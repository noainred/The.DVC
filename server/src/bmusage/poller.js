/**
 * bmusage/poller.js — 베어메탈 사용률 주기 수집(v2.550).
 *
 * ── CLAUDE.md 폴러 규약을 전부 지킨다 ───────────────────────────────────────
 *  ① **재진입 가드** — 이전 주기가 주기를 넘기면 이번 틱을 건너뛴다. 수동 실행('지금 수집')도
 *     **같은 가드를 공유**한다(연타가 SSH·Redfish 세션을 곱하지 않게 — `net/monitor` 패턴).
 *  ② **동시 수집 제한**(`BMUSAGE_CONCURRENCY` 기본 32 — v2.918, 이전 4) — 200대를 한꺼번에 찌르면 매 주기 SSH
 *     핸드셰이크가 몰려 CPU·회선이 순간 포화된다.
 *  ③ **서버당 타임아웃은 세션을 실제로 끊는다**(`withDeadline` + `signal` — v2.417). `Promise.race`
 *     로 결과만 포기하면 SSH 세션이 남아 동시성 상한이 실효를 잃고 다음 주기가 두 번째 세션을 연다.
 *  ④ **`startAdaptiveTimer`** — 주기를 매 틱 다시 읽는다(설정을 바꿔도 재시작이 필요 없게).
 *  ⑤ **prune 스로틀은 `(++tick % N) === 0`** — 기동 첫 틱에 즉시 참이 되면 안 된다(v2.453).
 *
 * ⚠ **인증 실패(401/403)로 주기 수집을 멈추는 가드를 붙였다**(`util/authGuard.js` — v2.535 규약).
 *   SSH 계정이 틀리면 5분마다 로그인 실패가 쌓여 **계정이 잠긴다**. 멈추는 것은 401/403 계열뿐이고
 *   (타임아웃·연결 실패로 멈추면 일시 장애가 수집을 영구 정지시킨다) 자격증명이 바뀌면 자동 재개한다.
 *   **수동 실행은 막지 않는다** — 고쳤는지 확인할 길을 없애면 안 된다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createChangeLogger } from '../util/logThrottle.js'; // v2.604
import { corruptOnlyReason, summarizeRegistryError } from '../util/registryCore.js';
import { safeLoadText } from '../util/atomicWrite.js'; // v2.744(최종 검토 FB): 등록부 읽기 예외 문구도 원문 조각 없이
import { config } from '../config.js';
import { store } from '../store.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { withDeadline } from '../proxy/sshExec.js';
import { createAuthGuard, isAuthFailureText } from '../util/authGuard.js';
import { loadBmUsageSettings, bmUsageEnabled, enterpriseActive, onBmUsageSettingsChange, STORE_DEFAULTS, effectiveRawDays, SNAPSHOT_KEEP_DAYS } from './settings.js';
import { withResolvedAuth, authCredOf } from './onboard/refs.js'; // 7b: OS 등록 항목의 키 · 공통 계정 참조 → 접속 자격
import { resolveTargets } from './targets.js';
import { enterpriseEligible } from './license.js';
import { collectEnterpriseUsage, SESSION_BUDGET_MS as ENT_BUDGET_MS } from './collectors/idracEnterprise.js';
import { buildUsage } from './usage.js';
import { recordHbaBasis, pruneHbaBasis } from './hbaBasis.js'; // v2.744(감사 LEFT-08 ②): HBA 사용률 분모 근거(화면 각주)
import { collectOsUsage, SESSION_BUDGET_MS as OS_BUDGET_MS } from './collectors/osSsh.js';
import { insertUsage, pruneUsage, repairRollups, snapshotPrune } from './db.js';
import { ensureMonthMigration, migrationLast } from './monthMigrate.js';
import { estimateBaseMs, planCycleWindow } from './peakPlan.js'; // v2.922: 피크 창 주기 예산 자동 맞춤
import { recordBmUsage } from './activityLog.js';
import { runBmUsageAlerts, alertStateInfo } from './notify.js';
import { isMockMode } from '../mock/demo/flags.js'; // v2.708: 데모(mock)는 장비에 접속하지 않고 합성 행
import { poolSettled } from '../util/pool.js'; // v2.579: 동시성 풀 단일 소스
import { numOrNull } from '../util/numOrNull.js';
import { capStr } from '../util/capStr.js'; // v2.744(RV2744F-WEB-03): 상주 상세 문자열 평탄화
import { idracAuthStopFor as mainIdracAuthStopFor, releaseIdracAuthStop } from '../idrac/poller.js'; // v2.590: 같은 iDRAC 계정을 쓰는 주 폴러의 인증 실패 정지
import { withSlot, configureSlots, slotPeakReset } from './slots.js'; // v2.929(5단계): 전역 동시성 풀 — 집중 수집과 슬롯을 나눠 쓴다 · 6단계: 주기 최대 사용(수집 건강)
import { summarizeCycle, dbFilesNow, collectCells } from './collectHealth.js'; // 6단계 수집 건강(메타 모니터링)
import { focusActiveCount, focusQueuedCount, registerFocusPollerHooks, focusHousekeeping, onFocusEnd, initFocus } from './focus/run.js'; // v2.929: 피크 창 예산에서 활성 집중 수만큼 동시성을 뺀다

/*
 * v2.918(사용자 결정 2026-11-06 "동시성을 32개로 늘려줘"): 기본 4 → 32. 1,000대 법인에서 동시 4 · 서버당 ~5초면 한 주기에 약 21분이
 * 걸려 재진입 가드 때문에 실제 주기가 5분이 아니라 20분 이상으로 늘어났다. 32 면 같은 조건에서 약 2.6분. env 로 낮출 수 있다(상한 없음 —
 * 엣지 자원이 작으면 BMUSAGE_CONCURRENCY=8 처럼). 회귀 `test/bmUsageConcurrency2918.test.js`.
 */
const CONCURRENCY = Math.max(1, Number(process.env.BMUSAGE_CONCURRENCY) || 32);
configureSlots({ capacity: CONCURRENCY }); // v2.929: 집중 수집과 나눠 쓰는 전역 슬롯 용량 = 이 값(단일 원천)
const DEVICE_TIMEOUT_MS = Math.max(20_000, Number(process.env.BMUSAGE_DEVICE_TIMEOUT_MS) || 60_000);
/**
 * v2.613 RUNTIME2613-05: '세션 예산 < 장비 시한' 은 v2.550.3·v2.554 가 **기본값 산수**로만 지킨 관계였다 — 세 env
 * (`BMUSAGE_DEVICE_TIMEOUT_MS`·`BMUSAGE_SESSION_BUDGET_MS`·`BMUSAGE_ENT_BUDGET_MS`)가 독립이라 장비 시한 하나를 30초로
 * 낮추면 OS 예산 50초 안의 두 번째 시도를 `withDeadline` 이 먼저 끊어 결과가 통째로 버려졌다(v2.550.3 이 고친 결함의 env
 * 재발 경로). 기동 시 예산을 **장비 시한 − 여유** 로 자르고(순수 함수 `coupleBudget`), 잘랐으면 콘솔에 1줄 남기며
 * `bmUsageStatus()` 가 세 값을 밝힌다. 예산의 하한은 각 수집기가 시도를 시작할 수 있는 최소(OS `MIN_SLICE_MS`·ENT 핸드셰이크)다.
 */
export const BUDGET_MARGIN_MS = 5_000;
export function coupleBudget(wantedMs, deviceMs, floorMs) {
  const cap = Math.max(floorMs, deviceMs - BUDGET_MARGIN_MS);
  const effective = Math.min(wantedMs, cap);
  return { effective, clamped: effective < wantedMs, cap };
}
const OS_BUDGET = coupleBudget(OS_BUDGET_MS, DEVICE_TIMEOUT_MS, 10_000);
const ENT_BUDGET = coupleBudget(ENT_BUDGET_MS, DEVICE_TIMEOUT_MS, 15_000);
for (const [name, b, wanted] of [['OS(BMUSAGE_SESSION_BUDGET_MS)', OS_BUDGET, OS_BUDGET_MS], ['iDRAC 대체(BMUSAGE_ENT_BUDGET_MS)', ENT_BUDGET, ENT_BUDGET_MS]]) {
  if (b.clamped) console.warn(`[bmusage] ${name} 세션 예산 ${Math.round(wanted / 1000)}초가 장비 시한(BMUSAGE_DEVICE_TIMEOUT_MS ${Math.round(DEVICE_TIMEOUT_MS / 1000)}초) − ${BUDGET_MARGIN_MS / 1000}초 를 넘어 ${Math.round(b.effective / 1000)}초로 줄였습니다 — 예산이 시한보다 크면 두 번째 시도 결과가 버려집니다(v2.613 RUNTIME2613-05)`);
}
const PRUNE_EVERY = 12;
/**
 * ⚠⚠ **주기당 '리포트 목록 조회' 예산**(v2.551). 텔레메트리 전수 모드는 장비마다 목록을 한 번
 *   열거해야 하는데(그 뒤 6시간 캐시), 200대가 **같은 주기에** 열거하면 왕복이 주기(300초)를
 *   꽉 채운다(`redfish.js` 예산 계산 주석의 실제 산수). 주기당 이 수만 허용해 점진적으로 채운다 —
 *   목록이 없는 장비는 그 주기에 `SystemUsage` 만 읽으므로 **v2.550 과 같은 비용**이고 값도 나온다.
 *   이 예산을 없애면 첫 주기가 주기를 넘겨 재진입 가드가 다음 틱을 계속 건너뛴다.
 */
const LIST_BUDGET_PER_RUN = Math.max(1, Number(process.env.BMUSAGE_LIST_BUDGET) || 20);
let _listBudget = 0;
/**
 * ⚠⚠ **주기당 'Enterprise 대체 수집' 예산**(v2.554). 이 경로는 장비당 센서 GET 4회 +
 *   (필요하면) **iDRAC SSH 세션 1개**다. BMC 핸드셰이크는 느려(수 초) 200대에 무제한으로 붙이면
 *   주기(300초)를 넘기고 재진입 가드가 다음 틱을 계속 건너뛴다 — v2.551 의 목록 조회 예산과
 *   같은 판단이다. 실제 산수: 40대 × 약 10초 ÷ 동시 4 = **100초**.
 *   예산을 넘긴 장비는 **사유를 남기고**(조용한 생략 금지) 다음 주기에 시도한다.
 * ⚠ 센서 경로 **탐색**(Chassis + Sensors 열거)은 더 비싸므로 별도 예산을 둔다.
 */
const ENT_BUDGET_PER_RUN = Math.max(1, Number(process.env.BMUSAGE_ENT_PER_RUN) || 40);
const ENT_PROBE_PER_RUN = Math.max(1, Number(process.env.BMUSAGE_ENT_PROBE_PER_RUN) || 10);
let _entBudget = 0;
let _entProbeBudget = 0;
/** 이번 주기에 예산으로 미룬 대수 — 화면이 '왜 아직 안 나오나' 를 말할 수 있게. */
let _entDeferred = 0;

const guard = createAuthGuard({ file: 'bmusage-auth-stops.json' });

let _running = false;
let _last = null;
let _timer = null;
/** 이전 주기의 누적 카운터(인메모리 — 재시작하면 첫 주기가 다시 `null` 이다. 그것이 정직하다). */
const _prev = new Map();

/*
 * ── 서버별 마지막 수집 상세(v2.744 최종 수정분 검토 RV2744F-WEB-03) ─────────────────────────────
 * 화면 상세 카드의 '무엇을 읽었고 무엇을 못 읽었나'(웹 bmUsageText.detailNotes·telemetryNote·entDetailNotes)는 buildUsage().detail
 *   을 입력으로 쓰는데, 그 상세는 DB 에 넣지 않고(usage_latest 열 고정 — 장치 수 × 주기면 행이 폭주한다, v2.550.3) 어떤 응답도 싣지
 *   않아 그 문구가 화면에 한 번도 나오지 않았다(정적 추적 + 반증 2인 재현). buildUsage 의 notes(FC 대표값 경로까지 아는 fcRateNotes
 *   fallback 문구 · 첫 표본 · 간격 초과 · 카운터 이상)도 폴러가 버렸다.
 * 그래서 서버마다 **마지막 수집의 상세를 화면이 쓰는 필드만** 메모리에 둔다(`slimUsageDetail`) — 상세 조회(/tools/bm-usage/history)가
 *   한 서버 것만 싣는다. 주 조회(/tools/bm-usage)에는 싣지 않는다(200대 × 상세면 응답이 수 MB 가 된다).
 *   · 키 = 대상 key(이 노드의 대상 — 엣지는 자기 것만 수집하므로 agent 축이 따로 필요 없다) · 매 주기 대상 목록(live)으로 정리
 *     (dropStaleState — v2.550.3 '인메모리 상태 맵은 대상 목록 기준으로 정리') → 크기 상한 = 대상 수.
 *   · 실패한 수집도 기록한다 — 그 주기의 실패 사유(osError·idracKind …)가 곧 상세다. 수집 자체가 예외로 끝나 상세가 없으면 직전 기록을 둔다.
 *   · ⚠ **재시작하면 비고 다음 수집부터 다시 찬다** — 화면은 그 사실을 상태 코드('none')로 받고 지어내지 않는다.
 *   · 이름·주소를 싣지 않는다: 장치 이름(eth0·host0·FQDD)·센서 이름·Redfish 경로·mounts 는 화면이 개수만 쓰므로 빼고 개수만 둔다.
 *     오류 문구와 racadm 원문(entRaw)은 주소가 섞일 수 있어 라우트가 비-관리자에게 가린다(원문은 아예 싣지 않는다).
 *   · 크기(계산): 문자열·배열 상한을 걸어 서버당 최대 약 30KB(notes 24줄 × 600자 · 원문 2.4KB · 장치 행 128개씩), 보통 2~4KB 다 —
 *     200대면 메모리 약 0.6MB(최악 약 6MB). 상세 조회 응답은 한 서버 것뿐이다.
 */
