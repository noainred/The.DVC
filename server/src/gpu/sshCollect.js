/**
 * SSH 기반 GPU 게스트 수집 — VMware Tools 게스트작업(VGAuthService) 대신 게스트 IP로 직접 SSH
 * 접속해 nvidia-smi를 실행하고 stdout을 읽는다.
 *
 * 배경: SSH(PAM/sshd)와 게스트작업(VGAuth)은 인증 경로가 다르다. 같은 계정/비번이라도
 *   open-vm-tools에 vgauth 없음·VGAuthService 미동작·비대화형 로그온 PAM 차단·도메인(SSSD)
 *   계정을 vgauth가 로컬로만 검증 등으로 게스트작업 인증만 실패할 수 있다. SSH가 되면 이 방식이
 *   해결책이며, ESXi 파일전송(InitiateFileTransferFromGuest)을 안 써서 회수 404/미도달도 없다.
 */

import { withSsh, withDeadline } from '../proxy/sshExec.js';
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
async function runNvsmi(sh, argStr, remainingMs = () => 60_000) {
  let stderr = '';
  for (const cmd of nvsmiCmds(argStr)) {
    // v2.583(감사 확정): 명령마다 sshExec 기본 60초를 쓰던 것을 **남은 예산**으로 줄인다(4후보 × 60초 = 4분까지 갔다).
    const left = remainingMs();
    if (left < 1_000) break;
    let res; try { res = await sh.exec(cmd, left); } catch { continue; }
    const out = (res.stdout || '').trim();
    if (out) return { out, cmd };
    if (res.stderr) stderr = res.stderr.trim() || stderr;
  }
  return { out: '', cmd: null, stderr };
}

const usableIp = (ip) => typeof ip === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)
  && !ip.startsWith('127.') && !ip.startsWith('169.254.') && ip !== '0.0.0.0';

/**
 * VM이 보고한 IP들 중 SSH 시도 가능한 IPv4(루프백/링크로컬 제외).
 * preferIp가 지정되면(사용자가 고른 고정 IP) 그 IP '하나만' 반환한다 — 다중 NIC VM에서
 * 순차 시도로 잘못된 인터페이스에 붙는 문제를 피하려는 것이므로 폴백하지 않는다.
 */
export function guestIps(vm, preferIp = '') {
  const pref = String(preferIp || '').trim();
  if (pref && usableIp(pref)) return [pref];
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
export async function collectVmGpuSsh(vm, creds, { timeoutMs = 20_000, port = 22, trace = null, preferIp = '' } = {}) {
  // v2.583(감사 확정 — v2.417 규약 위반): VM당 시한이 SSH **핸드셰이크에만** 걸리고 nvidia-smi 명령은 명령마다
  //   60초였다(IP·후보 수만큼 곱해진다). 이제 IP 한 곳당 예산(핸드셰이크 + 명령 = 시한 × 2)을 withDeadline 으로
  //   걸어 **세션을 실제로 끊는다**(signal) — 장비당 시한은 세션을 끊어야 한다(sshExec withDeadline 규약).
  const perIpBudget = Math.max(10_000, timeoutMs * 2);
  const ips = guestIps(vm, preferIp);
  if (!ips.length) { const e = new Error('게스트 IP 없음(VMware Tools가 IP 미보고) — SSH 수집 불가'); e.guestDiag = true; throw e; }
  let lastErr = '모든 IP 접속 실패';
  let connected = false;
  for (const ip of ips) {
    tlog(trace, `SSH ${creds.username}@${ip}:${port} → nvidia-smi`);
    try {
      const until = Date.now() + perIpBudget;
      const r = await withDeadline(perIpBudget, (signal) => withSsh(
        { host: ip, port, username: creds.username, password: creds.password || '', privateKey: creds.privateKey || undefined, readyTimeout: Math.max(5_000, timeoutMs), signal },
        async (sh) => runNvsmi(sh, NVSMI, () => Math.min(timeoutMs, until - Date.now())),
      ), 'SSH 수집 시간 초과');
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
    // v2.583(검증 에이전트 권고 — collectVmGpuSsh 와 같은 규약): 세션 전체에 예산을 두고 **세션을 실제로 끊는다**
    //   (v2.417 withDeadline + signal). 예전에는 nvidia-smi 후보 4개 × 60초 + hostname/uname/ver 기본 시한까지 갔다.
    const budget = Math.max(10_000, timeoutMs * 2);
    const until = Date.now() + budget;
    const left = () => Math.min(timeoutMs, until - Date.now());
    const r = await withDeadline(budget, (signal) => withSsh(
      { host, port, username: creds.username, password: creds.password || '', privateKey: creds.privateKey || undefined, readyTimeout: Math.max(5_000, timeoutMs), signal },
      async (sh) => {
        const names = await runNvsmi(sh, '--query-gpu=name --format=csv,noheader', left);
        const slot = () => Math.max(1_000, Math.min(10_000, left()));
        const hn = await sh.exec('hostname', slot()).catch(() => ({ stdout: '' }));
        // OS: Linux는 uname, Windows는 'ver'(cmd) — 되는 쪽 사용.
        const uname = await sh.exec('uname -s', slot()).catch(() => ({ stdout: '' }));
        const ver = (uname.stdout || '').trim() ? { stdout: '' } : await sh.exec('cmd /c ver', slot()).catch(() => ({ stdout: '' }));
        return { names: names.out, nvCmd: names.cmd, hostname: hn.stdout, os: (uname.stdout || ver.stdout || '') };
      },
    ), 'SSH 탐지 시간 초과');
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
export async function testVmGuestSsh(vm, creds, { timeoutMs = 20_000, port = 22, trace = null, preferIp = '' } = {}) {
  const out = { login: false, read: false, error: null, sample: null, trace: trace || [], via: 'ssh' };
  const tr = out.trace;
  try {
    const r = await collectVmGpuSsh(vm, creds, { timeoutMs, port, trace: tr, preferIp });
    out.login = true; // 접속+명령 실행 성공 = 로그인 성공
    if (r && r.utilPct != null) { out.read = true; out.sample = { gpus: r.count, utilPct: r.utilPct, utilNA: !!r.utilNA, memUsedPct: r.memUsedPct, migEnabled: r.migEnabled || 0 }; }
    else out.error = 'nvidia-smi 출력 없음';
  } catch (e) {
    out.error = e.message;
    out.login = !!e.sshConnected; // 접속은 됐으나 nvidia-smi 문제면 login=true로 구분
  }
  return out;
}
