# 에어갭 LLM 서버 구축 가이드 — Rocky Linux 9 + NVIDIA A40(24GB vGPU) + Ollama + Qwen

> 대상: The.DVC(VMware Global Monitoring Portal)의 자연어 처리(한국어 → 검색쿼리/추가명세 JSON) 백엔드로 쓸 **온프렘·에어갭 로컬 LLM 서버**.
> 하드웨어: NVIDIA A40(물리 48GB)에서 잘라낸 **24GB vGPU 프로파일** 게스트 VM · OS: **Rocky Linux 9**.
> 원칙(포탈 설계와 동일): LLM은 **질문→JSON 해석만** 하고 실제 인프라 데이터는 포탈을 벗어나지 않는다. LLM 오류/미설정 시 포탈은 규칙기반으로 자동 폴백한다.

> ⚠️ **정직 고지**: 이 가이드의 버전·태그·용량 숫자는 **작성 시점(2026-08) 예시**이고, 벤더 특정(특히 vGPU 드라이버/라이선스)·에어갭 반입 세부는 조직 NVIDIA 엔타이틀먼트와 인프라에 종속됩니다. 본문의 `[확인 필요]` 표시 지점은 단정하지 말고 담당자/엔타이틀먼트로 확인하세요. 마지막 부록에 "확인 필요" 항목을 한데 모았습니다.

---

## 0. 개요 · 아키텍처 · 반입 준비물

### 0.1 전체 데이터 흐름 (포탈 ↔ LLM)

```
[운영자 브라우저]
   │  자연어("폴란드 vCenter CPU 높은 호스트 5개")
   ▼
[The.DVC 포탈 서버] ── nlSearch/nlAdd 파서
   │  1차: 규칙 파서(순수 CPU, LLM 불필요)
   │  2차(옵션): LLM 필요 시 → 아래로 HTTP 호출
   ▼  POST http://<LLM서버>:11434/api/generate  (format:json, temperature:0)
[이 가이드로 만드는 LLM 서버]  Rocky9 + A40 24GB vGPU + Ollama + Qwen
   ▲  응답: 검색쿼리 JSON 만 반환(원본 데이터는 프롬프트에 없음)
   │
[포탈이 로컬 스냅샷에 그 JSON 쿼리를 실행 → 결과 표시]
```

- **LLM에는 질문 문장과 스키마 지시만** 간다. VM/호스트/IP 원본은 포탈 내부에서만 조회된다.
- 포탈은 `GET /api/tags`(연결/모델확인)·`POST /api/generate`(추론) 두 엔드포인트만 쓴다.

### 0.2 배치 토폴로지 — 둘 중 하나 선택

| 토폴로지 | Ollama 바인딩 | 방화벽 11434 | 권장 상황 |
|---|---|---|---|
| **A) 포탈과 LLM이 같은 서버** | `127.0.0.1:11434`(로컬 전용) | **열지 않음** | 가장 안전. GPU VM에 포탈도 함께 둘 수 있을 때 |
| **B) LLM 전용 서버 + 원격 포탈** | `0.0.0.0:11434` | **포탈 IP만** rich rule 허용 | GPU 서버를 분리 운용(A40 전용 노드) |

> Ollama에는 기본 인증이 없다. **B에서는 반드시 firewalld source 제한으로 포탈 서버 IP만** 11434를 허용한다(전체 개방 금지). 포탈의 SSH 자동설치 스크립트는 B를 가정해 `0.0.0.0:11434`로 심는다.

### 0.3 구축 순서 (이 문서의 장 구성)

```
1. Rocky Linux 9 설치(에어갭 로컬 리포)  →  2. A40 vGPU 게스트 드라이버 + 라이선스
   →  3. CUDA/드라이버 검증  →  4. 보안·방화벽·계정  →  5. Ollama 오프라인 설치+systemd+GPU
   →  6. Qwen 모델 오프라인 반입+최적화  →  7. 포탈(The.DVC) 연동  →  8. 통합 검증·트러블슈팅
```

### 0.4 마스터 반입 체크리스트 (에어갭 — 인터넷 되는 곳에서 미리 확보)

| # | 반입물 | 사용 장 | 비고 |
|---|---|---|---|
| 1 | `Rocky-9.x-x86_64-**dvd**.iso` + SHA256 | §1 | minimal 아님(오프라인 리포 소스) |
| 2 | EPEL RPM 세트(최소 `dkms`+의존성) | §1 | DVD에 dkms 없음 |
| 3 | **NVIDIA vGPU 게스트 드라이버 `.run`**(`-grid`) | §2 | NVIDIA Licensing Portal — **엔타이틀먼트 필요 [확인]** |
| 4 | **DLS 클라이언트 설정 토큰 `.tok`** | §2 | 사내 DLS 어플라이언스에서 생성 [확인] |
| 5 | `zstd` RPM(+의존성) | §5 | 최신 Ollama tarball이 zstd |
| 6 | **Ollama Linux tarball** + `sha256sum.txt` | §5 | 버전 고정 반입 |
| 7 | **Qwen 모델**(공식 `ollama pull` 후 models 디렉터리 tar, 또는 GGUF) | §6 | 24GB에 맞는 태그 [확인] |

### 0.5 이 서버에 올릴 모델 — 결론

작업이 "한국어 한두 문장 → JSON"이라 **큰 추론력이 불필요**하다. 24GB 예산 기준:

- **품질안**: 최신 Qwen dense **27B급 @ Q4_K_M(~17GB)** — 복잡한 한국어 지시에 강함.
- **속도안**: dense **8B~14B @ Q4~Q8** — 응답 지연 최소, 동시요청 여유.
- **피할 것**: `35b-a3b`(≈24GB, KV 자리 없음)·초대형 MoE(235B급) — 24GB 초과/오프로드로 느려짐.
- 최신 태그(예: qwen3.6 계열)는 반입 전 `ollama.com/library/.../tags`와 온라인 머신 `ollama show`로 **실제 태그·용량 재확인**(§6). 대표 프롬프트 20~30개로 A/B 실측 권장.

---

# 1. Rocky Linux 9 서버 설치 (에어갭)

이 섹션은 인터넷이 차단된 온프렘(air-gapped) 환경에서 NVIDIA A40(48GB, **24GB vGPU 프로파일** 할당) 게스트 VM 위에 **Rocky Linux 9**를 헤드리스로 설치하고, 이후 vGPU 드라이버 빌드와 Ollama 구동을 위한 초기 환경(오프라인 리포·시간 동기화·방화벽·빌드 도구)을 갖추는 절차를 다룹니다.

> ⚠️ **버전 표기 주의**: 아래 명령의 버전 숫자(예: `Rocky-9.4-x86_64-dvd.iso`, 커널 버전 등)는 **작성 시점 예시**입니다. 실배포 시 반입한 ISO/패키지의 실제 버전으로 바꾸세요. `$(uname -r)` 같은 동적 표현은 그대로 써도 됩니다.

> ⚠️ **에어갭 대전제**: 이 환경은 인터넷/온라인 리포지토리에 접근할 수 없습니다. 따라서 아래 절차의 모든 패키지·바이너리·모델은 **외부에서 미디어(USB/DVD/승인된 반입 채널)로 반입**해 로컬에서 설치합니다. `dnf install`이 인터넷을 타지 않도록 로컬 리포만 활성화하는 것이 핵심입니다.

---

## 1.1 사전 준비 (반입 물품 체크리스트)

에어갭 반입 전, 인터넷 되는 별도 준비용 PC에서 아래를 미리 확보해 검증 미디어에 담아 반입합니다.

| 반입 물품 | 용도 | 확보처(공식) |
|---|---|---|
| `Rocky-9.x-x86_64-dvd.iso` (**dvd**, minimal 아님) | OS 설치 + 오프라인 BaseOS/AppStream 리포 소스 | rockylinux.org |
| ISO의 SHA256 체크섬 파일 | 무결성 검증 | rockylinux.org |
| EPEL 미러(최소 `dkms` 및 의존성) | ⚠️ `dkms`는 DVD에 **없음**(EPEL 전용) — vGPU 드라이버 자동 재빌드에 필요 | dl.fedoraproject.org/pub/epel |
| NVIDIA **vGPU 게스트 드라이버** `.run`/RPM | A40 vGPU 게스트용 (섹션 2에서 사용) | NVIDIA Licensing Portal (**엔타이틀먼트 필요 — 확인 필요**) |
| Ollama 리눅스 tgz + Qwen 모델 blob | 섹션 3~4에서 사용 | Ollama GitHub Releases / Qwen 공식 HF |

> ⚠️ **dvd ISO vs minimal ISO**: 오프라인 리포로 쓰려면 반드시 **dvd(전체) ISO**를 반입하세요. `minimal`/`boot` ISO에는 AppStream 패키지가 거의 없어 `gcc`·`kernel-devel` 등을 로컬에서 설치할 수 없습니다.

ISO 무결성 검증(준비용 PC 또는 반입 후 관리 노드):

```bash
sha256sum -c Rocky-9.4-x86_64-dvd.iso.CHECKSUM
# 또는 단순 비교
sha256sum Rocky-9.4-x86_64-dvd.iso
```

---

## 1.2 VM/가상 미디어 설정 (헤드리스)

vGPU 프로파일이 붙은 게스트 VM에 dvd ISO를 CD/DVD 가상 드라이브로 연결하고 부팅합니다. 헤드리스이므로 하이퍼바이저의 원격 콘솔(예: vSphere Web Console / VNC)로 설치 화면에 접근합니다.

- 부팅 펌웨어: UEFI 권장(요즘 표준). Secure Boot를 켜면 이후 **NVIDIA 커널 모듈 서명** 이슈가 생길 수 있음 → **확인 필요**(2번 섹션 드라이버 파트와 연계).
- 부팅 메뉴에서 `Install Rocky Linux 9` 선택.

> ⚠️ vGPU 게스트에서 설치 초기에는 NVIDIA 드라이버가 없으므로 GPU 콘솔 출력이 안 나올 수 있습니다. 하이퍼바이저 콘솔(웹/VNC)로 설치를 진행하는 것이 정상입니다.

---

## 1.3 설치 유형 및 파티션 (LVM)

Anaconda 설치 관리자에서 다음을 설정합니다.

### 소프트웨어 선택
- **Base Environment**: `Server`(GUI 불필요, 헤드리스) 또는 `Minimal Install`.
  - 권장: **Server**(GUI 없음). Minimal을 고르면 이후 오프라인 리포에서 빌드 도구를 별도 설치해야 하는데, 어차피 이 가이드에서 명시적으로 설치하므로 어느 쪽도 무방합니다.
- GUI(Server with GUI/Workstation)는 서버 용도상 불필요 → 공격면·리소스 절감 위해 미선택 권장.

### 파티션 — 대용량 모델 볼륨을 위한 LVM 설계

모델 blob은 크기가 큽니다(예: Qwen 27B급 GGUF 양자화 모델은 수십 GB, 여러 개면 수백 GB까지). **Ollama 기본 모델 저장 경로는 `/usr/share/ollama/.ollama/models`**(systemd 서비스가 `ollama` 계정으로 동작 시). 이 경로가 속한 파일시스템에 여유가 없으면 모델 pull/import가 실패합니다.

권장 설계: **LVM** 기반으로 루트와 데이터(모델)를 분리해 나중에 온라인 확장 가능하게 합니다.

| 마운트 | 크기(예시) | FS | 비고 |
|---|---|---|---|
| `/boot/efi` | 600 MiB | vfat/EFI | UEFI 필수 |
| `/boot` | 1 GiB | xfs/ext4 | LVM 밖 |
| `/` (root LV) | 40~80 GiB | xfs | OS |
| `swap` (LV) | 8~16 GiB | swap | 메모리 규모 따라 조정 |
| `/var` (LV) | 20~40 GiB | xfs | 로그/컨테이너/저널 격리(로그 폭주가 root 채우는 것 방지) |
| **`/opt/models`** 또는 **`/var/lib/ollama`** (LV) | **200 GiB+** | xfs | ⚠️ 모델 전용 대용량 볼륨. Ollama 모델 디렉터리를 여기로 지정 |

