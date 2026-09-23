/**
 * bmusage/poller.js — 베어메탈 사용률 주기 수집(v2.550).
 *
 * ── CLAUDE.md 폴러 규약을 전부 지킨다 ───────────────────────────────────────
 *  ① **재진입 가드** — 이전 주기가 주기를 넘기면 이번 틱을 건너뛴다. 수동 실행('지금 수집')도
 *     **같은 가드를 공유**한다(연타가 SSH·Redfish 세션을 곱하지 않게 — `net/monitor` 패턴).
 *  ② **동시 수집 제한**(`BMUSAGE_CONCURRENCY` 기본 4) — 200대를 한꺼번에 찌르면 매 주기 SSH
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
import { config } from '../config.js';
import { store } from '../store.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { withDeadline } from '../proxy/sshExec.js';
import { createAuthGuard, isAuthFailureText } from '../util/authGuard.js';
import { loadBmUsageSettings, bmUsageEnabled, enterpriseActive, onBmUsageSettingsChange } from './settings.js';
import { resolveTargets } from './targets.js';
import { enterpriseEligible } from './license.js';
import { collectEnterpriseUsage, SESSION_BUDGET_MS as ENT_BUDGET_MS } from './collectors/idracEnterprise.js';
import { buildUsage } from './usage.js';
import { collectOsUsage } from './collectors/osSsh.js';
import { insertUsage, pruneUsage } from './db.js';
import { recordBmUsage } from './activityLog.js';
import { runBmUsageAlerts, alertStateInfo } from './notify.js';
import { poolSettled } from '../util/pool.js'; // v2.579: 동시성 풀 단일 소스
import { idracAuthStopFor, releaseIdracAuthStop } from '../idrac/poller.js'; // v2.590: 같은 iDRAC 계정을 쓰는 주 폴러의 인증 실패 정지

const CONCURRENCY = Math.max(1, Number(process.env.BMUSAGE_CONCURRENCY) || 4);
const DEVICE_TIMEOUT_MS = Math.max(20_000, Number(process.env.BMUSAGE_DEVICE_TIMEOUT_MS) || 60_000);
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

export function bmUsageStatus() {
  const s = loadBmUsageSettings();
  return {
    enabled: bmUsageEnabled(), running: _running, intervalMs: s.intervalMs,
    concurrency: CONCURRENCY, deviceTimeoutMs: DEVICE_TIMEOUT_MS,
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
  };
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

/** 대상 해석 — 스냅샷·등록부를 읽어 온다(장비에 접속하지 않는다). */
export async function currentTargets() {
  const s = loadBmUsageSettings();
  const snap = store.get();
  const [{ getFleetInventory }, { loadRegistry }, { listBmServersRaw }, { getInventory }] = await Promise.all([
    import('../insights/fleetInventory.js'), import('../idrac/registry.js'), import('../bmstor/registry.js'),
    import('../idrac/invCache.js'),
  ]);
  const fleet = await getFleetInventory(snap).catch(() => ({ bareMetal: [] }));
  const registry = (() => { try { return loadRegistry(); } catch { return []; } })();
  const bmServers = (() => { try { return listBmServersRaw(); } catch { return []; } })();
  const isEdge = !!config.agent?.centralUrl;
  return {
    settings: s,
    ...resolveTargets({
      bareMetal: fleet.bareMetal || [], registry, bmServers, settings: s,
      agentName: config.agent?.name || '', isEdge,
      // ⚠ **캐시된** 인벤토리만 읽는다(장비 왕복 0) — 라이선스 등급 판정용(v2.554).
      inventoryOf: (id) => getInventory(id),
    }),
    vcenters: (snap?.vcenters || []).map((v) => ({ id: v.id, name: v.name || v.id })),
    isEdge,
  };
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
    username: target.osHost.username, password: target.osHost.password,
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
  try { return idracAuthStopFor({ id: i.regId, username: i.username, password: i.password }); } catch { return null; }
}

