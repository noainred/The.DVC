# 설계: 아이실론 노드별 네트워크 부하(In / Out) — 저장 + 추이 차트

작성 2026-11-07 (main v2.914.0 기준 · 브랜치 `claude/charming-lamport-rr6090`) · 상태 **시안 — 컨펌 대기**(2026-11-07 07:42 KST 요청) ·
시안 캔버스: https://claude.ai/artifact/4Uktx1J1iDEEpojgWVz1fj (아트보드 6장 — ⓪ 지금 · ① 시안 1440 · ② 보기 전환(소형 다중 · 겹쳐 보기) · ③ 400px · ④ 상태 6종 · ⑤ 데이터 흐름 · 저장 구조).
이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스(HTML 프로토타입 — 복사 대상이 아님). **장비 · 노드 · IP · 시리얼 · 수치는 전부 가상**(데모 `PS-FRA-01` 모양)이다.
색 · 글자는 `web/src/styles.css` `:root` 토큰과 기존 `CapacityTrend`(v2.318)가 쓰는 계열색(`#3987e5` · `#d95926`) 그대로다(새 hex 는 히트맵 단일 색조 램프 5단계뿐 — §5.3).
규칙(2026-11-03 ‘기억해’): 설계는 Fable + Claude Design 시안 → **컨펌 뒤** Opus 구현. §2 는 이 세션(Fable)이 코드로 확인한 사실이다.

## 1. 요구(사용자 2026-11-07 07:42 KST)

> "아이실론에서 이미 수집하는 정보에서 노드별 io network 부하를 저장하고 차트로 그려서 볼 수 있게 해줘 클로드 코드로 시안 보여줘"

읽기: **새 장비 호출 없이**(이미 수집하는 정보에서) 노드별 부하를 **시계열로 저장**하고 **차트**로 본다. ‘io network 부하’ 는 지금 노드별로 받는 값이 네트워크 In/Out 뿐이라(§2) **네트워크 In/Out 처리량**으로 읽었다. 디스크 I/O 는 §3-②.

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
2. **디스크 I/O 는 지금 수집하지 않는다.** 옵션 ②(§4.6)로 키를 늘리면 REST 는 왕복 0, SSH 는 명령 1개다. OneFS 키 이름(`node.disk.bytes.in.rate` 등)과 CLI JSON 모양은 **실장비 미확인**(수집기 머리말과 같은 수준의 문서 지식).
3. 노드 목록 상한 64 밖 노드는 이력이 없다(66노드 클러스터 실재 — v2.615). 화면이 밝힌다(④-⑤).
4. 이력 키는 `node id(lnn)` 다. 노드를 교체해 같은 lnn 이 들어오면 추이가 이어진다 — 시리얼로 끊지 않는다(§6 질문).
5. Unity·PowerStore·VPLEX 수집기는 노드 `inBps/outBps` 를 null 로 보낸다 → 이 화면은 **값이 있는 장비(Isilon)에만** 나타난다. 저장 계층은 타입을 가리지 않는다(값이 있으면 적재).
6. 엣지 위임 장비의 중앙 이력은 **이 기능이 들어간 뒤 push 받은 분부터**다. 엣지의 옛 값을 소급해 올리지 않는다.
7. 시안의 모든 수치는 가상이다. Chromium 캡처는 없다(설계 단계 — 구현 뒤 1440/400 으로 본다).

## 4. 데이터 · 서버 — 새 장비 호출은 없다

### 4.1 적재 `storage/db.js saveNodeLoadPoint(snap)`
- 조건: `snap.ok` 이고 `sections.nodes === 'ok'` 이고 `nodes.list` 가 배열. 아닌 스냅샷은 사유와 함께 `saved:false`(조용히 버리지 않는다 — `saveCapacityPoint` 와 같은 모양).
- 노드마다 원시 1행 — `inBps` · `outBps` 는 `numOrNull`; **둘 다 null 이면 행을 만들지 않는다**(정보가 없다). 하나만 null 이면 그 칸만 NULL.
- **스냅샷 1개 = 트랜잭션 1개**(최대 64행 + 일 롤업 upsert — 무트랜잭션 6천 행 사고 규칙).
- 중복: `(device_id, node_id, ts)` 같은 행은 건너뛴다(`hasCap` 과 같은 규칙 · 엣지 재push 는 상위 `_lastRec` 가 먼저 거른다).
- 호출 지점 2곳 — `poller.js:135` 옆과 `storageEdge.js:263` 옆. 던지지 않는다(DB 비활성이면 수집·보관·로그는 계속).
- **부분 합 금지**: 클러스터 합계는 적재하지 않고 읽을 때 만든다(§4.3) — 어느 노드든 null 이면 그 주기 합계는 null.

