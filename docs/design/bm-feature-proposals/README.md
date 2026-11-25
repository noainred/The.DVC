# 제안: 물리서버 기능 13가지 — 다른 모니터링 제품 5곳에는 있고 포탈에는 없는 것

- 상태: **제안 · 시안 — 컨펌 대기(구현 전)**. 작성 2026-11-26 07:44~07:55 KST · main v3.39.0(`a820eed0`) 기준.
- 캔버스(Claude Design): https://claude.ai/artifact/5iT45BoB1uaSth5AkeaAjm (비공개 — 소유자만 열 수 있다)
- 아트보드 원본: 이 폴더의 `*.dc.html` 4개 + `fp.css`. 캔버스 렌더는 직접 열어 확인하지 않았다(Design 유형 규칙).
- 색 · 글자는 `web/src/styles.css` `:root` 토큰 그대로. 계정의 ‘Design System’ 아티팩트는 `project/` 파일이 없어 쓰지 않았다(2026-11-25 파일 목록으로 확인).
- 앞선 설계: `docs/design/bm-drawer/`(물리서버 상세 드로어 — 이 제안의 대부분이 그 드로어의 구역으로 들어간다).

## 1. 요구(사용자 2026-11-26 07:44 KST)

> "개선 하면 좋은 기능, 추가하면 좋은 기능, 모니터링 솔루션 업체 5개 찾아서, 여기서 구현하지 않은 기능 10개 이상 찾아서 제안해줘"
> "10개 이상 찾은거 시안 만들어서 보여줘"

해석(내 판단): 직전 작업이 물리서버 상세 창이라 **물리서버(베어메탈) 모니터링**에 한정했다. 포탈 전체(VM · 스토리지 · 네트워크 · 백업)로 넓힌 비교는 하지 않았다.

## 2. 조사한 업체 5곳(웹 검색 2026-11-26 — 업체 문서 · 소개 글 기준)

| 업체 · 제품 | 검색으로 확인한 것 | 확인하지 못한 것 |
|---|---|---|
| Dell — OpenManage Enterprise(+ Services 플러그인 · AIOps) | 펌웨어 · 구성 기준선과 준수 점검 · 보증 · 라이선스 보고 · 전력 관리(탄소 발자국) · 장애 때 지원 케이스 자동 접수와 부품 발송 · 가상 콘솔 열기 · 장비 하드웨어 로그(안내서 절 제목) · 건강 점수(100 에서 감점) | 웹 콘솔의 전원 조작 · LED 켜기(모바일 앱 안내서에서만 제목 확인) |
| HPE — OneView · Compute Ops Management · InfoSight | 인벤토리 · 상태 통합 보기 · 펌웨어 준수 대시보드(보안 갱신 찾기 · 구성 편차 방지) · 케이스 자동 접수 · 계약 만료 주간 알림 · 탄소 발자국 보고 · 부품 장애 예측 분석 | 메모리 · 디스크 수명별 예측의 구체 내용 |
| Zabbix | IPMI · SNMP(트랩 수신 포함) 수집 · 트리거 의존 관계 · 이벤트 상관 · 단계별 알림(원격 명령 포함) · 예측 함수(forecast · timeleft) | SLA 보고 · 정비 기간의 세부 |
| Datadog | 이상 탐지 · 묶음 대비 이상치(outlier) · 예측 알림 · Watchdog 원인 분석 · 호스트 맵 · SLO 알림 · 당직(단계 정책 · 일정) | 자동 조치(Workflow) · 노트북 |
| SolarWinds — Server & Application Monitor | 하드웨어 상태(팬 · 온도 · 전원 · 배터리 · 디스크) · 자산 인벤토리 · 지표 겹쳐 보기(PerfStack) · 단계별 알림(커뮤니티 글) | 보증 만료 보고 · AppStack 의존 지도 |