설계 이유(운영 관점): `/var`를 분리하면 로그·저널 폭주가 root를 채워 부팅 불능에 빠지는 사고를 막습니다. 모델 볼륨을 별도 LV로 두면 부족 시 `lvextend + xfs_growfs`로 무중단 확장이 됩니다.

설치 후 XFS 온라인 확장 예시(디스크 추가/여유 PE가 있을 때):

```bash
# 예시: 모델 LV를 100GiB 더 확장
lvextend -L +100G /dev/mapper/rl-models
xfs_growfs /opt/models          # XFS는 마운트된 채 확장
```

> ⚠️ **XFS는 축소 불가**: XFS 파일시스템은 온라인 확장만 되고 **축소가 안 됩니다**. LV 크기를 넉넉히 잡되, 과할당했다면 재생성만이 방법입니다. ext4는 축소가 되지만 서버 표준은 XFS(Rocky 9 기본).

---

## 1.4 호스트명 · 네트워크 · 시간(NTP)

설치 중 또는 설치 후 CLI로 설정합니다. 아래는 설치 후 CLI 기준(에어갭이므로 고정 IP 권장).

### 호스트명
```bash
hostnamectl set-hostname llm-a40-01.dc.local
```

### 네트워크 (고정 IP, nmcli)
```bash
# 연결 이름 확인
nmcli connection show
# 예: 'ens192' 연결에 고정 IP/게이트웨이/사내 DNS 지정
nmcli connection modify ens192 \
  ipv4.method manual \
  ipv4.addresses 10.20.30.11/24 \
  ipv4.gateway 10.20.30.1 \
  ipv4.dns 10.20.30.2
nmcli connection up ens192
ip a; ip route      # 확인
```

> ⚠️ 에어갭에서는 외부 DNS(8.8.8.8 등)를 쓰지 마세요. **사내 DNS**만 지정하거나, DNS가 없으면 `/etc/hosts`에 포탈·미러·LLM 호스트를 직접 등록합니다.

### 시간 동기화 (chrony) — 에어갭 주의
Rocky Linux 9는 **chrony**(`chronyd`)를 기본 시간 동기화 데몬으로 사용합니다.

```bash
timedatectl set-timezone Asia/Seoul
```

에어갭에서는 인터넷 NTP(pool.ntp.org)에 도달할 수 없으므로 **사내 NTP 서버**로 지정해야 합니다. `/etc/chrony.conf` 편집:

```conf
# 기본 pool 라인(pool 2.rocky.pool.ntp.org ...)을 주석 처리/삭제하고
# 사내 NTP 서버로 교체 (예시 IP)
server 10.20.30.2 iburst
```

적용 및 확인:
```bash
systemctl enable --now chronyd
systemctl restart chronyd
chronyc sources -v      # ^* 로 동기화된 소스 표시되는지 확인
timedatectl              # 'System clock synchronized: yes' 확인
```

> ⚠️ **사내 NTP가 없으면**: 시간이 틀어지면 TLS 인증서 검증·로그 상관·포탈 스냅샷 타임스탬프가 어긋납니다. NTP 서버가 정말 없다면 최소한 설치 시 정확한 시간을 수동 설정하고, 가상화 호스트의 시간 동기화(예: VMware Tools 시간 동기화) 사용 여부를 **확인 필요** 항목으로 검토하세요.

---

## 1.5 에어갭 로컬 리포지토리 구성 (핵심)

인터넷 없이 `dnf`를 쓰려면 로컬 리포를 만들고 **기본 온라인 리포를 비활성화**합니다. 두 가지 소스를 씁니다: (A) DVD ISO 리포(BaseOS/AppStream), (B) 사내 미러(선택, EPEL 등).

### (A) DVD ISO 마운트 리포

ISO를 반입해 서버에 두고 상시 마운트합니다.

```bash
# 1) ISO 배치 및 마운트 지점
mkdir -p /srv/iso /mnt/rocky-dvd
cp /path/to/Rocky-9.4-x86_64-dvd.iso /srv/iso/

# 2) 부팅 시 자동 마운트 (읽기전용, loop)
echo '/srv/iso/Rocky-9.4-x86_64-dvd.iso  /mnt/rocky-dvd  iso9660  loop,ro,nofail  0 0' >> /etc/fstab
mount -a
ls /mnt/rocky-dvd   # BaseOS/ AppStream/ 디렉터리 확인
```

리포 정의 파일 작성 — DVD에 동봉된 GPG 키로 `gpgcheck=1` 유지 권장:

```bash
# DVD의 GPG 키 임포트
rpm --import /mnt/rocky-dvd/RPM-GPG-KEY-Rocky-9

cat > /etc/yum.repos.d/rocky-dvd.repo <<'EOF'
[dvd-baseos]
name=Rocky Linux 9 - BaseOS (DVD)
baseurl=file:///mnt/rocky-dvd/BaseOS
enabled=1
gpgcheck=1
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-Rocky-9

[dvd-appstream]
name=Rocky Linux 9 - AppStream (DVD)
baseurl=file:///mnt/rocky-dvd/AppStream
enabled=1
gpgcheck=1
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-Rocky-9
EOF
```

> ⚠️ **GPG 키 경로 확인 필요**: 키 파일명은 릴리스에 따라 `RPM-GPG-KEY-Rocky-9` 형태입니다. `ls /mnt/rocky-dvd/` 및 `/etc/pki/rpm-gpg/`에서 실제 파일명을 확인해 `gpgkey=` 경로를 맞추세요. 확실치 않으면 우선 DVD 안의 키 파일 경로(`file:///mnt/rocky-dvd/RPM-GPG-KEY-Rocky-9`)를 그대로 gpgkey로 지정해도 됩니다.

### 기본 온라인 리포 비활성화

에어갭에서 온라인 리포가 활성이면 `dnf`가 매번 도달 불가 URL로 타임아웃 나며 느려집니다. 온라인 리포를 끕니다.

```bash
# 방법 1: 확장자 변경으로 비활성 (원본 보존)
cd /etc/yum.repos.d
for f in rocky*.repo rocky-*.repo; do
  # DVD용 우리 파일(rocky-dvd.repo)은 건드리지 않도록 주의
  case "$f" in rocky-dvd.repo) continue;; esac
  mv "$f" "$f.disabled" 2>/dev/null || true
done

# 방법 2(대안): dnf 설정으로 전역 비활성 후, 쓸 때만 --enablerepo
# 각 명령에서 --disablerepo='*' --enablerepo='dvd-*' 로 강제
```

동작 검증:
```bash
dnf clean all
dnf --disablerepo='*' --enablerepo='dvd-*' repolist
dnf --disablerepo='*' --enablerepo='dvd-*' makecache
```

### (B) 사내 미러 리포 (선택 — EPEL/추가 패키지)

여러 서버가 있거나 EPEL(예: `dkms`)이 필요하면, 한 대를 미러 호스트로 두고 나머지가 HTTP로 당기게 합니다. 준비용 PC에서 EPEL 하위셋을 내려받아 반입한 뒤 `createrepo_c`로 메타데이터를 만듭니다.

```bash
# (미러 호스트에서) 메타데이터 생성 도구 — DVD 리포로 설치 가능
dnf --disablerepo='*' --enablerepo='dvd-*' install -y createrepo_c

# 반입한 EPEL RPM들을 디렉터리에 모아 repodata 생성
mkdir -p /srv/repo/epel9
cp /반입경로/epel-rpms/*.rpm /srv/repo/epel9/
createrepo_c /srv/repo/epel9

# HTTP로 서빙(사내 미러). httpd도 DVD 리포에 있음
dnf --disablerepo='*' --enablerepo='dvd-*' install -y httpd
mkdir -p /var/www/html/repo
mount --bind /srv/repo /var/www/html/repo   # 또는 심볼릭/복사
systemctl enable --now httpd
firewall-cmd --add-service=http --permanent && firewall-cmd --reload
```

클라이언트 리포 정의(사내 미러 baseurl):
```bash
cat > /etc/yum.repos.d/intranet-epel.repo <<'EOF'
[intranet-epel9]
name=Intranet EPEL 9 mirror
baseurl=http://10.20.30.11/repo/epel9
enabled=1
gpgcheck=0
EOF
```

> ⚠️ **`gpgcheck=0`는 편의상 예시**입니다. 보안상 EPEL GPG 키(`RPM-GPG-KEY-EPEL-9`)도 함께 반입·임포트하고 `gpgcheck=1 gpgkey=...`로 두는 것을 권장합니다(정직: 서명 검증을 끄면 반입 무결성 보증이 약해집니다).

---

## 1.6 빌드 도구 확보 (vGPU 드라이버 빌드 전제)

섹션 2의 NVIDIA vGPU **게스트 드라이버**는 커널 모듈을 빌드합니다. 이를 위한 도구를 로컬 리포에서 설치합니다.

### DVD 리포로 설치 가능한 것 (BaseOS/AppStream 내)
```bash
dnf --disablerepo='*' --enablerepo='dvd-*' install -y \
  gcc gcc-c++ make automake tar bzip2 \
  kernel-devel-$(uname -r) kernel-headers-$(uname -r) \
  elfutils-libelf-devel pciutils pkgconf acpid
```

`kernel-devel`은 **현재 실행 중인 커널과 버전이 정확히 일치**해야 모듈이 빌드됩니다. 확인:
```bash
uname -r
rpm -q kernel-devel kernel-headers
# 두 버전이 uname -r 과 일치하는지 확인
```

> ⚠️ **커널 업데이트와 버전 불일치**: 에어갭에서 커널을 나중에 업데이트하면 `kernel-devel`도 같은 버전을 반입/설치해야 합니다. 불일치 시 vGPU 모듈 빌드가 실패합니다. **커널을 함부로 업데이트하지 말고**, 필요 시 커널·kernel-devel·NVIDIA 드라이버를 한 세트로 반입해 함께 적용하세요.

### ⚠️ dkms 는 DVD에 없다 (EPEL 전용)

**중요(검증됨)**: `dkms` 패키지는 Rocky 9의 **BaseOS/AppStream(DVD)에 포함되지 않고 EPEL에서 제공**됩니다. `gcc`·`make`·`kernel-devel`·`kernel-headers`는 DVD에 있지만 `dkms`는 없습니다.

DKMS는 커널 업데이트 때 NVIDIA 모듈을 자동 재빌드해 주는 편의 기능입니다. 에어갭에서 선택지는 두 가지:

1. **EPEL에서 dkms 반입(권장)** — 위 1.5(B) 사내 미러 또는 반입한 RPM으로 설치:
   ```bash
   dnf --disablerepo='*' --enablerepo='intranet-epel9' install -y dkms
   # 또는 반입한 로컬 rpm 직접 설치(의존성 함께)
   dnf install -y ./dkms-*.noarch.rpm
   ```
2. **DKMS 없이 진행** — NVIDIA `.run` 설치 시 DKMS를 쓰지 않고 현재 커널에 대해서만 모듈을 빌드. 대신 **커널이 바뀌면 드라이버를 수동 재설치**해야 합니다. 에어갭에서 커널을 고정 운용한다면 이 방식도 실무상 무방합니다(정직: 자동 재빌드 편의만 포기).

> ⚠️ **엔타이틀먼트/방식 확인 필요**: NVIDIA vGPU 게스트 드라이버가 DKMS를 요구하는지, `.run` 인스톨러의 `--dkms` 옵션을 쓸지는 반입한 드라이버 패키지 종류(.run vs RPM)에 따라 다릅니다. 섹션 2에서 실제 드라이버로 확정하세요.

---

## 1.7 기본 하드닝

### SELinux — enforcing 유지 권장
Rocky 9 기본값은 `enforcing`입니다. **끄지 말고 유지**하는 것을 권장합니다(정직: Ollama/포탈 연동은 enforcing에서 정상 동작 가능. 특정 커스텀 경로 접근 거부가 나면 끄는 대신 개별 정책/컨텍스트로 해결).

```bash
getenforce                 # Enforcing 확인
sestatus
# (문제 발생 시 임시 진단용으로만) setenforce 0 → 원인 파악 후 다시 1
```

