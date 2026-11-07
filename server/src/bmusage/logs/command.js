/**
 * bmusage/logs/command.js — 7a단계 서버 로그 **증분 읽기 명령**(설계 PROFILES §17 · 아트보드 Logs ‘수집 방식’).
 *
 * 같은 SSH 세션(주기 수집 1회 — 로그인 1회)에서 주 수집 명령 **다음에** 별도 exec 로 돈다(collectors/osSsh.js extraCommands — 남은 세션 예산 안에서만 ·
 *   예산이 모자라면 건너뛰고 사유를 남긴다). 주 명령에 섞지 않은 이유(설계와 다른 결정): ① 주 명령은 전체 바이트 상한(OUTPUT_MAX_BYTES)을 넘으면 마지막 구획을
 *   버리는 잘림 보호(1단계 D1)가 있다 — 로그 수천 줄이 다섯 지표 구획을 밀어내면 안 된다 ② 로그 읽기가 멈춰도 주 수집 결과는 그대로다(시한이 따로).
 *
 * 구획(이 명령의 표지 순서 — splitSections order · 정확 일치 · 재개방 금지):
 *   ##JOURNAL — `journalctl -o json -p warning`(우선순위 warning 이상) · 커널 전송 제외(_TRANSPORT=journal|syslog|stdout — 커널 메시지는 ##DMESG 가 읽는다: 두 번 세지 않게) ·
 *               항목마다 커서(awk 가 본 마지막 항목의 __CURSOR — 반증 F5) · 커서가 없으면 `--since=-60min`(처음 1시간만)
 *   ##JSEC    — `journalctl -o json -p info SYSLOG_IDENTIFIER=sshd …`(AUTH_IDENTS — sshd 성공 · 실패는 info 라 위 읽기에 안 들어온다 · 반증 F1) · 자기 커서 · 자기 상한
 *               (원문 보관 없음 — 분류 · 집계만). /var/log/secure 를 읽은 주기에는 같은 기록이라 세지 않는다(parse.js pickAuthSource).
 *   ##DMESG   — `dmesg -x --level=emerg,alert,crit,err,warn` · boot_id + 마지막 [초] 이후 줄만(재부팅이면 처음부터) · 첫 읽기는 가동 마지막 60분만(반증 F6)
 *   ##SECURE  — `/var/log/secure`(sshd · sudo · useradd …) — 파일 offset + inode 증분 · 로테이트 감지 · rsyslog 활성 여부 · 권한 없으면 ‘권한 없음’ 표지(파일 · 상위 폴더)
 *   ##AUDIT   — `/var/log/audit/audit.log`(있을 때만 — 관심 레코드 type 만 grep) · auditd 활성 여부 · 0700 폴더면 ‘권한 없음’(반증 F3)
 *   ##APPLOG  — 용도 로그(GPDB pg_log csv · Airflow scheduler) — **경로는 이 파일의 상수 카탈로그만**(사용자 입력 경로 없음) · 폴더가 있을 때만 · 가장 최근 파일 1개
 *   ##END
 *
 * ⚠⚠ 구획 위조 방지(4단계 반증 R1 · 1단계 D1 규약 그대로): **모든 내용 줄에 고정 접두**(J| · Q| · K| · S| · A| · G| · F|)를 붙이고 메타 줄은 `J#…` 꼴이다 —
 *   로그 줄이 ‘##SECURE’ · ‘##END’ 여도 줄 머리가 ‘J|…’ 가 되어 표지가 될 수 없다. 파서는 접두 없는 줄을 버린다.
 * ⚠⚠ 명령 조립 값(커서 · inode · offset · boot_id · 마지막 초)은 **화이트리스트 정규식을 통과한 것만** 넣는다(아래 *_RE — 셸 의미 문자가 들어갈 수 없는 꼴 ·
 *   숫자는 선행 0 없음 · 18자리까지 — dash 산술이 8진수로 읽거나 넘치지 않게 · 반증 F13). 통과하지 못하면 그 값은 없는 것으로(첫 읽기 꼴) 조립한다.
 * ⚠ 상한(반증 F4 — 산수를 테스트가 고정): 출처마다 줄 상한(설정 lineCap · LINE_CAP_RANGE)과 **바이트 상한**(SRC_BYTES = (OUTPUT_MAX − 메타 여유) / 출처 수)을 함께 건다 —
 *   넘친 줄은 ‘잘림 n줄’ 로 세고 위치는 본 데까지 넘긴다(잘린 줄은 다시 읽지 않는다 · 한 출처가 다른 구획을 밀어내 영구히 못 받는 일이 없다). 줄 폭 500자(JSON 1,200자) ·
 *   전체 head -c(OUTPUT_MAX — sshExec 상한 4MB 보다 작게 · 출처 상한 합 + 여유 이하라 실제로는 자르지 않는다) · 멈출 수 있는 명령은 timeout(journalctl 15 · dmesg 5 · systemctl 3 · find 5).
 * ⚠ 정직: Rocky 8 · 9 실장비에서 돌려 보지 못했다 — 이 개발 컨테이너(dash · mawk · coreutils)에서 가짜 journalctl · dmesg 와 임시 파일로 실행해 본 것이 전부다
 *   (test/bmLogs7aCommand.test.js). `-o json` · `--output-fields`(systemd 236+ — RHEL 8 = 239) · `_TRANSPORT=` 일치 · `--after-cursor` · 권한 힌트 문구는 systemd 문서 ·
 *   v239/v252 journal-util.c 원문(반증 F2 근거) 기준이다(실장비 실측 아님).
 */

