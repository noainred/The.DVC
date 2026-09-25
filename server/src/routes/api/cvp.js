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
import { isAdminReq, maskPollerStatus } from '../../auth/addressMask.js';
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

const adminOnly = requireRole('admin');
const writer = requireRole('admin', 'operator');
const toolsPerm = requirePerm('tools');
const fullScopeOnly = fullScopeOnlyWith('CVP 네트워크 스위치는 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다.');
const DEVICE_LIST_MAX = 5000;

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
  const totals = { devices: 0, streaming: 0, partsFault: 0, partsWarn: 0, partsUnknown: 0, partsUnread: 0, bgpDown: 0, bgpUnread: 0, portsDown: 0, portsUnread: 0 };
  for (const d of Array.isArray(rows) ? rows : []) {
    totals.devices++;
    if (d.streaming === true) totals.streaming++;
    const p = partsSummary(d.partsList);
    if (p) { totals.partsFault += p.fault; totals.partsWarn += p.warn; totals.partsUnknown += p.unknown; } else totals.partsUnread++;
    if (d.bgpPeers) totals.bgpDown += bgpSummary(d.bgpPeers).down; else totals.bgpUnread++;
    if (d.ports) totals.portsDown += d.ports.down; else totals.portsUnread++;
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
  };
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
  };
}

function maskServer(s, admin) {
  if (admin) return s;
  return { ...s, host: '', username: '' };
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
  res.json({
    enabled: settings.enabled, settings,
    poller: admin ? poller : maskPollerStatus(poller, servers.map((s) => s.host)),
    servers: servers.map((s) => ({ ...maskServer(s, admin), status: statusOf(s), pendingRequest: hasPendingCvpRequest(s.id) })),
    totals,
    orphanRows: rows.length - mine.length,
    edges: edgeCvpSummary(),
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
  const st = statusOf(srv);
  res.json({
    device: publicDevice(det.device, admin),
    parts: det.device.partsList,
    ports: det.ports,
    bgp: det.device.bgpPeers ? { peers: det.device.bgpPeers, summary: bgpSummary(det.device.bgpPeers) } : null,
    partsMissingKinds: det.device.extra?.partsMissingKinds || [],
    usedPaths: st.usedPaths || {}, missing: st.missing || {}, seenFields: st.seenFields || {},
    ...(admin ? {} : { addressHidden: true }),
  });
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
    ...(r.ok ? { deviceCount: r.deviceCount, usedPath: r.usedPath, seenFields: r.seenFields || [] } : { reason: r.reason, error: r.reason, authFailed: !!r.authFailed }),
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

