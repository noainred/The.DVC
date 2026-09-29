/**
 * 호스트 한 대의 GPU 사용 요약(v2.650 — 사용자 요청 "GPU 있는 서버는 GPU 사용율, GPU 온도, GPU 메모리 할당/사용율 붙여줘").
 * 순수 함수 — 호스트 상세(/tools/gpu/host)와 GPU 모니터링 호스트 표(buildGpuInventory)가 **같은 판정**을 쓴다.
 *
 * 값마다 출처가 다르고 화면이 그 사실을 말한다(섞지 않는다):
 *   · 사용률      ESXi 성능 카운터 gpu.utilization(vGPU/vSGA 호스트) → 없으면 게스트 nvidia-smi 평균(패스스루)
 *   · 온도        게스트 nvidia-smi temperature.gpu — **ESXi 경로에는 없다**. 게스트 수집 VM 이 없으면 null
 *   · 메모리 용량  vGPU/vSGA 는 vCenter 가 준 값(memorySizeInKB), 패스스루는 **모델명으로 추정**(capacityEstimated)
 *   · 메모리 할당  vGPU 는 프로파일 GB × 장치 수(켜진 VM 만 — 꺼진 VM 은 프레임버퍼를 잡지 않는다),
 *                 패스스루는 GPU 한 장 통째라 '장' 으로 센다
 *   · 메모리 사용  게스트 nvidia-smi memory.used 합(켜진 VM 중 수집된 것만) — 못 읽은 VM 수를 함께 싣는다
 */
import { numOrNull } from '../util/numOrNull.js';
import { gpuActivity, activityCounts } from './activity.js';
import { vmVgpuAllocGB, vmGpuDevices } from './vgpuProfile.js';

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * @param {object} host 스냅샷 호스트(gpus 포함)
 * @param {object[]} vms 이 호스트의 GPU 할당 VM(스냅샷 원소)
 * @param {Map<string,object>} guestByVm 게스트 수집 오버레이(vmId → store 레코드)
 */
export function summarizeHostGpu(host, vms, guestByVm, { now = Date.now() } = {}) {
  const gpus = (host && host.gpus) || [];
  const capKnown = gpus.every((g) => numOrNull(g.memGB) > 0);
  const capacityGB = gpus.length && capKnown ? gpus.reduce((a, g) => a + Number(g.memGB), 0) : null;
  const capacityEstimated = gpus.some((g) => g.mode === 'passthrough');
  const rows = [];
  let allocGB = 0; let allocKnown = 0; let allocUnknown = 0; let passthroughOn = 0;
  let memUsed = 0; let memTotal = 0; let memVms = 0;
  const utils = []; const temps = []; const acts = [];
  let vmsOn = 0; let vmsRead = 0;
  for (const v of vms || []) {
    const on = v.powerState === 'POWERED_ON';
    const g = on ? (guestByVm && guestByVm.get(v.id)) || null : null;
    const alloc = vmVgpuAllocGB(v.gpu);
    if (on) {
      vmsOn++;
      const dev = vmGpuDevices(v.gpu);
      if (dev.vgpu > 0) { if (alloc == null) allocUnknown++; else { allocGB += alloc; allocKnown++; } }
      passthroughOn += dev.passthrough;
    }
    const act = on ? gpuActivity(g) : { state: 'off', reason: null, tempRead: false };
    if (on) acts.push(act.state);
    if (g) {
      vmsRead++;
      if (g.utilPct != null) utils.push(g.utilPct);
      if (numOrNull(g.tempC) != null) temps.push(Number(g.tempC));
      if (numOrNull(g.memUsedMB) != null && numOrNull(g.memTotalMB) > 0) { memUsed += Number(g.memUsedMB); memTotal += Number(g.memTotalMB); memVms++; }
    }
    rows.push({
      id: v.id, name: v.name, powerState: v.powerState,
      mode: v.gpu?.type || null, profile: v.gpu?.profile || '', devices: v.gpu?.count ?? null,
      allocGB: alloc,
      utilPct: g ? g.utilPct ?? null : null, utilNA: g ? !!g.utilNA : false,
      memUsedMB: g ? numOrNull(g.memUsedMB) : null, memTotalMB: g ? numOrNull(g.memTotalMB) : null,
      memUsedPct: g ? numOrNull(g.memUsedPct) : null,
      tempC: g ? numOrNull(g.tempC) : null,
      gpusSeen: g ? numOrNull(g.gpus) : null,
      activity: act.state, activityReason: act.reason,
      ageMs: g && g.at ? Math.max(0, now - g.at) : null,
    });
  }
  const esxi = numOrNull(host?.gpuUtilPct);
  const guestAvg = utils.length ? Math.round(utils.reduce((a, b) => a + b, 0) / utils.length) : null;
  return {
    gpus: gpus.length,
    models: [...new Set(gpus.map((g) => g.model).filter(Boolean))],
    capacityGB, capacityEstimated,
    utilPct: esxi ?? guestAvg,
    utilSource: esxi != null ? 'esxi' : guestAvg != null ? 'guest' : null,
    tempC: temps.length ? Math.max(...temps) : null,
    // 할당 — vGPU 는 GB, 패스스루는 장(한 장 통째)
    allocGB: allocKnown ? round1(allocGB) : null,
    allocUnknown,
    allocPct: allocKnown && capacityGB ? Math.round((allocGB / capacityGB) * 100) : null,
    passthroughOn,
    // 사용 — 게스트 수집분만
    memUsedMB: memVms ? memUsed : null,
    memTotalMB: memVms ? memTotal : null,
    memUsedPct: memVms && memTotal ? Math.round((memUsed / memTotal) * 100) : null,
    memVms,
    vmsOn, vmsRead, vmsUnread: vmsOn - vmsRead,
    activity: activityCounts(acts),
    vms: rows,
  };
}
