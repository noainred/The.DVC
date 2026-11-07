/**
 * routes/api/bmPlaybookSlo.js — 리눅스 성능 6단계 **진단 플레이북 · 목표선(SLO)** API(설계 PROFILES §16 E · D · 아트보드 Runbook).
 *
 * 경로 `/tools/bm-usage/…`(도구 키 그대로). 권한 · 범위(security-api.md 6단계):
 *   · 플레이북 카탈로그 `GET /tools/bm-usage/playbooks` = tools(서버 정보 없음 — 정적 카탈로그).
 *   · 서버별 플레이북 `GET /tools/bm-usage/perf/:key/playbook` = tools + 조회 범위(resolvePerfTarget — 범위 밖 · 없는 키 404). **포탈은 명령을 실행하지 않는다**
 *     — 이 라우트는 판정 id · 맞는 플레이북 · 자리표시 값(장치 이름) · 포탈에서 먼저 볼 값만 준다(SSH · Redfish 호출 없음).
 *   · 목표선 `GET /tools/bm-usage/perf/:key/slo` = tools + 조회 범위 · 계열은 이 노드(trendFor) 또는 엣지 대행(3a 추이 — TREND 게이트 그대로 · 새 엣지 필드 없음) ·
 *     목표 대조는 이 응답을 만드는 노드(튜닝 · 용도와 같은 규칙).
 *   · 목표 설정 `GET /tools/bm-usage/slo` = tools · `PUT` = admin + requireSettingsOwner(소유자 ∧ 전체 범위) + tools + 감사 `bm-perf.slo`. 범위 계정의 읽기에는 서버별 목표 중 범위 밖 서버를 뺀다.
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { requireSettingsOwner } from '../admin/shared.js';
import { isAdminReq } from '../../auth/addressMask.js';
import { currentTargets } from '../../bmusage/poller.js';
import { latestUsage } from '../../bmusage/db.js';
import { hwFactsReader } from '../../bmusage/hwFacts.js';
import { buildPerfEntry, parseJsonCol } from '../../bmusage/perfView.js';
import { loadBmUsageSettings } from '../../bmusage/settings.js';
import { freshMsFor } from '../../bmusage/useJudge.js';
import { strOf } from '../../util/coercionTrap.js';
import { poolSettled } from '../../util/pool.js';
import { config } from '../../config.js';
import { resolvePerfTarget, bmAddressHosts, demoPerfRows } from './bmUsage.js';

const toolsPerm = requirePerm('tools');
const adminOnly = requireRole('admin');
const t = (v) => strOf(v, 4096).trim();
const NOT_FOUND = Object.freeze({ __status: 404, ok: false, reason: '대상 서버를 찾지 못했습니다.' });

function deps0(deps = {}) {
  return {
    currentTargets, bmAddressHosts, latestUsage, hwFactsReader,
    listEdgeBmUsage: async () => (await import('../../central/bmUsageEdgePull.js')).listEdgeBmUsage(),
    purposeOf: async (k) => (await import('../../insights/fleetTags.js')).fleetPurposeOf(k),
    trendFor: async (a) => (await import('../../bmusage/trendQuery.js')).trendFor(a),
    pullBmTrend: async (agent, key, q) => (await import('../../central/bmUsageEdgePull.js')).pullBmTrend(agent, { mode: 'history', key, query: q }),
    focusSummary: async () => (await import('../../bmusage/focus/run.js')).focusEnvelopeSummary(),
    ...deps,
  };
}
async function manualOf(D, target, realKey) {
  for (const k of [target?.serviceTag, realKey]) { const v = k ? await D.purposeOf(String(k)).catch(() => null) : null; if (v) return v; }
  return null;
}
/** 서버 한 대의 사실(이 노드 최신값 + 하드웨어 · 또는 엣지 보관분 — 판정은 수집 노드가 이미 했다). */
async function factsOf(found, D) {
  const s = loadBmUsageSettings();
  if (found.via === 'local') {
    const agent = config.agent?.name || '';
    const row0 = (await D.latestUsage({ json: true }).catch(() => [])).find((r) => t(r.key) === found.realKey && t(r.agent) === agent) || null;
    if (!row0) return { entry: null, row: null, detail: null, tuning: null };
    const row = (await demoPerfRows([row0], found.tg?.targets || [found.target]))[0];   // 데모 대상만 겹침(상세 화면과 같은 판정)
    const hwOf = await D.hwFactsReader({ agent, freshMs: freshMsFor(s.intervalMs) }).catch(() => () => null);
    const entry = buildPerfEntry({ row, hw: hwOf(found.target) || null, th: s.perf, intervalMs: s.intervalMs, full: true });
    return { entry, row, detail: entry.detail || parseJsonCol(row.detail_json), tuning: entry.tuning || parseJsonCol(row.tuning_json) };
  }
  const sn = found.rec?.snap || null;
  const e0 = (sn?.perf || []).find((p) => t(p.key) === found.realKey) || null;
  return { entry: e0, row: (sn?.rows || []).find((r) => t(r.key) === found.realKey) || null, detail: e0?.detail || null, tuning: e0?.tuning || null, snapAt: found.rec?.snapAt ?? null };
}

