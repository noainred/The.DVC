/**
 * bmusage/focus/run.js — **집중 모니터링**(10분 × 1분 · v2.929 예정 · 리눅스 성능 5단계 · 설계 PROFILES §13 · 아트보드 Focus).
 *
 * 장애 · 이슈 상황에서 정해진 주기(5분) 수집과 **별도로** 짧은 간격(기본 1분)으로 정해진 길이(기본 10분) 동안 한 서버를 본다.
 *   · 트리거: 수동(operator 이상 · 사유 필수 · 감사 — 라우트) · 자동(알림 규칙 autoFocus — 기본 꺼짐 · 법인 옵트인 · 같은 서버 재발 억제 30분 · 하루 상한 — perfAlerts).
 *   · 간격 하한 30초 · 길이 상한 60분(perfRules.focus — 설정). **별도 타이머 · 별도 표**(focus_session · focus_sample — 해상도가 달라 5분 표에 섞지 않는다).
 *   · 1회 = SSH 1회(주 수집 명령 그대로 — 기존 구획 전부 + 같은 세션의 경량 스냅샷 상수 명령) + Redfish 1회(텔레메트리 SystemUsage — 목록 조회 없음) —
 *     주기 수집과 같은 함수(collectOsUsage · idracTelemetryJob)다. 전력 · 흡기는 이미 가진 값(hwFacts — Redfish 추가 호출 없음).
 *   · 엣지 보호: 법인당 동시 상한(기본 5 — 넘치면 대기열 · 화면이 ‘대기 n번째’) · 전역 동시성 풀 공유(slots.js — 앞자리 대기 · 상한 넘으면 그 분 결측 ‘pool-busy’) ·
 *     서버당 세션 시한 50초(withDeadline 이 세션을 실제로 끊는다) · 서버당 동시 1세션.
 *   · ⚠⚠ 인증 거부(SSH · Redfish 401/403)는 **즉시 중단**하고 주기 수집과 같은 가드 · 같은 식별자에 기록한다(authGuard — 1분마다 다시 로그인하면 계정이 잠긴다).
 *     자동 집중은 이미 정지된 계정이면 시작하지 않는다. 수동 집중은 막지 않는다(사람이 1회 — 첫 분이 실패하면 거기서 멈춘다).
 *   · 결측은 **비운다**(0 금지) — OS · iDRAC 두 경로를 따로 센다(missOs · missIdrac).
 *   · 보관 30일(설정) — 폴러 주기 정리(focusHousekeeping)가 청크로 지운다. 재시작하면 타이머가 사라지므로 남은 진행 중 · 대기 세션은 ‘중단됨(interrupted)’ 으로 닫는다.
 *   · 피크 창 주기 예산(peakPlan)은 집중 수집을 예산에 넣지 않는다 — 대신 활성 집중 수만큼 동시성을 빼고 계획한다(poller planPeakForCycle).
 *   · ‘원인 후보’ 는 상관이다(분마다 I/O · CPU 1위 프로세스가 몇 번 겹쳤나) — 인과를 단정하지 않는다(화면이 ‘후보’ 로만 말한다).
 */
import crypto from 'node:crypto';
import { withDeadline } from '../../proxy/sshExec.js';
import { config } from '../../config.js';
import { osMissOf, idracMissOf } from '../missReason.js';
import { numOrNull } from '../../util/numOrNull.js';
import { dayKey, DAY_MS, DAY_OFFSET_MIN } from '../../util/dayKey.js';
import { capStr } from '../../util/capStr.js';
import { cleanReason } from '../snapshot/reason.js';
import { summarizeFocus } from './summary.js';

export { summarizeFocus }; // 테스트 · 웹 vitest 가 run.js 에서 가져간다
import { FOCUS_SNAPSHOT_COMMAND, parseSnapshot } from '../snapshot/command.js';
import { withSlot } from '../slots.js';
import * as ops from '../opsDb.js';

const n = numOrNull;
/** 분 표본 지표(평균 = 그 1분 창의 값 · 피크 = 같은 세션 1초 창의 최대). 웹 문구 표와 1:1(bmFocusText FOCUS_METRIC_TEXT). */
export const FOCUS_METRICS = Object.freeze([
  { col: 'cpu_pct', peak: true }, { col: 'cpu_iowait_pct', peak: true }, { col: 'runq_per_core' },
  { col: 'disk_busy_pct', peak: true }, { col: 'disk_await_ms', peak: true }, { col: 'disk_aqu', peak: true }, { col: 'psi_io_full10' },
  { col: 'mem_pct' }, { col: 'swap_out_ps' }, { col: 'net_pct', peak: true }, { col: 'net_drop_delta' }, { col: 'net_err_delta' },
  { col: 'power_w', src: 'idrac' }, { col: 'inlet_c', src: 'idrac' },
]);
export const FOCUS_COLS = Object.freeze(FOCUS_METRICS.map((m) => m.col));
export const FOCUS_STATUS = Object.freeze(['queued', 'running', 'done', 'stopped', 'auth', 'interrupted', 'failed']);
/** 결측 사유(웹 문구 1:1). */
export const FOCUS_MISS = Object.freeze(['timeout', 'auth', 'auth-stopped', 'ssh-error', 'host-key', 'not-linux', 'no-path', 'pool-busy', 'unreachable', 'no-telemetry', 'error']);
/** 결과 code → HTTP(라우트 · 엣지 대행 공용 — 스냅샷과 같은 규약: 업무 결과는 code 로). */
export const FOCUS_CODE_STATUS = Object.freeze({
  ok: 200, queued: 200, 'bad-reason': 400, 'bad-request': 400, 'not-found': 404, forbidden: 403, 'no-path': 409, busy: 409, 'daily-cap': 429,
  'auth-stopped': 409, 'store-unavailable': 503, 'settings-unreadable': 503, edge: 502,
  maintenance: 409,   // 8a단계 ③: 정비 창 안 자동 집중(수동은 이 code 가 나오지 않는다)
});
export const FOCUS_CODES = Object.freeze(Object.keys(FOCUS_CODE_STATUS));
/** 세션 시한(SSH 연결 15 + 주 명령 30 + 피크 창 + 경량 스냅샷) — 50초 안(주기 수집 SESSION_BUDGET 과 같다). */
export const FOCUS_DEADLINE_MS = 50_000;
export const FOCUS_BUDGET_MS = 45_000;
/** 1분 창 피크 — 같은 세션 1초 창(A 안). 설정 peakWindowS 보다 길게 잡지 않는다. */
export const FOCUS_PEAK_WINDOW_S = 10;

