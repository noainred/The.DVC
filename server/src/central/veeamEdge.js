/**
 * central/veeamEdge.js — 엣지가 보낸 Veeam 결과의 정제·적재 + 엣지 상태 보관(v2.751).
 *
 * 규약(isiduEdge.js 와 같다):
 *  · 서버는 **그 엣지에 배정된 것만** 받는다(남의 서버 id 는 버리고 개수를 밝힌다). 저장 이름은 인증된 agent(호출부가 넘긴다).
 *  · 원소는 아는 필드만·객체만·상한(parse.js sanitizeServerResult). 엣지 시각은 수신 시각으로 자르고 원본은 edgeTs.
 *  · 엣지 상태는 인메모리(엣지 수 상한) — 화면이 '이 엣지가 언제 보냈나' 를 말하는 데 쓴다.
 *  · v2.763(V2-2): 본문 최상위 sentAt(엣지 시계의 송신 시각)으로 엣지 시계 차이를 재 결과 ts·authStop.since·poller.at 을 중앙 시계로 옮긴다
 *    (edgeClockOffset). 엣지 시계가 늦으면 방금 받은 결과가 '오래됨' 이 되던 것을 막고, 재전송(옛 결과 반복)은 엣지 시계로 잰 나이가 남아
 *    계속 오래됨이다(rec.at 만 쓰면 이것을 못 잡는다). sentAt 이 없는 옛 엣지는 예전 그대로.
 */
import { sanitizeServerResult, s } from '../veeam/parse.js';
import { putResult } from '../veeam/store.js';
import { MAX_TIMER_MS } from '../config.js';
import { numOrNull } from '../util/numOrNull.js';

const AGENT_MAX = 256;
const RESULTS_PER_POST = 200;
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// v2.762(F-I2): 엣지 수집 주기는 엣지 pollMs 범위([2분, MAX_TIMER_MS] — veeam/poller.js clampIntervalMs)만 받는다. 밖이면 버린다(null — 중앙 주기로 판정).
const POLL_MIN_MS = 120_000;
const intervalOrNull = (v) => { const n = num(v); return n != null && n >= POLL_MIN_MS && n <= MAX_TIMER_MS ? n : null; };
// v2.763(V2-2): 이보다 큰 시계 차이는 보정하지 않는다(시계가 아니라 값이 틀린 것 — 지금처럼 미래만 자른다).
export const CLOCK_FIX_MAX_MS = 30 * 86_400_000;
// v2.763(R2-1): 이보다 작은 차이는 시계가 아니라 전송·재시도 지연이다 — 옮기면 시계가 맞는 엣지의 결과가 그만큼 새것처럼 보인다(보정 안 함).
export const CLOCK_FIX_MIN_MS = 120_000;

/**
 * v2.763(V2-2): 엣지 시계 차이(ms) = 중앙 수신 시각 − 본문 sentAt. sentAt 이 없거나(옛 엣지) 수가 아니거나 |차이| 가 30일을 넘으면 0(보정 안 함).
 *   오차는 전송·재시도 시간만큼(같은 본문을 다시 보내면 그만큼 '새것처럼') — 오래됨 한도(주기×2+2분) 대비 작다.
 */
export function edgeClockOffset(body, now = Date.now()) {
  const sent = numOrNull(isObj(body) ? body.sentAt : null);
  if (sent == null || sent <= 0) return 0;
  const off = now - sent;
  return Math.abs(off) > CLOCK_FIX_MAX_MS || Math.abs(off) < CLOCK_FIX_MIN_MS ? 0 : Math.round(off);
}

/**
 * @param {string} agent  인증된 엣지 이름
 * @param {object} body   { status, results:[{serverId, ...result}] }
 * @param {Set<string>|Map<string,string>} owned  이 엣지에 배정된 서버 id(Map 이면 id → 등록부의 지금 접속처 지문 — v2.762 G1)
 * @returns {{ saved:number, dropped:{notOwned:number, bad:number, stale:number} }}
 */
export function ingestVeeamPush(agent, body, owned, now = Date.now()) {
  const dropped = { notOwned: 0, bad: 0, stale: 0 };
  let saved = 0;
  const offset = edgeClockOffset(body, now);
  const list = Array.isArray(body?.results) ? body.results.slice(0, RESULTS_PER_POST) : [];
  for (const raw of list) {
    if (!isObj(raw)) { dropped.bad++; continue; }
    const id = s(raw.serverId, 64);
    if (!id) { dropped.bad++; continue; }
    if (!owned.has(id)) { dropped.notOwned++; continue; }
    const r = sanitizeServerResult(raw, now, { clockOffsetMs: offset });
    if (!r) { dropped.bad++; continue; }
    // v2.762(G1): 중앙에서 접속처를 바꾼 뒤 엣지가 아직 pull 하지 않은 동안 보낸 옛 접속처 결과는 버린다(지문 없는 옛 엣지 결과는 수용).
    const want = owned instanceof Map ? String(owned.get(id) || '') : '';
    if (want && r.target && r.target !== want) { dropped.stale++; continue; }
    if (putResult(id, r, { via: 'edge', agent, expectTarget: want })) saved++;
  }
  saveVeeamEdgeStatus(agent, body?.status, { at: now, results: list.length, saved, ...(dropped.notOwned || dropped.bad || dropped.stale ? { dropped } : {}) }, { clockOffsetMs: offset, now });
  return { saved, dropped };
}

const _status = new Map();
/** @param {{clockOffsetMs?:number, now?:number}} [clock] v2.763(V2-2): poller.at(엣지 시계)을 중앙 시계로 옮긴다 — 차이는 clockOffsetMs 로 함께 싣는다. */
export function saveVeeamEdgeStatus(agent, st, push = null, { clockOffsetMs = 0, now = Date.now() } = {}) {
  const k = String(agent || '').toLowerCase();
  if (!k) return;
  if (!_status.has(k) && _status.size >= AGENT_MAX) {
    let oldK = null; let oldAt = Infinity;
    for (const [kk, v] of _status) if (v.at < oldAt) { oldAt = v.at; oldK = kk; }
    if (oldK) _status.delete(oldK);
  }
  const x = isObj(st) ? st : {};
  const p = isObj(x.poller) ? x.poller : {};
  const pAt = num(p.at);
  _status.set(k, {
    agent: s(String(agent), 64), at: Date.now(),
    status: { servers: num(x.servers), version: s(x.version, 32) || null, poller: { at: pAt != null && clockOffsetMs ? Math.min(now, Math.max(0, pAt + clockOffsetMs)) : pAt, ok: num(p.ok), fail: num(p.fail), intervalMs: intervalOrNull(p.intervalMs), running: p.running === true } },
    ...(clockOffsetMs ? { clockOffsetMs } : {}),
    ...(push ? { lastPush: push } : {}),
  });
}
export function veeamEdgeStatus(agent) { return _status.get(String(agent || '').toLowerCase()) || null; }
export function allVeeamEdgeStatus() { return [..._status.values()]; }
export function _resetForTest() { _status.clear(); }
