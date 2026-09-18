# Handoff: 특수 기능 › 서버 온도 — 히트맵 보드 (시안 B)

대상 저장소: `noainred/The.DVC` · 브랜치 `claude/vmware-global-monitoring-portal-nrnpnt`
대상 화면: `web/src/views/tools/CapacityTools.jsx` → `EsxiTemp({ scope })` (URL `#/tools/esxitemp/<view>`)
부수 범위: 상단 메뉴 2단화(`web/src/App.jsx` `.topbar`), 하단 상태바 톤(`.statusbar`), 24시간 스파크라인 API(`server/`)

## Overview

'서버 온도' 화면을 **표 나열 → 상태 보드**로 바꾼다. 상단에 KPI + 온도 분포(1℃ 히스토그램), 중단에 법인 비교 막대 + 이상 서버(32℃↑) 리스트, 하단에 **서버 1대 = 타일 1개 히트맵**과 기존 표(히트바·스파크라인·정렬)를 둔다. 하위 탭 4개(서버별·ESXi 호스트별·클러스터별·법인별), 물리/가상화 필터, 5년 추이 모달 등 **기존 기능은 모두 유지**하고, 밀도 토글(여유/촘촘히)과 법인 드릴다운(법인 클릭 → 히트맵·표 좁힘)을 추가한다.

## About the Design Files

이 번들의 `*.dc.html` 은 **HTML 로 만든 디자인 레퍼런스(프로토타입)** 다. 그대로 복사해 쓰는 제품 코드가 아니다. 할 일은 이 화면을 **대상 코드베이스의 기존 환경(React 18 + 해시 라우팅 + `styles.css` CSS 변수/클래스 + `DataTable`·`Card`·`Modal` 등 공용 컴포넌트)** 으로 재구현하는 것이다. 프로토타입은 브라우저에서 `server-temp.dc.html` 을 열면 동작한다(같은 폴더의 `support.js`, `temp-data.js` 필요). 데이터는 `temp-data.js` 의 결정적 난수(mock)이며 실제 API 응답 모양을 흉내 낸 것이다.

- `server-temp.dc.html` — **최종안(B)**. 이것을 구현한다.
- `server-temp-current.dc.html` — 현재 화면 재현본(before). 비교용.
- `temp-data.js` — mock 데이터 생성기. 필드 이름은 실제 API(`/tools/esxi-temp`)와 맞춰 두었다.
- `support.js` — 프로토타입 런타임. 구현과 무관.

## Fidelity

**High-fidelity.** 색·타이포·간격·상태는 최종값이다. 단, 값은 아래 규칙으로 **기존 토큰에 매핑**해서 쓴다(새 hex 를 흩뿌리지 않는다). 프로토타입은 Pretendard 폰트를 가정했지만 폰트 교체는 선택이다(§Design Tokens).

## 디자인과 의도적으로 달리하는 점 (먼저 읽을 것)

1. **범위(vCenter) select 는 기존 자리 유지.** `SpecialTools.jsx` 의 도구 패널 헤더(`← 특수 기능` · 제목 · `범위`)가 이미 `scope` 를 소유한다. EsxiTemp 는 자기 툴바(뷰 세그먼트·샘플링 표시·밀도 토글)만 그린다. select 를 두 번 그리지 않는다.
2. **스파크라인은 계열 이름을 정직하게 붙인다.** iDRAC 서버의 장기 이력은 기본 설정에서 `idractemp_max`(최고 센서)만 적재된다(`server/src/idrac/serverTempSeries.js`). 흡기 계열(`idractemp_inlet`)은 `IDRAC_TEMP_SERIES_DETAIL=true` 일 때만 있다. 따라서 API 가 **키별 사용 메트릭을 응답에 싣고**, 화면은 툴팁에 '24시간 · 최고' / '24시간 · 흡기' 로 구분해 쓴다. 표의 현재온도(흡기)와 스파크라인(최고)이 다른 계열일 수 있음을 숨기지 않는다.
3. **법인 비교 막대의 점선 = 전체 평균 위치.** 프로토타입은 고정 위치다. 구현은 `summary.all.avgC` 를 15~30℃ 스케일에 놓아 그린다.
4. **5년 추이 모달은 그대로.** 서버(ESXi 출처)·호스트·클러스터·법인 이름 클릭 → 기존 `openHist(level, key)`. 디자인에는 안 보이지만 제거하지 않는다.
5. **히트맵 타일 툴팁은 타일 단위.** 프로토타입은 성능상 그룹 툴팁만 있다. React 에서는 그룹당 `<svg>` 하나 + `<rect>` 마다 `<title>` 로 구현한다(1,157 rect 는 문제 없음).

## Screens / Views

화면은 하나(`EsxiTemp`)이며 위→아래 7개 블록이다. 컨테이너: `padding: 18px 24px 64px`(하단 여백은 고정 상태바 높이), `max-width: 1680px`, 블록 간 `gap: 14px`(세로 flex).

