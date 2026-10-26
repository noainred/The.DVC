/**
 * guestdisk/service.js — 게스트 디스크 회수 리포트: 수집·조회·CSV(v2.459).
 *
 * 수집은 export 가 쓰던 벌크 조회(collectDetails)를 그대로 재사용한다 — vCenter 1회 로그인으로
 * 그 vCenter 의 모든 VM guest.disk 를 한 번에 가져온다. VMware Tools 가 꺼진 VM 은 파티션이
 * 비어 오므로(관측 불가) 목록에서 제외한다(추정하지 않는다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { store } from '../store.js';
import { config, loadVcenterConfig } from '../config.js';
import { collectDetails } from '../vcenter/vmExport.js';
import { parseGuestDisks } from '../vcenter/soapParse.js';
import { vmSummary, rankReclaim, usageTrend, reclaimAdvice, normUsageFactor, sanitizeGuestDiskVms, vmOwnerByPrefix } from './analyze.js';
import { commitCollection, listLatest, vmSeries, partSeries, latestOne, coverageByVcenter, currentPartPaths, lastCollectTs, latestHoldMs, pruneOrphanVcenters } from './db.js';
import { datacenterOfVcenter, listDatacenters } from '../datacenter/store.js';
import { csvLine } from '../util/csv.js';
import { reqTimeoutMs } from '../agent/envTimeout.js';
import { demoGuestDiskVms } from '../mock/demo/users.js'; // v2.708 데모(mock 에서만)

/** vCenterId → { corpId, corpName, region } 매핑(법인=DataCenter 할당 + 스냅샷 region). */
function buildVcMeta() {
  const dcName = new Map();
  try { for (const d of listDatacenters()) dcName.set(d.id, d.name || d.id); } catch { /* 미설정 */ }
  const region = new Map();
  try { for (const v of (store.get().vcenters || [])) region.set(v.id, v.location?.region || ''); } catch { /* */ }
  return (vcenterId) => {
    let corpId = '';
    try { corpId = datacenterOfVcenter(vcenterId) || ''; } catch { corpId = ''; }
    return { corpId, corpName: corpId ? (dcName.get(corpId) || corpId) : '(미지정)', region: region.get(vcenterId) || '' };
  };
}

// v2.606 LEFT2606-04: 2^31 초과·음수면 setTimeout 이 1ms 가 되어 전 수집이 즉시 타임아웃이었다.
const COLLECT_TIMEOUT_MS = reqTimeoutMs(process.env.GUESTDISK_TIMEOUT_MS, 120_000, { max: 1_800_000 }); // vCenter 1대 조회 상한

// v2.598 T2598-02: 시한이 되면 결과를 포기하는 것에 더해 signal 을 abort 한다 — 조회가 신호를 받으면 남은 SOAP
// 왕복을 멈춘다(v2.417 규약). race 는 남긴다(신호를 읽지 않는 조회도 결과를 기다리지 않게).
export function withTimeout(run, ms, label) {
  const ac = new AbortController();
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => { ac.abort(); rej(new Error(`${label} 타임아웃(${ms}ms)`)); }, ms); });
  return Promise.race([run(ac.signal).finally(() => clearTimeout(t)), timeout]);
}

/**
 * 한 vCenter 의 게스트 디스크를 조회해 VM별 파티션 요약을 만든다(DB 저장은 호출부).
 * 반환: { vcenterId, vcenterName, vms:[{vmId,vmName,allocGB,usedGB,freeGB,ratioPct,partCount,parts}], total, withGuest }
 */
