/**
 * Arista CloudVision(CVP) 수집 화면 라우트(v2.608) — 특수기능 'CVP 네트워크 스위치'(도구 키 `cvp`).
 *
 * 접근 규약(SAN 스위치·스토리지와 같다):
 *  - 조회: `requirePerm('tools')` + **전체 범위 계정만**(CVP 는 vCenter 귀속이 없는 인프라라 범위 계정에 나눌 축이 없다 — v2.525 규약).
 *    비-admin 에는 관리 주소(CVP host·장비 관리 IP·계정명)를 비우고 `addressHidden` 으로 밝힌다(v2.599 AUTHZ-2599-03 기준).
 *  - '지금 수집': requireRole('admin','operator') + tools(상태 변경 — requirePerm 만으로는 역할을 보지 않는다 — v2.590 D1).
 *  - 등록부 CRUD·연결 테스트·설정: adminOnly(자격증명) + 감사로그(비밀 미기재).
 *  - 연결 테스트가 저장 비밀을 물려받으면 **host·계정·인증 방식을 저장값으로 고정**한다(v2.480 — 저장 비밀이 요청자 호스트로 가지 않게).
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { isAdminReq, maskPollerStatus, scrubHosts } from '../../auth/addressMask.js';
import { logAudit } from '../../audit.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { knownAgentNames } from '../../central/knownAgents.js';
import { listServers, getServer, getServerWithSecret, saveServer, deleteServer, agentKeyEq } from '../../cvp/registry.js';
import { loadSettings, saveSettings, LIMITS } from '../../cvp/settings.js';
import { cvpPollerStatus, pollCvpOnce, isPollerBusy, testServerConnection } from '../../cvp/poller.js';
import { getStatus, dropStatus } from '../../cvp/store.js';
import * as cdb from '../../cvp/db.js';
import { partsSummary, bgpSummary } from '../../cvp/parse.js';
import { edgeCvpStatuses, edgeCvpSummary, edgeVersionOf, classifyCvpEdge, MIN_CVP_EDGE_VERSION } from '../../central/cvpEdge.js';
import { allCollectorStatus } from '../../collector/state.js'; // v2.613 CONTRACT2613-04: 엣지 버전 게이트
import { requestCvpCollect, hasPendingCvpRequest, recentCvpCollectDrops } from '../../cvp/collectRequests.js';
import { secretProvided } from '../../util/secretCarry.js';
import { capStr } from '../../util/capStr.js';
import { listDatacenters } from '../../datacenter/store.js';
import { pickAgent, pickDatacenter } from '../../cvp/formChoices.js';
import { runCvpFaultScan, cvpFaultScanStatus } from '../../cvp/faultScan.js';   // v2.640 ③ 장애 전이 판정(중앙)
import { previewParse, PREVIEW_KINDS, PREVIEW_TEXT_MAX } from '../../cvp/preview.js'; // v2.640 ② 파서 시험(왕복 0)
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { fileStamp, localStamp } from '../../util/dayKey.js';
// v2.643: CSV·텍스트 가져오기/내보내기는 관리자 이상 + 'data.csv' 권한(super_admin 항상, admin 은 권한 설정에서 끌 수 있다).
const csvPerm = requirePerm('data.csv');

const adminOnly = requireRole('admin');
const writer = requireRole('admin', 'operator');
const toolsPerm = requirePerm('tools');
const fullScopeOnly = fullScopeOnlyWith('CVP 네트워크 스위치는 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다.');
const DEVICE_LIST_MAX = 5000;
/** v2.641: CPU·메모리 '높음' 경계(%) — 웹 cvpText.SYS_HIGH_PCT 와 같은 값(테스트 대조). */
export const SYS_HIGH_PCT = 80;

/** 중앙 프로세스 기동 시각(silent 판정의 기준 — 보관분은 파일이라 재시작을 넘어 남지만 '기다렸다' 의 기준은 이번 기동이다). */
const CENTRAL_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

/** 그 CVP 의 최근 수집 상태 — 중앙 직접이면 이 노드의 스토어, 엣지 위임이면 그 엣지의 보고. */
function statusOf(srv) {
  if (!String(srv.agent || '').trim()) {
    const st = getStatus(srv.id);
    return st ? { ...pickStatus(st), source: 'central' } : { pending: true, ok: null, source: 'central', note: '이번 기동 뒤 아직 수집하지 않았습니다' };
  }
  // v2.611(CEN2611-02): 대소문자만 다른 보관분이 여럿이면(구버전 중앙이 남긴 것) **가장 최근에 push 한 것** — 삽입 순서로 고르면
  //   옛 정상 행이 현재 오류를 가렸다(재현).
  const st = pickEdgeStatus(edgeCvpStatuses(), srv);
  if (st) return { ...pickStatus(st), source: 'edge', pushedAt: st.pushedAt ?? null };
  // v2.613(CONTRACT2613-04): 보고가 없는 이유를 나눈다 — 구버전(업그레이드) / 버전 미상(수집 서버 연결) / silent(엣지 로그) / 첫 보고 대기.
  //   예전에는 전부 '보고가 아직 없습니다'(= 기다리면 된다)였다. 문장은 웹 `cvpText.serverState` 가 kind 로 만든다.
  const edgeVersion = edgeVersionOf(srv.agent, allCollectorStatus());
  const kind = classifyCvpEdge({ edgeVersion, sinceMs: CENTRAL_STARTED_AT, intervalMs: loadSettings().intervalMs });
  return { pending: true, ok: null, source: 'edge', kind, edgeVersion, minEdgeVersion: MIN_CVP_EDGE_VERSION, note: `엣지(${srv.agent})의 보고가 아직 없습니다` };
}
/** 엣지 보고 중 그 CVP·담당(대소문자 무시)에 맞는 것 — 여럿이면 pushedAt 이 가장 늦은 것(순수 — 테스트 고정). */
export function pickEdgeStatus(list, srv) {
  return (Array.isArray(list) ? list : []).filter((x) => x && x.cvpId === srv.id && agentKeyEq(x.agent, srv.agent))
    .reduce((best, x) => (!best || (Number(x.pushedAt) || 0) > (Number(best.pushedAt) || 0) ? x : best), null);
}