### 0. 앱 셸 (App.jsx) — 2단 상단 메뉴 + 상태바

**헤더 `header.topbar`** — `position: sticky; top: 0; z-index: 30; background: rgba(12,17,30,.9); backdrop-filter: blur(10px); border-bottom: 1px solid var(--border-soft)`.

- **1행(브랜드 행)** — `display:flex; align-items:center; gap:14px; padding:6px 20px; min-height:44px; flex-wrap:wrap; row-gap:4px`
  - 로고 26×26, `border-radius:7px`, `background: linear-gradient(135deg, var(--accent), var(--accent-2))`, 글자 `V` 13px/800 색 `#04101f`.
  - 브랜드 `The Davinci` 13px/700 + ` Virtual Platform` 13px/500 `var(--text-dim)` (한 줄).
  - 버전 칩(기존 `.brand-ver` 내용) 10.5px/700 `var(--accent-2)`, bg `rgba(34,211,238,.1)`, border `1px solid rgba(34,211,238,.28)`, `padding:1px 7px; border-radius:10px`.
  - LIVE 칩 10.5px/700 `#4ade80`, bg `rgba(34,197,94,.1)`, 앞에 6px 점(`#4ade80`, `box-shadow:0 0 6px #4ade80`, `animation: pulse 2s infinite`).
  - `spacer` (flex:1).
  - 상태 표시(기존 `.status-pill` 내용, 칩 배경 없이): 모노 폰트 12px, `letter-spacing:.04em`, `var(--text-dim)`: `● 21/21 vCenter` `OK`(`#4ade80` 700) `·` `08:24:07`. 점 7px `var(--green)` + `box-shadow:0 0 8px var(--green)`.
  - 사용자: 아바타 26px 원(gradient 135° `var(--accent-2)`→`var(--accent)`, 글자 12px/800 `#04101f`), 이름 12.5px/600, `Out` 버튼(`padding:4px 9px; border-radius:6px; border:1px solid var(--border); background:none; color:var(--text-dim); font-size:11.5px; font-weight:600`, hover `color:var(--text); border-color:var(--accent)`).
- **2행(메뉴 행) `nav.tabs`** — `display:flex; gap:2px; padding:0 12px; overflow-x:auto; border-top:1px solid rgba(255,255,255,.04)`
  - `.tab`: `padding:9px 12px; background:none; border:none; border-bottom:2px solid transparent; border-radius:0; color:var(--text-dim); font-weight:600; font-size:13px; white-space:nowrap`
  - `.tab:hover`: `color:var(--text)` (배경 없음)
  - `.tab.active`: `color:var(--text); font-weight:700; border-bottom-color:var(--accent-2)` (**파란 채움 버튼 → 청록 밑줄**)
  - ⚠ `.tab` 은 앱 전역에서 일반 버튼으로도 쓰인다(`className="tab"` 수십 곳: 접속확인·필터 초기화·CSV 선택 등). 위 규칙은 **`.topbar .tabs .tab` 로 한정**해 적용하고, 전역 `.tab` 은 건드리지 않는다.

**푸터 `footer.statusbar`** — `background: rgba(12,18,32,.92); border-top:1px solid var(--border-soft); backdrop-filter: blur(10px); font-family: var(--font-mono)`
- `.sb-cell`: `padding:7px 14px; gap:10px; font-size:12px; border-right:1px solid var(--border-soft)`
- `.sb-label`: `font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-faint)`
- `.sb-val`: `font-weight:700` (tabular-nums 유지). 보조값 `(4,641 On)` 은 `color:var(--text-dim); font-weight:400`.

### 1. 툴바(콘솔 바)

`display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; padding:12px 16px; border-radius:12px; background: linear-gradient(180deg, rgba(20,27,45,.9), rgba(13,20,28,.85)); border:1px solid var(--border); border-left:2px solid var(--teal)`

- 왼쪽: 모노 라벨 `▸ 특수 기능 / 서버 온도` — 12px, `letter-spacing:.22em; text-transform:uppercase; color:var(--text-dim)`, `▸` 는 `var(--teal)`, 오른쪽 여백 10px. (ToolPanel 헤더가 이미 제목을 그리므로 이 라벨은 **생략 가능** — 툴바 첫 요소를 세그먼트로 시작해도 된다.)
- **뷰 세그먼트**(하위 탭): 컨테이너 `display:flex; gap:2px; background:var(--panel-deep); border:1px solid var(--border); border-radius:9px; padding:3px`. 버튼 `padding:5px 12px; border-radius:6px; border:none; font-size:12.5px; font-weight:600; white-space:nowrap`; 활성 `background: rgba(59,130,246,.22); color:#dbeafe`; 비활성 `background:transparent; color:var(--text-dim)`, hover `color:var(--text)`. 항목: `서버별` `ESXi 호스트별` `클러스터별` `법인별` → `useHashTab` 값 `server|host|cluster|vc`.
- 오른쪽: 샘플링 표시 — 모노 11px `letter-spacing:.14em; uppercase; color:var(--text-faint)`: 7px 점(`var(--teal)`, `box-shadow:0 0 8px`, `animation: pulse 2.4s infinite`) + `Sampling 5m · **08:24:07**`(굵은 부분 `var(--text)` 700). 5m 은 `data.avgWindowLabel`, 시각은 `data.generatedAt`(없으면 응답 수신 시각) — 하드코딩 금지.
- **밀도 토글**: 컨테이너 `display:inline-flex; border:1px solid var(--border); border-radius:8px; overflow:hidden; background:var(--panel-deep)`; 버튼 `padding:6px 11px; font-size:12px; font-weight:600; border:none`; 둘째 버튼 `border-left:1px solid var(--border)`; 활성 `background: rgba(59,130,246,.18); color:#bfdbfe`; 비활성 `color:var(--text-dim)`. 라벨 `여유` / `촘촘히`.

