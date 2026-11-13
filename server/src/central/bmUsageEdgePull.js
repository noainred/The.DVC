/**
 * central/bmUsageEdgePull.js — 중앙이 엣지에서 베어메탈 사용률을 **당긴다**(v2.554).
 *
 * 사용자 지시: "엣지에서 종합하고 중앙으로 전달은 **중앙에서 조회할때만** 한다."
 * 즉 상시 push 가 없다 — 사람이 화면에서 누를 때만 나간다(v2.549 엣지 로그와 같은 구조).
 *
 * ⚠ **대상·토큰은 수집 서버 등록부**다 — `edgeLogPull.js findCollector` 를 **재사용**한다
 *   (등록부 조회를 복제하면 대소문자 규약·비활성 판정이 갈라진다. CLAUDE.md '코어는 하나다').
 * ⚠ **인메모리다** — 진실의 원천은 각 엣지의 DB 이고 이것은 '방금 본 값' 이다. 디스크에 쓰면
 *   재기동 뒤 낡은 값을 '지금 값' 인 척 보여준다(v2.548 `central/partFaultEdge.js` 와 같은 판단).
 * ⚠ **저장 키는 중앙이 아는 이름**(등록부 `name`)이다 — 응답 본문의 `node.agent` 를 믿지 않는다
 *   (v2.548 F5). 둘이 다르면 그 사실 자체가 진단이므로 화면이 나란히 보여 준다.
 * ⚠ 실패를 '모름' 으로 뭉개지 않는다 — `kind` 로 원인을 나눈다(조치가 전부 다르다).
 * v2.613(CONTRACT2613-01 · EDGE2613-02): 사다리(등록부 → fetch → 401/403 → 404 → http → bad-body)는 `central/edgePull.js
 *   pullFromEdge` **하나**다 — 여기는 시한 env·저장(`putEdgeBmUsage`)·정제만 갖는다. kind 문자열·응답 모양은 그대로.
 */
import { pullFromEdge } from './edgePull.js'; // v2.613 CONTRACT2613-01·EDGE2613-02: 당김 사다리는 하나(등록부 → fetch → 상태코드 → 본문)
import { strOf } from '../util/coercionTrap.js'; // v2.604 CEN2604-03: 엣지 본문의 글자 필드는 타입부터 좁힌다
import { numOrNull } from '../util/numOrNull.js';
import { capStr } from '../util/capStr.js';
import { sanitizePerfFields } from './bmPerfSanitize.js'; // v2.919: 리눅스 성능 항목 화이트리스트
import { PERF_COL_NAMES, PEAK_SQL_COLS, PEAK_SRC, SRC_CM_RE } from '../bmusage/perfCols.js'; // v2.993: SRC_CM_RE 지표별 출처 두 글자 꼴
import { clampEdgeTs } from '../util/clampEdgeTs.js'; // v2.932(점검 A1-06): 피크 시각도 수신 시각으로 자른다
/**
 * v2.919 — 행의 **새** 수치 열(리눅스 성능 열 + 두 경로 읽은 시각)은 수로 좁힌다('1.5' → 1.5 · 못 읽으면 null).
 * ⚠ 기존 9개 열은 예전 계약(원시값 그대로 — audit2604a CEN2604-03 이 고정)을 바꾸지 않는다.
 */
const ROW_NUM_COLS = Object.freeze([...PERF_COL_NAMES, 'os_at', 'idrac_at']);
/*
 * v2.932(점검 A1-06 · E1-07): v2.922 가 최신값 행에 피크 열(<열>_peak · _peak_at)과 메타(peak_src · peak_window_s · peak_n · dev_over)를 더해
 *   행이 65칸이 됐는데, 행도 대상과 같은 shallow(FIELD_MAX 64)를 거쳐 마지막 열 dev_over 가 **조용히** 빠졌다(sanitizeDropped 에도 안 셈).
 *   행은 열 이름이 정해져 있으므로(bmusage/db.js PERF_TABLE_COLS.usage_latest) 상한을 행 전용으로 넉넉히 두고, 넘쳐 뺀 칸은 센다.
 *   피크 값 · 창 · 개수 · dev_over 는 수로(문자열 수치 → 수 · 못 읽으면 null), *_peak_at 은 수신 시각으로 자르고(원본은 peakAtRaw),
 *   peak_src 는 아는 값만(PEAK_SRC + 'mixed'). 열 목록과 실제 표의 대조는 시험(sweep2932Bm)이 PRAGMA 로 고정한다.
 */
