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
/** v2.612 SEC2612-01: 개체 하나에 합칠 필드 수 상한(넘친 개수는 entitiesOf().droppedFields). */
export const ENTITY_FIELD_MAX = 400;
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
  // v2.642: 실장비 CVP 2023.1.1 텔레메트리 REST 는 값을 형식 표지로 감싼다 — `{"int":4056276992}`·`{"float":…}`·`{"bool":…}`.
  //   벗기지 않으면 meminfo 의 모든 값이 '.int' 필드가 되어 memTotal 을 못 찾았다(사용자 캡처로 확인).
  if (keys.length === 1 && TYPED_KEYS.has(keys[0]) && !isObj(v[keys[0]])) return v[keys[0]];
  return v;
}
const TYPED_KEYS = new Set(['int', 'uint', 'float', 'double', 'bool', 'str', 'string']);

/**
 * v2.642: 텔레메트리 포인터 → 경로 조각 배열(없으면 null). 실장비 CVP 2023.1.1 은 `{"ptr":["Sysdb","interface",…,"Ethernet1"]}`
 *   (**배열**)을 준다(사용자 캡처로 확인). v2.641 은 `{"_ptr":"/…"}`(문자열)만 알아서 포인터를 한 번도 따라가지 못했다 — 그래서
 *   포트·BGP·CPU 가 전부 '형식을 읽지 못했습니다' 였다. 문자열 형태도 계속 받는다.
 */
export function ptrSegs(val) {
  if (!isObj(val)) return null;
  if (Array.isArray(val.ptr) && val.ptr.length && val.ptr.every((x) => typeof x === 'string' || typeof x === 'number')) return val.ptr.map((x) => String(x));
  const sp = typeof val._ptr === 'string' ? val._ptr : typeof val.ptr === 'string' ? val.ptr : null;
  if (sp) { const segs = sp.split('/').filter(Boolean); return segs.length ? segs : null; }
  return null;
}

/** v2.642: update 의 키 → 문자열. 키가 객체(`{"key":{"int":1}}`)면 첫 스칼라를 쓴다(예전에는 update 맵 키로 떨어졌다). */
export function updKey(u, k) {
  if (!isObj(u)) return k;
  if (typeof u.key === 'string' || typeof u.key === 'number') return String(u.key);
  if (isObj(u.key)) {
    const f = flatten(u.key);
    const first = Object.values(f).find((x) => (typeof x === 'string' && x) || typeof x === 'number');
    if (first != null) return String(first);
  }
  return k;
}

