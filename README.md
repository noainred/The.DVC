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
- [설정 메뉴 구조](#설정-메뉴-구조)
- [분산 수집(에이전트) / IP 스캔](#분산-수집에이전트--ip-스캔)
- [오프라인 설치 & 패키징](#오프라인-설치--패키징)
- [자동 업그레이드](#자동-업그레이드)
- [보안 / 운영 메모](#보안--운영-메모)

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
- **NIC 분석 (v2.179+)** — iDRAC Redfish 인벤토리로 서버 물리 NIC의 **속도별 분류**(10G/25G/100G — 미링크 포트도 카드 정격으로 판별)와 **모델별 분류**(Intel·Broadcom·Mellanox…). DataCenter·가상화(ESXi)/베어메탈 필터, vCenter 수집(pnic+PCI) 결과를 **별도 컬럼**으로 교차 확인, CSV.
- **라이선스 만료일 (v2.189+)** — vCenter LicenseManager 전 제품 키(ESXi/vSphere·vCenter·vSAN·VCF/VVF 등) + NSX Manager + **Horizon Connection Server**(REST 직수집, 10분 캐시)를 한 화면에. 만료·90일 임박·정상·영구 분류, 제품군 필터, 남은 기간(D-일수) 정렬, CSV.
- **핑/네트워크 모니터링** — 네트워크 탭의 ① Ping 모니터링(등록 대상 ICMP/TCP 도달성·RTT 시계열) ② 서버 Ping 체크(엣지/수집 노드 TCP 지연을 DC별 산점도) ③ vCenter 포트 응답속도(사용자 지정 포트를 vCenter별 측정). 별도 시계열 DB(`ping-monitor.db`, 1년 보존)·baseline 대비 색상 추세.
- **IP 관리대장(IPAM)** — vCenter 수집 IP(서버종류 VM/베어메탈, OS 종류·버전) + **능동 스캔(TCP 커넥트)** 으로 물리/기타 장비 IP 보강. 서브넷 엑셀형 대장, 중복 IP, CSV/XLSX, 외부 공유 SQLite(`ipam.db`).
- **통합 서버 인벤토리** — iDRAC/OME 수집 물리 서버 + vCenter ESXi 호스트를 Dell 서비스태그로 조합해 **가상화 호스트 / 베어메탈**을 자동 분류. 베어메탈 **총전력 집계**, 소속 **법인(vCenter) 등록**(자동 추론·일괄 등록·수동 예외), **엣지→중앙 집계**(전력 없는 발견분까지 DC별 검색).
- **VM 생성(프로비저닝)** — 단건/대량 클론 + 게스트 커스터마이징(이름/IP 규칙), 동시성 제한 작업 큐, 작업 이력·메모/태그.
- **VM 사양 변경(관리자)** — `ReconfigVM_Task`로 vCPU·RAM 증설, 코어/소켓, 디스크 증설/추가(컨트롤러 선택), NIC 추가/삭제·연결 토글. **증설만**(감소·축소 차단) + hot-add 판정 + 확인창 + 감사로그.
- **원격 접속** — 브라우저 SSH(xterm.js/WebSocket)·RDP(Guacamole), HAProxy Data Plane API로 임시 포트 매핑(TTL 1일), `.rdp` 다운로드, VM에서 빠른 접속.
- **AI 자연어 검색** — 로컬 LLM(Ollama)로 "북미 메모리 90% 넘는 호스트" 같은 질의 → 구조화 검색(불가 시 규칙 기반 폴백).

### 인사이트 / 분석 (v1.88+)
- **인사이트 패널** — 💰 FinOps(전력→kWh·요금·CO₂, PUE/단가 설정) · 🤖 AI 이상탐지(중앙값·MAD Z-score) · 📈 용량/수명 예측(선형회귀 ETA) · 🛡 보안(ESXi/vCenter 빌드 ↔ 내장 VMSA·EOL) · 🌐 토폴로지 · 🚨 인시던트 타임라인 · 💬 LLM ChatOps.
- **구성도(3D)** — 설정된 라이브 구성을 3D 네트워크 그래프로(중앙→엣지→vCenter→NSX/호스트→VM, 줌·회전, vCenter/호스트 포커스로 VM 단위 탐색).
- **Prometheus/OTel 익스포터** — `/metrics`로 호스트 CPU·MEM·전력·GPU, 데이터스토어, VM 카운트 노출(`METRICS_EXPORT_TOKEN` 필요 — 미설정 시 비활성).
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
- **인증/RBAC** — scrypt 해시 + HS256 JWT, 역할(admin/operator/viewer), **TOTP 2FA**, **Active Directory(LDAP)** 연동. **admin·operator는 OTP 전용 로그인**(v2.204+, 아래 참조).
- **기능별 권한 매트릭스 (v2.196+)** — 역할은 3개로 두되 **기능 단위 권한 키 17종**(대시보드·인벤토리 6종·특수기능·인사이트·원격접속·원격콘솔·VM 사양변경/프로비저닝·게스트계정 배포·설정·업그레이드·사용자관리)을 **설정 › 사용자 관리에서 체크박스로 켜고 끕니다**. 서버(`requirePerm`)와 WS SSH/RDP 게이트웨이가 실제로 강제하므로 메뉴를 숨겨도 API 직접 호출은 차단됩니다. admin은 항상 전체(잠김 방지). 기본값은 기존 role 동작과 동일해 도입만으로 권한이 바뀌지 않습니다.
- **특수 기능 도구별 접근 (v2.197+)** — 약 40개 특수기능 도구를 역할별로 **개별 차단**(deny-list). '전체허용/전체차단' 일괄 설정 지원, 권한 없는 도구는 딥링크로도 열리지 않습니다.
- **사용자별 데이터 범위(scope) (v2.196+)** — 계정마다 **볼 수 있는 vCenter/리전**을 지정(예: 폴란드 법인 계정은 유럽 리전만). 호스트·VM·스토리지·네트워크·알람 목록과 vCenter 필터가 서버에서 제한됩니다(미지정 시 전체).
- **특수 계정 (v2.202~2.204)** — **`noainred` 수퍼관리자**(항상 admin 보장·강등/삭제/로그인차단 불가·설정 소유자 자동 포함), **`thedvcdemp` 데모 계정**(viewer 고정·삭제 불가, **비밀번호가 설정된 동안만 로그인** — 설정 › 사용자 관리에서 [비번 설정]/[로그인 차단]으로 열고 잠금).
- **감사 로그 / 진단·로그** — 쓰기 작업 감사(JSONL), 연결 실패 원인(한국어 힌트) + 실시간 서버 로그 뷰어.
- **알림** — 임계치 규칙 → Slack/Webhook(상태전이·쿨다운).
- **자동 업그레이드** — `versions.json` 모니터링 → 다운로드·적용·재시작(롤백 가능), 엣지 푸시.
- **분산 수집** — 원격 데이터센터 에이전트 pull(전력 등) + 중앙 할당(iDRAC/IP 스캔). **통합 엣지 모드**(`EDGE_MODE=all` + `CENTRAL_URL` + `EDGE_TOKEN` 3줄)로 수집·위임 스캔/핑/캡처/로그 워커·인벤토리 push·자동 업그레이드·부팅 시 중앙 자동 등록을 일괄 활성. **위임 iDRAC 스캔**은 엣지 폴링 또는 **중앙→엣지 직접(PUSH)** 방식 + 2단계 claim→ack로 인출 유실 방지. 중앙 **에이전트 배포**(SSH 원클릭 설치)·**에이전트 작업**(IP대역 할당) 지원.
- **중앙 → 엣지 배포 (v2.170+)** — 중앙 UI에서 원격 엣지의 **GPU 게스트 수집 설정**과 **접속 사용자 계정**을 만들어 내려보낸다(엣지가 주기적으로 pull — NAT/폐쇄망 안전). 복수 엣지·전체 엣지 동시 배포, 배포된 계정 수정/제거, 중앙 배포 admin은 엣지 설정 메뉴 자동 허용.
- **엣지 운영 도구** — 수집 서버 **토큰 강제 동기화**(403 토큰 불일치를 SSH로 즉시 교정 — 리슨 포트로 실제 인스턴스 역추적), Edge 노드 SSH 배포·상태 확인, 엣지 인증 거부 카운터 표시.
- **보안** — scrypt+HS256 JWT·TOTP(1회용)·AD 외에, **고권한 OTP 전용 로그인**(admin·operator는 비밀번호 로그인 차단, v2.204.0)·기능 권한 매트릭스 서버측 강제(WS SSH/RDP 포함)·**서버측 토큰 폐기**(비번/역할 변경 시 즉시 무효)·보안 응답 헤더·CORS 기본 차단·임의 초기 관리자 비번·SSRF/명령주입 방어·번들 sha256 필수·**엣지별 개별 central 토큰**(공유 토큰 스코프 축소, v2.191.0)·**자격증명 파일 손상 보존**(로드 실패 시 `.corrupt` 백업 — 전량 유실 방지)·**RDP 자격증명 1회용 티켓**(URL 미노출)·**설정 소유자 서버측 강제**(v2.195.0). 상세 [설치 가이드 §7](docs/INSTALL.md)·[감사 문서](docs/AUDIT-2026-06-27.md).
- **로그인 화면 20종 랜덤 (v2.199~2.201)** — 접속할 때마다 20가지 디자인(Davinci Map·Aurora Glass·Retro Terminal·Blueprint·Minimal Light·Neon City·Orbital·Matrix Rain·Sunset·Brutalist·Terminal Boot·Split Panel·Radar Ops·Light Console·Region Tiles·Ultra Minimal·NOC Preview·Left Rail·Amber Watch·Data Wall) 중 하나가 자동 표시됩니다. 우하단 🎲 버튼으로 즉시 교체 가능. 인증 로직(OTP·세션유지·3회 실패 경고)은 전 테마 공통.
- **데모(mock) 모드** — vCenter 없이 `DATA_SOURCE=mock`으로 전세계 11개 가상 vCenter + iDRAC 전력·핑/네트워크·지표·온도·GPU 게스트·로그까지 채워진 화면을 즉시 시연(v2.154.0 목업 완비).
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
  - `vcenter/restClient.js` — vSphere Automation REST(7.0/8.0) 폴백(핵심 목록 실패는 vCenter 수집 실패로 처리해 빈 스냅샷 유통을 막음).
  - `nsx/`, `idrac/`, `ipam/`, `gpu/`, `metrics/`, `provision/`, `proxy/`, `llm/`, `collector/`, `central/`, `agent/`, `upgrade/`, `auth/` — 각 하위 시스템.
- **web/** — React + Vite. 해시 라우팅 `#/<탭>`, 특수기능 딥링크 `#/tools/<기능>`. 전 뷰 lazy 청크 분할, 3D 토폴로지(1.3MB)는 클릭 시 동적 로드.

### 성능 설계 (28 vCenter · 고RTT 최적화, v2.106+)

| 계층 | 메커니즘 |
|---|---|
| HTTP 응답 | 자체 gzip 미들웨어(비동기 zlib) + **ETag/304** — 스냅샷(30초)보다 짧은 폴링(15초)의 무변동 응답은 본문 0바이트로 재검증만. 프론트 `pollFetch`가 If-None-Match 자동 처리 |
| SOAP 파싱 | 대형(256KB↑) RetrieveProperties XML 정규식 파싱을 **worker_threads 풀**(기본 min(4, CPU-1))로 zero-copy 오프로딩 — 매 주기 파싱이 메인 이벤트 루프를 막지 않음. 소형·워커 실패 시 인라인 폴백(동일 결과), 워커 사망 시 자기치유(`SOAP_PARSE_WORKERS`) |
| SQLite | 전 시계열 DB **WAL + synchronous=NORMAL + busy_timeout**(커밋 fsync 대폭 절감 — 단건 insert 5ms→0.01ms 실측). 외부 프로그램이 읽는 `ipam.db`만 기본 저널 + busy_timeout 유지 |
| 전력 시계열 | 서버별 최신값 **인메모리 캐시**(기동 시 1회 시드, 쓰기 시 O(1) 갱신) — 매 30초 GROUP BY 풀스캔 제거. 24h 집계는 **시간당 롤업 테이블**(`power_hourly`, 적재 트랜잭션 내 증분 upsert)로 수억 행 대신 ~24행 스캔 + 60초 캐시. 적재는 단일 트랜잭션 배치(insertMany), prune은 10틱 스로틀 + `ts` 인덱스 |
| 대량 export | GPU 시계열 등은 5만 행 청크 + `setImmediate` 양보로 조회(이벤트 루프 10초 정지 방지), 기본 상한 30만 행(`GPU_EXPORT_MAX_ROWS`) |
| 수집 | vCenter 병렬+동시성 제한, 모든 폴러 재진입 가드, 수집서버 풀러 배치 적재, 위임 잡 활동 기준 GC |

---

## 빠른 시작

```bash
npm run install:all          # 루트 + server + web 의존성
npm run dev                  # API :4000 + 웹 :5173 (핫리로드) → http://localhost:5173
# 또는 단일 포트(프로덕션)
npm run build && npm start   # API가 web/dist 서빙 → http://localhost:4000
```

최초 계정: **`admin`** + 비밀번호는 `DEFAULT_ADMIN_PASSWORD`(설정 시) 또는 **최초 기동 시 임의 생성되어 `$CONFIG_DIR/initial-admin-password.txt`(0600)에 저장**됩니다(알려진 기본 비번 폐지, v2.152.0). 로그인 후 즉시 변경하고 파일 삭제. 운영 시 `AUTH_SECRET` 지정 권장(미지정 시 재시작마다 세션 무효).

> 🔐 **v2.206+ OTP 전용 정책 + 강제 등록**: admin·operator의 최종 상태는 **OTP 전용 로그인**입니다. 최초 설치에서는 다음 흐름으로 도달합니다.
> 1. 로그인 화면이 **최초 관리자 비밀번호 파일 경로를 팝업으로 안내**합니다(`sudo cat $CONFIG_DIR/initial-admin-password.txt`).
> 2. 그 비밀번호로 로그인하면 곧바로 **"OTP 등록" 화면에 고정**됩니다 — 서버가 등록 외 모든 API를 차단합니다.
> 3. QR 스캔 후 6자리를 입력해 등록을 마치면 **비밀번호가 즉시 삭제**되고(비번 파일도 자동 삭제), 이후에는 OTP로만 로그인합니다.
>
> 헤드리스 등록·잠금 복구는 콘솔 도구를 씁니다: `sudo vmware-portal-otp admin`(설치본) 또는 `npm run otp-enroll -- admin`(소스). 긴급 해제는 `OTP_ROLE_ENFORCE=false`.
> 함께 시드되는 계정: **`noainred`**(수퍼관리자), **`thedvcdemp`**(데모 — viewer라 비밀번호 로그인 가능, 단 비번 설정 전까지는 로그인 불가).
git 소스로 실행하면 `CONFIG_DIR` 기본값이 `server/config` 라 이 파일이 저장소 안에 생기지만, `.gitignore`(`server/config/*.txt`)로 차단되어 커밋되지 않습니다.

> 🧑‍💻 **git 소스에서 설치**(Node 직접 설치·systemd·업데이트 상세): [docs/INSTALL.md 부록 A](docs/INSTALL.md#부록-a-git-소스에서-설치-개발커스터마이징).
> 운영(에어갭)은 오프라인 패키지 방식([docs/INSTALL.md](docs/INSTALL.md)) 권장.

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
| `SOAP_PARSE_WORKERS` / `SOAP_PARSE_MIN_CHARS` | `min(4,CPU-1)` / `262144` | SOAP XML 파싱 worker_threads 수(0=비활성) / 워커 오프로딩 최소 크기 |
| `VC_SOAP_METRICS` | `true` | vim25 SOAP 실측 메트릭 수집 |
| `VC_TLS_REJECT_UNAUTHORIZED` | `false` | 자체서명 인증서 거부 여부 |
| `VC_TLS_MIN_VERSION` / `VC_TLS_CIPHERS` | `TLSv1` / `DEFAULT@SECLEVEL=0` | 레거시 vCenter TLS 호환 |

### 인증
| 변수 | 기본값 | 설명 |
|---|---|---|
| `AUTH_ENABLED` | `true` | 로그인 인증 사용 |
| `AUTH_SECRET` | (랜덤) | JWT 서명 시크릿 — **운영 필수**(미지정 시 재시작마다 토큰 무효) |
| `AUTH_TOKEN_TTL` | `8h` | 토큰 유효기간 |
| `DEFAULT_ADMIN_PASSWORD` | (임의생성) | 초기 admin 비밀번호. 미설정 시 최초 기동에 임의 생성 → `$CONFIG_DIR/initial-admin-password.txt` |
| `TOTP_ISSUER` | `VMware Portal` | TOTP 표시명 |
| `OTP_ROLE_ENFORCE` | `true` | **admin·operator OTP 강제 등록**(v2.206+). OTP 미등록 고권한 계정은 최초 1회 비밀번호로 로그인되지만 그 세션은 **등록 외 모든 API가 차단**되고, 등록을 마치면 **비밀번호가 삭제**되어 이후 OTP 전용이 됩니다. `false`로 강제를 해제(긴급용). AD 계정·viewer·데모 계정은 대상 아님 |
| `AD_ENABLED`, `AD_URL`, `AD_DOMAIN`, `AD_BASE_DN`, `AD_*_GROUP`, `AD_DEFAULT_ROLE` | — | Active Directory(LDAP) 연동·그룹→역할 매핑 |
| `AD_GROUP_MATCH` | `exact` | 그룹→역할 매칭 방식. 기본은 **그룹명(CN)/전체 DN 완전일치**. `substring`은 구버전 호환용(부분문자열 매칭 — 권한 상승 위험, 비권장) |
| `AD_TLS_REJECT_UNAUTHORIZED` | `true` | LDAPS 인증서 검증(기본 ON — `false`로만 opt-out) |
| `AUTH_DISABLED_ROLE` | `admin` | `AUTH_ENABLED=false`일 때 익명 요청에 부여할 역할. 운영에서 인증을 끌 수밖에 없다면 `viewer`로 낮춰 변경 동작을 차단 |
| `OTP_MAX_FAILS` / `OTP_LOCKOUT_MS` / `OTP_FAIL_WINDOW_MS` | `5` / `600000`(10분) / `600000` | 민감작업 재인증 OTP 실패 잠금(로그인 잠금과 별도 키 공간) |
| `CORS_ORIGINS` | (교차출처 차단) | 허용 교차출처 목록(콤마). 미설정 시 same-origin만(와일드카드 제거) |
| `CSP` | — | Content-Security-Policy 헤더 값(옵트인) |
| `METRICS_ALLOW_QUERY_TOKEN` | `false` | `/metrics` 토큰을 `?token=`로도 허용(기본은 Authorization 헤더 전용) |
| `NSX_TLS_REJECT_UNAUTHORIZED` | `false` | NSX TLS 인증서 검증 강제(기본은 자체서명 허용) |
| `LOGIN_MAX_FAILS` / `LOGIN_LOCKOUT_MS` / `API_RATE_LIMIT` | `8` / `900000` / `1800` | 로그인 잠금·분당 IP API 상한 |

### 전력(iDRAC/OME) · 시계열
| 변수 | 기본값 | 설명 |
|---|---|---|
| `IDRAC_ENABLED` / `IDRAC_POLL_INTERVAL_MS` | `true` / `60000` | iDRAC 전력 폴링 |
| `IDRAC_DB_PATH` / `IDRAC_RETENTION_DAYS` | `CONFIG_DIR/idrac-power.db` / `90` | 전력 시계열 DB·보존 |
| `OME_POWER_PLUGIN_ID` / `OME_POWER_METRIC_TYPES` | — | OpenManage Power Manager |
| `TEMP_DB_PATH` / `TEMP_SAMPLE_INTERVAL_MS` / `TEMP_RETENTION_DAYS` | `CONFIG_DIR/host-temp.db` / `60000`(1분) / `1830`(~5년) | 온도·GPU·용량 시계열(설정에서도 변경) |
| `IPAM_DB_PATH` | `CONFIG_DIR/ipam.db` | 외부 공유 IP 대장 DB |
| `PING_MON_ENABLED` / `PING_DB_PATH` / `PING_MON_INTERVAL_MS` / `PING_MON_RETENTION_DAYS` | `true` / `CONFIG_DIR/ping-monitor.db` / `60000` / `365` | 핑/네트워크 모니터링 시계열 |

### 분산(수집/중앙/에이전트)
| 변수 | 기본값 | 설명 |
|---|---|---|
| `EDGE_MODE` / `EDGE_TOKEN` | — | **통합 엣지 모드**(`all`): 3줄로 전 엣지 기능 활성. `EDGE_TOKEN`이 CENTRAL/COLLECTOR 토큰 겸함 |
| `COLLECTOR_TOKEN` / `COLLECTOR_DATACENTER` | — | 이 인스턴스를 수집 에이전트로 노출(토큰), 사이트 라벨 |
| `COLLECTOR_PULL_INTERVAL_MS` | `60000` | 중앙이 에이전트 pull 주기 |
| `CENTRAL_TOKEN` | — | 중앙↔에이전트 API 토큰. **엣지별 개별 토큰**을 발급했다면 그 엣지에는 개별 토큰 값을 넣는다(자기 데이터만 접근) |
| `CENTRAL_REQUIRE_AGENT_TOKEN` | `false` | `true`면 공유 `CENTRAL_TOKEN` 거부 — 엣지별 개별 토큰만 허용(전 엣지 이관 후 권장) |
| `WAN_TLS_INSECURE` | `false`(검증 ON) | 중앙↔엣지 HTTPS 인증서 검증. **자체서명 HTTPS 엣지**가 있는 노드만 `true`(대부분 엣지는 http라 무영향) |
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
| `METRICS_EXPORT_TOKEN` | — | `/metrics`(Prometheus) 접근 토큰. **미설정 시 /metrics는 404(비활성)** — 무인증 공개는 `METRICS_ALLOW_ANON=true` 옵트인 |
| `HORIZON_TLS_VERIFY` | `false` | Horizon Connection Server TLS 검증(사내 사설 인증서 대비 기본 생략, `true`로 강제) |
| `SSRF_ALLOW_LOOPBACK` | `false` | SSRF 가드의 루프백(127.x/::1) 차단 해제 — 중앙·엣지를 같은 서버에 올린 랩 구성용 |
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
`gpu`(+`/history`,`/vms`), `esxi-temp`(+`/history`), `capacity`, `capacity-forecast`, `waste`, `thin-vms`, `guest-os`, `hba`, `licenses`, **`license-expiry`**(vCenter+NSX+Horizon 만료일), `esxi`, `solutions`, `hardware`, `vmtools`, `snapshots`, `duplicate-ips`, `vm-finder`(POST), `ipam`(+`/subnets`,`/sheet`,`/annotation`,`.xlsx`,`.csv`), `deep-search`(POST), `ip-ping`, `service-check`, `network-check`, `vmware-config`, `vclogs`(+`/export.csv`,`/federate`,`/sources`)

> 상태변경(POST/PUT/DELETE) 라우트는 **기능 권한(`requirePerm`)** 으로 보호됩니다(v2.196+) — IPAM 편집·ip-ping·Tools 업그레이드는 `tools`, 알람 음소거는 `inv.alarms`, VM 사양변경은 `vm.reconfig`, 원격 콘솔은 `vm.console`, SSH/RDP 터널·probe·rdp-ticket은 `remote.access`. 기본 매트릭스는 기존 `requireRole('admin','operator')` 동작과 동일(viewer는 조회 전용)이며, 설정 › 사용자 관리에서 역할별로 조정할 수 있습니다.

### 인사이트 `/api/insights/*`
`finops`(+`/config`), `power-breakdown`, `fleet`(+`/tag`,`/assign`,`/assign-bulk`,`/prune` — 통합 인벤토리), `anomalies`, `forecast`, `security`, `topology`, `graph`, `incidents`, `chatops`(POST) · 익스포터 `GET /metrics`(Prometheus)

### 관리자 `/api/admin/*` (발췌)
`users`(+**`/:username/password`** POST=비번 설정·DELETE=로그인 차단, `/:username/totp/*`), **`permissions`**(GET/PUT + `/reset` — 역할×기능 권한 매트릭스·특수기능 도구별 거부목록), `vcenters`(+`/test`,`/import`,`/order`), `nsx/managers`, `idrac`(+`/scan`,`/bulk-add`,`/power-dashboard`, **`/nic-speed`**, **`/nic-models`**, **`/scan-log`**(주기/수동 스캔 실행 이력 — 통합/법인별)), `collectors`(+`/:id` vCenter 매핑, **`/:id/force-token`** 토큰 강제 동기화), **`central/agent-tokens`**(엣지별 개별 토큰 발급·회수), `central/ingest-stats`, `vm/:id/{hardware,reconfig}`(VM 사양 변경), `assignments`, `agent-deploy`, `metrics/settings`, `gpu-guest/{settings,vms,test,diag}` + **`gpu-guest/deploy/:agent`**(중앙→엣지 GPU 설정 배포), **`edge-users`**(+`-bulk` — 중앙→엣지 계정 배포), **`horizon`**(+`/test` — Horizon 서버 등록), `ipam/settings`, `ipam/scan/{settings,run,results}`, `alerts`(+`/test`), `audit`, `data-source`, `llm-config`, `packages`, `geocode`, `logs`, `backup/*`, `vclogs/*`, `net/{capture,pcap,history,monitors,agents,log-issues}`, `guest/add-user`, `deep-search/probe`, `security/session`, `emergency-stop`

### 원격접속 `/api/remote/*`
`mappings`, `quick-connect`, `proxies`, `config`, `deploy`, `probe`, `targets`, `rdp/:id`, **`rdp-ticket`**(POST — RDP 자격증명 1회용 티켓 발급, admin/operator; 쿼리스트링에 비번 미노출)

### 업그레이드 `/api/upgrade/*`
`status`, `check`, `apply`, `restart`, `settings`, `bundle`

### 토큰 라우터(에이전트↔중앙)
- `/api/collector/{export,ping,idrac-scan,upgrade,set-password}` — **`X-Collector-Token`** 게이트(전력 export·중앙→엣지 PUSH 스캔·원격 업그레이드).
- `/api/central/{register-collector,assignment,result,inventory,fleet,idrac-scan-jobs,idrac-scan-progress,idrac-scan-result,ip-scan-assignment,ip-scan-result,gpu-guest-data,agent-config,ping-jobs,ping-result,log-queries,log-query-result,capture-jobs,capture-result,users-config,gpu-guest-config}` — **`X-Central-Token`** 게이트(엣지→중앙 보고·위임 잡 인출·중앙 배포 설정 pull).
  - **엣지별 개별 토큰(v2.191+)**: 설정 → 수집 서버 → 🔑에서 엣지별 토큰을 발급하면 그 토큰은 **자기 `agent` 데이터만** 접근한다(남의 이름으로 조회 시 403). 엣지는 이 값을 기존 `CENTRAL_TOKEN` 자리에 넣기만 하면 되므로 사이트별로 무중단 이관할 수 있고, 이관 완료 후 `CENTRAL_REQUIRE_AGENT_TOKEN=true`로 공유 토큰을 금지한다.
- `/dl/{versions.json,<번들>}` — 공개 업그레이드 소스(자동 업그레이드 원격 베이스).
- `/api/ping/*` — 핑/네트워크 모니터링(조회=인증, 대상 관리=관리자).

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
| `real-os` | 실제 OS 확인(게스트 탐침·불일치) | `vmprovision` | VM 생성(관리자) |
| `agent-scans` | **에이전트 작업**(IP대역 할당 위임 스캔, 관리자) | `shutdown` | 긴급중단(2인 OTP) |
| `insights` | 운영 인사이트(라이트사이징·N+1·알람 핫스팟·GPU 유휴) | `threats` | 위협 탐지 |
| `license-expiry` | **라이선스 만료일 확인**(ESXi·vCenter·vSAN·VCF/VVF·NSX·Horizon) | `dsusage` | vCenter별 스토리지 |
| `nic-speed` | **서버 NIC 속도 구분**(10G/25G/100G·DC/가상화·베어메탈) | `nic-models` | **서버 NIC 모델 확인**(Intel/Broadcom/Mellanox) |
| `login-fails` | 로그인 실패 분석 | `net-issues` | 네트워크 이슈 분석 |
| `diskadd` | 디스크 추가 자동화 | `massdeploy` | 대용량 배포 |
| `backup` | 백업 | | |

> 검색창에서 메뉴를 빠르게 찾을 수 있고(**최근 검색어**가 1줄로 표시), 전체 사용자 클릭수 기준
> **자주 쓰는 기능**이 상단에 자동 노출됩니다.
> 상단 **인사이트** 탭(FinOps·이상탐지·예측·보안·토폴로지·인시던트·ChatOps)과
> **설정**의 포탈 백업 · vCenter 로그 보관 · 게스트 계정 추가 · GPU 게스트 수집/진단도 참고.

---

## 설정 메뉴 구조

**설정** 탭은 6개 그룹으로 묶여 있습니다(v2.155~2.164에서 정리).

| 그룹 | 하위 메뉴 |
|---|---|
| 🖥️ **vCenter 관리** | vCenter 등록·관리 · vCenter 연결 테스트 |
| 🗄 **수집 서버** | iDRAC 서버 등록 · **스캔 로그**(주기/수동 스캔 실행 이력, 통합/법인별) · 지표 수집 · 게스트 계정 추가 · 수집 서버(원격) · **원격 법인(DC)에 Edge 노드 포탈 설치** |
| 🎮 **GPU 사용량 수집** | GPU 수집 · GPU 게스트 수집 · GPU 수집 진단 |
| 👤 **User Control** | 메인포탈 사용자 관리(계정 CRUD·OTP 등록/해제·**비번 설정/로그인 차단**·**데이터 범위(scope)**·**기능 권한 매트릭스**·**특수기능 도구별 접근**) · **엣지 사용자 배포** · 인증(AD) |
| 🛡️ **Security** | 세션 보안 · 이상동작 탐지 |
| 📋 **Log** | vCenter 로그 보관 · 진단·로그 · 감사 로그 |

그 외 단독 메뉴: DataCenter(법인) · NSX 관리 · 중계 서버 · 원격접속 설정 · AI 검색 · 알림 · 포탈 백업 · ⬆ 업그레이드 · About.

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
| `UPGRADE_ALLOW_UNVERIFIED` / `UPGRADE_TLS_INSECURE` | sha256 미검증 번들 허용(기본 거부) / 업그레이드 fetch TLS 완화 |

> **무결성**: 번들 sha256 검증이 **필수**입니다(공식 릴리스는 항상 제공). 중앙→엣지 푸시는 검증 TLS 디스패처를 사용합니다. 서명 없는 사내 미러만 부득이 `UPGRADE_ALLOW_UNVERIFIED=true`로 우회하세요.

관리자 **업그레이드** 탭에서 GUI로 설정·확인·적용·재시작. 설정은 `config/upgrade.json`(gitignore)에 보존, 환경변수는 기본값. 실행 버전은 상단 바 배지로 표시.

---

## 보안 / 운영 메모

- 자격증명/시크릿(`vcenters.json`, `users.json`, `*-assignments.json`, `central-agent-*.json`, `horizon.json`, 스캔/게스트 계정 등)은 `CONFIG_DIR`에 `0600` + **원자적 쓰기**(tmp+fsync+rename)로 저장되고 API 응답에서 마스킹됩니다. 손상 시 `<파일>.corrupt.<ts>`로 보존해 조용한 유실을 막습니다. 운영 시 `AUTH_SECRET` 지정 + 최초 임의 비밀번호(`initial-admin-password.txt`) 변경 필수. 보안 응답 헤더(X-Frame-Options·nosniff·HSTS)·CORS 기본 차단·업그레이드 sha256 필수 등은 [설치 가이드 §7](docs/INSTALL.md) 참고.
- **역할(RBAC) + 기능 권한** — `admin` / `operator` / `viewer` 3역할에 **기능 권한 매트릭스**(17개 키)를 얹어 설정 › 사용자 관리에서 역할별로 조정합니다. 상태변경 API와 **브라우저 SSH/RDP 터널**은 해당 권한(`remote.access` 등)이 있어야 하며, 기본값은 종전대로 `admin`·`operator`만 가능하고 viewer는 조회 전용입니다. **서버가 진실의 원천**이라 UI에서 버튼을 숨기는 것과 별개로 API 직접 호출도 차단됩니다. 비밀번호·역할 변경·계정 삭제·로그인 차단 시 그 계정의 **기존 토큰이 즉시 무효화**됩니다.
- **고권한 OTP 전용 로그인 + 강제 등록 (v2.206+)** — `admin`·`operator`(수퍼관리자 포함) 로컬 계정은 최종적으로 **OTP 6자리로만** 로그인합니다. 도달 흐름은 3단계입니다:
  1. **부트스트랩** — OTP 미등록 계정만 비밀번호로 로그인 가능(최초 설치·계정 발급 직후).
  2. **강제 등록** — 그 세션은 `mustEnrollOtp`로 표시되어 **OTP 등록 외 모든 API가 차단**(`requireEnrolled` → 403 `otp_enrollment_required`)되고, 프론트도 등록 화면에 고정됩니다.
  3. **비번 폐기** — 등록 확정 시 서버가 **비밀번호 해시를 삭제**하고 토큰을 폐기 → 이후 비밀번호 로그인 경로 자체가 사라집니다. 최초 관리자용 `initial-admin-password.txt`도 자동 삭제됩니다.
  - 로그인 화면은 초기 구축 중에만 **비밀번호 파일 경로를 팝업으로 안내**합니다(값이 아닌 경로만, 등록 완료 후 노출 중단).
  - 헤드리스 등록·잠금 복구: `sudo vmware-portal-otp <username>`(설치본) / `npm run otp-enroll -- <username>`(소스). 기동 시 OTP 등록 admin이 없으면 서버 로그가 절차를 안내합니다. 긴급 해제는 `OTP_ROLE_ENFORCE=false`. viewer·데모 계정은 강제 대상이 아닙니다.
- **특수 계정** — `noainred`(수퍼관리자)는 항상 admin이 보장되고 강등·삭제·로그인 차단이 거부되며 설정 소유자에 자동 포함됩니다. `thedvcdemp`(데모)는 viewer 고정·삭제 불가이며 **비밀번호가 설정된 동안에만** 로그인됩니다([로그인 차단]으로 즉시 잠금 + 활성 세션 종료).
- **설정 접근 계정(settingsOwners)** — '설정' 탭은 지정 계정만 보고 접근합니다(서버측 강제). 지정 방법 3가지가 **합산** 적용됩니다: ① `portal.env`의 `SETTINGS_OWNERS=계정1,계정2` ② `$CONFIG_DIR/settings-owners.txt`(한 줄에 하나, `#` 주석 가능) ③ 포탈 UI(설정 › 세션 보안). ①②는 서버 파일이라 **UI 저장으로 지워지지 않아**, 아무도 설정에 들어가지 못하는 잠금 상황의 복구 경로가 됩니다(`noainred`는 항상 자동 포함).
- **사용자별 데이터 범위(scope)** — 계정에 허용 vCenter/리전을 지정하면 인벤토리 목록과 vCenter 필터가 서버에서 그 범위로 제한됩니다(외주·감사·데모 계정에 유용). 전역 KPI 합계 등 일부 집계 화면은 후속 확대 예정.
- **엣지 토큰 스코프** — 공유 `CENTRAL_TOKEN` 하나를 전 엣지가 쓰면 엣지 1대 침해로 다른 사이트 자격증명까지 노출됩니다. **설정 → 수집 서버 → 🔑 엣지별 개별 central 토큰**에서 사이트별 토큰을 발급해 이관하세요(무중단, 미이관 엣지는 화면에 표시). 이관 후 `CENTRAL_REQUIRE_AGENT_TOKEN=true`.
- **버전 파일** — 기동 시 `CONFIG_DIR/vmware-portal-release`에 실행 버전·역할(central/edge/…)을 기록합니다(`/etc/redhat-release` 방식) — 배포 점검·자산 조사용.
- 시계열(온도/GPU/용량)을 분 단위·장기 보존하면 데이터가 커집니다 — **설정 › 지표 수집**에서 주기/보존기간을 조절하세요.
- 모니터링은 **읽기 전용 vCenter 계정** 권장. VM 생성/Tools 업그레이드/원격접속 등 쓰기·운영 기능은 권한 있는 계정과 승인 절차로 사용하세요.
