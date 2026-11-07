/**
 * routes/svcmon/settingsSync.js — 설정 연동 · Monitoring 개요(기술 뷰) · 실패 알림 설정(v2.915).
 *
 * 게이트(형제 라우트와 같은 기준 — shared.js 머리말):
 *  - 마운트가 이미 `requirePerm('svcmon')` 아래다(index.js).
 *  - `/settings-sync/*` 는 **조회도 adminOnly + fullScopeOnly** — 전 법인 설정의 주소(호스트·포트)가 실린다. 통신 점검 `/tools/link-check/targets`
 *    와 같은 게이트다(반증 H1: 처음 판본은 canEdit 이라 operator 가 봉인 비밀인 웹훅 URL·통합 계정 매핑을 받았다 — 행도 화이트리스트로 자른다).
 *  - `/overview` 는 `/state` 와 같은 조회 기준(svcmon 권한) — 대상 이름·호스트는 `/state` 가 이미 싣는 것과 같다. 엣지 주소(sourceIp)는 싣지 않는다.
 *  - `/alert-settings` 조회 canEdit · 저장 adminOnly + fullScopeOnly(알림 채널로 실제 발송이 나간다 — 로그 설정 PUT 과 같은 기준).
 *  - 엣지 노드(CENTRAL_URL)는 설정 연동을 쓰지 않는다(409) — 엣지의 svcmon 대상은 중앙 배정 사본이다.
 */

import { logAudit } from '../../audit.js';
import { listTargets, storeRevision, planBulkTargets } from '../../svcmon/store.js';
import {
  readCatalog, planApply, previewOf, executePlan, detachTarget, getOptions, setOptions, kindMeta, driftRing, dailySummary, syncEvents,
  lastDetection, syncAvailableHere, ackDrift, MAX_ROWS, MAX_APPLY, GONE_ACTIONS, EXCLUDED_KINDS, SYNC_ROOT, detectTiming,
} from '../../svcmon/settingsSync.js';
import { recordBatch } from '../../svcmon/batches.js';
import { buildDashAsync } from '../../svcmon/dash.js';
import { recentTransitions, hourlySeries, getAlertSettings, saveAlertSettings, alertStats, transitionsSince, alertBatchInfo, HOURS_KEEP } from '../../svcmon/transitions.js';
import { getResults, executesHere, pollerRole } from '../../svcmon/poller.js';
import { edgeSummary, edgeState, listAgentNames, MAX_ROWS_PER_AGENT } from '../../central/svcmonEdge.js';
import { listAssignments, setAssignment, DEFAULT_EXCEPT_TYPES } from '../../central/svcmonAssign.js';
import { canEdit, fullScopeOnly, adminOnly } from './shared.js';

const t = (v) => String(v ?? '').trim();

function edgeRows(now = Date.now()) {
  const assigned = new Map();
  try { for (const a of listAssignments()) assigned.set(a.agent, a); } catch { /* 배정 파일 못 읽음 — 보고만 싣는다 */ }
  const out = new Map();
  for (const e of edgeSummary(now)) {
    // ⚠ sourceIp 를 싣지 않는다 — 필요한 필드만 고른다(v2.595 가림 규약의 형제 경로를 만들지 않게).
    out.set(e.agent, {
      agent: e.agent, silent: !!e.silent, ageMs: e.ageMs ?? null, rows: e.rows || 0, items: e.items || 0,
      counts: e.counts || null, assignedTargets: assigned.get(e.agent)?.counts?.targets ?? null, byAgent: assigned.get(e.agent)?.scope?.byAgent === true,
      assignState: assigned.get(e.agent)?.state || '',
    });
  }
  for (const [name, a] of assigned) {
    if (out.has(name)) continue;
    out.set(name, { agent: name, silent: null, ageMs: null, rows: 0, items: 0, counts: null, assignedTargets: a.counts?.targets ?? 0, byAgent: a.scope?.byAgent === true, assignState: a.state || '', noReport: true });
  }
  return [...out.values()].sort((a, b) => a.agent.localeCompare(b.agent));
}

const edgeOnly = (res) => res.status(409).json({ ok: false, reason: 'edge-node', error: '엣지 노드에서는 설정 연동을 쓰지 않습니다 — Monitoring 대상은 중앙에서 배정됩니다.' });

