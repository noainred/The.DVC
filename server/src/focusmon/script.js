/**
 * focusmon/script.js — 대상 서버(리눅스 · RHEL 7.8 기준)에서 도는 **고정 수집 스크립트**(v2.976 집중 모니터링).
 *
 * ── 명령은 상수다(docs/rules/security-api.md v2.923 스냅샷 규약 ① 과 같은 원칙) ──────────────────────
 *  허용 주기(1 · 2 · 5 · 10초)마다 미리 만든 **문자열 상수** 하나를 고른다. 서버 이름 · 주소 · 계정 · 사용자 입력 · 장치 이름 ·
 *  설정값 어느 것도 명령에 들어가지 않는다(테스트가 네 상수를 글자 그대로 고정한다). 주기 밖 값은 2초 상수로 간다.
 *
 * ── 하는 일 ──────────────────────────────────────────────────────────────────────────────────────────
 *  · `##HELLO` 한 번(커널 · /etc/redhat-release · CLK_TCK · 페이지 크기 · 코어 수 · hidepid · 호스트 이름) 뒤
 *    `I` 초마다 `##T <uptime> <epoch>` · `##STAT` · `##LOAD` · `##MEM` · `##NET` · `##DISK` 를 찍고 `##END` 로 닫는다.
 *  · 30초마다 `##NETTOPO`(인터페이스 속도 · 상태 · 물리 여부 · 본딩 구성) · `##BLK`(lsblk — 디스크 › 파티션 › LVM › 마운트) · `##PS`(pid → 사용자).
 *  · 약 5초마다 `##PROC`(프로세스별 누적 CPU 시간 · 스레드 · 시작 · RSS · **comm 만** — v2.981 부터 부모 · 사용자/커널 시간 · nice · 가상 메모리 ·
 *    major fault · 디스크 대기 tick · 상태도 같은 /proc/<pid>/stat 줄에서) · `##IO`(v2.981 — /proc/<pid>/io 읽기 · 쓰기 바이트, **읽을 수 있는 것만**:
 *    그 프로세스의 계정 또는 root 만 읽는다 — 못 읽으면 줄이 없고 화면은 '읽을 수 없음').
 *  · 30초마다 `##UNIT`(v2.981 — pid → systemd 서비스 이름, /proc/<pid>/cgroup 의 systemd 줄. 누구나 읽는다 — 같은 java 라도 무슨 프로그램인지).
 *  · 30초마다 프레임 끝에 `##SELF`(v2.983 수집 부하 — 사용자 '엣지노드와 수집 대상 서버에 부하를 얼마나 주는지'): 이 반복문 셸 자신(/proc/$$/stat — 끝난 자식 포함)과
 *    sshd 세션(/proc/$PPID/stat)의 stat 줄 ')' 뒤 칸 · 세 묶음(기본 지표 · 구성 · 프로세스)의 누적 CPU tick. 묶음 tick 은 묶음 뒤에서 **셸 내장 명령만**(read · set · 산술 —
 *    포크 없음)으로 /proc/$$/stat 를 읽어 더한다. 실측(2026-11-12 이 컨테이너 · 1초 주기 · 60초 × 4회): 계측 없는 판과 tick 오차(±2) 안에서 구분되지 않았다(사용자 선택 '늘 잼 · 세 묶음').
 *
 * ── 지키는 것 ────────────────────────────────────────────────────────────────────────────────────────
 *  · **읽기 전용**: /proc · /sys 를 읽고 lsblk · ps 를 부를 뿐 — 파일을 만들지 않는다 · 설치하지 않는다 · 리다이렉트는 /dev/null 만.
 *  · **sudo · su 0** · 권한 없는 사용자 계정으로 돈다(이 값들은 누구나 읽는다). `hidepid` 로 남의 프로세스가 안 보이면 HELLO 가 그 사실을 말한다.
 *  · **프로세스 인자 · 환경 0** — 이름은 /proc/<pid>/stat 의 comm 만(cmdline · environ 금지 — 인자에 비밀번호가 흔하다). ps 는 pid · 사용자만.
 *    comm 은 awk 가 안전한 글자로 바꾼다(그 밖 → `_`) — 표지 위조 · 줄 깨기가 구조적으로 없다.
 *  · **awk getline 으로 /proc 을 읽지 않는다**(mawk 가 사라진 파일에서 멈춘다 — 8b 규약). `grep -H … 2>/dev/null | awk` 로 읽는다(v2.981 — pid 는 파일 경로에서).
 *  · **데이터 줄은 `##` 로 시작하지 않는다** — 인터페이스 줄은 `i ` 접두, lsblk 는 `NAME=`, /proc 줄은 공백 · 글자 · 숫자로 시작한다.
 *    표지는 파서가 정확 일치로만 받는다(parse.js).
 *  · **출력 상한** — 구획마다 `head -n` = 파서 상한 + 1(넘친 한 줄로 파서가 ‘잘림’ 을 안다 — 같으면 잘려도 몰랐다). 줄 상한은 collector 가 execStream 에 LINE_MAX + 64 로 준다 · 프레임 글자 상한 parse.FRAME_MAX_CHARS.
 *  · **스스로 끝난다** — 6시간치 반복 뒤 exit(채널이 끊겼는데 남은 반복문이 오래 살지 않게). 수집기가 다시 연다.
 *    채널이 닫히면 다음 echo 가 SIGPIPE 로 죽으므로 보통은 다음 주기 안에 끝난다.
 */

