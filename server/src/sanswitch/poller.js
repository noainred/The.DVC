/**
 * sanswitch/poller.js — SAN 스위치 수집 폴러(v2.410).
 * 이 노드 몫 장비(registry.devicesForThisNode)를 주기 수집해 store 에 최신 스냅샷을 둔다.
 *
 * CLAUDE.md 폴러 규칙을 그대로 따른다:
 *  - **재진입 가드**(이전 주기 미완이면 이번 틱 스킵) — 수동 실행 API 도 같은 가드를 공유한다.
 *  - **동시 수집 제한**(기본 4) — 한 법인에 스위치가 여러 대면 SSH 세션이 몰려 CPU/회선이 튄다.
 *  - **주기는 상수로 굳히지 않는다** — startAdaptiveTimer 로 매 회 다시 읽어 재무장한다
 *    (setInterval 은 생성 시 간격에 묶여 설정 변경이 재시작 전까지 안 먹는다).
 */
import { config } from '../config.js';
import { devicesForThisNode, getDeviceWithSecret } from './registry.js';
import { putSnapshot, getSnapshot } from './store.js';
import { recordActivity } from './activityLog.js';
import { emptySnapshot } from './types.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import * as fosSsh from './collectors/fosSsh.js';
import * as fosRest from './collectors/fosRest.js';
import { withDeadline, isSshAuthError } from '../proxy/sshExec.js';
import { createAuthGuard } from '../util/authGuard.js';
import { credFingerprintParts } from '../util/credFingerprint.js';
import { classifyFailure, makeTracer } from './testDiag.js';
import { precheckTarget } from './precheck.js';
import { poolRun as pool } from '../util/pool.js'; // v2.579(ARCH-01): 동시성 풀 단일 소스 — 손으로 쓴 사본 제거(첫 rejection 전파 = 예전과 같은 의미)

const CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.SANSW_CONCURRENCY) || 4));
const DEVICE_TIMEOUT_MS = Math.max(30_000, Number(process.env.SANSW_DEVICE_TIMEOUT_MS) || 120_000);

/** 주기(ms) — 포트 상태는 스토리지 용량보다 자주 봐야 해 기본 5분. 하한 60초. */
export const pollMs = () => Math.max(60_000, Number(process.env.SANSW_POLL_MS) || 5 * 60_000);

let _timer = null;
let _busy = false;
let _last = { at: 0, collected: 0, failed: 0 };
const _inFlight = new Map();

/**
 * SAN 스위치 주기 수집의 **인증 실패 정지**(v2.590 — 감사 F2, server/CLAUDE.md v2.541 '아직 가드가 없는 주기
 * SSH 수집기' 목록의 첫 항목). 재현: 틀린 비밀번호로 등록한 스위치 1대에 `pollSanSwitchOnce()` 3회 →
 * SSH 연결 3회·비밀번호 시도 6회(주기 5분이면 스위치당 하루 약 576회 실패 로그인 — 계정 잠금 경로).
 * 기본 수집(이 파일)과 포트 사용량 수집(`perfPoller.js`)은 **같은 장비 계정**이라 **같은 정지 기록**을 쓴다 —
 * 한쪽만 멈추면 다른 쪽이 계속 로그인해 잠금은 그대로다. 코어는 `util/authGuard.js` 하나다(v2.535).
 * 규칙: 조용히 멈추지 않는다(`extra.authStopped`) · 자격증명이 바뀌면 자동 재개 · 수동 실행('수집'·'전체 수집'·
 * 연결 테스트)은 막지 않는다 · 자격증명 거부(ssh2 `client-authentication`, REST 로그인 401)만 멈춘다.
 * 정지 id 는 장비 id — 엣지는 자기 몫 장비·자기 정지 파일을 쓰므로 법인 사이에 충돌하지 않는다.
 */
export const sanAuthGuard = createAuthGuard({ file: 'sanswitch-auth-stops.json' });

/** 오류가 스위치 **자격증명 거부**인가(출처: ssh2 의 level·정식 문구, REST 로그인의 '인증 실패(401)'). */
export function isSanAuthError(err) {
  if (!err) return false;
  return isSshAuthError(err) || /인증 실패\(401\)/.test(String(err.message || ''));
}

const stopView = (rec) => (rec ? { since: rec.since, at: rec.at, attempts: rec.attempts, reason: rec.reason } : null);

