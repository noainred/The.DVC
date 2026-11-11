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
import { isDemoId, demoBmIoSeries, demoBmIoMetrics } from '../../mock/demo/storage.js';
// v2.962 비교 세트(SAN A ↔ SAN B · 법인 SAN ↔ 베어메탈 …) — 조립은 bmstor/compareSet.js(순수), 어레이 측 표본은 SAN 스토리지 성능과 같은 코어.
import { parseSetIds, gridMs, bmMetricsFromRaw, bmMetricsFromRollup, combineBm, switchTput, feMetrics, finishMetric, METRIC_KEYS } from '../../bmstor/compareSet.js';
import { capacityIndexFor } from '../../sanswitch/storagePerfCore.js';
import { feEligibility, feWindowKind } from '../../sanswitch/arraySideLoad.js';
import { unitsForArray } from '../../sanswitch/arraySide.js';
import { nodeLoadQuery, nodeUnitsOf } from '../../storage/db.js';
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
function regrid(aggBuckets, values, buckets, bucketMs, mode = 'avg') {
  // v2.962: SAN 집계 칸이 우리 격자보다 촘촘하면(격자를 표본 간격으로 넓힌 경우) 한 칸에 여러 값이 들어온다 — **합하지 않고** 평균(avg) · 최댓값(max).
  //   v2.956 은 두 격자가 같아서 합 = 한 값이었다. 격자가 달라진 지금 합으로 두면 값이 칸 수만큼 부풀었다.
  const out = new Array(buckets.length).fill(null);
  if (!Array.isArray(aggBuckets) || !Array.isArray(values) || !buckets.length) return out;
  const b0 = buckets[0]; const cnt = new Array(buckets.length).fill(0);
  for (let i = 0; i < aggBuckets.length; i++) {
    const j = Math.floor((Number(aggBuckets[i]) - b0) / bucketMs);
    if (j < 0 || j >= out.length || values[i] == null) continue;
    const v = Number(values[i]);
    if (mode === 'max') out[j] = out[j] == null ? v : Math.max(out[j], v);
    else { out[j] = (out[j] ?? 0) + v; cnt[j] += 1; }
  }
  if (mode !== 'max') for (let j = 0; j < out.length; j++) if (cnt[j] > 1) out[j] /= cnt[j];
  return out;
}
// v2.643: CSV·텍스트 가져오기/내보내기는 관리자 이상 + 'data.csv' 권한(super_admin 항상, admin 은 권한 설정에서 끌 수 있다).
const csvPerm = requireCsvPerm('data.csv');

const adminOnly = requireRole('admin');
// v2.612 AUTHZ2612-06: 베어메탈 서버는 법인 축이 없다(엣지만) — 범위 제한 admin 도 403(스토리지 모니터링과 같은 기준).
const fullScopeOnly = fullScopeOnlyWith('베어메탈 스토리지는 vCenter 범위 밖이라 전체 범위(vCenter 제한 없는) 계정만 쓸 수 있습니다.');

/**
 * 7b: 요청이 키 · 공통 계정 참조를 **새로 묶는지**(새 항목 · 주소 변경 · 다른 참조) 판정하고 참조를 확인한다(존재 · 퇴역 · 종류).
 * @returns {Promise<{binds:boolean}|{error:string, code:string, status?:number}>}
 */
