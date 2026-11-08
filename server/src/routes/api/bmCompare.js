/**
 * routes/api/bmCompare.js — 리눅스 성능 6단계 **서버 비교(2~5대 한 화면)** API(설계 PROFILES §15 · 아트보드 Multi).
 *
 * 경로는 전부 `/tools/bm-usage/compare…`(도구 키 그대로 — auth/toolAccess.js 의 도구별 접근 집행을 그대로 탄다).
 * 권한 · 범위(security-api.md 6단계):
 *   · 조회 `GET /tools/bm-usage/compare` = tools + vCenter scope. 서버마다 형제 라우트와 같은 해석(resolvePerfTarget — 범위 밖 · 귀속 없음 · 없는 키는
 *     **그 열만 ‘없음’**: 사라진 서버와 범위 밖 서버가 같은 모양이라 존재가 새지 않는다).
 *   · **기본은 같은 법인만** — 첫 서버의 법인이 비교 법인이고 다른 법인 서버는 ‘other-corp’ 열(값을 당기지 않는다).
 *     ‘법인 간 허용’(cross=1)은 **전체 범위 계정만** — 범위 계정이 cross=1 을 보내면 404(토글이 없는 기능 · 은닉).
 *   · 엣지 위임 서버는 그 엣지에서 **서버당 요청 1개**(central/bmComparePull.js — 6단계 엣지 경로 · 구버전이면 그 열만 old-version) ·
 *     한 엣지가 실패하면 그 열만 오래됨(봉투 보관분 값) 또는 없음 · 법인별 읽은 시각을 함께 싣는다.
 *   · 5대 동시 집중 `POST /tools/bm-usage/compare/focus` = operator 이상 + tools · 사유 1회 · **전 서버를 먼저 검사**(하나라도 조회 밖이면 404 ·
 *     쓰기 밖이면 403 — 일부만 시작하지 않는다) → 서버마다 5단계 시작 함수 그대로(법인 상한 · 대기열 · 인증 가드 · 감사).
 *   · 저장된 세트 = 사용자별 · 중앙 파일(bmusage/compareSets.js) · 쓰기는 operator 이상(상태 변경 라우트 규약) · 범위 계정은 cross 세트를 저장할 수 없다(400).
 * 판정은 서버 — 편차 · 최고 · 스큐 후보 · 눈금은 multiCompare.buildCompareTable 이 만든다(웹은 그리기만).
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds, inUserWriteScope } from '../../auth/scope.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { isAdminReq } from '../../auth/addressMask.js';
import { currentTargets } from '../../bmusage/poller.js';
import { publicTarget, maskTargetAddress } from '../../bmusage/targets.js';
import { latestUsage } from '../../bmusage/db.js';
import { hwFactsReader } from '../../bmusage/hwFacts.js';
import { buildPerfEntry, compactPerfEntry, parseJsonCol } from '../../bmusage/perfView.js';
import { loadBmUsageSettings } from '../../bmusage/settings.js';
import { freshMsFor } from '../../bmusage/useJudge.js';
import { strOf } from '../../util/coercionTrap.js';
import { poolSettled } from '../../util/pool.js';
import { config } from '../../config.js';
import { resolvePerfTarget, bmAddressHosts, demoPerfRows, perfAddressMatcher } from './bmUsage.js';
import { depsOf as focusDepsOf, focusStartResolved } from './bmPerfOps.js';
import * as M from '../../bmusage/multiCompare.js';

const toolsPerm = requirePerm('tools');
const writeRole = requireRole('admin', 'operator');
const t = (v) => strOf(v, 4096).trim();
const NOT_FOUND = Object.freeze({ __status: 404, ok: false, reason: '대상 서버를 찾지 못했습니다.' });

function deps0(deps = {}) {
  return {
    currentTargets, bmAddressHosts, latestUsage, hwFactsReader,
    listEdgeBmUsage: async () => (await import('../../central/bmUsageEdgePull.js')).listEdgeBmUsage(),
    localSeries: async (o) => (await import('../../bmusage/perfOpsView.js')).localPerfOps('compare-series', o),
    edgeSeries: async (agent, o) => (await import('../../central/bmComparePull.js')).pullEdgeCompareSeries(agent, o),
    rules: async () => (await import('../../bmusage/perfRules.js')).loadPerfRules(),
    purposeOf: async (k) => (await import('../../insights/fleetTags.js')).fleetPurposeOf(k),
    profileView: async (o) => (await import('../../bmusage/profiles/match.js')).profileView(o),
    minEdgeVersion: async () => (await import('../../central/featureMinEdgeVersion.js')).stage6MinEdgeVersion(),
    audit: logAudit,
    ...deps,
  };
}
/** 키 목록 파싱(순수) — 쉼표 · 중복 제거 · 길이 상한. */
export function parseCompareKeys(v, max = 8) {
  const raw = Array.isArray(v) ? v : String(typeof v === 'string' ? v : '').split(',');
  const out = [...new Set(raw.map((k) => t(k)).filter(Boolean).map((k) => k.slice(0, 256)))];
  return { keys: out.slice(0, max), over: out.length > max };
}
async function maxServersOf(D) { try { return (await D.rules()).compare?.maxServers ?? 5; } catch { return 5; } }
/** 요청 하나 동안 대상 해석을 한 번만(resolvePerfTarget 은 서버마다 부른다 — 등록부 · 분류를 다섯 번 읽지 않게). */
function memoTargets(D) {
  let p = null;
  return { ...D, currentTargets: () => (p ||= D.currentTargets()) };
}
async function purposeGroupOf(D, target, realKey, facts) {
  let manual = null;
  for (const k of [target?.serviceTag, realKey]) { if (!k || manual) continue; manual = await D.purposeOf(String(k)).catch(() => null); }
  try {
    const pv = await D.profileView({ tuning: facts.tuning || null, detail: facts.detail || null, entry: facts.entry || null, row: facts.row || null, manual });
    const apps = [...(pv?.detection?.activeApps || [])].sort();
    if (!apps.length) return null;
    return `${apps.join('+')}${manual?.role ? `:${String(manual.role).slice(0, 32)}` : ''}`;
  } catch { return null; }
}

