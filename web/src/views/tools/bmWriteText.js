/**
 * views/tools/bmWriteText.js — 베어메탈 사용률 화면의 **쓰기 버튼 표지** 문구(점검 반복 2회차 E1 · E2 · 순수 · vitest bmLoop2.test.jsx).
 *
 * ⚠ 판정은 서버(`server/src/routes/api/bmWriteGate.js bmGate` — 라우트 게이트와 같은 판정: 데모 → 역할 → 전체 범위 · 법인 쓰기 범위)가 GET 응답에 싣는다
 *   (`actions.<동작> = { ok, why }` · 행 · 열 `writable`). 이 모듈은 그 값을 버튼 열림 · 한 줄 이유로 바꾸기만 한다 — 역할 · 범위를 다시 판정하지 않는다.
 * ⚠ 표지가 없으면(응답 실패 · 아직 못 읽음) 닫는다 — ‘조회 실패 상태로 저장 버튼을 열지 않는다’(루트 CLAUDE.md 프론트 회귀 방지).
 * ⚠ 문구에 백틱 금지(값 인용은 ‘ ’).
 */

/** 이유 code(서버 WRITE_WHY 와 1:1 — 시험이 대조) → 한 줄. */
export const WRITE_WHY_TEXT = Object.freeze({
  demo: '데모 계정은 할 수 없습니다(조회와 데모 수집만)',
  'role-admin': '관리자(admin)만 할 수 있습니다',
  'role-operator': '운영자(operator) 이상만 할 수 있습니다',
  'full-scope': '조회 · 쓰기 모두 전체 범위(vCenter 제한 없는) 계정만 할 수 있습니다 — 전 법인에 닿는 동작입니다',
  'read-only': '이 법인은 조회 전용입니다(쓰기 범위 밖)',
});

/** 버튼을 열어도 되나 — 서버 표지가 ok 일 때만(없으면 닫는다). */
export const gateOk = (g) => g?.ok === true;

/**
 * 버튼을 그릴까 — 열렸거나, 닫힌 이유가 역할이 아닐 때(범위 · 데모 · 조회 전용 — 잠근 채 이유를 보인다).
 *   역할이 모자란 계정(조회자 등)에는 예전처럼 그리지 않는다(쓰지 못할 기능 버튼을 늘어놓지 않게).
 */
export const gateShown = (g) => g?.ok === true || (!!g && !String(g.why || '').startsWith('role-'));

/** 닫힌 이유 한 줄 — 열려 있거나 이유를 모르면 ''(지어내지 않는다). */
export function gateWhy(g) {
  if (!g || g.ok === true) return '';
  return WRITE_WHY_TEXT[g.why] || '';
}

/** 버튼 마우스 설명(닫힌 버튼) — ‘동작 이름 — 이유’. 열려 있으면 undefined. */
export function gateTitle(g, label = '') {
  const w = gateWhy(g);
  if (!w) return g?.ok === true ? undefined : (label ? `${label} — 지금은 쓸 수 없습니다` : undefined);
  return label ? `${label} — ${w}` : w;
}

/**
 * 수집 설정 카드의 읽기 전용 한 줄(E1) — 알림 규칙 패널(BmPerfRulesPanel)의 ‘읽기 전용 — 저장은 …만 할 수 있습니다’ 와 같은 표현.
 *   열려 있으면 ''.
 */
export function settingsReadOnlyText(g, globalGate = undefined) {
  if (!gateOk(g)) {
    if (g?.why === 'demo') return '읽기 전용 — 데모 계정은 설정을 바꿀 수 없습니다.';
    if (g?.why === 'role-admin') return '읽기 전용 — 저장은 관리자(admin)만 할 수 있습니다.';
    return '읽기 전용 — 지금 이 계정으로는 저장할 수 없습니다(권한을 확인하지 못했습니다).';
  }
  // 재확인 R1: 전역 값(서버 actions.settingsGlobal — 조회 ∧ 쓰기 전체 범위)을 못 바꾸는 관리자는 쓰기 범위 법인의 켜기/끄기만.
  if (globalGate !== undefined && !gateOk(globalGate)) return SETTINGS_CORPS_ONLY_TEXT;
  return '';
}
export const SETTINGS_CORPS_ONLY_TEXT = '일부 읽기 전용 — 법인 켜기/끄기는 쓰기 범위 법인만 바꿀 수 있습니다. 수집 켜기 · 주기 · 보존 · 경로 · Enterprise · 알림 같은 전역 값은 조회 · 쓰기 모두 전체 범위(vCenter 제한 없는) 관리자만 바꿉니다.';
/** 쓰기 범위 밖 법인 칸의 마우스 설명(재확인 R1 — 서버 vcenters[].writable). */
export const CORP_READ_ONLY_TITLE = '조회 전용 법인(쓰기 범위 밖) — 수집을 켜고 끌 수 없습니다';