/** 구획 순서(명령의 echo 순서와 같다 — 테스트가 명령 문자열에서 뽑아 대조). JSEC = journald 의 sshd · sudo 계열 보안 기록(우선순위 info 이상 — 반증 F1). */
export const LOG_SECTIONS = Object.freeze(['JOURNAL', 'JSEC', 'DMESG', 'SECURE', 'AUDIT', 'APPLOG', 'END']);
/** 내용 줄 접두(출처별) · 메타 줄 접두는 `<글자>#`. */
export const LOG_PREFIX = Object.freeze({ journal: 'J', jsec: 'Q', kernel: 'K', secure: 'S', audit: 'A', gpdb: 'G', airflow: 'F' });
export const LINE_WIDTH = 500;
/** journald 는 JSON 한 줄 = 한 항목(줄 폭은 넉넉히 — 잘리면 파서가 MESSAGE 앞부분만 꺼낸다). */
export const JSON_WIDTH = 1_200;
/** 첫 읽기(커서 · offset · boot 없음) — journald 는 최근 60분, 파일은 끝 FIRST_FILE_BYTES 안의 마지막 200줄, dmesg 는 가동 마지막 60분(반증 F6). */
export const FIRST_SINCE_MIN = 60;
export const FIRST_FILE_LINES = 200;
/** 첫 읽기는 파일 끝 256KB 만 본다(반증 의심 — 큰 파일을 처음부터 두 번 읽지 않게: tail -c +N 은 정규 파일에서 seek). */
export const FIRST_FILE_BYTES = 256 * 1024;
/** 한 주기 증분 상한 — 넘으면 앞부분을 건너뛰고(바이트를 ‘건너뜀’ 으로 밝힌다) 끝 MAX_INC_BYTES 만 읽는다(세기 · 내보내기 두 번 읽기의 상한). */
export const MAX_INC_BYTES = 64 * 1024 * 1024;
/** 마지막 줄이 미완성(개행 없음)이면 그 조각은 다음 주기로(반증 F14) — 조각이 이보다 길면 진행 보장을 위해 그대로 읽는다. */
export const PARTIAL_MAX = 64 * 1024;
/** 전체 출력 상한 — sshExec EXEC_MAX_OUTPUT(4MB) 보다 작게(넘으면 sshExec 가 결과를 통째로 버린다). */
export const OUTPUT_MAX = 3 * 1024 * 1024;
/** 출처(구획 안 앱 포함) 수 · 메타 줄 여유 · 출처마다 내용 바이트 상한(반증 F4 — 한 출처가 전체 상한을 다 써 다른 구획을 영구히 밀어내지 않게: 합 + 여유 ≤ OUTPUT_MAX, 테스트가 산수를 고정). */
export const LOG_SOURCE_COUNT = Object.keys(LOG_PREFIX).length;
export const META_RESERVE = 32 * 1024;
export const SRC_BYTES = Math.floor((OUTPUT_MAX - META_RESERVE) / LOG_SOURCE_COUNT);
/** 출처마다 주기당 줄 상한 — APPLOG 구획은 앱 두 개가 한 구획이라 2 × 상한 + 메타 < splitSections 구획 줄 상한(20,000)이어야 한다(반증 F4 B — 테스트). */
export const LINE_CAP_RANGE = Object.freeze([100, 9_000]);
export const LINE_CAP_DEFAULT = 5_000;
/** journald 보안 읽기(JSEC)의 식별자(상수 — 같은 필드는 OR). 주 저널(JOURNAL)의 같은 식별자 줄은 파서가 빼고 센다(두 번 세지 않게). */
export const AUTH_IDENTS = Object.freeze(['sshd', 'sshd-session', 'sudo', 'su', 'login', 'useradd', 'usermod', 'userdel', 'groupadd', 'groupmod', 'groupdel', 'gpasswd', 'passwd', 'chpasswd', 'chage']);
const OUTPUT_FIELDS = '--output-fields=MESSAGE,SYSLOG_IDENTIFIER,_COMM,_PID,PRIORITY';