const _detail = new Map();
/** 이 프로세스가 상세 기록을 시작한 시각 — 화면이 '시작한 뒤 아직 수집하지 않았다' 를 말할 수 있게(지어내지 않는다). */
const DETAIL_SINCE = Date.now();
/** 상세 응답 필드 계약(화면 bmUsageText 가 읽는 것만) — 테스트가 고정한다. 필드를 늘리면 화면이 읽는지 먼저 볼 것. */
export const USAGE_DETAIL_FIELDS = Object.freeze([
  'at', 'ok',
  'osKind', 'osRead', 'osMissing', 'osAbsent', 'osError',
  'idracKind', 'idracError', 'idracUsedIds', 'idracSeenIdCount', 'idracReports', 'idracSeenReports', 'idracSeenReportCount', 'idracAbsent',
  'interfaces', 'fc', 'idracFc',
  'entTried', 'entVia', 'entKind', 'entError', 'entUsedPathCount', 'entUsedCmd', 'entUsedStat', 'entSkipped', 'entSeenSensorCount', 'entRaw',
  'notes',
]);
const DETAIL_ROWS_MAX = 128;
const dStr = (v, max) => (typeof v === 'string' ? capStr(v, max) : '');
const dList = (a, maxN = 40, maxLen = 80) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x).slice(0, maxN).map((x) => capStr(x, maxLen)) : []);
const dCount = (a) => (Array.isArray(a) ? a.length : null);
/** 장치 행(NIC) — 이름 없이 화면이 세는 값만(속도를 읽었나 · 가상인가 · 처리량). */
const dIf = (x) => (x && typeof x === 'object'
  ? { bps: numOrNull(x.bps ?? x.bytesPerSec), bitsPerSec: numOrNull(x.bitsPerSec), pct: numOrNull(x.pct), ...(x.virtual ? { virtual: true } : {}) }
  : null);
/** 장치 행(FC) — 이름 없이 판정 필드만(fcNominalRestKind·FC 문구가 쓰는 것). */
const dFc = (x) => (x && typeof x === 'object'
  ? {
    bps: numOrNull(x.bps), pct: numOrNull(x.pct), pctBasis: typeof x.pctBasis === 'string' ? capStr(x.pctBasis, 16) : null,
    ...(x.pctOver ? { pctOver: true } : {}), ...(x.pctClamped ? { pctClamped: true } : {}), ...(x.countersInvalid ? { countersInvalid: true } : {}),
  }
  : null);
const dRows = (a, fn) => (Array.isArray(a) ? a.slice(0, DETAIL_ROWS_MAX).map(fn).filter(Boolean) : []);
/** 짧은 이름 → 짧은 값 맵(메트릭 id · 읽은 열). '__' 로 시작하는 내부 키(usedIds.__seenMetricIds — 배열)는 뺀다. */
function dMap(o, maxN = 20) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(o)) {
    if (n >= maxN || typeof k !== 'string' || k.startsWith('__')) continue;
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    out[capStr(k, 40)] = capStr(v, 80); n += 1;
  }
  return n ? out : null;
}

/**
 * buildUsage() 결과 → 화면 상세(순수 — 원본을 바꾸지 않는다). 필드는 `USAGE_DETAIL_FIELDS` 그대로다.
 * @param {{detail?:object, notes?:string[]}} built
 * @param {{at?:number|null, ok?:boolean}} [o]
 */
export function slimUsageDetail(built, { at = null, ok = false } = {}) {
  const d = built?.detail && typeof built.detail === 'object' ? built.detail : {};
  return {
    at: numOrNull(at), ok: !!ok,
    osKind: dStr(d.osKind, 16) || null,
    osRead: dList(d.osRead), osMissing: dList(d.osMissing), osAbsent: dList(d.osAbsent), osError: dStr(d.osError, 300),
    idracKind: dStr(d.idracKind, 40), idracError: dStr(d.idracError, 300),
    idracUsedIds: dMap(d.idracUsedIds),
    idracSeenIdCount: dCount(d.idracSeenIds),
    // 리포트 id 는 Dell 의 일반 리포트 이름(SystemUsage·NICStatistics …)이라 그대로 둔다 — 화면이 앞 5개를 이름으로 보인다.
    idracReports: dList(d.idracReports, 60), idracSeenReports: dList(d.idracSeenReports, 100), idracSeenReportCount: dCount(d.idracSeenReports),
    idracAbsent: dList(d.idracAbsent),
    interfaces: dRows(d.interfaces, dIf), fc: dRows(d.fc, dFc), idracFc: dRows(d.idracFc, dFc),
    entTried: dList(d.entTried, 8, 16), entVia: dStr(d.entVia, 16), entKind: dStr(d.entKind, 60), entError: dStr(d.entError, 300),
    entUsedPathCount: d.entUsedPaths && typeof d.entUsedPaths === 'object' ? Object.keys(d.entUsedPaths).length : null,
    entUsedCmd: dStr(d.entUsedCmd, 120), entUsedStat: dMap(d.entUsedStat),
    entSkipped: (Array.isArray(d.entSkipped) ? d.entSkipped : []).slice(0, 10)
      .filter((x) => x && typeof x === 'object').map((x) => ({ step: dStr(x.step, 16), reason: dStr(x.reason, 300) })),
    entSeenSensorCount: dCount(d.entSeenSensors),
    entRaw: dStr(d.entRaw, 2_400),
    // buildUsage 의 노트 — FC 대표값을 실제로 정한 경로(fcRateNotes fallback)까지 아는 문구라 화면이 그대로 쓴다(웹 detailNotes 가 겹치는 줄을 양보한다).
    notes: dList(built?.notes, 24, 600),
  };
}

/** 한 서버의 마지막 수집 상세를 기록한다(collectOne — 실패 주기도). */
function recordUsageDetail(key, built, { at = null, ok = false } = {}) {
  if (!key || !built) return;
  _detail.set(key, { state: 'ok', detail: slimUsageDetail(built, { at, ok }) });
}

/**
 * 상세 조회용(라우트) — `{ state, detail, since }`. state: 'ok'(기록 있음) · 'none'(이 프로세스가 시작한 뒤 아직 수집하지 않음) ·
 *   'demo'(데모 대상 — 합성 행이라 장치 상세가 없다). 사본을 준다(라우트가 가림을 덧대도 기록이 바뀌지 않게).
 */
export function usageDetailFor(key) {
  const rec = key ? _detail.get(key) : null;
  if (!rec) return { state: 'none', detail: null, since: DETAIL_SINCE };
  return { state: rec.state, detail: rec.detail ? JSON.parse(JSON.stringify(rec.detail)) : null, since: DETAIL_SINCE, ...(rec.at ? { at: rec.at } : {}), ...(rec.maintSkip ? { maintSkip: { ...rec.maintSkip } } : {}) };
}

/**
 * @param {{detail?:boolean}} [o]  detail = 등록부 로드 오류 사유의 위치(줄·칸)까지 싣는가(v2.744 최종 검토 FB — RD-R1·RG2744-03).
 *   거짓이면 sourceErrors 의 등록부 항목을 분류 고정 문구로만 싣는다(sourceErrorsView). 기본값은 가리는 쪽이다(거부 기본값 —
 *   fleetPartialsSummary 와 같은 규칙). 관리자 + 전체 범위 응답(routes/api/bmUsage.js — isAdminReq)만 참으로 준다.
 *   ⚠ 어느 쪽이든 원문(JSON.parse 메시지의 파일 조각)은 없다 — 원문은 _last 에 들어가지 않는다(registrySourceError).
 */
export function bmUsageStatus({ detail = false } = {}) {
  const s = loadBmUsageSettings();
  const st = {
    enabled: bmUsageEnabled(), running: _running, intervalMs: s.intervalMs, ...(isMockMode() ? { demo: true } : {}),
    concurrency: CONCURRENCY, deviceTimeoutMs: DEVICE_TIMEOUT_MS,
    // v2.613 RUNTIME2613-05: 실제로 쓰는 예산(장비 시한과 묶인 값)과 잘랐는지.
    osBudgetMs: OS_BUDGET.effective, osBudgetClamped: OS_BUDGET.clamped, entBudgetEffectiveMs: ENT_BUDGET.effective, entBudgetClamped: ENT_BUDGET.clamped, budgetMarginMs: BUDGET_MARGIN_MS,
    rawRetentionDays: s.rawRetentionDays, dailyRetentionDays: s.dailyRetentionDays,
    idracFullTelemetry: !!s.idracFullTelemetry, listBudgetPerRun: LIST_BUDGET_PER_RUN,
    // v2.554 — Enterprise 대체 수집(동의 기반). 화면이 부하·예산을 말할 수 있게 그대로 낸다.
    enterpriseActive: enterpriseActive(s), enterpriseMode: s.enterpriseMode,
    enterpriseAck: !!s.enterpriseAck, enterpriseAckAt: s.enterpriseAckAt || 0, enterpriseAckBy: s.enterpriseAckBy || '',
    entBudgetPerRun: ENT_BUDGET_PER_RUN, entProbePerRun: ENT_PROBE_PER_RUN,
    entBudgetMs: ENT_BUDGET_MS, entDeferred: _entDeferred,
    alertEnabled: !!s.alertEnabled, alertPct: s.alertPct, alertSustainMin: s.alertSustainMin,
    alertRepeatHours: s.alertRepeatHours, alertState: alertStateInfo(),
    /*
     * ⚠⚠ **`last` 에 `counts` 를 싣지 않는다**(v2.550.3 에 고친 결함): v2.550.1 이 응답의
     *   `skippedCounts`·`counts` 를 scope 로 걸렀는데, `status.last.counts.byReason` 경로로
     *   **같은 정보가 무스코프로 그대로 나갔다**(범위 계정이 다른 법인의 베어메탈 대수와 사유
     *   분포를 알 수 있다 — server/CLAUDE.md '범위 밖 요약은 범위 계정에 노출하지 않는다').
     *   개수는 라우트가 보이는 목록에서 다시 세어 내보낸다. 여기서는 '몇 대를 돌았나' 만 남긴다.
     */
    last: _last ? (({ counts: _c, ...rest }) => rest)(_last) : null,
    prevKeys: _prev.size,
    authStopCount: _authStopped.size,
    lastPrune: _lastPrune,
    migration: migrationLast(),   // v2.922: 마지막 마이그레이션 실행(단계·실패 사유 — 개수만, 서버 이름 없음)
    peakPlan: _peakPlan,          // v2.922: 피크 창 주기 예산 결정(수집 건강 ⑫ — 개수·ms 만)
    rollupRepair: _lastRepair,    // v2.922(반증 D5): 마지막 롤업 보정(다시 집계한 버킷 수 · 실패)
  };
  // v2.744(최종 검토 FB): 등록부 로드 오류 사유는 detail 일 때만 위치(줄·칸)까지 — 그 밖에는 분류 문구(sourceErrorsView).
  if (st.last && Array.isArray(st.last.sourceErrors)) st.last = { ...st.last, sourceErrors: sourceErrorsView(st.last.sourceErrors, { detail }) };
  return st;
}

/**
 * 지금 **인증 실패로 정지된** 대상 목록. ⚠ 인메모리 맵(`_authStopped`)은 재시작하면 비므로
 * 그것만 보고 '정지 0건' 이라 말하면 **조용한 정지**가 된다(v2.528 규약: "조용히 멈추지 않는다").
 * `authGuard` 는 파일에 남기므로 **대상마다 다시 물어본다**(자격증명이 바뀐 대상은 그 함수가
 * 스스로 기록을 지우고 null 을 준다 = 자동 재개).
 */
export function authStopsFor(targets = []) {
  const out = [];
  for (const tg of targets) {
    // ⚠ 두 경로를 **각각** 보고한다(`path` 로 구분) — 뭉치면 사용자가 엉뚱한 비밀번호를 고친다.
    for (const [path, dev] of [['os', authDev(tg)], ['idrac', authDevIdrac(tg)]]) {
      if (!dev) continue;
      // v2.590: iDRAC 경로는 **주 iDRAC 폴러의 정지**도 함께 본다 — 같은 계정이라 그쪽이 멈췄으면
      //   이쪽도 시도하지 않는다(아래 collectOne). 화면이 그 정지를 말하지 않으면 조용한 정지다.
      const rec = guard.authStopFor(dev) || (path === 'idrac' ? mainIdracStop(tg) : null);
      if (rec) out.push({ key: tg.key, name: tg.name, vcenterId: tg.vcenterId || '', path, ...rec });
    }
  }
  return out;
}

/*
 * v2.628(감사 EDGE2628-03): 대상 해석 입력(분류·iDRAC 등록부·OS 계정 등록부) 실패를 **조용히 빈 값으로 삼키지 않는다**.
 *   예전에는 분류 예외가 '대상 서버가 없습니다', 등록부 손상이 전 서버 'no-idrac'/'no-os-cred'(설정 누락처럼 읽히는
 *   틀린 사유)로 보였고 `_last` 에도 콘솔에도 흔적이 없었다. 이제 `sourceErrors[{source,error}]` 로 모아 돌려주고
 *   (routes/api/corpUsage.js 의 sourceErrors 와 같은 모양) 폴러가 `_last` 에 싣고 콘솔에 남긴다(같은 내용은 10분에 1줄).
 *   분류 자체가 실패하면 `classifyFailed` — 폴러는 그 주기를 '대상 0대' 가 아니라 **실패**로 기록한다.
 */
const _srcErrLog = createChangeLogger({ windowMs: 10 * 60_000 });
let _fleetOverride = null;   // 테스트 전용(_setFleetForTest)
const errText = (e) => String(e?.message || e || 'unknown').slice(0, 200);

