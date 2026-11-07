# 설계: 아이실론 노드별 부하(네트워크 In / Out · 디스크 쓰기 / 읽기) — 저장 + 추이 차트 + 이전 구간 보기

작성 2026-11-07 (main v2.914.0 기준 · 브랜치 `claude/charming-lamport-rr6090`) · 상태 **구현됨 v2.927.0**(코드·테스트 표지는 v2.926 — 준비 중 main 이 2.926.0 을 먼저 써서 번호만 올림 · 07:42 KST 요청 · 08:21 ‘기간별·시간별 이전 기록’ 추가 · 08:27 ‘Disk io 추가’ · 11:37 성능 추천 ①CPU ④잡 엔진 ⑤지난주 비교 ‘추천대로 진행’ — 구현 기록 §8) ·
시안 캔버스: https://claude.ai/artifact/4Uktx1J1iDEEpojgWVz1fj (아트보드 6장 — ⓪ 지금 · ① 시안 1440 · ② 보기 전환(소형 다중 · 겹쳐 보기) · ③ 400px · ④ 상태 6종 · ⑤ 데이터 흐름 · 저장 구조).
이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스(HTML 프로토타입 — 복사 대상이 아님). **장비 · 노드 · IP · 시리얼 · 수치는 전부 가상**(데모 `PS-FRA-01` 모양)이다.
색 · 글자는 `web/src/styles.css` `:root` 토큰과 기존 `CapacityTrend`(v2.318)가 쓰는 계열색(`#3987e5` · `#d95926`) 그대로다(새 hex 는 히트맵 단일 색조 램프 5단계뿐 — §5.3).
규칙(2026-11-03 ‘기억해’): 설계는 Fable + Claude Design 시안 → **컨펌 뒤** Opus 구현. §2 는 이 세션(Fable)이 코드로 확인한 사실이다.

## 1. 요구(사용자 2026-11-07 07:42 KST)

> "아이실론에서 이미 수집하는 정보에서 노드별 io network 부하를 저장하고 차트로 그려서 볼 수 있게 해줘 클로드 코드로 시안 보여줘"

읽기: **새 장비 호출 없이**(이미 수집하는 정보에서) 노드별 부하를 **시계열로 저장**하고 **차트**로 본다. ‘io network 부하’ 는 지금 노드별로 받는 값이 네트워크 In/Out 뿐이라(§2) 먼저 **네트워크 In/Out 처리량**으로 읽었다.

추가 요청 2건(같은 날, 시안 v1 을 본 뒤):
> 08:21 "기간별 시간별로 이전 기록 보는 기능 추가" → §5.1-②b ‘이전 구간 이동’ 행(◀ 이전 · 슬라이더 · 다음 ▶ · 최신 · 날짜·시각으로 이동) + 긴 보기에서 열을 눌러 그 날 24시간(시간별)로 · API `end`.
> 08:27 "Disk io 추가" → 디스크 쓰기/읽기를 **수집 키를 늘려** 받는다(§4.6 — REST 같은 호출에 키 추가, SSH 명령 1개). 키 이름·방향은 실장비 미확인이라 첫 수집 뒤 보정한다.

## 2. 지금 코드에서 확인한 것(설계의 근거 — 2026-11-07 07:42~07:48 KST)

