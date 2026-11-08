# 설계: SAN 스토리지 사용량 · 트렌드 — 실시간 · 트렌드 · 디렉터(VMAX · PowerMax) · 컨트롤러(PowerStore · Unity)별

작성 2026-11-08 (main v2.914.0 기준 · 브랜치 `claude/festive-planck-vy0dg3`) · 상태 **시안 3차 — 결정 8개 반영 · 구현 착수 대기(남은 확인 §6)** ·
시안 캔버스: https://claude.ai/artifact/ApZK6HEzp3yjk6h6LKbYxk (아트보드 7장 — ① 현황 1440 · ② 어레이 상세 1440 · ③ 디렉터 · 컨트롤러 벤더별 · ④ 400px · ⑤ 상태 8종 · ⑥ 성능 점검 탭 · ⑦ 분류 · 매핑 탭).
**2차 보강(19:31~ KST)**: 사용자가 '디렉터별 · 컨트롤러별 성능' 을 다시 요청해 **어레이 측 성능(busy% · CPU · IOPS · 응답 시간 · 큐 깊이)을 2단계에서 이번 범위로** 올렸다 — ② 아래 패널 실값 · ③ 벤더 카드 실값 + API 확인 표 · ⑥ 판정표 신설.
**3차(19:42~ KST · 사용자 답 8개)**: ① **독립 도구 `san-storage` + 독립 메뉴** '스토리지 › SAN 스토리지 성능'(기존 SAN 스위치 화면의 '스토리지 사용량 분석' 모달은 이 메뉴로 보내고 지운다) ③ 분류 · 디렉터 매핑 **탭(⑦)** 신설 ⑥ 1년 보기 포함 ⑦ 표준 검증 ⑧ 팔레트 4색 `:root` 토큰 추가. ④ 캡처 방법은 `CAPTURE-GUIDE.md` · ⑤ 벤더 · 컨설팅 권장 기준은 §10(점검 기본값을 **벤더 문서 값만**으로 채움) · 추가 기능 · 문서 검토는 §12.
이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스(HTML 프로토타입 — 복사 대상이 아님). **법인 · 스토리지 · 스위치 이름(KR1 · PL1 · PMAX-KR1-01 · SW-KR1-A1 …)과 수치는 전부 가상**이다.
색 · 글자는 `web/src/styles.css` `:root` 토큰과 `.san2-*`(SAN Switch v2) · `components/vmperf/vmPerf.css` 그대로. 차트 시리즈 4색(`#3987e5 #d95926 #199e70 #c98500`)만 dataviz 검증기(다크 표면 `#141b2d`)를 통과한 참조 팔레트다 — 기존 `LINE_COLORS` 8색은 다크 밝기 대역 검사에서 FAIL 이라 §6 질문 7 로 둔다.
규칙(2026-11-03 '기억해'): 설계는 Fable + Claude Design 시안 → **컨펌 뒤** Opus 구현. §2 는 이 세션(Fable)이 코드로 확인한 사실이고, **목 서버 캡처('지금' 보드)는 만들지 않았다**(시안 시간을 줄이려고 — 기존 화면은 §2 표로 대신한다).

## 1. 요구(사용자 2026-11-08 17:15 · 17:19 KST)

> "SAN 스위치 기능에 추가해서 SAN 스토리지 실시간 사용량 및 트렌드 볼 있는 기능 만들어줘 시안부터 만들어서 보여줘"
> "SAN 스토리지 성능 점검 하면서 vMAX, powremax 디렉터별 성능도 볼 수 있고, power store, 유니티 등의 컨트롤러별 성능도 볼 수 있게 해줘"

## 2. 지금 코드에서 확인한 것(설계의 근거 — 17:15~17:30 KST)

