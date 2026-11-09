/**
 * sanswitch/storagePerfCore.js — SAN 스토리지 성능의 **판정 코어**(v2.953 · 설계 README §8.3). 라우트(`routes/api/sanStorage.js`) · 알림 틱(`storagePerfNotify.js`) ·
 * 월간 보고서(`storagePerfReportMail.js`) · 공개 API(`routes/publicApi.js`)가 **같은 함수**로 같은 행 · 같은 판정을 본다(판정 코어 하나).
 *
 *  · 왜 라우트 밖에 있나: 도메인(sanswitch/)이 routes/ 를 import 하면 방향 위반 + 순환이다(arch2579 ①). v2.948~2.952 에는 라우트 안에 있었고, 알림 · 보고서가 생기며 옮겼다.
 *  · `capacityIndexFor`(등록 스토리지 시리얼 색인) · `NONE_DC` · `abandoned` 도 여기 — `routes/api/sanSwitch.js` 가 재수출한다(기존 import 경로 유지).
 *  · 요청 객체를 모른다 — `deviceContextOf({ admin, dcQuery })` 로 문맥을 만든다(admin:true 면 주소를 가리지 않는다 · 내부 사용만).
 */
import { listDevices } from './registry.js';
import { listDatacenters } from '../datacenter/store.js';
import { maskDeviceAddress } from '../auth/addressMask.js';
import { storageSeriesMulti, latestSampleTs, endpointKind, arraySerialOf, metaFor } from './perfDb.js';
import { loadPerfSettings } from './perfSettings.js';
import { sumArrayTraffic } from './trafficTotal.js';
import { buildStorageRows } from './storageList.js';
import { checkArray, summarizeChecks, CHECK_ITEMS } from './storagePerfCheck.js';
import { checkInputFor } from './arraySideLoad.js';
import { localSnapshots as sanLocalSnaps } from './store.js';
import { edgeSanSwitchSnapshots } from '../central/sanSwitchEdge.js';
import { buildFabrics } from './attribution.js';
import { normWwn } from './zoning.js';
import { islCluesFor, islClueText } from './islClue.js';
import { dailySeries } from '../storage/db.js';
import { growthMatrix, normalizePeriods } from '../storage/growth.js';
import { dayIndex } from '../util/dayKey.js';
import { loadCheckSettings, publicCheckSettings } from './storageCheckSettings.js';
import { loadDirectorMap, directorMapKey } from './directorMap.js';
import { directorOf, applyDirectorOverride, VENDOR_LABEL } from './directorOf.js';
import { isMockMode } from '../mock/demo/flags.js';
import { ensureSanSwitchDemo } from './poller.js';
import { listDevices as listStorageDevices } from '../storage/registry.js';
import { localSnapshots as storageLocalSnaps } from '../storage/store.js';
import { edgeStorageSnapshots } from '../central/storageEdge.js';
import { numOrNull } from '../util/numOrNull.js';

/** 법인 필터에서 '법인 미지정' 을 뜻하는 토큰(쿼리 · 응답 공통). */
export const NONE_DC = '__none__';
/** 요청한 화면이 떠나 멈춘 조회 — 받을 사람이 없으니 응답하지 않는다(소켓은 이미 닫혔다). */
export const abandoned = (e) => e?.code === 'abandoned';

/**
 * 등록 스토리지의 최신 스냅샷(용량) 색인 — 시리얼 정규화 후 대조(storage-summary · v2.948 SAN 스토리지 성능이 같은 색인을 쓴다 — 코어 하나).
 * 법인별로 분리해 볼 때는 **그 법인의 스토리지 용량만** 붙여야 한다 — 그래서 키에 법인을 넣는다. 확실히 일치할 때만 붙이고 아니면 null(억지 매칭 금지).
 */
