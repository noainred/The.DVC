/**
 * agent/vmCloneWorker.js — VM 백업 센터의 엣지 워커(v2.793). CENTRAL_URL·토큰이 있을 때만 돈다.
 *
 * 사용자 요구(2026-10-26): 법인별 백업 — 법인 vCenter 는 그 법인 엣지가 백업한다(중앙은 site vCenter 에 로그인하지 않는다).
 *
 * 한 주기(기본 30초):
 *   ① GET  /api/central/vm-clone-sync  → 이 엣지 담당 vCenter 의 잡 정의 + 인출된 작업(지금 실행·검증·복구·NFS 연결)
 *   ② 정의를 로컬 저장소에 위임 잡으로 맞춘다(store.applyDelegatedJobs) — 실행은 이 노드의 기존 스케줄러·실행기가 한다
 *      (중앙과 통신이 끊겨도 백업은 계속된다). 이 노드가 **직접 수집하지 않는** vCenter 의 잡은 실행하지 않고 problem 으로 알린다.
 *   ③ 인출한 작업은 execOp 로 이 노드의 직렬 큐에 넣는다. 끝나면 다음 보고의 acks 에 싣는다(끝나는 즉시 한 번 더 보고한다).
 *   ④ POST /api/central/vm-clone-report → 위임 잡의 lastRun·이력·원장·실행 상태 + 이 노드의 NFS 마운트 + 진행 중 작업(inflight).
 *
 * 무음 실패 금지(docs/rules/edge.md '엣지 워커는 잴 것이 0건이어도 상태를 올린다'): 위임 잡이 0개여도 보고한다.
 * 실패는 `_last`(edgelog/spec.js 'pull.vmClone') + 콘솔(같은 사유 10분에 1번)로 남긴다.
 * 중앙이 503(settingsUnreadable·registryUnreadable)이면 **로컬 위임 잡을 그대로 둔다**(빈 목록으로 지우지 않는다).
 */

import fs from 'node:fs';
import { config, clampIntervalMs, loadVcenterConfig, currentVersion } from '../config.js';
import { reqTimeoutMs } from './envTimeout.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { classifyCentral404 } from './central404.js';
import { agentHeaders, withAgentQuery } from './agentNameCarry.js';
import { listJobs, applyDelegatedJobs, isDelegatedJob, HISTORY_MAX } from '../vmclone/store.js';
import { runnerStatus } from '../vmclone/runner.js';
import { executeOp } from '../vmclone/execOp.js';
import { listMounts } from '../system/nfsMounts.js';
import { isDirectCollectTarget } from '../vcenter/collectTarget.js';

const envNum = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? Math.round(n) : d; };
const INTERVAL_MS = clampIntervalMs(envNum('VMCLONE_SYNC_MS', 30_000), 30_000, 10_000);
const ENABLED = process.env.VMCLONE_DELEGATION !== 'false';
export const PROTO = 1;   // vmclone/dispatch.js PROTO 와 같은 프로토콜 계약(엣지가 central 모듈을 import 하지 않도록 상수만 복제)

let timer = null;
let running = false;
let unsupportedUntil = 0;
let _last = null;
let _lastSync = null;
const _logChange = createChangeLogger({ windowMs: 10 * 60_000 });
const _inflight = new Map();     // opId → Promise
const _acks = [];                // 회신 대기 [{id, ok, detail, ...}]
const _done = new Set();         // 이미 실행한 작업 id(중복 실행 방지 — 최근 500)

/** 상태 — edgelog/spec.js 가 화면에 싣는다. 비밀 없음. */
export function vmCloneWorkerStatus() {
  return {
    enabled: ENABLED && !!config.agent.centralUrl && !!config.agent.centralToken,
    intervalMs: INTERVAL_MS, unsupportedUntil: unsupportedUntil || null,
    inflight: [..._inflight.keys()], pendingAcks: _acks.length, lastSync: _lastSync, ..._last,
  };
}