/** 화이트리스트(셸에 들어가는 값 — 이 꼴이 아니면 넣지 않는다). 숫자는 선행 0 없음 · 18자리까지(dash 산술이 8진수로 읽거나 넘치지 않게 — 반증 F13). */
export const CURSOR_RE = /^s=[0-9a-f]{32};i=[0-9a-f]{1,16};b=[0-9a-f]{32};m=[0-9a-f]{1,16};t=[0-9a-f]{1,16};x=[0-9a-f]{1,16}$/;
export const BOOT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SECS_RE = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/;
export const DIGITS_RE = /^(?:0|[1-9]\d{0,17})$/;

/** 용도 로그 폴더 후보 { path, anchor } — anchor = 그 앱의 뿌리 폴더(권한 없음 판정은 path 에서 anchor 까지만 올라간다: /root · /home 같은 공용 상위가 막힌 것은 ‘없음’ 으로 · 반증 F3). */
const dirsOf = (pairs) => Object.freeze(pairs.map(([anchor, p]) => Object.freeze({ anchor, path: p })));
/**
 * 용도 로그 카탈로그(**상수만** — 사용자 입력 경로 금지 · 설계 §19 ‘프로파일 로그 경로는 카탈로그 상수’). 폴더가 있으면 그 안에서 glob 에 맞는 가장 최근 파일 하나.
 *   filter = grep -E 패턴(상수) — 관심 줄만 센다(나머지는 버린다 — 분류 안 됨으로도 세지 않는다: SQL 오류 줄에 데이터가 실린다).
 *   ⚠ 정직(○): 경로는 흔한 설치 관례로 고른 후보다(현장 MASTER_DATA_DIRECTORY · AIRFLOW_HOME 은 다를 수 있다) — 폴더가 없으면 그 출처는 ‘경로 없음’(absent),
 *   경로 일부가 권한 없음(0700 상위 폴더)이면 ‘권한 없음’(perm — 있는지 모른다 · 반증 F3).
 */
export const APP_LOGS = Object.freeze([
  Object.freeze({ id: 'gpdb', prefix: 'G', dirs: dirsOf([['/data/master', '/data/master/gpseg-1/pg_log'], ['/data1/master', '/data1/master/gpseg-1/pg_log'], ['/gpdata/master', '/gpdata/master/gpseg-1/pg_log'],
    ['/home/gpadmin', '/home/gpadmin/master/gpseg-1/pg_log'], ['/data/coordinator', '/data/coordinator/gpseg-1/log']]),
  glob: 'gpdb-*.csv', filter: ',"(FATAL|PANIC|ERROR|WARNING|LOG)","(28P01|28000)",|,"(FATAL|PANIC)",|deadlock detected|checkpoints are occurring|checkpoint complete|FTS' }),
  Object.freeze({ id: 'airflow', prefix: 'F', dirs: dirsOf([['/home/airflow', '/home/airflow/airflow/logs/scheduler/latest'], ['/opt/airflow', '/opt/airflow/logs/scheduler/latest'], ['/root/airflow', '/root/airflow/logs/scheduler/latest']]),
    glob: '*.log', filter: '\\} (ERROR|CRITICAL|WARNING) - ' }),
]);
const AUDIT_FILTER = '^type=(AVC|USER_AUTH|USER_LOGIN|USER_ACCT|ADD_USER|DEL_USER|ADD_GROUP|DEL_GROUP|USER_MGMT|GRP_MGMT|USER_CHAUTHTOK|CONFIG_CHANGE|DAEMON_ABORT|DAEMON_END) ';
const SECURE_FILE = '/var/log/secure';
const AUDIT_FILE = '/var/log/audit/audit.log';

