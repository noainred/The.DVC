/**
 * routes/api/bmPerfOps.js — 리눅스 성능 5단계(v2.929 예정) API: 집중 모니터링 · 변경 이벤트 · 베이스라인 띠 · 구간 비교 · 알림 규칙(설계 PROFILES §13·§14).
 *
 * 경로는 전부 `/tools/bm-usage/…`(도구 키 그대로 — auth/toolAccess.js 의 도구별 접근 집행을 그대로 탄다 · 새 첫 세그먼트를 만들지 않는다).
 * 권한 · 범위(형제 라우트 bmUsage.js 와 같다 — security-api.md v2.929):
 *   · 조회: tools + vCenter scope — 범위 밖 · 귀속 없음 · 없는 키는 404(존재 은닉). 비관리자는 주소인 키를 가림 토큰으로도 찾는다(resolvePerfTarget 하나).
 *   · 집중 시작 · 중지: operator 이상(writeRole) + tools · 조회 밖 404 → **쓰기 범위 밖 403 무조건**(server/CLAUDE.md v2.733 함정) · 사유 2~300자 · 감사 `bm-perf.focus` ·
 *     엣지 위임 서버는 엣지 대행(POST 재전송 0). 실행자(by)는 관리자에게만 · 비관리자에게는 사유의 IPv4 를 가린다.
 *   · 알림 규칙 저장: 설정 소유자 등급(admin + requireSettingsOwner — 소유자 ∧ 전체 범위) + 감사 `bm-perf.rules`. 읽기는 tools(범위 계정은 자기 법인 예외 · 자기 법인 발송 기록만).
 *   · 응답 캐시(memoJson)는 변경 이벤트 · 띠 · 비교만 — 키에 범위 서명 + 역할 + 마지막 수집 시각 + 규칙 저장 시각. 집중은 진행 중 값이라 캐시하지 않는다.
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds, inUserWriteScope } from '../../auth/scope.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { requireSettingsOwner, fullScopeOnlyWith } from '../admin/shared.js';
import { addressMatcher, isAdminReq, maskedIdToken } from '../../auth/addressMask.js';
import { currentTargets, bmUsageStatus } from '../../bmusage/poller.js';
import { memoJson, scopeKey } from './shared.js';
import { strOf } from '../../util/coercionTrap.js';
import { config } from '../../config.js';
import { resolvePerfTarget, perfTargetFail, perfVcOf, failParts, bmAddressHosts, maskBmList, applyScope } from './bmUsage.js';

const toolsPerm = requirePerm('tools');
const writeRole = requireRole('admin', 'operator');
const adminOnly = requireRole('admin');
// 시험 실행은 이 노드의 전 대상을 규칙에 대 본다(서버 이름 · 법인이 실린다) — 범위 관리자에게는 열지 않는다(archScan route-gate-missing · 조회 밖 서버가 섞이지 않게).
const fullScopeOnly = fullScopeOnlyWith('알림 규칙 시험 실행은 이 노드의 전 서버를 대 보므로 전체 범위(vCenter 제한 없는) 관리자만 쓸 수 있습니다.');
const t = (v) => strOf(v, 4096).trim();
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const scrubIp = (v) => (typeof v === 'string' ? v.replace(IPV4_RE, (ip) => maskedIdToken(ip)) : v);

export function depsOf(deps = {}) {
  return {
    currentTargets, bmAddressHosts,
    listEdgeBmUsage: async () => (await import('../../central/bmUsageEdgePull.js')).listEdgeBmUsage(),
    focus: async () => import('../../bmusage/focus/run.js'),
    pull: async () => import('../../central/bmPerfOpsPull.js'),
    local: async (mode, o) => (await import('../../bmusage/perfOpsView.js')).localPerfOps(mode, o),
    rules: async () => (await import('../../bmusage/perfRules.js')).loadPerfRules(),
    audit: logAudit,
    // 6단계: 집중 세션 자동 주석(작성자 system — 운영 주석 화면 · 추이 ◆ 핀에 보인다). 실패는 시작 결과를 바꾸지 않는다.
    autoAnnotate: async (o) => (await import('./bmAnnotations.js')).autoFocusAnnotation(o),
    ...deps,
  };
}
async function resolve(req, snap, D) {
  const allowed = scopedVcenterIds(req.user, snap);
  const isAdmin = isAdminReq(req);
  const key = t(req.params.key);
  if (!key) return { err: { __status: 400, ok: false, reason: 'key 가 필요합니다.' } };
  // 다음 점검 ①: (법인, 키) 쌍 — 화면이 행의 vcenterId 를 함께 보낸다(질의 · 본문). 같은 키가 범위 안 여러 법인이면 400 ambiguous-key.
  const found = await resolvePerfTarget(req, D, { allowed, isAdmin, key, vcenterId: perfVcOf(req) });
  const bad = perfTargetFail(found);
  if (bad) return { err: bad };
  return { found, key, isAdmin, allowed };
}
/** 세션 · 표본의 비관리자 가림 — 실행자 · 사유 IPv4. */
function scrubFocus(body, isAdmin) {
  if (isAdmin || !body || typeof body !== 'object') return body;
  const s1 = (s) => (s && typeof s === 'object' ? (({ by: _b, ...x }) => ({ ...x, reason: scrubIp(x.reason) }))(s) : s);
  return { ...body, ...(Array.isArray(body.sessions) ? { sessions: body.sessions.map(s1) } : {}), ...(body.session ? { session: s1(body.session) } : {}), ...(body.reason ? { reason: scrubIp(body.reason) } : {}),
    ...(Array.isArray(body.changes) ? { changes: body.changes.map((e) => ({ ...e, before: scrubIp(e.before), after: scrubIp(e.after) })) } : {}) };
}
let _codeStatus = null;
async function focusStatusOf(code) { if (!_codeStatus) _codeStatus = (await import('../../bmusage/focus/run.js')).FOCUS_CODE_STATUS; return _codeStatus[code] ?? 200; }
/** 이 서버의 집중 설정 요약(화면이 ‘10분 × 1분’ 을 숫자로 박지 않게). */
async function focusPlan(D) {
  try { const r = await D.rules(); const F = await D.focus(); return F.sessionPlan(r); } catch { return null; }
}

