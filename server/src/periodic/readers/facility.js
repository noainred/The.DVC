/**
 * periodic/readers/facility.js — 설비 항목 리더(파트 장애 · 디스크 배드 섹터 · 흡기 온도 · PDU · 전력 · 베어메탈 · GPU · 아이실론 · 게스트 파티션 · 폴더 · 서버 인벤토리).
 * 저장된 DB · 스냅샷 · 메모리 상태만 읽는다 — iDRAC Redfish(디스크 배드 섹터 scan · lclog · probe) · SSH · 엣지 pull 은 부르지 않는다.
 * 베어메탈 사용률은 중앙이 직접 수집한 서버만 중앙에 있다(엣지 값은 엣지 파일에만 — 화면을 열 때 가져온다) — 그 사실을 근거에 적는다.
 */
import { numOrNull } from '../../util/numOrNull.js';
import { activeVcs, judge, rowsBasis, vcRow, dcRow, n, latest } from './common.js';

/** 파트 장애 — 지금 열린 장애(part_state). 법인은 그 엣지(agent)가 수집하는 vCenter 가 하나일 때만 붙인다(아니면 법인 미지정 행). */
export async function partFaults(ctx) {
  const { openFaults } = await import('../../partfault/db.js');
  let enabled = true;
  try { const st = await import('../../partfault/settings.js'); const s = st.loadPartFaultSettings?.() || st.loadSettings?.(); if (s && s.enabled === false) enabled = false; } catch { /* 모름 — 열린 장애로만 판정 */ }
  const open = await openFaults({ limit: 5000 });
  if (open == null) return { status: 'unknown', unknownReason: '파트 장애 DB 를 열지 못했습니다', rows: [] };
  const list = Array.isArray(open) ? open : (open.rows || []);
  if (!enabled && !list.length) return { status: 'unknown', unknownReason: '파트 장애 감시가 꺼져 있습니다(기본 꺼짐)', rows: [] };
  const byAgent = new Map();
  for (const f of list) {
    const a = byAgent.get(String(f.agent || '')) || { crit: 0, warn: 0, names: [] };
    if (f.state === 'fault') a.crit++; else a.warn++;
    if (a.names.length < 3) a.names.push(`${f.deviceName || ''} ${f.label || f.kind || ''}`.trim());
    byAgent.set(String(f.agent || ''), a);
  }
  let vcOfAgent = () => null;
  try {
    const { siteAgentByVcenter } = await import('../../bmusage/targets.js');
    const m = siteAgentByVcenter(ctx.snap.vcenters || []);
    const inv = new Map();
    for (const [vc, ag] of (m instanceof Map ? m : new Map(Object.entries(m || {})))) { const k = String(ag || '').toLowerCase(); inv.set(k, inv.has(k) ? null : vc); }
    vcOfAgent = (ag) => inv.get(String(ag || '').toLowerCase()) || null;
  } catch { /* 법인 귀속 없이 */ }
  const rows = [...byAgent.entries()].map(([ag, a]) => ({ ...(vcOfAgent(ag) ? { vc: vcOfAgent(ag) } : {}), status: judge(a), count: a.crit + a.warn, text: `${ag || '중앙'} 열린 장애 ${a.crit + a.warn}(장애 ${a.crit})${a.names.length ? ` — ${a.names.join(', ')}` : ''}` }));
  if (!rows.length) return { status: 'ok', count: 0, basis: '열린 파트 장애 없음', rows: activeVcs(ctx.snap).map((v) => vcRow(v.id, 'ok', 0, '열린 장애 없음')) };
  return { rows, count: list.length, basis: `열린 장애 ${list.length}건 · ${rowsBasis(rows, '수집처')}` };
}