/** GET /tools/bm-usage/compare */
export async function bmCompareView(req, snap, deps = {}) {
  const D = memoTargets(deps0(deps));
  const allowed = scopedVcenterIds(req.user, snap);
  const isAdmin = isAdminReq(req);
  const q = req.query || {};
  const maxServers = await maxServersOf(D);
  const { keys, over } = parseCompareKeys(q.keys, maxServers);
  if (over) return { __status: 400, ok: false, code: 'too-many', reason: `서버는 ${maxServers}대까지 비교합니다.`, maxServers };
  if (!keys.length) return { __status: 400, ok: false, code: 'no-keys', reason: '비교할 서버를 고르세요.', maxServers };
  const cross = String(q.cross || '') === '1';
  // 법인 간 허용은 전체 범위 계정만 — 범위 계정에는 이 기능이 없다(토글 미노출 · 404 은닉).
  if (cross && allowed) return NOT_FOUND;
  const w = M.compareWindow({ range: String(q.range || '24h'), from: q.from != null && q.from !== '' ? Number(q.from) : null, to: q.to != null && q.to !== '' ? Number(q.to) : null });
  if (!w) return { __status: 400, ok: false, code: 'bad-window', reason: 'from 이 to 보다 앞이어야 합니다.' };
  const metrics = M.parseCompareMetrics(q.metrics, { group: String(q.group || '') });
  const value = ['avgpeak', 'avg', 'peak'].includes(String(q.value || '')) ? String(q.value) : 'avgpeak';

  // ① 해석 — 범위 밖 · 귀속 없음 · 없는 키는 그 열만 ‘없음’(같은 모양).
  const resolved = [];
  for (const key of keys) {
    const found = await resolvePerfTarget(req, D, { allowed, isAdmin, key });
    resolved.push({ key, found: found && !found.denied ? found : null });
  }
  const first = resolved.find((r) => r.found);
  const corp = first ? t(first.found.target.vcenterId) : null;
  const s = loadBmUsageSettings();
  const agent = config.agent?.name || '';
  // 데모(mock) 대상은 상세 화면과 같은 겹침(demoPerfRows — mock 이 아니면 그대로) — 비교의 판정이 상세와 갈리지 않게.
  const localRows = resolved.some((r) => r.found?.via === 'local') ? await demoPerfRows(await D.latestUsage({ json: true }).catch(() => []), (await D.currentTargets().catch(() => ({ targets: [] }))).targets || []) : [];
  const hwOf = resolved.some((r) => r.found?.via === 'local') ? await D.hwFactsReader({ agent, freshMs: freshMsFor(s.intervalMs) }).catch(() => () => null) : () => null;
  const minEdge = await D.minEdgeVersion().catch(() => null);
  const tg = await D.currentTargets().catch(() => ({ targets: [] }));
  let match = null; let hosts = [];
  if (!isAdmin) {
    ({ hosts, match } = await perfAddressMatcher(D, tg));   // 이 노드 + 엣지 보관분 호스트(주석 목록과 같은 판정기 — 반증 F11)
  }
  const nameOf = (target) => {
    const pt = target?.idrac || target?.osHost ? publicTarget(target) : target;
    return isAdmin ? String(pt?.name || pt?.key || '') : String(maskTargetAddress(pt, hosts, match)?.name || '');
  };

  // ② 열마다(병렬 5) — 같은 법인만이면 다른 법인 열은 값을 당기지 않는다.
  const settled = await poolSettled(resolved, 5, async ({ key, found }) => {
    if (!found) return { key, state: 'none' };
    const target = found.target;
    const vc = t(target.vcenterId);
    const base = { key, name: nameOf(target), vcenterId: vc || '', via: found.via, ...(found.via === 'edge' ? { agent: found.agent } : {}) };
    if (!cross && vc !== corp) return { ...base, state: 'other-corp' };
    let entry = null; let hw = null; let facts = {}; let readAt = null; let snapAt = null;
    if (found.via === 'local') {
      const row = localRows.find((r) => t(r.key) === found.realKey && t(r.agent) === agent) || null;
      hw = hwOf(target) || null;
      entry = row ? buildPerfEntry({ row, hw, th: s.perf, intervalMs: s.intervalMs, full: false }) : null;
      facts = { row, tuning: row ? parseJsonCol(row.tuning_json) : null, detail: row ? parseJsonCol(row.detail_json) : null, entry };
      readAt = entry?.ts ?? null;
    } else {
      const sn = found.rec?.snap || null;
      const e0 = (sn?.perf || []).find((p) => t(p.key) === found.realKey) || null;
      entry = e0 ? compactPerfEntry(e0) : null;
      hw = e0?.hw || null;
      facts = { row: (sn?.rows || []).find((r) => t(r.key) === found.realKey) || null, tuning: e0?.tuning || null, detail: e0?.detail || null, entry: e0 };
      snapAt = found.rec?.snapAt ?? null;
      readAt = entry?.ts ?? null;
    }
    const purposeGroup = await purposeGroupOf(D, target, found.realKey, facts);
    let series = null; let state = 'ok'; let reason = null; let kind = null; let seriesAt = null;
    const o = { key: found.realKey, metrics, from: w.from, to: w.to };
    if (found.via === 'local') {
      const r = await D.localSeries({ key: found.realKey, q: { metrics: metrics.join(','), from: w.from, to: w.to } }).catch((e) => ({ ok: false, reason: String(e?.message || e).slice(0, 160) }));
      if (r?.ok) { series = r; seriesAt = Date.now(); } else { state = entry ? 'stale' : 'none'; reason = r?.reason || '계열을 읽지 못했습니다.'; }
    } else {
      const r = await D.edgeSeries(found.agent, o);
      if (r?.ok) { series = r.body; seriesAt = Date.now(); }
      else { kind = r?.kind || 'error'; reason = r?.reason || '엣지에서 계열을 읽지 못했습니다.'; state = kind === 'old-version' ? 'old-version' : (entry ? 'stale' : 'none'); }
    }
    if (!entry && state === 'ok') state = 'no-sample';
    const dev = series?.dev || null;
    return {
      ...base, state, ...(reason ? { reason: String(reason).slice(0, 200) } : {}), ...(kind ? { kind } : {}),
      readAt, ...(snapAt ? { snapAt } : {}), seriesAt, purposeGroup,
      verdict: entry?.verdict ?? null, coverage: entry?.coverage ?? null, perResource: entry?.perResource ?? null, paths: Array.isArray(target.paths) ? target.paths : [],
      hwValues: M.hwValuesOf(hw), series: series?.metrics || null, res: series?.res || null, stepMs: series?.stepMs || null,
      dev, devWorst: M.worstDeviation(dev),
    };
  });
  const columns = settled.map((x, i) => (x.status === 'fulfilled' ? x.value : { key: resolved[i].key, state: 'none', reason: '처리 중 오류' }));
  // 법인별 읽은 시각(머리 — ‘법인 간’ 이면 법인마다 다르다).
  const corps = [];
  for (const c of columns) {
    if (!['ok', 'stale', 'old-version', 'no-sample'].includes(c.state)) continue;
    let g = corps.find((x) => x.vcenterId === c.vcenterId);
    if (!g) { g = { vcenterId: c.vcenterId, readAt: null, seriesAt: null, via: c.via, agent: c.agent || null, states: [] }; corps.push(g); }
    if (c.readAt != null) g.readAt = g.readAt == null ? c.readAt : Math.min(g.readAt, c.readAt);
    if (c.seriesAt != null) g.seriesAt = g.seriesAt == null ? c.seriesAt : Math.min(g.seriesAt, c.seriesAt);
    if (!g.states.includes(c.state)) g.states.push(c.state);
  }
  const table = M.buildCompareTable(columns, { metrics, value });
  return {
    ok: true, at: Date.now(), corp, cross, crossAllowed: !allowed, maxServers, ...w, metrics, value,
    groups: M.COMPARE_GROUP_IDS, groupMetrics: M.COMPARE_GROUPS, metricMeta: Object.fromEntries(M.COMPARE_METRICS.map((m) => [m.col, { unit: m.unit, scaleMax: m.scaleMax, src: m.src }])),
    columns, corps, table, ...(minEdge ? { minEdgeVersion: minEdge } : {}), ...(isAdmin ? {} : { addressHidden: true }),
  };
}

