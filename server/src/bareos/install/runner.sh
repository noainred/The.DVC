#!/bin/bash
# vmware-portal — Bareos 완전 설치 러너(v2.844). 포탈이 법인 엣지 노드에 올려 systemd-run 으로 **그 서버 안에서** 돌린다. 손으로 고치지 말 것.
#
# 단계(포탈 화면 번호와 같다): 0 기존 제거(초기화일 때만 · 되돌리지 않음) · 1 번들 풀기·로컬 저장소 · 2 패키지·pyVmomi·카탈로그 DB · 3 볼륨·SD 장치·서비스
# 4~7(Director 리소스·FD 플러그인·엣지 경유 확인·매핑)은 포탈이 기존 자동 설정 코드로 한다.
# 기록(포탈이 SSH 로 읽는다 — 비밀은 쓰지 않는다):
#   run/state       단계 상태 한 줄씩 '<단계> <상태> <epoch> [메모]'  상태: start ok fail rolledback rollback-fail stopped · 'all done|rolledback'
#   run/run.log     명령 이름과 출력 꼬리(명령 인자에 비밀이 없다 — SD 비밀번호는 셸 변수에서 파일로만)
#   run/err.<n>     실패한 명령·종료 코드·출력 마지막 60줄(포탈이 원인을 분류한다)
#   run/journal.<n> 그 단계가 바꾼 것(되돌리기 목록 — 역순으로 되돌린다)
# 입력: run/plan.env(포탈이 화이트리스트로 만든 KEY='값' — 따옴표·$ 없음)
# 시험: PORTAL_TEST_ROOT 를 주면 모든 경로 앞에 붙는다(server/test 가 가짜 루트 + 명령 대역으로 돌린다).
set -u
umask 077
P="${PORTAL_TEST_ROOT:-}"
W="$P/var/lib/portal-bareos-install"
R="$W/run"
ETC_BAREOS="$P/etc/bareos"
REPO_FILE="$P/etc/yum.repos.d/portal-bareos-local.repo"
PGDATA="$P/var/lib/pgsql/data"
MARKER='# managed-by: vmware-portal bareos auto-setup (rewritten on re-run)'
DEFAULT_STORE="$P/var/lib/bareos/storage"
cd / || exit 1
. "$R/plan.env" || exit 1
CUR=-
STATE="$R/state"
LOG="$R/run.log"

log() { printf '%s [%s] %s\n' "$(date '+%F %T')" "$CUR" "$*" >> "$LOG"; }
st() { printf '%s %s %s %s\n' "$1" "$2" "$(date +%s)" "${3:-}" >> "$STATE"; }
jr() { printf '%s\n' "$*" >> "$R/journal.$CUR"; }
# 사람이 읽는 실패(명령 없이) — 원인 분류용 code 를 붙인다
errx() { { echo "cmd=$1"; echo "code=${3:-1}"; echo "cause=${4:-}"; echo "---"; printf '%s\n' "$2"; } > "$R/err.$CUR"; log "실패: $1 — $2"; return 1; }
# run <이름> 명령…  — 출력은 로그 꼬리와(실패면) err 파일로
run() {
  local label="$1"; shift
  log "\$ $label"
  local tmp; tmp="$(mktemp "$R/out.XXXXXX")"
  "$@" > "$tmp" 2>&1; local rc=$?
  tail -n 200 "$tmp" >> "$LOG"
  if [ $rc -ne 0 ]; then
    { echo "cmd=$label"; echo "code=$rc"; echo "cause="; echo "---"; tail -n 60 "$tmp"; } > "$R/err.$CUR"
    log "실패(종료 코드 $rc): $label"
  fi
  rm -f "$tmp"
  return $rc
}
is_marker_file() { [ -f "$1" ] && [ ! -L "$1" ] && [ "$(head -n 1 "$1")" = "$MARKER" ]; }