### 4.2 표 2개(`storage-history.db`, 기존 파일 · `CREATE TABLE IF NOT EXISTS` 추가)
```
node_load_history (device_id TEXT, node_id INTEGER, ts INTEGER, in_bps REAL NULL, out_bps REAL NULL)
  INDEX idx_nlh_ts (ts) · INDEX idx_nlh_dev_ts (device_id, ts)          -- prune 용 ts 단독 + 조회용
node_load_daily   (device_id TEXT, node_id INTEGER, day INTEGER, samples INTEGER,
                   in_sum REAL, in_max REAL, in_n INTEGER, out_sum REAL, out_max REAL, out_n INTEGER,
                   PRIMARY KEY (device_id, node_id, day))                -- avg = sum / n (n 은 읽은 표본만)
```
- 일 경계는 `util/dayKey.js`(KST 오프셋) — `capacity_daily` 와 같다. upsert 는 `ON CONFLICT DO UPDATE SET in_sum = in_sum + ?, in_n = in_n + ?, in_max = max(in_max, ?) …`(스칼라 `max()` — 집계 2개 한 문장 금지 규칙과 무관).
- 보존: 원시 **기본 30일**(설정 › 수집 › 스토리지 보존 기간 옆에 ‘노드 부하 원시 보존’ 한 칸 · 1~400일) · 일 롤업은 용량과 같은 5년. prune 은 기존 `maybePrune` 틱에 합류(ts 인덱스 · `chunkedDelete` · 기동 첫 틱 금지).
- 규모 산수(클러스터 1개 · 1시간 주기): 8 노드 192행/일 · 64 노드 1,536행/일 → 원시 30일 5.8천~4.6만 행 · 일 롤업 8~64행/일(5년 1.5만~12만 행). 폴링을 5분으로 줄이면 ×12 — 그래서 원시 보존 기본을 용량(90일)보다 짧게 둔다.
- 장비 삭제(`delCapDev`) 때 두 표도 지운다. `resetCapacityHistory` 는 건드리지 않는다(용량 기준 변경과 무관).

### 4.3 API `GET /tools/storage/devices/:id/node-load?range=24h|7d|30d|90d[&nodes=1,2]`
- 게이트 `toolsPerm` + `fullScopeOnly`(용량 추이와 같다) · 데모 계정은 mock- 장비만(기존 `demoMask` 규칙 그대로).
- 응답 `{ db, range, spanMs, bucketMs, sampleMs(= 현재 수집 주기 — 화면이 ‘주기 N’ 을 여기서 읽는다), basis:{ source:'isi status'|'REST node.net.ext.bytes.*.rate', kind:'instant' }, nodeLimit:64, nodes:[{ id, ip?, points:[{ ts, in, out }] }], cluster:[{ ts, in, out, nodes }], thinned, truncated }`.
  · 24h: 원시 그대로 · 7d: 버킷 평균(`selCapBucket` 패턴 · CAST) · 30d/90d: **일 롤업**(avg + max) — 원시 폴백 없음(`historyRollup` 규약).
  · `cluster[]` 는 서버가 만든다(노드 하나라도 null 인 주기는 `in/out:null` + `nodes:<읽은 수>`). 일 롤업 구간의 합계는 **노드 avg 의 합**이고 `kind:'daily-avg'` 로 밝힌다.
  · 점이 5,000 을 넘으면 고르게 솎고 `thinned:true`(isidu v2.769 규칙).
- 하나의 요청으로 노드 전부를 돌려준다 — 노드마다 부르지 않는다(상세 모달 열 때 1회 + 기간 바꿀 때 1회 · 폴링 없음).

### 4.4 엣지 — 바뀌는 것 없음
노드 목록의 `inBps/outBps` 는 이미 export · 중앙 정제(`NODE_NUM_KEYS`)에 있다. 엣지 포탈도 같은 `saveNodeLoadPoint` 를 로컬 DB 에 적재하므로 엣지 화면에서도 같은 구역이 뜬다. 옵션 ② 를 하면 그때 `NODE_NUM_KEYS` 에 디스크 키를 더한다.

### 4.5 데모(mock)
`backfillStorage` 가 용량 점을 백필하는 루프에서 `saveNodeLoadPoint(demoStorageSnapshot(d, t, now))` 도 부른다(7일 시간별 — 시간 단위 지터가 이미 있어 모양이 난다). `ps-fra-01`(8노드 · REST) 의 노드 7 은 몇 주기 null 로 둬 결측 표시를 Chromium 으로 볼 수 있게 한다. MOCK 배지는 그대로.

