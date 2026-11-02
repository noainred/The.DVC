#!/usr/bin/env bash
#
# Bareos '완전 설치'(v2.844) 오프라인 번들 — Rocky Linux / RHEL 9 · x86_64.
#
# 포탈이 법인 엣지 노드에 Bareos(Director · Storage · FD · VMware 플러그인 · PostgreSQL 카탈로그)를 인터넷 없이 설치할 때 쓰는 묶음이다.
# **rockylinux:9 컨테이너 안에서** 실행한다(CI: .github/workflows/bareos-bundle.yml). 인터넷이 되는 곳에서만 만들 수 있다.
#
#   bash packaging/bareos-bundle/build-bundle.sh <출력 디렉터리>
#
# 만드는 것(<출력>/):
#   bareos-bundle-<BV>.tar.gz   — bareos-bundle/{rpms/(+repodata) · wheels/ · keys/ · bundle.json}
#   bareos-bundle-<BV>.json     — 위 bundle.json 사본(중앙이 tar 를 풀지 않고 내용·판 목록을 읽는다 — 서명 manifest 가 해시를 고정한다)
#   BV = <Bareos 메이저>.<YYYYMMDD>.<RUN_NO>  (서명 manifest 의 버전 규칙 x.y.z)
#
# 근거(docs/BAREOS-VMWARE-ROCKY9-INSTALL.md — 현장 실측 포함):
#   - 패키지 목록은 그 문서 4.2(에어갭) 의 목록 + bareos-tools·SELinux 도구. VDDK 는 bareos-vmware-plugin → bareos-vadp-dumper →
#     bareos-vmware-vix-disklib 의존으로 함께 받는다(문서 7.1 — 번들을 만들 때 의존 해석이 실제로 확정한다).
#   - ⚠ download.bareos.org/current 는 **사전 공개판**(예: 25.1.2~pre73 — 'Bareos experimental Signing Key' 서명)이다(CI 1차 실측 2026-11-01).
#     현장(문서 7.4)도 같은 판을 쓴다. 정식판은 구독 저장소(download.bareos.com — 자격증명 필요)라 BAREOS_REPO 로 바꿀 수 있게 둔다.
#   - pyVmomi 는 RPM 의존이 아니다(Bareos 21~). Rocky 9 의 Python 3.9 에서 9.x 는 'Python 3.10 or newer is required' 로 플러그인이 시작하지 못했다
#     (문서 7.4 현장 기록) — 8.x 만 휠로 넣는다(PyPI 에는 8.x 가 sdist 뿐이라 여기서 휠로 만든다).
#   - --alldeps: 대상 서버에 무엇이 깔려 있는지 모르므로 의존 전체를 받는다. **의존성**은 대상에 이미 있는 판이 요구를 채우면 dnf 가 그것을 쓴다.
#     ⚠ v2.851(2026-11-02 실환경 — 재현): 설치 목록(INSTALL_PKGS)에 적힌 이름은 다르다 — 대상에 이미 있어도 dnf(best=True)는 'install <그 이름>' 을 이 번들 판으로
#     올리는 일로 본다(서버 openssl 3.0.7-el9_4 → 번들 3.5.8-el9_8). 서버에 설치된 openssl-devel(번들에 없음)이 옛 판을 고정하면 거래 전체가 실패한다.
#     그래서 러너(server/src/bareos/install/runner.sh step2)는 이미 설치된 이름을 넘기지 않는다. 여기 목록(openssl · tar · policycoreutils-python-utils …)은
#     대상에 없을 때를 위한 것이고, 번들 안 시스템 패키지(glibc · systemd · openssl-libs …)는 이 컨테이너가 보는 최신 9.x 저장소 판이다 —
#     사전 점검(precheck.js osrel)이 서버 판과 비교해 경고한다.
#
set -euo pipefail