const ok = (re, v) => (typeof v === 'string' && re.test(v) ? v : '');
const sq = (v) => `'${v}'`;   // 화이트리스트를 통과한 값만 온다(따옴표 · 셸 의미 문자가 없다)
/** 내용 줄을 출처 바이트 상한 · 줄 상한 안에서만 접두를 붙여 내보내는 awk(상수 조각) — e = 내보낸 줄 수(파서가 n − e 를 잘림으로). */
const emitAwk = (cap, width) => `awk -v cap=${cap} -v bud=${SRC_BYTES} -v w=${width} -v p="$p" 'BEGIN{e=0;b=0} {l=substr($0,1,w); if(e<cap && b+length(l)+3<=bud){print p "|" l; e++; b+=length(l)+3}} END{print p "#e=" e}'`;

/**
 * 파일 증분 셸 함수(상수) — rdf <접두> <파일> <옛 inode> <옛 offset> <grep 패턴|''> <로테이트 폴더> <로테이트 glob>.
 *   mode: first(옛 inode 없음 — 끝 FIRST_FILE_BYTES 안에서 마지막 FIRST_FILE_LINES 줄만 · 앞 조각 줄은 버림) · inc(같은 inode · 커짐) · shrink(같은 inode · 작아짐 = copytruncate — 처음부터) ·
 *   rot(inode 바뀜 — 옛 inode 파일을 폴더에서 찾아 남은 꼬리 + 새 파일 처음부터 · 못 찾으면 old=0 = 그 사이 줄은 모른다).
 *   ⚠ 반증 F3: 파일이 ‘없어 보이는’ 데 상위 폴더가 있고 들어갈 수 없으면 ‘권한 없음’(#perm=dir — 0700 /var/log/audit). 파일만 못 읽으면 #perm=file.
 *   ⚠ 반증 F14: 마지막 줄이 미완성(개행 없음)이면 그 조각은 다음 주기로 — off 는 마지막 개행 뒤(#part=조각 바이트).
 *   ⚠ 증분이 MAX_INC_BYTES 를 넘으면 앞부분을 건너뛴다(#skipb=건너뛴 바이트 — 줄 수는 모른다 · 0 이 아니다).
 *   n = 이번에 새로 본 (관심) 줄 수 · 내보내는 줄은 줄 · 바이트 상한 안(emitAwk — 나머지는 잘림) · off = 다음 시작점.
 *   ⚠ 값 인자(inode · offset)는 호출부가 DIGITS_RE 를 통과시킨 것만 넣는다(아니면 '').
 */
