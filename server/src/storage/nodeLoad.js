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
  // v2.932(2차): 프로토콜 ops/s · 평균 지연(ms) · 디스크 busy %(노드 평균) · IOPS. 1시간 스냅샷은 busy·iops 만(REST 키), 5분 표본은 넷 다.
  { key: 'ops', field: 'opsPs', col: 'ops', unit: 'ops/s' },
  { key: 'lat', field: 'latencyMs', col: 'lat', unit: 'ms' },
  { key: 'busy', field: 'busyPct', col: 'busy', unit: '%' },
  { key: 'iops', field: 'iops', col: 'iops', unit: 'ops/s' },
  // v2.949(SAN 스토리지 성능 ⓑ): 어레이 프런트엔드 단위(PowerMax FE 디렉터 · PowerStore 노드 · Unity SP)의 호스트 처리량(B/s · 어레이 보고)과
  //   큐 깊이 사용률(% · PowerMax QueueDepthUtilization). busy = PercentBusy · cpu = 노드/SP CPU · iops · lat = 응답(ms)은 위 열을 그대로 쓴다.
  //   다른 장비(아이실론)는 이 두 열이 null 이다 — 0 이 아니다.
  { key: 'hbps', field: 'hostBytesPs', col: 'hbps', unit: 'B/s' },
  { key: 'queue', field: 'queuePct', col: 'queue', unit: '%' },
]);
export const METRIC_BY_KEY = new Map(NODE_LOAD_METRICS.map((m) => [m.key, m]));
/** 화면 묶음 — 한 번에 한 묶음만 그린다(bps 와 B/s 와 % 는 단위가 달라 한 차트에 겹치지 않는다 — 이중 축 금지). */
export const NODE_LOAD_GROUPS = Object.freeze({ net: ['in', 'out'], disk: ['din', 'dout', 'busy', 'iops'], cpu: ['cpu'], proto: ['ops', 'lat'],
  // v2.949: 어레이 프런트엔드 단위 묶음(SAN 스토리지 성능 상세 ② · 점검 어레이 측 5항목) — 단위가 섞이므로 화면은 지표 하나씩 그린다.
  fe: ['busy', 'cpu', 'iops', 'lat', 'hbps', 'queue'] });
/** 클러스터 값 — 처리량·ops·IOPS 는 노드 합, CPU·busy·지연은 노드 평균. */
export const CLUSTER_AGG = Object.freeze({ in: 'sum', out: 'sum', din: 'sum', dout: 'sum', cpu: 'avg', ops: 'sum', lat: 'avg', busy: 'avg', iops: 'sum', hbps: 'sum', queue: 'avg' });
/** 5분 표본 — 노드당 클라이언트 상위 N(기본 — 설정값은 폴러가 넘긴다) · 프로토콜 키 상한. */
export const CLIENT_LIMIT_DEF = 10;
export const CLIENT_LIMIT_MAX = 50;
export const PROTO_KEYS_MAX = 12;
/** 스냅샷 계약의 노드 목록 상한(types.js · edgeRecord.NODE_LIST_MAX 와 같은 값). */
export const NODE_LOAD_LIMIT = 64;
export const JOBS_MAX = 8;

const PCT_KEYS = new Set(['cpu', 'busy', 'queue']);
const valueOf = (m, v) => {
  const n = numOrNull(v);
  if (n == null || n < 0) return null;
  if (PCT_KEYS.has(m.key) && n > 100) return null;
  return n;
};
const numMetric = (k, v) => { const n = numOrNull(v); if (n == null || n < 0) return null; if (PCT_KEYS.has(k) && n > 100) return null; return n; };
const strCap = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
/** 프로토콜 이름 규칙(한 벌 — 수집기도 이것을 쓴다): 소문자 · 영숫자만 · 16자 · nfs3/nfs4 → nfs · smb1/2/3·cifs → smb · https → http. */
const PROTO_ALIAS = { nfs3: 'nfs', nfs4: 'nfs', nfsv3: 'nfs', nfsv4: 'nfs', nfs41: 'nfs', smb1: 'smb', smb2: 'smb', smb3: 'smb', cifs: 'smb', https: 'http', lsassin: 'lsass', lsassout: 'lsass' };
export function protoKeyOf(v) {
  const s = String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
  return PROTO_ALIAS[s] || s;
}
const protoKey = protoKeyOf;
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