const ROW_FIELD_MAX = 192;
const PEAK_NUM_COLS = Object.freeze([...PEAK_SQL_COLS.map(([c]) => c).filter((c) => !c.endsWith('_peak_at')), 'peak_window_s', 'peak_n', 'dev_over']);
const PEAK_AT_COLS = Object.freeze(PEAK_SQL_COLS.map(([c]) => c).filter((c) => c.endsWith('_peak_at')));
const PEAK_SRC_SET = new Set([...PEAK_SRC, 'mixed']);

/** 이 엔드포인트를 내주기 시작한 최소 엣지 버전 — 그 아래는 경로가 없다. */
export const MIN_EDGE_VERSION = '2.554.0';
const TIMEOUT_MS = Math.max(5_000, Number(process.env.BMUSAGE_PULL_TIMEOUT_MS) || 20_000);
/** 보관분이 이보다 오래되면 화면이 '낡았다' 고 말한다(값을 지우지는 않는다). */
export const STALE_MS = Math.max(60_000, Number(process.env.BMUSAGE_PULL_STALE_MS) || 30 * 60_000);

const t = (v) => String(v ?? '').trim();
/** agent(소문자) → { at, ok, ms, snap|null, kind, reason } */
const _store = new Map();

export function putEdgeBmUsage(agent, rec) {
  const key = t(agent).toLowerCase();
  if (!key) return null;
  const prev = _store.get(key) || null;
  const next = {
    agent: t(agent),
    at: Date.now(),
    ok: !!rec.ok,
    ms: Number(rec.ms) || 0,
    kind: rec.kind || '',
    reason: rec.reason || '',
    /*
     * ⚠ **실패는 직전 값을 지우지 않는다**(v2.550.3 H5 규약): 통째로 덮으면 한 번 실패한 뒤
     *   화면이 '보관분 없음' 이 되어 방금까지 보던 값이 사라진다. 실패는 `lastAttempt` 로 남긴다.
     */
    // v2.604(감사 CEN2604-03): 엣지 본문을 **아는 필드만** 담는다 — 예전에는 원문 그대로라 key 가 객체인 대상 하나로
    //   /tools/bm-usage/edges 가 재시작까지 500(String(obj) 가 던졌다), node.agent 가 객체면 화면이 React #31 로 죽었다.
    snap: rec.ok && rec.snap ? sanitizeBmUsageSnap(rec.snap) : (prev?.snap || null),
    snapAt: rec.ok && rec.snap ? Date.now() : (prev?.snapAt || null),
    lastAttempt: { at: Date.now(), ok: !!rec.ok, kind: rec.kind || '', reason: rec.reason || '', ms: Number(rec.ms) || 0 },
  };
  _store.set(key, next);
  return next;
}

/*
 * ── 엣지 사용률 봉투 정제(v2.604 CEN2604-03) ─────────────────────────────────────
 * 봉투 모양은 `bmusage/edgePull.js buildBmUsageEnvelope` 가 정한다. 그 필드만, 그 타입만 담는다.
 *  · 글자 필드는 strOf(객체·배열이면 '') · 수치는 numOrNull(못 읽으면 null — 0 으로 두지 않는다).
 *  · targets·rows·authStops 는 **원소가 객체일 때만**, 상한(엣지 봉투 상한 MAX_LIMIT 2,000)까지. 뺀 개수는 `sanitizeDropped`.
 *  · 대상 원소의 나머지 필드는 얕은 복사(원시값·원시값 배열·한 단계 객체)만 — 대상 모양은 버전마다 필드가 늘어서
 *    이름 목록으로 묶으면 새 필드가 조용히 사라진다. 대신 **깊이·개수·길이**를 묶는다.
 */
