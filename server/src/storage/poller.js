/**
 * storage/poller.js — 스토리지 수집 폴러(v2.302).
 * 이 노드 몫 장비(registry.devicesForThisNode)를 주기 수집해 store 에 최신 스냅샷을 둔다.
 * CLAUDE.md 폴러 규칙: 재진입 가드(이전 주기 미완이면 스킵) + 장비 병렬 3개 제한 + 장비당
 * 타임아웃(수집기 내부 15초 × 섹션) — 느린 장비 1대가 전체 주기를 못 막게.
 * 새 타입 추가 시 COLLECTORS 에 한 줄(types.js 절차 ①의 연결 지점).
 */
import { config } from '../config.js';
// v2.528: 인증 실패(401) 장비는 주기 수집을 멈춘다(계정 잠금 방지) + 자격증명 지문 표시.
import { isAuthFailure, markAuthStopped, clearAuthStop, authStopFor } from './authGuard.js';
import { credFingerprintParts } from '../util/credFingerprint.js';
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
import { runtimeIntervals, runtimeIntervalSource, centralIntervalsInfo, startAdaptiveTimer, applyOwnIntervals } from './intervals.js';

import { withDeadline, deadlineMs } from '../proxy/sshExec.js';
import { poolRun } from '../util/pool.js'; // v2.575 IMP-08 — 동시성 풀 단일 소스
/** 장비당 수집 타임아웃 — 느린 어레이 1대가 전체 주기를 막지 않게(기본 3분, 하한 30초). */
const DEVICE_TIMEOUT_MS = Math.max(30_000, Number(process.env.STORAGE_DEVICE_TIMEOUT_MS) || 180_000);
// v2.598 T2598-01: OneFS 영역 수집(66 엔드포인트 직렬)의 시한 — 예전엔 없어서 응답 없는 장비 하나가 최대 약 16.5분
// 동안 폴러의 재진입 가드를 붙잡았다. 장비 수집 시한과 따로 둔다(고RTT 현장의 정상 영역 수집이 3분을 넘을 수 있다).
const AREAS_TIMEOUT_MS = Math.max(60_000, Number(process.env.STORAGE_AREAS_TIMEOUT_MS) || 300_000);
const COLLECTORS = { isilon: isilon.collect, powerstore: powerstore.collect, unity480: unity.collect,
  xtremio: xtremio.collect, vmax: powermax.collect, powermax: powermax.collect,
  vplex: vplex.collect, metronode: vplex.collect };
// 주기는 상수가 아니라 **매번 조회**한다(v2.409) — 중앙이 배포한 값(storage/intervals.js)이
// 즉시 반영되게. 예전에는 모듈 로드 시 env 로 굳어 있어 주기를 바꾸려면 엣지 재시작이 필요했다.
const pollMs = () => runtimeIntervals().pollMs;
const areasEveryMs = () => runtimeIntervals().areasMs;
const _areasAt = new Map(); // deviceId → 마지막 영역 수집 시각(메모리 — 재시작 시 첫 주기에 재수집)
let _timer = null;
let _busy = false;
let _last = { at: 0, collected: 0, failed: 0 };
// 진행중(in-flight) 장비 — 화면 '작업 로그'의 '진행중' 구획이 이걸 읽는다(deviceId → {id,name,at}).
// collectOne 시작에 추가하고 finally 에서 제거해, 수집이 죽어도 유령으로 남지 않게 한다.
const _inFlight = new Map();

