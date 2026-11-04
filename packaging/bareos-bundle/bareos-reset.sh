#!/usr/bin/env bash
#
# bareos-reset.sh — 이 서버의 Bareos 를 **완전히** 지운다(카탈로그 DB · 백업 볼륨 · 패키지 · 설정 · 상태 · 로그).
#
# 왜 있나(2026-11-04 사용자 요청 '기존 백업 카탈로그와 볼륨 삭제 — 완전히 초기화 · 프로그램으로'):
#   포탈 '법인 Bareos 완전 설치' 의 사전 점검은 서버에 Bareos 가 이미 있으면 막는다. 포탈에 Director 가 등록되지 않은(사람이 직접 설치한)
#   Bareos 는 마법사의 '초기화 후 재설치' 가 열리지 않아 길이 없었다. 이 스크립트로 지운 뒤 마법사의 '다시 점검' 을 누르면 진행된다.
#   규칙은 포탈 설치 러너의 0단계(초기화 — server/src/bareos/install/runner.sh step0)와 같다:
#     · 실행 중 작업이 있거나 확인하지 못하면 멈춘다(못 읽음을 0 으로 보지 않는다 — bconsole 접속이 확인될 때만 센다)
#     · 볼륨은 SD 설정의 Archive Device 경로만, 시스템 경로 · 얕은 경로 · '..' · 심링크(부모 포함)는 지우지 않는다 — 디렉터리 안의 파일만 지운다
#       (v2.876 반증: /var/log · /var/lib/pgsql · /var/spool · 홈 바로 아래 · /tmp 아래 · 공백 · 글롭 글자가 든 경로도 — safe_voldir 는 러너와 같은 글자, 시험이 대조)
#     · --dry-run 은 아무것도 바꾸지 않는다(PostgreSQL 이 꺼져 있으면 켜지 않고 카탈로그를 '모름' 으로 보인다)
#     · 패키지는 dnf remove --noautoremove(의존 자동 제거 없음 · 저장소에 접속하지 않음)
#   ⚠ 되돌릴 수 없다. 기본은 아무것도 보관하지 않는다(사용자 결정). 남기려면 --keep-catalog · --keep-volumes.
#
# 사용(root):
#   bash bareos-reset.sh --dry-run          # 지울 것만 보여 준다(아무것도 바꾸지 않는다)
#   bash bareos-reset.sh                    # 지울 것을 보여 주고, 서버 이름(hostname -s)을 입력하면 실행
#   bash bareos-reset.sh --yes              # 확인 입력 없이(자동화용)
#   옵션: --keep-catalog(카탈로그 DB 를 남김) · --keep-volumes(볼륨 파일을 남김) · --ignore-running(실행 중 작업 확인을 건너뜀 — 위험)
# 로그: /var/log/bareos-reset-<시각>.log
#
# 시험(server/test/bareosResetScript2876.test.js)은 RESET_ROOT(가짜 루트)와 명령 대역(PATH)으로 이 파일을 실제 bash 로 돌린다 — 운영에서는 비워 둔다.

set -u
export LC_ALL=C

P="${RESET_ROOT:-}"                       # 시험용 가짜 루트(운영: 빈 값)
ETC="$P/etc/bareos"
WEBUI_ETC="$P/etc/bareos-webui"
VARLIB="$P/var/lib/bareos"
VARLOG="$P/var/log/bareos"
PGDATA="${PGDATA:-$P/var/lib/pgsql/data}"
DEFAULT_VOLDIR="/var/lib/bareos/storage"

DRY=0; YES=0; KEEP_DB=0; KEEP_VOL=0; IGN_RUN=0
for a in "$@"; do
  case "$a" in
    (--dry-run) DRY=1 ;;
    (--yes) YES=1 ;;
    (--keep-catalog) KEEP_DB=1 ;;
    (--keep-volumes) KEEP_VOL=1 ;;
    (--ignore-running) IGN_RUN=1 ;;
    (-h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    (*) echo "알 수 없는 옵션: $a (--help 참고)" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" != 0 ]; then echo "root 로 실행하세요(sudo 경로는 쓰지 않습니다)." >&2; exit 2; fi

LOGDIR="$P/var/log"
mkdir -p "$LOGDIR" 2>/dev/null || true
LOG="$LOGDIR/bareos-reset-$(date +%Y%m%d-%H%M%S).log"
log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }
die() { log "멈춤: $*"; exit 1; }