| 사실 | 위치 |
|---|---|
| 포트 사용량은 스위치 `portperfshow` 를 수집 주기(기본 5분 · 하한 1분 · 상한 6시간)마다 `sampleSeconds`(기본 8초) 받아써 **포트당 1표본(송수신 합 바이트/초)** 을 저장한다. 원본 90일 · 15분 집계 31일 · 1시간 집계 2년(설정값) | `server/src/sanswitch/perfSettings.js LIMITS` · `perfPoller.js` · `perfDb.js`(`pp_15m` · `pp_1h`) |
| `port_meta` 에 포트별 **연결 장비 심볼릭 이름 · WWN · 속도('32G') · 포트 종류**가 있다. 이름 예 `SYMMETRIX::000497700230::SAF-1d 4::FC::…` — 앞 두 조각이 어레이 키(`storageKey`), 둘째 조각이 시리얼(`arraySerialOf`), `::` 가 있으면 어레이 · 없으면 호스트(`endpointKind` — **추정**) | `perfDb.js:769~956` |
| **셋째 조각이 디렉터 · 컨트롤러 + 포트**다(PowerMax `FA-1D 4` · 목 PowerStore `NodeA FC0` · 목 Unity `SPA FC0`). 지금은 **아무 데서도 읽지 않는다** — 어레이 단위로만 합친다 | `perfDb.js storageSeriesMulti` · `mock/demo/sanswitch.js:43·47·50` |
| 어레이 합산 시계열(팹 A/B 합침 · 이월 한계 = 주기 × 2 · 부분 합은 null + `partial` · 전부 비면 null) · 법인 분리 · 종류 필터 · 등록 스토리지 용량 매칭(시리얼 일치 때만) — **트렌드 표(15분 · 1시간)로 계산** | `perfDb.js storageSeriesMulti` · `routes/api/sanSwitch.js /tools/sanswitch/perf/storage-summary` |
| 전체 합계 카드(`trafficTotal.js sumArrayTraffic` — 보고 멈춤 held · 없어진 시리즈 retired) · 1시간/24시간/7일 · 60초 폴링 · 'off / unavailable / empty / ok' 판정 | `SanSwitchV2Parts.jsx TrafficCard` · `sanSwitchViewText.js trafficSummary` |
| 기존 '스토리지 사용량 분석' 은 **모달(1180)** — 평균/피크 · 법인 분리 · 상위 8 선 · 표 200행 · 용량 열. 장비 상세의 '사용량 분석' 탭 · '포트 사용량(📊)' 탭(1일/7일/1달 · 이전 기간 · 히트맵 · 유휴 · 편중 `IMBALANCE_RATIO 1.4` · 포화도 `capBpsOf(speed)`) | `SanSwitchTool.jsx DcStoragePerf` · `SanPortUsage.jsx` · `sanswitch/portUsage.js` |
| '사용량이 왜 비어 있나' 판정(DB 불가 → 기간 밖 → REST → 엣지 미보고/꺼짐/첫수집 → 중앙)은 서버 `perfDiag` 하나 · 문구는 웹 `sanPerfDiagText` 하나 | `sanswitch/perfDiag.js` · `views/tools/sanPerfDiagText.js` |
| 스토리지 모듈의 **어레이 측 성능**: PowerStore 만 클러스터 전체 IOPS · 대역폭 · 지연 **최신 1점**(`extra.perf`). PowerMax(Unisphere REST) · Unity 는 용량 · 상태만 — **디렉터 · 노드 · SP 별 성능은 어느 벤더도 수집하지 않는다** | `storage/collectors/powerstore.js:176~186` · `powermax.js` · `unity.js` |
| 조회 라우트 게이트는 `toolsPerm + fullScopeOnly`(SAN 은 vCenter 범위 밖) · 비-admin 은 관리 주소 가림(`maskDeviceAddress` · `addressHidden`) · 무거운 조회는 `heavyQuery`(기억 TTL = 수집 주기 · 줄 multi/single · 취소 전달) | `routes/api/sanSwitch.js:882~1070` |
| 도구 키 `#/tools/sanswitch` 는 바꾸지 않는다 · 하위 탭은 해시(`useHashTab`) 선례가 있다(Bareos · Capacity) · 구간 이동(◀ 이전 · 슬라이더 · 날짜로 이동)은 전송 속도 · VM 성능(v2.911 `vmPerfText`) 선례 | `hooks/useHashTab.js` · `components/vmperf/` |

규모(설계 제약): 28 법인 · 스위치 수십 대 × 포트 128~768 · RTT 800ms+ 법인은 엣지가 표본을 중계(중앙은 어레이 · 스위치에 직접 묻지 않는다) · 집계 조회는 1회 수백 ms(합성 2,065만 행 실측 24시간 0.62초) · 주기 · 상한 숫자를 화면에 박지 않는다 · 1440/400.

## 3. 정직하게 밝혀야 하는 것(시안 문구에 반영)

1. **'실시간' 은 수집 주기 단위다** — 기본 5분 · 설정 하한 1분. 화면은 60초마다 다시 읽지만 새 표본은 주기마다 온다. 초 단위 실시간은 `portperfshow` 세션을 상시로 붙잡아야 해서 하지 않는다(세션 규약). 상단 알약이 '마지막 표본 시각 · 주기(API 값)' 를 말한다.
2. **값은 송수신 합 처리량**(바이트/초 → Gb/s)이다. 읽기/쓰기 · IOPS · 지연은 스위치가 모르는 값이라 1단계에 없다(2단계 — 어레이 측).
3. **회선 사용률 = 송수신 합 ÷ 연결 포트 속도 합**(포트 사용량 탭 '포화도' 와 같은 `capBpsOf`). FC 는 전이중이라 이론상 200% 까지 가능하다 — 문구에 적고, 속도를 모르는 포트는 분모에서 빼며 개수를 밝힌다.
4. **디렉터 · 컨트롤러는 스위치가 받은 심볼릭 이름에서 읽는다**(새 장비 접속 없음). PowerMax 꼴(`FA-1D 4` · `SAF-1d 4`)은 현장 포맷이 perfDb 머리말에 있지만 **PowerStore(`NodeA FC0`) · Unity(`SPA FC0`) 는 목 서버 형식**이고 실장비는 확인하지 못했다. 못 읽으면 '(구분 못 함)' 한 그룹 + 포트별 보기 + **관리자 수동 매핑**(추정하지 않는다). Unity 는 조닝 별칭(`Unity_SPA0_p8` — 현장 별칭 규칙)에서 한 번 더 찾는다.
5. **어레이 측 디렉터 · 노드 · SP 성능(busy% · CPU · IOPS · 응답 시간 · 큐 깊이)은 새 수집이고 이번 범위다**(2차 — 사용자 재요청). API 는 2026-11-08 웹 문서로 확인했다(§4.2 표 · 출처 §9) — PowerMax `FEDirector` 지표 6종은 2차 자료(Dell Splunk 애드온 · Dynatrace · Dell KB) · PowerStore 는 엔터티 이름만 개발자 가이드 열거형으로 확인(응답 필드 미확인) · Unity 는 백서 · 지원 스크립트의 경로. **세 벤더 모두 실장비 응답은 아직 보지 못했다.** 구현은 '장비가 주는 지표 목록을 먼저 읽고 없는 것은 — + 사유' 구조로 짜고, 응답 캡처를 받으면 파서를 그 모양에 맞춘다.
5-1. **성능 점검(⑥)의 임계값을 지어내지 않는다** — busy · 응답 시간 · 큐 깊이 · CPU 의 기본 임계값은 **비워 두고**(판정 '?' · 값은 표시) 관리자가 설정하면 판정한다. 편중 · 포화의 상수는 포트 사용량 탭의 기존 값. '팹 비대칭(30%)' · '보고 대조(30%)' 는 새 규칙의 **제안값**이라 §6 질문 5 로 묻는다.
6. 편중 판정은 포트 사용량 탭 규칙 그대로(그룹 평균 0.5 Gb/s 이상 · 멤버가 평균의 1.4배 이상 — 상수는 API 로 내려 화면에 박지 않는다) · **24시간 평균**으로 판정(한 칸 쏠림은 흔하다) · 원인을 단정하지 않는다.
7. '7일 대비' = 이번 24시간 평균 ÷ 지난 7일 하루 평균(둘 다 부분 합 제외) · 비교 구간에 값이 6시간 미만이면 '—'(v2.913 기능 사용 현황의 '직전 기간 전부 있을 때만' 교훈과 같은 방향).
8. 목록의 '지금 합계' 와 기존 트래픽 카드의 '지금' 은 **같은 함수**(`sumArrayTraffic`)여야 한다 — 다르면 결함(테스트가 같은 입력으로 대조).

