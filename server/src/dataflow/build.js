/**
 * dataflow/build.js — '데이터 흐름 지도' 의 판정(v2.587, 순수 함수).
 *
 * 사용자 요청(2026-09-23): "엣지에서 수집하는 모든 데이터 … iDRAC · GPU · 전력 … 엣지에서 포탈로 통신하는 모든
 * 데이터, push pull 로 가져오는 모든 데이터를 표시한다" + 노드 그래프 영상(가운데 버스·좌우 노드·하단 패널).
 *
 * ── 무엇을 그리는가 ───────────────────────────────────────────────────────────
 * 포탈 사이를 오가는 **모든 경로**다. 경로 목록은 손으로 적지 않는다 — 실제 express 라우터(`centralRouter`·
 * `collectorRouter`)의 선언을 읽어 받는다(`routes` 입력). 여기서는 그 경로를 **데이터 종류**(CATS)와
 * **방향**(KINDS)으로 나누기만 한다. 규칙에 걸리지 않은 경로는 버리지 않고 `other` 로 두고 `unmapped` 로
 * 밝힌다 — 테스트가 그 목록이 비어 있음을 고정하므로 새 경로를 만들면 CI 가 분류를 요구한다.
 *
 * ── 판정 규칙(각각 테스트가 고정) ────────────────────────────────────────────
 *  ① **기록이 없는 연결은 그리지 않는다** — '정상' 으로 칠하지 않는다. 경로 자체에 기록이 하나도 없으면 그 경로는
 *     `none`(회색)이다. 이 계측은 전부 인메모리라 **중앙 재시작 직후에는 전부 none** 이고, 화면이 `since` 로 밝힌다.
 *  ② 마지막 실패가 마지막 성공보다 **뒤**면 `fail`. 앞이면 이미 회복된 과거 기록이다(v2.570 거부 순서 규약).
 *  ③ 낡음 경계 = `max(그 연결의 관측 간격 × STALE_FACTOR, STALE_MIN_MS)`. 숫자를 박으면 주기가 긴 경로
 *     (스토리지 1시간·용량 보고)가 영원히 낡음이 된다(v2.584 통신 지도와 같은 판단).
 *  ④ 이름을 증명하지 못한 기록(공유 토큰 pull · 거부된 push)은 `unverified` 를 싣는다 — 화면이 그 사실을 말한다.
 *  ⑤ 등록부에 없는 이름도 노드를 만든다(`registered:false`). 지우면 '누가 보냈는지 모르는 요청' 이 사라진다.
 *
 * ⚠ 엣지 **안의** 수집(56개 작업)은 여기 없다 — 사용자 선택이 '누를 때만 가져오기' 라 화면이
 *   `/tools/edge-log/fetch` 로 그 엣지 한 곳만 당긴다(v2.549 경로 재사용).
 */

import { PULL_UNAUTH_KEY } from '../central/pullStats.js';

/**
 * v2.600 WEB2600-04: 인증에 실패한 요청을 모은 **집계 칸**(`PULL_UNAUTH_KEY`, v2.589·v2.599)의 내부 id.
 * ⚠ 이 칸은 엣지가 아니다 — 이름을 버리고 한 곳에 센 것이라 '등록부에 없는 엣지' 로 그리면 엣지 수가
 *   하나 늘고, 누르면 '등록부에 없음' 이라는 **틀린 조치**가 뜬다. 노드·선·합계에서 빼고 `unauth` 로 밝힌다.
 */
export const UNAUTH_EDGE_ID = '!unauth';
export { PULL_UNAUTH_KEY };

export const STALE_FACTOR = 3;
export const STALE_MIN_MS = 10 * 60_000;
export const RECENT_MAX = 40;

