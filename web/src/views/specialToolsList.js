// 특수 기능(SpecialTools) 도구 정의 — 화면 렌더와 권한 매트릭스 편집이 공유하는 단일 소스.
// k(권한 키의 대상)·label·icon·desc + 플래그(adminOnly/disabled/comingSoon/danger/external).
// aka(선택): **구 명칭·별칭 배열**(v2.508). 이름을 바꾸면 옛 이름으로 검색이 안 되는데(실제 사례:
//   v2.507 '낭비 리소스' → '자원 최적화'), desc 에 옛 이름을 억지로 남기는 대신 여기에 적는다.
//   toolSearch.js 가 k·label·desc·aka·분류명을 함께 본다. **k 는 어떤 경우에도 바꾸지 않는다.**
// external: 이 포탈의 화면이 아니라 다른 포탈을 새 탭으로 여는 항목. 주소는 서버가
// 인증 후에만 내려주므로(`/auth/me` serviceHubUrl), 미설정이면 카드 자체가 나오지 않는다.
export const TOOLS = [
  { k: 'service-hub', icon: '🧰', label: '서비스 허브 (별도 포탈)', desc: '운영 서비스 바로가기 모음 · 링크 상태 점검/추이 · 데이터센터 구성 (새 탭)', external: 'serviceHubUrl' },
  { k: 'aisearch', icon: '🔎', label: 'AI 검색 (자연어)', desc: '자연어로 VM/호스트/IP 검색 · 로컬 LLM' },
  { k: 'insights', icon: '🧠', label: '운영 인사이트', desc: 'VM 라이트사이징 · 클러스터 N+1 여력 · 알람 핫스팟 · GPU 유휴' },
  { k: 'explore', icon: '🏆', label: '탐색·랭킹', desc: '자원 최다 사용 Top 랭킹(CPU·메모리·디스크·전력) + 상세 스펙 VM 검색 — 리전/vCenter 범위 선택', perm: 'dashboard' },
  { k: 'threats', icon: '🛡️', label: '위협 탐지', desc: '마이닝 의심 · 위험 포트 노출 · EOL OS · 신규 rogue IP · NSX IDS' },
  { k: 'secret-scan', icon: '🔐', label: '평문 자격증명 점검', desc: '설정 파일·portal.env·로그·소스에 평문으로 남은 계정정보/토큰/키 탐지(값은 마스킹) · 암호화 저장 전환 안내', adminOnly: true },
  { k: 'codex-check', icon: '🛡️', label: '보안점검', desc: '프로그램 보안·완성도 점검 리포트 — 외부 전수 점검 결과 + 실시간 지표 · Markdown 저장/다운로드', adminOnly: true },
  { k: 'vm-clone', icon: '🧬', label: 'VM 복제(백업)', desc: 'vCenter별 VM 지정 → 스냅샷 시점 복제(무중단) · 스케줄 정기 실행 · 대상 데이터스토어/NFS 선택 · 최근 N개 보존 · 트리에 Clone 배지', adminOnly: true },
  { k: 'storage-mon', icon: '🗄️', label: '스토리지 모니터링', desc: '글로벌 법인 스토리지 8종(PowerScale/Isilon·PowerStore·Unity·XtremIO·VMAX/PowerMax·VPLEX/Metro Node) 사용량·버전·노드 통합 조회 · 용량 시계열/추이 · 엣지 현지 수집→중앙 집계 · 법인별/타입별 뷰', adminOnly: true },
  { k: 'serial-lookup', icon: '🔎', label: '시리얼 조회', desc: '등록·수집된 모든 장비의 시리얼을 한 번에 검색 — 서버(iDRAC) 섀시와 부품(PSU·디스크·메모리·NIC) · OME 장비 · ESXi 호스트 · 스토리지 어레이 · SAN 스위치(섀시·PSU·SFP) · 엣지 베어메탈 · 대소문자와 :·- 무시 부분 일치 · CSV 내보내기', adminOnly: true },
  { k: 'pdu', icon: '🔌', label: 'PDU 정보', desc: 'APC Rack PDU 2G(rpdu2g) — 전력(kW·누적 kWh·피상·역률) · 뱅크/상별 전류 · 온도·습도. 데이지체인 PDU 대수와 환경 센서 개수를 자동 탐지 · 엣지 현지 수집→중앙 집계 · 수집 주기 중앙 배포 · CSV 일괄 등록/수정 · 전용 시계열 DB', adminOnly: true },
  { k: 'san-switch', icon: '🔗', label: 'SAN 스위치 모니터링', desc: 'Brocade(Fabric OS) FC 스위치·디렉터 전 모델 — 포트별 상태·속도·연결 장비·에러 카운터·SFP 광레벨(Tx/Rx dBm) · 포트 용량(라이선스/사용중/여유, POD 미라이선스 제외) · SSH CLI 또는 REST(FOS 8.2.1+) · 엣지 현지 수집→중앙 집계 · 법인별 필터', adminOnly: true },
  { k: 'relaytopo', icon: '🗺️', label: '중계 토폴로지 (HAProxy 구성)', desc: 'Main – Edge DVC – IRS 구조를 표로 입력(스프레드시트 붙여넣기 · CSV/JSON 가져오기·내보내기 · 노드별 SSH ID/비밀번호/키) → 필요한 서비스(IRS 포탈 4068 · IRS SSH 4067 · IRS vCenter 4066 · Edge vCenter 4065 · HQ 4001 …)를 중계 엣지 HAProxy 관리 블록으로 생성·검증(haproxy -c)·적용(백업·reload·롤백) · 입력 표 자체 오류 점검(중복 IP·self-loop·수집 서버 누락) · 각 노드에 SSH 로 실제 haproxy.cfg/서비스/리스너/portal.env 를 가져와 표로 대조하고 오류·해결책 제시 · 2D/3D 토폴로지 그래픽', adminOnly: true },
  { k: 'relaycheck', icon: '🛣️', label: 'HAProxy 경로 점검', desc: '중앙 → 중계 엣지(Edge DVC) HAProxy 포워딩 포트(4000 자기 포탈 · 4065 자기 vCenter · 4066 IRS vCenter · 4067 IRS SSH · 4068 IRS 포탈 · 4001 HQ 포탈)를 주기 점검 — TCP → 프로토콜(SSH 배너/TLS·HTTP/포탈 ping) → 정체 대조(IRS 포트가 중계 엣지 자신으로 되돌아오는지, HQ 포트가 이 중앙에 닿는지). 연속 실패 시 알림 채널 발화·복구 알림, 실패 행에 원인 후보·조치 순서·haproxy.cfg 예시 제시. 호스트는 수집 서버 URL 에서 자동, 포트 프로파일·수동 호스트 편집 가능.', adminOnly: true },
  { k: 'credentials', icon: '🔑', label: '통합 계정 관리', desc: 'RMA 가 엣지 망 안의 서버에 SSH 로 점검·명령을 실행할 때 쓰는 계정을 한 곳에서 관리 — ID/비밀번호 또는 SSH 개인키(+패스프레이즈) 선택 · 봉인 저장(secretVault) · 비밀 값 무반환(지문만) · 법인/대상 호스트 사용 범위 · 변경 시 OTP 재인증 · 사용 감사 · 브로커 1회 전달(엣지 메모리에서만 사용)', adminOnly: true },
  { k: 'rma', icon: '🖥️', label: '원격 명령 실행 (RMA)', desc: '엣지 서버의 별도 프로세스(vmware-portal-rma@인스턴스)가 중앙을 롱폴해 프리셋 명령(서비스 상태/로그/재시작·df·free·ping·traceroute·포트 확인 등)을 실행하고 결과 회신 · 법인당 다중 인스턴스(한 서버 여러 프로세스/여러 서버) · 분배 방식 Active-Active/부하 분산/Active-Backup 선택 · 법인별 서명 비밀번호 · SSH 원격 배포 · 감사로그', adminOnly: true },
  { k: 'bm-storage', icon: '💽', label: '베어메탈 스토리지', desc: '서버 SSH(df)로 로컬 디스크 마운트 포인트 용량 수집 · 서버/그룹/전체 합산(총·사용·가용) · 사용자 지정 주기 · 엣지 위임(중앙→엣지 PUSH)', adminOnly: true },
  { k: 'vm-track', icon: '📈', label: 'VM 수량 추이', desc: 'vCenter별 매일 00시·12시 VM 수 스냅샷(전용 DB) · 전체·단위 vCenter 추이 차트 · 증감 클릭 시 생성·삭제 VM 과 클러스터·호스트·데이터스토어 확인' },
  { k: 'storage-track', icon: '💾', label: '스토리지 사용량 추이', desc: 'vCenter 데이터스토어 용량·사용량·사용률 매일 00시·12시 추이(VM 수량 추이와 같은 스냅샷) · vCenter별 현재/증감 표 · 데이터스토어별 개별 추이(선택 차트 + 기간 증감 상위) · 일평균 증가량과 가용 소진 예상(선형 추정) · 증감 클릭 시 변화 데이터스토어 상세' },
  { k: 'vmfinder', icon: '🧭', label: 'VM 정밀 검색 / 유휴 VM', desc: '다수 vCenter·폴더·클러스터·풀 + 조건 · 1일/1주 평균 CPU로 미사용 VM' },
  { k: 'deepsearch', icon: '🔭', label: '심층 검색', desc: '게이트웨이·서브넷·GPU·OS 등 다조건 + 게스트 탐침(GPU드라이버·프로세스) · 전체/복수 vCenter' },
  { k: 'capacity', icon: '📈', label: '용량 리포트', desc: '클러스터별 여유·오버커밋·수용여력 · 디스크 트렌드(할당·사용·회수 가능) · 전체/법인별' },
  // 이름 변경 이력(사용자 요청): v2.507 '낭비 리소스' → '자원 최적화 (CPU/Memory/Disk)',
  //   v2.508 → 'Optimization'. 키 `waste` 는 세 번 모두 유지했다 — 권한 매트릭스의 toolsDenied 값·
  //   딥링크 `#/tools/waste`·서버 매핑(auth/toolAccess.js)이 이 문자열이라, 바꾸면 각 법인이 저장해 둔
  //   거부 설정과 사용자 북마크가 조용히 깨진다.
  //   옛 이름은 전부 `aka` 에 남긴다 — 그래야 예전 이름으로 찾던 사용자가 기능을 잃지 않는다.
  { k: 'waste', icon: '♻️', label: 'Optimization', aka: ['자원 최적화', '자원 최적화 (CPU/Memory/Disk)', '낭비 리소스', '낭비 자원', '최적화'], desc: 'CPU·메모리 과할당(할당 vs 실사용 추이 · 감축 근거 리포트) · 전원 꺼진 VM · 스냅샷 · thin 회수가능 · Tools 미실행 — 낭비 자원 회수' },
  { k: 'esxitemp', icon: '🌡️', label: '서버 온도', desc: 'iDRAC/ESXi 수집 온도 — 물리·가상화 구분, 법인별 평균, 5년 추이' },
  { k: 'forecast', icon: '🔮', label: '용량 추세/예측', desc: '데이터스토어 증가율·가득 찰 예상일' },
  { k: 'dsusage', icon: '💽', label: 'vCenter별 스토리지', desc: 'DataCenter/vCenter별 데이터스토어 연결 현황 · 가용/전체 용량' },
  { k: 'guestos', icon: '🐧', label: 'Guest OS 종류/버전', desc: 'OS·버전별 VM 수 · 전체/법인별 · 검색' },
  // v2.520 — 게스트 계정 없이(사용자 결정 "Guestos 계정 없이") 게스트가 스스로 발행한
  // `guestinfo.curuser.*` 를 vCenter 구성에서 읽는다. `aka` 는 옛/다른 이름으로도 찾게 한다.
  { k: 'curuser', icon: '👥', label: '현재 사용자', desc: '지정 폴더의 Windows 서버에 로그인한 사용자 수 · 전체/법인(vCenter)별 · 같은 계정이 여러 서버에 있으면 1명 · 활성/연결끊김 구분 · 10분 주기 DB 저장·추이 · 게스트 계정 불필요(VMware Tools 발행값 읽기)', aka: ['로그인 사용자', '접속자', 'quser', 'rdp 사용자', 'current users'] },
  { k: 'real-os', icon: '🔎', label: '실제 OS 확인(게스트)', desc: '게스트 OS에서 실제 설치 OS(/etc/os-release 등) 읽기 · ESXi 보고와 불일치 탐지 · 주기 스캔 · CSV' },
  { k: 'thinvms', icon: '💧', label: 'Thin VM 찾기', desc: 'Thin 프로비저닝 VM · 회수 가능 용량(추정)' },
  { k: 'orphanvmdk', icon: '🧩', label: '고아 VMDK 찾기', desc: '데이터스토어에 있지만 어떤 VM 에도 연결되지 않은 가상디스크 · VM 소유 파일(layoutEx)과 대조 · FCD·콘텐츠 라이브러리·복제는 제외 · 확인 필요 후보만 제시(삭제 기능 없음)' },
  { k: 'guest-disk', icon: '🧹', label: '게스트 디스크 회수', desc: 'VM 게스트(VMware Tools) 파티션의 할당 대비 사용·비율 · 파티션별 사용량 증가 추이(전용 DB) · 줄일 수 있는 여유가 큰 VM 정렬 · 회수 판정(증가 중이면 보류) · CSV export' },
  { k: 'vm-export', icon: '📤', label: 'VM 전체 정보 CSV', desc: '선택 vCenter 모든 VM 의 최대 상세(호스트·클러스터/CPU·코어/메모리/NIC·MAC·IP/디스크 1~7 슬롯별 용량·타입·데이터스토어·파일/게스트 파티션 사용량/스냅샷/Tools/UUID 등 85+ 컬럼)를 CSV 로 내보내기' },
  // ipam 은 상단 'IP관리' 탭으로 승격(v2.274, 화면은 SpecialTools.jsx IpamStandalone). topTab:
  // 특수 기능 카드 그리드에는 안 보이지만 항목은 유지 — 권한 매트릭스(사용자 관리 › 도구별 접근)의
  // toolsDenied 'ipam' 키 편집 UI 가 이 목록에서 나오고, 그 값이 상단 탭 노출(App.jsx toolKey)을 결정한다.
  { k: 'ipam', icon: '📒', label: 'IP관리 (상단 메뉴)', desc: '상단 IP관리 탭으로 이동 — 여기서의 접근 차단이 상단 탭 노출에 그대로 적용됩니다.', topTab: true },
  { k: 'dupip', icon: '🔁', label: '중복 IP 찾기', desc: '둘 이상 VM이 같은 IPv4를 쓰는 경우' },
  { k: 'vmtools', icon: '🧩', label: 'VMware Tools 버전', desc: '버전별 집계 + 업그레이드' },
  { k: 'snapshots', icon: '📸', label: '스냅샷 있는 VM', desc: 'vCenter/용량/개수별 정렬' },
  { k: 'daily-health', icon: '📋', label: '일일 헬스체크 리포트', desc: 'vCheck 스타일 아침 점검 — 스냅샷·용량·Tools·연결·인증서 요약 + 매일 지정 시각 웹훅 자동 발송' },
  { k: 'snapshot-age', icon: '⏳', label: '스냅샷 나이 감시', desc: '생성일 기준 오래된 스냅샷 탐지 · 나이/크기 필터 · CSV' },
  { k: 'zombie-vms', icon: '🧟', label: '좀비/방치 리소스', desc: '고아·접근불가 VM · 장기 정지 VM · 템플릿 · 스냅샷 대식가 — 회수 가능 용량(RVTools 스타일)' },
  { k: 'cert-expiry', icon: '📜', label: '인증서 만료 감시', desc: 'vCenter·NSX TLS 인증서 만료일 — D-90 경고 · D-30 위험 · 12시간 자동 프로브' },
  { k: 'rightsizing', icon: '📐', label: 'VM 라이트사이징', desc: '관측 평균/피크 기반 과대할당 VM 축소 추천 · 회수 가능 vCPU/RAM' },
  { k: 'capacity-forecast', icon: '📉', label: '용량 고갈 예측', desc: '데이터스토어 증가 추세 선형회귀 → 가득 찰 예상일(ETA) · 30일 임박 경고' },
  { k: 'alert-channels', icon: '📣', label: '알림 채널·이력', desc: 'Slack/Teams/웹훅 채널 상태 · 발화 중/최근 알림 이력 · 중복 억제 · 테스트 발송' },
  { k: 'compliance-report', icon: '📑', label: '버전/패치 준수', desc: 'VMware Tools 업그레이드 필요 · VM 하드웨어 버전 · ESXi 지원 종료(EOL) 분포' },
  { k: 'change-history', icon: '🕘', label: '구성 변경 이력', desc: '누가 언제 무엇을 바꿨나 — vCenter 이벤트 기반 변경 타임라인 · 분류/계정/대상 필터' },
  { k: 'unprotected-vms', icon: '🛟', label: '미보호 VM (백업 공백)', desc: '백업 소프트웨어의 스냅샷 이벤트가 관측되지 않은 가동 VM — 계정 패턴·기간 설정' },
  { k: 'solutions', icon: '🧱', label: 'VMware 솔루션 / NSX', desc: 'vCenter별 설치 버전' },
  { k: 'licenses', icon: '🔑', label: '라이선스 한눈에', desc: '제품별 할당/사용/만료' },
  { k: 'license-expiry', icon: '📅', label: '라이선스 만료일 확인', desc: 'ESXi·vCenter·vSAN·VCF/VVF·NSX·Horizon 등 수집 가능한 전 라이선스의 유효/만료 날짜 — 만료·90일 임박 강조, Horizon 연결 서버 등록, CSV' },
  { k: 'esxi', icon: '🖳', label: 'ESXi 버전별', desc: '호스트 ESXi 버전 분포/목록' },
  { k: 'vcversion', icon: '🏛️', label: 'vCenter 버전별', desc: 'vCenter 버전 분포' },
  { k: 'nsx', icon: '🛡️', label: 'NSX 관리', desc: '게이트웨이·세그먼트·노드·DFW 방화벽·보안그룹 등 NSX 전체 관리', perm: 'inv.nsx' },
  { k: 'hardware', icon: '🏷️', label: '벤더/모델 서머리', desc: '법인별 호스트 벤더·모델 수량' },
  { k: 'powermap', icon: '⚡', label: '전력 분석 (법인/모델별)', desc: '측정된 모든 서버 소비전력을 법인(vCenter)·모델·지역별로 분해 · 미매핑 포함 · CSV' },
  { k: 'hba', icon: '🔌', label: 'HBA 카드 속도', desc: '호스트 FC/iSCSI 어댑터 속도' },
  { k: 'gpu', icon: '🎮', label: 'GPU 인벤토리', desc: '호스트/모델별 GPU + 사용률 최근 5년 추이' },
  { k: 'serveranalysis', icon: '🔬', label: '서버 분석', desc: 'iDRAC 수집 하드웨어 분석 · GPU 찾기(모델별 장수)' },
  { k: 'fleet', icon: '🗂️', label: '통합 서버 인벤토리', desc: 'iDRAC 태그 + vCenter 조합 → 가상화 호스트 / 베어메탈 자동 분류 · 베어메탈 전력 합계 · 수동 예외 · CSV' },
  { k: 'nic-speed', icon: '🔌', label: '서버 NIC 속도 구분', desc: 'iDRAC 수집 서버의 물리 NIC 속도(10G/25G/100G…)별 분류 — DataCenter·가상화/베어메탈 필터 + CSV' },
  { k: 'nic-models', icon: '🧬', label: '서버 NIC 모델 확인', desc: 'iDRAC 수집 서버에 설치된 NIC 어댑터 종류·모델명(Intel/Broadcom/Mellanox…)별 분류 — DataCenter·가상화/베어메탈 필터 + CSV' },
  { k: 'topo3d', icon: '🌐', label: '구성도 (3D)', desc: '설정된 구성을 3D 네트워크로 — 줌인/아웃·회전·VM 펼치기' },
  { k: 'davinci-svc', icon: '🩺', label: '다빈치 서비스 점검', desc: '포탈 내부 서비스/수집기(vCenter·NSX·전력·지표·GPU·알림·백업·에이전트) 상태 한눈에' },
  { k: 'capacity-advisor', icon: '📊', label: '리소스 적정성 진단', desc: '포탈 서버(중앙+엣지)의 CPU·메모리·네트워크·디스크 상시 실측 — 1일/1주/1달 추이로 인프라 증설/감축 조언 (관리자)', adminOnly: true },
  // svcmon: /api/svcmon 전체가 svcmon 기능 권한 게이트(v2.506) 아래다 — perm 이 없으면 카드가 열리고
  //         화면 전체가 403 이 된다(상단 'Monitoring' 탭과 같은 경계를 여기서도 유지).
  { k: 'svcmon-config', icon: '⚙️', label: 'Monitoring 설정', desc: 'Monitoring 대상·점검 항목을 CSV 로 가져오기/내보내기 (샘플 제공) · 대량 자동등록 · 점검 템플릿', perm: 'svcmon' },
  { k: 'net-check', icon: '📡', label: '글로벌 네트워크 점검', desc: '전세계 vCenter·NSX 제어플레인 도달성·RTT + 네트워크 객체 요약' },
  { k: 'net-traffic', icon: '🔬', label: '네트워크 트래픽 분석', desc: '두 서버 간 tcpdump 캡처·분석(핸드셰이크·재전송·RST) + 로그 자체 장애 탐지' },
  { k: 'vmware-backup', icon: '🗃️', label: 'VMware 구성 백업', desc: '사이트의 수집 구성(호스트·VM·DS·네트워크·NSX) 스냅샷 내보내기' },
  { k: 'roomtemp', icon: '🌡️', label: '법인 전산실 운영 온도', desc: '모든 법인의 흡기(Inlet)·배기(Exhaust)·CPU 온도 범위를 카드로 한 페이지 종합 · ASHRAE 권장 대역(18~27℃) 대비 상태 · 배기−흡기 ΔT · 서버별 상세', adminOnly: true },
  { k: 'portaldb', icon: '🗄️', label: '포탈 DB', desc: '사용 중 모든 DB/데이터 파일의 경로·파일명·용도·크기·증가 추이' },
  { k: 'mail-diag', icon: '✉️', label: '메일 진단', desc: 'SMTP 서버 설정 + 테스트 발송 · 연결/STARTTLS/인증/수신자까지 단계별 대화 로그로 실패 지점 확인(비밀번호는 가려짐)', adminOnly: true },
  { k: 'dir-usage', icon: '📁', label: '폴더 사용량 Top-N', desc: '엣지에 마운트된 공유 폴더의 하위 폴더(=사용자)별 사용량 Top N · 직전 대비 증감 · 주기 수집 결과와 메일 발송 이력', adminOnly: true },
  { k: 'diskadd', icon: '🧩', label: '디스크 추가 자동화', desc: 'VM 디스크 추가 할당 자동화 (준비 중)', disabled: true, comingSoon: true },
  { k: 'backup', icon: '💾', label: '백업', desc: '설정 백업/복원 (준비 중)', disabled: true, comingSoon: true },
  { k: 'massdeploy', icon: '🚀', label: '대용량 배포', desc: '대량 배포 (준비 중)', disabled: true, comingSoon: true },
  { k: 'shutdown', icon: '🛑', label: '긴급중단', desc: '온도 상승·재난·PM 등 긴급 시 법인 전 장비 shutdown — 2인 이상 관리자 동의 필요', danger: true },
  { k: 'vmprovision', icon: '🆕', label: 'VM 생성', desc: '템플릿/사양 지정으로 신규 VM 생성 (관리자)', adminOnly: true },
  { k: 'agent-scans', icon: '🛰️', label: '에이전트 작업', desc: '에이전트별 IP 대역+iDRAC 계정 할당 → 각 에이전트가 로컬 스캔·자동등록·보고 (관리자)', adminOnly: true },
  { k: 'login-fails', icon: '🔐', label: '로그인 실패 분석', desc: 'vCenter/포탈 로그인 실패 이벤트 원인·추이 분석 (관리자)', adminOnly: true },
  { k: 'net-issues', icon: '🩺', label: '네트워크 이슈 분석', desc: '로그·캡처 기반 네트워크 장애 징후(재전송·RST·핸드셰이크) 분석 (관리자)', adminOnly: true },
];
