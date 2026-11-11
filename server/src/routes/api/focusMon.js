/**
 * routes/api/focusMon.js — 특수 기능 ‘집중 모니터링’ 화면 API(v2.976). 경로 첫 세그먼트 `focus-mon` = 도구 키(toolAccess 집행).
 *
 * 사용자 요청(2026-11-11): "특수기능에 집중 모니터링 메뉴 … 중앙/엣지에 연결된 서버의 성능 지표를 실시간으로 … 최대 20개 서버 동시 수집 ·
 * cpu/memory/network/disk · 본딩 · 개별 인터페이스 · 디스크/파티션별 read/write/latency/wait · top 30 프로세스" + "리눅스만 · IP ssh key less 로그인 ·
 * redhat 7.8 기준" + iostat 13개 열 · 1/5/10/30분 구간 스크롤 · 디스크 표 요약 열 · 뒤로 30일(DB) · 프로세스도 DB · 고른 서버 iostat 비교. 설계 docs/design/focus-mon.
 *
 * ── 권한 ─────────────────────────────────────────────────────────────────────────────────────────────
 *  · 조회 = admin + **전체 범위**(fullScopeOnly) — 전 법인 서버의 주소 · 프로세스가 나온다. 대상이 vCenter 귀속이 아니라 범위 계정에 나눌 축이 없다
 *    (법인 간 전송 속도 · 통신 점검과 같은 기준 — 범위 계정 403).
 *  · 쓰기(대상 등록 · 수집 시작/끝 · 시험 · 다시 연결 · 키 · 설정) = admin + **조회 · 쓰기 모두 전체 범위**(fullReadWriteScopeOnly — v2.935 L-1).
 *    CSV 가져오기 · 내보내기는 + `data.csv`. 데모 계정은 데모(mock) 대상만 보고 쓰기는 403.
 *  · 프로세스 사용자 이름은 관리자 판본(isAdminDetailUser)만 원문 — 그 밖은 가림 토큰. 인자 · 환경은 수집 단계에서 없다(comm 만).
 *  · 요청 본문으로 주소 · 계정을 받아 **즉석 접속하지 않는다** — 시험 · 수집 대상은 등록부에서만.
 * ── 그 밖 ────────────────────────────────────────────────────────────────────────────────────────────
 *  · 등록부를 못 읽었으면 503(registryUnreadable) — 빈 목록을 200 으로 내지 않는다.
 *  · 최근 구간 조회는 메모리만(장비 · DB 왕복 0) — 이 조회가 ‘보는 화면’ 심박이다(잠깐 보기는 60초 동안 아무도 안 보면 끝난다).
 *  · 감사: 대상 등록 · 고침 · 삭제 · 가져오기 · 시험 · 다시 연결 · 수집 시작 · 연장 · 끝 · 키 만들기 · 설정.
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { fullScopeOnlyWith, fullReadWriteScopeOnlyWith } from '../admin/shared.js';
import { isDemoGuest, isAdminDetailUser } from '../../auth/demoGuest.js';
import { maskedIdToken } from '../../auth/addressMask.js';
import { knownAgentNames } from '../../central/knownAgents.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { acquireExport } from '../../util/exportBusy.js';
import { summarizeRegistryError } from '../../util/registryCore.js';
import * as registry from '../../focusmon/registry.js';
import * as store from '../../focusmon/store.js';
import * as db from '../../focusmon/db.js';
import * as Q from '../../focusmon/query.js';
import { focusKeys, allTargets, findTarget, isMockMode, startCollection, stopCollection, localRunner, serviceStatus } from '../../focusmon/service.js';
import { recorderStatus } from '../../focusmon/recorder.js';
import { wakeEdge } from '../../central/focusMonEdge.js';
import { INTERVALS, DEFAULT_INTERVAL } from '../../focusmon/script.js';
import { IOSTAT_COLS, IOSTAT_NAME } from '../../focusmon/rates.js';
import { focusAuthGuard, authDevOf } from '../../focusmon/collector.js';

const adminOnly = requireRole('admin');
const csvPerm = requirePerm('data.csv');
const fullScopeOnly = fullScopeOnlyWith('서버 집중 모니터링은 전체 범위(vCenter 제한 없는) 계정만 볼 수 있습니다 — 전 법인 서버의 주소 · 프로세스가 들어갑니다.');
const fullRwOnly = fullReadWriteScopeOnlyWith('서버 집중 모니터링의 대상 · 수집 변경은 조회 · 쓰기 모두 전체 범위인 계정만 할 수 있습니다.');
const EDGE_ONLINE_MS = 60_000;

const demoBlockWrite = (req, res, next) => (isDemoGuest(req.user) ? res.status(403).json({ ok: false, error: 'forbidden', reason: '데모 계정은 서버 집중 모니터링을 바꿀 수 없습니다.' }) : next());

function registryUnreadable(res) {
  const e = registry.registryLoadError();
  if (!e) return false;
  res.status(503).json({ ok: false, reason: 'registryUnreadable', detail: `서버 집중 모니터링 등록부(focusmon-targets.json)를 읽지 못했습니다(${summarizeRegistryError(e)?.text || '손상'}) — 손상 보존본을 확인하세요.` });
  return true;
}

/**
 * 데모 계정 판본 — 실제 엣지 이름 · 공개키 · 다른 사람이 시작한 수집(계정 이름 · 실제 대상 id)을 싣지 않는다(반증 11번).
 * 데모 계정은 데모 대상만 보므로, 수집 목록도 데모 대상만으로 된 것만 남기고 시작한 사람은 가린다.
 */