/** 정지 사실을 스냅샷 `extra` 에 싣는다(평문이 아닌 자격증명 지문 포함 — 엣지 위임 장비의 배포 대조용). */
function withAuthStopExtra(snap, full, rec) {
  const fp = credFingerprintParts(full.username, full.password);
  snap.extra = {
    ...(snap.extra || {}),
    authStopped: stopView(rec),
    credFp: { user: fp.user, len: fp.len, hash: fp.hash, space: fp.space, empty: fp.empty, userSpace: fp.userSpace },
    credFpSource: config.agent.centralUrl ? (config.agent.name || 'edge') : 'central',
  };
  return snap;
}

/**
 * 주기 수집에서 정지로 건너뛸 때 — 스냅샷이 정지 사실을 말하게 한다(재시작 뒤 스냅샷이 없어도 '미수집' 이
 * 아니라 '멈췄다' 로 보이게). 이미 같은 기록이 실려 있으면 다시 쓰지 않는다(매 주기 디스크·push 를 늘리지 않게).
 */
function noteAuthStopped(full, rec) {
  const prev = getSnapshot(full.id);
  const cur = prev?.extra?.authStopped;
  if (cur && cur.since === rec.since && cur.attempts === rec.attempts) return;
  const snap = prev ? { ...prev } : emptySnapshot(full);
  if (!prev) snap.error = `인증 실패로 주기 수집을 멈췄습니다 — ${rec.reason}`;
  putSnapshot(withAuthStopExtra(snap, full, rec));
}

function collectorFor(device) {
  if (device.type !== 'brocade') return null;
  return device.collectMethod === 'rest' ? fosRest.collect : fosSsh.collect;
}

async function collectOne(dev, { periodic = false } = {}) {
  // v2.590: **주기 수집만** 인증 실패 정지 장비를 건너뛴다(null = 정지 — 실패로 세지 않는다). 작업 로그에도
  // 남기지 않는다 — 정지 중에는 이벤트가 아니다(상한을 비이벤트로 소진한다 — Horizon v2.535 와 같은 판단).
  if (periodic) {
    const full0 = getDeviceWithSecret(dev.id) || dev;
    const stop = sanAuthGuard.authStopFor(full0);
    if (stop) { noteAuthStopped(full0, stop); return null; }
  }
  const startedAt = Date.now();
  _inFlight.set(dev.id, { id: dev.id, name: dev.name || dev.id, at: startedAt });
  try {
    const full = getDeviceWithSecret(dev.id) || dev;
    const fn = collectorFor(full);
    let snap;
    let authErr = null;
    if (!fn) {
      snap = emptySnapshot(full);
      snap.error = `수집기 미구현: ${full.type}`;
    } else {
      try {
        // 장비당 타임아웃 — 느린 1대가 전체 주기를 막지 않게(고RTT 법인 대비).
        // v2.417: 결과만 포기하는 race 가 아니라 signal 로 세션을 실제로 끊는다(동시성 상한 실효 유지).
        snap = await withDeadline(DEVICE_TIMEOUT_MS, (signal) => fn(full, { signal }), '수집 타임아웃');
      } catch (e) {
        snap = emptySnapshot(full);
        snap.error = e.message || String(e);
        if (isSanAuthError(e)) authErr = e;
      }
    }
    snap.collectedAt = Date.now();
    snap.durationMs = snap.collectedAt - startedAt;
    // v2.590: 자격증명 거부면 주기 수집을 멈추고 그 사실을 스냅샷에 싣는다(조용히 멈추지 않는다).
    if (authErr) {
      const rec = sanAuthGuard.markAuthStopped(full.id || dev.id, full, snap.error);
      withAuthStopExtra(snap, full, rec);
      console.warn(`[sanswitch] ${dev.name || dev.id}: 인증 실패로 주기 수집 정지(${rec.attempts}회) — 비밀번호를 고치면 자동 재개합니다`);
    } else if (snap.ok) {
      sanAuthGuard.clearAuthStop(full.id || dev.id);
    }
    putSnapshot(snap);
    // 작업 로그(v2.516) — 성공/실패 모두 1건. 출처는 이 노드 성격: 중앙(centralUrl 없음)이면
    // 'central', 엣지면 자기 이름(엣지 로컬 로그용 — 중앙 화면엔 엣지 push 를 sanSwitchEdge 가 기록).
    // ⚠ 실패도 반드시 남긴다 — 실패만 사라지면 '왜 값이 없나' 를 추적할 근거가 없어진다.
    try {
      // ⚠ **실패 스냅샷의 포트 수치는 null 이다** — `emptySnapshot` 이 ports 를 0 으로 초기화하므로
      //   그대로 실으면 화면에 '0/0 · 0%' 가 찍혀 **'포트 0개' 라는 사실과 다른 표시**가 된다
      //   (v2.516 실측으로 발견: 도달 불가 장비의 로그가 portsOnline:0 이었다).
      //   '수집 못 함' 과 '진짜 0' 은 구분해야 한다(types.js 정직 표기 규칙).
      const p = snap.ok ? (snap.ports || {}) : {};
      recordActivity({
        deviceId: dev.id, name: snap.name || dev.name || dev.id, host: dev.host || '',
        source: config.agent.centralUrl ? (config.agent.name || 'edge') : 'central',
        ok: !!snap.ok,
        portsOnline: p.online ?? null, portsLicensed: p.licensed ?? null,
        portsFree: p.free ?? null, usedPct: p.usedPct ?? null,
        durationMs: snap.durationMs, error: snap.ok ? null : (snap.error || null), at: startedAt,
      });
    } catch { /* 로그 기록 실패가 수집 결과를 가리지 않게 */ }
    return snap.ok;
  } finally { _inFlight.delete(dev.id); }
}


