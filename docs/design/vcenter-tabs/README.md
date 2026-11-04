# 설계: vCenter 상세 화면에 vSphere Client 탭 구성 넣기

작성 2026-11-05 (v2.889.0 기준) · 상태 **조사 완료 · 시안 대기**(규칙: 설계는 Fable + Claude Design 시안 → 컨펌 뒤 Opus 구현 — 2026-11-03 '기억해').
이 문서의 §2 는 Opus 세션이 코드로 확인한 사실이고, §3 이하는 시안 단계(Fable)에서 채운다.

## 1. 요구(사용자 2026-11-05)

- 스크린샷 ① 포탈 vCenter 상세(OC2 — 탭: 호스트 및 클러스터 · VM 및 폴더 · 데이터스토어 · 네트워크 · 추이 · ☐ 사용량 조회)
- 스크린샷 ② vSphere Client 의 vCenter 개체 탭 줄(빨간 테두리): **요약 · 모니터 · 구성 · 사용 권한 · 데이터 센터 · 호스트 및 클러스터 · VM · 데이터스토어 · 네트워크 · 연결된 vCenter Server 시스템 · 확장 프로그램 · 업데이트**
- 원문: "이 화면에 이 기능들을 추가해줘" → 이어서 "클로드 코드로 디자인해서 보여줘"

## 2. 탭별 데이터 대응(코드 확인 — 2026-11-05 08:43~08:46 KST)

화면: `web/src/views/VCenterDetail.jsx` — 탭 목록은 `VIEWS`(40행 부근, 5개), 머리 줄은 `site.name` · 위치 · `v{site.version}` · vcenterId · `StateBadge` + KPI(호스트 · VM · CPU · 메모리 · 디스크 스파크라인) + ⇄ 비교하기.

| vSphere 탭 | 포탈에 지금 있는 것 | 출처(코드) | 새 수집 필요 |
|---|---|---|---|
| 요약 | 탭 없음. 머리 줄 KPI 만 | `site`(version · build · apiVersion · instanceUuid — `soapClient.js` 236~255 `about`) · `/hosts` · `/vms` · `/datastores` 집계 · `/alarms` | 없음 — 기존 값 조합 |
| 모니터 | '📈 추이' 탭(`TrendView`) · 포탈 알람(`/alarms` — `inventory.js:583`) · 이벤트 도구(`change-history` · `vm-changes` · `vm-lifecycle`) · `contention` | 포탈 알람은 **포탈이 만든 규칙**(호스트 끊김 · 유지보수 · CPU>90 · MEM>92 · DS>90/95% · DS 접근 불가 — `soapClient.js` 2231~2252). vCenter 자체 트리거 알람(`triggeredAlarmState`)은 **수집하지 않는다**(grep 0건) · 최근 작업(`TaskManager.recentTask`)도 수집 안 함 | vCenter 알람 · 작업은 신규 |
| 구성 | 탭 없음 | 라이선스(`retrieveLicenses` — 도구 `licenses` · `license-expiry` · `core-license`) · 클러스터 HA · DRS(`clustercfg` — 도구 `cluster-check`) · 태그 · 사용자 지정 속성(`tagInv` — 도구 `vm-tags`) · 호스트 구성(도구 `host-hygiene`) · 인증서 만료(도구 `cert-expiry`) | vCenter 고급 설정(OptionManager) · 예약 작업 등은 신규 |
| 사용 권한 | 없음 | 권한 · 역할 **변경 이벤트**만(`vm-changes`). 권한 목록 수집 없음(`RetrieveAllPermissions` · `roleList` grep 0건) | 신규(읽기 전용 SOAP — AuthorizationManager) |
| 데이터 센터 | 탭 없음 | 클러스터 → vSphere 데이터센터 이름을 이미 계산(`soapClient.js` 1880~1892, 필드 `vcDatacenter` — 포탈 'DataCenter'(법인 묶음)와 다른 개념). 클러스터 밖 독립 호스트는 null 일 수 있음 | 대체로 없음(독립 호스트 DC 는 확인 필요) |
| 호스트 및 클러스터 | **있음** | `/hosts` + `/vms` 트리 · 전체 현황 표 · 엑셀 | — |
| VM | **있음**('VM 및 폴더') | 폴더 트리 · 검색 · Veeam/Bareos/포탈 백업 배지 · VM 전체 정보 내보내기 | — |
| 데이터스토어 | **있음** | `/datastores` + 저장소 종류 필터 | — |
| 네트워크 | **있음** | `/networks`(포트그룹별 호스트 · VM 수는 null — 수집 안 함) | — |
| 연결된 vCenter Server 시스템 | 없음 | 포탈 등록부(28개)만 안다. Enhanced Linked Mode 연결 정보(SSO 도메인 · lookup service) 수집 없음 | 신규 — **API 경로 미확인(추정 단계)** |
| 확장 프로그램 | fleet 도구 'VMware 솔루션 / NSX'(`solutions`) | `retrieveExtensions` — ExtensionManager `extensionList` 의 key · version · company · label(`soapClient.js` 609~627), 주기 수집에 이미 실림(`solutions`, 실패 시 `solutionsError`) | 없음 — 이 vCenter 로 거르면 됨 |
| 업데이트 | fleet 도구 'vCenter 버전별'(`vcversion`) · 'ESXi 버전별'(`esxi`) — 버전 · 빌드만 | 적용 가능 패치(VAMI `/api/appliance/update`) · vLCM 이미지 준수 상태 수집 없음(grep 0건) | 신규(VAMI 는 별도 접속 · 자격이 필요할 수 있음 — 미확인) |

