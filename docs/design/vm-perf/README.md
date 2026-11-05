# 설계: VM 상세 · 성능 그래프 — ① vCenter 트리의 VM 클릭을 가상화 서버와 같은 드로어로 · ② ‘성능 그래프 보기’ 재설계

작성 2026-11-06 (main v2.910.0 기준 · 브랜치 `claude/wizardly-goodall-2frd1k`) · 상태 **구현됨 v2.911.0**(컨펌 2026-11-06 08:20 '개선' — §6 질문 6가지 모두 기본값 · 검증 표준 · §8. 구현은 규칙상 Opus 이지만 사용자가 모델을 바꾸지 않고 바로 '개선' 이라 답해 이 세션(Fable)이 이어서 구현했다 — 보고에 밝힘) ·
시안 캔버스: https://claude.ai/artifact/EBKGEKL86TmCvytJ2k3KuD (아트보드 6장 — ⓪ 지금 · ① vCenter 트리 → 드로어 · ② 성능 1440 · ③ 성능 400 · ④ 상태 6종 · ⑤ 대안(모달 유지).
이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스(HTML 프로토타입 — 복사 대상이 아님). **VM · vCenter 이름(web-kr1-023 · VC-KR1 · esx-kr1-07 …)과 수치는 전부 가상**이고 ⓪ 의 캡처는 목 서버 데이터다.
색 · 글자는 `web/src/styles.css` `:root` 토큰과 `views/vms/vmHub.css` · `views/tools/xferSpeed.css` 그대로(새 hex 없음). 계정의 ‘Design System’ 아티팩트는 지금도 타입 파일뿐이라(`project/README.md` · `tokens.json` 없음 — 목록으로 확인) 쓰지 않았다.
규칙(2026-11-03 ‘기억해’): 설계는 Fable + Claude Design 시안 → **컨펌 뒤** Opus 구현. §2 는 이 세션(Fable)이 코드와 목 서버 캡처로 확인한 사실이다.

## 1. 요구(사용자 2026-11-06 07:09 KST)

> "vcenter 에서 VM 클릭하면 나오는 화면을 가상화 서버에서 VM 클릭하면 나오는 화면으로 교체해줘
> 성능 그래프 누르면 나오는 화면이 잘 안되는데, 클로드 디자인으로 시안 만들어서 보여줘"

첨부 ① 법인별 전송 속도 › 법인 상세(AZ — 기간 세그먼트 · 통계 카드 6 · 추이 차트 · 범례 · ◀ 이전 24시간 / 슬라이더 / 다음 ▶ / 최신 / 날짜로 이동) — 성능 화면이 따라갈 모양.
첨부 ② vCenter 상세 › 호스트 및 클러스터 트리(AZ · 20 호스트 · VM 195) — VM 행을 누르는 자리.

## 2. 지금 코드에서 확인한 것(설계의 근거 — 2026-11-06 07:10~07:25 KST)