## 4. 데이터 · 서버

### 4.1 1단계 — 기존 집계의 확장(새 장비 접속 없음)
- **순수 모듈** `sanswitch/directorOf.js`: 심볼릭 이름 → `{ vendor:'powermax'|'powerstore'|'unity'|null, group:'FA-1D'|'Node A'|'SPA'|null, port:'4'|'FC0'|null, confidence:'name'|'alias'|'manual'|'none' }`. 표 §3-4 의 규칙 · 테스트가 벤더별 예시와 평평한 이름을 고정.
- `perfDb.storageSeriesMulti` 응답에 **포트별 시리즈**(`ports[].{deviceId, port, speed, director, avg[], peak[]}`)를 선택적으로 싣는다(`withPorts:true` 일 때만 — 법인 합산의 기본 응답 크기를 늘리지 않는다). 디렉터 합산 · 팹 합산은 **화면이 같은 응답에서** 묶는다(보기 전환이 호출을 늘리지 않음).
- `GET /tools/sanswitch/perf/storage-list?datacenterId=&kind=array` — 목록 ① 용 한 번 호출: 어레이마다 `now`(주기 안에서 팹 A/B 다 모인 마지막 15분 칸) · `util`(§3-3) · `spark1h`(60초 칸 60개 — 기존 1시간 조회) · `avg24h · peak24h · prev7dAvg · delta7d` · `directors[]`(그룹 · 포트 수 · 24시간 평균 · 배수) · `imbalance` · `capacity` · `state`(⑤ 8종 코드). 내부는 `storageSeriesMulti` 2회(1시간 · 7일 — 둘 다 `heavyQuery` 기억 · `lane:'multi'`) + `latestSampleTs`. 60초 폴링은 기존 트래픽 카드와 같은 `usePolling`(90초 · 재시도 0).
- `GET /tools/sanswitch/perf/storage/:key?datacenterId=&hours=|from&to&withPorts=1` — 상세 ② 용. `:key` 는 어레이 키(`SYMMETRIX::000197900123`) URL 인코딩 · 법인은 쿼리(같은 어레이가 두 법인에 보이는 분리 보기 유지). 응답에 `bucketMs · source(원본/집계) · computedAt · cacheTtlMs · partialBuckets · retention{raw15m:31일, rollup1h:설정값}`.
- 요일 × 시간 히트맵은 7일(또는 30일) 1시간 칸 응답을 **화면이 접는다**(포탈 시간대 `DAY_OFFSET_MIN`) — 서버 호출 없음.
- CSV 는 화면이 받은 계열로 만든다(서버 호출 없음 · 결측은 빈 칸 · 파일명 `san-storage_<키>_<기간>_<날짜>.csv`).
- 수동 매핑 저장소 `sanswitch/directorMap.js`(`CONFIG_DIR/sanswitch-director-map.json` — 관리자 전용 PUT · 원자 쓰기 · 손상 보존 · 자격증명 아님 · 감사 로그). 키 = `어레이키|deviceId|port` → `{ group, note, by, at }`. '어레이로 지정'(endpointKind 재정의)도 같은 파일.
- 게이트: 조회 `toolsPerm + fullScopeOnly` · 수동 매핑 `adminOnly + fullScopeOnly` · 비-admin 응답은 스위치 주소 가림(`addressHidden`) 그대로 · `memoJson` 은 쓰지 않고 `heavyQuery` 기억만(기존 형제 라우트와 같은 규약).

### 4.2 어레이 측 — 어레이가 보고하는 디렉터 · 노드 · SP 성능(새 수집 · 이번 범위)
- **법인 로컬에서 돈다**(2026-11-01 규칙): 엣지의 스토리지 수집기가 읽고 요약(최신 1점 + 15분 평균)을 push · 중앙은 엣지 없는 법인만 직접. 주기는 스토리지 수집 주기와 같이(세션을 늘리지 않음) · per-장비 시한 · 재진입 가드 · 인증 실패 정지 그대로. 엣지 push 는 기존 `storage/push.js` 에 `perfDetail` 조각을 더하고 **중앙 정제 화이트리스트에도** 넣는다(엣지 규칙).
- 보관: `storage-perf.db`(SAN perfDb 의 15분 · 1시간 집계 규약 복제 금지 — `perfRollup.js` 계획 함수를 공용으로 뽑아 쓴다). 키 = (deviceId, unit — 디렉터/노드/SP 이름, metric).
- 벤더별 경로 · 확인 수준(2026-11-08 웹 문서 — 실장비 미확인):

