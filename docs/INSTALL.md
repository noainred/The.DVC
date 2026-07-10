# 설치 가이드 (The Davinci Virtual Platform)

전 세계 분산 vCenter/베어메탈 인프라를 통합 관리하는 포탈의 설치 가이드입니다.
소규모 **단독(standalone)** 부터 **중앙(central) 포탈 1대 + 데이터센터별 엣지/수집 서버**까지 확장합니다.

- 대상 OS: **Rocky Linux 9 / RHEL 9 / AlmaLinux 9 / CentOS Stream 9** (에어갭/오프라인). Windows 수집기는 [README-WINDOWS](../packaging/windows/README-WINDOWS.md).
- 오프라인 패키지 빌드/업그레이드 등 상세 메커니즘: **[OFFLINE-INSTALL.md](../packaging/offline/OFFLINE-INSTALL.md)**.
- 포탈과 에이전트(엣지/수집기)는 **같은 프로그램**입니다. 환경변수로 역할이 정해집니다.

---

## 0. 사전 요구사항

| 항목 | 최소 | 권장(중앙, 28+ vCenter) |
|---|---|---|
| OS | RHEL9 계열(Rocky/Alma/CentOS Stream 9) x86_64 | 동일 |
| CPU | 2 vCPU | 4~8 vCPU |
| RAM | 2 GB | 8 GB+ |
| 디스크 | 5 GB | 20 GB+ (전력/지표 시계열 DB 보존) |
| 권한 | 설치에 `sudo`(root) | 동일 |
| 런타임 | **불필요** — 오프라인 패키지에 Node.js 런타임이 **포함**됨 | 동일 |

- 방화벽에서 포탈 포트(**기본 4000/tcp**)를 열어야 합니다(§6).
- 인터넷이 없어도 됩니다(에어갭). 자동 업그레이드만 사내 미러 또는 GitHub 릴리스가 필요합니다(§8).
- 설치물 배치: 앱 `/opt/vmware-portal/app` · 런타임 `/opt/vmware-portal/runtime/node` · **설정/DB `/etc/vmware-portal`**(업그레이드해도 보존) · 서비스 계정 `vmportal` · systemd 서비스 `vmware-portal`.

---

## 1. 구성 형태 선택

| 구성 | 언제 | 필요한 토큰 |
|---|---|---|
| **단독(standalone)** | vCenter가 중앙에서 직접 도달 가능, 소규모 | 없음 |
| **중앙 + 엣지(site)** | 고RTT/폐쇄망 DC의 vCenter를 현장에서 수집해 push | `CENTRAL_TOKEN` |
| **중앙 + 수집기(collector)** | DC의 iDRAC/OME **전력**을 현장에서 모아 중앙이 pull | `COLLECTOR_TOKEN` |

> 대규모(27개 DC)에서는 보통 **중앙 1대 + DC마다 엣지(겸 수집기) 1대**를 둡니다. 한 엣지 서버가
> `CENTRAL_*`(인벤토리/베어메탈 push)와 `COLLECTOR_*`(전력 export)를 **동시에** 가질 수 있습니다.

```
              ┌─────────────────────────── 중앙(OC2) 포탈 ───────────────────────────┐
   엣지(Seoul) ──push 인벤토리/베어메탈──▶  /api/central/inventory · /api/central/fleet
   엣지(Poland)─push─────────────────────▶  (CENTRAL_TOKEN 인증)
   수집기(각 DC)◀──pull 전력 export───────  /api/collector/export  (COLLECTOR_TOKEN 인증)
              └──────────────────────────────────────────────────────────────────────┘
```

---

## 2. 중앙(central) 포탈 설치

### 2.1 패키지 설치 (오프라인)

```bash
# 1) 오프라인 패키지 전송·해제
tar -xzf vmware-portal-offline-<버전>-el9-x64.tar.gz
cd vmware-portal-offline-<버전>-el9-x64

# 2) 설치(루트) — Node 런타임·앱·systemd 서비스까지 자동 구성
sudo ./install.sh --port 4000
```