/* ── 상태(이 노드 인메모리 — 진실은 focus_session 표) ─────────────────────── */
const _active = new Map();   // id → sess(실행 중)
const _queue = new Map();    // vcenterId → [sess](대기 — 들어온 순서)
const _byKey = new Map();    // key → id(서버당 동시 1세션 — 실행 중 · 대기 모두)
const _starting = new Map(); // vcenterId → 시작 중(DB 쓰기 · 앞 1시간 읽기 중) 예약 수
const _endListeners = new Set();
let _initDone = false;
export function onFocusEnd(fn) { if (typeof fn === 'function') _endListeners.add(fn); return () => _endListeners.delete(fn); }
export function focusActiveCount() { return _active.size; }
export function focusQueuedCount() { let c = 0; for (const q of _queue.values()) c += q.length; return c; }
export function _resetFocusForTest() {
  for (const s of _active.values()) if (s.timer) clearTimeout(s.timer);
  _active.clear(); _queue.clear(); _byKey.clear(); _starting.clear(); _endListeners.clear(); _initDone = false; _initP = null;
  _manual.day = ''; _manual.counts = new Map(); _manual.init = new Map(); _nodeMax = 10; _corpMax = 5;
}

/*
 * 폴러 쪽 함수(이전 카운터 · 인증 정지 · iDRAC 텔레메트리 작업 · 인증 결과 기록)는 **폴러가 로드될 때 등록**한다(poller.js 머리 — registerFocusPollerHooks).
 * ⚠ 여기서 poller.js 를 import(정적 · 동적 모두)하면 poller → focus/run → poller 순환이 생긴다(arch2579 SCC 상한). 등록 전(폴러 미로드)이면
 *   인증 정지 조회는 ‘정지’ 로 답해(자동 집중 · iDRAC 시도를 하지 않는다 — 계정 잠금 쪽으로 틀리지 않게) 나머지는 그 분의 결측이 된다.
 */
let _poll = null;
const HOOKS_MISSING_STOP = Object.freeze({ reason: 'poller-hooks-missing' });
export function registerFocusPollerHooks(h) { _poll = h && typeof h === 'object' ? h : null; }
function pollHook(name) {
  return async (...a) => {
    const f = _poll?.[name];
    if (typeof f !== 'function') throw new Error(`집중 모니터링: 폴러 훅(${name})이 등록되지 않았습니다`);
    return f(...a);
  };
}

function deps0(D = {}) {
  return {
    now: () => Date.now(),
    loadRules: async () => (await import('../perfRules.js')).loadPerfRules(),
    loadSettings: async () => (await import('../settings.js')).loadBmUsageSettings(),
    collectOs: async (osHost, o) => (await import('../collectors/osSsh.js')).collectOsUsage(osHost, o),
    idracJob: async (entry, o) => pollHook('idracTelemetryJob')(entry, o),
    prevFor: async (key) => pollHook('prevCountersFor')(key),
    osAuthStop: async (tg) => (_poll ? pollHook('osAuthStopFor')(tg) : HOOKS_MISSING_STOP),
    idracAuthStop: async (tg) => (_poll ? pollHook('idracAuthStopFor')(tg) : HOOKS_MISSING_STOP),
    recordOsAuth: async (tg, o) => pollHook('recordOsAuthOutcome')(tg, o),
    recordIdracAuth: async (tg, o) => pollHook('recordIdracAuthOutcome')(tg, o),
    buildUsage: async (o) => (await import('../usage.js')).buildUsage(o),
    buildEntry: async (o) => (await import('../perfView.js')).buildPerfEntry(o),
    hwReader: async (o) => (await import('../hwFacts.js')).hwFactsReader(o),
    rawBefore: async (o) => (await import('../db.js')).rawRangeMerged(o),
    // 8a단계 ③: 정비 창 판정(판정 코어 하나 — maint/judge.js · 이 노드의 창 + 중앙 배포본).
    maintState: async (tg, now) => (await (await import('../maint/runtime.js')).maintJudge({ now })).stateFor(tg, now),
    db: ops,
    setTimer: (fn, ms) => { const h = setTimeout(fn, Math.max(0, ms)); h.unref?.(); return h; },
    clearTimer: (h) => clearTimeout(h),
    ...D,
  };
}
let _D = deps0();
/** 테스트 주입(가짜 SSH · Redfish · 시계 · 타이머). */
export function _setFocusDepsForTest(d) { _D = deps0(d || {}); }

