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
import { vgpuProfileGB, vmGpuDevices, gpuModeOf, gpuDevicesOnHost, isGpuVmOnHost } from './vgpuProfile.js';
import { inferGpuMemGB } from './gpuModelMem.js';

const ON = 'POWERED_ON';
const r1 = (n) => Math.round(n * 10) / 10;
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
export const NO_DC = '';            // 데이터센터를 모름(구버전 스냅샷) — 화면이 '(데이터센터 모름)' 으로 적는다
export const ALLOC_TREE_HOSTS_MAX = 5000;

// v2.937: gpuModeOf 는 vgpuProfile.js 로 옮겼다(GPU 인벤토리와 함께 쓰는 gpuDevicesOnHost 가 쓴다) — 예전 import 경로를 위해 다시 내보낸다.
export { gpuModeOf };

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
    vmsOn: 0, vmsOff: 0, unplaced: 0, freeGpus: 0, noPlacement: 0,
    // v2.868: 호스트 CPU·메모리(코어·GB 합, 사용률은 MHz·MB 합으로) · 켜진 GPU VM 의 vCPU·메모리 합. *Unknown = 그 값을 못 읽은 호스트·VM 수.
    hostCores: 0, hostMemGB: 0, hostResUnknown: 0, cpuMhzTotal: 0, cpuMhzUsed: 0, memMbTotal: 0, memMbUsed: 0, hostUseUnknown: 0,
    vmVcpu: 0, vmMemGB: 0, vmResUnknown: 0 };
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
    // v2.868: 코어·메모리 '합' 은 모르는 호스트가 섞이면 null(부분 합을 전체로 보이지 않는다 — 예비와 같은 규칙).
    //   사용률은 '비율' 이라 사용률을 읽은 호스트(끊긴 호스트 제외)만으로 MHz·MB 가중으로 내고, 못 읽은 호스트 수(hostUseUnknown)를 함께 싣는다 —
    //   화면·엑셀 비고가 'N대 제외' 를 말한다(한 대가 끊겼다고 법인 사용률 전체를 지우지 않는다). 읽은 호스트가 0 이면 null.
    hostCores: t.hostResUnknown ? null : t.hostCores,
    hostMemGB: t.hostResUnknown ? null : r1(t.hostMemGB),
    hostCpuPct: t.cpuMhzTotal > 0 ? Math.round((t.cpuMhzUsed / t.cpuMhzTotal) * 100) : null,
    hostMemPct: t.memMbTotal > 0 ? Math.round((t.memMbUsed / t.memMbTotal) * 100) : null,
    vmVcpu: t.vmResUnknown ? null : t.vmVcpu,
    vmMemGB: t.vmResUnknown ? null : r1(t.vmMemGB),
  };
}

const pos = (v) => { const n = numOrNull(v); return n != null && n > 0 ? n : null; };
const pctOrNull = (v) => { const n = numOrNull(v); return n != null && n >= 0 && n <= 1000 ? Math.round(n) : null; };
/** 끊긴 호스트 — store.usageReadable 과 같은 규칙(DISCONNECTED · NOT_RESPONDING). v2.870 감사 A1-01: 예전에는 DISCONNECTED 만(잠재 — SOAP 는 접어 보낸다). */
export const hostDown = (h) => h?.connectionState === 'DISCONNECTED' || h?.connectionState === 'NOT_RESPONDING';
/**
 * v2.868(사용자 요청 '호스트의 CPU/Memory 와 VM 의 CPU/Memory 도 포함'): 스냅샷 값만 읽는다(새 수집 없음).
 * 호스트: 코어 · 메모리 GB · 사용률(끊긴 호스트는 사용률 null — 수집기가 0 을 싣는다). VM: vCPU · 메모리 GB · 사용률(꺼진 VM 은 null — 0 이 아니라 모름).
 */
export function hostResOf(h) {
  const down = hostDown(h);
  const memMB = pos(h?.memTotalMB);
  return { cores: pos(h?.cpuCores), memGB: memMB == null ? null : r1(memMB / 1024),
    cpuPct: down ? null : pctOrNull(h?.cpuUsagePct), memPct: down ? null : pctOrNull(h?.memUsagePct) };
}
export function vmResOf(v) {
  const on = v?.powerState === ON;
  const memMB = pos(v?.memMB);
  return { vcpu: pos(v?.cpuCount), memGB: memMB == null ? null : r1(memMB / 1024),
    cpuPct: on ? pctOrNull(v?.cpuUsagePct) : null, memPct: on ? pctOrNull(v?.memUsagePct) : null };
}