export function capacityIndexFor({ dcSet = null, split = true, admin = false } = {}) {
  const norm = (v) => String(v ?? '').toLowerCase().replace(/[\s:_.-]/g, '');
  const stDevById = new Map(listStorageDevices().map((d) => [d.id, admin ? d : maskDeviceAddress(d)]));
  const capBySerial = new Map();   // `${dc}\u0000${serial}` 또는 split 아니면 serial
  const capKey = (dcId, serial) => (split ? `${dcId}\u0000${serial}` : serial);
  for (const snap of [...storageLocalSnaps(), ...edgeStorageSnapshots()]) {
    if (!snap?.ok) continue;
    const d = stDevById.get(snap.deviceId) || {};
    if (dcSet && !dcSet.has(String(d.datacenterId || ''))) continue;  // 범위 밖 법인의 어레이는 붙이지 않는다
    const info = {
      deviceId: snap.deviceId, name: d.name || snap.name || '', type: d.type || '',
      totalBytes: snap.capacity?.totalBytes ?? null, usedBytes: snap.capacity?.usedBytes ?? null,
      pct: snap.capacity?.pct ?? null,
      // v2.952(SAN 스토리지 성능 ⓑ): 어레이 측 성능 · 경보 연동에 필요한 것 — 미해결 알람 수(못 읽었으면 null) · 수집 시각 · 수집 방식 · 표본 토글 · 위임 엣지.
      alerts: numOrNull(snap.alerts?.unresolved), collectedAt: numOrNull(snap.collectedAt), collectMethod: d.collectMethod || 'api',
      nodeLoadEnabled: d.nodeLoadEnabled !== false, agent: String(d.agent || ''),
    };
    // v2.606(감사 CEN2606-04): appliances 가 배열이 아니거나 원소가 null 이면 이 요약 전체가 500 이었다 — 객체 원소의 글자만 읽는다.
    const apps = Array.isArray(snap.extra?.appliances) ? snap.extra.appliances : [];
    const keys = [snap.serial, ...apps.map((a) => (a && typeof a === 'object' ? a.serviceTag : null))];
    for (const key of keys) {
      if (key && (typeof key === 'string' || typeof key === 'number')) capBySerial.set(capKey(String(d.datacenterId || ''), norm(key)), info);
    }
  }
  return { lookup: (serial, dcId = '') => (serial ? (capBySerial.get(capKey(String(dcId ?? ''), norm(serial))) || null) : null), size: capBySerial.size };
}

/** 최근 1시간(지금 · 스파크 — 60초 칸) · 최근 7일(24시간 창 · 앞 6일 · 디렉터 · 포트 — 1시간 칸). 숫자는 설계 §4.1 — 화면에 박지 않고 응답에 싣는다. */
export const LIST_WINDOWS = Object.freeze({ nowHours: 1, nowPoints: 60, trendHours: 168, trendPoints: 168 });

