# 설계: GPU 할당율 엑셀 — 전체 시트는 그대로, 법인(vCenter)마다 시트 하나 추가

작성 2026-11-03 (v2.868.0 기준) · 상태 **구현됨 v2.869.0**(컨펌 2026-11-03 '구현해' · 기본안 4가지 · 표준 검증) · 시안 캔버스: https://claude.ai/artifact/6LcrjcPjNw5n5jinDCHppa
(아트보드 2장 — 이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스. 법인명·수치는 가상(목 서버의 vCenter 9곳 이름을 빌림)이고
색·글자는 `web/src/styles.css` `:root` 토큰과 `server/src/gpu/allocTreeXlsx.js` 의 `C`·`LEVEL` 색 그대로.
계정에 등록된 ‘Design System’ 아티팩트는 앞선 시안(bareos-cancel) 때와 같이 내용이 비어 있어 쓰지 않았다.)

## 1. 요구 (사용자 요청 2026-11-03)

- "엑셀에서 export 할때 지금처럼 전체 vcenter 를 하나에 sheet 에 표시하는거 유지하면서, 추가로 1개의 vcenter 를 1개의 sheet 에 표시해줘 클로드 디자인으로 설계해서 보여줘"
- 규칙(같은 날 '기억해'): 설계는 Fable + Claude Design 시안 → **컨펌 뒤** Opus 구현.

## 2. 지금 있는 것(코드 근거) — 그대로 두는 부분

| 있는 것 | 위치 | 이번 설계에서의 쓰임 |
|---|---|---|
| 통합 문서 3시트 `계층 표`·`평면 표`·`안내`(`ALLOC_XLSX_SHEETS`) · 시트 고르기 `ALLOC_SHEET_KEYS = tree·flat·info` · 단계 `ALLOC_DEPTHS` | `server/src/gpu/allocTreeXlsx.js:19~39` | **그대로**. 시트 키에 `corp` 하나를 더한다 |
| 계층 표 렌더 — 제목·기준·KPI 5칸·머리글(17열)·행 그룹(outline)·단계 색 `LEVEL`·인쇄 설정 `PRINT` | `allocTreeXlsx.js:127~192` | 법인 시트가 **같은 함수**로 그린다 — 입력을 `tree` 대신 법인 하나짜리 트리(`{ totals: vc.totals, vcenters: [vc] }`)로 주면 된다(`treeLines` 가 vcenters 를 돌므로 바꿀 것 없음) |
| 내보내기 창 — 범위 글자·단계 칩·시트 체크 3개·서식 목록·파일 이름(`/tools/gpu-alloc/export-meta`) | `web/src/views/tools/GpuAllocExportModal.jsx` · `gpuAllocText.js EXPORT_SHEETS` | 체크 항목 1개 추가(시안 ②) |
| 범위 — `allocTreeOf(req)`: scope 교집합 → `vcenterId`/`vcenterIds` → `scopeText`·`fileScope` | `server/src/routes/api/hardwareGpu.js:500~512` | 법인 시트는 **이 범위 안의 법인만** 만든다(범위 계정·칩 선택 모두 자동으로 맞음) |
| 파일 이름 `allocFileName(fileScope, stamp, ext, depth)` — 창 미리보기와 내려받기가 같은 함수 | `allocTreeXlsx.js:42` | 끝에 `_percorp` 를 붙이는 인자 하나 추가 |
| 시트 이름 정리 `replace(/[\\/?*[\]:]/g, '_').slice(0, 31)` | `server/src/ipam/excel.js:34` · `tools/wasteExportXlsx.js:28` · `vcenter/hostExport.js hostSheetNames` | 구현 정정: 공용 함수로 뽑지 않았다 — `allocTreeXlsx.corpSheetNames` 가 `hostSheetNames` 와 같은 규칙(겹침 `~2`)으로 따로 있다. 세 곳 통합은 별건(다른 두 곳은 겹침 처리가 없다) |
| 무거운 내보내기 동시 1건(`exportBusy`) · 큰 문서는 `yieldLoop` 로 양보 | `hardwareGpu.js:378` · `allocTreeXlsx.js:44` | 시트가 30장이 돼도 요청 경로를 막지 않게 법인마다 양보 |

