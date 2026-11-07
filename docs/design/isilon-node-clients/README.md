# 설계: 아이실론 노드 2차 — 클라이언트·프로토콜(③) · 디스크 busy·IOPS(②) · 표본 주기 분리(⑨) · 노드 클릭 → 연결 클라이언트 · 재배치 보드

작성 2026-11-07 (main v2.931.0 기준 · 브랜치 `claude/charming-lamport-rr6090`) · 상태 **구현됨 v2.935.0**(14:32 KST 요청 · 컨펌 뒤 구현 — §8 구현 기록) ·
시안 캔버스: https://claude.ai/artifact/3E5mZEubEdHdK8mJZhGmUs (아트보드 3장 — ① 노드 클릭 드로어 + 프로토콜·busy 묶음 · ② 보기 ‘클라이언트 분포’(노드 × 클라이언트 · 쏠림 · 재배치 후보) · ③ 표본 주기 분리 설정·흐름·산수·상태).
이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스(HTML 프로토타입 — 복사 대상이 아님). **IP · 이름 · 수치는 전부 가상**이다. 1차(v2.931 — `docs/design/isilon-node-load/`) 위에 얹는다.

## 1. 요구(사용자 2026-11-07 14:32 KST)

> "나머지 추천 ②③⑨도 진행해 / 그리고 특정 노드를 클릭하면 그 노드에서 연결된 클라이언트가 어떤 프로토클을 사용해서 노드를 사용하고있는지 체크해줘 /
> 노드가 많은데, 특정 노드에 치우치는 이슈가 있어서 노드에 연결된 서버를 확인해서 재배치 하려고해."

질문 답(14:34): **한 번에 모두** · 클라이언트는 **수집 주기마다 저장**(클릭 때 실시간 조회 아님) · ⑨ 는 **5분 · 모든 아이실론 기본 켬** · **시안 먼저**.

## 2. 지금 코드에서 확인한 것

| 사실 | 위치 |
|---|---|
| 클라이언트 정보는 REST 영역 수집(1시간)의 `statistics/summary/client?limit=50` 뿐 — 클러스터 전체 상위 50 · 최신본만 · 원문은 **수집 노드(엣지) DB** 에만. SSH 장비는 없음 | `storage/onefsCatalog.js:35` · `areasCollector.js` |
| 노드별 프로토콜·드라이브 통계는 어느 경로도 없음(영역 `protocol` 은 클러스터 합 3키) | `onefsCatalog.js:33` |
| 엣지 ‘지금 수집’ 은 5분 pull 큐 — 클릭 때 실시간 조회가 안 되는 이유 | `storage/collectRequests.js` |
| 수집 주기 규약: `INTERVAL_SPEC`(pollMs 1시간 · pushMs 5분 · configPullMs 5분 · areasMs 1시간) · 중앙 배포 · `startAdaptiveTimer` + 변경 리스너 | `storage/intervals.js:36~` |
| 폴러: 동시 3 · 장비 시한 180초 · `_inFlight` 소유 대조 · 인증 정지 공유 | `storage/poller.js` |
| 엣지 push: 5분 · gzip · 장비당 1 MB · 엣지당 16 MB · 노드 목록 정제 `NODE_NUM_KEYS` | `storage/push.js` · `central/edgeRecord.js:32~55` |
| 1차 저장 구조 `node_load_sample/history/daily` · API `node-load` · 화면 `storageNodeLoad/` | v2.931 |

## 3. 정직하게 밝혀야 하는 것(시안 문구에 반영)

1. **OneFS 클라이언트 통계는 ‘최근에 작업한’ 클라이언트만** 보인다(문서 지식). 마운트만 하고 쉬는 서버는 목록에 없다 → 화면은 ‘연결 없음’ 이라 말하지 않고 ‘최근 작업한 클라이언트 없음’ 이라 말한다. 재배치 판단에는 부하를 낸 클라이언트가 중요하므로 쓸모는 있다.
2. REST `summary/client · protocol · drive` 의 필드 이름(`remote_addr` · `remote_name` · `protocol` · `operation_rate` · `in/out` · `time_avg` · `busy` …)과 SSH `isi statistics client/protocol/drive --format json` 의 JSON 모양은 **실장비 미확인**. 1차와 같이 세 모양을 받고, 못 읽으면 사유 + 받은 키를 섹션 상태에 적는다.
3. 어느 노드에 붙는지는 SmartConnect 정책(라운드로빈·연결 수·처리량·CPU)과 클라이언트의 마운트 대상이 정한다. **포탈은 계산해 보여 줄 뿐 아무것도 바꾸지 않는다** — 재배치(마운트 대상 IP 변경 · SmartConnect 존/정책)는 관리자가 장비·클라이언트에서 한다. 화면이 그 사실을 말한다.
4. 5분 표본은 SSH 장비에서 5분마다 로그인이 생긴다(장비 감사 로그 증가). 장비별 토글(기본 켬)과 주기 설정으로 조절한다.
5. 이름 붙이기는 포탈 인벤토리(VM IP · 호스트 관리 IP · IP 대장)로만 — 역방향 DNS 조회는 하지 않는다(SSRF · 지연).
6. 지연(`time_avg`)의 단위(µs/ms)는 실장비에서 확인 — 그 전까지 장비가 보고한 값에 단위 표지를 붙여 그대로 보인다.