export async function collectVcenterGuestDisk(vcenterId) {
  const snap = store.get();
  const vc = (snap.vcenters || []).find((v) => v.id === vcenterId);
  const vcName = vc?.name || vcenterId;
  // v2.708: 데모(mock)는 게스트에 접속하지 않고 스냅샷 VM 에서 파티션을 합성한다(같은 정제를 거친다).
  if (snap.source === 'mock') return demoCollect(vcenterId, vcName, snap, Date.now());
  const vcCfg = loadVcenterConfig().vcenters.find((v) => v.id === vcenterId);
  if (!vcCfg) throw new Error('vCenter 접속 정보 없음');
  const vms = (snap.vms || []).filter((v) => v.vcenterId === vcenterId);
  const morefs = vms.map((v) => v.id.slice(vcenterId.length + 1)).filter(Boolean);
  if (!morefs.length) return { vcenterId, vcenterName: vcName, vms: [], total: 0, withGuest: 0 };
  const details = await withTimeout((signal) => collectDetails(vcCfg, morefs, { signal }), COLLECT_TIMEOUT_MS, `게스트 디스크 조회(${vcName})`);
  const raw = [];
  let partsUnknown = 0;   // v2.600(감사 LO2600-07): 여유 공간을 보고하지 않아 합계에서 뺀 파티션 수(vmSummary 가 센다)
  for (const vm of vms) {
    const props = details.get(vm.id.slice(vcenterId.length + 1)) || {};
    const parts = parseGuestDisks(props['guest.disk']);
    if (!parts.length) continue; // VMware Tools 미실행/미보고 — 관측 불가, 제외
    const s = vmSummary(parts);
    partsUnknown += s.partsUnknown || 0;
    raw.push({
      vmId: vm.id, vmName: vm.name || vm.id,
      allocGB: s.allocGB, usedGB: s.usedGB, freeGB: s.freeGB, ratioPct: s.ratioPct, partCount: s.partCount,
      parts: parts.map((p) => ({ path: p.path, capGB: p.capacityGB, usedGB: p.usedGB, ...(p.fs ? { fs: p.fs } : {}) })),   // v2.797 파일 시스템 종류
    });
  }
  // ⚠ v2.601(감사 RECENT2601-01): 중앙 수신 경로(routes/central.js /guest-disk)와 **같은 정제**를 거친다. 예전에는
  //   여유 공간을 보고하지 않은 파티션(usedGB:null — v2.600 LO2600-07)을 그대로 commitCollection 에 넘겼고, part_series.used_gb 가
  //   NOT NULL 이라 그 파티션 하나가 **그 vCenter 의 전 VM 커밋을 롤백**했다(매 주기). 정제는 그 파티션을 저장하지 않고 개수만
  //   센다 — VM 합계(allocGB·usedGB)는 vmSummary 가 이미 같은 파티션을 뺐으므로 일관된다. partCount 도 저장한 파티션 수가 된다.
  const out = sanitizeGuestDiskVms(raw);
  return { vcenterId, vcenterName: vcName, vms: out, total: vms.length, withGuest: out.length, ...(partsUnknown ? { partsUnknown } : {}) };
}

function demoCollect(vcenterId, vcName, snap, ts) {
  const vms = (snap.vms || []).filter((v) => v.vcenterId === vcenterId);
  const out = sanitizeGuestDiskVms(demoGuestDiskVms(vcenterId, vms, ts));
  return { vcenterId, vcenterName: vcName, vms: out, total: vms.length, withGuest: out.length, demo: true };
}

/**
 * v2.708 데모(mock) — 이 vCenter 의 적재 이력이 없으면 지난 30일을 하루 1점씩 먼저 채운다(추이·'증가 중 보류' 판정이 보이게).
 * 이력이 이미 있으면(재시작) 건드리지 않는다.
 */
async function demoBackfill(vcenterId, changeThresholdGB) {
  const snap = store.get();
  if (snap.source !== 'mock') return 0;
  if (await lastCollectTs([vcenterId])) return 0;
  const vcName = (snap.vcenters || []).find((v) => v.id === vcenterId)?.name || vcenterId;
  const now = Date.now();
  let n = 0;
  for (let d = 30; d >= 1; d--) {
    const ts = now - d * 86_400_000;
    const r = demoCollect(vcenterId, vcName, snap, ts);
    const c = await commitCollection(vcenterId, vcName, r.vms, { ts, changeThresholdGB });
    if (c?.ok) n++;
    await new Promise((res) => setImmediate(res));   // 하루치마다 양보(데모 백필이 이벤트 루프를 길게 막지 않게)
  }
  return n;
}

/**
 * v2.743(감사 VC-02): 알려진 vCenter id = 등록부 ∪ 스냅샷(status 무관 — 비활성·점검중·엣지 위임도 알려진 것이다). 회수 리포트의 '삭제된
 *   vCenter 행' 판정과 그 행의 정리(pruneOrphanGuestDisk)가 같은 집합을 쓴다(판정 한 벌).
 *   **판정할 수 없으면 null** — ① 등록부 파일(CONFIG_DIR/vcenters.json)이 있는데 읽지 못했다(loadVcenterConfig 는 그때 빈 목록이나 옛 위치의
 *   파일을 준다 — 그 목록으로 지우면 손상 한 번이 전 vCenter 의 게스트 디스크 행을 지운다. osScanner registryVcIds 와 같은 판단)
 *   ② 등록부도 스냅샷도 비었다(첫 병합 전·mock 첫 틱 — '아무 vCenter 도 없다' 를 근거로 전부 지우지 않는다).
 * @returns {Set<string>|null}
 */