### 2. KPI + 분포 (2열 그리드)

`display:grid; grid-template-columns: minmax(260px,300px) minmax(0,1fr); gap:14px`. 1200px 미만이면 1열로 접는다(`@media (max-width: 1200px) { grid-template-columns: 1fr }`).

**왼쪽(2×2 소그리드, gap 10)**
- **큰 카드(2칸)** `온도 수집 서버`: `.card` 스타일(§Tokens `card`), `padding:14px 16px; display:flex; align-items:flex-end; justify-content:space-between`.
  - 라벨: 모노 10.5px `letter-spacing:.14em; uppercase; var(--text-dim)`.
  - 값: `S.all.reporting` — 34px/800, `line-height:1; letter-spacing:-1px; tabular-nums`, 위 여백 8.
  - 하단: `iDRAC 1,133 · ESXi 24` 모노 11.5px `var(--text-faint)` (`idrac.counts`).
  - 오른쪽 범례(세로 3행, 11.5px, `min-width:96px`, 행 `display:flex; justify-content:space-between`): 8px 사각(초록/황/빨) + `정상`/`32℃↑`/`40℃↑` + 개수(굵게; 32↑ 는 `#fbbf24`, 40↑ 는 `#f87171`). 개수는 `rows` 에서 `curC` 로 계산.
- **소카드 ×2** `물리 평균` / `가상화 평균`: `.card` + `border-top:2px solid var(--amber)` / `var(--green)`, `padding:12px 14px`. 라벨 모노 10.5px; 값 24px/800 색 `#fbbf24` / `#4ade80` + 단위 `℃` 12px `var(--text-dim)` 600; 메타 11px `var(--text-faint)` `502대 · 최고 100℃`. 값은 `toFixed(1)`.

**오른쪽 — 분포 카드** `.card`, `padding:14px 16px 10px; display:flex; flex-direction:column`.
- 헤더 행: 라벨 모노 10.5px `현재 온도 분포 · 서버 1,157대 · 1℃ 구간`; 오른쪽 12px `var(--text-dim)`: `최고 센서 **100℃**(#f87171) · 흡기 평균 **20.6℃**(var(--text))`.
- 차트 영역 `position:relative; flex:1; min-height:104px; margin-top:12px`:
  - 버킷 33개: t = 14..46, 마지막(46)은 `46℃ 이상`. `n = rows.filter(floor(curC)==t)`(범위 밖은 양끝에 클램프).
  - 막대: `flex:1; height: max(2%, n/maxN*100%); min-height:2px; background: tempColor(t); border-radius:3px 3px 0 0; opacity:.85`, hover `opacity:1`. 막대 위 개수 라벨 10px `var(--text-dim)` — `n >= maxN*0.35` 또는 `(t>=32 && n>0)` 일 때만.
  - 임계선: `left: 54.5%`(=(32−14)/33) 점선 `1px dashed rgba(245,158,11,.6)` + 라벨 `32℃` 모노 10px `#fbbf24`; `left: 78.8%`(=(40−14)/33) `rgba(239,68,68,.65)` + `40℃` `#f87171`. 선은 `top:-6px; bottom:0`.
  - 축: `display:flex; justify-content:space-between; font-size:10.5px; color:var(--text-faint); border-top:1px solid var(--border-soft); padding-top:6px; margin-top:6px` — `14℃ 18 22 26 30 34 38 42 46+`.
  - 툴팁(title): `20~21℃ · 137대`.

### 3. 법인 비교 + 이상 서버 (2열)

`display:grid; grid-template-columns: minmax(0,3fr) minmax(300px,2fr); gap:14px` (1100px 미만 1열).

**섹션 카드 공통** — `.card` 배경, `border-radius:12px; overflow:hidden; display:flex; flex-direction:column`. 헤더 `display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-bottom:1px solid var(--border-soft)`; 제목 13.5px/700 + 부제 12px `var(--text-dim)`.