| 사실 | 위치 |
|---|---|
| 노드별로 **지금 받는 값**: `id`(lnn) · `ip` · `health` · `inBps` · `outBps`(+ SSH 는 `ext` · `totalBps` · `l3Bytes`, 시리얼) · HDD/SSD 풀. 스냅샷 계약 `nodes.list` ≤ 64 | `server/src/storage/types.js:30~40` |
| SSH 경로: `isi status` 노드 표의 Throughput(bps) In · Out · Total 열을 `parseBps` 로 읽는다(10진 k/M/G) | `storage/collectors/isilonSsh.js:159~181` (`parseIsiStatus`) · `:306` (`normalizeIsiStatus`) |
| REST 경로: `statistics/current?devid=all&key=node.net.ext.bytes.in.rate&key=…out.rate` → **B/s 를 ×8 해 bps**(v2.599). 값 null 은 키를 넣지 않는다(0 거짓 방지) | `storage/collectors/isilon.js:132~142` · `:265` |
| 노드별 **디스크 I/O 는 어느 경로도 받지 않는다**. 영역 수집(`performance`)은 `cluster.disk.busy.avg` 등 **클러스터** 키뿐 | `storage/onefsCatalog.js:38` · `isilon.js:265` 키 목록 |
| 저장: 최신 스냅샷만 `storage-latest.json`(장비 → 스냅샷 1개). **노드별 값의 시계열은 없다** | `storage/store.js` 머리말 ‘시계열은 후속 — v1 은 최신값만’ |
| 있는 시계열은 용량뿐: `capacity_history`(원시 · 폴링마다 1점 · 기본 90일) + `capacity_daily`(일 롤업 · 5년) · ts 인덱스 · 청크 prune · 버킷 평균(`selCapBucket`) | `storage/db.js:107~124` · `:166~179` · `:345~360` |
| 적재 지점 2곳: 중앙 직접 수집 `poller.js:135 saveCapacityPoint(snap)` · 엣지 push 수신 `central/storageEdge.js:263`(같은 `collectedAt` 재push 는 `_lastRec` 로 중복 제거) | 그 줄들 |
| 엣지가 올린 노드 목록은 중앙이 **아는 필드만** 받는다 — `NODE_NUM_KEYS = ['inBps','outBps','totalBps','l3Bytes']` · 64개 | `central/edgeRecord.js:52~55` · `sanitizeNodeList` |
| 수집 주기 기본 **1시간**(설정 — `pollMs` def 60분 · 하한 60초 · 중앙 배포값 우선) | `storage/intervals.js:36~41` |
| 추이 API 선례: `GET /tools/storage/devices/:id/history?range=12h|24h|7d|30d|90d|400d`(`toolsPerm` + `fullScopeOnly` · 24h 이하 원시 · 7d+ 버킷) | `routes/api/storageMon.js:573~592` |
| 화면 선례: 장비 상세 모달의 `CapacityTrend`(기간 버튼 · recharts LineChart · `isEdge` 안내) · 노드 표(`ncol.io` 가 있을 때만 In/Out 열) | `web/src/views/tools/StorageMonTool.jsx:1170` · `:1180~1216` · `:1811~1873` |
| 화면 판정 모듈: `storageNodeText.nodeRows`(`numOrNull` — null 을 0 으로 바꾸지 않는다) · `bpsText` | `web/src/views/tools/storageNodeText.js:55~130` |
| 데모: `demoStorageSnapshot` 이 노드별 `inBps/outBps` 를 **시간 단위 결정적 지터**로 만든다 · `backfillStorage` 가 용량 점을 400일/7일 백필 | `server/src/mock/demo/storage.js:183~184` · `:353~366` |
| 규칙: ‘못 읽은 값은 0 이 아니다’ · 부분 합은 추이에 적재하지 않는다 · SQLite 대량 쓰기는 트랜잭션 · prune 스로틀 + ts 인덱스 + 청크 · 원본 폴백 금지 · 주기·상한 숫자를 화면에 박지 않는다 | 루트 `CLAUDE.md` · `docs/rules/perf-db.md` |

## 3. 정직하게 밝혀야 하는 것(시안 문구에 반영)

1. **표본은 수집 주기마다 1회 읽은 순간값이다**(`isi status` 의 처리량 열 · REST `*.rate`). 기본 1시간이면 하루 24점 — 주기 사이의 부하는 모른다(평균이 아니다). `isi status` 처리량의 평균 창(몇 초 평균인지)은 OneFS 문서로 확인하지 못했다 — 화면은 ‘순간값’ 이라고만 말한다.
2. **디스크 I/O 는 지금 수집하지 않는다 → 이번에 키를 늘려 받는다(§4.6).** REST 는 같은 호출에 키 2개(왕복 0), SSH 는 세션 안 명령 1개. OneFS 키 이름(`node.disk.bytes.{in,out}.rate.sum`) · **In = 쓰기 / Out = 읽기라는 방향** · `isi statistics system --format json` 의 필드 이름은 전부 **실장비 미확인**(수집기 머리말과 같은 수준의 문서 지식). 장비가 키를 주지 않으면 디스크 버튼·열을 그리지 않고 노드 수집 상태에 받은 키를 적는다(④-⑥). 방향 표기(쓰기/읽기)는 첫 실장비 수집 뒤 확정한다.
3. 노드 목록 상한 64 밖 노드는 이력이 없다(66노드 클러스터 실재 — v2.615). 화면이 밝힌다(④-⑤).
4. 이력 키는 `node id(lnn)` 다. 노드를 교체해 같은 lnn 이 들어오면 추이가 이어진다 — 시리얼로 끊지 않는다(§6 질문).
5. Unity·PowerStore·VPLEX 수집기는 노드 `inBps/outBps` 를 null 로 보낸다 → 이 화면은 **값이 있는 장비(Isilon)에만** 나타난다. 저장 계층은 타입을 가리지 않는다(값이 있으면 적재).
6. 엣지 위임 장비의 중앙 이력은 **이 기능이 들어간 뒤 push 받은 분부터**다. 엣지의 옛 값을 소급해 올리지 않는다.
7. 시안의 모든 수치는 가상이다. Chromium 캡처는 없다(설계 단계 — 구현 뒤 1440/400 으로 본다).