출처: [Dell OME 안내서](https://dl.dell.com/topicspdf/dell-openmanage-enterprise_users-guide3_en-us.pdf) · [OME 지원 문서](https://www.dell.com/support/kbdoc/en-us/000175879/support-for-openmanage-enterprise) · [OME 4.6 도움말](https://www.dell.com/support/manuals/en-us/dell-openmanage-enterprise/ome_4_6_online_help_user_guide) · [OME Services](https://www.dell.com/support/kbdoc/000180961/support-for-dell-emc-openmanage-enterprise-supportassist) · [OpenManage 소개서](https://www.delltechnologies.com/asset/en-ke/products/servers/briefs-summaries/openmanage-brochure.pdf) · [Dell AIOps 건강 점수](https://www.dell.com/support/kbdoc/en-us/000206380/cloudiq-health-score-in-myservice360?lang=en) · [HPE OneView](https://www.hpe.com/us/en/what-is/oneview.html) · [HPE 탄소 발자국 보고](https://community.hpe.com/t5/compute-ops-management/carbon-footprint-reports-get-the-details/m-p/7176691) · [HPE InfoSight for Servers](https://community.hpe.com/t5/Servers-The-Right-Compute/HPE-InfoSight-for-servers-how-we-re-expanding-the-portfolio/ba-p/7028546) · [Zabbix 기능](https://www.zabbix.com/documentation/7.4/en/manual/introduction/features) · [Zabbix 예측 함수](https://www.zabbix.com/documentation/7.4/en/manual/config/triggers/prediction) · [Datadog 모니터 종류](https://docs.datadoghq.com/monitors/monitor_types/) · [Datadog Watchdog](https://www.datadoghq.com/product/watchdog/) · [Datadog 당직 단계 정책](https://docs.datadoghq.com/incident_response/on-call/escalation_policies/) · [SolarWinds 하드웨어 상태](https://documentation.solarwinds.com/en/success_center/SAM/Content/Onboarding/Monitor%20Your%20Environment/Monitor%20Hardware%20Health.htm) · [SolarWinds PerfStack](https://www.solarwinds.com/perfstack) · [SolarWinds 단계별 알림](https://thwack.solarwinds.com/discussion/145661/alert-escalation-using-alerts-to-provide-active-network-fault-management)

⚠ 업체 기능은 **그 업체가 쓴 글**을 옮긴 것이다 — 실제 제품을 써서 확인하지 않았다.

## 3. 포탈에 없는 기능 13가지(코드로 확인 — 낱말 검색 `server/src` · `web/src`, 테스트 · 목 · 릴리스 노트 제외)

| # | 기능 | 근거 업체 | 포탈 지금(근거) | 필요한 것 · 위험 | 크기(추정) |
|---|---|---|---|---|---|
| ① | 보증 · 계약 만료 추적 | Dell · HPE | 없음 — `warranty` · `보증 만료` 0건. 릴리스 노트가 정기 점검 보고에서 ‘보증 만료 = 수집 없음’ 이라 밝힘 | 자산 원장(CSV) 가져오기. 제조사 조회는 포탈이 인터넷에 나갈 때만 | 낮음~보통 |
| ② | 펌웨어 기준선 준수 | Dell · HPE | 목록은 읽음(`idrac/redfish.js:1022` `inv.firmware` · iDRAC 상세 ‘versions’ 탭) · 기준 대조 없음(릴리스 노트 ‘펌웨어 기준선 = 수집 없음’) | 기준 = 같은 모델 다수 버전 또는 관리자 지정. 엣지 서버의 펌웨어 목록이 중앙에 오는지 확인 필요 | 보통 |
| ③ | BIOS 설정 편차 | Dell · HPE | 설정 19개는 읽음(`idrac/biosKeys.js`) · 서버끼리 비교 없음(ESXi 호스트는 `hostcfg` 에 있음) | 같은 폴더 · 같은 모델 다수 값 비교 — 새 수집 없음 | 보통 |
| ④ | 펌웨어 보안 권고 대조(iDRAC · BIOS) | HPE | ESXi · vCenter 만 있음(`insights/cve.js` — 권고 표 내장) | 권고 표를 사람이 확인해 싣는 유지 부담 | 보통 |
| ⑤ | 하드웨어 이벤트 로그 보기 | Dell | 디스크 배드 섹터 분석에만 읽음(`diskbad/sel.js` · `diskbad/probe.js` Lclog) · 전체 보기 없음 | 같은 읽기 경로 재사용 · 원문 보관 범위 결정 | 보통 |
| ⑥ | 위치 LED 켜기 · 가상 콘솔 열기 | Dell | LED 상태는 읽음(`redfish.js:618`)인데 화면이 쓰지 않음 · 켜기 없음 · 가상 콘솔 0건 | 켜기는 장비 상태를 바꾸는 동작(권한 · 감사) | 표시 낮음 · 켜기 보통 |
| ⑦ | 원격 전원 조작 | Dell(모바일 앱) · Zabbix(원격 명령) | 없음 — `ComputerSystem.Reset` 0건 | **위험**: 운영 서버를 끌 수 있다. 전체 범위 관리자 · OTP · 이름 재입력 · 반증 검토 | 높음 |
| ⑧ | 부품 수명 지표(SSD 잔여 수명 · 메모리 교정 오류) | HPE · Dell | 디스크 누적 값(재할당 · 보류 · 복구 불가)만(`diskbad/diskvals.js`) · SSD 수명은 목 데이터에만 · 메모리 교정 오류 0건 | 새 수집 · 장비가 값을 주는지 실제 iDRAC 로 확인 | 보통~높음 |
| ⑨ | 같은 묶음 서버와 다른 서버 찾기 | Datadog | 자기 평소 대비만(`insights/anomaly.js` — 호스트 온도 · GPU · 데이터스토어) · `outlier` 0건 | 계산만(사용률 · 전력 · 온도는 이미 있음) | 보통 |
| ⑩ | 서버 건강 점수 | Dell AIOps | 스토리지 점검에만 분류가 있음(`storage/inspect/catalog.js`) · 서버 점수 없음 | 감점 표 결정 · 못 읽은 항목 처리 | 보통 |
| ⑪ | 알림 단계 올리기 · 당직 일정 | Zabbix · Datadog · SolarWinds | 채널은 있음(`alerts.js` — 메일 · Slack · Teams · 웹훅) · 단계 · 당직 0건 | 확인(ack) 상태 · 일정 저장 | 보통~높음 |
| ⑫ | 제조사 지원 케이스 연동 | Dell · HPE | 없음 — 케이스 번호 · SupportAssist 0건(부품 장애 → 포탈 이슈 자동 만들기는 있음) | 기본안은 자료 묶음 + 번호 추적(직접 접수 아님) | 낮음~보통 |
| ⑬ | 장애 바로 받기(이벤트 구독) | Zabbix(트랩 수신) | 주기 읽기만 — `EventService` 0건 | 엣지 수신 계약 · 장비에 구독 등록 · 망 경로 | 높음 |

## 4. 후보였지만 이미 있어서 뺀 것

| 후보 | 포탈에 있는 것 |
|---|---|
| 탄소 · 전기 요금 환산 | `insights/finops.js` — kWh · 전기 요금 · CO2(법인 · 지역 단위) |
| 용량 소진 예측 | 베어메탈 사용률 용량(`routes/api/bmCapacity.js`) · 용량 고갈 예측 도구 |
| 평소 대비 이상 탐지 | `insights/anomaly.js` |
| 알림 채널 | `alerts.js` — 메일 · Slack · Teams · 웹훅 |
| 서버 맵 | Bare Metal Server 맵 보기(`bmFolders/MapView.jsx`) |
| 정비 창 · 목표선 | 베어메탈 사용률 정비 창 · 목표선 |
| iDRAC 라이선스 등급 | `bmusage/license.js` |

지표 겹쳐 보기(SolarWinds PerfStack)는 비슷한 화면이 다른 이름으로 있을 수 있어 **없다고 확정하지 못해 뺐다.**

## 5. 개선하면 좋은 것(새 수집 없이 — 이미 가진 값을 서버 상세에 보이기)

| 개선 | 근거 |
|---|---|
| 위치 LED 상태 보이기 | `redfish.js:618` 이 읽지만 웹이 쓰지 않음 |
| 자산 태그 보이기 | `collector/compactInv.js:49` 수집 · 화면은 호스트 전력 패널 한 곳만 |
| 부품 줄마다 상태 배지 | `idrac/invView.js` 가 부품 상태를 만들지만 `hwDetailOf` 가 싣지 않음 |
| 전원 공급 장치 · GPU · BIOS 버전 · 온도 | `redfish.js` 가 읽지만 `/tools/bm-folders/hw` 응답에 없음 |
| 서버 전력 24시간 평균 · 피크 · kWh | `bmusage/powerAgg.js` |
| BIOS 설정 값 · 펌웨어 버전 목록 | `biosKeys.js` 19개 · iDRAC 상세 ‘versions’ 탭(Bare Metal Server 창에는 없음) |
| 성능 상세로 바로 가기 | 행에 사용률 키가 없어 지금은 목록 화면으로만 감 |
| 랙 위치 | 랙 실장도가 서비스 태그로 서버를 잇는다 |

## 6. 아트보드 4장

| 보드 | 파일 | 내용 |
|---|---|---|
| A 자산 · 준수 | `Main.dc.html` | ① 보증 · 계약 만료 ② 펌웨어 기준선 ③ BIOS 설정 편차 ④ 펌웨어 보안 권고 |
| B 진단 · 조작 | `Ops.dc.html` | ⑤ 하드웨어 이벤트 로그 ⑥ 위치 LED · 가상 콘솔 ⑦ 원격 전원 조작 |
| C 예측 · 탐지 | `Predict.dc.html` | ⑧ 부품 수명 지표 ⑨ 같은 묶음 대비 ⑩ 건강 점수 |
| D 알림 · 대응 | `Respond.dc.html` | ⑪ 알림 단계 · 당직 ⑫ 제조사 케이스 ⑬ 장애 바로 받기 |

## 7. 정직 기록 — 확인하지 못한 것

- ‘없음’ 판정은 **낱말 검색**이다(`warranty` · `ComputerSystem.Reset` · `EventService` · `outlier` · `escalat` · `correctable` 등). 다른 이름으로 구현된 것은 놓쳤을 수 있다.
- 업체 기능은 업체 글 기준이고 제품을 써 보지 않았다. 판(라이선스 등급)에 따라 없는 기능일 수 있다(예: Dell 구성 준수는 Advanced 라이선스).
- 시안의 이름 · 버전 · 숫자는 그림용 가상값이다. 보안 권고 번호 · 고친 버전은 지어내지 않고 `[ ]` 로 비웠다.
- ⑧: iDRAC 가 SSD 잔여 수명 · 메모리 교정 오류 건수를 주는지 실제 장비로 확인하지 않았다.
- ② ③: 엣지가 수집한 서버의 펌웨어 목록 · BIOS 설정이 중앙까지 오는지 확인하지 않았다(BIOS 키는 엣지 축약 인벤토리와 같은 목록이라고 `biosKeys.js` 주석이 말한다).
- ⑩: Dell 은 가장 큰 감점 하나만 뺀다고 한다 — 시안은 합산으로 그렸다(결정 필요).
- 크기(낮음 · 보통 · 높음)는 내 추정이다.
- 캔버스 렌더를 열어 보지 않았다.

## 8. 권하는 순서(내 판단)

1. 먼저: ① 보증 · 계약(원장) · ② 펌웨어 기준선 · ③ BIOS 편차 · ⑨ 묶음 대비 — 새 수집이 없거나 작고 상태를 바꾸지 않는다.
2. 다음: ⑤ 이벤트 로그 · ⑥ 위치 LED 표시 · ⑫ 케이스 자료 묶음 · ⑩ 건강 점수(② 가 있어야 감점 사유가 찬다) · ④ 보안 권고.
3. 결정 뒤: ⑧ 부품 수명(장비 확인 먼저) · ⑪ 알림 단계 · 당직.
4. 마지막: ⑦ 원격 전원 조작 · ⑬ 이벤트 구독 — 위험 · 계약 변경이 커서 반증 검토 대상.