> ⚠️ 모델 디렉터리를 비표준 경로(`/opt/models` 등)로 옮기고 Ollama가 접근 거부되면, `semanage fcontext`로 컨텍스트를 지정(`restorecon`)하는 것이 SELinux를 끄는 것보다 안전합니다. 구체 규칙은 섹션 3(Ollama 설치)에서 다룹니다 — **확인 필요**.

### 방화벽 (firewalld) — Ollama 포트 11434 로컬 한정

포탈↔Ollama 연동 계약상 포탈이 원격에서 접속하려면 **11434/tcp**가 열려야 합니다. 다만 **같은 호스트에서만 쓸 것이라면 로컬 한정으로 두는 것이 안전**합니다.

- **케이스 A — Ollama와 포탈이 같은 서버**(로컬 루프백만 사용): 11434를 외부에 열지 않습니다. Ollama가 `127.0.0.1:11434`만 리슨하도록 두면 방화벽 노출이 불필요합니다.
  ```bash
  # 별도 개방 없음. Ollama OLLAMA_HOST=127.0.0.1:11434 (기본) 유지
  systemctl enable --now firewalld
  firewall-cmd --list-all
  ```
- **케이스 B — 포탈이 다른 서버에서 이 Ollama로 접속**(연동 계약의 배포 스크립트가 `OLLAMA_HOST=0.0.0.0:11434`로 심는 시나리오): 포탈 서버 IP로만 11434를 허용하는 **rich rule** 권장(전체 개방 금지).
  ```bash
  # 포탈 서버 IP(예: 10.20.30.50)에서 오는 11434만 허용
  firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="10.20.30.50/32" port port="11434" protocol="tcp" accept'
  firewall-cmd --reload
  firewall-cmd --list-rich-rules
  ```

> ⚠️ **0.0.0.0 노출 주의**: 연동 계약의 SSH 배포 스크립트(`ollamaDeploy.js`)는 원격 접속을 위해 `OLLAMA_HOST=0.0.0.0:11434`를 심습니다. Ollama에는 기본 인증이 없으므로, 0.0.0.0으로 리슨할 때는 **반드시 방화벽 source 제한(rich rule)으로 포탈 서버만 허용**하세요. 전체 네트워크에 11434를 여는 것은 금지합니다.

### 서비스 계정

Ollama systemd 서비스는 전용 비로그인 계정으로 돌립니다(연동 계약의 배포 스크립트도 동일하게 `ollama` 계정을 생성). 수동 설치 시:

```bash
id ollama >/dev/null 2>&1 || useradd -r -s /bin/false -m -d /usr/share/ollama ollama
```

- `-r`(시스템 계정), `-s /bin/false`(로그인 셸 없음)로 공격면을 줄입니다.
- 관리자 작업은 개인 계정 + `sudo`로 수행하고 root 직접 로그인은 지양(SSH `PermitRootLogin` 정책은 조직 표준에 맞춰 **확인 필요**).

---

## 1.8 설치 완료 검증 체크리스트

```bash
# OS/커널
cat /etc/rocky-release
uname -r

# 리포 (DVD만 활성, 온라인 비활성 확인)
dnf repolist

# 시간
timedatectl            # synchronized: yes
chronyc sources

# 네트워크
ip a; ip route; cat /etc/resolv.conf

# 파티션/모델 볼륨
lsblk; df -hT /opt/models

# 빌드 도구 (버전 일치)
rpm -q gcc make kernel-devel kernel-headers
# (EPEL 반입 시) rpm -q dkms

# 보안
getenforce             # Enforcing
firewall-cmd --list-all
id ollama
```

위 항목이 모두 기대대로면 섹션 2(NVIDIA vGPU 게스트 드라이버 설치)로 진행할 준비가 된 것입니다.

---

### 이 섹션에서 반드시 기억할 것 (요약)
- **dvd(전체) ISO**를 반입해 `file://` 리포로 만들고, **온라인 리포는 비활성화**한다.
- 모델용 **대용량 LVM 볼륨**을 분리(XFS는 확장만 되고 축소 불가).
- 시간은 **사내 NTP**로 chrony 동기화(외부 pool 접근 불가).
- 빌드 도구 중 `gcc/make/kernel-devel/kernel-headers`는 DVD에 있으나 **`dkms`는 EPEL 전용 → 별도 반입** 또는 DKMS 없이 진행.
- 방화벽은 **11434를 포탈 서버 IP로만** 허용(전체 개방 금지), SELinux는 enforcing 유지.

---

## 2. NVIDIA A40 vGPU 게스트 드라이버 + 라이선스 (에어갭)

이 섹션은 **게스트 VM 안(Rocky Linux 9)** 에서 해야 하는 일만 다룬다. A40 카드의 물리 파티셔닝(48GB → 24GB 프로파일 2개), 하이퍼바이저(vSphere/KVM 등)에 vGPU Manager 설치, VM에 vGPU 프로파일 할당 같은 **호스트/하이퍼바이저 작업은 가상화 관리자 몫**이며 이 가이드 범위 밖이다. 다만 게스트 설치가 실패하는 원인의 대부분이 호스트-게스트 버전 불일치이므로, 아래 "0단계"를 반드시 먼저 확인하라.

> ⚠️ **이 섹션이 가이드 전체에서 가장 벤더-특정적이고 실패가 잦다.** 정확한 드라이버 버전·호환표·라이선스 절차는 **조직의 NVIDIA vGPU / NVIDIA AI Enterprise 엔타이틀먼트**와 **사용하는 하이퍼바이저**에 따라 달라진다. 아래에서 `[확인 필요]`로 표시한 지점은 단정하지 말고 반드시 조직 담당자/엔타이틀먼트로 확인하라. 버전 숫자(예: `595.91.07`, `18.x`)는 **전부 예시**이며 실배포 시 실제 반입한 패키지 버전으로 대체해야 한다.

### 2.0 사전 확인 체크포인트 (설치 전 필수)

| 항목 | 왜 중요한가 | 상태 |
|---|---|---|
| **하이퍼바이저 종류/버전** | 게스트 드라이버 패키지가 하이퍼바이저 계열마다 다르다(vSphere / KVM / Nutanix AHV 등) | `[확인 필요]` |
| **호스트 vGPU Manager 버전** | 게스트 드라이버는 이 버전과 **호환 브랜치**여야 한다(2.1 참고) | `[확인 필요]` |
| **할당된 vGPU 프로파일** | `A40-24C`(Compute) 인지 `A40-24Q`(RTX vWS) 인지에 따라 라이선스 FeatureType이 다르다(2.4) | `[확인 필요]` |
| **NVIDIA 라이선싱 포털(NLP) 접근** | 게스트 드라이버 `.run`은 일반 데이터센터 드라이버가 아니라 **엔타이틀먼트가 있어야 받을 수 있는 vGPU/AIE 게스트 드라이버**다 | `[확인 필요]` |
| **사내 DLS 어플라이언스 + 클라이언트 설정 토큰** | 에어갭에서는 인터넷 CLS 대신 사내 DLS로 라이선스를 받는다(2.4) | `[확인 필요]` |
| **UEFI Secure Boot 상태** | Secure Boot가 켜져 있으면 서명 안 된 커널 모듈 로드가 막혀 `.run` 설치가 실패한다. NVIDIA 문서는 (서명 인프라가 없으면) 비활성 권장 | `[확인 필요]` |

> LLM 추론(로컬 Ollama/Qwen) 용도라면 **연산(Compute) 성격의 C-series 프로파일(`A40-24C`)** 이 자연스럽다. 다만 배경 요청서에 언급된 "Q 프로파일"처럼 조직이 `A40-24Q`(RTX vWS)를 할당했을 수도 있다. 어느 쪽이든 CUDA 추론은 동작하지만 **라이선스 FeatureType 값이 달라진다**(2.4). 실제 할당된 프로파일 이름을 `nvidia-smi`로 확인한 뒤 맞춰라. `[확인 필요]`

---

### 2.1 게스트 드라이버는 "그리드/AIE 게스트 드라이버"다 (데이터센터 드라이버 아님)

- vGPU 게스트 드라이버 파일명은 보통 `NVIDIA-Linux-x86_64-<버전>-grid.run` 처럼 **`-grid`** 접미사가 붙는다. `.com`에서 누구나 받는 일반 데이터센터/Tesla 드라이버(`...-dc.run`)나 CUDA 리포지토리 드라이버로는 **vGPU가 라이선스 상태로 동작하지 않는다.**
- 게스트 드라이버는 **하이퍼바이저(호스트)의 vGPU Manager 버전과 호환**되어야 한다. NVIDIA 공식 호환 규칙 요약(출처: vGPU Release Notes):
  - vGPU Manager와 게스트 드라이버가 **같은 major 릴리스 브랜치**면 지원된다.
  - vGPU Manager가 게스트 드라이버보다 **한 브랜치(또는 한 LTS 브랜치) 최신**인 조합까지 지원된다.
  - 서로 다른 릴리스를 섞으면 **두 릴리스가 공통으로 지원하는 기능/OS까지만** 동작한다.
  - vGPU Manager가 게스트 드라이버보다 **2개 이상 major 브랜치 최신**이거나, 반대로 vGPU Manager가 게스트보다 **더 낮은** 경우는 **비호환**.
- 실무: **호스트 vGPU Manager 버전을 먼저 확인**(가상화 관리자에게)하고, 같은 vGPU 소프트웨어 릴리스 번들에 들어 있는 리눅스 게스트 `.run`을 반입하라. `[확인 필요 — 정확한 브랜치/버전은 조직 엔타이틀먼트에 의존]`

> ⚠️ 호스트-게스트 버전 불일치는 이 섹션 실패의 1순위 원인이다. `nvidia-smi`가 뜨더라도 라이선스/기능이 반쪽만 동작할 수 있으니 버전 조합을 먼저 맞춰라.

---

### 2.2 에어갭 반입물 준비 (인터넷 있는 곳에서 미리)

에어갭 게스트에서는 아래 파일들을 **미리 다운로드해 안전하게 반입(USB/승인된 파일 이동 경로)** 해야 한다. `curl | sh` 방식 온라인 설치는 게스트에 인터넷이 없어 **반드시 실패**한다.

| 반입물 | 출처 | 비고 |
|---|---|---|
| vGPU 리눅스 게스트 드라이버 `.run` | NVIDIA Licensing Portal(NLP) — 엔타이틀먼트 필요 | 호스트 vGPU Manager와 호환 버전(2.1). `[확인 필요]` |
| 클라이언트 설정 토큰 `client_configuration_token_*.tok` | 사내 **DLS 어플라이언스**에서 생성/다운로드 | 2.4에서 생성 방법 |
| (커널 모듈 빌드용) `kernel-devel`, `kernel-headers`, `gcc`, `make`, `dkms`, `openssl` RPM | 오프라인 로컬 미러 / 반입 RPM 세트 | 아래 참고 |

**커널 빌드 의존성 오프라인 설치** — `.run` 인스톤러는 커널 모듈을 그 자리에서 컴파일하므로 커널 헤더와 컴파일러가 있어야 한다. 반입한 RPM들을 한 디렉터리에 모아 설치한다:

```bash
# 현재 실행 중인 커널과 정확히 같은 버전의 kernel-devel 이 필요하다
uname -r                     # 예: 5.14.0-503.el9.x86_64
# 반입한 RPM 디렉터리에서 (인터넷 없이) 로컬 설치
sudo dnf install --disablerepo='*' \
  ./kernel-devel-$(uname -r).rpm \
  ./kernel-headers-$(uname -r).rpm \
  ./gcc-*.rpm ./make-*.rpm ./openssl-*.rpm ./dkms-*.rpm
```

> ⚠️ **`kernel-devel` 버전은 `uname -r`과 정확히 일치**해야 한다. 커널을 업데이트했다면 재부팅해 새 커널로 부팅한 뒤 그 버전의 `kernel-devel`을 설치하라. 불일치 시 `.run`이 모듈 빌드 단계에서 실패한다. NVIDIA 공식 설치 문서는 **컴파일러 툴체인 + 커널 헤더 + OpenSSL**(라이선스 취득에 필요)을 전제로 한다.

