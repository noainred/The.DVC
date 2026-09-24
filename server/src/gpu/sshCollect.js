/**
 * SSH 기반 GPU 게스트 수집 — VMware Tools 게스트작업(VGAuthService) 대신 게스트 IP로 직접 SSH
 * 접속해 nvidia-smi를 실행하고 stdout을 읽는다.
 *
 * 배경: SSH(PAM/sshd)와 게스트작업(VGAuth)은 인증 경로가 다르다. 같은 계정/비번이라도
 *   open-vm-tools에 vgauth 없음·VGAuthService 미동작·비대화형 로그온 PAM 차단·도메인(SSSD)
 *   계정을 vgauth가 로컬로만 검증 등으로 게스트작업 인증만 실패할 수 있다. SSH가 되면 이 방식이
 *   해결책이며, ESXi 파일전송(InitiateFileTransferFromGuest)을 안 써서 회수 404/미도달도 없다.
 */

import { withSsh, withDeadline, isSshAuthError } from '../proxy/sshExec.js';
import { parseNvidiaSmiCsv, gpuLostError } from './guestops.js';
import { createAuthGuard } from '../util/authGuard.js';

/**
 * GPU 게스트·물리 서버 주기 수집의 **인증 실패 정지**(v2.590 — 감사 F2, server/CLAUDE.md v2.541 '아직 가드가
 * 없는 주기 SSH 수집기' 의 `gpu/sshCollect.js`). 게스트 폴러(`poller.js`, 기본 60초)와 물리 폴러
 * (`physicalPoller.js`)가 함께 쓴다 — 두 폴러가 import 하는 공통 모듈이라 여기 둔다(새 모듈을 만들지 않는다).
 * id 이름공간을 나눈다: 게스트 `vm|<vcId>|<vmId>` · 물리 `phys|<serverId>` — 섞으면 엉뚱한 대상이 멈춘다.
 *
 * ⚠ 게스트 VM 은 **VM 단위**로 멈춘다. 법인 공용 계정(`resolveVmCreds` 의 vc/vc-win)이라도 게스트마다 로컬
 *   계정이 따로일 수 있어(한 VM 만 비밀번호가 다른 경우) 계정 단위로 멈추면 멀쩡한 VM 까지 죽는다. 대가로
 *   **첫 실패 주기에는 VM 마다 1회씩** 실패가 난다(도메인 계정이면 그 합이 잠금 임계에 닿을 수 있다 — 정직 기록).
 *   그 뒤로는 VM 마다 0회다. 예전에는 1분마다 VM 수 × 방식 수(auto 는 2)였다.
 */
export const gpuAuthGuard = createAuthGuard({ file: 'gpu-auth-stops.json' });
/**
 * **계정 단위** 정지 id(v2.591 — 감사 F2). 게스트를 **많이 도는** 조사(OS 판별 스캐너·게스트 조사 공용 계정)가
 * 한 실행에서 같은 계정의 연속 거부로 회로 차단기를 끊으면 이 기록을 남긴다. VM 단위(`vm|…`)만 두면 다음 주기가
 * **아직 멈추지 않은 다른 VM 3대**로 다시 시도해 주기마다 3회씩 실패 로그온이 쌓인다(5분 주기면 30분에 18회 —
 * AD 잠금 임계를 넘는다). 계정·비밀번호를 고치면 credHash 가 달라져 자동 재개하고, 그 계정으로 한 번 통하면 푼다.
 * ⚠ GPU 폴러는 이 기록을 보지 않는다(VM 마다 로컬 계정일 수 있어 VM 단위 — 위 머리말). 차단기가 끊은 계정만 대상이다.
 */
export const guestAccountStopDev = (vcId, creds) => ({ id: `acct|${vcId}|${String(creds?.username || '')}`, username: creds?.username, password: creds?.password });