설치가 하는 일: 번들 Node를 `/opt/vmware-portal/runtime/node`에, 앱을 `/opt/vmware-portal/app`에 배치하고,
`/etc/vmware-portal/portal.env`(없으면 예시에서 생성)에 **`AUTH_SECRET`을 자동 생성**·`PORT`를 반영한 뒤,
`vmportal` 계정으로 `vmware-portal` 서비스를 등록·기동합니다.

### 2.2 최초 로그인 (중요 — v2.152.0부터 기본 비번 방식 변경)

브라우저에서 `http://<중앙 IP>:4000` 접속. 계정은 **admin**, 비밀번호는:

- **`DEFAULT_ADMIN_PASSWORD`를 미리 설정했다면** 그 값.
- **미설정(기본)** 이면 최초 기동 시 **임의 비밀번호가 생성되어 파일에 저장**됩니다:
  ```bash
  sudo cat /etc/vmware-portal/initial-admin-password.txt
  ```
  이 값으로 로그인 → **설정 → 사용자 관리에서 즉시 변경** → 그 파일 삭제(`sudo rm`).

> 예전 문서의 `admin/admin123` 고정 기본값은 **보안상 폐지**되었습니다(알려진 기본 비번 제거).
> 무인 배포로 비번을 고정하려면 설치 전에 `portal.env`에 `DEFAULT_ADMIN_PASSWORD=<강력한값>`을 넣으세요.

### 2.3 중앙 환경설정

`sudo vi /etc/vmware-portal/portal.env` 후 `sudo systemctl restart vmware-portal`:

```ini
PORT=4000
DATA_SOURCE=live                       # 실제 vCenter (데모/시연은 mock — §9)
VC_TLS_REJECT_UNAUTHORIZED=false       # 자체서명 vCenter 인증서 허용

# 엣지 에이전트 push를 받으려면(중앙 역할):
CENTRAL_TOKEN=<강력한-공유-토큰-1>     # 엣지 인증용. 모든 엣지와 동일 값
COLLECTOR_PULL_INTERVAL_MS=60000       # 수집기 전력 pull 주기(0이면 비활성)
```

### 2.4 설치 검증

```bash
systemctl status vmware-portal                 # active (running) 확인
curl -s http://localhost:4000/api/health       # {"ok":true,"version":"<버전>", ...}
journalctl -u vmware-portal -n 30 --no-pager   # 기동 로그(오류 없는지)
```

브라우저 로그인까지 되면 중앙 설치 완료입니다.

### 2.5 vCenter 등록

포탈 로그인 → **설정 → vCenter 관리 → 추가**. 고RTT DC는 **수집 방식 = 사이트 위임(site)** 으로
두고 해당 엣지가 push하게 합니다(§3).

---

## 3. 엣지(현장) 포탈 설치

DC 현장 서버에 **같은 패키지**를 설치(2.1과 동일)한 뒤, 환경설정에서 **중앙으로 push**하도록 만듭니다.

```ini
PORT=4000
DATA_SOURCE=live
VC_TLS_REJECT_UNAUTHORIZED=false

# 이 서버를 '엣지(에이전트)'로 — 중앙으로 push:
AGENT_NAME=Seoul-DC1                   # 이 DC/에이전트 이름(중앙 화면 표시·매칭 키)
CENTRAL_URL=http://<중앙 IP>:4000      # 중앙 포탈 주소(끝에 / 없이)
CENTRAL_TOKEN=<강력한-공유-토큰-1>     # 중앙의 CENTRAL_TOKEN과 동일

AGENT_PUSH_INVENTORY=true              # vCenter 인벤토리(hosts/vms/...) push
# AGENT_PUSH_FLEET=false               # 베어메탈 push 끄기(기본 on) — 끌 때만 설정
AGENT_SCAN_INTERVAL_MS=3600000         # 위임 iDRAC/IP 스캔 주기(기본 1시간)
AGENT_AUTO_REGISTER=true               # 발견 iDRAC 로컬 자동 등록
```