---

### 2.3 게스트 드라이버 설치 (Rocky Linux 9)

#### (1) nouveau 오픈소스 드라이버 블랙리스트

```bash
lsmod | grep nouveau        # 출력이 있으면 nouveau 가 로드된 상태
```

로드되어 있으면 블랙리스트 파일 생성:

```bash
sudo tee /etc/modprobe.d/blacklist-nouveau.conf >/dev/null <<'EOF'
blacklist nouveau
options nouveau modeset=0
EOF

# initramfs 재생성 (Rocky/RHEL 계열)
sudo dracut --force
sudo reboot
```

재부팅 후 다시 `lsmod | grep nouveau` 결과가 비어 있어야 한다.

#### (2) (해당 시) NVIDIA DRM KMS / Secure Boot 정리

- NVIDIA 문서는 설치 전 커널 옵션에서 `nvidia-drm.modeset=1` 제거를 권장한다(신규 설치 시 보통 해당 없음).
- **UEFI Secure Boot**가 켜져 있으면 서명 안 된 NVIDIA 모듈 로드가 막힌다. 서명 인프라(MOK 등)가 없다면 비활성 후 진행. `[확인 필요 — 조직 보안정책]`

#### (3) 설치 실행

멀티유저 텍스트 모드로 전환(X/디스플레이 매니저가 GPU를 잡고 있지 않게):

```bash
sudo systemctl isolate multi-user.target    # 또는: sudo init 3
```

반입한 `.run`에 실행 권한을 주고 root로 설치(파일명·버전은 **예시**):

```bash
chmod +x ./NVIDIA-Linux-x86_64-595.91.07-grid.run
sudo sh ./NVIDIA-Linux-x86_64-595.91.07-grid.run
```

- 설치 마법사에서 커널 모듈 빌드가 진행된다(그래서 2.2의 헤더/컴파일러가 필요).
- DKMS 등록 여부, `nvidia-xconfig`로 xorg.conf 갱신 여부를 물으면 환경에 맞게 선택한다. **헤드리스 LLM 서버 용도**라면 X 설정은 필요 없다(선택하지 않아도 CUDA/추론은 동작).
- 설치 후 재부팅:

```bash
sudo reboot
```

#### (4) 1차 검증 (드라이버 로드 확인)

```bash
nvidia-smi
```

- GPU 이름이 할당된 vGPU 프로파일로 표시되어야 한다(예: `NVIDIA A40-24Q` 또는 `GRID A40-24C`). `[확인 필요 — 실제 프로파일명]`
- 드라이버 버전이 반입한 `.run` 버전과 일치하는지 확인.
- 이 시점에는 **라이선스가 아직 "Unlicensed"** 일 수 있다. 라이선스 설정은 2.4에서 한다.

---

### 2.4 vGPU 라이선스 설정 — 에어갭(사내 DLS + 클라이언트 설정 토큰)

vGPU의 Q/C 프로파일은 **라이선스가 필요**하다. 에어갭에서는 인터넷 기반 CLS(Cloud License Service)를 못 쓰므로 **사내 DLS(Delegated License Service) 어플라이언스**를 두고, 거기서 만든 **클라이언트 설정 토큰**을 게스트에 반입한다. 토큰에는 DLS 서비스 인스턴스의 주소/포트가 서명되어 담겨 있어, 토큰만 올바른 위치에 두면 게스트가 자동으로 라이선스를 체크아웃한다(`gridd.conf`에 서버 주소를 직접 적을 필요 없음).

#### (1) DLS에서 토큰 생성 (라이선스 관리자 작업)

DLS 어플라이언스 웹 콘솔 → 해당 **Service Instance** 상세 → **Actions → Generate client configuration token → Download**. 생성된 `client_configuration_token_MM-DD-YYYY-HH-MM-SS.tok` 파일을 게스트로 반입한다. `[확인 필요 — 사내 DLS 구축·엔타이틀먼트]`

#### (2) 게스트에 토큰 배치

```bash
# 토큰 디렉터리는 드라이버 설치 시 생성됨. 없으면 만든다.
sudo mkdir -p /etc/nvidia/ClientConfigToken
sudo cp ./client_configuration_token_*.tok /etc/nvidia/ClientConfigToken/

# 권한: 소유자 rwx, 그룹/기타 read (NVIDIA 문서 기준 744)
sudo chmod 744 /etc/nvidia/ClientConfigToken/client_configuration_token_*.tok
sudo chown root:root /etc/nvidia/ClientConfigToken/client_configuration_token_*.tok
```

#### (3) `gridd.conf`에 FeatureType 설정

```bash
# 템플릿이 있으면 복사해서 시작
sudo cp /etc/nvidia/gridd.conf.template /etc/nvidia/gridd.conf   # 이미 있으면 생략
sudo vi /etc/nvidia/gridd.conf
```

`FeatureType` 값을 할당된 프로파일 종류에 맞게 설정한다(NVIDIA 정의):

| FeatureType | 의미 | 사용 상황 |
|---|---|---|
| `0` | Unlicensed | 라이선스 미사용 |
| `1` | NVIDIA vGPU (vApps 등) | 일반 vGPU |
| `2` | NVIDIA RTX Virtual Workstation (vWS) | **`A40-24Q`(Q) 프로파일** |
| `4` | NVIDIA vGPU for Compute (vCS) | **`A40-24C`(C) 프로파일 — 연산/추론 지향** |

```ini
# 예) A40-24C (Compute) 프로파일인 경우
FeatureType=4
```

> ⚠️ **FeatureType은 반드시 실제 할당된 프로파일/엔타이틀먼트와 일치**해야 한다. C-series(`A40-24C`)에 `2`를, Q-series(`A40-24Q`)에 `4`를 넣는 식으로 어긋나면 라이선스 체크아웃이 실패하거나 원치 않는 기능 세트로 붙는다. LLM 추론이 목적이면 통상 `4`(Compute)가 맞지만, **조직이 실제로 보유한 라이선스 종류**가 무엇인지 먼저 확인하라. `[확인 필요]`
> - 토큰 기반 NLS에서는 `gridd.conf`에 `ServerAddress`/`ServerPort`를 **직접 넣지 않는다**(토큰이 그 정보를 담고 있음).

#### (4) 라이선스 데몬 재시작

```bash
sudo systemctl restart nvidia-gridd
sudo systemctl status nvidia-gridd --no-pager
```

#### (5) 라이선스 상태 검증

```bash
nvidia-smi -q | grep -i -A2 license
# 또는 전체 라이선스 섹션 확인
nvidia-smi -q | sed -n '/vGPU Software Licensed Product/,/License Status/p'
```

- 정상이면 `License Status : Licensed` (또는 만료시각 포함) 로 표시된다.
- `gridd`가 남기는 로그도 참고:

```bash
sudo journalctl -u nvidia-gridd --no-pager | tail -n 30
```

> ⚠️ **라이선스 미획득 시 영향**: vGPU 라이선스를 못 받으면 NVIDIA 정책상 **성능이 제한(클럭/성능 저하)** 되거나 일정 유예 후 기능이 제약될 수 있어 LLM 추론 성능/가용성에 직접 영향을 준다. 정확한 제한 동작은 릴리스/프로파일에 따라 다르니 실환경에서 라이선스 취득 상태를 반드시 확인하라. `[확인 필요 — 정확한 미획득 시 동작은 벤더 릴리스에 의존]`

---

### 2.5 최종 검증 체크리스트 (다음 섹션으로 넘어가기 전)

```bash
# 1) 드라이버 로드 & 프로파일 인식
nvidia-smi

# 2) 라이선스 = Licensed
nvidia-smi -q | grep -i "License Status"

# 3) 메모리 = 약 24GB(vGPU 프로파일) 로 보이는지 (물리 48GB 아님)
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv

# 4) 데몬 상태
systemctl is-active nvidia-gridd
```

- `nvidia-smi`가 GPU를 보이고, `License Status: Licensed`, 메모리가 **24GB 프로파일 크기**로 나오면 다음 단계(CUDA 확인 → Ollama 설치)로 진행한다.
- CUDA 툴킷 설치/검증(`nvidia-smi`는 되지만 `cuda`가 별개)은 다음 섹션에서 다룬다. Ollama는 자체 번들 CUDA 런타임으로 동작할 수 있으나, 드라이버 레벨에서 GPU가 라이선스 상태로 보이는 것이 전제다.

> 이 섹션에서 하나라도 실패하면 **호스트 vGPU Manager ↔ 게스트 드라이버 버전 조합(2.1)** 과 **FeatureType/토큰(2.4)** 을 먼저 재점검하라. 이 두 가지가 게스트측 vGPU 실패의 대부분이다.

---

## 3. CUDA / 드라이버 검증 (툴킷 설치 불필요)

이 장은 별도 작업이 거의 없다. **핵심: CUDA Toolkit을 따로 설치하지 않는다** — Ollama 리눅스 tarball이 CUDA 런타임 라이브러리(`libcudart`/`libcublas` 등)를 `lib/ollama/`에 번들한다(§5.9). 게스트에 필요한 것은 **NVIDIA 드라이버(커널 모듈 + 사용자공간 라이브러리)** 뿐이고, 그건 §2에서 이미 설치했다.

검증만 한다:

```bash
# 1) 드라이버 로드 + vGPU 프로파일 인식(메모리가 24GB로 보여야 함, 물리 48GB 아님)
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv

# 2) 드라이버가 지원하는 CUDA 버전(우상단 'CUDA Version') — 툴킷 버전 아님
nvidia-smi

# 3) vGPU 라이선스 = Licensed (미획득 시 성능 제한 가능)
nvidia-smi -q | grep -i "License Status"
```

- A40은 Ampere(compute capability 8.6)이라 Ollama 요구사항(cc 5.0+, 드라이버 550+)을 충족한다. 단 **vGPU에서는 게스트 드라이버 버전이 호스트 vGPU Manager와 짝이 맞아야** 하므로 실제 버전은 배포 브랜치에 종속된다 `[확인 필요]`.
- `nvidia-smi`가 GPU를 못 보이거나 `License Status`가 `Unlicensed`이면 **§2.4(라이선스)와 §2.1(버전 조합)** 로 돌아간다. 여기서 막히면 이후 Ollama는 무조건 CPU 폴백된다.

---

## 4. 보안 · 방화벽 · 서비스 계정 (요약)

세부는 §1.7·§5.7에 분산돼 있고, 여기서 원칙만 모은다.

- **11434 외부 미개방**: 인증 없는 포트다. 토폴로지 A(동일 호스트)면 `127.0.0.1:11434` loopback만 → 방화벽 규칙 불필요. 토폴로지 B(원격 포탈)면 `0.0.0.0:11434` + **포탈 서버 IP만** firewalld rich rule 허용(§5.7).
- **SELinux enforcing 유지**: 끄지 말 것. 모델을 비표준 경로(`/data/...`)로 옮겨 접근 거부(AVC)가 나면 SELinux를 끄는 대신 `semanage fcontext`+`restorecon`으로 컨텍스트를 지정한다 `[확인 필요 — 실경로 AVC]`.
- **전용 비로그인 계정**: `ollama`(`useradd -r -s /bin/false`)로 서비스 구동(§5.3). root로 serve 금지.
- **데이터 무유출**: 포탈→LLM은 outbound HTTP 11434(`/api/generate`,`/api/tags`)뿐이고 실제 인프라 데이터는 프롬프트에 실리지 않는다(`docs/NETWORK-COMMS-FIREWALL.md:47,170`). 이 원칙을 깨는 프롬프트 변경(예: VM 원본 목록을 통째로 프롬프트에 삽입)은 하지 말 것.
- **SSH(22)**: 포탈 자동설치를 쓸 때만 포탈→게스트로 열린다. 상시 개방이 필요 없으면 설치 후 정책에 맞게 제한 `[확인 필요 — 조직 SSH 하드닝]`.

---

## 5. Ollama 오프라인 설치 + GPU 활성 + systemd

