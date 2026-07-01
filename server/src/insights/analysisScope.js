/**
 * 서버 분석(법인별 서버 정보 등)의 스코프 필터 — 순수 함수.
 * 한 서버가 선택된 분류에 속하는지 판정한다. 세 축(상호 조합 가능):
 *   - vcenterId    : 그 vCenter의 가상화 장비만(vcenterId 일치). '__unmapped__'=vCenter 미소속.
 *   - datacenterId : 그 법인(DataCenter)의 모든 장비(dcOf 일치). '__unmapped__'=법인 미지정.
 *   - baremetal    : vCenter에 속하지 않는 물리(베어메탈) 장비만.
 * dcOf: 스캔 등록분은 server.datacenterId 직접, 그 외는 vCenter→DataCenter 할당(assign)으로 해석.
 */
export function serverInScope(server, scope = {}, assign = {}) {
  const s = server || {};
  const vcenterId = String(scope.vcenterId || '').trim();
  const datacenterId = String(scope.datacenterId || '').trim();
  const baremetal = scope.baremetal === true || String(scope.baremetal || '') === '1';
  const dcOf = String(s.datacenterId || assign[String(s.vcenterId || '')] || '');
  if (vcenterId) { if (vcenterId === '__unmapped__' ? !!s.vcenterId : s.vcenterId !== vcenterId) return false; }
  if (datacenterId) { if (dcOf !== (datacenterId === '__unmapped__' ? '' : datacenterId)) return false; }
  if (baremetal && s.vcenterId) return false;
  return true;
}