/** 디스크 배드 섹터 — 기간 안에 새로 받은 배드 섹터 계열 기록(기준선 제외 · 메일과 같은 분류). */
export async function diskBad(ctx) {
  const { loadAll } = await import('../../diskbad/db.js');
  const { mailable } = await import('../../diskbad/notify.js');
  const { corpResolverNow } = await import('../../diskbad/jobs.js');
  const all = await loadAll();
  if (!all) return { status: 'unknown', unknownReason: '디스크 배드 섹터 DB 를 열지 못했습니다', rows: [] };
  if (!(all.servers || []).length) return { na: true, basis: '점검한 서버가 없습니다(자동 점검 꺼짐 · 기록 없음)' };
  const fresh = mailable((all.records || []).filter((r) => !r.baseline && numOrNull(r.receivedAt) != null && r.receivedAt >= ctx.from && r.receivedAt < ctx.to));
  const corpOf = corpResolverNow();
  const acc = new Map();
  for (const r of fresh) {
    const c = corpOf(r.agent, r.serverId);
    const k = c?.id ? String(c.id) : '';
    const a = acc.get(k) || { warn: 0, servers: new Set() };
    a.warn++; a.servers.add(`${r.agent}|${r.serverId}`);
    acc.set(k, a);
  }
  const rows = [...acc.entries()].map(([vc, a]) => ({ ...(vc ? { vc } : {}), status: 'warn', count: a.warn, text: `새 기록 ${a.warn}건 · 서버 ${a.servers.size}대` }));
  const lastScan = latest((all.servers || []).map((s) => s.lastScanAt ?? s.last_scan_at));
  return { rows, status: rows.length ? undefined : 'ok', count: fresh.length, basis: `점검 서버 ${n(all.servers.length)}대 · 기간 중 새 기록 ${n(fresh.length)}건`, asOf: lastScan };
}

/** 서버 흡기 온도 — roomTempReport(ASHRAE 구간). 그룹은 법인(DataCenter) 우선 · 없으면 vCenter. */
export async function inletTemp(ctx) {
  const { roomTempReport } = await import('../../idrac/roomTemp.js');
  const { analysisServersWithRemote } = await import('../../insights/analysisServers.js');
  const servers = analysisServersWithRemote(null);
  const r = roomTempReport(Array.isArray(servers) ? servers : (servers?.servers || []), { now: ctx.now });
  const MAP = { hot: 'crit', warn: 'warn', ok: 'ok', lowok: 'ok', cold: 'warn' };
  const knownVc = ctx.knownVc;
  const rows = (r?.groups || []).map((g) => {
    const st = g.status ? (MAP[g.status] || 'unknown') : 'unknown';
    const text = `흡기 평균 ${numOrNull(g.inlet?.avg) != null ? `${g.inlet.avg}°C` : '—'} · 최고 ${numOrNull(g.inlet?.max) != null ? `${g.inlet.max}°C` : '—'}${g.staleCount ? ` · 오래된 표본 ${g.staleCount}` : ''}`;
    return knownVc.has(String(g.id)) ? vcRow(String(g.id), st, null, text) : dcRow(g.id || null, st, null, text);
  });
  if (!rows.length) return { status: 'unknown', unknownReason: '흡기 온도 표본이 없습니다(iDRAC 미등록 · 센서 없음)', rows: [] };
  return { rows, basis: `서버 ${n(r?.totals?.servers)} · 값 있음 ${n(r?.totals?.withData)} · 센서 없음 ${n(r?.totals?.noSensor)} · ${rowsBasis(rows)}` };
}