> **전제**: 4장까지 완료되어 게스트 VM(Rocky Linux 9)에 NVIDIA vGPU 게스트 드라이버가 설치되고 `nvidia-smi` 로 A40(24GB vGPU 프로파일)이 정상 인식된 상태. 이 장은 인터넷이 완전히 차단된 **에어갭** 환경을 전제로, 온라인 머신에서 Ollama 바이너리를 미리 받아 반입한 뒤 GPU 로 구동하는 절차를 다룬다.
>
> ⚠️ **버전 숫자는 모두 예시**다. 아래 `v0.32.15` 는 이 문서 작성 시점(2026-08) 확인한 최신 태그일 뿐이며, 실제 배포 때는 사내에서 검증한 버전으로 고정(pin)해서 반입하라.

---

### 5.1 왜 `install.sh` 를 쓸 수 없나 (에어갭 제약)

Ollama 공식 설치 방법인 원라이너:

```bash
# ❌ 에어갭에서는 실패한다 — ollama.com 으로 나가는 인터넷이 필요
curl -fsSL https://ollama.com/install.sh | sh
```

이 스크립트는 실행 시점에 `ollama.com`(HTTPS 443)에서 tarball 을 내려받는다. 인터넷이 차단된 DC 게스트에서는 curl 이 타임아웃/실패한다. 포탈의 자동설치(`ollamaDeploy.js`)도 `mode='online'` 은 내부적으로 이 스크립트를 호출하므로 **에어갭에서는 반드시 `mode='offline'`(미리 받은 tarball 전송)** 을 써야 한다. 이 장에서는 (A) 수동 설치와 (B) 포탈 SSH 자동설치 두 경로를 모두 다룬다.

---

### 5.2 온라인 머신에서 바이너리 확보

인터넷이 되는 별도 반출용 PC(사내 정책상 반입 승인된 매체 경유)에서 다음을 받는다.

```bash
# 1) 버전 고정해서 Linux x86_64 tarball 확보 (예시 버전 v0.32.15)
VER=v0.32.15
curl -fLO https://github.com/ollama/ollama/releases/download/${VER}/ollama-linux-amd64.tar.zst

# 2) 무결성 검증용 체크섬도 함께 확보
curl -fLO https://github.com/ollama/ollama/releases/download/${VER}/sha256sum.txt

# 3) 반입 전 해시 확인
grep 'ollama-linux-amd64.tar.zst' sha256sum.txt | sha256sum -c -
#   → ollama-linux-amd64.tar.zst: OK  이어야 한다
```

⚠️ **압축 포맷 변경(중요)**: 최근 릴리스(예: v0.32.x)의 Linux 자산은 **`ollama-linux-amd64.tar.zst`(zstd)** 다. 과거 버전(예: v0.5.x)은 **`ollama-linux-amd64.tgz`(gzip)** 였다. 릴리스마다 확장자가 다를 수 있으니 실제 자산명을 릴리스 페이지에서 확인하라. 이 차이는 뒤(5.6 포탈 자동설치)에서 문제가 되므로 반드시 인지할 것.

| 자산 이름 | 용도 |
|---|---|
| `ollama-linux-amd64.tar.zst` | 표준 x86_64 (NVIDIA/CPU). **A40 vGPU 는 이것** |
| `ollama-linux-amd64-rocm.tar.zst` | AMD ROCm GPU (해당 없음) |
| `ollama-linux-arm64.tar.zst` | ARM64 (해당 없음) |
| `sha256sum.txt` | 무결성 검증 |

반입 매체(승인된 USB/전송 시스템)로 `ollama-linux-amd64.tar.zst` 와 `sha256sum.txt` 를 게스트 VM 으로 옮긴다.

---

### 5.3 (경로 A) 게스트 VM 에 수동 설치

**1) zstd 준비.** 현재 tarball 은 zstd 압축이라 추출에 `zstd` 가 필요하다. GNU `tar` 는 zstd 매직을 자동 인식하지만, `zstd` 바이너리가 시스템에 있어야 한다. 에어갭이면 미리 반입한 로컬 미러/RPM 에서 설치한다.

```bash
# zstd 설치 여부 확인
command -v zstd || echo "zstd 없음 — 오프라인 리포지토리에서 dnf install zstd 필요"
# (예) 사내 로컬 미러가 구성돼 있으면
sudo dnf install -y zstd
```

**2) 반입 후 해시 재검증 → /usr 에 추출.** tarball 은 `bin/`(→ `/usr/bin/ollama`) 과 `lib/ollama/`(→ CUDA 런타임 등 번들 라이브러리) 를 담고 있어 `-C /usr` 로 풀면 표준 경로에 배치된다.

```bash
cd /path/to/반입폴더
# 반입 후 다시 한 번 무결성 확인
grep 'ollama-linux-amd64.tar.zst' sha256sum.txt | sha256sum -c -

# /usr 아래로 추출 (GNU tar 가 zstd 자동 인식)
sudo tar -C /usr -xvf ollama-linux-amd64.tar.zst
#   자동 인식이 안 되면 명시적으로:
#   zstd -dc ollama-linux-amd64.tar.zst | sudo tar -x -C /usr

# 설치 확인
/usr/bin/ollama --version
```

> ℹ️ 과거 `.tgz`(gzip) 버전을 쓴다면 추출 명령은 `sudo tar -C /usr -xzf ollama-linux-amd64.tgz` 다(zstd 불필요).

**3) 전용 서비스 계정 생성.** root 로 서비스를 돌리지 않도록 비로그인 전용 계정을 만든다(포탈 `ollamaDeploy.js:54` 와 동일한 관례).

```bash
sudo useradd -r -s /bin/false -U -m -d /usr/share/ollama ollama
# (선택) 관리자가 ollama 그룹으로 모델 파일에 접근하려면
sudo usermod -a -G ollama $(whoami)
```

---

### 5.4 대용량 모델 저장 경로 (`OLLAMA_MODELS`)

기본 모델 저장 위치는 **`/usr/share/ollama/.ollama/models`** 다(ollama 계정 홈). 루트 파일시스템이 작으면 24GB급 모델 blob 이 `/` 를 채운다. 별도 대용량 볼륨(예: `/data`)을 모델 경로로 지정하는 것을 권장한다.

```bash
# 대용량 볼륨에 모델 디렉터리 준비 + 소유권을 ollama 로
sudo mkdir -p /data/ollama/models
sudo chown -R ollama:ollama /data/ollama
sudo chmod 750 /data/ollama/models
```

이 경로는 다음 systemd 유닛의 `OLLAMA_MODELS` 로 넣는다. ⚠️ SELinux 가 enforcing 이면 비표준 경로(`/data/...`)에 서비스가 접근할 때 차단될 수 있다 → **확인 필요**(5.8 참조).

에어갭에서는 `ollama pull` 이 불가하므로, 모델 blob 은 6장(모델 반입) 절차대로 이 디렉터리 구조에 미리 심어 둔다. (모델 반입은 별도 장에서 다룸.)

---

### 5.5 systemd 서비스 유닛

`/etc/systemd/system/ollama.service` 를 아래 내용으로 작성한다. 공식 유닛(User/Group=ollama, Restart=always)을 기준으로, 우리 용도(로컬 전용 바인딩·대용량 모델 경로·모델 상주)에 맞게 `Environment` 를 보강했다.

```ini
[Unit]
Description=Ollama Service
After=network-online.target

[Service]
ExecStart=/usr/bin/ollama serve
User=ollama
Group=ollama
Restart=always
RestartSec=3

# --- 바인딩: 포탈이 같은 호스트면 로컬 전용(외부 노출 금지, 5.7 참조) ---
Environment="OLLAMA_HOST=127.0.0.1:11434"

# --- 모델 저장 경로를 대용량 볼륨으로 ---
Environment="OLLAMA_MODELS=/data/ollama/models"

# --- 모델 상주: 콜드스타트 지연 제거(전용 GPU VM이므로 상주 권장) ---
#     -1 = 무기한 상주, 0 = 즉시 언로드, 기본 5m
Environment="OLLAMA_KEEP_ALIVE=-1"

# --- 동시 처리 수(경량 JSON 의도추출이라 낮게; KV 캐시 VRAM 곱해짐) ---
Environment="OLLAMA_NUM_PARALLEL=2"

# --- 24GB 한 장에 큰 모델은 한 개만 상주시키는 편이 안전 ---
Environment="OLLAMA_MAX_LOADED_MODELS=1"

# --- (선택) KV 캐시 VRAM 절감 ---
Environment="OLLAMA_FLASH_ATTENTION=1"

# PATH 보존
Environment="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

[Install]
WantedBy=multi-user.target
```

적용:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ollama
sudo systemctl status ollama --no-pager
```

**주요 환경변수 표**(공식 FAQ/GPU 문서 기준):

| 변수 | 기본값 | 설명 / 우리 권장 |
|---|---|---|
| `OLLAMA_HOST` | `127.0.0.1:11434` | 바인딩 주소. **포탈이 같은 호스트면 127.0.0.1 유지**(외부 노출 금지). 원격 포탈이면 5.7 참조 |
| `OLLAMA_MODELS` | `/usr/share/ollama/.ollama/models` | 모델 저장 경로. 대용량 볼륨으로 이설 권장 |
| `OLLAMA_KEEP_ALIVE` | `5m` | 모델 메모리 상주 시간. `-1` 무기한, `0` 즉시 언로드. 상시 응답이면 `-1` 또는 `24h` |
| `OLLAMA_NUM_PARALLEL` | `1`(문서 기준, 버전에 따라 자동) | 모델당 동시 요청 수. 높이면 요청당 KV 캐시만큼 VRAM 추가 소모 |
| `OLLAMA_MAX_LOADED_MODELS` | `3` | 동시 상주 모델 수. 단일 24GB GPU 는 `1` 권장 |
| `OLLAMA_FLASH_ATTENTION` | `0`(비활성) | `1` 로 켜면 KV 캐시 메모리 절감(모델/GPU 지원 시) |

> ℹ️ `OLLAMA_NUM_PARALLEL` 기본값은 버전에 따라 "자동(메모리 여유에 따라 1 또는 4)" 로 동작한 이력이 있다. 실제 적용값은 기동 로그와 `ollama ps` 로 확인하라. → **확인 필요**

---

### 5.6 (경로 B) 포탈 SSH 자동설치와의 정합성 (`ollamaDeploy`)

포탈 설정 → AI 검색 → "Ollama 서버 자동설치(SSH)" 의 **offline 모드**는 중앙 포탈 서버 로컬의 `binaryPath` tarball 을 게스트로 SFTP 전송 후 다음을 실행한다(`ollamaDeploy.js:56-63`):

```bash
tar -C /usr -xzf /tmp/ollama-install.tgz     # ← -z (gzip) 고정
```

⚠️ **정합성 함정(중요)**: 이 명령은 `-z`(gzip) 로 **`.tgz` 를 가정**한다. 그런데 최신 Ollama 자산은 **`.tar.zst`(zstd)** 라 그대로 넣으면 `tar -xzf` 가 `not in gzip format` 로 실패한다("압축 해제 실패"). 대응 두 가지:

1. **gzip 으로 재포장**(권장 — 포탈 UI 그대로 사용). 온라인 머신에서:
   ```bash
   # zst → 순수 tar → gzip 으로 다시 포장 (내부 tar 구조는 동일)
   zstd -dc ollama-linux-amd64.tar.zst | gzip -9 > ollama-linux-amd64.tgz
   ```
   이 `.tgz` 를 포탈 서버 로컬에 두고 UI 의 `binaryPath`(placeholder `/root/ollama-linux-amd64.tgz`)에 지정한다.
2. **수동 설치(경로 A)** 로 끝내고, 포탈에서는 설치는 건너뛰고 `PUT /admin/llm-config` 로 `url`/`model`/`enabled` 만 지정.

또한 포탈 자동설치 유닛은 `OLLAMA_HOST=0.0.0.0:11434` 로 심는다(`ollamaDeploy.js:29,36`) — 이는 **포탈이 원격 호스트에서 접속**하기 위한 설정이다. 게스트와 포탈이 같은 호스트/터널이면 수동 설치(경로 A)로 `127.0.0.1` 을 유지하는 편이 보안상 낫다(5.7).

> 포탈 자동설치는 성공 시(`applyToPortal=true`) `llm.json` 을 `http://<host>:<port>` 로 자동 지정한다(`ollamaDeploy.js:84`). 에어갭이면 `model` pull 은 실패하므로 model 필드는 비우고, 모델은 6장 절차로 미리 반입한 뒤 UI 에서 model 명을 지정한다(`LlmSettings.jsx:109` 안내와 동일).

