/**
 * routes/api/bmUsage.js — 특수기능 '베어메탈 사용률' 화면 API(v2.550).
 *
 * 사용자 요청(2026-09-17): "여기에 분류된 서버들만 CPU memory disk Network HBA 사용율을 수집하고 싶어"
 * (서버 분석 › 구분 › **Baremetal(미가상화 물리)**).
 *
 * ── 권한: `tools` + **vCenter scope** ───────────────────────────────────────
 * 베어메탈은 `vcenterId`(법인) 축이 **있다** — 그래서 스토리지·Horizon 처럼 403 으로 거절하지 않고
 * 범위 계정에는 그 법인 것만 준다(CLAUDE.md '조회 라우트 scope 는 예외 없이').
 * ⚠ **법인 귀속이 없는 베어메탈은 범위 계정에 노출하지 않는다**('귀속 없는 데이터 미노출' 불변조건).
 *
 * ⚠ **자격증명을 응답에 싣지 않는다** — `targets.publicTarget()` 을 통과한 것만 내보낸다
 *   (`server/CLAUDE.md`: "비밀 값은 어떤 API 응답에도 싣지 않는다").
 * ⚠ **폴링 금지** — '지금 수집' 은 SSH·Redfish 왕복이다. 화면은 마운트 1회 + 버튼(v2.508 규약).
 */
import { isMockMode } from '../../mock/demo/flags.js'; // v2.708 데모 표시
import { requireRole, requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds, inUserWriteScope, isFullReadWriteScope } from '../../auth/scope.js';
import { mergeScopedMap, keepScopedFields, ignoredGlobalFields } from '../../auth/scopeMerge.js'; // v2.605 AUTHZ2605-01 · v2.607 AUTHZ2607-05
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { loadBmUsageSettings, saveBmUsageSettings, bmUsageEnabled, DEFAULTS, enterpriseActive, dropUnspecifiedNumbers, bmUsageCentralState, distributionStatus, saveDistribution } from '../../bmusage/settings.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { knownAgentNames } from '../../central/knownAgents.js';
import { unassignedCauses, CAUSE as UNASSIGNED_CAUSE } from '../../bmusage/attribution.js';
import { TIER_LABEL } from '../../bmusage/license.js';
import { publicTarget, maskTargetAddress, maskBmIdentity, NO_PATH_REASON } from '../../bmusage/targets.js';
import { maskActivityEvents, maskPollerStatus, scrubHosts, addressMatcher, resolveMaskedToken, isAdminReq, scrubberFor, maskedIdToken } from '../../auth/addressMask.js';
import { currentTargets, pollBmUsageOnce, bmUsageStatus, authStopsFor, sourceErrorsView, usageDetailFor } from '../../bmusage/poller.js';
import { isDemoGuest } from '../../auth/demoGuest.js'; // v2.720(감사 R1-03)
import { latestUsage, usageHistory, usageDaily, dbStatus, METRICS } from '../../bmusage/db.js';
import { bmUsageEvents, bmUsageLogInfo } from '../../bmusage/activityLog.js';
import { scopeFilePaths } from '../../auth/scopeStatus.js';   // v2.598 AUTHZ-2598-04: log.file 절대 경로는 admin 만
import { config } from '../../config.js';
import { strOf } from '../../util/coercionTrap.js';
import { fleetPartialsSummary } from '../../central/fleet.js'; // v2.607 LEFT2607-02
import { poolSettled } from '../../util/pool.js'; // v2.613 RUNTIME2613-03(a)
import { reqTimeoutMs } from '../../agent/envTimeout.js';
import { memoJson, scopeKey } from './shared.js'; // v2.919: 서버 1대 성능 상세(응답 캐시 + 범위 서명)
import { perfForRows, stripJsonCols } from '../../bmusage/edgePull.js'; // v2.919: 판정이 붙은 성능 항목(엣지 봉투와 같은 함수)
import { buildPerfEntry, PERF_COL_META, compactPerfEntry } from '../../bmusage/perfView.js';
import { hwFactsReader } from '../../bmusage/hwFacts.js';
import { freshMsFor } from '../../bmusage/useJudge.js';
import { PERF_DEFAULTS } from '../../bmusage/settings.js';

const toolsPerm = requirePerm('tools');
const writeRole = requireRole('admin', 'operator');
const adminOnly = requireRole('admin');
// v2.627: 엣지 배포는 28곳 전부의 수집 범위를 바꾼다 — 전 법인 공용 결정이라 전체 범위 관리자만.
const fleetOnly = fullScopeOnlyWith('베어메탈 사용률 설정의 엣지 배포는 전체 범위(vCenter 제한 없는) 관리자만 바꿀 수 있습니다 — 모든 엣지의 수집 범위를 한 번에 정합니다.');

// v2.604(감사 CEN2604-03 2중 방어): 엣지 보관분 값이 객체면 String() 이 던져 이 라우트가 500 이었다 — 글자·수·불리언만.
const t = (v) => strOf(v, 4096).trim();

/** 범위 계정용 절단(순수) — 허용 vCenter 것만, 귀속 없는 것은 숨긴다. */
export function applyScope(list = [], allowed = null, field = 'vcenterId') {
  if (!allowed) return list;
  const ok = new Set(allowed);
  return list.filter((x) => t(x[field]) && ok.has(t(x[field])));
}

/**
 * 엣지 설정 사본에서 **법인 축**을 뺀다(v2.574 SEC-03).
 * ⚠ `corps` 는 '수집을 켠 법인 목록' 이라 범위 제한 계정에 주면 조직 구성이 그대로 드러난다.
 *   나머지 필드(주기·경로 on/off)는 그 엣지의 동작 설명이라 남긴다 — 화면이 '왜 값이 없나' 를
 *   말하려면 필요하다(`enterpriseActive` 등). 통째로 null 로 만들면 그 진단이 사라진다.
 * ⚠ 뺀 사실을 **숨기지 않는다** — `corpsHidden: true` 로 밝힌다(조용한 축약 금지).
 */
export function scopeEdgeSettings(settings, allowed) {
  if (!settings || typeof settings !== 'object') return null;
  if (!allowed) return settings;
  const { corps, ...rest } = settings;
  // v2.583: corps 는 배열이 아니라 `{ [vcenterId]: true }` 맵이다 — 예전 `Array.isArray` 판정은 늘 null 을 줬다.
  const n = Array.isArray(corps) ? corps.length : (corps && typeof corps === 'object' ? Object.keys(corps).length : null);
  return { ...rest, corps: null, corpsHidden: true, corpsCount: n };
}

/**
 * 주 조회의 설정·상태를 범위·역할에 맞게 깎는다(v2.583 — 감사 확정. SEC-03 이 /edges 만 고친 형제 누락).
 *  · 범위 계정: `corps`(수집을 켠 법인 목록 — 그 자체가 조직 구성)를 **자기 범위 것만** 남기고 그 사실을 밝힌다.
 *  · 관리자가 아니면: 대체 경로 동의자 계정명(`enterpriseAckBy`)을 뺀다(설정·상태 양쪽).
 */
export function scopeMainSettings(settings, allowed, isAdmin) {
  if (!settings || typeof settings !== 'object') return settings;
  let out = settings;
  if (allowed && settings.corps && typeof settings.corps === 'object') {
    out = { ...out, corps: Object.fromEntries(Object.entries(settings.corps).filter(([id]) => allowed.has(id))), corpsScoped: true };
  }
  if (!isAdmin && 'enterpriseAckBy' in out) { const { enterpriseAckBy: _a, ...rest } = out; void _a; out = { ...rest, enterpriseAckByHidden: true }; }
  return out;
}
/**
 * v2.629(A6-05): 폴러 상태는 **전 함대 집계**다(last.servers·okCount·failCount·inserted·ent·alerts·sourceErrors ·
 *   authStopCount · entDeferred · prevKeys · alertState). v2.550.3 은 last.counts 만 뺐고, 응답은 isAdmin 이면 원본을 그대로 실어
 *   범위 관리자(그리고 범위 operator 도 — 가림은 주소만 한다)에게 다른 법인 대수·실패 수가 나갔다. 범위 계정에는 개수를 null 로
 *   두고 `fleetCountsHidden` 으로 밝힌다(설정값·주기·예산·실행 여부는 전 법인 공통이라 그대로). 전체 범위면 원본. 순수.
 */
export const FULL_SCOPE_TEXT = '(원문은 전체 범위 계정만 볼 수 있습니다)';
export function scopeBmStatus(st, allowed) {
  if (!allowed || !st || typeof st !== 'object') return st;
  const lr = st.last;
  /*
   * v2.630(R2630-03): **오류가 있었다는 사실·개수는 남긴다** — 예전에는 error·sourceErrors 를 통째로 버려 범위 계정
   *   화면이 마지막 수집 실패를 '저장된 값이 없습니다(기다리면 된다)' 로 말했다(bmUsageText.emptyDiag 가 last.error 로
   *   'failed' 를 판정한다). 원문(함대 등록부·분류 오류 문장)만 가리고, 입력 이름(source)은 공통 어휘라 그대로 둔다.
   */
  const srcErrs = Array.isArray(lr?.sourceErrors) ? lr.sourceErrors.filter((x) => x && typeof x === 'object') : [];
  const last = lr && typeof lr === 'object'
    ? {
      at: lr.at ?? null, ms: lr.ms ?? null, trigger: lr.trigger ?? null, servers: null, okCount: null, failCount: null, inserted: null,
      ...(lr.error ? { error: FULL_SCOPE_TEXT } : {}),
      ...(srcErrs.length ? { sourceErrors: srcErrs.map((x) => ({ source: String(x.source || ''), error: FULL_SCOPE_TEXT })) } : {}),
      ...(lr.dbError ? { dbOk: false, dbError: FULL_SCOPE_TEXT } : {}),
    }
    : lr;
  // 보존 정리의 삭제 행 수는 함대 전체 수치다 — 범위 계정에는 null(정리했는지·실패했는지는 남긴다).
  const lp = st.lastPrune;
  const lastPrune = lp && typeof lp === 'object'
    ? {
      at: lp.at ?? null, ok: lp.ok ?? null, skipped: lp.skipped ?? null, reason: lp.reason ?? null, done: lp.done ?? null,
      rawDeleted: null, dailyDeleted: null, ...(lp.error ? { error: FULL_SCOPE_TEXT } : {}),
    }
    : lp;
  return { ...st, last, ...('lastPrune' in st ? { lastPrune } : {}), authStopCount: null, entDeferred: null, prevKeys: null, alertState: null, fleetCountsHidden: true };
}
const stripAckBy = (st, isAdmin) => {
  if (isAdmin || !st || typeof st !== 'object' || !('enterpriseAckBy' in st)) return st;
  const { enterpriseAckBy: _a, ...rest } = st; void _a; return rest;
};

