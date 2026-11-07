/**
 * svcmon/dash.js — **Monitoring 개요(기술 뷰)** 집계(v2.915 · 시안 ⑦ · Datadog 대시보드 참고).
 *
 * 입력은 이미 있는 것뿐이다 — 저장소 대상(origin 포함) · 이 포탈의 결과(poller getResults) · 중앙이 받은 엣지 보고(edgeState) ·
 * 전이 이력(transitions.js). 새 수집·네트워크 왕복 없음.
 *
 * 판정은 하나: 상태는 `status.js testState`(직접) · 엣지 행의 `state`(edgeState — 무보고 unknown · stale 포함)를 그대로 쓴다.
 * 여기서 상태를 다시 계산하지 않는다(KPI 와 트리가 어긋나는 사고 — constants.js statusOf 머리말과 같은 이유).
 *
 * v2.926(반증 M6 후속 — 실측: 로컬 200k 0.39초 · 엣지 192k 0.86초 동기): 집계 본체를 누산기(`createDashAcc`) 하나로 두고
 *   ① 동기판 `buildDash`(테스트·작은 입력) ② 시간 기준 양보판 `buildDashAsync`(라우트 — `util/timeSlice.js createYielder`)가 **같은 누산기**를 쓴다
 *   (두 벌 판정 금지). 표 위젯(느린 TOP · 연속 실패 · 인증서)은 전 항목 배열을 만들어 정렬하지 않고 **상위 K 만** 유지한다(메모리·정렬 비용).
 */

import { testState } from './status.js';
import { createYielder } from '../util/timeSlice.js';

const t = (v) => String(v ?? '').trim();
export const DASH_STATES = Object.freeze(['ok', 'warn', 'bad', 'stale', 'pending', 'disabled', 'unknown']);
const RANK = { bad: 6, unknown: 5, stale: 4, warn: 3, pending: 2, ok: 1, disabled: 0 };
export const worstOf = (a, b) => ((RANK[a] ?? 0) >= (RANK[b] ?? 0) ? a : b);
export const HEX_MAX = 1500;
export const TOP_SLOW = 8;
export const TOP_STREAK = 10;
export const TOP_CERT = 10;
export const CERT_WINDOW_DAYS = 60;

/** 'D-21' · '만료됨 (3일 경과)' → 남은 일수(만료면 음수). 못 읽으면 null. */
export function certDaysOf(reply) {
  const s = t(reply);
  let m = /^D-(\d{1,5})$/.exec(s);
  if (m) return Number(m[1]);
  m = /^만료됨 \((\d{1,5})일 경과\)$/.exec(s);
  return m ? -Number(m[1]) : null;
}

const groupOfTarget = (tg) => {
  const o = tg?.origin;
  if (o?.corp) return o.corp;
  const segs = t(tg?.path).split('\\');
  return segs[0] === '설정 연동' ? (segs[2] || segs[1] || '설정 연동') : (segs[0] || '(루트)');
};

/**
 * 상위 K 유지 — 정렬된 작은 배열에 끼워 넣는다(K 가 작아 선형 삽입이 전 배열 정렬보다 싸다).
 * `better(a, b)` 가 true 면 a 가 앞. 같은 점수면 먼저 들어온 것이 앞(입력 순서 — 동기판과 결과가 같다).
 */
function pushTop(arr, item, k, better) {
  if (arr.length >= k && !better(item, arr[arr.length - 1])) return;
  let i = arr.length;
  while (i > 0 && better(item, arr[i - 1])) i -= 1;
  arr.splice(i, 0, item);
  if (arr.length > k) arr.pop();
}

/**
 * 누산기 — 항목을 하나씩 넣고 마지막에 `finish()`. 동기·양보판이 같은 함수를 쓴다.
 * @param {{targets:object[]}} input
 */
