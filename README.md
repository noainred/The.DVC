# VMware Global Monitoring Portal (The.DVC)

전 세계 데이터센터에 분산 운영 중인 다수의 **VMware vCenter / NSX** 인프라를 하나의 포탈에서
통합 모니터링·운영하는 대시보드입니다. VM · ESXi 호스트 · 스토리지 · 네트워크 · 알람뿐 아니라
**전력(iDRAC/OME) · 온도 · GPU · IP 관리대장 · 용량 예측 · 원격접속 · VM 생성**, 그리고
**인사이트(FinOps·AI 이상탐지·보안·토폴로지) · 포탈/구성 백업 · vCenter 로그 장기보관 ·
네트워크 트래픽 분석(tcpdump) · 게스트 계정 관리 · 심층 검색**까지 한 화면에서 다룹니다.

> 실제 vCenter 자격증명이 없어도 **현실적인 목(mock) 데이터로 즉시 실행**됩니다.
> 실 환경에서는 포탈 UI(또는 `server/config/vcenters.json`)에 vCenter만 등록하면 됩니다.

- 백엔드: Node.js / Express (집계 API + 분산 에이전트/중앙 오케스트레이션)
- 프론트엔드: React + Vite (다크 NOC 테마, 세계지도, recharts)
- 저장소: Node 내장 `node:sqlite`(시계열/IPAM) + NDJSON 폴백, 설정 JSON(0600)
- 배포: 에어갭 오프라인 설치(Rocky/CentOS 9), Windows 패키지, 자가 업그레이드

> 📦 **설치는 [docs/INSTALL.md — 설치 가이드(중앙/엣지/수집기 + 토큰·방화벽)](docs/INSTALL.md)** 참고.
> 오프라인 패키지/업그레이드 상세는 [packaging/offline/OFFLINE-INSTALL.md](packaging/offline/OFFLINE-INSTALL.md).

---