/*
 * v2.744(최종 검토 FB — RD-R1·RG2744-03): 등록부 로드 오류는 **원문이 아니라 요약**으로 싣는다. `registryLoadError().reason` 은 V8 JSON.parse
 *   메시지라 오류 위치 앞뒤 파일 조각(`..."assword": SuperSecre"...` — 손상된 OS 계정 등록부의 평문 비밀번호 앞부분)을 싣는데, sourceErrors 는
 *   _last → GET /tools/bm-usage 상태(operator 는 tools 를 기본 보유)·지금 수집 응답·콘솔·엣지 로그로 나간다. 요약은 summarizeRegistryError 한 벌이고
 *   (GD-R1 fleetPartials 와 같은 규칙) 관리자용 문장(위치 숫자 포함)을 항목에, 그 밖의 계정용 문장(분류 고정 문구)을 SRC_LABEL 에 둔다 —
 *   항목 모양({source, error})은 그대로라 화면(bmUsageText.sourceErrorsNote)이 바뀌지 않는다. 원문은 그 노드의 보존본 파일에 있다.
 */
const SRC_LABEL = new WeakMap();
/** @param {string} source  @param {(why:string)=>string} sentence  @param {any} err  registryLoadError() 값(또는 사유 문자열) */
export function registrySourceError(source, sentence, err) {
  const e0 = err && typeof err === 'object' ? err : { reason: err == null ? '' : String(err) };
  const sum = summarizeRegistryError(e0) || summarizeRegistryError({ reason: '' });
  const entry = { source, error: sentence(sum.text) };
  SRC_LABEL.set(entry, sentence(sum.label));
  return entry;
}
/**
 * sourceErrors 의 응답 모양(순수 — 원본을 바꾸지 않는다). detail 이 거짓이면 등록부 항목을 분류 고정 문구로 바꾼다. 그 밖의 항목은 그대로.
 *   관리자 + 전체 범위 응답만 detail:true(호출부가 isAdminReq 로 판정). 원소가 객체가 아니면 그대로 둔다(화면이 거른다).
 */
export function sourceErrorsView(list, { detail = false } = {}) {
  if (!Array.isArray(list)) return list;
  return list.map((x) => {
    if (!x || typeof x !== 'object') return x;
    if (detail || !SRC_LABEL.has(x)) return { ...x };
    return { ...x, error: SRC_LABEL.get(x) };
  });
}
const IDRAC_REGISTRY_FILE = () => path.join(config.configDir, 'idrac.json');

/** 대상 해석 — 스냅샷·등록부를 읽어 온다(장비에 접속하지 않는다). */
export async function currentTargets() {
  const snap = store.get();
  // v2.708: 데모(mock)는 판정 지점에서만 '켜짐 · 전 법인 선택' 으로 덮는다(설정 파일은 그대로).
  const saved = loadBmUsageSettings();
  const demoMod = isMockMode() ? await import('../mock/demo/baremetal.js') : null;
  const s = demoMod ? demoMod.demoBmSettings(saved, snap?.vcenters || []) : saved;
  const [{ getFleetInventory }, { loadRegistry }, { listBmServersRaw, registryLoadError: bmRegistryLoadError }, { getInventory }] = await Promise.all([
    import('../insights/fleetInventory.js'), import('../idrac/registry.js'), import('../bmstor/registry.js'),
    import('../idrac/invCache.js'),
  ]);
  const sourceErrors = [];
  let classifyFailed = false;
  const fleet = await (_fleetOverride || getFleetInventory)(snap).catch((e) => {
    classifyFailed = true;
    sourceErrors.push({ source: 'classify', error: errText(e) });
    return { bareMetal: [], virtualizationHosts: [] };
  });
  const held = await withholdUnreadBareMetal(snap, fleet.bareMetal || []);
  const { hostsUnread } = held;
  // v2.626: 법인이 빈 베어메탈은 개요와 같은 귀속(호스트명·서비스태그·지정·DataCenter 단일 vCenter)으로 채운다 —
  //   예전에는 '법인 귀속 없음' 으로 빠져 수집 대상이 되지 못했다. ⚠ 호스트를 못 읽은 동안 뺀 뒤에 채운다(그 판정은 그대로).
  const { attributeBareMetalFromSnap } = await import('../idrac/corpAttribution.js');
  const attr = attributeBareMetalFromSnap(held.bareMetal, snap);
  const bareMetal = attr.bareMetal;
  const registry = (() => {
    // idrac/registry.js loadRegistry 는 파싱 실패 시 손상본을 옮기고(preserveCorrupt) 빈 목록을 준다 — 호출 전후 파일
    //   존재로 그 사실을 알아챈다(등록부 모듈을 건드리지 않고). 빈 목록이면 전 서버가 'no-idrac' 로 보이므로 밝혀야 한다.
    let existed = false;
    try { existed = fs.existsSync(IDRAC_REGISTRY_FILE()); } catch { /* */ }
    try {
      const list = loadRegistry();
      if (!fs.existsSync(IDRAC_REGISTRY_FILE())) {
        // 방금 손상본으로 옮겨졌거나(existed) 재시작 전에 옮겨져 보존본만 남은 경우(corruptOnlyReason).
        const why = existed ? '손상본 보존' : corruptOnlyReason(IDRAC_REGISTRY_FILE());
        if (why) sourceErrors.push({ source: 'idrac-registry', error: `iDRAC 등록부(idrac.json)를 읽지 못했습니다(${why}) — 대상 서버가 no-idrac 로 보일 수 있습니다` });
      }
      return list;
    } catch (e) { sourceErrors.push({ source: 'idrac-registry', error: safeLoadText(e, 200) || 'unknown' }); return []; } // v2.744(최종 검토 FB): 따옴표 든 원문은 요약
  })();
  const bmServers = (() => {
    try {
      // 7b: 키 · 공통 계정 참조를 접속 자격으로 해석한다(refs.resolveOsAuth 하나 — 연결 시험과 같은 판정). 해석 실패는 authError 로 남아 접속하지 않는다.
      const list = withResolvedAuth(listBmServersRaw());
      const le = typeof bmRegistryLoadError === 'function' ? bmRegistryLoadError() : null;
      // v2.744(최종 검토 FB — RD-R1·RG2744-03): 원문(le.reason — JSON.parse 메시지의 파일 조각)이 아니라 요약(registrySourceError).
      if (le) sourceErrors.push(registrySourceError('os-registry', (why) => `OS 계정 등록부를 읽지 못했습니다 — 대상 서버가 no-os-cred 로 보일 수 있습니다(${why})`, le));
      return list;
    } catch (e) { sourceErrors.push({ source: 'os-registry', error: safeLoadText(e, 200) || 'unknown' }); return []; }
  })();
  for (const se of sourceErrors) {
    if (_srcErrLog(`src:${se.source}`, se.error)) console.warn(`[bmusage] 대상 해석 입력 실패(${se.source}): ${se.error}`);
  }
  const isEdge = !!config.agent?.centralUrl;
  const resolveInput = {
    bareMetal, registry, bmServers,
    // v2.625: 가상화 호스트(ESXi)도 — `includeVirtualization` 일 때만 대상이 된다. ⚠ 호스트를 못 읽은 vCenter 는
    //   베어메탈과 같은 이유로 뺀다(판정이 흔들린다 — 아래 withholdUnreadBareMetal 과 같은 집합).
    virtHosts: (fleet.virtualizationHosts || []).filter((h) => !hostsUnread || !(hostsUnread.vcenters || []).includes(h.vcenterId)),
    vcenters: snap?.vcenters || [],
    agentName: config.agent?.name || '', isEdge,
    // ⚠ **캐시된** 인벤토리만 읽는다(장비 왕복 0) — 라이선스 등급 판정용(v2.554).
    inventoryOf: (id) => getInventory(id),
  };
  let resolved = resolveTargets({ ...resolveInput, settings: s });
  if (demoMod) {
    // v2.719(감사 R1-03): 데모 설정(켜짐·전 법인)은 **데모 대상(mock-)에만** 적용한다. 사람이 등록한 서버는 저장된 설정
    //   그대로 판정하고(꺼져 있으면 대상이 아니다) 폴러가 예전처럼 실제로 수집한다 — 합성 값이 실장비 키로 이력에 남지 않게.
    //   빠진 실등록 대수는 demoScope.realNotEnabled 로 밝힌다(조용한 제외 금지).
    const realRes = saved.enabled === true ? resolveTargets({ ...resolveInput, settings: saved }) : null;
    const demoT = resolved.targets.filter((x) => demoMod.isDemoBmTarget(x));
    const realT = realRes ? realRes.targets.filter((x) => !demoMod.isDemoBmTarget(x)) : [];
    const realKeys = new Set(realT.map((x) => x.key));
    const realNotEnabled = resolved.targets.filter((x) => !demoMod.isDemoBmTarget(x) && !realKeys.has(x.key)).length;
    resolved = { ...resolved, targets: [...demoT, ...realT], demoScope: { demo: demoT.length, real: realT.length, realNotEnabled } };
  }
  return {
    settings: s,
    ...resolved,
    vcenters: (snap?.vcenters || []).map((v) => ({ id: v.id, name: v.name || v.id })),
    isEdge,
    attributed: { filled: attr.filled || 0, conflicts: attr.conflicts || 0, ...(attr.error ? { error: attr.error } : {}) },
    ...(hostsUnread ? { hostsUnread } : {}),
    sourceErrors,
    ...(classifyFailed ? { classifyFailed: true } : {}),
  };
}

/**
 * v2.604(감사 EDGE2604-01 의 bmusage 쪽): 호스트를 아직 읽지 못한 vCenter 가 있으면 베어메탈 판정이 흔들린다 —
 * classifyFleet 은 스냅샷 호스트와 iDRAC 을 대조하므로 호스트가 비면 **ESXi 를 받치는 iDRAC 이 베어메탈로 둔갑**해
 * 사용률 수집 대상(= iDRAC·SSH 세션)에 들어간다(부팅 직후 · 재시작 뒤 연결 실패 vCenter).
 * 그 동안은 **못 읽은 vCenter 로 귀속된 것과 귀속이 없는 것**을 대상에서 뺀다(어느 쪽이 ESXi 인지 알 수 없다).
 * 다른 vCenter 로 귀속된 베어메탈은 그대로 수집한다. 뺀 사실은 `hostsUnread` 로 밝히고 콘솔에 남긴다(조용한 제외 금지).
 * '못 읽음' 판정은 fleet push 와 같은 함수(agent/fleetPush.js unreadHostVcenters)다.
 * 순수에 가깝게 — 등록부만 읽는다(장비 왕복 0).
 */
const _unreadLog = createChangeLogger({ windowMs: 10 * 60_000 }); // 같은 상태는 10분에 1줄(대상 계산은 화면 조회마다 돈다)
/*
 * v2.605 RECENT2605-01(bmusage 쪽): 보류에는 반드시 시한(v2.601 RECENT2601-02 규약). 인증 정지·점검중+재시작·
 * 장기 장애 vCenter 는 호스트 0 으로 굳어 **복구될 때까지** unread 이고, 그 동안 귀속 없는 베어메탈과 그 vCenter
 * 귀속 베어메탈이 무기한 수집에서 빠졌다. 처음 본 시각부터 WITHHOLD_MAX_MS(= LASTGOOD_HOLD, inventoryPush 와 같은
 * 값)를 넘으면 그 vCenter 로는 더 빼지 않고 `hostsUnread.expired` 로 밝힌다(ESXi 오판 가능성이 있다는 사실도 함께).
 */
const _unreadSince = new Map();   // vcenterId → 처음 '못 읽음' 으로 본 시각
export async function withholdUnreadBareMetal(snap, bareMetal = [], registered = null, { now = Date.now(), sinceMap = _unreadSince } = {}) {
  const [{ unreadHostVcenters }, { loadVcenterConfig }, { WITHHOLD_MAX_MS }] = await Promise.all([
    import('../agent/fleetPush.js'), import('../config.js'), import('../agent/inventoryPush.js'),
  ]);
  let reg = registered;
  if (!Array.isArray(reg)) { try { reg = loadVcenterConfig()?.vcenters || []; } catch { reg = []; } }
  const unread = unreadHostVcenters(snap, reg);
  const unreadSet = new Set(unread);
  for (const id of [...sinceMap.keys()]) if (!unreadSet.has(id)) sinceMap.delete(id);   // 복구된 것은 시계를 지운다
  if (!unread.length) return { bareMetal, hostsUnread: null };
  for (const id of unread) if (!sinceMap.has(id)) sinceMap.set(id, now);
  const active = unread.filter((id) => now - sinceMap.get(id) <= WITHHOLD_MAX_MS);
  const expired = unread.filter((id) => now - sinceMap.get(id) > WITHHOLD_MAX_MS);
  const u = new Set(active);
  // 보류 중인 vCenter 가 하나도 없으면(전부 시한 초과) 귀속 없는 베어메탈도 더 빼지 않는다.
  const kept = active.length ? bareMetal.filter((b) => b && b.vcenterId && !u.has(b.vcenterId)) : bareMetal.slice();
  const dropped = bareMetal.length - kept.length;
  // 범위 계정에 다시 세어 줄 수 있게 뺀 대수를 vCenter 별로 둔다(''=귀속 없음).
  const keptSet = new Set(kept);
  const droppedByVc = {};
  for (const b of bareMetal) if (!keptSet.has(b)) { const k = String(b?.vcenterId || ''); droppedByVc[k] = (droppedByVc[k] || 0) + 1; }
  if (dropped && _unreadLog('bm-unread', `${active.join(',')}|${dropped}`)) console.warn(`[bmusage] 호스트를 아직 읽지 못한 vCenter ${active.length}개(${active.slice(0, 5).join(', ')}) — ESXi 를 받치는 iDRAC 이 베어메탈로 잘못 잡히지 않도록 귀속이 그 vCenter 이거나 없는 베어메탈 ${dropped}대를 이번에는 대상에서 뺐습니다`);
  if (expired.length && _unreadLog('bm-unread-expired', expired.join(','))) console.warn(`[bmusage] 호스트를 ${Math.round(WITHHOLD_MAX_MS / 3_600_000)}시간 넘게 읽지 못한 vCenter ${expired.length}개(${expired.slice(0, 5).join(', ')}) — 보류 시한이 지나 베어메탈을 다시 수집합니다(그 vCenter 의 ESXi iDRAC 이 섞일 수 있습니다)`);
  const since = Object.fromEntries(unread.slice(0, 32).map((id) => [id, sinceMap.get(id)]));
  return { bareMetal: kept, hostsUnread: { vcenters: unread.slice(0, 32), withheld: active.slice(0, 32), expired: expired.slice(0, 32), dropped, droppedByVc, since, withholdMaxMs: WITHHOLD_MAX_MS } };
}