---

### 5.7 방화벽 / 보안 — 11434 외부 노출 금지

- **원칙**: `11434` 는 인증이 없는 로컬 추론 포트다. 절대 대외/사내 광역에 열지 않는다.
- **동일 호스트 배치(권장)**: 포탈과 Ollama 가 같은 VM 이면 `OLLAMA_HOST=127.0.0.1:11434` 로 loopback 만 바인딩한다. 이 경우 방화벽에 11434 인바운드 규칙 자체가 불필요하다.
- **원격 포탈이 접속해야 하면**: `OLLAMA_HOST=0.0.0.0:11434` 로 열되(포탈 자동설치가 하는 방식), **반드시 포탈 서버 IP 로만 소스 제한**한다. loopback 바인딩만으로는 원격 포탈이 못 붙으므로 이 경우에 한해 개방하고 firewalld 로 좁힌다:

```bash
# 포탈 서버 IP 만 11434 로 허용(예: 10.10.0.5)
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" \
  source address="10.10.0.5/32" port port="11434" protocol="tcp" accept'
# 그 외 11434 인바운드는 기본 정책(차단) 유지
sudo firewall-cmd --reload
sudo firewall-cmd --list-rich-rules
```

- **통신 문서 근거**: 포탈→Ollama 는 outbound HTTP 11434(`POST /api/generate`, `GET /api/tags`), 설치용 포탈→게스트 SSH 22 (`docs/NETWORK-COMMS-FIREWALL.md:47,170-171`). **실제 인프라 데이터는 포탈을 벗어나지 않고**, LLM 은 한국어 질문→JSON 해석에만 쓰인다.

---

### 5.8 GPU 활성 확인 (CPU 폴백 감지)

설치 후 **실제로 GPU 로 도는지** 반드시 검증한다. Ollama 는 GPU 를 못 잡으면 조용히 CPU 로 폴백하며, 이 경우 응답이 수 배~수십 배 느려진다.

**1) 기동 로그에서 GPU 인식 확인:**

```bash
journalctl -u ollama -b --no-pager | grep -iE 'gpu|cuda|library|compute'
```
- 정상: `inference compute ... library=cuda ...`, `NVIDIA ... total="24.0 GiB"` 유사 라인.
- 폴백: `no compatible GPUs were discovered` 또는 `library=cpu` → GPU 미인식.

**2) 모델 적재 후 배치 위치 확인(`ollama ps`):** 모델을 한 번 호출해 상주시킨 뒤:

```bash
# 로컬에서 가벼운 호출로 상주 트리거(모델명은 반입한 실제 태그로)
curl -s http://127.0.0.1:11434/api/generate \
  -d '{"model":"qwen2.5:7b-instruct","prompt":"ping","stream":false}' >/dev/null

ollama ps
```
- `PROCESSOR` 열이 **`100% GPU`** 여야 정상.
- `100% CPU` 또는 `48%/52% CPU/GPU` 처럼 분할되면 VRAM 부족(모델이 24GB 초과)이거나 GPU 미인식.

**3) `nvidia-smi` 에서 ollama 프로세스와 VRAM 점유 확인:**

```bash
nvidia-smi
# 하단 Processes 목록에 /usr/bin/ollama (또는 ollama runner) 가 있고
# GPU-Util / Memory-Usage 가 올라가면 GPU 사용 중.
watch -n1 nvidia-smi   # 호출 중 실시간 관찰
```

**폴백 원인 체크리스트:**

| 증상 | 흔한 원인 | 조치 |
|---|---|---|
| `library=cpu`, `ollama ps` 100% CPU | 드라이버 미인식/버전 낮음 | `nvidia-smi` 부터 확인. 드라이버 550+ 필요(5.9) |
| GPU/CPU 분할 | 모델이 24GB VRAM 초과 | 더 작은 모델/양자화 사용, `OLLAMA_MAX_LOADED_MODELS=1` |
| 서비스 계정만 GPU 못 봄 | `/data` 경로 SELinux 차단 | `ausearch -m avc -ts recent` 확인, 정책 조정 → 확인 필요 |
| 재부팅/서스펜드 후 미인식 | `nvidia_uvm` 모듈 문제 | `sudo rmmod nvidia_uvm && sudo modprobe nvidia_uvm` |

---

### 5.9 CUDA 런타임 의존성 — 무엇이 필요하고 무엇이 불필요한가

- **CUDA 런타임 라이브러리는 tarball 에 번들**된다. Linux tarball 은 `lib/ollama/`(추출 후 `/usr/lib/ollama/`) 아래에 `cuda_v12`/`cuda_v13` 등의 디렉터리로 `libcudart`, `libcublas`, `libggml-cuda` 를 포함한다 → **별도 CUDA Toolkit 설치가 불필요**하다.
- **필요한 것은 NVIDIA 드라이버(커널 모듈 + 사용자공간 라이브러리)뿐**이다. 공식 GPU 문서 기준 요구사항:
  - compute capability **5.0 이상** — **A40 은 Ampere, compute capability 8.6 으로 충분**.
  - 드라이버 **550 이상**(compute capability 5.0–6.2 구형은 570 이상). A40(8.6)은 550+ 로 충족되지만, vGPU 환경에서는 게스트 드라이버 버전이 vGPU 매니저(호스트)와 짝이 맞아야 하므로 실제 버전은 배포 브랜치에 종속 → **확인 필요**.

```bash
# 드라이버/CUDA 드라이버 API 버전 확인 (Toolkit이 아니라 드라이버가 제공)
nvidia-smi   # 우상단 'CUDA Version: xx.x' 는 드라이버가 지원하는 최대 버전 표기
```

> ⚠️ **vGPU 라이선싱(확인 필요)**: A40 24GB **vGPU 프로파일**에서 CUDA 연산은 NVIDIA vGPU 라이선스(AI Enterprise/vGPU 소프트웨어) 활성과 연산 지원 프로파일(C-series 등)이 전제다. 라이선스가 미활성이면 게스트 vGPU 가 성능 제한/연산 저하 상태로 떨어질 수 있다. 이는 조직 엔타이틀먼트에 따라 다르므로 GPU 준비 장(1~4장)에서 라이선스 서버(DLS/CLS) 연동과 `nvidia-smi -q | grep -i license` 상태를 반드시 확인할 것.

---

### 5.10 업그레이드 / 제거 (오프라인)

- **업그레이드**: 새 버전 tarball 을 동일 절차(5.2→5.3-2)로 반입해 `/usr` 에 덮어쓴 뒤 `sudo systemctl restart ollama`. 모델(`OLLAMA_MODELS`)은 그대로 유지된다.
- **제거**:
  ```bash
  sudo systemctl disable --now ollama
  sudo rm /etc/systemd/system/ollama.service
  sudo rm -f /usr/bin/ollama
  sudo rm -rf /usr/lib/ollama
  sudo userdel ollama          # 필요 시
  # 모델까지 지우려면: sudo rm -rf /data/ollama /usr/share/ollama
  ```

---

## 6. Qwen 모델 오프라인 반입 + 로딩 + 최적화

이 절은 인터넷이 차단된 온프렘 서버(Rocky Linux 9, A40 물리카드에서 잘라낸 **24GB vGPU 프로파일**)에서 Ollama 위에 Qwen 모델을 올리는 절차다. 앞 절에서 Ollama 바이너리는 이미 오프라인으로 설치되어 systemd `ollama.service`(User=`ollama`, `OLLAMA_HOST=0.0.0.0:11434`)로 떠 있다고 가정한다 — 이 값들은 포탈의 SSH 배포 스크립트(`server/src/llm/ollamaDeploy.js`)가 심는 것과 동일하다.

> ⚠️ **버전 표기 주의(정직 고지)**: 이 문서의 모델명(`qwen3.6`, `qwen3.8` 등)·태그·용량·컨텍스트 수치는 **집필 시점(2026-08) Ollama 공식 라이브러리 페이지에서 확인한 값의 예시**다. 필자의 모델 학습 컷오프(2026-01) 이후 릴리스라 **1차 코드/문서로 완전 교차검증하지 못했다.** Ollama 라이브러리는 태그와 용량이 수시로 바뀌므로, **반입 전 반드시 `https://ollama.com/library/qwen3.6/tags` 와 온라인 머신의 `ollama show <태그>` 로 실제 태그·양자화·용량을 재확인**하라. 아래 명령의 태그는 그대로 복사하지 말고 확인한 값으로 치환할 것.

---

### 6.1 모델 선정 — 24GB 예산에 맞추기

#### VRAM 예산 계산 (추정)
24GB vGPU에서 실제 모델이 쓸 수 있는 메모리는 24GB 전체가 아니다. 다음을 빼고 계산한다(값은 추정, 실측 필요):

- vGPU/드라이버·CUDA 컨텍스트 오버헤드: 대략 0.5~1.5GB
- KV 캐시(컨텍스트): `num_ctx`에 비례해 증가 — 아래 6.5 참조
- 여유 마진

실사용 가능 예산 ≈ **20~22GB**로 잡고 모델을 고른다. 이보다 큰 모델은 일부 레이어가 CPU로 오프로드되어 **토큰 생성이 수 배 느려진다**(에어갭이라 더 티가 남).

#### 권장 2안 (자연어 → JSON 의도추출 용도)

| 구분 | 태그(예시, 확인 필요) | 유형 | Q4_K_M 용량(예시) | 24GB 적합성 | 용도 |
|---|---|---|---|---|---|
| **품질안** | `qwen3.6:27b` | Dense 27B | ~17GB | 여유 있게 적재(가중치17GB + KV/오버헤드 여유) | 파싱 정확도 우선. 복잡한 한국어 지시·중의적 표현에 강함 |
| **속도안** | `qwen3:14b` 또는 `qwen3:8b` | Dense 14B / 8B | ~9.3GB / ~5.2GB | 매우 여유 | 단순 KO→JSON. 응답 지연 최소·동시요청 여유. Qwen3.6에 소형이 없으면 이전 세대 dense 사용 |

> Qwen3.6 계열은 확인 시점 공개 태그가 **`27b`(dense)** 와 **`35b`(실제로는 `35b-a3b` MoE)** 위주였다. 소형이 필요하면 이전 세대 dense인 `qwen3:8b`/`qwen3:14b`/`qwen3:4b`를 쓴다. 실제 사용 가능한 소형 태그는 `/library`에서 확인 필요.

#### ⚠️ 24GB에서 피해야 할 것
- **`qwen3.6:35b`(=`35b-a3b` MoE, Q4 ~24GB)**: 가중치만 24GB로 예산을 통째로 먹어 **KV 캐시/오버헤드 자리가 없다 → CPU 오프로드 → 느림.** MoE라 활성 파라미터(A3B=3B)가 작아 "돌면" 빠르지만, **24GB에는 다 안 올라간다.** 굳이 MoE로 속도를 원하면 더 작은 `qwen3:30b`(MoE, ~19GB, 확인 필요)가 24GB에 더 적합.
- **초대형 MoE `qwen3:235b`(~142GB) 제외 이유**: 총 파라미터가 커서 24GB는 물론 단일 서버 RAM 오프로드로도 **실용 속도가 안 나온다**(토큰/초가 대화형으로 못 쓸 수준). 이 포탈의 작업은 "한국어 한 문장 → 검색쿼리 JSON" 변환이라 **235B급 추론력이 전혀 필요 없다.** 27B dense로 충분하고도 남는다.

---

### 6.2 반입 방법 A — `OLLAMA_MODELS` 디렉터리 통째 tar (권장, 가장 단순)