async function isDemoTarget(target) {
  try {
    const { isMockMode } = await import('../../mock/demo/flags.js');
    if (!isMockMode()) return false;
    return (await import('../../mock/demo/baremetal.js')).isDemoBmTarget(target);
  } catch { return false; }
}

/** 재시작 뒤 첫 사용 — 남은 진행 중 · 대기 세션을 닫는다(타이머가 없다). */
let _initP = null;
async function ensureInit() {
  if (_initDone) return;
  if (!_initP) _initP = (async () => { try { await _D.db.focusCloseOrphans({ agent: config.agent?.name || '', now: _D.now() }); } catch { /* 표가 없으면 다음 사용 때 */ } _initDone = true; })();
  await _initP;
}
/** 기동 때 한 번(반증 F13 — 폴러 시작이 부른다): 재시작 직후 봉투 · 함대 칩이 죽은 세션을 ‘진행 중’ 으로 보이지 않게 남은 세션을 먼저 닫는다. */
export async function initFocus() { await ensureInit(); }

/* 수동 집중 법인당 하루 상한(반증 F11) — 오늘(포탈 날짜) 그 법인에서 사람이 시작한 수. 처음 한 번 DB 에서 세고(같은 promise 공유) 그 뒤는 동기 증가(검사와 예약 사이 await 없음). */
const _manual = { day: '', counts: new Map(), init: new Map() };
const dayStartMs = (now) => { const k = dayKey(now); return k ? Date.parse(`${k}T00:00:00Z`) - DAY_OFFSET_MIN * 60_000 : now - (now % DAY_MS); };
async function manualReady(vc, now) {
  const day = dayKey(now) || '';
  if (_manual.day !== day) { _manual.day = day; _manual.counts = new Map(); _manual.init = new Map(); }
  if (!_manual.init.has(vc)) {
    _manual.init.set(vc, Promise.resolve().then(() => _D.db.focusCountSince({ vcenterId: vc, since: dayStartMs(now), trigger: 'manual' }))
      .then((c) => { if (!_manual.counts.has(vc)) _manual.counts.set(vc, Number(c) || 0); })
      .catch(() => { if (!_manual.counts.has(vc)) _manual.counts.set(vc, 0); }));
  }
  await _manual.init.get(vc);
}
let _nodeMax = 10;   // 마지막 설정의 노드 전체 동시 상한(대기열 처리 때 쓴다)
let _corpMax = 5;    // 마지막 설정의 법인당 상한(대기열 처리 때 — 대기 중 세션이 만들어질 때의 값이 아니라 지금 설정)
/** 이 노드에서 실행 중(+ 시작 중 예약) 세션 수. */
function nodeRunning() { let c = _active.size; for (const v of _starting.values()) c += v; return c; }

/** 설정 → 이번 세션 간격 · 횟수(하한 · 상한은 perfRules 정규화가 이미 지켰다 — 여기서 한 번 더). */
export function sessionPlan(rules = {}) {
  const f = rules.focus || {};
  const intervalS = Math.max(30, Math.min(600, Math.round(Number(f.intervalS) || 60)));
  const durationMin = Math.max(1, Math.min(60, Math.round(Number(f.durationMin) || 10)));
  const count = Math.max(1, Math.min(120, Math.floor((durationMin * 60) / intervalS)));
  return { intervalS, durationMin, count, corpMax: Math.max(1, Math.round(Number(f.corpMax) || 5)), nodeMax: Math.max(1, Math.min(64, Math.round(Number(f.nodeMax) || 10))) };
}

/**
 * 시작 — 실행 또는 대기열. 대상은 이 노드의 대상(자격증명 포함 — 반환값에는 싣지 않는다).
 * @returns {Promise<{ok:boolean, code:string, id?:string, status?:string, queuePos?:number, reason?:string}>}
 */
