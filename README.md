# VMware Global Monitoring Portal (The.DVC)

전 세계 데이터센터에 분산 운영 중인 다수의 **VMware vCenter / NSX** 인프라를 하나의 포탈에서
통합 모니터링·운영하는 대시보드입니다. VM · ESXi 호스트 · 스토리지 · 네트워크 · 알람뿐 아니라
**전력(iDRAC/OME) · 온도 · GPU · IP 관리대장 · 용량 예측 · 원격접속 · VM 생성**, 그리고
**인사이트(FinOps·AI 이상탐지·보안·토폴로지) · 운영 리포트 10종(일일 헬스체크·스냅샷 나이·좀비
리소스·인증서 만료·라이트사이징 등, v2.217) · 스토리지 어레이 모니터링(PowerScale·PowerStore·
Unity·XtremIO·VMAX/PowerMax·VPLEX/Metro Node, v2.302+) · VM 복제(백업식 스케줄, v2.299) ·
**VM 수량·스토리지 사용량 추이**(매일 00/12시 스냅샷 트래킹, v2.345+) · **베어메탈 스토리지**(SSH df
합산·엣지 위임, v2.340) · 포탈/구성 백업 · vCenter 로그 장기보관 · 네트워크 트래픽 분석(tcpdump) ·
게스트 계정 관리 · 심층 검색**까지 한 화면에서 다룹니다.

> 실제 vCenter 자격증명이 없어도 **현실적인 목(mock) 데이터로 즉시 실행**됩니다.
> 실 환경에서는 포탈 UI(또는 `server/config/vcenters.json`)에 vCenter만 등록하면 됩니다.

- 백엔드: Node.js / Express (집계 API + 분산 에이전트/중앙 오케스트레이션)
- 프론트엔드: React + Vite (다크 NOC 테마, 세계지도, recharts)
- 저장소: Node 내장 `node:sqlite`(시계열/IPAM) + NDJSON 폴백, 설정 JSON(0600)
- 배포: 에어갭 오프라인 설치(Rocky/CentOS 9), Windows 패키지, 자가 업그레이드

> 📦 **설치는 [docs/INSTALL.md — 설치 가이드(중앙/엣지/수집기 + 토큰·방화벽)](docs/INSTALL.md)** 참고.
> 오프라인 패키지/업그레이드 상세는 [packaging/offline/OFFLINE-INSTALL.md](packaging/offline/OFFLINE-INSTALL.md).