/**
 * 비-admin 가림에 쓸 주소 목록(v2.601 AUTHZ-2601-01) — 대상의 iDRAC·OS 주소 + iDRAC 등록부 주소.
 * 제외(skipped) 행·귀속 없음 표본에는 주소 칸이 없어 **등록부 주소와 대조**해야 이름=FQDN 인 행을 잡는다.
 * 등록부를 못 읽어도 IP 판정은 그대로 동작한다(넓게 여는 쪽으로 실패하지 않는다 — IPv4 는 항상 가린다).
 */
export async function bmAddressHosts(tg) {
  const hosts = [];
  for (const x of (tg?.targets || [])) {
    if (x?.idrac?.host) hosts.push(x.idrac.host);
    if (x?.osHost?.host) hosts.push(x.osHost.host);
    if (x?.idracHost) hosts.push(x.idracHost);
    if (x?.osHostName) hosts.push(x.osHostName);
  }
  try {
    const { loadRegistry } = await import('../../idrac/registry.js');
    for (const r of loadRegistry()) if (r?.host) hosts.push(r.host);
  } catch { /* 등록부를 못 읽으면 IP 판정만 — 아래 addressMatcher 가 IPv4 는 늘 잡는다 */ }
  return [...new Set(hosts.filter((h) => typeof h === 'string' && h))];
}

/** 비-admin 응답의 베어메탈 목록 전부를 같은 판정기로 가린다(대상과 최신값 행의 key 토큰이 같게). */
export function maskBmList(list, match) {
  return Array.isArray(list) ? list.map((x) => maskBmIdentity(x, match)) : list;
}

/** 귀속 없음 표본의 key·name 이 주소인 행을 가린다(v2.601 — 전체 범위 비-admin 에게만 나가는 경로). */
export function maskUnassignedInfo(info, match) {
  if (!info || typeof info !== 'object' || !Array.isArray(info.samples)) return info;
  return { ...info, samples: maskBmList(info.samples, match) };
}

/**
 * `hostsUnread`(v2.605 LEFT2605-05) — 범위 계정에는 허용 vCenter 것만 남기고 뺀 대수를 그 범위에서 다시 센다
 * (귀속 없는 베어메탈 개수는 '귀속 없는 데이터 미노출' 규약에 따라 주지 않는다). 없으면 null.
 */
export function scopeHostsUnread(h, allowed) {
  if (!h || typeof h !== 'object') return null;
  if (!allowed) return h;
  const inScope = (l) => (Array.isArray(l) ? l.filter((id) => allowed.has(id)) : []);
  const byVc = Object.fromEntries(Object.entries(h.droppedByVc || {}).filter(([id]) => id && allowed.has(id)));
  const vcenters = inScope(h.vcenters);
  if (!vcenters.length) return null;
  return {
    vcenters, withheld: inScope(h.withheld), expired: inScope(h.expired),
    dropped: Object.values(byVc).reduce((a, n) => a + n, 0), droppedByVc: byVc,
    since: Object.fromEntries(Object.entries(h.since || {}).filter(([id]) => allowed.has(id))),
    withholdMaxMs: h.withholdMaxMs ?? null, scoped: true,
  };
}

/*
 * v2.744(최종 수정분 검토 RV2744F-WEB-03): 서버 상세(poller.usageDetailFor)의 비-관리자 판본(순수 — 원본을 바꾸지 않는다).
 *   상세에는 장치 이름·경로가 없다(폴러가 개수만 둔다). 남는 위험은 **자유 문장**(OS·iDRAC·대체 경로 오류 문구 · 노트 · 대체 경로 생략 사유)에
 *   섞인 주소와 racadm **원문**(entRaw — 배너·호스트명이 섞일 수 있다)이다. 문장은 등록부 주소를 표식으로 바꾸고 IPv4 는 토큰으로(maskBmIdentity 와
 *   같은 규칙), 원문은 싣지 않고 `entRawHidden` 으로 밝힌다(조용히 빼지 않는다). ⚠ IPv6 는 등록부에 있는 주소만 가린다(정직 기록).
 */
const IPV4_TEXT = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
export function maskUsageDetail(d, hosts = []) {
  if (!d || typeof d !== 'object') return d;
  const sc = scrubberFor(Array.isArray(hosts) ? hosts : []);
  const clean = (v) => (typeof v === 'string' && v ? sc(v).replace(IPV4_TEXT, (ip) => maskedIdToken(ip)) : v);
  const { entRaw, ...rest } = d;
  return {
    ...rest,
    osError: clean(d.osError), idracError: clean(d.idracError), entError: clean(d.entError),
    entSkipped: Array.isArray(d.entSkipped) ? d.entSkipped.map((x) => (x && typeof x === 'object' ? { ...x, reason: clean(x.reason) } : x)) : d.entSkipped,
    notes: Array.isArray(d.notes) ? d.notes.map(clean) : d.notes,
    entRaw: '', ...(entRaw ? { entRawHidden: true } : {}),
  };
}
/** 상세 응답 조각 — 화면이 '왜 상세가 없는지' 를 상태 코드로 받는다(state 'none' · 'demo'). */
function usageDetailPart(key, { admin = false, hosts = [] } = {}) {
  const u = usageDetailFor(key);
  return {
    usageDetail: u.detail ? (admin ? u.detail : maskUsageDetail(u.detail, hosts)) : null,
    usageDetailState: u.state, usageDetailSince: u.since ?? null, ...(u.at ? { usageDetailAt: u.at } : {}),
  };
}

/** v2.920(반증 D2) — 데모(mock) 대상 최신값에 성능 열을 겹친다(응답 전용 · mock 이 아니면 그대로). */
async function demoPerfRows(rows, targets) {
  if (!isMockMode()) return rows;
  return (await import('../../mock/demo/baremetal.js')).demoPerfLatestRows(rows, targets);
}
/** v2.919 — 성능 항목에서 목록용 필드만(본체는 perfView.compactPerfEntry 하나 — 봉투 크기 상한과 같은 함수). */
export const compactPerf = compactPerfEntry;

// v2.613 RUNTIME2613-03(a): 엣지 인출 풀 상수(모듈 최상위 — export 를 등록 함수 안에 두면 SyntaxError, v2.593 교훈).
export const EDGE_PULL_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.BMUSAGE_PULL_CONCURRENCY) || 4));
// 시한 env 는 [1초, 10분] 정규화(v2.605 TIM2605-04 규약 — agent/envTimeout.js). 예산 상한 150초 < 웹 시한 180초.
export const EDGE_PULL_BUDGET_MS = reqTimeoutMs(process.env.BMUSAGE_PULL_BUDGET_MS, 150_000, { min: 20_000, max: 150_000 });
// 엣지 1곳 최악 = 요청 시한 × (1 + 재시도 1). ⚠ 시한 env 는 `central/bmUsageEdgePull.js:25` 와 같은 이름을 읽는다(그쪽이 export 하지 않는다 — 두 곳).
export const EDGE_PULL_WORST_MS = 2 * reqTimeoutMs(process.env.BMUSAGE_PULL_TIMEOUT_MS, 20_000, { min: 5_000 });

/**
 * v2.919(리눅스 성능 1단계) — 서버 1대의 성능 상세: USE 매트릭스(근거 포함) · 교차 판정 ①~④ · 커버리지 · 장치별 · 튜닝 현재값 · 두 경로 읽은 시각.
 *  · 권한: `tools` + vCenter scope — 범위 밖·귀속 없는 서버는 **없는 것과 구분하지 않고 404**(존재 은닉 — history 와 같은 규칙).
 *  · 이 노드가 직접 수집하는 서버는 여기서 판정한다(hwFacts — 장비 왕복 0). 엣지 위임 서버는 **엣지가 판정해 보낸 보관분**을 그대로 전한다
 *    (중앙이 다시 판정하지 않는다 — v2.548). 보관분이 없으면 404 가 아니라 `via:'edge-none'` 으로 ‘당겨 와야 한다’ 를 말한다.
 *  · 응답 캐시: memoJson(스냅샷 세대 + URL) + 범위 서명 + 역할(주소 가림이 다르다) + 마지막 수집 시각(새 표본이 오면 새로 계산).
 *  · 진단 스냅샷(POST)은 4단계다 — 이 라우트는 읽기만 한다.
 *  ⚠ 경로는 `/tools/bm-usage/perf/:key` 다(지시문의 `/tools/bm-perf/:key` 가 아니다): `/api/tools/<첫 세그먼트>` 는 도구 키와 같아야
 *    도구별 접근(toolsDenied)이 서버에서 집행된다(auth/toolAccess.js 이름 규약 — 세그먼트≠키 표는 늘리지 않는다). 새 세그먼트 bm-perf 를
 *    만들면 ‘베어메탈 사용률’ 을 거부당한 사용자도 이 상세를 읽는다. 같은 도구의 하위 경로로 두어 기존 매핑을 그대로 탄다.
 */