## 4. 데이터 · 서버

### 4.1 경량 폴러 `storage/nodeLoadPoller.js`(⑨)
- `INTERVAL_SPEC` 에 `nodeLoadMs`(기본 5분 · 하한 1분 · 상한 60분) — 중앙 배포·엣지 pull·변경 리스너 그대로. 장비 필드 `nodeLoad.enabled`(아이실론 기본 true · 일괄 변경 키에도).
- 켜진 아이실론만 · 동시 3 · 장비당 시한 60초 · 재진입 가드 · **같은 장비가 수집 주기 중이면 이번 표본은 건너뛴다**(`_inFlight` 공유 — 세션 두 개 금지) · 인증 정지(`authGuard`) 공유 · 자동 재시도 없음.
- REST: ① `statistics/current?devid=all&key=…`(1차 키 + `node.disk.busy.avg` · `node.disk.xfers.{in,out}.rate.sum` · 프로토콜 ops/지연 키) ② `summary/client?limit=<노드 수 × N>` ③ `summary/protocol` ④ `summary/drive`. SSH: 세션 1 · 명령 4(`isi statistics system|client|protocol|drive --nodes all --format json`) · 예산 60초 · 순서 system → client → protocol → drive(예산이 모자라면 뒤부터 잃는다).
- 표본 모양 `{ ts, nodes:[{ id, in, out, din, dout, cpu, ops, latency, busy, iops, proto:{nfs:{ops,lat}, smb:…}, clients:[{ ip, name?, proto, ops, in, out, lat }] }] }` — 노드 64 · 클라이언트 노드당 상위 N(기본 10, 설정) · 모든 수는 `numOrNull`.
- 수집 주기(1시간) 스냅샷 적재는 그대로(1차) — 5분 표본이 꺼진 장비는 그것만 남는다.

### 4.2 엣지 → 중앙
- 엣지는 미전송 표본을 **고리 3개**(15분)로 스냅샷 `extra.nodeLoadSamples` 에 싣는다(push 5분과 어긋나도 표본을 잃지 않게). 중앙 정제: 아는 필드만 · 노드 64 · 클라이언트 N · 문자열 수치는 수로 · (장비, ts) 중복 무시 · 크기 상한은 기존 장비당 1 MB. 산수: 표본 1개 ≈ 58 KB(64노드) · 고리 3개 ≈ 170 KB · gzip.
- `NODE_NUM_KEYS` 에 `busyPct` · `iops` · `opsPs` · `latencyMs` 추가(1시간 스냅샷의 노드 목록용).

### 4.3 저장(`storage-history.db`)
- 1차 표 3개에 열 추가(`ops` · `latency` · `busy` · `iops` + 일 롤업 sum·n·max) · **시간 요약 `node_load_hourly`(새)** — 원시 7일 · 시간 90일 · 일 5년(원시 기본 30일 → 7일: 5분이면 12배라).
- 새 표 `node_client_sample`(장비·ts·노드·클라이언트·프로토콜·ops·in·out·lat — 원시 2일) · `node_client_hourly`(장비·노드·클라이언트·프로토콜·시간 — 30일) · `node_client_daily`(1년) · `node_proto_hourly/daily`(노드 × 프로토콜). 적재는 표본 1개 = 트랜잭션 1개. prune 은 기존 틱에 합류(ts·day 인덱스 · 청크).
- 행 수 산수(8노드): 클라이언트 원시 23,040행/일 · 시간 요약 ≤ 1,920/일 · 64노드면 8배. 보존 3칸은 ⚙ 저장 기간에 새 칸.