/** 같은 경로의 notification 을 시각 순으로(나중 값이 앞 값을 덮게). 시각은 ns 문자열이라 길이·사전순으로 비교한다. */
function byTimestamp(list) {
  const t = (n) => { const x = isObj(n) ? n.timestamp : null; return typeof x === 'string' ? x : typeof x === 'number' ? String(x) : ''; };
  return [...list].sort((a, b) => { const x = t(a), y = t(b); return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0); });
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
  let droppedFields = 0;
  /*
   * v2.612 SEC2612-01: 같은 개체 이름으로 온 update 를 **제자리에서** 합친다. 예전 `{ ...prev, ...fields }` 는 put 마다
   *   누적 필드 전체를 복사해 O(n²) 였다(같은 개체 8천 update = 11.7초). 개체당 필드는 ENTITY_FIELD_MAX 로 자르고
   *   버린 개수를 droppedFields 로 밝힌다. `__proto__` 같은 키는 defineProperty 로 자기 속성에만 넣는다(프로토타입을 바꾸지 않게).
   */
  const put = (name, fields) => {
    const n = str(name, 128);
    if (!n) return;
    let cur = entities.get(n);
    if (!cur) {
      if (entities.size >= 4096) return;
      cur = {}; entities.set(n, cur);
    }
    let size = Object.keys(cur).length;
    for (const k of Object.keys(fields)) {
      const has = Object.hasOwn(cur, k);
      if (!has && size >= ENTITY_FIELD_MAX) { droppedFields++; continue; }
      Object.defineProperty(cur, k, { value: fields[k], enumerable: true, writable: true, configurable: true });
      if (!has) size++;
      if (keys.size < 40) keys.add(k.split('.').pop());
    }
  };
  for (const v of values) {
    if (isObj(v) && Array.isArray(v.notifications)) {
      format = 'notifications';
      for (const n of byTimestamp(v.notifications)) {
        if (!isObj(n) || !isObj(n.updates)) continue;
        // v2.641: 경로는 `path`(문자열) 또는 `path_elements`(배열) — Arista 텔레메트리 판본마다 다르다(둘 다 받는다).
        const segs = typeof n.path === 'string' ? n.path.split('/').filter(Boolean)
          : Array.isArray(n.path_elements) ? n.path_elements.filter((x) => typeof x === 'string' && x) : [];
        const tail = segs.length ? decodeSeg(segs[segs.length - 1]) : '';
        const ups = Object.entries(n.updates);
        // v2.641: 포인터(`{_ptr}`)는 필드가 아니다 — 개체 값으로 세면 포인터 목록이 '읽은 개체' 가 된다(없는 포트를 지어낸다).
        const isPtr = (u) => { const x = isObj(u) && Object.hasOwn(u, 'value') ? u.value : u; return ptrSegs(x) != null; };
        const objUps = ups.filter(([, u]) => !isPtr(u) && isObj(unwrap(isObj(u) && Object.hasOwn(u, 'value') ? u.value : u)));
        // 와일드카드 응답: 대부분의 update 값이 객체면 update 키가 개체 이름이다.
        if (tail === 'all' || (ups.length && objUps.length === ups.length && ups.length > 1)) {
          for (const [k, u] of ups) {
            if (isPtr(u)) continue;
            const val = unwrap(isObj(u) && Object.hasOwn(u, 'value') ? u.value : u);
            const name = updKey(u, k);
            if (isObj(val)) put(name, flatten(val));
          }
        } else {
          const fields = {};
          for (const [k, u] of ups) if (!isPtr(u)) fields[updKey(u, k)] = unwrap(isObj(u) && Object.hasOwn(u, 'value') ? u.value : u);
          if (Object.keys(fields).length) put(tail || '(root)', flatten(fields));
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
  return { entities, format, keys: [...keys], droppedFields };
}

/**
 * v2.641 — 텔레메트리 REST 응답의 '모양' 을 본다(순수). 실장비 CVP 2023.1.1 에서 확인한 사실(사용자 캡처):
 *   ① 경로는 열려 있지만 그 노드에 값이 없으면 HTTP 200 + `{"notifications":[]}`(21 바이트)가 온다. v2.640 까지 파서는 이것을
 *      '읽었고 0개' 로 세 화면이 초록 `0/0`·'피어 없음' 이라 말했다 — **빈 응답은 읽은 것이 아니다**(경로에 데이터 없음).
 *   ② 컬렉션 노드는 하위 개체를 포인터로 준다 — 실장비는 `{"ptr":["Sysdb",…,"Ethernet1"]}` 배열(v2.642 확인), 문자열 `_ptr` 도 받는다.
 *      BGP '응답은 왔지만 형식을 읽지 못했습니다' 9대가 이 경우였을 가능성이 높다(포인터 하나를 필드로 읽어 인식 필드 0).
 * @returns {{ format:'notifications'|null, empty:boolean, updates:number, ptrs:Array<{key:string, ptr:string}>, pathOf:string }}
 */
export const PTR_MAX = 256;
export function telemetryShape(text) {
  const { values } = splitJsonStream(text);
  let format = null; let updates = 0; const ptrs = []; let pathOf = '';
  for (const v of values) {
    if (!isObj(v) || !Array.isArray(v.notifications)) continue;
    format = 'notifications';
    for (const n of v.notifications) {
      if (!isObj(n)) continue;
      if (!pathOf) pathOf = typeof n.path === 'string' ? n.path : Array.isArray(n.path_elements) ? '/' + n.path_elements.map((x) => (typeof x === 'string' ? x : '')).join('/') : '';
      if (!isObj(n.updates)) continue;
      for (const [k, u] of Object.entries(n.updates)) {
        updates++;
        const val = isObj(u) && Object.hasOwn(u, 'value') ? u.value : u;
        const segs = ptrSegs(val);
        if (segs && ptrs.length < PTR_MAX) {
          const key = updKey(u, k);
          // ptr 는 '/' 로 이은 문자열(표시·비교용), segs 는 조각 배열(URL 조립용 — 'Ethernet3/1' 같은 조각을 지킨다).
          // 문자열 포인터(`_ptr`)는 조각 경계를 알 수 없으므로 segs 를 싣지 않는다(childPath 가 부모+키 규칙으로 이름을 지킨다).
          const arr = Array.isArray(val.ptr);
          ptrs.push(arr ? { key: str(key, 128), ptr: str('/' + segs.join('/'), 512), segs: segs.slice(0, 32).map((x) => str(x, 128)) }
            : { key: str(key, 128), ptr: str('/' + segs.join('/'), 512) });
        }
      }
    }
  }
  return { format, empty: format === 'notifications' && updates === 0, updates, ptrs, pathOf: str(pathOf, 512) };
}

/**
 * v2.641: 텔레메트리 응답에서 개체를 하나도 못 만들었으면(빈 응답·포인터만) '읽음 0개' 가 아니라 **못 읽음** 이다.
 *   평범한 JSON 빈 배열(`[]`)은 형식이 분명하므로 0개로 둔다 — 이 규칙은 notifications 형식에만 적용한다.
 */
const notRead = (format, entities) => !format || (format === 'notifications' && entities.size === 0);

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
      // v2.641: 장비 개요용(실장비 Resource API 에서 확인한 이름 — systemMacAddress·fqdn·hardwareRevision·bootTime).
      mac: str(mac || '', 32), fqdn: str(pick(f, ['fqdn']) ?? '', 256), hwRevision: str(pick(f, ['hardwareRevision']) ?? '', 64),
      bootAt: tsOf(pick(f, ['bootTime', 'bootupTimestamp', 'bootupTimeStamp'])),
    });
  }
  return { devices: out, truncated, dropped, keys: [...keys], badChunks: bad };
}