async function collectOne(dev, { periodic = false } = {}) {
  // v2.528: **주기 수집만** 인증 실패 장비를 건너뛴다. 수동 실행('지금 수집'·연결 테스트)은
  // 사람이 1회 누르는 것이라 잠금 위험이 없고, 막으면 '고쳤는지 확인할 길' 이 사라진다.
  if (periodic) {
    const stop = authStopFor(dev);
    if (stop) return null;
  }
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
    // ⚠ 이 값들은 **가짜**다. 예전에는 그 사실이 version 문자열의 '(mock)' 괄호로만 드러나서,
    //   PowerStore 장비에 'OneFS 9.4.0(mock)' 이 찍혀도 진짜 수집값처럼 보였다(실제 사용자 혼동).
    //   extra.mock 플래그를 세워 UI 가 배지·배너로 분명히 표시하게 한다 — 스냅샷은 중앙으로
    //   push 되므로 이 플래그가 엣지의 mock 을 중앙 화면에서도 드러낸다.
    snap.ok = true; snap.version = 'MOCK(가짜 데이터)'; snap.serial = `MOCK-${dev.id}`;
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
    // ⚠ mock:true 를 여기(객체 리터럴)에 둔다 — 위에서 snap.extra.mock 만 세우면 이 줄의
    //   재할당이 통째로 덮어써 플래그가 사라진다(실측으로 잡은 실수).
    snap.extra = { mock: true, collectMethod: full.collectMethod || 'ssh', clusterHealth: 'OK', dataReduction: '1.00:1', storageEfficiency: '0.83:1', vhsBytes: 15.4 * 1024 ** 4, l3TotalBytes: 8.7 * 1024 ** 4 };
  } else {
    // 장비당 타임아웃(v2.417) — 예전에는 없었다(CLAUDE.md 'per-vCenter 타임아웃' 규약 위반). SSH 계열
    // 수집기는 device._signal 을 withSsh creds 로 넘겨 기한 만료 시 세션을 실제로 끊는다.
    // v2.425: SSH 계열은 device._signal, REST 계열은 opts.signal 을 읽는다 — 양쪽에 넘겨야 어느 수집기든 실제로 끊긴다(리뷰 #4).
    try { snap = await withDeadline(DEVICE_TIMEOUT_MS, (signal) => fn({ ...full, _signal: signal }, { signal }), '수집 타임아웃'); }
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
    if (Date.now() - last >= areasEveryMs()) {
      _areasAt.set(dev.id, Date.now());
      try {
        const r = config.dataSource === 'mock'
          ? { summary: [{ area: 'cluster', ok: 3, failed: 0 }, { area: 'node', ok: 1, failed: 0 }], endpoints: 4 }
          // 시한이 끊어도 collectAreasOnce 는 던지지 않고 모은 결과를 저장·반환한다(stopped:'deadline').
          : await withDeadline(AREAS_TIMEOUT_MS, (signal) => collectAreasOnce(full, { signal }), '영역 수집 타임아웃');
        snap.extra = { ...snap.extra, areas: r.summary, areasAt: Date.now(), areasEndpoints: r.endpoints,
          ...(r.stopped ? { areasStopped: r.stopped, areasNotTried: r.notTried ?? 0 } : {}) };
        putSnapshot(snap); // 요약 갱신분 재저장(push 가 최신 요약을 실어가게)
      } catch (e) { snap.extra = { ...snap.extra, areasError: e.message }; putSnapshot(snap); }
    }
  }
  // ── v2.528 인증 실패 처리 ──────────────────────────────────────────────────
  // 401/403 은 재시도해도 결과가 같고 **계정만 잠근다**. 그 장비의 주기 수집을 멈추고,
  // 멈췄다는 사실·사유·엣지가 실제로 쓴 자격증명 지문을 스냅샷에 실어 화면이 말하게 한다
  // (조용히 멈추면 사용자는 수집이 되는 줄 안다 — authGuard.js 규칙 1).
  if (isAuthFailure(snap)) {
    const rec = markAuthStopped(dev.id, full, snap.error || '인증 실패');
    const fp = credFingerprintParts(full.username, full.password);
    snap.extra = {
      ...(snap.extra || {}),
      authStopped: { since: rec.since, attempts: rec.attempts, reason: rec.reason },
      // ⚠ 평문이 아니다 — 계정명·길이·비복원 해시뿐(credFingerprint.js 규칙 1).
      //   중앙 등록값과 눈으로 대조해 '배포가 상했나' vs '장비 비밀번호가 다른가' 를 가른다.
      credFp: { user: fp.user, len: fp.len, hash: fp.hash, space: fp.space, empty: fp.empty, userSpace: fp.userSpace },
      // 이 지문을 만든 주체(중앙인지 어느 엣지인지) — 위임 장비는 엣지 값이어야 한다.
      credFpSource: config.agent.centralUrl ? (config.agent.name || 'edge') : 'central',
    };
    putSnapshot(snap);
  } else if (snap.ok) {
    clearAuthStop(dev.id);      // 다시 성공했다 — 정지 해제(다음 주기부터 정상 수집)
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
    // 병렬 3개 제한 — 수집이 몰려 장비/네트워크에 부하 주지 않게(v2.575 IMP-08: 풀은 util/pool.js).
    let authStopped = 0;
    await poolRun(devs, 3, async (d) => {
      const r = await collectOne(d, { periodic: true });
      // null = 인증 실패로 건너뛴 것(v2.528). 실패로 세면 '수집 실패 N대' 가 매 주기 늘어나
      // 새 장애처럼 보인다 — 별도로 센다.
      if (r === null) authStopped++;
      else if (r) ok++; else fail++;
    });
    _last = { at: Date.now(), collected: ok, failed: fail, authStopped };
    return { ok, fail, authStopped };
  } finally { _busy = false; }
}