/**
 * 인증 정지 판정용 식별자 — **도구 안에서 유일**해야 한다(`authGuard` 는 `dev.id` 로 찾는다).
 * ⚠ 서버 키만 쓰면 한 법인의 정지가 다른 법인의 같은 태그 서버를 멈춘다 → agent 축을 앞에 둔다
 *   (v2.548 `(agent, part_key)` 와 같은 판단).
 */
function authDev(target) {
  if (!target.osHost) return null;
  return {
    id: `${config.agent?.name || 'central'}|os|${target.key}`,
    // 7b: 키 인증은 키 지문을 자격 지문으로 — 키를 바꾸면(회전) 정지가 풀리는 신호가 된다(bmstor 폴러와 같은 refs.authCredOf 하나).
    username: authCredOf(target.osHost).username, password: authCredOf(target.osHost).password,
  };
}
/**
 * Enterprise 대체 수집(iDRAC 계정)용 정지 식별자(v2.554). ⚠ **OS 계정과 다른 이름공간**이어야
 * 한다 — 같은 서버의 OS 비밀번호가 틀린 것과 iDRAC 비밀번호가 틀린 것은 **조치가 다르고**,
 * 한쪽 정지가 다른쪽을 멈추면 멀쩡한 경로가 죽는다(v2.535 '도구마다 다른 이름' 의 변형).
 * ⚠ **iDRAC 계정도 잠긴다** — 5분마다 틀린 비밀번호로 Redfish·SSH 로그인을 시도하면
 *   iDRAC 의 계정 잠금 정책(기본 3~5회)에 걸려 **전력·온도 수집까지 함께 죽는다**.
 */
function authDevIdrac(target) {
  if (!target.idrac) return null;
  return {
    id: `${config.agent?.name || 'central'}|idrac|${target.key}`,
    username: target.idrac.username, password: target.idrac.password,
  };
}

/** 주 iDRAC 폴러가 같은 계정을 인증 실패로 멈췄는가(읽기 전용 — 해제는 그 폴러만 한다, v2.590). */
function mainIdracStop(target) {
  const i = target?.idrac;
  if (!i?.regId) return null;
  try { return mainIdracAuthStopFor({ id: i.regId, username: i.username, password: i.password }); } catch { return null; }
}

/**
 * v2.923(4단계 — 진단 스냅샷): 사람이 누른 SSH 1회의 결과를 **주기 수집과 같은 가드 · 같은 식별자**에 반영한다(util/authGuard.js 규약).
 *  · 인증 실패 문구면 정지를 기록한다 — 그 뒤 주기 수집이 같은 틀린 계정으로 다시 로그인하지 않게(계정 잠금).
 *  · 성공이면 정지를 푼다 — 같은 계정으로 실제 로그인에 성공했다(v2.591 ‘수동 성공은 정지를 푼다’ 와 같은 판단).
 *  · 스냅샷 자체는 막지 않는다(규칙 3 — 수동 실행은 막지 않는다). 호스트키 거부 · 시한 · 연결 실패는 인증 실패가 아니다(규칙 4).
 */
export function recordOsAuthOutcome(target, { ok = false, errorText = '' } = {}) {
  const dev = authDev(target || {});
  if (!dev) return null;
  if (ok) { guard.clearAuthStop(dev.id); return null; }
  if (isAuthFailureText(errorText)) return guard.markAuthStopped(dev.id, dev, String(errorText || '인증 실패').slice(0, 200));
  return null;
}
/** v2.923 — 이 대상의 OS 인증 정지 기록(없으면 null · 자격증명이 바뀌었으면 풀린다). */
export function osAuthStopFor(target) {
  const dev = authDev(target || {});
  return dev ? guard.authStopFor(dev) : null;
}
/**
 * v2.929(5단계 — 집중 모니터링): iDRAC 경로의 인증 정지(이 도구의 정지 + 주 iDRAC 폴러의 정지 — collectOne 과 같은 판정). 없으면 null.
 */
export function idracAuthStopFor(target) {
  const dev = authDevIdrac(target || {});
  if (!dev) return null;
  return guard.authStopFor(dev) || mainIdracStop(target);
}
/**
 * v2.929 — 집중 수집의 Redfish 1회 결과를 **주기 수집과 같은 가드 · 같은 식별자**에 반영한다(kind 'auth' = 자격증명 거부 → 정지 · 성공 → 해제).
 *   시한 · 연결 실패는 인증 실패가 아니다(v2.535 — 정지하지 않는다).
 */
export function recordIdracAuthOutcome(target, { ok = false, kind = '', errorText = '' } = {}) {
  const dev = authDevIdrac(target || {});
  if (!dev) return null;
  if (ok) { guard.clearAuthStop(dev.id); return null; }
  if (kind === 'auth') return guard.markAuthStopped(dev.id, dev, String(errorText || 'iDRAC 인증 실패').slice(0, 200));
  return null;
}
/** v2.929 — 집중 수집 첫 분의 누적 카운터 기준(이 대상의 마지막 주기 표본 **사본** — 주기 수집 상태는 바꾸지 않는다). 없으면 null(첫 분은 첫 표본). */
export function prevCountersFor(key) {
  const p = _prev.get(String(key));
  return p ? structuredClone(p) : null;
}

/** 화면이 '몇 대가 정지됐나' 를 말할 수 있게 이번 주기의 정지분을 기억한다. */
const _authStopped = new Map();

/**
 * v2.732(감사 B1-01): 누적 카운터 간격 한계(`rates.spanLimitMs`)의 입력 — 설정 주기와 여유(slack).
 *   적응 타이머는 **직전 실행이 끝난 뒤** 재무장하므로 같은 서버의 두 표본 간격은
 *   (직전 주기에서 이 서버를 읽은 뒤 그 주기가 끝나기까지) + 주기 + (이번 주기에서 이 서버가 읽히기까지) ≤ 직전 실행 소요 + 주기 + 이번 offset 이다.
 *   그래서 slack = 직전 실행 소요 + 이번 offset 이고, 한계 = max(60분, 주기 × 3 + slack) 이다(CVP counterGapOk 와 같은 배수).
 *   ⚠ 예전에는 buildUsage 에 주기를 넘기지 않아 한계가 60분 고정이었다 — 주기 60분이면 매 주기 CPU·디스크·네트워크·HBA 가 비었다.
 *   ⚠ 수동 '지금 수집' 도 같은 값을 쓴다(주기는 그 순간의 설정 — 타이머가 다시 읽는 값과 같다).
 * @param {{intervalMs?:number|null, prevRunMs?:number|null, runT0?:number|null, sampledAt?:number|null}} p
 * @returns {{intervalMs:number|null, slackMs:number}}
 */
export function spanArgsFor({ intervalMs = null, prevRunMs = 0, runT0 = null, sampledAt = null } = {}) {
  const iv = numOrNull(intervalMs);
  const prevRun = numOrNull(prevRunMs);
  const t0 = numOrNull(runT0); const at = numOrNull(sampledAt);
  const offset = t0 != null && at != null ? Math.max(0, at - t0) : 0;
  return { intervalMs: iv != null && iv > 0 ? iv : null, slackMs: (prevRun != null && prevRun > 0 ? prevRun : 0) + offset };
}

/**
 * v2.744(감사 DEV-04): iDRAC 텔레메트리 수집 한 건 — **장비 시한이 요청을 실제로 끊는다**(`withDeadline` + `signal`, v2.417 규약).
 *
 * 예전에는 OS 경로만 `withDeadline` 안에 있고 텔레메트리 GET 은 시한 없이 돌았다. 요청마다 걸린 시한(IDRAC_TIMEOUT_MS)만 있어
 * 전수 모드에서 목록 1회 + 리포트 6개(동시 3)가 각자 시한을 다 쓰면 한 서버가 수 분을 붙잡았고, 그동안 동시성 슬롯이 묶여
 * 뒤 서버들이 통째로 밀렸다(그 결과 주기가 간격을 넘겨 재진입 가드가 다음 틱을 건너뛴다). 이제 시한이 되면 남은 GET 을
 * 보내지 않고 진행 중인 소켓을 끊는다.
 *
 * ⚠ 시한 초과는 `kind:'timeout'` 이다 — **자격증명 거부가 아니므로 인증 정지에 세지 않는다**(정지 조건은 `kind === 'auth'` 뿐).
 *   타임아웃으로 멈추면 일시 장애가 수집을 영구 정지시킨다(v2.535 규약). 그 밖의 예외는 예전처럼 'unreachable'.
 * ⚠ 공유 세션 POST 에는 호출자 signal 을 걸지 않는 규칙(v2.593 — 세션 생성 공유)은 `redfish.rawGet` 이 그대로 지킨다.
 *
 * @param {object} entry  `target.idrac`(등록 항목 사본)
 * @param {{full?:boolean, allowList?:boolean, timeoutMs?:number}} [opt]  `timeoutMs` 는 테스트용 — 기본은 장비 시한
 * @returns {Promise<object>} `fetchUsage()` 결과 또는 `{ok:false, kind:'timeout'|'unreachable', error}`
 */
export async function idracTelemetryJob(entry, { full = false, allowList = true, timeoutMs = DEVICE_TIMEOUT_MS } = {}) {
  const LABEL = 'iDRAC 텔레메트리 시한 초과';
  try {
    const m = await import('../idrac/redfish.js');
    return await withDeadline(timeoutMs, (signal) => m.fetchUsage(entry, { full, allowList, signal }), LABEL);
  } catch (e) {
    const msg = String(e?.message || e);
    return { ok: false, kind: msg.startsWith(LABEL) ? 'timeout' : 'unreachable', error: msg.slice(0, 300) };
  }
}

/**
 * 한 서버 수집 — 두 경로를 병렬로 시도하고 실패도 사유와 함께 돌려준다.
 *
 * ⚠⚠ **표본 시각은 이 서버가 실제로 읽힌 시각이다**(v2.550.3 에 고친 결함). 예전에는 주기 시작
 *   시각 하나(`pollBmUsageOnce` 의 `now`)를 전 서버에 썼다. 동시성 4로 200대를 돌면 마지막
 *   서버는 주기 시작보다 수 분 뒤에 읽히고, 그 offset 은 **주기마다 흔들린다**(한 대가 60초
 *   시한에 걸리면 뒤 서버들이 통째로 밀린다). 그러면 `perSecond`·`busyPct` 의 분모(span)가
 *   실제 경과와 달라져 사용률이 **오류 없이 틀린 값**이 된다 — 재현 계산: offset 10초→200초면
 *   실제 경과 490초인데 300초로 나눠 **63% 과다**, 200초→10초면 **63% 과소**, 5초→250초면
 *   **82% 과다**. `now` 를 다시 전 서버 공용으로 되돌리지 말 것.
 */
/** v2.922: 저장 구조·피크 설정(store) — 엣지·중앙 모두 이 노드의 설정이다. */
function storeOf() { try { return loadBmUsageSettings().store || STORE_DEFAULTS; } catch { return STORE_DEFAULTS; } }
/** OS 수집기에 넘길 옵션 — 파티션 I/O 옵트인 · ##BLKQ 장치 상한(D7) · 피크 창(A) · 샘플러 수거(B — 옵트인 · 해시 대조 자리). */
export function osStoreOpts(st = storeOf(), plan = null) {
  const base = { partitionIo: !!st.partitionIo, blkqMax: st.blkqMax, peakWindowS: st.peakWindowS, sampler: !!st.peakSampler, samplerSha: st.peakSamplerSha256 || '' };
  if (!plan) return base;
  // v2.922: 이번 주기 창 길이는 주기 예산 자동 맞춤(peakPlan)이 정한다 — 설정값은 상한(줄이기만 한다). 줄였으면 그 사실을 행 노트로.
  return { ...base, peakWindowS: Math.min(Number(st.peakWindowS) || 0, Number(plan.windowS) || 0), peakCycle: { capS: plan.capS, plannedS: plan.windowS, reason: plan.reason } };
}
/*
 * v2.922: 피크 창 주기 예산 — 직전 주기 서버별 소요(창 제외 기본 소요 실측의 근거)와 이번 주기 결정. 인메모리(재시작하면 첫 주기는 보수적 기본값).
 *   결정은 _last.peakPlan · bmUsageStatus().peakPlan(수집 건강 ⑫ 이 쓸 값)으로 올린다. 서버 이름은 싣지 않는다(개수·ms 만 — status 는 무스코프로 나간다).
 */
