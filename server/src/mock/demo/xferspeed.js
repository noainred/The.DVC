/**
 * mock/demo/xferspeed.js — 데모(mock) 모드의 법인 간 전송 속도 측정값(v2.735). **접속하지 않는다.**
 *
 * 데모 엣지(`edge.js DEMO_EDGES`)의 RTT 로 회선 속도를 정하고(가까울수록 빠르다), 그 엣지 현지 업무 시간에는 느려지게,
 * 30분 칸마다 결정적인 잡음을 더한다(같은 시각·같은 엣지는 언제나 같은 값). Edge-Shanghai 는 '평소보다 느려짐' 과
 * 가끔 실패를 보여 주려고 최근 6시간을 절반 가까이로 떨어뜨리고 약 6% 를 시한 초과로 둔다.
 * 판정·DB 는 실제 경로를 그대로 탄다 — 여기서는 측정 행(probe.js 반환 모양)만 만든다.
 */
import { demoRand } from './flags.js';
import { demoEdgeOf } from './edge.js';

const HOUR = 3_600_000;
const SLOT = 30 * 60_000;

/** 데모 엣지 현지 시각 오프셋(시) — 업무 시간 혼잡을 흉내 낸다. */
const LOCAL_OFFSET_H = { Seoul: 9, Singapore: 8, Frankfurt: 2, Ashburn: -4, Shanghai: 8 };

/** 기준 속도(Mbps) — RTT 가 길수록 TCP 창 한계로 느려진다(대략 12,000 / (RTT+10)). */
function baseMbps(e) {
  return Math.max(6, Math.min(900, 12_000 / ((e?.rttMs ?? 60) + 10)));
}

/**
 * 측정 행 하나(방향 dir) — probe.js measureDown/measureUp 반환과 같은 모양.
 * @param {object} col 수집 서버 등록부 항목(데모 엣지)
 */
export function demoXferResult(col, dir, { ts = Date.now(), bytes = 10 * 1_048_576 } = {}) {
  const e = demoEdgeOf(col?.id) || demoEdgeOf(col?.name);
  const slot = Math.floor(ts / SLOT);
  const r = (k) => demoRand(`xfer|${col?.id || col?.name}|${dir}|${k}|${slot}`);
  const rtt = e?.rttMs ?? 60;
  const localH = (((Math.floor(ts / HOUR) + (LOCAL_OFFSET_H[e?.datacenter] ?? 9)) % 24) + 24) % 24;
  const busy = localH >= 9 && localH <= 18 ? 0.32 : 0;
  const degradedNow = !!e?.degraded && (Date.now() - ts) < 6 * HOUR;
  const fail = !!e?.degraded && r('f') < 0.06;
  let mbps = baseMbps(e) * (dir === 'up' ? 0.62 : 1) * (1 - busy) * (0.86 + r('n') * 0.24) * (degradedNow ? 0.48 : 1);
  mbps = Math.round(mbps * 100) / 100;
  const ttfbMs = Math.round(rtt * 2.2 + r('t') * rtt * 0.4);   // ↑ 도 '전체 − 수신 구간' 의 연결·왕복(probe.js 와 같은 뜻)
  const base = { dir, ts, want: bytes, ttfbMs, basis: 'receiver', demo: true };
  if (fail) {
    const got = Math.round(bytes * (0.2 + r('g') * 0.5));
    return { ...base, ok: false, bytes: got, mbps: null, xferMs: null, totalMs: 120_000, kind: 'timeout', error: `시한(120초) 초과 — 시한 안에 ${(got / 1_048_576).toFixed(1)}MB / ${(bytes / 1_048_576).toFixed(1)}MB 만 받았습니다(데모)` };
  }
  const xferMs = Math.max(1, Math.round((bytes * 8) / (mbps * 1e6) * 1000 * 10) / 10);
  return { ...base, ok: true, bytes, mbps, xferMs, totalMs: Math.round(xferMs + ttfbMs), kind: null, error: '' };
}
