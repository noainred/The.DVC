/**
 * storage/nodeLoad.js — 노드 부하 시계열(네트워크 In/Out · 디스크 쓰기/읽기 · CPU)의 순수 규칙(v2.926).
 *
 * 사용자 요청(2026-11-07): "아이실론에서 이미 수집하는 정보에서 노드별 io network 부하를 저장하고 차트로" +
 * "기간별 시간별로 이전 기록 보는 기능" + "Disk io 추가" + 성능 관점 추천 ①CPU ④잡 엔진 겹쳐 표시 ⑤지난주 같은 구간 비교.
 * 설계·시안: `docs/design/isilon-node-load/README.md`. 저장·조회는 `storage/db.js`, 이 모듈은 DB 를 모른다(테스트가 고정).
 *
 * ★ 지키는 것
 *  · **새 장비 호출이 없다** — 스냅샷이 이미 가진 노드 값을 수집 주기마다 한 줄씩 남긴다(표본 = 그 시점 순간값 · 주기 사이는 모른다).
 *  · **못 읽은 값은 NULL** — 0 으로 바꾸지 않는다(numOrNull). 목록에 있는 노드는 값이 모두 비어도 행을 남긴다 — 그래야 그 주기의
 *    클러스터 합계가 '부분 합' 인지 판정할 수 있다(합계 = 목록의 모든 노드를 읽었을 때만, 아니면 null).
 *  · 노드 값이 하나도 없는 스냅샷(Unity·PowerStore 처럼 노드 처리량을 재지 않는 타입)은 **적재하지 않는다**(빈 행을 쌓지 않는다).
 *  · 노드 식별은 `nodes.list[].id`(Isilon = lnn) — 교체 노드도 같은 lnn 이면 이어진다(README §6-5).
 */
import { numOrNull } from '../util/numOrNull.js';

/** 지표 키 → 스냅샷 노드 필드 · DB 열. 순서가 곧 응답 순서다. */
export const NODE_LOAD_METRICS = Object.freeze([
  { key: 'in', field: 'inBps', col: 'in_bps', unit: 'bps' },
  { key: 'out', field: 'outBps', col: 'out_bps', unit: 'bps' },
  { key: 'din', field: 'diskInBytesPs', col: 'disk_in', unit: 'B/s' },
  { key: 'dout', field: 'diskOutBytesPs', col: 'disk_out', unit: 'B/s' },
  { key: 'cpu', field: 'cpuPct', col: 'cpu_pct', unit: '%' },
]);
export const METRIC_BY_KEY = new Map(NODE_LOAD_METRICS.map((m) => [m.key, m]));
/** 화면 묶음 — 한 번에 한 묶음만 그린다(bps 와 B/s 와 % 는 단위가 달라 한 차트에 겹치지 않는다 — 이중 축 금지). */
export const NODE_LOAD_GROUPS = Object.freeze({ net: ['in', 'out'], disk: ['din', 'dout'], cpu: ['cpu'] });
/** 클러스터 값 — 처리량은 노드 합, CPU 는 노드 평균. */
export const CLUSTER_AGG = Object.freeze({ in: 'sum', out: 'sum', din: 'sum', dout: 'sum', cpu: 'avg' });
/** 스냅샷 계약의 노드 목록 상한(types.js · edgeRecord.NODE_LIST_MAX 와 같은 값). */
export const NODE_LOAD_LIMIT = 64;
export const JOBS_MAX = 8;

const valueOf = (m, v) => {
  const n = numOrNull(v);
  if (n == null || n < 0) return null;
  if (m.key === 'cpu' && n > 100) return null;
  return n;
};
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * 스냅샷 → 적재할 노드 행(순수). 엣지가 올린 스냅샷도 이것을 거친다(아는 필드만 · 상한 · 문자열 수치는 수로).
 * @returns {{ok:false, reason:string} | {ok:true, ts:number, nodes:Array<object>, jobs:object|null}}
 *   reason: collect-failed · no-nodes · no-load(노드 값이 하나도 없다) · no-id
 */