## 3. 시안 ① — 통합 문서의 시트 구성(`Main.dc.html`, 탭을 눌러 본다)

```
[계층 표] [평면 표] [안내] [목차] [vcenter-ap-northeast-01] [vcenter-us-east-01] … (법인 수만큼)
 ─ 지금과 같음 ─────────  ─ 새로 ──  ─ 새로: 법인마다 1장 ────────────────────────────
```

- **계층 표·평면 표·안내는 바뀌지 않는다**(요구 1 — 전체 vCenter 한 시트 유지). 안내 시트에 ‘법인별 시트’ 한 줄만 더한다.
- **목차** — 모든 법인(GPU 호스트가 없는 법인 포함) 한 줄씩: 법인(vCenter) · 위치 · 호스트 · GPU · 전체 · 할당 · 예비 · 할당률(막대) · **시트**.
  법인 이름은 그 법인 시트로 가는 **하이퍼링크**(exceljs `cell.value = { text, hyperlink: "#'시트'!A1" }`). GPU 호스트가 없는 법인은 시트를 만들지 않고
  ‘— GPU 호스트 없음(시트 없음)’ 으로 적는다(빈 시트 28장이 생기지 않게). ‘시트’ 열에는 실제 시트 이름(줄였으면 ‘31자로 줄임’)을 적는다.
- **법인 시트** — 전체 계층 표에서 **그 법인 줄부터 아래를 그대로**(값·단계 색·행 그룹·머리글 고정·KPI 5칸은 그 법인 값).
  1행 오른쪽에 ‘← 목차’ 링크. ‘넣을 단계’(호스트·GPU·VM 까지)는 전체 시트와 같이 적용. 인쇄 설정도 같음.
- **탭 색**(`ws.properties.tabColor`) — 목차 회색 · 법인 파랑 · 할당률 90% 이상 법인 주황. 엑셀 하단 탭에서 포화 법인이 바로 보인다.
- **시트 이름** — vCenter 이름 → `: \ / ? * [ ]` 를 `_` 로 → 31자로 자름 → 뒤의 `-`·`.`·공백 제거 → 고정 시트(계층 표·평면 표·안내·목차)나 앞 법인과 겹치면 `~2`·`~3`.
  원래 이름은 목차와 시트 1행에 있으므로 잘려도 찾을 수 있다.
- **시트 순서** — 고정 4장 뒤에 법인 시트를 **화면 법인 칩과 같은 순서(id 순)** 로.

### 3.1 평면 표는 법인마다 만들지 않는다

평면 표에는 이미 법인(vCenter) 열이 있어 자동 필터가 같은 일을 하고, 법인마다 만들면 시트가 두 배(최대 60장)가 된다. 필요하면 다음 요청에서 옵션으로.

## 4. 시안 ② — 내보내기 창(`ExportModal.dc.html`)

- **법인(vCenter) 칸 추가 — 창을 열면 항상 모든 법인이 선택**(사용자 요청 2026-11-03 "엑셀 export 할때 기본적으로 모든 vcenter 를 선택").
  지금은 창이 화면의 칩 선택을 그대로 따르고 창에서 못 바꾸는데(`GpuAllocExportModal.jsx` 머리 주석), 이를 뒤집는다 — 창은 **화면 선택과 무관하게 전체 법인**으로
  시작하고, 칩으로 줄일 수 있다. 단추 ‘모두’ · ‘모두 해제’ · ‘화면 선택대로’(화면 칩 선택을 가져옴). 칩의 점은 GPU 호스트 유무(초록/회색).
  범위 계정은 자기 범위의 법인만 칩으로 보이고 그 전부가 기본 선택(서버 `allocTreeOf` 가 scope 교집합을 먼저 하므로 그 밖은 어차피 안 나간다).
  고른 법인이 0 이면 내려받기 버튼을 잠근다. 범위 글자 ‘모든 법인 N곳 · 호스트 · GPU’ 는 고른 칩에 따라 `export-meta` 를 다시 읽어 채운다(화면에서 더하지 않음).
