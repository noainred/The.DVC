/**
 * bmusage/powerAgg.js — 리눅스 성능 8b단계 **전력 · 온도 집계**(설계 PROFILES §20 ㉒ · 아트보드 Power). 새 수집 없음 — 이미 가진 값만 묶는다.
 *
 * 원천(전부 기존 — 한 소스 · 두 화면):
 *   · 지금 W — `idrac/service.js allMeasuredPower`(전력 대시보드 /power-breakdown · FinOps · Overview 와 **같은 함수** · 같은 신선도 컷 2시간) 중 iDRAC · OME · 엣지 실측만
 *     (vCenter 추정 source 'vcenter' 는 넣지 않는다 — power/total.js 와 같은 규칙). 교차 검증 시험이 같은 입력의 법인 합을 /power-breakdown 계산과 대조한다.
 *   · 24시간 평균 · 피크 · kWh · 월 누적 — iDRAC 폴러의 시간 롤업 power_hourly(시간 평균 W × 1h 합 · 피크 = 시간 최대의 최대) · 엣지 서버는 중앙 사본(rmt: 키 — collector/puller).
 *     법인 · 랙 24시간 피크는 **같은 시간의 합**(시간 평균 기준 — 1시간 안 순간 피크는 아님)이고 측정 서버가 다 모인 시간만으로 본다(부분 합을 피크로 쓰지 않는다).
 *   · PowerCap — 인벤토리 powerCap.limitWatts(이 노드 iDRAC 서버 · 2시간 넘은 인벤토리는 쓰지 않는다). ⚠ 엣지 인벤토리 축약(collector/compactInv.js)에는 powerCap 이 없어
 *     엣지 위임 서버의 상한은 ‘확인 불가’ 다(정직 기록 — 중앙 필드를 늘리지 않았다). ‘걸림’ = 지금 W ≥ 상한 × capHitPct%(기본 98%).
 *   · 흡기 · 최대 온도 — 서버 분석 › 법인별 온도와 같은 원천(로컬 sensorStore 최신 · 엣지 export s.sensors · roomTemp 분류 · 신선도). **지금 값만** —
 *     흡기 시계열은 IDRAC_TEMP_SERIES_DETAIL=true(옵트인 · 기본 꺼짐)일 때만 metrics DB 에 있어 이 화면은 시계열을 그리지 않는다(지어내지 않는다).
 *   · 팬 경고 — 파트 장애(⑦)의 열린 팬 장애 수(재판정하지 않는다) · 센서 표본이 없거나 낡았으면 ‘못 읽음’(정상으로 세지 않는다 — 파트 장애 F1 규칙).
 *   · 랙 · U — 설정 랙 배치(perfRules power.racks — 등록 CSV 에 ‘랙/위치’ 열이 없어 이 설정이 유일한 원천) · 없으면 ‘미매핑’.
 * ⚠ 미측정(iDRAC 없음 · 읽기 실패 · 0 W 보고)은 **합계에서 빼고 사유별로 센다**(0 W 를 ‘꺼짐’ · ‘유휴’ 로 더하지 않는다 · 추정으로 메우지 않는다).
 * 서버 식별은 (법인, 키) 쌍(maint/judge.js targetIdOf) · 요청 경로 비용: 함대 계산 하나를 60초 공유(진행 중이면 같은 프라미스) · 서버 사이 시간 기준 양보.
 */
import { numOrNull } from '../util/numOrNull.js';
import { createYielder } from '../util/timeSlice.js';
import { targetIdOf } from './maint/judge.js';
import { periodKeyOf, periodRange } from './monthStore.js';
import { dayKey, DAY_MS } from '../util/dayKey.js';
import { DEFAULTS as RULE_DEFAULTS } from './perfRules.js';

const n = numOrNull;
const HOUR = 3_600_000;
export const POWER_DEFAULTS = Object.freeze({ ...RULE_DEFAULTS.power });
export const UNMEASURED = Object.freeze(['no-idrac', 'read-fail', 'zero']);
export const UNMAPPED_RACK = '';
export const INLET_BINS = Object.freeze([18, 20, 22, 24, 26, 27, 29]);
export const HOT_MAX = 200;
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

/**
 * 서버 한 대의 시간 행 → 24시간 요약(순수). 0 W 이하 시간은 미측정(빼고 센다).
 * @param {Array<{ts,avg,max}>} hours
 */
