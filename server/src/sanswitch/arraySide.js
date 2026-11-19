/**
 * sanswitch/arraySide.js — 어레이가 보고하는 프런트엔드 성능을 SAN 스토리지 성능 화면 · 점검에 맞춰 조립(순수 · v2.952 · 설계 ⓑ §4.2).
 *
 * 입력은 노드 부하 표(storage/db.js nodeLoadQuery · nodeUnitsOf — 수집은 storage/collectors/arrayPerf.js)이고, 여기서는
 *  ① 단위 카탈로그에서 이 어레이 것만 고르고(PowerMax 는 Unisphere 하나가 여러 어레이를 관리하면 `<시리얼>::FA-1D` 로 이름이 붙는다),
 *  ② SAN 쪽 디렉터 그룹(FA-1D · Node A · SPA — directorOf 결과)과 **정규화 비교**로 짝을 짓고(대소문자 · 구분자 무시 · 억지로 합치지 않는다),
 *  ③ 최신 표본(단위 · 지표별 마지막 값과 시각 · 오래됨) · 창 시계열(열 = 시각, 단위 × 지표) · 점검용 요약(최댓값 단위와 함께) · 보고 대조(차이 %)를 만든다.
 * 못 읽은 값은 null 이고 합계는 **모든 부모 단위를 읽었을 때만**(부분 합 금지). 임계값 판정은 storagePerfCheck.judgeArraySide 가 한다(여기서 하지 않는다).
 */
import { numOrNull } from '../util/numOrNull.js';
import { unitMatchKey } from '../storage/nodeLoad.js';

/** 화면 · 점검이 쓰는 지표 목록(표 열 순서). unit 은 표시 단위. */
export const FE_METRICS = Object.freeze([
  { k: 'busy', label: '디렉터 busy', unit: '%', agg: 'max', kinds: ['fa'] },
  { k: 'cpu', label: '노드 · SP CPU', unit: '%', agg: 'max', kinds: ['node', 'sp'] },
  { k: 'iops', label: 'IOPS', unit: 'IO/s', agg: 'sum', kinds: ['fa', 'node', 'sp'] },
  { k: 'lat', label: '응답 시간', unit: 'ms', agg: 'max', kinds: ['fa', 'node', 'sp'] },
  { k: 'hbps', label: '호스트 처리량', unit: 'B/s', agg: 'sum', kinds: ['fa', 'node', 'sp'] },
  { k: 'queue', label: '큐 깊이 사용률', unit: '%', agg: 'max', kinds: ['fa'] },
]);
export const FE_KEYS = Object.freeze(FE_METRICS.map((m) => m.k));
/** 보고 대조를 하는 스위치 처리량 하한 — 이보다 한가하면 비율이 뜻이 없다(편중 하한과 같은 뜻 · 0.5 Gb/s). */
export const COMPARE_MIN_BPS = 62_500_000;
/** 최신 표본이 이보다 오래되면 '오래됨'(표본 주기의 3배 — nodeLoad 화면 lateMs 와 같은 배수). */
export const staleMsOf = (sampleMs) => Math.max(60_000, (numOrNull(sampleMs) ?? 300_000) * 3);

const norm = (v) => String(v ?? '').toUpperCase().replace(/[\s:_.-]+/g, '');

/**
 * ① 카탈로그에서 이 어레이의 단위만 — `<시리얼>::이름` 은 시리얼이 같을 때만 남기고 표시 이름은 뒤 조각. 접두가 없는 이름은 그대로(장비 = 어레이 하나).
 * @returns {Array<{id:number, name:string, kind:string, parent:number|null, display:string}>}
 */
export function unitsForArray(units = [], { serial = '' } = {}) {
  const want = norm(serial);
  const out = [];
  for (const u of units || []) {
    if (!u || typeof u !== 'object') continue;
    const name = String(u.name || '');
    const i = name.indexOf('::');
    if (i > 0) { if (!want || norm(name.slice(0, i)) !== want) continue; out.push({ ...u, display: name.slice(i + 2) }); }
    else out.push({ ...u, display: name });
  }
  return out;
}

