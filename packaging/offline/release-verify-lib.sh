# shellcheck shell=bash
#
# 오프라인 설치 패키지 서명 확인(검토 S-10, v2.730) — install.sh 가 source 한다.
#
# 기존 설치본(신뢰하는 코드)이 있으면 **그 설치본의** Node 런타임·확인 도구(server/src/upgrade/verifyCli.js)·신뢰 공개키
# (+ CONFIG_DIR/release-signing-keys.conf)로 새 패키지 파일과 서명 manifest 를 확인한다 — 포탈 안의 자동 업그레이드와
# **같은 판정 함수**다. 통과하지 못하면 아무것도 바꾸기 전에 멈춘다.
#
# ⚠ 정직한 한계: 이 함수는 새 패키지 안의 install.sh 가 부른다. 패키지 자체를 바꾼 공격자는 install.sh 도 바꿀 수 있으므로,
#   진짜 확인은 **풀기 전에** 기존 설치본의 도구로 하는 것이다:
#     sudo vmware-portal-verify --file <패키지.tar.gz> --manifest vmware-portal-<버전>.manifest.json   (root 소유 사본 — v2.741)
#   이 자동 확인은 '잘못 받은 패키지'·'보관 중 손상·변조' 를 잡는 두 번째 그물이다(docs/RELEASE-SIGNING.md).
#
# ── root 소유 도구(v2.741 감사 INJPKG-01) ─────────────────────────────────────────────────────────────────────
# 서비스 계정(vmportal)은 $PREFIX·$CONFIG_DIR 를 쓸 수 있다(install.sh 의 chown -R · 유닛 ReadWritePaths). 그래서 root 가 그 트리의
#   스크립트·node 를 실행하거나 그 트리의 파일을 신뢰 기준으로 읽으면, 서비스 계정 권한을 얻은 공격자가 root 로 올라가거나
#   서명 확인을 무력화할 수 있다(예전 /usr/local/bin/vmware-portal-* 는 앱 트리의 .sh 를 가리키는 링크였다). 규칙:
#   ① root 로 부르는 래퍼(vmware-portal-otp·-users·-verify)는 앱 트리 밖 root 소유 사본(vp_root_tools_dir)이다.
#      otp·users 래퍼는 앱 트리를 읽기 전에 서비스 계정으로 권한을 내린다(재시작만 root 사본이 한다).
#   ② 서명 확인 도구(node·server/src·공개키 목록)는 root 소유 사본(<도구 폴더>/verify)만 신뢰 기준으로 쓴다 — 그 사본은
#      install.sh 가 **방금 확인한 패키지**에서 만든다(서비스 계정이 쓸 수 있는 앱 트리에서 복사하지 않는다).
#   ③ root 로 읽는 portal.env 정책·호스트 키 파일은 uid 0 소유일 때만 받는다(호스트 키 파일은 signature.js 가 판정).
#   ⚠ 정직한 한계: 사본은 install.sh 를 실행할 때만 바뀐다 — 앱 안 업그레이드(서비스 계정)로 들어온 새 공개키 목록은
#     다음 install.sh 실행 전까지 root 확인에 반영되지 않는다(서비스 계정이 root 신뢰 기준을 바꿀 수 없게 한 대가).
VP_ROOT_TOOLS_BASE_DEFAULT=/usr/local/libexec/vmware-portal
# vp_root_tools_dir <prefix> — 그 설치본의 root 소유 도구 폴더(설치본마다 따로 — prefix 를 그대로 잇는다).
vp_root_tools_dir() { printf '%s%s\n' "${VP_ROOT_TOOLS_BASE:-$VP_ROOT_TOOLS_BASE_DEFAULT}" "$1"; }