**법인 비교** — 부제 `현재 평균 · 막대 15~30℃ · 법인을 누르면 아래 히트맵·표를 그 법인으로 좁힙니다`. 헤더 오른쪽 범례 11px: `▬ 물리`(`#fbbf24` 14×6) `▬ 가상화`(`#4ade80`) `● 전체 평균`(6px `var(--text)`).
- 목록 `padding:6px 8px 8px; overflow:auto; max-height:380px`(촘촘히 300). 정렬: `all.avgC` 내림차순(`idrac.byDatacenter` 순서 그대로 — 서버가 이미 그렇게 정렬).
- 행: `display:grid; grid-template-columns:120px minmax(0,1fr) 52px 74px; align-items:center; gap:12px; padding:7px 8px`(촘촘히 `4px 8px`); `border-radius:8px; cursor:pointer; border:1px solid transparent`; hover `background: rgba(59,130,246,.08)`; **선택** `background: rgba(59,130,246,.14); border-color: rgba(59,130,246,.5)`; 다른 법인이 선택되면 이름 색 `var(--text-dim)`.
  - 1열: 이름 12.5px/600 ellipsis; 아래 10.5px `var(--text-faint)` `아시아 · 물리 153 · 가상화 89`(리전은 vCenter `location.region` 이 있을 때만; 없으면 생략).
  - 2열: 막대 2개(세로 gap 3) `height:6px; border-radius:3px; background: rgba(255,255,255,.05)`; 채움 `width: w(avg)`, 색 `tempColor(avg)`(값 없으면 `rgba(255,255,255,.1)`, 폭 0). `w(v) = clamp((v−15)/15, .02, 1)`. 전체 평균 점: 7px 흰 원(`var(--text)`, `box-shadow: 0 0 0 2px var(--panel)`), `left: w(all.avgC)`, 세로 중앙. 점선 가이드 `1px dashed rgba(245,158,11,.35)` at `w(summary.all.avgC)`(전체 평균).
  - 3열: 두 값 11px 우측 tabular(물리 `#fbbf24` 계열색, 가상화 `#4ade80` 계열색 — 실제로는 `tempColor`), `line-height:1.35`.
  - 4열: 전체 평균 15px/700 `tempColor`; 아래 경보 칩(있을 때만) 10px/700 `padding:1px 6px; border-radius:8px` — `40℃↑ N`(bg `rgba(239,68,68,.16)`, `#f87171`) 우선, 없으면 `32℃↑ N`(bg `rgba(245,158,11,.16)`, `#fbbf24`). N 은 해당 법인 rows 의 `curC` 임계 개수.
- 클릭: `sel = (sel === key ? null : key)` → §5·§6 필터. `limit` 25 로 리셋.

**이상 서버** — 부제 `현재 32℃ 이상 · 더운 순`; 헤더 오른쪽 개수 칩 11px/700 `padding:2px 8px; border-radius:10px; bg rgba(239,68,68,.14); #f87171` `N대`.
- 목록 `overflow:auto; max-height:380px(300); padding:4px 8px 8px`. 행 `display:grid; grid-template-columns:20px minmax(0,1fr) 84px 54px; gap:10px; padding:8px 6px`(촘촘히 `5px 6px`); `border-bottom:1px solid rgba(36,48,73,.5)`; hover `rgba(59,130,246,.07)`.
  - 순위 11px `var(--text-faint)` 우측.
  - 이름 12.5px/600 ellipsis + 구분 칩(10px/700 `padding:1px 6px; radius 8` — 물리 amber / 가상화 green, 기존 `.badge` 축소판); 아래 10.5px faint `OC2 · OC2-CL01 · iDRAC`.
  - 24h 스파크라인 SVG 84×24: 면 채움(`rgba(239,68,68,.16)` 40↑ / `rgba(245,158,11,.14)`) + 선 `stroke-width:1.5; stroke: tempColor(curC)`, `stroke-linejoin/linecap: round`. y 는 계열 min~max 로 정규화(최소 span 2℃), 패딩 2/3px. 데이터 없음 → `—`(§Interactions 스파크 상태).
  - 값 15px/700 `tempColor` `toFixed(1)`; 아래 10px faint `24h +1.2`(= 현재 − 계열 첫 점; 계열 없으면 생략).
- 빈 목록: `이상 없음` 12px `var(--text-dim)` 가운데, `padding:20px`.

### 4. 서버 히트맵