export async function bmPerfView(req, snap, deps = {}) {
  // deps — 테스트 주입점(대상 해석·최신값·하드웨어 사실·엣지 보관분). 라우트는 넘기지 않는다(실제 모듈).
  const D = {
    currentTargets, latestUsage, hwFactsReader, bmAddressHosts,
    listEdgeBmUsage: async () => (await import('../../central/bmUsageEdgePull.js')).listEdgeBmUsage(),
    ...deps,
  };
  const allowed = scopedVcenterIds(req.user, snap);
  const isAdmin = isAdminReq(req);
  const key = t(req.params.key);
  if (!key) return { __status: 400, ok: false, reason: 'key 가 필요합니다.' };
  const NOT_FOUND = { __status: 404, ok: false, reason: '대상 서버를 찾지 못했습니다.' };
  const s = loadBmUsageSettings();
  const tg = await D.currentTargets();
  const realKey = tg.targets.some((x) => x.key === key) ? key
    : (isAdmin ? null : resolveMaskedToken(key, tg.targets.map((x) => x.key)));
  const target = realKey ? (tg.targets.find((x) => x.key === realKey) || null) : null;
  const common = { perfThresholds: s.perf, perfDefaults: PERF_DEFAULTS, perfCols: PERF_COL_META, intervalMs: s.intervalMs, freshMs: freshMsFor(s.intervalMs) };
  if (target) {
    if (allowed && (!target.vcenterId || !allowed.has(target.vcenterId))) return NOT_FOUND;
    const agent = config.agent?.name || '';
    const row0 = (await D.latestUsage({ json: true }).catch(() => [])).find((r) => t(r.key) === target.key && t(r.agent) === agent) || null;
    const row = row0 ? (await demoPerfRows([row0], tg.targets))[0] : null;   // v2.920(반증 D2) — 데모 대상만, 응답 단계에서만
    const hwOf = await D.hwFactsReader({ agent, freshMs: freshMsFor(s.intervalMs) }).catch(() => () => null);
    const entry = row ? buildPerfEntry({ row, hw: hwOf(target) || null, th: s.perf, intervalMs: s.intervalMs, full: true }) : null;
    if (isAdmin) return { ok: true, key, via: 'local', target: publicTarget(target), entry, ...common, ...(row ? {} : { reason: 'no-sample' }) };
    const hosts = await D.bmAddressHosts(tg);
    return { ok: true, key, via: 'local', target: maskTargetAddress(publicTarget(target), hosts), entry: entry ? { ...entry, key } : null, ...common, addressHidden: true, ...(row ? {} : { reason: 'no-sample' }) };
  }
  // 엣지 위임 서버 — 보관분(중앙이 당겨 온 엣지 봉투)에서 찾는다. 범위 계정은 대상의 vCenter 가 범위 안일 때만(엣지 목록과 같은 규칙).
  const regHosts = isAdmin ? [] : await D.bmAddressHosts(null);
  for (const rec of await D.listEdgeBmUsage()) {
    const sn = rec?.snap;
    if (!sn) continue;
    const snapHosts = isAdmin ? [] : [...regHosts, ...(sn.targets || []).flatMap((x) => [x?.idracHost, x?.osHostName])].filter((h) => typeof h === 'string' && h);
    const em = addressMatcher(snapHosts);
    const tgt = (sn.targets || []).find((x) => t(x.key) === key || (!isAdmin && maskBmIdentity(x, em).key === key));
    if (!tgt) continue;
    if (allowed && (!t(tgt.vcenterId) || !allowed.has(t(tgt.vcenterId)))) return NOT_FOUND;
    const entry = (sn.perf || []).find((p) => t(p.key) === t(tgt.key)) || null;
    // v2.919(반증 D2): 봉투가 크기 상한으로 상세를 뺐으면 그 사실과 사유를 그대로 전한다(상세가 없는 것을 ‘모름’ 으로 뭉개지 않는다).
    const base = { ok: true, key, via: entry ? 'edge' : 'edge-none', agent: rec.agent, snapAt: rec.snapAt || null, ...common,
      perfThresholds: sn.perfThresholds || null, edgeThresholds: true,
      ...(entry && !entry.cells ? { detailOmitted: true } : {}), ...(sn.perfTruncated ? { perfTruncated: sn.perfTruncated } : {}) };
    if (isAdmin) return { ...base, target: tgt, entry };
    return { ...base, target: maskTargetAddress(tgt, snapHosts, em), entry: entry ? { ...entry, key } : null, addressHidden: true };
  }
  return NOT_FOUND;
}
/**
 * v2.922(3a) — 서버 1대의 추이(평균·피크 두 계열) · 장치 목록. 3b 화면(추이 탭 · 확대 팝업 · 장치 토글)이 쓴다. 기존 `/tools/bm-usage/history`
 *   (BmUsageChart)는 그대로 두었다(계약 불변).
 *  · 권한·범위·404 는 bmPerfView 와 같은 규칙(범위 밖·귀속 없음·없는 키 → 404 · 주소인 key 는 가림 토큰으로도 찾는다).
 *  · 이 노드 서버는 trendFor/devicesFor(시간 단위 파일). **엣지 위임 서버는 엣지 대행**(central/bmUsageEdgePull.pullBmTrend — 응답 상한 ·
 *    아는 필드만 · truncated). 중앙은 엣지 이력을 복제 적재하지 않는다(설계 §4.4 ‘중앙 크기는 변하지 않는다’).
 *  · 응답 캐시: memoJson(세대 + URL) + 범위 서명 + 역할 + 마지막 수집 시각.
 */
export async function bmTrendView(req, snap, mode = 'history', deps = {}) {
  const D = {
    currentTargets, bmAddressHosts,
    listEdgeBmUsage: async () => (await import('../../central/bmUsageEdgePull.js')).listEdgeBmUsage(),
    pullBmTrend: async (agent, m, key, q) => (await import('../../central/bmUsageEdgePull.js')).pullBmTrend(agent, { mode: m, key, query: q }),
    trendFor: async (a) => (await import('../../bmusage/trendQuery.js')).trendFor(a),
    devicesFor: async (a) => (await import('../../bmusage/trendQuery.js')).devicesFor(a),
    ...deps,
  };
  const allowed = scopedVcenterIds(req.user, snap);
  const isAdmin = isAdminReq(req);
  const key = t(req.params.key);
  if (!key) return { __status: 400, ok: false, reason: 'key 가 필요합니다.' };
  const NOT_FOUND = { __status: 404, ok: false, reason: '대상 서버를 찾지 못했습니다.' };
  const tg = await D.currentTargets();
  const realKey = tg.targets.some((x) => x.key === key) ? key : (isAdmin ? null : resolveMaskedToken(key, tg.targets.map((x) => x.key)));
  const target = realKey ? (tg.targets.find((x) => x.key === realKey) || null) : null;
  if (target) {
    if (allowed && (!target.vcenterId || !allowed.has(target.vcenterId))) return NOT_FOUND;
    const agent = config.agent?.name || '';
    const r = mode === 'devices' ? await D.devicesFor({ agent, key: target.key }) : await D.trendFor({ agent, key: target.key, q: req.query || {}, settings: loadBmUsageSettings() });
    return r && r.ok ? { ...r, key, via: 'local' } : r;
  }
  const regHosts = isAdmin ? [] : await D.bmAddressHosts(null);
  for (const rec of await D.listEdgeBmUsage()) {
    const sn = rec?.snap;
    if (!sn) continue;
    const snapHosts = isAdmin ? [] : [...regHosts, ...(sn.targets || []).flatMap((x) => [x?.idracHost, x?.osHostName])].filter((h) => typeof h === 'string' && h);
    const em = addressMatcher(snapHosts);
    const tgt = (sn.targets || []).find((x) => t(x.key) === key || (!isAdmin && maskBmIdentity(x, em).key === key));
    if (!tgt) continue;
    if (allowed && (!t(tgt.vcenterId) || !allowed.has(t(tgt.vcenterId)))) return NOT_FOUND;
    const r = await D.pullBmTrend(rec.agent, mode, t(tgt.key), req.query || {});
    if (!r?.ok) return { ok: false, key, via: 'edge', agent: rec.agent, kind: r?.kind || 'error', reason: r?.reason || '엣지에서 추이를 읽지 못했습니다.' };
    return { ...r.body, key, via: 'edge', agent: rec.agent, ms: r.ms };
  }
  return NOT_FOUND;
}
/**
 * v2.922(3a · 설계 PROFILES §10) — 서버 NIC ↔ CVP 스위치 포트: 매핑(수동 확정 · 설명 매칭 후보) · 상태 5종 · 양쪽 대조 ⑤.
 *  · 법인 축: 서버 vCenter → DataCenter(datacenter/store) ↔ CVP 서버의 datacenterId. 그 법인 CVP 가 없으면 no-cvp(열 전체 ‘—’).
 *  · **범위 계정은 자기 법인 CVP 만**: 서버가 범위 밖이면 404(존재 은닉) · 수동 매핑이 다른 법인 CVP 를 가리키면 범위 계정에는 숨기고 센다.
 *  · CVP 이력은 복제 적재하지 않는다 — port_latest(이 노드 CVP DB)를 조회로 붙인다. 엣지 위임 서버의 NIC 값은 엣지 대행(nics).
 *  · LLDP·MAC 매핑은 만들지 않았다(경로 미확인 — 정직 기록). 응답이 그 사실을 싣는다(notBuilt).
 */
