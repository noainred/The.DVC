// 하드웨어/ESXi/GPU 인벤토리·시계열 export·IP핑 — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds, inUserScope } from '../../auth/scope.js';
import { guardCell } from '../../util/csv.js';
import { store } from '../../store.js';
import { config, loadVcenterConfig } from '../../config.js';
import { getMetricsDb } from '../../metrics/db.js';
import { sendMaybeZip } from '../../util/zip.js';
import { getGuestGpuVms } from '../../gpu/store.js';
import { summarizeHostGpu } from '../../gpu/hostGpu.js';
import { guestWhyOf } from '../../gpu/guestWhy.js';
import { getAllGpuGuestDiag } from '../../central/gpuGuestDiag.js';
import { getGpuGuestDiag } from '../../gpu/poller.js';
import { loadGpuGuestSettings } from '../../gpu/settings.js';
import { findCollectorByName } from '../../collector/registry.js';
import { allCollectorStatus } from '../../collector/state.js';
import { gpuActivity, BUSY_UTIL_PCT, HELD_MEM_PCT } from '../../gpu/activity.js';
import { vmVgpuAllocGB } from '../../gpu/vgpuProfile.js';
import { enqueuePing, getPingResults, setPingResults } from '../../central/pingJobs.js';
import { pingMany } from '../../util/ping.js';
import { todayStamp } from "../../util/dayKey.js";
import { acquireExport } from '../../util/exportBusy.js';
import { snapMemo } from '../../util/snapCache.js';
// v2.643: CSV·텍스트 가져오기/내보내기는 관리자 이상 + 'data.csv' 권한(super_admin 항상, admin 은 권한 설정에서 끌 수 있다).
const csvPerm = requirePerm('data.csv');


/**
 * GPU 호스트 매핑 키(v2.598 VC2598-03) — 호스트 **이름 단독** 키는 다른 vCenter 의 같은 이름 호스트
 * (esx01 같은 이름이 법인마다 있다)의 할당 VM·게스트 사용률·GPU 모델을 한 호스트에 섞는다.
 * 호스트 이름은 vCenter 안에서만 유일하므로 (vcenterId, 이름) 쌍으로 묶는다.
 */
export const gpuHostKey = (vcenterId, host) => `${vcenterId ?? ''}\t${host ?? ''}`;

/** GPU 호스트 → 대표 모델 맵(키 gpuHostKey). */
export function gpuHostModelMap(hosts) {
  const m = new Map();
  for (const h of hosts || []) if ((h.gpus || []).length) m.set(gpuHostKey(h.vcenterId, h.name), h.gpus[0].model);
  return m;
}

/**
 * v2.653: 호스트별 '게스트 값이 왜 비었는가' 판정 입력(gpu/guestWhy.js)을 vCenter 단위로 모은다.
 *   수집 경로(site=엣지/direct=중앙) · 담당 엣지(스냅샷 collectedBy) · 엣지 버전(수집 서버 상태) · 엣지가 보낸 수집 진단 ·
 *   중앙 로컬 설정·진단. 모두 인메모리/설정 파일이라 왕복 0 이다. 실패는 그 입력만 비운다(판정은 'unknown' 으로 떨어진다).
 */
export function gatherGuestWhyCtx(snap) {
  const mode = new Map();
  try { for (const v of loadVcenterConfig().vcenters || []) if (v && v.id != null) mode.set(String(v.id), (v.collectMode || 'direct') === 'site' ? 'site' : 'direct'); } catch { /* 등록부 못 읽음 */ }
  const agentOf = new Map();
  for (const v of snap.vcenters || []) if (v && v.collectedBy) agentOf.set(String(v.id), String(v.collectedBy));
  const reports = new Map();
  try { for (const r of getAllGpuGuestDiag()) if (r && r.agent) reports.set(String(r.agent).toLowerCase(), r); } catch { /* */ }
  let st = {}; try { st = allCollectorStatus() || {}; } catch { st = {}; }
  const verOf = (agent) => { try { const c = findCollectorByName(agent); return (c && st[c.id]?.version) || null; } catch { return null; } };
  let local = null; let settings = null;
  try { local = getGpuGuestDiag(); } catch { local = null; }
  try { settings = loadGpuGuestSettings(); } catch { settings = null; }
  const cache = new Map();
  return (vcId) => {
    const id = String(vcId ?? '');
    if (cache.has(id)) return cache.get(id);
    let ctx;
    if (mode.get(id) === 'site') {
      const agent = agentOf.get(id) || '';
      const report = agent ? reports.get(agent.toLowerCase()) || null : null;
      ctx = { mode: 'site', agent, edgeVersion: agent ? verOf(agent) : null, report,
        diagVc: report ? (report.vcenters || []).find((x) => String(x?.vcId) === id) || null : null };
    } else {
      // v2.653: 데모(mock)는 설정과 무관하게 전 법인을 합성 수집한다(gpu/poller.js demoAll) — '수집 꺼짐' 이라 말하면 거짓이다.
      const enabled = snap.source === 'mock' ? null : settings ? !!(settings.enabled && settings.vcenters?.[id]?.enabled) : null;
      ctx = { mode: 'direct', enabled, diagVc: local ? (local.vcenters || []).find((x) => String(x?.vcId) === id) || null : null };
    }
    cache.set(id, ctx);
    return ctx;
  };
}


