/**
 * svcmon/dash.js — **Monitoring 개요(기술 뷰)** 집계(v2.915 · 시안 ⑦ · Datadog 대시보드 참고).
 *
 * 입력은 이미 있는 것뿐이다 — 저장소 대상(origin 포함) · 이 포탈의 결과(poller getResults) · 중앙이 받은 엣지 보고(edgeState) ·
 * 전이 이력(transitions.js). 새 수집·네트워크 왕복 없음. 순수 함수(`buildDash`)와 입출력(`collectDash`)을 나눈다.
 *
 * 판정은 하나: 상태는 `status.js testState`(직접) · 엣지 행의 `state`(edgeState — 무보고 unknown · stale 포함)를 그대로 쓴다.
 * 여기서 상태를 다시 계산하지 않는다(KPI 와 트리가 어긋나는 사고 — constants.js statusOf 머리말과 같은 이유).
 */

import { testState } from './status.js';
import { createYielder } from '../util/timeSlice.js';

const t = (v) => String(v ?? '').trim();
export const DASH_STATES = Object.freeze(['ok', 'warn', 'bad', 'stale', 'pending', 'disabled', 'unknown']);
const RANK = { bad: 6, unknown: 5, stale: 4, warn: 3, pending: 2, ok: 1, disabled: 0 };
export const worstOf = (a, b) => ((RANK[a] ?? 0) >= (RANK[b] ?? 0) ? a : b);
export const HEX_MAX = 1500;

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

const SLOW_TOP = 8;
const STREAK_TOP = 10;
const CERT_TOP = 10;
const CERT_DAYS_MAX = 60;
/** 128행마다 양보 여부를 본다(시간 기준 판정은 createYielder — 행마다 await 하면 그 자체가 비용이다). */
const YIELD_EVERY = 128;

/**
 * 안정 top-K 삽입 — 같은 값이면 먼저 들어온 것이 앞이다. Array.prototype.sort 가 안정 정렬이므로 '전부 모아 정렬한 뒤 앞 K개' 와 같은 결과를
 * 전부 모으지 않고 낸다(v2.927 점검 E1-05 — 예전에는 로컬·엣지 전 행을 items 배열로 모은 뒤 filter·sort 했다).
 */
function pushTop(arr, item, k, cmp) {
  if (arr.length >= k && cmp(item, arr[arr.length - 1]) >= 0) return;
  let i = arr.length;
  while (i > 0 && cmp(item, arr[i - 1]) < 0) i -= 1;
  arr.splice(i, 0, item);
  if (arr.length > k) arr.pop();
}
const bySlow = (a, b) => b.ms - a.ms;
const byStreak = (a, b) => b.streak - a.streak;
const byDays = (a, b) => a.days - b.days;
const byHex = (a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name);

/**
 * 집계 본문 — **생성기**다. 128행마다(그리고 큰 정렬 사이마다) `yield` 하고, 호출자가 그 자리에서 양보할지 정한다.
 * 동기 판(buildDash)과 양보 판(buildDashAsync)이 같은 본문을 쓴다(판정을 두 벌로 두지 않는다).
 * @param {{targets:object[], results:Map, edgeStates:object[], now?:number, executes?:boolean}} input
 *   edgeStates: [{ agent, silent, items: Iterable<{state,status,reply,ms,streak,path,target,host,test,type}> }] — 배열 또는 반복자(central/svcmonEdge.js edgeItems)
 */