function rdfShell(cap) {
  return [
    'rdf() { p="$1"; f="$2"; pi="$3"; po="$4"; g="$5"; rd="$6"; rg="$7";',
    'if [ ! -e "$f" ]; then d="${f%/*}"; if [ -d "$d" ] && { [ ! -x "$d" ] || [ ! -r "$d" ]; }; then echo "$p#perm=dir"; else echo "$p#absent"; fi; return 0; fi;',
    'if [ ! -r "$f" ]; then echo "$p#perm=file"; return 0; fi;',
    'i=$(stat -c %i "$f" 2>/dev/null); s=$(stat -c %s "$f" 2>/dev/null);',
    'case "$i$s" in ""|*[!0-9]*) echo "$p#fail=stat"; return 0;; esac;',
    'echo "$p#ino=$i"; echo "$p#size=$s"; o=""; rs=0; d1=0; sk=0;',
    'if [ -z "$pi" ]; then m=first; elif [ "$i" != "$pi" ]; then m=rot; o=$(timeout 5 find "$rd" -maxdepth 1 -name "$rg" -inum "$pi" 2>/dev/null | head -n 1);',
    'elif [ -z "$po" ] || [ "$s" -lt "$po" ]; then m=shrink; else m=inc; rs=$po; fi;',
    `if [ "$m" = first ] && [ "$s" -gt ${FIRST_FILE_BYTES} ]; then rs=$((s-${FIRST_FILE_BYTES})); d1=1; fi;`,
    `if [ $((s-rs)) -gt ${MAX_INC_BYTES} ]; then sk=$((s-${MAX_INC_BYTES}-rs)); rs=$((s-${MAX_INC_BYTES})); d1=1; o=""; fi;`,
    'echo "$p#mode=$m"; if [ "$m" = rot ]; then if [ -n "$o" ] && [ -r "$o" ]; then echo "$p#old=1"; else echo "$p#old=0"; o=""; fi; fi;',
    'if [ "$sk" -gt 0 ]; then echo "$p#skipb=$sk"; fi; re=$s;',
    // 마지막 바이트가 개행이 아니면 마지막 조각 길이만큼 끝을 당긴다(조각은 다음 주기에 온전한 줄로 읽는다).
    'if [ "$re" -gt "$rs" ]; then lb=$(tail -c +$re "$f" 2>/dev/null | head -c 1 | od -An -tx1 | tr -d " \\n");',
    'if [ "$lb" != 0a ]; then pl=$(tail -c +$((rs+1)) "$f" 2>/dev/null | head -c $((re-rs)) | tail -n 1 | wc -c | tr -d " "); case "$pl" in ""|*[!0-9]*) pl=0;; esac;',
    `if [ "$pl" -le ${PARTIAL_MAX} ]; then re=$((re-pl)); echo "$p#part=$pl"; fi; fi; fi;`,
    'rsrc() { { if [ -n "$o" ]; then tail -c +$(( ${po:-0} + 1 )) "$o"; fi; if [ "$re" -gt "$rs" ]; then tail -c +$((rs+1)) "$f" | head -c $((re-rs)); fi; } |',
    `{ if [ "$d1" = 1 ]; then sed 1d; else cat; fi; } | { if [ "$m" = first ]; then tail -n ${FIRST_FILE_LINES}; else cat; fi; }; };`,
    'rflt() { if [ -n "$g" ]; then grep -E -a "$g"; else cat; fi; };',
    'n=$(rsrc 2>/dev/null | rflt | wc -l | tr -d " ");',
    `rsrc 2>/dev/null | rflt | head -n ${cap} | ${emitAwk(cap, LINE_WIDTH)};`,
    'echo "$p#n=$n"; echo "$p#off=$re"; }',
  ].join(' ');
}

/**
 * journald 읽기(상수 조각) — `-o json`(한 줄 = 한 항목 · `__CURSOR` · `__REALTIME_TIMESTAMP` 는 늘 실린다 — systemd 문서 --output-fields).
 *   ⚠ 반증 F5: 커서는 **awk 가 본 마지막 항목의 `__CURSOR`** — 줄 상한 · 바이트 상한 · 시한(timeout 15 → rc 124)에서도 본 지점까지 전진한다(같은 줄을 다시 세지 않는다 · 진행 보장).
 *     본 항목은 전부 n 에 세고 내보낸 것(e)만 분류한다(나머지는 잘림). `--show-cursor` 에 기대지 않는다(journalctl 이 끝까지 가야 찍힌다).
 *   ⚠ 반증 F2: `-q` 를 쓰지 않는다 — systemd v239 · v252 `journal_access_check_and_warn()` 원문은 `-q` 가 아니고 EACCES 로 못 연 파일이 있으며 root · systemd-journal ·
 *     저널 ACL 그룹이 아닐 때만 ‘Hint: You are currently not seeing messages from …’ 을 찍는다 → #perm=own(자기 저널만 — 시스템 메시지는 못 본다).
 *     연 파일이 하나도 없으면 ‘No journal files were opened due to insufficient permissions.’ → #perm=none · 파일이 아예 없으면 ‘No journal files were found.’ → #nofiles.
 *     힌트가 없으면(위 원문 조건) 볼 수 있는 저널을 다 본 것이다. 보조 근거로 수집 계정 uid · 소속(systemd-journal · adm · wheel 중)을 #uid · #grp 로 싣는다(화면 안내용).
 *   표지 줄(‘-- Logs begin …’ · ‘-- No entries --’)은 버린다.
 */