온라인 머신에서 `ollama pull`로 blob+manifest를 받은 뒤 **모델 저장 디렉터리를 통째로** 에어갭 서버로 옮긴다. Ollama의 blob은 내용주소(sha256) 방식이라 디렉터리를 그대로 합쳐도 안전하다.

Ollama 모델 저장 경로(리눅스 systemd 설치, User=`ollama`): **`/usr/share/ollama/.ollama/models`** (하위 `blobs/`, `manifests/`). 이는 포탈 배포 스크립트가 만든 `useradd -d /usr/share/ollama ollama` 계정 홈 기준이다.

#### [온라인 머신] 모델 받고 압축
```bash
# 1) 목표 모델 pull (태그는 ollama.com/library/qwen3.6/tags 에서 확인한 값으로)
ollama pull qwen3.6:27b

# 2) 저장 경로 확인 (일반 사용자 설치면 ~/.ollama/models,
#    systemd 서비스 설치면 /usr/share/ollama/.ollama/models)
ollama list
MODELS_DIR="$HOME/.ollama"            # 서비스 설치면 /usr/share/ollama/.ollama

# 3) blobs + manifests 를 통째로 tar (models/ 의 부모에서 실행)
cd "$MODELS_DIR"
tar -czf /tmp/qwen3.6-27b.tgz models/blobs models/manifests

# 4) 무결성 해시 (반입 매체 검증용)
sha256sum /tmp/qwen3.6-27b.tgz | tee /tmp/qwen3.6-27b.tgz.sha256
```
`/tmp/qwen3.6-27b.tgz` 와 `.sha256` 를 **승인된 반입 매체**로 에어갭 서버에 전달한다.

#### [에어갭 서버, root] 적재
```bash
# 1) 무결성 확인
cd /tmp
sha256sum -c qwen3.6-27b.tgz.sha256

# 2) 서비스 정지 후 병합 해제 (models/ 아래로 합쳐짐 — blob은 내용주소라 안전)
systemctl stop ollama
tar -C /usr/share/ollama/.ollama -xzf /tmp/qwen3.6-27b.tgz

# 3) 소유권 원복 (ollama 유저가 읽어야 함)
chown -R ollama:ollama /usr/share/ollama/.ollama

# 4) 서비스 기동 및 목록 확인
systemctl start ollama
sudo -u ollama OLLAMA_HOST=127.0.0.1:11434 ollama list
# → qwen3.6:27b 가 보이면 성공
```

> ⚠️ **prune로 인한 blob 삭제 예방(확인 필요)**: 에어갭에서 Ollama가 blob을 "고아"로 오판해 지우는 사례 보고가 있다. systemd drop-in에 `Environment="OLLAMA_NOPRUNE=1"` 를 추가해두면 안전하다. (지원 여부/명칭은 설치한 Ollama 버전 릴리스 노트로 확인.)
> ```bash
> mkdir -p /etc/systemd/system/ollama.service.d
> printf '[Service]\nEnvironment="OLLAMA_NOPRUNE=1"\n' \
>   > /etc/systemd/system/ollama.service.d/noprune.conf
> systemctl daemon-reload && systemctl restart ollama
> ```

---

### 6.3 반입 방법 B — GGUF 파일 + Modelfile 로 `ollama create`

Hugging Face 등에서 받은 **GGUF 단일 파일**을 반입해 로컬에서 모델을 만든다. 양자화·시스템 프롬프트·컨텍스트를 Modelfile로 직접 통제할 수 있어 **파싱 전용 튜닝**에 유리하다.

#### [반입] GGUF 준비
온라인 망에서 목표 양자화의 GGUF를 내려받아(예: `qwen3.6-27b-q4_k_m.gguf`) 매체로 반입 후 서버의 예: `/opt/models/` 에 둔다. `ollama` 유저가 읽을 수 있어야 한다:
```bash
mkdir -p /opt/models
# (반입한 gguf를 /opt/models/ 로 복사)
chown -R ollama:ollama /opt/models
```

#### [에어갭 서버] Modelfile 작성 + create
```bash
cat > /opt/models/Modelfile <<'EOF'
FROM /opt/models/qwen3.6-27b-q4_k_m.gguf

# 파싱 작업 고정값
PARAMETER temperature 0
PARAMETER num_ctx 8192

# 추론(thinking) 억제 + JSON 전용 지시를 모델에 각인
SYSTEM """너는 요청을 검색쿼리 JSON으로만 변환하는 파서다. 설명·사고과정 없이 JSON만 출력한다. /no_think"""
EOF

sudo -u ollama OLLAMA_HOST=127.0.0.1:11434 \
  ollama create qwen3.6-27b-json -f /opt/models/Modelfile

sudo -u ollama OLLAMA_HOST=127.0.0.1:11434 ollama list
```

> ⚠️ **채팅 템플릿(확인 필요)**: Ollama는 대개 GGUF 메타데이터에서 아키텍처별 프롬프트 템플릿을 자동 인식한다. 하지만 커스텀/변환 GGUF는 템플릿이 비어 응답이 깨질 수 있다. 그럴 땐 Modelfile에 `TEMPLATE` 블록을 명시해야 한다 — Qwen3 계열의 정확한 chat template은 **해당 모델의 HF 카드/`tokenizer_config.json`** 에서 확인해 넣을 것. `ollama show qwen3.6:27b --modelfile` 로 공식 태그의 템플릿을 참고 복사하는 방법도 있다.

> ℹ️ **방법 A vs B**: A는 "공식 태그 그대로"가 필요할 때(포탈 `hasModel` 체크가 태그명을 그대로 비교 — 6.6 참조). B는 시스템 프롬프트·num_ctx를 각인한 **전용 파서 모델**을 만들 때. 둘 다 인터넷 없이 동작한다.

---

### 6.4 로딩 / 검증

#### (1) 대화형 스모크 테스트
```bash
sudo -u ollama OLLAMA_HOST=127.0.0.1:11434 \
  ollama run qwen3.6:27b "한 줄로 인사해줘"
```

#### (2) 포탈이 실제로 쓰는 경로와 동일한 검증 — `POST /api/generate` (format:json, temperature:0)
아래 바디는 포탈 클라이언트(`server/src/llm/ollama.js`)가 보내는 형태(`model`/`prompt`/`stream:false`/`format`/`options.temperature:0`)와 동일하다. 자연어 검색(`nlSearch.js`)은 항상 `format:'json'` 을 강제한다.
```bash
curl -s http://127.0.0.1:11434/api/generate -d '{
  "model": "qwen3.6:27b",
  "prompt": "다음 한국어 요청을 검색쿼리 JSON으로만 변환하라. 필드: entity, filters, sort, limit.\n요청: 폴란드 vCenter에서 CPU 사용률 높은 호스트 5개 보여줘",
  "stream": false,
  "format": "json",
  "options": { "temperature": 0 }
}'
```
기대 출력(예시 — 실제 스키마는 `nlSearch.js` 프롬프트가 정의):
```json
{"entity":"host","filters":{"vcenter":"폴란드"},"sort":{"field":"cpu","order":"desc"},"limit":5}
```

#### (3) 연결/모델 존재 확인 — `GET /api/tags` (포탈 [연결 테스트]와 동일)
```bash
curl -s http://127.0.0.1:11434/api/tags | grep -o '"name":"[^"]*"'
```
포탈의 `POST /admin/llm-test` 는 이 응답의 `models` 배열에 `cfg.model` 이 **정확히** 포함되는지로 `hasModel` 을 판정한다. 태그 문자열이 한 글자라도 다르면 "모델 없음"으로 뜬다(6.6).

---

### 6.5 최적화

#### (A) thinking(추론) 모드 끄기 — 파싱에는 불필요, 지연만 늘린다
Qwen3.x는 `<think>...</think>` 사고 블록을 내보내는 추론 모드가 있다. JSON 의도추출에는 불필요하고 **응답 지연·토큰만 늘린다.** 끄는 수단(신뢰도 순):

1. **`format:"json"` 이 이미 방어막** — 포탈 자연어 검색은 JSON 문법으로 출력을 제약하므로 사고 블록이 끼어들 여지가 사실상 없다. 이 경로는 별도 조치 없이도 대체로 안전(핵심).
2. **CLI/디버깅**: `ollama run <model> --think=false "..."`
3. **API**: 최신 Ollama의 `/api/generate`·`/api/chat` 은 최상위 `"think": false` 필드를 받는다. **단, 포탈은 이 필드를 보내지 않는다**(`ollama.js` 바디에 없음, `config.js` 저장 화이트리스트에도 없음). 따라서 포탈을 거치는 호출에서 확실히 끄려면 아래 4를 쓴다.
4. **모델에 각인(포탈 통합 시 권장)**: 방법 B(6.3)처럼 `SYSTEM` 에 `/no_think` 를 넣은 **전용 모델**을 만들어 포탈 `model` 로 지정. 자유형식 경로인 **ChatOps(`chatops.js`, format 없음)** 에서 특히 효과.

