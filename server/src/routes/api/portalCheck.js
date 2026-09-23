/**
 * routes/api/portalCheck.js — 특수기능 '포탈 점검 › 토큰 점검' API(v2.560).
 *
 * 사용자 요청(2026-09-18): "특수기능에 '포탈 점검' 메뉴를 만들고 첫번째 서브메뉴로 '토큰 점검' —
 * ① 등록된 모든 엣지/수집 서버의 모든 토큰을 수집해서 **중복**된 것이 있는지 ② 중앙에서 저장된
 * 토큰과 엣지에서 저장된 토큰을 사용해서 **통신이 되는지** ③ 중앙에 등록된 엣지의 토큰과 엣지에
 * 저장된 토큰이 **동일한지** ④ 점검하는 기능".
 *
 * ── 권한: adminOnly + fullScopeOnly ─────────────────────────────────────────
 * 응답에는 전 법인 엣지의 **주소·이름·토큰 지문·길이**가 들어간다. operator 는 `tools` 를 기본
 * 보유하므로 `requirePerm('tools')` 만으로는 부족하다(v2.500 D/M1 relaycheck · v2.549 엣지 로그 ·
 * v2.552 통신 점검과 **같은 기준**). 엣지는 vCenter 귀속이 아니라 범위 계정에 나눌 축이 없다 →
 * 403 (v2.525 규약).
 *
 * ── 이 라우트가 **하지 않는** 것(되돌리지 말 것) ──────────────────────────────
 * ① **평문 토큰을 응답에 싣지 않는다.** 나가는 것은 sha256 앞 8자 + 길이 + 앞뒤공백 플래그뿐이고
 *    전체 해시도 싣지 않는다(`util/tokenFingerprint.js` 규칙 2 — 전체 해시가 곧 중앙 저장값이고,
 *    사람이 정한 공유 토큰이면 오프라인 사전 공격이 성립한다).
 * ② **요청 본문의 url·token 을 받지 않는다.** 프로브의 접속처는 **등록부 저장값에서만** 읽는다
 *    (v2.480 규약 — 받으면 저장 토큰을 공격자 호스트로 실어 보내는 경로가 된다). 본문에서 읽는
 *    것은 **엣지 이름 필터**뿐이다.
 * ③ **배포 대상 토큰으로 엣지를 찔러보지 않는다**(사용자 선택 v2.560 '저장소 대조만'). 틀린 토큰
 *    시도는 그 엣지의 거부 링버퍼(20건 — `routes/collector.js denyRecent`)를 채워 **실제 침입
 *    흔적을 밀어낸다**. 그 축은 저장값끼리 대조한다.
 * ④ **폴링하지 않는다** — 화면은 마운트 1회 + 버튼(v2.508 V4 규약). 점검은 사람이 누를 때만 나간다.
 *
 * ⚠ `listTargetsRaw()`(평문 포함)를 쓰지만 **응답에 그 값이 실리지 않는다** — 지문·불리언으로
 *   환원한 뒤에만 밖으로 나간다(server/CLAUDE.md 의 '비밀 포함 내보내기는 소유자 전용' 규칙은
 *   *값을 내보내는* 경로에 대한 것이고, 여기는 값을 내보내지 않는다). 그 경계가 이 파일의 계약이다.
 */
