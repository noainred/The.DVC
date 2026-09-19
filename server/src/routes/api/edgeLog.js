/**
 * routes/api/edgeLog.js — 특수기능 '엣지 로그·진행상태' 화면 API(v2.549).
 *
 * 사용자 요청(2026-09-17): "진행상태를 edge 의 로그를 읽어와서 확인할 수 있는 기능 만들어줘".
 * 선택: **로그 + 진행상태** · **중앙이 당긴다(pull) + 폴백** · **즉석 조회 + 최근분 보관**.
 *
 * ── 권한: adminOnly + fullScopeOnly ─────────────────────────────────────────
 * 로그 줄에는 **호스트명·IP·장비 식별자·실패 원문**이 그대로 들어간다(가리는 것은 비밀 값뿐 —
 * `edgelog/redact.js`). operator 는 `tools` 를 기본 보유하므로 `toolsPerm` 만으로는 전 법인의
 * 내부 주소가 열린다 — v2.500 D/M1 'relaycheck 는 admin 에게만' 과 **같은 기준**이다.
 * 범위 제한 계정에는 나눌 축이 없다(엣지는 vCenter 귀속이 아니다) → 403(v2.525 Horizon 규약).
 *
 * ── 이 라우트가 하지 않는 것 ────────────────────────────────────────────────
 *  · **상시 폴링하지 않는다.** 사람이 누를 때만 엣지로 나간다(로그는 대부분 볼 일이 없다).
 *  · **장비에 접속하지 않는다.** 엣지가 이미 갖고 있는 로그·상태만 읽는다(v2.548 파트 장애와 같은 판단).
 */
import { requireRole } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { listCollectors } from '../../collector/registry.js';
import { allCollectorStatus } from '../../collector/state.js';
import { pullEdgeLog, MIN_EDGE_VERSION } from '../../central/edgeLogPull.js';
import { lastDataEdgeLog, edgeLogHistory, edgeLogSummaries, storeInfo } from '../../central/edgeLogStore.js';
import { enqueueEdgeLogJob, edgeLogJobState, edgeLogJobsInfo } from '../../central/edgeLogJobs.js';
import { GROUP_LABEL, STATUS_LABEL } from '../../edgelog/spec.js';
import { MAX_LOG_LIMIT, DEFAULT_LOG_LIMIT } from '../../edgelog/collect.js';
import { config, currentVersion } from '../../config.js';

const adminOnly = requireRole('admin');
const fullScopeOnly = (req, res, next) => {
  if (scopedVcenterIds(req.user, store.get())) {
    return res.status(403).json({ ok: false, reason: '엣지 로그 화면은 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다.' });
  }
  next();
};

const t = (v) => String(v ?? '').trim();

