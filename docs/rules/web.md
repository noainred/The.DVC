# 규칙 — 웹 화면·메뉴·표·문구 규약

> 루트 `CLAUDE.md` 에서 옮긴 기록(2026-10-20, v2.746 시점). 문구는 원문 그대로이고 목록 들여쓰기만 한 단계 줄였다. "되돌리지 말 것" 규칙은 그대로 유효하다 — 이 영역 코드를 고치기 전에 이 파일을 읽을 것. 새 교훈은 테스트 → 이 파일 순으로 남기고 루트 CLAUDE.md 에는 쌓지 않는다.

**언제 읽나**: web/src/ 전반(메뉴·사이드바·표·문구·드롭다운·게시판)

## 목차

- (원래 895행) 상단 메뉴 2단화 — 탭 규칙은 `.topbar .tabs .tab` 으로 한정한다
- (원래 904행) 1600px 이상에서만 상단 메뉴를 브랜드행 한 줄에 합친다 — 임의 폭에서 합치면 메뉴가
- (원래 935행) v2.725 — 상단 메뉴는 대메뉴 10개 + 하위 메뉴 줄(시안 A '2단 탭')이고, 표는 `web/src/views/topMenu.js` 하나다
- (원래 948행) v2.726 — 메뉴는 좌측 사이드바이고, 계정별 메뉴(내 메뉴 > 배포 메뉴 > 포탈 기본)는 서버에 저장한다
- (원래 1192행) 역할별 ‘도구별 접근’ 표는 특수기능 카탈로그 전체를 쓴다 — 여기에 필터를 붙이지 말 것
- (원래 1227행) 사용자별 특수기능 권한 — '허용 목록' 은 거부 목록과 반대 방향의 성질을 가진다
- (원래 2688행) 리포트 표(`.rpt-wrap`)의 숫자칸·계열명칸은 단어 중간에서 쪼개지 않는다
- (원래 2820행) 웹 폴링 뷰 오류 처리
- (원래 3011행) `text-transform: uppercase` 를 앱 텍스트에 걸지 말 것 — 제품명·단위의 대소문자는 정보다
- (원래 3021행) 표의 상한(`limit`)과 최소폭(`minWidth`)은 `STable` 이 소유한다
- (원래 3044행) 값이 없으면 단위를 붙이지 않는다 — `web/src/views/unitText.js`
- (원래 3047행) 웹에도 `numOrNull` 이 있다
- (원래 3052행) Ping 추이의 '측정 없음' 을 한 문구로 덮지 말 것
- (원래 3106행) 화면 문구에 백틱 금지는 전수 스윕이 고정한다
- (원래 3119행) 그리드·플렉스 자식의 `min-width: 0` 은 한 폭만 재면 놓친다
- (원래 3453행) 로딩 표시의 '요청자' 는 서버가 기록한 로그인 계정이 먼저다
- (원래 4643행) Optimization(`#/tools/waste`) 화면은 시안 A 배치다 — 계산은 `views/tools/wasteViewText.js` 하나
- (v2.764 추가) ESXi 호스트(`#/hosts`) 화면은 시안 B '이상 우선' 배치다 — 판정은 `views/hostTriage.js` 하나
- (v2.805 추가) ESXi 호스트 화면의 '엑셀 수준 상세' — 열 묶음 9개·점검 열은 `views/hostChecksText.js` + 서버 `/hosts/checks` · 상세는 전체 페이지 `#/hosts/<id>`(모달 구성요소 공용)
- (v2.811 추가) ESXi 호스트 화면의 '법인별' 보기 — 숫자·판정은 서버 `/hosts/corp`(`vcenter/hostCorp.js`), 글자·색은 `views/hostCorpText.js`
- (v2.858 추가) Bareos 실행 중 작업 상세 — 진행 현황 행 펼침 · 실행 현황 · 이력 표가 `views/tools/BareosRunDetail.jsx` 하나를 쓴다 · 판정은 `bareosLiveText.js`
- (v2.860 추가) Bareos 화면 재구성(시안 `docs/design/bareos-ui-v2`) — 탭 5개 · 운영 안 묶음 · 정책 · 보존 한 화면 · 설정 왼쪽 목록 · 옛 주소 이동
- (v2.861 추가) Bareos 운영 › 복원 — 폴더 트리에서 고르기 · 3단계 · 묶음 진행 · 복원 뒤 네트워크 끊기 · 남은 스냅샷 칩
- (v2.862 추가) Bareos 복원 검증(리허설) 카드 · 일일 요약 메일 설정
- (v2.881 추가) 위키(상단 메뉴 '위키') — 마크다운 렌더러 안전 규약 · 충돌 저장 · 초안 · 링크 색 · 아래 고정 줄
- (v2.882 추가) 이슈 확장 — 에픽 › 이슈 › 하위 작업 · 스프린트 보드 · 검색식/저장 필터 · 일괄 편집(목록 열은 늘리지 않는다)
- (v2.883 추가) C-1 — 이슈 본문 마크다운(breaks) · 위키 체크리스트 체크(줄 번호 · 판 없이) · 이슈 찾기 · 이슈 연결 · 주간 메일 구독
- (v2.888 추가) C-2 · C-3 — 위키 즐겨찾기 · 최근 본 · 많이 본 · 슬래시 명령 · 이슈 CSV · 보드 끌기 · 보드에 필터 · 작업 기록 · SLA · 버전 · 쓰기 응답 범위
- (v2.889 추가) C-4 · C-5 — 첨부(인증 붙여 받기 · attach: 주소) · 포탈 매크로 · 포함 · 인라인 댓글 · 담당/당번 · 관리자 템플릿 · 캘린더 · 내보내기
- (v2.895 추가) vCenter 상세 탭 12개(시안 `docs/design/vcenter-tabs` ①~⑦) — 탭 목록 · 옛 키 · 하위 칸 · 묶음은 `views/vcd/vcdTabs.js` 하나 · 도구 데이터는 그 도구 권한일 때만 · 포탈 알람은 '포탈 규칙'
- (v2.895 추가) VM · ESXi 호스트 개체 보기(시안 ⑧~⑪) — 주소 `#/vcenters/<vc>/vm|host/<id>[/<탭>]` 는 `views/vcd/vcdRoute.js` 하나 · 트리 행 · 상세 창의 '⤢ 개체 보기' · 섹션은 EntityDetail 것을 재사용
- (v2.898 추가) vCenter 개체 보기 2차 — '수집하지 않음' 칸을 채웠다(알람 · 작업 · 권한 목록 · Linked Mode · 업데이트 · vLCM · 스냅샷 트리 · NIC) · 카드는 `vcd/VcInfoParts.jsx` 하나 · 권한 목록은 관리자 판본만 부른다
- (v2.901 추가) 개체 보기 3차(NIC 팀 · DS 마운트 · 리소스 풀) · useOnce 열쇠 · 관리자 전용 버튼은 `adminToolAllowed` · Bareos 그룹 기준 시계 선택
- (v2.906 추가) 호스트 네트워크 탭 '분산 포트그룹' 카드(vDS 팀 구성 · LACP · VLAN) · 팀 구성 문구는 `vcd/vcInfo.js` 한 벌 · Bareos 행마다 취소 회차 표시
- (v2.895 추가) 개체 보기 › 성능 튜닝(시안 ⑫⑬) — 판정은 기존 모듈(rightsize verdict · contention · vmcfg · hcfg · 가상화율 RATIO_LEVELS · 사용률 75/90 · DS 90/95)을 `vcd/tuning.js` 한 곳에서 모은다 · 새 서버 경로 없음 · 계획은 저장 없이 내보내기만
- (v2.920 추가) 베어메탈 사용률(`bm-usage`) USE 매트릭스 보드 · 서버 성능 상세 — 판정은 서버 `useJudge.js`, 문구·칸 표기는 `views/tools/bmPerfText.js` 하나 · 기존 사용률 표는 토글로 유지
- (v2.923 추가) 베어메탈 서버 상세 ‘추이’ 탭(평균 · 피크 두 패널 · 장치 토글 · 확대 팝업 · CVP 포트 절) — 창 · 해상도 · 결측 · 기준선은 서버 `trendWindow.js`, 문구 · 좌표는 `views/tools/bmTrendText.js` · 구간 이동은 공용 `vmPerfText.windowSpan`
- (v2.923 추가) 베어메탈 서버 상세 ‘장애 기록 · 튜닝 · 용도 · 진단 스냅샷’ 탭 · 함대 ‘용도 분석 · 장애 기록’ 보기 — 판정은 서버, 문구는 `views/tools/bmOpsText.js`(서버 code 1:1) · 근거 등급은 기호 + 낱말
- (v2.929 추가) 베어메탈 ‘집중 모니터링’ 탭 · 소모품 카드 · 보드 칩 · 추이 겹침(베이스라인 · 변경 · 집중 점) · 구간 비교 · 알림 규칙 절 — 판정은 서버, 문구 `bmPerfOpsText.js` · 폴링은 진행 중 집중 화면만(30초 · 상한)
- (6단계 추가) 리눅스 성능 6단계 화면 — 서버 비교 · 수집 건강 · ◆ 주석 핀 · 플레이북 · 목표선 · 공유 링크 · 캡처 PNG — 판정은 서버, 결측은 ‘—’ · 개수
- (7a단계 추가) 리눅스 성능 7a단계 화면 — 서버 상세 ‘로그’ 탭 · 함대 ‘로그 분석’ 보기 — 판정은 서버, 읽은 기록 없는 시간은 막대 없음(0 아님) · 숫자는 API 값
- (원래 5663행) v2.708 — 드롭다운은 공용 `Select`·`DataList` 하나다(자동 정렬)
- (원래 5801행) 특수 기능 화면(v2.679) — 표시 이름·설명·개발 단계는 '덮어쓰기' 이고 키는 그대로다
- (원래 5848행) 접속 공지 팝업 · 게시판(v2.722)
- (원래 5853행) 게시판 답글·공감(v2.723)
- (원래 5868행) 상단 메뉴에서 특수 기능으로 옮긴 화면은 옛 주소를 살린다

- (7b단계 추가) 리눅스 성능 7b단계 설정 › 서버 등록 패널 — 판정은 서버 값 그대로 · 키 관리 버튼은 settingsOwnerTier · 모르는 수 ‘—’ · 수집 건강 RTT 줄은 rttHigh 그대로
- (8a단계 추가) 리눅스 성능 8a단계 정비 창 패널 · 용량 예측 보기 — 일정 · 시간대 · 예측을 계산하지 않는다(서버 값 · 미리보기 API) · 버튼은 서버 can* · 못 읽음 ≠ 0일
- (8b단계 추가) 리눅스 성능 8b단계 화면 — 이 시점 프로세스 · 띠 · 저활용 · 전력/온도 — 서버 값만(점수 · 합 · 단서 재계산 없음) · 권한 · 미측정 ≠ 0 · 폴링 없음
- (v2.976) 집중 모니터링 화면 — 시간 띠 하나가 모든 차트를 옮김 · 숫자는 응답 limits · 비교 색은 고정한 서버에만(4색) · 대상 표는 1440px 에서 동작 열까지
- (v2.977) 업그레이드 뒤 화면 조각 404 는 자동 새로고침(60초에 한 번) · 열이 많은 표는 오른쪽 동작 열을 고정한다(sm-pin-right)
- (v2.997.0(코드 · 테스트 표지는 v2.994 — main 이 v2.996 까지 먼저 나가 번호만 올렸다)) 서버 메뉴 이름 변경 — Virtual Machine(VM)(vms · vcenters) · Hypervisor(hosts · 새 항목) · Physical Server · Bare Metal Server · 저장 메뉴 별칭은 tab:vcenters → tab:vms · 마지막 본 탭 기억 삭제 · 허브 제목 = 메뉴 라벨

## 본문

- ⚠⚠ **리눅스 성능 6단계 화면 — ‘서버 비교’ · ‘수집 건강’ 보기 · 상세 ‘진단 플레이북’ · ‘목표선’ 탭 · 추이 ◆ 주석 핀 · 목표 위반 띠 · 공유 링크 · 캡처 PNG(그리기만 — 판정 · 대조는 서버)**
  화면 `views/tools/{BmCompareView,BmCollectHealth,BmAnnotations,BmRunbookTabs,BmShareButtons}.jsx` · 문구 · 좌표 `bm{Compare,Collect,Annot,Runbook}Text.js` · 공유 `bmShare.js` · 캡처 `bmCapture.js` · 스타일 `bmStage6.css` ·
  회귀 `bmStage6Text.test.jsx`(서버 열거와 1:1 · SSR · 소스 스윕 · 35건). Chromium 1440/400 판독(r1~r5 — 가로 넘침 0):
  - **판정을 웹에서 하지 않는다**: 편차 ×2 · 스큐 · 축 상한 · 칸 code(비교) · 기준 대조 칸 · 노드 상태(수집 건강) · 달성 · 미달 · 자료 없음 · 위반 띠(목표선) · 맞는 플레이북 · 자리표시 값은 전부 서버 응답 그대로 — 웹은 code → 문장 · 숫자 → 글자.
    소스 스윕이 `cyclePct >=` · `successPct <` 같은 기준 비교와 setInterval · usePolling 을 막는다(전부 마운트 1회 + 버튼).
  - **결측은 ‘—’ · 개수로**: 비교 스파크는 값 없는 칸을 잇지 않는다(홀로 남은 점은 점으로 — r1 결함 고침) · 목표 일 추이 막대는 값 없는 날 ‘·’ · 수집 건강 KPI 합은 모르는 법인 · 노드를 빼고 ‘n곳 모름(합에서 뺌)’ · DB 크기를 못 읽으면 ‘0’ 이 아니라 사유.
  - **비교 고르기**: 보드 행 체크 → 아래 트레이(2~최대 · 상한은 API `maxServers`) · Top N 비교 · 함대 그룹 비교 · 상세 ‘비교에 추가’ — 고른 키는 `localStorage bmUsage.compare`(try/catch). 보기 3(나란히 · 겹쳐서 · 표) · 지표 묶음 4 · CSV(canCsv).
    ‘법인 간 허용’ 토글은 전체 범위 계정에만 보인다(서버도 404) · 다른 법인 열은 ‘다른 법인 — 값을 당기지 않음’ · 없는 서버는 ‘없음’(범위 밖과 구분하지 않는다).
  - **◆ 주석 핀**: 추이 차트 위 HTML 덧층(`.bmt-pinwrap/.bmt-pin` — SVG 밖이라 400px 에서도 눌린다) · 같은 핀이 비교 · 집중 이벤트 목록에도. 주석 추가 폼은 운영자 이상 · 고치기 · 지우기 버튼은 서버 `canEdit` 그대로.
  - **목표 위반 띠는 선택(opt-in) 체크** — 추이 탭이 목표선 API 를 매번 부르지 않게(지표마다 계열을 읽는다).
  - **공유 링크**: `#/tools/bm-usage/share?view=detail&key=&tab=&range=&to=&cur=&sel=…` · `view=compare&keys=&cross=&range=&cv=&grp=&val=&m=` — 값은 전부 열거 · 형식 화이트리스트(밖이면 버린다) · 도구 키(`bm-usage`)는 바꾸지 않는다 · 링크는 보기 상태만(권한 없음 — 버튼 title 이 말한다) · 서버가 없으면 ‘공유 링크의 서버를 찾지 못했습니다’.
  - **반증 review-s6 반영(화면)**: 수집 건강 — 상태 ‘주기 실패’(빨강) · ‘노드 값 숨김(법인 행 기준)’ 과 노드별 실패 문구(`NODE_ERROR_TEXT` — 서버 열거 1:1) · 행의 기준 밖 칸은 서버가 준 행 `flags` ·
    저장 카드 가족 값은 `famLine`(못 읽음 ‘—’ · 부분 ‘부분’ — `?? 0` 금지). 비교 — 피크 칸은 피크 표본만(‘—’) · 평균+피크에서 서버가 평균으로 대 봤으면 행에 ‘평균으로 비교’(`rowBasisNote`).
    목표선 — 피크 열 없는 지표는 기준 목록에서 ‘피크’ 를 뺀다(`basesFor` · 서버 `peakMetrics`) · 피크 표본 없는 주기 수 표시. 운영 주석 고치기 — **바뀐 칸만** 보낸다(`annotEditPatch` — 원래 시각의 초 ·
    집중 세션 · 백업 연결 보존 · 지운 칸은 null). 플레이북 문구 — ‘검토된 읽기 전용 목록에 글자 그대로 있는 줄뿐’(보증 수준대로).
  - **캡처 PNG**: 리포트 저장의 캡처 코어(`reportExport.captureElementCanvas` — html2canvas 1.4.1 · MIT · **새 의존성 없음**)를 재사용 · SVG 칠을 인라인으로 옮겨 그린다 · 각주(서버 · 법인 · 기간 · 커서 · 출처 · 생성자 · 시각) ·
    버튼 · 결과 문구는 `data-export-hide` 로 그림에서 뺀다(r2 판독 결함 — ‘캡처하는 중…’ 이 찍혔다).
- ⚠⚠ **리눅스 성능 7a단계 화면 — 서버 상세 ‘로그’ 탭 · 함대 ‘로그 분석’ 보기(그리기만 — 분류 · 집중 · 공통 원인 후보는 서버)**
  (`web/src/views/tools/{BmLogsTab,BmLogsFleet}.jsx` · 문구 `bmLogsText.js` · `bmLogs.css` · 탭 열 `DETAIL_TABS` 에 `logs` · 보기 `VIEWS` 에 `logs` · 규칙 패널 `logs` 절. 회귀 `bmLogsText.test.jsx`):
  - 상세: 기간(1시간 · 24시간 · 7일) · 다시 읽기 · CSV(수식 주입 차단) → KPI 4(분류별 패턴 · 줄) + 읽은 양(상한 · 잘림 · 분류 안 됨 · 마지막 읽음) → 출처 상태 칩(권한 없음 · 없음 · 로테이트 · 재부팅 …) →
    **필요한 권한 안내**(못 읽은 출처만 — 수집 계정 uid · 소속 · journald 그룹 · secure · audit 폴더 · 포탈은 권한을 바꾸지 않음 · 배포판 기본값은 ‘실장비 미확인’ 으로 밝힘) →
    시간대별 누적 막대(**읽은 기록이 없는 시간은 막대 없이 점선 — 0 아님**) → 보안 패널(합계는 서버 — **그 종류를 담는 출처를 못 읽었으면 ‘—’ + 이유**(담는 출처 · 상태 · 권한 범위 · 다른 출처의 부분 합) · 7a 반증 F1) →
    패턴 표(STable 8열 · 1440 에서 열 숨김 없음 — Chromium 판독으로 1100 → 960 줄임) →
    규칙 카탈로그(등급 문구는 로그 뜻 ‘○ 실장비 표본 없음’ — 튜닝 근거 등급 문구를 빌리지 않는다) → 수집 방식(숫자는 API `method` — **주기도 `method.intervalMs`**: ‘5분 주기’ 를 박았던 결함 · 반증 F12).
  - **분류 칸의 읽기 범위**(추가 수정): 서버가 그 분류를 담는 출처를 못 읽었으면 값을 null 로 보낸다 — 상세 KPI · 함대 표 칸은 ‘—’ + 이유(못 읽은 출처 — 칸 title) · 일부 출처만이면 값 + ‘일부’ ·
    함대 KPI 덧말은 ‘모름 n대 · 일부 출처만 n대’(`kpi.unknown` · `kpi.partial`). 웹은 다시 판정하지 않는다(`coverNote` · `fleetClsCell` 은 글자만).
  - 출처 칩 덧말은 서버가 센 값만: 권한 범위(자기 저널만 · 상위 폴더 · 파일) · 시한 부분 · 끝 줄 미완성 · 첫 읽기(dmesg 는 그 앞 n줄 안 셈) · 시각 모름 · 서버 시계 빠름 · 같은 기록(dup) · rsyslog/auditd 상태.
  - 연계 칩은 그 탭으로(변경 → 추이 · 집중 → 집중 · 교차 · 소모품 → 요약 · 장애 → 장애 기록 · 플레이북) — 머리에 ‘±N분 시각 매칭 · 인과 아님’(N 은 API `corrWindowMs`).
  - 조회기는 한 번 만들어진다(`useOpsLoad`) — **기간은 열쇠에 실어** 넘긴다(클로저에 묶으면 첫 기간으로 고정된다). 폴링 없음(소스 스윕).
  - 함대: KPI 4(로그 장애 서버 · 보안 high 서버 · 요약 있는 서버 · 공통 원인 후보) → 노드 상태 문구(구버전 엣지 등) → 공통 원인 후보(후보 문구 · 창은 API `commonWindowMs`) → 서버 표(법인 · 분류 · 규칙 · 이름 거르기 — 24시간 못 읽은 서버는 ‘—’).
- ⚠⚠ **v2.929 — 베어메탈 ‘집중 모니터링’ 탭 · 요약 탭 소모품 카드 · 보드 ‘집중 n건 · 소모품 주의’ 칩 · 추이 탭 겹침 카드 · 구간 비교 · 설정의 ‘리눅스 성능 알림 규칙’ 절(리눅스 성능 5단계 · 아트보드 Focus · Health · Alerts · Compare)**.
  화면 `views/tools/{BmFocusTab,BmPerfOpsParts,BmTrendOps,BmPerfRulesPanel}.jsx`(그리기만) · 문구 · 좌표 `bmPerfOpsText.js`(순수) · 스타일 `bmPerfOps.css` · 회귀 `bmPerfOpsText.test.jsx`(서버 열거와 1:1 · SSR · 소스 스윕):
  - **판정을 웹에서 하지 않는다** — 집중 상태 · 결측 사유 · 소모품 칸 code · 변경 종류 · 규칙 · 조건 · 채널 · 비교 지표는 서버 열거와 1:1 문구 표 · 기준값 키(chronyMs · fdPct · bandPct · diffPct …)와 비교 연산이 웹에 없다(스윕).
    히트 표 농도는 ‘이 세션 안 최대 대비’(판정이 아님)라고 화면이 말한다 · 원인은 ‘후보(상관)’ 로만.
  - ⚠ **폴링 예외(근거 · 상한)**: 진행 중인 집중 세션 화면만 `setTimeout` 30초(`FOCUS_POLL_MS`) · 횟수 상한 `focusPollMax`(세션 길이 ÷ 30초 + 4) — 판정은 순수 `focusPollStep`(목록은 4회에 1번).
    ⚠ 반증 F8: 초판은 폴링이 부른 `open()` 이 카운터를 0 으로 되돌려 상한이 동작하지 않았고 목록도 매번 다시 읽었다 — 폴링 경로는 `open(id, { poll: true })`(카운터 유지) · 사람이 고른 세션만 0 부터. · 끝나거나 탭을 떠나면 멈춘다 — 1분 간격 결과를 사람이 지켜보는 화면이라서다.
    그 밖(보드 칩 · 소모품 · 겹침 · 비교 · 규칙)은 마운트 1회 + 버튼(소스 스윕: setInterval · usePolling 0 · setTimeout 1곳).
  - **‘경로 없음’ 은 결측이 아니다**(반증 F14): iDRAC 만 있는 서버의 분을 점선 · 결측 이벤트 · 결측 칸으로 그리지 않는다(`osMissed` — 옛 표본의 `no-path` 도 같은 뜻) · 발송 결과에 `queued`(보내는 중) · `failed`(보내지 못함 — 반증 F6) 문구.
  - **결측은 0 이 아니다**: 히트 표 · 진행 띠 · CSV 의 결측 분은 ‘—’ · 점선 · 빈 칸 · 결측 문구는 `missPathParts` — 요약의 missOs · missIdrac 가 **null 이면 ‘경로 없음’**(OS 경로가 없는 서버를 ‘OS 0분’ 으로 적던 것 — Chromium r3 판독) ·
    둘 다 없으면 ‘—’. 값이 없으면 단위를 붙이지 않는다(`unitText` — 규칙 표 기준 · 띠 사유 · 스냅샷 개수 · 시험 실행 대수 · 이력 머리의 ‘?? 0’ 을 이번에 걷어냈다).
  - 표는 STable(+ `limit` — 알림 이력 100행은 정렬 뒤 자르기) · 히트 표는 `minWidth = 150 + 분 × 88` 에 `width: auto`(하한 560 이던 판은 400 폭에서 값 칸이 오른쪽 밖으로 밀려 지표 이름만 보였다 — r2 판독) ·
    규칙 절의 체크박스 줄은 `.bmr-grid label.bmo-check`(그리드 라벨 규칙이 덮어 체크박스가 글 위 가운데에 떴다 — r2 판독) · 날 select 없음(`Select`) · uppercase · 백틱 없음.
  - **쓰기 버튼**: 집중 시작은 operator 이상 · 사유 2자 미만이면 잠금 · 진행 중이면 ‘진행 중 세션이 있습니다’ · 규칙 저장은 설정 소유자 등급(`canEditRules` — 서버 403 과 같은 판단) ·
    시험 실행은 응답의 `readOnly` 가 false 일 때만(범위 관리자는 서버도 403 — fullScopeOnly) · 저장 결과는 `r?.ok === false` 로 검사(putJson 반환값).
  - 겹침 카드: 띠(서버 `bandOf` 결과 다각형 — 띠 없는 시간에서 끊는다) · 띠 밖 점(빨강 — **서버가 판정한 `outside`**: 반증 L3 · 웹 outsidePoints 복제를 지웠다) · 변경 이벤트 점선 + 위 점(같은 시각은 한 점) · 집중 1분 점(5분 값과 섞지 않고 점으로만) · yMax 에 집중 점 값 포함.
    구간 비교는 ‘어제 같은 시각 · 지난주 · 집중 세션 · 직접’ 프리셋 — 같은 길이 · B 는 끌어 고른 구간(없으면 최근 1시간) · ±20% 밖은 양방향 모두 주의색 · 그 사이 전체 변경은 접힘(details).
  - ⚠ 정직 기록: Chromium 판독(r1~r4 · 1440/400 · 가로 넘침 0 · 콘솔 오류 0)은 목 서버 데모 — 데모 백필(30분 · 14일)에 4주 1시간 롤업이 없어 띠는 서버 `bandOf` 로 만든 띠를 응답에 끼워(Playwright route) 그리기만 확인했고,
    데모 이력에 디스크 지표가 없어 ‘앞 1시간 대비’ · 구간 비교의 디스크 행은 ‘—’ 로만 봤다.