/** GET /tools/bm-usage/perf/:key/focus[/:id] */
export async function bmFocusRead(req, snap, deps = {}) {
  const D = depsOf(deps);
  const r = await resolve(req, snap, D);
  if (r.err) return r.err;
  const { found, key, isAdmin } = r;
  const id = t(req.params.id);
  let res;
  if (found.via === 'local') {
    const F = await D.focus();
    const keepDays = (await D.rules().catch(() => null))?.focus?.keepDays ?? 30;
    res = id ? await F.getFocusLocal({ key: found.realKey, id }) : await F.listFocusLocal({ key: found.realKey, keepDays });
  } else res = await (await D.pull()).pullEdgeFocus(found.agent, { key: found.realKey, id });
  const plan = await focusPlan(D);
  const writable = inUserWriteScope(req.user, snap, t(found.target.vcenterId));
  const body = scrubFocus({ ...res, key, via: found.via, ...(found.via === 'edge' ? { agent: found.agent } : {}), writable, plan, pathsOs: (found.target.paths || []).includes('os'), pathsIdrac: (found.target.paths || []).includes('idrac') }, isAdmin);
  const st = res?.ok ? 200 : await focusStatusOf(res?.code || 'edge');
  return st === 200 ? body : { __status: st, ...body };
}
/** POST /tools/bm-usage/perf/:key/focus — 시작(사유 필수 · 감사). */
export async function bmFocusStart(req, deps = {}) {
  const D = depsOf(deps);
  const snap = store.get();
  const S = await import('../../bmusage/snapshot/run.js');
  const reason = S.cleanReason(req.body?.reason);
  if (!reason) return { status: 400, body: { ok: false, code: 'bad-reason', reason: '사유를 2자 이상 적어야 합니다(감사 기록에 남습니다).' } };
  const r = await resolve(req, snap, D);
  if (r.err) return r.err.code ? failParts(r.err) : { status: r.err.__status, body: { ok: false, code: 'bad-request', reason: r.err.reason } };
  const { found, key, isAdmin } = r;
  // ⚠ 쓰기 범위는 조건 없이(조회 무제한 + writeVcenters 계정 — server/CLAUDE.md v2.733). 조회 밖은 위에서 404.
  if (!inUserWriteScope(req.user, snap, t(found.target.vcenterId))) return { status: 403, body: { ok: false, code: 'forbidden', error: 'forbidden', reason: '이 서버의 법인에 쓰기 권한이 없습니다(조회 전용) — 집중 모니터링은 SSH · Redfish 를 분마다 엽니다.' } };
  return focusStartResolved(req, D, { found, key, isAdmin, reason });
}
/**
 * 범위 · 사유 검사를 마친 서버 하나에 집중을 건다(단건 시작 · 6단계 비교의 ‘5대 동시 집중’ 이 같은 함수 — 법인 상한 · 대기열 · 인증 가드는 startFocusLocal/엣지가 그대로).
 *   감사 `bm-perf.focus`(via 표지 — 비교에서 건 것은 origin:'compare') · 6단계 운영 주석(집중 세션 자동 주석 — 실패해도 시작 결과는 그대로).
 */
