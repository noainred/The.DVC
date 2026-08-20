// 가상화율(과커밋) 집계용 순수 함수 — VCenterDetail 트리의 호스트·클러스터·DC 행에서 쓴다.
// 컴포넌트 안에 인라인으로 두면 단위테스트가 불가능하므로 분리했다(vcdSearch.js 와 같은 이유, v2.293).
//
// 'Off VM 포함' 체크박스(v2.333)와의 관계: **합산 대상 VM 은 호출부가 결정한다.** 체크를 해제하면
// 호출부가 POWERED_OFF 를 제외한 목록을 넘기고, 그러면 CPU·MEM 가상화율도 켜진 VM 기준으로 다시
// 계산된다(v2.334 — 사용자 요구). 이 모듈은 전원 상태를 보지 않으므로 필터 정책이 한 곳에만 남는다.

/**
 * 호스트명 -> 할당 vCPU 합계 / 할당 메모리(MB) 합계.
 * VM 은 vm.host(호스트명)로 호스트에 매핑된다. cpuCount/memMB 가 없거나 숫자가 아니면 0으로 본다.
 */
export function allocByHost(vms) {
  const vcpu = new Map();
  const vmem = new Map();
  for (const v of vms || []) {
    const k = v.host || '';
    vcpu.set(k, (vcpu.get(k) || 0) + (Number(v.cpuCount) || 0));
    vmem.set(k, (vmem.get(k) || 0) + (Number(v.memMB) || 0));
  }
  return { vcpu, vmem };
}

/** 호스트명 -> VM 대수. 'Off VM 포함' 해제 시 켜진 VM 만 세기 위해 호출부가 필터된 목록을 넘긴다. */
export function countByHost(vms) {
  const map = new Map();
  for (const v of vms || []) {
    const k = v.host || '';
    map.set(k, (map.get(k) || 0) + 1);
  }
  return map;
}

/**
 * 호스트 묶음(클러스터·데이터센터)의 합계.
 *   alloc / cores    = CPU 가상화율의 분자(할당 vCPU) · 분모(물리 코어)
 *   memAlloc/memPhys = MEM 가상화율의 분자(할당 VM RAM, MB) · 분모(물리 RAM, MB)
 *   vmc              = VM 수 합계. vmCount 맵(countByHost 결과)을 주면 그 값으로 세고,
 *                      주지 않으면 호스트가 보고한 h.vmCount(서버 집계값)를 쓴다.
 *                      전자는 'Off VM 포함' 해제 시(켜진 VM 만), 후자는 체크 시 사용한다 —
 *                      /vms 응답 상한에 걸릴 수 있는 대형 vCenter 에서도 전체 수는 서버 값이 정확하다.
 */
export function virtSum(hosts, vcpu, vmem, vmCount) {
  let alloc = 0, cores = 0, vmc = 0, memAlloc = 0, memPhys = 0;
  for (const h of hosts || []) {
    alloc += (vcpu && vcpu.get(h.name)) || 0;
    cores += Number(h.cpuCores) || 0;
    vmc += vmCount ? vmCount.get(h.name) || 0 : Number(h.vmCount) || 0;
    memAlloc += (vmem && vmem.get(h.name)) || 0;
    memPhys += Number(h.memTotalMB) || 0;
  }
  return { alloc, cores, vmc, memAlloc, memPhys };
}
