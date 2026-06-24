/**
 * SSH 기반 GPU 게스트 수집 — VMware Tools 게스트작업(VGAuthService) 대신 게스트 IP로 직접 SSH
 * 접속해 nvidia-smi를 실행하고 stdout을 읽는다.
 *
 * 배경: SSH(PAM/sshd)와 게스트작업(VGAuth)은 인증 경로가 다르다. 같은 계정/비번이라도
 *   open-vm-tools에 vgauth 없음·VGAuthService 미동작·비대화형 로그온 PAM 차단·도메인(SSSD)
 *   계정을 vgauth가 로컬로만 검증 등으로 게스트작업 인증만 실패할 수 있다. SSH가 되면 이 방식이
 *   해결책이며, ESXi 파일전송(InitiateFileTransferFromGuest)을 안 써서 회수 404/미도달도 없다.
 */

import { withSsh } from '../proxy/sshExec.js';
import { parseNvidiaSmiCsv } from './guestops.js';

const NVSMI = '--query-gpu=utilization.gpu,utilization.memory,memory.used,memory.total,mig.mode.current --format=csv,noheader,nounits';
const tlog = (tr, msg) => { if (tr) tr.push({ t: Date.now(), msg: String(msg) }); };

const usableIp = (ip) => typeof ip === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)
  && !ip.startsWith('127.') && !ip.startsWith('169.254.') && ip !== '0.0.0.0';

/** VM이 보고한 IP들 중 SSH 시도 가능한 IPv4(루프백/링크로컬 제외). */
export function guestIps(vm) {
  return [...new Set([...(vm.ipAddresses || []), vm.ipAddress].filter(Boolean))].filter(usableIp);
}

function cleanSshErr(m) {
  m = String(m || '');
  if (/authentication methods failed|auth.*fail|password|publickey|permission denied/i.test(m)) return 'SSH 인증 실패(계정/비번 또는 비밀번호 로그인 비활성)';
  if (/ECONNREFUSED|refused/i.test(m)) return 'SSH 연결 거부(sshd 미동작/포트 차단)';
  if (/ETIMEDOUT|timed out|timeout/i.test(m)) return 'SSH 타임아웃(IP 미도달/방화벽)';
  if (/EHOSTUNREACH|ENETUNREACH|unreach/i.test(m)) return 'SSH 경로 없음(망 분리)';
  return m.slice(0, 140);
}

/**
 * 게스트에 SSH로 nvidia-smi 실행 → 파싱. 여러 IP 중 하나라도 되면 성공.
 * 반환 parseNvidiaSmiCsv 결과({ count, utilPct, memUsedPct, ... }). 실패 시 throw(e.guestDiag).
 */
export async function collectVmGpuSsh(vm, creds, { timeoutMs = 20_000, port = 22, trace = null } = {}) {
  const ips = guestIps(vm);
  if (!ips.length) { const e = new Error('게스트 IP 없음(VMware Tools가 IP 미보고) — SSH 수집 불가'); e.guestDiag = true; throw e; }
  const cmd = `sh -lc 'export PATH=$PATH:/usr/bin:/usr/local/bin:/usr/local/sbin:/usr/local/nvidia/bin; nvidia-smi ${NVSMI}'`;
  let lastErr = '모든 IP 접속 실패';
  let connected = false;
  for (const ip of ips) {
    tlog(trace, `SSH ${creds.username}@${ip}:${port} → nvidia-smi`);
    try {
      const r = await withSsh(
        { host: ip, port, username: creds.username, password: creds.password || '', privateKey: creds.privateKey || undefined, readyTimeout: Math.max(5_000, timeoutMs) },
        async (sh) => sh.exec(cmd),
      );
      connected = true;
      const out = (r.stdout || '').trim();
      if (out) {
        const parsed = parseNvidiaSmiCsv(out);
        if (parsed && parsed.utilPct != null) { tlog(trace, `✓ SSH 수집 성공(${ip}) — GPU ${parsed.count}, 사용률 ${parsed.utilPct}%`); return parsed; }
        lastErr = `nvidia-smi 출력 파싱 실패: ${out.slice(0, 80)}`;
      } else {
        lastErr = ((r.stderr || '').trim().split('\n')[0]) || 'nvidia-smi 출력 없음(드라이버/PATH 확인)';
      }
      tlog(trace, `✗ ${ip}: ${lastErr}`);
    } catch (e) {
      lastErr = cleanSshErr(e.message);
      tlog(trace, `✗ ${ip}: ${lastErr}`);
    }
  }
  const e = new Error(`SSH 수집 실패: ${lastErr}`);
  e.guestDiag = true; e.sshConnected = connected;
  throw e;
}

/** SSH 로그인+읽기 테스트 — testVmGuest와 동일한 { login, read, error, sample, trace } 형태. */
export async function testVmGuestSsh(vm, creds, { timeoutMs = 20_000, port = 22, trace = null } = {}) {
  const out = { login: false, read: false, error: null, sample: null, trace: trace || [], via: 'ssh' };
  const tr = out.trace;
  try {
    const r = await collectVmGpuSsh(vm, creds, { timeoutMs, port, trace: tr });
    out.login = true; // 접속+명령 실행 성공 = 로그인 성공
    if (r && r.utilPct != null) { out.read = true; out.sample = { gpus: r.count, utilPct: r.utilPct, memUsedPct: r.memUsedPct, migEnabled: r.migEnabled || 0 }; }
    else out.error = 'nvidia-smi 출력 없음';
  } catch (e) {
    out.error = e.message;
    out.login = !!e.sshConnected; // 접속은 됐으나 nvidia-smi 문제면 login=true로 구분
  }
  return out;
}