섹션 카드. 헤더: 제목 `서버 히트맵`(뷰별: `ESXi 호스트 히트맵`/`클러스터 히트맵`/`법인 히트맵`), 부제 `타일 1개 = 서버 1대 · 법인별 · 더운 순 · 1,157대`; 선택 중이면 제목 옆 칩 `법인 WA ×`(`padding:3px 9px; radius 12; border 1px rgba(59,130,246,.45); bg rgba(59,130,246,.16); #bfdbfe; 11.5px/600`, `×` 는 `#7dd3fc`) — 클릭 시 해제. 오른쪽 범례 10.5px faint: `15℃ [그라디언트 120×8: rgba(34,197,94,.25) → #22c55e 55% → #f59e0b 62% → #ef4444 86%] 45℃` + 10px 빨간 사각(`animation: hotglow 1.6s infinite`) `40℃↑`.
- 본문 `padding:14px 16px; display:flex; flex-wrap:wrap; gap:12px`(촘촘히 8) `align-items:flex-start`.
- **그룹(법인) 카드**: `display:flex; flex-direction:column; gap:6px; padding:8px 10px; border-radius:10px; border:1px solid rgba(36,48,73,.8); background: rgba(10,14,23,.35); cursor:pointer`; hover `border-color: rgba(59,130,246,.5)`; 선택 `border-color: rgba(59,130,246,.55); background: rgba(59,130,246,.08)`. 헤더 11.5px 한 줄: 이름 700 · 개수 faint tabular · 평균 `tempColor` 700 우측(`margin-left:auto`) `20.1℃`.
- **타일 격자**: 항목을 값 내림차순으로 놓고 `cols = clamp(ceil(sqrt(n×2.2)), 4, 24)`, 행 = ceil(n/cols). 타일 크기: 서버/호스트 12px·gap 2(촘촘히 9·1), 클러스터 18·2(14·1), 법인 24·2(18·1). `rx=2`.
  - 채움: `null → rgba(255,255,255,.08)`; `<32 → rgba(34,197,94, 0.22 + clamp((v−15)/17,0,1)×0.7)`; `32~40 → var(--amber)`; `≥40 → var(--red)` + `stroke:#fecaca; stroke-width:1.5`.
  - 툴팁 `<title>`: `OC2-DB03 · 물리 · 41.6℃` / 호스트 `esx01.oc2.corp · OC2-CL01 · 27.3℃` / 클러스터 `WA / WA-CL02 · 호스트 24 · 21.0℃`.
  - 구현: 그룹당 `<svg width={cols×step−gap} height={rows×step−gap}>` + `<rect>`. 타일 클릭(선택)은 이번 범위에 없다.
- 뷰별 그룹 구성: `server` → 법인(`datacenterId||vcenterId`)별 rows(kind 필터 적용); `host` → `vcenterId` 별 hosts; `cluster` → 법인별 clusters(`key.split('|')[0]`); `vc` → 그룹 1개 `전체 법인`, 타일 = vcenters. `sel` 이 있으면 그 법인 그룹만.

### 5. 표

섹션 카드. 헤더: 제목 `서버별`(뷰별) + 부제 `1,157대 · 법인 WA`(선택 시); 오른쪽(서버별 뷰만) **구분 세그먼트** `전체 1157 / 물리 502 / 가상화 655`(§1 세그먼트와 같은 스타일, 버튼 `padding:4px 11px; font-size:12px`).
- 표 컨테이너 `overflow:auto; max-height:60vh` (`.table-wrap` 대신 카드가 테두리를 그리므로 표 자체 테두리는 없음).
- `table`: `border-collapse:separate; border-spacing:0; font-size:13px`(촘촘히 12.5).
- `th`: `padding:10px 14px`(촘촘히 `8px 12px`); `background: var(--panel-deep)`; `color: var(--text-dim)`(정렬 중인 열 `var(--text)`); `font-size:11px; font-weight:600; letter-spacing:.03em; position:sticky; top:0; white-space:nowrap; border-bottom:1px solid var(--border)`; 정렬 화살표 `▲/▼` 9px `#7dd3fc` 왼쪽 여백 4. hover `color:var(--text)`.
- `td`: `padding:9px 14px`(촘촘히 `5px 12px`); `border-bottom:1px solid rgba(36,48,73,.55)`; `white-space:nowrap; font-variant-numeric: tabular-nums; vertical-align:middle`.
- 행: hover `background: rgba(59,130,246,.07)`; **curC ≥ 40 → `rgba(239,68,68,.07)`, ≥ 32 → `rgba(245,158,11,.05)`** (hover 가 위). `DataTable` 에 행 스타일 훅이 없으면 `rowStyle={(r) => …}` prop 을 추가한다.
- 열(서버별): `서버`(600) · `구분`(`.badge.amber` 물리 / `.badge.green` 가상화) · `출처`(12px dim `iDRAC`/`ESXi`, stale 이면 ` · 오래됨`) · `법인`(dim) · `클러스터`(dim, 없으면 `—` faint) · `현재온도 ℃`(히트셀, 굵게) · `흡기 ℃` · `배기 ℃` · `CPU ℃`(히트셀) · `최고 ℃`(피크셀) · `24시간 추이`(스파크).
  - 호스트별: `호스트` · `법인` · `클러스터` · `현재온도 ℃` · `{avgWindowLabel} 평균 ℃` · `최대 온도 ℃`(피크) · `24시간 추이`.
  - 클러스터별/법인별: `클러스터|법인` · `호스트 수`(우측) · `현재온도 ℃` · `{avgWindowLabel} 평균 ℃` · `최대 온도 ℃` · `24시간 추이`. 이름은 `key.replace('|',' / ')`.
  - **히트셀**: `[막대 48×4](촘촘히 36) [값]` — 막대 track `rgba(255,255,255,.07); border-radius:2px; overflow:hidden; margin-right:8px; vertical-align:middle`, 채움 `width: clamp((v−15)/30, .04, 1)`, 색 `tempColor(v)`; 값 `display:inline-block; min-width:34px; color: tempColor(v); font-weight: 500`(현재온도는 700). `null → —`(faint, 막대 없음).
  - **피크셀**(최고/최대): 막대 없이 값만, `color: tempColor(v); opacity:.75; font-weight:400`. 이유: 최고 센서는 거의 항상 40℃↑ 라 막대까지 붉히면 경보색이 희석된다.
  - **스파크셀**: SVG 84×22 선만(`stroke-width 1.5`, 색 `tempColor(curC)`), `display:block; margin-left:auto`. 상태 `…`/`—` 는 `sparkBatch.js` 의 `sparkCellState/sparkCellText` 재사용. 정렬값은 현재온도.
  - 이름 셀: 추이가 있는 행(`level != null`)은 기존 `.cell-link` 버튼 → `openHist`. 없는 행은 `<span>`.
