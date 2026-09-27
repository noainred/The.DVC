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

/**
 * v2.632 WEB2632-07: 라이선스 사용 현황 — 여러 vCenter 가 같은 키를 보고해(Enhanced Linked Mode) 서버가 합계에서
 * 한 번만 센 보고 수(`duplicateKeys`, v2.631 AX2-06). 화면이 그 사실을 말하지 않으면 '제품별 합계' 가 아래 표의 행을
 * 더한 값과 달라 보인다. 0·없음이면 null(문구를 띄우지 않는다).
 * @returns {string|null}
 */
export function licenseDupNote(data) {
  const n = data?.duplicateKeys;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return null;
  return `여러 vCenter 가 같은 라이선스 키를 보고한 ${n.toLocaleString('en-US')}건은 제품별 합계에서 한 번만 셌습니다(아래 표는 vCenter 별 보고 그대로라 행을 더한 값과 합계가 다를 수 있습니다)`;
}
