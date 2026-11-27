/**
 * periodic/readers/vsphere.js — vCenter · 호스트 · VM 항목 리더(인벤토리 스냅샷 · 그 스냅샷에 실린 구성 점검 값 · vmtrack DB · 인증서 캐시만 읽는다).
 * 판정은 각 기능의 함수를 그대로 부른다(computeHealthReport · hostCfgSummaryByVc · analyzeVmHygiene · analyzeClusters · n1Groups · analyzeDatastores ·
 * storagePathsSummaryByVc · contentionSummaryByVc · computeCompliance · analyzeCoreLicense · licenseExpiryStatus · certStatus). 법인 행은 vCenter 마다 자른 스냅샷으로 낸다.
 */
import { numOrNull } from '../../util/numOrNull.js';
import { sliceVc, activeVcs, vcNameMap, vcUnreadReason, n, judge, rowsBasis, vcRow } from './common.js';

/* ── 일일 헬스체크 절(1~7) — vCenter 마다 computeHealthReport 를 한 번씩(회차 안에서 공유) ── */
async function healthByVc(ctx) {
  if (ctx.cache.has('health')) return ctx.cache.get('health');
  const { computeHealthReport } = await import('../../reports/healthReport.js');
  const { loadDailyReportSettings } = await import('../../reports/dailyReport.js');
  let s = {};
  try { s = loadDailyReportSettings() || {}; } catch { s = {}; }
  const out = new Map();
  for (const v of activeVcs(ctx.snap)) {
    out.set(String(v.id), computeHealthReport(sliceVc(ctx.snap, v.id), { now: ctx.now, snapshotAgeDays: s.snapshotAgeDays, dsWarnPct: s.dsWarnPct }));
  }
  const res = { byVc: out, settings: { snapshotAgeDays: numOrNull(s.snapshotAgeDays) ?? 3, dsWarnPct: numOrNull(s.dsWarnPct) ?? 85 } };
  ctx.cache.set('health', res);
  return res;
}
function fromHealthSection(key, { itemText } = {}) {
  return async (ctx) => {
    const h = await healthByVc(ctx);
    const rows = [];
    const detail = [];
    let total = 0;
    for (const [vc, rep] of h.byVc) {
      const sec = (rep.sections || []).find((x) => x.key === key);
      if (!sec) continue;
      total += numOrNull(sec.count) ?? 0;
      const why = sec.status === 'unknown' ? (sec.detail || '확인하지 못한 부분이 있습니다') : '';
      rows.push(vcRow(vc, sec.status, numOrNull(sec.count), `${sec.label} ${n(sec.count)}건${why ? ` · ${why}` : ''}`));
      for (const x of (sec.items || []).slice(0, 3)) if (detail.length < 20) detail.push(`${vcNameMap(ctx.snap).get(vc) || vc} — ${itemText ? itemText(x) : (x.name || x.entity || x.vmName || '')}`);
    }
    return { rows, count: total, basis: `${rowsBasis(rows)} · 해당 ${n(total)}건`, detail };
  };
}

export const vcReach = fromHealthSection('vcenters', { itemText: (x) => `${x.name || x.id} ${x.error ? `(${String(x.error).slice(0, 80)})` : ''}` });
export const hostState = fromHealthSection('hosts', { itemText: (x) => `${x.name || ''} ${x.connectionState || ''}` });
export const dsUsage = fromHealthSection('datastores', { itemText: (x) => `${x.name || ''} ${numOrNull(x.usagePct) != null ? `${x.usagePct}%` : ''}` });
export const snapshotAge = fromHealthSection('snapshots', { itemText: (x) => `${x.name || x.vmName || ''}${numOrNull(x.ageDays) != null ? ` ${x.ageDays}일` : ''}` });
export const vcAlarms = fromHealthSection('alarms', { itemText: (x) => `${x.entity || ''} ${String(x.message || '').slice(0, 80)}` });
export const vmTools = fromHealthSection('tools', { itemText: (x) => x.name || '' });