export async function focusStartResolved(req, D, { found, key, isAdmin, reason, origin = '' }) {
  const by = String(req.user?.username || '').slice(0, 64);
  const out = found.via === 'local'
    ? await (await D.focus()).startFocusLocal({ target: found.target, reason, by, trigger: 'manual' })
    : await (await D.pull()).runEdgeFocus(found.agent, { key: found.realKey, reason, by });
  if (!['bad-reason', 'not-found'].includes(out?.code)) {
    D.audit({ user: req.user?.username, action: 'bm-perf.focus', target: found.realKey, ip: req.ip || '',
      detail: JSON.stringify({ via: found.via, agent: found.agent || '', ok: !!out?.ok, code: out?.code || '', id: out?.id || null, status: out?.status || null, ...(origin ? { origin } : {}), reason: reason.slice(0, 120) }).slice(0, 300) });
  }
  if (out?.ok && out?.id && typeof D.autoAnnotate === 'function') {
    try { await D.autoAnnotate({ found, id: out.id, reason, by, status: out.status || null }); } catch { /* 주석 실패는 집중 시작을 바꾸지 않는다 */ }
  }
  const body = scrubFocus({ ...out, key, via: found.via, ...(found.via === 'edge' ? { agent: found.agent } : {}) }, isAdmin);
  return { status: out?.ok ? 200 : await focusStatusOf(out?.code || 'edge'), body };
}
/** POST /tools/bm-usage/perf/:key/focus/:id/stop — 중지(시작과 같은 권한 · 감사). */
export async function bmFocusStop(req, deps = {}) {
  const D = depsOf(deps);
  const snap = store.get();
  const r = await resolve(req, snap, D);
  if (r.err) return r.err.code ? failParts(r.err) : { status: r.err.__status, body: { ok: false, code: 'bad-request', reason: r.err.reason } };
  const { found, key, isAdmin } = r;
  if (!inUserWriteScope(req.user, snap, t(found.target.vcenterId))) return { status: 403, body: { ok: false, code: 'forbidden', error: 'forbidden', reason: '이 서버의 법인에 쓰기 권한이 없습니다(조회 전용).' } };
  const id = t(req.params.id).slice(0, 40);
  const by = String(req.user?.username || '').slice(0, 64);
  const out = found.via === 'local' ? await (await D.focus()).stopFocusLocal({ key: found.realKey, id }) : await (await D.pull()).stopEdgeFocus(found.agent, { key: found.realKey, id, by });
  if (out?.ok) D.audit({ user: req.user?.username, action: 'bm-perf.focus.stop', target: found.realKey, ip: req.ip || '', detail: JSON.stringify({ via: found.via, agent: found.agent || '', id }).slice(0, 300) });
  return { status: out?.ok ? 200 : await focusStatusOf(out?.code || 'edge'), body: scrubFocus({ ...out, key, via: found.via }, isAdmin) };
}

