/**
 * cvp/parse.js — Arista CloudVision(CVP) 응답 파서(순수 함수, v2.608).
 *
 * ⚠⚠ 정직 기록 — **실장비 CVP 응답을 본 적이 없다.** 경로·필드명은 공개 문서·관용 형태에서 추정했다(docs/CVP.md).
 *   그래서 파서는 형식에 관용적이다:
 *     · Resource API 스트림 — 줄마다 `{"result":{"value":{...}}}`(NDJSON) · JSON 배열 · 이어 붙인 JSON 객체
 *     · Telemetry REST — `{"notifications":[{"path":"…","updates":{"k":{"key":"k","value":…}}}]}`
 *     · 평범한 JSON 배열/맵
 *   **못 읽으면 null 이다 — 0 을 지어내지 않는다**(CLAUDE.md '못 읽은 값은 null'). 빈 배열(= 읽었고 0개)과 구분한다.
 *
 * 상태 판정: 부품은 partfault 와 같은 다섯 이름(ok/warn/fault/unknown/absent). 상태 단어는 storage/healthWord.js 하나.
 */
import { healthWord } from '../storage/healthWord.js';
import { numOrNull } from '../util/numOrNull.js';
import { capStr } from '../util/capStr.js';

export const DEVICE_MAX = 2000;
export const PORT_MAX = 1024;
export const PEER_MAX = 512;
export const PART_MAX = 512;
const STR = 256;

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (v, n = STR) => capStr(v, n);

/**
 * 텍스트 → JSON 값 목록. 한 덩어리 JSON(배열이면 원소를 펼친다) → 실패하면 줄 단위(NDJSON) → 실패하면
 * 이어 붙인 객체(`}{`)를 중괄호 깊이로 나눈다. 못 읽은 조각 수를 돌려준다(조용히 버리지 않는다).
 * @returns {{ values: any[], bad: number }}
 */
export function splitJsonStream(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return { values: [], bad: 0 };
  try {
    const v = JSON.parse(t);
    return { values: Array.isArray(v) ? v : [v], bad: 0 };
  } catch { /* 스트림 형태 */ }
  const values = []; let bad = 0;
  // 중괄호 깊이로 최상위 객체를 자른다(문자열 안의 괄호·이스케이프는 건너뛴다). 선형 — 정규식 없음.
  let depth = 0; let start = -1; let inStr = false; let esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') { if (depth === 0) start = i; depth++; continue; }
    if (c === '}' || c === ']') {
      depth--;
      if (depth === 0 && start >= 0) {
        try { values.push(JSON.parse(t.slice(start, i + 1))); } catch { bad++; }
        start = -1;
      }
      if (depth < 0) { depth = 0; bad++; }
    }
  }
  if (depth !== 0) bad++;
  return { values, bad };
}

/** `{Name,Value}`·`{value:…}`·`{key,value}` 로 감싼 값을 벗긴다(깊이 4). */
export function unwrap(v, depth = 0) {
  if (!isObj(v) || depth > 4) return v;
  if (Object.hasOwn(v, 'Name') && typeof v.Name === 'string') return v.Name;
  const keys = Object.keys(v);
  if (keys.length === 1 && Object.hasOwn(v, 'value')) return unwrap(v.value, depth + 1);
  if (keys.length === 2 && Object.hasOwn(v, 'key') && Object.hasOwn(v, 'value')) return unwrap(v.value, depth + 1);
  if (keys.length === 1 && Object.hasOwn(v, 'Value')) return unwrap(v.Value, depth + 1);
  return v;
}

/** 중첩 객체를 `a.b.c` 평면 필드로(깊이 4 · 필드 200개 상한). 값은 벗긴 스칼라만. */
export function flatten(obj, prefix = '', out = {}, depth = 0) {
  if (!isObj(obj) || depth > 4) return out;
  for (const [k, raw] of Object.entries(obj)) {
    if (Object.keys(out).length >= 200) break;
    const v = unwrap(raw);
    const key = prefix ? `${prefix}.${k}` : k;
    if (isObj(v)) flatten(v, key, out, depth + 1);
    else if (v == null || typeof v !== 'object') out[key] = v;
  }
  return out;
}

/** 평면 필드에서 이름 후보(대소문자 무시, 마지막 조각 기준)로 값 하나. */
export function pick(flat, names) {
  if (!isObj(flat)) return undefined;
  const want = names.map((n) => n.toLowerCase());
  for (const w of want) {
    for (const [k, v] of Object.entries(flat)) {
      const last = k.split('.').pop().toLowerCase();
      if (last === w && v != null && v !== '') return v;
    }
  }
  return undefined;
}

