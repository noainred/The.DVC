/**
 * SAN 스토리지 성능 라우트(v2.948 — 독립 도구 `san-storage` · 설계 docs/design/san-storage-perf · 사용자 컨펌 2026-11-08).
 *
 * 무엇: 스위치 portperfshow 표본을 **어레이 → 디렉터(PowerMax FA) · 컨트롤러(PowerStore Node · Unity SP) → 포트**로 묶어
 *   지금 · 회선 사용률 · 24시간 평균/피크 · 7일 대비 · 편중 · 팹 비대칭 · 회선 포화 · 수집 상태를 보여 준다. 조립은 sanswitch/storageList.js(순수) ·
 *   판정은 storagePerfCheck.js(순수) · 디렉터 해석은 directorOf.js(순수) · 관리자 재정의는 directorMap.js · 임계값은 storageCheckSettings.js.
 * 접근(형제 sanswitch 라우트와 같은 게이트): 조회 = tools 권한 + 전체 범위(SAN 은 vCenter 범위 밖 — 범위 계정에 노출하지 않는다) ·
 *   임계값 · 매핑 PUT = admin + 조회 · 쓰기 전체 범위(fullRwOnly) + 감사 로그 · 포트 이름 CSV = data.csv + admin + 전체 범위(WWN · 시리얼).
 *   비-admin 응답은 스위치 주소를 가린다(maskDeviceAddress · addressHidden) — 등록부 이름 폴백도 가린 행으로.
 * 무거운 집계는 perfDb.heavyQuery(기억 TTL = 수집 주기 · lane multi · 취소 전달)만 — memoJson 을 겹치지 않는다. 조회 두 번(최근 1시간 60초 칸 ·
 *   최근 7일 1시간 칸 + 포트별)이고 '지금 합계' KPI 는 트래픽 카드와 **같은 함수**(trafficTotal.sumArrayTraffic)로 낸다.
 * 어레이 측 성능(busy% · IOPS · 응답 시간 · CPU)은 다음 판(수집기) — 이 판의 점검은 그 항목을 unknown('어레이 측 성능 미수집')으로 둔다(거짓 정상 금지).
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { fullScopeOnlyWith, fullReadWriteScopeOnlyWith } from '../admin/shared.js';
import { isAdminReq, maskDeviceAddress } from '../../auth/addressMask.js';
import { logAudit } from '../../audit.js';
import { listDevices } from '../../sanswitch/registry.js';
import { listDatacenters } from '../../datacenter/store.js';
import { storageSeriesMulti, latestSampleTs, endpointKind, perfQueryTtlMs, arraySerialOf, storageKey, metaFor } from '../../sanswitch/perfDb.js';
import { loadPerfSettings } from '../../sanswitch/perfSettings.js';
import { sumArrayTraffic } from '../../sanswitch/trafficTotal.js';
import { buildStorageRows, rowTotals, STATE_TEXT, MIN_PREV_HOURS } from '../../sanswitch/storageList.js';
import { checkArray, summarizeChecks, CHECK_ITEMS, IMBALANCE_BAD_RATIO, FABRIC_MIN_BPS } from '../../sanswitch/storagePerfCheck.js';
import { loadCheckSettings, saveCheckSettings, publicCheckSettings } from '../../sanswitch/storageCheckSettings.js';
import { loadDirectorMap, saveDirectorMap, directorMapKey, MAP_LIMITS } from '../../sanswitch/directorMap.js';
import { directorOf, applyDirectorOverride, VENDOR_LABEL, UNPARSED_GROUP, groupLabel } from '../../sanswitch/directorOf.js';
import { IMBALANCE_MIN_BPS, IMBALANCE_RATIO } from '../../sanswitch/portUsage.js';
import { rangeParams, NONE_DC, capacityIndexFor, perfAbortSignal, abandoned } from './sanSwitch.js';
import { isMockMode, demoOn } from '../../mock/demo/flags.js';
import { ensureSanSwitchDemo } from '../../sanswitch/poller.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { numOrNull } from '../../util/numOrNull.js';
import { DAY_OFFSET_MIN, todayStamp } from '../../util/dayKey.js';   // 요일 × 시간 히트맵은 포탈 하루(한국 시각) 기준으로 화면이 접는다 · 파일명 날짜도 포탈 날짜(BUG-3 — UTC 날짜 금지)

const toolsPerm = requirePerm('tools');
const adminOnly = requireRole('admin');
const csvPerm = requirePerm('data.csv');
const fullScopeOnly = fullScopeOnlyWith('SAN 스토리지 성능은 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다.');
const fullRwOnly = fullReadWriteScopeOnlyWith('SAN 스토리지 성능의 기준 · 분류 · 매핑 변경은 조회 · 쓰기 모두 전체 범위(vCenter 제한 없는) 관리자만 할 수 있습니다.');

/** 최근 1시간(지금 · 스파크 — 60초 칸) · 최근 7일(24시간 창 · 앞 6일 · 디렉터 · 포트 — 1시간 칸). 숫자는 설계 §4.1 — 화면에 박지 않고 응답에 싣는다. */
export const LIST_WINDOWS = Object.freeze({ nowHours: 1, nowPoints: 60, trendHours: 168, trendPoints: 168 });
const KEY_MAX = 160;