/**
 * 장비 행 → KPI 합계(순수 — 테스트 고정). v2.611(WEB2611-02): BGP·포트를 **읽지 못한 장비 수**도 센다 —
 *   예전엔 조용히 건너뛰어 'down 0' 이 '전부 확인했다' 처럼 보였다.
 */
export function cvpTotals(rows) {
  const totals = { devices: 0, streaming: 0, partsFault: 0, partsWarn: 0, partsUnknown: 0, partsUnread: 0, bgpDown: 0, bgpStateUnknown: 0, bgpUnread: 0, bgpEmpty: 0, portsDown: 0, portsNoLink: 0, portsUnread: 0, portsEmpty: 0,
    cpuHigh: 0, memHigh: 0, sysUnread: 0, cpuMax: null, memMax: null };
  for (const d of Array.isArray(rows) ? rows : []) {
    totals.devices++;
    if (d.streaming === true) totals.streaming++;
    const p = partsSummary(d.partsList);
    if (p) { totals.partsFault += p.fault; totals.partsWarn += p.warn; totals.partsUnknown += p.unknown; } else totals.partsUnread++;
    if (d.bgpPeers) { const b = bgpSummary(d.bgpPeers); totals.bgpDown += b.down; totals.bgpStateUnknown += b.stateUnknown || 0; } else totals.bgpUnread++; // v2.630 A2-03: 모르는 상태는 down 이 아니다
    if (d.ports) { totals.portsDown += d.ports.down; totals.portsNoLink += d.ports.noLink || 0; } else totals.portsUnread++; // v2.630 A2-02
    // v2.641: 빈 응답(경로에 값 없음)으로 못 읽은 장비는 따로 센다 — '형식을 못 읽음' 과 조치가 다르다.
    if (!d.bgpPeers && d.info?.bgpEmpty) totals.bgpEmpty++;
    if (!d.ports && d.info?.portsEmpty) totals.portsEmpty++;
    // v2.641 ③: CPU·메모리 — 80% 이상을 '높음' 으로 센다(임계는 화면 문구와 같은 값). 못 읽은 장비는 sysUnread.
    if (d.cpuPct == null && d.memPct == null) totals.sysUnread++;
    if (d.cpuPct != null) { if (d.cpuPct >= SYS_HIGH_PCT) totals.cpuHigh++; totals.cpuMax = Math.max(totals.cpuMax ?? 0, d.cpuPct); }
    if (d.memPct != null) { if (d.memPct >= SYS_HIGH_PCT) totals.memHigh++; totals.memMax = Math.max(totals.memMax ?? 0, d.memPct); }
  }
  return totals;
}

function pickStatus(st) {
  return {
    ok: st.pending ? null : st.ok === true, pending: st.pending === true, collectedAt: st.collectedAt ?? null, lastAttemptAt: st.lastAttemptAt ?? null,
    durationMs: st.durationMs ?? null, deviceCount: st.deviceCount ?? null, error: st.error ?? null, authStopped: st.authStopped || null,
    usedPaths: st.usedPaths || {}, missing: st.missing || {}, seenFields: st.seenFields || {}, truncated: st.truncated || null, cvpVersion: st.cvpVersion || '',
    ...(st.dbUnavailable ? { dbUnavailable: true } : {}),
    ...(st.partsDueUnread ? { partsDueUnread: true, partsNotTried: Number.isFinite(st.partsNotTried) ? st.partsNotTried : null } : {}), // v2.612 RECENT2612-01
    ...(st.pruneHeld && typeof st.pruneHeld === 'object' ? { pruneHeld: st.pruneHeld } : {}),
    ...(st.samples && typeof st.samples === 'object' ? { samples: st.samples } : {}), // v2.640 ②: 원문 표본(라우트가 admin 에게만 싣는다)
    ...(Array.isArray(st.probes) ? { probes: st.probes } : {}), // v2.641: 경로 탐색 표본(admin 만 — stripSamples 가 뺀다)
    ...(Object.hasOwn(st, 'events') ? { events: st.events } : {}), // v2.641 ④: 이벤트 요약(null = 못 읽음)
  };
}

/** v2.640 ②: 원문 표본은 호스트명·IP·오류 본문이 그대로 들어간다 — 비-admin 응답에서는 통째로 뺀다(가림이 아니라 제거). */
function stripSamples(st) {
  if (!st || typeof st !== 'object' || (!st.samples && !st.probes)) return st;
  const { samples, probes, ...rest } = st; // v2.641: 경로 탐색 표본도 같은 등급(원문 응답 — 관리 IP·피어 IP 가 들어 있다)
  return { ...rest, samplesHidden: true };
}

/** v2.640 ①(AUTHZ2611-06): BGP 피어 주소는 장비 관리 주소와 같은 등급으로 본다 — 비-admin 에는 비운다(화면은 '—'). */
function maskPeers(peers, admin) {
  if (admin || !Array.isArray(peers)) return peers;
  return peers.map((p) => (p && typeof p === 'object' ? { ...p, peer: '' } : p));
}

/** 등록부 담당과 맞는 행만(엣지가 바뀌었는데 옛 엣지 행이 남은 경우를 거짓으로 섞지 않게). */
function rowBelongs(row, servers) {
  const srv = servers.find((s) => s.id === row.cvpId);
  if (!srv) return false;
  return String(srv.agent || '').trim() ? agentKeyEq(row.agent, srv.agent) : row.agent === cdb.LOCAL_AGENT;
}