| 사실 | 위치 |
|---|---|
| **가상화 서버**(`#/vms`)에서 VM 행 클릭 → **오른쪽 드로어** `VmDrawer`(v2.909 · 시안 `docs/design/vm-screen` ⑦⑧). 신호 배지 · 경로 줄 · 버튼 6 · 타일 4(24시간 스파크는 열 때 1회) · 신호 행 · 구성 KV · IP 핑 · 섹션 6 · 푸터 ‘개체 보기 탭 바로가기’ · ‹ › ↑↓ 로 목록 순서 이동 | `web/src/views/Vms.jsx:72` · `web/src/views/vms/VmDrawer.jsx` |
| **vCenter 상세**(호스트 및 클러스터 · VM 및 폴더) 트리에서 VM 행 클릭 → **옛 640px 가운데 모달** `EntityDetail type='vm'`. 행의 ‘⤢ 개체 보기’ 단추(1440 은 마우스 올릴 때) → `VmObject` | `web/src/views/VCenterDetail.jsx:784·819·834(setSel) → :871` · `components/EntityDetail.jsx:626` · `vcd/VmObject.jsx` |
| ⚠ 정정: 이 세션의 브랜치는 처음에 main 보다 뒤(v2.908)여서 **둘 다 모달**로 보였다 — `git merge --ff-only origin/main`(v2.910.0) 뒤 다시 확인해 위 차이를 확정했다. 캡처 ⓪ 은 v2.910 목 서버 | `git log` 7986313 |
| **‘📈 성능 그래프 보기’** 는 어디서 눌러도 같은 `MetricModal`(900px · recharts AreaChart). VM 쪽 4곳(옛 모달 · 드로어 · 개체 보기 머리 · 개체 보기 모니터 탭 ‘성능’ 카드) + 호스트 3곳(호스트 모달 · `HostObject` 머리/모니터 탭 · `HostDetail` 전체 페이지) | `components/VmMetrics.jsx` · `EntityDetail.jsx:716` · `VmDrawer.jsx:113` · `VmObject.jsx` · `HostObject.jsx:47·75` · `HostDetail.jsx:137` |
| 모달의 조작: 지표 버튼 4(CPU 사용률 · 메모리 사용률 · 디스크 I/O · 네트워크 I/O) + 기간 버튼 5(실시간 · 일 · 주 · 월 · 년 평균) 한 줄 · `datetime-local` 두 칸 + 적용/최근으로 · 현재/평균/최대 글줄 · 높이 340 차트 · 실시간 20초 자동 갱신 | `VmMetrics.jsx:62~183` |
| API `GET /vms/:id/metrics?type=cpu|mem|disk|net&interval=realtime|day|week|month|year[&start&end][&manual=1]` — scope 밖 404 · 목은 `synthMetric` · 인증 정지 vCenter 는 409 `authStopped`(manual=1 은 통과) · 직접 수집 대상 아님은 409 `skipReason`(manual 도 막음) · 호스트는 `/hosts/:id/metrics` 같은 모양 | `server/src/routes/api/vmMetrics.js:94·125` · `vcenter/authStopGate.js:76` |
| vCenter 조회 `fetchEntityMetric`: **호출마다 login → perfCounterMap(6시간 캐시) → QueryPerf 1카운터 → logout**. 카운터 `cpu.usage.average`(÷100 %) · `mem.usage.average` · `disk.usage.average`(KBps) · `net.usage.average`(KBps). 실시간은 `maxSample 180`(= 1시간). 결측 -1 → `null`(`entityMetricPoints`) | `server/src/vcenter/soapClient.js:1240~1300` · `PERF_INTERVALS` {realtime 20 · day 300 · week 1800 · month 7200 · year 86400} :1211 |
| **여러 카운터를 QueryPerf 1회**로 받는 함수가 이미 있다(축소 근거 리포트가 쓴다): `queryEntityPerfMulti(entityType, ref, counterIds, intervalId, {startTime,endTime})` → `Map<counterId, [{t,v}]>` | `soapClient.js:548` · `parsePerfMultiXml` :1182 |
| 화면 판정 한 벌: `metricErrorState`(409 본문 → authStopped / skip) · `stopsAutoRefresh` · `metricAuthStopText` · `metricSkipText` · 요약 `metricStats`(결측을 0 으로 더하지 않음) — **새 화면도 이것을 그대로 쓴다** | `components/vmMetricsText.js` · `vmMetricStats.js` |
| 드로어 · 개체 보기 요약의 24시간 스파크: `useDaySeries` 가 `type=cpu` · `type=mem` **2회** 호출(= 로그인 2회) · AbortController 로 늦은 응답 폐기 | `views/vms/vmSeries.jsx` |
| 과부하 신호 기준 `OVERLOAD_PCT = 90`(분포 패널 ‘90%↑’ 와 같은 칸) — 화면 기준선은 이 값을 API 로 받아 그린다(화면에 90 을 박지 않는다) | `server/src/inventory/vmSignals.js:23` |
| vCenter **보관 주기(`PerformanceManager.historicalInterval`)는 수집하지 않는다**(grep 0건) — 과거 창의 롤업 선택 · 슬라이더 범위는 이 값이 필요하다(§4.2) | `soapClient.js` |
| 참고 화면(첨부 ①): `PERIODS` 세그먼트 · `.xs-stats` 카드 · 차트 카드 + 범례 + 주석 줄 · `WindowScroll`(◀ 이전 · 슬라이더(놓을 때 조회) · 다음 ▶ · 최신 · 날짜로 이동) · 창 계산 순수 함수 | `views/tools/XferSpeedTool.jsx:748·783` · `xferSpeedText.js:408~516`(`maxBackOf` · `windowEndOf` · `windowLabel` · `windowRangeText` · `portalDateOf`) |
| 같은 모양의 구간 스크롤 선례 2곳(Infra Observability v2.666 · 전송 속도 v2.735.3) — 새 화면은 세 번째이므로 **창 계산을 공용 순수 모듈로** 뽑는 것이 맞다(복제 금지) | `views/tools/IdracTrendTool.jsx:436` |
| `VmObject` 모니터 탭: ‘성능’ 카드(문구 + 버튼) · ‘이벤트 · 이동’ · vCenter 알람 · 최근 작업 — 성능 화면이 들어갈 자리. 주소 `#/vcenters/<vc>/vm/<id>/monitor` 는 드로어 푸터 · 신호 행이 이미 링크한다 | `vcd/VmObject.jsx`(monitor) · `vcd/vcdRoute.js vcHash` |