function headers() {
  return { 'Content-Type': 'application/json', ...agentHeaders(config.agent.name), ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

/** 마운트 여유 공간 — 못 읽으면 싣지 않는다(0 으로 만들지 않는다). */
function mountView(m) {
  let freeBytes = null; let totalBytes = null;
  if (m.mounted) {
    try { const s = fs.statfsSync(m.mountPoint); freeBytes = Number(s.bavail) * Number(s.bsize); totalBytes = Number(s.blocks) * Number(s.bsize); }
    catch { /* 못 읽음 */ }
  }
  return { id: m.id, label: `${m.server}:${m.exportPath}`, mounted: !!m.mounted,
    ...(Number.isFinite(freeBytes) ? { freeBytes } : {}), ...(Number.isFinite(totalBytes) && totalBytes > 0 ? { totalBytes } : {}) };
}

/** 이 노드가 직접 로그인하는 vCenter id 집합(못 읽으면 null). */
function localDirectVcIds() {
  try { return new Set((loadVcenterConfig().vcenters || []).filter(isDirectCollectTarget).map((v) => String(v.id))); }
  catch { return null; }
}

/** 보고 본문(순수에 가깝다 — 로컬 상태를 읽는다). */
export function buildReport() {
  const direct = localDirectVcIds();
  const jobs = listJobs().filter(isDelegatedJob).map((j) => ({
    id: j.id,
    lastRun: j.lastRun || null,
    history: (j.history || []).slice(-HISTORY_MAX),
    clones: (j.clones || []).slice(-30).map((c) => ({ ref: c.ref, name: c.name, at: c.at, ...(c.bytes != null ? { bytes: c.bytes } : {}), ...(c.verify ? { verify: c.verify } : {}) })),
    ...(j.running ? { running: true } : {}),
    ...(direct && !direct.has(String(j.vcenterId)) ? { problem: '이 엣지가 직접 수집하는 vCenter 가 아닙니다(엣지 설정 › vCenter 에 없거나 꺼짐·점검중) — 실행하지 않습니다' } : {}),
  }));
  let mounts = [];
  try { mounts = listMounts().map(mountView); } catch { mounts = []; }
  return {
    proto: PROTO, version: (() => { try { return currentVersion(); } catch { return ''; } })(),
    runner: runnerStatus(), jobs, mounts,
    inflight: [..._inflight.keys()], acks: _acks.slice(0, 50),
    ...(_lastSync ? { sync: _lastSync } : {}),
  };
}

async function failHttp(stage, r) {
  let why = '';
  try { const b = await r.json(); why = String(b?.detail || b?.reason || '').slice(0, 200); } catch { /* 본문 없음 */ }
  const msg = `${stage} HTTP ${r.status}${why ? ` — ${why}` : ''}`;
  _last = { at: Date.now(), ok: false, error: msg, status: r.status };
  if (_logChange(stage, msg)) console.warn(`[vmclone-edge] ${msg}`);
  return { ok: false, reason: msg };
}

/** 인출한 작업 실행 — 중복 id 는 다시 하지 않는다. 끝나면 회신 대기열에 넣고 바로 보고한다. */
function runOps(ops) {
  for (const op of Array.isArray(ops) ? ops : []) {
    const id = typeof op?.id === 'string' ? op.id.slice(0, 80) : '';
    if (!id || _inflight.has(id) || _done.has(id)) continue;
    const p = executeOp({ ...op, id }).catch((e) => ({ ok: false, detail: String(e?.message || e).slice(0, 400) }))
      .then((r) => {
        _inflight.delete(id); _done.add(id);
        if (_done.size > 500) _done.delete(_done.values().next().value);
        _acks.push({ id, ok: !!r?.ok, detail: String(r?.detail ?? '').slice(0, 400), ...(r?.ms != null ? { ms: r.ms } : {}), ...(Array.isArray(r?.hosts) ? { hosts: r.hosts.slice(0, 500) } : {}), ...(r?.newName ? { newName: r.newName } : {}) });
        if (_acks.length > 200) _acks.splice(0, _acks.length - 200);
        reportNow().catch(() => {});
      });
    _inflight.set(id, p);
  }
}

/** 보고만(작업이 끝났을 때 즉시). */
export async function reportNow() {
  const body = buildReport();
  let r;
  try {
    r = await resilientFetch(withAgentQuery(`${config.agent.centralUrl}/api/central/vm-clone-report`, config.agent.name), {
      method: 'POST', headers: headers(), body: JSON.stringify(body), timeoutMs: reqTimeoutMs(process.env.VMCLONE_REPORT_TIMEOUT_MS, 30_000), retries: 1,
    });
  } catch (e) {
    const msg = `보고 실패 — ${String(e?.message || e).slice(0, 200)}`;
    _last = { at: Date.now(), ok: false, error: msg };
    if (_logChange('report', msg)) console.warn(`[vmclone-edge] ${msg}`);
    return { ok: false, reason: msg };
  }
  if (!r.ok) return failHttp('보고', r);
  let d = {};
  try { d = await r.json(); } catch { d = {}; }
  // 중앙이 받았다고 한 회신만 지운다(나머지는 다음 보고에 다시 싣는다).
  const got = new Set(Array.isArray(d?.acked) ? d.acked.map(String) : []);
  for (let i = _acks.length - 1; i >= 0; i--) if (got.has(_acks[i].id)) _acks.splice(i, 1);
  return { ok: true, jobs: body.jobs.length, acked: got.size };
}

export async function syncVmCloneNow() {
  if (!ENABLED) return { ok: false, reason: 'VMCLONE_DELEGATION=false' };
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'CENTRAL_URL/토큰 미설정' };
  if (running) return { ok: false, reason: '이전 주기 진행 중' };
  if (Date.now() < unsupportedUntil) return { ok: false, reason: '중앙이 이 기능을 지원하지 않습니다(백오프 중)' };
  running = true;
  try {
    const res = await resilientFetch(withAgentQuery(`${config.agent.centralUrl}/api/central/vm-clone-sync?proto=${PROTO}`, config.agent.name), {
      method: 'GET', headers: headers(), timeoutMs: reqTimeoutMs(process.env.VMCLONE_SYNC_TIMEOUT_MS, 30_000), retries: 1,
    });
    if (res.status === 404) {
      const c = await classifyCentral404(res);
      const backoff = c.kind === 'no-endpoint' ? 3_600_000 : 600_000;
      unsupportedUntil = Date.now() + backoff;
      const reason = `${c.reason} (${Math.round(backoff / 60_000)}분 후 재시도)`;
      _last = { at: Date.now(), ok: false, error: reason, kind: c.kind };
      if (_logChange('sync404', c.reason)) console.warn(`[vmclone-edge] ${reason}`);
      return { ok: false, reason };
    }
    if (!res.ok) {
      // 503(설정·등록부를 못 읽음)·403·5xx — 로컬 위임 잡은 그대로 둔다. 상태는 그래도 올린다(무음 실패 금지).
      const f = await failHttp('동기화', res);
      await reportNow().catch(() => {});
      return f;
    }
    const d = await res.json();
    const s = applyDelegatedJobs(d?.jobs, d?.vcenters);
    _lastSync = { at: Date.now(), added: s.added, updated: s.updated, removed: s.removed, conflicts: s.conflicts.slice(0, 20), invalid: s.invalid.slice(0, 20) };
    if (s.added || s.updated || s.removed) console.log(`[vmclone-edge] 위임 잡 동기화 — 추가 ${s.added} · 변경 ${s.updated} · 제거 ${s.removed}`);
    if (s.conflicts.length && _logChange('conflict', s.conflicts[0])) console.warn(`[vmclone-edge] 받지 않은 위임 잡: ${s.conflicts.join(' · ')}`);
    runOps(d?.ops);
    const rep = await reportNow();
    _last = { at: Date.now(), ok: rep.ok, vcenters: Array.isArray(d?.vcenters) ? d.vcenters.length : 0, jobs: Array.isArray(d?.jobs) ? d.jobs.length : 0, ops: Array.isArray(d?.ops) ? d.ops.length : 0, ...(rep.ok ? {} : { error: rep.reason }) };
    return { ok: rep.ok, ..._last };
  } catch (e) {
    _last = { at: Date.now(), ok: false, error: String(e?.message || e).slice(0, 300) };
    if (_logChange('sync', _last.error)) console.warn(`[vmclone-edge] 실패: ${_last.error}`);
    return { ok: false, reason: _last.error };
  } finally { running = false; }
}

export function startVmCloneWorker() {
  if (timer) return;
  if (!ENABLED || !config.agent.centralUrl || !config.agent.centralToken) return;
  setTimeout(() => {
    syncVmCloneNow().catch(() => {});
    timer = setInterval(() => { syncVmCloneNow().catch(() => {}); }, INTERVAL_MS);
    timer.unref?.();
  }, 20_000).unref?.();
  console.log(`[vmclone-edge] VM 백업 위임 동기화 시작 → ${config.agent.centralUrl} (${Math.round(INTERVAL_MS / 1000)}초 주기)`);
}

/** 테스트 전용. */
export function _resetVmCloneWorkerForTest() { running = false; unsupportedUntil = 0; _last = null; _lastSync = null; _inflight.clear(); _acks.length = 0; _done.clear(); }
