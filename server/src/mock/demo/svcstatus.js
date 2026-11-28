/**
 * mock/demo/svcstatus.js — 포탈 서비스 상태 모니터링의 데모 측정(순수 · 결정적 · v3.54).
 *
 * ⚠ 데모 항목에 **실제로 접속하지 않는다** — 반환 모양은 실제 측정(svcstatus/probe.js probeTcp)과 같고, 판정 · DB · 화면은 실제 경로를 탄다
 *   (xferspeed 데모와 같은 원칙 — flags.js 머리말).
 * 네 상태가 다 보이게(시연):
 *   · 정상 — 대부분(종류 · 측정 위치별 평소 RTT 에 잔잡음)
 *   · 지연 — Edge-Shanghai(고RTT 회선 · degraded)가 재는 대상과 Shanghai 엣지 포탈: 최근 3시간 평소의 약 2.6배
 *   · 끊김 — 스토리지 하나(id 정렬 첫째): 최근 40분 연결 시간 초과(연속 실패)
 *   · 못 잼 — Edge-Singapore 는 보고하지 않는다(poller 가 그 엣지 보고를 합성하지 않는다 — 구버전 엣지 흉내)
 *   그 밖에 드문 일시 실패(약 0.4%)는 끊김 판정 전 '일시 실패' 칸을 보여 준다.
 * import 는 flags.js · edge.js 만(순환 SCC 제약 — demo2708edge ⑦ 과 같은 원칙).
 */
import { demoRand } from './flags.js';
import { demoEdgeOf } from './edge.js';

export const DEMO_SILENT_EDGE = 'mock-Edge-Singapore';
const SLOW_RECENT_MS = 3 * 3_600_000;
const DOWN_RECENT_MS = 40 * 60_000;

/** 대상의 평소 RTT(ms) — 결정적. */
export function demoBaseMs(target) {
  const id = String(target?.id || '');
  const by = String(target?.by || 'central');
  const r = demoRand(`svcbase|${id}`);
  if (target?.kind === 'collector') return demoEdgeOf(target?.ref || target?.name)?.rttMs ?? Math.round(40 + r * 60);
  if (by !== 'central') return Math.round(2 + r * 6);           // 엣지가 재는 현지 장비 — LAN
  return Math.round(6 + r * 30);                                 // 중앙이 직접 재는 장비
}

/**
 * 데모 측정 하나.
 * @param {{id:string, kind:string, by:string, ref?:string, name?:string}} target
 * @param {{ts:number, now?:number, downId?:string}} o  downId = 끊김을 보여 줄 대상 id(호출부가 고른다 — 정렬 첫 스토리지)
 * @returns {{ok:boolean, ms:number|null, fk:string|null}}
 */
export function demoSvcResult(target, { ts, now = ts, downId = '' } = {}) {
  const id = String(target?.id || '');
  const base = demoBaseMs(target);
  const age = now - ts;
  if (downId && id === downId && age <= DOWN_RECENT_MS) return { ok: false, ms: null, fk: 'timeout' };
  const slot = Math.floor(ts / 60_000);
  if (demoRand(`svcfail|${id}|${slot}`) < 0.004) return { ok: false, ms: null, fk: 'timeout' };
  const shanghai = String(target?.by || '').toLowerCase() === 'mock-edge-shanghai' || /shanghai/i.test(String(target?.ref || target?.name || ''));
  const slowNow = shanghai && age <= SLOW_RECENT_MS;
  const jitter = 0.9 + demoRand(`svcj|${id}|${slot}`) * 0.25;
  return { ok: true, ms: Math.max(1, Math.round(base * jitter * (slowNow ? 2.6 : 1))), fk: null };
}
