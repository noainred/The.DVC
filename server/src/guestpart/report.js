/**
 * guestpart/report.js — 게스트 파티션 사용률 화면·메일·CSV 의 조회 조립(v2.749). DB(게스트 디스크 회수와 같은 guest-disk.db)와
 *   인벤토리 스냅샷을 읽고 판정은 rules.js(순수)에 맡긴다.
 *
 * 범위(scope)는 **다른 무엇보다 먼저** 좁힌다 — allowed(Set) 가 있으면 기억한 전체 목록에서 그 vCenter 의 행만 남긴 뒤 판정·요청 필터를 한다(보안 불변조건).
 *
 * '확인 불가' = 인벤토리의 게스트(템플릿 제외) 중 이번 최신 값에 파티션이 하나도 없는 VM — 전원 꺼짐·Tools 미실행·Tools 가 파티션을 보고하지 않음.
 *   초과에도 정상에도 넣지 않고 따로 센다. 파티션은 있는데 여유 공간을 보고하지 않은 것은 '값 모름 파티션' 으로 따로 센다.
 */
import { store } from '../store.js';
import { listPartLatest, partUsedAt, guestDiskDbStatus, latestHoldMs, onGuestDiskCommitted, vmPartLatest, lastCollectTs } from '../guestdisk/db.js';
import { load as loadGuestDiskSettings } from '../guestdisk/settings.js';
import { datacenterOfVcenter, listDatacenters } from '../datacenter/store.js';
import { evaluate, histogram, etaDays, CRIT_PCT, IGNORE_TEXT, thresholdFor, rulesOf, pctOf, ignoreReason, osOfPath } from './rules.js';
import { load as loadSettings } from './settings.js';
import { csvLine, CSV_BOM } from '../util/csv.js';
import { DAY_OFFSET_MIN } from '../util/dayKey.js';

const DAY = 86_400_000;
export const LIST_LIMIT = 300;
export const GROWTH_DAYS = 7;

/*
 * 파티션 최신 값 기억 — 화면 갱신마다 전 함대 행(5,850 VM × 파티션 약 1.6만 행 추정)을 DB 에서 다시 읽지 않는다.
 * 세대가 바뀌면 지운다: 수집 커밋(onGuestDiskCommitted)마다 세대를 올리고, 그 밖의 변경(삭제된 vCenter 정리)은 60초 안에 반영된다.
 * 범위는 기억한 전체 목록에서 JS 로 좁힌다(DB 를 다시 읽지 않는다 — 결과는 같다). 행 객체는 공유하므로 읽기만 한다(evaluate 는 복사한다).
 */
const PARTS_TTL_MS = 60_000;
let _gen = 0;
let _parts = null;   // { at, gen, rows }
onGuestDiskCommitted(() => { _gen++; });
async function partsFor(allowed) {
  if (!_parts || _parts.gen !== _gen || Date.now() - _parts.at > PARTS_TTL_MS) {
    const gen = _gen; const at = Date.now();   // 읽기 전에 잡는다 — 읽는 사이 커밋이 오면 다음 호출이 다시 읽는다
    _parts = { at, gen, rows: await listPartLatest(null) };
  }
  return allowed ? _parts.rows.filter((p) => allowed.has(p.vcenterId)) : _parts.rows;
}
export function _resetPartsCache() { _parts = null; }

const r1 = (n) => (n == null ? null : Math.round(Number(n) * 10) / 10);

function vcMeta(snap) {
  const dcName = new Map();
  try { for (const d of listDatacenters()) dcName.set(d.id, d.name || d.id); } catch { /* 미설정 */ }
  const byId = new Map();
  for (const v of snap?.vcenters || []) {
    let corpId = '';
    try { corpId = datacenterOfVcenter(v.id) || ''; } catch { corpId = ''; }
    byId.set(v.id, { id: v.id, name: v.name || v.id, region: v.location?.region || '', corp: corpId ? (dcName.get(corpId) || corpId) : '', site: v.collectSource === 'site' });
  }
  return byId;
}

