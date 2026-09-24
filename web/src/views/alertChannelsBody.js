import { blankOr } from './blankOr.js';

/**
 * 특수기능 › 리포트 › 알림 채널 저장 본문(v2.607, 감사 WEB2607-04). 중복 억제 창(분) 칸은 **원문 문자열**을 상태에
 * 두고 전송 때만 blankOr 로 바꾼다 — 빈 칸은 키를 빼서 서버(alerts.js)가 이전 값을 유지하게 한다.
 * 예전에는 onChange 가 `Number('') || 0` 으로 0(= 억제 끔)을 넣고 그대로 저장했다. 같은 /admin/alerts 를 쓰는
 * 설정 › 알림(Alerts2.jsx)은 v2.605 에 이미 이 규칙이다.
 */
export function alertChannelsBody(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  return { ...c, suppressWindowMin: blankOr(c.suppressWindowMin) };
}
