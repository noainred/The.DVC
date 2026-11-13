/**
 * 디스크 배드 섹터 분석 라우트(v2.915) — 특수 기능 '디스크 배드 섹터 분석' · iDRAC 상세 '디스크 이력' 탭.
 *
 * 설계: `docs/design/idrac-disk-badsector/README.md`(시안 · 결정 · 근거 · 한계).
 *
 * 범위(루트 CLAUDE.md '가림 · 범위는 그 값이 실리는 응답 경로 전부에'):
 *  · 조회는 `tools` 권한 + **범위 계정은 귀속 vCenter(법인)가 허용 집합인 서버만**(iDRAC 서버 분석과 같은 판정 `idracScopeOf` 하나).
 *    귀속 없는 서버는 범위 계정에 보이지 않는다. 서버 단건 조회는 범위 밖이면 404(존재 은닉).
 *  · 점검(장비에 로그인하는 동작)은 admin · operator + 쓰기 범위: '전체' 는 전체 범위(조회 ∧ 쓰기 무제한) 계정만,
 *    법인은 그 vCenter 가 쓰기 범위 안일 때만(조회 밖 404 → 쓰기 밖 403), 서버 1대는 그 서버의 법인이 쓰기 범위 안일 때만.
 *  · 설정(자동 점검 · 메일 · 법인 담당자)은 admin + 전체 범위.
 *  · 작업 목록은 범위 계정에 자기 엣지 조각만 싣는다.
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { scopedVcenterIds, inUserWriteScope, isFullReadWriteScope } from '../../auth/scope.js';
import { idracScopeOf, idracInScope, idracServerVcOf, idracCorpIndex } from '../admin/idracCore.js';
import { hostVcByTag } from '../../insights/analysisServers.js';
import { allPhysicalServers } from '../../idrac/corpAttribution.js';
import { corpIdentityOf } from '../../vcenter/hostCorp.js';
import { loadAll, loadServer, diskBadDbStatus, diskBadGeneration } from '../../diskbad/db.js';
import { buildFleet, serverView, labelsPayload } from '../../diskbad/summary.js';
import { createJob, listJobs, stopJob, retryUnit, unitsForAll, autoStatus, setCorpResolver, getJob } from '../../diskbad/jobs.js';
import { loadDiskBadSettings, saveDiskBadSettings, diskBadSettingsLoadError } from '../../diskbad/settings.js';
import { diskBadMailStatus } from '../../diskbad/notify.js';
import { diskBadEdgeStatus } from '../../diskbad/edge.js';
import { config } from '../../config.js';
import { isAdminDetailUser } from '../../auth/demoGuest.js';

const toolsPerm = requirePerm('tools');
const writeRole = requireRole('admin', 'operator');
const adminOnly = requireRole('admin');
const fullScopeOnly = fullScopeOnlyWith('디스크 배드 섹터 설정은 전 법인 공용이라 전체 범위(vCenter 제한 없는) 계정만 바꿀 수 있습니다.');
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

// 메일 · 작업 진행이 법인을 찾을 때 쓰는 판정 — 범위 없는 판정(시스템 동작)이다.
setCorpResolver((agent, serverId) => {
  try {
    const { servers } = physicalServersFor({ user: null });
    const s = servers.find((x) => x.agent === String(agent || '').toLowerCase() && x.id === String(serverId));
    return s?.corp ? { id: s.corp.id, name: s.corp.name } : null;
  } catch { return null; }
});

// 응답 캐시 — DB 세대 · 범위 · 법인 필터가 같고 20초 안이면 다시 계산하지 않는다(서버 1,100대 판정).
// 세대가 바뀌면(적재) 지운다 — '무엇이 지워지는가' 의 답은 '그 세대의 집계 전부'.
const _memo = new Map();
const MEMO_MS = 20_000;
function memoFleet(key, gen, fn) {
  const hit = _memo.get(key);
  if (hit && hit.gen === gen && Date.now() - hit.at < MEMO_MS) return hit.v;
  const v = fn();
  if (_memo.size > 200) _memo.clear();
  _memo.set(key, { gen, at: Date.now(), v });
  return v;
}

function corpOptions(servers) {
  const m = new Map();
  for (const s of servers) {
    if (!s.corp) continue;
    if (!m.has(s.corp.id)) m.set(s.corp.id, { ...s.corp, servers: 0 });
    m.get(s.corp.id).servers += 1;
  }
  return [...m.values()].sort((a, b) => String(a.country || '').localeCompare(String(b.country || '')) || String(a.name).localeCompare(String(b.name)));
}

/** 범위 계정에 보일 작업 — 자기 엣지 조각만. */
function jobsFor(req, servers, scoped) {
  const all = listJobs();
  if (!scoped) return all;
  const agents = new Set(servers.map((s) => s.agent));
  return all.map((j) => ({ ...j, units: j.units.filter((u) => agents.has(u.agent)) })).filter((j) => j.units.length);
}