export async function bmPortsView(req, snap, deps = {}) {
  const D = {
    currentTargets, bmAddressHosts,
    listEdgeBmUsage: async () => (await import('../../central/bmUsageEdgePull.js')).listEdgeBmUsage(),
    pullBmTrend: async (agent, m, key, q) => (await import('../../central/bmUsageEdgePull.js')).pullBmTrend(agent, { mode: m, key, query: q }),
    nicLatestFor: async (a) => (await import('../../bmusage/trendQuery.js')).nicLatestFor(a),
    cvpServers: async () => (await import('../../cvp/registry.js')).listServers(),
    datacenterOfVcenter: async (vc) => (await import('../../datacenter/store.js')).datacenterOfVcenter(vc),
    portLatestRows: async (o) => (await import('../../cvp/db.js')).portLatestRows(o),
    portsByDesc: async (t2) => (await import('../../cvp/db.js')).portsByDesc(t2),
    cvpIntervalMs: async () => { try { return (await import('../../cvp/settings.js')).loadSettings().intervalMs; } catch { return null; } },
    listPortMap: async (o) => (await import('../../bmusage/portMap.js')).listPortMap(o),
    ...deps,
  };
  const P = await import('../../bmusage/portCompare.js');
  const allowed = scopedVcenterIds(req.user, snap);
  const isAdmin = isAdminReq(req);
  const key = t(req.params.key);
  if (!key) return { __status: 400, ok: false, reason: 'key 가 필요합니다.' };
  const NOT_FOUND = { __status: 404, ok: false, reason: '대상 서버를 찾지 못했습니다.' };
  const found = await resolvePerfTarget(req, D, { allowed, isAdmin, key });
  if (!found) return NOT_FOUND;
  if (found.denied) return NOT_FOUND;
  const s = loadBmUsageSettings();
  const tol = s.store?.portTolPct ?? 5;
  const vc = t(found.target.vcenterId);
  const corpId = vc ? t(await D.datacenterOfVcenter(vc)) : '';
  const cvps = (await D.cvpServers().catch(() => [])) || [];
  const corpCvpIds = corpId ? cvps.filter((x) => t(x.datacenterId) === corpId).map((x) => String(x.id)) : [];
  const base = { ok: true, key, via: found.via, corpId: corpId || null, tolPct: tol, alignPct: 20, notBuilt: ['lldp', 'mac'] };
  // 서버 NIC 최신 5분(이 노드 또는 엣지 대행)
  let nicRes;
  if (found.via === 'local') nicRes = await D.nicLatestFor({ agent: found.agent, key: found.realKey, intervalMs: s.intervalMs });
  else { const r = await D.pullBmTrend(found.agent, 'nics', found.realKey, {}); nicRes = r?.ok ? r.body : { ok: false, nics: [], reason: r?.reason || '엣지에서 NIC 값을 읽지 못했습니다.' }; }
  const nics = nicRes?.nics || [];
  if (!corpCvpIds.length) return { ...base, cvpRegistered: false, nics: nics.map((x) => ({ nic: x.nic, state: 'no-cvp' })), candidates: [] };
  const corpSet = new Set(corpCvpIds);
  const maps0 = await D.listPortMap({ agent: found.agent, key: found.realKey });
  // 확정 매핑이 가리키는 CVP 의 포트 최신값만 읽는다(범위 계정은 자기 법인 CVP 만 — 나머지는 아래에서 숨기고 센다).
  const mapCvps = [...new Set(maps0.map((m) => String(m.cvpId)))].filter((id) => !allowed || corpSet.has(id));
  const portsAll = (await D.portLatestRows({ cvpIds: mapCvps }).catch(() => ({ rows: [] }))).rows || [];
  // 후보: v2.920 cvp/hostMatch 하나(포트 설명 — 호스트 짧은 이름·서비스 태그·NIC 이름). 단서로 LIKE 를 넉넉히 뽑고 경계 판정은 matchUplinks.
  const H = await import('../../cvp/hostMatch.js');
  const host = { name: found.target.name || '', aliases: [found.target.serviceTag, found.target.osHostName].filter(Boolean), nics: nics.map((x) => ({ device: x.nic })) };
  const terms = H.hostMatchTerms(host).names;
  const byDesc = terms.length ? ((await D.portsByDesc(terms).catch(() => ({ rows: [] }))).rows || []).filter((p) => corpSet.has(String(p.cvpId))) : [];
  const candidates = H.matchUplinks(byDesc, host).uplinks.slice(0, 32)
    .map((u) => ({ cvpId: String(u.cvpId), deviceKey: String(u.key), deviceName: u.hostname || '', port: u.port, descr: String(u.desc).slice(0, 200), nic: u.nic, basis: u.basis }));
  const maps = maps0;
  let hiddenOutOfScope = 0;
  const cvpSpan = Number(await D.cvpIntervalMs()) || null;
  const freshMs = Math.max(30 * 60_000, 3 * (cvpSpan || 300_000));
  const rows = nics.map((x) => {
    let mapping = maps.find((m) => m.nic === x.nic) || null;
    if (mapping && allowed && !corpSet.has(String(mapping.cvpId))) { hiddenOutOfScope += 1; mapping = null; }
    const port = mapping ? (portsAll.find((p) => String(p.cvp_id) === String(mapping.cvpId) && String(p.device_key) === String(mapping.deviceKey) && String(p.port) === String(mapping.port)) || null) : null;
    const state = P.portState({ mapping, candidates: candidates.filter((c) => !c.nic || c.nic === x.nic), corpHasCvp: true, port, freshMs });
    const compare = state === 'mapped' ? P.compareTraffic({ server: { txBps: x.txBps, rxBps: x.rxBps, at: x.at, spanMs: x.spanMs, dropDelta: x.dropDelta, errDelta: x.errDelta },
      port: { ...port, spanMs: cvpSpan }, tolPct: tol }) : null;
    return { nic: x.nic, state, mapping: mapping ? { cvpId: mapping.cvpId, deviceKey: mapping.deviceKey, port: mapping.port, by: isAdmin ? mapping.by : undefined, at: mapping.at } : null,
      port: port ? { device: port.hostname || port.device_key, port: port.port, descr: port.descr, speedBps: port.speed_bps, oper: port.oper, inBps: port.in_bps, outBps: port.out_bps, inUtil: port.in_util, outUtil: port.out_util,
        inErr: port.in_err, outErr: port.out_err, inDrop: port.in_drop ?? null, outDrop: port.out_drop ?? null, rateAt: port.rate_ts } : null,
      server: { rxBps: x.rxBps, txBps: x.txBps, at: x.at, dropDelta: x.dropDelta, errDelta: x.errDelta }, compare };
  });
  return { ...base, cvpRegistered: true, nics: rows, candidates, ...(hiddenOutOfScope ? { hiddenOutOfScope } : {}), ...(nicRes?.ok === false ? { nicError: nicRes.reason } : {}) };
}
/** 성능 상세 대상 해석(이 노드 · 엣지 보관분) — bmTrendView 와 같은 규칙. 범위 밖이면 { denied }. */
async function resolvePerfTarget(req, D, { allowed, isAdmin, key }) {
  const tg = await D.currentTargets();
  const realKey = tg.targets.some((x) => x.key === key) ? key : (isAdmin ? null : resolveMaskedToken(key, tg.targets.map((x) => x.key)));
  const target = realKey ? (tg.targets.find((x) => x.key === realKey) || null) : null;
  if (target) {
    if (allowed && (!target.vcenterId || !allowed.has(target.vcenterId))) return { denied: true };
    return { via: 'local', agent: config.agent?.name || '', realKey, target };
  }
  const regHosts = isAdmin ? [] : await D.bmAddressHosts(null);
  for (const rec of await D.listEdgeBmUsage()) {
    const sn = rec?.snap;
    if (!sn) continue;
    const snapHosts = isAdmin ? [] : [...regHosts, ...(sn.targets || []).flatMap((x) => [x?.idracHost, x?.osHostName])].filter((h) => typeof h === 'string' && h);
    const em = addressMatcher(snapHosts);
    const tgt = (sn.targets || []).find((x) => t(x.key) === key || (!isAdmin && maskBmIdentity(x, em).key === key));
    if (!tgt) continue;
    if (allowed && (!t(tgt.vcenterId) || !allowed.has(t(tgt.vcenterId)))) return { denied: true };
    return { via: 'edge', agent: rec.agent, realKey: t(tgt.key), target: tgt };
  }
  return null;
}
export function registerBmUsage(api) {

/** 주 조회 — 대상·최신값·설정·상태. 장비에 접속하지 않는다. */
api.get('/tools/bm-usage', toolsPerm, async (req, res) => {
  const allowed = scopedVcenterIds(req.user, store.get());
  const isAdmin = isAdminReq(req);
  try {
    const [tg, latest, db] = await Promise.all([
      currentTargets(),
      latestUsage({ json: true }).catch(() => []),   // v2.922(D13): 판정(psiAbsent·firstSample)이 detail_json 을 쓴다
      dbStatus().catch(() => ({ available: false })),
    ]);
    // v2.600 AUTHZ-2600-08: 비-admin 에는 iDRAC·OS 관리 주소를 가린다(가린 사실은 addressHidden).
    // v2.601 AUTHZ-2601-01: 주소 칸만이 아니라 **식별자·이름이 주소인 행**(IP 로 등록한 iDRAC)도 가린다 —
    //   serverId·fleetId·key·name 이 곧 IP 라 host 를 비워도 그대로 샜다. 범위 절단은 원문으로 먼저 한다.
    const hosts = isAdmin ? [] : await bmAddressHosts(tg);
    const match = addressMatcher(hosts);
    const targets0 = applyScope(tg.targets.map(publicTarget), allowed);
    const targets = isAdmin ? targets0 : targets0.map((x) => maskTargetAddress(x, hosts, match));
    const skipped0 = applyScope(tg.skipped, allowed);
    const skipped = isAdmin ? skipped0 : maskBmList(skipped0, match);
    /*
     * ⚠ **사유별 개수도 scope 를 타야 한다**(v2.550 자체 재검토에서 잡은 결함): 예전에는
     *   `tg.counts.byReason` 을 그대로 내보내 범위 제한 계정이 **다른 법인 서버 대수**를 알 수 있었다
     *   (server/CLAUDE.md '귀속 없는 데이터·범위 밖 요약은 범위 계정에 노출하지 않는다').
     *   전체 범위 계정은 그대로, 범위 계정은 **보이는 목록에서 다시 센다**.
     */
    const skippedCounts = allowed
      ? skipped.reduce((acc, x) => { acc[x.reason] = (acc[x.reason] || 0) + 1; return acc; }, {})
      : (tg.counts.byReason || {});
    const counts = allowed
      ? { ...tg.counts, targets: targets.length, skipped: skipped.length, byReason: skippedCounts,
          idrac: targets.filter((x) => (x.paths || []).includes('idrac')).length,
          os: targets.filter((x) => (x.paths || []).includes('os')).length,
          both: targets.filter((x) => (x.paths || []).length > 1).length }
      : tg.counts;
    const keys = new Set(targets0.map((x) => x.key));
    // 최신값은 **대상 목록 안의 것만** 준다(법인을 끄거나 등록이 사라진 서버의 옛 값이 새어 나가지 않게).
    // v2.920(반증 D2): 데모(mock) 대상의 성능 열은 응답 단계에서만 겹친다(적재하지 않는다 — mock/demo/baremetal.js demoPerfLatestRows).
    const rowsRaw = await demoPerfRows(latest.filter((r) => keys.has(t(r.key))), tg.targets);
    // v2.919: 행에서 JSON 문자열 열(장치별·튜닝)을 뗀다 — 목록에는 판정 code 표(perf)만, 장치별은 서버 상세(/tools/bm-usage/perf/:key)에서.
    const rows0 = rowsRaw.map(stripJsonCols);
    const rows = isAdmin ? rows0 : maskBmList(rows0, match);
    const perfSettings = loadBmUsageSettings();
    const pf = await perfForRows(rowsRaw, tg.targets, perfSettings, { full: false });
    const perf = isAdmin ? pf.perf : maskBmList(pf.perf, match);
    res.json({
      ok: true, at: Date.now(),
      enabled: bmUsageEnabled(),
      // v2.708: 데모(mock) — 저장된 설정은 꺼짐이어도 수집이 켜진 것처럼 돈다(설정 파일은 바꾸지 않는다). 화면이 데모임을 말할 수 있게.
      ...(isMockMode() ? { demo: true } : {}),
      settings: scopeMainSettings(loadBmUsageSettings(), allowed, isAdmin), defaults: DEFAULTS,
      targets, rows,
      // '왜 대상이 아닌지' 는 개수와 사유로만 준다(범위 밖 서버 이름을 흘리지 않기 위해).
      skippedCounts,
      skipped,
      counts,
      /* 키 충돌 — 범위 계정에는 보이는 것만(v2.550.3). 조용히 두면 한 서버 값이 다른 서버로 보인다. */
      keyConflicts: (isAdmin ? (x) => x : (l) => maskBmList(l, match))(applyScope(tg.keyConflicts || [], allowed)),
      metrics: METRICS, reasons: NO_PATH_REASON,
      vcenters: applyScope(tg.vcenters.map((v) => ({ ...v, vcenterId: v.id })), allowed),
      isEdge: tg.isEdge,
      // v2.627: 이 노드가 중앙 배포값을 쓰는가(엣지 화면 배너·입력 잠금) · 중앙의 배포 현황(전체 범위 admin 에게만 — 전 엣지 이름).
      central: bmUsageCentralState(),
      distribution: isAdmin && !allowed && !tg.isEdge ? distributionStatus(safeKnownAgents()) : null,
      // ⚠ DB 파일 경로는 admin 에게만(operator 는 tools 를 기본 보유 — '거부 기본값' 규칙).
      db: isAdmin ? db : (({ path: _p, ...rest }) => ({ ...rest, redacted: ['path'] }))(db),
      // v2.744(최종 검토 FB — RD-R1·RG2744-03): 등록부 로드 오류 사유(last.sourceErrors)의 위치(줄·칸)는 관리자에게만 — 그 밖의 계정은 분류 문구만.
      //   원문 조각은 폴러가 처음부터 싣지 않는다(registrySourceError). fleetPartials(아래)와 같은 규칙이다.
      status: scopeBmStatus(isAdmin ? bmUsageStatus({ detail: true }) : maskPollerStatus(stripAckBy(bmUsageStatus({ detail: false }), isAdmin), hosts), allowed),
      enterpriseActive: enterpriseActive(),
      licenseLabels: TIER_LABEL,
      /*
       * ⚠⚠ **'법인 귀속 없음' 의 원인을 말한다**(v2.554 — 사용자 지시 "네 — 원인까지 조사").
       *   이 현장은 이 사유로 **500대**가 제외돼 표가 통째로 비어 있었다. 사유만 말하고 원인을
       *   말하지 않으면 사용자가 무엇을 고쳐야 하는지 알 수 없다.
       * ⚠ **범위 제한 계정에는 주지 않는다** — 귀속 없는 서버의 이름·서비스태그를 노출하는 것은
       *   '귀속 없는 데이터 미노출' 불변조건 위반이다(server/CLAUDE.md).
       */
      unassignedInfo: allowed ? null : (isAdmin ? await unassignedInfoFor(tg) : maskUnassignedInfo(await unassignedInfoFor(tg), match)),
      unassignedCauses: UNASSIGNED_CAUSE,
      /*
       * ⚠ 인증 실패로 정지된 대상은 **파일 기준으로 다시 센다** — 폴러의 인메모리 맵은 재시작하면
       *   비어서, 그것만 보고 '정지 0건' 이라 말하면 조용한 정지가 된다(v2.528 규약).
       *   범위 계정에는 보이는 대상만.
       */
      authStops: (isAdmin ? (x) => x : (l) => maskBmList(l, match))(applyScope(authStopsFor(tg.targets), allowed)),
      // v2.605 LEFT2605-05: 호스트를 못 읽은 vCenter 때문에 이번에 뺀 베어메탈 — 화면이 말해야 조용한 제외가 아니다.
      hostsUnread: scopeHostsUnread(tg.hostsUnread, allowed),
      // v2.607(감사 LEFT2607-02): 엣지가 일부만 보낸 베어메탈 목록(부분 전송·상한 제외·귀속 비움) — 범위 계정에는 null(엣지는 나눌 축이 없다).
      fleetPartials: allowed ? null : fleetPartialsSummary({ detail: isAdmin }), // v2.744(회귀 검토 GD-R1): 등록부 손상 사유의 위치(줄·칸)는 관리자에게만(operator 는 tools 기본 보유) — 원문 조각은 누구에게도 싣지 않는다
      log: scopeFilePaths(bmUsageLogInfo(), req.user),
      ...(isAdmin ? {} : { addressHidden: true }),
      /*
       * v2.919(리눅스 성능 1단계): 보이는 행마다 USE 판정 code 표·판정 한 줄·커버리지·교차 판정 상태(perf) + 기준값(이 노드 설정 — 화면에
       *   숫자를 박지 않는다) + 열 ↔ USE 칸 대응(perfCols). 행 필터·주소 가림은 rows 와 같다(같은 key 토큰).
       */
      perf, perfThresholds: perfSettings.perf, perfDefaults: PERF_DEFAULTS, perfCols: PERF_COL_META,
      ...(pf.perfError ? { perfError: pf.perfError } : {}),
    });
  } catch (e) {
    res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
  }
});

api.get('/tools/bm-usage/perf/:key', toolsPerm, (req, res) => memoJson(req, res, 'bm-perf', (snap) => bmPerfView(req, snap), {
  extraKey: `${scopeKey(req.user, store.get())}|${isAdminReq(req) ? 'a' : 'u'}|${bmUsageStatus().last?.at || 0}`,
}));

// v2.922(3a): 추이(평균·피크 · 해상도 auto · 결측 · 기준선) · 장치 목록(색 고정 순서). 엣지 위임 서버는 엣지 대행.
const trendKey = (req) => `${scopeKey(req.user, store.get())}|${isAdminReq(req) ? 'a' : 'u'}|${bmUsageStatus().last?.at || 0}`;
api.get('/tools/bm-usage/perf/:key/history', toolsPerm, (req, res) => memoJson(req, res, 'bm-trend', (snap) => bmTrendView(req, snap, 'history'), { extraKey: trendKey(req) }));
api.get('/tools/bm-usage/perf/:key/devices', toolsPerm, (req, res) => memoJson(req, res, 'bm-devices', (snap) => bmTrendView(req, snap, 'devices'), { extraKey: trendKey(req) }));

api.get('/tools/bm-usage/perf/:key/ports', toolsPerm, (req, res) => memoJson(req, res, 'bm-ports', (snap) => bmPortsView(req, snap), { extraKey: trendKey(req) }));
/**
 * v2.922 — 수동 매핑 확정/삭제(설정 소유자 = admin). 범위: 서버가 안 보이면 404 · 보이는데 매핑할 CVP 가 그 법인 것이 아니면 403(조회 밖 404 → 쓰기 밖 403).
 *   원자적 쓰기(portMap.js) · 감사 로그. body { key, nic, cvpId, deviceKey, port, remove? }.
 */
/*
 * v2.922(반증 D1): 쓰기 범위 검사는 **조건 없이** 한다 — 바깥 조건을 조회 범위(scopedVcenterIds)로 두면 ‘조회 무제한 + writeVcenters 제한’
 *   계정이 통째로 검사에서 빠진다(server/CLAUDE.md v2.733 함정). 순서: 조회 밖 404 → 쓰기 밖 403 → (전체 범위가 아니면) 법인 CVP 403.
 *   삭제는 PUT { remove:true } 와 DELETE 둘 다 받는다(같은 처리 함수 — 검사가 갈라지지 않게).
 */
async function portMapWrite(req, res, { remove = false } = {}) {
  const b = { ...(req.query && typeof req.query === 'object' ? req.query : {}), ...(req.body && typeof req.body === 'object' ? req.body : {}) };
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  const D = {
    currentTargets, bmAddressHosts,
    listEdgeBmUsage: async () => (await import('../../central/bmUsageEdgePull.js')).listEdgeBmUsage(),
  };
  try {
    const found = await resolvePerfTarget(req, D, { allowed, isAdmin: true, key: t(b.key) });
    if (!found || found.denied) return res.status(404).json({ ok: false, reason: '대상 서버를 찾지 못했습니다.' });
    if (!inUserWriteScope(req.user, snap, t(found.target.vcenterId))) return res.status(403).json({ ok: false, error: 'forbidden', reason: '이 서버의 법인에 쓰기 권한이 없습니다(조회 전용).' });
    const PM = await import('../../bmusage/portMap.js');
    if (remove || b.remove === true) {
      const r = PM.removePortMapping({ agent: found.agent, key: found.realKey, nic: t(b.nic) });
      logAudit({ user: req.user?.username, action: 'bm-usage.port-map.remove', ip: req.ip || '', detail: JSON.stringify({ key: found.realKey, nic: t(b.nic), ok: r.ok }).slice(0, 300) });
      return res.status(r.ok ? 200 : r.notFound ? 404 : 409).json(r);
    }
    if (!isFullReadWriteScope(req.user, snap)) {
      const vc = t(found.target.vcenterId);
      const corp = vc ? t((await import('../../datacenter/store.js')).datacenterOfVcenter(vc)) : '';
      const cvp = (await import('../../cvp/registry.js')).listServers().find((x) => String(x.id) === t(b.cvpId));
      if (!cvp || !corp || t(cvp.datacenterId) !== corp) return res.status(403).json({ ok: false, error: 'forbidden', reason: '범위 계정은 자기 법인 CVP 포트로만 매핑할 수 있습니다.' });
    }
    const r = PM.setPortMapping({ agent: found.agent, key: found.realKey, nic: b.nic, cvpId: b.cvpId, deviceKey: b.deviceKey, port: b.port }, { by: req.user?.username || '' });
    logAudit({ user: req.user?.username, action: 'bm-usage.port-map.set', ip: req.ip || '', detail: JSON.stringify({ key: found.realKey, nic: t(b.nic), cvpId: t(b.cvpId), deviceKey: t(b.deviceKey), port: t(b.port), ok: r.ok, replaced: !!r.replaced }).slice(0, 300) });
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) { res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) }); }
}
api.put('/tools/bm-usage/port-map', adminOnly, toolsPerm, (req, res) => portMapWrite(req, res));
api.delete('/tools/bm-usage/port-map', adminOnly, toolsPerm, (req, res) => portMapWrite(req, res, { remove: true }));