function demoMask(req, out) {
  if (!isDemoGuest(req.user)) return out;
  const vis = new Set(out.targets.map((t) => t.id));
  const onlyVisible = (s) => Array.isArray(s.targets) && s.targets.length > 0 && s.targets.every((id) => vis.has(id));
  const central = out.nodes.find((x) => x.kind === 'central');
  return {
    ...out,
    nodes: central ? [{ ...central, key: central.key ? { present: !!central.key.present, usable: !!central.key.usable, type: null, fingerprint: null, publicKey: null, source: null, file: null } : null }] : [],
    sessions: out.sessions.filter(onlyVisible).map((s) => ({ ...s, by: '' })),
    ended: out.ended.filter(onlyVisible).map((s) => ({ ...s, by: '' })),
  };
}

/** 이 요청이 볼 수 있는 대상들(데모 계정은 데모 대상만). */
function visibleTargets(req) {
  const all = allTargets();
  return isDemoGuest(req.user) ? all.filter((t) => t.demo) : all;
}
function visibleById(req) { return new Map(visibleTargets(req).map((t) => [t.id, t])); }

/** 쿼리 targets(쉼표) → 보이는 대상 id(최대 40 · 중복 제거). 없는 id 는 조용히 빼지 않고 missing 으로 센다. */
function pickIds(req, max = 40) {
  const vis = visibleById(req);
  const raw = String(req.query.targets || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 200);
  const ids = []; let missing = 0;
  for (const x of raw) { if (vis.has(x)) { if (!ids.includes(x)) ids.push(x); } else missing += 1; }
  return { ids: ids.slice(0, max), missing, vis };
}

function nodeKeyView(agent) {
  if (!agent) return focusKeys.publicKeyView();
  return store.edgeStateOf(agent)?.key || null;
}

function targetView(t, now, { agentsLower }) {
  const st = store.statusOf(t.id);
  const edge = t.agent && !t.demo ? store.edgeStateOf(t.agent) : null;
  const known = !t.agent || t.demo || agentsLower.has(String(t.agent).toLowerCase());
  const authStop = !t.agent || t.demo ? focusAuthGuard.peekAuthStop(authDevOf(t, focusKeys.keyInfo()?.fingerprint)) : null;
  return {
    ...t, nodeKnown: known,
    status: st ? { ...st, stale: st.lastSampleAt ? now - st.lastSampleAt > 3 * (st.interval || DEFAULT_INTERVAL) * 1000 + 2_000 : null } : null,
    edgeOnline: edge ? now - edge.at < EDGE_ONLINE_MS : null, edgeAt: edge?.at || null,
    test: store.testOf(t.id), ...(authStop ? { authStop: { since: authStop.since, reason: authStop.reason } } : {}),
  };
}

