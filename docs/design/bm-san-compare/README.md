# 설계: 베어메탈 스토리지 ↔ SAN(VMAX · PowerMax) 비교 — 디스크 사용률 · 전송 속도를 숫자로 한 표에

작성 2026-11-09 (main v2.914.0 기준 · 브랜치 `claude/festive-curie-16lmut`) · 상태 **시안 — 컨펌 대기**
시안 캔버스: https://claude.ai/artifact/Ww4x7UTUS5CYbY3cVJhAdB (아트보드 5장 — ⓪ 지금 · ① 1440 · ② 400 · ③ 상태 6종 · ④ 대안).
이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스(HTML 프로토타입 — 복사 대상이 아님). **서버 · 어레이 이름과 수치는 전부 가상**(베어메탈은 데모(mock) 사양, 어레이 `PMAX-2500-KR1` 등은 지어낸 이름).
색 · 글자는 `web/src/styles.css` `:root` 토큰과 `.bm2-*`(v2.688 베어메탈 시안) 그대로(새 hex 없음). 계정의 ‘Design System’ 아티팩트는 없다(목록으로 확인).
규칙(2026-11-03 ‘기억해’): 설계는 Fable + Claude Design 시안 → **컨펌 뒤** Opus 구현. §2 는 이 세션(Fable)이 코드로 확인한 사실이다.

## 1. 요구(사용자 2026-11-09 08:49 KST)

> "베어메탈 스토리지 라는 특수기능이있는데, 그 베어메탈 스토리지의 실시간 디스크 사용율을 파악하고 싶어, 그래서 SAN vmax, pmax 사용율/전송 속도와 숫자로 비교하고 싶어, 기능 만들어줘"
> → 진행 방식 질문에 "시안 보여줘".

## 2. 지금 코드에서 확인한 것(설계의 근거 — 2026-11-09 08:49~08:53 KST)

