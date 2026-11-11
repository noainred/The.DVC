/**
 * storage/inspect/store.js — 점검 실행 **이력**(v2.964) — `storage-inspect-runs.json`(상태 파일 · 백업 변경 감시 대상 아님).
 *
 *  · 장비마다 최근 RUNS_MAX 회(실행 = { at, ms, method, source, agent?, facts, why, errors }). facts · why 는 저장 · 되살릴 때 sanitizeFacts 로 다시 자른다.
 *  · 원본 출력은 저장하지 않는다(크기 · 장비 응답에 들 수 있는 이름 · 주소 — 중앙에 싣지 않는다). 실패한 단계의 사유(160자)만.
 *  · 쓰기는 2초 디바운스 + 종료 시 동기 flush · 원자적 쓰기. 손상이면 원본을 `.corrupt.*` 로 보존하고 빈 이력으로 간다(무음 금지 — 콘솔 · 상태).
 *  · 같은 (장비, at) 실행은 한 번만(엣지 재전송 — duplicate).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../../util/atomicWrite.js';
import { registerExitFlush } from '../../util/exitFlush.js';
import { registerStateFile } from '../../util/stateFiles.js';
import { numOrNull } from '../../util/numOrNull.js';
import { capStr } from '../../util/capStr.js';
import { sanitizeFacts } from './facts.js';

export const RUNS_MAX = 12;
export const DEVICES_MAX = 1000;
const FILE = () => path.join(config.configDir, 'storage-inspect-runs.json');
const capErr = (e) => capStr(String(e?.message || e || '').slice(0, 400), 160);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, n) => (typeof v === 'string' ? capStr(v, n) : '');  // 상주 이력 — SlicedString 이 원문을 붙잡지 않게 평탄화(util/capStr.js)

let _map = null; let _loadErr = null; let _timer = null; let _dirty = false;
const _persist = { saved: 0, error: null };

/** 실행 정제(저장 · 엣지 수신 공용) — 아는 필드만. at 은 maxTs(수신 시각) 이하로 자른다. 잘못된 실행은 null. */
export function sanitizeRun(raw, { maxTs = Date.now() + 60_000 } = {}) {
  if (!isObj(raw)) return null;
  const at = numOrNull(raw.at);
  if (at == null || at <= 0) return null;
  const { facts, why } = sanitizeFacts(raw);
  const errors = (Array.isArray(raw.errors) ? raw.errors : []).slice(0, 16)
    .map((e) => (isObj(e) ? { step: str(e.step, 24), error: str(e.error, 160), ...(e.auth === true ? { auth: true } : {}) } : null)).filter(Boolean);
  const method = ['ssh', 'api', 'demo'].includes(raw.method) ? raw.method : 'api';
  return { at: Math.min(at, maxTs), ms: Math.max(0, Math.min(3_600_000, numOrNull(raw.ms) ?? 0)), method, facts, why, errors,
    ...(raw.edgeAt != null && numOrNull(raw.edgeAt) != null ? { edgeAt: numOrNull(raw.edgeAt) } : {}),
    ...(str(raw.agent, 64) ? { agent: str(raw.agent, 64) } : {}), ...(raw.partial === true ? { partial: true } : {}) };
}

function load() {
  if (_map) return _map;
  _map = new Map();
  const file = FILE();
  registerStateFile(file);
  registerExitFlush('storage-inspect-runs', flushSync);
  try {
    if (!fs.existsSync(file)) return _map;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isObj(j) || !isObj(j.devices)) throw new Error('점검 이력 파일 모양이 아닙니다');
    for (const [id, arr] of Object.entries(j.devices).slice(0, DEVICES_MAX)) {
      if (!Array.isArray(arr)) continue;
      const runs = arr.slice(0, RUNS_MAX).map((r) => sanitizeRun(r, { maxTs: Number.MAX_SAFE_INTEGER })).filter(Boolean).sort((a, b) => b.at - a.at);
      if (runs.length) _map.set(capStr(String(id), 128), runs);
    }
    _loadErr = null;
  } catch (e) {
    _loadErr = safeLoadText(e);
    preserveCorrupt(file, e?.message);
    console.warn(`[storage-inspect] 점검 이력 파일을 읽지 못해 빈 이력으로 시작합니다(원본은 .corrupt 로 보존): ${_loadErr}`);
  }
  return _map;
}
function flushSync() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (!_dirty) return;
  _dirty = false;
  try {
    atomicWriteFileSync(FILE(), JSON.stringify({ version: 1, at: Date.now(), devices: Object.fromEntries(load()) }), { mode: 0o600 });
    _persist.saved += 1; _persist.error = null;
  } catch (e) { _persist.error = capErr(e); console.warn(`[storage-inspect] 점검 이력 저장 실패: ${capErr(e)}`); }
}
function save() {
  _dirty = true;
  if (_timer) return;
  _timer = setTimeout(() => { _timer = null; flushSync(); }, 2_000);
  _timer.unref?.();
}

/** 실행 기록 — { saved, duplicate }. 정제를 통과하지 못하면 { saved:false, dropped:true }. */
export function recordRun(deviceId, raw, { maxTs } = {}) {
  const id = capStr(String(deviceId || ''), 128);
  const run = sanitizeRun(raw, { maxTs });
  if (!id || !run) return { saved: false, dropped: true };
  const m = load();
  const arr = m.get(id) || [];
  // 반증 F7: 시계가 빠른 엣지의 at 은 수신 시각으로 잘려 재전송마다 달라진다 — 엣지 원본 시각(edgeAt)이 있으면 그것으로 같은 실행을 알아본다.
  if (arr.some((r) => r.at === run.at || (run.edgeAt != null && r.edgeAt === run.edgeAt))) return { saved: false, duplicate: true };
  arr.unshift(run);
  arr.sort((a, b) => b.at - a.at);
  m.set(id, arr.slice(0, RUNS_MAX));
  if (m.size > DEVICES_MAX) { const oldest = [...m].sort((a, b) => a[1][0].at - b[1][0].at)[0]; if (oldest) m.delete(oldest[0]); }
  save();
  return { saved: true, run };
}
export function runsOf(deviceId, limit = RUNS_MAX) { return (load().get(String(deviceId)) || []).slice(0, limit); }
export function latestRunOf(deviceId) { return load().get(String(deviceId))?.[0] || null; }
export function latestAtOf(deviceId) { return latestRunOf(deviceId)?.at ?? null; }
/** 등록부에서 빠진 장비의 이력을 지운다(등록부를 읽었을 때만 — 호출부가 확인). */
export function pruneRuns(liveIds) {
  let removed = 0;
  for (const k of [...load().keys()]) if (!liveIds.has(k)) { load().delete(k); removed += 1; }
  if (removed) save();
  return removed;
}
export function inspectStoreStatus() {
  load();
  let runs = 0; for (const a of _map.values()) runs += a.length;
  return { devices: _map.size, runs, max: RUNS_MAX, loadError: _loadErr, persist: { ..._persist } };
}
export const inspectStoreLoadError = () => { load(); return _loadErr; };
export function _resetStoreForTest({ reload = false } = {}) {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (reload) { _map = null; _loadErr = null; _dirty = false; return; }
  _map = new Map(); _loadErr = null; _dirty = false; _persist.saved = 0; _persist.error = null;
}
export function _flushStoreForTest() { _dirty = true; flushSync(); return FILE(); }