| 벤더 | 경로 · 지표 | 확인 수준 |
|---|---|---|
| PowerMax · VMAX | `POST /univmax/restapi/performance/FEDirector/keys`(symmetrixId) → `/metrics`(directorId · metrics[] · dataFormat Average) — PercentBusy · HostIOs · HostMBs · ReadResponseTime · WriteResponseTime · QueueDepthUtilization. **지원 지표는 장비마다 help 엔드포인트로 먼저 묻는다**(`/performance/FEDirector/help/<SID>/FEDirector/metrics/All` — Dell KB 000213922 · V4 2500/8500 은 일부 지표 없음). 디렉터 ID 는 `FA-1D` 외에 2500/8500 의 `OR-1C` 꼴 | 2차 자료 확인 |
| PowerStore | `POST /api/rest/metrics/generate` entity `performance_metrics_by_node`(entity_id = 노드 id · 기존 `fetchSpaceMetrics` 재사용 · interval Five_Mins) · 포트는 `performance_metrics_by_fe_fc_port`. **응답 필드 이름 미확인**(클러스터와 같은 `total_iops · avg_latency · read/write_bandwidth` 로 추정 · 노드 CPU 는 응답에 있을 때만) | 엔터티만 확인 |
| Unity | `GET /api/types/metric/instances`(경로 목록) → `GET /api/types/metricValue/instances?filter=path EQ "sp.*.cpu.summary.utilization"`(이력 · 60초) · FC `sp.*.fibreChannel.target.*.readBytes / writeBytes`(**누적 카운터** — 델타 · 첫 표본 null) · 실시간 `metricRealTimeQuery` 는 쓰지 않는다(세션 상시 금지) | 백서 · 지원 스크립트 |

- 매칭: SAN 쪽 그룹 이름(FA-1D · Node A · SPA)과 어레이 API 의 단위 ID 를 **정규화 비교**(대소문자 · 구분자 무시)해 같은 카드에 둔다 · 대조가 안 되면 따로 보여 주고 억지로 합치지 않는다.
- 보고 대조: 어레이가 보고한 호스트 대역폭 합(MB/s → Gb/s)과 스위치 처리량의 차이가 30% 이상이면 주의만(원인을 단정하지 않는다 — FC 프레임 헤더 · 제어 트래픽 · 한쪽 계측 누락이 후보).

### 4.3 성능 점검(⑥) — `sanswitch/storagePerfCheck.js`(순수) + `GET /tools/sanswitch/perf/storage-check`
- 월간 점검 규약 그대로: 판정 4종(ok · warn · bad · unknown) · 저장 표본만 판정(새 접속 없음) · **unknown 을 ok 로 흡수하지 않는다** · 판정 1회 = 기록 1회 · PDF 는 `reportExport` 재사용.
- 항목 9: 디렉터 편중 · 팹 비대칭 · 회선 포화 · 디렉터 busy · 응답 시간 · 큐 깊이 · 노드/SP CPU · 보고 대조 · 수집 상태. 벤더에 없는 항목은 `na`('—'). 임계값은 `CONFIG_DIR/storage-perf-check.json`(관리자 전용 · 원자 쓰기 · 손상 보존 — 기본값 **비움**).

## 5. 화면(IA) — 아트보드 5장

| 보드 | 파일 | 내용 |
|---|---|---|
| ① | `Main.dc.html` | **SAN 스위치 모니터링 안의 보기 전환 `[스위치 · 포트 용량] [스토리지 · 사용량 · 트렌드]`**(해시 `#/tools/sanswitch/storage` — 도구 키 불변) · 실시간 알약(마지막 표본 · 주기 · 읽은 곳) · KPI 5(지금 합계 · 회선 사용률 · 어레이 수 · 편중 · 측정 없음/미보고) · 필터(법인 칩 · 벤더 · 정렬 · 검색) · **어레이 표(STable)**: 법인 · 스토리지(벤더 배지 · 모델 · S/N) · 디렉터/컨트롤러 수 · 포트 A/B · 지금 · 회선 사용률 바 · 1시간 스파크 · 24시간 평균/피크 · 7일 대비 · 용량 · 상태 · 편중 경고 목록 · 법인별 비중(기존 카드와 같은 합계) |
| ② | `Detail.dc.html` | **어레이 상세 페이지**(모달 아님 · 해시 `…/storage/<키>`): 머리(벤더 · S/N · 법인 · 스위치 · 포트 · 디렉터 · 용량 링크 · 포트 배치 · 조닝 · CSV · 지금 수집) · 기간 세그먼트(실시간 1시간 · 24시간 · 7일 · 30일 · 90일 · 1년) · 기준(평균 · 피크) · **묶음(합계 · 디렉터별 · 팹 A/B · 포트별)** · 알약(해상도 · 읽은 시각) · 지표 카드 4(지금 + 회선 % · 평균 · 최고 + 시각 · 7일 대비) · **디렉터별 쌓기 면적 차트**(부분 합 빗금 · 평균 점선 · 마우스 오버 상자) · 구간 이동 줄 · **디렉터별 소형 카드 4**(지금 · 스파크 · 포트 · 평균/피크 · 회선 % · 배수 배지) · 포트 표 8 · **요일 × 시간 히트맵** · **'어레이가 보고하는 디렉터 성능' 패널**(디렉터별 busy 바 · IOPS · MB/s · 읽기/쓰기 응답 · 큐 깊이 표 + busy% 24시간 선 차트 + 임계값 점선 + **보고 대조** 문구 — 2차 보강) · 각주 |
| ③ | `Directors.dc.html` | **벤더별 패널 3**(PowerMax 디렉터 4 · PowerStore 노드 2(편중 · CPU 74% 예) · Unity SP 2(엣지 중계 예)) — 심볼릭 이름 해석 예 · 그룹 행(포트 칩 팹 A/B · 24시간 평균 · 배수) · **어레이 측 지표 실값**(busy/CPU 바 · IOPS · 응답) · **해석 규칙 표**(확신 등급 · `OR-1C` 추가) · 어레이 측 수집 설계 + **벤더별 API 확인 표** · 묶음 보기 4가지 설명 |
| ④ | `Narrow.dc.html` | 400px — 목록은 카드 행(지금 · 회선 바 · 스파크 · 평균/피크 · 7일 대비 · 상태) · 상세는 KPI 2×2 · 세그먼트 줄바꿈 · 차트 뷰박스 400 · 디렉터 카드 세로 · 포트 표 가로 넘김 · 어레이 보고 성능 카드(디렉터 4행) · 히트맵 가로 넘김 |
| ⑤ | `States.dc.html` | 상태 8종 — 수집 꺼짐 · 첫 주기 대기 · 엣지 미보고 · 부분 합 구간(빗금) · 보고 멈춤(held) · **디렉터 구분 못 함(수동 매핑 · 어레이로 지정)** · 용량 미매칭 · 과거 구간/데모/DB 불가 — 어느 것이 기존 판정이고 어느 것이 새 판정인지 밝힘 |
| ⑥ | `Check.dc.html` | **성능 점검 탭**(`#/tools/san-storage/check`): 어레이 × 항목 9(디렉터 편중 · 팹 비대칭 · 회선 포화 · 디렉터 busy · 응답 시간 · 큐 깊이 · 노드/SP CPU · 보고 대조 · 수집 상태) · 판정 4종 + 해당 없음 · 종합 배지('정상(일부 미확인)' 포함) · **판정 규칙 표(기준 출처 — 기존 상수 / 벤더 문서 기본값 / 관리자 설정(비움))** · 기준 설정 · PDF · 지금 판정 |
| ⑦ | `Mapping.dc.html` | **분류 · 디렉터 매핑 탭(관리자 · `#/tools/san-storage/mapping`)**: 요약 알약(연결 대상 · 어레이/호스트 · 자동 해석/구분 못 함 · 수동) · ① 연결 대상 분류 표(자동 근거 · 적용 · 어레이로/호스트로 지정 · 자동으로 되돌리기) · ② 포트 → 디렉터 매핑 표(심볼릭 이름 · 자동 해석 · 수동 그룹 입력 · 메모/변경자) · 해석 순서 · 저장 규약 · 최근 변경 · **'포트 이름 CSV 내보내기'**(port_meta — 벤더 이름 형식 확인용 · 스위치 접속 없음) |

