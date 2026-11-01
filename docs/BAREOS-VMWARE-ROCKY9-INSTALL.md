# Bareos 설치 가이드 — Rocky Linux 9 · VMware vSphere 8/9 게스트 VM 백업 (저장 경로 `/mnt/bareos`)

> 대상: The.DVC 운영 환경(28개 vCenter · 글로벌 분산 · 일부 사이트 RTT 800ms 초과)에서 **vSphere 8.x / 9.x 의 게스트 VM 을
> 에이전트 없이(VADP + CBT) 백업**하는 Bareos 를 Rocky Linux 9 에 설치한다. 포탈의 Bareos 연동(`server/src/bareos/`, 설정 탭
> '사전 준비'·'자동 설정')이 기대하는 구성에 맞춘다.
>
> 작성 2026-10-30. 근거는 ① Bareos 공식 문서 원본(GitHub `bareos/bareos` master — `VMwarePlugin.rst.inc`·`InstallingBareos.rst`·`bareos.spec`),
> ② 이 저장소의 Bareos 연동 코드·현장 기록(커밋 0a3c155 등), ③ PyPI 의 pyVmomi 배포 기록이다.
> **이 문서를 쓴 세션은 download.bareos.org 에 접속하지 못했다** — 지금 저장소에 올라 있는 정확한 패키지 버전은 확인하지 못했다.
> 단정하지 못한 곳은 `[확인 필요]`, 추정은 `[추정]` 으로 표시했고 맨 끝 부록에 모았다.

---

## 0. 결론 요약

| 항목 | 결정 | 근거 |
|---|---|---|
| Bareos 버전 | **24.0.5 이상**(가능하면 현재 안정판 25.x) | 24.0.5 부터 VMware 플러그인이 **VDDK 9.0** 을 쓴다 — VDDK 9.0 은 vSphere 9 와 7.0.x·8.0.x 를 지원(Bareos 문서가 인용한 VDDK 9.0 릴리스 노트) |
| OS | Rocky Linux 9 (x86_64) | Bareos `EL_9` 저장소가 Rocky 를 포함(설치 문서 'EL_* repositories are for RHEL derivatives … Rocky Linux') |
| **pyVmomi** | **8.x (`pyvmomi>=8,<9`)** | Rocky 9 의 Python 은 3.9 이고, FD 의 Python 플러그인은 OS 기본 Python 으로 돈다. pyVmomi 9.x 는 `Exception: Python 3.10 or newer is required (found 3.9)` 로 플러그인이 시작하지 못한다 — **이 환경 현장 작업 로그 실측**(커밋 0a3c155, v2.822.1) |
| 백업 저장 경로 | **`/mnt/bareos`** (SD 의 `Archive Device`) | 사용자 지정 |
| 카탈로그 DB | PostgreSQL (Bareos 는 PostgreSQL 만 지원) | 설치 문서 'Setup Bareos catalog with PostgreSQL' |
| 배치 | Director 1대(한국, 포탈 옆) + **사이트마다 FD(VMware 플러그인)+SD 를 vCenter 가까이** | 고RTT(800ms+) 구간으로 디스크 데이터를 보내지 않기 위해 — 1장 |

> ⚠ vSphere 9 사이트에서 **pyVmomi 8.x 가 vCenter 9 와 모든 플러그인 동작(스냅샷·CBT·NVRAM·VM 재생성)을 문제없이 하는지는 확인하지 못했다** `[확인 필요]`.
> Bareos 문서는 "pyVmomi 메이저 버전은 vSphere 메이저 버전과 맞추는 것이 좋다" 고 쓰지만, Rocky 9(Python 3.9)에서는 9.x 를 쓸 수 없다.
> vSphere 9 사이트는 **시험 VM 1대로 백업 → 다른 이름으로 복원(VM 재생성)까지** 먼저 확인하고 확대한다(9장).
> 이것이 막히면 그 사이트의 FD 만 Python 3.10 이상이 기본인 OS(예: Rocky/RHEL 10 `[추정]`)로 두는 것이 남는 길이다.

---

### 0.1 포탈 '완전 설치'(v2.844) — 이 문서의 2~7장을 포탈이 자동으로

설정 › Bareos › **법인 Bareos 완전 설치**는 법인의 **엣지 노드 자체**에 Director · SD · FD · VMware 플러그인 · PostgreSQL 카탈로그 · WebUI 를 한 번에 설치하고
Director 를 포탈에 등록한다(담당 = 그 엣지). 배포 등록부의 SSH root 계정을 쓰고, 패키지는 포탈 릴리스와 같은 키로 서명된 **오프라인 번들**(릴리스 태그 `bareos-bundle`)에서 올린다.
규칙·되돌리기·초기화 범위는 `server/src/bareos/install/CLAUDE.md`. 이 문서와 다른 점(그 기능 기준):

- 한 서버 구성(1장의 'Director 는 한국 1대' 와 다름 — 사용자 결정 '백업은 법인 로컬'): 법인 · vCenter · Bareos 1:1:1 이라 Director 도 그 법인 엣지 노드에 둔다.
- 볼륨 경로 기본값은 패키지 기본 `/var/lib/bareos/storage`(계획 화면에서 `/mnt/bareos` 같은 다른 디스크로 바꿀 수 있다 — 3.3 의 SELinux 문맥은 포탈이 `semanage fcontext -e` 로 준다).
- 번들 실측(CI 2026-11-01): Bareos **25.1.2~pre73(download.bareos.org/current — 사전 공개판, 'experimental' 키 서명)** · PostgreSQL 13.23 ·
  VDDK `bareos-vmware-vix-disklib-9.0.0.0` 은 플러그인 의존으로 함께 들어온다(7.1 과 같음) · pyVmomi 는 8.x 휠만(7.4 현장 기록 — 9.x 는 Python 3.9 에서 플러그인이 시작하지 못함).