- 표 푸터 `display:flex; justify-content:space-between; align-items:center; padding:8px 16px; border-top:1px solid var(--border-soft); font-size:11.5px; color:var(--text-faint)`: 왼쪽 각주 `현재온도 = iDRAC 흡기 센서 · 최고 = 전체 센서 최댓값 · 열 제목을 누르면 정렬`; 오른쪽 `1,157행 중 25행 표시` + 버튼 `25행 더 보기`(`padding:4px 10px; radius 6; border 1px var(--border); bg var(--panel-deep); #bfdbfe; 11.5px/600`). 모두 표시되면 `N행` 만.
- 정렬 기본: `curC desc`(모든 뷰). 뷰 전환 시 정렬·limit 리셋.

## Interactions & Behavior

- **뷰 전환**(세그먼트): `setView(k)`(useHashTab) + `sort = {curC, desc}` + `limit = 25`. 히트맵·표 제목/열이 바뀐다. 구분 세그먼트는 서버별 뷰에서만 보인다.
- **구분 필터**(전체/물리/가상화): rows 필터 → KPI 는 **바뀌지 않는다**(전체 기준 유지, 현재 코드와 동일). 히트맵·표만 바뀐다. `limit` 리셋.
- **법인 선택**: 법인 비교 행 또는 히트맵 그룹 클릭 → 토글. 히트맵은 그 법인만, 표는 그 법인 rows 만, 부제에 `· 법인 X`, 히트맵 헤더에 해제 칩. KPI·분포·비교·이상 서버 리스트는 전체 유지.
- **밀도**: `여유|촘촘히` → 표 폰트/패딩, 타일 크기, 리스트 패딩, 리스트 max-height 가 §Screens 의 두 값 사이에서 바뀐다. `localStorage['dvc.esxitemp.density']` 에 저장·복원(다른 화면 키와 충돌 없게 접두 유지).
- **정렬**: th 클릭 — 같은 열 재클릭 시 desc→asc 토글(DataTable 기존 동작). `null` 은 항상 뒤.
- **더 보기**: `limit += 25`. 스파크라인은 **보이는 행에 대해서만** 배치 조회(§API). 최대 200행까지(`SPARK_ROW_CAP`) — 넘으면 `sparkCapText` 문구를 푸터 각주에 덧붙인다.
- **이름 클릭**: 기존 5년 추이 모달(변경 없음).
- **hover**: 표 행·비교 행·이상 서버 행 배경, 히트맵 그룹 테두리, 히스토그램 막대 opacity, 세그먼트 텍스트 색. 전환 `transition: background-color .12s, border-color .12s`.
- **애니메이션**: `@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }`(LIVE 점·샘플링 점), `@keyframes hotglow { 0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,0)} 50%{box-shadow:0 0 0 3px rgba(239,68,68,.35)} }`(범례 사각만; 타일에는 걸지 않는다 — 수백 개 애니메이션은 GPU 낭비).
- **로딩/오류**: 기존 `Loading`/`ErrorBox`. 응답 후 `idrac.reason`·`avgError`·수집 0대 경고 `.card`(amber 테두리)는 **툴바 아래, KPI 위**에 그대로 둔다.
- **빈 상태**: 히트맵 그룹이 0개면 섹션 본문에 `표시할 서버가 없습니다` 12px dim; 이상 서버 0 → `이상 없음`.
- **반응형**: 1200px 미만 KPI 그리드 1열, 1100px 미만 비교/이상 1열. 표는 가로 스크롤. 상단 메뉴 행은 가로 스크롤(`overflow-x:auto`).