export function hourSummary(hours = []) {
  const ok = (Array.isArray(hours) ? hours : []).filter((h) => n(h?.avg) != null && Number(h.avg) > 0);
  if (!ok.length) return null;
  const wh = ok.reduce((a, h) => a + Number(h.avg), 0);
  return { avgW: Math.round(wh / ok.length), peakW: Math.round(Math.max(...ok.map((h) => n(h.max) ?? Number(h.avg)))), kwh: r2(wh / 1000), hours: ok.length,
    byHour: ok.map((h) => ({ t: Math.floor(Number(h.ts) / HOUR) * HOUR, w: Number(h.avg) })) };
}

/** 그룹 한 칸(누적용). */
const emptyGroup = () => ({ servers: 0, measured: 0, unmeasured: { 'no-idrac': 0, 'read-fail': 0, zero: 0 }, nowW: 0, avg24W: 0, avg24N: 0, kwh24: 0, kwhMonth: 0, monthN: 0,
  hours: new Map(), inletSum: 0, inletN: 0, inletMax: null, maxC: null, fanWarn: 0, fanUnread: 0, capSet: 0, capHit: 0 });
function addTo(g, s) {
  g.servers += 1;
  if (s.w != null) { g.measured += 1; g.nowW += s.w; } else g.unmeasured[UNMEASURED.includes(s.unmeasured) ? s.unmeasured : 'read-fail'] += 1;
  if (s.h24) { g.avg24W += s.h24.avgW; g.avg24N += 1; g.kwh24 += s.h24.kwh; for (const h of s.h24.byHour) { const e = g.hours.get(h.t) || { w: 0, n: 0 }; e.w += h.w; e.n += 1; g.hours.set(h.t, e); } }
  if (s.kwhMonth != null) { g.kwhMonth += s.kwhMonth; g.monthN += 1; }
  if (s.inletC != null) { g.inletSum += s.inletC; g.inletN += 1; g.inletMax = g.inletMax == null ? s.inletC : Math.max(g.inletMax, s.inletC); }
  if (s.maxC != null) g.maxC = g.maxC == null ? s.maxC : Math.max(g.maxC, s.maxC);
  if (s.fanWarn != null) g.fanWarn += s.fanWarn;
  if (s.fanRead === false) g.fanUnread += 1;
  if (s.capW != null) g.capSet += 1;
  if (s.capHit) g.capHit += 1;
}
/** 그룹 마감(순수) — 피크는 측정 서버가 다 모인 시간(n = 최대)만. */
function finishGroup(g, { capKw = null, rackLowPct = 10 } = {}) {
  const hrs = [...g.hours.entries()].sort((a, b) => a[0] - b[0]);
  const full = hrs.length ? Math.max(...hrs.map(([, e]) => e.n)) : 0;
  const complete = hrs.filter(([, e]) => e.n === full);
  const pk = complete.reduce((a, [t, e]) => (a == null || e.w > a.w ? { t, w: e.w } : a), null);
  const nowKw = g.measured ? r2(g.nowW / 1000) : null;
  const margin = capKw != null && nowKw != null ? r1(((capKw - nowKw) / capKw) * 100) : null;
  return {
    servers: g.servers, measured: g.measured, unmeasured: g.unmeasured, unmeasuredN: g.servers - g.measured,
    nowW: g.measured ? Math.round(g.nowW) : null, nowKw, avg24Kw: g.avg24N ? r2(g.avg24W / 1000) : null, avg24Servers: g.avg24N, peak24Kw: pk ? r2(pk.w / 1000) : null, peak24At: pk ? pk.t : null, peakServers: full,
    partialHours: hrs.length - complete.length, kwh24: g.avg24N ? r1(g.kwh24) : null, kwhMonth: g.monthN ? r1(g.kwhMonth) : null, monthServers: g.monthN,
    capKw, marginPct: margin, low: margin != null && margin < rackLowPct,
    inletAvg: g.inletN ? r1(g.inletSum / g.inletN) : null, inletMax: g.inletMax, maxC: g.maxC, inletServers: g.inletN,
    fanWarn: g.fanWarn, fanUnread: g.fanUnread, capSet: g.capSet, capHit: g.capHit,
    trend: hrs.map(([t, e]) => ({ t, kw: r2(e.w / 1000), n: e.n, partial: e.n < full })),
  };
}

/**
 * 함대 집계(순수 — 시험 대상). servers = gather 의 서버 기록(이미 범위로 거른 것) · racks = 설정 랙 배치.
 * @returns {{ corps:Array, racks:Array, hot:Array, capHit:Array, fleet:object, bins:Array, rackOf:Map }}
 */
