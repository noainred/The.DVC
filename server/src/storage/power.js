/**
 * storage/power.js — 스토리지 소비 전력 공용 판정(v2.667, **순수 모듈** — 테스트로 고정).
 *
 * 사용자 요청: "스토리지가 안나오는데, 모든 스토리지의 수집하는 파싱값에서 소비전력 추가로 수집해서 처리하는 로직 추가해줘"
 * (전체 소비 전력 화면: 스토리지 0.0 kW · 측정 0/79대 · 못 읽음 18 · 수집 경로 없음 61).
 *
 * 수집기는 결과를 `snap.extra.power`(읽음) 또는 `snap.extra.powerProbe`(시도했지만 못 읽음)로 싣는다:
 *   extra.power      = { watts, source, basis, scope, parts, at }           ← power/total.js 가 더한다
 *   extra.powerProbe = { tried:true, reason, source, detail?, seenKeys? }    ← '못 읽음' 을 사유별로 센다
 *
 * ⚠⚠ 정직 기록 — **벤더 전원 필드는 전부 실장비로 확인하지 못했다**(Unity SSH `svc_diag -s spinfo` 만 사용자 제공 출력으로
 *   만든 파서다). 그래서 필드 이름을 하나로 굳히지 않고 **이름 패턴**으로 찾으며, 무엇을 읽었는지(`source`·`basis`)와
 *   못 읽었을 때 응답에 있던 키(`seenKeys`)를 싣는다 — 첫 실수집에서 그 값을 보고 좁힐 것(v2.545 후보 체인 규약).
 *
 * 규칙:
 *  · 못 읽으면 0 W 가 아니라 null(0 은 '전원이 꺼졌다' 는 거짓 — v2.664 규약).
 *  · 퍼센트·최대·평균·정격·임계·용량 이름은 전력값이 아니다 — 현재 전력만 쓴다(평균·최대를 섞으면 합계가 거짓).
 *  · 같은 응답 안에서 시스템 합계와 부품별 값이 함께 있으면 **시스템 합계 하나**만 쓴다(둘을 더하면 이중 계수).
 *  · 범위(scope)를 밝힌다 — 'system'(장비 전체) · 'psu'(전원공급장치 입력 합) · 'dpe'(Unity SP 인클로저만) · 'node'(노드 합).
 */
import { numOrNull } from '../util/numOrNull.js';
import { normalizeCollectMethod } from './types.js';

/** 타입·수집 방식별 전원 수집 경로. 여기 없는 조합은 '수집 경로 없음' 이다(power/total.js 가 이 표로 가른다). */
export const POWER_PATHS = Object.freeze({
  'unity480:ssh': 'svc_diag -s spinfo (DPE 전원공급장치 입력 전력)',
  'unity480:api': 'Unisphere REST system.currentPower',
  'powerstore:api': 'PowerStore REST hardware(Power_Supply).extra_details',
  'xtremio:api': 'XMS REST storage-controller-psus',
  'isilon:api': 'OneFS statistics(전원 키 탐색)',
  'isilon:ssh': 'isi statistics(전원 키 탐색)',
  'powermax:api': 'Unisphere REST 어레이 상세 응답의 전원 필드',
  'vmax:api': 'Unisphere REST 어레이 상세 응답의 전원 필드',
});

/** 경로가 없는 이유(화면 문구 근거) — 지어내지 않는다: '확인한 조회 경로가 없다' 까지만 말한다. */
export const NO_PATH_REASON = Object.freeze({
  vplex: 'VPLEX/Metro Node 관리 API 에서 전원 값을 주는 경로를 확인하지 못했습니다',
  ssh: '이 SSH 수집 방식에는 전원 조회 명령이 없습니다(API 수집이면 시도합니다)',
  other: '이 장비 종류의 전원 조회 경로를 확인하지 못했습니다',
});

/** 수집 방식 — 등록값이 비었거나 허용되지 않으면 그 타입의 기본(수집기와 같은 규칙 — Isilon 은 ssh 가 기본). */
export function methodOf(d) {
  return normalizeCollectMethod(String(d?.type || ''), String(d?.collectMethod || '').toLowerCase());
}

export function powerPathOf(d) {
  return POWER_PATHS[`${String(d?.type || '')}:${methodOf(d)}`] || null;
}

export function noPathReason(d) {
  const t = String(d?.type || '');
  if (t === 'vplex' || t === 'metronode') return NO_PATH_REASON.vplex;
  if (methodOf(d) === 'ssh') return NO_PATH_REASON.ssh;
  return NO_PATH_REASON.other;
}

/* ───────────── 값 해석 ───────────── */

const W_MAX = 1_000_000;   // 한 장비 1MW 초과는 전력값이 아니다(단위 오인 — mW·kWh 등)

/**
 * 전력 값 한 개 → W(순수). 숫자 또는 `330` · `330 W` · `330 Watts` · `0.33 kW` 문자열.
 * 퍼센트(`%`)·에너지(`kWh`)·전압(`V`)·전류(`A`) 는 null.
 */
