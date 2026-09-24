/**
 * 일일 헬스체크 리포트 — 자동 발송 실패 안내 문구(순수, v2.603 감사 TIM2603-02 후속).
 *
 * 서버(`reports/dailyReport.js dailyReportStatus`)는 전 채널 실패가 이어지면 매 분이 아니라 15→30→60분 간격으로 다시 보내고
 * `failStreak`·`lastFailAt`·`nextRetryAt`·`lastFailReason` 을 준다. 간격을 늘린 사실을 화면이 말하지 않으면 사용자는
 * '고쳤는데 왜 안 보내지' 를 모른다 — 그래서 다음 자동 시도 시각과 '지금 발송은 바로 시도한다' 를 함께 적는다.
 * 시각은 서버가 주는 포탈 오프셋(`tzOffsetMin`) 기준 HH:MM 이다(브라우저 시간대가 아니다 — 발송 시각 칸과 같은 기준).
 */

/** epoch ms → 포탈 오프셋 기준 'HH:MM'. 값이 없으면 null(지어내지 않는다). */
export function portalHhmm(ts, offsetMin) {
  if (ts == null || ts === '' || typeof ts === 'boolean') return null;
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  const off = Number.isFinite(Number(offsetMin)) ? Number(offsetMin) : 540;
  const d = new Date(n + off * 60_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * 연속 실패 안내. 실패가 없으면 null.
 * @param {{failStreak?:number, nextRetryAt?:number|null, lastFailReason?:string, enabled?:boolean, tzOffsetMin?:number}} s
 * @returns {null | {streak:number, text:string}}
 */
export function dailyReportFailNote(s) {
  const streak = Number(s?.failStreak);
  if (!Number.isFinite(streak) || streak <= 0) return null;
  const next = portalHhmm(s?.nextRetryAt, s?.tzOffsetMin);
  const reason = String(s?.lastFailReason || '').trim();
  const parts = [`자동 발송 연속 실패 ${streak}회`];
  if (reason) parts.push(`마지막 사유: ${reason}`);
  if (s?.enabled === false) parts.push('자동 발송이 꺼져 있어 다시 시도하지 않습니다');
  else parts.push(next ? `다음 자동 시도 ${next} 이후(실패가 이어지면 간격을 15→30→60분으로 늘립니다)` : '다음 자동 시도 시각을 알 수 없습니다');
  parts.push('지금 발송은 간격과 무관하게 바로 시도합니다');
  return { streak, text: parts.join(' · ') };
}