> **간편 통합 엣지 모드**: 위 개별 변수 대신 아래 3개만으로 전 기능(수집 export·위임 스캔/핑/로그
> 워커·인벤토리 push·자동 업그레이드·부팅 시 중앙 자동 등록)이 켜집니다.
> ```ini
> EDGE_MODE=all
> CENTRAL_URL=http://<중앙 IP>:4000
> EDGE_TOKEN=<공유토큰>     # CENTRAL_TOKEN/COLLECTOR_TOKEN 역할을 겸함
> ```

- 엣지는 자기 DC의 vCenter를 **로컬에서 수집**해 중앙으로 보냅니다(중앙↔원격 RTT 제거).
- 통신은 **엣지 → 중앙 단방향 아웃바운드**라 폐쇄망/NAT에 유리합니다.
- 등록 후 중앙 **vCenter 관리**에서 해당 vCenter를 **사이트 위임**으로 설정해야 push가 반영됩니다.

### 3.1 (선택) SSH 자동 배포 — 중앙에서 엣지를 원격 설치

수동 설치 대신, 중앙 포탈에서 대상 호스트에 SSH로 **원클릭 설치**할 수 있습니다:
**특수 기능/설정 → 에이전트 배포 → 에이전트 추가/변경** 에서 SSH 접속정보 + 에이전트 설정을 입력하고
**🌐 올인원 자동 채우기**로 값을 채운 뒤 **배포 + 설치**. 중앙이 오프라인 패키지를 SFTP 전송 →
`install.sh` 실행 → `portal.env` 주입 → 서비스 재시작까지 자동 수행합니다. 저장된 대상은
**에이전트 현황** 탭에서 재배포·상태확인·편집·삭제할 수 있습니다.

---

## 4. 수집기(collector) — iDRAC/OME 전력

현장 서버가 자기 DC의 **iDRAC/OME 전력**을 모으고, **중앙이 pull**합니다.

### 4.1 에이전트(192.168.x.x) 측 설정

```ini
COLLECTOR_TOKEN=<강력한-공유-토큰-2>   # 직접 정하는 공유 비밀(openssl rand -hex 32)
COLLECTOR_DATACENTER=Seoul-DC1
```

`sudo systemctl restart vmware-portal` 후, 그 서버의 포탈 **설정 → 전력 수집(iDRAC 서버 등록)** 에서 로컬 iDRAC/OME를 등록합니다.

### 4.2 중앙 측 등록

중앙 포탈 **설정 → 수집 서버(원격) → 수집 서버 추가**:
- **수집 서버 URL**: `http://<에이전트 IP>:4000` (NAT/포트포워딩이면 도달 가능한 주소:포트)
- **토큰**: 위 `COLLECTOR_TOKEN`과 **동일한 값** → **연결 테스트** → **저장**.
- 등록 후 **귀속 vCenter** 드롭다운으로 그 수집기의 호스트를 특정 법인(vCenter)에 매핑할 수 있습니다.
- 관리자가 URL/토큰을 저장하면 **🔒 고정(managed)** 되어 엣지 자기등록이 값을 덮어쓰지 않습니다.

> 토큰을 모르면 에이전트에서 확인: `sudo grep COLLECTOR_TOKEN /etc/vmware-portal/portal.env`

---

## 5. 토큰 정리 (헷갈리지 않게)

| 토큰 | 방향 | 용도 | 어디에 |
|---|---|---|---|
| **CENTRAL_TOKEN** | 엣지 → 중앙 **push** | vCenter 인벤토리 + 베어메탈 보고 수신 | 중앙 + 모든 엣지에 **동일** |
| **COLLECTOR_TOKEN** | 중앙 → 에이전트 **pull/PUSH스캔** | iDRAC/OME **전력** export·원격 스캔 보호 | 각 수집 에이전트 + 중앙 등록 폼 |
| **EDGE_TOKEN** | (통합모드) | 위 둘을 겸함(EDGE_MODE=all) | 엣지 |
| **AUTH_SECRET** | (내부) | 로그인 JWT 서명 | 각 서버 — 설치 스크립트가 자동 생성 |