/**
 * Telemetry REST·일반 JSON → 개체 맵 { name → 평면 필드 }. 개체 이름은 notification 경로의 마지막 조각,
 * 와일드카드(`…/all`) 응답이면 updates 의 키가 개체다(값이 객체일 때).
 * @returns {{ entities: Map<string, object>, format: string|null, keys: string[] }}
 */
export function entitiesOf(text) {
  const { values } = splitJsonStream(text);
  const entities = new Map();
  const keys = new Set();
  let format = null;
  const put = (name, fields) => {
    const n = str(name, 128);
    if (!n || entities.size >= 4096) return;
    const prev = entities.get(n) || {};
    entities.set(n, { ...prev, ...fields });
    for (const k of Object.keys(fields)) if (keys.size < 40) keys.add(k.split('.').pop());
  };
  for (const v of values) {
    if (isObj(v) && Array.isArray(v.notifications)) {
      format = 'notifications';
      for (const n of v.notifications) {
        if (!isObj(n) || !isObj(n.updates)) continue;
        const segs = String(typeof n.path === 'string' ? n.path : '').split('/').filter(Boolean);
        const tail = segs.length ? decodeSeg(segs[segs.length - 1]) : '';
        const ups = Object.entries(n.updates);
        const objUps = ups.filter(([, u]) => isObj(unwrap(isObj(u) && Object.hasOwn(u, 'value') ? u.value : u)));
        // 와일드카드 응답: 대부분의 update 값이 객체면 update 키가 개체 이름이다.
        if (tail === 'all' || (ups.length && objUps.length === ups.length && ups.length > 1)) {
          for (const [k, u] of ups) {
            const val = unwrap(isObj(u) && Object.hasOwn(u, 'value') ? u.value : u);
            const name = isObj(u) && typeof u.key === 'string' ? u.key : k;
            if (isObj(val)) put(name, flatten(val));
          }
        } else {
          const fields = {};
          for (const [k, u] of ups) fields[isObj(u) && typeof u.key === 'string' ? u.key : k] = unwrap(isObj(u) && Object.hasOwn(u, 'value') ? u.value : u);
          put(tail || '(root)', flatten(fields));
        }
      }
    } else if (isObj(v) && isObj(v.result) && isObj(v.result.value)) {
      format = format || 'resource';
      const val = v.result.value;
      const name = nameOf(val) || String(entities.size);
      put(name, flatten(val));
    } else if (Array.isArray(v)) {
      format = format || 'array';
      for (const x of v) if (isObj(x)) put(nameOf(x) || String(entities.size), flatten(x));
    } else if (isObj(v) && Object.keys(v).length) {
      // 평범한 맵 { name: {…} } 또는 개체 하나
      const ents = Object.entries(v).filter(([, x]) => isObj(x));
      if (ents.length && ents.length === Object.keys(v).length) {
        format = format || 'map';
        for (const [k, x] of ents) put(nameOf(x) || k, flatten(x));
      } else {
        format = format || 'object';
        put(nameOf(v) || '(root)', flatten(v));
      }
    }
  }
  return { entities, format, keys: [...keys] };
}

function decodeSeg(s) { try { return decodeURIComponent(s); } catch { return s; } }
function nameOf(o) {
  if (!isObj(o)) return '';
  for (const k of ['name', 'intfId', 'interface', 'intf', 'peerAddress', 'peer', 'serialNumber', 'deviceId', 'hostname', 'label']) {
    const v = unwrap(o[k]);
    if (typeof v === 'string' && v) return v;
    if (isObj(v) && typeof v.deviceId === 'string') return v.deviceId;
  }
  if (isObj(o.key)) { const f = flatten(o.key); const first = Object.values(f).find((x) => typeof x === 'string' && x); if (first) return first; }
  return '';
}

/* ── 인벤토리 ──────────────────────────────────────────────────────────── */

/** streamingStatus → true/false/null(모름). */
export function streamingOf(v) {
  if (v === true || v === false) return v;
  const s = String(v ?? '').toLowerCase();
  if (!s) return null;
  if (/inactive|not_streaming|disconnected|stopped/.test(s)) return false;
  if (/active|streaming|connected/.test(s)) return true;
  return null;
}