# 포탈 표지 파일 놓기 — 없으면 만들고, 표지 파일이면 옛 내용을 사본으로 두고 바꾸고, 남의 파일·심링크면 멈춘다.
# place <경로> <소유자> <그룹> <모드>  (내용은 표준입력 — 비밀이 명령 인자에 실리지 않게)
place() {
  local dest="$1" own="$2" grp="$3" mode="$4" d; d="$(dirname "$dest")"
  if [ -L "$dest" ] || [ -L "$d" ]; then errx "파일 놓기" "$dest 또는 그 디렉터리가 심링크입니다 — 바꾸지 않았습니다." 1 conflict; return 1; fi
  if [ -e "$dest" ] && ! is_marker_file "$dest"; then errx "파일 놓기" "$dest 가 이미 있고 포탈이 만든 파일이 아닙니다 — 덮어쓰지 않습니다." 1 conflict; return 1; fi
  local t; t="$(mktemp "$R/f.XXXXXX")"; cat > "$t"
  if [ -e "$dest" ]; then local b; b="$R/bak.$CUR.$(basename "$dest").$(date +%s%N)"; cp -p "$dest" "$b"; jr file-old "$dest" "$b"; else jr file "$dest"; fi
  install -o "$own" -g "$grp" -m "$mode" "$t" "$dest" || { rm -f "$t"; errx "파일 놓기" "$dest 를 쓰지 못했습니다." 1; return 1; }
  rm -f "$t"
}
enable_start() {
  local u="$1"
  if ! systemctl is-enabled -q "$u" 2>/dev/null; then run "systemctl enable $u" systemctl enable "$u" || return 1; jr svc-enabled "$u"; fi
  if ! systemctl is-active -q "$u" 2>/dev/null; then run "systemctl start $u" systemctl start "$u" || return 1; jr svc-started "$u"; fi
}
wait_port() {
  local p="$1" i
  for i in $(seq 1 "${WAIT_PORT_SEC:-30}"); do ss -ltn 2>/dev/null | grep -Eq "[:.]$p[[:space:]]" && return 0; sleep 1; done
  return 1
}
bundle_dir() { printf '%s' "$W/bundle/$BV/bareos-bundle"; }
# 지워도 되는 볼륨 디렉터리인가(시스템 경로·얕은 경로·심링크 거부)
safe_voldir() {
  local x="${1#$P}"
  case "$x" in (/|/etc|/etc/*|/usr|/usr/*|/bin|/bin/*|/sbin|/sbin/*|/lib|/lib/*|/lib64|/lib64/*|/boot|/boot/*|/dev|/dev/*|/proc|/proc/*|/sys|/sys/*|/run|/run/*|/root|/home|/var|/var/lib|/opt|/tmp|/srv|/mnt|/media) return 1;; esac
  case "$x" in (/*/*) ;; (*) return 1;; esac
  case "$x" in (*..*) return 1;; esac
  [ -d "$1" ] && [ ! -L "$1" ]
}

