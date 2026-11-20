/**
 * mock/demo/bmLogs.js — 7a단계 로그 분석 데모(DATA_SOURCE=mock — 화면 판독용 · **값 · IP · 계정 · 메시지는 전부 가상**).
 *
 * 로그 읽기 명령(bmusage/logs/command.js)의 **출력과 같은 꼴**(구획 표지 · J|/Q|/K|/S|/A| 접두 · journald 는 JSON 한 줄 = 한 항목 · 메타 줄)을 합성해 돌려준다 —
 *   폴러가 실제 파서 · 분류 · 쓰기(같은 함수)에 넣는다. 첫 호출(읽기 위치 없음)은 지난 24시간을, 그 뒤는 직전 읽기부터 지금까지를 만든다.
 *   IP 는 문서용 예시 대역(203.0.113.0/24 · 198.51.100.0/24 — RFC 5737)과 사설 대역만 쓴다(설계 §17 정직 기록).
 * 시나리오는 키 해시로 고른다(몇 대는 같은 시간대 NVMe 시한 — ‘공통 원인 후보’ · 한 대는 /var/log/secure 권한 없음(journald 보안으로 셈) ·
 *   한 대는 비 root 기본 구성(secure · audit · journald 모두 권한 없음 — 보안 합계 ‘—’) · 한 대는 잘림).
 */
