// 베어메탈 스토리지(v2.340, 사용자 요구) — 서버 SSH(df)로 로컬 디스크 마운트 용량을 주기 수집해
// 서버/그룹/전체 합산(총·사용·가용)을 보여준다. 전부 adminOnly(SSH 자격증명·호스트 구성).
import { requireRole } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { listBmServers, listBmServersRaw, saveBmServer, removeBmServer, getBmSettings, saveBmSettings, bmServerInputIssue } from '../../bmstor/registry.js';
import { getBmLatest, bmCollectNow, bmPollerStatus } from '../../bmstor/poller.js';
import { isDemoGuest } from '../../auth/demoGuest.js'; // v2.720(감사 R1-03)
import { aggregate } from '../../bmstor/agg.js';
import { bmServersToCsv, sampleCsv as bmSampleCsv, parseBmServersCsv, analyzeBmServersImport } from '../../bmstor/csv.js';
import { listCollectors, findCollectorByName } from '../../collector/registry.js';
import { bmHistoryStatus } from '../../bmstor/historySampler.js';
import { bmHistoryRange, bmHistoryDbStatus } from '../../bmstor/historyDb.js';
import { historyPeriodOf, seriesFromRows, HISTORY_PERIODS } from '../../bmstor/history.js';
import { requireSettingsOwner, fullScopeOnlyWith } from '../admin/shared.js';
import { requirePerm as requireCsvPerm } from '../../auth/auth.js';
import { isAdminReq, maskDeviceAddress, scrubHosts } from '../../auth/addressMask.js';
// ── v2.915 SAN 비교 · 장비별 디스크 성능 차트(설계 docs/design/bm-san-compare §4) ──
import { numOrNull } from '../../util/numOrNull.js';
import { listDatacenters, datacenterOfVcenter } from '../../datacenter/store.js';
import { listDevices as listStorageDevices } from '../../storage/registry.js';
import { localSnapshots as storageLocalSnaps } from '../../storage/store.js';
import { edgeStorageSnapshots } from '../../central/storageEdge.js';
import { listDevices as listSanSwitches } from '../../sanswitch/registry.js';
import { storageSeriesMulti, arraySerialOf, endpointKind, available as perfDbAvailable, rangeOf as sanRangeOf, latestSampleTs } from '../../sanswitch/perfDb.js';
import { loadPerfSettings } from '../../sanswitch/perfSettings.js';
import { sumArrayTraffic } from '../../sanswitch/trafficTotal.js';
import { demoOn, isMockMode } from '../../mock/demo/flags.js';
import { isDemoId, demoBmIoSeries } from '../../mock/demo/storage.js';
import { datacenterOfBmServer, parseDcQuery, NONE_DC } from '../../bmstor/corp.js';
import { parseTypes, latestSnapshotMap, sanArrayRows, attachThroughput, compareSummary, datacenterChips, stripHost, norm as normSerial, BLOCK_ARRAY_TYPES } from '../../bmstor/compare.js';
import { RANGES, rangeKeyOf, bucketsOf, sourceFor, seriesFromRaw, seriesFromRollup, sumSeries, summarize, parseSeriesIds, metricOf } from '../../bmstor/ioSeries.js';
import { ioRawRows, ioRollupRows, ioMeasuredServerIds, ioRank, bmIoDbStatus, ioRetention } from '../../bmstor/ioDb.js';

/** 등록 서버 + 법인(corp.datacenterOfBmServer — 폼 값 → 엣지의 법인 → ''). 비밀은 이미 가려져 있다(listBmServers). 엣지 조회는 등록부 코어 하나(findCollectorByName). */
function serversWithCorp() {
  const findCollector = (q) => { const c = findCollectorByName(q); return c ? { vcenterId: c.vcenterId } : null; };   // vcenterId 만 — 토큰은 꺼내지 않는다
  return listBmServers().map((s) => ({ ...s, ...datacenterOfBmServer(s, { findCollector, datacenterOfVcenter }) }));
}
function dcNameFn() {
  try { const m = new Map(listDatacenters().map((d) => [String(d.id), d.name || d.id])); return (id) => m.get(String(id)) || String(id || '') || '(법인 미지정)'; }
  catch { return (id) => String(id || '') || '(법인 미지정)'; }
}
/** SAN 집계의 버킷(값이 있는 것만 · 희소) → 우리 격자. 같은 bucketMs 라 인덱스로 맞춘다. */
function regrid(aggBuckets, values, buckets, bucketMs) {
  const out = new Array(buckets.length).fill(null);
  if (!Array.isArray(aggBuckets) || !Array.isArray(values) || !buckets.length) return out;
  const b0 = buckets[0];
  for (let i = 0; i < aggBuckets.length; i++) {
    const j = Math.floor((Number(aggBuckets[i]) - b0) / bucketMs);
    if (j >= 0 && j < out.length && values[i] != null) out[j] = out[j] == null ? Number(values[i]) : out[j] + Number(values[i]);
  }
  return out;
}
// v2.643: CSV·텍스트 가져오기/내보내기는 관리자 이상 + 'data.csv' 권한(super_admin 항상, admin 은 권한 설정에서 끌 수 있다).
const csvPerm = requireCsvPerm('data.csv');

