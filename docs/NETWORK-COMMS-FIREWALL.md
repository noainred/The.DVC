# 네트워크 통신 · 방화벽 오픈 가이드 (The DVC Portal)

> 전체 소스코드 분석으로 도출한 **모든 프로세스 간 통신 경로**입니다. 방화벽 정책(ACL) 작성에 바로 쓰도록 출발지/도착지·방향·프로토콜·포트·기본값·환경변수·근거 파일까지 정리했습니다.
> 분석 범위: 중앙 포탈 ↔ 엣지 포탈 ↔ 수집 에이전트 ↔ vCenter/ESXi ↔ iDRAC/OME ↔ HAProxy 중계 ↔ 게스트/네트워크 점검 + AD·LLM·NSX·알림·업그레이드.
> 총 **82개 통신 경로**(6개 도메인). 포트는 기본값 기준이며, 대부분 환경변수/설정으로 변경 가능합니다(아래 표의 '환경변수/설정' 열).

## 0. 핵심 요약 (먼저 읽기)

- **포탈은 단일 인바운드 포트 `TCP 4000`(`PORT`) 하나만 listen합니다.** 웹 UI, 모든 `/api/*`(admin·collector·central·upgrade·metrics·dl), WebSocket 원격콘솔(`/api/remote/ssh`·`/rdp`)이 전부 이 포트로 들어옵니다. HTTPS 종단은 보통 앞단 리버스프록시(nginx 등)에서 443→4000으로 처리합니다.
- **나머지는 거의 전부 포탈/에이전트 → 인프라 방향의 아웃바운드**입니다.
- **엣지(분산) 에이전트는 중앙으로 단방향 아웃바운드 push/pull만** 합니다(`CENTRAL_URL`→중앙 `4000`). 중앙이 에이전트로 먼저 연결하는 건 (a) 수집 에이전트 전력 pull(`/api/collector/export`)과 (b) 업그레이드 번들 push 두 가지뿐 → NAT/폐쇄망 사이트는 에이전트 방식이 유리.
- **vCenter를 HAProxy로 중계**하는 구성에서는 vCenter 포트가 `443`이 아니라 **중계 frontend의 커스텀 포트**(예: `4065`)입니다 — `vcenters.json`의 `host`에 `https://중계IP:포트`로 들어갑니다.
- **HAProxy 원격접속 frontend 포트는 동적**입니다(`20000`+, `PROXY_PUBLIC_PORT_BASE`부터 매핑마다 1씩 증가 할당).

## 1. 구성요소(역할) 용어

| 역할 | 설명 |
|---|---|
| **중앙 포탈(Central Portal)** | 글로벌 대시보드. 모든 사이트 데이터를 통합. `PORT`(4000) listen. |
| **엣지 포탈/수집 에이전트(Edge/Collector Agent)** | 현장(사이트)에 설치된 동일 앱. 로컬 vCenter/iDRAC/스캔을 수집해 중앙으로 push, 또는 중앙이 pull. `CENTRAL_URL`로 중앙을 가리킴. |
| **vCenter / ESXi** | 가상화 관리/하이퍼바이저. REST(`/api`)·SOAP(`/sdk`) HTTPS 443(중계 시 커스텀). 게스트 파일전송은 ESXi 직접. |
| **iDRAC / OME** | Dell 서버 BMC(Redfish 443) / OpenManage Enterprise(OData 443). 전력·하드웨어. |
| **HAProxy 중계 서버** | 직접 못 닿는 망의 SSH/RDP/vCenter/NSX를 TCP 패스스루로 중계. Data Plane API(5555) 또는 SSH(22)로 포탈이 설정. |
| **guacd** | Apache Guacamole 데몬(4822). 브라우저 RDP 게이트웨이 백엔드. |

## 2. 통합 방화벽 매트릭스 (정책 작성용)

### 2-A. 포탈 호스트 — 인바운드(열어야 할 listen 포트)

| 포트 | 프로토콜 | 출발지 | 용도 |
|---|---|---|---|
| **TCP 4000** (`PORT`) | HTTP/HTTPS + WebSocket | 운영자 브라우저 · 엣지 에이전트(→`/api/central`) · 중앙(이 호스트가 수집 에이전트면 `/api/collector`) · Prometheus(`/metrics`) · 에이전트(`/dl` 업그레이드) | 포탈의 모든 기능(UI·API·원격콘솔·메트릭·업그레이드 소스). 앞단 443 리버스프록시 권장. |

### 2-B. 중앙 포탈 — 아웃바운드(인프라로 나가는 통신)

| 대상 | 포트 | 프로토콜 | 용도 | 변경 |
|---|---|---|---|---|
| vCenter | **443** (중계 시 커스텀 예 4065) | HTTPS REST+SOAP | 인벤토리·메트릭·연결테스트 | `vcenters.json` host |
| ESXi 호스트 | **443** | HTTPS/TLS | VM콘솔 thumbprint·게스트 파일전송 | — |
| iDRAC | **443** | HTTPS Redfish | 전력·온도·하드웨어 | host URL |
| OME | **443** | HTTPS OData | DC 전체 전력 | host URL |
| HAProxy Data Plane API | **5555** | HTTP/HTTPS | 원격접속 매핑 프로비저닝 | `HAPROXY_DATAPLANE_URL` |
| HAProxy 서버 SSH | **22** | SSH/SFTP | HAProxy 설정 배포·probe·에이전트 배포 | `PROXY_SSH_PORT` |
| HAProxy frontend(publicPort) | **20000+**(동적) | TCP | SSH 게이트웨이 다이얼 | `PROXY_PUBLIC_PORT_BASE` |
| guacd | **4822** | TCP(guac) | RDP 게이트웨이 | `GUACD_PORT` |
| AD/LDAP | **389**(LDAP) / **636**(LDAPS) | LDAP(S) | 사용자 인증 | `AD_URL` |
| Ollama LLM | **11434** | HTTP | 자연어 검색 해석 | `OLLAMA_URL` |
| NSX Manager | **443**(중계 시 publicPort) | HTTPS | NSX 인벤토리/보안 | nsx.json |
| Slack/Webhook | **443** | HTTPS | 알림 | alerts.json |
| (SMTP 게이트웨이) | **25/465/587** | SMTP | 이메일 알림(현재 미구현, Webhook 권장) | — |
| GitHub Releases / LAN 미러 | **443** | HTTPS | 원격 업그레이드 다운로드 | `PACKAGE_BASE_URL`/`UPGRADE_REMOTE_BASE` |
| 수집/엣지 에이전트 | 에이전트 **4000** | HTTPS | 전력 pull(`/export`)·업그레이드 push | 등록 URL/`UPGRADE_EDGES` |
| IP 스캔 대상 | **22,80,443,445,3389,623,8006,902,5985,5986** | TCP | IP 능동 스캔 | 스캔설정 ports |
| DNS 리졸버 | **53** | DNS(UDP/TCP) | 역DNS(호스트명) | OS resolver |
| 게스트 VM/물리서버 | **22** | SSH | GPU/실제OS 수집·tcpdump | 게스트설정 sshPort |
| ping 대상 | **ICMP** + TCP **445,3389,22,80,443,135** | ICMP/TCP | 도달성/RTT | — |

### 2-C. 엣지(분산) 에이전트 — 아웃바운드

| 대상 | 포트 | 프로토콜 | 용도 |
|---|---|---|---|
| 중앙 포탈 | **4000**(`CENTRAL_URL`) | HTTPS | 모든 위임 push/pull(`/api/central/*`, `X-Central-Token`) |
| 로컬 vCenter | **443** | HTTPS | 사이트 인벤토리(`AGENT_PUSH_INVENTORY`) |
| 로컬 iDRAC/OME | **443** | HTTPS | 현장 전력 수집(중앙은 결과만 pull) |
| 로컬 스캔/게스트 | **DEFAULT_PORTS / 22** | TCP/SSH | 사이트 IP스캔·GPU/OS 수집 |

### 2-D. 사용자 브라우저 → 인프라(포탈은 URL만 생성)

| 대상 | 포트 | 프로토콜 | 용도 |
|---|---|---|---|
| ESXi 호스트 | **443** | VMRC(`vmrc://`)/WebMKS(HTTPS) | VM 원격 콘솔 |
| HAProxy frontend | **20000+** | RDP | 다운로드한 `.rdp` 직접 접속 |

### 2-E. HAProxy 중계 서버(프록시 박스) 관점

| 방향 | 포트 | 출발/도착 |
|---|---|---|
| 인바운드 | **5555** | 포탈 → Data Plane API |
| 인바운드 | **22** | 포탈 → SSH 설정배포 |
| 인바운드 | **20000+**(동적) | 포탈 게이트웨이/사용자 → frontend |
| 아웃바운드 | 대상 **22(SSH)/3389(RDP)/443(vCenter·NSX, 커스텀 가능)** | HAProxy backend → 실제 대상 |

