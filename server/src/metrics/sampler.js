/**
 * Metrics sampler — on an interval, snapshots host temperature and GPU
 * utilization (per host + per-cluster/per-vCenter averages) and datastore used
 * GB into the time-series DB. Enables 5-year history (온도/GPU) and capacity forecast.
 * Failures are isolated; sampling never blocks the event loop meaningfully.
 */

import { config } from '../config.js';
import { store } from './../store.js';
import { getMetricsDb } from './db.js';
import { loadMetricsSettings } from './settings.js';
import { getGuestGpuHost } from '../gpu/store.js';
import { updateVmStats } from '../reports/vmStats.js';
import { memSampleRows, maybeLogMem } from '../system/memtrack.js';
import { insertVmperf, pruneVmperf } from './vmperfDb.js';
import { loadVmperfSettings, vmperfTracks } from './vmperfSettings.js';

let timer = null;
let lastRun = null;
let _pruneTicks = 0; // retention prune 주기 카운터(매 샘플 DELETE 스캔 방지)
let _vmperfPruneTicks = 0; // vmperf(vCenter별 DB) prune 카운터 — DB 개수만큼 DELETE 라 더 드물게
let sampling = false; // 재진입 방지

const avg = (arr) => (arr.length ? arr.reduce((a, x) => a + x, 0) / arr.length : null);

async function sampleOnce() {
  if (sampling) return; // 이전 샘플이 아직 진행 중이면 이번 틱 건너뜀
  sampling = true;
  try {
    return await sampleOnceInner();
  } finally {
    sampling = false;
  }
}

/**
 * VM 할당 vs 실사용 집계 행 생성(v2.374) — vCenter 별 + 전체('').
 * 할당 CPU clock 은 vCPU × 그 VM 이 올라간 호스트의 코어당 MHz 로 환산한다(VM 객체에 MHz
 * 원값이 없어 호스트를 조인). 호스트 코어 MHz 를 모르는 VM 은 **CPU 집계에서 제외**한다
 * (임의값 추정 금지 — /tools/waste 의 overAllocatedReport 와 같은 규칙). 메모리는 호스트
 * 정보 없이 계산 가능하므로 전원 On 전량을 집계한다. 전원 OFF/템플릿은 제외(사용률 0 이라 왜곡).
 */
function vmAllocRows(snap, settings) {
  const hostMhz = new Map(); // host.name -> 코어당 MHz
  for (const h of snap.hosts || []) {
    const cores = Number(h.cpuCores) || 0;
    const total = Number(h.cpuTotalMhz) || 0;
    if (cores > 0 && total > 0) hostMhz.set(h.name, total / cores);
  }
  // vcenterId -> 누적
  const agg = new Map();
  const bucket = (id) => {
    let e = agg.get(id);
    if (!e) { e = { cpuUsed: 0, cpuAlloc: 0, memUsed: 0, memAlloc: 0, dsUsed: 0, dsCap: 0 }; agg.set(id, e); }
    return e;
  };
  for (const v of snap.vms || []) {
    if (v.powerState !== 'POWERED_ON' || v.template) continue;
    const memMB = Number(v.memMB) || 0;
    const memPct = Number(v.memUsagePct) || 0;
    const vcpu = Number(v.cpuCount) || 0;
    const cpuPct = Number(v.cpuUsagePct) || 0;
    const mhzPerCore = hostMhz.get(v.host);
    // 설정(v2.376): 대상 vCenter 만 수집. vcenterIds 가 비어 있으면 전체가 대상이다.
    if (!vmperfTracks(v.vcenterId, settings)) continue;
    const targets = settings.trackTotal ? [v.vcenterId, ''] : [v.vcenterId];
    for (const id of targets) {                    // vCenter별 (+ 선택 시 전체 합계)
      const e = bucket(id);
      e.memAlloc += memMB;
      e.memUsed += memMB * (memPct / 100);
      if (mhzPerCore && vcpu > 0) {
        const alloc = vcpu * mhzPerCore;
        e.cpuAlloc += alloc;
        e.cpuUsed += alloc * (cpuPct / 100);
      }
    }
  }
  // 디스크(데이터스토어) vCenter 합계(v2.377) — Platform 추이 차트의 'disk 사용 vs 용량'.
  // ds_usedgb 는 데이터스토어 **개별 키**로만 쌓여 vCenter 단위 추이를 만들 수 없었다.
  // 여기서 vCenter(+전체) 합계를 별도 계열로 적재한다. 용량(capacity)이 CPU/MEM 의 '할당'에 대응.
  for (const d of snap.datastores || []) {
    if (!vmperfTracks(d.vcenterId, settings)) continue;
    const cap = Number(d.capacityGB) || 0;
    const used = Number(d.usedGB) || 0;
    if (cap <= 0) continue;                       // 용량 미상 데이터스토어는 집계 제외(추정 금지)
    for (const id of (settings.trackTotal ? [d.vcenterId, ''] : [d.vcenterId])) {
      const e = bucket(id);
      e.dsCap += cap; e.dsUsed += used;
    }
  }

  // v2.376: vCenter 별 독립 DB 로 적재하므로 **키별로 묶어서** 돌려준다(Map<vcenterId, rows[]>).
  const out = new Map();
  for (const [k, e] of agg) {
    const rows = [];
    // 값이 0 이면(해당 vCenter 에 전원 On VM 없음) 행을 만들지 않는다 — 빈 구간이 0 으로
    // 기록돼 '사용률 0%' 로 오해되는 것 방지(차트는 결측을 결측으로 보여야 한다).
    if (e.cpuAlloc > 0) {
      rows.push({ metric: 'vm_cpu_alloc_mhz', k, v: Math.round(e.cpuAlloc) });
      rows.push({ metric: 'vm_cpu_used_mhz', k, v: Math.round(e.cpuUsed) });
    }
    if (e.memAlloc > 0) {
      rows.push({ metric: 'vm_mem_alloc_mb', k, v: Math.round(e.memAlloc) });
      rows.push({ metric: 'vm_mem_used_mb', k, v: Math.round(e.memUsed) });
    }
    if (e.dsCap > 0) {
      rows.push({ metric: 'ds_cap_gb_vc', k, v: Math.round(e.dsCap) });
      rows.push({ metric: 'ds_used_gb_vc', k, v: Math.round(e.dsUsed) });
    }
    if (rows.length) out.set(k, rows);
  }
  return out;
}