## 4. 데이터 · 서버 — 새 장비 호출은 없다

### 4.1 적재 `storage/db.js saveNodeLoadPoint(snap)`
- 조건: `snap.ok` 이고 `sections.nodes === 'ok'` 이고 `nodes.list` 가 배열. 아닌 스냅샷은 사유와 함께 `saved:false`(조용히 버리지 않는다 — `saveCapacityPoint` 와 같은 모양).
- 노드마다 원시 1행 — `inBps` · `outBps`(bps) · `diskInBytesPs` · `diskOutBytesPs`(B/s — 이름에 단위를 싣는다. v2.599 의 ×8 사고처럼 같은 이름에 다른 단위를 섞지 않는다)는 `numOrNull`; **넷 다 null 이면 행을 만들지 않는다**(정보가 없다). 일부만 null 이면 그 칸만 NULL.
- **스냅샷 1개 = 트랜잭션 1개**(최대 64행 + 일 롤업 upsert — 무트랜잭션 6천 행 사고 규칙).
- 중복: `(device_id, node_id, ts)` 같은 행은 건너뛴다(`hasCap` 과 같은 규칙 · 엣지 재push 는 상위 `_lastRec` 가 먼저 거른다).
- 호출 지점 2곳 — `poller.js:135` 옆과 `storageEdge.js:263` 옆. 던지지 않는다(DB 비활성이면 수집·보관·로그는 계속).
- **부분 합 금지**: 클러스터 합계는 적재하지 않고 읽을 때 만든다(§4.3) — 어느 노드든 null 이면 그 주기 합계는 null.

### 4.2 표 2개(`storage-history.db`, 기존 파일 · `CREATE TABLE IF NOT EXISTS` 추가)
```
node_load_history (device_id TEXT, node_id INTEGER, ts INTEGER,
                   in_bps REAL NULL, out_bps REAL NULL, disk_in_bytes_ps REAL NULL, disk_out_bytes_ps REAL NULL)
  INDEX idx_nlh_ts (ts) · INDEX idx_nlh_dev_ts (device_id, ts)          -- prune 용 ts 단독 + 조회용
node_load_daily   (device_id TEXT, node_id INTEGER, day INTEGER, samples INTEGER,
                   in_sum, in_max, in_n, out_sum, out_max, out_n, din_sum, din_max, din_n, dout_sum, dout_max, dout_n,
                   PRIMARY KEY (device_id, node_id, day))                -- 계열마다 avg = sum / n (n 은 읽은 표본만)
```
- 일 경계는 `util/dayKey.js`(KST 오프셋) — `capacity_daily` 와 같다. upsert 는 `ON CONFLICT DO UPDATE SET in_sum = in_sum + ?, in_n = in_n + ?, in_max = max(in_max, ?) …`(스칼라 `max()` — 집계 2개 한 문장 금지 규칙과 무관).
- 보존: 원시 **기본 30일**(설정 › 수집 › 스토리지 보존 기간 옆에 ‘노드 부하 원시 보존’ 한 칸 · 1~400일) · 일 롤업은 용량과 같은 5년. prune 은 기존 `maybePrune` 틱에 합류(ts 인덱스 · `chunkedDelete` · 기동 첫 틱 금지).
- 규모 산수(클러스터 1개 · 1시간 주기): 8 노드 192행/일 · 64 노드 1,536행/일 → 원시 30일 5.8천~4.6만 행 · 일 롤업 8~64행/일(5년 1.5만~12만 행). 폴링을 5분으로 줄이면 ×12 — 그래서 원시 보존 기본을 용량(90일)보다 짧게 둔다.
- 장비 삭제(`delCapDev`) 때 두 표도 지운다. `resetCapacityHistory` 는 건드리지 않는다(용량 기준 변경과 무관).