| 사실 | 위치 |
|---|---|
| 베어메탈 스토리지는 SSH `df -P -k -- <마운트>` 로 **용량만** 모은다. 주기 1~1440분(기본 10분), 최신값은 메모리(`latest`), 12시간 이력은 별도 DB. 전송 속도 · 디스크 바쁨은 수집하지 않는다 | `server/src/bmstor/collect.js:118` · `poller.js` · `historySampler.js` |
| 수집 경로 셋 — 중앙 직접 `collectMany` · 엣지 폴링 위임(`agent/bmstorWorker.js` → `POST /api/central/bmstor-result` → `applyBmstorResults`) · 중앙→엣지 PUSH(`/api/collector/bmstor-collect`). 폴링 회신은 `sanitizeBmMounts` 로 정제하지만 **PUSH 회신은 정제 없이 `latest` 에 들어간다**(`collectViaEdge` → `bmCollectNow`) — 발견한 기존 간극, 이번에 같은 정제로 묶는다 | `poller.js:93·159·190` · `routes/collector.js:306` |
| 사용률 정의는 df 와 같은 used / (used + avail), 분모 0 은 null(0 아님). 그룹은 서버당 최대 3개라 **그룹 합이 전체보다 클 수 있다** | `collect.js dfUsedPct` · `agg.js` |
| 화면 `BmStorageTool.jsx`(v2.688 시안) — KPI · 주의 카드 · 12시간 추이 · 그룹 카드 · 서버 표. 15초마다 `/tools/bm-storage`(메모리 값 — 가볍다) 재조회. 하위 탭 없음 | `web/src/views/tools/BmStorageTool.jsx` |
| 게이트 — 현황 · 수집 · 설정 전부 `adminOnly + fullScopeOnly`(vCenter 범위 밖). 비-관리자 상세에는 주소 가림 | `routes/api/bmstor.js:21~31` |
| VMAX · PowerMax 용량 사용률은 스토리지 모니터링 스냅샷 `capacity.{totalBytes,usedBytes,pct}` — Unisphere `usable_used_tb`(데이터 감축 후 실사용) 우선, `physicalCapacity` 는 폴백이고 `extra.capacityBasis` 가 기준을 말한다. 시리얼은 `snap.serial`(symmetrixId) | `storage/collectors/powermax.js:115~164·318·420` |
| 어레이 **성능(IOPS · MB/s)은 수집하지 않는다** — powermax.js 에 perf · throughput · iops 가 0건 | grep 확인 |
| VMAX · PowerMax **전송 속도는 SAN 스위치 포트 사용량 DB** 가 가진다 — `portperfshow` 5분 주기 바이트/초, 포트 메타의 연결 이름(`SYMMETRIX::<시리얼>::SAF-1d …`)을 `storageKey` 로 어레이별 묶고, `arraySerialOf` 로 뽑은 시리얼을 등록 스토리지 시리얼과 대조해 용량을 덧붙인다(확신 없으면 빈 값 — 억지 매칭 금지) | `sanswitch/perfDb.js:713·773·791·929` |
| 그 합산 API 가 이미 있다 — `GET /tools/sanswitch/perf/storage-summary`(법인 복수 · split · kind · 1시간~7일) → series[{key, avgTotal, maxTotal, peakAvg, peakTotal, ports, switches, arraySerial, endpointKind, capacity}] · `storageSeriesMulti` 는 heavyQuery 기억(TTL = 수집 주기) | `routes/api/sanSwitch.js:882` |
| 측정 없음 규약 — 부분 합으로 비워진 계열은 `avgTotal·peakAvg·peakTotal` 이 null 이고 화면은 ‘—’ 로 둔다(v2.721). 피크 합은 동시 피크의 **상한** | `web/src/views/tools/sanStorageSumText.js` · `trafficTotal.js` |
| 데모(mock) — 베어메탈 10대(`demoBmResult`) · 스토리지 장비(`demoStorageDevices`, powermax · vmax 포함) · SAN 포트 수식(`demoPerfSynth.js`) 이 있어 Chromium 검증이 비지 않는다. 데모 df 결과에 I/O 를 더해야 한다 | `server/src/mock/demo/storage.js:242~265` |
| 엣지 로그 등재 — `collect.bmstor` · `push.bmstor` 가 이미 있다(새 워커 없음 — 같은 워커가 I/O 를 함께 올린다) | `edgelog/spec.js:118·137` |

규모(설계 제약): 운영 28 법인 · RTT 800ms+ · 베어메탈 서버 상한 1,000대(동시 4) · 엣지 PUSH 시한 60초 + 서버당 20초 · 인증 실패 정지 규칙 · 1440/400 · 주기 숫자를 화면에 박지 않는다(API 값).

## 3. 정직하게 밝혀야 하는 것(시안 문구에 반영)

