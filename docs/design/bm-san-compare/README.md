# 설계: 베어메탈 스토리지 ↔ SAN(VMAX · PowerMax) 비교 — 디스크 사용률 · 전송 속도를 숫자로 한 표에

작성 2026-11-09 (main v2.914.0 기준 · 브랜치 `claude/festive-curie-16lmut`) · 상태 **구현됨 — v2.915.0**(컨펌 2026-11-09 '진행해' — §6 기본값 그대로 · 검증 표준 · §8. 구현은 규칙상 Opus 이지만 사용자가 모델을 바꾸지 않아 이 세션(Fable)이 이어서 구현했다 — 보고에 밝힘)
시안 캔버스: https://claude.ai/artifact/Ww4x7UTUS5CYbY3cVJhAdB (아트보드 7장 — ⓪ 지금 · ① 1440 · ② 400 · ③ 상태 6종 · ④ 대안 · ⑤ 법인별 보기 · ⑥ 장비별 평균 · 피크 차트).
이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스(HTML 프로토타입 — 복사 대상이 아님). **서버 · 어레이 이름과 수치는 전부 가상**(베어메탈은 데모(mock) 사양, 어레이 `PMAX-2500-KR1` 등은 지어낸 이름).
색 · 글자는 `web/src/styles.css` `:root` 토큰과 `.bm2-*`(v2.688 베어메탈 시안) 그대로(새 hex 없음). 계정의 ‘Design System’ 아티팩트는 없다(목록으로 확인).
규칙(2026-11-03 ‘기억해’): 설계는 Fable + Claude Design 시안 → **컨펌 뒤** Opus 구현. §2 는 이 세션(Fable)이 코드로 확인한 사실이다.

## 1. 요구(사용자 2026-11-09 08:49 KST)

> "베어메탈 스토리지 라는 특수기능이있는데, 그 베어메탈 스토리지의 실시간 디스크 사용율을 파악하고 싶어, 그래서 SAN vmax, pmax 사용율/전송 속도와 숫자로 비교하고 싶어, 기능 만들어줘"
> → 진행 방식 질문에 "시안 보여줘".
> → 시안을 본 뒤(10:30 KST) 다른 화면의 ‘⚡ 바로가기’ 칩 줄 캡처(AZ · AZ-IRS · GM1 … 숫자 = 그 vCenter 의 조치 필요 VM · 고른 법인은 파랗게 · 접기)와 함께 **"법인별로 볼 수 있는 기능 추가"** → 보드 ⑤ · §4.4.
> → 3차(16:35 KST) **"각 장비별로 peak / average 디스크 access 성능을 비교하는 차트를 만들어서 실시간/트렌드 볼 수있는 차트 기능 추가"** → 보드 ⑥ · §4.5 · §4.6. 이 요청으로 §3-7(‘I/O 표본은 이력 DB 에 쌓지 않는다’)을 **정정**했다 — 추이를 보려면 쌓아야 하고, 평균은 카운터 차분으로 정확히 낼 수 있다.

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
2. **전송 속도의 출처가 다르다** — 베어메탈은 서버 `/proc/diskstats` 를 2초 간격 두 번 읽은 **그 순간의 표본**(서버 전체 물리 디스크 합 — 마운트별이 아니다). SAN 은 **스위치 포트 트래픽** 1시간 평균(또는 피크). 배율은 ‘참고치’ 라고 쓴다.
   ⚠ 정정(구현 중 main 병합 — v2.952): 설계 때 "어레이 자체 성능 API 는 수집하지 않는다" 고 적었는데, 그 사이 main 이 **어레이 프런트엔드 성능 5분 표본**(`storage/collectors/arrayPerf.js` · ‘SAN 스토리지 성능’ 화면 · REST 수집 어레이만 · 실장비 미확인)을 더했다. 이 비교는 그래도 **스위치 포트 트래픽**을 쓴다 — 모든 어레이(SSH 수집 포함)에 같은 기준이고, 화면 문구를 "어레이 측 표본은 SAN 스토리지 성능 화면이 따로 본다" 로 고쳤다.