### 4.3 API `GET /tools/storage/devices/:id/node-load?range=24h|7d|30d|90d[&end=<ms>][&nodes=1,2]`
- 게이트 `toolsPerm` + `fullScopeOnly`(용량 추이와 같다) · 데모 계정은 mock- 장비만(기존 `demoMask` 규칙 그대로).
- `end`(창 끝 시각, ms) 가 있으면 **그 시각에서 끝나는 같은 길이의 창**을 돌려준다(이전 구간 보기 — 08:21 요청). 없으면 지금 끝. `end` 가 미래면 지금으로 자르고 `clamped`. 응답은 `start`·`end`·`past`(end 가 지금보다 한 칸 이상 앞) 를 싣고, 화면은 `past` 면 자동 갱신하지 않는다(전송 속도 v2.735.3 규칙).
- 응답 `{ db, range, spanMs, bucketMs, start, end, past, sampleMs(= 현재 수집 주기 — 화면이 ‘주기 N’ 을 여기서 읽는다), offsetMin, oldest:{ sampleTs, day }, retention:{ rawDays, dailyDays }, basis:{ net:'isi status'|'REST node.net.ext.bytes.*.rate', disk:'isi statistics system'|'REST node.disk.bytes.*.rate.sum'|null, kind:'instant' }, nodeLimit:64, nodes:[{ id, ip?, points:[{ ts, in, out, din, dout }] }], cluster:[{ ts, in, out, din, dout, nodes }], thinned, truncated }`.
  · 24h: 원시 그대로 · 7d: 버킷 평균(`selCapBucket` 패턴 · CAST) · 30d/90d: **일 롤업**(avg + max) — 원시 폴백 없음(`historyRollup` 규약).
  · `oldest`·`retention` 으로 화면이 슬라이더 범위(몇 칸까지 과거로 갈 수 있나)를 계산한다 — 24h·7d 는 원시 표의 가장 오래된 표본, 30d·90d 는 일 롤업의 가장 오래된 날(전송 속도 `maxBackOf`·`historyOldestOf` 와 같은 규칙 — **그 순수 함수를 그대로 쓴다**, 사본 금지).
  · `cluster[]` 는 서버가 만든다(노드 하나라도 null 인 주기는 그 계열 `null` + `nodes:<읽은 수>`). 일 롤업 구간의 합계는 **노드 avg 의 합**이고 `kind:'daily-avg'` 로 밝힌다.
  · 디스크 계열은 값이 있는 장비에서만 `basis.disk` 가 채워지고, 없으면 `din/dout` 은 모두 null + `basis.disk:null`(화면이 디스크 버튼·열을 숨기는 근거).
  · 점이 5,000 을 넘으면 고르게 솎고 `thinned:true`(isidu v2.769 규칙).
- 하나의 요청으로 노드 전부를 돌려준다 — 노드마다 부르지 않는다(상세 모달 열 때 1회 + 기간·창을 바꿀 때 1회 · 최신 창만 수집 주기에 맞춰 갱신).

### 4.4 엣지 — 화이트리스트 2개만
노드 목록의 `inBps/outBps` 는 이미 export · 중앙 정제(`NODE_NUM_KEYS`)에 있다. 디스크 2필드(`diskInBytesPs` · `diskOutBytesPs`)를 **엣지 export 와 중앙 `NODE_NUM_KEYS` 에 같이** 넣는다(규칙 ‘새 엣지 export 필드는 중앙 정제 화이트리스트에도’). 구버전 엣지는 그 필드가 없어 디스크 계열이 null 로 남는다(화면이 ‘없음’ 으로 보이고 0 이 아니다). 엣지 포탈도 같은 `saveNodeLoadPoint` 를 로컬 DB 에 적재하므로 엣지 화면에서도 같은 구역이 뜬다.

### 4.5 데모(mock)
`backfillStorage` 가 용량 점을 백필하는 루프에서 `saveNodeLoadPoint(demoStorageSnapshot(d, t, now))` 도 부른다(7일 시간별 — 시간 단위 지터가 이미 있어 모양이 난다). `ps-fra-01`(8노드 · REST) 의 노드 7 은 몇 주기 null 로 둬 결측 표시를 Chromium 으로 볼 수 있게 한다. MOCK 배지는 그대로.

