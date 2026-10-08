/**
 * Metrics sampler — on an interval, snapshots host temperature and GPU
 * utilization (per host + per-cluster/per-vCenter averages) and datastore used
 * GB into the time-series DB. Enables 5-year history (온도/GPU) and capacity forecast.
 * Failures are isolated; sampling never blocks the event loop meaningfully.
 */

import { config } from '../config.js';
import { numOrNull } from '../util/numOrNull.js';
import { withJob } from '../perf/monitor.js'; // v2.498: 스톨 발생 시 '진행 중 작업' 표시(계측 전용)
import { store, usageReadable } from './../store.js';
/** v2.666: 호스트별 vCenter CPU 사용률 적재(iDRAC 통합 추이의 비교 계열). '0' 이면 끈다. */
const HOST_CPU_SERIES = String(process.env.HOST_CPU_SERIES ?? '').trim() !== '0';
import { getMetricsDb } from './db.js';
import { loadMetricsSettings } from './settings.js';
import { rollupBackfillStatus, scheduleRollupBackfill } from './rollupBackfill.js'; // v2.675: 롤업 도입 이전 원본 → 시간당 롤업
import { getGuestGpuHost, getGuestGpuVms } from '../gpu/store.js';
import { loadGpuGuestSettings } from '../gpu/settings.js';
import { updateVmStats } from '../reports/vmStats.js';
import { memSampleRows, maybeLogMem } from '../system/memtrack.js';
import { insertVmperf, pruneVmperf } from './vmperfDb.js';
import { loadVmperfSettings, vmperfTracks } from './vmperfSettings.js';
import { roomTempRows } from '../idrac/roomTempSeries.js';
import { serverTempRows } from '../idrac/serverTempSeries.js';   // v2.504: 서버별 온도 추이(아래 주석)
import { serverTrendRows } from '../idrac/serverTrendSeries.js'; // v2.660: iDRAC 통합 추이(CPU 사용률·CPU/GPU 온도)

let timer = null;
import { pushAll } from '../util/pushAll.js';
import { demoVmperfBackfill } from '../mock/demo/vmperf.js'; // v2.718: 데모(mock) 과거 90일 백필(한 번)
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
 * v2.620(SRV2620-03): '지금 값' 으로 적재하면 안 되는 vCenter — store 는 수집 실패 vCenter 의 마지막 정상 데이터를
 * `status:'unreachable', stale:true` 로 최대 LASTGOOD_HOLD_MS(기본 6시간) 이어 서빙하고, 위임(site) vCenter 는 마지막 push 를
 * **기한 없이** `stale:true` 로 서빙한다. 그 값을 매 주기 `ts = now` 로 적재하면 장애·엣지 정지 구간에 마지막 값의 평탄선이
 * 실측처럼 쌓이고 롤업·이상탐지·용량 예측이 그것을 쓴다(v2.387 · v2.504 iDRAC 규약과 같은 유형). 그런 vCenter 의 호스트·DS·VM 은
 * 적재하지 않는다 — 결측은 결측으로 남긴다.
 * @returns {Set<string>}
 */
export function staleVcenterIds(snap) {
  return new Set(unreadVcenterReasons(snap).keys());
}

/**
 * v2.621(감사 RECENT-03 — 재현: maintenance vCenter 가 제외되지 않았다): '지금 값' 으로 적재하지 않는 vCenter 와 그 사유(순수).
 *   · `maintenance` — 점검중. store.js 가 직전 캐시를 **기한 없이** 이어 서빙하고 stale 표시도 붙이지 않는다(점검이 며칠이면
 *     며칠 동안 같은 값의 평탄선이 ts=now 로 쌓였다). 엣지 agent/inventoryPush.js UNREAD_STATUSES 가 이미 '못 읽은 상태' 로 본다.
 *   · `unreachable` — 수집 실패 이월(LASTGOOD) 또는 최소 항목.
 *   · `stale` — 위임(site) push 가 낡았다(상태는 엣지가 준 값 그대로라 stale 표시로만 안다).
 *   ⚠ `pending`(첫 수집 중)은 넣지 않는다 — 적재할 데이터가 없어 호스트 제외 효과가 없고, 넣으면 영영 push 가 오지 않는 site
 *     vCenter 하나가 전체('') VM 합계를 **영원히** 막는다(v2.594 vmtrack 은 30분 시한을 두고 판단했다 — 같은 판단이 필요하면 별건).
 * @returns {Map<string,'maintenance'|'unreachable'|'stale'>}
 */
