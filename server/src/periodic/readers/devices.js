/**
 * periodic/readers/devices.js — vSphere 밖 장비 항목 리더(스토리지 어레이 · 증가량 · SAN 스위치 · SAN 스토리지 성능 · PowerScale · CVP · IP 관리 · VM DNS).
 * 이 장비들의 '법인' 은 DataCenter(법인 등록) id 다 — 행을 { dc } 로 주면 assemble 이 그 법인의 vCenter 로 붙인다.
 * 저장된 스냅샷 · DB · 이력만 읽는다(장비 호출 금지). SAN 점검 이력(recordRun)은 쓰지 않는다 — 보고서는 읽기만.
 */
import { numOrNull } from '../../util/numOrNull.js';
import { judge, rowsBasis, dcRow, n, latest } from './common.js';
import { periodicProvider } from '../providers.js';

const STORAGE_WARN_PCT = 80;   // 스토리지 사용량 보고 ACTION_RULE(warn 80 · crit 90) — 아래 리더는 그 상수를 읽는다(여기 값은 모듈을 못 읽을 때만)
const STORAGE_CRIT_PCT = 90;

/** 같은 법인(dc)의 행을 한 줄로 합친다(가장 나쁜 판정 · 수 더하기 · 글 이어 붙이기). */
function mergeByDc(list) {
  const m = new Map();
  for (const r of list) {
    const k = r.dc || '';
    const a = m.get(k) || { dc: r.dc || null, crit: 0, warn: 0, unknown: 0, ok: 0, count: 0, texts: [] };
    a[r.status] = (a[r.status] || 0) + 1;
    a.count += r.count || 0;
    if (r.status !== 'ok' && a.texts.length < 4) a.texts.push(r.text);
    m.set(k, a);
  }
  return [...m.values()].map((a) => dcRow(a.dc, judge(a), a.count, `${a.crit + a.warn + a.unknown + a.ok}대 — 이상 ${a.crit} · 주의 ${a.warn}${a.unknown ? ` · 확인 불가 ${a.unknown}` : ''}${a.texts.length ? ` · ${a.texts.join(' / ')}` : ''}`));
}

/** 스토리지 어레이 상태 · 사용률 — 최신 스냅샷(중앙 직접 + 엣지 push). 수집 실패 · 오래됨은 확인 불가. */
export async function arrayHealth(ctx) {
  const { latestMapByDevice } = await import('../../storage/latestSnapshots.js');
  const { localSnapshots } = await import('../../storage/store.js');
  const { edgeStorageSnapshots } = await import('../../central/storageEdge.js');
  const { listDevices } = await import('../../storage/registry.js');
  const { STORAGE_STALE_MS } = await import('../../power/total.js');
  let rule = { warnPct: STORAGE_WARN_PCT, critPct: STORAGE_CRIT_PCT };
  try { rule = (await import('../../storage/usageInsights.js')).ACTION_RULE || rule; } catch { /* 기본 */ }
  const devices = listDevices().filter((d) => d && d.enabled !== false);
  if (!devices.length) return { na: true, basis: '등록된 스토리지 장비가 없습니다' };
  const latestMap = latestMapByDevice([localSnapshots(), edgeStorageSnapshots()]);
  const per = devices.map((d) => {
    const s = latestMap.get?.(d.id) || latestMap[d.id] || null;
    const name = d.name || d.id;
    if (!s) return { dc: d.datacenterId, status: 'unknown', text: `${name} 수집 기록 없음` };
    const at = numOrNull(s.collectedAt) ?? numOrNull(s.reportedAt);
    if (s.ok === false) return { dc: d.datacenterId, status: 'unknown', text: `${name} 수집 실패` };
    if (at == null || ctx.now - at > STORAGE_STALE_MS) return { dc: d.datacenterId, status: 'unknown', text: `${name} 값이 오래됨` };
    const unhealthy = numOrNull(s.nodes?.unhealthy) ?? 0; const alerts = numOrNull(s.alerts?.unresolved) ?? 0; const pct = numOrNull(s.capacity?.pct);
    const st = judge({ crit: unhealthy + (pct != null && pct >= rule.critPct ? 1 : 0), warn: alerts + (pct != null && pct >= rule.warnPct ? 1 : 0) });
    return { dc: d.datacenterId, status: st, count: st === 'ok' ? 0 : 1, text: `${name}${pct != null ? ` ${pct}%` : ''}${unhealthy ? ` · 비정상 노드 ${unhealthy}` : ''}${alerts ? ` · 미해결 경보 ${alerts}` : ''}` };
  });
  const rows = mergeByDc(per);
  return { rows, basis: `장비 ${devices.length}대 · ${rowsBasis(rows)} · 용량 ${rule.warnPct}% 주의 · ${rule.critPct}% 이상` };
}

