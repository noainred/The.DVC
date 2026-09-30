/**
 * iDRAC(Redfish) 센서 상세 — 판정·분류·요약(순수 모듈, v2.659).
 *
 * 사용자 요청: "특수 기능 › 서버 온도 를 세부적으로 · iDRAC 에서 수집하는 모든 센서 · inlet 온도로 전산실 온도 ·
 * CPU 사용량을 온도와 CPU performance 로 · GPU 사용량을 GPU 온도로". 선택: Sensors 컬렉션 전부 · CPU 사용률은
 * 베어메탈 사용률 값 재사용 · 전체 검증.
 *
 * 입력은 두 경로다.
 *  ① Thermal(`Chassis/<id>/Thermal`) — 폴러가 **매 주기** 이미 읽는다. 여기서 버리던 임계값·상태를 살린다(왕복 0).
 *  ② Sensors 컬렉션(`Chassis/<id>/Sensors`) — 전압·전류·전력·퍼센트까지 담는다. 인벤토리 주기(30분)에만 읽는다.
 * 둘을 합칠 때는 같은 센서(종류 + 이름)가 두 번 나오지 않게 한다 — 컬렉션이 먼저, Thermal 은 빈 칸만 채운다.
 *
 * ⚠ 규칙(이 저장소의 정직성 규약):
 *  · 값을 못 읽은 센서는 `reading:null` 이다 — 0 으로 두지 않는다(`Number(null) === 0` 함정 — util/numOrNull.js).
 *  · 상태는 다섯이다 — ok / warn / crit / **unknown**(판정 근거 없음) / **absent**(빈 슬롯). 뒤 둘을 정상에도 이상에도 넣지 않는다.
 *  · 상태 판정은 장비가 준 Health 가 먼저, 없으면 **장비가 준 임계값**으로만 판정한다. 포탈이 임계를 지어내지 않는다
 *    (모델마다 다르다 — v2.519 SAN 점검 규약). 임계도 Health 도 없으면 unknown.
 *  · 역할(흡기·배기·CPU·GPU·DIMM)은 **이름·PhysicalContext 에서 추정**한 것이다 — 화면이 그 사실을 말한다.
 */

import { numOrNull } from '../util/numOrNull.js';

export const SENSOR_KINDS = ['temperature', 'fan', 'voltage', 'current', 'power', 'percent', 'energy', 'other'];
export const SENSOR_ROLES = ['inlet', 'exhaust', 'cpu', 'gpu', 'dimm', 'psu', 'other'];
export const SENSOR_STATES = ['ok', 'warn', 'crit', 'unknown', 'absent'];
/** 한 서버에서 싣는 센서 수 상한 — 넘치면 개수를 밝힌다(조용한 상한 금지). */
export const SENSOR_LIST_MAX = 400;

const str = (v, max = 160) => (typeof v === 'string' ? v.trim().slice(0, max) : (typeof v === 'number' && Number.isFinite(v) ? String(v) : ''));
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/** Redfish ReadingType / 단위 → 종류. */
export function kindOf({ readingType = '', unit = '', name = '' } = {}) {
  const t = String(readingType).toLowerCase();
  const u = String(unit).toLowerCase();
  if (t === 'temperature' || u === 'cel' || u === 'c') return 'temperature';
  if (t === 'rotational' || u === 'rpm') return 'fan';
  if (t === 'voltage' || u === 'v') return 'voltage';
  if (t === 'current' || u === 'a') return 'current';
  if (t === 'power' || u === 'w') return 'power';
  if (t === 'energyjoules' || t === 'energykwh' || t === 'energywh' || u === 'kw.h' || u === 'kwh' || u === 'j') return 'energy';
  if (t === 'percent' || u === '%') return 'percent';
  if (/\btemp/i.test(name)) return 'temperature';
  if (/\bfan/i.test(name)) return 'fan';
  return 'other';
}

/**
 * 역할 추정 — 이름과 PhysicalContext. 순서가 계약이다: 전원공급장치 → 흡기·배기 → GPU → CPU
 * ('CPU Inlet' 같은 이름은 거의 없지만, 'Inlet Temp' 를 다른 것으로 읽으면 전산실 온도가 사라진다).
 */
