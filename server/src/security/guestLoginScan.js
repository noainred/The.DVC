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
/**
 * @param {string} line 로그 한 줄
 * @param {{tzOffsetMin?:number|null, nowMs?:number}} [opts]
 *   tzOffsetMin — 게스트의 UTC 오프셋(분, 스크립트 첫 줄 'TZ|+0900'). 오프셋이 없는 형식(syslog)을 **게스트 시각**으로
 *   해석하는 데 쓴다. 없으면 예전처럼 포탈 프로세스 로컬 시각으로 해석한다.
 * @returns {number|null}
 */
export function parseLogTs(line, { tzOffsetMin = null, nowMs = Date.now() } = {}) {
  const off = Number.isFinite(tzOffsetMin) ? tzOffsetMin : null;
  // 타임존 오프셋(+0200, +02:00, Z)까지 캡처 — journalctl -o short-iso는 오프셋을 붙이는데,
  // 오프셋을 잘라내면 원격 게스트(폴란드·미국동부)의 시각이 포탈 로컬(한국)로 해석돼 최대
  // ±13시간 어긋나 브루트포스 창(10분) 판정이 통째로 빗나간다.
  const iso = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:?\d{2}|Z)?)/.exec(line);
  if (iso) {
    let s = iso[1].replace(' ', 'T');
    // v2.621(감사 DATA-01 — 재현): '+0900' 은 **5글자**다. 예전 `s.slice(0, -4)` 는 '+' 를 남겨 '…++09:00' 이 되고
    //   Date.parse 가 NaN → 호출부가 ts=지금 으로 적재했다(매 조사마다 같은 실패가 새 ts 로 다시 쌓여 며칠 전 실패가
    //   '브루트포스 의심' 이 됐다). 형제 loganalysis/parse.js 와 같은 치환으로 바꾼다('+09:00'·'Z' 는 그대로 통과).
    s = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    // 오프셋이 없는 ISO 는 게스트 오프셋을 알면 그것으로 해석한다(프로세스 TZ 에 기대지 않게).
    if (off != null && !/(?:[+-]\d{2}:\d{2}|Z)$/.test(s)) s += offsetText(off);
    const t = Date.parse(s);
    if (Number.isFinite(t)) return t;
  }
  const sl = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(line);
  if (sl && MONTHS[sl[1]] != null) {
    const mon = MONTHS[sl[1]]; const day = Number(sl[2]); const hh = Number(sl[3]); const mi = Number(sl[4]); const ss = Number(sl[5]);
    if (off != null) {
      // v2.621(감사 DATA-01): 게스트 오프셋을 알면 게스트 벽시계 → UTC 로 환산한다(포탈 프로세스 TZ 와 무관 — 결정적).
      const year = new Date(nowMs + off * 60_000).getUTCFullYear();
      let t = Date.UTC(year, mon, day, hh, mi, ss) - off * 60_000;
      if (t - nowMs > 86_400_000) t = Date.UTC(year - 1, mon, day, hh, mi, ss) - off * 60_000; // 미래면 작년(연말→연초 롤오버)
      return t;
    }
    const now = new Date(nowMs);
    const d = new Date(now.getFullYear(), mon, day, hh, mi, ss);
    if (d.getTime() - now.getTime() > 86_400_000) d.setFullYear(now.getFullYear() - 1); // 미래면 작년(연말→연초 롤오버)
    return d.getTime();
  }
  return null;
}

const offsetText = (min) => { const a = Math.abs(min); return `${min < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`; };

/** 'TZ|+0900' → 540(분). 모양이 다르면 null(추측하지 않는다). */
export function parseTzLine(line) {
  const m = /^TZ\|([+-])(\d{2})(\d{2})\s*$/.exec(String(line || '').trim());
  if (!m) return null;
  const v = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -v : v;
}

/*
 * v2.621(감사 DATA-01 부수): 예전 스크립트는 journalctl 과 /var/log/secure·auth.log 를 **둘 다** 읽었다. rsyslog 가 저널을
 *   secure 로 옮겨 적는 배포판(Rocky 9)에서는 같은 사건이 두 번 — 게스트 TZ ≠ 포탈 TZ 면 서로 다른 시각으로 — 적재됐다.
 *   이제 저널에서 한 줄이라도 나오면 저널만, 아니면(저널 없음·권한 없음) 파일만 읽는다. 첫 줄은 게스트 오프셋(date +%z)이다 —
 *   파일(syslog) 형식에는 연도·TZ 가 없어 그것으로 게스트 시각을 해석한다. 첫 줄은 tail 밖이라 잘리지 않는다.
 */