/**
 * v2.657(사용자 요청 "GPU 사용율·메모리 할당·메모리 사용, 아니면 GPU 정보 전체를 못 읽는지 구체적으로"):
 * 배너 한 줄(vCenter × 사유)에 '그 호스트들에서 무엇이 비었나' 를 싣는다. 호스트 대수로 센다.
 *   util  사용률을 어느 출처(ESXi·게스트)로도 못 얻음
 *   mem   메모리 사용을 어느 출처로도 못 얻음
 *   temp  온도를 어느 출처로도 못 얻음
 *   alloc 켜진 vGPU VM 의 프로파일을 해석하지 못함(할당은 게스트가 아니라 vCenter 프로파일에서 온다)
 *   all   사용률·메모리 사용·온도가 전부 비었음(= 이 호스트의 GPU 동작 값을 하나도 모른다)
 */
export function missingZero() { return { util: 0, mem: 0, temp: 0, alloc: 0, all: 0 }; }
export function addMissing(m, gs) {
  const u = gs.utilPct == null; const me = gs.memUsedMB == null && gs.memUsedPct == null; const t = gs.tempC == null;
  if (u) m.util++; if (me) m.mem++; if (t) m.temp++;
  if ((gs.allocUnknown || 0) > 0) m.alloc++;
  if (u && me && t) m.all++;
  return m;
}

