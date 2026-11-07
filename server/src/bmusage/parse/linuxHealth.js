/**
 * bmusage/parse/linuxHealth.js — 리눅스 성능 5단계(v2.929 예정)의 **점검 소모품 · 변경 이벤트** 구획(설계 PROFILES §14 ⑧·⑩ · 아트보드 Health · Compare).
 *
 * 같은 SSH 1회 명령(`collectors/osSsh.js linuxCommand`)에 구획 셋을 더한다 — `##CHRONY` · `##DMESG` · `##CHANGES`. 명령 조각은 전부 이 모듈의 **상수**다(변수 삽입 없음).
 *
 * ⚠⚠ 구획 규약(4단계 반증 R1 · 1단계 D1 — 되돌리지 말 것):
 *   · **줄 머리는 우리가 정한다** — 모든 줄에 고정 접두를 붙인다(CHRONY `c:` · DMESG `k:` · CHANGES `x:`). 장비 출력(chronyc 의 참조 이름 · dnf 의 명령줄 칸 ·
 *     /etc/cron.d 파일 이름 · crontab 사용자 이름)이 줄 머리에 오지 않는다 → ‘##MEM’ · ‘##END’ 같은 표지를 위조할 수 없다. 파서는 접두 없는 줄을 버린다.
 *   · 표지는 정확 일치 · 순서 · 재개방 금지(splitSections — LINUX_SECTIONS 에 이 순서로 넣었다).
 *   · 구획마다 줄 수(head) · 줄 폭(cut) 상한 — 바이트 산수(SECTION_BYTES_SUM < OUTPUT_MAX_BYTES < EXEC_MAX_OUTPUT)에 더한다(osSsh).
 *   · 멈출 수 있는 명령은 `timeout`(chronyc 3 · dmesg 3 · systemctl 3 · needs-restarting 8 · dnf 8) — 주기 명령 전체가 시한 하나라 한 칸이 전 구획을 잃게 하지 않는다(R8).
 *   · **실패 = missing** — 명령이 있는데 실패하면(종료 코드 ≠ 0) 값을 내지 않고 `rc=<코드>` 만 낸다 → 파서가 그 칸을 null(확인 불가). 0 을 지어내지 않는다(R7).
 *     명령이 없으면 아무것도 내지 않는다(구획은 왔는데 0줄 = absent — chrony 가 아닌 시각 동기를 쓰는 서버).
 *
 * ⚠⚠ 보관 금지(비밀 혼입 — 설계 §14 ‘설정 파일 내용은 포탈이 보관하지 않는다’):
 *   · /etc/sysctl.d · /etc/cron.d · /etc/crontab · /var/spool/cron 은 **cksum(CRC) 만** — 내용은 셸 밖으로 나오지 않는다(파일 이름 · CRC · 크기 없음).
 *   · `sysctl -a` 는 **전체 CRC 하나**(휘발성 키를 뺀 것) — 값은 나오지 않는다. 바뀐 ‘키 이름’ 은 ##SYSCTL 화이트리스트 값의 변화로만 안다(changes.js).
 *   · `dmesg` 는 **개수만**(err · warn 전체 · 최근 24시간) — 커널 메시지 원문은 awk 밖으로 나오지 않는다(원문은 진단 스냅샷 · 사람이 누를 때만).
 *   · `dnf history list` 는 rpmdb 가 최근 20분 안에 바뀐 때만 돌리고(평소 비용 0), 파서가 **ID · 날짜 · 동작 · 바뀐 수만** 꺼낸다 — 명령줄 칸은 버린다
 *     (`--setopt=proxy_password=…` 같은 비밀이 실릴 수 있다).
 *   · chronyc 의 참조 **이름**(NTP 서버 주소)은 버리고 RefID(16진 — 주소를 담을 수 있어 화면에는 싣지 않는다) · stratum · 오프셋 · 상태만.
 *
 * ⚠ 정직 기록: `chronyc -c tracking` · `needs-restarting -r` · `dnf history list` 의 출력 형식과 소요 시간은 **이 현장 Rocky 9 실장비에서 확인하지 못했다**
 *   (chrony 문서 · dnf 문서 기준 — 이 개발 컨테이너에는 셋 다 없다). 파서는 접두 · 앵커 · 행 수 상한으로 보호하고, 못 읽으면 그 칸은 확인 불가다.
 */

