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

// nvidia-smi 실행 후보(OS·PATH 무관). 순서: 직접(Win/Linux PATH) → Linux 비대화형 PATH 보강
// → Windows 절대경로. 하나라도 출력이 있으면 성공.
function nvsmiCmds(argStr) {
  return [
    `nvidia-smi ${argStr}`,
    `sh -lc 'export PATH=$PATH:/usr/bin:/usr/local/bin:/usr/local/sbin:/usr/local/nvidia/bin; nvidia-smi ${argStr}'`,
    `"C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe" ${argStr}`,
    `"C:\\Windows\\System32\\nvidia-smi.exe" ${argStr}`,
  ];
}
async function runNvsmi(sh, argStr) {
  let stderr = '';
  for (const cmd of nvsmiCmds(argStr)) {
    let res; try { res = await sh.exec(cmd); } catch { continue; }
    const out = (res.stdout || '').trim();
    if (out) return { out, cmd };
    if (res.stderr) stderr = res.stderr.trim() || stderr;
  }
  return { out: '', cmd: null, stderr };
}

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
  let lastErr = '모든 IP 접속 실패';
  let connected = false;
  for (const ip of ips) {
    tlog(trace, `SSH ${creds.username}@${ip}:${port} → nvidia-smi`);
    try {
      const r = await withSsh(
        { host: ip, port, username: creds.username, password: creds.password || '', privateKey: creds.privateKey || undefined, readyTimeout: Math.max(5_000, timeoutMs) },
        async (sh) => runNvsmi(sh, NVSMI),
      );
      connected = true;
      const out = (r.out || '').trim();
      if (out) {
        const parsed = parseNvidiaSmiCsv(out);
        if (parsed && parsed.utilPct != null) { tlog(trace, `✓ SSH 수집 성공(${ip}) — GPU ${parsed.count}, 사용률 ${parsed.utilNA ? 'N/A(MIG 모드)' : parsed.utilPct + '%'}`); return parsed; }
        lastErr = `nvidia-smi 출력 파싱 실패: ${out.slice(0, 80)}`;
      } else {
        lastErr = (r.stderr || '').split('\n')[0] || 'nvidia-smi 출력 없음(드라이버 미설치 또는 nvidia-smi 경로 없음 — Windows는 nvidia-smi.exe 설치/PATH 확인)';
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

/**
 * 물리 서버 자동 감지 — SSH 접속해 GPU 모델명·호스트명·OS를 한 번에 읽어 자동 등록에 사용.
 * 반환 { reachable, hostname, os, gpuModels:[name…], error }.
 */
export async function detectPhysicalGpu(host, creds, { timeoutMs = 20_000, port = 22 } = {}) {
  const out = { reachable: false, hostname: '', os: '', gpuModels: [], error: null };
  try {
    const r = await withSsh(
      { host, port, username: creds.username, password: creds.password || '', privateKey: creds.privateKey || undefined, readyTimeout: Math.max(5_000, timeoutMs) },
      async (sh) => {
        const names = await runNvsmi(sh, '--query-gpu=name --format=csv,noheader');
        const hn = await sh.exec('hostname').catch(() => ({ stdout: '' }));
        // OS: Linux는 uname, Windows는 'ver'(cmd) — 되는 쪽 사용.
        const uname = await sh.exec('uname -s').catch(() => ({ stdout: '' }));
        const ver = (uname.stdout || '').trim() ? { stdout: '' } : await sh.exec('cmd /c ver').catch(() => ({ stdout: '' }));
        return { names: names.out, nvCmd: names.cmd, hostname: hn.stdout, os: (uname.stdout || ver.stdout || '') };
      },
    );
    out.reachable = true;
    out.gpuModels = String(r.names || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // Windows 절대경로 명령으로 GPU를 찾았으면 OS를 windows로 보정.
    if (/nvidia-smi\.exe|ver/i.test(`${r.nvCmd || ''} ${r.os || ''}`)) out.os = out.os || 'Windows';
    out.hostname = String(r.hostname || '').trim().split(/\s+/)[0] || '';
    out.os = String(r.os || '').trim().split(/\r?\n/).filter(Boolean)[0] || '';
  } catch (e) { out.error = cleanSshErr(e.message); }
  return out;
}

/** SSH 로그인+읽기 테스트 — testVmGuest와 동일한 { login, read, error, sample, trace } 형태. */
export async function testVmGuestSsh(vm, creds, { timeoutMs = 20_000, port = 22, trace = null } = {}) {
  const out = { login: false, read: false, error: null, sample: null, trace: trace || [], via: 'ssh' };
  const tr = out.trace;
  try {
    const r = await collectVmGpuSsh(vm, creds, { timeoutMs, port, trace: tr });
    out.login = true; // 접속+명령 실행 성공 = 로그인 성공
    if (r && r.utilPct != null) { out.read = true; out.sample = { gpus: r.count, utilPct: r.utilPct, utilNA: !!r.utilNA, memUsedPct: r.memUsedPct, migEnabled: r.migEnabled || 0 }; }
    else out.error = 'nvidia-smi 출력 없음';
  } catch (e) {
    out.error = e.message;
    out.login = !!e.sshConnected; // 접속은 됐으나 nvidia-smi 문제면 login=true로 구분
  }
  return out;
}