/* ── v2.932(2차) 5분 표본 ──────────────────────────────────────────────── */
/**
 * 표본 정제(순수 — 엣지가 올린 것도 이것을 거친다): 아는 필드만 · 노드 64 · 클라이언트 노드당 ≤ clientLimit · 프로토콜 ≤ 12 ·
 * 문자열 수치는 수로 · 못 읽은 값은 null(0 이 아니다). ts 는 양의 정수. 모양이 아니면 null.
 */
export function sanitizeNodeLoadSample(raw, { clientLimit = CLIENT_LIMIT_DEF, maxTs = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let ts = numOrNull(raw.ts);
  if (ts == null || !(ts > 0)) return null;
  ts = Math.floor(ts);
  if (maxTs != null && ts > maxTs) ts = maxTs; // 엣지 시각은 수신 시각 이하로(원본은 호출부가 따로 둔다)
  if (!Array.isArray(raw.nodes)) return null;
  const lim = Math.max(1, Math.min(CLIENT_LIMIT_MAX, Math.floor(clientLimit) || CLIENT_LIMIT_DEF));
  const nodes = []; const seen = new Set();
  for (const n of raw.nodes) {
    if (nodes.length >= NODE_LOAD_LIMIT) break;
    if (!n || typeof n !== 'object' || Array.isArray(n)) continue;
    const id = numOrNull(n.id);
    if (id == null || !Number.isSafeInteger(id) || id < 0 || seen.has(id)) continue;
    seen.add(id);
    const o = { id };
    for (const m of NODE_LOAD_METRICS) o[m.key] = numMetric(m.key, n[m.key]);
    const bm = numMetric('busy', n.busyMax); if (bm != null) o.busyMax = bm;
    o.proto = null;
    if (n.proto && typeof n.proto === 'object' && !Array.isArray(n.proto)) {
      const pr = {};
      for (const [k0, v] of Object.entries(n.proto)) {
        const k = protoKey(k0); if (!k || Object.keys(pr).length >= PROTO_KEYS_MAX || !v || typeof v !== 'object') continue;
        pr[k] = { ops: numMetric('ops', v.ops), lat: numMetric('lat', v.lat), in: numMetric('in', v.in), out: numMetric('out', v.out) };
      }
      if (Object.keys(pr).length) o.proto = pr;
    }
    o.clients = [];
    if (Array.isArray(n.clients)) {
      for (const c of n.clients) {
        if (o.clients.length >= lim) break;
        if (!c || typeof c !== 'object') continue;
        const ip = strCap(c.ip, 64).replace(/[^\x21-\x7e]/g, '');
        if (!ip) continue;
        o.clients.push({ ip, name: strCap(c.name, 80), proto: protoKey(c.proto), ops: numMetric('ops', c.ops), in: numMetric('in', c.in), out: numMetric('out', c.out), lat: numMetric('lat', c.lat) });
      }
    }
    nodes.push(o);
  }
  if (!nodes.length) return null;
  const probe = raw.probe && typeof raw.probe === 'object' && !Array.isArray(raw.probe)
    ? Object.fromEntries(Object.entries(raw.probe).filter(([k, v]) => /^[a-zA-Z]{1,24}$/.test(k) && (typeof v === 'string' ? v.length <= 120 : typeof v === 'number' && Number.isFinite(v))).slice(0, 12))
    : null;
  return { ts, nodes, ...(probe ? { probe } : {}) };
}

/** 표본 → 적재 행(순수). 노드 값이 하나도 없고 클라이언트도 없으면 no-load. */
export function sampleRowsOf(deviceId, sample) {
  const id = String(deviceId ?? '');
  if (!id) return { ok: false, reason: 'no-id' };
  const s = sanitizeNodeLoadSample(sample, { clientLimit: CLIENT_LIMIT_MAX });
  if (!s) return { ok: false, reason: 'no-nodes' };
  let any = false;
  const nodes = []; const clients = []; const protos = [];
  for (const n of s.nodes) {
    const row = { id: n.id };
    for (const m of NODE_LOAD_METRICS) { row[m.key] = n[m.key]; if (row[m.key] != null) any = true; }
    nodes.push(row);
    for (const c of n.clients) { clients.push({ node: n.id, ...c }); any = true; }
    if (n.proto) for (const [k, v] of Object.entries(n.proto)) protos.push({ node: n.id, proto: k, ops: v.ops, lat: v.lat });
  }
  if (!any) return { ok: false, reason: 'no-load' };
  return { ok: true, deviceId: id, ts: s.ts, nodes, clients, protos };
}

/* ── v2.949 어레이 프런트엔드 단위 카탈로그(순수) ─────────────────────── */
/** 단위 종류 — fa(PowerMax FE 디렉터) · node(PowerStore 노드) · sp(Unity SP) · port(FC 포트 — 부모 단위 아래). 모르면 ''. */
export const NODE_UNIT_KINDS = Object.freeze(['fa', 'node', 'sp', 'port', '']);
export const NODE_UNIT_NAME_MAX = 60;
/**
 * 단위 이름 → 안정된 정수 id(FNV-1a 32비트의 하위 31비트). 노드 부하 표의 node_id 는 정수라 이름을 따로 둔다(node_unit 표).
 * 같은 이름은 어디서 계산해도 같은 id — 엣지·중앙·데모가 모두 이 함수를 쓴다. 0 은 피한다(아이실론 lnn 과 겹치지 않게 하려는 뜻은 아니다 — 장비가 다르다).
 */
export function unitIdOf(name) {
  const str = String(name ?? '').trim().toUpperCase().replace(/[\s:_.-]+/g, '');
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  const id = h & 0x7fffffff;
  return id === 0 ? 1 : id;
}
/** 이름 정규화 비교 키(SAN 쪽 디렉터 그룹 'FA-1D' · 'Node A' · 'SPA' 와 어레이 API 의 'FA-1D' · 'NodeA' · 'spa' 를 같은 칸에 — 대소문자 · 구분자 무시). */
export const unitMatchKey = (name) => String(name ?? '').trim().toUpperCase().replace(/[\s:_.-]+/g, '');
/**
 * 엣지·수집기가 준 단위 목록 정제 — 아는 필드만 · 상한 64 · id 는 안전한 정수 · 이름 1~60자 · 종류는 목록 안 · parent 는 정수 또는 null.
 * @returns {Array<{id:number, name:string, kind:string, parent:number|null}>}
 */
export function sanitizeNodeUnits(list) {
  if (!Array.isArray(list)) return [];
  const out = []; const seen = new Set();
  for (const u of list) {
    if (out.length >= NODE_LOAD_LIMIT) break;
    if (!u || typeof u !== 'object' || Array.isArray(u)) continue;
    const name = strCap(u.name, NODE_UNIT_NAME_MAX);
    if (!name) continue;
    const idRaw = numOrNull(u.id);
    const id = idRaw != null && Number.isSafeInteger(idRaw) && idRaw >= 0 ? idRaw : unitIdOf(name);
    if (seen.has(id)) continue;
    seen.add(id);
    const kind = NODE_UNIT_KINDS.includes(u.kind) ? u.kind : '';
    const parent = numOrNull(u.parent);
    out.push({ id, name, kind, parent: parent != null && Number.isSafeInteger(parent) && parent >= 0 ? parent : null });
  }
  return out;
}

/* ── 재배치 판정(순수) ─────────────────────────────────────────────────── */
export const FIXED_SHARE_DEF = 0.9;   // '고정 클라이언트' — 창의 ops 중 한 노드 비중
export const SKEW_FACTOR_DEF = 1.5;   // '쏠린 노드' — 노드 ops 합이 노드 평균의 배수
/**
 * 클라이언트 × 노드 행렬 — rows: [{ client, name?, proto?, node, ops }](창 합). 클라이언트는 ops 합 내림차순, 노드 비중 %(0~100).
 * @returns {{ clients:Array<{client,name,proto,total,nodes:Object<number,number>,share:Object<number,number>,top:number|null,topShare:number,fixed:boolean}>, nodeTotals:Object<number,number> }}
 */
export function clientNodeMatrix(rows, { fixedShare = FIXED_SHARE_DEF, limit = 50 } = {}) {
  const by = new Map(); const nodeTotals = {};
  for (const r of rows || []) {
    const client = strCap(r?.client, 64); const node = numOrNull(r?.node); const ops = numOrNull(r?.ops);
    if (!client || node == null || ops == null || ops < 0) continue;
    const cur = by.get(client) || { client, name: strCap(r.name, 80), proto: protoKey(r.proto), total: 0, nodes: {} };
    if (!cur.name && r?.name) cur.name = strCap(r.name, 80);
    if (!cur.proto && r?.proto) cur.proto = protoKey(r.proto);
    cur.nodes[node] = (cur.nodes[node] || 0) + ops; cur.total += ops;
    nodeTotals[node] = (nodeTotals[node] || 0) + ops;
    by.set(client, cur);
  }
  const clients = [...by.values()].sort((a, b) => b.total - a.total || a.client.localeCompare(b.client)).slice(0, Math.max(1, limit)).map((c) => {
    const share = {}; let top = null; let topShare = 0;
    for (const [n, v] of Object.entries(c.nodes)) { const p = c.total > 0 ? v / c.total : 0; share[n] = Math.round(p * 1000) / 10; if (p > topShare) { topShare = p; top = Number(n); } }
    return { ...c, share, top, topShare: Math.round(topShare * 1000) / 10, fixed: c.total > 0 && topShare >= fixedShare };
  });
  return { clients, nodeTotals };
}
/** 노드 쏠림 — 평균 대비 배수(소수 1자리) · skew = 배수 ≥ factor. 노드 목록은 표본의 노드(ops 0 도 포함). */
export function nodeSkew(nodeTotals, nodeIds, { factor = SKEW_FACTOR_DEF } = {}) {
  const ids = [...new Set([...(nodeIds || []), ...Object.keys(nodeTotals || {}).map(Number)])].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const totals = ids.map((n) => numOrNull(nodeTotals?.[n]) ?? 0);
  const mean = ids.length ? totals.reduce((a, b) => a + b, 0) / ids.length : 0;
  return { mean, factor, nodes: ids.map((n, i) => ({ id: n, total: totals[i], ratio: mean > 0 ? Math.round((totals[i] / mean) * 10) / 10 : null, skew: mean > 0 && totals[i] >= mean * factor })) };
}
/**
 * 재배치 후보(탐욕) — 쏠린 노드의 '고정' 클라이언트를 ops 큰 순으로, 그때마다 가장 한가한 노드에 배정. 쏠린 노드가 평균 아래로 내려가면 멈춘다.
 * 계산일 뿐이다(포탈은 바꾸지 않는다) — 응답에 그 사실을 적는 것은 호출부.
 * @returns {Array<{client,name,proto,from,to,ops,fromAfter,toAfter}>}
 */
export function rebalanceCandidates(matrix, skew, { max = 10 } = {}) {
  const load = {}; for (const n of skew.nodes) load[n.id] = n.total;
  const out = [];
  for (const sk of skew.nodes.filter((n) => n.skew).sort((a, b) => b.total - a.total)) {
    const fixed = matrix.clients.filter((c) => c.fixed && c.top === sk.id).sort((a, b) => b.total - a.total);
    for (const c of fixed) {
      if (out.length >= max) break;
      if (load[sk.id] <= skew.mean) break;
      const idle = skew.nodes.map((n) => n.id).filter((id) => id !== sk.id).sort((a, b) => load[a] - load[b])[0];
      if (idle == null) break;
      const amt = c.nodes[sk.id] || 0;           // 옮기는 양 = 그 노드에서 낸 ops(다른 노드 몫은 그대로)
      if (!(amt > 0)) continue;
      if (Math.max(load[sk.id] - amt, load[idle] + amt) >= load[sk.id]) break; // 옮겨도 가장 바쁜 값이 안 내려가면 의미 없다
      load[sk.id] -= amt; load[idle] += amt;
      out.push({ client: c.client, name: c.name, proto: c.proto, from: sk.id, to: idle, ops: Math.round(amt), fromAfter: Math.round(load[sk.id]), toAfter: Math.round(load[idle]) });
    }
  }
  return out;
}