# vp_path_root_only <경로> — 경로와 그 위 모든 폴더가 root 소유이고 그룹·기타가 쓸 수 없는가(sticky 폴더 /tmp 는 허용 —
#   남이 root 항목을 바꾸거나 지울 수 없다). 하나라도 아니면 그 경로는 서비스 계정이 갈아끼울 수 있다.
vp_path_root_only() {
  local p st uid mode
  p="$(readlink -f -- "$1" 2>/dev/null)" || return 1
  [[ "$p" == /* ]] || return 1
  while :; do
    st="$(stat -c '%u %a' -- "$p" 2>/dev/null)" || return 1
    uid="${st%% *}"; mode="${st##* }"
    [[ "$uid" == 0 ]] || return 1
    if (( 8#$mode & 8#022 )) && ! (( 8#$mode & 8#1000 )); then return 1; fi
    [[ "$p" == / ]] && return 0
    p="$(dirname -- "$p")"
  done
}

# vp_tree_root_only <폴더> — 그 아래 전부가 root 소유 · 그룹/기타 쓰기 없음 · 심볼릭 링크 없음.
vp_tree_root_only() {
  local bad
  [[ -d "$1" ]] || return 1
  bad="$(find "$1" \( -type l -o ! -uid 0 -o -perm /022 \) -print -quit 2>/dev/null)" || return 1
  [[ -z "$bad" ]]
}

# vp_anchor_ok <도구 폴더> — root 소유 서명 확인 사본을 신뢰 기준으로 쓸 수 있는가.
vp_anchor_ok() {
  local v="$1/verify"
  [[ -x "$v/node" && -f "$v/server/src/upgrade/verifyCli.js" ]] || return 1
  vp_path_root_only "$v" && vp_tree_root_only "$v"
}

# vp_root_env_policy <config_dir> — portal.env 의 UPGRADE_SIGNATURE_POLICY 를 **root 소유 파일일 때만** 돌려준다.
#   연 파일(fd)의 소유자를 보므로 확인 뒤 바꿔치기가 끼어들지 않는다. 서비스 계정 소유면 값을 쓰지 않고 한 줄 알린다(stderr).
vp_root_env_policy() {
  local f="$1/portal.env" fd uid v=""
  [[ -f "$f" && ! -L "$f" ]] || return 0
  exec {fd}<"$f" || return 0
  uid="$(stat -L -c %u "/dev/fd/$fd" 2>/dev/null || echo x)"
  if [[ "$uid" == 0 ]]; then
    v="$(grep -E '^UPGRADE_SIGNATURE_POLICY=' <&"$fd" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  elif grep -qE '^UPGRADE_SIGNATURE_POLICY=' <&"$fd" 2>/dev/null; then
    echo "ⓘ $f 는 root 소유가 아니라(서비스 계정이 쓸 수 있다) 그 안의 UPGRADE_SIGNATURE_POLICY 를 root 확인에 쓰지 않습니다." >&2
  fi
  exec {fd}<&-
  printf '%s' "$v"
}

# vp_as_user <계정> 명령… — 권한을 그 계정으로 내린 뒤 실행한다(runuser → setpriv). 터미널이면 새 pty 를 만든다
#   (낮은 권한 프로세스가 root 의 터미널에 입력을 밀어 넣지 못하게 — runuser --pty). 내릴 수 없으면 실행하지 않는다.
vp_as_user() {
  local u="$1"; shift
  if command -v runuser >/dev/null 2>&1; then
    local pty=()
    if [[ -t 0 && -t 1 ]] && runuser --help 2>&1 | grep -q -- '--pty'; then pty=(--pty); fi
    runuser -u "$u" "${pty[@]}" -- "$@"
  elif command -v setpriv >/dev/null 2>&1; then
    setpriv --reuid="$(id -u "$u")" --regid="$(id -g "$u")" --init-groups -- "$@"
  else
    echo "✖ runuser·setpriv 가 없어 '$u' 계정으로 권한을 내릴 수 없습니다 — root 로 앱 트리를 실행하지 않습니다." >&2
    return 126
  fi
}

# vp_write_launcher <파일> <종류 otp|users|verify> <prefix> <서비스 계정> <서비스 이름> <config_dir> <도구 폴더>
#   root 소유 래퍼를 만든다. 값은 printf %q 로 넣고, 판정 함수는 이 파일의 정의를 그대로 싣는다(declare -f — 사본을 두 벌 두지 않는다).
vp_write_launcher() {
  local out="$1" kind="$2" prefix="$3" user="$4" svc="$5" cdir="$6" tools="$7" tool=""
  case "$kind" in otp) tool=otp-enroll.sh ;; users) tool=user-admin.sh ;; verify) tool="" ;; *) return 1 ;; esac
  {
    echo '#!/bin/bash'
    echo "# vmware-portal root 래퍼($kind) — install.sh 가 만든 root 소유 사본(v2.741 감사 INJPKG-01). 손으로 고치지 마세요."
    echo "# VP_LAUNCHER_PREFIX=$prefix"
    echo '# 앱 트리(<prefix>/app)·런타임은 서비스 계정이 쓸 수 있다 — root 로 그 파일을 읽거나 실행하지 않는다.'
    echo 'set -uo pipefail'
    printf 'PREFIX=%q\nSERVICE_USER=%q\nSERVICE_NAME=%q\nCONFIG_DIR=%q\nTOOLS=%q\nTOOL=%q\nKIND=%q\n' "$prefix" "$user" "$svc" "$cdir" "$tools" "$tool" "$kind"
    declare -f vp_as_user vp_root_env_policy vp_path_root_only vp_tree_root_only vp_anchor_ok
    cat <<'BODY'
if [[ "$KIND" == verify ]]; then
  # 서명 확인 — root 소유 사본(node·server/src·공개키 목록)만 신뢰 기준으로 쓴다.
  if ! vp_anchor_ok "$TOOLS"; then
    echo "✖ root 소유 서명 확인 도구가 없거나 안전하지 않습니다($TOOLS/verify) — install.sh 로 다시 설치하세요." >&2
    exit 2
  fi
  POLICY="${UPGRADE_SIGNATURE_POLICY:-}"
  [[ -n "$POLICY" ]] || POLICY="$(vp_root_env_policy "$CONFIG_DIR")"
  exec env CONFIG_DIR="$CONFIG_DIR" UPGRADE_SIGNATURE_POLICY="$POLICY" "$TOOLS/verify/node" "$TOOLS/verify/server/src/upgrade/verifyCli.js" "$@"
fi
APP_TOOL="$PREFIX/app/$TOOL"
if [[ "$(id -u)" -ne 0 ]]; then exec /bin/bash "$APP_TOOL" "$@"; fi   # root 가 아니면 권한 경계가 없다 — 앱 트리 래퍼 그대로
id "$SERVICE_USER" >/dev/null 2>&1 || { echo "✖ 서비스 계정 '$SERVICE_USER' 이 없습니다 — root 로 앱 트리를 실행하지 않습니다." >&2; exit 1; }
if [[ "$(id -u "$SERVICE_USER")" -eq 0 ]]; then   # 서비스가 root 로 도는 설치(--user root) — 앱 트리도 root 소유다
  exec env CONFIG_DIR="$CONFIG_DIR" SERVICE_NAME="$SERVICE_NAME" VP_LAUNCHER=1 VP_LAUNCHER_CMD="sudo $0" /bin/bash "$APP_TOOL" "$@"
fi
[[ -f "$APP_TOOL" ]] || { echo "✖ 도구를 찾을 수 없습니다: $APP_TOOL" >&2; exit 1; }
cd / 2>/dev/null || true   # root 의 작업 폴더(/root 등)는 서비스 계정이 들어갈 수 없다
vp_as_user "$SERVICE_USER" env CONFIG_DIR="$CONFIG_DIR" SERVICE_NAME="$SERVICE_NAME" VP_LAUNCHER=1 VP_LAUNCHER_CMD="sudo $0" /bin/bash "$APP_TOOL" "$@"
rc=$?
if [[ "$KIND" == users && $rc -eq 10 ]]; then
  # 도구가 '지금 재시작' 을 골랐다(종료코드 10) — 재시작만 root 사본이 한다(앱 트리 코드는 root 로 돌지 않는다).
  echo "==> ${SERVICE_NAME} 재시작 중…"
  if systemctl restart "$SERVICE_NAME"; then echo "==> 재시작했습니다."; exit 0; fi
  echo "✖ 재시작에 실패했습니다 — sudo systemctl status ${SERVICE_NAME} 로 확인하세요." >&2; exit 1
fi
exit $rc
BODY
  } > "$out"
  chmod 0755 "$out"
}

# vp_install_root_tools <prefix> <script_dir> <서비스 계정> <서비스 이름> <config_dir>
#   방금 확인한 패키지(script_dir — root 가 푼 폴더)에서 root 소유 도구 폴더를 새로 만든다(만든 뒤 한 번에 바꾼다).
#   반환 0 = 서명 확인 사본까지 준비됨 · 1 = 래퍼만(사본 실패 — vmware-portal-verify 는 걸지 않는다) · 2 = 실패
vp_install_root_tools() {
  local prefix="$1" sdir="$2" user="$3" svc="$4" cdir="$5" tools tmp anchor_rc=0
  tools="$(vp_root_tools_dir "$prefix")"
  ( umask 022; mkdir -p -- "$(dirname -- "$tools")" ) || return 2
  tmp="$tools.new.$$"
  rm -rf -- "$tmp"
  ( umask 022; mkdir -p -- "$tmp/verify/server" ) || return 2
  if [[ -x "$sdir/runtime/node/bin/node" && -f "$sdir/app/server/src/upgrade/verifyCli.js" && -f "$sdir/app/server/package.json" ]]; then
    # -a 를 쓰지 않는다 — tar 가 보존한 빌드 머신 소유자(uid)를 옮겨 오지 않게(아래에서 root 로 다시 맞춘다).
    cp -- "$sdir/runtime/node/bin/node" "$tmp/verify/node" \
      && cp -R -- "$sdir/app/server/src" "$tmp/verify/server/src" \
      && cp -- "$sdir/app/server/package.json" "$tmp/verify/server/package.json" \
      && { [[ ! -f "$sdir/app/package.json" ]] || cp -- "$sdir/app/package.json" "$tmp/verify/package.json"; } \
      || anchor_rc=1
  else
    anchor_rc=1
  fi
  [[ $anchor_rc -eq 0 ]] || rm -rf -- "$tmp/verify"
  vp_write_launcher "$tmp/vmware-portal-otp" otp "$prefix" "$user" "$svc" "$cdir" "$tools" || return 2
  vp_write_launcher "$tmp/vmware-portal-users" users "$prefix" "$user" "$svc" "$cdir" "$tools" || return 2
  if [[ $anchor_rc -eq 0 ]]; then
    vp_write_launcher "$tmp/vmware-portal-verify" verify "$prefix" "$user" "$svc" "$cdir" "$tools" || return 2
  fi
  chown -R 0:0 -- "$tmp" && chmod -R u+rwX,go+rX,go-w -- "$tmp" || { rm -rf -- "$tmp"; return 2; }
  [[ $anchor_rc -ne 0 ]] || chmod 0755 -- "$tmp/verify/node"
  rm -rf -- "$tools.old.$$"
  if [[ -e "$tools" ]]; then mv -- "$tools" "$tools.old.$$" || { rm -rf -- "$tmp"; return 2; }; fi
  mv -- "$tmp" "$tools" || return 2
  rm -rf -- "$tools.old.$$"
  return $anchor_rc
}

# verify_release_package <prefix> <script_dir> <config_dir> <version> <package_file|""> <manifest_file|""> <skip 0|1>
#   반환 0 = 설치 계속 · 1 = 멈춤
verify_release_package() {
  local prefix="$1" sdir="$2" cdir="$3" ver="$4" pkg="$5" man="$6" skip="$7"
  local base; base="$(basename "$sdir")"
  if [[ -z "$pkg" && -f "$sdir/../$base.tar.gz" ]]; then pkg="$sdir/../$base.tar.gz"; fi
  if [[ -z "$man" && -f "$sdir/../vmware-portal-$ver.manifest.json" ]]; then man="$sdir/../vmware-portal-$ver.manifest.json"; fi

  local node js trust runas_uid="" runas_gid="" tools
  local old_node="$prefix/runtime/node/bin/node" old_js="$prefix/app/server/src/upgrade/verifyCli.js"
  tools="$(vp_root_tools_dir "$prefix")"
  if vp_anchor_ok "$tools"; then
    # v2.741(INJPKG-01): 지난 install.sh 가 만든 root 소유 사본 — 서비스 계정이 바꿀 수 없는 신뢰 기준이다.
    node="$tools/verify/node"; js="$tools/verify/server/src/upgrade/verifyCli.js"; trust="existing"
  elif [[ -d "$prefix/app" && -x "$old_node" && -f "$old_js" ]]; then
    node="$old_node"; js="$old_js"; trust="existing"
    # root 소유 사본이 아직 없는 설치본(v2.741 이전) — 앱 트리의 도구는 서비스 계정이 쓸 수 있으므로 root 로 실행하지 않고
    #   그 파일의 소유자 권한으로 실행한다(서비스 계정이 변조했다면 이 확인을 믿을 수 없다 — 그 사실을 말한다).
    #   ⚠ 권한을 내리는 것은 **root 로 실행할 때만**이다 — root 가 아니면 넘을 권한 경계가 없고(지금 계정이 이미 그 권한이다)
    #     setpriv·runuser 는 다른 계정으로 바꿀 수 없어 확인이 통째로 실패한다(v2.741 CI — uid 1001 에서 setgroups 거부).
    local ou; ou="$(stat -c %u -- "$old_js" 2>/dev/null || echo 0)"
    if [[ "$(id -u)" == 0 && "$ou" != 0 ]]; then
      runas_uid="$ou"; runas_gid="$(stat -c %g -- "$old_js" 2>/dev/null || echo "$ou")"
      echo "⚠ 기존 설치본에 root 소유 서명 확인 도구가 없습니다(v2.741 이전) — 이번 확인은 기존 설치본의 도구를 그 소유 계정(uid $ou) 권한으로 실행합니다."
      echo "  그 계정이 변조됐다면 이 확인을 믿을 수 없습니다. 이번 설치가 root 소유 확인 도구($tools)를 만듭니다."
    fi
  else
    node="$sdir/runtime/node/bin/node"; js="$sdir/app/server/src/upgrade/verifyCli.js"; trust="package"
    if [[ -d "$prefix/app" ]]; then
      echo "⚠ 기존 설치본에 서명 확인 도구가 없습니다(v2.730 이전). 이번 설치는 호스트에 신뢰 기준이 없어 새 패키지 안의 도구로 확인합니다 —"
      echo "  이 확인은 무결성(손상·잘못 받은 파일)만 봅니다. 배포자 확인은 신뢰하는 다른 서버의 release-verify.sh 로 하세요."
    fi
  fi

  local pol="${UPGRADE_SIGNATURE_POLICY:-}"
  if [[ -z "$pol" ]]; then
    if [[ -n "$runas_uid" || "$(id -u)" != 0 ]]; then
      # 소유 계정 권한으로 도는 옛 도구는 예전처럼 portal.env 정책을 따른다(그 도구 자체가 그 계정의 신뢰 수준이다).
      #   root 가 아닌 실행도 같다 — 넘는 권한 경계가 없으므로 root 소유 파일만 받는 규칙이 지킬 것이 없다.
      pol="$(grep -E '^UPGRADE_SIGNATURE_POLICY=' "$cdir/portal.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
    else
      pol="$(vp_root_env_policy "$cdir")"   # root 로 도는 확인 — root 소유 portal.env 의 정책만 받는다
    fi
  fi

  # _vp_verify_run 인자… — 고른 도구를 실행한다. 소유 계정 권한으로 낮출 때는 패키지·manifest 를 그 계정이 읽을 수 있는
  #   root 소유 임시 폴더에 복사해 넘긴다(이름은 그대로 — manifest 의 파일 이름과 대조한다).
  _vp_verify_run() {
    if [[ -z "$runas_uid" ]]; then
      CONFIG_DIR="$cdir" UPGRADE_SIGNATURE_POLICY="$pol" "$node" "$js" "$@"
      return
    fi
    local drop=()
    if command -v setpriv >/dev/null 2>&1; then drop=(setpriv --reuid="$runas_uid" --regid="$runas_gid" --clear-groups --)
    elif command -v runuser >/dev/null 2>&1 && getent passwd "$runas_uid" >/dev/null 2>&1; then drop=(runuser -u "$(getent passwd "$runas_uid" | cut -d: -f1)" --)
    else echo "✖ setpriv·runuser 가 없어 권한을 내릴 수 없습니다 — 기존 설치본의 도구를 root 로 실행하지 않습니다." >&2; return 3
    fi
    ( cd / && "${drop[@]}" env CONFIG_DIR="$cdir" UPGRADE_SIGNATURE_POLICY="$pol" "$node" "$js" "$@" )
  }

  if [[ -z "$pkg" || -z "$man" || ! -f "$pkg" || ! -f "$man" ]]; then
    # v2.735.1: 기존 설치본에 서명 공개키가 아직 하나도 설정되지 않았으면(키 등록 전 릴리스) 그 설치본의 정책이 warn 이다 —
    #   그 도구에 직접 묻는다(--policy). 이 인자를 모르는 옛 도구는 3 을 돌려주고, 그때는 예전처럼 '필수' 로 본다.
    if [[ "$trust" == "existing" && "$skip" != "1" ]]; then
      local polout=""
      polout="$(_vp_verify_run --policy 2>/dev/null || true)"
      if [[ "$polout" == "policy=warn source=unconfigured"* ]]; then
        echo "⚠ 서명 manifest 를 찾지 못했지만 기존 설치본에 서명 공개키가 아직 설정되지 않아(키 등록 전 릴리스) 경고 후 설치를 계속합니다."
        echo "  배포자 확인이 빠진 설치입니다 — 서명 키가 등록된 릴리스부터 확인이 다시 필수가 됩니다(docs/RELEASE-SIGNING.md)."
        return 0
      fi
    fi
    if [[ "$trust" == "existing" && "$skip" != "1" ]]; then
      echo "✗ 업그레이드 설치는 서명 확인이 필요합니다 — 패키지 파일과 서명 manifest 를 찾지 못했습니다." >&2
      echo "  패키지 파일 : ${pkg:-(없음)}  (기본: 압축을 푼 폴더 옆의 $base.tar.gz)" >&2
      echo "  manifest    : ${man:-(없음)}  (기본: 같은 위치의 vmware-portal-$ver.manifest.json — 릴리스 자산에서 함께 받으세요)" >&2
      echo "  다른 위치면 --package <파일> --manifest <파일> 로 지정하세요. 확인 없이 진행하려면 --skip-signature-check(권장하지 않음)." >&2
      return 1
    fi
    if [[ "$skip" == "1" && "$trust" == "existing" ]]; then
      echo "⚠ --skip-signature-check: 패키지 서명을 확인하지 않고 설치합니다(패키지·manifest 없음)."
    else
      echo "ⓘ 서명 manifest 를 찾지 못해 확인을 건너뜁니다(신규 설치). 배포자 확인은 docs/RELEASE-SIGNING.md 의 '오프라인 패키지' 절을 보세요."
    fi
    return 0
  fi

  local rc=0 how vtmp="" vpkg="$pkg" vman="$man"
  if [[ "$trust" == "package" ]]; then how='패키지 안의 도구 — 무결성만'
  elif [[ -n "$runas_uid" ]]; then how="기존 설치본의 도구·신뢰 키 — 소유 계정(uid $runas_uid) 권한"
  elif [[ "$node" == "$tools/verify/node" ]]; then how='root 소유 확인 도구·신뢰 키'
  else how='기존 설치본의 도구·신뢰 키'
  fi
  echo "==> 패키지 서명 확인(${how})"
  if [[ -n "$runas_uid" ]]; then
    vtmp="$(mktemp -d "${TMPDIR:-/var/tmp}/vmware-portal-verify.XXXXXX")" \
      && chgrp "$runas_gid" "$vtmp" && chmod 0750 "$vtmp" \
      && vpkg="$vtmp/$(basename -- "$pkg")" && vman="$vtmp/$(basename -- "$man")" \
      && cp -- "$pkg" "$vpkg" && cp -- "$man" "$vman" \
      && chgrp "$runas_gid" "$vpkg" "$vman" && chmod 0640 "$vpkg" "$vman" \
      || { echo "✖ 확인용 임시 사본을 만들지 못했습니다(${vtmp:-mktemp 실패})." >&2; [[ -z "$vtmp" ]] || rm -rf -- "$vtmp"; vtmp=""; rc=3; }
  fi
  if [[ $rc -eq 0 ]]; then _vp_verify_run --file "$vpkg" --manifest "$vman" --version "$ver" || rc=$?; fi
  [[ -z "$vtmp" ]] || rm -rf -- "$vtmp"
  if [[ $rc -eq 0 ]]; then return 0; fi
  if [[ "$skip" == "1" ]]; then
    echo "⚠ --skip-signature-check: 서명 확인 실패(코드 $rc)를 무시하고 설치를 계속합니다 — 배포자를 확인하지 않은 코드입니다."
    return 0
  fi
  if [[ "$trust" == "package" && $rc -eq 2 ]]; then
    echo "ⓘ 새 패키지 안의 신뢰 키로는 확인할 수 없습니다(코드 2 — 신규 설치라 호스트에 신뢰 기준이 없음). 설치를 계속합니다."
    return 0
  fi
  echo "✗ 서명 확인에 실패해 설치를 멈춥니다(코드 $rc). 아무것도 바뀌지 않았습니다." >&2
  return 1
}
