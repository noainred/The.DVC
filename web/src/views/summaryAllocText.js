/**
 * views/summaryAllocText.js — Summary 화면의 'VM 할당 합(vCPU · 메모리)' 글자(순수 — vitest 로 고정, v3.19.2).
 *
 * 서버 `/summary` 는 못 읽은 cpuCount · memMB 를 0 으로 더하지 않는다(판정 코어 server `vcenter/vmSums.js`):
 *   · 합은 읽은 VM 만, 못 읽은 VM 수는 `vcpuUnknown` · `ramUnknown`(allocation · osAllocation[] · byVcenter[] 세 곳 같은 이름).
 *   · VM 이 있는데 하나도 못 읽었으면 합이 **null** 이다(0 이 아니다) → '—'(단위 없음).
 *   · 일부만 못 읽었으면 값 옆에 '미상 N'(같은 표의 디스크 · 스토리지 열과 같은 표기), 그 합으로 낸 비율에는 '≥'(최소값 — /hosts 요약 · 법인별 보기와 같은 표기).
 */
import { numOrNull } from '../numOrNull.js';

const n = numOrNull;
const fmt = (v) => v.toLocaleString('en-US');
/** 종류별 낱말 — 조사까지(‘vCPU 를’ · ‘메모리를’). */
const WORD = Object.freeze({ vcpu: { name: 'vCPU', obj: 'vCPU 를' }, ram: { name: '메모리', obj: '메모리를' } });
const wordOf = (kind) => WORD[kind] || WORD.vcpu;

/** 그 행(allocation · OS 행 · vCenter 행)에서 vCPU('vcpu') · 메모리('ram')를 못 읽어 합에서 뺀 VM 수. 없거나 못 읽었으면 0. */
export function allocUnknownOf(row, kind = 'vcpu') {
  const v = n(kind === 'ram' ? row?.ramUnknown : row?.vcpuUnknown);
  return v != null && v > 0 ? v : 0;
}

/**
 * 표의 할당 합 칸.
 * @returns {{ text:string, mark:string, title:string, sort:number|string }} mark 는 값 옆 흐린 글자('미상 N' — 없으면 ''), sort 는 `data-sort`(null 은 '' → 항상 뒤로)
 */
export function allocCell(value, unknown, kind = 'vcpu') {
  const v = n(value);
  const u = n(unknown) > 0 ? n(unknown) : 0;
  const w = wordOf(kind);
  if (v == null) {
    return { text: '—', mark: u > 0 ? `미상 ${fmt(u)}` : '', sort: '',
      title: u > 0 ? `VM ${fmt(u)}대의 ${w.obj} 하나도 읽지 못했습니다 — 합을 내지 않습니다(0 이 아닙니다)` : '' };
  }
  return { text: fmt(v), mark: u > 0 ? `미상 ${fmt(u)}` : '', sort: v,
    title: u > 0 ? `${w.obj} 못 읽은 VM ${fmt(u)}대는 이 값에서 뺐습니다(0 으로 채우지 않음 — 최소값)` : '' };
}

/** KPI 부제 조각 — 'vCPU 미상 VM 3대 제외'. 못 읽은 VM 이 없으면 ''. */
export function allocUnknownSub(unknown, kind = 'vcpu') {
  const u = n(unknown);
  return u != null && u > 0 ? `${wordOf(kind).name} 미상 VM ${fmt(u)}대 제외` : '';
}

/**
 * 할당 합 KPI(‘할당된 vCPU 합계’ · ‘할당된 RAM 합계’)의 부제 조각 — 합이 null(하나도 못 읽음)이면 '제외' 가 아니라 '읽지 못했습니다'
 * (뺄 합이 없다 — Chromium 판독 v3.19.2). 일부만 못 읽었으면 allocUnknownSub. 못 읽은 VM 이 없으면 ''.
 */
export function allocKpiSub(value, unknown, kind = 'vcpu') {
  const u = n(unknown);
  if (!(u > 0)) return '';
  return n(value) == null ? `VM ${fmt(u)}대의 ${wordOf(kind).obj} 읽지 못했습니다` : allocUnknownSub(u, kind);
}