/** 요청 없이도(알림 틱 · 월간 보고서 · 공개 API) 같은 문맥을 만든다 — admin:true 면 주소를 가리지 않는다(내부 사용만). */
export async function deviceContextOf({ admin = false, dcQuery = '' } = {}) {
  if (isMockMode()) { try { await ensureSanSwitchDemo(); } catch { /* 데모 시드 실패는 빈 목록 */ } }
  const dcs = String(dcQuery || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => (x === NONE_DC ? '' : x));
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
export function kindResolver(capIdx, map) {
  return (key, dcId) => {
    const ov = map.kinds[String(key)];
    if (ov) return { kind: ov.kind, basis: 'manual' };
    const serial = arraySerialOf(key);
    if (serial && capIdx.lookup(serial, dcId)) return { kind: 'array', basis: 'serial' };
    const k = endpointKind(key, { matched: false });
    return { kind: k, basis: k === 'unknown' ? 'none' : (String(key).includes('::') ? 'name' : 'flat') };
  };
}
/** 디렉터 — 관리자 매핑 > 이름 규칙 > 조닝 별칭(v2.952 C — 심볼릭 이름이 없는 Unity SPA/SPB 포트는 zone 별칭 `Unity_SPA0_p8` 로). */
export function directorResolver(map, aliasFor = null) {
  return (port, key) => applyDirectorOverride(directorOf(port.name, { alias: aliasFor ? aliasFor(port.deviceId, port.port) : '' }), map.directors[directorMapKey(key, port.deviceId, port.port)] || null);
}
/**
 * v2.952(C): 포트 → 조닝 별칭. port_meta 의 연결 WWN 을 장비별 최신 스냅샷 zone 멤버 별칭(attribution.buildFabrics aliasOf)에서 찾는다.
 * 스냅샷 · DB 가 없으면 빈 조회(별칭 없음 = 폴백 없음 — 판정이 바뀌지 않는다). 요청마다 한 번 만든다.
 */
export async function aliasLookupFor(ctx) {
  const snapOf = new Map();
  try {
    for (const s of [...sanLocalSnaps(), ...edgeSanSwitchSnapshots()]) {
      if (!s?.deviceId || !ctx.deviceMeta.has(String(s.deviceId))) continue;
      const cur = snapOf.get(s.deviceId);
      if (!cur || (s.collectedAt || 0) > (cur.collectedAt || 0)) snapOf.set(s.deviceId, s);
    }
  } catch { /* 스냅샷 저장소 불가 — 별칭 없음 */ }
  const aliasOf = new Map();
  try {
    for (const f of buildFabrics([...snapOf.values()].map((s) => { const m = ctx.deviceMeta.get(String(s.deviceId)) || {}; return { ...s, name: m.name || s.name, datacenterId: m.datacenterId || '' }; }))) {
      for (const [w, a] of f.aliasOf || []) { const k = normWwn(w); if (k && a && !aliasOf.has(k)) aliasOf.set(k, String(a).slice(0, 120)); }
    }
  } catch { /* 조닝 해석 실패 — 별칭 없음 */ }
  let wwnOf = new Map();
  if (aliasOf.size) { try { wwnOf = new Map((await metaFor(ctx.ids)).map((r) => [`${r.d}|${Number(r.p)}`, normWwn(r.wwn || '')])); } catch { wwnOf = new Map(); } }
  const fn = (deviceId, port) => { const w = wwnOf.get(`${deviceId}|${Number(port)}`); return w ? (aliasOf.get(w) || '') : ''; };
  fn.size = aliasOf.size;
  return fn;
}

export async function loadAggs(ctx, signal) {
  return Promise.all([
    storageSeriesMulti(ctx.ids, { hours: LIST_WINDOWS.nowHours, points: LIST_WINDOWS.nowPoints, groupOf: ctx.groupOf, signal }),
    storageSeriesMulti(ctx.ids, { hours: LIST_WINDOWS.trendHours, points: LIST_WINDOWS.trendPoints, groupOf: ctx.groupOf, withPorts: true, signal }),
  ]);
}

/** v2.953: 문맥만 받는 조립 — 라우트 · 알림 틱 · 월간 보고서 · 공개 API 가 같은 행을 본다(판정 코어 하나). 취소(abandoned)는 던진다. */
export async function buildListCore(ctx, signal = null) {
  const st = loadPerfSettings();
  const [agg1h, agg7d] = await loadAggs(ctx, signal);
  let lastTs = new Map();
  try { lastTs = await latestSampleTs(ctx.ids); } catch { /* DB 불가 — unavailable 이 말한다 */ }
  const map = loadDirectorMap();
  const capIdx = capacityIndexFor({ dcSet: ctx.dcSet, split: true, admin: ctx.admin });
  const kindOf = kindResolver(capIdx, map);
  const aliasFor = await aliasLookupFor(ctx);
  const directorFor = directorResolver(map, aliasFor);
  const carryMs = numOrNull(agg1h.carryMs) ?? (Number(st.intervalMs) || 300_000) * 2;
  const now = Date.now();
  const { rows, counts } = buildStorageRows({
    agg1h, agg7d, deviceMeta: ctx.deviceMeta, deviceLastTs: lastTs, now, carryMs,
    kindOf: (key, dc) => kindOf(key, dc).kind,
    capacityOf: (key, dc) => capIdx.lookup(arraySerialOf(key), dc),
    directorFor,
  });
  for (const r of rows) { r.vendorLabel = VENDOR_LABEL[r.vendor] || VENDOR_LABEL.other; r.kindBasis = kindOf(r.key, r.datacenterId).basis; r.name = r.capacity?.name || r.key; }
  // v2.953(§12.2-12) 용량 × 성능 — 짝 지은 스토리지 장비의 30일 증가량(일 롤업만 · 장비 호출 0 · 10분 기억). 못 읽으면 null(0 이 아니다).
  const growthOf = await growthLookup(now);
  for (const r of rows) r.growth = r.capacity?.deviceId ? growthOf(String(r.capacity.deviceId)) : null;
  // 지금 합계 — 트래픽 카드(traffic-total)와 같은 함수 · 같은 분류(둘이 다르면 결함).
  const total = sumArrayTraffic(agg1h, { isArray: (s) => kindOf(s.key, s.group ?? '').kind === 'array', carryMs, activeDeviceIds: new Set(ctx.ids.map(String)), deviceLastTs: lastTs });
  let lastSampleAt = null;
  for (const v of lastTs.values()) if (Number.isFinite(Number(v)) && (lastSampleAt == null || Number(v) > lastSampleAt)) lastSampleAt = Number(v);
  const edgeRaw = ctx.devices.filter((d) => String(d.agent || '').trim());
  return { ctx, st, agg1h, agg7d, lastTs, map, rows, counts, total, carryMs, now, lastSampleAt, aliasCount: aliasFor.size,
    edgeSwitches: edgeRaw.length, edgeMissing: edgeRaw.filter((d) => !lastTs.get(String(d.id))).length };
}

/** 30일 증가량 조회(10분 기억) — deviceId → { bytes30d, perDayBytes, usedBytes, totalBytes, pctUsed, daysToFull, exact } 또는 null. DB 없음 · 오류면 전부 null(조용히 0 으로 만들지 않는다). */
const GROWTH_MEMO_MS = 10 * 60_000;
let _growthMemo = { at: 0, map: null };
export async function growthLookup(now = Date.now()) {
  if (_growthMemo.map && now - _growthMemo.at < GROWTH_MEMO_MS) return (id) => _growthMemo.map.get(id) || null;
  const map = new Map();
  try {
    const asOfDay = dayIndex(now);
    const rows = await dailySeries(null, asOfDay - 32);
    const m = growthMatrix(rows, { periods: normalizePeriods('30d').periods, asOfDay });
    for (const d of m.devices) {
      const g = d.growth?.['30d'] || null;
      map.set(String(d.deviceId), { bytes30d: g?.bytes ?? null, perDayBytes: g?.perDayBytes ?? null, exact: g?.exact ?? null, reason: g?.bytes == null ? (g?.reason || 'no-data') : null,
        usedBytes: d.usedBytes, totalBytes: d.totalBytes, pctUsed: d.pct, daysToFull: numOrNull(d.daysToFull?.days), daysBasis: d.daysToFull?.basisLabel ?? null, observedDays: d.observedDays, stale: !!d.stale });   // growth.js 는 { days, basis } 객체 — 화면 · 공개 API 는 일수(숫자)만
    }
  } catch { /* DB 없음 · 오류 — 전부 null */ }
  _growthMemo = { at: now, map };
  return (id) => map.get(id) || null;
}
export function _resetGrowthMemoForTest() { _growthMemo = { at: 0, map: null }; }

/** v2.953: 점검 실행 — 라우트 · 알림 틱 · 월간 보고서 · 공개 API 가 같은 함수(판정 코어 하나). 취소(abandoned)는 던진다. */
export async function runCheck(b, { signal = null } = {}) {
  const settings = loadCheckSettings();
  // v2.952(H) — 어레이가 물린 스위치의 ISL 피크 포화도(24시간)를 팹 비대칭 문구에 붙인다(판정은 바꾸지 않는다). 조회 실패는 문구에 '조회 실패'.
  let islMap = new Map();
  try {
    const sws = new Map(); for (const r of b.rows) for (const f of r.fabrics || []) if (f.deviceId) sws.set(String(f.deviceId), { id: String(f.deviceId), name: f.name || String(f.deviceId) });
    islMap = await islCluesFor([...sws.values()], { signal: signal });
  } catch (e) { if (abandoned(e)) throw e; islMap = new Map(); }
  // v2.952 — 어레이 측 입력(최근 표본 · 장비 호출 0). 짝이 없거나 표본이 없으면 그 사유가 unknown 문구가 된다.
  const results = [];
  for (const r of b.rows) {
    let as = { input: {}, text: '', reason: 'no-device', lastSampleTs: null, eligible: false };
    try { as = await checkInputFor(r.capacity, { serial: r.serial, now: b.now, switchBps: r.now?.bps ?? null }); }
    catch (e) { as = { input: {}, text: `어레이 측 값을 읽지 못했습니다: ${String(e?.message || e).slice(0, 100)}`, reason: 'error', lastSampleTs: null, eligible: false }; }
    const res1 = checkArray(r, settings, { arraySide: Object.keys(as.input).length ? as.input : null, arraySideText: as.text });
    const clue = islClueText(r.fabrics || [], islMap, { warnPct: settings?.values?.portSatWarnPct ?? null });
    if (clue && res1.items.fabric && res1.items.fabric.status !== 'na') res1.items.fabric = { ...res1.items.fabric, text: `${res1.items.fabric.text} · ${clue}`, isl: (r.fabrics || []).map((f) => islMap.get(String(f.deviceId)) || null) };
    results.push({ ...res1,
      name: r.name, vendor: r.vendor, vendorLabel: r.vendorLabel, datacenterName: r.datacenterName, state: r.state,
      arraySide: { eligible: as.eligible, reason: as.reason, lastSampleTs: as.lastSampleTs, keys: Object.keys(as.input) } });
  }
  return { results, summary: summarizeChecks(results), settings: publicCheckSettings(), items: CHECK_ITEMS, judgedAt: b.now };
}
