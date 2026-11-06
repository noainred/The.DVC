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

/**
 * @param {{targets:object[], results:Map, edgeStates:object[], now?:number, executes?:boolean}} input
 *   edgeStates: [{ agent, silent, items:[{state,status,reply,ms,streak,path,target,host,test,type}] }]
 */
export function buildDash({ targets = [], results = new Map(), edgeStates = [], now = Date.now(), executes = true } = {}) {
  const summary = { total: 0 };
  for (const s of DASH_STATES) summary[s] = 0;
  const byOrigin = new Map();        // kind -> { kind, total, worst, counts }
  const hexByTarget = new Map();     // `${where}|${targetKey}` -> { name, group, state, where }
  const items = [];                  // 표 위젯용(느린 TOP · 연속 실패 · 인증서)

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
    const h = hexByTarget.get(hk) || { name: targetName, group: tg ? groupOfTarget(tg) : (t(path).split('\\')[0] || '(루트)'), state: 'disabled', where, kind };
    h.state = worstOf(h.state, state);
    hexByTarget.set(hk, h);
    items.push({ state, where, target: targetName, host, path, test, type, reply: t(reply).slice(0, 120), ms: Number.isFinite(ms) ? ms : null, streak: Number(streak) || 0, kind });
  };

  if (executes) {
    for (const tg of targets) {
      for (const x of (tg.tests || [])) {
        const r = results.get(x.id) || null;
        add(testState(tg, x, results, now), { tg, where: '', test: x.name, reply: r?.reply, ms: r?.ms, streak: r?.streak, type: x.type, targetName: tg.name, host: tg.host, path: tg.path });
      }
    }
  }
  for (const es of edgeStates) {
    for (const it of (es.items || [])) {
      const tg = byPathName.get(`${t(it.path)}\u0001${t(it.target).toLowerCase()}`) || null;
      add(DASH_STATES.includes(it.state) ? it.state : 'unknown', { tg, where: es.agent, test: it.test, reply: it.reply, ms: it.ms, streak: it.streak, type: it.type, targetName: it.target, host: it.host, path: it.path });
    }
  }

  const hexes = [...hexByTarget.values()].sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  const groups = new Map();
  for (const h of hexes) {
    const g = groups.get(h.group) || { group: h.group, total: 0, worst: 'disabled', counts: {} };
    g.total += 1; g.counts[h.state] = (g.counts[h.state] || 0) + 1; g.worst = worstOf(g.worst, h.state);
    groups.set(h.group, g);
  }
  const slow = items.filter((x) => (x.state === 'ok' || x.state === 'warn') && x.ms != null && x.type !== 'cert' && x.type !== 'domain')
    .sort((a, b) => b.ms - a.ms).slice(0, 8);
  const streaks = items.filter((x) => x.state === 'bad').sort((a, b) => b.streak - a.streak).slice(0, 10);
  const certs = items.filter((x) => x.type === 'cert' || x.type === 'domain').map((x) => ({ ...x, days: certDaysOf(x.reply) }))
    .filter((x) => x.days != null && x.days <= 60).sort((a, b) => a.days - b.days).slice(0, 10);

  return {
    summary,
    byOrigin: [...byOrigin.values()].sort((a, b) => (RANK[b.worst] - RANK[a.worst]) || b.total - a.total),
    groups: [...groups.values()].sort((a, b) => (RANK[b.worst] - RANK[a.worst]) || a.group.localeCompare(b.group)),
    hexes: hexes.slice(0, HEX_MAX), hexTotal: hexes.length, hexTruncated: hexes.length > HEX_MAX,
    slow, streaks, certs,
  };
}
