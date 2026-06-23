/**
 * 게스트 OS 로그인 실패 조사 — VMware Tools(게스트 작업)로 게스트 안에서 인증 로그를 읽어
 * 실패 로그인을 추출한다. Linux: sshd "Failed password/Invalid user"(journalctl/secure),
 * Windows: 보안 이벤트 4625(PowerShell). root/Administrator 게스트 권한 권장.
 */

import { runGuestScript } from '../gpu/guestops.js';

const LINUX_SCRIPT = (days, n) =>
  `( journalctl _COMM=sshd -o short-iso --since "-${days} day" 2>/dev/null; cat /var/log/secure /var/log/auth.log 2>/dev/null ) ` +
  `| grep -iE "Failed password|Invalid user|authentication failure" | tail -${n}`;

const WIN_SCRIPT = (n) =>
  '@echo off\r\npowershell -NoProfile -Command "try { Get-WinEvent -FilterHashtable @{LogName=\'Security\';Id=4625} -MaxEvents ' + n +
  ' -ErrorAction Stop | ForEach-Object { $x=[xml]$_.ToXml(); $u=($x.Event.EventData.Data | Where-Object {$_.Name -eq \'TargetUserName\'}).\'#text\'; ' +
  '$ip=($x.Event.EventData.Data | Where-Object {$_.Name -eq \'IpAddress\'}).\'#text\'; ' +
  'Write-Output (\'F|\'+$u+\'|\'+$ip+\'|\'+$_.TimeCreated.ToUniversalTime().ToString(\'o\')) } } catch { Write-Output \'NOACCESS\' }"\r\n';

/** 한 VM의 게스트 로그인 실패를 조사 → [{ user, ip, ts, reason }]. */
export async function scanGuestLoginFails(c, vmMoref, creds, { isWindows = false, days = 7, maxLines = 80, dlHosts = [] } = {}) {
  const script = isWindows ? WIN_SCRIPT(maxLines) : LINUX_SCRIPT(days, maxLines);
  const r = await runGuestScript(c, vmMoref, creds, script, { isWindows, dlHosts, timeoutMs: 25_000 });
  const fails = [];
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    if (!line.trim() || /NOACCESS/.test(line)) continue;
    if (isWindows) {
      const m = /^F\|([^|]*)\|([^|]*)\|(.*)$/.exec(line);
      if (!m) continue;
      const user = (m[1] || '').trim() || '(unknown)';
      const ip = (m[2] || '').trim().replace(/^-$/, '');
      if (user === '-' || (!user && !ip)) continue;
      fails.push({ user, ip, ts: Date.parse(m[3]) || Date.now(), reason: '보안 4625(실패 로그온)' });
    } else {
      const ip = /(?:from|rhost=)\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/i.exec(line)?.[1] || /(\d{1,3}\.){3}\d{1,3}/.exec(line)?.[0] || '';
      const user = /(?:invalid user|user|for)\s+([A-Za-z0-9._\\-]+)\s+from/i.exec(line)?.[1] || /for\s+([A-Za-z0-9._\\-]+)/i.exec(line)?.[1] || '(unknown)';
      const tsm = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/.exec(line);
      const ts = tsm ? (Date.parse(tsm[1].replace(' ', 'T')) || Date.now()) : Date.now();
      fails.push({ user, ip, ts, reason: line.slice(0, 140) });
    }
  }
  return fails;
}