export async function startFocusLocal({ target, reason = '', by = '', trigger = 'manual', rule = '' } = {}) {
  await ensureInit();
  const now = _D.now();
  if (!target || !target.key) return { ok: false, code: 'not-found', reason: '대상 서버를 찾지 못했습니다.' };
  const r = trigger === 'manual' ? cleanReason(reason) : capStr(String(reason || '자동 규칙'), 300);
  if (!r) return { ok: false, code: 'bad-reason', reason: '사유를 2자 이상 적어야 합니다(감사 기록에 남습니다).' };
  const paths = Array.isArray(target.paths) ? target.paths : [];
  const hasOs = paths.includes('os') && !!target.osHost && !!String(target.osHost.host || '').trim();
  const hasIdrac = paths.includes('idrac') && !!target.idrac;
  if (!hasOs && !hasIdrac) return { ok: false, code: 'no-path', reason: '이 서버에는 OS · iDRAC 수집 경로가 없습니다.' };
  // 서버당 동시 1세션 — 검사와 등록 사이에 await 를 두지 않는다.
  if (_byKey.has(target.key)) return { ok: false, code: 'busy', reason: '이 서버의 집중 모니터링이 이미 진행 중이거나 대기 중입니다.', id: _byKey.get(target.key) };
  // 인증 정지된 계정으로는 시작하지 않는다 — 자동 · **수동 모두**(반증 F11: 수동은 누를 때마다 로그인 1회 → 계정 잠금 경로였다 · iDRAC 은 이미 분마다 정지를 존중).
  //   OS 경로가 정지면 거부(분마다 SSH 를 연다) · iDRAC 만 있는 서버는 iDRAC 정지면 거부. 풀기는 주기 수집이 다음 성공에서 · 자격증명을 고친 뒤.
  {
    const osSt = hasOs ? (await _D.osAuthStop(target).catch(() => null)) || null : null;
    const idSt = !hasOs && hasIdrac ? (await _D.idracAuthStop(target).catch(() => null)) || null : null;
    if (osSt || idSt) {
      return { ok: false, code: 'auth-stopped', authStopped: osSt ? 'os' : 'idrac',
        reason: `${osSt ? 'OS(SSH)' : 'iDRAC'} 계정이 인증 실패로 정지돼 있어 ${trigger === 'manual' ? '' : '자동 '}집중 모니터링을 시작하지 않았습니다 — 분마다 로그인하면 계정이 잠길 수 있습니다. 자격증명을 고친 뒤 주기 수집이 성공하면 풀립니다.` };
    }
  }
  /*
   * 8a단계 ③ 자동 집중 억제(설계 §20 ⑲): 정비 창(③ focus 또는 ④ collect 를 켠 창) 안이면 **자동** 집중은 시작하지 않는다 — 수동 집중은 허용(사유를 적고 실행).
   *   인증 정지(위)가 먼저다 — 창과 무관하게 막는다. 억제는 그 발생의 끝까지(시한)이고 적용 기록은 ‘창 끝 뒤 억제 0’ 점검에 남긴다.
   *   ⚠ 이 함수가 choke point 다(자동 집중은 perfAlerts.dispatch → 여기 하나로만 들어온다).
   */
  if (trigger !== 'manual') {
    let ms = null;
    try { ms = await _D.maintState(target, now); } catch { ms = null; }
    if (ms && (ms.scopes?.focus || ms.scopes?.collect)) {
      const scope = ms.scopes.focus ? 'focus' : 'collect';
      const ids = (ms.windows || []).filter((w) => (w.scopes || []).includes(scope)).map((w) => w.id);
      try { const R = await import('../maint/runtime.js'); R.countSuppression('focus', ids, { now }); R.noteApplied(scope, target.key, ms.until?.[scope], ids, now, { since: R.sinceOf?.(ms, scope) ?? null }); } catch { /* 계수 실패는 억제를 바꾸지 않는다 */ }
      return { ok: false, code: 'maintenance', maint: { ids, until: ms.until?.[scope] ?? null }, reason: '정비 창 안이라 자동 집중 모니터링을 시작하지 않았습니다(수동 집중은 사유를 적고 실행할 수 있습니다).' };
    }
  }
  if (_byKey.has(target.key)) return { ok: false, code: 'busy', reason: '이 서버의 집중 모니터링이 이미 진행 중이거나 대기 중입니다.', id: _byKey.get(target.key) };
  if (!(await _D.db.focusStoreAvailable())) return { ok: false, code: 'store-unavailable', reason: '집중 모니터링 보관 DB 를 열 수 없어 시작하지 않았습니다.' };
  let rules;
  try { rules = await _D.loadRules(); } catch { return { ok: false, code: 'settings-unreadable', reason: '집중 모니터링 설정을 읽지 못했습니다.' }; }
  const plan = sessionPlan(rules);
  _nodeMax = plan.nodeMax; _corpMax = plan.corpMax;
  const vc = String(target.vcenterId || '');
  const manualMax = Math.max(1, Math.round(Number(rules?.daily?.manualFocus) || 20));
  if (trigger === 'manual') await manualReady(vc, now);
  const id = crypto.randomUUID();
  const sess = {
    id, key: target.key, vcenterId: vc, target, trigger: trigger === 'manual' ? 'manual' : 'auto', rule: String(rule || '').slice(0, 32), by: String(by || '').slice(0, 64), reason: r,
    created: now, start: null, intervalS: plan.intervalS, count: plan.count, done: 0, missOs: 0, missIdrac: 0, status: 'queued',
    hasOs, hasIdrac, prev: null, samples: [], timer: null, stopped: false, summaryBefore: null,
    // 데모(mock) 대상은 장비에 접속하지 않고 합성 분을 만든다(mock/demo/baremetal.js demoFocusSample — 사람이 등록한 서버는 mock 에서도 실제로 수집).
    demo: await isDemoTarget(target),
  };
  // 데모 합성 분은 OS 값을 만든다(demoFocusSample) — 경로 표시('OS 경로 없음')와 결측 카운터가 합성 분과 어긋나지 않게.
  if (sess.demo) sess.hasOs = true;
  if (_byKey.has(target.key)) return { ok: false, code: 'busy', reason: '이 서버의 집중 모니터링이 이미 진행 중이거나 대기 중입니다.', id: _byKey.get(target.key) };
  // ── 여기서부터 등록까지 await 없음(검사와 예약을 한 동기 구간에서) ──
  // 설정(상한)이 바뀌어 대기열 앞쪽이 지금 시작할 수 있으면 그것부터(새 요청이 대기열을 앞지르지 않게 — 반증 F4).
  startTaken(takeStartable());
  if (trigger === 'manual') {
    const usedN = _manual.counts.get(vc) || 0;
    if (usedN >= manualMax) return { ok: false, code: 'daily-cap', reason: `이 법인의 오늘 수동 집중 모니터링 상한(${manualMax}회)에 닿았습니다 — 설정 › 리눅스 성능 알림 규칙 › 하루 상한.` };
    _manual.counts.set(vc, usedN + 1);
  }
  sess.corpMax = plan.corpMax;
  sess.wallMs = plan.durationMin * 60_000;
  _byKey.set(target.key, id);
  // 법인당 · 노드 전체 동시 상한 — 실행 중 + 시작 중(예약)을 **동기적으로** 세고 예약한다(검사와 예약 사이에 await 없음 — 스냅샷 R2 와 같은 판단).
  //   ⚠ 반증 F4: 그 법인 대기열이 비어 있지 않으면 새 요청도 대기열 뒤로(앞지르기 금지 — 끝나는 세션이 대기열 맨 앞을 같은 동기 구간에서 시작한다).
  const running = runningIn(vc);
  const queued = running >= plan.corpMax || (_queue.get(vc)?.length || 0) > 0 || nodeRunning() >= plan.nodeMax || anyQueued();
  sess.status = queued ? 'queued' : 'running';
  if (queued) { if (!_queue.has(vc)) _queue.set(vc, []); _queue.get(vc).push(sess); }
  else _starting.set(vc, (_starting.get(vc) || 0) + 1);
  const unreserve = () => { if (!queued) { const c = (_starting.get(vc) || 1) - 1; if (c > 0) _starting.set(vc, c); else _starting.delete(vc); } };
  const ins = await _D.db.focusInsert({ ...sess, agent: config.agent?.name || '', status: sess.status }).catch((e) => ({ ok: false, reason: String(e?.message || e) }));
  if (!ins?.ok) {
    _byKey.delete(target.key); unreserve();
    if (trigger === 'manual') _manual.counts.set(vc, Math.max(0, (_manual.counts.get(vc) || 1) - 1));
    if (queued) { const q = _queue.get(vc) || []; const i = q.indexOf(sess); if (i >= 0) q.splice(i, 1); if (!q.length) _queue.delete(vc); }
    return { ok: false, code: 'store-unavailable', reason: '집중 모니터링 보관 DB 에 쓰지 못했습니다.' };
  }
  if (queued) return { ok: true, code: 'queued', id, status: 'queued', queuePos: queuePosOf(id), intervalS: plan.intervalS, count: plan.count };
  // beginSession 은 첫 await 전에 _active 에 넣는다 — 그 직후 예약을 푼다(두 번 세지 않게).
  const p = beginSession(sess); unreserve(); await p;
  return { ok: true, code: 'ok', id, status: 'running', intervalS: plan.intervalS, count: plan.count, start: sess.start };
}
/** 이 법인에서 실행 중(+ 시작 중 예약) 세션 수. */
function runningIn(vc) { let c = _starting.get(vc) || 0; for (const s of _active.values()) if (s.vcenterId === vc) c += 1; return c; }
/** 노드 상한 때문에 기다리는 세션이 있는가(다른 법인 대기열 포함 — 새 요청이 노드 자리를 새치기하지 않게). */
function anyQueued() { for (const q of _queue.values()) if (q.length) return nodeRunning() >= _nodeMax; return false; }
/**
 * 대기열에서 지금 시작할 수 있는 세션을 꺼내 **예약**한다(동기 — 반증 F4). 들어온 순서(전 법인 공통) · 법인 상한 · 노드 상한을 같이 본다.
 *   호출부는 같은 동기 구간에서 _active 해제를 마친 뒤 부르고, 돌려받은 세션마다 beginSession 직후 예약을 푼다.
 */