규모(설계 제약): 운영 28 vCenter · RTT 800ms+ 법인 · vCenter 성능 조회는 **주기 수집이 아니라 사람이 열 때**(저장 안 함) · 인증 실패 정지 규칙(v2.591 — 모달을 연 채 두면 분당 3회 로그인 · 계정 잠금) · 주기·상한 숫자를 화면에 박지 않는다 · 1440/400.

## 3. 정직하게 밝혀야 하는 것(시안 문구에 반영)

1. **vCenter 보관 주기는 VMware 기본값으로 가정했다** — 5분 평균 1일 · 30분 평균 1주 · 2시간 평균 1달 · 1일 평균 1년 · 실시간(20초)은 1시간. 관리자가 바꿀 수 있는 값이므로 **읽어서 쓴다**(§4.2) — 실 vCenter 에서는 확인하지 못했다(목 서버뿐).
2. 과거 구간 조회는 `start/end` 로 **지금도 가능**하지만 `intervalId` 를 같이 바꾸지 않으면 보관 밖 구간(예: 5분 평균으로 어제보다 전)은 **빈 응답**이다 — 서버가 창의 나이로 롤업을 고르고 실제로 쓴 값을 돌려줘야 화면이 ‘30분 평균’ 이라고 말할 수 있다.
3. 실시간(20초)은 vCenter 가 최근 1시간만 보관한다 → 실시간 보기에는 구간 이동이 없다(화면이 그 이유를 말한다).
4. 지표 4개를 지금 방식(지표마다 로그인)으로 한 번에 그리면 **로그인이 4배**다 — 반드시 QueryPerf 1회(§4.1). 드로어 · 개체 보기 요약의 스파크(2회)도 같은 엔드포인트로 1회가 된다.
5. 엣지 위임 · 비활성 vCenter 는 중앙이 직접 묻지 않는다(409 skip) — 이 시안은 그 규칙을 바꾸지 않는다(상태 ④). 엣지 포탈의 같은 화면으로 안내하는 링크는 지금 모달에도 없다 → 구현 때 `findRemoteServer` 안내를 넣을 수 있는지 확인(지어내지 않는다).
6. ② 의 ‘구간 요약’ 표(최대 · 최저 시각 · 90% 이상 시간)는 **지금 받은 점으로 화면이 계산**한다 — 서버 호출이 늘지 않는다. 결측 점은 분모에서 빼고 ‘결측 n/288’ 로 밝힌다(`metricStats` 규약).
7. 캡처 ⓪ 의 ‘web-ap-0131 · 목록 1/1000’ 은 목 데이터이고, 시안 ①② 의 `web-kr1-023` 은 앞 시안(`vm-screen`)과 같은 가상 이름이다.