const adminOnly = requireRole('admin');
// v2.612 AUTHZ2612-06: 베어메탈 서버는 법인 축이 없다(엣지만) — 범위 제한 admin 도 403(스토리지 모니터링과 같은 기준).
const fullScopeOnly = fullScopeOnlyWith('베어메탈 스토리지는 vCenter 범위 밖이라 전체 범위(vCenter 제한 없는) 계정만 쓸 수 있습니다.');

export function registerBmStorage(api) {
  // 현황 — 서버 목록(비밀 redact) + 최신 수집을 합산(서버/그룹/전체)해 반환. 엣지 콤보용 목록 포함.
  api.get('/tools/bm-storage', adminOnly, fullScopeOnly, (req, res) => {
    const servers = serversWithCorp();   // v2.915: 법인(폼 값 · 엣지 추정)도 함께
    const { total, groups, perServer } = aggregate(servers, getBmLatest());
    // v2.743 AUTHZ-01: 관리 주소·SSH 계정은 관리자 상세(데모 계정 제외)에게만 — 형제 스토리지·SAN 목록과 같은 maskDeviceAddress.
    //   오류 문구 속 주소도 같은 목록으로 가린다(v2.599 '형제 경로가 우회로' 규약). 가린 사실은 addressHidden.
    const full = isAdminReq(req);
    const hosts = full ? [] : servers.map((x) => x?.host).filter(Boolean);
    const rows = full ? perServer : perServer.map((r) => ({ ...maskDeviceAddress(r), error: r.error ? scrubHosts(r.error, hosts) : r.error }));
    res.json({
      ok: true, total, groups, servers: rows,
      config: full ? servers : servers.map(maskDeviceAddress), // 편집 폼용 원본(마운트 목록 포함, 비밀번호는 hasPassword 만)
      ...(full ? {} : { addressHidden: true }),
      settings: getBmSettings(), status: bmPollerStatus(),
      agents: listCollectors().map((c) => c.id), // 위임 가능한 엣지(수집 서버) 이름 목록
      datacenters: (() => { try { return listDatacenters().map((d) => ({ id: d.id, name: d.name || d.id })); } catch { return []; } })(),   // v2.915: 폼 '법인' 선택
    });
  });

  /*
   * ── v2.915 SAN 비교(설계 docs/design/bm-san-compare §4.2 · §4.4) ──
   * 베어메탈(그룹 · 전체 · 서버) 용량 사용률 + 디스크 I/O 표본 ↔ SAN 어레이(VMAX · PowerMax 기본) 용량 사용률 + 포트 전송 속도.
   * 게이트는 현황과 같다. 응답에 **관리 주소를 싣지 않는다**(stripHost — 가림 분기 자체가 없다).
   * 무거운 것은 storageSeriesMulti 뿐이고 자체 기억(TTL = 수집 주기)이 있다 — 화면은 마운트 1회 + 버튼 + '지금 측정' 뒤 1회만 부른다.
   */
  api.get('/tools/bm-storage/compare', adminOnly, fullScopeOnly, async (req, res) => {
    const hours = Math.max(1, Math.min(24 * 7, Math.round(numOrNull(req.query.hours) ?? 1)));
    const types = parseTypes(req.query.types);
    const dcSet = parseDcQuery(req.query.datacenterId);
    const dcName = dcNameFn();
    const serversAll = serversWithCorp();
    const servers = dcSet ? serversAll.filter((s) => dcSet.has(String(s.datacenterId || ''))) : serversAll;
    const latest = getBmLatest();
    const bmAgg = aggregate(servers, latest);
    const bmAll = dcSet ? aggregate(serversAll, latest) : bmAgg;   // 법인 칩 개수는 필터 전 전체로
    // SAN — 등록 어레이(종류 · 활성) × 최신 스냅샷(중앙 · 엣지 중 늦은 것)
    const typeSet = new Set(types);
    let stAll = []; try { stAll = listStorageDevices().filter((d) => d.enabled !== false && typeSet.has(String(d.type || ''))); } catch { stAll = []; }
    let snapMap = new Map(); try { snapMap = latestSnapshotMap([storageLocalSnaps(), edgeStorageSnapshots()]); } catch { snapMap = new Map(); }
    const rowsAll = sanArrayRows(stAll, snapMap);
    const rows = dcSet ? rowsAll.filter((r) => dcSet.has(r.datacenterId)) : rowsAll;
    let switches = []; try { switches = listSanSwitches().filter((d) => d.enabled !== false && (!dcSet || dcSet.has(String(d.datacenterId || '')))); } catch { switches = []; }
    const perfSettings = loadPerfSettings();
    const perfEnabled = demoOn(perfSettings.enabled);
    let perfAvailable = false; let agg = null; let perfError = '';
    if (perfEnabled && switches.length) {
      try { perfAvailable = await perfDbAvailable(); } catch { perfAvailable = false; }
      if (perfAvailable) {
        try { agg = await storageSeriesMulti(switches.map((d) => d.id), { hours, groupOf: new Map(switches.map((d) => [String(d.id), String(d.datacenterId || '')])) }); }
        catch (e) { perfError = String(e?.message || e).slice(0, 200); agg = null; }
      }
    }
    const sanRows = attachThroughput(rows, agg, { perfEnabled, perfAvailable: perfAvailable && !!agg, switches: switches.length, split: true })
      .map((r) => ({ ...r, datacenterName: r.datacenterId ? dcName(r.datacenterId) : '(법인 미지정)' }));
    let lastSampleAt = null;
    if (switches.length) { try { const m = await latestSampleTs(switches.map((d) => d.id)); for (const v of m.values()) { const t = numOrNull(v); if (t != null && (lastSampleAt == null || t > lastSampleAt)) lastSampleAt = t; } } catch { lastSampleAt = null; } }
    const chips = datacenterChips({ servers: bmAll.perServer, sanRows: rowsAll, dcNameOf: dcName }).map((c) => ({ ...c, id: c.id || NONE_DC }));
    // 종류 칩 개수(필터 전 · 블록 어레이 전 종류 — 화면이 고르지 않은 종류의 대수도 보이게)
    const sanTypeCounts = {};
    try { for (const d of listStorageDevices()) { if (d.enabled === false) continue; const t = String(d.type || ''); if (BLOCK_ARRAY_TYPES.includes(t)) sanTypeCounts[t] = (sanTypeCounts[t] || 0) + 1; } } catch { /* 등록부 못 읽음 — 빈 개수 */ }
    // 법인을 골랐을 때 그룹 전체 대수('서울 2/3대' 의 분모)
    const groupTotals = dcSet ? Object.fromEntries(bmAll.groups.map((g) => [g.name, g.servers])) : null;
    res.json({
      ok: true, hours, types, datacenterIds: dcSet ? [...dcSet].map((x) => x || NONE_DC) : [], datacenters: chips, sanTypeCounts, groupTotals,
      bm: {
        total: bmAgg.total, groups: bmAgg.groups,
        servers: bmAgg.perServer.map((r) => ({ ...stripHost(r), datacenterName: r.datacenterId ? dcName(r.datacenterId) : '(법인 미지정)' })),
        status: bmPollerStatus(), settings: getBmSettings(),
      },
      san: {
        arrays: sanRows, perfEnabled, perfAvailable: perfAvailable && !!agg, perfError, switches: switches.length,
        perfIntervalMs: numOrNull(perfSettings.intervalMs), lastSampleAt, bucketMs: agg?.bucketMs ?? null,
      },
      summary: compareSummary({ bmTotal: bmAgg.total, sanRows }),
      io: await bmIoDbStatus(),
    });
  });

  /*
   * ── v2.915 장비별 디스크 성능 시계열(설계 §4.6) ──
   * ids = bm:<id> · san:<시리얼> · bm:all · san:all (최대 10). 격자는 SAN 포트 사용량과 같다(sanRangeOf — 15분 · 1시간 정배수).
   * 베어메탈: 1시간 = 원시 표(점 = 수집 주기) · 24시간 = 15분 표 · 7일 · 30일 = 1시간 표. 평균 = 카운터 차분 평균, 피크 = 2초 표본 최댓값(하한).
   * SAN: storageSeriesMulti 의 sum(평균) · peak(표본 최댓값) 을 어레이 시리얼로 고른다. rank=1 이면 막대 비교용 전 장비 순위도 싣는다.
   */
  api.get('/tools/bm-storage/io/series', adminOnly, fullScopeOnly, async (req, res) => {
    const range = rangeKeyOf(req.query.range);
    const metric = metricOf(req.query.metric);
    const ids = parseSeriesIds(req.query.ids, { maxIds: 10 });
    const dcSet = parseDcQuery(req.query.datacenterId);
    const types = parseTypes(req.query.types);
    const wantRank = String(req.query.rank || '') === '1';
    const now = Date.now();
    const toQ = numOrNull(req.query.to);
    const until = toQ != null && toQ > 0 && toQ <= now ? Math.round(toQ) : now;
    const since = until - RANGES[range].hours * 3600e3;
    const { bucketMs } = sanRangeOf({ from: since, to: until, points: 120 });
    const buckets = bucketsOf(since, until, bucketMs);
    const n = buckets.length;
    const gran = sourceFor(bucketMs);
    const settings = getBmSettings();
    const bmSampleMs = Math.max(60_000, settings.intervalMinutes * 60_000);
    const mock = isMockMode();
    const dcName = dcNameFn();
    const serversAll = serversWithCorp().filter((s) => s.enabled !== false);
    const servers = dcSet ? serversAll.filter((s) => dcSet.has(String(s.datacenterId || ''))) : serversAll;
    const serverById = new Map(servers.map((s) => [String(s.id), s]));
    const pick = (r, k) => (metric === 'read' ? r[`${k}Read`] ?? r[`${k}Rd`] : metric === 'write' ? r[`${k}Write`] ?? r[`${k}Wr`] : r[`${k}Total`] ?? r[k]);
    const bmSeriesFor = async (id) => {
      if (mock && isDemoId(id)) return demoBmIoSeries(id, { buckets, bucketMs, metric });
      if (gran === 'raw') {
        const rows = await ioRawRows(id, since, until);
        if (!rows) return null;
        return seriesFromRaw(rows.map((r) => ({ ts: r.ts, avgTotal: pick(r, 'avg'), instTotal: pick(r, 'inst'), busy: r.busy })), buckets, bucketMs);
      }
      const rows = await ioRollupRows(gran, id, since, until);
      if (!rows) return null;
      return seriesFromRollup(rows.map((r) => ({ b: r.b, nAvg: r.nAvg, sumAvg: metric === 'read' ? r.sumRd : metric === 'write' ? r.sumWr : r.sumAvg, maxInst: metric === 'read' ? r.maxRd : metric === 'write' ? r.maxWr : r.maxInst, maxBusy: r.maxBusy })), buckets, bucketMs);
    };
    // 측정된 서버 — DB 에 값이 있는 서버 + (mock 이면) 데모 서버(수식). 사람이 등록한 서버는 mock 모드에서도 DB 를 본다(v2.719 규칙).
    const measuredIds = async () => {
      const list = await ioMeasuredServerIds(gran, since, until);
      const out = new Set((list || []).filter((id) => serverById.has(id) && !(mock && isDemoId(id))));
      if (mock) for (const s of servers) if (isDemoId(s.id)) out.add(String(s.id));
      return [...out];
    };
    const bmBasis = { avg: 'counter', peak: 'sample2s' };
    // SAN 집계(필요할 때 1회)
    const needSan = wantRank || ids.some((x) => x.kind === 'san');
    let agg = null; let switches = []; let perfEnabled = false; let perfAvailable = false; let sanInterval = null;
    let serialName = new Map();
    if (needSan) {
      try { switches = listSanSwitches().filter((d) => d.enabled !== false && (!dcSet || dcSet.has(String(d.datacenterId || '')))); } catch { switches = []; }
      const ps = loadPerfSettings(); perfEnabled = demoOn(ps.enabled); sanInterval = numOrNull(ps.intervalMs);
      if (perfEnabled && switches.length) {
        try { perfAvailable = await perfDbAvailable(); } catch { perfAvailable = false; }
        if (perfAvailable) {
          try { agg = await storageSeriesMulti(switches.map((d) => d.id), { from: since, to: until, points: 120, groupOf: new Map(switches.map((d) => [String(d.id), String(d.datacenterId || '')])) }); }
          catch { agg = null; }
        }
      }
      try {
        const typeSet = new Set(types);
        const snapMap = latestSnapshotMap([storageLocalSnaps(), edgeStorageSnapshots()]);
        for (const d of listStorageDevices()) {
          if (d.enabled === false || !typeSet.has(String(d.type || ''))) continue;
          const sn = snapMap.get(d.id);
          const k = normSerial(sn?.serial);
          if (k) serialName.set(k, { name: d.name || d.id, type: String(d.type || ''), datacenterId: String(d.datacenterId || '') });
        }
      } catch { serialName = new Map(); }
    }
    const sanBasis = { avg: 'sample5m', peak: 'sample5m' };
    const sanSeriesBySerial = new Map();
    for (const s of agg?.series || []) {
      const k = normSerial(arraySerialOf(s.key));
      if (!k) continue;
      if (dcSet && !dcSet.has(String(s.group ?? ''))) continue;
      const prev = sanSeriesBySerial.get(k);
      if (!prev || (Number(s.avgTotal) || 0) > (Number(prev.avgTotal) || 0)) sanSeriesBySerial.set(k, s);
    }
    const series = [];
    for (const { kind, key } of ids) {
      if (kind === 'bm' && key === 'all') {
        const list = [];
        for (const id of await measuredIds()) { const s = await bmSeriesFor(id); if (s) list.push(s); }
        const sum = sumSeries(list, n);
        series.push({ id: 'bm:all', kind: 'bm', name: dcSet ? `베어메탈 합(${[...dcSet].map((x) => dcName(x)).join(', ')})` : '베어메탈 전체', avg: sum.avg, peak: sum.peak, partial: sum.partial, measured: sum.measured, total: servers.length, sampleMs: bmSampleMs, basis: bmBasis, ...summarize(sum) });
      } else if (kind === 'bm') {
        const s = serverById.get(key);
        if (!s) { series.push({ id: `bm:${key}`, kind: 'bm', name: key, avg: new Array(n).fill(null), peak: new Array(n).fill(null), missing: true, reason: 'unknown-server', sampleMs: bmSampleMs, basis: bmBasis, ...summarize(null) }); continue; }
        const ser = await bmSeriesFor(key);
        const lat = getBmLatest().get(String(key));
        series.push({ id: `bm:${key}`, kind: 'bm', name: s.name || key, datacenterId: s.datacenterId || '', avg: ser?.avg || new Array(n).fill(null), peak: ser?.peak || new Array(n).fill(null), busy: ser?.busy || null, sampleMs: bmSampleMs, basis: bmBasis, dbUnavailable: ser == null, ioError: lat?.ok ? (lat.io ? null : (lat.ioError || null)) : null, ...summarize(ser) });
      } else if (kind === 'san' && key === 'all') {
        if (!agg) { series.push({ id: 'san:all', kind: 'san', name: 'SAN 전체', avg: new Array(n).fill(null), peak: new Array(n).fill(null), reason: !perfEnabled ? 'perf-disabled' : !switches.length ? 'no-switches' : 'perf-unavailable', sampleMs: sanInterval, basis: sanBasis, ...summarize(null) }); continue; }
        const t = sumArrayTraffic(agg, { isArray: (s) => endpointKind(s.key, { matched: false }) === 'array', carryMs: agg.carryMs });
        const avg = regrid(agg.buckets, t.total, buckets, bucketMs);
        // 피크 합 — 평균 합이 있는 버킷에서 어레이 피크를 더한다(동시 피크의 상한).
        const peakRaw = new Array(agg.buckets.length).fill(null);
        for (let i = 0; i < agg.buckets.length; i++) {
          if (t.total[i] == null) continue;
          let p = 0; for (const s of agg.series) if (endpointKind(s.key, { matched: false }) === 'array' && s.peak?.[i] != null) p += s.peak[i];
          peakRaw[i] = p || null;
        }
        const peak = regrid(agg.buckets, peakRaw, buckets, bucketMs);
        series.push({ id: 'san:all', kind: 'san', name: 'SAN 전체', avg, peak, arrays: t.arrays, partialBuckets: t.partialBuckets, sampleMs: sanInterval, basis: sanBasis, ...summarize({ avg, peak }) });
      } else if (kind === 'san') {
        const k = normSerial(key);
        const meta = serialName.get(k) || null;
        const s = sanSeriesBySerial.get(k) || null;
        if (!s) { series.push({ id: `san:${key}`, kind: 'san', name: meta?.name || key, type: meta?.type || '', datacenterId: meta?.datacenterId || '', avg: new Array(n).fill(null), peak: new Array(n).fill(null), reason: !agg ? (!perfEnabled ? 'perf-disabled' : !switches.length ? 'no-switches' : 'perf-unavailable') : 'serial-unmatched', sampleMs: sanInterval, basis: sanBasis, ...summarize(null) }); continue; }
        const avg = regrid(agg.buckets, s.sum, buckets, bucketMs); const peak = regrid(agg.buckets, s.peak, buckets, bucketMs);
        series.push({ id: `san:${key}`, kind: 'san', name: meta?.name || s.key, type: meta?.type || '', datacenterId: meta?.datacenterId || String(s.group ?? ''), avg, peak, ports: Array.isArray(s.ports) ? s.ports.length : 0, switches: Array.isArray(s.deviceIds) ? s.deviceIds.length : 0, sampleMs: sanInterval, basis: sanBasis, ...summarize({ avg, peak }) });
      }
    }
    // 순위(막대 비교) — 베어메탈은 집계 표 세 문장(ioRank) · 데모는 수식 요약 · SAN 은 agg.series 의 어레이 계열
    let rank = null;
    if (wantRank) {
      rank = [];
      const m = servers.some((s) => !(mock && isDemoId(s.id))) ? await ioRank(gran, since, until, { metric }) : new Map();
      for (const s of servers) {
        if (mock && isDemoId(s.id)) {   // 데모 서버는 수식(적재하지 않는다)
          const sm = summarize(demoBmIoSeries(s.id, { buckets, bucketMs, metric }));
          rank.push({ id: `bm:${s.id}`, kind: 'bm', name: s.name, datacenterId: s.datacenterId || '', avgBps: sm.avgTotal, peakBps: sm.peakTotal, points: sm.points, reason: sm.points ? null : 'unmeasured' });
          continue;
        }
        const r = m?.get(String(s.id)) || null;
        rank.push({ id: `bm:${s.id}`, kind: 'bm', name: s.name, datacenterId: s.datacenterId || '', avgBps: r?.avgBps ?? null, peakBps: r?.peakBps ?? null, points: r?.n ?? 0, reason: r && r.avgBps != null ? null : (m ? 'unmeasured' : 'db-unavailable') });
      }
      const seen = new Set();
      for (const [k, s] of sanSeriesBySerial) { const meta = serialName.get(k); if (!meta) continue; seen.add(k); rank.push({ id: `san:${k}`, kind: 'san', name: meta.name, type: meta.type, datacenterId: meta.datacenterId, avgBps: numOrNull(s.avgTotal), peakBps: numOrNull(s.peakTotal), points: Array.isArray(s.sum) ? s.sum.filter((v) => v != null).length : 0, ports: Array.isArray(s.ports) ? s.ports.length : 0, reason: numOrNull(s.avgTotal) == null ? 'no-samples' : null }); }
      for (const [k, meta] of serialName) { if (seen.has(k)) continue; if (dcSet && !dcSet.has(meta.datacenterId)) continue; rank.push({ id: `san:${k}`, kind: 'san', name: meta.name, type: meta.type, datacenterId: meta.datacenterId, avgBps: null, peakBps: null, points: 0, reason: !agg ? (!perfEnabled ? 'perf-disabled' : !switches.length ? 'no-switches' : 'perf-unavailable') : 'serial-unmatched' }); }
      rank.sort((a, b) => (b.avgBps ?? -1) - (a.avgBps ?? -1));
    }
    res.json({
      ok: true, range, metric, since, until, bucketMs, gran, buckets, series, rank,
      sampleMs: { bm: bmSampleMs, san: sanInterval }, retention: ioRetention(), db: await bmIoDbStatus(),
      san: { perfEnabled, perfAvailable: !!agg, switches: switches.length },
    });
  });

  /*
   * 디스크 사용량 이력(v2.635, 사용자 요청 — 12시간마다 별도 DB 에 적재 · 1일/7일/1달/분기/반기 차트).
   * 폴링하지 않는 화면이 기간을 바꿀 때만 부른다. kind(total|group|server)로 좁힐 수 있다.
   * 이 DB 에는 호스트 주소를 저장하지 않는다(서버 id·이름·용량 수치뿐) — 게이트는 형제 라우트와 같다.
   */
  api.get('/tools/bm-storage/history', adminOnly, fullScopeOnly, async (req, res) => {
    const period = historyPeriodOf(String(req.query.period || ''));
    const kindQ = String(req.query.kind || '');
    const kind = ['total', 'group', 'server'].includes(kindQ) ? kindQ : null;
    const to = Date.now();
    const from = to - period.days * 86_400_000;
    const r = await bmHistoryRange(from, to, { kind });
    const db = await bmHistoryDbStatus();
    res.json({
      ok: true, available: r.available, period: period.key, periods: HISTORY_PERIODS, from, to, kind,
      series: seriesFromRows(r.rows, { servers: listBmServers() }),
      span: r.span, status: bmHistoryStatus(),
      dbError: r.available ? '' : (db.error || 'node:sqlite 를 쓸 수 없습니다'),
    });
  });

  // 서버 추가/수정 — body { id?, name, host, port, username, password?, agent, groups(최대 3개), mounts, enabled }
  api.post('/tools/bm-storage/servers', adminOnly, fullScopeOnly, (req, res) => {
    const r = saveBmServer(req.body || {});
    if (r.ok) logAudit({ user: req.user?.username, action: '베어메탈 스토리지 서버 저장', target: r.server?.host || '', detail: `mounts ${(r.server?.mounts || []).length}개${r.server?.agent ? ` · 엣지 ${r.server.agent}` : ''}`, ip: req.ip || '' });
    res.status(r.ok ? 200 : 400).json(r);
  });

  api.delete('/tools/bm-storage/servers/:id', adminOnly, fullScopeOnly, (req, res) => {
    const r = removeBmServer(req.params.id);
    if (r.ok) logAudit({ user: req.user?.username, action: '베어메탈 스토리지 서버 삭제', target: req.params.id, ip: req.ip || '' });
    res.status(r.ok ? 200 : 404).json(r);
  });

  // 수집 주기 저장(분) — 폴러가 30초 틱마다 설정을 다시 읽으므로 재기동 없이 반영된다.
  api.put('/tools/bm-storage/settings', adminOnly, fullScopeOnly, (req, res) => {
    const r = saveBmSettings(req.body || {});
    if (r.ok) logAudit({ user: req.user?.username, action: '베어메탈 스토리지 주기 변경', target: `${r.settings.intervalMinutes}분`, ip: req.ip || '' });
    res.status(r.ok ? 200 : 400).json(r);
  });

  /* ── 서버 CSV 일괄 관리(v2.341, 사용자 요구 — 다수 서버 등록). 수집 서버 CSV(v2.338)와 동일 골격:
   * 기본 export 는 비밀번호 제외(?secrets=1 은 설정 소유자 + 감사로그), 가져오기는 드라이런 →
   * 덮어쓰기(overwrite=true 명시) 2단계. agent 는 등록된 수집 서버(원격) 이름만 허용. ── */
  api.get('/tools/bm-storage/export.csv', csvPerm, adminOnly, fullScopeOnly, (req, res) => {
    const withPw = String(req.query.secrets || '') === '1';
    const send = () => {
      const list = withPw ? listBmServersRaw() : listBmServers();
      const csv = bmServersToCsv(list, { includeSecrets: withPw });
      logAudit({ user: req.user?.username, action: withPw ? '베어메탈 스토리지 CSV 내보내기(비밀번호 포함)' : '베어메탈 스토리지 CSV 내보내기', detail: `${list.length}대`, ip: req.ip || '' });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="bm-storage-servers${withPw ? '-with-passwords' : ''}.csv"`);
      res.send(csv);
    };
    if (withPw) return requireSettingsOwner(req, res, send);
    send();
  });

  api.get('/tools/bm-storage/sample.csv', csvPerm, adminOnly, fullScopeOnly, (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="bm-storage-servers-sample.csv"');
    res.send(bmSampleCsv());
  });

  api.post('/tools/bm-storage/import', csvPerm, adminOnly, fullScopeOnly, (req, res) => {
    const { rows, error } = parseBmServersCsv(String(req.body?.csv || ''));
    if (error) return res.status(400).json({ ok: false, reason: error });
    if (!rows.length) return res.status(400).json({ ok: false, reason: '가져올 데이터 행이 없습니다.' });

    const all = listBmServers();
    const existingId = (host, port, user) => all.find((s) =>
      String(s.host).trim() === String(host).trim()
      && String(s.port || 22) === String(port || 22)
      && String(s.username || '') === String(user || ''))?.id;
    const agentSet = new Set(listCollectors().map((c) => String(c.id).toLowerCase()));
    const validAgent = (a) => agentSet.has(String(a).trim().toLowerCase());
    // v2.915: 법인 열 — 등록된 DataCenter 의 id 또는 이름(대소문자 무시)만 id 로 푼다. 모르는 값은 analyze 가 오류로 적는다.
    const dcList = (() => { try { return listDatacenters(); } catch { return []; } })();
    const resolveDatacenter = (txt) => {
      const t = String(txt || '').trim().toLowerCase();
      if (!t) return '';
      const hit = dcList.find((d) => String(d.id).toLowerCase() === t) || dcList.find((d) => String(d.name || '').trim().toLowerCase() === t);
      return hit ? String(hit.id) : null;
    };

    const { report, summary } = analyzeBmServersImport(rows, { existingId, validate: bmServerInputIssue, validAgent, resolveDatacenter });
    if (req.body?.dryRun) return res.json({ ok: true, dryRun: true, report, summary, total: rows.length });

    const allowOverwrite = req.body?.overwrite === true;
    let added = 0, overwritten = 0; const failed = []; const skipped = [];
    const verdictByLine = new Map(report.map((r) => [r.line, r])); // O(rows²) find → O(rows) (v2.342 성능)
    for (const row of rows) {
      const verdict = verdictByLine.get(row._line);
      if (verdict?.action === 'error') { failed.push({ line: verdict.line, host: row.host, reason: verdict.reason }); continue; }
      const id = existingId(row.host, row.port, row.username);
      if (id && !allowOverwrite) { skipped.push({ line: row._line, host: row.host, reason: '기존 항목 — 덮어쓰기 미허용(overwrite 확인 필요)' }); continue; }
      const input = { id, name: row.name, host: row.host, port: row.port, username: row.username,
        groups: row.groups, agent: row.agent, dispatch: row.dispatch, mounts: row.mounts, enabled: row.enabled };
      if (row.datacenter) input.datacenterId = resolveDatacenter(row.datacenter) || '';   // v2.915: 빈 칸은 기존 유지(미전달)
      if (row._hasPassword) input.password = row.password; // 비우면 기존 유지(saveBmServer 규칙)
      const r = saveBmServer(input);
      if (r.ok) { if (id) overwritten++; else added++; }
      else failed.push({ line: row._line, host: row.host, reason: r.reason });
    }
    logAudit({ user: req.user?.username, action: '베어메탈 스토리지 CSV 가져오기', detail: `추가 ${added}·덮어쓰기 ${overwritten}·건너뜀 ${skipped.length}·실패 ${failed.length}`, ip: req.ip || '' });
    res.json({ ok: true, added, overwritten, skipped, failed, total: rows.length });
  });

  // 지금 수집 — 진행 중이면 skipped(재진입 가드 공유, net/monitor.runMonitorNow 패턴).
  api.post('/tools/bm-storage/collect', adminOnly, fullScopeOnly, async (req, res) => {
    const r = await bmCollectNow('manual', { demoOnly: isDemoGuest(req.user) }); // v2.720(감사 R1-03·B2-01): 데모 계정은 데모 서버만
    if (r.ok) logAudit({ user: req.user?.username, action: '베어메탈 스토리지 수동 수집', detail: `서버 ${r.servers} · 성공 ${r.okCount} · 오류 ${r.errors}`, ip: req.ip || '' });
    res.status(r.ok ? 200 : 409).json(r);
  });
}