export function nodeLoadRowsOf(snap) {
  if (!snap?.ok) return { ok: false, reason: 'collect-failed' };
  const id = String(snap.deviceId ?? snap.id ?? '');
  if (!id) return { ok: false, reason: 'no-id' };
  const list = snap.nodes?.list;
  if (snap.sections?.nodes !== 'ok' || !Array.isArray(list) || !list.length) return { ok: false, reason: 'no-nodes' };
  const nodes = []; const seen = new Set(); let any = false;
  for (const n of list) {
    if (nodes.length >= NODE_LOAD_LIMIT) break;
    if (!n || typeof n !== 'object' || Array.isArray(n)) continue;
    const nid = numOrNull(n.id);
    if (nid == null || !Number.isSafeInteger(nid) || nid < 0 || seen.has(nid)) continue;
    seen.add(nid);
    const row = { id: nid };
    for (const m of NODE_LOAD_METRICS) { row[m.key] = valueOf(m, n[m.field]); if (row[m.key] != null) any = true; }
    nodes.push(row);
  }
  if (!nodes.length) return { ok: false, reason: 'no-nodes' };
  if (!any) return { ok: false, reason: 'no-load' };
  const ts = numOrNull(snap.collectedAt);
  return { ok: true, deviceId: id, ts: ts != null && ts > 0 ? Math.floor(ts) : Date.now(), nodes, jobs: jobsOf(snap.extra?.jobs) };
}

/**
 * 잡 엔진 상태(SSH `isi status` 꼬리 — REST 경로는 없다) → 적재용 작은 모양. 모르면 null(‘잡 없음’ 이 아니다).
 * @returns {{running:Array<{job:string, impact:string, phase:string}>, paused:number} | null}
 */
export function jobsOf(j) {
  if (!j || typeof j !== 'object' || !Array.isArray(j.running)) return null;
  const running = j.running.filter((x) => x && typeof x === 'object' && typeof x.job === 'string' && x.job)
    .slice(0, JOBS_MAX).map((x) => ({ job: str(x.job, 80), impact: str(x.impact, 16), phase: str(x.phase, 16) }));
  return { running, paused: Array.isArray(j.paused) ? Math.min(99, j.paused.length) : 0 };
}

/* ── 조회 창 ───────────────────────────────────────────────────────────── */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/**
 * 기간 → 창 길이·읽는 표·버킷. 24시간·7일은 원시 표, 30일·90일은 일 롤업(원시 폴백 없음 — historyRollup 규약).
 *  · 24h: 수집 주기가 15분 이상이면 원시 그대로(표본 = 칸), 그보다 촘촘하면 15분 버킷(칸 ≤ 96).
 *  · 7d : 4시간 버킷(42칸 — 평균 + 최대).
 */
export const NODE_LOAD_RANGES = Object.freeze({
  '24h': { days: 1, spanMs: DAY, table: 'raw' },
  '7d': { days: 7, spanMs: 7 * DAY, table: 'raw', bucketMs: 4 * HOUR },
  '30d': { days: 30, spanMs: 30 * DAY, table: 'daily' },
  '90d': { days: 90, spanMs: 90 * DAY, table: 'daily' },
});
/** 비교 구간(⑤) — 24시간은 지난주 같은 요일, 7일은 지난주, 30·90일은 바로 앞 같은 길이. */
export const BASELINE = Object.freeze({
  '24h': { shiftMs: 7 * DAY, label: '지난주 같은 요일' },
  '7d': { shiftMs: 7 * DAY, label: '지난주' },
  '30d': { shiftMs: 30 * DAY, label: '이전 30일' },
  '90d': { shiftMs: 90 * DAY, label: '이전 90일' },
});
export const RAW_BUCKET_FLOOR_MS = 15 * 60_000;

/**
 * 창 계산(순수). `end` 가 없으면 지금. 미래 end 는 지금으로 자르고 clamped. 형식 오류는 지금(조용히 400 을 만들지 않는다 — 화면 링크 호환).
 * @returns {{range, days, spanMs, start, end, past, clamped, kind:'raw'|'bucket'|'daily', bucketMs:number}}
 */
export function nodeLoadWindow({ range, end, now = Date.now(), sampleMs = HOUR } = {}) {
  const key = NODE_LOAD_RANGES[range] ? range : '24h';
  const R = NODE_LOAD_RANGES[key];
  let e = numOrNull(end);
  let clamped = false;
  if (e == null || !(e > 0)) e = now;
  else if (e > now) { e = now; clamped = true; }
  e = Math.floor(e);
  let kind = 'raw'; let bucketMs = 0;
  if (R.table === 'daily') { kind = 'daily'; bucketMs = DAY; }
  else if (R.bucketMs) { kind = 'bucket'; bucketMs = R.bucketMs; }
  else if ((numOrNull(sampleMs) ?? HOUR) < RAW_BUCKET_FLOOR_MS) { kind = 'bucket'; bucketMs = RAW_BUCKET_FLOOR_MS; }
  return { range: key, days: R.days, spanMs: R.spanMs, start: e - R.spanMs, end: e, past: e < now - 60_000, clamped, kind, bucketMs };
}