/**
 * 단일 장비 즉시 수집(등록 화면 '지금 수집' · 엣지 재수집 요청).
 * v2.591 L1: 같은 장비가 이미 수집 중이면(주기 수집·다른 요청) **시작하지 않고 false** 를 돌린다 — SAN(`sanswitch/poller.js`)·
 *   PDU 와 같은 규약. 예전 주석은 '1대 한정이라 안전' 이라 적었지만 같은 어레이에 세션이 2개 열리고(Unity 는 세션당 최대 150초),
 *   늦게 끝난 옛 결과가 최신 스냅샷을 덮고, 먼저 끝난 쪽이 in-flight 를 지워 화면 '진행중' 에서 사라졌다(재현: 동시 요청 2개).
 */
export async function collectDeviceNow(id) {
  const dev = getDeviceWithSecret(id);
  if (!dev) throw new Error('장비를 찾을 수 없습니다.');
  if (_inFlight.has(dev.id)) return false;
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
  // v2.421: 결과만 포기하는 race 가 아니라 **signal 로 수집기를 실제로 끊는다**(CLAUDE.md withDeadline 규칙). 예전에는
  // 타임아웃 뒤에도 REST 수집기가 남은 요청(20여 회 × 15초)을 백그라운드에서 이어가 세션·소켓이 수 분간 남았다.
  // v2.607 TIM2607-02: 시한 단일 관문 — 예전 `Math.max(1000, timeoutMs)` 는 2^31 초과·NaN 을 그대로 넘겨 1ms 에 끊겼다.
  const effMs = deadlineMs(timeoutMs);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), effMs);
  try {
    const snap = await Promise.race([
      // `_test` 는 수집기가 '연결 테스트' 를 구분하는 표시다 — v2.525: Unity SSH 는 이때만
      // 전 명령의 원문(cliRaw)을 담는다(주기 수집에서는 실패한 명령만 — 대역폭).
      fn({ ...device, _signal: ac.signal, _test: true }, { signal: ac.signal }),
      new Promise((_, reject) => ac.signal.addEventListener('abort', () => reject(new Error(`테스트 시간 초과(${Math.round(effMs / 1000)}초) — 방화벽/포트 또는 장비 응답 지연을 확인하세요.`)), { once: true })),
    ]);
    return { ...snap, ms: Date.now() - startedAt };
  } catch (e) {
    return { ok: false, error: e.message, sections: {}, ms: Date.now() - startedAt };
  } finally { clearTimeout(timer); }
}

export function startStoragePoller() {
  if (_timer) return;
  // 조용한 mock 방지(v2.408): config.dataSource 기본값이 'mock' 이라(EDGE_MODE=all 이 아니고
  // DATA_SOURCE 미설정이면) 엣지가 설정 누락만으로 가짜 스토리지 데이터를 중앙에 push 한다.
  // 실제로 그 상태를 운영에서 발견해(PowerStore 에 'OneFS 9.4.0(mock)' 표시) 경고를 추가했다.
  if (config.dataSource === 'mock') {
    console.warn('[storage] ⚠ DATA_SOURCE=mock — 스토리지 수집이 가짜 데이터를 만듭니다.'
      + ' 실제 장비를 수집하려면 portal.env 에 DATA_SOURCE=live (또는 EDGE_MODE=all) 를 넣고 재시작하세요.');
  }
  // 중앙 노드는 자기 몫(agent '') 주기를 파일에서 바로 적용 — 엣지는 config pull 이 넣어준다.
  try { applyOwnIntervals(); } catch (e) { console.warn(`[storage] 수집 주기 설정 로드 실패(기본값 사용): ${e.message}`); }
  // 기동 15초 후 첫 수집, 이후 매 회 현재 주기로 재무장(setInterval 은 생성 시 간격에 묶여
  // 중앙 배포를 못 받는다). 재진입 가드(_busy)는 그대로 — 수동 실행과 공유한다.
  _timer = startAdaptiveTimer(pollMs, () => pollStorageOnce(), { firstDelayMs: 15_000, name: '장비 수집' });
}
export function storagePollerStatus() {
  return { ..._last, intervalMs: pollMs(), areasMs: areasEveryMs(), busy: _busy, inFlight: [..._inFlight.values()],
    intervals: runtimeIntervalSource(), intervalsCentral: centralIntervalsInfo() };
}