# ───────── 0 기존 제거(초기화) — 되돌리지 않는다(지운 것은 복구할 수 없다). 다시 하면 이미 한 것은 건너뛴다.
step0() {
  if systemctl is-active -q bareos-dir 2>/dev/null && command -v bconsole >/dev/null 2>&1; then
    local out; out="$(printf 'llist jobs jobstatus=R\n' | timeout 45 bconsole 2>&1)"
    if printf '%s\n' "$out" | grep -Eq '^[[:space:]]*jobid:[[:space:]]*[0-9]+'; then
      errx "실행 중 작업 확인" "Director 에 실행 중인 작업이 있습니다 — 끝난 뒤 다시 하세요. 아무것도 지우지 않았습니다." 1 running-jobs; return 1
    fi
  fi
  # 볼륨 경로는 설정을 지우기 **전에** 읽는다(포탈이 확인받은 목록과 겹치는 것만 지운다)
  local conf_dirs=""
  if [ -d "$ETC_BAREOS/bareos-sd.d/device" ]; then
    conf_dirs="$(sed -n 's/^[[:space:]]*Archive[[:space:]]*Device[[:space:]]*=[[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}[[:space:]]*$/\1/Ip' "$ETC_BAREOS"/bareos-sd.d/device/*.conf 2>/dev/null | sort -u)"
  fi
  local u
  for u in bareos-dir bareos-sd bareos-fd; do
    if systemctl list-unit-files "$u.service" >/dev/null 2>&1; then systemctl disable --now "$u" >/dev/null 2>&1 || true; fi
  done
  if [ -d "$ETC_BAREOS" ]; then
    mkdir -p "$W/reset"
    local bk; bk="$W/reset/etc-bareos-$(date +%Y%m%d-%H%M%S).tar.gz"
    run "설정 보관(tar /etc/bareos)" tar czf "$bk" -C "$(dirname "$ETC_BAREOS")" bareos || return 1
    log "설정 보관: $bk"
  fi
  local pk; pk="$(rpm -qa --qf '%{NAME}\n' 2>/dev/null | grep -E '^bareos(-|$)' | sort -u | tr '\n' ' ')"
  if [ -n "$pk" ]; then run "dnf remove (Bareos 패키지)" dnf -y --disablerepo='*' remove $pk || return 1; fi
  rm -rf "$ETC_BAREOS"
  if [ "${RESET_DB:-0}" = 1 ]; then
    if [ -f "$PGDATA/PG_VERSION" ]; then
      systemctl start postgresql >/dev/null 2>&1 || true
      local ex; ex="$(su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='bareos'\"" 2>/dev/null | tr -d '[:space:]')"
      if [ "$ex" = 1 ]; then run "카탈로그 DB 삭제(dropdb bareos)" su - postgres -c "dropdb bareos" || return 1; fi
      su - postgres -c "psql -tAc \"DROP ROLE IF EXISTS bareos\"" >/dev/null 2>&1 || true
    fi
  fi
  if [ "${RESET_VOLUMES:-0}" = 1 ]; then
    local d
    for d in $RESET_VOLUME_DIRS; do
      d="$P$d"
      if ! printf '%s\n' "$conf_dirs" | grep -Fxq "${d#$P}"; then
        # 설정이 이미 지워진 재시도 — 확인받은 목록만으로 진행하되 안전 판정은 그대로
        [ -n "$conf_dirs" ] && { log "볼륨 경로 $d 는 지금 설정에 없어 건너뜀"; continue; }
      fi
      if safe_voldir "$d"; then run "볼륨 삭제($d 안의 파일)" find "$d" -mindepth 1 -maxdepth 1 -exec rm -rf {} + || return 1
      else log "볼륨 경로 $d 는 지우지 않음(시스템 경로·심링크·없음)"; fi
    done
  fi
  return 0
}