# 지워도 되는 볼륨 디렉터리인가 — runner.sh safe_voldir 와 같은 판정(시스템 경로 · 얕은 경로 · '..' · 심링크 · 부모 심링크 거부)
safe_voldir() {
  local x="${1#$P}"
  case "$x" in (/|/etc|/etc/*|/usr|/usr/*|/bin|/bin/*|/sbin|/sbin/*|/lib|/lib/*|/lib64|/lib64/*|/boot|/boot/*|/dev|/dev/*|/proc|/proc/*|/sys|/sys/*|/run|/run/*|/root|/home|/var|/var/lib|/opt|/tmp|/srv|/mnt|/media) return 1;; esac
  # v2.876(반증 I — 재현: Archive Device 가 /var/log 면 그 안의 로그를 지웠다): 볼륨이 아닌 것이 분명한 곳 · 사람의 홈 바로 아래 · 글자 밖 경로(공백 · 글롭)도 지우지 않는다
  case "$x" in (/var/log|/var/log/*|/var/spool|/var/spool/*|/var/cache|/var/cache/*|/var/tmp|/var/tmp/*|/var/mail|/var/mail/*|/var/lib/pgsql|/var/lib/pgsql/*|/var/lib/mysql|/var/lib/mysql/*|/var/lib/rpm|/var/lib/rpm/*|/var/lib/dnf|/var/lib/dnf/*|/var/lib/portal-bareos-install|/var/lib/portal-bareos-install/*|/tmp/*) return 1;; esac
  case "$x" in (/home/*/*|/root/*/*) ;; (/home/*|/root/*) return 1;; esac
  case "$x" in (*[!A-Za-z0-9._/-]*) return 1;; esac
  case "$x" in (/*/*) ;; (*) return 1;; esac
  case "$x" in (*..*) return 1;; esac
  [ -d "$1" ] && [ ! -L "$1" ] || return 1
  local rp; rp="$(realpath -e -- "$1" 2>/dev/null)" || return 1
  [ "$rp" = "$1" ]
}

# 실행 중 작업 수 — 숫자 | inactive(Director 꺼짐) | unknown(못 읽음 — 0 이 아니다). runner.sh running_jobs 와 같은 판정.
running_jobs() {
  local s; s="$(systemctl is-active bareos-dir 2>/dev/null)"
  case "$s" in
    (inactive|failed) echo inactive; return 0 ;;
    (active|activating|reloading|deactivating) ;;
    (*) echo unknown; return 0 ;;
  esac
  command -v bconsole >/dev/null 2>&1 || { echo unknown; return 0; }
  local o rc; o="$(printf 'llist jobs jobstatus=R\n' | timeout 45 bconsole 2>&1)"; rc=$?
  if [ $rc -eq 0 ] && printf '%s\n' "$o" | grep -q 'Connecting to Director' && ! printf '%s\n' "$o" | grep -qiE 'Authorization failed|Failed to connect|ERR='; then
    printf '%s\n' "$o" | grep -cE '^[[:space:]]*jobid:[[:space:]]*[0-9]+'
  else echo unknown; fi
}

pg_q() { su - postgres -c "psql -tAc \"$1\"" 2>/dev/null | tr -d '[:space:]'; }

