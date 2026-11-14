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
 * 어레이 측 성능(디렉터 busy% · IOPS · 응답 시간 · 노드/SP CPU · 큐 · 호스트 처리량)은 v2.952 부터 스토리지 수집기의 5분 표본(storage/collectors/arrayPerf.js)에서
 *   시리얼로 짝 지어 읽는다(sanswitch/arraySideLoad.js — 장비 호출 0). 값이 없으면 점검은 unknown 에 사유를 적는다(거짓 정상 금지).
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { fullScopeOnlyWith, fullReadWriteScopeOnlyWith } from '../admin/shared.js';
import { isAdminReq, maskDeviceAddress } from '../../auth/addressMask.js';
import { logAudit } from '../../audit.js';
import { storageSeriesMulti, endpointKind, perfQueryTtlMs, arraySerialOf, storageKey, metaFor } from '../../sanswitch/perfDb.js';
import { loadPerfSettings } from '../../sanswitch/perfSettings.js';
import { sumArrayTraffic } from '../../sanswitch/trafficTotal.js';
import { rowTotals, STATE_TEXT, MIN_PREV_HOURS } from '../../sanswitch/storageList.js';
import { CHECK_ITEMS, IMBALANCE_BAD_RATIO, FABRIC_MIN_BPS } from '../../sanswitch/storagePerfCheck.js';
import { loadArraySide } from '../../sanswitch/arraySideLoad.js';   // v2.952 어레이 측 성능(디렉터 · 노드 · SP)
import { islCluesFor } from '../../sanswitch/islClue.js';              // v2.952(H) 팹 비대칭 단서 — E-포트 피크 포화도
import { foldBaseline, compareToBaseline, baselineSummary, BASELINE_WEEKS_DEF } from '../../sanswitch/storageBaseline.js';   // v2.950(§12.2-7) 자기 기준선
import { loadNotifySettings, saveNotifySettings, notifyLoadError, loadNotifyState, MIN_LEVELS } from '../../sanswitch/storagePerfNotifyStore.js';   // v2.950(§12.2-6) 알림 설정 · 상태(러너는 동적 import — 순환 방지)
import { loadCheckSettings, saveCheckSettings, publicCheckSettings } from '../../sanswitch/storageCheckSettings.js';
import { loadDirectorMap, saveDirectorMap, directorMapKey, MAP_LIMITS } from '../../sanswitch/directorMap.js';
import { directorOf, VENDOR_LABEL, UNPARSED_GROUP, groupLabel } from '../../sanswitch/directorOf.js';
import { IMBALANCE_MIN_BPS, IMBALANCE_RATIO } from '../../sanswitch/portUsage.js';
import { rangeParams, NONE_DC, capacityIndexFor, perfAbortSignal, abandoned } from './sanSwitch.js';
import { LIST_WINDOWS, deviceContextOf, buildListCore, growthLookup, runCheck, _resetGrowthMemoForTest, kindResolver, directorResolver, aliasLookupFor } from '../../sanswitch/storagePerfCore.js';   // v2.953 판정 코어(라우트 밖 — 알림 · 보고서 · 공개 API 와 공유)
export { LIST_WINDOWS, deviceContextOf, buildListCore, growthLookup, runCheck, _resetGrowthMemoForTest };
import { storagePerfNotifyStatus, pollStoragePerfNotifyOnce } from '../../sanswitch/storagePerfNotify.js';
import { storagePerfReportStatus, saveReportSettings, buildReport, sendReportNow } from '../../sanswitch/storagePerfReportMail.js';
import { recordCheckRuns, listCheckRuns, checkHistoryOverview, checkHistoryStatus } from '../../sanswitch/storageCheckHistory.js';   // v2.955 점검 결과 이력
import { scopeDbStatus } from '../../auth/scopeStatus.js';
import { isMockMode, demoOn } from '../../mock/demo/flags.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { DAY_OFFSET_MIN, todayStamp } from '../../util/dayKey.js';   // 요일 × 시간 히트맵은 포탈 하루(한국 시각) 기준으로 화면이 접는다 · 파일명 날짜도 포탈 날짜(BUG-3 — UTC 날짜 금지)

const toolsPerm = requirePerm('tools');
const adminOnly = requireRole('admin');
const csvPerm = requirePerm('data.csv');
const fullScopeOnly = fullScopeOnlyWith('SAN 스토리지 성능은 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다.');
const fullRwOnly = fullReadWriteScopeOnlyWith('SAN 스토리지 성능의 기준 · 분류 · 매핑 변경은 조회 · 쓰기 모두 전체 범위(vCenter 제한 없는) 관리자만 할 수 있습니다.');