/** 인벤토리 게스트 집계 — vCenter 별 { guests(템플릿 제외), off, vms: Map(vmId → {host, cluster, os, power}) }. */
function inventory(snap, allowed) {
  const per = new Map();
  for (const vm of snap?.vms || []) {
    if (!vm || vm.template) continue;
    if (allowed && !allowed.has(vm.vcenterId)) continue;
    let p = per.get(vm.vcenterId);
    if (!p) { p = { guests: 0, off: 0, vms: new Map() }; per.set(vm.vcenterId, p); }
    p.guests++;
    const off = String(vm.powerState || '').toUpperCase().includes('OFF');
    if (off) p.off++;
    p.vms.set(vm.id, { host: vm.host || '', cluster: vm.cluster || '', os: vm.guestOS || '', off, tools: vm.toolsStatus || '' });
  }
  return per;
}

/** 초과 행의 7일 증가(GB) — 기준 점이 없으면 null(관측 기간 부족). VM 단위면 파티션 합(하나라도 모르면 null). */
async function attachGrowth(ev, rows, now) {
  const vmIds = [...new Set(rows.map((r) => r.vmId))];
  const base = await partUsedAt(vmIds, now - GROWTH_DAYS * DAY);
  const partGrowth = (vmId, path, used) => { const b = base.get(`${vmId}\u0000${path}`); return b == null || used == null ? null : r1(used - b); };
  const partsOf = new Map();   // VM → 판정에 쓴 파티션(무시·값 모름 제외) — 행마다 전체 파티션을 훑지 않게 한 번에 묶는다
  if (ev.mode === 'vm') for (const p of ev.parts) { if (p.ignored || p.pct == null) continue; if (!partsOf.has(p.vmId)) partsOf.set(p.vmId, []); partsOf.get(p.vmId).push(p); }
  for (const r of rows) {
    if (ev.mode === 'vm') {
      const ps = partsOf.get(r.vmId) || [];
      const gs = ps.map((p) => partGrowth(p.vmId, p.path, p.usedGB));
      r.growth7dGB = gs.length && gs.every((g) => g != null) ? r1(gs.reduce((a, b) => a + b, 0)) : null;
    } else {
      r.growth7dGB = partGrowth(r.vmId, r.path, r.usedGB);
    }
    r.etaDays = etaDays(r.freeGB, r.growth7dGB);
  }
}

function ignoredSummary(parts) {
  const by = {}; let win = 0; let lnx = 0; let total = 0;
  for (const p of parts) {
    if (!p.ignored) continue;
    total++; by[p.ignored] = (by[p.ignored] || 0) + 1;
    if (p.os === 'win') win++; else if (p.os === 'lnx') lnx++;
  }
  return { total, win, lnx, byReason: Object.entries(by).map(([code, count]) => ({ code, text: IGNORE_TEXT[code] || code, count })).sort((a, b) => b.count - a.count) };
}

function collectState(parts, allowed) {
  const gd = loadGuestDiskSettings();
  const db = guestDiskDbStatus();
  return {
    enabled: !!gd.enabled, intervalHours: gd.intervalHours, dbAvailable: !!db.available,
    holdMs: latestHoldMs(), empty: parts.length === 0, scoped: !!allowed,
  };
}

/**
 * 전체(또는 범위 안) 개요.
 * @param {{allowed:Set|null, thr?:number|null, mode?:string|null, vcenterId?:string|null, q?:string, os?:string, limit?:number, now?:number, all?:boolean}} o
 *   all=true 면 목록 상한 없이(CSV·메일).
 */
