/**
 * central/veeamEdge.js — 엣지가 보낸 Veeam 결과의 정제·적재 + 엣지 상태 보관(v2.751).
 *
 * 규약(isiduEdge.js 와 같다):
 *  · 서버는 **그 엣지에 배정된 것만** 받는다(남의 서버 id 는 버리고 개수를 밝힌다). 저장 이름은 인증된 agent(호출부가 넘긴다).
 *  · 원소는 아는 필드만·객체만·상한(parse.js sanitizeServerResult). 엣지 시각은 수신 시각으로 자르고 원본은 edgeTs.
 *  · 엣지 상태는 인메모리(엣지 수 상한) — 화면이 '이 엣지가 언제 보냈나' 를 말하는 데 쓴다.
 */
import { sanitizeServerResult, s } from '../veeam/parse.js';
import { putResult } from '../veeam/store.js';
import { MAX_TIMER_MS } from '../config.js';

const AGENT_MAX = 256;
const RESULTS_PER_POST = 200;
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// v2.762(F-I2): 엣지 수집 주기는 엣지 pollMs 범위([2분, MAX_TIMER_MS] — veeam/poller.js clampIntervalMs)만 받는다. 밖이면 버린다(null — 중앙 주기로 판정).
const POLL_MIN_MS = 120_000;
const intervalOrNull = (v) => { const n = num(v); return n != null && n >= POLL_MIN_MS && n <= MAX_TIMER_MS ? n : null; };

/**
 * @param {string} agent  인증된 엣지 이름
 * @param {object} body   { status, results:[{serverId, ...result}] }
 * @param {Set<string>|Map<string,string>} owned  이 엣지에 배정된 서버 id(Map 이면 id → 등록부의 지금 접속처 지문 — v2.762 G1)
 * @returns {{ saved:number, dropped:{notOwned:number, bad:number, stale:number} }}
 */
export function ingestVeeamPush(agent, body, owned, now = Date.now()) {
  const dropped = { notOwned: 0, bad: 0, stale: 0 };
  let saved = 0;
  const list = Array.isArray(body?.results) ? body.results.slice(0, RESULTS_PER_POST) : [];
  for (const raw of list) {
    if (!isObj(raw)) { dropped.bad++; continue; }
    const id = s(raw.serverId, 64);
    if (!id) { dropped.bad++; continue; }
    if (!owned.has(id)) { dropped.notOwned++; continue; }
    const r = sanitizeServerResult(raw, now);
    if (!r) { dropped.bad++; continue; }
    // v2.762(G1): 중앙에서 접속처를 바꾼 뒤 엣지가 아직 pull 하지 않은 동안 보낸 옛 접속처 결과는 버린다(지문 없는 옛 엣지 결과는 수용).
    const want = owned instanceof Map ? String(owned.get(id) || '') : '';
    if (want && r.target && r.target !== want) { dropped.stale++; continue; }
    if (putResult(id, r, { via: 'edge', agent, expectTarget: want })) saved++;
  }
  saveVeeamEdgeStatus(agent, body?.status, { at: now, results: list.length, saved, ...(dropped.notOwned || dropped.bad || dropped.stale ? { dropped } : {}) });
  return { saved, dropped };
}

const _status = new Map();
export function saveVeeamEdgeStatus(agent, st, push = null) {
  const k = String(agent || '').toLowerCase();
  if (!k) return;
  if (!_status.has(k) && _status.size >= AGENT_MAX) {
    let oldK = null; let oldAt = Infinity;
    for (const [kk, v] of _status) if (v.at < oldAt) { oldAt = v.at; oldK = kk; }
    if (oldK) _status.delete(oldK);
  }
  const x = isObj(st) ? st : {};
  const p = isObj(x.poller) ? x.poller : {};
  _status.set(k, {
    agent: s(String(agent), 64), at: Date.now(),
    status: { servers: num(x.servers), version: s(x.version, 32) || null, poller: { at: num(p.at), ok: num(p.ok), fail: num(p.fail), intervalMs: intervalOrNull(p.intervalMs), running: p.running === true } },
    ...(push ? { lastPush: push } : {}),
  });
}
export function veeamEdgeStatus(agent) { return _status.get(String(agent || '').toLowerCase()) || null; }
export function allVeeamEdgeStatus() { return [..._status.values()]; }
export function _resetForTest() { _status.clear(); }
