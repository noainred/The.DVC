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
        snap = await withTimeout(fn(full), DEVICE_TIMEOUT_MS, `수집 타임아웃(${Math.round(DEVICE_TIMEOUT_MS / 1000)}초)`);
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

function withTimeout(p, ms, msg) {
  return Promise.race([p, new Promise((_, rej) => { const t = setTimeout(() => rej(new Error(msg)), ms); t.unref?.(); })]);
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
  await collectOne(dev);
  return true;
}

/**
 * 연결 테스트(등록 화면) — **스냅샷을 저장하지 않는다**. 아직 등록 전이거나 수정 중인 값으로
 * 도는 것이라, 저장하면 화면에 유령 장비가 생긴다(스토리지의 testDeviceConnection 과 동일 규칙).
 * SSH 방식은 CLI 원문을 함께 돌려줘, 파싱이 빗나갔을 때 운영자가 실제 출력을 보고 판단할 수 있게 한다.
 */
export async function testDeviceConnection(device, { timeoutMs = 60_000 } = {}) {
  const t0 = Date.now();
  try {
    if (device.type !== 'brocade') throw new Error(`수집기 미구현: ${device.type}`);
    if (device.collectMethod === 'rest') {
      const snap = await withTimeout(fosRest.collect(device), timeoutMs, '테스트 타임아웃');
      return { ok: true, ms: Date.now() - t0, snap: summary(snap), cliRaw: [] };
    }
    const { snap, raw } = await withTimeout(fosSsh.collect(device, { withRaw: true }), timeoutMs, '테스트 타임아웃');
    return { ok: true, ms: Date.now() - t0, snap: summary(snap), cliRaw: raw };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, reason: e.message || String(e) };
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
