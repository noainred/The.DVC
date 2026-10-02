/**
 * horizon/sessionPoller.js — Horizon 실시간 사용자 주기 수집(v2.525). 기본 5분.
 *
 * CLAUDE.md 규약 전부 적용:
 *  · 재진입 가드(폴러 + 수동 '지금 수집' 이 **같은 가드를 공유**한다 — net/monitor.runMonitorNow 패턴)
 *  · 적응형 타이머 + 설정 변경 즉시 재무장(주기를 모듈 로드 시 굳히지 않는다 — v2.409)
 *  · Connection Server 동시 수집 제한 + 서버당 시한(느린 1곳이 다음 주기를 막지 않는다)
 *  · prune 은 `(++tick % N) === 0`(기동 첫 틱을 피한다 — v2.453)
 *
 * ── 전체 합계를 '전체 latest 로부터' 다시 계산하는 이유 ─────────────────────────
 * 이번 주기에 **실패한 서버**가 있으면 그 서버만으로 합계를 쓰면 사용자 수가 뚝 떨어진 것처럼
 * 보인다. 그래서 적재 직후 `hzLatestRecords()` 전량으로 다시 집계하고, **실패 서버 수를
 * 계열에 함께 싣는다**(`serversFailed`) — 화면이 '수치가 왜 낮은지' 를 말할 수 있게.
 * ⚠ 다만 실패 서버의 **직전 값을 합계에 넣지 않는다** — 그건 지금 값이 아니다. 대신 빠졌다는
 *   사실을 밝힌다(v2.520 `stale` 처리와 같은 판단).
 */
import { loadHorizon } from './horizon.js';
import { store } from '../store.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { withJob } from '../perf/monitor.js';
import { describeError } from '../util/errors.js';
import { createAuthGuard } from '../util/authGuard.js';
import { isStopped } from '../security/emergencyStop.js';
import { load as loadHzSettings, onHorizonSessionSettingsChange } from './sessionSettings.js';
import { collectServerSessions, mockSessionResult } from './sessionCollect.js';
import { commitHzSessions, hzLatestRecords, pruneHzSessions, pruneHzUsage, hzSessionDbStatus, dropHzLatest } from './sessionDb.js';
import { combineServers, seriesRow } from './sessions.js';
import { recordHzSessionActivity } from './sessionActivityLog.js';
import { poolSettled } from '../util/pool.js'; // v2.579: 동시성 풀 단일 소스
import { clampIntervalMs } from '../config.js';
import { localStamp } from '../util/dayKey.js';

const CONCURRENCY_CAP = 8;
const PRUNE_EVERY_RUNS = 12;                        // 5분 × 12 = 1시간에 1회
const FIRST_DELAY_MS = Number(process.env.HZSESS_FIRST_DELAY_MS) || 60_000;

let running = false;
let tick = 0;
let lastResult = null;
let lastRunTs = 0;
let timer = null;
const inFlight = new Map();                         // serverId -> startedAt ('진행중' 구획의 원천)

/**
 * 인증 실패(401/403) 서버의 **주기 수집 정지**(v2.535 자격증명 감사).
 *
 * 왜: `sessionCollect.js` 는 401/403 을 `kind:'auth'` 로 정확히 분류하는데 v2.534 까지 아무도
 * 그것을 소비하지 않았다 — 폴러는 화면 표시용 `errors` 에 담기만 하고 다음 주기에 **같은 AD
 * 계정으로 다시 로그인**했다. 주기 기본 5분·하한 60초라 서버 1대당 하루 288~1,440회 실패
 * 로그인이고, 그것이 **AD 서비스 계정을 스스로 잠그는 경로**다(비밀번호 회전·오타만으로 발생).
 * 스토리지에는 v2.528 부터 같은 방어가 있었는데 Horizon 에만 없었다 — 그 비대칭을 없앤다.
 *
 * ⚠ 파일을 스토리지와 **나눈다**(`horizon-auth-stops.json`) — 한 파일에 섞으면 두 도구의 id 가
 *   충돌해 엉뚱한 대상이 멈춘다.
 */
const authGuard = createAuthGuard({ file: 'horizon-auth-stops.json' });

/** 테스트용 — 정지 기록 초기화. */
export function _resetHzAuthGuard() { authGuard._resetForTest(); }

