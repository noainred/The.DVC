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
 *    v2.978: CSV 적용(미리보기는 바꾸는 것이 없어 남기지 않는다) · 등록부 내보내기 · 일괄 시험 · 노드 옮기기 · 엣지 다시 깨우기.
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
import { focusKeys, allTargets, findTarget, isMockMode, startCollection, stopCollection, addToCollection, removeFromCollection, targetEndpointChanged, localRunner, serviceStatus } from '../../focusmon/service.js';
import { recorderStatus } from '../../focusmon/recorder.js';
import { wakeEdge, focusEdgeMinVersion, focusDiagMinVersion } from '../../central/focusMonEdge.js';
import { startBulk, bulkJob, bulkProgress } from '../../focusmon/bulkTest.js';
import { INTERVALS, DEFAULT_INTERVAL, PROC_EVERY_CHOICES, TOPO_EVERY_S } from '../../focusmon/script.js';
import { judgeLoad, estimateLoad, averageLoads, averageNodes, loadTotals } from '../../focusmon/load.js';
import { demoNodeLoad } from '../../focusmon/mock.js';
import { IOSTAT_COLS, IOSTAT_NAME } from '../../focusmon/rates.js';
import { focusAuthGuard, authDevOf } from '../../focusmon/collector.js';

const adminOnly = requireRole('admin');
const csvPerm = requirePerm('data.csv');
const fullScopeOnly = fullScopeOnlyWith('서버 집중 모니터링은 전체 범위(vCenter 제한 없는) 계정만 볼 수 있습니다 — 전 법인 서버의 주소 · 프로세스가 들어갑니다.');
const fullRwOnly = fullReadWriteScopeOnlyWith('서버 집중 모니터링의 대상 · 수집 변경은 조회 · 쓰기 모두 전체 범위인 계정만 할 수 있습니다.');
const EDGE_ONLINE_MS = 60_000;
/** 감사 기록용 바뀐 칸 글(v2.980) — 'IP 10.0.0.1 → 10.0.0.2 · 담당 노드 중앙 → 엣지 NJ'. 값은 입력 검사를 지난 짧은 글자뿐이다(비밀 칸 없음). */
const CHANGE_LABEL = { name: '이름', host: 'IP', port: '포트', username: '계정', agent: '담당 노드', group: '그룹' };
const changeVal = (k, v) => (k === 'agent' ? (v ? `엣지 ${v}` : '중앙') : k === 'group' ? (v || '그룹 없음') : v);
const changesText = (changes = []) => changes.map((c) => `${CHANGE_LABEL[c.k] || c.k} ${changeVal(c.k, c.from)} → ${changeVal(c.k, c.to)}`).join(' · ');
const verCmp = (a, b) => { const x = String(a).split('.').map(Number); const y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };

/**
 * 엣지 노드의 업그레이드 안내(판정 코어 — 화면은 이 값만 읽는다).
 *  · 'feature' — 동기화한 적이 없고 깨우기가 '경로 없음(옛 판)' 이었다 → 이 엣지에서는 서버 집중 모니터링이 돌지 않는다.
 *  · 'diag'    — 동기화는 하지만 판이 진단 · 쉬는 주기 단축보다 낮다 → 진단 칸이 비고 쉬는 동안 30초 주기다.
 *  · null      — 안내 없음(또는 모름 — 판을 모르면 단정하지 않는다).
 */
export function edgeUpgradeNeed({ synced, version, wakeKind }, { diagMin }) {
  if (!synced) return wakeKind === 'old-version' ? 'feature' : null;
  if (version && diagMin && verCmp(version, diagMin) < 0) return 'diag';
  return null;
}

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
/**
 * 그룹 보기(v2.982 — 사용자 '등록된 서버를 그룹별로 분류해서 보는 기능'): 목록 순서(만든 순서 · 빈 그룹 포함) + 보이는 서버 수.
 * own = 등록부의 그룹(이름 바꾸기 · 지우기 가능) · 데모 서버만 쓰는 그룹은 own false. 데모 계정에는 등록부 그룹 이름을 싣지 않는다(보이는 서버의 그룹만).
 */