/**
 * ② SAN 쪽 그룹(디렉터 카드 · 포트 표의 group / directorPort)과 짝짓기. 부모 단위는 그룹 이름으로, 포트 단위는 `그룹 + 포트` 로 비교한다.
 * @param {Array} units unitsForArray 결과
 * @param {Array<{group:string, parsed?:boolean}>} groups SAN 디렉터 묶음
 * @param {Array<{group:string, directorPort?:string}>} [ports] SAN 포트(선택)
 * @returns {{byUnit:Object<number,{group:string|null, port:string|null}>, unmatchedGroups:string[], matched:number}}
 */
export function matchUnits(units = [], groups = [], ports = []) {
  const gKey = new Map();
  for (const g of groups || []) if (g && g.group && g.parsed !== false) gKey.set(unitMatchKey(g.group), g.group);
  const pKey = new Map();
  for (const p of ports || []) if (p && p.group) pKey.set(unitMatchKey(`${p.group} ${p.directorPort ?? ''}`), { group: p.group, port: String(p.directorPort ?? '') });
  const byUnit = {}; const usedGroups = new Set(); let matched = 0;
  for (const u of units) {
    const key = unitMatchKey(u.display ?? u.name);
    if (u.kind === 'port') {
      const hit = pKey.get(key) || null;
      byUnit[u.id] = hit ? { group: hit.group, port: hit.port } : { group: null, port: null };
    } else {
      const g = gKey.get(key) || null;
      byUnit[u.id] = { group: g, port: null };
      if (g) { usedGroups.add(unitMatchKey(g)); matched += 1; }
    }
  }
  const unmatchedGroups = [...gKey.entries()].filter(([k]) => !usedGroups.has(k)).map(([, g]) => g);
  return { byUnit, unmatchedGroups, matched };
}

/**
 * ③-1 최신 표본(순수): nodeLoadQuery(kind raw) 행 → 단위별 { ts(마지막 표본), v:{지표: 마지막으로 읽힌 값}, at:{지표: 그 값의 시각}, stale }.
 * 값이 null 인 표본은 그 지표의 '마지막 값' 을 덮지 않는다(못 읽음은 0 도 최신도 아니다) — 대신 ts 는 가장 최근 표본 시각이다.
 */
export function latestByUnit(rows = [], { now = Date.now(), staleMs = 900_000 } = {}) {
  const out = {};
  for (const r of rows || []) {
    const id = numOrNull(r?.node); const ts = numOrNull(r?.ts);
    if (id == null || ts == null) continue;
    const cur = out[id] || (out[id] = { ts: null, v: {}, at: {} });
    if (cur.ts == null || ts >= cur.ts) cur.ts = ts;
    for (const k of FE_KEYS) {
      const val = numOrNull(r.v?.[k]);
      if (val == null) continue;
      if (cur.at[k] == null || ts >= cur.at[k]) { cur.v[k] = val; cur.at[k] = ts; }
    }
  }
  for (const u of Object.values(out)) { u.stale = u.ts == null || u.ts < now - staleMs; for (const k of FE_KEYS) if (!(k in u.v)) u.v[k] = null; }
  return out;
}

/**
 * ③-2 창 시계열(순수): 행(raw · bucket · daily 공통 — node · ts · v) → { cols:[ts…], byUnit:{id:{지표:[값|null…]}} }. 열은 모든 단위의 시각 합집합(정렬).
 * 행이 너무 많으면 maxCols 로 앞에서 자른다(오래된 쪽을 버리지 않고 **최근 쪽을 남긴다**).
 */
