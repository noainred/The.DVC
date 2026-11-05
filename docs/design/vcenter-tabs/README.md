# 설계: vCenter 상세 화면에 vSphere Client 탭 구성 넣기

작성 2026-11-05 (v2.889.0 기준) · 상태 **시안 완료 · 컨펌 대기**(규칙: 설계는 Fable + Claude Design 시안 → 컨펌 뒤 Opus 구현 — 2026-11-03 '기억해') · 시안 캔버스: https://claude.ai/artifact/KWhkAuJSdxrjDaJAJeS8en
(아트보드 14장 — ①~⑦ vCenter 탭 · ⑧~⑪ VM · 호스트 개체 보기(§8) · ⑫~⑬ 성능 튜닝(§9) · ⑭ 포탈 전체 제안(§10) — 이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스. **법인 · vCenter 이름(VC-DEMO1 · DC-KR1 · esx-kr1-07 …) · 수치는 전부 가상**이고 색 · 글자 · 버튼은 `web/src/styles.css` `:root` 토큰 그대로.
계정의 ‘Design System’ 아티팩트는 앞 시안(bareos-errlog · bareos-cancel)과 같이 `project/README.md` · `project/tokens.json` 이 없어(타입 파일 + index.html 뿐) 쓰지 않았다. 아트보드에 VMware 로고 · 상표 이미지는 넣지 않았다 — 탭 이름 글자만.)
이 문서의 §2 는 Opus 세션이 코드로 확인한 사실이고, §3 · §4 는 시안 단계(Fable)에서 채웠다.

## 1. 요구(사용자 2026-11-05)

- 스크린샷 ① 포탈 vCenter 상세(OC2 — 탭: 호스트 및 클러스터 · VM 및 폴더 · 데이터스토어 · 네트워크 · 추이 · ☐ 사용량 조회)
- 스크린샷 ② vSphere Client 의 vCenter 개체 탭 줄(빨간 테두리): **요약 · 모니터 · 구성 · 사용 권한 · 데이터 센터 · 호스트 및 클러스터 · VM · 데이터스토어 · 네트워크 · 연결된 vCenter Server 시스템 · 확장 프로그램 · 업데이트**
- 원문: "이 화면에 이 기능들을 추가해줘" → 이어서 "클로드 코드로 디자인해서 보여줘" → "시안 보여줘"

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

시안 단계에서 더 확인한 것(2026-11-05 10:35~10:45 KST): 데이터스토어 용량 `capacityGB` · `usedGB` · `usagePct`(`soapClient.js` 2202) · 수집 시각 `collectedAt`(`collector/compactInv.js:64`) · 이벤트 행 `{ key, ts, type, severity, user, entity, message }`(`inventory.js:1621`) · 알람 처음 본 시각 `stampAlarmFirstSeen`(`inventory.js:1198`) · 라이선스 행 name · editionKey · licenseKey · costUnit · total/used(선택 항목 → 없으면 null) · 클러스터 `ha` · `drs` · `evc` · `rulesTotal`(`clustercfg/analyze.js:203·254`) · 인증서 `cn` · `issuer` · `validTo` → `daysLeft`(`security/certMonitor.js:29·52`, 12시간 주기 · D-90/D-30).

## 3. 화면(IA) — 아트보드 7장

