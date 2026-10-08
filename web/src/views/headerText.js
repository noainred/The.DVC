/**
 * views/headerText.js — 상단 헤더(브랜드 행)의 순수 문구(v2.727, 사용자 선택 'C안').
 *
 * 배경: v2.726 까지 헤더의 역할 칸이 `user.role` 원문(`super_admin`)을 그대로 보였고 `.user-role` 의
 * `text-transform: capitalize` 가 그것을 `Super_admin` 으로 만들었다(사용자 캡처). 역할 표기는 여기 하나가 소유한다.
 *
 * 규칙:
 *  · 데모 계정이 먼저다 — 요청 문맥 역할은 admin 이지만(v2.716) 화면은 '데모 계정' 이라 말한다.
 *  · super_admin 은 요청 문맥에서 admin + `superAdmin:true` 로 접힌다(v2.643) — 표지로 판정한다.
 *  · 모르는 역할은 지어내지 않고 원문 그대로.
 */
export const ROLE_LABEL = Object.freeze({ admin: '관리자', operator: '운영자', viewer: '조회자' });

export function roleLabel(user) {
  if (!user) return '';
  if (user.demoGuest) return '데모 계정';
  if (user.superAdmin) return '슈퍼 관리자';
  return ROLE_LABEL[user.role] || String(user.role ?? '');
}

/** ⌘K 검색 버튼 문구 — 기능(특수 기능)·화면(탭)만 찾는다. VM 이름 검색은 Platform 탭의 검색창이다(여기서 약속하지 않는다). */
export const SEARCH_PLACEHOLDER = '기능 · 화면 찾기';
export const SEARCH_TITLE = '기능·화면 찾기 (⌘K / Ctrl+K)';

/** 수집 시각을 헤더 한 줄에 붙일 짧은 표기(ko-KR 시각). 읽지 못하면 빈 문자열 — '—' 를 붙이지 않는다(값 자리가 아니라 꼬리). */
export function generatedAtText(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('ko-KR');
}