export async function bmBindCheck(body = {}) {
  const KS = await import('../../bmusage/onboard/keyStore.js');
  const { bindOfWrite } = await import('../../bmusage/onboard/bindRule.js');
  const ex = body.id ? listBmServersRaw().find((x) => x.id === body.id) || null : null;
  for (const [f, kind] of [['keyRef', 'key'], ['credRef', 'acc']]) {
    if (body[f] === undefined) continue;
    const v = String(body[f] || '').trim();
    if (!v) continue;   // 떼기 — 확인할 참조가 없다
    if (kind === 'key') { const k = KS.keyById(v); if (!k) return { error: 'SSH 키가 키 저장소에 없습니다.', code: 'key-missing' }; if (k.status === 'retired') return { error: '회전으로 퇴역한 키는 고를 수 없습니다.', code: 'key-retired' }; }
    else { const a = KS.accountById(v); if (!a) return { error: '공통 계정이 없습니다.', code: 'account-missing' }; if (a.kind !== 'os') return { error: 'OS 공통 계정만 고를 수 있습니다.', code: 'account-kind' }; }
  }
  // 7b r3(R-N1): 묶음 판정은 등록부 choke point 와 **같은 함수 · 같은 입력**(bindRule.bindOfWrite) — 두 벌을 두지 않는다.
  return { binds: bindOfWrite(ex, body).binds };
}

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
   * 베어메탈: 1시간 = 원시 표(점 = 수집 주기) · 24시간 = 15분 표 · 7일 · 30일 = 1시간 표. 평균 = 디스크별 카운터 차분 평균, 피크 = 2초 표본과 구간 평균 중 큰 값(하한 — v2.971).
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
    const settings = getBmSettings();
    const bmSampleMs = Math.max(60_000, settings.intervalMinutes * 60_000);
    // v2.962(결함 수정): 격자가 수집 주기보다 촘촘하면 10칸 중 9칸이 비어 선이 끊긴 점들만 남았다(점 표시 없이 그려 아예 안 보였다 — 데모는 칸마다 값을
    //   합성해 Chromium 검증에서 드러나지 않았다). 격자를 표본 간격(베어메탈 수집 주기 · SAN 포트 수집 주기 중 큰 것)으로 넓힌다 — compareSet.gridMs.
    const sanIntervalMs = numOrNull(loadPerfSettings().intervalMs) ?? 300_000;
    const bucketMs = gridMs(sanRangeOf({ from: since, to: until, points: 120 }).bucketMs, Math.max(bmSampleMs, sanIntervalMs));
    const buckets = bucketsOf(since, until, bucketMs);
    const n = buckets.length;
    const gran = sourceFor(bucketMs);
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
        return seriesFromRaw(rows.map((r) => ({ ts: r.ts, avgTotal: pick(r, 'avg'), instTotal: pick(r, 'inst'), busy: r.busy, avgBusy: r.avgBusy })), buckets, bucketMs);
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
          try { agg = await storageSeriesMulti(switches.map((d) => d.id), { from: since, to: until, points: Math.max(10, Math.ceil((until - since) / bucketMs)), groupOf: new Map(switches.map((d) => [String(d.id), String(d.datacenterId || '')])) }); }
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
        const avg = regrid(agg.buckets, t.total, buckets, bucketMs, 'avg');
        // 피크 합 — 평균 합이 있는 버킷에서 어레이 피크를 더한다(동시 피크의 상한).
        const peakRaw = new Array(agg.buckets.length).fill(null);
        for (let i = 0; i < agg.buckets.length; i++) {
          if (t.total[i] == null) continue;
          let p = 0; for (const s of agg.series) if (endpointKind(s.key, { matched: false }) === 'array' && s.peak?.[i] != null) p += s.peak[i];
          // v2.971(반증 F8): 평균 합에는 이월 값이 들어가는데 피크 합은 피크가 있는 어레이만 더한다(부분 합) — 최소한 평균 합 위로.
          peakRaw[i] = Math.max(p, t.total[i]);
        }
        const peak = regrid(agg.buckets, peakRaw, buckets, bucketMs, 'max');
        series.push({ id: 'san:all', kind: 'san', name: 'SAN 전체', avg, peak, arrays: t.arrays, partialBuckets: t.partialBuckets, sampleMs: sanInterval, basis: sanBasis, ...summarize({ avg, peak }) });
      } else if (kind === 'san') {
        const k = normSerial(key);
        const meta = serialName.get(k) || null;
        const s = sanSeriesBySerial.get(k) || null;
        if (!s) { series.push({ id: `san:${key}`, kind: 'san', name: meta?.name || key, type: meta?.type || '', datacenterId: meta?.datacenterId || '', avg: new Array(n).fill(null), peak: new Array(n).fill(null), reason: !agg ? (!perfEnabled ? 'perf-disabled' : !switches.length ? 'no-switches' : 'perf-unavailable') : 'serial-unmatched', sampleMs: sanInterval, basis: sanBasis, ...summarize(null) }); continue; }
        const avg = regrid(agg.buckets, s.sum, buckets, bucketMs, 'avg'); const peak = regrid(agg.buckets, s.peak, buckets, bucketMs, 'max');
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

  /*
   * ── v2.962 비교 세트(사용자 요청 2026-11-10 — "SAN 스토리지 A / SAN 스토리지 B · 가 법인의 SAN 스토리지 A / 가 법인의 베어메탈 AA …") ──
   * GET /tools/bm-storage/compare-set?ids=bm:<id>,bmg:<그룹>,bmc:<법인 id>,san:<시리얼>&range=1h|24h|7d|30d[&to=ms]
   * 대상 2~4개(종류를 섞어서)를 **같은 격자**에 놓고 지표 넷(전송 속도 · IOPS · 응답 시간 · 바쁨)과 용량을 나란히 준다. 조립 규칙은 bmstor/compareSet.js 머리말.
   * 게이트 · 주소 규칙은 compare 와 같다(전체 범위 관리자 · 관리 주소 없음). 장비 호출 0 — DB · 메모리만 읽는다. 화면은 마운트 · 대상 변경 · 버튼 때만 부르고
   * 실시간 1시간(최근 구간)만 공용 usePolling 으로 다시 읽는다.
   */
  api.get('/tools/bm-storage/compare-set', adminOnly, fullScopeOnly, async (req, res) => {
    const range = rangeKeyOf(req.query.range);
    const targets = parseSetIds(req.query.ids);
    const now = Date.now();
    const toQ = numOrNull(req.query.to);
    const until = toQ != null && toQ > 0 && toQ <= now ? Math.round(toQ) : now;
    const since = until - RANGES[range].hours * 3600e3;
    const settings = getBmSettings();
    const bmSampleMs = Math.max(60_000, settings.intervalMinutes * 60_000);
    const perfSt = loadPerfSettings();
    const sanIntervalMs = numOrNull(perfSt.intervalMs) ?? 300_000;
    const FE_SAMPLE_MS = 300_000;   // 어레이 측 5분 표본(storage intervals nodeLoadMs 기본) — 위임 엣지 현장 값은 중앙이 모른다(arraySideLoad.sampleMsOf 와 같은 한계)
    const hasBm = targets.some((t) => t.kind !== 'san'); const hasSan = targets.some((t) => t.kind === 'san');
    const bucketMs = gridMs(sanRangeOf({ from: since, to: until, points: 120 }).bucketMs,
      Math.max(hasBm ? bmSampleMs : 0, hasSan ? Math.max(sanIntervalMs, FE_SAMPLE_MS) : 0));
    const buckets = bucketsOf(since, until, bucketMs);
    const n = buckets.length;
    const gran = sourceFor(bucketMs);
    const mock = isMockMode();
    const dcName = dcNameFn();
    const serversAll = serversWithCorp().filter((s) => s.enabled !== false);
    const serverById = new Map(serversAll.map((s) => [String(s.id), s]));
    const latest = getBmLatest();
    const empty = () => ({ avg: new Array(n).fill(null), peak: new Array(n).fill(null) });
    let dbDown = false;

    const bmMetricsOf = async (id) => {
      if (mock && isDemoId(id)) return demoBmIoMetrics(id, { buckets, bucketMs });
      if (gran === 'raw') { const rows = await ioRawRows(id, since, until); if (!rows) { dbDown = true; return null; } return bmMetricsFromRaw(rows, buckets, bucketMs); }
      const rows = await ioRollupRows(gran, id, since, until);
      if (!rows) { dbDown = true; return null; }
      return bmMetricsFromRollup(rows, buckets, bucketMs);
    };
    const bmTarget = async (t, members, meta) => {
      const ms = [];
      for (const s of members) { const m = await bmMetricsOf(String(s.id)); if (m) ms.push(m); }
      const single = t.kind === 'bm';
      const c = single ? null : combineBm(ms, n);
      const metrics = single ? (ms[0] || { tput: empty(), iops: empty(), lat: empty(), busy: empty() }) : c.metrics;
      const tot = aggregate(members, latest).total;
      let at = null;
      for (const s of members) { const r = latest.get(String(s.id)); if (r?.at && (at == null || r.at > at)) at = r.at; }
      const lr = single ? latest.get(String(t.key)) : null;
      // 사유 — 서버 한 대면 마지막 수집의 I/O 사유(엣지 구버전 · Linux 아님 …)가 가장 정확하다. 그 밖은 코드.
      const ioReason = dbDown ? 'db-unavailable' : (lr?.ok && !lr.io && lr.ioError ? lr.ioError : null);
      const base = ioReason || 'no-io-data';
      return {
        id: t.id, kind: t.kind, key: t.key, ...meta,
        members: { total: members.length, ok: tot.ok, measured: c ? c.measured : null, partial: c ? c.partial : null },
        capacity: tot.totalBytes > 0 ? { totalBytes: tot.totalBytes, usedBytes: tot.usedBytes, pct: tot.usedPct, basis: 'df', at } : null,
        metrics: {
          tput: finishMetric(metrics.tput, { source: 'diskstats', reason: base }),
          iops: finishMetric(metrics.iops, { source: 'diskstats', reason: ioReason || 'no-iops-data' }),
          lat: finishMetric({ avg: metrics.lat.avg, peak: metrics.lat.peak }, { source: 'diskstats', reason: ioReason || 'no-iops-data' }),
          // v2.971(반증 F3): 처리량 평균은 있는데 바쁨 평균만 없으면 ‘표본 없음’ 이 아니다 — 디스크별 카운터가 없는 구간(구버전 엣지 · v2.971 이전 기록 · 업그레이드 첫 구간).
          busy: finishMetric(metrics.busy, { source: 'diskstats-busy', reason: ioReason || ((metrics.tput.avg || []).some((v) => v != null) ? 'busy-avg-unknown' : base) }),
        },
      };
    };

    // SAN — 스위치 포트 합은 대상이 몇이든 한 번만(같은 격자 · 법인 분리 집계).
    let sanCtx = null;
    const sanContext = async () => {
      if (sanCtx) return sanCtx;
      const switches = (() => { try { return listSanSwitches().filter((d) => d.enabled !== false); } catch { return []; } })();
      const perfEnabled = demoOn(perfSt.enabled);
      let agg = null; let perfAvailable = false;
      if (perfEnabled && switches.length) {
        try { perfAvailable = await perfDbAvailable(); } catch { perfAvailable = false; }
        if (perfAvailable) {
          try {
            agg = await storageSeriesMulti(switches.map((d) => d.id), { from: since, to: until, points: Math.max(10, Math.ceil((until - since) / bucketMs)),
              groupOf: new Map(switches.map((d) => [String(d.id), String(d.datacenterId || '')])) });
          } catch { agg = null; }
        }
      }
      let devRows = [];
      try {
        const snapMap = latestSnapshotMap([storageLocalSnaps(), edgeStorageSnapshots()]);
        devRows = sanArrayRows(listStorageDevices().filter((d) => d.enabled !== false && BLOCK_ARRAY_TYPES.includes(String(d.type || ''))), snapMap);
      } catch { devRows = []; }
      let capIdx = null;
      try { capIdx = capacityIndexFor({ split: true, admin: true }); } catch { capIdx = null; }   // 내부 사용 — 응답에는 deviceId · 종류 · 수집 방식만 쓴다(주소 없음)
      sanCtx = { switches, perfEnabled, perfAvailable, agg, devRows, capIdx };
      return sanCtx;
    };
    const sanTarget = async (t) => {
      const ctx = await sanContext();
      const k = normSerial(t.key);
      const row = ctx.devRows.find((r) => r.serialKeys.includes(k)) || null;
      const dcId = row ? row.datacenterId : '';
      const meta = { name: row?.name || t.key, type: row?.type || '', serial: row?.serial || t.key, datacenterId: dcId, datacenterName: dcId ? dcName(dcId) : '(법인 미지정)' };
      if (!row) return { id: t.id, kind: 'san', key: t.key, ...meta, missing: true, reason: 'unknown-target', capacity: null,
        metrics: Object.fromEntries(METRIC_KEYS.map((mk) => [mk, finishMetric(empty(), { reason: 'unknown-target' })])) };
      // 전송 속도 — 스위치 포트(같은 법인 계열 우선)
      let sw = null;
      for (const s of ctx.agg?.series || []) {
        if (normSerial(arraySerialOf(s.key)) !== k) continue;
        if (row && (s.group ?? '') !== dcId && sw) continue;
        if (!sw || ((s.group ?? '') === dcId && (sw.group ?? '') !== dcId) || (Number(s.avgTotal) || 0) > (Number(sw.avgTotal) || 0)) sw = s;
      }
      const swReason = !ctx.perfEnabled ? 'perf-disabled' : !ctx.switches.length ? 'no-switches' : !ctx.perfAvailable || !ctx.agg ? 'perf-unavailable' : 'serial-unmatched';
      // 어레이 측 5분 표본(IOPS · 응답 시간 · 바쁨 · 호스트 처리량)
      const cap = ctx.capIdx ? ctx.capIdx.lookup(row.serial || t.key, dcId) : null;
      const el = feEligibility(cap);
      let fe = null;
      if (el.eligible) {
        try {
          const units = unitsForArray(await nodeUnitsOf(cap.deviceId), { serial: row.serial || t.key });
          const wk = feWindowKind(since, until, { now });
          const q = await nodeLoadQuery(cap.deviceId, { group: 'fe', kind: wk.kind, from: since, to: until, bucketMs: wk.bucketMs });
          fe = feMetrics(q.rows, units, buckets, bucketMs);
        } catch { fe = null; }
      }
      const feReason = el.eligible ? (fe && fe.samples ? null : 'fe-no-sample') : `fe-${el.reason || 'no-device'}`;
      let tput = null; let tputSource = null;
      if (sw) { tput = switchTput(ctx.agg.buckets, sw.sum, sw.peak, buckets, bucketMs); tputSource = 'switch-port'; }
      else if (fe && (fe.hbps.avg || []).some((v) => v != null)) { tput = fe.hbps; tputSource = 'array-fe-hbps'; }
      return {
        id: t.id, kind: 'san', key: t.key, ...meta,
        capacity: row.capacity ? { ...row.capacity, basis: row.capacity.basis || 'unisphere' } : null,
        fe: { eligible: el.eligible, reason: feReason, units: fe?.units ?? 0, busyBasis: fe?.busyBasis ?? null },
        switchPorts: sw ? (Array.isArray(sw.ports) ? sw.ports.length : 0) : 0,
        metrics: {
          tput: finishMetric(tput || empty(), { source: tputSource, reason: tput ? null : swReason }),
          iops: finishMetric(fe?.iops || empty(), { source: 'array-fe', reason: feReason }),
          lat: finishMetric(fe?.lat || empty(), { source: 'array-fe', reason: feReason }),
          busy: finishMetric(fe?.busy || empty(), { source: fe?.busyBasis === 'cpu' ? 'array-fe-cpu' : 'array-fe-busy', reason: feReason }),
        },
      };
    };

    const out = [];
    for (const t of targets) {
      if (t.kind === 'san') { out.push(await sanTarget(t)); continue; }
      let members = []; let meta = {};
      if (t.kind === 'bm') {
        const s = serverById.get(String(t.key));
        if (s) members = [s];
        meta = { name: s?.name || t.key, groups: s?.groups || [], datacenterId: s?.datacenterId || '', datacenterName: s?.datacenterId ? dcName(s.datacenterId) : '(법인 미지정)', datacenterSource: s?.datacenterSource || '' };
      } else if (t.kind === 'bmg') {
        members = serversAll.filter((s) => (s.groups || []).includes(t.key));
        const dcs = [...new Set(members.map((s) => s.datacenterId || ''))];
        meta = { name: t.key, datacenterId: dcs.length === 1 ? dcs[0] : null, datacenterName: dcs.length === 1 ? (dcs[0] ? dcName(dcs[0]) : '(법인 미지정)') : `법인 ${dcs.length}곳` };
      } else {
        const dc = t.key === NONE_DC ? '' : t.key;
        members = serversAll.filter((s) => String(s.datacenterId || '') === dc);
        meta = { name: dc ? dcName(dc) : '(법인 미지정)', datacenterId: dc, datacenterName: dc ? dcName(dc) : '(법인 미지정)' };
      }
      if (!members.length) {
        out.push({ id: t.id, kind: t.kind, key: t.key, ...meta, missing: true, reason: 'unknown-target', capacity: null, members: { total: 0 },
          metrics: Object.fromEntries(METRIC_KEYS.map((mk) => [mk, finishMetric(empty(), { reason: 'unknown-target' })])) });
        continue;
      }
      out.push(await bmTarget(t, members, meta));
    }
    res.json({
      ok: true, range, since, until, bucketMs, gran, buckets, targets: out,
      sampleMs: { bm: bmSampleMs, san: sanIntervalMs, fe: FE_SAMPLE_MS }, retention: ioRetention(), db: await bmIoDbStatus(),
      ...(mock ? { demo: true } : {}),
    });
  });

  // 서버 추가/수정 — body { id?, name, host, port, username, password?, agent, groups(최대 3개), mounts, enabled }
  api.post('/tools/bm-storage/servers', adminOnly, fullScopeOnly, async (req, res) => {
    // 7b 메인 결정(감사 H-1 · 반증 F1 · Q4): SSH 키 · 공통 계정을 이 주소에 **묶는(바꾸는)** 저장은 그 비밀을 관리하는 등급과 같다 —
    //   설정 소유자 등급 + 본인 OTP(마지막). 존재 · 퇴역 · 종류도 여기서 본다(형식만 보던 것). 참조를 떼는 것(빈 값)은 묶음이 아니다.
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const bind = await bmBindCheck(body);
    if (bind.error) return res.status(bind.status || 400).json({ ok: false, code: bind.code, reason: bind.error });
    if (bind.binds) {
      const { runGate } = await import('./bmOnboard.js');
      const { reauth } = await import('./reauth.js');
      const g1 = await runGate(requireSettingsOwner, req);
      if (!g1.ok) return res.status(g1.status).json({ ...g1.body, reason: '공통 계정 · SSH 키를 서버 주소에 묶는 저장은 설정 소유자(전체 범위)만 할 수 있습니다 — 개별 비밀번호로 등록하거나 소유자에게 맡기세요.' });
      const g2 = await runGate(reauth, req);
      if (!g2.ok) return res.status(g2.status).json(g2.body);
    }
    // 7b r3(R-N1): bindApproved 는 **위 두 게이트를 통과했을 때만** 이 라우트가 세운다 — 클라이언트가 보낸 값은 버린다(등록부 choke point 가 이 칸만 본다).
    const { otp, bindApproved: _clientApproval, ...rest } = body; void otp; void _clientApproval;
    const r = saveBmServer(bind.binds ? { ...rest, bindApproved: true } : rest);
    if (r.ok && bind.binds) logAudit({ user: req.user?.username, action: '베어메탈 서버 인증 참조 묶음', target: r.server?.host || '', detail: JSON.stringify({ keyRef: rest.keyRef || '', credRef: rest.credRef || '', osAuth: rest.osAuth || '' }).slice(0, 200), ip: req.ip || '' });
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