/** POST /tools/bm-usage/compare/focus — 고른 서버 전부에 집중(사유 1회 · 전 서버 먼저 검사 · 서버마다 5단계 시작 함수). */
export async function bmCompareFocus(req, deps = {}) {
  const D = memoTargets({ ...focusDepsOf(deps), ...deps0(deps) });
  const snap = store.get();
  const S = await import('../../bmusage/snapshot/run.js');
  const reason = S.cleanReason(req.body?.reason);
  if (!reason) return { status: 400, body: { ok: false, code: 'bad-reason', reason: '사유를 2자 이상 적어야 합니다(감사 기록에 남습니다).' } };
  const maxServers = await maxServersOf(D);
  const { keys, over } = parseCompareKeys(req.body?.keys, maxServers);
  if (over || !keys.length) return { status: 400, body: { ok: false, code: 'bad-request', reason: `서버는 1~${maxServers}대여야 합니다.` } };
  const allowed = scopedVcenterIds(req.user, snap);
  const isAdmin = isAdminReq(req);
  const list = [];
  for (const key of keys) {
    const found = await resolvePerfTarget(req, D, { allowed, isAdmin, key });
    if (!found || found.denied) return { status: 404, body: { ok: false, code: 'not-found', reason: '대상 서버를 찾지 못했습니다.' } };
    list.push({ key, found });
  }
  // 쓰기 범위는 조건 없이(조회 무제한 + writeVcenters 계정 — server/CLAUDE.md v2.733). 하나라도 밖이면 아무것도 시작하지 않는다.
  if (list.some(({ found }) => !inUserWriteScope(req.user, snap, t(found.target.vcenterId)))) {
    return { status: 403, body: { ok: false, code: 'forbidden', error: 'forbidden', reason: '고른 서버 중 쓰기 권한이 없는 법인의 서버가 있습니다(조회 전용) — 아무것도 시작하지 않았습니다.' } };
  }
  const results = [];
  for (const { key, found } of list) {
    const r = await focusStartResolved(req, D, { found, key, isAdmin, reason, origin: 'compare' });
    results.push({ key, httpStatus: r.status, ...r.body });
  }
  const started = results.filter((r) => r.ok).length;
  return { status: 200, body: { ok: started > 0, started, total: results.length, results } };
}

