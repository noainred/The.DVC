/**
 * VM 합계(KPI) — `/vms` totals 와 법인별 집계(v2.909 `vmByVcenter.js`)가 같이 쓰는 계산 한 벌. 순수.
 *
 * v2.909 에 `routes/api/inventory.js /vms` 본문에서 글자 그대로 옮겼다(응답 바이트 동일 — test/vmDist2746 ④ 가 예전 구현과 대조한다).
 * 규칙(바꾸지 말 것):
 *  · 평균은 값이 있는 VM 만(v2.629 WEB2629-01) — 못 읽은 VM 을 0 으로 세면 평균이 거짓으로 내려간다. 대상이 0 이면 null('—'). 뺀 수는 missing.
 *  · diskGB·diskTB 는 읽은 VM 만(sm 이 null 을 0 으로 접는다) — 뺀 수를 storageUnknown 으로 밝힌다(v2.727 C-01).
 *  · 평균 디스크 사용률은 committed·uncommitted 를 **둘 다** 읽은 VM 만.
 *  · vcpu·ramGB 는 읽은 VM 만(v3.28.1 — 판정 코어 vcenter/vmSums.js · 템플릿 포함: 받은 목록 그대로) — 뺀 수를 vcpuUnknown·ramUnknown 으로,
 *    VM 이 있는데 하나도 못 읽었으면 null(0 이 아니다).
 *  · ⚠ 합의 순서를 바꾸지 말 것 — 부동소수 합은 순서에 따라 비트가 달라진다(정렬 뒤 합계를 예전과 같게).
 */
import { numOrNull } from '../util/numOrNull.js';
import { vmSumsOf, vmAllocOf } from '../vcenter/vmSums.js';   // v3.28.1: vCPU · 메모리 합의 판정 코어

/** 값이 있는 것만의 평균(소수 한 자리) + 뺀 개수. */
export function usageAvg(arr, fn) {
  let sum = 0; let n = 0;
  for (const v of arr) { const x = numOrNull(fn(v)); if (x == null) continue; sum += x; n += 1; }
  return { value: n ? Math.round((sum / n) * 10) / 10 : null, missing: arr.length - n };
}

/** /vms 의 totals 본문(키 순서 그대로). gpuCounts 는 호출부가 센 값. */
export function vmTotals(vms, gpuCounts) {
  const sm = (fn) => vms.reduce((a, v) => a + (fn(v) || 0), 0);
  const on = vms.filter((v) => v.powerState === 'POWERED_ON');
  const cpuAvg = usageAvg(on, (v) => v.cpuUsagePct);
  const memAvg = usageAvg(on, (v) => v.memUsagePct);
  const avg = (arr, fn) => usageAvg(arr, fn).value;
  const alloc = vmSumsOf(vms, { includeTemplates: true });   // v3.28.1
  const al = vmAllocOf(alloc);
  return {
    count: vms.length,
    poweredOn: on.length,
    poweredOff: vms.length - on.length,
    vcpu: al.vcpu,
    ramGB: al.memMB == null ? null : Math.round(al.memMB / 1024),
    vcpuUnknown: alloc.vcpuUnknown,   // v3.28.1: vCPU 를 못 읽어 vcpu 에서 뺀 VM 수
    ramUnknown: alloc.memUnknown,     // v3.28.1: 메모리를 못 읽어 ramGB 에서 뺀 VM 수
    diskGB: sm((v) => v.storageGB),
    diskTB: Math.round(sm((v) => v.storageGB) / 1024 * 10) / 10,
    avgCpuUsagePct: cpuAvg.value,
    avgMemUsagePct: memAvg.value,
    usageUnknown: { cpu: cpuAvg.missing, mem: memAvg.missing },   // v2.629 WEB2629-01: 사용률 미수집 구동 VM 수
    // v2.727(C-01): diskGB·diskTB 는 읽은 VM 만(sm 이 null 을 0 으로 접는다) — 뺀 수를 밝힌다.
    storageUnknown: vms.filter((v) => numOrNull(v.storageGB) == null).length,
    // 평균 디스크 사용율 = 프로비저닝(committed+uncommitted) 대비 실제 사용(committed).
    // thick 디스크는 uncommitted=0 → 100%. 게스트 파일시스템 사용율과는 다름.
    // v2.727(C-01): committed·uncommitted 를 **둘 다** 읽은 VM 만 — 한쪽이 null 이면 0 으로 접혀 0%·100% 가 지어진다.
    avgDiskUsagePct: avg(vms.filter((v) => numOrNull(v.storageGB) != null && numOrNull(v.uncommittedGB) != null && v.storageGB + v.uncommittedGB > 0),
      (v) => (v.storageGB / (v.storageGB + v.uncommittedGB)) * 100),
    gpu: gpuCounts,
  };
}
