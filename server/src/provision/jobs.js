/**
 * VM provisioning job engine. Holds deployment jobs in memory and runs them
 * asynchronously with bounded concurrency so a 100-VM batch never blocks the
 * event loop or hammers vCenter. Each VM tracks its own status so the UI can
 * show live progress; one VM failing never aborts the batch.
 *
 * Mock data source → the job is simulated (queued → running → done, with a rare
 * synthetic failure) so the feature is fully usable in a demo. Live → each VM
 * is cloned + guest-customized on the real vCenter via the SOAP provisioner.
 *
 * 결정(56~75 남긴 것) 74 ②: LIVE 의 VM 상태는 queued → running(제출 중) → submitted(vCenter 작업 진행 중) →
 *   done(vCenter 복제 작업 성공) · error(제출 실패 · vCenter 작업 실패) · unknown(시간 초과 · 결과 조회 실패 · 재기동 — vCenter 에서 계속될 수 있음).
 *   예전에는 제출만 하고 'done' 이라 했다. 제출은 예전 속도 그대로(CONCURRENCY 풀 — 결과를 기다리지 않는다)이고, 결과는 제출 풀과 분리된
 *   추적 고리(taskTracker.js — 작업 id 를 묶어 PROVISION_TRACK_POLL_MS 마다 조회 · 묶음 동시성 상한 · 제출 시각부터 PROVISION_TASK_TIMEOUT_MS)가 본다.
 *   작업 목록은 provision-runs.json 에 남긴다 — 재기동하면 추적 중이던 VM 은 '결과 모름(재기동으로 추적 중단)' 이다(영원히 submitted 로 두지 않는다).
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { store } from '../store.js';
import { getDataSource } from '../runtime-settings.js';
import { config, loadVcenterConfig } from '../config.js';
import { safeLoadText } from '../util/atomicWrite.js';
import { makeJsonFileReader, READ_RETRY_MS } from '../util/jsonFileLoad.js';   // 반증 후속 ⑥: 읽기 오류 ≠ 손상 · 30초 재읽기
import { createDebouncedWriter } from '../central/edgeRecord.js';   // 디바운스 + tmp→rename + 종료 시 동기 flush(상태 파일 등록 포함)
import { runLiveVms } from './taskTracker.js';   // 결정 74 ②: 제출 풀과 분리된 결과 추적
import { expandSpec } from './spec.js';
import { cleanPlacement, placementNotApplied } from './placement.js';
import { addSaved } from './saved.js';
import { createProvisioner, findHostRef, findDatastoreRef } from './vsphere.js';
import { onDemandVcBlock } from '../vcenter/dsBrowse.js';   // v2.743(감사 VC-03): 주문형 vCenter 로그인 문(판정은 collectTarget·authStopGate 하나)
import { isAdminDetailUser } from '../auth/demoGuest.js';   // v2.744(감사 AUTHZ-01): '남의 작업도 본다' 판정 하나
import { poolRun } from '../util/pool.js'; // v2.579: 동시성 풀 단일 소스(util/pool.js) — 손으로 쓴 사본 제거
import { envPositive, ENV_INT_MAX } from '../util/envNumber.js'; // v3.17.6: 양수 env 는 하나로(음수 · Infinity 를 통과시키지 않는다)

const CONCURRENCY = envPositive(process.env.PROVISION_CONCURRENCY, 4);
/** 74 ②: 복제 작업 결과를 기다리는 시한(VM 하나 · 제출 시각부터) — 넘으면 '결과 모름'(작업은 취소하지 않는다). Infinity · 2^31 초과 · 음수는 기본값. */
export const TASK_TIMEOUT_MS = envPositive(process.env.PROVISION_TASK_TIMEOUT_MS, 60 * 60_000, { max: ENV_INT_MAX });
/** 74 ②: 추적 간격 — 이만큼마다 '제출됨' 작업 id 를 묶어 한 번 조회한다. */
export const TRACK_POLL_MS = envPositive(process.env.PROVISION_TRACK_POLL_MS, 15_000, { max: ENV_INT_MAX });
export const TRACK_CHUNK = 100;          // 한 조회에 싣는 작업 id 수
export const TRACK_CONCURRENCY = 2;      // 동시에 도는 묶음 조회 수(제출 풀과 별개)
/** 추적 고리가 사라진 채 남은 '제출됨' 을 정리하는 여유 — 시한 + 간격 두 번 + 1분이 지나도 submitted 면 '추적 중단'(보류에는 시한). */
const STALE_GRACE_MS = 2 * TRACK_POLL_MS + 60_000;
const MAX_JOBS = 50; // keep the most recent N jobs in memory

