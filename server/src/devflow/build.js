/**
 * devflow/build.js — 특수기능 '3단 지도(장비 → 엣지 → 메인)' 조립기(v2.588, 순수).
 *
 * 사용자 요청(2026-09-23): "엣지와 main 이 통신하는것도 표시해줘 · 3단계로 만들어줘, 장비-edge-main".
 * 선택: 장비는 **종류별 묶음 + 펼치기** · 특수기능 별도 화면.
 *
 * ── 새 판정을 만들지 않는다 ─────────────────────────────────────────────────
 * 장비 귀속·상태는 통신 지도(`commmap/build.js buildCommMap`)가, 엣지 ↔ 메인 연결은 데이터 흐름 지도
 * (`dataflow/build.js buildDataFlow`)가 이미 판정한다. 여기서는 그 둘을 **묶기만** 한다 — 같은 판정을
 * 복제하면 세 화면이 서로 다른 말을 하게 된다(CLAUDE.md '코어는 하나다').
 * 새로 들어오는 입력은 iDRAC 뿐이다(통신 지도는 iDRAC 을 다루지 않는다):
 *   - 중앙 등록부의 iDRAC(OME 제외) → 메인 직접
 *   - 엣지가 export 로 올린 iDRAC(`remoteInventory.allRemoteServers`) → collectorId 의 엣지
 *
 * ── 정직성 규칙(테스트가 하나씩 고정) ───────────────────────────────────────
 *  ① 장비 상태는 **받은 그대로**다. iDRAC·스토리지·SAN·PDU 는 이 화면이 장비별 수집 성패를 판정하지 않으므로
 *     `registered`(등록됨 — 판정 안 함)이고 묶음 색은 **중립**이다. 초록으로 칠하지 않는다.
 *  ② 엣지 ↔ 메인 채널은 기록이 있는 경로만 센다. 기록이 없으면 `none`(회색)이지 정상이 아니다.
 *  ③ 채널 상태: 하나라도 실패면 fail → 낡음이 있으면 stale → 성공 기록이 있으면 ok → 아니면 none.
 *  ④ 등록부에 없는 엣지 이름(데이터 흐름 기록에만 있는 것)도 노드를 만들고 `registered:false` 로 밝힌다.
 *  ⑤ 어느 엣지에도 붙일 수 없는 장비는 지어낸 노드에 붙이지 않고 `unassigned` 로 모은다.
 *  ⑥ 목록 상한으로 자른 개수는 `omitted` 로 밝힌다(개수 집계는 자르기 **전** 전량 기준).
 */

export const DEV_KINDS = Object.freeze(['vcenter', 'idrac', 'storage', 'sanswitch', 'pdu']);
/** 묶음 하나가 펼칠 때 보여줄 장비 상한(집계는 전량). */
export const ITEM_MAX = 80;
/** 엣지 ↔ 메인 채널 4개와 데이터 흐름 방향(KINDS)의 대응. */
export const CHANNELS = Object.freeze(['up', 'down', 'cpull', 'cpush']);
export const CHANNEL_OF = Object.freeze({ push: 'up', reply: 'up', pull: 'down', job: 'down', cpull: 'cpull', cpush: 'cpush' });
/** 장비 상태 — 통신 지도 RES_STATES 와 같은 집합(+ 순서가 곧 심각도). */
export const ITEM_STATES = Object.freeze(['fail', 'stale', 'pending', 'ok', 'maintenance', 'registered', 'disabled']);
export const GROUP_TONES = Object.freeze(['fail', 'warn', 'ok', 'neutral']);
export const CHANNEL_STATES = Object.freeze(['fail', 'stale', 'ok', 'none']);

const t = (v) => (v == null ? '' : String(v).trim());
const rank = (s) => { const i = ITEM_STATES.indexOf(s); return i < 0 ? ITEM_STATES.length : i; };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 종류별 묶음 — 상태 개수는 전량, 목록은 심각한 것부터 상한까지. */
export function groupOf(kind, list = [], extra = {}) {
  const counts = Object.fromEntries(ITEM_STATES.map((s) => [s, 0]));
  for (const it of list) counts[ITEM_STATES.includes(it.state) ? it.state : 'registered'] += 1;
  const sorted = [...list].sort((a, b) => (rank(a.state) - rank(b.state)) || String(a.name).localeCompare(String(b.name), 'ko'));
  const items = sorted.slice(0, ITEM_MAX);
  let tone;
  if (counts.fail) tone = 'fail';
  else if (counts.stale || counts.pending) tone = 'warn';
  else if (counts.ok) tone = 'ok';
  else tone = 'neutral'; // ① 등록만 알고 판정하지 않은 묶음은 초록이 아니다
  return { kind, total: list.length, counts, tone, items, omitted: list.length - items.length, ...extra };
}