- ⚠⚠ **v2.923 — 베어메탈 서버 상세 ‘장애 기록 · 튜닝 · 용도 · 진단 스냅샷’ 탭 + 함대 ‘용도 분석 · 장애 기록’ 보기(리눅스 성능 4단계 · 아트보드 ⑤⑥⑦ · Server 스냅샷 · States ④)**.
  화면 `views/tools/{BmFaultsTab,BmTuningTab,BmProfileTab,BmSnapshotTab,BmOpsFleet}.jsx`(그리기만) · 문구 `bmOpsText.js`(순수) · 스타일 `bmOps.css` · 회귀 `bmOpsText.test.jsx`(code 표 1:1 · 서버 함수로 만든 실제 응답 SSR · 소스 스윕):
  - **판정을 웹에서 하지 않는다** — 튜닝 상태 · 사유 · 근거 등급 · 점검 결과 · 프로파일 상태 · 스냅샷 code/칸 상태는 서버 열거와 1:1 문구 표(테스트가 서버 모듈을 import 해 대조). 장애 기록의 상태 · 종료 사유 · 보류 사유는 기존 `partFaultText.js` 를 그대로 쓴다(복제 금지).
  - **‘확인 불가’ ≠ ‘권고’** — 낱말 · 색 · 정렬 순위가 다르다(정렬: 권고 → 확인 불가 → 적합 → 참고). 사실을 못 받은 서버는 전 항목 확인 불가 · 권고 0 과 이유 문장.
  - **자동 적용 버튼 없음** — 쓰기 요청은 용도 태그(PUT purpose · 관리자)와 스냅샷 실행(POST · operator 이상)뿐(테스트가 put/post 호출 경로를 스윕).
  - **근거 등급은 기호 + 짧은 낱말**(‘◐ 발췌’ — `Grade` · `gradeView`) · 기호는 기호 글꼴을 앞에 둔 `.bmo-g`: Chromium(이 컨테이너 글꼴)에서 ◐ 가 작은 반원 ‘◖’ 로 보여 표 칸에서 읽기 어려웠다. 출처 링크는 `--accent-2`(기본 링크색은 어두운 판넬에서 거의 안 보였다 — 1440 판독).
  - **표 칸은 배열로** — 조건부 칸(서버 · 법인 열 · I/O 표 열)을 `<>…</>` 로 감싸면 STable 이 머리 · 칸을 세지 못해 정렬 화살표가 사라졌다(1440 판독 — v2.920 D1 과 같은 함정). select 는 `Select` + `className="select select-sm"`(날 select 는 흰 바탕).
  - 탭 열이 8개 — 400 폭은 한 줄 4개 두 줄(`.bmp-seg-tabs`) · 표는 카드 안 가로 스크롤 · 함대 보기에서 서버를 누르면 상세가 그 탭(용도 · 장애 기록)으로 열린다(`initialTab`).
  - 조회는 탭을 고를 때 1회 + ‘다시 읽기’(폴링 없음 · 세대로 늦은 응답 버림 — `useOpsLoad` = createDetailLoader) · 기간 같은 선택은 키에 담아 다시 읽는다 · 403 은 ErrorBox, 404 는 ‘없거나 범위 밖’(`OpsError`).
  - 스냅샷: 실행 칸은 operator 이상에게만(서버도 403) · 사유 2자 미만이면 버튼 잠금 · 결과의 ‘권한 부족’ 은 상태 9종 ④ 문구(`STATE_TEXT.perm`) · 정책 거부(사유 없음 · 경로 없음 · 권한)는 서버 사유를 겹쳐 쓰지 않는다(같은 말 두 번 — 판독).
  - **반증(review-s4) 반영 — 화면**: W1 새 실행은 보관분 ‘보기’ 상태를 비우고 시작한다(예전엔 예전 보관분이 계속 보였다) · W2 ‘보기’ 연타는 세대로 늦은 응답을 버린다 ·
    W3 보관분 표 결과 칸은 code 원문이 아니라 짧은 낱말(`SNAP_CODE_TEXT[code].short` · 모르는 code 는 ‘알 수 없음’ — `SnapshotListTable`) ·
    W4 실행 · 태그 칸은 서버 GET 의 `writable` 로도 잠근다(`snapRunGate` — 역할 미달 · 쓰기 범위 밖 · 응답 전에는 잠그지 않음 — 서버가 403) ·
    W5 시간순 닫힘 문구는 서버가 이벤트마다 실은 `endReason`(incidents.js `closeReasonToEnd`)으로만 고른다(웹이 closeReason 을 다시 매핑하지 않는다 — 소스 스윕) ·
    R4 보관 상한으로 덜어 낸 칸 문구(`snapTrimNote`) · R5 dmesg 자체 오류(권한 아님)는 ‘받지 못함’.
    (Chromium r9 판독) 실패한 실행 · 보관분은 결과가 `{ error }` 뿐이라 빈 OS 칸 여섯 개가 그려졌고, 보관분의 `reason`(사람이 적은 실행 사유)이 서버 사유 자리에 보였다 —
    OS 칸은 출력을 하나라도 읽었을 때만(`osRead`) · 보관분은 `userReason` 으로 넘겨 ‘실행 사유:’ 로 적는다.
  - (기록 — 반증 W6) 함대 ‘용도 분석 · 장애 기록’ 보기는 **URL 로 열 수 없다**(링크 · 뒤로 가기 · 공유 링크 미지원). 보기 전환은 v2.920 localStorage + 자동 기본값이라 `useHashTab` 으로 옮기지 않았다(audit2613a 명시 예외 —
    그 훅은 첫 렌더의 fallback 을 해시에 굳혀 ‘성능 항목이 있으면 USE’ 를 깬다). 해시에 있으면 읽고 없으면 기존 규칙(쓰지 않음)으로 좁히는 안은 다음 판.
  - ⚠ 정직 기록: Chromium 판독은 목 서버(데모 사실 — mock/demo/baremetal.js `demoTuningFacts`)와 합성 응답(장애 기록 · 스냅샷 결과 — 서버 함수로 만든 것)으로 했다. 실장비 스냅샷 출력은 보지 못했다.
- ⚠⚠ **v2.923 — 베어메탈 서버 상세 ‘추이(평균 · 피크)’ 탭(리눅스 성능 3b · 설계 `docs/design/linux-bm-perf/PROFILES.md` §8~§12 · 아트보드 AvgPeak · Toggle · Popup)**.
  화면 `views/tools/{BmTrendTab,BmTrendPopup,BmTrendChart}.jsx`(조립 · 그리기만) · 문구 · 좌표 · 토글 `bmTrendText.js`(순수) · 조회기 `bmTrendLoad.js` · 회귀 `bmTrendText.test.jsx`:
  - **창 · 해상도 · 결측 · 기준선 · 포트 상태 · 대조 ⑤ 판정은 서버**(`bmusage/trendWindow.js` · `portCompare.js`) — 웹은 응답을 그리기만 한다. 선은 값이 null 이거나 **서버 `gaps` 가 두 점 사이에 걸칠 때만** 끊는다(웹이 점 간격으로 결측을 다시 판정하지 않는다 — 테스트가 서버 `gapsOf` 결과로 대조). 홀로 남은 점은 점으로 그린다(선이 없다고 값이 안 보이면 거짓).
  - 웹 쪽 지표 표(이름 · 단위 · 피크 열 유무)는 서버 `PEAK_COLS` · `DEVICE_PEAK_COLS` · `SERVER_METRICS` · `DEVICE_METRICS` 와, 피크 출처 · 포트 상태 · 대조 판정 이름은 `PEAK_SRC` · `PORT_STATES` · `COMPARE_VERDICTS` 와 테스트가 대조한다(두 벌이면 대조).
  - **피크 값 옆에 출처를 항상**(`peakSrcText` — ② 패널 머리 · 요약 표 각주 · 장치 표 각주 · 팝업). 창을 주기 예산으로 줄였으면(`peak_window_s` < 10) 그 사실, 0 이면 ‘꺼짐 — PSI 보조만’. 피크 점을 눌러도 **1초 표본은 펼치지 않는다**(저장하지 않는다 · B 샘플러 펼침은 배포 뒤 — 없는 기능을 그리지 않는다).
  - 추이 API 는 지표 하나 = 요청 하나다 — 탭을 열 때 주 패널 9행 + 장치 목록 + 포트 대조만, 추천 12행은 화면에 들어올 때(IntersectionObserver · 없으면 버튼), 장치 표는 세그먼트를 고를 때 부른다. **동시 4개** · 같은 창 · 같은 계열은 한 번 · 창이 바뀌면 세대로 늦은 응답을 버린다 · 폴링 없음(`bmTrendLoad.js` — 가짜 fetcher 로 고정). ⚠ 창이 바뀔 때 비우는 효과는 조회 효과보다 **먼저** 둔다(뒤면 방금 넣은 결과를 지운다) · `cancel()` 은 끊은 신호를 물려주지 않는다(StrictMode 이중 마운트).
  - 구간 이동(◀ · 슬라이더 · ▶ · 최신 · 날짜)은 **공용 코어** `components/vmperf/vmPerfText.js` 의 `windowSpan` · `backForSpan`(기간이 6시간 · 24시간 · 7일 · 30일이라 키가 아니라 길이로 — 기존 `windowOf` · `backForEnd` 가 이것을 부른다). 구간 요약(평균 · 최대 · 주의 이상 비율)도 공용 `seriesStats`. 보존(일)은 이 노드 대상만 안다 — 엣지 위임 서버는 슬라이더 없이 ◀ · ▶ · 날짜만(보존 밖이면 서버 `resReason` 이 말한다).
  - 장치 토글(§12): 색은 서버가 준 처음 본 순서(`color`)로만 — 필터해도 바뀌지 않는다 · 6색 × 실선/점선 · 범례 누름 = 그 장치만(다시 누르면 모두) · Shift = 더하기/빼기 · 8개 초과면 앞 8개 + 겹침 → 행 나눔 자동. ⚠ 설계의 ‘기타(최대)’ 계열은 그리지 않았다(장치마다 요청이 하나씩 늘어난다) — 그린 수와 남은 수를 행이 말한다. 범례 · 상한 안내는 묶음 첫 행에만.
  - 1440 에서 표 열이 가로 스크롤 뒤로 숨지 않게(v2.780 교훈) — D 절은 두 칸 대신 위아래로, NIC 표는 둘째 줄을 써서 7열로, 긴 설명 칸은 `td.bmt-wrap`(줄바꿈) · 표 칸 여백은 `table.bmt-t`. 400 은 표가 가로 스크롤 박스 · 팝업은 전체 화면.
  - 행 문구: 값이 없으면 가운데 ‘0 으로 그리지 않습니다’, 선이 있는데 피크 열이 없으면 이름 아래 작은 줄(선 위에 글자를 겹치지 않는다 — Chromium 판독).
- ⚠⚠ **v2.920 — 베어메탈 사용률(`#/tools/bm-usage` · 도구 키 그대로) USE 매트릭스 보드 · 서버 성능 상세(리눅스 성능 2단계 · 설계 `docs/design/linux-bm-perf/README.md` §5 ①~④)**.
  화면 `views/tools/{BmPerfBoard,BmPerfDetail}.jsx`(조립만) · 문구 `bmPerfText.js`(순수) · 회귀 `bmPerfText.test.js`(문구 · 상태 9종 · 렌더 스모크 · 소스 스윕) + `server/test/bmPerf2920.test.js`(API 보강 `psiAbsent` · 정제 · 데모 합성):
  - **판정을 웹에서 다시 하지 않는다** — 칸 색은 서버 code(`ok·warn·bad·none·missing·nopath·stale`), 판정 한 줄(`line`)은 서버 문장 그대로, 기준 숫자는 API `perfThresholds` 를 **보여 주기만**(`thresholdText`). 테스트가 ‘기준값 키 + 비교 연산’ 을 소스 스윕으로 막는다.
  - **‘—’ 넷은 각주 기호로 구분** — `—¹` 못 읽음 · `—²` 그 커널에 없음 · `—³` 경로 없음 · `—⁴` 오래됨(`CODE_INFO` · `cellFootnotes` — 표에 나온 것만). ‘경로 없음’(등록 없음)과 ‘못 읽음’(등록은 있는데 안 읽힘)은 상태도 다르다(`pathState` · `osOnly`/`osOnlyUnread` · `idracOnly`/`idracOnlyUnread` · `noPath`/`noneRead`).
  - **U 칸만 숫자**(입력이 하나 — 사용률), S·E 칸은 낱말(정상 · 주의 · 초과) — 여러 입력 중 가장 나쁜 것이 색을 정하는 칸에 대표값 하나를 적으면 색과 숫자가 어긋난다.
  - 보드 항목은 이 노드 대상 + **엣지 보관분**(`boardItems` — 위임 수집 환경에서 중앙 보드가 비지 않게) · 법인/경로 칩과 검색은 같은 `facetState` 를 이 목록에 다시 건다. 기존 다섯 지표 표는 ‘사용률 표’ 토글로 그대로 두었다(보기는 localStorage 편의 — 실패해도 기본값).
  - 서버 상세 탭은 **데이터가 있는 것만**(`DETAIL_TABS` — 요약 · 자원 · 하드웨어). 장애 기록 · 튜닝 · 용도 · 스냅샷 · 추이 탭은 그 기능이 생길 때 더한다(비활성 탭으로 그리지 않는다). 사용률 추이는 아래 기존 상세 카드 그대로(이 노드 대상만 — 엣지 위임 서버는 성능 상세만 연다).
  - 조회는 행을 누를 때 1회 + ‘다시 읽기’(폴링 없음) · 늦게 온 다른 서버 응답은 세대로 버린다 · 403 은 ErrorBox · 404 는 ‘없거나 범위 밖’(둘을 구분하지 않는다).
  - ⚠⚠ **매트릭스 칸은 `<td>` 를 돌려주는 함수(`perfCell`)로 넣는다 — 컴포넌트(`<PerfCell/>`)로 넣지 말 것**(2단계 반증 D1): STable 정렬(`sortableText.cellText`)은 행에 td 가 하나라도 있으면 **td/th 만 셀로 센다** — 컴포넌트 칸 15개가 빠져 열 클릭이 판정 열로 정렬되거나 아무 일도 하지 않았다. 회귀는 `matrixRows` 결과에 실제 `sortChildren` 을 건다(U 숫자 · S code · 판정 · ‘—’ 늘 뒤).
  - 각주와 칸은 같은 함수(`cellCode` · `codesUsed`)로 — 항목이 없는 행(표본 없음)은 기호 없는 ‘—’ + 별도 각주(`NO_ENTRY_FOOTNOTE`), code 가 빠진 칸은 ‘—¹’ 이고 각주 ¹ 이 함께 나온다(반증 D3).
  - ‘꺼짐’ 은 이 노드 `enabled === false`(데모 제외) · 엣지 `enabledOnEdge === false` 로 항목에 `off` 를 달아 신뢰 띠 안내 + 행 칩 + 상세 머리로 그린다 · 꺼진 법인 수는 `skippedCounts['corp-off']`(반증 D4). 인증 정지는 이 노드 + 엣지 보관분 합산(`allAuthStops` — 반증 D6).
  - 상세는 상태 없는 `BmPerfDetailView` + 세대 조회기 `createDetailLoader` 로 나눴다 — 응답 뒤 화면 · 403/404 · 늦은 응답 버림을 가짜 fetcher + SSR 로 고정(반증 D8). 404·실패 때는 목록 항목의 상태 블록을 섞지 않는다.
  - 400 폭: `.bmp-seg` 전폭 · 버튼 44px · 탭 글자는 줄바꿈 허용(nowrap 이면 세 번째 탭이 잘렸다 — Chromium 실측) · 매트릭스는 STable `minWidth` 가로 스크롤 박스. 1440 에서는 법인을 서버 칸 아래로 · 판정 배지를 판정 한 줄 칸으로 합쳐 스크롤 없이 들어간다(1차 판본은 1589px 표가 1118px 칸에서 하드웨어 · 판정 열이 잘렸다).

- ⚠⚠ **상단 메뉴 2단화 — 탭 규칙은 `.topbar .tabs .tab` 으로 한정한다**(v2.556, 같은 핸드오프 §0):
  `className="tab"` 은 앱 **전역에서 일반 버튼**으로도 쓰인다(접속확인·필터 초기화·CSV 선택·
  집계 단위 … 수십 곳). 전역 `.tab` 을 밑줄 스타일로 바꾸면 그 버튼들이 전부 테두리 없는 글자가
  된다. Chromium 으로 확인했고(전역 `.tab`: radius 8px·active 파란 채움 / 헤더 탭: radius 0·청록
  밑줄) `web/src/shellStyles.test.js` 가 CSS 소스로 그 계약을 고정한다(주석을 먼저 제거해 검사).
  · **브랜드 행의 `flex-wrap: wrap`** 이 좁은 폭 가로 넘침의 해법이다 — 이 셸은 v2.555 까지
    400px 에서 **628px** 로 넘쳤고(원인: `status-pill`·`user-box`) 2단화로 0 이 됐다.
  · 상태 칩 내용·사용자 메뉴 동작은 **그대로 두고 톤만** 바꿨다(모노·자간·배경). 하단 상태바도
    칸 개수·내용은 그대로다.
- ⚠⚠ **1600px 이상에서만 상단 메뉴를 브랜드행 한 줄에 합친다 — 임의 폭에서 합치면 메뉴가
  잘린다**(v2.572, 사용자가 캡처와 함께 "빨간색으로 표시된 부분에 있는 메뉴를 노란색 부분으로
  이동해줘, 버전명/메뉴/로그인 사용자가 1줄로 깔끔하게 보이게 해줘" 요청 — v2.556 의 2행 레이아웃
  에서 행1(로고~버전~여백)과 행2(메뉴 13개) 사이 빈 공간을 메우는 것):
  - **`<nav className="tabs">` 는 이제 JSX 상 `.tb-brandrow` 의 자식이다**(`App.jsx`) — 예전에는
    brandrow 뒤의 형제 블록(행2)이었다. 시각적 순서는 CSS `order` 로만 정한다(마크업 순서와 무관).
  - ⚠⚠ **`flex-wrap: wrap` 은 줄바꿈 여부를 '줄어든 뒤 크기' 가 아니라 각 아이템의 hypothetical
    size(= flex-shrink 적용 전의 flex-basis)로 판단한다.** `.topbar .tabs` 에 `flex:1 1 auto` 를
    주면 `min-width:0` 로 줄어들 수 있는데도 **줄어들기 전 전체 콘텐츠 폭**이 줄맞춤 판정에 쓰여
    옆 칸(user-box)이 다음 줄로 밀려난다(1440px 실측 — 메뉴는 줄어들 수 있었는데 옆 칸이
    튕겨나갔다). **`flex: 1 1 0%`**(flex-basis 0%)로 hypothetical size 를 0 으로 만들어야
    한 줄에 남는다 — `auto` 로 되돌리지 말 것.
  - ⚠⚠ **미디어쿼리는 특정도를 올리지 않는다 — 특정도가 같으면 소스에서 나중 규칙이 이긴다**
    (조건이 참이어도). `.topbar .tabs {...}` 미디어쿼리 블록을 그 선택자의 **기본 규칙보다 앞에**
    두면(v2.572 초판의 실제 결함) 1600px·1920px 에서도 기본 규칙에 덮여 메뉴·사용자칩이 여전히
    다른 줄로 떨어졌다(실측으로 확정). 미디어쿼리는 그 선택자를 건드리는 **모든 기본 규칙 뒤에**
    배치할 것.
  - **1600px 미만(1440px·400px 포함)은 v2.556 그대로 2행**이다 — `.topbar .tabs { flex:1 1 100%; }`
    가 기본값으로 메뉴를 독립된 줄로 떨어뜨린다. **경계는 추측이 아니라 실측**이다 — 2400px
    뷰포트(축소·확장 왜곡이 없는 폭)에서 로고 206.8px + 탭 13개 실제 콘텐츠폭 985.39px +
    상태칩 123.3px + 사용자칩 164.0px + gap(14px×3) + padding(20px×2) = **1561.55px**. 1440px
    에서 강제로 한 줄에 넣으면 `nav.scrollWidth(985) > nav.clientWidth(864)` 로 탭 2개
    ('인사이트'·'설정')가 **스크롤 없이 안 보이게 잘린다** — 그래서 40px 여유를 둔 1600px 를
    썼다. 이 숫자보다 낮춰 되돌리지 말 것(재측정 없이 낮추면 같은 클리핑이 재발한다).
  - **narrow-width 회귀 없음**: A/B 로 확정 — 변경 전 커밋으로 되돌려 400px 헤더를 재빌드해
    스크린샷을 비교하면 **바이트 단위로 동일한 3줄 패턴**(브랜드+상태칩 1줄, 사용자칩 2줄, 메뉴
    3줄+가로스크롤)이었다. `.tb-brandrow` 의 `flex-wrap: wrap`(v2.556 의 400px 안전망)은 손대지
    않았다 — 1600px 미만에서는 이 안전망이 그대로 작동한다.
  - `shellStyles.test.js` 의 기존 7개 계약(탭 선택자 범위·전역 `.tab` 스타일·brandrow
    flex-wrap·`.topbar .tabs` overflow-x:auto 등)은 전부 무수정으로 통과 — 이번 변경은 이
    계약들과 독립적인 **폭 조건부 순서 재배치**다.