## 목차
- [주요 기능](#주요-기능)
- [아키텍처](#아키텍처)
- [빠른 시작](#빠른-시작)
- [실제 vCenter 연결](#실제-vcenter-연결)
- [환경변수](#환경변수)
- [API 엔드포인트](#api-엔드포인트)
- [특수 기능](#특수-기능-tools)
- [분산 수집(에이전트) / IP 스캔](#분산-수집에이전트--ip-스캔)
- [오프라인 설치 & 패키징](#오프라인-설치--패키징)
- [자동 업그레이드](#자동-업그레이드)

---

## 주요 기능

### 모니터링 / 대시보드
- **글로벌 개요** — 전세계 KPI(vCenter/호스트/VM/CPU/메모리/스토리지/알람), 세계지도 위 사이트 마커(정상/경고/위험), 리전(Americas/EMEA/APAC) 롤업, 차트.
- **통합 서머리** — 모든 vCenter 자원을 SUM(개수·물리용량·할당·오버커밋·전력·Guest OS 분포·vCenter별 기여도). 리전/vCenter 스코프.
- **vCenter 카드 & 드릴다운** — 등록된 vCenter를 카드로 표시, 클릭 시 호스트·클러스터/VM·폴더/데이터스토어/네트워크 트리. **VM 이름 검색**(부분일치).
- **리소스 탐색 & 랭킹** — 호스트/VM/스토리지/네트워크/알람 정렬·검색·필터, Top N 랭킹, VM 사양·사용률 검색.
- **호스트/VM 성능** — CPU/메모리/디스크/네트워크 **실시간 + 일·주·월·년 + 날짜 기간** 시계열(vim25 PerformanceManager).
- **알람 + 음소거** — vCenter 알람 집계, 음소거 규칙.

### 인프라 운영
- **NSX** — NSX-T/4.x 매니저별 게이트웨이(T0/T1)·세그먼트(Overlay/VLAN, 연결 VM 포트 수)·분산방화벽(DFW, 허용/차단·로깅)·보안그룹(**라이브 멤버 조회**).
- **전력(iDRAC/OME)** — Dell Redfish/OpenManage로 호스트 전력(W) 수집·시계열, ESXi 전력은 vim25에서도 수집. IP 대역 스캔으로 iDRAC 대량 등록.
- **온도 / GPU / 용량** — ESXi 온도(현재/5분평균/최대 + 5년 추이, 분/시간/일 단위), GPU 인벤토리(**vGPU/패스쓰루 구분**, 사용률 5년 추이, 게스트 OS 수집), 데이터스토어 용량 추세·포화 예측.
- **IP 관리대장(IPAM)** — vCenter 수집 IP(서버종류 VM/베어메탈, OS 종류·버전) + **능동 스캔(TCP 커넥트)** 으로 물리/기타 장비 IP 보강. 서브넷 엑셀형 대장, 중복 IP, CSV/XLSX, 외부 공유 SQLite(`ipam.db`).
- **통합 서버 인벤토리** — iDRAC/OME 수집 물리 서버 + vCenter ESXi 호스트를 Dell 서비스태그로 조합해 **가상화 호스트 / 베어메탈**을 자동 분류. 베어메탈 **총전력 집계**, 소속 **법인(vCenter) 등록**(자동 추론·일괄 등록·수동 예외), **엣지→중앙 집계**(전력 없는 발견분까지 DC별 검색).
- **VM 생성(프로비저닝)** — 단건/대량 클론 + 게스트 커스터마이징(이름/IP 규칙), 동시성 제한 작업 큐, 작업 이력·메모/태그.
- **VM 사양 변경(관리자)** — `ReconfigVM_Task`로 vCPU·RAM 증설, 코어/소켓, 디스크 증설/추가(컨트롤러 선택), NIC 추가/삭제·연결 토글. **증설만**(감소·축소 차단) + hot-add 판정 + 확인창 + 감사로그.
- **원격 접속** — 브라우저 SSH(xterm.js/WebSocket)·RDP(Guacamole), HAProxy Data Plane API로 임시 포트 매핑(TTL 1일), `.rdp` 다운로드, VM에서 빠른 접속.
- **AI 자연어 검색** — 로컬 LLM(Ollama)로 "북미 메모리 90% 넘는 호스트" 같은 질의 → 구조화 검색(불가 시 규칙 기반 폴백).

### 인사이트 / 분석 (v1.88+)
- **인사이트 패널** — 💰 FinOps(전력→kWh·요금·CO₂, PUE/단가 설정) · 🤖 AI 이상탐지(중앙값·MAD Z-score) · 📈 용량/수명 예측(선형회귀 ETA) · 🛡 보안(ESXi/vCenter 빌드 ↔ 내장 VMSA·EOL) · 🌐 토폴로지 · 🚨 인시던트 타임라인 · 💬 LLM ChatOps.
- **구성도(3D)** — 설정된 라이브 구성을 3D 네트워크 그래프로(중앙→엣지→vCenter→NSX/호스트→VM, 줌·회전, vCenter/호스트 포커스로 VM 단위 탐색).
- **Prometheus/OTel 익스포터** — `/metrics`로 호스트 CPU·MEM·전력·GPU, 데이터스토어, VM 카운트 노출(선택 토큰).
- **다빈치 서비스 점검 / 글로벌 네트워크 점검** — 내부 서비스·수집기 상태 + 제어플레인(vCenter/NSX) 도달성·RTT.
- **심층 검색** — 게이트웨이·서브넷(CIDR)·OS·GPU·범위 등 다조건 + 게스트 탐침(GPU 드라이버/특정 프로세스). 전체/특정/복수 vCenter.

### 백업 / 로그 / 네트워크 진단 (v1.88+)
- **포탈 백업** — 중앙+엣지 설정을 gzip로 통합 백업(정기/변경 자동, 보관·복원). **VMware 구성 백업**(사이트 수집 구성 스냅샷).
- **vCenter 로그 장기보관** — vim25 EventManager로 이벤트 증분 수집해 SQLite/NDJSON 장기보관(보관기간·용량·저장경로 설정). **분산 저장**(각 엣지 로컬) + 중앙 **연합 조회**.
- **네트워크 트래픽 분석** — 두 서버 간 `tcpdump` 캡처·진단(핸드셰이크·재전송·RST), **동시(양방향) 비교**, **에이전트 위임 캡처**, **pcap 다운로드**, **캡처 이력**, **연속 모니터링**(주기 캡처 + 이슈 알림) + 로그 자체 장애 탐지.
- **게스트 계정 추가** — VMware Tools(게스트 작업)로 게스트 OS에 sudo 계정 생성(비밀번호 파일 전달로 셸 노출 회피, 다중 VM, 감사 로그).
- **VM IP Ping** — 중앙이 못 가는 사설 IP를 엣지 에이전트가 대행 ping(VM 상세에서 녹/적).
- **PWA** — 설치 가능 + 위험 인시던트 브라우저 알림.

### 관리 / 운영 편의
- **인증/RBAC** — scrypt 해시 + HS256 JWT, 역할(admin/operator/viewer), **TOTP 2FA**, **Active Directory(LDAP)** 연동.
- **감사 로그 / 진단·로그** — 쓰기 작업 감사(JSONL), 연결 실패 원인(한국어 힌트) + 실시간 서버 로그 뷰어.
- **알림** — 임계치 규칙 → Slack/Webhook(상태전이·쿨다운).
- **자동 업그레이드** — `versions.json` 모니터링 → 다운로드·적용·재시작(롤백 가능), 엣지 푸시.
- **분산 수집** — 원격 데이터센터 에이전트 pull(전력 등) + 중앙 할당(iDRAC/IP 스캔).
- **장애 내성 & 성능** — 한 vCenter/매니저가 죽어도 포탈은 정상(해당만 `unreachable`). 고RTT·다수 vCenter(현재 28, 향후 30+) 대비 **동시 수집 개수 제한(`COLLECT_CONCURRENCY`, 기본 8) + per-vCenter 타임아웃 + 폴러 재진입 가드(주기 초과 시 중첩 실행 방지) + O(N) 롤업 집계 + 논블로킹 DB write(트랜잭션·prune 스로틀)**로 매 주기 CPU 스파이크를 평탄화.

---

## 아키텍처

```
                ┌──────────── 분산 에이전트(사이트별) ───────────┐
                │  IP/iDRAC 스캔 · 전력 수집 · GPU 게스트 수집     │
                └───────────────▲───────────────┬───────────────┘
            중앙 할당 pull(/api/central)         │ 결과 보고
                                │               ▼
 vCenter A/B/C…   REST+SOAP   ┌─────────────────────────────┐   /api/*   ┌───────────────┐
 NSX Manager      ───────────▶│  Aggregation API (Express)  │──────────▶│ React 대시보드 │
 iDRAC/OME, HAProxy           │  in-memory snapshot + SQLite │           │   (Vite)       │
                              └─────────────────────────────┘           └───────────────┘
```

- **server/** — `store.js`가 `POLL_INTERVAL_MS`마다 전 vCenter를 **동시성 제한(`COLLECT_CONCURRENCY`) 병렬** 폴링해 정규화 스냅샷 유지. 느린/장애 vCenter가 전체를 막지 않음. 이전 주기가 아직 진행 중이면 이번 틱은 건너뛰어(재진입 가드) 수집이 겹치지 않음. 롤업은 vCenter별 1회 그룹핑(O(N)).
  - `vcenter/soapClient.js` — vim25 SOAP(PropertyCollector/PerformanceManager): 호스트/VM 실측 메트릭, 온도/GPU/HBA, VM GPU 할당(vGPU/패스쓰루), 성능 시계열, VM 클론.
  - `vcenter/restClient.js` — vSphere Automation REST(7.0/8.0) 폴백.
  - `nsx/`, `idrac/`, `ipam/`, `gpu/`, `metrics/`, `provision/`, `proxy/`, `llm/`, `collector/`, `central/`, `agent/`, `upgrade/`, `auth/` — 각 하위 시스템.
- **web/** — React + Vite. 해시 라우팅 `#/<탭>`, 특수기능 딥링크 `#/tools/<기능>`.

---

## 빠른 시작

```bash
npm run install:all          # 루트 + server + web 의존성
npm run dev                  # API :4000 + 웹 :5173 (핫리로드) → http://localhost:5173
# 또는 단일 포트(프로덕션)
npm run build && npm start   # API가 web/dist 서빙 → http://localhost:4000
```

기본 데모 계정: **`admin` / `admin123`** (`users.json` 없으면 자동 시드). 운영 시 반드시 변경 + `AUTH_SECRET` 지정.

---

## 실제 vCenter 연결

기본은 목 데이터(`DATA_SOURCE=mock`). 실 환경:
1. 웹 **설정 › vCenter 관리**에서 등록(호스트/계정/위치 → 연결 테스트 → 저장, 즉시 재수집) — 또는 `server/config/vcenters.json`(0600, gitignore).
2. 실행: `DATA_SOURCE=live npm start` (실 vCenter만) / `DATA_SOURCE=auto npm start` (실패 시 목으로 폴백).

> **메트릭 수집**: 호스트/VM의 CPU·메모리 사용률, 데이터스토어 사용량 등은 REST 목록 API로 안 나오므로 기본적으로 vim25 **SOAP(`/sdk`)** 로 수집합니다(443 + 읽기 권한 필요). 실패 시 REST로 폴백. `VC_SOAP_METRICS=false`로 끌 수 있습니다. 읽기 전용 모니터링 계정 권장.

---

## 환경변수

주요 항목만 발췌(전체는 `server/src/config.js`).

### 기본 / vCenter
| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `4000` | API 포트 |
| `DATA_SOURCE` | `mock` | `mock`/`live`/`auto` |
| `CONFIG_DIR` | `server/config` | 설정·DB 저장 위치(오프라인 설치 시 `/etc/vmware-portal` → 업그레이드해도 보존) |
| `POLL_INTERVAL_MS` | `30000` | vCenter 폴링 주기(ms). 이전 주기가 끝나기 전이면 이번 틱은 건너뜀(재진입 가드) |
| `COLLECT_CONCURRENCY` | `8` | 매 주기 동시 수집 vCenter 개수 상한(고RTT·다수 vCenter에서 CPU 스파이크 완화) |
| `VC_SOAP_METRICS` | `true` | vim25 SOAP 실측 메트릭 수집 |
| `VC_TLS_REJECT_UNAUTHORIZED` | `false` | 자체서명 인증서 거부 여부 |
| `VC_TLS_MIN_VERSION` / `VC_TLS_CIPHERS` | `TLSv1` / `DEFAULT@SECLEVEL=0` | 레거시 vCenter TLS 호환 |

### 인증
| 변수 | 기본값 | 설명 |
|---|---|---|
| `AUTH_ENABLED` | `true` | 로그인 인증 사용 |
| `AUTH_SECRET` | (랜덤) | JWT 서명 시크릿 — **운영 필수**(미지정 시 재시작마다 토큰 무효) |
| `AUTH_TOKEN_TTL` | `8h` | 토큰 유효기간 |
| `DEFAULT_ADMIN_PASSWORD` | `admin123` | 초기 admin 비밀번호 |
| `TOTP_ISSUER` | `VMware Portal` | TOTP 표시명 |
| `AD_ENABLED`, `AD_URL`, `AD_DOMAIN`, `AD_BASE_DN`, `AD_*_GROUP`, `AD_DEFAULT_ROLE` | — | Active Directory(LDAP) 연동·그룹→역할 매핑 |

### 전력(iDRAC/OME) · 시계열
| 변수 | 기본값 | 설명 |
|---|---|---|
| `IDRAC_ENABLED` / `IDRAC_POLL_INTERVAL_MS` | `true` / `60000` | iDRAC 전력 폴링 |
| `IDRAC_DB_PATH` / `IDRAC_RETENTION_DAYS` | `CONFIG_DIR/idrac-power.db` / `90` | 전력 시계열 DB·보존 |
| `OME_POWER_PLUGIN_ID` / `OME_POWER_METRIC_TYPES` | — | OpenManage Power Manager |
| `TEMP_DB_PATH` / `TEMP_SAMPLE_INTERVAL_MS` / `TEMP_RETENTION_DAYS` | `CONFIG_DIR/host-temp.db` / `60000`(1분) / `1830`(~5년) | 온도·GPU·용량 시계열(설정에서도 변경) |
| `IPAM_DB_PATH` | `CONFIG_DIR/ipam.db` | 외부 공유 IP 대장 DB |

### 분산(수집/중앙/에이전트)
| 변수 | 기본값 | 설명 |
|---|---|---|
| `COLLECTOR_TOKEN` / `COLLECTOR_DATACENTER` | — | 이 인스턴스를 수집 에이전트로 노출(토큰), 사이트 라벨 |
| `COLLECTOR_PULL_INTERVAL_MS` | `60000` | 중앙이 에이전트 pull 주기 |
| `CENTRAL_TOKEN` | — | 중앙↔에이전트 API 토큰(중앙·에이전트 동일값) |
| `AGENT_NAME` / `CENTRAL_URL` / `AGENT_SCAN_INTERVAL_MS` | hostname / — / `3600000` | 에이전트 이름·중앙 주소·스캔 주기 |
| `AGENT_PUSH_INVENTORY` / `AGENT_PUSH_FLEET` | `false` / `true` | 엣지→중앙 vCenter 인벤토리 push · 베어메탈 push(엣지 기본 on) |
| `CENTRAL_FLEET_TTL_MS` / `CENTRAL_FLEET_MAX_AGENTS` | `1800000` / `500` | 중앙의 엣지 베어메탈 만료시간 · 에이전트 상한 |
| `AGENT_PING_POLL_MS` / `AGENT_LOGQ_POLL_MS` / `AGENT_CAPTURE_POLL_MS` | `4000` | 위임 ping·로그조회·캡처 워커 폴링 주기 |
| `AGENT_CONFIG_PUSH_MS` | `1800000` | 엣지 설정 → 중앙 push 주기(백업 통합) |

### 원격접속 · LLM · 기타
| 변수 | 기본값 | 설명 |
|---|---|---|
| `HAPROXY_DATAPLANE_URL/USER/PASS`, `PROXY_PUBLIC_HOST`, `PROXY_PUBLIC_PORT_BASE`, `GUACD_HOST/PORT` | — | 원격 SSH/RDP 게이트웨이(HAProxy/Guacamole) |
| `REMOTE_MAPPING_TTL_MS` | `86400000` | 원격 매핑 TTL(1일) |
| `LLM_ENABLED` / `OLLAMA_URL` / `OLLAMA_MODEL` | `false` / `http://localhost:11434` / `llama3.1` | AI 자연어 검색 |
| `PROVISION_CONCURRENCY` | `4` | 동시 VM 클론 수 |
| `METRICS_EXPORT_TOKEN` | — | `/metrics`(Prometheus) 접근 토큰(미설정 시 공개) |
| `UPGRADE_*` | — | 자동 업그레이드(아래 참조) |

---

## API 엔드포인트

마운트: `/api`(인증) · `/api/admin`·`/api/upgrade`·`/api/remote`(관리자) · `/api/auth`(공개) · `/api/collector`·`/api/central`(토큰).
`/api/auth/*`와 토큰 라우터를 제외한 모든 경로는 `Authorization: Bearer <token>` 필요(`AUTH_ENABLED=false`면 제외).

### 인증 `/api/auth`
`POST /login` · `GET /me` · `GET /config` · `POST /totp/begin|confirm` · `GET/PUT /ad-config` · `POST /ad-test`

### 조회(일반) `/api`
| 경로 | 설명 |
|---|---|
| `GET /health` `GET /overview` `GET /summary` | 상태 · 글로벌 KPI · 통합 합계 |
| `GET /vcenters` `GET /hosts` `GET /vms` `GET /datastores` `GET /networks` `GET /alarms` `GET /top` | 스냅샷 자원(공통필터 `vcenterId·region·q`) |
| `GET /vms?gpu=1&gpuType=vgpu|passthrough…` | VM 사양·GPU 필터/정렬 |
| `GET /vms/lookup?name=&ip=` | VM 단건 조회(상세 팝업) |
| `GET /vms/:id/metrics` `GET /hosts/:id/metrics` | 성능 시계열(cpu/mem/disk/net, realtime/day/week/month/year, start/end) |
| `GET /vms/:id/console` `POST /vms/upgrade-tools` | 원격 콘솔 · Tools 일괄 업그레이드 |
| `GET /nsx` `GET /nsx/group-members` | NSX 개요 · 보안그룹 라이브 멤버 |
| `GET /idrac/host-power` | 호스트 전력(현재+히스토리) |
| `GET /provision/sources|placement|saved|jobs` `POST /provision/preview` | 프로비저닝 조회·미리보기 |
| `GET/POST/DELETE /alarm-mutes` `GET/PUT /ui-settings` `POST /search/nl` | 음소거 · UI설정 · 자연어검색 |

### 특수기능 `/api/tools/*`
`gpu`(+`/history`,`/vms`), `esxi-temp`(+`/history`), `capacity`, `capacity-forecast`, `waste`, `thin-vms`, `guest-os`, `hba`, `licenses`, `esxi`, `solutions`, `hardware`, `vmtools`, `snapshots`, `duplicate-ips`, `vm-finder`(POST), `ipam`(+`/subnets`,`/sheet`,`/annotation`,`.xlsx`,`.csv`), `deep-search`(POST), `ip-ping`, `service-check`, `network-check`, `vmware-config`, `vclogs`(+`/export.csv`,`/federate`,`/sources`)

### 인사이트 `/api/insights/*`
`finops`(+`/config`), `power-breakdown`, `fleet`(+`/tag`,`/assign`,`/assign-bulk`,`/prune` — 통합 인벤토리), `anomalies`, `forecast`, `security`, `topology`, `graph`, `incidents`, `chatops`(POST) · 익스포터 `GET /metrics`(Prometheus)

### 관리자 `/api/admin/*` (발췌)
`users`, `vcenters`(+`/test`,`/import`,`/order`), `nsx/managers`, `idrac`(+`/scan`,`/bulk-add`,`/power-dashboard`), `collectors`(+`/:id` vCenter 매핑), `vm/:id/{hardware,reconfig}`(VM 사양 변경), `assignments`, `agent-deploy`, `metrics/settings`, `gpu-guest/{settings,vms,test,diag}`, `ipam/settings`, `ipam/scan/{settings,run,results}`, `alerts`(+`/test`), `audit`, `data-source`, `llm-config`, `packages`, `geocode`, `logs`, `backup/*`, `vclogs/*`, `net/{capture,pcap,history,monitors,agents,log-issues}`, `guest/add-user`, `deep-search/probe`

### 원격접속 `/api/remote/*`
`mappings`, `quick-connect`, `proxies`, `config`, `deploy`, `probe`, `targets`, `rdp/:id`

### 업그레이드 `/api/upgrade/*`
`status`, `check`, `apply`, `restart`, `settings`, `bundle`

### 토큰 라우터(에이전트↔중앙, `X-Central-Token`)
`/api/collector/{export,ping,upgrade}` · `/api/central/{assignment,result,inventory,fleet,ip-scan-assignment,ip-scan-result,gpu-guest-data,agent-config,ping-jobs,ping-result,log-queries,log-query-result,capture-jobs,capture-result}`

---

## 특수 기능 (`/tools`)

상단 **특수 기능** 탭. 각 기능은 **고유 URL `#/tools/<키>`** 로 북마크/바로가기 가능. 대부분 vCenter 범위(법인) 선택 지원.

| 키 | 기능 | 키 | 기능 |
|---|---|---|---|
| `aisearch` | AI 자연어 검색 | `ipam` | 센터별 IP 관리대장(+IP 능동 스캔) |
| `vmfinder` | VM 정밀검색 / 유휴 VM | `dupip` | 중복 IP 찾기 |
| `capacity` | 용량 리포트(오버커밋) | `vmtools` | VMware Tools 버전 |
| `forecast` | 용량 추세/예측 | `snapshots` | 스냅샷 있는 VM |
| `waste` | 낭비 리소스 | `solutions` | VMware 솔루션/NSX |
| `thinvms` | Thin VM 찾기 | `licenses` | 라이선스 한눈에 |
| `guestos` | Guest OS 종류/버전 | `esxi` / `vcversion` | ESXi/vCenter 버전 분포 |
| `esxitemp` | ESXi 온도(5년 추이) | `hardware` / `hba` | 벤더·모델 / HBA 속도 |
| `gpu` | GPU 인벤토리(vGPU/패스쓰루·5년) | `nsx` | NSX 관리 |
| `deepsearch` | 심층 검색(게이트웨이·GPU·프로세스·다중 vCenter) | `topo3d` | 구성도(3D 네트워크) |
| `davinci-svc` | 다빈치 서비스 점검 | `net-check` | 글로벌 네트워크 점검 |
| `net-traffic` | 네트워크 트래픽 분석(tcpdump) | `vmware-backup` | VMware 구성 백업 |
| `powermap` | 전력 분석(법인·모델·지역별) | `serveranalysis` | 서버 분석(iDRAC 하드웨어·GPU) |
| `fleet` | **통합 서버 인벤토리**(가상화/베어메탈·법인 등록·엣지 집계) | `portaldb` | 포탈 DB 현황 |

> 상단 **인사이트** 탭(FinOps·이상탐지·예측·보안·토폴로지·인시던트·ChatOps)과
> **설정**의 포탈 백업 · vCenter 로그 보관 · 게스트 계정 추가 · GPU 게스트 수집/진단도 참고.

---

## 분산 수집(에이전트) / IP 스캔

대규모·고RTT(한국↔폴란드/미동부 등) 환경을 위해 **각 사이트에 에이전트**를 두고 스캔/수집을 사이트 내부에서 수행합니다.

- **전력/데이터 pull**: 원격 인스턴스를 `COLLECTOR_TOKEN`으로 노출 → 중앙이 `/api/collector/export`를 주기적으로 pull.
- **중앙 할당(iDRAC/IP 스캔)**: 중앙이 에이전트별 대역/포트를 할당 → 에이전트가 `/api/central/*`로 풀 → 로컬 스캔 → 결과 보고 → 중앙이 IP 대장에 병합.
- **IP 능동 스캔(TCP 커넥트)**: vCenter가 모르는 물리/타가상화/네트워크 장비 IP를 공통 포트(22/80/443/445/3389/623/8006/902/5985…)로 탐지 → 서버종류 "스캔"으로 대장에 채움. **설정 › IP 스캔**에서 할당 에이전트 선택·대역/포트/주기 설정, 에이전트별 보고 현황 표시.
  - 에이전트 측: `AGENT_NAME=<이름>`, `CENTRAL_URL=<중앙주소>`, `CENTRAL_TOKEN=<동일토큰>` / 중앙 측: `CENTRAL_TOKEN` 설정 필수.
  - ⚠️ 포트 스캔은 침투성 — **승인된 대역만**, 레이트리밋, 보안팀 공지 후 사용.

---

## 오프라인 설치 & 패키징

에어갭 서버에 Node 런타임·서버 의존성·빌드된 웹 UI를 모두 포함한 자체 완결형 패키지를 설치합니다(타깃에 인터넷·npm·컴파일러 불필요).

```bash
# Rocky/RHEL 9 (el9)
packaging/offline/build-package.sh                                   # → dist-offline/vmware-portal-offline-<버전>-el9-x64.tar.gz
# CentOS Stream 9 표기 변형
STAMP=cent9-x64 packaging/offline/build-package.sh
# 오프라인 빌드(미리 받은 Node)
packaging/offline/build-package.sh --offline --node-tarball /path/node-v22.20.0-linux-x64.tar.xz
# Windows (포탈/수집 에이전트)
packaging/windows/build-collector-win.sh --node-zip /path/node-v22.20.0-win-x64.zip

# 설치 (Rocky 9, systemd)
tar -xzf vmware-portal-offline-<버전>-el9-x64.tar.gz && cd vmware-portal-offline-*
sudo ./install.sh --port 4000
```

**산출물 / 배포(`download/`)**
| 파일 | 내용 |
|---|---|
| `vmware-portal-offline-<버전>-el9-x64.tar.gz` | Rocky/RHEL/Alma 9 설치 패키지(~66MB, Node+앱+systemd) |
| `vmware-portal-offline-<버전>-cent9-x64.tar.gz` | CentOS Stream 9 표기 변형 |
| `vmware-portal-win-<버전>-x64.zip` | Windows 설치(~49MB, 포탈/수집 에이전트) |
| `vmware-portal-<버전>.tar.gz` | 업그레이드 번들(~9MB, 앱만) |
| `versions.json` | 자동 업그레이드 메타데이터(`latest` + sha256). 롤링 릴리스 자산 1000개 상한을 피해 **최근 15개 버전만 유지**(`VERSIONS_KEEP`, CI가 오래된 버전 자산을 자동 prune) |
| `*.sha256` | 무결성 검증 |

자세한 내용: `packaging/README.md`, `packaging/offline/OFFLINE-INSTALL.md`, `packaging/windows/README-WINDOWS.md`.

---

## 자동 업그레이드

옵트인(기본 꺼짐). `download/versions.json`을 주기적으로 확인해 더 새 버전만 받아 적용·재시작(re-exec), 기존 코드 백업(롤백), 경로탈출·아카이브폭탄 방지, 표준 라이브러리만 사용. 자가 업그레이드 후 등록된 엣지에 번들 푸시.

| 변수 | 설명 |
|---|---|
| `UPGRADE_ENABLED` | 기능 활성화 |
| `UPGRADE_REMOTE_BASE` / `UPGRADE_TOKEN` | 원격 소스(versions.json 디렉터리) / 사설 레포 PAT |
| `UPGRADE_WATCH_DIR` / `UPGRADE_INSTALL_DIR` / `UPGRADE_PACKAGE_NAME` | 로컬 번들 감시 / 교체 대상 / 번들 최상위 디렉터리명 |
| `UPGRADE_POLL_INTERVAL_MS` / `UPGRADE_AUTO_APPLY` / `UPGRADE_EDGES` | 확인 주기 / 자동 적용 / 엣지 푸시 목록 |

관리자 **업그레이드** 탭에서 GUI로 설정·확인·적용·재시작. 설정은 `config/upgrade.json`(gitignore)에 보존, 환경변수는 기본값. 실행 버전은 상단 바 배지로 표시.

---

## 보안 / 운영 메모

- 자격증명/시크릿(`vcenters.json`, `users.json`, `*-assignments.json`, 스캔/게스트 계정 등)은 `CONFIG_DIR`에 `0600`으로 저장되고 API 응답에서 마스킹됩니다. 운영 시 `AUTH_SECRET` 지정 + 기본 비밀번호 변경 필수.
- 시계열(온도/GPU/용량)을 분 단위·장기 보존하면 데이터가 커집니다 — **설정 › 지표 수집**에서 주기/보존기간을 조절하세요.
- 모니터링은 **읽기 전용 vCenter 계정** 권장. VM 생성/Tools 업그레이드/원격접속 등 쓰기·운영 기능은 권한 있는 계정과 승인 절차로 사용하세요.
