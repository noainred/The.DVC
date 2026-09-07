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
import { putSnapshot } from './store.js';
import { emptySnapshot } from './types.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import * as fosSsh from './collectors/fosSsh.js';
import * as fosRest from './collectors/fosRest.js';
import { withDeadline } from '../proxy/sshExec.js';
import { classifyFailure, makeTracer } from './testDiag.js';
import { precheckTarget } from './precheck.js';

const CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.SANSW_CONCURRENCY) || 4));
const DEVICE_TIMEOUT_MS = Math.max(30_000, Number(process.env.SANSW_DEVICE_TIMEOUT_MS) || 120_000);

/** 주기(ms) — 포트 상태는 스토리지 용량보다 자주 봐야 해 기본 5분. 하한 60초. */
export const pollMs = () => Math.max(60_000, Number(process.env.SANSW_POLL_MS) || 5 * 60_000);

let _timer = null;
let _busy = false;
let _last = { at: 0, collected: 0, failed: 0 };
const _inFlight = new Map();

function collectorFor(device) {
  if (device.type !== 'brocade') return null;
  return device.collectMethod === 'rest' ? fosRest.collect : fosSsh.collect;
}

async function collectOne(dev) {
  const startedAt = Date.now();
  _inFlight.set(dev.id, { id: dev.id, name: dev.name || dev.id, at: startedAt });
  try {
    const full = getDeviceWithSecret(dev.id) || dev;
    const fn = collectorFor(full);
    let snap;
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
      }
    }
    snap.collectedAt = Date.now();
    snap.durationMs = snap.collectedAt - startedAt;
    putSnapshot(snap);
    return snap.ok;
  } finally { _inFlight.delete(dev.id); }
}

/** 동시 개수 제한 실행(storage.collectPool 과 같은 패턴 — 순간 부하 평탄화). */
async function pool(items, limit, fn) {
  const it = items[Symbol.iterator]();
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let n = it.next(); !n.done; n = it.next()) await fn(n.value);
  });
  await Promise.all(workers);
}

export async function pollSanSwitchOnce() {
  if (_busy) return { ok: false, reason: '이전 수집 진행 중(겹침 방지)' };
  _busy = true;
  const t0 = Date.now();
  let collected = 0; let failed = 0;
  try {
    const devices = devicesForThisNode();
    await pool(devices, CONCURRENCY, async (d) => { (await collectOne(d)) ? collected++ : failed++; });
    _last = { at: Date.now(), collected, failed, durationMs: Date.now() - t0, total: devices.length };
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
