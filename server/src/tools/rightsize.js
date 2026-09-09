/**
 * tools/rightsize.js — VM 자원 축소 **근거 리포트** 판정(순수, v2.445).
 *
 * 사용자 요구: "CPU·메모리를 줄여도 되는 구체적인 근거를 볼 수 있게 — 설정한 주기마다 점검한
 * 사용률 추이가 이렇게 되니 이만큼 줄여도 된다. 차트·기간별·구체적 설명과 근거자료. 근거가
 * 충분해야 자원을 줄일 수 있다." + "메모리는 벌룬·스왑 같은 구체적 사용률도" + "VMware best
 * practice 와 참고한 공식 문서를 근거 자료로 제시".
 *
 * 왜 순수 모듈인가: 판정·문구가 사용자가 실제로 실행하는 감축 결정의 근거라서 네트워크 없이
 * 테스트로 고정해야 한다(CLAUDE.md '문구 로직은 순수 함수에'). 시계열은 라우트가 vCenter 에서
 * 가져와 넘긴다(vCenter 가 자체 보관하는 통계 롤업 — 우리가 5,850 VM 분을 따로 쌓지 않는다).
 *
 * 방법론(출처는 CITATIONS 참조):
 *  · 메모리: 워킹셋은 mem.active 로 추정하되, 감축 하한은 **consumed 의 p95** 와 **active 의 최대**
 *    중 큰 값 + 여유(headroom). active 만 보면 캐시로 잡힌 메모리를 빼앗아 성능이 떨어진다.
 *  · 벌룬(mem.vmmemctl)·스왑(mem.swapped)이 관측 창 안에서 0 을 넘긴 적이 있으면 그 호스트가
 *    이미 메모리를 회수 중이라는 뜻 → **감축 보류**(VMware 가이드: 호스트 스왑이 정규적으로
 *    일어나는 과할당은 피하라).
 *  · CPU: 실제 사용 MHz 의 p95 + 여유를 코어당 MHz 로 나눠 vCPU 를 산정. cpu.ready 가 높으면
 *    경합이 있다는 뜻이라 감축이 아니라 배치 문제 → 보류.
 *  · 권고 축소 폭은 현재 할당의 50% 를 넘지 않는다(Aria Operations 의 oversized 권고 상한과 동일).
 *  · 근거 게이트: 관측 일수·샘플 커버리지가 정책 하한 미만이면 **'근거 불충분'** 으로 끝낸다 —
 *    부족한 근거로 권고를 내지 않는다.
 */

/** 참고한 공식 문서 — 화면에 그대로 싣는다(사용자 요구). usedFor 는 어느 판정에 썼는지. */
export const CITATIONS = [
  {
    title: 'Performance Best Practices for VMware vSphere 8.0 (VMware/Broadcom)',
    url: 'https://www.vmware.com/docs/vsphere-esxi-vcenter-server-80-performance-best-practices',
    usedFor: '메모리는 애플리케이션 워킹셋을 담을 만큼 배정하고(Active 로 추정) 호스트 스왑이 정규적으로 일어나는 과할당은 피할 것 — 벌룬·스왑 관측 시 감축 보류 규칙의 근거',
  },
  {
    title: 'Understanding Memory Resource Management in VMware ESX (VMware 기술백서)',
    url: 'https://www.vmware.com/files/pdf/perf-vsphere-memory_management.pdf',
    usedFor: '벌룬(vmmemctl)·호스트 스왑·active/consumed 의 정의와 동작 — 각 메모리 계열의 해석',
  },
  {
    title: 'Rightsizing virtual machines on ESXi 8.0: vCPU, memory, and CPU topology guidance (Broadcom KB 438023)',
    url: 'https://knowledge.broadcom.com/external/article/438023/rightsizing-virtual-machines-on-esxi-80.html',
    usedFor: 'vCPU·메모리 적정화 일반 지침 — 과다 vCPU 는 스케줄링 오버헤드, 필요 이상 배정 금지',
  },
  {
    title: 'VMware Aria Operations — Using Rightsize to Adjust Resource Allocation (Broadcom TechDocs)',
    url: 'https://techdocs.broadcom.com/us/en/vmware-cis/aria/aria-operations/8-18/vmware-aria-operations-configuration-guide-8-18/optimizing-capacity-and-improving-performance/how-to-optimize-capacity-and-improve-performance/using-rightsize-to-adjust-resource-allocation.html',
    usedFor: '과대 VM 권고 축소 폭을 현재 할당의 50% 로 제한(예: 8 vCPU → 최대 4 감축) — 이 리포트의 감축 상한',
  },
  {
    title: 'How Does VMware Aria Operations Calculate and Forecast Capacity (Broadcom TechDocs)',
    url: 'https://techdocs.broadcom.com/us/en/vmware-cis/aria/aria-operations/8-18/vmware-aria-operations-configuration-guide-8-18/optimizing-capacity-and-improving-performance/capacity-optimization-concepts/how-does-vmware-aria-operations-calculate-and-forecast-capacity.html',
    usedFor: '권고 크기 = 관측 기간의 최대 예상 사용량 기준 — 평균이 아니라 피크(p95/최대) 로 산정하는 근거',
  },
  {
    title: 'vCenter Server 성능 통계 수집 간격·레벨 (vSphere Monitoring and Performance)',
    url: 'https://techdocs.broadcom.com/us/en/vmware-cis/vsphere/vsphere/8-0/vsphere-monitoring-and-performance-8-0.html',
    usedFor: '이 리포트의 데이터 출처 — vCenter 가 자체 보관하는 롤업(1일=5분·1주=30분·1달=2시간·1년=1일) 과 레벨 1 기본 카운터',
  },
];