### 4.6 디스크 I/O 수집(08:27 사용자 추가 — 포함)
- REST(`isilon.js collect`): 같은 `statistics/current?devid=all` 호출의 `key=` 목록에 `node.disk.bytes.in.rate.sum` · `node.disk.bytes.out.rate.sum`(노드의 전 드라이브 합, B/s — 문서 지식, 실장비 미확인) 를 더한다. **왕복 0.** `normalizeIsilon` 이 `diskInBytesPs` · `diskOutBytesPs` 로 싣는다(B/s 그대로 — 네트워크처럼 ×8 하지 않는다. 화면이 MB/s 로 그린다). 키가 응답에 없으면 필드를 만들지 않고 `sections.nodeStats` 에 ‘디스크 키 없음(받은 키 …)’ 를 적는다(용량의 `ifs.bytes.total 없음` 문구와 같은 모양).
- SSH(`isilonSsh.js collectViaSsh`): 세션 안에 `isi statistics system --nodes all --format json` 1개를 더한다(best-effort · 20초 · 실패해도 `isi status` 값은 유지 — `ISI_STATS_CMD` 와 같은 취급). 노드별 `DiskIn` · `DiskOut`(B/s) 를 lnn 으로 조인한다. 파서는 순수 함수(`parseIsiSystemStats`)로 두고 ①행 객체 배열 ② `{stats:[…]}` ③ 그 밖은 못 읽음 — 세 모양을 받는다(`parseIsiStatsBytes` 와 같은 방어). 필드 이름(`disk_in`/`DiskIn`…)은 **실장비 미확인**이라 대소문자·밑줄을 모두 받는다.
- 방향 표기: OneFS 는 디스크도 `in`/`out` 으로 부른다. 화면은 ‘쓰기(In)’ · ‘읽기(Out)’ 로 쓰되 **첫 실장비 수집에서 방향을 확인한 뒤 확정**한다(틀리면 문구만 바꾸면 되게 값 이름은 `diskIn*`/`diskOut*` 로 둔다).
- 화면: `basis.disk` 가 있을 때만 ‘디스크’ 세그먼트와 표 열 2개가 생긴다 — 없는 열을 ‘—’ 로 늘어놓지 않는다(④-⑥). 네트워크(bps)와 디스크(B/s)는 **같은 차트에 겹치지 않는다**(단위가 다르다 — 이중 축 금지). 세그먼트 묶음으로 바꿔 본다.

## 5. 화면(아트보드) — 장비 상세 모달의 ‘노드’ 절에 새 구역 하나

### 5.1 ① 1440 — 구역 구성(위 → 아래)
1. 머리: ‘노드 부하 추이 — 네트워크 In / Out’ + 출처 pill(REST 키 또는 ‘isi status’ 처리량 열 — `basis.source`) + 표본 pill(‘수집 주기마다 1회 · 순간값(주기 N — 설정값)’ — `sampleMs`) + ‘표로 보기’ 링크.
2. 조작 한 줄(차트 위, 카드 밖 — 한 줄이 아래 전부를 지배): 기간 [24시간 | 7일 | 30일 | 90일] · 네트워크 [In | Out | In + Out] · 디스크 [쓰기(In) | 읽기(Out) | 합계] · 보기 [히트맵 | 소형 다중 | 겹쳐 보기]. 오른쪽에 ‘칸 = 수집 주기 1회(순간값) / 4시간 평균 / 하루 평균’ 한 줄. 네트워크·디스크 두 묶음 중 하나만 켜진다(단위가 달라 한 차트에 겹치지 않는다).
2b. **이전 구간 이동 행**(08:21 요청 — 전송 속도 v2.735.3·v2.902 의 `WindowScroll` 과 같은 틀): `◀ 이전 N` · 슬라이더(오른쪽 끝 = 최근, 놓을 때 조회) · `다음 N ▶` · `최신`(최근 창이면 강조) · ‘날짜·시각으로 이동’(`datetime-local`, 시간 단위 — 고른 시각을 창 끝으로) · 아래 한 줄 ‘3칸 전 (24시간 단위) · 11.04 07:00 ~ 11.05 07:00 · 과거 구간은 자동 갱신하지 않습니다 · 갈 수 있는 범위 30칸 = 원시 표 보존 30일(설정값)’. 슬라이더 범위는 응답의 `oldest`·`retention` 으로 계산(24h·7d → 원시 보존, 30d·90d → 일 롤업 5년). 기간을 바꾸면 최근 창으로 돌아온다. 창 계산은 `xferSpeedText` 의 순수 함수(`maxBackOf` · `historyOldestOf` · `windowEndOf` · `jumpToDate` · `windowLabel` · `windowRangeText`)를 그대로 쓴다 — 세 번째 사용처이므로 구현 때 공용 모듈로 옮길지 확인(vm-perf README 가 같은 메모).
2c. **시간별 드릴다운**: 7일·30일·90일 보기에서 히트맵 열(시각)이나 합계 차트의 점을 누르면 **그 날의 24시간 보기**로 들어간다(창 끝 = 그 날 끝). 24시간 보기에서는 툴팁만.
3. 타일 4: 클러스터 합계(창 끝 표본 — 최근 창이면 ‘마지막 표본’) · 가장 바쁜 노드(기간 평균 · 노드 평균의 N배) · 가장 한가한 노드(최대와 N배 차이) · 표본 수 + ‘읽지 못한 노드값 N개 — 0 으로 채우지 않음’. 단위는 켜진 묶음을 따른다(Gbps / MB·GB/s).
4. **노드 × 시간 히트맵**(기본 보기 — 노드가 24·64대여도 색을 늘리지 않는 형태): 행 = 노드(ID + IP), 열 = 표본(24h 는 24칸), 칸 색 = 그 방향 값의 5단계 단일 색조, 빗금 = 값 없음. 칸 hover 툴팁(노드 · 시각 · In · Out). 오른쪽 **노드 순위**(기간 평균 · 가로 막대 한 색 · 값은 글자색).
5. **클러스터 합계 추이**(In · Out 선 2개 · 범례 + 오른쪽 끝 이름표 · 세로 십자선 툴팁에 두 계열) — 한 노드라도 못 읽은 주기는 합계를 비운다(선이 끊긴다) + 그 사실을 아래 한 줄로.
6. 노드 표 = 기존 표 + **디스크 쓰기/읽기(MB/s) 열 2개**(값이 있을 때만) + **‘추이’ 열**(켜진 묶음의 두 계열 스파크, 같은 응답으로 그린다 — 추가 호출 0) + **선택 체크**(≤ 4 → 겹쳐 보기). 기존 열 순서·단위는 그대로.
7. 읽는 법 한 단락(순간값 · 네트워크 bps(REST ×8) · 디스크 B/s · 디스크 키·방향 실장비 미확인 · 엣지 시작 시점).

