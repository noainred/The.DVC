/**
 * 디스크 배드 섹터 분석 라우트(v3.8.0) — 특수 기능 '디스크 배드 섹터 분석' · iDRAC 상세 '디스크 이력' 탭.
 *
 * 설계: `docs/design/idrac-disk-badsector/README.md`(시안 · 결정 · 근거 · 한계).
 *
 * 범위(루트 CLAUDE.md '가림 · 범위는 그 값이 실리는 응답 경로 전부에'):
 *  · 조회는 `tools` 권한 + **범위 계정은 귀속 vCenter(법인)가 허용 집합인 서버만**(iDRAC 서버 분석과 같은 판정 `idracScopeOf` 하나).
 *    귀속 없는 서버는 범위 계정에 보이지 않는다. 서버 단건 조회는 범위 밖이면 404(존재 은닉).
 *  · 점검(장비에 로그인하는 동작)은 admin · operator + 쓰기 범위: '전체' 는 전체 범위(조회 ∧ 쓰기 무제한) 계정만,
 *    법인은 그 vCenter 가 쓰기 범위 안일 때만(조회 밖 404 → 쓰기 밖 403), 서버 1대는 그 서버의 법인이 쓰기 범위 안일 때만.
 *  · 설정(자동 점검 · 메일 · 법인 담당자)은 admin + **조회 · 쓰기 모두** 전체 범위(반증 #5 — 쓰기만 줄인 admin 이 전 법인 자동 점검을 켜지 못하게).
 *  · 작업 조각의 권한은 **조각이 맡은 서버 집합**으로 판정한다(반증 #4 — 엣지 이름으로 보면 중앙 직결 조각 '' 을 모든 법인이 함께 쓴다):
 *    보기는 그 서버가 전부 조회 범위 안일 때만, 멈추기 · 다시 보내기는 조회 밖 404 → 쓰기 밖 403(`unitAccess` 하나).
 *  · 서버는 (엣지, id)로 찾는다(반증 #16 — 다른 엣지에 같은 사설 IP id 가 있다).
 *  · 엣지 포탈에서는 점검 · 작업 조작 · 설정을 하지 않는다(409) — 커서 파일을 중앙 작업과 함께 쓰므로 엣지 단독 점검이 중앙의 구간을 건너뛰게 한다(반증 #1).
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { fullReadWriteScopeOnlyWith } from '../admin/shared.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { scopedVcenterIds, inUserWriteScope, isFullReadWriteScope } from '../../auth/scope.js';
import { idracScopeOf, idracInScope, idracServerVcOf, idracCorpIndex } from '../admin/idracCore.js';
import { hostVcByTag } from '../../insights/analysisServers.js';
import { allPhysicalServers } from '../../idrac/corpAttribution.js';
import { corpIdentityOf } from '../../vcenter/hostCorp.js';
import { loadAll, loadServer, diskBadDbStatus, diskBadGeneration } from '../../diskbad/db.js';
import { buildFleet, serverView, labelsPayload } from '../../diskbad/summary.js';
import { createJob, listJobs, stopJob, retryUnit, unitsForAll, autoInfo, setCorpResolver, getJob, isAgentBusy } from '../../diskbad/jobs.js';
import { loadDiskBadSettings, saveDiskBadSettings, diskBadSettingsLoadError } from '../../diskbad/settings.js';
import { diskBadMailInfo } from '../../diskbad/notify.js';
import { diskBadEdgeStatus } from '../../diskbad/edge.js';
import { config } from '../../config.js';
import { isAdminDetailUser } from '../../auth/demoGuest.js';

const toolsPerm = requirePerm('tools');
const writeRole = requireRole('admin', 'operator');
const adminOnly = requireRole('admin');
const fullScopeOnly = fullReadWriteScopeOnlyWith('디스크 배드 섹터 설정은 전 법인 공용이라 조회 · 쓰기 모두 전체 범위(vCenter 제한 없는) 계정만 바꿀 수 있습니다.');
const EDGE_NODE = { ok: false, reason: '엣지 포탈에서는 점검하지 않습니다 — 중앙 포탈의 디스크 배드 섹터 분석에서 점검합니다(이 법인 서버는 중앙이 낸 작업으로 이 엣지가 읽습니다).' };
const isEdge = () => !!config.agent.centralUrl;
const busyBody = (who) => ({ ok: false, busy: true, reason: `${who}가 다른 점검을 하는 중이라 시작하지 못했습니다 — 점검 탭에서 진행 중인 작업이 끝난 뒤(또는 그 작업을 중단한 뒤) 다시 누르세요.` });
const NOT_FOUND = { ok: false, reason: '서버를 찾을 수 없습니다.' };
const t = (v) => String(v ?? '').trim();
const isHpe = (s) => { const v = t(s?.vendor).toLowerCase(); return v === 'hpe' || v === 'hp' || v.includes('hewlett'); };

/** vCenter id → 법인 신원. */
function corpTable(snap) {
  const m = new Map();
  for (const vc of snap?.vcenters || []) if (vc?.id) m.set(String(vc.id), corpIdentityOf(vc));
  return m;
}