- 방화벽은 WebUI 의 http(80)만 연다(Director · SD · FD 는 한 서버 안에서만 통신 — 1.1 의 9101~9103 개방은 이 구성에서 필요 없다).

---

## 1. 구성 — 이 환경에 맞춘 배치

```
                       (제어만: 수 KB)                    (제어만)
[포탈 서버] ──9101/TLS-PSK──▶ [Bareos Director + PostgreSQL 카탈로그]  ──9102──▶ 각 사이트 FD
                                   (한국, 포탈과 같은 망·같은 시간대)   ──9103──▶ 각 사이트 SD

 사이트 A (예: 한국)                     사이트 B (예: 폴란드, RTT 800ms+)
 ┌───────────────────────────────┐      ┌───────────────────────────────┐
 │ Rocky 9 백업 프록시 VM           │      │ Rocky 9 백업 프록시 VM           │
 │  bareos-fd + vmware-plugin     │      │  bareos-fd + vmware-plugin     │
 │  bareos-sd → /mnt/bareos       │      │  bareos-sd → /mnt/bareos       │
 └──────┬───────────────▲─────────┘      └──────┬───────────────▲─────────┘
        │443(API)       │902/443(VDDK NBD)      │               │
     [vCenter A]     [ESXi 호스트들]          [vCenter B]     [ESXi 호스트들]
```

- **디스크 데이터는 사이트 안에서만 흐른다**: VDDK(ESXi) → FD → SD(`/mnt/bareos`). Bareos 에서 백업 데이터는 FD → SD 로 직접 가고 Director 를 거치지 않는다.
  Director·포탈은 명령과 카탈로그(파일 목록·잡 기록)만 주고받는다(`server/src/bareos/CLAUDE.md` 첫 단락과 같은 전제).
- **한 사이트 = FD 1 + SD 1 을 한 VM 에** 두는 것을 기본으로 한다(FD→SD 가 같은 호스트라 네트워크 왕복이 없다). 용량·성능이 모자라면 나눈다.
- **복원은 같은 vCenter 로만**: Bareos 문서 'Restore to different vCenter Server is unsupported'. 사이트의 FD 가 자기 vCenter 를 맡는다.
- **시간대**: 포탈은 카탈로그 시각(시간대 없는 Director 현지 시각)을 **포탈 서버 현지 시각으로 읽는다**(`server/src/bareos/CLAUDE.md`).
  Director 서버의 시간대를 포탈 서버와 같게 둔다(예: `Asia/Seoul`). 사이트 FD·SD 의 시간대는 판정에 쓰이지 않는다.

### 1.1 포트 (방화벽)

| 출발 → 도착 | 포트 | 용도 |
|---|---|---|
| 포탈 → Director | 9101/tcp | 포탈 콘솔(TLS-PSK) |
| Director → 사이트 FD | 9102/tcp | 잡 지시 |
| Director → 사이트 SD | 9103/tcp | 잡 지시 |
| 사이트 FD → 사이트 SD | 9103/tcp | **백업 데이터**(같은 VM 이면 로컬) |
| 사이트 FD → vCenter | 443/tcp | vSphere API(스냅샷·CBT·NVRAM·VM 재생성) |
| 사이트 FD → ESXi 호스트 | 902/tcp, 443/tcp | VDDK NBD/NBDSSL 디스크 읽기·쓰기 |
| 포탈 → Director(선택) | 22/tcp | 포탈 '자동 설정'(SSH root) 을 쓸 때만 |
| 포탈 → 사이트 FD(선택) | 22/tcp | 포탈 'FD INI 자동 설정'·'지문 읽기' 를 쓸 때만 |

Bareos 데몬 사이 통신은 기본으로 TLS-PSK 다(별도 인증서 불필요).

### 1.2 전송 방식(transport)

- 기본은 **자동 협상**(플러그인 옵션 `transport` 를 주지 않음). 프록시가 물리 서버거나 데이터스토어에 닿지 않는 VM 이면 NBD/NBDSSL 이 된다.
- 프록시 VM 이 **백업 대상과 같은 클러스터·데이터스토어에 닿으면** VDDK 가 hotadd 를 고를 수 있다(Bareos 문서). hotadd 는 디스크를 프록시 VM 에
  잠시 붙이는 방식이라 프록시 VM 의 SCSI 슬롯·스냅샷 상태 영향을 받는다 — **처음에는 자동 협상 그대로 두고**, 로그(`/var/log/bareos/` 의 vadp_dumper 로그)로
  실제 선택된 방식을 확인한 뒤 필요할 때만 `transport=nbdssl` 등으로 고정한다(존재하지 않는 방식을 강제하면 잡이 실패한다 — Bareos 문서).

---

## 2. 서버 준비 (모든 Bareos 서버 공통)

### 2.1 사양 기준

숫자를 단정하지 않는다 — 첫 Full 을 실측해서 정한다.

- **`/mnt/bareos` 용량** ≈ (사이트 VM 의 **사용 블록** 합 × 압축률) × 보관하는 Full 개수 + (일 변경량 × 보관 일수) + 여유 20% 이상.
  플러그인은 할당된 블록만 읽는다(23.0.0~, VDDK 할당 블록 조회). 포탈의 VM 표에 사용량(committed) 열이 있다(v2.822.2).
- 루트(`/`)와 **다른 디스크**로 `/mnt/bareos` 를 둔다(가득 차도 OS·카탈로그가 멈추지 않게).
- Director 서버의 PostgreSQL 은 파일 목록을 담는다. VM 백업은 잡당 파일 수가 디스크 개수 수준이라 작다 `[추정]`.

### 2.2 OS 기본 설정

