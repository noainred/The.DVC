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

const AGENT_MAX = 256;
const RESULTS_PER_POST = 200;
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * @param {string} agent  인증된 엣지 이름
 * @param {object} body   { status, results:[{serverId, ...result}] }
 * @param {Set<string>} owned  이 엣지에 배정된 서버 id
 * @returns {{ saved:number, dropped:{notOwned:number, bad:number} }}
 */
export function ingestVeeamPush(agent, body, owned, now = Date.now()) {
  const dropped = { notOwned: 0, bad: 0 };
  let saved = 0;
  const list = Array.isArray(body?.results) ? body.results.slice(0, RESULTS_PER_POST) : [];
  for (const raw of list) {
    if (!isObj(raw)) { dropped.bad++; continue; }
    const id = s(raw.serverId, 64);
    if (!id) { dropped.bad++; continue; }
    if (!owned.has(id)) { dropped.notOwned++; continue; }
    const r = sanitizeServerResult(raw, now);
    if (!r) { dropped.bad++; continue; }
    if (putResult(id, r, { via: 'edge', agent })) saved++;
  }
  saveVeeamEdgeStatus(agent, body?.status, { at: now, results: list.length, saved, ...(dropped.notOwned || dropped.bad ? { dropped } : {}) });
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
    status: { servers: num(x.servers), version: s(x.version, 32) || null, poller: { at: num(p.at), ok: num(p.ok), fail: num(p.fail), intervalMs: num(p.intervalMs), running: p.running === true } },
    ...(push ? { lastPush: push } : {}),
  });
}
export function veeamEdgeStatus(agent) { return _status.get(String(agent || '').toLowerCase()) || null; }
export function allVeeamEdgeStatus() { return [..._status.values()]; }
export function _resetForTest() { _status.clear(); }