function publicDevice(d, admin) {
  return {
    key: d.key, cvpId: d.cvpId, agent: d.agent, hostname: d.hostname, model: d.model, serial: d.serial,
    mgmtIp: admin ? d.mgmtIp : '', eosVersion: d.eosVersion, streaming: d.streaming,
    parts: partsSummary(d.partsList), partsAt: d.partsAt,
    bgp: d.bgpPeers ? bgpSummary(d.bgpPeers) : null,
    ports: d.ports, collectedAt: d.collectedAt, telemetry: d.telemetry,
    // v2.641 ②③: CPU·메모리 최신값(못 읽으면 null) · 개요(비-admin 에는 MAC 을 뺀다 — 관리 식별자 등급)
    cpuPct: d.cpuPct ?? null, memPct: d.memPct ?? null, sysAt: d.sysAt ?? null,
    info: d.info ? (admin ? d.info : (({ mac, ...rest }) => rest)(d.info)) : null,
  };
}

function maskServer(s, admin) {
  if (admin) return s;
  return { ...s, host: '', username: '' };
}

/**
 * v2.620(SEC2620-03): 비-admin 응답의 오류 문구에서 주소를 가린다. poller 는 maskPollerStatus 를 거치는데
 * servers[].status.error·edges[].error(엣지 원문 최대 1,000자)는 원문 그대로였다 — 특히 리다이렉트 사유는
 * Location 의 출처(등록부에 없는 주소일 수 있다)를 싣는다. 등록 주소는 표식으로, 그 밖의 URL·IPv4 는 일반 표식으로.
 */