/** 스토리지 증가량 · 소진 예상 — 스토리지 사용량 주간 보고표 + 조치 규칙(usageInsights) 그대로. */
export async function storageGrowth(ctx) {
  const { loadUsageReport } = await import('../../storage/usageData.js');
  const { buildInsights, ACTION_RULE } = await import('../../storage/usageInsights.js');
  const rep = await loadUsageReport({ gran: 'week', count: 8, admin: true, now: ctx.now });
  if (!rep || rep.ok === false) return { status: 'unknown', unknownReason: `스토리지 사용량 보고표를 만들지 못했습니다${rep?.registryError ? `(등록부: ${String(rep.registryError).slice(0, 80)})` : ''}`, rows: [] };
  const ins = buildInsights(rep, { includeResources: false, rule: ACTION_RULE });
  const per = [];
  for (const e of ins.entities || []) {
    if (e.kind !== 'device') continue;
    const pct = numOrNull(e.trend?.cur?.pct);
    const w90 = numOrNull(e.w90);
    const st = pct == null ? 'unknown' : pct >= ACTION_RULE.critPct ? 'crit' : (pct >= ACTION_RULE.warnPct || (w90 != null && w90 <= ACTION_RULE.horizonWeeks)) ? 'warn' : 'ok';
    per.push({ dc: e.datacenterId || e.device?.datacenterId, status: st, count: st === 'ok' ? 0 : 1, text: `${e.name || e.deviceId}${pct != null ? ` ${pct}%` : ''}${e.eta90 ? ` · 90% ${e.eta90}` : ''}` });
  }
  if (!(ins.kpi?.registered > 0)) return { na: true, basis: '등록된 스토리지 장비가 없습니다' };
  for (const m of ins.missing || []) per.push({ dc: m.datacenterId || null, status: 'unknown', text: `${m.name || m.deviceId} ${m.why || '이력 없음'}` });
  const rows = mergeByDc(per);
  return { rows, basis: `${ins.weekLabel || ''} 기준 · 장비 ${ins.kpi?.devices ?? '—'}대 · ${ACTION_RULE.warnPct}% 주의 · ${ACTION_RULE.critPct}% 이상 · ${ACTION_RULE.horizonWeeks}주 안 ${ACTION_RULE.critPct}% 도달 전망은 주의`, detail: (ins.actions || []).slice(0, 10).map((a) => `${a.name || a.deviceId} ${numOrNull(a.trend?.cur?.pct) ?? '—'}% ${a.eta90 || ''}`) };
}

/** SAN 스위치 — 최신 스냅샷(중앙 직접 · 엣지 push 중 늦은 것)에 월간 점검 판정(checkDevice) · 포트 판정(checkPorts). 이력에 기록하지 않는다. */
async function sanResults(ctx) {
  if (ctx.cache.has('san')) return ctx.cache.get('san');
  const { listDevices } = await import('../../sanswitch/registry.js');
  const { getSnapshot } = await import('../../sanswitch/store.js');
  const { edgeSanSwitchSnapshotFor } = await import('../../central/sanSwitchEdge.js');
  const { getBaseline } = await import('../../sanswitch/errBaseline.js');
  const { checkDevice, checkPorts } = await import('../../sanswitch/healthCheck.js');
  const out = [];
  for (const d of listDevices().filter((x) => x && x.enabled !== false)) {
    const a = getSnapshot(d.id); const b = edgeSanSwitchSnapshotFor(d.id);
    const snap = !a ? b : !b ? a : ((numOrNull(b.collectedAt) ?? 0) > (numOrNull(a.collectedAt) ?? 0) ? b : a);
    let dev = null; let ports = null; let err = '';
    if (snap) {
      const baseline = getBaseline(d.id);
      try { dev = checkDevice(snap, { baseline }); } catch (e) { err = String(e?.message || e).slice(0, 80); }
      try { ports = checkPorts(snap, { baseline }); } catch (e) { err = err || String(e?.message || e).slice(0, 80); }
    }
    out.push({ d, snap, dev, ports, err });
  }
  ctx.cache.set('san', out);
  return out;
}
const SAN_STATUS = { ok: 'ok', warn: 'warn', bad: 'crit', unknown: 'unknown' };
export async function sanMonthly(ctx) {
  const list = await sanResults(ctx);
  if (!list.length) return { na: true, basis: '등록된 SAN 스위치가 없습니다' };
  const per = list.map(({ d, snap, dev, err }) => {
    const name = d.name || d.id;
    if (!snap) return { dc: d.datacenterId, status: 'unknown', text: `${name} 스냅샷 없음` };
    if (!dev) return { dc: d.datacenterId, status: 'unknown', text: `${name} 판정 실패${err ? `(${err})` : ''}` };
    const st = SAN_STATUS[dev.overall] || 'unknown';
    return { dc: d.datacenterId, status: st, count: st === 'ok' ? 0 : 1, text: `${name} ${dev.overall}${dev.uncheckedCount ? ` · 확인 못 한 항목 ${dev.uncheckedCount}` : ''}` };
  });
  const rows = mergeByDc(per);
  return { rows, basis: `스위치 ${list.length}대 · ${rowsBasis(rows)} · 확인 못 한 항목은 정상으로 세지 않음`, asOf: latest(list.map((x) => x.snap?.collectedAt)) };
}
export async function sanPorts(ctx) {
  const list = await sanResults(ctx);
  if (!list.length) return { na: true, basis: '등록된 SAN 스위치가 없습니다' };
  const per = list.map(({ d, snap, ports }) => {
    const name = d.name || d.id;
    if (!snap || !ports) return { dc: d.datacenterId, status: 'unknown', text: `${name} 포트 판정 없음` };
    const c = ports.counts || {};
    const st = judge({ crit: c.bad, warn: c.warn, unknown: ports.complete === false && !(c.bad || c.warn) ? 1 : 0 });
    return { dc: d.datacenterId, status: st, count: (c.bad || 0) + (c.warn || 0), text: `${name} 포트 이상 ${n(c.bad)} · 주의 ${n(c.warn)}${ports.portsOmitted ? ` · 생략 ${ports.portsOmitted}` : ''}` };
  });
  const rows = mergeByDc(per);
  return { rows, basis: `스위치 ${list.length}대 · ${rowsBasis(rows)}` };
}