/** 고아 VM(일일 헬스체크 orphaned 절) + 좀비 리포트의 회수 가능 용량(근거에만). */
export async function zombies(ctx) {
  const base = await fromHealthSection('orphaned', { itemText: (x) => `${x.name || ''} ${x.connectionState || ''}` })(ctx);
  try {
    const { computeZombies } = await import('../../reports/zombies.js');
    const z = computeZombies(ctx.snap, { now: ctx.now })?.summary || {};
    base.basis += ` · 전원 꺼진 VM ${n(z.poweredOffCount)}대 · 회수 가능 ${numOrNull(z.reclaimableGB) != null ? `${Math.round(z.reclaimableGB).toLocaleString('ko-KR')} GB` : '—'}`;
  } catch { /* 근거 보강만 — 판정은 위 절 */ }
  return base;
}

/** ESXi 호스트 구성 점검 — 법인 줄(hostCfgSummaryByVc) 그대로. */
export async function hostHygiene(ctx) {
  const { hostCfgSummaryByVc } = await import('../../hostcfg/analyze.js');
  const vcs = new Set(activeVcs(ctx.snap).map((v) => String(v.id)));
  const sm = hostCfgSummaryByVc(sliceVc(ctx.snap, vcs), { now: ctx.now, vcName: vcNameMap(ctx.snap), topN: 3 });
  const rows = (sm.rows || []).filter((r) => vcs.has(String(r.vcenterId))).map((r) => {
    const unk = (numOrNull(r.outOfJudgment) ?? 0);
    const st = judge({ crit: r.crit, warn: r.warn, unknown: r.hosts > 0 ? unk : 0 });
    return vcRow(r.vcenterId, st, (r.crit || 0) + (r.warn || 0), `문제 호스트 이상 ${n(r.crit)} · 주의 ${n(r.warn)} / ${n(r.hosts)}대${unk ? ` · 판정 밖 ${n(unk)}대(미수집 · 끊김)` : ''}`);
  });
  return { rows, basis: rowsBasis(rows) };
}

/** VM 구성 점검 — analyzeVmHygiene 의 법인 줄. */
export async function vmHygiene(ctx) {
  const { analyzeVmHygiene } = await import('../../vmhygiene/analyze.js');
  const { loadVmHygieneSettings } = await import('../../vmhygiene/settings.js');
  const s = loadVmHygieneSettings();
  const res = analyzeVmHygiene(ctx.snap.vms || [], s, { vcName: vcNameMap(ctx.snap), now: ctx.now });
  const by = new Map((res.vcenters || []).map((v) => [String(v.vcenterId), v]));
  const rows = activeVcs(ctx.snap).map((v) => {
    const r = by.get(String(v.id));
    if (!r) return vcRow(v.id, vcUnreadReason(v) ? 'unknown' : 'ok', 0, vcUnreadReason(v) || 'VM 없음');
    const st = judge({ crit: r.crit, warn: r.warn, unknown: r.vms > 0 && r.notCollected >= r.vms ? 1 : 0 });
    return vcRow(v.id, st, (r.crit || 0) + (r.warn || 0), `발견 VM 이상 ${n(r.crit)} · 주의 ${n(r.warn)} / ${n(r.vms)}대${r.notCollected ? ` · 미수집 ${n(r.notCollected)}대` : ''}`);
  });
  return { rows, basis: `${rowsBasis(rows)}${s?.unreadable ? ' · VM 구성 점검 설정을 못 읽어 기본 기준으로 판정' : ''}` };
}