async function sampleOnceInner() {
  const snap = store.get();
  const db = await getMetricsDb();
  const ts = Date.now();
  const rows = [];

  // Host temperature (only hosts that report a sensor reading).
  const hostsWithTemp = (snap.hosts || []).filter((h) => h.tempC != null);
  const byCluster = new Map();
  const byVc = new Map();
  for (const h of hostsWithTemp) {
    rows.push({ metric: 'temp_host', k: h.id, v: h.tempC });
    const ck = `${h.vcenterId}|${h.cluster || 'standalone'}`;
    (byCluster.get(ck) || byCluster.set(ck, []).get(ck)).push(h.tempC);
    (byVc.get(h.vcenterId) || byVc.set(h.vcenterId, []).get(h.vcenterId)).push(h.tempC);
  }
  for (const [k, arr] of byCluster) rows.push({ metric: 'temp_cluster', k, v: round1(avg(arr)) });
  for (const [k, arr] of byVc) rows.push({ metric: 'temp_vc', k, v: round1(avg(arr)) });

  // Datastore used GB (for capacity forecast).
  for (const d of snap.datastores || []) if (d.usedGB != null) rows.push({ metric: 'ds_usedgb', k: d.id, v: d.usedGB });

  // GPU utilization — ESXi 보고값 우선, 없으면 게스트 OS 수집 오버레이(패스쓰루).
  // per host + per-cluster/per-vCenter averages.
  const gpuByCluster = new Map();
  const gpuByVc = new Map();
  for (const h of snap.hosts || []) {
    const util = h.gpuUtilPct ?? (getGuestGpuHost(h.id)?.utilPct ?? null);
    if (util == null) continue;
    rows.push({ metric: 'gpu_util', k: h.id, v: util });
    const ck = `${h.vcenterId}|${h.cluster || 'standalone'}`;
    (gpuByCluster.get(ck) || gpuByCluster.set(ck, []).get(ck)).push(util);
    (gpuByVc.get(h.vcenterId) || gpuByVc.set(h.vcenterId, []).get(h.vcenterId)).push(util);
  }
  for (const [k, arr] of gpuByCluster) rows.push({ metric: 'gpu_cluster', k, v: round1(avg(arr)) });
  for (const [k, arr] of gpuByVc) rows.push({ metric: 'gpu_vc', k, v: round1(avg(arr)) });

  // VM 실사용 vs 할당 집계(v2.374) — '주기적 실사용 트렌드로 할당량을 조절'하기 위한 시계열.
  //
  // ⚠ VM 별 시계열은 만들지 않는다: 5,850 VM × 시간당 1행 = 연 5,100만 행으로 감당이 안 된다
  //   (vmStats.js 가 인메모리 누적을 택한 것과 같은 이유). 대신 **vCenter 단위 + 전체 합계**만
  //   적재해 행 수를 (vCenter 수 × 메트릭 수)로 유계화한다 — 28 vCenter 면 시간당 ~116행.
  //   VM 개별 트렌드는 rightsizing 리포트(vmStats 평균/피크)가 담당한다.
  // 저장 메트릭(키 = vCenter id, 전체는 '')
  //   vm_cpu_used_mhz / vm_cpu_alloc_mhz : 사용·할당 CPU clock 합계(MHz)
  //   vm_mem_used_mb  / vm_mem_alloc_mb  : 사용·할당 메모리 합계(MB)
  // 사용률(%)·절감 가능(%)은 이 4개에서 파생 계산한다(값을 중복 저장하지 않는다).
  // VM 할당/사용 집계는 **vCenter 별 독립 DB**(metrics/vmperfDb.js)에 적재한다(v2.376).
  // 공용 metrics.db 에 섞으면 제외/보존 변경 시 DELETE 로 행만 지워져 파일이 줄지 않는다 —
  // 파일이 분리돼 있으면 대상에서 빼는 순간 파일을 지워 용량을 즉시 회수할 수 있다.
  // 실패는 격리(한 vCenter 쓰기 오류가 다른 vCenter·본 샘플링을 막지 않게).
  try {
    const vmperfCfg = loadVmperfSettings();
    if (vmperfCfg.enabled) {
      // 이름 주의: 이 함수 위쪽 온도 집계에도 byVc 가 있어 혼동을 막으려 vmperfByVc 로 둔다.
      const vmperfByVc = vmAllocRows(snap, vmperfCfg);
      for (const [vcId, vcRows] of vmperfByVc) {
        try { await insertVmperf(vcId, vcRows, ts); } catch (e) { console.warn(`[vmperf] ${vcId || '(전체)'} insert 실패: ${e.message}`); }
      }
      // 보존기간 prune — DB 개수만큼 DELETE 가 돌므로 공용(20틱)보다 더 드물게(120틱 ≈ 2시간@1분).
      if (vmperfCfg.retentionDays > 0 && (++_vmperfPruneTicks % 120 === 1)) {
        for (const vcId of vmperfByVc.keys()) {
          try { await pruneVmperf(vcId, vmperfCfg.retentionDays); } catch { /* per-DB 격리 */ }
        }
      }
    }
  } catch { /* 집계·설정 로드 실패가 샘플링을 막지 않게 */ }

  // 포탈 자신의 프로세스 메모리(누수 추적) — 인벤토리 유무와 무관하게 항상 샘플하고,
  // 시간당 1줄 상태 로그(링 버퍼·journal)도 여기서 남긴다. 실패가 본 샘플링을 막지 않게 격리.
  try { rows.push(...memSampleRows()); maybeLogMem(ts); } catch { /* */ }

  if (rows.length) { try { db.insertMany(rows, ts); } catch (e) { console.warn('[metrics] insert 실패:', e.message); } }

  // VM 사용률 누적(인메모리) — 라이트사이징 리포트용. 행을 쌓지 않으므로(O(VM수) 메모리)
  // 5,850 VM 규모에서도 시계열 DB 폭증 없이 평균/피크를 관측한다.
  try { updateVmStats(snap, ts); } catch { /* 통계 실패가 샘플링을 막지 않게 */ }

  // Retention prune (runtime-configurable). 매 샘플마다 DELETE 스캔하면 비용이 크므로
  // 약 20샘플(기본 60s면 ~20분)에 1회만 실행한다 — store의 전력 적재 prune과 동일한 절감 패턴.
  const { retentionDays } = loadMetricsSettings();
  if (retentionDays > 0 && (++_pruneTicks % 20 === 1)) { try { db.prune(ts - retentionDays * 86_400_000); } catch { /* */ } }
  lastRun = { at: ts, rows: rows.length, hostsWithTemp: hostsWithTemp.length };
}

const round1 = (x) => (x == null ? null : Number(x.toFixed(1)));

export function metricsSamplerStatus() {
  const s = loadMetricsSettings();
  return { intervalMs: s.sampleIntervalMs, retentionDays: s.retentionDays, lastRun };
}

/** (Re)arm the periodic timer from the current effective settings. */
export function rescheduleMetricsSampler() {
  if (timer) clearInterval(timer);
  const { sampleIntervalMs } = loadMetricsSettings();
  timer = setInterval(() => sampleOnce().catch(() => {}), sampleIntervalMs);
  timer.unref?.();
  console.log(`[metrics] sampler rescheduled — every ${Math.round(sampleIntervalMs / 1000)}s`);
  return sampleIntervalMs;
}

export function startMetricsSampler() {
  const { sampleIntervalMs, retentionDays } = loadMetricsSettings();
  setTimeout(() => sampleOnce().catch((e) => console.error('[metrics] sample 실패:', e.message)), 12_000).unref?.();
  timer = setInterval(() => sampleOnce().catch(() => {}), sampleIntervalMs);
  timer.unref?.();
  console.log(`[metrics] sampler started (every ${Math.round(sampleIntervalMs / 1000)}s, retention ${retentionDays}d)`);
}