/** 데이터 종류 — 순서가 화면 순서다. `test` 는 `side:path` 에 대한 정규식이고 **처음 맞는 것** 하나를 쓴다. */
export const CATS = Object.freeze([
  { id: 'inv', label: '인벤토리(vCenter)', test: /^central:\/(inventory|fleet|capacity-report|guest-disk|vmseries(-config)?)$|^collector:\/export$/ },
  { id: 'idrac', label: 'iDRAC·서버', test: /^central:\/(idrac-scan-(jobs|progress|result)|assignment|ip-scan-(assignment|result))$|^collector:\/(idrac-scan|bm-usage)$/ },
  { id: 'gpu', label: 'GPU', test: /^central:\/gpu-guest-(data|config)$/ },
  { id: 'power', label: '전력·PDU', test: /^central:\/pdu-(data|config)$/ },
  { id: 'storage', label: '스토리지', test: /^central:\/(storage-(data|config)|bmstor-(jobs|result))$|^collector:\/bmstor-collect$/ },
  // v2.608: Arista CloudVision(CVP) 도 같은 '스위치' 칸에 둔다(웹 CAT_COLOR 에 새 칸을 만들지 않으려고 — 라벨이 그 사실을 말한다).
  { id: 'san', label: 'SAN·네트워크 스위치', test: /^central:\/(sanswitch-(data|config|perf|test-result)|cvp-(data|config))$/ },
  { id: 'watch', label: '장애·감시', test: /^central:\/(part-faults|partfault-config|svcmon-(config|config-ack|report)|link-check(-config)?|ping-(jobs|result))$|^collector:\/ping$/ },
  { id: 'users', label: '사용자·세션', test: /^central:\/(curuser(-config)?|users-config)$/ },
  { id: 'ops', label: '운영 작업', test: /^central:\/(capture-(jobs|result)|rma-(poll|result|credential)|log-quer(ies|y-result)|edge-log-(jobs|result)|result)$|^collector:\/edge-log$/ },
  { id: 'reg', label: '등록·설정', test: /^central:\/(register-collector|agent-config|health-probe)$|^collector:\/(token-check|upgrade|set-password)$/ },
]);

/**
 * 방향 — 조치가 다른 것만 나눈다.
 *  push  엣지 → 중앙(자료 올림)        reply 엣지 → 중앙(작업 결과 회신)
 *  pull  엣지가 중앙에서 설정·자료를 가져감   job   엣지가 중앙에서 작업을 인출
 *  cpull 중앙이 엣지에서 가져옴           cpush 중앙이 엣지에 보냄(명령·번들)
 */
export const KINDS = Object.freeze(['push', 'reply', 'pull', 'job', 'cpull', 'cpush']);
const JOB_PATHS = /^\/(.*-jobs|assignment|ip-scan-assignment|log-queries|rma-poll|rma-credential)$/;
const REPLY_PATHS = /^\/(.*-result|.*-progress|svcmon-config-ack|result)$/;

export function kindOf(side, method, path) {
  const m = String(method || '').toUpperCase();
  if (side === 'collector') return m === 'GET' ? 'cpull' : 'cpush';
  if (JOB_PATHS.test(path)) return 'job';
  if (m === 'GET') return 'pull';
  if (REPLY_PATHS.test(path)) return 'reply';
  return 'push';
}

export function catOf(side, path) {
  const k = `${side}:${path}`;
  for (const c of CATS) if (c.test.test(k)) return c.id;
  return 'other';
}

const t = (v) => String(v ?? '').trim();
const norm = (v) => t(v).toLowerCase();
export function originOf(url) { try { return new URL(t(url)).origin; } catch { return ''; } }
/**
 * v2.601(감사 WEB2601-01): 수집 서버의 **주소 기준**(origin + 경로 접두, 끝 슬래시 제거). 등록부는
 * `https://gw/siteA` 같은 경로 접두를 받고 puller 는 `${url}/api/collector/export` 로 부른다 —
 * origin 만으로 맞추면 한 게이트웨이 뒤의 엣지 여럿이 한 노드로 합쳐진다. outboundStats 행의 `base` 와 비교한다.
 */
export function baseOf(url) {
  try { const u = new URL(t(url)); return `${u.origin}${u.pathname.replace(/\/+$/, '')}`; } catch { return ''; }
}

/** 한 연결의 상태(규칙 ①~③). okAt/failAt 이 둘 다 없으면 null(연결 없음). */
export function linkState({ okAt = 0, failAt = 0, intervalMs = null, now = Date.now() } = {}) {
  if (!okAt && !failAt) return null;
  if (failAt > okAt) return 'fail';
  const bound = Math.max(STALE_MIN_MS, intervalMs ? intervalMs * STALE_FACTOR : 0);
  return now - okAt > bound ? 'stale' : 'ok';
}

/**
 * @param p.routes    [{side:'central'|'collector', method, path}] — 실제 라우터에서 읽은 선언
 * @param p.collectors 수집 서버 등록부
 * @param p.ingest    getIngestStats()   (엣지 → 중앙 POST 성공)
 * @param p.pulls     pullStats()        (엣지 → 중앙 GET)
 * @param p.rejects   rejectStats()      (거부된 POST — 이름 미검증)
 * @param p.outbound  outboundStats()    (이 노드 → 다른 포탈)
 */