/* ── 부품 ──────────────────────────────────────────────────────────────── */

export const PART_STATES = Object.freeze(['ok', 'warn', 'fault', 'unknown', 'absent']);
// v2.612 COL2612-03: 부품 '이상' 으로 읽을 명시 단어(단어 경계 없이 — EOS 열거형은 붙여 쓴다: powerLoss·hwStatusFailed).
const CVP_BAD = /fail|fault|error|critical|broken|loss|lost|shutdown|overheat|notok|not[\s_-]*ok|unhealthy|down|offline|alarm|bad/;

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
  /*
   * v2.612 COL2612-03: EOS 열거형 접두(hwStatusOk·powerSupplyOk…)를 떼고 판정한다 — 예전에는 'hwstatus' 를 떼지 않아
   *   hwStatusOk 가 모르는 단어 → fault 였다. healthWord 는 모르는 단어를 bad 로 보지만(스토리지 규약), CVP 는 형식을 본 적이
   *   없으므로 **명시적 이상 단어만** fault 이고 그 밖의 모르는 단어는 unknown 이다(없는 장애를 만들지 않는다).
   */
  const core = s.replace(/^(hwstatus|powersupply|fanstatus|fan|xcvr|intfoper)[\s_:-]*/, '');
  if (!core) return 'unknown';
  const w = healthWord(core);
  if (w === 'ok') return 'ok';
  if (w === 'unknown') return 'unknown';
  return CVP_BAD.test(core) ? 'fault' : 'unknown';
}

/**
 * 부품 목록 파서. kind 는 'psu'|'fan'|'temp'|'xcvr'. 못 읽으면 null.
 * @returns {{ parts: Array<{kind,name,state,detail}>|null, keys: string[], truncated: number }}
 */