/** GET /tools/bm-usage/focus — 함대(진행 중 · 대기 · 최근 24시간): 이 노드 + 엣지 봉투 요약. 범위 계정은 자기 법인만 · 비관리자는 주소인 키를 가린다. */
export async function bmFocusFleet(req, snap, deps = {}) {
  const D = depsOf(deps);
  const allowed = scopedVcenterIds(req.user, snap);
  const isAdmin = isAdminReq(req);
  const F = await D.focus();
  const tg = await D.currentTargets().catch(() => ({ targets: [] }));
  const nameOf = new Map((tg.targets || []).map((x) => [x.key, x.name || x.key]));
  const local = ((await F.focusEnvelopeSummary()) || []).map((s) => ({ ...s, name: nameOf.get(s.key) || s.key, via: 'local', agent: config.agent?.name || '' }));
  const edge = [];
  for (const rec of await D.listEdgeBmUsage()) {
    const en = new Map((rec?.snap?.targets || []).map((x) => [String(x.key), x.name || x.key]));
    for (const s of rec?.snap?.focusSummary || []) edge.push({ ...s, name: en.get(s.key) || s.key, via: 'edge', agent: rec.agent, snapAt: rec.snapAt || null });
  }
  let list = applyScope([...local, ...edge], allowed);
  if (!isAdmin) {
    const hosts = await D.bmAddressHosts(tg);
    list = maskBmList(list, addressMatcher(hosts));
  }
  const running = list.filter((s) => s.status === 'running').length;
  const queued = list.filter((s) => s.status === 'queued').length;
  return { ok: true, at: Date.now(), running, queued, sessions: list.slice(0, 500), ...(isAdmin ? {} : { addressHidden: true }) };
}

/** GET /tools/bm-usage/perf/:key/(changes|baseline|compare) — 이 노드 계산 또는 엣지 대행(보관 없음). */
export async function bmPerfOpsRead(req, snap, mode, deps = {}) {
  const D = depsOf(deps);
  const r = await resolve(req, snap, D);
  if (r.err) return r.err;
  const { found, key, isAdmin } = r;
  let res;
  if (found.via === 'local') res = await D.local(mode, { key: found.realKey, q: req.query || {} });
  else {
    const p = await (await D.pull()).pullEdgePerfOps(found.agent, mode, { key: found.realKey, query: req.query || {} });
    res = p.ok ? p.body : { __status: 502, ok: false, kind: p.kind, reason: p.reason };
  }
  if (!res || typeof res !== 'object') return { __status: 500, ok: false, reason: '응답이 없습니다.' };
  const scrubEv = (e) => ({ ...e, before: scrubIp(e.before), after: scrubIp(e.after), item: scrubIp(e.item) });
  const out = { ...res, key, via: found.via, ...(found.via === 'edge' ? { agent: found.agent } : {}) };
  if (!isAdmin) {
    if (Array.isArray(out.events)) out.events = out.events.map(scrubEv);
    if (Array.isArray(out.changes)) out.changes = out.changes.map(scrubEv);
    if (Array.isArray(out.tuning)) out.tuning = out.tuning.map(scrubEv);
    out.addressHidden = true;
  }
  return out;
}