/**
 * @param {{manual?: boolean}} [opts] manual — 관리자 '전체 수집'. v2.590: 수동 실행은 인증 실패 정지 장비도
 *   1회 시도한다(고쳤는지 확인할 길을 없애지 않는다). 타이머는 인자 없이 부른다(= 주기 수집).
 */
export async function pollSanSwitchOnce({ manual = false } = {}) {
  if (_busy) return { ok: false, reason: '이전 수집 진행 중(겹침 방지)' };
  _busy = true;
  const t0 = Date.now();
  let collected = 0; let failed = 0; let authStopped = 0;
  try {
    const devices = devicesForThisNode();
    await pool(devices, CONCURRENCY, async (d) => {
      const r = await collectOne(d, { periodic: !manual });
      if (r === null) authStopped++; else if (r) collected++; else failed++;
    });
    _last = { at: Date.now(), collected, failed, authStopped, durationMs: Date.now() - t0, total: devices.length };
    return { ok: true, ..._last };
  } finally { _busy = false; }
}

/** 단건 즉시 수집(중앙 UI '수집' 버튼 — 중앙 직접 수집 장비용). */
export async function collectDeviceNow(id) {
  const dev = devicesForThisNode().find((d) => d.id === id) || getDeviceWithSecret(id);
  if (!dev) throw new Error('이 노드가 수집하는 장비가 아닙니다.');
  // 폴러와 가드를 공유한다(CLAUDE.md '수동 실행 API 도 같은 가드') — 같은 스위치에 SSH 세션이 겹치면
  // in-flight 상태가 먼저 끝난 쪽에 지워지고 처리량 델타 간격이 흐트러진다.
  if (_inFlight.has(dev.id)) return false;
  await collectOne(dev);
  return true;
}

/**
 * 연결 테스트(등록 화면) — **스냅샷을 저장하지 않는다**. 아직 등록 전이거나 수정 중인 값으로
 * 도는 것이라, 저장하면 화면에 유령 장비가 생긴다(스토리지의 testDeviceConnection 과 동일 규칙).
 * SSH 방식은 CLI 원문을 함께 돌려줘, 파싱이 빗나갔을 때 운영자가 실제 출력을 보고 판단할 수 있게 한다.
 */
/**
 * v2.421: 단계별 추적(trace) + 사전 점검(DNS·TCP) + 실패 분류(phase/hint).
 *  - `trace(msg, level)` 를 주면 진행 상황을 실시간으로 받는다(테스트 실행 화면이 폴링으로 보여준다).
 *  - `verbose` 면 SSH 프로토콜 단계 로그(ssh2 debug — ssh -vvv 상당)까지 남긴다.
 *  - 사전 점검은 **접속이 어디서 막히는지**를 분리한다: DNS 해석 → TCP 연결(10초) 을 먼저 따로 해 보고
 *    실패하면 SSH 를 시도하지 않고 그 단계에서 끝낸다(readyTimeout 60초를 기다리며 "멈춘" 것처럼 보이지 않게).
 */
