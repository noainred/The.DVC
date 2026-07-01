/**
 * 서버 분석(법인별 서버 정보 등)의 스코프 필터 — 순수 함수.
 * 한 서버가 선택된 분류에 속하는지 판정한다. 세 축(상호 조합 가능):
 *   - vcenterId    : 그 vCenter의 가상화 장비만. '__unmapped__'=vCenter 미소속.
 *   - datacenterId : 그 법인(DataCenter)의 모든 장비(dcOf 일치). '__unmapped__'=법인 미지정.
 *   - baremetal    : vCenter에 속하지 않는 물리(베어메탈) 장비만.
 *
 * '가상화 소속 vCenter'는 명시 vcenterId가 있으면 그것, 없으면 mappedVcenterId
 * (서비스태그=ESXi 일련번호 매칭으로 찾은 vCenter)를 쓴다. 스캔 등록된 iDRAC 서버는
 * vcenterId가 비어 있어도, 그 서비스태그가 ESXi 호스트와 일치하면 그 vCenter의 가상화 장비로 인식된다.
 * dcOf: 스캔 등록분은 server.datacenterId 직접, 그 외는 (매핑 포함) vCenter→DataCenter 할당으로 해석.
 */
export function serverInScope(server, scope = {}, assign = {}) {
  const s = server || {};
  const vcenterId = String(scope.vcenterId || '').trim();
  const datacenterId = String(scope.datacenterId || '').trim();
  const baremetal = scope.baremetal === true || String(scope.baremetal || '') === '1';
  const effVc = String(s.vcenterId || s.mappedVcenterId || '').trim(); // 명시 또는 서비스태그 매핑 vCenter
  const dcOf = String(s.datacenterId || assign[effVc] || '');
  if (vcenterId) { if (vcenterId === '__unmapped__' ? !!effVc : effVc !== vcenterId) return false; }
  if (datacenterId) { if (dcOf !== (datacenterId === '__unmapped__' ? '' : datacenterId)) return false; }
  if (baremetal && effVc) return false;
  return true;
}