## 4. 데이터 · 서버(새 vCenter 호출 종류는 없음 — 묶는 방식만 바뀐다)

### 4.1 `GET /vms/:id/metrics?types=cpu,mem,disk,net&interval=day[&start&end][&manual=1]` (호스트 `/hosts/:id/metrics` 동일)
- `types`(복수) 가 있으면 **login 1회 · `queryEntityPerfMulti` 1회 · logout** 으로 4계열을 받는다. 기존 `type=`(단수) 는 그대로 둔다(호환 — 축소 근거 리포트 · 외부 호출).
- 응답: `{ ok, interval: '<실제로 쓴 롤업>', sampleSec, start, end, past: boolean, refreshSec: 20, overloadPct: 90, retention: { realtime, day, week, month, year }(초 · §4.2), series: { cpu: { unit:'%', points:[{t,v|null}] }, mem, disk: { unit:'KBps', … }, net }, mock }`.
- scope 404 · 409 `authStopped`/`skipReason` · 502 본문은 **지금과 같은 모양**(`authStopGate` · `respondVcError`) — 화면 판정 모듈을 바꾸지 않는다. `manual=1` 규칙도 그대로(사람이 누른 ‘지금 다시 조회’ 만).
- 목(`synthMetric`)은 `types` 를 받아 계열별로 만든다(Chromium 검증이 비지 않게).

### 4.2 보관 주기 읽기 — `PerformanceManager.historicalInterval`
- `PerfInterval[]`(`samplingPeriod` · `length` · `enabled`)을 `perfCounterMap()` 옆에 **vCenter 별 6시간 캐시**로 읽는다(새 호출 1종 · 열 때만 · 실패하면 VMware 기본값으로 두고 응답에 `retentionSource:'default'`).
- 창(start~end)의 **나이**로 롤업을 고른다: 끝이 지금−1일 안이면 300 · 1주 안 1800 · 1달 안 7200 · 그 밖 86400(실시간 20 은 start/end 없이 최근 1시간만). 응답 `interval` 이 실제값이고 화면은 ‘이 구간은 30분 평균(vCenter 보관 주기)’ 라고 말한다.

### 4.3 구간 이동 규칙(화면 — 순수 모듈 `vmPerfText.js`, 전송 속도의 `maxBackOf`/`windowEndOf` 와 같은 모양으로 공용화 후보)
| 보기(창) | 기본 롤업 | ◀ 이전으로 갈 수 있는 범위 | 그때의 롤업 |
|---|---|---|---|
| 실시간 1시간 | 20초 | 없음(vCenter 가 1시간만 보관) | — |
| 24시간 | 5분 | 1주(30분 평균) → 1달(2시간 평균 · 12점) | 응답 `interval` 대로 |
| 7일 | 30분 | 1달(2시간) → 1년(1일 평균 · 7점) | 〃 |
| 30일 | 2시간 | 1년(1일 평균) | 〃 |
| 1년 | 1일 | 없음 | — |
슬라이더는 놓을 때만 조회(전송 속도 v2.735.3 규칙) · 과거 구간은 자동 갱신 없음 · ‘날짜로 이동’ 은 그 포탈 날짜가 끝나는 시각을 창 끝으로.