/** PDU — 최신 스냅샷(중앙 + 엣지)에 임계 판정(evaluateSnapshot). 수집 실패는 확인 불가. */
export async function pdu(ctx) {
  const { localSnapshots } = await import('../../pdu/poller.js');
  const { edgePduSnapshots } = await import('../../central/pduEdge.js');
  const { evaluateSnapshot, loadThresholds } = await import('../../pdu/thresholds.js');
  const th = loadThresholds();
  const snaps = [...(localSnapshots() || []), ...(edgePduSnapshots() || [])];
  if (!snaps.length) return { na: true, basis: '등록된 PDU 가 없습니다' };
  const acc = new Map();
  for (const s of snaps) {
    const k = String(s.datacenterId || '');
    const a = acc.get(k) || { crit: 0, warn: 0, unknown: 0, total: 0 };
    a.total++;
    if (s.ok === false || s.stale === true) { a.unknown++; acc.set(k, a); continue; }
    const v = evaluateSnapshot(s, th) || [];
    if (v.some((x) => x.severity === 'critical')) a.crit++; else if (v.length) a.warn++;
    acc.set(k, a);
  }
  const rows = [...acc.entries()].map(([dc, a]) => dcRow(dc || null, judge(a), a.crit + a.warn, `PDU ${a.total} · 위험 ${a.crit} · 경고 ${a.warn}${a.unknown ? ` · 확인 불가 ${a.unknown}` : ''}`));
  return { rows, basis: `${th?.enabled === false ? '임계 판정 꺼짐 · ' : ''}${rowsBasis(rows)}` };
}

/** 소비 전력(정보) — iDRAC 측정 합계(지금). */
export async function power(ctx) {
  const { allMeasuredPower, vcPowerSkippedOf } = await import('../../idrac/service.js');
  const { unreadVcenterReasons } = await import('../../metrics/unreadVcenters.js');
  const { usageReadable } = await import('../../store.js');
  // 포탈의 다른 전력 합계(store.js · fleetInventory)와 같은 제외 — 점검중 · 수집 실패 · 보고가 오래된 vCenter 와 끊긴 호스트의 마지막 추정 전력은 '지금 값' 이 아니다.
  const vcSkip = { unread: unreadVcenterReasons(ctx.snap), hostReadable: usageReadable };
  const hosts = ctx.snap.hosts || [];
  const r = await allMeasuredPower({ hosts, ...vcSkip });
  const list = Array.isArray(r) ? r : (r?.items || r?.servers || []);
  let w = 0; let read = 0;
  for (const x of list) { const v = numOrNull(x.watts ?? x.powerWatts ?? x.currentWatts); if (v != null) { w += v; read++; } }
  const skipped = vcPowerSkippedOf(hosts, vcSkip);
  const skipText = skipped?.hosts ? ` · 못 읽은 vCenter · 끊긴 호스트 ${skipped.hosts.toLocaleString('ko-KR')}대는 합계에서 뺌` : '';
  if (!read) return { value: `측정된 서버가 없습니다${skipText}`, rows: [] };
  return { value: `${(w / 1000).toFixed(1)} kW · 측정 서버 ${read.toLocaleString('ko-KR')}대${list.length > read ? ` · 못 읽음 ${list.length - read}` : ''}${skipText}`, count: Math.round(w), rows: [] };
}

/** 베어메탈 사용률 — 이 포탈이 직접 수집한 서버의 최신 판정(buildPerfEntry). 켜지 않은 법인은 확인 불가가 아니라 대상 아님. */
export async function bmUsage(ctx) {
  const { loadBmUsageSettings } = await import('../../bmusage/settings.js');
  const s = loadBmUsageSettings();
  if (!s?.enabled) return { status: 'unknown', unknownReason: '베어메탈 사용률 수집이 꺼져 있습니다(기본 꺼짐)', rows: [] };
  const { latestUsage } = await import('../../bmusage/db.js');
  const { buildPerfEntry } = await import('../../bmusage/perfView.js');
  const rows0 = await latestUsage({ json: true });
  if (!rows0) return { status: 'unknown', unknownReason: '베어메탈 사용률 DB 를 열지 못했습니다', rows: [] };
  const MAP = { bottleneck: 'crit', saturated: 'crit', errors: 'warn', warn: 'warn', ok: 'ok', partial: 'ok', stale: 'unknown', unknown: 'unknown' };
  const acc = new Map();
  for (const row of rows0) {
    const e = buildPerfEntry({ row, hw: null, th: s.perf || {}, intervalMs: s.intervalMs, now: ctx.now });
    const st = MAP[e.verdict] || 'unknown';
    const k = String(row.vcenter_id || '');
    const a = acc.get(k) || { crit: 0, warn: 0, unknown: 0, total: 0 };
    a.total++; if (st === 'crit') a.crit++; else if (st === 'warn') a.warn++; else if (st === 'unknown') a.unknown++;
    acc.set(k, a);
  }
  const rows = [...acc.entries()].map(([vc, a]) => ({ ...(vc ? { vc } : {}), status: judge({ crit: a.crit, warn: a.warn, unknown: a.unknown >= a.total ? 1 : 0 }), count: a.crit + a.warn, text: `서버 ${a.total} · 병목 ${a.crit} · 주의 ${a.warn}${a.unknown ? ` · 오래됨 · 모름 ${a.unknown}` : ''}` }));
  return { rows, basis: `${rowsBasis(rows)} · 이 포탈이 직접 수집한 서버만(엣지 법인 값은 그 엣지에 있습니다)` };
}

