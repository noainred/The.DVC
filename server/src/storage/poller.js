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
import * as powerstore from './collectors/powerstore.js'; // v2.309
import * as unity from './collectors/unity.js';           // v2.309
import * as xtremio from './collectors/xtremio.js';       // v2.310
import * as powermax from './collectors/powermax.js';     // v2.310(vmax·powermax 공용 — 같은 Unisphere REST)
import * as vplex from './collectors/vplex.js';           // v2.311(vplex·metronode 공용 — 같은 Element Manager REST 계열)
import { collectAreasOnce } from './areasCollector.js';
import { saveCapacityPoint } from './db.js';
import { recordActivity } from './activityLog.js';

const COLLECTORS = { isilon: isilon.collect, powerstore: powerstore.collect, unity480: unity.collect,
  xtremio: xtremio.collect, vmax: powermax.collect, powermax: powermax.collect,
  vplex: vplex.collect, metronode: vplex.collect };
const INTERVAL_MS = Math.max(60_000, Number(process.env.STORAGE_POLL_MS) || 10 * 60_000); // 기본 10분
const AREAS_EVERY_MS = Math.max(10 * 60_000, Number(process.env.STORAGE_AREAS_MS) || 60 * 60_000); // 영역 전수 수집 기본 60분
const _areasAt = new Map(); // deviceId → 마지막 영역 수집 시각(메모리 — 재시작 시 첫 주기에 재수집)
let _timer = null;
let _busy = false;
let _last = { at: 0, collected: 0, failed: 0 };
// 진행중(in-flight) 장비 — 화면 '작업 로그'의 '진행중' 구획이 이걸 읽는다(deviceId → {id,name,at}).
// collectOne 시작에 추가하고 finally 에서 제거해, 수집이 죽어도 유령으로 남지 않게 한다.
const _inFlight = new Map();

async function collectOne(dev) {
  const startedAt = Date.now();
  _inFlight.set(dev.id, { id: dev.id, name: dev.name || dev.id, at: startedAt });
  try {
    return await collectOneInner(dev, startedAt);
  } finally { _inFlight.delete(dev.id); }
}