export function maskErrText(v, hosts = []) {
  if (typeof v !== 'string' || !v) return v;
  return scrubHosts(v, hosts)
    .replace(/\bhttps?:\/\/[^\s,)'"]{1,300}/g, '(주소 가림)')
    .replace(/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g, '(주소 가림)');
}

/**
 * v2.621(감사 RECENT-07): 비-admin 응답의 servers[].status 에서 **주소가 실릴 수 있는 문자열 칸 전부**를 가린다.
 *   v2.620 은 status.error 만 가렸는데 status.missing 의 값도 같은 사유 문구다 — 텔레메트리·인벤토리 경로가 리다이렉트되면
 *   `…실패(HTTP 302 → https://출처)`·`경로: 리다이렉트 사유` 를 싣고(cvp/client.js), 토큰 모드에서는 인벤토리가 첫 요청이라
 *   error 는 가려져도 missing.inventory 로 같은 출처(등록 주소)가 원문 그대로 나갔다. authStopped.reason 도 같은 계열이다.
 */
export function maskStatusText(st, hosts = []) {
  if (!st || typeof st !== 'object') return st;
  const out = { ...st, error: maskErrText(st.error, hosts) };
  if (st.missing && typeof st.missing === 'object') {
    out.missing = Object.fromEntries(Object.entries(st.missing).map(([k, v]) => [k, maskErrText(v, hosts)]));
  }
  if (st.authStopped && typeof st.authStopped === 'object') out.authStopped = { ...st.authStopped, reason: maskErrText(st.authStopped.reason, hosts) };
  return out;
}

export function registerCvp(api) {

api.get('/tools/cvp', toolsPerm, fullScopeOnly, async (req, res) => {
  const admin = isAdminReq(req);
  const settings = loadSettings();
  const servers = listServers();
  const { rows, unavailable } = await cdb.listDeviceRows();
  const mine = rows.filter((r) => rowBelongs(r, servers));
  const totals = cvpTotals(mine);
  const poller = cvpPollerStatus();
  const hosts = servers.map((s) => s.host);
  res.json({
    enabled: settings.enabled, settings,
    poller: admin ? poller : maskPollerStatus(poller, servers.map((s) => s.host)),
    servers: servers.map((s) => {
      const st = statusOf(s);
      return { ...maskServer(s, admin), status: admin || !st ? st : stripSamples(maskStatusText(st, hosts)), pendingRequest: hasPendingCvpRequest(s.id) };
    }),
    totals,
    // v2.640 ③: 열린 장애 개수 + 마지막 판정 — 화면 KPI 와 '장애 이력' 카드가 쓴다. DB 불가면 counts 가 unavailable 을 말한다.
    faults: await cdb.faultCounts().catch((e) => ({ unavailable: true, error: capStr(e?.message, 200) })),
    faultScan: faultScanView(cvpFaultScanStatus()),
    orphanRows: rows.length - mine.length,
    edges: admin ? edgeCvpSummary() : edgeCvpSummary().map((e) => ({ ...e, error: maskErrText(e.error, hosts) })),
    collectDrops: recentCvpCollectDrops(),
    ...(unavailable ? { dbUnavailable: true } : {}),
    ...(admin ? { db: await cdb.dbStats() } : { addressHidden: true }),
  });
});

api.get('/tools/cvp/devices', toolsPerm, fullScopeOnly, async (req, res) => {
  const admin = isAdminReq(req);
  const cvpId = typeof req.query.cvpId === 'string' && req.query.cvpId ? req.query.cvpId : null;
  const q = capStr(typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '', 128);
  const servers = listServers();
  const { rows, unavailable } = await cdb.listDeviceRows({ cvpId });
  let list = rows.filter((r) => rowBelongs(r, servers));
  if (q) list = list.filter((d) => [d.hostname, d.model, d.serial, d.eosVersion, d.key, ...(admin ? [d.mgmtIp] : [])].some((x) => String(x || '').toLowerCase().includes(q)));
  const omitted = Math.max(0, list.length - DEVICE_LIST_MAX);
  res.json({ devices: list.slice(0, DEVICE_LIST_MAX).map((d) => publicDevice(d, admin)), omitted, ...(unavailable ? { dbUnavailable: true } : {}), ...(admin ? {} : { addressHidden: true }) });
});

api.get('/tools/cvp/device', toolsPerm, fullScopeOnly, async (req, res) => {
  const admin = isAdminReq(req);
  const cvpId = typeof req.query.cvpId === 'string' ? req.query.cvpId : '';
  const key = typeof req.query.key === 'string' ? req.query.key : '';
  const srv = cvpId ? getServer(cvpId) : null;
  if (!srv || !key) return res.status(404).json({ ok: false, reason: '없는 장비입니다.' });
  const agents = await cdb.agentsForDevice(cvpId, key);
  const agent = String(srv.agent || '').trim() ? agents.find((a) => agentKeyEq(a, srv.agent)) : (agents.includes(cdb.LOCAL_AGENT) ? cdb.LOCAL_AGENT : undefined);
  if (agent === undefined) return res.status(404).json({ ok: false, reason: '수집된 장비 정보가 없습니다.' });
  const det = await cdb.deviceDetail(agent, cvpId, key);
  if (!det) return res.status(404).json({ ok: false, reason: '수집된 장비 정보가 없습니다.' });
  // v2.621(감사 RECENT-07): 장비 상세도 같은 status.missing 을 싣는다 — 목록과 같은 가림(형제 경로).
  const st0 = statusOf(srv);
  const st = admin ? st0 : maskStatusText(st0, listServers().map((x) => x.host));
  res.json({
    device: publicDevice(det.device, admin),
    parts: det.device.partsList,
    ports: det.ports,
    bgp: det.device.bgpPeers ? { peers: maskPeers(det.device.bgpPeers, admin), summary: bgpSummary(det.device.bgpPeers) } : null,
    partsMissingKinds: det.device.extra?.partsMissingKinds || [],
    usedPaths: st.usedPaths || {}, missing: st.missing || {}, seenFields: st.seenFields || {},
    // v2.640 ②: 그 CVP 의 종류별 원문 표본(첫 장비의 응답 앞부분) — admin 만. 장비마다 다르지 않다(표본은 CVP 단위).
    ...(admin ? { samples: st0.samples || null, probes: st0.probes || null } : { addressHidden: true, samplesHidden: true }),
  });
});

// ── v2.641 ③ CPU·메모리 추이 · ④ 이벤트 · ⑤ 포트 사용량 ──────────────────────────
/** 장비 행을 가진 agent 를 등록부 담당으로 고른다(port-series 와 같은 규칙). */
async function agentFor(srv, cvpId, key) {
  const agents = await cdb.agentsForDevice(cvpId, key);
  return String(srv.agent || '').trim() ? agents.find((a) => agentKeyEq(a, srv.agent)) : (agents.includes(cdb.LOCAL_AGENT) ? cdb.LOCAL_AGENT : undefined);
}
api.get('/tools/cvp/device-series', toolsPerm, fullScopeOnly, async (req, res) => {
  const cvpId = typeof req.query.cvpId === 'string' ? req.query.cvpId : '';
  const key = typeof req.query.key === 'string' ? req.query.key : '';
  const srv = cvpId ? getServer(cvpId) : null;
  if (!srv || !key) return res.status(404).json({ ok: false, reason: '없는 장비입니다.' });
  const agent = await agentFor(srv, cvpId, key);
  const s = loadSettings();
  if (agent === undefined) return res.json({ points: [], intervalMs: s.intervalMs, rawRetentionDays: s.rawRetentionDays });
  const hours = Math.max(1, Math.min(24 * 90, Math.floor(Number(req.query.hours)) || 24));
  const r = await cdb.devSeries({ agent, cvpId, key, hours });
  res.json({ ...r, intervalMs: s.intervalMs, rawRetentionDays: s.rawRetentionDays, highPct: SYS_HIGH_PCT });
});

/**
 * CVP 이벤트 목록(최신 순) + 기간 안 심각도별 개수. 이벤트 본문(description)에 장비 관리 IP·피어 IP 가 들어갈 수 있어
 *   비-admin 에는 주소를 가린다(maskErrText — 등록 주소 + 일반 IPv4·URL).
 */
api.get('/tools/cvp/events', toolsPerm, fullScopeOnly, async (req, res) => {
  const admin = isAdminReq(req);
  const servers = listServers();
  const cvpId = typeof req.query.cvpId === 'string' && req.query.cvpId ? req.query.cvpId : null;
  if (cvpId && !servers.some((x) => x.id === cvpId)) return res.status(404).json({ ok: false, reason: '없는 CVP 서버입니다.' });
  const sev = ['critical', 'error', 'warning', 'info', 'debug', 'unknown'].includes(req.query.severity) ? req.query.severity : null;
  const hours = Math.max(1, Math.min(24 * 30, Math.floor(Number(req.query.hours)) || 24));
  const r = await cdb.listEvents({ cvpId, severity: sev, sinceMs: hours * 3600_000, limit: Math.floor(Number(req.query.limit)) || 500 });
  if (r.unavailable) return res.status(503).json({ ok: false, reason: '중앙 CVP DB 를 열지 못했습니다.' });
  const hosts = servers.map((x) => x.host);
  // 등록부 담당과 맞는 행만(옛 담당 엣지의 이벤트를 섞지 않는다 — rowBelongs 와 같은 규칙).
  const byId = new Map(servers.map((x) => [x.id, x]));
  const own = (e) => { const srv = byId.get(e.cvpId); return !!srv && (String(srv.agent || '').trim() ? agentKeyEq(e.agent, srv.agent) : e.agent === cdb.LOCAL_AGENT); };
  // v2.643: 장비 식별자(시리얼·장비 키) → 호스트명·장비 키(상세 열기용). 등록부 담당 행만 쓴다(rowBelongs 와 같은 규칙).
  //   못 찾으면 원문 식별자를 그대로 둔다(호스트명을 지어내지 않는다 — refs 에 hostname 이 없다).
  const idx = new Map();
  for (const d of (await cdb.deviceNameIndex({ cvpId })).rows) {
    if (!own(d)) continue;
    const v = { key: d.key, hostname: d.hostname };
    for (const id of [d.serial, d.key]) { if (id) { const k = `${d.cvpId}\u0000${String(id).toLowerCase()}`; if (!idx.has(k)) idx.set(k, v); } }
  }
  const refsOf = (e) => (Array.isArray(e.devices) ? e.devices : []).map((id) => {
    const hit = idx.get(`${e.cvpId}\u0000${String(id).toLowerCase()}`);
    return hit ? { id: String(id), key: hit.key, hostname: hit.hostname || '' } : { id: String(id) };
  });
  const list = r.events.filter(own).map((e) => ({ ...e, deviceRefs: refsOf(e), cvpName: byId.get(e.cvpId)?.name || e.cvpId, ...(admin ? {} : { title: maskErrText(e.title, hosts), desc: maskErrText(e.desc, hosts) }) }));
  // 이벤트를 읽었는지(서버별 events 요약) — null 이면 '못 읽음', 없으면 '보고 없음'. 화면이 0건과 구분한다.
  const readState = servers.filter((x) => !cvpId || x.id === cvpId).map((x) => { const st = statusOf(x); return { cvpId: x.id, name: x.name || x.id, events: Object.hasOwn(st || {}, 'events') ? st.events : undefined, missing: admin ? (st?.missing?.events || null) : maskErrText(st?.missing?.events || null, hosts) }; });
  res.json({ events: list, counts: r.counts, hours, ...(r.truncated ? { truncated: true, limit: r.limit } : {}), readState, retentionDays: cdb.EVENT_RETENTION_DAYS, ...(admin ? {} : { addressHidden: true }) });
});

/** 포트 사용량 — 전 장비 포트를 사용률 높은 순으로(⑤). 사용률을 계산할 수 없는 포트는 사유별 개수로 밝힌다(0% 로 세지 않는다). */
api.get('/tools/cvp/port-usage', toolsPerm, fullScopeOnly, async (req, res) => {
  const servers = listServers();
  const cvpId = typeof req.query.cvpId === 'string' && req.query.cvpId ? req.query.cvpId : null;
  if (cvpId && !servers.some((x) => x.id === cvpId)) return res.status(404).json({ ok: false, reason: '없는 CVP 서버입니다.' });
  const s = loadSettings();
  // 처리량이 '지금 값' 인지 — 수집 주기의 3배(최소 15분)보다 오래되면 순위에서 뺀다.
  const staleMs = Math.max(15 * 60_000, s.intervalMs * 3);
  const byId = new Map(servers.map((x) => [x.id, x]));
  const own = (p) => { const srv = byId.get(p.cvpId); return !!srv && (String(srv.agent || '').trim() ? agentKeyEq(p.agent, srv.agent) : p.agent === cdb.LOCAL_AGENT); };
  const r = await cdb.portUsage({ cvpId, limit: Math.floor(Number(req.query.limit)) || 200, minUtil: Number(req.query.minUtil) || 0, staleMs, keep: own });
  if (r.unavailable) return res.status(503).json({ ok: false, reason: '중앙 CVP DB 를 열지 못했습니다.' });
  const ports = r.ports.map((p) => ({ ...p, cvpName: byId.get(p.cvpId)?.name || p.cvpId }));
  res.json({ ports, counts: r.counts, staleMs, intervalMs: s.intervalMs, highPct: SYS_HIGH_PCT, ...(r.omitted ? { omitted: r.omitted, limit: r.limit } : {}) });
});

/** v2.640 ③: 판정 상태 → 화면 모양(주소 없음). */
function faultScanView(st) {
  const o = st && typeof st === 'object' ? st : {};
  return { at: o.at ?? null, reason: o.reason ?? null, devices: o.devices ?? null, opened: o.opened ?? null, updated: o.updated ?? null, closed: o.closed ?? null,
    held: o.held ?? null, notified: o.notified ?? null, durationMs: o.durationMs ?? null, error: o.error ?? null, unavailable: o.unavailable === true, pending: o.pending ?? 0, debounceMs: o.debounceMs ?? null };
}

/**
 * v2.640 ③ — 장애 이력: 열린 장애(보류 사유 포함) + 최근 전이 이벤트. 조회는 tools + 전체 범위(목록과 같다).
 * 비-admin 에는 detail(BGP 피어 주소가 들어간다)·오류 문구를 가린다.
 */
api.get('/tools/cvp/faults', toolsPerm, fullScopeOnly, async (req, res) => {
  const admin = isAdminReq(req);
  const cvpId = typeof req.query.cvpId === 'string' && req.query.cvpId ? req.query.cvpId : null;
  const days = Math.max(1, Math.min(365, Math.floor(Number(req.query.days)) || 30));
  const servers = listServers();
  const known = new Set(servers.map((s) => String(s.id)));
  const hosts = servers.map((s) => s.host);
  const nameOf = new Map(servers.map((s) => [String(s.id), s.name || s.id]));
  const mask = (f) => (admin ? f : { ...f, detail: maskErrText(f.detail, hosts), label: f.kind === 'bgp' ? maskErrText(f.label, hosts) : f.label, faultKey: f.kind === 'bgp' ? '(가림)' : f.faultKey });
  let open = []; let events = []; let unavailable = false;
  try {
    const o = await cdb.listOpenFaults({ cvpId });
    const e = await cdb.recentFaultEvents({ sinceMs: days * 86_400_000, limit: 500, cvpId });
    if (o.unavailable || e.unavailable) unavailable = true;
    open = (o.rows || []).filter((f) => known.has(String(f.cvpId))).map((f) => mask({ ...f, cvpName: nameOf.get(String(f.cvpId)) || f.cvpId }));
    events = (e.rows || []).filter((f) => known.has(String(f.cvpId))).map((f) => mask({ ...f, cvpName: nameOf.get(String(f.cvpId)) || f.cvpId }));
  } catch (e) { unavailable = true; console.warn(`[cvp] 장애 이력 조회 실패: ${e.message}`); }
  const settings = loadSettings();
  res.json({
    open, events, days, unavailable,
    counts: await cdb.faultCounts().catch(() => ({ unavailable: true })),
    scan: faultScanView(cvpFaultScanStatus()),
    settings: { enabled: settings.enabled, faultAlerts: settings.faultAlerts === true, faultAlertsClosed: settings.faultAlertsClosed !== false, intervalMs: settings.intervalMs },
    ...(admin ? {} : { addressHidden: true }),
  });
});

/** v2.640 ③ — '지금 판정': 중앙 DB 의 최신값만 다시 판정한다(장비·엣지 왕복 0 — 연타해도 부하 없음). admin·operator. */
api.post('/tools/cvp/faults/scan', writer, toolsPerm, fullScopeOnly, async (req, res) => {
  try {
    const r = await runCvpFaultScan({ reason: 'manual' });
    logAudit({ user: req.user?.username, action: 'CVP 장애 판정 실행', target: 'cvp-faults', detail: `열림 ${r?.opened ?? '?'} · 변경 ${r?.updated ?? '?'} · 닫힘 ${r?.closed ?? '?'} · 보류 ${r?.held ?? '?'}` });
    res.json({ ok: true, result: faultScanView({ ...r, at: r?.at ?? Date.now() }) });
  } catch (e) { res.status(500).json({ ok: false, reason: capStr(e?.message, 300) }); }
});

/**
 * v2.640 ③ — 수동 닫기(adminOnly · 사유 필수 · 감사): 등록 삭제·담당 변경으로 관측이 사라진 장애는 자동으로 닫히지 않는다
 * (보고 부재 ≠ 고침 — v2.548 C5). 화면 문구가 '고쳐졌다는 뜻이 아니다' 를 적는다.
 */
api.post('/tools/cvp/faults/close', adminOnly, toolsPerm, fullScopeOnly, async (req, res) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const pick = (k, n) => (typeof b[k] === 'string' ? capStr(b[k], n) : '');
  const agent = typeof b.agent === 'string' ? capStr(b.agent, 128) : '';
  const cvpId = pick('cvpId', 128); const deviceKey = pick('deviceKey', 128); const faultKey = pick('faultKey', 256); const reason = pick('reason', 300);
  if (!cvpId || !deviceKey || !faultKey) return res.status(400).json({ ok: false, reason: 'cvpId·deviceKey·faultKey 가 필요합니다.' });
  if (!reason.trim()) return res.status(400).json({ ok: false, reason: '닫는 사유를 적어야 합니다(감사 기록).' });
  try {
    const r = await cdb.closeFaultManual({ agent, cvpId, deviceKey, faultKey, reason, user: req.user?.username || '' });
    if (r?.unavailable) return res.status(503).json({ ok: false, reason: '중앙 CVP DB 를 열지 못했습니다.' });
    const closed = Number(r?.closed || 0) > 0;
    logAudit({ user: req.user?.username, action: 'CVP 장애 수동 닫기', target: `${cvpId}/${deviceKey}/${faultKey}`, detail: `${closed ? '닫음' : '대상 없음'} · 사유: ${reason}` });
    if (!closed) return res.status(404).json({ ok: false, reason: '열린 장애가 없습니다(이미 닫혔거나 키가 다릅니다).' });
    res.json({ ok: true, closed: 1 });
  } catch (e) { res.status(500).json({ ok: false, reason: capStr(e?.message, 300) }); }
});

/**
 * v2.640 ② — 파서 시험(adminOnly): 관리자가 CVP 응답 원문을 붙여넣으면 이 포탈의 파서가 무엇을 읽는지 보여준다. **네트워크 왕복 0**,
 * 저장 0. 본문 상한은 express.json 기본(1MB) — 그보다 큰 응답은 앞부분만 붙여넣으라고 화면이 말한다(PREVIEW_TEXT_MAX 는 문자 기준).
 */
api.post('/tools/cvp/parse-preview', adminOnly, toolsPerm, fullScopeOnly, (req, res) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const kind = typeof b.kind === 'string' ? b.kind : '';
  if (!PREVIEW_KINDS.includes(kind)) return res.status(400).json({ ok: false, reason: `kind 는 ${PREVIEW_KINDS.join('·')} 중 하나여야 합니다.`, kinds: PREVIEW_KINDS });
  const text = typeof b.text === 'string' ? b.text : '';
  if (!text.trim()) return res.status(400).json({ ok: false, reason: '응답 원문을 붙여넣으세요.' });
  res.json({ ok: true, kinds: PREVIEW_KINDS, textMax: PREVIEW_TEXT_MAX, preview: previewParse(kind, text) });
});

