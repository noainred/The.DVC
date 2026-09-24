/**
 * addressHiddenText.js — 비-admin 에게 가린 장비 관리 주소·계정의 화면 표기(v2.599 AUTHZ-2599-03).
 *
 * 서버(`server/src/auth/addressMask.js`)가 스토리지·SAN 스위치·PDU 조회에서 비-admin 에게
 * host·username 을 빈 문자열로 주고 응답에 `addressHidden: true` 를 싣는다. 화면은 빈 칸을 그대로
 * 두지 않고 '—' 로 그리며, 왜 비었는지를 배너로 **한 번만** 말한다(행마다 반복하지 않는다 — v2.509).
 */

/** 주소 칸 표기 — 값이 없으면 '—'(빈 칸은 화면 결함처럼 읽힌다). */
export function hostText(v) {
  return v == null || v === '' ? '—' : String(v);
}

/** 응답이 주소를 가렸을 때만 배너 문구를 준다(아니면 null). BoldText 로 그린다 — 백틱 금지. */
export function addressHiddenNote(resp) {
  if (!resp || resp.addressHidden !== true) return null;
  return '장비 **관리 IP·접속 계정**은 관리자에게만 표시됩니다 — 이 계정에는 ‘—’ 로 보입니다. 수집 결과·상태는 그대로입니다.';
}