/* ── 알림 규칙(설정) ─────────────────────────────────────────────────────── */
/** GET /tools/bm-usage/perf-rules — 규칙 · 상한 · 기준값 · 상태 · 발송 기록(이 노드 + 엣지 봉투). 범위 계정은 자기 법인 것만. */
export async function bmRulesRead(req, snap, deps = {}) {
  const D = depsOf(deps);
  const allowed = scopedVcenterIds(req.user, snap);
  const isAdmin = isAdminReq(req);
  const R = await import('../../bmusage/perfRules.js');
  const A = await import('../../bmusage/perfAlerts.js');
  const { slotStatus } = await import('../../bmusage/slots.js');
  const F = await D.focus();
  const rules = R.loadPerfRules();
  const keepVc = (arr) => (allowed ? (arr || []).filter((v) => allowed.has(v)) : (arr || []));
  // 8b단계: 랙 배치는 보이는 법인 것만(범위 계정에 다른 법인의 랙 · 서버 키를 주지 않는다) · 편집 텍스트는 서버가 만든다(웹이 형식을 다시 해석하지 않는다).
  const racks = (rules.power?.racks || []).filter((r) => !allowed || allowed.has(r.vcenterId));
  const scopedRules = { ...rules, rules: Object.fromEntries(Object.entries(rules.rules || {}).map(([id, x]) => [id, { ...x, corpsOff: keepVc(x.corpsOff) }])), focus: { ...rules.focus, autoCorps: keepVc(rules.focus?.autoCorps) },
    power: { ...(rules.power || {}), racks, racksText: R.racksToText(racks) } };
  const st = A.perfAlertStatus();
  const sent = [...(st.sent || []).map((x) => ({ ...x, agent: config.agent?.name || '', via: 'local' }))];
  // 엣지 발송 기록 — 서버 키 · 법인 · 제목은 중앙이 다시 세운다(반증 F9: 엣지가 준 vcenterId 로 범위를 가르지 않는다 · 그 엣지 대상 밖 키는 버린다).
  const { centralizeEdgeSent } = await import('../../central/bmPerfOpsPull.js');
  let edgeDropped = 0;
  for (const rec of await D.listEdgeBmUsage()) {
    const c = await centralizeEdgeSent(rec.agent, rec?.snap || {}, deps);
    edgeDropped += c.dropped;
    for (const x of c.list) sent.push({ ...x, agent: rec.agent, via: 'edge' });
  }
  let sentShown = applyScope(sent, allowed).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 300);
  if (!isAdmin) { const tg = await D.currentTargets().catch(() => ({ targets: [] })); sentShown = maskBmList(sentShown, addressMatcher(await D.bmAddressHosts(tg))).map((x) => ({ ...x, title: scrubIp(x.title) })); }
  const loadError = R.perfRulesLoadError();
  return {
    ok: true, rules: scopedRules, defaults: R.DEFAULTS, ruleDefaults: R.RULE_DEFAULTS, limits: R.LIMITS, ruleIds: R.RULE_IDS, conds: R.RULE_CONDS, channels: R.CHANNELS, baselineMetrics: R.BASELINE_METRICS,
    autoFocusOff: R.AUTOFOCUS_OFF,   // 자동 집중을 걸지 않는 규칙(서버 정규화와 같은 목록 — 화면 ‘해당 없음’)
    ...(loadError ? { loadError: { at: loadError.at, reason: isAdmin ? loadError.reason : '설정 파일을 읽지 못했습니다' } } : {}),
    status: { tracked: st.tracked, day: st.day, counts: allowed ? Object.fromEntries(Object.entries(st.counts || {}).filter(([vc]) => allowed.has(vc))) : st.counts, ...(st.loadError ? { stateError: st.loadError.reason } : {}),
      slots: slotStatus(), focusActive: F.focusActiveCount(), focusQueued: F.focusQueuedCount(), last: bmUsageStatus().last?.perfAlerts || null },
    sent: sentShown, ...(edgeDropped && isAdmin ? { edgeSentDropped: edgeDropped } : {}),
    // 정직 기록 — 이 노드 전용 설정(엣지 배포는 다음 판) · 유지보수 창 억제 원천 없음.
    scope: config.agent?.centralUrl ? 'edge-local' : 'central-local', maintenanceSource: 'none',
    readOnly: !isAdmin || !!allowed, ...(isAdmin ? {} : { addressHidden: true }),
  };
}
async function rulesWrite(req, res) {
  try {
    const R = await import('../../bmusage/perfRules.js');
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const out = R.savePerfRules(b, { by: req.user?.username || '' });
    logAudit({ user: req.user?.username, action: 'bm-perf.rules', target: 'bm-perf-rules.json', ip: req.ip || '', detail: R.rulesAuditSummary(out.prev, out.value) });
    res.json({ ok: true, rules: { ...out.value, power: { ...(out.value.power || {}), racksText: R.racksToText(out.value.power?.racks || []) } } });
  } catch (e) {
    if (e?.status === 400) return res.status(400).json({ ok: false, field: e.field || null, reason: String(e.message || e).slice(0, 300) });
    res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
  }
}
/** POST /tools/bm-usage/perf-rules/dry-run — 시험 실행(지금 값에 대 보기 — 보내지 않고 상태도 바꾸지 않는다 · 이 노드 대상만). */
export async function bmRulesDryRun(req, deps = {}) {
  const R = await import('../../bmusage/perfRules.js');
  const A = await import('../../bmusage/perfAlerts.js');
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  let rules;
  try { rules = body && body.rules ? R.normalizeRules(body, { strict: true }).value : R.loadPerfRules(); } catch (e) { return { status: 400, body: { ok: false, field: e.field || null, reason: String(e.message || e).slice(0, 300) } }; }
  const { latestUsage } = await import('../../bmusage/db.js');
  const { buildPerfEntry, parseJsonCol } = await import('../../bmusage/perfView.js');
  const { loadBmUsageSettings } = await import('../../bmusage/settings.js');
  const s = loadBmUsageSettings();
  const tg = await (deps.currentTargets || currentTargets)();
  const agent = config.agent?.name || '';
  const byKey = new Map(tg.targets.map((x) => [x.key, x]));
  const rows = (await latestUsage({ json: true }).catch(() => [])).filter((r) => String(r.agent || '') === agent && byKey.has(String(r.key)));
  const B = rules.rules?.baseline?.on ? await import('../../bmusage/baseline.js') : null;
  const bands = B ? await B.slotBands({ agent, cfg: rules.baseline, intervalMs: s.intervalMs }).catch(() => null) : null;
  const items = rows.map((r) => {
    const tgt = byKey.get(String(r.key));
    const detail = parseJsonCol(r.detail_json);
    return { key: tgt.key, name: tgt.name || tgt.key, vcenterId: tgt.vcenterId || '', entry: buildPerfEntry({ row: r, hw: null, th: s.perf, intervalMs: s.intervalMs, full: false }), health: detail?.health || null, dev: bands ? B.deviationsFor(bands, tgt.key, r) : null, profile: null };
  });
  const servers = items.length;
  // 다음 점검 ②: 전력 · 온도 규칙도 같은 입력(이 노드 원천 · 이 노드 대상 — 폴러와 같은 powerAlertItems)으로 대 본다(켠 것이 있을 때만).
  let powerError = null; let powerItems = null;
  const PA = await import('../../bmusage/powerAlerts.js');
  if (Object.keys(rules.rules || {}).some((id) => PA.isPowerRule(id))) {
    try {
      const px = await PA.powerAlertItems({ targets: tg.targets || [], rules, ...(deps.powerSources || deps.judgeCtx ? { deps: { ...(deps.powerSources ? { sources: deps.powerSources } : {}), ...(deps.judgeCtx ? { judgeCtx: deps.judgeCtx } : {}) } } : {}) });
      powerItems = px.length; for (const x of px) items.push(x);
    } catch (e) { powerError = String(e?.message || e).slice(0, 200); }
  }
  const out = await A.runPerfAlerts(items, { rules, dryRun: true });
  // 반증 n2 F3: 전력 판정 입력 실패(powerError) · 전력 항목 수(powerItems) · 판정 보류 수(counts.unknown)를 화면이 0건과 갈라 그린다(BmPerfRulesPanel DryRunResult).
  return { status: 200, body: { ...out, servers, ...(powerItems != null ? { powerItems } : {}), ...(powerError ? { powerError } : {}), note: '지금 값에 대 본 결과입니다 — 보내지 않았고 상태도 바꾸지 않았습니다(이 노드가 직접 수집하는 서버만 · 지속 주기는 1주기로 봅니다 · 전력 규칙은 같은 표본 보류 없이 지금 표본 하나로 봅니다).' } };
}