export function parseParts(text, kind, { max = PART_MAX } = {}) {
  const { entities, format, keys, droppedFields } = entitiesOf(text);
  if (notRead(format, entities)) return { parts: null, keys, truncated: 0 };
  const parts = []; let truncated = 0; let unrecognized = 0;
  for (const [name, f] of entities) {
    if (pick(f, ['state', 'status', 'health', 'operStatus', 'powerSupplyState', 'fanState', 'hwStatus', 'xcvrPresence', 'presence', 'alertRaised', 'alarm', 'overheat', 'critical', 'temperature', 'currentTemperature']) === undefined) { unrecognized++; continue; }
    if (parts.length >= max) { truncated++; continue; }
    const st = partState(f);
    const detailBits = [];
    const raw = pick(f, ['state', 'status', 'health', 'operStatus']);
    if (raw != null) detailBits.push(String(raw));
    const t = numOrNull(pick(f, ['temperature', 'currentTemperature', 'value']));
    if (kind === 'temp' && t != null) detailBits.push(`${Math.round(t * 10) / 10}℃`); // v2.643: 25.329440000034℃ 같은 부동소수 꼬리를 자른다
    parts.push({ kind, name: str(name, 128), state: st, detail: str(detailBits.join(' · '), 200) });
  }
  if (!parts.length && unrecognized) return { parts: null, keys, truncated: 0 };
  return { parts, keys, truncated, droppedFields };
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
  // v2.612 COL2612-05: '100Gbps'·'1000Mbps'·'10 Gbps' 도 받는다(예전 식은 \b 때문에 'g' 뒤에 'bps' 가 붙으면 놓쳤다).
  const m = e ? [e[0], e[2] != null ? `${e[1]}.${e[2]}` : e[1], e[3]] : /^(\d+(?:\.\d+)?)\s*(g|m|k)(?:b(?:ps|it\/s)?|bits?\/s)?$/i.exec(s.trim());
  if (m) {
    const n = Number(m[1]); const u = String(m[2] || '').toLowerCase();
    const mult = u === 'g' ? 1e9 : u === 'm' ? 1e6 : u === 'k' ? 1e3 : 1;
    const r = n * mult;
    return Number.isFinite(r) && r > 0 ? r : null;
  }
  const n = numOrNull(s);
  return n != null && n > 0 ? n : null;
}

/**
 * v2.612 COL2612-05: 속도 후보를 차례로 본다 — 첫 후보가 'speedUnknown' 처럼 읽히지 않으면 다음 후보(bandwidth)로 넘어간다.
 *   예전 pick 은 비어 있지 않은 첫 값을 골라 그것이 읽히지 않아도 null 로 끝났다.
 */
export function firstSpeed(flat) {
  for (const k of ['speed', 'bandwidth', 'speedEnum']) {
    const r = speedBps(unwrap(pick(flat, [k])));
    if (r != null) return r;
  }
  return null;
}

/**
 * oper/admin 상태 → 'up'|'down'|'nolink'|'unknown'.
 * v2.630(감사 A2-02): EOS 인터페이스 기본값은 no shutdown(enabled)이라 케이블 없는 포트는 'notconnect', 트랜시버 없는
 *   포트는 'notPresent' 로 보고된다. 그것을 'down' 으로 번역하면 'admin up 인데 oper down' 판정(portsSummary)이 **쓰지 않는
 *   포트 전부**를 다운 포트로 세 정상 장비가 수십 개의 down 을 가진 것처럼 보였다. 링크가 한 번도 없었을 수 있는 상태
 *   (notconnect·notPresent·disconnected)는 'nolink' 로 따로 두고, down 은 linkDown·errdisabled·lowerLayerDown 처럼
 *   '링크가 있어야 하는데 내려간' 상태로 좁힌다. ⚠ 실장비 CVP 응답을 본 적이 없다 — 단어 목록은 EOS CLI 관용 표기 기준이다.
 */
export function linkWord(v) {
  if (v === true) return 'up';
  if (v === false) return 'down';
  const s = String(v ?? '').toLowerCase();
  if (!s) return 'unknown';
  if (/notconnect|notpresent/.test(s)) return 'nolink'; // v2.630 A2-02: EOS 의 미연결·트랜시버 없음만 — 'disconnected' 는 v2.612 판정대로 down
  // v2.612 COL2612-02: 'disconnected' 가 'connected' 를 품어 up 으로 읽혔다 — 끊김 단어를 down 에 넣고 up 은 단어 경계로 본다.
  if (/disconnect|down|disabled|errdisabled|shutdown|linkdown|intfoperdown|lowerlayerdown/.test(s)) return 'down';
  if (/\bup\b|linkup|intfoperup|\bconnected\b|\benabled\b/.test(s)) return 'up';
  return 'unknown';
}

/**
 * 인터페이스 상태 파서 → [{name, desc, speedBps, oper, admin, vlan, lag}] 또는 null.
 */
export function parseInterfaces(text, { max = PORT_MAX } = {}) {
  const { entities, format, keys, droppedFields } = entitiesOf(text);
  if (notRead(format, entities)) return { ports: null, keys, truncated: 0 };
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
      speedBps: firstSpeed(f),
      oper: linkWord(pick(f, ['operStatus', 'linkStatus', 'oper', 'operState'])),
      admin: linkWord(pick(f, ['adminStatus', 'enabledState', 'adminEnabled', 'admin', 'enabled'])),
      vlan: vlanRaw == null ? '' : str(vlanRaw, 32),
      lag: lagRaw == null ? '' : str(lagRaw, 64),
    });
  }
  if (!ports.length && unrecognized) return { ports: null, keys, truncated: 0 };
  return { ports, keys, truncated, droppedFields };
}

