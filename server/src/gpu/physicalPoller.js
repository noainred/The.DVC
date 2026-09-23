/**
 * 물리(베어메탈) GPU 서버 폴러 — 등록된 가상화 안 한 서버에 직접 SSH로 nvidia-smi를 돌려
 * GPU 사용률을 수집한다. VM 게스트 수집과 같은 sshCollect 로직을 재사용하되, 대상은 vCenter VM이
 * 아니라 등록부의 물리 서버다. 실패는 서버별로 격리하고, 긴급중단 시 멈춘다.
 */

import { loadGpuGuestSettings } from './settings.js';
import { loadPhysical, updatePhysical } from './physicalRegistry.js';
import { collectVmGpuSsh, detectPhysicalGpu, gpuAuthGuard, gpuStopView, isGpuAuthError } from './sshCollect.js';
import { setPhysicalGpu, prunePhysicalGpu, physicalGpuCounts } from './physicalStore.js';
import { isStopped } from '../security/emergencyStop.js';
import { poolSettled } from '../util/pool.js'; // v2.579: 동시성 풀 단일 소스(util/pool.js) — 손으로 쓴 사본 제거

let timer = null;
let lastRun = null;
let running = false;

// 수집 실패 원인 분류 — UI에서 로그인/드라이버/접속/오류로 구분 표시.
function classifyErr(e) {
  const m = String(e?.message || '');
  if (e?.sshConnected) {
    if (/nvidia-smi|드라이버|파싱|출력 없음/i.test(m)) return { errorCode: 'nodriver', errorLabel: '드라이버 없음' };
    return { errorCode: 'error', errorLabel: '오류' };
  }
  if (/인증|auth|permission|비밀번호|publickey/i.test(m)) return { errorCode: 'login', errorLabel: '로그인 안됨' };
  if (/거부|refused|타임아웃|timeout|미도달|경로|unreach|ETIMEDOUT|ECONNREFUSED/i.test(m)) return { errorCode: 'unreachable', errorLabel: '접속 불가' };
  return { errorCode: 'error', errorLabel: '오류' };
}


/**
 * @param {{manual?: boolean}} [opts] manual — 관리자 '지금 수집'. v2.590(감사 F2): 인증 실패로 멈춘 서버는
 *   **주기 수집에서만** 건너뛴다(등록·수정 직후 호출은 자격증명이 바뀌었으면 credHash 로 자동 재개된다).
 */
export async function pollPhysicalOnce({ manual = false } = {}) {
  if (running) return lastRun;
  running = true;
  try {
    if (isStopped()) { lastRun = { at: Date.now(), skipped: '긴급중단' }; return lastRun; }
    const servers = loadPhysical().filter((s) => s.enabled !== false && s.host && s.username);
    const s = loadGpuGuestSettings();
    let ok = 0; let failed = 0; let authStopped = 0;
    await poolSettled(servers, Math.max(1, s.concurrency || 4), async (sv) => {
      const vm = { name: sv.name, ipAddresses: [sv.host], ipAddress: sv.host };
      const creds = { username: sv.username, password: sv.password || '' };
      const authDev = { id: `phys|${sv.id}`, username: sv.username, password: sv.password || '' };
      const stop = manual ? null : gpuAuthGuard.authStopFor(authDev);
      if (stop) {
        // 정지 사실을 결과에 싣는다 — 조용히 건너뛰면 화면이 '마지막 값' 을 지금 값처럼 보여준다.
        setPhysicalGpu(sv.id, { id: sv.id, name: sv.name, host: sv.host, vcenterId: sv.vcenterId || '', error: `인증 실패로 주기 수집 정지(${stop.attempts}회) — 비밀번호를 고치면 자동 재개합니다`, errorCode: 'login', errorLabel: '로그인 안됨', authStopped: gpuStopView(stop) });
        authStopped++;
        return;
      }
      try {
        const r = await collectVmGpuSsh(vm, creds, { timeoutMs: s.timeoutMs, port: sv.port || 22 });
        setPhysicalGpu(sv.id, {
          id: sv.id, name: sv.name, host: sv.host, vcenterId: sv.vcenterId || '',
          count: r.count, utilPct: r.utilPct, utilNA: !!r.utilNA, memUsedPct: r.memUsedPct, gpus: r.gpus || [], error: null,
        });
        // GPU 모델명이 없으면(수동 등록) 1회 감지해 등록부에 백필 → 서버 분석 GPU 찾기에 모델별 합산.
        if (!(sv.gpuModels && sv.gpuModels.length)) {
          try { const det = await detectPhysicalGpu(sv.host, creds, { timeoutMs: s.timeoutMs, port: sv.port || 22 }); if (det.gpuModels.length) updatePhysical(sv.id, { gpuModels: det.gpuModels }); } catch { /* best effort */ }
        }
        gpuAuthGuard.clearAuthStop(authDev.id);
        ok++;
      } catch (e) {
        // v2.590: 자격증명 거부면 이 서버의 주기 수집을 멈춘다(재시도해도 결과가 같고 계정만 잠근다).
        const rec = isGpuAuthError(e) ? gpuAuthGuard.markAuthStopped(authDev.id, authDev, e.message) : null;
        if (rec) console.warn(`[gpu-physical] ${sv.name || sv.host}: 인증 실패로 주기 수집 정지(${rec.attempts}회) — 비밀번호를 고치면 자동 재개합니다`);
        setPhysicalGpu(sv.id, { id: sv.id, name: sv.name, host: sv.host, vcenterId: sv.vcenterId || '', error: e.message, ...classifyErr(e), ...(rec ? { authStopped: gpuStopView(rec) } : {}) });
        failed++;
      }
    });
    prunePhysicalGpu(new Set(servers.map((x) => x.id)));
    lastRun = { at: Date.now(), servers: servers.length, ok, failed, authStopped, overlay: physicalGpuCounts() };
    return lastRun;
  } finally { running = false; }
}

export function physicalPollerStatus() {
  const { pollIntervalMs } = loadGpuGuestSettings();
  return { intervalMs: pollIntervalMs, servers: loadPhysical().length, lastRun, overlay: physicalGpuCounts() };
}

// v2.597(감사 LC2597-02 — 코드 확인): 이 함수를 부르는 곳이 없어 주기 변경이 재시작 전까지 먹지 않았는데 상태는 새 주기를
//   보고했다. 설정 저장(PUT /gpu-guest/settings)·엣지 설정 pull 적용이 부른다. 시작 전이면 아무것도 하지 않는다(start 가 무장).
export function reschedulePhysicalPoller() {
  if (!timer) return null;
  clearInterval(timer);
  const { pollIntervalMs } = loadGpuGuestSettings();
  timer = setInterval(() => pollPhysicalOnce().catch(() => {}), pollIntervalMs);
  timer.unref?.();
  return pollIntervalMs;
}

export function startPhysicalGpuPoller() {
  setTimeout(() => pollPhysicalOnce().catch((e) => console.error('[gpu-physical] 폴 실패:', e.message)), 20_000).unref?.();
  const { pollIntervalMs } = loadGpuGuestSettings();
  if (timer) clearInterval(timer);   // 이중 시작이 고아 타이머를 남기지 않게(v2.591 L9 와 같은 가드)
  timer = setInterval(() => pollPhysicalOnce().catch(() => {}), pollIntervalMs);
  timer.unref?.();
  console.log(`[gpu-physical] poller started (every ${Math.round(pollIntervalMs / 1000)}s)`);
}