/** 베어메탈 스토리지(정보) — 서버 수 · 사용률 합(임계가 모듈에 없어 판정하지 않는다). */
export async function bmStorage() {
  const { getBmLatest } = await import('../../bmstor/poller.js');
  const { listBmServers } = await import('../../bmstor/registry.js');
  const { aggregate } = await import('../../bmstor/agg.js');
  const servers = listBmServers();
  if (!servers.length) return { value: '등록된 베어메탈 스토리지 서버가 없습니다', rows: [] };
  const a = aggregate(servers, getBmLatest());
  const t = a?.total || {};
  return { value: `서버 ${n(t.servers)} · 읽음 ${n(t.ok)} · 실패 ${n(t.errors)} · 사용률 ${numOrNull(t.usedPct) != null ? `${t.usedPct}%` : '—'}`, rows: [] };
}

/** GPU 활동(정보) — 게스트 GPU VM 의 활동 상태(바쁨 · 붙들림 · 유휴). */
export async function gpu(ctx) {
  const { getGuestGpuVms } = await import('../../gpu/store.js');
  const { gpuActivity } = await import('../../gpu/activity.js');
  const vms = getGuestGpuVms() || [];
  if (!vms.length) return { value: 'GPU 게스트 기록이 없습니다', rows: [] };
  const acc = new Map();
  for (const g of vms) {
    const a = gpuActivity(g)?.state || 'unknown';
    const k = String(g.vcenterId || '');
    const o = acc.get(k) || { busy: 0, held: 0, idle: 0, unknown: 0 };
    o[a] = (o[a] || 0) + 1; acc.set(k, o);
  }
  const rows = [...acc.entries()].map(([vc, o]) => ({ ...(vc ? { vc } : {}), status: 'info', count: o.busy + o.held + o.idle + o.unknown, text: `바쁨 ${o.busy} · 붙들림 ${o.held} · 유휴 ${o.idle} · 모름 ${o.unknown}` }));
  const tot = [...acc.values()].reduce((x, o) => ({ busy: x.busy + o.busy, idle: x.idle + o.idle }), { busy: 0, idle: 0 });
  return { rows, value: `GPU VM ${n(vms.length)} · 바쁨 ${n(tot.busy)} · 유휴 ${n(tot.idle)}` };
}