export function knownVcenterIds(snap = store.get()) {
  return knownOf(snap).ids;
}

/** knownVcenterIds 본체 — 판정할 수 없는 이유('registry-unreadable' | 'no-known-vcenters')도 돌려준다. */
function knownOf(snap) {
  let reg;
  try {
    reg = loadVcenterConfig();
    const primary = path.join(config.configDir, 'vcenters.json');
    if (fs.existsSync(primary) && reg.file !== primary) return { ids: null, why: 'registry-unreadable' };
  } catch { return { ids: null, why: 'registry-unreadable' }; }
  const out = new Set();
  for (const v of reg?.vcenters || []) if (v && v.id != null && v.id !== '') out.add(String(v.id));
  for (const v of snap?.vcenters || []) if (v && v.id != null && v.id !== '') out.add(String(v.id));
  return out.size ? { ids: out, why: null } : { ids: null, why: 'no-known-vcenters' };
}

/**
 * v2.743(감사 VC-02): 등록부에서 지운 vCenter 의 최신 행을 정리한다(폴러의 보존 정리 틱이 부른다). 판정할 수 없으면 지우지 않고 사유를 돌려준다.
 * @returns {Promise<{ok:boolean, skipped?:string, vcenters?:string[], vcenterCount?:number, removedRows?:number}>}
 */
export async function pruneOrphanGuestDisk(snap = store.get()) {
  const k = knownOf(snap);
  if (!k.ids) return { ok: false, skipped: k.why };
  return pruneOrphanVcenters(k.ids);
}

/** 한 vCenter 수집 + DB 커밋(폴러/수동 공용). */
export async function collectAndStore(vcenterId, { changeThresholdGB = 1 } = {}) {
  if (store.get()?.source === 'mock') { try { await demoBackfill(vcenterId, changeThresholdGB); } catch (e) { console.warn(`[guestdisk] 데모 백필 실패(${vcenterId}): ${e.message}`); } }
  const r = await collectVcenterGuestDisk(vcenterId);
  const ts = Date.now();
  const commit = await commitCollection(r.vcenterId, r.vcenterName, r.vms, { ts, changeThresholdGB });
  return { ...r, commit };
}

/**
 * 회수 리포트 — vm_latest 를 scope 로 좁혀 회수 순위를 만든다.
 * allowed: Set<vcenterId> | null(무제한). opts: { minReclaimGB }
 */