export function feSeries(rows = [], { maxCols = 2000 } = {}) {
  const tsSet = new Set();
  for (const r of rows || []) { const t = numOrNull(r?.ts); if (t != null) tsSet.add(t); }
  let cols = [...tsSet].sort((a, b) => a - b);
  if (cols.length > maxCols) cols = cols.slice(cols.length - maxCols);
  const idx = new Map(cols.map((t, i) => [t, i]));
  const byUnit = {};
  for (const r of rows || []) {
    const id = numOrNull(r?.node); const i = idx.get(numOrNull(r?.ts));
    if (id == null || i == null) continue;
    const u = byUnit[id] || (byUnit[id] = Object.fromEntries(FE_KEYS.map((k) => [k, new Array(cols.length).fill(null)])));
    for (const k of FE_KEYS) { const v = numOrNull(r.v?.[k]); if (v != null) u[k][i] = v; }
  }
  return { cols, byUnit };
}

/**
 * ③-3 점검용 요약(순수): 지표마다 부모 단위(포트 제외)의 최댓값(또는 합) + 그 단위 이름. 오래된 단위는 빼고, 하나도 없으면 null.
 *  합(iops · hbps)은 **그 지표를 읽은 단위가 부모 전부일 때만**(부분 합 금지) — 아니면 null 과 partial:true.
 * @returns {Object<string, {value:number, unit:string, ts:number, partial?:boolean}|null>}
 */
export function summarizeLatest(units = [], latest = {}) {
  const parents = (units || []).filter((u) => u && u.kind !== 'port');
  const out = {};
  for (const m of FE_METRICS) {
    const cand = parents.filter((u) => m.kinds.includes(u.kind || '')).map((u) => ({ u, l: latest[u.id] })).filter((x) => x.l && !x.l.stale);
    if (!cand.length) { out[m.k] = null; continue; }
    const have = cand.filter((x) => x.l.v[m.k] != null);
    if (!have.length) { out[m.k] = null; continue; }
    if (m.agg === 'sum') {
      const partial = have.length < cand.length;
      out[m.k] = partial ? { value: null, unit: '', ts: null, partial: true, read: have.length, of: cand.length }
        : { value: have.reduce((a, x) => a + x.l.v[m.k], 0), unit: '', ts: Math.max(...have.map((x) => x.l.at[m.k])), read: have.length, of: cand.length };
    } else {
      const top = have.reduce((a, x) => (a == null || x.l.v[m.k] > a.l.v[m.k] ? x : a), null);
      out[m.k] = { value: top.l.v[m.k], unit: top.u.display ?? top.u.name, ts: top.l.at[m.k], read: have.length, of: cand.length };
    }
  }
  return out;
}

/**
 * ③-4 보고 대조(순수): 어레이가 보고한 호스트 처리량 합(B/s)과 스위치 처리량(B/s)의 차이 % = (어레이 − 스위치) ÷ 스위치 × 100.
 * 둘 중 하나가 없거나 스위치가 하한 미만이면 null(비율이 뜻이 없다). 원인은 단정하지 않는다(FC 프레임 헤더 · 제어 트래픽 · 한쪽 계측 누락 — 화면 문구).
 */
export function compareDiffPct(arrayBps, switchBps, { minBps = COMPARE_MIN_BPS } = {}) {
  const a = numOrNull(arrayBps); const s = numOrNull(switchBps);
  if (a == null || s == null || s < minBps) return null;
  return Math.round(((a - s) / s) * 100);
}

/** 점검 입력(storagePerfCheck.checkArray 의 arraySide) — summarizeLatest + 대조를 판정 모양 `{ value, max, group }` 으로. 값이 없으면 그 항목은 넣지 않는다(→ unknown). */
export function toCheckInput(summary, { switchBps = null } = {}) {
  const out = {};
  const put = (k, s) => { if (s && s.value != null) out[k] = { value: Math.round(s.value * 10) / 10, group: s.unit || null, ts: s.ts }; };
  put('dirBusy', summary.busy); put('resp', summary.lat); put('queue', summary.queue); put('cpu', summary.cpu);
  const diff = compareDiffPct(summary.hbps?.value, switchBps);
  if (diff != null) out.compare = { value: diff, arrayBps: summary.hbps.value, switchBps };
  return out;
}