```
vCenter 상세(기본 셸 안 · 지금 화면 하나) — 머리 줄은 그대로(← 목록 · 이름 · 위치 · 버전 · id · 상태 · KPI · ⇄ 비교하기)
탭 줄(12개 · vSphere 순서 · 이모지 없음 · 한 줄, 넘치면 탭 줄만 가로 스크롤):
 요약 · 모니터 · 구성 · 사용 권한 · 데이터 센터 · 호스트 및 클러스터 · VM · 데이터스토어 · 네트워크 · 연결된 vCenter Server 시스템 · 확장 프로그램 · 업데이트
 ├ ① Main        요약 — 카드 6(vCenter 정보 · 인벤토리 · 용량 · 포탈 알람 · 라이선스·인증서 · 확장·버전) + 최근 이벤트 표. 전부 기존 값.
 ├ ② Monitor     모니터 — 왼쪽 하위 칸: 문제 및 알람(포탈 규칙) · 이벤트 · 작업(수집하지 않음) · 성능(= 지금 '추이' 그대로)
 ├ ③ Configure   구성 — 하위 칸: 설정(라이선스 · 클러스터·HA·DRS · 태그·사용자 지정 속성 · 고급 설정(수집하지 않음)) · 보안(인증서) · 점검(호스트 구성 점검).
 │                fleet 도구 데이터를 이 vCenter 로 거른 표 + '도구에서 열기 →'. 태그 · 호스트 구성은 요약 카드만.
 ├ ④ Datacenter  데이터 센터 — vSphere 데이터센터(vcDatacenter) › 클러스터 트리 표(호스트 · VM · CPU · MEM · 가상화) · 독립 호스트는 '데이터센터 확인 필요'
 ├ ⑤ Extensions  확장 프로그램 — key · 이름 · 버전 · 회사 + 'fleet 안 같은 key' · 조회 실패면 '확인 불가 — 사유'(빈 표 금지)
 ├ ⑥ NewCollect  사용 권한 · 연결된 vCenter Server 시스템 · 업데이트 — 칸 둘: '지금 아는 것'(1차에 보임) | '수집하면 보일 것'(2차 · 회색 뼈대)
 └ ⑦ Narrow      400px — 머리 줄 두 줄 · 탭 줄 가로 스크롤(오른쪽 흐림) · 요약 카드 한 열 · 이벤트는 카드 줄
기존 4개 탭(호스트 및 클러스터 · VM · 데이터스토어 · 네트워크)의 내용은 그대로 — 시안에서 다시 그리지 않았다.
```

## 4. 설계

### 4.1 탭 줄(①·⑦)
- `VIEWS` 를 12개로 늘리되 **키는 새로 만들고 기존 키(`hosts` · `vms` · `storage` · `network` · `trend`)는 유지**(URL · 저장된 보기 호환). 'trend' 는 모니터의 하위 보기로 매핑(기본값 ②).
- 모양은 지금 `.tab` / `.tab.active`(accent 채움) 그대로 — 새 클래스를 만들지 않는다. 이모지 아이콘은 뺀다(12개가 한 줄에 들어가도록 · 캔버스 규약도 이모지 금지).
- `.vcd-views` 를 `flex-wrap: wrap` → `overflow-x: auto`(탭 줄만 스크롤 · 페이지는 밀지 않는다). 400px 은 오른쪽 끝 흐림으로 '더 있음' 을 알리고 현재 탭이 보이도록 스크롤(`scrollIntoView`). 대안은 `Select` 드롭다운(정할 것 ④).
- '📊 사용량 조회' 체크는 탭 줄에서 빼서 호스트 및 클러스터 · VM 탭의 필터 줄(메모 포함 · Off VM 포함 옆)로 옮긴다 — 탭 줄이 길어져 자리가 없다.
- 탭의 작은 숫자(모니터 2)는 심각 알람 수만 — 다른 탭엔 숫자를 두지 않는다(수집 중인 값이 없는 탭에 0 을 보이지 않으려고).

### 4.2 요약(①)
- 새 라우트 없이 기존 응답 조합: `site`(about) · `/hosts` · `/vms` · `/datastores` · `/networks` · `/alarms` · 라이선스/확장(주기 수집 snapshot) · 인증서(`certMonitor` 캐시) · 이벤트(변경 이력 조회를 이 vCenter · 24시간 · 6건으로). 요약 탭이 열릴 때만 추가 조회(이벤트 · 인증서)하고 15초 폴링엔 넣지 않는다.
- 못 읽은 값은 '—'(단위 없이) · 부분 합(접근 불가 DS)은 합에서 빼고 따로 센다 · 라이선스 · 확장은 `null`+`*Error` 면 '확인 불가 — 사유'.