- ⚠⚠ **v2.725 — 상단 메뉴는 대메뉴 10개 + 하위 메뉴 줄(시안 A '2단 탭')이고, 표는 `web/src/views/topMenu.js` 하나다**
  (사용자 요청 메뉴 재구성 + Claude Design 시안 https://claude.ai/artifact/HMEPTddM42sLXFikvQX1eq · 업그레이드는 설정 하위. 회귀 `web/src/views/topMenu.test.js`):
  · 화면을 새로 만들지 않는다 — 하위 메뉴는 기존 탭(`#/<tab>`)이나 특수 기능 도구(`#/tools/<k>`)를 가리킬 뿐이다. **탭 id·도구 키는 그대로**
    (해시 라우팅·북마크·toolsDenied 가 쓴다). 옛 주소(#/hosts 등)는 그대로 열린다.
  · ⚠ **App 의 TABS 에 탭을 더하면 MENU_GROUPS 에도 넣을 것** — 빠진 탭은 메뉴로 갈 길이 없다(테스트가 두 집합을 대조한다).
  · 지금 위치는 `locate(tab, hash)` 하나가 판정한다 — 특수 기능 카드로 연 도구도 그 도구가 속한 메뉴가 켜진다. 물리 서버는 서버 분석의
    셋째 주소 조각 `baremetal`(`#/tools/serveranalysis/baremetal/<하위 탭>`)이고 서버 분석은 그 모드에서 구분을 Baremetal 로 고정한다
    (모드가 바뀌면 `key` 로 화면을 새로 만든다 — 하위 탭 훅의 base 가 모드마다 다르다).
  · 노출은 탭 = App visibleTabs, 도구 = `toolVisibility.lockReasonOf`(특수 기능 카드와 같은 판정). 하위 메뉴가 모두 빠진 대메뉴는 숨긴다.
    카탈로그는 첫 번들을 키우지 않게 동적 import 이고, 불러오기 전에는 toolAllowed 만 본다.
  · ⚠ 인증을 끈 목 서버는 화면 쪽 사용자가 언제나 Anonymous 관리자다(App.jsx `!cfg.authEnabled`) — viewer·operator 메뉴는 **인증을 켜고 실제 계정으로**
    확인해야 한다(v2.725 검증: viewer 는 서버·스토리지·네트워크 일부만, operator 는 관리자 전용 도구가 빠진다).

- ⚠⚠ **v2.726 — 메뉴는 좌측 사이드바이고, 계정별 메뉴(내 메뉴 > 배포 메뉴 > 포탈 기본)는 서버에 저장한다**
  (사용자 요청 "상단 1줄과 하위 메뉴 재구성을 좌측 사이드바 구성으로" + "사용자가 자신만의 메뉴 · 슈퍼 관리자는 전체 사용자에게 강제 배포(직접 만든
  사용자에게 강제 적용할지 선택)" · Claude Design 시안 https://claude.ai/artifact/LmmbvpcR9wp9pMWUWmLRu4 · 선택 '전체 검증' · '분류 바로가기 제외'.
  서버 `usermenu/store.js`(순수 정규화 + 파일 `user-menus.json`) · `routes/api/userMenu.js` · 웹 `views/sidebar/`{sideMenu.js,menuEdit.js,
  Sidebar.jsx,MenuEditor.jsx,sidebarIcons.jsx}. 회귀 `server/test/userMenu2726.test.js`(실제 api 라우터) + 웹 `sideMenu.test.js`·`menuEdit.test.js`·
  `shellStyles.test.js`·`topMenu.test.js`):
  · **포탈 기본 메뉴는 여전히 `topMenu.js MENU_GROUPS` 하나**다. 저장 메뉴는 주소(탭·도구+조각)만 담고 라벨·id 는 화면이 기본 메뉴·카탈로그에서
    채운다(`sideMenu.resolveMenu` — 서버는 라벨을 모른다). 모르는 항목은 버리고 `unknown` 으로 센다(지어내지 않는다). `locate`·`visibleMenu`·`entryOf` 는
    groups 인자를 받아 사용자 메뉴에도 그대로 쓴다 — **권한 판정은 바뀌지 않는다**(메뉴에 넣어도 넓어지지 않고, 뺀 화면은 카드·주소로 열린다).
  · ⚠⚠ **저장 모양의 계약**: `{v:1, groups:[{id,label?,tab}|{id,label?,tool,seg?}|{id,label?,children:[{tab}|{tool,seg?}]}]}` — 같은 항목은 앞의 것만(단독 · 그룹 통틀어), 빈 그룹은 저장 시 제외,
    상한(그룹 40·항목 400·라벨 40)을 넘으면 400(`field`). 사용자 그룹 id 는 `custom-n`. 특수 기능은 단독 항목(`#/tools`)이다 — 분류 바로가기 하위 메뉴는
    사용자 결정으로 두지 않았다(SpecialTools.jsx 무변경).
  · **배포는 superAdmin 만**(`requireSuperAdmin` — `isSuperAdmin(req.user)`, 범위 superAdmin 도 403 `menuFleetOnly`). `force` 는 직접 만든 사용자의 메뉴를
    `prev`(누가·언제·방식) 로 옮기고 지운다(배포자 자신은 제외) · `keep` 은 건드리지 않는다. 철회(DELETE)는 배포 메뉴만 지운다. 기록 `history` 20건 +
    감사 로그(`user-menu.*`). 대상 수는 로컬 계정 기준이고 AD 계정은 미리 셀 수 없다 — 화면이 말한다. 배포는 '저장된 내 메뉴' 만(바뀐 것이 있으면 버튼 비활성).
  · **새 게이트 이름 `menuFleetOnly`·`requireSuperAdmin` 은 `scripts/api-doc.mjs GUARD_NOTE` 에, 파일은 `archScan KNOWN_CONFIG_FILES` 에 등재했다.**
    상태가 아니라 설정 파일(백업 감시 대상)이다. 손상이면 `preserveCorrupt` + 빈 저장소(저장분도 `safeMenu` 로 재정규화해 읽는다).
  · **사이드바 셸**: full 236px / rail 64px(hover·focus-within 플라이아웃 — `.sb-nav` 가 `overflow:visible` 이어야 하고 `.sb` 에 backdrop-filter·transform 을
    걸지 말 것) / drawer(<720px, 닫히면 `visibility:hidden`). 높이는 App 이 ResizeObserver 로 잰 `--topbar-h`·`--statusbar-h`(숫자를 박지 않는다).
    `localStorage ui.sidebar`('rail'|'open', try/catch) · 저장값 없으면 1200px 미만은 레일. **CSS 는 `.sb`·`.me`·`.app-body` 아래로만**, 전역 `.tab` 그대로,
    uppercase 금지 — `shellStyles.test.js` 가 고정한다. v2.556·v2.573·v2.725 의 상단 메뉴 규칙(`.topbar .tabs`·`.subtabs`·1600px 한 줄)은 지웠다.
  · **v2.891 단독 메뉴**(사용자 요청 '메뉴 수정에서 단독 메뉴로 추가하는 기능' · 선택 '바로 구현 · 표준 검증'): 아무 항목(그룹 안 항목 · 특수 기능 도구)이나
    그룹 없이 한 줄로 — 최상위 `{id,tab}`(예전부터) · `{id,tool,seg?}`(새 모양 — 서버 `normalizeMenu` 가 받는다). 판정은 `sideMenu.isSingle` 하나(children 배열 없음).
    편집: 오른쪽 '+ 단독'(`addSingle` — 추가 대상 그룹 없이 '특수 기능' 앞) · 그룹 항목 '단독'(`detachToSingle` — 그 그룹 바로 아래) · 만든 단독만 ✕
    (기본 단독은 `fixedSingleKeys` — 자리만). 새 단독(custom id)은 **라벨 · 아이콘을 저장하지 않는다** — 해석 때 항목 라벨(이름 덮어쓰기)과 그 항목의
    기본 그룹 아이콘(`iconOf` · 특수 기능에서 더한 도구는 특수 기능)으로 채운다. `locate` 는 단독 도구 화면을 그 단독(child null)으로 가리킨다.
    회귀 웹 `sidebar/singleMenu2891.test.js` · 서버 `userMenuSingle2891.test.js`.
  · 편집 창(`MenuEditor`)의 '바뀐 항목' 은 `menuEdit.changeCount`(LCS 기반 최소 개수 — 항목 하나를 지우면 1 이지 밀린 뒤 항목 전부가 아니다).
    저장·삭제·복원·배포는 `putJson/delJson/postJson` 이고 403 은 `ErrorBox error={}` 로 권한 안내.
  · ⚠ 정직 기록: Chromium 은 인증을 켠 목 서버(비밀번호 로그인 재정의 `login-policy-users.txt`)에서 admin·noainred(super_admin)·operator·viewer × 1440/400 을
    봤다. AD 계정·실운영 계정 수백 명 규모의 배포는 보지 못했다(대상 수는 로컬 계정 수).

- ⚠⚠ **역할별 ‘도구별 접근’ 표는 특수기능 카탈로그 전체를 쓴다 — 여기에 필터를 붙이지 말 것**
  (`web/src/views/userAdmin/userToolText.js roleToolRows` + `UserAdmin.jsx:11`, v2.573 —
  사용자 지시 "특수기능이 추가되면 자동으로 권한설정 하는 기능에 추가되게 해줘"):
  - **증상**: v2.572 까지 `const TOOL_ROWS = SPECIAL_TOOLS.filter((t) => !t.adminOnly)` 라
    카탈로그 **86개 중 61개만** 표에 나왔다. 빠진 25개는 대부분 **최근에 추가된 기능**
    (통신 점검 v2.552 · 포탈 점검 v2.560 · 엣지 로그 v2.549 · 파트 장애 v2.547 · 스토리지
    증가량 v2.531 …)이라 — **기능을 더할수록 권한 화면이 조용히 뒤처졌다**.
  - ⚠⚠ **그 필터는 틀린 전제 위에 있었다.** `adminOnly` 는 카드 표시 관례이고 접근제어가
    아니다 — v2.555 가 **사용자별 모달에서 이미 확인해 기록해 둔 사실**인데(아래 항목)
    역할 표에는 적용하지 않았다. 실측: `/api/tools/pdu` 의 조회는 `routes/api/pdu.js:52`
    에서 `requirePerm('tools') + fullScopeOnly` 이고 `/api/tools/storage` 도 같다 — operator 가
    주소로 직접 열 수 있는데 **그 도구가 표에 없으니 관리자는 끌 방법 자체가 없었다**.
    빠진 25개 중 **16개가 서버 집행 대상**(`enforcedToolKeys()`)이었다.
  - **고친 방식**: 필터를 없애고 `roleToolRows(catalog)` 하나가 '거르지 않는다' 를 선언한다
    (키 없는 행만 뺀다 — 표에 그릴 수 없다). adminOnly 행에는 사용자별 모달과 **같은 상수**
    (`ADMIN_MARK_LABEL`·`ADMIN_MARK_TITLE_ROLE`/`_USER`)로 ‘관리자 표시’ 배지를 단다.
    ⚠ 두 화면의 **뜻이 반대**라 title 은 따로 둔다 — 모달은 '고르면 보인다', 역할 표는
    '끄면 막힌다'. 한 문구로 덮으면 반대 방향 안내가 된다(테스트가 두 값이 다름을 고정).
  - ⚠ **머리말도 함께 고쳐야 한다** — 예전 문구는 "관리자 전용 도구는 목록에서 제외됩니다"
    였다. 제외를 없애고 문장을 남기면 **화면이 거짓말을 한다**(테스트가 ‘제외’ 0 을 고정).
  - **회귀는 소스까지 검사한다**(`userToolText.test.js`): ① `roleToolRows(SPECIAL_TOOLS)` 가
    실제 카탈로그와 **개수·순서 모두 일치** ② `UserAdmin.jsx` 에 `SPECIAL_TOOLS.filter`·
    `TOOL_ROWS.filter` 가 **0건** ③ 라벨 문자열을 JSX 에 다시 적지 않았는지. 변이 검증 —
    필터를 되살리면 ②가 실패한다(실측 1 failed / 12 passed).
  - ⚠ **나머지 등록처는 이미 자동이거나 테스트가 막고 있다**(v2.573 에 전수 확인):
    사용자별 모달(`SPECIAL_TOOLS` 직접) · (v2.747 V4 트리 배치는 셸과 함께 폐기) ·
    서버 집행 커버리지(`audit2506.test.js:282` 가 `specialToolsList.js` 를 **정규식으로 읽어**
    미선언 0 을 고정 — 새 도구를 매핑도 선언도 없이 추가하면 CI 가 깨진다). 즉 **남은
    수동 작업은 `auth/toolAccess.js` 에 경로를 매핑하거나 사유를 선언하는 것 하나**이고,
    그것은 경로를 사람이 확인해야 하므로 자동화 대상이 아니다(잘못 매핑하면 **엉뚱한 화면이
    막힌다** — v2.506 `capacity-forecast` 사고).
  - ⚠ **화면이 갑자기 '권한이 열린 것처럼' 보인다** — 새로 나온 25행의 operator·viewer 가
    전부 체크돼 있기 때문이다. 이것은 **바뀐 것이 아니라 원래 그랬던 사실이 보이게 된 것**
    이다(서버 동작은 한 줄도 바꾸지 않았다). 머리말이 그 사실을 말한다.

- ⚠⚠ **사용자별 특수기능 권한 — '허용 목록' 은 거부 목록과 반대 방향의 성질을 가진다**
  (`auth/permissions.js effectiveToolAccess`·`auth/toolAccess.js issueFor` + 웹
  `views/toolVisibility.js`·`views/userAdmin/userToolText.js`, v2.555 — 사용자 요청 "특정 사용자는
  특수기능의 특정 기능만 사용할 수 있고, 나머지 기능은 보여주지 않고 싶다 · 스토리지 엔지니어에게
  스토리지 메뉴만". 선택: **허용 목록 모드 추가**(기존 거부 목록 유지) · **사용자 단위** ·
  **아예 숨긴다** · **사용자 관리 화면 안에 확장** · 전진 검증):
  - ⚠⚠ **판정은 `effectiveToolAccess` 하나가 소유한다.** 이 값을 쓰는 곳이 셋이다 — ① 서버 집행
    (`toolGate`) ② 로그인·`/auth/me` 응답(웹 숨김의 근거) ③ 관리 화면. 세 곳이 각자 `mode==='allow'`
    를 해석하면 **화면은 숨겼는데 API 는 열려 있는** 상태가 된다. 그것이 v2.536 이 기록한 사고
    (프론트 탭 조건만 있고 서버 집행이 없었다 — 그건 접근제어가 아니라 '메뉴 숨김' 이다)다.
    `routes/auth.js` 는 두 응답에 **같은 헬퍼(`toolFields`)** 를 쓴다 — 테스트가 그 사실을 고정한다.
  - ⚠⚠ **허용 목록은 '앞으로 추가되는 도구' 도 차단한다**(거부 기본값). 거부 목록은 새 도구를
    자동으로 **허용**하므로 방향이 반대다. 그래서 화면이 그 성질을 문구로 먼저 말한다.
    **`allowed` 가 배열이면 그것이 전부다** — 웹 `toolAllowed` 가 `toolsDenied` 만 보던 판정으로
    되돌아가면 허용 목록이 **화면에서 통째로 무시**되어 숨겨야 할 메뉴가 그대로 보인다.
  - ⚠⚠ **`allow` + 빈 목록을 버리지 말 것.** "이 계정에 특수기능을 하나도 주지 않는다" 는 정당한
    설정이고, 버리면 그 의도가 조용히 **'제한 없음'** 으로 되돌아간다(이 기능 최악의 거짓).
    반대로 `deny` + 빈 목록은 아무것도 막지 않으므로 '재정의 없음' 과 같다 → 저장하지 않는다.
    ⚠ 의존성 키를 `tools.join(',')` 으로 만들지 말 것 — 빈 배열과 `null` 이 **둘 다 빈 문자열**이
    되어 전면 차단 설정이 '재정의 없음' 으로 읽힌다(웹 3곳은 `JSON.stringify` 를 쓴다).
  - **허용 목록은 역할 거부와 합치지 않는다**(교집합 금지) — 관리자가 "이 사람은 이것만" 이라고
    명시한 것이므로 교집합을 내면 **관리자가 준 것이 조용히 사라진다**. 대신 상위 게이트인
    `tools` 기능 권한은 **여전히 필요**하고, 그 조합(권한 없음 + 허용 목록 있음)을 모달이 경고한다.
  - **`off`(재정의 없음)는 저장하지 않는다** — false 를 쌓으면 '한 번 건드린 사용자' 와 '건드리지
    않은 사용자' 를 구분할 수 없다. **admin 은 재정의 대상이 아니다**(관리자 잠김 방지) — 라우트가
    400 + 사유로 거절한다(조용히 무시하면 관리자가 적용된 줄 안다). 없는 계정에도 저장하지 않는다
    (파일에만 남은 유령 항목이 나중에 같은 이름의 계정에 뜻하지 않은 제한을 건다).
  - ⚠ **`SCHEMA_VERSION` 은 올리지 않는다** — 이것은 **권한 키 추가가 아니다**. 파일에 `users` 가
    없으면 `{}` = '재정의 없음' = 기존 동작이라 **조용한 거부가 생길 수 없다**(버전 마이그레이션은
    '행이 곧 부여 목록' 인 권한 키에만 필요하다 — v2.506 규약).
  - ⚠⚠ **숨김/회색 잠금은 축으로 나눈다**(`views/toolVisibility.js toolHidden` 하나가 판정):
    **허용 목록 모드 → 숨긴다**(사용자가 그것을 요청했다) · **거부 목록 모드 → 기존대로 회색 잠금**
    (`SpecialTools.jsx` 주석이 "항목이 많아 숨김보다 회색 잠금이 낫다" 고 적고 있다 — 기존 현장
    화면이 바뀌면 안 된다). **카드 그리드·V4 내비 트리·⌘K 팔레트 셋이 같은 함수를 쓴다** — 한 곳만
    고치면 "내비에는 없는데 팔레트로는 열린다" 가 된다. `visibleTree` 는 `toolShown` 을 주지 않으면
    예전 규칙을 그대로 쓴다(구버전 호출·테스트 호환).
  - ⚠ **`adminOnly` 플래그는 표시 관례이고 접근제어가 아니다**(`specialToolsList.js`). 사용자 예시인
    스토리지 모니터링이 실제로 그렇다 — 조회 라우트는 `requirePerm('tools') + fullScopeOnly` 라
    operator 는 **이미 API 로 읽을 수 있는데 카드만 감춰져** 있었고(실측: viewer 토큰으로
    `/api/tools/storage` 200), 그 플래그 때문에 "스토리지 엔지니어에게 스토리지만" 이 **성립하지
    않았다**. 그래서 관리자가 **명시적으로 허용한** 도구는 그 관례를 넘어 보여 준다
    (`api.js toolExplicitlyAllowed`). **서버 권한은 무엇도 넓히지 않는다** — 조회에 admin 이 필요한
    도구는 열어도 403 이고, 모달이 그 사실을 미리 적는다(무음 실패 금지).
  - ⚠ **허용 목록 모드에서 '회색 카드는 클릭할 수 없습니다' 안내를 쓰지 말 것** — 숨겨서 회색 카드가
    **하나도 없으므로** 그 문구가 거짓이 된다(v2.555 Chromium 판독에서 발견. 수치로는 안 잡혔다).
    판정·문구는 `toolVisibility.gridIntro` 가 소유하고, 허용 0개면 '없습니다 + 조치' 를 말한다.
  - **403 응답에 `toolMode` 를 싣는다** — '역할이 막았다'(deny)와 '허용 목록에 없다'(allow)는
    사용자가 관리자에게 요청할 내용이 다르다. ⚠ 사유 문구에서 **도구 키에 조사(은/는·이/가)를 붙이지
    말 것** — 키가 영문이라 받침 유무를 알 수 없다(괄호 뒤에 붙인다).
  - ⚠ 서버가 막을 수 있는 도구는 `/api/tools/*` 중 **매핑된 경로**뿐이다(v2.506 `toolEnforcement`).
    허용 목록 모드에서는 **'고르지 않은 전부'** 가 차단 대상이므로 그 기준으로 공백을 세어 모달이
    개수를 밝힌다(`enforcementGapNote`). 판정은 `toolEnforcementText.enforcementOf` 하나가 소유한다.
  - 회귀는 `server/test/userTools2555.test.js` 가 **실제 `api` 라우터를 express 에 마운트해
    상태코드로** 고정한다(소스 grep 이 아니다 — v2.506 이 그 실수를 했다) + 웹
    `toolVisibility.test.js`·`userToolText.test.js`.
  - ⚠ **정직 기록 — 실측으로 확인한 것과 못 한 것**: 목 서버(인증 켬)에 viewer 계정 2개를 만들어
    **실제로 로그인해** 확인했다 — 허용 계정은 카드 **2장**(스토리지 2종)만 보이고, 재정의가 없는
    계정은 **83장** 그대로이며, `/api/tools/{ipam,hardware,gpu}` 는 403 · `/api/tools/storage`·
    `storage-growth` 는 200 이었다. 400px 가로 넘침(584px)은 **두 계정이 동일**하고 원인이 기존 셸
    헤더(`status-pill`·`user-box`)라 **이 변경과 무관**하다(A/B 확인). 실제 운영 계정·AD 계정으로는
    확인하지 못했다.

- **리포트 표(`.rpt-wrap`)의 숫자칸·계열명칸은 단어 중간에서 쪼개지 않는다**(`web/src/styles.css`,
  v2.525 — 사용자 신고 "실시간 글자 1줄에 나오게 해줘"): `overflow-wrap: anywhere` 는 **문장 칸**을
  위한 규칙인데 숫자 칸까지 적용돼 `실시간` 배지가 `실/시간` 으로, `Consumed` 가 `Consum/ed` 로,
  `63.6 GB` 가 `63.6/GB` 로 쪼개졌다. `td.right`·`td:first-child` 만 해제하고(공백 줄바꿈은 유지 —
  `nowrap` 으로 굳히면 400px 에서 표가 뷰포트를 넘친다) 배지 자체에 `white-space:nowrap` 을 준다.
  A/B 실측(Chromium): 칸 폭 50px 이하에서 배지가 **2~4줄** 이었고 이제 항상 1줄, `Consumed` 는
  2줄 → 1줄, 문장 칸은 6줄로 그대로다(회귀 없음). **스크린샷·DOM 측정을 해야 보이는 결함이다.**
- **웹 폴링 뷰 오류 처리**: 데이터 보유 중 일시 폴링 오류 1회로 화면 전체를 ErrorBox로 갈아치우지 않는다 — `if (error && !data)`일 때만 전체 오류, 그 외엔 배너(고RTT에서 대시보드 깜빡임 방지). 스코프(파라미터) 변경 시 usePolling이 직전 데이터를 비워 이전 스코프 데이터 표시를 막는다.
- ⚠⚠ **`text-transform: uppercase` 를 앱 텍스트에 걸지 말 것 — 제품명·단위의 대소문자는 정보다**
  (v2.575 BUG-13. CLAUDE.md 가 v2.508 `kWh`·v2.550 `디스크 busy` 에 **두 번** 겪고도 그때마다
  **개별 라벨만** 고쳐(한글로 바꿔 우회) 구조를 남겨 둔 탓에 세 번째가 왔다):
  Chromium 전수 판독(1440px·9화면)에서 **11건**이 실제로 새고 있었다 —
  `vCenter→VCENTER` · `Cores→CORES` · `ESXi→ESXI` · `vCore→VCORE` · `vCPU→VCPU` ·
  `서버 Uptime→UPTIME` · `수집 서버(edge)→(EDGE)`. 제거한 선택자는 `thead th`(전역·181개 표)·
  `.kpi .label`·`.statusbar .sb-label`·`.section-title`·`.collector-diag-path-label` 다.
  한글에는 대문자화가 **무연산**이고, 대문자는 글자가 더 넓으므로 제거는 표를 **좁히는** 방향이라
  가로 넘침 위험도 없다('작은 라벨' 느낌은 `letter-spacing` 이 유지한다).
  ⚠ **수치로는 안 잡힌다 — 스크린샷을 읽어야 보인다.** `test/audit2575.test.js` 가 다섯 선택자를 고정한다.
- ⚠⚠ **표의 상한(`limit`)과 최소폭(`minWidth`)은 `STable` 이 소유한다**(v2.575 BUG-19·23/IMP-12):
  · **`limit` 은 정렬 뒤 자른다.** 호출부에서 `rows.slice(0, N)` 으로 먼저 자르면 표가
    '전체를 정렬한 상위 N' 이 아니라 **'앞 N 을 정렬한 것'** 이 된다 — 열을 눌러도 원래 순서의
    앞 N 안에서만 정렬되므로 **오류 없이 틀린 표**다(v2.556 이 `DataTable` 에 같은 이유로 넣은 규약인데
    `STable` 에는 수단이 없어 호출부 6곳이 먼저 자르고 있었다). **뺀 개수는 호출부가 말한다**(조용한 상한 금지).
  · **`minWidth` 를 주면 컴포넌트가 가로 스크롤 래퍼까지 함께 만든다.** 래퍼만 있으면
    `table{width:100%}` 때문에 브라우저가 스크롤 대신 **열을 짜부라뜨리고**(400px 에서 행이 세로로
    길어진다 — 넘침은 0px 이라 **수치로는 안 잡힌다**), `minWidth` 만 있으면 **페이지가 가로로 밀린다**.
    이 짝을 손으로 맞추다 한쪽을 빠뜨리는 것이 반복 사고라 컴포넌트가 둘을 묶는다. 이미 스크롤
    래퍼 안이면 `wrap={false}`.
- ⚠ **값이 없으면 단위를 붙이지 않는다 — `web/src/views/unitText.js`**(v2.575 BUG-20):
  `— ℃` · `— MB` · `—%` 는 **0 처럼 읽힌다**(v2.534 가 전산실 온도에서 겪은 것과 같은 유형이
  다른 화면 9곳에 남아 있었다). `${v ?? '—'}${단위}` 를 새로 쓰지 말 것.
- ⚠ **웹에도 `numOrNull` 이 있다**(`web/src/numOrNull.js`, v2.575 — **여덟 번째 재발**):
  서버 `util/numOrNull.js` 와 **같은 규칙**이고 테스트가 두 구현을 같은 입력으로 대조한다(웹은
  서버 소스를 import 할 수 없다 — 번들 경계). v2.575 실측 재현 — 연결 끊긴 ESXi 호스트가
  vCenter 개요 표에서 **`흡기온도 0℃ · CPU 0% · MEM 0%`**(정답은 전부 `—`), 처리량을 재지 않는
  Unity·VPLEX·PowerStore 노드가 **`0 bps`**(= '트래픽 없음' 이라는 거짓). 둘 다 **오류 없이 틀린 값**이다.
- ⚠ **Ping 추이의 '측정 없음' 을 한 문구로 덮지 말 것**(`web/src/views/pingEmptyText.js`, v2.575 BUG-16):
  폴러 전역 꺼짐 / 대상 비활성 / 마지막 측정이 조회 기간 밖 / 첫 측정 대기는 **조치가 전부 다르다**
  (앞 셋은 **기다려도 안 된다**). 판정 순서가 계약이고 `waiting` 플래그가 그것을 들고 있다 —
  실패 판정들 **뒤**에 '기다리면 된다' 를 둔다(v2.509·v2.517 규약).

- ⚠⚠ **화면 문구에 백틱 금지는 전수 스윕이 고정한다**(`web/src/views/uiText.test.js`, v2.576 —
  **여섯 번째 재발**): `BoldText` 는 `**강조**` 만 해석하므로 백틱은 **화면에 글자로 보인다**.
  v2.439·v2.440·v2.505·v2.545·v2.553 에 다섯 번 기록하고도 그때마다 **그 파일 하나만** 고쳤고
  (v2.553 테스트는 `settingsCheckText` 만 검사한다) v2.576 에 **6곳**이 남아 있었다 —
  `sanHealthText.cmdNote`(BoldText) · `bulkIoText.tokenHint`(plain) ·
  `UnityCapacityPlanPanel` 의 `sub` prop(plain) · `CurrentUsersSettings`(BoldText) ·
  `curUserText.agentGuide` 2줄(`<li>{g}</li>`). 값 인용은 **홑화살괄호 `‘ ’`** 로 한다.
  · 검출은 **이스케이프된 백틱**(앞선 백슬래시 연속 개수가 **홀수**)이다 — `` `${sel}\` ``
    (백슬래시 짝수 = Windows 경로)는 대상이 아니다.
  · ⚠ **홑따옴표 문자열 안의 백틱까지 정규식으로 잡으려 하지 말 것** — 중첩 템플릿 리터럴
    (`` `평균 ${x == null ? '—' : `${x}%`}` ``)에서 **오탐 30여 건**이 났다. 오탐이 있는 스윕은
    곧 무력화된다(현재 그 형태는 0건).

- ⚠⚠ **그리드·플렉스 자식의 `min-width: 0` 은 한 폭만 재면 놓친다**(`.vc-grid`/`.vc-card`,
  v2.576 — 특수기능·vCenter 목록·IPAM·하드웨어 **5화면이 공유**하는 그리드):
  카드 하나(`스토리지 모니터링`)의 설명문이 **줄바꿈 지점 없는 min-content 456px 토큰**이라
  `min-width: auto` 때문에 트랙을 474px 로 키웠다. 실측 — **1920px 0px / 1440px 115px /
  1280px 0px**(3열이 되며 트랙이 우연히 충분) **/ 400px 99px**. 표준 폭에서 넘치는데 더 넓은
  폭에서는 0 이므로 **여러 폭을 재야 보인다**.
  · 수정은 **`min-width: 0` 과 `.vc-card .muted { overflow-wrap: anywhere }` 둘 다** 필요하다 —
    전자만 두면 텍스트가 카드를 넘쳐 잘리고, 후자만 두면 `auto` 트랙이 여전히 max-content 다.
  · ⚠ `overflow-wrap: anywhere` 는 **설명문 전용**이다. 숫자 칸에 걸면 `63.6 GB` 가 `63.6/GB` 로
    쪼개진다(v2.525 `.rpt-wrap` 실제 사고).
  · 함께 고친 표 3곳 — `DatastoreUsage.DsVcTable`(400px **201px** 넘침 · 한 화면에 11개) ·
    `RelayTopoTool` 2곳(**613px**). 6열이어도 `minWidth` 가 없으면 넘친다(v2.575 스윕은 7열
    이상만 봤다) — **열 수로 면제하지 말 것.**

- **로딩 표시의 '요청자' 는 서버가 기록한 로그인 계정이 먼저다**(v2.585, `perfClientLogic.requesterText` +
  `TaskWho.jsx`, 사용자 요청 "요청자 ID 가 포탈 내부에서 사용하는 ID 말고 job 을 실행한 사용자 ID 로 표시"):
  `GET /perf/req-status` 가 소유자 검사를 통과한 항목에 `user` 를 싣고, 서버 확인 전에는 이 브라우저의 로그인
  계정을 쓴다(요청은 이 탭이 보냈다). 둘 다 없으면 이름을 지어내지 않는다. ⚠ 내부 추적 ID(`w…-…`)는 **대체가
  아니라 보조**다 — 서버 성능 측정·라이브 로그와 대조하는 유일한 열쇠라 작게 남긴다(지우지 말 것).
- **Optimization(`#/tools/waste`) 화면은 시안 A 배치다 — 계산은 `views/tools/wasteViewText.js` 하나**(v2.651, 사용자 요청 "시안 A 적용해줘" —
  디자인 캔버스 `Optimization 시안`): 회수 가능 스토리지 = 꺼진 VM 점유(committed) + Thin 여유(uncommitted) — 겹치지 않는 두 양의 합이고 **추정**이라 적는다.
  꺼진 기간 분포는 `/tools/waste/off-since`(꺼진 VM 전량), 법인별 점유는 `byVcenter`(절단 전 전체) 기준 — 화면에 실린 상위 300대로 세지 말 것
  (부분 합이 된다). 기간 칩의 **표 필터**는 표시 목록 기준이라 개수와 다를 수 있다(문구가 '표시 목록 N대 중' 으로 말한다). 0 인 분포 칸은 중립색(`zero`).
  탭 주소(`#/tools/waste/<탭>`)·검색·엑셀 내보내기·근거 리포트·스파크라인은 그대로다. '확인 필요 후보 · 포탈은 VM 을 지우지 않습니다' 안내를 지우지 말 것(v2.505 규약).