let _cycleSamples = [];
let _peakPlan = null;
export function peakPlanStatus() { return _peakPlan; }
/** 이번 주기 결정(실제 대상 기준 — 데모 합성 대상은 수집 시간이 없다). */
export function planPeakForCycle(realTargets = [], { intervalMs, st = storeOf(), samples = _cycleSamples, concurrency = CONCURRENCY } = {}) {
  const est = estimateBaseMs(samples);
  const plan = planCycleWindow({
    targets: realTargets.length, osTargets: realTargets.filter((x) => (x?.paths || []).includes('os')).length,
    concurrency, intervalMs, ratio: st.peakCycleRatio, capS: st.peakWindowS, baseMs: est.baseMs, baseSource: est.source,
  });
  const { steps, ...rest } = plan;
  return { at: Date.now(), ...rest, baseSamples: est.n, steps: (steps || []).slice(0, 6) };
}
async function collectOne(target, { trigger = 'auto', intervalMs = null, prevRunMs = 0, runT0 = null, peakPlan = null, logExtra = null } = {}) {
  const t0 = Date.now();
  const dev = authDev(target);
  // ⚠ **수동 실행은 막지 않는다** — 사람이 1회 누르는 것은 잠금 위험이 없고, 비밀번호를 고친 뒤
  //   확인할 길을 없애면 안 된다(v2.528·v2.535 규약). 막는 것은 주기 수집뿐이다.
  const stopped = (dev && trigger !== 'manual') ? guard.authStopFor(dev) : null;
  if (stopped) _authStopped.set(target.key, stopped); else _authStopped.delete(target.key);
  const jobs = [];
  /*
   * v2.590(감사 F1 보조): **iDRAC 텔레메트리 GET 도 인증 실패 정지를 본다.** 예전에는 Enterprise 대체
   *   경로(아래 ③)만 `authStopFor` 를 봤고 텔레메트리 GET 은 정지 없이 매 주기 같은 iDRAC 계정으로
   *   로그인했다 — 게다가 `redfish.get` 의 401 문구에 숫자가 없어 `fetchUsage` 가 401 을 'unreachable' 로
   *   분류해 **정지 조건에 닿지도 않았다**(redfish.js 에서 함께 고쳤다). 주 iDRAC 폴러(1분)가 같은 계정을
   *   이미 멈췄으면 여기서도 시도하지 않는다. 수동 실행은 막지 않는다.
   */
  const entDev = authDevIdrac(target);
  let entStopped = (entDev && trigger !== 'manual')
    ? (guard.authStopFor(entDev) || mainIdracStop(target)) : null;
  // 전수 모드는 설정으로 켜고 끈다. `allowList` 는 **이번 주기의 목록 조회 예산**이다(위 주석).
  const full = !!loadBmUsageSettings().idracFullTelemetry;
  const allowList = full && _listBudget > 0 && !entStopped;
  if (allowList) _listBudget -= 1;
  jobs.push(!target.paths.includes('idrac') ? Promise.resolve(null)
    : entStopped ? Promise.resolve({ ok: false, kind: 'auth-stopped', error: `iDRAC 인증 실패로 주기 수집이 정지됐습니다(${entStopped.attempts}회 시도). 비밀번호를 고치면 자동 재개합니다.`, authStopped: entStopped })
      : idracTelemetryJob(target.idrac, { full, allowList }));
  // 6단계 수집 건강: OS(SSH) 세션 소요 — 실제로 연 경우만(정지 · 경로 없음은 재지 않는다 — 0 으로 세지 않는다).
  let osMs = null;
  const osT0 = Date.now();
  jobs.push((target.paths.includes('os') && !stopped)
    ? withDeadline(DEVICE_TIMEOUT_MS, (signal) => collectOsUsage(target.osHost, { signal, budgetMs: OS_BUDGET.effective, ...osStoreOpts(storeOf(), peakPlan), ...(logExtra ? { extraCommands: [logExtra] } : {}) }), 'OS 수집 시한 초과')
      .catch((e) => ({ ok: false, error: String(e?.message || e).slice(0, 300) }))
      .then((r) => { osMs = Date.now() - osT0; return r; })
    : Promise.resolve(stopped ? { ok: false, error: `인증 실패로 주기 수집이 정지됐습니다(${stopped.attempts}회 시도). 비밀번호를 고치면 자동 재개합니다.`, authStopped: stopped } : null));
  const [idrac, os] = await Promise.all(jobs);
  /*
   * 이 서버의 표본 시각. Linux 는 명령 1회 왕복이라 '출력을 받은 시각' 과 여기의 차이는 수십 ms 이고
   * (주기 300초 대비 무시 가능), 예전 방식의 오차는 **수 분**이었다. `prev.at` 과 `row.ts` 가 같은
   * 기준을 쓰는 것이 핵심이다 — 하나만 바꾸면 span 이 그만큼 어긋난다.
   */
  const sampledAt = Date.now();

  // v2.590: 텔레메트리가 자격증명 거부(401/403)면 iDRAC 경로를 멈춘다 — 같은 계정으로 대체 경로(③)도
  //   이번 주기에 시도하지 않는다(시도하면 한 주기에 실패 로그인이 두 경로만큼 쌓인다).
  if (entDev && idrac && idrac.ok === false && idrac.kind === 'auth') {
    const rec = guard.markAuthStopped(entDev.id, entDev, idrac.error || 'iDRAC 인증 실패');
    _authStopped.set(`${target.key}|idrac`, rec);
    entStopped = rec;
    console.warn(`[bmusage] ${target.name}: iDRAC 인증 실패로 텔레메트리 주기 수집 정지(${rec.attempts}회)`);
  } else if (entDev && idrac?.ok) {
    guard.clearAuthStop(entDev.id);
    // v2.591(감사 R-BM1): 수동 '지금 수집' 이 **같은 regId·같은 자격증명**으로 텔레메트리를 읽었다면 계정은 맞다 —
    //   주 iDRAC 폴러의 정지도 푼다. 그 폴러는 정지된 서버를 주기에서 건너뛰므로 스스로는 풀리지 않고, 그대로 두면
    //   다음 주기에 이 도구도 주 폴러 정지를 따라 다시 멈춘다(화면 문구 '고친 뒤 지금 수집으로 확인' 이 거짓이 된다).
    //   주기 수집은 주 폴러 정지 중에는 텔레메트리를 시도하지 않으므로(위 entStopped) 이 분기는 사실상 수동 전용이다.
    const i = target.idrac;
    if (trigger === 'manual' && i?.regId && releaseIdracAuthStop({ id: i.regId, username: i.username, password: i.password })) {
      console.log(`[bmusage] ${target.name}: 수동 수집이 같은 iDRAC 계정으로 성공 — 주 iDRAC 폴러의 인증 실패 정지를 풀었습니다`);
    }
  }

  /*
   * ── ③ Enterprise 대체 수집(v2.554) ─────────────────────────────────────────
   * 사용자 신고: "텔레메트리는 Datacenter 라이선스가 필요한데 내가 가진건 enterprise 라서".
   * ⚠⚠ **텔레메트리 결과를 본 뒤에 판정한다**(`license.enterpriseEligible`) — 등급만 보고 걸면
   *   ⓐ 등급을 못 읽은 서버가 영영 제외되고 ⓑ 텔레메트리가 잘 되는 Datacenter 장비에도 SSH·추가
   *   GET 이 붙어 **장비 부하가 두 배**가 된다. 관리자가 동의한 것은 '텔레메트리로 못 읽는 서버'
   *   에 대한 부하다.
   * ⚠ **401/403 이면 시도하지 않는다** — 같은 계정이라 결과가 같고 **iDRAC 계정을 잠근다**.
   * ⚠ **주기당 예산**을 넘기면 이번 주기는 미루고 **사유를 남긴다**(조용한 생략 금지).
   * ⚠ 시한은 `withDeadline` + `signal` 로 **SSH 세션을 실제로 끊는다**(v2.417).
   */
  let ent = null;
  if (entStopped) _authStopped.set(`${target.key}|idrac`, entStopped); else _authStopped.delete(`${target.key}|idrac`);
  if (target.entAllowed && enterpriseActive(loadBmUsageSettings())) {
    /*
     * v2.598(감사 IDRAC-2598-01): '텔레메트리가 값을 줬다' 는 **보드 CPU·메모리를 읽었다** 는 뜻이어야 한다 — 전수 모드가
     *   NIC·스토리지 값만 읽고 ok 로 돌아오면 CPU·메모리가 비었는데도 대체 경로가 '텔레메트리 정상' 으로 막혔다.
     *   대체 경로는 **빈 칸만** 채우므로(usage.js) 텔레메트리 값을 덮지 않는다.
     */
    const boardRead = !!idrac?.ok && (idrac.cpuPct != null || idrac.memPct != null);
    const el = enterpriseEligible({
      tier: target.license?.tier || '', telemetryOk: boardRead,
      telemetryKind: idrac?.ok ? (boardRead ? '' : 'board-missing') : (idrac?.kind || ''),
    });
    if (entStopped) {
      ent = { ok: false, kind: 'auth-stopped', error: `iDRAC 인증 실패로 주기 대체 수집이 정지됐습니다(${entStopped.attempts}회 시도). 비밀번호를 고치면 자동 재개합니다.`, authStopped: entStopped };
    } else if (!el.eligible) {
      ent = { ok: false, kind: `not-eligible:${el.why}`, skipped: true };
    } else if (_entBudget <= 0) {
      _entDeferred += 1;
      ent = { ok: false, kind: 'budget', skipped: true, error: '이번 주기의 대체 수집 예산을 다 써서 미뤘습니다 — 다음 주기에 시도합니다.' };
    } else {
      _entBudget -= 1;
      const allowProbe = _entProbeBudget > 0;
      if (allowProbe) _entProbeBudget -= 1;
      ent = await withDeadline(DEVICE_TIMEOUT_MS,
        (signal) => collectEnterpriseUsage(target.idrac, { mode: loadBmUsageSettings().enterpriseMode, allowProbe, signal, budgetMs: ENT_BUDGET.effective }),
        'iDRAC 대체 수집 시한 초과')
        .catch((e) => ({ ok: false, kind: 'timeout', error: String(e?.message || e).slice(0, 300) }));
      // 자격증명 거부면 주기 수집을 멈춘다(위 주석 — iDRAC 계정 잠금 방지).
      if (entDev && (ent.kind === 'auth' || ent.kind === 'ssh-auth')) {
        const rec = guard.markAuthStopped(entDev.id, entDev, ent.error || ent.kind);
        _authStopped.set(`${target.key}|idrac`, rec);
        console.warn(`[bmusage] ${target.name}: iDRAC 인증 실패로 대체 수집 정지(${rec.attempts}회)`);
      } else if (entDev && ent.ok) {
        guard.clearAuthStop(entDev.id);
        _authStopped.delete(`${target.key}|idrac`);
      }
    }
  }

  // 인증 실패면 주기 수집을 멈춘다 — 반복 시도는 결과가 같고 계정만 잠근다.
  if (dev && os && os.ok === false && !os.authStopped && isAuthFailureText(os.error)) {
    const rec = guard.markAuthStopped(dev.id, dev, os.error);
    _authStopped.set(target.key, rec);
    console.warn(`[bmusage] ${target.name}: 인증 실패로 주기 수집 정지(${rec.attempts}회) — ${rec.reason}`);
  } else if (dev && os && os.ok) {
    guard.clearAuthStop(dev.id);
    _authStopped.delete(target.key);
  }

  // v2.732(B1-01): 주기·여유를 넘긴다 — 넘기지 않으면 간격 한계가 60분 고정이라 주기 60분 이상에서 누적 카운터 지표가 매 주기 빈다.
  const built = buildUsage({ target, idrac, os, ent, prev: _prev.get(target.key) || null, now: sampledAt, deviceMax: storeOf().deviceMax, ...spanArgsFor({ intervalMs, prevRunMs, runT0, sampledAt }) });
  if (built.next) _prev.set(target.key, built.next);
  const ok = !!(idrac?.ok || os?.ok || ent?.ok);
  recordHbaBasis(target.key, built, { at: sampledAt, ok });   // v2.744(LEFT-08 ②): 포트 수만 — 화면 각주가 분모 근거를 한 번 말한다
  recordUsageDetail(target.key, built, { at: sampledAt, ok });   // v2.744(RV2744F-WEB-03): 화면 상세 카드 — 실패 주기도(그 사유가 상세다)
  recordBmUsage({
    // ⚠ `idracHost` 는 `publicTarget()` 이 만드는 응답용 필드다 — **내부 target 에는 없다**.
    //   `target.idracHost` 로 읽으면 iDRAC 전용 서버의 작업 로그에 host 가 빈 칸으로 남는다.
    deviceId: target.key, name: target.name, host: target.osHost?.host || target.idrac?.host || '',
    source: config.agent?.name || 'central', ok, durationMs: Date.now() - t0,
    error: ok ? null : (os?.error || ent?.error || idrac?.error || '수집 경로 전부 실패'),
    // ⚠ 실패 주기의 수치는 싣지 않는다(0 은 '부하 없음' 이라는 거짓).
    ...(ok ? { cpuPct: built.row.cpu_pct, memPct: built.row.mem_pct, diskBusyPct: built.row.disk_busy_pct, netPct: built.row.net_pct, hbaPct: built.row.hba_pct } : {}),
  });
  // v2.922: 서버별 수집 소요와 실제로 쓴 피크 창 — 다음 주기의 ‘서버당 기본 소요’ 실측(peakPlan.estimateBaseMs)이 쓴다.
  return { ok, target, built, idrac, os, ent, ms: Date.now() - t0, osMs, windowS: Number(os?.peak?.windowS) || 0 };
}

/**
 * 대상에서 사라진 키의 인메모리 상태를 버린다(v2.550.3 누수 방지 — v2.628 에 0대 경로도 부르도록 함수로 뺐다).
 * ⚠ iDRAC 정지 키는 `<key>|idrac` 이므로 접미를 떼고 대조한다(안 떼면 영원히 남는다 — 누수).
 */
function dropStaleState(live) {
  for (const k of _prev.keys()) if (!live.has(k)) _prev.delete(k);
  pruneHbaBasis(live);   // v2.744(LEFT-08 ②)
  for (const k of _detail.keys()) if (!live.has(k)) _detail.delete(k);   // v2.744(RV2744F-WEB-03)
  for (const k of _authStopped.keys()) if (!live.has(String(k).replace(/\|idrac$/, ''))) _authStopped.delete(k);
}