/** 정지 기록 → 화면·API 용(해시 제외). */
export const gpuStopView = (rec) => (rec ? { since: rec.since, at: rec.at, attempts: rec.attempts, reason: rec.reason } : null);
/** 게스트 작업(VMware Tools) 또는 SSH 의 **자격증명 거부**인가. */
export function isGpuAuthError(err) {
  if (!err) return false;
  if (err.authFailed === true) return true;
  // 게스트 작업 fault(InvalidGuestLogin)는 guestops.cleanGuestError 가 '게스트 로그인 실패' 로 요약한다.
  return /InvalidGuestLogin|게스트 로그인 실패/.test(String(err.message || err));
}

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
        // v2.601(RECENT2601-04): 전 GPU 오류면 '파싱 실패' 가 아니라 'GPU 응답 없음' 이다 — 다른 IP 도 같은 게스트라 그대로 던진다.
        const lost = gpuLostError(parsed);
        if (lost) { lost.sshConnected = true; throw lost; }
        if (parsed && parsed.utilPct != null) { tlog(trace, `✓ SSH 수집 성공(${ip}) — GPU ${parsed.count}, 사용률 ${parsed.utilNA ? 'N/A(MIG 모드)' : parsed.utilPct + '%'}`); return parsed; }
        lastErr = `nvidia-smi 출력 파싱 실패: ${out.slice(0, 80)}`;
      } else {
        lastErr = (r.stderr || '').split('\n')[0] || 'nvidia-smi 출력 없음(드라이버 미설치 또는 nvidia-smi 경로 없음 — Windows는 nvidia-smi.exe 설치/PATH 확인)';
      }
      tlog(trace, `✗ ${ip}: ${lastErr}`);
    } catch (e) {
      if (e.gpuLost) throw e; // 접속·명령은 됐다 — 원인은 GPU 쪽(SSH 문구로 다듬지 않는다)
      lastErr = cleanSshErr(e.message);
      tlog(trace, `✗ ${ip}: ${lastErr}`);
      // v2.590(감사 F2): 자격증명 거부면 **다른 IP 를 더 시도하지 않는다** — 같은 게스트의 같은 계정이라 결과가
      // 같고, IP 수만큼 실패 로그인이 곱해진다(계정 잠금 경로). 호출자가 `authFailed` 로 주기 수집을 멈춘다.
      if (isSshAuthError(e)) {
        const err = new Error(`SSH 수집 실패: ${lastErr}`);
        err.guestDiag = true; err.sshConnected = false; err.authFailed = true;
        throw err;
      }
    }
  }
  const e = new Error(`SSH 수집 실패: ${lastErr}`);
  e.guestDiag = true; e.sshConnected = connected;
  throw e;
}

/**
 * v2.601(감사 COL-2601-01): `nvidia-smi --query-gpu=name,uuid --format=csv,noheader` 출력에서 GPU 모델명만 뽑는다.
 * 줄 끝이 `GPU-<uuid>` 인 줄만 GPU 다 — 'No devices were found'·'NVIDIA-SMI has failed …' 같은 오류 문장은 모델이 아니다.
 * 모델로 세지 않은 줄이 있으면 첫 줄을 note 로 돌려준다(조용히 버리지 않는다).
 */
export function parseGpuNameLines(text) {
  const models = [];
  let note = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(.+?),\s*(GPU-[0-9A-Fa-f-]{8,})\s*$/.exec(line);
    if (m && m[1].trim()) models.push(m[1].trim());
    else if (!note) note = line.slice(0, 160);
  }
  return { models, note };
}

/**
 * 물리 서버 자동 감지 — SSH 접속해 GPU 모델명·호스트명·OS를 한 번에 읽어 자동 등록에 사용.
 * 반환 { reachable, hostname, os, gpuModels:[name…], error }.
 */
/**
 * 탐지 OS 표기(순수, v2.603 감사 COL-2603-06). uname·ver 출력 첫 줄이 있으면 그것이고, 둘 다 비었는데
 * Windows 절대경로 nvidia-smi(.exe)로 GPU 를 찾았으면 'Windows' 로 보정한다. 예전에는 보정 줄 **바로 다음 줄**이
 * out.os 를 무조건 다시 대입해 보정이 도달 불가였다.
 */
export function physicalOsOf(nvCmd, osRaw) {
  const first = String(osRaw || '').trim().split(/\r?\n/).filter(Boolean)[0] || '';
  if (first) return first;
  return /nvidia-smi\.exe/i.test(String(nvCmd || '')) ? 'Windows' : '';
}

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
        // v2.601(감사 COL-2601-01): uuid 를 함께 받아 'GPU-…' uuid 가 있는 줄만 GPU 로 센다 — 예전에는 stdout 첫 줄이면
        //   무엇이든 모델명이 되어 'No devices were found'(exit 6)가 GPU 모델로 등록됐다(GPU 없는 호스트 자동 등록).
        const names = await runNvsmi(sh, '--query-gpu=name,uuid --format=csv,noheader', left);
        const slot = () => Math.max(1_000, Math.min(10_000, left()));
        const hn = await sh.exec('hostname', slot()).catch(() => ({ stdout: '' }));
        // OS: Linux는 uname, Windows는 'ver'(cmd) — 되는 쪽 사용.
        const uname = await sh.exec('uname -s', slot()).catch(() => ({ stdout: '' }));
        const ver = (uname.stdout || '').trim() ? { stdout: '' } : await sh.exec('cmd /c ver', slot()).catch(() => ({ stdout: '' }));
        return { names: names.out, nvCmd: names.cmd, hostname: hn.stdout, os: (uname.stdout || ver.stdout || '') };
      },
    ), 'SSH 탐지 시간 초과');
    out.reachable = true;
    const parsedNames = parseGpuNameLines(r.names);
    out.gpuModels = parsedNames.models;
    if (parsedNames.note) out.gpuNote = parsedNames.note; // GPU 없음·nvidia-smi 오류 원문(첫 줄) — 모델로 세지 않은 이유
    out.hostname = String(r.hostname || '').trim().split(/\s+/)[0] || '';
    out.os = physicalOsOf(r.nvCmd, r.os);
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