export async function overview({ allowed = null, thr = null, mode = null, vcenterId = null, q = '', os = 'all', limit = LIST_LIMIT, now = Date.now(), all = false } = {}) {
  const settings = loadSettings();
  const snap = store.get();
  const meta = vcMeta(snap);
  const parts = await partsFor(allowed);
  const ev = evaluate(parts, settings, { thrOverride: thr, mode });
  const inv = inventory(snap, allowed);
  // vCenter 별 집계
  const per = new Map();
  const vcOf = (id) => { let x = per.get(id); if (!x) { x = { reportedVms: new Set(), overVms: new Set(), overParts: 0, crit: 0, maxPct: null, unknownParts: 0, ignoredParts: 0, lastTs: 0, thr: null }; per.set(id, x); } return x; };
  for (const p of ev.parts) {
    const x = vcOf(p.vcenterId);
    x.reportedVms.add(p.vmId); x.lastTs = Math.max(x.lastTs, p.ts || 0); x.thr = p.thr;
    if (p.ignored) { x.ignoredParts++; continue; }
    if (p.pct == null) { x.unknownParts++; continue; }
    if (x.maxPct == null || p.pct > x.maxPct) x.maxPct = p.pct;
    if (p.over) { x.overParts++; if (p.crit) x.crit++; }
  }
  for (const v of ev.vms.values()) if (v.over) { vcOf(v.vcenterId).overVms.add(v.vmId); if (ev.mode === 'vm' && v.crit) vcOf(v.vcenterId).crit++; }
  const holdMs = latestHoldMs();
  const vcIds = new Set([...meta.keys()].filter((id) => !allowed || allowed.has(id)));
  for (const id of per.keys()) vcIds.add(id);
  const vcenters = [...vcIds].map((id) => {
    const m = meta.get(id) || { id, name: id, region: '', corp: '', site: false };
    const x = per.get(id);
    const iv = inv.get(id) || { guests: 0, off: 0, vms: new Map() };
    const reported = x ? x.reportedVms.size : 0;
    let offNotReported = 0;
    for (const [vmId, v] of iv.vms) if (v.off && !(x && x.reportedVms.has(vmId))) offNotReported++;
    return { id, name: m.name, region: m.region, corp: m.corp, site: m.site,
      guests: iv.guests, reported, notReported: Math.max(0, iv.guests - reported), offNotReported,
      overVms: x ? x.overVms.size : 0, overParts: x ? x.overParts : 0, crit: x ? x.crit : 0, maxPct: x ? x.maxPct : null,
      unknownParts: x ? x.unknownParts : 0, ignoredParts: x ? x.ignoredParts : 0,
      lastTs: x && x.lastTs ? x.lastTs : null, stale: !!(x && x.lastTs && now - x.lastTs > holdMs),
      thr: settings.vcThresholds[id] ?? null };
  }).sort((a, b) => b.overVms - a.overVms || (b.maxPct ?? -1) - (a.maxPct ?? -1) || a.name.localeCompare(b.name));

  // 초과 목록(필터는 범위 안에서만)
  const ql = String(q || '').trim().toLowerCase();
  const pass = (r) => (!vcenterId || r.vcenterId === vcenterId) && (os === 'all' || os === r.os) && (!ql || String(r.vmName).toLowerCase().includes(ql) || String(r.path || '').toLowerCase().includes(ql));
  let rows;
  if (ev.mode === 'vm') {
    const osOfVm = new Map();
    for (const p of ev.parts) if (!osOfVm.has(p.vmId)) osOfVm.set(p.vmId, p.os);
    rows = [...ev.vms.values()].filter((v) => v.over).map((v) => ({ vmId: v.vmId, vmName: v.vmName, vcenterId: v.vcenterId, vcenterName: meta.get(v.vcenterId)?.name || v.vcenterName,
      os: osOfVm.get(v.vmId) || 'other', path: null, partCount: v.known, capGB: v.capGB, usedGB: v.usedGB, freeGB: r1(v.capGB - v.usedGB), pct: v.pct, crit: v.crit, thr: v.thr, ts: v.ts })).filter(pass);
  } else {
    rows = ev.parts.filter((p) => p.over).map((p) => ({ vmId: p.vmId, vmName: p.vmName, vcenterId: p.vcenterId, vcenterName: meta.get(p.vcenterId)?.name || p.vcenterName,
      os: p.os, path: p.path, capGB: r1(p.capGB), usedGB: r1(p.usedGB), freeGB: r1(p.capGB - p.usedGB), pct: p.pct, crit: p.crit, thr: p.thr, ts: p.ts })).filter(pass);
  }
  rows.sort((a, b) => b.pct - a.pct || a.freeGB - b.freeGB);
  const total = rows.length;
  const shown = all ? rows : rows.slice(0, Math.max(1, limit));
  await attachGrowth(ev, shown, now);
  const overVmSet = new Set(rows.map((r) => r.vmId));
  const sumGuests = vcenters.reduce((a, v) => a + v.guests, 0);
  const sumNot = vcenters.reduce((a, v) => a + v.notReported, 0);
  return {
    mode: ev.mode, thr: thr ?? null, defaultThr: settings.threshold, now, offsetMin: DAY_OFFSET_MIN, growthDays: GROWTH_DAYS, critPct: CRIT_PCT,
    kpi: {
      guests: sumGuests, reported: vcenters.reduce((a, v) => a + v.reported, 0), notReported: sumNot,
      offNotReported: vcenters.reduce((a, v) => a + v.offNotReported, 0),
      overVms: overVmSet.size, overParts: ev.mode === 'part' ? total : ev.parts.filter((p) => overVmSet.has(p.vmId) && !p.ignored && p.pct != null && p.pct >= p.thr).length,
      crit: rows.filter((r) => r.crit).length, soon: shown.filter((r) => r.etaDays != null && r.etaDays < 30).length,
      unknownParts: vcenters.reduce((a, v) => a + v.unknownParts, 0),
    },
    vcenters, rows: shown, total, limited: !all && total > shown.length,
    ignored: ignoredSummary(ev.parts),
    collect: collectState(parts, allowed),
  };
}