/** 요청의 법인 필터 · 장비 · 이름 · 가림 — 형제 라우트(storage-summary)와 같은 규칙. */
async function deviceContext(req) {
  if (isMockMode()) { try { await ensureSanSwitchDemo(); } catch { /* 데모 시드 실패는 빈 목록 */ } }
  const admin = isAdminReq(req);
  const dcs = String(req.query.datacenterId || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => (x === NONE_DC ? '' : x));
  const dcSet = dcs.length ? new Set(dcs) : null;
  const raw = listDevices().filter((d) => d.enabled !== false && (!dcSet || dcSet.has(String(d.datacenterId || ''))));
  const devices = admin ? raw : raw.map(maskDeviceAddress);
  const dcNameOf = (() => {
    try { const m = new Map(listDatacenters().map((x) => [x.id, x.name || x.id])); return (id) => m.get(id) || id || '(법인 미지정)'; }
    catch { return (id) => id || '(법인 미지정)'; }
  })();
  const deviceMeta = new Map(devices.map((d) => [String(d.id), { name: d.name || d.host || d.id, datacenterId: String(d.datacenterId || ''), datacenterName: dcNameOf(d.datacenterId), agent: String(d.agent || '').trim() }]));
  const groupOf = new Map(devices.map((d) => [String(d.id), String(d.datacenterId || '')]));
  const allDatacenters = (() => {
    const m = new Map();
    for (const d of listDevices().filter((x) => x.enabled !== false)) {
      const id = String(d.datacenterId || '');
      if (!m.has(id)) m.set(id, { id: id || NONE_DC, name: dcNameOf(id), switches: 0 });
      m.get(id).switches++;
    }
    return [...m.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  })();
  return { admin, dcs, dcSet, devices, ids: devices.map((d) => d.id), deviceMeta, groupOf, dcNameOf, allDatacenters };
}

/** 분류 — 관리자 재정의 > 등록 스토리지 시리얼 일치 > 이름 규칙(endpointKind — `::` 이면 어레이 추정) . 근거도 함께 준다. */
function kindResolver(capIdx, map) {
  return (key, dcId) => {
    const ov = map.kinds[String(key)];
    if (ov) return { kind: ov.kind, basis: 'manual' };
    const serial = arraySerialOf(key);
    if (serial && capIdx.lookup(serial, dcId)) return { kind: 'array', basis: 'serial' };
    const k = endpointKind(key, { matched: false });
    return { kind: k, basis: k === 'unknown' ? 'none' : (String(key).includes('::') ? 'name' : 'flat') };
  };
}
/** 디렉터 — 관리자 매핑 > 이름 규칙(> 조닝 별칭 — 이 판은 별칭을 넘기지 않는다 · README §8). */
function directorResolver(map) {
  return (port, key) => applyDirectorOverride(directorOf(port.name), map.directors[directorMapKey(key, port.deviceId, port.port)] || null);
}

async function loadAggs(ctx, signal) {
  return Promise.all([
    storageSeriesMulti(ctx.ids, { hours: LIST_WINDOWS.nowHours, points: LIST_WINDOWS.nowPoints, groupOf: ctx.groupOf, signal }),
    storageSeriesMulti(ctx.ids, { hours: LIST_WINDOWS.trendHours, points: LIST_WINDOWS.trendPoints, groupOf: ctx.groupOf, withPorts: true, signal }),
  ]);
}

/** 현황 · 점검이 같이 쓰는 조립 — 응답하지 않고 돌려준다(abandoned 면 null). */
async function buildList(req, res) {
  const ctx = await deviceContext(req);
  const st = loadPerfSettings();
  let agg1h; let agg7d;
  try { [agg1h, agg7d] = await loadAggs(ctx, perfAbortSignal(res)); }
  catch (e) { if (abandoned(e)) return null; throw e; }
  let lastTs = new Map();
  try { lastTs = await latestSampleTs(ctx.ids); } catch { /* DB 불가 — unavailable 이 말한다 */ }
  const map = loadDirectorMap();
  const capIdx = capacityIndexFor({ dcSet: ctx.dcSet, split: true, admin: ctx.admin });
  const kindOf = kindResolver(capIdx, map);
  const directorFor = directorResolver(map);
  const carryMs = numOrNull(agg1h.carryMs) ?? (Number(st.intervalMs) || 300_000) * 2;
  const now = Date.now();
  const { rows, counts } = buildStorageRows({
    agg1h, agg7d, deviceMeta: ctx.deviceMeta, deviceLastTs: lastTs, now, carryMs,
    kindOf: (key, dc) => kindOf(key, dc).kind,
    capacityOf: (key, dc) => capIdx.lookup(arraySerialOf(key), dc),
    directorFor,
  });
  for (const r of rows) { r.vendorLabel = VENDOR_LABEL[r.vendor] || VENDOR_LABEL.other; r.kindBasis = kindOf(r.key, r.datacenterId).basis; r.name = r.capacity?.name || r.key; }
  // 지금 합계 — 트래픽 카드(traffic-total)와 같은 함수 · 같은 분류(둘이 다르면 결함).
  const total = sumArrayTraffic(agg1h, { isArray: (s) => kindOf(s.key, s.group ?? '').kind === 'array', carryMs, activeDeviceIds: new Set(ctx.ids.map(String)), deviceLastTs: lastTs });
  let lastSampleAt = null;
  for (const v of lastTs.values()) if (Number.isFinite(Number(v)) && (lastSampleAt == null || Number(v) > lastSampleAt)) lastSampleAt = Number(v);
  const edgeRaw = ctx.devices.filter((d) => String(d.agent || '').trim());
  return { ctx, st, agg1h, agg7d, lastTs, map, rows, counts, total, carryMs, now, lastSampleAt,
    edgeSwitches: edgeRaw.length, edgeMissing: edgeRaw.filter((d) => !lastTs.get(String(d.id))).length };
}

const commonMeta = (b) => ({
  unit: 'bytesPerSec', datacenterIds: b.ctx.dcs.map((x) => x || NONE_DC), allDatacenters: b.ctx.allDatacenters,
  intervalMs: b.st.intervalMs, enabled: demoOn(b.st.enabled), carryMs: b.carryMs, windows: LIST_WINDOWS, minPrevHours: MIN_PREV_HOURS,
  imbalanceRule: { minBps: IMBALANCE_MIN_BPS, ratio: IMBALANCE_RATIO, badRatio: IMBALANCE_BAD_RATIO }, fabricMinBps: FABRIC_MIN_BPS,
  unavailable: !!(b.agg1h.unavailable || b.agg7d.unavailable), computedAt: b.agg7d.computedAt ?? b.agg1h.computedAt ?? null, cacheTtlMs: perfQueryTtlMs(),
  source: b.agg7d.source ?? null, lastSampleAt: b.lastSampleAt, edgeSwitches: b.edgeSwitches, edgeMissing: b.edgeMissing,
  mapStatus: { kinds: Object.keys(b.map.kinds).length, directors: Object.keys(b.map.directors).length },
  stateText: STATE_TEXT, ...(isMockMode() ? { demo: true } : {}), ...(b.ctx.admin ? {} : { addressHidden: true }),
});

/** 디렉터 · 팹 묶음 시계열(순수) — 포트별 avg 를 그룹으로 더한다(자기 표본이 하나도 없는 칸은 null). */
export function groupedSeries(portsDetail = [], groupKeyOf, n) {
  const by = new Map();
  for (const p of portsDetail) {
    const g = groupKeyOf(p);
    if (!by.has(g.key)) by.set(g.key, { ...g, ports: 0, sum: new Array(n).fill(null), peak: new Array(n).fill(null) });
    const s = by.get(g.key); s.ports++;
    for (let j = 0; j < n; j++) {
      if (p.avg?.[j] == null) continue;
      s.sum[j] = (s.sum[j] ?? 0) + p.avg[j];
      s.peak[j] = (s.peak[j] ?? 0) + (p.peak?.[j] ?? 0);
    }
  }
  return [...by.values()];
}

export function registerSanStorage(api) {
  /** 현황 — 어레이 행 전부(법인 필터 · 선택) + KPI + 상태 코드 표. */
  api.get('/tools/san-storage', toolsPerm, fullScopeOnly, async (req, res) => {
    const b = await buildList(req, res);
    if (!b) return;
    const kindQ = String(req.query.kind || '');   // 'host' 를 고르면 호스트 키 목록만(이름 · 개수 — 표가 아니라 '어레이로 지정' 후보)
    const hostKeys = kindQ === 'host'
      ? (b.agg7d.series || []).filter((s) => kindResolver(capacityIndexFor({ dcSet: b.ctx.dcSet, split: true, admin: b.ctx.admin }), b.map)(s.key, s.group ?? '').kind === 'host')
        .slice(0, 2000).map((s) => ({ key: s.key, datacenterId: s.group ?? '', datacenterName: b.ctx.dcNameOf(s.group ?? ''), ports: (s.ports || []).length }))
      : undefined;
    res.json({
      ok: true, ...commonMeta(b), rows: b.rows, counts: b.counts,
      totals: { nowBps: b.total.now?.bps ?? null, nowTs: b.total.now?.ts ?? null, avgBps: b.total.avg ?? null, peak: b.total.peak ?? null,
        measuredBuckets: b.total.measuredBuckets, partialBuckets: b.total.partialBuckets, retiredSeries: b.total.retiredSeries ?? 0, heldSeries: b.total.heldSeries ?? 0,
        ...rowTotals(b.rows) },
      ...(hostKeys ? { hostKeys } : {}),
    });
  });

  /** 어레이 상세 — 기간(hours | from·to) · 합계 · 디렉터별 · 팹별 · 포트별 시계열(조회 한 번 · 화면이 묶는다). */
  api.get('/tools/san-storage/array', toolsPerm, fullScopeOnly, async (req, res) => {
    const key = String(req.query.key || '').slice(0, KEY_MAX);
    if (!key) return res.status(400).json({ ok: false, reason: 'key(어레이 키)가 필요합니다' });
    const { hours, from, to, issue } = rangeParams(req.query);
    const ctx = await deviceContext(req);
    const st = loadPerfSettings();
    let agg;
    try { agg = await storageSeriesMulti(ctx.ids, { hours, from, to, groupOf: ctx.groupOf, withPorts: true, signal: perfAbortSignal(res) }); }
    catch (e) { if (abandoned(e)) return; throw e; }
    const map = loadDirectorMap();
    const capIdx = capacityIndexFor({ dcSet: ctx.dcSet, split: true, admin: ctx.admin });
    const kindOf = kindResolver(capIdx, map);
    const directorFor = directorResolver(map);
    const cands = (agg.series || []).filter((s) => s.key === key);
    const s = cands.length <= 1 ? cands[0] : (cands.find((x) => ctx.dcs.includes(x.group ?? '')) || cands[0]);
    if (!s) return res.status(404).json({ ok: false, reason: '이 범위 · 기간에서 그 스토리지의 표본을 찾지 못했습니다.', ...(isMockMode() ? { demo: true } : {}) });
    const dcId = s.group ?? '';
    const n = (agg.buckets || []).length;
    const ports = (s.portsDetail || []).map((p) => {
      const d = directorFor({ deviceId: String(p.deviceId), port: Number(p.port), name: p.name || '' }, key);
      const meta = ctx.deviceMeta.get(String(p.deviceId)) || { name: String(p.deviceId) };
      const vals = (p.avg || []).filter((v) => v != null); const pk = (p.peak || []).filter((v) => v != null);
      return { deviceId: String(p.deviceId), deviceName: meta.name, port: Number(p.port), name: p.name || '', speed: p.speed || '', portType: p.portType || '',
        group: groupLabel(d.group), confidence: d.confidence, directorPort: d.port || '', avg: p.avg, peak: p.peak,
        avgTotal: vals.length ? vals.reduce((a, c) => a + c, 0) / vals.length : null, maxPeak: pk.length ? Math.max(...pk) : null };
    });
    const directors = groupedSeries(s.portsDetail || [], (p) => { const d = directorFor({ deviceId: String(p.deviceId), port: Number(p.port), name: p.name || '' }, key); return { key: groupLabel(d.group), group: groupLabel(d.group), confidence: d.confidence, parsed: d.group != null }; }, n)
      .sort((a, b) => (a.parsed === b.parsed ? a.group.localeCompare(b.group) : a.parsed ? -1 : 1));
    const fabrics = groupedSeries(s.portsDetail || [], (p) => ({ key: String(p.deviceId), deviceId: String(p.deviceId), name: (ctx.deviceMeta.get(String(p.deviceId)) || { name: String(p.deviceId) }).name }), n);
    const kind = kindOf(key, dcId);
    const vendor = ports[0] ? directorOf(ports[0].name).vendor : 'other';
    const capacity = capIdx.lookup(arraySerialOf(key), dcId);
    res.json({
      ok: true, unit: 'bytesPerSec', key, name: capacity?.name || key, serial: arraySerialOf(key), vendor, vendorLabel: VENDOR_LABEL[vendor] || VENDOR_LABEL.other,
      kind: kind.kind, kindBasis: kind.basis, datacenterId: dcId, datacenterName: ctx.dcNameOf(dcId),
      switches: (s.deviceIds || []).map((id) => { const m = ctx.deviceMeta.get(String(id)) || { name: String(id) }; return { id: String(id), name: m.name, agent: m.agent || '' }; }),
      hours, from, to, rangeIssue: issue || null, buckets: agg.buckets, bucketMs: agg.bucketMs, since: agg.since ?? null, until: agg.until ?? null,
      sum: s.sum, peak: s.peak, avgTotal: s.avgTotal, maxTotal: s.maxTotal, peakAvg: s.peakAvg, peakTotal: s.peakTotal,
      partial: s.partial || [], partialBuckets: s.partialBuckets || 0, carriedCells: s.carriedCells || 0,
      directors, fabrics, ports, capacity, unparsedGroup: UNPARSED_GROUP,
      intervalMs: st.intervalMs, carryMs: agg.carryMs ?? null, enabled: demoOn(st.enabled), unavailable: !!agg.unavailable, offsetMin: DAY_OFFSET_MIN,
      computedAt: agg.computedAt ?? null, cacheTtlMs: perfQueryTtlMs(), source: agg.source ?? null,
      ...(isMockMode() ? { demo: true } : {}), ...(ctx.admin ? {} : { addressHidden: true }),
    });
  });

  /** 성능 점검 — 어레이 × 항목 9(스위치 측 4 는 판정 · 어레이 측 5 는 이 판에서 unknown) + 임계값 · 요약. 저장 표본만 판정(새 접속 없음). */
  api.get('/tools/san-storage/check', toolsPerm, fullScopeOnly, async (req, res) => {
    const b = await buildList(req, res);
    if (!b) return;
    const settings = loadCheckSettings();
    const results = b.rows.map((r) => ({ ...checkArray(r, settings), name: r.name, vendor: r.vendor, vendorLabel: r.vendorLabel, datacenterName: r.datacenterName, state: r.state }));
    res.json({ ok: true, ...commonMeta(b), items: CHECK_ITEMS, results, summary: summarizeChecks(results), settings: publicCheckSettings(), judgedAt: b.now });
  });

  api.get('/tools/san-storage/check-settings', toolsPerm, fullScopeOnly, (_req, res) => {
    res.json({ ok: true, ...publicCheckSettings(), imbalanceRule: { minBps: IMBALANCE_MIN_BPS, ratio: IMBALANCE_RATIO, badRatio: IMBALANCE_BAD_RATIO } });
  });
  /** 임계값 저장 — null = 비움(판정 안 함) · 빈 값 · 미지정 = 기본값으로. 형식 오류 400. 감사 로그. */
  api.put('/tools/san-storage/check-settings', adminOnly, fullRwOnly, (req, res) => {
    const r = saveCheckSettings(req.body || {}, { by: req.user?.username || '' });
    if (r.issue) return res.status(400).json({ ok: false, reason: r.issue });
    logAudit({ user: req.user?.username, action: 'SAN 스토리지 성능 점검 기준 변경', target: 'storage-perf-check.json', detail: `사용자 설정 ${r.settings.userSet.length}개: ${r.settings.userSet.join(', ') || '(전부 기본값)'}` });
    res.json({ ok: true, ...publicCheckSettings() });
  });

  /** 분류 · 디렉터 매핑 — 현재 저장값 + 후보(자동이 못 읽은 포트 · 이름 규칙만으로 분류된 키 · 재정의된 것). */
  api.get('/tools/san-storage/mapping', toolsPerm, fullScopeOnly, async (req, res) => {
    const b = await buildList(req, res);
    if (!b) return;
    const capIdx = capacityIndexFor({ dcSet: b.ctx.dcSet, split: true, admin: b.ctx.admin });
    const kindOf = kindResolver(capIdx, b.map);
    const targets = [];
    const ports = [];
    for (const s of b.agg7d.series || []) {
      const dcId = s.group ?? '';
      const k = kindOf(s.key, dcId);
      const first = (s.portsDetail || [])[0]?.name || '';
      const ov = b.map.kinds[s.key] || null;
      // 후보: 수동 재정의가 있거나 · 이름 규칙으로만 어레이가 된 것 · 평평한 이름(호스트) 중 `::` 없는 것은 수천 개라 'array' 와 재정의만.
      if (ov || k.basis === 'name' || k.kind === 'array') {
        targets.push({ key: s.key, datacenterId: dcId, datacenterName: b.ctx.dcNameOf(dcId), vendor: directorOf(first).vendor, autoKind: ov ? kindResolverNoOverride(capIdx)(s.key, dcId) : k, applied: k.kind, basis: k.basis, override: ov, firstName: first, ports: (s.ports || []).length });
      }
      if (k.kind !== 'array') continue;
      for (const p of s.portsDetail || []) {
        const auto = directorOf(p.name || '');
        const mk = directorMapKey(s.key, p.deviceId, p.port);
        const ov2 = b.map.directors[mk] || null;
        if (auto.group != null && !ov2) continue;
        ports.push({ mapKey: mk, key: s.key, datacenterId: dcId, deviceId: String(p.deviceId), deviceName: (b.ctx.deviceMeta.get(String(p.deviceId)) || { name: String(p.deviceId) }).name,
          port: Number(p.port), name: p.name || '', auto: { group: auto.group, confidence: auto.confidence, vendor: auto.vendor }, override: ov2,
          nameChanged: !!(ov2 && ov2.name && ov2.name !== (p.name || '')) });
      }
    }
    targets.sort((a, b2) => (a.override ? -1 : b2.override ? 1 : 0) || a.key.localeCompare(b2.key));
    res.json({ ok: true, ...commonMeta(b), counts: b.counts, map: { kinds: b.map.kinds, directors: b.map.directors, updatedAt: b.map.updatedAt, updatedBy: b.map.updatedBy }, limits: MAP_LIMITS,
      targets: targets.slice(0, 2000), targetsOmitted: Math.max(0, targets.length - 2000), ports: ports.slice(0, 4000), portsOmitted: Math.max(0, ports.length - 4000),
      unparsedGroup: UNPARSED_GROUP });
  });
  /** 매핑 저장(전체 교체) — 관리자 · 전체 범위 · 감사 로그. 형식 오류 400(조용히 버리지 않는다). */
  api.put('/tools/san-storage/mapping', adminOnly, fullRwOnly, (req, res) => {
    const r = saveDirectorMap(req.body || {}, { by: req.user?.username || '' });
    if (r.issue) return res.status(400).json({ ok: false, reason: r.issue });
    logAudit({ user: req.user?.username, action: 'SAN 스토리지 분류 · 디렉터 매핑 변경', target: 'san-storage-map.json', detail: `분류 재정의 ${Object.keys(r.map.kinds).length}개 · 디렉터 매핑 ${Object.keys(r.map.directors).length}개` });
    res.json({ ok: true, map: r.map });
  });

  /** 포트 이름 CSV — port_meta 의 연결 장비 심볼릭 이름 · WWN · 속도(벤더 이름 형식 확인용 — 스위치에 접속하지 않는다). WWN · 시리얼이라 관리자 + data.csv. */
  api.get('/tools/san-storage/port-names.csv', csvPerm, adminOnly, fullScopeOnly, async (req, res) => {
    const ctx = await deviceContext(req);
    const rows = await metaFor(ctx.ids);
    const map = loadDirectorMap();
    const head = ['스위치', '법인', '포트', '연결 장비 이름', 'WWN', '속도', '포트 종류', '어레이 키', '자동 분류', '디렉터(자동)', '근거', '수동 매핑', '이름 갱신 시각'];
    const lines = [head];
    for (const r of rows) {
      const key = storageKey(r.name);
      const d = directorOf(r.name || '');
      const ov = map.directors[directorMapKey(key, r.d, r.p)] || null;
      const meta = ctx.deviceMeta.get(String(r.d)) || { name: String(r.d), datacenterName: '' };
      lines.push([meta.name, meta.datacenterName, r.p, r.name || '', r.wwn || '', r.speed || '', r.type || '', key, map.kinds[key]?.kind || endpointKind(key, { matched: false }),
        groupLabel(d.group), d.confidence, ov ? ov.group : '', r.ts ? new Date(Number(r.ts)).toISOString() : '']);
    }
    logAudit({ user: req.user?.username, action: 'SAN 스토리지 포트 이름 CSV 내보내기', target: `스위치 ${ctx.ids.length}대`, detail: `${lines.length - 1}행` });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="san-port-names_${todayStamp()}.csv"`);
    res.send(CSV_BOM + lines.map((x) => csvLine(x)).join('\r\n') + '\r\n');
  });
}

/** 재정의를 뺀 자동 분류(매핑 화면이 '자동 → 적용' 을 나란히 보여 주려고). */
function kindResolverNoOverride(capIdx) {
  return (key, dcId) => {
    const serial = arraySerialOf(key);
    if (serial && capIdx.lookup(serial, dcId)) return { kind: 'array', basis: 'serial' };
    const k = endpointKind(key, { matched: false });
    return { kind: k, basis: k === 'unknown' ? 'none' : (String(key).includes('::') ? 'name' : 'flat') };
  };
}