### 5.1 ① 이 바꾸는 것(3차 — 독립 도구)
- **새 도구 키 `san-storage`**(세그먼트 = 키 규칙 — `auth/toolAccess.js` 머리말). 등록 지점 전부:
  `web/src/views/specialToolsList.js`(`k:'san-storage'` · `aka:['SAN 스토리지','디렉터 성능','컨트롤러 성능','SAN storage']` · `adminOnly` 는 실제 게이트와 맞춘다 — 조회는 `toolsPerm + fullScopeOnly` 이므로 SAN 스위치 항목의 값과 같게) ·
  `web/src/views/SpecialTools.jsx`(`tool === 'san-storage'` → `SanStorageTool`) · `web/src/views/topMenu.js` '스토리지' 그룹에 `{ id:'san-storage', label:'SAN 스토리지 성능', tool:'san-storage' }` 추가(기존 `san` 항목은 id · tool 그대로 두고 **라벨만** 'SAN 스위치 모니터링' 으로 — 지금 라벨 'SAN 스토리지 성능 측정' 이 새 메뉴와 헷갈린다) ·
  `server/src/toolcats/catalog.js` PRESET 'storage' 에 `'san-storage'` · `server/src/auth/toolAccess.js TOOL_PATH_KEYS` 에 `'san-storage':'san-storage'` · `auth/demoGuest.js` 의 데모 읽기 허용 목록(필요한 GET 만) · `components/invSearchQuery.js`(⌘K 검색에서 어레이 → 이 도구) ·
  회귀 테스트 대조: `test/audit2613a.test.js`(세그먼트↔키) · `toolCatalog2614`(adminOnly↔게이트) · `toolNames2679` · `linkCheck2552`(메뉴 링크) · `settingsLinks2685` · 문서 생성기 `scripts/api-doc.mjs`(docs/API.md) · `config-doc.mjs`(새 설정 파일 2개).
- 탭은 해시(`useHashTab({ base:['tools','san-storage'], valid:['list','check','mapping'] })`) · 어레이 상세는 `#/tools/san-storage/array/<키>`(법인은 쿼리).
- **기존 SAN 스위치 화면**: `DcGrid` 의 '스토리지 사용량 분석 →' 링크는 `#/tools/san-storage`(선택 법인을 쿼리로) · `DcStoragePerf` 모달은 **지운다**(판정 코어 하나 — 사용자 답 2 '독립적인 메뉴로') · `TrafficCard` 는 남기고 머리에 'SAN 스토리지 성능에서 자세히 →'. 장비 상세의 '사용량 분석(perf)' 탭은 스위치 단위라 그대로.

### 5.2 ② 가 바꾸는 것
- 상세는 페이지(새로고침 · 공유 · 뒤로 가기) — 목록 행 · 편중 경고 · 기존 모달 표의 스토리지 이름에서 들어온다.
- 차트는 SVG 직접 그리기(vmperf · 전송 속도와 같은 방식 — 이 경로에 recharts 를 더 싣지 않는다) · 결측은 선을 끊고 부분 합은 빗금.
- 구간 이동은 `vmPerfText` 의 창 계산을 **공용 순수 모듈로 뽑아** 세 번째로 쓴다(복제 금지 — v2.913 README 의 같은 메모).

## 6. 컨펌 결과(2026-11-08 19:41 KST 사용자 답 — 원문 그대로 · 해석 · 남은 확인)