export function createDashAcc({ targets = [] } = {}) {
  const summary = { total: 0 };
  for (const s of DASH_STATES) summary[s] = 0;
  const byOrigin = new Map();        // kind -> { kind, total, worst, counts }
  const hexByTarget = new Map();     // `${where}|${targetKey}` -> { id, targetKind, name, group, state, where, kind }
  const buckets = new Map();         // group -> hex[] (v2.926: 전체 hex 를 한 번에 localeCompare 정렬하지 않는다 — 반증 재검토 N3)
  const slow = []; const streaks = []; const certs = [];

  // 엣지 행 → 중앙 대상(출처) 조인 키 — 엣지 사본은 경로·이름이 같다(배정 스냅샷).
  const byPathName = new Map();
  for (const tg of targets) byPathName.set(`${t(tg.path)}\u0001${t(tg.name).toLowerCase()}`, tg);

  const add = (state, { tg, where, test, reply, ms, streak, type, targetName, host, path }) => {
    summary.total += 1;
    summary[state] = (summary[state] || 0) + 1;
    const kind = t(tg?.origin?.kind) || 'manual';
    const o = byOrigin.get(kind) || { kind, total: 0, worst: 'disabled', counts: {} };
    o.total += 1; o.counts[state] = (o.counts[state] || 0) + 1; o.worst = worstOf(o.worst, state);
    byOrigin.set(kind, o);
    const hk = `${where}|${tg?.id || `${path}|${targetName}`}`;
    let h = hexByTarget.get(hk);
    if (!h) {
      // id·targetKind 는 화면이 개요 → 트리로 그 대상을 바로 고르는 데 쓴다(v2.926). 중앙 저장소에 없는 엣지 행은 id 가 없다.
      h = { id: tg?.id || '', targetKind: tg?.kind || '', name: targetName, group: tg ? groupOfTarget(tg) : (t(path).split('\\')[0] || '(루트)'), state: 'disabled', where, kind };
      hexByTarget.set(hk, h);
      const b = buckets.get(h.group);
      if (b) b.push(h); else buckets.set(h.group, [h]);
    }
    h.state = worstOf(h.state, state);
    const m = Number.isFinite(ms) ? ms : null;
    const item = { state, where, target: targetName, host, path, test, type, reply: t(reply).slice(0, 120), ms: m, streak: Number(streak) || 0, kind };
    if ((state === 'ok' || state === 'warn') && m != null && type !== 'cert' && type !== 'domain') pushTop(slow, item, TOP_SLOW, (a, b) => a.ms > b.ms);
    if (state === 'bad') pushTop(streaks, item, TOP_STREAK, (a, b) => a.streak > b.streak);
    if (type === 'cert' || type === 'domain') {
      const days = certDaysOf(item.reply);
      if (days != null && days <= CERT_WINDOW_DAYS) pushTop(certs, { ...item, days }, TOP_CERT, (a, b) => a.days < b.days);
    }
  };

  /*
   * v2.926(반증 재검토 N3 — 실측: 50k hex localeCompare 정렬 71~153ms · 400k 0.84~1.44초 동기): 그룹은 add 에서 이미 묶였고,
   *   그룹 순서 → 그룹 안 이름 순서로 **HEX_MAX 가 찰 때까지만** 정렬한다. 비교는 코드 단위(cmp) — 한글 음절은 유니코드가 가나다 순이고
   *   localeCompare 보다 훨씬 싸다(대소문자는 대문자가 먼저 — 표시 순서만 다르다).
   */
  const cmp = (a, b) => (a < b ? -1 : (a > b ? 1 : 0));
  const finish = () => {
    const groups = [];
    let hexTotal = 0;
    for (const [group, list] of buckets) {
      const g = { group, total: list.length, worst: 'disabled', counts: {} };
      for (const h of list) { g.counts[h.state] = (g.counts[h.state] || 0) + 1; g.worst = worstOf(g.worst, h.state); }
      groups.push(g);
      hexTotal += list.length;
    }
    const hexes = [];
    for (const group of [...buckets.keys()].sort(cmp)) {
      if (hexes.length >= HEX_MAX) break;
      const list = buckets.get(group).slice().sort((a, b) => cmp(a.name, b.name));
      for (const h of list) { if (hexes.length >= HEX_MAX) break; hexes.push(h); }
    }
    return {
      summary,
      byOrigin: [...byOrigin.values()].sort((a, b) => (RANK[b.worst] - RANK[a.worst]) || b.total - a.total),
      groups: groups.sort((a, b) => (RANK[b.worst] - RANK[a.worst]) || cmp(a.group, b.group)),
      hexes, hexTotal, hexTruncated: hexTotal > HEX_MAX,
      slow, streaks, certs,
    };
  };
  return { add, finish, byPathName };
}

/** 직접 실행 결과 1건 → 누산기. */
function addLocal(acc, tg, x, results, now) {
  const r = results.get(x.id) || null;
  acc.add(testState(tg, x, results, now), { tg, where: '', test: x.name, reply: r?.reply, ms: r?.ms, streak: r?.streak, type: x.type, targetName: tg.name, host: tg.host, path: tg.path });
}
/** 엣지 행 1건 → 누산기. */
function addEdge(acc, agent, it) {
  const tg = acc.byPathName.get(`${t(it.path)}\u0001${t(it.target).toLowerCase()}`) || null;
  acc.add(DASH_STATES.includes(it.state) ? it.state : 'unknown', { tg, where: agent, test: it.test, reply: it.reply, ms: it.ms, streak: it.streak, type: it.type, targetName: it.target, host: it.host, path: it.path });
}

/**
 * 동기판 — 테스트·작은 입력용.
 * @param {{targets:object[], results:Map, edgeStates:object[], now?:number, executes?:boolean}} input
 *   edgeStates: [{ agent, silent, items:[{state,status,reply,ms,streak,path,target,host,test,type}] }]
 */
export function buildDash({ targets = [], results = new Map(), edgeStates = [], now = Date.now(), executes = true } = {}) {
  const acc = createDashAcc({ targets });
  if (executes) for (const tg of targets) for (const x of (tg.tests || [])) addLocal(acc, tg, x, results, now);
  for (const es of edgeStates) for (const it of (es.items || [])) addEdge(acc, es.agent, it);
  return acc.finish();
}

/**
 * 양보판 — 라우트용. `every` 항목마다 `maybeYield()`(시간 기준 — 15ms 를 넘겼을 때만 setImmediate 로 양보)를 부른다.
 * 엣지 행은 **엣지 하나씩** 받는다(`edgeItemsOf(agent)` — 전 엣지 행 배열을 한꺼번에 만들지 않게). 결과는 동기판과 같다(테스트가 대조).
 * @param {{targets:object[], results:Map, agents?:string[], edgeItemsOf?:(agent:string)=>object[], now?:number, executes?:boolean}} input
 */
export async function buildDashAsync({ targets = [], results = new Map(), agents = [], edgeItemsOf = () => [], now = Date.now(), executes = true } = {},
  { maybeYield = createYielder(15), every = 1000 } = {}) {
  const acc = createDashAcc({ targets });
  let n = 0;
  if (executes) {
    for (const tg of targets) {
      for (const x of (tg.tests || [])) {
        addLocal(acc, tg, x, results, now);
        if (++n % every === 0) await maybeYield();
      }
    }
  }
  for (const agent of agents) {
    await maybeYield();
    const items = edgeItemsOf(agent) || [];
    for (const it of items) {
      addEdge(acc, agent, it);
      if (++n % every === 0) await maybeYield();
    }
  }
  return acc.finish();
}