/** 허용 주기(초). 화면 · API · 엣지가 이 목록 밖 값을 쓰지 않는다. */
export const INTERVALS = Object.freeze([1, 2, 5, 10]);
export const DEFAULT_INTERVAL = 2;
/** 프로세스 표본 주기(초) 기본값 — 지표 주기가 이보다 길면 지표 주기마다. v2.983 부터 설정으로 고른다(`PROC_EVERY_CHOICES`). */
export const PROC_EVERY_S = 5;
/** 프로세스 표본 주기 선택지(v2.983 시안 ⑪ 컨펌 ④ — 큰 서버의 부하를 줄이는 손잡이). 이 목록 밖 값은 기본값으로. */
export const PROC_EVERY_CHOICES = Object.freeze([5, 15, 30]);
/** 구성(본딩 · 블록 · ps 사용자) 주기(초). */
export const TOPO_EVERY_S = 30;
/** 한 번 연 반복문의 수명(초) — 넘으면 스스로 끝나고 수집기가 다시 연다. */
export const LOOP_LIFE_S = 6 * 3600;

/**
 * 프로세스 줄: `pid ticks threads starttime rssPages comm ppid utime stime nice vsizeBytes majflt blkioTicks state` — comm 은 안전한 글자만(그 밖은 `_` · 비면 `_`).
 * 마지막 ')' 뒤를 필드로 자른다(f[k] = stat 의 k+2 번째 칸). v2.981 이 comm 뒤에 8칸을 더했다(파서는 옛 6칸 줄도 읽는다).
 * 디스크 대기 tick(42번째 칸 delayacct_blkio_ticks)은 칸이 없으면 '-'. 모두 같은 /proc/<pid>/stat 한 줄이라 더 읽는 파일이 없다.
 * ⚠ v2.981 반증 F2(재현): comm 에는 줄바꿈도 넣을 수 있다(prctl PR_SET_NAME) — `cat` 으로 읽으면 한 stat 이 두 줄이 되고 뒷줄이 `1234 (sshd) …` 처럼
 *   다른 pid 행으로 읽혔다(v2.976 부터). 이제 `grep -H` 로 읽어 **pid 는 파일 경로에서** 뽑고, 같은 파일의 줄은 `_` 로 이어 붙인 뒤 첫 칸이 그 pid 일 때만 받는다
 *   (위조 줄은 이름 안의 글자로 남고 · 프로세스는 숨지 않는다). 함수 e 는 stdin 버퍼만 본다 — getline 아님.
 */