const KEY_MAX = 160;

/*
 * v2.954(점검 A-3): 비관리자 판본(조회는 tools + 전체 범위라 operator · viewer 도 부른다 — 카탈로그 adminOnly 는 서버 집행이 아니다) —
 *   받는 사람 메일 주소는 개수로만(형제 아이실론 · 종합 메일과 같은 결: 받는 사람은 관리자 판본에만) · 설정한 관리자 계정명(updatedBy)은 뺀다 ·
 *   발송 기록의 결과 · 사유 문구 안 메일 주소(SMTP 거부 문구 등)도 가린다. 관리자 판정은 isAdminReq(= demoGuest.js isAdminDetailUser 하나).
 */
const MAIL_RE = /[^\s<>@,;:"'()[\]]+@[^\s<>@,;:"'()[\]]+/g;
/** 매핑 재정의 한 건의 비관리자 판본 — 바꾼 사람(by)을 뺀다. */
export function byView(o, admin) {
  if (admin || !o || typeof o !== 'object') return o;
  const { by: _b, ...rest } = o; void _b;
  return rest;
}
const scrubMail = (v) => (typeof v === 'string' ? v.slice(0, 400).replace(MAIL_RE, '(메일 가림)') : v);
export function settingsView(s, admin) {
  if (admin || !s || typeof s !== 'object') return s;
  const { updatedBy: _u, ...rest } = s; void _u;
  return Array.isArray(rest.to) ? { ...rest, to: [], toCount: rest.to.length, toHidden: true } : rest;
}
const historyView = (list, admin) => (admin || !Array.isArray(list) ? list : list.map((h) => (h && typeof h === 'object'
  ? { ...h, ...(h.result !== undefined ? { result: scrubMail(h.result) } : {}), ...(h.reason !== undefined ? { reason: scrubMail(h.reason) } : {}), ...(typeof h.to === 'string' ? { to: scrubMail(h.to) } : {}) } : h)));
/** 알림 상태(마지막 실행 · 발송 기록) 비관리자 판본. */
export function notifyStatusView(st, admin) {
  if (admin || !st || typeof st !== 'object') return st;
  return { ...st, ...(Array.isArray(st.history) ? { history: historyView(st.history, false) } : {}), ...(Array.isArray(st.sent) ? { sent: historyView(st.sent, false) } : {}), ...(st.error !== undefined ? { error: scrubMail(st.error) } : {}) };
}
/** 월간 보고서 상태 비관리자 판본. */
export function reportStatusView(st, admin) {
  if (admin || !st || typeof st !== 'object') return st;
  return { ...st, settings: settingsView(st.settings, false), history: historyView(st.history, false) };
}

/** 요청의 법인 필터 · 장비 · 이름 · 가림 — 형제 라우트(storage-summary)와 같은 규칙. */
async function deviceContext(req) { return deviceContextOf({ admin: isAdminReq(req), dcQuery: req.query.datacenterId }); }
/** 현황 · 점검이 같이 쓰는 조립 — 응답하지 않고 돌려준다(abandoned 면 null). */
async function buildList(req, res) {
  const ctx = await deviceContext(req);
  try { return await buildListCore(ctx, perfAbortSignal(res)); }
  catch (e) { if (abandoned(e)) return null; throw e; }
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
    // v2.955: `points` — 칸 수를 화면이 정할 수 있게(상한 2000). 요일 × 시간 히트맵은 7일을 1시간 칸(168)으로 받아야 자기 기준선이 붙는다(2시간 칸은 reason 'bucket').
    const points = Math.min(2000, Math.max(0, Number(req.query.points) || 0)) || undefined;
    const ctx = await deviceContext(req);
    const st = loadPerfSettings();
    let agg;
    try { agg = await storageSeriesMulti(ctx.ids, { hours, from, to, ...(points ? { points } : {}), groupOf: ctx.groupOf, withPorts: true, signal: perfAbortSignal(res) }); }
    catch (e) { if (abandoned(e)) return; throw e; }
    const map = loadDirectorMap();
    const capIdx = capacityIndexFor({ dcSet: ctx.dcSet, split: true, admin: ctx.admin });
    const kindOf = kindResolver(capIdx, map);
    const directorFor = directorResolver(map, await aliasLookupFor(ctx));
    const cands = (agg.series || []).filter((s) => s.key === key);
    const s = cands.length <= 1 ? cands[0] : (cands.find((x) => ctx.dcs.includes(x.group ?? '')) || cands[0]);
    if (!s) return res.status(404).json({ ok: false, reason: '이 범위 · 기간에서 그 스토리지의 표본을 찾지 못했습니다.', ...(isMockMode() ? { demo: true } : {}) });
    const dcId = s.group ?? '';
    const n = (agg.buckets || []).length;
    const ports = (s.portsDetail || []).map((p) => {
      const d = directorFor({ deviceId: String(p.deviceId), port: Number(p.port), name: p.name || '' }, key);
      const meta = ctx.deviceMeta.get(String(p.deviceId)) || { name: String(p.deviceId) };
      const vals = (p.avg || []).filter((v) => v != null); const pk = (p.peak || []).filter((v) => v != null);
      return { deviceId: String(p.deviceId), deviceName: meta.name, port: Number(p.port), name: p.name || '', wwn: p.wwn || '', speed: p.speed || '', portType: p.portType || '',
        group: groupLabel(d.group), confidence: d.confidence, directorPort: d.port || '', avg: p.avg, peak: p.peak,
        avgTotal: vals.length ? vals.reduce((a, c) => a + c, 0) / vals.length : null, maxPeak: pk.length ? Math.max(...pk) : null };
    });
    const directors = groupedSeries(s.portsDetail || [], (p) => { const d = directorFor({ deviceId: String(p.deviceId), port: Number(p.port), name: p.name || '' }, key); return { key: groupLabel(d.group), group: groupLabel(d.group), confidence: d.confidence, parsed: d.group != null }; }, n)
      .sort((a, b) => (a.parsed === b.parsed ? a.group.localeCompare(b.group) : a.parsed ? -1 : 1));
    const fabrics = groupedSeries(s.portsDetail || [], (p) => ({ key: String(p.deviceId), deviceId: String(p.deviceId), name: (ctx.deviceMeta.get(String(p.deviceId)) || { name: String(p.deviceId) }).name }), n);
    const kind = kindOf(key, dcId);
    const vendor = ports[0] ? directorOf(ports[0].name).vendor : 'other';
    const capacity = capIdx.lookup(arraySerialOf(key), dcId);
    // v2.952 — 어레이가 보고하는 디렉터 · 노드 · SP 성능(시리얼로 짝 지은 스토리지 장비의 5분 표본). 스위치 '지금' = 합계 선의 마지막 값(없으면 대조 없음).
    const nowSwitchBps = (() => { const a = s.sum || []; for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; })();
    const winFrom = agg.since ?? (agg.buckets?.[0] ?? null); const winTo = agg.until ?? (agg.buckets?.length ? agg.buckets[agg.buckets.length - 1] + (agg.bucketMs || 0) : null);
    // v2.952(H) — 팹 비대칭 단서: 이 어레이가 물린 스위치의 ISL(E-포트) 24시간 피크 포화도(판정 아님 · 문구).
    let isl = [];
    try { const m = await islCluesFor((s.deviceIds || []).map((id) => ({ id: String(id), name: (ctx.deviceMeta.get(String(id)) || { name: String(id) }).name })), { signal: perfAbortSignal(res) }); isl = [...m.values()]; }
    catch (e) { if (abandoned(e)) return; isl = []; }
    // v2.950(§12.2-7) 자기 기준선 — 창 앞 4주의 1시간 집계(같은 스위치들)를 요일 × 시간으로 접어 창의 칸과 견준다(1시간 이하 칸에서만 · 판정 불변 · 폭은 설정 baselineTolerancePct · 비움 = 끔).
    let baseline = { applicable: false, reason: 'bucket', marks: [], offCount: 0, compared: 0 };
    try {
      const tolPct = loadCheckSettings()?.values?.baselineTolerancePct ?? null;
      if (tolPct == null) baseline = { applicable: false, reason: 'disabled', marks: [], offCount: 0, compared: 0 };
      else if ((agg.bucketMs || 0) > 0 && agg.bucketMs <= 3_600_000 && (agg.buckets || []).length) {
        const winFrom = agg.since ?? agg.buckets[0];
        const base = await storageSeriesMulti(s.deviceIds || [], { from: winFrom - BASELINE_WEEKS_DEF * 7 * 86_400_000, to: winFrom, points: BASELINE_WEEKS_DEF * 168, groupOf: ctx.groupOf, signal: perfAbortSignal(res) });
        const bs = (base.series || []).find((x) => x.key === key && (x.group ?? '') === dcId) || (base.series || []).find((x) => x.key === key) || null;
        const fold = foldBaseline(base.buckets || [], bs?.sum || [], { until: winFrom, weeks: BASELINE_WEEKS_DEF });
        const cmp = compareToBaseline(agg.buckets, s.sum, fold, { bucketMs: agg.bucketMs, tolerance: tolPct / 100 });
        baseline = { ...cmp, weeks: fold.weeks, from: fold.from, until: fold.until, measured: fold.measured, tolerancePct: tolPct, ...baselineSummary(fold) };
      }
    } catch (e) { if (abandoned(e)) return; baseline = { applicable: false, reason: 'error', marks: [], offCount: 0, compared: 0 }; }
    let arraySide = null;
    try {
      arraySide = await loadArraySide(capacity, { serial: arraySerialOf(key), from: winFrom ?? Date.now() - hours * 3_600_000, to: winTo ?? Date.now(), now: Date.now(),
        groups: directors, ports, switchBps: nowSwitchBps });
    } catch (e) { arraySide = { eligible: false, reason: 'error', text: `어레이 측 값을 읽지 못했습니다: ${String(e?.message || e).slice(0, 120)}` }; }
    res.json({
      ok: true, unit: 'bytesPerSec', key, name: capacity?.name || key, serial: arraySerialOf(key), vendor, vendorLabel: VENDOR_LABEL[vendor] || VENDOR_LABEL.other,
      kind: kind.kind, kindBasis: kind.basis, datacenterId: dcId, datacenterName: ctx.dcNameOf(dcId),
      switches: (s.deviceIds || []).map((id) => { const m = ctx.deviceMeta.get(String(id)) || { name: String(id) }; return { id: String(id), name: m.name, agent: m.agent || '' }; }),
      hours, from, to, rangeIssue: issue || null, buckets: agg.buckets, bucketMs: agg.bucketMs, since: agg.since ?? null, until: agg.until ?? null,
      sum: s.sum, peak: s.peak, avgTotal: s.avgTotal, maxTotal: s.maxTotal, peakAvg: s.peakAvg, peakTotal: s.peakTotal,
      partial: s.partial || [], partialBuckets: s.partialBuckets || 0, carriedCells: s.carriedCells || 0,
      directors, fabrics, ports, capacity, unparsedGroup: UNPARSED_GROUP, arraySide, isl, baseline, growth: capacity?.deviceId ? (await growthLookup(Date.now()))(String(capacity.deviceId)) : null,
      intervalMs: st.intervalMs, carryMs: agg.carryMs ?? null, enabled: demoOn(st.enabled), unavailable: !!agg.unavailable, offsetMin: DAY_OFFSET_MIN,
      computedAt: agg.computedAt ?? null, cacheTtlMs: perfQueryTtlMs(), source: agg.source ?? null,
      ...(isMockMode() ? { demo: true } : {}), ...(ctx.admin ? {} : { addressHidden: true }),
    });
  });

  /** 성능 점검 — 어레이 × 항목 9(스위치 측 4 는 판정 · 어레이 측 5 는 이 판에서 unknown) + 임계값 · 요약. 저장 표본만 판정(새 접속 없음). */
  api.get('/tools/san-storage/check', toolsPerm, fullScopeOnly, async (req, res) => {
    const b = await buildList(req, res);
    if (!b) return;
    let r;
    try { r = await runCheck(b, { signal: perfAbortSignal(res) }); } catch (e) { if (abandoned(e)) return; throw e; }
    // v2.955 — '지금 판정' 도 이력에 적는다(바뀌었거나 1시간 — 틱과 같은 규칙 · 실패해도 판정 응답은 그대로).
    let history = null;
    try { history = await recordCheckRuns(r.results, { at: b.now }); } catch { history = null; }
    res.json({ ok: true, ...commonMeta(b), ...r, history });
  });

  /** v2.955 점검 결과 이력 — key 가 있으면 그 어레이의 최근 N회 + 상태 전이 비교, 없으면 기록된 어레이 목록 + 최근 days 일의 변화. DB 못 열면 available:false(빈 표로 숨기지 않는다). */
  api.get('/tools/san-storage/check/history', toolsPerm, fullScopeOnly, async (req, res) => {
    const key = String(req.query.key || '').slice(0, KEY_MAX);
    const dcRaw = String(req.query.datacenterId || '');
    const db = scopeDbStatus(await checkHistoryStatus(), req.user);
    if (key) {
      const r = await listCheckRuns(key, dcRaw === NONE_DC ? '' : dcRaw, Number(req.query.limit) || 10);
      return res.json({ ok: true, key, datacenterId: dcRaw, ...r, db });
    }
    const o = await checkHistoryOverview({ days: Math.min(90, Math.max(1, Number(req.query.days) || 7)) });
    res.json({ ok: true, ...o, db });
  });

  api.get('/tools/san-storage/check-settings', toolsPerm, fullScopeOnly, (req, res) => {
    res.json({ ok: true, ...settingsView(publicCheckSettings(), isAdminReq(req)), imbalanceRule: { minBps: IMBALANCE_MIN_BPS, ratio: IMBALANCE_RATIO, badRatio: IMBALANCE_BAD_RATIO } });
  });
  /** 임계값 저장 — null = 비움(판정 안 함) · 빈 값 · 미지정 = 기본값으로. 형식 오류 400. 감사 로그. */
  api.put('/tools/san-storage/check-settings', adminOnly, fullRwOnly, (req, res) => {
    const r = saveCheckSettings(req.body || {}, { by: req.user?.username || '' });
    if (r.issue) return res.status(400).json({ ok: false, reason: r.issue });
    logAudit({ user: req.user?.username, action: 'SAN 스토리지 성능 점검 기준 변경', target: 'storage-perf-check.json', detail: `사용자 설정 ${r.settings.userSet.length}개: ${r.settings.userSet.join(', ') || '(전부 기본값)'}` });
    res.json({ ok: true, ...publicCheckSettings() });
  });

  /** 분류 · 디렉터 매핑 — 현재 저장값 + 후보(자동이 못 읽은 포트 · 이름 규칙만으로 분류된 키 · 재정의된 것). */
  /* ── v2.950(§12.2-6) 알림 — 설정(켬 · 최소 수준 · 회복 · 항목) + 상태(마지막 틱 · 기준 어레이 수 · 발송 기록). 발송은 상태가 바뀐 순간만 · 법인 단위 · 중앙만. ── */
  api.get('/tools/san-storage/notify', toolsPerm, fullScopeOnly, async (req, res) => {
    const admin = isAdminReq(req);
    res.json({ ok: true, settings: settingsView(loadNotifySettings(), admin), loadError: notifyLoadError(), status: notifyStatusView(storagePerfNotifyStatus(), admin), minLevels: MIN_LEVELS, items: CHECK_ITEMS, arraysTracked: Object.keys(loadNotifyState().last || {}).length });
  });
  api.put('/tools/san-storage/notify-settings', adminOnly, fullRwOnly, (req, res) => {
    const r = saveNotifySettings(req.body || {}, { by: req.user?.username || '' });
    if (r.issue) return res.status(400).json({ ok: false, reason: r.issue });
    logAudit({ user: req.user?.username, action: 'SAN 스토리지 성능 알림 설정 변경', target: 'san-storage-notify.json', detail: `${r.settings.enabled ? '켬' : '끔'} · 최소 ${r.settings.minLevel} · 회복 ${r.settings.recoveries ? '알림' : '안 함'}${r.settings.items ? ` · 항목 ${r.settings.items.join(',')}` : ''}` });
    res.json({ ok: true, settings: r.settings });
  });
  /** 지금 판정해 전이를 보낸다(관리자 · 사람이 누름 — 설정이 꺼져 있어도 1회 돈다 · 첫 실행은 기준만 잡는다). */
  api.post('/tools/san-storage/notify/run-now', adminOnly, fullRwOnly, async (req, res) => {
    const r = await pollStoragePerfNotifyOnce({ force: true });
    logAudit({ user: req.user?.username, action: 'SAN 스토리지 성능 알림 지금 실행', target: 'san-storage-notify-state.json', detail: `${r.action} · 알림 ${r.alerts ?? 0}건 · 열림 ${r.opened ?? 0} · 회복 ${r.recovered ?? 0}` });
    res.json({ ok: r.action !== 'error', ...r });
  });

  /* ── v2.950(§12.2-8) 월간 보고서 — 설정 · 상태 · 미리보기(HTML) · 지금 보내기. 보고서는 자급형 HTML(브라우저에서 PDF 저장) — PDF 직접 생성은 한글 글꼴 동봉이 필요해 이번 판은 아니다. ── */
  api.get('/tools/san-storage/report', toolsPerm, fullScopeOnly, async (req, res) => {
    res.json({ ok: true, ...reportStatusView(storagePerfReportStatus(), isAdminReq(req)) });
  });
  api.put('/tools/san-storage/report-settings', adminOnly, fullRwOnly, async (req, res) => {
    const r = saveReportSettings(req.body || {}, { by: req.user?.username || '' });
    if (r.issue) return res.status(400).json({ ok: false, reason: r.issue });
    logAudit({ user: req.user?.username, action: 'SAN 스토리지 성능 월간 보고서 설정 변경', target: 'san-storage-report.json', detail: `${r.settings.enabled ? '켬' : '끔'} · 매달 ${r.settings.dayOfMonth}일 ${r.settings.time} · 받는 사람 ${r.settings.to.length || '기본'}` });
    res.json({ ok: true, settings: r.settings });
  });
  /** 미리보기 — 지금 값으로 만든 보고서 HTML 그대로(보내지 않는다 · 관리자 아닌 조회자도 주소 가림 판본). */
  api.get('/tools/san-storage/report/preview', toolsPerm, fullScopeOnly, async (req, res) => {
    const b = await buildReport({ now: Date.now() });
    if (String(req.query.format || '') === 'json') return res.json({ ok: true, model: b.model, parts: b.parts, arrays: b.arrays });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${b.parts.filename}"`);
    res.send(b.html);
  });
  api.post('/tools/san-storage/report/send-now', adminOnly, fullRwOnly, async (req, res) => {
    const r = await sendReportNow(req.user?.username || 'admin');
    logAudit({ user: req.user?.username, action: 'SAN 스토리지 성능 월간 보고서 지금 보내기', target: 'san-storage-report.json', detail: `${r.state}${r.reason ? ` · ${r.reason}` : ''}${r.to ? ` · 받는 사람 ${r.to}` : ''}` });
    res.status(r.ok ? 200 : 409).json(r);
  });

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
      const ov = byView(b.map.kinds[s.key] || null, b.ctx.admin);
      // 후보: 수동 재정의가 있거나 · 이름 규칙으로만 어레이가 된 것 · 평평한 이름(호스트) 중 `::` 없는 것은 수천 개라 'array' 와 재정의만.
      if (ov || k.basis === 'name' || k.kind === 'array') {
        targets.push({ key: s.key, datacenterId: dcId, datacenterName: b.ctx.dcNameOf(dcId), vendor: directorOf(first).vendor, autoKind: ov ? kindResolverNoOverride(capIdx)(s.key, dcId) : k, applied: k.kind, basis: k.basis, override: ov, firstName: first, ports: (s.ports || []).length });
      }
      if (k.kind !== 'array') continue;
      for (const p of s.portsDetail || []) {
        const auto = directorOf(p.name || '');
        const mk = directorMapKey(s.key, p.deviceId, p.port);
        const ov2 = byView(b.map.directors[mk] || null, b.ctx.admin);
        if (auto.group != null && !ov2) continue;
        ports.push({ mapKey: mk, key: s.key, datacenterId: dcId, deviceId: String(p.deviceId), deviceName: (b.ctx.deviceMeta.get(String(p.deviceId)) || { name: String(p.deviceId) }).name,
          port: Number(p.port), name: p.name || '', auto: { group: auto.group, confidence: auto.confidence, vendor: auto.vendor }, override: ov2,
          nameChanged: !!(ov2 && ov2.name && ov2.name !== (p.name || '')) });
      }
    }
    targets.sort((a, b2) => (a.override ? -1 : b2.override ? 1 : 0) || a.key.localeCompare(b2.key));
    // v2.977(전체 점검 — audits.md v2.954 '남긴 것'): 비관리자 판본은 설정한 관리자 계정명(updatedBy · 재정의의 by)을 싣지 않는다(A-3 과 같은 부류).
    const admin = b.ctx.admin;
    const mapView = (m) => (admin ? m : Object.fromEntries(Object.entries(m || {}).map(([k, v]) => [k, byView(v, false)])));
    res.json({ ok: true, ...commonMeta(b), counts: b.counts, map: { kinds: mapView(b.map.kinds), directors: mapView(b.map.directors), updatedAt: b.map.updatedAt, ...(admin ? { updatedBy: b.map.updatedBy } : {}) }, limits: MAP_LIMITS,
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