### 5.2 ② 보기 전환 · ③ 400px · ④ 상태 · ⑤ 흐름
- **소형 다중**: 노드마다 작은 차트(In · Out) · **Y 축 공통** · 범례 한 번 · 결측 노드는 선이 끊기고 한 줄 안내. 노드 수가 많아도 색이 늘지 않는다.
- **겹쳐 보기**: 체크한 노드 ≤ 4 · 한 방향만 · 색은 **노드 번호 순으로 고정**(선택을 바꿔도 남은 노드 색 유지) · 끝 이름표 + 범례. 5개 이상 체크하면 소형 다중으로.
- **400px**: 조작 세그먼트가 줄바꿈 · 타일 1~2열 · 히트맵은 상자 안 가로 스크롤(`min-width 640`) · 순위 막대 전폭 · 합계 차트 150px · 표는 가로 스크롤.
- **상태 6종**(④): 이력 없음(수집 누적 전 — 1점 차트를 지어내지 않고 문장) · DB 비활성(`db:false`) · 부분 결측(빗금 + 합계 생략) · 엣지 위임(중앙 이력 시작 시점) · 목록 상한 64 밖 · 디스크 I/O 미수집 + MOCK.
- **흐름**(⑤): 수집기 2 → 스냅샷 → 적재 지점 2 → `saveNodeLoadPoint`(트랜잭션 1) → 표 2개 → API → 화면 · 보존 정리 · 규모 산수 · 옵션 ②.

### 5.3 차트 규약(데이터 시각화 지침 — 검증기로 확인)
- 형태: 노드 × 시간 **히트맵(단일 색조 순차)** 이 기본 — ‘노드가 많을 때 색으로 구분하지 않는다’. 식별이 필요한 곳(In/Out · 겹쳐 보기 ≤ 4)만 범주색.
- 범주색은 기존 `CapacityTrend` 계열색 그대로: In/쓰기 `#3987e5` · Out/읽기 `#d95926`(2색 · 어두운 패널 `#141b2d` 기준 **검증기 전부 통과** — CVD ΔE 26.8 · 정상 31.8 · 대비 ≥ 3:1). 디스크 묶음도 같은 두 색을 쓴다(한 번에 한 묶음만 보이므로 충돌하지 않는다 — 범례 글자가 ‘쓰기/읽기’ 로 바뀐다). 겹쳐 보기 4색 `#3987e5 · #d95926 · #199e70 · #c98500` 도 통과(최악 인접 CVD 8.4 · 정상 19.8).
- 히트맵 램프 5단계 `#184f95 → #2a78d6 → #5598e7 → #86b6ef → #b7d3f6`(어두운 면에서 밝을수록 큼 · 단일 색조 · 단계 ΔL ≥ 0.06). 값 없음은 빗금(45°) — 색이 아니라 질감.
- 선 2px · 막대 ≤ 24px(14px) + 끝 4px 둥글게 · 칸 사이 2px 틈 · 격자 실선 hairline · 글자는 계열색을 입지 않는다(값·이름표는 글자색, 옆에 색 키) · 숫자를 모든 점에 달지 않는다(끝 값만) · 범례는 2계열 이상에 항상 · 표 보기 쌍둥이(노드 표 + ‘표로 보기’).
- 이중 축 없음 — In/Out 은 같은 단위라 한 축. 디스크 I/O 를 나중에 더해도 같은 차트에 겹치지 않고 방향 버튼으로 바꾼다.