/**
 * 한 vCenter 의 게스트별 전 파티션. 범위 밖이면 null(라우트가 404 — 존재 은닉).
 * onlyOver=false 면 보고한 VM 전부(상한 2,000).
 */
export async function vcenterDetail(vcenterId, { allowed = null, thr = null, mode = null, onlyOver = true, now = Date.now() } = {}) {
  const id = String(vcenterId || '');
  if (!id || (allowed && !allowed.has(id))) return null;
  const settings = loadSettings();
  const snap = store.get();
  const meta = vcMeta(snap);
  const parts = await partsFor(new Set([id]));
  if (!meta.has(id) && !parts.length) return null;
  const m = meta.get(id) || { id, name: parts[0]?.vcenterName || id, region: '', corp: '', site: false };
  const ev = evaluate(parts, settings, { thrOverride: thr, mode });
  const inv = inventory(snap, new Set([id])).get(id) || { guests: 0, off: 0, vms: new Map() };
  const byVm = new Map();
  for (const p of ev.parts) {
    let v = byVm.get(p.vmId);
    if (!v) {
      const iv = inv.vms.get(p.vmId) || {};
      const sv = ev.vms.get(p.vmId);
      v = { vmId: p.vmId, vmName: p.vmName, host: iv.host || '', cluster: iv.cluster || '', guestOS: iv.os || '', over: !!sv?.over, crit: !!sv?.crit,
        pct: sv?.pct ?? null, maxPct: sv?.maxPct ?? null, ts: p.ts, parts: [] };
      byVm.set(p.vmId, v);
    }
    v.parts.push({ path: p.path, os: p.os, capGB: r1(p.capGB), usedGB: r1(p.usedGB), freeGB: p.capGB == null || p.usedGB == null ? null : r1(p.capGB - p.usedGB),
      pct: p.pct, ignored: p.ignored, ignoredText: p.ignored ? IGNORE_TEXT[p.ignored] || p.ignored : '', over: p.over || (ev.mode === 'vm' && !!v.over && !p.ignored && p.pct != null), unknown: !!p.unknown });
  }
  const allVms = [...byVm.values()];
  for (const v of allVms) v.parts.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
  const sortKey = (v) => (ev.mode === 'vm' ? v.pct : v.maxPct) ?? -1;
  allVms.sort((a, b) => sortKey(b) - sortKey(a) || a.vmName.localeCompare(b.vmName));
  const overVms = allVms.filter((v) => v.over);
  const list = (onlyOver ? overVms : allVms).slice(0, 2000);
  // 초과 파티션의 7일 증가·가득 참 예상
  const overRows = [];
  for (const v of list) for (const p of v.parts) if (p.over && p.path != null) overRows.push(Object.assign(p, { vmId: v.vmId }));
  if (overRows.length) {
    const base = await partUsedAt([...new Set(overRows.map((r) => r.vmId))], now - GROWTH_DAYS * DAY);
    for (const r of overRows) {
      const b = base.get(`${r.vmId}\u0000${r.path}`);
      r.growth7dGB = b == null || r.usedGB == null ? null : r1(r.usedGB - b);
      r.etaDays = etaDays(r.freeGB, r.growth7dGB);
      delete r.vmId;
    }
  }
  // 클러스터별
  const cl = new Map();
  for (const v of allVms) { const k = v.cluster || '(클러스터 모름)'; const c = cl.get(k) || { name: k, total: 0, over: 0 }; c.total++; if (v.over) c.over++; cl.set(k, c); }
  let offNotReported = 0;
  for (const [vmId, v] of inv.vms) if (v.off && !byVm.has(vmId)) offNotReported++;
  const lastTs = parts.reduce((a, p) => Math.max(a, p.ts || 0), 0) || null;
  return {
    vcenter: { ...m, lastTs, stale: !!(lastTs && now - lastTs > latestHoldMs()), thr: settings.vcThresholds[id] ?? null },
    mode: ev.mode, thr: thr ?? null, defaultThr: settings.threshold, effectiveThr: ev.parts[0]?.thr ?? (thr ?? settings.vcThresholds[id] ?? settings.threshold),
    now, offsetMin: DAY_OFFSET_MIN, growthDays: GROWTH_DAYS,
    kpi: { guests: inv.guests, reported: allVms.length, notReported: Math.max(0, inv.guests - allVms.length), offNotReported,
      overVms: overVms.length, overParts: ev.parts.filter((p) => p.over).length,
      crit: ev.parts.filter((p) => !p.ignored && p.pct != null && p.pct >= CRIT_PCT).length,
      critFreeGB: r1(ev.parts.filter((p) => !p.ignored && p.pct != null && p.pct >= CRIT_PCT).reduce((a, p) => a + (p.capGB - p.usedGB), 0)),
      unknownParts: ev.parts.filter((p) => !p.ignored && p.pct == null).length },
    histogram: histogram(ev.parts),
    clusters: [...cl.values()].sort((a, b) => b.over - a.over || b.total - a.total),
    vms: list, total: (onlyOver ? overVms : allVms).length, onlyOver: !!onlyOver,
    ignored: ignoredSummary(ev.parts),
    collect: collectState(parts, allowed),
  };
}