```bash
# 호스트 이름(각 데몬이 서로를 이 이름으로 찾는다 — DNS 또는 /etc/hosts 에 정방향 등록)
hostnamectl set-hostname kr-bareos01.corp.example

# 시간 동기화(스냅샷·카탈로그·TLS 에 필요)
dnf -y install chrony && systemctl enable --now chronyd
chronyc tracking

# 시간대 — Director 서버는 포탈 서버와 같게(1장)
timedatectl set-timezone Asia/Seoul

# 기본 도구
dnf -y install policycoreutils-python-utils tar openssl
```

- **SELinux 는 끄지 않는다**(Enforcing 유지) — `/mnt/bareos` 는 3.3 처럼 문맥을 맞춘다.

---

## 3. `/mnt/bareos` 저장소 준비 (각 사이트 SD 서버)

### 3.1 로컬 디스크(권장)

```bash
# 예: 백업 전용 디스크가 /dev/sdb 일 때(먼저 lsblk 로 대상이 비어 있는지 반드시 확인)
lsblk
pvcreate /dev/sdb
vgcreate vg_bareos /dev/sdb
lvcreate -n lv_bareos -l 100%FREE vg_bareos
mkfs.xfs /dev/vg_bareos/lv_bareos

mkdir -p /mnt/bareos
echo '/dev/vg_bareos/lv_bareos  /mnt/bareos  xfs  defaults  0 0' >> /etc/fstab
systemctl daemon-reload
mount /mnt/bareos
df -h /mnt/bareos
```

`nofail` 은 붙이지 않는다 — 마운트가 실패했을 때 SD 가 루트 디스크의 빈 `/mnt/bareos` 디렉터리에 쓰는 것을 막기 위해서다(3.4 에서 한 번 더 막는다).

### 3.2 NFS 를 쓸 때

```bash
dnf -y install nfs-utils
mkdir -p /mnt/bareos
echo 'nas01.corp.example:/export/bareos  /mnt/bareos  nfs  defaults,_netdev,hard  0 0' >> /etc/fstab
systemctl daemon-reload && mount /mnt/bareos
```

- SD 는 **`bareos` 계정**으로 쓴다. NFS 서버 쪽 디렉터리의 소유자를 SD 서버의 `id -u bareos` / `id -g bareos` **숫자**와 맞춘다
  (이름이 아니라 UID/GID 로 맞춰진다). 이 환경 현장에서 `Permission denied` 를 실제로 봤다(포탈 결과 창 해석 규칙, v2.822.3).
- NFS 는 3.3 의 `restorecon` 이 적용되지 않는다(문맥이 `nfs_t` 로 고정) — 3.3 의 '거부 확인' 으로 판단한다.

### 3.3 소유자 · 권한 · SELinux

Bareos 패키지 설치(5장) **뒤에** 실행한다(`bareos` 계정이 그때 생긴다).

```bash
chown bareos:bareos /mnt/bareos
chmod 0750 /mnt/bareos

# SELinux: 패키지 기본 저장 경로(/var/lib/bareos/storage)와 같은 문맥을 /mnt/bareos 에 준다(로컬 디스크일 때)
ls -Zd /var/lib/bareos/storage           # 기본 경로의 문맥 확인(참고)
semanage fcontext -a -e /var/lib/bareos/storage /mnt/bareos
restorecon -Rv /mnt/bareos
ls -Zd /mnt/bareos

# 쓰기 시험(bareos 계정으로)
sudo -u bareos touch /mnt/bareos/.write-test && sudo -u bareos rm /mnt/bareos/.write-test && echo OK
```

첫 백업 뒤에 SELinux 거부가 있었는지 확인한다:

```bash
ausearch -m avc -ts recent | grep -i bareos || echo '거부 없음'
```

### 3.4 마운트가 없으면 SD 가 뜨지 않게

```bash
mkdir -p /etc/systemd/system/bareos-sd.service.d
cat > /etc/systemd/system/bareos-sd.service.d/mnt-bareos.conf <<'EOF'
[Unit]
RequiresMountsFor=/mnt/bareos
EOF
systemctl daemon-reload
```

---

## 4. Bareos 저장소 등록

### 4.1 인터넷이 되는 서버

Bareos 는 저장소마다 `add_bareos_repositories.sh` 를 둔다(설치 문서).

| 저장소 | 주소 | 비고 |
|---|---|---|
| 커뮤니티 안정판 | `https://download.bareos.org/current/EL_9/` | 최신 안정 브랜치의 최신 빌드 |
| 구독(유료) | `https://download.bareos.com/bareos/release/<메이저>/EL_9/` | 최근 3개 메이저 유지 · 인증 필요(자격증명은 `/etc/yum.repos.d/bareos.repo` 에 저장됨) |

```bash
cd /root
curl -fsSLO https://download.bareos.org/current/EL_9/add_bareos_repositories.sh
less add_bareos_repositories.sh          # 내용 확인 후 실행
sh ./add_bareos_repositories.sh
dnf makecache
dnf list --showduplicates bareos-vmware-plugin   # 24.0.5 이상이 보이는지 확인
```

### 4.2 에어갭(인터넷 없는) 서버

이 저장소의 포탈도 Rocky 9 오프라인 패키지(`packaging/offline/`)로 배포한다. Bareos 도 같은 방식으로 반입한다.

인터넷이 되는 **같은 마이너 버전의 Rocky 9** 에서:

