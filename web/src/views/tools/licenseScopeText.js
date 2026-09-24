/**
 * 라이선스 만료 — 범위 계정에서 뺀 항목 안내(v2.603 AUTHZ-2603-01). 서버가 `scoped`·`omittedOutOfScope` 를 준다.
 * 뺀 것이 없으면 null(문구를 띄우지 않는다). 조용한 제외 금지 — 뺀 개수와 이유를 짧게 말한다.
 * @returns {string|null}
 */
export function licenseScopeNote(data) {
  const o = data?.omittedOutOfScope;
  if (!data?.scoped || !o || typeof o !== 'object') return null;
  const parts = [];
  const m = Number.isInteger(o.nsxManagers) ? o.nsxManagers : 0;
  if (m > 0) parts.push(`NSX 매니저 ${m}개(라이선스 ${Number.isInteger(o.nsxLicenses) ? o.nsxLicenses : '?'}건)`);
  if (o.horizon === true) parts.push('Horizon 라이선스(vCenter 에 매이지 않아 범위를 나눌 수 없음)');
  if (!parts.length) return null;
  return `내 조회 범위 밖이라 제외: ${parts.join(' · ')}`;
}