/** 한 서버의 추이 — 원시 + 일 롤업. 상한으로 잘렸으면 밝힌다(조용한 상한 금지). */
api.get('/tools/bm-usage/history', toolsPerm, async (req, res) => {
  const key = t(req.query.key);
  if (!key) return res.status(400).json({ ok: false, reason: 'key 가 필요합니다.' });
  const allowed = scopedVcenterIds(req.user, store.get());
  try {
    const tg = await currentTargets();
    const isAdmin = isAdminReq(req);
    // v2.601 AUTHZ-2601-01: 비-admin 은 주소인 key 를 토큰으로 받는다 — 토큰으로도 같은 대상을 찾는다.
    const realKey = tg.targets.some((x) => x.key === key) ? key
      : (isAdmin ? null : resolveMaskedToken(key, tg.targets.map((x) => x.key)));
    const target = realKey ? (tg.targets.find((x) => x.key === realKey) || null) : null;
    // 범위 계정은 자기 법인 서버만 — 없는 것과 구분하지 않고 404(존재 은닉 규약).
    // ⚠⚠ v2.574 SEC-02 — `allowed` 는 **Set 또는 null** 이다(`auth/scope.js:16-26`).
    //   예전 코드는 `allowed.includes(...)` 라 **범위 제한 계정에서 항상 TypeError** 였고,
    //   이 라우트가 async 라 express 4 가 그것을 잡지 못해 **응답 없이 매달렸다**(BUG-03 과 겹친다).
    //   전체 범위 계정은 `allowed === null` 이라 `&&` 에서 단락돼 아무도 못 느꼈다.
    //   저장소 전수: `allowed.has(` 110곳 vs `allowed.includes(` **이 한 곳뿐**이었다.
    if (!target || (allowed && (!target.vcenterId || !allowed.has(target.vcenterId)))) {
      return res.status(404).json({ ok: false, reason: '대상 서버를 찾지 못했습니다.' });
    }
    /*
     * ⚠⚠ **적재 키와 조회 키가 같아야 한다**(v2.550 자체 재검토에서 잡은 결함):
     *   `poller.js` 는 `insertUsage(rows, config.agent?.name || '')` 로 적재한다 — 엣지에서는
     *   `AGENT_NAME`, 중앙에서는 `''` 다. 조회를 `''` 로 굳혀 두면 **엣지에서는 추이가 영원히 빈다**
     *   (수집은 되는데 상세가 비어 '저장이 안 된다' 로 보인다). 같은 식을 쓴다.
     */
    const agent = config.agent?.name || '';
    const [raw, daily] = await Promise.all([
      usageHistory(target.key, { agent, hours: Number(req.query.hours) || 24 }),
      usageDaily({ key: target.key, agent, days: Number(req.query.days) || 90 }),
    ]);
    // v2.744(RV2744F-WEB-03): 그 서버의 마지막 수집 상세(읽은 항목·장치별 판정·노트) — 화면 상세 카드가 쓴다. 주 조회에는 싣지 않는다(크기).
    if (isAdmin) {
      return res.json({ ok: true, key, target: publicTarget(target), raw: raw.rows, rawTruncated: raw.truncated, daily, metrics: METRICS, ...usageDetailPart(target.key, { admin: true }) });
    }
    const hosts = await bmAddressHosts(tg);
    const match = addressMatcher(hosts);
    const own = [target.idrac?.host, target.osHost?.host].filter((h) => typeof h === 'string' && h);
    res.json({ ok: true, key, target: maskTargetAddress(publicTarget(target), hosts), addressHidden: true,
      raw: maskBmList(raw.rows, match), rawTruncated: raw.truncated,
      daily: Array.isArray(daily) ? maskBmList(daily, match) : daily, metrics: METRICS,
      ...usageDetailPart(target.key, { admin: false, hosts: [...own, ...hosts] }) });
  } catch (e) {
    res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
  }
});