/** 구획 순서(linuxCommand 가 이 순서로 붙이고 splitSections 가 이 순서로만 받는다 — osSsh LINUX_SECTIONS). */
export const HEALTH_SECTIONS = Object.freeze(['CHRONY', 'DMESG', 'CHANGES']);
/** 줄 고정 접두 — 줄 머리를 우리가 정한다(반증 R1). */
export const HEALTH_PREFIX = Object.freeze({ CHRONY: 'c:', DMESG: 'k:', CHANGES: 'x:' });
/** 구획별 줄 상한(명령의 head -n 과 같은 값). CHANGES = 고정 키 13줄 + dnf 6 + sysctl.d 32 + cron.d 32 + spool 32 + 여유. */
export const HEALTH_LINE_CAP = Object.freeze({ CHRONY: 3, DMESG: 2, CHANGES: 120 });
/** 줄 최대 바이트(가정 — cut 폭 + 접두 + 개행). osSsh SECTION_BYTES_SUM 산수에 더한다. */
export const HEALTH_LINE_BYTES = Object.freeze({ CHRONY: 304, DMESG: 100, CHANGES: 170 });
/** 파일 목록 상한(sysctl.d · cron.d · spool 각각). */
export const HEALTH_FILES_MAX = 32;
/** dnf history 줄 상한. */
export const DNF_LINES_MAX = 6;
/** rpmdb 가 이 분 안에 바뀌었을 때만 dnf history 를 읽는다(평소 주기 비용 0 — 5분 주기의 4배 여유). */
export const DNF_RECENT_MIN = 20;

/**
 * `sysctl -a` 전체 CRC 에서 뺄 휘발성 키(매 주기 값이 바뀐다 — 넣으면 매 주기 ‘바뀜’ 이 된다).
 *   이 개발 컨테이너(커널 6.18)에서 3초 간격 두 번 비교로 확인한 6개(fs.dentry-state · fs.file-nr · fs.inode-nr · fs.inode-state · kernel.ns_last_pid · kernel.random.uuid)
 *   + 이름으로 휘발성이 분명한 것(entropy_avail · aio-nr · pty.nr · dqstats · quota · nf_conntrack_count). ⚠ 실장비 목록은 미확인 — 그래서 changes.js 가
 *   ‘연속 3주기 바뀜 = 휘발성(noisy)’ 으로 보고 전체 CRC 이벤트를 멈춘다(정직 기록).
 */
export const SYSCTL_VOLATILE_RE = '^(fs\\.(dentry-state|file-nr|inode-nr|inode-state|aio-nr|quota\\.|dqstats\\.)|kernel\\.(ns_last_pid|random\\.(uuid|entropy_avail)|pty\\.nr)|net\\.netfilter\\.nf_conntrack_count)';

const P = HEALTH_PREFIX;
/**
 * 셸 조각(상수) — `linuxCommand` 가 HEALTH_SECTIONS 순서로 붙인다. ⚠ 여기에 변수 · 외부 입력을 넣지 말 것(테스트가 `${` 바깥 삽입 · sudo 를 스윕한다).
 *   셸 변수($l · $r · $f)는 명령 안 지역 변수다(외부 입력 아님).
 */