const PROC_AWK = 'awk \'function e(  s,p,q,o,c,n,f,a,sp){if(cf!~/^\\/proc\\/[0-9]+\\/stat$/)return;split(cf,a,"/");s=bf;sp=index(s," ");'
  + 'if(sp<2||substr(s,1,sp-1)!=a[3])return;p=0;while((q=index(substr(s,p+1),")"))>0)p+=q;o=index(s,"(");if(o<1||p<=o)return;'
  + 'c=substr(s,o+1,p-o-1);gsub(/[^A-Za-z0-9._:@+-]/,"_",c);if(c=="")c="_";n=split(substr(s,p+2),f," ");if(n<22)return;'
  + 'print a[3],f[12]+f[13],f[18],f[20],f[22],c,f[2],f[12],f[13],f[17],f[21],f[10],(n>=40?f[40]:"-"),f[1]}'
  + '{k=index($0,":");if(k<2)next;fp=substr($0,1,k-1);if(fp!=cf){if(cf!="")e();cf=fp;bf=substr($0,k+1)}else bf=bf "_" substr($0,k+1)}END{if(cf!="")e()}\'';
/**
 * 서비스 줄(v2.981): `pid unit` — /proc/<pid>/cgroup 의 systemd 줄(cgroup v1 `N:name=systemd:/…` · v2 `0::/…`) 경로에서 .service · .scope 로 끝나는
 * **첫** 칸(시스템 수준 — 반증 F5: 마지막 칸을 고르면 사용자 유닛 `user@1000.service/app.slice/sshd.service` 가 sshd.service 로 위조됐다).
 * 경로는 세 번째 ':' 뒤 전부(이름 안의 ':' 를 자르지 않는다). 안전한 글자만(그 밖은 `_`) · 96자. 서비스가 없는 프로세스(커널 스레드)는 줄을 내지 않는다.
 * 입력은 grep 출력(stdin)이다 — getline 아님.
 */
const UNIT_AWK = 'awk -F: \'{split($1,a,"/");p=a[3];if(p!~/^[0-9]+$/)next;x=substr($0,length($1)+length($2)+length($3)+4);n=split(x,b,"/");u="";'
  + 'for(i=1;i<=n;i++)if(b[i]~/\\.(service|scope)$/){u=b[i];break}if(u=="")next;gsub(/[^A-Za-z0-9@._:-]/,"_",u);print p,substr(u,1,96)}\'';
/** 입출력 줄(v2.981): `pid readBytes writeBytes` — grep 이 읽을 수 있었던 /proc/<pid>/io 두 줄을 하나로. 읽기 · 쓰기 둘 다 있을 때만. */
const IO_AWK = 'awk \'{split($1,a,"/");p=a[3];if(p!~/^[0-9]+$/)next;if(index($1,"read_bytes"))r[p]=$2;else w[p]=$2}END{for(p in r)if(p in w)print p,r[p],w[p]}\'';

/**
 * v2.983 묶음 tick — 셸 내장 명령만(포크 없음): /proc/$$/stat 의 ')' 뒤 칸에서 utime · stime · cutime · cstime(셸 자신 + 끝난 자식) 합.
 * 함수 안의 set -- 는 그 함수의 위치 인자만 바꾼다(bash · dash). 못 읽으면 CK 는 앞 값 그대로(0 으로 떨어지지 않게 — 묶음 차이가 음수가 되지 않는다).
 */
const CK_FN = 'ck() { read -r x 2>/dev/null </proc/$$/stat || return 0; set -- ${x##*) }; [ $# -ge 15 ] && CK=$(( ${12} + ${13} + ${14} + ${15} )); }';
/** 묶음 뒤에 붙이는 한 줄 — 앞 표시(L)부터의 tick 을 그 묶음 누적(CB · CC · CP)에 더한다. */
const ckAdd = (v, ind) => `${ind}ck; ${v}=$((${v} + CK - L)); L=$CK`;