/** semver 비교(`partFaults.js cmpVersion` 과 같은 규칙 — 형식이 아니면 null). */
export function cmpVersion(a, b) {
  const pa = t(a).replace(/^v/, '').split('.').map(Number);
  const pb = t(b).replace(/^v/, '').split('.').map(Number);
  if (pa.length < 3 || pb.length < 3 || pa.some(Number.isNaN) || pb.some(Number.isNaN)) return null;
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * 엣지 행 조립(순수 — 테스트가 고정한다).
 *
 * ⚠ **'가져온 적 없다' 를 '안 된다' 라고 말하지 않는다.** 이 기능은 사람이 누를 때만 가므로
 *   보관분이 없는 것이 **정상 초기 상태**다. `kind` 는 '지금 누르면 될 것 같은가' 를 말한다:
 *     `ready`(버전 충분 · 아직 안 가져옴) / `have`(가져온 적 있음) / `failed`(마지막 시도가 실패) /
 *     `old-version`(엣지가 구버전 — 눌러도 안 된다) / `unknown-version`(수집 서버 상태를 모른다 —
 *     한 번도 export 를 주지 않았다) / `disabled`(중앙에서 비활성) / `no-url`.
 */
export function buildEdgeRows({ collectors = [], status = {}, summaries = [], jobs = {}, minVersion = MIN_EDGE_VERSION } = {}) {
  const byAgent = new Map(summaries.map((s) => [t(s.agent).toLowerCase(), s]));
  const rows = [];
  const seen = new Set();
  for (const c of collectors) {
    const name = t(c.name); if (!name) continue;
    const key = name.toLowerCase(); seen.add(key);
    const st = status[c.id] || null;
    const version = t(st?.version);
    const s = byAgent.get(key) || null;
    const cmp = cmpVersion(version, minVersion);
    let kind;
    if (c.enabled === false) kind = 'disabled';
    else if (!t(c.url)) kind = 'no-url';
    else if (s && s.ok === false) kind = 'failed';
    else if (s) kind = 'have';
    else if (!version) kind = 'unknown-version';
    else if (cmp != null && cmp < 0) kind = 'old-version';
    else kind = 'ready';
    rows.push({
      agent: name, id: c.id, datacenter: t(c.datacenter) || null,
      enabled: c.enabled !== false, hasUrl: !!t(c.url), version: version || null, kind,
      // 수집 서버 상태(export pull)의 최신 시각 — '엣지가 살아 있는가' 의 독립 근거다.
      collectorAt: st?.at || null, collectorOk: st?.ok ?? null,
      hasData: s ? !!s.hasData : false,
      last: s ? { at: s.at, via: s.via, ok: s.ok, error: s.error, ms: s.ms, logCount: s.logCount, logTruncated: s.logTruncated, statusFailed: s.statusFailed, maskedFields: s.maskedFields, kept: s.kept, node: s.node } : null,
      job: jobs[key] || { state: 'none' },
    });
  }
  // 등록부에 없는데 보관분이 있는 것(수집 서버를 지운 뒤) — 숨기지 않는다.
  for (const s of summaries) {
    const key = t(s.agent).toLowerCase();
    if (seen.has(key)) continue;
    rows.push({ agent: s.agent, id: null, datacenter: null, enabled: null, hasUrl: null, version: s.node?.version || null,
      kind: s.ok === false ? 'failed' : 'have', unregistered: true, collectorAt: null, collectorOk: null, hasData: !!s.hasData,
      last: { at: s.at, via: s.via, ok: s.ok, error: s.error, ms: s.ms, logCount: s.logCount, logTruncated: s.logTruncated, statusFailed: s.statusFailed, maskedFields: s.maskedFields, kept: s.kept, node: s.node },
      job: jobs[key] || { state: 'none' } });
  }
  rows.sort((a, b) => t(a.agent).localeCompare(t(b.agent)));
  const counts = {};
  for (const r of rows) counts[r.kind] = (counts[r.kind] || 0) + 1;
  counts.hasData = rows.filter((r) => r.hasData).length;   // '보관분 있음' 은 내용이 있는 것만 센다
  return { rows, counts, minVersion };
}

function edgesNow() {
  const collectors = (() => { try { return listCollectors(); } catch { return []; } })();
  const status = (() => { try { return allCollectorStatus(); } catch { return {}; } })();
  const summaries = edgeLogSummaries();
  const jobs = {};
  for (const c of collectors) if (t(c.name)) jobs[t(c.name).toLowerCase()] = edgeLogJobState(c.name);
  for (const s of summaries) { const k = t(s.agent).toLowerCase(); if (!jobs[k]) jobs[k] = edgeLogJobState(s.agent); }
  return buildEdgeRows({ collectors, status, summaries, jobs });
}

export function registerEdgeLog(api) {

/** 목록 + 배너 재료. 엣지로 나가지 않는다(보관분과 등록부만 읽는다). */
api.get('/tools/edge-log', adminOnly, fullScopeOnly, (_req, res) => {
  const e = edgesNow();
  res.json({
    ok: true, at: Date.now(), ...e,
    store: storeInfo(), jobs: edgeLogJobsInfo(),
    limits: { defaultLimit: DEFAULT_LOG_LIMIT, maxLimit: MAX_LOG_LIMIT },
    labels: { group: GROUP_LABEL, status: STATUS_LABEL },
    self: { agent: config.agent.name || '', isEdge: !!config.agent.centralUrl, version: currentVersion() },
  });
});

/** 이 포탈(중앙) 자신의 로그·진행상태. ⚠ 경로를 `/:agent` 와 섞지 않는다(엣지 이름과 충돌한다). */
api.get('/tools/edge-log-local', adminOnly, fullScopeOnly, async (req, res) => {
  try {
    const { collectEdgeLog } = await import('../../edgelog/collect.js');
    const snap = await collectEdgeLog({
      since: Number(req.query.since) || 0, level: t(req.query.level),
      limit: Number(req.query.limit) || 0, withStatus: req.query.status !== '0',
    });
    res.json({ ok: true, local: true, ...snap });
  } catch (e) {
    res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
  }
});

/**
 * 지금 가져온다(pull). 닿지 못하면 **폴백 큐에 등록**하고 그 사실을 말한다.
 * ⚠ 실패를 '모름' 으로 뭉개지 않는다 — `kind` 를 그대로 화면에 넘긴다(조치가 전부 다르다).
 */
api.post('/tools/edge-log/fetch', adminOnly, fullScopeOnly, async (req, res) => {
  const agent = t(req.body?.agent);
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent 가 필요합니다.' });
  const opt = {
    since: Number(req.body?.since) || 0, level: t(req.body?.level),
    limit: Math.min(MAX_LOG_LIMIT, Math.max(0, Number(req.body?.limit) || 0)),
    withStatus: req.body?.withStatus !== false,
  };
  let r;
  try { r = await pullEdgeLog(agent, opt); }
  catch (e) { r = { ok: false, kind: 'error', reason: String(e?.message || e).slice(0, 300), ms: 0 }; }

  // 닿지 못한 경우에만 폴백 — 토큰 불일치·구버전은 큐에 넣어도 결과가 같다(엣지가 그 경로를 모른다).
  let queued = null;
  if (!r.ok && (r.kind === 'unreachable' || r.kind === 'timeout')) {
    const job = enqueueEdgeLogJob(agent, opt);
    queued = job ? { state: 'pending', at: job.at } : null;
  }
  logAudit({
    user: req.user?.username, action: 'edge-log.fetch', ip: req.ip || '',
    detail: JSON.stringify({ agent, ok: !!r.ok, kind: r.kind || null, queued: !!queued }).slice(0, 300),
  });
  res.json({
    ok: !!r.ok, kind: r.kind || null, reason: r.reason || null, ms: r.ms ?? null,
    queued, jobState: edgeLogJobState(agent),
    // ⚠ 실패했을 때 내주는 것은 **마지막으로 내용이 있던** 보관분이다(실패 기록 자체가 아니다).
    snap: r.ok ? r.snap : (lastDataEdgeLog(agent) || null), fresh: !!r.ok,
    minVersion: MIN_EDGE_VERSION,
  });
});

/** 보관분 조회(최신 + 이력). 엣지로 나가지 않는다. */
api.get('/tools/edge-log/:agent', adminOnly, fullScopeOnly, (req, res) => {
  const agent = t(req.params.agent);
  const hist = edgeLogHistory(agent);
  res.json({
    ok: true, agent, snap: lastDataEdgeLog(agent),
    // 마지막 시도가 실패였으면 그 사실을 따로 전한다(보관분을 '지금 값' 으로 읽지 않게).
    lastAttempt: hist.length ? (({ logs, status, ...rest }) => rest)(hist[hist.length - 1]) : null,
    // 이력은 목록만(본문 제외) — 한 응답에 로그 10벌을 실으면 수 MB 가 된다.
    history: hist.map((h) => ({ at: h.at, via: h.via, ok: h.ok, error: h.error, ms: h.ms, logCount: h.logs?.count ?? null, statusFailed: h.statusFailed })),
    job: edgeLogJobState(agent), store: storeInfo(),
    labels: { group: GROUP_LABEL, status: STATUS_LABEL }, minVersion: MIN_EDGE_VERSION,
  });
});

}