3. **‘실시간’ 은 수집 주기 단위다** — 주기 하한 1분 + ‘지금 측정’ 버튼. 화면이 열려 있는 동안 자동으로 SSH 를 여는 모드는 기본에 넣지 않았다(④-D — 로그인 시도가 겹쳐 계정 잠금 규칙과 충돌). 행마다 표본 시각을 보여 준다.
4. **못 읽은 값은 0 이 아니다** — 측정 불가 서버(Linux 아님 · 엣지 구버전 회신 · 수집 대기 · 인증 정지)와 시리얼 미대조 어레이는 ‘—’ 로 두고 합에서 빼며 ‘9/10대 측정 합’ 처럼 개수를 쓴다. 측정 불가가 섞인 그룹의 합은 **부분 합**(호박색).
5. **그룹 겹침** — 서버가 여러 그룹에 속하면 그룹 행의 합이 전체보다 클 수 있다(현황 탭과 같은 규칙 · 각주).
6. 마운트별 I/O 는 하지 않는다 — df 의 파일시스템 → 블록 장치(dm · md · 파티션) 대응이 서버마다 달라 틀린 값을 만들기 쉽다. 서버 단위가 어레이 단위와도 같은 눈높이다.
7. ~~베어메탈 I/O 표본은 12시간 이력 DB 에 쌓지 않는다~~ → **정정(요청 3차)**: 추이 차트를 위해 **별도 I/O 시계열 DB** 에 쌓는다(§4.5). 다만 2초 순간 표본을 평균이라 부르지 않는다 — **평균은 누적 카운터 차분**(수집 사이 구간의 진짜 평균)으로 내고, 2초 표본은 **피크의 하한**으로만 쓴다. 12시간 용량 이력 DB 에는 넣지 않는다(용도 · 보존이 다르다).
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

### 4.4 법인별 보기(요청 2차 — 보드 ⑤)
- **칩 줄은 공용 `DeviceFacetBar`(`views/tools/DeviceFacetBar.jsx` · 판정 `deviceFacets.js facetState`)** 를 쓴다 — 캡처의 ‘바로가기’ 칩(`.vc-quicknav` · `.qn-btn` · `.qn-dot`)과 같은 모양이고 스토리지 모니터링 · 증가량 화면이 이미 쓰는 부품이다(‘다른 화면과 동일하게’ = 같은 컴포넌트). 여러 법인 선택 · `✕ 필터 해제` · 주소 `?dc=a,b` 로 북마크. `dcMeta` 로 점(그 법인의 최고 사용률 색)과 숫자(비교 대상 = 베어메탈 서버 + 어레이 수)를 붙인다. 숫자의 뜻은 캡처(조치 필요 VM)와 다르므로 칩 줄 아래 한 줄로 밝힌다.
- **베어메탈 서버에는 지금 법인 축이 없다**(`agent` 뿐 — v2.612 ‘베어메탈 서버는 법인 축이 없다(엣지만)’). 출처를 이 순서로 정한다(순수 함수 `bmstor/corp.js datacenterOfBmServer(server, { collectors, datacenterOfVcenter })`):
  1. 서버 등록 폼의 **‘법인’ 선택(새 필드 `datacenterId` · 선택)** — 스토리지 장비 폼과 같은 DataCenter 목록(`listDatacenters()`). CSV 열 `datacenter`(id 또는 이름 — 저장은 id · 모르는 값은 드라이런 오류). 비우면 기존 유지.
  2. 비어 있고 `agent` 가 있으면 **그 엣지의 법인** — 수집 서버(원격) 레코드의 `vcenterId` → `datacenterOfVcenter()`(법인 · vCenter · 엣지 1:1:1). 응답에 `datacenterSource: 'edge'` 를 실어 화면이 ‘엣지로 추정’ 표지를 붙인다. 수집 서버의 자유 문자열 `datacenter`(이름)는 id 가 아니라 쓰지 않는다 — 이름 대조로 억지 매칭하지 않는다.
  3. 둘 다 없으면 `''` → 칩 ‘(법인 미지정)’(`NONE_DC` 센티널 — SAN 스위치 화면과 같은 규칙). 숨기지 않는다.