const jobs = []; // newest first

/*
 * 74 ②: 작업 목록 보존(provision-runs.json — 상태 파일). 재기동하면 추적 고리가 없으므로 남은 VM 을 끝낸다:
 *   submitted · running(제출 응답을 못 받았을 수 있다) → unknown '재기동으로 추적 중단' · queued → error '재기동으로 제출하지 않음'.
 *   VM 마다 화면에 필요한 칸만 남긴다(게스트 설정 · NIC 는 남기지 않는다). 손상은 보존본으로 옮기고 빈 목록, 읽기 오류는 덮어쓰지 않게 저장을 멈춘다.
 */
const JOBS_FILE = path.join(config.configDir, 'provision-runs.json');   // ⚠ 리터럴 형태 유지 — scripts/config-doc.mjs 가 이 모양으로 찾는다 · '-runs.json' = 백업 판정의 상태 파일 규약
const VM_KEEP = ['name', 'hostname', 'ip', 'status', 'error', 'task', 'submittedAt'];
const slimJob = (j) => ({ ...j, vms: j.vms.map((v) => Object.fromEntries(VM_KEEP.filter((k) => v[k] !== undefined).map((k) => [k, v[k]]))) });
let _persistBlocked = false;
/*
 * 반증(G2 · G3) 개선: 3초마다 50작업 × 500대(2만 5천 VM)를 통째로 다시 직렬화하면 한 번에 약 40ms(이름 · 사유가 긴 최악 75~136ms) 이벤트 루프를 막았다(실측).
 *   끝난 작업(status ≠ running)은 더 바뀌지 않으므로(제출 · 추적 · sweepStale 은 진행 중 작업의 VM 만 바꾼다) 직렬화 결과를 상태별로 기억한다 — 결과 바이트는 같다.
 */
const _slimJsonOf = new WeakMap();   // job -> { key, json }
/** 기억 키 — 작업 상태 + VM 상태별 수(끝난 작업이 예외 경로로 바뀌어도 옛 직렬화를 쓰지 않게 — VM 순회 한 번은 직렬화보다 훨씬 싸다). */
function slimKeyOf(j) {
  const n = {};
  for (const v of j.vms) n[v.status] = (n[v.status] || 0) + 1;
  return `${j.status}|${j.vms.length}|${Object.entries(n).map(([k, c]) => `${k}:${c}`).join(',')}`;
}
function slimJobJson(j) {
  if (j.status === 'running') return JSON.stringify(slimJob(j));
  const key = slimKeyOf(j);
  const hit = _slimJsonOf.get(j);
  if (hit && hit.key === key) return hit.json;
  const json = JSON.stringify(slimJob(j));
  _slimJsonOf.set(j, { key, json });
  return json;
}
/** provision-runs.json 본문(JSON.stringify({ jobs: jobs.map(slimJob) }) 과 같은 바이트). */
export function serializeJobs() { return `{"jobs":[${jobs.map(slimJobJson).join(',')}]}`; }
const _writer = createDebouncedWriter(JOBS_FILE, serializeJobs, { delayMs: 3_000, name: 'provision-runs.json' });
const persist = () => { if (!_persistBlocked) _writer.save(); };
export const RESTART_UNKNOWN = '재기동으로 추적 중단 — vCenter 에서 계속될 수 있습니다(최근 작업에서 확인하세요).';
/** 읽어 온 작업 하나를 재기동 뒤 상태로(순수 — 시험이 같이 쓴다). */
export function settleAfterRestart(j) {
  for (const v of j.vms) {
    if (v.status === 'submitted' || v.status === 'running') { v.status = 'unknown'; v.error = RESTART_UNKNOWN; }
    else if (v.status === 'queued') { v.status = 'error'; v.error = '재기동으로 중단 — 제출하지 않았습니다.'; }
  }
  if (j.status === 'running') j.status = jobStatusOf(j.vms);
  return j;
}
/*
 * 결정 G2 · G3 반증 후속 ⑥: 기동 때 작업 목록 파일을 **읽지 못하면**(EACCES · EIO — 손상 아님) 예전에는 프로세스 수명 동안 저장을 멈췄다(재시도 없음).
 *   이제 원본은 덮지 않고(저장 보류) 30초 간격으로 다시 읽어, 읽히면 그동안 메모리에 만든 새 작업과 **합쳐** 저장을 다시 연다. 그동안 목록 응답은
 *   storeError 표지를 싣는다('작업 기록 파일을 못 읽음 — 새 작업은 메모리에만'). 손상은 예전처럼 보존본으로 옮기고 빈 목록에서 시작한다.
 */
