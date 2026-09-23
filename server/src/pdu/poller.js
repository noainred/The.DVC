/**
 * pdu/poller.js — PDU 주기 수집.
 *
 * 이 저장소의 폴러 규약을 그대로 지킨다(CLAUDE.md):
 *  - **재진입 가드**: 이전 주기가 안 끝났으면 이번 틱을 건너뛴다(수동 실행 API 도 가드 공유).
 *  - **동시 수집 제한**(`PDU_CONCURRENCY` 기본 4): 수십 대를 한꺼번에 열면 SSH 세션이 폭증한다.
 *  - **장비당 타임아웃은 세션을 실제로 끊는다**(v2.417): `withDeadline` 의 signal 을 수집기에
 *    넘겨 SSH 세션 자체를 종료시킨다. Promise.race 로 결과만 포기하면 세션이 남은 명령을
 *    끝까지 돌려 동시성 상한이 실효를 잃고 다음 주기가 같은 장비에 두 번째 세션을 연다.
 *  - **startAdaptiveTimer**: setInterval 은 생성 시 간격에 묶여 중앙 주기 변경이 안 먹는다.
 */

import { config } from '../config.js';
import { withDeadline, isSshAuthError } from '../proxy/sshExec.js';
import { createAuthGuard } from '../util/authGuard.js';
import * as apcSsh from './collectors/apcSsh.js';
import { devicesForThisNode, getDeviceWithSecret } from './registry.js';
import { recordSnapshot } from './db.js';
import { pollMs, startAdaptiveTimer } from './intervals.js';
import { emptySnapshot, summarize } from './types.js';
import { evaluateSnapshot, diffAlerts, loadThresholds, forgetDeviceAlerts, readAlertKeys } from './thresholds.js';
import { loadAlertConfig, notify } from '../alerts.js';
import { poolRun } from '../util/pool.js'; // v2.575 IMP-08 — 동시성 풀 단일 소스

const CONCURRENCY = Math.max(1, Number(process.env.PDU_CONCURRENCY) || 4);
const DEVICE_TIMEOUT_MS = Math.max(10_000, Number(process.env.PDU_DEVICE_TIMEOUT_MS) || 90_000);

let _running = false;                 // 재진입 가드(수동 실행과 공유)
let _timer = null;
let _last = { at: null, ok: 0, fail: 0, durationMs: null };
const _snapshots = new Map();         // deviceId → 최근 스냅샷(중앙/엣지 공통 인메모리)

/**
 * PDU 주기 수집의 **인증 실패 정지**(v2.590 — 감사 F2, server/CLAUDE.md v2.541 '아직 가드가 없는 주기 SSH
 * 수집기'). 예전에는 틀린 비밀번호로 5분마다 NMC 에 SSH 로그인했다(APC NMC 는 로그인 실패가 반복되면 계정을
 * 잠근다). 코어는 `util/authGuard.js` 하나다. 멈추는 것은 ssh2 `client-authentication` 뿐 — 타임아웃·연결
 * 실패로는 멈추지 않는다. 수동 '지금 수집'·'전체 수집'·연결 테스트는 막지 않는다. 정지 사실은 스냅샷의
 * `authStopped` 로 화면이 말한다(엣지 스냅샷은 그대로 중앙에 push 된다).
 */
const authGuard = createAuthGuard({ file: 'pdu-auth-stops.json' });
const stopView = (rec) => (rec ? { since: rec.since, at: rec.at, attempts: rec.attempts, reason: rec.reason } : null);

/** 한 대 수집 + 시계열 적재. 실패해도 스냅샷(ok:false)을 남겨 화면이 원인을 보여준다. */
const _inFlight = new Set();          // v2.479(감사 도메인 B-3): 같은 장비 동시 수집 금지(수동 '지금 수집' × 폴러 — SSH 2세션·늦은 결과가 최신을 덮음)
/**
 * @param {string} deviceId
 * @param {{onTrace?: Function, periodic?: boolean}} [opts] periodic — 주기 수집(폴러). v2.590: 인증 실패로 멈춘
 *   장비는 **주기 수집에서만** 건너뛴다. 수동 '지금 수집'(기본값 false)은 막지 않는다.
 */