function idracItem(s, remote) {
  return {
    id: t(s.id) || t(s.serviceTag) || t(s.host), name: t(s.name) || t(s.host) || t(s.id), kind: 'idrac',
    type: 'idrac', state: 'registered', serviceTag: t(s.serviceTag), model: t(s.model),
    ...(remote ? { hasInventory: !!s.inv } : {}),
  };
}

/** 한 엣지의 데이터 흐름 연결을 채널 4개로 접는다. */
export function channelsOf(edgeId, flow = {}) {
  const routeById = new Map((flow.routes || []).map((r) => [r.id, r]));
  const out = Object.fromEntries(CHANNELS.map((c) => [c, { state: 'none', routes: 0, failRoutes: 0, staleRoutes: 0, count: 0, failCount: 0, bytes: 0, lastOkAt: 0, lastFailAt: 0, unverified: false, cats: [] }]));
  for (const l of flow.links || []) {
    if (l.edge !== edgeId) continue;
    const r = routeById.get(l.route); const ch = CHANNEL_OF[r?.kind]; if (!ch) continue;
    const c = out[ch];
    c.routes += 1; c.count += num(l.count) || 0; c.failCount += num(l.failCount) || 0; c.bytes += num(l.bytes) || 0;
    if (l.state === 'fail') c.failRoutes += 1; else if (l.state === 'stale') c.staleRoutes += 1;
    if ((num(l.okAt) || 0) > c.lastOkAt) c.lastOkAt = l.okAt;
    if ((num(l.failAt) || 0) > c.lastFailAt) c.lastFailAt = l.failAt;
    if (l.unverified) c.unverified = true;
    if (r?.cat && !c.cats.includes(r.cat)) c.cats.push(r.cat);
  }
  for (const c of Object.values(out)) {
    c.state = c.failRoutes ? 'fail' : c.staleRoutes ? 'stale' : c.routes ? 'ok' : 'none'; // ③
    c.lastOkAt = c.lastOkAt || null; c.lastFailAt = c.lastFailAt || null;
  }
  return out;
}

/** 채널 넷 중 가장 나쁜 상태 — 선 색. 기록이 하나도 없으면 none. */
export function worstChannel(ch = {}) {
  for (const s of CHANNEL_STATES) if (CHANNELS.some((k) => ch[k]?.state === s)) return s;
  return 'none';
}

/**
 * @param {object} p
 * @param {object} p.comm   buildCommMap({... resMax: Infinity, directMax: Infinity })
 * @param {object} p.flow   buildDataFlow(...)
 * @param {Array}  p.idracLocal   중앙 iDRAC 등록부(OME 포함 가능 — 여기서 뺀다)
 * @param {Array}  p.idracRemote  allRemoteServers() — collectorId 가 붙어 있다
 * @param {object} [p.central]    { version, agentName }
 */