---

## 3. 도메인별 상세 통신표 (근거 파일 포함)

### ① 포탈 ↔ vCenter / ESXi (10)

| # | 출발(연결 시작) | 도착 | 방향 | 프로토콜 | 포트 | 기본 | 환경변수/설정 | 용도 | 근거 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Central/Edge Portal (Store 폴링 collector) | vCenter (REST API) | outbound | HTTPS/REST (vSphere Automation /api, undici fetch) | 443 (기본) — HAProxy 중계 시 host에 :커스텀포트 포함 가능 | 443 | host는 config/vcenters.json의 vc.host(https://host[:port]). VC_TLS_REJECT_UNAUTHORIZED, VC_TLS_MIN_VERSION, VC_TLS_CIPHERS, VC_KEEPALIVE_MS | REST 세션 로그인(POST /api/session) 후 host/cluster/vm/datastore/network 목록 수집. SOAP 미가용 시 폴백 경로 | server/src/vcenter/restClient.js:54-115, 136-207 |
| 2 | Central/Edge Portal (Store 폴링 collector — 기본 경로) | vCenter (vim25 SOAP /sdk) | outbound | HTTPS/SOAP (vim25, PropertyCollector·PerformanceManager·EventManager) | 443 (기본) — HAProxy 중계 시 host의 :커스텀포트 | 443 | VC_SOAP_METRICS(기본 on), 타임아웃 vc.timeoutMs(vcenters.json), POLL_INTERVAL_MS, vc.pollIntervalSec | 실 메트릭 수집(호스트/VM CPU·메모리·전력·GPU·온도·HBA, 데이터스토어, 이벤트 로그). 기본 수집 경로(VC_SOAP_METRICS!=false) | server/src/vcenter/soapClient.js:86-104, 811-840; server/src/store.js:105 collectFromVCenter |
| 3 | Central/Edge Portal (admin /vcenters/test, /vcenters/test-all) | vCenter (REST API) | outbound | HTTPS/REST (POST /api/session 로그인→로그아웃) | 443 (기본) — host의 :커스텀포트 | 443 | 엔트리 host(https://host[:port]); 같은 전역 undici Agent/TLS 설정 | 연결성 테스트: vCenter REST 세션 로그인/로그아웃 성공 여부 + 소요 ms 측정 | server/src/routes/admin.js:704-724; server/src/vcenter/registry.js:158-177 |
| 4 | Central/Edge Portal (admin /vcenter/relay-test, test-all 실패 시) | vCenter 또는 중계 HAProxy 엔드포인트 | outbound | TCP → TLS → HTTPS(GET /sdk) 3단계 분리 진단 | 443 (기본) — host의 :커스텀포트(HAProxy frontend) | 443 | host(쿼리 ?host= 또는 ?vcenterId=로 등록 vc.host 조회). 단계별 timeoutMs 기본 6000 | 중계 경로 단계별 진단: TCP 연결→TLS 핸드셰이크→HTTP 응답 어디서 막혔는지(예: TCP OK인데 TLS 무응답=HAProxy frontend만 살고 backend 끊김) | server/src/vcenter/relayProbe.js:12-73; server/src/routes/admin.js:149-159 |
| 5 | Central/Edge Portal (VM 콘솔 URL 생성 시 getThumbprint) | ESXi 호스트 (vCenter 아님) | outbound | TLS (raw socket, 인증서 fingerprint만 획득) | 443 (기본) — vc.host의 :커스텀포트 파싱 | 443 | host=vc.host에서 스킴/포트 분리(hostOnly, port) | HTML5 웹 콘솔(webconsole.html)에 필요한 호스트 TLS 인증서 SHA-1 thumbprint 획득 | server/src/vcenter/soapClient.js:23-37, 45-74 |
| 6 | Browser (포탈이 생성한 콘솔 URL 사용) | ESXi 호스트 (vCenter 아님) | outbound | VMRC(vmrc://) / HTTPS WebMKS(webconsole.html) | 443 (기본) — host[:port] | 443 | hostNoScheme=vc.host(스킴 제거, 포트 포함 가능) | VM 원격 콘솔 열기. clone ticket+thumbprint로 재로그인 없이 접속 | server/src/vcenter/soapClient.js:55-61 |
| 7 | Central/Edge Portal (GPU guestops — SOAP 제어 평면) | vCenter (vim25 SOAP /sdk, GuestOperationsManager) | outbound | HTTPS/SOAP (게스트작업: ValidateCredentialsInGuest, StartProgramInGuest, ListProcessesInGuest, InitiateFileTransfer{From,To}Guest, DeleteFileInGuest) | 443 (기본) — vc.host의 :커스텀포트 | 443 | VimSoapClient(vc) 재사용 → vc.host/sdk, vc.timeoutMs 타임아웃. NamePasswordAuthentication(게스트 계정) | VMware Tools 게스트작업으로 게스트 OS 안에서 nvidia-smi 실행/계정생성/스크립트 실행. SOAP 제어는 vCenter 경유(맞음) | server/src/gpu/guestops.js:18, 29-34, 69-71, 99-102, 184-190, 316-317, 347-348, 354 |
| 8 | Central/Edge Portal (GPU guestops — 파일 전송 데이터 평면) | ESXi 호스트 (1차) / vCenter (폴백) | outbound | HTTPS (GET=다운로드 / PUT=업로드, fetch) | 443 (기본) — InitiateFileTransfer가 돌려준 URL의 호스트:포트 | 443 | InitiateFileTransfer 응답 <url>(원본=ESXi). dlHosts/preferHosts(ESXi IP·FQDN 후보), vcHost 폴백 | 게스트 파일 회수(nvidia-smi 출력 .out/.err, 스크립트 결과) GET / 게스트로 파일 업로드(스크립트/비밀번호 파일) PUT | server/src/gpu/guestops.js:90-156(readGuestFile), 302-330(writeGuestFile), 94 swapHost, 127-128 candidates |
| 9 | Central/Edge Portal (GPU 폴러/이벤트/메트릭 on-demand) | vCenter (vim25 SOAP /sdk) | outbound | HTTPS/SOAP (QueryPerf, CreateCollectorForEvents/ReadNextEvents, UpgradeTools_Task, AcquireCloneTicket) | 443 (기본) — vc.host의 :커스텀포트 | 443 | VimSoapClient(vc) → vc.host/sdk, vc.timeoutMs(없으면 30s) | on-demand 엔티티 메트릭(fetchVm/HostMetric), 이벤트 로그 수집(collectVCenterEvents), VMware Tools 업그레이드, 콘솔 clone ticket — 모두 vCenter SOAP 경유 | server/src/vcenter/soapClient.js:307-325, 665-688, 691-709, 716-743, 375-381 |
| 10 | vcenters.json 설정 / config 로더 (연결 파라미터 정의) | vCenter (모든 위 통신의 host/포트/TLS 결정) | outbound | 설정값(HTTPS host 정규화 + TLS 정책) | 443 (기본) — host에 :커스텀포트 포함 시 HAProxy 중계 | 443 | VC_TLS_REJECT_UNAUTHORIZED, VC_TLS_MIN_VERSION(기본 TLSv1), VC_TLS_CIPHERS(기본 DEFAULT@SECLEVEL=0), VC_SOAP_METRICS, POLL_INTERVAL_MS, CONFIG_DIR | vc.host(https://host[:port]) 정규화 및 vcTls* TLS 호환 설정 제공. 스킴 없으면 https:// 자동 보강 | server/src/config.js:32-38, 200-222 |

### ② 중앙 포탈 ↔ 엣지/수집 에이전트 (25)

| # | 출발(연결 시작) | 도착 | 방향 | 프로토콜 | 포트 | 기본 | 환경변수/설정 | 용도 | 근거 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Central Portal | Portal HTTP Server (self) | inbound | HTTP/HTTPS | 4000 | 4000 | PORT | 포탈 백엔드가 listen하는 메인 포트. 모든 /api/* (collector, central, admin, api 등)와 웹 대시보드가 이 포트로 들어온다. 에이전트의 push/pull, 브라우저 UI, 다른 포탈의 pull이 모두 이 포트로 인바운드. | server/src/index.js:125; server/src/config.js:24 |
| 2 | Central Portal | Collector Agent | outbound | HTTPS/HTTP (GET, JSON) | 에이전트 URL의 포트(기본 4000) | 4000 | COLLECTOR_PULL_INTERVAL_MS / COLLECTOR_TIMEOUT_MS | 중앙이 등록된 각 수집 에이전트의 GET /api/collector/export 를 주기적으로 pull → 에이전트 로컬 iDRAC/OME 전력(byHost)을 받아 공유 state·DB(rmt:<host>)에 병합. 실패는 per-collector 격리. | server/src/collector/puller.js:17 (pullOne); 주기 startCollectorPuller puller.js:53-58 |
| 3 | Central Portal | Collector Agent | outbound | HTTPS/HTTP (GET) | 에이전트 URL의 포트(기본 4000) | 4000 |  | 관리자 '테스트' 버튼용 경량 liveness probe. GET /api/collector/ping → {ok, datacenter, version}. 전력 페이로드 없음. | server/src/routes/collector.js:39 (수신측 핸들러) |
| 4 | Central Portal | Collector Agent | outbound | HTTPS/HTTP (POST, application/gzip) | 에이전트 URL의 포트(기본 4000) | 4000 |  | 중앙이 자기 자신을 업그레이드한 뒤 동일 번들(tar.gz bytes)을 모든 등록 수집 에이전트의 POST /api/collector/upgrade?restart=true 로 push → 에이전트가 self-install 후 재시작. 모든 DC가 같은 버전 유지. | server/src/collector/upgradePush.js:10 (pushBundleToCollector), :30 (pushUpgradeToCollectors); 트리거 upgrade/manager.js:97 pushToCollectors; 수신측 routes/collector.js:47 |
| 5 | Central Portal | Edge Portal (upgrade edges) | outbound | HTTPS/HTTP (POST, application/gzip) | 엣지 URL의 포트(기본 4000) | 4000 | UPGRADE_EDGES | self-upgrade 성공 후 UPGRADE_EDGES에 등록된 엣지 포탈들의 POST /api/upgrade/bundle 로 tar.gz 번들 push → 엣지가 self-install. (collector upgrade와 별개 경로, 사용자 인증 라우터 쪽 엔드포인트) | server/src/upgrade/upgrade.js:357 (pushBundleToEdge), URL :359; 트리거 upgrade/manager.js:107 pushToEdges; 수신측 routes/upgrade.js:55 |
| 6 | Central Portal | New Agent Host (Rocky 9) | outbound | SSH/SFTP (port 22) | 22 | 22 |  | 중앙 포탈이 새 DC 호스트에 오프라인 설치 패키지를 SSH/SFTP로 올리고 install.sh 실행 → portal.env에 에이전트 설정(AGENT_NAME, CENTRAL_URL, CENTRAL_TOKEN, COLLECTOR_TOKEN 등) 주입 → systemctl restart. 포탈에서 무인 에이전트 부트스트랩. | server/src/agent/deploy.js:143 (deployAgent), putFile :160, install :164, env 주입 envPairs :43-67 |
| 7 | Edge/Collection Agent | Central Portal | outbound | HTTPS/HTTP (GET, JSON) | CENTRAL_URL의 포트(기본 4000) | 4000 | CENTRAL_URL / CENTRAL_TOKEN / AGENT_SCAN_INTERVAL_MS / AGENT_NAME | iDRAC 스캔 에이전트가 GET /api/central/assignment?agent=<name> 으로 자기 IP 할당(대역+iDRAC 자격증명)을 pull. 이어 로컬 Redfish 스캔. | server/src/agent/scanner.js:21 (pullAssignment), 주기 startAgentScanner :73; 수신측 routes/central.js:31 |
| 8 | Edge/Collection Agent | Central Portal | outbound | HTTPS/HTTP (POST, JSON) | CENTRAL_URL의 포트(기본 4000) | 4000 | CENTRAL_URL / CENTRAL_TOKEN | iDRAC 스캔 에이전트가 스캔 요약·발견목록을 POST /api/central/result 로 회신(scanned, found[], unreachable, notIdrac, authFailed, durationMs). | server/src/agent/scanner.js:28 (postResult), 호출 :48; 수신측 routes/central.js:40 |
| 9 | Edge/Collection Agent | Central Portal | outbound | HTTPS/HTTP (GET, JSON) | CENTRAL_URL의 포트(기본 4000) | 4000 | CENTRAL_URL / CENTRAL_TOKEN / AGENT_IDRAC_SCAN_POLL_MS | 위임 iDRAC 온디맨드 스캔: 에이전트가 GET /api/central/idrac-scan-jobs?agent=<name> 으로 대기 잡(스캔/등록)을 인출(짧은 폴링). | server/src/agent/idracScanWorker.js:38, 주기 startIdracScanWorker :87; 수신측 routes/central.js:78 |
| 10 | Edge/Collection Agent | Central Portal | outbound | HTTPS/HTTP (POST, JSON) | CENTRAL_URL의 포트(기본 4000) | 4000 | CENTRAL_URL / CENTRAL_TOKEN | 위임 iDRAC 스캔 진행률 중간보고 POST /api/central/idrac-scan-progress ({reqId, scanned, total}) → UI 프로세스 바. | server/src/agent/idracScanWorker.js:29 (postProgress); 수신측 routes/central.js:85 |
| 11 | Edge/Collection Agent | Central Portal | outbound | HTTPS/HTTP (POST, JSON) | CENTRAL_URL의 포트(기본 4000) | 4000 | CENTRAL_URL / CENTRAL_TOKEN | 위임 iDRAC 스캔 결과/등록결과를 POST /api/central/idrac-scan-result ({reqId, agent, scanned, found[], registered, error?}) 로 reqId와 함께 회신. | server/src/agent/idracScanWorker.js:23 (postResult), 호출 :51,:71,:75; 수신측 routes/central.js:96 |
| 12 | Edge/Collection Agent | Central Portal | outbound | HTTPS/HTTP (GET, JSON) | CENTRAL_URL의 포트(기본 4000) | 4000 | CENTRAL_URL / CENTRAL_TOKEN / AGENT_SCAN_INTERVAL_MS | IP 스캔 위임: 에이전트가 GET /api/central/ip-scan-assignment?agent=<name> 으로 TCP 커넥트 스캔 설정(ranges, ports, concurrency, timeoutMs, reverseDns)을 pull. | server/src/agent/ipScanWorker.js:22, 주기 startIpScanAgent :38; 수신측 routes/central.js:192 |
| 13 | Edge/Collection Agent | Central Portal | outbound | HTTPS/HTTP (POST, JSON) | CENTRAL_URL의 포트(기본 4000) | 4000 | CENTRAL_URL / CENTRAL_TOKEN | IP 스캔 결과 보고 POST /api/central/ip-scan-result ({agent, alive[], scanned}) → 중앙이 IP 대장(scanStore)에 병합. | server/src/agent/ipScanWorker.js:30; 수신측 routes/central.js:201 (mergeScanResults) |
| 14 | Edge/Collection Agent | Central Portal | outbound | HTTPS/HTTP (POST, JSON) | CENTRAL_URL의 포트(기본 4000) | 4000 | AGENT_PUSH_INVENTORY / CENTRAL_URL / CENTRAL_TOKEN / AGENT_INVENTORY_INTERVAL_MS | 사이트 위임 수집: 현장 서버가 로컬 vCenter 인벤토리를 vCenter별로 잘라 POST /api/central/inventory 로 push(hosts/vms/datastores/networks/alarms). 중앙↔원격vCenter RTT 제거(단방향 아웃바운드, NAT/폐쇄망 유리). | server/src/agent/inventoryPush.js:33 (pushVcenter), 주기 startInventoryPush :54; 수신측 routes/central.js:59 (setInventory) |
| 15 | Edge/Collection Agent | Central Portal | outbound | HTTPS/HTTP (POST, JSON) | CENTRAL_URL의 포트(기본 4000) | 4000 | CENTRAL_URL / CENTRAL_TOKEN / AGENT_INVENTORY_INTERVAL_MS | 게스트 GPU 수집 위임: ESXi 망에 닿는 현장 agent가 게스트 OS(nvidia-smi) GPU 사용률+진단을 POST /api/central/gpu-guest-data ({agent, hosts[], vms[], diag}) 로 push. 중앙은 게스트 오버레이로 표시. | server/src/agent/gpuGuestPush.js:31, 주기 startGpuGuestPush :49; 수신측 routes/central.js:108 (setGuestGpu) |
| 16 | Edge/Collection Agent | Central Portal | outbound | HTTPS/HTTP (GET, JSON) | CENTRAL_URL의 포트(기본 4000) | 4000 | CENTRAL_URL / CENTRAL_TOKEN / AGENT_PING_POLL_MS | 위임 Ping: 에이전트가 GET /api/central/ping-jobs?vcenters=<id,id> 로 자기 담당 vCenter들의 대기 ping IP를 인출. | server/src/agent/pingWorker.js:24, 주기 startPingWorker :41; 수신측 routes/central.js:123 |
| 17 | Edge/Collection Agent | Central Portal | outbound | HTTPS/HTTP (POST, JSON) | CENTRAL_URL의 포트(기본 4000) | 4000 | CENTRAL_URL / CENTRAL_TOKEN | 위임 Ping 결과 보고 POST /api/central/ping-result ({vcenterId, results:[{ip,alive,rttMs}]}) → UI가 VM 상세에서 녹/적 표시. | server/src/agent/pingWorker.js:32; 수신측 routes/central.js:131 (setPingResults) |
| 18 | Edge/Collection Agent | Central Portal | outbound | HTTPS/HTTP (POST, JSON) | CENTRAL_URL의 포트(기본 4000) | 4000 | CENTRAL_URL / CENTRAL_TOKEN / AGENT_CONFIG_PUSH_MS | 엣지 설정 push: 에이전트가 자기 CONFIG_DIR의 *.json/*.env 설정을 POST /api/central/agent-config ({agent, files{name:content}}) 로 보내 중앙 통합 백업에 합침. 시작 시 + 주기 + fs.watch 변경 디바운스 시. | server/src/agent/configPush.js:23, 주기/감시 startConfigPush :32; 수신측 routes/central.js:142 (setAgentConfig) |
| 19 | Edge/Collection Agent | Central Portal | outbound | HTTPS/HTTP (GET, JSON) | CENTRAL_URL의 포트(기본 4000) | 4000 | CENTRAL_URL / CENTRAL_TOKEN / AGENT_LOGQ_POLL_MS | 엣지 로그 연합 조회: 에이전트가 GET /api/central/log-queries?vcenters=<id,id> 로 자기 vCenter들의 대기 로그 조회를 인출. | server/src/agent/logQueryWorker.js:22, 주기 startLogQueryWorker :41; 수신측 routes/central.js:158 |
| 20 | Edge/Collection Agent | Central Portal | outbound | HTTPS/HTTP (POST, JSON) | CENTRAL_URL의 포트(기본 4000) | 4000 | CENTRAL_URL / CENTRAL_TOKEN | 엣지 로그 조회 결과 보고 POST /api/central/log-query-result ({reqId, vcenterId, total, rows, dbKind}). 데이터는 엣지에 남고 결과 페이지만 중계. | server/src/agent/logQueryWorker.js:32; 수신측 routes/central.js:165 (setLogQueryResult) |
| 21 | Edge/Collection Agent | Central Portal | outbound | HTTPS/HTTP (GET, JSON) | CENTRAL_URL의 포트(기본 4000) | 4000 | CENTRAL_URL / CENTRAL_TOKEN / AGENT_CAPTURE_POLL_MS | 위임 tcpdump 캡처: 에이전트가 GET /api/central/capture-jobs?agent=<name> 으로 대기 캡처 작업을 인출(사설망 서버에 닿는 엣지가 대행). | server/src/agent/captureWorker.js:21, 주기 startCaptureWorker :51; 수신측 routes/central.js:175 |
| 22 | Edge/Collection Agent | Central Portal | outbound | HTTPS/HTTP (POST, JSON) | CENTRAL_URL의 포트(기본 4000) | 4000 | CENTRAL_URL / CENTRAL_TOKEN | 위임 캡처 결과 보고 POST /api/central/capture-result ({reqId, result}). 성공 시 중앙이 captureHistory에 기록. | server/src/agent/captureWorker.js:41; 수신측 routes/central.js:181 (setCaptureResult/recordCapture) |
| 23 | Edge/Collection Agent | Central Portal (/api/central/*) | inbound | HTTPS/HTTP | 4000 | 4000 | PORT / CENTRAL_TOKEN | 중앙 측 수신 엔드포인트 집합: /api/central/{assignment, result, inventory, idrac-scan-jobs, idrac-scan-progress, idrac-scan-result, gpu-guest-data, ping-jobs, ping-result, agent-config, log-queries, log-query-result, capture-jobs, capture-result, ip-scan-assignment, ip-scan-result}. 사용자 인증 밖, X-Central-Token으로만 게이트. | server/src/routes/central.js:22-209; 마운트 server/src/index.js:83 (app.use('/api/central', centralRouter)) |
| 24 | Central Portal (puller) / Collector Agent | Collector Agent (/api/collector/*) | inbound | HTTPS/HTTP | 4000 | 4000 | PORT / COLLECTOR_TOKEN | 수집 에이전트 측 수신 엔드포인트: GET /api/collector/export(전력), GET /api/collector/ping(liveness), POST /api/collector/upgrade(번들 self-install). 사용자 인증 밖, X-Collector-Token으로만 게이트. | server/src/routes/collector.js:24,39,47; 마운트 server/src/index.js:82 (app.use('/api/collector', collectorRouter)) |
| 25 | Central Portal (upgrade edges) | Edge Portal (/api/upgrade/bundle) | inbound | HTTPS/HTTP | 4000 | 4000 | PORT | 엣지 포탈 측 업그레이드 번들 수신 엔드포인트 POST /api/upgrade/bundle (application/gzip raw, 256MB). 받아서 self-install + 옵션 재시작. | server/src/routes/upgrade.js:55; 마운트 server/src/index.js:87 (app.use('/api/upgrade', authMiddleware, upgradeRouter)) |

### ③ 포탈/에이전트 ↔ iDRAC / OME (전력·하드웨어) (9)

| # | 출발(연결 시작) | 도착 | 방향 | 프로토콜 | 포트 | 기본 | 환경변수/설정 | 용도 | 근거 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Central Portal (포탈 프로세스 내 idrac poller) | iDRAC (Dell server, type='idrac') | outbound | HTTPS / Redfish (REST, Basic Auth) | 443 | 443 | IDRAC_POLL_INTERVAL_MS(주기), IDRAC_TIMEOUT_MS(타임아웃). 포트는 host URL에 포함(https:// 보강 시 443 기본) | 전력 수집: GET /redfish/v1/Chassis -> 각 Chassis/Power 의 PowerControl[].PowerConsumedWatts 합산. 매 폴링 주기(기본 60초)마다 등록된 enabled iDRAC 전체를 Promise.all로 병렬 호출, per-request 타임아웃(IDRAC_TIMEOUT_MS, 기본 15초). 신원(Model/ServiceTag/PowerState)도 best-effort 수집. | server/src/idrac/poller.js:44, server/src/idrac/redfish.js:35,52-67 |
| 2 | Central Portal (idrac poller, 센서 수집) | iDRAC (Dell server) | outbound | HTTPS / Redfish (REST, Basic Auth) | 443 | 443 | IDRAC_TIMEOUT_MS | 온도/팬/CPU사용률 수집: GET /redfish/v1/Chassis/<id>/Thermal (Temperatures[], Fans[]) + GET /redfish/v1/TelemetryService/MetricReports/SystemUsage (CPU 사용률, Dell 텔레메트리 가용 시). 매 폴링 주기(1분)마다 fetchSensors로 시계열 적재. 전력 수집과 격리(센서 실패해도 전력은 무관). | server/src/idrac/poller.js:47, server/src/idrac/redfish.js:561-608 |
| 3 | Central Portal (idrac poller, 인벤토리 수집) | iDRAC (Dell server) | outbound | HTTPS / Redfish (REST, Basic Auth) | 443 | 443 | IDRAC_TIMEOUT_MS | 하드웨어/펌웨어 인벤토리(저빈도, 최대 30분마다): Systems, Managers, EthernetInterfaces, Bios, Chassis/Power(PSU·PowerCap), Storage(디스크), Memory(DIMM), Processors(GPU), LogServices/Sel\|Lclog(이벤트), LicenseService/Licenses, AccountService/Accounts, UpdateService/FirmwareInventory. fetchInventory가 다수 Redfish 서브리소스를 순차 GET. | server/src/idrac/poller.js:49-50, server/src/idrac/redfish.js:152-442,448-472 |
| 4 | Central Portal (registry testServer / probeGpuTelemetry) | iDRAC (Dell server) | outbound | HTTPS / Redfish (REST, Basic Auth) | 443 | 443 | IDRAC_TIMEOUT_MS | 온디맨드 연결 테스트(fetchPower+fetchInventory) 및 GPU 텔레메트리 가용성 실측(Systems/Processors -> ProcessorMetrics, TelemetryService/MetricReports GPU 리포트). UI '테스트' 버튼/GPU 진단 시. | server/src/idrac/registry.js:296-299, server/src/idrac/redfish.js:497-554 |
| 5 | Central Portal (idrac scan, 로컬 직접) 또는 Edge Agent (위임 scan worker) | iDRAC 후보 IP (스캔 대상 대역) | outbound | HTTPS / Redfish probe (REST, Basic Auth) | 443 | 443 | perHostTimeout 기본 3000ms(고정 인자), concurrency 기본 32. 포트는 IP에 https:// 보강(443) — 명시 포트 입력 가능 | iDRAC 스캔 probe: GET /redfish/v1 (no-auth, Redfish 서비스루트 + Dell 시그니처 판별) → GET /redfish/v1/Systems + Systems/<id> (auth, 신원/서비스태그 확인). expandIpList로 IP 전개(단일/범위/CIDR, 최대 2048), bounded concurrency(기본 32), per-host 짧은 타임아웃(기본 3000ms). Dell iDRAC만 골라냄. | server/src/idrac/scan.js:10-51, server/src/idrac/redfish.js:105-144 |
| 6 | Central Portal (idrac poller, OME 수집) | OME (Dell OpenManage Enterprise, type='ome') | outbound | HTTPS / OME REST API (OData v4, X-Auth-Token 세션 또는 Basic 폴백) | 443 | 443 | OME_POWER_PLUGIN_ID(기본 2F6D05BE-...), OME_POWER_METRIC_TYPES(기본 '3,4,1'), OME_POWER_DURATION(기본 0), IDRAC_TIMEOUT_MS. 포트는 host URL 포함(기본 443) | OME 1대로 DC 전체 장비 전력 수집. POST /api/SessionService/Sessions(로그인 → X-Auth-Token) → GET /api/DeviceService/Devices(페이지네이션 $top=200) → POST /api/MetricService/Metrics(Power Manager 플러그인 per-device 전력). 미가용 시 GET /api/DeviceService/Devices(id)/PowerUsage\|SystemPowerConsumption 폴백. 장비별 watts를 DB에 적재. | server/src/idrac/poller.js:34-42, server/src/idrac/ome.js:69-187 |
| 7 | Central Portal (registry testOme) | OME | outbound | HTTPS / OME REST API (OData v4) | 443 | 443 | IDRAC_TIMEOUT_MS | OME 온디맨드 연결 테스트: login + listDevices(count) + 샘플 장비 전력 1건(metric 또는 device 폴백). UI '테스트' 시. | server/src/idrac/ome.js:190-205, server/src/idrac/registry.js:293-294 |
| 8 | Edge Agent (idracScanWorker, CENTRAL_URL 설정된 현장 에이전트) | Central Portal (/api/central/*) | outbound | HTTPS / HTTP (포탈 REST API, X-Central-Token 헤더) | 포탈 PORT (기본 4000) | 4000 | CENTRAL_URL(중앙 base URL — 비면 에이전트 비활성), CENTRAL_TOKEN(=X-Central-Token), AGENT_NAME, AGENT_IDRAC_SCAN_POLL_MS(기본 5000), AGENT_AUTO_REGISTER. 포트는 CENTRAL_URL에 포함(스킴/포트 그대로) | 위임 스캔 잡 인출/회신: 짧은 주기(기본 5초)로 GET /api/central/idrac-scan-jobs?agent=NAME(자기 이름 잡 인출) → 로컬 Redfish 스캔 실행 → POST /api/central/idrac-scan-progress(진행률, 1.5s 스로틀) → POST /api/central/idrac-scan-result(reqId, found 목록·요약). autoRegister 시 현지 레지스트리 등록 후 pollNow(). | server/src/agent/idracScanWorker.js:24-92, server/src/central/idracScanJobs.js:69-126, server/src/routes/central.js:78-103 |
| 9 | Central Portal (collector puller) | Edge Agent (수집 에이전트 /api/collector/export) | outbound | HTTPS / 포탈 REST API (COLLECTOR_TOKEN 가드) | 에이전트 PORT (기본 4000) | 4000 | COLLECTOR_TOKEN, COLLECTOR_PULL_INTERVAL_MS(기본 60초), COLLECTOR_TIMEOUT_MS(기본 20초). 포트는 등록된 collector url에 포함 | 위임 수집 결과 병합: 중앙이 등록된 collector 에이전트의 GET /api/collector/export를 주기적으로 pull. 각 에이전트가 자기 로컬 iDRAC/OME에서 수집한 host→power 결과를 중앙이 가져와 remotePowerByHost로 병합(최신 ts 우선). 고RTT 원격 사이트 iDRAC는 현장 에이전트가 전담 수집하고 중앙은 결과만 당겨옴. | server/src/collector/puller.js:17, server/src/idrac/service.js:80-89,142-147 |

### ④ 원격 접속(브라우저 SSH/RDP) + HAProxy 중계 (10)

| # | 출발(연결 시작) | 도착 | 방향 | 프로토콜 | 포트 | 기본 | 환경변수/설정 | 용도 | 근거 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Browser (xterm.js) | Portal (sshGateway WebSocketServer) | bidirectional | WebSocket (ws/wss, text+JSON 제어 프레임) — HTTP Upgrade | 4000 (포탈 HTTP 포트와 동일) | 4000 | PORT (config.js:24, 기본 4000) | 브라우저 SSH 콘솔. URL /api/remote/ssh 로 Upgrade. ?token=JWT 쿼리파라미터로 인증(브라우저는 WS 헤더 설정 불가). 클라이언트 {type:'auth',mappingId,username,password} → 키스트로크 {type:'data'} / {type:'resize'}, 서버는 stdout 청크/상태 전송 | server/src/proxy/sshGateway.js:20-33, server/src/index.js:142 |
| 2 | Browser (guacamole-common-js / Guacamole.Client) | Portal (guacdTunnel WebSocketServer) | bidirectional | WebSocket (Guacamole protocol 텍스트 명령 스트림) — HTTP Upgrade | 4000 (포탈 HTTP 포트와 동일) | 4000 | PORT (config.js:24, 기본 4000) | 브라우저 RDP 콘솔. URL /api/remote/rdp 로 Upgrade. ?token=JWT + mappingId/username/password/domain/width/height/security 쿼리파라미터. 포탈이 guacd 핸드셰이크(select→args→size/audio/video/image→connect→ready) 수행 후 양방향 중계 | server/src/proxy/guacdTunnel.js:45-55, server/src/index.js:143 |
| 3 | Portal (dataplane.js fetch 클라이언트) | HAProxy Data Plane API (프록시 호스트) | outbound | HTTP 또는 HTTPS (REST/JSON, Basic Auth) — dp.url 스킴에 따름 | 5555 (관례적 기본; 코드 하드코딩 없음, dp.url 로 지정) | 5555 | HAPROXY_DATAPLANE_URL (예 http://proxy:5555), HAPROXY_DATAPLANE_BASE(/v3), HAPROXY_DATAPLANE_USER, HAPROXY_DATAPLANE_PASS (registry.js:20-23) | 매핑별 TCP frontend+backend 동적 프로비저닝. 트랜잭션(POST /transactions → 변경 → PUT commit = graceful reload). 경로 {url}{basePath}/services/haproxy, basePath 기본 /v3 (3.x) 또는 /v2 (2.x). 15초 타임아웃 | server/src/proxy/dataplane.js:11-31, server/src/proxy/registry.js:18-25 |
| 4 | Portal (sshExec.js / deploy.js, ssh2 클라이언트) | 프록시 호스트 SSH (HAProxy 서버) | outbound | SSH (ssh2) + SFTP. password 또는 privateKey, keyboard-interactive 지원 | 22 (deploy.port, 기본 22) | 22 | PROXY_SSH_HOST, PROXY_SSH_PORT(22), PROXY_SSH_USER, PROXY_SSH_PASS, PROXY_HAPROXY_CFG(/etc/haproxy/haproxy.cfg), PROXY_VALIDATE_CMD, PROXY_RELOAD_CMD (registry.js:29-37) | Data Plane API 대안 — SSH 자동배포. haproxy.cfg 읽기(SFTP)→관리 블록 splice→임시파일 기록→haproxy -c 검증→백업(cp)→교체(mv)→reload(systemctl reload haproxy). /probe 도 동일 SSH로 대상 ping/포트체크 실행 | server/src/proxy/sshExec.js:9-23, server/src/proxy/deploy.js:48-79, server/src/routes/remote.js:47-54 |
| 5 | HAProxy frontend (동적 bind) | 공개 프론트엔드 포트 (사용자/포탈 게이트웨이 접속점) | inbound | TCP (mode tcp, option tcplog) — SSH 또는 RDP 페이로드 패스스루 | 20000+ (동적 할당, 범위: publicPortBase 부터 1씩 증가) | 20000 | PROXY_PUBLIC_PORT_BASE(기본 20000), publicPortBase(프록시별 설정 가능). bind 주소 dataplane.bindAddress (registry.js:40,109,183-189) | 매핑마다 HAProxy 에 공개 TCP frontend 를 동적 생성. 프록시별로 미사용 포트를 base(기본 20000)부터 탐색해 할당(nextPublicPort). 프록시가 다르면 같은 포트 재사용 가능. bind 주소는 dataplane.bindAddress(기본 '*') | server/src/proxy/registry.js:183-200, server/src/proxy/dataplane.js:64-75, server/src/proxy/deploy.js:14-27 |
| 6 | Portal SSH 게이트웨이 (sshGateway.js, ssh2) | HAProxy frontend → 대상 호스트 SSH | outbound | SSH (ssh2). proxyHost:publicPort 로 다이얼(프록시 경유), 매핑 없으면 직접 targetHost:targetPort | 20000+ (proxyHost 있을 때 m.publicPort) / 대상 SSH 22 (직접일 때 m.targetPort) | 22 | PROXY_PUBLIC_HOST(proxyHost). 대상 SSH 포트는 매핑별 targetPort(기본 PROTO_PORT.ssh=22) (registry.js:39,191; sshGateway.js:62-64) | 브라우저 SSH 세션의 실제 백엔드 연결. 포탈은 글로벌 프록시 경유로만 대상 도달 가능하므로 proxyHost:publicPort 로 접속. HAProxy backend(server target <targetHost>:<targetPort>)가 실제 대상 SSH(기본 22)로 전달 | server/src/proxy/sshGateway.js:62-64,120-124, server/src/proxy/registry.js:191 |
| 7 | Portal RDP 게이트웨이 (guacdTunnel.js, net.connect) | guacd (Apache Guacamole proxy daemon) | outbound | TCP (Guacamole wire protocol, 평문) | 4822 (proxy.guacd.port, 기본 4822) | 4822 | GUACD_HOST, GUACD_PORT(기본 4822) — 프록시별 guacd.host/guacd.port 설정 가능 (registry.js:41) | RDP 게이트웨이. 포탈이 guacd 로 TCP 연결해 select 'rdp' → 핸드셰이크 → connect(설정: hostname=proxyHost, port=publicPort, username/password/domain/security/ignore-cert). guacd 가 실제 RDP를 수행하고 그 화면 스트림을 브라우저로 중계 | server/src/proxy/guacdTunnel.js:62-77, server/src/proxy/registry.js:41 |
| 8 | guacd | HAProxy frontend → 대상 호스트 RDP | outbound | RDP (guacd 가 수립). 연결 대상은 proxyHost:publicPort (프록시 경유), 매핑 없으면 targetHost:targetPort | 20000+ (proxyHost 있을 때 publicPort) / 대상 RDP 3389 (직접일 때 targetPort) | 3389 | PROXY_PUBLIC_HOST(proxyHost). 대상 RDP 포트는 매핑별 targetPort(기본 PROTO_PORT.rdp=3389) (registry.js:191; guacdTunnel.js:64-65) | guacd 가 받은 connect 설정의 hostname=proxyHost, port=publicPort 로 RDP 접속. HAProxy backend 가 실제 대상 RDP(기본 3389, 비표준 가능)로 패스스루 | server/src/proxy/guacdTunnel.js:64-71, server/src/proxy/registry.js:191 |
| 9 | Browser / RDP 클라이언트 (mstsc) | HAProxy frontend (다운로드한 .rdp) | outbound | RDP (클라이언트측 직접 접속, .rdp 파일) | 20000+ (proxyHost 있을 때 publicPort) / 대상 3389 (직접) | 3389 | PROXY_PUBLIC_HOST(proxyHost), publicPort(동적) | GET /api/remote/rdp/:id 가 full address:s:<proxyHost>:<publicPort> 를 가리키는 .rdp 파일을 생성·다운로드. 사용자가 로컬 RDP 클라이언트로 HAProxy frontend 에 직접 접속(브라우저 게이트웨이 대안) | server/src/routes/remote.js:202-219 |
| 10 | Portal 매핑 등록 (registry.js) | 프로토콜 기본 포트 매핑(내부 상수) | outbound | 내부 상수 — 대상 포트 결정 로직 | ssh=22, rdp=3389, nsx=443 | 22/3389/443 |  | PROTO_PORT 상수. 매핑 생성 시 targetPort 미지정이면 프로토콜별 기본값 사용. nsx 는 HTTPS API(TCP 패스스루) 경유용으로 443 | server/src/proxy/registry.js:191,195-196 |

### ⑤ 부가 서비스(AD/LDAP · LLM · NSX · 알림 · 업그레이드 · 메트릭) (15)

| # | 출발(연결 시작) | 도착 | 방향 | 프로토콜 | 포트 | 기본 | 환경변수/설정 | 용도 | 근거 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Portal (server) | Active Directory / LDAP DC | outbound | LDAP | 389 | 389 | AD_URL(ldap://dc:389), AD_ENABLED, AD_DOMAIN, AD_BASE_DN, AD_USER_FILTER, AD_ADMIN_GROUP, AD_OPERATOR_GROUP, AD_VIEWER_GROUP, AD_DEFAULT_ROLE, AD_TIMEOUT_MS | 사용자 인증 — UPN simple bind(<user>@domain)으로 비밀번호 검증 후 memberOf 조회→포탈 역할(admin/operator/viewer) 매핑. ldapjs createClient. | server/src/auth/ad.js:22, 66-74, 103-126 |
| 2 | Portal (server) | Active Directory / LDAP DC (TLS) | outbound | LDAPS | 636 | 636 | AD_URL(ldaps://dc:636), AD_TLS_REJECT_UNAUTHORIZED(기본 false=검증 안함) | 동일 AD 인증을 TLS로. ldaps:// URL 사용 시. 자가서명 인증서 검증은 AD_TLS_REJECT_UNAUTHORIZED로 제어(tlsOptions.rejectUnauthorized). | server/src/auth/ad.js:22, 30, 71 |
| 3 | Portal (server) | Ollama LLM 서버 | outbound | HTTP | 11434 | 11434 | OLLAMA_URL(기본 http://localhost:11434), OLLAMA_MODEL(기본 llama3.1), LLM_ENABLED, LLM_TIMEOUT_MS | 자연어 검색 질의 '해석'만 LLM에 전송(POST /api/generate, GET /api/tags 연결테스트). 실제 인프라 데이터는 포탈을 벗어나지 않음. | server/src/llm/ollama.js:3-31, server/src/llm/config.js:16-17 |
| 4 | Portal (server) | 원격 LLM 호스트 (SSH) | outbound | SSH | 22 | 22 | —(target.host/port/username/password/privateKey는 API 입력값) | 에어갭 환경에서 별도 서버에 Ollama 설치 — SSH로 useradd, tar 추출/SFTP putFile(오프라인 tgz), systemd 서비스 등록(OLLAMA_HOST=0.0.0.0:11434), 모델 pull. 설치 후 포탈 LLM config를 http://<host>:11434로 지정. | server/src/llm/ollamaDeploy.js:39, 41-88, 18-37 |
| 5 | 원격 LLM 호스트 (online 설치 시) | ollama.com | outbound | HTTPS | 443 | 443 | — | online 설치 모드에서 대상 서버가 공식 설치 스크립트를 내려받아 실행(curl -fsSL https://ollama.com/install.sh \| sh). | server/src/llm/ollamaDeploy.js:65 |
| 6 | Portal (server) | NSX Manager (NSX-T / 4.x Manager appliance) | outbound | HTTPS | 443 | 443 | —(NSX Manager host/username/password/timeoutMs는 CONFIG_DIR/nsx.json, 설정 UI에서 관리) | NSX 인벤토리/보안 수집 — HTTP Basic 인증으로 Manager API(/api/v1: node, cluster/status, transport-nodes, IDS events)와 Policy API(/policy/api/v1: tier-0s/1s, segments, security-policies, groups, DFW rules) 조회. fetch + AbortSignal.timeout. | server/src/nsx/client.js:35, 39-72, 97-214, server/src/nsx/registry.js:53 |
| 7 | Portal (server) | HAProxy 중계 서버 (NSX 프록시 경유 시) | outbound | HTTPS(TCP 패스스루) | publicPort(동적 할당) |  | —(proxyId는 nsx.json 항목; publicPort는 proxy/registry가 할당) | 직접 닿지 않는 타 법인 NSX Manager를 등록된 HAProxy frontend로 다이얼. 프록시에 NSX:443 TCP 패스스루 매핑을 보장/프로비저닝하고 baseUrl=https://proxyHost:publicPort로 접속(TLS 종단은 NSX). | server/src/nsx/proxy.js:28-42, server/src/nsx/client.js:31-34 |
| 8 | Portal (server) | Slack Incoming Webhook | outbound | HTTPS | 443 | 443 | —(채널 url은 CONFIG_DIR/alerts.json, 설정 UI에서 관리) | 알림 — 임계/조건 규칙 발화 시 Slack incoming webhook으로 JSON POST({ text }). 알림엔진 tick 주기 평가. | server/src/alerts.js:186-198, 192-193 |
| 9 | Portal (server) | 일반 Webhook 수신처 | outbound | HTTPS/HTTP | 443 | 443 | —(webhook url은 alerts.json, 설정 UI) | 알림 — 범용 webhook으로 JSON POST({ source:'vmware-portal', severity, title, detail, text, at }). 이메일은 사내 webhook→메일 게이트웨이 경유 권장. | server/src/alerts.js:195-196, 186-188 |
| 10 | Portal (server) | 메일 게이트웨이 (SMTP, 미구현/권장만) | outbound | SMTP | 25/465/587 | 587 | —(현재 구현 없음) | 이메일 알림 — 코드상 직접 SMTP 발신은 구현되어 있지 않음. 주석/안내로 'SMTP가 필요해 현재는 Webhook 경유 권장(사내 webhook→메일 게이트웨이)'으로만 언급. | server/src/alerts.js:4-5, web/src/views/Alerts2.jsx:43 |
| 11 | Portal (server) | GitHub Releases (또는 LAN 미러) | outbound | HTTPS | 443 | 443 | UPGRADE_REMOTE_BASE(기본 github releases/download/downloads), PACKAGE_BASE_URL(동일 기본), UPGRADE_TOKEN(PAT), PACKAGE_DIR, UPGRADE_ENABLED, UPGRADE_POLL_INTERVAL_MS, UPGRADE_AUTO_APPLY | 원격 업그레이드 체크/다운로드 — remoteBase/PACKAGE_BASE_URL의 versions.json 조회 후 vmware-portal-<ver>.tar.gz 다운로드(SHA-256 검증). private repo면 raw URL을 GitHub contents API(api.github.com)로 재작성하고 PAT(Bearer)로 인증. | server/src/upgrade/upgrade.js:241-318, 320-352, server/src/upgrade/fetchPackage.js:16-62, server/src/config.js:12-13, 91-92, 161-163 |
| 12 | Portal (server) | Edge/Collector 에이전트 | outbound | HTTPS/HTTP | edge URL 포트 |  | UPGRADE_EDGES(JSON 배열 [{url,token}]) | 자가 업그레이드 후 동일 번들을 등록된 edge/collector 에이전트에 푸시 — POST <edge>/api/upgrade/bundle (Content-Type: application/gzip, 선택 Bearer 토큰). | server/src/upgrade/upgrade.js:357-375, server/src/upgrade/manager.js:97-114, 107-114 |
| 13 | Edge/Collector 에이전트 | Portal /dl (중앙 업그레이드 소스) | inbound | HTTPS/HTTP | 4000 | 4000 | PORT(포탈 리슨, 기본 4000), PACKAGE_DIR/download 디렉터리에서 번들 스캔 | 이 포탈이 에이전트들의 업그레이드 원본 — 에이전트의 UPGRADE_REMOTE_BASE가 /dl을 가리키면 GET /dl/versions.json과 GET /dl/<번들>(vmware-portal-<ver>.tar.gz)을 내려받아 자가 업그레이드. 토큰 없이 공개 제공(authMiddleware 앞 마운트). | server/src/routes/dlsource.js:39-63, 18-36, server/src/index.js:84 |
| 14 | Build host (release 워크플로/패키징 스크립트) | nodejs.org | outbound | HTTPS | 443 | 443 | NODE_VERSION(기본 22.20.0). --node-tarball/--node-zip 제공 시 오프라인(네트워크 없음) | 오프라인 설치 패키지 빌드 시 Node.js 런타임 tarball/zip + SHASUMS256.txt 다운로드(node-v<ver>-linux-x64.tar.xz, win-x64.zip). 런타임 시점 통신이 아니라 패키지 빌드 단계. | packaging/offline/build-package.sh:53-54, packaging/windows/build-collector-win.sh:20, .github/workflows/release.yml:52 |
| 15 | Prometheus / Grafana / OTel 수집기 | Portal /metrics | inbound | HTTP | 4000 | 4000 | METRICS_EXPORT_TOKEN(설정 시 인증 필수, 미설정 시 공개), PORT(포탈 리슨) | 메트릭 익스포트 — GET /metrics가 스냅샷(vCenter up, 호스트 CPU/MEM/전력/GPU, 데이터스토어, VM 카운트)을 Prometheus 텍스트 포맷으로 노출. 선택 토큰 인증(?token= 또는 Authorization: Bearer; 불일치 시 403). | server/src/routes/metricsExport.js:15, 24-87, server/src/index.js:85 |

### ⑥ 능동 스캔 · 게스트 수집 · 네트워크 점검 (13)

| # | 출발(연결 시작) | 도착 | 방향 | 프로토콜 | 포트 | 기본 | 환경변수/설정 | 용도 | 근거 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | IP 스캔 폴러 (server/src/ipam/scanPoller.js, runScanOnce → scanRanges) | 스캔 대역 내 각 대상 IP (사내 승인 대역) | outbound | TCP (커넥트 스캔, net.Socket.connect) | 22,80,443,445,3389,623,8006,902,5985,5986 (DEFAULT_PORTS, 설정으로 변경 가능) | 22,80,443,445,3389,623,8006,902,5985,5986 |  | IP 능동 스캔 — 각 IP의 공통 관리 포트로 TCP 연결을 시도해 생존/열린 포트(SSH/HTTP/HTTPS/SMB/RDP/IPMI-BMC/Proxmox/ESXi/WinRM 추정)를 파악 | server/src/ipam/scan.js:78 (tcpProbe), :94 (scanOneHost), :102 (scanRanges); server/src/ipam/scanPoller.js:36 |
| 2 | IP 스캔 (scanOneHost reverseDNS, server/src/ipam/scan.js) | OS 기본 DNS 리졸버 → 생존 IP의 PTR 조회 | outbound | DNS 역방향 조회 (dns/promises reverse, UDP/TCP 53) | 53 | 53 |  | 역DNS — 생존 호스트의 IP를 PTR로 역조회해 호스트명 보강 | server/src/ipam/scan.js:10 (import dns/promises), :97 (dnsp.reverse) |
| 3 | 분산 에이전트 IP 스캔 워커 (server/src/agent/ipScanWorker.js, runIpScanAgentOnce → scanRanges) | 사이트(에이전트) 로컬 대역의 각 대상 IP | outbound | TCP (커넥트 스캔) | 22,80,443,445,3389,623,8006,902,5985,5986 (중앙이 할당한 ports) | 22,80,443,445,3389,623,8006,902,5985,5986 | CENTRAL_URL, AGENT_NAME | 분산 에이전트가 자기 사이트 대역을 로컬 스캔(고RTT/망분리 사이트). scan.js 동일 엔진 사용. (할당/보고는 중앙 HTTPS API로 별도) | server/src/agent/ipScanWorker.js:27 (scanRanges); scan.js:78/94/102 |
| 4 | GPU 게스트 폴러 SSH 경로 (server/src/gpu/poller.js → collectVmGpuSsh, server/src/gpu/sshCollect.js) | 게스트 VM이 보고한 게스트 IP (VMware Tools가 알려준 IPv4) | outbound | SSH (ssh2; password/keyboard-interactive/privateKey) | 22 (s.sshPort, 기본 22) | 22 |  | 게스트 OS에 직접 SSH 접속해 nvidia-smi 실행 → GPU 사용률/메모리 수집 (VMware Tools 게스트작업 인증 실패 대안) | server/src/gpu/sshCollect.js:59 (collectVmGpuSsh), :65 (SSH user@ip:port → nvidia-smi), :67 (withSsh); server/src/gpu/poller.js:126 |
| 5 | 물리 GPU 서버 자동감지 (server/src/gpu/sshCollect.js detectPhysicalGpu, physicalPoller) | 등록된 물리 서버 host (IP/FQDN) | outbound | SSH | 22 (기본) | 22 |  | 물리 서버에 SSH 접속해 nvidia-smi(GPU 모델명)·hostname·uname/ver(OS) 수집 → 자동 등록 | server/src/gpu/sshCollect.js:95 (detectPhysicalGpu), :98 (withSsh) |
| 6 | GPU 게스트 폴러 guestops 경로 — 제어 채널 (server/src/gpu/guestops.js, VimSoapClient) | vCenter (vc.host)/sdk | outbound | SOAP over HTTPS (vim25 GuestOperationsManager: StartProgramInGuest/ListProcessesInGuest/InitiateFileTransferFromGuest·ToGuest/DeleteFileInGuest, ValidateCredentialsInGuest) | 443 (vc.host에 :포트 명시 가능, 기본 443) | 443 |  | VMware Tools 게스트작업으로 게스트 OS 안에서 nvidia-smi 실행/결과파일 회수 — vCenter SOAP 경유 게스트 프로세스/파일 제어 | server/src/gpu/guestops.js:168 (collectVmGpu), :185 (StartProgramInGuest), :208 (ListProcessesInGuest), :100 (InitiateFileTransferFromGuest); server/src/vcenter/soapClient.js:89 (url=vc.host/sdk), :95 (fetch POST) |
| 7 | GPU 게스트 guestops 파일전송 — 데이터 채널 (server/src/gpu/guestops.js readGuestFile/writeGuestFile) | ESXi 호스트 (dlHosts: h.mgmtIp, h.name) → 폴백 vCenter host. (InitiateFileTransfer가 반환한 URL의 host) | outbound | HTTPS (HTTP GET 결과파일 회수 / HTTP PUT 파일 업로드 — fetch, guestFile 티켓 URL) | 443 (전송 URL의 host:port, ESXi 443) | 443 |  | 게스트 nvidia-smi stdout/stderr 파일을 ESXi guestFile 엔드포인트에서 GET 회수, 계정추가/스크립트 파일은 PUT 업로드 | server/src/gpu/guestops.js:137 (GET fetch), :324 (PUT fetch), :127 (호스트 후보=ESXi mgmtIp/FQDN→vCenter 폴백); server/src/gpu/poller.js:107 (dlByHost=h.mgmtIp,h.name) |
| 8 | 게스트 계정 추가 (server/src/guest/accountService.js → addGuestUser, server/src/gpu/guestops.js runGuestScript/writeGuestFile) | vCenter(/sdk, SOAP) + ESXi(파일 PUT/GET) | outbound | SOAP over HTTPS (StartProgramInGuest/파일전송) + HTTPS PUT/GET (스크립트·비번파일 업로드, 결과 회수) | 443 (vCenter), 443 (ESXi 파일전송) | 443 |  | 게스트 OS에 sudo 계정 추가 — 스크립트/비번파일을 게스트로 업로드(PUT)해 실행(useradd/chpasswd) 후 stdout/stderr 회수(GET) | server/src/guest/accountService.js:43 (addGuestUser); server/src/gpu/guestops.js:333 (runGuestScript), :367 (addGuestUser), :341 (writeGuestFile PUT) |
| 9 | 실제 OS 인벤토리 스캐너 (server/src/inventory/osScanner.js → detectGuestOs, server/src/inventory/osDetect.js) | vCenter(/sdk, SOAP) + ESXi(파일 PUT/GET) | outbound | SOAP over HTTPS (runGuestScript: StartProgramInGuest 등) + HTTPS PUT/GET (스크립트 업로드/결과 회수) | 443 (vCenter), 443 (ESXi) | 443 |  | 게스트 OS 안에서 cat /etc/os-release·uname (Linux) / PowerShell Get-CimInstance Win32_OperatingSystem (Windows) 실행해 '실제 OS' 탐지 — vCenter 게스트작업 경유 | server/src/inventory/osDetect.js:71 (detectGuestOs → runGuestScript), :8 (import guestops); server/src/inventory/osScanner.js:80 (detectGuestOs) |
| 10 | 네트워크 트래픽 캡처 (server/src/net/tcpdump.js runTrafficCapture/runPcapCapture, monitor.js) | hostA (캡처 수행 서버, creds.host) — SSH 접속 | outbound | SSH (ssh2, withSsh.exec) — 원격에서 tcpdump 실행 | 22 (hostA.port, 기본 22) | 22 |  | 포탈이 hostA에 SSH로 접속해 'tcpdump -i <iface> -n -tt host <peerB>' (또는 -w pcap)을 제한 시간/패킷으로 실행, 출력을 SSH 채널로 회수해 핸드셰이크/재전송/RST 진단 | server/src/net/tcpdump.js:83 (tcpdump cmd), :84 (withSsh), :152 (pcap -w); server/src/proxy/sshExec.js:72 (withSsh) |
| 11 | 네트워크 캡처 대상 — hostA의 tcpdump host 필터 (간접: A↔B 트래픽) | peer B (대상 호스트 IP/이름) — hostA에서 tcpdump host <B>로 관찰 | bidirectional | (관찰 대상) hostA↔B 간 TCP 트래픽 (포탈이 B로 직접 접속하지 않음 — A에서 패킷만 캡처) | B와의 모든 포트(필터=host B, 포트 무관) |  |  | A에서 'tcpdump host B'로 A↔B 패킷을 캡처해 경로 손실/단방향/RST 진단. 양방향 캡처(runDualCapture)는 B에도 SSH 접속해 동시 캡처 후 대조 | server/src/net/tcpdump.js:75 (peer), :125 (runDualCapture: hostA+hostB 둘 다 SSH 22), :135 |
| 12 | ICMP ping 유틸 (server/src/util/ping.js pingOne/pingMany) | 대상 호스트 IP | outbound | ICMP Echo (OS ping CLI execFile; raw 소켓 미사용) | (ICMP — 포트 없음) |  |  | 대상 IP 도달성/RTT 측정 — OS ping 명령 호출 | server/src/util/ping.js:35 (pingOne), :44 (execFile 'ping'), :85 (pingMany) |
| 13 | ping TCP 폴백/프로브 (server/src/util/ping.js tcpReachable, tcpConnect, tcpProbeMany) | 대상 호스트 IP | outbound | TCP 연결 프로브 (net.connect) | 445,3389,22,80,443,135 (FALLBACK_PORTS, ping 미설치 시) / tcpConnect는 기본 443(또는 지정 포트) | 443 |  | ping CLI 없는 환경(컨테이너)에서 흔한 관리 포트로 TCP 연결해 도달성 추정 / tcpConnect·tcpProbeMany는 제어플레인(443 등) 도달성·지연 측정 | server/src/util/ping.js:16 (FALLBACK_PORTS), :17 (tcpReachable), :59 (tcpConnect, port=443), :75 (tcpProbeMany) |

---

## 4. 운영 주의 · 보안 참고

- **단일 포트 아키텍처**: 포탈은 `4000` 하나만 연다. 앞단에 nginx/HAProxy로 `443(TLS) → 4000` 종단을 두는 것을 권장(포탈 자체는 평문 HTTP listen).
- **토큰 게이트**: `/api/central/*`(엣지→중앙)는 `X-Central-Token`(`CENTRAL_TOKEN`), `/api/collector/*`(중앙→수집)는 `X-Collector-Token`(`COLLECTOR_TOKEN`)으로만 보호된다(사용자 로그인 밖). 이 토큰은 길고 비밀로 관리하고, 가능하면 해당 포트를 관리망으로 제한.
- **TLS 검증**: vCenter/iDRAC/NSX는 사설 자가서명 대비 기본 `rejectUnauthorized=false`(`VC_TLS_REJECT_UNAUTHORIZED`/`AD_TLS_REJECT_UNAUTHORIZED` 등). 운영 시 사내 CA 신뢰 + 검증 ON 권장.
- **HAProxy 중계 vCenter**: vCenter 직접 443이 안 닿으면 중계 frontend 커스텀 포트를 `vcenters.json` host에 `https://중계:포트`로 넣는다. 이 포트도 포탈→중계 방향으로 열어야 한다(2-B vCenter 행의 '커스텀').
- **동적 포트 범위**: 원격접속 frontend는 `PROXY_PUBLIC_PORT_BASE`(20000)부터 매핑 수만큼 증가한다. 방화벽은 넉넉한 범위(예 20000–29999)를 포탈/사용자→중계로 열어두는 것이 운영상 편하다.
- **능동 스캔/콘솔은 침투성**: IP 스캔(2-B 마지막 그룹)·tcpdump·게스트 SSH는 승인된 대역/호스트에만. 스캔 포트는 설정으로 축소 가능.
- **업그레이드 무결성**: 패키지 다운로드는 SHA-256 검증을 하되 서명은 없음 — 미러/경로(`PACKAGE_BASE_URL`)는 신뢰 가능한 출처로 한정.

## 5. 환경변수 빠른 참조 (포트/주소 변경)

| 변수 | 기본 | 영향 |
|---|---|---|
| `PORT` | 4000 | 포탈 listen 포트 |
| `CENTRAL_URL` / `CENTRAL_TOKEN` | — | 엣지→중앙 주소·토큰 |
| `COLLECTOR_TOKEN` | — | 수집 export 토큰 |
| `HAPROXY_DATAPLANE_URL`/`_USER`/`_PASS` | http://proxy:5555 | Data Plane API |
| `PROXY_SSH_HOST`/`_PORT`/`_USER`/`_PASS` | 22 | HAProxy SSH 배포 |
| `PROXY_PUBLIC_HOST`/`PROXY_PUBLIC_PORT_BASE` | 20000 | 원격접속 frontend |
| `GUACD_HOST`/`GUACD_PORT` | 4822 | RDP 게이트웨이 |
| `AD_URL`/`AD_TLS_REJECT_UNAUTHORIZED` | 389/636 | AD 인증 |
| `OLLAMA_URL` | http://localhost:11434 | LLM |
| `PACKAGE_BASE_URL`/`UPGRADE_REMOTE_BASE` | GitHub releases | 업그레이드 소스 |
| `METRICS_EXPORT_TOKEN` | (없음=공개) | /metrics 인증 |
| `VC_TLS_REJECT_UNAUTHORIZED`/`VC_KEEPALIVE_MS` | false/4000ms | vCenter TLS/keepalive |

> 본 문서는 소스 분석(82개 경로)으로 자동 생성·정리되었습니다. 코드 변경 시 갱신이 필요하면 동일 분석을 재실행하세요.
