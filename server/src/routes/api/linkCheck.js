/**
 * routes/api/linkCheck.js — 특수기능 '통신 점검' 화면 API(v2.552).
 *
 * 사용자 요청(2026-09-18): "main 포탈과 edge 포탈의 모든 통신이 정상인지 측정하는 프로그램을
 * 특수기능에 만들어줘, 현재 포탈에서 설정된 엣지와 vcenter 와 수집 서버가 통신하는 것을 파악해서
 * 점검하고 점검하는 **로그를 최대한 많이 기록**해서 이슈가 있을때 분석하는 자료로 사용하고 싶어".
 *
 * ── 권한: adminOnly + fullScopeOnly ─────────────────────────────────────────
 * 응답에는 **엣지 URL·vCenter 호스트·내부 IP·인증서 주체·응답 본문 조각**이 그대로 들어간다.
 * operator 는 `tools` 를 기본 보유하므로 `requirePerm('tools')` 만으로는 전 법인의 내부 주소가
 * 열린다 — v2.500 D/M1(relaycheck) · v2.549(엣지 로그)와 **같은 기준**이다.
 * 링크는 vCenter 귀속이 아니라(엣지·중앙 축이다) 범위 계정에 나눌 축이 없다 → 403(v2.525 규약).
 *
 * ── 이 라우트가 하지 않는 것 ────────────────────────────────────────────────
 *  · **폴링하지 않는다**(화면은 마운트 1회 + 버튼). 점검 자체는 폴러가 주기로 돈다.
 *  · **vCenter·엣지에 로그인하지 않는다**(`linkcheck/run.js` 머리말 — 점검이 계정을 잠그지 않게).
 */
import { requireRole } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { publicLink, LINK_KINDS, KIND_KEYS, EDGE_KINDS } from '../../linkcheck/links.js';
import { PHASES, PHASE_LABEL, FAIL_KINDS } from '../../linkcheck/phases.js';
import { loadLinkCheckSettings, saveLinkCheckSettings, linkCheckEnabled, DEFAULTS } from '../../linkcheck/settings.js';
import { centralLinks, pollOnce, linkCheckPollerStatus } from '../../linkcheck/poller.js';
import { latestAll, samplesOf, eventsOf, eventDetail, dailyOf, dbStatus } from '../../linkcheck/db.js';
import { allEdgeLinkReports, REPORT_STALE_MS } from '../../central/linkCheckEdge.js';
import { allCollectorStatus } from '../../collector/state.js';
import { linkCheckWorkerStatus } from '../../agent/linkCheckWorker.js';
// v2.553 — 설정 전수 점검(25종) + 해결책
import { buildSettingsTargets, publicTarget } from '../../linkcheck/settingsLinks.js';
import { SETTING_KINDS, SETTING_KIND_KEYS, DEPTH_LABEL, GROUP_ORDER, SETTINGS_PATHS } from '../../linkcheck/settingsKinds.js';
import { configFindings, resultFindings, mergeFindings, hostCountsOf, HOST_FORM, CERT_WARN_DAYS } from '../../linkcheck/remedy.js';
import { ipBlockReason } from '../../collector/registry.js';

const adminOnly = requireRole('admin');
const fullScopeOnly = (req, res, next) => {
  if (scopedVcenterIds(req.user, store.get())) {
    return res.status(403).json({ ok: false, reason: '통신 점검 화면은 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다 — 링크에는 전 법인의 엣지 주소·내부 IP 가 들어갑니다.' });
  }
  next();
};

const t = (v) => String(v ?? '').trim();
const num = (v, dflt) => { const n = Number(v); return Number.isFinite(n) ? n : dflt; };