1. **용량의 뜻이 다르다** — 베어메탈 df used/(used+avail)(지정 마운트만) ↔ SAN Unisphere 감축 후 실사용(씬 구독 아님). 두 % 를 한 표에 두되 ‘기준 · 신선도’ 칸이 뜻을 말한다.
2. **전송 속도의 출처가 다르다** — 베어메탈은 서버 `/proc/diskstats` 를 2초 간격 두 번 읽은 **그 순간의 표본**(서버 전체 물리 디스크 합 — 마운트별이 아니다). SAN 은 **스위치 포트 트래픽** 1시간 평균(또는 피크)이고 어레이 자체 성능 API 는 수집하지 않는다. 배율은 ‘참고치’ 라고 쓴다.
3. **‘실시간’ 은 수집 주기 단위다** — 주기 하한 1분 + ‘지금 측정’ 버튼. 화면이 열려 있는 동안 자동으로 SSH 를 여는 모드는 기본에 넣지 않았다(④-D — 로그인 시도가 겹쳐 계정 잠금 규칙과 충돌). 행마다 표본 시각을 보여 준다.
4. **못 읽은 값은 0 이 아니다** — 측정 불가 서버(Linux 아님 · 엣지 구버전 회신 · 수집 대기 · 인증 정지)와 시리얼 미대조 어레이는 ‘—’ 로 두고 합에서 빼며 ‘9/10대 측정 합’ 처럼 개수를 쓴다. 측정 불가가 섞인 그룹의 합은 **부분 합**(호박색).
5. **그룹 겹침** — 서버가 여러 그룹에 속하면 그룹 행의 합이 전체보다 클 수 있다(현황 탭과 같은 규칙 · 각주).
6. 마운트별 I/O 는 하지 않는다 — df 의 파일시스템 → 블록 장치(dm · md · 파티션) 대응이 서버마다 달라 틀린 값을 만들기 쉽다. 서버 단위가 어레이 단위와도 같은 눈높이다.
7. 베어메탈 I/O 표본은 12시간 이력 DB 에 **쌓지 않는다**(순간 표본을 추이로 적재하면 거짓 추세가 된다). 추이가 필요하면 별건으로 평균 표본 설계부터.
8. 캡처 ⓪ 은 이 세션에서 목 서버를 띄우지 않아 글로 대신했다(의존성 설치 중) — 구현 단계 Chromium 검증에서 실제 화면으로 확인한다.

## 4. 데이터 · 서버

### 4.1 베어메탈 디스크 I/O 표본(새 수집 — 같은 SSH 세션, 명령 1개 추가)
- `df` 다음에 상수 명령 `cat /proc/diskstats; sleep <N>; echo __DVC_IO_SEP__; cat /proc/diskstats` (입력이 들어가는 자리 없음 — 주입 면). `N` = `BMSTOR_IO_SAMPLE_SEC`(기본 2 · 0 = 끔 · 1~10 클램프). 서버당 약 N초가 늘어난다(동시 4 · 기본 10분 주기면 1,000대도 여유 — 엣지 PUSH 시한은 서버당 20초라 그대로).
- 순수 함수(테스트 대상): `parseDiskstats(text)` → `Map<dev, {rdSectors, wrSectors, ioMs}>` — **통짜 디스크만**(`^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$`), dm · md · loop · ram · 파티션은 같은 I/O 의 중복이라 뺀다. `ioRate(before, after, elapsedMs)` → `{ readBps, writeBps, totalBps, busyPct, busiestDev, disks, sampleMs }` — 섹터 512B 고정(diskstats 규약), 카운터가 줄어든 장치(재설정)는 그 장치만 null, `busyPct` = Δio_ms / Δt 의 **장치별 최댓값**(가장 바쁜 디스크 — 평균이 아니다 · 100 상한).
- 결과 모양: `io: { … , at } | null` + `ioError: '/proc/diskstats 없음(Linux 아님)' | 'I/O 표본 꺼짐' | …`. df 가 성공했으면 io 실패가 서버를 오류로 만들지 않는다(용량은 살린다).
- 엣지: `collectMany` 를 공유하므로 PUSH 경로는 자동. 폴링 워커의 회신 화이트리스트(`safe`)에 `io · ioError` 를 더한다. 중앙 `sanitizeBmIo`(숫자는 `numOrNull` · 문자열 상한 · 디스크 수 상한 256) 를 **폴링 · PUSH 두 경로에 같은 함수로** 건다(§2 의 간극도 여기서 닫힌다 — `sanitizeBmResult` 하나). 구버전 엣지 회신(io 없음)은 `ioError: '엣지 회신에 I/O 값 없음(엣지 구버전)'`.
- `aggregate`: 그룹 · 전체에 `io: { readBps, writeBps, totalBps, measured, total, partial }` — 측정된 서버만 더하고 개수를 쓴다. 측정 0 이면 null.