## 6. 사용자에게 묻는 것(기본값 제안 — 답이 없으면 기본값으로 간다)

| # | 질문 | 기본값 | 다른 선택 |
|---|---|---|---|
| 1 | **표본 주기**: 지금 수집 주기(기본 1시간)의 값만 저장(장비 부담 0) | **그대로**(요청 ‘이미 수집하는 정보에서’) | 노드 부하만 더 자주(예 5분) 읽는 가벼운 폴러 — SSH/REST 호출이 ×12, 인증 정지 규칙 동일 적용 — 별건으로 |
| 2 | **디스크 I/O** | **포함**(08:27 사용자 ‘Disk io 추가’ — 답 받음) | — |
| 3 | **원시 보존 기본값** | **30일**(설정 1~400일) | 용량과 같은 90일 |
| 4 | **화면 자리** | 장비 상세 모달의 ‘노드’ 절(기본 보기 히트맵) | 스토리지 모니터링에 하위 탭 `#/tools/storage-mon/nodeload`(전 장비 비교) — 별건으로 |
| 5 | **노드 식별** | lnn(id) — 교체 노드도 이어진다 | 시리얼이 바뀌면 끊고 표시 |
| 6 | **검증 수준** | 표준(관련 테스트 + Chromium 1440/400) | 전체 검증 / 빠르게 |
| 7 | **이전 구간 이동**(08:21 요청) | 슬라이더 + ◀▶ + 최신 + 날짜·시각 이동 + 긴 보기에서 열 클릭 → 그 날 24시간 | 날짜·시각 이동만(슬라이더 없이) |
| 8 | **디스크 방향 표기** | ‘쓰기(In) / 읽기(Out)’ 로 두고 첫 실장비 수집에서 확인 | ‘In / Out’ 그대로 |

## 7. 구현 계획(컨펌 뒤 — 규칙상 Opus)

| 단계 | 파일 | 테스트 |
|---|---|---|
| 수집기 | `storage/collectors/isilon.js`(키 2개 · `diskInBytesPs/diskOutBytesPs` · 키 없음 문구) · `isilonSsh.js`(`isi statistics system` 명령 · 순수 파서 `parseIsiSystemStats` · lnn 조인) · `types.js` 계약 주석 · `central/edgeRecord.js NODE_NUM_KEYS` · 엣지 export | 픽스처(REST 키 있음/없음 · CLI JSON 세 모양 · 세션 예산) · 기존 `storageMon.test.js` 유지 |
| DB | `storage/db.js`(표 2 · `saveNodeLoadPoint` · `nodeLoadHistory` · `nodeLoadDaily` · prune 합류 · 장비 삭제) · `storage/growthSettings.js`(원시 보존 칸) | `server/test/storageNodeLoad29xx.test.js` — 트랜잭션 1개 · null 은 NULL · 넷 다 null 행 없음 · 중복 · prune · 일 롤업 avg/max(4계열) · 부분 합 null |
| 적재 지점 | `storage/poller.js` · `central/storageEdge.js` · `mock/demo/storage.js`(백필 · 디스크 합성값) | 같은 테스트(실제 centralRouter 로 push → 중앙 적재 · 구버전 엣지 = 디스크 null) |
| API | `routes/api/storageMon.js`(`/devices/:id/node-load` · `end` 창 · `oldest/retention/past`) · `auth/toolAccess.js` 등록 확인 | 범위 404 · 데모 마스크 · range 별 모양 · end 과거 창 · 미래 end 자르기 · thinned |
| 웹 | `StorageMonTool.jsx`(구역 1개 · 노드 표 열 4개) → `views/tools/storageNodeLoad/` 분리 · 판정·문구 `storageNodeLoadText.js`(순수 — 단위·합계 null·슬라이더 범위) · `storageNodeLoad.css` · 창 계산은 `xferSpeedText` 순수 함수 재사용(공용화 여부 확인) | 웹 테스트(문구 · 합계 null 규칙 · 색 고정 규칙 · 창 계산 대조) · Chromium 1440/400 · A/B |
| 문서 | `docs/rules/storage.md` 항목 추가 · release-notes · 이 README 상태 갱신 · 첫 실장비 수집 뒤 디스크 방향 확정 메모 | — |