> ⚠️ **`PARAMETER think false` 는 버전 의존(확인 필요)**: Modelfile에 `PARAMETER think false` 를 넣는 기능 요청이 올라와 있으나(ollama/ollama #14809), 설치한 버전에서 지원 안 될 수 있다. 또한 `enable_thinking=false` 를 넘겨도 여전히 thinking으로 들어가고 매 추론마다 `/no_think` 를 붙여야 확실했다는 보고가 있다. **설치 버전에서 `ollama run --think=false` 와 `SYSTEM /no_think` 각인을 직접 테스트해 확인**하라.

#### (B) 양자화 선택
| 양자화 | 27B 용량(예시) | 24GB 적합 | 비고 |
|---|---|---|---|
| **Q4_K_M** | ~17GB | ✅ 권장 | 크기/품질 균형. JSON 파싱엔 이 정도로 충분 |
| Q8_0 | ~30GB | ❌ | 24GB 초과 → CPU 오프로드 |
| fp16/bf16 | ~56GB | ❌ | 논외 |

파싱 작업은 출력 공간이 좁은 구조화 태스크라 Q4_K_M의 품질 손실 영향이 작다. **"작은 모델 고품질 양자화(예: 14B Q8) vs 큰 모델 저품질 양자화(27B Q4)"** 중 이 용도에선 27B Q4가 무난. 실제 정확도는 대표 프롬프트 20~30개로 A/B 비교 권장.

#### (C) 컨텍스트 길이(`num_ctx`) ↔ VRAM 트레이드오프
- KV 캐시 VRAM은 `num_ctx` 에 거의 선형 비례. 27B에서 4k→32k로 키우면 수 GB가 추가로 든다(정확치는 레이어/헤드 수·KV 양자화에 따라 다름 — 추정).
- **이 포탈의 프롬프트는 짧다**(한국어 한두 문장 + 스키마 지시). `num_ctx` 를 크게 잡을 이유가 없다. **4096~8192 권장.** 모델 기본 컨텍스트가 256K라도 실제 로드 시엔 `num_ctx` 만큼만 KV를 잡는다.
- Modelfile `PARAMETER num_ctx 8192` 로 고정하거나(방법 B), `/api/generate` 의 `options.num_ctx` 로 지정. **큰 num_ctx = VRAM 낭비 + 모델 적재 실패/오프로드**의 흔한 원인이니 필요 최소로 둘 것.
- (선택) KV 캐시 양자화(`OLLAMA_KV_CACHE_TYPE=q8_0` 등)로 컨텍스트당 VRAM을 줄일 수 있음 — 지원/명칭은 설치 버전 확인 필요.

---

### 6.6 포탈(The.DVC) 연동 체크포인트

1. **모델 태그 정확 일치**: 포탈 설정 → AI 검색의 `model` 값은 `ollama list` 에 뜨는 문자열과 **완전히 동일**해야 한다(`hasModel = models.includes(cfg.model)`). 방법 A면 `qwen3.6:27b`, 방법 B로 만든 전용 모델이면 `qwen3.6-27b-json`.
2. **URL**: 포탈이 원격 접속하므로 `http://<서버IP>:11434`(로컬 동일 호스트면 `http://127.0.0.1:11434`). 서비스는 이미 `OLLAMA_HOST=0.0.0.0:11434` 로 리슨.
3. **저장 경로**: 포탈 `PUT /admin/llm-config` 로 `enabled/url/model/timeoutMs` 저장(`llm.json`, 0600). SSH 자동설치를 썼다면 `applyToPortal` 이 `llm.json` 을 자동 지정.
4. **타임아웃**: 27B가 첫 요청에 콜드로드(수 초~수십 초) 될 수 있어 `timeoutMs` 를 넉넉히(예: 60000). 상시 사용이면 Ollama keep-alive로 상주시켜 콜드로드 회피(설정 확인 필요).
5. **폴백 안전망**: LLM 비활성/오류 시 자연어 검색은 규칙기반 `fallbackParse` 로 자동 폴백하므로, 모델 검증 전에도 포탈 검색 자체는 죽지 않는다.

---

## 7. 포탈(The.DVC) 연동

이 장은 코드로 확인한 **실제 연동 계약**에 근거한다(파일:라인 인용). 좋은 소식: **코드 변경 없이 설정 3필드만** 바꾸면 이 LLM 서버가 붙는다.

### 7.1 설정의 진실의 원천 — `CONFIG_DIR/llm.json`

포탈은 LLM 설정을 `CONFIG_DIR/llm.json`에 저장한다([config.js:11](server/src/llm/config.js#L11)). 저장 필드는 정확히 5개만 화이트리스트된다([config.js:30](server/src/llm/config.js#L30)):

| 필드 | 기본값 | 의미 |
|---|---|---|
| `enabled` | `false`(`LLM_ENABLED==='true'`) | LLM 사용 여부. false면 규칙기반만 |
| `provider` | `'ollama'` | 고정 |
| `url` | `http://localhost:11434` | **이 LLM 서버 주소** |
| `model` | `'llama3.1'` | **반입한 Qwen 태그로 교체** |
| `timeoutMs` | `30000` | 27B 콜드로드 대비 넉넉히(예 60000) |

- env(`OLLAMA_URL`/`OLLAMA_MODEL`/`LLM_ENABLED`/`LLM_TIMEOUT_MS`)는 **파일이 없을 때의 폴백**일 뿐, `llm.json`이 있으면 파일이 우선한다. 즉 **코드 상수가 아니라 이 파일이 진실의 원천**이다.

### 7.2 화면에서 붙이는 절차 — 설정 → AI 검색

[LlmSettings.jsx](web/src/views/LlmSettings.jsx) (관리자, adminOnly):

1. 상단 카드에서 **Ollama 주소**(`url`)를 이 서버로: 동일 호스트면 `http://127.0.0.1:11434`, 원격이면 `http://<LLM서버IP>:11434`.
2. **모델**(`model`)을 §6에서 반입한 **정확한 태그**로 입력(예: `qwen3.6:27b` 또는 전용모델 `qwen3.6-27b-json`).
3. **'사용'(enabled) 체크** → **[저장]**(`PUT /admin/llm-config`).
4. **[연결 테스트]**(`POST /admin/llm-test`) → 내부적으로 `GET /api/tags`를 호출해 `연결 성공(ms) · 모델 N개 · '<model>' 있음/없음`을 보여준다.

> ⚠️ **모델 태그 정확 일치**: 포탈은 `hasModel = models.includes(cfg.model)`로 판정([ollama.js:30](server/src/llm/ollama.js#L30)). `ollama list`에 뜨는 문자열과 **한 글자라도 다르면 "없음"** 이고, 그 경우 자연어 검색은 조용히 규칙기반 폴백으로만 동작한다(에러 아님).

### 7.3 (선택) SSH 자동설치와의 정합성 — 에어갭 주의

하단 "Ollama 서버 자동설치(SSH)"는 [ollamaDeploy.js](server/src/llm/ollamaDeploy.js)를 호출한다. **에어갭에서 반드시 알 것**:

- **online 모드 불가**: `curl https://ollama.com/install.sh | sh`(deploy.js online 경로)와 `ollama pull`은 인터넷이 필요 → 에어갭에서 실패. 반드시 **offline 모드**(로컬 tarball을 SFTP 전송)를 쓴다.
- **tgz vs zst 함정**: 스크립트는 `tar -C /usr -xzf ...`로 **gzip(.tgz)** 를 가정한다([ollamaDeploy.js:56-63]). 최신 Ollama 자산은 `.tar.zst`(zstd)라 그대로 넣으면 "압축 해제 실패". → 온라인 머신에서 **gzip으로 재포장**해 반입: `zstd -dc ollama-linux-amd64.tar.zst | gzip -9 > ollama-linux-amd64.tgz` (§5.6).
- 자동설치는 `OLLAMA_HOST=0.0.0.0:11434`를 심고(원격 포탈 접속용), 성공 시 `applyToPortal`이 `llm.json`을 자동 지정한다. 동일 호스트 배치면 자동설치 대신 **§5 수동설치로 `127.0.0.1` 유지**가 보안상 낫다.

### 7.4 연동 검증 & 폴백 안전망

- 포탈 [연결 테스트]가 `'<model>' 있음`이면 완료. 실제 추론 경로는 §6.4의 `POST /api/generate`(format:json)로 이미 검증했다.
- **폴백**: `enabled=false`이거나 LLM 호출이 실패하면 자연어 검색은 규칙기반 `fallbackParse`로 자동 전환된다([nlSearch.js:150-163]). 즉 모델을 붙이기 전에도, 붙인 뒤 장애가 나도 **포탈 검색 자체는 죽지 않는다.**
- 헬스: 포탈 상태 화면의 'AI(LLM)' 항목이 `loadLlmConfig()` 기준으로 표시된다([health/services.js:106]).

---

## 8. 통합 검증 · 트러블슈팅 · "확인 필요" 체크리스트

### 8.1 End-to-End 스모크 테스트 (위→아래 순서로 하나라도 실패하면 그 장으로)

```bash
# [OS]   Rocky 9 / 리포(DVD만) / 시간 동기화
cat /etc/rocky-release; dnf repolist; timedatectl | grep -i synchronized

# [GPU]  드라이버 + vGPU 라이선스 + 24GB 인식               (실패 → §2)
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv
nvidia-smi -q | grep -i "License Status"        # Licensed 여야 함

# [Ollama] 서비스 기동 + API 응답                            (실패 → §5)
systemctl is-active ollama
curl -s http://127.0.0.1:11434/api/tags | grep -o '"name":"[^"]*"'

# [GPU 실사용] 모델 상주 후 100% GPU 확인                    (CPU면 §5.8)
curl -s http://127.0.0.1:11434/api/generate -d '{"model":"<태그>","prompt":"ping","stream":false}' >/dev/null
ollama ps        # PROCESSOR 열이 100% GPU 여야 정상

# [포탈 경로] format:json 추론(포탈이 실제로 쓰는 형태)       (실패 → §6.4)
curl -s http://127.0.0.1:11434/api/generate -d '{"model":"<태그>","prompt":"다음 한국어를 검색쿼리 JSON으로만: 폴란드 vCenter CPU 높은 호스트 5개","stream":false,"format":"json","options":{"temperature":0}}'

# [포탈 연동] 설정→AI검색 [연결 테스트]에서 '<태그>' 있음 확인 (§7)
```

### 8.2 트러블슈팅 빠른표

| 증상 | 원인 후보 | 조치(장) |
|---|---|---|
| `nvidia-smi` 안 보임 | 드라이버 미설치 / nouveau / Secure Boot 서명 | §2.3 |
| `License Status: Unlicensed` | DLS 토큰/FeatureType 불일치 | §2.4 |
| `ollama ps`가 100% CPU | GPU 미인식 / 모델 24GB 초과 | §5.8, 더 작은 모델(§6.1) |
| `tar ... not in gzip format` | zst를 tgz로 넣음 | gzip 재포장(§5.6/§7.3) |
| 포탈 "모델 없음" | 태그 문자열 불일치 | `ollama list`와 정확히 일치(§7.2) |
| 첫 요청만 느림 | 콜드로드 | `OLLAMA_KEEP_ALIVE=-1`(§5.5), `timeoutMs`↑(§7.1) |
| blob이 사라짐 | 에어갭 prune 오판 | `OLLAMA_NOPRUNE=1`(§6.2) |
| 응답에 `<think>` 섞임 | Qwen 추론 모드 | `format:json`+`/no_think` 각인(§6.5) |

### 8.3 통합 "확인 필요" 체크리스트 (조직/엔타이틀먼트 의존 — 착수 전 확정)

**A. NVIDIA vGPU / 라이선스 (가장 실패 잦음)**
- [ ] 하이퍼바이저 종류/버전, **호스트 vGPU Manager 버전** → 호환되는 **게스트 드라이버 버전** 확정(본문 `595.91.07` 등은 예시)
- [ ] 할당 프로파일이 **A40-24C(Compute, FeatureType=4)** 인지 **A40-24Q(vWS, FeatureType=2)** 인지 (`nvidia-smi`로 확인)
- [ ] NVIDIA Licensing Portal 접근 엔타이틀먼트(vGPU 게스트 드라이버 `.run` 수령 가능?)
- [ ] 사내 **DLS 어플라이언스** 구축 + 클라이언트 설정 토큰 생성 권한
- [ ] **UEFI Secure Boot** 상태(켜져 있으면 모듈 서명/MOK 필요 → 없으면 비활성)
- [ ] Rocky 9가 해당 vGPU 릴리스의 게스트 OS 지원 매트릭스에 포함되는지

**B. OS / 에어갭 인프라**
- [ ] **dvd(전체) ISO** 확보 + GPG 키 경로(`RPM-GPG-KEY-Rocky-9`) 실제 파일명
- [ ] **사내 NTP** 서버 IP (없으면 하이퍼바이저 시간 동기화 여부)
- [ ] **EPEL `dkms`+의존성** 오프라인 확보(또는 DKMS 없이 커널 고정 운용)
- [ ] 커널 버전 고정 정책(커널·kernel-devel·NVIDIA 드라이버는 한 세트로 반입)
- [ ] SSH/root 로그인 등 조직 하드닝 표준

**C. Ollama / 모델**
- [ ] 반입 Ollama 버전의 자산 확장자(**.tar.zst vs .tgz**) 확인 → 포탈 자동설치 쓰면 gzip 재포장
- [ ] tarball 내부에 `lib/ollama` CUDA 런타임 포함(`tar -tf`로 확인)
- [ ] 최신 Qwen **실제 태그·양자화·용량**을 `ollama.com/library/.../tags` + `ollama show`로 재확인
- [ ] 24GB 실적재 VRAM·`num_ctx`별 KV 캐시를 `ollama ps`/`nvidia-smi`로 실측
- [ ] 설치 버전에서 `--think=false`/`SYSTEM /no_think`·`OLLAMA_NOPRUNE`·`OLLAMA_KV_CACHE_TYPE` 지원 여부 테스트
- [ ] GGUF 임포트 시 Qwen3 chat template 자동 인식 여부(안 되면 `TEMPLATE` 명시)

### 8.4 출처 (공식 우선 — 블로그는 참고)

- Rocky/EPEL: docs.rockylinux.org · rockylinux.org/download · docs.fedoraproject.org/en-US/epel
- NVIDIA vGPU/라이선스: docs.nvidia.com/vgpu · docs.nvidia.com/license-system
- Ollama: docs.ollama.com(linux·faq·gpu·import) · github.com/ollama/ollama/releases
- Qwen: ollama.com/library/qwen3.6(및 /tags) · Qwen 공식 GitHub/HF
- ⚠️ 'Qwen3.8' 등 최신 계열의 정확한 명칭/태그는 공식으로 완전 확인되지 않았고 일부는 블로그 출처다 — 반입 전 `/library`에서 직접 확인.

---

### 부록. 이 가이드의 다음 단계

이 서버가 준비되면, 앞서 설계한 **자연어 → 인프라 추가(규칙 파서 + LLM 폴백)** 를 이 LLM에 얹으면 된다. 규칙 파서는 GPU 없이 CPU로 1차 처리하고, 이 A40 LLM은 자유 표현/모호한 문장의 2차 폴백으로 쓰는 하이브리드가 이 하드웨어를 가장 잘 활용한다.