/** 클러스터 HA · DRS(analyzeClusters) + N+1(n1Groups). */
export async function clusterCheck(ctx) {
  const { analyzeClusters } = await import('../../clustercfg/analyze.js');
  const { n1Groups } = await import('../../clustercfg/n1.js');
  const { usageReadable } = await import('../../store.js');
  const res = analyzeClusters(ctx.snap.vcenters || [], ctx.snap.hosts || [], {});
  const n1 = n1Groups(ctx.snap.hosts || [], usageReadable);
  const acc = new Map();
  const get = (vc) => { let a = acc.get(vc); if (!a) { a = { crit: 0, warn: 0, unknown: 0, clusters: 0, n1Bad: 0 }; acc.set(vc, a); } return a; };
  for (const r of res.rows || []) {
    const a = get(String(r.vcenterId)); a.clusters++;
    if (r.collected === false) a.unknown++;
    else if (r.sev === 'crit') a.crit++;
    else if (r.sev === 'warn') a.warn++;
  }
  for (const g of n1 || []) { if (g?.row?.n1Ok === false) { const a = get(String(g.row.vcenterId)); a.warn++; a.n1Bad++; } }
  const rows = activeVcs(ctx.snap).map((v) => {
    const a = acc.get(String(v.id));
    if (!a) return vcRow(v.id, vcUnreadReason(v) ? 'unknown' : 'ok', 0, vcUnreadReason(v) || '클러스터 없음');
    return vcRow(v.id, judge(a), a.crit + a.warn, `클러스터 ${a.clusters}곳 · 이상 ${a.crit} · 주의 ${a.warn}${a.n1Bad ? `(N+1 부족 ${a.n1Bad})` : ''}${a.unknown ? ` · 구성 미수집 ${a.unknown}` : ''}`);
  });
  return { rows, basis: rowsBasis(rows) };
}

/** 데이터스토어 · 경로 · vSAN(analyzeDatastores · storagePathsSummaryByVc · analyzeVsan). 죽은 경로는 주의(화면 배지와 같은 급). */
export async function storagePaths(ctx) {
  const { analyzeDatastores, analyzeVsan } = await import('../../dscfg/analyze.js');
  const { storagePathsSummaryByVc } = await import('../../dscfg/summary.js');
  const vcName = vcNameMap(ctx.snap);
  const ds = analyzeDatastores(ctx.snap.datastores || [], { vcName });
  const paths = storagePathsSummaryByVc(ctx.snap, { vcName, topN: 3 });
  const vsan = analyzeVsan(ctx.snap.hosts || [], ctx.snap.datastores || [], { vcName });
  const acc = new Map();
  const get = (vc) => { let a = acc.get(vc); if (!a) { a = { crit: 0, warn: 0, unknown: 0, dead: 0, single: 0 }; acc.set(vc, a); } return a; };
  for (const r of ds.rows || []) { const a = get(String(r.vcenterId)); if (r.sev === 'crit') a.crit++; else if (r.sev === 'warn') a.warn++; }
  for (const r of paths.rows || []) { const a = get(String(r.vcenterId)); a.dead += numOrNull(r.totals?.dead) ?? 0; a.single += numOrNull(r.totals?.singlePath) ?? 0; if ((r.totals?.dead || 0) > 0) a.warn++; if ((r.notCollected || 0) > 0 && (r.coverage?.hosts || 0) > 0 && r.notCollected >= r.coverage.hosts) a.unknown++; }
  for (const c of vsan.clusters || []) for (const f of c.findings || []) { const a = get(String(c.vcenterId)); if (f.sev === 'crit') a.crit++; else if (f.sev === 'warn') a.warn++; }
  for (const d of vsan.datastores || []) for (const f of d.findings || []) { const a = get(String(d.vcenterId)); if (f.sev === 'warn') a.warn++; }
  const rows = activeVcs(ctx.snap).map((v) => {
    const a = acc.get(String(v.id)) || { crit: 0, warn: 0, unknown: 0, dead: 0, single: 0 };
    return vcRow(v.id, judge(a), a.crit + a.warn, `이상 ${a.crit} · 주의 ${a.warn} · 죽은 경로 ${a.dead} · 단일 경로 ${a.single}${a.unknown ? ' · 경로 미수집' : ''}`);
  });
  return { rows, basis: `${rowsBasis(rows)}${ds.coverage?.notCollected ? ` · 구성 미수집 데이터스토어 ${n(ds.coverage.notCollected)}` : ''}` };
}