/**
 * 누적 카운터 파서 → Map(name → {inOctets,outOctets,inErrors,outErrors}) 또는 null.
 * 값이 없는 필드는 null 이다(0 을 지어내지 않는다).
 */
export function parseCounters(text) {
  const { entities, format, keys, droppedFields } = entitiesOf(text);
  if (notRead(format, entities)) return { counters: null, keys };
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
  return { counters, keys, droppedFields };
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
  const { entities, format, keys, droppedFields } = entitiesOf(text);
  if (notRead(format, entities)) return { peers: null, summary: null, keys, truncated: 0 };
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
  return { peers, summary: bgpSummary(peers), keys, truncated, droppedFields };
}

/**
 * BGP 피어 상태 → 'established'|'down'|'unknown'(v2.630 감사 A2-03).
 * 예전에는 'established' 가 아닌 비어 있지 않은 값을 전부 down 으로 셌다 — BGP4-MIB 이름(bgpPeerState)으로 오는 값은
 * **정수**(6=established)라 정상 피어가 전부 down 이 되고, 'unknown'·'n/a' 도 down 이었다(확인 불가를 장애로).
 * down 은 FSM 의 비-established 상태(idle·connect·active·opensent·openconfirm, 숫자 1~5)만이고 나머지는 unknown 이다
 * (linkWord 와 같은 원칙). ⚠ 실장비 CVP 응답 형식은 확인하지 못했다 — 관용 표기와 MIB 숫자를 둘 다 받는다.
 */
export function bgpStateWord(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n === 6) return 'established';
    if (n >= 1 && n <= 5) return 'down';
    return 'unknown';
  }
  if (/established/.test(s)) return 'established';
  if (/^(bgp[_-]?)?(state[_-]?)?(idle|connect|active|open[_\s-]?sent|open[_\s-]?confirm)\b/.test(s)) return 'down';
  return 'unknown';
}

export function bgpSummary(peers) {
  if (!Array.isArray(peers)) return null;
  let established = 0; let down = 0; let unknown = 0; let pSum = 0; let pKnown = 0;
  for (const p of peers) {
    const w = bgpStateWord(p?.state);
    if (w === 'established') established++;
    else if (w === 'down') down++;
    else unknown++;
    if (p?.prefixes != null) { pSum += p.prefixes; pKnown++; }
  }
  // v2.612 COL2612-04: prefix 수를 모르는 피어 수를 함께 준다 — 있으면 prefixes 는 '최소' 값이다(부분 합을 전체라 말하지 않는다).
  // v2.630 A2-03: 상태를 알 수 없는 피어는 established 에도 down 에도 넣지 않고 따로 센다(stateUnknown).
  return { peers: peers.length, established, down, ...(unknown ? { stateUnknown: unknown } : {}), prefixes: pKnown ? pSum : null, prefixesUnknown: peers.length - pKnown };
}

/**
 * 포트 목록 → {total, up, down}(null 이면 null). **down 은 '관리상 켜져 있는데 링크가 내려간' 포트만**이다 —
 * 쓰지 않는(admin down·미연결) 포트까지 세면 정상 장비가 수십 개의 'down' 을 가진 것처럼 보인다. admin 을 모르면 세지 않는다.
 */
export function portsSummary(ports) {
  if (!Array.isArray(ports)) return null;
  let up = 0; let down = 0; let noLink = 0;
  for (const p of ports) {
    if (p?.oper === 'up') up++;
    else if (p?.oper === 'down' && p?.admin === 'up') down++;
    else if (p?.oper === 'nolink') noLink++;   // v2.630 A2-02: 미연결·트랜시버 없음 — down 이 아니다(개수는 밝힌다)
  }
  return { total: ports.length, up, down, ...(noLink ? { noLink } : {}) };   // 없으면 필드 자체를 싣지 않는다(기존 모양 호환)
}

/* ── v2.641: CPU·메모리 ─────────────────────────────────────────────────── */