# ───────── 1 번들 확인·풀기·로컬 저장소
step1() {
  local tar="$W/bundles/bareos-bundle-$BV.tar.gz"
  [ -f "$tar" ] || { errx "번들 확인" "번들 파일이 없습니다: $tar" 1 bundle-missing; return 1; }
  local sum; sum="$(sha256sum "$tar" | cut -d' ' -f1)"
  [ "$sum" = "$TAR_SHA256" ] || { errx "번들 확인(sha256)" "sha256 이 포탈 값과 다릅니다: $sum" 1 bundle-hash; return 1; }
  local dst="$W/bundle/$BV"
  if [ ! -f "$dst/.ok" ]; then
    rm -rf "$dst"; mkdir -p "$dst"; jr dir "$dst"
    run "번들 풀기(tar xzf)" tar xzf "$tar" -C "$dst" --no-same-owner || return 1
    touch "$dst/.ok"
  fi
  local B; B="$(bundle_dir)"
  [ -d "$B/rpms/repodata" ] || { errx "번들 확인" "번들에 저장소 목록(repodata)이 없습니다." 1 bundle-broken; return 1; }
  local keys="" k
  for k in "$B"/keys/*; do [ -f "$k" ] && keys="$keys file://$k"; done
  [ -n "$keys" ] || { errx "번들 확인" "번들에 패키지 서명 키가 없습니다." 1 bundle-broken; return 1; }
  if [ -e "$REPO_FILE" ] && ! is_marker_file "$REPO_FILE"; then errx "로컬 저장소 파일" "$REPO_FILE 가 이미 있고 포탈이 만든 파일이 아닙니다." 1 conflict; return 1; fi
  [ -e "$REPO_FILE" ] || jr file "$REPO_FILE"
  mkdir -p "$(dirname "$REPO_FILE")"
  printf '%s\n[portal-bareos-local]\nname=vmware-portal Bareos offline bundle %s\nbaseurl=file://%s/rpms\nenabled=0\ngpgcheck=1\ngpgkey=%s\n' \
    "$MARKER" "$BV" "$B" "${keys# }" > "$REPO_FILE"
  chmod 0644 "$REPO_FILE"
}

# ───────── 2 패키지 · pyVmomi · 카탈로그 DB
step2() {
  local B; B="$(bundle_dir)"
  [ -d "$ETC_BAREOS" ] || jr etcnew
  rpm -qa --qf '%{NAME}\n' | sort -u > "$R/rpm.before"
  run "dnf install(번들 저장소만 · $INSTALL_PKGS)" dnf -y --disablerepo='*' --enablerepo=portal-bareos-local install $INSTALL_PKGS
  local rc=$?
  rpm -qa --qf '%{NAME}\n' | sort -u > "$R/rpm.after"
  local new; new="$(comm -13 "$R/rpm.before" "$R/rpm.after" | tr '\n' ' ')"
  [ -n "${new// /}" ] && jr pkgs $new
  [ $rc -eq 0 ] || return 1

  # pyVmomi — 시스템 site-packages 에 고른 8.x 하나만(문서 7.2·7.4)
  local cur; cur="$(python3 -c 'import importlib.metadata as m; print(m.version("pyvmomi"))' 2>/dev/null || true)"
  local BPP; BPP="$P$(python3 -c 'import sys; print(f"/usr/{sys.platlibdir}/bareos/plugins")' 2>/dev/null || echo /usr/lib64/bareos/plugins)"
  log "pyVmomi 지금: ${cur:-없음} → 고른 판 $PYVMOMI"
  if [ "${PYVMOMI_FIX:-0}" = 1 ]; then
    # 포탈에서 고치기: 플러그인 경로에 따로 깔린 pyVmomi 를 옆으로 옮긴다(지우지 않는다 — 되돌릴 수 있게)
    local mv_dst="$W/moved/$(date +%Y%m%d-%H%M%S)" x
    for x in "$BPP"/pyVmomi "$BPP"/pyVim "$BPP"/pyvmomi-*.dist-info "$BPP"/pyvmomi-*.egg-info; do
      [ -e "$x" ] || continue
      mkdir -p "$mv_dst"; mv "$x" "$mv_dst/" && jr moved "$x" "$mv_dst/$(basename "$x")" && log "옮김: $x → $mv_dst"
    done
  fi
  if [ "$cur" != "$PYVMOMI" ]; then
    run "pip install pyvmomi==$PYVMOMI(번들 휠)" python3 -m pip install --no-index --find-links "$B/wheels" "pyvmomi==$PYVMOMI" || return 1
    if [ -z "$cur" ]; then jr pip-new; else jr pip-prev "$cur"; fi
  fi
  local eff; eff="$(PYTHONPATH="$BPP" python3 -c 'import pyVmomi, importlib.metadata as m; print(m.version("pyvmomi"))' 2>&1 | tail -n 1)"
  if [ "$eff" != "$PYVMOMI" ]; then
    errx "pyVmomi 확인" "플러그인이 실제로 불러오는 판이 $eff 입니다(고른 판 $PYVMOMI). 플러그인 경로($BPP)에 다른 판이 따로 있으면 그것이 먼저 불립니다." 1 pyvmomi-shadow; return 1
  fi

  # 카탈로그(PostgreSQL)
  if [ ! -f "$PGDATA/PG_VERSION" ]; then run "postgresql-setup --initdb" postgresql-setup --initdb || return 1; jr pginit; fi
  enable_start postgresql || return 1
  local i; for i in $(seq 1 30); do su - postgres -c 'pg_isready -q' >/dev/null 2>&1 && break; sleep 1; done
  local ex; ex="$(su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='bareos'\"" 2>/dev/null | tr -d '[:space:]')"
  if [ "$ex" != 1 ]; then
    run "create_bareos_database" su - postgres -c /usr/lib/bareos/scripts/create_bareos_database || return 1
    jr db
    run "make_bareos_tables" su - postgres -c /usr/lib/bareos/scripts/make_bareos_tables || return 1
  else
    log "카탈로그 DB 'bareos' 가 이미 있음(초기화에서 남김) — 판 맞춤만"
    run "update_bareos_tables" su - postgres -c /usr/lib/bareos/scripts/update_bareos_tables || return 1
  fi
  run "grant_bareos_privileges" su - postgres -c /usr/lib/bareos/scripts/grant_bareos_privileges || return 1
}

# ───────── 3 볼륨 디렉터리 · SD 장치 · Director 스토리지 · 서비스
step3() {
  id -u bareos >/dev/null 2>&1 || { errx "bareos 계정" "bareos 계정이 없습니다 — 패키지 설치가 끝나지 않았습니다." 1 pkg-incomplete; return 1; }
  local V="$P$VOLUME_DIR"
  if [ ! -d "$V" ]; then run "볼륨 디렉터리 만들기" install -d -o bareos -g bareos -m 0750 "$V" || return 1; jr voldir "$V"; fi
  if [ "$V" != "$DEFAULT_STORE" ] && command -v getenforce >/dev/null 2>&1 && [ "$(getenforce 2>/dev/null)" != Disabled ]; then
    if ! semanage fcontext -l -C 2>/dev/null | grep -Fq "$VOLUME_DIR"; then
      run "SELinux 문맥(semanage fcontext -e)" semanage fcontext -a -e /var/lib/bareos/storage "$VOLUME_DIR" || return 1
      jr fcontext "$VOLUME_DIR"
    fi
    run "restorecon" restorecon -R "$V" || return 1
  fi
  run "볼륨 쓰기 시험(bareos 계정)" runuser -u bareos -- sh -c "touch '$V/.portal-write-test' && rm -f '$V/.portal-write-test'" || return 1

  local SDDIR="$ETC_BAREOS/bareos-sd.d/director/bareos-dir.conf"
  local SDPW; SDPW="$(sed -n 's/^[[:space:]]*Password[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$SDDIR" 2>/dev/null | head -n 1)"
  [ -n "$SDPW" ] || { errx "SD 비밀번호 읽기" "$SDDIR 에서 Director 비밀번호를 읽지 못했습니다(패키지 기본 구성이 아닙니다)." 1 sd-conf; return 1; }
  place "$ETC_BAREOS/bareos-sd.d/device/$SD_DEVICE.conf" bareos bareos 0640 <<EOF || return 1
$MARKER
Device {
  Name = $SD_DEVICE
  Media Type = $SD_MEDIA
  Archive Device = $VOLUME_DIR
  LabelMedia = yes
  Random Access = yes
  AutomaticMount = yes
  RemovableMedia = no
  AlwaysOpen = no
  Description = "vmware-portal full install volume directory"
}
EOF
  place "$ETC_BAREOS/bareos-dir.d/storage/$DIR_STORAGE.conf" bareos bareos 0640 <<EOF || return 1
$MARKER
Storage {
  Name = $DIR_STORAGE
  Address = $HOST_ADDR
  Password = "$SDPW"
  Device = $SD_DEVICE
  Media Type = $SD_MEDIA
}
EOF
  run "bareos-sd -t" runuser -u bareos -- bareos-sd -t || return 1
  run "bareos-dir -t" runuser -u bareos -- bareos-dir -t || return 1
  run "bareos-fd -t" bareos-fd -t || return 1
  local u
  for u in bareos-dir bareos-sd bareos-fd; do
    if systemctl is-active -q "$u" 2>/dev/null; then run "systemctl restart $u" systemctl restart "$u" || return 1
    else enable_start "$u" || return 1; fi
  done
  local p; for p in 9101 9103 9102; do wait_port "$p" || { errx "포트 확인" "$p 포트가 30초 안에 열리지 않았습니다(서비스가 바로 끝났을 수 있습니다 — journalctl 확인)." 1 port; return 1; }; done
  local v; v="$(printf 'version\n' | timeout 30 bconsole 2>&1)"
  printf '%s\n' "$v" | grep -q 'Version' || { errx "bconsole 접속" "$(printf '%s\n' "$v" | tail -n 20)" 1 bconsole; return 1; }
  log "Director 응답: $(printf '%s\n' "$v" | grep -m1 'Version')"
}

# ───────── 되돌리기(그 단계의 journal 을 역순으로)
undo_line() {
  local kind="$1"; shift
  case "$kind" in
    file) [ -e "$1" ] && is_marker_file "$1" && rm -f "$1" ;;
    file-old) [ -f "$2" ] && cp -p "$2" "$1" ;;
    dir) case "$1" in ("$W"/*) rm -rf "$1" ;; esac ;;
    voldir) rmdir "$1" 2>/dev/null || log "볼륨 디렉터리 $1 가 비어 있지 않아 남김" ;;
    fcontext) semanage fcontext -d "$1" >/dev/null 2>&1 || true ;;
    pkgs) run "dnf remove(이 단계가 설치한 패키지)" dnf -y --disablerepo='*' remove "$@" || return 1 ;;
    pip-new) python3 -m pip uninstall -y pyvmomi >/dev/null 2>&1 || true ;;
    pip-prev) if ls "$(bundle_dir)"/wheels/pyvmomi-"$1"-*.whl >/dev/null 2>&1; then python3 -m pip install --no-index --find-links "$(bundle_dir)/wheels" "pyvmomi==$1" >/dev/null 2>&1 || true
              else log "이전 pyVmomi $1 은 번들에 없어 되돌리지 못함(지금 판 유지)"; fi ;;
    moved) [ -e "$2" ] && [ ! -e "$1" ] && mv "$2" "$1" ;;
    db) su - postgres -c "dropdb --if-exists bareos" >/dev/null 2>&1; su - postgres -c "psql -tAc \"DROP ROLE IF EXISTS bareos\"" >/dev/null 2>&1 || true ;;
    pginit) systemctl stop postgresql >/dev/null 2>&1 || true; case "$PGDATA" in (*/var/lib/pgsql/data) rm -rf "$PGDATA" ;; esac ;;
    svc-enabled) systemctl disable "$1" >/dev/null 2>&1 || true ;;
    svc-started) systemctl stop "$1" >/dev/null 2>&1 || true ;;
    etcnew) rm -rf "$ETC_BAREOS" ;;
    *) log "모르는 되돌리기 항목: $kind" ;;
  esac
}
rollback_step() {
  local s="$1" ok=0 line
  local j="$R/journal.$s"
  [ -f "$j" ] || return 0
  CUR="$s"
  log "되돌리기 시작(${s}단계)"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    # shellcheck disable=SC2086
    undo_line $line || ok=1
  done < <(tac "$j")
  if [ $ok -eq 0 ]; then mv "$j" "$j.undone.$(date +%s)"; log "되돌리기 끝(${s}단계)"; else log "되돌리기 일부 실패(${s}단계) — 남은 것은 로그 참고"; fi
  return $ok
}

