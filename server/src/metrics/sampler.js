/**
 * Metrics sampler — on an interval, snapshots host temperature and GPU
 * utilization (per host + per-cluster/per-vCenter averages) and datastore used
 * GB into the time-series DB. Enables 5-year history (온도/GPU) and capacity forecast.
 * Failures are isolated; sampling never blocks the event loop meaningfully.
 */

import { config } from '../config.js';
import { withJob } from '../perf/monitor.js'; // v2.498: 스톨 발생 시 '진행 중 작업' 표시(계측 전용)
import { store } from './../store.js';
import { getMetricsDb } from './db.js';
import { loadMetricsSettings } from './settings.js';
import { getGuestGpuHost } from '../gpu/store.js';
import { updateVmStats } from '../reports/vmStats.js';
import { memSampleRows, maybeLogMem } from '../system/memtrack.js';
import { insertVmperf, pruneVmperf } from './vmperfDb.js';
import { loadVmperfSettings, vmperfTracks } from './vmperfSettings.js';
import { roomTempRows } from '../idrac/roomTempSeries.js';
import { serverTempRows } from '../idrac/serverTempSeries.js';   // v2.504: 서버별 온도 추이(아래 주석)

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
    return await withJob('metrics.sample', sampleOnceInner);
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
export function vmAllocRows(snap, settings) {
  // `${vcenterId}|${host.name}` -> 코어당 MHz. 이름 단독 키는 vCenter 간 동명 호스트가
  // 덮어써 다른 사이트 MHz 로 환산되는 오염이 생긴다(v2.388 수정).
  const hostMhz = new Map();
  for (const h of snap.hosts || []) {
    const cores = Number(h.cpuCores) || 0;
    const total = Number(h.cpuTotalMhz) || 0;
    if (cores > 0 && total > 0) hostMhz.set(`${h.vcenterId}|${h.name}`, total / cores);
  }
  // vcenterId -> 누적
  const agg = new Map();
  const bucket = (id) => {
    let e = agg.get(id);
    if (!e) { e = { cpuUsed: 0, cpuAlloc: 0, memUsed: 0, memAlloc: 0, dsUsed: 0, dsCap: 0, diskProv: 0, diskUsed: 0, diskOff: 0, snapGB: 0 }; agg.set(id, e); }
    return e;
  };
  for (const v of snap.vms || []) {
    if (v.template) continue;
    // 디스크 트렌드(v2.446) — 용량 리포트 › 디스크 트렌드의 '할당(프로비저닝)/커밋/정지 VM/스냅샷' 계열.
    // 전원 OFF VM 도 스토리지는 점유하므로 CPU/MEM 과 달리 **전원 무관하게** 집계한다.
    if (vmperfTracks(v.vcenterId, settings)) {
      const committed = Number(v.storageGB) || 0;
      const uncommitted = Number(v.uncommittedGB) || 0;
      const snapGB = Number(v.snapshotSizeGB) || 0;
      for (const id of (settings.trackTotal ? [v.vcenterId, ''] : [v.vcenterId])) {
        const e = bucket(id);
        e.diskProv += committed + uncommitted;
        e.diskUsed += committed;
        if (v.powerState !== 'POWERED_ON') e.diskOff += committed;
        e.snapGB += snapGB;
      }
    }
    if (v.powerState !== 'POWERED_ON') continue;
    const memMB = Number(v.memMB) || 0;
    const memPct = Number(v.memUsagePct) || 0;
    const vcpu = Number(v.cpuCount) || 0;
    const cpuPct = Number(v.cpuUsagePct) || 0;
    const mhzPerCore = hostMhz.get(`${v.vcenterId}|${v.host}`);
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
    // VM 디스크 집계(v2.446) — 할당이 0 이면(VM 없음) 행을 만들지 않는다(결측은 결측으로).
    // 정지/스냅샷은 0 이 실제값(없음)이므로 할당 행이 있을 때 함께 기록한다.
    if (e.diskProv > 0) {
      rows.push({ metric: 'vm_disk_prov_gb', k, v: Math.round(e.diskProv) });
      rows.push({ metric: 'vm_disk_used_gb', k, v: Math.round(e.diskUsed) });
      rows.push({ metric: 'vm_disk_off_gb', k, v: Math.round(e.diskOff) });
      rows.push({ metric: 'vm_snap_gb', k, v: Math.round(e.snapGB * 10) / 10 });
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
      // v2.583: `% 120 === 1` 은 **기동 첫 샘플에서 즉시 참**이었다(v2.453 규약 위반 — 보존일을 줄이고 재시작하면
      //   첫 틱이 그 차액을 한 번에 지운다). `(++t % N) === 0` 으로 쓴다.
      if (vmperfCfg.retentionDays > 0 && ((++_vmperfPruneTicks % 120) === 0)) {
        for (const vcId of vmperfByVc.keys()) {
          try { await pruneVmperf(vcId, vmperfCfg.retentionDays); } catch { /* per-DB 격리 */ }
        }
      }
    }
  } catch { /* 집계·설정 로드 실패가 샘플링을 막지 않게 */ }

  // 법인 전산실 온도(v2.384) — 흡기·배기·CPU 를 **법인 단위 집계**로만 적재한다.
  //
  // ⚠ 서버별 시계열은 만들지 않는다: 965 서버 × 3종 × 시간당 = 연 2,500만 행이 되고,
  //   iDRAC 센서는 원래 sensorStore(인메모리 24시간)에만 있었다. 법인 단위면 (법인 수 × 6)
  //   행/샘플로 유계다(법인 10곳이면 60행 — 온도/GPU 계열과 같은 규모).
  // 메트릭: roomtemp_{inlet|exhaust|cpu}_{avg|max} (키 = 법인 id, ''=전체)
  // 이 계열이 있어야 '흡기/배기/CPU 를 눌러 1일~1년 추이' 를 볼 수 있다(그 전에는 데이터 자체가
  // 없어 24시간을 넘는 기간을 그릴 방법이 없었다 — 화면이 수집 시작 시각을 함께 표기한다).
  try { rows.push(...roomTempRows()); } catch { /* 집계 실패가 샘플링을 막지 않게 */ }

  // 서버별 iDRAC 온도(v2.504, 사용자 요청 "idrac 에서 조사하는 온도를 차트로 보이게 해줘").
  //
  // 위 주석의 "서버별 시계열은 만들지 않는다 — 965 서버 × 3종 × 시간당 = 연 2,500만 행" 은
  // **3종을 모두 쓸 때**의 계산이었다. 그래서 기본은 **서버당 1계열**(idractemp_max — 그 서버의
  // 최고 온도)만 적재한다: 965 × 24 × 365 ≈ 연 845만 행으로, 이미 수용 중인 temp_host
  // (ESXi 655 호스트 ≈ 연 574만 행)와 같은 규모다. 흡기·배기·CPU 를 따로 보려면
  // IDRAC_TEMP_SERIES_DETAIL=true(연 3,380만 행 — 현장이 알고 켠다), 완전 비활성은
  // IDRAC_TEMP_SERIES=false. 이 계열이 있어야 **위임(엣지) 수집 서버**도 추이 차트를 갖는다
  // (엣지는 최신 스냅샷만 export 하므로 중앙에 이력이 0 이었다 — v2.493 이 '중앙 이력 없음' 으로
  // 정직하게 표기한 그 공백을 이 계열이 채운다).
  try { rows.push(...serverTempRows()); } catch { /* 집계 실패가 샘플링을 막지 않게 */ }

  // 포탈 자신의 프로세스 메모리(누수 추적) — 인벤토리 유무와 무관하게 항상 샘플하고,
  // 시간당 1줄 상태 로그(링 버퍼·journal)도 여기서 남긴다. 실패가 본 샘플링을 막지 않게 격리.
  try { rows.push(...memSampleRows()); maybeLogMem(ts); } catch { /* */ }

  if (rows.length) { try { db.insertMany(rows, ts); } catch (e) { console.warn('[metrics] insert 실패:', e.message); } }

  // VM 사용률 누적(인메모리) — 라이트사이징 리포트용. 행을 쌓지 않으므로(O(VM수) 메모리)
  // 5,850 VM 규모에서도 시계열 DB 폭증 없이 평균/피크를 관측한다.
  try { updateVmStats(snap, ts); } catch { /* 통계 실패가 샘플링을 막지 않게 */ }

  // Retention prune (runtime-configurable). 매 샘플마다 DELETE 스캔하면 비용이 크므로
  // 약 20샘플(기본 60s면 ~20분)에 1회만 실행한다 — store의 전력 적재 prune과 동일한 절감 패턴.
  const { retentionDays, rawRetentionDays } = loadMetricsSettings();
  // ⚠ `% 20 === 0` 이어야 한다(v2.453). `=== 1` 이면 **기동 후 첫 샘플**에서 곧바로 prune 이
  // 돌아, 보존기간을 줄인 직후 재시작한 포탈이 첫 1분 안에 대량 삭제를 시작한다 —
  // v2.451 에서 실제로 그렇게 멈췄다(34.3GB DB, accept 큐가 차서 웹 타임아웃).
  // 이제 삭제 자체도 청크로 양보하지만(metrics/db.js), 기동 직후를 피하는 것도 함께 유지한다.
  if (retentionDays > 0 && (++_pruneTicks % 20 === 0)) {
    try {
      // v2.451: 원본은 rawRetentionDays, 롤업은 retentionDays(기본 5년).
      // rawRetentionDays 가 0 이거나 retentionDays 보다 길면 예전처럼 같은 기준을 쓴다.
      const raw = rawRetentionDays > 0 ? Math.min(rawRetentionDays, retentionDays) : retentionDays;
      await db.prune(ts - raw * 86_400_000, ts - retentionDays * 86_400_000);
    } catch (e) {
      // 조용히 삼키면 디스크 부족(SQLITE_FULL)조차 흔적이 없다 — v2.451 장애 때 실제로 그랬다.
      console.warn(`[metrics] prune 실패: ${e.message}`);
    }
  }
  lastRun = { at: ts, rows: rows.length, hostsWithTemp: hostsWithTemp.length };
}

const round1 = (x) => (x == null ? null : Number(x.toFixed(1)));

export function metricsSamplerStatus() {
  const s = loadMetricsSettings();
  return { intervalMs: s.sampleIntervalMs, retentionDays: s.retentionDays, rawRetentionDays: s.rawRetentionDays, lastRun };
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