export function registerFocusMon(api) {

/** 메인 — 노드(키) · 대상 · 수집 · 기록 · 한도. 화면은 숫자(주기 · 대수 · 임계)를 여기서 읽는다(박지 않는다). */
api.get('/tools/focus-mon', adminOnly, fullScopeOnly, async (req, res) => {
  if (registryUnreadable(res)) return;
  const now = Date.now();
  const agents = knownAgentNames();
  const agentsLower = new Set(agents.map((a) => a.toLowerCase()));
  const targets = visibleTargets(req).map((t) => targetView(t, now, { agentsLower }));
  const edgeSeen = new Map(store.edgeStates().map((e) => [e.agent.toLowerCase(), e]));
  const nodes = [{ agent: '', name: '중앙', kind: 'central', online: true, key: focusKeys.publicKeyView(), version: null, at: now }];
  const nodeNames = new Set([...agents, ...targets.filter((t) => t.agent && !t.demo).map((t) => t.agent)]);
  for (const a of [...nodeNames].sort((x, y) => x.localeCompare(y))) {
    const e = edgeSeen.get(a.toLowerCase());
    nodes.push({ agent: a, name: a, kind: 'edge', online: e ? now - e.at < EDGE_ONLINE_MS : false, at: e?.at || null, version: e?.version || null, key: e?.key || null,
      targets: targets.filter((t) => String(t.agent).toLowerCase() === a.toLowerCase()).length });
  }
  const dbOk = await db.available();
  res.json({
    ok: true, now, mock: isMockMode(), admin: isAdminDetailUser(req.user),
    limits: { maxPerSession: store.MAX_PER_SESSION, maxSessions: store.MAX_SESSIONS, maxTotal: store.MAX_TOTAL_TARGETS, maxRecord: store.MAX_RECORD_TARGETS,
      intervals: INTERVALS, defaultInterval: DEFAULT_INTERVAL, windows: Q.WINDOWS, watchMin: store.WATCH_MIN, watchMaxMin: store.WATCH_MAX_MIN,
      viewerTtlMs: store.VIEWER_TTL_MS, idleInterval: store.IDLE_INTERVAL, maxTargets: registry.MAX_TARGETS },
    settings: registry.getSettings(), settingRanges: registry.SETTING_RANGES,
    iostat: { cols: IOSTAT_COLS, names: IOSTAT_NAME },
    ...demoMask(req, { nodes, targets, sessions: store.listSessions(now), ended: store.endedSessions() }),
    recorder: recorderStatus(), db: { available: dbOk, error: db.dbError() || null, oldestMinute: dbOk ? await db.oldestMinute() : null },
    mem: store.memStats(), local: serviceStatus().running,
  });
});

/* ── 대상 ─────────────────────────────────────────────────────────────────── */

api.post('/tools/focus-mon/targets', adminOnly, fullRwOnly, demoBlockWrite, (req, res) => {
  if (registryUnreadable(res)) return;
  const r = registry.addTarget(req.body || {}, { agents: knownAgentNames(), by: req.user?.username });
  if (!r.ok) return res.status(r.code === 'registry-unreadable' ? 503 : 400).json(r);
  logAudit({ user: req.user?.username, action: 'focus-mon.target.add', target: r.target.name, detail: `${r.target.host}:${r.target.port} ${r.target.username} @ ${r.target.agent || '중앙'}`, ip: req.ip });
  res.json(r);
});

api.put('/tools/focus-mon/targets/:id', adminOnly, fullRwOnly, demoBlockWrite, (req, res) => {
  if (registryUnreadable(res)) return;
  const r = registry.updateTarget(req.params.id, req.body || {}, { agents: knownAgentNames() });
  if (!r.ok) return res.status(r.code === 'not-found' ? 404 : r.code === 'registry-unreadable' ? 503 : 400).json(r);
  logAudit({ user: req.user?.username, action: 'focus-mon.target.update', target: r.target.name, detail: `${r.target.host}:${r.target.port} ${r.target.username} @ ${r.target.agent || '중앙'}${r.moved ? ' (접속처 바뀜)' : ''}`, ip: req.ip });
  res.json(r);
});

api.delete('/tools/focus-mon/targets/:id', adminOnly, fullRwOnly, demoBlockWrite, (req, res) => {
  if (registryUnreadable(res)) return;
  const t = registry.getTarget(req.params.id);
  const r = registry.removeTarget(req.params.id);
  if (!r.ok) return res.status(r.code === 'not-found' ? 404 : 503).json(r);
  logAudit({ user: req.user?.username, action: 'focus-mon.target.remove', target: t?.name || req.params.id, ip: req.ip });
  res.json(r);
});

api.post('/tools/focus-mon/targets/import', adminOnly, fullRwOnly, csvPerm, demoBlockWrite, (req, res) => {
  if (registryUnreadable(res)) return;
  const r = registry.importCsv(String(req.body?.text || ''), { agents: knownAgentNames(), by: req.user?.username });
  if (!r.ok) return res.status(r.code === 'registry-unreadable' ? 503 : 400).json(r);
  logAudit({ user: req.user?.username, action: 'focus-mon.target.import', target: 'focus-mon', detail: `${r.added}대`, ip: req.ip });
  res.json(r);
});

/** 연결 시험 — 대상마다 진행 중 1건 · TEST_MIN_MS 에 한 번(병렬로 보내 로그인 시도를 늘리지 못하게 — 반증 6번). */
const TEST_MIN_MS = 10_000;
const testGate = new Map(); // targetId → { at, busy }
api.post('/tools/focus-mon/targets/:id/test', adminOnly, fullRwOnly, demoBlockWrite, async (req, res) => {
  const t = visibleById(req).get(String(req.params.id));
  if (!t) return res.status(404).json({ ok: false, code: 'not-found', reason: '없는 대상입니다.' });
  const g = testGate.get(t.id);
  const nowT = Date.now();
  if (g && (g.busy || nowT - g.at < TEST_MIN_MS)) return res.status(429).json({ ok: false, code: 'too-soon', reason: `같은 대상은 ${TEST_MIN_MS / 1000}초에 한 번만 시험합니다${g.busy ? '(앞 시험이 아직 진행 중)' : ''}.` });
  testGate.set(t.id, { at: nowT, busy: true });
  if (testGate.size > 1000) for (const k of [...testGate.keys()].slice(0, 500)) if (!testGate.get(k).busy) testGate.delete(k);
  logAudit({ user: req.user?.username, action: 'focus-mon.target.test', target: t.name, detail: `${t.host}:${t.port} @ ${t.agent || '중앙'}`, ip: req.ip });
  try {
    if (t.agent && !t.demo) {
      store.requestEdgeTest(t.id, t.agent);
      wakeEdge(t.agent).catch(() => {});
      return res.json({ ok: true, queued: true, via: 'edge' });
    }
    const result = await localRunner.test(t);
    store.putTestResult(t.id, { ...result, via: 'central' });
    res.json({ ok: true, queued: false, result });
  } finally { testGate.set(t.id, { at: nowT, busy: false }); }
});

/** 다시 연결 — 인증 정지를 지우고 지금 한 번 시도한다(대상마다 60초에 한 번). */
api.post('/tools/focus-mon/targets/:id/retry', adminOnly, fullRwOnly, demoBlockWrite, (req, res) => {
  const t = visibleById(req).get(String(req.params.id));
  if (!t) return res.status(404).json({ ok: false, code: 'not-found', reason: '없는 대상입니다.' });
  logAudit({ user: req.user?.username, action: 'focus-mon.target.retry', target: t.name, ip: req.ip });
  if (t.agent && !t.demo) { store.requestEdgeRetry(t.id, t.agent); wakeEdge(t.agent).catch(() => {}); return res.json({ ok: true, via: 'edge' }); }
  const r = localRunner.retry(t.id, t);
  if (!r.ok && r.code === 'too-soon') return res.status(429).json(r);
  res.json({ ok: true, via: 'central', running: !!r.running });
});

/** 이 노드(중앙)의 키 만들기 — 있으면 아무것도 하지 않는다. 엣지 키는 그 엣지에 대상이 생기면 엣지가 만든다. */
api.post('/tools/focus-mon/key', adminOnly, fullRwOnly, demoBlockWrite, (req, res) => {
  try {
    const r = focusKeys.ensureKey();
    if (r.created) logAudit({ user: req.user?.username, action: 'focus-mon.key.create', target: 'central', detail: `${r.info?.type || ''} ${r.info?.fingerprint || ''}`, ip: req.ip });
    res.json({ ok: !r.reason, created: !!r.created, key: focusKeys.publicKeyView(), ...(r.reason ? { reason: r.reason } : {}) });
  } catch (e) { res.status(500).json({ ok: false, reason: `키를 만들지 못했습니다(${String(e?.message || e).slice(0, 160)})` }); }
});

api.put('/tools/focus-mon/settings', adminOnly, fullRwOnly, demoBlockWrite, (req, res) => {
  if (registryUnreadable(res)) return;
  const r = registry.saveSettings(req.body || {});
  if (!r.ok) return res.status(503).json(r);
  logAudit({ user: req.user?.username, action: 'focus-mon.settings', target: 'focus-mon', detail: r.changed.length ? `바뀐 항목: ${r.changed.join(', ')}` : '변경 없음', ip: req.ip });
  res.json(r);
});

/* ── 수집 ─────────────────────────────────────────────────────────────────── */

api.post('/tools/focus-mon/sessions', adminOnly, fullRwOnly, demoBlockWrite, (req, res) => {
  const b = req.body || {};
  const vis = visibleById(req);
  const ids = (Array.isArray(b.targets) ? b.targets : []).map(String).slice(0, 200);
  const unknown = ids.filter((id) => !vis.has(id));
  if (unknown.length) return res.status(404).json({ ok: false, code: 'not-found', reason: `없는 대상이 ${unknown.length}대 있습니다.` });
  const disabled = ids.filter((id) => vis.get(id).enabled === false);
  if (disabled.length) return res.status(400).json({ ok: false, code: 'disabled', reason: `꺼 둔 대상이 ${disabled.length}대 있습니다.` });
  const mode = b.mode === 'record' ? 'record' : 'watch';
  const interval = INTERVALS.includes(Number(b.interval)) ? Number(b.interval) : DEFAULT_INTERVAL;
  const r = startCollection({ targets: ids, interval, mode, by: req.user?.username || '' });
  if (!r.ok) return res.status(409).json(r);
  logAudit({ user: req.user?.username, action: 'focus-mon.start', target: r.session.id, detail: `${mode === 'record' ? '계속 수집' : '잠깐 보기'} · ${interval}초 · ${ids.length}대: ${ids.map((id) => vis.get(id).name).join(', ').slice(0, 600)}`, ip: req.ip });
  res.json(r);
});

api.post('/tools/focus-mon/sessions/:id/extend', adminOnly, fullRwOnly, demoBlockWrite, (req, res) => {
  const r = store.extendSession(req.params.id);
  if (!r.ok) return res.status(r.code === 'not-found' ? 404 : 409).json(r);
  logAudit({ user: req.user?.username, action: 'focus-mon.extend', target: r.session.id, ip: req.ip });
  res.json(r);
});

api.delete('/tools/focus-mon/sessions/:id', adminOnly, fullRwOnly, demoBlockWrite, (req, res) => {
  const r = stopCollection(req.params.id, 'stopped');
  if (!r.ok) return res.status(404).json(r);
  logAudit({ user: req.user?.username, action: 'focus-mon.stop', target: r.session.id, ip: req.ip });
  res.json(r);
});

/* ── 조회 ─────────────────────────────────────────────────────────────────── */

/** 화면 데이터. view = overview | compare | server | iostat. 최근 구간이면 ‘보는 화면’ 심박을 남긴다. */
api.get('/tools/focus-mon/data', adminOnly, fullScopeOnly, async (req, res) => {
  const view = String(req.query.view || 'overview');
  const w = Q.normWindow({ win: req.query.win, end: req.query.end });
  const { ids, missing } = pickIds(req, view === 'server' ? 1 : 40);
  if (!ids.length) return res.status(404).json({ ok: false, code: 'not-found', reason: '볼 대상이 없습니다(없는 대상이거나 고르지 않았습니다).' });
  if (!w.past) store.touchView(ids);
  const base = { ok: true, view, win: w.win, from: w.from, to: w.to, past: w.past, missing, now: Date.now() };
  if (view === 'overview') return res.json({ ...base, ...(await Q.overview(ids, w)) });
  if (view === 'compare') {
    const metric = ['cpu', 'mem', 'net', 'disk'].includes(String(req.query.metric)) ? String(req.query.metric) : 'cpu';
    return res.json({ ...base, metric, ...(await Q.compare(ids, w, { metric, item: String(req.query.item || ''), scope: String(req.query.scope || 'all').slice(0, 220) })) });
  }
  if (view === 'server') return res.json({ ...base, ...(await Q.serverDetail(ids[0], w, { at: req.query.at === 'avg' ? 'avg' : 'end', dev: String(req.query.dev || '') })) });
  if (view === 'iostat') {
    const pins = String(req.query.pins || '').split(',').filter(Boolean).slice(0, 4);
    return res.json({ ...base, ...(await Q.iostatCompare(ids, w, { at: req.query.at === 'avg' ? 'avg' : 'end', scope: req.query.scope === 'all' ? 'all' : 'phys', col: String(req.query.col || 'wAwait'), pins })) });
  }
  return res.status(400).json({ ok: false, code: 'bad-view', reason: '모르는 보기입니다.' });
});

/** 프로세스 상위 30 — 서버별 · 통합 · 이름별 묶음. 사용자 이름은 관리자 판본만 원문. */
api.get('/tools/focus-mon/procs', adminOnly, fullScopeOnly, async (req, res) => {
  const w = Q.normWindow({ win: req.query.win, end: req.query.end });
  const { ids, missing } = pickIds(req, 40);
  if (!ids.length) return res.status(404).json({ ok: false, code: 'not-found', reason: '볼 대상이 없습니다.' });
  if (!w.past) store.touchView(ids);
  const admin = isAdminDetailUser(req.user);
  const r = await Q.procs(ids, w, { at: req.query.at === 'avg' ? 'avg' : 'end', maskUser: admin ? (u) => u : (u) => maskedIdToken(u) });
  res.json({ ok: true, win: w.win, from: w.from, to: w.to, past: w.past, missing, usersMasked: !admin, ...r });
});

/** 기록이 있는 시간 — 그 날(포탈 기준 날짜) 또는 최근 24시간. */
api.get('/tools/focus-mon/coverage', adminOnly, fullScopeOnly, async (req, res) => {
  const { ids } = pickIds(req, 40);
  if (!ids.length) return res.status(404).json({ ok: false, code: 'not-found', reason: '볼 대상이 없습니다.' });
  const now = Date.now();
  const to = Number(req.query.to) > 0 ? Math.min(now, Number(req.query.to)) : now;
  const from = to - 24 * 3_600_000;
  res.json({ ok: true, ...(await Q.coverage(ids, from, to)) });
});

/** CSV — kind=series(지표 비교 한 줄씩) | iostat(장치 줄 × 13칸). 구간은 화면과 같다(최대 30분). */
api.get('/tools/focus-mon/export.csv', adminOnly, fullScopeOnly, csvPerm, async (req, res) => {
  const lock = acquireExport('focus-mon', req);
  if (!lock.ok) return res.status(lock.status).json(lock.body);
  try {
    const w = Q.normWindow({ win: req.query.win, end: req.query.end });
    const { ids, vis } = pickIds(req, 40);
    if (!ids.length) return res.status(404).json({ ok: false, code: 'not-found', reason: '볼 대상이 없습니다.' });
    const name = (id) => vis.get(id)?.name || id;
    const lines = [];
    if (req.query.kind === 'iostat') {
      const r = await Q.iostatCompare(ids, w, { at: req.query.at === 'avg' ? 'avg' : 'end', scope: req.query.scope === 'all' ? 'all' : 'phys' });
      lines.push(csvLine(['server', 'device', 'name', 'kind', 'mount', ...IOSTAT_COLS.map((c) => IOSTAT_NAME[c])]));
      for (const row of r.rows) {
        if (row.total) lines.push(csvLine([name(row.id), '(전체 디스크)', '', 'total', '', ...row.total.map((v) => (v == null ? '' : v))]));
        for (const d of row.devices) lines.push(csvLine([name(row.id), d.n, d.dn || '', d.k, d.mp || '', ...d.v.map((v) => (v == null ? '' : v))]));
      }
    } else {
      const metric = ['cpu', 'mem', 'net', 'disk'].includes(String(req.query.metric)) ? String(req.query.metric) : 'cpu';
      const r = await Q.compare(ids, w, { metric, item: String(req.query.item || ''), scope: String(req.query.scope || 'all').slice(0, 220) });
      const step = (w.to - w.from) / r.points;
      lines.push(csvLine(['time', ...r.targets.map((x) => name(x.id))]));
      for (let k = 0; k < r.points; k++) {
        const t = new Date(w.from + step * (k + 0.5)).toISOString();
        lines.push(csvLine([t, ...r.targets.map((x) => (x.avg[k] == null ? '' : x.avg[k]))]));
      }
    }
    logAudit({ user: req.user?.username, action: 'focus-mon.export', target: 'focus-mon', detail: `${req.query.kind === 'iostat' ? 'iostat' : 'series'} · ${ids.length}대`, ip: req.ip });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="focus-mon-${req.query.kind === 'iostat' ? 'iostat' : 'series'}.csv"`);
    res.send(CSV_BOM + lines.join('\n') + '\n');
  } finally { lock.release(); }
});

}