const SNAP_LIST_MAX = 2_000;
const FIELD_MAX = 64;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
function prim(v) {
  if (typeof v === 'string') return capStr(v, 512); // v2.607(TIM2607-01)
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean' || v === null) return v;
  return undefined;
}
function shallow(o, depth = 0, { max = FIELD_MAX, over = null } = {}) {
  const out = {};
  let n = 0;
  for (const k of Object.keys(o)) {
    if (BAD_KEYS.has(k)) continue;
    if (n >= max) { if (over) over.n += 1; continue; }
    const v = o[k];
    let c = prim(v);
    if (c === undefined && Array.isArray(v)) c = v.slice(0, FIELD_MAX).map(prim).filter((x) => x !== undefined);
    else if (c === undefined && isObj(v) && depth < 1) c = shallow(v, depth + 1);
    if (c === undefined) continue;
    out[k] = c; n += 1;
  }
  return out;
}
function objList(v, fn) {
  const arr = Array.isArray(v) ? v : [];
  const kept = arr.slice(0, SNAP_LIST_MAX).filter(isObj).map(fn);
  return { list: kept, dropped: arr.length - kept.length };
}
function numMap(v) {
  if (!isObj(v)) return {};
  const out = {};
  for (const k of Object.keys(v).slice(0, 256)) {
    if (BAD_KEYS.has(k)) continue;
    const x = v[k];
    if (isObj(x)) out[k] = numMap(x); // counts.byReason 처럼 한 단계 중첩
    else { const n = numOrNull(x); if (n != null) out[k] = n; }
  }
  return out;
}
export function sanitizeBmUsageSnap(snap, { receivedAt = Date.now() } = {}) {
  if (!isObj(snap)) return null;
  const node = isObj(snap.node) ? snap.node : {};
  const st = isObj(snap.settings) ? snap.settings : null;
  const targets = objList(snap.targets, (x) => ({ ...shallow(x), key: strOf(x.key, 256), name: strOf(x.name, 256), vcenterId: strOf(x.vcenterId, 128) }));
  // v2.919: 행의 JSON 문자열 열(detail_json·tuning_json)은 받지 않는다 — 같은 내용은 perf 에 객체로 오고 그쪽을 화이트리스트로 정제한다.
  //   새 지표 열(성능 열 · 시각)은 **수로** 좁힌다(문자열 수치 '1.5' → 1.5 · 못 읽으면 null — 0 으로 두지 않는다).
  const rowOver = { n: 0 };
  const rows = objList(snap.rows, (r) => {
    const { detail_json: _d, tuning_json: _t, ...rest } = shallow(r, 0, { max: ROW_FIELD_MAX, over: rowOver });
    for (const c of ROW_NUM_COLS) if (Object.hasOwn(rest, c)) rest[c] = numOrNull(r[c]);
    for (const c of PEAK_NUM_COLS) if (Object.hasOwn(rest, c)) rest[c] = numOrNull(r[c]);
    let raw = null;
    for (const c of PEAK_AT_COLS) {
      if (!Object.hasOwn(rest, c)) continue;
      const v = numOrNull(r[c]); const cut = clampEdgeTs(v, receivedAt);
      if (v != null && cut !== v) (raw ||= {})[c] = v;
      rest[c] = cut;
    }
    if (Object.hasOwn(rest, 'peak_src')) rest.peak_src = PEAK_SRC_SET.has(rest.peak_src) ? rest.peak_src : null;
    // v2.993(출처 색): 지표별 출처 두 글자 — 꼴(o · i · e · -)만 받는다(그 밖은 null = 모름 · 화면은 행 출처로 돌아간다).
    if (Object.hasOwn(rest, 'src_cm')) rest.src_cm = typeof rest.src_cm === 'string' && SRC_CM_RE.test(rest.src_cm) ? rest.src_cm : null;
    return { ...rest, ...(raw ? { peakAtRaw: raw } : {}), key: strOf(r.key, 256), name: strOf(r.name, 256) };
  });
  const pf = sanitizePerfFields(snap, receivedAt);   // v2.919(D3): 엣지 시각은 수신 시각으로 자른다
  const stops = objList(snap.authStops, (a) => ({ key: strOf(a.key, 256), path: strOf(a.path, 32), attempts: numOrNull(a.attempts), since: numOrNull(a.since), reason: strOf(a.reason, 300) }));
  const dropped = targets.dropped + rows.dropped + stops.dropped + pf.dropped + rowOver.n;   // v2.932(A1-06): 행 칸 상한으로 뺀 칸도 센다
  return {
    node: { agent: strOf(node.agent, 128), version: strOf(node.version, 32), role: strOf(node.role, 16), datacenter: strOf(node.datacenter, 128) },
    at: numOrNull(snap.at),
    enabled: snap.enabled === true,
    settings: st ? {
      intervalMs: numOrNull(st.intervalMs), osSsh: st.osSsh === true, idracTelemetry: st.idracTelemetry === true,
      idracFullTelemetry: st.idracFullTelemetry === true, includeUnassigned: st.includeUnassigned === true,
      includeVirtualization: st.includeVirtualization === true,
      corps: (Array.isArray(st.corps) ? st.corps : []).slice(0, 1_000).map((c) => strOf(c, 128)).filter(Boolean),
      enterpriseEnabled: st.enterpriseEnabled === true, enterpriseAck: st.enterpriseAck === true,
      enterpriseMode: strOf(st.enterpriseMode, 32), enterpriseActive: st.enterpriseActive === true,
    } : null,
    targets: targets.list,
    truncated: numOrNull(snap.truncated) ?? 0,
    rows: rows.list,
    counts: numMap(snap.counts),
    skippedCounts: numMap(snap.skippedCounts),
    authStops: stops.list,
    status: isObj(snap.status) ? shallow(snap.status) : null,
    ...pf.fields,
    ...(dropped ? { sanitizeDropped: dropped } : {}),
  };
}

