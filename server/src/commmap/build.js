/**
 * commmap/build.js — 통신 지도(중앙 ↔ 엣지 통신 시각화)의 **순수 조립 모듈**(v2.584).
 *
 * 사용자 요청(2026-09-23, 라디얼 그래프 캡처와 함께): "이런 방식으로 메인과 edge 가 통신하는 것을
 * 비주얼하게 보여주는 dashboard 추가해줘". 선택: 특수기능 새 화면 '통신 지도' · 위임 자원 외곽 링까지 ·
 * 전체 검증.
 *
 * ── 이 모듈이 하는 것 ──────────────────────────────────────────────────────────
 *  중앙이 **이미 갖고 있는 값**만 조합한다 — 장비·엣지에 왕복하지 않는다(그래서 15초 폴링이 가능하다).
 *   · 등록부(`collectors.json`) → 안쪽 링(엣지)
 *   · `collector/state.js allCollectorStatus()` → 중앙 → 엣지 **pull**(60초 주기) 결과
 *   · `central/ingestStats.js getIngestStats()` → 엣지 → 중앙 **push** 수신 통계(와이어 바이트·간격)
 *   · `central/ingestReject.js rejectStats()` → 거부된 push(⚠ 이름은 **검증되지 않은** 값 — v2.570)
 *   · `linkcheck/db.js latestAll()` → 통신 점검(v2.552)의 링크별 최신 판정
 *   · vCenter 등록부 + 스냅샷, 스토리지·SAN·PDU 등록부 → 바깥 링(각 엣지가 위임받은 자원)
 *
 * ── 정직성 규칙(테스트가 고정) ─────────────────────────────────────────────────
 *  ① **'기록 없음' 을 정상으로 칠하지 않는다.** pull 상태도 push 기록도 없는 엣지는 `unknown` 이다 —
 *     중앙이 재시작한 직후가 그렇고(두 통계 모두 인메모리다), 기다리면 pull 은 60초 안에 채워진다.
 *  ② **push 의 신선도 경계는 그 엣지의 실제 push 간격에서 계산한다**(EWMA × 3, 하한 `siteStaleMs`).
 *     숫자를 박으면 주기가 긴 법인이 영원히 '낡음' 이 된다.
 *  ③ **거부 기록이 마지막 정상 수신보다 뒤일 때만** `push-rejected` 다(v2.570 판정 순서). 옛 거부가
 *     방금 들어온 정상 수신을 덮으면 안 된다. 그리고 거부의 agent 이름은 `unverified` 로 밝힌다.
 *  ④ **위임 자원의 담당 엣지는 등록값(`remoteAgent`·`agent`)이 먼저다.** 스냅샷이 관측한 pusher
 *     (`collectedBy`)가 다르면 **둘 다** 싣고 `agentMismatch` 로 밝힌다(v2.542 배지 규약 — 한쪽만 고르면
 *     반대 방향의 거짓). 등록부의 어느 엣지와도 맞지 않는 이름은 **지어낸 노드에 붙이지 않고**
 *     `unassigned` 로 따로 센다.
 *  ⑤ **상한으로 자른 것은 개수를 밝힌다**(`omitted`). 바깥 링은 엣지당 종류별 `RES_MAX_PER_KIND`.
 *  ⑥ 판정은 여기서 `state` + `reasons`(코드)만 만들고 **문장은 웹**(`commMapText.js`)이 만든다
 *     (v2.553 remedy 규약 — 코드 목록과 문구가 1:1 이어야 하고 테스트가 대조한다).
 */
import { linkIdOf } from '../linkcheck/links.js';

const t = (v) => String(v ?? '').trim();
const norm = (v) => t(v).toLowerCase();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** 바깥 링 — 엣지당 종류별 상한(넘치면 `omitted`). 28엣지 × 4종 × 40 = 4,480 노드가 상한이다. */
export const RES_MAX_PER_KIND = 40;
/** 중앙 직접 자원(허브에 붙는 것) 종류별 상한. */
export const DIRECT_MAX_PER_KIND = 60;
/** push 신선도 = max(siteStaleMs, PUSH_FRESH_FACTOR × 관측 간격). */
export const PUSH_FRESH_FACTOR = 3;

/** 자원 종류 — 순서가 화면 범례 순서다. */
export const RES_KINDS = Object.freeze(['vcenter', 'storage', 'sanswitch', 'pdu']);