- SAN 쪽은 이미 있다 — 어레이 `datacenterId`(등록값), 전송 속도는 **그 법인 스위치만** 합산(`storageSeriesMulti` 에 `groupOf` = 법인 → `series.group`; 어레이 대조 키에 법인을 넣는다 — `storage-summary` 의 `capKey(dc, serial)` 와 같은 이유: 법인별로 볼 때 다른 법인 어레이의 트래픽을 붙이지 않는다).
- 비교 API: `?datacenterId=a,b`(빈 값 = 전체 · `__none__` = 미지정). 법인을 고르면 `bm.groups` 는 **그 법인 서버만으로 다시 합산**(`aggregate(servers.filter(inDc), latest)` — 코어 재사용 · 복제 금지)하고 표의 ‘법인 · 그룹’ 열이 ‘서울 2/3대’(그룹 전체 중 이 법인 대수)를 말한다. 어레이는 그 법인 것만. 여러 법인이면 법인마다 합계 행(SAN 스위치 split 규칙). 법인 칩의 개수 · 점은 **필터 전 전체**로 계산해 응답에 `datacenters: [{id,name,servers,arrays,maxPct}]` 로 싣는다(화면이 다시 세지 않는다).
- 그룹과 법인을 섞지 않는다 — 그룹은 관점별 묶음(최대 3개) · 법인은 서버당 하나. 데모 시드의 ‘서울’ · ‘프랑크푸르트’ 는 그룹 이름이므로 데모 서버에 `datacenterId` 를 따로 넣는다(데모 법인 = 데모 vCenter 의 DataCenter).
- 범위 계정은 이 화면에 오지 않는다(403 — 전체 범위 관리자 전용)이므로 법인 필터와 scope 교집합 문제는 없다. 비-관리자 상세 계정 가림도 해당 없음(주소를 싣지 않는다).

### 4.5 베어메탈 I/O 시계열 DB(요청 3차 — 보드 ⑥의 바탕 · 새 파일 `bmstor-io.db` · `bmstor/ioDb.js`)
- **왜 따로인가**: 12시간 용량 이력(`bmstor-history.db`)은 하루 2회 · 5년 보존이고, I/O 는 수집 주기(1~1440분)마다 · 수 일~2년 보존 · 집계 표가 필요하다. 보존 · 정리 주기가 다르면 한 DB 에 섞지 않는다(SAN 포트 사용량 DB 가 따로 있는 것과 같은 이유).
- **한 행 = 서버 × 수집 1회**(`io_raw`): `server_id · ts · rd_sectors · wr_sectors · io_ms`(누적 카운터 합 — 통짜 디스크만) · `avg_rd_bps · avg_wr_bps`(직전 행과의 **카운터 차분 ÷ 경과** — 첫 행 · 카운터 감소(재부팅) · 공백이 주기 ×2 를 넘으면 null) · `inst_rd_bps · inst_wr_bps · busy_pct`(수집 시점 2초 표본) · `disks`. 엣지 위임 서버의 값도 **중앙이 적재한다**(결과가 중앙에 닿을 때 — 엣지에 DB 를 두지 않는다 · 엣지 시각은 수신 시각으로 자른다).
- **적재 규약(perf-db.md)**: 결과 묶음 하나를 **트랜잭션 1개**로(수백 대 × 1행) · `ts` 단독 인덱스 + `(server_id, ts)` · prune 은 `(++tick % 20) === 0` 에 `chunkedDelete`(첫 틱 금지) · `openSqlite` 공유 open · 실패해도 수집은 산다(available=false 를 화면이 말한다). 직전 카운터는 메모리 Map(server_id → {ts, rd, wr})으로 들고 기동 시 각 서버의 마지막 행에서 되살린다(MAX(ts) 단독 — 집계 함수 2개 한 문장 금지).
- **집계 표**: `io_r15(server_id, b, n, sum_avg, max_inst, sum_rd, sum_wr, max_busy)` 와 `io_r1h(...)` — SAN `perfRollup.js` 의 G15 · G1H · `planSegments` 를 **그대로 가져다 쓴다**(복제가 아니라 import). 평균 = 구간 평균(avg_*)의 평균, 피크 = 2초 표본(inst_*)의 최댓값. 백필은 SAN 과 같은 시간 기준 양보(`runRollupBackfill` 모양).
- **보존(env · 기본)**: 원시 `BMSTOR_IO_RAW_DAYS=3` · 15분 `BMSTOR_IO_R15_DAYS=31` · 1시간 `BMSTOR_IO_R1H_DAYS=730`. 상한 산수(1,000대 · 주기 1분 — 최악): 원시 4.3M 행 · 15분 3.0M · 1시간 17.5M(2년) — SAN 포트 사용량 DB(운영 약 1억 행 추정)보다 작다. 주기 10분(기본)이면 원시 0.43M.
- **조회**: 실시간 1시간 = 원시 표(해당 서버만 · 최대 8대 · `(server_id, ts)` 인덱스) · 24시간 = 15분 표 · 7일 · 30일 = 1시간 표. 조회 조각 + `createYielder`(요청 경로 큰 집계 규약). 어느 표에서 읽었는지 `source` 로 돌려준다.
- 데모(mock): 서버 해시 기반 수식으로 원시 · 집계를 합성한다(SAN `demoPerfSynth.js` 와 같은 방식 — 적재하지 않고 계산).