/* ── 저장된 세트 ─────────────────────────────────────────────────────────── */
async function setsRead(req, res) {
  try {
    const C = await import('../../bmusage/compareSets.js');
    res.json({ ok: true, sets: C.listCompareSets(req.user?.username || ''), max: C.SETS_PER_USER, maxServers: await maxServersOf(deps0()) });
  } catch (e) {
    if (e?.status === 503) return res.status(503).json({ ok: false, code: 'settingsUnreadable', reason: String(e.message || e).slice(0, 300) });
    res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
  }
}
async function setsWrite(req, res) {
  try {
    const C = await import('../../bmusage/compareSets.js');
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const allowed = scopedVcenterIds(req.user, store.get());
    if (b.cross === true && allowed) return res.status(400).json({ ok: false, code: 'bad-cross', reason: '법인 간 비교 세트는 전체 범위 계정만 저장할 수 있습니다.' });
    const set = C.saveCompareSet({ user: req.user?.username || '', id: typeof b.id === 'string' ? b.id : '', name: b.name, keys: b.keys, cross: b.cross === true, maxServers: await maxServersOf(deps0()) });
    logAudit({ user: req.user?.username, action: 'bm-perf.compare-set', target: set.id, ip: req.ip || '', detail: JSON.stringify({ op: b.id ? 'update' : 'create', n: set.keys.length, cross: set.cross }).slice(0, 200) });
    res.json({ ok: true, set });
  } catch (e) {
    const st = [400, 404, 409, 503].includes(e?.status) ? e.status : 500;
    res.status(st).json({ ok: false, code: e?.code || 'error', reason: String(e?.message || e).slice(0, 300) });
  }
}
async function setsDelete(req, res) {
  try {
    const C = await import('../../bmusage/compareSets.js');
    C.deleteCompareSet({ user: req.user?.username || '', id: t(req.params.id).slice(0, 40) });
    logAudit({ user: req.user?.username, action: 'bm-perf.compare-set', target: t(req.params.id).slice(0, 40), ip: req.ip || '', detail: '{"op":"delete"}' });
    res.json({ ok: true });
  } catch (e) {
    const st = [404, 503].includes(e?.status) ? e.status : 500;
    res.status(st).json({ ok: false, code: e?.code || 'error', reason: String(e?.message || e).slice(0, 300) });
  }
}

export function registerBmCompare(api) {
  const send = (r, res) => { if (r.__status) { const { __status, ...rest } = r; return res.status(__status).json(rest); } return res.json(r); };
  const fail = (res, e) => res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
  // 사람이 누를 때만 부르는 조회(폴링 없음) — 엣지 요청이 섞이므로 응답 캐시를 두지 않는다(늦게 온 이전 응답은 화면이 버린다).
  api.get('/tools/bm-usage/compare', toolsPerm, async (req, res) => { try { send(await bmCompareView(req, store.get()), res); } catch (e) { fail(res, e); } });
  api.post('/tools/bm-usage/compare/focus', writeRole, toolsPerm, async (req, res) => { try { const r = await bmCompareFocus(req); res.status(r.status).json(r.body); } catch (e) { fail(res, e); } });
  api.get('/tools/bm-usage/compare/sets', toolsPerm, (req, res) => setsRead(req, res));
  api.put('/tools/bm-usage/compare/sets', writeRole, toolsPerm, (req, res) => setsWrite(req, res));
  api.delete('/tools/bm-usage/compare/sets/:id', writeRole, toolsPerm, (req, res) => setsDelete(req, res));
}