export function wattsOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v < W_MAX ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, 64);
  if (!s) return null;
  const m = /^(-?\d+(?:\.\d+)?)\s*(kw|w|watts?)?$/i.exec(s);
  if (!m) return null;
  const n = numOrNull(m[1]);
  if (n == null || n < 0) return null;
  const w = /^kw$/i.test(m[2] || '') ? n * 1000 : n;
  return w < W_MAX ? w : null;
}

const norm = (k) => String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** 현재 전력이 아닌 이름(평균·최대·정격·임계·퍼센트·에너지·용량·전압·전류·상태). */
const NOT_CURRENT = /(avg|average|max|min|peak|rated|rating|limit|threshold|budget|capacity|percent|pct|ratio|energy|kwh|volt|amp|current(?:a|amps?)$|state|status|fault|fail|lost|redundan|mode|count|num|id$|type|feed|source|supply(?:type|model))/;
/** 시스템(장비 전체) 합계 이름. */
const SYSTEM_KEYS = new Set(['currentpower', 'powerconsumption', 'currentpowerconsumption', 'powerconsumptionwatts', 'totalpower', 'totalpowerconsumption', 'systempower', 'chassispower', 'powerwatts', 'consumedpower', 'powerconsumed', 'powerdraw']);
/** 부품(PSU·노드) 단위 입력 전력 이름. */
const PART_KEYS = new Set(['inputpower', 'inputwatts', 'powerinput', 'inputpowerwatts', 'powerinwatts', 'inpower', 'acinputpower', 'watts', 'power', 'outputpower', 'outputwatts']);

/** 키 이름 판정 — 'system' | 'part' | 'output' | null. */
export function powerKeyKind(key) {
  const k = norm(key);
  if (!k || !/power|watt/.test(k)) return null;
  if (NOT_CURRENT.test(k.replace(/^current(?=power)/, ''))) return null;
  if (SYSTEM_KEYS.has(k)) return 'system';
  if (/^output/.test(k) || k === 'outputpower') return 'output';
  if (PART_KEYS.has(k)) return 'part';
  return null;
}

/**
 * 응답 객체를 훑어 전력 후보를 모은다(순수). 깊이·노드 상한이 있다(장비 응답은 외부 입력이다).
 * @returns {{hits:Array<{path:string,key:string,kind:string,watts:number}>, keys:string[]}}
 *   keys = 응답에 있던 키 이름(최대 40개) — 못 읽었을 때 '무엇이 있었나' 를 밝히는 진단값.
 */
export function scanPower(obj, { maxDepth = 6, maxNodes = 5000 } = {}) {
  const hits = []; const misses = []; const keys = new Set(); let nodes = 0;
  const walk = (o, path, depth) => {
    if (o == null || depth > maxDepth || nodes > maxNodes) return;
    nodes += 1;
    if (Array.isArray(o)) { o.slice(0, 500).forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1)); return; }
    if (typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (keys.size < 40) keys.add(k);
      const kind = powerKeyKind(k);
      if (kind && (v === null || typeof v === 'number' || typeof v === 'string')) {
        const w = v === null ? null : wattsOf(v);
        if (w != null) hits.push({ path: path ? `${path}.${k}` : k, key: k, kind, watts: w });
        // v2.682 R3D-03: 전원 키는 있는데 값을 못 읽은 항목(null·'N/A'·빈 문자열)을 센다 — 같은 층에서 이것이 있으면
        //   합계는 일부 부품만의 값이다. 빈 슬롯(상태가 absent·not present·empty·removed)은 부품이 아니라 세지 않는다.
        else if (!slotAbsent(o)) misses.push({ path: path ? `${path}.${k}` : k, key: k, kind });
        continue;
      }
      if (v && typeof v === 'object') walk(v, path ? `${path}.${k}` : k, depth + 1);
    }
  };
  walk(obj, '', 0);
  return { hits, misses, keys: [...keys] };
}

/** 같은 객체의 상태 필드가 '빈 슬롯' 을 말하는가(순수). */
const ABSENT_RE = /^(absent|not ?present|notpresent|empty|removed|missing|not ?installed)$/i;
function slotAbsent(o) {
  for (const [k, v] of Object.entries(o)) {
    if (typeof v !== 'string') continue;
    if (/^(state|status|presence|health_?state|lifecycle_?state)$/i.test(k) && ABSENT_RE.test(v.trim())) return true;
  }
  return false;
}

/**
 * 후보 → 합계(순수). 시스템 합계가 있으면 그것(여러 개면 합 — 어레이·클러스터가 여럿일 때), 없으면 부품 입력 합,
 * 그것도 없으면 부품 출력 합(basis 'output' — 효율 손실만큼 과소). 서로 다른 층을 더하지 않는다.
 * @returns {{watts:number, basis:'system'|'input'|'output', parts:number, keys:string[]} | null}
 */