function vmRowOf(v, gb, extra = {}, dev = vmGpuDevices(v.gpu)) {
  return {
    id: str(v.id), name: str(v.name), powerState: str(v.powerState),
    mode: str(v.gpu?.type) || (dev.vgpu ? 'vgpu' : 'passthrough'),
    profile: str(v.gpu?.profile), vgpuDevices: dev.vgpu, passthroughDevices: dev.passthrough,
    gb: gb == null ? null : r1(gb),
    res: vmResOf(v),
    ...extra,
  };
}

/**
 * 호스트 한 대 → GPU 행·VM 배치·합계.
 * @param {object} h 스냅샷 호스트
 * @param {object[]} vmsIn 이 호스트의 GPU VM(템플릿 제외 — GPU 아닌 패스스루만 가진 VM 은 여기서 뺀다)
 */
export function buildHostAlloc(h, vmsIn) {
  let vms = vmsIn;
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
  // v2.871(버그 점검) → v2.937: GPU 가 아닌 패스스루(NIC · HBA)를 가르는 판정은 vgpuProfile.gpuDevicesOnHost 하나다(GPU 인벤토리와 같은 함수).
  const pciKey = (x) => String(x).toLowerCase();
  const devs = new Map(vms.map((v) => [v, gpuDevicesOnHost(v.gpu, h.gpus)]));
  // GPU 장치가 하나도 없는 VM(패스스루가 전부 NIC 등)은 이 계층의 대상이 아니다 — 켜짐·꺼짐·미배치 어디에도 넣지 않는다.
  vms = vms.filter((v) => isGpuVmOnHost(devs.get(v)));
  // v2.937(개선 3): 한 VM 의 vGPU 장치 여럿이 같은 GPU 에 붙으면 graphicsInfo 목록에는 그 VM 이 한 번만 온다 — GPU 단위 할당이 한 장치분으로
  //   적게 잡혔다. VM 이 vGPU GPU 목록 **하나에만** 있으면 그 VM 의 vGPU 장치 수를 모두 그 GPU 에 둔다. 여러 목록에 있으면 목록마다 한 장치
  //   (장치 수가 목록 수보다 많으면 어느 GPU 에 더 붙었는지 몰라 예전처럼 한 장치씩 — 호스트 합계는 VM 구성에서 내므로 늘 정확하다).
  const listedOn = new Map();
  for (const g of gpus) if (g.mode === 'vgpu' && g._vmIds) for (const id of new Set(g._vmIds)) listedOn.set(id, (listedOn.get(id) || 0) + 1);
  const hasPci = (v, id) => Array.isArray(v.gpu?.pciIds) && v.gpu.pciIds.some((x) => pciKey(x) === pciKey(id));
  const byId = new Map(vms.map((v) => [str(v.id), v]));
  const placed = new Set();
  const t = zeroTotals();
  t.hosts = 1;
  // v2.868: 호스트 CPU·메모리
  const hr = hostResOf(h);
  if (hr.cores == null || hr.memGB == null) t.hostResUnknown += 1; else { t.hostCores += hr.cores; t.hostMemGB += hr.memGB; }
  const cpuT = pos(h?.cpuTotalMhz); const memT = pos(h?.memTotalMB);
  const cpuU = numOrNull(h?.cpuUsageMhz); const memU = numOrNull(h?.memUsageMB);
  if (hostDown(h) || cpuT == null || memT == null || cpuU == null || memU == null || cpuU < 0 || memU < 0) t.hostUseUnknown += 1;
  else { t.cpuMhzTotal += cpuT; t.cpuMhzUsed += cpuU; t.memMbTotal += memT; t.memMbUsed += memU; }
  // ① GPU 별 배치 — 켜진 VM 만(꺼진 VM 은 GPU 에 올라가 있지 않다)
  for (const g of gpus) {
    if (g.mode === 'vgpu' && g._vmIds) {
      for (const id of g._vmIds) {
        const v = byId.get(id);
        if (!v || v.powerState !== ON || placed.has(`${id}|${g.idx}`)) continue;
        const per = vgpuProfileGB(v.gpu?.profile);
        const d = devs.get(v);
        const n = listedOn.get(id) === 1 && d.vgpu > 1 ? d.vgpu : 1;   // 이 GPU 위의 장치 수(v2.937 — 위 설명)
        g.vms.push(vmRowOf(v, per == null ? null : per * n, { onGpu: n }, d));
        placed.add(`${id}|${g.idx}`); placed.add(id);
      }
    } else if (g.mode === 'passthrough' && g.pciId) {
      for (const v of vms) {
        if (v.powerState !== ON || !hasPci(v, g.pciId)) continue;
        g.vms.push(vmRowOf(v, g.capGB, { gbEstimated: true }, devs.get(v)));
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
      const usedDev = g.vms.reduce((s, x) => s + (x.onGpu || 1), 0);   // v2.937: 슬롯은 VM 수가 아니라 장치 수
      g.slots = profiles.length === 0 ? { total: null, used: 0, free: null, profile: null }
        : per && g.capGB != null ? { total: Math.floor(g.capGB / per), used: usedDev, free: Math.max(0, Math.floor(g.capGB / per) - usedDev), profile: profiles[0] }
          : { total: null, used: usedDev, free: null, profile: profiles.length === 1 ? profiles[0] : null, mixed: profiles.length > 1 };
    }
    if (g.vms.length === 0) t.freeGpus += 1;
  }
  // ③ 호스트 할당(GPU 배치와 무관 — VM 구성에서) · 배치 안 된 켜진 VM · 꺼진 VM
  const ptCaps = gpus.filter((g) => g.mode === 'passthrough').map((g) => g.capGB);
  const ptUniform = ptCaps.length && ptCaps.every((c) => c != null && c === ptCaps[0]) ? ptCaps[0] : null;
  const unplaced = []; const off = [];
  for (const v of vms) {
    const dev = devs.get(v);
    const vg = vgpuGBOf(v.gpu);
    let pt = 0;
    if (dev.passthrough > 0) {
      const matched = gpus.filter((g) => g.mode === 'passthrough' && g.pciId && hasPci(v, g.pciId));
      pt = matched.length === dev.passthrough && matched.every((g) => g.capGB != null) ? matched.reduce((s, g) => s + g.capGB, 0)
        : ptUniform != null ? ptUniform * dev.passthrough : null;
    }
    const gb = vg == null || pt == null ? null : vg + pt;
    if (v.powerState === ON) {
      t.vmsOn += 1;
      const vr = vmResOf(v);
      if (vr.vcpu == null || vr.memGB == null) t.vmResUnknown += 1; else { t.vmVcpu += vr.vcpu; t.vmMemGB += vr.memGB; }
      if (gb == null) t.allocUnknown += 1; else t.allocGB += gb;
      if (!placed.has(str(v.id))) {
        const anyPlacement = gpus.some((g) => g.placement && (dev.vgpu ? g.mode === 'vgpu' : g.mode === 'passthrough'));
        unplaced.push(vmRowOf(v, gb, { reason: anyPlacement ? 'not-listed' : 'no-placement', gbEstimated: dev.passthrough > 0 }, dev));
        t.unplaced += 1;
      }
    } else {
      t.vmsOff += 1;
      if (gb == null) t.offUnknown += 1; else t.offGB += gb;
      off.push(vmRowOf(v, gb, { gbEstimated: dev.passthrough > 0 }, dev));
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  for (const g of gpus) g.vms.sort(byName);
  unplaced.sort(byName); off.sort(byName);
  const totals = finishTotals(t);
  // v2.937(개선 5): 꺼진 VM 을 모두 켜면 예비보다 많이 필요한가 — 호스트 행에만(배치는 호스트 단위다). 모르는 값이 섞이면 판정하지 않는다.
  //   vGPU 는 같은 프로파일 슬롯 단위로만 들어가므로 GB 비교는 근사다(넘지 않아도 슬롯이 맞지 않으면 켜지지 않을 수 있다 — 비고가 말한다).
  totals.offOverGB = totals.spareGB != null && t.offUnknown === 0 && t.offGB > totals.spareGB ? r1(t.offGB - totals.spareGB) : null;
  return {
    id: str(h.id), name: str(h.name), cluster: str(h.cluster), vcDatacenter: str(h.vcDatacenter),
    connectionState: str(h.connectionState), res: hr,
    models: [...new Set(gpus.map((g) => g.model).filter(Boolean))],
    gpus, unplaced, off, totals, _t: t,
  };
}

/** 범위 판정 하나 — 계층(buildGpuAllocTree)과 법인 목록(allocCorpRoster)이 같은 것을 쓴다. 조회 범위(allowed)가 먼저다. */
function scopeTest({ allowed = null, vcenterId = null, vcenterIds = null } = {}) {
  // v2.853: vcenterIds = 화면 법인 칩에서 고른 법인들(빈 집합·null = 전체). 범위 밖 id 는 그냥 빠진다.
  const pick = vcenterIds && vcenterIds.size ? vcenterIds : null;
  return (vc) => (!allowed || allowed.has(vc)) && (!vcenterId || vc === vcenterId) && (!pick || pick.has(vc));
}

/**
 * 스냅샷 → 계층.
 * @param {object} snap store.get()
 * @param {{ allowed?: Set<string>|null, vcenterId?: string|null, vcenterIds?: Set<string>|null }} opt allowed = 사용자 조회 범위(null = 무제한) — 요청 필터보다 먼저.
 */
export function buildGpuAllocTree(snap, { allowed = null, vcenterId = null, vcenterIds = null } = {}) {
  const inScope = scopeTest({ allowed, vcenterId, vcenterIds });
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

/**
 * v2.871 감사 A4-02: 계층에 노드가 없는 법인이 'GPU 호스트 0대' 인지 '모름' 인지 — 인벤토리가 비어 있는 상태(store.js 가 인벤토리 없이
 *   status 만 남기는 경우: 재시작 직후 첫 수집 전 'pending' · 보존 창을 넘긴 장기 장애 'unreachable' · 수집 꺼짐 · 점검 중)면 모른다.
 *   stale(직전 인벤토리를 보존해 보이는 중)이면 인벤토리가 있으므로 노드가 없는 것은 실제 0대다. 계층이 상한으로 잘렸으면(truncated)
 *   노드가 없는 법인도 잘린 호스트의 법인일 수 있어 모른다. 웹 gpuAllocText.js corpUnknownOf 와 같은 판정(시험이 같은 입력으로 대조).
 * @returns {''|'pending'|'unreachable'|'disabled'|'maintenance'|'truncated'} '' = 아는 값(노드가 있거나 실제 0대)
 */
export const CORP_INV_EMPTY = Object.freeze(['pending', 'unreachable', 'disabled', 'maintenance']);
export function corpUnknownOf(meta, hasNode, truncated = 0) {
  if (hasNode) return '';
  const st = str(meta?.status);
  if (!meta?.stale && CORP_INV_EMPTY.includes(st)) return st;
  return truncated > 0 ? 'truncated' : '';
}
/** 목차·창 칩 글자(모름 사유) — 웹 gpuAllocText.js CORP_UNKNOWN_TEXT 와 같은 글자. */
export const CORP_UNKNOWN_TEXT = Object.freeze({
  pending: '수집 전', unreachable: '접속 불가', disabled: '수집 꺼짐', maintenance: '점검 중', truncated: '상한으로 잘림',
});

/**
 * v2.869: 범위 안 법인(vCenter) 전부 — GPU 호스트가 없는 법인도(엑셀 '목차' 시트 · 내보내기 창의 법인별 시트 안내).
 * 계층(tree)에 있는 법인은 그 노드(vc)를 붙이고, 없는 법인은 vc = null. id 순(화면 법인 칩과 같은 순서).
 * v2.871 A4-02: unknown = corpUnknownOf(노드가 없는 이유가 '모름' 이면 사유 — 0대로 적지 않는다).
 * @returns {{ id: string, name: string, city: string, country: string, vc: object|null, unknown: string }[]}
 */
export function allocCorpRoster(snap, opt = {}, tree = null) {
  const inScope = scopeTest(opt);
  const byId = new Map((tree?.vcenters || []).map((v) => [v.id, v]));
  const truncated = Number(tree?.truncated) || 0;
  const out = new Map();
  for (const m of snap?.vcenters || []) {
    if (!m) continue;
    const id = str(m.id);
    if (!id || out.has(id) || !inScope(id)) continue;
    const vc = byId.get(id) || null;
    out.set(id, { id, name: str(m.name) || id, city: str(m.location?.city), country: str(m.location?.country), vc, unknown: corpUnknownOf(m, !!vc, truncated) });
  }
  for (const v of byId.values()) if (!out.has(v.id) && inScope(v.id)) out.set(v.id, { id: v.id, name: v.name, city: v.city, country: v.country, vc: v, unknown: '' });
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 범위 글자(제목 · 창) · 파일 이름의 범위 부분. v2.871(버그 점검): 고른 법인은 '범위 안에서 고른 법인'(GPU 호스트 없는 법인 포함 —
 * allocCorpRoster 의 id)으로 센다. 예전에는 계층(GPU 호스트가 있는 법인)만 세어 GPU 없는 법인만 고르면 '조회 범위 안에 없음' 이라고
 * 거짓으로 적었고 3곳을 골라도 파일 이름이 2corps 였다. 많이 고르면 앞 3곳 + '외 N곳'(제목이 끝없이 길어지지 않게).
 * @param {{ vcenterId?: string|null, picked?: boolean, tree: object, rosterIds?: string[] }} o
 */
export function allocScopeOf({ vcenterId = null, picked = false, tree, rosterIds = [] }) {
  const list = (ids) => (ids.length <= 4 ? ids.join(', ') : `${ids.slice(0, 3).join(', ')} 외 ${ids.length - 3}곳`);
  const scopeText = vcenterId ? (tree?.vcenters?.[0]?.name || vcenterId)
    : picked ? (rosterIds.length ? `법인 ${rosterIds.length}곳 — ${list(rosterIds)}` : '고른 법인(조회 범위 안에 없음)') : '전체 법인';
  const fileScope = vcenterId || (picked ? (rosterIds.length === 1 ? rosterIds[0] : `${rosterIds.length}corps`) : 'all');
  return { scopeText, fileScope: String(fileScope).replace(/[^\w.-]+/g, '_').slice(0, 60) };
}

/** 평면 행(CSV·엑셀 '평면 표') — GPU × VM 한 줄(VM 없는 GPU 도 한 줄) + 배치 안 된 켜진 VM + 꺼진 VM. */
export const FLAT_COLUMNS = Object.freeze([
  ['vcenter', '법인(vCenter)'], ['location', '위치'], ['datacenter', '데이터센터'], ['cluster', '클러스터'], ['host', '호스트'],
  ['gpuIdx', 'GPU#'], ['gpuModel', 'GPU 모델'], ['gpuMode', '방식'], ['gpuCapGB', 'GPU 용량(GB)'], ['gpuAllocGB', 'GPU 할당(GB)'], ['gpuSpareGB', 'GPU 예비(GB)'],
  ['slots', '슬롯(사용/전체)'], ['vm', 'VM'], ['power', '전원'], ['profile', '프로파일'], ['vmGB', 'VM 할당(GB)'],
  // v2.868: 호스트·VM CPU/메모리
  ['hostCores', '호스트 코어'], ['hostCpuPct', '호스트 CPU(%)'], ['hostMemGB', '호스트 메모리(GB)'], ['hostMemPct', '호스트 메모리(%)'],
  ['vmVcpu', 'VM vCPU'], ['vmCpuPct', 'VM CPU(%)'], ['vmMemGB', 'VM 메모리(GB)'], ['vmMemPct', 'VM 메모리(%)'],
  ['note', '비고'],
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
/** GPU 한 장의 프로파일 · 슬롯 칸 — 웹 gpuAllocText.gpuTexts().prof 와 같은 말(v2.870 감사 A4-05: 엑셀이 배치 모르는 vGPU 를 '비어 있음' 으로 적었다). */
export function gpuProfText(g) {
  if (g.mode === 'vsga') return 'vSGA';
  if (!g.placement) return '배치 정보 없음';
  if (g.mode === 'passthrough') return g.vms.length ? '패스스루 · 1장 할당' : '패스스루 · 미할당';
  if (!g.vms.length) return '비어 있음';
  return g.slots?.profile ? `${g.slots.profile} · ${g.slots.used}/${g.slots.total ?? '?'} 슬롯` : '여러 프로파일';
}
/** GPU 한 장의 VM 칸 — 배치를 모르면 '—'(0 이 아니다 · v2.870 감사 A4-05) · vSGA 는 빈 칸. */
export const gpuVmsText = (g) => (g.mode === 'vsga' ? '' : !g.placement ? '—' : `${g.vms.length} / 0`);
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
    const hr = h.res || {};
    const base = { vcenter: vc.name, location: locationText(vc), datacenter: dcText(dc.name), cluster: cl.name, host: h.name,
      hostCores: numCell(hr.cores), hostCpuPct: numCell(hr.cpuPct), hostMemGB: numCell(hr.memGB), hostMemPct: numCell(hr.memPct) };
    const vres = (v) => { const r = v.res || {}; return { vmVcpu: numCell(r.vcpu), vmCpuPct: numCell(r.cpuPct), vmMemGB: numCell(r.memGB), vmMemPct: numCell(r.memPct) }; };
    const noVm = { vmVcpu: '', vmCpuPct: '', vmMemGB: '', vmMemPct: '' };
    for (const g of h.gpus) {
      const gb = { ...base, gpuIdx: g.idx, gpuModel: g.model, gpuMode: MODE_TEXT[g.mode] || g.mode || '', gpuCapGB: numCell(g.capGB),
        gpuAllocGB: numCell(g.allocGB), gpuSpareGB: numCell(g.spareGB), slots: slotsText(g.slots) };
      if (!g.vms.length) out.push({ ...gb, ...noVm, vm: '', power: '', profile: '', vmGB: '', note: gpuNoteText(g) });
      for (const v of g.vms) out.push({ ...gb, ...vres(v), vm: v.name, power: '켜짐', profile: v.mode === 'passthrough' ? '패스스루 1장' : v.profile, vmGB: numCell(v.gb), note: v.gb == null ? '프로파일 해석 불가' : v.gbEstimated ? 'GB 는 모델명 추정' : '' });
    }
    const noGpu = { ...base, gpuIdx: '', gpuModel: '', gpuMode: '', gpuCapGB: '', gpuAllocGB: '', gpuSpareGB: '', slots: '' };
    for (const v of h.unplaced) out.push({ ...noGpu, ...vres(v), vm: v.name, power: '켜짐', profile: v.profile || (v.passthroughDevices ? `패스스루 ${v.passthroughDevices}장` : ''), vmGB: numCell(v.gb), note: UNPLACED_TEXT[v.reason] || '' });
    for (const v of h.off) out.push({ ...noGpu, ...vres(v), vm: v.name, power: '꺼짐', profile: v.profile || (v.passthroughDevices ? `패스스루 ${v.passthroughDevices}장` : ''), vmGB: numCell(v.gb), note: `꺼짐 — 할당에서 제외(켜면 ${v.gb == null ? '?' : v.gb} GB 필요)` });
  }
  return out;
}

/**
 * v2.937(개선 2 — 실장비 확인 도구): 'GPU 할당율' 이 기대는 수집 가정을 **이미 수집한 스냅샷**으로 판정한다(vCenter 왕복 0 · 엣지 법인도 같다).
 *   ① 꺼진 VM 이 GPU 별 목록(HostGraphicsInfo.vm)에 오는가 — 배치 정보가 있는 vGPU GPU 의 목록에 꺼진 vGPU VM 이 보이는가
 *   ② 켜진 패스스루 VM 의 장치 주소(정적 id · 동적 assignedId)를 읽는가 — gpu.pciIds 가 장치 수만큼 있는가
 *   ③ vGPU 프로파일 이름을 GB 로 읽는가(vgpuProfileGB) — 못 읽은 이름과 VM 수
 *   그 밖: 배치 정보 없는 GPU(구버전 수집기) · 주소 없는 패스스루 GPU · GPU 아닌 패스스루(NIC · HBA)를 가진 VM · 용량 모름 · 모델명 추정 용량.
 * 판정은 관측만 말한다 — 관측할 대상이 없으면 '판단 불가' 다(없다고 단정하지 않는다).
 * @param {object} snap store.get()
 * @param {{ allowed?: Set<string>|null, vcenterId?: string|null, vcenterIds?: Set<string>|null }} opt 계층과 같은 범위(scopeTest)
 */
export function allocDiag(snap, opt = {}) {
  const inScope = scopeTest(opt);
  const vcName = new Map((snap?.vcenters || []).filter(Boolean).map((v) => [str(v.id), str(v.name) || str(v.id)]));
  const zero = () => ({ gpuHosts: 0, vgpuGpus: 0, vgpuNoPlacement: 0, ptGpus: 0, ptNoPci: 0, capUnknown: 0, capModel: 0,
    offVgpuVms: 0, offListed: 0, ptOnVms: 0, ptOnPciRead: 0, unparsedVms: 0, nonGpuPtVms: 0, nonGpuOnlyVms: 0 });
  const per = new Map();
  const unparsed = new Map();
  const hostsByKey = new Map();
  for (const h of snap?.hosts || []) {
    if (!h || !inScope(h.vcenterId) || !Array.isArray(h.gpus) || !h.gpus.length) continue;
    hostsByKey.set(`${h.vcenterId}\t${h.name}`, h);
    const id = str(h.vcenterId);
    const d = per.get(id) || per.set(id, zero()).get(id);
    d.gpuHosts += 1;
    for (const g of h.gpus) {
      if (!g || typeof g !== 'object') continue;
      const mode = gpuModeOf(g);
      if (mode === 'vgpu') { d.vgpuGpus += 1; if (!Array.isArray(g.vms)) d.vgpuNoPlacement += 1; }
      if (mode === 'passthrough') { d.ptGpus += 1; if (!(typeof g.pciId === 'string' && g.pciId)) d.ptNoPci += 1; }
      if (mode !== 'vsga') { const c = gpuCapacityOf(g); if (c.gb == null) d.capUnknown += 1; else if (c.basis === 'model') d.capModel += 1; }
    }
  }
  for (const v of snap?.vms || []) {
    if (!v || !v.gpu || v.template || !v.host || !inScope(v.vcenterId)) continue;
    const h = hostsByKey.get(`${v.vcenterId}\t${v.host}`);
    if (!h) continue;
    const d = per.get(str(v.vcenterId));
    const raw = vmGpuDevices(v.gpu);
    const dev = gpuDevicesOnHost(v.gpu, h.gpus);
    if (dev.other > 0) { d.nonGpuPtVms += 1; if (!isGpuVmOnHost(dev)) { d.nonGpuOnlyVms += 1; continue; } }
    const on = v.powerState === ON;
    const ref = str(v.id).startsWith(`${v.vcenterId}:`) ? str(v.id).slice(String(v.vcenterId).length + 1) : str(v.id);
    if (!on && dev.vgpu > 0) {
      const placedGpus = h.gpus.filter((g) => g && gpuModeOf(g) === 'vgpu' && Array.isArray(g.vms));
      if (placedGpus.length) { d.offVgpuVms += 1; if (placedGpus.some((g) => g.vms.includes(ref))) d.offListed += 1; }
    }
    if (on && raw.passthrough > 0) { d.ptOnVms += 1; if (Array.isArray(v.gpu.pciIds) && v.gpu.pciIds.length === raw.passthrough) d.ptOnPciRead += 1; }
    if (dev.vgpu > 0 && vgpuProfileGB(v.gpu.profile) == null) {
      d.unparsedVms += 1;
      const p = str(v.gpu.profile).slice(0, 80) || '(이름 없음)';
      unparsed.set(p, (unparsed.get(p) || 0) + 1);
    }
  }
  const vcenters = [...per.entries()].map(([id, d]) => ({ id, name: vcName.get(id) || id, ...d })).sort((a, b) => a.id.localeCompare(b.id));
  const t = zero();
  for (const v of vcenters) for (const k of Object.keys(t)) t[k] += v[k];
  const verdicts = {
    offListed: t.offListed > 0 ? 'yes' : t.offVgpuVms > 0 ? 'no' : 'unknown',
    ptPciRead: t.ptOnVms === 0 ? 'unknown' : t.ptOnPciRead === t.ptOnVms ? 'yes' : t.ptOnPciRead === 0 ? 'no' : 'partial',
    profiles: t.unparsedVms === 0 ? (t.vgpuGpus > 0 ? 'yes' : 'unknown') : 'partial',
    placement: t.vgpuGpus === 0 ? 'unknown' : t.vgpuNoPlacement === 0 ? 'yes' : t.vgpuNoPlacement === t.vgpuGpus ? 'no' : 'partial',
  };
  const unparsedProfiles = [...unparsed.entries()].map(([profile, vms]) => ({ profile, vms })).sort((a, b) => b.vms - a.vms || a.profile.localeCompare(b.profile)).slice(0, 50);
  return { vcenters, totals: t, verdicts, unparsedProfiles };
}