### 4.6 차트 API — `GET /api/tools/bm-storage/io/series?range=1h|24h|7d|30d&metric=total|read|write&ids=bm:<id>,san:<serial>,bm:all,san:all[&datacenterId=…][&to=<ts>]`
- 게이트 · 주소 규칙은 compare 와 같다. `ids` 는 최대 8 + 합계 2(`bm:all` · `san:all`). 응답 `{ buckets, bucketMs, source, series: [{ id, kind:'bm'|'san', name, avg: (number|null)[], peak: (number|null)[], unit:'bytesPerSec', sampleMs(점 간격 — bm 수집 주기 · san 포트 수집 주기), basis:{ avg:'counter'|'sample', peak:'sample2s'|'sample5m' } }], retention:{ rawDays, r15Days, r1hDays } }`.
- SAN 계열은 `storageSeriesMulti(스위치 id, { hours|from/to, groupOf })` 의 `sum` · `peak` 배열을 어레이 시리얼로 골라 그대로 싣는다(이월 · 부분 합 규칙 그대로 — 부분 합 버킷은 null). `san:all` 은 `trafficTotal.sumArrayTraffic` 의 합계 줄.
- `bm:all` 은 고른 법인(없으면 전체)의 측정 서버 합 — 버킷마다 **모든 측정 서버에 값이 있을 때만** 더하고 아니면 null + `partial` 로 센다(SAN 포트 합과 같은 규칙 — 모르는 것을 0 으로 더하지 않는다).
- **막대 비교**(보드 ⑥ 구역 1)는 같은 응답의 계열별 `avgTotal(평균의 평균) · peakTotal(피크의 최댓값) · points` 로 그린다 — 호출 1회. 장비가 100대를 넘으면 평균 상위 N(기본 30)만 싣고 `omitted` 를 밝힌다.
- 실시간 1시간은 **30초마다** 다시 읽는다(고른 ≤8 계열 · 원시 표 인덱스 조회 · SAN 쪽은 heavyQuery 기억 TTL 안이면 같은 결과) — 무거운 API 15초 폴링 금지 규칙 안이다. 24시간 이상은 마운트 1회 + 버튼 + ◀ 이전(창 계산은 `views/tools/xferSpeedText.js` 의 `maxBackOf` · `windowEndOf` 공용 — 세 번째 쓰임이므로 공용 모듈로 뽑는다).
- 차트는 기존 의존성 **recharts**(`VmMetrics.jsx` 가 쓰는 것)로 그린다 — 실선 평균 · 점선 피크 · 결측은 끊긴 선 · 툴팁에 두 값 · y 축 로그 눈금 토글(서버와 어레이가 10배 차이일 때) · 400px 에서는 높이 240 · 범례 접힘.

## 5. 화면(IA) — 아트보드 5장

