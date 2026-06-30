# 설치 가이드 (The Davinci Virtual Platform)

전 세계 분산 vCenter/베어메탈 인프라를 통합 관리하는 포탈의 설치 가이드입니다.
**중앙(central) 포탈 1대 + 데이터센터별 엣지/수집 서버**로 확장하는 것을 전제로 합니다.

- 대상 OS: **Rocky Linux 9 / RHEL 9 / AlmaLinux 9** (에어갭/오프라인). Windows 수집기는 [README-WINDOWS](../packaging/windows/README-WINDOWS.md).
- 오프라인 패키지 빌드/업그레이드 등 상세 메커니즘: **[OFFLINE-INSTALL.md](../packaging/offline/OFFLINE-INSTALL.md)** (이 문서는 분산 구성 중심).
- 포탈과 에이전트(엣지/수집기)는 **같은 프로그램**입니다. 환경변수로 역할이 정해집니다.

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
tar -xzf vmware-portal-offline-<버전>-el9-x64.tar.gz
cd vmware-portal-offline-<버전>-el9-x64
sudo ./install.sh --port 4000
```

설치 후:
- 서비스: `vmware-portal` (systemd, 부팅 시 자동 시작)
- URL: `http://<중앙 IP>:4000`  ·  기본 로그인 **admin / admin123** (즉시 변경)
- 설정 파일: `/etc/vmware-portal/portal.env`

### 2.2 중앙 환경설정

`sudo vi /etc/vmware-portal/portal.env` 후 `sudo systemctl restart vmware-portal`:

```ini
PORT=4000
DATA_SOURCE=live                       # 실제 vCenter (데모는 mock)
VC_TLS_REJECT_UNAUTHORIZED=false       # 자체서명 인증서 허용

# 엣지 에이전트 push를 받으려면(중앙 역할):
CENTRAL_TOKEN=<강력한-공유-토큰-1>     # 엣지 인증용. 모든 엣지와 동일 값
COLLECTOR_PULL_INTERVAL_MS=60000       # 수집기 전력 pull 주기(0이면 비활성)
```

### 2.3 vCenter 등록

포탈 로그인 → **설정 → vCenter 관리 → 추가**. (또는 `/etc/vmware-portal/`이 아닌
앱 폴더 `server/config/vcenters.json` — UI 등록을 권장.) 고RTT DC는 **수집 방식 = site(현장 수집)**
로 두고 해당 엣지가 push하게 합니다.

---

## 3. 엣지(현장) 포탈 설치

DC 현장 서버에 **같은 패키지**를 설치(2.1과 동일)한 뒤, 환경설정에서 **중앙으로 push**하도록 만듭니다.

```ini
PORT=4000
DATA_SOURCE=live
VC_TLS_REJECT_UNAUTHORIZED=false

# 이 서버를 '엣지(에이전트)'로 — 중앙으로 push:
AGENT_NAME=Seoul-DC1                   # 이 DC/에이전트 이름(중앙 화면 표시)
CENTRAL_URL=http://<중앙 IP>:4000      # 중앙 포탈 주소
CENTRAL_TOKEN=<강력한-공유-토큰-1>     # 중앙의 CENTRAL_TOKEN과 동일

AGENT_PUSH_INVENTORY=true              # vCenter 인벤토리(hosts/vms/...) push
# AGENT_PUSH_FLEET=false               # 베어메탈 push 끄기(기본 on) — 끌 때만 설정
AGENT_SCAN_INTERVAL_MS=3600000         # 위임 iDRAC/IP 스캔 주기(기본 1시간)
AGENT_AUTO_REGISTER=true               # 발견 iDRAC 로컬 자동 등록
```

- 엣지는 자기 DC의 vCenter를 **로컬에서 수집**해 중앙으로 보냅니다(중앙↔원격 RTT 제거).
- 엣지의 **베어메탈**(전력 없는 발견분 포함)도 `/api/central/fleet`로 보고되어, 중앙 **통합 서버 인벤토리**에서 DC별로 보입니다.
- 통신은 **엣지 → 중앙 단방향 아웃바운드**라 폐쇄망/NAT에 유리합니다.

---

## 4. 수집기(collector) — iDRAC/OME 전력

현장 서버가 자기 DC의 **iDRAC/OME 전력**을 모으고, **중앙이 pull**합니다.

### 4.1 에이전트(192.168.x.x) 측 설정

```ini
COLLECTOR_TOKEN=<강력한-공유-토큰-2>   # 직접 정하는 공유 비밀(openssl rand -hex 32)
COLLECTOR_DATACENTER=Seoul-DC1
```