/** 지금 수집 — 폴러와 **재진입 가드를 공유**한다(연타가 세션을 곱하지 않게). */
api.post('/tools/bm-usage/collect', writeRole, toolsPerm, async (req, res) => {
  // v2.583(감사 확정): 범위 계정이 **전 법인** 수동 수집(인증 정지도 무시)을 걸고 전 법인 counts 를 받았다 —
  //   형제 /edges/pull 처럼 전체 범위 계정만 허용한다(수집 대상을 범위로 나누는 경로가 폴러에 없다).
  if (scopedVcenterIds(req.user, store.get())) {
    return res.status(403).json({ ok: false, error: 'forbidden', requiredOwner: true, reason: '지금 수집은 전 법인 서버에 접속합니다 — 전체 범위(vCenter 제한 없는) 계정만 실행할 수 있습니다.' });
  }
  const r = await pollBmUsageOnce({ trigger: 'manual', demoOnly: isDemoGuest(req.user) }); // v2.720(감사 R1-03): 데모 계정은 데모 대상만
  logAudit({
    user: req.user?.username, action: 'bm-usage.collect', ip: req.ip || '',
    detail: JSON.stringify({ ok: !!r.ok, servers: r.servers ?? null }).slice(0, 300),
  });
  // v2.744(최종 검토 FB): 결과의 sourceErrors 도 주 조회와 같은 규칙 — 등록부 사유의 위치(줄·칸)는 관리자에게만(operator 는 분류 문구만).
  res.json(!isAdminReq(req) && Array.isArray(r?.sourceErrors) ? { ...r, sourceErrors: sourceErrorsView(r.sourceErrors, { detail: false }) } : r);
});

/**
 * 작업 로그 — 실패 사유를 툴팁이 아니라 본문으로 볼 수 있게(v2.516 규약).
 *
 * ⚠⚠ v2.574 SEC-04 — **이 라우트에 scope 가 없었다.** 링버퍼 500건에는
 *   `name`(서버 이름)·`host`(iDRAC 주소 또는 OS 호스트)·`error`(최대 300자)가 **전 법인 혼재**로
 *   들어 있다(`util/activityLog.js:58-68`). 같은 모듈의 주 조회(`/tools/bm-usage`)는
 *   `applyScope()` 로 6개 필드를 전부 거르는데 그 노력이 이 한 라우트로 무효가 됐다.
 *   형제 모듈은 제대로 하고 있었다 — `horizonSessions.js:104` 는 `denyScoped(req,res)` 를 먼저 부른다.
 * ⚠ 이벤트에는 vcenterId 가 없으므로 **대상 목록(scope 적용)의 key 집합**으로 거른다.
 *   키를 못 붙인 이벤트(장비 단위가 아닌 주기 요약 등)는 범위 계정에 주지 않는다 — 안전한 쪽으로.
 * ⚠ **폴러 상태(`poller`)도 그대로 내보내지 않는다** — `last` 안에 사유별 대수가 있다
 *   (v2.550.3 이 겪은 `status.last.counts` 우회로와 같은 유형).
 */