import { demoHash } from './flags.js';
import { LOG_SECTIONS } from '../../bmusage/logs/command.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const pad = (n, w = 2) => String(n).padStart(w, '0');
/** journald `-o json` 한 줄(커서 · 단조 시각 · boot_id 는 명령이 내보내기 전에 뺀다 — command.js). */
function jsonLine(ts, proc, msg, prio) {
  const m = /^([\w.-]{1,64})(?:\[(\d{1,10})\])?$/.exec(proc) || [];
  return JSON.stringify({ __REALTIME_TIMESTAMP: String(ts * 1000), PRIORITY: String(prio), SYSLOG_IDENTIFIER: m[1] || proc, ...(m[2] ? { _PID: m[2] } : {}), _COMM: m[1] || proc, MESSAGE: msg });
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function syslogLocal(ts) { const d = new Date(ts); return `${MON[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
const SCEN = Object.freeze(['brute', 'nvme', 'oom', 'quiet', 'nvme', 'units', 'perm', 'edac', 'trunc']);
/** 비 root 기본 구성(모두 권한 없음)은 ‘조용한’ 서버 일부만(다른 시나리오 분포를 바꾸지 않게 — 따로 해시). */
const scenOf = (key) => { const sc = SCEN[demoHash(`logs|${key}`) % SCEN.length]; return sc === 'quiet' && demoHash(`noperm|${key}`) % 3 === 0 ? 'noperm' : sc; };

/** 한 대상 · 구간(from, to] 의 합성 줄(결정적 — 같은 키 · 같은 분이면 같은 줄). */
function linesFor(key, host, from, to) {
  const sc = scenOf(key);
  const J = []; const K = []; const S = []; const A = []; const Q = [];
  const h0 = Math.floor(from / HOUR) * HOUR;
  for (let h = h0; h <= to; h += HOUR) {
    const hr = new Date(h).getHours();
    const at = (m, s = 0) => h + m * MIN + s * 1000;
    const inWin = (ts) => ts > from && ts <= to;
    const j = (ts, proc, msg) => { if (inWin(ts)) J.push([ts, jsonLine(ts, proc, msg, 4)]); };
    // secure 와 journald 보안(JSEC)은 같은 사건의 두 기록이다(rsyslog 가 journald 에서 받아 쓴다) — 파서가 한 출처만 센다.
    const s = (ts, proc, msg) => { if (inWin(ts)) { S.push([ts, `${syslogLocal(ts)} ${host} ${proc}: ${msg}`]); Q.push([ts, jsonLine(ts, proc, msg, 6)]); } };
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
  return { sc, J, K, S, A, Q };
}

/**
 * 데모 출력 — prev(읽기 위치 행 · 없으면 첫 읽기 24시간). 커널 줄은 [초] 로(boot = 30일 전 · 키별 boot_id).
 * @returns {string} 로그 읽기 명령 출력 꼴
 */
export function demoLogStdout(target, now = Date.now(), prev = null) {
  const key = String(target?.key || '');
  const host = String(target?.name || key).replace(/[^\w.-]/g, '').slice(0, 40) || 'bm-demo';
  const from = Number(prev?.at) > 0 ? Math.max(Number(prev.at), now - 24 * HOUR) : now - 24 * HOUR;
  const { sc, J, K, S, A, Q } = linesFor(key, host, from, now);
  const up = 30 * 86_400;   // 30일 가동
  const bootAt = now - up * 1000;
  const h = demoHash(`boot|${key}`).toString(16).padStart(8, '0').slice(0, 8);
  const boot = `${h}-0000-4000-8000-${String(demoHash(key)).padStart(12, '0').slice(-12)}`;
  const sort = (a) => a.sort((x, y) => x[0] - y[0]);
  const cur = (salt) => `s=${'a'.repeat(31)}${salt};i=${(Math.floor(now / 1000)).toString(16)};b=${'b'.repeat(32)};m=1f;t=${(now * 1000).toString(16)};x=2e`;
  const out = [];
  const cap = sc === 'trunc' ? 12 : 5_000;
  const acct = sc === 'noperm' ? ['1001', ''] : ['0', ''];
  out.push('##JOURNAL', `J#uid=${acct[0]}`, `J#grp=${acct[1]}`);
  if (sc === 'noperm') out.push('J#perm=own', `J#cur=${cur('c')}`, 'J#n=0', 'J#e=0', 'J#rc=0');
  else { const js = sort(J).slice(0, cap); js.forEach(([, l]) => out.push(`J|${l}`)); out.push(`J#cur=${cur('c')}`, `J#n=${J.length}`, `J#e=${js.length}`, 'J#rc=0'); }
  out.push('##JSEC', `Q#uid=${acct[0]}`, `Q#grp=${acct[1]}`);
  if (sc === 'noperm') out.push('Q#perm=own', `Q#cur=${cur('d')}`, 'Q#n=0', 'Q#e=0', 'Q#rc=0');
  else { sort(Q).forEach(([, l]) => out.push(`Q|${l}`)); out.push(`Q#cur=${cur('d')}`, `Q#n=${Q.length}`, `Q#e=${Q.length}`, 'Q#rc=0'); }
  out.push('##DMESG');
  sort(K).forEach(([ts, m]) => out.push(`K|kern  :${/Hardware Error|soft lockup|Out of memory/.test(m) ? 'err   ' : 'warn  '}: [${((ts - bootAt) / 1000).toFixed(6).padStart(14, ' ')}] ${m}`));
  const lastK = K.length ? ((K.at(-1)[0] - bootAt) / 1000).toFixed(6) : (prev?.state?.pos?.kernel?.last || '-1');
  out.push(`K#boot=${boot}`, `K#last=${lastK}`, `K#up=${up}.00`, `K#now=${Math.floor(now / 1000)}`, `K#n=${K.length}`, `K#e=${K.length}`, ...(prev ? [] : ['K#first=0']), 'K#rc=0');
  out.push('##SECURE', 'S#svc=active');
  if (sc === 'perm' || sc === 'noperm') out.push('S#perm=file');
  else {
    const off = Number(prev?.state?.pos?.secure?.off) || 4_096;
    sort(S).forEach(([, l]) => out.push(`S|${l}`));
    out.push(`S#ino=${100_000 + (demoHash(key) % 1000)}`, `S#size=${off + S.length * 90}`, `S#mode=${prev ? 'inc' : 'first'}`, `S#n=${S.length}`, `S#e=${S.length}`, `S#off=${off + S.length * 90}`);
  }
  out.push('##AUDIT', `A#svc=${sc === 'edac' ? 'active' : 'inactive'}`);
  if (sc === 'edac') { const off = Number(prev?.state?.pos?.audit?.off) || 2_048; A.forEach(([, l]) => out.push(`A|${l}`)); out.push('A#ino=7001', `A#size=${off + A.length * 200}`, `A#mode=${prev ? 'inc' : 'first'}`, `A#n=${A.length}`, `A#e=${A.length}`, `A#off=${off + A.length * 200}`); }
  else out.push('A#perm=dir');
  out.push('##APPLOG', 'G#absent', 'F#absent', `##${LOG_SECTIONS.at(-1)}`);
  return out.join('\n');
}
