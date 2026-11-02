/**
 * gpu/allocTree.js — GPU 할당 계층(v2.852 — 승인 시안 https://claude.ai/artifact/GQKnG775UijSAU7aUSFFeB '계층 표' ·
 *   사용자 요청 "법인의 vcenter - 데이터센터 - 클러스터 - 가상화 호스트에 어떤 GPU 가 설치되어 있고, 그 호스트의 어떤 VM 에
 *   얼만큼의 vGPU/GPU 가 할당되어 있고 할당량/예비량이 얼마다는 표" + "결과를 excel 로").
 *
 * 순수 함수 — 스냅샷(vcenters·hosts·vms)만 읽는다(왕복 0). 계층: 법인(vCenter) › 데이터센터 › 클러스터 › 호스트 › 물리 GPU › VM.
 *
 * 판정(값마다 근거가 다르다 — 섞지 않는다):
 *   · GPU 용량   vGPU/vSGA = max(vCenter 보고값, 모델 명목값)(hostGpu.js allocCapacityGB 와 같은 규칙 — 프로파일 GB 가 명목 단위다) ·
 *                패스스루 = 모델명 추정(estimated). 둘 다 모르면 null(용량 모름 — 따로 센다).
 *   · 할당       **켜진 VM** 만(꺼진 VM 은 프레임버퍼를 잡지 않는다 — 'off' 로 따로 적고 켜면 필요한 GB 를 offGB 로).
 *                vGPU = 프로파일 이름 끝 숫자(GB) × 장치 수(vgpuProfile.js) · 패스스루 = 받은 GPU 의 용량(한 장 통째).
 *                프로파일을 해석하지 못하면 0 이 아니라 null — allocUnknown 으로 센다.
 *   · 예비       용량 − 할당. 용량이나 할당 중 하나라도 모르는 것이 섞이면 **null**(부분 합을 예비로 보이지 않는다).
 *   · GPU 별 배치 vGPU = 호스트 graphicsInfo 의 GPU 별 VM 목록(gpus[].vms — v2.852 수집기), 패스스루 = GPU pciId ↔ VM gpu.pciIds.
 *                그 정보가 없는 GPU(구버전 수집기·엣지)는 placement:false — GPU 단위 할당·예비를 null 로 두고 VM 은 호스트의
 *                '배치 정보 없음' 묶음에 둔다(GPU 에 지어내 배치하지 않는다).
 *   · 슬롯       한 GPU 의 vGPU 가 모두 같은 프로파일일 때만(같은 GPU 에는 같은 프로파일만 올라간다 — NVIDIA 일반 규칙,
 *                혼합 크기 모드는 예외라 섞이면 슬롯을 계산하지 않는다).
 *   · vSGA GPU  할당형이 아니라 행으로만 보이고 합계(용량·할당·예비)에 넣지 않는다.
 */
import { numOrNull } from '../util/numOrNull.js';
import { vgpuProfileGB, vmGpuDevices } from './vgpuProfile.js';
import { inferGpuMemGB } from './gpuModelMem.js';

const ON = 'POWERED_ON';
const r1 = (n) => Math.round(n * 10) / 10;
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
export const NO_DC = '';            // 데이터센터를 모름(구버전 스냅샷) — 화면이 '(데이터센터 모름)' 으로 적는다
export const ALLOC_TREE_HOSTS_MAX = 5000;

/** GPU 모드 — 수집기 mode 가 없으면 vgpuMode 로(구버전 스냅샷). */
export function gpuModeOf(g) {
  if (!g) return null;
  if (g.mode === 'vgpu' || g.mode === 'passthrough' || g.mode === 'vsga') return g.mode;
  return g.vgpuMode ? 'vgpu' : 'passthrough';
}

/** GPU 한 장의 용량(GB)과 근거. @returns {{ gb: number|null, basis: 'reported'|'nominal'|'model'|null }} */
export function gpuCapacityOf(g) {
  const mode = gpuModeOf(g);
  const rep = numOrNull(g?.memGB);
  const nom = inferGpuMemGB(g?.model) || null;
  if (mode === 'passthrough') {
    if (nom != null) return { gb: nom, basis: 'model' };
    return rep != null && rep > 0 ? { gb: rep, basis: 'model' } : { gb: null, basis: null };
  }
  if (rep == null || rep <= 0) return nom != null ? { gb: nom, basis: 'nominal' } : { gb: null, basis: null };
  return nom != null && nom > rep ? { gb: nom, basis: 'nominal' } : { gb: rep, basis: 'reported' };
}

