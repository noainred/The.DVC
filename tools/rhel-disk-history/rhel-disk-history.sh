#!/bin/bash
# rhel-disk-history.sh — RHEL 서버 디스크 과거 장애 이력 점검(읽기 전용 · 독립 실행)
#
# 무엇을 하나
#   남아 있는 로그(journal · /var/log/messages* 압축 포함 · dmesg)와 디스크가 스스로 들고 있는 누적값
#   (smartctl) · RAID 컨트롤러 기록(storcli/perccli)을 모아 세 가지를 판정한다.
#     ① 과거 bad sector / I/O / media error 발생 여부
#     ② 포맷 후 재사용 정황
#     ③ 과거 장애 디스크가 교체되어 지금은 없는지(시리얼 / WWN 기준)
#   판정마다 확정 / 추정 / 불명 과 근거 줄, 틀릴 수 있는 경우를 붙인다.
#
# 읽기 전용
#   디스크 · 설정 · 서비스 상태를 바꾸는 명령을 쓰지 않는다. 쓰는 것은 결과 파일(--output-dir)과
#   작업용 임시 폴더(/dev/shm, 끝나면 지움)뿐이다. 외부 명령은 run_cmd() 하나를 거치고,
#   ro_guard() 가 상태를 바꾸는 인자(smartctl -t/-s/-X, storcli 의 show 가 아닌 동사 등)를 막는다.
#
# 요구 환경
#   RHEL 7 · 8 · 9, bash 4.2 이상, GNU awk(gawk 4.0 이상 — RHEL 의 /usr/bin/awk), coreutils, grep, sed.
#   bash 4.3+ 전용 문법(declare -n · wait -n · mapfile -d · ${v@Q} · 음수 배열 대입)은 쓰지 않는다.
#   set -u 를 쓰지 않는다(bash 4.2 는 빈 배열 "${a[@]}" 를 unbound 로 처리한다).
#
# 실서버 미검증(2026-11-14 작성 시점)
#   가짜 로그 · 가짜 명령으로만 시험했다. 커널 문구 · smartctl · storcli 출력 형식은 공개 소스 · 문서에
#   대한 기억으로 적은 것이라 실제 장비 출력과 다를 수 있다. 패턴마다 근거와 확인 수준을 주석에 적었다.

VERSION="1.0.0"
PROG="${0##*/}"

# 터미널 문자셋은 LC_ALL=C 로 덮어쓰기 전에 봐 둔다(화면이 UTF-8 이 아니면 한글이 깨진다).
ORIG_CTYPE="${LC_ALL:-${LC_CTYPE:-${LANG:-}}}"
export LC_ALL=C LANG=C
umask 077

# ── 옵션 기본값 ────────────────────────────────────────────────────────────────
OUTDIR=""              # 결과 저장 위치(비우면 /root/rhel-disk-history, root 가 아니면 $HOME/rhel-disk-history)
SAVE_RAW=0             # 명령 원본 출력(smartctl · storcli · lsblk …)을 결과 옆 폴더에 남긴다
USE_SMART=1
USE_RAID=1
USE_JOURNAL=1
USE_HISTORY=1          # /root/.bash_history 에서 포맷 계열 명령 줄만 찾는다
REQUIRE_ROOT=0
QUIET=0
CMD_TIMEOUT=60         # 일반 명령 1개당 시한(초)
LONG_TIMEOUT=600       # journalctl · 컨트롤러 이벤트 로그 시한(초)
MAX_EVIDENCE=30        # 장치 1개당 결과 파일에 싣는 근거 줄 수
EXTRA_LOGS=()
R="${RDH_ROOT:-}"      # 시험 · 다른 루트 분석용 접두어(평소에는 빈 값). 파일 경로에만 붙는다.

usage() {
  cat <<EOF
$PROG $VERSION — RHEL 디스크 과거 장애 이력 점검(읽기 전용)

사용법: $PROG [옵션]

  -o, --output-dir DIR   결과 파일 저장 위치(기본: /root/rhel-disk-history · root 가 아니면 \$HOME 아래)
                         쓸 수 없으면 /dev/shm → /tmp 순으로 바꿔 쓰고 그 사실을 알린다.
      --save-raw         명령 원본 출력을 결과 옆 폴더(…_raw/)에 남긴다(처음 돌릴 때 권장 — 형식 대조용)
      --extra-log FILE   추가로 분석할 로그 파일(여러 번 가능 · gz/xz/bz2 가능)
      --no-smart         smartctl 을 실행하지 않는다
      --no-raid          storcli / perccli 를 실행하지 않는다
      --no-journal       journalctl 을 읽지 않는다
      --no-history       /root/.bash_history 를 보지 않는다
      --require-root     root 가 아니면 진행하지 않고 끝낸다(기본: 읽을 수 있는 것만 진행)
      --timeout SEC      일반 명령 1개 시한(기본 $CMD_TIMEOUT)
      --long-timeout SEC journalctl · 컨트롤러 이벤트 로그 시한(기본 $LONG_TIMEOUT)
      --max-evidence N   장치 1개당 결과 파일에 싣는 근거 줄 수(기본 $MAX_EVIDENCE)
  -q, --quiet            화면에는 결과 파일 경로만 낸다
  -h, --help             이 도움말
      --version          버전

종료 코드: 0 = 근거 구간 안에 오류 기록 없음 · 10 = 추정만 있음 · 20 = 확정 있음 ·
           2 = 사용법 오류 · 3 = 실행 불가(필수 도구 없음 · --require-root 인데 root 아님)
EOF
}

die() { printf '%s: %s\n' "$PROG" "$*" >&2; exit 3; }

while [ $# -gt 0 ]; do
  case "$1" in
    -o|--output-dir) [ $# -ge 2 ] || { usage >&2; exit 2; }; OUTDIR="$2"; shift 2 ;;
    --output-dir=*)  OUTDIR="${1#*=}"; shift ;;
    --save-raw)      SAVE_RAW=1; shift ;;
    --extra-log)     [ $# -ge 2 ] || { usage >&2; exit 2; }; EXTRA_LOGS[${#EXTRA_LOGS[@]}]="$2"; shift 2 ;;
    --no-smart)      USE_SMART=0; shift ;;
    --no-raid)       USE_RAID=0; shift ;;
    --no-journal)    USE_JOURNAL=0; shift ;;
    --no-history)    USE_HISTORY=0; shift ;;
    --require-root)  REQUIRE_ROOT=1; shift ;;
    --timeout)       [ $# -ge 2 ] || { usage >&2; exit 2; }; CMD_TIMEOUT="$2"; shift 2 ;;
    --long-timeout)  [ $# -ge 2 ] || { usage >&2; exit 2; }; LONG_TIMEOUT="$2"; shift 2 ;;
    --max-evidence)  [ $# -ge 2 ] || { usage >&2; exit 2; }; MAX_EVIDENCE="$2"; shift 2 ;;
    -q|--quiet)      QUIET=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    --version)       printf '%s %s\n' "$PROG" "$VERSION"; exit 0 ;;
    *)               printf '%s: 알 수 없는 옵션: %s\n' "$PROG" "$1" >&2; usage >&2; exit 2 ;;
  esac
done
case "$CMD_TIMEOUT$LONG_TIMEOUT$MAX_EVIDENCE" in
  *[!0-9]*|"") printf '%s: --timeout · --long-timeout · --max-evidence 는 숫자여야 합니다\n' "$PROG" >&2; exit 2 ;;
esac

have() { command -v "$1" >/dev/null 2>&1; }
prog() { [ "$QUIET" = 1 ] || printf '  .. %s\n' "$*" >&2; }

# ── 필수 도구 ──────────────────────────────────────────────────────────────────
for t in date stat sort grep sed cut tr head mktemp rm mkdir chmod cat id; do
  have "$t" || die "필수 명령이 없습니다: $t"
done
AWK=""
for t in gawk awk; do
  if have "$t" && "$t" --version 2>/dev/null | head -n 1 | grep -q 'GNU Awk'; then AWK="$t"; break; fi
done
[ -n "$AWK" ] || die "GNU awk(gawk)가 필요합니다 — RHEL 의 기본 awk 가 gawk 입니다(yum install gawk)"
HAVE_TIMEOUT=0; have timeout && HAVE_TIMEOUT=1

NOW=$(date +%s)
STAMP=$(date -d "@$NOW" '+%Y%m%d-%H%M%S')
HOST=$(hostname 2>/dev/null); [ -n "$HOST" ] || HOST=$(cat "$R/proc/sys/kernel/hostname" 2>/dev/null); [ -n "$HOST" ] || HOST=unknown
HOST_SAFE=$(printf '%s' "$HOST" | tr -c 'A-Za-z0-9._-' '_')
MYUID=$(id -u 2>/dev/null); [ -n "$MYUID" ] || MYUID=-1
IS_ROOT=0; [ "$MYUID" = 0 ] && IS_ROOT=1

if [ "$IS_ROOT" != 1 ]; then
  cat >&2 <<EOF
[주의] root 가 아닙니다(uid=$MYUID). 다음은 읽지 못할 가능성이 큽니다:
  - /var/log/messages* · /var/log/secure*(보통 root 전용 600)
  - journalctl 의 시스템 로그(systemd-journal 그룹이 아니면 자기 로그만 보입니다)
  - dmesg(kernel.dmesg_restrict=1 이면 거부)
  - smartctl · storcli/perccli · tune2fs · xfs_db(장치 접근 권한)
  - /etc/lvm/archive · /etc/lvm/backup(700)
  읽지 못한 것은 '불명' 으로 표시합니다(0 이나 정상으로 치지 않습니다).
EOF
  if [ "$REQUIRE_ROOT" = 1 ]; then die "--require-root: root 로 다시 실행하십시오(sudo $PROG)"; fi
fi

# ── 작업 폴더(메모리 우선) · 결과 폴더 ─────────────────────────────────────────
WORK=""
for base in /dev/shm "${TMPDIR:-/tmp}" /var/tmp; do
  if [ -d "$base" ] && [ -w "$base" ]; then
    WORK=$(mktemp -d "$base/rdh.XXXXXXXX" 2>/dev/null) && [ -n "$WORK" ] && break
    WORK=""
  fi
done
[ -n "$WORK" ] || die "임시 작업 폴더를 만들 수 없습니다(/dev/shm · /tmp · /var/tmp 모두 쓰기 불가)"
cleanup() {
  case "$WORK" in */rdh.????????) rm -rf -- "$WORK" ;; esac
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM HUP
RAW="$WORK/raw"; mkdir -p "$RAW"
FACTS="$WORK/facts.tsv"; EVENTS="$WORK/events.tsv"
: > "$FACTS"; : > "$EVENTS"

OUT_NOTE=""
if [ -z "$OUTDIR" ]; then
  if [ "$IS_ROOT" = 1 ]; then OUTDIR="/root/rhel-disk-history"; else OUTDIR="${HOME:-/tmp}/rhel-disk-history"; fi
fi
try_outdir() { mkdir -p -- "$1" 2>/dev/null && [ -w "$1" ] && : > "$1/.rdh-write-test" 2>/dev/null && rm -f -- "$1/.rdh-write-test"; }
if ! try_outdir "$OUTDIR"; then
  for alt in /dev/shm/rhel-disk-history "${TMPDIR:-/tmp}/rhel-disk-history"; do
    if try_outdir "$alt"; then
      OUT_NOTE="요청한 저장 위치($OUTDIR)에 쓸 수 없어 $alt 에 저장했습니다(/dev/shm 은 재부팅하면 사라집니다 — 다른 곳으로 복사하십시오)."
      OUTDIR="$alt"; break
    fi
  done
  [ -z "$OUT_NOTE" ] && die "결과를 저장할 곳이 없습니다: $OUTDIR"
fi
OUTFILE="$OUTDIR/rhel-disk-history_${HOST_SAFE}_${STAMP}.txt"
RAWKEEP="$OUTDIR/rhel-disk-history_${HOST_SAFE}_${STAMP}_raw"

# ── 공용 함수 ──────────────────────────────────────────────────────────────────
# fact: 탭으로 구분한 사실 한 줄을 적는다(값 안의 탭 · 줄바꿈은 공백으로).
fact() {
  local a out="" first=1
  for a in "$@"; do
    a=${a//$'\t'/ }; a=${a//$'\n'/ }; a=${a//$'\r'/ }
    if [ $first = 1 ]; then out="$a"; first=0; else out="$out"$'\t'"$a"; fi
  done
  printf '%s\n' "$out" >> "$FACTS"
}

# ro_guard: 읽기 전용 보증 — 상태를 바꾸는 인자가 섞이면 실행하지 않는다.
#   허용 목록이 아니라 '알려진 변경 동사 차단' 이다. 이 스크립트가 부르는 명령은 아래 run_cmd 호출부가 전부다.
ro_guard() {
  local joined=" $* " base="${1##*/}"
  case "$base" in
    smartctl)
      case "$joined" in
        *" -t "*|*" --test"*|*" -s "*|*" --smart"*|*" --set"*|*" -S "*|*" --saveauto"*|*" -o "*|*" --offlineauto"*|*" -X "*|*" --abort"*|*" -C "*|*" --captive"*) return 1 ;;
      esac ;;
    storcli*|perccli*)
      case "$joined" in *" show "*) ;; *) return 1 ;; esac
      case "$joined" in
        *" set "*|*" start "*|*" stop "*|*" delete "*|*" del "*|*" add "*|*" flash"*|*" download "*|*" erase"*|*" init"*|*" spinup"*|*" spindown"*|*" restart"*|*" clear "*) return 1 ;;
      esac ;;
    dmesg)
      case "$joined" in *" -c "*|*" -C "*|*" --clear"*|*" -D "*|*" -E "*|*" -n "*|*" --console"*) return 1 ;; esac ;;
    tune2fs)  case "$joined" in *" -l "*) ;; *) return 1 ;; esac ;;
    xfs_db)   case "$joined" in *" -r "*) ;; *) return 1 ;; esac
              case "$joined" in *" -x "*|*"write"*) return 1 ;; esac ;;
    mdadm)    case "$joined" in *" --detail "*) ;; *) return 1 ;; esac ;;
    journalctl)
      case "$joined" in *"--vacuum"*|*"--rotate"*|*"--flush"*|*"--sync"*|*"--relinquish"*|*"--setup-keys"*|*"--update-catalog"*) return 1 ;; esac ;;
    rpm)      case "$joined" in *" -q "*|*" -qa "*) ;; *) return 1 ;; esac ;;
    lsblk|dumpe2fs|uname|stat|readlink) ;;
    *) return 1 ;;
  esac
  return 0
}

# run_cmd 이름 시한 명령…  → 출력 $RAW/이름.out · 오류 $RAW/이름.err, 종료 코드 반환.
#   없는 명령은 127 을 돌려주고 CMD 사실에 '명령 없음' 으로 남긴다(판정에서 '불명' 의 근거가 된다).
run_cmd() {
  local name="$1" tmo="$2" rc st
  shift 2
  local out="$RAW/$name.out" err="$RAW/$name.err"
  : > "$out"; : > "$err"
  if ! have "$1"; then
    fact CMD "$name" 127 "명령 없음" "$*"
    return 127
  fi
  if ! ro_guard "$@"; then
    fact CMD "$name" 126 "차단(읽기 전용 보증에 걸림 — 실행하지 않음)" "$*"
    return 126
  fi
  # storcli/perccli 는 현재 폴더에 로그 파일을 만들 수 있어 작업 폴더(메모리)에서 돌린다.
  if [ "$HAVE_TIMEOUT" = 1 ]; then
    ( cd "$WORK" && exec timeout -k 5 "$tmo" "$@" ) >"$out" 2>"$err" </dev/null
  else
    ( cd "$WORK" && exec "$@" ) >"$out" 2>"$err" </dev/null
  fi
  rc=$?
  case "$rc" in
    0)   st="정상" ;;
    124|137) st="시간 초과(${tmo}초) — 출력이 잘렸을 수 있음" ;;
    *)   st="종료 코드 $rc" ;;
  esac
  fact CMD "$name" "$rc" "$st" "$*"
  return "$rc"
}

to_epoch() { # 'Sat Nov 14 02:28:11 2026' 같은 날짜 문자열 → epoch(실패하면 빈 값)
  date -d "$1" +%s 2>/dev/null
}

# ══════════════════════════════════════════════════════════════════════════════
# awk 프로그램(작업 폴더에 풀어 쓴다 — bash 4.2 의 $(… <<EOF) 파싱 문제를 피한다)
# ══════════════════════════════════════════════════════════════════════════════
write_awk_programs() {

# ── classify.awk: 로그 한 출처를 읽어 '분 단위 묶음' 사건으로 낸다 ─────────────
#   입력 변수: st(출처 종류 M=파일 J=저널 D=dmesg O=시각 없는 dmesg 사본 S=secure X=추가 파일)
#             src(표시 이름) mtime(파일 수정 시각) boot_epoch(dmesg 환산용) now
#   출력: EVT 줄(사건 묶음) · SRC 줄(출처 보존 구간)
#
#   패턴의 근거와 확인 수준(실서버 로그와 대조한 것은 없다 — 전부 '기억 기반'):
#     [K] 리눅스 커널 소스(block/blk-core.c blk_errors[] · drivers/scsi/scsi_logging.c ·
#         drivers/ata/libata-eh.c · drivers/nvme/host/core.c · drivers/md/raid1.c)의 문구
#     [S] smartmontools smartd.cpp 의 로그 문구
#     [V] 벤더 유틸(MR_MONITOR · Dell OMSA)의 syslog 문구 — 가장 불확실하다
#   분류(cls):
#     MEDIA   미디어 오류라고 커널 · 디스크가 직접 말한 것(확정 근거)
#     IOERR   I/O 오류 — 이 줄만으로는 미디어인지 전송인지 알 수 없다(같은 분에 MEDIA/XPORT 가 있으면 그쪽으로 붙인다)
#     HWERR   Sense Key Hardware Error 등 장치 하드웨어 오류
#     XPORT   전송 · 경로 · 타임아웃 · 오프라인(미디어 오류로 세지 않는다 — 오탐 방지)
#     OTHER   디스크 결함이 아닌 블록 오류(critical target = WRITE SAME 미지원 등)
#     FSIO / FSCTX  파일시스템이 본 I/O 오류 / 그 결과(읽기 전용 전환 등)
#     SMARTSTATE / SMARTERR / SMARTFAIL / SMARTCHG / SMARTID  smartd 가 남긴 것
#     CTRLMSG 컨트롤러 감시 유틸이 syslog 에 남긴 것
#     BOOT / HOST / INQ / ATTACH / SASSEEN / SASREM / FMTCMD  판정 보조(부팅 경계 · 전송 종류 · 식별자 · 포맷 명령)
cat > "$WORK/classify.awk" <<'RDH_AWK_CLASSIFY'
BEGIN {
  FS = "\n"
  split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", mn, " ")
  for (i = 1; i <= 12; i++) MON[mn[i]] = i
  # 빠른 1차 거름(이 중 하나도 없으면 분류 규칙을 돌리지 않는다)
  QUICK = "rror|Sense|hostbyte|ffline|ata[0-9]|nvme|smartd|Attached SCSI|Linux version|scsi host|scsi[0-9]+ :|Direct-Access|sas_addr|MR_MONITOR|EventID|multipath|COMMAND=|ailure|FAILED|Failing|timed out|timeout|timing out|edium|ad block|usb-storage|megasas|megaraid|blocked|Link Down|LOOP DOWN|read-only|unctur|hutdown|Shutting down|disabled|resetting|task abort|emoving|Aborting journal|iscsid"
  if (now == "") now = systime()
  mtime += 0; boot_epoch += 0
  yidx = 0; pm = 0; nlines = 0; nboot = 0; nb = 0
  firstraw = ""; lastraw = ""
}

function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }

# 줄 머리의 시각을 읽는다. T_FMT: T=전통 syslog(연도 없음) I=ISO D=dmesg 초 ""=없음
function tsparse(line,   c) {
  T_FMT = ""; T_RAW = ""; T_REST = line
  c = substr(line, 1, 1)
  if (c >= "A" && c <= "Z") {
    if ((substr(line, 1, 3) in MON) && substr(line, 10, 1) == ":" && substr(line, 13, 1) == ":") {
      T_FMT = "T"; T_RAW = substr(line, 1, 15); T_REST = substr(line, 17)
    }
  } else if (c >= "0" && c <= "9") {
    if (substr(line, 5, 1) == "-" && substr(line, 11, 1) == "T") {
      c = index(line, " ")
      if (c > 19) { T_FMT = "I"; T_RAW = substr(line, 1, c - 1); T_REST = substr(line, c + 1) }
    }
  } else if (c == "[") {
    if (match(line, /^\[ *[0-9]+\.[0-9]+\] /)) {
      T_FMT = "D"; T_RAW = substr(line, 2, RLENGTH - 3); T_REST = substr(line, RLENGTH + 1)
    }
  }
}

function tzsecs(z,   s, h, m) {   # +0900 / +09:00 / Z → 초
  if (z == "Z" || z == "") return 0
  s = (substr(z, 1, 1) == "-") ? -1 : 1
  gsub(/[^0-9]/, "", z)
  h = substr(z, 1, 2) + 0; m = substr(z, 3, 2) + 0
  return s * (h * 3600 + m * 60)
}

# 시각 문자열 → epoch. 전통 형식은 연도가 없어 '파일 수정 시각' 을 닻으로 거꾸로 맞춘다(yi = 그 줄까지의 해 넘김 횟수).
function conv(fmt, raw, yi,   y, t, z, lo) {
  if (fmt == "T") {
    y = anchor_year - (yidx - yi)
    t = mktime(y " " MON[substr(raw, 1, 3)] " " (substr(raw, 5, 2) + 0) " " substr(raw, 8, 2) " " substr(raw, 11, 2) " " substr(raw, 14, 2))
    return (t < 0) ? 0 : t
  }
  if (fmt == "I") {
    t = mktime(substr(raw, 1, 4) " " substr(raw, 6, 2) " " substr(raw, 9, 2) " " substr(raw, 12, 2) " " substr(raw, 15, 2) " " substr(raw, 18, 2))
    if (t < 0) return 0
    if (match(raw, /(Z|[+-][0-9][0-9]:?[0-9][0-9])$/)) {
      z = substr(raw, RSTART)
      lo = tzsecs(strftime("%z", t))
      t = t + lo - tzsecs(z)
    }
    return t
  }
  if (fmt == "D") return (boot_epoch > 0) ? boot_epoch + int(raw) : 0
  return 0
}

