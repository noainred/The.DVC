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
import { withDeadline } from '../proxy/sshExec.js';
import * as apcSsh from './collectors/apcSsh.js';
import { devicesForThisNode, getDeviceWithSecret } from './registry.js';
import { recordSnapshot } from './db.js';
import { pollMs, startAdaptiveTimer } from './intervals.js';
import { emptySnapshot, summarize } from './types.js';
import { evaluateSnapshot, diffAlerts, loadThresholds, forgetDeviceAlerts } from './thresholds.js';
import { loadAlertConfig, notify } from '../alerts.js';
import { poolRun } from '../util/pool.js'; // v2.575 IMP-08 — 동시성 풀 단일 소스

const CONCURRENCY = Math.max(1, Number(process.env.PDU_CONCURRENCY) || 4);
const DEVICE_TIMEOUT_MS = Math.max(10_000, Number(process.env.PDU_DEVICE_TIMEOUT_MS) || 90_000);

let _running = false;                 // 재진입 가드(수동 실행과 공유)
let _timer = null;
let _last = { at: null, ok: 0, fail: 0, durationMs: null };
const _snapshots = new Map();         // deviceId → 최근 스냅샷(중앙/엣지 공통 인메모리)

/** 한 대 수집 + 시계열 적재. 실패해도 스냅샷(ok:false)을 남겨 화면이 원인을 보여준다. */
const _inFlight = new Set();          // v2.479(감사 도메인 B-3): 같은 장비 동시 수집 금지(수동 '지금 수집' × 폴러 — SSH 2세션·늦은 결과가 최신을 덮음)
export async function collectDeviceNow(deviceId, { onTrace = null } = {}) {
  const dev = getDeviceWithSecret(deviceId);
  if (!dev) return { ok: false, reason: '없는 장비입니다.' };
  if (_inFlight.has(dev.id)) return { ok: false, skipped: true, reason: '이 장비는 이미 수집 중입니다.' };
  _inFlight.add(dev.id);
  const started = Date.now();
  try {
    const snap = await withDeadline(DEVICE_TIMEOUT_MS,
      (signal) => apcSsh.collect(dev, { signal, onTrace }), '수집 타임아웃');
    snap.agent = config.agent.centralUrl ? config.agent.name : '';
    _snapshots.set(dev.id, snap);
    await recordSnapshot(snap);
    return { ok: true, ms: Date.now() - started, snap: { ...snap, summary: summarize(snap) } };
  } catch (e) {
    const snap = emptySnapshot(dev);
    snap.ok = false;
    snap.error = e.message || String(e);
    snap.agent = config.agent.centralUrl ? config.agent.name : '';
    _snapshots.set(dev.id, snap);
    return { ok: false, ms: Date.now() - started, reason: snap.error };
  } finally { _inFlight.delete(dev.id); }
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
        units: snap.units.map((u) => ({ index: u.index, powerW: u.powerW, banks: u.banks.length, phases: u.phases.length })),
        sensors: snap.sensors.map((s) => ({ index: s.index, name: s.name, tempC: s.tempC, humidityPct: s.humidityPct })),
      },
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, reason: e.message || String(e) };
  }
}

/** 한 주기: 이 노드가 맡은 장비 전부를 동시성 제한 아래 수집. */
export async function pollOnce() {
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
  let ok = 0, fail = 0;
  try {
    // v2.575 IMP-08: 동시성 풀 단일 소스.
    await poolRun(devices, CONCURRENCY, async (d) => {
      const r = await collectDeviceNow(d.id);
      if (r.ok) ok++; else fail++;
    });
    // 임계치 평가는 **한 주기가 끝난 뒤 한 번**만 한다 — 장비마다 평가하면 '복구' 판정이
    // 아직 수집 안 된 장비를 '위반 해소'로 잘못 읽는다(diffAlerts 는 전체 위반 집합을 본다).
    await evaluateAndNotify();
    _last = { at: Date.now(), ok, fail, durationMs: Date.now() - started };
    return { ok: true, devices: devices.length, collected: ok, failed: fail };
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
    for (const s of _snapshots.values()) {
      if (s && s.ok === false) { heldDeviceIds.push(s.id); continue; }   // 못 읽은 장비는 판정 보류(v2.583)
      violations.push(...evaluateSnapshot(s, th));
    }
    const cfg = loadAlertConfig();
    const { fire, resolve } = diffAlerts(violations, { cooldownMs: (cfg.cooldownMin || 60) * 60_000, heldDeviceIds });
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
export function getLocalSnapshot(id) { return _snapshots.get(id) || null; }
export function _resetForTest() { _snapshots.clear(); _running = false; _last = { at: null, ok: 0, fail: 0, durationMs: null }; }