async function collectOneInner(dev, startedAt) {
  const fn = COLLECTORS[dev.type];
  const full = getDeviceWithSecret(dev.id) || dev;
  let snap;
  if (!fn) { snap = emptySnapshot(full); snap.error = `수집기 미구현: ${dev.type}`; }
  else if (config.dataSource === 'mock') { // v2.310 수정: config.mode 는 미존재 키(항상 undefined)라 mock 분기가 죽어 있었음 — 확립 패턴(dataSource)으로 교정
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
  // ⚠ 스냅샷 저장(회귀 수정 — v2.310 적대적 검증에서 확정): v2.308 리팩터가 이 무조건
  // putSnapshot 을 saveCapacityPoint 로 '교체'하면서 삭제해 버려, 정규/수동 수집 결과가
  // 스토어(localSnapshots)에 안 들어가 UI 조회·엣지 push 가 전부 빈손이 되는 회귀가 있었다
  // (isilon 만 아래 60분 areas 분기의 재저장으로 우연히 살아 있었음). 성공/실패 모두 저장한다 —
  // 실패 스냅샷(error·섹션 상태)도 화면에 정직하게 보여야 한다(types.js sections 계약).
  putSnapshot(snap);
  // 용량 시계열(v2.308) — 성공 수집마다 1점 적재(추이 그래프/DB 저장 요구).
  try { await saveCapacityPoint(snap); } catch { /* DB 비활성 환경 — 스냅샷 경로는 계속 */ }
  // OneFS API 전 영역 수집(v2.308, 40개 표) — 스냅샷보다 무거워 별도 주기(기본 60분)로.
  // mock 모드는 요약만 시뮬레이션. 실패는 영역별 요약에 그대로 남는다(은폐 금지).
  if (snap.ok && dev.type === 'isilon') {
    const last = _areasAt.get(dev.id) || 0;
    if (Date.now() - last >= AREAS_EVERY_MS) {
      _areasAt.set(dev.id, Date.now());
      try {
        const r = config.dataSource === 'mock'
          ? { summary: [{ area: 'cluster', ok: 3, failed: 0 }, { area: 'node', ok: 1, failed: 0 }], endpoints: 4 }
          : await collectAreasOnce(full);
        snap.extra = { ...snap.extra, areas: r.summary, areasAt: Date.now(), areasEndpoints: r.endpoints };
        putSnapshot(snap); // 요약 갱신분 재저장(push 가 최신 요약을 실어가게)
      } catch (e) { snap.extra = { ...snap.extra, areasError: e.message }; putSnapshot(snap); }
    }
  }
  // 작업 로그 기록(v2.315) — 성공/실패 모두 1건. 출처는 이 노드 성격: 중앙(centralUrl 없음)이면
  // 'central', 엣지면 자기 이름(엣지 로컬 로그용 — 중앙 화면엔 엣지 push 를 storageEdge 가 별도 기록).
  const source = config.agent.centralUrl ? (config.agent.name || 'edge') : 'central';
  try {
    recordActivity({
      deviceId: dev.id, name: snap.name || dev.name || dev.id, host: dev.host || '', source,
      ok: !!snap.ok, nodes: snap.nodes?.count ?? null,
      usedBytes: snap.capacity?.usedBytes ?? null, totalBytes: snap.capacity?.totalBytes ?? null,
      durationMs: Date.now() - startedAt, error: snap.ok ? null : (snap.error || null), at: startedAt,
    });
  } catch { /* 로그 기록 실패가 수집 결과를 가리지 않게 */ }
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

/**
 * 등록 전 연결/API 동작 테스트(v2.404, 사용자 요구 — Unity 등록 시 API 가 실제로 도는지 확인).
 * 입력받은 장비 정보로 **수집기만 1회** 돌리고 결과를 그대로 돌려준다.
 *
 * ⚠ putSnapshot / recordActivity / saveCapacityPoint 를 부르지 않는다 — 아직 등록되지 않은
 *   장비의 결과가 조회 목록·수집 작업 로그·용량 추이에 섞이면 안 된다(테스트가 실데이터 오염).
 * ⚠ mock 모드에서도 가짜 스냅샷을 만들지 않는다(collectOneInner 와 다른 점). '실제 API 가
 *   도는지' 확인이 목적이라 가짜 성공을 돌려주면 테스트 자체가 거짓말이 된다.
 * 전체 상한 타임아웃을 둔다 — 수집기는 섹션마다 15초 HTTP 타임아웃이라 섹션이 많으면
 *   1분을 넘길 수 있고, 그동안 요청이 매달려 있으면 사용자는 멈춘 줄 안다.
 */
export async function testDeviceConnection(device, { timeoutMs = 60_000 } = {}) {
  const fn = COLLECTORS[device.type];
  const startedAt = Date.now();
  if (!fn) return { ok: false, error: `수집기 미구현: ${device.type}`, sections: {}, ms: 0 };
  let timer = null;
  try {
    const snap = await Promise.race([
      fn(device),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`테스트 시간 초과(${Math.round(timeoutMs / 1000)}초) — 방화벽/포트 또는 장비 응답 지연을 확인하세요.`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return { ...snap, ms: Date.now() - startedAt };
  } catch (e) {
    return { ok: false, error: e.message, sections: {}, ms: Date.now() - startedAt };
  } finally { if (timer) clearTimeout(timer); }
}

export function startStoragePoller() {
  if (_timer) return;
  setTimeout(() => pollStorageOnce().catch(() => {}), 15_000); // 기동 15초 후 첫 수집
  _timer = setInterval(() => pollStorageOnce().catch(() => {}), INTERVAL_MS);
  _timer.unref?.();
}
export function storagePollerStatus() {
  return { ..._last, intervalMs: INTERVAL_MS, busy: _busy, inFlight: [..._inFlight.values()] };
}