/** VM 한 대가 받은(받을) vGPU GB — 프로파일 GB × vGPU 장치 수. vGPU 가 없으면 0, 해석 못 하면 null. */
function vgpuGBOf(gpu) {
  const { vgpu } = vmGpuDevices(gpu);
  if (!(vgpu > 0)) return 0;
  const per = vgpuProfileGB(gpu?.profile);
  return per == null ? null : per * vgpu;
}

export function zeroTotals() {
  return { hosts: 0, gpus: 0, vsga: 0, capGB: 0, capUnknown: 0, allocGB: 0, allocUnknown: 0, offGB: 0, offUnknown: 0,
    vmsOn: 0, vmsOff: 0, unplaced: 0, freeGpus: 0, noPlacement: 0 };
}
function addTotals(a, b) {
  for (const k of Object.keys(a)) a[k] += b[k] || 0;
  return a;
}
/** 합계에 예비·할당률을 붙인다 — 모르는 것이 섞이면 null(부분 합을 예비로 보이지 않는다). */
export function finishTotals(t) {
  const known = t.capUnknown === 0 && t.allocUnknown === 0;
  return {
    ...t,
    capGB: r1(t.capGB), allocGB: r1(t.allocGB), offGB: r1(t.offGB),
    spareGB: known ? r1(t.capGB - t.allocGB) : null,
    allocPct: known && t.capGB > 0 ? Math.round((t.allocGB / t.capGB) * 100) : null,
  };
}

function vmRowOf(v, gb, extra = {}) {
  const dev = vmGpuDevices(v.gpu);
  return {
    id: str(v.id), name: str(v.name), powerState: str(v.powerState),
    mode: str(v.gpu?.type) || (dev.vgpu ? 'vgpu' : 'passthrough'),
    profile: str(v.gpu?.profile), vgpuDevices: dev.vgpu, passthroughDevices: dev.passthrough,
    gb: gb == null ? null : r1(gb),
    ...extra,
  };
}

/**
 * 호스트 한 대 → GPU 행·VM 배치·합계.
 * @param {object} h 스냅샷 호스트
 * @param {object[]} vms 이 호스트의 GPU VM(템플릿 제외)
 */