OUT="${1:?출력 디렉터리를 주세요}"
BAREOS_REPO="${BAREOS_REPO:-https://download.bareos.org/current/EL_9}"
PYVMOMI_VERSIONS="${PYVMOMI_VERSIONS:-8.0.3.0.1 8.0.2.0.1 8.0.1.0.2}"
PYVMOMI_DEFAULT="${PYVMOMI_DEFAULT:-8.0.3.0.1}"
RUN_NO="${RUN_NO:-0}"
# 설치 단계(러너)가 dnf install 에 넘기는 이름 — 여기서 받은 것과 같아야 한다(bundle.json install 로 전달).
# bareos-webui(2026-11-01 사용자 결정 '완전 설치에 WebUI 추가') — httpd · php-fpm 은 의존으로 함께 받는다.
# v2.845: 'bareos' 메타 패키지는 bareos-client → bareos-traymonitor(Qt5 · mesa · X11 GUI)를 끌어온다(번들 RPM 실측) — 서버에 필요한 것만 이름으로 준다.
INSTALL_PKGS=(bareos-director bareos-bconsole bareos-database-postgresql bareos-storage bareos-filedaemon bareos-filedaemon-python3-plugin bareos-vmware-plugin bareos-tools
  bareos-webui httpd php-fpm
  postgresql-server python3-pip python3-requests python3-urllib3 python3-six policycoreutils-python-utils tar openssl)

case "$RUN_NO" in (*[!0-9]*|'') echo "RUN_NO 는 숫자여야 합니다" >&2; exit 2;; esac
for v in $PYVMOMI_VERSIONS; do case "$v" in (8.*) ;; (*) echo "pyVmomi 는 8.x 만 넣습니다(받은 값: $v)" >&2; exit 2;; esac; done

. /etc/os-release
case "${VERSION_ID:-}" in (9|9.*) ;; (*) echo "Rocky/RHEL 9 컨테이너에서 실행하세요(지금: ${PRETTY_NAME:-?})" >&2; exit 2;; esac

dnf -y install dnf-plugins-core createrepo_c python3-pip tar gzip findutils
curl -fsSL -o /tmp/add_bareos_repositories.sh "$BAREOS_REPO/add_bareos_repositories.sh"
sh /tmp/add_bareos_repositories.sh
dnf -y makecache

WORK="$(mktemp -d)"
B="$WORK/bareos-bundle"
mkdir -p "$B/rpms" "$B/wheels" "$B/keys" "$OUT"

echo "== RPM 받기(의존 전체)"
# 저장소에 aarch64 판도 있어 이름만 주면 두 아키텍처가 함께 걸린다(CI 1차 실패 — conflicting requests) → x86_64·noarch 로 한정
dnf download --arch x86_64 --arch noarch --resolve --alldeps --destdir "$B/rpms" "${INSTALL_PKGS[@]}"
createrepo_c "$B/rpms"