| 보드 | 파일 | 내용 |
|---|---|---|
| ⓪ | `Current.dc.html` | **지금** — 세 화면(베어메탈 현황 · 스토리지 모니터링 · SAN 스토리지 사용량 분석)에 값이 흩어져 있고 베어메탈 전송 속도는 없다 |
| ① | `Main.dc.html` | **1440** — 베어메탈 스토리지 › **SAN 비교** 탭(`#/tools/bm-storage/compare`). 위→아래: 하위 탭(현황 · SAN 비교) · 설명 + 상태 줄 · 버튼(지금 측정 · 새로 고침 · CSV) · 도구 모음(SAN 종류 칩 · 전송 속도 범위 1시간/24시간/7일 · 평균/피크) · **비교 요약**(용량 사용률 ↔ · 전송 속도 ↔ · 기준 · 신선도) · **비교 표**(합계 2행 고정 + 그룹 7 + 어레이 4 · 사용률 높은 순 · STable 정렬) · **한눈에**(사용률 막대 0~100 · 75% 선 · 전송 속도 막대 최댓값 대비) · **서버별 디스크 I/O** 표(읽기 · 쓰기 · 합 · 바쁨(가장 바쁜 디스크) · 표본 · 상태) · 알아 둘 것 4줄 |
| ② | `Narrow.dc.html` | **400** — 같은 화면. 요약은 세로, 비교 표는 행 카드, 서버별 I/O 는 접힘 |
| ③ | `States.dc.html` | 상태 6종 — SAN 어레이 없음 · 포트 사용량 수집 꺼짐 · 시리얼 미대조 · 베어메탈 측정 불가 4가지 · 측정 중 · 403 |
| ④ | `Alt.dc.html` | 대안 — A 탭(추천) vs B 새 특수 기능 ‘스토리지 비교’ · C 주기 하한 1분 + 버튼(추천) vs D 화면이 열려 있는 동안 자동 1분 측정 |
| ⑥ | `Chart.dc.html` | **장비별 디스크 성능 차트(요청 3차)** — ① 의 ‘한눈에’ 와 ‘서버별 디스크 I/O’ 사이 구역. 구역 1 **막대 비교**: 장비(서버 · 어레이)마다 평균 막대 + 피크 표지(노란 ▌) · 평균 높은 순 · 범위(실시간 1시간 · 24시간 · 7일 · 30일) · 지표(읽기+쓰기 · 읽기 · 쓰기 — SAN 은 합계만) · 대상(서버 · 어레이 / 그룹 · 어레이) · 측정 없음은 ‘—’ 와 사유. 구역 2 **추이**: 장비 선택 칩(기본 베어메탈 전체 · SAN 전체 + 고른 장비 · 최대 8) · 실선 평균 · 점선 피크 · 실시간 1시간은 30초 갱신(베어메탈 점 1분 · SAN 점 5분) · 24시간 15분 집계 · 7일 · 30일 1시간 집계 · ◀ 이전 / 최신 · 툴팁 · 로그 눈금 토글. 아래 ‘두 값의 기준’ 카드가 평균(카운터 차분 vs 5분 표본)과 피크(표본 최댓값 = 하한)의 뜻을 말한다 |
| ⑤ | `Corp.dc.html` | **법인별 보기(요청 2차)** — ① 의 도구 모음 아래 ‘법인 바로가기’ 칩 줄(공용 DeviceFacetBar · 점 = 최고 사용률 색 · 숫자 = 비교 대상 수 · 고른 법인은 파랗게 · 여러 개 선택). ‘서울’ 을 고른 화면: 요약 · 비교 표가 그 법인으로 좁혀지고 베어메탈 그룹은 그 법인 서버만으로 다시 합산(‘서울 2/3대’). 아래 패널이 **베어메탈 서버의 법인 출처 4규칙**과 서버 폼의 새 칸 ‘법인(선택 · 비우면 엣지의 법인)’ 을 보인다. ① · ② 에도 같은 칩 줄을 넣었다 |

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
| 7 | 베어메탈 법인 축(요청 2차) | 서버 폼 ‘법인’ 선택(새 필드) → 비우면 엣지의 법인 → ‘(법인 미지정)’ | 폼 필드 없이 엣지 법인만(중앙 직접 서버는 전부 미지정) / 그룹 이름을 법인으로 간주(권하지 않음 — 그룹은 관점별 묶음) |
| 8 | 차트의 ‘실시간’(요청 3차) | 수집 주기 점(최소 1분) · 30초 갱신 · ‘지금 측정’ | **2단계 후보** — 장비 1대를 고르면 SSH 세션 하나로 2초마다 diskstats 를 흘려 보는 모드(iostat 처럼 · 최대 5분 · 관리자별 1건 · 엣지 위임 서버는 엣지가 대행 — 잡 큐 + 중계가 필요해 별건 설계) |
| 9 | I/O 보존 기간 | 원시 3일 · 15분 31일 · 1시간 2년(env) | 더 짧게(디스크 절약) / 원시를 7일로(주기 1분이면 1,000대에 10M 행 — 권하지 않음) |
| 10 | 차트 피크의 뜻 | 표본 최댓값(베어메탈 2초 · SAN 5분) — 화면이 ‘하한’ 이라고 말한다 | 피크 열을 빼고 평균만(정직하지만 요청과 다름) |