/* ── 진단 플레이북 ─────────────────────────────────────────────────────── */
export async function bmPlaybookCatalog() {
  const P = await import('../../bmusage/playbooks.js');
  const S = await import('../../bmusage/tuning/sources.js');
  return { ok: true, playbooks: P.playbookCatalog(), judgmentIds: P.allJudgmentIds(), stepKinds: P.STEP_KINDS, methodSources: P.METHOD_SOURCES,
    sources: S.ALL_SOURCES.map((x) => ({ id: x.id, title: x.title, url: x.url, grade: x.grade })), executes: false };
}
export async function bmPlaybookView(req, snap, deps = {}) {
  const D = deps0(deps);
  const allowed = scopedVcenterIds(req.user, snap);
  const key = t(req.params.key);
  if (!key) return { __status: 400, ok: false, reason: 'key 가 필요합니다.' };
  const found = await resolvePerfTarget(req, D, { allowed, isAdmin: isAdminReq(req), key });
  if (!found || found.denied) return NOT_FOUND;
  const P = await import('../../bmusage/playbooks.js');
  const O = await import('../../bmusage/opsView.js');
  const f = await factsOf(found, D);
  const manual = await manualOf(D, found.target, found.realKey);
  let profile = null;
  try { profile = O.profileViewFor({ tuning: f.tuning, detail: f.detail, entry: f.entry, row: f.row, manual }); } catch { profile = null; }
  const ids = P.judgmentIdsOf({ entry: f.entry, health: f.entry?.health || null, profile });
  // 포탈에서 먼저 볼 값 — 맞는 플레이북의 portal 단계가 고른 지표의 지금 값(수집 노드 값 그대로) · 마지막 집중 세션 요약.
  const cat = P.playbookCatalog();
  const matched = P.playbooksFor(ids);
  const want = new Set(cat.filter((p) => matched.some((m) => m.id === p.id)).flatMap((p) => p.steps.filter((s) => s.kind === 'portal').flatMap((s) => s.metrics || [])));
  const values = {};
  for (const m of want) values[m] = f.entry?.values?.[m] ?? f.row?.[m] ?? null;
  let focus = null;
  try {
    const list = found.via === 'local' ? (await D.focusSummary()) || [] : (found.rec?.snap?.focusSummary || []);
    focus = list.filter((s) => t(s.key) === found.realKey).sort((a, b) => (b.created || 0) - (a.created || 0))[0] || null;
  } catch { focus = null; }
  return { ok: true, key, via: found.via, ...(found.via === 'edge' ? { agent: found.agent, snapAt: f.snapAt ?? null } : {}), ids, matched, fill: P.fillOf(f.detail),
    portal: { values, at: f.entry?.ts ?? null, verdict: f.entry?.verdict ?? null, focus: focus ? { id: focus.id, status: focus.status, verdictFrom: focus.verdictFrom ?? null, verdictTo: focus.verdictTo ?? null, candidate: focus.candidate ?? null, start: focus.start ?? null } : null },
    noEntry: !f.entry, executes: false };
}