/**
 * v2.686 HZT-07: 세션 경로가 404(이 버전에 없음)인 서버는 다음 주기에도 404 다 — 실장비 7.13.1 이 그랬다(사용자 curl).
 * 그대로 두면 주기(기본 5분)마다 AD 로그인·404·로그아웃을 무기한 반복한다. 그래서 **주기 수집만** 쉬고
 * (`HZSESS_NO_ENDPOINT_BACKOFF_MS`, 기본 6시간), 그 사실과 다음 확인 시각을 결과에 싣는다(조용히 멈추지 않는다).
 * ⚠ '지금 수집'(수동)은 막지 않고, 주소·계정·도메인이 바뀌거나 한 번 성공하면 즉시 지운다.
 * 인메모리다 — 재시작하면 한 번 다시 확인하고 다시 쉰다(영속할 만큼 비싼 정보가 아니다).
 */
// 기본 21_600_000 = 6시간(env-doc 생성기가 곱셈식의 첫 숫자를 기본값으로 읽어 '6' 이라 적었다 — HZ2686-R7).
const NO_ENDPOINT_BACKOFF_MS = clampIntervalMs(Number(process.env.HZSESS_NO_ENDPOINT_BACKOFF_MS) || 21_600_000, 21_600_000, 600_000);
/**
 * 쉬게 하는 종류 — 다음 주기에도 같은 결과가 나올 것이 확실한 것만(v2.686 HZ2686-R3·SEC-2686-02).
 * 로그인 API 없음·토큰 없는 응답은 그 주소가 커넥션 서버가 아닐 수 있어, 주기마다 AD 자격증명을 그쪽으로 보내지 않게 쉰다.
 */
export const BACKOFF_KINDS = Object.freeze(['no-endpoint', 'no-login-endpoint', 'no-token']);
/** 로그인이 **성공한** 결과 — 자격증명이 받아들여졌으므로 인증 정지를 풀어도 된다(HZ2686-R1). */
const LOGIN_OK_KINDS = new Set(['ok', 'forbidden', 'no-endpoint', 'unparsed']);
const _noEndpoint = new Map();                      // serverId -> { until, sig }
const accessSig = (srv) => `${srv.host || ''}|${srv.username || ''}|${srv.domain || ''}`.toLowerCase();
export function _resetHzNoEndpoint() { _noEndpoint.clear(); }
/** 연결 테스트가 세션 조회 성공을 확인하면 쉬는 기록을 지운다(HZ2686-R2 — 업그레이드 뒤 6시간 낡은 404 금지). */
export function clearHzNoEndpoint(id) { if (id) _noEndpoint.delete(String(id)); }
export function noEndpointBackoffFor(srv, now = Date.now()) {
  const ne = _noEndpoint.get(srv?.id);
  if (!ne) return null;
  if (ne.sig !== accessSig(srv)) { _noEndpoint.delete(srv.id); return null; }   // 등록을 고쳤다 — 즉시 다시 확인
  return ne.until > now ? ne : null;
}

export function hzSessionPollerStatus() {
  const s = loadHzSettings();
  return {
    running, lastResult, lastRunTs,
    intervalMs: s.intervalMs, enabled: s.enabled,
    concurrency: Math.min(CONCURRENCY_CAP, s.concurrency),
    retentionDays: s.retentionDays,
    inFlight: [...inFlight.entries()].map(([id, at]) => ({ deviceId: id, at })),
  };
}

// v2.579(ARCH-01): 풀 스캐폴드는 util/pool.js 하나다 — 항목별 결과 모양(예전 그대로)만 여기서 입힌다.
async function pool(items, n, fn) {
  return (await poolSettled(items, n, fn)).map((r) => (r.status === 'fulfilled' ? { ok: true, value: r.value } : { ok: false, error: r.reason }));
}

/** 대상 서버 — 등록 + 활성 + 설정에서 끄지 않은 것. */
export function targetServers(settings = loadHzSettings()) {
  return loadHorizon().filter((s) => s.enabled !== false && settings.servers?.[s.id]?.enabled !== false);
}