export function aggregatePower(servers = [], { racks = [], cfg = {} } = {}) {
  // 기준값만(랙 배치 목록은 cfg 로 받지 않는다 — 응답에 실리는 cfg 로 다른 법인 랙이 새지 않게)
  const c = { ...POWER_DEFAULTS, ...Object.fromEntries(Object.entries(cfg || {}).filter(([k, v]) => v != null && k in POWER_DEFAULTS)) };
  const rackOf = new Map();
  for (const r of Array.isArray(racks) ? racks : []) for (const sv of r.servers || []) rackOf.set(`${r.vcenterId}|${sv.key}`, { rack: r.rack, u: sv.u ?? null, capKw: r.capKw ?? null });
  const rackCap = new Map((Array.isArray(racks) ? racks : []).map((r) => [`${r.vcenterId}|${r.rack}`, r.capKw ?? null]));
  const fleet = emptyGroup(); const corps = new Map(); const rg = new Map();
  const seen = new Set();
  const list = [];
  for (const s0 of servers) {
    const id = targetIdOf(s0);
    if (seen.has(id)) continue;
    seen.add(id);
    const rk = rackOf.get(`${s0.vcenterId}|${s0.key}`) || null;
    const s = { ...s0, rack: rk ? rk.rack : UNMAPPED_RACK, u: rk ? rk.u : null };
    const capHit = s.w != null && s.capW != null && s.capW > 0 ? s.w >= (s.capW * c.capHitPct) / 100 : null;
    s.capPct = s.w != null && s.capW != null && s.capW > 0 ? r1((s.w / s.capW) * 100) : null;
    s.capHit = capHit;
    list.push(s);
    addTo(fleet, s);
    if (!corps.has(s.vcenterId)) corps.set(s.vcenterId, emptyGroup());
    addTo(corps.get(s.vcenterId), s);
    const rid = `${s.vcenterId}|${s.rack}`;
    if (!rg.has(rid)) rg.set(rid, emptyGroup());
    addTo(rg.get(rid), s);
  }
  const rackRows = [...rg.entries()].map(([rid, g]) => {
    const [vc, rack] = [rid.slice(0, rid.indexOf('|')), rid.slice(rid.indexOf('|') + 1)];
    const capKw = rack ? (rackCap.get(rid) ?? null) : null;
    return { vcenterId: vc, rack, unmapped: !rack, ...finishGroup(g, { capKw, rackLowPct: c.rackLowPct }) };
  }).sort((a, b) => (a.unmapped - b.unmapped) || ((a.marginPct ?? 1e9) - (b.marginPct ?? 1e9)) || String(a.rack).localeCompare(String(b.rack)));
  const corpRows = [...corps.entries()].map(([vc, g]) => ({ vcenterId: vc, ...finishGroup(g) })).sort((a, b) => String(a.vcenterId).localeCompare(String(b.vcenterId)));
  const hot = list.filter((s) => (s.inletC != null && s.inletC >= c.inletWarnC) || s.capHit === true)
    .sort((a, b) => (b.inletC ?? -1) - (a.inletC ?? -1) || (b.capPct ?? -1) - (a.capPct ?? -1)).slice(0, HOT_MAX)
    .map(serverView);
  const bins = INLET_BINS.map((lo, i) => ({ lo, hi: INLET_BINS[i + 1] ?? null, n: 0 }));
  let below = 0;
  for (const s of list) {
    if (s.inletC == null) continue;
    let k = -1; for (let i = 0; i < INLET_BINS.length; i += 1) if (s.inletC >= INLET_BINS[i]) k = i;
    if (k < 0) below += 1; else bins[k].n += 1;
  }
  const f = finishGroup(fleet);
  const minRack = rackRows.filter((r) => r.marginPct != null).sort((a, b) => a.marginPct - b.marginPct)[0] || null;
  return {
    fleet: { ...f, racks: rackRows.filter((r) => !r.unmapped).length, unmappedServers: rackRows.filter((r) => r.unmapped).reduce((a, r) => a + r.servers, 0),
      minMargin: minRack ? { vcenterId: minRack.vcenterId, rack: minRack.rack, pct: minRack.marginPct } : null,
      hotCount: list.filter((s) => s.inletC != null && s.inletC >= c.inletWarnC).length, hottest: hot[0] && hot[0].inletC != null ? { name: hot[0].name, inletC: hot[0].inletC } : null,
      inletBelow: below },
    corps: corpRows, racks: rackRows, hot, bins, cfg: c,
    capHit: list.filter((s) => s.capHit === true).map(serverView).slice(0, HOT_MAX),
    serversOf: (vc, rack) => list.filter((s) => s.vcenterId === vc && s.rack === rack).map(serverView).sort((a, b) => (a.u ?? 999) - (b.u ?? 999) || (b.w ?? -1) - (a.w ?? -1)),
  };
}
const serverView = (s) => ({ key: s.key, name: s.name, vcenterId: s.vcenterId, node: s.node, via: s.via, rack: s.rack, u: s.u, w: s.w, unmeasured: s.unmeasured || null,
  avg24W: s.h24?.avgW ?? null, peak24W: s.h24?.peakW ?? null, capW: s.capW ?? null, capPct: s.capPct ?? null, capHit: s.capHit ?? null,
  inletC: s.inletC ?? null, maxC: s.maxC ?? null, tempAt: s.tempAt ?? null, fanWarn: s.fanWarn ?? null, fanRead: s.fanRead ?? null });