## State Management

`EsxiTemp` 내부 상태(훅은 **조기 return 위**에 모두 선언 — React #310 회귀 방지, `CLAUDE.md` 규약):

```
view      : useHashTab({ base:['tools','esxitemp'], valid:['server','host','cluster','vc'], fallback:'server' })  // 기존
kindF     : 'all'|'physical'|'virtual'                                                                          // 기존
sel       : string|null      // 선택 법인 key (byDatacenter[].key)
dense     : boolean          // localStorage 'dvc.esxitemp.density' === 'compact'
sort      : { key, dir }     // DataTable 이 내부 관리하면 initialSort 만 넘기고 view 변경 시 key 로 리마운트
limit     : number           // 25, +25
hist/days/bucket/histGen     // 기존 모달 상태 그대로
spark     : useTempSparklines(visibleRows, level)  // { map: key→points|null, asked:Set, progress, metricByKey }
```

파생값(useMemo): `srvRows`(kind·sel 필터), `buckets`(33개), `byDcView`(비교 목록 + 임계 개수), `hotList`(curC≥32 desc), `groups`(히트맵), `tableRows`(정렬·slice).

데이터: `useTool('/tools/esxi-temp', scope ? { vcenterId: scope } : {})` 그대로. 응답 필드(변경 없음): `idrac.rows[]{id,source,kind,name,ip,serviceTag,datacenterId,vcenterId,cluster,hostName,curC,maxC,inletC,exhaustC,cpuC,sensors,at,stale}`, `idrac.summary{all,physical,virtual}{servers,reporting,avgC,minC,curMaxC,maxC,avgInletC,…}`, `idrac.byDatacenter[]{key,name,all,physical,virtual}`, `idrac.counts{idrac,esxi,stale,noSensors}`, `idrac.reason`, `hosts[]{id,name,vcenterId,cluster,curC,avg5C,tempMaxC}`, `clusters[]/vcenters[]{key,hosts,curC,avg5C,maxC}`, `avgWindowLabel`, `sampleIntervalMs`, `avgError`, `reportingHosts`.

### 24시간 스파크라인 — 새 API (구현 포함)

`server/src/routes/api/toolsCapacity.js` 에 추가. 기존 `/tools/esxi-temp/history` 바로 아래.

```
POST /tools/esxi-temp/spark   requirePerm('tools')
body: { items: [{ key, source }], hours?: 24 }
      source: 'idrac' | 'esxi' | 'cluster' | 'vc'   (서버별 뷰는 행의 r.source, 다른 뷰는 뷰 이름)
resp: { hours, bucketMs: 3600000, maxItems, capped, skipped, synthesized,
        series: { [key]: [{ ts, avg, max }] | null }, metricByKey: { [key]: 'idractemp_inlet'|'idractemp_max'|'temp_host'|'temp_cluster'|'temp_vc' } }
```

- 메트릭 선택(순수 함수 `sparkMetricFor(source, { detail })` — `server/src/tools/serverTemp.js` 에 추가, 테스트로 고정):
  `idrac → detail ? 'idractemp_inlet' : 'idractemp_max'` · `esxi → 'temp_host'` · `cluster → 'temp_cluster'` · `vc → 'temp_vc'`. `detail` 은 `TEMP_SERIES_DETAIL`(`idrac/serverTempSeries.js`). detail 이지만 흡기 계열이 비어 있으면(`points.length === 0`) `idractemp_max` 로 한 번 더 조회하고 `metricByKey` 에 실제 쓴 메트릭을 적는다.
- 조회: `const db = await getMetricsDb(); db.history(metric, key, Date.now() − hours×3_600_000, 3_600_000, hours)`. 점이 2개 미만이면 `null`. `db.history` 실패는 기존 route 처럼 `console.warn` + 그 키 `null`(응답 전체를 500 으로 만들지 않는다).
- 상한: 요청당 `maxItems = 200`(env `ESXI_TEMP_SPARK_MAX`, 기본 200). 넘는 항목은 `skipped` 로 세고 `capped:true`. 화면은 응답의 `maxItems` 로 배치 크기를 맞춘다 — **화면에 숫자를 하드코딩하지 않는다**(`sparkBatch.js` 규약).
- 범위 강제(존재 은닉 — 기존 history 라우트의 `owns` 와 같은 규약): `idrac` 키는 `analysisServersWithRemote(req)` 의 id 집합, `esxi/cluster/vc` 키는 사용자 scope 의 hosts/clusters/vcenters 집합에 있어야 한다. 밖의 키는 조회하지 않고 `series[key] = null`(오류 아님, 응답 200).
- mock(`snap.source === 'mock'`): 기존 history 라우트의 합성 규약(`hash(key)` 기반 결정적 곡선, `synthesized:true`)을 재사용해 24점 합성.
- 메모: 스냅샷 파생이 아니라 DB 조회라 `memoJson` 은 쓰지 않는다. 필요하면 `snapCache` 12초 TTL 로 `items` 서명 키 캐시(선택).
- 부수 등록: `web/src/components/taskLabel.js` 에 `'/tools/esxi-temp/spark': { label: '서버 온도 24시간 추이' }`; `server/src/auth/toolAccess.js` 의 esxi-temp 라우트 목록/강제 표에 새 경로가 필요하면 추가(파일 상단 규약 확인).

프런트 훅 `useTempSparklines(rows, level, enabled)` — `Waste` 의 `useSparklines` 를 본떠 **순차 배치**(응답 `maxItems` 로 크기 조정), `asked` Set 으로 대기(`…`)/없음(`—`) 구분, `dead` 가드. 입력 키가 바뀌면 리셋. 서버별 뷰는 `items = rows.map(r => ({ key: r.id, source: r.source }))`, 다른 뷰는 `source = view`.

## Design Tokens

**기존(`web/src/styles.css` :root — 그대로 사용)**: `--bg #0a0e17` · `--bg-soft #111726` · `--panel #141b2d` · `--panel-2 #1a2236` · `--border #243049` · `--text #e6edf6` · `--text-dim #8b9bb4` · `--text-faint #5d6b85` · `--accent #3b82f6` · `--accent-2 #22d3ee` · `--green #22c55e` · `--amber #f59e0b` · `--red #ef4444` · `--radius`. (구현 전 :root 블록에서 이름을 재확인한다 — 추정으로 `var()` 를 쓰지 않는다.)

**추가 제안(:root 에 3개)**:
- `--border-soft: #1f2a40` — 카드 내부 구분선·헤더/푸터 테두리(`--border` 보다 한 단계 어둡다).
- `--panel-deep: #0f1626` — 세그먼트·th·더보기 버튼 배경(`--bg-soft` 보다 살짝 어둡다). 대안: `--bg-soft` 로 통일해도 무방.
- `--teal: #2dd4bf` — 툴바 왼쪽 테두리·▸·샘플링 점(기존 `.badge.teal` 글자색과 동일 계열).
- `--font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` — 모노 라벨·상태·푸터.

**강조 글자색(파생, 클래스에만)**: `#4ade80`(green 400) · `#fbbf24`(amber 400) · `#f87171`(red 400) — 기존 `.badge.*` 가 이미 쓰는 값. 파란 세그먼트 활성 글자 `#dbeafe`/`#bfdbfe`, 정렬 화살표 `#7dd3fc`.

**상태색 규칙(변경 없음)**: `tempColor(c)` = `null → var(--text-faint)`, `≥40 → var(--red)`, `≥32 → var(--amber)`, 그 외 `var(--green)`. 임계값을 `shared.jsx` 에 `TEMP_WARN_C = 32`, `TEMP_HOT_C = 40` 상수로 빼고 KPI 개수·히스토그램 선·행 배경이 같은 상수를 쓴다.

**카드(`card`)**: `background: linear-gradient(180deg, var(--panel), var(--bg-soft)); border:1px solid var(--border); border-radius:12px; box-shadow: 0 4px 24px rgba(0,0,0,.35)`(기존 `.card` 와 동일 계열 — 값이 다르면 기존 `.card` 를 우선).

**타이포**: 본문 폰트는 기존 스택 유지(프로토타입의 Pretendard 는 선택 — 넣을 경우 CDN 이 아니라 `web/public/fonts/` 자체 호스팅, 오프라인 현장). 크기 스케일: 34/24/15/13.5/13/12.5/12/11.5/11/10.5/10. 숫자는 전부 `font-variant-numeric: tabular-nums`. 큰 값 `letter-spacing:-1px`, 모노 라벨 `letter-spacing:.14em~.22em` uppercase.

**간격**: 블록 14 · 카드 안 12~16 · 리스트 행 7~8(촘촘히 4~5) · 표 셀 9×14(촘촘히 5×12). **반경**: 카드 12 · 그룹 10 · 세그먼트 9/6 · 칩 8~12(pill) · 타일 2.

## Assets

이미지·아이콘 없음. 로고는 기존 `.brand .logo` 글자 `V`. 이모지 `🌡️` 는 기존 도구 제목(ToolPanel)에만 남는다.

## Files

- `server-temp.dc.html` — 최종 디자인(B). 로직은 파일 하단 `<script data-dc-script>` 의 `Component` 클래스에 있다: 버킷·히트맵 격자·비교 막대·스파크 path 계산식을 그대로 옮길 수 있다(`renderVals()`).
- `server-temp-current.dc.html` — 현재 화면 재현(before).
- `temp-data.js` — mock 데이터/응답 모양(`buildData()`), `tempColor`.
- `support.js` — 프로토타입 런타임(참고 불필요).
- `CLAUDE_CODE_PROMPT.md` — Claude Code 에 붙여 넣을 실행 프롬프트.