/** 비율 · 퍼센트 앞 표지 — 분자(할당 합)가 부분 합이면 '≥ '(최소값). 비율이 없으면(null) 붙이지 않는다('—' 앞에 '≥' 금지). */
export function minMark(ratio, unknown) {
  return ratio != null && n(unknown) > 0 ? '≥ ' : '';
}

/**
 * 비율 KPI 의 부제 — 비율이 없는 이유를 단정하지 않고 실제 이유를 말한다.
 * @param {number|null} ratio 화면이 쓰는 비율(serverRatio 결과)
 * @param {{ sub:string }} kpi ratioKpi 결과(물리 자원 기준 문구)
 * @param {{ allocated:any, unknown:any, kind?:'vcpu'|'ram', capSub?:string|null }} o capSub: 용량 미상 호스트 문구(있으면 그것이 먼저)
 */
export function ratioKpiSub(ratio, kpi, { allocated, unknown, kind = 'vcpu', capSub = null } = {}) {
  const u = n(unknown) > 0 ? n(unknown) : 0;
  if (ratio == null) {
    if (capSub) return capSub;
    if (u > 0 && n(allocated) == null) return `VM ${fmt(u)}대의 ${wordOf(kind).obj} 읽지 못했습니다 — 판정 보류`;
    return kpi?.sub || '';
  }
  return u > 0 ? `${kpi?.sub || ''} · 최소값(${allocUnknownSub(u, kind)})` : (kpi?.sub || '');
}

/**
 * vCenter 별 가상화율 창의 배지 툴팁 — 비율을 내지 않은 이유(용량 미상 호스트가 먼저 · 다음이 '할당을 하나도 못 읽음').
 * @param {object} vc byVcenter 행
 * @param {'vcpu'|'ram'} kind
 * @param {string|null} capTitle capUnknownTitle(vc)
 * @param {string} fallback 물리 자원을 못 읽었을 때의 기존 문구
 */
export function ratioBadgeTitle(vc, kind, capTitle, fallback) {
  if (capTitle) return capTitle;
  const u = allocUnknownOf(vc, kind);
  const allocated = kind === 'ram' ? vc?.ramAllocatedGB : vc?.vcpuAllocated;
  if (u > 0 && n(allocated) == null) return `VM ${fmt(u)}대의 ${wordOf(kind).obj} 하나도 읽지 못해 가상화율을 판정하지 않았습니다(할당 0 이 아닙니다).`;
  return fallback;
}

/**
 * OS 별 표의 합계 행 — 읽은 행만 더하고(null 은 0 이 아니다), 못 읽은 VM 수를 함께 돌려준다.
 * 행이 있는데 그 열을 전부 못 읽었으면 합은 null('—').
 * @returns {{ vms:number, vcpu:number|null, ramGB:number|null, diskGB:number, vcpuUnknown:number, ramUnknown:number, storageUnknown:number }}
 */
export function osAllocTotals(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = { vms: 0, vcpu: 0, ramGB: 0, diskGB: 0, vcpuUnknown: 0, ramUnknown: 0, storageUnknown: 0 };
  let vcpuRead = 0; let ramRead = 0;
  for (const r of list) {
    out.vms += n(r?.vms) ?? 0;
    const c = n(r?.vcpu); if (c != null) { out.vcpu += c; vcpuRead += 1; }
    const m = n(r?.ramGB); if (m != null) { out.ramGB += m; ramRead += 1; }
    out.diskGB += n(r?.diskGB) ?? 0;
    out.vcpuUnknown += allocUnknownOf(r, 'vcpu');
    out.ramUnknown += allocUnknownOf(r, 'ram');
    out.storageUnknown += n(r?.storageUnknown) > 0 ? n(r.storageUnknown) : 0;
  }
  if (list.length > 0 && vcpuRead === 0) out.vcpu = null;
  if (list.length > 0 && ramRead === 0) out.ramGB = null;
  return out;
}
