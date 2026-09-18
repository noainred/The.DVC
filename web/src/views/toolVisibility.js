/**
 * toolVisibility.js — 특수기능 도구를 **숨길지 / 회색으로 보여줄지**(순수, v2.555).
 *
 * 사용자 선택(2026-09-18): 제한된 도구는 **"아예 숨긴다"**(회색 잠금이 아니라 목록에서 없앤다).
 *
 * 그런데 이 저장소의 기존 정책은 그 반대였다 — `SpecialTools.jsx:208` 이 "특수 기능은 항목이
 * 많아 '숨김'보다 '회색 잠금'이 낫다: 어떤 기능이 있는지는 보이고, 권한이 없으면 클릭만 막아
 * 관리자에게 요청할 수 있게 한다" 고 적고 있다. **둘 다 맞는 정책이므로 섞지 않고 축으로 나눈다**:
 *   · **허용 목록 모드**(관리자가 "이 사람은 이것만" 이라고 명시) → 목록 밖은 **숨긴다**.
 *     그 사람에게는 존재를 알릴 이유가 없고, 사용자가 그것을 요청했다.
 *   · **거부 목록 모드**(기존) → 그대로 **회색 잠금**. 기존 현장의 화면이 바뀌면 안 된다.
 *
 * ⚠ 판정을 화면마다 복제하지 말 것 — 카드 그리드·V4 내비 트리·⌘K 팔레트 셋이 같은 답을 써야
 *   한다. 한 곳만 고치면 "내비에는 없는데 팔레트로는 열린다" 가 된다(v2.536 이 겪은 유형).
 * ⚠ **이것은 접근제어가 아니라 표시**다. 서버 집행은 `auth/toolAccess.js` 가 한다 —
 *   화면만 고치는 것은 '메뉴 숨김' 이라는 것이 이 저장소의 기록된 교훈이다(v2.536).
 */

/**
 * 그 도구를 목록에서 **숨기는가**.
 * @param {{k:string, adminOnly?:boolean}} t  도구 정의(specialToolsList.js 항목)
 * @param {object} opt
 * @param {boolean} opt.isAdmin        admin 은 언제나 전부 본다(관리자 잠김 방지)
 * @param {string[]|null} opt.toolsAllowed  서버가 준 허용 목록(배열이면 허용 목록 모드)
 * @param {boolean} opt.hideAdminOnly  관리자 전용 도구를 숨기는 화면인가(V4 내비·팔레트 = true,
 *                                     특수기능 카드 그리드 = false → 회색 잠금 유지)
 */
export function toolHidden(t, { isAdmin = false, toolsAllowed = null, hideAdminOnly = false } = {}) {
  if (!t) return true;
  if (isAdmin) return false;
  if (Array.isArray(toolsAllowed)) {
    // 허용 목록 모드 — 목록에 있으면 관리자 전용 표시 관례도 넘어 보여 준다(api.js
    // toolExplicitlyAllowed 주석). 목록 밖은 전부 숨김.
    return !toolsAllowed.includes(t.k);
  }
  return hideAdminOnly ? !!t.adminOnly : false;
}

/** 도구 배열 필터(같은 판정 재사용 — 호출부가 `filter` 조건을 다시 쓰지 않게). */
export function visibleTools(tools = [], opt = {}) {
  return (tools || []).filter((t) => !toolHidden(t, opt));
}

/**
 * 카드 목록 머리말 — **허용 목록 모드에서는 '회색 카드' 안내가 거짓이 된다**(숨겨서 회색 카드가
 * 하나도 없다). v2.555 Chromium 판독에서 실제로 그렇게 보였다(수치로는 안 잡혔다).
 * @returns {string} BoldText 로 렌더할 문구(백틱 금지 — v2.553 규약)
 */
export function gridIntro({ isAdmin = false, toolsAllowed = null, shownCount = 0 } = {}) {
  if (!isAdmin && Array.isArray(toolsAllowed)) {
    if (!shownCount) {
      return '이 계정에는 사용할 수 있는 특수 기능이 **없습니다** — 관리자가 허용한 기능이 없거나, 허용한 기능이 이 화면에 없습니다. 관리자에게 요청하세요(설정 › 사용자 관리 › 특수기능).';
    }
    return `관리자가 이 계정에 허용한 기능 **${shownCount}개**만 표시됩니다. 허용되지 않은 기능은 목록에 나오지 않습니다.`;
  }
  return '아래 기능을 클릭하면 해당 진단을 실행해 보여줍니다. **🔒 회색 카드**는 접근 권한이 없어 클릭할 수 없습니다.';
}
