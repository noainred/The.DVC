/**
 * 아이실론 디렉터리 사용량 '수집 대상 설정' 의 자리(v2.740, 순수 — vitest).
 *
 * 사용자 요청(2026-10-15): "수집 대상 설정은 설정 메뉴로 이동해서 일반 사용자, 관리자는 못 보게 해 줘" · "전체 설정 메뉴로 이동".
 *  · 설정 › 🗄 수집 서버 › 아이실론 디렉터리 사용량(키 `isilon-dirusage`) — 슈퍼 관리자에게만 메뉴가 보인다(Settings.jsx `superOnly`).
 *  · 서버 설정 API(조회·저장·일괄 변경·연결 시험·지금 메일·SSH 키)는 `requireSuperAdmin` 이 집행한다(화면 숨김은 표시일 뿐이다).
 *  · 일괄 변경 탭으로 바로 여는 주소는 `…/bulk` 다(설정 화면이 첫 렌더에서 한 번 읽는다).
 */
export const ISIDU_SETTINGS_KEY = 'isilon-dirusage';
export const ISIDU_SETTINGS_HASH = `#/settings/${ISIDU_SETTINGS_KEY}`;
export const ISIDU_SETTINGS_BULK_HASH = `${ISIDU_SETTINGS_HASH}/bulk`;
/** v2.742 종합 메일 탭으로 바로 여는 주소(메일 본문의 '바꾸는 곳' 안내와 같은 자리). */
export const ISIDU_SETTINGS_DIGEST_HASH = `${ISIDU_SETTINGS_HASH}/digest`;
/** 화면 문구에 쓰는 메뉴 경로(메뉴 이름을 바꾸면 Settings.jsx 의 label·GROUPS 와 함께 바꿀 것 — 테스트가 대조한다). */
export const ISIDU_SETTINGS_PLACE = '설정 › 수집 서버 › 아이실론 디렉터리 사용량';

/** 주소 조각 → 설정 화면의 첫 탭('bulk' | 'digest' | 'edit'). segs = hashSegments(hash). */
export function isiduSettingsTabOf(segs) {
  const s = Array.isArray(segs) ? segs : [];
  if (s[0] !== 'settings' || s[1] !== ISIDU_SETTINGS_KEY) return 'edit';
  return s[2] === 'bulk' || s[2] === 'digest' ? s[2] : 'edit';
}