function journalShell({ prefix, cap, pos, args }) {
  return [
    'if command -v journalctl >/dev/null 2>&1; then',
    `echo "${prefix}#uid=$(id -u 2>/dev/null | cut -c1-10)"; echo "${prefix}#grp=$(id -nG 2>/dev/null | tr ' ' '\\n' | grep -E -x 'systemd-journal|adm|wheel' | head -n 3 | tr '\\n' ',' | cut -c1-40)"`,
    `{ timeout 15 journalctl --no-pager -o json ${OUTPUT_FIELDS} ${args} ${pos} 2>&1; echo "@rc=$?"; } |`,
    `awk -v cap=${cap} -v bud=${SRC_BYTES} -v w=${JSON_WIDTH} -v p=${prefix} 'BEGIN{t=0;e=0;b=0;er=0;rc="";cur=""} /^@rc=/{rc=substr($0,5);next}`,
    // 커서 · 단조 시각 · boot_id 는 내보내는 줄에서 뺀다(파서는 쓰지 않는다 — 출처 바이트 상한 안에 줄을 더 싣는다). 커서 값에는 따옴표가 없다(s=…;x=… 16진).
    '/^\\{/{t++; i=index($0,"\\"__CURSOR\\":\\""); if(i>0){s=substr($0,i+12,200); j=index(s,"\\""); if(j>1) cur=substr(s,1,j-1)}',
    'l=$0; sub(/"__CURSOR":"[^"]*",?/,"",l); sub(/"__MONOTONIC_TIMESTAMP":"[0-9]*",?/,"",l); sub(/"_BOOT_ID":"[0-9a-f]*",?/,"",l); l=substr(l,1,w);',
    'if(e<cap && b+length(l)+3<=bud){print p "|" l; e++; b+=length(l)+3} next}',
    '/^Hint: You are currently not seeing messages/{print p "#perm=own"; next} /^No journal files were opened due to insufficient permissions/{print p "#perm=none"; next}',
    '/^No journal files were found/{print p "#nofiles"; next} /^-- /{next} /^[ \\t]/{next}',
    `{if(!er){print p "#err"; er=1}} END{if(cur!="") print p "#cur=" cur; print p "#n=" t; print p "#e=" e; print p "#rc=" rc}'`,
    'else',
    `echo '${prefix}#absent'`,
    'fi',
  ];
}

/**
 * 로그 읽기 명령(한 서버 · 한 주기). state = 직전 커서(log_cursor.state_json 의 읽기 위치 부분) — 화이트리스트를 통과한 값만 쓴다.
 * @param {{journal?:{cursor?:string}, jsec?:{cursor?:string}, kernel?:{boot?:string, last?:string}, secure?:{ino?:string, off?:string}, audit?:{ino?,off?}, apps?:{[id]:{dir?:number, ino?:string, off?:string}}}} state
 * @param {{lineCap?:number, _paths?:object}} o  _paths 는 **테스트 전용**(임시 파일로 실제 셸을 돌려 본다 — 설정 · 라우트 경로에서 넘기는 곳이 없다: 소스 스윕이 고정)
 */