/* ── 응답 조립 ─────────────────────────────────────────────────────────── */
/**
 * DB 행 → 열 정렬 배열(순수). 행 모양(db.nodeLoadQuery):
 *  · raw   : { node, ts, v:{in,…} }
 *  · bucket/daily : { node, ts, v:{in,…}(평균), mx:{in,…}(최대), n:{in,…}(읽은 표본 수) }
 * 클러스터 값은 그 칸에 행이 있는 노드(= 그 주기 목록의 노드) **전부를** 읽었을 때만 — 하나라도 비면 null(부분 합 금지).
 * 버킷·일 칸은 노드마다 읽은 표본이 하나 이상이면 '읽음' 이고 평균의 합이다(CPU 는 평균의 평균).
 * @returns {{cols:number[], nodes:Array<{id:number, v:object, mx:object|null}>, cluster:object, clusterNodes:number[]}}
 */
export function buildNodeLoadSeries(rows, metrics, { kind = 'raw' } = {}) {
  const keys = (metrics || []).filter((k) => METRIC_BY_KEY.has(k));
  const colSet = new Set(); const byNode = new Map();
  for (const r of rows || []) {
    const ts = numOrNull(r?.ts); const node = numOrNull(r?.node);
    if (ts == null || node == null) continue;
    colSet.add(ts);
    if (!byNode.has(node)) byNode.set(node, new Map());
    byNode.get(node).set(ts, r);
  }
  const cols = [...colSet].sort((a, b) => a - b);
  const idx = new Map(cols.map((t, i) => [t, i]));
  const withMax = kind !== 'raw';
  const nodes = [...byNode.keys()].sort((a, b) => a - b).map((id) => {
    const v = {}; const mx = withMax ? {} : null;
    for (const k of keys) { v[k] = cols.map(() => null); if (mx) mx[k] = cols.map(() => null); }
    for (const [ts, r] of byNode.get(id)) {
      const i = idx.get(ts);
      for (const k of keys) {
        const read = withMax ? (numOrNull(r.n?.[k]) || 0) > 0 : true;
        v[k][i] = read ? numOrNull(r.v?.[k]) : null;
        if (mx) mx[k][i] = read ? numOrNull(r.mx?.[k]) : null;
      }
    }
    return { id, v, mx };
  });
  const cluster = {}; const clusterNodes = cols.map(() => 0);
  for (const k of keys) cluster[k] = cols.map(() => null);
  cols.forEach((ts, i) => {
    const present = nodes.filter((n) => byNode.get(n.id).has(ts));
    clusterNodes[i] = present.length;
    if (!present.length) return;
    for (const k of keys) {
      const vals = present.map((n) => n.v[k][i]);
      if (vals.some((x) => x == null)) continue;
      const sum = vals.reduce((a, b) => a + b, 0);
      cluster[k][i] = CLUSTER_AGG[k] === 'avg' ? Math.round((sum / vals.length) * 10) / 10 : sum;
    }
  });
  return { cols, nodes, cluster, clusterNodes };
}

/** 적재된 잡 표본 → 응답(창 안 · 시각순). jobs 가 null 인 표본(REST 장비 · 모름)은 빼고 known 을 거짓으로 둔다. */
export function jobsSeriesOf(samples) {
  const out = []; let known = false;
  for (const s of samples || []) {
    const ts = numOrNull(s?.ts);
    if (ts == null || typeof s.jobs !== 'string') continue;
    let o = null; try { o = JSON.parse(s.jobs); } catch { o = null; }
    // 저장 모양은 jobsOf 의 결과({running, paused:<수>})다 — 다시 좁힐 때 paused 는 수로 읽는다(배열이 아니다).
    const j = o && typeof o === 'object' && Array.isArray(o.running)
      ? { ...jobsOf({ running: o.running }), paused: Math.max(0, Math.min(99, Math.floor(numOrNull(o.paused) ?? 0))) } : null;
    if (!j) continue;
    known = true;
    if (j.running.length || j.paused) out.push({ ts, running: j.running, paused: j.paused });
  }
  return { known, list: out };
}