function groupsView(req, targets) {
  const own = isDemoGuest(req.user) ? [] : registry.listGroups().map((g) => g.name);
  const names = [...own];
  for (const t of targets) if (t.group && !names.includes(t.group)) names.push(t.group);
  return { list: names.map((name) => ({ name, n: targets.filter((t) => t.group === name).length, own: own.includes(name) })), none: targets.filter((t) => !t.group).length, max: registry.MAX_GROUPS };
}

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
  const settings = registry.getSettings();
  const edgeMin = focusEdgeMinVersion(); const diagMin = focusDiagMinVersion();
  const nodeNames = new Set([...agents, ...targets.filter((t) => t.agent && !t.demo).map((t) => t.agent)]);
  for (const a of [...nodeNames].sort((x, y) => x.localeCompare(y))) {
    const e = edgeSeen.get(a.toLowerCase());
    const mineCount = targets.filter((t) => String(t.agent).toLowerCase() === a.toLowerCase()).length;
    const wake = store.edgeWakeOf(a);
    nodes.push({ agent: a, name: a, kind: 'edge', online: e ? now - e.at < EDGE_ONLINE_MS : false, at: e?.at || null, version: e?.version || null, key: e?.key || null,
      targets: mineCount, known: agentsLower.has(a.toLowerCase()), diag: e?.diag || null, wake, firstAt: e?.firstAt || null,
      idleMs: mineCount ? settings.edgeIdleSec * 1000 : null,
      upgrade: edgeUpgradeNeed({ synced: !!e, version: e?.version || '', wakeKind: wake?.kind || null }, { diagMin }) });
  }
  const dbOk = await db.available();
  res.json({
    ok: true, now, mock: isMockMode(), admin: isAdminDetailUser(req.user),
    limits: { maxPerSession: store.MAX_PER_SESSION, maxSessions: store.MAX_SESSIONS, maxTotal: store.MAX_TOTAL_TARGETS, maxRecord: store.MAX_RECORD_TARGETS,
      intervals: INTERVALS, defaultInterval: DEFAULT_INTERVAL, windows: Q.WINDOWS, watchMin: store.WATCH_MIN, watchMaxMin: store.WATCH_MAX_MIN,
      viewerTtlMs: store.VIEWER_TTL_MS, idleInterval: store.IDLE_INTERVAL, maxTargets: registry.MAX_TARGETS },
    settings, settingRanges: registry.SETTING_RANGES, edgeMin, diagMin,
    csv: { maxRows: registry.CSV_MAX_ROWS, maxBytes: registry.CSV_MAX_BYTES },
    ...(isDemoGuest(req.user) ? {} : { bulkTest: bulkProgress(bulkJob(), store.testOf, now) }),
    iostat: { cols: IOSTAT_COLS, names: IOSTAT_NAME },
    ...demoMask(req, { nodes, targets, sessions: store.listSessions(now), ended: store.endedSessions() }),
    groups: groupsView(req, targets),
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
  if (!r.changes.length) return res.json({ ...r, cleared: false });
  // v2.980(사용자 '등록된 서버 수정하는 기능 추가'): 접속처가 바뀌면 바로 다시 맞추고 예전 접속처의 상태 · 시험 결과를 지운다.
  if (r.moved) targetEndpointChanged(r.before, r.target);
  logAudit({ user: req.user?.username, action: 'focus-mon.target.update', target: r.target.name, detail: `${changesText(r.changes)}${r.moved ? ' (접속처 바뀜)' : ''}`, ip: req.ip });
  res.json({ ok: true, target: r.target, moved: r.moved, changes: r.changes, cleared: r.moved });
});

api.delete('/tools/focus-mon/targets/:id', adminOnly, fullRwOnly, demoBlockWrite, (req, res) => {
  if (registryUnreadable(res)) return;
  const t = registry.getTarget(req.params.id);
  const r = registry.removeTarget(req.params.id);
  if (!r.ok) return res.status(r.code === 'not-found' ? 404 : 503).json(r);
  logAudit({ user: req.user?.username, action: 'focus-mon.target.remove', target: t?.name || req.params.id, ip: req.ip });
  res.json(r);
});

