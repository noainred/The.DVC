/**
 * storage/ifaceSummary.js — Unity 인터페이스 화면 · 알림이 같이 쓰는 조립(v3.35.0 — 설계 docs/design/unity-iface).
 *
 * 입력: 장비 스냅샷의 `extra.ifaces`(구성 — 수집 주기마다) + 5분 표본(노드 부하 표 · 단위 kind 'port' FC · 'eth' 이더넷의 in/out bps) + 포트 상태 표(lastUpAt).
 * 판정은 `ifaces.judgePort` 하나 — 여기는 값을 모아 넘길 뿐이다. 장비 호출 0(DB · 스냅샷만 읽는다).
 *
 * 규칙:
 *  - 처리량은 **REST 수집 Unity 만** 있다(사용자 결정 — SSH 장비는 5분 표본이 없다). 없는 장비 · 포트는 `unread` 로 따로 센다(0 이 아니다).
 *  - 칸(띠) 24개 = 기간 ÷ 24(24시간 = 1시간 칸). 칸 값은 그 칸 표본들의 **최댓값**(피크)이다. 원시 보존 밖은 시간 요약으로(nodeLoadQuery 규약).
 *  - 피크 = 칸 최댓값들 중 최댓값 = 표본들의 max(in, out) 최댓값(같다 — max 는 교환된다). 평균은 방향별 평균 중 큰 쪽(근사 — 화면 주석).
 *  - 최근 값 = 마지막 표본(표본 주기 × 3 보다 오래되면 '오래됨' — 판정에 쓰지 않는다).
 */
import { numOrNull } from '../util/numOrNull.js';
import { nodeLoadQuery, nodeUnitsOf, ifaceStatesOf, DAY_OFFSET_MIN } from './db.js';
import { unitMatchKey } from './nodeLoad.js';
import { judgePort, utilPct, spBalance, isIfaceType, portMatchKey, IFACE_DEFAULTS } from './ifaces.js';
import { sampleDiagOf } from './sampleDiag.js';   // v3.36.1 사용량이 비는 이유의 근거

const HOUR = 3_600_000;
export const IFACE_RANGES = Object.freeze({ '24h': 24 * HOUR, '7d': 7 * 24 * HOUR, '30d': 30 * 24 * HOUR });
export const IFACE_CELLS = 24;
export const rangeKey = (v) => (Object.hasOwn(IFACE_RANGES, String(v)) ? String(v) : '24h');

/** 단위 카탈로그 → 포트 매칭 키 → 단위 id(kind port · eth 만). */
export function unitIdByPort(units = []) {
  const m = new Map();
  for (const u of units || []) {
    if (!u || (u.kind !== 'port' && u.kind !== 'eth')) continue;
    const name = String(u.name || '');
    const i = name.indexOf('::');
    m.set(unitMatchKey(i > 0 ? name.slice(i + 2) : name), u.id);
  }
  return m;
}

/**
 * 버킷 행(nodeLoadQuery kind bucket — v:{in,out} 평균 · mx 최대 · n 표본 수) → 단위별 칸 · 기간 요약(순수).
 * @returns {Map<number, {cells:Array<{ts, inMax, outMax, n}>, peakBps:number|null, peakAt:number|null, peakIn:number|null, peakOut:number|null, avgIn:number|null, avgOut:number|null, samples:number}>}
 */