/** CPU 경합 · 디스크 지연(contentionSummaryByVc) — 최근 5분 창 값이라 회차 시점 상태다. */
export async function contention(ctx) {
  const { contentionSummaryByVc } = await import('../../contention/analyze.js');
  const { config } = await import('../../config.js');
  const sm = contentionSummaryByVc(ctx.snap, { now: ctx.now, refreshMs: config.contentionRefreshMs, vcName: vcNameMap(ctx.snap), topN: 3 });
  const by = new Map((sm.rows || []).map((r) => [String(r.vcenterId), r]));
  const rows = activeVcs(ctx.snap).map((v) => {
    const r = by.get(String(v.id));
    if (!r) return vcRow(v.id, 'unknown', null, vcUnreadReason(v) || '측정 값 없음');
    const k = r.kpi || {}; const cv = r.coverage || {};
    const crit = (k.readyCrit || 0) + (k.diskCrit || 0); const warn = (k.readyWarn || 0) + (k.diskWarn || 0);
    const unk = (cv.poweredOn || 0) > 0 && (cv.measured || 0) === 0 ? 1 : 0;
    return vcRow(v.id, judge({ crit, warn, unknown: unk }), crit + warn, `Ready 이상 ${n(k.readyCrit)} · 주의 ${n(k.readyWarn)} · 디스크 지연 이상 ${n(k.diskCrit)} · 주의 ${n(k.diskWarn)}${cv.notMeasured ? ` · 미측정 ${n(cv.notMeasured)}` : ''}${cv.stale ? ` · 오래된 표본 ${n(cv.stale)}` : ''}`);
  });
  return { rows, basis: `${rowsBasis(rows)} · 회차 시점(최근 측정 창) 값` };
}

/** VM 수량 추이(정보) — vmtrack 의 vCenter 별 슬롯에서 기간 첫 · 끝 total. */
export async function vmCount(ctx) {
  const { readSeries } = await import('../../vmtrack/db.js');
  const rows0 = await readSeries({ vcenterId: 'ALL', sinceTs: ctx.from - 12 * 3_600_000 });
  const by = new Map();
  for (const r of rows0 || []) {
    if (!r || r.ts > ctx.to) continue;
    const vc = String(r.vcenter_id || '');
    if (!vc) continue;
    const a = by.get(vc) || { first: null, last: null, added: 0, removed: 0 };
    if (a.first == null) a.first = r;
    a.last = r;
    if (r.ts >= ctx.from && !r.baseline) { a.added += numOrNull(r.added) ?? 0; a.removed += numOrNull(r.removed) ?? 0; }
    by.set(vc, a);
  }
  let tFirst = 0; let tLast = 0; let known = 0;
  const rows = activeVcs(ctx.snap).map((v) => {
    const a = by.get(String(v.id));
    if (!a) return vcRow(v.id, 'info', null, '기간 안 기록 없음');
    const f = numOrNull(a.first.total); const l = numOrNull(a.last.total);
    if (f != null && l != null) { tFirst += f; tLast += l; known++; }
    return vcRow(v.id, 'info', l, `${n(f)} → ${n(l)}대 (생성 ${n(a.added)} · 삭제 ${n(a.removed)})`);
  });
  return { rows, count: known ? tLast : null, value: known ? `${tFirst.toLocaleString('ko-KR')} → ${tLast.toLocaleString('ko-KR')}대 (${tLast - tFirst >= 0 ? '+' : ''}${(tLast - tFirst).toLocaleString('ko-KR')})` : '기록 없음',
    basis: `기간 첫 · 끝 슬롯(00 · 12시) 기준 · 기록이 있는 vCenter ${known}곳 합` };
}