api.get('/tools/bm-usage/activity', toolsPerm, async (req, res) => {
  const allowed = scopedVcenterIds(req.user, store.get());
  const events0 = bmUsageEvents(Number(req.query.limit) || 100);
  // v2.600 AUTHZ-2600-08: 작업 로그 이벤트의 host(iDRAC·OS 주소)도 비-admin 에는 가린다.
  // v2.601 AUTHZ-2601-01: deviceId·name 이 주소인 이벤트(IP 로 등록한 iDRAC)와 스킴 붙은 host 의 오류 문구도.
  //   ⚠ 범위 절단은 **원문 deviceId** 로 먼저 하고 가림은 그 뒤에 한다(가린 뒤에 대조하면 전부 빠진다).
  const isAdmin = isAdminReq(req);
  let tg = null;
  try { tg = await currentTargets(); } catch { tg = null; }
  const hosts = isAdmin ? [] : await bmAddressHosts(tg);
  const maskEv = (list) => (isAdmin ? list : maskActivityEvents(list, hosts));
  if (!allowed) {
    const poller = isAdmin ? bmUsageStatus({ detail: true }) : maskPollerStatus(stripAckBy(bmUsageStatus({ detail: false }), false), hosts);
    return res.json({ ok: true, poller, events: maskEv(events0), log: scopeFilePaths(bmUsageLogInfo(), req.user), ...(isAdmin ? {} : { addressHidden: true }) });
  }
  // 대상을 못 읽으면 아래에서 전부 걸러진다 — 넓게 여는 쪽으로 실패하지 않는다.
  const keys = new Set(applyScope(tg?.targets || [], allowed).map((x) => t(x.key)));
  const events = events0;
  const shown = maskEv((events || []).filter((e) => keys.has(t(e?.deviceId)) || keys.has(t(e?.key))));
  res.json({
    ok: true,
    poller: { running: bmUsageStatus()?.running ?? null, intervalMs: bmUsageStatus()?.intervalMs ?? null },
    events: shown,
    ...(isAdmin ? {} : { addressHidden: true }),
    // 조용히 빼지 않는다 — 몇 건이 범위 밖이라 빠졌는지 화면이 말할 수 있게.
    omittedOutOfScope: Math.max(0, (events || []).length - shown.length),
    scoped: true,
    log: scopeFilePaths(bmUsageLogInfo(), req.user),
  });
});

/**
 * 귀속 없음 원인 — 등록부·수동 귀속 파일을 읽어 판정한다(장비 왕복 0).
 * ⚠ 읽기 실패는 조용히 삼키지 않는다 — 원인을 못 판정했다는 사실을 화면이 알 수 있게 `error` 로.
 */