export function buildDeviceFlow(p = {}) {
  const comm = p.comm || {};
  const flow = p.flow || {};
  const commEdges = comm.edges || [];
  const ids = new Set(commEdges.map((e) => e.id));

  // iDRAC 배치
  const idracByEdge = new Map();
  const idracDirect = [];
  const idracUnassigned = [];
  for (const s of Array.isArray(p.idracLocal) ? p.idracLocal : []) {
    if (!s || s.type === 'ome') continue; // OME 는 관리 콘솔이지 서버가 아니다(Overview 와 같은 기준)
    idracDirect.push(idracItem(s, false));
  }
  for (const s of Array.isArray(p.idracRemote) ? p.idracRemote : []) {
    if (!s || s.type === 'ome') continue;
    const cid = t(s.collectorId);
    if (cid && ids.has(cid)) { if (!idracByEdge.has(cid)) idracByEdge.set(cid, []); idracByEdge.get(cid).push(idracItem(s, true)); }
    else idracUnassigned.push({ ...idracItem(s, true), agent: cid, reason: cid ? 'agent-unknown' : 'agent-empty' });
  }

  const listOf = (res, k) => (res && res[k] && Array.isArray(res[k].items) ? res[k].items : []);

  // ── 엣지 노드 ──
  const edges = commEdges.map((e) => {
    const channels = channelsOf(e.id, flow);
    const groups = [];
    for (const k of DEV_KINDS) {
      const list = k === 'idrac' ? (idracByEdge.get(e.id) || []) : listOf(e.resources, k);
      if (!list.length) continue;
      // 묶음의 '마지막 보고' — 엣지가 그 종류를 중앙에 올린 시각(모르면 null, 지어내지 않는다)
      let reportAt = null; let reportBasis = '';
      if (k === 'vcenter') { reportAt = list.reduce((m, x) => Math.max(m, num(x.receivedAt) || 0), 0) || null; reportBasis = 'push'; }
      else if (k === 'idrac') { reportAt = num(e.pull?.at); reportBasis = 'pull'; }
      else { reportAt = num(e.reports?.[k]?.at); reportBasis = 'push'; }
      groups.push(groupOf(k, list, { reportAt, reportBasis }));
    }
    return {
      id: e.id, name: e.name, registered: true, enabled: e.enabled !== false, datacenter: t(e.datacenter), origin: t(e.origin),
      version: t(e.version), mock: !!e.mock, state: e.state || 'unknown', reasons: e.reasons || [],
      pull: { state: e.pull?.state || 'none', at: num(e.pull?.at), error: t(e.pull?.error) },
      push: { state: e.push?.state || 'none', lastAt: num(e.push?.lastAt) },
      channels, line: worstChannel(channels), groups,
      deviceTotal: groups.reduce((s, g) => s + g.total, 0),
    };
  });
  // ④ 데이터 흐름 기록에만 있는 엣지 이름
  for (const fe of flow.edges || []) {
    if (fe.registered || ids.has(fe.id)) continue;
    const channels = channelsOf(fe.id, flow);
    edges.push({
      id: fe.id, name: fe.name, registered: false, enabled: true, datacenter: '', origin: '', version: '', mock: false,
      state: 'unknown', reasons: ['not-registered'], unverifiedOnly: !!fe.unverifiedOnly,
      pull: { state: 'none', at: null, error: '' }, push: { state: 'none', lastAt: null },
      channels, line: worstChannel(channels), groups: [], deviceTotal: 0,
    });
  }

  // ── 메인(중앙 직접) ──
  const direct = comm.hub?.direct || {};
  const mainGroups = [];
  for (const k of DEV_KINDS) {
    const list = k === 'idrac' ? idracDirect : listOf(direct, k);
    if (list.length) mainGroups.push(groupOf(k, list, { reportAt: null, reportBasis: 'direct' }));
  }

  // ── 붙일 곳이 없는 장비(⑤) ──
  const unassignedAll = [...(comm.unassigned || []), ...idracUnassigned];
  const unassigned = [];
  for (const k of DEV_KINDS) {
    const list = unassignedAll.filter((x) => x.kind === k);
    if (list.length) unassigned.push(groupOf(k, list));
  }

  // ── 합계 ──
  const byEdgeState = {}; const byLine = Object.fromEntries(CHANNEL_STATES.map((s) => [s, 0]));
  for (const e of edges) { byEdgeState[e.state] = (byEdgeState[e.state] || 0) + 1; byLine[e.line] += 1; }
  const edgeDevices = edges.reduce((s, e) => s + e.deviceTotal, 0);
  const mainDevices = mainGroups.reduce((s, g) => s + g.total, 0);
  const unassignedDevices = unassigned.reduce((s, g) => s + g.total, 0);
  const byKind = Object.fromEntries(DEV_KINDS.map((k) => [k, { edge: 0, main: 0, unassigned: 0 }]));
  for (const e of edges) for (const g of e.groups) byKind[g.kind].edge += g.total;
  for (const g of mainGroups) byKind[g.kind].main += g.total;
  for (const g of unassigned) byKind[g.kind].unassigned += g.total;

  return {
    at: num(p.now) || Date.now(),
    main: {
      version: t(p.central?.version), agentName: t(p.central?.agentName),
      pullIntervalMs: num(comm.hub?.pullIntervalMs), pullerEnabled: !!comm.hub?.pullerEnabled,
      groups: mainGroups, deviceTotal: mainDevices,
    },
    edges: edges.sort((a, b) => (Number(b.registered) - Number(a.registered)) || String(a.name).localeCompare(String(b.name), 'ko')),
    unassigned,
    totals: { edges: edges.length, edgeDevices, mainDevices, unassignedDevices, devices: edgeDevices + mainDevices + unassignedDevices, byEdgeState, byLine, byKind },
    since: num(flow.since),
    rejectsWithoutTime: num(flow.rejectsWithoutTime) || 0,
    // v2.600 WEB2600-04: 인증 실패 집계 칸은 엣지가 아니다 — 노드·합계에서 빠졌고 여기서 개수만 밝힌다.
    unauth: flow.unauth || null,
  };
}