export function pickPower(hits, misses = []) {
  const list = Array.isArray(hits) ? hits : [];
  const miss = Array.isArray(misses) ? misses : [];
  for (const [kind, basis] of [['system', 'system'], ['part', 'input'], ['output', 'output']]) {
    const hs = list.filter((h) => h.kind === kind);
    if (!hs.length) continue;
    // 같은 층 안에서도 이름이 여럿이면 가장 흔한 이름 하나만 쓴다(inputPower 와 watts 가 같은 값을 두 번 줄 수 있다).
    const byKey = new Map();
    for (const h of hs) { const k = norm(h.key); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(h); }
    const [chosenKey, chosenAll] = [...byKey.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    let chosen = chosenAll; let duplicates = 0;
    // v2.682 R3D-08: 시스템 합계가 **한 응답 안의 서로 다른 자리**(배열 원소가 아닌 경로 — 예 summary.currentPower 와
    //   system.currentPower)에 **같은 값**으로 두 번 나오면 같은 합계를 되풀이한 것이다 — 하나만 쓴다. 배열 원소(여러 어레이·
    //   클러스터)나 같은 경로(수집기가 어레이마다 따로 훑은 값)는 합친다(예전 그대로). ⚠ 실장비 응답 모양은 확인하지 못했다 —
    //   서로 다른 객체 키 아래의 두 어레이가 우연히 같은 값이면 하나로 줄어든다(드문 경우 — 정직 기록).
    if (kind === 'system') {
      const seen = new Map(); const keep = [];
      for (const h of chosenAll) {
        if (String(h.path || '').includes('[')) { keep.push(h); continue; }
        const prev = seen.get(h.watts);
        if (prev && prev !== h.path) { duplicates += 1; continue; }
        if (!prev) seen.set(h.watts, h.path);
        keep.push(h);
      }
      chosen = keep;
    }
    const watts = chosen.reduce((a, h) => a + h.watts, 0);
    // v2.682 R3D-03: 같은 층·같은 이름에서 값을 못 읽은 부품 수 — 있으면 합계는 부분 합이다.
    const missing = miss.filter((m) => m && m.kind === kind && norm(m.key) === chosenKey).length;
    const out = { watts: Math.round(watts), basis, parts: chosen.length, keys: [chosen[0].key] };
    if (missing > 0) out.missing = missing;
    if (duplicates > 0) out.duplicates = duplicates;
    return out;
  }
  return null;
}

/** 수집기가 싣는 읽음 결과. */
export function powerResult({ watts, source, basis = 'system', scope = 'system', parts = null, keys = null, missing = null, at = Date.now() }) {
  const w = numOrNull(watts);
  if (w == null || w < 0 || w >= W_MAX) return null;
  const out = { watts: Math.round(w), source: String(source || '').slice(0, 200), basis, scope, at };
  if (parts != null) out.parts = parts;
  // v2.682 R3D-03: 일부 부품의 값을 못 읽었으면 부분 합이다 — power/total.js 가 '측정' 이 아니라 partial 로 센다.
  const ms = numOrNull(missing);
  if (ms != null && ms > 0) { out.partial = true; out.missing = Math.round(ms); }
  if (Array.isArray(keys) && keys.length) out.keys = keys.slice(0, 8).map((k) => String(k).slice(0, 80));
  return out;
}

/** 못 읽음 사유 코드 — 화면(웹 powerTotalText)이 1:1 로 문구를 가진다. */
export const PROBE_REASONS = Object.freeze(['request-failed', 'no-field', 'skipped', 'parse-failed']);

export function powerProbe(reason, { source = '', detail = '', seenKeys = null } = {}) {
  const r = PROBE_REASONS.includes(reason) ? reason : 'request-failed';
  const out = { tried: true, reason: r, source: String(source || '').slice(0, 200), at: Date.now() };
  if (detail) out.detail = String(detail).slice(0, 200);
  if (Array.isArray(seenKeys) && seenKeys.length) out.seenKeys = seenKeys.slice(0, 40).map((k) => String(k).slice(0, 60));
  return out;
}

/**
 * 응답 하나(또는 여럿)를 훑어 extra 에 결과를 싣는다 — 수집기 공용(순수 + extra 변경).
 * @param {object} extra snap.extra
 * @param {any} data 응답(배열이면 원소 합)
 * @param {{source:string, scope?:string}} opts
 */
export function applyScannedPower(extra, data, { source, scope = 'system' }) {
  const { hits, misses, keys } = scanPower(data);
  const p = pickPower(hits, misses);
  const r = p ? powerResult({ watts: p.watts, source, basis: p.basis, scope: p.basis === 'system' ? scope : (scope === 'system' ? 'psu' : scope), parts: p.parts, keys: p.keys, missing: p.missing }) : null;
  if (r) { extra.power = r; delete extra.powerProbe; return true; }
  extra.powerProbe = powerProbe('no-field', { source, seenKeys: keys });
  return false;
}
