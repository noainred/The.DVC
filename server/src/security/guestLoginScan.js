/**
 * 게스트 OS 로그인 실패 조사 — VMware Tools(게스트 작업)로 게스트 안에서 인증 로그를 읽어
 * 실패 로그인을 추출한다. Linux: sshd "Failed password/Invalid user"(journalctl/secure),
 * Windows: 보안 이벤트 4625(PowerShell). root/Administrator 게스트 권한 권장.
 */

import { runGuestScript } from '../gpu/guestops.js';

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
// 로그 라인의 타임스탬프를 안정적으로 뽑는다. ISO(journalctl -o short-iso)와 syslog('Mmm D HH:MM:SS',
// /var/log/secure·auth.log)를 모두 인식 — 이전엔 syslog 형식이 불일치해 매 조사마다 ts=Date.now()로
// 기록돼 동일 실패가 중복 적재되고 브루트포스 오탐을 유발했다. 같은 라인은 항상 같은 ts가 나오게 한다.
function parseLogTs(line) {
  // 타임존 오프셋(+0200, +02:00, Z)까지 캡처 — journalctl -o short-iso는 오프셋을 붙이는데,
  // 오프셋을 잘라내면 원격 게스트(폴란드·미국동부)의 시각이 포탈 로컬(한국)로 해석돼 최대
  // ±13시간 어긋나 브루트포스 창(10분) 판정이 통째로 빗나간다.
  const iso = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:?\d{2}|Z)?)/.exec(line);
  if (iso) {
    let s = iso[1].replace(' ', 'T');
    const m = /([+-]\d{2})(\d{2})$/.exec(s); // '+0200' → '+02:00' (Date.parse 호환)
    if (m) s = s.slice(0, -4) + `${m[1]}:${m[2]}`;
    const t = Date.parse(s);
    if (Number.isFinite(t)) return t;
  }
  const sl = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(line);
  if (sl && MONTHS[sl[1]] != null) {
    const now = new Date();
    const d = new Date(now.getFullYear(), MONTHS[sl[1]], Number(sl[2]), Number(sl[3]), Number(sl[4]), Number(sl[5]));
    if (d.getTime() - now.getTime() > 86_400_000) d.setFullYear(now.getFullYear() - 1); // 미래면 작년(연말→연초 롤오버)
    return d.getTime();
  }
  return null;
}

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
      const ts = parseLogTs(line) ?? Date.now();
      fails.push({ user, ip, ts, reason: line.slice(0, 140) });
    }
  }
  return fails;
}