/* ── 목표선(SLO) ───────────────────────────────────────────────────────── */
export async function bmSloView(req, snap, deps = {}) {
  const D = deps0(deps);
  const allowed = scopedVcenterIds(req.user, snap);
  const key = t(req.params.key);
  if (!key) return { __status: 400, ok: false, reason: 'key 가 필요합니다.' };
  const found = await resolvePerfTarget(req, D, { allowed, isAdmin: isAdminReq(req), key });
  if (!found || found.denied) return NOT_FOUND;
  const L = await import('../../bmusage/slo.js');
  const q = req.query || {};
  const now = Date.now();
  const mw = L.monthWindow(now);
  const from0 = Number(q.from); const to0 = Number(q.to);
  const win = Number.isFinite(from0) && Number.isFinite(to0) && to0 > from0 ? { from: Math.max(from0, now - 400 * 86_400_000), to: Math.min(to0, now) } : mw;
  const res = L.sloRes(win.from, win.to);
  const cfg = L.loadSlo();
  const f = await factsOf(found, D);
  const manual = await manualOf(D, found.target, found.realKey);
  let apps = [];
  try { apps = ((await import('../../bmusage/opsView.js')).profileViewFor({ tuning: f.tuning, detail: f.detail, entry: f.entry, row: f.row, manual })?.detection?.activeApps || []).filter((a) => L.SLO_PROFILES.includes(a)); } catch { apps = []; }
  const goals = L.effectiveGoals(cfg, { key: found.realKey, apps });
  const settings = loadBmUsageSettings();
  const metrics = [...new Set(goals.map((g) => g.metric))];
  // 계열 — 지표마다 한 번(이 노드: 시간 단위 파일 · 엣지: 3a 추이 대행 — 동시 2 · 실패는 그 목표만 ‘읽지 못함’).
  const got = await poolSettled(metrics, 2, async (metric) => {
    const qq = { metric, from: win.from, to: win.to, res };
    if (found.via === 'local') return [metric, await D.trendFor({ agent: config.agent?.name || '', key: found.realKey, q: qq, settings })];
    const r = await D.pullBmTrend(found.agent, found.realKey, qq);
    return [metric, r?.ok ? r.body : { ok: false, reason: r?.reason || '엣지에서 추이를 읽지 못했습니다.', kind: r?.kind || 'error' }];
  });
  const byMetric = new Map(got.filter((x) => x.status === 'fulfilled').map((x) => x.value));
  const items = goals.map((g) => {
    const tr = byMetric.get(g.metric);
    if (!tr || tr.ok === false) return { goal: g, error: String(tr?.reason || '추이를 읽지 못했습니다').slice(0, 200), kind: tr?.kind || null };
    return { goal: g, res: tr.res, stepMs: tr.stepMs, ...L.evaluateGoal(g, tr.points || [], { from: win.from, to: win.to, stepMs: tr.stepMs, now }) };
  });
  return { ok: true, key, via: found.via, ...(found.via === 'edge' ? { agent: found.agent } : {}), ...win, month: win === mw, res, apps, items,
    maintenanceSource: 'none', canEdit: isAdminReq(req) && !allowed, ...(L.sloLoadError() ? { loadError: { reason: '목표 설정 파일을 읽지 못해 기본 목표로 계산했습니다' } } : {}) };
}
export async function bmSloSettingsRead(req, snap) {
  const L = await import('../../bmusage/slo.js');
  const cfg = L.loadSlo();
  const allowed = scopedVcenterIds(req.user, snap);
  let servers = cfg.servers;
  if (allowed || !isAdminReq(req)) {
    // 범위 계정 · 비관리자 — 서버별 목표는 보이는 서버 것만(키가 곧 서버 식별자다).
    const D = deps0();
    const keep = {};
    for (const k of Object.keys(cfg.servers || {})) { const f = await resolvePerfTarget(req, D, { allowed, isAdmin: isAdminReq(req), key: k }); if (f && !f.denied) keep[k] = cfg.servers[k]; }
    servers = keep;
  }
  return { ok: true, slo: { ...cfg, servers }, metrics: L.SLO_METRICS, bases: L.SLO_BASES, ops: L.SLO_OPS, profiles: L.SLO_PROFILES, limits: L.SLO_LIMITS, defaults: L.SLO_DEFAULTS,
    canEdit: isAdminReq(req) && !allowed, ...(L.sloLoadError() ? { loadError: { reason: '목표 설정 파일을 읽지 못해 기본 목표로 동작 중입니다(저장하면 새 파일 · 손상본은 보존)' } } : {}) };
}
async function sloWrite(req, res) {
  try {
    const L = await import('../../bmusage/slo.js');
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const out = L.saveSlo(b, { by: req.user?.username || '' });
    logAudit({ user: req.user?.username, action: 'bm-perf.slo', target: 'bm-perf-slo.json', ip: req.ip || '', detail: L.sloAuditSummary(out.prev, out.value) });
    res.json({ ok: true, slo: out.value });
  } catch (e) {
    if (e?.status === 400) return res.status(400).json({ ok: false, field: e.field || null, reason: String(e.message || e).slice(0, 300) });
    res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
  }
}

export function registerBmPlaybookSlo(api) {
  const send = (r, res) => { if (r.__status) { const { __status, ...rest } = r; return res.status(__status).json(rest); } return res.json(r); };
  const fail = (res, e) => res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
  api.get('/tools/bm-usage/playbooks', toolsPerm, async (_req, res) => { try { res.json(await bmPlaybookCatalog()); } catch (e) { fail(res, e); } });
  api.get('/tools/bm-usage/perf/:key/playbook', toolsPerm, async (req, res) => { try { send(await bmPlaybookView(req, store.get()), res); } catch (e) { fail(res, e); } });
  api.get('/tools/bm-usage/perf/:key/slo', toolsPerm, async (req, res) => { try { send(await bmSloView(req, store.get()), res); } catch (e) { fail(res, e); } });
  api.get('/tools/bm-usage/slo', toolsPerm, async (req, res) => { try { send(await bmSloSettingsRead(req, store.get()), res); } catch (e) { fail(res, e); } });
  api.put('/tools/bm-usage/slo', adminOnly, requireSettingsOwner, toolsPerm, (req, res) => sloWrite(req, res));
}