# ───────── 1. 살피기(아무것도 바꾸지 않는다)
PKGS="$(rpm -qa --qf '%{NAME}\n' 2>/dev/null | grep -E '^(bareos(-|$)|python3-bareos$)' | sort -u | tr '\n' ' ')"
ETC_N="없음"; [ -d "$ETC" ] && ETC_N="$(find "$ETC" -type f 2>/dev/null | wc -l | tr -d ' ')개 파일"
# 볼륨 경로는 설정을 지우기 **전에** 읽는다(Archive Device) — 설정이 없으면 기본 경로
# v2.876(반증 H — 재현: 따옴표 없이 펼쳐 '/data/bareos vol' 이 '/data/bareos' 로 갈라졌다): 한 줄 = 한 경로(배열) · 쓸 때는 늘 "${VOLARR[@]}"
VOLARR=()
if [ -d "$ETC/bareos-sd.d/device" ]; then
  mapfile -t VOLARR < <(sed -n 's/^[[:space:]]*Archive[[:space:]]*Device[[:space:]]*=[[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}[[:space:]]*$/\1/Ip' "$ETC"/bareos-sd.d/device/*.conf 2>/dev/null | sed '/^$/d' | sort -u)
fi
[ ${#VOLARR[@]} -gt 0 ] || VOLARR=("$DEFAULT_VOLDIR")
DB_STATE="PostgreSQL 데이터 없음"; DB_EXISTS=0; DB_UNKNOWN=0
if [ -f "$PGDATA/PG_VERSION" ] && [ $DRY = 1 ] && ! systemctl is-active -q postgresql >/dev/null 2>&1; then
  # v2.876(반증 G): --dry-run 은 아무것도 바꾸지 않는다 — PostgreSQL 을 켜지 않는다(카탈로그는 '모름')
  DB_STATE="모름(PostgreSQL 꺼짐 — --dry-run 은 켜지 않습니다. 실제 실행 때 켜서 확인합니다)"; DB_UNKNOWN=1
elif [ -f "$PGDATA/PG_VERSION" ]; then
  systemctl start postgresql >/dev/null 2>&1 || true
  if [ "$(pg_q "SELECT 1 FROM pg_database WHERE datname='bareos'")" = 1 ]; then
    DB_EXISTS=1
    J="$(su - postgres -c "psql -d bareos -tAc \"SELECT count(*) FROM job\"" 2>/dev/null | tr -d '[:space:]')"
    DB_STATE="있음(카탈로그 실행 기록 ${J:-모름}건)"
  else DB_STATE="없음"; fi
fi
RUN="$(running_jobs)"

log "== Bareos 완전 초기화 — $(hostname -f 2>/dev/null || hostname) =="
log "패키지: ${PKGS:-없음}"
log "/etc/bareos: $ETC_N · /etc/bareos-webui: $([ -d "$WEBUI_ETC" ] && echo 있음 || echo 없음)"
log "카탈로그 DB(bareos): $DB_STATE$([ $KEEP_DB = 1 ] && echo ' — 남김(--keep-catalog)')"
for d in "${VOLARR[@]}"; do
  dd="$P$d"
  if [ ! -d "$dd" ]; then log "볼륨 경로 $d: 없음"
  elif ! safe_voldir "$dd"; then log "볼륨 경로 $d: 지우지 않음(시스템 경로 · 얕은 경로 · 심링크)"
  else log "볼륨 경로 $d: $(find "$dd" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')개 항목 · $(du -sh "$dd" 2>/dev/null | cut -f1)$([ $KEEP_VOL = 1 ] && echo ' — 남김(--keep-volumes)')"; fi
done
case "$RUN" in
  (inactive) log "실행 중 작업: Director 꺼짐(없음)" ;;
  (0) log "실행 중 작업: 0개(bconsole 접속 확인)" ;;
  (unknown|''|*[!0-9]*) log "실행 중 작업: 확인하지 못함(Director 는 켜져 있는데 bconsole 로 묻지 못함 — 0 이 아닙니다)"
    [ $IGN_RUN = 1 ] || die "실행 중 작업을 확인하지 못했습니다 — Director 를 멈추거나(systemctl stop bareos-dir) --ignore-running 으로 다시 실행하세요. 아무것도 지우지 않았습니다." ;;
  (*) log "실행 중 작업: ${RUN}개"
    [ $IGN_RUN = 1 ] || die "실행 중인 작업이 ${RUN}개 있습니다 — 끝난 뒤 다시 하세요(또는 --ignore-running). 아무것도 지우지 않았습니다." ;;
esac

# 지울 것이 하나도 없으면 끝(다시 실행해도 안전)
NEED=0
[ -n "$PKGS" ] && NEED=1
[ -d "$ETC" ] && NEED=1
[ -d "$WEBUI_ETC" ] && NEED=1
[ $KEEP_DB = 0 ] && { [ $DB_EXISTS = 1 ] || [ $DB_UNKNOWN = 1 ]; } && NEED=1
if [ $KEEP_VOL = 0 ]; then for d in "${VOLARR[@]}"; do dd="$P$d"; if safe_voldir "$dd" && [ -n "$(find "$dd" -mindepth 1 -maxdepth 1 2>/dev/null | head -1)" ]; then NEED=1; fi; done; fi
[ $NEED = 1 ] || { log "지울 Bareos 가 없습니다 — 이미 초기화된 상태입니다."; exit 0; }

if [ $DRY = 1 ]; then log "--dry-run: 아무것도 바꾸지 않았습니다."; exit 0; fi

# ───────── 2. 확인
if [ $YES = 0 ]; then
  want="$(hostname -s 2>/dev/null || hostname)"
  printf '\n⚠ 위 항목을 영구히 지웁니다(되돌릴 수 없음). 계속하려면 서버 이름 ‘%s’ 을 입력하세요: ' "$want"
  read -r typed || typed=""
  [ "$typed" = "$want" ] || { log "확인 입력이 다릅니다 — 아무것도 지우지 않았습니다."; exit 1; }
fi

# ───────── 3. 지우기(되돌리지 않는다 — 다시 실행하면 이미 지운 것은 건너뛴다)
for u in bareos-dir bareos-sd bareos-fd; do systemctl disable --now "$u" >/dev/null 2>&1 || true; done
log "서비스 멈춤: bareos-dir · bareos-sd · bareos-fd"

if [ $KEEP_DB = 0 ] && [ -f "$PGDATA/PG_VERSION" ]; then
  if [ "$(pg_q "SELECT 1 FROM pg_database WHERE datname='bareos'")" = 1 ]; then
    su - postgres -c "dropdb bareos" >>"$LOG" 2>&1 || die "카탈로그 DB 를 지우지 못했습니다(dropdb bareos) — 로그를 보세요."
    log "카탈로그 DB 삭제: bareos"
  fi
  su - postgres -c "psql -tAc \"DROP ROLE IF EXISTS bareos\"" >>"$LOG" 2>&1 || true
fi

if [ $KEEP_VOL = 0 ]; then
  for d in "${VOLARR[@]}"; do
    dd="$P$d"
    if safe_voldir "$dd"; then
      find "$dd" -mindepth 1 -maxdepth 1 -exec rm -rf {} + || die "볼륨을 지우지 못했습니다($d)."
      log "볼륨 삭제: $d 안의 파일(디렉터리는 남김)"
    else log "볼륨 경로 $d 는 지우지 않음(없음 · 시스템 경로 · 심링크)"; fi
  done
fi

if [ -n "$PKGS" ]; then
  # shellcheck disable=SC2086
  dnf -y --disablerepo='*' --noautoremove remove $PKGS >>"$LOG" 2>&1 || die "패키지를 지우지 못했습니다(dnf remove) — 로그를 보세요."
  log "패키지 삭제: $PKGS"
fi

rm -rf "$ETC" "$WEBUI_ETC" "$VARLOG"
[ $KEEP_VOL = 0 ] && rm -rf "$VARLIB"
log "설정 · 로그 삭제: /etc/bareos · /etc/bareos-webui · /var/log/bareos$([ $KEEP_VOL = 0 ] && echo ' · /var/lib/bareos')"

# ───────── 4. 확인
left="$(rpm -qa --qf '%{NAME}\n' 2>/dev/null | grep -E '^(bareos(-|$)|python3-bareos$)' | tr '\n' ' ')"
[ -z "$left" ] || die "남은 패키지: $left"
[ ! -d "$ETC" ] || die "/etc/bareos 가 남아 있습니다."
if [ $KEEP_DB = 0 ] && [ -f "$PGDATA/PG_VERSION" ] && [ "$(pg_q "SELECT 1 FROM pg_database WHERE datname='bareos'")" = 1 ]; then die "카탈로그 DB 가 남아 있습니다."; fi
log "완료 — 포탈 '법인 Bareos 완전 설치' 화면에서 '다시 점검' 을 누르세요. 로그: $LOG"
exit 0