```bash
sh ./add_bareos_repositories.sh
dnf -y install dnf-plugins-core createrepo_c python3-pip
mkdir -p /root/bareos-offline/rpms /root/bareos-offline/wheels
dnf download --resolve --alldeps --destdir /root/bareos-offline/rpms \
  bareos bareos-database-postgresql bareos-storage bareos-filedaemon \
  bareos-filedaemon-python3-plugin bareos-vmware-plugin bareos-tools \
  postgresql-server python3-pip python3-requests python3-urllib3
createrepo_c /root/bareos-offline/rpms
# pyVmomi 8.x 휠(대상 Python 3.9 기준)
python3 -m pip download 'pyvmomi>=8,<9' -d /root/bareos-offline/wheels
grep -i gpgkey /etc/yum.repos.d/bareos.repo   # 이 키 파일도 함께 반입한다
tar czf bareos-offline.tgz -C /root bareos-offline
```

대상 서버에서:

```bash
tar xzf bareos-offline.tgz -C /root
cat > /etc/yum.repos.d/bareos-local.repo <<'EOF'
[bareos-local]
name=Bareos local
baseurl=file:///root/bareos-offline/rpms
enabled=1
gpgcheck=1
EOF
rpm --import /root/bareos-offline/<반입한 Bareos 키 파일>
dnf makecache
```

`--alldeps` 는 이미 설치된 패키지까지 받아 크다 — 크기가 문제면 빼고, 대상에서 의존성 오류가 나는 것만 추가로 받는다.
pyVmomi 휠 설치는 7.3 의 `--no-index --find-links` 를 쓴다.

---

## 5. Director + 카탈로그 (한국, 1대)

### 5.1 PostgreSQL

```bash
dnf module list postgresql            # Rocky 9 는 기본 13 + 모듈 스트림(15·16 등) — [확인 필요] 운영 표준 버전에 맞출 것
dnf -y module enable postgresql:16    # 표준이 16 일 때의 예
dnf -y install postgresql-server
postgresql-setup --initdb
systemctl enable --now postgresql
```

### 5.2 Bareos 설치 · 카탈로그 생성

```bash
dnf -y install bareos bareos-database-postgresql
# bareos 메타 패키지 = director·storage·filedaemon·bconsole. Director 서버에서 SD·FD 를 쓰지 않으면 5.4 에서 끈다.

su postgres -c /usr/lib/bareos/scripts/create_bareos_database
su postgres -c /usr/lib/bareos/scripts/make_bareos_tables
su postgres -c /usr/lib/bareos/scripts/grant_bareos_privileges
```

### 5.3 시작 · 방화벽

```bash
systemctl enable --now bareos-dir
firewall-cmd --permanent --add-port=9101/tcp      # 포탈·bconsole → Director
firewall-cmd --reload
bconsole <<< 'version'
```

### 5.4 Director 서버에서 쓰지 않는 데몬

Director 서버가 백업 데이터를 받지 않으면 같이 설치된 SD·FD 는 끈다(켜 두려면 SD 의 `Archive Device` 도 3장처럼 맞춘다).

```bash
systemctl disable --now bareos-sd bareos-fd
```

### 5.5 WebUI (선택)

Bareos 의 PHP WebUI(`bareos-webui` — httpd + php-fpm)를 쓸 수 있다. 포탈이 실행·조회·복원 화면을 갖고 있으므로 필수는 아니다.
쓸 경우 SELinux 에서 `setsebool -P httpd_can_network_connect on` 이 필요하다(Bareos WebUI 문서).

---

## 6. 사이트 SD — `/mnt/bareos` 에 저장

### 6.1 설치

```bash
dnf -y install bareos-storage bareos-tools
# 3.3(소유자·SELinux)과 3.4(마운트 의존)를 지금 실행한다
firewall-cmd --permanent --add-port=9103/tcp && firewall-cmd --reload
```

### 6.2 장치 — 저장 경로를 `/mnt/bareos` 로

`/etc/bareos/bareos-sd.d/device/FileStorage.conf` 를 아래처럼 고친다. **`Media Type` 은 사이트마다 다르게** 한다
(Director 가 다른 사이트 SD 의 볼륨을 이 SD 에서 열려고 하지 않게).

```
Device {
  Name = FileStorage
  Media Type = File-KR              # 사이트마다 고유: File-KR, File-PL, File-USE …
  Archive Device = /mnt/bareos
  LabelMedia = yes                  # 볼륨 자동 라벨(없으면 'Please mount … label a new one' 으로 멈춘다)
  Random Access = yes
  AutomaticMount = yes
  RemovableMedia = no
  AlwaysOpen = no
  Description = "VMware VM backup volumes on /mnt/bareos"
}
```

### 6.3 Director 와의 비밀번호

SD 쪽 `/etc/bareos/bareos-sd.d/director/bareos-dir.conf` 의 `Password` 값을 Director 의 Storage 리소스(8.2)에 그대로 쓴다.
SD 의 `Name = bareos-dir` 는 Director 의 이름과 같아야 한다(기본값 `bareos-dir`).

```bash
grep -E 'Name|Password' /etc/bareos/bareos-sd.d/director/bareos-dir.conf
bareos-sd -t && systemctl enable --now bareos-sd
```

---

## 7. 사이트 FD — VMware 플러그인 + pyVmomi 8.x

SD 와 같은 VM 이면 그 VM 에 설치한다.

### 7.1 패키지

```bash
dnf -y install bareos-filedaemon bareos-filedaemon-python3-plugin bareos-vmware-plugin python3-pip python3-requests python3-urllib3
rpm -q bareos-filedaemon bareos-filedaemon-python3-plugin bareos-vmware-plugin bareos-vadp-dumper bareos-vmware-vix-disklib
```

- `bareos-vmware-plugin` → `bareos-vadp-dumper` → `bareos-vmware-vix-disklib`(VDDK)로 의존성이 이어진다(`bareos.spec`). VDDK 를 따로 받을 필요가 없다.
- **pyVmomi 는 의존성에 없다**(21.0.0 부터 — Bareos 문서). 7.2 에서 따로 설치한다.
- 플러그인은 NVRAM 백업에 `requests >= 2.20.0`, `urllib3 >= 1.24.1` 이 필요하다(23.0.3~). Rocky 9 패키지판을 쓰고 버전을 확인한다:
  `python3 -c 'import requests, urllib3; print(requests.__version__, urllib3.__version__)'`

