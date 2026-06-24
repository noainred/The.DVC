/**
 * 게스트 실제 OS 탐지 — VMware Tools 게스트 작업으로 게스트 OS 안의 정보를 직접 읽는다.
 * Linux: /etc/os-release(우선) → /etc/redhat-release → /etc/lsb-release + uname.
 * Windows: PowerShell(Win32_OperatingSystem.Caption/Version) → ver 폴백.
 * ESXi가 보고하는 guestOS(템플릿 기준일 수 있음)가 아니라 '실제 설치된 OS'를 확인한다.
 */

import { runGuestScript } from '../gpu/guestops.js';

const LINUX_SCRIPT = [
  'if [ -r /etc/os-release ]; then echo "===OSRELEASE==="; cat /etc/os-release; fi',
  'if [ -r /etc/redhat-release ]; then echo "===REDHAT==="; cat /etc/redhat-release; fi',
  'if [ -r /etc/lsb-release ]; then echo "===LSB==="; cat /etc/lsb-release; fi',
  'echo "===KERNEL==="; uname -sr 2>/dev/null',
].join('\n');

// cmd.exe /c 로 실행되는 .bat. PowerShell로 OS 캡션/버전 출력, 실패 시 ver.
const WIN_SCRIPT = [
  '@echo off',
  'powershell -NoProfile -ExecutionPolicy Bypass -Command "$o=Get-CimInstance Win32_OperatingSystem; Write-Output (\'CAPTION=\'+$o.Caption); Write-Output (\'VERSION=\'+$o.Version); Write-Output (\'BUILD=\'+$o.BuildNumber)" 2>nul',
  'if errorlevel 1 ver',
].join('\r\n');

const kv = (text, key) => {
  const m = new RegExp(`^${key}=\\"?([^\\"\\r\\n]+)\\"?`, 'mi').exec(text);
  return m ? m[1].trim() : '';
};

/** 실제 OS 분류(계열) — Rocky/Alma/Oracle/RHEL/CentOS/Ubuntu/Debian/SUSE/Windows 구분. */
export function classifyOs(name = '') {
  const s = String(name).toLowerCase();
  if (s.includes('windows')) return 'Windows';
  if (s.includes('rocky')) return 'Rocky';
  if (s.includes('alma')) return 'AlmaLinux';
  if (s.includes('oracle')) return 'Oracle';
  if (s.includes('red hat') || s.includes('rhel') || /\brhel\b/.test(s)) return 'RHEL';
  if (s.includes('centos')) return 'CentOS';
  if (s.includes('ubuntu')) return 'Ubuntu';
  if (s.includes('debian')) return 'Debian';
  if (s.includes('suse') || s.includes('sles')) return 'SUSE';
  if (s.includes('amazon')) return 'AmazonLinux';
  if (s.includes('fedora')) return 'Fedora';
  return 'Other';
}

const majorOf = (ver = '') => (String(ver).match(/\d+/) || [''])[0];

function parseLinux(stdout) {
  const osr = /===OSRELEASE===([\s\S]*?)(?:===|$)/.exec(stdout)?.[1] || '';
  const rh = (/===REDHAT===([\s\S]*?)(?:===|$)/.exec(stdout)?.[1] || '').trim();
  const lsb = /===LSB===([\s\S]*?)(?:===|$)/.exec(stdout)?.[1] || '';
  const kernel = (/===KERNEL===([\s\S]*?)$/.exec(stdout)?.[1] || '').trim();
  let os = kv(osr, 'PRETTY_NAME') || rh || kv(lsb, 'DISTRIB_DESCRIPTION') || '';
  let version = kv(osr, 'VERSION_ID') || kv(lsb, 'DISTRIB_RELEASE') || (rh.match(/\d+(\.\d+)?/) || [''])[0];
  const osId = (kv(osr, 'ID') || classifyOs(os)).toLowerCase();
  if (!os) return null;
  return { os, osId, osVersion: version, family: classifyOs(os), kernel, raw: (osr || rh || lsb).trim().slice(0, 800) };
}

function parseWindows(stdout) {
  const caption = kv(stdout, 'CAPTION');
  const version = kv(stdout, 'VERSION');
  if (caption) return { os: caption.trim(), osId: 'windows', osVersion: version || '', family: 'Windows', kernel: kv(stdout, 'BUILD'), raw: stdout.trim().slice(0, 400) };
  const ver = /Microsoft Windows \[Version ([^\]]+)\]/i.exec(stdout) || /Windows \[?Version ([^\]\r\n]+)/i.exec(stdout);
  if (ver) return { os: `Windows (build ${ver[1]})`, osId: 'windows', osVersion: ver[1], family: 'Windows', kernel: '', raw: stdout.trim().slice(0, 400) };
  return null;
}

/** 한 VM의 실제 OS 탐지. 반환 { os, osId, osVersion, family, kernel, raw } 또는 throw. */
export async function detectGuestOs(c, vmMoref, creds, { isWindows = false, dlHosts = [], timeoutMs = 25_000 } = {}) {
  const r = await runGuestScript(c, vmMoref, creds, isWindows ? WIN_SCRIPT : LINUX_SCRIPT, { isWindows, dlHosts, timeoutMs });
  const out = (r.stdout || '').trim();
  const parsed = isWindows ? parseWindows(out) : parseLinux(out);
  if (!parsed || !parsed.os) throw new Error(`OS 정보 파싱 실패${r.stderr ? `: ${r.stderr.slice(0, 80)}` : '(빈 출력)'}`);
  return parsed;
}

export { majorOf };