### 4.3 모니터(②)
- 하위 칸은 왼쪽 세로 메뉴(190px) · 400px 은 가로 칩 줄. 4칸: **문제 및 알람**(포탈 규칙 — 표 머리에 '포탈 규칙' 배지 · 규칙 목록을 각주로 · vCenter 알람과 섞지 않는다) · **이벤트**(변경 이력 도구의 조회를 이 vCenter 로 거름 · 심각도 칩 · 검색 · 페이지 단위) · **작업**(수집하지 않음 — 빈 상태 카드에 사실과 2차 열 뼈대) · **성능**(`TrendView` 를 그대로 옮긴다 · 내용 변경 없음).
- 알람 행: 심각도 · 종류(규칙) · 대상 · 대상 종류 · 메시지 · 처음 본 시각(`stampAlarmFirstSeen`) · 지속 · 열기(→ 호스트/데이터스토어 탭). 못 읽은 호스트 · DS 는 알람에 넣지 않고 따로 센다.

### 4.4 구성(③)
- 하위 칸 7: 라이선스 · 클러스터·HA·DRS · 태그·사용자 지정 속성 · 고급 설정(수집하지 않음) / 인증서 / 호스트 구성 점검. 각 칸 = 해당 fleet 도구 API 에 `vcenterId` 거름을 넣은 표(코드 재사용 — 판정은 도구의 analyze 모듈 하나, 웹에서 다시 판정하지 않는다) + '도구에서 열기 →'(그 vCenter 가 골라진 채).
- 도구 화면이 큰 태그 · 호스트 구성은 요약 카드만(숫자 4~5개) + 열기. 권한은 끼우는 도구의 `toolAllowed`/카탈로그 `adminOnly` 를 칸 단위로 따르고, 없으면 칸을 숨기지 않고 `ErrorBox` 403 안내(정할 것 ⑤).
- 라이선스 키 가림(뒤 5자리)은 **제안** — 지금 라이선스 도구의 가림 규칙을 확인해 그대로 따른다.

### 4.5 데이터 센터(④) · 확장 프로그램(⑤)
- ④ `/hosts` 의 클러스터 `vcDatacenter` 로 묶는다. 독립 호스트(DC null)는 '데이터센터 확인 필요' 행으로 두고 어느 DC 에도 더하지 않는다. 데이터스토어 · 네트워크의 DC 소속은 수집하지 않으므로 열을 두지 않는다. CPU · MEM · 가상화율은 호스트 및 클러스터 탭의 계산(`vcdVirt`) 그대로 · 'Off VM 포함' 공유.
- ⑤ 주기 수집 `solutions` 를 이 vCenter 로 거름. 열은 수집하는 4개 값만. 'fleet 안 같은 key' 는 같은 snapshot 의 다른 vCenter 를 센 것(새 수집 없음). `solutions === null` 이면 표 대신 '확인 불가 — solutionsError'.

### 4.6 새 수집이 필요한 탭(⑥) — 1차엔 '지금 아는 것' 만
- **사용 권한**: 1차 = 권한 · 역할 변경 이벤트 표(`vm-changes` 출처). 2차 = AuthorizationManager.RetrieveAllPermissions + roleList(읽기 전용 · 탭 열 때만 · 관리자 판본만 · 범위 밖 404).
- **연결된 vCenter Server 시스템**: 1차 = '이 vCenter' 한 줄 + 'SSO 도메인 · 연결된 vCenter — 모름(수집하지 않음)'. 포탈 등록부 28개를 '연결된' 것처럼 보이지 않는다. 2차는 **API 경로를 먼저 조사**(어느 API 로 Linked Mode 구성원을 읽는지 코드로 확인한 바 없음 — 추정 후보만 아트보드에 적음).
- **업데이트**: 1차 = vcversion · esxi 값을 이 vCenter 로 거른 표(구성 요소 · 버전 · 빌드 · 대수 · fleet 안 위치) · 끊긴 호스트는 '버전 모름' 으로 따로. 2차 = VAMI 패치 목록(어플라이언스 자격 별도 필요 여부 미확인) · vLCM 준수. 동작(패치 적용)은 두지 않는다.
- 세 탭 모두 새 수집은 **탭을 열 때만 · per-vCenter 시한 · 캐시 TTL · 엣지 위임 법인은 엣지 작업 표 + 중앙 정제 화이트리스트**(루트 CLAUDE.md 엣지 규칙).