export async function testDeviceConnection(device, { timeoutMs = 60_000, trace = null, verbose = false, ranOn = '중앙' } = {}) {
  const t0 = Date.now();
  const tracer = makeTracer(t0);
  const say = (m, lv = 'info') => { tracer.push(m, lv); try { trace?.(m, lv); } catch { /* */ } };
  const rest = device.collectMethod === 'rest';
  const port = rest ? (Number(device.httpsPort) || 443) : (Number(device.sshPort) || 22);
  let phase = 'dns';
  const done = (r) => ({ ...r, ms: Date.now() - t0, trace: tracer.lines, traceDropped: tracer.dropped, ranOn, verbose });
  try {
    say(`연결 테스트 시작 — ${device.type}/${rest ? 'REST' : 'SSH'} ${device.host}:${port} 계정=${device.username || '(없음)'}${device.vfId ? ` VF=${device.vfId}` : ''} 실행 위치=${ranOn} 제한 ${Math.round(timeoutMs / 1000)}초${verbose ? ' [자세히: SSH 프로토콜 로그 포함]' : ''}`);
    if (device.type !== 'brocade') throw new Error(`수집기 미구현: ${device.type}`);
    // 사전 점검 — DNS·TCP 를 따로 재서 '어디서 막히는지' 분리
    const pre = await precheckTarget(device.host, port, { trace: say, timeoutMs: Math.min(10_000, timeoutMs) });
    if (!pre.ok) { phase = pre.phase; throw new Error(pre.reason); }
    phase = rest ? 'rest' : 'ssh-handshake';
    if (rest) {
      const snap = await withDeadline(timeoutMs, (signal) => fosRest.collect(device, { signal, trace: say }), '테스트 타임아웃');
      say(`완료 — 이름 ${snap.name || '—'} 모델 ${snap.model || '—'} FOS ${snap.fabricOs || '—'} 포트 ${snap.ports?.online ?? '—'}/${snap.ports?.licensed ?? '—'}`);
      return done({ ok: true, snap: summary(snap), cliRaw: [], phase: 'done' });
    }
    const wrapped = (m, lv) => { if (/세션 준비 완료/.test(String(m))) phase = 'exec'; else if (/핸드셰이크 완료/.test(String(m))) phase = 'ssh-auth'; say(m, lv); };
    const { snap, raw } = await withDeadline(timeoutMs, (signal) => fosSsh.collect(device, { withRaw: true, signal, trace: wrapped, verbose }), '테스트 타임아웃');
    say(`완료 — 이름 ${snap.name || '—'} 모델 ${snap.model || '—'} FOS ${snap.fabricOs || '—'} 포트 ${snap.ports?.online ?? '—'}/${snap.ports?.licensed ?? '—'} (${Date.now() - t0}ms)`);
    return done({ ok: true, snap: summary(snap), cliRaw: raw, phase: 'done' });
  } catch (e) {
    const reason = e.message || String(e);
    const c = classifyFailure(reason, phase, { agentDelegated: !!String(device.agent || '').trim(), ranOn });
    say(`실패(${c.phase}): ${reason}`, 'error');
    return done({ ok: false, reason, phase: c.phase, hint: c.hint });
  }
}

const summary = (s) => ({
  name: s.name, model: s.model, fabricOs: s.fabricOs, serial: s.serial, domainId: s.domainId,
  switchState: s.switchState,
  ports: { total: s.ports.total, licensed: s.ports.licensed, online: s.ports.online, free: s.ports.free, usedPct: s.ports.usedPct },
  sections: s.sections,
});

export function startSanSwitchPoller() {
  if (_timer) return;
  // 기동 25초 후 첫 수집(스토리지 폴러 15초와 겹치지 않게 어긋냄), 이후 현재 주기로 재무장.
  _timer = startAdaptiveTimer(pollMs, () => pollSanSwitchOnce(), { firstDelayMs: 25_000, name: 'SAN 스위치 수집' });
}

export function sanSwitchPollerStatus() {
  return { ..._last, intervalMs: pollMs(), busy: _busy, inFlight: [..._inFlight.values()], concurrency: CONCURRENCY };
}