import { fullScopeOnlyWith } from '../admin/shared.js';
import { requireRole } from '../../auth/auth.js';
import { store, SITE_STALE_MS } from '../../store.js';
import { config } from '../../config.js';
import { logAudit } from '../../audit.js';
import { loadCollectors } from '../../collector/registry.js';
import { allCollectorStatus } from '../../collector/state.js';
import { listAgentTokens } from '../../central/agentTokens.js';
import { listTargetsRaw } from '../../agent/deployRegistry.js';
import { listAgentConfigs } from '../../central/agentConfig.js';
import { knownAgentNames } from '../../central/knownAgents.js';   // v2.312 — 중앙이 아는 엣지 이름 합집합(코어는 하나다)
import { getCentralAuthStats } from '../central.js';     // 공유 토큰 사용 통계 · CENTRAL_REQUIRE_AGENT_TOKEN
import { scanTokens, mergeProbe, mergeEdgeReport, withRowStates, kpisOf, TOKEN_MODE, PROBE_STATE, EDGE_TOKEN_FACT, DUP_KIND, ROW_STATE } from '../../portalcheck/tokenScan.js';
import { findingsOf, findingCounts, groupFindings, FINDING, FINDING_GRADE } from '../../portalcheck/tokenFindings.js';
import {
  probeAll, putProbeResults, listProbeResults,
  PROBE_CONCURRENCY, PROBE_TIMEOUT_MS, PROBE_BUDGET_MS,
} from '../../portalcheck/tokenProbe.js';
import { pullTokenCheck, listEdgeTokenReports, MIN_EDGE_VERSION, STALE_MS } from '../../central/tokenCheckPull.js';
// v2.570 — 인벤토리 점검(두 번째 서브메뉴): 위임(site) vCenter 의 push 가 실제로 들어오는가.
import { listRegistry as listVcentersFull } from '../../vcenter/registry.js';
import { listInventory } from '../../central/inventory.js';
import { getIngestStats } from '../../central/ingestStats.js';
import { rejectStats } from '../../central/ingestReject.js';
import { agentIdentitySummary } from '../../central/agentIdentity.js';
import {
  scanInventory, findingsOf as invFindingsOf, groupFindings as invGroupFindings,
  findingCounts as invFindingCounts, INV_STATE, INV_FINDING, INV_GRADE,
} from '../../portalcheck/invScan.js';

// vc 별 위임 여부만 필요하다 — redact() 는 이미 password 를 뺀다(vcenter/registry.js:45).
// v2.575 IMP-11: store.js 의 값을 그대로 쓴다(두 벌이면 판정 기준이 조용히 갈린다).

const adminOnly = requireRole('admin');
// v2.583: 같은 6줄이 라우트 파일 8곳에 복사돼 있었다 — 공용 팩토리 하나로(사유 문구는 그대로).
const fullScopeOnly = fullScopeOnlyWith('토큰 점검 화면은 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다 — 전 법인 엣지의 주소와 토큰 지문이 들어갑니다.');

const t = (v) => String(v ?? '').trim();
const norm = (v) => t(v).toLowerCase();

/**
 * 재진입 가드 — 두 실행(프로브·엣지 인출)이 **가드를 공유**한다. 연타가 엣지에 대한 요청을
 * 곱하지 않게 한다(CLAUDE.md '수동 실행 API 도 가드를 공유할 것').
 */
let running = '';

/**
 * 중앙이 아는 엣지 이름의 합집합 + **그 이름을 어디서 봤는지**.
 * ⚠ 이것이 없으면 `collectors.json` 에 없는 사이트(공유 토큰만 쓰고 자기등록도 안 함)가 표에
 *   아예 나타나지 않아 화면이 '전부 정상' 이라는 거짓을 말한다.
 */
/*
 * ⚠ v2.583 감사 #29: 한 엣지의 키는 **수집 서버 id(= 에이전트 이름)** 하나다 — `tokenScan` 행·수집 상태 맵·
 *   개별 토큰·배포 대상이 전부 그 값을 쓴다. 예전에는 이 함수·`tokenLookup`·`tokenCheckPull` 이 **표시 이름**
 *   (`c.name`)을 썼고, id 와 이름이 다른 수집 서버(수동 등록)는 ① 표시 이름으로 '등록부 없음' 유령 행이 생기고
 *   ② 등록 행은 프로브 토큰을 못 찾아 '토큰 없음' 으로 **건너뛰고** ③ 엣지 보고가 다른 키에 저장돼 합쳐지지 않았다.
 *   표시 이름으로 들어온 이름은 id 로 **접는다**(aliasOf).
 */
function collectorAlias() {
  const m = new Map();
  for (const c of safe(() => loadCollectors(), [])) {
    const id = t(c.id || c.name);
    if (!id) continue;
    m.set(norm(id), id);
    if (c.name) m.set(norm(c.name), id);
  }
  return m;
}

