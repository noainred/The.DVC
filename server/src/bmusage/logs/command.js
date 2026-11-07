/**
 * bmusage/logs/command.js — 7a단계 서버 로그 **증분 읽기 명령**(설계 PROFILES §17 · 아트보드 Logs ‘수집 방식’).
 *
 * 같은 SSH 세션(주기 수집 1회 — 로그인 1회)에서 주 수집 명령 **다음에** 별도 exec 로 돈다(collectors/osSsh.js extraCommands — 남은 세션 예산 안에서만 ·
 *   예산이 모자라면 건너뛰고 사유를 남긴다). 주 명령에 섞지 않은 이유(설계와 다른 결정): ① 주 명령은 전체 바이트 상한(OUTPUT_MAX_BYTES)을 넘으면 마지막 구획을
 *   버리는 잘림 보호(1단계 D1)가 있다 — 로그 수천 줄이 다섯 지표 구획을 밀어내면 안 된다 ② 로그 읽기가 멈춰도 주 수집 결과는 그대로다(시한이 따로).
 *
 * 구획(이 명령의 표지 순서 — splitSections order · 정확 일치 · 재개방 금지):
 *   ##JOURNAL — `journalctl -p warning`(우선순위 warning 이상) · 커널 전송 제외(_TRANSPORT=journal|syslog|stdout — 커널 메시지는 ##DMESG 가 읽는다: 두 번 세지 않게) ·
 *               `--after-cursor`(커서 증분) · 커서가 없으면 `--since=-60min`(처음 1시간만 — 과거 전체를 읽지 않는다)
 *   ##DMESG   — `dmesg -x --level=emerg,alert,crit,err,warn` · boot_id + 마지막 [초] 이후 줄만(재부팅이면 처음부터 — 링 버퍼 크기만큼)
 *   ##SECURE  — `/var/log/secure`(sshd · sudo · useradd …) — 파일 offset + inode 증분 · 로테이트 감지(옛 inode 를 같은 폴더에서 찾아 남은 꼬리를 먼저) · 권한 없으면 ‘권한 없음’ 표지
 *   ##AUDIT   — `/var/log/audit/audit.log`(있을 때만 — 관심 레코드 type 만 grep) · auditd 활성 여부
 *   ##APPLOG  — 용도 로그(GPDB pg_log csv · Airflow scheduler) — **경로는 이 파일의 상수 카탈로그만**(사용자 입력 경로 없음) · 폴더가 있을 때만 · 가장 최근 파일 1개
 *   ##END
 *
 * ⚠⚠ 구획 위조 방지(4단계 반증 R1 · 1단계 D1 규약 그대로): **모든 내용 줄에 고정 접두**(J| · K| · S| · A| · G| · F|)를 붙이고 메타 줄은 `J#…` 꼴이다 —
 *   로그 줄이 ‘##SECURE’ · ‘##END’ 여도 줄 머리가 ‘J|##END’ 가 되어 표지가 될 수 없다. 파서는 접두 없는 줄을 버린다.
 * ⚠⚠ 명령 조립 값(커서 · inode · offset · boot_id · 마지막 초)은 **화이트리스트 정규식을 통과한 것만** 넣는다(아래 *_RE — 셸 의미 문자가 들어갈 수 없는 꼴).
 *   통과하지 못하면 그 값은 없는 것으로(첫 읽기 꼴) 조립한다 — 명령에 바깥 문자열이 섞이지 않는다(테스트가 위조 상태로 조립해 본다).
 * ⚠ 상한: 출처마다 줄 상한(설정 lineCap · 기본 5,000 — 넘친 줄은 ‘잘림 n줄’ 로 센다 · 커서는 끝까지 넘긴다: 잘린 줄은 다시 읽지 않는다) · 줄 폭 500자(cut · awk substr) ·
 *   전체 head -c(OUTPUT_MAX — sshExec 상한 4MB 보다 작게) · 멈출 수 있는 명령은 timeout(journalctl 15 · dmesg 5 · systemctl 3 · find 5).
 * ⚠ 정직: Rocky 8 · 9 실장비에서 돌려 보지 못했다 — 이 개발 컨테이너(dash · mawk · coreutils)에서 가짜 journalctl · dmesg 와 임시 파일로 실행해 본 것이 전부다
 *   (test/bmLogs7aCommand.test.js). `journalctl --show-cursor` · `_TRANSPORT=` 일치 · `--after-cursor` 동작은 systemd 문서 기준(실측 아님).
 */