export function buildHostAlloc(h, vms) {
  const vcId = str(h.vcenterId);
  const gpus = (Array.isArray(h.gpus) ? h.gpus : []).filter((g) => g && typeof g === 'object').map((g, idx) => {
    const mode = gpuModeOf(g);
    const cap = gpuCapacityOf(g);
    const vmIds = mode === 'vgpu' && Array.isArray(g.vms) ? g.vms.filter((r) => typeof r === 'string' && r).map((r) => `${vcId}:${r}`) : null;
    const pciId = mode === 'passthrough' && typeof g.pciId === 'string' && g.pciId ? g.pciId : null;
    return { idx, model: str(g.model), mode, capGB: cap.gb, capBasis: cap.basis, pciId,
      placement: mode === 'vgpu' ? vmIds != null : mode === 'passthrough' ? pciId != null : false,
      _vmIds: vmIds, vms: [] };
  });
  const byId = new Map(vms.map((v) => [str(v.id), v]));
  const placed = new Set();
  const t = zeroTotals();
  t.hosts = 1;
  // ① GPU 별 배치 — 켜진 VM 만(꺼진 VM 은 GPU 에 올라가 있지 않다)
  for (const g of gpus) {
    if (g.mode === 'vgpu' && g._vmIds) {
      for (const id of g._vmIds) {
        const v = byId.get(id);
        if (!v || v.powerState !== ON || placed.has(`${id}|${g.idx}`)) continue;
        const per = vgpuProfileGB(v.gpu?.profile);
        g.vms.push(vmRowOf(v, per));   // 이 GPU 위의 장치 하나 = 프로파일 GB 하나
        placed.add(`${id}|${g.idx}`); placed.add(id);
      }
    } else if (g.mode === 'passthrough' && g.pciId) {
      for (const v of vms) {
        if (v.powerState !== ON || !Array.isArray(v.gpu?.pciIds) || !v.gpu.pciIds.includes(g.pciId)) continue;
        g.vms.push(vmRowOf(v, g.capGB, { gbEstimated: true }));
        placed.add(str(v.id));
      }
    }
  }
  // ② GPU 행 마무리 — 할당·예비·슬롯
  for (const g of gpus) {
    delete g._vmIds;
    if (g.mode === 'vsga') { t.vsga += 1; g.allocGB = null; g.spareGB = null; g.slots = null; continue; }
    t.gpus += 1;
    if (g.capGB == null) t.capUnknown += 1; else t.capGB += g.capGB;
    if (!g.placement) { g.allocGB = null; g.spareGB = null; g.slots = null; t.noPlacement += 1; continue; }
    if (g.mode === 'passthrough') {
      const used = g.vms.length > 0;
      g.allocGB = used ? g.capGB : 0;
      g.spareGB = g.capGB == null ? null : used ? 0 : g.capGB;
      g.slots = { total: 1, used: used ? 1 : 0, free: used ? 0 : 1, profile: null };
    } else {
      const unknown = g.vms.filter((x) => x.gb == null).length;
      const alloc = g.vms.reduce((s, x) => s + (x.gb || 0), 0);
      g.allocGB = unknown ? null : r1(alloc);
      g.spareGB = unknown || g.capGB == null ? null : r1(g.capGB - alloc);
      const profiles = [...new Set(g.vms.map((x) => x.profile))];
      const per = profiles.length === 1 ? vgpuProfileGB(profiles[0]) : null;
      g.slots = profiles.length === 0 ? { total: null, used: 0, free: null, profile: null }
        : per && g.capGB != null ? { total: Math.floor(g.capGB / per), used: g.vms.length, free: Math.max(0, Math.floor(g.capGB / per) - g.vms.length), profile: profiles[0] }
          : { total: null, used: g.vms.length, free: null, profile: profiles.length === 1 ? profiles[0] : null, mixed: profiles.length > 1 };
    }
    if (g.vms.length === 0) t.freeGpus += 1;
  }
  // ③ 호스트 할당(GPU 배치와 무관 — VM 구성에서) · 배치 안 된 켜진 VM · 꺼진 VM
  const ptCaps = gpus.filter((g) => g.mode === 'passthrough').map((g) => g.capGB);
  const ptUniform = ptCaps.length && ptCaps.every((c) => c != null && c === ptCaps[0]) ? ptCaps[0] : null;
  const unplaced = []; const off = [];
  for (const v of vms) {
    const dev = vmGpuDevices(v.gpu);
    const vg = vgpuGBOf(v.gpu);
    let pt = 0;
    if (dev.passthrough > 0) {
      const matched = gpus.filter((g) => g.mode === 'passthrough' && g.pciId && Array.isArray(v.gpu?.pciIds) && v.gpu.pciIds.includes(g.pciId));
      pt = matched.length === dev.passthrough && matched.every((g) => g.capGB != null) ? matched.reduce((s, g) => s + g.capGB, 0)
        : ptUniform != null ? ptUniform * dev.passthrough : null;
    }
    const gb = vg == null || pt == null ? null : vg + pt;
    if (v.powerState === ON) {
      t.vmsOn += 1;
      if (gb == null) t.allocUnknown += 1; else t.allocGB += gb;
      if (!placed.has(str(v.id))) {
        const anyPlacement = gpus.some((g) => g.placement && (dev.vgpu ? g.mode === 'vgpu' : g.mode === 'passthrough'));
        unplaced.push(vmRowOf(v, gb, { reason: anyPlacement ? 'not-listed' : 'no-placement', gbEstimated: dev.passthrough > 0 }));
        t.unplaced += 1;
      }
    } else {
      t.vmsOff += 1;
      if (gb == null) t.offUnknown += 1; else t.offGB += gb;
      off.push(vmRowOf(v, gb, { gbEstimated: dev.passthrough > 0 }));
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  for (const g of gpus) g.vms.sort(byName);
  unplaced.sort(byName); off.sort(byName);
  return {
    id: str(h.id), name: str(h.name), cluster: str(h.cluster), vcDatacenter: str(h.vcDatacenter),
    connectionState: str(h.connectionState),
    models: [...new Set(gpus.map((g) => g.model).filter(Boolean))],
    gpus, unplaced, off, totals: finishTotals(t), _t: t,
  };
}

/**
 * 스냅샷 → 계층.
 * @param {object} snap store.get()
 * @param {{ allowed?: Set<string>|null, vcenterId?: string|null }} opt allowed = 사용자 조회 범위(null = 무제한) — 요청 필터보다 먼저.
 */
export function buildGpuAllocTree(snap, { allowed = null, vcenterId = null } = {}) {
  const inScope = (vc) => (!allowed || allowed.has(vc)) && (!vcenterId || vc === vcenterId);
  const gpuVmsByHost = new Map();
  for (const v of snap?.vms || []) {
    if (!v || !v.gpu || v.template || !v.host || !inScope(v.vcenterId)) continue;
    const k = `${v.vcenterId}\t${v.host}`;
    (gpuVmsByHost.get(k) || gpuVmsByHost.set(k, []).get(k)).push(v);
  }
  const vcMeta = new Map((snap?.vcenters || []).filter(Boolean).map((vc) => [str(vc.id), vc]));
  const vcs = new Map();
  let truncated = 0;
  let n = 0;
  for (const h of snap?.hosts || []) {
    if (!h || !inScope(h.vcenterId) || !Array.isArray(h.gpus) || !h.gpus.length) continue;
    if (n >= ALLOC_TREE_HOSTS_MAX) { truncated += 1; continue; }
    n += 1;
    const ha = buildHostAlloc(h, gpuVmsByHost.get(`${h.vcenterId}\t${h.name}`) || []);
    const vcId = str(h.vcenterId);
    if (!vcs.has(vcId)) {
      const m = vcMeta.get(vcId) || {};
      vcs.set(vcId, { id: vcId, name: str(m.name) || vcId, city: str(m.location?.city), country: str(m.location?.country),
        region: str(m.location?.region), dcs: new Map() });
    }
    const vc = vcs.get(vcId);
    const dcName = ha.vcDatacenter || NO_DC;
    if (!vc.dcs.has(dcName)) vc.dcs.set(dcName, { name: dcName, clusters: new Map() });
    const dc = vc.dcs.get(dcName);
    const clKey = str(h.clusterRef) || `name:${ha.cluster}`;
    if (!dc.clusters.has(clKey)) dc.clusters.set(clKey, { key: clKey, name: ha.cluster || 'standalone', hosts: [] });
    dc.clusters.get(clKey).hosts.push(ha);
  }
  const all = zeroTotals();
  const byName = (a, b) => a.name.localeCompare(b.name);
  const vcenters = [...vcs.values()].map((vc) => {
    const vt = zeroTotals();
    const datacenters = [...vc.dcs.values()].map((dc) => {
      const dt = zeroTotals();
      const clusters = [...dc.clusters.values()].map((cl) => {
        const ct = zeroTotals();
        cl.hosts.sort(byName);
        for (const ha of cl.hosts) { addTotals(ct, ha._t); delete ha._t; }
        addTotals(dt, ct);
        return { key: cl.key, name: cl.name, totals: finishTotals(ct), hosts: cl.hosts };
      }).sort(byName);
      addTotals(vt, dt);
      return { name: dc.name, totals: finishTotals(dt), clusters };
    }).sort((a, b) => (a.name === NO_DC) - (b.name === NO_DC) || a.name.localeCompare(b.name));
    addTotals(all, vt);
    return { id: vc.id, name: vc.name, city: vc.city, country: vc.country, region: vc.region, totals: finishTotals(vt), datacenters };
  }).sort(byName);
  return { totals: finishTotals(all), vcenters, truncated };
}

/** 평면 행(CSV·엑셀 '평면 표') — GPU × VM 한 줄(VM 없는 GPU 도 한 줄) + 배치 안 된 켜진 VM + 꺼진 VM. */
export const FLAT_COLUMNS = Object.freeze([
  ['vcenter', '법인(vCenter)'], ['location', '위치'], ['datacenter', '데이터센터'], ['cluster', '클러스터'], ['host', '호스트'],
  ['gpuIdx', 'GPU#'], ['gpuModel', 'GPU 모델'], ['gpuMode', '방식'], ['gpuCapGB', 'GPU 용량(GB)'], ['gpuAllocGB', 'GPU 할당(GB)'], ['gpuSpareGB', 'GPU 예비(GB)'],
  ['slots', '슬롯(사용/전체)'], ['vm', 'VM'], ['power', '전원'], ['profile', '프로파일'], ['vmGB', 'VM 할당(GB)'], ['note', '비고'],
]);
export const MODE_TEXT = Object.freeze({ vgpu: 'vGPU', passthrough: '패스스루', vsga: 'vSGA', mixed: 'vGPU+패스스루' });
export const UNPLACED_TEXT = Object.freeze({
  'no-placement': 'GPU 배치 정보 없음(수집기 갱신 전)',
  'not-listed': '켜져 있으나 어느 GPU 목록에도 없음',
});
export const locationText = (vc) => [vc.city, vc.country].filter(Boolean).join(' · ');
export const dcText = (name) => (name === NO_DC ? '(데이터센터 모름)' : name);
/** 슬롯 글자 — CSV 를 엑셀로 열 때 '4/4' 가 날짜(4월 4일)로 바뀌지 않게 낱말을 붙인다. */
export function slotsText(s) {
  if (!s) return '';
  if (s.total != null) return `사용 ${s.used} / 전체 ${s.total}`;
  return s.used ? `사용 ${s.used} / 전체 ?` : '';
}
export function gpuNoteText(g) {
  if (g.mode === 'vsga') return 'vSGA — 할당형 아님(합계 제외)';
  if (!g.placement) return 'GPU 배치 정보 없음 — 할당·예비 모름';
  if (g.mode === 'passthrough') return g.vms.length ? '한 장 통째 할당' : '1장 예비 — VM 에 연결 가능';
  if (!g.vms.length) return '비어 있음 — 모든 프로파일 가능';
  if (g.allocGB == null) return '프로파일 해석 불가 VM 포함 — 할당·예비 모름';
  if (g.slots?.mixed) return '여러 프로파일(혼합 크기 모드) — 슬롯 계산 안 함';
  if (g.slots?.free > 0) return `같은 프로파일 ${g.slots.free}대 더 가능`;
  if (g.slots?.free === 0) return '슬롯 모두 사용';
  return '';
}
const numCell = (v) => (v == null ? '' : v);

export function flatRows(tree) {
  const out = [];
  for (const vc of tree.vcenters) for (const dc of vc.datacenters) for (const cl of dc.clusters) for (const h of cl.hosts) {
    const base = { vcenter: vc.name, location: locationText(vc), datacenter: dcText(dc.name), cluster: cl.name, host: h.name };
    for (const g of h.gpus) {
      const gb = { ...base, gpuIdx: g.idx, gpuModel: g.model, gpuMode: MODE_TEXT[g.mode] || g.mode || '', gpuCapGB: numCell(g.capGB),
        gpuAllocGB: numCell(g.allocGB), gpuSpareGB: numCell(g.spareGB), slots: slotsText(g.slots) };
      if (!g.vms.length) out.push({ ...gb, vm: '', power: '', profile: '', vmGB: '', note: gpuNoteText(g) });
      for (const v of g.vms) out.push({ ...gb, vm: v.name, power: '켜짐', profile: v.mode === 'passthrough' ? '패스스루 1장' : v.profile, vmGB: numCell(v.gb), note: v.gb == null ? '프로파일 해석 불가' : v.gbEstimated ? 'GB 는 모델명 추정' : '' });
    }
    const noGpu = { ...base, gpuIdx: '', gpuModel: '', gpuMode: '', gpuCapGB: '', gpuAllocGB: '', gpuSpareGB: '', slots: '' };
    for (const v of h.unplaced) out.push({ ...noGpu, vm: v.name, power: '켜짐', profile: v.profile || (v.passthroughDevices ? `패스스루 ${v.passthroughDevices}장` : ''), vmGB: numCell(v.gb), note: UNPLACED_TEXT[v.reason] || '' });
    for (const v of h.off) out.push({ ...noGpu, vm: v.name, power: '꺼짐', profile: v.profile || (v.passthroughDevices ? `패스스루 ${v.passthroughDevices}장` : ''), vmGB: numCell(v.gb), note: `꺼짐 — 할당에서 제외(켜면 ${v.gb == null ? '?' : v.gb} GB 필요)` });
  }
  return out;
}