/**
 * 담당 엣지 배정 동기화 — byAgent 배정이거나 배정이 없는 엣지만 다시 굳힌다. **경로 기준 배정을 byAgent 로 바꾸지 않는다**
 * (그 엣지가 맡던 경로 대상이 통째로 빠진다 — 파괴적). 그런 엣지는 '건너뜀' 으로 보고하고 엣지 배정 탭에서 사람이 고른다.
 */
function syncAssignments(agents, user) {
  const out = [];
  let cur = [];
  try { cur = listAssignments(); } catch (e) { return agents.map((agent) => ({ agent, ok: false, reason: `배정 파일을 읽지 못했습니다: ${t(e?.message).slice(0, 120)}` })); }
  const byName = new Map(cur.map((a) => [a.agent, a]));
  for (const agent of agents) {
    const a = byName.get(agent);
    if (a && a.scope?.byAgent !== true) { out.push({ agent, ok: false, skipped: true, reason: '이 엣지는 경로 기준 배정입니다 — 엣지 배정 탭에서 범위를 확인하세요(자동으로 바꾸지 않습니다).' }); continue; }
    try {
      const picked = listTargets().filter((x) => t(x.agent) === agent).map((x) => ({ ...x, tests: x.tests.map((y) => ({ ...y })) }));
      const r = setAssignment(agent, { byAgent: true, exceptTypes: a?.exceptTypes || DEFAULT_EXCEPT_TYPES, note: '설정 연동 동기화' }, picked, { user });
      out.push({ agent, ok: true, targets: r?.counts?.targets ?? picked.length });
    } catch (e) { out.push({ agent, ok: false, reason: t(e?.message).slice(0, 200) }); }
  }
  return out;
}

/* ── Monitoring 개요(기술 뷰) ── */
let _dashMemo = null;       // { key, at, body }
let _dashInflight = null;   // { key, promise } — 같은 세대의 동시 요청은 계산 하나를 함께 기다린다
let _dashBuilds = 0;        // 테스트 전용 — 실제 계산 횟수

/**
 * 개요 본문 계산 — **시간 기준 양보**(buildDashAsync · createYielder 15ms)로 이벤트 루프를 붙잡지 않는다.
 * v2.928(반증 M6 후속): 예전에는 전 점검 + 전 엣지 행을 동기로 돌았다(실측: 로컬 200k 0.39초 · 엣지 192k 0.86초 · 상한 1.28M 5.6초 블로킹).
 *   엣지 행은 엣지 하나씩 만들고(sort:false — localeCompare 정렬 생략) 표 위젯은 상위 K 만 유지한다.
 */
const OVERVIEW_TRANSITIONS = 60;
async function computeDash(now) {
  _dashBuilds += 1;
  const agents = listAgentNames();   // 이름만 — edgeSummary 는 전 행을 순회한다(반증 재검토 N3: 1.28M 행 301ms). 엣지 표(edgeRows)에서 한 번만 돈다.
  const dash = await buildDashAsync({
    targets: listTargets(), results: getResults(), agents, now, executes: executesHere(),
    edgeItemsOf: (agent) => edgeState(agent, { limit: MAX_ROWS_PER_AGENT, sort: false }, now)?.items || [],
  });
  return {
    ok: true, at: now, ...dash,
    hourly: hourlySeries(now), transitions: recentTransitions(OVERVIEW_TRANSITIONS), since: transitionsSince(),
    limits: { hours: HOURS_KEEP, transitions: OVERVIEW_TRANSITIONS },   // v2.927(점검 D1-08): 화면 문구('최근 N시간 · 최근 N건')용
    edges: edgeRows(now), executes: executesHere(), role: pollerRole(),
    alerts: { enabled: getAlertSettings().enabled, ...alertStats() },
    kindLabels: Object.fromEntries(Object.entries(kindMeta()).map(([k, v]) => [k, v.label])),
  };
}

/** 테스트 전용 — 개요 캐시·계산 횟수. */
export function _dashStateForTest({ reset = false } = {}) { if (reset) { _dashMemo = null; _dashInflight = null; _dashBuilds = 0; } return { builds: _dashBuilds }; }