/**
 * CPU 사용률 파서(순수). ⚠ 경로·필드는 추정이다(TerminAttr 가 올리는 Linux /proc 관용 이름 — user·system·idle·iowait…).
 *   값이 **퍼센트**(합 90~110)면 바로 `pct = 100 − (idle + iowait)` 이고(iowait 를 busy 로 세면 디스크 대기 중인 장비가 100% 로
 *   보인다 — v2.550 규약), **누적 카운터**(합이 더 크다)면 `counters:{busy,total}` 만 주고 두 표본의 차이는 호출자(폴러)가 계산한다.
 *   필드가 없으면 null(0% 를 지어내지 않는다).
 * @returns {{ pct:number|null, counters:{busy:number,total:number}|null, keys:string[] }}
 */
export function parseCpu(text) {
  const { entities, format, keys } = entitiesOf(text);
  if (notRead(format, entities)) return { pct: null, counters: null, keys };
  // 첫 개체(보통 'total') 또는 이름에 total 이 들어간 개체.
  let f = null;
  for (const [name, x] of entities) { if (/total|^cpu$|\(root\)|leaf/.test(String(name).toLowerCase()) || !f) f = x; if (/total/i.test(name)) break; }
  if (!f) return { pct: null, counters: null, keys };
  const NAMES = ['user', 'nice', 'system', 'idle', 'iowait', 'irq', 'softirq', 'steal'];
  const v = {};
  for (const n of NAMES) { const x = numOrNull(pick(f, [n])); if (x != null && x >= 0) v[n] = x; }
  const util = numOrNull(pick(f, ['utilization', 'cpuUtilization', 'busy', 'usage']));
  if (v.idle == null) {
    if (util != null && util >= 0 && util <= 100) return { pct: Math.round(util * 10) / 10, counters: null, keys };
    return { pct: null, counters: null, keys };
  }
  const total = Object.values(v).reduce((a, b) => a + b, 0);
  const idle = v.idle + (v.iowait || 0);
  if (!(total > 0)) return { pct: null, counters: null, keys };
  if (total >= 90 && total <= 110) {
    const pct = Math.max(0, Math.min(100, (1 - idle / total) * 100));
    return { pct: Math.round(pct * 10) / 10, counters: null, keys };
  }
  return { pct: null, counters: { busy: total - idle, total }, keys };
}

/** 누적 CPU 카운터 두 개 → 사용률(첫 표본·리셋·간격 0 이면 null — rates.js 규약). */
export function cpuPctFromCounters(prev, cur) {
  if (!prev || !cur) return null;
  const dt = cur.total - prev.total; const db = cur.busy - prev.busy;
  if (!(dt > 0) || db < 0) return null;
  const p = (db / dt) * 100;
  return p > 100 ? null : Math.round(p * 10) / 10;
}

/**
 * 메모리 파서(순수) — /proc/meminfo 관용 이름. 사용률 = (total − available)/total, available 이 없으면 (total − free − buffers − cached)/total.
 * 단위는 확인하지 못했다(/proc/meminfo 는 kB) — 비율만 단정하고 total 은 원값을 그대로 싣는다(`unit` 은 추정 표시용).
 * @returns {{ pct:number|null, total:number|null, keys:string[] }}
 */
export function parseMemory(text) {
  const { entities, format, keys } = entitiesOf(text);
  if (notRead(format, entities)) return { pct: null, total: null, keys };
  let f = null;
  for (const [, x] of entities) if (pick(x, ['memTotal', 'MemTotal', 'total']) != null) { f = x; break; }
  if (!f) return { pct: null, total: null, keys };
  const total = numOrNull(pick(f, ['memTotal', 'MemTotal', 'total']));
  if (!(total > 0)) return { pct: null, total: null, keys };
  const avail = numOrNull(pick(f, ['memAvailable', 'MemAvailable', 'available']));
  let used = null;
  if (avail != null && avail >= 0 && avail <= total) used = total - avail;
  else {
    const free = numOrNull(pick(f, ['memFree', 'MemFree', 'free']));
    if (free == null) return { pct: null, total, keys };
    const bc = (numOrNull(pick(f, ['buffers', 'Buffers'])) || 0) + (numOrNull(pick(f, ['cached', 'Cached'])) || 0);
    used = total - free - bc;
    if (used < 0) return { pct: null, total, keys };
  }
  return { pct: Math.round((used / total) * 1000) / 10, total, keys };
}

