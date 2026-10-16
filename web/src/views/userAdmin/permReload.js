/**
 * permReload.js — 사용자 관리 화면이 목록을 다시 읽을 때 권한 매트릭스를 어떻게 반영할지(순수 — v2.743 감사 WEB-02).
 *
 * 왜 필요한가: 계정 행 동작(추가·역할 변경·삭제·범위·비밀번호·OTP·로그인 차단)이 성공하면 화면이 load() 로 목록을 다시 읽는다.
 *   예전 load() 는 /admin/permissions 응답으로 매트릭스를 **조건 없이** 덮고 permDirty 를 내렸다 — 같은 화면 아래 '기능 권한(역할별)'
 *   표에서 저장하지 않은 편집과 '변경사항이 저장되지 않았습니다' 경고가 아무 말 없이 사라졌다.
 *
 * 규칙:
 *  · 저장하지 않은 편집이 없으면(dirty=false) 서버 값을 그대로 쓴다(예전과 같다).
 *  · 편집 중이면 **역할별 편집 칸**(PERM_EDIT_KEYS — savePerms 가 보내는 칸과 같다)은 지금 화면 값을 남기고,
 *    그 밖(사용자별 도구 재정의 users·카탈로그·역할 목록·adminRow 편집 가능 여부)은 서버 값을 쓴다 —
 *    계정을 지우면 서버에서 그 계정의 재정의가 빠지므로 users 는 서버가 진실이다. dirty 는 그대로 둔다.
 *  · 다시 읽기에 실패했으면(fetched 없음) 지금 값을 그대로 둔다.
 * kept 는 '편집을 지켰다' 는 사실 — 화면이 그 사실을 말할 수 있게 돌려준다.
 */

/** savePerms 가 서버로 보내는 역할별 편집 칸 — 이 칸만 화면 편집이 이긴다. */
export const PERM_EDIT_KEYS = Object.freeze(['operator', 'viewer', 'toolsDenied', 'adminDenied']);

export function mergeReloadedPerms(current, fetched, dirty) {
  if (!fetched || typeof fetched !== 'object') return { perms: current ?? null, dirty: Boolean(dirty && current), kept: false };
  if (!dirty || !current || typeof current !== 'object' || !current.matrix) return { perms: fetched, dirty: false, kept: false };
  const matrix = { ...(fetched.matrix || {}) };
  for (const k of PERM_EDIT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(current.matrix, k)) matrix[k] = current.matrix[k];
  }
  return { perms: { ...fetched, matrix }, dirty: true, kept: true };
}
