/**
 * 물리(iDRAC) ↔ 가상화(vCenter ESXi) 매칭 — 순수 함수.
 * Dell 서버는 iDRAC '서비스태그'와 ESXi 호스트 하드웨어 '일련번호'가 동일하므로,
 * 서비스태그로 대응하는 vCenter 호스트를 찾는다. 대소문자·공백 무시.
 */
export function findHostByServiceTag(serviceTag, hosts = []) {
  const t = String(serviceTag || '').trim().toLowerCase();
  if (!t) return null;
  return (hosts || []).find((h) => String(h.serviceTag || '').trim().toLowerCase() === t) || null;
}
