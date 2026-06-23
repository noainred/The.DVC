/**
 * ICMP ping 유틸 — OS의 ping CLI를 호출해 도달성/RTT를 반환한다(raw 소켓 불필요).
 * Linux/Windows 모두 지원. 모든 실패는 격리되어 { alive:false }로 떨어진다.
 */

import { execFile } from 'node:child_process';
import net from 'node:net';

const isWin = process.platform === 'win32';
let pingMissing = false; // ping CLI가 없는 환경(컨테이너 등)에서 TCP 폴백으로 전환

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
export function pingOne(ip, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const target = String(ip || '').trim();
    if (!target || !SAFE.test(target)) return resolve({ ip: target, alive: false, rttMs: null });
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

/** 여러 IP를 동시(제한) ping → [{ ip, alive, rttMs }]. */
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
