/**
 * util/fsType.js — 게스트 파티션의 파일 시스템 종류 이름(v2.798 — VM 목록 내보내기 '파일 시스템 종류').
 * GuestDiskInfo.filesystemType(vSphere 7.0 이상이 준다고 추정 — 실물 미확인)·엣지가 보낸 값 모두 이 형식만 받는다:
 * 영숫자·. _ - 1~32자. 그 밖(빈 값·잡음·긴 값)은 ''(모름 — 지어내지 않는다).
 */
export function fsTypeOf(v) {
  const s = typeof v === 'string' ? v.trim().slice(0, 33) : '';
  return /^[A-Za-z0-9._-]{1,32}$/.test(s) ? s : '';
}