function takeStartable() {
  const out = [];
  const all = [..._queue.values()].flat().sort((a, b) => (a.created - b.created) || 0);
  for (const nx of all) {
    if (nodeRunning() >= _nodeMax) break;
    if (runningIn(nx.vcenterId) >= _corpMax) continue;
    const q = _queue.get(nx.vcenterId) || [];
    const i = q.indexOf(nx); if (i >= 0) q.splice(i, 1);
    if (!q.length) _queue.delete(nx.vcenterId);
    if (nx.stopped) continue;
    _starting.set(nx.vcenterId, (_starting.get(nx.vcenterId) || 0) + 1);
    out.push(nx);
  }
  return out;
}
function startTaken(list) {
  for (const nx of list) {
    const p = beginSession(nx);   // 첫 await 전에 _active 에 넣는다 — 그 직후 예약을 푼다
    const c = (_starting.get(nx.vcenterId) || 1) - 1; if (c > 0) _starting.set(nx.vcenterId, c); else _starting.delete(nx.vcenterId);
    p.catch((e) => finish(nx, 'failed', String(e?.message || e)));
  }
}

/** 대기 순번(1부터) — 없으면 0. */
export function queuePosOf(id) {
  for (const q of _queue.values()) { const i = q.findIndex((s) => s.id === id); if (i >= 0) return i + 1; }
  return 0;
}

async function beginSession(sess) {
  sess.status = 'running';
  sess.start = _D.now();
  _active.set(sess.id, sess);
  // 앞 1시간(5분 평균) — ‘평소’ 와 비교할 기준. 못 읽으면 비운다(지어내지 않는다).
  try {
    const r = await _D.rawBefore({ key: sess.key, agent: config.agent?.name || '', from: sess.start - 3_600_000, to: sess.start, limit: 64, cols: FOCUS_COLS.filter((c) => !['power_w', 'inlet_c'].includes(c)) });
    sess.summaryBefore = beforeStats(r?.rows || []);
  } catch { sess.summaryBefore = null; }
  await _D.db.focusUpdate(sess.id, { status: 'running', start: sess.start, summary: { before: sess.summaryBefore } }).catch(() => {});
  try { sess.prev = (await _D.prevFor(sess.key)) || null; } catch { sess.prev = null; }
  schedule(sess, 0);
}
function schedule(sess, idx) {
  if (sess.stopped) return;
  const at = sess.start + idx * sess.intervalS * 1000;
  sess.timer = _D.setTimer(() => { tick(sess, idx).catch((e) => finish(sess, 'failed', String(e?.message || e))); }, at - _D.now());
}