### 4.4 CSV · 자동 갱신
- CSV 는 화면이 받은 4계열로 만든다(서버 호출 없음 · `vm_web-kr1-023_24h_2026-11-06.csv` · 결측은 빈 칸).
- 실시간만 `refreshSec`(API 값) 마다 자동 갱신 · 인증 정지/skip 이면 멈춤(지금 규칙 그대로) · 과거 구간 · 24시간 이상 보기는 **열 때 1회 + ‘지금 다시 조회’**(무거운 API 15초 폴링 금지).

## 5. 화면(IA) — 아트보드 6장

| 보드 | 파일 | 내용 |
|---|---|---|
| ⓪ | `Current.dc.html` | **지금**(v2.910 목 서버 캡처 3장) — 옛 모달 · 드로어 · 성능 모달 + 잘 안 되는 것 6가지 |
| ① | `VcTreeDrawer.dc.html` | **vCenter › 호스트 및 클러스터 트리에서 VM 클릭 → 드로어**(1440) — 가상화 서버와 **같은 컴포넌트** · ‹ › 는 트리에 보이는 VM 순서 · 행의 ‘⤢ 개체 보기’ · 호스트 클릭은 그대로 · 드로어의 ‘성능 그래프 보기’ 는 ② 로 이동 |
| ② | `Main.dc.html` | **성능 — 개체 보기 › 모니터 탭 맨 위**(1440 · 1204px 본문): 머리(기간 세그먼트 실시간 1시간 · 24시간 · 7일 · 30일 · 1년 / 롤업·점수·읽은 시각 알약 / CSV / 지금 다시 조회) · **지표 카드 4**(현재 · 평균 · 최대+시각 · 최저 · 스파크 — 누르면 차트 지표) · 차트 카드(겹쳐 보기 세그먼트 · 범례: 값 · 기간 평균 점선 · 과부하 기준 90% 점선(API 값) · 결측은 끊음 · 마우스 오버 상자) · ◀ 이전 24시간 / 슬라이더 / 다음 ▶ / 최신 / 날짜로 이동 + 창 설명 · **이 구간 요약 표**(평균 · 최대 시각 · 최저 시각 · 90% 이상 시간 · 결측) · 아래는 기존 이벤트 · 알람 · 작업 카드 그대로 |
| ③ | `Narrow.dc.html` | ② 의 400px — 카드 2×2 · 세그먼트 줄바꿈 · 차트 360 뷰박스 · 구간 줄 접힘 · 요약 표는 가로 넘김 |
| ④ | `States.dc.html` | 상태 6종 — 조회 중 · 꺼진 VM(실시간 잠금) · 인증 실패로 멈춤(409 · ‘다시 조회’ 1회) · 직접 수집 대상 아님(409 skip · 단추 없음) · 표본 없음(0 으로 그리지 않음) · 과거 구간 + 데모 데이터 배지 |
| ⑤ | `AltModal.dc.html` | **대안** — 모달을 유지하고 디자인만 교체(1180px · 같은 컴포넌트). 단점(모달 위 모달 · 주소 없음)을 보드 안에 적었다 |

### 5.1 ① 이 바꾸는 것
- `VCenterDetail.jsx` 의 `setSel({ type:'vm', item })` 세 곳(호스트 트리 2 · 폴더 트리 1)을 **`VmDrawer`** 로 — `rows` 는 지금 트리에 보이는 VM 순서(검색 · ‘Off VM 포함’ 반영 · 호스트/폴더 단위로 묶인 순서), `days` 는 `vmsD.signalCounts.snapAgeDays`(이 화면은 이미 `signals=1` 로 받는다), `onMove` 는 같은 드로어 안에서 교체.
- 드로어 푸터 · 신호 행의 ‘개체 보기 ›’ 링크는 **같은 vCenter 화면 안**이라 드로어를 닫고 해시만 바뀐다(가상화 서버보다 자연스럽다).
- host · datastore 의 `EntityDetail` 모달은 그대로(범위 밖 — 앞 시안 §6.3 과 같은 결정). `EntityDetail type='vm'` 을 쓰는 **다른 5곳**(알람 · 탐색 · Platform VM 검색 · `VmLink`(도구 다수) · 호스트 전체 페이지의 VM 열)도 같은 드로어로 바꿀 수 있다 → 질문 ①.

