// mailSettingsText.js — 메일 설정 화면(설정 › 메일 발송 · 특수 기능 › 메일 진단) 공용 문구(순수 — vitest 가 고정한다).

/**
 * 결정(56~75 남긴 것) 73 ③: 범위 관리자(조회 또는 쓰기 범위가 제한된 관리자)에게 서버가 SMTP 계정 이름 · 수신자 목록을 빼고 보낸다(scopedMasked).
 *   빈 칸을 '설정 없음' 으로 읽지 않게 가린 사실과 개수를 말한다. 저장은 설정 소유자(전체 범위) 전용이라 이 계정에는 원래 열리지 않는다.
 */
export function mailMaskedText(s) {
  if (!s?.scopedMasked) return null;
  const kinds = Object.values(s.kinds || {});
  const per = kinds.reduce((a, k) => a + (k?.toCount || 0) + (k?.ccCount || 0), 0);
  return `범위 관리자에게는 SMTP 계정 이름과 수신자 목록을 가립니다(포탈 공용 설정) — 계정 ${s.smtp?.hasUser ? '있음' : '없음'} · 기본 수신자 ${s.defaultToCount ?? 0}명 · 종류별 수신자 ${per}명. 저장은 설정 소유자만 할 수 있습니다.`;
}
/** 73 ①: 메일 설정 파일을 못 읽은 동안의 안내(사유는 서버 요약 — 파일 조각 없음). */
export function mailLoadErrorText(le) {
  if (!le) return null;
  return `메일 설정 파일을 읽지 못했습니다 — ${le.reason || '사유 미상'}. 그동안 메일은 나가지 않고(기본값: 꺼짐) 저장은 거절합니다.`;
}