### 4.7 구현 때 바뀌는 파일(예상)
- 웹: `VCenterDetail.jsx`(VIEWS 12 · 탭 줄 overflow · 사용량 조회 체크 이동 · 하위 보기 라우팅) · 새 보기 컴포넌트 `vcd/Summary.jsx` · `vcd/Monitor.jsx` · `vcd/Configure.jsx` · `vcd/Datacenter.jsx` · `vcd/Extensions.jsx` · `vcd/NewCollect.jsx`(또는 탭별 파일) · `styles.css`(`.vcd-views` 한 줄 규칙) · 순수 모듈(데이터센터 묶기 · 요약 집계)은 vitest.
- 서버(1차): 기존 도구 라우트에 `vcenterId` 거름 쿼리(없는 곳만) — 새 수집 없음. 2차: `vcenter/permissions.js` · `vcenter/updates.js` 등 + 엣지 작업 표 + 정제.
- 시험: VIEWS 키 불변 · 못 읽음 → '—' · 부분 합 분리 · 범위/권한(404/403) · 400px 가로 넘침 0(Chromium 1440/400).

## 5. 정할 것(컨펌 때 — 기본값 제안)

1. **1차 범위**: 기본 = 기존 데이터만(요약 · 모니터(포탈 알람 · 이벤트 · 성능) · 구성(라이선스 · 클러스터 · 태그 · 인증서 · 호스트 구성) · 데이터 센터 · 확장 프로그램 · 업데이트(버전만) · 사용 권한(변경 이벤트만) · 연결된 vCenter('모름' 한 줄)). 새 수집(권한 목록 · Linked Mode · vCenter 알람 · 작업 · 패치 · 고급 설정)은 2차.
2. **'추이' 의 자리**: 기본 = 모니터 › 성능으로 옮긴다(`trend` 키는 그 하위 보기로 매핑해 호환). 대안 = 1단 탭으로 남긴다(13개).
3. **fleet 도구 재사용 방식**: 기본 = 도구 API 에 `vcenterId` 거름 + 이 화면 표 + '도구에서 열기 →'. 대안 = 요약 카드만 + 열기.
4. **탭 줄 폭**: 기본 = 한 줄 + 탭 줄만 가로 스크롤(400px 오른쪽 흐림) · 이모지 아이콘 제거. 대안 = 400px 에서 `Select` 드롭다운.
5. **권한 없는 하위 칸**: 기본 = 숨기지 않고 `ErrorBox` 403 안내. 대안 = 숨김.
6. **탭 이름**: 기본 = 'VM 및 폴더' → 'VM'(vSphere 와 같게 · 키 `vms` 불변). 대안 = 그대로.
7. **'📊 사용량 조회' 체크 위치**: 기본 = 호스트 및 클러스터 · VM 탭의 필터 줄로 이동. 대안 = 탭 줄 오른쪽 끝 유지(한 줄이 더 길어진다).

## 6. 시안에서 확인하지 못한 것(정직 기록)
- 라이선스 도구의 키 가림 규칙 · 인증서 지문(SHA-256) 수집 여부 · 클러스터 '승인 제어' · 'DRS 수준' 수집 여부 · host-hygiene 의 점검 항목 이름(NTP · SSH · Lockdown 은 예시) · TrendView 기간 칩 이름(9종이라는 것만) — 아트보드의 해당 칸은 **자리 · 예시**이고 구현 때 실제 수집 필드로 맞춘다.
- 엣지 위임 법인에서 `solutionsError` 가 중앙에 그대로 올라오는지(추정).
- 연결된 vCenter(Linked Mode) 를 읽는 API — 미확인(§2 그대로).
- 시안은 Fable **하위 에이전트**가 만들었다(사용자 선택 2026-11-05 — 메인은 Opus). 메인이 7장을 Chromium(1500px · Narrow 는 900px 안의 400px 틀)으로 직접 렌더해 봤다(10:50 KST) — 깨짐 · 가로 넘침 없음. 구현 때 고칠 문구 · 모양 3건:
  ① 확장 프로그램 '확인 불가' 안내가 '다음 주기에 다시 읽는다' 와 '자동 재시도 없음 — 인증 실패는 주기 수집을 멈춘다' 를 한 문장에 섞는다 — NoPermission 은 인증 실패가 아니라 다음 주기에 다시 읽힌다(인증 정지 규칙은 로그인 실패에만).
  ② 데이터 센터 표의 클러스터 행 '클러스터' 칸이 '—' — '모름' 으로 읽힌다. 하위 행은 빈칸으로.
  ③ 요약 › 용량 카드의 '디스크 추이' 이름이 1440 에서 두 줄로 꺾인다.