function knownAgentSources() {
  const by = new Map(); // norm → { name, from: Set }
  const alias = collectorAlias();
  const add = (name0, from) => {
    const name = alias.get(norm(name0)) || name0;
    const k = norm(name);
    if (!k) return;
    if (!by.has(k)) by.set(k, { name: t(name), from: new Set() });
    by.get(k).from.add(from);
  };
  for (const c of safe(() => loadCollectors(), [])) add(c.id || c.name, 'registry');
  for (const a of safe(() => listAgentTokens(), [])) add(a.agent, 'agent-token');
  for (const d of safe(() => listTargetsRaw(), [])) add(d.agentName, 'deploy-target');
  for (const a of safe(() => listAgentConfigs(), [])) add(a.agent, 'config-push');
  for (const id of Object.keys(safe(() => allCollectorStatus(), {}))) add(id, 'pull-status');
  for (const r of safe(() => listEdgeTokenReports(), [])) add(r.agent, 'token-report');
  /*
   * ⚠ 마지막으로 **기존 공용 합집합**(`central/knownAgents.js`, v2.312)을 얹는다 — 인벤토리
   *   push·GPU 게스트 진단·위임 스캔 배정처럼 위에서 열거하지 않은 소스가 그 안에 있다. 여기서
   *   목록을 다시 쓰면 '그 소스로만 아는 엣지' 가 이 화면에서 통째로 사라진다(코어는 하나다).
   *   그 이름들의 출처는 세분할 수 없어 `other` 로 적는다 — 지어내지 않는다.
   */
  for (const nm of safe(() => knownAgentNames(), [])) add(nm, 'other');
  return [...by.values()].map((x) => ({ name: x.name, from: [...x.from] }));
}

function safe(fn, dflt) { try { const v = fn(); return v ?? dflt; } catch { return dflt; } }

/** 등록부 + 설정 + 배포 대상을 읽어 로컬 판정(왕복 0)까지 한다. */
function localScan() {
  const collectors = safe(() => loadCollectors(), []);
  const status = safe(() => allCollectorStatus(), {});
  const known = knownAgentSources();
  const scan = scanTokens({
    collectors,
    sharedCentralToken: config.central.token,
    sharedCollectorToken: config.collector.token,
    agentTokens: safe(() => listAgentTokens(), []),
    deployTargets: safe(() => listTargetsRaw(), []),
    knownAgents: known.map((k) => k.name),
    status,
    minEdgeVersion: MIN_EDGE_VERSION,
  });
  // 이름의 출처를 행에 붙인다(화면이 '등록부 없음' 행의 근거를 말할 수 있게).
  const fromBy = new Map(known.map((k) => [norm(k.name), k.from]));
  scan.rows = scan.rows.map((r) => ({ ...r, nameFrom: fromBy.get(norm(r.agent)) || [] }));
  return scan;
}

/**
 * 프로브·엣지 보고를 얹은 완성 스냅샷.
 * ⚠ `withRowStates` 로 **행 상태를 서버가 붙인다** — 화면이 같은 판정을 다시 쓰면 KPI 개수와
 *   표의 색이 어긋난다(CLAUDE.md '코어는 하나다').
 */
function fullScan() {
  const merged = withRowStates(mergeEdgeReport(mergeProbe(localScan(), listProbeResults()), listEdgeTokenReports()));
  const findings = findingsOf(merged);
  return {
    ...merged,
    kpis: kpisOf(merged),
    findings,
    // ⚠ 화면은 **묶은 것**을 그린다 — 같은 문장이 28줄 반복되면 화면을 덮는다(v2.509 규약).
    //   원본 `findings` 도 함께 내려 개수·대상을 잃지 않는다.
    findingGroups: groupFindings(findings),
    findingCounts: findingCounts(findings),
  };
}

/** 등록부에서 이 행의 수집 토큰 평문을 꺼낸다 — **응답에는 절대 나가지 않는다**(프로브 헤더 전용). */
function tokenLookup() {
  const by = new Map();
  for (const c of safe(() => loadCollectors(), [])) {
    if (c.enabled === false) continue;
    const tok = String(c.token ?? '');
    const k = norm(c.id || c.name); // #29: 행 키(id)와 같은 값
    if (k) by.set(k, tok);
    if (c.name && !by.has(norm(c.name))) by.set(norm(c.name), tok); // 표시 이름으로 들어온 행도 찾는다
  }
  return (row) => by.get(norm(row?.agent)) || '';
}