- 모든 토큰은 **직접 정하는 임의의 긴 랜덤 문자열**입니다: `openssl rand -hex 32`.
- 평문은 `$CONFIG_DIR/portal.env`(0640)와 `$CONFIG_DIR/collectors.json`(0600)에만 저장됩니다.
- 토큰을 붙여넣을 때 **앞뒤 공백/CRLF 주의**(`grep TOKEN portal.env | cat -A`로 확인).

---

## 6. 방화벽 / 포트

| 출발 → 도착 | 포트 | 용도 |
|---|---|---|
| 사용자 → 포탈(중앙/엣지) | TCP 4000 | 웹 UI/API |
| 엣지 → 중앙 | TCP 4000 | 인벤토리/베어메탈 push(아웃바운드) |
| 중앙 → 수집 에이전트 | TCP 4000 | 전력 export pull · PUSH 스캔 · 업그레이드 푸시 |
| 포탈 → vCenter | TCP 443 | vim25 SOAP/REST |
| 포탈/에이전트 → iDRAC/OME | TCP 443 | Redfish/OME |

```bash
sudo firewall-cmd --permanent --add-port=4000/tcp && sudo firewall-cmd --reload
```

자세한 통신/방화벽 매트릭스는 [docs/NETWORK-COMMS-FIREWALL.md](NETWORK-COMMS-FIREWALL.md) 참고.

---

## 7. 보안 설정 (권장 — v2.152.0 반영)

포탈은 기본적으로 안전하게 동작하지만, 운영 환경에서 아래를 확인하세요.

| 항목 | 설명 |
|---|---|
| **초기 비번** | `initial-admin-password.txt`로 로그인 후 **즉시 변경**하고 파일 삭제(§2.2). |
| **HTTPS 권장** | 리버스 프록시(nginx/HAProxy)로 TLS 종단 권장. HTTPS면 `HSTS` 헤더가 자동 적용됩니다. |
| **CORS** | 기본은 **교차출처 차단**(같은 포탈에서 SPA 사용 시 무영향). 별도 프론트 출처가 있으면 `CORS_ORIGINS=https://포탈주소`. |
| **/metrics 토큰** | Prometheus 연동 시 기본 **Authorization 헤더** 전용. 기존 `?token=` 방식이 필요하면 `METRICS_ALLOW_QUERY_TOKEN=true`. |
| **자동 업그레이드 무결성** | 번들 **sha256 필수**(공식 릴리스는 항상 제공). 서명 없는 사내 미러만 부득이 `UPGRADE_ALLOW_UNVERIFIED=true`. |
| **NSX 자체서명** | 기본 허용. 검증을 강제하려면 `NSX_TLS_REJECT_UNAUTHORIZED=true`. |
| **CSP(선택)** | 필요 시 `CSP=<정책문자열>`로 옵트인(인라인 스타일/intro 호환 확인 후). |

---

## 8. 자동 업그레이드

운영 포탈이 원격 소스를 감시해 새 버전을 자동 적용합니다. **설정 → ⬆ 업그레이드**에서 설정하거나 env로:

```ini
UPGRADE_ENABLED=true
UPGRADE_AUTO_APPLY=true
UPGRADE_REMOTE_BASE=http://<중앙 또는 사내 미러>/dl   # versions.json 위치
UPGRADE_POLL_INTERVAL_MS=3600000                      # 1시간
```