function build(I, PE = PROC_EVERY_S) {
  const topoEvery = Math.max(1, Math.round(TOPO_EVERY_S / I));
  const maxN = Math.max(1, Math.floor(LOOP_LIFE_S / I));
  return [
    'LC_ALL=C; export LC_ALL',
    `I=${I}; P=${PE}; TE=${topoEvery}; MAXN=${maxN}`,
    "echo '##HELLO 1'",
    'echo "uname $(uname -srm 2>/dev/null)"',
    'echo "rel $(head -n 1 /etc/redhat-release 2>/dev/null)"',
    'echo "tck $(getconf CLK_TCK 2>/dev/null)"',
    'echo "page $(getconf PAGESIZE 2>/dev/null)"',
    'echo "ncpu $(grep -c ^processor /proc/cpuinfo 2>/dev/null)"',
    'echo "hidepid $(grep -c hidepid /proc/mounts 2>/dev/null)"',
    // v2.981 디스크 대기(지연 집계): 5.14 이후 커널은 sysctl 로 켜고 끈다(기본 꺼짐) · 그 전(RHEL 7)은 sysctl 이 없고 nodelayacct 부트 옵션이 없으면 켜짐.
    //   /proc/cmdline(커널 부트 줄)은 grep -c 로 개수만 센다 — 내용을 내보내지 않는다.
    'echo "dacct $(cat /proc/sys/kernel/task_delayacct 2>/dev/null || echo -) $(grep -c nodelayacct /proc/cmdline 2>/dev/null)"',
    'echo "host $(hostname 2>/dev/null)"',
    "echo '##END'",
    CK_FN,
    'CK=0; ck; L=$CK; CB=0; CC=0; CP=0',
    'n=0',
    'while [ $n -lt $MAXN ]; do',
    '  echo "##T $(cut -d" " -f1 /proc/uptime) $(date +%s)"',
    "  echo '##STAT'; grep -E '^(cpu[0-9]* |procs_running |procs_blocked )' /proc/stat 2>/dev/null | head -n 1101",
    "  echo '##LOAD'; cat /proc/loadavg 2>/dev/null",
    "  echo '##MEM'; head -n 129 /proc/meminfo 2>/dev/null",
    "  echo '##NET'; head -n 259 /proc/net/dev 2>/dev/null",
    "  echo '##DISK'; head -n 1025 /proc/diskstats 2>/dev/null",
    ckAdd('CB', '  '),
    '  if [ $((n % TE)) -eq 0 ]; then',
    "    echo '##NETTOPO'",
    '    for d in /sys/class/net/*; do',
    '      x="${d##*/}"; [ "$x" = lo ] && continue',
    '      s=$(cat "$d/speed" 2>/dev/null); [ -n "$s" ] || s=-1',
    '      o=$(cat "$d/operstate" 2>/dev/null); [ -n "$o" ] || o=unknown',
    '      p=0; [ -e "$d/device" ] && p=1',
    '      m=-; [ -L "$d/master" ] && m=$(readlink "$d/master" 2>/dev/null) && m="${m##*/}"',
    '      b=-; sl=-; a=-',
    '      if [ -d "$d/bonding" ]; then b=$(cut -d" " -f1 "$d/bonding/mode" 2>/dev/null); sl=$(tr " " "," < "$d/bonding/slaves" 2>/dev/null); a=$(cat "$d/bonding/active_slave" 2>/dev/null); fi',
    '      echo "i $x $s $o $p ${m:--} ${b:--} ${sl:--} ${a:--}"',
    '    done 2>/dev/null | head -n 257',
    "    echo '##BLK'; lsblk -P -b -o NAME,KNAME,PKNAME,TYPE,SIZE,MOUNTPOINT 2>/dev/null | head -n 513",
    "    echo '##PS'; ps -e -o pid=,user:32= 2>/dev/null | head -n 20001",
    // v2.981 반증 F1: /proc/<pid>/io · cgroup 읽기는 커널 잠금(옛 커널 io = cred_guard_mutex — exec 중에 잡힌다)에서 기다릴 수 있다 → 시한(SIGKILL)으로 감싸
    //   한 프로세스 때문에 프레임 전체(##END)가 멈추지 않게. 수집 계정이 root · 앱 계정일 때만 남의 io 를 연다(전용 계정은 open 에서 EACCES).
    `    echo '##UNIT'; timeout -s KILL 5 grep -H -m1 -E ':name=systemd:|^0::' /proc/[0-9]*/cgroup 2>/dev/null | ${UNIT_AWK} | head -n 20001`,
    ckAdd('CC', '    '),
    '  fi',
    '  if [ $(( (n * I) % P )) -lt $I ]; then',
    `    echo '##PROC'; grep -H '' /proc/[0-9]*/stat 2>/dev/null | ${PROC_AWK} | head -n 20001`,
    `    echo '##IO'; timeout -s KILL 3 grep -H -E '^(read_bytes|write_bytes):' /proc/[0-9]*/io 2>/dev/null | ${IO_AWK} | head -n 20001`,
    ckAdd('CP', '    '),
    '  fi',
    // v2.983 수집 부하 — 30초마다 프레임 끝에 셸 자신(s) · sshd 세션(p)의 stat ')' 뒤 칸과 세 묶음 누적 tick(c). 내장 명령만(read · echo).
    //   ')' 뒤만 내보낸다 — 이름 칸(comm)은 싣지 않는다. 못 읽으면 그 줄은 빈 칸(파서가 버린다).
    '  if [ $((n % TE)) -eq 0 ]; then',
    "    echo '##SELF'",
    '    read -r x 2>/dev/null </proc/$$/stat && echo "s ${x##*) }"',
    '    read -r x 2>/dev/null </proc/$PPID/stat && echo "p ${x##*) }"',
    '    echo "c $CB $CC $CP"',
    '  fi',
    "  echo '##END'",
    '  n=$((n + 1))',
    '  sleep $I',
    'done',
  ].join('\n');
}