/* ── 그룹(v2.982) — 수집 시작과 같은 문(admin · 조회 · 쓰기 전체 범위 · 데모 차단) · 감사 ─────────────── */
const groupStatus = (r) => (r.code === 'not-found' ? 404 : r.code === 'registry-unreadable' ? 503 : r.code === 'duplicate' ? 409 : 400);
api.post('/tools/focus-mon/groups', adminOnly, fullRwOnly, demoBlockWrite, (req, res) => {
  if (registryUnreadable(res)) return;
  const r = registry.createGroup(req.body?.name);
  if (!r.ok) return res.status(groupStatus(r)).json(r);
  logAudit({ user: req.user?.username, action: 'focus-mon.group.add', target: r.group, ip: req.ip });
  res.json(r);
});
api.put('/tools/focus-mon/groups/:name', adminOnly, fullRwOnly, demoBlockWrite, (req, res) => {
  if (registryUnreadable(res)) return;
  const r = registry.renameGroup(req.params.name, req.body?.name);
  if (!r.ok) return res.status(groupStatus(r)).json(r);
  logAudit({ user: req.user?.username, action: 'focus-mon.group.rename', target: r.group, detail: `${String(req.params.name).slice(0, 32)} → ${r.group} · 서버 ${r.moved}대`, ip: req.ip });
  res.json(r);
});
api.delete('/tools/focus-mon/groups/:name', adminOnly, fullRwOnly, demoBlockWrite, (req, res) => {
  if (registryUnreadable(res)) return;
  const r = registry.deleteGroup(req.params.name);
  if (!r.ok) return res.status(groupStatus(r)).json(r);
  logAudit({ user: req.user?.username, action: 'focus-mon.group.remove', target: String(req.params.name).slice(0, 32), detail: `서버 ${r.freed}대는 그룹 없음으로`, ip: req.ip });
  res.json(r);
});
/** 서버 옮기기 — ids 를 group 으로('' = 그룹 없음). 보이는(등록부) 서버만 — 데모 서버 · 없는 id 는 missing 으로 센다. */
api.post('/tools/focus-mon/targets/group', adminOnly, fullRwOnly, demoBlockWrite, (req, res) => {
  if (registryUnreadable(res)) return;
  const raw = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, registry.MAX_TARGETS) : [];
  if (!raw.length) return res.status(400).json({ ok: false, code: 'no-targets', reason: '옮길 서버가 없습니다.' });
  const r = registry.setTargetsGroup(raw, typeof req.body?.group === 'string' ? req.body.group : '');
  if (!r.ok) return res.status(groupStatus(r)).json(r);
  if (r.moved) logAudit({ user: req.user?.username, action: 'focus-mon.group.move', target: r.group || '그룹 없음', detail: `서버 ${r.moved}대`, ip: req.ip });
  res.json(r);
});

/** 연결 시험 — 대상마다 진행 중 1건 · TEST_MIN_MS 에 한 번(병렬로 보내 로그인 시도를 늘리지 못하게 — 반증 6번).
 * 일괄 시험(v2.978)도 이 문턱을 같이 쓴다. */
const TEST_MIN_MS = 10_000;
const testGate = new Map(); // targetId → { at, busy }

/**
 * CSV 미리보기(v2.978) — 아무것도 바꾸지 않는다. 줄마다 새로 · 갱신 · 그대로 · 오류. 화면은 이 결과로 표를 그리고, 적용은 본문을 다시 계획한다.
 * 쓰기와 같은 문을 둔다(등록부 주소 · 계정이 계획에 그대로 들어간다 — 조회 범위만 있는 계정에 주지 않는다).
 */