## 7. 구현 순서(컨펌 뒤 · 규칙상 Opus)

1. `bmstor/diskstats.js`(순수 — parse · rate) + `collect.js` 명령 1개 추가 + `poller.js sanitizeBmResult`(폴링 · PUSH 공용) + `agent/bmstorWorker.js` 회신 필드 + `agg.js` io 합 + 데모 I/O. 테스트 `server/test/bmstorIo29xx.test.js`(파서 · 중복 장치 제외 · 카운터 역행 · 정제 변이 · PUSH 정제 · 부분 합).
2. `bmstor/compare.js`(순수 — 시리얼 대조 · 요약 계산 · 법인 칩 개수) + `bmstor/corp.js`(서버 법인 출처) + 등록부 `datacenterId` 필드 · CSV 열 + `routes/api/bmstor.js` compare 라우트(`datacenterId` 필터) + 테스트(범위 계정 403 · 주소 미포함 · 미대조 사유 코드 · 법인 출처 3규칙 · 법인별 재합산).
3. 웹 `views/tools/BmSanCompare.jsx` + `bmSanCompareText.js`(fmtBps · 차이 · 배율 · 기준 문장 · 사유 코드→문장 · ‘서울 2/3대’) + `DeviceFacetBar` 재사용(법인 칩 · `?dc=`) + `BmStorageTool.jsx` 하위 탭(`useHashTab`) + 서버 폼 ‘법인’ 선택 + vitest.
3-b. (요청 3차) `bmstor/ioDb.js`(원시 · 15분 · 1시간 표 · 적재 트랜잭션 · prune · 백필 — `sanswitch/perfRollup.js` import) + `bmstor/ioSeries.js`(순수 — 카운터 차분 평균 · 공백 · 재부팅 null · 합계 줄 부분 합) + `routes/api/bmstor.js` `io/series` + 데모 수식 + 테스트(차분 · 재부팅 · 공백 · 롤업 평균/피크 정의 · 부분 합 null · ids 상한 · 403). 웹 `views/tools/BmIoChart.jsx`(recharts · 막대 비교 + 추이) + `bmIoChartText.js`(기준 문장 · 점 간격 · 로그 눈금 · 창 계산 공용화) + vitest. 상한 산수(§4.5)는 테스트가 고정한다.
4. 문서 — `docs/rules/storage.md` 항목 · `specialToolsList.js` 설명에 ‘SAN 비교’ · API 문서 생성기 · 릴리스 노트 · 버전.
5. 검증 — 변경 모듈 테스트 → 빌드 → Chromium 1440/400(admin) → 전량 verify(백그라운드) → PR → CI → 머지 → 릴리스 → `versions.json`.

## 8. 구현 기록(2026-11-09 · v2.956.0 릴리스 — 코드 · 테스트 표지 v2.915)

번호: 설계 때 main 이 v2.914.0 이었는데 구현을 마칠 때 main 이 v2.955.0 까지 갔다(다른 세션의 릴리스) — 릴리스는 **v2.956.0**, 코드 · 테스트 · 이 문서의 표지는 v2.915 그대로(feature-usage 선례).