main() {
  case "${RUN_MODE:-install}" in
    rollback-all)
      local s rc=0
      for s in 3 2 1; do rollback_step "$s" || rc=1; done
      CUR=-
      if [ $rc -eq 0 ]; then
        # 설치 전 없던 것만: 로컬 저장소 파일 · 풀어 둔 번들 · 올린 번들(초기화 보관본 reset/ 은 남긴다)
        is_marker_file "$REPO_FILE" && rm -f "$REPO_FILE"
        rm -rf "$W/bundle" "$W/bundles"
        st all rolledback
      else st all rollback-fail; fi
      return $rc ;;
  esac
  local s
  for s in 0 1 2 3; do
    [ "$s" -lt "$START_STEP" ] && continue
    if [ "$s" = 0 ] && [ "${RESET:-0}" != 1 ]; then continue; fi
    CUR="$s"
    if [ -e "$R/stop" ]; then st "$s" stopped; log "중단 요청 — ${s}단계 앞에서 멈춤"; return 0; fi
    rm -f "$R/err.$s"
    st "$s" start
    if "step$s"; then st "$s" ok; continue; fi
    if [ "$s" = 0 ]; then st 0 fail; return 1; fi
    st "$s" fail
    if rollback_step "$s"; then st "$s" rolledback; else st "$s" rollback-fail; fi
    return 1
  done
  CUR=-
  st all done
}
main