# 포맷 · 초기화 계열 명령인가(목록만 보는 fdisk -l · parted print · wipefs 조회는 뺀다)
function fmtcmd(c) {
  if (c ~ /(^|[ \/;|&(])(mkfs(\.[a-z0-9]+)?|mke2fs|mkswap|pvcreate|vgcreate|blkdiscard|shred)( |$)/) return 1
  if (c ~ /(^|[ \/;|&(])wipefs .*(-a|--all|-o|--offset)/) return 1
  if (c ~ /(^|[ \/;|&(])mdadm .*(--create|-C )/) return 1
  if (c ~ /(^|[ \/;|&(])dd .*of=\/dev\/(sd|nvme|vd|xvd|mapper|dm-|md)/) return 1
  if (c ~ /(^|[ \/;|&(])(parted|sgdisk|sfdisk|fdisk|gdisk) /) {
    if (c ~ /fdisk +-l|parted .*( print|-l)|sgdisk +(-p|--print)|sfdisk +(-l|-d|--dump|--list)|gdisk +-l/) return 0
    return 1
  }
  return 0
}

# 컨트롤러 이벤트 문구 분류([V] — storcli 이벤트 로그와 MR_MONITOR 가 같은 문구를 쓴다고 보고 같은 규칙을 쓴다)
function pclass(t) {
  if (t ~ /[Mm]edium error|[Mm]edia error|ad block|unctur/) return "PMEDIA"
  if (match(t, /Unexpected sense.*Sense: ([0-9a-fA-F])\//, pa)) {
    if (pa[1] == "3") return "PMEDIA"
    if (pa[1] == "4") return "PHW"
    if (pa[1] == "1") return "PRECOV"
    if (pa[1] == "b" || pa[1] == "B") return "PXPORT"
    return ""
  }
  if (t ~ /redictive [Ff]ailure|SMART/) return "PPRED"
  if (t ~ /State change.* to (FAILED|Failed|UNCONFIGURED_BAD|Unconfigured Bad|OFFLINE|Offline)|Device failed|[Dd]isk failed/) return "PFAIL"
  if (t ~ /^Removed: PD|[Dd]evice removed|PD .*[Rr]emoved|Physical disk removed/) return "PREM"
  if (t ~ /^Inserted: PD|[Dd]evice inserted|Physical disk inserted/) return "PINS"
  if (t ~ /[Rr]ebuild/) return "PREBUILD"
  if (t ~ /[Rr]eplaced|[Rr]eplace [Mm]issing|[Cc]opyback/) return "PREPL"
  if (t ~ /Command timeout|Error on PD|PD .* reset|[Ll]ink|path/) return "PXPORT"
  if (t ~ /VD .*(reated|eleted)|Created VD|Deleted VD|[Ii]nitialization (started|complete)|Configuration cleared|Foreign/) return "PVD"
  return ""
}

function classify(prog, msg,   a, b, k, t, rest, tags, mm) {
  CLS = ""; SUB = ""; DEV = ""; HCTL = ""; KX = ""; EXTRA = ""; VAL = 0

  if (prog == "kernel") {
    # sd H:C:T:L: [sdX] … — hctl ↔ sdX 대응을 배워 둔다(오프라인 거부 줄에는 hctl 만 있다)
    if (match(msg, /^(sd|scsi) ([0-9]+:[0-9]+:[0-9]+:[0-9]+): /, a)) {
      HCTL = a[2]
      if (match(msg, /^sd [0-9:]+: \[(sd[a-z]+)\]/, b)) { DEV = b[1]; H2D[HCTL] = DEV }
      else if (HCTL in H2D) DEV = H2D[HCTL]
    }

    # [K] 부팅 경계 — init/main.c 의 linux_banner
    if (index(msg, "Linux version ") == 1) { CLS = "BOOT"; split("", H2D); return 1 }

    # [K] block/blk-core.c: "<종류> error, dev <이름>, sector <N>"
    #     RHEL 7 'blk_update_request: I/O error' · 'end_request: I/O error' / RHEL 8 'print_req_error: I/O error'
    #     RHEL 8.x 후기 · 9 'blk_update_request: I/O error, dev sda, sector N op 0x0:(READ) …' / 9.x 후기는 머리말 없이 'I/O error, dev …'
    #     머리말(함수 이름)은 판마다 달라 보지 않고 뒤쪽 문구만 본다.
    if (match(msg, /(I\/O|critical medium|critical target|critical nexus|critical space allocation|protection|timeout|recoverable transport|operation not supported|kernel resource|device resource) error, dev ([^ ,]+), sector ([0-9]+)/, a)) {
      DEV = a[2]; EXTRA = "sector=" a[3]
      if (a[1] == "critical medium") { CLS = "MEDIA"; SUB = "blk-critical-medium" }
      else if (a[1] == "I/O") { CLS = "IOERR"; SUB = "blk-io" }
      else if (a[1] == "timeout" || a[1] == "recoverable transport") { CLS = "XPORT"; SUB = "blk-" a[1] }
      else { CLS = "OTHER"; SUB = "blk-" a[1] }   # critical target(WRITE SAME/UNMAP 미지원) · nexus(예약 충돌) · space(씬 풀 부족) 등
      gsub(/ /, "-", SUB)
      return 1
    }

    # [K] fs/buffer.c: 'Buffer I/O error on dev sda1, logical block N'(구판 'on device') · 'lost page write due to I/O error on sda1'
    if (match(msg, /Buffer I\/O error on dev(ice)? ([^ ,]+), logical block ([0-9]+)/, a)) { CLS = "IOERR"; SUB = "buffer-io"; DEV = a[2]; return 1 }
    if (match(msg, /lost (async )?page write due to I\/O error on ([^ ,]+)/, a)) { CLS = "IOERR"; SUB = "lost-page-write"; DEV = a[2]; return 1 }

    # [K] scsi_logging.c: '… Sense Key : Medium Error [current]' — sense key 가 미디어/하드웨어/복구됨을 직접 말한다
    if (index(msg, "Sense Key : ")) {
      if (match(msg, /Sense Key : ([A-Za-z ]+)/, a)) {
        k = trim(a[1])
        if (DEV == "" && match(msg, /\[(sd[a-z]+)\]/, b)) DEV = b[1]
        if (DEV == "" && HCTL != "") DEV = "hctl:" HCTL
        if (k == "Medium Error") { CLS = "MEDIA"; SUB = "sense-medium-error" }
        else if (k == "Hardware Error") { CLS = "HWERR"; SUB = "sense-hardware-error" }
        else if (k == "Recovered Error") { CLS = "RECOV"; SUB = "sense-recovered-error" }
        else if (k == "Aborted Command") { CLS = "XPORT"; SUB = "sense-aborted-command" }
        else if (k == "Not Ready") { CLS = "XPORT"; SUB = "sense-not-ready" }
        else { CLS = "OTHER"; SUB = "sense-" tolower(k); gsub(/ /, "-", SUB) }   # Illegal Request · Unit Attention 등은 결함이 아니다
        return 1
      }
    }
    # [K] 'Add. Sense: Unrecovered read error' 등 — ASC 문구. 미디어 계열만 MEDIA 로 센다.
    if (match(msg, /Add\. Sense: (.*)$/, a)) {
      t = a[1]
      if (DEV == "" && match(msg, /\[(sd[a-z]+)\]/, b)) DEV = b[1]
      if (DEV == "" && HCTL != "") DEV = "hctl:" HCTL
      if (t ~ /Unrecovered read error|Read retries exhausted|Record not found|Id crc or ecc error|Error too long to correct|Data synchronization mark error|Write error|Peripheral device write fault|auto reallocate failed|Medium format corrupted|Address mark not found/) { CLS = "MEDIA"; SUB = "asc-medium" }
      else if (t ~ /Internal target failure|Logical unit failure|Failure prediction threshold exceeded/) { CLS = "HWERR"; SUB = "asc-hardware" }
      else if (t ~ /Logical unit not ready|communication|[Tt]imeout|Nexus loss|iuCRC|parity error|Data phase error|Target operating conditions have changed/) { CLS = "XPORT"; SUB = "asc-transport" }
      else return 0
      EXTRA = substr(t, 1, 80)
      return 1
    }
    # [K] 'FAILED Result: hostbyte=DID_xxx driverbyte=…' — DID_OK 가 아니면 호스트(전송) 쪽이 명령을 못 넘긴 것이다
    if (match(msg, /hostbyte=(DID_[A-Z_]+)/, a)) {
      if (DEV == "" && match(msg, /\[(sd[a-z]+)\]/, b)) DEV = b[1]
      if (a[1] != "DID_OK") { CLS = "XPORT"; SUB = tolower(a[1]); return 1 }
      if (index(msg, "DRIVER_TIMEOUT")) { CLS = "XPORT"; SUB = "driver-timeout"; return 1 }
      return 0
    }
    # [K] scsi_lib.c: 'rejecting I/O to offline device' / 'rejecting I/O to dead device' — 장치가 이미 빠진 뒤의 I/O
    if (match(msg, /rejecting I\/O to (offline|dead) device/, a)) {
      if (DEV == "" && HCTL != "") DEV = "hctl:" HCTL
      CLS = "XPORT"; SUB = a[1] "-device"; return 1
    }
    if (index(msg, "Device offlined") || index(msg, "Medium access timeout failure") || index(msg, "timing out command") || index(msg, "task abort")) {
      if (DEV == "" && match(msg, /\[(sd[a-z]+)\]/, b)) DEV = b[1]
      if (DEV == "" && HCTL != "") DEV = "hctl:" HCTL
      CLS = "XPORT"
      SUB = index(msg, "Device offlined") ? "device-offlined" : (index(msg, "Medium access timeout") ? "medium-access-timeout" : "command-timeout")
      return 1
    }
    # RAID 컨트롤러 드라이버의 리셋 · 타임아웃(컨트롤러 쪽 문제 — 미디어 오류로 세지 않는다)
    if (msg ~ /megasas|megaraid_sas/ && msg ~ /RESET|[Rr]eset|FAULT|timed out|TIMEOUT|pending commands|kill adapter|killed/) {
      if (DEV == "" && match(msg, /\[(sd[a-z]+)\]/, b)) DEV = b[1]
      CLS = "XPORT"; SUB = "raid-controller"; return 1
    }

    # [K] libata-eh.c: 'ataN.MM: error: { UNC }' = 읽지 못한 섹터 / '{ ICRC ABRT }' = 인터페이스 CRC(케이블 · 백플레인)
    if (match(msg, /^(ata[0-9]+(\.[0-9]+)?): (.*)$/, a)) {
      DEV = a[1]; t = a[3]
      if (t ~ /^error: \{/) {
        if (t ~ /UNC/) { CLS = "MEDIA"; SUB = "ata-unc" }
        else if (t ~ /ICRC/) { CLS = "XPORT"; SUB = "ata-icrc" }
        else if (t ~ /IDNF/) { CLS = "IOERR"; SUB = "ata-idnf" }
        else { CLS = "OTHER"; SUB = "ata-abrt" }
        return 1
      }
      if (t ~ /^failed command: /) { CLS = "ATACTX"; SUB = "ata-failed-command"; return 1 }
      if (t ~ /resetting link|link is slow to respond|COMRESET failed|SATA link down|limiting SATA link speed|^SError: \{|reset failed/) { CLS = "XPORT"; SUB = "ata-link"; return 1 }
      if (t ~ /^(revalidation failed|failed to IDENTIFY|qc timeout|device not ready)/) { CLS = "XPORT"; SUB = "ata-timeout"; return 1 }
      if (t ~ /^disabled/) { CLS = "XPORT"; SUB = "ata-disabled"; return 1 }
      return 0
    }

    # [K] nvme/host/core.c(5.18+ · RHEL 9.x 백포트 여부 미확인): 'nvme0n1: I/O Cmd(0x2) @ LBA N, 8 blocks, I/O Error (sct 0x2 / sc 0x81)'
    #     sct 0x2 = Media and Data Integrity Errors(NVMe 규격)
    if (match(msg, /^(nvme[0-9]+n[0-9]+): .*\(sct 0x([0-9a-fA-F]+) \/ sc 0x([0-9a-fA-F]+)\)/, a)) {
      DEV = a[1]; EXTRA = "sct=0x" a[2] " sc=0x" a[3]
      if (strtonum("0x" a[2]) == 2) { CLS = "MEDIA"; SUB = "nvme-media-status" } else { CLS = "IOERR"; SUB = "nvme-status" }
      return 1
    }
    if (match(msg, /^nvme (nvme[0-9]+): (.*)$/, a)) {
      DEV = a[1]; t = a[2]
      if (t ~ /timeout/) { CLS = "XPORT"; SUB = "nvme-timeout"; return 1 }
      if (t ~ /controller is down|Removing after probe failure|Device not ready|Disabling device|Identify Controller failed|could not set queue count|Device shutdown incomplete/) { CLS = "XPORT"; SUB = "nvme-controller"; return 1 }
      return 0
    }

    # [K] md/raid1.c · raid10.c · raid5.c
    if (match(msg, /read error corrected \(([0-9]+) sectors at ([0-9]+) on ([a-z0-9]+)\)/, a)) { CLS = "MEDIA"; SUB = "md-read-error-corrected"; DEV = a[3]; return 1 }
    if (match(msg, /read error not correctable \(sector ([0-9]+) on ([a-z0-9]+)\)/, a)) { CLS = "MEDIA"; SUB = "md-read-error-uncorrectable"; DEV = a[2]; return 1 }
    if (match(msg, /Disk failure on ([a-z0-9]+), disabling device/, a)) { CLS = "IOERR"; SUB = "md-disk-failure"; DEV = a[1]; return 1 }
    if (match(msg, /^md\/raid[0-9]*:(md[0-9]+): ([a-z0-9]+): (rescheduling sector|unrecoverable I\/O read error|redirecting sector)/, a)) { CLS = "IOERR"; SUB = "md-read-error"; DEV = a[2]; return 1 }

    # [K] 파일시스템이 본 I/O 오류(원인이 미디어인지 전송인지는 알 수 없다)
    if (msg ~ /^(EXT[234]-fs|XFS|JBD2?|BTRFS|FAT-fs)/) {
      if (msg ~ /I\/O [Ee]rror|IO error|IO failure|error -5|error 5 /) { CLS = "FSIO"; SUB = "fs-io-error" }
      else if (msg ~ /Remounting filesystem read-only|Aborting journal|force_shutdown|Shutting down filesystem|has been shut down|journal has aborted/) { CLS = "FSCTX"; SUB = "fs-shutdown" }
      else return 0
      if (match(msg, /\(device ([^)]+)\)/, a)) DEV = a[1]
      else if (match(msg, /^[A-Za-z0-9-]+ \(([^)]+)\)/, a)) DEV = a[1]
      else if (match(msg, / on (device )?([a-z][a-z0-9-]+)/, a)) DEV = a[2]
      if (DEV !~ /^dm-/) sub(/-[0-9]+$/, "", DEV)     # JBD2 의 'sdb1-8' → sdb1
      return 1
    }

    # 판정 보조: 장치 연결 · INQUIRY · 호스트 어댑터 종류 · SAS 주소
    if (msg ~ /Attached SCSI (removable )?disk/) {
      if (DEV == "") return 0
      CLS = "ATTACH"; return 1
    }
    if (match(msg, /^scsi ([0-9]+:[0-9]+:[0-9]+:[0-9]+): Direct-Access[A-Z-]* +(.*) PQ: /, a)) {
      HCTL = a[1]; rest = a[2]
      CLS = "INQ"; KX = trim(substr(rest, 1, 8)) "|" trim(substr(rest, 10, 16))
      return 1
    }
    if (match(msg, /^scsi host([0-9]+): (.*)$/, a) || match(msg, /^scsi([0-9]+) : (.*)$/, a)) {
      CLS = "HOST"; KX = a[1] "|" substr(a[2], 1, 60); return 1
    }
    if (match(msg, /^mpt[23]sas[_a-z0-9]*: (.*)sas_addr\(0x([0-9a-fA-F]+)\)/, a)) {
      CLS = (a[1] ~ /removing handle/) ? "SASREM" : "SASSEEN"; KX = tolower(a[2]); return 1
    }
    # 장치 이름이 없는 전송 계열 맥락(iSCSI · FC · 멀티패스)
    if (msg ~ /detected conn error|session recovery timed out|blocked FC remote port time out|Link Down|LOOP DOWN|multipath: Failing path|rport-[0-9:-]+: blocked/) {
      CLS = "XPORTCTX"; SUB = "san-transport"; DEV = ""; return 1
    }
    return 0
  }

  # [S] smartd: 'Device: /dev/sda [SAT], <모델>, S/N:<시리얼>, WWN:<n-n-n>, FW:…' (ATA)
  #            'Device: /dev/sdb [megaraid_disk_00], [VENDOR PRODUCT REV], lu id: 0x…, S/N: <시리얼>, <크기>' (SCSI)
  if (prog == "smartd") {
    if (!match(msg, /^Device: (\/dev\/[^ ,]+)(( \[[^]]*\])*),? (.*)$/, a)) return 0
    DEV = a[1]; sub(/^\/dev\//, "", DEV); tags = a[2]; rest = a[4]
    if (match(tags, /megaraid_disk_([0-9]+)/, b)) DEV = "megaraid," (b[1] + 0)
    else if (match(tags, /(cciss|areca|3ware)_disk_([0-9]+)/, b)) DEV = b[1] "," (b[2] + 0)
    if (index(rest, "S/N:")) {
      CLS = "SMARTID"
      k = ""; t = ""
      if (match(rest, /S\/N: ?([^, ]+)/, b)) k = b[1]
      if (match(rest, /WWN: ?([0-9a-fA-F-]+)/, b)) { t = b[1]; gsub(/-/, "", t) }
      else if (match(rest, /lu id: 0x([0-9a-fA-F]+)/, b)) t = b[1]
      mm = rest; sub(/, (S\/N|lu id|WWN).*$/, "", mm)
      KX = k "|" tolower(t) "|" trim(mm)
      return 1
    }
    if (match(rest, /^([0-9]+) Currently unreadable \(pending\) sectors/, b)) { CLS = "SMARTSTATE"; SUB = "pending-sectors"; VAL = b[1] + 0; return 1 }
    if (match(rest, /^([0-9]+) Offline uncorrectable sectors/, b)) { CLS = "SMARTSTATE"; SUB = "offline-uncorrectable"; VAL = b[1] + 0; return 1 }
    if (match(rest, /ATA error count increased from ([0-9]+) to ([0-9]+)/, b)) { CLS = "SMARTERR"; SUB = "ata-error-count"; VAL = b[2] + 0; return 1 }
    if (match(rest, /Error Log entries increased from ([0-9]+) to ([0-9]+)/, b)) { CLS = "SMARTERR"; SUB = "nvme-error-log"; VAL = b[2] + 0; return 1 }
    if (match(rest, /Self-Test Log error count increased from ([0-9]+) to ([0-9]+)/, b)) { CLS = "SMARTERR"; SUB = "selftest-error"; VAL = b[2] + 0; return 1 }
    if (index(rest, "Media and Data Integrity Errors")) { CLS = "SMARTERR"; SUB = "nvme-media-errors"; return 1 }
    if (index(rest, "FAILED SMART self-check")) { CLS = "SMARTFAIL"; SUB = "self-check-failed"; return 1 }
    if (index(rest, "SMART Failure:")) { CLS = "SMARTFAIL"; SUB = "scsi-smart-failure"; return 1 }
    if (match(rest, /Failed SMART usage Attribute: ([0-9]+)/, b)) { CLS = "SMARTFAIL"; SUB = "attr-" b[1] "-failed"; return 1 }
    if (index(rest, "Critical Warning")) { CLS = "SMARTFAIL"; SUB = "nvme-critical-warning"; return 1 }
    if (match(rest, /SMART (Prefailure|Usage) Attribute: (5|187|196|197|198) [A-Za-z_-]+ changed from ([0-9]+) to ([0-9]+)/, b)) { CLS = "SMARTCHG"; SUB = "attr-" b[2] "-changed"; VAL = b[4] + 0; return 1 }
    return 0
  }

  # [V] 컨트롤러 감시 유틸(MR_MONITOR · Dell OMSA 'Storage Service EventID')
  if (prog ~ /^(MR_MONITOR|MegaRAID|perccli|storcli)/ || index(msg, "Storage Service EventID") || index(msg, "MR_MONITOR")) {
    SUB = pclass(msg)
    if (SUB == "") return 0
    CLS = "CTRLMSG"
    if (match(msg, /PD ([0-9a-fA-F]+)\(e(0x[0-9a-fA-F]+|[0-9]+)\/s([0-9]+)\)/, b)) DEV = "pd:e" strtonum(b[2]) "/s" b[3]
    else if (match(msg, /Physical Disk ([0-9:]+)/, b)) DEV = "pd:" b[1]
    else DEV = "pd:?"
    return 1
  }
  if (prog ~ /^multipathd?$/) {
    if (msg ~ /fail|down|removed|timed out|not ready/) {
      CLS = "XPORT"; SUB = "multipath"
      if (match(msg, /(sd[a-z]+)/, b)) DEV = b[1]; else { CLS = "XPORTCTX"; DEV = "" }
      return 1
    }
    return 0
  }
  if (prog == "iscsid") {
    if (msg ~ /rror|timed out|down|lost/) { CLS = "XPORTCTX"; SUB = "iscsi"; return 1 }
    return 0
  }
  if (prog == "sudo") {
    if (match(msg, /COMMAND=(.*)$/, b) && fmtcmd(b[1])) { CLS = "FMTCMD"; KX = substr(b[1], 1, 200); return 1 }
    return 0
  }
  return 0
}

{
  nlines++
  line = $0
  c = substr(line, 1, 1)
  # 전통 syslog 형식의 해 넘김(12월 → 1월)을 줄 순서대로 센다
  if (c >= "A" && c <= "Z") {
    m = MON[substr(line, 1, 3)]
    if (m) {
      if (pm && m < pm && pm - m >= 6) yidx++
      pm = m
    }
  }
  if (firstraw == "") {
    tsparse(line)
    if (T_FMT != "") { firstraw = T_RAW; firstfmt = T_FMT; firsty = yidx }
  }
  lastline = line; lasty = yidx
  if (line !~ QUICK) next

  if (length(line) > 700) line = substr(line, 1, 700)      # 길이를 먼저 자른다(정규식 비용 상한)
  tsparse(line)
  rest = T_REST
  prog = ""; msg = rest
  if (T_FMT == "D" || (T_FMT == "" && st == "O")) {
    prog = "kernel"
    if (T_FMT == "") sub(/^\[[^]]*\] /, "", msg)
  } else if (match(rest, /^[^ ]+ ([^ :\[]+)(\[[0-9]+\])?: ?/, pp)) {
    prog = pp[1]; msg = substr(rest, RLENGTH + 1)
    if (prog == "kernel") sub(/^\[ *[0-9]+\.[0-9]+\] /, "", msg)
  }
  if (!classify(prog, msg)) next
  if (CLS == "BOOT") nboot++

  # 분 단위로 묶는다: 같은 (분 · 분류 · 세부 · 장치 · 키)는 한 줄로, 건수만 센다
  if (T_FMT == "T") mk = yidx " " substr(T_RAW, 1, 12)
  else if (T_FMT == "I") mk = substr(T_RAW, 1, 16)
  else if (T_FMT == "D") mk = int(T_RAW / 60)
  else mk = "?"
  key = mk SUBSEP CLS SUBSEP SUB SUBSEP DEV SUBSEP KX
  if (!(key in B)) {
    nb++; ORDER[nb] = key
    B[key] = 0
    Bfmt[key] = T_FMT; Bfirst[key] = T_RAW; By[key] = yidx
    Bcls[key] = CLS; Bsub[key] = SUB; Bdev[key] = DEV; Bhctl[key] = HCTL; Bkx[key] = KX
    Bextra[key] = EXTRA; Blno[key] = nlines
    gsub(/\t/, " ", line); Bline[key] = substr(line, 1, 320)
    Bmax[key] = VAL
  }
  B[key]++
  Blast[key] = T_RAW; Bly[key] = yidx
  if (VAL > Bmax[key]) Bmax[key] = VAL
}

END {
  # 닻 연도: 마지막 줄의 시각이 파일 수정 시각(없으면 지금)보다 이틀 넘게 미래가 되지 않는 해
  mt = (mtime > 0) ? mtime : now
  anchor_year = strftime("%Y", mt) + 0
  tsparse(lastline)
  if (T_FMT == "T") {
    t = conv("T", T_RAW, yidx)
    if (t > mt + 172800) anchor_year--
  }
  fe = 0; le = 0; flag = "?"
  if (firstraw != "") { fe = conv(firstfmt, firstraw, firsty) }
  if (T_FMT != "") { le = conv(T_FMT, T_RAW, yidx); flag = (T_FMT == "T") ? "y" : ((T_FMT == "D") ? "d" : "e") }
  if (T_FMT == "D" && boot_epoch <= 0) flag = "?"
  status = (nlines > 0) ? "읽음" : "빈 출력"
  printf "SRC\t%s\t%s\t%s\t%d\t%d\t%s\t%d\t%d\t%d\n", st, src, status, fe, le, flag, nlines, nb, nboot

  for (i = 1; i <= nb; i++) {
    key = ORDER[i]
    f = Bfmt[key]
    ef = conv(f, Bfirst[key], By[key]); el = conv(f, Blast[key], Bly[key])
    fl = (f == "T") ? "y" : ((f == "D") ? "d" : ((f == "I") ? "e" : "?"))
    if (ef <= 0) { fl = "?"; ef = 0; el = 0 }
    printf "EVT\t%d\t%d\t%s\t%s\t%s\t%d\t%s\t%s\t%s\t%s\t%d\t%s\t%s\t%d\t%s\n", ef, el, fl, st, src, Blno[key], Bcls[key], Bsub[key], Bdev[key], Bhctl[key], B[key], Bkx[key], Bextra[key], Bmax[key], Bline[key]
  }
}
RDH_AWK_CLASSIFY

# ── smart.awk: smartctl -x / -a 출력 한 개 → SMART 사실 한 줄 + 오류 로그(SMERR) ──
#   형식 근거: smartmontools 6.x~7.x 의 ataprint.cpp · scsiprint.cpp · nvmeprint.cpp 출력(기억 기반 · 실물 미대조)
#   못 읽은 값은 빈 문자열로 둔다(0 으로 채우지 않는다 — 판정부가 '불명' 으로 센다).
cat > "$WORK/smart.awk" <<'RDH_AWK_SMART'
function val(s,   i) { i = index(s, ":"); s = substr(s, i + 1); sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
function num(s) { gsub(/,/, "", s); if (s ~ /^[0-9]+/) { match(s, /^[0-9]+/); return substr(s, 1, RLENGTH) + 0 } return "" }
BEGIN { kind = ""; inattr = 0; rawcol = 0; status = ""; errpoh = ""; nerr = 0 }
/^Device Model:/        { kind = "ata"; model = val($0) }
/^Model Number:/        { if (kind == "") kind = "nvme"; model = val($0) }
/^Vendor:/              { vendor = val($0) }
/^Product:/             { product = val($0); if (kind == "") kind = "scsi" }
/^Serial [Nn]umber:/    { serial = val($0) }
/^LU WWN Device Id:/    { wwn = val($0); gsub(/ /, "", wwn) }
/^Logical Unit id:/     { wwn = val($0); sub(/^0x/, "", wwn) }
/^Rotation Rate:/       { rot = val($0) }
/^SMART overall-health self-assessment test result:/ { health = val($0) }
/^SMART Health Status:/ { health = val($0) }
/DELL or MegaRaid controller, please try adding/ { status = "vd" }
/Smartctl open device: .* failed/ { if (status == "") status = "openfail" }
/Permission denied/     { status = "perm" }
/^ID# ATTRIBUTE_NAME/   { inattr = 1; rawcol = NF; next }
inattr && /^ *[0-9]+ [A-Za-z]/ {
  id = $1 + 0; raw = num($rawcol)
  if (id == 5) realloc = raw
  else if (id == 9) poh = raw
  else if (id == 187) repunc = raw
  else if (id == 196) reallocev = raw
  else if (id == 197) pending = raw
  else if (id == 198) offunc = raw
  else if (id == 199) crc = raw
  next
}
inattr && /^ *$/        { inattr = 0 }
/^ATA Error Count:/     { ataerr = num(val($0)) }
/^Device Error Count:/  { ataerr = num(val($0)) }
/^No Errors Logged/     { if (ataerr == "") ataerr = 0 }
/^Error [0-9]+ (\[[0-9]+\] )?occurred at disk power-on lifetime: [0-9]+ hours/ {
  match($0, /lifetime: [0-9]+/); errpoh = substr($0, RSTART + 10, RLENGTH - 10) + 0
}
/Error: [A-Z]/ && errpoh != "" {
  t = substr($0, index($0, "Error: "))
  if (nerr < 20) { nerr++; printf "SMERR\t%s\t%s\t%s\n", handle, errpoh, substr(t, 1, 120) }
  if (t ~ /UNC/) unclog++
  if (t ~ /ICRC/) icrclog++
  errpoh = ""
}
/^# *[0-9]+ +(Short|Extended|Conveyance|Background|Selective|Offline)/ && /read failure|[Ff]ailed|servo|electrical|handling damage/ {
  stfail++
  h = ""
  for (i = 2; i <= NF; i++) if ($i ~ /%$/) { h = num($(i + 1)); break }
  if (nerr < 20) { nerr++; t = $0; gsub(/  +/, " ", t); printf "SMERR\t%s\t%s\tself-test: %s\n", handle, h, substr(t, 1, 120) }
}
/^Elements in grown defect list:/ { grown = num(val($0)) }
/^(read|write|verify): +[0-9]/ { u = num($NF); if ($1 == "read:") uncr = u; else if ($1 == "write:") uncw = u; else uncv = u }
/^Non-medium error count:/ { nonmed = num(val($0)) }
/^Accumulated power on time, hours:minutes/ { t = $0; sub(/^.*hours:minutes +/, "", t); poh = num(t) }
/number of hours powered up =/ { t = $0; sub(/^.*= */, "", t); poh = num(t) }
/^Power On Hours:/      { poh = num(val($0)) }
/^Media and Data Integrity Errors:/ { nvmemedia = num(val($0)) }
/^Error Information Log Entries:/   { nvmeerr = num(val($0)) }
/^Critical Warning:/    { critwarn = val($0) }
/^Percentage Used:/     { pctused = num(val($0)) }
END {
  if (kind == "scsi" && model == "") model = vendor " " product
  if (model ~ /PERC|MegaRAID|MR[0-9]|Virtual|VIRTUAL|BOSS|LOGICAL VOLUME|RAID/ && kind == "scsi") status = "vd"
  if (status == "") status = (serial != "" || health != "" || kind != "") ? "ok" : "nodata"
  printf "SMART\t%s\tosdev=%s\tkind=%s\tstatus=%s\trc=%s\tmodel=%s\tserial=%s\twwn=%s\trot=%s\thealth=%s\tpoh=%s\trealloc=%s\treallocev=%s\tpending=%s\toffunc=%s\trepunc=%s\tcrc=%s\tataerr=%s\tunclog=%s\ticrclog=%s\tstfail=%s\tgrown=%s\tuncr=%s\tuncw=%s\tuncv=%s\tnonmed=%s\tnvmemedia=%s\tnvmeerr=%s\tcritwarn=%s\tpctused=%s\n", \
    handle, osdev, kind, status, rc, model, serial, tolower(wwn), rot, health, poh, realloc, reallocev, pending, offunc, repunc, crc, ataerr, unclog, icrclog, stfail, grown, uncr, uncw, uncv, nonmed, nvmemedia, nvmeerr, critwarn, pctused
}
RDH_AWK_SMART

# ── perc.awk: storcli/perccli 출력 → PD · VD · PEVT 사실 ───────────────────────
#   mode=pd  '/cN/eall/sall show all' · '/cN/sall show all'
#   mode=vd  '/cN/vall show all'
#   mode=evt '/cN show events'
#   형식 근거: StorCLI Reference Manual 의 예시 출력(기억 기반 · 실제 PERC 출력 미대조). perccli 는 storcli 와 같은 형식이라고 가정한다.
cat > "$WORK/perc.awk" <<'RDH_AWK_PERC'
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
function kv(s,   i) { i = index(s, "="); return trim(substr(s, i + 1)) }
function pclass(t) {
  if (t ~ /[Mm]edium error|[Mm]edia error|ad block|unctur/) return "PMEDIA"
  if (match(t, /Unexpected sense.*Sense: ([0-9a-fA-F])\//, pa)) {
    if (pa[1] == "3") return "PMEDIA"
    if (pa[1] == "4") return "PHW"
    if (pa[1] == "1") return "PRECOV"
    if (pa[1] == "b" || pa[1] == "B") return "PXPORT"
    return ""
  }
  if (t ~ /redictive [Ff]ailure|SMART/) return "PPRED"
  if (t ~ /State change.* to (FAILED|Failed|UNCONFIGURED_BAD|Unconfigured Bad|OFFLINE|Offline)|Device failed|[Dd]isk failed/) return "PFAIL"
  if (t ~ /^Removed: PD|[Dd]evice removed|PD .*[Rr]emoved|Physical disk removed/) return "PREM"
  if (t ~ /^Inserted: PD|[Dd]evice inserted|Physical disk inserted/) return "PINS"
  if (t ~ /[Rr]ebuild/) return "PREBUILD"
  if (t ~ /[Rr]eplaced|[Rr]eplace [Mm]issing|[Cc]opyback/) return "PREPL"
  if (t ~ /Command timeout|Error on PD|PD .* reset|[Ll]ink|path/) return "PXPORT"
  if (t ~ /VD .*(reated|eleted)|Created VD|Deleted VD|[Ii]nitialization (started|complete)|Configuration cleared|Foreign/) return "PVD"
  return ""
}
function flush_pd() {
  if (pdkey == "") return
  printf "PD\t%s\tdid=%s\tstate=%s\tdg=%s\tsize=%s\tintf=%s\tmed=%s\tmodel=%s\tsn=%s\twwn=%s\tsasaddr=%s\tmediaerr=%s\tothererr=%s\tpredfail=%s\tsmartalert=%s\n", \
    pdkey, P["did"], P["state"], P["dg"], P["size"], P["intf"], P["med"], P["model"], P["sn"], tolower(P["wwn"]), tolower(P["sasaddr"]), P["mediaerr"], P["othererr"], P["predfail"], P["smartalert"]
  pdkey = ""; split("", P)
}
function flush_vd() {
  if (vdkey == "") return
  ce = ""
  if (V["cdate"] ~ /^[0-9]+-[0-9]+-[0-9]+$/) {
    split(V["cdate"], d, "-"); hh = 0; mi = 0; ss = 0
    if (match(V["ctime"], /^([0-9]+):([0-9]+):([0-9]+) *(AM|PM)?/, tm)) {
      hh = tm[1] + 0; mi = tm[2] + 0; ss = tm[3] + 0
      if (tm[4] == "PM" && hh < 12) hh += 12
      if (tm[4] == "AM" && hh == 12) hh = 0
    }
    ce = mktime(d[3] " " d[2] " " d[1] " " hh " " mi " " ss)
    if (ce < 0) ce = ""
  }
  printf "VD\t%s\ttype=%s\tstate=%s\tosdev=%s\tnaa=%s\tcreated=%s\tcreated_raw=%s %s\tmembers=%s\n", vdkey, V["type"], V["state"], V["osdev"], tolower(V["naa"]), ce, V["cdate"], V["ctime"], V["members"]
  vdkey = ""; split("", V)
}
function flush_evt() {
  if (!inev) return
  inev = 0
  cls = pclass(edesc)
  if (cls == "") return
  pd = ""; did = ""; addr = ""
  if (match(edesc, /PD ([0-9a-fA-F]+)\(e(0x[0-9a-fA-F]+|[0-9]+)\/s([0-9]+)\)/, m)) { did = strtonum("0x" m[1]); pd = ctl ":" strtonum(m[2]) ":" m[3] }
  if (match(edesc, /Path ([0-9a-fA-F]+)/, m) && length(m[1]) == 16) addr = tolower(m[1])
  else if (match(edesc, /sasAddr=([0-9a-fA-F]+)/, m) && length(m[1]) == 16) addr = tolower(m[1])
  gsub(/\t/, " ", edesc)
  printf "PEVT\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", (ets == "" ? 0 : ets), (ets == "" ? "?" : "c"), ctl, pd, did, cls, addr, eseq, substr(edesc, 1, 300)
}
BEGIN {
  split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", mn, " ")
  for (i = 1; i <= 12; i++) MON[mn[i]] = i
  pdkey = ""; vdkey = ""; inev = 0; nev = 0; first = 0; last = 0
}
mode == "pd" {
  if (match($0, /^Drive \/c([0-9]+)(\/e([0-9]+))?\/s([0-9]+) :/, m)) { flush_pd(); pdkey = m[1] ":" m[3] ":" m[4]; next }
  if (pdkey == "") next
  if (match($0, /^ *([0-9]*):([0-9]+) +([0-9]+) +([A-Za-z]+) +([^ ]+) +([0-9.]+ [KMGT]B) +([A-Za-z]+) +([A-Za-z]+)/, m)) {
    P["did"] = m[3]; P["state"] = m[4]; P["dg"] = m[5]; P["size"] = m[6]; P["intf"] = m[7]; P["med"] = m[8]; next
  }
  if ($0 ~ /^Media Error Count *=/) P["mediaerr"] = kv($0)
  else if ($0 ~ /^Other Error Count *=/) P["othererr"] = kv($0)
  else if ($0 ~ /^Predictive Failure Count *=/) P["predfail"] = kv($0)
  else if ($0 ~ /^S\.M\.A\.R\.T alert flagged by drive *=/) P["smartalert"] = kv($0)
  else if ($0 ~ /^SN *=/) P["sn"] = kv($0)
  else if ($0 ~ /^WWN *=/) P["wwn"] = kv($0)
  else if ($0 ~ /^Model Number *=/) P["model"] = kv($0)
  else if (P["sasaddr"] == "" && match($0, /^ *[0-9]+ +[A-Za-z]+ +[0-9.]+Gb\/s +0x([0-9a-fA-F]+)/, m) && m[1] != "0") P["sasaddr"] = m[1]
  next
}
mode == "vd" {
  if (match($0, /^\/c([0-9]+)\/v([0-9]+) :/, m)) { flush_vd(); vdkey = m[1] ":" m[2]; next }
  if (vdkey == "") next
  if (match($0, /^ *([0-9]+)\/([0-9]+) +([A-Za-z0-9]+) +([A-Za-z]+)/, m)) { V["type"] = m[3]; V["state"] = m[4]; next }
  if (match($0, /^ *([0-9]*):([0-9]+) +[0-9]+ +[A-Za-z]+ /, m)) { V["members"] = V["members"] (V["members"] == "" ? "" : ",") m[1] ":" m[2]; next }
  if ($0 ~ /^OS Drive Name *=/) { V["osdev"] = kv($0); sub(/^\/dev\//, "", V["osdev"]) }
  else if ($0 ~ /^SCSI NAA Id *=/) V["naa"] = kv($0)
  else if ($0 ~ /^Creation Date *=/) V["cdate"] = kv($0)
  else if ($0 ~ /^Creation Time *=/) V["ctime"] = kv($0)
  next
}
mode == "evt" {
  if ($0 ~ /^seqNum:/) { flush_evt(); inev = 1; nev++; eseq = trim(substr($0, 8)); ets = ""; edesc = ""; next }
  if (!inev) next
  # 'Time: Sat Nov 14 02:28:11 2026' — 컨트롤러 시계(호스트 시간대와 같다는 보장이 없다 → 표시에 '컨트롤러 시계' 를 붙인다)
  if (match($0, /^Time: +[A-Za-z]+ +([A-Za-z]+) +([0-9]+) +([0-9]+):([0-9]+):([0-9]+) +([0-9]+)/, m)) {
    if (m[1] in MON) { ets = mktime(m[6] " " MON[m[1]] " " m[2] " " m[3] " " m[4] " " m[5]); if (ets < 0) ets = "" }
    if (ets != "") { if (first == 0 || ets < first) first = ets; if (ets > last) last = ets }
    next
  }
  if ($0 ~ /^Event Description:/) { edesc = trim(substr($0, 19)); next }
  next
}
END {
  if (mode == "pd") flush_pd()
  if (mode == "vd") flush_vd()
  if (mode == "evt") {
    flush_evt()
    printf "SRC\tP\t%s\t%s\t%d\t%d\tc\t%d\t%d\t0\n", src, (nev > 0 ? "읽음" : "이벤트 없음(형식이 다르거나 비어 있음)"), first, last, NR, nev
  }
}
RDH_AWK_PERC

# ── lvm.awk: /etc/lvm/backup · archive 의 메타데이터 텍스트 → LVM 사실 ─────────
cat > "$WORK/lvm.awk" <<'RDH_AWK_LVM'
BEGIN { depth = 0; vg = ""; sect = ""; cur = "" }
{
  line = $0; sub(/#.*$/, "", line)
  if (depth == 0 && match(line, /^description *= *"(.*)"/, m)) desc = m[1]
  if (depth == 0 && match(line, /^creation_time *= *([0-9]+)/, m)) top = m[1]
  if (match(line, /^[ \t]*([A-Za-z0-9_.+-]+) *\{/, m)) {
    depth++
    if (depth == 1) vg = m[1]
    else if (depth == 2) sect = m[1]
    else if (depth == 3) cur = m[1]
    next
  }
  if (line ~ /^[ \t]*\}/) { if (depth == 3) cur = ""; if (depth == 2) sect = ""; depth--; next }
  if (depth == 3 && sect == "logical_volumes" && match(line, /creation_time *= *([0-9]+)/, m)) printf "LVM\t%s\t%s\tLV\t%s\t%s\n", m[1], vg, cur, file
  if (depth == 3 && sect == "physical_volumes" && match(line, /device *= *"([^"]+)"/, m)) printf "LVMPV\t%s\t%s\t%s\n", vg, m[1], file
}
END {
  if (kind == "archive" && top != "") { gsub(/\t/, " ", desc); printf "LVM\t%s\t%s\tARCH\t%s\t%s\n", top, vg, desc, file }
  if (kind == "backup" && top != "") printf "LVM\t%s\t%s\tLAST\t마지막 메타데이터 변경\t%s\n", top, vg, file
}
RDH_AWK_LVM

# ── lsblk.awk: lsblk -P 출력 → CUR(디스크) · BLK(트리) 사실 ─────────────────────
cat > "$WORK/lsblk.awk" <<'RDH_AWK_LSBLK'
{
  split("", f)
  s = $0
  while (match(s, /^ *([A-Za-z0-9:_-]+)="([^"]*)"/, m)) { k = m[1]; gsub(/[:-]/, "_", k); f[k] = m[2]; s = substr(s, RLENGTH + 1) }
  name = (f["KNAME"] != "") ? f["KNAME"] : f["NAME"]
  if (name == "") next
  for (k in f) { gsub(/\t/, " ", f[k]); sub(/^ +/, "", f[k]); sub(/ +$/, "", f[k]) }
  if (mode == "disk" && f["TYPE"] == "disk")
    printf "CUR\t%s\tserial=%s\twwn=%s\tmodel=%s\tvendor=%s\tsize=%s\ttran=%s\thctl=%s\trota=%s\n", name, f["SERIAL"], tolower(f["WWN"]), f["MODEL"], f["VENDOR"], f["SIZE"], f["TRAN"], f["HCTL"], f["ROTA"]
  if (mode == "tree")
    printf "BLK\t%s\t%s\t%s\t%s\t%s\t%s\n", name, f["PKNAME"], f["TYPE"], f["FSTYPE"], f["MOUNTPOINT"], f["NAME"]
}
RDH_AWK_LSBLK
}

# ── analyze.awk: 모은 사실(facts.tsv)을 읽어 판정하고 보고서를 낸다 ─────────────
#   출력 줄 머리: 'S|' = 화면 + 파일 · 'F|' = 파일에만 · 'X|' = 종료 코드
#   원칙: 못 읽은 값은 0 · 정상으로 치지 않는다(빈 문자열 = 불명). '기록 없음' 은 항상 근거 구간과 함께 말한다.
write_analyze_program() {
cat > "$WORK/analyze.awk" <<'RDH_AWK_ANALYZE'
BEGIN { FS = "\t"; n = 0; nsrc = 0; ncmd = 0; nfs = 0; nid = 0; npe = 0; nsm = 0; npd = 0; nvd = 0; nlvm = 0; nhist = 0; nnote = 0; ncur = 0; nmd = 0; nsmerr = 0 }

function S(s) { print "S|" s }
function F(s) { print "F|" s }
function kvparse(from, arr,   i, p) { for (i = from; i <= NF; i++) { p = index($i, "="); if (p > 1) arr[substr($i, 1, p - 1)] = substr($i, p + 1) } }
function ts(t, fl,   s) {
  if (t + 0 <= 0) return "시각 불명"
  s = strftime("%Y-%m-%d %H:%M", t)
  if (fl == "y") s = s "(연도 추정)"
  else if (fl == "d") s = s "(dmesg 환산)"
  else if (fl == "c") s = s "(컨트롤러 시계)"
  return s
}
function nolead(s) { sub(/^ · /, "", s); return s }     # 목록 머리의 구분점 제거(LC_ALL=C 에서는 가운뎃점이 2바이트라 substr 로 자르면 깨진다)
function day(t) { return (t + 0 > 0) ? strftime("%Y-%m-%d", t) : "시각 불명" }
function isnum(v) { return (v != "" && v ~ /^[0-9]+$/) }
function pos(v) { return (isnum(v) && v + 0 > 0) }

function basedisk(d) {
  if (d ~ /^nvme[0-9]+n[0-9]+p[0-9]+$/) { sub(/p[0-9]+$/, "", d); return d }
  if (d ~ /^(sd|vd|xvd|hd)[a-z]+[0-9]+$/) { sub(/[0-9]+$/, "", d); return d }
  if (d ~ /^mmcblk[0-9]+p[0-9]+$/) { sub(/p[0-9]+$/, "", d); return d }
  return d
}
function devclass(b) {
  if (b ~ /^(sr|scd|fd|loop|ram|zram|nbd|rbd|mmcblk|mtdblock|st|sg)[0-9]/) return "excl"
  if (b ~ /^dm-/) return "dm"
  if (b ~ /^md[0-9]/) return "md"
  if (b ~ /^nvme/) return "nvme"
  if (b ~ /^ata[0-9]/) return "ata"
  if (b ~ /^(sd|vd|xvd|hd)[a-z]+$/) return "sd"
  if (b ~ /^(megaraid|cciss|areca|3ware),/) return "pdsmart"
  if (b ~ /^pd:/) return "pdctl"
  if (b ~ /^hctl:/) return "hctl"
  return "other"
}
function drvclass(d) {
  if (d ~ /usb-storage|uas/) return "usb"
  if (d ~ /iSCSI|iscsi/) return "iscsi"
  if (d ~ /qla2xxx|lpfc|bfa|fnic|qedf|bnx2fc/) return "fc"
  if (d ~ /MegaRAID|megaraid|PERC|smartpqi|hpsa|aacraid/) return "raid"
  if (d ~ /ahci|ata_piix|sata|pata/) return "sata"
  if (d ~ /mpt[23]sas|Fusion MPT|pm80xx|mvsas|isci/) return "sas"
  if (d ~ /virtio|vmw_pvscsi|storvsc|VMware/) return "virt"
  return ""
}
function tranlabel(t) {
  if (t == "usb") return "USB 이동식"
  if (t == "iscsi") return "iSCSI LUN"
  if (t == "fc") return "FC LUN"
  if (t == "raid") return "RAID 가상 디스크"
  if (t == "sata") return "SATA 직결"
  if (t == "sas") return "SAS/HBA 직결"
  if (t == "nvme") return "NVMe"
  if (t == "virt") return "가상 머신 디스크"
  return "종류 불명"
}
function bootof(t,   i) { for (i = nboots; i >= 1; i--) if (boots[i] <= t + 60) return boots[i]; return 0 }
# 사건 시각의 전송 종류: 그 부팅의 'scsi hostN: <드라이버>' 줄(로그) → 없으면 현재 lsblk 기준
function tranof(b, t,   bt, h, q) {
  TRSRC = ""
  if (devclass(b) == "nvme") { TRSRC = "이름"; return "nvme" }
  bt = bootof(t)
  if ((bt, b) in d2h) {
    h = d2h[bt, b]; split(h, q, ":")
    if ((bt, q[1]) in hostdrv) { TRSRC = "그때의 부팅 로그"; return drvclass(hostdrv[bt, q[1]]) }
  }
  if (b in curclass) { TRSRC = "현재 lsblk 기준(그때와 다를 수 있음)"; return curclass[b] }
  return ""
}
function sn_norm(s) { s = toupper(s); gsub(/[ _-]/, "", s); return s }
function wwn_norm(w) { w = tolower(w); sub(/^(0x|naa\.|eui\.|wwn-0x)/, "", w); gsub(/[ :-]/, "", w); return w }
function add_cur_sn(s, where,   k) { k = sn_norm(s); if (length(k) < 4) return; if (!(k in cur_sn)) cur_sn[k] = where }
function add_cur_wwn(w, where,   k) { k = wwn_norm(w); if (length(k) < 8) return; if (!(k in cur_wwn)) cur_wwn[k] = where }
function sn_cur_find(s,   k, c, lk, ln) {
  k = sn_norm(s); if (k == "") return ""
  if (k in cur_sn) return cur_sn[k]
  ln = length(k)
  if (ln < 8) return ""
  for (c in cur_sn) {
    lk = length(c)
    if (lk < 8) continue
    if (lk >= ln && substr(c, lk - ln + 1) == k) return cur_sn[c] " [끝자리 일치]"
    if (ln > lk && substr(k, ln - lk + 1) == c) return cur_sn[c] " [끝자리 일치]"
  }
  return ""
}
function wwn_cur_find(w,   k, c) {
  k = wwn_norm(w); if (k == "") return ""
  if (k in cur_wwn) return cur_wwn[k]
  if (length(k) == 16) for (c in cur_wwn) if (length(c) == 16 && substr(c, 1, 15) == substr(k, 1, 15)) return cur_wwn[c] " [마지막 자리만 다름 — SAS 포트 주소]"
  return ""
}
function near(arr, b, m) { return ((b, m) in arr) || ((b, m - 1) in arr) || ((b, m + 1) in arr) }
function xnear(b, m, t,   h) {
  if (near(hasX, b, m)) return 1
  if ((m in ctxX) || ((m - 1) in ctxX) || ((m + 1) in ctxX)) return 1
  h = bootof(t)
  if ((h, b) in d2h) return near(hasX, "hctl:" d2h[h, b], m)
  return 0
}
function attach_between(b, a, z,   q, k, i) { k = split(att[b], q, " "); for (i = 1; i <= k; i++) if (q[i] + 0 > a && q[i] + 0 <= z) return q[i] + 0; return 0 }
function clslabel(c) {
  if (c == "MEDIA") return "미디어 오류"
  if (c == "IOERR") return "I/O 오류"
  if (c == "HWERR") return "하드웨어 오류"
  if (c == "RECOV") return "복구된 오류"
  if (c == "XPORT" || c == "XPORTCTX") return "전송·경로"
  if (c == "OTHER") return "기타(결함 아님)"
  if (c == "FSIO") return "파일시스템 I/O 오류"
  if (c == "FSCTX") return "파일시스템 중단"
  if (c == "SMARTSTATE") return "smartd 불량 섹터 보고"
  if (c == "SMARTERR") return "smartd 오류 증가"
  if (c == "SMARTFAIL") return "SMART 실패 보고"
  if (c == "SMARTCHG") return "SMART 값 변화"
  if (c == "CTRLMSG") return "컨트롤러 알림"
  if (c == "ATACTX") return "ATA 명령 실패"
  return c
}
function stlabel(s) {
  if (s == "M") return "messages"
  if (s == "S") return "secure"
  if (s == "X") return "추가 로그"
  if (s == "J") return "journal"
  if (s == "JH") return "journal 전체"
  if (s == "D") return "dmesg"
  if (s == "O") return "dmesg 사본"
  if (s == "P") return "컨트롤러 이벤트"
  if (s == "H") return "셸 기록"
  return s
}
function evline(i,   s) {
  s = sprintf("[%s/%s] %s", clslabel(ecls[i]), esub[i], ts(ef[i], efl[i]))
  if (el[i] > ef[i] + 59) s = s "~" strftime("%H:%M", el[i])
  s = s sprintf(" ×%d건", ecnt[i])
  if (ecls[i] == "SMARTSTATE" || ecls[i] == "SMARTERR") s = s sprintf(" (값 최대 %d)", emax[i])
  s = s sprintf(" | %s:%s", esrc[i], elno[i])
  if (ealso[i] != "") s = s " (같은 기록:" ealso[i] ")"
  return s
}
function print_evidence(b,   q, k, i, head, tail) {
  k = split(sev[b], q, " ")
  if (k == 0) return
  head = (k > MAXEV) ? MAXEV - 5 : k; if (head < 1) head = 1
  tail = (k > MAXEV) ? 5 : 0
  for (i = 1; i <= head; i++) { F("      " evline(q[i])); F("        > " eline[q[i]]) }
  if (k > head + tail) F(sprintf("      … 중간 %d묶음 생략(--max-evidence 로 늘릴 수 있음) …", k - head - tail))
  for (i = k - tail + 1; i <= k && tail > 0; i++) { F("      " evline(q[i])); F("        > " eline[q[i]]) }
}

$1 == "META" { meta[$2] = $3; next }
$1 == "CMD"  { ncmd++; cname[ncmd] = $2; crc[ncmd] = $3; cst[ncmd] = $4; cline[ncmd] = $5; cmdst[$2] = $4; next }
$1 == "SRC"  { nsrc++; sst[nsrc] = $2; sname[nsrc] = $3; sstat[nsrc] = $4; sfe[nsrc] = $5 + 0; sle[nsrc] = $6 + 0; sfl[nsrc] = $7; slines[nsrc] = $8 + 0; sev_n[nsrc] = $9 + 0; sboot[nsrc] = $10 + 0; next }
$1 == "NOTE" { nnote++; note[nnote] = $2; next }
$1 == "EVT"  { n++; ef[n] = $2 + 0; el[n] = $3 + 0; efl[n] = $4; est[n] = $5; esrc[n] = $6; elno[n] = $7; ecls[n] = $8; esub[n] = $9; edev[n] = $10; ehctl[n] = $11; ecnt[n] = $12 + 0; ekx[n] = $13; eextra[n] = $14; emax[n] = $15 + 0; eline[n] = $16; next }
$1 == "CUR"  { ncur++; cur[ncur] = $2; split("", kv); kvparse(3, kv); c_serial[$2] = kv["serial"]; c_wwn[$2] = kv["wwn"]; c_model[$2] = kv["model"]; c_vendor[$2] = kv["vendor"]; c_size[$2] = kv["size"]; c_tran[$2] = kv["tran"]; c_hctl[$2] = kv["hctl"]; next }
$1 == "BYID" { nby++; by_link[nby] = $2; by_tgt[nby] = $3; next }
$1 == "DM"   { dm_name[$2] = $3; dm_slaves[$2] = $4; next }
$1 == "SMART" { nsm++; sm[nsm] = $2; split("", kv); kvparse(3, kv); for (k in kv) smv[$2, k] = kv[k]; next }
$1 == "SMERR" { nsmerr++; se_h[nsmerr] = $2; se_poh[nsmerr] = $3; se_txt[nsmerr] = $4; next }
$1 == "PD"   { npd++; pd[npd] = $2; split("", kv); kvparse(3, kv); for (k in kv) pdv[$2, k] = kv[k]; pdidx[$2] = npd; next }
$1 == "VD"   { nvd++; vd[nvd] = $2; split("", kv); kvparse(3, kv); for (k in kv) vdv[$2, k] = kv[k]; next }
$1 == "PEVT" { npe++; pe_t[npe] = $2 + 0; pe_fl[npe] = $3; pe_ctl[npe] = $4; pe_pd[npe] = $5; pe_did[npe] = $6; pe_cls[npe] = $7; pe_addr[npe] = $8; pe_seq[npe] = $9; pe_txt[npe] = $10; next }
$1 == "FS"   { nfs++; fs_dev[nfs] = $2; fs_type[nfs] = $3; fs_mnt[nfs] = $4; fs_t[nfs] = $5; fs_how[nfs] = $6; fs_disks[nfs] = $7; next }
$1 == "LVM"  { nlvm++; lv_t[nlvm] = $2 + 0; lv_vg[nlvm] = $3; lv_kind[nlvm] = $4; lv_name[nlvm] = $5; lv_file[nlvm] = $6; next }
$1 == "LVMPV" { if (index(lvmpv[$2] " ", " " $3 " ") == 0) lvmpv[$2] = lvmpv[$2] " " $3; next }
$1 == "MD"   { nmd++; md_name[nmd] = $2; md_t[nmd] = $3; md_members[nmd] = $4; next }
$1 == "OSINST" { osinst = $2 + 0; osinst_how = $3; next }
$1 == "HIST" { nhist++; h_t[nhist] = $2 + 0; h_cmd[nhist] = $3; next }

# ── 1단계: 부팅 경계 · 중복 제거 · 맥락 ────────────────────────────────────────
function prep(   i, k, j, m, d, dup, q, b, c) {
  nboots = 0
  for (i = 1; i <= n; i++) if (ecls[i] == "BOOT" && ef[i] > 0) { if (nboots == 0 || ef[i] - boots[nboots] > 300) boots[++nboots] = ef[i] }
  # 같은 커널 줄이 messages · journal · dmesg 에 각각 남는다 → (분 · 분류 · 세부 · 장치 · 키)가 같으면 하나로 보고 건수는 큰 쪽을 쓴다.
  # (회전 경계의 같은 분이 두 파일에 걸치면 조금 적게 센다 — 두 번 세는 것보다 낫다고 봤다)
  for (i = 1; i <= n; i++) {
    if (est[i] == "D") continue
    if (ef[i] <= 0) { keep[i] = 1; continue }
    k = int(ef[i] / 60) SUBSEP ecls[i] SUBSEP esub[i] SUBSEP edev[i] SUBSEP ekx[i]
    if (k in seen) {
      j = seen[k]
      if (ecnt[i] > ecnt[j]) ecnt[j] = ecnt[i]
      if (emax[i] > emax[j]) emax[j] = emax[i]
      if (el[i] > el[j]) el[j] = el[i]
      ealso[j] = ealso[j] " " esrc[i]
      continue
    }
    seen[k] = i; keep[i] = 1
  }
  # dmesg 시각은 '지금 − 가동 시간 + 초' 로 환산한 근사값이라 ±5분 안에 같은 사건이 있으면 중복으로 본다
  for (i = 1; i <= n; i++) {
    if (est[i] != "D") continue
    if (ef[i] <= 0) { keep[i] = 1; continue }
    m = int(ef[i] / 60); dup = 0
    for (d = -5; d <= 5 && !dup; d++) {
      k = (m + d) SUBSEP ecls[i] SUBSEP esub[i] SUBSEP edev[i] SUBSEP ekx[i]
      if (k in seen) { dup = 1; ealso[seen[k]] = ealso[seen[k]] " dmesg" }
    }
    if (!dup) { seen[m SUBSEP ecls[i] SUBSEP esub[i] SUBSEP edev[i] SUBSEP ekx[i]] = i; keep[i] = 1 }
  }
  for (i = 1; i <= n; i++) {
    if (!keep[i]) continue
    c = ecls[i]; b = basedisk(edev[i]); m = int(ef[i] / 60)
    if (ef[i] > 0) {
      if (c == "MEDIA") hasM[b, m] = 1
      else if (c == "XPORT" && b != "") hasX[b, m] = 1
      else if (c == "XPORTCTX") ctxX[m] = 1
      else if (c == "HOST") { split(ekx[i], q, "|"); hostdrv[bootof(ef[i]), q[1]] = q[2] }
      else if (c == "INQ") inq[bootof(ef[i]), ehctl[i]] = ekx[i]
      else if (c == "ATTACH") att[b] = att[b] " " ef[i]
      if (ehctl[i] != "" && edev[i] ~ /^sd[a-z]+$/) d2h[bootof(ef[i]), edev[i]] = ehctl[i]
    }
    if (c == "SMARTID") {
      nid++; id_t[nid] = ef[i]; id_fl[nid] = efl[i]; id_dev[nid] = edev[i]; id_ev[nid] = i
      split(ekx[i], q, "|"); id_sn[nid] = q[1]; id_wwn[nid] = q[2]; id_model[nid] = q[3]
      k = sn_norm(q[1])
      if (k != "") {
        if (!(k in hs_first) || (ef[i] > 0 && ef[i] < hs_first[k])) hs_first[k] = ef[i]
        if (!(k in hs_last) || ef[i] >= hs_last[k]) { hs_last[k] = ef[i]; hs_dev[k] = edev[i]; hs_model[k] = q[3]; hs_raw[k] = q[1]; hs_wwn[k] = q[2]; hs_ev[k] = i }
      }
    }
    if (c == "FMTCMD") { nhist++; h_t[nhist] = ef[i]; h_cmd[nhist] = ekx[i] " (" esrc[i] ":" elno[i] ")" }
  }
}

# ── 2단계: 현재 디스크 · 식별자 집합 ───────────────────────────────────────────
function build_current(   i, d, t, m, s, h, k, link, q, kn) {
  for (i = 1; i <= ncur; i++) {
    d = cur[i]; t = c_tran[d]; m = c_vendor[d] " " c_model[d]
    if (devclass(d) == "excl") curclass[d] = "excl"
    else if (t == "usb") curclass[d] = "usb"
    else if (t == "iscsi") curclass[d] = "iscsi"
    else if (t == "fc") curclass[d] = "fc"
    else if (m ~ /PERC|MegaRAID|MR[0-9][0-9]|RAID|LOGICAL VOLUME|ServeRAID|BOSS|Virtual Disk/) curclass[d] = "raid"
    else if (d ~ /^nvme/) curclass[d] = "nvme"
    else if (t == "sata" || t == "ata") curclass[d] = "sata"
    else if (t == "sas") curclass[d] = "sas"
    else if (t == "virtio" || m ~ /VMware|QEMU|Virtual/) curclass[d] = "virt"
    else curclass[d] = ""
    if (curclass[d] == "raid") { nvdcur++; continue }
    if (curclass[d] == "excl" || curclass[d] == "usb" || curclass[d] == "iscsi" || curclass[d] == "fc" || curclass[d] == "virt") continue
    curphys[d] = 1
    if (c_serial[d] != "") { cursn_of[d] = c_serial[d]; add_cur_sn(c_serial[d], d "(lsblk)") }
    if (c_wwn[d] != "") { curwwn_of[d] = c_wwn[d]; add_cur_wwn(c_wwn[d], d "(lsblk)") }
  }
  for (i = 1; i <= nsm; i++) {
    h = sm[i]
    if (smv[h, "status"] != "ok") continue
    s = smv[h, "serial"]; d = smv[h, "osdev"]
    if (h ~ /megaraid/) nsm_mr++
    if (s != "") { add_cur_sn(s, h "(smartctl)"); if (d != "" && (d in curphys) && cursn_of[d] == "") cursn_of[d] = s }
    if (smv[h, "wwn"] != "") { add_cur_wwn(smv[h, "wwn"], h "(smartctl)"); if (d != "" && (d in curphys) && curwwn_of[d] == "") curwwn_of[d] = smv[h, "wwn"] }
    if (d != "") { smart_of[d] = h; if (d ~ /^nvme[0-9]+$/) smart_of[d "n1"] = h }
  }
  for (i = 1; i <= npd; i++) {
    k = pd[i]
    if (pdv[k, "sn"] != "") add_cur_sn(pdv[k, "sn"], "PERC 슬롯 " k "(storcli)")
    if (pdv[k, "wwn"] != "") add_cur_wwn(pdv[k, "wwn"], "PERC 슬롯 " k "(storcli)")
    if (pdv[k, "sasaddr"] != "") add_cur_wwn(pdv[k, "sasaddr"], "PERC 슬롯 " k " SAS 주소(storcli)")
  }
  for (i = 1; i <= nby; i++) {
    link = by_link[i]; d = by_tgt[i]
    if (link ~ /-part[0-9]+$/) continue
    if (!(d in curphys)) continue
    if (link ~ /^wwn-0x/) { add_cur_wwn(link, d "(by-id)"); if (curwwn_of[d] == "") curwwn_of[d] = wwn_norm(link) }
    else if (link ~ /^(ata|nvme|scsi-S)[-A-Za-z0-9]*_/ && link !~ /^nvme-(eui|nvme)\./) {
      kn = split(link, q, "_"); s = q[kn]
      if (length(s) >= 6) { add_cur_sn(s, d "(by-id)"); if (cursn_of[d] == "") cursn_of[d] = s }
    }
  }
  cur_unknown = 0
  for (d in curphys) if (cursn_of[d] == "") { cur_unknown++; cur_unknown_list = cur_unknown_list " " d }
  vd_blind = (nvdcur > 0 && npd == 0 && nsm_mr == 0) ? 1 : 0
  coverage_ok = (cur_unknown == 0 && !vd_blind) ? 1 : 0
  if (!coverage_ok) {
    coverage_why = ""
    if (cur_unknown > 0) coverage_why = "시리얼을 못 읽은 현재 디스크 " cur_unknown "대(" substr(cur_unknown_list, 2) ")"
    if (vd_blind) coverage_why = coverage_why (coverage_why == "" ? "" : " · ") "RAID 가상 디스크 뒤의 물리 디스크 시리얼을 못 읽음(storcli/perccli · smartctl -d megaraid 결과 없음)"
  }
}

# ── 3단계: 장치별 집계 · 판정 ① ────────────────────────────────────────────────
function aggregate(   i, c, b, m, cnt, faulty, kind) {
  for (i = 1; i <= n; i++) {
    if (!keep[i]) continue
    c = ecls[i]
    if (c == "BOOT" || c == "HOST" || c == "INQ" || c == "ATTACH" || c == "SMARTID" || c == "SASSEEN" || c == "SASREM" || c == "FMTCMD" || c == "XPORTCTX") continue
    if (edev[i] == "") continue
    b = basedisk(edev[i]); m = int(ef[i] / 60); cnt = ecnt[i]
    if (!(b in subj)) { subj[b] = 1; nsubj++ }
    sev[b] = sev[b] " " i
    faulty = 0
    if (c == "MEDIA") {
      # 읽기 실패 한 번이 sense key · ASC · blk 줄을 각각 남긴다 → 줄 수를 그대로 '건' 으로 세면 부풀려진다.
      # 같은 분 안에서는 줄 종류별 건수 중 가장 큰 값을 그 분의 회수로 본다.
      a_medialines[b] += cnt; faulty = 1
      mmsum[b, m, esub[i]] += cnt
      if (mmsum[b, m, esub[i]] > mmmax[b, m]) { a_media[b] += mmsum[b, m, esub[i]] - mmmax[b, m]; mmmax[b, m] = mmsum[b, m, esub[i]] }
    }
    else if (c == "IOERR" || c == "FSIO") {
      kind = (c == "IOERR") ? "io" : "fs"
      if (ef[i] > 0 && near(hasM, b, m)) { a_withm[b, kind] += cnt; faulty = 1 }
      else if (ef[i] > 0 && xnear(b, m, ef[i])) a_withx[b, kind] += cnt
      else { a_plain[b, kind] += cnt; faulty = 1 }
    }
    else if (c == "HWERR") { a_hw[b] += cnt; faulty = 1 }
    else if (c == "SMARTSTATE") { if (emax[i] > a_ssmax[b, esub[i]]) a_ssmax[b, esub[i]] = emax[i]; a_ssrep[b] += cnt; if (emax[i] > 0) faulty = 1 }
    else if (c == "SMARTERR") { a_smerr[b] += cnt; faulty = 1 }
    else if (c == "SMARTFAIL") { a_smfail[b] += cnt; faulty = 1 }
    else if (c == "SMARTCHG") { a_smchg[b] += cnt; faulty = 1 }
    else if (c == "CTRLMSG") { if (esub[i] == "PMEDIA") { a_cmedia[b] += cnt; faulty = 1 } else if (esub[i] == "PPRED" || esub[i] == "PFAIL" || esub[i] == "PHW") { a_cfault[b] += cnt; faulty = 1 } else a_cinfo[b] += cnt }
    else if (c == "XPORT") a_xport[b] += cnt
    else if (c == "RECOV") a_recov[b] += cnt
    else if (c == "OTHER") a_other[b] += cnt
    else if (c == "FSCTX") a_fsctx[b] += cnt
    else if (c == "ATACTX") a_atactx[b] += cnt
    if (ef[i] <= 0) a_notime[b] += cnt
    if (faulty && ef[i] > 0) {
      if (!(b in a_first) || ef[i] < a_first[b]) { a_first[b] = ef[i]; a_firstfl[b] = efl[i] }
      if (!(b in a_last) || el[i] > a_last[b]) { a_last[b] = el[i]; a_lastfl[b] = efl[i] }
    }
  }
}
function judge1(   b, t, cl) {
  for (b in subj) {
    cl = devclass(b)
    t = tranof(b, (b in a_last) ? a_last[b] : NOW); s_tran[b] = t; s_trsrc[b] = TRSRC
    if (cl == "excl" || t == "usb") { v1[b] = "E"; continue }
    if (a_media[b] > 0 || a_ssmax[b, "pending-sectors"] > 0 || a_ssmax[b, "offline-uncorrectable"] > 0 || a_cmedia[b] > 0) v1[b] = "C"
    else if (a_plain[b, "io"] > 0 || a_plain[b, "fs"] > 0 || a_hw[b] > 0 || a_smerr[b] > 0 || a_smfail[b] > 0 || a_smchg[b] > 0 || a_cfault[b] > 0) v1[b] = "L"
    else v1[b] = "X"
    if (v1[b] == "C") nC++; else if (v1[b] == "L") nL++; else nX++
  }
}

# ── 판정 ③: 식별자(시리얼 · WWN) 연결 ──────────────────────────────────────────
function find_id(b, t1, t2,   i, bt, before, after, alt) {
  ID_STRENGTH = ""; ID_WHY = ""
  alt = b; if (b ~ /^nvme[0-9]+n[0-9]+$/) sub(/n[0-9]+$/, "", alt)
  bt = bootof(t2); before = 0; after = 0
  for (i = 1; i <= nid; i++) {
    if (id_dev[i] != b && id_dev[i] != alt) continue
    if (id_t[i] <= 0 || bootof(id_t[i]) != bt) continue
    if (id_t[i] <= t2) { if (!before || id_t[i] > id_t[before]) before = i }
    else if (!after || id_t[i] < id_t[after]) after = i
  }
  if (before) {
    if (attach_between(b, id_t[before], t1)) { ID_STRENGTH = "W"; ID_WHY = "시리얼 기록과 오류 사이에 같은 이름으로 장치가 다시 연결된 흔적이 있습니다" }
    else ID_STRENGTH = "S"
    return before
  }
  if (after) {
    ID_STRENGTH = "W"
    ID_WHY = attach_between(b, t2, id_t[after]) ? "오류 뒤 같은 이름으로 장치가 다시 연결된 다음의 시리얼 기록입니다" : "같은 부팅 안이지만 오류보다 나중에 남은 시리얼 기록입니다"
    return after
  }
  return 0
}
function smart_fault(h,   r) {     # 현재 디스크의 누적 오류값: 1=미디어 계열 있음 0=읽었고 없음 ""=못 읽음
  if (smv[h, "status"] != "ok") return ""
  if (pos(smv[h, "realloc"]) || pos(smv[h, "pending"]) || pos(smv[h, "offunc"]) || pos(smv[h, "repunc"]) || pos(smv[h, "grown"]) || pos(smv[h, "uncr"]) || pos(smv[h, "uncw"]) || pos(smv[h, "uncv"]) || pos(smv[h, "nvmemedia"]) || pos(smv[h, "unclog"]) || pos(smv[h, "stfail"])) return 1
  if (smv[h, "kind"] == "ata" && isnum(smv[h, "realloc"]) && (isnum(smv[h, "pending"]) || isnum(smv[h, "offunc"]))) return 0
  if (smv[h, "kind"] == "scsi" && (isnum(smv[h, "grown"]) || isnum(smv[h, "uncr"]))) return 0
  if (smv[h, "kind"] == "nvme" && isnum(smv[h, "nvmemedia"])) return 0
  return ""
}
function judge3(   b, cl, i, sn, w, c, t1, t2, a, h, born, sf, q, hc, repl, same, m) {
  for (b in subj) {
    if (v1[b] != "C" && v1[b] != "L") continue
    cl = devclass(b)
    if (cl == "dm" || cl == "md") { v3[b] = "N"; r3[b] = "가상 장치(" cl ")라 디스크 식별자가 없습니다 — 하위 물리 디스크의 판정을 보십시오."; continue }
    if (cl == "ata") { v3[b] = "U"; r3[b] = "SATA 포트 이름(ataN)만 남아 있고 sd 이름 · 시리얼과 연결할 줄이 없습니다 — 같은 시각의 sdX 판정을 보십시오."; continue }
    if (cl == "pdctl") { v3[b] = "U"; r3[b] = "컨트롤러 감시 유틸의 syslog 에는 슬롯만 있습니다 — 아래 'PERC 슬롯' 판정을 보십시오."; continue }
    if (s_tran[b] == "iscsi" || s_tran[b] == "fc") { v3[b] = "N"; r3[b] = "SAN LUN 입니다 — 물리 디스크 교체 여부는 스토리지 장비에서 확인해야 합니다."; continue }
    if (!(b in a_first)) { v3[b] = "U"; r3[b] = "오류 시각을 알 수 없어(시각 없는 출처) 그때의 식별자와 연결할 수 없습니다."; continue }
    t1 = a_first[b]; t2 = a_last[b]
    i = find_id(b, t1, t2)
    if (i) {
      sn = id_sn[i]; w = id_wwn[i]
      c = sn_cur_find(sn); if (c == "" && w != "") c = wwn_cur_find(w)
      id3[b] = i
      a = sprintf("오류 당시 식별자: S/N %s%s (%s) — smartd 기록 %s %s:%s", sn, (w != "" ? " · WWN " w : ""), id_model[i], ts(id_t[i], id_fl[i]), esrc[id_ev[i]], elno[id_ev[i]])
      if (c != "") {
        same3[b] = 1
        if (ID_STRENGTH == "S") { v3[b] = "C"; r3[b] = "그대로 있음(교체되지 않음) — 현재 " c " 와 시리얼 일치. " a }
        else { v3[b] = "L"; r3[b] = "그대로 있는 것으로 보임 — 현재 " c " 와 시리얼 일치. 다만 " ID_WHY ". " a }
      } else if (coverage_ok) {
        gone3[b] = 1
        if (ID_STRENGTH == "S") { v3[b] = "C"; r3[b] = "현재 없음(교체 · 제거됨) — 지금 읽히는 시리얼 · WWN 어디에도 없습니다. " a }
        else { v3[b] = "L"; r3[b] = "현재 없는 것으로 보임 — 지금 읽히는 시리얼 어디에도 없습니다. 다만 " ID_WHY ". " a }
      } else {
        gone3[b] = 1; v3[b] = "L"
        r3[b] = "현재 읽힌 시리얼 중에는 없음(교체 · 제거 가능성) — 단 " coverage_why " 이 있어 그중 하나일 수 있습니다. " a
      }
      continue
    }
    # 식별자 연결 근거가 없을 때: 정황만 모은다
    hc = ""; repl = 0; same = 0
    a = attach_between(b, t2, NOW)
    if (a && bootof(a) > 0 && a - bootof(a) > 600) { repl++; hc = hc " · 마지막 오류 뒤 가동 중에(" ts(a) ") 같은 이름으로 장치가 새로 연결됨" }
    q = bootof(t2)
    if (((q, b) in d2h) && ((q, d2h[q, b]) in inq) && (b in c_model) && c_model[b] != "") {
      split(inq[q, d2h[q, b]], m, "|")
      if (m[2] != "" && index(c_model[b], m[2]) == 0 && index(m[2], c_model[b]) == 0) { repl++; hc = hc " · 그때의 모델(" m[2] ")과 현재 모델(" c_model[b] ")이 다름" }
    }
    h = smart_of[b]
    if (h != "" && smv[h, "status"] == "ok") {
      sf = smart_fault(h)
      if (isnum(smv[h, "poh"])) {
        born = NOW - smv[h, "poh"] * 3600
        if (born > t2 + 86400) { repl++; hc = hc " · 현재 " b " 디스크의 누적 가동 시간(" smv[h, "poh"] "h)으로 보면 첫 가동이 " day(born) " 무렵으로, 마지막 오류보다 뒤" }
        else if (sf == 1) { same++; hc = hc " · 현재 " b " 디스크가 오류 이전부터 가동 중이고(" smv[h, "poh"] "h) 누적 오류값이 있음" }
      } else if (sf == 1) { same++; hc = hc " · 현재 " b " 디스크에 누적 오류값이 있음" }
    }
    if (repl > 0 && same == 0) { v3[b] = "L"; r3[b] = "교체된 것으로 보임 — 시리얼 연결 근거는 없고 정황만 있습니다: " nolead(hc) }
    else if (same > 0 && repl == 0) { v3[b] = "L"; r3[b] = "그대로 있는 것으로 보임 — 시리얼 연결 근거는 없고 정황만 있습니다: " nolead(hc) }
    else {
      v3[b] = "U"
      r3[b] = "커널 로그에는 장치 이름(" b ")만 있고, 그 시각의 시리얼 · WWN 과 연결할 근거(smartd 시작 로그 등)가 근거 구간 안에 없습니다." (hc != "" ? " 엇갈리는 정황: " nolead(hc) : "")
    }
  }
}

# ── 판정 ②: 포맷 후 재사용 ─────────────────────────────────────────────────────
function fs_on(b, out,   i, k, q, j, c) {   # b 위에 놓인 파일시스템 번호 목록
  c = 0
  for (i = 1; i <= nfs; i++) {
    k = split(fs_disks[i], q, ",")
    for (j = 1; j <= k; j++) if (q[j] == b) { out[++c] = i; break }
  }
  return c
}
function fsdesc(i) { return sprintf("%s(%s%s) 생성 %s[%s]", fs_dev[i], fs_type[i], (fs_mnt[i] != "" ? " " fs_mnt[i] : ""), (isnum(fs_t[i]) ? ts(fs_t[i]) : "시각 불명"), fs_how[i]) }
function judge2(   b, cl, k, lst, i, t1, nafter, nknown, da, db, j, q, kk, cmdhit) {
  for (b in subj) {
    if (v1[b] != "C" && v1[b] != "L") continue
    cl = devclass(b)
    if (cl != "sd" && cl != "nvme" && cl != "md" && cl != "dm") { v2[b] = "N"; continue }
    if (!(b in a_first)) { v2[b] = "U"; r2[b] = "오류 시각을 알 수 없어 파일시스템 생성 시각과 비교할 수 없습니다."; continue }
    t1 = a_first[b]
    split("", lst); k = fs_on(b, lst)
    nafter = 0; nknown = 0; da = ""; db = ""
    for (i = 1; i <= k; i++) {
      if (!isnum(fs_t[lst[i]])) { db = db " · " fsdesc(lst[i]); continue }
      nknown++
      if (fs_t[lst[i]] + 0 > t1) { nafter++; da = da " · " fsdesc(lst[i]) } else db = db " · " fsdesc(lst[i])
    }
    for (i = 1; i <= nmd; i++) {
      kk = split(md_members[i], q, ",")
      for (j = 1; j <= kk; j++) if (basedisk(q[j]) == b && isnum(md_t[i])) {
        nknown++
        if (md_t[i] + 0 > t1) { nafter++; da = da " · md " md_name[i] " 생성 " ts(md_t[i]) } else db = db " · md " md_name[i] " 생성 " ts(md_t[i])
      }
    }
    cmdhit = ""
    for (i = 1; i <= nhist; i++) if (h_t[i] > t1 && index(h_cmd[i], "/dev/" b)) cmdhit = cmdhit " · " ts(h_t[i]) " " h_cmd[i]
    if (nafter > 0) {
      if (cmdhit != "") da = da " · 같은 장치 이름으로 실행한 포맷 계열 명령 기록 — " nolead(cmdhit)
      if (same3[b] && v3[b] == "C") { v2[b] = "C"; r2[b] = "포맷 후 재사용 — 첫 오류(" ts(t1, a_firstfl[b]) ") 뒤에 파일시스템이 새로 만들어졌고, 디스크는 시리얼이 같은 그 디스크입니다: " nolead(da) }
      else if (gone3[b] && v3[b] == "C") { v2[b] = "N"; r2[b] = "재사용 아님 — 첫 오류 뒤에 만들어진 파일시스템이 있지만, 디스크가 교체된 뒤(③ 확정) 새 디스크에 만든 것입니다: " nolead(da) }
      else { v2[b] = "L"; r2[b] = "첫 오류(" ts(t1, a_firstfl[b]) ") 뒤에 파일시스템이 새로 만들어짐 — 같은 디스크를 포맷해 다시 쓴 것인지, 디스크를 바꾸고 새로 만든 것인지는 ③ 이 확정이 아니라 가르지 못합니다: " nolead(da) }
    } else if (cmdhit != "") {
      v2[b] = "L"; r2[b] = "첫 오류 뒤에 이 장치 이름으로 포맷 · 초기화 계열 명령을 실행한 기록이 있습니다: " nolead(cmdhit)
    } else if (nknown > 0) {
      if (same3[b] && v3[b] == "C") { v2[b] = "C0"; r2[b] = "재포맷 정황 없음 — 현재 파일시스템은 첫 오류 이전에 만들어진 그대로이고 디스크도 같은 시리얼입니다: " nolead(db) }
      else { v2[b] = "L0"; r2[b] = "재포맷 정황 없음으로 보임 — 지금 " b " 위의 파일시스템은 첫 오류 이전에 만들어졌습니다. 단 '지금의 " b "' 가 그때의 디스크라는 전제입니다(③): " nolead(db) }
    } else {
      v2[b] = "U"
      r2[b] = (k > 0) ? "이 장치 위 파일시스템의 생성 시각을 읽지 못해 비교할 수 없습니다: " nolead(db) : "지금 이 장치 이름 위에 생성 시각을 읽을 수 있는 파일시스템이 없습니다(장치가 없거나 · 원시 장치 사용 · 읽기 실패)."
    }
  }
}
function vlabel(v) {
  if (v == "C" || v == "C0") return "[확정]"
  if (v == "L" || v == "L0") return "[추정]"
  if (v == "U") return "[불명]"
  if (v == "N") return "[해당 없음]"
  return "[" v "]"
}
RDH_AWK_ANALYZE
}

write_report_program() {
cat >> "$WORK/analyze.awk" <<'RDH_AWK_REPORT'
# ── PERC 슬롯(컨트롤러 이벤트 로그) ────────────────────────────────────────────
function pdmatch(K,   q, i, hit, c, p) {
  if (K in pdidx) return K
  split(K, q, ":"); hit = ""; c = 0
  for (i = 1; i <= npd; i++) { split(pd[i], p, ":"); if (p[1] == q[1] && p[3] == q[3]) { hit = pd[i]; c++ } }
  return (c == 1) ? hit : ""
}
function w15(a) { a = wwn_norm(a); return (length(a) == 16) ? substr(a, 1, 15) : a }
function percslots(   i, K, c, ck, t1, same, m, j, q, kk, vk, hit) {
  for (i = 1; i <= npe; i++) {
    K = pe_pd[i]; c = pe_cls[i]
    if (K == "") continue
    if (!(K in ps)) { ps[K] = 1; psn++; psorder[psn] = K }
    ps_ev[K] = ps_ev[K] " " i
    if (c == "PMEDIA") ps_media[K]++
    else if (c == "PPRED") ps_pred[K]++
    else if (c == "PFAIL") ps_fail[K]++
    else if (c == "PHW") ps_hw[K]++
    else if (c == "PXPORT") ps_xport[K]++
    if (c == "PMEDIA" || c == "PPRED" || c == "PFAIL" || c == "PHW") {
      if (!(K in ps_firsti)) { ps_firsti[K] = i; ps_first[K] = pe_t[i] }
      ps_lasti[K] = i; ps_last[K] = pe_t[i]
      if (pe_addr[i] != "") ps_erraddr[K] = pe_addr[i]
    }
    if (c == "PINS" && !(K in ps_firsti) && pe_addr[i] != "") ps_preaddr[K] = pe_addr[i]     # 오류 이전 삽입 때의 주소
    if (c == "PINS" && (K in ps_firsti)) { ps_insafter[K]++; ps_insaddr[K] = pe_addr[i]; ps_inst[K] = pe_t[i] }
    if (c == "PREM" && (K in ps_firsti)) ps_remafter[K]++
  }
  for (j = 1; j <= psn; j++) {
    K = psorder[j]
    if (ps_media[K] > 0) { pv1[K] = "C"; pC++ } else if (ps_pred[K] + ps_fail[K] + ps_hw[K] > 0) { pv1[K] = "L"; pL++ } else { pv1[K] = "I"; continue }
    ck = pdmatch(K)
    m = (ps_erraddr[K] != "") ? ps_erraddr[K] : ps_preaddr[K]
    if (npd == 0) { pv3[K] = "U"; pr3[K] = "현재 물리 디스크 목록(storcli/perccli)을 읽지 못해 지금 그 슬롯에 무엇이 있는지 모릅니다." }
    else if (ck == "") { pv3[K] = "L"; pr3[K] = "현재 그 슬롯에 디스크가 없습니다(제거됨으로 보임) — 슬롯 번호 기준." }
    else if (toupper(pdv[ck, "intf"]) == "SAS" && m != "" && m !~ /^4433/ && (pdv[ck, "wwn"] != "" || pdv[ck, "sasaddr"] != "")) {
      same = (w15(m) == w15(pdv[ck, "wwn"]) || wwn_norm(m) == wwn_norm(pdv[ck, "sasaddr"]) || w15(m) == w15(pdv[ck, "sasaddr"]))
      pv3[K] = "C"
      if (same) { psame[K] = 1; pr3[K] = "그대로 있음 — 오류 당시 SAS 주소(" m ")가 현재 슬롯 디스크(S/N " pdv[ck, "sn"] " · WWN " pdv[ck, "wwn"] ")와 같습니다(마지막 자리 제외 비교)." }
      else { pgone[K] = 1; pr3[K] = "교체됨 — 오류 당시 SAS 주소(" m ")와 현재 슬롯 디스크(S/N " pdv[ck, "sn"] " · WWN " pdv[ck, "wwn"] " · SAS 주소 " pdv[ck, "sasaddr"] ")가 다릅니다." }
    }
    else if (ps_insafter[K] > 0) { pv3[K] = "L"; pgone[K] = 1; pr3[K] = "교체된 것으로 보임 — 오류 뒤 같은 슬롯에 삽입 이벤트 " ps_insafter[K] "건(제거 " (ps_remafter[K] + 0) "건). 같은 디스크를 뺐다 다시 꽂은 경우와는 구분하지 못합니다(SATA 는 SAS 주소가 디스크가 아니라 슬롯을 따릅니다). 현재: S/N " pdv[ck, "sn"] }
    else { pv3[K] = "L"; psame[K] = 1; pr3[K] = "그대로 있는 것으로 보임 — 오류 뒤 그 슬롯의 제거 · 삽입 이벤트가 없습니다(이벤트 로그가 그 사이 지워지지 않았다는 전제). 현재: S/N " pdv[ck, "sn"] }
    # ② 가상 디스크가 오류 뒤에 다시 만들어졌는가
    split(K, q, ":"); hit = ""
    for (i = 1; i <= nvd; i++) {
      vk = vd[i]; split(vk, kk, ":")
      if (kk[1] != q[1]) continue
      if (index("," vdv[vk, "members"] ",", "," q[2] ":" q[3] ",") || index("," vdv[vk, "members"] ",", ",:" q[3] ",")) hit = vk
    }
    if (hit == "") { pv2[K] = "U"; pr2[K] = "이 슬롯이 속한 가상 디스크를 찾지 못했습니다(가상 디스크 목록을 못 읽었거나 · 핫스페어 · 미구성)." }
    else if (!isnum(vdv[hit, "created"]) || ps_first[K] <= 0) { pv2[K] = "U"; pr2[K] = "가상 디스크 " hit " 의 생성 시각 또는 오류 시각을 읽지 못해 비교할 수 없습니다." }
    else if (vdv[hit, "created"] + 0 > ps_first[K]) { pv2[K] = "L"; pr2[K] = "오류(" ts(ps_first[K], "c") ") 뒤에 가상 디스크 " hit "(" vdv[hit, "osdev"] ")가 다시 만들어졌습니다(" ts(vdv[hit, "created"], "c") ") — 재구성 후 재사용 정황." }
    else { pv2[K] = "L0"; pr2[K] = "가상 디스크 " hit "(" vdv[hit, "osdev"] ")는 오류 이전(" ts(vdv[hit, "created"], "c") ")에 만들어진 그대로입니다 — 재구성 정황 없음(디스크 교체 · 리빌드는 가상 디스크를 다시 만들지 않습니다)." }
  }
}
function smart_summary(h,   s, k, f, lab, nlab, i) {
  s = ""
  nlab = split("realloc=재할당 섹터|reallocev=재할당 이벤트|pending=보류 섹터|offunc=오프라인 복구 불가|repunc=보고된 복구 불가|grown=grown defect|uncr=읽기 미복구|uncw=쓰기 미복구|uncv=검증 미복구|nvmemedia=NVMe media errors|unclog=오류 로그 UNC|stfail=자가 진단 실패|ataerr=ATA 오류 로그 건수|nvmeerr=NVMe 오류 로그 건수|crc=인터페이스 CRC(전송)|nonmed=non-medium(전송 등)", lab, "|")
  for (i = 1; i <= nlab; i++) { split(lab[i], f, "="); if (smv[h, f[1]] != "") s = s " " f[2] "=" smv[h, f[1]] }
  return s
}
function report(   i, b, k, lst, q, oldest, oldname, okeys, nk, h, sf, K, j, c, t, any, est1, est2, e, d, x, line, cl, rank, anyL, missing) {
  S("================================================================================")
  S(" RHEL 디스크 과거 장애 이력 점검 결과   (rhel-disk-history " VERSION ")")
  S("================================================================================")
  S(" 호스트      : " meta["host"])
  S(" 실행 시각   : " ts(NOW) " " meta["tz"])
  S(" OS / 커널   : " meta["os"] " / " meta["kernel"])
  S(" 실행 계정   : uid=" meta["uid"] (meta["uid"] == "0" ? " (root)" : "  ※ root 가 아님 — 읽지 못한 출처는 [1] 에 표시"))
  S(" 마지막 부팅 : " ts(meta["boot"] + 0))
  S(" 읽기 전용   : 디스크 · 설정 · 서비스를 바꾸는 명령은 쓰지 않았습니다. 쓴 것은 결과 파일뿐입니다.")
  S("")
  F(" 읽는 법")
  F("   [확정]  근거 줄이 직접 말합니다(예: 커널의 'critical medium error', 시리얼 일치).")
  F("   [추정]  정황은 있으나 다른 설명이 가능합니다. 각 항목의 '틀릴 수 있는 경우' 를 보십시오.")
  F("   [불명]  판단할 근거가 없거나 읽지 못했습니다. '없음' 이 아닙니다.")
  F("   '기록 없음' 은 '발생한 적 없음' 이 아닙니다 — 항상 [1] 의 근거 구간 안에서만 하는 말입니다.")
  F("")

  # ── [1] 근거 출처와 보존 구간
  S("[1] 근거 출처와 보존 구간")
  oldest = 0
  for (i = 1; i <= nsrc; i++) {
    line = sprintf("  - %-12s %s : %s", stlabel(sst[i]), sname[i], sstat[i])
    if (sst[i] == "JH") { S(sprintf("  - %-12s %s : 가장 오래된 항목 %s", stlabel(sst[i]), sname[i], (sfe[i] > 0 ? ts(sfe[i]) : "읽지 못함"))); if (sfe[i] > 0 && (oldest == 0 || sfe[i] < oldest)) { oldest = sfe[i]; oldname = sname[i]; oldfl = sfl[i] } continue }
    if (sfe[i] > 0 || sle[i] > 0) line = line " · " ts(sfe[i], sfl[i]) " ~ " ts(sle[i], sfl[i])
    if (slines[i] > 0) line = line sprintf(" · %d줄", slines[i])
    if (sst[i] != "JH" && sst[i] != "P" && sev_n[i] > 0) line = line sprintf(" · 사건 묶음 %d", sev_n[i])
    S(line)
    if ((sst[i] == "M" || sst[i] == "X" || sst[i] == "J" || sst[i] == "JH" || sst[i] == "D") && sfe[i] > 0 && (oldest == 0 || sfe[i] < oldest)) { oldest = sfe[i]; oldname = sname[i]; oldfl = sfl[i] }
  }
  if (nsrc == 0) S("  - 읽은 로그 출처가 없습니다.")
  if (oldest > 0) {
    COVER = ts(oldest, oldfl) " ~ " ts(NOW)
    S("  ▶ OS 로그 근거 구간: " COVER "   (가장 오래된 근거: " oldname ")")
    S("    이 구간보다 앞선 시기의 오류는 OS 로그로는 알 수 없습니다 → 불명.")
  } else {
    COVER = "없음(시각을 읽을 수 있는 OS 로그가 없음)"
    S("  ▶ OS 로그 근거 구간: " COVER " → OS 로그 기준 판정은 전부 불명입니다.")
  }
  S("  - 저널(journald) 보존: " meta["journal"])
  if (meta["logrotate"] != "") F("  - logrotate 설정(참고): " meta["logrotate"])
  for (i = 1; i <= nnote; i++) S("  - 주의: " note[i])
  missing = ""
  if (meta["smartctl"] != "1") { S("  - smartctl " meta["smartctl_why"] " → 디스크가 들고 있는 누적 오류값(재할당 · 보류 · 복구 불가 섹터)과 현재 시리얼을 읽지 못했습니다. ① 의 '현재 디스크 누적값' 과 ③ 의 시리얼 대조가 그만큼 불명입니다."); missing = 1 }
  if (meta["raidcli"] == "") {
    if (nvdcur > 0) S("  - storcli / perccli " meta["raidcli_why"] " → RAID 뒤 물리 디스크별 Media Error Count · 시리얼 · 컨트롤러 이벤트 로그를 읽지 못했습니다(이 서버에는 RAID 가상 디스크가 " nvdcur "개 있습니다 — 영향이 큽니다).")
    else if (ncur > 0) S("  - storcli / perccli " meta["raidcli_why"] " — lsblk 기준으로는 RAID 가상 디스크가 보이지 않아 영향이 없는 것으로 보입니다(모델 이름으로 판별한 것이라 추정).")
    else S("  - storcli / perccli " meta["raidcli_why"] " — 현재 디스크 목록도 읽지 못해 RAID 구성 여부 자체가 불명입니다.")
  }
  S("")

  # ── [2] 현재 디스크
  S("[2] 현재 디스크(식별자)")
  if (ncur == 0) S("  - 현재 디스크 목록을 읽지 못했습니다(lsblk " (("lsblk" in cmdst) ? cmdst["lsblk"] : "미실행") ").")
  for (i = 1; i <= ncur; i++) {
    b = cur[i]
    line = sprintf("  - %-8s %s · %s · %s", b, tranlabel(curclass[b]), c_size[b], (c_vendor[b] != "" ? c_vendor[b] " " : "") c_model[b])
    if (curclass[b] == "raid") line = line " · (가상 디스크 — 뒤의 물리 디스크는 아래 PERC 목록)"
    else line = line " · S/N " (cursn_of[b] != "" ? cursn_of[b] : "못 읽음") " · WWN " (curwwn_of[b] != "" ? curwwn_of[b] : "못 읽음")
    if (curclass[b] == "excl" || curclass[b] == "usb") F(line " · 판정 제외"); else S(line)
  }
  for (i = 1; i <= npd; i++) {
    K = pd[i]
    S(sprintf("  - PERC %-8s DID %s · %s · %s %s · %s · %s · S/N %s · WWN %s · MediaErr %s · OtherErr %s · PredFail %s", K, pdv[K, "did"], pdv[K, "state"], pdv[K, "intf"], pdv[K, "med"], pdv[K, "size"], pdv[K, "model"], (pdv[K, "sn"] != "" ? pdv[K, "sn"] : "못 읽음"), (pdv[K, "wwn"] != "" ? pdv[K, "wwn"] : "못 읽음"), (pdv[K, "mediaerr"] != "" ? pdv[K, "mediaerr"] : "못 읽음"), (pdv[K, "othererr"] != "" ? pdv[K, "othererr"] : "못 읽음"), (pdv[K, "predfail"] != "" ? pdv[K, "predfail"] : "못 읽음")))
  }
  for (i = 1; i <= nvd; i++) { K = vd[i]; F(sprintf("  - 가상 디스크 %s · %s %s · OS 장치 %s · 구성 슬롯 %s · 생성 %s", K, vdv[K, "type"], vdv[K, "state"], (vdv[K, "osdev"] != "" ? vdv[K, "osdev"] : "못 읽음"), vdv[K, "members"], (isnum(vdv[K, "created"]) ? ts(vdv[K, "created"], "c") : "못 읽음"))) }
  for (b in dm_name) F("  - " b " = " dm_name[b] " (현재 하위 장치: " dm_slaves[b] ")")
  if (!coverage_ok) S("  ※ 시리얼 대조 한계: " coverage_why)
  S("")

  # ── [3] 판정 ①
  S("[3] 판정 ① 과거 bad sector / I/O / media error 발생 여부")
  S("  (a) OS 로그 기준 — 근거 구간 " COVER)
  nk = 0
  for (b in subj) { rank = (v1[b] == "C") ? 1 : ((v1[b] == "L") ? 2 : ((v1[b] == "X") ? 3 : 4)); okeys[++nk] = rank ":" b }
  if (nk > 1) asort(okeys)
  any = 0
  for (i = 1; i <= nk; i++) {
    b = substr(okeys[i], 3)
    if (v1[b] != "C" && v1[b] != "L") continue
    any = 1; cl = devclass(b)
    line = "    " vlabel(v1[b]) " " b
    if (cl == "sd" || cl == "nvme") line = line " (" tranlabel(s_tran[b]) (s_trsrc[b] != "" ? " — " s_trsrc[b] : "") ")"
    else if (cl == "dm") line = line " (device-mapper" ((b in dm_name) ? " — 현재 " dm_name[b] " · 하위 " dm_slaves[b] : "") ")"
    else if (cl == "md") line = line " (소프트웨어 RAID)"
    else if (cl == "ata") line = line " (SATA 포트 — 같은 디스크가 sdX 로도 집계됐을 수 있습니다)"
    else if (cl == "pdsmart") line = line " (RAID 뒤 물리 디스크 — smartd 장치 번호)"
    else if (cl == "pdctl") line = line " (컨트롤러 감시 유틸이 남긴 슬롯)"
    else if (cl == "hctl") line = line " (SCSI 주소 — sd 이름과 연결할 줄이 없음)"
    S(line)
    if (v1[b] == "C") line = "미디어 오류 기록이 있습니다"; else line = "I/O · 하드웨어 오류 기록이 있으나 미디어 오류라고 직접 말한 줄은 없습니다"
    S("      " line " — 기간 " ((b in a_first) ? ts(a_first[b], a_firstfl[b]) " ~ " ts(a_last[b], a_lastfl[b]) : "시각 불명"))
    line = ""
    if (a_media[b] > 0) line = line sprintf(" · 미디어 오류 %d회(관련 로그 줄 %d)", a_media[b], a_medialines[b])
    if (a_withm[b, "io"] > 0) line = line sprintf(" · 미디어 오류와 같은 때의 I/O 오류 %d건", a_withm[b, "io"])
    if (a_plain[b, "io"] > 0) line = line sprintf(" · 원인 미상 I/O 오류 %d건", a_plain[b, "io"])
    if (a_withx[b, "io"] > 0) line = line sprintf(" · 전송 계열과 같은 때의 I/O 오류 %d건(미디어로 세지 않음)", a_withx[b, "io"])
    if (a_withm[b, "fs"] + a_plain[b, "fs"] + a_withx[b, "fs"] > 0) line = line sprintf(" · 파일시스템 I/O 오류 %d건", a_withm[b, "fs"] + a_plain[b, "fs"] + a_withx[b, "fs"])
    if (a_hw[b] > 0) line = line sprintf(" · 하드웨어 오류 %d건", a_hw[b])
    if (a_ssmax[b, "pending-sectors"] > 0) line = line sprintf(" · smartd 보류 섹터 최대 %d", a_ssmax[b, "pending-sectors"])
    if (a_ssmax[b, "offline-uncorrectable"] > 0) line = line sprintf(" · smartd 복구 불가 섹터 최대 %d", a_ssmax[b, "offline-uncorrectable"])
    if (a_smerr[b] > 0) line = line sprintf(" · smartd 오류 증가 보고 %d회", a_smerr[b])
    if (a_smfail[b] > 0) line = line sprintf(" · SMART 실패 보고 %d회", a_smfail[b])
    if (a_smchg[b] > 0) line = line sprintf(" · SMART 재할당 계열 값 변화 %d회", a_smchg[b])
    if (a_cmedia[b] > 0) line = line sprintf(" · 컨트롤러 미디어 오류 알림 %d건", a_cmedia[b])
    if (a_cfault[b] > 0) line = line sprintf(" · 컨트롤러 장애 알림 %d건", a_cfault[b])
    if (a_xport[b] > 0) line = line sprintf(" · 전송 · 경로 %d건", a_xport[b])
    if (a_recov[b] > 0) line = line sprintf(" · 복구된 오류 %d건", a_recov[b])
    if (a_other[b] > 0) line = line sprintf(" · 결함 아닌 블록 오류 %d건", a_other[b])
    if (a_fsctx[b] > 0) line = line sprintf(" · 파일시스템 중단 %d건", a_fsctx[b])
    if (a_notime[b] > 0) line = line sprintf(" · 이 중 시각 불명 출처 %d건(다른 출처와 중복일 수 있음)", a_notime[b])
    S("      집계(로그 줄 기준): " nolead(line))
    if (v1[b] == "C") {
      F("      틀릴 수 있는 경우: 장치 이름(sdX)은 부팅마다 달라질 수 있어, 이 이름이 지금의 같은 이름 디스크라는 보장은 없습니다(③).")
      if (s_tran[b] == "raid") F("        RAID 가상 디스크가 낸 미디어 오류는 컨트롤러가 못 고친 것만 올라온 것입니다 — 어느 물리 디스크인지는 컨트롤러 기록으로 봐야 합니다.")
      if (s_tran[b] == "iscsi" || s_tran[b] == "fc") F("        SAN LUN 입니다 — 결함 위치는 이 서버가 아니라 스토리지 장비 쪽입니다.")
    } else {
      F("      틀릴 수 있는 경우: I/O 오류 문구만으로는 미디어 결함인지 케이블 · 경로 · 컨트롤러 문제인지 가르지 못합니다.")
      F("        같은 때(±1분)에 미디어 근거도 전송 근거도 없어 '원인 미상' 으로 둔 것입니다.")
    }
    F("      근거:")
    print_evidence(b)
  }
  if (!any) {
    S("    [불명] 근거 구간 안에서는 미디어 · I/O 오류 기록을 찾지 못했습니다.")
    S("      '없었다' 가 아니라 '남아 있는 로그(" COVER ")에는 없다' 입니다. 그 이전과 읽지 못한 출처는 불명입니다.")
  }
  # 전송 계열만 있는 장치 · 제외한 장치(오탐 방지)
  for (i = 1; i <= nk; i++) {
    b = substr(okeys[i], 3)
    if (v1[b] == "X") {
      S("    [해당 없음·추정] " b " — 미디어 · 원인 미상 I/O 오류 줄은 없고, 디스크 미디어 오류로 세지 않는 기록만 있습니다" sprintf("(전송·경로 %d · 전송과 같은 때의 I/O %d · 결함 아닌 블록 오류 %d · 복구된 오류 %d · 파일시스템 중단 %d · ATA 명령 실패 %d건)", a_xport[b], a_withx[b, "io"] + a_withx[b, "fs"], a_other[b], a_recov[b], a_fsctx[b], a_atactx[b]))
      F("      틀릴 수 있는 경우: 응답이 없는 고장 디스크가 타임아웃 · 오프라인으로만 보이는 경우를 배제하지 못합니다. 파일시스템 중단은 원인 줄이 로그 보존 구간 밖에 있을 수 있습니다.")
      F("      근거:"); print_evidence(b)
    } else if (v1[b] == "E") {
      F("    [제외] " b " — " (s_tran[b] == "usb" ? "USB 이동식 장치" : "광학 · 플로피 · loop · ram 등 서버 디스크가 아닌 장치") "의 오류라 판정에서 뺐습니다.")
      F("      근거:"); print_evidence(b)
    }
  }
  S("")

  S("  (b) 현재 장착 디스크의 누적값(SMART) — 디스크 수명 전체가 대상이지만 '지금 꽂혀 있는 디스크' 만 봅니다")
  if (nsm == 0) S("    [불명] smartctl 결과가 없습니다(" (meta["smartctl"] == "1" ? "읽을 수 있는 장치 없음" : meta["smartctl_why"]) ").")
  sC = 0; sL = 0; sU = 0; sZ = 0
  for (i = 1; i <= nsm; i++) {
    h = sm[i]
    if (smv[h, "status"] == "vd") { F("    [해당 없음] " h " — RAID 가상 디스크라 SMART 가 없습니다(뒤의 물리 디스크는 -d megaraid,N 으로 따로 읽습니다)."); continue }
    if (smv[h, "status"] != "ok") { sU++; S("    [불명] " h " — smartctl 로 읽지 못했습니다(" smv[h, "status"] " · 종료 코드 " smv[h, "rc"] ")."); continue }
    sf = smart_fault(h)
    line = h " · " smv[h, "model"] " · S/N " (smv[h, "serial"] != "" ? smv[h, "serial"] : "못 읽음") (smv[h, "poh"] != "" ? " · 가동 " smv[h, "poh"] "h" : "") (smv[h, "health"] != "" ? " · 자가 판정 " smv[h, "health"] : "")
    if (sf == 1) {
      sC++; S("    [확정] " line); S("      이 디스크는 미디어 오류를 겪은 적이 있습니다:" smart_summary(h))
      if (smv[h, "rot"] ~ /Solid State/ || smv[h, "kind"] == "nvme") F("      틀릴 수 있는 경우: SSD 의 재할당(불량 블록 대체)은 소량이면 정상 마모 범위일 수 있습니다(제조사 기준 확인). 누적값에는 시각이 없습니다.")
      else F("      틀릴 수 있는 경우: 누적값에는 시각이 없습니다 — 언제 생긴 오류인지는 아래 오류 로그(가동 시간)로만 짐작합니다. 제조사마다 속성의 뜻이 조금씩 다릅니다.")
    } else if (sf == "") {
      sU++; S("    [불명] " line); S("      오류 누적값 항목을 읽지 못했습니다(이 디스크 · 컨트롤러 조합에서 smartctl 이 내주지 않음):" smart_summary(h))
    } else if (smv[h, "health"] ~ /FAIL/ || (smv[h, "critwarn"] != "" && smv[h, "critwarn"] !~ /^0x0+$/) || pos(smv[h, "ataerr"])) {
      sL++; S("    [추정] " line); S("      미디어 계열 누적값은 0 이지만 다른 이상 신호가 있습니다:" smart_summary(h) (smv[h, "critwarn"] != "" ? " critical_warning=" smv[h, "critwarn"] : ""))
      F("      틀릴 수 있는 경우: ATA 오류 로그에는 케이블(ICRC) · 명령 중단(ABRT) 같은 미디어가 아닌 오류도 들어갑니다.")
    } else {
      sZ++; F("    [확정] " line); F("      미디어 계열 누적값 0:" smart_summary(h))
    }
    for (j = 1; j <= nsmerr; j++) if (se_h[j] == h) {
      e = ""
      if (isnum(se_poh[j]) && isnum(smv[h, "poh"]) && smv[h, "poh"] + 0 >= se_poh[j] + 0) e = " → 대략 " day(NOW - (smv[h, "poh"] - se_poh[j]) * 3600) " (가동 시간 역산 · 추정)"
      F("      오류 로그: 가동 " (se_poh[j] != "" ? se_poh[j] "h" : "?") e " | " se_txt[j])
    }
  }
  if (nsm > 0) S(sprintf("    요약: 미디어 오류 이력 있음 %d대 · 다른 이상 신호 %d대 · 누적값 0 %d대 · 못 읽음 %d대", sC, sL, sZ, sU))
  if (sZ > 0 && sC == 0) S("    누적값 0 은 '지금 꽂힌 그 디스크' 에 한한 확정입니다. 이미 빠진 디스크의 이력은 여기서 알 수 없습니다(③).")
  S("")

  S("  (c) RAID 컨트롤러 기준(storcli / perccli)")
  if (meta["raidcli"] == "") {
    if (nvdcur > 0) S("    [불명] RAID 가상 디스크가 있는데 storcli / perccli " meta["raidcli_why"] " — 컨트롤러가 고친 오류는 OS 로그에 남지 않으므로 이 부분은 판단하지 못했습니다.")
    else if (ncur > 0) S("    [해당 없음] lsblk 기준 RAID 가상 디스크가 없습니다(storcli / perccli " meta["raidcli_why"] ").")
    else S("    [불명] storcli / perccli " meta["raidcli_why"] " — 현재 디스크 목록도 없어 RAID 구성 여부를 모릅니다.")
  }
  dC = 0; dL = 0; dU = 0
  for (i = 1; i <= npd; i++) {
    K = pd[i]
    line = "슬롯 " K " · " pdv[K, "model"] " · S/N " pdv[K, "sn"]
    if (pos(pdv[K, "mediaerr"])) { dC++; S("    [확정] " line " — Media Error Count " pdv[K, "mediaerr"] (pos(pdv[K, "predfail"]) ? " · Predictive Failure Count " pdv[K, "predfail"] : "")); F("      틀릴 수 있는 경우: 컨트롤러 집계값이라 언제부터 센 것인지(초기화 시점)는 알 수 없습니다.") }
    else if (pos(pdv[K, "predfail"]) || pdv[K, "smartalert"] ~ /^[Yy]/) { dL++; S("    [추정] " line " — 예측 장애 보고(Predictive Failure Count " pdv[K, "predfail"] " · SMART alert " pdv[K, "smartalert"] "). 미디어 오류 건수는 0 입니다.") }
    else if (!isnum(pdv[K, "mediaerr"])) { dU++; S("    [불명] " line " — Media Error Count 를 읽지 못했습니다(출력 형식이 예상과 다를 수 있음).") }
    else if (pos(pdv[K, "othererr"])) F("    [참고] " line " — Other Error Count " pdv[K, "othererr"] "(전송 · 기타 — 미디어 오류 아님)")
  }
  if (npd > 0) S(sprintf("    현재 물리 디스크 %d대: 미디어 오류 집계 있음 %d · 예측 장애 %d · 못 읽음 %d", npd, dC, dL, dU))
  any = 0
  for (j = 1; j <= psn; j++) {
    K = psorder[j]
    if (pv1[K] != "C" && pv1[K] != "L") continue
    any = 1
    S("    " vlabel(pv1[K]) " 이벤트 로그 · 슬롯 " K " — " sprintf("미디어 오류 %d · 예측 장애 %d · 실패 처리 %d · 하드웨어 %d · 전송 %d건", ps_media[K], ps_pred[K], ps_fail[K], ps_hw[K], ps_xport[K]) " · 기간 " ts(ps_first[K], "c") " ~ " ts(ps_last[K], "c"))
    F("      틀릴 수 있는 경우: 컨트롤러 시계는 호스트 시간대와 다를 수 있습니다. 이벤트 로그는 순환 · 삭제될 수 있습니다.")
    F("      근거:")
    k = split(ps_ev[K], q, " ")
    for (i = 1; i <= k; i++) { if (i > MAXEV) { F(sprintf("      … %d건 더 있음 …", k - MAXEV)); break } F("      [" pe_cls[q[i]] "] " ts(pe_t[q[i]], pe_fl[q[i]]) " seq " pe_seq[q[i]] " | " pe_txt[q[i]]) }
  }
  if (npe > 0 && !any) S("    이벤트 로그 구간 안에서는 물리 디스크의 미디어 오류 · 예측 장애 · 실패 이벤트가 없습니다([1] 의 '컨트롤러 이벤트' 구간 — 그 이전은 불명).")
  S("")

  # ── [4] 판정 ②
  S("[4] 판정 ② 포맷 후 재사용 정황")
  any = 0
  for (i = 1; i <= nk; i++) {
    b = substr(okeys[i], 3)
    if (!(b in v2) || v2[b] == "N" && r2[b] == "") continue
    any = 1
    S("    " vlabel(v2[b]) " " b " — " r2[b])
  }
  for (j = 1; j <= psn; j++) { K = psorder[j]; if (K in pv2) { any = 1; S("    " vlabel(pv2[K]) " PERC 슬롯 " K " — " pr2[K]) } }
  # 현재 디스크의 SMART 오류 로그 시각(가동 시간 역산)과 파일시스템 생성 시각 비교
  for (i = 1; i <= nsm; i++) {
    h = sm[i]
    if (smart_fault(h) != 1) continue
    est1 = 0
    for (j = 1; j <= nsmerr; j++) if (se_h[j] == h && isnum(se_poh[j]) && isnum(smv[h, "poh"]) && smv[h, "poh"] + 0 >= se_poh[j] + 0) { e = NOW - (smv[h, "poh"] - se_poh[j]) * 3600; if (est1 == 0 || e < est1) est1 = e }
    d = smv[h, "osdev"]
    if (d == "" && match(h, /megaraid,([0-9]+)/, q)) {     # RAID 뒤 물리 디스크 → 속한 가상 디스크의 OS 장치
      for (j = 1; j <= npd; j++) if (pdv[pd[j], "did"] == q[1]) { split(pd[j], x, ":"); for (k = 1; k <= nvd; k++) if (index("," vdv[vd[k], "members"] ",", "," x[2] ":" x[3] ",")) d = vdv[vd[k], "osdev"] }
    }
    split("", lst); k = (d != "") ? fs_on(d, lst) : 0
    any = 1
    if (est1 == 0) { S("    [불명] " h " (S/N " smv[h, "serial"] ") — 누적 오류값은 있으나 오류 시각을 알 수 없어 포맷 시각과 비교할 수 없습니다."); for (j = 1; j <= k; j++) F("      참고: " fsdesc(lst[j])); continue }
    c = 0; line = ""
    for (j = 1; j <= k; j++) if (isnum(fs_t[lst[j]])) { if (fs_t[lst[j]] + 0 > est1 + 86400) { c++; line = line " · " fsdesc(lst[j]) } }
    if (c > 0) { S("    [추정] " h " (S/N " smv[h, "serial"] ") — SMART 오류 로그 기준 포맷 후 재사용 정황: 디스크 오류 로그의 첫 오류(가동 시간 역산 약 " day(est1) ") 뒤에 그 위 파일시스템이 만들어졌습니다: " nolead(line)); F("      틀릴 수 있는 경우: 오류 시각은 '지금 − (현재 가동 시간 − 오류 때 가동 시간)' 으로 역산한 것이라, 전원이 꺼져 있던 기간만큼 실제보다 늦게 나옵니다.") }
    else if (k > 0) S("    [추정] " h " (S/N " smv[h, "serial"] ") — SMART 오류 로그 기준 재포맷 정황 없음: 첫 오류(역산 약 " day(est1) ") 뒤에 만들어진 파일시스템이 없습니다.")
    else S("    [불명] " h " (S/N " smv[h, "serial"] ") — 이 디스크 위의 파일시스템을 찾지 못해 비교할 수 없습니다(RAID 구성원 · 원시 장치 · 목록 읽기 실패).")
  }
  if (!any) {
    S("    [불명] 기준이 될 '과거 오류' 기록이 없어 '오류 뒤 포맷' 을 판단할 수 없습니다(근거 구간 " COVER ").")
    S("      아래 생성 시각 목록(결과 파일)은 참고용입니다 — 포맷 자체는 로그에 남지 않습니다.")
  }
  F("    참고 — 시각 목록(지금 남아 있는 것 기준)")
  if (osinst > 0) F("      OS 설치: " ts(osinst) " [" osinst_how "]")
  for (i = 1; i <= nfs; i++) F("      파일시스템: " fsdesc(i) " · 놓인 디스크 " (fs_disks[i] != "" ? fs_disks[i] : "불명"))
  for (i = 1; i <= nmd; i++) F("      md: " md_name[i] " 생성 " (isnum(md_t[i]) ? ts(md_t[i]) : "시각 불명") " · 구성 " md_members[i])
  for (i = 1; i <= nlvm; i++) F("      LVM: " ts(lv_t[i]) " VG " lv_vg[i] " " (lv_kind[i] == "LV" ? "LV " lv_name[i] " 생성" : (lv_kind[i] == "ARCH" ? "변경 이력: " lv_name[i] : lv_name[i])) " (" lv_file[i] ")")
  for (b in lvmpv) F("      LVM: VG " b " 의 PV(기록된 장치 이름):" lvmpv[b])
  for (i = 1; i <= nhist; i++) F("      포맷 · 초기화 계열 명령: " (h_t[i] > 0 ? ts(h_t[i]) : "시각 불명") " " h_cmd[i])
  F("      (LVM archive 는 기본 30일 · 최소 10개만 남습니다. 셸 기록은 시각이 없는 경우가 많고 지워질 수 있습니다.)")
  S("")

  # ── [5] 판정 ③
  S("[5] 판정 ③ 과거 장애 디스크가 교체되어 지금 없는가(시리얼 / WWN 기준)")
  any = 0
  for (i = 1; i <= nk; i++) {
    b = substr(okeys[i], 3)
    if (!(b in v3)) continue
    any = 1
    S("    " vlabel(v3[b]) " " b " — " r3[b])
    if (v3[b] == "L") F("      틀릴 수 있는 경우: 장치 이름 · 가동 시간 · 연결 이벤트는 디스크 자체의 식별자가 아닙니다. 같은 디스크를 뺐다 꽂아도 같은 흔적이 남습니다.")
  }
  for (j = 1; j <= psn; j++) { K = psorder[j]; if (K in pv3) { any = 1; S("    " vlabel(pv3[K]) " PERC 슬롯 " K " — " pr3[K]) } }
  if (!any) S("    [불명] 근거 구간 안에 '과거 장애 디스크' 로 볼 기록이 없어 교체 여부를 따질 대상이 없습니다.")
  # 과거에 보였다가 지금 없는 시리얼
  c = 0
  for (k in hs_last) {
    if (sn_cur_find(k) != "") continue
    if (hs_wwn[k] != "" && wwn_cur_find(hs_wwn[k]) != "") continue
    c++
    S("    " (coverage_ok ? "[확정]" : "[추정]") " 과거에 있었으나 지금 없는 디스크: S/N " hs_raw[k] " (" hs_model[k] ") — " hs_dev[k] " 로 " ts(hs_first[k]) " ~ " ts(hs_last[k]) " 에 smartd 가 기록 (" esrc[hs_ev[k]] ":" elno[hs_ev[k]] ")")
  }
  if (nid == 0) S("    참고: 근거 구간 안에 smartd 의 시리얼 기록(시작 로그)이 없습니다 — 커널 로그의 sdX 를 그때의 시리얼과 이을 수단이 없어 OS 로그 기준 ③ 은 확정이 나오지 않습니다.")
  else if (c == 0) S("    참고: smartd 가 기록한 과거 시리얼 " length(hs_last) "개는 전부 지금도 있습니다(사라진 디스크 없음 — 근거 구간 " COVER " 안).")
  if (!coverage_ok && c > 0) F("      [추정] 인 이유: " coverage_why)
  S("")

  # ── [6] 한계
  S("[6] 한계 — 이 결과가 말하지 못하는 것")
  S("  - 로그 보존: 판정은 [1] 의 근거 구간 안에서만 유효합니다. " (meta["journal_volatile"] == "1" ? "저널은 휘발성이라 재부팅 전 기록이 없습니다." : ""))
  S("  - RAID 가상 디스크: OS 는 가상 디스크만 봅니다. 컨트롤러가 다른 디스크로 고쳐 읽은 오류 · 리빌드 · 디스크 교체는 커널 로그에 남지 않습니다")
  S("    (storcli / perccli 의 물리 디스크 집계 · 이벤트 로그가 유일한 근거이고, 그 로그도 순환 · 삭제됩니다).")
  S("  - 장치 이름: sdX 는 부팅 · 재연결 때 바뀔 수 있습니다. 시리얼 / WWN 과 이어지지 않은 판정은 추정 이하입니다.")
  S("  - 포맷: mkfs 는 로그를 남기지 않습니다. 파일시스템 생성 시각 · LVM 이력 · 명령 기록으로만 정황을 봅니다. XFS 는 생성 시각을 못 읽는 경우가 있습니다.")
  S("  - 연도: /var/log/messages 의 시각에는 연도가 없어 파일 수정 시각으로 맞췄습니다('연도 추정' 표시). 파일을 복사해 수정 시각이 바뀌었으면 틀립니다.")
  S("  - 실서버 미검증: 커널 · smartctl · storcli 문구는 판마다 다릅니다. 이 스크립트가 모르는 문구는 '기록 없음' 으로 보일 수 있습니다.")
  S("    처음 돌릴 때 --save-raw 로 원본 출력을 남겨 형식을 대조하십시오.")
  S("")

  # ── [7] 수집 기록
  F("[7] 실행한 명령과 상태(전부 조회 전용)")
  for (i = 1; i <= ncmd; i++) F(sprintf("  - %-28s %s | %s", cname[i], cst[i], cline[i]))
  F("")

  code = 0
  if (nL + sL + dL + pL > 0) code = 10
  if (nC + sC + dC + pC > 0) code = 20
  print "X|" code
}
END { prep(); build_current(); aggregate(); judge1(); judge3(); judge2(); percslots(); report() }
RDH_AWK_REPORT
}

# ══════════════════════════════════════════════════════════════════════════════
# 수집
# ══════════════════════════════════════════════════════════════════════════════
write_awk_programs
write_analyze_program
write_report_program

tmo() { # tmo 초 명령… — timeout 이 없으면 시한 없이 실행
  if [ "$HAVE_TIMEOUT" = 1 ]; then local t="$1"; shift; timeout -k 5 "$t" "$@"; else shift; "$@"; fi
}

# scan_log 종류 표시이름 수정시각 부팅시각  (stdin = 로그) → 사건 묶음을 EVENTS 에 덧붙인다
scan_log() {
  "$AWK" -v st="$1" -v src="$2" -v mtime="$3" -v boot_epoch="$4" -v now="$NOW" -f "$WORK/classify.awk" >> "$EVENTS"
}
src_fail() { fact SRC "$1" "$2" "$3" 0 0 "" 0 0 0; }

scan_file() { # scan_file 종류 경로
  local st="$1" f="$2" name mt dec rc
  name="${f#"$R"}"
  if [ ! -r "$f" ]; then src_fail "$st" "$name" "못 읽음(권한 없음)"; return; fi
  if [ ! -s "$f" ]; then src_fail "$st" "$name" "빈 파일"; return; fi
  mt=$(stat -c %Y -- "$f" 2>/dev/null); [ -n "$mt" ] || mt=0
  dec=""
  case "$f" in
    *.gz) dec=gzip ;; *.xz) dec=xz ;; *.bz2) dec=bzip2 ;; *.zst) dec=zstd ;;
  esac
  prog "로그 읽는 중: $name"
  if [ -n "$dec" ]; then
    if ! have "$dec"; then src_fail "$st" "$name" "못 읽음(압축 해제 명령 $dec 없음)"; return; fi
    "$dec" -dc -- "$f" 2>>"$WORK/decompress.err" | scan_log "$st" "$name" "$mt" 0
    rc=${PIPESTATUS[0]}
    [ "$rc" = 0 ] || fact NOTE "$name 압축 해제가 오류로 끝났습니다(종료 코드 $rc) — 앞부분만 읽었을 수 있습니다."
  else
    scan_log "$st" "$name" "$mt" 0 < "$f"
  fi
}

# ── 기본 정보 ──────────────────────────────────────────────────────────────────
OSREL=$(head -n 1 "$R/etc/redhat-release" 2>/dev/null)
[ -n "$OSREL" ] || OSREL=$(sed -n 's/^PRETTY_NAME="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$R/etc/os-release" 2>/dev/null | head -n 1)
BOOT_EPOCH=0
if [ -r "$R/proc/uptime" ]; then
  read -r UPSEC _ < "$R/proc/uptime"
  UPSEC=${UPSEC%%.*}
  case "$UPSEC" in ''|*[!0-9]*) ;; *) BOOT_EPOCH=$((NOW - UPSEC)) ;; esac
fi
fact META host "$HOST"
fact META uid "$MYUID"
fact META tz "$(date '+%Z(UTC%z)')"
fact META os "${OSREL:-불명}"
fact META kernel "$(uname -r 2>/dev/null)"
fact META boot "$BOOT_EPOCH"

JOURNAL_VOL=""
if [ -d "$R/var/log/journal" ] && [ -n "$(ls -A "$R/var/log/journal" 2>/dev/null)" ]; then
  JOURNAL_DESC="영구 저장(/var/log/journal) — 재부팅 뒤에도 남지만 용량 한도에 따라 오래된 것부터 지워집니다"
  JOURNAL_VOL=0
elif [ -d "$R/run/log/journal" ]; then
  JOURNAL_DESC="휘발성(/run/log/journal) — 재부팅하면 사라집니다. 이전 부팅의 기록은 /var/log/messages* 에만 남습니다"
  JOURNAL_VOL=1
else
  JOURNAL_DESC="저널 폴더를 찾지 못했습니다(/var/log/journal · /run/log/journal 둘 다 없음)"
fi
fact META journal "$JOURNAL_DESC"
fact META journal_volatile "$JOURNAL_VOL"
LR=""
for f in "$R/etc/logrotate.conf" "$R/etc/logrotate.d/syslog" "$R/etc/logrotate.d/rsyslog"; do
  [ -r "$f" ] || continue
  x=$(grep -E '^[[:space:]]*(rotate|daily|weekly|monthly|yearly|maxage|size|compress|delaycompress)([[:space:]]|$)' "$f" 2>/dev/null | tr -s ' \t' ' ' | tr '\n' ';')
  [ -n "$x" ] && LR="$LR ${f#"$R"}: $x"
done
fact META logrotate "$LR"

# ── 현재 디스크(lsblk · by-id · dm) ────────────────────────────────────────────
prog "현재 디스크 목록 읽는 중"
for cols in "NAME,KNAME,TYPE,SIZE,MODEL,VENDOR,SERIAL,WWN,TRAN,HCTL,ROTA" "NAME,KNAME,TYPE,SIZE,MODEL,VENDOR,WWN,TRAN,HCTL" "NAME,KNAME,TYPE,SIZE,MODEL"; do
  run_cmd lsblk "$CMD_TIMEOUT" lsblk -d -n -P -o "$cols"; rc=$?
  [ "$rc" = 127 ] && break
  if [ "$rc" = 0 ] && [ -s "$RAW/lsblk.out" ]; then
    "$AWK" -v mode=disk -f "$WORK/lsblk.awk" "$RAW/lsblk.out" >> "$FACTS"
    break
  fi
done
: > "$WORK/blk.tsv"
for cols in "NAME,KNAME,PKNAME,TYPE,FSTYPE,MOUNTPOINT" "NAME,KNAME,TYPE,FSTYPE,MOUNTPOINT"; do
  run_cmd lsblk-tree "$CMD_TIMEOUT" lsblk -n -P -o "$cols"; rc=$?
  [ "$rc" = 127 ] && break
  if [ "$rc" = 0 ] && [ -s "$RAW/lsblk-tree.out" ]; then
    "$AWK" -v mode=tree -f "$WORK/lsblk.awk" "$RAW/lsblk-tree.out" > "$WORK/blk.tsv"
    break
  fi
done
if [ -d "$R/dev/disk/by-id" ]; then
  for l in "$R"/dev/disk/by-id/*; do
    [ -L "$l" ] || continue
    t=$(readlink -f -- "$l" 2>/dev/null)
    [ -n "$t" ] && fact BYID "${l##*/}" "${t##*/}"
  done
fi
: > "$WORK/dm.tsv"
for d in "$R"/sys/block/dm-*; do
  [ -d "$d" ] || continue
  nm=$(cat "$d/dm/name" 2>/dev/null)
  sl=$(ls "$d/slaves" 2>/dev/null | tr '\n' ',')
  fact DM "${d##*/}" "$nm" "${sl%,}"
  printf 'DM\t%s\t%s\t%s\n' "${d##*/}" "$nm" "${sl%,}" >> "$WORK/dm.tsv"
done

# ── RAID 컨트롤러(storcli / perccli) ───────────────────────────────────────────
find_raid_cli() {
  local c p
  for c in perccli64 perccli storcli64 storcli; do
    if have "$c"; then command -v "$c"; return 0; fi
  done
  for p in /opt/MegaRAID/perccli/perccli64 /opt/MegaRAID/perccli/perccli /opt/MegaRAID/storcli/storcli64 /opt/MegaRAID/storcli/storcli /opt/lsi/storcli/storcli64 /usr/sbin/storcli64; do
    if [ -x "$R$p" ]; then printf '%s\n' "$R$p"; return 0; fi
  done
  return 1
}
RAIDCLI=""; RAID_WHY=""
if [ "$USE_RAID" != 1 ]; then
  RAID_WHY="를 실행하지 않았습니다(--no-raid)"
elif ! RAIDCLI=$(find_raid_cli); then
  RAIDCLI=""; RAID_WHY="명령이 없습니다(Dell perccli 또는 Broadcom storcli 미설치)"
else
  prog "RAID 컨트롤러 읽는 중: $RAIDCLI"
  run_cmd raid-ctrlcount "$CMD_TIMEOUT" "$RAIDCLI" show ctrlcount
  NCTRL=$(sed -n 's/^Controller Count *= *\([0-9][0-9]*\).*/\1/p' "$RAW/raid-ctrlcount.out" | head -n 1)
  if [ -z "$NCTRL" ]; then
    fact NOTE "$RAIDCLI 가 컨트롤러 수를 알려 주지 않아 0번 컨트롤러만 시도했습니다(출력 형식이 예상과 다를 수 있음)."
    NCTRL=1
  fi
  [ "$NCTRL" -gt 8 ] && NCTRL=8
  [ "$NCTRL" = 0 ] && fact NOTE "$RAIDCLI 기준 RAID 컨트롤러가 0개입니다."
  c=0
  while [ "$c" -lt "$NCTRL" ]; do
    run_cmd "raid-c$c-pd" "$CMD_TIMEOUT" "$RAIDCLI" "/c$c/eall/sall" show all
    "$AWK" -v mode=pd -f "$WORK/perc.awk" "$RAW/raid-c$c-pd.out" > "$WORK/pd.tsv"
    if [ ! -s "$WORK/pd.tsv" ]; then      # 인클로저 없이 직접 붙은 구성
      run_cmd "raid-c$c-pd-noencl" "$CMD_TIMEOUT" "$RAIDCLI" "/c$c/sall" show all
      "$AWK" -v mode=pd -f "$WORK/perc.awk" "$RAW/raid-c$c-pd-noencl.out" > "$WORK/pd.tsv"
    fi
    cat "$WORK/pd.tsv" >> "$FACTS"
    run_cmd "raid-c$c-vd" "$CMD_TIMEOUT" "$RAIDCLI" "/c$c/vall" show all
    "$AWK" -v mode=vd -f "$WORK/perc.awk" "$RAW/raid-c$c-vd.out" >> "$FACTS"
    run_cmd "raid-c$c-events" "$LONG_TIMEOUT" "$RAIDCLI" "/c$c" show events
    "$AWK" -v mode=evt -v ctl="$c" -v src="${RAIDCLI##*/} /c$c show events" -f "$WORK/perc.awk" "$RAW/raid-c$c-events.out" >> "$FACTS"
    c=$((c + 1))
  done
fi
fact META raidcli "$RAIDCLI"
fact META raidcli_why "$RAID_WHY"

# ── smartctl ───────────────────────────────────────────────────────────────────
smart_one() { # smart_one 장치 종류 [probe]  — probe=1 이면 열지 못한 번호는 사실로 남기지 않는다
  local dev="$1" type="$2" probe="$3" name rc osdev handle
  name="smartctl_$(printf '%s' "$dev${type:+_$type}" | tr -c 'A-Za-z0-9' '_')"
  if [ -n "$type" ]; then run_cmd "$name" "$CMD_TIMEOUT" smartctl -x -d "$type" "$dev"; else run_cmd "$name" "$CMD_TIMEOUT" smartctl -x "$dev"; fi
  rc=$?
  if [ $((rc & 1)) = 1 ] && [ "$rc" -lt 124 ]; then      # 옛 판이 -x 를 모르면 -a 로 다시
    if [ -n "$type" ]; then run_cmd "$name" "$CMD_TIMEOUT" smartctl -a -d "$type" "$dev"; else run_cmd "$name" "$CMD_TIMEOUT" smartctl -a "$dev"; fi
    rc=$?
  fi
  if [ "$probe" = 1 ] && { [ $((rc & 2)) = 2 ] || [ "$rc" -ge 124 ]; }; then return 1; fi
  osdev=""
  case "$type" in megaraid,*|cciss,*|areca,*|3ware,*|aacraid,*) ;; *) osdev="${dev#/dev/}" ;; esac
  handle="$dev${type:+ -d $type}"
  "$AWK" -v handle="$handle" -v osdev="$osdev" -v rc="$rc" -f "$WORK/smart.awk" "$RAW/$name.out" >> "$FACTS"
  return 0
}
SMART_OK=0; SMART_WHY=""
if [ "$USE_SMART" != 1 ]; then
  SMART_WHY="을 실행하지 않았습니다(--no-smart)"
elif ! have smartctl; then
  SMART_WHY="명령이 없습니다(smartmontools 미설치)"
else
  SMART_OK=1
  prog "smartctl 읽는 중"
  run_cmd smartctl-scan "$CMD_TIMEOUT" smartctl --scan
  SM_LIST="$WORK/smart.list"; : > "$SM_LIST"
  while read -r dev opt type _; do
    case "$dev" in /dev/*) ;; *) continue ;; esac
    [ "$opt" = "-d" ] || type=""
    # --scan 은 SATA 디스크도 '-d scsi' 로 알려 준다. 그 값을 그대로 넘기면 smartctl 이 SAT 자동 판별을 하지 않아
    # ATA 속성을 못 읽는다(smartmontools os_linux.cpp autodetect_open — 기억 기반). 컨트롤러 경유(megaraid,N · cciss,N 등
    # 쉼표가 있는 종류)만 -d 로 넘기고 나머지는 자동 판별에 맡긴다.
    case "$type" in *,*) ;; *) type="" ;; esac
    printf '%s\t%s\n' "$dev" "$type" >> "$SM_LIST"
  done < "$RAW/smartctl-scan.out"
  # --scan 이 놓친 현재 디스크(옛 판의 NVMe 등)를 더한다
  VDNODE=""
  while IFS=$'\t' read -r tag name rest; do
    [ "$tag" = CUR ] || continue
    case "$name" in sr*|fd*|loop*|ram*|zram*) continue ;; esac
    case "$rest" in *PERC*|*MegaRAID*|*"LOGICAL VOLUME"*) [ -n "$VDNODE" ] || VDNODE="/dev/$name" ;; esac
    case "$rest" in *"tran=fc"*|*"tran=iscsi"*|*"tran=usb"*) continue ;; esac      # SAN LUN · USB 는 이 서버의 디스크 SMART 가 아니다
    alt="/dev/${name%n[0-9]*}"
    if ! grep -q -e "^/dev/$name	" -e "^$alt	" "$SM_LIST"; then printf '/dev/%s\t\n' "$name" >> "$SM_LIST"; fi
  done < "$FACTS"
  while IFS=$'\t' read -r dev type; do
    smart_one "$dev" "$type" 0
  done < "$SM_LIST"
  # RAID 뒤 물리 디스크: --scan 에 megaraid 항목이 없으면 storcli 의 DID 로, 그것도 없으면 0~31 을 차례로 열어 본다
  if [ -n "$VDNODE" ] && ! grep -q 'megaraid,' "$SM_LIST"; then
    DIDS=$("$AWK" -F'\t' '$1 == "PD" { for (i = 3; i <= NF; i++) if ($i ~ /^did=[0-9]+$/) print substr($i, 5) }' "$FACTS" | sort -n | uniq)
    if [ -n "$DIDS" ]; then
      for n in $DIDS; do smart_one "$VDNODE" "megaraid,$n" 1; done
    else
      n=0; miss=0
      while [ "$n" -le 31 ] && [ "$miss" -lt 8 ]; do
        if smart_one "$VDNODE" "megaraid,$n" 1; then miss=0; else miss=$((miss + 1)); fi
        n=$((n + 1))
      done
    fi
  fi
fi
fact META smartctl "$SMART_OK"
fact META smartctl_why "$SMART_WHY"

# ── 파일시스템 · md · LVM · 설치 시각(판정 ② 근거) ──────────────────────────────
prog "파일시스템 · LVM 생성 시각 읽는 중"
"$AWK" -F'\t' '
  $1 == "DM"  { n = split($4, s, ","); for (i = 1; i <= n; i++) if (s[i] != "") par[$2] = par[$2] " " s[i]; next }
  $1 == "BLK" { type[$2] = $4; if ($3 != "") par[$2] = par[$2] " " $3; if ($5 != "" && !($2 in fst)) { fst[$2] = $5; mnt[$2] = $6; order[++c] = $2 } }
  function up(k, depth,   q, n, i) {
    if (depth > 8 || (k in seen)) return
    seen[k] = 1
    if (type[k] == "disk") { disks[k] = 1; return }
    n = split(par[k], q, " ")
    if (n == 0 && k ~ /^(sd[a-z]+|vd[a-z]+|nvme[0-9]+n[0-9]+)$/) { disks[k] = 1; return }
    if (n == 0 && k ~ /^(sd|vd)[a-z]+[0-9]+$/) { sub(/[0-9]+$/, "", k); disks[k] = 1; return }        # 트리에 부모 줄이 없는 파티션
    if (n == 0 && k ~ /^nvme[0-9]+n[0-9]+p[0-9]+$/) { sub(/p[0-9]+$/, "", k); disks[k] = 1; return }
    for (i = 1; i <= n; i++) up(q[i], depth + 1)
  }
  END {
    for (j = 1; j <= c; j++) {
      k = order[j]; split("", seen); split("", disks); up(k, 0)
      d = ""; for (x in disks) d = d (d == "" ? "" : ",") x
      printf "%s\t%s\t%s\t%s\n", k, fst[k], (mnt[k] == "" ? "-" : mnt[k]), (d == "" ? "-" : d)
    }
  }' "$WORK/dm.tsv" "$WORK/blk.tsv" > "$WORK/fs.list"
while IFS=$'\t' read -r kname fstype mnt disks; do
  [ "$mnt" = "-" ] && mnt=""
  [ "$disks" = "-" ] && disks=""
  epoch=""; how=""
  case "$fstype" in
    ext2|ext3|ext4)
      how="tune2fs -l"
      if run_cmd "tune2fs-$kname" "$CMD_TIMEOUT" tune2fs -l "/dev/$kname"; then
        x=$(sed -n 's/^Filesystem created: *//p' "$RAW/tune2fs-$kname.out" | head -n 1)
        [ -n "$x" ] && epoch=$(to_epoch "$x")
      fi
      [ -n "$epoch" ] || how="tune2fs -l 로 읽지 못함"
      ;;
    xfs)
      # ① 마운트 지점 루트 디렉터리의 생성 시각(statx — RHEL 9 의 coreutils 만 지원) ② xfs_db 로 루트 inode crtime(v5 포맷만)
      if [ -n "$mnt" ]; then
        x=$(stat -c %W -- "$R$mnt" 2>/dev/null)
        case "$x" in ''|0|-|*[!0-9]*) ;; *) epoch="$x"; how="stat 생성 시각(마운트 지점 루트 = mkfs 때 생성 · 추정)" ;; esac
      fi
      if [ -z "$epoch" ] && run_cmd "xfsdb-sb-$kname" "$CMD_TIMEOUT" xfs_db -r -c "sb 0" -c "print rootino" "/dev/$kname"; then
        ino=$(sed -n 's/^rootino *= *\([0-9][0-9]*\).*/\1/p' "$RAW/xfsdb-sb-$kname.out" | head -n 1)
        if [ -n "$ino" ] && run_cmd "xfsdb-ino-$kname" "$CMD_TIMEOUT" xfs_db -r -c "inode $ino" -c "print v3.crtime.sec" "/dev/$kname"; then
          x=$(sed -n 's/^v3\.crtime\.sec *= *//p' "$RAW/xfsdb-ino-$kname.out" | head -n 1)
          [ -n "$x" ] && epoch=$(to_epoch "$x")
          [ -n "$epoch" ] && how="xfs_db 루트 inode 생성 시각(= mkfs 시각 · 추정)"
        fi
      fi
      [ -n "$epoch" ] || how="XFS 생성 시각을 읽지 못함(v4 포맷이거나 xfs_db · statx 미지원)"
      ;;
    swap|LVM2_member|linux_raid_member|crypto_LUKS|iso9660|"") continue ;;
    *) how="이 파일시스템($fstype)은 생성 시각 조회를 지원하지 않음" ;;
  esac
  fact FS "$kname" "$fstype" "$mnt" "$epoch" "$how" "$disks"