### 4.4 API(장비 호출 0 · 폴링 없음)
- `node-load`(1차)에 묶음 `disk`(busy % · IOPS 추가) · `proto`(전체 ops/s · NFS · SMB · S3 · HDFS · 평균 지연) · 표본 종류(5분/1시간)와 마지막 표본 시각.
- `GET /tools/storage/devices/:id/node-clients?node=4&range=24h|7d[&end]` → 노드 요약(ops · In/Out · CPU · busy · 프로토콜 구성) · 클라이언트 상위(이름은 중앙 인벤토리로 붙임) · 클라이언트마다 7일 노드 비중과 ‘고정’ 판정(기준 설정값 · 기본 90%) · 표본 수·결측 · 마지막 표본.
- `GET /tools/storage/devices/:id/client-dist?range=7d&proto=all` → 클라이언트 × 노드 비중 행렬(상위 M 클라이언트) · 노드 ops 합·평균 대비(쏠림 기준 설정값 · 기본 1.5배) · 재배치 후보(탐욕: 쏠린 노드의 고정 클라이언트를 ops 큰 순으로 가장 한가한 노드에 — 평균 아래로 내려가면 멈춤 · ‘지금 값 기준 산수’ 표지) · CSV.
- 게이트는 1차와 같다(toolsPerm + fullScopeOnly · 데모 계정은 데모 장비만).

## 5. 화면(아트보드)

- **① 노드 클릭 드로어**(장비 상세 모달 안 오른쪽 패널 · 400px 에서는 아래로): 머리(노드·IP·시리얼 · 표본 수) · 타일 3(ops · In/Out+CPU+busy · 클라이언트 수/고정 수) · 프로토콜 구성 얇은 분할 막대 · 클라이언트 표(STable — IP · 이름(출처) · 프로토콜 · ops/s · In·Out · 지연 · 이 노드 비중(7일) · 고정/분산 표지) · 재배치 참고 한 단락 · 정직 문장. 노드 이름(히트맵·순위·소형 다중 머리)을 누르면 열린다.
- **묶음 2개 추가**: 디스크에 busy % · IOPS, 새 묶음 프로토콜(전체 ops/s · NFS · SMB · S3 · 평균 지연). 노드 × 프로토콜 표(ops·지연·busy·IOPS·구성 막대 — 평균의 배수 넘으면 노란 글자, 배수는 설정값).
- **② 보기 ‘클라이언트 분포’**: 클라이언트 × 노드 행렬(단일 색조 · 칸 = 7일 ops 비중 % · 행 = 상위 M) · 노드 쏠림 막대(평균 대비 ×) · 재배치 후보 표(지금 → 제안 · 옮기는 ops · 뒤 값) · ‘포탈은 바꾸지 않는다’ · CSV.
- **③ 설정·흐름**: 수집 주기 새 칸 · 장비 토글 · 저장 기간 칸 · 흐름 6단계 · 부담/행 수/push 산수 · 상태 6종(클라이언트 없음 · SSH JSON 미확인 · 이름 못 찾음 · 표본 늦음 · 수집 꺼짐 · 구버전 엣지).
- 색·규약은 1차 그대로(단일 색조 램프 · 2계열색 · 범례 · 표 보기 쌍둥이 · 이중 축 없음).

## 6. 컨펌 때 정해 주실 것(기본값 제안)

| # | 질문 | 기본값 |
|---|---|---|
| 1 | 노드당 클라이언트 상위 N | 10 |
| 2 | 클라이언트·프로토콜 보존(원시 · 시간 · 일) | 2일 · 30일 · 1년 |
| 3 | 노드 원시 보존(5분 표본) | 7일(기존 30일 저장값은 유지) |
| 4 | ‘고정 클라이언트’ 기준 | 7일 ops 의 90% 이상이 한 노드 |
| 5 | 쏠림 기준 | 노드 ops 합이 평균의 1.5배 이상 |
| 6 | 디스크 busy 표시 | 노드 평균 %(드라이브 최대는 툴팁) |
| 7 | 검증 수준 | 표준(+ 엣지 수신 계약 변경분은 변이 확인) |

## 7. 구현 계획(컨펌 뒤 — 규칙상 Opus · 예상 구현 150분 + 검증 40분)

