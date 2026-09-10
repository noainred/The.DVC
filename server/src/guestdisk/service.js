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
import { vmSummary, rankReclaim, usageTrend, reclaimAdvice } from './analyze.js';
import { commitCollection, listLatest, vmSeries, partSeries, latestOne } from './db.js';
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
export async function reclaimReport({ allowed = null, minReclaimGB = 5, maxRatioPct = null, vcenterId = null } = {}) {
  let ids = allowed ? [...allowed] : null;
  // 특정 vCenter 선택 — scope 우선: 허용 목록 안일 때만 좁힌다(범위 밖이면 빈 결과).
  if (vcenterId) ids = (allowed && !allowed.has(vcenterId)) ? [] : [vcenterId];
  const rows = await listLatest(ids);
  const ranked = rankReclaim(rows, { minReclaimGB });
  // 각 행에 그룹핑 축(법인=DataCenter · vCenter · 클러스터)을 붙인다 — 프론트가 선택 구분.
  const meta = buildVcMeta();
  const clusterOf = new Map();
  try { for (const v of (store.get().vms || [])) clusterOf.set(v.id, v.cluster || ''); } catch { /* */ }
  let enriched = ranked.rows.map((r) => {
    const m = meta(r.vcenterId);
    return { ...r, corpId: m.corpId, corpName: m.corpName, region: m.region, cluster: clusterOf.get(r.vmId) || '(미지정)' };
  });
  // 사용률(%) 이하 필터 — 할당 대비 사용이 낮은(회수 여지가 큰) VM 만. 비율 null(할당 0)은 제외.
  const mr = Number(maxRatioPct);
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
  return { rows: enriched, totalReclaimGB, vmCount: enriched.length, clusters, minReclaimGB, maxRatioPct: Number.isFinite(mr) ? mr : null, scoped: Boolean(allowed) };
}

/** 한 VM 의 파티션별 최신값 + 추이 판정(드릴다운). */
export async function vmDetail(vmId, { flatPerDayGB = 0.1 } = {}) {
  const latest = await latestOne(vmId);
  if (!latest) return null;
  const [vs, ps] = await Promise.all([vmSeries(vmId), partSeries(vmId)]);
  // 파티션별로 점을 모아 추이 판정.
  const byPath = new Map();
  for (const r of ps) {
    if (!byPath.has(r.path)) byPath.set(r.path, { path: r.path, points: [], capGB: r.capGB, usedGB: r.usedGB });
    const e = byPath.get(r.path);
    e.points.push({ ts: r.ts, usedGB: r.usedGB, capGB: r.capGB });
    e.capGB = r.capGB; e.usedGB = r.usedGB; // 최신값(ORDER BY path,ts)
  }
  const partitions = [...byPath.values()].map((e) => {
    const freeGB = Math.round(Math.max(0, e.capGB - e.usedGB) * 10) / 10;
    const trend = usageTrend(e.points, { flatPerDayGB });
    return { path: e.path, capGB: e.capGB, usedGB: e.usedGB, freeGB, trend, advice: reclaimAdvice(freeGB, trend.trend) };
  });
  const vmTrend = usageTrend(vs.map((p) => ({ ts: p.ts, usedGB: p.usedGB })), { flatPerDayGB });
  const freeGB = Math.round(Math.max(0, latest.allocGB - latest.usedGB) * 10) / 10;
  return { ...latest, freeGB, vmTrend, vmTrendSeries: vs, partitions };
}

/** CSV — 회수 목록(VM 1행). 수식 인젝션 가드 + BOM. rows 는 rankReclaim 결과. */
export function reclaimCsv(rows) {
  const cols = [
    ['corpName', '법인'], ['vcenterName', 'vCenter'], ['cluster', '클러스터'], ['vmName', 'VM'],
    ['allocGB', '할당(GB)'], ['usedGB', '사용(GB)'],
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