## 7. 지켜야 할 규약(구현 때 — 루트 · 영역 문서에서)

- 새 셸 · 틀 금지(기본 셸 안의 이 화면만) · 도구 키 불변 · 표는 `STable` · 못 읽은 값은 '—'(0 아님, `numOrNull`) · 값이 없는 이유를 단정하지 않는다.
- 새 수집이 생기면: 고RTT(800ms+) · 30 vCenter 전제 — 탭을 열 때만 조회하거나 느린 주기 + 캐시, per-vCenter 시한, 위임(엣지) 수집 환경에서 중앙 화면이 비지 않게(`findRemoteServer`), 새 엣지 export 필드는 중앙 정제 화이트리스트에도.
- 무거운 API 는 15초 폴링 금지(마운트 1회 + 버튼) · 늦게 온 이전 응답은 버린다.
- 화면 변경은 Chromium 1440/400 직접 확인.

## 8. 개체 보기(VM · ESXi 호스트) — 추가 요청(2026-11-05 11:44 KST · Fable 메인)

- 요구 원문: "폴더 형태로 볼때 VM 의 정보를 vcenter 에서 보는 것처럼 보는 것같은 메뉴를 별도의 버튼을 누르면 보이게 하고, esxi 호스트도 동일한 기능만들어줘. 시안 만들어서 보여줘"
- 아트보드 ⑧ `VmObject.dc.html` · ⑨ `HostObject.dc.html` · ⑩ `ObjectTabs.dc.html` · ⑪ `ObjectNarrow.dc.html`(같은 캔버스 넷째 줄). 가상 데이터(web-kr1-023 · esx-kr1-03).

### 8.1 여는 방법(별도 버튼)
- 트리 행(VM 및 폴더 › VM 행 · 호스트 및 클러스터 › 호스트 행)에 **‘⤢ 개체 보기’** 버튼 — 1440 에서는 마우스를 올리면 보이고 400 에서는 항상 보인다(줄바꿈). 행 이름을 누르는 지금 동작(640px 상세 창 `EntityDetail`)은 그대로.
- 지금 상세 창의 아래 버튼 줄에도 같은 버튼(`VmReconfigButton · VmConsoleButton · … · ⤢ 개체 보기`). VM 개체 화면의 ‘호스트’ 링크 → 호스트 개체 화면.
- 누르면 **같은 vCenter 화면 안에서 탭 자리가 개체 화면으로 바뀐다**(새 셸 · 새 창 없음) · 경로 줄 ‘← VM 및 폴더 › VC › DC › 폴더 › 이름’ 으로 복귀. 주소는 `#/vcenter/<id>/vm/<vmId>` 같이 해시에 실어 새로고침 · 공유가 되게(구현 때 라우팅 규약 확인).