export async function reclaimReport({ allowed = null, minReclaimGB = 5, maxRatioPct = null, vcenterId = null, usageFactor = 1 } = {}) {
  const uf = normUsageFactor(usageFactor);   // v2.482: 회수 = 할당 − 사용×배율
  let ids = allowed ? [...allowed] : null;
  // 특정 vCenter 선택 — scope 우선: 허용 목록 안일 때만 좁힌다(범위 밖이면 빈 결과).
  if (vcenterId) ids = (allowed && !allowed.has(vcenterId)) ? [] : [vcenterId];
  // v2.767(점검 R2-B2-02): 범위 계정에는 id 가 그 행의 vCenter 네임스페이스(`${vcenterId}:`)인 행만 — 수신 차단(central.js) 이전에 남의 VM id 로
  //   덮인 행이 남아 있어도(그 vCenter 의 다음 수집이 PK 로 되돌릴 때까지) 덮은 쪽 범위 목록·CSV 에 싣지 않는다.
  const rowsIn = await listLatest(ids);
  const known = knownVcenterIds();
  const knownArr = known ? [...known] : [];
  const ownRow = (r) => {
    const vc = String(r.vcenterId ?? ''); const id = String(r.vmId || '');
    if (!vc || !id.startsWith(`${vc}:`)) return false;
    const b = vmOwnerByPrefix(id, knownArr);   // 더 긴 등록 id 가 접두를 가로채면 그 vCenter 의 VM 이다
    return !b || b.length <= vc.length;
  };
  const rows0 = allowed ? rowsIn.filter(ownRow) : rowsIn;
  // v2.743(감사 VC-02 — 재현): **등록부·스냅샷 어디에도 없는 vCenter**(등록에서 지운 vCenter)의 행은 합계·목록·CSV 에 넣지 않고 개수로 밝힌다
  //   (예전에는 50일 전 행이 합계에 그대로 들어갔고 coverage 에는 그 vCenter 줄이 없었다). 행 정리는 폴러의 보존 정리 틱이 한다 — 그 전에도
  //   리포트가 거짓 합계를 내지 않게 여기서 먼저 뺀다. 알려진 vCenter 를 판정할 수 없으면(null) 예전처럼 전부 둔다(지우는 쪽으로 단정하지 않는다).
  //   범위 계정은 허용 vCenter(스냅샷에 있는 것)만 조회하므로 이 목록에 걸리지 않는다.
  const rows = known ? rows0.filter((r) => known.has(String(r.vcenterId))) : rows0;
  const orphanRows = rows0.length - rows.length;
  const orphanVcenters = orphanRows ? new Set(rows0.filter((r) => !known.has(String(r.vcenterId))).map((r) => String(r.vcenterId))).size : 0;
  // v2.743(감사 VC-02 — 보수적 판단): **등록된 vCenter 의 오래된 행**(수집 주기 × 3 — 부분 합 보류와 같은 경계)은 db.js 가 의도로 남기는 값이라
  //   (빈 수집 방어 '오래된 관측이 더 정직') 합계에서 빼지 않는다. 대신 행에 stale 표지를 달고 몇 대·몇 GB 인지 밝힌다 — 화면이 '지금 값이 아닐 수
  //   있다' 를 말한다(합계에서 조용히 빼면 수집이 꺼진 법인의 회수 후보가 통째로 사라진다).
  const staleAfterMs = latestHoldMs();
  const staleBefore = Date.now() - staleAfterMs;
  // 필터(최소 회수/사용률)와 무관하게 '수집된 VM 수'와 '가장 큰 회수여유'를 먼저 잰다 —
  // 목록이 비었을 때 화면이 '데이터 없음'인지 '필터 때문'인지 정직하게 가르게 한다.
  let collectedCount = 0; let maxFreeGB = 0;
  for (const r of rows) {
    collectedCount++;
    const f = Math.max(0, (Number(r.allocGB) || 0) - (Number(r.usedGB) || 0) * uf);
    if (f > maxFreeGB) maxFreeGB = f;
  }
  maxFreeGB = Math.round(maxFreeGB * 10) / 10;
  const ranked = rankReclaim(rows, { minReclaimGB, usageFactor: uf });
  // 각 행에 그룹핑 축(법인=DataCenter · vCenter · 클러스터)을 붙인다 — 프론트가 선택 구분.
  const meta = buildVcMeta();
  const clusterOf = new Map();
  try { for (const v of (store.get().vms || [])) clusterOf.set(v.id, v.cluster || ''); } catch { /* */ }
  let enriched = ranked.rows.map((r) => {
    const m = meta(r.vcenterId);
    const stale = Number.isFinite(Number(r.ts)) && Number(r.ts) < staleBefore;
    return { ...r, corpId: m.corpId, corpName: m.corpName, region: m.region, cluster: clusterOf.get(r.vmId) || '(미지정)', ...(stale ? { stale: true } : {}) };
  });
  // 사용률(%) 이하 필터 — 할당 대비 사용이 낮은(회수 여지가 큰) VM 만. 비율 null(할당 0)은 제외.
  // ★ 버그(v2.461~2.466): 미설정이면 maxRatioPct 는 null 인데 Number(null)===0 이라 isFinite(0)===true 로
  //   '문턱 0%' 필터가 조용히 돌아 사용량>0 인 VM 을 전부 제거했다(716대 수집돼도 목록 0대). null/''
  //   (미설정)은 반드시 필터를 건너뛰고, 명시적 0 만 '0% 이하' 필터로 취급한다.
  const mr = (maxRatioPct == null || maxRatioPct === '') ? NaN : Number(maxRatioPct);
  if (Number.isFinite(mr)) enriched = enriched.filter((r) => r.ratioPct != null && r.ratioPct <= mr);
  const totalReclaimGB = Math.round(enriched.reduce((s, r) => s + (r.freeGB || 0), 0) * 10) / 10;
  // v2.743(VC-02): 합계 중 오래된 관측에서 온 몫(필터를 지난 목록 기준 — 합계와 같은 집합).
  let staleRows = 0; let staleReclaimGB = 0;
  for (const r of enriched) if (r.stale) { staleRows += 1; staleReclaimGB += r.freeGB || 0; }
  staleReclaimGB = Math.round(staleReclaimGB * 10) / 10;
  // 콤보용 클러스터 목록 — **인벤토리 기준**(게스트 데이터가 없어도 vCenter 선택 시 채워지게).
  // scope 준수: ids(허용∩선택 vCenter) 안의 VM 클러스터만. ids=null 이면 무제한 계정.
  const idSet = ids ? new Set(ids) : null;
  const cl = new Set();
  try {
    for (const v of (store.get().vms || [])) {
      if (!v.cluster) continue;
      if (idSet && !idSet.has(v.vcenterId)) continue;
      cl.add(v.cluster);
    }
  } catch { /* 스냅샷 없음 */ }
  const clusters = [...cl].sort((a, b) => String(a).localeCompare(String(b)));
  // 커버리지 — 범위 내(또는 선택한) vCenter 각각의 데이터 유무·신선도·수집원(정직 표시용).
  // vm_latest 에 데이터가 있는 vCenter 만이 아니라 '보여야 할 모든 vCenter'를 기준으로 만든다:
  // 데이터가 0 인 vCenter 도 '왜 없나(엣지 push 대기 / Tools 미보고 / direct 미수집)'를 화면이 알린다.
  const coverage = await buildCoverage(ids, idSet, vcenterId, staleBefore);
  return { rows: enriched, totalReclaimGB, vmCount: enriched.length, collectedCount, maxFreeGB, clusters, coverage, minReclaimGB, maxRatioPct: Number.isFinite(mr) ? mr : null, usageFactor: uf, scoped: Boolean(allowed),
    staleRows, staleReclaimGB, staleAfterMs, orphanRows, orphanVcenters };
}