| 단계 | 파일 |
|---|---|
| 수집 | `storage/collectors/isilonNodeLoad.js`(키·명령 4·파서 3 — 순수) · `isilon.js`·`isilonSsh.js`(1시간 경로에 busy·IOPS·ops 키) · `types.js` · `edgeRecord.NODE_NUM_KEYS` |
| 폴러 | `storage/nodeLoadPoller.js`(새) · `intervals.js nodeLoadMs` · `registry.js nodeLoad.enabled` · 일괄 변경 키 · `index.js` 기동 |
| 엣지 | `push.js`(표본 고리) · `central/storageEdge.js`(정제·적재) · `edgeRecord.js`(화이트리스트) |
| DB | `storage/nodeLoad.js`(규칙) · `db.js`(표·열·시간 요약·조회·prune) · `growthSettings.js`(칸 3) · `mock/demo/storage.js`(클라이언트 합성·백필) |
| API | `routes/api/storageMon.js`(node-load 확장 · node-clients · client-dist · CSV) · 이름 붙이기 `storage/clientNames.js`(인벤토리 조회 순수) |
| 웹 | `storageNodeLoad/`(묶음 2 · 드로어 `NodeClientsDrawer.jsx` · 보기 `ClientDistView.jsx` · 문구 모듈 + vitest) · 설정 폼(주기 칸 · 장비 토글 · 저장 기간 칸) |
| 테스트·문서 | `server/test/storageNodeClients29xx.test.js` · `docs/rules/storage.md` · release-notes · 이 README 상태 |

## 8. 구현 기록(2026-11-07 — 상태 **구현됨 v2.935.0**)

컨펌 "이대로 구현(§6 기본값)" 뒤 구현. ⚠ 규칙(설계 = Fable · 구현 = Opus)과 달리 **구현도 Fable 로 진행했다**(사용자가 `/model` 을 바꾸지 않았고 작업 흐름을 끊지 않기 위해 — vm-perf 때와 같은 선례. 보고에 밝힌다).

- 시안과 달라진 것(정직 기록):
  · 엣지 → 중앙 표본은 스냅샷 `extra` 가 아니라 **push 본문 최상위 `nodeLoadSamples`** 로 보낸다 — `extra` 에 싣으면 중앙 정제 화이트리스트와 `central-agent-storage.json` 보관분까지 표본이 섞여 커진다. 소유권 필터는 장비 목록과 같은 함수로 따로 건다.
  · 드로어는 장비 상세 모달 위의 모달이 아니라 **노드 부하 구역 안에 펼치는 구획**이다(모달 겹침 회피). 열리는 곳은 히트맵 노드 이름 · 노드 순위 · 분포 막대(노드 표 ID 열은 아니다 — 남긴 것).
  · 수집 주기 폴러는 표본이 진행 중이면 **끝날 때까지 기다린다**(≤60초) — 시안은 '표본이 수집 중이면 건너뜀' 만 적었는데, 반대 경우(표본 때문에 1시간 수집이 한 주기 빠짐)가 더 나빠 추가했다.
  · 비교 구간(지난주)이 노드 원시 보존(7일) 경계에 걸려 비던 것은 **원시 보존 밖 창을 시간 요약 1시간 칸으로** 내려 해결했다(원시 폴백 아님).
  · 일괄 변경·CSV 의 `nodeLoadEnabled` 칸은 넣지 않았다(장비 편집 폼만) — 남긴 것.
  · 묶음 버튼은 표본 폴러가 켜진 장비면 디스크(busy·IOPS)·프로토콜을 **응답 `sample.sampleEnabled`** 로 연다(1시간 스냅샷에는 그 키가 없다).
- 실장비 미확인 항목(첫 수집 뒤 `probe` 를 보고 보정할 것): REST `summary/{client,protocol,drive}` 경로·필드 · `isi statistics client/protocol/drive --format json` 행 모양 · 행의 node 가 lnn 인지 devid 인지(lnn 으로 본다) · 지연 단위(µs→ms 가정) · `isi statistics system` 의 Net In/Out 단위(B/s 가정 ×8).
- 파일: `storage/nodeLoadPoller.js`(새) · `storage/clientNames.js`(새) · `collectors/isilonNodeLoad.js`(파서·REST 표본 노드·system net 옵션) · `nodeLoad.js`(정제·행렬·쏠림·후보) · `db.js`(표 6개·열 4·시간 요약·조회) · `intervals.js nodeLoadMs` · `poller.js runSampleExclusive` · `push.js` · `central/storageEdge.js` · `routes/central.js` · `routes/api/storageMon.js`(라우트 3) · `growthSettings.js`(칸 4) · `mock/demo/storage.js` · `edgelog/spec.js` · `health/services.js` · `index.js` · 웹 `storageNodeLoad/{NodeClientsDrawer,ClientDistView}.jsx` · `NodeLoadPanel.jsx` · `nodeLoadText.js`(+vitest) · `StorageMonTool.jsx`(토글).
- 회귀: `server/test/storageNodeClients2935.test.js`(①~⑧) · `storageNodeLoad2926.test.js`(보존 기본 7일 · 디스크 묶음 4지표 갱신) · 규칙 `docs/rules/storage.md` 36항.