### 5.2 ② 가 바꾸는 것
- 성능은 **모달이 아니라 개체 보기 › 모니터 탭의 첫 섹션**(VM `#/vcenters/<vc>/vm/<id>/monitor` · 호스트 `…/host/<id>/monitor`) — 새로고침 · 공유 · 브라우저 뒤로 가기가 된다. ‘📈 성능 그래프 보기’ 7곳은 전부 그 주소로 **이동**(드로어 · 모달은 닫고). `MetricModal` 은 지운다(대안 ⑤ 를 고르면 같은 컴포넌트를 모달에 넣는다).
- 조작은 전송 속도 상세와 같은 문법: 기간은 세그먼트 하나(5개) · 지표는 카드(4개 · 눌러 고름) · 과거는 ◀ 이전/슬라이더/날짜 — `datetime-local` 두 칸은 없앤다.
- 차트는 SVG 직접 그리기(전송 속도 · Infra Observability 와 같은 방식 — recharts 번들을 개체 보기 경로에 더 싣지 않는다) · 평균선 · 과부하 기준선(API `overloadPct`) · 결측은 선을 끊음 · 마우스 오버 상자에 같은 시각의 다른 지표 값.
- 겹쳐 보기(CPU + 메모리 · 디스크 + 네트워크)는 같은 단위끼리만(% 와 KBps 를 한 축에 두지 않는다).
- 요약 수치는 `metricStats` 규약(결측 제외 · 점이 없으면 ‘—’) · 단위는 값이 있을 때만.

## 6. 컨펌 질문(기본값 — ‘기본값대로’ 면 이대로 구현)

1. **드로어 전환 범위** — 기본: vCenter 트리(호스트 및 클러스터 · VM 및 폴더)만. 대안: `EntityDetail type='vm'` 을 쓰는 다른 5곳(알람 · 탐색 · Platform VM 검색 · VmLink · 호스트 전체 페이지)도 전부 드로어로(옛 VM 모달 제거).
2. **성능 화면 자리** — 기본: ② 개체 보기 › 모니터 탭 안 + ‘성능 그래프 보기’ 7곳은 이동. 대안: ⑤ 모달 유지(디자인만 교체) · 또는 둘 다(모니터 탭 + 모달에 ‘모니터에서 열기’).
3. **이 구간 요약 표** — 기본: 포함(화면 계산 · 호출 없음). 빼면 차트 카드까지만.
4. **겹쳐 보기 세그먼트**(CPU + 메모리 · 디스크 + 네트워크) — 기본: 포함.
5. **호스트 성능도 같은 화면**(HostObject 모니터 탭 · 호스트 모달 · HostDetail 의 📈 → 이동) — 기본: 포함(같은 컴포넌트 · `entity=host`).
6. **검증 수준** — 기본: 표준(관련 테스트 + Chromium 1440/400 + 전량 verify) + **서버 엔드포인트(인증 정지 · scope 404 유지) 변이 검증 1회**(반증 에이전트는 두지 않음). ‘전체 검증’ 을 고르면 반증 1인 추가.

## 7. 구현 메모(컨펌 뒤 · Opus)