export function bucketStats(rows, { from, bucketMs, cells = IFACE_CELLS } = {}) {
  const out = new Map();
  for (const r of rows || []) {
    const id = numOrNull(r?.node); const ts = numOrNull(r?.ts);
    if (id == null || ts == null) continue;
    const cur = out.get(id) || { cells: Array.from({ length: cells }, (_, i) => ({ ts: from + i * bucketMs, inMax: null, outMax: null, n: 0 })),
      peakBps: null, peakAt: null, peakIn: null, peakOut: null, sIn: 0, nIn: 0, sOut: 0, nOut: 0, samples: 0 };
    const i = Math.floor((ts - from) / bucketMs);
    const nIn = numOrNull(r.n?.in) || 0; const nOut = numOrNull(r.n?.out) || 0;
    const mxIn = nIn > 0 ? numOrNull(r.mx?.in) : null; const mxOut = nOut > 0 ? numOrNull(r.mx?.out) : null;
    if (i >= 0 && i < cells) {
      const c = cur.cells[i];
      if (mxIn != null) c.inMax = c.inMax == null ? mxIn : Math.max(c.inMax, mxIn);
      if (mxOut != null) c.outMax = c.outMax == null ? mxOut : Math.max(c.outMax, mxOut);
      c.n += Math.max(nIn, nOut);
    }
    const big = mxIn == null && mxOut == null ? null : Math.max(mxIn ?? 0, mxOut ?? 0);
    if (big != null && (cur.peakBps == null || big > cur.peakBps)) { cur.peakBps = big; cur.peakAt = ts; cur.peakIn = mxIn; cur.peakOut = mxOut; }
    const aIn = numOrNull(r.v?.in); const aOut = numOrNull(r.v?.out);
    if (aIn != null && nIn > 0) { cur.sIn += aIn * nIn; cur.nIn += nIn; }
    if (aOut != null && nOut > 0) { cur.sOut += aOut * nOut; cur.nOut += nOut; }
    cur.samples += Math.max(nIn, nOut);
    out.set(id, cur);
  }
  for (const v of out.values()) {
    v.avgIn = v.nIn > 0 ? v.sIn / v.nIn : null; v.avgOut = v.nOut > 0 ? v.sOut / v.nOut : null;
    delete v.sIn; delete v.nIn; delete v.sOut; delete v.nOut;
  }
  return out;
}
/** 원시 행 → 단위별 마지막 표본 { ts, in, out } (순수). 값이 null 인 방향은 그 방향의 직전 값을 덮지 않는다. */
export function latestRaw(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const id = numOrNull(r?.node); const ts = numOrNull(r?.ts);
    if (id == null || ts == null) continue;
    const cur = out.get(id) || { ts: null, in: null, out: null };
    if (cur.ts == null || ts >= cur.ts) {
      cur.ts = ts;
      const a = numOrNull(r.v?.in); const b = numOrNull(r.v?.out);
      if (a != null) cur.in = a;
      if (b != null) cur.out = b;
    }
    out.set(id, cur);
  }
  return out;
}

/**
 * 포트 한 줄 조립(순수) — 구성 + 처리량 요약 + 상태 → 화면 행. 판정은 judgePort.
 */
export function portRow(p, { stat = null, last = null, state = null, now = Date.now(), staleMs = 15 * 60_000, busyPct = IFACE_DEFAULTS.busyPct, idlePct = IFACE_DEFAULTS.idlePct } = {}) {
  const speed = numOrNull(p.speedGbps);
  const fresh = last && numOrNull(last.ts) != null && last.ts >= now - staleMs;
  const nowPct = fresh ? utilPct(last.in, last.out, speed) : null;
  const peakPct = stat && stat.peakBps != null ? utilPct(stat.peakIn, stat.peakOut, speed) : null;
  const avgPct = stat ? utilPct(stat.avgIn, stat.avgOut, speed) : null;
  const tp = stat || fresh ? { peakPct, avgPct, nowPct, samples: stat?.samples ?? 0 } : null;
  const j = judgePort(p, tp, { lastUpAt: state?.lastUpAt ?? null, busyPct, idlePct });
  return {
    ...p,
    readBps: fresh ? (p.kind === 'fc' ? last.out : last.in) : null,    // FC: 읽기 = 나간 것 · 이더넷: 받음
    writeBps: fresh ? (p.kind === 'fc' ? last.in : last.out) : null,   // FC: 쓰기 = 들어온 것 · 이더넷: 보냄
    lastTs: last?.ts ?? null, stale: !!last && !fresh,
    nowPct, peakPct, peakAt: stat?.peakAt ?? null, avgPct,
    avgBps: stat && (stat.avgIn != null || stat.avgOut != null) ? (stat.avgIn ?? 0) + (stat.avgOut ?? 0) : null,
    samples: stat?.samples ?? 0,
    cells: stat ? stat.cells.map((c) => (c.inMax == null && c.outMax == null ? null : utilPct(c.inMax, c.outMax, speed))) : null,
    lastUpAt: state?.lastUpAt ?? null,
    state: j.state, issue: j.issue, unread: j.unread, flags: j.flags,
  };
}

