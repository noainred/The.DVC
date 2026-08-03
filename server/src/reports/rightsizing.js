/**
 * VM 라이트사이징 추천 — 관측 평균/피크(vmStats 누적) 기반으로 과대할당 VM의 축소 사양을
 * 제안한다. 기존 /tools/insights의 순간값 분류와 달리, 누적 통계가 충분한 VM은 평균·피크로
 * 판정해 "마침 그 순간만 유휴"였던 오탐을 줄인다(통계 부족 시 순간값 폴백 + 표기).
 * 순수 함수 — statsFor(vmId)를 주입받아 테스트 가능.
 */

const r1 = (n) => Math.round((n || 0) * 10) / 10;

/**
 * 추천 vCPU: 피크 사용률 기준 60% 목표 여유. 추천 RAM: 피크 기준 75% 목표.
 * suggested < current 일 때만 축소 후보.
 */
export function suggestSize(vcpu, ramGB, cpuMaxPct, memMaxPct) {
  const sVcpu = Math.max(1, Math.ceil((vcpu * (cpuMaxPct / 100)) / 0.6));
  const sRam = Math.max(1, Math.ceil((ramGB * (memMaxPct / 100)) / 0.75));
  return { suggestedVcpu: Math.min(sVcpu, vcpu), suggestedRamGB: Math.min(sRam, ramGB) };
}

/**
 * vms: 스냅샷 VM 배열(전원 ON·비템플릿만 대상). statsFor: (id)=>{samples,cpuAvg,memAvg,cpuMax,memMax,sinceTs}|null
 * opts: { minSamples(기본 10), cpuIdlePct(5), oversizedCpuPct(20), minVcpu(2) }
 */
export function computeRightsizing(vms, statsFor, opts = {}) {
  const minSamples = Number(opts.minSamples) || 10;
  const cpuIdle = Number(opts.cpuIdlePct) || 5;
  const overCpu = Number(opts.oversizedCpuPct) || 20;
  const minVcpu = Number(opts.minVcpu) || 2;

  const idle = []; const oversized = []; const undersized = [];
  let observed = 0; let instantOnly = 0;

  for (const v of vms) {
    if (v.powerState !== 'POWERED_ON' || v.template) continue;
    const st = statsFor ? statsFor(v.id) : null;
    const hasStats = st && st.samples >= minSamples;
    if (hasStats) observed++; else instantOnly++;
    const cpuAvg = hasStats ? st.cpuAvg : (v.cpuUsagePct ?? null);
    const memAvg = hasStats ? st.memAvg : (v.memUsagePct ?? null);
    const cpuMax = hasStats ? st.cpuMax : (v.cpuUsagePct ?? 0);
    const memMax = hasStats ? st.memMax : (v.memUsagePct ?? 0);
    if (cpuAvg == null && memAvg == null) continue;
    const ramGB = Math.round((v.memMB || 0) / 1024);
    const base = {
      id: v.id, name: v.name, vcenterId: v.vcenterId, host: v.host || '', cluster: v.cluster || '',
      vcpu: v.cpuCount || 0, ramGB,
      cpuAvg: r1(cpuAvg), memAvg: r1(memAvg), cpuMax: r1(cpuMax), memMax: r1(memMax),
      samples: hasStats ? st.samples : 0, observedSinceTs: hasStats ? st.sinceTs : null,
    };
    // 유휴: 평균 CPU/메모리 모두 매우 낮음.
    if ((cpuAvg ?? 100) < cpuIdle && (memAvg ?? 100) < 20) {
      idle.push({ ...base, reclaimVcpu: base.vcpu, reclaimRamGB: ramGB });
      continue;
    }
    // 과대: vCPU가 minVcpu 이상이고 평균 CPU가 낮음 → 피크 기준 추천 사양 계산.
    if ((v.cpuCount || 0) >= minVcpu && (cpuAvg ?? 100) < overCpu) {
      const s = suggestSize(base.vcpu, ramGB, cpuMax, memMax);
      if (s.suggestedVcpu < base.vcpu || s.suggestedRamGB < ramGB) {
        oversized.push({
          ...base, ...s,
          reclaimVcpu: Math.max(0, base.vcpu - s.suggestedVcpu),
          reclaimRamGB: Math.max(0, ramGB - s.suggestedRamGB),
        });
        continue;
      }
    }
    // 과소: 평균이 이미 높음 → 증설 검토 대상.
    if ((cpuAvg ?? 0) > 85 || (memAvg ?? 0) > 90) undersized.push(base);
  }

  const sum = (arr, k) => arr.reduce((a, x) => a + (x[k] || 0), 0);
  idle.sort((a, b) => b.vcpu - a.vcpu);
  oversized.sort((a, b) => b.reclaimVcpu - a.reclaimVcpu);
  undersized.sort((a, b) => (b.cpuAvg || 0) - (a.cpuAvg || 0));
  return {
    config: { minSamples, cpuIdlePct: cpuIdle, oversizedCpuPct: overCpu },
    observedVms: observed, instantOnlyVms: instantOnly,
    idleCount: idle.length, oversizedCount: oversized.length, undersizedCount: undersized.length,
    reclaimableVcpu: sum(idle, 'reclaimVcpu') + sum(oversized, 'reclaimVcpu'),
    reclaimableRamGB: sum(idle, 'reclaimRamGB') + sum(oversized, 'reclaimRamGB'),
    idle: idle.slice(0, 300), oversized: oversized.slice(0, 300), undersized: undersized.slice(0, 300),
  };
}