export function getEdgeBmUsage(agent) { return _store.get(t(agent).toLowerCase()) || null; }
/**
 * v2.927(반증 F7): 보관분이 말한 그 노드의 역할 — 'edge'(CENTRAL_URL 이 있다 = 배포 인출 워커가 돈다) · 'central'(중앙·단독 — 배포를 받지 않는다)
 *   · 'unknown'(보관분 없음 · 역할 없음). '중앙에서 켜기' 는 'edge' 에만 제공한다(화면 버튼과 PUT 이 이 함수 하나로 판정한다).
 *   값은 엣지 export(bmusage/edgePull.js node.role)를 중앙 정제(sanitizeBmUsageSnap)가 16자로 자른 글자다.
 */
export function edgeRoleOf(rec) {
  const r = String(rec?.snap?.node?.role || '').trim().toLowerCase();
  return r === 'edge' ? 'edge' : (r === 'central' ? 'central' : 'unknown');
}
export function listEdgeBmUsage() { return [..._store.values()]; }
export function _resetForTest() { _store.clear(); }

/**
 * 한 엣지에서 당긴다. **저장까지** 하고 결과를 돌려준다.
 * @returns {{ok:boolean, kind?:string, reason?:string, ms:number, rec?:object}}
 */
export async function pullBmUsage(agent, { limit = 0 } = {}) {
  const qs = Number(limit) > 0 ? `?limit=${Math.round(Number(limit))}` : '';
  const r = await pullFromEdge(agent, `/api/collector/bm-usage${qs}`, {
    timeoutMs: TIMEOUT_MS, retries: 1, minVersion: MIN_EDGE_VERSION, what: '사용률을 읽을', label: '엣지 사용률 응답',
    bodyOk: (b) => isObj(b) && b.ok !== false && isObj(b.node),   // 봉투 모양(이 경로만 node 가 있다 — 명시: 경로마다 모양이 다르다 · 반증 F2)
  });
  if (!r.ok) {
    if (!r.fetched) return { ok: false, kind: r.kind, reason: r.reason, ms: r.ms }; // 등록부 단계 — 보관소에 남기지 않는다
    const rec = putEdgeBmUsage(r.col.name || agent, { ok: false, kind: r.kind, reason: r.reason, ms: r.ms });
    return { ok: false, kind: r.kind, reason: r.reason, ms: r.ms, rec };
  }
  const rec = putEdgeBmUsage(r.col.name || agent, { ok: true, ms: r.ms, snap: r.body });
  // v2.929(5단계): 엣지 규칙이 이슈를 원한 발송 건(pending-central)을 중앙 문지기로 판단해 이슈로(같은 건은 두 번 만들지 않는다). 실패해도 당김은 성공이다.
  try { if (rec?.snap) await (await import('./bmPerfOpsPull.js')).ingestEdgeAlertIssues(r.col.name || agent, rec.snap); } catch { /* 이슈 저장소 오류는 화면 당김을 막지 않는다 */ }
  return { ok: true, ms: r.ms, rec };
}