/**
 * 장비 하나의 인터페이스 보기(DB 읽기). snap 이 없거나 Unity 가 아니면 null.
 * @returns {Promise<{deviceId, at, source, probe, ports:Array, interfaces:Array, sp:object|null, hasThroughput:boolean, throughputWhy:string}>}
 */
export async function deviceIfaces(dev, snap, { range = '24h', now = Date.now(), sampleMs = 300_000, busyPct = IFACE_DEFAULTS.busyPct, idlePct = IFACE_DEFAULTS.idlePct, withCells = true } = {}) {
  if (!dev || !isIfaceType(dev.type)) return null;
  const ifc = snap?.extra?.ifaces;
  const ports = Array.isArray(ifc?.ports) ? ifc.ports : [];
  const rk = rangeKey(range);
  const span = IFACE_RANGES[rk];
  const bucketMs = Math.max(HOUR, Math.round(span / IFACE_CELLS / HOUR) * HOUR);
  // 칸 경계는 nodeLoadQuery 버킷과 같은 격자(포탈 날짜 오프셋)에 맞춘다 — 마지막 칸이 지금을 담는다.
  const off = DAY_OFFSET_MIN * 60_000;
  const from = Math.floor((now + off) / bucketMs) * bucketMs - off - (IFACE_CELLS - 1) * bucketMs;
  const staleMs = Math.max(15 * 60_000, sampleMs * 3);
  // v3.46.0: SSH 로 등록한 Unity 도 5분 표본이 있다(REST 먼저 · 안 되면 uemcli — collectors/unityMetricsSsh.js).
  const restSample = dev.nodeLoadEnabled !== false;
  let unitMap = new Map(); let stats = new Map(); let lasts = new Map(); let states = new Map(); let db = true; let allUnits = [];
  let statesKnown = true;
  try { const st = await ifaceStatesOf(dev.id); if (st) states = st; else statesKnown = false; } catch { statesKnown = false; }
  if (restSample && ports.length) {
    try {
      allUnits = await nodeUnitsOf(dev.id);
      unitMap = unitIdByPort(allUnits);
      if (unitMap.size) {
        if (withCells) {
          const q = await nodeLoadQuery(dev.id, { group: 'net', kind: 'bucket', from, to: now + 1, bucketMs });
          db = q.db; stats = bucketStats(q.rows, { from, bucketMs });
        }
        const lq = await nodeLoadQuery(dev.id, { group: 'net', kind: 'raw', from: now - staleMs, to: now + 1 });
        db = db && lq.db; lasts = latestRaw(lq.rows);
      }
    } catch { db = false; }
  }
  const unmatched = [];
  const rows = ports.map((p) => {
    const uid = unitMap.get(portMatchKey(p.id)) ?? unitMap.get(portMatchKey(p.name));
    if (uid == null && p.linkUp === true) unmatched.push(p.id);
    return portRow(p, { stat: uid != null ? stats.get(uid) || null : null, last: uid != null ? lasts.get(uid) || null : null,
      state: states.get(p.id) || null, now, staleMs, busyPct, idlePct });
  });
  const upPorts = ports.filter((p) => p.linkUp === true).length;
  const diag = sampleDiagOf(dev.id);
  const why = throughputWhyOf({ ports: ports.length, snapFailed: !!snap && !snap.ok, method: dev.collectMethod, sampleOff: dev.nodeLoadEnabled === false, db,
    units: allUnits.length, portUnits: unitMap.size, upPorts, unmatched: unmatched.length, withData: rows.filter((r) => !r.unread).length, diag });
  // v3.36.1: 사유의 근거 — 마지막 표본 진단 · 표본 쪽 포트 이름 · 짝을 못 찾은 구성 포트(각 8개까지). 화면이 '왜' 를 단정 대신 근거로 보여 준다.
  const unitNames = [...(allUnits || [])].filter((u) => u && (u.kind === 'port' || u.kind === 'eth')).slice(0, 8).map((u) => String(u.name || '').slice(0, 60));
  const throughputDetail = { diag, unitKinds: kindCounts(allUnits), unitNames, unmatchedPorts: unmatched.slice(0, 8), unmatched: unmatched.length, upPorts };
  const fcRows = rows.filter((r) => r.kind === 'fc' && r.linkUp === true);
  return {
    deviceId: dev.id, at: numOrNull(ifc?.at), source: ifc?.source || '', probe: ifc?.probe || {},
    portsDropped: numOrNull(ifc?.portsDropped) || 0, ifsDropped: numOrNull(ifc?.ifsDropped) || 0,
    ports: rows, interfaces: Array.isArray(ifc?.interfaces) ? ifc.interfaces : [],
    sp: { fc: spBalance(fcRows), eth: spBalance(rows.filter((r) => r.kind === 'eth' && r.linkUp === true)) },
    hasThroughput: rows.some((r) => !r.unread), throughputWhy: why, throughputDetail, statesKnown, range: rk, bucketMs, from, to: now, staleMs,
  };
}