/**
 * 장비 인벤토리 파서. 레코드마다 { key, hostname, model, serial, mgmtIp, eosVersion, streaming }.
 * 장비 키는 serial → systemMac → hostname(없으면 그 레코드를 버리고 센다).
 * @returns {{ devices: object[]|null, truncated: number, dropped: number, keys: string[] }}  읽은 레코드가 0이고 형식도 모르면 devices=null
 */
export function parseInventory(text, { max = DEVICE_MAX } = {}) {
  const { values, bad } = splitJsonStream(text);
  const recs = [];
  const keys = new Set();
  let recognized = false;
  const visit = (o) => {
    if (!isObj(o)) return;
    if (isObj(o.result) && isObj(o.result.value)) { recognized = true; recs.push(o.result.value); return; }
    if (Array.isArray(o.value)) { o.value.forEach(visit); return; }
    if (Array.isArray(o.data)) { recognized = true; o.data.forEach(visit); return; }
    if (Array.isArray(o.netElementList)) { recognized = true; o.netElementList.forEach(visit); return; }
    if (o.serialNumber != null || o.hostname != null || o.fqdn != null || isObj(o.key) || o.systemMacAddress != null) { recognized = true; recs.push(o); }
  };
  for (const v of values) { if (Array.isArray(v)) v.forEach(visit); else visit(v); }
  if (!recognized) return { devices: values.length || bad ? null : [], truncated: 0, dropped: 0, keys: [], badChunks: bad };
  const out = []; const seen = new Set(); let dropped = 0; let truncated = 0;
  for (const r of recs) {
    const f = flatten(r);
    for (const k of Object.keys(f)) if (keys.size < 40) keys.add(k.split('.').pop());
    const serial = str(pick(f, ['serialNumber', 'serial', 'deviceId']));
    const mac = str(pick(f, ['systemMacAddress', 'systemMac']));
    const hostname = str(pick(f, ['hostname', 'fqdn', 'name']));
    const key = serial || mac || hostname;
    if (!key || seen.has(key)) { dropped++; continue; }
    if (out.length >= max) { truncated++; continue; }
    seen.add(key);
    out.push({
      key,
      hostname: hostname || '',
      model: str(pick(f, ['modelName', 'model', 'hardwareModel'])) || '',
      serial: serial || '',
      mgmtIp: str(pick(f, ['ipAddress', 'managementIp', 'mgmtIp', 'ip'])) || '',
      eosVersion: str(pick(f, ['softwareVersion', 'version', 'eosVersion'])) || '',
      streaming: streamingOf(pick(f, ['streamingStatus', 'streaming', 'streamingState'])),
    });
  }
  return { devices: out, truncated, dropped, keys: [...keys], badChunks: bad };
}

/* ── 부품 ──────────────────────────────────────────────────────────────── */

export const PART_STATES = Object.freeze(['ok', 'warn', 'fault', 'unknown', 'absent']);

/**
 * 부품 상태 판정(순수). 순서가 계약이다: ① 빈 슬롯(absent) ② 경보 플래그 ③ 경고 단어 ④ healthWord.
 * 상태 필드가 하나도 없으면 unknown(정상이라 말하지 않는다).
 */
export function partState(flat) {
  if (!isObj(flat)) return 'unknown';
  const stateRaw = unwrap(pick(flat, ['state', 'status', 'health', 'operStatus', 'powerSupplyState', 'fanState', 'hwStatus']));
  const presenceRaw = unwrap(pick(flat, ['xcvrPresence', 'presence']));
  const statusRaw = stateRaw ?? presenceRaw;
  const s = String(statusRaw ?? '').toLowerCase();
  if (/not\s*_?inserted|notinserted|absent|not\s*_?present|notpresent|\bempty\b|xcvrnotpresent|removed/.test(s)) return 'absent';
  const alert = pick(flat, ['alertRaised', 'alarm', 'overheat', 'critical']);
  if (alert === true || String(alert).toLowerCase() === 'true') return 'fault';
  const alertFalse = alert === false || String(alert).toLowerCase() === 'false';
  if (statusRaw == null || s === '') {
    // 상태 필드 없이 경보 플래그만 있고 그것이 false 면 정상
    if (alertFalse) return 'ok';
    return 'unknown';
  }
  /*
   * v2.611(COL2611-04): 장착 여부(xcvrPresent·present·inserted)는 '빈 슬롯이 아니다' 만 말한다 — 건강 상태가 아니다.
   *   예전에는 이 값이 healthWord 에서 모르는 단어 → fault 로 떨어져 **꽂혀 있는 트랜시버가 전부 장애**가 됐다(재현).
   *   다른 상태 필드가 없으면 unknown(경보 플래그가 false 로 명시돼 있을 때만 ok) — 정상으로 칠하지 않는다.
   */
  if (stateRaw == null) return alertFalse ? 'ok' : 'unknown';
  if (/warn|minor|degrad|attention/.test(s)) return 'warn';
  const w = healthWord(s.replace(/^(powersupply|fan|xcvr|intfoper)/, ''));
  return w === 'ok' ? 'ok' : w === 'bad' ? 'fault' : 'unknown';
}