### 4.6 옵션 ② 디스크 I/O(이번 범위 밖 — 사용자 선택)
- REST: 같은 `statistics/current?devid=all` 호출에 `node.disk.bytes.in.rate` · `node.disk.bytes.out.rate`(문서 지식 — 실장비 미확인) 키를 더한다(왕복 0). 노드 필드 `diskInBps` · `diskOutBps`(B/s ×8 규칙 동일) + 표 열 2개 + `NODE_NUM_KEYS`.
- SSH: `ISI_STATS_CMD` 옆에 `isi statistics query current --nodes all --keys node.disk.bytes.in.rate,… --format json` 1개(세션 예산 안 · best-effort). CLI JSON 모양은 `parseIsiStatsBytes` 와 같이 세 모양을 받는다.
- 화면: 값이 있는 장비에서만 ‘디스크’ 방향 버튼이 생긴다 — 없는 열을 ‘—’ 로 늘어놓지 않는다(④-⑥).

## 5. 화면(아트보드) — 장비 상세 모달의 ‘노드’ 절에 새 구역 하나

### 5.1 ① 1440 — 구역 구성(위 → 아래)
1. 머리: ‘노드 부하 추이 — 네트워크 In / Out’ + 출처 pill(REST 키 또는 ‘isi status’ 처리량 열 — `basis.source`) + 표본 pill(‘수집 주기마다 1회 · 순간값(주기 N — 설정값)’ — `sampleMs`) + ‘표로 보기’ 링크.
2. 조작 한 줄(차트 위, 카드 밖 — 한 줄이 아래 전부를 지배): 기간 [24시간 | 7일 | 30일 | 90일] · 방향 [In | Out | In + Out] · 보기 [히트맵 | 소형 다중 | 겹쳐 보기]. 오른쪽에 ‘칸 = 수집 주기 1회(순간값) / 4시간 평균 / 하루 평균’ 한 줄.
3. 타일 4: 클러스터 합계(마지막 표본 In / Out) · 가장 바쁜 노드(기간 평균 · 노드 평균의 N배) · 가장 한가한 노드(최대와 N배 차이) · 표본 수 + ‘읽지 못한 노드값 N개 — 0 으로 채우지 않음’.
4. **노드 × 시간 히트맵**(기본 보기 — 노드가 24·64대여도 색을 늘리지 않는 형태): 행 = 노드(ID + IP), 열 = 표본(24h 는 24칸), 칸 색 = 그 방향 값의 5단계 단일 색조, 빗금 = 값 없음. 칸 hover 툴팁(노드 · 시각 · In · Out). 오른쪽 **노드 순위**(기간 평균 · 가로 막대 한 색 · 값은 글자색).
5. **클러스터 합계 추이**(In · Out 선 2개 · 범례 + 오른쪽 끝 이름표 · 세로 십자선 툴팁에 두 계열) — 한 노드라도 못 읽은 주기는 합계를 비운다(선이 끊긴다) + 그 사실을 아래 한 줄로.
6. 노드 표 = 기존 표 + **‘추이’ 열**(In·Out 스파크, 같은 응답으로 그린다 — 추가 호출 0) + **선택 체크**(≤ 4 → 겹쳐 보기). 열 순서·단위는 지금 표 그대로.
7. 읽는 법 한 단락(순간값 · 디스크 미수집 · ×8 · 엣지 시작 시점).

### 5.2 ② 보기 전환 · ③ 400px · ④ 상태 · ⑤ 흐름
- **소형 다중**: 노드마다 작은 차트(In · Out) · **Y 축 공통** · 범례 한 번 · 결측 노드는 선이 끊기고 한 줄 안내. 노드 수가 많아도 색이 늘지 않는다.
- **겹쳐 보기**: 체크한 노드 ≤ 4 · 한 방향만 · 색은 **노드 번호 순으로 고정**(선택을 바꿔도 남은 노드 색 유지) · 끝 이름표 + 범례. 5개 이상 체크하면 소형 다중으로.
- **400px**: 조작 세그먼트가 줄바꿈 · 타일 1~2열 · 히트맵은 상자 안 가로 스크롤(`min-width 640`) · 순위 막대 전폭 · 합계 차트 150px · 표는 가로 스크롤.
- **상태 6종**(④): 이력 없음(수집 누적 전 — 1점 차트를 지어내지 않고 문장) · DB 비활성(`db:false`) · 부분 결측(빗금 + 합계 생략) · 엣지 위임(중앙 이력 시작 시점) · 목록 상한 64 밖 · 디스크 I/O 미수집 + MOCK.
- **흐름**(⑤): 수집기 2 → 스냅샷 → 적재 지점 2 → `saveNodeLoadPoint`(트랜잭션 1) → 표 2개 → API → 화면 · 보존 정리 · 규모 산수 · 옵션 ②.