export function roleOf({ name = '', context = '' } = {}) {
  const n = String(name).toLowerCase();
  const c = String(context).toLowerCase();
  // 전원공급장치 센서를 먼저 — HPE '32-P/S 1 Inlet' 을 흡기로 읽으면 전산실 온도가 PSU 내부 온도가 된다(v2.621 DATA-04 와 같은 규칙).
  if (/\bp\/?s\s*\d|\bp\/s\b|\bpsu\d*\b|power\s*supply/.test(n) || c === 'powersupply') return 'psu';
  if (/inlet|intake|ambient/.test(n) || c === 'intake' || c === 'room') return 'inlet';
  if (/exhaust|outlet/.test(n) || c === 'exhaust') return 'exhaust';
  if (/\bgpu|accelerator|\bgfx/.test(n) || c === 'gpu' || c === 'accelerator') return 'gpu';
  if (/\bcpu|processor|\bsoc\b/.test(n) || c === 'cpu') return 'cpu';
  if (/dimm|memory/.test(n) || c === 'memory') return 'dimm';
  return 'other';
}

function healthState(health) {
  const h = String(health ?? '').trim().toLowerCase();
  if (h === 'ok') return 'ok';
  if (h === 'warning') return 'warn';
  if (h === 'critical') return 'crit';
  return null;
}

/**
 * 한 센서의 상태. 순서: 빈 슬롯 → 장비 Health → 장비 임계값 → 판정 불가.
 * 임계 판정은 '값을 읽었고 그 쪽 임계가 있을 때' 만 한다(없는 임계를 0 으로 보지 않는다).
 */
export function sensorState(s) {
  if (!s || typeof s !== 'object') return 'unknown';
  if (s.absent) return 'absent';
  const h = healthState(s.health);
  if (h) return h;
  const v = numOrNull(s.reading);
  if (v == null) return 'unknown';
  const t = s.thresholds || {};
  const cMax = numOrNull(t.critMax); const cMin = numOrNull(t.critMin);
  const wMax = numOrNull(t.warnMax); const wMin = numOrNull(t.warnMin);
  if ((cMax != null && v >= cMax) || (cMin != null && v <= cMin)) return 'crit';
  if ((wMax != null && v >= wMax) || (wMin != null && v <= wMin)) return 'warn';
  if (cMax != null || cMin != null || wMax != null || wMin != null) return 'ok';
  return 'unknown';
}

function thresholdOf(o) {
  // Redfish Sensor 의 Thresholds.X 는 { Reading } 객체다. 숫자로 오는 구현도 받는다.
  if (o == null) return null;
  if (typeof o === 'object') return numOrNull(o.Reading);
  return numOrNull(o);
}

function finish(s) {
  const out = { ...s, reading: r1(numOrNull(s.reading)) };
  const th = {};
  for (const k of ['warnMin', 'warnMax', 'critMin', 'critMax']) {
    const v = numOrNull(s.thresholds?.[k]);
    if (v != null) th[k] = r1(v);
  }
  out.thresholds = th;
  out.role = roleOf(out);
  out.state = sensorState(out);
  return out;
}

/** Redfish Sensor 리소스(`Chassis/<id>/Sensors/<id>`) → 센서 레코드. 이름·값·종류가 하나도 없으면 null. */
export function parseRedfishSensor(o, { chassis = '' } = {}) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const name = str(o.Name) || str(o.Id);
  if (!name) return null;
  const unit = str(o.ReadingUnits, 24);
  const readingType = str(o.ReadingType, 32);
  const th = o.Thresholds && typeof o.Thresholds === 'object' ? o.Thresholds : {};
  const state = str(o.Status?.State, 32).toLowerCase();
  return finish({
    id: str(o.Id, 120) || name,
    name,
    kind: kindOf({ readingType, unit, name }),
    reading: o.Reading,
    unit,
    health: str(o.Status?.Health, 16) || null,
    absent: state === 'absent',
    context: str(o.PhysicalContext, 40),
    chassis,
    source: 'sensors',
    thresholds: {
      warnMin: thresholdOf(th.LowerCaution), warnMax: thresholdOf(th.UpperCaution),
      critMin: thresholdOf(th.LowerCritical), critMax: thresholdOf(th.UpperCritical),
    },
  });
}