/** SAN 스토리지 성능(월간 보고 판정) — 판정 이력 DB 의 어레이별 마지막 판정(이 기간 안). */
export async function sanStoragePerf(ctx) {
  const { checkHistoryOverview, listCheckRuns } = await import('../../sanswitch/storageCheckHistory.js');
  const days = Math.max(1, Math.ceil((ctx.to - ctx.from) / 86_400_000) + 1);
  const ov = await checkHistoryOverview({ days, now: ctx.to });
  if (!ov) return { status: 'unknown', unknownReason: 'SAN 스토리지 판정 이력 DB 를 열지 못했습니다', rows: [] };
  const arrays = ov.arrays || [];
  if (!arrays.length) return { status: 'unknown', unknownReason: '기간 안에 SAN 스토리지 성능 판정 기록이 없습니다(판정 이력은 중앙 알림 틱이 남깁니다)', rows: [] };
  const per = [];
  for (const a of arrays) {
    const runs = await listCheckRuns(a.key, a.dc || '', 1);
    const r = runs?.runs?.[0] || runs?.[0] || null;
    const st = SAN_STATUS[r?.overall] || 'unknown';
    per.push({ dc: a.dc || null, status: st, count: st === 'ok' ? 0 : 1, text: `${a.name || a.key} ${r?.overall || '기록 없음'}` });
  }
  const rows = mergeByDc(per);
  return { rows, basis: `어레이 ${arrays.length}대 · ${rowsBasis(rows)}` };
}

/** PowerScale 장비 점검 — 저장된 점검 실행의 장비 종합 판정(8일 넘으면 그 모듈이 확인 불가로). */
export async function psInspect(ctx) {
  const { buildInspectModel } = await import('../../storage/inspect/view.js');
  const { loadSettings } = await import('../../storage/inspect/schedule.js');
  let th = null; try { th = loadSettings()?.thresholds || null; } catch { th = null; }
  const m = await buildInspectModel({ now: ctx.now, admin: false, thresholds: th, withItems: false });
  const devs = m?.devices || [];
  if (!devs.length) return { na: true, basis: '점검 대상 PowerScale 장비가 없습니다' };
  const per = devs.map((d) => {
    const st = SAN_STATUS[d.summary?.overall] || 'unknown';
    return { dc: d.corp || null, status: st, count: st === 'ok' ? 0 : 1, text: `${d.name || d.id} ${d.summary?.overall || '모름'}${d.run?.staleDays != null ? ` · ${d.run.staleDays}일 전 점검` : ''}` };
  });
  const rows = mergeByDc(per);
  return { rows, basis: `장비 ${devs.length}대 · ${rowsBasis(rows)}` };
}