### 4.2 `GET /api/tools/bm-storage/compare?hours=1&types=vmax,powermax`
- 게이트 `adminOnly + fullScopeOnly`(현황과 같다 · 403 문구 같다). 응답에 **주소를 싣지 않는다**(서버 이름 · 그룹 · 수치만) — 가림 분기 자체가 없다.
- `bm`: `aggregate()` 의 total · groups · perServer(io 포함) + `status`(lastRunAt · running) + `settings.intervalMinutes`.
- `san`: `listDevices()`(storage/registry) 중 `type ∈ types`(기본 vmax · powermax · `types=all` 이면 블록 어레이 전부) · enabled → 최신 스냅샷(`localSnapshots()` ∪ `edgeStorageSnapshots()`) 의 `capacity` · `extra.capacityBasis` · `collectedAt` · `serial`. 전송 속도는 `storageSeriesMulti(모든 enabled SAN 스위치 id, { hours })` 결과를 `arraySerialOf(key)` ↔ 스냅샷 시리얼(`norm`) 로 대조해 `{ avgTotal, maxTotal, peakAvg, peakTotal, ports, switches, lastSampleAt }`; 못 붙이면 `throughput: null, reason: 'perf-disabled' | 'no-samples' | 'serial-unmatched'`(코드 — 문장은 웹).
- `summary`: `capacity: { bmPct, sanPct, deltaPp }` · `throughput: { bmBps, sanBps, ratio, bmMeasured/bmTotal, sanMeasured/sanTotal, sanPeakSumBps }` · `fresh: { bmAt, bmIntervalMin, sanPerfAt, sanPerfIntervalMin, sanCapAt, sanCapIntervalMin }`. 분모가 null 이면 ratio · delta 도 null.
- 무거운 쪽은 `storageSeriesMulti` 뿐이고 자체 기억(TTL = 수집 주기)이 있어 추가 캐시를 두지 않는다. 화면은 **마운트 1회 + 버튼 + ‘지금 측정’ 완료 뒤 1회**만 부른다(무거운 API 15초 폴링 금지). 베어메탈 쪽 15초 재조회는 현황과 같은 가벼운 `/tools/bm-storage`.
- 데모(mock): `demoBmResult` 에 결정적 I/O(서버 해시 기반 읽기 · 쓰기 · 바쁨 · 1대는 `ioError`)를 더한다.

### 4.3 바뀌지 않는 것
도구 키 `bm-storage` · 권한 · 카탈로그 · 12시간 이력 DB · SAN 스위치 화면 · 스토리지 모니터링 화면 · vCenter 호출 0.

## 5. 화면(IA) — 아트보드 5장

| 보드 | 파일 | 내용 |
|---|---|---|
| ⓪ | `Current.dc.html` | **지금** — 세 화면(베어메탈 현황 · 스토리지 모니터링 · SAN 스토리지 사용량 분석)에 값이 흩어져 있고 베어메탈 전송 속도는 없다 |
| ① | `Main.dc.html` | **1440** — 베어메탈 스토리지 › **SAN 비교** 탭(`#/tools/bm-storage/compare`). 위→아래: 하위 탭(현황 · SAN 비교) · 설명 + 상태 줄 · 버튼(지금 측정 · 새로 고침 · CSV) · 도구 모음(SAN 종류 칩 · 전송 속도 범위 1시간/24시간/7일 · 평균/피크) · **비교 요약**(용량 사용률 ↔ · 전송 속도 ↔ · 기준 · 신선도) · **비교 표**(합계 2행 고정 + 그룹 7 + 어레이 4 · 사용률 높은 순 · STable 정렬) · **한눈에**(사용률 막대 0~100 · 75% 선 · 전송 속도 막대 최댓값 대비) · **서버별 디스크 I/O** 표(읽기 · 쓰기 · 합 · 바쁨(가장 바쁜 디스크) · 표본 · 상태) · 알아 둘 것 4줄 |
| ② | `Narrow.dc.html` | **400** — 같은 화면. 요약은 세로, 비교 표는 행 카드, 서버별 I/O 는 접힘 |
| ③ | `States.dc.html` | 상태 6종 — SAN 어레이 없음 · 포트 사용량 수집 꺼짐 · 시리얼 미대조 · 베어메탈 측정 불가 4가지 · 측정 중 · 403 |
| ④ | `Alt.dc.html` | 대안 — A 탭(추천) vs B 새 특수 기능 ‘스토리지 비교’ · C 주기 하한 1분 + 버튼(추천) vs D 화면이 열려 있는 동안 자동 1분 측정 |

