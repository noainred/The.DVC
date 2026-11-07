/**
 * mock/demo/bmLogs.js — 7a단계 로그 분석 데모(DATA_SOURCE=mock — 화면 판독용 · **값 · IP · 계정 · 메시지는 전부 가상**).
 *
 * 로그 읽기 명령(bmusage/logs/command.js)의 **출력과 같은 꼴**(구획 표지 · J|/K|/S|/A| 접두 · 메타 줄)을 합성해 돌려준다 —
 *   폴러가 실제 파서 · 분류 · 쓰기(같은 함수)에 넣는다. 첫 호출(읽기 위치 없음)은 지난 24시간을, 그 뒤는 직전 읽기부터 지금까지를 만든다.
 *   IP 는 문서용 예시 대역(203.0.113.0/24 · 198.51.100.0/24 — RFC 5737)과 사설 대역만 쓴다(설계 §17 정직 기록).
 * 시나리오는 키 해시로 고른다(몇 대는 같은 시간대 NVMe 시한 — ‘공통 원인 후보’ · 한 대는 /var/log/secure 권한 없음 · 한 대는 잘림).
 */
import { demoHash } from './flags.js';
import { LOG_SECTIONS } from '../../bmusage/logs/command.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const pad = (n, w = 2) => String(n).padStart(w, '0');
function isoLocal(ts) {
  const d = new Date(ts);
  const off = -d.getTimezoneOffset();
  const sg = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sg}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`;
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function syslogLocal(ts) { const d = new Date(ts); return `${MON[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
const SCEN = Object.freeze(['brute', 'nvme', 'oom', 'quiet', 'nvme', 'units', 'perm', 'edac', 'trunc']);

/** 한 대상 · 구간(from, to] 의 합성 줄(결정적 — 같은 키 · 같은 분이면 같은 줄). */
function linesFor(key, host, from, to) {
  const sc = SCEN[demoHash(`logs|${key}`) % SCEN.length];
  const J = []; const K = []; const S = []; const A = [];
  const h0 = Math.floor(from / HOUR) * HOUR;
  for (let h = h0; h <= to; h += HOUR) {
    const hr = new Date(h).getHours();
    const at = (m, s = 0) => h + m * MIN + s * 1000;
    const inWin = (ts) => ts > from && ts <= to;
    const j = (ts, proc, msg) => { if (inWin(ts)) J.push([ts, `${isoLocal(ts)} ${host} ${proc}: ${msg}`]); };
    const s = (ts, proc, msg) => { if (inWin(ts)) S.push([ts, `${syslogLocal(ts)} ${host} ${proc}: ${msg}`]); };
    const k = (ts, msg) => { if (inWin(ts)) K.push([ts, msg]); };
    // 모든 서버: 가끔 sudo · 성공 로그인 · 분류 안 되는 경고
    if (hr % 3 === 1) { s(at(12), 'sshd[2210]', 'Accepted publickey for kim.ops from 10.20.3.11 port 52210 ssh2: ED25519 SHA256:AbCdEf0123'); s(at(13), 'sudo[2301]', 'kim.ops : TTY=pts/0 ; PWD=/home/kim.ops ; USER=root ; COMMAND=/usr/bin/systemctl restart postgresql'); }
    if (hr % 4 === 2) j(at(20), 'NetworkManager[1022]', '<warn>  [1762402800.1234] dhcp4 (eno2): request timed out');
    if (hr === 9) s(at(2, 10), 'sshd[3311]', 'Accepted password for root from 10.20.1.5 port 44012 ssh2');
    if (sc === 'brute') {
      if (hr >= 2 && hr <= 4) for (let m = 0; m < 60; m += 7) s(at(m, 31), 'sshd[4410]', `Failed password for ${m % 2 ? 'admin' : 'root'} from 198.51.100.7 port ${40000 + m} ssh2`);
      if (hr === 3) for (let x = 0; x < 40; x += 1) s(at(10 + Math.floor(x / 8), x % 60), 'sshd[4411]', `Failed password for root from 203.0.113.45 port ${51800 + x} ssh2`);
      if (hr === 3) s(at(30), 'sshd[4412]', 'Invalid user oracle from 203.0.113.45 port 51990');
    }
    if (sc === 'nvme' && (hr === 13 || hr === 14)) for (let m = 2; m < 42; m += 6) k(at(m, 41), `nvme nvme1: I/O ${1000 + m} QID 7 timeout, completion polled`);
    if (sc === 'oom' && hr === 11) { k(at(40, 3), 'TCP: out of memory -- consider tuning tcp_mem'); k(at(41, 9), 'Out of memory: Killed process 48112 (postgres) total-vm:8123456kB, anon-rss:7654321kB, file-rss:0kB, shmem-rss:0kB'); }
    if (sc === 'oom' && hr === 3) k(at(12, 9), 'watchdog: BUG: soft lockup - CPU#21 stuck for 23s! [postgres:48112]');
    if (sc === 'units' && hr === 22) { j(at(5, 51), 'systemd[1]', "airflow-scheduler.service: Failed with result 'exit-code'."); j(at(6, 2), 'systemd[1]', 'airflow-scheduler.service: Start request repeated too quickly.'); }
    if (sc === 'units' && hr === 13) j(at(42), 'chronyd[812]', 'System clock wrong by 0.912345 seconds, adjustment started');
    if (sc === 'edac' && hr === 11) { k(at(4, 12), 'mce: [Hardware Error]: Machine check events logged'); k(at(4, 13), 'EDAC MC0: 1 CE memory read error on CPU_SrcID#0_Ha#0_Chan#2_DIMM#1 (channel:2 slot:1 page:0x3e2a1f offset:0x400 grain:32 syndrome:0x0)'); }
    if (sc === 'edac' && hr === 18 && inWin(at(20))) A.push([at(20), `type=ADD_USER msg=audit(${Math.floor(at(20) / 1000)}.200:458): pid=3311 uid=0 auid=1000 ses=3 msg='op=add-user id=1001 exe="/usr/sbin/useradd" hostname=? addr=? terminal=pts/0 res=success'`]);
    if (sc === 'trunc' && hr % 2 === 0) for (let m = 0; m < 60; m += 3) j(at(m), 'rsyslogd[1200]', `file '/var/log/app/batch.log': write error - No space left on device [v8.2102.0-${m}]`);
  }
  return { sc, J, K, S, A };
}

/**
 * 데모 출력 — prev(읽기 위치 행 · 없으면 첫 읽기 24시간). 커널 줄은 [초] 로(boot = 30일 전 · 키별 boot_id).
 * @returns {string} 로그 읽기 명령 출력 꼴
 */
export function demoLogStdout(target, now = Date.now(), prev = null) {
  const key = String(target?.key || '');
  const host = String(target?.name || key).replace(/[^\w.-]/g, '').slice(0, 40) || 'bm-demo';
  const from = Number(prev?.at) > 0 ? Math.max(Number(prev.at), now - 24 * HOUR) : now - 24 * HOUR;
  const { sc, J, K, S, A } = linesFor(key, host, from, now);
  const up = 30 * 86_400;   // 30일 가동
  const bootAt = now - up * 1000;
  const h = demoHash(`boot|${key}`).toString(16).padStart(8, '0').slice(0, 8);
  const boot = `${h}-0000-4000-8000-${String(demoHash(key)).padStart(12, '0').slice(-12)}`;
  const sort = (a) => a.sort((x, y) => x[0] - y[0]);
  const out = [];
  const cap = sc === 'trunc' ? 12 : 5_000;
  out.push('##JOURNAL');
  sort(J).slice(0, cap).forEach(([, l]) => out.push(`J|${l}`));
  out.push(`J#cur=s=${'a'.repeat(32)};i=${(Math.floor(now / 1000)).toString(16)};b=${'b'.repeat(32)};m=1f;t=${(now * 1000).toString(16)};x=2e`, `J#n=${J.length}`, 'J#rc=0');
  out.push('##DMESG');
  sort(K).forEach(([ts, m]) => out.push(`K|kern  :${/Hardware Error|soft lockup|Out of memory/.test(m) ? 'err   ' : 'warn  '}: [${((ts - bootAt) / 1000).toFixed(6).padStart(14, ' ')}] ${m}`));
  const lastK = K.length ? ((K.at(-1)[0] - bootAt) / 1000).toFixed(6) : (prev?.state?.pos?.kernel?.last || '-1');
  out.push(`K#boot=${boot}`, `K#last=${lastK}`, `K#up=${up}.00`, `K#now=${Math.floor(now / 1000)}`, `K#n=${K.length}`, 'K#rc=0');
  out.push('##SECURE');
  if (sc === 'perm') out.push('S#perm');
  else {
    const off = Number(prev?.state?.pos?.secure?.off) || 4_096;
    sort(S).forEach(([, l]) => out.push(`S|${l}`));
    out.push(`S#ino=${100_000 + (demoHash(key) % 1000)}`, `S#size=${off + S.length * 90}`, `S#mode=${prev ? 'inc' : 'first'}`, `S#n=${S.length}`, `S#off=${off + S.length * 90}`);
  }
  out.push('##AUDIT', `A#svc=${sc === 'edac' ? 'active' : 'inactive'}`);
  if (sc === 'edac') { const off = Number(prev?.state?.pos?.audit?.off) || 2_048; A.forEach(([, l]) => out.push(`A|${l}`)); out.push('A#ino=7001', `A#size=${off + A.length * 200}`, `A#mode=${prev ? 'inc' : 'first'}`, `A#n=${A.length}`, `A#off=${off + A.length * 200}`); }
  else out.push('A#perm');
  out.push('##APPLOG', 'G#absent', 'F#absent', `##${LOG_SECTIONS.at(-1)}`);
  return out.join('\n');
}