- 서버: `vcenter/soapClient.js` — `fetchEntityMetrics(vc, entityType, moref, types, interval, {start,end})`(login 1회 · `queryEntityPerfMulti` · 롤업 선택 `pickIntervalId(now, start, end, retention)`) + `historicalIntervals(vc)`(6시간 캐시 · 실패는 기본값 + `retentionSource`) · `routes/api/vmMetrics.js` — `types` 파싱(화이트리스트 4 · 중복 제거) · 응답 모양 §4.1 · 목 `synthMetric` 복수 계열.
- 웹: 새 `components/vmperf/`(`VmPerfView.jsx` 화면 · `vmPerfText.js` 순수: 창 계산 · 롤업 라벨 · 요약 통계 · CSV 행 · 상태 문구 → vitest) · `VmObject.jsx`/`HostObject.jsx` 모니터 탭 첫 섹션 · `VmDrawer.jsx` · `EntityDetail.jsx` · `HostDetail.jsx` 의 📈 단추를 링크로 · `vmSeries.jsx useDaySeries` 를 `types=cpu,mem` 1회로 · `VCenterDetail.jsx` 트리 `setSel` → `VmDrawer`(§5.1) · `VmMetrics.jsx MetricModal` 제거(⑤ 면 유지).
- 테스트: 서버 `test/vmMetricsTypes.test.js`(types 파싱 · 로그인 1회 · scope 밖 404 · 인증 정지 409 본문 그대로 · 롤업 선택 경계) · 웹 `vmPerfText.test.js`(창 범위 표 §4.3 · 결측 null 통계 · CSV) · `vcd/vcTreeDrawer.test.jsx`(트리 VM 클릭 → 드로어 · 호스트 클릭은 모달 유지) · 기존 `authStop2591` · `audit2744k` 통과.
- 문서: `docs/rules/vcenter.md` 에 ‘성능 화면 · 드로어’ 항목 · 이 README §8 에 ‘시안과 달리 한 것’.
- 릴리스: 포탈 동작이 바뀌므로 버전업 + GitHub 릴리스 게시 1회(`versions.json` latest 확인).

## 8. 구현(v2.911.0 — 2026-11-06 · 시안과 달리 한 것 · 남긴 것)

- 파일: 서버 `vcenter/soapClient.js`(`fetchEntityMetrics` · `pickPerfInterval` · `parseHistoricalIntervals` · `perfRetention` · `queryEntityPerfMulti` 에 `maxSample`) · `routes/api/vmMetrics.js`(`parseMetricTypes` · `synthMetrics` · 두 라우트의 `types=` 분기) ·
  웹 `components/vmperf/{VmPerfView.jsx,vmPerfText.js,vmPerf.css}`(새) · `components/VmMetrics.jsx`(모달 삭제 → 링크 단추 2개) · `vcd/VmObject.jsx` · `vcd/HostObject.jsx`(모니터 탭 첫 섹션) · `VCenterDetail.jsx`(트리 VM 클릭 → `VmDrawer` · `vcd/treeRows.js` 순서) ·
  `vms/vmSeries.jsx`(스파크 1회 호출) · `EntityDetail.jsx` · `HostDetail.jsx` · `VmDrawer.jsx`(단추에 vcenterId · 닫기).
- 테스트: `server/test/vmPerf2911.test.js`(가짜 vCenter 로그인 수로 '복수 지표 = 로그인 1회 · 단건 4회 = 4회' · 범위 404 · skip 409 · 순수 4) · 웹 `vmPerfText.test.js`(10) · `treeRows.test.js`(4) · `vmPerf2911.test.jsx`(소스 스윕 · 단추 렌더) · `audit2744k.test.js` 의 성능 모달 409 정지 시험을 `VmPerfView` 로 옮김.
- 시안과 달리 한 것:
  1. **기본 기간은 24시간**(옛 모달은 실시간이 기본 — 열자마자 20초 갱신 = 분당 3회 로그인). 실시간은 세그먼트로 고른다.
  2. 지표 카드에 '최저 시각' 은 넣지 않았다(요약 표에 있다 — 카드가 넓어진다).
  3. 겹쳐 보기(두 지표)에서는 기간 평균 점선을 생략했다(어느 지표의 평균인지 헷갈린다) — 한 지표일 때만.
  4. ④ 상태 '직접 수집 대상 아님' 의 **엣지 포탈 링크는 넣지 않았다**(옛 모달에도 없었고 `findRemoteServer` 안내 모양을 정하지 않았다 — 남긴 것).
  5. 드로어의 ‹ › 순서는 **트리에 보이는 순서 전체**(펼친 호스트만이 아니라 접힌 호스트의 VM 으로도 넘어간다 — 시안은 '보이는 VM 순서' 라고만 적었다).
  6. 슬라이더 범위(`maxBackOf`)는 '그 창을 아직 보관하는 가장 거친 롤업으로도 점이 6개 이상' 규칙 그대로 — 24시간 창 29칸(1달) · 7일 창 51칸 · 30일 창 11칸(기본 보관 기준 · vCenter 값을 읽으면 그 값).
  7. 롤업이 요청보다 거칠어진 구간은 차트 주석 줄과 창 설명 두 곳에서 말한다(시안은 창 설명만).
