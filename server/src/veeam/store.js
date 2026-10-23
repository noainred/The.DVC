/**
 * veeam/store.js — Veeam 서버별 마지막 결과(v2.751). 중앙 직접 수집과 엣지 push 가 같은 표에 들어간다.
 *
 *  · 키는 서버 id. 값은 `{ result, via:'local'|'edge', agent, at }` — 결과 모양은 parse.js sanitizeServerResult 와 같다.
 *  · 실패 결과는 직전 성공 결과의 VM 표를 지우지 않는다 — `lastOk` 로 따로 들고, 화면은 '마지막 성공 시각' 과 오류를 함께 말한다
 *    (한 주기 실패로 배지가 전부 사라지면 '백업 안 됨' 처럼 보인다).
 *  · 파일(veeam-latest.json)은 재시작 직후 화면이 비지 않게 하는 캐시다 — 상태 파일로 등록된다(백업 '변경 감시' 대상 아님).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { createDebouncedWriter } from '../central/edgeRecord.js';

const FILE = () => path.join(config.configDir, 'veeam-latest.json');
const MAX_SERVERS = 400;
let _map = null;
let _writer = null;

function load() {
  if (_map) return _map;
  _map = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    for (const [k, v] of Object.entries(raw?.servers || {})) if (v && typeof v === 'object') _map.set(k, v);
  } catch { /* 없거나 깨짐 — 다시 받으면 되는 캐시 */ }
  return _map;
}
function writer() {
  if (!_writer) _writer = createDebouncedWriter(FILE(), () => JSON.stringify({ v: 1, servers: Object.fromEntries(load()) }), { delayMs: 5_000, name: 'veeam-latest.json' });
  return _writer;
}

/**
 * 결과 1건 기록.
 * v2.762(G1): expectTarget(등록부의 지금 접속처 지문)이 있고 결과의 지문과 다르면 버린다(false) — 옛 접속처 결과가 새 서버 것으로 되살아나지 않게.
 *   lastOk 는 지문이 같을 때만 이어받는다. 지문이 없는 결과·기록(옛 엣지·업그레이드 전 파일)은 지금처럼 수용·승계한다(호환).
 */
export function putResult(serverId, result, { via = 'local', agent = '', expectTarget = '' } = {}) {
  const tgt = typeof result?.target === 'string' ? result.target : '';
  if (expectTarget && tgt && tgt !== expectTarget) return false;
  const m = load();
  if (!m.has(serverId) && m.size >= MAX_SERVERS) return false;
  const prev = m.get(serverId);
  const sameTarget = (t) => !tgt || !t || t === tgt;
  const okPart = (r) => ({ ts: r.ts, jobs: r.jobs, vms: r.vms, counts: r.counts, notes: r.notes, backups: r.backups, ...(r.target ? { target: r.target } : {}) });
  const rec = { result, via, agent: String(agent || ''), at: Date.now() };
  if (result?.ok) rec.lastOk = okPart(result);
  else if (prev?.lastOk && sameTarget(prev.lastOk.target)) rec.lastOk = prev.lastOk;
  else if (prev?.result?.ok && sameTarget(prev.result.target)) rec.lastOk = okPart(prev.result);
  m.set(serverId, rec);
  writer().save();
  return true;
}
export function getRecord(serverId) { return load().get(serverId) || null; }
export function dropResult(serverId) { if (load().delete(serverId)) writer().save(); }
/** 등록부에 없는 서버의 결과를 지운다(삭제된 서버의 유령 배지 방지). */
export function pruneExcept(ids) {
  const keep = new Set(ids); let n = 0;
  for (const k of [...load().keys()]) if (!keep.has(k)) { load().delete(k); n++; }
  if (n) writer().save();
  return n;
}
/** 대조에 쓸 VM 표 — 이번 결과가 성공이면 그것, 실패면 마지막 성공분. */
export function usableResult(rec) {
  if (!rec) return null;
  if (rec.result?.ok) return rec.result;
  return rec.lastOk || null;
}
export function _resetForTest() { _map = new Map(); }
