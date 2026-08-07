/**
 * ICMP ping 유틸 — OS의 ping CLI를 호출해 도달성/RTT를 반환한다(raw 소켓 불필요).
 * Linux/Windows 모두 지원. 모든 실패는 격리되어 { alive:false }로 떨어진다.
 */

import { execFile } from 'node:child_process';
import net from 'node:net';

const isWin = process.platform === 'win32';
let pingMissing = false; // ping CLI가 없는 환경(컨테이너 등)에서 TCP 폴백으로 전환
let pingAttempts = 0;    // 시도 횟수 — 0회면 아직 '알 수 없음'이다(아래 pingProbeMode 참고)

// IP/호스트 형식 화이트리스트(명령 인젝션 방지). 실패 시 ping 건너뜀.
const SAFE = /^[a-zA-Z0-9._:-]+$/;

// ping CLI가 없을 때의 폴백: 흔한 관리 포트 TCP 연결로 도달성 추정.
const FALLBACK_PORTS = [445, 3389, 22, 80, 443, 135];
function tcpReachable(host, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (alive, rttMs) => { if (!done) { done = true; resolve({ alive, rttMs }); } };
    const start = Date.now();
    let pending = FALLBACK_PORTS.length;
    for (const port of FALLBACK_PORTS) {
      const sock = net.connect({ host, port });
      const give = () => { sock.destroy(); if (--pending === 0) finish(false, null); };
      sock.setTimeout(timeoutMs);
      sock.once('connect', () => { sock.destroy(); finish(true, Date.now() - start); });
      sock.once('timeout', give);
      sock.once('error', give); // 연결 거부(RST)도 호스트는 살아있다는 뜻이지만, 보수적으로 무응답 처리
    }
  });
}

/** 단일 IP ping → { ip, alive, rttMs }. ping CLI 없으면 TCP 폴백. */
/**
 * 이 프로세스가 ping 을 어떤 방식으로 판정하는지 — `'icmp' | 'tcp-fallback' | 'unknown'`.
 *
 * `pingMissing` 은 **ENOENT 를 한 번 겪은 뒤에만** true 가 된다. 따라서 아직 ping 을 한 번도
 * 실행하지 않은 프로세스에서 이 값을 그대로 믿으면 "ICMP 정상"이라고 잘못 보고한다.
 * 그래서 시도 횟수를 함께 보고 0회면 `'unknown'` 을 돌려준다 — 엣지 위임에서 중앙이
 * '이 엣지의 ping 은 실제로는 TCP 연결 판정'이라는 사실을 알아야 하기 때문이다
 * (TCP 폴백은 방화벽 정책이 다르면 결과 의미가 달라진다).
 */
export function pingProbeMode() {
  if (!pingAttempts) return 'unknown';
  return pingMissing ? 'tcp-fallback' : 'icmp';
}
export function pingProbeStats() { return { mode: pingProbeMode(), attempts: pingAttempts, cliMissing: pingMissing }; }

export function pingOne(ip, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const target = String(ip || '').trim();
    if (!target || !SAFE.test(target)) return resolve({ ip: target, alive: false, rttMs: null });
    pingAttempts += 1;
    if (pingMissing) return tcpReachable(target, timeoutMs).then((r) => resolve({ ip: target, ...r }));
    const sec = Math.max(1, Math.round(timeoutMs / 1000));
    const args = isWin
      ? ['-n', '1', '-w', String(timeoutMs), target]
      : ['-c', '1', '-W', String(sec), target];
    execFile('ping', args, { timeout: timeoutMs + 1500, windowsHide: true }, (err, stdout) => {
      if (err && err.code === 'ENOENT') { // ping 미설치 → 이후 TCP 폴백
        pingMissing = true;
        return tcpReachable(target, timeoutMs).then((r) => resolve({ ip: target, ...r }));
      }
      const out = String(stdout || '');
      // 성공 판정: 에러코드 0 + "ttl=" 포함(일부 OS는 손실에도 0 반환하므로 ttl 확인).
      const alive = !err && /ttl[=:]/i.test(out);
      const m = /time[=<]\s*([\d.]+)\s*ms/i.exec(out);
      resolve({ ip: target, alive, rttMs: alive && m ? Number(m[1]) : null });
    });
  });
}

/** 단일 호스트:포트 TCP 연결 프로브 → { alive, rttMs }. 제어플레인(443 등) 도달성/지연 측정용. */
export function tcpConnect(host, port = 443, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const h = String(host || '').trim();
    if (!h || !SAFE.test(h)) return resolve({ alive: false, rttMs: null });
    const start = Date.now();
    let done = false;
    const fin = (alive) => { if (!done) { done = true; resolve({ alive, rttMs: alive ? Date.now() - start : null }); } };
    const sock = net.connect({ host: h, port });
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => { sock.destroy(); fin(true); });
    sock.once('timeout', () => { sock.destroy(); fin(false); });
    sock.once('error', () => { sock.destroy(); fin(false); });
  });
}

/** 여러 {host,port,...meta} 동시(제한) TCP 프로브. 반환은 입력 + {alive,rttMs}. */
export async function tcpProbeMany(targets = [], { timeoutMs = 2500, concurrency = 10 } = {}) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < targets.length) { const t = targets[i++]; const r = await tcpConnect(t.host, t.port || 443, timeoutMs); out.push({ ...t, ...r }); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return out;
}

export async function pingMany(ips = [], { timeoutMs = 1500, concurrency = 8 } = {}) {
  const list = [...new Set(ips.map((s) => String(s).trim()).filter(Boolean))];
  const out = [];
  let i = 0;
  async function worker() {
    while (i < list.length) { const ip = list[i++]; out.push(await pingOne(ip, { timeoutMs })); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return out;
}