색 규칙: 베어메탈 = 민트(`--mint`), SAN = 파랑(`--accent`), VMAX 배지 보라 · PowerMax 배지 파랑, 부분 합 · 측정 없음 = 호박색(`--amber`), 사용률 색은 현황 탭의 `pctColor`(90 빨강 · 75 호박). `BoldText` 규약(백틱 금지 · 인용은 ‘ ’) · `STable`(`data-sort` · `data-pin` 합계 행 · null 은 뒤) · `text-transform` 없음.

## 6. 결정이 필요한 것(기본값으로 두고 진행 가능)

| # | 질문 | 기본값(시안) | 다른 선택 |
|---|---|---|---|
| 1 | 자리 | ④-A 기존 도구의 ‘SAN 비교’ 탭 | ④-B 새 특수 기능(도구 키 · 권한 · 카탈로그 6곳 변경) |
| 2 | ‘실시간’ | ④-C 주기 하한 1분 + ‘지금 측정’ | ④-D 화면이 열려 있는 동안 자동 1분 측정(관리자별 1건 · 5분 뒤 자동 끔 조건) |
| 3 | 베어메탈 전송 속도 | diskstats 2초 표본 추가(서버 전체 물리 디스크) | 용량만 비교(전송 속도는 SAN 쪽만) |
| 4 | SAN 종류 | VMAX · PowerMax 기본, 칩으로 Unity · PowerStore · XtremIO 확장 | VMAX · PowerMax 고정 |
| 5 | 전송 속도 기준 | 1시간 평균 기본 · 피크 토글 · 24시간 · 7일 | 24시간 기본 |
| 6 | 검증 | 표준(변경 모듈 테스트 + 엣지 회신 정제 변이 확인 + 전량 1회 + Chromium 1440/400) | 전체(반증 에이전트 · A/B) / 빠르게(Chromium 생략) |

## 7. 구현 순서(컨펌 뒤 · 규칙상 Opus)

1. `bmstor/diskstats.js`(순수 — parse · rate) + `collect.js` 명령 1개 추가 + `poller.js sanitizeBmResult`(폴링 · PUSH 공용) + `agent/bmstorWorker.js` 회신 필드 + `agg.js` io 합 + 데모 I/O. 테스트 `server/test/bmstorIo29xx.test.js`(파서 · 중복 장치 제외 · 카운터 역행 · 정제 변이 · PUSH 정제 · 부분 합).
2. `bmstor/compare.js`(순수 — 시리얼 대조 · 요약 계산) + `routes/api/bmstor.js` compare 라우트 + 테스트(범위 계정 403 · 주소 미포함 · 미대조 사유 코드).
3. 웹 `views/tools/BmSanCompare.jsx` + `bmSanCompareText.js`(fmtBps · 차이 · 배율 · 기준 문장 · 사유 코드→문장) + `BmStorageTool.jsx` 하위 탭(`useHashTab`) + vitest.
4. 문서 — `docs/rules/storage.md` 항목 · `specialToolsList.js` 설명에 ‘SAN 비교’ · API 문서 생성기 · 릴리스 노트 · 버전.
5. 검증 — 변경 모듈 테스트 → 빌드 → Chromium 1440/400(admin) → 전량 verify(백그라운드) → PR → CI → 머지 → 릴리스 → `versions.json`.