- **ESXi 호스트(`#/hosts`) 화면은 시안 B '이상 우선' 배치다 — 판정은 `views/hostTriage.js` 하나**(v2.764, 사용자 요청 "B 안으로 해줘" — 디자인 캔버스 `ESXi 호스트 화면 시안`):
  확인 대상 = 점검 + 끊김·무응답 + **CPU > 90**(서버 high-cpu 경보와 같은 기준 — 사용자 선택, `hostTriage.test.js` 가 soapClient 의 비교식과 대조한다). 상단 카드 숫자·표 탭·구간 막대·클러스터 타일은
  전부 같은 `hostReasons`/`cpuBucket` 을 쓴다 — 화면에서 따로 세지 말 것. 사용률은 `hostUsagePct` 로 읽고 못 읽은 호스트는 '미수집' 구간(0% 아님)·평균 제외.
  CPU % 는 정격 용량 대비라 100 을 넘으므로 '100% 초과' 를 별도 구간으로 둔다. 클러스터 키는 (vCenter, 클러스터)다(동명 클러스터 분리). 예전 KPI 카드 6장의 값(전원 On/Off·코어·vCore 비율·메모리·전력·ESXi 버전)은
  요약 띠로 옮겼을 뿐 빼지 않았다. 타일은 1440 에서 12개·720px 이하 4개부터(400px 에서 표까지 스크롤이 길었다 — Chromium 판독).