export const HEALTH_SHELL = Object.freeze({
  // chronyc -c tracking: RefID,이름,stratum,기준 시각,System time(초),Last offset,RMS,Freq,Resid,Skew,Root delay,Root disp,Update interval,Leap status.
  //   없으면 0줄(absent) · 실패면 rc 만(missing). 한 줄만.
  CHRONY: [
    'if command -v chronyc >/dev/null 2>&1; then',
    'l=$(timeout 3 chronyc -c tracking 2>/dev/null); r=$?;',
    `if [ "$r" -eq 0 ]; then printf '%s\\n' "$l" | head -n 1 | cut -c1-300 | sed 's/^/${P.CHRONY}t,/'; fi; echo "${P.CHRONY}rc=$r";`,
    'fi',
  ].join(' '),
  /*
   * dmesg -x(‘kern  :err   : [  12.345678] 메시지’) — awk 가 **개수만** 센다(원문은 awk 밖으로 나오지 않는다). 시각은 부팅 뒤 초(대괄호)라 /proc/uptime 과 비교해
   *   최근 24시간을 센다. 권한이 없으면(dmesg_restrict) dmesg 가 실패 → rc ≠ 0 → 파서가 ‘권한 부족 또는 실패’ 로(개수를 지어내지 않는다).
   */
  DMESG: [
    `{ timeout 3 dmesg -x --level=err,warn 2>/dev/null; echo "@rc=$?"; } | awk -v up="$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"`,
    "'BEGIN { e=0; w=0; e24=0; w24=0; rc=\"\" }",
    '/^@rc=/ { rc = substr($0, 5); next }',
    '{ s = substr($0, 1, 40); lv = ""; if (index(s, ":err ") > 0 || index(s, ":err:") > 0) lv = "e"; else if (index(s, ":warn ") > 0 || index(s, ":warn:") > 0) lv = "w"; if (lv == "") next;',
    'ts = -1; i = index(s, "["); j = index(s, "]"); if (i > 0 && j > i) ts = substr(s, i + 1, j - i - 1) + 0;',
    'if (lv == "e") { e++; if (ts >= 0 && up + 0 > 0 && ts >= up - 86400) e24++ } else { w++; if (ts >= 0 && up + 0 > 0 && ts >= up - 86400) w24++ } }',
    `END { if (rc == "0") print "${P.DMESG}err=" e " warn=" w " err24=" e24 " warn24=" w24 " rc=0"; else print "${P.DMESG}rc=" rc }'`,
  ].join(' '),
  /*
   * 변경 감지 사실 — 줄마다 `x:<키>=<값>`(키는 고정). 파일 목록은 `x:sf:<이름>|<crc>` · `x:cf:` · `x:ct:` (이름은 root 가 만든 파일 · 사용자 이름).
   *   needs-restarting 은 종료 코드만(0 = 재부팅 불필요 · 1 = 필요 · 그 밖 = 실패) — 없으면 `nr=absent`.
   */
  CHANGES: [
    `echo "${P.CHANGES}up=$(cut -d' ' -f1 /proc/uptime 2>/dev/null)";`,
    `echo "${P.CHANGES}boot=$(cut -c1-36 /proc/sys/kernel/random/boot_id 2>/dev/null)";`,
    `echo "${P.CHANGES}kern=$(uname -r 2>/dev/null | cut -c1-80)";`,
    `if command -v needs-restarting >/dev/null 2>&1; then timeout 8 needs-restarting -r >/dev/null 2>&1; echo "${P.CHANGES}nr=$?"; else echo '${P.CHANGES}nr=absent'; fi;`,
    `echo "${P.CHANGES}pk=$(stat -c %Y /var/lib/rpm/rpmdb.sqlite /var/lib/rpm/Packages 2>/dev/null | head -n 1)";`,
    `if [ -n "$(find /var/lib/rpm -maxdepth 1 \\( -name rpmdb.sqlite -o -name Packages \\) -mmin -${DNF_RECENT_MIN} 2>/dev/null | head -n 1)" ] && command -v dnf >/dev/null 2>&1; then`,
    `timeout 8 dnf -q history list 2>/dev/null | head -n ${DNF_LINES_MAX + 2} | cut -c1-160 | sed 's/^/${P.CHANGES}h:/'; fi;`,
    `echo "${P.CHANGES}sx=$(sysctl -a 2>/dev/null | grep -v -E '${SYSCTL_VOLATILE_RE}' | cksum | cut -d' ' -f1)";`,
    `for f in /etc/sysctl.conf /etc/sysctl.d/*.conf; do if [ -f "$f" ]; then echo "${P.CHANGES}sf:\${f##*/}|$(cksum < "$f" 2>/dev/null | cut -d' ' -f1)"; fi; done 2>/dev/null | head -n ${HEALTH_FILES_MAX} | cut -c1-120;`,
    `for f in /etc/crontab /etc/cron.d/*; do if [ -f "$f" ]; then echo "${P.CHANGES}cf:\${f##*/}|$(cksum < "$f" 2>/dev/null | cut -d' ' -f1)"; fi; done 2>/dev/null | head -n ${HEALTH_FILES_MAX} | cut -c1-120;`,
    `if [ -d /var/spool/cron ] && [ -r /var/spool/cron ] && [ -x /var/spool/cron ]; then for f in /var/spool/cron/*; do if [ -f "$f" ]; then if [ -r "$f" ]; then echo "${P.CHANGES}ct:\${f##*/}|$(cksum < "$f" 2>/dev/null | cut -d' ' -f1)"; else echo "${P.CHANGES}ct:\${f##*/}|perm"; fi; fi; done 2>/dev/null | head -n ${HEALTH_FILES_MAX} | cut -c1-120; elif [ -d /var/spool/cron ]; then echo '${P.CHANGES}ctperm=1'; fi;`,
    `echo "${P.CHANGES}fw=$(timeout 3 systemctl is-active firewalld 2>/dev/null | head -n 1 | cut -c1-16)";`,
    `echo "${P.CHANGES}fd=$(cat /proc/sys/fs/file-nr 2>/dev/null)";`,
    `if [ -r /proc/sys/net/netfilter/nf_conntrack_count ]; then echo "${P.CHANGES}ct=$(cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null) $(cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null)"; fi`,
  ].join(' '),
});

