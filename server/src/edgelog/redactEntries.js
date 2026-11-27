/**
 * edgelog/redactEntries.js — 콘솔 링버퍼(logbuffer.js getLogs) 항목들을 응답에 싣기 전에 가린다(보안 잔여 11-27 L8).
 *
 * 왜: 같은 링버퍼가 엣지 → 중앙(collectEdgeLog) · 중앙 자신의 엣지 로그 화면 · 로그 분석 표본에서는 redactLogLine 을 거쳤는데,
 *   관리자 로그 뷰어(GET /api/admin/logs — 설정 › 진단 › 서버 로그)만 원문을 내보냈다(형제 불일치). 가림 판정 코어는 redact.js 의
 *   **redactLogLine 하나**이고, 이 파일은 '항목 묶음' 처리(원문 상한 · 순서 · 개수 · 표지 · 실패 처리)를 한 곳에 둔다 — 응답 출구는 이 함수를 쓴다
 *   (test/secResidual1127DemoLogs.test.js ⑧ 소스 스윕).
 *
 * 규칙
 *  · 18회차 반증 A-1 순서: **원문(SCAN_MAX 까지)을 다 가린 뒤** 화면 길이(lineMax)로 자른다 — 먼저 자르면 끝 표지('@' · 닫는 따옴표)가 잘린
 *    비밀 앞부분이 원문으로 나간다.
 *  · 가린 줄은 `masked: true` · 묶음의 가린 줄 수는 `masked`(조용한 가림 금지 — 화면이 개수를 말한다).
 *  · 가림 함수가 던지면 그 줄은 원문 없이 표지 문구로 바꾼다(fail-closed) — 나머지 줄은 그대로 나간다(가용성).
 *  · 항목 객체는 logbuffer 가 만든 뒤 바꾸지 않으므로 항목별 결과를 WeakMap 에 기억한다 — 3초 폴링이 같은 1,000줄을 다시 훑지 않게
 *    (기본 가림 함수일 때만 — 주입한 함수의 결과는 기억하지 않는다).
 *  · ⚠ 꼴 기반이라 완전하지 않다(redact.js 머리말 — PEM 여러 줄 · 이름 없는 비밀 · 사용자 지정 헤더). stdout · journal 에는 원문이 남는다 —
 *    화면이 그 사실을 말한다(web/src/views/logRedactText.js).
 */
import { redactLogLine } from './redact.js';

/** 가림 정규식에 넣는 원문 상한(logbuffer MSG_MAX 8,192 + 생략 표지보다 넉넉히 — collect.js 와 같은 값). */
export const SCAN_MAX = 16_384;
export const REDACT_FAIL_MSG = '[가림 실패 — 이 줄은 표시하지 않습니다]';

const _memo = new WeakMap();

function redactOne(e, redact) {
  const useMemo = redact === redactLogLine && e && typeof e === 'object';
  if (useMemo) { const hit = _memo.get(e); if (hit) return hit; }
  let out;
  try {
    const raw = String(e?.msg ?? '').slice(0, SCAN_MAX);
    const msg = String(redact(raw));
    out = { msg, masked: msg !== raw };
  } catch {
    out = { msg: REDACT_FAIL_MSG, masked: true };
  }
  if (useMemo) _memo.set(e, out);
  return out;
}

/**
 * @param {Array<{id:number,time:number,level:string,msg:string}>} entries getLogs().items
 * @param {{ lineMax?: number, redact?: (s:string)=>string }} [opt] lineMax 를 주면 가린 뒤 그 길이로 자른다(엣지 회신 2,000자). 로컬 뷰어는 자르지 않는다.
 * @returns {{ items: Array<{id,time,level,msg,masked?:true}>, masked: number }}
 */
export function redactLogEntries(entries, { lineMax = Infinity, redact = redactLogLine } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const items = [];
  let masked = 0;
  for (const e of list) {
    const r = redactOne(e, redact);
    const msg = Number.isFinite(lineMax) && lineMax >= 0 ? r.msg.slice(0, lineMax) : r.msg;
    if (r.masked) masked += 1;
    items.push({ id: e?.id, time: e?.time, level: e?.level, msg, ...(r.masked ? { masked: true } : {}) });
  }
  return { items, masked };
}