export function registerPortalCheck(api) {

/**
 * 메인 — 로컬 판정 + 보관된 프로브·엣지 보고. **왕복 0**(화면 진입이 네트워크를 쓰지 않는다).
 */
api.get('/tools/portal-check/tokens', adminOnly, fullScopeOnly, (_req, res) => {
  const scan = fullScan();
  res.json({
    ok: true,
    ...scan,
    vocab: {
      probeStates: PROBE_STATE, tokenModes: TOKEN_MODE, edgeFacts: EDGE_TOKEN_FACT,
      dupKinds: DUP_KIND, rowStates: ROW_STATE, findings: FINDING, findingGrades: FINDING_GRADE,
    },
    /*
     * 공유 토큰 강화 모드(`CENTRAL_REQUIRE_AGENT_TOKEN=true`)가 켜져 있으면 '수집 토큰 ==
     * 공유 중앙 토큰' 의 실제 위험이 낮아진다(그 값으로는 중앙 엔드포인트가 열리지 않는다) —
     * 화면 문구가 그 사실을 반영한다. **위험을 0 이라 말하지는 않는다**(설정이 꺼지면 되살아난다).
     */
    centralAuth: safe(() => getCentralAuthStats(), null),
    limits: {
      minEdgeVersion: MIN_EDGE_VERSION,
      staleMs: STALE_MS,
      concurrency: PROBE_CONCURRENCY,
      timeoutMs: PROBE_TIMEOUT_MS,
      budgetMs: PROBE_BUDGET_MS,
    },
    running: running || '',
  });
});

/**
 * ② 통신 + ③ 동일성(수집 토큰 축) — **중앙이 저장한 수집 토큰으로** 각 엣지의 `/ping` 을 두드린다.
 *
 * ⚠ 200 이면 엣지 게이트가 전체 문자열을 상수시간 비교하므로(`util/secureCompare.js tokenMatches`)
 *   **중앙 저장값 == 엣지 저장값이 증명**된다(지문 8자 대조와 달리 확정이다).
 * ⚠ 본문에서 읽는 것은 `agent`(이름 필터)뿐이다 — url·token 을 받지 않는다.
 */
api.post('/tools/portal-check/tokens/probe', adminOnly, fullScopeOnly, async (req, res) => {
  if (running) return res.status(409).json({ ok: false, reason: `이미 점검이 진행 중입니다(${running}).` });
  const only = norm(req.body?.agent);
  const scan = localScan();
  const rows = only ? scan.rows.filter((r) => norm(r.agent) === only) : scan.rows;
  if (!rows.length) return res.status(400).json({ ok: false, reason: only ? `그 이름의 엣지가 없습니다: ${req.body?.agent}` : '점검할 엣지가 없습니다(설정 › 수집 서버에서 등록하세요).' });
  running = 'probe';
  try {
    const out = await probeAll(rows, { tokenOf: tokenLookup() });
    putProbeResults(out.probes);
    logAudit({ user: req.user?.username || '', action: '토큰 점검 — 중앙→엣지 프로브', target: only || `전체 ${rows.length}곳`, ip: req.ip || '' });
    const scanned = fullScan();
    res.json({
      ok: true, probed: rows.length, ms: out.ms,
      // ⚠ 예산에 걸려 시도하지 못한 개수를 **밝힌다**(조용한 상한 금지 — 다시 누르면 이어진다).
      budgetExceeded: out.budgetExceeded,
      ...scanned,
    });
  } catch (err) {
    res.status(500).json({ ok: false, reason: String(err?.message || err).slice(0, 300) });
  } finally { running = ''; }
});

/**
 * ③ 동일성(중앙 토큰 축) — 엣지의 **자기보고**를 당긴다.
 *
 * 중앙은 개별 엣지 토큰의 **해시만** 갖고 있어(`central/agentTokens.js:72`) 값으로는 답할 수 없다.
 * 엣지가 자기 토큰으로 중앙 `/api/central/health-probe` 를 두드려 받은 `yourAgent` 가 그 답이다.
 * ⚠ **정직 기록**: 중앙의 **수집** 토큰이 틀리면 이 인출도 같은 토큰으로 나가므로 함께 거부된다 —
 *   그때는 '엣지 저장값이 무엇인지' 를 알 길이 없다. 화면이 그 사실과 다음 단서(배포 대상 대조·
 *   그 엣지 호스트 직접 확인)를 말한다.
 */
api.post('/tools/portal-check/tokens/edge-pull', adminOnly, fullScopeOnly, async (req, res) => {
  if (running) return res.status(409).json({ ok: false, reason: `이미 점검이 진행 중입니다(${running}).` });
  const only = norm(req.body?.agent);
  const selfProbe = req.body?.selfProbe !== false;
  const scan = localScan();
  const rows = (only ? scan.rows.filter((r) => norm(r.agent) === only) : scan.rows).filter((r) => r.registered && t(r.url));
  if (!rows.length) {
    return res.status(400).json({ ok: false, reason: only ? `그 이름의 엣지가 등록부에 없거나 URL 이 없습니다: ${req.body?.agent}` : '인출할 엣지가 없습니다 — 등록부에 URL 이 있는 항목이 없습니다.' });
  }
  running = 'edge-pull';
  const t0 = Date.now();
  try {
    const results = [];
    // 순차가 아니라 동시성 제한 — 28곳 × 고RTT 를 감당하되 엣지 하나에 몰리지 않게.
    let i = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(PROBE_CONCURRENCY, rows.length)) }, async () => {
      for (;;) {
        const k = i++;
        if (k >= rows.length) return;
        const r = rows[k];
        try { results.push({ agent: r.agent, ...(await pullTokenCheck(r.agent, { selfProbe })) }); }
        catch (e) { results.push({ agent: r.agent, ok: false, kind: 'error', reason: String(e?.message || e).slice(0, 300) }); }
      }
    });
    await Promise.all(workers);
    logAudit({ user: req.user?.username || '', action: '토큰 점검 — 엣지 자기보고 인출', target: only || `전체 ${rows.length}곳`, ip: req.ip || '' });
    const scanned = fullScan();
    res.json({
      ok: true, pulled: rows.length, ms: Date.now() - t0,
      failed: results.filter((x) => !x.ok).length,
      results: results.map((x) => ({ agent: x.agent, ok: !!x.ok, kind: x.kind || '', reason: x.reason || '', ms: x.ms || 0 })),
      ...scanned,
    });
  } catch (err) {
    res.status(500).json({ ok: false, reason: String(err?.message || err).slice(0, 300) });
  } finally { running = ''; }
});