/** 정책 기본값 — env 로 조정 가능(라우트에서 주입). 값의 근거는 CITATIONS 와 주석 참조. */
export const DEFAULT_POLICY = {
  headroomPct: 20,       // 피크 위 여유. 관행적 20~30% — 낮추면 공격적, 높이면 보수적
  minDays: 7,            // 이보다 짧은 관측으로는 권고하지 않는다(주간 패턴 1회는 봐야 함)
  minCoveragePct: 60,    // 기대 샘플 대비 실제 샘플 비율 하한(전원 OFF·수집 공백이 크면 근거 불충분)
  capReductionPct: 50,   // Aria Operations 과대 권고 상한(현재 할당의 50% 까지만 감축)
  readyWarnPct: 5,       // vCPU 당 %Ready 경고선(관행적 5%) — 넘으면 CPU 감축 보류
  memStepMB: 1024,       // 메모리 권고는 1GB 단위로 올림
};

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const r0 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x));

/** 유효 값만 뽑는다(null/-1 결측 제외). */
export function values(series) {
  return (series || []).map((p) => p?.v).filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0);
}

/** 백분위(선형 보간 없음 — 최근접 순위). p95 는 '상위 5% 를 제외한 최대' 로 읽는다. */
export function percentile(arr, p) {
  const a = [...arr].sort((x, y) => x - y);
  if (!a.length) return null;
  const idx = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1));
  return a[idx];
}

export function stats(series) {
  const v = values(series);
  if (!v.length) return { n: 0, avg: null, p95: null, max: null, min: null };
  const sum = v.reduce((a, b) => a + b, 0);
  return { n: v.length, avg: r1(sum / v.length), p95: r1(percentile(v, 95)), max: r1(Math.max(...v)), min: r1(Math.min(...v)) };
}

/** 관측 창 요약 — 얼마나 오래·얼마나 촘촘히 봤는가(근거 게이트의 입력). */
export function windowInfo(series, intervalSec, days, now = Date.now()) {
  const ts = (series || []).map((p) => Date.parse(p?.t)).filter((t) => Number.isFinite(t));
  const firstTs = ts.length ? Math.min(...ts) : null;
  const lastTs = ts.length ? Math.max(...ts) : null;
  const coverageDays = firstTs != null ? r1((lastTs - firstTs) / 86_400_000) : 0;
  const samples = values(series).length;
  const expected = Math.max(1, Math.floor((days * 86_400) / Math.max(1, intervalSec)));
  return { days, intervalSec, firstTs, lastTs, coverageDays, samples, expectedSamples: expected, coveragePct: r0(clamp((samples / expected) * 100, 0, 100)), now };
}

/**
 * 주 판정. 입력 series 의 각 계열은 [{t:ISO, v:number|null}].
 * @returns 리포트 객체(화면이 그대로 표시). 값이 없는 것은 null — 추정하지 않는다.
 */