// GPU inventory per host + aggregate counts by model and vCenter.
// GPU 인벤토리 집계(호스트별 GPU 장수·모드·사용률·할당 VM) — /tools/gpu 와 CSV/JSON export 공용.
export function buildGpuInventory(snap, vcenterId, allowed = null) {
  let hosts = snap.hosts;
  if (allowed) hosts = hosts.filter((h) => allowed.has(h.vcenterId));  // 사용자 scope 선강제
  if (vcenterId) hosts = hosts.filter((h) => h.vcenterId === vcenterId);
  // 스코프 밖 VM(할당 VM 이름·게스트 오버레이·GPU VM 수)이 새지 않게 vms 도 allowed 로 거른다.
  const scopedVms = allowed ? (snap.vms || []).filter((v) => allowed.has(v.vcenterId)) : (snap.vms || []);
  const hostsWithGpu = [];
  const byModel = {};
  const byVcenter = {};
  const byMode = { vgpu: 0, passthrough: 0, vsga: 0 };
  let totalGpus = 0;
  // GPU가 할당된 VM을 호스트(이름)별로 집계 — 각 GPU 호스트에 몇 개 VM이 GPU를 쓰는지.
  // 키는 gpuHostKey(vcenterId, 호스트 이름) — 이름 단독이면 다른 vCenter 의 동명 호스트와 섞인다(VC2598-03).
  const gpuVmByHost = new Map();
  for (const v of scopedVms) {
    if (!v.gpu || !v.host) continue;
    const k = gpuHostKey(v.vcenterId, v.host);
    const e = gpuVmByHost.get(k) || { vms: 0, on: 0, off: 0, vgpu: 0, passthrough: 0, names: [] };
    e.vms++; e.vgpu += v.gpu.vgpu || 0; e.passthrough += v.gpu.passthrough || 0;
    if (v.powerState === 'POWERED_ON') e.on++; else e.off++;
    if (v.name) e.names.push({ name: v.name, on: v.powerState === 'POWERED_ON' });
    gpuVmByHost.set(k, e);
  }
  // 게스트 수집 사용률은 '전원 ON GPU VM'만 집계(전원 OFF VM의 stale 값 제외) → 호스트별 평균.
  // 게스트 레코드의 vCenter 는 스냅샷 VM 에서 얻는다(레코드에 vcenterId 가 없을 수 있다 — 구버전 엣지).
  const onGpuVms = new Map(scopedVms.filter((v) => v.gpu && v.powerState === 'POWERED_ON').map((v) => [v.id, v]));
  const guestUtilByHost = new Map(); // gpuHostKey -> [utilPct...]
  for (const g of getGuestGpuVms()) {
    const vm = onGpuVms.get(g.vmId);
    if (!vm || g.utilPct == null) continue;
    const k = gpuHostKey(vm.vcenterId, g.host || vm.host);
    const arr = guestUtilByHost.get(k) || []; arr.push(g.utilPct); guestUtilByHost.set(k, arr);
  }
  // v2.650: 호스트별 GPU 메모리 할당/사용·온도·동작 — 호스트 상세와 같은 판정(gpu/hostGpu.js summarizeHostGpu).
  const guestByVm = new Map(getGuestGpuVms().map((g) => [g.vmId, g]));
  const gpuVmsByHost = new Map();
  for (const v of scopedVms) {
    if (!v.gpu || !v.host) continue;
    const k = gpuHostKey(v.vcenterId, v.host);
    (gpuVmsByHost.get(k) || gpuVmsByHost.set(k, []).get(k)).push(v);
  }
  let allocGBTotal = 0; let allocHosts = 0; let memUsedMBTotal = 0; let memTotalMBTotal = 0; let memHosts = 0; let tempMax = null;
  const actTotal = { busy: 0, held: 0, idle: 0, unknown: 0 };
  const whyCtx = gatherGuestWhyCtx(snap);
  const whyCounts = {};
  for (const h of hosts) {
    const gpus = h.gpus || [];
    if (!gpus.length) continue;
    totalGpus += gpus.length;
    const gs = summarizeHostGpu(h, gpuVmsByHost.get(gpuHostKey(h.vcenterId, h.name)) || [], guestByVm);
    const why = guestWhyOf(gs, whyCtx(h.vcenterId));
    if (why) {
      const k = `${h.vcenterId}\t${why.code}`;
      const e = whyCounts[k] || (whyCounts[k] = { vcenterId: h.vcenterId, code: why.code, agent: why.agent || null, detail: why.detail || null, hosts: 0, vms: 0, missing: missingZero() });
      e.hosts++; e.vms += gs.vmsUnread || 0;
      addMissing(e.missing, gs);
    }
    if (gs.allocGB != null) { allocGBTotal += gs.allocGB; allocHosts++; }
    if (gs.memUsedMB != null && gs.memTotalMB > 0) { memUsedMBTotal += gs.memUsedMB; memTotalMBTotal += gs.memTotalMB; memHosts++; }
    if (gs.tempC != null) tempMax = tempMax == null ? gs.tempC : Math.max(tempMax, gs.tempC);
    for (const k of Object.keys(actTotal)) actTotal[k] += gs.activity[k] || 0;
    // 한 호스트에 모드가 섞일 수 있으므로 대표 모드(가장 많은 것) + 개수 분포를 함께 제공.
    const modes = {};
    for (const g of gpus) { const md = g.mode || (g.vgpuMode ? 'vgpu' : 'passthrough'); modes[md] = (modes[md] || 0) + 1; byMode[md] = (byMode[md] || 0) + 1; }
    const primaryMode = Object.entries(modes).sort((a, b) => b[1] - a[1])[0][0];
    // ESXi가 사용률을 못 보는 패스쓰루 호스트는 게스트 OS 수집 오버레이로 보완(전원 ON VM만).
    const gu = guestUtilByHost.get(gpuHostKey(h.vcenterId, h.name));
    const guestUtil = gu && gu.length ? Math.round(gu.reduce((a, b) => a + b, 0) / gu.length) : null;
    const utilPct = h.gpuUtilPct ?? guestUtil;
    const vmAlloc = gpuVmByHost.get(gpuHostKey(h.vcenterId, h.name)) || { vms: 0, on: 0, off: 0, vgpu: 0, passthrough: 0, names: [] };
    hostsWithGpu.push({
      id: h.id, host: h.name, vcenterId: h.vcenterId, cluster: h.cluster, count: gpus.length,
      model: gpus[0].model, memGB: gpus[0].memGB, mode: primaryMode, modes,
      vgpu: primaryMode === 'vgpu', utilPct, utilSource: h.gpuUtilPct != null ? 'esxi' : (guestUtil != null ? 'guest' : null),
      assignedVms: vmAlloc.vms, assignedVmsOn: vmAlloc.on || 0, assignedVmsOff: vmAlloc.off || 0, assignedVmNames: vmAlloc.names || [],
      // v2.650
      capacityGB: gs.capacityGB, capacityEstimated: gs.capacityEstimated, allocCapacityGB: gs.allocCapacityGB, allocCapacityBasis: gs.allocCapacityBasis,
      allocGB: gs.allocGB, allocUnknown: gs.allocUnknown, allocPct: gs.allocPct, passthroughOn: gs.passthroughOn,
      memUsedMB: gs.memUsedMB, memTotalMB: gs.memTotalMB, memUsedPct: gs.memUsedPct, memVms: gs.memVms, memSource: gs.memSource, tempSource: gs.tempSource,
      tempC: gs.tempC, vmsRead: gs.vmsRead, vmsUnread: gs.vmsUnread, activity: gs.activity,
      // v2.653: 게스트 값이 빈 이유(gpu/guestWhy.js) · 수집 경로 · 호스트 VM 목록(펼침 행 — 호스트 상세와 같은 판정)
      guestWhy: why, collectPath: whyCtx(h.vcenterId).mode, collectAgent: whyCtx(h.vcenterId).agent || null,
      vms: gs.vms.map((v) => ({ id: v.id, name: v.name, powerState: v.powerState, mode: v.mode, profile: v.profile, allocGB: v.allocGB, utilPct: v.utilPct, utilNA: v.utilNA, memUsedMB: v.memUsedMB, memTotalMB: v.memTotalMB, tempC: v.tempC, activity: v.activity })),
    });
    for (const g of gpus) {
      byModel[g.model] = (byModel[g.model] || 0) + 1;
      byVcenter[h.vcenterId] = (byVcenter[h.vcenterId] || 0) + 1;
    }
  }
  const utils = hostsWithGpu.map((x) => x.utilPct).filter((x) => x != null);
  // GPU를 사용하는 VM 수(스코프 내, 템플릿 제외) — 상단 요약용.
  const gpuVmCount = scopedVms.filter((v) => v.gpu && !v.template && (!vcenterId || v.vcenterId === vcenterId)).length;
  return {
    totalGpus,
    hostsWithGpu: hostsWithGpu.length,
    gpuVmCount,
    utilReporting: utils.length,
    avgUtilPct: utils.length ? Math.round(utils.reduce((a, b) => a + b, 0) / utils.length) : null,
    // v2.650: 메모리 할당(vGPU 프로파일 합)·사용(게스트 수집 합)·가장 뜨거운 GPU·동작 상태 개수(켜진 GPU VM 기준 — 겹치지 않는다)
    allocGB: allocHosts ? Math.round(allocGBTotal * 10) / 10 : null,
    memUsedMB: memHosts ? memUsedMBTotal : null,
    memTotalMB: memHosts ? memTotalMBTotal : null,
    memUsedPct: memHosts && memTotalMBTotal ? Math.round((memUsedMBTotal / memTotalMBTotal) * 100) : null,
    tempC: tempMax,
    activity: actTotal,
    activityRule: { busyUtilPct: BUSY_UTIL_PCT, heldMemPct: HELD_MEM_PCT },
    byMode,
    byModel: Object.entries(byModel).map(([model, count]) => ({ model, count })).sort((a, b) => b.count - a.count),
    byVcenter: Object.entries(byVcenter).map(([vcenterId, count]) => ({ vcenterId, count })).sort((a, b) => b.count - a.count),
    items: hostsWithGpu.sort((a, b) => b.count - a.count),
    // v2.653: vCenter × 사유별 개수(표 위 배너) — 켜진 GPU VM 을 한 대도/일부 못 읽은 호스트만 센다.
    guestWhy: Object.values(whyCounts).sort((a, b) => b.hosts - a.hosts),
  };
}