/** 아이실론 디렉터리 사용량 조사 — 대상마다 상태(statusOfRow). 실패 · 인증 정지는 주의 · 오래됨 · 기록 없음은 확인 불가. */
export async function isilonDirusage(ctx) {
  const { targetRows } = await import('../../isidu/rows.js');
  const { statusOfRow } = await import('../../isidu/digestRules.js');
  const list = await targetRows();
  const rows0 = Array.isArray(list) ? list : (list?.rows || []);
  if (!rows0.length) return { na: true, basis: '조사 대상이 없습니다' };
  const per = rows0.map((t) => {
    const s = statusOfRow(t, ctx.now) || {};
    const st = s.tone === 'bad' || s.tone === 'warn' ? 'warn' : s.tone === 'ok' || s.tone === 'run' ? 'ok' : (s.key === 'off' ? 'ok' : 'unknown');
    return { dc: t.datacenterId || t.corp || null, status: st, text: `${t.name || t.id} ${s.text || s.key || ''}` };
  });
  const acc = new Map();
  for (const p of per) { const a = acc.get(p.dc || '') || { dc: p.dc, crit: 0, warn: 0, unknown: 0, total: 0, t: [] }; a.total++; if (p.status === 'warn') a.warn++; else if (p.status === 'unknown') a.unknown++; if (p.status !== 'ok' && a.t.length < 3) a.t.push(p.text); acc.set(p.dc || '', a); }
  const rows = [...acc.values()].map((a) => dcRow(a.dc, judge(a), a.warn, `대상 ${a.total} · 주의 ${a.warn} · 확인 불가 ${a.unknown}${a.t.length ? ` — ${a.t.join(' / ')}` : ''}`));
  return { rows, basis: rowsBasis(rows) };
}

/** 게스트 파티션 사용률 — overviewSummary(전체 범위). 95% 이상은 이상 · 임계 초과는 주의 · 수집이 꺼져 있으면 확인 불가. */
export async function guestPartition(ctx) {
  const { overviewSummary } = await import('../../guestpart/report.js');
  const r = await overviewSummary({ allowed: null, now: ctx.now });
  if (r?.collect && r.collect.enabled === false) return { status: 'unknown', unknownReason: '게스트 파티션 수집이 꺼져 있습니다', rows: [] };
  if (r?.collect && r.collect.dbAvailable === false) return { status: 'unknown', unknownReason: '게스트 디스크 DB 를 열지 못했습니다', rows: [] };
  const rows = (r?.rows || []).map((v) => {
    const st = judge({ crit: v.crit, warn: v.overVms, unknown: !(v.overVms) && v.stale ? 1 : 0 });
    return vcRow(v.vcenterId, st, numOrNull(v.overVms) ?? 0, `임계 초과 VM ${n(v.overVms)} · 파티션 ${n(v.overParts)} · 95% 이상 ${n(v.crit)} · 최고 ${numOrNull(v.maxPct) != null ? `${v.maxPct}%` : '—'}${v.unknownParts ? ` · 모름 ${n(v.unknownParts)}` : ''}${v.stale ? ' · 오래됨' : ''}`);
  });
  return { rows, basis: rowsBasis(rows) };
}

/** 폴더 사용량 Top-N(정보) — 대상별 마지막 조사. */
export async function dirUsage() {
  const { getDb } = await import('../../dirusage/db.js');
  const db = await getDb();
  if (!db) return { value: '폴더 사용량 DB 가 없습니다', rows: [] };
  const all = typeof db.latestAll === 'function' ? await db.latestAll() : [];
  const list = Array.isArray(all) ? all : [];
  if (!list.length) return { value: '조사 기록이 없습니다', rows: [] };
  return { value: `대상 ${list.length.toLocaleString('ko-KR')}개 · 마지막 조사 ${new Date(latest(list.map((x) => x.ts)) || 0).toISOString().slice(0, 10)}`, rows: [] };
}

/** 서버 인벤토리(정보) — 가상화 호스트 · 베어메탈 수. */
export async function fleetChange(ctx) {
  const { getFleetInventory } = await import('../../insights/fleetInventory.js');
  const r = await getFleetInventory(ctx.snap);
  const s = r?.summary || {};
  return { value: `가상화 호스트 ${n(s.virtualizationHosts)} · 베어메탈 ${n(s.bareMetal)}(법인 지정 ${n(s.bareMetalAssigned)} · 미지정 ${n(s.bareMetalUnassigned)})`, count: (numOrNull(s.virtualizationHosts) ?? 0) + (numOrNull(s.bareMetal) ?? 0), rows: [] };
}