/** 수집 1회(자동·수동 공용 — 같은 재진입 가드). */
export async function runHzSessionsNow(trigger = 'manual') {
  if (running) return { ok: false, skipped: true, reason: '이미 수집이 진행 중입니다.' };
  running = true;
  const started = Date.now();
  try {
    if (isStopped()) { lastResult = { at: Date.now(), trigger, skipped: '긴급중단' }; return { ok: false, ...lastResult }; }
    const s = loadHzSettings();
    if (!s.enabled && trigger !== 'manual') return { ok: false, reason: '수집이 꺼져 있습니다(설정에서 켜세요).' };
    const db = await hzSessionDbStatus();
    if (!db.available) return { ok: false, reason: `DB 를 쓸 수 없습니다: ${db.error || 'node:sqlite 없음'}` };

    const mock = store.get()?.source === 'mock';
    const servers = targetServers(s);
    if (!servers.length) {
      lastRunTs = Date.now();
      lastResult = { at: lastRunTs, trigger, servers: 0, records: 0, errors: [], ms: Date.now() - started };
      return { ok: true, ...lastResult, reason: '대상 Horizon 서버가 없습니다(설정 › Horizon 등록에서 추가하세요).' };
    }

    // ⚠ **수동 실행은 막지 않는다**(authGuard 규칙 3) — 사람이 1회 누르는 것은 잠금 위험이 없고,
    //   비밀번호를 고쳤는지 확인할 길을 없애면 안 된다. 막는 것은 주기 수집뿐이다.
    const periodic = trigger !== 'manual';
    const results = await pool(servers, Math.min(CONCURRENCY_CAP, s.concurrency), (srv) => withJob(`horizon.sessions:${srv.id}`, async () => {
      inFlight.set(srv.id, Date.now());
      try {
        let stop = periodic && !mock ? authGuard.authStopFor(srv) : null;
        // v2.686 HZ2686-R1: v2.685 까지는 로그인 뒤 403(역할 권한)도 'auth' 로 세어 정지를 남겼다. 그 정지는 로그인 단계
        //   실패가 아니므로 풀고 다시 시도한다(이유 문구가 '세션 조회 실패' 로 시작한다 — 로그인 실패는 'Horizon 로그인 실패').
        if (stop && /^세션 조회 실패/.test(String(stop.reason || ''))) { authGuard.clearAuthStop(srv.id); stop = null; }
        if (stop) {
          // ⚠ **조용히 멈추지 않는다**(규칙 1) — 정지 사실·시각·시도 횟수를 그대로 실어 화면이 말한다.
          //   말없이 건너뛰면 사용자는 '수집이 되는 줄' 안다.
          return {
            serverId: srv.id, name: srv.name || srv.id, host: srv.host,
            ok: false, kind: 'auth-stopped', authStopped: stop,
            error: `인증 실패로 주기 수집을 멈췄습니다 — ${stop.reason}`,
            hint: '설정 › Horizon 등록에서 비밀번호를 고치면 자동으로 재개합니다(‘지금 수집’ 은 그대로 동작합니다).',
            parsed: false, sessions: null, connected: null, disconnected: null, pending: null,
            users: null, usersConnected: null, names: [], pools: [],
            usersOmitted: 0, poolsOmitted: 0, usedUserKey: null, usedStateKey: null, userIdOnly: false,
          };
        }
        const ne = periodic && !mock ? noEndpointBackoffFor(srv) : null;
        if (ne) {
          // 활동 로그에는 남기지 않는다 — 시도하지 않은 주기를 이벤트로 쌓으면 상한을 비이벤트로 소진한다(v2.517 규약).
          return {
            serverId: srv.id, name: srv.name || srv.id, host: srv.host,
            ok: false, kind: ne.kind || 'no-endpoint', backoffUntil: ne.until,
            error: `${ne.kind === 'no-login-endpoint' ? '이 주소에 로그인 API 가 없습니다(404)' : ne.kind === 'no-token' ? '로그인 응답에 토큰이 없었습니다' : '이 커넥션 서버에는 세션 목록 API 가 없습니다(404)'} — 주기 수집은 ${localStamp(ne.until)} 에 다시 확인합니다`,
            hint: '주기마다 로그인하지 않으려고 쉬는 중입니다. ‘지금 수집’ 은 그대로 동작합니다.',
            parsed: false, sessions: null, connected: null, disconnected: null, pending: null,
            users: null, usersConnected: null, names: [], pools: [],
            usersOmitted: 0, poolsOmitted: 0, usedUserKey: null, usedStateKey: null, userIdOnly: false,
          };
        }
        const r = mock ? mockSessionResult(srv) : await collectServerSessions(srv, {
          pageSize: s.pageSize, maxPages: s.maxPages, maxUsers: s.maxUsers, timeoutMs: s.timeoutMs,
        });
        // 401/403 이면 다음 **주기**부터 멈춘다. 성공하면 기록을 지워 재개한다(규칙 2 — 자격증명이
        // 바뀌면 `authStopFor` 가 credHash 비교로 이미 자동 재개하므로 여기는 성공 경로만 본다).
        if (!mock) {
          if (r?.kind === 'auth') authGuard.markAuthStopped(srv.id, srv, r.error || '인증·권한 거부');
          else if (r?.ok || LOGIN_OK_KINDS.has(r?.kind)) authGuard.clearAuthStop(srv.id);   // 로그인이 됐으면 자격증명은 맞다
          if (BACKOFF_KINDS.includes(r?.kind)) _noEndpoint.set(srv.id, { until: Date.now() + NO_ENDPOINT_BACKOFF_MS, sig: accessSig(srv), kind: r.kind });
          else if (r?.ok) _noEndpoint.delete(srv.id);
        }
        recordHzSessionActivity({
          deviceId: srv.id, name: srv.name || srv.id, host: srv.host, source: 'central',
          ok: !!r.ok, durationMs: r.ms ?? null, error: r.error || null,
          // ⚠ 실패 주기의 수치는 null(위 머리말) — `r.sessions` 가 이미 null 이다.
          sessions: r.ok ? r.sessions : null, users: r.ok ? r.users : null,
        });
        return { serverId: srv.id, name: srv.name || srv.id, host: srv.host, ...r };
      } finally { inFlight.delete(srv.id); }
    }));

    const records = []; const errors = [];
    results.forEach((r, i) => {
      const srv = servers[i];
      if (!r?.ok) {
        const d = describeError(r?.error);
        errors.push({ serverId: srv.id, error: d.message, hint: d.hint || '' });
        records.push({ serverId: srv.id, name: srv.name || srv.id, host: srv.host, ok: false, kind: 'error', error: d.message, names: [], pools: [] });
        recordHzSessionActivity({ deviceId: srv.id, name: srv.name || srv.id, host: srv.host, source: 'central', ok: false, durationMs: null, error: d.message, sessions: null, users: null });
        return;
      }
      const v = r.value;
      if (!v.ok && v.error) errors.push({ serverId: srv.id, error: v.error, hint: v.hint || '' });
      records.push(v);
    });

    const ts = Date.now();
    const commit = await commitHzSessions({ ts, records, series: [], maxUsers: s.maxUsers });

    // 등록이 사라진 서버의 낡은 최신값 정리(화면에 유령 행이 남지 않게).
    const live = new Set(servers.map((x) => x.id));
    for (const row of await hzLatestRecords()) if (!live.has(row.serverId)) await dropHzLatest(row.serverId);

    let total = null;
    if (commit.ok) {
      const all = await hzLatestRecords();
      // ⚠ 이번 주기의 결과만 합친다 — 직전 주기 값을 섞으면 '지금 몇 명' 이 거짓이 된다.
      const fresh = all.filter((r) => Number(r.ts) === ts);
      total = combineServers(fresh);
      await commitHzSessions({
        ts,
        records: [],
        series: [
          { serverId: '', ...seriesRow(total), serversOk: total.serversOk, serversFailed: total.serversFailed },
          ...fresh.filter((r) => r.ok).map((r) => ({ serverId: r.serverId, ...seriesRow(r), serversOk: 1, serversFailed: 0 })),
        ],
      });
    }

    if ((++tick % PRUNE_EVERY_RUNS) === 0) {
      try { await pruneHzSessions(s.retentionDays, { every: 1 }); } catch { /* */ }
      try { await pruneHzUsage(s.usageRetentionDays); } catch { /* */ }
    }

    lastRunTs = ts;
    lastResult = {
      at: ts, trigger, servers: servers.length, records: records.length,
      users: total?.users ?? null, connected: total?.usersConnected ?? null,
      // v2.606 COL2606-04: 이 주기의 수치가 하한인가(일부 세션만 읽음·상태 미확인 세션) — 추이에는 적재하지 않았다.
      usersLowerBound: !!total?.usersLowerBound, connectedLowerBound: !!total?.connectedLowerBound,
      serversTruncated: total?.serversTruncated ?? 0,
      serversFailed: total?.serversFailed ?? null,
      errors, mock, ms: Date.now() - started, commit,
    };
    return { ok: errors.length === 0, ...lastResult };
  } finally { running = false; }
}

/** 적응형 타이머 기동 — 주기·on/off 변경은 즉시 재무장된다. */
export function startHzSessionPoller() {
  if (timer) return;
  const getMs = () => Math.max(60_000, loadHzSettings().intervalMs);
  timer = startAdaptiveTimer(getMs, async () => {
    if (running) return;                              // 재진입 가드
    if (!loadHzSettings().enabled) return;            // opt-in
    try { await runHzSessionsNow('auto'); } catch (e) { console.warn(`[horizon-sessions] 폴러 틱 오류: ${e.message}`); }
  }, { firstDelayMs: FIRST_DELAY_MS, name: 'horizon-sessions', subscribe: onHorizonSessionSettingsChange });
  const s = loadHzSettings();
  if (s.enabled) console.log(`[horizon-sessions] started — 주기 ${Math.round(s.intervalMs / 60_000)}분 · 동시 ${Math.min(CONCURRENCY_CAP, s.concurrency)}`);
}

export function stopHzSessionPoller() { timer?.stop?.(); timer = null; }