시안과 **다르게 한 것**(이유와 함께):
1. **합계 행은 표 맨 아래**(시안은 맨 위) — 공용 `STable` 이 `data-pin` 행을 정렬에서 빼고 맨 아래에 고정한다(저장소 규약 · 다른 표와 같게).
2. **‘피크’ 열을 ‘전송 속도’ 칸의 둘째 줄로** — 1440 에서 열이 넘쳐 가로 스크롤이 생겼다(Chromium 실측). 정보는 같다.
3. **법인 · SAN 종류 칩은 공용 `DeviceFacetBar`**(🏢 법인 줄 + 🗄 SAN 종류 줄 + 검색) — 시안의 ‘법인 바로가기’ 한 줄 대신 스토리지 모니터링과 같은 부품. 검색은 표 · 서버별 I/O 표를 거른다.
4. 실시간 1시간 재조회는 공용 `usePolling`(30초 · 403 이면 멈춤 · 숨은 탭이면 쉼). 24시간 이상은 1시간 간격(사실상 마운트 1회 + 버튼).
5. **데모(mock)**: PowerMax · VMAX 데모 스냅샷의 시리얼을 SAN 데모 포트 이름(`SYMMETRIX::<시리얼>`)과 맞췄다(`sanDemoArraysFor`) — 데모에서 어레이 4대 중 3대가 대조되고 1대(VMAX-PEK-01)는 ‘시리얼 미대조’ 상태를 그대로 보인다. 데모 베어메탈 I/O 는 수식(`demoBmIoSeries` · hpc-node-03 은 ‘엣지 구버전’ 측정 불가).

**정정(§3-7)**: I/O 표본을 이력에 쌓지 않는다고 했던 것을 3차 요청(차트)으로 뒤집었다 — 별도 `bmstor-io.db`, 평균은 카운터 차분, 피크는 표본 하한(§4.5).

검증(표준): `server/test/bmstorIo2915.test.js` 16건(파서 · 속도 · 차분 · 법인 출처 · 격자 · 합 · 비교 조립 · agg · CSV · 원천 스윕 · 정제 변이 · 등록부 · DB 적재/집계/순위 · 라우트 403/주소 없음/칩/시계열) + 웹 `bmSanCompareText.test.js` 8건 · `bmIoChartText.test.js` 5건 · Chromium 1440/400(콘솔 오류 0 · 가로 넘침 0 · 법인 칩 · 24시간 · 피크 · 로그 눈금 · 필터 해제 · 현황 탭 · 서버 폼) · 전량 verify. 반증 에이전트 · A/B 는 쓰지 않았다(표준).

발견 · 함께 고친 것: 엣지 PUSH 회신이 정제 없이 latest 에 들어가던 간극(폴링 회신만 정제) — `sanitizeBmResult` 하나로 두 경로 통일. 테스트의 정적 import 가 개발용 `server/config/` 에 테스트 서버를 쌓던 문제(실측 12대 — 지웠다) — 테스트는 전부 동적 import.

## 9. 비교 세트(2026-11-10 · v2.962.0)

요청(2026-11-10 17:01 KST): "비교를 다양하게 하는 기능 추가 — 1. SAN 스토리지 A / SAN 스토리지 B 2. 가 법인의 SAN 스토리지 A / 가 법인의 베어메탈 스토리지 AA 3. 이런 식으로 다양하게 각각의 스토리지의 성능을 비교".
컨펌: **바로 구현**(새 시안 없음 — 기존 화면 문법을 따른 새 하위 탭) · 지표 **IOPS · 응답 시간까지** · 검증 **표준**.