> 📖 **사용자 수준별 가이드(화면 캡처 포함)** —
> [처음 사용자](docs/GUIDE-BEGINNER.md) · [중급 사용자(운영 실무)](docs/GUIDE-INTERMEDIATE.md) ·
> [관리자(설치·구성·보안)](docs/GUIDE-ADMIN.md)

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
- [서비스 바로가기 허브 (별도 페이지 · Python)](#서비스-바로가기-허브-별도-페이지--python)
- [오프라인 설치 & 패키징](#오프라인-설치--패키징)
- [자동 업그레이드](#자동-업그레이드)
- [보안 / 운영 메모](#보안--운영-메모)

---

## 주요 기능

### 모니터링 / 대시보드
- **글로벌 개요** — 전세계 KPI(vCenter/호스트/VM/CPU/메모리/스토리지/알람), 세계지도 위 사이트 마커(정상/경고/위험), 리전(Americas/EMEA/APAC) 롤업, 차트.
- **통합 서머리** — 모든 vCenter 자원을 SUM(개수·물리용량·할당·오버커밋·전력·Guest OS 분포·vCenter별 기여도). 리전/vCenter 스코프.
- **vCenter 카드 & 드릴다운(Platform 탭)** — 등록된 vCenter를 카드로 표시, 클릭 시 호스트·클러스터/VM·폴더/데이터스토어/네트워크 트리. **VM 검색**(다단어 OR·메모 포함, v2.293) + 일치 VM 자원 합계. 트리의 vCenter·클러스터·호스트 행에 **CPU/MEM 가상화율**(할당÷물리, v2.270) 표시, **'Off VM 포함' 체크박스**(v2.333~2.336)로 꺼진 VM 을 트리·검색·VM 수·가상화율에서 제외 가능. **'전체 현황' 평면 표 + CSV**(v2.335) — 트리를 펼치지 않고 모든 클러스터·호스트의 상태·VM수·사용률·가상화율·할당/물리 자원·ESXi 버전·모델·전력·온도를 한 표로 보고 그대로 내려받음. 전체 VM/호스트의 **다빈치/IRS 분류** 표시(v2.323~2.324).
- **상단 메뉴(v2.271·2.274 개편)** — `Overview · Summary · Platform · Monitoring(성능점검) · VM호스트 · 가상머신 · 스토리지 · 네트워크 · IP관리 · 알람 · 특수 기능 · 인사이트 · 설정`. 탐색·랭킹과 NSX 는 특수 기능 하위 카드로 이동, IP 관리대장은 상단 탭으로 승격.
- **리소스 탐색 & 랭킹** — 호스트/VM/스토리지/네트워크/알람 정렬·검색·필터, Top N 랭킹, VM 사양·사용률 검색.
- **호스트/VM 성능** — CPU/메모리/디스크/네트워크 **실시간 + 일·주·월·년 + 날짜 기간** 시계열(vim25 PerformanceManager).
- **알람 + 음소거** — vCenter 알람 집계, 음소거 규칙.
- **성능점검(svcmon, v2.230+)** — vCenter 인벤토리와 **독립**된 임의 호스트/서비스 감시 모듈(별도 `svcmon.json`·전용 워커풀·CSV 로그). 15종 점검(ping·trace·tcp·udp·http·soap·dns·cert·ntp·smtp·pop3·imap·ssh·ldap·domain), 인프라/서비스 트리, 3단계 추가 마법사. 1만 대·일 2GB 로그를 전제로 만기 인덱싱·원형 커서 선정(과부하 시 뒤쪽 굶음 방지)·틱당 상한·스트림 CSV 로 설계. 성능점검 화면 우측 상단 **⚙ 설정** 버튼으로 아래 설정 화면에 바로 진입(v2.256, 현재 모드·경로 프리필). **특수 기능 → 성능점검 설정**에 6개 서브탭:
  - **점검 템플릿(v2.244)** — 서버 유형별 점검 묶음(빌트인 6종: Linux·Windows·웹/TLS·DNS·메일·디렉터리) 정의→대상 일괄 적용. 치환 변수(`{host}{name}{path}{kind}`), 재적용 멱등(test.id 승계), CSV 가져오기/내보내기(v2.246).
  - **대량 자동등록(v2.244, v2.251 강화)** — 이름 규칙(`{n}`)+**시작~끝 번호·자리수**로 대상 생성+템플릿 자동 할당. 주소는 **IP 범위/CIDR · 자동(hostname 그대로 / DNS 쿼리로 IP 고정) · 수동(호스트별 IP 직접)** 세 방식. 수동은 **호스트↔IP 를 CSV/JSON/XLSX 로 가져오기 + 이름 채운 템플릿 다운로드**. '어디에 만들까요'는 텍스트 입력 + **기존 폴더 트리 선택**. 개수 불일치·미해석 DNS·차단/미귀속 주소는 전체 거부(부분 등록 금지), 배치 이력·롤백.
  - **가져오기·내보내기(v2.243, v2.251 전 포맷)** — 대상·점검을 **CSV · JSON · 엑셀(XLSX)** 로 가져오기/내보내기(확장자 자동 판별, 세 포맷 모두 같은 파서로 검증 — 규칙 단일화). 샘플 제공, 용량 판정, 미리보기→커밋 all-or-nothing.
  - **엣지 배정(v2.245, RMA)** — 중앙은 실행 안 하고(`SVCMON_ROLE=central`) 정의를 엣지에 배포, 엣지가 실행·결과 push. 목록 선택형 배정 + **통신 진단**(ping/TCP RTT) + 무보고 감시·알림.
  - **로그 설정(v2.246)** — 저장 경로(대용량 볼륨)·분할 단위·보관 기간·용량 상한(경로는 쓰기 시험 통과 필수).
  - **로그 분석(v2.246)** — 시간/일/주/월/분기/반기/연간 집계(가용률·평균·p95). CSV 로그 스트리밍+예산, 조회 범위 표시.

### 인프라 운영
- **NSX** — NSX-T/4.x 매니저별 게이트웨이(T0/T1)·세그먼트(Overlay/VLAN, 연결 VM 포트 수)·분산방화벽(DFW, 허용/차단·로깅)·보안그룹(**라이브 멤버 조회**).
- **스토리지 어레이 모니터링 (v2.302~2.326)** — 글로벌 법인의 물리 스토리지를 **엣지 현지 수집 → 중앙 집계**로 통합 조회. 수집기 카탈로그 8종 전체 구현: **PowerScale/Isilon**(SSH `isi status` 파싱이 기본 + OneFS API 39개 영역 선택) · **PowerStore · Unity · XtremIO · VMAX/PowerMax · VPLEX/Metro Node**(REST). 용량(HDD/SSD 풀 분리)·노드별 상세(IP·상태·처리량)·Critical Events·버전을 수집해 SQLite 시계열로 저장, 장비 상세에 **용량 추이 그래프**(v2.318). 장비 CSV 가져오기/내보내기(비밀번호 포함 내보내기 선택 + 가져오기 드라이런 검증, v2.317), 수집 방식(SSH/API) 표시, 전체 새로고침 + **수집 작업 로그 패널**(진행중/완료, v2.315), 실패 사유 표시.
- **VM 복제(백업식) (v2.299)** — vCenter별 VM 지정 → 스냅샷 시점 무중단 클론. **스케줄 정기 복제**·대상 데이터스토어/NFS 선택·**최근 N개 보존**(오래된 사본 자동 정리)·Platform 트리에 Clone/veeamed 배지.
- **VM 전체 정보 CSV (v2.275·2.278)** — 선택 vCenter 모든 VM 을 **85+ 컬럼**(호스트·클러스터/CPU·코어/메모리/NIC·MAC·IP/디스크 1~7 슬롯별 용량·타입·데이터스토어·파일/게스트 파티션/스냅샷/Tools/UUID 등)으로 내보내기.
- **데이터스토어 브라우즈 (v2.276)** — 데이터스토어 클릭 시 할당된 VM 과 실제 파일 목록(크기·유형·수정시각).
- **파트 인벤토리 (v2.328~2.330, 서버 분석 내)** — iDRAC Redfish 로 물리 서버의 전체 하드웨어 파트(CPU·DIMM·디스크·NIC·PSU 등)를 수집·필터·드릴다운. 장착 서버 목록에 호스트 IP·호스트네임 병기.
- **베어메탈 스토리지 (v2.340~2.341)** — 하이퍼바이저 밖 물리 서버의 로컬 디스크 용량을 **SSH(df)** 로 주기 수집(마운트 포인트 복수 지정·사용자 지정 주기). 서버는 **최대 3개 그룹** 소속 가능, 서버/그룹/전체 합산(총·사용·가용). 중앙에서 직접 접속 불가한 서버는 **엣지 위임(중앙→엣지 PUSH + claim→ack)** 으로 점검. 서버 목록 CSV 가져오기/내보내기(드라이런 검증 → 덮어쓰기 확인).
- **VM 수량 추이 (v2.345~2.347)** — vCenter별 **매일 00시·12시 스냅샷**을 전용 DB(`vm-track.db`)에 적재해 총 VM·켜짐/꺼짐·생성/삭제·전원 전환(Off↔On)을 추적. 증감 숫자를 누르면 **어떤 VM 이 어느 클러스터·호스트·데이터스토어에** 생기고 사라졌는지 확인. moref 기반 diff 라 이름 변경을 생성+삭제로 오탐하지 않고, 최초 스냅샷은 기준선(전량 신규 오탐 방지). 저장은 diff 만(전량 로스터 미적재 — 연 427만 행 대신 ~2만 행).
- **스토리지 사용량 추이 (v2.348~2.356)** — 같은 00/12시 스냅샷으로 vCenter 연결 데이터스토어의 용량·사용량·사용률 추적. 합계 차트(**총 용량 한도선 + 슬롯별 사용량 막대**) · vCenter별 표(콤보 이름순 정렬) · **DS별 개별 시계열**(diff-압축: 첫 관측 + 1GB 이상 변화만 저장, 조회 시 step 펼침) · 선택 vCenter 전체 DS 미니 차트 그리드(12개 페이지) · **스토리지 변경 이력**(시각별 슬롯+DS 칩 / DS별 슬롯 피벗 두 보기) · 일평균 증가량·선형 소진 예상(추정임을 명시). 상단 '스토리지' 탭 각 행의 📈 버튼으로도 개별 DS 추이 확인. 값 소급 없음 — 관측 이전 슬롯은 공백/'—'.
- **일괄 등록 CSV 확대 (v2.338~2.339)** — **수집 서버(원격 엣지)**·**엣지 배포 대상**·**iDRAC 스캔 대역**을 CSV 로 가져오기/내보내기. 공통 규칙: 드라이런 분석(문법·중복·참조 검증) → 덮어쓰기 여부 확인 → 커밋, 수식 주입 방어(RFC4180), 샘플 다운로드. 비밀값 컬럼은 기본 공란(옵션+설정 소유자+감사 로그로만 포함).
- **전력(iDRAC/OME)** — Dell Redfish/OpenManage로 호스트 전력(W) 수집·시계열, ESXi 전력은 vim25에서도 수집. IP 대역 스캔으로 iDRAC 대량 등록.
- **온도 / GPU / 용량** — ESXi 온도(현재/5분평균/최대 + 5년 추이, 분/시간/일 단위), GPU 인벤토리(**vGPU/패스쓰루 구분**, 사용률 5년 추이, 게스트 OS 수집), 데이터스토어 용량 추세·포화 예측.
- **NIC 분석 (v2.179+)** — iDRAC Redfish 인벤토리로 서버 물리 NIC의 **속도별 분류**(10G/25G/100G — 미링크 포트도 카드 정격으로 판별)와 **모델별 분류**(Intel·Broadcom·Mellanox…). DataCenter·가상화(ESXi)/베어메탈 필터, vCenter 수집(pnic+PCI) 결과를 **별도 컬럼**으로 교차 확인, CSV.
- **라이선스 만료일 (v2.189+)** — vCenter LicenseManager 전 제품 키(ESXi/vSphere·vCenter·vSAN·VCF/VVF 등) + NSX Manager + **Horizon Connection Server**(REST 직수집, 10분 캐시)를 한 화면에. 만료·90일 임박·정상·영구 분류, 제품군 필터, 남은 기간(D-일수) 정렬, CSV.
- **핑/네트워크 모니터링** — 네트워크 탭의 ① Ping 모니터링(등록 대상 ICMP/TCP 도달성·RTT 시계열) ② 서버 Ping 체크(엣지/수집 노드 TCP 지연을 DC별 산점도) ③ vCenter 포트 응답속도(사용자 지정 포트를 vCenter별 측정). 별도 시계열 DB(`ping-monitor.db`, 1년 보존)·baseline 대비 색상 추세.
- **IP 관리대장(IPAM)** — vCenter 수집 IP(서버종류 VM/베어메탈, OS 종류·버전) + **능동 스캔(TCP 커넥트 + ICMP ping, v2.359)** 으로 물리/기타 장비 IP 보강 · IP별 사용 이력(사용중/과거 사용, 사용·미사용 구간). 서브넷 엑셀형 대장, 중복 IP, CSV/XLSX, 외부 공유 SQLite(`ipam.db`).
- **통합 서버 인벤토리** — iDRAC/OME 수집 물리 서버 + vCenter ESXi 호스트를 Dell 서비스태그로 조합해 **가상화 호스트 / 베어메탈**을 자동 분류. 베어메탈 **총전력 집계**, 소속 **법인(vCenter) 등록**(자동 추론·일괄 등록·수동 예외), **엣지→중앙 집계**(전력 없는 발견분까지 DC별 검색).
- **VM 생성(프로비저닝)** — 단건/대량 클론 + 게스트 커스터마이징(이름/IP 규칙), 동시성 제한 작업 큐, 작업 이력·메모/태그.
- **VM 사양 변경(관리자)** — `ReconfigVM_Task`로 vCPU·RAM 증설, 코어/소켓, 디스크 증설/추가(컨트롤러 선택), NIC 추가/삭제·연결 토글. **증설만**(감소·축소 차단) + hot-add 판정 + 확인창 + 감사로그.
- **원격 접속** — 브라우저 SSH(xterm.js/WebSocket)·RDP(Guacamole), HAProxy Data Plane API로 임시 포트 매핑(TTL 1일), `.rdp` 다운로드, VM에서 빠른 접속.
- **AI 자연어 검색** — 로컬 LLM(Ollama)로 "북미 메모리 90% 넘는 호스트" 같은 질의 → 구조화 검색(불가 시 규칙 기반 폴백).

### 인사이트 / 분석 (v1.88+)
- **인사이트 패널** — 💰 FinOps(전력→kWh·요금·CO₂, PUE/단가 설정) · 🤖 AI 이상탐지(중앙값·MAD Z-score) · 📈 용량/수명 예측(선형회귀 ETA) · 🛡 보안(ESXi/vCenter 빌드 ↔ 내장 VMSA·EOL) · 🌐 토폴로지 · 🚨 인시던트 타임라인 · 💬 LLM ChatOps.
- **구성도(3D)** — 설정된 라이브 구성을 3D 네트워크 그래프로(중앙→엣지→vCenter→NSX/호스트→VM, 줌·회전, vCenter/호스트 포커스로 VM 단위 탐색).
- **리소스 적정성 진단 / Capacity Advisor (v2.254+, 관리자 전용)** — **포탈이 도는 서버(중앙 + 엣지 에이전트)** 자신의 CPU(시스템/프로세스)·메모리(시스템/RSS)·부하평균/코어·**이벤트 루프 지연(p99)**·디스크 사용률·네트워크 처리량(리눅스)을 운영 중인 프로세스 안에서 30초마다 **상시 실측**해 시계열(`capacity.db`, 원본 72h + 시간당 롤업 ~13개월)로 기록. **1일/1주/1달** 창별 p50/p95/max 로 **증설/적정/감축**을 실측 근거와 함께 조언(증설=p95≥위험 임계 · 감축=1달 피크조차 경고의 절반 미만 · 표본 부족 시 '측정 중'). 엣지는 자기 리소스를 1분마다 중앙으로 push(개별 토큰·agent 바인딩). 수집기는 등록형(`registerCollector`)이라 새 지표를 한 곳에 등록하면 게이지·추세·권고에 자동 편입. 환경변수 `CAPACITY_MON_ENABLED`·`CAPACITY_SAMPLE_INTERVAL_MS`(기본 30초)·`CAPACITY_RAW_RETENTION_HOURS`(72)·`CAPACITY_ROLLUP_RETENTION_DAYS`(400)·`CAPACITY_PUSH`.
- **Prometheus/OTel 익스포터** — `/metrics`로 호스트 CPU·MEM·전력·GPU, 데이터스토어, VM 카운트 노출(`METRICS_EXPORT_TOKEN` 필요 — 미설정 시 비활성).
- **다빈치 서비스 점검 / 글로벌 네트워크 점검** — 내부 서비스·수집기 상태 + 제어플레인(vCenter/NSX) 도달성·RTT.
- **심층 검색** — 게이트웨이·서브넷(CIDR)·OS·GPU·범위 등 다조건 + 게스트 탐침(GPU 드라이버/특정 프로세스). 전체/특정/복수 vCenter.
- **운영 리포트 10종 (v2.217+)** — 커뮤니티(vCheck·RVTools) 표준 점검 항목을 특수 기능에 내장:
  ① **일일 헬스체크 리포트**(스냅샷·용량·Tools·연결·인증서 요약 + **매일 지정 시각 웹훅 자동 발송**)
  ② **스냅샷 나이 감시**(생성일 기준 N일 이상 탐지) ③ **좀비/방치 리소스**(고아·접근불가 VM·장기 정지·스냅샷 대식가 — 회수 용량 추정)
  ④ **인증서 만료 감시**(vCenter·NSX TLS 12시간 프로브, D-90/D-30) ⑤ **VM 라이트사이징**(관측 평균/피크 기반 축소 추천)
  ⑥ **용량 고갈 예측**(선형회귀 ETA) ⑦ **알림 채널·이력**(Slack/**Teams**/웹훅 + 전역 중복 억제)
  ⑧ **버전/패치 준수**(Tools 업그레이드 필요·VM HW 버전·ESXi EOL) ⑨ **구성 변경 이력**(누가 언제 무엇을 — 이벤트 타임라인)
  ⑩ **미보호 VM**(백업 소프트웨어 스냅샷 이벤트 미관측 VM). 모든 리포트는 사용자 데이터 범위(scope)를 서버에서 강제.

### 백업 / 로그 / 네트워크 진단 (v1.88+)
- **포탈 백업** — 중앙+엣지 설정을 gzip로 통합 백업(정기/변경 자동, 보관·복원). **VMware 구성 백업**(사이트 수집 구성 스냅샷).
- **vCenter 로그 장기보관** — vim25 EventManager로 이벤트 증분 수집해 SQLite/NDJSON 장기보관(보관기간·용량·저장경로 설정). **분산 저장**(각 엣지 로컬) + 중앙 **연합 조회**.
- **네트워크 트래픽 분석** — 두 서버 간 `tcpdump` 캡처·진단(핸드셰이크·재전송·RST), **동시(양방향) 비교**, **에이전트 위임 캡처**, **pcap 다운로드**, **캡처 이력**, **연속 모니터링**(주기 캡처 + 이슈 알림) + 로그 자체 장애 탐지.
- **게스트 계정 추가** — VMware Tools(게스트 작업)로 게스트 OS에 sudo 계정 생성(비밀번호 파일 전달로 셸 노출 회피, 다중 VM, 감사 로그).
- **VM IP Ping** — 중앙이 못 가는 사설 IP를 엣지 에이전트가 대행 ping(VM 상세에서 녹/적).
- **PWA** — 설치 가능 + 위험 인시던트 브라우저 알림.

### 관리 / 운영 편의
- **인증/RBAC** — scrypt 해시 + HS256 JWT, 역할(admin/operator/viewer), **TOTP 2FA**, **Active Directory(LDAP)** 연동. **admin·operator는 OTP 전용 로그인**(v2.204+, 아래 참조).
- **로그인 방식 선택 (v2.272~2.273)** — 설정 › 세션 보안에서 전역 정책을 **OTP 전용 / OTP+비밀번호(혼용) / 비밀번호 전용** 중 선택. 서버 구성 파일로 **특정 사용자만** 다른 방식을 지정하는 사용자별 재정의도 지원(UI 미노출).
- **단일 세션 강제 (v2.280)** — 설정 › 세션 보안에서 켜면 계정당 동시 1세션(ID 공유 방지 — 새 로그인 시 기존 세션 종료).
- **자격증명 저장 방식 선택 (v2.296~2.297)** — vCenter 등 저장 자격증명을 **평문/암호화**(보안 레벨 1·2·3 또는 알고리즘 선택)로 저장, 양방향 일괄 전환. 특수 기능 **'평문 자격증명 점검'** 이 설정 파일·portal.env·로그·소스에 남은 평문 계정정보/토큰을 탐지(값은 마스킹)해 전환을 안내.
- **기능별 권한 매트릭스 (v2.196+)** — 역할은 3개로 두되 **기능 단위 권한 키 17종**(대시보드·인벤토리 6종·특수기능·인사이트·원격접속·원격콘솔·VM 사양변경/프로비저닝·게스트계정 배포·설정·업그레이드·사용자관리)을 **설정 › 사용자 관리에서 체크박스로 켜고 끕니다**. 서버(`requirePerm`)와 WS SSH/RDP 게이트웨이가 실제로 강제하므로 메뉴를 숨겨도 API 직접 호출은 차단됩니다. admin은 항상 전체(잠김 방지). 기본값은 기존 role 동작과 동일해 도입만으로 권한이 바뀌지 않습니다.
- **특수 기능 도구별 접근 (v2.197+, 표시 v2.209.0)** — 특수기능 도구(현재 67종, `web/src/views/specialToolsList.js` 단일 소스)를 역할별로 **개별 차단**(deny-list). '전체허용/전체차단' 일괄 설정 지원. 상단 '특수 기능' 탭은 항상 노출되고, 권한 없는 도구는 숨기지 않고 **회색·클릭 불가(🔒 권한 없음)** 로 표시해 어떤 기능이 있는지 확인하고 관리자에게 요청할 수 있습니다(딥링크로도 열리지 않으며 서버 API 도 별도 강제).
- **사용자별 데이터 범위(scope) (v2.196+, v2.255~2.257 전면 강제)** — 계정마다 **볼 수 있는 vCenter/리전**을 지정(예: 폴란드 법인 계정은 유럽 리전만). 호스트·VM·스토리지·네트워크·알람 목록과 vCenter 필터가 서버에서 제한됩니다(미지정 시 전체). v2.255~2.257 에서 범위 강제를 **자연어/심층/VM 정밀 검색·운영 리포트·특수기능 집계(GPU·위협·용량·낭비·GuestOS·하드웨어·라이선스 등)·IPAM 조회 및 쓰기(override·정책)** 전반으로 확대했고, `/summary`·`/overview` 의 캐시 교차 노출도 캐시 키에 범위 서명을 넣어 차단했습니다. 외부 프로그램이 공유하는 `ipam.db` 원장 자체는 범위를 적용하지 않습니다(전체 유지).
- **특수 계정 (v2.202~2.204)** — **`noainred` 수퍼관리자**(항상 admin 보장·강등/삭제/로그인차단 불가·설정 소유자 자동 포함), **`thedvcdemp` 데모 계정**(viewer 고정·삭제 불가, **비밀번호가 설정된 동안만 로그인** — 설정 › 사용자 관리에서 [비번 설정]/[로그인 차단]으로 열고 잠금).
- **감사 로그 / 진단·로그** — 쓰기 작업 감사(JSONL), 연결 실패 원인(한국어 힌트) + 실시간 서버 로그 뷰어.
- **알림** — 임계치 규칙 → Slack/**Microsoft Teams**/웹훅(상태전이·쿨다운 + **전역 중복 억제 창**, v2.217). 웹훅 URL 저장 시 SSRF 검증. **일일 헬스체크 리포트 자동 발송**(매일 지정 시각, 관리자 설정).
- **자동 업그레이드** — `versions.json` 모니터링 → 다운로드·적용·재시작(롤백 가능), 엣지 푸시.
- **분산 수집** — 원격 데이터센터 에이전트 pull(전력 등) + 중앙 할당(iDRAC/IP 스캔). **통합 엣지 모드**(`EDGE_MODE=all` + `CENTRAL_URL` + `EDGE_TOKEN` 3줄)로 수집·위임 스캔/핑/캡처/로그 워커·인벤토리 push·자동 업그레이드·부팅 시 중앙 자동 등록을 일괄 활성. **위임 iDRAC 스캔**은 엣지 폴링 또는 **중앙→엣지 직접(PUSH)** 방식 + 2단계 claim→ack로 인출 유실 방지. 중앙 **에이전트 배포**(SSH 원클릭 설치)·**에이전트 작업**(IP대역 할당) 지원.
- **중앙 → 엣지 배포 (v2.170+)** — 중앙 UI에서 원격 엣지의 **GPU 게스트 수집 설정**과 **접속 사용자 계정**을 만들어 내려보낸다(엣지가 주기적으로 pull — NAT/폐쇄망 안전). 복수 엣지·전체 엣지 동시 배포, 배포된 계정 수정/제거, 중앙 배포 admin은 엣지 설정 메뉴 자동 허용.
- **엣지 운영 도구** — 수집 서버 **토큰 강제 동기화**(403 토큰 불일치를 SSH로 즉시 교정 — 리슨 포트로 실제 인스턴스 역추적), Edge 노드 SSH 배포·상태 확인, 엣지 인증 거부 카운터 표시.
- **보안** — scrypt+HS256 JWT·TOTP(1회용)·AD 외에, **고권한 OTP 전용 로그인 + 강제 등록**(admin·operator는 등록 후 비밀번호 삭제, v2.206.0)·기능 권한 매트릭스 서버측 강제(WS SSH/RDP 포함)·**사용자별 데이터 범위**(단건 라우트 포함, v2.207.0)·**백업 인출을 설정 소유자로 제한 + 감사 로그**(v2.210.0)·**서버측 토큰 폐기**(비번/역할 변경 시 즉시 무효)·보안 응답 헤더·CORS 기본 차단·임의 초기 관리자 비번·SSRF/명령주입 방어·번들 sha256 필수·**엣지별 개별 central 토큰**(공유 토큰 스코프 축소, v2.191.0)·**자격증명 파일 손상 보존**(로드 실패 시 `.corrupt` 백업 — 전량 유실 방지)·**RDP 자격증명 1회용 티켓**(URL 미노출)·**설정 소유자 서버측 강제**(v2.195.0). 별도 페이지 서비스 허브는 **6차 감사(v2.214.0)** 로
CSRF·SSRF 스캐너·정보노출·잠금 DoS 를 차단했습니다. 이후에도 전수 보안 감사를 반복해 조치를 누적하고
있습니다 — v2.258~2.261(전 소스 재점검 + 3D 토폴로지 XSS·RDP 티켓·SSRF 재검증 등 21건),
v2.288~2.290(인사이트 scope 누수·위임 잡 소유권), v2.314·2.321~2.322(**7차원 전수 감사** 확정 11건 +
NSX/원격접속 scope 갭). 상세 [설치 가이드 §7](docs/INSTALL.md)·[감사 이력](SECURITY-AUDIT.md).
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
  - `nsx/`, `idrac/`, `ipam/`, `gpu/`, `metrics/`, `provision/`, `proxy/`, `llm/`, `collector/`, `central/`, `agent/`, `upgrade/`, `auth/`, `storage/`(스토리지 어레이 수집기 8종), `vmclone/`(백업식 복제), `svcmon/`(성능점검), `capacity/`(Capacity Advisor), `reports/`(운영 리포트), `vmtrack/`(VM 수량·스토리지 사용량 추이 — 전용 `vm-track.db`), `bmstor/`(베어메탈 스토리지 SSH 수집·엣지 위임), `horizon/` — 각 하위 시스템.
- **web/** — React + Vite. 해시 라우팅 `#/<탭>`, 특수기능 딥링크 `#/tools/<기능>`. 전 뷰 lazy 청크 분할, 3D 토폴로지(1.3MB)는 클릭 시 동적 로드.

### 성능 설계 (28 vCenter · 고RTT 최적화, v2.106+)

| 계층 | 메커니즘 |
|---|---|
| HTTP 응답 | 자체 gzip 미들웨어(비동기 zlib) + **ETag/304** — 스냅샷(30초)보다 짧은 폴링(15초)의 무변동 응답은 본문 0바이트로 재검증만. 프론트 `pollFetch`가 If-None-Match 자동 처리. 라우트가 직접 발급한 ETag 존중 + **페이로드 단위 직렬화·SHA-1·gzip 1회 캐시**(WeakMap, v2.342~2.343), 인벤토리 목록 5종은 스냅샷 단위 캐시(사용자 scope 서명 포함) |
| SOAP 파싱 | 대형(256KB↑) RetrieveProperties XML 정규식 파싱을 **worker_threads 풀**(기본 min(4, CPU-1))로 zero-copy 오프로딩 — 매 주기 파싱이 메인 이벤트 루프를 막지 않음. 소형·워커 실패 시 인라인 폴백(동일 결과), 워커 사망 시 자기치유(`SOAP_PARSE_WORKERS`) |
| SQLite | 전 시계열 DB **WAL + synchronous=NORMAL + busy_timeout**(커밋 fsync 대폭 절감 — 단건 insert 5ms→0.01ms 실측). 외부 프로그램이 읽는 `ipam.db`만 기본 저널 + busy_timeout 유지 |
| 전력 시계열 | 서버별 최신값 **인메모리 캐시**(기동 시 1회 시드, 쓰기 시 O(1) 갱신) — 매 30초 GROUP BY 풀스캔 제거. 24h 집계는 **시간당 롤업 테이블**(`power_hourly`, 적재 트랜잭션 내 증분 upsert)로 수억 행 대신 ~24행 스캔 + 60초 캐시. 적재는 단일 트랜잭션 배치(insertMany), prune은 10틱 스로틀 + `ts` 인덱스 |
| 대량 export | GPU 시계열 등은 5만 행 청크 + `setImmediate` 양보로 조회(이벤트 루프 10초 정지 방지), 기본 상한 30만 행(`GPU_EXPORT_MAX_ROWS`) |
| 수집 | vCenter 병렬+동시성 제한, 모든 폴러 재진입 가드, 수집서버 풀러 배치 적재, 위임 잡 활동 기준 GC. 위임 잡(iDRAC 스캔·캡처·Ping)은 **2단계 확인응답(claim→ack)** — 엣지 재시작으로 인출된 잡이 유실되면 기한 후 자동 재수확(v2.290). 엣지 인벤토리 push 가 512KB+ 무압축으로 3회 연속이면 경고 이벤트(v2.344) |
| 추이 트래킹 | VM 수량·DS 사용량은 **diff 만 저장**(변경 VM 행·1GB+ 변화 DS 행) — 전량 로스터 적재 대비 행수 1/100 이하. DS별 시계열은 UNIQUE(slot, ds_id) upsert + `ts` 단독 인덱스(prune 풀스캔 방지), 조회는 마지막 관측값 step 펼침(v2.345~2.355) |

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

### 성능점검(svcmon)
| 변수 | 기본값 | 설명 |
|---|---|---|
| `SVCMON_ENABLED` | `true` | `false`면 폴러 미기동(전체 킬스위치) |
| `SVCMON_ROLE` | `both` | `central`=점검 실행 안 함(정의 배포·결과 수신만) · `edge`=실행+중앙 보고 · `both`=단독(기존 동작) |
| `SVCMON_WORKERS` / `SVCMON_CONCURRENCY` / `SVCMON_PROC_CONCURRENCY` | `min(4,cpu-1)` / `256` / `64` | 워커 수 · 소켓형/프로세스형(ping·trace) 동시 실행 |
| `SVCMON_TICK_MS` / `SVCMON_MAX_PER_TICK` | `5000` / `4000` | 폴러 틱 간격 · 틱당 실행 상한(만기 폭주 방지) |
| `SVCMON_PUSH_INTERVAL_MS` / `SVCMON_PUSH_CHUNK` | `60000` / `2000` | (엣지) 결과 push 주기 · 청크당 행 수(413 시 자동 절반) |
| `SVCMON_CONFIG_PULL_MS` | `300000` | (엣지) 정의 pull 주기 |
| `SVCMON_EDGE_SILENCE_MIN_MS` / `SVCMON_EDGE_MAX_AGENTS` / `SVCMON_EDGE_MAX_ROWS` | `300000` / `64` / `20000` | (중앙) 무보고 판정 하한 · 수신 엣지/행 상한 |

상한(저장소): 대상 20,000 · 대상당 점검 200 · 전체 점검 200,000 · 폴더 5,000 · 트리 깊이 10.
1회 요청(라우트): 대량 등록/CSV 2,000행. 자세한 설계·용량 산정은 [docs/SVCMON-ARCHITECTURE.md](docs/SVCMON-ARCHITECTURE.md), 유형 상세 [docs/SVCMON-TESTS.md](docs/SVCMON-TESTS.md), 대량/CSV [docs/SVCMON-BULK.md](docs/SVCMON-BULK.md).

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
`gpu`(+`/history`,`/vms`), `esxi-temp`(+`/history`), `capacity`, `capacity-forecast`, `waste`, `thin-vms`, `guest-os`, `hba`, `licenses`, **`license-expiry`**(vCenter+NSX+Horizon 만료일), `esxi`, `solutions`, `hardware`, `vmtools`, `snapshots`, `duplicate-ips`, `vm-finder`(POST), `ipam`(+`/subnets`,`/sheet`,`/annotation`,`.xlsx`,`.csv`), `deep-search`(POST), `ip-ping`, `service-check`, `network-check`, `vmware-config`, `vclogs`(+`/export.csv`,`/federate`,`/sources`), **`storage`**(+`/devices`,`/devices/import`,`/collect-all`,`/activity` — 스토리지 어레이 모니터링), **`vm-clone`**(+`/jobs`,`/jobs/:id/run`,`/badges` — 백업식 복제), **`vm-track`**(+`/changes`,`/ds-changes`,`/ds-list`,`/ds-series`,`/ds-series-all`,`/ds-top`,`/ds-change-log`,`/ds-pivot`,`/snapshot` — VM 수량·데이터스토어 사용량 추이, v2.345~2.356), **`bm-storage`**(+`/servers`,`/settings`,`/collect`,`/import`,`/export.csv` — 베어메탈 스토리지, 관리자)

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
| `aisearch` | AI 자연어 검색 | `ipam` | IP 관리대장(+IP 능동 스캔) — **상단 'IP관리' 탭으로 승격**(v2.274) |
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
| `daily-health` | **일일 헬스체크 리포트**(vCheck 스타일 + 자동 발송, v2.217) | `snapshot-age` | **스냅샷 나이 감시**(생성일 기준, v2.217) |
| `zombie-vms` | **좀비/방치 리소스**(고아 VM·회수 용량, v2.217) | `cert-expiry` | **인증서 만료 감시**(vCenter·NSX TLS, v2.217) |
| `rightsizing` | **VM 라이트사이징**(관측 통계 기반, v2.217) | `capacity-forecast` | **용량 고갈 예측**(선형회귀 ETA, v2.217) |
| `alert-channels` | **알림 채널·이력**(Slack/Teams/웹훅, v2.217) | `compliance-report` | **버전/패치 준수**(Tools·HW·ESXi EOL, v2.217) |
| `change-history` | **구성 변경 이력**(이벤트 타임라인, v2.217) | `unprotected-vms` | **미보호 VM**(백업 공백 탐지, v2.217) |
| `service-hub` | 서비스 허브(별도 포탈, 새 탭 — `SERVICE_HUB_URL` 설정 시 표시) | `explore` | **탐색·랭킹**(Top N·상세 스펙 검색 — 상단 탭에서 이동, v2.274) |
| `storage-mon` | **스토리지 모니터링**(PowerScale·PowerStore·Unity·XtremIO·VMAX/PowerMax·VPLEX 8종, v2.302+) | `vm-clone` | **VM 복제(백업식)** — 스케줄·데이터스토어/NFS·보존 N개(v2.299) |
| `vm-export` | **VM 전체 정보 CSV**(85+ 컬럼·디스크 1~7 슬롯별, v2.275·2.278) | `secret-scan` | **평문 자격증명 점검**(설정·env·로그·소스, 값 마스킹, v2.297) |
| `codex-check` | **보안점검 리포트**(외부 전수 점검 + 실시간 지표, 관리자, v2.284) | `capacity-advisor` | **리소스 적정성 진단**(포탈 중앙/엣지 서버 자체 실측, v2.254+) |
| `bm-storage` | **베어메탈 스토리지**(SSH df 합산·그룹 3개·엣지 위임·CSV, v2.340) | `vm-track` | **VM 수량 추이**(00/12시 스냅샷·증감 클릭 상세·전원 전환, v2.345+) |
| `storage-track` | **스토리지 사용량 추이**(합계+DS별 시계열·변경 이력·소진 예상, v2.348+) | `svcmon-config` | 성능점검 설정(템플릿·대량등록·가져오기/내보내기·엣지 배정·로그) |
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
- **IP 능동 스캔(TCP 커넥트 + ICMP ping)**: vCenter가 모르는 물리/타가상화/네트워크 장비 IP를 공통 포트(22/80/443/445/3389/623/8006/902/5985…)로 탐지하고, 포트가 전부 닫힌 서버는 ICMP ping 으로 생존 감지(v2.359 — 설정에서 끌 수 있음). **스캔은 별도 프로세스(child_process)에서 격리 실행**(v2.363)해 TCP/ping/역DNS 부하·FD 를 포탈에서 떼어낸다(중앙·엣지 공통, 데드라인 초과 시 자식만 강제종료·포탈 무영향, 워커 실패 시 인라인 폴백). ping 은 **fping 이 있으면 배치(한 프로세스로 다수 IP)**, 없으면 동시성 상한(기본 8) per-IP 폴백 → 서버종류 "스캔"으로 대장에 채움. **설정 › IP 스캔**에서 할당 에이전트 선택·대역/포트/주기 설정, 에이전트별 보고 현황 표시.
  - 에이전트 측: `AGENT_NAME=<이름>`, `CENTRAL_URL=<중앙주소>`, `CENTRAL_TOKEN=<동일토큰>` / 중앙 측: `CENTRAL_TOKEN` 설정 필수.
  - ⚠️ 포트 스캔은 침투성 — **승인된 대역만**, 레이트리밋, 보안팀 공지 후 사용.

---

## 서비스 바로가기 허브 (별도 페이지 · Python)

운영에 쓰는 **여러 서비스 포탈(Grafana·NetBox·ServiceNow·Vault·백업 콘솔 …)을 한 화면에 모아 두는
바로가기 허브**입니다. 설정에서 **이름과 URL**만 입력하면 대시보드에 바로가기 카드가 즉시 생성됩니다.

> 이 포탈(Node/React)과는 **완전히 분리된 별도 페이지·별도 프로세스**입니다. 포트만 다르게 띄우면 되고
> 인증·데이터가 서로 얽히지 않습니다.
> 📘 **상세 문서: [docs/SERVICE-HUB.md — 서비스 허브 운영 가이드](docs/SERVICE-HUB.md)**
> (화면·설정·점검/알림·보안·운영 전체). 기술 문서(환경변수·REST API·테스트)는 [`pyportal/README.md`](pyportal/README.md).

```bash
cd pyportal && python3 app.py        # http://<서버>:8095  (pip 설치 불필요, Python 3.9+ 표준 라이브러리만)
```

핵심 요약 — **클로드 다크 디자인 + 다중 키워드 검색 + 즉석 카테고리 생성**(v2.218) · 사용자명+비밀번호
로그인과 카테고리 직접 구성·CSV 가져오기/내보내기·포트 응답 기반 가동 판정(v2.216) · 상태 전환 웹훅
알림·감사 로그·재시작에도 유지되는 세션(v2.215) · 6차 보안 감사 반영(v2.214). 포탈에 `SERVICE_HUB_URL`을
주면 특수 기능에 '서비스 허브' 카드가, 허브에 `HUB_PORTAL_URL`을 주면 헤더에 [모니터링 포탈 ↗]이
나타납니다. 오프라인 설치 패키지에도 `pyportal/`이 함께 포함됩니다.

---

## UAG 모니터 (별도 배포물 · `uagmon/`)

Horizon **UAG(Unified Access Gateway)** 어플라이언스의 상태·세션을 모아 보는 경량 모니터입니다.
포탈과 별개로 배포·실행되며 **Node 내장 모듈만** 사용합니다(외부 의존성 0). 하나의 코드로
**서버(웹) · Windows 앱 · macOS 앱(Electron 자체 창)** 세 가지 배포를 지원하고, 데스크톱 앱
데이터는 OS 사용자 폴더에 저장되어 앱 교체 후에도 유지됩니다. 상세: [`uagmon/README.md`](uagmon/README.md).

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
- **⚠ 포탈 백업 = 자격증명 사본 (v2.210.0)** — 백업 아카이브에는 `portal.env`(**AUTH_SECRET**·`CENTRAL_TOKEN`)·`users.json`(**TOTP 시크릿**·비번 해시)·`vcenters.json` 사본이 들어갑니다. 그래서 `/api/admin/backup/*`(상태·설정·즉시 백업·다운로드·조회·삭제·복원) **전부와 세션 보안 설정 조회**는 admin이 아니라 **설정 소유자(settingsOwners)만** 호출할 수 있고, 다운로드·복원은 **감사 로그**에 남습니다. 내려받은 파일은 자격증명과 동급으로 보관·폐기하세요(AUTH_SECRET 유출 = 임의 계정 토큰 위조 = OTP 정책·소유자 경계 동시 무력화).
- **사용자별 데이터 범위(scope)** — 계정에 허용 vCenter/리전을 지정하면 인벤토리 목록과 vCenter 필터가 서버에서 그 범위로 제한됩니다(외주·감사·데모 계정에 유용). **목록뿐 아니라 id를 직접 받는 단건 라우트**(VM 콘솔 티켓·호스트/VM 지표)도 범위를 검사하며, 범위 밖은 403이 아니라 **404**로 응답해 존재 여부도 흘리지 않습니다(v2.207.0). 전역 KPI 합계 등 일부 집계 화면은 후속 확대 예정.
- **엣지 토큰 스코프** — 공유 `CENTRAL_TOKEN` 하나를 전 엣지가 쓰면 엣지 1대 침해로 다른 사이트 자격증명까지 노출됩니다. **설정 → 수집 서버 → 🔑 엣지별 개별 central 토큰**에서 사이트별 토큰을 발급해 이관하세요(무중단, 미이관 엣지는 화면에 표시). 이관 후 `CENTRAL_REQUIRE_AGENT_TOKEN=true`.
- **버전 파일** — 기동 시 `CONFIG_DIR/vmware-portal-release`에 실행 버전·역할(central/edge/…)을 기록합니다(`/etc/redhat-release` 방식) — 배포 점검·자산 조사용.
- 시계열(온도/GPU/용량)을 분 단위·장기 보존하면 데이터가 커집니다 — **설정 › 지표 수집**에서 주기/보존기간을 조절하세요.
- 모니터링은 **읽기 전용 vCenter 계정** 권장. VM 생성/Tools 업그레이드/원격접속 등 쓰기·운영 기능은 권한 있는 계정과 승인 절차로 사용하세요.