/**
 * GPU 사용률 시계열 CSV **스트리밍** export(v2.371).
 * 기존 경로는 청크 조회로 이벤트 루프 양보까지 했지만 결과를 out[] 에 전량 누적한 뒤
 * lines.join() 으로 수십 MB 문자열을 한 번에 만들어 전송했다 — 그 직렬화가 중간 양보 없는
 * 동기 CPU 라 포탈 전체가 그 시간만큼 멈추고 메모리 피크도 컸다(30만 행 × 객체+라인+합친 문자열).
 * 이제 vclogs export(`/tools/vclogs/export.csv`)와 **같은 패턴**으로 청크마다 즉시 흘려보낸다:
 * 청크 조회 → 그 청크만 라인 변환 → res.write → 백프레셔(drain) → setImmediate 양보 → 반복.
 * ⚠ 스트리밍이므로 zip 압축(sendMaybeZip, 1MB 초과 시)은 적용할 수 없다 — 전량 버퍼가 필요하기
 *   때문이다. 대량 export 에서 '포탈이 멈추지 않는 것'이 압축 이득보다 중요하다는 판단.
 *   (compress.js 의 ETag 래퍼는 res.json 만 감싸므로 이 경로는 ETag/304 에 영향을 주지 않는다.)
 */
async function gpuSeriesExportCsvStream(req, res) {
  const range = req.query.range === 'days' ? 'days' : 'all';
  const days = Math.max(1, Math.min(1830, Number(req.query.days) || 30));
  const vcId = req.query.vcenterId || null;
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap); // null=무제한. 범위 밖 vCenter 유출 차단(기존과 동일).
  const hostMap = new Map();
  for (const h of snap.hosts || []) hostMap.set(h.id, h);
  const db = await getMetricsDb();
  // v2.675: 시작 시각만 쓴다 — meta() 의 COUNT(*) 는 gpu_util 원본 전부를 동기로 훑는다(합성 3,168만 행 2.3초).
  const meta = typeof db.metaRange === 'function' ? db.metaRange('gpu_util') : db.meta('gpu_util');
  const until = Date.now();
  const since = range === 'days' ? until - days * 86_400_000 : (meta.firstTs ?? 0);
  const MAX_ROWS = Math.max(1000, Number(process.env.GPU_EXPORT_MAX_ROWS) || 300_000);
  const CHUNK = 50_000;
  const normPct = (v) => { const n = Number(v); if (!Number.isFinite(n)) return 0; const p = n > 100 ? n / 100 : n; return Math.max(0, Math.min(100, Math.round(p))); };
  const esc = (v) => { const t = guardCell(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }; // guardCell: 수식 인젝션 방어
  const stamp = todayStamp();
  const sinceIso = meta.firstTs ? new Date(meta.firstTs).toISOString() : '없음';

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="gpu-history-${range}-${stamp}.csv"`);
  // 헤더 주석 2줄 + 컬럼행. 총 샘플 수는 스트리밍이라 미리 알 수 없어 마지막에 요약 주석으로 적는다.
  res.write('\uFEFF' + [
    `# GPU 사용률 수집 데이터 — 수집 시작: ${sinceIso} (그날부터 누적) | 범위: ${range === 'all' ? '전체' : `최근 ${days}일`} | 생성: ${new Date().toISOString()}`,
    '# 단위: gpu_util_pct = GPU 사용률 %(0~100) · epoch_ms = Unix epoch 밀리초(엑셀은 지수표기로 보일 수 있음) · timestamp_iso = ISO8601 시각',
    'timestamp_iso,epoch_ms,host,vcenter_id,cluster,gpu_util_pct',
  ].join('\r\n') + '\r\n');

  let cursor = since;
  let written = 0;
  let truncated = false;
  while (written < MAX_ROWS) {
    if (res.destroyed) return; // 클라이언트 중단 시 즉시 종료(불필요한 조회 방지)
    const chunk = db.dump('gpu_util', cursor, until, CHUNK);
    if (!chunk.length) break;
    let rows = chunk;
    if (chunk.length === CHUNK) {
      // 경계 ts 행이 잘리지 않게 마지막 ts 는 버리고 다음 청크에서 다시 읽는다(기존 로직과 동일).
      const lastTs = chunk[chunk.length - 1].ts;
      rows = chunk.filter((r) => r.ts < lastTs);
      cursor = lastTs;
    }
    const lines = [];
    for (const r of rows) {
      const h = hostMap.get(r.k);
      if (allowed && !allowed.has(h?.vcenterId || '')) continue; // scope 밖(미상 호스트 포함) 제외
      if (vcId && (!h || h.vcenterId !== vcId)) continue;
      lines.push([new Date(r.ts).toISOString(), r.ts, h?.name || r.k, h?.vcenterId || '', h?.cluster || '', normPct(r.v)].map(esc).join(','));
      written += 1;
      if (written >= MAX_ROWS) { truncated = true; break; }
    }
    if (lines.length) {
      const ok = res.write(lines.join('\r\n') + '\r\n');
      if (!ok) await new Promise((resolve) => res.once('drain', resolve)); // 소켓 백프레셔(느린 클라이언트에 수십 MB 버퍼링 방지)
    }
    if (truncated) break;
    if (chunk.length < CHUNK) break;
    await new Promise((resolve) => setImmediate(resolve)); // 이벤트 루프 양보(다른 사용자 요청 처리)
  }
  // 잘린 결과를 완전한 것처럼 주지 않는다 — CSV 안에 명시(vclogs 와 동일 원칙).
  res.write(`# 샘플 ${written.toLocaleString()}건${truncated ? ` (행 상한 ${MAX_ROWS.toLocaleString()} 도달 — 기간을 좁혀 다시 내보내세요)` : ''}\r\n`);
  res.end();
}