/**
 * v2.750 VM 상세 '게스트 파티션 사용량'(순수). rec = guestdisk/db.js vmPartLatest 결과, vcenterId = **스냅샷의** vCenter.
 *   수집 행의 vCenter 가 스냅샷과 다르면(옮겨진 VM 의 옛 행) 이 VM 의 값으로 쓰지 않는다 — 다른 vCenter 의 옛 값을 지금 값처럼 보이지 않게.
 *   값을 모르는 파티션(여유 공간 미보고)은 사용률·여유를 null 로(0 이 아니다). 무시 규칙에 걸린 파티션도 보여 주되 사유를 단다(경보에서만 빠진다).
 *   정렬: 사용률 높은 순, 모르는 값은 뒤로.
 */
export function buildVmPartitions(rec, settings, { vcenterId, vmName = '' } = {}) {
  const vm = rec?.vm && String(rec.vm.vcenterId) === String(vcenterId) ? rec.vm : null;
  const thr = thresholdFor(vcenterId, settings);
  if (!vm) return { collectedAt: null, partial: false, thr, parts: [] };
  const rules = rulesOf(settings?.rules);
  const parts = (rec.parts || []).map((p) => {
    const known = !p.unknown && p.capGB != null && p.usedGB != null;
    const pct = known ? pctOf(p.usedGB, p.capGB) : null;
    const code = ignoreReason({ path: p.path, capGB: p.capGB, usedGB: p.usedGB, vmName }, rules);
    return {
      path: p.path, os: osOfPath(p.path), capGB: p.capGB, usedGB: known ? p.usedGB : null,
      freeGB: known ? Math.round(Math.max(0, p.capGB - p.usedGB) * 10) / 10 : null, pct, unknown: !known,
      over: pct != null && pct >= thr, ignored: code ? (IGNORE_TEXT[code] || code) : null,
    };
  });
  parts.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || String(a.path).localeCompare(String(b.path)));
  // v2.785(GH H-B1): 시각은 값의 원천(part_latest — 이번 수집)의 것이다. vm_latest 는 부분 합 보류(partialHeld)·partialStale 로
  //   직전 온전한 행(옛 ts)을 다시 넣으므로 그 ts 를 쓰면 이번 값에 '수집 N시간 전'·'최근 수집이 실패했을 수 있습니다' 가 거짓으로 붙는다.
  //   partial 은 vm_latest 합계의 표지라 그대로 둔다(보류 합계는 온전한 값 — 값 모르는 파티션은 행마다 '값 모름' 으로 이미 보인다).
  const partTs = (rec.parts || []).map((p) => Number(p.ts)).filter((t) => Number.isFinite(t) && t > 0);
  const collectedAt = partTs.length ? Math.max(...partTs) : vm.ts;
  return { collectedAt, partial: vm.partial, thr, parts };
}

