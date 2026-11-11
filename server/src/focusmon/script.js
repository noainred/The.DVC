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
 *  · 약 5초마다 `##PROC`(프로세스별 누적 CPU 시간 · 스레드 · 시작 · RSS · **comm 만**).
 *
 * ── 지키는 것 ────────────────────────────────────────────────────────────────────────────────────────
 *  · **읽기 전용**: /proc · /sys 를 읽고 lsblk · ps 를 부를 뿐 — 파일을 만들지 않는다 · 설치하지 않는다 · 리다이렉트는 /dev/null 만.
 *  · **sudo · su 0** · 권한 없는 사용자 계정으로 돈다(이 값들은 누구나 읽는다). `hidepid` 로 남의 프로세스가 안 보이면 HELLO 가 그 사실을 말한다.
 *  · **프로세스 인자 · 환경 0** — 이름은 /proc/<pid>/stat 의 comm 만(cmdline · environ 금지 — 인자에 비밀번호가 흔하다). ps 는 pid · 사용자만.
 *    comm 은 awk 가 안전한 글자로 바꾼다(그 밖 → `_`) — 표지 위조 · 줄 깨기가 구조적으로 없다.
 *  · **awk getline 으로 /proc 을 읽지 않는다**(mawk 가 사라진 파일에서 멈춘다 — 8b 규약). `cat … 2>/dev/null | awk` 로 읽는다.
 *  · **데이터 줄은 `##` 로 시작하지 않는다** — 인터페이스 줄은 `i ` 접두, lsblk 는 `NAME=`, /proc 줄은 공백 · 글자 · 숫자로 시작한다.
 *    표지는 파서가 정확 일치로만 받는다(parse.js).
 *  · **출력 상한** — 구획마다 `head -n` = 파서 상한 + 1(넘친 한 줄로 파서가 ‘잘림’ 을 안다 — 같으면 잘려도 몰랐다). 줄 상한은 collector 가 execStream 에 LINE_MAX + 64 로 준다 · 프레임 글자 상한 parse.FRAME_MAX_CHARS.
 *  · **스스로 끝난다** — 6시간치 반복 뒤 exit(채널이 끊겼는데 남은 반복문이 오래 살지 않게). 수집기가 다시 연다.
 *    채널이 닫히면 다음 echo 가 SIGPIPE 로 죽으므로 보통은 다음 주기 안에 끝난다.
 */

/** 허용 주기(초). 화면 · API · 엣지가 이 목록 밖 값을 쓰지 않는다. */
export const INTERVALS = Object.freeze([1, 2, 5, 10]);
export const DEFAULT_INTERVAL = 2;
/** 프로세스 표본 주기(초) — 지표 주기가 이보다 길면 지표 주기마다. */
export const PROC_EVERY_S = 5;
/** 구성(본딩 · 블록 · ps 사용자) 주기(초). */
export const TOPO_EVERY_S = 30;
/** 한 번 연 반복문의 수명(초) — 넘으면 스스로 끝나고 수집기가 다시 연다. */
export const LOOP_LIFE_S = 6 * 3600;

/** 프로세스 줄: `pid ticks threads starttime rssPages comm` — comm 은 안전한 글자만(그 밖은 `_`). 마지막 ')' 뒤를 필드로 자른다. */
const PROC_AWK = 'awk \'{s=$0;p=0;while((q=index(substr(s,p+1),")"))>0)p+=q;o=index(s,"(");if(o<1||p<=o)next;'
  + 'c=substr(s,o+1,p-o-1);gsub(/[^A-Za-z0-9._:@+-]/,"_",c);n=split(substr(s,p+2),f," ");if(n<22)next;'
  + 'print $1,f[12]+f[13],f[18],f[20],f[22],c}\'';

function build(I) {
  const topoEvery = Math.max(1, Math.round(TOPO_EVERY_S / I));
  const maxN = Math.max(1, Math.floor(LOOP_LIFE_S / I));
  return [
    'LC_ALL=C; export LC_ALL',
    `I=${I}; P=${PROC_EVERY_S}; TE=${topoEvery}; MAXN=${maxN}`,
    "echo '##HELLO 1'",
    'echo "uname $(uname -srm 2>/dev/null)"',
    'echo "rel $(head -n 1 /etc/redhat-release 2>/dev/null)"',
    'echo "tck $(getconf CLK_TCK 2>/dev/null)"',
    'echo "page $(getconf PAGESIZE 2>/dev/null)"',
    'echo "ncpu $(grep -c ^processor /proc/cpuinfo 2>/dev/null)"',
    'echo "hidepid $(grep -c hidepid /proc/mounts 2>/dev/null)"',
    'echo "host $(hostname 2>/dev/null)"',
    "echo '##END'",
    'n=0',
    'while [ $n -lt $MAXN ]; do',
    '  echo "##T $(cut -d" " -f1 /proc/uptime) $(date +%s)"',
    "  echo '##STAT'; grep -E '^(cpu[0-9]* |procs_running |procs_blocked )' /proc/stat 2>/dev/null | head -n 1101",
    "  echo '##LOAD'; cat /proc/loadavg 2>/dev/null",
    "  echo '##MEM'; head -n 129 /proc/meminfo 2>/dev/null",
    "  echo '##NET'; head -n 259 /proc/net/dev 2>/dev/null",
    "  echo '##DISK'; head -n 1025 /proc/diskstats 2>/dev/null",
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
    '  fi',
    '  if [ $(( (n * I) % P )) -lt $I ]; then',
    `    echo '##PROC'; cat /proc/[0-9]*/stat 2>/dev/null | ${PROC_AWK} | head -n 20001`,
    '  fi',
    "  echo '##END'",
    '  n=$((n + 1))',
    '  sleep $I',
    'done',
  ].join('\n');
}

/** 주기 → 명령 상수. 만들고 나서 얼린다. */
export const SCRIPTS = Object.freeze(Object.fromEntries(INTERVALS.map((i) => [i, build(i)])));

/** 주기 정규화 — 목록 밖은 기본값. */
export function normInterval(v) {
  const n = Number(v);
  return INTERVALS.includes(n) ? n : DEFAULT_INTERVAL;
}

/** 주기에 맞는 명령 상수(사용자 입력이 들어갈 자리가 없다). */
export function scriptFor(interval) { return SCRIPTS[normInterval(interval)]; }
