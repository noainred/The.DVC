/**
 * veeam/em/store.js — Enterprise Manager 별 마지막 결과(v2.788). veeam/store.js 와 같은 모양:
 *  · 키는 EM id. 값은 `{ result, at, lastOk? }`.
 *  · 실패 결과는 직전 성공 결과를 지우지 않는다 — `lastOk` 로 따로 들고, 화면은 '마지막 성공 시각' 과 오류를 함께 말한다.
 *  · 접속처 지문(target)이 다르면 이어받지 않는다(접속처를 바꾼 EM 에 옛 EM 의 숫자가 보이지 않게).
 *  · 파일(veeam-em-latest.json)은 재시작 직후 화면이 비지 않게 하는 캐시다(다시 받으면 되는 값 — 손상이면 빈 값으로 시작).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { createDebouncedWriter } from '../../central/edgeRecord.js';

const FILE = () => path.join(config.configDir, 'veeam-em-latest.json');
const MAX = 40;
let _map = null;
let _writer = null;

function load() {
  if (_map) return _map;
  _map = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    for (const [k, v] of Object.entries(raw?.ems || {})) if (v && typeof v === 'object' && v.result && typeof v.result === 'object') _map.set(k, v);
  } catch { /* 없거나 깨짐 — 다시 받으면 되는 캐시 */ }
  return _map;
}
const slim = (rec) => { if (!rec?.result?.ok || !rec.lastOk) return rec; const { lastOk: _drop, ...rest } = rec; return rest; };
function writer() {
  if (!_writer) _writer = createDebouncedWriter(FILE(), () => JSON.stringify({ v: 1, ems: Object.fromEntries([...load()].map(([k, v]) => [k, slim(v)])) }), { delayMs: 5_000, name: 'veeam-em-latest.json' });
  return _writer;
}

/** 결과 1건 기록 — expectTarget 과 결과 지문이 다르면 버린다(false). */
export function putEmResult(id, result, { expectTarget = '' } = {}) {
  const tgt = typeof result?.target === 'string' ? result.target : '';
  if (expectTarget && tgt && tgt !== expectTarget) return false;
  const m = load();
  if (!m.has(id) && m.size >= MAX) return false;
  const prev = m.get(id);
  const prevOk = prev ? (prev.result?.ok ? prev.result : prev.lastOk) : null;
  const rec = { result, at: Date.now() };
  if (!result?.ok && prevOk && (!tgt || !prevOk.target || prevOk.target === tgt)) rec.lastOk = prevOk;
  m.set(id, rec);
  writer().save();
  return true;
}
export function getEmRecord(id) {
  const r = load().get(id);
  if (!r) return null;
  return r.result?.ok ? { ...r, lastOk: r.result } : r;
}
export function dropEmResult(id) { if (load().delete(id)) writer().save(); }
export function pruneEmExcept(ids) {
  const keep = new Set(ids); let n = 0;
  for (const k of [...load().keys()]) if (!keep.has(k)) { load().delete(k); n++; }
  if (n) writer().save();
  return n;
}
export function _resetEmStoreForTest() { _map = new Map(); }