### 8.2 탭(vSphere Client 개체 탭 순서)
| 개체 | 탭 | 1차(지금 값) | 2차(수집 추가) |
|---|---|---|---|
| VM | 요약 | VM 하드웨어(/vms 행 + vmcfg cfg·dev) · 게스트 OS(guest.*) · 관련 개체(vmPlacement · host · cluster · resourcePool · 디스크별 DS) · 사용률(quickStats + perfc) · 구성 점검(vmcfg findings) · 태그 · 메모 · 백업 배지 · 최근 변경(vmHistory 5건) | — |
| VM | 모니터 | 성능(`/vms/:id/metrics` — 지금 ‘📈 메트릭’ 창 본문) · 이벤트(vmHistory) | 작업(TaskManager) |
| VM | 구성 | 하드웨어 장치 표(cfg.dev: 디스크 · CD-ROM · USB/직렬/병렬) + 설정 점검 행(vmCfgRows) | 네트워크 어댑터 장치(backing) |
| VM | 사용 권한 | 권한 · 역할 변경 이벤트만 | RetrieveEntityPermissions(관리자 판본) |
| VM | 데이터스토어 | 디스크별 DS(cfg.dev.datastore) + DS 사용률(/datastores) + 게스트 파티션(`/vms/:id/partitions`) | — |
| VM | 네트워크 | 게스트 IP · 게이트웨이 · DNS · DNS 역방향(vmdns 판정) · IP 대장 링크 · 핑(VmIpPing) | 포트그룹 / vSwitch |
| VM | 스냅샷 | 개수 · 크기(snapshotCount · snapshotSizeGB) · 가장 오래된 것 · 생성자(이벤트 추정) | 스냅샷 트리(rootSnapshotList) |
| VM | 업데이트 | Tools 버전 · 상태(toolsVersionStatus) · 호환성(hwVersion) | — |
| 호스트 | 요약 | 하드웨어(vendor · model · serviceTag · cpuModel · 코어/스레드/소켓 · 메모리 · HBA · NIC · GPU · 전력 · 온도 · bootTime) · 사용률(+ 가상화율 vcdVirt · perfc) · 관련 개체 · 구성·보안 점검(hcfg) · HBA·NIC 표 | — |
| 호스트 | 모니터 | 성능(`/hosts/:id/metrics`) · 이벤트(호스트 대상 이벤트) | 작업 |
| 호스트 | 구성 | hostCfgRows(인증서 · 재부팅 · SSH/Shell · NTP · DNS · syslog · 잠금 모드 …) | 고급 설정 |
| 호스트 | 사용 권한 | 변경 이벤트만 | 권한 목록 |
| 호스트 | VM | 지금 `HostVmsModal` 표를 탭으로(검색 · 정렬 · CSV · ‘개체 →’) | — |
| 호스트 | 리소스 풀 | VM.resourcePool 로 묶은 합(VM · vCPU · 메모리) | 풀 속성(예약 · 제한 · 공유) |
| 호스트 | 데이터스토어 · 네트워크 | 물리 NIC · HBA(지금 값) · VM 디스크로 역산한 DS 목록 | 호스트별 DS 마운트 · 포트그룹 · vSwitch |
| 호스트 | 업데이트 | ESXi 버전 · 빌드 · fleet 안 같은 빌드 수 · 재부팅 필요(hcfg) | vLCM 준수 · 패치 |

### 8.3 규약(구현 때)
- 개체 화면은 **조회 전용**. 상태를 바꾸는 동작(사양 변경 · 콘솔 · Tools 업그레이드)은 지금 버튼 · 도구 그대로(권한 `requirePerm` · 쓰기 범위) — 탭 안에 새 쓰기 경로를 만들지 않는다.
- 온디맨드 조회(메트릭 · 파티션 · 이벤트)는 **탭을 열 때 1회** + 버튼 · 15초 폴링 금지 · 늦게 온 이전 응답은 버린다 · 도구 권한이 없으면 부르지 않는다(403 을 만들지 않게 — ClusterCfgSection 규약).
- 단건 라우트는 `inUserScope` 404(존재 은닉). 관리자 판본 값(권한 목록 등)은 `isAdminDetailUser`.
- 못 읽은 값은 '—' · 수집하지 않는 칸은 숨기지 않고 '수집하지 않음 · 2차' · 꺼진 VM 사용률 '—' · 경합 없음 ≠ 측정하지 않음.
- 지금 `EntityDetail` 의 섹션 컴포넌트(VmCfgSection · HostCfgSection · PerfcSection · ClusterCfgSection · VmTagsSection · VmChangesSection · HostHbaTable · HostVmsModal 본문)를 **꺼내 재사용**한다 — 복제하지 않는다.