const kindCounts = (units) => { const o = {}; for (const u of units || []) { const k = String(u?.kind || '') || 'unknown'; o[k] = (o[k] || 0) + 1; } return o; };
/**
 * v3.36.1(사용자 신고 '사용량이 보이지 않음' — 실제 현장 496 포트 전부 '못 읽음'): 처리량이 비는 **이유 판정**(순수 — 한 곳).
 * 예전에는 표본은 있는데 포트 이름이 짝지어지지 않으면 사유가 빈 글자('')였고, SP 값만 있고 포트 단위가 없으면 '아직 표본이 없습니다' 로 틀리게 말했다.
 * 순서가 곧 우선순위다(앞이 더 근본 원인). '' = 사유 없음(읽힌 포트가 있다 — 일부만 비면 partial 은 화면이 따로 센다).
 *  · no-config / collect-failed — 구성(포트 목록)이 없다          · (ssh — v3.46.0 에 없앴다: SSH 장비도 REST 먼저 · 안 되면 uemcli 로 표본을 읽는다)
 *  · sample-off — 표본 수집 꺼짐                                  · db-unavailable — DB 를 못 열었다
 *  · sample-failed — 표본이 하나도 없고 마지막 시도가 실패했다(진단 오류 문구가 근거)
 *  · no-samples — 표본이 하나도 없다(첫 표본 전 · 엣지에서 실패해 중앙에 안 왔을 수 있다)
 *  · no-port-units — 표본은 있는데 포트 단위가 없다(SP 값만 — 장비가 포트 지표 경로를 주지 않았다 · 진단의 경로별 항목 수가 근거)
 *  · no-match — 포트 단위는 있는데 구성 포트 id 와 이름이 하나도 짝지어지지 않는다(두 이름 목록이 근거)
 *  · no-recent — 짝은 맞는데 최근(표본 주기 × 3) · 기간 안에 값이 없다
 */
export function throughputWhyOf({ ports = 0, snapFailed = false, method = 'api', sampleOff = false, db = true, units = 0, portUnits = 0, upPorts = 0, unmatched = 0, withData = 0, diag = null } = {}) {
  if (!ports) return snapFailed ? 'collect-failed' : 'no-config';
  // v3.46.0: SSH 장비도 표본을 읽으므로 'ssh' 는 사유가 아니다(엣지가 아직 옛 판이면 표본이 없어 no-samples 로 말한다).
  if (sampleOff) return 'sample-off';
  if (!db) return 'db-unavailable';
  if (!units) return diag && diag.ok === false ? 'sample-failed' : 'no-samples';
  if (!portUnits) return 'no-port-units';
  if (upPorts > 0 && unmatched >= upPorts) return 'no-match';
  if (!withData) return 'no-recent';
  return '';
}