### 7.2 pyVmomi 8.x 설치 (온라인)

```bash
python3 --version                                  # Python 3.9.x 여야 한다(Rocky 9 기본)
python3 -m pip install 'pyvmomi>=8,<9'
```

**셸에는 ASCII 작은따옴표**를 쓴다 — 굽은 따옴표(‘ ’)는 셸이 따옴표로 보지 않아 `>`·`<` 가 리다이렉트가 된다(포탈 체크리스트 v2.822.3 에서 고친 실수).

Bareos 문서의 다른 방법(Bareos 플러그인 전용 경로에 설치)도 있다:

```bash
BPP=$(python3 -c'import sys; print(f"/usr/{sys.platlibdir}/bareos/plugins")')   # Rocky 9: /usr/lib64/bareos/plugins
python3 -m pip install -t "$BPP" --upgrade 'pyvmomi>=8,<9'
```

**둘 중 한 곳에만** 둔다. 두 곳에 다른 버전이 있으면 어느 쪽이 먼저 불리는지에 따라 결과가 달라진다.

### 7.3 pyVmomi 8.x 설치 (에어갭)

```bash
python3 -m pip install --no-index --find-links /root/bareos-offline/wheels 'pyvmomi>=8,<9'
```

### 7.4 ★ pyVmomi 9 를 설치했다가 8 로 바꾼 경우 — 남은 9.x 확인

이 환경에서 실제로 있었던 순서(9 설치 → 플러그인 실패 → 8 재설치)다. **9.x 가 한 곳이라도 남아 있으면 같은 오류가 계속 난다.**

현장 기록(2026-10-30, 작업 로그 jobid 4 — Bareos `25.1.2~pre73` · Rocky Linux 9.4):
pyVmomi 가 root 의 `pip` 로 **`/usr/local/lib/python3.9/site-packages/pyVmomi/`** 에 설치돼 있었고,
`bareos-fd-vmware.py` line 50 의 `from pyVim.connect import …` 에서 `_init_utils.py` 가 `Exception: Python 3.10 or newer is required (found 3.9)` 를 냈다.
이어진 `TwoWayAuthenticate failed, because job was canceled` · `Failed to authenticate Storage daemon` · `2902 Bad storage` 는 **플러그인 치명 오류로 잡이 취소된 연쇄**다
(비밀번호 문제로 오인하지 말 것). 8.x 로 바꾼 뒤 jobid 7 에서 `Successfully connected to VSphere API` 가 확인됐다(설치된 8.x 의 정확한 버전은 기록에 없다).

```bash
# ① 시스템 site-packages 의 버전
python3 -m pip list 2>/dev/null | grep -i pyvmomi
python3 -m pip show pyvmomi | grep -E '^(Version|Location)'

# ② Bareos 플러그인 전용 경로에 따로 깔린 것이 있는지
BPP=/usr/lib64/bareos/plugins
ls -d "$BPP"/pyVmomi* "$BPP"/pyvmomi* "$BPP"/vmware 2>/dev/null
python3 -m pip list --path "$BPP" 2>/dev/null | grep -i pyvmomi

# ③ 플러그인 경로를 앞에 두었을 때 실제로 불리는 것(경로와 버전)
PYTHONPATH="$BPP" python3 -c 'import pyVmomi, importlib.metadata as m; print(pyVmomi.__file__); print(m.version("pyvmomi"))'
```

- ①~③ 이 모두 **8.x** 이고 경로가 한 곳이면 정상이다.
- ②에 9.x 가 남아 있으면: `python3 -m pip uninstall -y pyvmomi` 는 ② 경로를 지우지 않는다 — `rm -rf "$BPP"/pyVmomi "$BPP"/pyvmomi-*.dist-info "$BPP"/vmware` 처럼
  **그 경로의 pyVmomi 관련 디렉터리만** 지운다(지우기 전에 `ls` 로 대상만 있는지 확인. `$BPP` 의 `bareos-fd-vmware.py` 등 Bareos 파일은 건드리지 않는다).
  `vmware` 디렉터리는 pyVmomi 가 함께 까는 패키지(`vmware.vapi` 등)일 때만 지운다 `[확인 필요 — 설치된 휠의 RECORD 파일로 확인]`.
- 바꾼 뒤 **반드시 FD 재시작**: `systemctl restart bareos-fd` (Python 플러그인은 FD 프로세스 안에서 한 번 불린다).
- 잡 로그에 `Python 3.10 or newer is required (found 3.9)` 가 다시 나오면 9.x 가 아직 어딘가에 있는 것이다(포탈 결과 창도 이 줄에 같은 해석을 붙인다).

### 7.5 FD 설정 — Python 3 플러그인 켜기

`/etc/bareos/bareos-fd.d/client/myself.conf` 의 `Client { }` 안에 추가:

```
  Plugin Directory = /usr/lib64/bareos/plugins
  Plugin Names = "python3"
```

```bash
firewall-cmd --permanent --add-port=9102/tcp && firewall-cmd --reload
bareos-fd -t && systemctl enable --now bareos-fd
```

---

## 8. Director 에 사이트 등록

### 8.1 FD(Client) — Director 에서

```bash
bconsole
*configure add client name=kr-vmw-fd address=kr-bareos01.corp.example password=<임의의 긴 비밀번호>
```

Director 는 FD 에 넣을 설정을 `/etc/bareos/bareos-dir-export/client/kr-vmw-fd/bareos-fd.d/director/bareos-dir.conf` 로 만들어 준다.
이 파일을 사이트 FD 의 `/etc/bareos/bareos-fd.d/director/` 로 복사하고 FD 를 재시작한다.