export function registerSettingsSync(svcmonRouter) {

/** 카탈로그 × Monitoring 대상 — 행 · 집계 · 드리프트 이력 · 엣지 · 이벤트. */
svcmonRouter.get('/settings-sync/catalog', adminOnly, fullScopeOnly, async (req, res) => {
  if (!syncAvailableHere()) return edgeOnly(res);
  const cat = await readCatalog();
  const rows = cat.rows.slice(0, MAX_ROWS);
  const assignedTargets = new Map();
  for (const x of listTargets()) if (x.origin && t(x.agent)) assignedTargets.set(t(x.agent), (assignedTargets.get(t(x.agent)) || 0) + 1);
  res.json({
    ok: true, at: cat.at, readMs: cat.ms, rows, truncated: cat.rows.length > rows.length, total: cat.rows.length,
    counts: cat.counts, sourceErrors: cat.sourceErrors, kinds: kindMeta(), excluded: EXCLUDED_KINDS,
    options: getOptions(), drift: { ring: driftRing(), daily: dailySummary(), last: lastDetection() },
    edges: edgeRows().map((e) => ({ ...e, syncTargets: assignedTargets.get(e.agent) || 0 })),
    events: syncEvents().slice(0, 50), limits: { maxApply: MAX_APPLY, goneActions: GONE_ACTIONS }, root: SYNC_ROOT,
    // v2.927(점검 D1-08): 화면 문구('기동 N 뒤부터 M마다')가 서버 상수를 박지 않게 감지 주기를 싣는다.
    detect: detectTiming(),
    role: pollerRole(), storeRev: storeRevision(),
  });
});

async function planFrom(body = {}) {
  const keys = Array.isArray(body.keys) ? body.keys.map(t).filter(Boolean) : [];
  if (!keys.length) return { error: '적용할 항목을 고르세요.' };
  if (keys.length > MAX_APPLY) return { error: `한 번에 ${MAX_APPLY}건까지 적용할 수 있습니다(요청 ${keys.length}건).` };
  const { buildSettingsTargets } = await import('../../linkcheck/settingsLinks.js');
  const built = await buildSettingsTargets();
  const cat = await readCatalog({ build: async () => built });
  const builtByKey = new Map((built.targets || []).map((x) => [t(x.id), x]));
  const plan = planApply(cat.rows, keys, {
    enabled: body.enabled === true, goneAction: GONE_ACTIONS.includes(body.goneAction) ? body.goneAction : 'disable',
    withChecks: body.withChecks !== false, builtByKey,
  });
  return { plan, keys };
}

/** 미리보기 — 저장하지 않는다(대량 등록과 같은 검증 코드 planBulkTargets 로 판정). */
svcmonRouter.post('/settings-sync/preview', adminOnly, fullScopeOnly, async (req, res) => {
  if (!syncAvailableHere()) return edgeOnly(res);
  const r = await planFrom(req.body || {});
  if (r.error) return res.status(400).json({ ok: false, error: r.error });
  const bulk = r.plan.add.length ? planBulkTargets(r.plan.add.map((a) => a.row), { dedup: true, trustedOrigin: true }) : null;
  res.json({ ok: true, preview: previewOf(r.plan, bulk) });
});

/** 적용 — 추가(전부 성공 또는 전부 취소) · 주소 반영 · 사라짐 처리 · (선택) 담당 엣지 배정 동기화. */
svcmonRouter.post('/settings-sync/apply', adminOnly, fullScopeOnly, async (req, res) => {
  if (!syncAvailableHere()) return edgeOnly(res);
  const r = await planFrom(req.body || {});
  if (r.error) return res.status(400).json({ ok: false, error: r.error });
  const user = req.user?.username || '';
  const out = executePlan(r.plan, { user });
  if (out.added) {
    recordBatch({ id: out.batch, createdBy: user, source: 'settings', kind: 'infra', path: SYNC_ROOT, targets: out.added, tests: out.newTests, note: `설정 연동 — ${r.plan.add.length}건 선택` });
  }
  const assign = req.body?.syncAssign === true && out.agents.length ? syncAssignments(out.agents, user) : [];
  logAudit({
    user, action: 'svcmon.settings-sync.apply', target: out.batch,
    detail: `추가 ${out.added}(점검 ${out.newTests}) · 주소 반영 ${out.changed.length} · 사라짐 ${out.gone.length} · 건너뜀 ${r.plan.skip.length} · 실패 ${out.errors.length}${out.committed ? '' : ' · 추가 취소'}${assign.length ? ` · 배정 ${assign.filter((x) => x.ok).length}/${assign.length}` : ''}`,
  });
  // 추가가 취소돼도(오류 1건이면 0건 — 대량 등록 규약) 200 + ok:false 로 결과 본문을 그대로 돌려준다 — 화면이 어떤 행이 왜 막혔는지 보여 준다.
  res.json({ ok: out.committed && !out.errors.length, result: { ...out, skip: r.plan.skip.slice(0, 200) }, assign });
});

/** 자동 등록 종류(기본 없음 = 끔). */
svcmonRouter.put('/settings-sync/options', adminOnly, fullScopeOnly, (req, res) => {
  if (!syncAvailableHere()) return edgeOnly(res);
  const before = getOptions();
  const next = setOptions(req.body || {});
  logAudit({ user: req.user?.username, action: 'svcmon.settings-sync.options', detail: `자동 등록 ${before.autoKinds.join(',') || '없음'} → ${next.autoKinds.join(',') || '없음'}` });
  res.status(next.saved ? 200 : 500).json({ ok: next.saved, options: { autoKinds: next.autoKinds } });
});

/** 배너 '확인' — 지금까지 설정에 새로 생긴 항목을 본 것으로 둔다(미등록 상태는 설정 연동 탭에 그대로 남는다). */
svcmonRouter.post('/settings-sync/ack', adminOnly, fullScopeOnly, (req, res) => {
  if (!syncAvailableHere()) return edgeOnly(res);
  const r = ackDrift();
  res.status(r.saved ? 200 : 500).json({ ok: r.saved, ackAt: r.ackAt });
});

/** 연동 해제 — 대상은 남기고 출처만 지운다(수동 대상으로 전환). */
svcmonRouter.post('/settings-sync/detach/:id', adminOnly, fullScopeOnly, (req, res) => {
  const r = detachTarget(String(req.params.id || ''));
  if (!r) return res.status(404).json({ ok: false, error: '대상을 찾을 수 없습니다.' });
  if (r.changed) logAudit({ user: req.user?.username, action: 'svcmon.settings-sync.detach', target: r.target?.id, detail: r.target?.name || '' });
  res.json({ ok: true, changed: r.changed });
});

/* ── Monitoring 개요(기술 뷰) — 라우트 ── */
svcmonRouter.get('/overview', async (req, res) => {
  const now = Date.now();
  // 같은 저장소 세대·30초 안이면 재사용(화면 60초 갱신 — 무거운 API 15초 폴링 금지). 계산 중이면 그 계산을 함께 기다린다.
  const key = `${storeRevision()}|${Math.floor(now / 30_000)}`;
  if (_dashMemo && _dashMemo.key === key) return res.json(_dashMemo.body);
  if (!_dashInflight || _dashInflight.key !== key) {
    const promise = computeDash(now)
      // 늦게 끝난 옛 계산이 더 새 캐시를 덮지 않게(반증 재검토 L1).
      .then((body) => { if (!_dashMemo || _dashMemo.at <= now) _dashMemo = { key, at: now, body }; return body; })
      .finally(() => { if (_dashInflight?.promise === promise) _dashInflight = null; });
    _dashInflight = { key, promise };
  }
  try { res.json(await _dashInflight.promise); }
  catch (e) { res.status(500).json({ ok: false, error: `개요 집계 실패: ${t(e?.message).slice(0, 200)}` }); }
});

/* ── 실패 알림 설정 ── */
svcmonRouter.get('/alert-settings', canEdit, (req, res) => {
  // v2.927(점검 D1-08): 요약 묶음 창·기준 건수를 싣는다 — 화면이 '20초 안에 6건' 을 박지 않게(+1 해석은 서버 alertBatchInfo 한 곳).
  res.json({ ok: true, settings: getAlertSettings(), stats: alertStats(), batch: alertBatchInfo() });
});
svcmonRouter.put('/alert-settings', adminOnly, fullScopeOnly, (req, res) => {
  try {
    const before = getAlertSettings();
    const next = saveAlertSettings(req.body || {});
    logAudit({ user: req.user?.username, action: 'svcmon.alert-settings', detail: `${JSON.stringify(before)} → ${JSON.stringify(next)}`.slice(0, 500) });
    res.json({ ok: true, settings: next });
  } catch (e) { res.status(500).json({ ok: false, error: `저장 실패: ${t(e?.message).slice(0, 200)}` }); }
});
}