done < "$WORK/fs.list"

if [ -r "$R/proc/mdstat" ]; then
  "$AWK" '/^md[0-9]+ *:/ { m = ""; for (i = 3; i <= NF; i++) if ($i ~ /\[[0-9]+\]/) { x = $i; sub(/\[.*$/, "", x); m = m (m == "" ? "" : ",") x } print $1 "\t" m }' "$R/proc/mdstat" > "$WORK/md.list"
  while IFS=$'\t' read -r md members; do
    epoch=""
    if run_cmd "mdadm-$md" "$CMD_TIMEOUT" mdadm --detail "/dev/$md"; then
      x=$(sed -n 's/^ *Creation Time *: *//p' "$RAW/mdadm-$md.out" | head -n 1)
      [ -n "$x" ] && epoch=$(to_epoch "$x")
    fi
    fact MD "$md" "$epoch" "$members"
  done < "$WORK/md.list"
fi

for kind in backup archive; do
  dir="$R/etc/lvm/$kind"
  [ -d "$dir" ] || continue
  if [ ! -r "$dir" ]; then fact NOTE "/etc/lvm/$kind 를 읽지 못했습니다(권한) — LVM 변경 이력은 불명입니다."; continue; fi
  for f in "$dir"/*; do
    if [ ! -f "$f" ] || [ ! -r "$f" ]; then continue; fi
    "$AWK" -v kind="$kind" -v file="${f#"$R"}" -f "$WORK/lvm.awk" "$f" >> "$FACTS"
  done
done

if run_cmd rpm-basesystem "$CMD_TIMEOUT" rpm -q --qf '%{INSTALLTIME}\n' basesystem; then
  x=$(head -n 1 "$RAW/rpm-basesystem.out")
  case "$x" in ''|*[!0-9]*) ;; *) fact OSINST "$x" "rpm basesystem 설치 시각" ;; esac
fi

# ── 로그 ───────────────────────────────────────────────────────────────────────
found=0
for f in "$R"/var/log/messages*; do [ -e "$f" ] || continue; found=1; scan_file M "$f"; done
[ "$found" = 1 ] || src_fail M "/var/log/messages*" "파일 없음"
for f in "$R"/var/log/secure*; do [ -e "$f" ] || continue; scan_file S "$f"; done
for f in "$R/var/log/dmesg" "$R/var/log/dmesg.old"; do [ -e "$f" ] || continue; scan_file O "$f"; done
i=0
while [ "$i" -lt "${#EXTRA_LOGS[@]}" ]; do
  f="${EXTRA_LOGS[$i]}"; i=$((i + 1))
  if [ -e "$f" ]; then R_SAVE="$R"; R=""; scan_file X "$f"; R="$R_SAVE"; else src_fail X "$f" "파일 없음"; fi
done

if [ "$USE_HISTORY" = 1 ] && [ -e "$R/root/.bash_history" ]; then
  if [ -r "$R/root/.bash_history" ]; then
    # 셸 기록을 'sudo: COMMAND=' 줄 모양으로 바꿔 같은 분류기(포맷 계열 명령만 남김)에 태운다. '#epoch' 줄이 있으면 시각으로 쓴다.
    "$AWK" '/^#[0-9]+$/ { t = substr($0, 2) + 0; print ""; next }
            { if (t > 0) printf "%s localhost sudo: COMMAND=%s\n", strftime("%Y-%m-%dT%H:%M:%S%z", t), $0; else printf "localhost sudo: COMMAND=%s\n", $0; t = 0 }' \
      "$R/root/.bash_history" | scan_log H "/root/.bash_history" 0 0
  else
    src_fail H "/root/.bash_history" "못 읽음(권한 없음)"
  fi
fi

if [ "$USE_JOURNAL" != 1 ]; then
  src_fail J "journalctl" "읽지 않음(--no-journal)"
elif ! have journalctl; then
  fact CMD journalctl 127 "명령 없음" "journalctl"
  src_fail J "journalctl" "명령 없음"
else
  prog "journal 읽는 중(오래 걸릴 수 있습니다)"
  JARGS="_TRANSPORT=kernel + SYSLOG_IDENTIFIER=smartd + SYSLOG_IDENTIFIER=multipathd + SYSLOG_IDENTIFIER=iscsid + SYSLOG_IDENTIFIER=sudo + SYSLOG_IDENTIFIER=MR_MONITOR"
  # 저널 전체의 가장 오래된 항목(보존 구간)
  tmo "$CMD_TIMEOUT" journalctl --no-pager -o short-iso 2>/dev/null | head -n 5 \
    | "$AWK" -v st=JH -v src="journalctl(전체 범위)" -v mtime=0 -v boot_epoch=0 -v now="$NOW" -f "$WORK/classify.awk" | grep '^SRC' >> "$EVENTS"
  : > "$WORK/j.tsv"
  # shellcheck disable=SC2086
  tmo "$LONG_TIMEOUT" journalctl --no-pager -o short-iso $JARGS 2>"$RAW/journalctl.err" \
    | "$AWK" -v st=J -v src="journalctl(커널·smartd 등)" -v mtime=0 -v boot_epoch=0 -v now="$NOW" -f "$WORK/classify.awk" > "$WORK/j.tsv"
  rc=${PIPESTATUS[0]}
  jl=$("$AWK" -F'\t' '$1 == "SRC" { print $8 + 0 }' "$WORK/j.tsv" | head -n 1)
  if [ "$rc" != 0 ] && [ "${jl:-0}" = 0 ]; then
    # 조건식(+)을 모르는 옛 판이면 전체를 읽어 걸러 낸다
    fact CMD journalctl "$rc" "종료 코드 $rc — 조건 없이 다시 읽음" "journalctl --no-pager -o short-iso $JARGS"
    tmo "$LONG_TIMEOUT" journalctl --no-pager -o short-iso 2>"$RAW/journalctl.err" \
      | "$AWK" -v st=J -v src="journalctl(전체)" -v mtime=0 -v boot_epoch=0 -v now="$NOW" -f "$WORK/classify.awk" > "$WORK/j.tsv"
    rc=${PIPESTATUS[0]}
    fact CMD journalctl "$rc" "$([ "$rc" = 0 ] && echo 정상 || echo "종료 코드 $rc")" "journalctl --no-pager -o short-iso"
  else
    fact CMD journalctl "$rc" "$([ "$rc" = 0 ] && echo 정상 || echo "종료 코드 $rc")" "journalctl --no-pager -o short-iso $JARGS"
  fi
  case "$rc" in 124|137) fact NOTE "journalctl 이 시한(${LONG_TIMEOUT}초) 안에 끝나지 않아 앞부분만 읽었습니다(--long-timeout 으로 늘릴 수 있음)." ;; esac
  cat "$WORK/j.tsv" >> "$EVENTS"
  [ "$IS_ROOT" = 1 ] || fact NOTE "root 가 아니어서 journalctl 은 볼 수 있는 범위(자기 로그 또는 systemd-journal 그룹)만 읽었습니다."
fi

if run_cmd dmesg "$CMD_TIMEOUT" dmesg && [ -s "$RAW/dmesg.out" ]; then
  scan_log D "dmesg(현재 부팅분만)" 0 "$BOOT_EPOCH" < "$RAW/dmesg.out"
else
  src_fail D "dmesg" "못 읽음($(have dmesg && echo '권한 없음 또는 kernel.dmesg_restrict' || echo '명령 없음'))"
fi

# ══════════════════════════════════════════════════════════════════════════════
# 판정 · 출력
# ══════════════════════════════════════════════════════════════════════════════
grep -a '^EVT' "$EVENTS" | sort -s -t "$(printf '\t')" -k2,2n >> "$FACTS"
grep -a -v '^EVT' "$EVENTS" >> "$FACTS"

[ "$MAX_EVIDENCE" -lt 6 ] && MAX_EVIDENCE=6
if ! "$AWK" -v NOW="$NOW" -v VERSION="$VERSION" -v MAXEV="$MAX_EVIDENCE" -f "$WORK/analyze.awk" "$FACTS" > "$WORK/report.raw" 2> "$WORK/analyze.err"; then
  cp "$FACTS" "$OUTDIR/rhel-disk-history_${HOST_SAFE}_${STAMP}_facts.tsv" 2>/dev/null
  cat "$WORK/analyze.err" >&2
  die "판정 단계가 실패했습니다 — 모은 사실은 $OUTDIR/rhel-disk-history_${HOST_SAFE}_${STAMP}_facts.tsv 에 남겼습니다."
fi

{
  grep '^[SF]|' "$WORK/report.raw" | cut -c3-
  [ -n "$OUT_NOTE" ] && printf '%s\n' "주의: $OUT_NOTE"
  printf '%s\n' "결과 파일: $OUTFILE (권한 600 — 호스트 이름 · 시리얼 · 로그 줄이 들어 있습니다)"
} > "$OUTFILE"
chmod 600 "$OUTFILE" 2>/dev/null

if [ "$SAVE_RAW" = 1 ]; then
  mkdir -p "$RAWKEEP" && cp "$RAW"/* "$RAWKEEP"/ 2>/dev/null
  cp "$FACTS" "$RAWKEEP/facts.tsv" 2>/dev/null
  chmod -R go-rwx "$RAWKEEP" 2>/dev/null
fi

if [ "$QUIET" != 1 ]; then
  case "$ORIG_CTYPE" in
    *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) ;;
    *) printf '%s\n' "NOTE: terminal locale is not UTF-8 ('${ORIG_CTYPE:-unset}'); the Korean text below may be garbled." \
                     "      The result file is UTF-8 - view it in a UTF-8 terminal or copy it to a PC." ;;
  esac
  grep '^S|' "$WORK/report.raw" | cut -c3-
  [ -n "$OUT_NOTE" ] && printf '%s\n' "주의: $OUT_NOTE"
fi
printf '%s\n' "결과 파일(상세 근거 포함): $OUTFILE"
[ "$SAVE_RAW" = 1 ] && printf '%s\n' "명령 원본 출력: $RAWKEEP/"

CODE=$(sed -n 's/^X|//p' "$WORK/report.raw" | tail -n 1)
case "$CODE" in 10|20) exit "$CODE" ;; *) exit 0 ;; esac