```bash
scp /etc/bareos/bareos-dir-export/client/kr-vmw-fd/bareos-fd.d/director/bareos-dir.conf \
    root@kr-bareos01:/etc/bareos/bareos-fd.d/director/bareos-dir.conf
ssh root@kr-bareos01 'chown root:bareos /etc/bareos/bareos-fd.d/director/bareos-dir.conf; chmod 640 /etc/bareos/bareos-fd.d/director/bareos-dir.conf; bareos-fd -t && systemctl restart bareos-fd'
```

### 8.2 Storage · Pool · Schedule — Director 의 `bareos-dir.d/`

`/etc/bareos/bareos-dir.d/storage/File-KR.conf`

```
Storage {
  Name = File-KR
  Address = kr-bareos01.corp.example
  Password = "<6.3 에서 읽은 SD 비밀번호>"
  Device = FileStorage
  Media Type = File-KR          # 6.2 의 Media Type 과 같게
}
```

`/etc/bareos/bareos-dir.d/pool/KR-VM.conf`

```
Pool {
  Name = KR-VM
  Pool Type = Backup
  Storage = File-KR
  Label Format = "KR-VM-"        # 자동 라벨 볼륨 이름 접두
  Maximum Volume Bytes = 50G     # 볼륨 파일 하나의 크기 상한(예시)
  Volume Retention = 35 days     # 예시 — Full 주기의 2배 이상으로(증분은 앞선 Full 이 있어야 복원된다)
  AutoPrune = yes
  Recycle = yes
}
```

`/etc/bareos/bareos-dir.d/schedule/VM-Weekly.conf` — 시각은 **Director 현지 시각(KST)** 이다. 폴란드·미국 사이트의 현지 야간에 맞추려면 시각을 환산한다.

```
Schedule {
  Name = "VM-Weekly"
  Run = Full sun at 01:00
  Run = Incremental mon-sat at 01:00
}
```

```bash
bareos-dir -t && bconsole <<< 'reload'
bconsole <<< 'status storage=File-KR'
bconsole <<< 'status client=kr-vmw-fd'
```

사이트마다 8.1~8.2 를 반복한다(`File-PL`/`PL-VM`, `File-USE`/`USE-VM` …). 이 이름들이 포탈 설정 탭 '사이트 매핑'의 클라이언트·스토리지·풀이다.

---

## 9. vCenter 준비 · 첫 백업/복원 시험 (포탈 없이)

포탈 연동 전에 **사이트마다 VM 1대로** 플러그인이 끝까지 도는지 먼저 확인한다. vSphere 9 사이트는 이 시험이 0장 경고의 확인 절차다.

### 9.1 vCenter 계정

- 백업 전용 계정(예: `bareos-svc@vsphere.local`)을 만들고 **관리자 역할**을 준다 — Bareos 문서의 권고다(최소 권한 목록은 Bareos 가 제시하지 않는다).
- VADP 는 **Essentials 이상 라이선스**가 필요하고 무료(무라이선스) ESXi 단독 호스트에서는 동작하지 않는다(Bareos 문서).

### 9.2 vCenter 인증서 지문(SHA1)

```bash
echo -n | openssl s_client -connect vc-kr.corp.example:443 2>/dev/null | openssl x509 -noout -fingerprint -sha1 | tr -d ':'
# → SHA1 Fingerprint=AABB…(40자). '=' 뒤 값을 vcthumbprint 에 쓴다
```

인증서를 갱신하면 지문이 바뀌어 잡이 실패한다(22.1.0 부터 플러그인이 지문 불일치를 알려 준다). 포탈 '지문 읽기' 도 같은 값을 FD 에서 읽어 보여 준다.

### 9.3 자격증명 INI (FD) — 포탈 규약과 같은 위치·모양

포탈은 vCenter 비밀번호를 갖지 않고, 잡에는 `config_file=` 만 싣는다(`server/src/bareos/CLAUDE.md`). INI 는 **`/etc/bareos/` 아래**에 둔다(포탈 자동 설정의 허용 범위).

```bash
install -d -o root -g bareos -m 0750 /etc/bareos/vmware
install -o bareos -g bareos -m 0600 /dev/null /etc/bareos/vmware/vc-kr.ini
vi /etc/bareos/vmware/vc-kr.ini
```

```ini
[vmware_plugin_options]
vcserver=vc-kr.corp.example
vcuser=bareos-svc@vsphere.local
vcpass=<비밀번호>
vcthumbprint=AABBCCDDEEFF11223344556677889900AABBCCDD
```

- **따옴표 금지**(ConfigParser 가 따옴표를 값으로 읽는다 — Bareos 문서).
- **비밀번호의 `%` 는 `%%` 로** 적는다 — 플러그인이 보간을 켠 ConfigParser 로 읽어 `%` 하나면 그 사이트 백업이 전부 실패한다(플러그인 소스 확인, v2.822.3).

### 9.4 CBT

23.0.0 부터 `enable_cbt=yes` 가 기본이라 플러그인이 CBT 를 켠다. **켤 때 그 VM 에 스냅샷이 없어야 한다.** 확인·수동 조작은 패키지에 든 도구로:

```bash
vmware_cbt_tool.py -s vc-kr.corp.example -u bareos-svc@vsphere.local -p '<비밀번호>' -d <데이터센터> -f /<폴더> -v <VM이름> --info
```

(명령 인자의 비밀번호는 셸 기록에 남는다 — 시험 뒤 `history -d` 로 지우거나 `-p` 를 빼고 프롬프트로 넣는다 `[확인 필요 — 도구가 프롬프트를 지원하는지]`.)
가상 하드웨어 버전 6 이하는 CBT 가 안 된다.