### 5.3 차트 규약(데이터 시각화 지침 — 검증기로 확인)
- 형태: 노드 × 시간 **히트맵(단일 색조 순차)** 이 기본 — ‘노드가 많을 때 색으로 구분하지 않는다’. 식별이 필요한 곳(In/Out · 겹쳐 보기 ≤ 4)만 범주색.
- 범주색은 기존 `CapacityTrend` 계열색 그대로: In `#3987e5` · Out `#d95926`(2색 · 어두운 패널 `#141b2d` 기준 **검증기 전부 통과** — CVD ΔE 26.8 · 정상 31.8 · 대비 ≥ 3:1). 겹쳐 보기 4색 `#3987e5 · #d95926 · #199e70 · #c98500` 도 통과(최악 인접 CVD 8.4 · 정상 19.8).
- 히트맵 램프 5단계 `#184f95 → #2a78d6 → #5598e7 → #86b6ef → #b7d3f6`(어두운 면에서 밝을수록 큼 · 단일 색조 · 단계 ΔL ≥ 0.06). 값 없음은 빗금(45°) — 색이 아니라 질감.
- 선 2px · 막대 ≤ 24px(14px) + 끝 4px 둥글게 · 칸 사이 2px 틈 · 격자 실선 hairline · 글자는 계열색을 입지 않는다(값·이름표는 글자색, 옆에 색 키) · 숫자를 모든 점에 달지 않는다(끝 값만) · 범례는 2계열 이상에 항상 · 표 보기 쌍둥이(노드 표 + ‘표로 보기’).
- 이중 축 없음 — In/Out 은 같은 단위라 한 축. 디스크 I/O 를 나중에 더해도 같은 차트에 겹치지 않고 방향 버튼으로 바꾼다.

## 6. 사용자에게 묻는 것(기본값 제안 — 답이 없으면 기본값으로 간다)

| # | 질문 | 기본값 | 다른 선택 |
|---|---|---|---|
| 1 | **표본 주기**: 지금 수집 주기(기본 1시간)의 값만 저장(장비 부담 0) | **그대로**(요청 ‘이미 수집하는 정보에서’) | 노드 부하만 더 자주(예 5분) 읽는 가벼운 폴러 — SSH/REST 호출이 ×12, 인증 정지 규칙 동일 적용 — 별건으로 |
| 2 | **디스크 I/O**(옵션 ②) | **이번엔 넣지 않는다**(실장비 미확인 키) | 같이 넣는다 — 실장비 응답을 보고 보정한다는 전제 |
| 3 | **원시 보존 기본값** | **30일**(설정 1~400일) | 용량과 같은 90일 |
| 4 | **화면 자리** | 장비 상세 모달의 ‘노드’ 절(기본 보기 히트맵) | 스토리지 모니터링에 하위 탭 `#/tools/storage-mon/nodeload`(전 장비 비교) — 별건으로 |
| 5 | **노드 식별** | lnn(id) — 교체 노드도 이어진다 | 시리얼이 바뀌면 끊고 표시 |
| 6 | **검증 수준** | 표준(관련 테스트 + Chromium 1440/400) | 전체 검증 / 빠르게 |

## 7. 구현 계획(컨펌 뒤 — 규칙상 Opus)

| 단계 | 파일 | 테스트 |
|---|---|---|
| DB | `storage/db.js`(표 2 · `saveNodeLoadPoint` · `nodeLoadHistory` · `nodeLoadDaily` · prune 합류 · 장비 삭제) · `storage/growthSettings.js`(원시 보존 칸) | `server/test/storageNodeLoad29xx.test.js` — 트랜잭션 1개 · null 은 NULL · 둘 다 null 행 없음 · 중복 · prune · 일 롤업 avg/max · 부분 합 null |
| 적재 지점 | `storage/poller.js` · `central/storageEdge.js` · `mock/demo/storage.js`(백필) | 같은 테스트(실제 centralRouter 로 push → 중앙 적재) |
| API | `routes/api/storageMon.js`(`/devices/:id/node-load`) · `auth/toolAccess.js` 등록 확인 | 범위 404 · 데모 마스크 · range 별 모양 · thinned |
| 웹 | `StorageMonTool.jsx`(구역 1개 · 노드 표 열 2개) → 200줄 넘으면 `views/tools/storageNodeLoad/` 분리 · 판정·문구 `storageNodeLoadText.js`(순수) · `storageNodeLoad.css` | 웹 테스트(문구 · 합계 null 규칙 · 색 고정 규칙) · Chromium 1440/400 · A/B |
| 문서 | `docs/rules/storage.md` 항목 추가 · release-notes · 이 README 상태 갱신 | — |

예상: 구현 + 테스트 약 60~80분 · 검증 표준 약 25분(별도 보고에 적는다).