export function analyzeRightsize({ vm = {}, hostMhzPerCore = null, intervalSec = 1800, days = 7, series = {}, missing = [], empty = [], noData = [], policy: pol = {}, now = Date.now() } = {}) {
  // 호출자가 env 미설정 키를 undefined 로 넘겨도 기본값을 덮지 않는다 — v2.445 개발 중 실제로
  // { headroomPct: undefined } 가 스프레드로 기본값을 지워 산식이 NaN(권고 null)이 됐다.
  const policy = { ...DEFAULT_POLICY };
  for (const [k, v] of Object.entries(pol || {})) if (v !== undefined && v !== null && Number.isFinite(Number(v))) policy[k] = Number(v);
  const S = (k) => series[k] || [];
  const vcpu = Number(vm.cpuCount) || 0;
  const memAllocMB = Number(vm.memMB) || 0;
  const mhz = Number(hostMhzPerCore) || 0;
  const cpuAllocMhz = vcpu > 0 && mhz > 0 ? vcpu * mhz : null;

  // 관측 창은 가장 기본 계열(cpuUsageMhz, 없으면 memActive)로 잡는다.
  const base = S('cpuUsageMhz').length ? S('cpuUsageMhz') : S('memActiveMB');
  const win = windowInfo(base, intervalSec, days, now);

  /* ── 근거 게이트 ─────────────────────────────────────────────── */
  const evidence = { sufficient: true, reasons: [] };
  if (vm.powerState && vm.powerState !== 'POWERED_ON') { evidence.sufficient = false; evidence.reasons.push('전원이 꺼진 VM 은 사용률 근거가 없습니다 — 켜진 상태에서 관측해야 합니다.'); }
  if (!base.length) { evidence.sufficient = false; evidence.reasons.push('vCenter 에서 이 기간의 성능 이력을 받지 못했습니다(통계 보관 기간 밖이거나 수집 레벨이 낮을 수 있음).'); }
  if (base.length && win.coverageDays < policy.minDays) { evidence.sufficient = false; evidence.reasons.push(`관측 기간 ${win.coverageDays}일 — 정책 하한 ${policy.minDays}일 미만입니다. 주간 패턴(주말·월말 배치 등)을 최소 한 번은 봐야 감축을 권고할 수 있습니다.`); }
  if (base.length && win.coveragePct < policy.minCoveragePct) { evidence.sufficient = false; evidence.reasons.push(`샘플 커버리지 ${win.coveragePct}%(${win.samples}/${win.expectedSamples}) — 정책 하한 ${policy.minCoveragePct}% 미만입니다. 수집 공백이 커서 피크를 놓쳤을 수 있습니다.`); }
  // 계열이 비는 이유를 셋으로 나눠 알린다(v2.449) — 화면에는 다 '—' 로 보이지만 대응이 다르다.
  // 이 구분이 없어 mem.active·mem.swapped 가 왜 비는지 알 수 없던 것이 v2.445~2.448 의 실제 문제였다.
  for (const m of missing || []) evidence.reasons.push(`카운터 없음: ${m} — 이 vCenter 의 카운터 카탈로그에 없습니다(버전 차이). 해당 판정은 생략합니다.`);
  for (const m of empty || []) evidence.reasons.push(`표본 없음: ${m} — 카운터는 있으나 vCenter 가 이 롤업(${intervalSec}초) 구간에서 계열을 돌려주지 않았습니다. 그 구간의 통계 레벨이 이 카운터를 수집하지 않을 가능성이 큽니다(vCenter › Configure › General › Statistics).`);
  for (const m of noData || []) evidence.reasons.push(`값 전부 결측: ${m} — 표본은 왔지만 모두 -1(값 없음)입니다. 이 기간에 VM 이 꺼져 있었거나 보관 기간이 지난 구간입니다.`);

  /* ── CPU ─────────────────────────────────────────────────────── */
  const cpuUsed = stats(S('cpuUsageMhz'));
  const cpuPct = stats(S('cpuUsagePct'));
  // %Ready(vCPU 당) = ready_ms / (interval_ms) / vCPU × 100 — 관측 간격 롤업이라 순간 피크는 더 높을 수 있다.
  const readyPctSeries = vcpu > 0 ? S('cpuReadyMs').map((p) => ({ t: p.t, v: p.v == null ? null : (p.v / (intervalSec * 1000) / vcpu) * 100 })) : [];
  const ready = stats(readyPctSeries);
  const cpu = {
    vcpu, mhzPerCore: mhz || null, allocMhz: cpuAllocMhz,
    used: cpuUsed, usagePct: cpuPct, readyPct: ready,
    recommendedVcpu: null, reductionVcpu: null, reductionPct: null, capped: false, blockers: [], ok: false,
    basisMhz: null,
  };
  if (evidence.sufficient && cpuAllocMhz && cpuUsed.p95 != null) {
    if (ready.p95 != null && ready.p95 > policy.readyWarnPct) {
      cpu.blockers.push(`CPU Ready p95 ${ready.p95}%/vCPU — 경고선 ${policy.readyWarnPct}% 초과. 이 VM 은 CPU 를 못 받아 기다리는 중이라(호스트 경합) 감축이 아니라 배치/호스트 여유를 먼저 봐야 합니다.`);
    }
    // 산정 근거 = p95 사용 MHz × (1+여유). 최대값이 p95 를 크게 넘으면(스파이크 워크로드) 최대값을 씁니다.
    const spiky = cpuUsed.max != null && cpuUsed.p95 != null && cpuUsed.max > cpuUsed.p95 * 1.5;
    const basis = (spiky ? cpuUsed.max : cpuUsed.p95) * (1 + policy.headroomPct / 100);
    cpu.basisMhz = r0(basis);
    cpu.basisNote = spiky ? '최대값이 p95 의 1.5배를 넘는 스파이크 워크로드라 최대값 기준으로 산정' : 'p95 기준으로 산정';
    let rec = Math.max(1, Math.ceil(basis / mhz));
    // Aria 상한: 현재의 50% 아래로는 권고하지 않는다.
    const floor = Math.max(1, Math.ceil(vcpu * (1 - policy.capReductionPct / 100)));
    if (rec < floor) { rec = floor; cpu.capped = true; }
    cpu.recommendedVcpu = Math.min(vcpu, rec);
    cpu.reductionVcpu = vcpu - cpu.recommendedVcpu;
    cpu.reductionPct = vcpu > 0 ? r0((cpu.reductionVcpu / vcpu) * 100) : null;
    cpu.ok = cpu.blockers.length === 0 && cpu.reductionVcpu > 0;
  } else if (evidence.sufficient && !cpuAllocMhz) {
    cpu.blockers.push('호스트 코어당 MHz 를 알 수 없어 vCPU 를 산정하지 않습니다(추정 금지).');
  }

  /* ── 메모리 ──────────────────────────────────────────────────── */
  const active = stats(S('memActiveMB'));
  const consumed = stats(S('memConsumedMB'));
  const balloonV = values(S('memBalloonMB'));
  const swapV = values(S('memSwappedMB'));
  const balloon = { ...stats(S('memBalloonMB')), samplesAbove0: balloonV.filter((v) => v > 0).length, pctTime: balloonV.length ? r0((balloonV.filter((v) => v > 0).length / balloonV.length) * 100) : null };
  const swapped = { ...stats(S('memSwappedMB')), samplesAbove0: swapV.filter((v) => v > 0).length, pctTime: swapV.length ? r0((swapV.filter((v) => v > 0).length / swapV.length) * 100) : null };
  const memPct = stats(S('memUsagePct'));
  const mem = {
    allocMB: memAllocMB, active, consumed, balloon, swapped, usagePct: memPct,
    recommendedMB: null, reductionMB: null, reductionPct: null, capped: false, blockers: [], ok: false,
    basisMB: null,
  };
  if (evidence.sufficient && memAllocMB > 0 && (consumed.p95 != null || active.max != null)) {
    if (balloon.samplesAbove0 > 0) mem.blockers.push(`벌룬 관측 — 최대 ${balloon.max} MB, 관측 시간의 ${balloon.pctTime}% 에서 0 초과. ESXi 가 이 VM 에서 메모리를 회수한 적이 있다는 뜻이라 호스트 압박이 있습니다. 감축 전에 호스트 메모리 여유부터 확인하세요.`);
    if (swapped.samplesAbove0 > 0) mem.blockers.push(`호스트 스왑 관측 — 최대 ${swapped.max} MB, 관측 시간의 ${swapped.pctTime}% 에서 0 초과. VMware 가이드가 피하라고 하는 상태입니다. 이 VM 은 감축 대상이 아니라 호스트 과할당 해소 대상입니다.`);
    // 하한 = max(consumed p95, active 최대) × (1+여유) — active 만 보면 캐시를 빼앗는다.
    const floorMB = Math.max(consumed.p95 ?? 0, active.max ?? 0);
    const basis = floorMB * (1 + policy.headroomPct / 100);
    mem.basisMB = r0(basis);
    mem.basisNote = `max(consumed p95 ${consumed.p95 ?? '—'} MB, active 최대 ${active.max ?? '—'} MB) × (1 + ${policy.headroomPct}%)`;
    let rec = Math.ceil(basis / policy.memStepMB) * policy.memStepMB;
    const floorAlloc = Math.ceil((memAllocMB * (1 - policy.capReductionPct / 100)) / policy.memStepMB) * policy.memStepMB;
    if (rec < floorAlloc) { rec = floorAlloc; mem.capped = true; }
    mem.recommendedMB = Math.min(memAllocMB, Math.max(policy.memStepMB, rec));
    mem.reductionMB = memAllocMB - mem.recommendedMB;
    mem.reductionPct = r0((mem.reductionMB / memAllocMB) * 100);
    mem.ok = mem.blockers.length === 0 && mem.reductionMB > 0;
  }

  /* ── 디스크(정직: 이력 없음) ─────────────────────────────────── */
  const disk = {
    storageGB: vm.storageGB ?? null, uncommittedGB: vm.uncommittedGB ?? null, thin: !!vm.thin, toolsStatus: vm.toolsStatus || '',
    note: '게스트 디스크 사용률 이력은 vCenter 기본 통계(레벨 1)에 없어 이 리포트는 현재 시점의 프로비저닝/커밋 용량만 보여줍니다. 파일시스템 사용률은 VMware Tools 의 guest.disk 로만 알 수 있으며 추이는 별도 수집이 필요합니다.',
  };

  /* ── 판정 ────────────────────────────────────────────────────── */
  let verdict;
  if (!evidence.sufficient) {
    verdict = { state: 'insufficient', title: '근거 불충분 — 감축을 권고하지 않습니다', summary: evidence.reasons[0] || '' };
  } else if (cpu.blockers.length || mem.blockers.length) {
    verdict = { state: 'hold', title: '감축 보류 — 압박·경합 신호가 관측됐습니다', summary: [...mem.blockers, ...cpu.blockers][0] };
  } else if (cpu.ok || mem.ok) {
    const parts = [];
    if (cpu.ok) parts.push(`vCPU ${vcpu} → ${cpu.recommendedVcpu} (−${cpu.reductionVcpu}, ${cpu.reductionPct}%)`);
    if (mem.ok) parts.push(`메모리 ${r1(memAllocMB / 1024)} GB → ${r1(mem.recommendedMB / 1024)} GB (−${r1(mem.reductionMB / 1024)} GB, ${mem.reductionPct}%)`);
    verdict = { state: 'reduce', title: '감축 가능 — 관측 근거가 정책 기준을 충족합니다', summary: parts.join(' · ') };
  } else {
    verdict = { state: 'keep', title: '현행 유지 — 감축 여지가 정책 상한 안에서 없습니다', summary: '피크 + 여유가 현재 할당에 근접합니다.' };
  }

  const methodology = [
    `관측 창: 최근 ${days}일, vCenter 롤업 간격 ${intervalSec}초(${intervalSec === 300 ? '1일 통계' : intervalSec === 1800 ? '1주 통계' : intervalSec === 7200 ? '1달 통계' : '1년 통계'}). 각 점은 그 간격의 평균이므로 순간 피크는 이보다 높을 수 있습니다.`,
    `CPU 권고 vCPU = ⌈(사용 MHz p95 × (1 + ${policy.headroomPct}%)) ÷ 코어당 MHz⌉. 최대값이 p95 의 1.5배를 넘는 스파이크형이면 최대값을 씁니다. CPU Ready p95 가 vCPU 당 ${policy.readyWarnPct}% 를 넘으면 경합으로 보고 보류합니다.`,
    `메모리 권고 = ⌈max(consumed p95, active 최대) × (1 + ${policy.headroomPct}%)⌉ (${policy.memStepMB} MB 단위). 벌룬·스왑이 관측 창에서 0 을 넘긴 적이 있으면 보류합니다.`,
    `감축 폭은 현재 할당의 ${policy.capReductionPct}% 를 넘지 않습니다(Aria Operations 과대 권고 상한). 관측 ${policy.minDays}일·커버리지 ${policy.minCoveragePct}% 미만이면 권고하지 않습니다.`,
  ];

  return { vm: { id: vm.id, name: vm.name, vcenterId: vm.vcenterId, host: vm.host, guestOS: vm.guestOS, powerState: vm.powerState }, window: win, policy, evidence, cpu, mem, disk, verdict, methodology, citations: CITATIONS, readyPctSeries };
}