### 9.5 시험 잡

`/etc/bareos/bareos-dir.d/fileset/test-vm-kr.conf`

```
FileSet {
  Name = "test-vm-kr"
  Include {
    Options { Signature = XXH128; Compression = LZ4 }
    Plugin = "python3:module_name=bareos-fd-vmware:dc=<데이터센터>:folder=/<VM 폴더>:vmname=<시험 VM>:config_file=/etc/bareos/vmware/vc-kr.ini"
  }
}
```

`/etc/bareos/bareos-dir.d/job/test-vm-kr.conf`

```
Job {
  Name = "test-vm-kr"
  Type = Backup
  Level = Full
  Client = kr-vmw-fd
  FileSet = "test-vm-kr"
  Storage = File-KR
  Pool = KR-VM
  Messages = Standard
  Write Bootstrap = "/var/lib/bareos/%c.bsr"
}
```

- 루트 폴더의 VM 은 `folder=/`. 데이터센터가 폴더 안에 있으면 `dc=/폴더/데이터센터`(Bareos 문서).
- 문서 예시의 `Plugin = "python"` 이 아니라 **`python3`** 이다(7.5 의 `Plugin Names = "python3"` 와 짝 — 포탈의 FileSet 도 `python3`).

```bash
bareos-dir -t && bconsole <<< 'reload'
bconsole <<< 'run job=test-vm-kr level=Full yes'
bconsole <<< 'messages'
ls -lh /mnt/bareos/            # (SD 서버) KR-VM-0001 같은 볼륨 파일이 생겼는지
```

이어서 같은 잡을 `level=Incremental` 로 한 번 더 돌려 증분이 작게 끝나는지 본다.

### 9.6 복원 시험

1. **로컬 VMDK 로 복원**(원본 VM 영향 없음 — 켜진 채 가능): `restore` → 5(클라이언트 최신) → 파일셋 선택 → `mark *` → `done` →
   `mod` → Plugin Options 에 `python:localvmdk=yes`, Where 는 `/mnt/bareos/restore-test`(용량 큰 디스크 — 기본 `/tmp/bareos-restores` 는 루트를 채운다).
   2TB 초과 디스크의 localvmdk 복원은 **25.0.4 이상**에서만 된다(2GB 조각으로 나뉜다).
2. **다른 이름의 새 VM 으로 복원**(VM 재생성 경로 — vSphere 9 사이트에서 반드시 시험):
   Plugin Options 에 `python:vmname=<시험VM>-restored:restore_powerstate=off`. 원본이 남아 있는 상태에서 다른 위치로 복원하면 **새 MAC·UUID 의 새 VM** 이 생긴다 —
   고정 IP 충돌을 막으려고 꺼진 채로 둔다(Bareos 문서).
3. 같은 VM 덮어쓰기 복원은 그 VM 이 **꺼져 있고 스냅샷이 없어야** 한다.

복원 시험이 끝나면 `/mnt/bareos/restore-test` 와 새 VM 을 정리한다.

---

## 10. 포탈 연동 (설정 탭)

포탈 메뉴의 Bareos 설정 탭이 Director 에 넣을 리소스(FileSet `PortalVmwareGeneric`·JobDefs `PortalVmwareDefaults`·복원 잡 `PortalVmwareRestore`·Console·Profile `portal`)를 보여 준다.

1. **연결 점검**: 포탈 서버에서 `BAREOS_PASSWORD='…' node server/src/tools/bareos-probe.js --host <Director> --name <콘솔 이름>` — TLS-PSK·인증·JSON 모드 확인.
2. **자동 설정(선택)** 은 Director 에 SSH **root 비밀번호**로 접속한다. Rocky 9 sshd 기본값 `PermitRootLogin prohibit-password` 는 이를 막는다 —
   자동 설정을 쓰려면 그 동안만 허용하거나, 화면의 '사전 준비' 블록을 `bareos-dir.d/` 에 직접 넣고 `bareos-dir -t` → `reload` 한다.
   Director 는 `bareos-dir.d/` 디렉터리 구성이어야 한다(단일 `bareos-dir.conf` 는 자동 설정이 거부).
3. **사이트 매핑**: vCenter 마다 클라이언트(8.1)·스토리지/풀(8.2)·스케줄·INI 경로(9.3)를 고른다.
4. 포탈 콘솔은 잡을 만들려고 `configure` 를 쓰므로 **사실상 Director 관리자 등급**이다(Bareos 에 하위 명령 단위 ACL 이 없다) — 콘솔 비밀번호를 그 등급으로 관리한다.

---

## 11. 문제 해결 — 이 환경에서 실제로 본 오류

| 잡 로그 줄 | 원인 | 조치 |
|---|---|---|
| `Python 3.10 or newer is required (found 3.9)` | FD 에 pyVmomi 9.x | 7.4 — 모든 위치에서 9.x 제거 → 8.x → `systemctl restart bareos-fd` |
| `Permission denied` | `/mnt/bareos` 에 `bareos` 계정이 못 씀(현장: 이전 경로 `/mnt/theDVC/bareos/Full-0006` 에서 실제 발생) | 3.3 소유자·SELinux, NFS 는 UID/GID 숫자(3.2) |
| `Please mount … label a new one` | SD 가 쓸 볼륨을 열지 못함 | 바로 위 줄(열기 실패 원인) 먼저 · Device `LabelMedia = yes` · Pool `Label Format` |
| `Could not open` / `Open device … fail` | 볼륨 파일 열기 실패 | 같은 이름의 디렉터리·권한·디스크 여유 |
| `No space left on device` | 디스크 가득 | `df -h /mnt/bareos /` · 보관 기간·볼륨 수 조정 |
| `Authorization failed` / `authenticate` | 데몬 사이 비밀번호·이름 불일치 | 6.3·8.1 의 비밀번호와 `Name = bareos-dir` · 앞선 치명 오류의 연쇄일 수 있으니 첫 오류부터 |
| INI 를 읽은 뒤 잡 전체 실패(값에 `%`) | ConfigParser 보간 | 9.3 — `%` → `%%` |
| 지문 불일치 | vCenter 인증서 갱신 | 9.2 로 다시 읽어 INI 의 `vcthumbprint` 교체 |
| 증분이 'full 이 필요' 로 실패 | 디스크가 다른 데이터스토어로 이동(Storage vMotion·SDRS) | Full 1회 실행(Bareos 제한 사항) |