/**
 * vCenter 별 커버리지 행 — 화면이 데이터 유무·수집원(direct/site)·신선도를 보이게 한다.
 * ids: 조회 대상 vCenterId 배열(null=무제한). idSet: Set(ids) 또는 null. vcenterId: 단일 선택(있으면 그것만).
 */
async function buildCoverage(ids, idSet, vcenterId, staleBefore = null) {
  let cov = new Map();
  try { cov = await coverageByVcenter(ids); } catch { cov = new Map(); }
  const snap = store.get();
  const meta = buildVcMeta();
  // 보여야 할 vCenter 목록: 스냅샷의 vCenter 중 scope/선택 안에 드는 것.
  const list = (snap.vcenters || []).filter((v) => {
    if (vcenterId && v.id !== vcenterId) return false;
    if (idSet && !idSet.has(v.id)) return false;
    return true;
  });
  const out = list.map((v) => {
    const c = cov.get(v.id) || { vmCount: 0, lastTs: null };
    const m = meta(v.id);
    return {
      vcenterId: v.id,
      vcenterName: v.name || v.id,
      corpName: m.corpName,
      collectSource: v.collectSource === 'site' ? 'site' : 'direct', // site=엣지 수집(push), direct=중앙 직접
      vmCount: c.vmCount,
      lastTs: c.lastTs,
      // v2.743(VC-02): 마지막 적재가 수집 주기 × 3 보다 오래됐다(그 vCenter 의 행 전부가 '오래된 관측' 이다).
      ...(staleBefore != null && c.vmCount > 0 && c.lastTs != null && c.lastTs < staleBefore ? { stale: true } : {}),
    };
  });
  out.sort((a, b) => String(a.vcenterName).localeCompare(String(b.vcenterName)));
  return out;
}