/**
 * 부품 목록 파서. kind 는 'psu'|'fan'|'temp'|'xcvr'. 못 읽으면 null.
 * @returns {{ parts: Array<{kind,name,state,detail}>|null, keys: string[], truncated: number }}
 */
export function parseParts(text, kind, { max = PART_MAX } = {}) {
  const { entities, format, keys } = entitiesOf(text);
  if (!format) return { parts: null, keys, truncated: 0 };
  const parts = []; let truncated = 0; let unrecognized = 0;
  for (const [name, f] of entities) {
    if (pick(f, ['state', 'status', 'health', 'operStatus', 'powerSupplyState', 'fanState', 'hwStatus', 'xcvrPresence', 'presence', 'alertRaised', 'alarm', 'overheat', 'critical', 'temperature', 'currentTemperature']) === undefined) { unrecognized++; continue; }
    if (parts.length >= max) { truncated++; continue; }
    const st = partState(f);
    const detailBits = [];
    const raw = pick(f, ['state', 'status', 'health', 'operStatus']);
    if (raw != null) detailBits.push(String(raw));
    const t = numOrNull(pick(f, ['temperature', 'currentTemperature', 'value']));
    if (kind === 'temp' && t != null) detailBits.push(`${t}℃`);
    parts.push({ kind, name: str(name, 128), state: st, detail: str(detailBits.join(' · '), 200) });
  }
  if (!parts.length && unrecognized) return { parts: null, keys, truncated: 0 };
  return { parts, keys, truncated };
}

/** 부품 목록 → 상태별 개수(null 이면 null). */
export function partsSummary(parts) {
  if (!Array.isArray(parts)) return null;
  const s = { ok: 0, warn: 0, fault: 0, unknown: 0, absent: 0 };
  for (const p of parts) if (p && Object.hasOwn(s, p.state)) s[p.state]++;
  return s;
}

/* ── 인터페이스·카운터 ─────────────────────────────────────────────────── */

// v2.611(COL2611-07): EOS 열거형은 소수를 'p' 로 쓴다(speed2p5Gbps = 2.5G) — 예전 식은 이것을 null 로 버렸다.
const SPEED_ENUM = /speed(\d+)(?:p(\d+))?(g|m|k)?bps/i;
/**
 * 속도 → bps(모르면 null). 숫자(bps) · 'speed100Gbps' · 'speed2p5Gbps'(2.5G) · '100G' · '10000'.
 * 단위 없는 수는 **bps 로 본다**(Mbps 로 추정해 곱하지 않는다 — 예전 주석은 반대로 적혀 있었다). 그 결과 사용률이 100% 를 넘으면
 * portDelta 가 null 로 버린다(지어낸 속도로 사용률을 만들지 않는다).
 */
export function speedBps(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  const s = String(v);
  const e = SPEED_ENUM.exec(s);
  const m = e ? [e[0], e[2] != null ? `${e[1]}.${e[2]}` : e[1], e[3]] : /^(\d+(?:\.\d+)?)\s*(g|m|k)\b/i.exec(s.trim());
  if (m) {
    const n = Number(m[1]); const u = String(m[2] || '').toLowerCase();
    const mult = u === 'g' ? 1e9 : u === 'm' ? 1e6 : u === 'k' ? 1e3 : 1;
    const r = n * mult;
    return Number.isFinite(r) && r > 0 ? r : null;
  }
  const n = numOrNull(s);
  return n != null && n > 0 ? n : null;
}

/** oper/admin 상태 → 'up'|'down'|'unknown'. */
export function linkWord(v) {
  if (v === true) return 'up';
  if (v === false) return 'down';
  const s = String(v ?? '').toLowerCase();
  if (!s) return 'unknown';
  if (/notconnect|down|disabled|errdisabled|shutdown|notpresent|linkdown|intfoperdown|lowerlayerdown/.test(s)) return 'down';
  if (/\bup\b|linkup|intfoperup|connected|enabled|^up$/.test(s)) return 'up';
  return 'unknown';
}