| # | 질문 | 사용자 답(원문) | 반영 |
|---|---|---|---|
| 1 | 자리 | "독립 도구" | 새 도구 키 `san-storage`(§5.1) |
| 2 | 기존 모달 · 카드 | "독립적인 메뉴로 만들어줘" | **해석**: 새 기능을 독립 메뉴('스토리지 › SAN 스토리지 성능')로 만들고 기존 '스토리지 사용량 분석' 모달은 그 메뉴로 보낸 뒤 지운다 · 트래픽 카드는 남긴다. ⚠ 다르게 뜻하셨으면(예: 기존 모달도 별개 메뉴로 유지) 알려 주실 것 — **남은 확인 1** |
| 3 | 수동 매핑 · 어레이로 지정 | "포함하고 더 구체적으로 표시할 수 있는 메뉴 추가 검토" | 포함 + **⑦ 분류 · 디렉터 매핑 탭**(관리자) 신설 — 분류 표 · 포트→디렉터 표 · 근거 배지 · 변경 이력 · 포트 이름 CSV |
| 4 | 어레이 측 수집 | "어떤 장비를 어떻게 캡처해야 되는지 알려줘" | `CAPTURE-GUIDE.md`(우선순위 · 장비별 명령 · 가릴 것 · 파일 목록). 캡처가 오기 전에도 방어 구조로 구현은 시작할 수 있다 — **남은 확인 2**: 캡처를 기다렸다가 착수할지, 먼저 착수할지 |
| 5 | 점검 기준 | "스토리지 벤더 및 컨설팅 업체의 추천 가이드 찾아줘" | §10 — 찾은 값만 기본값으로(PowerMax busy 70 · 큐 75 · Unity SP CPU 70/90 · PowerStore 노드 CPU 50/70 · 회선 포화 70) · 못 찾은 응답 시간은 비움 · 컨설팅 경험칙(10/20 ms)은 호스트 지연용이라 FE 응답 시간 기준으로 쓰지 않음 |
| 6 | 1년 보기 | "1년" | 포함(1시간 집계 2년 · 하루 평균 365점) |
| 7 | 검증 | "기본" | 표준(관련 테스트 + Chromium 1440/400 + 전량 verify) + 서버 변이 검증 1회 |
| 8 | 시리즈 색 | "검증 팔레트 4색 토큰 추가" | `web/src/styles.css :root` 에 `--viz-1: #3987e5 · --viz-2: #d95926 · --viz-3: #199e70 · --viz-4: #c98500`(dataviz 검증기 다크 표면 통과) — 새 hex 4개 · 디렉터/컨트롤러 시리즈 전용 · 5개 이상은 '그 밖'(회색) |

## 7. 구현 메모(컨펌 뒤 · Opus)

- 서버(스위치 측): `sanswitch/directorOf.js`(순수) · `sanswitch/directorMap.js`(저장소) · `perfDb.js storageSeriesMulti` `withPorts` · `sanswitch/storageList.js`(순수 조립 — now · util · delta · imbalance · state) · `routes/api/sanSwitch.js` 라우트 3(목록 · 상세 · 매핑 PUT) · 목 `demoPerfSynth` 가 포트별 시리즈도 만든다(Chromium 검증이 비지 않게).
- 서버(어레이 측): `storage/collectors/powermax.js`(FEDirector keys → help → metrics) · `powerstore.js`(`performance_metrics_by_node` — 기존 `fetchSpaceMetrics` 재사용) · `unity.js`(`metric/instances` → `metricValue`) · 순수 `storage/perfDetail.js`(벤더 응답 → 공통 `{unit, metric, value, at}` · 누적 카운터 델타) · `storage/perfDb.js`(SAN `perfRollup` 공용화) · 엣지 push 조각 + 중앙 정제 화이트리스트 · 목 합성 · `sanswitch/storagePerfCheck.js`(⑥ 판정) · 임계값 저장소.
- 웹: `views/tools/SanStorageTool.jsx`(탭 3 — 현황 · 성능 점검 · 분류 · 매핑) · `SanStorageDetail.jsx` · `SanStorageCheck.jsx` · `SanStorageMapping.jsx` · 순수 `sanStorageText.js`(문구 · 상태 8종 · 7일 대비 · 히트맵 접기 · 보고 대조 · CSV 행) · 공용 창 계산 모듈(`components/windowScroll/`) · §5.1 의 등록 지점 전부 · `SanSwitchTool.jsx` 링크 교체 + `DcStoragePerf` 삭제 · 설정 › 수집 › 스토리지 성능 점검(임계값 — 벤더 기본값 표시 · '사용자 설정' 배지) · `:root --viz-1~4`.
- 서버(매핑 · 분류): `sanswitch/directorMap.js`(`CONFIG_DIR/san-storage-map.json` — 분류 재정의 + 포트→디렉터 · 관리자 PUT · 감사 로그 · '이름이 바뀜' 표지) · `GET /tools/san-storage/port-names.csv`(port_meta 내보내기 · `csvPerm + adminOnly`).
- 테스트: 서버 `test/sanStorage29xx.test.js`(directorOf 벤더별 · 평평한 이름 · `OR-1C` · 목록 조립의 now/util/delta 결측 규칙 · 합계 = `sumArrayTraffic` 대조 · 매핑/임계값 PUT admin 게이트 · 비-admin 주소 가림 · 판정표 unknown 흡수 금지 · 벤더 응답 픽스처(가상 식별자) 파서) · 웹 `sanStorageText.test.js` · `sanSwitchViewText` 기존 통과.
- 문서: `docs/rules/sanswitch.md` 에 '스토리지 보기 · 디렉터 해석 · 수동 매핑 · 성능 점검' 항목 · `docs/rules/storage.md` 에 '디렉터 · 노드 · SP 성능 수집' 항목 · 이 README §8 에 '시안과 달리 한 것'.
- 릴리스: 포탈 동작이 바뀌므로 버전업 + GitHub 릴리스 1회(`versions.json` latest 확인). 규모가 커서(스위치 측 + 어레이 측 3벤더 + 점검) **PR 2개로 나눌 수 있다**: ⓐ 스위치 측 목록 · 상세 · 디렉터 해석 · 점검 틀 ⓑ 어레이 측 수집 3벤더 — 질문 4 의 답에 따라 정한다.

## 8. 구현(컨펌 뒤 채움)

- (비어 있음 — 시안 단계)

## 9. 출처(어레이 측 API — 2026-11-08 웹 확인 · 실장비 미확인)