## 3. 설계 때 정해야 할 것(시안 단계 질문 후보)

1. **범위**: 1차를 '기존 데이터만'(요약 · 모니터(포탈 알람 + 이벤트 + 추이) · 구성(라이선스 · 클러스터 · 태그 · 인증서) · 데이터 센터 · 확장 프로그램 · 업데이트(버전만))으로 할지, 새 수집(사용 권한 · 연결된 vCenter · vCenter 알람 · 작업 · 패치 상태)까지 할지.
2. **'추이' 탭의 자리**: vSphere 는 모니터 › 성능 아래. 포탈의 '추이' 를 모니터 하위로 옮길지, 그대로 둘지.
3. **fleet 도구 재사용**: 구성 · 모니터 하위 칸을 기존 도구 화면에 `vcenterId` 거름을 넣어 끼울지(코드 재사용), 요약 카드만 두고 '도구에서 열기 →' 로 보낼지.
4. **탭 12개의 폭**: 1440px 한 줄 · 400px 에서는 가로 스크롤 탭 줄(페이지 가로 넘침 금지) 또는 드롭다운.
5. **권한**: 끼우는 도구의 관리자 전용 여부(`toolAllowed` · 카탈로그 `adminOnly`)를 탭 단위로 따른다 — 권한 없는 탭은 숨김 또는 권한 안내(`ErrorBox` 403).

## 4. 지켜야 할 규약(구현 때 — 루트 · 영역 문서에서)

- 새 셸 · 틀 금지(기본 셸 안의 이 화면만) · 도구 키 불변 · 표는 `STable` · 못 읽은 값은 '—'(0 아님, `numOrNull`) · 값이 없는 이유를 단정하지 않는다.
- 새 수집이 생기면: 고RTT(800ms+) · 30 vCenter 전제 — 탭을 열 때만 조회하거나 느린 주기 + 캐시, per-vCenter 시한, 위임(엣지) 수집 환경에서 중앙 화면이 비지 않게(`findRemoteServer`), 새 엣지 export 필드는 중앙 정제 화이트리스트에도.
- 무거운 API 는 15초 폴링 금지(마운트 1회 + 버튼) · 늦게 온 이전 응답은 버린다.
- 화면 변경은 Chromium 1440/400 직접 확인.