/**
 * 인터페이스 상태 파서 → [{name, desc, speedBps, oper, admin, vlan, lag}] 또는 null.
 */
export function parseInterfaces(text, { max = PORT_MAX } = {}) {
  const { entities, format, keys } = entitiesOf(text);
  if (!format) return { ports: null, keys, truncated: 0 };
  const ports = []; let truncated = 0; let unrecognized = 0;
  for (const [name, f] of entities) {
    // 인터페이스 필드가 하나도 없는 개체(오류 본문 등)는 포트로 세지 않는다 — 없는 포트를 지어내지 않게.
    if (pick(f, ['operStatus', 'linkStatus', 'oper', 'operState', 'adminStatus', 'enabledState', 'adminEnabled', 'speed', 'bandwidth', 'description']) === undefined) { unrecognized++; continue; }
    if (ports.length >= max) { truncated++; continue; }
    const lagRaw = pick(f, ['lag', 'portChannel', 'lagId', 'membership']);
    const vlanRaw = pick(f, ['vlan', 'accessVlan', 'nativeVlan', 'vlanId']);
    ports.push({
      name: str(name, 64),
      desc: str(pick(f, ['description', 'desc']) ?? '', 200),
      speedBps: speedBps(pick(f, ['speed', 'bandwidth', 'speedEnum'])),
      oper: linkWord(pick(f, ['operStatus', 'linkStatus', 'oper', 'operState'])),
      admin: linkWord(pick(f, ['adminStatus', 'enabledState', 'adminEnabled', 'admin', 'enabled'])),
      vlan: vlanRaw == null ? '' : str(vlanRaw, 32),
      lag: lagRaw == null ? '' : str(lagRaw, 64),
    });
  }
  if (!ports.length && unrecognized) return { ports: null, keys, truncated: 0 };
  return { ports, keys, truncated };
}

/**
 * 누적 카운터 파서 → Map(name → {inOctets,outOctets,inErrors,outErrors}) 또는 null.
 * 값이 없는 필드는 null 이다(0 을 지어내지 않는다).
 */
export function parseCounters(text) {
  const { entities, format, keys } = entitiesOf(text);
  if (!format) return { counters: null, keys };
  const counters = new Map();
  for (const [name, f] of entities) {
    const c = {
      inOctets: numOrNull(pick(f, ['inOctets', 'inBytes', 'ifInOctets', 'ifHCInOctets'])),
      outOctets: numOrNull(pick(f, ['outOctets', 'outBytes', 'ifOutOctets', 'ifHCOutOctets'])),
      inErrors: numOrNull(pick(f, ['inErrors', 'inErrorsTotal', 'ifInErrors', 'inTotalErrors'])),
      outErrors: numOrNull(pick(f, ['outErrors', 'outErrorsTotal', 'ifOutErrors', 'outTotalErrors'])),
    };
    if (Object.values(c).every((x) => x == null)) continue; // 카운터 필드가 없는 개체는 세지 않는다
    counters.set(str(name, 64), c);
  }
  if (!counters.size && entities.size) return { counters: null, keys };
  return { counters, keys };
}

/**
 * 두 표본 사이 델타(순수 — 테스트 고정).
 *  · 첫 표본(prev 없음) → null  · 음수 델타(카운터 리셋) → null  · 간격이 0 이하거나 주기의 3배 초과 → null
 *  · 사용률은 **방향별** — in_bps / speed, out_bps / speed(rx+tx 합을 한 방향 속도로 나누지 않는다 — v2.590 F9).
 *    속도를 모르면 null. 100% 를 넘으면(카운터·속도 불일치) null(클램프하지 않는다 — v2.578).
 * @param {{at:number, c:{inOctets,outOctets,inErrors,outErrors}}|null} prev
 * @param {{at:number, c:object}} cur
 * @param {number|null} speed  bps
 * @param {number} intervalMs  설정 주기(간격 비정상 판정 기준)
 * @param {number} [slackMs]    간격 한계에 더할 직전 실행 소요(v2.611 COL2611-08 — 표본 간격 = 주기 + 실행 시간)
 */
