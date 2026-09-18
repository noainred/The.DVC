# Claude Code 실행 프롬프트

아래를 그대로 붙여 넣는다. 저장소 루트에서 실행하고, 이 폴더(`design_handoff_server_temp/`)를 저장소 안(예: `docs/design/server-temp/`)이나 접근 가능한 경로에 두었다고 가정한다.

---

`docs/design/server-temp/README.md` 를 끝까지 읽고 '특수 기능 › 서버 온도' 화면을 디자인 B(히트맵 보드)로 재구현해 줘. `server-temp.dc.html` 은 브라우저로 열어 결과와 대조할 디자인 레퍼런스이고(HTML 프로토타입 — 복사 대상이 아님), 하단 `<script data-dc-script>` 의 `renderVals()` 에 버킷·히트맵 격자·비교 막대·스파크 path 계산식이 있으니 그 수식은 그대로 옮겨도 된다.

## 작업 순서

1. **읽기** — `web/src/views/tools/CapacityTools.jsx` 의 `EsxiTemp`, `web/src/views/tools/shared.jsx`(`Card`, `tempColor`, `useTool`), `web/src/components/primitives.jsx`(`DataTable` — 행 스타일 훅·`sortValue`·`initialSort` 지원 여부 확인), `web/src/views/tools/sparkBatch.js`, `web/src/hooks/useHashTab.js`, `web/src/styles.css` `:root`~`.statusbar`, `web/src/App.jsx` 354~500행(topbar/statusbar), `server/src/routes/api/toolsCapacity.js` 1087~1220행(`/tools/esxi-temp`, `/history`), `server/src/tools/serverTemp.js`, `server/src/idrac/serverTempSeries.js`, `server/src/metrics/db.js`(`history/recentAvg/meta`), `server/CLAUDE.md`·루트 `CLAUDE.md` 의 프런트 회귀 방지·정직성·범위 강제 규약.
2. **토큰** — `styles.css :root` 에 `--border-soft`, `--panel-deep`, `--teal`, `--font-mono` 추가(README §Design Tokens). 기존 변수명은 파일에서 확인한 것만 쓴다.
3. **서버 API** — `sparkMetricFor(source, { detail })` 를 `server/src/tools/serverTemp.js` 에 순수 함수로 추가하고, `POST /tools/esxi-temp/spark` 를 `toolsCapacity.js` 에 README §State Management 사양대로 추가한다(범위 강제 = 존재 은닉, 상한 `maxItems` 응답, mock 합성은 `synthesized:true`, DB 실패는 키별 `null`). `taskLabel.js`·`toolAccess.js` 등록을 확인한다. 테스트 `server/test/serverTempSpark.test.js`(메트릭 선택·상한·2점 미만 null·범위 밖 null)를 추가하고 서버 테스트를 통과시킨다.
4. **프런트 — EsxiTemp** — README §Screens 1~5 순서대로 구현한다. 훅은 전부 조기 return 위. 구조: 툴바 → 경고 카드(기존) → KPI/분포 → 법인 비교/이상 서버 → 히트맵 → 표(+푸터). 새 부품은 같은 파일 하단에 지역 컴포넌트로 두고(`HeatCell`, `PeakCell`, `TempSpark`, `TempHistogram`, `DcCompare`, `HotList`, `TempHeatmap`, `Segment`, `DensityToggle`), 200줄을 넘기면 `web/src/views/tools/serverTemp/` 폴더로 분리한다. 스파크라인 훅 `useTempSparklines` 는 `Waste` 의 `useSparklines` 패턴(순차 배치·`asked`·`dead` 가드)을 따른다. 임계값은 `shared.jsx` 의 `TEMP_WARN_C=32`, `TEMP_HOT_C=40` 상수로 통일한다.
5. **프런트 — 앱 셸** — `App.jsx` `header.topbar` 를 브랜드 행 + 메뉴 행 2단으로 나누고(README §0), CSS 는 `.topbar .tabs .tab` 로 **한정**해 밑줄 탭으로 바꾼다(전역 `.tab` 버튼 스타일은 유지). `footer.statusbar` 는 모노 폰트·라벨 자간·배경만 바꾼다. 기존 상태 칩 내용(`21/21 vCenter OK`, 시각)과 사용자 메뉴 동작은 그대로.
6. **검증** — `web` 빌드·lint 통과, `server` 테스트 통과. 브라우저에서 `#/tools/esxitemp/server` 를 열어 `server-temp.dc.html` 과 나란히 비교: 뷰 4개 전환, 물리/가상화 필터, 법인 클릭 → 히트맵·표 좁힘 + 해제 칩, 여유/촘촘히(새로고침 후 유지), 정렬, 25행 더 보기, 스파크라인 `…`→선/`—` 전이, 이름 클릭 → 5년 추이 모달, 1100px/1200px 미만 1열 접힘, 상단 메뉴 활성 밑줄·가로 스크롤.

## 지켜야 할 것

- README '디자인과 의도적으로 달리하는 점' 5개를 따른다(범위 select 중복 금지, 스파크 계열 라벨 정직, 비교 점선 = 전체 평균, 5년 추이 모달 유지, 타일 툴팁).
- 화면에 상한·주기 숫자를 하드코딩하지 않는다 — `avgWindowLabel`, `maxItems` 등 API 값을 쓴다.
- 데이터가 없는 것을 0 이나 합성값으로 채우지 않는다. 합성(mock)은 응답의 `synthesized` 로 표시한다.
- 스타일은 CSS 변수/클래스로 — 새 hex 는 README 에 적힌 강조색(`#4ade80 #fbbf24 #f87171 #dbeafe #bfdbfe #7dd3fc #fecaca`)과 rgba 오버레이만 허용.
- 기존 동작을 줄이지 않는다: 하위 탭 URL 해시 유지, 물리/가상화 필터, 경고 카드 3종, 히스토리 모달의 기간·집계 단위 버튼.
- 버전 표기·release-notes 갱신 규약이 있으면(`server/src/release-notes.js`, `server/CLAUDE.md`) 그대로 따른다.

끝나면 변경 파일 목록, 새 API 의 요청/응답 예시 1개, 그리고 README 와 달리 판단한 부분이 있으면 이유와 함께 알려 줘.