export function registerLinkCheck(api) {

/**
 * 메인 — 링크 목록 + 최신 상태 + 엣지 보고 + 폴러 상태.
 *
 * ⚠⚠ **'상태 행이 없다' 를 '정상' 으로도 '장애' 로도 세지 않는다.** 엣지가 재는 링크는 그 엣지가
 *   v2.552 로 올라가기 전까지 비어 있다 — `state:'no-data'` 로 밝히고 이유 후보를 함께 준다
 *   (엣지 보고 없음 / 구버전 / 점검 꺼짐). 빈 칸을 초록으로 칠하면 이 기능 최악의 거짓이다.
 */
api.get('/tools/link-check', adminOnly, fullScopeOnly, async (_req, res) => {
  const s = loadLinkCheckSettings();
  const { all, counts, problems, collectors } = centralLinks();
  const latest = await latestAll();
  const byId = new Map(latest.map((r) => [r.link_id, r]));
  const reports = allEdgeLinkReports();
  /*
   * 엣지 버전 — `allCollectorStatus()` 는 **수집 서버 id** 로 키가 잡히고 값에는 엣지가 스스로
   * 보고한 `agent` 가 들어 있다. 링크의 `from` 은 등록부의 **이름**이므로 **둘 다** 키로 넣는다.
   * ⚠ 한쪽만 넣으면 이름과 id 가 다른 법인에서 버전이 '미상' 이 되어, 화면이 '구버전' 대신
   *   '버전 미상' 이라 말한다(v2.548 H5 와 같은 유형 — 원인을 흐린다).
   */
  const colStatus = allCollectorStatus();
  const versions = {};
  for (const [id, st] of Object.entries(colStatus || {})) {
    const ver = t(st?.version);
    if (!ver) continue;
    if (t(id)) versions[t(id).toLowerCase()] = ver;
    if (t(st?.agent)) versions[t(st.agent).toLowerCase()] = ver;
  }

  const rows = all.map((l) => {
    const r = byId.get(l.id) || null;
    const rep = l.by === 'edge' ? (reports[l.from] || null) : null;
    return {
      ...publicLink(l),
      latest: r ? {
        ts: r.ts, ok: !!r.ok, phase: r.phase, failKind: r.fail_kind, reached: r.reached,
        totalMs: r.total_ms, dnsMs: r.dns_ms, tcpMs: r.tcp_ms, tlsMs: r.tls_ms, httpMs: r.http_ms,
        status: r.status, certDaysLeft: r.cert_days, byNode: r.by_node,
        summary: r.summary, sinceTs: r.since_ts, streak: r.streak,
      } : null,
      // 엣지 측정분의 '왜 비었나' 재료 — 화면이 문구를 만든다(서버가 문구를 만들지 않는다).
      ...(l.by === 'edge' ? {
        edgeReport: rep ? {
          at: rep.at, stale: rep.stale, ageMs: rep.ageMs, version: rep.version,
          rejected: rep.rejected, omitted: rep.omitted,
          // v2.554 — 엣지가 밝힌 '왜 0건인가'. 없으면 구버전 엣지다(그 사실도 화면이 말한다).
          note: rep.note || '', disabledOnCentral: !!rep.disabledOnCentral, links: rep.links ?? null,
        } : null,
        edgeVersion: versions[t(l.from).toLowerCase()] || '',
      } : {}),
    };
  });

  res.json({
    ok: true,
    enabled: linkCheckEnabled(),
    settings: {
      /*
       * ⚠⚠ **`enabled` 를 빼먹으면 안 된다**(v2.552 스크린샷 판독에서 잡은 결함): 화면의 설정 폼은
       *   이 객체로 초기화되므로 빠지면 체크박스가 **항상 꺼짐**으로 열리고, 사용자가 다른 값만
       *   고쳐 저장하는 순간 **점검이 조용히 꺼진다**. 수치로는 안 잡히는 종류다.
       */
      enabled: s.enabled,
      intervalMs: s.intervalMs, concurrency: s.concurrency, kinds: s.kinds, pairs: s.pairs,
      dnsTimeoutMs: s.dnsTimeoutMs, tcpTimeoutMs: s.tcpTimeoutMs, tlsTimeoutMs: s.tlsTimeoutMs, httpTimeoutMs: s.httpTimeoutMs,
      sampleRetentionDays: s.sampleRetentionDays, eventRetentionDays: s.eventRetentionDays, dailyRetentionDays: s.dailyRetentionDays,
    },
    links: rows, counts, problems,
    /*
     * ⚠⚠ **'언제부터 점검이 돌고 있나'**(v2.554). 이 값이 없으면 화면이 엣지 미보고를 영원히
     *   '첫 보고 대기'(= 기다리면 된다)라고 말한다 — 사용자 실화면에서 10분·3회가 지나도 그
     *   문구가 그대로였다. 중앙 측정분의 **가장 오래된 상태 시작 시각**을 프록시로 쓴다
     *   (중앙 폴러가 처음 돈 시점 이후로는 줄지 않는다). 없으면 null 이고 화면은 escalate 하지 않는다.
     */
    runningSinceTs: (() => {
      const xs = rows.map((r) => Number(r.latest?.sinceTs)).filter((v) => Number.isFinite(v) && v > 0);
      return xs.length ? Math.min(...xs) : null;
    })(),
    kinds: LINK_KINDS, kindKeys: KIND_KEYS, edgeKinds: EDGE_KINDS,
    phases: PHASES, phaseLabel: PHASE_LABEL, failKinds: FAIL_KINDS,
    poller: linkCheckPollerStatus(),
    worker: linkCheckWorkerStatus(),      // 이 포탈이 엣지면 자기 워커 상태(중앙에서는 비어 있다)
    edgeReports: reports, reportStaleMs: REPORT_STALE_MS,
    db: await dbStatus(),
    /*
     * ⚠ 엣지 목록은 **등록부 이름**이다. v2.552 초판은 `versions`(엣지가 보고한 버전 맵)의 키를
     *   썼는데, 한 번도 export 를 주지 않은 법인은 그 맵에 없어 화면이 **"엣지 0곳"** 이라고
     *   말했다(등록은 4곳인데). 짝 설정 안내의 산수가 거짓이 된다 — 스크린샷 판독으로 발견.
     */
    agents: collectors.map((c) => String(c.name || c.id || '')).filter(Boolean),
    at: Date.now(),
  });
});

/** 한 링크의 추이(요약 표본). 폴링용이 아니다 — 상세를 열 때 1회. */
api.get('/tools/link-check/samples', adminOnly, fullScopeOnly, async (req, res) => {
  const linkId = t(req.query.linkId);
  if (!linkId) return res.status(400).json({ ok: false, reason: 'linkId 가 필요합니다.' });
  const out = await samplesOf(linkId, { hours: Math.min(24 * 30, Math.max(1, num(req.query.hours, 24))) });
  res.json({ ok: true, linkId, ...out, at: Date.now() });
});

/**
 * 로그 뷰어 — **이 기능의 본체**. 실패·상태변화만 상세가 있으므로(3단 구조) 목록은 가볍다.
 * ⚠ `detail` 은 목록에 싣지 않는다(8KB × 300건). 크기만 `detail_bytes` 로 알려준다.
 */
api.get('/tools/link-check/events', adminOnly, fullScopeOnly, async (req, res) => {
  const out = await eventsOf({
    linkId: t(req.query.linkId),
    hours: Math.min(24 * 90, Math.max(1, num(req.query.hours, 24 * 7))),
    failKind: t(req.query.failKind),
    event: t(req.query.event),
    limit: Math.min(1_000, Math.max(1, num(req.query.limit, 300))),
  });
  res.json({ ok: true, ...out, at: Date.now() });
});

/** 상세 1건(원문 JSON). 잘렸으면 `truncated` 가 1 이다 — 화면이 밝힌다. */
api.get('/tools/link-check/event/:id', adminOnly, fullScopeOnly, async (req, res) => {
  const row = await eventDetail(req.params.id);
  if (!row) return res.status(404).json({ ok: false, reason: '그 기록이 없습니다(보존 기간이 지나 정리됐을 수 있습니다).' });
  let detail = null;
  try { detail = JSON.parse(row.detail || 'null'); } catch { detail = null; }
  res.json({
    ok: true,
    row: { ...row, detail: undefined },
    detail,
    // ⚠ 파싱 실패를 조용히 null 로 넘기지 않는다 — 잘린 JSON 이면 원문을 그대로 보여준다.
    detailRaw: detail == null ? String(row.detail || '').slice(0, 20_000) : '',
  });
});

/** 일 롤업(장기 추이·가용률). */
api.get('/tools/link-check/daily', adminOnly, fullScopeOnly, async (req, res) => {
  const rows = await dailyOf({ linkId: t(req.query.linkId), days: Math.min(365 * 5, Math.max(1, num(req.query.days, 90))) });
  res.json({ ok: true, rows, at: Date.now() });
});

/**
 * '지금 점검'. **폴러와 같은 재진입 가드**를 쓴다(연타가 점검 세션을 곱하지 않게).
 * ⚠ 중앙이 재는 링크만 즉시 돌아간다 — 엣지 측정분은 **그 엣지의 다음 주기**에 온다.
 *   응답이 그 사실을 나눠 말한다(뭉치면 '전부 지금 점검했다' 는 거짓이 된다).
 */
api.post('/tools/link-check/run', adminOnly, fullScopeOnly, async (req, res) => {
  if (!linkCheckEnabled()) return res.status(400).json({ ok: false, reason: '통신 점검이 꺼져 있습니다 — 설정에서 먼저 켜세요.' });
  const { mine, all } = centralLinks();
  const edgeSide = all.filter((l) => l.by === 'edge' && l.enabled !== false).length;
  const out = await pollOnce({ trigger: 'manual' });
  logAudit({
    user: req.user?.username, action: 'link-check.run', ip: req.ip || '',
    detail: JSON.stringify({ central: mine.length, edge: edgeSide, ...out }).slice(0, 300),
  });
  res.json({
    ok: out.ok !== false, ...out,
    centralNow: mine.length, edgePending: edgeSide,
    note: edgeSide ? '엣지가 재는 링크는 그 엣지의 다음 주기에 갱신됩니다(중앙이 엣지에 점검을 밀어넣지 않습니다).' : '',
  });
});

api.get('/tools/link-check/settings', adminOnly, fullScopeOnly, (_req, res) => {
  res.json({ ok: true, settings: loadLinkCheckSettings(), defaults: DEFAULTS, kinds: LINK_KINDS });
});

/**
 * **설정 전수 점검 목록 + 해결책**(v2.553 — 사용자 요청 "설정에 있는 모든 통신이 되는지 점검하고
 * 해결책 제시하는 기능").
 *
 * ⚠ 이 응답은 **네트워크로 나가지 않는다** — 등록부를 읽어 목록·설정 발견(맞춤 진단)을 만들고,
 *   측정값은 DB 의 최신 1건을 붙인다. 점검을 켜지 않아도 '설정 문제' 는 즉시 보인다.
 * ⚠ **측정값이 없는 것을 '정상' 으로 칠하지 않는다**(v2.552 규약) — 화면이 `latest === null` 을
 *   '측정 없음' 으로 다룬다.
 */
api.get('/tools/link-check/targets', adminOnly, fullScopeOnly, async (_req, res) => {
  const built = await buildSettingsTargets();
  const latest = await latestAll();
  const byId = new Map(latest.map((r) => [r.link_id, r]));
  const hostCounts = hostCountsOf(built.targets);
  const s = loadLinkCheckSettings();

  const rows = built.targets.map((x) => {
    const r = byId.get(x.id) || null;
    /*
     * 최신 행에는 단계 객체가 없다(요약 표본이다 — v2.552 3단 구조). 결과 기반 발견이 필요한
     * 것만 **행이 실제로 가진 열**로 되돌린다. 없는 값을 지어내지 않는다.
     */
    const pseudoSteps = r ? {
      ...(r.cert_days != null ? { tls: { certDaysLeft: r.cert_days } } : {}),
      ...(r.status != null ? { http: { status: r.status } } : {}),
      ...(r.phase ? { [r.phase]: { ok: !!r.ok, error: '' } } : {}),
    } : {};
    const findings = mergeFindings(
      configFindings(x, { hostCounts, ipBlockReason }),
      r ? resultFindings(x, { ok: !!r.ok, phase: r.phase, failKind: r.fail_kind, reached: r.reached }, pseudoSteps) : [],
    );
    return {
      ...publicTarget(x),
      ...(x.bad ? { bad: x.bad } : {}),
      latest: r ? {
        ts: r.ts, ok: !!r.ok, phase: r.phase, failKind: r.fail_kind, reached: r.reached,
        totalMs: r.total_ms, status: r.status, certDaysLeft: r.cert_days,
        summary: r.summary, sinceTs: r.since_ts, streak: r.streak, byNode: r.by_node,
      } : null,
      findings,
    };
  });

  res.json({
    ok: true,
    enabled: linkCheckEnabled(),
    settingsCheck: s.settingsCheck !== false,
    intervalMs: s.intervalMs,
    targets: rows,
    counts: built.counts,
    problems: built.problems,
    // ⚠ 등록부 하나가 못 읽히면 그 종류가 **통째로 빠진다** — 조용히 0건으로 두지 않는다.
    sourceErrors: built.sourceErrors,
    kinds: SETTING_KINDS, kindKeys: SETTING_KIND_KEYS,
    depthLabel: DEPTH_LABEL, groupOrder: GROUP_ORDER, settingsPaths: SETTINGS_PATHS,
    hostForm: HOST_FORM, certWarnDays: CERT_WARN_DAYS,
    poller: linkCheckPollerStatus(),
    at: Date.now(),
  });
});

api.put('/tools/link-check/settings', adminOnly, fullScopeOnly, (req, res) => {
  const next = saveLinkCheckSettings(req.body || {});
  logAudit({
    user: req.user?.username, action: 'link-check.settings', ip: req.ip || '',
    detail: JSON.stringify({
      enabled: next.enabled, intervalMs: next.intervalMs, concurrency: next.concurrency,
      pairs: next.pairs.length, kindsOff: Object.keys(next.kinds),
    }).slice(0, 300),
  });
  res.json({ ok: true, settings: next });
});

}