/*
 * ⚠⚠ v2.628(감사 EDGE2628-02): **보존 정리는 수집과 무관하게 돈다.** 예전에는 pruneUsage 가 '켜져 있고 대상이 1대
 *   이상인 성공 주기' 에서만 불려, 꺼짐(중앙 배포로 끔·이 엣지 제외 포함)·대상 0대·수집 예외면 원시 90일/롤업 5년
 *   보존이 **영원히 집행되지 않았다**(설정이 거짓말 — v2.531 과 같은 유형). 폴러 틱마다 이 함수를 부르고 스로틀은
 *   `(++tick % N) === 0`(기동 첫 틱에 참이 되지 않는다 — v2.453 규약). 수집이 꺼져 있고 DB 파일이 아직 없으면
 *   **파일을 만들지 않는다**(켠 적 없는 노드에 빈 DB 를 만들지 않게). 경로는 bmusage/db.js FILE() 과 같은 식이다.
 */
/*
 * ── 6단계 수집 건강(메타 모니터링 — 설계 PROFILES §16 C) ─────────────────────────────────────
 * 매 주기 끝에 이 노드의 수집을 잰다(주기 소요/예산 · 성공률 · 실패 사유 · 동시성 사용 최대 · SSH 중앙값/p95 · 저장 실측 · 집중 · 피크 창).
 *   ⚠ status(bmUsageStatus) 에 넣지 않는다 — 사유별 개수 · 법인별 분해는 범위를 거는 라우트(/tools/bm-usage/collect-health)와 엣지 봉투(collectHealth)만 싣는다.
 *   ⚠ 0대 · 분류 실패 주기도 기록한다(무음 실패 금지). 주기 기록은 메인 DB collect_cycle(주기당 한 행 · 30일 · pruneTick 청크).
 */
let _health = null;
let _healthSince = new Map();
const HEALTH_SINCE_FROM = Date.now();
async function recordCycleHealth({ results = [], t0, intervalMs, peakPlan = null, error = null } = {}) {
  try {
    const sum = summarizeCycle({ results, startedAt: t0, endedAt: Date.now(), intervalMs, concurrency: CONCURRENCY, slotPeak: slotPeakReset(),
      focus: { running: focusActiveCount(), queued: focusQueuedCount() }, peakPlan, sinceMap: _healthSince, error });
    _healthSince = sum.sinceMap;
    const db = await dbFilesNow(path.dirname(BMUSAGE_DB_FILE()));
    let cfg = null; try { cfg = (await import('./perfRules.js')).loadPerfRules().collect; } catch { cfg = null; }
    const cc = collectCells(sum.node, db, cfg || undefined);
    _health = { at: sum.node.at, node: { ...sum.node, db, dbPct: cc.dbPct, capBytes: cc.capBytes, cells: cc.cells, th: cc.th }, byCorp: sum.byCorp, sinceFrom: HEALTH_SINCE_FROM };
    if (fs.existsSync(BMUSAGE_DB_FILE())) {
      const O = await import('./opsDb.js');
      await O.cycleInsert({ agent: config.agent?.name || '', ts: sum.node.at, ms: sum.node.cycleMs, budgetMs: sum.node.budgetMs, servers: sum.node.servers, ok: sum.node.ok,
        concMax: sum.node.conc.max, concCap: sum.node.conc.cap, sshP50: sum.node.ssh.p50Ms, sshP95: sum.node.ssh.p95Ms }).catch((e) => { _health.node.recordError = String(e?.message || e).slice(0, 160); });
    }
  } catch (e) {
    // 계산 실패도 ‘주기 실패’ 칸으로(반증 F1 — 정상으로 보이지 않게). 원문은 이 노드에만(errorDetail — 봉투 정제가 싣지 않는다).
    _health = { at: Date.now(), node: { at: Date.now(), error: 'health-failed', errorDetail: `수집 건강 계산 실패: ${String(e?.message || e).slice(0, 160)}`, cells: { error: 'true' } }, byCorp: {}, sinceFrom: HEALTH_SINCE_FROM };
  }
  return _health;
}
/** 이 노드의 수집 건강(사본) — 아직 주기가 없으면 null(지어내지 않는다 — 화면은 ‘아직 주기 없음’). */
export function collectHealthNow() { return _health ? JSON.parse(JSON.stringify(_health)) : null; }

let _pruneTick = 0;
let _lastPrune = null;
let _lastLiveKeys = null;   // v2.929: 마지막 성공 주기의 대상 키(null = 아직 모름 — 지우지 않는다)
const BMUSAGE_DB_FILE = () => path.join(config.dbDir || config.configDir, 'bm-usage.db');
export async function pruneTick({ every = PRUNE_EVERY } = {}) {
  if ((++_pruneTick % Math.max(1, every)) !== 0) return { ok: true, skipped: true };
  let exists = false;
  try { exists = fs.existsSync(BMUSAGE_DB_FILE()); } catch { /* */ }
  if (!exists && !bmUsageEnabled()) return { ok: true, skipped: true, reason: 'no-db' };
  const s = loadBmUsageSettings();
  // v2.922: 시간 단위 파일 보존(파일 삭제 + 경계 기간 청크) — 단계마다 보존일. 예전 표(마이그레이션 전 잔여)는 예전 규칙 그대로.
  const st = s.store || STORE_DEFAULTS;
  const keep = { raw: effectiveRawDays(s), h1: st.hourlyDays, d1: s.dailyRetentionDays, dev: st.devRawDays, dev1h: st.devHourlyDays };
  const r = await pruneUsage({ rawDays: s.rawRetentionDays, dailyDays: s.dailyRetentionDays, force: true, keep }).catch((e) => ({ ok: false, error: errText(e) }));
  // v2.923(반증 R3): 진단 스냅샷 7일 보관 — 예전에는 ‘실행할 때만’ 지워져 아무도 누르지 않으면 프로세스 이름 · 커널 로그가 영구 보관됐다. 같은 스로틀 틱에 정리한다.
  if (exists) {
    try { const n = await snapshotPrune({ before: Date.now() - SNAPSHOT_KEEP_DAYS * 86_400_000 }); if (r && typeof r === 'object') r.snapshotsPruned = n; }
    catch (e) { if (_srcErrLog('snap-prune', errText(e))) console.warn(`[bmusage] 스냅샷 보관 정리 실패: ${errText(e)}`); }
    // v2.929(5단계): 집중 모니터링(30일) · 변경 이벤트(30일) 보관 — 같은 스로틀 틱 · 청크 DELETE. 대상에서 사라진 서버의 변경 사실 최신값도 지운다.
    try {
      const rules = (await import('./perfRules.js')).loadPerfRules();
      const O = await import('./opsDb.js');
      const fp = await focusHousekeeping({ keepDays: rules.focus?.keepDays ?? 30 });
      const cp = await O.changePrune({ before: Date.now() - (rules.changes?.keepDays ?? 30) * 86_400_000 });
      const cyc = await O.cyclePrune({ before: Date.now() - 30 * 86_400_000 }).catch(() => 0);   // 6단계 수집 건강 주기 기록 30일
      // 대상 목록은 마지막 성공 주기의 것(이 틱에서 대상 해석을 다시 하지 않는다 — 등록부 · 분류를 정리 틱마다 읽지 않게). 모르면 지우지 않는다.
      let gone = 0;
      if (_lastLiveKeys) { try { gone = await O.changeLatestKeep({ agent: config.agent?.name || '', keys: [..._lastLiveKeys] }); } catch { /* 다음 틱 */ } }
      if (r && typeof r === 'object') r.opsPruned = { focusSessions: fp?.sessions ?? 0, focusSamples: fp?.samples ?? 0, changeEvents: cp || 0, changeLatestGone: gone, collectCycles: cyc || 0 };
      // 7a단계 로그 분석 보관(설정 keepDays) + 대상에서 사라진 서버의 읽기 위치 — 같은 스로틀 틱 · 청크 DELETE.
      try { const lp = await (await import('./logs/run.js')).logPruneTick({ agent: config.agent?.name || '', keys: _lastLiveKeys ? [..._lastLiveKeys] : null }); if (r && typeof r === 'object') r.logsPruned = lp; }
      catch (e) { if (_srcErrLog('log-prune', errText(e))) console.warn(`[bmusage] 로그 분석 보관 정리 실패: ${errText(e)}`); }
    } catch (e) { if (_srcErrLog('ops-prune', errText(e))) console.warn(`[bmusage] 집중 · 변경 이벤트 보관 정리 실패: ${errText(e)}`); }
  }
  _lastPrune = { at: Date.now(), ...r };
  if (r && r.ok === false && r.error && _srcErrLog('prune', r.error)) console.warn(`[bmusage] 보존 정리 실패: ${r.error}`);
  return r;
}

/** 폴러 한 틱 — 켜져 있으면 수집하고, **켜짐 여부와 무관하게** 보존 정리를 시도한다(위 주석). */
export async function bmUsageTimerTick() {
  // v2.922: 예전 표 → 시간 단위 파일 마이그레이션 — 기다리지 않는다(청크·양보·재개 — monthMigrate.js). DB 파일이 있을 때만.
  try { if (fs.existsSync(BMUSAGE_DB_FILE())) ensureMonthMigration(); } catch { /* 상태로 밝힌다 */ }
  try {
    if (bmUsageEnabled()) await pollBmUsageOnce({ trigger: 'auto' });
  } finally {
    // v2.922(반증 D5): 롤업 보정 대기(원시는 들어갔는데 롤업이 실패한 버킷)를 원시에서 다시 집계 — 매 틱, 대기가 없으면 파일을 열어 보기만 한다.
    if (fs.existsSync(BMUSAGE_DB_FILE())) {
      try {
        const s = loadBmUsageSettings();
        const r = await repairRollups({ rawKeepFrom: Date.now() - effectiveRawDays(s) * 86_400_000 });
        _lastRepair = { at: Date.now(), ...(({ errors, ...x }) => ({ ...x, errors: (errors || []).slice(0, 3) }))(r) };
        if (r.errors?.length && _srcErrLog('repair', r.errors[0])) console.warn(`[bmusage] 롤업 보정 실패: ${r.errors[0]}`);
      } catch (e) { _lastRepair = { at: Date.now(), ok: false, error: String(e?.message || e).slice(0, 200) }; }
    }
    await pruneTick().catch(() => {});
  }
}
let _lastRepair = null;

/**
 * 동시성 제한 풀 — v2.579(ARCH-01): 본체는 `util/pool.js poolSettled` 다(손으로 쓴 사본 제거).
 * 이 호출부의 `fn` 은 스스로 catch 해 절대 거부하지 않으므로 `value` 만 뽑으면 예전 반환(결과 배열,
 * 입력 순서 보존)과 같다. 만에 하나 거부되면 예전에는 전체가 거부됐고 지금은 `undefined` 자리가
 * 남는다 — 그 항목은 아래 `results.filter(Boolean)` 계열이 거르므로 조용히 0 으로 둔갑하지 않는다.
 */
async function pool(items, limit, fn) {
  const settled = await poolSettled(items, limit, fn);
  return settled.map((r) => (r.status === 'fulfilled' ? r.value : undefined));
}

/**
 * 한 주기. `trigger:'manual'` 이면 인증 정지를 무시한다(사람이 1회 누르는 것은 잠금 위험이 없다).
 */
/*  v2.720(감사 R1-03): `demoOnly` — 데모 계정의 '지금 수집' 은 데모 대상(mock-)만 합성하고 사람이 등록한 서버에는 접속하지 않는다
 *   (v2.719 부터 mock 모드에서도 실서버는 실제로 수집되고, 수동 실행은 인증 정지도 무시한다). 뺀 대수는 skippedNonDemo 로 밝힌다.
 *   ⚠ 대상 목록(live)은 그대로 둔다 — 뺀 서버의 누적 카운터를 지우면 다음 주기 실수집이 '첫 표본' 이 된다. */