/* ── v2.641: 장비 개요(레거시 인벤토리·수명주기·버그 노출) · 이벤트 ─────────────── */

/** 시각 → epoch ms. ISO 문자열·초·밀리초를 받는다. **1970 년(0 이하)·말이 안 되는 값은 null**(실장비 Resource API 의 bootTime 이
 *  '1970-01-01T00:00:00Z' 였다 — 그것을 믿으면 업타임 56년이 된다). 숫자 문자열은 Date.parse 에 넘기지 않는다(v2.562). */
export function tsOf(v) {
  if (v == null || v === '') return null;
  let ms = null;
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()))) {
    const n = Number(v);
    ms = n > 1e14 ? Math.floor(n / 1e6) : n > 1e11 ? n : n * 1000; // ns · ms · s
  } else if (typeof v === 'string') { const t = Date.parse(v); ms = Number.isFinite(t) ? t : null; }
  else if (isObj(v) && (v.seconds != null)) ms = Number(v.seconds) * 1000;
  if (!Number.isFinite(ms) || ms <= 86_400_000 * 365) return null; // 1971 이전은 '값 없음'
  return Math.round(ms);
}

/**
 * 레거시 인벤토리(`/cvpservice/inventory/devices`) → Map(serial → {mgmtIp, status, complianceCode, complianceIndication,
 *   bootAt, container, ztpMode, mlag}). 필드 이름은 Arista cvprac(get_inventory)이 쓰는 이름이다.
 */
export function parseLegacyInventory(text) {
  const { values } = splitJsonStream(text);
  const out = new Map(); const keys = new Set();
  const visit = (o) => {
    if (!isObj(o)) return;
    const serial = str(o.serialNumber || '', 128);
    if (!serial) return;
    for (const k of Object.keys(o)) if (keys.size < 40) keys.add(k);
    const code = o.complianceCode == null ? '' : str(o.complianceCode, 32);
    out.set(serial, {
      mgmtIp: str(o.ipAddress || '', 64),
      status: str(o.status || '', 32),
      complianceCode: code,
      complianceIndication: str(o.complianceIndication || '', 32),
      bootAt: tsOf(o.bootupTimestamp ?? o.bootupTimeStamp),
      container: str(o.containerName || o.parentContainerName || '', 128),
      ztpMode: o.ztpMode === true || o.ztpMode === 'true' ? true : o.ztpMode === false || o.ztpMode === 'false' ? false : null,
      mlag: o.mlagEnabled === true ? true : o.mlagEnabled === false ? false : null,
      internalVersion: str(o.internalVersion || '', 64),
    });
  };
  for (const v of values) {
    if (Array.isArray(v)) v.forEach(visit);
    else if (isObj(v) && Array.isArray(v.netElementList)) v.netElementList.forEach(visit);
    else visit(v);
  }
  return { map: values.length ? out : null, keys: [...keys] };
}

/** Resource API 스트림(`{"result":{"value":…}}`) → value 목록. 못 읽으면 null. */
function resourceValues(text) {
  const { values } = splitJsonStream(text);
  const out = []; let recognized = false;
  for (const v of values) {
    const list = Array.isArray(v) ? v : [v];
    for (const x of list) if (isObj(x) && isObj(x.result) && isObj(x.result.value)) { recognized = true; out.push(x.result.value); }
  }
  return recognized ? out : (values.length === 0 ? [] : null);
}
const devIdOf = (v) => (isObj(v?.key) ? str(v.key.deviceId || '', 128) : '');

/** 수명주기(lifecycle.v1 DeviceLifecycleSummary) → Map(deviceId → {swEol:{version,endOfSupport}, hwEol, hwEos, hwEoTac, hwEoRma}). */
export function parseLifecycle(text) {
  const vals = resourceValues(text);
  if (vals == null) return { map: null, keys: [] };
  const out = new Map(); const keys = new Set();
  for (const v of vals) {
    const id = devIdOf(v); if (!id) continue;
    for (const k of Object.keys(v)) if (keys.size < 40) keys.add(k);
    const sw = isObj(v.softwareEol) ? v.softwareEol : {};
    const hw = isObj(v.hardwareLifecycleSummary) ? v.hardwareLifecycleSummary : {};
    const d = (x) => (isObj(x) ? tsOf(x.date) : null);
    out.set(id, {
      swEolVersion: str(sw.version || '', 64), swEndOfSupport: tsOf(sw.endOfSupport),
      hwEndOfLife: d(hw.endOfLife), hwEndOfSale: d(hw.endOfSale), hwEndOfTacSupport: d(hw.endOfTacSupport), hwEndOfRma: d(hw.endOfHardwareRmaRequests),
    });
  }
  return { map: out, keys: [...keys] };
}