const _jobsReader = makeJsonFileReader(() => JOBS_FILE, { parse: (t) => { const p = JSON.parse(t); if (!Array.isArray(p?.jobs)) throw new Error('형식 오류'); return p; }, tag: 'provision' });
let _readError = null;   // { at, code } — 읽기 오류로 저장을 보류하는 동안
let _retryTimer = null;
function armJobsRetry() {
  if (_retryTimer) return;
  _retryTimer = setTimeout(() => { _retryTimer = null; if (_readError) loadJobs(); }, READ_RETRY_MS + 1_000);
  _retryTimer.unref?.();
}
function loadJobs() {
  const r = _jobsReader.read();
  if (r.kind === 'read-error') {
    if (!_readError) {
      _readError = { at: Date.now(), code: String(r.error?.code || 'read-error').slice(0, 32) };
      console.warn(`[provision] 작업 목록 파일을 읽지 못했습니다(${_readError.code}) — 손상이 아니라 원본은 그대로 두고 저장을 보류합니다(새 작업은 메모리에만 · ${Math.round(READ_RETRY_MS / 1000)}초마다 다시 읽음)`);
    }
    _persistBlocked = true;
    armJobsRetry();
    return;
  }
  const wasBlocked = _persistBlocked;
  _persistBlocked = false; _readError = null;
  if (r.kind === 'ok') {
    const have = new Set(jobs.map((j) => j.id));   // 보류 중 메모리에 만든 새 작업 — 더 새것이라 앞에 두고, 파일의 작업은 뒤에 잇는다
    for (const j of r.value.jobs.slice(0, MAX_JOBS)) {
      if (!j || typeof j !== 'object' || typeof j.id !== 'string' || !Array.isArray(j.vms) || have.has(j.id)) continue;
      j.vms = j.vms.filter((v) => v && typeof v === 'object');
      jobs.push(settleAfterRestart(j));
    }
    while (jobs.length > MAX_JOBS) jobs.pop();
    if (jobs.length) persist();
  } else if (r.kind === 'corrupt') {
    console.warn(`[provision] 작업 목록 파일이 손상돼 보존본으로 옮기고 빈 목록으로 시작합니다: ${safeLoadText(r.error) || '사유 미상'}`);
    if (jobs.length) persist();
  } else if (wasBlocked && jobs.length) persist();
  if (wasBlocked) console.warn('[provision] 작업 목록 파일을 다시 읽었습니다 — 그동안의 새 작업과 합쳐 저장을 다시 엽니다');
}
/** 작업 기록 파일을 못 읽어 저장을 보류하는 중이면 표지(목록 응답 — 화면 배너), 아니면 null. 부를 때 간격이 지났으면 다시 읽는다. */
export function jobsStoreError() {
  if (_readError) loadJobs();
  return _readError ? { readError: true, at: _readError.at, code: _readError.code, reason: `작업 기록 파일(provision-runs.json)을 읽지 못했습니다(${_readError.code}) — 원본은 그대로 두고 새 작업은 메모리에만 둡니다(그 사이 재시작하면 새 작업 기록은 사라집니다). ${Math.round(READ_RETRY_MS / 1000)}초마다 다시 읽고, 읽히면 합쳐 저장을 다시 엽니다.` } : null;
}
loadJobs();