`sudo systemctl restart vmware-portal` 후, 그 서버의 포탈 **설정 → 전력 수집**에서 로컬 iDRAC/OME를 등록합니다.

### 4.2 중앙 측 등록

중앙 포탈 **설정 → 수집 서버(원격) → 서버 추가**:
- **수집 서버 URL**: `http://<에이전트 IP>:4000`
- **토큰**: 위 `COLLECTOR_TOKEN`과 **동일한 값** → **연결 테스트** → **등록**.
- 등록 후 **귀속 vCenter** 드롭다운으로 그 수집기의 호스트를 특정 법인(vCenter)에 매핑할 수 있습니다.

> 토큰을 모르면 에이전트에서 확인: `sudo grep COLLECTOR_TOKEN /etc/vmware-portal/portal.env`

---

## 5. 토큰 3종 정리 (헷갈리지 않게)

| 토큰 | 방향 | 용도 | 어디에 |
|---|---|---|---|
| **CENTRAL_TOKEN** | 엣지 → 중앙 **push** | vCenter 인벤토리 + 베어메탈 보고 수신 | 중앙 + 모든 엣지에 **동일** |
| **COLLECTOR_TOKEN** | 중앙 → 에이전트 **pull** | iDRAC/OME **전력** export 보호 | 각 수집 에이전트 + 중앙 등록 폼 |
| **AUTH_SECRET** | (내부) | 로그인 JWT 서명 | 각 서버 — 설치 스크립트가 자동 생성 |

- 모든 토큰은 **직접 정하는 임의의 긴 랜덤 문자열**입니다: `openssl rand -hex 32`.
- 평문은 `$CONFIG_DIR/portal.env`(0640)와 `$CONFIG_DIR/collectors.json`(0600)에만 저장됩니다.

---

## 6. 방화벽 / 포트

| 출발 → 도착 | 포트 | 용도 |
|---|---|---|
| 사용자 → 포탈(중앙/엣지) | TCP 4000 | 웹 UI/API |
| 엣지 → 중앙 | TCP 4000 | 인벤토리/베어메탈 push(아웃바운드) |
| 중앙 → 수집 에이전트 | TCP 4000 | 전력 export pull |
| 포탈 → vCenter | TCP 443 | vim25 SOAP/REST |
| 포탈/에이전트 → iDRAC/OME | TCP 443 | Redfish/OME |

```bash
sudo firewall-cmd --permanent --add-port=4000/tcp && sudo firewall-cmd --reload
```

자세한 통신/방화벽 매트릭스는 [docs/NETWORK-COMMS-FIREWALL.md](NETWORK-COMMS-FIREWALL.md) 참고.

---

## 7. 운영 명령 / 업그레이드

```bash
systemctl status vmware-portal        # 상태
journalctl -u vmware-portal -f        # 실시간 로그
systemctl restart vmware-portal       # 재시작(설정 변경 후)
```

업그레이드(오프라인): 새 **설치 패키지**를 풀고 `sudo ./install.sh --port 4000` 재실행하면 기존 앱이
백업(`app.bak.<ts>`)된 뒤 교체됩니다(설정 `portal.env` 유지). 관리자 UI/감시 폴더/원격 자동
업그레이드는 [OFFLINE-INSTALL.md](../packaging/offline/OFFLINE-INSTALL.md#업그레이드-오프라인) 참고.

---

## 8. 자주 묻는 점검

| 증상 | 확인 |
|---|---|
| 수집기 '연결 테스트' 실패 | 에이전트 `COLLECTOR_TOKEN`과 폼 토큰 일치? 4000 방화벽? URL `http://IP:4000` |
| 엣지 데이터가 중앙에 안 보임 | 엣지 `CENTRAL_URL/CENTRAL_TOKEN`, 중앙 `CENTRAL_TOKEN` 일치? 엣지→중앙 4000 아웃바운드? |
| 베어메탈이 '미지정'만 | 통합 인벤토리에서 행별 **법인 등록**(드롭다운) 또는 수집기 **귀속 vCenter** 매핑 |
| VM 사양 변경 안 보임 | **관리자**로 로그인 + **live**(mock 차단). vCenter 계정에 reconfigure 권한 |
| vCenter 인증서 오류 | `VC_TLS_REJECT_UNAUTHORIZED=false` |

---

자세한 환경변수 전체 목록은 [portal.env.example](../packaging/offline/portal.env.example) 와
[README 환경변수](../README.md#환경변수) 를 참고하세요.