api.post('/tools/focus-mon/targets/import/preview', adminOnly, fullRwOnly, csvPerm, demoBlockWrite, (req, res) => {
  if (registryUnreadable(res)) return;
  const r = registry.planCsv(String(req.body?.text ?? ''), { agents: knownAgentNames() });
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

/**
 * CSV 적용 — mode 'valid'(맞는 줄만) | 'all'(오류가 있으면 하나도 넣지 않는다 · 예전 동작이자 mode 를 안 보낸 호출의 기본) ·
 * update true 면 같은 IP · 포트의 기존 대상을 갱신(기본 false — 예전 호출은 추가만). 넣거나 바꾼 대상 id 를 돌려준다(화면이 일괄 시험에 쓴다).
 */
api.post('/tools/focus-mon/targets/import', adminOnly, fullRwOnly, csvPerm, demoBlockWrite, (req, res) => {
  if (registryUnreadable(res)) return;
  const b = req.body || {};
  const r = registry.applyCsv(String(b.text ?? ''), { agents: knownAgentNames(), by: req.user?.username, mode: b.mode === 'valid' ? 'valid' : 'all', update: b.update === true });
  if (!r.ok) return res.status(r.code === 'registry-unreadable' ? 503 : 400).json(r);
  logAudit({ user: req.user?.username, action: 'focus-mon.target.import', target: 'focus-mon', detail: `새로 ${r.added}대 · 갱신 ${r.updated}대 · 그대로 ${r.same}대 · 건너뜀 ${r.skipped}줄${r.moved.length ? ` · 접속처 바뀜 ${r.moved.length}대` : ''}`, ip: req.ip });
  res.json(r);
});

/** 등록부 내보내기(다시 가져올 수 있는 모양) · template=1 이면 머리글 + 예시 한 줄. 비밀 칸은 애초에 없다. */
api.get('/tools/focus-mon/targets/export.csv', adminOnly, fullScopeOnly, csvPerm, (req, res) => {
  if (registryUnreadable(res)) return;
  const template = req.query.template === '1';
  const lock = template ? { ok: true, release: () => {} } : acquireExport('focus-mon-targets', req);
  if (!lock.ok) return res.status(lock.status).json(lock.body);
  try {
    const demo = isDemoGuest(req.user);
    const list = template ? [] : allTargets().filter((t) => (demo ? t.demo : !t.demo));
    const rows = template ? registry.csvTemplateRows() : registry.exportRows(list);
    if (!template) logAudit({ user: req.user?.username, action: 'focus-mon.target.export', target: 'focus-mon', detail: `${list.length}대`, ip: req.ip });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${template ? 'focus-mon-targets-template' : 'focus-mon-targets'}.csv"`);
    res.send(CSV_BOM + rows.map((r) => csvLine(r)).join('\n') + '\n');
  } finally { lock.release?.(); }
});

/**
 * 일괄 연결 시험(v2.978) — ids(최대 등록 상한). 작업은 노드에 하나 · 대상마다 시험 문턱을 지킨다 · 진행률은 메인 GET 의 bulkTest.
 * 시험은 등록부의 대상만(요청 본문의 주소로 즉석 접속하지 않는다).
 */
api.post('/tools/focus-mon/targets/test-bulk', adminOnly, fullRwOnly, demoBlockWrite, (req, res) => {
  if (registryUnreadable(res)) return;
  const vis = visibleById(req);
  const raw = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, registry.MAX_TARGETS) : [];
  const ids = [...new Set(raw)].filter((id) => vis.has(id));
  if (!ids.length) return res.status(400).json({ ok: false, code: 'no-targets', reason: '시험할 대상이 없습니다.' });
  const nowT = Date.now();
  const r = startBulk({
    targets: ids.map((id) => vis.get(id)), by: req.user?.username || '', testOf: store.testOf, now: nowT,
    peek: (id) => { const g = testGate.get(id); return !(g && (g.busy || Date.now() - g.at < TEST_MIN_MS)); },
    gate: (id) => { const n = Date.now(); const g = testGate.get(id); if (g && (g.busy || n - g.at < TEST_MIN_MS)) return false; testGate.set(id, { at: n, busy: true }); return true; },
    release: (id) => { const g = testGate.get(id); testGate.set(id, { at: g?.at || Date.now(), busy: false }); },
    testLocal: (t) => localRunner.test(t),
    putResult: (id, result) => store.putTestResult(id, { ...result, via: 'central' }),
    queueEdge: (t) => store.requestEdgeTest(t.id, t.agent, nowT),
    wake: (agent) => { wakeEdge(agent).catch(() => {}); },
  });
  if (!r.ok) return res.status(409).json(r);
  logAudit({ user: req.user?.username, action: 'focus-mon.target.test-bulk', target: 'focus-mon', detail: `${r.job.total}대(중앙 ${r.job.central} · 엣지 ${r.job.edges}곳 · 건너뜀 ${r.job.skipped})`, ip: req.ip });
  res.json(r);
});

/** 노드 옮기기(v2.978) — from 노드(빈 문자열 = 중앙)의 대상(ids 를 주면 그중 from 에 속한 것만)을 to 노드로. 받는 엣지는 한 번 깨운다(키를 만들게). */
api.post('/tools/focus-mon/targets/move', adminOnly, fullRwOnly, demoBlockWrite, (req, res) => {
  if (registryUnreadable(res)) return;
  const b = req.body || {};
  const agents = knownAgentNames();
  const r = registry.moveTargets({ from: String(b.from ?? ''), to: String(b.to ?? ''), ids: Array.isArray(b.ids) ? b.ids : null }, { agents });
  if (!r.ok) return res.status(r.code === 'registry-unreadable' ? 503 : 400).json(r);
  if (r.moved.length) {
    logAudit({ user: req.user?.username, action: 'focus-mon.target.move', target: 'focus-mon', detail: `${String(b.from || '') || '중앙'} → ${String(b.to || '') || '중앙'} · ${r.moved.length}대${r.skipped ? ` · 겹쳐 건너뜀 ${r.skipped}대` : ''}`, ip: req.ip });
    if (b.to) wakeEdge(String(b.to)).catch(() => {});
  }
  res.json(r);
});

/** 엣지 다시 깨우기(v2.978 엣지 연결 진단) — 직접 닿는지 · 걸린 시간 · 옛 판인지. 등록된 엣지 이름만 · 엣지마다 10초에 한 번. */
const wakeGate = new Map(); // agentLower → at
api.post('/tools/focus-mon/edges/:agent/wake', adminOnly, fullRwOnly, demoBlockWrite, async (req, res) => {
  const want = String(req.params.agent || '').toLowerCase();
  const agent = knownAgentNames().find((a) => a.toLowerCase() === want);
  if (!agent) return res.status(404).json({ ok: false, code: 'not-found', reason: '등록된 엣지(수집 서버) 이름이 아닙니다.' });
  const nowT = Date.now();
  if (nowT - (wakeGate.get(want) || 0) < TEST_MIN_MS) return res.status(429).json({ ok: false, code: 'too-soon', reason: `같은 엣지는 ${TEST_MIN_MS / 1000}초에 한 번만 깨웁니다.` });
  wakeGate.set(want, nowT);
  if (wakeGate.size > 1000) wakeGate.delete(wakeGate.keys().next().value);
  logAudit({ user: req.user?.username, action: 'focus-mon.edge.wake', target: agent, ip: req.ip });
  const r = await wakeEdge(agent, { by: 'manual' });
  res.json({ ok: true, agent, wake: store.edgeWakeOf(agent) || { ...r, at: nowT } });
});

/** 연결 시험 — 대상마다 진행 중 1건 · TEST_MIN_MS 에 한 번(TEST_MIN_MS · testGate 는 위 — 일괄 시험과 같은 문턱). */
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

/**
 * 다시 연결 — 인증 정지를 지우고 **한 번** 시도한다(대상마다 60초에 한 번 — 검사는 러너가 먼저 한다).
 *  · 수집 중이면 그 수집기가 다시 붙는다. 수집 중이 아니면(시험만 한 서버) 정지를 지운 뒤 연결 시험 한 번(v2.978 — 예전에는 정지만 지우고
 *    아무것도 하지 않아 사용자가 '시험' 을 다시 눌러야 했고, 엣지 서버는 정지조차 풀리지 않았다).
 *  · 시험은 시험 문턱(10초 · 진행 중 1건)을 같이 쓴다 — 문턱에 걸리면 정지만 풀고 시험은 건너뛴다.
 */
api.post('/tools/focus-mon/targets/:id/retry', adminOnly, fullRwOnly, demoBlockWrite, async (req, res) => {
  const t = visibleById(req).get(String(req.params.id));
  if (!t) return res.status(404).json({ ok: false, code: 'not-found', reason: '없는 대상입니다.' });
  logAudit({ user: req.user?.username, action: 'focus-mon.target.retry', target: t.name, ip: req.ip });
  const nowT = Date.now();
  const g = testGate.get(t.id);
  const gateOpen = !(g && (g.busy || nowT - g.at < TEST_MIN_MS));
  if (t.agent && !t.demo) {
    store.requestEdgeRetry(t.id, t.agent);
    if (gateOpen) { testGate.set(t.id, { at: nowT, busy: false }); store.requestEdgeTest(t.id, t.agent, nowT); }
    wakeEdge(t.agent).catch(() => {});
    return res.json({ ok: true, via: 'edge', test: gateOpen });
  }
  const r = localRunner.retry(t.id, t);
  if (!r.ok && r.code === 'too-soon') return res.status(429).json(r);
  if (r.running || !gateOpen) return res.json({ ok: true, via: 'central', running: !!r.running, test: false });
  testGate.set(t.id, { at: nowT, busy: true });
  try {
    const result = await localRunner.test(t);
    store.putTestResult(t.id, { ...result, via: 'central' });
    return res.json({ ok: true, via: 'central', running: false, test: true, result });
  } finally { testGate.set(t.id, { at: nowT, busy: false }); }
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
  const started = r.session.targets;
  logAudit({ user: req.user?.username, action: 'focus-mon.start', target: r.session.id, detail: `${mode === 'record' ? '계속 수집' : '잠깐 보기'} · ${interval}초 · ${started.length}대: ${started.map((id) => vis.get(id)?.name || id).join(', ').slice(0, 600)}${r.skipped?.length ? ` · 이미 수집 중이라 뺌 ${r.skipped.length}대` : ''}${r.moved?.length ? ` · 잠깐 보기에서 넘겨받음 ${r.moved.length}대` : ''}`, ip: req.ip });
  res.json(r);
});

/**
 * 진행 중인 수집에 서버 더하기(v2.979 — 사용자 '기존 모니터링 돌고 있는데 추가하면 잘 안 돼' · 중복 방지). 이미 다른 수집에 있는 서버는 뺀다(store.planJoin).
 * 수집 시작과 같은 문(관리자 · 조회 · 쓰기 전체 범위 · 데모 차단) · 보이는 대상만 · 꺼 둔 대상은 거절.
 */
api.post('/tools/focus-mon/sessions/:id/targets', adminOnly, fullRwOnly, demoBlockWrite, (req, res) => {
  const vis = visibleById(req);
  const ids = (Array.isArray(req.body?.targets) ? req.body.targets : []).map(String).slice(0, 200);
  const unknown = ids.filter((id) => !vis.has(id));
  if (unknown.length) return res.status(404).json({ ok: false, code: 'not-found', reason: `없는 대상이 ${unknown.length}대 있습니다.` });
  const disabled = ids.filter((id) => vis.get(id).enabled === false);
  if (disabled.length) return res.status(400).json({ ok: false, code: 'disabled', reason: `꺼 둔 대상이 ${disabled.length}대 있습니다.` });
  const r = addToCollection(req.params.id, ids);
  if (!r.ok) return res.status(r.code === 'not-found' ? 404 : 409).json(r);
  logAudit({ user: req.user?.username, action: 'focus-mon.add', target: r.session.id, detail: `${r.added.length}대 더함: ${r.added.map((id) => vis.get(id)?.name || id).join(', ').slice(0, 600)}${r.skipped.length ? ` · 이미 수집 중이라 뺌 ${r.skipped.length}대` : ''}`, ip: req.ip });
  res.json(r);
});

/** 수집에서 서버 하나 빼기(서버별 ‘수집 종료’ · v2.979) — 마지막 서버면 그 수집이 끝난다. */
api.delete('/tools/focus-mon/sessions/:id/targets/:tid', adminOnly, fullRwOnly, demoBlockWrite, (req, res) => {
  const vis = visibleById(req);
  const tid = String(req.params.tid);
  if (!vis.has(tid)) return res.status(404).json({ ok: false, code: 'not-found', reason: '없는 대상입니다.' });
  const r = removeFromCollection(req.params.id, tid);
  if (!r.ok) return res.status(r.code === 'not-found' ? 404 : 409).json(r);
  logAudit({ user: req.user?.username, action: 'focus-mon.remove-target', target: r.session.id, detail: `${vis.get(tid).name}${r.ended ? ' · 마지막 서버라 수집이 끝남' : ''}`, ip: req.ip });
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

/**
 * v2.983 수집 부하 — 대상 서버마다 수집 CPU(원격 셸 + 끝난 자식) · sshd · 세 묶음 · 보내는 양 · 메모리, 노드마다 포탈 프로세스 CPU · 그중 집중 모니터링 해석 ·
 * 메모리 · 이벤트 루프 지연 p99 · 받은 양 · 중앙으로 · DB 쓰기. 최근 구간이면 대상마다 최신 30초 창(2분 넘으면 '오래됨' — 값을 싣지 않고 ageS 만), 과거 구간이면 DB(분당 한 줄) 평균.
 * 조회와 같은 문(admin + 전체 범위) · 보이는 대상만 · 데모 계정에는 엣지 노드를 싣지 않는다.
 */
const LOAD_LIVE_MAX_MS = 120_000;
api.get('/tools/focus-mon/load', adminOnly, fullScopeOnly, async (req, res) => {
  if (registryUnreadable(res)) return;
  const w = Q.normWindow({ win: req.query.win, end: req.query.end });
  const now = Date.now();
  const settings = registry.getSettings();
  const demoUser = isDemoGuest(req.user);
  const vis = visibleTargets(req);
  const sessOf = new Map(); for (const s of store.listSessions(now)) for (const id of s.targets) if (!sessOf.has(id)) sessOf.set(id, s);
  const loads = new Map(); const nodeVals = new Map(); const stale = new Map();
  let dbOk = true;
  if (w.past) {
    const fm = Math.floor(w.from / 60_000); const tm = Math.floor(w.to / 60_000);
    const [lr, nr] = await Promise.all([db.readLoads(fm, tm), db.readNodeLoads(fm, tm)]);
    if (lr == null || nr == null) dbOk = false;
    const byT = new Map(); for (const r of lr || []) { const a = byT.get(r.target) || []; a.push(r.v); byT.set(r.target, a); }
    for (const [id, list] of byT) loads.set(id, averageLoads(list));
    const byN = new Map(); for (const r of nr || []) { const a = byN.get(r.node) || []; a.push(r.v); byN.set(r.node, a); }
    for (const [k, list] of byN) nodeVals.set(k, averageNodes(list));
  } else {
    // 반증 F4: 최근 구간에는 **수집 중이거나 2분 안에 창이 온** 서버만 — 끝난 수집의 묵은 창은 싣지 않는다('오래됨 · 값 없음' 으로 쌓이지 않게).
    //   '오래됨' 은 수집 중인데 새 창이 2분 넘게 없는 서버만(그 서버는 값 없음으로 따로 센다).
    for (const t of vis) {
      const l = store.loadOf(t.id);
      if (l && now - l.at <= LOAD_LIVE_MAX_MS) loads.set(t.id, l);
      else if (l && sessOf.has(t.id)) stale.set(t.id, Math.round((now - l.at) / 1000));
    }
    for (const x of store.nodeLoads()) if (now - x.at <= LOAD_LIVE_MAX_MS) nodeVals.set(x.node, x);
  }
  const est = (l) => (l ? {
    byInterval: Object.fromEntries(INTERVALS.map((i) => [i, estimateLoad(l, { interval: i, procEvery: l.procEvery ?? settings.procEvery })])),
    byProcEvery: Object.fromEntries(PROC_EVERY_CHOICES.map((p) => [p, estimateLoad(l, { interval: l.interval, procEvery: p })])),
  } : null);
  // 반증 F7: 지난 구간은 그 구간에 기록이 있는 서버만 · 지금 수집 상태(방식)를 섞지 않는다
  const rows = vis.filter((t) => (w.past ? loads.has(t.id) : (sessOf.has(t.id) || loads.has(t.id)))).map((t) => {
    const l = loads.get(t.id) || null; const s = w.past ? null : sessOf.get(t.id);
    // agent = 담당 노드 표시(데모 서버는 표시용 엣지 이름 — 목 모드에서 실제로는 이 노드가 만든다 · 노드 표가 '데모' 라고 밝힌다)
    return { id: t.id, name: t.name, host: t.host, agent: t.agent || '', group: t.group || '', demo: !!t.demo,
      collecting: !!s, mode: s?.mode || null, interval: l?.interval ?? s?.interval ?? null, procEvery: l?.procEvery ?? settings.procEvery,
      load: l, staleS: stale.get(t.id) ?? null, judge: judgeLoad(l?.cpuPct, settings), est: est(l) };
  });
  // 보는 화면 심박 — **잠깐 보기 서버만**(이 탭만 열어 두어도 잠깐 보기가 '보는 화면 없음' 으로 끝나지 않게 · 2026-11-12 화면 확인).
  //   계속 수집은 남기지 않는다 — 남기면 쉬는 10초 주기가 2초로 올라가 재려는 부하 자체가 바뀐다(관찰이 값을 바꾼다).
  if (!w.past) store.touchView(rows.filter((r) => r.mode === 'watch').map((r) => r.id), now);
  // 노드 — 중앙 1 + 엣지(보이는 대상을 맡았거나 표본이 있는 엣지). 데모 계정에는 엣지를 싣지 않는다.
  const nodes = [{ node: '', kind: 'central', label: '중앙', servers: rows.filter((r) => !r.agent && r.collecting).length, load: nodeVals.get('') || null }];
  if (!demoUser) {
    const names = new Map();
    for (const a of knownAgentNames()) names.set(String(a).toLowerCase(), String(a));
    for (const r of rows) if (r.agent) names.set(r.agent.toLowerCase(), r.agent);
    for (const [k, name] of names) {
      const servers = rows.filter((r) => r.agent.toLowerCase() === k && r.collecting).length;
      let l = nodeVals.get(k) || null;
      const demoOnly = servers > 0 && rows.filter((r) => r.agent.toLowerCase() === k).every((r) => r.demo);
      if (!l && isMockMode() && demoOnly && !w.past) l = demoNodeLoad(name, servers, now); // 목 모드 표시용(실제 엣지 아님)
      if (!servers && !l) continue;
      nodes.push({ node: k, kind: 'edge', label: name, servers, demo: demoOnly, load: l });
    }
  }
  res.json({
    ok: true, live: !w.past, win: w.win, from: w.from, to: w.to, now, dbOk, mock: isMockMode(),
    settings: { loadWarnPct: settings.loadWarnPct, loadCritPct: settings.loadCritPct, procEvery: settings.procEvery, retentionDays: settings.retentionDays },
    ranges: { loadWarnPct: registry.SETTING_RANGES.loadWarnPct, loadCritPct: registry.SETTING_RANGES.loadCritPct },
    choices: { intervals: INTERVALS, procEvery: PROC_EVERY_CHOICES },
    targets: rows,
    nodes, totals: loadTotals(rows, nodes, settings), liveMaxS: LOAD_LIVE_MAX_MS / 1000,
    cadence: { windowSec: TOPO_EVERY_S, topoSec: TOPO_EVERY_S }, // 반증 F12 — 화면이 창 · 구성 주기 숫자를 박지 않게
  });
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

/**
 * 프로세스 세부 정보(v2.981 — 사용자 '프로세스를 클릭하면 어떤 프로세스인지 · 네트워크 · 디스크 · CPU'). 대상 하나 · pid 하나(+ 시작 tick sk).
 * 같은 문(admin · 전체 범위 — 전 법인 서버의 프로세스) · 사용자 이름은 관리자 판본만 원문 · 그 구간의 상위 30 에 없었으면 404.
 */
api.get('/tools/focus-mon/proc', adminOnly, fullScopeOnly, async (req, res) => {
  const vis = visibleById(req);
  const id = String(req.query.target || '');
  if (!vis.has(id)) return res.status(404).json({ ok: false, code: 'not-found', reason: '볼 대상이 없습니다.' });
  const pid = /^\d{1,7}$/.test(String(req.query.pid ?? '')) ? Number(req.query.pid) : null;
  if (!pid || pid > 4_194_304) return res.status(400).json({ ok: false, code: 'bad-pid', reason: 'PID 는 1 ~ 4194304 의 정수입니다.' });
  const skRaw = req.query.sk;
  const sk = skRaw == null || skRaw === '' ? null : /^\d{1,15}$/.test(String(skRaw)) ? Number(skRaw) : NaN;
  if (Number.isNaN(sk)) return res.status(400).json({ ok: false, code: 'bad-sk', reason: '시작 시각(sk)은 0 이상의 정수입니다.' });
  const w = Q.normWindow({ win: req.query.win, end: req.query.end });
  if (!w.past) store.touchView([id]);
  const admin = isAdminDetailUser(req.user);
  const r = await Q.procDetail(id, w, { pid, sk, maskUser: admin ? (u) => u : (u) => maskedIdToken(u) });
  if (!r) return res.status(404).json({ ok: false, code: 'not-in-window', reason: '이 구간의 CPU 상위 30 에 이 프로세스가 없습니다 — 끝났거나 상위 밖으로 내려갔습니다.' });
  res.json({ ok: true, win: w.win, from: w.from, to: w.to, past: w.past, usersMasked: !admin, ...r });
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