/** 보류에는 시한 — 추적 고리 없이 남은 '제출됨'(고리가 예외로 끝난 경우 등)을 시한 + 여유 뒤 '추적 중단' 으로 끝낸다. */
export function sweepStale(j, now = Date.now(), { timeoutMs = TASK_TIMEOUT_MS, graceMs = STALE_GRACE_MS } = {}) {
  let changed = false;
  for (const v of j.vms) {
    if (v.status !== 'submitted') continue;
    const at = Number(v.submittedAt);
    if (Number.isFinite(at) && now - at < timeoutMs + graceMs) continue;
    v.status = 'unknown'; v.error = '결과 추적이 시한 안에 끝나지 않아 정리했습니다 — vCenter 에서 계속될 수 있습니다.'; changed = true;
  }
  if (changed && j.status === 'running' && !j.vms.some((v) => ['queued', 'running', 'submitted'].includes(v.status))) j.status = jobStatusOf(j.vms);
  if (changed) persist();
  return changed;
}

/** Source VMs/templates that can be cloned, from the current snapshot.
 *  `q` does a case-insensitive prefix match on the name (A → all starting "A"). */
/**
 * @param {Set<string>|null} allowed 사용자 scope 로 허용된 vCenter id 집합(null=제한 없음).
 *   scope 는 요청 필터(vcenterId)보다 **먼저** 적용한다 — 범위 밖 vCenter 의 VM/템플릿이
 *   목록에 새지 않게(server/CLAUDE.md scope 규칙, v2.313 감사 반영).
 */