/** 용량 고갈 예측 — 화면과 같은 항목 계산(tools/capacityForecastItems) + 법인 줄(capacityForecastSummaryByVc). */
export async function capacityEta(ctx) {
  const { dsGrowthFor } = await import('../../tools/dsGrowth.js');
  const { forecastItems } = await import('../../tools/capacityForecastItems.js');
  const { capacityForecastSummaryByVc } = await import('../../dscfg/summary.js');
  const all = ctx.snap.datastores || [];
  const growth = await dsGrowthFor(all.map((d) => d.id));
  const items = forecastItems(all, growth, { mock: ctx.snap.source === 'mock' });
  const vcs = activeVcs(ctx.snap);
  const sm = capacityForecastSummaryByVc(items, { vcenters: vcs }, { vcName: vcNameMap(ctx.snap), topN: 3 });
  const by = new Map((sm.rows || []).map((r) => [String(r.vcenterId), r]));
  const rows = vcs.map((v) => {
    const r = by.get(String(v.id));
    if (!r) return vcRow(v.id, 'ok', 0, '데이터스토어 없음');
    const w30 = numOrNull(r.fullWithin?.[30]) ?? 0; const w90 = numOrNull(r.fullWithin?.[90]) ?? 0;
    const unk = (r.datastores || 0) > 0 && (numOrNull(r.noForecast) ?? 0) + (numOrNull(r.usageUnknown) ?? 0) >= r.datastores ? 1 : 0;
    return vcRow(v.id, judge({ crit: w30, warn: w90 - w30 > 0 ? w90 - w30 : 0, unknown: unk }), w90, `30일 안 ${n(w30)} · 90일 안 ${n(w90)} / ${n(r.datastores)}개${r.noForecast ? ` · 추세 없음 ${n(r.noForecast)}` : ''}`);
  });
  return { rows, basis: `${rowsBasis(rows)}${growth.stale ? ' · 추세 계산이 오래됨' : ''}${growth.error ? ` · 추세 계산 오류: ${String(growth.error).slice(0, 80)}` : ''}${items.some((x) => x.synthesized) ? ' · 데모 합성 증가율 포함' : ''}`, asOf: numOrNull(growth.at) };
}

/** 버전 · 패치 준수 — 지원 종료 ESXi 이상 · 종료 임박 · Tools 업그레이드 필요는 주의. */
export async function compliance(ctx) {
  const { computeCompliance } = await import('../../reports/compliance.js');
  const rows = activeVcs(ctx.snap).map((v) => {
    const c = computeCompliance(sliceVc(ctx.snap, v.id), { now: ctx.now })?.summary || {};
    const eol = numOrNull(c.eolHosts) ?? 0; const ending = numOrNull(c.endingHosts) ?? 0; const tools = numOrNull(c.toolsNeedUpgrade) ?? 0; const hw = numOrNull(c.oldHwVms) ?? 0;
    return vcRow(v.id, judge({ crit: eol, warn: ending + tools }), eol + ending + tools, `지원 종료 ESXi ${n(eol)} · 종료 임박 ${n(ending)} · Tools 업그레이드 필요 ${n(tools)} · 오래된 HW 버전 ${n(hw)}`);
  });
  return { rows, basis: rowsBasis(rows) };
}

