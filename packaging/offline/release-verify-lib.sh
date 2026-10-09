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
#     sudo /opt/vmware-portal/app/release-verify.sh --file <패키지.tar.gz> --manifest vmware-portal-<버전>.manifest.json
#   이 자동 확인은 '잘못 받은 패키지'·'보관 중 손상·변조' 를 잡는 두 번째 그물이다(docs/RELEASE-SIGNING.md).
#
# verify_release_package <prefix> <script_dir> <config_dir> <version> <package_file|""> <manifest_file|""> <skip 0|1>
#   반환 0 = 설치 계속 · 1 = 멈춤
verify_release_package() {
  local prefix="$1" sdir="$2" cdir="$3" ver="$4" pkg="$5" man="$6" skip="$7"
  local base; base="$(basename "$sdir")"
  if [[ -z "$pkg" && -f "$sdir/../$base.tar.gz" ]]; then pkg="$sdir/../$base.tar.gz"; fi
  if [[ -z "$man" && -f "$sdir/../vmware-portal-$ver.manifest.json" ]]; then man="$sdir/../vmware-portal-$ver.manifest.json"; fi

  local node js trust
  local old_node="$prefix/runtime/node/bin/node" old_js="$prefix/app/server/src/upgrade/verifyCli.js"
  if [[ -d "$prefix/app" && -x "$old_node" && -f "$old_js" ]]; then
    node="$old_node"; js="$old_js"; trust="existing"
  else
    node="$sdir/runtime/node/bin/node"; js="$sdir/app/server/src/upgrade/verifyCli.js"; trust="package"
    if [[ -d "$prefix/app" ]]; then
      echo "⚠ 기존 설치본에 서명 확인 도구가 없습니다(v2.730 이전). 이번 설치는 호스트에 신뢰 기준이 없어 새 패키지 안의 도구로 확인합니다 —"
      echo "  이 확인은 무결성(손상·잘못 받은 파일)만 봅니다. 배포자 확인은 신뢰하는 다른 서버의 release-verify.sh 로 하세요."
    fi
  fi

  if [[ -z "$pkg" || -z "$man" || ! -f "$pkg" || ! -f "$man" ]]; then
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

  local pol=""
  pol="$(grep -E '^UPGRADE_SIGNATURE_POLICY=' "$cdir/portal.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  local rc=0
  echo "==> 패키지 서명 확인($([[ "$trust" == "existing" ]] && echo '기존 설치본의 도구·신뢰 키' || echo '패키지 안의 도구 — 무결성만'))"
  CONFIG_DIR="$cdir" UPGRADE_SIGNATURE_POLICY="$pol" "$node" "$js" --file "$pkg" --manifest "$man" --version "$ver" || rc=$?
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