/** 물리 서버 → {agent, id, name, corp, vc, excluded}. 범위 계정이면 귀속 서버만. */
export function physicalServersFor(req, { snap = store.get() } = {}) {
  const sc = idracScopeOf(req);
  const tagMap = sc?.tagMap || hostVcByTag();
  const index = sc?.index || idracCorpIndex(snap);
  const corps = corpTable(snap);
  const out = [];
  let list = [];
  try { list = allPhysicalServers(); } catch { list = []; }
  for (const s of list) {
    if (!s?.id || t(s.type) === 'ome') continue;
    if (sc && !idracInScope(sc, s)) continue;
    const vc = idracServerVcOf(s, tagMap, index) || '';
    const c = vc ? (corps.get(vc) || { id: vc, name: vc, country: null, city: null }) : null;
    out.push({
      agent: s.remote ? t(s.collectorId).toLowerCase() : '', id: String(s.id), name: t(s.name) || t(s.host) || String(s.id),
      vc, corp: c ? { id: c.id, name: c.name, country: c.country || null, city: c.city || null } : null,
      excluded: isHpe(s), remote: !!s.remote,
    });
  }
  return { servers: out, scoped: !!sc, sc };
}

// 메일이 법인을 찾을 때 쓰는 판정 — 범위 없는 판정(시스템 동작)이다. 메일 한 번에 표를 한 번 만든다(반증 #12).
setCorpResolver(() => {
  const m = new Map();
  try {
    for (const s of physicalServersFor({ user: null }).servers) if (s.corp) m.set(`${s.agent}|${s.id}`, { id: s.corp.id, name: s.corp.name });
  } catch { /* 법인을 못 찾으면 '법인 귀속 없음' */ }
  return (agent, serverId) => m.get(`${String(agent || '').toLowerCase()}|${serverId}`) || null;
});

// 응답 캐시 — DB 세대 · 범위 · 법인 필터가 같고 20초 안이면 다시 계산하지 않는다(서버 1,100대 판정).
// 세대가 바뀌면(적재) 지운다 — '무엇이 지워지는가' 의 답은 '그 세대의 집계 전부'.
// 반증 #11: 캐시를 **DB 를 읽기 전에** 본다 — 맞으면 DB 도 집계도 건너뛴다(db.js loadAll 도 세대 단위로 캐시한다).
const _memo = new Map();
const MEMO_MS = 20_000;
function memoGet(key, gen) {
  const hit = _memo.get(key);
  return hit && hit.gen === gen && Date.now() - hit.at < MEMO_MS ? hit.v : undefined;
}
function memoSet(key, gen, v) {
  if (_memo.size > 200) _memo.clear();
  _memo.set(key, { gen, at: Date.now(), v });
}