/**
 * 사유 코드 → 심각도. ⚠ 웹 `commMapText.js REASON_TEXT` 와 **키 집합이 같아야 한다**(테스트가 대조).
 *  fail  : 지금 통신이 되지 않는다(조치 필요)
 *  warn  : 되지만 불완전하다(저하·낡음·정체 불일치)
 *  info  : 이상이 아니다(사실 고지)
 */
export const REASON_SEVERITY = Object.freeze({
  'disabled': 'info',
  'pull-fail': 'fail',
  'pull-degraded': 'warn',
  'pull-none': 'info',
  'pull-auth': 'fail',
  'pull-identity': 'warn',
  'push-rejected': 'fail',
  'push-stale': 'warn',
  'push-none': 'info',
  'push-none-expected': 'warn',
  'link-fail': 'fail',
  'edge-report-stale': 'warn',
  'mock': 'info',
  'puller-off': 'warn',
});
export const REASON_CODES = Object.freeze(Object.keys(REASON_SEVERITY));

/** 엣지 상태 — 화면 KPI·색의 계약. `disabled`·`unknown` 은 정상에도 장애에도 넣지 않는다. */
export const EDGE_STATES = Object.freeze(['ok', 'warn', 'fail', 'disabled', 'unknown']);
/** 자원(vCenter) 상태. 장비(스토리지·SAN·PDU)는 등록부만 보므로 `registered` 하나다. */
export const RES_STATES = Object.freeze(['ok', 'stale', 'pending', 'fail', 'maintenance', 'disabled', 'registered']);

/** 등록부 이름 접기 — 표시 이름·id 어느 쪽으로 와도 **id** 로 접는다(v2.583 '키 하나' 규약). */
export function aliasMap(collectors = []) {
  const m = new Map();
  for (const c of collectors) {
    const id = t(c?.id || c?.name);
    if (!id) continue;
    m.set(norm(id), id);
    if (t(c?.name)) m.set(norm(c.name), id);
  }
  return m;
}

/** 등록된 vCenter + 스냅샷을 합쳐 vCenter 자원 한 줄을 만든다. */
function vcenterRow(reg, snapVc, counts) {
  const id = t(reg.id);
  const s = snapVc || null;
  let state = 'registered';
  if (reg.enabled === false) state = 'disabled';
  else if (reg.maintenance === true || s?.status === 'maintenance') state = 'maintenance';
  else if (!s) state = 'pending';
  else if (s.status === 'pending') state = 'pending';
  else if (s.status === 'unreachable') state = 'fail';
  else if (s.stale) state = 'stale';
  else state = 'ok';
  const c = counts?.get(id) || null;
  return {
    id, name: t(reg.name) || id, kind: 'vcenter', state,
    collectMode: t(reg.collectMode) === 'site' ? 'site' : 'direct',
    receivedAt: num(s?.receivedAt), stale: !!s?.stale, error: s?.error ? String(s.error).slice(0, 200) : '',
    hosts: c ? c.hosts : null, vms: c ? c.vms : null,
  };
}

function deviceRow(d, kind) {
  return { id: t(d.id || d.deviceId), name: t(d.name) || t(d.host) || t(d.id), kind, type: t(d.type), state: d.enabled === false ? 'disabled' : 'registered' };
}

/** 종류별 상한 적용 — 잘린 개수를 **밝힌다**. */
function capList(list, max) {
  if (list.length <= max) return { items: list, omitted: 0 };
  return { items: list.slice(0, max), omitted: list.length - max };
}

/**
 * @param {object} p
 * @param {number} p.now
 * @param {Array}  p.collectors       redact 된 수집 서버 목록(토큰 없음)
 * @param {object} p.status           allCollectorStatus()  (id → 상태)
 * @param {object} p.ingest           getIngestStats()
 * @param {object} p.rejects          rejectStats()
 * @param {Array}  p.latestLinks      latestAll()  (link_latest 행)
 * @param {object} p.edgeReports      allEdgeLinkReports()
 * @param {Array}  p.vcenters         vCenter 등록부(listRegistry)
 * @param {Array}  p.snapVcenters     스냅샷의 vcenters
 * @param {Map}    p.vcCounts         vCenter id → {hosts, vms}
 * @param {Array}  p.storage, p.sanswitch, p.pdu   장비 등록부(redact)
 * @param {Array}  p.storageReports   edgeStorageReports()  [{agent, at, deviceCount}]
 * @param {Array}  p.pduReports       edgePduStatus()       [{agent, at, devices, stale}]
 * @param {Array}  p.sanReports       [{agent, at, devices}]
 * @param {number} p.pullIntervalMs   config.collector.pullIntervalMs (0 = 폴러 꺼짐)
 * @param {number} p.siteStaleMs      store.SITE_STALE_MS
 * @param {boolean} p.linkCheckEnabled
 * @param {number} [p.resMax]    엣지 자원 종류별 상한(기본 RES_MAX_PER_KIND — 3단 지도는 전량을 받아 자기 상한을 쓴다)
 * @param {number} [p.directMax] 중앙 직접 자원 종류별 상한(기본 DIRECT_MAX_PER_KIND)
 */