/* ════════════════════════════════════════════════════════════════════════════
 * v2.922(3a) — 엣지 대행 추이·장치 목록. **보관하지 않는다**(조회할 때만 당긴다 — 중앙은 엣지 이력을 복제 적재하지 않는다).
 *   응답 상한은 pullFromEdge 의 EDGE_RESPONSE_MAX_BYTES(크기 상한 읽기) · 점·결측·장치 수 상한 · 아는 필드만 · 글자 길이 상한.
 *   잘랐으면 `sanitizeTruncated` 로 밝힌다(조용한 상한 금지).
 * ════════════════════════════════════════════════════════════════════════════ */
export const TREND_PULL_MAX_POINTS = 6_000;
const TREND_GAPS_MAX = 2_000;
const DEV_MAX = 512;
const RES_SET = new Set(['5m', '1h', '1d']);
export function sanitizeTrendBody(b) {
  if (!isObj(b)) return null;
  let cut = 0;
  const pts = Array.isArray(b.points) ? b.points : [];
  if (pts.length > TREND_PULL_MAX_POINTS) cut += pts.length - TREND_PULL_MAX_POINTS;
  const points = pts.slice(-TREND_PULL_MAX_POINTS).filter(isObj).map((p) => ({ t: numOrNull(p.t), avg: numOrNull(p.avg), max: numOrNull(p.max), peak: numOrNull(p.peak), peakAt: numOrNull(p.peakAt), n: numOrNull(p.n) })).filter((p) => p.t != null);
  const gl = Array.isArray(b.gaps) ? b.gaps : [];
  if (gl.length > TREND_GAPS_MAX) cut += gl.length - TREND_GAPS_MAX;
  const gaps = gl.slice(0, TREND_GAPS_MAX).filter(isObj).map((g) => ({ from: numOrNull(g.from), to: numOrNull(g.to), reason: strOf(g.reason, 32) })).filter((g) => g.from != null && g.to != null);
  const bl = isObj(b.baseline) ? { warn: numOrNull(b.baseline.warn), bad: numOrNull(b.baseline.bad), key: strOf(b.baseline.key, 32) } : null;
  return {
    ok: b.ok === true, kind: strOf(b.kind, 16), metric: strOf(b.metric, 64), dev: b.dev == null ? null : strOf(b.dev, 256),
    from: numOrNull(b.from), to: numOrNull(b.to), res: RES_SET.has(b.res) ? b.res : null, resReason: strOf(b.resReason, 32), stepMs: numOrNull(b.stepMs),
    points, gaps, baseline: bl,
    peakSrc: (Array.isArray(b.peakSrc) ? b.peakSrc : []).slice(0, 8).map((x) => strOf(x, 16)).filter(Boolean),
    ...(numOrNull(b.truncated) ? { truncated: numOrNull(b.truncated) } : {}),
    ...(b.truncatedRows === true ? { truncatedRows: true } : {}),
    ...(Array.isArray(b.missingPeriods) ? { missingPeriods: b.missingPeriods.slice(0, 16).filter(isObj).map((m) => ({ period: strOf(m.period, 16), reason: strOf(m.reason, 200) })) } : {}),
    ...(numOrNull(b.filesCapped) ? { filesCapped: numOrNull(b.filesCapped) } : {}),
    ...(typeof b.migration === 'string' ? { migration: strOf(b.migration, 16) } : {}),
    ...(cut ? { sanitizeTruncated: cut } : {}),
  };
}
export function sanitizeDevicesBody(b) {
  if (!isObj(b)) return null;
  const devs = isObj(b.devices) ? b.devices : {};
  let cut = 0;
  const list = (k) => {
    const a = Array.isArray(devs[k]) ? devs[k] : [];
    if (a.length > DEV_MAX) cut += a.length - DEV_MAX;
    return a.slice(0, DEV_MAX).filter(isObj).map((d) => ({ dev: strOf(d.dev, 256), ord: numOrNull(d.ord), color: numOrNull(d.color), firstTs: numOrNull(d.firstTs), lastTs: numOrNull(d.lastTs), ...(d.info ? { info: strOf(d.info, 32) } : {}) })).filter((d) => d.dev);
  };
  return { ok: b.ok === true, devices: { disk: list('disk'), nic: list('nic'), mount: list('mount') }, over: numOrNull(b.over), peakSrc: b.peakSrc == null ? null : strOf(b.peakSrc, 16), peakWindowS: numOrNull(b.peakWindowS), ...(cut ? { sanitizeTruncated: cut } : {}) };
}
export function sanitizeNicsBody(b) {
  if (!isObj(b)) return null;
  const a = Array.isArray(b.nics) ? b.nics : [];
  return { ok: b.ok === true, nics: a.slice(0, DEV_MAX).filter(isObj).map((x) => ({ nic: strOf(x.nic, 64), at: numOrNull(x.at), spanMs: numOrNull(x.spanMs), rxBps: numOrNull(x.rxBps), txBps: numOrNull(x.txBps),
    dropDelta: numOrNull(x.dropDelta), errDelta: numOrNull(x.errDelta), oper: x.oper == null ? null : strOf(x.oper, 16), speedBps: numOrNull(x.speedBps) })).filter((x) => x.nic),
    ...(a.length > DEV_MAX ? { sanitizeTruncated: a.length - DEV_MAX } : {}) };
}
/**
 * 응답 모양 판정(경로마다 — 6단계 반증 F2 정정). pullFromEdge 의 기본 판정은 봉투(`/bm-usage`)의 `{ok, node}` 모양이라, node 가 없는 추이 · 장치 · NIC 응답은
 *   v2.922(3a) 게시 이후 **성공 응답이 전부 bad-body** 로 버려졌다(엣지 위임 서버의 추이 탭 · 목표선이 늘 ‘읽지 못함’). 테스트가 pullBmTrend 를 의존성 주입으로 바꿔 끼워 실제 함수를 부르지 않아 놓쳤다.
 *   회귀: server/test/bmEdgeRoundTrip.test.js(실제 collector 라우터 왕복).
 */