/** 앞 1시간 통계(순수) — 지표마다 평균 · 최대 · 표본 수(null 은 세지 않는다). */
export function beforeStats(rows = []) {
  const out = {};
  for (const c of FOCUS_COLS) {
    const vs = rows.map((r) => n(r?.[c])).filter((v) => v != null);
    if (vs.length) out[c] = { avg: Math.round((vs.reduce((a, b) => a + b, 0) / vs.length) * 100) / 100, max: Math.max(...vs), n: vs.length };
  }
  return out;
}

// 결측 사유 판정은 bmusage/missReason.js 하나(6단계 수집 건강과 같은 코어).

async function tick(sess, idx) {
  if (sess.stopped || !_active.has(sess.id)) return;
  // 길이 상한은 횟수만이 아니라 **벽시계로도**(반증 L8): 한 분 수집이 간격보다 길면(시한 50초 + 슬롯 대기) 횟수로는 60분을 넘는다.
  if (n(sess.wallMs) != null && sess.start != null && _D.now() - sess.start >= sess.wallMs) { sess.wallCapped = true; return finish(sess, 'done'); }
  if (sess.demo) {
    const d = (await import('../../mock/demo/baremetal.js')).demoFocusSample(sess.target, _D.now(), idx);
    const sample = { sessionId: sess.id, idx, minuteTs: _D.now(), osOk: d.osOk, idracOk: d.idracOk, verdict: d.verdict, missOs: d.missOs || null, missIdrac: null, vals: d.vals, snap: d.snap };
    sess.samples.push(sample); sess.done = idx + 1; if (d.missOs) sess.missOs += 1;
    await _D.db.focusSampleInsert(sample).catch(() => {});
    await _D.db.focusUpdate(sess.id, { done: sess.done, missOs: sess.missOs, missIdrac: sess.missIdrac }).catch(() => {});
    if (idx + 1 >= sess.count) return finish(sess, 'done');
    return schedule(sess, idx + 1);
  }
  const tg = sess.target;
  const minuteTs = _D.now();
  const settings = await _D.loadSettings().catch(() => ({}));
  const st = settings.store || {};
  // iDRAC 경로가 이미 인증 정지면(주 폴러 · 이 도구) 시도하지 않는다(계정 잠금) — 그 분은 결측 ‘auth-stopped’.
  const idrStop = sess.hasIdrac ? await _D.idracAuthStop(tg).catch(() => null) : null;
  const busy = () => ({ ok: false, busy: true, error: '전역 동시성 풀이 가득 차 이번 분을 건너뛰었습니다' });
  const waitMs = Math.max(5_000, Math.min(45_000, sess.intervalS * 1000 * 0.75));
  const [os, idrac] = await Promise.all([
    sess.hasOs ? withSlot(() => withDeadline(FOCUS_DEADLINE_MS, (signal) => _D.collectOs(tg.osHost, {
      signal, budgetMs: FOCUS_BUDGET_MS, partitionIo: !!st.partitionIo, blkqMax: st.blkqMax, peakWindowS: Math.min(FOCUS_PEAK_WINDOW_S, Number(st.peakWindowS ?? FOCUS_PEAK_WINDOW_S) || 0),
      extraCommands: [{ name: 'snap', cmd: FOCUS_SNAPSHOT_COMMAND, timeoutMs: 12_000, maxBytes: 16 * 1024 }],
    }), '집중 수집 시한 초과').catch((e) => ({ ok: false, error: String(e?.message || e).slice(0, 300) })), { priority: true, waitMs, onBusy: busy }) : null,
    sess.hasIdrac ? (idrStop ? { ok: false, kind: 'auth-stopped' } : withSlot(() => _D.idracJob(tg.idrac, { full: false, allowList: false, timeoutMs: FOCUS_DEADLINE_MS }).catch((e) => ({ ok: false, error: String(e?.message || e).slice(0, 300) })), { priority: true, waitMs, onBusy: busy })) : null,
  ]);
  if (sess.stopped) return;
  const sampledAt = _D.now();
  const missOs = sess.hasOs ? osMissOf(os) : 'no-path';
  const missIdrac = sess.hasIdrac ? idracMissOf(idrac) : 'no-path';
  // 인증 결과를 주기 수집과 같은 가드에 — 실패는 정지 · 성공은 해제.
  if (sess.hasOs && os) await _D.recordOsAuth(tg, { ok: !!os.ok, errorText: missOs === 'auth' ? os.error : '' }).catch(() => {});
  if (sess.hasIdrac && idrac && idrac.kind !== 'auth-stopped' && !idrac.busy) await _D.recordIdracAuth(tg, { ok: !!idrac.ok, kind: idrac.kind || '', errorText: idrac.error || '' }).catch(() => {});

  // 값 — 주기 수집과 같은 계산(buildUsage · buildPerfEntry). 누적 카운터 이전 표본은 이 세션 것(첫 분은 주기 수집의 마지막 표본 사본 — 주기 수집 상태는 건드리지 않는다).
  let vals = {}; let verdict = null; let snap = null; let dmesgErr = null;
  const osOk = !!os?.ok; const idracOk = !!idrac?.ok;
  if (osOk || idracOk) {
    const built = await _D.buildUsage({ target: tg, idrac: idracOk ? idrac : null, os: osOk ? os : null, ent: null, prev: sess.prev, now: sampledAt, intervalMs: sess.intervalS * 1000, slackMs: 20_000, deviceMax: st.deviceMax || 32 });
    if (built?.next) sess.prev = built.next;
    const row = built?.row || {};
    let hw = null;
    try { const rd = await _D.hwReader({ agent: config.agent?.name || '', now: sampledAt, freshMs: 5 * 60_000 }); hw = rd(tg) || null; } catch { hw = null; }
    const entry = await _D.buildEntry({ row: { ...row, key: tg.key, ts: sampledAt }, hw, th: settings.perf || {}, intervalMs: sess.intervalS * 1000, now: sampledAt, full: false }).catch(() => null);
    verdict = entry?.verdict || null;
    for (const m of FOCUS_METRICS) {
      if (m.src === 'idrac') continue;
      const avg = osOk ? n(row[m.col]) : null;
      const peak = m.peak && osOk ? n(row[`${m.col}_peak`]) : null;
      if (avg != null || peak != null) vals[m.col] = { avg, ...(m.peak ? { peak } : {}) };
    }
    if (hw?.power?.watts != null) vals.power_w = { avg: hw.power.watts };
    if (hw?.inletC != null) vals.inlet_c = { avg: hw.inletC };
    if (idracOk && n(idrac.cpuPct) != null) vals.idrac_cpu_pct = { avg: n(idrac.cpuPct) };
    if (osOk && os.extra?.snap?.stdout) {
      const p = parseSnapshot(os.extra.snap.stdout, { topN: 5, dmesgLines: 1 });
      snap = { cpuTop: (p.cpuTop || []).slice(0, 5).map((x) => ({ name: x.name, cpuPct: x.cpuPct })), ioTop: (p.ioTop || []).slice(0, 5).map((x) => ({ name: x.name, readBps: x.readBps, writeBps: x.writeBps })),
        io: p.states.io, cpu: p.states.cpu, ssTcp: p.ssTcp };
    } else if (osOk && os.extra?.snap) snap = { error: os.extra.snap.skipped ? 'budget' : 'failed' };
    const dm = os?.perf?.dmesg?.value;
    dmesgErr = dm && !dm.failed ? n(dm.err) : null;
    if (dmesgErr != null) vals.dmesg_err = { avg: dmesgErr };
    if (entry?.perResource) vals._res = entry.perResource;
  }
  // 경로가 없는 쪽은 결측이 아니다(반증 F14) — 표본에 null(‘경로 없음’ 은 세션의 hasOs · 요약 null 이 말한다).
  const sample = { sessionId: sess.id, idx, minuteTs, osOk, idracOk: sess.hasIdrac ? idracOk : null, verdict, missOs: sess.hasOs ? (missOs || null) : null, missIdrac: sess.hasIdrac ? (missIdrac || null) : null, vals, snap };
  sess.samples.push(sample);
  sess.done = idx + 1;
  if (missOs && sess.hasOs) sess.missOs += 1;
  if (missIdrac && sess.hasIdrac) sess.missIdrac += 1;
  await _D.db.focusSampleInsert(sample).catch(() => {});
  await _D.db.focusUpdate(sess.id, { done: sess.done, missOs: sess.missOs, missIdrac: sess.missIdrac }).catch(() => {});
  // ⚠⚠ 인증 거부는 즉시 중단(다음 분에 다시 로그인하지 않는다).
  if (missOs === 'auth' || missIdrac === 'auth') return finish(sess, 'auth');
  if (idx + 1 >= sess.count) return finish(sess, 'done');
  schedule(sess, idx + 1);
}