export function registerBmPerfOps(api) {
  const opsKey = async (req) => {
    let at = 0; try { at = (await import('../../bmusage/perfRules.js')).loadPerfRules().at || 0; } catch { at = -1; }
    return `${scopeKey(req.user, store.get())}|${isAdminReq(req) ? 'a' : 'u'}|${bmUsageStatus().last?.at || 0}|r${at}`;
  };
  const send = (r, res) => { if (r.__status) { const { __status, ...rest } = r; return res.status(__status).json(rest); } return res.json(r); };
  const fail = (res, e) => res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
  // 집중 모니터링 — 실행 · 중지는 operator 이상, 조회는 tools + 조회 범위. 진행 중 값이라 캐시하지 않는다.
  api.get('/tools/bm-usage/focus', toolsPerm, async (req, res) => { try { send(await bmFocusFleet(req, store.get()), res); } catch (e) { fail(res, e); } });
  api.get('/tools/bm-usage/perf/:key/focus', toolsPerm, async (req, res) => { try { send(await bmFocusRead(req, store.get()), res); } catch (e) { fail(res, e); } });
  api.get('/tools/bm-usage/perf/:key/focus/:id', toolsPerm, async (req, res) => { try { send(await bmFocusRead(req, store.get()), res); } catch (e) { fail(res, e); } });
  api.post('/tools/bm-usage/perf/:key/focus', writeRole, toolsPerm, async (req, res) => { try { const r = await bmFocusStart(req); res.status(r.status).json(r.body); } catch (e) { fail(res, e); } });
  api.post('/tools/bm-usage/perf/:key/focus/:id/stop', writeRole, toolsPerm, async (req, res) => { try { const r = await bmFocusStop(req); res.status(r.status).json(r.body); } catch (e) { fail(res, e); } });
  // 변경 이벤트 · 베이스라인 띠 · 구간 비교 — 응답 캐시(범위 서명 + 역할 + 마지막 수집 + 규칙 저장 시각).
  for (const mode of ['changes', 'baseline', 'compare']) {
    api.get(`/tools/bm-usage/perf/:key/${mode}`, toolsPerm, async (req, res) => memoJson(req, res, `bm-${mode}`, (snap) => bmPerfOpsRead(req, snap, mode), { extraKey: await opsKey(req) }));
  }
  // 알림 규칙 — 읽기 tools · 저장은 설정 소유자 등급(소유자 ∧ 전체 범위) + 감사 · 시험 실행은 관리자(보내지 않는다).
  api.get('/tools/bm-usage/perf-rules', toolsPerm, async (req, res) => { try { send(await bmRulesRead(req, store.get()), res); } catch (e) { fail(res, e); } });
  api.put('/tools/bm-usage/perf-rules', adminOnly, requireSettingsOwner, toolsPerm, (req, res) => rulesWrite(req, res));
  api.post('/tools/bm-usage/perf-rules/dry-run', adminOnly, fullScopeOnly, toolsPerm, async (req, res) => { try { const r = await bmRulesDryRun(req); res.status(r.status).json(r.body); } catch (e) { fail(res, e); } });
}