/** CVP — 저장된 장비 행 · 열린 장애로 개요(buildCvpOverview — 화면과 같은 함수). */
export async function cvp(ctx) {
  const { listServers } = await import('../../cvp/registry.js');
  const { loadSettings } = await import('../../cvp/settings.js');
  const cdb = await import('../../cvp/db.js');
  const { buildCvpOverview, rowOwnerOf, freshnessBounds } = await import('../../cvp/overview.js');
  const { listDatacenters } = await import('../../datacenter/store.js');
  const servers = listServers();
  if (!servers.length) return { na: true, basis: '등록된 CVP 가 없습니다' };
  const settings = loadSettings();
  const { rows: dev0, unavailable } = await cdb.listDeviceRows();
  if (unavailable) return { status: 'unknown', unknownReason: 'CVP DB 를 열지 못했습니다', rows: [] };
  const own = rowOwnerOf(servers);
  const { staleMs } = freshnessBounds(settings.intervalMs);
  const faults = await cdb.listOpenFaults().catch(() => ({ rows: [] }));
  const traffic = await cdb.trafficByDevice({ staleMs }).catch(() => ({ rows: [] }));
  let dcs = []; try { dcs = listDatacenters().map((d) => ({ id: String(d.id), name: String(d.name || d.id) })); } catch { dcs = []; }
  const ov = buildCvpOverview({ devices: (dev0 || []).filter(own), servers, datacenters: dcs, intervalMs: settings.intervalMs, highPct: 80,
    openFaults: (faults.rows || []).filter(own), traffic: (traffic.rows || []).filter(own), events: [], eventsTruncated: false });
  const rows = (ov.corps || []).map((c) => {
    const h = c.health || {};
    const st = judge({ crit: (h.bad || 0) + (c.openFaultsFault || 0), warn: (h.warn || 0) + (c.openFaultsWarn || 0), unknown: (h.unknown || 0) && !(h.ok || 0) ? 1 : 0 });
    return dcRow(c.corpId || null, st, (h.bad || 0) + (h.warn || 0), `장비 ${n(c.devices)}대 · 이상 ${n(h.bad)} · 주의 ${n(h.warn)} · 확인 불가 ${n(h.unknown)} · 열린 장애 ${n(c.openFaults)}`);
  });
  return { rows, basis: `CVP ${servers.length}대 · ${rowsBasis(rows)}` };
}

/** IP 관리 — IP 관리 정기 보고와 같은 모델(gatherReportModel): 중복 · 가득 찬 대역 · 스캔 공백. */
export async function ipam(ctx) {
  const { loadReportSettings, gatherReportModel } = await import('../../ipam/report.js');
  const { reportOf } = await import('../../ipam/reportRules.js');
  const r = loadReportSettings() || reportOf(null);
  const m = gatherReportModel(r, ctx.now);
  const rows = (m?.corps || []).filter((c) => !c.mock || ctx.snap?.source === 'mock').map((c) => {
    const t = c.totals || {};
    const gap = c.scanGap ? 1 : 0;
    const st = judge({ warn: (t.dup || 0) + (t.full || 0), unknown: !(t.ips > 0) && gap ? 1 : 0 });
    return dcRow(c.id || null, st, (t.dup || 0) + (t.full || 0), `IP ${n(t.ips)} · 중복 ${n(t.dup)} · 가득 찬 대역 ${n(t.full)} / ${n(t.subnets)}${gap ? ' · 스캔 공백' : ''}`);
  });
  return { rows, basis: `${rowsBasis(rows)} · 가득 찬 대역 기준 ${r.fullPct}%` };
}

/** VM DNS — 화면과 같은 분석(라우트 공급자 · 시스템 계정). */
export async function vmDns(ctx) {
  const p = periodicProvider('vm-dns');
  if (!p) return { status: 'unknown', unknownReason: 'VM DNS 분석기를 쓸 수 없습니다(라우트 공급자 미등록)', rows: [] };
  const r = await p();
  const k = r?.kpis || {};
  const rows = (r?.vcenters || []).map((v) => {
    const st = judge({ warn: (v.unapprovedVms || 0), unknown: (v.vms || 0) > 0 && (v.reported || 0) === 0 ? 1 : 0 });
    return { vc: String(v.id), status: st, count: v.unapprovedVms || 0, text: `VM ${n(v.vms)} · 승인 안 된 DNS ${n(v.unapprovedVms)}${v.unknown ? ` · 모름 ${n(v.unknown)}` : ''}${v.notCollected ? ` · 미수집 ${n(v.notCollected)}` : ''}` };
  });
  return { rows, basis: `${rowsBasis(rows)} · 공인 DNS ${n(k.publicVms)} · 불일치 ${n(k.mismatchVms)} · 단일 DNS ${n(k.singleDnsVms)}` };
}