- PowerMax FEDirector 지표: Dell PowerMax Splunk 애드온 `fe_dir.rst` · Dynatrace 'dell emc powermax' 확장 지표 표 · Dell KB 000213922(V4 지표 제거 · help 엔드포인트) · Dell KB 000214283(디바이스 레벨 지표) · PowerShell 모듈 샘플 payload(FrontEnd.xml) · Dell infohub 'What's new in PowerMax REST API 10.0'(`directorId: "OR-1C"` 예).
- PowerStore metrics/generate 엔터티: PowerStore 3000X REST API Developers Guide(열거형) · Dell 커뮤니티 'API Sample Data' · Dell KB 000490125(요청 형식) · Netdata PowerStore 수집기(노드 · FC 포트 · Five_Mins).
- Unity 지표 경로: Dell EMC Unity Performance Metrics 백서(H15161) · Dell 지원 스크립트 getPerformance.pl(FC 경로) · Dell 커뮤니티(metricValue filter 예) · dell/gounity metrics.go.

## 10. 권장 기준 가이드 — 벤더 · 컨설팅(2026-11-08 웹 검색 · 사용자 답 5)

> ⚠ 이 세션은 `www.dell.com` 직접 열람이 네트워크 정책에 막혀(ENOTFOUND) 본문을 읽지 못했다 — 아래 숫자는 검색 결과 요약에 인용된 값이고 출처 링크를 붙였다. 구현 전에 Unisphere 제품 가이드 · Unity BP 가이드 원문에서 한 번 더 대조할 것. **찾지 못한 값은 비워 두었다 — 지어내지 않는다.**