const num = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const clip = (s, n) => String(s ?? '').slice(0, n);
/** 접두가 있는 줄만, 접두를 벗겨서(줄 길이를 먼저 자른다). */
function stripped(lines, pfx, max = 400) {
  const out = [];
  for (const l of lines || []) {
    const s = clip(l, max);
    if (s.startsWith(pfx)) out.push(s.slice(pfx.length));
  }
  return out;
}

/**
 * ##CHRONY → { offsetMs, lastOffsetMs, stratum, refId, leap, synced } · 실패(rc≠0)면 null(missing). 줄이 없으면 readSection 이 absent 로 둔다.
 *   System time(초)은 chrony 문서상 ‘시스템 시각이 NTP 시각보다 빠르면 +’ — 화면은 절댓값만 기준과 비교한다(부호는 그대로 보인다).
 */
export function parseChrony(lines = []) {
  const ls = stripped(lines, P.CHRONY);
  let rc = null; let row = null;
  for (const s of ls) {
    const m = /^rc=(\d{1,3})$/.exec(s.trim());
    if (m) { rc = Number(m[1]); continue; }
    if (s.startsWith('t,') && !row) row = s.slice(2, 302);
  }
  if (rc !== 0 || !row) return null;
  const f = row.split(',');
  if (f.length < 14) return null;
  const refId = /^[0-9A-Fa-f]{1,8}$/.test(f[0]) ? f[0].toUpperCase() : null;
  const stratum = num(f[2]);
  const sys = num(f[4]); const last = num(f[5]);
  const leap = clip(f[13], 32).trim();
  const leapOk = /^[A-Za-z ]{1,32}$/.test(leap) ? leap : '';
  const synced = leapOk ? !/not\s*synch/i.test(leapOk) && stratum != null && stratum > 0 && stratum < 16 : null;
  return {
    offsetMs: sys == null ? null : Math.round(sys * 1e6) / 1e3,
    lastOffsetMs: last == null ? null : Math.round(last * 1e6) / 1e3,
    stratum, refId, leap: leapOk || null, synced,
  };
}

/** ##DMESG → { err, warn, err24, warn24 } · rc ≠ 0 이면 { failed:true, rc }(권한 부족 · 옵션 미지원 — 개수를 지어내지 않는다). */
export function parseDmesgCounts(lines = []) {
  const ls = stripped(lines, P.DMESG, 120);
  for (const s of ls) {
    const t = s.trim();
    const m = /^err=(\d{1,9}) warn=(\d{1,9}) err24=(\d{1,9}) warn24=(\d{1,9}) rc=0$/.exec(t);
    if (m) return { err: Number(m[1]), warn: Number(m[2]), err24: Number(m[3]), warn24: Number(m[4]) };
    const f = /^rc=(\d{0,3})$/.exec(t);
    if (f) return { failed: true, rc: f[1] === '' ? null : Number(f[1]) };
  }
  return null;
}

const FILE_NAME_RE = /^[A-Za-z0-9._@+-]{1,64}$/;
const CRC_RE = /^\d{1,10}$/;
/** 파일 줄 `<이름>|<crc|perm>` → [이름, crc|'perm'] 또는 null. */
function fileEntry(s) {
  const i = s.indexOf('|');
  if (i <= 0) return null;
  const name = s.slice(0, i); const v = s.slice(i + 1).trim();
  if (!FILE_NAME_RE.test(name)) return null;
  if (v === 'perm') return [name, 'perm'];
  return CRC_RE.test(v) ? [name, v] : null;
}
/**
 * dnf history list 한 줄 → { id, at, action, altered } (명령줄 칸은 버린다 — 비밀 혼입).
 *   형식(dnf 문서 기준 — 실장비 미확인): ` 214 | install kernel … | 2026-11-05 22:05 | Install | 12  ` · 머리글 · 구분선은 버린다.
 */