export function logCommand(state = {}, { lineCap = LINE_CAP_DEFAULT, _paths = null } = {}) {
  const cap = Math.max(LINE_CAP_RANGE[0], Math.min(LINE_CAP_RANGE[1], Math.floor(Number(lineCap) || LINE_CAP_DEFAULT)));
  const P = { secure: SECURE_FILE, audit: AUDIT_FILE, apps: APP_LOGS, bootId: '/proc/sys/kernel/random/boot_id', uptime: '/proc/uptime', ...(_paths || {}) };
  const st = state && typeof state === 'object' ? state : {};
  const posOf = (c) => { const cur = ok(CURSOR_RE, c); return cur ? `--after-cursor=${sq(cur)}` : `--since=-${FIRST_SINCE_MIN}min`; };
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
    // ── journald(우선순위 warning 이상 · 커널 전송 제외 — 커널은 dmesg 가 읽는다) ─────────────
    "echo '##JOURNAL'",
    ...journalShell({ prefix: 'J', cap, pos: posOf(st.journal?.cursor), args: '-p warning _TRANSPORT=journal _TRANSPORT=syslog _TRANSPORT=stdout' }),
    // ── journald 보안(sshd · sudo · su · 계정 도구 — 우선순위 info 이상: sshd 실패 · 성공은 info 라 위 읽기에 안 들어온다 · 반증 F1) ─────
    "echo '##JSEC'",
    ...journalShell({ prefix: 'Q', cap, pos: posOf(st.jsec?.cursor), args: `-p info ${AUTH_IDENTS.map((x) => `SYSLOG_IDENTIFIER=${x}`).join(' ')}` }),
    // ── dmesg(커널 링 버퍼) — boot_id 가 같으면 마지막 [초] 이후 줄만 · 첫 읽기는 가동 마지막 60분만(반증 F6) ─────
    "echo '##DMESG'",
    'if command -v dmesg >/dev/null 2>&1; then',
    `{ timeout 5 dmesg -x --level=emerg,alert,crit,err,warn 2>&1; echo "@rc=$?"; } |`,
    `awk -v cap=${cap} -v bud=${SRC_BYTES} -v w=${LINE_WIDTH} -v fw=${FIRST_SINCE_MIN * 60} -v boot="$(cut -c1-36 ${sq(P.bootId)} 2>/dev/null)" -v lboot=${sq(boot)} -v last=${sq(last || '-1')} -v up="$(cut -d' ' -f1 ${sq(P.uptime)} 2>/dev/null)" -v now="$(date +%s 2>/dev/null)" \\`,
    `'BEGIN{t=0;e=0;b=0;old=0;mx=-1;rc="";perm=0;same=(boot!="" && boot==lboot);first=(lboot=="");lo=-1;if(first){if(up+0>0) lo=up-fw; else lo=1e18}} /^@rc=/{rc=substr($0,5);next} /^dmesg: /{if($0 ~ /not permitted|Permission denied/) perm=1; next}`,
    '{s=substr($0,1,60); i=index(s,"["); j=index(s,"]"); ts=-1; if(i>0 && j>i) ts=substr(s,i+1,j-i-1)+0; if(ts<0) next; if(ts>mx) mx=ts; if(same && ts<=last+0) next; if(first && ts<lo){old++; next}',
    't++; l=substr($0,1,w); if(e<cap && b+length(l)+3<=bud){print "K|" l; e++; b+=length(l)+3}}',
    `END{print "K#boot=" boot; if(mx>=0) printf "K#last=%.6f\\n", mx; else if(same) print "K#last=" last; else print "K#last=-1"; print "K#up=" up; print "K#now=" now; print "K#n=" t; print "K#e=" e; if(first) print "K#first=" old; if(perm) print "K#perm"; print "K#rc=" rc}'`,
    'else',
    "echo 'K#absent'",
    'fi',
    // ── /var/log/secure — offset + inode ──────────────────────────────────────
    "echo '##SECURE'",
    // rsyslog 활성 여부(secure 에 새 줄이 쌓이는지 — 멈췄으면 보안 줄은 journald 쪽을 쓴다: parse.js pickAuthSource)
    `echo "S#svc=$(timeout 3 systemctl is-active rsyslog 2>/dev/null | head -n 1 | cut -c1-16)"`,
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
      // 폴더 후보 중 처음 읽을 수 있는 것 · 그 안 glob 의 가장 최근 파일(ls -t). 파일 이름은 줄 머리에 오지 않는다(폴더 번호만 G#dir= 로).
      //   후보가 있는데 못 들어가거나(0700) 경로 중간이 막혔으면(상위 폴더 탐색 권한 없음) ‘권한 없음’ — 있는지 모른다(반증 F3).
      //   후보 = ‘번호:뿌리:경로’(상수 — 콜론 · 공백 없는 경로). 뿌리보다 위(/root · /home 등 공용 상위)가 막힌 것은 그 앱의 권한 문제가 아니다 — ‘없음’.
      const dirs = a.dirs.map((d, i) => { const x = typeof d === 'string' ? { path: d, anchor: d } : d; return `${i}:${x.anchor}:${x.path}`; }).join(' ');
      return [
        `ad=''; ai=''; blk=0; for x in ${dirs}; do i="\${x%%:*}"; r="\${x#*:}"; an="\${r%%:*}"; d="\${r#*:}"; if [ -d "$d" ]; then if [ -r "$d" ] && [ -x "$d" ]; then ad="$d"; ai="$i"; break; else blk=1; fi;`,
        'else q="${d%/*}"; while [ -n "$q" ] && [ "${#q}" -ge "${#an}" ]; do if [ -d "$q" ]; then if [ ! -x "$q" ] || [ ! -r "$q" ]; then blk=1; fi; break; fi; q="${q%/*}"; done; fi; done',
        'if [ -z "$ad" ]; then',
        `if [ "$blk" = 1 ]; then echo '${a.prefix}#perm=dir'; else echo '${a.prefix}#absent'; fi`,
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