/** 장비 목록(등록부 + 스냅샷 Map) → Unity 만 장비 보기 배열. 한 장비가 실패해도 나머지는 계속(사유는 그 장비 칸). */
export async function fleetIfaces(devices, snapById, opts = {}) {
  const out = [];
  for (const d of devices || []) {
    if (!d || !isIfaceType(d.type)) continue;
    try { const v = await deviceIfaces(d, snapById.get(d.id) || null, opts); if (v) out.push({ device: d, snap: snapById.get(d.id) || null, view: v }); }
    catch (e) { out.push({ device: d, snap: snapById.get(d.id) || null, view: null, error: String(e?.message || e).slice(0, 160) }); }
  }
  return out;
}

/**
 * 알림 판정(순수 — alerts.js refreshState 가 부른다). 규칙: unityIfaceDown(링크 다운 — 직전에 업이던 포트) · unityIfaceSlow(자동 협상인데 최대보다 낮음) ·
 * unityIfaceBusy(최근 5분 사용률 ≥ 임계 — REST 수집 장비만). 상태형: 조건이 계속되는 동안 발생 중 · 풀리면 해소.
 * '모름' 은 해소가 아니다 — 수집 실패 · 낡은 스냅샷 · 구성 없음은 그 장비 접두(`unityif:<id>:`)를 통째로 보류하고, 사용률을 못 읽은 포트의 포화 키도 보류한다.
 * @param {Array<{device, snap, view}>} fleet fleetIfaces 결과
 * @returns {{alerts:Array<object>, held:string[], heldPrefixes:string[]}}
 */
export function ifaceAlertsOf(fleet, rules = {}, { now = Date.now(), staleMsOf = () => 3 * HOUR } = {}) {
  const alerts = []; const held = []; const heldPrefixes = [];
  const on = (k) => !!rules?.[k]?.enabled;
  if (!on('unityIfaceDown') && !on('unityIfaceSlow') && !on('unityIfaceBusy')) return { alerts, held, heldPrefixes };
  for (const x of fleet || []) {
    const d = x?.device; if (!d?.id || d.enabled === false) continue;
    const pre = `unityif:${d.id}:`;
    const snap = x.snap; const v = x.view;
    const at = numOrNull(snap?.collectedAt);
    if (!snap?.ok || at == null || at < now - staleMsOf(d) || !v || !v.ports.length) { heldPrefixes.push(pre); continue; }
    const name = d.name || snap.name || d.id;
    for (const p of v.ports) {
      const base = `${pre}${p.id}:`;
      const label = `${name} ${p.id}`;
      if (on('unityIfaceDown')) {
        // 포트 상태 표를 못 읽었으면(DB 없음) '다운' 과 '미연결' 을 가를 수 없다 — 내지도 해소하지도 않는다.
        if (v.statesKnown === false) held.push(`${base}down`);
        else if (p.state === 'down') alerts.push({ key: `${base}down`, severity: 'critical', title: `Unity 포트 링크 다운: ${label}`, detail: `${d.id} · ${p.kind === 'fc' ? 'FC' : '이더넷'} · 직전 링크 업 ${p.lastUpAt ? new Date(p.lastUpAt).toISOString() : '—'}` });
        else if (p.linkUp == null) held.push(`${base}down`);
      }
      if (on('unityIfaceSlow')) {
        if (p.flags.includes('slow')) alerts.push({ key: `${base}slow`, severity: 'warning', title: `Unity 포트 속도 저하: ${label} ${p.speedGbps} Gb (최대 ${p.maxGbps} Gb)`, detail: `${d.id} · 요청 속도 자동 · 상대 장비 · 케이블 · SFP 확인` });
        else if (p.linkUp == null || p.speedGbps == null || p.maxGbps == null) held.push(`${base}slow`);
      }
      if (on('unityIfaceBusy')) {
        const th = Number(rules.unityIfaceBusy.threshold) || IFACE_DEFAULTS.busyPct;
        if (p.nowPct == null) held.push(`${base}busy`);
        else if (p.nowPct >= th) alerts.push({ key: `${base}busy`, severity: 'warning', title: `Unity 포트 사용률 ${p.nowPct}%: ${label}`, detail: `${d.id} · 최근 5분 표본 · 링크 ${p.speedGbps} Gb · 기준 ${th}%` });
      }
    }
  }
  return { alerts, held, heldPrefixes };
}