- 엣지는 보통 **중앙을 소스로**(`중앙 URL/dl`) 두어 중앙이 새 번들을 올리면 따라 올라옵니다.
- 폐쇄망은 **사내 미러**(예: Nexus)를 `UPGRADE_REMOTE_BASE`로 지정하고, 릴리스 자산을 미러에 올립니다.
- 중앙에서 엣지로 **직접 푸시**도 가능: 수집 서버 화면의 **모두 업그레이드**(실패 시 엣지별 원인 표시).
- 자동 업그레이드 흐름/오프라인 미러 구축 상세: [OFFLINE-INSTALL.md](../packaging/offline/OFFLINE-INSTALL.md#업그레이드-오프라인).

### 수동 오프라인 업그레이드

새 **설치 패키지**를 풀고 `sudo ./install.sh --port 4000`을 재실행하면 기존 앱이
백업(`app.bak.<ts>`)된 뒤 교체됩니다(설정 `portal.env`·DB 유지). 적용 직전 라이브 SQLite는
WAL 체크포인트로 복사 정합성을 확보합니다.

---

## 9. 데모(mock) 모드 — vCenter 없이 바로 체험

실제 vCenter 없이 전 기능을 시연할 수 있습니다.

```ini
DATA_SOURCE=mock
```

`sudo systemctl restart vmware-portal` 후 접속하면 **11개 가상 vCenter**(전세계 도시·좌표)와
호스트/VM/데이터스토어/GPU/알람은 물론, **iDRAC 전력(24h 시계열)·핑/네트워크 체크·vCenter 포트
응답·지표·ESXi 온도·GPU 게스트·vCenter 로그**까지 채워진 대시보드/세계지도/특수기능을 볼 수 있습니다
(v2.154.0부터 목업 데이터 완비). 운영으로 전환하려면 `DATA_SOURCE=live`로 바꾸고(데모용 `mock-` iDRAC/핑
항목은 자동으로 실제 폴 대상에서 제외되며, 원하면 목록에서 삭제) vCenter를 등록하세요.

---

## 10. 운영 명령

```bash
systemctl status vmware-portal        # 상태
journalctl -u vmware-portal -f        # 실시간 로그
systemctl restart vmware-portal       # 재시작(설정 변경 후)
sudo cat /etc/vmware-portal/portal.env    # 현재 설정(민감정보 포함 — 취급 주의)
```

**백업/복원**: 설정·데이터는 전부 `/etc/vmware-portal` 아래에 있습니다. 이 디렉터리를 백업하면
계정·토큰·vCenter·수집기·시계열 DB가 보존됩니다(포탈 **설정 → 포탈 백업**에서 스냅샷 내보내기도 가능).

---

## 11. 자주 묻는 점검

| 증상 | 확인 |
|---|---|
| 로그인 비번을 모름 | `sudo cat /etc/vmware-portal/initial-admin-password.txt` (없으면 `DEFAULT_ADMIN_PASSWORD` 설정값) |
| 수집기 '연결 테스트' 실패(403) | 에이전트 `COLLECTOR_TOKEN`과 **저장된** 폼 토큰 일치? 앞뒤 공백/CRLF? 4000 방화벽? URL `http://IP:포트` |
| 저장한 수집 서버 값이 원복됨 | v2.150.0+ 필요 — 관리자 저장 시 **🔒 고정**됨. 구버전이면 업그레이드 |
| 엣지 데이터가 중앙에 안 보임 | 엣지 `CENTRAL_URL/CENTRAL_TOKEN`, 중앙 `CENTRAL_TOKEN` 일치? 엣지→중앙 4000 아웃바운드? |
| 중앙→엣지 업그레이드/스캔 403 | 엣지 로그 `journalctl -u vmware-portal \| grep -i '인증 거부'` — 찍히면 토큰 문제, 무로그면 포트포워딩 대상 오류 |
| 베어메탈이 '미지정'만 | 통합 인벤토리에서 행별 **법인 등록** 또는 수집기 **귀속 vCenter** 매핑 |
| VM 사양 변경 안 보임 | **관리자**로 로그인 + **live**(mock 차단). vCenter 계정에 reconfigure 권한 |
| vCenter 인증서 오류 | `VC_TLS_REJECT_UNAUTHORIZED=false` |
| 브라우저 교차출처(CORS) 차단 | 별도 프론트 출처면 `CORS_ORIGINS`에 그 출처 추가(§7) |

---

## 부록 A. git 소스에서 설치 (개발/커스터마이징)

오프라인 tarball(운영 권장) 대신 저장소를 클론해 소스로 실행합니다. **인터넷 되는 환경·개발용**에 적합합니다.

### A.1 Node.js 22 LTS 이상 설치 (컴파일러 불필요)

```bash
# Rocky/RHEL/CentOS 9
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - && sudo dnf install -y nodejs git
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs git
node -v   # v22.x
```

### A.2 클론 + 빌드

```bash
cd /opt && sudo git clone https://github.com/noainred/The.DVC.git && cd The.DVC
git checkout main            # 최신(최근 릴리스는 태그가 없어 main이 최신)
npm run install:all          # 루트 + server + web 의존성
npm run build                # 웹을 web/dist 로 빌드(API가 서빙)
```

### A.3 설정 (⚠ `.env` 자동 로드 없음 — 셸 env 또는 파일 소싱)

```bash
sudo mkdir -p /etc/vmware-portal
sudo tee /etc/vmware-portal/portal.env >/dev/null <<'EOF'
PORT=4000
CONFIG_DIR=/etc/vmware-portal
DATA_SOURCE=mock                 # 데모(vCenter 없이). 운영은 live
AUTH_SECRET=
VC_TLS_REJECT_UNAUTHORIZED=false
EOF
S=$(openssl rand -hex 32); sudo sed -i "s/^AUTH_SECRET=.*/AUTH_SECRET=$S/" /etc/vmware-portal/portal.env
```

### A.4 실행

```bash
# 개발(핫리로드): API :4000 + 웹 :5173
npm run dev
# 프로덕션(단일 포트 :4000) — portal.env 소싱 + 내장 SQLite 활성
set -a; . /etc/vmware-portal/portal.env; set +a
NODE_OPTIONS=--experimental-sqlite npm start
```

> `--experimental-sqlite`는 Node 22의 내장 `node:sqlite`를 켭니다(없으면 NDJSON 폴백, 대용량 시계열 성능↓). Node 23.5+/24는 불필요.
> 최초 로그인 비번: `cat /etc/vmware-portal/initial-admin-password.txt`(§2.2). 검증: `curl -s http://localhost:4000/api/health`.

### A.5 systemd 서비스(상시 구동)

```ini
# /etc/systemd/system/vmware-portal.service
[Unit]
After=network-online.target
[Service]
User=vmportal
WorkingDirectory=/opt/The.DVC
Environment=NODE_OPTIONS=--experimental-sqlite
EnvironmentFile=/etc/vmware-portal/portal.env
ExecStart=/usr/bin/node server/src/index.js
Restart=always
[Install]
WantedBy=multi-user.target
```
```bash
sudo useradd --system --no-create-home --shell /sbin/nologin vmportal 2>/dev/null || true
sudo chown -R vmportal:vmportal /opt/The.DVC /etc/vmware-portal
sudo systemctl daemon-reload && sudo systemctl enable --now vmware-portal
```

### A.6 업데이트

```bash
cd /opt/The.DVC && sudo -u vmportal git pull && sudo -u vmportal npm run install:all \
  && sudo -u vmportal npm run build && sudo systemctl restart vmware-portal
```

> **git 소스 vs 오프라인 패키지**: git 소스는 Node 직접 설치·수동 systemd 구성·`git pull` 수동 업데이트(개발·커스터마이징용). 오프라인 tarball은 Node 번들·`install.sh` 자동 구성·**원격 자동 업그레이드**(운영·폐쇄망 권장).

---

자세한 환경변수 전체 목록은 [portal.env.example](../packaging/offline/portal.env.example) 와
[README 환경변수](../README.md#환경변수) 를 참고하세요.