/** 한 VM 의 파티션별 최신값 + 추이 판정(드릴다운). days>0 이면 그 구간만 조회(최근 N일). */
export async function vmDetail(vmId, { flatPerDayGB = 0.1, days = 0, usageFactor = 1 } = {}) {
  const latest = await latestOne(vmId);
  if (!latest) return null;
  const uf = normUsageFactor(usageFactor);   // v2.482: 목록과 같은 배율로 파티션/VM 여유 계산
  const d = Number(days);
  const sinceTs = Number.isFinite(d) && d > 0 ? Date.now() - d * 86_400_000 : 0;
  const [vs0, ps, curPaths] = await Promise.all([vmSeries(vmId, sinceTs), partSeries(vmId, sinceTs), currentPartPaths(vmId)]);
  // v2.590 P3: diff-저장은 '안 바뀐 동안' 행이 없다 — 마지막 점 이후 최신 수집 시각까지 값이 유지됐다는 사실을 끝점으로
  // 이어 준다(추이 판정·차트가 '마지막 변화 시점에서 끊긴 선' 이 아니라 지금까지의 평탄선을 본다).
  const tail = (pts, pick) => (pts.length && latest.ts && latest.ts > pts[pts.length - 1].ts ? [...pts, { ...pick(pts[pts.length - 1]), ts: latest.ts, carried: true }] : pts);
  const vs = tail(vs0, (p) => ({ allocGB: p.allocGB, usedGB: p.usedGB }));
  // 파티션별로 점을 모아 추이 판정.
  const byPath = new Map();
  for (const r of ps) {
    if (!byPath.has(r.path)) byPath.set(r.path, { path: r.path, points: [], capGB: r.capGB, usedGB: r.usedGB });
    const e = byPath.get(r.path);
    e.points.push({ ts: r.ts, usedGB: r.usedGB, capGB: r.capGB });
    e.capGB = r.capGB; e.usedGB = r.usedGB; // 최신값(ORDER BY path,ts)
  }
  // v2.591(3차 감사 R-G1): 현재 파티션 목록(part_last)에 없는 경로는 **제거된 파티션**이다 — 끝점 연장을 하지 않고
  // 회수 권고에서 뺀다(예전엔 언마운트된 /data 가 '축소 후보(사용량 평탄)' 로 권고됐다). 목록을 모르면(null·빈 Set) 판정하지 않는다.
  const knownCur = curPaths && curPaths.size > 0 ? curPaths : null;
  const partitions = [...byPath.values()].map((e) => {
    const removed = !!(knownCur && !knownCur.has(e.path));
    if (removed) {
      const trend = usageTrend(e.points, { flatPerDayGB });
      return { path: e.path, capGB: e.capGB, usedGB: e.usedGB, freeGB: null, trend, removed: true, lastSeenTs: e.points[e.points.length - 1]?.ts ?? null,
        advice: { safe: false, label: '제거됨(최근 수집에 없음) — 회수 대상 아님' } };
    }
    const freeGB = Math.round(Math.max(0, e.capGB - e.usedGB * uf) * 10) / 10;
    const trend = usageTrend(tail(e.points, (p) => ({ usedGB: p.usedGB, capGB: p.capGB })), { flatPerDayGB });
    return { path: e.path, capGB: e.capGB, usedGB: e.usedGB, freeGB, trend, advice: reclaimAdvice(freeGB, trend.trend) };
  });
  const vmTrend = usageTrend(vs.map((p) => ({ ts: p.ts, usedGB: p.usedGB })), { flatPerDayGB });
  const freeGB = Math.round(Math.max(0, latest.allocGB - latest.usedGB * uf) * 10) / 10;
  const ratioPct = latest.allocGB > 0 ? Math.round((latest.usedGB / latest.allocGB) * 1000) / 10 : null;
  return { ...latest, freeGB, ratioPct, usageFactor: uf, vmTrend, vmTrendSeries: vs, partitions, days: sinceTs ? d : null, sinceTs: sinceTs || null };
}

/** CSV — 회수 목록(VM 1행). 수식 인젝션 가드 + BOM. rows 는 rankReclaim 결과. */
export function reclaimCsv(rows) {
  const cols = [
    ['corpName', '법인'], ['vcenterName', 'vCenter'], ['cluster', '클러스터'], ['vmName', 'VM'],
    ['allocGB', '할당(GB)'], ['usedGB', '사용(GB)'], ['neededGB', '필요=사용×배율(GB)'],
    ['freeGB', '회수가능(GB)'], ['ratioPct', '사용률(%)'], ['partCount', '파티션수'],
  ];
  // v2.598 INJ-03: 수식 가드·따옴표는 util/csv.js csvLine 하나다 — 예전 사본은 앞의 탭·CR 가드가 없고
  //   단독 CR 을 따옴표로 감싸지 않았다(셀 경계가 깨진다). null 은 빈 칸(csvLine 의 guardCell 이 '' 로 만든다).
  const head = csvLine(cols.map((c) => c[1]));
  const body = rows.map((r) => csvLine(cols.map((c) => r[c[0]]))).join('\n');
  return `﻿${head}\n${body}\n`;
}
