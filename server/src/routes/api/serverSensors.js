/**
 * 서버 온도 › 센서 상세 API(v2.659).
 *  GET /tools/esxi-temp/sensors      — iDRAC 서버별 요약(흡기·CPU 온도·CPU 사용률·GPU 온도·경고 센서 수) + 법인별 전산실 온도
 *  GET /tools/esxi-temp/sensors/:id  — 한 서버의 전 센서(값·임계값·상태·역할)
 *
 * 경로가 `/tools/esxi-temp/*` 라 도구 키 `esxitemp` 의 거부 목록을 그대로 따른다(auth/toolAccess.js).
 * 범위: 형제 `/tools/esxi-temp` 와 같다 — 범위 계정은 허용 vCenter 에 귀속된 서버만(귀속 없는 물리 서버 미노출).
 * 주소: 비-admin 에는 IP 로 등록된 id·name 을 가린다(v2.601 AUTHZ-2601-04 — id 는 불투명 토큰, 상세 조회가 되찾는다).
 * 왕복 0 — 폴러가 모은 캐시·엣지 export 만 읽는다. 장비에 접속하지 않는다.
 */

import { requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { isAdminReq, addressMatcher, maskedIdToken, maskedAddressName, resolveMaskedToken } from '../../auth/addressMask.js';
import { store } from '../../store.js';
import { memoJson, scopeKey, hash } from './shared.js';
import { analysisServersWithRemote } from '../admin/shared.js';
import { localSensorDetail } from '../../idrac/sensorDetailCache.js';
import { expandCompact, mergeSensors, summarizeSensors, parseThermalTemp, parseThermalFan, parseRedfishSensor } from '../../idrac/sensorDetail.js';
import { getSensorSeries, sensorPollCycle } from '../../idrac/sensorStore.js';
import { DEFAULT_MAX_AGE_MS, sampleMaxAgeMs } from '../../idrac/roomTemp.js';
import { listDatacenters } from '../../datacenter/store.js';
import { buildSensorRows, cpuIndexOf, cpuOf } from '../../tools/serverSensors.js';
import { numOrNull } from '../../util/numOrNull.js';

const toolsPerm = requirePerm('tools');
/** Sensors 컬렉션만 있는 상세의 신선도 — 인벤토리 주기(30분) × 2 + 여유. */
const COLL_ONLY_MAX_AGE_MS = 75 * 60_000;

/** 원격(엣지) 서버의 상세 — export 콤팩트를 되돌린다. 상태는 여기서 다시 판정한다(expandCompact). */
function remoteDetail(s) {
  const d = s?.sensorDetail;
  if (!d || !Array.isArray(d.list)) return null;
  const list = d.list.map(expandCompact).filter(Boolean);
  return {
    list, omitted: numOrNull(d.omitted) || 0,
    at: numOrNull(d.at), thermalAt: numOrNull(d.thermalAt),
    collection: d.collAt != null || d.collOk != null ? { at: numOrNull(d.collAt), sensorsAt: numOrNull(d.collAt), ok: d.collOk, error: d.collError || '' } : null,
  };
}
function localDetail(s) {
  const d = localSensorDetail(s.id);
  if (!d) return null;
  const at = Math.max(d.thermalAt || 0, d.collection?.sensorsAt || 0) || null;
  return { ...d, at };
}

/* ── mock(데모) 합성 — 실데이터와 섞지 않고 synthesized 로 밝힌다 ─────────────────── */
function mockDetail(seed, withGpu) {
  const n = (k, span) => (hash(`${seed}|${k}`) % (span * 10)) / 10;
  const th = [];
  const T = (name, v, th4, health = 'OK') => th.push(parseThermalTemp({ Name: name, ReadingCelsius: v, Status: { Health: health, State: 'Enabled' }, ...th4 }));
  T('CPU0 Temp', 45 + n('c0', 12), { LowerThresholdCritical: 3, UpperThresholdCritical: 108 });
  T('CPU1 Temp', 46 + n('c1', 12), { LowerThresholdCritical: 3, UpperThresholdCritical: 108 });
  T('Inlet Temp', 19 + n('in', 7), { LowerThresholdNonCritical: 3, UpperThresholdNonCritical: 38, LowerThresholdCritical: -7, UpperThresholdCritical: 42 });
  T('System Board Exhaust Temp', 30 + n('ex', 9), { LowerThresholdNonCritical: 8, UpperThresholdNonCritical: 70, LowerThresholdCritical: 3, UpperThresholdCritical: 75 });
  T('Max DIMM Temperature', 27 + n('dm', 6), {});
  if (withGpu) { for (const g of [2, 7]) T(`GPU${g} Temp`, 42 + n(`g${g}`, 20), {}); }
  for (let i = 1; i <= 6; i++) th.push(parseThermalFan({ Name: `System Board Fan${i}`, Reading: 5200 + Math.round(n(`f${i}`, 300)) * 10, ReadingUnits: 'RPM', LowerThresholdCritical: 600, Status: { Health: 'OK', State: 'Enabled' } }));
  const coll = [];
  const S = (name, type, unit, v, t = {}, ctx = '') => coll.push(parseRedfishSensor({ Id: name.replace(/\s+/g, ''), Name: name, ReadingType: type, ReadingUnits: unit, Reading: v, PhysicalContext: ctx, Status: { Health: 'OK', State: 'Enabled' }, Thresholds: t }));
  S('CPU Usage', 'Percent', '%', 10 + n('cu', 55), {}, 'CPU');
  S('PS1 Voltage 1', 'Voltage', 'V', 228 + n('v1', 6), { LowerCritical: { Reading: 180 }, UpperCritical: { Reading: 264 } }, 'PowerSupply');
  S('PS2 Voltage 2', 'Voltage', 'V', 228 + n('v2', 6), { LowerCritical: { Reading: 180 }, UpperCritical: { Reading: 264 } }, 'PowerSupply');
  S('PS1 Current 1', 'Current', 'A', 1.2 + n('a1', 2), {}, 'PowerSupply');
  S('System Board Pwr Consumption', 'Power', 'W', 380 + n('pw', 250), { UpperCaution: { Reading: 1210 }, UpperCritical: { Reading: 1330 } }, 'SystemBoard');
  // 경고 하나(데모): 씨드에 따라 배기 경고.
  if (hash(`${seed}|warn`) % 7 === 0) T('System Board Exhaust Temp 2', 71, { UpperThresholdNonCritical: 70, UpperThresholdCritical: 75 }, 'Warning');
  const { list, omitted } = mergeSensors(coll.filter(Boolean), th.filter(Boolean));
  return { list, omitted, at: Date.now(), thermalAt: Date.now(), collection: { at: Date.now(), sensorsAt: Date.now(), ok: true, count: coll.length, expanded: 1, notRead: 0, error: '' } };
}
function mockServers(snap) {
  const dcs = [...new Set((snap.hosts || []).map((h) => h.vcenterId))].slice(0, 6);
  const out = [];
  dcs.forEach((dc, i) => {
    for (let k = 1; k <= 4; k++) {
      const seed = hash(`${dc}|bm${k}`);
      out.push({ id: `mock-bm-${dc}-${k}`, name: `bm-${String(dc).replace(/^vc-/, '')}-${k <= 2 ? 'gpu' : 'db'}0${k}`, ip: `10.${i + 10}.0.${k}`, serviceTag: `MOCK${(seed % 9000) + 1000}`, datacenterId: dc, vcenterId: dc, remote: true, _gpu: k <= 2, _seed: seed });
    }
  });
  return out;
}

/** 요청 범위의 서버 목록 + 상세 조회기. mock 이고 상세 있는 서버가 없으면 합성한다. */
function serversFor(req, snap) {
  const allowed = scopedVcenterIds(req.user, snap);
  const vcId = typeof req.query.vcenterId === 'string' ? req.query.vcenterId : '';
  let servers = analysisServersWithRemote(req) || [];
  if (allowed) servers = servers.filter((s) => s.vcenterId && allowed.has(s.vcenterId));
  if (vcId) servers = servers.filter((s) => !s.vcenterId || s.vcenterId === vcId);
  const detailOf = (s) => (s._seed != null ? mockDetail(s._seed, s._gpu) : (s.remote ? remoteDetail(s) : localDetail(s)));
  let synthesized = false;
  if (snap?.source === 'mock' && !servers.some((s) => detailOf(s))) {
    let m = mockServers(snap);
    if (allowed) m = m.filter((s) => allowed.has(s.vcenterId));
    if (vcId) m = m.filter((s) => s.vcenterId === vcId);
    servers = m; synthesized = true;
  }
  return { servers, detailOf, synthesized };
}

function maxAgeOf(localCycle) {
  return (s, _at, d) => {
    // Thermal(매 주기) 이 있으면 폴 주기 기반 경계, 컬렉션만 있으면 인벤토리 주기 기반 경계.
    if (d && !d.thermalAt) return COLL_ONLY_MAX_AGE_MS;
    return sampleMaxAgeMs(DEFAULT_MAX_AGE_MS, s.remote ? (s.sensors || null) : null, { remote: !!s.remote, localCycle });
  };
}

async function cpuRows() {
  const out = { rows: [], bmEnabled: null, error: '' };
  try {
    const [{ latestUsage }, { loadBmUsageSettings, bmUsageEnabled }, edge] = await Promise.all([
      import('../../bmusage/db.js'), import('../../bmusage/settings.js'), import('../../central/bmUsageEdgePull.js'),
    ]);
    const central = await latestUsage().catch(() => []);
    let s = null; try { s = loadBmUsageSettings(); } catch { s = null; }
    try { out.bmEnabled = typeof bmUsageEnabled === 'function' ? !!bmUsageEnabled(s) : !!s?.enabled; } catch { out.bmEnabled = null; }
    const freshOf = (ms) => Math.max(30 * 60_000, 3 * (numOrNull(ms) || 300_000));
    const edges = (() => { try { return edge.listEdgeBmUsage(); } catch { return []; } })();
    const edgeRows = edges.flatMap((e) => (e?.snap?.rows || []).filter((r) => r && typeof r === 'object').map((r) => ({ ...r, _freshMs: freshOf(e?.snap?.settings?.intervalMs) })));
    out.rows = [...central.map((r) => ({ ...r, _freshMs: freshOf(s?.intervalMs) })), ...edgeRows];
  } catch (e) { out.error = String(e?.message || e).slice(0, 200); }
  return out;
}

function maskRow(row, match) {
  const o = { ...row };
  if (match(o.id)) o.id = maskedIdToken(o.id);
  if (match(o.name)) o.name = maskedAddressName(o.name);
  return o;
}

export function registerServerSensors(api) {
  api.get('/tools/esxi-temp/sensors', toolsPerm, (req, res) => memoJson(req, res, 'tools-esxi-temp-sensors', async (snap) => {
    const { servers, detailOf, synthesized } = serversFor(req, snap);
    const dcNames = new Map(listDatacenters().map((d) => [String(d.id), d.name || d.id]));
    // DataCenter 로 등록되지 않은 귀속 값(vCenter id)은 vCenter 이름으로 보인다 — id 를 라벨인 척 두지 않는다.
    for (const v of snap?.vcenters || []) if (v?.id && !dcNames.has(String(v.id))) dcNames.set(String(v.id), v.name || v.id);
    const cpu = await cpuRows();
    const cpuIndex = cpuIndexOf(cpu.rows);
    const localCycle = sensorPollCycle();
    const ageOf = maxAgeOf(localCycle);
    const details = new Map();
    const dOf = (s) => { if (!details.has(s.id)) details.set(s.id, detailOf(s)); return details.get(s.id); };
    const rep = buildSensorRows({
      servers,
      detailOf: dOf,
      cpuFor: (s, sum) => cpuOf(s, {
        cpuIndex, bmEnabled: cpu.bmEnabled, sensorPct: sum?.sensorCpuUsagePct ?? null,
        telemetryOf: (x) => {
          if (x.remote) return null;
          const l = getSensorSeries(x.id).latest;
          if (!l || l.cpu == null) return null;
          return { pct: l.cpu, at: l.t, fresh: Date.now() - (l.t || 0) <= sampleMaxAgeMs(DEFAULT_MAX_AGE_MS, null, { localCycle }) };
        },
      }),
      dcName: (id) => dcNames.get(String(id)) || id,
      maxAgeOf: (s, at) => ageOf(s, at, dOf(s)),
    });
    let rows = rep.rows;
    const admin = isAdminReq(req);
    if (!admin) {
      const match = addressMatcher(servers.flatMap((x) => [x?.host, x?.ip]).filter((h) => typeof h === 'string' && h));
      rows = rows.map((r) => maskRow(r, match));
    }
    return {
      rows, summary: rep.summary, byDatacenter: rep.byDatacenter,
      cpuSource: { bmEnabled: cpu.bmEnabled, error: cpu.error },
      freshBaseMs: DEFAULT_MAX_AGE_MS, collOnlyMaxAgeMs: COLL_ONLY_MAX_AGE_MS,
      ...(synthesized ? { synthesized: true } : {}),
      ...(admin ? {} : { addressHidden: true }),
    };
  }, { extraKey: `${scopeKey(req.user, store.get())}|${isAdminReq(req) ? 'a' : 'm'}` }));

  api.get('/tools/esxi-temp/sensors/:id', toolsPerm, async (req, res) => {
    const snap = store.get();
    const { servers, detailOf, synthesized } = serversFor(req, snap);
    const raw = resolveMaskedToken(String(req.params.id || ''), servers.map((s) => String(s.id)));
    const s = raw ? servers.find((x) => String(x.id) === raw) : null;
    if (!s) return res.status(404).json({ error: 'not_found', reason: '서버를 찾을 수 없거나 조회 범위 밖입니다' });
    const d = detailOf(s);
    const list = d?.list || [];
    const admin = isAdminReq(req);
    const match = admin ? () => false : addressMatcher(servers.flatMap((x) => [x?.host, x?.ip]).filter((h) => typeof h === 'string' && h));
    const head = maskRow({ id: String(s.id), name: s.name || s.host || String(s.id) }, match);
    return res.json({
      server: { ...head, serviceTag: s.serviceTag || '', model: s.model || '', vendor: s.vendor || '', remote: !!s.remote, datacenterId: s.datacenterId || s.vcenterId || '' },
      at: d?.at ?? null, thermalAt: d?.thermalAt ?? null, collection: d?.collection || null, omitted: d?.omitted || 0,
      summary: list.length ? summarizeSensors(list) : null,
      sensors: list,
      ...(synthesized ? { synthesized: true } : {}),
      ...(admin ? {} : { addressHidden: true }),
    });
  });
}