export async function collectDeviceNow(deviceId, { onTrace = null, periodic = false } = {}) {
  const dev = getDeviceWithSecret(deviceId);
  if (!dev) return { ok: false, reason: '없는 장비입니다.' };
  if (periodic) {
    const stop = authGuard.authStopFor(dev);
    if (stop) {
      // 정지 사실을 스냅샷에 싣는다 — 재시작 뒤(인메모리가 빈 상태)에도 '미수집' 이 아니라 '멈췄다' 로 보이게.
      // ⚠ 직전 스냅샷은 **실패 스냅샷**이다(값을 지어내지 않는다) — 시각도 마지막 시도 시각 그대로 둔다.
      const prev = _snapshots.get(dev.id);
      const snap = prev ? { ...prev } : { ...emptySnapshot(dev), error: `인증 실패로 주기 수집을 멈췄습니다 — ${stop.reason}`, agent: config.agent.centralUrl ? config.agent.name : '' };
      snap.authStopped = stopView(stop);
      _snapshots.set(dev.id, snap);
      return { ok: false, skipped: true, authStopped: stopView(stop), reason: '인증 실패로 주기 수집이 정지된 장비입니다(비밀번호를 고치면 자동 재개).' };
    }
  }
  if (_inFlight.has(dev.id)) return { ok: false, skipped: true, reason: '이 장비는 이미 수집 중입니다.' };
  _inFlight.add(dev.id);
  const started = Date.now();
  try {
    const snap = await withDeadline(DEVICE_TIMEOUT_MS,
      (signal) => apcSsh.collect(dev, { signal, onTrace }), '수집 타임아웃');
    snap.agent = config.agent.centralUrl ? config.agent.name : '';
    _snapshots.set(dev.id, snap);
    authGuard.clearAuthStop(dev.id); // 로그인됐다 — 정지 해제
    await recordSnapshot(snap);
    return { ok: true, ms: Date.now() - started, snap: { ...snap, summary: summarize(snap) } };
  } catch (e) {
    const snap = emptySnapshot(dev);
    snap.ok = false;
    snap.error = e.message || String(e);
    snap.agent = config.agent.centralUrl ? config.agent.name : '';
    // v2.590: 자격증명 거부면 주기 수집을 멈추고 그 사실을 스냅샷에 싣는다(조용히 멈추지 않는다).
    if (isSshAuthError(e)) {
      const rec = authGuard.markAuthStopped(dev.id, dev, snap.error);
      snap.authStopped = stopView(rec);
      console.warn(`[pdu] ${dev.name || dev.id}: 인증 실패로 주기 수집 정지(${rec.attempts}회) — 비밀번호를 고치면 자동 재개합니다`);
    }
    _snapshots.set(dev.id, snap);
    return { ok: false, ms: Date.now() - started, reason: snap.error, ...(snap.authStopped ? { authStopped: snap.authStopped } : {}) };
  } finally { _inFlight.delete(dev.id); }
}

/**
 * 연결 테스트의 유닛 요약(v2.598 RECENT2598-04). 데이지체인 유닛 2 이상은 뱅크·상을 **읽지 않으므로**
 * (`apcSsh.js` banksNotCollected — v2.597 C2597-01) 개수를 0 이 아니라 **null** 로 둔다 —
 * '뱅크 0 · 상 0' 은 '뱅크가 없다' 는 거짓이 된다. 화면은 null 을 '미수집' 으로 쓴다.
 */
export function detectedUnits(snap) {
  return (snap?.units || []).map((u) => ({
    index: u.index, powerW: u.powerW,
    banks: u.banksNotCollected ? null : (u.banks || []).length,
    phases: u.banksNotCollected ? null : (u.phases || []).length,
    ...(u.banksNotCollected ? { banksNotCollected: true } : {}),
  }));
}

/** 등록 화면 '연결 테스트' — 저장 전 임의 입력으로도 동작(레지스트리를 거치지 않는다). */
export async function testDeviceConnection(device, { timeoutMs = 60_000, onTrace = null } = {}) {
  const t0 = Date.now();
  try {
    const snap = await withDeadline(timeoutMs, (signal) => apcSsh.collect(device, { signal, onTrace }), '테스트 타임아웃');
    return {
      ok: snap.ok, ms: Date.now() - t0,
      model: snap.model, serial: snap.serial, aosVersion: snap.aosVersion, appVersion: snap.appVersion,
      units: snap.units.length, sensors: snap.sensors.length,
      summary: summarize(snap), notes: snap.notes,
      // 자동 탐지 결과를 그대로 보여준다 — '몇 대/몇 개를 찾았는지'가 이 테스트의 핵심 가치.
      detected: {
        units: detectedUnits(snap),
        sensors: snap.sensors.map((s) => ({ index: s.index, name: s.name, tempC: s.tempC, humidityPct: s.humidityPct })),
      },
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, reason: e.message || String(e) };
  }
}

/**
 * 한 주기: 이 노드가 맡은 장비 전부를 동시성 제한 아래 수집.
 * @param {{manual?: boolean}} [opts] manual — 관리자 '전체 수집'(인증 실패 정지 장비도 1회 시도한다 — v2.590).
 */