export const TREND_BODY_OK = Object.freeze({
  history: (b) => isObj(b) && b.ok === true && Array.isArray(b.points),
  devices: (b) => isObj(b) && b.ok === true && isObj(b.devices),
  nics: (b) => isObj(b) && b.ok === true && Array.isArray(b.nics),
});
/** 한 엣지에서 추이(또는 장치 목록)를 당긴다 — 저장하지 않는다. */
export async function pullBmTrend(agent, { mode = 'history', key = '', query = {} } = {}) {
  const qs = new URLSearchParams();
  qs.set('key', String(key));
  if (mode === 'history') for (const k of ['metric', 'kind', 'dev', 'res', 'from', 'to']) if (query?.[k] != null && query[k] !== '') qs.set(k, capStr(String(query[k]), 256));
  const r = await pullFromEdge(agent, `/api/collector/bm-usage/${mode === 'devices' ? 'devices' : mode === 'nics' ? 'nics' : 'trend'}?${qs.toString()}`, {
    timeoutMs: TIMEOUT_MS, retries: 1, minVersion: TREND_MIN_EDGE_VERSION, what: '추이를 읽을', label: '엣지 추이 응답',
    bodyOk: TREND_BODY_OK[mode === 'devices' ? 'devices' : mode === 'nics' ? 'nics' : 'history'],
  });
  if (!r.ok) return { ok: false, kind: r.kind, reason: r.reason, ms: r.ms };
  const body = mode === 'devices' ? sanitizeDevicesBody(r.body) : mode === 'nics' ? sanitizeNicsBody(r.body) : sanitizeTrendBody(r.body);
  if (!body) return { ok: false, kind: 'bad-body', reason: '엣지 추이 응답 형식이 다릅니다.', ms: r.ms };
  return { ok: true, ms: r.ms, body };
}
/** 엣지 추이 엔드포인트를 내주기 시작한 버전(3a). */
export const TREND_MIN_EDGE_VERSION = '2.922.0';

/* ════════════════════════════════════════════════════════════════════════════
 * v2.923(4단계) — 진단 스냅샷 엣지 대행. 실행은 그 서버를 수집하는 엣지가 하고(SSH 1회 · 읽기 전용 · 상수 명령 · 7일 보관),
 *   중앙은 결과만 받는다(저장하지 않는다). POST 는 재전송하지 않는다(retries 0 — 엣지 동작을 두 번 시키지 않게 · v2.612 EDGE2612-01).
 *   엣지 응답은 아는 필드만 · 상한(sanitizeSnapshotBody). 사유 · 실행자는 엣지 보관 행과 양쪽 감사 로그에 남는다.
 * ════════════════════════════════════════════════════════════════════════════ */