- ‘시트’ 칸에 **법인별 시트** 체크 한 줄 추가(기본 **켬** — 사용자가 요청한 기능이라 기본값으로 둔다. 끄면 지금과 같은 3시트 파일).
  바로 아래 작은 상자: ‘법인 N곳 가운데 GPU 호스트가 있는 M곳 → 시트 M장’ + 시트 이름 칩(줄인 이름은 주황) — 값은 `export-meta` 가 준다(화면에서 지어내지 않음).
- 단계 설명에 ‘법인별 시트에도 같은 단계’ 한 구절, 서식 목록에 링크·탭 색 두 줄.
- 파일 이름 끝에 `_percorp`(끄면 없음) · 옆에 ‘시트 N장’. 파일 이름의 범위 부분은 지금 규칙 그대로(`all` · 법인 1곳 이름 · `Ncorps`).
- 그 밖(단계 칩·서식 목록·버튼)은 지금 창 그대로.

## 5. 구현 메모(컨펌 뒤 Opus) — 손댈 곳

| 영역 | 파일 | 바꾸는 것 |
|---|---|---|
| 서버 | `gpu/allocTreeXlsx.js` | `ALLOC_SHEET_KEYS` 에 `corp` · `ALLOC_XLSX_SHEETS` 에 `목차` · 계층 표 그리기를 `renderTreeSheet(wb, name, tree, meta, …)` 로 뽑아 전체·법인 둘이 호출 · `renderTocSheet` · `sheetNameOf(name, taken)` 공용화 · `allocFileName(…, { percorp })` · 안내 1줄 |
| 서버 | `routes/api/hardwareGpu.js` | `export-meta` 에 `corpSheets: [{ id, name, sheet, cut, hosts }]`·`corpSheetCount` 추가(범위 안 법인 전부 — GPU 없는 법인은 `snap` 의 vCenter 목록에서) · `.xlsx` 에 `sheets=corp` 전달 · 법인 시트마다 `yieldLoop` |
| 웹 | `gpuAllocText.js` · `GpuAllocExportModal.jsx` | 창 안 법인 칩(`corpChips` 재사용 — 기본 전부 선택 · ‘화면 선택대로’ 는 부모 `vcSel` 복사) · `allocExportQuery` 는 창의 선택으로(전부면 `vcenterIds` 를 싣지 않음) · `EXPORT_SHEETS` 에 `corp` · 체크 아래 상자 · 파일 이름 키(`fileNames` 를 `{depth}` → `{depth, percorp}` 로) |
| 테스트 | `server/test/gpuAllocTree2852.test.js` · `web/src/views/tools/gpuAllocText.test.js` | 시트 이름 규칙(금지 문자·31자·뒤 `-` 제거·겹침 `~2`) · 법인 시트 수 = GPU 호스트 있는 법인 수 · 목차 링크 대상 시트가 실제로 있음 · 범위 계정은 자기 법인만 · 창 쿼리 `sheets=corp` |
| 문서 | `docs/rules/gpu.md` · `docs/API.md` 재생성 | 시트 규칙 한 단락 |

측정해서 보고할 것: 목 데이터(법인 9곳)와 28법인 가정의 파일 크기·생성 시간(지금 3시트 대비).

## 6. 컨펌 때 정할 것(기본안은 굵게)

1. 법인별 시트 기본값 — **켬** / 끔.
2. 평면 표도 법인마다 — **아니오**(§3.1) / 예.
3. GPU 호스트 없는 법인 — **시트 없이 목차에만** / 빈 시트도 만든다.
4. 파일 이름 접미사 — **`_percorp`** / 없음.
5. 창의 법인 기본 선택 — **모든 법인(화면 선택과 무관)** / 화면 선택을 가져오되 바꿀 수 있게. (사용자 지시로 전자가 확정 — 2026-11-03 "기본적으로 모든 vcenter 를 선택")
