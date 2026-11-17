/**
 * 112회차(설정 화면 스윕 — 106회차 R3 · R4 와 같은 꼴): '서버가 설정 파일을 읽지 못한 동안의 조회' 를 화면이 다루는 공용 판정(순수 — 화면 · vitest 가 같이 쓴다).
 *
 * 무엇이 틀렸나: 서버가 설정 파일을 **읽지 못한 동안**(읽기 오류 — EIO · EACCES · EISDIR) 조회(GET)는 저장된 값이 아니라 기본값 · 빈 목록을 준다.
 *   화면이 그 값으로 편집 폼을 채우고, 파일이 다시 읽힌 뒤(쓰기 거절 503 · 409 는 읽기 오류가 이어지는 동안만 막는다) ‘저장’ 한 번이
 *   저장돼 있던 설정을 그 기본값으로 덮는다 — 원본이 제자리에 있었으므로 보존본도 없다.
 * 규약: ① 조회 응답에 표지(`loadError` · `settingsLoadError` — { reason, readError }) ② 화면은 안내를 보이고 읽기 오류면 저장을 잠근다
 *   ③ 못 읽은 값으로 채운 폼은 상태가 바뀐 조회(다시 읽힘 · 손상으로 바뀜)의 값으로 다시 채운다(편집 중이어도).
 *   손상(보존본으로 옮김 — readError 아님)은 예전대로 저장이 해제 길이다(잠그지 않는다 — 지금 값이 기본값이라는 사실만 말한다).
 */
const txt = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
/**
 * 123회차: 목적격 조사 — 마지막 한글 글자에 받침이 있으면 ‘을’, 없으면 ‘를’(‘저장’ 을 · ‘지금 정리’ 를). 한글로 끝나지 않으면 ‘을’.
 *   버튼 이름이 화면마다 달라(‘저장 · 지금 정리’) 한 가지로 박아 두면 틀린다.
 */
export function objectParticle(word) {
  const t = txt(word);
  const c = t ? t.charCodeAt(t.length - 1) : 0;
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 === 0 ? '를' : '을';
}

/** 조회 응답에서 표지를 꺼낸다(없으면 null). 서버마다 이름이 둘이다 — `loadError`(대부분) · `settingsLoadError`(통신 점검 · 디스크 점검). */
export function unreadMarkOf(d) {
  if (!d || typeof d !== 'object') return null;
  // 객체인 것만 표지다 — 게스트 파티션 설정은 loadError 가 글자(예전 화면 문구)이고 표지는 settingsLoadError 에 따로 온다.
  for (const le of [d.loadError, d.settingsLoadError]) if (le && typeof le === 'object' && !Array.isArray(le)) return le;
  return null;
}

/** 폼을 채운 조회의 상태: '' 읽음 · 'read' 읽기 오류(원본 그대로) · 'corrupt' 손상(보존본) */
export function unreadKind(le) {
  if (!le || typeof le !== 'object') return '';
  return le.readError === true ? 'read' : 'corrupt';
}

/** 읽기 오류(다시 읽히면 풀린다)인가 — 참이면 ‘저장’ 을 잠근다. 손상은 저장이 해제 길이라 잠그지 않는다(서버가 손상도 거절하는 화면은 corruptLocks 로). */
export function saveLockedByUnread(le, { corruptLocks = false } = {}) {
  const k = unreadKind(le);
  return k === 'read' || (corruptLocks && k === 'corrupt');
}

/**
 * 못 읽은 값으로 채운 폼을 이번 조회의 값으로 다시 채울 것인가.
 *   seedKind = 폼을 채울 때의 상태(unreadKind) · le = 이번 조회의 표지. 채울 때 못 읽은 상태였고 지금 상태가 달라졌으면 참(편집 중이어도 버린다 — 그 편집은 기본값 위의 것이다).
 *   읽은 값으로 채운 폼(seedKind '')은 건드리지 않는다.
 */
export function shouldReseed(seedKind, le) {
  return !!seedKind && seedKind !== unreadKind(le);
}

/**
 * 안내 문구(표지가 없으면 ''). 값을 인용하는 백틱은 쓰지 않는다(화면 규칙).
 * @param {object|null} le  표지
 * @param {{ what?:string, save?:string, corruptLocks?:boolean, formHidden?:boolean }} [o]  what = 설정 이름(‘스토리지 수집 주기’) · save = 잠기는 버튼 이름 ·
 *   formHidden = 읽기 오류 동안 편집 칸을 아예 그리지 않는 화면(전체 교체 저장 — IPMS 설정) ·
 *   lastGood = 서버가 읽기 오류 동안 마지막으로 읽은 값을 주는 설정(LLM — 기동 뒤 한 번도 못 읽었을 때만 기본값이다. 기본값이라고 단정하지 않는다)
 */
export function settingsUnreadNote(le, { what = '설정', save = '저장', corruptLocks = false, formHidden = false, lastGood = false } = {}) {
  const k = unreadKind(le);
  if (!k) return '';
  const obj = objectParticle(save);   // 123회차: ‘저장 · 지금 정리’ 을 → 를
  const code = txt(le.code) && /^[A-Za-z0-9_-]{1,32}$/.test(le.code.trim()) ? `(${le.code.trim()})` : '';
  const why = txt(le.reason) || `설정 파일을 읽지 못했습니다${code}`;
  if (k === 'read' && formHidden) return `${what} — ${why} — 저장된 값을 읽지 못해 편집 칸을 열지 않습니다(빈 값으로 저장하면 저장된 설정이 지워집니다). 읽히면 저장된 값으로 엽니다.`;
  if (k === 'read' && lastGood) return `${what} — ${why} — 지금 보이는 값은 마지막으로 읽은 값(기동 뒤 한 번도 읽지 못했으면 기본값)이라 저장된 설정과 다를 수 있습니다. 다시 읽힐 때까지 ‘${save}’ ${obj} 잠급니다.`;
  if (k === 'read') return `${what} — ${why} — 지금 보이는 값은 저장된 설정이 아니라 기본값(빈 값)입니다. 다시 읽힐 때까지 ‘${save}’ ${obj} 잠급니다(읽히면 저장된 값으로 다시 채웁니다).`;
  return corruptLocks
    ? `${what} — ${why} — 지금 보이는 값은 저장된 설정이 아니라 기본값입니다. 풀릴 때까지 ‘${save}’ ${obj} 잠급니다(서비스 점검에서 확정하거나 보존본을 되돌리세요).`
    : `${what} — ${why} — 지금 보이는 값은 기본값입니다. ‘${save}’ ${obj} 누르면 이 화면의 값이 새 설정이 됩니다(손상 보존본은 그대로 남습니다).`;
}

/**
 * 못 읽은 동안 연 편집 창(모달)의 잠금 사유 — 창은 열 때의 값으로 폼을 채우고 다시 채우지 않는다.
 *   openedKind = 창을 열 때의 상태 · le = 지금 표지. 열 때 읽기 오류였으면 다시 읽힌 뒤에도 잠근다(닫고 다시 열어야 저장된 값이 보인다).
 * @returns {string} 잠금 사유(잠그지 않으면 '')
 */
export function staleSeedLock(openedKind, le, { what = '설정' } = {}) {
  if (unreadKind(le) === 'read') return `${what} 파일을 읽지 못한 상태라 저장을 잠급니다 — 지금 보이는 값은 저장된 설정이 아닙니다.`;
  if (openedKind === 'read') return `${what} 파일을 읽지 못한 동안 연 창입니다 — 이 창의 값은 저장된 설정이 아닙니다. 창을 닫고 다시 열면 저장된 값이 보입니다.`;
  return '';
}