export function buildDataFlow(p = {}) {
  const now = Number(p.now) || Date.now();
  // ── 경로 ──
  const seenRoute = new Set();
  const routes = [];
  for (const r of p.routes || []) {
    const side = r?.side === 'collector' ? 'collector' : 'central';
    const path = t(r?.path);
    const method = t(r?.method).toUpperCase();
    if (!path || !method) continue;
    const id = `${side}:${method} ${path}`;
    if (seenRoute.has(id)) continue;
    seenRoute.add(id);
    routes.push({ id, side, method, path, kind: kindOf(side, method, path), cat: catOf(side, path) });
  }
  const routeBy = new Map(routes.map((r) => [r.id, r]));
  const rid = (side, method, path) => `${side}:${String(method).toUpperCase()} ${path}`;

  // ── 엣지 노드(등록부 + 기록에만 있는 이름) ──
  const alias = new Map();
  const edges = new Map();
  // v2.601(감사 WEB2601-02): 주소(base)가 같은 수집 서버가 둘 이상이면 예전엔 **첫 엣지**에 기록을 합치고
  //   둘째는 '기록 없음' 이었다(매분 403 인 엣지가 회색이 되고 정상 엣지에 실패가 섞였다). 이제 목록으로 들고,
  //   태그(수집 서버 id — puller 가 붙인다)가 있는 행은 그 엣지에, 없는 행은 **유일할 때만** 붙인다.
  const byBase = new Map();
  const byOriginAll = new Map(); // base 가 없는 행(구버전 기록 형식)용 — origin 이 같은 수집 서버 전부
  for (const c of p.collectors || []) {
    const id = t(c?.id || c?.name); if (!id) continue;
    alias.set(norm(id), id); if (t(c?.name)) alias.set(norm(c.name), id);
    const origin = originOf(c?.url);
    const base = baseOf(c?.url);
    if (base) { if (!byBase.has(base)) byBase.set(base, []); byBase.get(base).push(id); }
    if (origin) { if (!byOriginAll.has(origin)) byOriginAll.set(origin, []); byOriginAll.get(origin).push(id); }
    edges.set(id, { id, name: t(c?.name) || id, registered: true, enabled: c?.enabled !== false, origin, unverifiedOnly: false });
  }
  for (const ids of byBase.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) edges.get(id).sharedUrlWith = ids.filter((x) => x !== id);
  }
  const edgeOf = (name, { verified = true } = {}) => {
    const n = t(name) || '(unknown)';
    if (n === PULL_UNAUTH_KEY) return UNAUTH_EDGE_ID; // 엣지 노드를 만들지 않는다(위 UNAUTH_EDGE_ID 설명)
    const id = alias.get(norm(n));
    if (id) return id;
    const key = `?${n}`;
    if (!edges.has(key)) edges.set(key, { id: key, name: n, registered: false, enabled: true, origin: '', unverifiedOnly: !verified });
    else if (verified) edges.get(key).unverifiedOnly = false;
    return key;
  };

  // ── 연결 기록 모으기 ── key = edgeId|routeId
  const acc = new Map();
  const slot = (edge, route) => {
    const k = `${edge}|${route}`;
    let s = acc.get(k);
    if (!s) { s = { edge, route, okAt: 0, failAt: 0, count: 0, failCount: 0, bytes: 0, intervalMs: null, reason: '', unverified: false }; acc.set(k, s); }
    return s;
  };
  const extra = []; // 라우터에 없는 경로로 온 기록(구버전 경로 등) — 버리지 않고 밝힌다
  const ensureRoute = (side, method, path) => {
    const id = rid(side, method, path);
    if (routeBy.has(id)) return id;
    const r = { id, side, method: String(method).toUpperCase(), path, kind: kindOf(side, method, path), cat: catOf(side, path), undeclared: true };
    routes.push(r); routeBy.set(id, r); extra.push(id);
    return id;
  };

  for (const row of p.ingest?.rows || []) {
    // v2.591(PR-2): 수신 행도 이름 검증 여부를 싣는다(예전엔 무조건 검증됨 — 공유 토큰의 주장 이름이 검증된 엣지로 그려졌다).
    const e = edgeOf(row.agent, { verified: row.verified !== false });
    for (const ep of row.byEndpoint || []) {
      const s = slot(e, ensureRoute('central', 'POST', t(ep.endpoint)));
      s.okAt = Math.max(s.okAt, Number(ep.lastAt) || 0);
      s.count += Number(ep.count) || 0;
      s.bytes = Number(ep.lastBytes ?? 0) || s.bytes;
      if (ep.intervalMsEwma != null) s.intervalMs = Math.round(ep.intervalMsEwma);
    }
  }
  for (const row of p.pulls?.rows || []) {
    const e = edgeOf(row.agent, { verified: !!row.verified });
    for (const ep of row.byEndpoint || []) {
      const s = slot(e, ensureRoute('central', 'GET', t(ep.endpoint)));
      s.okAt = Math.max(s.okAt, Number(ep.lastOkAt) || 0);
      s.failAt = Math.max(s.failAt, Number(ep.lastFailAt) || 0);
      s.count += Number(ep.count) || 0; s.failCount += Number(ep.failCount) || 0;
      s.bytes = Number(ep.lastBytes) || s.bytes;
      if (ep.intervalMs != null) s.intervalMs = ep.intervalMs;
      if (!row.verified) s.unverified = true;
      if (ep.lastFailAt && ep.lastFailAt >= ep.lastOkAt) s.reason = `HTTP ${ep.lastStatus}`;
    }
  }
  // 거부: 시각은 최근 원문(recent)에만 경로별로 있다. 원문이 밀려난 거부는 개수만 싣고 상태에 넣지 않는다(시각을 모른다).
  let rejectsPlaced = 0; // v2.589: 선에 실제로 올린 개수 — '시각 모름' 은 전체에서 이것만 뺀다('(기타)' 로 빠진 건이 사라지지 않게)
  for (const r of p.rejects?.recent || []) {
    if (!t(r.endpoint) || r.endpoint === '(기타)') continue;
    rejectsPlaced += 1;
    const s = slot(edgeOf(r.agent, { verified: false }), ensureRoute('central', 'POST', t(r.endpoint)));
    if ((Number(r.at) || 0) > s.failAt) { s.failAt = Number(r.at) || 0; s.reason = t(r.reason) || `거부 ${r.kind || ''}`.trim(); }
    s.failCount += 1; s.unverified = true;
  }
  const ambiguous = new Map(); // base → { base, edges, routes:Set, count } — 태그 없이 같은 주소를 쓰는 엣지 여럿
  for (const o of p.outbound?.rows || []) {
    const path = t(o.path);
    if (!path.startsWith('/api/collector/')) continue; // 이 노드가 중앙일 때 의미 있는 방향만
    const base = t(o.base) || t(o.origin); // 구버전 행(base 없음)은 origin 으로만 맞춘다
    const tagged = t(o.tag) ? alias.get(norm(o.tag)) : null;
    const cands = (t(o.base) ? byBase.get(base) : byOriginAll.get(base)) || [];
    let e;
    if (tagged) e = tagged;
    else if (cands.length === 1) e = cands[0];
    else if (cands.length > 1) {
      // 어느 엣지의 호출인지 모른다 — 한쪽에 붙이면 거짓 상태가 된다. 붙이지 않고 개수로 밝힌다.
      const a = ambiguous.get(base) || { base, edges: cands, routes: new Set(), count: 0 };
      a.routes.add(path); a.count += (Number(o.count) || 0);
      ambiguous.set(base, a);
      continue;
    } else e = edgeOf(originOf(base) || t(o.origin) || '(알 수 없는 주소)'); // 노드 이름은 origin 만(경로에 비밀이 실릴 수 있다)
    const s = slot(e, ensureRoute('collector', o.method || 'GET', path.slice('/api/collector'.length)));
    s.okAt = Math.max(s.okAt, Number(o.lastOkAt) || 0);
    s.failAt = Math.max(s.failAt, Number(o.lastFailAt) || 0);
    s.count += Number(o.count) || 0; s.failCount += Number(o.failCount) || 0;
    s.bytes = Number(o.lastBytes) || s.bytes;
    if (o.lastFailAt && o.lastFailAt >= o.lastOkAt) s.reason = t(o.lastError);
  }

  // ── 판정 ──
  const links = [];
  const unauthRows = [];
  for (const s of acc.values()) {
    if (s.edge === UNAUTH_EDGE_ID) {
      // 인증 실패는 경로 상태·엣지 합계에 넣지 않는다 — 실제 엣지의 선을 빨갛게 만들면 거짓 장애다(v2.589).
      const route = routeBy.get(s.route);
      unauthRows.push({ route: s.route, side: route?.side || '', method: route?.method || '', path: route?.path || '',
        count: s.count + s.failCount, lastAt: Math.max(s.okAt, s.failAt), reason: s.reason });
      continue;
    }
    const state = linkState({ okAt: s.okAt, failAt: s.failAt, intervalMs: s.intervalMs, now });
    if (!state) continue;
    links.push({ ...s, state, lastAt: Math.max(s.okAt, s.failAt) });
  }
  unauthRows.sort((a, b) => b.lastAt - a.lastAt || b.count - a.count);
  const unauth = unauthRows.length
    ? { key: PULL_UNAUTH_KEY, reason: 'unauth-bucket', count: unauthRows.reduce((a, r) => a + r.count, 0),
      lastAt: unauthRows[0].lastAt || null, routes: unauthRows }
    : null;
  links.sort((a, b) => (a.edge < b.edge ? -1 : a.edge > b.edge ? 1 : a.route < b.route ? -1 : 1));

  const zero = () => ({ ok: 0, stale: 0, fail: 0 });
  const routeState = new Map(routes.map((r) => [r.id, zero()]));
  const edgeState = new Map([...edges.keys()].map((k) => [k, { ...zero(), used: 0, lastAt: 0 }]));
  for (const l of links) {
    routeState.get(l.route)[l.state]++;
    const es = edgeState.get(l.edge); es[l.state]++; es.used++; es.lastAt = Math.max(es.lastAt, l.lastAt);
  }
  const routesOut = routes.map((r) => {
    const s = routeState.get(r.id);
    const any = s.ok + s.stale + s.fail;
    return { ...r, ...s, state: !any ? 'none' : s.fail ? 'fail' : s.stale ? 'stale' : 'ok' };
  });
  const catDefs = [...CATS.map((c) => ({ id: c.id, label: c.label }))];
  if (routesOut.some((r) => r.cat === 'other')) catDefs.push({ id: 'other', label: '분류 안 됨' });
  const cats = catDefs.map((c) => {
    const rs = routesOut.filter((r) => r.cat === c.id);
    return { ...c, routes: rs.length,
      ok: rs.reduce((a, r) => a + r.ok, 0), stale: rs.reduce((a, r) => a + r.stale, 0), fail: rs.reduce((a, r) => a + r.fail, 0),
      none: rs.filter((r) => r.state === 'none').length };
  }).filter((c) => c.routes > 0);
  const order = new Map(catDefs.map((c, i) => [c.id, i]));
  routesOut.sort((a, b) => (order.get(a.cat) - order.get(b.cat)) || (KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind)) || (a.path < b.path ? -1 : 1));

  const edgesOut = [...edges.values()].map((e) => ({ ...e, ...edgeState.get(e.id) }))
    .sort((a, b) => (Number(b.registered) - Number(a.registered)) || (a.name < b.name ? -1 : 1));

  const recent = [...links].sort((a, b) => b.lastAt - a.lastAt).slice(0, RECENT_MAX);
  const totals = links.reduce((a, l) => { a[l.state]++; return a; }, { ok: 0, stale: 0, fail: 0 });
  totals.links = links.length;
  totals.routesNone = routesOut.filter((r) => r.state === 'none').length;
  totals.routes = routesOut.length;

  const sinceVals = [p.ingestSince, p.pulls?.since, p.outbound?.since].map(Number).filter((v) => v > 0);
  return {
    routes: routesOut, cats, edges: edgesOut, links, recent, totals, unauth,
    unmapped: routesOut.filter((r) => r.cat === 'other').map((r) => r.id),
    undeclared: extra,
    // v2.601(WEB2601-02): 같은 주소를 쓰는 엣지 여럿에 걸려 어느 엣지에도 붙이지 않은 중앙 → 엣지 기록.
    sharedUrl: [...ambiguous.values()].map((a) => ({ origin: originOf(a.base), edges: a.edges, routes: [...a.routes].sort(), count: a.count })),
    rejectsWithoutTime: Math.max(0, (p.rejects?.rows || []).reduce((a, r) => a + (Number(r.total) || 0), 0) - rejectsPlaced),
    since: sinceVals.length ? Math.min(...sinceVals) : null,
    rules: { staleFactor: STALE_FACTOR, staleMinMs: STALE_MIN_MS },
  };
}
