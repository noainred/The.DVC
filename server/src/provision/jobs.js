/**
 * VM provisioning job engine. Holds deployment jobs in memory and runs them
 * asynchronously with bounded concurrency so a 100-VM batch never blocks the
 * event loop or hammers vCenter. Each VM tracks its own status so the UI can
 * show live progress; one VM failing never aborts the batch.
 *
 * Mock data source → the job is simulated (queued → running → done, with a rare
 * synthetic failure) so the feature is fully usable in a demo. Live → each VM
 * is cloned + guest-customized on the real vCenter via the SOAP provisioner.
 */

import { randomUUID } from 'node:crypto';
import { store } from '../store.js';
import { getDataSource } from '../runtime-settings.js';
import { loadVcenterConfig } from '../config.js';
import { expandSpec } from './spec.js';
import { cleanPlacement } from './placement.js';
import { addSaved } from './saved.js';
import { createProvisioner } from './vsphere.js';
import { describeError } from '../util/errors.js';

const CONCURRENCY = Number(process.env.PROVISION_CONCURRENCY) || 4;
const MAX_JOBS = 50; // keep the most recent N jobs in memory

const jobs = []; // newest first

/** Source VMs/templates that can be cloned, from the current snapshot.
 *  `q` does a case-insensitive prefix match on the name (A → all starting "A"). */
export function listSources(vcenterId, q = '') {
  const snap = store.get();
  const prefix = String(q || '').trim().toLowerCase();
  const all = snap.vms
    .filter((v) => !vcenterId || v.vcenterId === vcenterId)
    .filter((v) => !prefix || String(v.name || '').toLowerCase().startsWith(prefix));
  const sources = all
    .map((v) => ({
      id: v.id, name: v.name, vcenterId: v.vcenterId,
      template: Boolean(v.template), guestOS: v.guestOS || '',
      powerState: v.powerState, cpuCount: v.cpuCount, memMB: v.memMB,
    }))
    // Templates first, then powered-off (golden images), then the rest.
    .sort((a, b) => (Number(b.template) - Number(a.template)) || a.name.localeCompare(b.name));
  // Cap the payload; the name search narrows it for the user.
  return { total: sources.length, sources: sources.slice(0, 300) };
}

export function listJobs(user) {
  const isAdmin = user?.role === 'admin';
  return jobs
    .filter((j) => isAdmin || j.createdBy === user?.username)
    .map(redact);
}
export function getJob(id, user) {
  const j = jobs.find((x) => x.id === id);
  if (!j) return null;
  if (user && user.role !== 'admin' && j.createdBy !== user.username) return null;
  return redact(j);
}

const redact = (j) => ({
  id: j.id, createdAt: j.createdAt, createdBy: j.createdBy, vcenterId: j.vcenterId,
  sourceId: j.sourceId, sourceName: j.sourceName, powerOn: j.powerOn, live: j.live,
  placement: j.placement,
  status: j.status, total: j.vms.length,
  done: j.vms.filter((v) => v.status === 'done').length,
  failed: j.vms.filter((v) => v.status === 'error').length,
  vms: j.vms.map((v) => ({ name: v.name, hostname: v.hostname, ip: v.ip, status: v.status, error: v.error, task: v.task })),
});

/**
 * Create + start a provisioning job. Returns { ok, job } or { ok:false, reason }.
 * spec is the bulk spec (see expandSpec); sourceId picks the VM/template to clone.
 */
export function createJob(spec, { user } = {}) {
  const snap = store.get();
  const source = snap.vms.find((v) => v.id === spec.sourceId);
  if (!source) return { ok: false, reason: '원본 VM/템플릿을 찾을 수 없습니다.' };

  const { vms, errors } = expandSpec(spec);
  if (errors.length) return { ok: false, reason: errors.join(' / ') };
  if (!vms.length) return { ok: false, reason: '생성할 VM이 없습니다.' };

  const live = getDataSource() !== 'mock';
  const guest = spec.guest || {};
  const placement = cleanPlacement(spec.placement);
  const job = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    createdBy: user?.username || 'unknown',
    vcenterId: source.vcenterId,
    sourceId: source.id,
    sourceName: source.name,
    sourceGuestOS: source.guestOS || '',
    powerOn: Boolean(spec.powerOn),
    placement,
    live,
    status: 'running',
    vms: vms.map((v) => ({ ...v, guest, placement, status: 'queued', error: null, task: null })),
  };
  jobs.unshift(job);
  while (jobs.length > MAX_JOBS) jobs.pop();

  // Persist the spec so it can be reloaded/reused later (memo/tags editable).
  try { addSaved({ spec, source, user, memo: spec.memo, tags: spec.tags }); } catch { /* best effort */ }

  // Run in the background; never await here so the HTTP response returns at once.
  runJob(job, source).catch((err) => {
    job.status = 'error';
    // 잡 레벨 실패(예: createProvisioner/loadVcenterConfig 예외) 시 아직 종료되지 않은 VM들이
    // queued/running에 영구 고착돼 UI가 '실행 중'으로 계속 표시하지 않게 error로 마감한다.
    for (const v of job.vms) { if (v.status !== 'done' && v.status !== 'error') { v.status = 'error'; v.error = v.error || err.message; } }
    console.error('[provision] job 실패:', err.message);
  });
  return { ok: true, job: redact(job) };
}

async function runJob(job, source) {
  if (!job.live) { await runMock(job); return; }

  const vc = loadVcenterConfig().vcenters.find((v) => v.id === job.vcenterId);
  if (!vc) { job.vms.forEach((v) => { v.status = 'error'; v.error = 'vCenter 설정을 찾을 수 없습니다.'; }); job.status = 'error'; return; }

  const prov = createProvisioner(vc);
  try {
    await eachLimited(job.vms, CONCURRENCY, async (v) => {
      v.status = 'running';
      try {
        const r = await prov.cloneOne(source, v, { powerOn: job.powerOn, placement: job.placement });
        v.task = r.task; v.status = 'done';
      } catch (err) {
        const d = describeError(err);
        v.status = 'error'; v.error = d.message;
      }
    });
  } finally {
    await prov.close().catch(() => {});
  }
  job.status = job.vms.some((v) => v.status === 'error') ? 'completed_with_errors' : 'completed';
  store.refresh().catch(() => {}); // surface the new VMs sooner
}

async function runMock(job) {
  await eachLimited(job.vms, CONCURRENCY, async (v) => {
    v.status = 'running';
    await sleep(300 + Math.floor(Math.random() * 700));
    // ~4% synthetic failure so the UI exercises the error path in demos.
    if (Math.random() < 0.04) { v.status = 'error'; v.error = '데모: 시뮬레이션된 복제 실패'; }
    else { v.status = 'done'; v.task = `task-${Math.random().toString(36).slice(2, 8)}`; }
  });
  job.status = job.vms.some((v) => v.status === 'error') ? 'completed_with_errors' : 'completed';
}

/** Run `fn` over items with at most `limit` in flight at once. */
async function eachLimited(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
