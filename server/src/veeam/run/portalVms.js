/**
 * veeam/run/portalVms.js — **포탈로 백업한 VM 목록**(v2.819). vCenter 폴더 트리 배지와 '포탈 백업 VM' 표가 읽는다.
 *
 *  · 실행 기록(runs.js)은 최근 100건이라 오래된 VM 이 사라진다 — 이 목록은 VM 마다 한 줄(마지막 백업·결과·포탈 잡·빼냄·삭제·복원 이력)을 따로 둔다.
 *  · 값은 포탈이 **보낸 요청과 그 결과**다. Veeam 이 지금 가진 복원 지점은 관리 창에서 Veeam 에 직접 묻는다(이 목록을 근거로 단정하지 않는다).
 *  · 저장: `veeam-portal-vms.json`(원자적 쓰기 · 손상이면 preserveCorrupt · 상한 5000 — 오래된 것부터). 바뀐 것이 있을 때만 쓴다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../../util/atomicWrite.js';
import { registerStateFile } from '../../util/stateFiles.js';

const FILE_NAME = 'veeam-portal-vms.json';
registerStateFile(FILE_NAME);
const FILE = () => path.join(config.configDir, FILE_NAME);
const MAX = 5000;
const RESTORES_MAX = 10;
const FINAL = new Set(['success', 'warning', 'failed', 'unknown']);

let _map = null;
function load() {
  if (_map) return _map;
  _map = new Map();
  if (!fs.existsSync(FILE())) return _map;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    for (const r of Array.isArray(raw?.vms) ? raw.vms : []) if (r && typeof r.vmId === 'string' && typeof r.vcenterId === 'string') _map.set(r.vmId, r);
  } catch (e) { preserveCorrupt(FILE(), e?.message); _map = new Map(); }
  return _map;
}
function persist() {
  const m = load();
  if (m.size > MAX) {   // 오래된 것부터(마지막 활동 시각)
    const old = [...m.values()].sort((a, b) => (a.touchedAt || 0) - (b.touchedAt || 0)).slice(0, m.size - MAX);
    for (const r of old) m.delete(r.vmId);
  }
  try { atomicWriteFileSync(FILE(), JSON.stringify({ version: 1, vms: [...m.values()] }), { mode: 0o600 }); }
  catch (e) { console.warn(`[veeam-run] 포탈 백업 VM 목록 저장 실패: ${e?.message || e}`); }
}

function upsert(vmId, base, patch) {
  const m = load();
  const cur = m.get(vmId) || { vmId, ...base, restores: [] };
  const next = { ...cur, ...base, ...patch };
  if (JSON.stringify(next) === JSON.stringify(cur)) return false;
  m.set(vmId, { ...next, touchedAt: Date.now() });
  return true;
}

/** 실행 1건을 목록에 반영(백업 방식 VM · 복원). 건너뜀(skipped)은 보낸 것이 아니라 넣지 않는다. 바뀐 것이 있으면 저장. */
export function notePortalRun(run) {
  if (!run || !Array.isArray(run.vms)) return false;
  let changed = false;
  for (const v of run.vms) {
    if (!v || typeof v.vmId !== 'string' || v.state === 'skipped' || v.state === 'queued') continue;
    const g = (run.groups || []).find((x) => x.serverId === v.serverId && x.kind === v.how && (!x.vcenterId || x.vcenterId === v.vcenterId)) || {};
    const base = { vcenterId: v.vcenterId, name: v.name };
    if (v.how === 'restore') {
      const cur = load().get(v.vmId);
      if (!cur) continue;   // 포탈로 백업한 적 없는 VM 의 복원은 목록에 새로 만들지 않는다(목록은 '포탈 백업 VM')
      const restores = [...(cur.restores || [])];
      const i = restores.findIndex((x) => x.runId === run.id);
      const row = { runId: run.id, at: run.at, newName: v.restore?.newName || '', state: v.state, pointAt: v.restore?.pointAt ?? null };
      if (i >= 0) restores[i] = row; else restores.unshift(row);
      changed = upsert(v.vmId, base, { restores: restores.slice(0, RESTORES_MAX) }) || changed;
      continue;
    }
    if (v.how !== 'quick' && v.how !== 'portal') continue;
    const patch = { serverId: v.serverId, serverName: v.serverName, hostName: v.hostName || '', objectId: v.objectId || '', how: v.how, lastRunId: run.id, lastAt: run.at, lastState: v.state, final: FINAL.has(v.state) };
    if (v.how === 'portal') { patch.jobName = g.jobName || ''; patch.excludedAt = null; patch.deletedAt = null; }   // 다시 넣고 백업했다
    changed = upsert(v.vmId, base, patch) || changed;
  }
  if (changed) persist();
  return changed;
}

/** 잡에서 뺐다 / 백업을 지웠다(관리 창). */
export function notePortalVm(vmId, patch) {
  const cur = load().get(vmId);
  if (!cur) return false;
  if (upsert(vmId, { vcenterId: cur.vcenterId, name: cur.name }, patch)) { persist(); return true; }
  return false;
}

export function getPortalVm(vmId) { return load().get(vmId) || null; }
/** allowed = 조회 범위 vCenter 집합(null 이면 전체). vcenterId 를 주면 그 vCenter 만. */
export function listPortalVms({ allowed = null, vcenterId = '' } = {}) {
  return [...load().values()].filter((r) => (!allowed || allowed.has(r.vcenterId)) && (!vcenterId || r.vcenterId === vcenterId))
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}
export function _resetForTest() { _map = null; try { fs.rmSync(FILE()); } catch { /* 없음 */ } }