/** (엣지, id)로 서버 찾기. agent 를 안 주면 id 가 하나뿐일 때만 — 둘 이상이면 'ambiguous'(지어내지 않는다). */
function findServer(servers, id, agent) {
  const hits = servers.filter((x) => x.id === String(id ?? ''));
  if (agent != null) return hits.find((x) => x.agent === String(agent).trim().toLowerCase()) || null;
  if (hits.length > 1) return 'ambiguous';
  return hits[0] || null;
}
const AMBIGUOUS = { ok: false, reason: '같은 id 의 서버가 여러 엣지에 있습니다 — agent 를 함께 보내세요.' };

function corpOptions(servers) {
  const m = new Map();
  for (const s of servers) {
    if (!s.corp) continue;
    if (!m.has(s.corp.id)) m.set(s.corp.id, { ...s.corp, servers: 0 });
    m.get(s.corp.id).servers += 1;
  }
  return [...m.values()].sort((a, b) => String(a.country || '').localeCompare(String(b.country || '')) || String(a.name).localeCompare(String(b.name)));
}

/** 조각이 맡은 서버 키(serverIds 가 없으면 그 엣지 · 중앙 직결의 서버 전부 — 범위 없는 목록에서). */
function unitKeys(u, allServers) {
  const a = String(u.agent || '').toLowerCase();
  if (Array.isArray(u.serverIds)) return u.serverIds.map((id) => `${a}|${id}`);
  return allServers.filter((s) => s.agent === a).map((s) => `${a}|${s.id}`);
}

/** 권한 판단 재료(요청마다 한 번). */
function unitCtx(req) {
  const mine = physicalServersFor(req);
  let all = mine.servers;
  if (mine.scoped) { try { all = physicalServersFor({ user: null }).servers; } catch { all = []; } }
  return { scoped: mine.scoped, visible: new Map(mine.servers.map((s) => [`${s.agent}|${s.id}`, s])), all, snap: store.get() };
}

/**
 * 조각 하나를 이 계정이 보거나 조작할 수 있는가(반증 #4 — 판정 하나). 조회 밖 404 → 쓰기 밖 403.
 * @returns {200|403|404}
 */
export function unitAccess(req, u, ctx, { write = false } = {}) {
  if (isFullReadWriteScope(req.user, ctx.snap)) return 200;
  const keys = unitKeys(u, ctx.all);
  if (!keys.length) return ctx.scoped ? 404 : 403;
  if (ctx.scoped && keys.some((k) => !ctx.visible.has(k))) return 404;
  if (!write) return 200;
  for (const k of keys) {
    const s = ctx.visible.get(k);
    if (!s || !s.vc || !inUserWriteScope(req.user, ctx.snap, s.vc)) return 403;
  }
  return 200;
}

const sumUnits = (units, k) => units.reduce((acc, u) => acc + (Number(u[k]) || 0), 0);

/** 이 계정에 보일 작업 — 조각을 서버 집합으로 거르고, 합계 · 실행자는 보이는 조각 기준으로 다시 싣는다. */
function jobsFor(req, ctx = unitCtx(req)) {
  const all = listJobs();
  if (!ctx.scoped) return all;
  const me = req.user?.username || '';
  const out = [];
  for (const j of all) {
    const units = j.units.filter((u) => unitAccess(req, u, ctx) === 200);
    if (!units.length) continue;
    out.push({
      ...j, units, by: ['auto', 'demo', me].includes(j.by) ? j.by : '',
      total: units.every((u) => u.total != null) ? sumUnits(units, 'total') : null,
      done: sumUnits(units, 'done'), failed: sumUnits(units, 'failed'), excluded: sumUnits(units, 'excluded'), newRecords: sumUnits(units, 'newRecords'),
      running: units.some((u) => u.state === 'queued' || u.state === 'running'),
    });
  }
  return out;
}