### 8.4 정할 것(기본값)
8. **개체 화면 위치**: 기본 = 같은 vCenter 화면의 탭 자리(경로 줄로 복귀 · 해시 주소). 대안 = 전체 화면 창(Modal 1200px).
9. **상세 창 유지**: 기본 = 지금 640px 창은 그대로 두고 버튼만 추가. 대안 = 창을 없애고 행 클릭이 바로 개체 화면.
10. **버튼 노출**: 기본 = 1440 마우스 올림 · 400 항상. 대안 = 항상 보임.

### 8.5 확인하지 못한 것
- 호스트 대상 이벤트를 vmHistory 처럼 호스트 단위로 거르는 API 가 있는지(HOSTOPS_TYPES 는 있다 — 라우트는 미확인).
- 스냅샷 ‘생성자’ 는 이벤트에서 추정 — 이름에 VEEAM 이 있을 때만 백업 계정으로 본다(규칙은 veeamBadge 와 맞춘다).
- 메인(Fable)이 4장을 Chromium(1500 · 900 안 400 틀)으로 렌더해 봤다(11:50 KST 경) — 깨짐 · 가로 넘침 0 · 콘솔 오류 0.

## 9. 성능 튜닝 탭(VM · ESXi 호스트) — 추가 요청(2026-11-05 11:59 KST · Fable 메인)

- 요구 원문: "성능 튜닝을 위한 기능 추가해줘"(VmObject 아트보드를 보던 중). 아트보드 ⑫ `VmTuning.dc.html` · ⑬ `HostTuning.dc.html`(캔버스 다섯째 줄).
- 자리: vSphere Client 에 없는 **포탈 전용 탭** — 개체 탭 줄 맨 끝에 구분선 뒤 ‘성능 튜닝 N’(N = 확인할 축 수).
- 구성(둘 다 같은 틀): **진단 띠**(다섯 축 · 점수 없음 · 축마다 근거 한 줄) → 카드 4 → **조치 계획**(번호 · 조치 · 기대 효과 · 위험 · 어디서 · 상태).
  - VM: 자원 적정화(`/tools/rightsize` — p95/최대 · 권장 vCPU/메모리 · 감축 금지 신호 벌룬·스왑·Ready) · CPU 경합 + 같은 호스트 이웃(contention perfc) · 스토리지 지연(디스크별 지연 · DS 사용률 · 씬 오버할당 · 스냅샷) · 구성 권장(vmcfg findings · Tools · HW 버전).
  - 호스트: VM 배치(무거운 VM · 적정화 열 = waste/rightsize 판정) · 메모리 압박(consumed/active/벌룬/스왑 합) · 스토리지·네트워크 경로(storage-paths 판정 · pnic) · 하드웨어·전력·온도(센서 · iDRAC).
- 규약: 판정은 서버 값 그대로(rightsize 정책 · contention/parse.js 코드 · vmcfg/parse.js · storage-paths · hcfg) — 화면 재판정 금지 · 점수·등급 없음 · 못 읽은 축은 ‘—’(정상 아님) · 감축 금지 신호를 못 읽었으면 권장을 내지 않는다 · 경고선 숫자는 API 정책값(화면에 박지 않기) · 적용은 지금 도구(사양 변경 — `vm.reconfig` · 쓰기 범위) 또는 vSphere — 탭은 조회 + 계획만 · 열 때 1회 조회.
- 수집하지 않아 ‘2차’ 로 둔 것: 호스트 CPU 전원 정책 · NUMA 배치 · 지연 민감도 · 네트워크 어댑터 유형(vmxnet3) · 포트그룹 · 팀 구성 · 메모리 압축. 벌룬·스왑은 레벨 2 카운터라 vCenter 통계 수준이 1이면 ‘—’(RIGHTSIZE_COUNTERS 주석).
- 조치 계획 저장(상태 · 담당 · 사유)은 새 저장소가 필요하다 — §10 제안 2 와 같은 것. 1차 구현은 저장 없이 ‘내보내기’ 만으로도 된다(정할 것 11).
- 정할 것(기본값): **11.** 조치 계획 저장: 기본 = 1차는 저장 없이 체크리스트 내보내기 · 상태 저장은 보드(제안 2)와 함께. **12.** 기간 기본값: VM 30일 · 호스트 7일. **13.** 탭 이름 ‘성능 튜닝’ (대안 ‘적정화’).
- 메인이 Chromium 으로 2장 렌더(12:05 KST 경) — 깨짐 · 가로 넘침 0.
- ‘커스텀 프로파일 보는 기능’ 요청(12:09)은 뜻을 묻는 중 **사용자가 취소**(12:10) — 시안 · 제안에 넣지 않았다.