/**
 * 두 번째 서브메뉴 — 인벤토리 점검(v2.570).
 *
 * 사용자 요청: 에이전트 수신 트래픽 진단의 '최근 페이로드 —' 를 보고 "여기서 수집되는 데이터가
 * 없으면 어떤 문제가 발생하는지 확인하고 오류를 점검하려면 어떻게 해야 하는지" → 점검 기능.
 *
 * **왕복 0** — 이미 중앙이 가진 값(위임 vCenter 인벤토리 캐시·수신 통계·거부 기록·엣지 정체)만
 * 조합한다. 토큰 점검과 달리 엣지에 나가는 프로브가 없다 — 그래서 재진입 가드(`running`)를
 * 공유하지 않는다(공유할 왕복이 없다).
 */
api.get('/tools/portal-check/inventory', adminOnly, fullScopeOnly, (_req, res) => {
  const scan = scanInventory({
    vcenters: safe(() => listVcentersFull(), []),
    inventory: safe(() => listInventory(), []),
    ingestRows: safe(() => getIngestStats().rows, []),
    rejects: safe(() => rejectStats(), null),
    identity: safe(() => agentIdentitySummary(), null),
    now: Date.now(),
    staleMs: SITE_STALE_MS,
  });
  const findings = invFindingsOf(scan);
  res.json({
    ok: true,
    ...scan,
    findings,
    findingGroups: invGroupFindings(findings),
    findingCounts: invFindingCounts(findings),
    vocab: { states: INV_STATE, findings: INV_FINDING, grades: INV_GRADE },
  });
});

}