| 항목 | 벤더 · 컨설팅 권장 | 출처 | 시안 기본값 |
|---|---|---|---|
| PowerMax FE 디렉터 % busy | Unisphere for PowerMax 건강 점수 기본 **critical 70** (FE port % busy 는 항목만 있고 기본값 미기재) | [Unisphere 10.0 Product Guide — System Health Score](https://www.dell.com/support/manuals/en-us/powermax-os-10/esd_p_mt_unisph_u4p_product_guide_10_0_0/understanding-the-system-health-score?guid=guid-52ed4b8e-8c13-4384-96c7-c3f35db5aed7&lang=en-us) | 이상 70 · 주의 비움 |
| PowerMax 큐 깊이 사용률 | 기본 **critical 75** | 같은 문서 | 이상 75 · 주의 비움 |
| PowerMax 응답 시간 | 공식 권장값 **못 찾음**(Dell RAS 백서는 FE 연결을 물리 부품에 분산하라는 설계 권고만) | [PowerMax RAS 백서](https://www.delltechnologies.com/asset/en-us/products/storage/industry-market/h17064-dell-powermax-ras-white-paper.pdf) | 비움 |
| PowerStore 노드 CPU | 업그레이드 전 점검 KB: **≤50% 진행 · >50% 연기 · 지속 ≥70% 는 부하 높음**. 노드 친화도 자동 조정도 CPU 50% 를 본다(30분마다) | [KB 000192018](https://www.dell.com/support/kbdoc/en-us/000192018/powerstore-cpu-utilization-level-too-high-reduce-system-load-prior-to-ndu-cpu-usage-level-exceeded) · [Clustering & HA](https://www.dell.com/en-us/infohub/articles/dell-powerstore-clustering-and-high-availability) | 주의 50 · 이상 70 (**간접 근거** — 업그레이드 문맥) |
| PowerStore 지연 | 공식 알림 기준 **못 찾음**(용량 알림 70/85% 만 문서화) | [KB 000123351](https://www.dell.com/support/kbdoc/en-us/000123351/powerstore-alerts-capacity-utilization) | 비움 |
| Unity SP CPU | Best Practices Guide Table 2 지속 사용률 구간: **<50 여유 · 50~70 정상 · 70~90 높음 · >90 과부하** · 두 SP 를 비슷하게 맞출 것 · Data Reduction 추가는 70% 근처면 비권장(KB) | [Dell Unity Best Practices Guide](https://www.dell.com/en-us/infohub/articles/dell-unity-best-practices-guide-1) · [H15093 PDF](https://dl.dell.com/content/docu69891) · [KB 000022795](https://www.dell.com/support/kbdoc/en-us/000022795/unity-how-to-use-compression-considerations-and-best-practices) | 주의 70 · 이상 90 |
| Unity 포트 상한 | 포트당 최대 **16Gb FC 1,500 MB/s · 32Gb FC 3,000 MB/s**(45,000 IOPS) | 같은 가이드 | 회선 사용률 분모(`capBpsOf`)와 일치 — 추가 기준 없음 |
| Brocade 포트 사용률 | MAPS 기본 FPI 과가입 트리거 **TX 70%**(F/E 포트) · 혼잡 가이드의 대역폭 경보 60/75/90 %/hr(기본값인지 미확인) · 기본 정책 3종(conservative/moderate/aggressive) · 스토리지 포트는 코어로 과가입하지 말 것 | [FOS 9.1.x MAPS User Guide](https://techdocs.broadcom.com/content/dam/broadcom/techdocs/us/en/pdf/fc-networking/software-maps/fos-91x-maps.pdf) · [Fabric Congestion Troubleshooting](https://sanview.thorington.uk/wp-content/uploads/2018/08/fabric-congestion-troubleshooting-guide.pdf) · [SAN Design and Best Practices](https://docs.broadcom.com/doc/53-1004781) | 회선 포화 주의 70 · 이상 90(**90 은 제안**) |
| 호스트 지연(컨설팅 · 벤더 중립 경험칙) | <10 ms 양호 · >20 ms 느림(경험칙) · VMware 계열 블로그 읽기 5/20 · 쓰기 10/30 ms · Microsoft SQL 데이터 ≤20 ms · 로그 ≤5 ms · 모니터링 벤더 매트릭스 20/50 ms + SAN 업링크 70% | [Paessler](https://blog.paessler.com/the-storage-monitoring-matrix-10-critical-metrics-every-it-team-must-track?hs_amp=true) · [matrixpost](https://blog.matrixpost.net/analyzing-vmware-storage-performance-from-latency-to-iops/) · [House of Brick](https://houseofbrick.com/blog/storage-performance-metrics/) | FE 응답 시간 기준으로 **쓰지 않음**(계측 지점이 다르다) — 나중에 vCenter 데이터스토어 지연을 붙일 때 참고 |

종합: 벤더가 숫자로 준 것은 PowerMax busy 70 · 큐 75, Unity SP CPU 구간, PowerStore CPU 50/70(간접), Brocade TX 70 이다. 응답 시간 · 지연은 어느 벤더도 디렉터/노드 단위 공식 기준을 공개한 것을 찾지 못했다 → 비워 두고 관리자 설정. 컨설팅 자료는 대부분 호스트 관점 경험칙이라 참고만.

## 11. 캡처 가이드

`CAPTURE-GUIDE.md` — 우선순위 1 은 **PowerStore · Unity 어레이 포트의 심볼릭 이름**(포탈 `port_meta` 에서 바로 뽑을 수 있다 → 구현에서 '포트 이름 CSV 내보내기' 단추로). 2~4 는 PowerMax Unisphere · PowerStore · Unity REST 응답 각 2~4개(curl 예 포함). 공개 저장소에 커밋하지 않는다.

## 12. 추가 기능 · 문서 검토(사용자 요청 "더 찾아서 한번 더 검토")

### 12.1 이번 구현에 같이 넣을 만한 것(작고 근거가 있는 것)
1. **포트 이름 CSV 내보내기**(⑦ 탭) — 심볼릭 이름 형식 확인을 스위치 접속 없이. `port_meta` 읽기 1문장 · `csvPerm + adminOnly`.
2. **SAN 플로우 모니터(`san-flow` · v2.935 Flow Vision) 연결** — 어레이 상세 ② 머리에 '호스트별 플로우 ↗'(그 어레이 타깃 WWN 으로 필터). 디렉터 처리량을 **어느 호스트가 만드는지**는 이미 있는 도구가 답한다 — 다시 만들지 않는다.
3. **메뉴 라벨 정리** — '스토리지 › SAN 스토리지 성능 측정'(→ `san-switch`)을 'SAN 스위치 모니터링' 으로(라벨만 · id · tool 불변).
4. **스토리지 경로 도구(`storage-paths`) 링크** — 어레이 ↔ 데이터스토어/LUN 경로가 이미 있다면 상세 ② 에서 링크(있는지 구현 때 확인 — `web/src/views/tools/StoragePathsTool.jsx` 존재 확인만 했다).
5. **설정 요약 알약** — 상단에 '수집 주기 5분 · 어레이 측 10분 · 임계값 사용자 설정 2개' 처럼 API 값으로(숫자 하드코딩 금지).

### 12.2 후속 후보(별도 작업 — 우선순위 순)
6. **알림(메일)** — 편중 · 포화 · 임계값 초과 · 보고 끊김을 법인 단위로(스토리지 `usageMail` 규약 재사용 · 1:1:1 법인 묶음). 상태가 **바뀐 순간만**(파트 장애 규약).
7. **자기 기준선 대비 이상 표시** — 요일 × 시간 기준선(지난 4주)에서 ±N% 벗어난 칸을 '평소와 다름' 으로 — 벤더 임계값이 없는 응답 시간에도 쓸 수 있는 **지어내지 않는 기준**(기준선 = 자기 과거).
8. **월간 성능 점검 PDF 자동 발송** — ⑥ 판정표 + 상위 어레이 추이(월간 점검 PDF 인프라 재사용).
9. **ISL 사용량 연계** — 팹 비대칭의 원인 단서(헬스체크 ISL 항목 + 포트 사용량의 E-포트).
10. **어레이 측 경보 연동** — 스토리지 수집기가 이미 세는 알람 수를 상세 ② 머리에(링크 → 스토리지 현황).
11. **publicapi 노출** — `/api/public/san-storage/...`(외부 모니터링 연동 · 기존 publicapi 토큰 규약).
12. **용량 × 성능 교차 보기** — 스토리지 증가량(`growth.js`)과 디렉터 처리량 추세를 한 표에(증설 판단 — '찼는데 한가함' / '바쁜데 여유').
13. **Unity · PowerStore 포트 단위 어레이 측 지표**(`performance_metrics_by_fe_fc_port` · Unity fePort) — 1차는 노드/SP 단위까지.

### 12.3 문서
- 저장소: `docs/rules/sanswitch.md`(스토리지 성능 도구 · 디렉터 해석 · 매핑 · 점검 기본값 출처) · `docs/rules/storage.md`(디렉터 · 노드 · SP 수집 · 누적 카운터 델타) · `docs/API.md` 재생성(`scripts/api-doc.mjs`) · `docs/CONFIG-FILES.md` 재생성(`config-doc.mjs` — `san-storage-map.json` · `storage-perf-check.json`) · 운영 안내 `docs/OPS-SAN-STORAGE.md`(캡처 · 임계값 설정 · 판정표 읽는 법 · '확인 불가' 의 뜻) · 릴리스 노트에 '첫 반영에서 어레이 측 칸이 비어 있을 수 있는 이유'.
- 확보해야 할 외부 문서: Unisphere for PowerMax REST 문서(장비 로컬 `https://<unisphere>:8443/univmax/restapi/docs` — FEDirector 절) · PowerStore REST API Developers Guide(dell.com/powerstoredocs — `metrics/generate` 응답 스키마) · Unity Unisphere Management REST API Programmer's Guide + Performance Metrics 백서 H15161 · 운영 중인 FOS 버전의 MAPS User Guide(기본 임계값 표) · Broadcom SAN Design and Best Practices 53-1004781.