const EXPOSURE = { HIGHEST_EXPOSURE_NONE: 'none', HIGHEST_EXPOSURE_LOW: 'low', HIGHEST_EXPOSURE_HIGH: 'high' };
/** 버그 노출(bugexposure.v1) → Map(deviceId → {bugCount, cveCount, highestBug, highestCve}). **확인하지 않은(UNACKNOWLEDGED) 것**을 우선한다. */
export function parseBugExposure(text) {
  const vals = resourceValues(text);
  if (vals == null) return { map: null, keys: [] };
  const out = new Map(); const keys = new Set();
  for (const v of vals) {
    const id = devIdOf(v); if (!id) continue;
    for (const k of Object.keys(v)) if (keys.size < 40) keys.add(k);
    const ack = String(v.key?.acknowledgement || '');
    const rec = {
      bugCount: numOrNull(v.bugCount), cveCount: numOrNull(v.cveCount),
      highestBug: EXPOSURE[v.highestBugExposure] || null, highestCve: EXPOSURE[v.highestCveExposure] || null,
      acknowledged: ack === 'ACKNOWLEDGEMENT_ACKNOWLEDGED',
    };
    const prev = out.get(id);
    if (!prev || (prev.acknowledged && !rec.acknowledged)) out.set(id, rec);
  }
  return { map: out, keys: [...keys] };
}

export const EVENT_SEVERITIES = Object.freeze(['critical', 'error', 'warning', 'info', 'debug', 'unknown']);
const SEV = { EVENT_SEVERITY_CRITICAL: 'critical', EVENT_SEVERITY_ERROR: 'error', EVENT_SEVERITY_WARNING: 'warning', EVENT_SEVERITY_INFO: 'info', EVENT_SEVERITY_DEBUG: 'debug' };
export const EVENT_MAX = 2000;

/**
 * 이벤트(event.v1 Event) → { events:[{key, ts, severity, title, desc, type, devices[], ack, updatedAt, deleted}] (최신 순, 상한 EVENT_MAX),
 *   bySeverity, total, truncated }. 필드 이름은 cloudvision-apis event.proto 기준(camelCase JSON). 대상 장비는 components 의
 *   `deviceId` 값에서 뽑는다(없으면 빈 목록 — 지어내지 않는다). **'진행 중(Active)' 여부는 판정하지 않는다** — 스키마에 종료 시각
 *   필드가 없다(delete_time 은 삭제다). 못 읽으면 events=null.
 */
export function parseEvents(text, { max = EVENT_MAX } = {}) {
  const vals = resourceValues(text);
  if (vals == null) return { events: null, bySeverity: null, total: 0, truncated: 0, keys: [] };
  const keys = new Set(); const all = [];
  for (const v of vals) {
    if (!isObj(v?.key)) continue;
    for (const k of Object.keys(v)) if (keys.size < 40) keys.add(k);
    const ts = tsOf(v.key.timestamp);
    const devs = [];
    const comps = Array.isArray(v.components?.components) ? v.components.components : [];
    for (const c of comps) {
      const m = isObj(c?.components) ? c.components : {};
      const id = m.deviceId || m.device || m.serialNumber;
      if (typeof id === 'string' && id && devs.length < 32 && !devs.includes(id)) devs.push(str(id, 128));
    }
    all.push({
      key: str(v.key.key || '', 256), ts,
      severity: SEV[v.severity] || 'unknown',
      title: str(v.title || '', 256), desc: str(v.description || '', 1000), type: str(v.eventType || '', 128),
      devices: devs, ack: v.ack?.ack === true, updatedAt: tsOf(v.lastUpdatedTime), deleted: tsOf(v.deleteTime) != null,
    });
  }
  all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const bySeverity = Object.fromEntries(EVENT_SEVERITIES.map((k) => [k, 0]));
  for (const e of all) bySeverity[e.severity]++;
  return { events: all.slice(0, max), bySeverity, total: all.length, truncated: Math.max(0, all.length - max), keys: [...keys] };
}