/** Thermal.Temperatures[] 원소 → 센서 레코드(임계값·상태를 살린다). */
export function parseThermalTemp(t, { chassis = '' } = {}) {
  if (!t || typeof t !== 'object') return null;
  const name = str(t.Name) || str(t.MemberId) || (t.SensorNumber != null ? `Sensor ${t.SensorNumber}` : '');
  if (!name) return null;
  const state = str(t.Status?.State, 32).toLowerCase();
  return finish({
    id: str(t.MemberId, 120) || name,
    name, kind: 'temperature', reading: t.ReadingCelsius, unit: 'Cel',
    health: str(t.Status?.Health, 16) || null,
    absent: state === 'absent',
    context: str(t.PhysicalContext, 40), chassis, source: 'thermal',
    thresholds: {
      warnMin: numOrNull(t.LowerThresholdNonCritical), warnMax: numOrNull(t.UpperThresholdNonCritical),
      critMin: numOrNull(t.LowerThresholdCritical), critMax: numOrNull(t.UpperThresholdCritical),
    },
  });
}

/** Thermal.Fans[] 원소 → 센서 레코드. HPE 의 Percent 단위는 퍼센트로 둔다(RPM 으로 읽지 않는다 — v2.611). */
export function parseThermalFan(f, { chassis = '' } = {}) {
  if (!f || typeof f !== 'object') return null;
  const name = str(f.Name) || str(f.FanName) || str(f.MemberId);
  if (!name) return null;
  const pct = /^\s*percent\s*$/i.test(String(f.ReadingUnits ?? ''));
  const state = str(f.Status?.State, 32).toLowerCase();
  return finish({
    id: str(f.MemberId, 120) || name,
    name, kind: 'fan', reading: f.Reading ?? f.ReadingRPM, unit: pct ? '%' : 'RPM',
    health: str(f.Status?.Health, 16) || null,
    absent: state === 'absent',
    context: str(f.PhysicalContext, 40), chassis, source: 'thermal',
    thresholds: {
      warnMin: numOrNull(f.LowerThresholdNonCritical), warnMax: numOrNull(f.UpperThresholdNonCritical),
      critMin: numOrNull(f.LowerThresholdCritical), critMax: numOrNull(f.UpperThresholdCritical),
    },
  });
}

const keyOf = (s) => `${s.kind}|${String(s.name).trim().toLowerCase()}`;

/**
 * 두 출처를 합친다. 컬렉션 레코드가 먼저이고, 같은 센서의 Thermal 레코드는 **비어 있는 값만** 채운다
 * (예: 컬렉션에 임계가 없으면 Thermal 의 임계). Thermal 에만 있는 센서는 그대로 더한다.
 * @returns {{ list: object[], omitted: number }}
 */
export function mergeSensors(collection = [], thermal = [], { max = SENSOR_LIST_MAX } = {}) {
  const byKey = new Map();
  const add = (s, fill) => {
    if (!s || typeof s !== 'object' || !s.name) return;
    const k = keyOf(s);
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, { ...s }); return; }
    if (!fill) return;
    const m = { ...prev };
    if (m.reading == null && s.reading != null) m.reading = s.reading;
    if (!m.health && s.health) m.health = s.health;
    const th = { ...(prev.thresholds || {}) };
    for (const [tk, tv] of Object.entries(s.thresholds || {})) if (th[tk] == null && tv != null) th[tk] = tv;
    m.thresholds = th;
    m.source = 'both';
    byKey.set(k, finish(m));
  };
  for (const s of collection || []) add(s, false);
  for (const s of thermal || []) add(s, true);
  const all = [...byKey.values()];
  const list = all.slice(0, max);
  return { list, omitted: all.length - list.length };
}

const maxOf = (arr) => { let m = null; for (const v of arr) if (v != null && (m == null || v > m)) m = v; return m; };
const avgOf = (arr) => { const xs = arr.filter((v) => v != null); return xs.length ? r1(xs.reduce((a, b) => a + b, 0) / xs.length) : null; };