export function listSources(vcenterId, q = '', allowed = null) {
  const snap = store.get();
  const prefix = String(q || '').trim().toLowerCase();
  const all = snap.vms
    .filter((v) => !allowed || allowed.has(v.vcenterId))
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

/**
 * v2.632 AX3-02: 범위(scope) 교집합. role==='admin' 만 보고 전 작업을 주면 범위 관리자(역시 admin)가 범위 밖 법인의
 * 원본 VM·배치·생성 VM 이름·IP 를 본다(형제 /provision/saved·/sources 는 이미 범위로 거른다).
 * @param {Set<string>|null} allowed null = 제한 없음. Set 이면 그 vCenter 의 작업만(vCenter 귀속 없는 작업도 숨긴다).
 */
const inScope = (j, allowed) => !allowed || (j.vcenterId && allowed.has(String(j.vcenterId)));

/** @returns {{jobs: object[], omittedOutOfScope: number}} */
export function listJobsScoped(user, allowed = null) {
  // v2.744(감사 AUTHZ-01): mock 데모 계정은 요청 문맥이 admin 이지만 남의 작업(createdBy·원본 VM·생성 VM 이름)을 보지 않는다.
  const isAdmin = isAdminDetailUser(user);
  const mine = jobs.filter((j) => isAdmin || j.createdBy === user?.username);
  const visible = mine.filter((j) => inScope(j, allowed));
  return { jobs: visible.map(redact), omittedOutOfScope: mine.length - visible.length };
}
export function listJobs(user, allowed = null) {
  return listJobsScoped(user, allowed).jobs;
}
export function getJob(id, user, allowed = null) {
  const j = jobs.find((x) => x.id === id);
  if (!j) return null;
  if (user && !isAdminDetailUser(user) && j.createdBy !== user.username) return null;   // v2.744(AUTHZ-01)
  if (!inScope(j, allowed)) return null; // 범위 밖은 존재 은닉(404)
  return redact(j);
}

const redact = (j) => { sweepStale(j); return redactView(j); };
const redactView = (j) => ({
  id: j.id, createdAt: j.createdAt, createdBy: j.createdBy, vcenterId: j.vcenterId,
  sourceId: j.sourceId, sourceName: j.sourceName, powerOn: j.powerOn, live: j.live,
  placement: j.placement, placementNotApplied: j.placementNotApplied || [],
  status: j.status, total: j.vms.length,
  done: j.vms.filter((v) => v.status === 'done').length,
  failed: j.vms.filter((v) => v.status === 'error').length,
  unknown: j.vms.filter((v) => v.status === 'unknown').length,   // 74 ②: 시간 초과 · 결과 조회 실패(vCenter 에서 계속될 수 있음)
  vms: j.vms.map((v) => ({ name: v.name, hostname: v.hostname, ip: v.ip, status: v.status, error: v.error, task: v.task })),
});

/**
 * Create + start a provisioning job. Returns { ok, job } or { ok:false, reason }.
 * spec is the bulk spec (see expandSpec); sourceId picks the VM/template to clone.
 */
export function createJob(spec, { user, expectVcenterId = null } = {}) {
  const snap = store.get();
  const source = snap.vms.find((v) => v.id === spec.sourceId);
  if (!source) return { ok: false, reason: '원본 VM/템플릿을 찾을 수 없습니다.' };
  // v2.767(점검 R2-B3-1): 라우트가 범위를 판정한 원본의 vCenter 와 다르면 만들지 않는다(그 사이 스냅샷이 바뀐 경우까지 — 이중 방어).
  if (expectVcenterId != null && String(source.vcenterId || '') !== String(expectVcenterId)) {
    return { ok: false, reason: '원본 VM/템플릿의 vCenter 가 확인한 값과 다릅니다 — 다시 시도하세요.' };
  }

  const { vms, errors } = expandSpec(spec);
  if (errors.length) return { ok: false, reason: errors.join(' / ') };
  if (!vms.length) return { ok: false, reason: '생성할 VM이 없습니다.' };

  const live = getDataSource() !== 'mock';
  // v2.743(감사 VC-03): 실제 vCenter 에 VM 을 만드는 작업은 시작하기 전에 주문형 로그인 문을 본다 — 비활성·점검중·엣지 위임(site)
  //   vCenter 는 이 포탈이 로그인하지 않으므로 작업을 만들지 않고 사유를 돌려준다(작업을 만든 뒤 VM 마다 같은 오류로 끝나는 것보다 낫다).
  //   인증 정지는 막지 않는다(관리자가 누른 수동 작업은 1회 시도 — 거부는 vsphere.js 가 기록하고 남은 VM 은 다시 시도하지 않는다).
  if (live) {
    const vcCfg = (loadVcenterConfig().vcenters || []).find((v) => v.id === source.vcenterId);
    const block = vcCfg ? onDemandVcBlock(vcCfg, { allowAuthStopped: true }) : null;
    if (block) return { ok: false, reason: block.reason, ...(block.skipReason ? { skipReason: block.skipReason } : {}) };
  }
  const guest = spec.guest || {};
  const placement = cleanPlacement(spec.placement);
  // 74회차 F5: 고른 호스트 · 데이터스토어가 원본 vCenter 의 현재 인벤토리에 없으면 작업을 만들지 않는다 — 예전에는 조용히 빼고
  //   원본 위치에 만들었다(오타 · 다른 vCenter 의 이름 · 그 사이 빠진 호스트). 데모(mock)도 같은 스냅샷으로 판정한다.
  if (placement.host && !findHostRef(source.vcenterId, placement.host)) return { ok: false, reason: `선택한 호스트 '${placement.host}' 를 원본 VM 의 vCenter 에서 찾을 수 없습니다.` };
  if (placement.datastore && !findDatastoreRef(source.vcenterId, placement.datastore)) return { ok: false, reason: `선택한 데이터스토어 '${placement.datastore}' 를 원본 VM 의 vCenter 에서 찾을 수 없습니다.` };
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
    placementNotApplied: placementNotApplied(placement),   // 74회차 F5 · F6: 받았지만 적용하지 않는 배치 항목(화면이 밝힌다)
    live,
    status: 'running',
    vms: vms.map((v) => ({ ...v, guest, placement, status: 'queued', error: null, task: null })),
  };
  jobs.unshift(job);
  while (jobs.length > MAX_JOBS) jobs.pop();
  persist();

  // Persist the spec so it can be reloaded/reused later (memo/tags editable).
  try { addSaved({ spec, source, user, memo: spec.memo, tags: spec.tags }); } catch { /* best effort */ }

  // Run in the background; never await here so the HTTP response returns at once.
  runJob(job, source).catch((err) => {
    job.status = 'error';
    // 잡 레벨 실패(예: createProvisioner/loadVcenterConfig 예외) 시 아직 종료되지 않은 VM들이
    // queued/running에 영구 고착돼 UI가 '실행 중'으로 계속 표시하지 않게 error로 마감한다.
    for (const v of job.vms) {
      // 74 ②: 이미 제출한(submitted) VM 은 vCenter 에서 복제가 계속될 수 있다 — 실패가 아니라 결과 모름으로 둔다.
      if (v.status === 'submitted') { v.status = 'unknown'; v.error = v.error || `결과 추적이 중단됐습니다(${err.message}) — vCenter 에서 계속될 수 있습니다.`; }
      else if (v.status !== 'done' && v.status !== 'error' && v.status !== 'unknown') { v.status = 'error'; v.error = v.error || err.message; }
    }
    persist();
    console.error('[provision] job 실패:', err.message);
  });
  return { ok: true, job: redact(job) };
}