export function unreadVcenterReasons(snap) {
  const out = new Map();
  for (const vc of snap?.vcenters || []) {
    if (!vc || vc.id == null) continue;
    const reason = (vc.status === 'maintenance' || vc.maintenance === true) ? 'maintenance'
      : vc.status === 'unreachable' ? 'unreachable'
        : vc.stale === true ? 'stale' : null;
    if (reason) out.set(String(vc.id), reason);
  }
  return out;
}

/**
 * VM 할당 vs 실사용 집계 행 생성(v2.374) — vCenter 별 + 전체('').
 * 할당 CPU clock 은 vCPU × 그 VM 이 올라간 호스트의 코어당 MHz 로 환산한다(VM 객체에 MHz
 * 원값이 없어 호스트를 조인). 호스트 코어 MHz 를 모르는 VM 은 **CPU 집계에서 제외**한다
 * (임의값 추정 금지 — /tools/waste 의 overAllocatedReport 와 같은 규칙). 메모리는 호스트
 * 정보 없이 계산 가능하므로 전원 On 전량을 집계한다. 전원 OFF/템플릿은 제외(사용률 0 이라 왜곡).
 */
export function vmAllocRows(snap, settings) {
  // v2.620(SRV2620-03): 낡은(stale·unreachable) vCenter 의 VM·DS 는 적재 대상이 아니다. 전체('') 합계는 대상 vCenter 중
  //   하나라도 빠지면 **적재하지 않는다** — 부분 합은 '거짓 하락' 이다(v2.594 vmtrack skipped 와 같은 판단).
  const unread = unreadVcenterReasons(snap);
  const staleIds = new Set(unread.keys());
  const fresh = (id) => !staleIds.has(String(id));
  // v2.622(감사 RECENT-01 — 재현: 점검중 vCenter 하나로 전체('') 키가 사라졌다): 점검중(maintenance)은 관리자가 켜는 상태라
  //   며칠·몇 주 이어진다. pending 을 뺀 이유('합계를 영원히 막는다')가 그대로 들어맞으므로 전체 합계를 막는 집합에서 뺀다 —
  //   그 vCenter 행만 제외하고(fresh 거짓) 전체 합계는 적재하되, 뺀 개수를 maintenanceExcluded 로 밝힌다(부분 합 표식).
  let staleTracked = 0;
  let maintenanceTracked = 0;
  for (const [id, reason] of unread) {
    if (!vmperfTracks(id, settings)) continue;
    if (reason === 'maintenance') maintenanceTracked++; else staleTracked++;
  }
  // `${vcenterId}|${host.name}` -> 코어당 MHz. 이름 단독 키는 vCenter 간 동명 호스트가
  // 덮어써 다른 사이트 MHz 로 환산되는 오염이 생긴다(v2.388 수정).
  const hostMhz = new Map();
  for (const h of snap.hosts || []) {
    if (!fresh(h.vcenterId)) continue;
    const cores = Number(h.cpuCores) || 0;
    const total = Number(h.cpuTotalMhz) || 0;
    if (cores > 0 && total > 0) hostMhz.set(`${h.vcenterId}|${h.name}`, total / cores);
  }
  // vcenterId -> 누적
  const agg = new Map();
  const bucket = (id) => {
    let e = agg.get(id);
    if (!e) { e = { cpuUsed: 0, cpuAlloc: 0, memUsed: 0, memAlloc: 0, dsUsed: 0, dsCap: 0, diskProv: 0, diskUsed: 0, diskOff: 0, snapGB: 0, snapOnGB: 0 }; agg.set(id, e); }
    return e;
  };
  // v2.727(감사 C-01 — 재현 c01_sampler.mjs: VM a 500/100 + VM b storageGB·uncommittedGB null → prov 600·used 500·off 500 이
  //   **표지 없이** 적재됐다): soapClient.js 는 v2.719(B1-09)부터 summary.storage 를 못 읽은 VM 의 storageGB/uncommittedGB 를
  //   null 로 싣는데 여기가 `Number(null) || 0` 으로 0 을 더해 vm_disk_* 계열이 못 읽은 VM 만큼 **조용히 작게** 쌓였다(되돌릴 수 없다).
  //   DS 쪽(dsUsedUnknown — 아래)과 같은 규칙으로 VM 을 세어 lastRun 에 싣는다. 판정:
  //   · committed(storageGB)를 모르는 VM 은 디스크 계열 **다섯(prov/used/off/snap/snapOn) 전부에서 뺀다** — 다섯 계열이 같은 VM 집합을
  //     말해야 '회수 = off + snapOn' · '사용 ÷ 할당' 이 뜻을 갖는다. 스냅샷 크기(layoutEx)는 알 수 있어도 그 델타는 그 VM 의
  //     committed 에 이미 든 바이트라 committed 없이 더하면 계열끼리 짝이 안 맞는다.
  //   · uncommitted 만 모르는 VM 은 committed 를 prov/used/off/snap 에 더한다 — prov 에서도 빼면 그 vCenter 행이 prov < used 가 되어
  //     (prov = used + uncommitted 항등식 위반) 차트가 '미커밋 음수' 라는 거짓을 그린다. prov 는 그 VM 의 uncommitted 만큼 하한이므로
  //     같은 카운터(vmStorageUnknown)로 세어 행이 부분 합임을 밝힌다(사유는 vmStorageUnknownBy 로 나눈다).
  //   ⚠ 계열 전체를 보류(행을 안 만듦)하지 않는다 — 영구 결측 VM 하나가 그 vCenter 계열을 영원히 비운다(v2.682 R3A-03 교훈).
  //   ⚠ 보고된 0 은 값이다 — numOrNull 은 0 을 지키고 null·''·NaN 만 결측으로 본다.
  let vmStorageUnknown = 0;
  const vmStorageUnknownBy = { committed: 0, uncommitted: 0 };
  for (const v of snap.vms || []) {
    if (v.template) continue;
    if (!fresh(v.vcenterId)) continue;
    // 디스크 트렌드(v2.446) — 용량 리포트 › 디스크 트렌드의 '할당(프로비저닝)/커밋/정지 VM/스냅샷' 계열.
    // 전원 OFF VM 도 스토리지는 점유하므로 CPU/MEM 과 달리 **전원 무관하게** 집계한다.
    if (vmperfTracks(v.vcenterId, settings)) {
      const committed = numOrNull(v.storageGB);
      const uncommitted = numOrNull(v.uncommittedGB);
      const snapGB = Number(v.snapshotSizeGB) || 0;
      if (committed == null) { vmStorageUnknown += 1; vmStorageUnknownBy.committed += 1; }
      else {
        if (uncommitted == null) { vmStorageUnknown += 1; vmStorageUnknownBy.uncommitted += 1; }
        for (const id of (settings.trackTotal ? [v.vcenterId, ''] : [v.vcenterId])) {
          const e = bucket(id);
          e.diskProv += committed + (uncommitted ?? 0);
          e.diskUsed += committed;
          if (v.powerState !== 'POWERED_ON') e.diskOff += committed;
          e.snapGB += snapGB;
          // v2.630(감사 DATA2630-01): 전원 켜진 VM 의 스냅샷만 — 정지 VM 의 스냅샷 델타는 diskOff(committed)에 이미 들어 있다.
          //   회수 가능 시계열은 diskOff + snapOn 이어야 현재값(diskTrend.snapshotReclaimGB 의 offIds 판정 '!== POWERED_ON')과 같은 뜻이다.
          if (v.powerState === 'POWERED_ON') e.snapOnGB += snapGB;
        }
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
  // v2.598(감사 RECENT2598-03 — 재현: ds1 1000/800 + ds2 1000/사용량 미상 → 용량 2000 · 사용 800 = 40%. 실제는 판단 불가):
  // vCenter REST 폴백은 사용량을 못 읽은 DS 를 usedGB:null 로 준다(v2.597 C2597-08). 그것을 0 으로 더하면 사용량 계열이
  // 과소가 된다. 사용량을 못 읽은 DS 는 **용량·사용량 둘 다에서 빼고**(비율이 읽은 DS 끼리 맞게) 뺀 개수를 밝힌다.
  let dsUsedUnknown = 0;
  for (const d of snap.datastores || []) {
    if (!fresh(d.vcenterId)) continue;
    if (!vmperfTracks(d.vcenterId, settings)) continue;
    const cap = Number(d.capacityGB) || 0;
    if (cap <= 0) continue;                       // 용량 미상 데이터스토어는 집계 제외(추정 금지)
    const used = numOrNull(d.usedGB);
    if (used == null) { dsUsedUnknown += 1; continue; }
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
      rows.push({ metric: 'vm_snap_on_gb', k, v: Math.round(e.snapOnGB * 10) / 10 });
    }
    if (rows.length) out.set(k, rows);
  }
  out.dsUsedUnknown = dsUsedUnknown;             // 사용량을 못 읽어 디스크 합계에서 뺀 DS 수(lastRun 에 싣는다)
  out.vmStorageUnknown = vmStorageUnknown;       // v2.727(C-01): 스토리지를 못 읽어 VM 디스크 계열에서 뺐거나(committed) 부분 합으로 만든(uncommitted) VM 수
  out.vmStorageUnknownBy = vmStorageUnknownBy;   //   { committed, uncommitted } — 조치가 다르다(전자는 계열에서 빠짐 · 후자는 prov 만 하한)
  out.staleVcenters = staleTracked;              // v2.620(SRV2620-03): 낡아서 뺀 대상 vCenter 수(점검중 제외)
  out.maintenanceExcluded = maintenanceTracked;   // v2.622(RECENT-01): 점검중이라 행을 빼고 전체 합계에서도 빠진 대상 vCenter 수
  out.totalWithheld = false;
  out.totalPartial = false;
  if (staleTracked > 0 && out.has('')) { out.delete(''); out.totalWithheld = true; }
  else if (maintenanceTracked > 0 && out.has('')) out.totalPartial = true;  // 적재는 하되 점검중 vCenter 가 빠진 합계
  return out;
}

async function sampleOnceInner() {
  let gpuMemPartialHosts = 0; // v2.681 R2D-06 — 게스트 GPU 메모리 합이 부분 합이라 게스트 값을 적재하지 않은 호스트 수
  let dsUsedUnknown = 0; // v2.598 RECENT2598-03 — vmAllocRows 가 센 '사용량 미상으로 뺀 DS' 수
  let vmStorageUnknown = 0; let vmStorageUnknownBy = null; // v2.727(C-01) — vmAllocRows 가 센 '스토리지 미상 VM' 수·사유
  const snap = store.get();
  const db = await getMetricsDb();
  const ts = Date.now();
  const rows = [];
  // v2.620(SRV2620-03): 낡은 vCenter(수집 실패 이월·위임 push 끊김)의 호스트·DS 는 '지금 값' 으로 적재하지 않는다(staleVcenterIds 주석).
  // v2.621(감사 RECENT-03): 점검중(maintenance) vCenter 도 뺀다 — 사유별 개수를 staleSkipped.byReason 으로 밝힌다.
  const unreadReasons = unreadVcenterReasons(snap);
  const staleIds = new Set(unreadReasons.keys());
  const freshHosts = (snap.hosts || []).filter((h) => !staleIds.has(String(h.vcenterId)));
  const byReason = {};
  for (const r of unreadReasons.values()) byReason[r] = (byReason[r] || 0) + 1;
  const staleSkipped = { vcenters: staleIds.size, hosts: (snap.hosts || []).length - freshHosts.length, datastores: 0, byReason };
  let vmperfStale = null;

  // Host temperature (only hosts that report a sensor reading).
  const hostsWithTemp = freshHosts.filter((h) => h.tempC != null);
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

  // v2.666: 호스트별 vCenter CPU 사용률 — iDRAC 통합 추이가 매칭된 ESXi 호스트 값을 '별도 계열' 로 보여 준다(iDRAC CPU 와 섞지 않는다).
  //   연결된 호스트만(store.usageReadable — 끊긴 호스트의 마지막 값을 지금 값으로 쌓지 않는다) · 낡은 vCenter 는 freshHosts 가 이미 뺐다.
  //   행 수: 호스트 658대 × 1행/분 → 롤업 연 576만 행(temp_host 와 같은 규모). HOST_CPU_SERIES=0 으로 끈다.
  if (HOST_CPU_SERIES) {
    for (const h of freshHosts) {
      if (!usageReadable(h)) continue;
      const v = numOrNull(h.cpuUsagePct);
      if (v == null || v < 0 || v > 100) continue;
      rows.push({ metric: 'host_cpu_pct', k: h.id, v: round1(v) });
    }
  }

  // Datastore used GB (for capacity forecast).
  for (const d of snap.datastores || []) {
    if (staleIds.has(String(d.vcenterId))) { staleSkipped.datastores++; continue; }
    if (d.usedGB != null) rows.push({ metric: 'ds_usedgb', k: d.id, v: d.usedGB });
  }

  // GPU utilization — ESXi 보고값 우선, 없으면 게스트 OS 수집 오버레이(패스쓰루).
  // per host + per-cluster/per-vCenter averages.
  const gpuByCluster = new Map();
  const gpuByVc = new Map();
  // v2.681(R2D-05): 게스트 값의 신선도 경계 — 아래 VM 계열과 **같은 값**(게스트 폴 주기 × 3, 최소 15분).
  //   예전 호스트 계열은 게스트 항목의 at 을 보지 않아, 게스트 수집이 멈춘 패스쓰루 호스트의 마지막 사용률이
  //   store GC(약 35분)까지 매 분 '지금 값' 으로 다시 쌓였다(v2.504 '마지막 값을 다시 쓰면 평탄선' 규약). MIG(utilNA)도 뺀다.
  const gpuGuestPollMs = Number(loadGpuGuestSettings()?.pollIntervalMs) || 60_000;
  const gpuGuestFreshMs = Math.max(15 * 60_000, gpuGuestPollMs * 3);
  const gpuNow = Date.now();
  for (const h of freshHosts) {
    const gh = h.gpuUtilPct == null ? getGuestGpuHost(h.id) : null;
    const util = h.gpuUtilPct ?? (gh && !gh.utilNA && gh.at > gpuNow - gpuGuestFreshMs ? (gh.utilPct ?? null) : null);
    if (util == null) continue;
    rows.push({ metric: 'gpu_util', k: h.id, v: util });
    const ck = `${h.vcenterId}|${h.cluster || 'standalone'}`;
    (gpuByCluster.get(ck) || gpuByCluster.set(ck, []).get(ck)).push(util);
    (gpuByVc.get(h.vcenterId) || gpuByVc.set(h.vcenterId, []).get(h.vcenterId)).push(util);
  }
  for (const [k, arr] of gpuByCluster) rows.push({ metric: 'gpu_cluster', k, v: round1(avg(arr)) });
  for (const [k, arr] of gpuByVc) rows.push({ metric: 'gpu_vc', k, v: round1(avg(arr)) });

  // v2.650: VM 별 GPU 사용률·메모리 점유·온도 + 호스트 GPU 온도(가장 뜨거운 GPU)·메모리 점유.
  //   계열 수 계산(시간당 롤업 기준): GPU VM 200대 × 3계열 × 8,760시간 = 연 526만 행 — temp_host(655 호스트 연 574만 행)와
  //   같은 규모다. 원시 표본은 dead-band(0.5 변화)로 줄어든다. 켜진 VM 의 **신선한** 게스트 값만 적재한다
  //   (게스트 폴 주기 × 3, 최소 15분 — 마지막 값을 매 분 다시 쓰면 장기 차트가 평탄선이 된다, v2.504 규약).
  //   GPU_VM_SERIES=0 으로 끈다.
  if (process.env.GPU_VM_SERIES !== '0') {
    const freshMs = gpuGuestFreshMs;
    const nowG = gpuNow;
    const onGpuVm = new Map((snap.vms || []).filter((v) => v.gpu && v.powerState === 'POWERED_ON' && !staleIds.has(String(v.vcenterId))).map((v) => [v.id, v]));
    const hostIdOf = new Map((snap.hosts || []).map((h) => [`${h.vcenterId}\t${h.name}`, h.id]));
    const hostTemp = new Map(); const hostMem = new Map();
    // v2.681(R2D-06): 호스트의 켜진 GPU VM 수 — 메모리 합에 든 VM 이 이보다 적으면 그 합은 부분 합이다.
    const gpuVmsOfHost = new Map();
    for (const vm of onGpuVm.values()) {
      const hid = hostIdOf.get(`${vm.vcenterId}\t${vm.host}`);
      if (hid) gpuVmsOfHost.set(hid, (gpuVmsOfHost.get(hid) || 0) + 1);
    }
    for (const g of getGuestGpuVms()) {
      const vm = onGpuVm.get(g.vmId);
      if (!vm || !(g.at > nowG - freshMs)) continue;
      if (g.utilPct != null && !g.utilNA) rows.push({ metric: 'gpu_vm_util', k: g.vmId, v: g.utilPct });
      if (g.memUsedPct != null) rows.push({ metric: 'gpu_vm_mem', k: g.vmId, v: g.memUsedPct });
      if (g.tempC != null) rows.push({ metric: 'gpu_vm_temp', k: g.vmId, v: g.tempC });
      // v2.653: 메모리 절대량(MB)도 저장 — 사용률(%)만으로는 '몇 GB 를 쓰는가' 추이를 볼 수 없다(사용자 요청 "수집하는 모든 데이터를 저장").
      if (g.memUsedMB != null) rows.push({ metric: 'gpu_vm_mem_mb', k: g.vmId, v: g.memUsedMB });
      const hid = hostIdOf.get(`${vm.vcenterId}\t${vm.host}`);
      if (!hid) continue;
      if (g.tempC != null) hostTemp.set(hid, Math.max(hostTemp.get(hid) ?? -Infinity, g.tempC));
      if (g.memUsedMB != null && g.memTotalMB > 0) { const e = hostMem.get(hid) || [0, 0, 0]; e[0] += g.memUsedMB; e[1] += g.memTotalMB; e[2] += 1; hostMem.set(hid, e); }
    }
    // v2.681(R2D-06): 켜진 GPU VM 중 일부만 신선한 게스트 메모리 값을 준 호스트는 합이 부분 합이다 — 게스트 합을 적재하지 않고
    //   (거짓 하락) 아래 ESXi 카운터 경로로 넘긴다(그 값도 없으면 그 주기는 적재하지 않는다). 몇 호스트였는지는 gpuMemPartialHosts.
    for (const [hid, e] of [...hostMem]) {
      if (e[2] < (gpuVmsOfHost.get(hid) || 0)) { hostMem.delete(hid); gpuMemPartialHosts += 1; }
    }
    for (const [k, v] of hostTemp) rows.push({ metric: 'gpu_temp', k, v });
    for (const [k, [u, t]] of hostMem) { rows.push({ metric: 'gpu_mem', k, v: round1((u / t) * 100) }); rows.push({ metric: 'gpu_mem_mb', k, v: u }); }
    // v2.653: 게스트 값이 없는 호스트는 ESXi 카운터(gpu.temperature · gpu.mem.usage/used — vGPU/vSGA)로 채운다.
    //   같은 호스트에 두 출처를 섞지 않는다(게스트가 먼저). 신선한 호스트(freshHosts)만 — 낡은 vCenter 값을 '지금' 으로 쌓지 않는다.
    for (const h of freshHosts) {
      if (!(h.gpus || []).length) continue;
      if (!hostTemp.has(h.id) && Number.isFinite(h.gpuTempC)) rows.push({ metric: 'gpu_temp', k: h.id, v: h.gpuTempC });
      if (!hostMem.has(h.id)) {
        if (Number.isFinite(h.gpuMemUsedPct)) rows.push({ metric: 'gpu_mem', k: h.id, v: h.gpuMemUsedPct });
        if (Number.isFinite(h.gpuMemUsedMB)) rows.push({ metric: 'gpu_mem_mb', k: h.id, v: h.gpuMemUsedMB });
      }
    }
  }

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
      dsUsedUnknown = vmperfByVc.dsUsedUnknown || 0;
      vmStorageUnknown = vmperfByVc.vmStorageUnknown || 0;
      vmStorageUnknownBy = vmStorageUnknown ? { ...vmperfByVc.vmStorageUnknownBy } : null;
      if (vmperfByVc.staleVcenters || vmperfByVc.maintenanceExcluded) {
        vmperfStale = {
          vcenters: vmperfByVc.staleVcenters || 0, totalWithheld: !!vmperfByVc.totalWithheld,
          // v2.622(RECENT-01): 점검중 vCenter 는 합계를 막지 않고 빠진다 — 그 사실을 밝힌다.
          ...(vmperfByVc.maintenanceExcluded ? { maintenanceExcluded: vmperfByVc.maintenanceExcluded, totalPartial: !!vmperfByVc.totalPartial } : {}),
        };
      }
      for (const [vcId, vcRows] of vmperfByVc) {
        try { await insertVmperf(vcId, vcRows, ts); } catch (e) { console.warn(`[vmperf] ${vcId || '(전체)'} insert 실패: ${e.message}`); }
        // v2.618(PERF-2): vCenter 사이에 한 번 양보한다 — 기동 첫 샘플은 vCenter 마다 DB 파일을 처음 열어(PRAGMA 포함)
        //   33곳 연속이면 84ms 멈췄다(실측). 파일 하나당 약 3ms 조각으로 나뉜다.
        await new Promise((r) => setImmediate(r));
      }
      // v2.718: 데모(mock)는 과거 이력이 없으면 한 번 채운다(기다리지 않는다 — 샘플러 주기를 붙잡지 않게). mock 이 아니면 즉시 끝난다.
      demoVmperfBackfill(vmperfByVc, ts).catch((e) => console.warn(`[vmperf] 데모 백필 실패: ${e?.message || e}`));
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
  try { pushAll(rows, roomTempRows()); } catch { /* 집계 실패가 샘플링을 막지 않게 */ }

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
  try { pushAll(rows, serverTempRows()); } catch { /* 집계 실패가 샘플링을 막지 않게 */ }
  // v2.660: iDRAC 통합 추이 — 같은 대상·같은 신선도 판정(idrac/serverTrendSeries.js 머리말에 계열 수).
  // v2.665: CPU 사용률은 iDRAC 출처만 — vCenter 호스트 값을 넘기지 않는다.
  try { pushAll(rows, serverTrendRows()); } catch { /* 집계 실패가 샘플링을 막지 않게 */ }

  // 포탈 자신의 프로세스 메모리(누수 추적) — 인벤토리 유무와 무관하게 항상 샘플하고,
  // 시간당 1줄 상태 로그(링 버퍼·journal)도 여기서 남긴다. 실패가 본 샘플링을 막지 않게 격리.
  try { pushAll(rows, memSampleRows()); maybeLogMem(ts); } catch { /* */ }

  if (rows.length) { try { db.insertMany(rows, ts); } catch (e) { console.warn('[metrics] insert 실패:', e.message); } }

  // VM 사용률 누적(인메모리) — 라이트사이징 리포트용. 행을 쌓지 않으므로(O(VM수) 메모리)
  // 5,850 VM 규모에서도 시계열 DB 폭증 없이 평균/피크를 관측한다.
  // v2.622(감사 LEFT-04): 적재에서 뺀 vCenter(점검중·수집 실패 이월·낡은 위임)의 동결 VM 값은 누적하지 않는다.
  let vmStatsSkipped = 0;
  try { vmStatsSkipped = updateVmStats(snap, ts, { skipVcenterIds: staleIds })?.skipped || 0; } catch { /* 통계 실패가 샘플링을 막지 않게 */ }

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
  lastRun = {
    at: ts, rows: rows.length, hostsWithTemp: hostsWithTemp.length, ...(dsUsedUnknown ? { dsUsedUnknown } : {}), ...(gpuMemPartialHosts ? { gpuMemPartialHosts } : {}),
    // v2.727(C-01): DS 와 같은 자리 — 스토리지를 못 읽어 VM 디스크 계열에서 뺀 VM 수(0 이면 싣지 않는다).
    ...(vmStorageUnknown ? { vmStorageUnknown, vmStorageUnknownBy } : {}),
    // v2.620(SRV2620-03): 낡아서 적재하지 않은 vCenter·호스트·DS 수와, 그 때문에 전체('') VM 합계를 적재하지 않았는지.
    ...(staleSkipped.vcenters ? { staleSkipped } : {}),
    ...(vmperfStale ? { vmperfStale } : {}),
    ...(vmStatsSkipped ? { vmStatsSkipped } : {}),
  };
}

const round1 = (x) => (x == null ? null : Number(x.toFixed(1)));

/** 테스트 전용 — 타이머 없이 한 번 샘플한다(v2.621 감사 RECENT-03 회귀가 실제 적재 경로를 부른다). */
export function _sampleOnceForTest() { return sampleOnce(); }

/**
 * v2.628(감사 LEFT2628-01): 가장 최근 샘플이 적재에서 뺀 것(개수만). v2.620·v2.622 가 lastRun 에 싣고 **어느 화면도 읽지 않던**
 * 값이다 — 그래서 추이 화면은 마지막 전체 합계 점이 '적재 보류' 인지 '점검중 vCenter 를 뺀 부분 합' 인지 말할 수 없었다.
 * ⚠ 전 함대 기준 개수라 **전체 범위 계정에만** 준다(범위 계정은 null — '귀속 없는 데이터 미노출').
 * 적재 제외가 하나도 없으면 null 이다(0 칸을 늘어놓지 않는다).
 */
export function samplerWithheldOf(lastRun) {
  if (!lastRun || typeof lastRun !== 'object') return null;
  const vs = lastRun.vmperfStale || null;
  const ss = lastRun.staleSkipped || null;
  const out = {
    at: _num(lastRun.at),
    staleVcenters: _num(ss?.vcenters) || 0,
    byReason: ss && ss.byReason && typeof ss.byReason === 'object' ? { ...ss.byReason } : {},
    totalWithheld: !!vs?.totalWithheld,
    totalPartial: !!vs?.totalPartial,
    maintenanceExcluded: _num(vs?.maintenanceExcluded) || 0,
    vmStatsSkipped: _num(lastRun.vmStatsSkipped) || 0,
    // v2.727(C-01): 결측으로 뺀 DS·VM 수 — 추이 화면이 '마지막 점이 못 읽은 장비를 뺀 값' 임을 말한다(0 으로 채우지 않았다).
    dsUsedUnknown: _num(lastRun.dsUsedUnknown) || 0,
    vmStorageUnknown: _num(lastRun.vmStorageUnknown) || 0,
  };
  if (!out.staleVcenters && !out.totalWithheld && !out.totalPartial && !out.maintenanceExcluded && !out.vmStatsSkipped
    && !out.dsUsedUnknown && !out.vmStorageUnknown) return null;
  return out;
}
const _num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function metricsSamplerStatus() {
  const s = loadMetricsSettings();
  return { intervalMs: s.sampleIntervalMs, retentionDays: s.retentionDays, rawRetentionDays: s.rawRetentionDays, lastRun, rollupBackfill: rollupBackfillStatus() };
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
  // v2.591 L9: 기동 스태거 전에 설정 저장(reschedule)이 먼저 오면 그 interval 이 고아로 남아 샘플러가 두 벌이 됐다.
  if (timer) clearInterval(timer);
  timer = setInterval(() => sampleOnce().catch(() => {}), sampleIntervalMs);
  timer.unref?.();
  console.log(`[metrics] sampler started (every ${Math.round(sampleIntervalMs / 1000)}s, retention ${retentionDays}d)`);
  // v2.675: 롤업 도입(v2.252) 이전 원본을 시간당 롤업으로 옮긴다(긴 기간 차트가 원본으로 떨어지지 않게). 기동 5분 뒤 · 천천히 · 1회.
  scheduleRollupBackfill();
}