/** v2.750 VM 상세 — 한 VM 의 게스트 파티션(라우트가 범위를 먼저 검사한 뒤 부른다). */
export async function vmPartitions(vm, { now = Date.now() } = {}) {
  const rec = await vmPartLatest(vm.id);
  const gd = loadGuestDiskSettings();
  return {
    ok: true, vmId: vm.id, dbAvailable: rec != null, now, offsetMin: DAY_OFFSET_MIN, critPct: CRIT_PCT,
    collect: { enabled: !!gd.enabled, intervalHours: gd.intervalHours },
    vcenterLastTs: rec ? await lastCollectTs([vm.vcenterId]) : null,
    ...buildVmPartitions(rec, loadSettings(), { vcenterId: vm.vcenterId, vmName: vm.name }),
  };
}

/** CSV(초과 목록 전체). 빈 칸은 0 이 아니라 빈 값. 수식 가드 + BOM. */
export function overCsv(r) {
  const head = ['vCenter', 'VM', 'OS', '파티션', '할당(GB)', '사용(GB)', '남은 용량(GB)', '사용률(%)', '임계(%)', `${r.growthDays}일 증가(GB)`, '가득 참 예상(일)', '수집 시각'];
  const osText = { win: 'Windows', lnx: 'Linux', other: '기타' };
  const at = (t) => { if (!t) return ''; const d = new Date(t + r.offsetMin * 60_000); return d.toISOString().slice(0, 16).replace('T', ' '); };
  const lines = [csvLine(head)];
  for (const x of r.rows) {
    lines.push(csvLine([x.vcenterName, x.vmName, osText[x.os] || '', x.path ?? `파티션 ${x.partCount ?? ''}개 합계`, x.capGB ?? '', x.usedGB ?? '', x.freeGB ?? '', x.pct ?? '', x.thr ?? '',
      x.growth7dGB ?? '', x.etaDays ?? '', at(x.ts)]));
  }
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}