- 남긴 것(다음 후보): `EntityDetail type='vm'` 모달을 쓰는 다른 5곳(알람 · 탐색 · Platform VM 검색 · VmLink · 호스트 전체 페이지의 VM 열)은 그대로(질문 ① 기본값) · 엣지 위임 vCenter 성능의 엣지 포탈 링크 · 축소 근거 리포트(`RightsizeReport`)는 별도 모달 그대로.

### 8.1 Chromium 확인(1440 · 400 · 목 서버 v2.911 빌드 · pageerror/console error 0 · 가로 넘침 0)
- 1440: 호스트 및 클러스터(검색 결과) · VM 및 폴더 트리에서 VM 클릭 → 드로어(옛 모달 0) · ↓ 로 다음 VM(목록 1/2 → app-us-0007) · 드로어의 📈 → 해시 `…/monitor` · 드로어 닫힘 · 성능 섹션 렌더(5분 평균 · 288점) ·
  마우스 오버 상자(같은 시각 4지표) · 7일 → ◀ 이전 7일 → '과거 구간' 배지 + '이 구간은 2시간 평균(vCenter 보관 주기)' · 실시간 → 20초 · 180점 · 20초마다 갱신 · 겹쳐 보기 CPU + 메모리 · 호스트 모니터 탭 같은 섹션 · 가상화 서버 드로어의 📈 → 그 VM 의 모니터 탭.
- 찾아 고친 것: ① 모니터 탭 아래 '이벤트 · 이동'(VM) · '이벤트'(호스트) 카드가 성능 카드가 빠지며 3열 격자에 혼자 좁게 남았다 → 한 줄 전체(`gridColumn 1 / -1`).
  ② 400px 에서 차트 SVG 가 뷰박스 1360 그대로라 340px 폭에서 **높이 68px 띠 · 글자 6px** 였다 → 720 미만은 뷰박스 400(높이 약 230px) · 눈금 3개 · 긴 창은 MM-DD 만(`ticksOf short`).
- 400: 드로어는 v2.909 에서 확인한 전체 시트 그대로 · 성능 섹션은 카드 2×2 · 세그먼트 줄바꿈 · 요약 표는 가로 넘김(페이지 넘침 0).
- 남긴 것(기존 · A/B 미확인): 같은 페이지에서 해시로 **다른 vCenter 의 VM 개체**로 바로 건너뛴 직후 한 번 '이 vCenter 의 VM 목록에 이 VM 이 없습니다' 가 보였다(새 창에서 같은 주소를 열면 정상 — 옛 vCenter 의 VM 목록이 잠시 남는 경합으로 추정 · 이번 변경과 무관한 경로). 머리 줄 '← 목록' 이 400 에서 두 줄로 접히는 것도 기존.
- fullPage 캡처에서 고정 하단 상태 막대가 본문 중간에 겹쳐 보이는 것은 캡처 방식 때문(실제 뷰포트에서는 맨 아래) — 결함 아님.