export async function pollBmUsageOnce({ trigger = 'auto', demoOnly = false } = {}) {
  if (!bmUsageEnabled()) return { ok: false, reason: '베어메탈 사용률 수집이 꺼져 있습니다(설정에서 켜세요).' };
  if (_running) return { ok: false, reason: '이전 수집이 진행 중입니다.' };
  _running = true;
  const t0 = Date.now();
  slotPeakReset();   // 6단계 수집 건강 — 이 주기의 동시성 사용 최대를 0(지금 사용 중)부터
  // v2.732(B1-01): 직전 주기 실행 소요 — 이번 주기에서 _last 를 덮기 전에 읽는다(간격 한계의 여유 — spanArgsFor).
  const prevRunMs = numOrNull(_last?.ms) ?? 0;
  try {
    const { targets, counts, settings, sourceErrors = [], classifyFailed } = await currentTargets();
    const srcErr = sourceErrors.length ? { sourceErrors: sourceErrors.slice(0, 8) } : {};
    if (classifyFailed) {
      // v2.628 EDGE2628-03: 분류 실패는 '대상 0대' 가 아니다 — 대상을 모르는 것이다. 누적 카운터·정지 기록은 건드리지 않는다
      //   (분류가 돌아오면 같은 대상이 그대로 이어진다).
      const reason = `대상 분류(서버 인벤토리)에 실패해 이번 주기를 건너뛰었습니다 — ${sourceErrors.find((x) => x.source === 'classify')?.error || ''}`;
      _last = { at: Date.now(), ms: Date.now() - t0, servers: null, okCount: 0, failCount: 0, inserted: 0, error: reason, ...srcErr, trigger };
      await recordCycleHealth({ results: [], t0, intervalMs: loadBmUsageSettings().intervalMs, error: 'classify-failed' });
      const na = await runNodeCollectAlert();
      if (na && !na.skipped) _last.collectAlert = { fires: na.fires ?? 0, error: na.error || null };
      return { ok: false, reason, ...srcErr };
    }
    if (!targets.length) {
      // v2.628 EDGE2628-02: 0대 경로도 누적 카운터·정지 기록을 정리한다(마지막 대상의 카운터가 남아 돌아왔을 때 간격 한계 — rates.spanLimitMs, 최소 60분 — 에 걸리지 않게).
      dropStaleState(new Set());
      _last = { at: Date.now(), ms: Date.now() - t0, servers: 0, okCount: 0, failCount: 0, inserted: 0, counts, ...srcErr, trigger };
      await recordCycleHealth({ results: [], t0, intervalMs: loadBmUsageSettings().intervalMs, error: 'no-targets' });
      await runNodeCollectAlert();
      return { ok: true, servers: 0, counts, reason: '대상 서버가 없습니다.', ...srcErr };
    }
    _listBudget = LIST_BUDGET_PER_RUN;   // ⚠ 주기 시작마다 리셋(위 상수 주석 참조)
    _entBudget = ENT_BUDGET_PER_RUN;
    _entProbeBudget = ENT_PROBE_PER_RUN;
    _entDeferred = 0;
    // v2.708: 데모(mock) — 장비(iDRAC·SSH)에 접속하지 않고 합성 행을 만든다. 첫 주기에 원시 14일 + 일 롤업 45일을 1회 백필한다.
    // v2.719(감사 R1-03): 합성은 데모 대상(mock-)에만 — 사람이 등록한 서버는 mock 모드에서도 예전처럼 실제로 수집한다.
    const demo = isMockMode() ? await import('../mock/demo/baremetal.js') : null;
    const demoTargets = demo ? targets.filter((tg) => demo.isDemoBmTarget(tg)) : [];
    const realAll = demo ? targets.filter((tg) => !demo.isDemoBmTarget(tg)) : targets;
    const realTargets = demoOnly ? [] : realAll;
    const skippedNonDemo = realAll.length - realTargets.length;
    const runCount = targets.length - skippedNonDemo;
    if (demo && demoTargets.length) await demo.backfillBmUsage(demoTargets).catch(() => {});
    // v2.732(B1-01): 간격 한계용 주기 — 타이머가 재무장에 쓰는 값과 같은 출처(loadBmUsageSettings — 엣지는 배포분이 겹친 유효 설정)다.
    const intervalMs = loadBmUsageSettings().intervalMs;
    const demoResults = demo ? demo.demoBmUsageResults(demoTargets, Date.now()) : [];
    // v2.744(RV2744F-WEB-03): 데모 합성 행에는 장치 상세가 없다 — 화면이 '아직 수집하지 않았다' 고 말하지 않게 데모라고 표시해 둔다.
    for (const r of demoResults) if (r?.target?.key) _detail.set(r.target.key, { state: 'demo', detail: null, at: Date.now() });
    // v2.922: 피크 창 주기 예산 자동 맞춤 — 예상 주기 소요가 주기 × peakCycleRatio 를 넘으면 창을 10 → 5 → 3 → 0초로 줄인다(설정값이 상한).
    // v2.929(5단계): 집중 수집은 이 예산 밖이다 — 대신 활성 집중 수만큼 슬롯을 쓰므로 그만큼 동시성을 빼고 계획한다(전역 풀 공유 — slots.js).
    const peakPlan = planPeakForCycle(realTargets, { intervalMs, concurrency: Math.max(1, CONCURRENCY - focusActiveCount()) });
    _peakPlan = peakPlan;
    if (peakPlan.reason === 'reduced' || peakPlan.reason === 'base-over-budget') {
      const line = `피크 창 ${peakPlan.capS}초 → ${peakPlan.windowS}초(예상 주기 ${Math.round(peakPlan.expectedMs / 1000)}초 · 예산 ${Math.round(peakPlan.budgetMs / 1000)}초 · 서버당 기본 ${Math.round(peakPlan.baseMs / 1000)}초 ${peakPlan.baseSource === 'measured' ? '실측' : '기본값'})`;
      if (_srcErrLog('peak-plan', line)) console.log(`[bmusage] ${line}`);
    }
    // v2.929: 서버 하나의 수집은 전역 슬롯 하나 안에서(집중 수집과 같은 풀 — 주기 수집은 풀 상한이 같아 스스로 기다리지 않는다).
    /*
     * 7a단계(로그 분석): 주기 시작에 읽기 위치를 한 번 읽고(서버 수만큼 점 조회 없음) 서버마다 로그 읽기 exec 를 같은 SSH 세션에 붙인다(osSsh extraCommands — 남은 예산 안에서만).
     *   실패해도 수집은 실패가 아니다(로그만 그 주기에 없다 — 위치가 넘어가지 않아 다음 주기에 같은 줄을 읽는다).
     */
    const L = await import('./logs/run.js');
    const logCtx = await L.beginLogCycle({ agent: config.agent?.name || '' }).catch((e) => ({ on: true, cursors: null, error: String(e?.message || e).slice(0, 200) }));
    /*
     * 8a단계 정비 창(설계 §20 ⑲ — 판정 코어 maint/judge.js 하나): ④ 수집 중단 창 안의 서버는 **접속하지 않는다**(‘정비 중’ — 실패로 세지 않는다 ·
     *   기존 vCenter maintenance 플래그와 같은 뜻 · 수동 실행도 같다). 창 안에서 수집이 실패한 서버는 inMaint 로 표시해 성공률에서 빼고 따로 센다 —
     *   ⚠ 인증 거부는 창과 무관하다(collectOne 의 authGuard 가 그대로 정지 · 이 표시는 인증 실패에 달지 않는다).
     *   판정기를 못 만들면(파일 손상 등) 억제하지 않는다(평소대로 수집).
     */
    let mj = null;
    try { mj = await (await import('./maint/runtime.js')).maintJudge({ now: t0 }); } catch { mj = null; }
    const maintOf = (tg) => (mj ? mj.stateFor(tg, Date.now()) : null);
    const maintSkip = []; const collectTargets = [];
    for (const tg of realTargets) {
      const ms = maintOf(tg);
      if (ms?.scopes?.collect) maintSkip.push({ tg, ms }); else collectTargets.push(tg);
    }
    const realResults0 = collectTargets.length ? await pool(collectTargets, CONCURRENCY, (tg) => withSlot(() => collectOne(tg, { trigger, intervalMs, prevRunMs, runT0: t0, peakPlan, logExtra: (tg.paths || []).includes('os') ? L.logExtraFor(tg, logCtx) : null })).catch((e) => ({ ok: false, target: tg, error: String(e?.message || e) }))) : [];
    const MR = mj ? await import('./maint/runtime.js') : null;
    for (const r of markInMaint(realResults0, maintOf)) MR?.countSuppression('collectFail', r.inMaint.ids);
    const skippedResults = maintSkip.map(({ tg, ms }) => {
      const ids = ms.windows.filter((w) => w.scopes.includes('collect')).map((w) => w.id);
      MR?.countSuppression('collect', ids); MR?.noteApplied('collect', tg.key, ms.until.collect, ids, Date.now());
      // 상세는 지난 수집 기록을 지우지 않고 ‘정비 중 — 건너뜀’ 표지만 덧댄다(다음 실제 수집이 표지를 지운다).
      _detail.set(tg.key, { ...(_detail.get(tg.key) || { state: 'none', detail: null }), maintSkip: { ids, until: ms.until.collect, at: Date.now() } });
      return { ok: false, target: tg, maintSkip: { ids, until: ms.until.collect }, ms: 0 };
    });
    const realResults = [...realResults0, ...skippedResults];
    // 다음 주기 실측 근거 — 실제로 수집한 서버만(데모 합성·예외로 끝난 항목은 소요가 없다).
    const samplesNow = realResults.filter((r) => r && Number.isFinite(r.ms)).map((r) => ({ ms: r.ms, windowS: r.windowS || 0 }));
    if (samplesNow.length) _cycleSamples = samplesNow;
    const results = [...demoResults, ...realResults];
    /*
     * ⚠ **대상에서 사라진 키를 버린다**(v2.550.3): `_prev` 는 서버마다 누적 카운터 배열(디스크·NIC·
     *   HBA)을 들고 있어 서버당 수 KB 다. 법인을 끄거나 등록부에서 서버가 빠져도 예전에는 그 항목이
     *   프로세스 수명 내내 남았다 — 등록부를 오래 편집하는 현장에서 조용히 늘어나는 누수다.
     *   더 나쁜 것: 서버가 **되돌아오면** 몇 시간 전 카운터와 비교해 간격 한계(`rates.spanLimitMs` — 최소 1시간, v2.732 부터 주기 × 3 + 여유)에
     *   걸려 그 주기가 통째로 `null` 이 된다(첫 수집이라고 말하지도 않는다).
     */
    const live = new Set(targets.map((t2) => t2.key));
    dropStaleState(live);
    // v2.929: 변경 사실 최신값 정리(pruneTick)가 쓰는 대상 목록 — ⚠ 반증 L5: 대상이 **일부만** 해석된 주기(등록부 못 읽음 등 sourceErrors)의 목록으로는 지우지 않는다
    //   (그 밖 서버의 change_latest 를 지우면 돌아올 때 ‘첫 관찰’ 이 돼 그 사이 변화 · 소모품 ‘며칠째’ 를 잃는다). 그 주기는 직전 목록을 그대로 둔다.
    if (!sourceErrors.length) _lastLiveKeys = live;
    /*
     * v2.929(5단계): 점검 소모품 판정(detail_json 에 health — 이 노드 기준값) · 변경 이벤트 전이(직전 사실과 비교). **적재 전에** 해야 행이 소모품 칸을 싣는다.
     *   실패해도 수집은 실패가 아니다(사유는 _last.cycleOps).
     */
    let rulesNow = null; try { rulesNow = (await import('./perfRules.js')).loadPerfRules(); } catch { rulesNow = null; }
    const agentName = config.agent?.name || '';
    let cycleOps = null;
    try { cycleOps = await (await import('./cycleOps.js')).prepareCycleOps(results.filter((r) => r?.ok && r.built), { agent: agentName, rules: rulesNow || {}, now: Date.now() }); }
    catch (e) { cycleOps = { items: [], error: String(e?.message || e).slice(0, 200) }; }
    // ⚠ `_perIf`·`_perFc` 는 화면 상세용 내부 배열이다 — DB 적재 경로로 넘기지 않는다(오염 방지).
    const rows = results.filter((r) => r?.ok && r.built)
      .map((r) => { const { _perIf: _a, _perFc: _b, ...row } = r.built.row; return row; });
    // v2.922: 장치별 이력(5분 → 1시간)·마운트 일 롤업 — 행 밖 배열로 함께 넘긴다(1초 피크 표본은 이미 집계돼 없다).
    const okBuilt = results.filter((r) => r?.ok && r.built);
    const devices = okBuilt.flatMap((r) => r.built.devices || []);
    const mounts = okBuilt.flatMap((r) => r.built.mounts || []);
    const ins = await insertUsage(rows, config.agent?.name || '', { devices, mounts });
    let changeRes = null;
    if (cycleOps?.items?.length) {
      try { changeRes = await (await import('./opsDb.js')).changeWriteBatch({ agent: agentName, items: cycleOps.items }); }
      catch (e) { changeRes = { ok: false, reason: String(e?.message || e).slice(0, 200) }; }
    }
    // 7a단계: 로그 분석 — 파싱 · 분류 · 한 트랜잭션 쓰기(위치 비교 후 쓰기) · 함대 요약. 데모 대상은 합성 출력(같은 파서 · 분류 · 쓰기).
    let logRes = null;
    try {
      const DL = demo && demoTargets.length ? await import('../mock/demo/bmLogs.js') : null;
      logRes = await L.finishLogCycle(results, logCtx, { demoStdout: DL ? (tg, nowT) => (demo.isDemoBmTarget(tg) ? DL.demoLogStdout(tg, nowT, logCtx?.cursors?.get(tg.key) || null) : null) : null });
    } catch (e) { logRes = { error: String(e?.message || e).slice(0, 200) }; }
    if (logRes?.error && _srcErrLog('logs', logRes.error)) console.warn(`[bmusage] 로그 분석 주기 실패(로그만 이번 주기에 없다 — 읽기 위치는 넘어가지 않는다): ${logRes.error}`);
    /*
     * 임계 초과 알림(v2.551). ⚠ **적재 뒤에** 판정한다(알림은 저장된 값을 근거로 한다).
     * ⚠ 실패해도 수집을 실패로 만들지 않는다 — 알림은 부가 기능이고, 사유는 `_last` 에 남긴다.
     */
    let alerts = null;
    // v2.599(RECENT2599-01): 이번 수집 시간을 함께 넘긴다 — 관측 간격이 '주기 + 수집 시간' 이라
    //   주기만으로 연속을 판정하면 수집이 긴 현장에서 지속 시간이 0 에 묶여 알림이 영원히 안 울린다.
    const targetsByKey = new Map(targets.map((x) => [x.key, x]));
    try { alerts = await runBmUsageAlerts(rows, { ...settings, runMs: Date.now() - t0, ...(mj ? { maintJudge: mj } : {}), targetOf: (k) => targetsByKey.get(k) || null }); }
    catch (e) { alerts = { ok: false, error: String(e?.message || e).slice(0, 200) }; }
    // 6단계 수집 건강 — 적재 뒤 · 알림 판정 앞(‘수집 건강’ 규칙이 이번 주기 값을 쓴다).
    await recordCycleHealth({ results, t0, intervalMs, peakPlan });
    // v2.929(5단계): 리눅스 성능 알림 규칙(켠 규칙이 있을 때만 — 판정 입력은 이 노드가 이미 만든 값). 실패해도 수집은 실패가 아니다.
    let perfAlerts = null;
    try { perfAlerts = rulesNow ? await runCyclePerfAlerts(results, { settings, rules: rulesNow, agent: agentName }) : null; }
    catch (e) { perfAlerts = { ok: false, error: String(e?.message || e).slice(0, 200) }; }
    // 8a단계: ‘창 끝 뒤 억제 0’ 점검 — 이번 주기에 적용한 억제(수집 건너뜀 · 알림 보류 · 자동 집중)를 파일 기준으로 다시 만든 판정과 대조(수집 건강 행).
    let maintAudit = null;
    try { maintAudit = await (await import('./maint/runtime.js')).auditCycle({ targetsByKey }); } catch (e) { maintAudit = { error: String(e?.message || e).slice(0, 120) }; }
    if (_health?.node?.maint) _health.node.maint = { ..._health.node.maint, leak: maintAudit?.leak ?? null, checked: maintAudit?.checked ?? null, ...(mj?.meta ? { windows: mj.meta.n, localUnreadable: mj.meta.localUnreadable, deployed: mj.meta.deployed } : { judge: 'unavailable' }) };
    const okCount = results.filter((r) => r?.ok).length;
    _last = {
      at: Date.now(), ms: Date.now() - t0, servers: runCount,
      okCount, failCount: runCount - okCount - skippedResults.length, inserted: ins.inserted || 0, ...(skippedResults.length ? { maintSkipped: skippedResults.length } : {}), ...(demoOnly ? { demoOnly: true, skippedNonDemo } : {}),
      /*
       * Enterprise 대체 수집 요약(v2.554) — 화면이 '동의했는데 왜 값이 없나' 를 말할 수 있게.
       * ⚠ 개수만 담는다(장비 이름·법인은 담지 않는다 — `status.last` 는 무스코프로 나간다. v2.550.3).
       */
      ent: {
        tried: results.filter((r) => r?.ent && !r.ent.skipped).length,
        ok: results.filter((r) => r?.ent?.ok).length,
        deferred: _entDeferred,
        viaApi: results.filter((r) => r?.ent?.ok && String(r.ent.via || '').includes('api')).length,
        viaSsh: results.filter((r) => r?.ent?.ok && String(r.ent.via || '').includes('ssh')).length,
        unparsed: results.filter((r) => r?.ent && r.ent.kind === 'unparsed').length,
      },
      // v2.922: 피크 창 결정(창 길이·사유·예상 소요·예산 — 수집 건강 ⑫ 이 쓸 값).
      peakPlan: (({ steps: _s, ...p }) => p)(peakPlan),
      // v2.922(반증 D6): 마이그레이션 상태(단계 · 시도 · 다음 재시도) — 수집 건강 ⑫ 이 쓸 값.
      migration: migrationLast(),
      dbOk: !!ins.ok, dbError: ins.error || null, ...(ins.migrateError ? { dbMigrateError: { count: ins.migrateError.count, at: ins.migrateError.at } } : {}), counts, ...srcErr, trigger, ...(demo ? { demo: true } : {}),
      alerts: alerts && !alerts.skipped ? { sent: alerts.sent ?? 0, suppressed: alerts.suppressed ?? 0, capped: alerts.capped ?? 0, over: alerts.counts?.over ?? 0, error: alerts.error || null } : null,
      // v2.929(5단계): 소모품 · 변경 이벤트 · 성능 알림 규칙 — 개수만(서버 이름 없음 · status 는 무스코프로 나간다).
      ...(perfAlerts?.skipped ? { perfAlertsSkipped: perfAlerts.skipped } : {}),
      cycleOps: cycleOps ? { health: cycleOps.health ?? 0, events: cycleOps.events ?? 0, written: changeRes?.ok ? changeRes.events ?? 0 : null, error: cycleOps.error || (changeRes && !changeRes.ok ? changeRes.reason || 'write-failed' : null) } : null,
      // 7a단계 로그 분석 — 개수만(서버 이름 없음).
      logs: logRes || null,
      perfAlerts: perfAlerts && !perfAlerts.skipped ? { fires: perfAlerts.fires ?? 0, queued: perfAlerts.queued ?? 0, deferred: perfAlerts.deferred ?? 0, capped: perfAlerts.capped ?? 0, autoFocus: perfAlerts.autoFocus ?? 0, issues: perfAlerts.issues ?? 0, ...(perfAlerts.warmup ? { warmup: true } : {}), error: perfAlerts.error || null } : null,
    };
    return { ok: true, ...(_last) };
  } catch (e) {
    _last = { at: Date.now(), ms: Date.now() - t0, error: String(e?.message || e).slice(0, 300), trigger };
    await recordCycleHealth({ results: [], t0, intervalMs: loadBmUsageSettings().intervalMs, error: 'cycle-error' }).catch(() => {});
    await runNodeCollectAlert();
    return { ok: false, reason: _last.error };
  } finally { _running = false; }
}