윗부분 6줄은 포탈 '결과' 창이 같은 해석을 붙인다(`web/src/views/tools/bareosText.js` ISSUE_HINTS — 2026-10-30 현장 로그 실측).
디버그가 필요하면 플러그인 옵션 `vadp_dumper_verbose=yes`, `cleanup_tmpfiles=no` 를 잠시 켜고 `/var/log/bareos/` 를 본다.

### 11.1 Bareos VMware 플러그인 제한 (공식 문서)

- 일반(dependent) 디스크를 골라서 뺄 수 없다. independent 디스크는 스냅샷 대상이 아니라 자동으로 빠진다.
- **템플릿은 백업할 수 없다**(스냅샷 불가).
- 다른 vCenter 로 복원은 지원하지 않는다.
- 템플릿·OVA 로 만든 VM 을 완전히 지운 뒤 재생성 복원하면 디스크 지오메트리 불일치로 실패할 수 있다(같은 VM 이 남아 있으면 복원 가능).
- vSAN 에서 재생성 복원이 디스크 불일치로 멈추면 `restore_allow_disks_mismatch=yes`(23.0.4~).
- 24.0.1 미만에서 만든 증분·차등은 CBT 를 다 못 읽었을 수 있다 — 업그레이드 뒤 Full 1회를 권고(Bareos 문서).

---

## 12. 설치 확인 체크리스트

- [ ] 모든 서버 `chronyc tracking` 정상 · Director 시간대 = 포탈 서버 시간대
- [ ] `rpm -q bareos-vmware-plugin` 이 **24.0.5 이상**
- [ ] 7.4 의 ①~③ 이 모두 pyVmomi **8.x**, 한 위치에만 있음
- [ ] `df -h /mnt/bareos` 가 백업 전용 디스크 · `ls -ld /mnt/bareos` 소유자 `bareos` · `systemctl cat bareos-sd` 에 `RequiresMountsFor=/mnt/bareos`
- [ ] `bconsole`: `status client=<사이트 FD>` · `status storage=<사이트 SD>` 정상
- [ ] 사이트마다 시험 VM Full → Incremental → localvmdk 복원 → 새 이름 VM 복원(vSphere 9 사이트 필수)
- [ ] `ausearch -m avc -ts recent` 에 bareos 거부 없음
- [ ] 포탈 `bareos-probe.js` 접속 성공 → 설정 탭 사이트 매핑 저장

---

## 부록 A. 확인하지 못한 것 · 추정

| 항목 | 상태 |
|---|---|
| download.bareos.org 의 현재 EL_9 패키지 버전 | 이 문서를 쓴 세션에서 접속 불가 — 4.1 의 `dnf list --showduplicates` 로 확인 |
| pyVmomi 8.x ↔ vCenter 9 의 전 기능 호환 | `[확인 필요]` — 9.5·9.6 시험으로 사이트별 확인 |
| PostgreSQL 버전 선택 | `[확인 필요]` — 운영 표준에 맞춘다(Rocky 9 기본 스트림 13) |
| hotadd 사용 시 프록시 VM 영향 | 자동 협상 기본 · 로그로 확인 후 결정 |
| `vmware_cbt_tool.py` 비밀번호 프롬프트 지원 | `[확인 필요]` |
| Rocky/RHEL 10 FD 로 pyVmomi 9 사용 | `[추정]` — 시험하지 않았다 |
| 사이트 동시 백업 수 · 볼륨 크기 · 보관 기간 | 예시 값 — 첫 Full 실측 뒤 조정 |
| 현장 시험 환경의 vCenter·ESXi·VDDK 버전 · 재설치한 pyVmomi 8.x 의 정확한 버전 | 세션 기록에 없음 — `rpm -q bareos-vmware-vix-disklib` · `python3 -m pip show pyvmomi` 로 기록해 둘 것 |

## 부록 B. 근거

- Bareos 문서 원본: `docs/manuals/source/TasksAndConcepts/Plugins/FileDaemonPlugins/VMwarePlugin.rst.inc`(VDDK 9.0·pyVmomi·옵션·제한),
  `docs/manuals/source/IntroductionAndTutorial/InstallingBareos.rst`(저장소·카탈로그·서비스 이름), `core/platforms/packaging/bareos.spec`(패키지 의존성) — GitHub `bareos/bareos` master, 2026-10-30 열람.
- Bareos 24.0.5 릴리스 공지(VDDK 9.0, pyVmomi 9 호환 수정) — https://www.bareos.com/bareos-24-0-5/
- PyPI pyVmomi 배포 기록(8.0.3.0.1 = 2024-06, 9.0.0.0 = 2025-06, 9.1.1.0 = 2026-09) — https://pypi.org/project/pyvmomi/
- 이 저장소: `server/src/bareos/CLAUDE.md`, `server/src/bareos/autoSetup.js`, `web/src/views/tools/bareosText.js`,
  커밋 0a3c155(v2.822.1 — 현장 로그 `Python 3.10 or newer is required (found 3.9)`), `server/src/release-notes.json` v2.822.3·v2.822.4.
