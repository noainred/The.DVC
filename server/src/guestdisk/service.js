/**
 * guestdisk/service.js — 게스트 디스크 회수 리포트: 수집·조회·CSV(v2.459).
 *
 * 수집은 export 가 쓰던 벌크 조회(collectDetails)를 그대로 재사용한다 — vCenter 1회 로그인으로
 * 그 vCenter 의 모든 VM guest.disk 를 한 번에 가져온다. VMware Tools 가 꺼진 VM 은 파티션이
 * 비어 오므로(관측 불가) 목록에서 제외한다(추정하지 않는다).
 */
import { store } from '../store.js';
import { loadVcenterConfig } from '../config.js';
import { collectDetails } from '../vcenter/vmExport.js';
import { parseGuestDisks } from '../vcenter/soapParse.js';
import { vmSummary, rankReclaim, usageTrend, reclaimAdvice, normUsageFactor } from './analyze.js';
import { commitCollection, listLatest, vmSeries, partSeries, latestOne, coverageByVcenter } from './db.js';
import { datacenterOfVcenter, listDatacenters } from '../datacenter/store.js';

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

const COLLECT_TIMEOUT_MS = Number(process.env.GUESTDISK_TIMEOUT_MS) || 120_000; // vCenter 1대 조회 상한

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} 타임아웃(${ms}ms)`)), ms); });
  return Promise.race([promise.finally(() => clearTimeout(t)), timeout]);
}

/**
 * 한 vCenter 의 게스트 디스크를 조회해 VM별 파티션 요약을 만든다(DB 저장은 호출부).
 * 반환: { vcenterId, vcenterName, vms:[{vmId,vmName,allocGB,usedGB,freeGB,ratioPct,partCount,parts}], total, withGuest }
 */
export async function collectVcenterGuestDisk(vcenterId) {
  const snap = store.get();
  const vc = (snap.vcenters || []).find((v) => v.id === vcenterId);
  const vcName = vc?.name || vcenterId;
  if (snap.source === 'mock') throw new Error('데모 모드 — 라이브 게스트 디스크 미조회');
  const vcCfg = loadVcenterConfig().vcenters.find((v) => v.id === vcenterId);
  if (!vcCfg) throw new Error('vCenter 접속 정보 없음');
  const vms = (snap.vms || []).filter((v) => v.vcenterId === vcenterId);
  const morefs = vms.map((v) => v.id.slice(vcenterId.length + 1)).filter(Boolean);
  if (!morefs.length) return { vcenterId, vcenterName: vcName, vms: [], total: 0, withGuest: 0 };
  const details = await withTimeout(collectDetails(vcCfg, morefs), COLLECT_TIMEOUT_MS, `게스트 디스크 조회(${vcName})`);
  const out = [];
  for (const vm of vms) {
    const props = details.get(vm.id.slice(vcenterId.length + 1)) || {};
    const parts = parseGuestDisks(props['guest.disk']);
    if (!parts.length) continue; // VMware Tools 미실행/미보고 — 관측 불가, 제외
    const s = vmSummary(parts);
    out.push({
      vmId: vm.id, vmName: vm.name || vm.id,
      allocGB: s.allocGB, usedGB: s.usedGB, freeGB: s.freeGB, ratioPct: s.ratioPct, partCount: s.partCount,
      parts: parts.map((p) => ({ path: p.path, capGB: p.capacityGB, usedGB: p.usedGB })),
    });
  }
  return { vcenterId, vcenterName: vcName, vms: out, total: vms.length, withGuest: out.length };
}

/** 한 vCenter 수집 + DB 커밋(폴러/수동 공용). */
export async function collectAndStore(vcenterId, { changeThresholdGB = 1 } = {}) {
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
  const rows = await listLatest(ids);
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
    return { ...r, corpId: m.corpId, corpName: m.corpName, region: m.region, cluster: clusterOf.get(r.vmId) || '(미지정)' };
  });
  // 사용률(%) 이하 필터 — 할당 대비 사용이 낮은(회수 여지가 큰) VM 만. 비율 null(할당 0)은 제외.
  // ★ 버그(v2.461~2.466): 미설정이면 maxRatioPct 는 null 인데 Number(null)===0 이라 isFinite(0)===true 로
  //   '문턱 0%' 필터가 조용히 돌아 사용량>0 인 VM 을 전부 제거했다(716대 수집돼도 목록 0대). null/''
  //   (미설정)은 반드시 필터를 건너뛰고, 명시적 0 만 '0% 이하' 필터로 취급한다.
  const mr = (maxRatioPct == null || maxRatioPct === '') ? NaN : Number(maxRatioPct);
  if (Number.isFinite(mr)) enriched = enriched.filter((r) => r.ratioPct != null && r.ratioPct <= mr);
  const totalReclaimGB = Math.round(enriched.reduce((s, r) => s + (r.freeGB || 0), 0) * 10) / 10;
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
  const coverage = await buildCoverage(ids, idSet, vcenterId);
  return { rows: enriched, totalReclaimGB, vmCount: enriched.length, collectedCount, maxFreeGB, clusters, coverage, minReclaimGB, maxRatioPct: Number.isFinite(mr) ? mr : null, usageFactor: uf, scoped: Boolean(allowed) };
}

/**
 * vCenter 별 커버리지 행 — 화면이 데이터 유무·수집원(direct/site)·신선도를 보이게 한다.
 * ids: 조회 대상 vCenterId 배열(null=무제한). idSet: Set(ids) 또는 null. vcenterId: 단일 선택(있으면 그것만).
 */
async function buildCoverage(ids, idSet, vcenterId) {
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
  const [vs0, ps] = await Promise.all([vmSeries(vmId, sinceTs), partSeries(vmId, sinceTs)]);
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
  const partitions = [...byPath.values()].map((e) => {
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
  const esc = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;         // 엑셀 수식 인젝션 가드
    if (/[",\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const head = cols.map((c) => esc(c[1])).join(',');
  const body = rows.map((r) => cols.map((c) => esc(r[c[0]])).join(',')).join('\n');
  return `﻿${head}\n${body}\n`;
}