export function parseDnfLine(s) {
  const cols = clip(s, 160).split('|').map((x) => x.trim());
  if (cols.length < 4) return null;
  const id = /^\d{1,9}$/.test(cols[0]) ? Number(cols[0]) : null;
  if (id == null) return null;
  const date = cols.find((c) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(c)) || null;
  const di = date ? cols.indexOf(date) : -1;
  const action = di >= 0 && cols[di + 1] && /^[A-Za-z, ]{1,40}$/.test(cols[di + 1]) ? cols[di + 1] : null;
  const altered = di >= 0 && cols[di + 2] != null ? num(String(cols[di + 2]).replace(/[^\d]/g, '')) : null;
  return { id, at: date, action, altered };
}

/**
 * ##CHANGES → 사실(전부 짧은 값 · 내용 없음). 하나도 못 읽으면 null.
 *  { upS, bootId, kernel, needsRestart(true|false|null), nrAbsent, rpmdbAt, dnf:[…]|null, sysctlCrc, sysctlFiles:{이름:crc}, cronFiles:{}, spool:{}|null, spoolPerm,
 *    firewalld, fd:{alloc,max,pct}, conntrack:{count,max,pct}|null }
 */
export function parseChanges(lines = []) {
  const ls = stripped(lines, P.CHANGES, 200);
  const out = {
    upS: null, bootId: null, kernel: null, needsRestart: null, nrAbsent: false, rpmdbAt: null, dnf: null,
    sysctlCrc: null, sysctlFiles: {}, cronFiles: {}, spool: {}, spoolPerm: false, firewalld: null, fd: null, conntrack: null,
  };
  let seen = 0;
  const files = { sf: out.sysctlFiles, cf: out.cronFiles, ct: out.spool };
  const counts = { sf: 0, cf: 0, ct: 0 };
  for (const s0 of ls) {
    const s = s0.trimEnd();
    let m;
    if ((m = /^(sf|cf|ct):(.{1,130})$/.exec(s))) {
      const e = fileEntry(m[2]);
      if (e && counts[m[1]] < HEALTH_FILES_MAX && !Object.hasOwn(files[m[1]], e[0])) { files[m[1]][e[0]] = e[1]; counts[m[1]] += 1; seen += 1; }
      continue;
    }
    if (s.startsWith('h:')) {
      const d = parseDnfLine(s.slice(2));
      if (d) { out.dnf = out.dnf || []; if (out.dnf.length < DNF_LINES_MAX) out.dnf.push(d); seen += 1; }
      continue;
    }
    if ((m = /^up=([\d.]{1,16})$/.exec(s))) { out.upS = num(m[1]); seen += 1; continue; }
    if ((m = /^boot=([0-9a-f-]{36})$/.exec(s))) { out.bootId = m[1]; seen += 1; continue; }
    if ((m = /^kern=([A-Za-z0-9._+-]{1,80})$/.exec(s))) { out.kernel = m[1]; seen += 1; continue; }
    if ((m = /^nr=(absent|\d{1,3})$/.exec(s))) {
      if (m[1] === 'absent') out.nrAbsent = true;
      else out.needsRestart = m[1] === '1' ? true : m[1] === '0' ? false : null;   // 그 밖(실패 · 시한 124)은 확인 불가
      seen += 1; continue;
    }
    if ((m = /^pk=(\d{1,12})$/.exec(s))) { out.rpmdbAt = Number(m[1]) * 1000; seen += 1; continue; }
    if ((m = /^sx=(\d{1,10})$/.exec(s))) { out.sysctlCrc = m[1]; seen += 1; continue; }
    if (s === 'ctperm=1') { out.spoolPerm = true; out.spool = null; seen += 1; continue; }
    if ((m = /^fw=([a-z-]{0,16})$/.exec(s))) { out.firewalld = m[1] || null; seen += 1; continue; }
    if ((m = /^fd=(\d{1,12})\s+(\d{1,12})\s+(\d{1,20})$/.exec(s))) {
      const alloc = Number(m[1]); const max = Number(m[3]);
      out.fd = { alloc, max, pct: max > 0 ? Math.round((alloc / max) * 1000) / 10 : null }; seen += 1; continue;
    }
    if ((m = /^ct=(\d{1,12}) (\d{1,12})$/.exec(s))) {
      const count = Number(m[1]); const max = Number(m[2]);
      out.conntrack = { count, max, pct: max > 0 ? Math.round((count / max) * 1000) / 10 : null }; seen += 1; continue;
    }
  }
  if (out.spool && Object.values(out.spool).some((v) => v === 'perm')) out.spoolPerm = true;
  return seen ? out : null;
}