/* ════════════════════════ 원천 모으기(이 노드) ════════════════════════ */
const t = (v) => String(v ?? '').trim();
const up = (v) => t(v).toUpperCase();
const _dayWh = new Map();   // `${dbKey}|${YYYY-MM-DD}` → Wh(끝난 날만 — 값이 바뀌지 않는다)
export function _resetPowerAggForTest() { _dayWh.clear(); _fleet = null; }

/** 온도 최신(순수) — roomTemp 분류(흡기 = 흡기 계열 최대 · 최대 = CPU · 배기 계열 최대) · 신선도. */
export function tempsOf(latest, { now = Date.now(), maxAgeMs = 15 * 60_000, classify }) {
  if (!latest || !latest.temps || typeof latest.temps !== 'object') return { inletC: null, maxC: null, at: null, state: 'none' };
  const at = n(latest.t);
  if (at == null || now - at > maxAgeMs) return { inletC: null, maxC: null, at, state: 'stale' };
  let inlet = null; let mx = null;
  for (const [name, v] of Object.entries(latest.temps)) {
    const c = n(v); if (c == null) continue;
    const k = classify(name);
    if (k === 'inlet') inlet = inlet == null ? c : Math.max(inlet, c);
    else if (k === 'cpu' || k === 'exhaust') mx = mx == null ? c : Math.max(mx, c);
  }
  return { inletC: inlet, maxC: mx, at, state: inlet == null && mx == null ? 'none' : 'ok' };
}

/**
 * 원천을 모아 서버 기록을 만든다(이 노드 — 중앙은 엣지 위임 서버도 중앙 사본으로 본다). deps 로 시험이 주입한다.
 * @param {{targets:Array<{key,name,vcenterId,serviceTag?,idrac?,node,via}>, deps:object, now?:number}} p
 */