// v2.933 정정: 4단계는 번호 충돌로 2.926.0 으로 게시됐다 — 2.923~2.925 는 다른 작업의 릴리스라 스냅샷 대행 라우트가 없다(예정 번호 2.923.0 이 남아 그 엣지에 요청을 보내 404 를 받았다).
export const SNAPSHOT_MIN_EDGE_VERSION = '2.926.0';
/** 엣지 시한(연결 15초 + 명령 30초 + 여유) — 엣지 세션 시한(50초)보다 길게. */
export const SNAPSHOT_PULL_TIMEOUT_MS = 75_000;
const SNAP_STATES = ['ok', 'perm', 'partial', 'absent', 'missing'];
const SNAP_TRIM_KEYS = ['dmesg', 'idrac', 'ss', 'cpuTop', 'memTop', 'ioTop', 'error'];   // snapshot/command.js fitSnapshotResult 가 덜어 내는 칸
const procList = (v, max) => (Array.isArray(v) ? v.slice(0, max).filter(isObj).map((p) => ({ pid: numOrNull(p.pid), user: strOf(p.user, 32), cpuPct: numOrNull(p.cpuPct), rssKb: numOrNull(p.rssKb), name: strOf(p.name, 32) })) : []);
/** 스냅샷 결과 본문 정제(엣지 → 중앙 · 아는 필드만). */
export function sanitizeSnapshotResult(r) {
  if (!isObj(r)) return null;
  const st = isObj(r.states) ? r.states : {};
  const idr = isObj(r.idrac) ? r.idrac : null;
  return {
    v: numOrNull(r.v),
    cpuTop: procList(r.cpuTop, 30), memTop: procList(r.memTop, 30),
    ioTop: Array.isArray(r.ioTop) ? r.ioTop.slice(0, 30).filter(isObj).map((x) => ({ pid: numOrNull(x.pid), name: strOf(x.name, 32), readBps: numOrNull(x.readBps), writeBps: numOrNull(x.writeBps) })) : [],
    pids: numOrNull(r.pids), ioReadable: numOrNull(r.ioReadable), ioSpanS: numOrNull(r.ioSpanS),
    ss: (Array.isArray(r.ss) ? r.ss : []).slice(0, 20).map((x) => strOf(x, 200)).filter(Boolean),
    ssTcp: isObj(r.ssTcp) ? { total: numOrNull(r.ssTcp.total), estab: numOrNull(r.ssTcp.estab), timewait: numOrNull(r.ssTcp.timewait), orphaned: numOrNull(r.ssTcp.orphaned) } : null,
    dmesg: (Array.isArray(r.dmesg) ? r.dmesg : []).slice(-200).map((x) => strOf(x, 300)),
    dmesgTotal: numOrNull(r.dmesgTotal),
    states: Object.fromEntries(['cpu', 'mem', 'io', 'ss', 'dmesg'].map((k) => [k, typeof st[k] === 'string' && SNAP_STATES.includes(st[k]) ? st[k] : 'missing'])),
    truncated: r.truncated === true,
    idrac: idr ? {
      events: Array.isArray(idr.events) ? idr.events.slice(0, 5).filter(isObj).map((e) => ({ severity: strOf(e.severity, 16), at: strOf(e.at, 40), message: strOf(e.message, 200) })) : null,
      eventsAt: numOrNull(idr.eventsAt),
      temps: Array.isArray(idr.temps) ? idr.temps.slice(0, 12).filter(isObj).map((x) => ({ name: strOf(x.name, 48), c: numOrNull(x.c) })) : null,
      sensorAt: numOrNull(idr.sensorAt), cpuPct: numOrNull(idr.cpuPct), powerW: numOrNull(idr.powerW), powerAt: numOrNull(idr.powerAt),
    } : null,
    ...(r.error ? { error: strOf(r.error, 300) } : {}),
    // 반증 R4: 보관 상한에 맞춰 덜어 낸 칸(아는 이름만) · 덜어 낸 커널 로그 줄 수.
    ...(Array.isArray(r.trimmed) ? { trimmed: r.trimmed.filter((k) => SNAP_TRIM_KEYS.includes(k)).slice(0, 8) } : {}),
    ...(numOrNull(r.dmesgDropped) != null ? { dmesgDropped: numOrNull(r.dmesgDropped) } : {}),
    ...(isObj(r.authStoppedBefore) ? { authStoppedBefore: { since: numOrNull(r.authStoppedBefore.since), attempts: numOrNull(r.authStoppedBefore.attempts) } } : {}),
  };
}
const SNAP_CODE_SET = new Set(['ok', 'bad-reason', 'not-found', 'no-os-path', 'busy', 'daily-cap', 'store-unavailable', 'ssh-error', 'auth', 'host-key', 'timeout', 'not-linux']);
const snapMeta = (s) => ({ id: strOf(s.id, 40), key: strOf(s.key, 256), at: numOrNull(s.at), by: strOf(s.by, 64), reason: strOf(s.reason, 300), ok: s.ok === true,
  code: SNAP_CODE_SET.has(s.code) ? s.code : 'ssh-error', ms: numOrNull(s.ms) });