async function finish(sess, status, error = '') {
  if (sess.finished) return;
  sess.finished = true;
  if (sess.timer) _D.clearTimer(sess.timer);
  sess.stopped = true;
  _active.delete(sess.id);
  if (_byKey.get(sess.key) === sess.id) _byKey.delete(sess.key);
  // ⚠⚠ 반증 F4: 해제와 대기열 시작을 **같은 동기 구간**에서 — 예전에는 DB 쓰기 · 결론 알림(await) 뒤에 대기열을 봐서 그 사이 새 시작이 대기열을 앞지르고
  //   이어 대기열 다음도 시작돼 법인 상한을 넘었다.
  startTaken(takeStartable());
  const end = _D.now();
  const summary = summarizeFocus(sess.samples, { before: sess.summaryBefore, hasOs: sess.hasOs, hasIdrac: sess.hasIdrac });
  if (error) summary.error = String(error).slice(0, 200);
  if (sess.wallCapped) summary.wallCapped = true;
  sess.status = status;
  await _D.db.focusUpdate(sess.id, { status, end, done: sess.done, missOs: sess.missOs, missIdrac: sess.missIdrac, summary }).catch(() => {});
  // 끝 구독자(집중 결론 알림)는 **기다리지 않는다**(반증 L4 — 엣지 대행 중지가 메일 시한만큼 늦게 답해 중앙이 ‘시한 초과’ 로 보였다).
  const ev = { id: sess.id, key: sess.key, vcenterId: sess.vcenterId, name: sess.target?.name || sess.key, trigger: sess.trigger, status, summary, start: sess.start, end, target: sess.target };
  for (const fn of _endListeners) Promise.resolve().then(() => fn(ev)).catch(() => { /* 알림 실패는 세션을 바꾸지 않는다 */ });
}

