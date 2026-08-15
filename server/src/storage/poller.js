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
import { collectAreasOnce } from './areasCollector.js';
import { saveCapacityPoint } from './db.js';

const COLLECTORS = { isilon: isilon.collect };
const INTERVAL_MS = Math.max(60_000, Number(process.env.STORAGE_POLL_MS) || 10 * 60_000); // 기본 10분
const AREAS_EVERY_MS = Math.max(10 * 60_000, Number(process.env.STORAGE_AREAS_MS) || 60 * 60_000); // 영역 전수 수집 기본 60분
const _areasAt = new Map(); // deviceId → 마지막 영역 수집 시각(메모리 — 재시작 시 첫 주기에 재수집)
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
    snap.media = { hdd: { totalBytes: 450e12, usedBytes: 290e12, pct: 64.4 }, ssd: { totalBytes: 50e12, usedBytes: 22e12, pct: 44 } };
    snap.nodes = { count: 4, unhealthy: 0, list: Array.from({ length: 4 }, (_, i) => ({
      id: i + 1, ip: `10.94.41.${202 + i}`, health: 'ok', inBps: 3.4e6 * (i + 1), outBps: 1.2e7,
      hdd: i < 2 ? { totalBytes: 108e12, usedBytes: 88e12, pct: 81.5 } : null,  // 무디스크 노드(No Storage HDDs) 재현
      ssd: { totalBytes: 20.7e12, usedBytes: 17.6e12, pct: 85 },
    })) };
    snap.pools = [{ name: 'h500_30tb', totalBytes: 500e12, usedBytes: 312e12, pct: 62.4 }];
    snap.accounts = [{ name: 'root', enabled: true }, { name: 'admin', enabled: true }];
    snap.sections = { config: 'ok', capacity: 'ok', nodes: 'ok', accounts: 'ok', alerts: 'ok' };
    snap.extra = { collectMethod: full.collectMethod || 'ssh', clusterHealth: 'OK', dataReduction: '1.00:1', storageEfficiency: '0.83:1', vhsBytes: 15.4 * 1024 ** 4, l3TotalBytes: 8.7 * 1024 ** 4 };
  } else {
    try { snap = await fn(full); }
    catch (e) { snap = emptySnapshot(full); snap.error = e.message; }
  }
  // 용량 시계열(v2.308) — 성공 수집마다 1점 적재(추이 그래프/DB 저장 요구).
  try { await saveCapacityPoint(snap); } catch { /* DB 비활성 환경 — 스냅샷 경로는 계속 */ }
  // OneFS API 전 영역 수집(v2.308, 40개 표) — 스냅샷보다 무거워 별도 주기(기본 60분)로.
  // mock 모드는 요약만 시뮬레이션. 실패는 영역별 요약에 그대로 남는다(은폐 금지).
  if (snap.ok && dev.type === 'isilon') {
    const last = _areasAt.get(dev.id) || 0;
    if (Date.now() - last >= AREAS_EVERY_MS) {
      _areasAt.set(dev.id, Date.now());
      try {
        const r = config.mode === 'mock'
          ? { summary: [{ area: 'cluster', ok: 3, failed: 0 }, { area: 'node', ok: 1, failed: 0 }], endpoints: 4 }
          : await collectAreasOnce(full);
        snap.extra = { ...snap.extra, areas: r.summary, areasAt: Date.now(), areasEndpoints: r.endpoints };
        putSnapshot(snap); // 요약 갱신분 재저장(push 가 최신 요약을 실어가게)
      } catch (e) { snap.extra = { ...snap.extra, areasError: e.message }; putSnapshot(snap); }
    }
  }
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