function* dashSteps({ targets = [], results = new Map(), edgeStates = [], now = Date.now(), executes = true } = {}) {
  const summary = { total: 0 };
  for (const s of DASH_STATES) summary[s] = 0;
  const byOrigin = new Map();        // kind -> { kind, total, worst, counts }
  const hexByTarget = new Map();     // `${where}|${targetKey}` -> { name, group, state, where }
  const slow = []; const streaks = []; const certs = [];   // 표 위젯(느린 TOP · 연속 실패 · 인증서) — 상한만큼만 들고 간다
  let n = 0;

  // 엣지 행 → 중앙 대상(출처) 조인 키 — 엣지 사본은 경로·이름이 같다(배정 스냅샷).
  const byPathName = new Map();
  for (const tg of targets) {
    byPathName.set(`${t(tg.path)}\u0001${t(tg.name).toLowerCase()}`, tg);
    if ((++n % YIELD_EVERY) === 0) yield;
  }

  const add = (state, { tg, where, test, reply, ms, streak, type, targetName, host, path }) => {
    summary.total += 1;
    summary[state] = (summary[state] || 0) + 1;
    const kind = t(tg?.origin?.kind) || 'manual';
    const o = byOrigin.get(kind) || { kind, total: 0, worst: 'disabled', counts: {} };
    o.total += 1; o.counts[state] = (o.counts[state] || 0) + 1; o.worst = worstOf(o.worst, state);
    byOrigin.set(kind, o);
    const hk = `${where}|${tg?.id || `${path}|${targetName}`}`;
    const h = hexByTarget.get(hk) || { name: targetName, group: tg ? groupOfTarget(tg) : (t(path).split('\\')[0] || '(루트)'), state: 'disabled', where, kind };
    h.state = worstOf(h.state, state);
    hexByTarget.set(hk, h);
    const item = { state, where, target: targetName, host, path, test, type, reply: t(reply).slice(0, 120), ms: Number.isFinite(ms) ? ms : null, streak: Number(streak) || 0, kind };
    if ((state === 'ok' || state === 'warn') && item.ms != null && type !== 'cert' && type !== 'domain') pushTop(slow, item, SLOW_TOP, bySlow);
    if (state === 'bad') pushTop(streaks, item, STREAK_TOP, byStreak);
    if (type === 'cert' || type === 'domain') {
      const days = certDaysOf(item.reply);
      if (days != null && days <= CERT_DAYS_MAX) pushTop(certs, { ...item, days }, CERT_TOP, byDays);
    }
  };

  if (executes) {
    for (const tg of targets) {
      for (const x of (tg.tests || [])) {
        const r = results.get(x.id) || null;
        add(testState(tg, x, results, now), { tg, where: '', test: x.name, reply: r?.reply, ms: r?.ms, streak: r?.streak, type: x.type, targetName: tg.name, host: tg.host, path: tg.path });
        if ((++n % YIELD_EVERY) === 0) yield;
      }
    }
  }
  for (const es of edgeStates) {
    for (const it of (es.items || [])) {
      const tg = byPathName.get(`${t(it.path)}\u0001${t(it.target).toLowerCase()}`) || null;
      add(DASH_STATES.includes(it.state) ? it.state : 'unknown', { tg, where: es.agent, test: it.test, reply: it.reply, ms: it.ms, streak: it.streak, type: it.type, targetName: it.target, host: it.host, path: it.path });
      if ((++n % YIELD_EVERY) === 0) yield;
    }
  }

  // 육각 지도: 법인(그룹) 집계는 전부 · 그리는 칸은 (그룹, 이름) 순 앞 HEX_MAX 개만 — 전부를 정렬하지 않는다(대상 수십만이면 localeCompare 정렬만 수백 ms).
  //   후보를 HEX_MAX 개씩 모아 '지금까지의 앞 HEX_MAX' 와 합쳐 정렬한다(안정 정렬 — 같은 키는 먼저 들어온 것이 앞: 전부 정렬한 뒤 자른 것과 같다).
  const groups = new Map();
  let best = []; let pend = [];
  for (const h of hexByTarget.values()) {
    const g = groups.get(h.group) || { group: h.group, total: 0, worst: 'disabled', counts: {} };
    g.total += 1; g.counts[h.state] = (g.counts[h.state] || 0) + 1; g.worst = worstOf(g.worst, h.state);
    groups.set(h.group, g);
    if (!(best.length >= HEX_MAX && byHex(h, best[best.length - 1]) >= 0)) {
      pend.push(h);
      if (pend.length >= HEX_MAX) { best = best.concat(pend).sort(byHex).slice(0, HEX_MAX); pend = []; yield; }
    }
    if ((++n % YIELD_EVERY) === 0) yield;
  }
  if (pend.length) best = best.concat(pend).sort(byHex).slice(0, HEX_MAX);
  const hexTotal = hexByTarget.size;

  return {
    summary,
    byOrigin: [...byOrigin.values()].sort((a, b) => (RANK[b.worst] - RANK[a.worst]) || b.total - a.total),
    groups: [...groups.values()].sort((a, b) => (RANK[b.worst] - RANK[a.worst]) || a.group.localeCompare(b.group)),
    hexes: best, hexTotal, hexTruncated: hexTotal > HEX_MAX,
    slow, streaks, certs,
  };
}

/** 동기 판 — 순수 함수(시험·작은 입력). 요청 경로는 buildDashAsync 를 쓴다. */
export function buildDash(input = {}) {
  const it = dashSteps(input);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

/**
 * v2.927(점검 E1-05 — 측정): 요청 경로용 — 같은 본문을 **시간 기준으로 양보**하며 돈다(perf-db '요청 경로의 큰 집계는 조각 + 시간 기준 양보').
 *   예전에는 로컬 점검 20만 + 엣지 행 19.2만을 한 번에 동기로 돌아 약 1.2초 이벤트 루프를 잡았다(30초 memo 가 바뀔 때마다 첫 요청).
 * @param {object} input buildDash 와 같다(edgeStates[].items 는 반복자여도 된다)
 * @param {{sliceMs?:number}} [opts]
 */
export async function buildDashAsync(input = {}, { sliceMs = 15 } = {}) {
  const y = createYielder(sliceMs);
  const it = dashSteps(input);
  let r = it.next();
  while (!r.done) { await y(); r = it.next(); }
  return r.value;
}