export function portDelta(prev, cur, speed, intervalMs, slackMs = 0) {
  const out = { inBps: null, outBps: null, inUtil: null, outUtil: null, inErr: null, outErr: null, reason: null };
  if (!prev || !prev.c) { out.reason = 'first'; return out; }
  const gapMs = Number(cur?.at) - Number(prev.at);
  const slack = Number(slackMs);
  const lim = Math.max(1, Number(intervalMs) || 0) * 3 + (Number.isFinite(slack) && slack > 0 ? slack : 0);
  if (!Number.isFinite(gapMs) || gapMs <= 0 || gapMs > lim) { out.reason = 'gap'; return out; }
  const sec = gapMs / 1000;
  const d = (a, b) => (a == null || b == null ? null : (b - a < 0 ? null : b - a));
  const inO = d(prev.c.inOctets, cur.c.inOctets);
  const outO = d(prev.c.outOctets, cur.c.outOctets);
  if ((prev.c.inOctets != null && cur.c.inOctets != null && inO == null) || (prev.c.outOctets != null && cur.c.outOctets != null && outO == null)) out.reason = 'reset';
  out.inBps = inO == null ? null : Math.round((inO * 8) / sec);
  out.outBps = outO == null ? null : Math.round((outO * 8) / sec);
  out.inErr = d(prev.c.inErrors, cur.c.inErrors);
  out.outErr = d(prev.c.outErrors, cur.c.outErrors);
  const sp = Number(speed);
  const util = (bps) => {
    if (bps == null || !Number.isFinite(sp) || sp <= 0) return null;
    const p = (bps / sp) * 100;
    return p > 100 ? null : Math.round(p * 100) / 100;
  };
  out.inUtil = util(out.inBps);
  out.outUtil = util(out.outBps);
  return out;
}

/* ── BGP ───────────────────────────────────────────────────────────────── */

/**
 * BGP 피어 파서 → { peers:[{peer,asn,vrf,state,prefixes}]|null, summary:{peers,established,down,prefixes}|null }.
 * prefixes 합계는 **읽은 피어가 하나라도 있을 때만**(전부 모르면 null). 전체 RIB 는 수집하지 않는다(docs/CVP.md).
 */
export function parseBgp(text, { max = PEER_MAX } = {}) {
  const { entities, format, keys } = entitiesOf(text);
  if (!format) return { peers: null, summary: null, keys, truncated: 0 };
  const peers = []; let truncated = 0; let unrecognized = 0;
  for (const [name, f] of entities) {
    const stateRaw = pick(f, ['bgpPeerState', 'peerState', 'state', 'bgpState']);
    if (stateRaw === undefined && pick(f, ['bgpPeerAs', 'peerAs', 'remoteAs', 'peerAddress', 'bgpPeerAddr']) === undefined) { unrecognized++; continue; }
    if (peers.length >= max) { truncated++; continue; }
    const state = str(stateRaw ?? '', 32);
    peers.push({
      peer: str(pick(f, ['peerAddress', 'bgpPeerAddr', 'peer']) ?? name, 64),
      asn: str(pick(f, ['bgpPeerAs', 'peerAs', 'asn', 'remoteAs']) ?? '', 16),
      vrf: str(pick(f, ['vrf', 'vrfName']) ?? '', 64),
      state,
      prefixes: numOrNull(pick(f, ['bgpPeerPrefixesReceived', 'prefixesReceived', 'prefixReceived', 'prefixAccepted', 'bgpPeerPrefixAccepted'])),
    });
  }
  if (!peers.length && unrecognized) return { peers: null, summary: null, keys, truncated: 0 };
  return { peers, summary: bgpSummary(peers), keys, truncated };
}

export function bgpSummary(peers) {
  if (!Array.isArray(peers)) return null;
  let established = 0; let down = 0; let pSum = 0; let pKnown = 0;
  for (const p of peers) {
    const s = String(p?.state || '').toLowerCase();
    if (/established/.test(s)) established++;
    else if (s) down++;
    if (p?.prefixes != null) { pSum += p.prefixes; pKnown++; }
  }
  return { peers: peers.length, established, down, prefixes: pKnown ? pSum : null };
}

/**
 * 포트 목록 → {total, up, down}(null 이면 null). **down 은 '관리상 켜져 있는데 링크가 내려간' 포트만**이다 —
 * 쓰지 않는(admin down·미연결) 포트까지 세면 정상 장비가 수십 개의 'down' 을 가진 것처럼 보인다. admin 을 모르면 세지 않는다.
 */
export function portsSummary(ports) {
  if (!Array.isArray(ports)) return null;
  let up = 0; let down = 0;
  for (const p of ports) { if (p?.oper === 'up') up++; else if (p?.oper === 'down' && p?.admin === 'up') down++; }
  return { total: ports.length, up, down };
}