async function runJob(job, source) {
  if (!job.live) { await runMock(job); return; }

  const vc = loadVcenterConfig().vcenters.find((v) => v.id === job.vcenterId);
  if (!vc) { job.vms.forEach((v) => { v.status = 'error'; v.error = 'vCenter 설정을 찾을 수 없습니다.'; }); job.status = 'error'; persist(); return; }   // 반증: 여기만 저장이 빠져(다른 작업의 저장이 없으면) 재기동 뒤 '재기동으로 중단 — 제출하지 않음' 으로 바뀌어 보였다

  const prov = createProvisioner(vc);
  try {
    // 74 ②: 제출은 CONCURRENCY 풀(결과를 기다리지 않는다) · 결과는 분리된 추적 고리(묶음 조회 · 자체 동시성 · 제출 시각부터 시한).
    await runLiveVms(prov, source, job.vms, {
      powerOn: job.powerOn, placement: job.placement, concurrency: CONCURRENCY,
      timeoutMs: TASK_TIMEOUT_MS, pollMs: TRACK_POLL_MS, chunk: TRACK_CHUNK, trackConcurrency: TRACK_CONCURRENCY, onChange: persist,
    });
  } finally {
    await prov.close().catch(() => {});
  }
  job.status = jobStatusOf(job.vms);
  persist();
  store.refresh().catch(() => {}); // surface the new VMs sooner
}

/** 74 ②: 작업 상태 — 실패가 있으면 completed_with_errors, 아니고 결과 모름이 있으면 completed_with_unknown, 다 성공이면 completed. */
export function jobStatusOf(vms) {
  if (vms.some((v) => v.status === 'error')) return 'completed_with_errors';
  if (vms.some((v) => v.status === 'unknown')) return 'completed_with_unknown';
  return 'completed';
}

async function runMock(job) {
  await poolRun(job.vms, CONCURRENCY, async (v) => {
    v.status = 'running';
    await sleep(300 + Math.floor(Math.random() * 700));
    // ~4% synthetic failure so the UI exercises the error path in demos.
    if (Math.random() < 0.04) { v.status = 'error'; v.error = '데모: 시뮬레이션된 복제 실패'; }
    else { v.status = 'done'; v.task = `task-${Math.random().toString(36).slice(2, 8)}`; }   // 74 ②: 데모는 작업 결과를 바로 성공으로 본다
  });
  job.status = jobStatusOf(job.vms);
  persist();
}

/** Run `fn` over items with at most `limit` in flight at once. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