/** 구획 순서(명령의 echo 순서와 같다 — 테스트가 명령 문자열에서 뽑아 대조). */
export const LOG_SECTIONS = Object.freeze(['JOURNAL', 'DMESG', 'SECURE', 'AUDIT', 'APPLOG', 'END']);
/** 내용 줄 접두(출처별) · 메타 줄 접두는 `<글자>#`. */
export const LOG_PREFIX = Object.freeze({ journal: 'J', kernel: 'K', secure: 'S', audit: 'A', gpdb: 'G', airflow: 'F' });
export const LINE_WIDTH = 500;
/** 첫 읽기(커서 · offset 없음) — journald 는 최근 60분, 파일은 마지막 200줄(과거 전체를 읽지 않는다 — 시작점을 잡는 읽기). */
export const FIRST_SINCE_MIN = 60;
export const FIRST_FILE_LINES = 200;
/** 전체 출력 상한 — sshExec EXEC_MAX_OUTPUT(4MB) 보다 작게(넘으면 sshExec 가 결과를 통째로 버린다). 출처 6 × 상한 줄 × 폭을 다 받을 수는 없다 — 넘치면 마지막 구획이 잘린다(파서가 END 미도착으로 밝힌다). */
export const OUTPUT_MAX = 3 * 1024 * 1024;
export const LINE_CAP_RANGE = Object.freeze([100, 20_000]);
export const LINE_CAP_DEFAULT = 5_000;

/** 화이트리스트(셸에 들어가는 값 — 이 꼴이 아니면 넣지 않는다). */
export const CURSOR_RE = /^s=[0-9a-f]{32};i=[0-9a-f]{1,16};b=[0-9a-f]{32};m=[0-9a-f]{1,16};t=[0-9a-f]{1,16};x=[0-9a-f]{1,16}$/;
export const BOOT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SECS_RE = /^\d{1,10}(?:\.\d{1,6})?$/;
export const DIGITS_RE = /^\d{1,19}$/;

/**
 * 용도 로그 카탈로그(**상수만** — 사용자 입력 경로 금지 · 설계 §19 ‘프로파일 로그 경로는 카탈로그 상수’). 폴더가 있으면 그 안에서 glob 에 맞는 가장 최근 파일 하나.
 *   filter = grep -E 패턴(상수) — 관심 줄만 센다(나머지는 버린다 — 분류 안 됨으로도 세지 않는다: SQL 오류 줄에 데이터가 실린다).
 *   ⚠ 정직(○): 경로는 흔한 설치 관례로 고른 후보다(현장 MASTER_DATA_DIRECTORY · AIRFLOW_HOME 은 다를 수 있다) — 폴더가 없으면 그 출처는 ‘경로 없음’(absent)이다.
 */