예상: 구현 + 테스트 약 90~110분(디스크 수집기 2경로 + 이전 구간 창이 더해졌다) · 검증 표준 약 30분(별도 보고에 적는다).

## 8. 구현 기록(v2.926 — 2026-11-07 11:37~ KST · Opus)

사용자 선택: 시안 v2 + 성능 관점 추천 중 **①노드 CPU · ④잡 엔진 겹쳐 표시 · ⑤지난주 같은 구간 비교**를 이번에(‘추천대로 진행’). ②디스크 busy·IOPS ③프로토콜 지연 ⑨표본 주기 분리는
실장비에서 키·응답 모양을 본 뒤 다음 릴리스. 미답 질문은 제안 기본값(원시 보존 30일 · 검증 표준 · 자리 = 장비 상세 · 노드 식별 = lnn).

**정정(앞 설계 문장이 틀렸던 것)**
1. §4.2 ‘장비 삭제(`delCapDev`) 때 두 표도 지운다’ — 틀렸다. `delCapDev` 는 장비 삭제가 아니라 `resetCapacityHistory`(측정 기준 재시작)에서만 쓰이고, 장비를 지워도 용량 이력은 남는다(보존 기간으로 정리). 노드 부하도 같게 했다.
2. §4.1 ‘넷 다 null 이면 행을 만들지 않는다’ — 바꿨다. 목록에 있는 노드는 값이 모두 비어도 원시·일 행을 남긴다. 행이 없으면 그 주기의 클러스터 합계가 부분 합인지 판정할 수 없다(노드가 통째로 빠진 합을 전체로 그리게 된다).
   대신 **노드 값이 하나도 없는 스냅샷**(Unity·PowerStore 처럼 노드 처리량을 재지 않는 타입)은 적재하지 않는다.
3. 화면 문구의 설정 경로 — ‘설정 › 수집 › 스토리지 보존’ 이 아니라 **특수 기능 › 스토리지 증가량 › ⚙ 저장 기간**(그 모달이 `GROWTH_SPEC` 을 그대로 그린다 — 새 칸 ‘노드 부하 원시 보존 기간’).

**시안과 다르게 한 것(이유)**
- 자리는 장비 상세 **모달(폭 900px)** 이다. 1440 시안의 ‘히트맵 + 오른쪽 순위’ 는 flex-wrap 으로 모달 안에서 나란히(좁으면 아래로) 놓인다.
- 겹쳐 보기의 노드 선택은 노드 표 체크 상자가 아니라 **겹쳐 보기 안의 체크 상자**(+ 히트맵 노드 이름 클릭)로 했다 — 노드 표는 기존 공용 표(STable)라 선택 상태를 표와 패널이 나눠 갖게 되면 두 벌이 된다. 색 칸은 고른 순서에 붙는다(남은 노드 색 유지).
- 날짜·시각 이동은 시안대로 `datetime-local`(시간 단위). 창 계산은 전송 속도의 순수 함수를 그대로 쓰고, ‘그 시각을 창 끝으로’ 만 `nodeLoadText.scrollToEnd` 로 더했다.
- 7일 보기는 4시간 버킷(평균 · 툴팁에 최대), 30일·90일은 하루 1칸(90칸 — 시안의 2일 묶음 대신 일 롤업 그대로).
- 잡 엔진(④)은 히트맵 맨 아래 ‘잡 엔진’ 행(칸 정렬이 맞는 자리) + 합계 차트 툴팁. REST 장비는 잡을 읽지 않으므로 행을 그리지 않는다(‘잡 없음’ 이 아니라 ‘모름’).
- 지난주 비교(⑤)는 합계 차트의 회색 선 + 타일 ‘대비 %’(두 구간 모두 합계를 낸 칸이 절반 이상일 때만).
- 노드 표 ‘추이’ 열은 **넣지 않았다**(처음 구현 뒤 뺐다) — Chromium 1440 판독에서 디스크·CPU 열과 함께 900px 모달을 넘어 기존 HDD/SSD 열이 가로 스크롤 뒤로 밀렸고,
  추이는 바로 위 패널(히트맵·소형 다중)이 이미 보여 준다. 대신 **아이실론 상세 모달만 1240px**(다른 타입은 900 그대로) — 1440 에서 노드 표 넘침 0(측정), 400 에서는 Modal 이 화면 폭으로 줄인다.
- 히트맵 행의 최소 폭은 칸 수에 맞춘다(칸당 4px) — 24칸은 400px 에서도 상자 안에 다 들어가고, 90칸(일)만 상자 안 가로 스크롤.