/** 화면이 '몇 대가 정지됐나' 를 말할 수 있게 이번 주기의 정지분을 기억한다. */
const _authStopped = new Map();

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
async function collectOne(target, { trigger = 'auto' } = {}) {
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
      : import('../idrac/redfish.js').then((m) => m.fetchUsage(target.idrac, { full, allowList })).catch((e) => ({ ok: false, kind: 'unreachable', error: String(e?.message || e).slice(0, 300) })));
  jobs.push((target.paths.includes('os') && !stopped)
    ? withDeadline(DEVICE_TIMEOUT_MS, (signal) => collectOsUsage(target.osHost, { signal }), 'OS 수집 시한 초과')
      .catch((e) => ({ ok: false, error: String(e?.message || e).slice(0, 300) }))
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
        (signal) => collectEnterpriseUsage(target.idrac, { mode: loadBmUsageSettings().enterpriseMode, allowProbe, signal }),
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

  const built = buildUsage({ target, idrac, os, ent, prev: _prev.get(target.key) || null, now: sampledAt });
  if (built.next) _prev.set(target.key, built.next);
  const ok = !!(idrac?.ok || os?.ok || ent?.ok);
  recordBmUsage({
    // ⚠ `idracHost` 는 `publicTarget()` 이 만드는 응답용 필드다 — **내부 target 에는 없다**.
    //   `target.idracHost` 로 읽으면 iDRAC 전용 서버의 작업 로그에 host 가 빈 칸으로 남는다.
    deviceId: target.key, name: target.name, host: target.osHost?.host || target.idrac?.host || '',
    source: config.agent?.name || 'central', ok, durationMs: Date.now() - t0,
    error: ok ? null : (os?.error || ent?.error || idrac?.error || '수집 경로 전부 실패'),
    // ⚠ 실패 주기의 수치는 싣지 않는다(0 은 '부하 없음' 이라는 거짓).
    ...(ok ? { cpuPct: built.row.cpu_pct, memPct: built.row.mem_pct, diskBusyPct: built.row.disk_busy_pct, netPct: built.row.net_pct, hbaPct: built.row.hba_pct } : {}),
  });
  return { ok, target, built, idrac, os, ent };
}

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
export async function pollBmUsageOnce({ trigger = 'auto' } = {}) {
  if (!bmUsageEnabled()) return { ok: false, reason: '베어메탈 사용률 수집이 꺼져 있습니다(설정에서 켜세요).' };
  if (_running) return { ok: false, reason: '이전 수집이 진행 중입니다.' };
  _running = true;
  const t0 = Date.now();
  try {
    const { targets, counts, settings } = await currentTargets();
    if (!targets.length) {
      _last = { at: Date.now(), ms: Date.now() - t0, servers: 0, okCount: 0, failCount: 0, inserted: 0, counts, trigger };
      return { ok: true, servers: 0, counts, reason: '대상 서버가 없습니다.' };
    }
    _listBudget = LIST_BUDGET_PER_RUN;   // ⚠ 주기 시작마다 리셋(위 상수 주석 참조)
    _entBudget = ENT_BUDGET_PER_RUN;
    _entProbeBudget = ENT_PROBE_PER_RUN;
    _entDeferred = 0;
    const results = await pool(targets, CONCURRENCY, (tg) => collectOne(tg, { trigger }).catch((e) => ({ ok: false, target: tg, error: String(e?.message || e) })));
    /*
     * ⚠ **대상에서 사라진 키를 버린다**(v2.550.3): `_prev` 는 서버마다 누적 카운터 배열(디스크·NIC·
     *   HBA)을 들고 있어 서버당 수 KB 다. 법인을 끄거나 등록부에서 서버가 빠져도 예전에는 그 항목이
     *   프로세스 수명 내내 남았다 — 등록부를 오래 편집하는 현장에서 조용히 늘어나는 누수다.
     *   더 나쁜 것: 서버가 **되돌아오면** 몇 시간 전 카운터와 비교해 `MAX_SPAN_MS`(1시간) 상한에
     *   걸려 그 주기가 통째로 `null` 이 된다(첫 수집이라고 말하지도 않는다).
     */
    const live = new Set(targets.map((t2) => t2.key));
    for (const k of _prev.keys()) if (!live.has(k)) _prev.delete(k);
    // ⚠ iDRAC 정지 키는 `<key>|idrac` 이므로 접미를 떼고 대조한다(안 떼면 영원히 남는다 — 누수).
    for (const k of _authStopped.keys()) if (!live.has(String(k).replace(/\|idrac$/, ''))) _authStopped.delete(k);
    // ⚠ `_perIf`·`_perFc` 는 화면 상세용 내부 배열이다 — DB 적재 경로로 넘기지 않는다(오염 방지).
    const rows = results.filter((r) => r?.ok && r.built)
      .map((r) => { const { _perIf: _a, _perFc: _b, ...row } = r.built.row; return row; });
    const ins = await insertUsage(rows, config.agent?.name || '');
    /*
     * 임계 초과 알림(v2.551). ⚠ **적재 뒤에** 판정한다(알림은 저장된 값을 근거로 한다).
     * ⚠ 실패해도 수집을 실패로 만들지 않는다 — 알림은 부가 기능이고, 사유는 `_last` 에 남긴다.
     */
    let alerts = null;
    try { alerts = await runBmUsageAlerts(rows, settings); }
    catch (e) { alerts = { ok: false, error: String(e?.message || e).slice(0, 200) }; }
    const okCount = results.filter((r) => r?.ok).length;
    await pruneUsage({ rawDays: settings.rawRetentionDays, dailyDays: settings.dailyRetentionDays, every: PRUNE_EVERY });
    _last = {
      at: Date.now(), ms: Date.now() - t0, servers: targets.length,
      okCount, failCount: targets.length - okCount, inserted: ins.inserted || 0,
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
      dbOk: !!ins.ok, dbError: ins.error || null, counts, trigger,
      alerts: alerts && !alerts.skipped ? { sent: alerts.sent ?? 0, suppressed: alerts.suppressed ?? 0, capped: alerts.capped ?? 0, over: alerts.counts?.over ?? 0, error: alerts.error || null } : null,
    };
    return { ok: true, ...(_last) };
  } catch (e) {
    _last = { at: Date.now(), ms: Date.now() - t0, error: String(e?.message || e).slice(0, 300), trigger };
    return { ok: false, reason: _last.error };
  } finally { _running = false; }
}

export function startBmUsagePoller() {
  if (_timer) return;
  // ⚠ 인자 순서는 `(getMs, fn, opts)` — 매 틱 주기를 다시 읽어야 설정 변경이 재시작 없이 먹는다.
  _timer = startAdaptiveTimer(() => loadBmUsageSettings().intervalMs, async () => {
    if (!bmUsageEnabled()) return;
    await pollBmUsageOnce({ trigger: 'auto' });
  }, { name: 'bmusage', firstDelayMs: 45_000, subscribe: onBmUsageSettingsChange });
  console.log('[bmusage] 폴러 등록(설정에서 켜면 수집 시작)');
}

export function stopBmUsagePoller() { _timer?.stop?.(); _timer = null; }
export function _resetForTest() { _prev.clear(); _authStopped.clear(); _last = null; _running = false; guard._resetForTest(); }
export { guard as _authGuardForTest };