- 화면: 베어메탈 스토리지 › **비교 세트** 탭(`#/tools/bm-storage/set/<ids>` — 고른 대상이 주소에 실려 북마크 · 공유) · `views/tools/BmCompareSet.jsx` + 문구 `compareSetText.js`.
  대상 2~4개(A~D)를 **종류를 섞어** 고른다 — SAN 어레이(`san:<시리얼>`) · 베어메탈 서버(`bm:<id>`) · 베어메탈 그룹(`bmg:<이름>`) · 법인 베어메탈 합계(`bmc:<법인 id>`).
  첫 대상(A)이 기준이고 나머지 칸에 ‘A 대비’(용량 %p · 지표 배율). 빠른 세트(SAN ↔ SAN · 같은 법인 SAN ↔ 베어메탈 · 그룹 ↔ 그룹) · ‘A로’ · 링크 복사.
  비교 표(STable — 행 = 지표 · 열 = 대상) + 지표별 추이 차트 2×2(실선 평균 · 점선 피크 · 색 = 칸) + **세로축 선형/로그**(대상끼리 20배 넘게 차이 나면 ‘로그 축으로’ 버튼).
- API: `GET /tools/bm-storage/compare-set?ids&range`(adminOnly · fullScopeOnly — 같은 탭의 다른 API 와 같은 게이트) — 대상마다 용량 · 지표 4종(tput · iops · lat · busy) × {avg[], peak[], avgTotal, peakTotal, source, reason}. 주소(host)는 싣지 않는다.
  - 베어메탈: `/proc/diskstats` 의 완료 I/O 수(열 3 · 7)와 소요 시간(열 6 · 10)을 더 읽는다 — **IOPS = 완료 수 차분 ÷ 경과**, **응답 시간 = 소요 시간 차분 ÷ 완료 수 차분**(I/O 가중 — iostat await 와 같은 뜻). 기존 `bmstor-io.db` 는 `ensureColumns`(PRAGMA → ALTER TABLE ADD COLUMN)로 빠진 열만 더한다.
  - SAN: 전송 속도 = 스위치 포트(v2.956 과 같은 시리즈) · IOPS · 응답 시간 · 바쁨 = **어레이 측 5분 표본**(스토리지 DB 의 FE 노드 부하 — REST 로 수집하는 PowerMax · VMAX · PowerStore · Unity 만 · **실장비 미확인**). SSH 장비는 사유 `fe-ssh` 로 ‘—’.
  - 묶음(그룹 · 법인 합계)은 **측정된 서버 전부에 값이 있는 칸만 더한다**(부분 합 금지) · 바쁨은 가장 바쁜 서버 · 응답 시간은 I/O 가중(Σ소요 ÷ ΣI/O).
- **격자 결함 고침(v2.956 — 코드 읽기로 발견, 실데이터 미관측)**: 1시간 시계열이 1분 격자였는데 베어메탈 수집은 기본 10분 — 값이 10칸에 하나라 `dot={false}` 선이 그려지지 않을 수 있었다. 격자를 표본 간격보다 잘게 만들지 않는다(`compareSet.gridMs`) · 재격자는 합이 아니라 평균/최대.
- **화면 확인에서 발견 · 고친 것**: ① 응답 시간 평균이 피크보다 크게 보였다(평균 3.0 ms · 피크 2.6 ms) — 공용 `ioSeries.summarize` 가 평균을 정수로 반올림(B/s · IOPS 용). 비교 세트는 평균을 반올림 없이 다시 낸다(회귀 테스트). ② IOPS 세로축 눈금 ‘48,709 IOPS’ 가 축 폭에서 두 줄로 접혔다 → ‘48.7k’. ③ 대상 칸의 ‘법인 베어메탈 합계’ 배지 · ‘A로’ 버튼 줄바꿈 → 말줄임. ④ 같은 사유 문장이 한 열에 8번 반복 → 바로 위 칸과 같으면 생략(마우스를 올리면 그대로).
- 검증(표준): 서버 `server/test/bmCompareSet2962.test.js`(diskstats IOPS · 응답 시간 · 구간 평균 · 정제 · DB 이전 · 집계 · 순수 함수 · FE 합/최대 · 라우트 403 · 주소 없음 · 격자) + `bmstorIo2915.test.js` 갱신 3곳 · 웹 `compareSetText.test.js` · Chromium 1440/400(오류 0 · 가로 넘침 0 · 빠른 세트 · 대상 추가 · 24시간 · ‘A로’ · 빼기 · 세트 링크로 열기 · 로그 축).
