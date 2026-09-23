/**
 * views/idrac/manualPollText.js — '지금 1회 수집'(iDRAC 전력·센서) 응답 문구(순수, v2.591 — 감사 P1).
 *
 * 예전 화면은 응답의 `lastRun` 만 보고 '수동 1회 수집 — 성공 N · 실패 N' 이라 말했다. 그런데
 *  ① 다른 수집이 진행 중이면 서버의 재진입 가드가 이번 요청을 **실행하지 않고** 직전 결과를 돌려줬고
 *     (화면은 그것을 '방금 수집한 결과' 로 보고했다)
 *  ② 긴급중단 중이면 `lastRun.skipped` 가 '긴급중단' 인데 '성공 0 · 실패 0' 이라 했다.
 * 서버(`POST /admin/idrac/poll`)가 `busy`·`stopped` 를 싣고, 여기서 셋을 나눠 말한다.
 * 구버전 서버(두 필드 없음)는 예전 문구 그대로다.
 * @returns {{ ok: boolean, tone: 'green'|'red'|'amber', text: string }}
 */
export function manualPollMessage(r) {
  const lr = r?.lastRun || {};
  if (r?.busy) {
    return {
      ok: false, tone: 'amber',
      text: '다른 수집이 진행 중이라 이번 요청은 실행하지 않았습니다 — 동시에 두 번 돌리지 않습니다(같은 iDRAC 에 세션이 겹칩니다). 잠시 뒤 다시 누르세요.',
    };
  }
  if (r?.stopped || lr.skipped === '긴급중단') {
    return { ok: false, tone: 'amber', text: '긴급중단 중이라 수집하지 않았습니다 — 설정 › 긴급중단에서 해제한 뒤 다시 누르세요.' };
  }
  const auth = lr.authStopped ? ` · 인증 실패 정지 ${lr.authStopped}` : '';
  return { ok: !lr.failed, tone: lr.failed ? 'red' : 'green', text: `수동 1회 수집 — 성공 ${lr.ok ?? 0} · 실패 ${lr.failed ?? 0}${auth}` };
}