/** 중지(사람) — 실행 중이면 그 분까지 남기고 닫는다 · 대기 중이면 대기열에서 뺀다. */
export async function stopFocusLocal({ key, id } = {}) {
  await ensureInit();
  const s = _active.get(String(id));
  if (s && s.key === String(key)) { await finish(s, 'stopped'); return { ok: true, code: 'ok', id: s.id, status: 'stopped' }; }
  for (const [vc, q] of _queue) {
    const i = q.findIndex((x) => x.id === String(id) && x.key === String(key));
    if (i < 0) continue;
    const [x] = q.splice(i, 1);
    if (!q.length) _queue.delete(vc);
    x.stopped = true; x.finished = true;
    if (_byKey.get(x.key) === x.id) _byKey.delete(x.key);
    await _D.db.focusUpdate(x.id, { status: 'stopped', end: _D.now() }).catch(() => {});
    return { ok: true, code: 'ok', id: x.id, status: 'stopped' };
  }
  return { ok: false, code: 'not-found', reason: '진행 중이거나 대기 중인 집중 모니터링을 찾지 못했습니다.' };
}

/** 한 서버의 세션 목록(보관 기간 안). 진행 중은 대기 순번을 붙인다. */
export async function listFocusLocal({ key, keepDays = 30 } = {}) {
  await ensureInit();
  const list = await _D.db.focusList({ key, agent: config.agent?.name || '', since: _D.now() - keepDays * 86_400_000, limit: 60 });
  if (list == null) return { ok: false, code: 'store-unavailable', reason: '집중 모니터링 보관 DB 를 열 수 없습니다.' };
  // 진행 중 · 대기 세션은 경로(hasOs · hasIdrac)를 싣는다 — 요약이 아직 없어 화면이 ‘경로 없음’ 과 ‘0분 결측’ 을 가를 근거(반증 F14).
  const liveOf = (id) => _active.get(id) || [..._queue.values()].flat().find((x) => x.id === id) || null;
  return { ok: true, code: 'ok', sessions: list.map((s) => { const lv = liveOf(s.id); return { ...s, ...(s.status === 'queued' ? { queuePos: queuePosOf(s.id) } : {}), ...(lv ? { hasOs: !!lv.hasOs, hasIdrac: !!lv.hasIdrac } : {}) }; }), keepDays };
}
/** 세션 하나 + 분 표본 + 같은 시간대 변경 이벤트(키가 다르면 없는 것으로). */
export async function getFocusLocal({ key, id } = {}) {
  await ensureInit();
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return { ok: false, code: 'not-found', reason: '세션을 찾지 못했습니다.' };
  const s = await _D.db.focusGet(String(id));
  if (!s || s.key !== String(key) || s.agent !== (config.agent?.name || '')) return { ok: false, code: 'not-found', reason: '세션을 찾지 못했습니다.' };
  const samples = (await _D.db.focusSamples(s.id)) || [];
  const live = _active.get(s.id);
  const summary = s.summary && s.status !== 'running' ? s.summary : summarizeFocus(samples, { before: s.summary?.before || null, hasOs: live ? live.hasOs : true, hasIdrac: live ? live.hasIdrac : false });
  const from = s.start ?? s.created; const to = s.end ?? (from + s.count * s.intervalS * 1000);
  const ch = await _D.db.changeEventsRange({ key: s.key, agent: s.agent, from, to, limit: 50 }).catch(() => null);
  return { ok: true, code: 'ok', session: { ...s, summary, ...(s.status === 'queued' ? { queuePos: queuePosOf(s.id) } : {}) }, samples, changes: ch?.rows || [] };
}

/** 봉투 요약(중앙은 요약만 — 상세는 볼 때 당긴다): 진행 중 · 대기 + 최근 24시간 끝난 것. */
export async function focusEnvelopeSummary({ now = Date.now(), max = 200 } = {}) {
  await ensureInit();   // 반증 F13 — 재시작 뒤 남은 세션을 닫은 다음에 싣는다
  try {
    const list = await _D.db.focusRecent({ agent: config.agent?.name || '', since: now - 86_400_000, limit: max });
    if (!list) return null;
    return list.map((s) => ({
      id: s.id, key: s.key, vcenterId: s.vcenterId, trigger: s.trigger, status: s.status, created: s.created, start: s.start, end: s.end, intervalS: s.intervalS, count: s.count, done: s.done,
      missOs: s.missOs, missIdrac: s.missIdrac, ...(s.status === 'queued' ? { queuePos: queuePosOf(s.id) } : {}),
      verdictFrom: s.summary?.verdictFrom || null, verdictTo: s.summary?.verdictTo || null, candidate: s.summary?.candidates?.[0]?.name || null,
    }));
  } catch { return null; }
}

/** 폴러 주기 정리 — 보관 밖 세션 · 표본(청크). */
export async function focusHousekeeping({ keepDays = 30, now = Date.now() } = {}) {
  await ensureInit();
  try { return await _D.db.focusPrune({ before: now - Math.max(1, keepDays) * 86_400_000 }); } catch (e) { return { error: String(e?.message || e).slice(0, 160) }; }
}