export function buildCommMap(p = {}) {
  const resMax = typeof p.resMax === 'number' && p.resMax > 0 ? p.resMax : RES_MAX_PER_KIND;
  const directMax = typeof p.directMax === 'number' && p.directMax > 0 ? p.directMax : DIRECT_MAX_PER_KIND;
  const now = num(p.now) ?? Date.now();
  const collectors = Array.isArray(p.collectors) ? p.collectors : [];
  const status = p.status && typeof p.status === 'object' ? p.status : {};
  const ingestRows = Array.isArray(p.ingest?.rows) ? p.ingest.rows : [];
  const rejectRows = Array.isArray(p.rejects?.rows) ? p.rejects.rows : [];
  const latestLinks = Array.isArray(p.latestLinks) ? p.latestLinks : [];
  const edgeReports = p.edgeReports && typeof p.edgeReports === 'object' ? p.edgeReports : {};
  const vcenters = Array.isArray(p.vcenters) ? p.vcenters : [];
  const snapVcenters = Array.isArray(p.snapVcenters) ? p.snapVcenters : [];
  const vcCounts = p.vcCounts instanceof Map ? p.vcCounts : new Map();
  const pullIntervalMs = num(p.pullIntervalMs) ?? 60_000;
  const siteStaleMs = Math.max(60_000, num(p.siteStaleMs) ?? 300_000);
  const linkCheckEnabled = !!p.linkCheckEnabled;

  const alias = aliasMap(collectors);
  const toId = (name) => alias.get(norm(name)) || null;

  // ── 통계를 엣지 id 로 접는다(이름·id 어느 쪽으로 기록됐든) ──
  const ingestById = new Map();
  for (const r of ingestRows) { const id = toId(r.agent); if (id && !ingestById.has(id)) ingestById.set(id, r); }
  const rejectById = new Map();
  for (const r of rejectRows) { const id = toId(r.agent); if (id && !rejectById.has(id)) rejectById.set(id, r); }
  const linkById = new Map(latestLinks.map((r) => [r.link_id, r]));
  const reportsOf = (list, id) => (Array.isArray(list) ? list : []).find((r) => toId(r.agent) === id) || null;
  const snapById = new Map(snapVcenters.map((v) => [t(v.id), v]));

  // ── 자원 → 담당 엣지 배정 ──
  const perEdge = new Map(); // id → { vcenter:[], storage:[], sanswitch:[], pdu:[] }
  for (const c of collectors) { const id = t(c.id || c.name); if (id) perEdge.set(id, { vcenter: [], storage: [], sanswitch: [], pdu: [] }); }
  const direct = { vcenter: [], storage: [], sanswitch: [], pdu: [] };
  const unassigned = [];

  for (const reg of vcenters) {
    const id = t(reg.id); if (!id) continue;
    const s = snapById.get(id) || null;
    const row = vcenterRow(reg, s, vcCounts);
    if (row.collectMode !== 'site') { direct.vcenter.push(row); continue; }
    const declared = t(reg.remoteAgent);
    const observed = t(s?.collectedBy);
    const declId = declared ? toId(declared) : null;
    const obsId = observed ? toId(observed) : null;
    row.remoteAgent = declared; row.collectedBy = observed;
    if (declared && observed && norm(declared) !== norm(observed)) row.agentMismatch = true; // ④ 둘 다 싣고 밝힌다
    const owner = declId || obsId;
    if (owner) perEdge.get(owner)[ 'vcenter' ].push(row);
    else unassigned.push({ ...row, agent: declared || observed || '', reason: declared || observed ? 'agent-unknown' : 'agent-empty' });
  }
  // 등록부에 없는데 스냅샷에만 있는 vCenter(목 데이터 폴백이 그렇다) — 지어내지 않고 **`registryMissing`** 으로 밝혀 직접 자원에 둔다.
  const regIds = new Set(vcenters.map((v) => t(v.id)).filter(Boolean));
  for (const s of snapVcenters) {
    const id = t(s.id); if (!id || regIds.has(id)) continue;
    const row = vcenterRow({ id, name: s.name, collectMode: s.collectSource === 'site' ? 'site' : 'direct', enabled: true }, s, vcCounts);
    row.registryMissing = true;
    if (row.collectMode === 'site') { const obs = t(s.collectedBy); const oid = obs ? toId(obs) : null; if (oid) { perEdge.get(oid).vcenter.push(row); continue; } unassigned.push({ ...row, agent: obs, reason: obs ? 'agent-unknown' : 'agent-empty' }); continue; }
    direct.vcenter.push(row);
  }
  const placeDevices = (list, kind) => {
    for (const d of Array.isArray(list) ? list : []) {
      const row = deviceRow(d, kind);
      const ag = t(d.agent);
      if (!ag) { direct[kind].push(row); continue; }
      const owner = toId(ag);
      if (owner) perEdge.get(owner)[kind].push(row);
      else unassigned.push({ ...row, agent: ag, reason: 'agent-unknown' });
    }
  };
  placeDevices(p.storage, 'storage'); placeDevices(p.sanswitch, 'sanswitch'); placeDevices(p.pdu, 'pdu');

  // ── 엣지 행 ──
  const edges = collectors.map((c) => {
    const id = t(c.id || c.name);
    const name = t(c.name) || id;
    const linkFrom = t(c.name) || t(c.id); // buildLinks 와 같은 규칙(링크 id 의 from/to)
    const st = status[id] || null;
    const enabled = c.enabled !== false;
    const reasons = [];

    // pull(중앙 → 엣지)
    let pull;
    if (!st) pull = { state: 'none', at: null, ageMs: null, error: '', fails: 0 };
    else if (st.ok === false) pull = { state: 'fail', at: num(st.at), ageMs: num(st.at) != null ? now - st.at : null, error: t(st.error).slice(0, 200), fails: num(st.fails) ?? 0 };
    else if (st.degraded) pull = { state: 'degraded', at: num(st.at), ageMs: num(st.at) != null ? now - st.at : null, error: t(st.error).slice(0, 200), fails: num(st.fails) ?? 0 };
    else pull = { state: 'ok', at: num(st.at), ageMs: num(st.at) != null ? now - st.at : null, error: '', fails: 0 };
    pull.hosts = num(st?.hosts); pull.identityIssue = st?.identity?.issue || st?.identity || null;
    if (pull.identityIssue && typeof pull.identityIssue === 'object' && !pull.identityIssue.reason) pull.identityIssue = null;

    // push(엣지 → 중앙)
    const ing = ingestById.get(id) || null;
    const rej = rejectById.get(id) || null;
    const intervalMs = ing?.intervalSec != null ? ing.intervalSec * 1000 : null;
    const freshMs = Math.max(siteStaleMs, intervalMs != null ? intervalMs * PUSH_FRESH_FACTOR : 0);
    let push;
    if (!ing) push = { state: 'none', lastAt: null, ageMs: null, pushes: 0, wireBytes: 0, bytesPerSec: null, intervalSec: null, endpoints: [] };
    else {
      const ageMs = now - ing.lastAt;
      push = {
        state: ageMs > freshMs ? 'stale' : 'ok', lastAt: ing.lastAt, ageMs, pushes: ing.pushes, wireBytes: ing.wireBytes,
        bytesPerSec: ing.bytesPerSec ?? null, intervalSec: ing.intervalSec ?? null,
        endpoints: (ing.byEndpoint || []).slice(0, 8).map((e) => ({ endpoint: e.endpoint, count: e.count, wireBytes: e.wireBytes, lastAt: e.lastAt })),
      };
    }
    push.freshMs = freshMs;
    // ③ 거부가 마지막 정상 수신보다 **뒤**일 때만 거부 상태
    if (rej && (!ing || rej.lastAt > ing.lastAt)) push.state = 'rejected';
    push.rejects = rej ? { total: rej.total, lastAt: rej.lastAt, lastKind: t(rej.lastKind), lastReason: t(rej.lastReason).slice(0, 200), unverified: true } : null;

    // 통신 점검(v2.552) 최신값 — 있으면 싣고, 없으면 null(정상으로 칠하지 않는다)
    const lk = (kind, from, to) => {
      const r = linkById.get(linkIdOf(kind, from, to));
      return r ? { ok: !!r.ok, ts: r.ts, phase: t(r.phase), failKind: t(r.fail_kind), streak: num(r.streak) ?? 1, sinceTs: num(r.since_ts), totalMs: num(r.total_ms) } : null;
    };
    const rep = edgeReports[linkFrom] || edgeReports[id] || null;
    const linkCheck = {
      enabled: linkCheckEnabled,
      'central->edge': lk('central->edge', 'central', linkFrom),
      'edge->central': lk('edge->central', linkFrom, 'central'),
      'edge->central-pull': lk('edge->central-pull', linkFrom, 'central'),
      reportAt: num(rep?.at), reportStale: rep ? !!rep.stale : null, reportVersion: t(rep?.version),
    };

    // 자원(바깥 링)
    const res = perEdge.get(id);
    const resources = {}; let resTotal = 0; let resOmitted = 0;
    for (const k of RES_KINDS) {
      const { items, omitted } = capList(res[k], resMax);
      resources[k] = { items, total: res[k].length, omitted };
      resTotal += res[k].length; resOmitted += omitted;
    }
    const reports = {
      storage: (() => { const r = reportsOf(p.storageReports, id); return r ? { at: num(r.at), devices: num(r.deviceCount) ?? 0 } : null; })(),
      sanswitch: (() => { const r = reportsOf(p.sanReports, id); return r ? { at: num(r.at), devices: num(r.devices) ?? 0 } : null; })(),
      pdu: (() => { const r = reportsOf(p.pduReports, id); return r ? { at: num(r.at), devices: num(r.devices) ?? 0 } : null; })(),
    };

    // 사유
    if (!enabled) reasons.push('disabled');
    else {
      if (pullIntervalMs <= 0) reasons.push('puller-off');
      if (pull.state === 'fail') reasons.push(/인증 실패|토큰/.test(pull.error) ? 'pull-auth' : 'pull-fail');
      else if (pull.state === 'degraded') reasons.push('pull-degraded');
      else if (pull.state === 'none') reasons.push('pull-none');
      if (pull.identityIssue) reasons.push('pull-identity');
      if (push.state === 'rejected') reasons.push('push-rejected');
      else if (push.state === 'stale') reasons.push('push-stale');
      else if (push.state === 'none') reasons.push(resTotal > 0 ? 'push-none-expected' : 'push-none');
      if (linkCheck['central->edge'] && linkCheck['central->edge'].ok === false) reasons.push('link-fail');
      if (rep && rep.stale) reasons.push('edge-report-stale');
      if (st?.mock) reasons.push('mock');
    }
    // 상태 — ① 기록이 둘 다 없으면 unknown(정상이 아니다)
    let state;
    if (!enabled) state = 'disabled';
    else if (reasons.some((r) => REASON_SEVERITY[r] === 'fail')) state = 'fail';
    else if (pull.state === 'none' && push.state === 'none') state = 'unknown';
    else if (reasons.some((r) => REASON_SEVERITY[r] === 'warn')) state = 'warn';
    else state = 'ok';

    return {
      id, name, datacenter: t(c.datacenter), origin: originOf(c.url), enabled, managed: !!c.managed,
      version: t(st?.version), hostname: t(st?.hostname), mock: !!st?.mock, vcenterId: t(c.vcenterId),
      pull, push, linkCheck, resources, resourceCounts: { total: resTotal, omitted: resOmitted }, reports,
      state, reasons,
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'ko'));

  // 중앙 직접 자원(허브에 붙는다)
  const hubDirect = {}; let directTotal = 0;
  for (const k of RES_KINDS) {
    const { items, omitted } = capList(direct[k], directMax);
    hubDirect[k] = { items, total: direct[k].length, omitted };
    directTotal += direct[k].length;
  }

  const byState = { ok: 0, warn: 0, fail: 0, disabled: 0, unknown: 0 };
  for (const e of edges) byState[e.state] += 1;
  const resTotal = edges.reduce((s, e) => s + e.resourceCounts.total, 0);

  return {
    at: now,
    hub: { pullIntervalMs, pullerEnabled: pullIntervalMs > 0, siteStaleMs, linkCheckEnabled, direct: hubDirect, directTotal },
    edges,
    unassigned,
    counts: { edges: edges.length, byState, resources: resTotal, direct: directTotal, unassigned: unassigned.length },
    ingest: { totalBytes: num(p.ingest?.totalBytes) ?? 0, since: num(p.ingest?.since), agents: num(p.ingest?.agents) ?? 0 },
    rejectsUnverified: true,
  };
}

/** URL 에서 출처(스킴+호스트+포트)만 남긴다 — 경로·쿼리(토큰이 실릴 수 있다)는 싣지 않는다. */
export function originOf(url) {
  const s = t(url);
  if (!s) return '';
  try { return new URL(s).origin; } catch { return s.split(/[?#]/)[0].slice(0, 120); }
}