export async function pollOnce({ manual = false } = {}) {
  if (_running) return { ok: false, reason: '이미 수집 중입니다.', running: true };
  const devices = devicesForThisNode();
  // v2.583: 삭제·재배정된 장비의 스냅샷을 대상 목록 기준으로 걸러낸다 — 남겨 두면 없는 장비에 대해 계속
  //   임계 알림이 나가고 push 에도 실린다(인메모리 상태 맵은 대상 목록으로 정리한다 — v2.550.3 규약).
  {
    const live = new Set(devices.map((d) => String(d.id)));
    const gone = [..._snapshots.keys()].filter((id) => !live.has(String(id)));
    for (const id of gone) _snapshots.delete(id);
    if (gone.length) forgetDeviceAlerts(gone);   // 없어진 장비를 '정상 복귀' 로 알리지 않는다
  }
  if (!devices.length) { _last = { ..._last, at: Date.now(), ok: 0, fail: 0 }; return { ok: true, devices: 0 }; }
  _running = true;
  const started = Date.now();
  let ok = 0, fail = 0, authStopped = 0;
  try {
    // v2.575 IMP-08: 동시성 풀 단일 소스.
    await poolRun(devices, CONCURRENCY, async (d) => {
      const r = await collectDeviceNow(d.id, { periodic: !manual });
      // 정지로 건너뛴 장비는 실패로 세지 않는다(매 주기 '실패 N대' 가 새 장애처럼 보인다 — 스토리지 v2.528).
      if (r.ok) ok++; else if (r.skipped && r.authStopped) authStopped++; else fail++;
    });
    // 임계치 평가는 **한 주기가 끝난 뒤 한 번**만 한다 — 장비마다 평가하면 '복구' 판정이
    // 아직 수집 안 된 장비를 '위반 해소'로 잘못 읽는다(diffAlerts 는 전체 위반 집합을 본다).
    await evaluateAndNotify();
    _last = { at: Date.now(), ok, fail, authStopped, durationMs: Date.now() - started };
    return { ok: true, devices: devices.length, collected: ok, failed: fail, authStopped };
  } finally { _running = false; }
}

/**
 * 이 노드가 들고 있는 스냅샷 전체를 임계치와 대조해 상태 전이분만 알린다.
 * 엣지에서도 동작한다(현장에서 바로 알리는 편이 빠르다 — 중앙 push 를 기다리지 않는다).
 */
async function evaluateAndNotify() {
  try {
    const th = loadThresholds();
    if (th.enabled === false) return;
    const violations = [];
    const heldDeviceIds = [];
    const readKeys = new Set();
    for (const s of _snapshots.values()) {
      if (s && s.ok === false) { heldDeviceIds.push(s.id); continue; }   // 못 읽은 장비는 판정 보류(v2.583)
      violations.push(...evaluateSnapshot(s, th));
      for (const k of readAlertKeys(s)) readKeys.add(k);                  // v2.590 F5: 값을 읽은 항목만 해소 판정
    }
    const cfg = loadAlertConfig();
    const { fire, resolve, dropped } = diffAlerts(violations, { cooldownMs: (cfg.cooldownMin || 60) * 60_000, heldDeviceIds, readKeys });
    if (dropped?.length) console.warn(`[pdu] 값을 오래 읽지 못한 경보 ${dropped.length}건을 해소 알림 없이 끊었습니다(복구가 아니라 확인 불가): ${dropped.slice(0, 5).join(', ')}`);
    for (const a of [...fire, ...resolve]) {
      await notify(a, cfg).catch(() => {}); // 알림 실패가 수집을 막지 않는다
    }
  } catch (e) {
    console.error('[pdu] 임계치 평가 실패:', e.message);
  }
}

export function startPduPoller() {
  if (_timer) return;
  // 첫 실행은 부팅 45초 후(다른 수집과 겹치지 않게), 이후 중앙 배포 주기로 재무장.
  _timer = startAdaptiveTimer(pollMs, () => pollOnce(), { firstDelayMs: 45_000, name: 'pdu-poll' });
  console.log(`[pdu] poller started (interval=${Math.round(pollMs() / 1000)}s, concurrency=${CONCURRENCY})`);
}

export function pduPollerStatus() {
  return { running: _running, last: _last, intervalMs: pollMs(), concurrency: CONCURRENCY, deviceTimeoutMs: DEVICE_TIMEOUT_MS };
}

/** 이 노드가 들고 있는 최근 스냅샷(중앙 직접 수집분 + 엣지 로컬분). */
export function localSnapshots() { return [..._snapshots.values()]; }
/** v2.597(L2597-05): 설정 pull 로 빠진 장비의 스냅샷·알림 상태를 즉시 지운다(다음 수집까지 push 되지 않게). */
export function forgetDevices(ids) {
  const gone = (ids || []).map(String).filter((id) => _snapshots.delete(id) || true);
  if (gone.length) forgetDeviceAlerts(gone);
  return gone.length;
}
export function getLocalSnapshot(id) { return _snapshots.get(id) || null; }
export function _resetForTest() { _snapshots.clear(); _running = false; _last = { at: null, ok: 0, fail: 0, durationMs: null }; authGuard._resetForTest(); }