export const APP_LOGS = Object.freeze([
  Object.freeze({ id: 'gpdb', prefix: 'G', dirs: Object.freeze(['/data/master/gpseg-1/pg_log', '/data1/master/gpseg-1/pg_log', '/gpdata/master/gpseg-1/pg_log', '/home/gpadmin/master/gpseg-1/pg_log', '/data/coordinator/gpseg-1/log']),
    glob: 'gpdb-*.csv', filter: ',"(FATAL|PANIC)",|deadlock detected|checkpoints are occurring|checkpoint complete|FTS' }),
  Object.freeze({ id: 'airflow', prefix: 'F', dirs: Object.freeze(['/home/airflow/airflow/logs/scheduler/latest', '/opt/airflow/logs/scheduler/latest', '/root/airflow/logs/scheduler/latest']),
    glob: '*.log', filter: '\\} (ERROR|CRITICAL|WARNING) - ' }),
]);
const AUDIT_FILTER = '^type=(AVC|USER_AUTH|USER_LOGIN|USER_ACCT|ADD_USER|DEL_USER|ADD_GROUP|DEL_GROUP|USER_MGMT|GRP_MGMT|USER_CHAUTHTOK|CONFIG_CHANGE|DAEMON_ABORT|DAEMON_END) ';
const SECURE_FILE = '/var/log/secure';
const AUDIT_FILE = '/var/log/audit/audit.log';

const ok = (re, v) => (typeof v === 'string' && re.test(v) ? v : '');
const sq = (v) => `'${v}'`;   // 화이트리스트를 통과한 값만 온다(따옴표 · 셸 의미 문자가 없다)

/**
 * 파일 증분 셸 함수(상수) — rdf <접두> <파일> <옛 inode> <옛 offset> <grep 패턴|''> <로테이트 폴더> <로테이트 glob>.
 *   mode: first(옛 inode 없음 — 끝에서 FIRST_FILE_LINES 줄만) · inc(같은 inode · 커짐) · shrink(같은 inode · 작아짐 = copytruncate — 처음부터) ·
 *   rot(inode 바뀜 — 옛 inode 파일을 폴더에서 찾아 남은 꼬리 + 새 파일 처음부터 · 못 찾으면 old=0 = 그 사이 줄은 모른다).
 *   n = 이번에 새로 본 (관심) 줄 수 · 내보내는 줄은 앞 cap 줄(나머지는 잘림) · off = 이번 stat 크기(다음 시작점 — 크기를 넘는 줄은 다음 주기에).
 *   ⚠ 값 인자(inode · offset)는 호출부가 DIGITS_RE 를 통과시킨 것만 넣는다(아니면 '').
 */
function rdfShell(cap) {
  return [
    'rdf() { p="$1"; f="$2"; pi="$3"; po="$4"; g="$5"; rd="$6"; rg="$7";',
    'if [ ! -e "$f" ]; then echo "$p#absent"; return 0; fi;',
    'if [ ! -r "$f" ]; then echo "$p#perm"; return 0; fi;',
    'i=$(stat -c %i "$f" 2>/dev/null); s=$(stat -c %s "$f" 2>/dev/null);',
    'case "$i$s" in ""|*[!0-9]*) echo "$p#fail=stat"; return 0;; esac;',
    'echo "$p#ino=$i"; echo "$p#size=$s"; o="";',
    'if [ -z "$pi" ]; then m=first; elif [ "$i" != "$pi" ]; then m=rot; o=$(timeout 5 find "$rd" -maxdepth 1 -name "$rg" -inum "$pi" 2>/dev/null | head -n 1);',
    'elif [ -z "$po" ] || [ "$s" -lt "$po" ]; then m=shrink; else m=inc; fi;',
    'echo "$p#mode=$m"; if [ "$m" = rot ]; then if [ -n "$o" ] && [ -r "$o" ]; then echo "$p#old=1"; else echo "$p#old=0"; o=""; fi; fi;',
    // 읽기 원천(모드별) → 관심 줄 거르기(g) → 세기 / 앞 cap 줄만 접두를 붙여 내보낸다. 원천은 두 번 읽는다(세기 · 내보내기 — head 가 일찍 끝나도 개수는 정확).
    'rsrc() { case "$m" in first) head -c "$s" "$f" | tail -n ' + String(FIRST_FILE_LINES) + ';; inc) tail -c +$((po+1)) "$f" | head -c $((s-po));; shrink) head -c "$s" "$f";;',
    'rot) if [ -n "$o" ]; then tail -c +$(( ${po:-0} + 1 )) "$o"; fi; head -c "$s" "$f";; esac; };',
    'rflt() { if [ -n "$g" ]; then grep -E -a "$g"; else cat; fi; };',
    'n=$(rsrc 2>/dev/null | rflt | wc -l | tr -d " ");',
    `rsrc 2>/dev/null | rflt | head -n ${cap} | cut -c1-${LINE_WIDTH} | sed "s/^/$p|/";`,
    'echo "$p#n=$n"; echo "$p#off=$s"; }',
  ].join(' ');
}