export function registerDiskBad(api) {
  api.get('/tools/disk-bad', toolsPerm, async (req, res) => {
    const { servers, scoped } = physicalServersFor(req);
    const corpId = t(req.query.corp);
    if (corpId && !servers.some((s) => s.corp?.id === corpId)) return res.status(404).json({ ok: false, reason: '법인을 찾을 수 없습니다.' });
    const db = await loadAll();
    const status = await diskBadDbStatus();
    const picked = corpId ? servers.filter((s) => s.corp?.id === corpId) : servers;
    const allowed = scopedVcenterIds(req.user, store.get());
    const key = `${allowed ? [...allowed].sort().join(',') : '*'}|${corpId}`;
    const fleet = db ? memoFleet(key, diskBadGeneration(), () => buildFleet({ servers: picked, db })) : null;
    const isAdmin = isAdminDetailUser(req.user) && !scoped;
    res.json({
      ok: true, scoped, corp: corpId || null, corps: corpOptions(servers), fleet, labels: labelsPayload(),
      db: { available: status.available, error: status.available ? '' : status.error, records: status.records },
      jobs: jobsFor(req, servers, scoped).slice(0, 10), auto: autoStatus(),
      canScanAll: isFullReadWriteScope(req.user, store.get()) && ['admin', 'operator'].includes(req.user?.role),
      ...(isAdmin ? { settings: loadDiskBadSettings(), settingsLoadError: diskBadSettingsLoadError(), mail: diskBadMailStatus() } : {}),
      node: config.agent.centralUrl ? { role: 'edge', edge: diskBadEdgeStatus() } : { role: 'central' },
    });
  });

  // 진행 표시용 가벼운 조회 — 집계를 다시 하지 않는다(화면이 점검 중일 때만 10초마다 부른다).
  api.get('/tools/disk-bad/jobs', toolsPerm, (req, res) => {
    const { servers, scoped } = physicalServersFor(req);
    res.json({ ok: true, jobs: jobsFor(req, servers, scoped).slice(0, 10), auto: autoStatus(), generation: diskBadGeneration() });
  });

  api.get('/tools/disk-bad/server/:id', toolsPerm, async (req, res) => {
    const { servers } = physicalServersFor(req);
    const s = servers.find((x) => x.id === String(req.params.id));
    if (!s) return res.status(404).json(NOT_FOUND);
    const d = await loadServer(s.agent, s.id);
    if (!d) return res.json({ ok: true, server: s, dbUnavailable: true, labels: labelsPayload() });
    const v = serverView(d.server, d.records, d.serials);
    const running = listJobs().some((j) => j.units.some((u) => (u.agent === s.agent) && (u.state === 'queued' || u.state === 'running')));
    res.json({ ok: true, server: s, view: v, scanned: !!d.server, running, labels: labelsPayload(), excluded: s.excluded });
  });

  api.post('/tools/disk-bad/scan', writeRole, toolsPerm, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const scope = ['all', 'corp', 'server'].includes(body.scope) ? body.scope : '';
    const mode = body.mode === 'full' ? 'full' : 'incremental';
    const snap = store.get();
    if (!scope) return res.status(400).json({ ok: false, reason: '범위(scope)는 all · corp · server 중 하나입니다.' });
    const by = req.user?.username || '';
    if (scope === 'all') {
      if (!isFullReadWriteScope(req.user, snap)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '전체 점검은 전체 범위(조회 · 쓰기 제한 없는) 계정만 실행할 수 있습니다.' });
      const job = createJob({ scope: 'all', targetLabel: '전체', mode, by, units: await unitsForAll() });
      logAudit(req, 'diskbad.scan', { scope, mode, job: job.id });
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
      const s = servers.find((x) => x.id === target);
      if (!s) return res.status(404).json(NOT_FOUND);
      if (s.excluded) return res.status(400).json({ ok: false, reason: 'HPE iLO 서버는 점검 대상이 아닙니다.' });
      if (!s.vc ? !isFullReadWriteScope(req.user, snap) : !inUserWriteScope(req.user, snap, s.vc)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '이 서버의 법인은 쓰기 범위 밖입니다.' });
      picked = [s]; label = s.name;
    }
    if (!picked.length) return res.status(400).json({ ok: false, reason: '점검할 서버가 없습니다(HPE iLO 는 제외됩니다).' });
    const byAgent = new Map();
    for (const s of picked) { if (!byAgent.has(s.agent)) byAgent.set(s.agent, []); byAgent.get(s.agent).push(s.id); }
    const units = [...byAgent.entries()].map(([agent, ids]) => ({ agent, kind: agent ? 'edge' : 'local', serverIds: ids, label: agent || '중앙 직결' }));
    const job = createJob({ scope, target, targetLabel: label, mode, by, manual: scope === 'server', units });
    logAudit(req, 'diskbad.scan', { scope, target, mode, job: job.id, units: units.length });
    res.json({ ok: true, job });
  });

  /** 범위 계정이 손댈 수 있는 조각인가 — 자기 엣지(서버가 범위 안)만. */
  const unitAllowed = (req, agent) => {
    const { servers, scoped } = physicalServersFor(req);
    if (!scoped) return true;
    const snap = store.get();
    return servers.some((s) => s.agent === String(agent ?? '').toLowerCase() && s.vc && inUserWriteScope(req.user, snap, s.vc));
  };

  api.post('/tools/disk-bad/jobs/:id/stop', writeRole, toolsPerm, (req, res) => {
    const agent = req.body?.agent;
    const j = getJob(req.params.id);
    if (!j) return res.status(404).json({ ok: false, reason: '작업을 찾을 수 없습니다.' });
    if (agent == null && !isFullReadWriteScope(req.user, store.get())) return res.status(403).json({ ok: false, error: 'forbidden', reason: '작업 전체 중단은 전체 범위 계정만 — 법인 조각을 골라 멈추세요.' });
    if (agent != null && !unitAllowed(req, agent)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '이 법인은 쓰기 범위 밖입니다.' });
    const r = stopJob(req.params.id, agent == null ? null : String(agent));
    logAudit(req, 'diskbad.stop', { job: req.params.id, agent: agent ?? '*' });
    res.json({ ok: true, job: r });
  });

  api.post('/tools/disk-bad/jobs/:id/retry', writeRole, toolsPerm, (req, res) => {
    const agent = String(req.body?.agent ?? '');
    if (!unitAllowed(req, agent)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '이 법인은 쓰기 범위 밖입니다.' });
    const r = retryUnit(req.params.id, agent);
    if (!r) return res.status(404).json({ ok: false, reason: '다시 보낼 조각이 없습니다(진행 중이거나 작업이 없습니다).' });
    if (r.busy) return res.status(409).json({ ok: false, reason: '이 법인에 진행 중인 다른 점검이 있습니다.' });
    logAudit(req, 'diskbad.retry', { job: req.params.id, agent });
    res.json({ ok: true, job: r });
  });

  api.put('/tools/disk-bad/settings', adminOnly, fullScopeOnly, (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const patch = {};
    for (const k of ['autoEnabled', 'intervalHours', 'mailEnabled', 'corpTo']) if (k in b) patch[k] = b[k];
    let next;
    try { next = saveDiskBadSettings(patch); } catch (e) { return res.status(500).json({ ok: false, reason: `저장 실패: ${String(e?.message || e).slice(0, 200)}` }); }
    logAudit(req, 'diskbad.settings', { autoEnabled: next.autoEnabled, intervalHours: next.intervalHours, mailEnabled: next.mailEnabled, corps: Object.keys(next.corpTo).length });
    res.json({ ok: true, settings: next, auto: autoStatus() });
  });
}