/**
 * GPU 사용률 시계열 JSON **스트리밍** export(v2.632 AX3-04).
 * 예전 JSON 경로는 최대 30만 행을 out[] 에 모은 뒤 `JSON.stringify(…, null, 2)` + zipSingle(deflateRawSync)
 * 를 메인 스레드에서 **동기로** 했다 — 1건 2.6초·루프 지연 1.9초, 동시 10건이면 루프 지연 15초·RSS 1GB(감사 재현).
 * CSV(v2.371)와 같은 패턴으로 청크마다 흘려보낸다: 조회 → 그 청크만 직렬화 → res.write → drain → 양보.
 * zip 압축은 전량 버퍼가 필요해 적용하지 않는다(CSV 와 같은 판단). 들여쓰기도 없다.
 * sampleCount·truncated 는 끝에서야 알 수 있으므로 객체의 **마지막 키**로 싣는다(JSON 키 순서는 뜻이 없다).
 */
async function gpuSeriesExportJsonStream(req, res) {
  const range = req.query.range === 'days' ? 'days' : 'all';
  const days = Math.max(1, Math.min(1830, Number(req.query.days) || 30));
  const vcId = req.query.vcenterId || null;
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap); // null=무제한. 범위 밖 vCenter 의 GPU 시계열 유출 차단.
  const hostMap = new Map();
  for (const h of snap.hosts || []) hostMap.set(h.id, h);
  const db = await getMetricsDb();
  // v2.675: 시작 시각만 쓴다 — meta() 의 COUNT(*) 는 gpu_util 원본 전부를 동기로 훑는다(합성 3,168만 행 2.3초).
  const meta = typeof db.metaRange === 'function' ? db.metaRange('gpu_util') : db.meta('gpu_util');
  const until = Date.now();
  const since = range === 'days' ? until - days * 86_400_000 : (meta.firstTs ?? 0);
  const MAX_ROWS = Math.max(1000, Number(process.env.GPU_EXPORT_MAX_ROWS) || 300_000);
  const CHUNK = 50_000;
  // gpu_util은 %(0~100). 과거 일부 샘플이 vSphere 1/100% 단위로 ×100 저장된 경우가 있어 100 초과면 ÷100.
  const normPct = (v) => { const n = Number(v); if (!Number.isFinite(n)) return 0; const p = n > 100 ? n / 100 : n; return Math.max(0, Math.min(100, Math.round(p))); };
  const stamp = todayStamp();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="gpu-history-${range}-${stamp}.json"`);
  const head = {
    generatedAt: new Date().toISOString(), collectedSince: meta.firstTs ? new Date(meta.firstTs).toISOString() : null,
    range, days: range === 'days' ? days : null, vcenterId: vcId,
  };
  res.write(JSON.stringify(head).slice(0, -1) + ',"points":[');
  let cursor = since;
  let written = 0;
  let truncated = false;
  while (written < MAX_ROWS) {
    if (res.destroyed) return; // 클라이언트 중단 시 즉시 종료
    const chunk = db.dump('gpu_util', cursor, until, CHUNK);
    if (!chunk.length) break;
    let rows = chunk;
    if (chunk.length === CHUNK) {
      // 경계 ts 의 행이 잘리지 않게 마지막 ts 는 버리고 다음 청크에서 다시 읽는다(CSV 와 같은 페이지네이션).
      const lastTs = chunk[chunk.length - 1].ts;
      rows = chunk.filter((r) => r.ts < lastTs);
      cursor = lastTs;
    }
    const parts = [];
    for (const r of rows) {
      const h = hostMap.get(r.k);
      if (allowed && !allowed.has(h?.vcenterId || '')) continue; // scope 밖(미상 호스트 포함) 제외
      if (vcId && (!h || h.vcenterId !== vcId)) continue;
      parts.push(JSON.stringify({ ts: r.ts, host: h?.name || r.k, vcenterId: h?.vcenterId || '', cluster: h?.cluster || '', utilPct: normPct(r.v), tsIso: new Date(r.ts).toISOString() }));
      written += 1;
      if (written >= MAX_ROWS) { truncated = true; break; }
    }
    if (parts.length) {
      const ok = res.write((written - parts.length > 0 ? ',' : '') + parts.join(','));
      if (!ok) await new Promise((resolve) => res.once('drain', resolve)); // 소켓 백프레셔
    }
    if (truncated) break;
    if (chunk.length < CHUNK) break;
    await new Promise((resolve) => setImmediate(resolve)); // 이벤트 루프 양보
  }
  res.end(`],"sampleCount":${written},"truncated":${truncated}}`);
}

// GPU 사용률 '수집된 전체 데이터' export — 시계열(샘플마다 한 행). range=all(수집 시작~현재)
// 또는 range=days(최근 N일). vcenterId로 법인 스코프. format은 .csv/.json — 둘 다 스트리밍이다.
// v2.632 AX3-04: 동시 실행 1건 가드(util/exportBusy — v2.575 '새 내보내기 라우트도 acquireExport') — 넘으면 409 export_busy.
//   release 는 finally — 예외로 빠져나가도 이름이 잠기지 않게.
async function gpuSeriesExport(req, res, fmt) {
  const lock = acquireExport('gpu.series.export', req);
  if (!lock.ok) return res.status(lock.status).json(lock.body);
  try {
    if (fmt === 'csv') return await gpuSeriesExportCsvStream(req, res);
    return await gpuSeriesExportJsonStream(req, res);
  } finally {
    lock.release();
  }
}

// 중앙에서 직접 ping 시도 후 결과 저장(에이전트 없이도 같은 망이면 즉시 결과). 실패 격리.
// v2.590 P11: 위임(site) vCenter 는 도달한 것만 저장하고 나머지는 담당 엣지 보고를 기다린다. **중앙 직접 수집
// vCenter 는 담당 엣지가 없으므로** 무응답도 그대로 저장한다 — 예전에는 엣지를 기다린다며 영원히 '확인 중…' 이었다.
async function pingLocallyAndStore(vcenterId, ips, { direct = false } = {}) {
  const rows = await pingMany(ips, { timeoutMs: 1500 });
  const keep = direct ? rows : rows.filter((r) => r.alive);
  if (keep.length) setPingResults(vcenterId, keep);
}
/** 이 vCenter 가 엣지 위임(site)인가 — 스냅샷 항목의 수집 방식으로 판정한다(store.js 가 같은 필드를 쓴다). */
function isSiteVcenter(snap, vcenterId) {
  const vc = (snap?.vcenters || []).find((v) => v.id === vcenterId);
  if (vc && (vc.collectMode === 'site' || vc.collectSource === 'site')) return true;
  // v2.591(3차 감사 R-P1): 점검중(maintenance)인 위임 vCenter 는 스냅샷 항목에 collectMode 가 실리지 않는다 —
  //   그러면 엣지 큐에 넣지 않고 중앙 ping 무응답을 전부 'down' 으로 저장했다. 스냅샷에서 모르면 **등록부**로 판정한다.
  try { return (loadVcenterConfig().vcenters || []).some((v) => v.id === vcenterId && v.collectMode === 'site'); } catch { return false; }
}

export function registerHardwareGpu(api) {

// Host hardware (vendor/model) summary — per vendor, per model, and the
// vCenter × vendor × model breakdown ("어떤 법인에 어떤 모델 몇 대").
api.get('/tools/hardware', requirePerm('tools'), (req, res) => {
  const snap = store.get();
  let hosts = snap.hosts;
  const allowed = scopedVcenterIds(req.user, snap);
  if (allowed) hosts = hosts.filter((h) => allowed.has(h.vcenterId));
  if (req.query.vcenterId) hosts = hosts.filter((h) => h.vcenterId === req.query.vcenterId);
  const vcName = {};
  for (const vc of snap.vcenters || []) vcName[vc.id] = vc.name;
  const byVendor = {};
  const byModel = {};
  const combo = new Map(); // vcenter|vendor|model -> count
  for (const h of hosts) {
    const vendor = h.vendor || '미상';
    const model = h.model || '미상';
    byVendor[vendor] = (byVendor[vendor] || 0) + 1;
    byModel[`${vendor} ${model}`] = (byModel[`${vendor} ${model}`] || 0) + 1;
    const key = `${h.vcenterId}|${vendor}|${model}`;
    combo.set(key, (combo.get(key) || 0) + 1);
  }
  const items = [...combo.entries()].map(([k, count]) => {
    const [vcenterId, vendor, model] = k.split('|');
    return { vcenterId, vcenterName: vcName[vcenterId] || vcenterId, vendor, model, count };
  }).sort((a, b) => b.count - a.count);
  res.json({
    hosts: hosts.length,
    byVendor: Object.entries(byVendor).map(([vendor, count]) => ({ vendor, count })).sort((a, b) => b.count - a.count),
    byModel: Object.entries(byModel).map(([model, count]) => ({ model, count })).sort((a, b) => b.count - a.count),
    items,
  });
});

// ESXi version distribution + host list (optionally per vCenter).
api.get('/tools/esxi', requirePerm('tools'), (req, res) => {
  const snap = store.get();
  let hosts = snap.hosts;
  const allowed = scopedVcenterIds(req.user, snap);
  if (allowed) hosts = hosts.filter((h) => allowed.has(h.vcenterId));
  if (req.query.vcenterId) hosts = hosts.filter((h) => h.vcenterId === req.query.vcenterId);
  const map = new Map();
  for (const h of hosts) {
    const v = h.version || 'unknown';
    if (!map.has(v)) map.set(v, { version: v, count: 0 });
    map.get(v).count++;
  }
  res.json({
    scanned: hosts.length,
    versions: [...map.values()].sort((a, b) => b.count - a.count),
    items: hosts.map((h) => ({ host: h.name, vcenterId: h.vcenterId, cluster: h.cluster, version: h.version || 'unknown', build: h.build || '', connectionState: h.connectionState })),
  });
});

api.get('/tools/gpu', requirePerm('tools'), (req, res) => {
  const snap = store.get();
  res.json(buildGpuInventory(snap, req.query.vcenterId, scopedVcenterIds(req.user, snap)));
});

// GPU 사용량/인벤토리 JSON export — 집계 결과 그대로 파일로 내려받기.
api.get('/tools/gpu.json', requirePerm('tools'), (req, res) => {
  const snap = store.get();
  const data = buildGpuInventory(snap, req.query.vcenterId, scopedVcenterIds(req.user, snap));
  const body = JSON.stringify({ generatedAt: new Date().toISOString(), vcenterId: req.query.vcenterId || null, ...data }, null, 2);
  sendMaybeZip(res, `gpu-${todayStamp()}.json`, body, 'application/json; charset=utf-8');
});

// GPU 사용량/인벤토리 CSV export — 호스트별 한 행(모델·장수·모드·사용률·할당 VM).
api.get('/tools/gpu.csv', csvPerm, requirePerm('tools'), (req, res) => {
  const snap = store.get();
  const data = buildGpuInventory(snap, req.query.vcenterId, scopedVcenterIds(req.user, snap));
  const head = ['host', 'vcenter_id', 'cluster', 'gpu_model', 'gpu_count', 'mem_gb', 'mode', 'mode_breakdown', 'util_pct', 'util_source', 'assigned_vms'];
  const esc = (v) => { const s = guardCell(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }; // guardCell: 수식 인젝션 방어(= + - @)
  const lines = [head.join(',')];
  for (const r of data.items) {
    const breakdown = Object.entries(r.modes || {}).map(([m, n]) => `${m}:${n}`).join(' ');
    lines.push([r.host, r.vcenterId, r.cluster, r.model, r.count, r.memGB, r.mode, breakdown,
      r.utilPct == null ? '' : r.utilPct, r.utilSource || '', r.assignedVms].map(esc).join(','));
  }
  sendMaybeZip(res, `gpu-${todayStamp()}.csv`, '﻿' + lines.join('\r\n'), 'text/csv; charset=utf-8'); // BOM for Excel
});

// GPU 사용률 시계열 수집 메타 — '언제부터 데이터가 쌓였는지'(수집 시작/마지막/샘플 수).
// export 모달에서 사용자가 수집 시작 일시를 보고 전체/기간을 고르도록.
api.get('/tools/gpu/series-meta', requirePerm('tools'), async (req, res) => {
  try {
    const db = await getMetricsDb();
    // v2.675(운영 멈춤 후보): meta() 는 MIN·MAX·COUNT 를 한 문장으로 세어 gpu_util 원본 전부를 동기로 훑었다(창을 열 때마다 —
    //   합성 3,168만 행 2.3초). 기간은 단독 집계(인덱스 끝점), 표본 수는 6시간 조각으로 나눠 세고(양보) 5분 기억한다 —
    //   여러 사람이 창을 열어도 한 번만 센다(single-flight).
    const payload = await snapMemo('gpuSeriesMeta', 'gpuSeriesMeta|gpu_util', 5 * 60_000, async () => {
      const r = typeof db.metaRange === 'function' ? db.metaRange('gpu_util') : db.meta('gpu_util');
      const sampleCount = typeof db.countAsync === 'function' ? await db.countAsync('gpu_util') : Number(r.count || 0);
      return { collectedSince: r.firstTs, latestAt: r.lastTs, sampleCount };
    });
    res.json(payload);
  } catch { res.json({ collectedSince: null, latestAt: null, sampleCount: 0 }); }
});
api.get('/tools/gpu/export.csv', csvPerm, requirePerm('tools'), (req, res) => gpuSeriesExport(req, res, 'csv'));
api.get('/tools/gpu/export.json', csvPerm, requirePerm('tools'), (req, res) => gpuSeriesExport(req, res, 'json'));

// VM IP Ping(위임) — 중앙은 VM 사설 IP에 직접 못 가므로, 그 vCenter 담당 에이전트가
// ping을 대행한다. POST로 요청 큐잉 → 에이전트가 인출/실행/보고 → GET으로 녹/적 조회.
// 중앙이 직접 수집하는 vCenter(에이전트 없음)는 중앙이 직접 ping해 즉시 결과를 채운다.
api.post('/tools/ip-ping', requirePerm('tools'), async (req, res) => {
  const vcenterId = String(req.body?.vcenterId || '').trim();
  let ips = Array.isArray(req.body?.ips) ? req.body.ips.map((s) => String(s).trim()).filter(Boolean).slice(0, 16) : [];
  if (!vcenterId || !ips.length) return res.status(400).json({ ok: false, reason: 'vcenterId·ips가 필요합니다.' });
  // v2.322 보안 감사: 범위 밖 vCenter 로 위임 ping(범위 밖 에이전트가 임의 IP 도달성 프로빙)
  // 차단 — 단건 라우트 규칙대로 범위 밖은 404(존재 은닉). 전체 범위 계정은 무영향.
  if (!inUserScope(req.user, store.get(), vcenterId)) return res.status(404).json({ ok: false, reason: 'not found' });
  // v2.593(감사 AUTHZ-02): 범위만 보고 IP 는 무엇이든 받았다 — tools 계정이 중앙·엣지를 시켜 외부 IP·다른 법인
  //   VM IP·호스트명의 도달성을 캐볼 수 있었다(v2.322 가 막으려던 '임의 IP 도달성 프로빙' 의 남은 절반). 이 화면
  //   (VM 상세)이 보내는 것은 **그 vCenter 의 VM 에 수집된 IP** 뿐이므로 그 집합으로 좁히고, 뺀 개수를 밝힌다.
  const known = new Set();
  for (const v of store.get().vms || []) {
    if (v.vcenterId !== vcenterId) continue;
    if (v.ipAddress) known.add(String(v.ipAddress));
    for (const ip of v.ipAddresses || []) known.add(String(ip));
  }
  const rejected = ips.filter((ip) => !known.has(ip));
  ips = ips.filter((ip) => known.has(ip));
  if (!ips.length) return res.status(400).json({ ok: false, reason: '그 vCenter 의 VM 에서 수집된 IP 가 아닙니다.', rejected: rejected.length });
  const site = isSiteVcenter(store.get(), vcenterId);
  // 엣지 위임 vCenter 만 엣지 대행 큐에 올린다 — 중앙 직접 수집 vCenter 를 큐에 올리면 가져갈 엣지가 없다(v2.590 P11).
  if (site) enqueuePing(vcenterId, ips);
  if (config.dataSource !== 'mock') pingLocallyAndStore(vcenterId, ips, { direct: !site }).catch(() => {});
  res.json({ ok: true, queued: site ? ips.length : 0, direct: !site, rejected: rejected.length });
});
api.get('/tools/ip-ping', requirePerm('tools'), (req, res) => {
  const vcenterId = String(req.query.vcenterId || '').trim();
  const ips = String(req.query.ips || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!vcenterId || !ips.length) return res.status(400).json({ ok: false, reason: 'vcenterId·ips가 필요합니다.' });
  if (!inUserScope(req.user, store.get(), vcenterId)) return res.status(404).json({ ok: false, reason: 'not found' });
  res.json({ ok: true, results: getPingResults(vcenterId, ips) });
});

// v2.650: 호스트 한 대의 GPU 사용 요약 — 호스트 상세(EntityDetail)의 GPU 칸. 사용률·온도·메모리 할당/사용·VM별 행.
//   스냅샷·인메모리 오버레이만 읽는다(vCenter·게스트 왕복 0). 범위 밖 호스트는 존재를 숨긴다(404).
api.get('/tools/gpu/host', requirePerm('tools'), (req, res) => {
  const snap = store.get();
  const vcenterId = String(req.query.vcenterId || '');
  const id = String(req.query.id || '');
  const name = String(req.query.host || '');
  const h = (snap.hosts || []).find((x) => (id ? x.id === id : (x.name === name && (!vcenterId || x.vcenterId === vcenterId))));
  if (!h || !inUserScope(req.user, snap, h.vcenterId)) return res.status(404).json({ ok: false, reason: 'not found' });
  if (!(h.gpus || []).length) return res.json({ ok: true, hostId: h.id, gpus: 0 });
  const vms = (snap.vms || []).filter((v) => v.gpu && v.host === h.name && v.vcenterId === h.vcenterId);
  const guestByVm = new Map(getGuestGpuVms().map((g) => [g.vmId, g]));
  const sum = summarizeHostGpu(h, vms, guestByVm);
  res.json({ ok: true, hostId: h.id, host: h.name, vcenterId: h.vcenterId, ...sum, vms: sum.vms.slice(0, 200), vmsOmitted: Math.max(0, sum.vms.length - 200), activityRule: { busyUtilPct: BUSY_UTIL_PCT, heldMemPct: HELD_MEM_PCT } });
});

// GPU가 할당된 VM 목록 — 어떤 VM이 어떤 방식(vGPU/패스쓰루)·프로파일로 GPU를 쓰는지.
// 선택 필터: vcenterId, host, mode(vgpu|passthrough|mixed), model(호스트 GPU 모델).
api.get('/tools/gpu/vms', requirePerm('tools'), (req, res) => {
  const snap = store.get();
  // (vCenter, 호스트명) → GPU 모델 매핑(모델 필터용 — 이름 단독 키는 다른 vCenter 동명 호스트와 섞인다, VC2598-03)
  const hostModel = gpuHostModelMap(snap.hosts);
  const modelOf = (v) => hostModel.get(gpuHostKey(v.vcenterId, v.host)) || '';
  let vms = (snap.vms || []).filter((v) => v.gpu);
  const allowed = scopedVcenterIds(req.user, snap);
  if (allowed) vms = vms.filter((v) => allowed.has(v.vcenterId));
  if (req.query.vcenterId) vms = vms.filter((v) => v.vcenterId === req.query.vcenterId);
  if (req.query.host) vms = vms.filter((v) => v.host === req.query.host);
  if (req.query.model) vms = vms.filter((v) => modelOf(v) === req.query.model);
  if (req.query.mode) vms = vms.filter((v) => v.gpu.type === req.query.mode || (req.query.mode === 'vgpu' && v.gpu.vgpu) || (req.query.mode === 'passthrough' && v.gpu.passthrough));
  // 게스트 OS(nvidia-smi)에서 수집한 VM별 GPU 사용률/메모리 오버레이(패스쓰루 GPU는 ESXi가 못 봄).
  const guestByVm = new Map(getGuestGpuVms().map((g) => [g.vmId, g]));
  res.json({
    total: vms.length,
    vms: vms.map((v) => {
      // 전원 OFF VM은 사용률 계산/표시에서 제외(이전에 수집된 stale 값 무시).
      const g = v.powerState === 'POWERED_ON' ? guestByVm.get(v.id) : null;
      return {
        id: v.id, name: v.name, vcenterId: v.vcenterId, host: v.host, cluster: v.cluster,
        powerState: v.powerState, model: modelOf(v), gpu: v.gpu,
        guestUtilPct: g ? g.utilPct : null, guestUtilNA: g ? !!g.utilNA : false, guestMemPct: g ? (g.memUsedPct ?? null) : null, guestAt: g ? g.at : null,
        // v2.650: VRAM 절대량·온도·동작 판정·vGPU 할당 GB(프로파일에서 계산 — 해석 못 하면 null)
        guestMemUsedMB: g ? (g.memUsedMB ?? null) : null, guestMemTotalMB: g ? (g.memTotalMB ?? null) : null,
        guestTempC: g ? (g.tempC ?? null) : null,
        activity: v.powerState === 'POWERED_ON' ? gpuActivity(g).state : 'off',
        allocGB: vmVgpuAllocGB(v.gpu),
      };
    }).sort((a, b) => (a.vcenterId === b.vcenterId
      ? String(a.name || '').localeCompare(String(b.name || ''))
      : String(a.vcenterId || '').localeCompare(String(b.vcenterId || '')))).slice(0, 5000),
  });
});
}