/**
 * 로그 읽기 명령(한 서버 · 한 주기). state = 직전 커서(log_cursor.state_json 의 읽기 위치 부분) — 화이트리스트를 통과한 값만 쓴다.
 * @param {{journal?:{cursor?:string}, kernel?:{boot?:string, last?:string}, secure?:{ino?:string, off?:string}, audit?:{ino?,off?}, apps?:{[id]:{dir?:number, ino?:string, off?:string}}}} state
 * @param {{lineCap?:number, _paths?:object}} o  _paths 는 **테스트 전용**(임시 파일로 실제 셸을 돌려 본다 — 설정 · 라우트 경로에서 넘기는 곳이 없다: 소스 스윕이 고정)
 */
export function logCommand(state = {}, { lineCap = LINE_CAP_DEFAULT, _paths = null } = {}) {
  const cap = Math.max(LINE_CAP_RANGE[0], Math.min(LINE_CAP_RANGE[1], Math.floor(Number(lineCap) || LINE_CAP_DEFAULT)));
  const P = { secure: SECURE_FILE, audit: AUDIT_FILE, apps: APP_LOGS, ...(_paths || {}) };
  const st = state && typeof state === 'object' ? state : {};
  const cur = ok(CURSOR_RE, st.journal?.cursor);
  const jPos = cur ? `--after-cursor=${sq(cur)}` : `--since=-${FIRST_SINCE_MIN}min`;
  const boot = ok(BOOT_RE, st.kernel?.boot);
  const last = boot ? ok(SECS_RE, st.kernel?.last) : '';
  const fileArgs = (x) => {
    const ino = ok(DIGITS_RE, x?.ino);
    return [ino ? sq(ino) : "''", ino ? (ok(DIGITS_RE, x?.off) ? sq(x.off) : "''") : "''"];
  };
  const dirOf = (f) => f.slice(0, f.lastIndexOf('/')) || '/';
  const baseOf = (f) => f.slice(f.lastIndexOf('/') + 1);
  const [sIno, sOff] = fileArgs(st.secure);
  const [aIno, aOff] = fileArgs(st.audit);

  const cmds = [
    rdfShell(cap),
    // ── journald ────────────────────────────────────────────────────────────
    "echo '##JOURNAL'",
    'if command -v journalctl >/dev/null 2>&1; then',
    `{ timeout 15 journalctl -q --no-pager -o short-iso -p warning _TRANSPORT=journal _TRANSPORT=syslog _TRANSPORT=stdout ${jPos} --show-cursor 2>&1; echo "@rc=$?"; } |`,
    // 내용 줄 = 시각(숫자)으로 시작하거나 들여쓴 이어진 줄. 그 밖은 journalctl 자신의 줄(권한 힌트 · 오류) — 글자는 내보내지 않고 표지만.
    `awk -v cap=${cap} 'BEGIN{t=0;rc=""} /^@rc=/{rc=substr($0,5);next} /^-- cursor: /{print "J#cur=" substr($0,12,200);next} /^-- /{next}`,
    '/^[0-9]/ || /^[ \\t]/ {t++; if(t<=cap) print "J|" substr($0,1,' + LINE_WIDTH + '); next}',
    '/^Hint: You are currently not seeing messages/ || /^No journal files were opened due to insufficient permissions/ {print "J#perm"; next}',
    `{print "J#err"} END{print "J#n=" t; print "J#rc=" rc}'`,
    'else',
    "echo 'J#absent'",
    'fi',
    // ── dmesg(커널 링 버퍼) — boot_id 가 같으면 마지막 [초] 이후 줄만 ───────────────────────
    "echo '##DMESG'",
    'if command -v dmesg >/dev/null 2>&1; then',
    `{ timeout 5 dmesg -x --level=emerg,alert,crit,err,warn 2>&1; echo "@rc=$?"; } |`,
    `awk -v cap=${cap} -v boot="$(cut -c1-36 /proc/sys/kernel/random/boot_id 2>/dev/null)" -v lboot=${sq(boot)} -v last=${sq(last || '-1')} -v up="$(cut -d' ' -f1 /proc/uptime 2>/dev/null)" -v now="$(date +%s 2>/dev/null)" \\`,
    `'BEGIN{t=0;mx=-1;rc="";perm=0;same=(boot!="" && boot==lboot)} /^@rc=/{rc=substr($0,5);next} /^dmesg: /{if($0 ~ /not permitted|Permission denied/) perm=1; next}`,
    '{s=substr($0,1,60); i=index(s,"["); j=index(s,"]"); ts=-1; if(i>0 && j>i) ts=substr(s,i+1,j-i-1)+0; if(ts<0) next; if(same && ts<=last+0) next; if(ts>mx) mx=ts;',
    `t++; if(t<=cap) print "K|" substr($0,1,${LINE_WIDTH})}`,
    `END{print "K#boot=" boot; if(mx>=0) printf "K#last=%.6f\\n", mx; else if(same) print "K#last=" last; else print "K#last=-1"; print "K#up=" up; print "K#now=" now; print "K#n=" t; if(perm) print "K#perm"; print "K#rc=" rc}'`,
    'else',
    "echo 'K#absent'",
    'fi',
    // ── /var/log/secure — offset + inode ──────────────────────────────────────
    "echo '##SECURE'",
    `rdf S ${sq(P.secure)} ${sIno} ${sOff} '' ${sq(dirOf(P.secure))} ${sq(`${baseOf(P.secure)}*`)}`,
    // ── auditd(있을 때만) — 활성 여부 + 관심 레코드 ───────────────────────────────
    "echo '##AUDIT'",
    `echo "A#svc=$(timeout 3 systemctl is-active auditd 2>/dev/null | head -n 1 | cut -c1-16)"`,
    `rdf A ${sq(P.audit)} ${aIno} ${aOff} ${sq(AUDIT_FILTER)} ${sq(dirOf(P.audit))} ${sq(`${baseOf(P.audit)}*`)}`,
    // ── 용도 로그(상수 카탈로그) ─────────────────────────────────────────────────
    "echo '##APPLOG'",
    ...P.apps.flatMap((a) => {
      const sa = st.apps?.[a.id] || {};
      const [ino, off] = fileArgs(sa);
      // 폴더 후보 중 처음 있는 것 · 그 안 glob 의 가장 최근 파일(ls -t). 파일 이름은 줄 머리에 오지 않는다(폴더 번호만 G#dir= 로).
      const dirs = a.dirs.map((d, i) => `${i}:${d}`).join(' ');
      return [
        `ad=''; ai=''; for x in ${dirs}; do d="\${x#*:}"; if [ -d "$d" ]; then ad="$d"; ai="\${x%%:*}"; break; fi; done`,
        'if [ -z "$ad" ]; then',
        `echo '${a.prefix}#absent'`,
        'else',
        `echo "${a.prefix}#dir=$ai"; af=$(ls -1t "$ad"/${a.glob} 2>/dev/null | head -n 1)`,
        `if [ -z "$af" ]; then echo '${a.prefix}#nofile'; else rdf ${a.prefix} "$af" ${ino} ${off} ${sq(a.filter)} "$ad" ${sq(a.glob)}; fi`,
        'fi',
      ];
    }),
    "echo '##END'",
  ];
  return `export LC_ALL=C\n{\n${cmds.join('\n')}\n} 2>/dev/null | head -c ${OUTPUT_MAX}`;
}
