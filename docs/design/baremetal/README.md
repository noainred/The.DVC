# Handoff: 서버 › 물리 서버 — 상태 보드 (시안 A)

- 시안: Claude Design 캔버스 `물리 서버 화면 시안`(2026-11-06, 사용자 컨펌 '컨펌, 구현 진행해줘')
- 대상 화면: `web/src/views/tools/HardwareTools.jsx` → `ServerAnalysisView` 의 새 하위 탭 `board`
  (`#/tools/serveranalysis/baremetal/board` — 물리 서버 메뉴의 첫 탭 · 서버 분석(전체)에서는 `#/tools/serveranalysis/board`)
- 구현: `web/src/views/tools/BaremetalBoard.jsx` · 집계/문구 `baremetalBoardText.js`(+ `.test.js`) · CSS `styles.css` 끝 `.bmb-*`

## 파일

| 파일 | 내용 |
|---|---|
| `baremetal-board.dc.html` | 최종안(A) — 구현 대상. 숫자는 mock |
| `baremetal-current.dc.html` | 현재 화면(법인 카드 + 모델별 대수) 재현본 — 비교용 |
| `support.js` | 프로토타입 런타임(구현과 무관 — `docs/design/server-temp/` 와 같은 파일) |

## 구성 (Datadog Host Map · Infrastructure List 구성 참고 — 고유 디자인 복제 아님)

1. **머리** — 범위 글자(Baremetal · 법인), 인벤토리 최신 수집 경과, 판정 기준 한 줄, 검색 · 타일 밀도(여유/촘촘히, 브라우저에 기억) · 새로고침.
2. **KPI 띠 7개** — 등록 서버 · 장애 · 경고 · 정상 · 일부 확인 불가 · 판정 못함 · 오래됨. 누르면 호스트 맵은 그 상태만 강조, 표는 그 상태만.
3. **호스트 맵** — 법인별 묶음, 서버 1대 = 타일 1개(나쁜 것이 앞). 타일·법인 이름 클릭 = iDRAC 상세 / 표를 그 법인으로.
4. **우측 패널** — 주의 필요 서버(장애 먼저) · 모델 분포 · 판정 못한 사유.
5. **서버 표** — `STable`(헤더 정렬 · 정렬 뒤 200행 · 더 보기).

## 시안과 의도적으로 달리한 점

1. **흡기 온도 · BIOS · iDRAC 버전 열을 뺐다.** 목록 API(`/admin/idrac?parts=1`)에 그 값이 없다 — 화면이 지어내지 않는다.
   서버 상세(행·타일 클릭)와 기존 탭(법인별 온도 · BIOS/iDRAC 버전 정보)에서 본다. 넣으려면 목록 응답에 옵션 플래그로 싣는 별건.
2. **주의 목록의 부품 이름(예: 'PSU2 Critical')을 뺐다.** 목록 응답의 `parts` 는 개수 요약(`withFaults:false`)이다 — '장애 부품 N · 모델' 로 쓴다.
3. **'판정 못함' 과 '일부 확인 불가' 를 나눴다.** 시안은 한 칸이었다. 판정은 했지만 읽지 못한 부품이 있거나 일부 종류 수집이 실패한 서버를
   정상으로 세지 않기 위해서다('못 읽은 값은 0 이 아니다'). 회색 두 단(명도 차)으로 구분한다.
4. **오래됨 기준 분을 화면에 박지 않았다.** 시안의 '수집 2시간↑' 는 서버 `INV_STALE_MS`(env 로 바뀜)가 붙이는 `stale` 를 그대로 쓴다.
5. **하위 탭은 기존 버튼 줄에 하나를 앞에 더했다**(새 셸·틀 금지). 법인 select 는 기존 화면 머리의 것을 쓴다(두 번 그리지 않는다).
6. **OME(관리 콘솔 등록)는 세지 않는다** — 서버가 아니다. 등록 서버 KPI 보조 줄에 뺀 수를 밝힌다.

## 판정 (서버가 한다 — 화면은 접고 센다)

행의 `parts` = 서버 `idrac/serverParts.js serverPartsCell`. `baremetalBoardText.boardState`:
장애 1↑ → 장애 · 경고 1↑ → 경고 · 확인 불가 1↑ 또는 `failedKinds` → 일부 확인 불가 · 정상 1↑ → 정상 · 그 밖(`judged:false`·부품 0·요약 없음) → 판정 못함.
소속·스코프(`scopeMatchServer`)는 서버 `insights/analysisScope.js serverInScope` 와 **같은 입력으로 대조하는 테스트**가 있다 — 법인별 서버 정보 탭도 이 함수를 쓴다.