## 10. 포탈 전체 — 추가하면 좋은 기능 제안(2026-11-05 12:10 KST · 아트보드 ⑭ `Proposals.dc.html`)

요구 원문: "포탈 전체 기능에서 추가하면 좋은 기능도 넣어줘". **제안이며 확정이 아니다.** 근거는 ‘코드 확인’(이 세션에서 소스를 읽음)과 ‘추정’ 을 나눠 적었다. 특수 기능이 121개라 구현 전에 겹침을 먼저 본다.

| # | 제안 | 근거 | 수집 | 난이도 |
|---|---|---|---|---|
| 1 | 개체 보기 틀을 데이터스토어 · 클러스터 · 네트워크에도 | 데이터스토어는 640px 창만 · 클러스터 상세 없음(코드 확인) | 없음 | 보통 |
| 2 | 조치 계획 보드(전 vCenter · 상태 · 담당 · 기한 · 알림) | 개체에 묶인 저장소 없음(`issues/store.js` 개체 키 없음 — 코드 확인) | 없음 | 보통 |
| 3 | 변경 전후 성능 비교(vm-changes 시각 기준 전후 p95 · Ready · 지연) | 잇는 화면 유무 미확인(추정) | 없음 | 낮음~보통 |
| 4 | 개체 즐겨찾기 · 최근 본 개체 · 검색 결과에서 ‘개체 보기’ | 즐겨찾기는 도구·위키만 · 개체 없음(grep — 코드 확인) | 없음 | 낮음 |
| 5 | vCenter 알람 · 최근 작업 수집 → 모니터 탭 vCenter 구획 | 포탈 규칙 6가지뿐 · triggeredAlarmState · recentTask 없음(코드 확인) | 새 수집 | 높음 |
| 6 | 사용 권한 목록(관리자 판본 · 전 vCenter 비교) | 변경 이벤트만(코드 확인) | 새 수집 | 보통(보안 변이 검증) |
| 7 | 네트워크 어댑터 · 포트그룹 · vSwitch | 네트워크 host·vm 배열은 크기 때문에 의도적 미수집(soapClient 주석 — 코드 확인) | 새 수집(측정 먼저) | 보통 |
| 8 | 소형 수집 묶음 — 스냅샷 트리 · 리소스 풀 속성 · 전원 정책 · vLCM · Linked Mode | 모두 미수집(grep) · Linked Mode 경로 미확인(추정) | 새 수집 | 낮음~보통 |
| 9 | 일일 헬스체크에 ‘성능 튜닝 요약’ | daily-health 설명에 경합·적정화 없음(추정 — 본문 코드 안 읽음) | 없음 | 낮음 |
| 10 | 알림 규칙 확장 — Ready 지속 · DS 쓰기 지연 · 스냅샷 N일 · 벌룬 | 알림 엔진 규칙 범위 미확인(추정) | 없음 | 보통(폭주 방지) |

우선순위 제안: 1 · 4 · 9 → 2 · 3 · 10 → 8 · 7 · 6 → 5. `rightsizePolicy()` 가 env 전역(`RIGHTSIZE_READY_WARN_PCT`)인 것은 코드로 확인했다 — 워크로드별 기준(프로파일)은 사용자가 취소해 제안에서 뺐다.
