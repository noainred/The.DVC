/**
 * storage/poller.js — 스토리지 수집 폴러(v2.302).
 * 이 노드 몫 장비(registry.devicesForThisNode)를 주기 수집해 store 에 최신 스냅샷을 둔다.
 * CLAUDE.md 폴러 규칙: 재진입 가드(이전 주기 미완이면 스킵) + 장비 병렬 3개 제한 + 장비당
 * 타임아웃(수집기 내부 15초 × 섹션) — 느린 장비 1대가 전체 주기를 못 막게.
 * 새 타입 추가 시 COLLECTORS 에 한 줄(types.js 절차 ①의 연결 지점).
 */
import { config } from '../config.js';
import { devicesForThisNode, getDeviceWithSecret } from './registry.js';
import { putSnapshot } from './store.js';
import { emptySnapshot } from './types.js';
import * as isilon from './collectors/isilon.js';

const COLLECTORS = { isilon: isilon.collect };
const INTERVAL_MS = Math.max(60_000, Number(process.env.STORAGE_POLL_MS) || 10 * 60_000); // 기본 10분
let _timer = null;
let _busy = false;
let _last = { at: 0, collected: 0, failed: 0 };

async function collectOne(dev) {
  const fn = COLLECTORS[dev.type];
  const full = getDeviceWithSecret(dev.id) || dev;
  let snap;
  if (!fn) { snap = emptySnapshot(full); snap.error = `수집기 미구현: ${dev.type}`; }
  else if (config.mode === 'mock') {
    // mock 모드(개발): 결정적 가짜 스냅샷 — UI/집계/push 흐름 검증용.
    snap = emptySnapshot(full);
    snap.ok = true; snap.version = 'OneFS 9.4.0(mock)'; snap.serial = `MOCK-${dev.id}`;
    snap.capacity = { totalBytes: 500e12, usedBytes: 312e12, pct: 62.4 };
    snap.nodes = { count: 4, unhealthy: 0 };
    snap.pools = [{ name: 'h500_30tb', totalBytes: 500e12, usedBytes: 312e12, pct: 62.4 }];
    snap.accounts = [{ name: 'root', enabled: true }, { name: 'admin', enabled: true }];
    snap.sections = { config: 'ok', capacity: 'ok', nodes: 'ok', accounts: 'ok', alerts: 'ok' };
  } else {
    try { snap = await fn(full); }
    catch (e) { snap = emptySnapshot(full); snap.error = e.message; }
  }
  putSnapshot(snap);
  return snap.ok;
}

export async function pollStorageOnce() {
  if (_busy) return { skipped: true }; // 재진입 가드
  _busy = true;
  try {
    const devs = devicesForThisNode();
    let ok = 0, fail = 0;
    // 병렬 3개 제한 — 수집이 몰려 장비/네트워크에 부하 주지 않게(단순 워커 풀).
    let idx = 0;
    const worker = async () => { while (idx < devs.length) { const d = devs[idx++]; (await collectOne(d)) ? ok++ : fail++; } };
    await Promise.all(Array.from({ length: Math.min(3, devs.length) }, worker));
    _last = { at: Date.now(), collected: ok, failed: fail };
    return { ok, fail };
  } finally { _busy = false; }
}

/** 단일 장비 즉시 수집(등록 화면 '연결 테스트'/'지금 수집') — 폴러 가드와 독립(1대 한정이라 안전). */
export async function collectDeviceNow(id) {
  const dev = getDeviceWithSecret(id);
  if (!dev) throw new Error('장비를 찾을 수 없습니다.');
  await collectOne(dev);
  return true;
}

export function startStoragePoller() {
  if (_timer) return;
  setTimeout(() => pollStorageOnce().catch(() => {}), 15_000); // 기동 15초 후 첫 수집
  _timer = setInterval(() => pollStorageOnce().catch(() => {}), INTERVAL_MS);
  _timer.unref?.();
}
export function storagePollerStatus() { return { ..._last, intervalMs: INTERVAL_MS, busy: _busy }; }
