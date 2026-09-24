/**
 * 범위 제한 계정의 설정 저장 응답 → 화면 경고 문장(v2.607, 감사 WEB2607-02 · RECENT2607-06).
 *
 * 서버(auth/scopeMerge.js · routes/admin/opsSettings.js)는 범위 계정이 보낸 값 중 적용하지 않은 것을 응답에 싣는다 —
 *  · `unapplied` + `unappliedReason` — 요청 자체를 적용하지 않았다('전체 vCenter' 대상이라 목록을 바꿀 수 없음 등)
 *  · `ignoredGlobal` + `ignoredReason` — 전 법인 공용 값(사용 여부·전역 임계)을 바꾸지 않았다
 *  · `ignoredOutOfScope`(개수) — 이 계정 범위 밖 vCenter 키는 무시하고 직전 값을 보존했다
 * 예전에는 화면이 이것을 하나도 읽지 않고 '저장되었습니다' 만 말했다 — 바뀌지 않은 설정을 바뀐 것처럼 보고한다.
 * 문장은 서버 사유를 그대로 쓰고, 없으면 짧은 기본 문구를 쓴다(지어내지 않는다). 해당 없으면 빈 배열.
 */
export function scopeSaveNotes(r) {
  if (!r || typeof r !== 'object') return [];
  const out = [];
  if (r.unapplied) out.push(typeof r.unappliedReason === 'string' && r.unappliedReason ? r.unappliedReason : '요청한 대상 목록 변경은 적용하지 않았습니다(범위 제한 계정).');
  const glob = Array.isArray(r.ignoredGlobal) ? r.ignoredGlobal.filter((x) => typeof x === 'string') : [];
  if (glob.length) {
    const base = typeof r.ignoredReason === 'string' && r.ignoredReason ? r.ignoredReason : '전 법인 공용 값은 전체 범위 계정만 바꿀 수 있습니다 — 적용하지 않았습니다.';
    out.push(`${base} (적용하지 않은 항목: ${glob.join(', ')})`);
  }
  const n = Number.isFinite(r.ignoredOutOfScope) ? r.ignoredOutOfScope : 0;
  if (n > 0) out.push(`이 계정 범위 밖 vCenter ${n}개에 대한 값은 적용하지 않고 기존 설정을 그대로 두었습니다.`);
  return out;
}

/** 저장 성공 문장 뒤에 붙일 경고(없으면 ''). 경고가 있으면 '저장되었습니다' 가 전부 적용됐다는 뜻이 아님을 앞에 밝힌다. */
export function scopeSaveSuffix(r) {
  const notes = scopeSaveNotes(r);
  return notes.length ? ` ⚠ 일부는 적용되지 않았습니다 — ${notes.join(' ')}` : '';
}