/**
 * v2.640 ④ — 장비 목록 CSV(목록 라우트와 같은 필터·같은 가림). 파일명은 ASCII(v2.519 규약) · 수식 가드(util/csv) · BOM.
 * 수치가 없으면 빈 칸(0 을 지어내지 않는다).
 */
api.get('/tools/cvp/devices.csv', csvPerm, toolsPerm, fullScopeOnly, async (req, res) => {
  const admin = isAdminReq(req);
  const cvpId = typeof req.query.cvpId === 'string' && req.query.cvpId ? req.query.cvpId : null;
  const q = capStr(typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '', 128);
  const servers = listServers();
  const nameOf = new Map(servers.map((s) => [String(s.id), s.name || s.id]));
  const { rows, unavailable } = await cdb.listDeviceRows({ cvpId });
  if (unavailable) return res.status(503).json({ ok: false, reason: '중앙 CVP DB 를 열지 못했습니다.' });
  let list = rows.filter((r) => rowBelongs(r, servers));
  if (q) list = list.filter((d) => [d.hostname, d.model, d.serial, d.eosVersion, d.key, ...(admin ? [d.mgmtIp] : [])].some((x) => String(x || '').toLowerCase().includes(q)));
  const n = (v) => (v == null ? '' : v);
  const head = ['호스트명', '모델', '시리얼', '관리 주소', 'EOS', '스트리밍', '파트 정상', '파트 주의', '파트 장애', '파트 미확인', '빈 슬롯', '포트 up', '포트 down', '포트 전체', 'BGP established', 'BGP down', 'BGP 피어', 'CVP', '엣지', '수집 시각', '텔레메트리'];
  const lines = [csvLine(head)];
  for (const d of list) {
    const p = partsSummary(d.partsList); const bg = d.bgpPeers ? bgpSummary(d.bgpPeers) : null; const po = d.ports;
    lines.push(csvLine([d.hostname, d.model, d.serial, admin ? d.mgmtIp : '', d.eosVersion, d.streaming === true ? 'yes' : d.streaming === false ? 'no' : '',
      n(p?.ok), n(p?.warn), n(p?.fault), n(p?.unknown), n(p?.absent), n(po?.up), n(po?.down), n(po?.total), n(bg?.established), n(bg?.down), n(bg?.peers),
      nameOf.get(String(d.cvpId)) || d.cvpId, d.agent || '', localStamp(d.collectedAt), d.telemetry || '']));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="cvp-devices-${fileStamp()}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(CSV_BOM + lines.join('\r\n') + '\r\n');
});

api.get('/tools/cvp/port-series', toolsPerm, fullScopeOnly, async (req, res) => {
  const cvpId = typeof req.query.cvpId === 'string' ? req.query.cvpId : '';
  const key = typeof req.query.key === 'string' ? req.query.key : '';
  const port = typeof req.query.port === 'string' ? req.query.port : '';
  const srv = cvpId ? getServer(cvpId) : null;
  if (!srv || !key || !port) return res.status(404).json({ ok: false, reason: '없는 포트입니다.' });
  const agents = await cdb.agentsForDevice(cvpId, key);
  const agent = String(srv.agent || '').trim() ? agents.find((a) => agentKeyEq(a, srv.agent)) : cdb.LOCAL_AGENT;
  if (agent === undefined) return res.json({ points: [], source: 'raw', intervalMs: loadSettings().intervalMs });
  const s = loadSettings();
  const hours = Math.max(1, Math.min(24 * 3650, Math.floor(Number(req.query.hours)) || 24));
  const r = await cdb.portSeries({ agent, cvpId, key, port, hours, rawRetentionDays: s.rawRetentionDays, intervalMs: s.intervalMs });
  res.json(r);
});

api.post('/tools/cvp/collect', writer, toolsPerm, fullScopeOnly, async (req, res) => {
  const only = typeof req.body?.cvpId === 'string' && req.body.cvpId ? req.body.cvpId : null;
  const servers = listServers().filter((s) => s.enabled !== false && (!only || s.id === only));
  if (only && !servers.length) return res.status(404).json({ ok: false, reason: '없는(또는 꺼진) CVP 서버입니다.' });
  const direct = servers.filter((s) => !String(s.agent || '').trim());
  const edge = servers.filter((s) => String(s.agent || '').trim());
  let busy = false;
  if (direct.length) {
    if (isPollerBusy()) busy = true;
    else pollCvpOnce({ manual: true, only: direct.map((s) => s.id), trigger: 'manual' }).catch((e) => console.warn(`[cvp] 수동 수집 실패: ${e.message}`));
  }
  let requested = 0;
  for (const s of edge) { requestCvpCollect(s.id, s.agent); requested++; }
  logAudit({ user: req.user?.username, action: 'CVP 지금 수집', target: only || '(전체)', detail: `중앙 즉시 ${busy ? 0 : direct.length}대${busy ? '(진행 중이라 건너뜀)' : ''} · 엣지 요청 ${requested}대` });
  res.json({ ok: true, direct: busy ? 0 : direct.length, requested, ...(busy ? { busy: true, reason: '이전 수집이 진행 중입니다 — 끝난 뒤 다시 누르세요' } : {}) });
});

// ── 등록부(adminOnly — 자격증명) ────────────────────────────────────────────
api.get('/tools/cvp/servers', adminOnly, toolsPerm, fullScopeOnly, (_req, res) => {
  res.json({ servers: listServers(), agents: knownAgentNames(), datacenters: dcList() });
});

// DataCenter 목록 — 폼 드롭다운과 저장 검증이 같은 목록을 본다(v2.609).
function dcList() {
  try { return listDatacenters().map((d) => ({ id: String(d.id), name: String(d.name || d.id) })); } catch { return []; }
}

const saveRoute = (req, res) => {
  try {
    const input = { ...(req.body && typeof req.body === 'object' ? req.body : {}), ...(req.params.id ? { id: req.params.id } : {}) };
    // 담당 엣지·DataCenter 는 기존 목록의 표기로 맞추고, 목록에 없는 새 값은 거부한다(오타 방지 — v2.609).
    const prev = req.params.id ? getServer(req.params.id) : null;
    const ag = pickAgent(input.agent, knownAgentNames(), prev?.agent || '');
    if (ag.error) return res.status(400).json({ ok: false, reason: ag.error, field: 'agent' });
    const dc = pickDatacenter(input.datacenterId, dcList(), prev?.datacenterId || '');
    if (dc.error) return res.status(400).json({ ok: false, reason: dc.error, field: 'datacenterId' });
    input.agent = ag.value;
    input.datacenterId = dc.value;
    const saved = saveServer(input);
    logAudit({ user: req.user?.username, action: req.params.id ? 'CVP 서버 수정' : 'CVP 서버 등록', target: `${saved.name}(${saved.host})`,
      detail: `${saved.authMode}${saved.agent ? ` 엣지 ${saved.agent}` : ' 중앙 직접'}${saved.droppedSecrets ? ` · 접속 대상 변경으로 저장 비밀 폐기(${saved.droppedSecrets.join(',')})` : ''}` });
    res.json({ ok: true, server: saved });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
};
api.post('/tools/cvp/servers', adminOnly, toolsPerm, fullScopeOnly, (req, res) => saveRoute(req, res));
api.put('/tools/cvp/servers/:id', adminOnly, toolsPerm, fullScopeOnly, (req, res) => saveRoute(req, res));

api.delete('/tools/cvp/servers/:id', adminOnly, toolsPerm, fullScopeOnly, async (req, res) => {
  const srv = getServer(req.params.id);
  if (!deleteServer(req.params.id)) return res.status(404).json({ ok: false, reason: '없는 CVP 서버입니다.' });
  dropStatus(req.params.id);
  try { await cdb.pruneDevices(cdb.LOCAL_AGENT, {}, { cvpIds: listServers().filter((s) => !String(s.agent || '').trim()).map((s) => s.id) }); } catch { /* 다음 주기 폴러가 다시 정리한다 */ }
  // v2.640 ③: 등록을 지우면 그 CVP 의 열린 장애도 지운다(관측이 영영 오지 않으므로 'missing' 보류로 남기면 화면에 유령이 된다). 이벤트 이력은 남긴다.
  try { await cdb.deleteFaultsFor(null, req.params.id); } catch (e) { console.warn(`[cvp] 삭제한 CVP 의 장애 행 정리 실패: ${e.message}`); }
  logAudit({ user: req.user?.username, action: 'CVP 서버 삭제', target: `${srv?.name || ''}(${req.params.id})` });
  res.json({ ok: true });
});

api.post('/tools/cvp/servers/:id/test', adminOnly, toolsPerm, fullScopeOnly, async (req, res) => {
  const saved = getServerWithSecret(req.params.id);
  if (!saved) return res.status(404).json({ ok: false, reason: '없는 CVP 서버입니다.' });
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const mode = b.authMode === 'password' || b.authMode === 'token' ? b.authMode : saved.authMode;
  const newSecret = mode === 'password' ? secretProvided(b.password) : secretProvided(b.token);
  // 저장 비밀을 물려받으면 접속 대상(host·계정·인증 방식)을 저장값으로 고정한다(v2.480).
  const target = newSecret
    ? { ...saved, host: typeof b.host === 'string' && b.host.trim() ? b.host.trim() : saved.host, authMode: mode,
      username: typeof b.username === 'string' ? b.username.trim() : saved.username, verifyTls: typeof b.verifyTls === 'boolean' ? b.verifyTls : saved.verifyTls,
      ...(mode === 'password' ? { password: String(b.password) } : { token: String(b.token).trim() }) }
    : { ...saved, verifyTls: typeof b.verifyTls === 'boolean' ? b.verifyTls : saved.verifyTls };
  if (newSecret) {
    const { baseUrlOf } = await import('../../cvp/registry.js');
    const bu = baseUrlOf(target.host);
    if (bu.issue) return res.status(400).json({ ok: false, reason: bu.issue, error: bu.issue });
  }
  const r = await testServerConnection(newSecret ? { ...target, id: undefined } : target);
  logAudit({ user: req.user?.username, action: 'CVP 연결 테스트', target: `${saved.name}(${newSecret ? target.host : saved.host})`, detail: `${target.authMode}${newSecret ? ' 새 비밀' : ' 저장 비밀'} → ${r.ok ? `성공 ${r.deviceCount}대` : `실패: ${capStr(r.reason, 200)}`}` });
  res.json({
    ok: !!r.ok, ms: r.ms ?? null, ranOn: 'central',
    ...(r.ok ? { deviceCount: r.deviceCount, usedPath: r.usedPath, seenFields: r.seenFields || [], ...(r.cvpVersion ? { cvpVersion: r.cvpVersion } : {}) } : { reason: r.reason, error: r.reason, authFailed: !!r.authFailed }),
    ...(r.sample && typeof r.sample === 'object' ? { sample: r.sample } : {}), // v2.640 ②: 원문 표본(adminOnly 라우트)
    ...(String(saved.agent || '').trim() ? { note: `이 CVP 는 엣지(${saved.agent})가 수집합니다 — 중앙에서 닿지 않는 것은 정상일 수 있습니다(엣지의 다음 수집 결과를 보세요).` } : {}),
  });
});

// ── 설정(adminOnly) ──────────────────────────────────────────────────────────
api.get('/tools/cvp/settings', adminOnly, toolsPerm, fullScopeOnly, (_req, res) => {
  res.json({ settings: loadSettings(), limits: LIMITS });
});
api.put('/tools/cvp/settings', adminOnly, toolsPerm, fullScopeOnly, (req, res) => {
  const before = loadSettings();
  const next = saveSettings(req.body && typeof req.body === 'object' ? req.body : {});
  logAudit({ user: req.user?.username, action: 'CVP 수집 설정 변경', target: 'cvp-settings', detail: JSON.stringify({ before, after: next }).slice(0, 500) });
  res.json({ ok: true, settings: next, limits: LIMITS });
});
}