export function registerDiskBad(api) {
  api.get('/tools/disk-bad', toolsPerm, async (req, res) => {
    const { servers, scoped } = physicalServersFor(req);
    const corpId = t(req.query.corp);
    if (corpId && !servers.some((s) => s.corp?.id === corpId)) return res.status(404).json({ ok: false, reason: '법인을 찾을 수 없습니다.' });
    const status = await diskBadDbStatus();
    const picked = corpId ? servers.filter((s) => s.corp?.id === corpId) : servers;
    const allowed = scopedVcenterIds(req.user, store.get());
    const key = `${allowed ? [...allowed].sort().join(',') : '*'}|${corpId}`;
    const gen = diskBadGeneration();
    let fleet = memoGet(key, gen);
    if (fleet === undefined) {
      const db = await loadAll();
      fleet = db ? buildFleet({ servers: picked, db }) : null;
      if (db) memoSet(key, gen, fleet);
    }
    const isAdmin = isAdminDetailUser(req.user) && !scoped;
    res.json({
      ok: true, scoped, corp: corpId || null, corps: corpOptions(servers), fleet, labels: labelsPayload(),
      db: { available: status.available, error: status.available ? '' : status.error, records: status.records },
      jobs: jobsFor(req).slice(0, 10), auto: autoInfo(),
      canScanAll: isFullReadWriteScope(req.user, store.get()) && ['admin', 'operator'].includes(req.user?.role),
      ...(isAdmin ? { settings: loadDiskBadSettings(), settingsLoadError: diskBadSettingsLoadError(), mail: diskBadMailInfo() } : {}),
      node: config.agent.centralUrl ? { role: 'edge', edge: diskBadEdgeStatus() } : { role: 'central' },
    });
  });

  // 진행 표시용 가벼운 조회 — 집계를 다시 하지 않는다(화면이 점검 중일 때만 10초마다 부른다).
  api.get('/tools/disk-bad/jobs', toolsPerm, (req, res) => {
    res.json({ ok: true, jobs: jobsFor(req).slice(0, 10), auto: autoInfo(), generation: diskBadGeneration() });
  });

  api.get('/tools/disk-bad/server/:id', toolsPerm, async (req, res) => {
    const { servers } = physicalServersFor(req);
    const s = findServer(servers, req.params.id, typeof req.query.agent === 'string' ? req.query.agent : null);
    if (s === 'ambiguous') return res.status(409).json(AMBIGUOUS);
    if (!s) return res.status(404).json(NOT_FOUND);
    const d = await loadServer(s.agent, s.id);
    if (!d) return res.json({ ok: true, server: s, dbUnavailable: true, labels: labelsPayload() });
    const v = serverView(d.server, d.records, d.serials);
    const running = listJobs().some((j) => j.units.some((u) => (u.agent === s.agent) && (u.state === 'queued' || u.state === 'running')));
    // 장비 진단(그 장비가 무엇을 주는가 — 펌웨어 판 · 속성 이름 등)은 관리자 판본에만 싣는다.
    const probe = isAdminDetailUser(req.user) && d.server?.probe ? { probe: d.server.probe, probeAt: d.server.probeAt } : {};
    // canProbe: 이 계정이 장비 진단을 볼 수 있는가 — 화면이 '아직 없다 · 받는 방법' 을 관리자에게만 안내한다.
    res.json({ ok: true, server: s, view: v, scanned: !!d.server, running, labels: labelsPayload(), excluded: s.excluded, canProbe: isAdminDetailUser(req.user), ...probe });
  });

  api.post('/tools/disk-bad/scan', writeRole, toolsPerm, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const scope = ['all', 'corp', 'server'].includes(body.scope) ? body.scope : '';
    const mode = body.mode === 'full' ? 'full' : 'incremental';
    const snap = store.get();
    if (!scope) return res.status(400).json({ ok: false, reason: '범위(scope)는 all · corp · server 중 하나입니다.' });
    if (isEdge()) return res.status(409).json(EDGE_NODE);
    const by = req.user?.username || '';
    if (scope === 'all') {
      if (!isFullReadWriteScope(req.user, snap)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '전체 점검은 전체 범위(조회 · 쓰기 제한 없는) 계정만 실행할 수 있습니다.' });
      const allUnits = await unitsForAll();
      if (allUnits.length && allUnits.every((u) => isAgentBusy(u.agent))) return res.status(409).json(busyBody('모든 노드'));
      const job = createJob({ scope: 'all', targetLabel: '전체', mode, by, units: allUnits });
      logAudit({ user: by, action: '디스크 배드 섹터 점검 시작', target: '전체', detail: `${mode === 'full' ? '처음부터' : '새 로그만'} · 작업 ${job.id}`, ip: req.ip });
      return res.json({ ok: true, job });
    }
    const { servers } = physicalServersFor(req);
    let picked = [];
    let label = '';
    let target = '';
    if (scope === 'corp') {
      target = t(body.corpId);
      picked = servers.filter((s) => s.corp?.id === target && !s.excluded);
      if (!servers.some((s) => s.corp?.id === target)) return res.status(404).json({ ok: false, reason: '법인을 찾을 수 없습니다.' });
      if (!inUserWriteScope(req.user, snap, target)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '이 법인은 쓰기 범위 밖입니다 — 점검은 장비에 로그인하는 동작이라 쓰기 범위가 필요합니다.' });
      label = picked[0]?.corp?.name || target;
    } else {
      target = t(body.serverId);
      const s = findServer(servers, target, typeof body.agent === 'string' ? body.agent : null);
      if (s === 'ambiguous') return res.status(409).json(AMBIGUOUS);
      if (!s) return res.status(404).json(NOT_FOUND);
      if (s.excluded) return res.status(400).json({ ok: false, reason: 'HPE iLO 서버는 점검 대상이 아닙니다.' });
      if (!s.vc ? !isFullReadWriteScope(req.user, snap) : !inUserWriteScope(req.user, snap, s.vc)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '이 서버의 법인은 쓰기 범위 밖입니다.' });
      picked = [s]; label = s.name;
    }
    if (!picked.length) return res.status(400).json({ ok: false, reason: '점검할 서버가 없습니다(HPE iLO 는 제외됩니다).' });
    const byAgent = new Map();
    for (const s of picked) { if (!byAgent.has(s.agent)) byAgent.set(s.agent, []); byAgent.get(s.agent).push(s.id); }
    const units = [...byAgent.entries()].map(([agent, ids]) => ({ agent, kind: agent ? 'edge' : 'local', serverIds: ids, label: agent || '중앙 직결' }));
    // 그 노드가 다른 점검을 하는 중이면 조각이 'busy' 로 건너뛰어진다 — 전부 그렇다면 **시작하지 않은 것**이다. 작업을 만들지 않고 그 사실을 답한다
    //   (v3.8.3 — 화면이 '점검을 보냈습니다' 라고만 해서, 서버 한 대 점검이 조용히 건너뛰어진 것을 사용자가 알 수 없었다).
    if (units.every((u) => isAgentBusy(u.agent))) return res.status(409).json(busyBody(scope === 'server' ? '이 서버를 맡은 노드' : '이 법인의 노드'));
    const job = createJob({ scope, target, targetLabel: label, mode, by, manual: scope === 'server', units });
    logAudit({ user: by, action: '디스크 배드 섹터 점검 시작', target: label || target, detail: `${scope === 'corp' ? '법인' : '서버'} · ${mode === 'full' ? '처음부터' : '새 로그만'} · 조각 ${units.length}개 · 작업 ${job.id}`, ip: req.ip });
    res.json({ ok: true, job });
  });

  /** 조각 하나를 찾고 권한을 본다 — 작업이 없거나 조회 범위 밖이면 404, 쓰기 범위 밖이면 403. */
  const unitFor = (req, res, agent) => {
    const j = getJob(req.params.id);
    if (!j) { res.status(404).json({ ok: false, reason: '작업을 찾을 수 없습니다.' }); return null; }
    const u = j.units.find((x) => x.agent === String(agent ?? '').trim().toLowerCase());
    const code = u ? unitAccess(req, u, unitCtx(req), { write: true }) : 404;
    if (code === 404) { res.status(404).json({ ok: false, reason: '작업 조각을 찾을 수 없습니다.' }); return null; }
    if (code === 403) { res.status(403).json({ ok: false, error: 'forbidden', reason: '이 조각이 맡은 서버 가운데 쓰기 범위 밖이 있습니다.' }); return null; }
    return { j, u };
  };

  api.post('/tools/disk-bad/jobs/:id/stop', writeRole, toolsPerm, (req, res) => {
    if (isEdge()) return res.status(409).json(EDGE_NODE);
    const agent = req.body?.agent;
    if (agent == null) {
      if (!getJob(req.params.id)) return res.status(404).json({ ok: false, reason: '작업을 찾을 수 없습니다.' });
      if (!isFullReadWriteScope(req.user, store.get())) return res.status(403).json({ ok: false, error: 'forbidden', reason: '작업 전체 중단은 전체 범위 계정만 — 법인 조각을 골라 멈추세요.' });
    } else if (!unitFor(req, res, agent)) return undefined;
    const r = stopJob(req.params.id, agent == null ? null : String(agent));
    logAudit({ user: req.user?.username || '', action: '디스크 배드 섹터 점검 중단', target: req.params.id, detail: `조각 ${agent == null ? '전부' : (String(agent) || '중앙 직결')}`, ip: req.ip });
    res.json({ ok: true, job: r });
  });

  api.post('/tools/disk-bad/jobs/:id/retry', writeRole, toolsPerm, (req, res) => {
    if (isEdge()) return res.status(409).json(EDGE_NODE);
    const agent = String(req.body?.agent ?? '');
    if (!unitFor(req, res, agent)) return undefined;
    const r = retryUnit(req.params.id, agent);
    if (!r) return res.status(404).json({ ok: false, reason: '다시 보낼 조각이 없습니다(진행 중이거나 작업이 없습니다).' });
    if (r.busy) return res.status(409).json({ ok: false, reason: '이 법인에 진행 중인 다른 점검이 있습니다.' });
    logAudit({ user: req.user?.username || '', action: '디스크 배드 섹터 점검 다시 보내기', target: req.params.id, detail: `조각 ${agent || '중앙 직결'}`, ip: req.ip });
    res.json({ ok: true, job: r });
  });

  api.put('/tools/disk-bad/settings', adminOnly, fullScopeOnly, (req, res) => {
    if (isEdge()) return res.status(409).json(EDGE_NODE);
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const patch = {};
    for (const k of ['autoEnabled', 'intervalHours', 'mailEnabled', 'corpTo']) if (k in b) patch[k] = b[k];
    let next;
    try { next = saveDiskBadSettings(patch); } catch (e) { return res.status(500).json({ ok: false, reason: `저장 실패: ${String(e?.message || e).slice(0, 200)}` }); }
    logAudit({ user: req.user?.username || '', action: '디스크 배드 섹터 설정 저장', target: 'disk-bad-settings', detail: `자동 ${next.autoEnabled ? `켜짐(${next.intervalHours}시간)` : '꺼짐'} · 메일 ${next.mailEnabled ? '켜짐' : '꺼짐'} · 법인 담당자 ${Object.keys(next.corpTo).length}곳`, ip: req.ip });
    res.json({ ok: true, settings: next, auto: autoInfo() });
  });
}