export async function gatherPower({ targets = [], deps, now = Date.now() }) {
  const D = deps;
  const measured = (await D.measured().catch(() => [])).filter((m) => m && m.source !== 'vcenter');
  const byId = new Map(); const byTag = new Map();
  for (const m of measured) {
    if (m.serverId) byId.set(t(m.serverId), m);
    const tag = up(m.serviceTag);
    if (tag) { if (!byTag.has(tag)) byTag.set(tag, []); byTag.get(tag).push(m); }
  }
  const analysis = await D.analysisServers().catch(() => []);
  const aById = new Map(); const aByTag = new Map();
  for (const s of analysis) { if (s?.id) aById.set(t(s.id), s); const tag = up(s?.serviceTag); if (tag && !aByTag.has(tag)) aByTag.set(tag, s); }
  const faults = await D.fanFaults().catch(() => null);
  const idb = await D.powerDb().catch(() => null);
  const { classify, maxAgeOf } = D.temps;
  const y = D.yielder || createYielder(15);
  const monthKey = periodKeyOf('toph', now);
  const monthStart = monthKey ? periodRange('toph', monthKey)[0] : now - 30 * DAY_MS;
  const today = dayKey(now);
  const todayStart = periodRange('top', today)[0];   // 포탈 날 시작(날 파일 가족의 기간 계산을 그대로 쓴다)
  const out = [];
  for (const tg of targets) {
    const vc = t(tg.vcenterId); const tag = up(tg.serviceTag);
    const regId = t(tg.idrac?.regId);
    const pick = (list) => (list ? (list.find((m) => t(m.vcenterId) === vc) || (list.length === 1 ? list[0] : null)) : null);
    const m = (regId && byId.get(regId)) || pick(tag ? byTag.get(tag) : null) || null;
    const a = (regId && aById.get(regId)) || (tag ? aByTag.get(tag) : null) || null;
    let w = null; let unmeasured = null;
    if (m && n(m.watts) != null && Number(m.watts) > 0) w = Number(m.watts);
    else if (m && n(m.watts) != null) unmeasured = 'zero';
    else unmeasured = a || regId || (tg.paths || []).includes('idrac') ? 'read-fail' : 'no-idrac';
    // 24시간 · 월 누적 — 시간 롤업(같은 계열 키 — 로컬 iDRAC = 등록부 id · OME = 장비 키 · 엣지 = rmt: 사본)
    const dbKey = m ? t(m.source === 'remote' ? (m.dbKey || '') : m.serverId) : (regId || '');
    let h24 = null; let kwhMonth = null;
    if (dbKey && idb?.hourlyStats) {
      try {
        const rows = idb.hourlyStats(dbKey, now - DAY_MS, now);
        h24 = hourSummary(rows);
        // 월 누적 = 끝난 날(캐시) + 오늘(24시간 행 중 오늘 것)
        let wh = 0; let any = false;
        const missDays = [];
        for (let d = monthStart; d < todayStart; d += DAY_MS) { const k = `${dbKey}|${dayKey(d + HOUR)}`; if (_dayWh.has(k)) { const v = _dayWh.get(k); if (v != null) { wh += v; any = true; } } else missDays.push(d); }
        if (missDays.length) {
          const mr = idb.hourlyStats(dbKey, missDays[0], todayStart);
          const per = new Map();
          for (const h of mr || []) { if (n(h.avg) == null || Number(h.avg) <= 0) continue; const k = dayKey(Number(h.ts) + 1); per.set(k, (per.get(k) || 0) + Number(h.avg)); }
          for (const d of missDays) { const dk = dayKey(d + HOUR); const v = per.has(dk) ? per.get(dk) : null; _dayWh.set(`${dbKey}|${dk}`, v); if (v != null) { wh += v; any = true; } }
        }
        for (const h of rows || []) if (Number(h.ts) >= todayStart && n(h.avg) != null && Number(h.avg) > 0) { wh += Number(h.avg); any = true; }
        kwhMonth = any ? r1(wh / 1000) : null;
      } catch { h24 = null; kwhMonth = null; }
    }
    // 상한 · 온도 · 팬
    const inv = D.inventoryOf(a, regId);
    const capW = n(inv?.powerCap?.limitWatts);
    const latest = a ? (a.remote ? a.sensors : D.sensorLatest(t(a.id))) : (regId ? D.sensorLatest(regId) : null);
    const tp = tempsOf(latest, { now, maxAgeMs: maxAgeOf(latest, !!a?.remote), classify });
    let fanWarn = null;
    if (faults) { const ids = [t(a?.id), regId, tag].filter(Boolean); fanWarn = faults.filter((f) => ids.includes(t(f.deviceId)) || (tag && up(f.deviceKey) === tag)).length; }
    out.push({ key: t(tg.key), name: t(tg.name) || t(tg.key), vcenterId: vc, node: tg.node || '', via: tg.via || 'local', w, unmeasured: w == null ? unmeasured : null, at: m ? n(m.ts) : null,
      h24, kwhMonth, capW: capW != null && capW > 0 ? capW : null, inletC: tp.inletC, maxC: tp.maxC, tempAt: tp.at, tempState: tp.state,
      fanWarn, fanRead: tp.state === 'ok' ? true : (a || regId ? false : null) });
    await y();
  }
  // 캐시 정리 — 40일 넘은 날 · 이번 대상에 없는 계열은 버린다(누수 방지)
  const cut = dayKey(now - 40 * DAY_MS);
  for (const k of _dayWh.keys()) if (k.slice(k.lastIndexOf('|') + 1) < cut) _dayWh.delete(k);
  return out;
}

/* ── 함대 계산 공유(요청 경로) ── 60초 · 진행 중이면 같은 프라미스(동시 요청이 같은 일을 두 번 하지 않게) ── */
let _fleet = null;   // { key, at, p }
export const FLEET_TTL_MS = 60_000;
export function sharedPowerFleet(key, compute, { now = Date.now() } = {}) {
  if (_fleet && _fleet.key === key && now - _fleet.at < FLEET_TTL_MS) return _fleet.p;
  const p = compute().catch((e) => { if (_fleet?.p === p) _fleet = null; throw e; });
  _fleet = { key, at: now, p };
  return p;
}