echo "== 서명 키"
# Bareos 저장소 키(저장소 파일의 gpgkey) + 이 컨테이너의 Rocky 키(RHEL 대상에도 Rocky 서명 패키지를 검사할 수 있게)
for url in $(grep -h '^gpgkey' /etc/yum.repos.d/*bareos*.repo | sed 's/^gpgkey *= *//' | tr ' ' '\n' | sort -u); do
  case "$url" in
    (http*://*) curl -fsSL -o "$B/keys/RPM-GPG-KEY-bareos-$(echo "$url" | sha256sum | cut -c1-8)" "$url";;
    (file://*) cp "${url#file://}" "$B/keys/";;
  esac
done
cp /etc/pki/rpm-gpg/RPM-GPG-KEY-Rocky-9 "$B/keys/" 2>/dev/null || true
ls "$B/keys" | grep -q . || { echo "서명 키를 하나도 넣지 못했습니다" >&2; exit 1; }

echo "== pyVmomi 휠"
# PyPI 의 pyVmomi 8.x 는 sdist 뿐 — 휠을 만들려면 빌드 도구(wheel)가 필요하다(CI 2차 실패: invalid command 'bdist_wheel'). 빌드 컨테이너에만 깐다.
python3 -m pip install --quiet wheel
for v in $PYVMOMI_VERSIONS; do python3 -m pip wheel --no-deps -w "$B/wheels" "pyvmomi==$v"; done

echo "== 내용 목록"
DIR_RPM="$(ls "$B"/rpms/bareos-director-[0-9]*.rpm | head -1)"
BAREOS_VERSION="$(rpm -qp --qf '%{VERSION}' "$DIR_RPM")"
PG_RPM="$(ls "$B"/rpms/postgresql-server-[0-9]*.rpm | head -1)"
PG_VERSION="$(rpm -qp --qf '%{VERSION}' "$PG_RPM")"
MAJOR="${BAREOS_VERSION%%.*}"
case "$MAJOR" in (*[!0-9]*|'') echo "Bareos 판을 읽지 못했습니다: $BAREOS_VERSION" >&2; exit 1;; esac
BV="$MAJOR.$(date -u +%Y%m%d).$RUN_NO"

python3 - "$B" "$BV" "$BAREOS_VERSION" "$PG_VERSION" "$BAREOS_REPO" "$PYVMOMI_DEFAULT" "${INSTALL_PKGS[*]}" <<'PY'
import json, os, subprocess, sys, datetime
b, bv, bareos, pg, repo, pydef, install = sys.argv[1:8]
pk = []
for f in sorted(os.listdir(os.path.join(b, 'rpms'))):
    if not f.endswith('.rpm'): continue
    q = subprocess.run(['rpm', '-qp', '--qf', '%{NAME}\t%{VERSION}\t%{RELEASE}\t%{ARCH}', os.path.join(b, 'rpms', f)], capture_output=True, text=True, check=True).stdout.split('\t')
    pk.append({'name': q[0], 'version': q[1], 'release': q[2], 'arch': q[3], 'file': f})
wheels = sorted(f for f in os.listdir(os.path.join(b, 'wheels')) if f.endswith('.whl'))
pyv = sorted({w.split('-')[1] for w in wheels if w.lower().startswith('pyvmomi-')}, key=lambda v: [int(x) if x.isdigit() else x for x in v.split('.')], reverse=True)
if pydef not in pyv: sys.exit(f'기본 pyVmomi {pydef} 휠이 없습니다')
doc = {
  'format': 'portal-bareos-bundle', 'v': 1, 'version': bv, 'builtAt': datetime.datetime.utcnow().replace(microsecond=0).isoformat() + 'Z',
  'el': '9', 'arch': 'x86_64', 'bareosVersion': bareos, 'postgresqlVersion': pg, 'bareosRepo': repo,
  'install': install.split(), 'packages': pk, 'keys': sorted(os.listdir(os.path.join(b, 'keys'))),
  'pyvmomi': {'versions': pyv, 'default': pydef, 'python': '3.9', 'wheels': wheels},
  'vddk': sorted({p['name'] + '-' + p['version'] for p in pk if 'vix-disklib' in p['name'] or p['name'] == 'bareos-vadp-dumper'}),
}
json.dump(doc, open(os.path.join(b, 'bundle.json'), 'w'), ensure_ascii=False, indent=1)
print(json.dumps({k: doc[k] for k in ('version', 'bareosVersion', 'postgresqlVersion', 'install', 'vddk')}, ensure_ascii=False))
print('packages', len(pk), 'pyvmomi', pyv)
PY

tar czf "$OUT/bareos-bundle-$BV.tar.gz" -C "$WORK" bareos-bundle
cp "$B/bundle.json" "$OUT/bareos-bundle-$BV.json"
ls -l "$OUT"
echo "BUNDLE_VERSION=$BV"
[ -n "${GITHUB_OUTPUT:-}" ] && echo "version=$BV" >> "$GITHUB_OUTPUT" || true