export function sanitizeSnapshotBody(b) {
  if (!isObj(b)) return null;
  const code = SNAP_CODE_SET.has(b.code) ? b.code : (b.ok === true ? 'ok' : 'ssh-error');
  return {
    ok: b.ok === true, code, ...(b.reason != null ? { reason: strOf(b.reason, 300) } : {}),
    ...(b.id != null ? { id: strOf(b.id, 40) } : {}), at: numOrNull(b.at), ms: numOrNull(b.ms), used: numOrNull(b.used), max: numOrNull(b.max), stored: b.stored === true,
    ...(isObj(b.result) ? { result: sanitizeSnapshotResult(b.result) } : {}),
    ...(Array.isArray(b.snapshots) ? { snapshots: b.snapshots.slice(0, 200).filter(isObj).map(snapMeta) } : {}),
    ...(isObj(b.snapshot) ? { snapshot: { ...snapMeta(b.snapshot), result: sanitizeSnapshotResult(b.snapshot.result) } } : {}),
    ...(numOrNull(b.keepDays) != null ? { keepDays: numOrNull(b.keepDays) } : {}),
    ...(b.running === true ? { running: true } : {}),
  };
}
const snapBodyOk = (b) => isObj(b) && typeof b.code === 'string';
/** 엣지에 스냅샷 실행을 맡긴다(한 번 — 재전송 없음). */
export async function runEdgeSnapshot(agent, { key, reason, by } = {}) {
  const r = await pullFromEdge(agent, '/api/collector/bm-usage/snapshot', {
    method: 'POST', jsonBody: { key: capStr(String(key), 256), reason: capStr(String(reason), 300), by: capStr(String(by || ''), 64) }, retries: 0, timeoutMs: SNAPSHOT_PULL_TIMEOUT_MS,
    minVersion: SNAPSHOT_MIN_EDGE_VERSION, what: '진단 스냅샷을 실행할', label: '엣지 스냅샷 응답', bodyOk: snapBodyOk, missing401: true,
  });
  if (!r.ok) return { ok: false, code: 'edge', kind: r.kind, reason: r.reason, ms: r.ms };
  const body = sanitizeSnapshotBody(r.body);
  return body ? { ...body, via: 'edge', agent } : { ok: false, code: 'edge', kind: 'bad-body', reason: '엣지 스냅샷 응답 형식이 다릅니다.' };
}
/** 엣지 보관 목록 · 하나(GET — 재시도 1). */
export async function pullEdgeSnapshots(agent, { key, id = '' } = {}) {
  const qs = new URLSearchParams({ key: String(key) });
  if (id) qs.set('id', String(id));
  const r = await pullFromEdge(agent, `/api/collector/bm-usage/${id ? 'snapshot' : 'snapshots'}?${qs.toString()}`, {
    timeoutMs: TIMEOUT_MS, retries: 1, minVersion: SNAPSHOT_MIN_EDGE_VERSION, what: '진단 스냅샷을 읽을', label: '엣지 스냅샷 응답', bodyOk: snapBodyOk, missing401: true,
  });
  if (!r.ok) return { ok: false, code: 'edge', kind: r.kind, reason: r.reason, ms: r.ms };
  const body = sanitizeSnapshotBody(r.body);
  return body ? { ...body, via: 'edge', agent } : { ok: false, code: 'edge', kind: 'bad-body', reason: '엣지 스냅샷 응답 형식이 다릅니다.' };
}
