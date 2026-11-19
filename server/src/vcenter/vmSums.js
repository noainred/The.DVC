/**
 * vcenter/vmSums.js — 호스트(또는 호스트 묶음)에 올라간 VM 의 vCPU · 메모리 할당 합(순수 · 판정 코어 하나, v3.19.1).
 *
 * 같은 판정이 세 벌이었다 — /hosts 요약(routes/api/inventory.js) · 법인별 보기(vcenter/hostCorp.js) · 호스트 엑셀(vcenter/hostExport.js 의 사본 vmSums).
 * 합은 같았지만 'VM 을 전부 못 읽음' 을 요약 · 엑셀은 null, 법인별은 0 · 비율 0 으로 냈다. 이제 세 곳이 이 모듈만 부른다
 * (회귀 server/test/vmSumsCore3191.test.js — 같은 입력으로 세 출력을 대조한다).
 *
 * 규칙
 *   · 템플릿은 세지 않는다(켤 수 없는 VM — templates 로 따로). 단 '전 VM 인벤토리 합'(/summary · 공개 API /inventory/summary — 템플릿도 VM 수에 든다)은
 *     `{ includeTemplates: true }` 로 부르거나 한 대씩 `vmSumAdd` 로 더한다(v3.19.2 — 못 읽은 값 판정은 여전히 이 파일 하나).
 *   · 못 읽은 cpuCount · memMB(null · '' · 공백 · 수 아님 — util/numOrNull.js)는 0 으로 더하지 않고 vcpuUnknown · memUnknown 으로 따로 센다.
 *   · VM 이 있는데 하나도 못 읽었으면 합은 0 이 아니라 null(모름 — vmAllocOf). 일부만 못 읽었으면 읽은 값의 합(부분 합 = 최소값) + unknown 수.
 *   · VM 이 없으면 0(모름이 아니다).
 * ⚠ 다른 도메인 모듈을 import 하지 않는다 — hostChecks.js 가 hostExport.js 를 부르므로, 이 코어가 둘 중 하나에 있으면 순환이 된다.
 */
import { numOrNull } from '../util/numOrNull.js';

/** 빈 합 — `vmSumAdd` 로 한 대씩 더한다(묶음별 누적용: OS 별 · vCenter 별). */
export function newVmSum() {
  return { n: 0, on: 0, templates: 0, vcpu: 0, memMB: 0, vcpuUnknown: 0, memUnknown: 0 };
}

/**
 * VM 한 대를 합에 더한다 — 못 읽은 cpuCount · memMB 는 0 으로 더하지 않고 unknown 으로 센다(이 파일의 유일한 '읽기 판정').
 * ⚠ 템플릿 여부는 보지 않는다 — 넣을지 말지는 부르는 쪽(vmSumsOf · /summary 의 kind 필터)이 정한다.
 */
export function vmSumAdd(out, v) {
  out.n += 1;
  if (v.powerState === 'POWERED_ON') out.on += 1;
  const c = numOrNull(v.cpuCount); if (c == null) out.vcpuUnknown += 1; else out.vcpu += c;
  const m = numOrNull(v.memMB); if (m == null) out.memUnknown += 1; else out.memMB += m;
  return out;
}

/**
 * 이 VM 들의 vCPU · 메모리(MB) 합 — 못 읽은 VM 은 unknown 으로 따로. 템플릿은 세지 않는다(기본).
 * @param {object[]} vms
 * @param {{ includeTemplates?: boolean }} [opts] includeTemplates: 템플릿도 n · 합에 넣는다(templates 수는 그대로 따로 센다)
 */
export function vmSumsOf(vms, { includeTemplates = false } = {}) {
  const out = newVmSum();
  for (const v of vms || []) {
    if (!v) continue;
    if (v.template === true) { out.templates += 1; if (!includeTemplates) continue; }
    vmSumAdd(out, v);
  }
  return out;
}

/**
 * 화면 · 응답에 싣는 할당 합 — VM 이 있는데 하나도 못 읽었으면 null(0 이 아니다).
 * @param {ReturnType<typeof vmSumsOf>} sum
 * @returns {{ vcpu:number|null, memMB:number|null }}
 */
export function vmAllocOf(sum) {
  const s = sum || {};
  const n = numOrNull(s.n) ?? 0;
  return {
    vcpu: n > 0 && s.vcpuUnknown === n ? null : (numOrNull(s.vcpu) ?? 0),
    memMB: n > 0 && s.memUnknown === n ? null : (numOrNull(s.memMB) ?? 0),
  };
}