/** 주기 → 명령 상수(프로세스 표본 주기 기본 5초). 만들고 나서 얼린다. */
export const SCRIPTS = Object.freeze(Object.fromEntries(INTERVALS.map((i) => [i, build(i)])));
/** v2.983 (주기, 프로세스 표본 주기) → 명령 상수 — 열쇠 'I/P'. 4 × 3 = 12개, 모두 미리 만든 상수(사용자 값이 명령에 들어가지 않는다). */
export const SCRIPT_TABLE = Object.freeze(Object.fromEntries(INTERVALS.flatMap((i) => PROC_EVERY_CHOICES.map((p) => [`${i}/${p}`, p === PROC_EVERY_S ? SCRIPTS[i] : build(i, p)]))));

/** 주기 정규화 — 목록 밖은 기본값. */
export function normInterval(v) {
  const n = Number(v);
  return INTERVALS.includes(n) ? n : DEFAULT_INTERVAL;
}
/** 프로세스 표본 주기 정규화 — 목록 밖은 기본값(5초). */
export function normProcEvery(v) {
  const n = Number(v);
  return PROC_EVERY_CHOICES.includes(n) ? n : PROC_EVERY_S;
}

/** 주기(+ 프로세스 표본 주기)에 맞는 명령 상수(사용자 입력이 들어갈 자리가 없다 — 표에서 고를 뿐). */
export function scriptFor(interval, procEvery = PROC_EVERY_S) { return SCRIPT_TABLE[`${normInterval(interval)}/${normProcEvery(procEvery)}`]; }
