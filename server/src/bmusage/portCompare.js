/**
 * bmusage/portCompare.js — 서버 NIC ↔ CVP 스위치 포트 **매핑 후보 · 상태 · 양쪽 대조(교차 판정 ⑤)** 순수 모듈(v2.922 · 3a · 설계 PROFILES §10).
 *
 *  · 매핑 출처(우선순위): ① 수동 매핑(portMap.js — 확정) ② 포트 설명 매칭(cvp/hostMatch.js — 호스트명·서비스 태그·NIC 이름·MAC 이
 *    descr 에 있으면 **후보** — 사람이 확정) ③ LLDP ④ MAC 테이블 — ③④ 는 **만들지 않는다**(CVP 경로 미확인 — 정직 기록 유지).
 *  · 상태 5종(+ 확정): no-mapping(매핑 없음) · candidate(후보 — 확인 필요) · no-cvp(CVP 미등록 법인) · no-counters(포트 카운터 없음 —
 *    CVP 빈 응답) · stale(오래됨) · mapped(확정 · 신선).
 *  · 대조 ⑤: 서버 tx ≈ 포트 in · 서버 rx ≈ 포트 out(같은 회선의 양 끝). **창을 맞출 수 없으면 비교하지 않는다**(window-mismatch) —
 *    두 값의 끝 시각 차와 계측 길이 차가 각각 긴 쪽 길이의 alignPct(기본 20% — 추정) 안일 때만. 기준(tolPct 기본 5% — 설정값) 이상 어긋나면
 *    ‘중간 손실 또는 계측 창 불일치 후보’ · 포트 오류·드롭만 있으면 ‘케이블·광모듈(GBIC 화면)’ · 서버 드롭만 있으면 ‘커널/큐(교차 ④)’.
 *    둘 다 거의 0(idleBps 아래)이면 비율이 뜻이 없다 — idle.
 *  · 단위: 서버는 B/s(bmusage), CVP 포트는 bit/s → 포트를 8 로 나눠 B/s 로 맞춘다.
 *  · ‘못 읽은 값’ 은 0 이 아니다 — 하나라도 null 이면 그 방향은 비교하지 않는다(numOrNull).
 */
import { numOrNull } from '../util/numOrNull.js';

const n = numOrNull;
// v2.922(반증 D15): 'no-permission' — CVP 도구 접근이 없는 계정(포트 값을 내주지 않는다).
export const PORT_STATES = Object.freeze(['mapped', 'candidate', 'no-mapping', 'no-cvp', 'no-counters', 'stale', 'no-permission']);
export const COMPARE_VERDICTS = Object.freeze(['ok', 'mismatch', 'port-errors', 'server-drops', 'idle', 'window-mismatch', 'no-data']);

/*
 * 설명 매칭 후보는 **cvp/hostMatch.js matchUplinks 하나**가 정한다(v2.920 가상화 호스트 업링크 매칭과 같은 판정 — 판정 코어는 하나).
 *   베어메탈은 별칭(서비스 태그)·리눅스 NIC 이름을 넘긴다(hostMatch 를 그만큼 넓혔다). 여기서는 그 결과를 후보로만 쓴다(사람이 확정).
 */
/**
 * 한 NIC 의 매핑 상태(순수).
 * @param {{mapping?:object|null, candidates?:Array, corpHasCvp:boolean, port?:object|null, now?:number, freshMs:number}} p
 */
export function portState({ mapping = null, candidates = [], corpHasCvp = true, port = null, now = Date.now(), freshMs = 30 * 60_000 } = {}) {
  if (!corpHasCvp) return 'no-cvp';
  if (!mapping) return candidates.length ? 'candidate' : 'no-mapping';
  if (!port) return 'no-counters';
  const hasCounters = ['in_bps', 'out_bps', 'in_err', 'out_err'].some((k) => n(port[k]) != null);
  if (!hasCounters) return 'no-counters';
  const at = n(port.rate_ts) ?? n(port.ts);
  if (at == null || now - at > freshMs) return 'stale';
  return 'mapped';
}

/**
 * 양쪽 대조 ⑤(순수).
 * @param {{server:{txBps,rxBps,at,spanMs,dropDelta,errDelta}, port:{in_bps,out_bps,rate_ts,spanMs,in_err,out_err,in_drop,out_drop}, tolPct?:number, alignPct?:number, idleBps?:number}} p
 * @returns {{verdict:string, reason?:string, tx?:object, rx?:object}}
 */
export function compareTraffic({ server = {}, port = {}, tolPct = 5, alignPct = 20, idleBps = 1_000 } = {}) {
  const sAt = n(server.at); const pAt = n(port.rate_ts ?? port.at); const sSpan = n(server.spanMs); const pSpan = n(port.spanMs);
  if (sAt == null || pAt == null || sSpan == null || pSpan == null || sSpan <= 0 || pSpan <= 0) return { verdict: 'no-data', reason: 'window-unknown' };
  const longer = Math.max(sSpan, pSpan);
  if (Math.abs(sAt - pAt) > longer * (alignPct / 100) || Math.abs(sSpan - pSpan) > longer * (alignPct / 100)) {
    return { verdict: 'window-mismatch', reason: `서버 ${Math.round(sSpan / 1000)}초 창 · 포트 ${Math.round(pSpan / 1000)}초 창 · 끝 시각 차 ${Math.round(Math.abs(sAt - pAt) / 1000)}초` };
  }
  const pair = (a, bBits) => {
    const x = n(a); const y = n(bBits) == null ? null : n(bBits) / 8;
    if (x == null || y == null) return null;
    const hi = Math.max(x, y);
    return { server: Math.round(x), port: Math.round(y), diffPct: hi < idleBps ? 0 : Math.round((Math.abs(x - y) / hi) * 1000) / 10, idle: hi < idleBps };
  };
  const tx = pair(server.txBps, port.in_bps);   // 서버가 보낸 것 = 포트가 받은 것
  const rx = pair(server.rxBps, port.out_bps);  // 포트가 보낸 것 = 서버가 받은 것
  if (!tx && !rx) return { verdict: 'no-data', reason: 'counters-missing' };
  const portErr = ['in_err', 'out_err', 'in_drop', 'out_drop'].some((k) => (n(port[k]) ?? 0) > 0);
  const srvDrop = (n(server.dropDelta) ?? 0) > 0 || (n(server.errDelta) ?? 0) > 0;
  const off = [tx, rx].some((x) => x && !x.idle && x.diffPct >= tolPct);
  let verdict = 'ok';
  if (off) verdict = 'mismatch';
  else if (portErr) verdict = 'port-errors';      // 둘 다면 포트 쪽(물리 계층)을 먼저 본다 — srvDrop 도 함께 싣는다
  else if (srvDrop) verdict = 'server-drops';
  else if ([tx, rx].every((x) => !x || x.idle)) verdict = 'idle';
  return { verdict, tx, rx, portErr, srvDrop, tolPct };
}