- **v2.805 — ESXi 호스트 화면의 '엑셀 수준 상세'(승인 시안 https://claude.ai/artifact/EFh5K3UDzuGpUpqVyqXPf1)** — 요약 8칸 · '지금 확인할 것' 카드 3 + 칩 10 · 호스트 목록 표 30열 9묶음 · 전체 페이지 상세(사용자 선택). 회귀 `hostChecksText.test.js` + `server/test/hostChecks2805.test.js`:
  · 판정은 셋뿐이다 — 확인 대상(카드·탭)은 `hostTriage.js` 그대로, 구성·보안(열·칩 코드)은 `hostcfg/hostCfgText.js hostCfgFindings`, iDRAC 부품·최근 재부팅·Veeam·VM 할당 합은 서버
    `GET /hosts/checks`(`vcenter/hostChecks.js` — 호스트·클러스터 엑셀과 같은 함수 `hwSummary`·`analyzeReboots`·`recentBackupYn`). 화면에서 따로 세지 말 것. 칩 수는 그 묶음을 못 읽었으면 **null('—')** 이지 0 이 아니다.
  · `/hosts/checks` 는 무거운 집계(로그 DB·iDRAC 등록부·Veeam 대조 — 서버 60초 캐시, 범위·판본 키)라 **마운트 1회 + 필터 변경 + '다시 읽기' 버튼**만 — 15초 폴링(/hosts)에 섞지 말 것.
    묶음 권한은 엑셀과 같은 `accessOf`(구성 점검 도구 → 재부팅 · 관리자 판본 → iDRAC) — 권한 없는 묶음은 키 자체가 없고 iDRAC 열은 그때 빠진다.
  · 열 묶음 끄기는 `localStorage ui.hosts.cols`(try/catch · 모르는 키는 버림) — '기본' 묶음은 끌 수 없다. 표는 `DataTable` + `.ht-table`(첫 열 sticky · nowrap · 래퍼가 스크롤 컨테이너).
  · 상세는 `#/hosts/<id>`(Hosts.jsx 가 해시 둘째 조각으로 가른다 — 탭 id 는 그대로 `hosts`). **모달과 같은 구성요소**(`EntityDetail.jsx` 의 `HostBasicRows`·`HostCfgSection`·`PerfcSection`·
    `ClusterCfgSection`·`HostHbaTable` + `HostGpuPanel`·`HostPowerPanel`·`HostMetricButton`·`IdracTrendLinkButton`·`HostVmsModal`)를 export 해 쓴다 — 화면을 복제하지 않는다. 호스트 한 대는
    `GET /hosts/:id`(범위 밖 404 — `/hosts/checks` 를 먼저 등록해 'checks' 가 id 로 잡히지 않게). 정직 기록: 목 데이터 호스트는 NIC 인벤토리가 없어 네트워크 표는 '없음' 문구만 봤다.
- **v2.811 — ESXi 호스트 화면의 '법인별' 보기(승인 시안 B https://claude.ai/artifact/JGykMmoG7kAyNsa5y4uG1x)** — 사용자 선택 2026-10-28: 서버 집계 API 신설 · 시안 판정 그대로 ·
  기본 정렬 리전 › 이름 · 같은 화면의 '호스트별 | 법인별' 전환(`localStorage dvc.hosts.view`). 회귀 `hostCorpText.test.js` + `server/test/hostCorp2811.test.js`:
  · 숫자·판정(법인 위험/주의/모름 · 확인 사유 · CPU 구간 · 여유 메모리 · 과할당 비율)은 서버 `GET /hosts/corp`(`vcenter/hostCorp.js` 순수) 하나 — 화면에서 다시 세지 말 것.
    CPU 구간 경계는 웹 `hostTriage.cpuBucket` 과 두 벌이라 서버 테스트가 같은 입력으로 대조한다. N+1 은 '인사이트' 와 같은 `clustercfg/n1.js n1Groups`(v2.811 에 옮겼다).
  · 클러스터 구성(HA·수용 제어·DRS·EVC)·N+1 은 '클러스터 HA·DRS 점검' 과 같은 권한(`accessOf().cluster`)일 때만 응답에 실린다 — 없으면 키 자체가 없고 화면은 그 열을 뺀다.
  · RTT 는 핑 모니터가 저장한 vCenter 대상의 마지막 값이다(요청마다 실시간 측정 금지 — `/tools/network-check` 는 최대 5초 프로브). 30분보다 오래된 값은 흐리게.
  · 호스트를 모르는 법인(첫 수집 중·비활성·이월 값 없는 연결 실패)은 개수를 null('—')로 둔다 — 표지는 `corpSiteStatus` 그대로. 요약 합에서는 빼고 '미수집 N곳 제외' 를 밝힌다.
  · 과할당 비율은 용량(코어·메모리)을 하나라도 못 읽은 법인·클러스터에서 null — 분자만 남은 비율 금지(`toolsCapacity` 와 같은 규칙). vCPU 합은 템플릿 제외(`vmSumsOf`).
  · 표는 `STable`(법인 열 sticky · `data-sort` 로 null 뒤로). 패널은 콘텐츠가 넓을 때(창 1600px 이상)만 표 옆, 그보다 좁으면 표 아래로 내려가고 행을 고르면 그 패널로 스크롤한다.
    펼친 클러스터의 호스트 표는 `limit` 8 + '호스트 N대 모두 보기 — 호스트별 보기로'(그 클러스터 focus 로 내려간다).
- ⚠⚠ **v2.708 — 드롭다운은 공용 `Select`·`DataList` 하나다(자동 정렬)**(`web/src/components/`{Select.jsx,DataList.jsx,selectSort.js}, 사용자 요청 "모든 드랍박스 메뉴를 소팅되서 보이게 하고 앞으로 만들면 소팅"):
  · 날 `<select>`·`<datalist>` 는 eslint `no-restricted-syntax` 와 `selectSort.test.js` 스윕이 막는다. 선택지는 보이는 글자 순(숫자 인식 — vcenter-2 < vcenter-10),
    value ''·'all'·'*'·'__…' 이거나 글자가 '전체·모든·—·(·선택' 으로 시작하거나 `data-pin` 이면 맨 위 고정.
  · **순서가 곧 뜻인 목록**(기간·심각도·단계·권장 먼저·최신 버전 먼저·폴링 중 에이전트 먼저)은 `sort={false}` — 데이터 목록에 붙이지 말 것(사용자 선택 '의미 순서 유지').
- ⚠⚠ **특수 기능 화면(v2.679) — 표시 이름·설명·개발 단계는 '덮어쓰기' 이고 키는 그대로다**(`server/src/toolcats/`{catalog,settings}.js +
  웹 `views/toolSections.js applyOverrides·buildStageSections·introLine` + `views/ToolNamesStages.jsx`(드로어·설정 화면 공용) + `SpecialTools.jsx`,
  사용자 제공 핸드오프 '특수 기능 화면 재구성'. 회귀 `server/test/toolNames2679.test.js` + 웹 `toolSections.test.js`):
  · 설정 파일은 기존 `tool-categories.json` 에 `stages`(null = 단계 축 꺼짐 — **업그레이드로 자동으로 켜지지 않는다**) · `overrides`(키 → label/desc/stage,
    빈 값은 키를 지운다) · `stageDisplay`(badge|suffix). 단계 색은 `STAGE_COLORS` 팔레트만(서버 400) — 임의 문자열이 style 로 들어가지 않게.
  · 첫 단계가 기본값 — 없는 단계를 가리키면 화면은 기본 단계로 본다(서버는 저장 때 그 stage 를 지우고 경고). 단계 축을 끄면(null) 지정은 남긴다.
  · 카테고리 저장(PUT 에 overrides·stages 없음)은 덮어쓰기를 건드리지 않는다 — `Object.hasOwn(body, …)` 일 때만 바꾼다(테스트 고정).
  · 바꾼 이름은 특수 기능 화면·도구 제목에만 쓴다. ⌘K 팔레트는 원래 이름이다(드로어 안내가 말한다). 원래 이름은 `aka` 로 검색된다.
  · 분류 바 sticky top = 셸 머리 실제 높이 + 8px(ResizeObserver) · 720px 이하는 고정하지 않는다(탭이 여러 줄이라 400px 화면의 1/3 을 가렸다 — Chromium 판독).
  · v2.810: 화면 안 sticky 바의 높이 측정은 `web/src/hooks/useStickyOffset.js` 하나(셸 머리 `useStickyHeadH` · 바 `useBoxHeight` — 셸 머리 선택자 사본 금지).
    Veeam 백업 현황 › Detail 의 일괄 표시 바(`.bk-bulk`)도 같은 규칙 — 머리 아래 sticky · 불투명 배경 · 옆 상세 칸(`.bk-side`)은 바 아래 · 720px 이하 고정 안 함.
    회귀 `web/src/views/tools/bulkSticky2810.test.js`.
- **접속 공지 팝업 · 게시판(v2.722)** — `server/src/bulletin/store.js`(notices.json·board.json, 원자 쓰기·손상 보존·상한 거부) + `routes/api/bulletin.js`
  (`/notices/*`·`/board/*`, 회귀 `server/test/bulletin2722.test.js` — 실제 api 라우터로 역할별 상태코드) + 웹 `views/board/`{Board.jsx,NoticePopup.jsx,bulletinText.js}:
  · 팝업은 **로그인 뒤에만**(App 의 `<Portal>` 옆 — 모든 셸 위) · 폴링 없음 · '보지 않기' 는 브라우저 저장이고 키가 `rev`(id + 수정 시각)라 고치면 다시 보인다.
  · 쓰기 권한: 공지 = admin + 전체 범위 · 글·댓글 = admin·operator(서버 불변조건 '/api 상태변경은 requireRole(admin, operator)') · 수정·삭제 = 작성자 또는 관리자 · 고정 = 관리자.
  · 상단 탭 'board' 를 더하면 V5 `tree.js`(TAB_NAMES·platform) · V6 `menus.js`(TAB_INFO·platform) · `noFilterTabs` 도 함께. 1600px 한 줄 메뉴는 14개에서도 잘리지 않았다(실측 nav scrollWidth == clientWidth).
- **이슈 트래커(v2.864)** — `server/src/issues/store.js`(issues.json · 게시판과 같은 디바운스 비동기 원자 쓰기·손상 보존·합계 상한 `ISSUES_MAX_BYTES`) + `routes/api/issues.js`(`/issues*`, 회귀 `server/test/issues2864.test.js` — 실제 api 라우터로 역할별 상태코드) + 웹 `views/issues/`{Issues.jsx,issueText.js}. 디자인 시안: Claude Design 캔버스 https://claude.ai/artifact/DhvGAynr761G6y3arqqU8R:
  · 전이 규칙은 서버가 판정한다 — '진행 중' 은 담당자 필수(400) · 보류는 사유 필수 · 완료는 `closedAt`. 화면은 거부 사유를 그대로 보인다(두 벌 판정 금지).
  · 쓰기 권한: 생성·수정·상태·할당·댓글 = admin·operator(협업 도구라 남의 이슈도 고친다) · 삭제 = 본인 또는 **전체 범위** 관리자(게시판 `isBoardModerator` 와 같은 기준). 담당자 후보(`people`)는 쓰기 계정에게만 — viewer 에게 계정명 목록을 주지 않는다.
  · ⚠ `/issues/bulk/assign` 은 `/issues/:key/…` 보다 **먼저** 등록한다 — 뒤에 두면 'bulk' 가 키로 잡혀 404 다(초판 자체 테스트가 잡았다).
  · **v2.875(법인 축 · 알림 · 자동 할당 · 요청 등록 · 진행 공유)**: 이슈마다 `vcenterId`(''=공용). 범위 계정은 자기 법인 이슈만 보고 공용은 못 본다 — 조회 밖 404 → 쓰기 밖 403(`findFor` 하나).
    법인을 반드시 고르는 계정은 `meta.scoped || meta.writeScoped`(조회 무제한 + writeVcenters 도 공용 불가 — 화면 `vcenterRequired`). 목록 행·상세에 `writable` 을 실어 화면이 버튼·일괄 선택을 잠근다.
    '이 사람이 이 법인 이슈를 볼 수 있나' 는 `issues/visibility.js` 하나(자동 할당·알림 수신자). 로컬 계정은 그 범위로, 로컬이 아닌 이름은 AD(범위 축 없음 — `auth/ad.js`)로 본다.
    알림(`issues/notify.js`)은 사람별 1분 묶음 · 본인 제외 · 범위 밖 수신자 제외(`outOfScope`) · 멘션은 알려진 이름의 가장 긴 접두(`resolveMentions`) · 팀 채팅은 `chatSafe` 로 꺾쇠·대괄호를 바꿔 싣는다 ·
    이슈 메일은 메일 설정 시간당 한도의 절반까지(넘으면 미룸) · 기한 기록은 **보낸 뒤** 쓴다. 기한 판정은 날짜 기준(`store.dueDays` ↔ 웹 `dueInfo` — 대조 시험).
    요청 등록(viewer · `issues.request`)은 요청 유형·백로그만, 1인 열린 요청 20건 · 전체 상한 중 200건은 운영자 몫. 진행률은 0~100 정수 또는 null(‘보고 없음’ — 0 이 아니다).
    회귀 `server/test/issues2871.test.js`(변이 14/14).
  · **v2.880 자동 등록 이슈**: 출처(`origin` — 파트 장애)가 있는 이슈는 카드 · 목록 · 상세에 ‘자동’ 배지(`originText`)와 파트 장애 화면 링크.
    설정 › 자동 등록(`AutoCreateSettings`)은 서버가 준 지원 칸(`supported`)만 고를 수 있게 그린다('—' = 추출기 없음) · 시험 실행은 저장 전 화면 값을 보낸다(만들지 않는다).
    이슈 본문은 아직 마크다운을 그리지 않는다 — 서버가 만드는 본문에 '###' 같은 기호를 쓰지 않는다(위키 렌더러가 들어오면 같이 바꾼다).
- **게시판 답글·공감(v2.723)** — 답글은 댓글 배열에 `parentId`(최상위 댓글 id)로 묶는 **한 단계**다(답글에 단 답글은 최상위 아래로 옮기고 `replyTo`).
  답글이 달린 댓글을 지우면 **자리를 남기고**(`deleted` — 내용·작성자 지움, 세지 않음) 마지막 답글이 지워지면 자리도 치운다. 공감은 이름 목록 `likes` 이고
  요청은 상태를 명시한다(`POST …/like {on:true|false}` — 연타·재전송이 두 번 세지 않는다). 응답에는 개수·내 공감·앞 30명만(`likeView`) — `likes` 배열을 내보내지 말 것.
  공감·답글도 쓰기 권한(admin·operator, 서버 불변조건). 옛 board.json 은 그대로 읽힌다(필드 없음 = 공감 0·최상위). 회귀 `server/test/bulletin2723.test.js`(변이 3/3).
- **상단 메뉴에서 특수 기능으로 옮긴 화면은 옛 주소를 살린다**(v2.592 — 사용자 요청 "인싸이트를 특수기능으로
  이동해줘"): 상단 '인사이트' 탭(`views/Insights.jsx`, FinOps 등 7패널)은 특수 기능 카드 **`insights-hub`**
  (`#/tools/insights-hub/<패널>`)가 됐다. ⚠⚠ **기존 카드 `insights`(운영 인사이트 — `tools/InsightsThreats.jsx`)는
  다른 화면이다** — v2.592 초판이 둘을 같은 것으로 보고 옛 주소를 `#/tools/insights` 로 보냈다가 Chromium 판독에서
  엉뚱한 화면이 떠서 잡았다. 도구 키는 바꾸지 않으므로(`toolsDenied` 값) 새 키를 만들었다.
  · 옛 주소 `#/insights[/<패널>]` 는 `hooks/hashTab.js MOVED_TABS`·`movedTabHash` 가 `replaceState` 로 바꾼다
    (App 최초 렌더 + hashchange). **지우지 말 것** — 북마크·공유 링크가 있다. 옮긴 탭이 늘면 이 표에 더한다.
  · 탭 권한(`perm:'insights'`)은 카드의 `perm` 으로 옮겼다 — 데이터 API `/api/insights/*` 는 원래대로 requirePerm.

- **(v2.976) 집중 모니터링 화면**(`views/tools/FocusMonTool.jsx` · `focusMonText.js` · `focusMonChart.js` · `focusMon.css` · 시안 `docs/design/focus-mon`):
  - 주소 `#/tools/focus-mon[/compare|/procs|/targets]` · 서버 상세 `/server/<id>`. 폴링은 세대 번호로 늦은 응답을 버리고 · 가려지면 멈추고 · 403 · 404 면 멈춘다. 과거 구간은 한 번만 읽는다.
  - 비교 차트 색은 **고정한 서버에만**(최대 4 · 처음에는 높은 순 3대를 한 번 고정 — 그 뒤 순위가 바뀌어도 다시 칠하지 않는다) · 나머지는 회색. 수집 상태 이름은 서버 `STATES` 와 1:1(테스트).
  - 대상 표는 포트 · 계정을 주소 칸에, OS 를 키 로그인 칸에 합쳤다 — 따로 두면 1440px 에서 동작(시험 · 삭제) 열이 잘렸다(2026-11-11 화면 검증).
  - 표 안 추이선은 고정 폭(140px) — 표 칸의 width:100% 는 줄어들어 보이지 않는다.

- **(v2.977) 화면 조각 404 · 열 많은 표**:
  - 업그레이드는 설치 폴더를 통째로 바꾼다 — 열린 탭이 아직 안 연 메뉴를 누르면 옛 해시 청크가 404 다. React.lazy 는 실패한 약속을 기억해 '다시 시도' 로 풀리지 않는다.
    `chunkReload.js`(청크 오류 판정 · 같은 탭 60초에 한 번 자동 새로고침 · `vite:preloadError`) + ErrorBoundary 의 '새로고침' 단추. 새 lazy 화면을 만들 때 따로 할 일은 없다.
  - 1440px(사이드바 열림 · 칸 약 1,154px)에서 열이 가로 스크롤 뒤로 가면 결함이다. 먼저 긴 칸을 접고(whiteSpace normal + maxWidth), 그래도 안 되면 동작 · 상태처럼 꼭 보여야 할
    오른쪽 열을 고정한다(`styles.css .sm-pin-right` — 마지막 두 칸 sticky · colSpan 행 제외). 표 칸(td)에 `className="flex"` 를 직접 주지 말 것 — 칸이 플렉스 상자가 돼 줄 높이 · 테두리가 어긋난다(안에 div 로).

## 원래 루트 「프론트엔드 회귀 방지」 절


- ⚠⚠ **V4·V5·V6 셸은 지웠다 — 되살리거나 고치지 않는다**(v2.747, 2026-10-20 사용자 요청 "독립셀 version 4,5,6 은 삭제하고
  더이상 수정하거나 업데이트 하지 않도록 변경해줘, 그리고 설정에서 신규 포탈 보기 메뉴 삭제"): `web/src/version_{4,5,6}/` ·
  `views/V4Portal.jsx`(설정 › 신규 포탈 보기)를 지웠다. 화면은 **기본 셸(App 라우터) + 관제 콘솔(`console/`)** 둘이다.
  `server/test/v4Portal2508.test.js` 가 폴더 부활·옛 경로 import·설정 메뉴 부활을 막는다. 새 셸·새 틀을 만들지 말 것.
  - 기본 화면이 쓰던 모듈은 옮겨 살렸다: ⌘K 팔레트 `components/Palette.jsx`·`palette.js` · Overview 보기 모드 `views/overviewMode.js` ·
    로딩 판정 `components/loadState.js`(관제 콘솔) · Summary 기여도 `views/corpContribution.js`. V4·V5·V6 만 쓰던 함수는 함께 지웠다
    (`physicalServersKpi`·`corpTotalLabel`·`modeSpec`·`viewFromHash`·`liveText`·`shouldBanner`).
  - **옛 주소는 버리지 않는다**: `#/v3·#/v4·#/m/…` → `#/overview`, `#/v5/<주소>`·`#/v6/<주소>` → `#/<주소>` (`hooks/hashTab.js legacyShellHash`,
    App 의 `migrateMovedHash` 가 기동·hashchange 때 적용). 남은 셸 플래그 `localStorage ui.shell` 은 기동 시 지운다.
  - ⌘K 팔레트는 V4 메뉴 트리 없이 동작한다 — 분류명은 특수 기능 카테고리 설정(`/admin/tool-categories`, 카드 그리드와 같은 출처),
    탭은 App 의 `visibleTabs`(권한으로 거른 것)를 받는다. **새 도구를 추가할 때 고칠 트리가 없다**(V4·V5·V6 트리 배치 규칙은 폐기).
  - 셸이 사라져도 남는 규칙(v2.508 에서 정한 것):
    - **도구 키(`#/tools/<k>`) 는 어떤 이름 변경에도 바꾸지 않는다** — `permissions.json` 의 `toolsDenied` 값이자 `auth/toolAccess.js` 의
      집행 매핑이다. 옛 이름은 `specialToolsList.js` 의 **`aka` 배열**에 남긴다. 검색 매칭은 `views/toolSearch.js` 하나(카드 그리드 = ⌘K).
    - 새 도구는 `toolcats/catalog.js` 의 PRESET 도 채운다(빠지면 화면에서 '기타' 로 밀린다). 상태를 바꾸는 도구(rma·vm-clone·vmprovision·
      shutdown·diskadd·backup·massdeploy·agent-scans)는 PRESET 의 '운영 작업' 분류에 둔다.
    - **모드 토글은 권한이 아니다**(`views/overviewMode.js`): 권한·데이터 범위·임계값(75/90)은 두 보기가 같다. `localStorage` 는 try/catch.
    - **무거운 API 는 15초 폴링 금지**: `/tools/capacity-forecast`(실측 1.5초)는 120초 이상·마운트 시에만, 고아 VMDK 스캔(`/tools/orphan-vmdk`)은
      폴링 금지(버튼 + 재진입 가드). 목록(`/tools/orphan-vmdk/datastores`)은 스냅샷 memo 라 폴링해도 된다.
    - **'수집 대기' 로 뭉개지 말 것**(`components/loadState.js`, v2.509 — "기다리면 나오는거야?"): pending(기다리면 채워진다)과
      unreachable(기다려도 안 된다)을 합치지 않는다 · 타임아웃·연결 실패는 화면 전체 오류가 아니다(재시도 중) · 수집 주기 숫자를 문구에 박지 않는다.
    - **표 머리글에 영문 소문자 단위를 쓰지 말 것**(uppercase 셸 CSS 에서 `kWh` 가 `KWH` 로 샜다 — 한글 라벨 + 각주).
- **위임(엣지) 수집 환경에서 중앙 화면이 비면 안 된다**(v2.493, 2026-09-12 실제 신고 — 같은 유형이
  v2.381→2.383 에서 이미 한 번 발생했다): 위임 법인 서버는 중앙 레지스트리에 없고, 엣지가 export 로
  **최신 스냅샷만** 올려 보낸다(`collector/agent.js compactSensors` → 중앙 `collector/remoteInventory.js`).
  새 상세/조회 화면을 만들 때 `loadRegistry().find(...)` 로 못 찾으면 **빈 응답으로 끝내지 말고**
  `findRemoteServer(id)` 의 값을 쓸 것 — 이미 그 값을 쓰는 화면이 있는지 먼저 확인한다
  (`routes/admin/idracCore.js /idrac/temps` 의 `s.remote ? s.sensors : getSensorSeries(s.id).latest`,
  `idrac/roomTemp.js`). v2.493 은 iDRAC 상세 센서 탭이 이 확인을 빠뜨려, **같은 서버가 '법인별 온도'
  에서는 52℃ 로 보이는데 상세에서는 '센서 0개·0샘플'** 로 보이던 결함을 고친 것이다. 중앙에 이력이
  없으면 `seriesAvailable:false` 로 밝히고 최신값만 표로 보여준다 — 없는 이력을 1점 차트로 지어내지 않는다.
- **값이 없는 이유를 단정하지 말 것**(같은 v2.493 건): '텔레메트리 미지원' 처럼 원인을 특정하는 문구는
  그 원인을 실제로 확인했을 때만 쓴다. 표본이 0건인 것과 '표본은 있는데 그 지표만 없는 것' 은 다르고,
  조회 실패(404/403)와 '수집 0' 도 다르다. 네 경우를 구분하는 판정은 순수 모듈에 두고 테스트로 고정한다
  (`web/src/views/idrac/sensorText.js`). 조회 오류를 `.catch(() => {})` 로 삼키면 사용자는 원인을 알 수 없다.
- **수집 주기·상한 같은 숫자는 화면에 하드코딩하지 말 것**: API 가 실제 값(`intervalMs` 등)을 주면 그것을
  쓴다. v2.493 까지 센서 탭은 '1분 간격' 을 고정 문자열로 표시해, 주기를 바꾸면 문구가 사실과 달라졌다.

- **스토리지 장비 표의 '장비' 열은 `장비가 보고한 이름` 이 먼저다**(`views/tools/StorageMonTool.jsx`
  `Cell 'device'` + `storageColumns.js sortValue`, v2.530 — 사용자 요청 "'장비' 에 들어가는 데이터를
  hostname 에서 획득한 장비 명을 넣어줘"): Isilon 은 `isi status` 의 클러스터 이름, Unity/PowerStore 는
  시스템·클러스터 이름 — 현장 콘솔에 찍히는 그 이름이다.
  - ⚠ **이것은 v2.515 와 반대 방향이다.** v2.514 까지 스냅샷 이름이 우선이었고, 그래서 '수정' 폼에서
    이름을 고쳐 저장해도 표가 그대로라 사용자가 **"수정하는데 수정사항이 반영되지 않는다"** 고
    신고했다(저장은 성공했다). 원인은 순서가 아니라 **고친 값이 화면 어디에도 안 보였던 것**이다.
    그래서 등록 표시명이 다르면 둘째 줄에 **`등록명 …` 이라고 라벨을 붙여** 보여준다 —
    **이 둘째 줄을 지우면 v2.515 결함이 그대로 되살아난다.**
  - **정렬 값(`sortValue('device')`)을 같은 순서로 유지할 것** — 보이는 글자와 정렬 기준이 어긋나면
    사용자가 '정렬이 틀렸다' 고 본다.
  - **두 줄 모두 폭을 `maxWidth:150` + 말줄임으로 묶는다**(실측: 25자 이름에서 장비 열이
    101→195px). 묶지 않으면 표가 밀려 오른쪽 '작업' 열이 잘린다(v2.403 이 고쳤던 문제의 재발).
    전체 문자열은 `title` 로 남긴다.

- **긴 작업의 '진행 중' 잠금은 그 대상만 잠근다 — 화면 전체를 잠그지 말 것**(v2.529 사용자 신고
  "이 상태에서 수정 버튼 누르면 수정 창이 안떠", `views/tools/StorageMonTool.jsx`):
  스토리지 장비 표의 `수집`·`수정`·`삭제` 가 전부 **전역 `busy`** 로 잠겨 있었다. 한 장비를
  수집하는 동안 **다른 장비의 수정·삭제까지** 죽었고, **왜 안 눌리는지 화면이 말하지 않았다**
  (툴팁도 없어 '버튼이 고장난 것' 으로 보인다). Unity 수집이 v2.526(명령 24개)·v2.528(예산 150초)
  이후 최대 2분을 넘기면서 그 창이 몇 초 → 수 분으로 늘어 드러났다.
  - **'지금 수집' 은 `busyId`(그 장비)만 잠근다.** 전역 `busy` 는 전체 새로고침처럼 **진짜 전역**
    작업에만 쓴다. 버튼 글자를 `수집 중…` 으로 바꿔 무엇이 도는지 보이게 한다.
  - **`수정` 은 잠그지 않는다** — 인증 실패·수집 실패 상황에서 **자격증명을 고치는 것이 바로 그
    순간 필요한 조치**다. 그것을 막으면 사용자는 복구할 길이 없다.
  - **잠긴 버튼은 사유를 말한다**(`title`). 반응 없는 버튼은 '고장' 으로 읽힌다.
  - 같은 패턴을 쓰는 다른 표(SAN 스위치·PDU 등)를 만들 때도 **전역 잠금을 기본으로 삼지 말 것**.

- **법인 전산실 운영 온도는 '보기 전환' 화면이다**(`web/src/views/tools/RoomTemp.jsx` +
  순수 모듈 `roomTempView.js` + 서버 `idrac/roomTempSeries.js roomTempSparks`, v2.534 —
  사용자 제공 클로드 디자인 캔버스 '온도 시각화 10안' 의 **적용안 `2a`**):
  - **범위 플롯 / 매트릭스 / 상황실 월보드** 세 가지를 한 페이지에서 토글한다. 플롯·월보드에서
    법인을 누르면 매트릭스로 넘어가 **흡기 높은 서버 상위 6대**가 펼쳐진다.
  - ★ **판정은 흡기 최고값만** 쓴다(v2.381 부터의 규약). 배기·CPU 는 장비·부하에 따라 정상 범위가
    달라 **임계를 정하지 않고** 값과 **열 안에서의 상대 농도**로만 칠한다 — 두 색 체계를 섞지 말 것
    (상태색은 **판정**, 농도는 **비교**다). 흡기 열에 농도를 쓰면 판정이 사라진다.
  - ★ **흡기를 못 읽은 법인은 `ok` 가 아니라 '판정 불가'(회색)** 다. 월보드 카운트에서도
    `unknown` 을 정상에 흡수하지 않는다(v2.519·v2.523 규약과 같다 — 확인 못 한 것을 이상 없음으로
    칠하는 것이 이 화면이 만들 수 있는 가장 위험한 거짓이다).
  - ⚠ **값이 없으면 단위를 붙이지 말 것** — 월보드 타일이 `— ℃` 로 나오면 0℃ 처럼 읽힌다
    (v2.534 스크린샷 판독에서 발견해 고친 결함. 수치로는 안 잡혔다).
  - ⚠ **'상위 N대' 라고 적었으면 N행이 전부 보이는 높이여야 한다** — `maxHeight:240` 에서 6번째
    행이 잘려 '6대' 라고 해 놓고 5행만 보였다(같은 판독에서 발견).
  - **월보드 스파크라인은 폴링하지 않는다** — 보기를 열 때 `/admin/room-temp/spark` 를 **1회**
    부른다(법인 집합이 바뀔 때만 재조회). **1시간 버킷**만 써서 `samples_hourly` 롤업이 걸리게
    한다 — 법인마다 인덱스 선탐색이라 16곳도 가볍다(CLAUDE.md v2.503: '전 키 1쿼리' 로 합치면
    오히려 느려진다).
  - ⚠ **수집이 없던 시간은 선을 잇지 않는다**(`sparkPath` 가 subpath 를 끊는다). 이으면 그 시간도
    값이 있던 것처럼 보인다. 그리고 `p.avg == null` 을 **먼저** 본다 — `Number(null) === 0` 이라
    `Number.isFinite(Number(v))` 만 보면 결측이 **0℃ 로 둔갑**한다(v2.525 규약. 초판이 실제로
    그랬고 자체 테스트가 잡아냈다).
  - 전체 화면은 **Esc 로 닫힌다** — 버튼만 두면 키보드 사용자가 갇힌다.

- **React 훅은 조기 return 위에서 선언**: `if (!data) return <Loading/>` 같은 조기 반환 뒤에 `useState`를
  추가하면 렌더 간 훅 개수가 달라져 **React #310으로 화면 전체가 크래시**한다(v2.202 사용자 관리에서 실제
  발생 → v2.203 긴급 수정). 뷰에 상태를 추가할 때는 항상 컴포넌트 최상단에 선언할 것.
- **권한 거부(403)는 '오류'로 표시하지 않는다**(v2.398): 403 은 장애가 아니라 정책대로 동작한
  접근 제어다. "오류: forbidden" 으로 보여주면 사용자가 시스템 장애로 오해해 새로고침·재로그인을
  반복하고 장애 문의를 올린다. 공용 `ErrorBox`(오류 표시 단일 지점 — 86개 파일·132곳)가 403 을
  감지해 `components/AccessDenied.jsx`(필요 권한·부여 방법·관리자 요청 문구)로 자동 전환하므로
  **뷰에서 따로 처리할 필요 없다**. 유지 규칙:
  - `api.js` 의 실패 경로는 반드시 `httpFail()` 로 `HttpError`(status·requiredRole/Perm/Owner)를
    던진다. `new Error(reason)` 으로 되돌리면 403 메타데이터가 사라져 안내가 범용 문구로 퇴화한다.
  - 서버에서 새 권한 게이트를 만들 때는 기존 응답 형태를 유지할 것 —
    `{error:'forbidden', requiredRole|requiredPerm}` 또는 `{requiredOwner:true, reason}`.
    이 키가 없으면 화면이 '데이터 범위 제한'으로만 안내한다(틀리진 않지만 부정확).
  - `usePolling` 은 403 을 받으면 그 (path,params) 폴링을 **중단**한다 — 정책 거부는 재시도해도
    결과가 같고, 15초마다 같은 403 을 만드는 것은 서버 로그·감사만 오염시킨다.
  - 문구 로직은 `components/accessDeniedText.js`(순수 함수)에 둔다 — 웹 테스트가 node 환경
    (DOM 없음)이라 컴포넌트 렌더 테스트가 불가하므로 판정·문구는 여기서 회귀로 고정한다.

- **엣지 토큰 맞추기는 독립 도구(`edge-tokens`)이자 공통 메뉴(설정 그룹) 항목이다**(v2.827 — 사용자 요청 "독립적인 메뉴 · 기존 메뉴에서 추출해서 공통 메뉴로").
  화면은 `views/EdgeTokenSync.jsx` 하나(설정 하위 탭 v2.825 에서 추출 — 복제하지 않는다). 등록 지점은 `specialToolsList.js`(adminOnly · aka) ·
  `SpecialTools.jsx` 렌더 · `toolcats/catalog.js` '운영 작업' · `topMenu.js` 설정 그룹 `{tool:'edge-tokens'}` · `auth/toolAccess.js TOOL_ENFORCEMENT_NOTES`
  (전용 /api/tools 경로가 없고 /api/admin/* 라우터가 집행) · `web/public/special-tools.json` 재생성. 옛 주소 `#/settings/edge-tokens` 는
  `hooks/hashTab.js MOVED_SUBS`(두 조각 이동 규칙 — 첫 조각 `settings` 는 살아 있는 화면이라 MOVED_TABS 에 넣을 수 없다)가 새 주소로 보낸다.
  하위 탭 주소를 통째로 옮길 때는 같은 방식으로 적고 `hashTab.test.js` 에 고정한다.
- **Backup 현황은 큰 탭 4개(Summary · Detail · Veeam · Bareos)다**(v2.835 — 사용자 요청 '백업 메뉴 개편'). Veeam 은 하위 탭(서버 · EM · 라이선스 / 백업 실행 — `VeeamHeader.jsx veeamSubTabs`)이고
  도구 키(`backup-em`·`backup-run`)는 바꾸지 않았다. **백업 정책(사람이 정한 값)과 실제 백업(포탈이 읽은 것)을 한 칸에 섞지 않는다** — 판정은 서버 `veeam/backupPolicy.js` 하나,
  웹은 받은 `p a mm lok` 을 그린다. Summary · Detail 에 Clone·스냅샷 문구·기능을 다시 넣지 말 것(`backupPolicy2835.test.js` · `backupSummary2836.test.js`). 기록은 `docs/rules/audits.md` v2.835 · v2.836.
  v2.836 Summary 의 법인 › 폴더 › VM 트리는 법인 줄 = 서버 집계(`veeam/backupSummaryAgg.js`), 폴더·VM = 그 법인의 Detail 응답을 `buildTree` 로 — Summary 에서 따로 판정하지 말 것.
  v2.837 Summary 의 선택은 **한 법인 안에서만**(트리 · 찾기 결과가 한 선택 — 다른 법인 칸은 막는다) · 쓰기 가능은 서버 법인 줄 `w` 로만(캐시 키 `writeKeyOf`) · 자료가 없는 칸은 지어내지 않고 출처를 밝히거나 '—(2차)'.
  v2.838 Summary 아래 두 구획(용량과 일정 · 통합 에러 로그)은 **무거운 집계라 폴링하지 않는다**(처음 · 기간 · 새로고침) · 자료가 없는 칸은 출처를 밝히고 '—(2차)' — 30일 선은 'Veeam 저장소 사용(EM)' 이지 백업 용량 추이가 아니다 · 열기 링크는 권한이 없으면 그리지 않는다(`backupSummaryPlan.errorOpen`).
  v2.839 Bareos '정책 · 일정'(`#/tools/bareos-summary/policy` — 조회 전용 키 아래 하위 탭 · `useHashTab`)은 **수집 중일 때만** 5초 뒤 다시 읽는다(평소 폴링 없음) · 기본 `tbody td` 는 nowrap 이라 긴 칸은 `WRAPBOX`(whiteSpace normal + 최대 폭)로 감싼다 — 안 그러면 옆 칸을 덮는다(Chromium 1440 확인) · JobDefs 빈 칸은 '기본'.
  v2.840 '보존 · 풀'(`#/tools/bareos-summary/pools` — 같은 키 · 폴링 없음)의 볼륨 즉시 조회는 서버 `canQuery` + `toolAllowed('bareos-backup')` 둘 다일 때만 버튼 · 관리 도구 탭 줄(BareosBackupTool)에도 정책 · 일정 · 보존 · 풀 링크를 백업 그룹 뒤에 둔다(bareosSubTabs 와 같은 순서 — 2.839 에 빠졌었다) · 기존 표의 칸에 줄을 더할 때는 그 칸을 원래 폭 안에서 줄바꿈시킨다(nowrap 한 줄이 길어지면 표가 넓어진다 — 백업 대상 표 A/B 로 확인).
- **v2.858 — Bareos 실행 중 작업 상세(승인 시안 — 진행 현황 › 단일 법인 행 펼침 · 실행 현황 · 이력의 상자 격자를 표 + 고른 작업 상세로)**. 회귀 `web/.../bareosRunDetail2858.test.js` + `server/test/bareosRunDetail2858.test.js`:
  ① 상세는 **한 조각**(`BareosRunDetail.jsx`)을 두 화면이 쓴다 — 복제하지 말 것. 판정(추정 진척 기준 · 남은 시간 · 지금 단계 · 원장+진행 행 합치기 · 대기 사유 요약)은 `bareosLiveText.js` 하나.
  ② 추정 진척 기준 = 지난 같은 레벨 성공 실행의 바이트(서버 `bareosLive.prevSameLevel` — 원장 `finishedRuns` 가 v2.858 부터 bytes·startedAt 를 남긴다) → 없으면 **Full 만** VM 용량 → 그 밖은 % 를 만들지 않는다(Incremental 을 VM 용량으로 나눈 2% 는 뜻이 없다).
  ③ 잡 로그는 **펼칠 때 한 번 + '로그 다시 읽기'**(Director 조회 — 진행 현황이 15초마다 와도 다시 읽지 않는다). 로그 시각(Director 현지 글)은 브라우저 시각과 빼지 않는다 — 지금 단계 구간은 끝이 열린 막대로 그린다.
  ④ 저장한 양 · 압축 · 쓰는 중 볼륨 크기는 잡 끝 보고에만 있다 — '끝나면 표시'(점선 칸). FD 보고가 없으면 진행량 · 속도 · 진척 · 남은 시간은 '모름'/'—'(0 아님)이고 타임라인 · 볼륨은 로그로 채운다.
  ⑤ 진행 현황 표 안의 펼침 칸은 `position: sticky; left: 0` + **실측 폭**(ResizeObserver) — 400px 에서 넓은 표(minWidth 1100)를 가로로 밀어도 상세는 화면 안. 정렬 때 행과 펼침 칸이 떨어지지 않게 `React.Fragment` 로 묶는다(`sortChildren` 이 첫 tr 로 정렬).
  ⑥ 대기 배지는 회색(실행 중 파랑과 구분 — `bareosText.STATE_BADGE`). 상세에 취소 단추는 두지 않았다(백업 대상 탭). 데모 실행 길이는 env `BAREOS_DEMO_RUN_MS`(화면 검증용 — 기본 30초는 진행 현황 조회 주기보다 짧다).
  ⑨ v2.866(사용자 요청 '진행 중인 백업 VM 이 자동으로 선택되게'): 아래 카탈로그 최근 실행 표의 대상은 처음에 진행 중 VM 이고, 위 실행 중 표에서 골라진(기본: 실행 중) 작업 VM 을 따라간다(`historyFollowTarget`) ·
     사람이 대상 칸을 직접 바꾸면 따라가지 않고, 위 표의 행을 누르면 다시 따라간다 · Director 거르기 밖 VM 이면 바꾸지 않는다.
- **v2.860 — Bareos 화면 재구성(사용자 요청 'Bareos UI 전폭 개선 · 직관적이고 복잡하지 않게' · 승인 시안 `docs/design/bareos-ui-v2` ⓪~⑥)**. 도구 키 3개(`bareos-summary`·`bareos-detail`·`bareos-backup`)와 권한은 그대로이고 탭은 주소만 바꾼다:
  ① 탭은 5개(현황 · 법인 · 운영 · 정책 · 보존 · 설정) — 판정은 `bareosViewText.bareosSubTabs` 하나, 그리는 곳은 `BareosTabs.jsx` 하나(모든 Bareos 화면이 같은 자리 · 오른쪽 `right` 칸에 그 화면의 조작). 두 벌 탭 줄을 되살리지 말 것.
  ② 운영 안 묶음(백업 대상 · 백업 그룹 · 진행 · 이력)은 `OPS_SEGMENTS`. 옛 하위 주소 `live`·`history` 는 `legacyOpsHash` 로 `runs` 로 바꾼다 — **렌더 중에** 바꾼다(효과에서 바꾸면 자식인 현황판이 옛 주소를 먼저 읽어 보기를 잃는다) · 아래 조각 유지(`live/corp` → `runs/corp`) · 옛 진행 현황 링크로 오면 현황판을 펼친 채로(`runsBoardOpen` — 처음 그릴 때는 바꾸기 전 주소, 떠 있는 동안 들어온 주소는 **hashchange 의 `newURL`** 로 본다: 앞 리스너의 갱신이 먼저 그려지면 부모가 주소를 이미 runs 로 바꿔 놓아 `location.hash` 로는 놓친다 — Chromium 재현). 다른 화면의 `/live`·`/history` 링크는 고치지 않아도 된다(`backupSummary2838` 이 옛 주소를 고정).
  ③ 현황판(`BareosLiveTab`)은 보기 주소의 마지막 조각을 부르는 쪽이 준다(`hashSub` — 진행 · 이력 안에서는 `runs` · `useHashTab({ base: ['tools', …` 글자 모양은 CATALOG2613-06 스윕이 고정). 펼친 동안만 Director 에 묻는 규칙 그대로 · 접으면 주소에서 보기를 뗀다.
  ④ 백업 대상은 표 + 오른쪽 패널(동작 · 상세). 패널이 열리면 표 폭이 800px 안팎이라 **표 칸에 긴 문구를 넣지 않는다** — 위치는 VM 칸 둘째 줄, 정책은 `targetPolicyShort`(다음 실행 또는 판정)이고 전체 문구 `targetPolicyText` 는 칸 title · 패널(Chromium 1440 에서 6칸 · 전체 문구일 때 용량 칸이 가로 스크롤 뒤로 숨었다).
  ⑤ 정책 · 보존은 `BareosPolicyPage` 한 화면에 두 구획(`BareosPolicyTab`·`BareosPoolsTab` 의 `bare`) — 'Director 수집 상태' 표 · 데모 안내는 한 번만. 옛 `#/tools/bareos-summary/pools` 는 풀 구획으로 내려간다.
  ⑥ 설정은 왼쪽 목록(`#/tools/bareos-backup/settings/<director|install|corp|accounts|defaults>` — `useHashTab` 중첩 base). 데모일 때 운영 머리의 Director 한 줄은 설정에서 빼고 설정 화면의 안내 하나만 둔다.
  ⑦ 공용 조각은 `BareosBits.jsx`(Note · ReadGuide · Stat · Dot · ResultBar · Segs · FilterChip) — 칸 설명 · 범례는 '읽는 법' 토글로 치우되 지우지 않는다. '확인 필요' 는 실패 · 미등록 · 오래됨 · 켜진 잡의 백업 없음을 합친 것이고 결과를 못 읽으면 '—'(`corpAttention`·`detailFilterCounts`).
  ⑧ (v2.882.1 — 사용자 요청 '1440 패널 닫기 줄바꿈도 고쳐줘') 오른쪽 패널 머리 줄은 **바깥 줄 줄바꿈 없음**(`data-panel-head`) + 이름 · 배지는 안쪽 묶음(`minWidth: 0`)에서만 줄바꿈 + 닫기는 묶음 밖(`flex: 'none'`). 한 줄 `flexWrap` + `marginLeft: 'auto'` 로 되돌리면 1440(패널 폭 약 320px)에서 이름 + 실행 배지 + OS 배지가 넘칠 때 닫기가 둘째 줄로 내려간다(Chromium A/B · 회귀 `bareosPanelHead2882.test.js`). 머리 줄에 칩을 더하지 말 것 — 멈추는 중(v2.867) · GPU 표지(v2.873)는 따로 한 줄이다.
- **v2.861 — Bareos 운영 › 복원(사용자 요청 '백업처럼 폴더에서 선택해서 복원' · '네트워크 연결 끊고 시작' · '데이터스토어 선택' — 시안 ⑦~⑪)**. 화면 `BareosRestore.jsx` · 글자 · 빠른 확인 `bareosRestoreText.js`(+ test):
  ① 판정은 서버 `bulkRestorePlan` 하나 — 화면은 같은 규칙을 먼저 말할 뿐(`wizardIssue`) · 3단계 미리 보기는 POST `restore-check/bulk`(Director · OTP 안 씀). 고르기는 **한 법인(Director)만 · 50대**(`pickBlock`) · 덮어쓰기는 1대일 때만 목록에 나온다.
  ② 복원 지점 · 실행은 Director 를 거친다 — `withRelayWait(…, 'restorePoints' | 'restores')`(서버 RESULT_MS — 숫자를 화면에 박지 않는다) · 늦게 온 이전 응답은 `gen` 으로 버린다 · 실패한 OTP 는 비운다.
  ③ 네트워크 끊기 기본(새 VM 끊기 · 덮어쓰기 그대로 — `withMode`) · 상태는 원장 `restores[].nic · finish` 를 `finishText` 로(옛 복원은 '—'). 진행 · 이력의 복원 이력 표에 '네트워크' 칸.
  ④ 데이터스토어 목록은 `/datastores`(vCenter 마다 한 번 — `dsAsked` ref · 렌더마다 다시 묻지 않는다) · 남은 스냅샷 칩은 인벤토리 `snapshotCount`(못 읽으면 칩 없음 — 0 으로 보지 않는다).
  ⑤ 백업 대상 패널의 '복원…' 은 이 화면으로 그 VM 을 골라 넘긴다(옛 단건 RestoreModal 은 지웠다). 결과 창의 'Full 로 지금 실행' 은 해석이 Full 을 권하는 줄(`issueNeedsFull`)에만 · 쓰기 범위일 때만.
  ⑨ v2.866 폴더 표(`BareosRestoreTable.jsx` · 트리 `bareosRestoreTree.js` + test): 고르는 방식 칩 두 개(간단 목록 · 폴더 표 — 브라우저에 기억, 못 읽으면 간단 목록) · 표는 div 격자(role=table · 열 머리 고정)이고 트리라 정렬하지 않는다 ·
     아래 고정 줄(선택 수 · 용량 · 다음) · 폴더 체크는 고를 수 있는 VM 만(일부만 고르면 중간 표시) · 모르는 값은 '—' · 부분 합은 '+' · 폴더 VM 수는 열 때 한 번(폴링 없음).
     v2.867.1(Chromium 판독): 아래 고정 줄은 `.pickbar-sticky`(하단 상태바 위 — 상태바는 720px 이하에서 두 줄 · 실측 52px) · bottom: 8 이면 '다음' 버튼이 상태바에 가렸다(400px 에서는 보이지 않음).
- **v2.862 — Bareos 복원 검증(리허설) · 일일 요약 메일**(`BareosRehearsal.jsx` — 운영 › 복원 아래 카드 · 설정 › 공통 기본값 · 수집의 '일일 요약 메일' 펼침). 글자는 `bareosRestoreText.js`:
  ① 정책은 꺼짐이 기본 — 화면이 그 사실과 이유(VM 을 만들고 데이터스토어를 쓴다)를 먼저 말한다. 정책 바꾸기 · 지금 검증은 서버가 준 `fullScope` 일 때만 그린다(집행은 서버) · OTP 칸은 6자리 숫자만 · 실패해도 비운다.
  ② 폴링하지 않는다(처음 한 번 + 다시 읽기) · 결과 표의 Tools 응답 시간은 `toolsText`(모르면 '—' — 0 아님) · 정리 칸은 지움/남김/—.
  ③ 최근 묶음 진행(`latestBatchId`)에서 검증 회차는 뺀다 — 사람이 시작한 묶음만. 요약 메일 설정은 공통 기본값 저장과 따로 저장한다.
  ④ v2.863 vCenter 별 검증 데이터스토어 칸은 정책 편집 안의 접힌 `<details>`(vCenter 가 28곳이어도 기본 화면을 늘리지 않게) · 목록은 편집을 열 때 `/datastores` 한 번(폴링 없음) ·
     지금 값이 목록에 없으면 지우지 않고 사유를 붙인다(`rehearsalDsOptions` — 읽는 중 · 못 읽음 · 접근 불가 · 인벤토리에 없음을 가른다).
- **v2.881 — 위키(사용자 요청 '지라와 컨플루언스 같은 기능' · 승인 시안 `docs/design/wiki-issues` ①~⑤ · ⑫)**. 화면 `views/wiki/Wiki.jsx` · 렌더러 `MdView.jsx` · 파서 `markdown.js` · 판정 `wikiText.js`.
  ① **마크다운은 자체 파서 → 구문 나무 → React 요소**(새 의존성 없음). **innerHTML · dangerouslySetInnerHTML 금지** — HTML 은 글자 그대로다. 링크는 `safeHref`(http(s) · `#/` · mailto)만,
     그림은 `safeImg`(같은 출처 `/…` · `data:image/(png|jpeg|gif|webp)` — CSP `img-src 'self' data: blob:` 와 맞춘 것. 바깥 그림은 링크로 내린다). 이 둘을 넓히면 `markdown.test.js` 안전 묶음이 막는다.
  ② 파서 정규식은 앵커 + 길이 상한만 — 제목 · 울타리 · 표 구분 줄은 손으로 판정한다(뒤쪽 공백 · # 을 겹쳐 훑는 역추적). 인라인 짝 찾기는 '닫는 짝 없음' 을 기억해 다시 훑지 않는다.
     선형 시간은 `markdown.test.js` 가 **비율**로 고정(병적 입력 11종 · 2배 입력에 3.2배 미만 · 3회 최솟값). 옛 정규식으로 되돌리는 변이 2건을 잡는 것을 확인했다.
  ③ 목차 · 각주 이동은 **해시를 바꾸지 않고** `scrollIntoView`(해시는 화면 주소다 — `#wh-3` 으로 바꾸면 위키를 떠난다). 제목 id 는 `idPrefix` 로 미리보기 · 댓글과 겹치지 않게.
  ④ 저장은 편집 시작 판(`baseVersion`)을 싣는다 — 409 `conflict` 면 내 글을 그대로 두고 그 사이 바뀐 줄(`/diff`)을 보인 뒤 '확인하고 내 글로 저장'(지금 판으로 다시 보냄). 조용히 덮지 않는다.
     초안은 이 브라우저(localStorage)에만 1.5초 멈추면 저장 — 모든 접근은 try/catch(막힌 브라우저에서도 화면이 돈다). 서버 판과 편집 시작 판이 같을 때만 '불러오기' 를 띄운다.
  ⑤ 버튼 판정은 서버 값으로: `writable`(편집 · 지우기 — 쓰기 범위 ∧ 읽기 전용 아님) · `commentable`(댓글 — 쓰기 범위만, 읽기 전용 스페이스에서도 된다 · `addComment` 와 같은 판정 · `wiki2881` ③ 이 고정).
  ⑥ 본문 첫 `# 제목` 이 문서 제목과 같으면 보기에서만 뺀다(`withoutTitle` — 템플릿이 '# 제목' 으로 시작해 두 번 보였다 · 글은 바꾸지 않는다). 콜아웃 제목이 종류 이름과 같으면 한 번만.
  ⑦ 링크 색은 `.wiki-page :where(a:not(...))` — 앱 전역이 `a` 색을 정하지 않아 기본 파랑 + 밑줄이 어두운 배경에서 안 읽혔다(Chromium 판독). `:where` 로 특이도를 0 으로 둬야
     문서 나무 · 빵 부스러기 링크가 자기 색을 지킨다(`:not()` 사슬은 특이도를 올려 덮었다). 위키 밖(이슈 상세 '관련 문서')은 `.wiki-xlink`.
  ⑧ 편집 아래 고정 버튼 줄은 `bottom: var(--statusbar-h)` — `bottom: 0` 이면 하단 상태바(fixed)가 저장 버튼을 가렸다(Chromium 실측 1440: 버튼 855~900 · 상태바 868~ / 400: 상태바 848~). v2.867 `.pickbar-sticky` 와 같은 사고.
  ⑨ 마크다운 표도 `STable`(헤더 정렬 · `data-sort` 에 순수 글 · `minWidth` 로 400px 가로 스크롤). 400px 에서 문서 나무는 '문서 목록' 버튼으로 연다.
- **v2.882 — 이슈 확장(사용자 요청 '지라 같은 기능' — 에픽 · 스프린트 · 필터 · 승인 시안 `docs/design/wiki-issues` ⑥⑦⑧⑬)**. 화면 `views/issues/IssuesPlus.jsx`(스프린트 · 에픽 · 필터 · 일괄 편집 ·
  상세의 에픽/스프린트 칸 · 하위 작업 칸) · 공용 조각 `issueParts.jsx`(Issues.jsx 에서 옮김) · 판정 `issueText.js`(칩 · 칩 지우기 · 오류 밑줄 · 번다운 선).
  ① **검색식은 서버가 해석한다**(`server/src/issues/query.js` 하나) — 화면은 식 문자열만 보내고, 칩 · 오류 위치 · 제안도 서버 값이다. 칩을 지우면 남은 칸의 **원문 구간**을
     ' AND ' 로 다시 잇고 정렬 부분(`orderStart` 뒤)을 그대로 붙인다(`removeChip` — 두 벌의 식을 만들지 않는다). 칸 구간은 `in (…)` 의 닫는 괄호까지 덮는다(빠지면 지울 때 ')' 가 남았다 — 테스트가 잡았다).
  ② **목록 표에 열을 더하지 않는다** — 에픽 · 스프린트 두 열을 더했더니 1440px 에서 표(1,320px)가 본문 폭(약 1,120px)을 넘어 기한 · 갱신이 가로 스크롤 뒤로 숨었다
     (Chromium 판독 — v2.780 과 같은 종류). 에픽 · 하위 · 스프린트는 제목 아래 작은 표시(`iss-row-tags`)로 두고, 그 값으로 정렬하려면 필터 화면의 결과 표(열이 따로 있다 · 가로 스크롤)를 쓴다.
  ③ 스프린트 기본 선택은 '기간 안의 진행 중' → 기간 지난 진행 중(최근) → 예정 — 목록 순서(시작일)대로 고르면 기간이 지난 옛 스프린트가 먼저 잡혔다(Chromium 판독).
  ④ 번다운 기준선은 '가장 많이 남았던 수 → 마지막 날 0' — 첫날 값으로 그으면 스프린트 중간에 이슈를 넣었을 때 바닥에 붙는다. 아직 오지 않은 날(null)은 그리지 않는다(지어내지 않는다).
  ⑤ 남은 하위 작업(에픽이면 소속 이슈)이 있으면 서버가 409 `open-children` 로 묻고 화면은 확인을 받아 `closeChildren:true` 로 다시 보낸다(취소하면 아무것도 바꾸지 않는다).
     자식이 있는 이슈의 진행률 입력은 잠기고 메모만 보낸다(서버 409 `progress-auto` 와 같은 판정).
  ⑥ 스프린트 · 필터 공유 버튼은 서버 값(`canSprints` · `canShareFilters` — 전체 범위 쓰기 계정)일 때만 그린다. 필터 저장은 쓰기 역할만(viewer 상태변경 예외를 늘리지 않았다).
- **v2.930 — 개선 포인트 1 · 3 · 2 · 4(사용자 '제 추천 순서는 1 → 3 → 2 → 4 진행해' · 4번 '같은 법인 + 공용만' · 검증 '표준' · 코드 · 테스트 표지는 v2.929 — 준비 중 main 이 2.927 → 2.928 → 2.929 로 올라가 릴리스 번호만 v2.930.0)**. 회귀 `web/src/cssSelectors2929.test.js` · `server/test/issuesFix2929.test.js`.
  - **정정 ①(CSS 이름 겹침 재발)**: v2.908 이 SLA 업무 시간 입력에 `.iss-cal` 을 써서 이슈 캘린더 화면의 `.iss-cal` 에 점선 · 여백을 덧붙였다(같은 v2.908 에서 `.iss-filters` 겹침을 고치며 그 이름 하나만 막았다).
    입력은 `.iss-slacal` 로. 이제 테스트가 **styles.css 전체**에서 '클래스 하나짜리 선택자가 두 규칙에 나오는 것' 을 찾고, 의도한 덧붙임(11개)만 `KNOWN` 에 사유와 함께 둔다.
  - **정정 ②(인증서 만료)**: v2.908 은 '인증서 만료는 판정이 없어 대상이 아니다' 라고 화면 · DB 안내에 적었는데, 알람 엔진에만 없고 `security/certMonitor.js` 가
    vCenter · NSX 443 을 12시간마다 확인한다. 그 결과(`onCertResults` 구독)로 이슈를 만든다(`alertIssues.js applyCertResults` — 30일 이하 · 만료, 갱신되면 해소 · 확인 실패는 보류).
  - 알람 엔진 평가 → 구독 → 이슈 등록이 **실제로 이어지는지**를 테스트한다(`alerts._refreshStateForTest` — v2.908 은 판정 함수만 직접 불렀다). 판정 보류로 빠진 알람은 해소가 아니다.
  - 위키 자동 체크는 **이슈의 법인 스페이스 + 공용만**(`checkIssueTasks(…, { vcenterId })` — 다른 법인 문서는 `outOfScope` 로 세기만). 변이 2/2(판정 줄 · 자동화가 법인을 넘기는 줄).
- **v2.908 — 이슈 기능 추천 6~10(사용자 '모두 적용' · 시안 없이 기존 화면 틀대로 — 사용자 선택)**. 회귀 `server/test/issuesR4_2908.test.js` · `web/src/views/issues/features2908.test.js`.
  - 자동화 규칙은 **고정 4개**(`issues/automation.js` · 설정 `automation` — 기본 전부 꺼짐). 저장소 이벤트는 동기라 **setImmediate 로 미뤄** 돈다 — 상위를 하위와 함께
    완료(closeChildren)하는 도중 자식 완료 이벤트가 상위를 '검토' 로 되돌리지 않게(테스트가 고정). 위키 체크는 보기에서 체크와 같은 경로(판 없음 · checkLog · checkRev) ·
    키 뒤에 숫자가 이어지면 다른 키다(ISS-1 ≠ ISS-10). 멈춤은 30분 검사(`notify.js scanStale` — 기록 `stale:<키>`)와 목록 배지(`store.js staleDaysOf`)가 **같은 기준**.
  - 포탈 알림함(`issues/inbox.js` · `issue-inbox.json` 상태 파일)은 **받을 사람 판정을 메일과 같이**(`recipientsOf(…, { force:true })`) 쓰고 스위치만 따로다(기본 켬 —
    밖으로 나가는 것이 없다). 줄에 법인을 적고 **읽을 때 지금 범위로 다시 거른다**. 메일이 꺼져 있어도 기한 · SLA · 멈춤 기록은 남긴다(30분마다 같은 줄이 쌓이지 않게).
    안 읽은 수는 마운트 1회 + 새로고침(폴링 없음).
  - 리포트(`issues/report.js`)는 **서버 집계 하나** — 화면은 다시 세지 않는다. SLA 가 꺼져 있으면 준수율 null('—' — 0% 로 적지 않는다) · 평균 해결은 완료만 · 보류 제외 · 달력 시간.
    범위 계정은 재료(`reportSource`)를 만들 때 거른다(공용 이슈도 빠진다). CSV 는 'data.csv' 권한.
  - SLA 업무 시간(`sla.js calendarFor · businessMs · addBusinessMin`): 오프셋은 그 날 정오에 Intl 로 읽어 캐시(서머타임 전환은 새벽) · 휴일은 날짜 번호 집합 · 법인 휴일 목록이 있으면
    공통 휴일 **대신**. 이슈 설정 화면은 `calendar` 를 늘 같이 보낸다(빠뜨리면 저장이 기본값(24×7)으로 되돌린다). 서버는 automation · inbox · sla 가 빠진 저장을 '지금 값 유지' 로 본다.
  - 다른 알람 자동 등록(`issues/alertIssues.js` · `issue-alert-auto.json`)은 알람 엔진 · Bareos 쪽에 **구독 훅만**(`alerts.js onAlertState` · `bareos/notify.js onBareosFailures`) — 그 모듈들은
    이슈를 모른다. 판정 보류로 끊긴 키는 해소가 아니다(resolved 에 넣지 않는다). 인증서 만료는 알람 엔진에 판정이 없어 넣지 않았다(지어내지 않는다).
  - **CSS 클래스 이름 겹침(Chromium 판독으로 발견 — v2.882 부터)**: 필터 화면의 격자 `.iss-filters`(240px + 나머지)가 보드 필터 줄 · 활동 머리의 같은 이름(줄 배치)을
    파일 뒤쪽에서 덮어 그 줄들이 2열 격자로 늘어났다. 필터 화면은 `.iss-filterview` 로 바꿨다. **새 클래스를 만들기 전에 `grep -n '^\.<이름>' styles.css` 로 같은 이름이 있는지 볼 것**
    (`features2908.test.js` 가 `.iss-filters` 한 벌을 고정). 카드 아래 줄(`.iss-card-foot`)은 줄바꿈 — 1440 5열에서 담당자 동그라미가 카드 밖으로 나갔다.
- **v2.907 — 위키 · 이슈 기능 추천 1~5(사용자 '모두 적용' · 시안 없이 기존 화면 틀대로 — 사용자 선택)**. 회귀 `server/test/wikiIssues2907.test.js` · `web/src/views/wiki/features2907.test.js`.
  - 댓글 고치기(위키 · 이슈): 쓴 사람만 · 옛 본문 5개 보관 · 판/이력은 만들지 않는다 · **알림은 새로 언급한 사람에게만**(`ev.edit` — 담당 · 보고 · 관찰자에게 다시 가지 않는다).
  - 문서 지우기는 **휴지통**(30일 — 판 · 댓글 · 첨부 그대로). 첨부 본체 · 즐겨찾기는 영구 삭제(손으로 · 기한) 때 정리하고, 첨부는 삭제가 디스크에 닿은 뒤(`removeOwnerAfterPersist`). 기한 정리는 폴링하지 않고 목록 · 지우기 때.
  - 문서 링크는 화면 파서와 **같은 규칙**(서버 `pageRefsOf` · `resolveRef` ↔ 웹 `markdown.js` · `resolvePageRef`). 제목을 바꾸면 '[[옛 제목]]' 중 **이 문서로 풀리던 것만** 새 제목으로(같은 제목의 다른 문서를 빼앗지 않는다) — 쓰기 범위 밖 문서는 건너뛰고 센다.
  - 다른 스페이스로 옮기기는 하위 문서와 함께 · 두 스페이스 모두 쓰기 범위 · 문서 번호가 그대로라 첨부 · 즐겨찾기 · 이슈 '관련 문서' 가 따라간다.
  - 이슈 템플릿(`issue-templates.json`)은 위키 관리자 템플릿과 같은 틀(전체 범위 관리자만 쓰기 · 내장 3개는 못 고침) · '/issues/templates' 는 '/issues/:key' 보다 먼저 등록(뒤면 404).
- **v2.907 — 위키 댓글 @멘션 자동완성 · '계정/이름' · 언급한 사람에게 이슈 등록(사용자 요청 + 시안 `docs/design/wiki-mention` · '모두 적용' — 추천안 5개)**. 회귀 `server/test/wikiMention2907.test.js` · `web/src/components/mentionText.test.js`.
  - 멘션 후보는 **서버가 거른다**(`issues/mentionables.js` — A3-02 그대로 + 문서/이슈 참여자). 역할 · 범위 · 메일 유무 · '그 법인을 볼 수 있는가' 는 전체 범위 쓰기 계정에게만 싣는다.
  - 자동완성 목록은 글상자 아래 줄을 통째로(`components/MentionBox.jsx` — 떠 있는 상자 금지) · 한글 조합 중 Enter 는 먹지 않는다 · 늦게 온 응답은 버린다 · 폴링 없음.
  - '@계정/이름' 은 **글자 그대로 저장**한다. 파서 · 알림 해석(가장 긴 접두) · .md · 메일이 같은 글자를 쓰고, 칩만 계정(모노) + 이름으로 나눠 그린다. 이름의 공백 · 멘션을 끊는 글자는 넣을 때 뺀다.
  - 댓글 → 이슈는 **저장 전에 거를 수 있는 것을 먼저**(담당자 = 언급한 사람 · 그 법인을 볼 수 있는가 · 권한) — 400 이면 댓글도 저장하지 않는다. 같은 댓글로 두 번 만들지 않는다(`origin wiki-comment`).
- **v2.906 — 분산 포트그룹 카드 · 별건 정리 화면(사용자 선택 '남은 별건 정리 · vDS 팀 구성 수집 · 남은 화면 실검증' · '표준')**. 회귀 `vcd/vcInfo.test.js` · `vcdTabsRender.test.jsx` · `bareosCancelText.test.js`.
  - `VcInfoParts.DvpgTeamingCard` — 분산 스위치가 없는 호스트 · 호스트 구성을 아직 읽지 않은 호스트에는 **부르지도 그리지도 않는다**(훅은 조기 return 위 · `useOnce` 의 enabled). 업링크 포트그룹은 뺀다.
    팀 구성 문구(`TEAMING_TEXT` · `teamingText`)는 `vcd/vcInfo.js` 한 벌로 옮겼다(HostObject 는 다시 내보내기만 — 표준 스위치 표와 분산 포트그룹 표가 같은 말).
  - Bareos 그룹 카드: 회차 중단 없이 행마다 취소한 이번 회차 실행 — '멈추는 중(실행별 취소)' · '실행 중 · 실행별 취소 n'(서버 `cancelPlan.sentFire` · 옛 서버는 예전 판정).
- **v2.916 — 설정 메뉴 개편: 왼쪽 목록 + 상태 배지(사용자 요청 '설정 메뉴를 클로드 디자인 사용해서 개편 — 효율적이고 직관적으로' · 시안 A안 + B 상태 요약 · '항목별 미설정 전부' · '표준')**.
  회귀 `server/test/settingsMenu2905.test.js`(③ 갱신) · `server/test/settingsStatus2916.test.js` · `web/src/views/settingsMenu.test.js`. 설계 `docs/design/settings-menu/README.md` §4.
  - 메뉴는 **설정 안의 왼쪽 목록**(`.stg` — 묶음 접기 · 검색 `/` · 상태 요약 칩 · 즐겨찾기 · 최근)이고 v2.905 의 1단 가로 탭 줄(`.vcd-views`)은 없다. 묶음 10개(`GROUP_ORDER`).
    새 설정 화면은 `SUB` 에 `group:` 과 **`desc:`(한 줄 설명 — 본문 머리 · 검색이 쓴다)** 를 달 것(테스트 ③이 desc 없는 항목을 막는다).
  - 좁은 화면 판정은 **화면 폭(media)이 아니라 설정 영역 폭(컨테이너 쿼리 `@container stg (max-width: 760px)`)** — 사이드바 펼침(236)/레일(64)에 따라 본문 폭이 달라 같은 1100px 화면도 결과가 다르다.
  - 상태 배지 판정은 서버 `settingsStatus/grade.js` 하나(화면에서 다시 판정하지 않는다). **꺼짐(off — 선택 기능 미사용)은 미설정이 아니다** — 쓰지 않는 법인에 호박색이 13개 붙지 않게.
    사실을 못 읽으면 그 항목만 `unknown`('?') · 응답 실패면 목록 바닥에 '배지가 없다고 정상인 것은 아닙니다'. 사실 수집(`sources.js`)은 **파일 · 메모리 값만**(외부 호출 · SQLite · `authStopFor` 금지 — 테스트 ④가 원문 대조).
    로드 오류 표지가 없는 로더는 '파일 없음 + 손상 보존본' 을 `damaged()` 로 따로 본다(기본값의 0개를 미설정으로 보이게 하지 않는다). 응답은 `no-store` — `memoJson`(세대 키 ETag)을 쓰면 저장 직후 304 로 옛 배지가 남는다.
- **v2.905 — 설정 메뉴 재배치(사용자 요청 '설정에 메뉴가 너무 많아져서 스크롤바가 생긴다 — 재배치' · '9개 묶음 + 2단' · '표준')**. 회귀 `server/test/settingsMenu2905.test.js`.
  - 1단은 **묶음만**(`Settings.jsx GROUP_ORDER` 9개 — 인프라 등록 · 백업 · 수집 · 엣지·원격 · 사용자 · 보안 · 알림·연동 · 로그 · 시스템). 단독 1단 항목을 만들지 않는다 —
    v2.904 까지 단독 12개 + 그룹 7개 = 19개라 1,600px 대에서도 가로 스크롤이 생겼다. 새 설정 화면은 `SUB` 에 `group:` 을 달아 묶음 하나에 넣는다(묶음 없으면 테스트 ②가 막는다).
  - 1단 줄은 줄바꿈(`flexWrap: 'wrap'` — `.vcd-views` 의 가로 스크롤을 여기서만 끈다). 1단 라벨에 이모지를 넣지 않는다(폭).
  - 키(`#/settings/<k>`)는 묶음과 무관하게 그대로다(테스트 ①이 48개를 고정). 묶음 라벨을 바꾸면 화면 · 서버 · 메일 문구의 '설정 › <묶음> › <항목>' 경로를 함께 고친다 —
    테스트 ④(옛 이름 잔존)·⑤(항목이 그 묶음에 있는가)가 주석을 뺀 소스를 훑는다. 버전 이력 주석 · 릴리스 노트는 과거 기록이라 고치지 않는다.
- **v2.904 — 위키 · 이슈 · 첨부 점검 확정분(사용자 요청 '버그 10개 찾아줘' → '모두 적용해줘' · '표준')**. 회귀 `server/test/wikiIssues2904.test.js`(변이 6/6) · `web/src/views/wiki/fixes2904.test.js`.
  - **'전체 범위' 판정은 조회 ∧ 쓰기 무제한** — `auth/scope.js isFullReadWriteScope` 하나. 위키 · 이슈 · 첨부의 `isMod` 가 조회만 봐서 쓰기 범위 관리자가 남의 위키 댓글을 지우고 해결하고 공유 필터를 지웠다(P-1).
  - 범위 계정 응답의 **이력도 가린다** — `parentKey · epic · links` 를 `vis()` 로 가리면서 `history` 는 원문이었다(범위 밖 법인 id · 공용 에픽 키). 저장된 이력은 그대로, 응답에서만(`historyFor`).
  - 판을 만들지 않는 변경(체크 토글)은 **판 번호 말고 따로 센다**(`checkRev` ↔ 편집기 `baseCheckRev`) — 옛 본문을 실은 저장이 409 없이 체크를 되돌렸다. 체크만 바뀐 충돌은 비교 대신 그 사실을 말한다.
  - 두 저장소의 **내구성 시점을 맞춘다** — 첨부(동기)와 주인(디바운스 300ms): 올리기는 주인 저장 확인 뒤, 주인 삭제의 첨부 정리는 삭제가 디스크에 닿은 뒤(`removeOwnerAfterPersist`).
  - 표 빈 값 자리표시로 `'~'` 를 쓰지 않는다(Collator 에서 맨 앞) — `data-sort=''` 면 방향과 상관없이 뒤(`EMPTY_TOKENS`). 한글 조합 중 Enter(`isComposing` · 229)는 단축 동작으로 먹지 않는다.
  - 내려받기 이름은 `Content-Disposition` 의 `filename*=UTF-8''` 먼저(`api.js dispositionName`) · 그림 주소 화이트리스트는 역슬래시도 막는다(`/\host` 는 바깥 호스트) · 줄 끝 판정을 이어 붙인 버퍼의 `endsWith` 로 하지 않는다(제곱 시간).
- **v2.901 — 개체 보기 3차 · 점검 확정분 화면(사용자 요청 '버그 수정이나 개선' · '표준')**. 회귀 `vcd/objView.test.js` · `vcInfo.test.js` · `vcdTabsRender.test.jsx` · `bareosGroupText.test.js`.
  - 호스트 네트워크 표에 팀 구성 열(`HostObject.jsx TEAMING_TEXT`) · 데이터스토어 탭 마운트 카드(`objTabs.hostDsMounts` — 못 읽음 · 없음 · 행) · 리소스 풀 카드(`PoolSettingsCard`). '수집하지 않음' 표는 지웠다.
  - `vcd/useOnce.js` 는 상태에 열쇠를 싣고 **지금 열쇠의 값만** 돌려준다 — 다른 개체로 옮겨 가면 이전 개체의 값 · 오류를 한 번도 그리지 않는다(변이 확인).
  - 못 읽은 워킹셋은 '—'(W3 — v2.895 가 0 GB 로 그렸다 · 정정). 관리자 전용 API 를 부르는 버튼은 `adminToolAllowed(k)`(= 관리자 ∧ 도구 권한 — W1).
  - 스프린트를 바꾸면 다른 스프린트의 보드를 그리지 않는다(`cur = board.sprint.id === sel`) · 위키 충돌 저장은 비교가 있을 때만 · 옛 GPU 주소는 `location.replace` · 오류 뒤 effect deps 에 error.
  - Bareos 그룹 편집: 기준 시각 Select(현지 서버 · 중앙 포탈 + UTC 오프셋 — **한 줄 전체**, 두 칸 폭에서는 오프셋이 잘렸다) · 미리보기의 서버 시간대 이름은 현지 서버 시계일 때만 ·
    다음 실행 칸은 두 시계를 함께(`nextClockText`) · 새 그룹 기본은 'portal'(옛 그룹은 server — 서버 기본과 같다).
  - ⚠ **정정(Chromium 판독)**: 새 값을 수집하게 만들면 화면의 '수집하지 않' 문구를 **grep 해 함께 고친다** — v2.901 이 VMXNET3 권장을 넣고도 튜닝 탭에 '(vmxnet3 여부) 수집하지 않습니다(2차)' 가,
    v2.898 이 업데이트 · vLCM 을 넣고도 vCenter 요약에 '적용 가능 패치: 수집하지 않음' 이 남아 있었다(`vcdTabs.test.js` 가 고정). v2.898 정정(반대 방향 — 수집하는 값을 '수집하지 않음' 으로)과 짝이다.
- **v2.898 — vCenter 개체 보기 2차(사용자 요청 '수집하지 않음 항목 반영할 수 있어?' · 선택 '①~④ 전부' · '전체 검증')**. 카드 `views/vcd/VcInfoParts.jsx` · 판정 `vcd/vcInfo.js`(순수) ·
  서버 `server/src/vcinfo/`(규칙은 `docs/rules/vcenter.md` v2.898). 회귀 `vcd/vcInfo.test.js` · `vcdTabsRender.test.jsx` · `server/test/vcinfo2898.test.js` · `vcd2898snapNic.test.js`.
  - 값은 `/vcenter-info/<kind>` — 탭을 열 때 1회 + '다시 읽기'(15초 폴링 금지). 갱신 주기 문구는 응답 `refreshMs` 로(화면에 숫자를 박지 않는다). `at:null`+`notCollected` 는 '없음' 이 아니라 '아직 읽지 않음'.
  - 권한 목록 카드는 `hasRole('admin')` 일 때만 부른다(아니면 부르지 않고 `ErrorBox` 403 — 서버도 `isAdminDetailUser` 로 403). 작업 시작 사용자 · 알람 확인자는 관리자 판본에서만 이름이 온다(`userMasked`).
  - VM · 호스트 개체의 알람 · 작업 · 권한은 같은 카드에 `entityType`+`entity`(moref — `VmObject.vmRef`)를 준다. 권한은 **그 개체에 직접 정의된 것만**이라 상속은 '알 수 없음' 으로 말한다.
  - 함수 컴포넌트에 `ref` 라는 prop 이름을 쓰지 말 것(React 가 떼어 간다 — `Target` 의 `mref`). JSX 컴포넌트 미정의는 eslint `no-undef` 가 잡지 않는다(react 플러그인 없음) — 새 카드를 꽂을 때 import 를 손으로 확인했다.
  - 스냅샷 트리는 트리 모양 목록(`role=tree` · `aria-level`)이라 STable 이 아니다(정렬하면 부모 관계가 깨진다). 들여쓰기는 6단까지만 키운다(400px).
- **v2.895 — 성능 튜닝 탭(VM · ESXi 호스트 개체 보기 — 사용자 요청 '성능 튜닝을 위한 기능' · 승인 시안 ⑫⑬ · 기본값 11~13)**. 화면 `views/vcd/TuningTabs.jsx` · 판정 · 계획 `vcd/tuning.js`(순수). 회귀 `vcd/tuning.test.js` · `vcdTabsRender.test.jsx`.
  - **새 판정 · 새 서버 경로 없음** — 자원 적정화는 서버 `/tools/rightsize`(analyzeRightsize) verdict 그대로(reduce · hold = 주의 · keep = 적정 · insufficient = 판정 보류) · CPU 경합 · 디스크 지연은 `contentionText.vmContentionFindings` · 구성은 `vmCfgFindings` · `hostCfgFindings` · 가상화율은 `vcdVirt.js RATIO_LEVELS`(트리 색 `ratioColor` 도 이 값을 쓴다 — 한 곳) · 사용률은 usageColor 의 75/90 · 데이터스토어는 포탈 알람 규칙 90/95. 기준을 바꾸려면 원래 모듈을 바꾼다(여기서 숫자를 새로 정하지 않는다).
  - 축마다 ok · warn · crit · **unknown** — 꺼짐 · 측정 없음 · 권한 없음 · 조회 실패 · 레벨 2 카운터(벌룬 · 스왑) 표본 없음은 unknown('—')이고 정상으로 세지 않는다. 점수 · 등급 없음.
  - VM 탭만 서버를 부른다(`/tools/rightsize` · 열 때 1회 · 기간 7/30/90 · 기본 30일 · 'rightsizing' 권한 없으면 부르지 않고 403 안내). 호스트 탭은 받은 목록만 쓴다 — **VM 수십 대의 성능 롤업을 한꺼번에 묻지 않는다**(고RTT 부하).
  - 조치 계획은 축의 근거에서만 만들고 **저장하지 않는다**(체크리스트 CSV · Markdown 내려받기 — `canCsv` · CSV 수식 주입 방지 · BOM). 적용은 지금 도구(사양 변경 — vm.reconfig · 쓰기 범위) · vSphere 에서.
- **v2.895 — VM · ESXi 호스트 개체 보기(사용자 요청 '폴더에서 VM 을 vCenter 처럼 — 별도 버튼 · 호스트도' · 승인 시안 `docs/design/vcenter-tabs` ⑧~⑪ · 기본값 8~10)**. 화면 `views/vcd/{VmObject,HostObject,ObjectShell}.jsx` · 주소 `vcd/vcdRoute.js` · 묶음 `vcd/objTabs.js`. 회귀 `vcd/objView.test.js` · `vcdTabsRender.test.jsx`.
  - **주소가 진실의 원천**: `#/vcenters/<vcId>` = 상세, `/vm|host/<id>[/<탭>]` = 개체 보기(id 에 ':' 이 있어 조각마다 encodeURIComponent). `VCenters` 의 연 vCenter 도 주소에서 읽는다(새로고침 · 뒤로 가기 · 공유). 탭 전환은 `replaceHash`(기록을 쌓지 않는다). 다른 vCenter 주소는 무시한다. 브라우저가 아닌 시험에서도 던지지 않게 `currentHash` · `goHash` · `onHashChange` 를 쓴다(직접 `window.location` 금지).
  - 여는 곳 셋 — 트리 행의 `.vcd-objbtn`(1440 은 마우스를 올릴 때 · 터치/좁은 화면은 항상) · 상세 창 버튼 줄의 `ObjectViewButton`(창을 닫고 간다 — 다른 화면의 상세 창에서도 같은 주소로) · 개체끼리(VM 요약 › 호스트 · 호스트 VM 탭 › 개체 →). 행 이름 클릭(상세 창)은 그대로.
  - **새 수집 없음** — /vms · /hosts 한 행 + 캐시(vmcfg cfg·dev · hcfg · perfc) + 온디맨드(파티션 · 이벤트 · 메트릭 — 열 때 1회). 섹션은 `EntityDetail` 의 것(VmCfgSection · VmPartitionsSection · VmTagsSection · VmChangesSection · PerfcSection · ClusterCfgSection · HostBasicRows · HostCfgSection · HostHbaTable)을 export 해 재사용 — 복제 금지. 조회 전용이고 상태를 바꾸는 동작은 지금 버튼(권한 · 쓰기 범위) 그대로.
  - 수집하지 않는 칸(리소스 풀 속성 · 호스트별 DS 마운트 · NIC 팀 구성 · 고급 설정)은 탭을 숨기지 않고 `NotCollected`.
    ⚠ **정정(v2.898)**: v2.895 는 여기에 '포트그룹' 도 적고 호스트 네트워크 탭을 '수집하지 않음' 으로 그렸다 — 호스트 가상 스위치 · 포트그룹은 **v2.701(A10)부터 `hcfg.net`** 에 있었다(틀린 문구 ·
    사용자 보고에도 그대로 나갔다). '수집하지 않음' 으로 적기 전에 그 값의 수집 모듈(hostcfg · vmcfg · soapParse)을 grep 할 것. 네트워크 어댑터 · 권한 목록 · 스냅샷 트리 · vLCM · 작업은 v2.898 에 채웠다. vmcfg 가 아직 읽지 않은 디스크는 '아직 읽지 않음'(빈 표 아님) · 호스트 데이터스토어는 VM 디스크로 역산하고 못 읽은 VM 수를 밝힌다.
  - ⚠ CSS 이름: 새 클래스는 `.vcd-` 접두라도 **기존 트리 규칙(.vcd-sub · .vcd-row · .vcd-node …)과 겹치는지 먼저 grep** — v2.895 가 하위 칸 목록에 `.vcd-sub` 를 써 트리 행이 47px 로 늘었다(Chromium 재판독에서 발견 · `vcdTabs.test.js` 가 고정).
- **v2.895 — vCenter 상세 탭 12개(사용자 요청 'vSphere Client 처럼' · 승인 시안 `docs/design/vcenter-tabs` ①~⑦ · 기본값 1~7)**. 화면 `views/VCenterDetail.jsx` + `views/vcd/`(SummaryTab · MonitorTab · ConfigureTab · InventoryTabs · VcdParts · useOnce). 회귀 `views/vcd/vcdTabs.test.js` · `vcdTabsRender.test.jsx`.
  - 탭 목록 · 옛 키('trend' → 모니터 › 성능) · 하위 칸 · 데이터센터 묶음 · 확장 상태 · 버전 행은 **`vcd/vcdTabs.js` 하나**. 기본 탭은 예전과 같은 '호스트 및 클러스터', 그 뒤로는 브라우저 기억(`vcd.tab`, try/catch).
  - 탭 줄은 **한 줄**(`.vcd-views` nowrap + overflow-x) — 1440px 에서 12개가 들어가는 폭(패딩 6px 10px)이다. 탭을 더하거나 이름을 늘리면 1440 에서 다시 잰다(넘치면 마지막 탭이 잘려 보인다).
  - 새 탭은 **새 수집이 없다** — 사이트 about · /hosts · /vms · /datastores · /networks · /alarms + 특수 기능 API(licenses · cluster-check · vm-tags · report/certs · host-hygiene · solutions · report/changes)를 `vcenterId` 로 거른다. 그 도구 권한(`toolAllowed`)이 없으면 **부르지 않고** `toolDenied()` 403 을 `ErrorBox` 로 보인다(숨기지 않는다).
  - 포탈 알람은 vCenter 자체 알람이 아니다(수집기 `mkAlarm` 규칙) — 화면이 **'포탈 규칙'** 배지 + 규칙 각주를 단다. 수집하지 않는 것(작업 · vCenter 트리거 알람 · 고급 설정 · 권한 목록 · Linked Mode · 패치 · vLCM)은 `NotCollected`('수집하지 않음 · 2차')로 말하고 빈 표 · 0 을 그리지 않는다.
  - 탭 조회는 `useOnce`(열 때 1회 + 다시 읽기 · 늦은 응답 폐기) — 15초 폴링 금지. 알람만 60초 폴링(memo 라우트).
  - 데이터센터를 못 따라간 호스트(`vcDatacenter` null)는 어느 데이터센터에도 더하지 않고 '데이터센터 확인 필요' 로 따로 센다. 확장 목록을 못 읽었으면(`solutionsUnread`) '0개' 가 아니라 '확인 불가'.
- **v2.889 — C-4 · C-5 기능 모음**. 위키 보기 · 편집 · 대문 · 설정 · 이슈 상세 · 캘린더 · 이슈 설정.
  ① **첨부 파일은 `<img src>` · 주소창으로 열지 않는다** — 인증이 Bearer 머리말이라 직접 열면 401 이다. `fetchBlob` 으로 받아 object URL 로 그리고(`AttachImg`) 내려받는다.
     본문의 첨부는 `attach:<32자 hex>` 주소 하나(`markdown.js attachId`) — `safeHref` 로는 통과시키지 않는다(일반 링크가 되면 401 링크가 된다).
     그림은 서버가 첫 바이트로 그림이라 판정한 것만 `?inline=1` 로 그린다(확장자만 png 인 html 은 attachment 로만 받는다).
  ② **매크로는 문서 보기에서만 그린다**(`MdView renderMacro` — 이슈 본문 · 미리보기 · 포함된 문서 안은 안내 상자). `{{include}}` 는 한 단계(포함 안의 매크로 · 포함을 그리지 않아 재귀가 없다).
     도구 API(`/tools/part-faults`)를 소유 화면 밖에서 부르면 `toolAllowed(` 가드가 있어야 한다(audit2613a 스윕).
  ③ **인라인 댓글은 인용 글만 저장한다**(줄 번호 · 위치 없음 — 판이 바뀌면 못 찾을 수 있고 화면이 그렇게 말한다). 찾기는 DOM 글자 노드를 공백 정리 뒤 대조(`wikiExport.findQuote`).
  ④ **인쇄 · PDF 는 지금 보이는 문서 DOM 을 복제**(매크로 값 · 첨부 그림 포함 — 그 시각 기준). innerHTML 로 그리지 않는다(React 가 넣은 노드를 importNode).
  ⑤ 같은 파일에 기본 인자 함수(`save = (x = null) =>`)가 있으면 다른 컴포넌트의 `onClick={save}` 도 스윕에 걸린다(ipamSheetScope2603 — 이름 기준). 이벤트에는 `() => fn()`.
  ⑥ 캘린더 날짜는 기한 입력과 같은 브라우저 날짜(`toDateInput`/`fromDateInput`) — 700px 아래에서는 한 줄 목록으로 접는다(이달 밖 칸은 숨긴다).
- **v2.888 — C-2 · C-3 기능 모음**. 위키 대문 · 문서 보기 · 편집기 · 이슈 보드 · 상세 · 설정 · 릴리스 노트.
  ① **개인 상태(즐겨찾기 · 최근 본 · 조회 수)는 저장된 id 를 믿지 않는다** — 보여 줄 때 위키 저장소 `metasFor` 가 지금 범위로 다시 거른다(범위가 줄면 빠진다). 조회 수는
     사람 · 날(포탈 날짜) · 문서마다 1회(`wiki/userState.js` — 새로 고침이 순위를 만들지 않게). 문서를 지우면 그 기록도 지운다(`forgetPage`). 즐겨찾기는 지켜보기와 같은 문지기(`commenters`).
  ② **슬래시 명령은 줄 머리의 '/낱말' 만**(`wikiText.js slashQuery` — 주소 · 경로의 '/' 는 아니다 · 줄 머리에서 40자까지만 본다). 메뉴는 커서 좌표를 재지 않고 본문 칸 아래에 붙인다.
     `.wiki-home-grid.three` 처럼 같은 요소에 클래스를 더하면 좁은 화면 미디어 쿼리에도 그 선택자를 같이 적을 것(특이도가 높아 1열로 접히지 않는다).
  ③ **보드 끌기는 상세와 같은 상태 바꾸기 함수**(`postStatusConfirmed` — 완료 확인 409 흐름 하나). 끌 수 있는 카드는 쓰기 범위 안(`writable !== false`)만. 키보드 · 터치는 상세의 상태 고르기.
  ④ **CSV 는 포탈 규약대로 `requirePerm('data.csv')`**(관리자 · 권한에서 끈다) + 화면 `canCsv()`. 화면 걸러보기 → 서버 매개변수는 `csvParams` 하나(서버가 범위 → 같은 조건으로 다시 거른다).
     값이 없으면 빈 칸(기록 0분을 '0' 으로 쓰지 않는다 — 엑셀 합계).
  ⑤ **SLA 는 서버가 이력에서 계산한 값을 그대로 보인다**(`issues/sla.js slaOf` — 화면이 다시 계산하지 않는다). 기본 꺼짐 · 보류 중 멈춤 · 달력 시간. sla 칸 없는 설정 저장(옛 화면)은
     지금 SLA 설정을 유지한다(`saveIssueSettings`). 알림 기록 'sla:<키>:<단계>' 는 보낸 뒤 쓰고, 더는 넘은 상태가 아니면 지운다(기한 알림의 3일 정리에서 뺀다).
  ⑥ **정정 — 쓰기 응답도 범위로 거른다**: `updateIssue` · `setBlocked` · `setWatch` 가 `viewIssue(…, user)` 로 범위를 넘기지 않아 v2.882 · v2.883 동안 범위 계정의 수정 응답에
     범위 밖 연결 이슈(키 · 제목 · 상태)와 공용 에픽이 실렸다(조회 응답은 정상). 이슈 저장소의 `viewIssue` · `summary` 를 부르는 곳은 **모두 access 를 넘긴다** — 기본값(FULL_ACCESS)에
     기대지 말 것. 회귀 `server/test/wikiIssues2885.test.js` ④(변이 M1 · M2 확인).
- **v2.883 — C-1 기능 모음(시안 ③⑨⑩⑧ 중 A · B 에서 미룬 것)**. 마크다운 파서(`views/wiki/markdown.js`) · `MdView` · 이슈 상세 · 위키 보기/편집 · 필터.
  ① **이슈 본문 · 댓글은 위키 렌더러 + `breaks`**(줄 하나 바꿈 = 줄바꿈). 표준 마크다운대로 그리면 사람이 평문으로 쓴 예전 본문(파트 장애 자동 이슈의 '■' 줄 포함)이 한 줄로 붙는다.
     `BREAKS` 는 `parseMarkdown` 호출 동안만 켜는 모듈 변수다(동기 — 다음 해석에 남지 않는 것을 테스트가 본다).
  ② 문서 목록을 모르는 화면(이슈)은 못 찾은 `[[제목]]` 을 '없는 문서'(빨간 점선)로 단정하지 않고 위키 찾기로 잇는다(`unresolvedAsSearch` — 있는 문서가 빨갛게 보였다, Chromium 판독).
  ③ **체크리스트 체크는 원문 줄 번호로** — 파서가 줄 번호를 들고 다닌다(인용 · 콜아웃 · 중첩 안에서도 · 코드 블록 안은 항목이 아니다). 서버는 `baseVersion` 과 그 줄의 체크 표시를 다시 확인한다.
     줄 판정 `taskMarkAt` 은 웹 · 서버 두 벌이라 `server/test/wikiIssues2883.test.js` ① 이 같은 입력으로 대조한다(한쪽만 고치면 다른 칸이 체크된다).
  ④ 펼친 목록은 떠 있는 상자(absolute)로 두지 말고 그 줄을 통째로 쓴다 — 이슈 찾기 목록이 1440px 에서 화면 오른쪽 끝을 넘어 글자가 잘렸다(Chromium 판독). 키 칩(`.md-iss`)은 줄바꿈하지 않는다.
  ⑤ 완료 전에 서버가 묻는 것(409 `open-children` · `open-blockers`)은 `statusConfirmText` · `STATUS_CONFIRM_FLAG` 하나로 차례로 확인받는다(최대 3번 · 취소하면 아무것도 바꾸지 않는다).
- **v2.909 — 헤더 ⌘K 통합 장비 검색(사용자 요청 '상단 검색창에서 VM · 베어메탈 · 스토리지 등 등록된 모든 인벤토리 장비 검색' · 승인 시안 `docs/design/inventory-search`)**.
  화면 `components/Palette.jsx` · 순수 `components/invSearchQuery.js`(+ test) · 받는 훅 `hooks/useSearchHandoff.js` · 서버 `GET /api/search/inventory`(security-api.md 같은 버전 항목).
  ① **장비 판정(범위 · 권한 · 주소 가림 · 일치)은 서버가 한다** — 팔레트는 응답의 `kinds`(잠금 포함) · `counts` · `groups` 를 그리기만 한다. 기능 · 탭 찾기는 지금처럼 브라우저 안(`palette.js`)이라 장비 색인을 못 읽어도 팔레트는 동작한다.
  ② **이동은 이미 있는 상세 주소 + 검색어 인계**(`hooks/searchHandoff.js` v2.616 — 검색어 · IP · 시리얼을 URL 에 싣지 않는다). VM `#/vcenters/<vc>/vm/<id>` · 호스트 `#/hosts/<id>` · vCenter `#/vcenters/<id>`,
     그 밖은 그 화면 검색 칸으로(`focusPlan` · `listPlan`). ⚠ 해시에 `?q=` 를 붙이지 말 것 — App 의 탭 판정이 `split('/')[0]` 이라 `vms?q=x` 가 탭 이름이 되어 이동이 실패한다(구현 중 확인).
     받는 쪽 target 표(`SCREEN`)와 `useSearchHandoff('<target>'` · `takeSearch('<target>')` · App `INV_FILTER_TABS` 는 글자 그대로 같아야 한다 — `invSearchQuery.test.js` 가 소스로 대조한다.
  ③ 묶음 머리의 ‘모두 보기’ 에 **개수를 쓰지 않는다** — 목적 화면의 필터 규칙이 달라(템플릿 · OS 일치) 수가 다르다(목 실측 41 ↔ 43). 검색 칸이 없는 화면(PDU)은 ‘열기’ 로만.
  ④ 메타는 상태를 법인 바로 뒤에 둔다(끝에 두면 1440 에서 잘린다) · 행 이름은 `flex: 0 0 auto; max-width: 42%`(메타와 함께 줄면 이름이 먼저 잘렸다) · 400px 은 행 2줄 · 칩 가로 스크롤.
  ⑤ 최근 연 항목은 localStorage 10개(`ui.invSearch.recent`) — 읽을 때 `#/` 로 시작하지 않는 주소는 버린다(저장소 값을 믿지 않는다). 새 탭(⌘Enter)은 메모리 인계가 닿지 않아 주소만 연다.
- **v2.911 — ⌘K 통합 장비 검색 개선(완전 일치 우선 · 여러 낱말 AND · 고른 장비 상세 열기 · PDU 검색 칸 · 결과로 돌아가기 · 단축키 OS 표기)** — 설계 `docs/design/inventory-search/README.md` §8.
  ① **한 이동이 여러 칸을 넘긴다** — `hooks/searchHandoff.js handoffMany([[target, 검색어], [target:focus, id]])`. 칸은 target 별이고 새로 남기면 이전 묶음은 모두 버린다(예전 1칸 규칙과 같은 효과).
     받는 쪽은 `useSearchHandoff`(검색 칸) · `useFocusHandoff`(상세) — **items 는 받기 전 undefined/null** 로 줄 것(빈 배열이면 '받았는데 없음' 으로 읽고 고른 장비를 잊는다 — PDU 실측).
     상세 여는 함수가 조기 return 아래에 있으면 ref 로 늦게 묶는다(SanSwitchTool `openDetailRef` — TDZ 를 만들지 않게).
  ② 단축키 글자는 `headerText.js cmdkLabel · modKeyLabel`(Mac ⌘ · 그 밖 Ctrl) — 화면에 ⌘ 를 박지 않는다.
  ③ v2.928 — 새 탭(⌘/Ctrl+Enter) 인계는 **localStorage 일회용 칸 + window.name 번호**(`searchHandoff.stashForNewTab · consumeNewTabHandoff`, main.jsx 가 그리기 전 1회) — 주소에 싣지 않는다.
     새 창은 `window.open(url, name)` 뒤 `w.opener = null` 로 끊는다(이 경로로 Chromium 에서 창 이름 전달을 확인했다 — `noopener` 기능 문자열로 바꿀 때는 창 이름이 살아 있는지 다시 확인할 것). 팔레트 접근성은 combobox + `aria-activedescendant`(포커스를 줄로 옮기지 않는다) ·
     일치 표지(`via` → `VIA_LABEL`)는 줄지 않게(`flex: 0 0 auto`) — 메타와 함께 줄면 일치한 값이 잘린다(1440 실측). 좁은 화면 2줄 메타의 구분자는 ‘· ’(뒤 공백) — 줄이 ‘·’ 로 시작하지 않게.
- **v2.920 — 호스트 상세 ‘SAN 경로·트래픽’ 묶음 · ‘네트워크’ 카드 CVP 열 · SAN 도구 ‘호스트 귀속’ 모달** — 설계 `docs/design/san-cvp-traffic/README.md`:
  ① 묶음 `san` 은 `toolAllowed('san-switch')` 일 때만(hd-nav 도 같이) · 본문 `HostSanSection.jsx` 는 지연 로드(recharts) · 마운트 1회 + 기간 버튼(24h·7일)으로만 받는다(무거운 집계 —
     폴링 금지) · 403 은 `ErrorBox` 가 권한 안내로. 묶음 머리 한 줄은 `hostSanText.sanSubText`.
  ② 네트워크 카드의 `hcfg.net` 변수는 `vnet` 이다(CVP 업링크 응답 `net` 과 이름이 겹쳐 v2.920 에 바꿈). CVP 열 3개(스위치·포트 / 매칭 / 지금 송신·수신)는
     `toolAllowed('cvp')` 일 때만 붙고, NIC 미확정(호스트 이름만 맞은) 포트는 열이 아니라 아래 블록(`HostNetCvp.jsx`)에 'NIC 미확정' 으로 둔다.
  ③ 확정(●)·추정(◐) 글리프와 배지 색은 `hostSanText.CONF` 하나(서버 `attribution.js` 신뢰도 키와 같다) — 확정분·추정분 열을 합치지 않고, 측정 없음은 '—'.
  ④ SAN 도구의 '호스트 귀속' 은 헤더 버튼 + `Modal`(폭 1240)이고 창 안에서 법인 칩을 바꾼다(`DcStoragePerf` 와 같은 이유). 표 제목 정렬은 `sanHostAttribText.sortRows`(null 뒤로).

- **v2.942(코드 · 테스트 표지는 v2.915 — main 이 v2.941 까지 먼저 나가 번호만 올렸다) — '서버 › 가상화 플랫폼' 허브(가상화 서버 · ESXi 호스트 · vCenter 세 메뉴 → 하나 · 사용자 요청 2026-11-07 · 설계 `docs/design/virt-platform-menu/README.md` 시안 A · 컨펌 '이름 가상화 플랫폼 · 표준 검증')**.
  ① **탭 id(vcenters · hosts · vms) · 해시 · 권한 id · 도구 키는 그대로** — 합친 것은 메뉴 층뿐이다. `topMenu.js` 항목 `{ tab:'vcenters', tabs:['hosts','vms'], also:[도구 16] }` · `tabsOf(item)` 이 항목의 탭 전부 ·
     `locate` 는 tabs 도 그 항목으로 · `visibleMenu` 는 **하나라도 허용이면** 보이고 처음 여는 탭은 허용된 것 중 첫째(`entryTab` — `hashOf` 가 읽는다). 권한 판정은 바뀌지 않는다(App `isAllowed` 그대로).
  ② **저장 메뉴 별칭**(`sidebar/sideMenu.js itemAliases` — `tab:hosts` · `tab:vms` → 가상화 플랫폼 항목): 서버는 주소만 저장하고 탭 실재를 모르므로 별칭이 없으면 옛 항목이 `unknown` 으로 조용히 사라진다.
     별칭 키는 `missingDefaults`('다시 넣기') 후보가 아니다. 그룹 별칭(`LEGACY_GROUP_LABELS`)과 별개 — 항목 별칭은 이것이 처음.
  ③ **허브 셸은 App 이 세 탭 위에 그린다**(`views/platform/PlatformHub.jsx` — 제목 · 엔티티 탭 3 · 바로가기 칩). 상세 · 개체 보기(`#/vcenters/<id>…`)로 내려가면 허브 · 범위 바를 그리지 않는다(브레드크럼이 대신 — `vcDrill`).
     숫자는 서버 `/platform/summary` 하나(`inventory/platformSummary.js` · memoJson 30초 · 범위 · 권한 · 설정 개정이 캐시 키) — 탭 배지를 위해 `/hosts/checks` 같은 무거운 집계를 다시 부르지 않는다.
     응답 전 · 첫 수집 중 · 권한 없음은 **'—'**(0 금지 · `platformText.entityTabs`). 호스트 확인 대상 판정은 웹 `hostTriage.hostReasons` 와 같은 세 규칙(서버 `hostReasonKinds` — `platformHub2915.test.js` ① 이 같은 입력으로 대조).
  ④ **범위(리전 · vCenter · 검색)는 세 탭이 한 칸(`PLATFORM_SCOPE_KEY`)으로 공유**하고 탭 고유 조건(상태 · 전원 · 메모 · IPMS · 호스트)은 그 탭 칸에 남는다(`patchFilter` 가 키를 나눈다). vCenter 탭도 범위 바를 쓴다(`noFilterTabs` 에서 뺐다 — 카드를 범위로 거른다).
     공용 바 문구는 `platformText.SCOPE_SEARCH_PLACEHOLDER · SCOPE_NOTE` 하나. ⌘K 인계 target 에 'vcenters' 가 들어갔다(`INV_FILTER_TABS`).
  ⑤ **탭 줄은 하나**(`views/platform/HubTabs.jsx` — v2.909 `VmHubTabs` 를 일반화 · 모양 `.vmh-tabs` 그대로): 이 화면 안의 보기 ‖ 그 탭 성격의 특수 기능(권한 없는 도구 숨김) ‖ 오른쪽 = 탭 고유 조건. 도구 목록은 `platformText.VC_TOOLS · HOST_TOOLS`(VM 6 은 `vmHubText.HUB_TOOLS`).
     도구 라벨 줄 여백은 10px(`.vmh-tab.tool`) — 1440 에서 도구 6 + 조건이 한 줄에 들어가게(글자는 '메모' · 'IPMS' 로 짧게 — 뜻은 title).
  ⑥ **상세 한 규칙**: 호스트 표 · VM 표의 이름 = 개체 보기(`vcHash(vc, {type,id})` — 브레드크럼). 전체 페이지 상세(`#/hosts/<id>`)는 개체 보기 안 버튼, VM 드로어는 이름 옆 '빠른 확인'(`VmNameCell href`). 주소는 전부 그대로 산다.
     브레드크럼은 `가상화 플랫폼 › vCenter › <vCenter> › …`(`VCenterDetail` · `ObjectShell`) + ‹ 이전 · 다음 › vCenter(`VCenters.siblingsOf` — 목록 순서).
  ⑦ **교차 링크**: vCenter 카드 · 표의 호스트 · VM 수 → 허브 범위를 그 법인으로 + 탭 이동(`onSelectSite` — v2.914 까지 선언만 되고 호출되지 않던 prop · `onGoVms`) · 호스트 표 VM 수 → VM 탭 `?host=`(App `vmHost`) · VM 표 호스트 → 호스트 탭 이름 일치(`nameFocus`). 칩으로 해제 · '필터 초기화' 가 함께 지운다.
  ⑧ **백업 칸은 Veeam / Bareos**(사용자 지시 — 스냅샷 제외): Veeam 수는 v2.778.1 `backupPairCell` 의 앞 수 그대로, Bareos 는 `/tools/bareos-summary` 법인 줄 `counts.jobs`(도구 권한이 있을 때만 · 못 읽으면 '—') — `VCenters.backupVbCell`. 호스트 표 '백업' 열은 Veeam 뿐(Bareos 호스트별 수는 수집 없음 — 2차).
  ⑨ vCenter 탭 보기는 **카드 | 표**(`platform/VcTable.jsx` — 법인별 비교 · `/vcenters` + 허브 요약만 · 새 집계 없음 · localStorage `platform.vcView`). '트리' 보기와 호스트 · VM 탭 '법인별' 흡수는 2차(README §4.0-12·13).
     마지막 본 탭은 `platform.tab`, 바로가기 접힘은 `platform.chips`(전부 try/catch). 400px: 엔티티 탭 3칸 한 줄(수 + 이름 + 배지 — `.ph-tab .parts` 숨김 · 열린 탭의 분해는 아래 한 줄) · KPI 한 줄(`kpis-1row`)은 720 미만에서 세로로(추이 스파크 130px 가 넘쳤다 — Chromium 실측 8px).
  ⑩ 기능 사용 현황(`featureUsageText.js menuIndex`)은 `tabs` 도 같은 자리로 센다(`tab:vms` 키 그대로 · 이름 '가상화 플랫폼 › 가상화 서버 · VM').
  ⑪ **v2.994 에서 이름 · 항목 분리가 바뀌었다** — 아래 'v2.994 서버 메뉴 이름 변경' 항목이 우선한다(①의 항목 모양 · ②의 별칭 방향 · ⑨의 '마지막 본 탭' 기억 · ⑥의 브레드크럼 뿌리 이름).

- **v2.997.0(코드 · 테스트 표지는 v2.994 — main 이 v2.996 까지 먼저 나가 번호만 올렸다) — 서버 메뉴 이름 변경: Virtual Machine(VM) · Hypervisor · Bare Metal Server · Physical Server(사용자 요청 2026-11-13 · 설계 `docs/design/server-menu-rename/README.md` · 컨펌 '추천대로 전부 진행')**.
  회귀 `web/src/views/topMenu.test.js`(구성 · locate · 진입 탭 `menuTabOf` · aka 검색) · `sidebar/{sideMenu,singleMenu2891,menuEdit}.test.js`(옛 저장 메뉴 두 모양) · `platform/platformText.test.js`(허브 제목 = 메뉴 라벨) · `featureUsageText.test.js` · `server/test/platformHub2915.test.js` ④.
  ① **바꾸지 않은 것**: 탭 id(vcenters · hosts · vms) · 해시 · 권한 id · 도구 키(serveranalysis · bm-folders · 호스트 도구 4 등) · 저장 형식. 옛 이름은 카탈로그 `aka`('서버 분석' · '서버분석' · '물리서버 폴더' · '물리 서버 폴더').
  ② **메뉴**(`topMenu.js` 서버 그룹): `virt` = 'Virtual Machine(VM)' · `tab:'vms'` · `tabs:['vcenters']` · also = VM 6 + vCenter 6 / 새 항목 `hv` = 'Hypervisor' · `tab:'hosts'` · also = 호스트 4(host-hygiene · esxi · hba · cluster-check) /
     `bm` = 'Physical Server · Baremetal'(id · tool · seg 그대로) / 자원관리 `sa` = 'Physical Server'. 도구 목록은 `platformText.VM_ITEM_TOOL_KEYS` · `HV_ITEM_TOOL_KEYS`(합 = `PLATFORM_TOOL_KEYS`)와 테스트가 대조한다.
  ③ **저장 메뉴 별칭 방향이 바뀌었다**: `itemAliases` 는 topMenu `tabs` 에서만 만든다 → 이제 `tab:vcenters → tab:vms`(virt) 하나. 옛 저장 메뉴 — v2.942~v2.993 의 `tab:vcenters` 하나는 virt 로,
     그 이전의 `tab:vms` · `tab:hosts` · `tab:vcenters` 셋은 virt · hv 둘로 풀린다(중복 없음 · unknown 0). `tab:hosts` 는 **별칭이 아니라 실제 항목**이다. 별칭 키를 sideMenu 에 따로 적지 말 것.
     저장 메뉴에 Hypervisor 를 **자동으로 넣지 않는다**(결정 4) — `missingDefaults` 의 '다시 넣기' 후보로 나온다(넣기 전에는 #/hosts 에서 켜지는 항목이 없다).
  ④ **메뉴 클릭 = 그 항목의 처음 허용 탭**(`topMenu.menuTabOf` — visibleMenu 의 `entryTab` → `tab`): Virtual Machine(VM) → VM 탭(inv.vms 가 없으면 vCenter 탭) · Hypervisor → 호스트 탭.
     v2.915~v2.993 의 '마지막으로 본 탭' 기억(`loadLastTab` · `saveLastTab` · localStorage `platform.tab`)과 허브 헤더 문구 '마지막으로 본 탭을 기억합니다'는 **지웠다** — 되살리지 말 것(두 항목이 같은 기억을 나누면 Hypervisor 를 눌러 VM 탭이 열린다).
     vCenter 탭으로 갈 때 드릴다운을 닫는 재클릭 신호(`setPlatformResetSeq`)는 그대로.
  ⑤ **허브 이름은 메뉴 라벨 하나에서**: 제목 `<h1>` · `aria-label` · 경로 뿌리(`vcd/ObjectShell.jsx` · `VCenterDetail.jsx`)는 `platformText.platformMenuLabel(tab)` 이 MENU_GROUPS 라벨을 읽는다(v2.915 상수 `PLATFORM_MENU_LABEL` 은 없앴다).
     호스트 탭 = 'Hypervisor', vCenter · VM 탭 = 'Virtual Machine(VM)'. 호스트 개체 보기도 주소가 `#/vcenters/<vc>/host/<id>` 라 경로 뿌리는 'Virtual Machine(VM)'(locate 가 virt).
     탭 줄 이름은 `PLATFORM_TABS`(label + sub) 하나 — 'vCenter · 법인' · 'Hypervisor · ESXi 호스트' · 'Virtual Machine · VM'(`entityTabs` 도 여기서 읽는다).
  ⑥ **위치 안내 문구**: '서버 분석 › …' → 'Physical Server › …'(통합 검색 화면 이름 `invSearchQuery.LIST_SCREEN` · `TO_LABEL` 은 웹 한 벌 · 서버 `dbGuideData` · `hwExport/xlsx` 안내) ·
     '특수 기능 › 물리서버 폴더' → '특수 기능 › Bare Metal Server' · BmFolders 화면 제목. **개념 이름은 그대로**: '물리서버 폴더 규칙'(서비스 인벤토리 `SRC_LABEL` — 서버 `svcInventory.js` 와 두 벌) ·
     저장소 손상 · 이름 변경/삭제 결과 문구 · 일반 용어 '물리 서버'(Overview 카드 · 법인별 서버 사용량 역할 이름). 도구 이름 안의 'ESXi'(ESXi 호스트 구성 점검 · ESXi 버전별)도 그대로.

- **리눅스 성능 7b단계 설정 › 베어메탈 성능 › 서버 등록(`web/src/views/tools/BmOnboardPanel.jsx` · 문구 `bmOnboardText.js` · `bmOnboard.css` · vitest `bmOnboardText.test.jsx`)**:
  - 순서: SSH 키 저장소 → 법인 공통 계정 → CSV · Excel 등록(파일 → 분석 표 → 결과 CSV · 적용) → 엣지 배포 목록(중앙) → 누락 점검. 마운트 1회 + 버튼(폴링 없음) · 늦은 응답은 gen 으로 버린다.
  - 판정은 서버 값 그대로(행 action · code · reason · warnings · 누락 bucket · 수집 건강 `rttHigh`) — 화면이 800ms 를 다시 판정하지 않는다(테스트가 rttHigh false + 1000ms 를 고정).
  - 키 · 공통 계정 관리 폼은 `settingsOwnerTier`(소유자 ∧ 전체 범위)일 때만 그린다(`isSettingsOwner` 아님 — server/CLAUDE.md) · 서버가 다시 막는다.
  - postJson 은 409 를, delJson(sendJson)은 400 · 409 를 던지지 않는다 — 결과마다 `r?.ok === false` 를 먼저 본다(분석 서명 409 · 사용 중 키 409).
  - 개인키 · passphrase · 비밀번호 입력 칸은 `autoComplete="new-password"`/`off` · 보낸 뒤 비운다 · OTP 는 실패해도 비운다(1회용 — 같은 코드 재시도는 잠금만 올린다).
  - 모르는 수(null — 사용처를 모름 · 인출 기록 없음)는 ‘—’ / ‘모름’ 이다(0 · 반영됨으로 지어내지 않는다). 분석 표는 `STable limit={500}`(정렬 뒤 자름) · 전체는 결과 CSV.
  - (r2) 분석 요약 `needOwner` 가 있으면 적용 옆에 **본인 OTP** 칸(1회용 — 실패해도 비운다) · 호스트키 정책 observe 안내 문구(`HOSTKEY_OBSERVE_NOTE`) · 범위 계정 키 목록 숨김 안내 ·
    iDRAC 공통 계정 '복사 방식' · 비밀번호 변경 시 사본 수(`copiesStale`) 안내 · 누락 점검 칸 'OS 만 — 성능 수집 안 됨' · 엣지 배포 '제거 대기 n'.
    베어메탈 스토리지 서버 폼(`BmStorageTool.jsx`)에 **인증(SSH 키 · 공통 계정) 드롭다운** — `settingsOwnerTier` 에만 보이고, 묶음이 바뀌면 본인 OTP 칸 · 바뀌지 않으면 참조 칸을 보내지 않는다(`authBodyOf`).

- ⚠⚠ **리눅스 성능 8a단계 화면 — 설정 › 정비 창 · 알림 억제 / 함대 ‘용량 예측’ / 상세 용량 카드 / 추이 음영 · 변경 이벤트 묶음 / 수집 건강 정비 행 / 보드 KPI**
  (`web/src/views/tools/{BmMaintPanel,BmCapacityFleet}.jsx` · `bmMaintText.js` · `bmCapacityText.js` · `bmMaint.css` · `BmTrendChart(mbands)` · `BmTrendOps ChangeTable(maintBands)` · `BmCollectHealth` · `BmPerfBoard` ·
  회귀 `bmMaint8a.test.jsx` — 문구 표 = 서버 열거 · 폼 본문이 서버 `normalizeWindow` 를 그대로 통과 · SSR · 소스 스윕):
  - **웹은 시간대 · 일정 · 회귀를 계산하지 않는다** — 상태 · 남은 시간 · 다음 발생 · 벽시계 표기는 목록 응답, 미리보기(다음 5회 · DST 표지)는 `POST /maintenance/preview`, 예측은 서버 행 그대로(스윕: `timeZone:` · 회귀 함수 이름 · `setInterval` 0).
  - 버튼은 서버가 준 `canEdit · canEnd · canConfirm · canDelete` 로만 연다(소유자 등급 창은 운영자에게 잠김 — 서버가 다시 막는다) · 쓰기 응답 400/409 는 본문 `ok:false` 로 온다(api.js) — 둘 다 사유를 그대로.
  - 숫자(길이 상한 · 소유자 기준 · 재확인 일수 · 배포 시한 · 재계산 시각 · 목표선 · 알림 N일)는 API `limits` · `cfg` 값만 — 문구에 박지 않는다.
  - **못 읽음 ≠ 0**: 데이터 부족 · 불안정 · 증가 없음 · 상한 없음은 그 글자(‘0일’ 금지) · 출처가 구버전 · 계산 전 · 손상이면 행 대신 표지 · 보드 KPI 는 계산된 출처가 없으면 ‘—’.
  - 추이 음영은 서버 `occurrences.merged` 를 주황 낮은 불투명도로(결측 띠 아래) · 변경 이벤트는 같은 구간으로 ‘정비 창 안’ 묶음(위) · 조회는 창이 바뀔 때 1회.
  - 상세 용량 카드의 로딩 문구는 ‘용량 예측을 읽는 중…’(상세 본문의 ‘불러오는 중’ 과 구분 — bmPerfText D8 시험). 일 날짜 글자는 `toISOString().slice` 대신 직접 조립(dayStamp 스윕).
  - **8a 반증 뒤**: 서버 창 폼에 법인 고르기(‘자동 — 키로 찾기’ 가 기본 · 고치기에서는 잠금 — 서버 대상은 (법인, 키) 쌍) · 승인 안내에 ‘같은 서버를 덮는 창들(소유자 창 · 법인 · 태그 창 포함)의 합’ 규칙(숫자는 `limits`) ·
    점검 문구에 잡는 것(창 끝 · 길이 상한 · 지움 · 끝내기 · 재확인 만료 · 배포본 시한)과 못 잡는 것(판정 규칙 자체) · 용량 ‘현재’ 칸은 오래된 관측에 ‘(n일 전)’ · 메모에 일상 몫(분) ·
    출처 줄에 상한 내역(계산 안 한 서버 n대 · 마운트 일부만 n대) · 도달 행인데 추세를 못 쓰면 기울기 ‘—’.
  - **수집 건강 법인별 표 1440 열 숨김 수정**(6단계 첫 커밋부터 `STable minWidth 1100` · 열 10개라 본문 약 1,080px 에서 ‘상태’ 열이 잘렸다 — 8a 반증 확인): 최소 폭 960 · 노드 칸 줄바꿈(최대 200px) —
    1440 에서 열마다 오른쪽 끝 좌표가 표 영역 안 · 400 은 표 안 가로 스크롤.
- ⚠⚠ **리눅스 성능 8b단계 화면 — 추이 팝업 ‘이 시점 프로세스’ · 시간 × 프로세스 띠 / 함대 ‘저활용 서버’ · ‘전력 · 온도’ / 설정 Top-N · 저활용 · 전력 · 랙 배치**
  (`web/src/views/tools/{BmTopProc,BmIdleFleet,BmPowerFleet}.jsx` · 문구 `bmTopText.js` · `bmIdleText.js` · `bmPowerText.js` · 회귀 `bmPerf8b.test.jsx`):
  - 웹은 점수 · 합 · 피크 · 단서 · 지속 · PID 재사용을 **다시 계산하지 않는다**(소스 스윕) — 문구 표는 서버 열거와 1:1(시험이 대조). 전력 화면은 `.reduce(` 로 합을 내지 않는다.
  - 못 읽음 ≠ 0: 권한 없는 I/O = ‘권한’ · 값 없음 = ‘—’(단위 없음) · 그 시각 표본 없음 = 문장(0 으로 그리지 않음) · 미측정은 사유별 수 · 랙 여유 음수는 ‘상한 초과 n%’ · 지난 30일은 계산 이력이 30일 안 되면 ‘—’.
  - 팝업의 프로세스 표 기본 시각 = 누른 점 → 창의 피크 시각 → 창 끝 · ◀ ▶ = 서버가 준 앞뒤 표본 · 띠 막대를 누르면 그 표본 · 조회는 시각 · 창이 바뀔 때 1회(세대로 늦은 응답 버림 · 폴링 없음).
  - 띠 막대는 최소 폭 4 · 창 끝 표본이 그림 밖으로 잘리지 않게 [0, 폭 − w] 안(r1 판독 결함). 1440 에서 저활용 표 열이 숨지 않게 minWidth 1040(r1 판독: ‘검토’ 열이 잘렸다) · 400 은 표 안 스크롤 · 페이지 넘침 0.
  - 랙 배치는 텍스트 상자(서버가 만든 `racksText` 를 보이고 고친 텍스트를 보낸다 — 웹이 형식을 해석하지 않는다).
  - 반증 F3 · F6 · F8: 이 시점 프로세스는 `reason: 'base-missing'` 이면 ‘상위 행이 없습니다’ 를 띄우지 않고 ‘**읽지 못했습니다** … ‘없다’ 는 뜻이 아닙니다’ · 바닥 줄은 ‘나머지 합계’ 대신 전 프로세스 합만 ·
    띠는 `baseMissing` 수를 적는다 · 랙 여유 칸은 `marginPartial` 이면 ‘일부만 측정(n/m)’(낮음 색 없음 — `low === true` 만 빨강) · 여유 최소 카드는 부분 랙 수를 적는다 · 엣지 버전 안내는 `kind === 'old-version'` 일 때만.
- **v2.953 SAN 스토리지 성능 2차 화면(`SanStorageTool.jsx` CrossView · 기준선 표시 · `SanStorageCheck.jsx` NotifyModal · ReportModal)**
  - 보기 전환 상태(`view`)는 ListTab 의 **조기 return 위**에 둔다(eslint rules-of-hooks 가 잡았다). 교차 보기 표는 STable · 사분면 라벨은 표시 규칙(각주) · 짝 없으면 '—' · 일수는 `daysText`(10년 이상은 문구).
  - 기준선 표시는 서버 `baseline.applicable` 일 때만(범례 '평소와 다름 n/m칸' · 차트 고리 · 히트맵 테두리 `.sst-hm i.off`). 데모는 벗어난 칸이 없으니 표시 자체는 단위 시험으로 확인한다고 적는다.
  - 알림 · 보고서 모달은 `putJson/postJson` 의 **반환값(`ok === false`)을 보고** 실패를 알린다 · 미리보기는 `downloadFile`(토큰 헤더 — `window.open` 금지) · 보내기 409 는 '보내지 않음' 문구.
  - 상태 알약 `.sst-pill` 은 600px 이하에서 줄바꿈(`white-space: normal`) — 400px 에서 잘리던 것(PR ⓐ 때부터). 1440 은 한 줄 그대로.
- **v2.955 SAN 스토리지 성능 3차 화면(이력 모달 · 임의 구간 · ⌘K 행 · Flow 인계 · PDF 저장)**
  - 이력 모달은 서버 `available:false` 를 `sst-info` 로 그대로 보인다(빈 표 금지) · 표는 STable · 어레이 이름은 `.sst-link` 글자 단추로 상세 열기(새 표 틀 없음).
  - 임의 구간 입력은 `datetime-local` 둘 + '구간 보기'(검증: 둘 다 · 시작<끝 · ≤366일 — 서버 상한과 같다) · 구간 중 ◀ ▶ 비활성 · 기간 세그를 누르면 구간 해제. 400px 은 `.sst-custom` 줄바꿈.
  - 검색어 · WWN 은 해시에 싣지 않고 `handoffMany` 로 넘긴다(받는 쪽 `useSearchHandoff('san-storage' | 'san-flow:targets')`). 팔레트 추가 행은 `lockOf('san-storage')` 가 잠긴 계정에는 보이지 않는다.
  - 'PDF 로 저장' 은 `reportExport.saveDocAsPdf` 동적 import — 평소 번들에 jsPDF 가 실리지 않는다 · 문서 모델은 `reportPdfDoc`(순수 · 시험) · 표시 글자는 `PDF_MARK`(KS X 1001 안).
- **v2.958 — 가상화 플랫폼 허브: 법인 클릭 → vCenter ‘요약’ 탭 · 상세 탭 ‘호스트 및 클러스터’ · ‘VM’ 강조 · KPI 줄은 허브 범위만 합산**(사용자 요청 2026-11-10):
  ① 허브의 vCenter 카드 · 표 이름을 누르면 상세가 **‘요약’ 부터** 열린다(`vcd/vcdTabs.js HUB_ENTRY_TAB · entryTab` — 기억값으로도 남겨 새로고침이 같은 탭). 주소로 바로 · 뒤로 가기 · ‹ 이전 · 다음 › vCenter 는 마지막 본 탭 그대로(`VCenters.setOpenId(id, tab)` 의 tab 이 null). 바로가기 칩은 범위 전환 그대로.
  ② 상세 탭 줄의 ‘호스트 및 클러스터’ · ‘VM’ 은 열려 있지 않을 때 `.vcd-tab-hot`(`tabClass`) — 2초 펄스 + 점. **모션 줄임이면 정지 강조만**(styles.css `@media (prefers-reduced-motion: reduce)`). 점멸(깜빡임)은 쓰지 않았다(피로 — 사용자가 원하면 keyframes 만 바꾼다).
  ③ vCenter 탭 KPI 줄(VM 백업 · VM 증가 · 스토리지 증가)은 **허브 범위(리전 · vCenter) 안의 법인만** 합한다 — `countableTotals(inScope)` · `backupTotals(byVc, 범위 id)` · Bareos 는 범위면 `platformText.bareosSumOf`(법인 줄 합 · 못 읽은 법인은 따로) · 추이는 `/tools/vm-track?vcenterId=|region=`(서버 `vmtrack/scopeIds.js` — 사용자 범위와 교집합). 검색어는 범위가 아니라 KPI 에 걸지 않는다. 문구 머리는 `scopeLabel`(전체 / 이름 / ‘리전 X · N법인’).
- **v2.959 — 가상화 플랫폼 KPI 카드 클릭은 고른 법인으로 연다**(사용자 요청 2026-11-10): 법인(vCenter)을 고른 상태에서 ‘VM 증가 추이’ · ‘스토리지 증가 추이’ 카드를 누르면 그 도구가 **그 vCenter 를 고른 채** 열린다 —
  `platformText.KPI_HANDOFF`(`vm-track:vcenter` · `storage-track:vcenter`) 로 `hooks/searchHandoff` 메모리 인계(URL 에 싣지 않는다 · 30초 · 꺼내면 지운다) · 받는 도구는 `useState(() => takeKpiVcenter(…))` 로 마운트 때 1회.
  ‘VM 백업’ 카드는 법인을 골랐으면 Backup 현황 · Detail(`backupViewText.openBackupDetail` — 서머리의 openDetail 과 같은 키 `backup-detail-vc`), 아니면 Summary. 도구 권한이 없으면 누를 수 없다(커서 · 제목 없음). 리전만 골랐으면 전체로 연다(도구에 리전 선택이 없다).
  새 인계 target 을 ⌘K 의 `invSearchQuery SCREEN` 표에 넣지 않는다(검색 인계가 아니다) — `useSearchHandoff` 훅 대신 `takeSearch` 를 직접 쓴 이유.