const LINUX_PATTERN = 'Failed password|Invalid user|authentication failure';
export const LINUX_SCRIPT = (days, n) =>
  `echo "TZ|$(date +%z 2>/dev/null)"\n` +
  `J=$(journalctl _COMM=sshd -o short-iso --since "-${days} day" 2>/dev/null | grep -iE "${LINUX_PATTERN}")\n` +
  `if [ -n "$J" ]; then printf '%s\\n' "$J"; else cat /var/log/secure /var/log/auth.log 2>/dev/null | grep -iE "${LINUX_PATTERN}"; fi | tail -${n}\n`;

/** Linux 조사 출력 → 실패 목록(순수 — 테스트가 직접 부른다). */
export function parseLinuxFailOutput(stdout, { nowMs = Date.now() } = {}) {
  const fails = [];
  let tzOffsetMin = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim() || /NOACCESS/.test(line)) continue;
    if (line.startsWith('TZ|')) { tzOffsetMin = parseTzLine(line); continue; }
    const ip = /(?:from|rhost=)\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/i.exec(line)?.[1] || /(\d{1,3}\.){3}\d{1,3}/.exec(line)?.[0] || '';
    const user = /(?:invalid user|user|for)\s+([A-Za-z0-9._\\-]+)\s+from/i.exec(line)?.[1] || /for\s+([A-Za-z0-9._\\-]+)/i.exec(line)?.[1] || '(unknown)';
    const ts = parseLogTs(line, { tzOffsetMin, nowMs }) ?? nowMs;
    fails.push({ user, ip, ts, reason: line.slice(0, 140) });
  }
  return fails;
}

const WIN_SCRIPT = (n) =>
  '@echo off\r\npowershell -NoProfile -Command "try { Get-WinEvent -FilterHashtable @{LogName=\'Security\';Id=4625} -MaxEvents ' + n +
  ' -ErrorAction Stop | ForEach-Object { $x=[xml]$_.ToXml(); $u=($x.Event.EventData.Data | Where-Object {$_.Name -eq \'TargetUserName\'}).\'#text\'; ' +
  '$ip=($x.Event.EventData.Data | Where-Object {$_.Name -eq \'IpAddress\'}).\'#text\'; ' +
  'Write-Output (\'F|\'+$u+\'|\'+$ip+\'|\'+$_.TimeCreated.ToUniversalTime().ToString(\'o\')) } } catch { Write-Output \'NOACCESS\' }"\r\n';

export const LOGIN_SCAN_OUT_MAX = 32_000;

/** 한 VM의 게스트 로그인 실패를 조사 → [{ user, ip, ts, reason }]. */
export async function scanGuestLoginFails(c, vmMoref, creds, { isWindows = false, days = 7, maxLines = 80, dlHosts = [] } = {}) {
  const script = isWindows ? WIN_SCRIPT(maxLines) : LINUX_SCRIPT(days, maxLines);
  // v2.621: 출력 상한을 넓힌다 — 기본 2000자면 tail 80줄 중 오래된 약 13줄만 남아 **최신 실패가 버려졌다**(Linux).
  //   80줄 × 줄당 최대 약 400자 = 32KB. 그래도 잘리면 로그로 밝힌다.
  const r = await runGuestScript(c, vmMoref, creds, script, { isWindows, dlHosts, timeoutMs: 25_000, outMax: LOGIN_SCAN_OUT_MAX });
  if (r.stdoutTruncated) console.warn(`[guestLoginScan] ${vmMoref}: 조사 출력이 ${LOGIN_SCAN_OUT_MAX}자를 넘어 잘렸습니다 — 뒤쪽(최신) 실패 일부가 빠졌을 수 있습니다.`);
  if (!isWindows) return parseLinuxFailOutput(r.stdout || '');   // v2.621(감사 DATA-01): 파싱은 순수 함수 하나
  const fails = [];
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    if (!line.trim() || /NOACCESS/.test(line)) continue;
    const m = /^F\|([^|]*)\|([^|]*)\|(.*)$/.exec(line);
    if (!m) continue;
    const user = (m[1] || '').trim() || '(unknown)';
    const ip = (m[2] || '').trim().replace(/^-$/, '');
    if (user === '-' || (!user && !ip)) continue;
    fails.push({ user, ip, ts: Date.parse(m[3]) || Date.now(), reason: '보안 4625(실패 로그온)' });
  }
  return fails;
}