/**
 * v2.929(5단계) — 이번 주기 알림 규칙 입력을 모은다: 성능 항목(이 노드 판정 — perfForRows 와 같은 buildPerfEntry) · 소모품 칸(방금 detail_json 에 넣은 것) ·
 *   베이스라인 이탈(그 규칙이 켜졌을 때만 — 슬롯 평균은 한 시간에 한 번 읽는다) · 용도 점검(그 규칙이 켜졌을 때만 — 이 노드의 수동 태그 · 자동 감지).
 */
async function runCyclePerfAlerts(results, { settings, rules, agent }) {
  // 규칙 파일 손상(보존본만 남음)이면 ‘켠 규칙 없음’ 과 구별해 상태에 남긴다 — 기본값(전부 꺼짐)으로 조용히 꺼진 것처럼 보이지 않게(규칙 화면 · 서비스 점검이 손상을 밝힌다).
  if ((await import('./perfRules.js')).perfRulesLoadError()) return { ok: false, skipped: 'settings-unreadable' };
  const on = Object.keys(rules?.rules || {});
  if (!on.length) return { ok: true, skipped: 'no-rules' };
  const { buildPerfEntry, parseJsonCol } = await import('./perfView.js');
  const { freshMsFor } = await import('./useJudge.js');
  const { hwFactsReader } = await import('./hwFacts.js');
  const now = Date.now();
  const hwOf = await hwFactsReader({ agent, now, freshMs: freshMsFor(settings.intervalMs) }).catch(() => () => null);
  let bands = null;
  if (on.includes('baseline')) {
    // 8a단계 ⑤: 정비 창(롤업 제외) 구간의 주는 베이스라인 표본에서 뺀다(판정 코어 maint/judge.js — 이 노드의 창 + 중앙 배포본).
    let ex = null;
    try { const R = await import('./maint/runtime.js'); const tmap = new Map(results.filter((r) => r?.target).map((r) => [r.target.key, r.target])); ex = R.exclusionFor(await R.maintJudge({ now }), (k) => tmap.get(k)); } catch { ex = null; }
    try { bands = await (await import('./baseline.js')).slotBands({ agent, cfg: rules.baseline, intervalMs: settings.intervalMs, now, ...(ex ? { exclOf: ex.exclOf, exclSig: ex.sig } : {}) }); } catch { bands = null; }
  }
  const B = bands ? await import('./baseline.js') : null;
  // 7a단계: 로그 규칙 입력(이번 주기에 로그를 읽은 서버만 — 못 읽은 서버는 없음 = 판정 보류)
  const LA = on.includes('logs') ? (await import('./logs/run.js')).logAlertInputs() : null;
  const M = on.includes('profile') ? await import('./profiles/match.js') : null;
  const FT = on.includes('profile') ? await import('../insights/fleetTags.js').catch(() => null) : null;
  const items = [];
  for (const r of results) {
    if (!r?.ok || !r.built?.row || !r.target) continue;
    const row = { ...r.built.row, key: r.target.key, ts: r.built.row.ts ?? now };
    const entry = buildPerfEntry({ row, hw: hwOf(r.target) || null, th: settings.perf, intervalMs: settings.intervalMs, now, full: false });
    const detail = parseJsonCol(row.detail_json);
    let profile = null;
    if (M) {
      let manual = null;
      try { manual = FT ? (FT.fleetPurposeOf(String(r.target.serviceTag || '')) || FT.fleetPurposeOf(r.target.key)) : null; } catch { manual = null; }
      try { profile = M.profileView({ tuning: parseJsonCol(row.tuning_json), detail, entry, row, manual }); } catch { profile = null; }
    }
    items.push({ key: r.target.key, name: r.target.name || r.target.key, vcenterId: r.target.vcenterId || '', target: r.target, entry, health: detail?.health || null,
      dev: B ? B.deviationsFor(bands, r.target.key, row) : null, profile, logs: LA ? LA.get(r.target.key) || null : null });
  }
  // 6단계 ‘수집 건강’ — 서버가 아니라 이 노드 한 칸(key '__node__' · 법인 공용). 칸은 이번 주기 recordCycleHealth 가 기준과 대 본 결과 그대로.
  const nodeItem = on.includes('collect') ? collectNodeItem(agent) : null;
  if (nodeItem) items.push(nodeItem);
  return (await import('./perfAlerts.js')).runPerfAlerts(items, { rules, now });
}
function collectNodeItem(agent) {
  if (!_health?.node?.cells) return null;
  const h = _health.node;
  return { key: '__node__', name: `수집 노드 ${agent || '(이 노드)'}`, vcenterId: '', collect: { cells: h.cells, cyclePct: h.cyclePct, successPct: h.successPct, dbPct: h.dbPct, th: h.th, error: h.error || null } };
}
/**
 * 실패 · 0대 주기(분류 실패 · 주기 예외 · 대상 없음)에도 ‘수집 건강’ 규칙만 돌린다(반증 F1 — 예전에는 이 경로가 알림 판정 전에 돌아가 규칙이 실패를 못 잡았다).
 *   서버 항목은 넣지 않는다(다른 규칙의 서버 상태는 evaluatePerfRules 가 CARRY_MS 동안 들고 간다 — 지우지 않는다). 실패해도 주기 결과를 바꾸지 않는다.
 */
async function runNodeCollectAlert() {
  try {
    const R = await import('./perfRules.js');
    if (R.perfRulesLoadError()) return { ok: false, skipped: 'settings-unreadable' };
    const rules = R.loadPerfRules();
    if (!rules?.rules?.collect?.on) return { ok: true, skipped: 'off' };
    const item = collectNodeItem(config.agent?.name || '');
    if (!item) return { ok: true, skipped: 'no-health' };
    return await (await import('./perfAlerts.js')).runPerfAlerts([item], { rules });
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 160) }; }
}
/**
 * 8a단계 — 창 안 수집 실패 표시(순수): 실패한 결과 중 **인증 거부가 아닌 것**에만 inMaint 를 단다(인증 거부는 창과 무관 — authGuard 가 정지하고 실패로 센다).
 *   창(아무 억제 범위나) 안이면 ‘정비 중’ 으로 성공률에서 빼고 따로 센다(summarizeCycle). 표시한 결과 목록을 돌려준다.
 */
export function markInMaint(results = [], maintOf = () => null) {
  const marked = [];
  for (const r of results) {
    if (!r || r.ok || !r.target) continue;
    const authFail = !!(r.os?.authStopped || r.idrac?.authStopped || r.ent?.authStopped || (r.os && r.os.ok === false && isAuthFailureText(r.os.error))
      || r.idrac?.kind === 'auth' || r.ent?.kind === 'auth' || r.ent?.kind === 'ssh-auth' || isAuthFailureText(r.error));
    if (authFail) continue;
    const ms = maintOf(r.target);
    if (ms?.active) { r.inMaint = { ids: ms.windows.map((w) => w.id) }; marked.push(r); }
  }
  return marked;
}
let _focusEndHooked = false;
export function startBmUsagePoller() {
  if (_timer) return;
  // v2.929(5단계): 집중 결론 규칙 — 세션이 끝날 때 한 번(focus/run.js). 기동 때 한 번만 구독한다.
  if (!_focusEndHooked) {
    _focusEndHooked = true;
    // 반증 F13: 재시작 뒤 남은 집중 세션(타이머 없음)을 기동 때 닫는다 — 봉투 · 함대 칩이 죽은 세션을 ‘진행 중’ 으로 보이지 않게.
    initFocus().catch(() => {});
    onFocusEnd(async (ev) => {
      try { const rules = (await import('./perfRules.js')).loadPerfRules(); await (await import('./perfAlerts.js')).runFocusEndAlert(ev, { rules }); }
      catch (e) { console.warn(`[bmusage] 집중 결론 알림 실패: ${String(e?.message || e).slice(0, 160)}`); }
    });
  }
  // ⚠ 인자 순서는 `(getMs, fn, opts)` — 매 틱 주기를 다시 읽어야 설정 변경이 재시작 없이 먹는다.
  _timer = startAdaptiveTimer(() => loadBmUsageSettings().intervalMs, bmUsageTimerTick,
    { name: 'bmusage', firstDelayMs: 45_000, subscribe: onBmUsageSettingsChange });
  console.log('[bmusage] 폴러 등록(설정에서 켜면 수집 시작)');
}

export function stopBmUsagePoller() { _timer?.stop?.(); _timer = null; }
export function _resetForTest() { _lastLiveKeys = null; _lastRepair = null; _cycleSamples = []; _peakPlan = null; _prev.clear(); _authStopped.clear(); _detail.clear(); _last = null; _running = false; _pruneTick = 0; _lastPrune = null; _fleetOverride = null; _health = null; _healthSince = new Map(); guard._resetForTest(); }
/** 테스트 전용 — 분류 함수 대체(EDGE2628-03) · 인메모리 상태 주입(EDGE2628-02). */
export function _setFleetForTest(fn) { _fleetOverride = typeof fn === 'function' ? fn : null; }
export function _seedStateForTest({ prev = [], authStopped = [] } = {}) {
  for (const k of prev) _prev.set(k, { at: Date.now() });
  for (const k of authStopped) _authStopped.set(k, { attempts: 1 });
}
export { guard as _authGuardForTest };

// v2.929(5단계): 집중 모니터링이 쓰는 폴러 함수 등록 — focus/run.js 가 이 파일을 import 하지 않게(순환 방지 · arch2579).
// 같은 인증 가드(정지 · 해제) · 같은 이전 카운터 · 같은 iDRAC 텔레메트리 작업을 쓴다(두 벌 금지).
registerFocusPollerHooks({ idracTelemetryJob, prevCountersFor, osAuthStopFor, idracAuthStopFor, recordOsAuthOutcome, recordIdracAuthOutcome });