/** 라이선스 만료 — vCenter 라이선스(licenseExpiryStatus — 라이선스 만료일 확인 도구와 같은 판정). Horizon 은 캐시가 없으면 로그인하므로 넣지 않는다. */
export async function licenseExpiry(ctx) {
  const { vcListUnread, vcListItems } = await import('../../corelicense/analyze.js');
  const { licenseExpiryStatus } = await import('../../util/licenseExpiry.js');
  const rows = activeVcs(ctx.snap).map((v) => {
    const why = vcListUnread(v, 'licenses');
    if (why) return vcRow(v.id, 'unknown', null, `라이선스를 읽지 못함(${why})`);
    let exp = 0; let crit = 0; let soon = 0;
    for (const l of vcListItems(v, 'licenses')) {
      const ts = numOrNull(l.expires ?? l.expiresAt ?? l.expiration);
      if (ts == null) continue;
      const st = licenseExpiryStatus(ts, { now: ctx.now });
      if (st?.status === 'expired') exp++;
      else if (st?.status === 'expiring') { if (numOrNull(st.daysLeft) != null && st.daysLeft <= 30) crit++; else soon++; }
    }
    return vcRow(v.id, judge({ crit: exp + crit, warn: soon }), exp + crit + soon, `만료 ${exp} · 30일 안 ${crit} · 90일 안 ${soon}`);
  });
  return { rows, basis: `${rowsBasis(rows)} · vCenter 라이선스 기준(Horizon 은 특수 기능 › 라이선스 만료일 확인에서)` };
}

/** 인증서 만료 — certMonitor 캐시(vCenter · NSX). 첫 확인 전이면 확인 불가. */
export async function certExpiry(ctx) {
  const { certStatus } = await import('../../security/certMonitor.js');
  const c = certStatus() || {};
  if (!numOrNull(c.at)) return { status: 'unknown', unknownReason: '인증서 첫 확인이 아직 끝나지 않았습니다(포탈 기동 뒤 첫 확인 전) — 다음 회차부터 실립니다.', rows: [] };
  const acc = new Map();
  for (const it of c.items || []) {
    const vc = it.kind === 'vcenter' ? String(it.id) : (typeof it.vcenterId === 'string' && it.vcenterId ? it.vcenterId : null);
    const key = vc || '';
    const a = acc.get(key) || { crit: 0, warn: 0, unknown: 0, total: 0, names: [] };
    a.total++;
    if (it.status === 'expired' || it.status === 'critical') { a.crit++; a.names.push(`${it.name || it.host} ${numOrNull(it.daysLeft) != null ? `D-${it.daysLeft}` : ''}`); }
    else if (it.status === 'expiring') { a.warn++; a.names.push(`${it.name || it.host} D-${it.daysLeft}`); }
    else if (it.status !== 'ok') a.unknown++;
    acc.set(key, a);
  }
  const rows = [...acc.entries()].map(([vc, a]) => ({ ...(vc ? { vc } : {}), status: judge(a), count: a.crit + a.warn, text: `인증서 ${a.total}개 · 이상 ${a.crit} · 주의 ${a.warn}${a.unknown ? ` · 확인 불가 ${a.unknown}` : ''}${a.names.length ? ` — ${a.names.slice(0, 3).join(', ')}` : ''}` }));
  return { rows, basis: rowsBasis(rows, '대상'), asOf: numOrNull(c.at) };
}

/** 코어 라이선스 산정(정보). */
export async function coreLicense(ctx) {
  const { analyzeCoreLicense } = await import('../../corelicense/analyze.js');
  const r = analyzeCoreLicense(ctx.snap, { vsanPlan: 'none' });
  const rows = (r.vcenters || []).map((v) => vcRow(v.vcenterId, 'info', numOrNull(v.licensed), `산정 코어 ${n(v.licensed)} · 실제 코어 ${n(v.cores)}${v.notRead ? ' · 못 읽음' : ''}${v.licensesUnread ? ' · 라이선스 못 읽음' : ''}`));
  return { rows, count: numOrNull(r.totals?.licensed), value: `산정 코어 ${n(r.totals?.licensed)}${r.totals?.notRead ? ` · 못 읽은 vCenter ${n(r.totals.notRead)}` : ''}`, basis: '16코어/소켓 최소 기준(코어 라이선스 산정 도구)' };
}