async function unassignedInfoFor(tg) {
  const unassigned = (tg.skipped || []).filter((x) => x.reason === 'unassigned');
  if (!unassigned.length) return { total: 0, byCause: {}, samples: [], truncated: 0, assignKeys: 0 };
  try {
    const [{ loadRegistry }, { loadFleetAssign }] = await Promise.all([
      import('../../idrac/registry.js'), import('../../insights/fleetAssign.js'),
    ]);
    return unassignedCauses({
      unassigned,
      registry: (() => { try { return loadRegistry(); } catch { return []; } })(),
      assign: (() => { try { return loadFleetAssign(); } catch { return {}; } })(),
      vcenterIds: (tg.vcenters || []).map((v) => v.id),
    });
  } catch (e) {
    return { total: unassigned.length, byCause: {}, samples: [], truncated: 0, assignKeys: 0, error: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * 엣지 보관분 — **네트워크에 나가지 않는다**(v2.554). 중앙이 이미 당겨 둔 값만 보여준다.
 * 사용자 지시 "엣지에서 종합하고 중앙으로 전달은 중앙에서 조회할때만" 이라 상시 push 가 없으므로,
 * 여기서 폴링하면 그 설계가 무의미해진다 — 화면은 마운트 1회 + 버튼(v2.508 규약).
 */
api.get('/tools/bm-usage/edges', toolsPerm, async (req, res) => {
  const allowed = scopedVcenterIds(req.user, store.get());
  try {
    const { listEdgeBmUsage, MIN_EDGE_VERSION, STALE_MS } = await import('../../central/bmUsageEdgePull.js');
    const { loadCollectors } = await import('../../collector/registry.js');
    const cols = (() => { try { return loadCollectors(); } catch { return []; } })();
    const stored = listEdgeBmUsage();
    const byName = new Map(stored.map((x) => [t(x.agent).toLowerCase(), x]));
    /*
     * ⚠ **등록부를 기준으로 줄을 만든다** — 보관분만 나열하면 '한 번도 당기지 않은 엣지' 가
     *   목록에서 사라져 화면이 '전부 봤다' 는 거짓을 말한다(v2.548 `classifyEdges` 와 같은 판단).
     */
    const isAdmin = isAdminReq(req);
    const edgeUrls = cols.map((c) => t(c.url)).filter(Boolean);
    // v2.601 AUTHZ-2601-01: 엣지 보관분의 대상·최신값·정지 목록도 식별자가 주소인 행을 가린다.
    const regHosts = isAdmin ? [] : await bmAddressHosts(null);
    const rows0 = cols.filter((c) => t(c.name)).map((c) => {
      const rec = byName.get(t(c.name).toLowerCase()) || null;
      const snap = rec?.snap || null;
      // v2.600 AUTHZ-2600-08: 엣지 보관분의 대상도 비-admin 에는 관리 주소를 가린다.
      const targets0 = snap ? applyScope(snap.targets || [], allowed) : [];
      const snapHosts = isAdmin ? [] : [...regHosts, ...targets0.flatMap((x) => [x?.idracHost, x?.osHostName])].filter((h) => typeof h === 'string' && h);
      const em = addressMatcher(snapHosts);
      const targets = isAdmin ? targets0 : targets0.map((x) => maskTargetAddress(x, snapHosts, em));
      const keys = new Set(targets0.map((x) => t(x.key)));
      return {
        agent: c.name, enabled: c.enabled !== false, hasUrl: !!t(c.url),
        at: rec?.at || null, snapAt: rec?.snapAt || null,
        // 실패 사유 문구에는 엣지 URL 이 실릴 수 있다 — 비-admin 에는 가린다(범위 계정은 아래에서 통째로 비운다).
        lastAttempt: rec?.lastAttempt
          ? (isAdmin ? rec.lastAttempt : { ...rec.lastAttempt, reason: scrubHosts(rec.lastAttempt.reason, edgeUrls) })
          : null,
        // ⚠ 엣지가 말한 이름을 **나란히** 둔다(다르면 그 자체가 진단 — v2.548 F5·v2.549 규약).
        reportedAgent: snap?.node?.agent || '', version: snap?.node?.version || '',
        enabledOnEdge: snap ? !!snap.enabled : null,
        /*
         * ⚠⚠ v2.574 SEC-03 — **같은 객체 리터럴 안에서 일부 필드만 거르면 안 된다.**
         *   `counts`·`skippedCounts` 는 `!allowed` 로 올바로 막고 있었는데 바로 옆의
         *   `settings`·`authStops` 는 무필터라 범위 제한 계정에 다른 법인 정보가 나갔다:
         *     · `settings.corps` = **수집을 켠 법인 목록**(그 자체가 조직 구성이다)
         *     · `authStops[].key` = 정지 대상 서버 키(`<agent>|os|<key>`)
         *   v2.550.3 이 `status.last.counts.byReason` 에서 이미 겪은 것과 **같은 유형**이다
         *   ("scope 를 고칠 때는 그 데이터가 응답에 실리는 경로를 **전부** 찾을 것").
         */
        settings: scopeEdgeSettings(snap?.settings, allowed),
        targets, rows: snap ? (isAdmin ? (l) => l : (l) => maskBmList(l, em))((snap.rows || []).filter((r) => keys.has(t(r.key)))) : [],
        counts: snap && !allowed ? (snap.counts || {}) : null,
        skippedCounts: snap && !allowed ? (snap.skippedCounts || {}) : null,
        truncated: snap?.truncated || 0,
        // v2.919: 엣지가 판정한 성능 항목 — 보이는 대상의 것만 · 목록에는 code 표만(근거·장치별은 /tools/bm-usage/perf/:key) · 기준값은 그 엣지 설정.
        perf: snap ? (isAdmin ? (l) => l : (l) => maskBmList(l, em))((snap.perf || []).filter((p) => keys.has(t(p.key))).map(compactPerf)) : [],
        perfThresholds: snap?.perfThresholds || null,
        perfTruncated: snap?.perfTruncated || null,
        // 정지 목록은 **보이는 대상의 것만** — 키가 곧 범위 밖 서버의 식별자다.
        authStops: (isAdmin ? (l) => l : (l) => maskBmList(l, em))((snap?.authStops || []).filter((a) => !allowed || keys.has(t(a?.key)))),
      };
    });
    /*
     * v2.600 AUTHZ-2600-07: 엣지는 vCenter 귀속이 없다 — 범위 제한 계정에는 **자기 범위 대상이 보이는
     *   엣지 행만** 주고, 그 행의 인출 시도 기록(lastAttempt — 엣지 전체의 운영 정보)은 비운다.
     *   예전에는 대상이 0개인 엣지까지 전 사이트 이름·버전·시도 결과가 그대로 나갔다. 뺀 개수는 밝힌다.
     */
    const rows = allowed ? rows0.filter((r) => r.targets.length > 0).map((r) => ({ ...r, lastAttempt: null })) : rows0;
    res.json({
      ok: true, at: Date.now(), rows, minEdgeVersion: MIN_EDGE_VERSION, staleMs: STALE_MS,
      ...(allowed ? { scoped: true, edgesOmitted: rows0.length - rows.length } : {}),
      ...(isAdmin ? {} : { addressHidden: true }),
    });
  } catch (e) {
    res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
  }
});

/**
 * 엣지에서 지금 당긴다(사람이 누를 때만). 상태를 바꾸지는 않지만 **외부로 나가는 동작**이라
 * writeRole + 감사. ⚠ 연타 방지는 엣지당 한 번에 하나(중앙 인메모리 플래그).
 */
const _pulling = new Set();
/*
 * v2.613 RUNTIME2613-03(a): 엣지 인출은 순차 for 였고 총 예산이 없었다 — 최악 40곳 × (20초 × 재시도 1) 은 웹 시한
 *   (`api.js MUT_TIMEOUT_MS` 180초)을 넘긴다(웹은 한 번에 한 엣지만 보내지만 API 직접 호출은 40곳까지 받는다).
 *   `poolSettled`(동시 4) + 총 예산 — 남은 예산이 한 엣지의 최악 시간보다 적으면 시작하지 않고 `budget` 으로 밝힌다.
 *   ⚠ 예산은 웹 시한보다 작아야 한다(같거나 크면 화면이 먼저 끊긴다).
 */
api.post('/tools/bm-usage/edges/pull', writeRole, toolsPerm, async (req, res) => {
  // ⚠ 엣지 목록·보관분에는 다른 법인 서버가 섞여 있다 — 당기는 동작은 **전체 범위 계정만**.
  if (scopedVcenterIds(req.user, store.get())) {
    return res.status(403).json({ ok: false, requiredOwner: true, reason: '엣지 인출은 전체 범위 계정만 할 수 있습니다(엣지는 법인 축으로 나눌 수 없습니다).' });
  }
  const agents = Array.isArray(req.body?.agents) ? req.body.agents.map(t).filter(Boolean).slice(0, 40) : [];
  if (!agents.length) return res.status(400).json({ ok: false, reason: '가져올 엣지 이름이 필요합니다.' });
  try {
    const { pullBmUsage } = await import('../../central/bmUsageEdgePull.js');
    const deadline = Date.now() + EDGE_PULL_BUDGET_MS;
    let budgetExceeded = 0;
    const settled = await poolSettled(agents, EDGE_PULL_CONCURRENCY, async (a) => {
      if (_pulling.has(a.toLowerCase())) return { agent: a, ok: false, kind: 'busy', reason: '이 엣지에서 이미 가져오는 중입니다.' };
      if (Date.now() + EDGE_PULL_WORST_MS > deadline) {
        budgetExceeded += 1;
        return { agent: a, ok: false, kind: 'budget', reason: '인출 시간 예산을 넘겨 이번에는 시도하지 않았습니다 — 다시 누르면 이어서 가져옵니다.' };
      }
      _pulling.add(a.toLowerCase());
      // v2.628(EDGE2628-01): limit 을 주지 않으면 엣지 기본(400대)에서 잘렸다 — ESXi 포함으로 대상이 늘었다. 기본을 상한(2,000)으로.
      try { return { agent: a, ...(await pullBmUsage(a, { limit: Number(req.body?.limit) || 2_000 })) }; }
      finally { _pulling.delete(a.toLowerCase()); }
    });
    // 입력 순서 보존(poolSettled) — 예전 순차 for 와 같은 순서로 응답한다.
    const results = settled.map((x, i) => (x.status === 'fulfilled' ? x.value : { agent: agents[i], ok: false, kind: 'error', reason: String(x.reason?.message || x.reason).slice(0, 300) }));
    logAudit({
      user: req.user?.username, action: 'bm-usage.edge-pull', ip: req.ip || '',
      detail: JSON.stringify({ agents: agents.length, ok: results.filter((r) => r.ok).length }).slice(0, 300),
    });
    // ⚠ 응답에 `rec.snap` 을 담지 않는다(수 백 KB) — 화면은 `/edges` 로 다시 읽는다.
    res.json({ ok: true, results: results.map(({ agent, ok, kind, reason, ms }) => ({ agent, ok, kind, reason, ms })), budgetExceeded });
  } catch (e) {
    res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
  }
});

function safeKnownAgents() { try { return knownAgentNames(); } catch { return []; } }

/**
 * v2.627 엣지 배포(사용자 요청 "한번에 켜는 기능") — 켬/끔 + 엣지별 제외. 배포되는 값은 이 중앙의 설정 자체다(따로 두 벌을 두지 않는다).
 * 엣지는 다음 인출(기본 10분 주기)에 받는다 — 응답이 그 사실과 주기를 말한다(즉시 반영된 척하지 않는다).
 */
api.put('/tools/bm-usage/distribute', adminOnly, fleetOnly, (req, res) => {
  const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const patch = {};
  if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
  if (b.excluded && typeof b.excluded === 'object' && !Array.isArray(b.excluded)) patch.excluded = b.excluded;
  const next = saveDistribution(patch, String(req.user?.username || ''));
  logAudit({ user: req.user?.username, action: 'bm-usage.distribute', ip: req.ip || '',
    detail: JSON.stringify({ enabled: next.enabled, excluded: Object.keys(next.excluded).length }).slice(0, 300) });
  res.json({ ok: true, distribution: distributionStatus(safeKnownAgents()) });
});

/** 설정 — 법인 on/off·주기·보존. 수집 범위를 바꾸는 동작이라 admin 전용 + 감사. */
api.put('/tools/bm-usage/settings', adminOnly, (req, res) => {
  /*
   * ⚠⚠ **Enterprise 대체 수집 동의는 '누가·언제' 를 기록한다**(v2.554 — 사용자 지시 "사용할
   *   것이냐고 물어보고 사용하겠다고 하면"). 장비에 부하를 더하는 결정이라 근거를 남긴다.
   * ⚠ 동의를 서버가 대신 켜지 않는다 — 본문에 `enterpriseAck:true` 가 와야 한다
   *   (`normalizeSettings` 가 `enabled && ack` 로 못 박는다).
   */
  const prev = loadBmUsageSettings();
  // v2.607 AUTHZ2607-05: 범위 계정은 법인(corps) 키만 바꿀 수 있다 — 주기·보존일·임계·Enterprise 동의 같은 전역 필드는
  //   전 법인 공용이라 버리고 응답에 밝힌다(예전에는 범위 admin 이 보존일을 하한으로 내려 다른 법인 이력을 지웠다).
  const kg = keepScopedFields(req.body || {}, prev, scopedVcenterIds(req.user, store.get()), ['corps', 'corpsScoped']);
  const body = kg.patch;
  if (body.enterpriseAck === true && !prev.enterpriseAck) {
    body.enterpriseAckAt = Date.now();
    body.enterpriseAckBy = String(req.user?.username || '').slice(0, 64);
  }
  // v2.605 AUTHZ2605-01: 범위 제한 admin 의 GET 은 corps 를 자기 범위로 거른다(scopeMainSettings) —
  //   그 값을 펼쳐 PUT 하면 다른 법인의 수집이 꺼졌다. 범위 밖 법인은 직전 값을 보존한다.
  const allowed = scopedVcenterIds(req.user, store.get());
  let ignoredOutOfScope = [];
  if (allowed && body.corps !== undefined) {
    const m = mergeScopedMap(prev.corps, body.corps, allowed); body.corps = m.merged; ignoredOutOfScope = m.ignored;
  }
  delete body.corpsScoped;
  const next = saveBmUsageSettings(body);
  logAudit({
    user: req.user?.username, action: 'bm-usage.settings', ip: req.ip || '',
    detail: JSON.stringify({
      enabled: next.enabled, corps: Object.keys(next.corps).length,
      intervalMs: next.intervalMs, rawRetentionDays: next.rawRetentionDays, dailyRetentionDays: next.dailyRetentionDays,
      // v2.551 — 수집 범위·알림을 바꾸는 동작이라 감사에 남긴다.
      idracFullTelemetry: next.idracFullTelemetry, alertEnabled: next.alertEnabled,
      // v2.554 — 장비 부하를 더하는 결정이라 감사에 남긴다(동의 여부·모드).
      enterpriseEnabled: next.enterpriseEnabled, enterpriseAck: next.enterpriseAck, enterpriseMode: next.enterpriseMode,
      alertPct: next.alertPct, alertSustainMin: next.alertSustainMin, alertRepeatHours: next.alertRepeatHours,
    }).slice(0, 300),
  });
  // v2.583 #36: 비어 있어 **저장하지 않은** 숫자 칸을 밝힌다(조용히 버리면 '저장했는데 왜 그대로지' 가 된다).
  const { dropped } = dropUnspecifiedNumbers(req.body || {});
  // PUT 응답도 GET 과 같은 필터(범위 계정에는 자기 범위 corps 만 · 비-admin 가림은 adminOnly 라 해당 없음).
  res.json({ ok: true, settings: scopeMainSettings(next, allowed, true), ...(next.ignoredCentralManaged ? { ignoredCentralManaged: next.ignoredCentralManaged } : {}), ...(dropped.length ? { ignoredBlank: dropped } : {}), ...(ignoredOutOfScope.length ? { ignoredOutOfScope: ignoredOutOfScope.length } : {}), ...ignoredGlobalFields(kg.ignoredGlobal) });
});

}