/**
 * 서버 한 대의 요약 — 목록 표가 쓴다. 역할별 온도는 온도 센서에서만 뽑는다(팬·전력의 'CPU' 이름을 섞지 않는다).
 * ⚠ 흡기가 여러 개면 **최대**(판정 규약 v2.381 — 흡기 최고값)와 개수를 함께 준다.
 */
export function summarizeSensors(list = []) {
  const temps = (list || []).filter((s) => s && s.kind === 'temperature' && !s.absent);
  const pick = (role) => temps.filter((s) => s.role === role);
  const vals = (xs) => xs.map((s) => numOrNull(s.reading));
  const counts = Object.fromEntries(SENSOR_STATES.map((k) => [k, 0]));
  const byKind = {};
  for (const s of list || []) {
    if (!s || typeof s !== 'object') continue;
    counts[SENSOR_STATES.includes(s.state) ? s.state : 'unknown'] += 1;
    byKind[s.kind] = (byKind[s.kind] || 0) + 1;
  }
  const inlet = pick('inlet'); const cpu = pick('cpu'); const gpu = pick('gpu');
  // Sensors 컬렉션의 CPU 사용률 센서(Dell SystemBoardCPUUsage 등 — 퍼센트). 없으면 null(지어내지 않는다).
  const cpuUse = (list || []).find((s) => s && s.kind === 'percent' && s.role === 'cpu' && /usage|util/i.test(s.name) && numOrNull(s.reading) != null);
  return {
    total: (list || []).length,
    counts, byKind,
    inletC: maxOf(vals(inlet)), inletCount: inlet.length,
    exhaustC: maxOf(vals(pick('exhaust'))),
    cpuTempMaxC: maxOf(vals(cpu)), cpuTempAvgC: avgOf(vals(cpu)), cpuTempCount: cpu.length,
    gpuTempMaxC: maxOf(vals(gpu)), gpuTempAvgC: avgOf(vals(gpu)), gpuTempCount: gpu.length,
    dimmTempMaxC: maxOf(vals(pick('dimm'))),
    sensorCpuUsagePct: cpuUse ? numOrNull(cpuUse.reading) : null,
    sensorCpuUsageName: cpuUse ? cpuUse.name : '',
    worst: counts.crit ? 'crit' : counts.warn ? 'warn' : (counts.ok ? 'ok' : 'unknown'),
  };
}

/**
 * 엣지 export 용 콤팩트 레코드(필드 이름을 줄인다) ↔ 복원. 중앙은 `expandCompact` 로 되돌린 뒤 finish 로
 * **상태를 다시 판정**한다 — 엣지가 보낸 state 를 믿지 않는다(판정 규칙을 고치면 중앙만 바꾸면 된다).
 */
export function compactSensor(s) {
  if (!s || typeof s !== 'object') return null;
  const o = { n: s.name, k: s.kind };
  if (s.reading != null) o.v = s.reading;
  if (s.unit) o.u = s.unit;
  if (s.health) o.h = s.health;
  if (s.absent) o.a = 1;
  if (s.context) o.c = s.context;
  const th = s.thresholds || {};
  if (th.warnMin != null) o.wl = th.warnMin;
  if (th.warnMax != null) o.wh = th.warnMax;
  if (th.critMin != null) o.cl = th.critMin;
  if (th.critMax != null) o.ch = th.critMax;
  if (s.source && s.source !== 'sensors') o.s = s.source;
  return o;
}
export function expandCompact(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const name = str(o.n);
  if (!name) return null;
  const kind = SENSOR_KINDS.includes(o.k) ? o.k : 'other';
  const source = ['thermal', 'both', 'sensors'].includes(o.s) ? o.s : 'sensors';
  return finish({
    id: name, name, kind, reading: numOrNull(o.v), unit: str(o.u, 24),
    health: str(o.h, 16) || null, absent: o.a === 1 || o.a === true, context: str(o.c, 40), chassis: '', source,
    thresholds: { warnMin: numOrNull(o.wl), warnMax: numOrNull(o.wh), critMin: numOrNull(o.cl), critMax: numOrNull(o.ch) },
  });
}
