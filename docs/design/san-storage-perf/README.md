# 설계: SAN 스토리지 사용량 · 트렌드 — 실시간 · 트렌드 · 디렉터(VMAX · PowerMax) · 컨트롤러(PowerStore · Unity)별

작성 2026-11-08 (main **v2.946.0** 기준 — ⚠ 정정: 처음에 v2.914.0 이라 적었던 것은 브랜치를 main 에 맞추기 전의 추정이었다 · 브랜치 `claude/festive-planck-vy0dg3`) · 상태 **구현 v2.948.0(§8 — 2026-11-08 23:00~ · 사용자 '그대로 진행' 으로 이 세션(Fable)이 구현 · 규칙상 Opus)** ·
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
- **기존 SAN 스위치 화면은 보존한다**(사용자 답 "기존 메뉴도 보존해줘"): `DcGrid` 의 '스토리지 사용량 분석 →' 과 `DcStoragePerf` 모달 · `TrafficCard` · 메뉴 항목 전부 그대로. 모달 머리와 카드에 **'SAN 스토리지 성능에서 자세히 →'**(`#/tools/san-storage?datacenterId=…` — 선택 법인을 쿼리로) 링크만 더한다. 장비 상세의 '사용량 분석(perf)' 탭도 그대로.

### 5.2 ② 가 바꾸는 것
- 상세는 페이지(새로고침 · 공유 · 뒤로 가기) — 목록 행 · 편중 경고 · 기존 모달 표의 스토리지 이름에서 들어온다.
- 차트는 SVG 직접 그리기(vmperf · 전송 속도와 같은 방식 — 이 경로에 recharts 를 더 싣지 않는다) · 결측은 선을 끊고 부분 합은 빗금.
- 구간 이동은 `vmPerfText` 의 창 계산을 **공용 순수 모듈로 뽑아** 세 번째로 쓴다(복제 금지 — v2.913 README 의 같은 메모).

## 6. 컨펌 결과(2026-11-08 19:41 KST 사용자 답 — 원문 그대로 · 해석 · 남은 확인)

| # | 질문 | 사용자 답(원문) | 반영 |
|---|---|---|---|
| 1 | 자리 | "독립 도구" | 새 도구 키 `san-storage`(§5.1) |
| 2 | 기존 모달 · 카드 | "독립적인 메뉴로 만들어줘" → 재확인 답(22:45) **"기존 메뉴도 보존해줘"** | 새 기능은 독립 메뉴('스토리지 › SAN 스토리지 성능')로 만들고, **기존 SAN 스위치 화면의 '스토리지 사용량 분석' 모달 · 트래픽 카드 · 메뉴 항목은 그대로 둔다**. 모달 머리와 카드에 '새 화면에서 보기 →' 링크만 더한다. 두 화면 모두 같은 서버 집계(`storage-summary` · `storageSeriesMulti`)를 읽으므로 판정 코어는 하나다(화면이 둘인 것이지 판정이 둘이 아니다 — 테스트가 같은 입력으로 대조) |
| 3 | 수동 매핑 · 어레이로 지정 | "포함하고 더 구체적으로 표시할 수 있는 메뉴 추가 검토" | 포함 + **⑦ 분류 · 디렉터 매핑 탭**(관리자) 신설 — 분류 표 · 포트→디렉터 표 · 근거 배지 · 변경 이력 · 포트 이름 CSV |
| 4 | 어레이 측 수집 | "어떤 장비를 어떻게 캡처해야 되는지 알려줘" → 재확인 답(22:45) **"먼저 착수하고 캡쳐가 오면 파서를 맞춰"** | `CAPTURE-GUIDE.md`(우선순위 · 장비별 명령 · 가릴 것 · 파일 목록). **구현은 바로 착수** — 세 벤더 모두 '장비가 주는 지표 목록을 먼저 읽고 없는 것은 — + 사유' 구조로 짜고, 파서는 가상 식별자 픽스처(웹 문서 형식)로 테스트한다. 캡처가 오면 픽스처를 실제 형식으로 바꾸고 파서를 맞춘다(그때 패치 릴리스). 릴리스 노트에 '첫 반영에서 어레이 측 칸이 비어 있을 수 있음' 을 적는다 |
| 5 | 점검 기준 | "스토리지 벤더 및 컨설팅 업체의 추천 가이드 찾아줘" | §10 — 찾은 값만 기본값으로(PowerMax busy 70 · 큐 75 · Unity SP CPU 70/90 · PowerStore 노드 CPU 50/70 · 회선 포화 70) · 못 찾은 응답 시간은 비움 · 컨설팅 경험칙(10/20 ms)은 호스트 지연용이라 FE 응답 시간 기준으로 쓰지 않음 |
| 6 | 1년 보기 | "1년" | 포함(1시간 집계 2년 · 하루 평균 365점) |
| 7 | 검증 | "기본" | 표준(관련 테스트 + Chromium 1440/400 + 전량 verify) + 서버 변이 검증 1회 |
| 8 | 시리즈 색 | "검증 팔레트 4색 토큰 추가" | `web/src/styles.css :root` 에 `--viz-1: #3987e5 · --viz-2: #d95926 · --viz-3: #199e70 · --viz-4: #c98500`(dataviz 검증기 다크 표면 통과) — 새 hex 4개 · 디렉터/컨트롤러 시리즈 전용 · 5개 이상은 '그 밖'(회색) |

## 7. 구현 메모(컨펌 뒤 · Opus)

- 서버(스위치 측): `sanswitch/directorOf.js`(순수) · `sanswitch/directorMap.js`(저장소) · `perfDb.js storageSeriesMulti` `withPorts` · `sanswitch/storageList.js`(순수 조립 — now · util · delta · imbalance · state) · `routes/api/sanSwitch.js` 라우트 3(목록 · 상세 · 매핑 PUT) · 목 `demoPerfSynth` 가 포트별 시리즈도 만든다(Chromium 검증이 비지 않게).
- 서버(어레이 측): `storage/collectors/powermax.js`(FEDirector keys → help → metrics) · `powerstore.js`(`performance_metrics_by_node` — 기존 `fetchSpaceMetrics` 재사용) · `unity.js`(`metric/instances` → `metricValue`) · 순수 `storage/perfDetail.js`(벤더 응답 → 공통 `{unit, metric, value, at}` · 누적 카운터 델타) · `storage/perfDb.js`(SAN `perfRollup` 공용화) · 엣지 push 조각 + 중앙 정제 화이트리스트 · 목 합성 · `sanswitch/storagePerfCheck.js`(⑥ 판정) · 임계값 저장소.
- 웹: `views/tools/SanStorageTool.jsx`(탭 3 — 현황 · 성능 점검 · 분류 · 매핑) · `SanStorageDetail.jsx` · `SanStorageCheck.jsx` · `SanStorageMapping.jsx` · 순수 `sanStorageText.js`(문구 · 상태 8종 · 7일 대비 · 히트맵 접기 · 보고 대조 · CSV 행) · 공용 창 계산 모듈(`components/windowScroll/`) · §5.1 의 등록 지점 전부 · `SanSwitchTool.jsx` 는 모달 · 카드에 링크만 추가(삭제 없음) · 설정 › 수집 › 스토리지 성능 점검(임계값 — 벤더 기본값 표시 · '사용자 설정' 배지) · `:root --viz-1~4`.
- 서버(매핑 · 분류): `sanswitch/directorMap.js`(`CONFIG_DIR/san-storage-map.json` — 분류 재정의 + 포트→디렉터 · 관리자 PUT · 감사 로그 · '이름이 바뀜' 표지) · `GET /tools/san-storage/port-names.csv`(port_meta 내보내기 · `csvPerm + adminOnly`).
- 테스트: 서버 `test/sanStorage29xx.test.js`(directorOf 벤더별 · 평평한 이름 · `OR-1C` · 목록 조립의 now/util/delta 결측 규칙 · 합계 = `sumArrayTraffic` 대조 · 매핑/임계값 PUT admin 게이트 · 비-admin 주소 가림 · 판정표 unknown 흡수 금지 · 벤더 응답 픽스처(가상 식별자) 파서) · 웹 `sanStorageText.test.js` · `sanSwitchViewText` 기존 통과.
- 문서: `docs/rules/sanswitch.md` 에 '스토리지 보기 · 디렉터 해석 · 수동 매핑 · 성능 점검' 항목 · `docs/rules/storage.md` 에 '디렉터 · 노드 · SP 성능 수집' 항목 · 이 README §8 에 '시안과 달리 한 것'.
- 릴리스: 포탈 동작이 바뀌므로 버전업 + GitHub 릴리스 1회(`versions.json` latest 확인). 규모가 커서(스위치 측 + 어레이 측 3벤더 + 점검) **PR 2개로 나눌 수 있다**: ⓐ 스위치 측 목록 · 상세 · 디렉터 해석 · 점검 틀 ⓑ 어레이 측 수집 3벤더 — 질문 4 의 답에 따라 정한다.

## 8. 구현(v2.948.0 — 2026-11-08 23:00~ KST · 스위치 측 PR ⓐ · 이 세션(Fable) — 사용자 "그대로 진행")

- 서버: `sanswitch/directorOf.js`(순수 — 벤더별 이름 규칙 · 별칭 폴백 · `OR-1C`) · `sanswitch/directorMap.js`(`san-storage-map.json` — 분류 재정의 + 포트→디렉터 · 원자 쓰기 · 손상 보존 · 전체 교체 · 바뀐 항목만 변경자/시각) ·
  `sanswitch/storageCheckSettings.js`(`storage-perf-check.json` — 벤더 문서 기본값 · null = 비움 · 빈 값 = 기본값 · 주의 ≤ 이상) · `sanswitch/storageList.js`(순수 조립 — 지금 · 24시간 · 7일 대비 · 디렉터 · 팹 · 회선 · 상태 코드) ·
  `sanswitch/storagePerfCheck.js`(순수 판정 — ok/warn/bad/unknown/na · unknown 흡수 금지 · 어레이 측은 이 판에서 unknown) · `perfDb.storageSeriesMulti` `withPorts`(포트별 시계열 · 기억 키에 포함) ·
  `demoPerfSynth`(어레이 합 = 포트별 시계열의 합 — withPorts 유무와 무관하게 같은 숫자) · `routes/api/sanSwitch.js`(`capacityIndexFor` · `perfAbortSignal` · `abandoned` 를 모듈 범위로 — 두 라우터가 같은 코어) ·
  `routes/api/sanStorage.js`(라우트 7 — 현황 · 상세 · 점검 · 임계값 GET/PUT · 매핑 GET/PUT · 포트 이름 CSV) · `auth/toolAccess.js`(`san-storage` 세그먼트 = 키) · `toolcats/catalog.js`(PRESET 스토리지) · `routes/api.js`.
- 웹: `views/tools/SanStorageTool.jsx`(탭 3 + 어레이 상세 — SVG 쌓기 차트 · 스파크 · 히트맵 · CSV) · `SanStorageCheck.jsx`(판정표 · 규칙 표 · 기준 설정 모달) · `SanStorageMapping.jsx`(분류 · 포트→디렉터 · 최근 변경 · CSV) ·
  순수 `sanStorageText.js` · `sanStorage.css`(`.sst-*`) · `styles.css :root --viz-1~4` · `specialToolsList.js`(`san-storage` · adminOnly 는 san-switch 와 같이 true) · `SpecialTools.jsx` · `topMenu.js`(스토리지 › 'SAN 스토리지 성능' 추가 · 'san' 항목 라벨 'SAN 스위치 모니터링') ·
  `SanSwitchTool.jsx`(분석 모달 머리에 새 화면 링크 — 모달 보존) · `SanSwitchV2Parts.jsx`(트래픽 카드 제목에 링크) · `web/public/special-tools.json` 재생성.
- 테스트: 서버 `test/sanStorage2948.test.js`(directorOf 15 케이스 · storageList 결측 · stale · edge-missing · partial-only · 편중 · 점검 · 임계값 · 매핑 · **실제 라우트 — 현황 지금 합계 == traffic-total** · 매핑 저장 뒤 분류 반영 · 상세 · CSV) ·
  `test/sanStorage2948gate.test.js`(범위 admin 403 · operator/쓰기 범위 admin PUT 403 · 전체 범위 admin 400) · 웹 `sanStorageText.test.js`(23) · `topMenu.test.js` 갱신(메뉴 18 · 스토리지 라벨). 기존 `sanPerf2728` · `sanDemoPerf2715` · `audit2732g` · `toolCatalog2614` · `audit2613a` 통과.
- 문서: `docs/rules/sanswitch.md` 항목 추가 · `docs/API.md` · `docs/CONFIG-FILES.md` 재생성 · 이 README.
- **시안과 달리 한 것**(정직 기록):
  1. 구간 이동은 ◀ 이전 · 다음 ▶ · 최신(창 단위)만 — **슬라이더 · '날짜로 이동' 은 넣지 않았다**(공용 창 계산 모듈 공용화는 별건 — vmPerfText 와 xferSpeedText 의 통합을 이 PR 에서 하지 않음).
  2. 성능 점검은 **화면 판정만** — PDF 내려받기 · 점검 이력('판정 1회 = 기록 1회')은 넣지 않았다. 사용자가 고른 표준 검증 범위에서 PR ⓐ 를 작게 유지하려는 선택이며, 다음 후보 §8.1.
  3. **어레이 측 성능 수집(busy% · IOPS · 응답 · CPU)은 PR ⓑ** — 이 판의 점검은 어레이 측 5항목을 전부 unknown('어레이 측 성능 미수집')으로 둔다. 상세의 그 카드는 '다음 판 — 수집 전' 이다.
  4. 조닝 별칭 폴백(Unity_SPA0_p8)은 `directorOf` 에 있으나 **라우트가 별칭을 넘기지 않는다**(port_meta 에 별칭이 없고 조닝 스냅샷 대조는 실 Unity 캡처 뒤에).
  5. 현황의 오른쪽 아래 카드는 '법인별 비중' 대신 **'합계 · 상태'**(법인별 비중은 SAN 스위치 화면의 트래픽 카드가 이미 보여 준다 — 중복 제거).
  6. 상세의 '포트 배치 · 조닝' · '호스트별 플로우' 는 그 도구 첫 화면으로 가는 링크다(장비 · 타깃을 특정하는 딥링크 해시가 두 도구에 없다).
  7. 1년 보기는 서버 `hours` 상한(90일) 때문에 from/to 로 묻는다(최대 366일).
  8. 기존 메뉴 'san' 항목은 라벨만 'SAN 스위치 모니터링' 으로(id · 도구 키 그대로) — 새 항목이 'SAN 스토리지 성능' 을 쓴다.
  9. 'kind=host' 조회(호스트 키 목록)는 라우트에 있으나 화면은 '분류 · 매핑' 탭의 후보 표(이름 규칙 · 재정의)로 대신한다 — 평평한 이름 호스트 수천 개를 표에 깔지 않는다.
- **남긴 것**(§8.1): PR ⓑ 어레이 측 3벤더 수집 · 슬라이더/날짜 이동 · 점검 PDF/이력 · 별칭 전달 · 메일 알림 · 자기 기준선 이상 표시 · Flow Vision 타깃 필터 딥링크 · `invSearchQuery`(⌘K) 어레이 → 이 도구.

### 8.1 Chromium 확인(1440 · 400 · 목 서버 `DATA_SOURCE=mock AUTH_ENABLED=false` — 2026-11-08 23:20~23:55 KST)
- 측정(Sonnet 1회 + 메인 Playwright 3회): 현황 · 상세 · 성능 점검 · 분류 매핑 · 기존 SAN 스위치 화면, 1440/400 모두 **문서 가로 넘침 0 · pageerror 0 · console error 0**.
  목 서버 첫 응답(`/tools/san-storage`, 86 스위치 · 7일 집계)은 약 5.8초 — 화면은 60초 폴링(`usePolling`) · `timeoutMs 90000` 이라 넘치지 않는다.
- 메인 스크린샷 판독에서 찾은 결함과 고친 것(측정 보고에는 '넘침 0' 으로만 잡혔던 것 — v2.780 선례처럼 **표 안 가로 스크롤 밖의 열은 결함**으로 본다):
  1. 1440 현황 표가 오른쪽 25~70px 잘려 '7일 대비 · 용량 · 상태' 열이 스크롤 밖 → '포트' 열을 없애고 스토리지 보조줄(벤더 · 시리얼 · 포트 수, 속도는 title)로,
     24시간 평균/피크를 두 줄로, 스파크 120→88px · 사용률 막대 120→92px · 셀 패딩 9/10→8/8 · `minWidth` 1120→1040. 실측 표 1154 = 틀 1154(잘림 0) · 보조줄 말줄임 0/30행.
  2. '읽은 곳' 알약이 데모에서 '계산 —' → `computedAt` 이 없으면 그 조각을 뺀다(값이 없으면 단위 · 표시를 붙이지 않는다).
  3. 편중 경고 카드의 '디렉터별 보기 →' 링크가 배경과 대비가 낮음 → `.sst-alert a { color: var(--mint) }`.
  4. 1440 상세 포트 표(그리드 오른쪽 1fr 칸 589px)가 27px 잘림 → 열 8→6 병합(디렉터 · 어레이 포트 / 스위치 : 포트 / 속도 / 평균 / 최고 / 피크 포화도) + 그리드 1.2fr→1.4fr. 실측 632 = 632.
  5. 분류 매핑 탭 알약이 0 → 매핑 라우트 응답에 `counts` 가 빠져 있었다(화면은 `data.counts` 를 읽음) → 서버에 `counts: b.counts` 추가. 재확인 '어레이 3 · 호스트 51 · 미확인 1'.
- 결함이 아닌 것: 400px `#/tools/san-switch` 에서 측정 스크립트가 'SAN 스위치 모니터링' 글자를 120초 안에 못 찾은 것은 **스크립트의 첫 일치가 접힌 사이드바 라벨(숨김)** 이어서다 —
  본문 h1 에 같은 글자가 있고(DOM 확인 · 3곳) 넘침 0 · 오류 0. 기존 화면 회귀가 아니다(A/B 생략 — DOM 근거로 충분).
- 데모 어레이 수가 첫 측정 3대 → 뒤 측정 30대로 달랐던 것은 목 서버 기동 직후 표본이 쌓이기 전이어서로 보인다(데모 합성이 시간 함수) — 실장비와 무관 · 미검증 추정.
- 스크린샷(세션 스크래치패드 · 저장소에 넣지 않음): `sst-{1440,400}-{list,detail,check,mapping,sanswitch}.png`.
- 전량 verify(Sonnet · 23:40~23:52 KST) 실패 7건과 조치(00:05~00:15 KST · 2026-11-09):
  6. 성능 점검 판정표(11열)가 규칙 표와 나란히(1.6fr) 있어 1440 에서 78px 잘림(어레이 측 열이 스크롤 밖) → 두 표를 세로로 쌓고 항목 머리글을 두 줄까지 접음(`.sst-judge th.c`) · 스토리지 칸은 현황 표와 같은 보조줄. 실측 1154 = 1154.
  7. 규칙 표 · 기준 설정 모달의 날 `<table>` 2개(audit2575 IMP-05 — 모든 표는 STable) → `STable`.
  8. '설정 › 수집 › SAN 스위치 포트 사용량' 은 v2.916 이전 묶음 이름(settingsMenu2905) → '설정 › 수집 주기·임계 › …'.
  9. 시험의 절대 시간 단언 `< 200ms`(audit2613h — CPU 에 따라 깨진다) → 200자 대 2만 자 처리 시간 **비율**로.
  10. 상세 화면의 수제 `setInterval` 폴러(audit2613b — 폴링은 usePolling) → `usePolling` 으로. 과거 창은 자동 갱신이 없어야 하므로 `usePolling` 에 **`intervalMs ≤ 0 = 1회만`** 을 더했다(`web/src/api.js` · 탭 가시화에도 다시 읽지 않음).
  11. `await putJson(...)` 반환값을 버리던 저장 2곳(audit2727e E-01 — 400 `{ok:false, reason}` 을 성공으로 지나간다) → `r.ok === false` 면 사유를 보여 주고 멈춤.
  - `bmIdle8b` · `bmPower8b` 2건은 이 가지가 손대지 않은 베어메탈 시험(시각 의존 — main 이 그사이 `bmPower8b` 를 고쳤다 · 234be5df). main 병합 뒤 전량 재실행으로 확인한다.
- **번호 정정**: 구현 중 main 이 **v2.947.0**(베어메탈 — 같은 서버 키 정리 · PR #975)을 먼저 썼다. 이 작업은 **v2.948.0** 이고, 이 문서 · 코드 머리말 · 규칙 문서 · 시험 파일 이름(`sanStorage2948*.test.js`)의 v2.947 표기를 v2.948 로 일괄 바꿨다(main 쪽 v2.947 기록은 손대지 않음).

### 8.2 ⓑ 어레이 측 성능 + 후속(v2.952.0 — 2026-11-09 08:35~ KST · 사용자 "남긴것들 만들어줘" → 범위 '전부' · 검증 '표준')
- **수집은 새 DB 를 만들지 않고 노드 부하 5분 표본 경로를 재사용했다**(§4.2 의 `storage-perf.db` 계획을 바꿈 — 근거: 표 · 보존 · 시간/일 롤업 · 엣지 push 고리 · 중앙 정제 · 조회 API 가
  이미 있고 '복제 금지' 규칙). 지표 열 `hbps`(호스트 처리량 B/s) · `queue`(큐 깊이 사용률 %)를 더하고(`node_load_*` 세 표 ALTER · 문장은 `NODE_LOAD_METRICS` 에서 생성), 단위 이름은
  `node_unit` 표(id = 이름의 FNV 해시 31비트 · 종류 fa/node/sp/port · 부모)로 둔다. 묶음 `fe` = busy · cpu · iops · lat · hbps · queue.
- 수집기 `storage/collectors/arrayPerf.js` — PowerMax `performance/FEDirector/keys → metrics`(디렉터마다 POST · 전체 지표 거부 시 핵심 3개) · PowerStore `metrics/generate`
  노드 + `fc_port` 포트 · Unity `metricValue`(cpu.summary · fibreChannel.target 누적 → 최신 두 항목 델타). 폴러 `nodeLoadPoller.js` 가 REST 어레이(토글 `nodeLoadEnabled` 기본 켬)를
  같은 5분 주기 · 시한 · 인증 정지로 돈다. **실장비 미확인** — 파서는 전부 순수 함수 + 픽스처 시험이고 `probe` 가 읽은 필드 · 오류를 남긴다(캡처가 오면 파서만 맞춘다).
- SAN 쪽 조립 `sanswitch/arraySide.js`(순수) + `arraySideLoad.js`(DB): 시리얼로 짝(PowerMax 여러 어레이는 `<시리얼>::FA-1D` 접두) · 이름 정규화 비교로 SAN 디렉터 묶음 · 포트와 대조 ·
  최신(null 은 덮지 않음 · 주기 ×3 오래됨) · 창 시계열(26시간 원시 · 8일 1시간 · 그 위 하루) · 요약(합은 부모 전부 읽었을 때만) · 보고 대조(차이 % · 스위치 0.5Gb/s 미만이면 없음).
  `/array` 응답 `arraySide` · `/check` 는 어레이 측 5항목을 **판정**(값 없으면 unknown 에 사유 — 짝 없음 · SSH · 토글 꺼짐 · 표본 없음 · 오래됨 · 지표 없음).
- 화면: 상세 ② 패널(지표 세그 · 단위 카드 + SAN 대조 배지 · 선 차트 · 포트 표 · 보고 대조 문장 · 미해결 알람 링크 → 스토리지 모니터링) · 점검 탭 '어레이 측 값 N/M' 알약.
- 후속 같이 넣은 것: (C) 조닝 별칭 폴백 — port_meta WWN → 장비별 최신 스냅샷 zone 별칭(`attribution.buildFabrics`) → `directorOf(name, {alias})` · (D) 기준 설정 슬라이더(숫자 칸과 같은 상태) ·
  (H) ISL 단서 — 어레이가 물린 스위치 E-포트 24시간 피크 포화도를 팹 비대칭 문구 · 상세 `isl` 에(판정 불변) · (I) 미해결 알람 수(`capacityIndexFor` 에 alerts · collectedAt · agent · 토글) ·
  (L) Unity · PowerStore 포트 단위(kind port · 64 상한 안에서 부모 먼저) · (B) `bmIdle8b` 시각 의존 시험 고침(main 결함 — 포탈 하루 안쪽 기준 시각).
- 데모: 스토리지 데모 어레이의 시리얼을 같은 법인의 SAN 데모 어레이 시리얼로 맞췄고(`sanDemoArraySerial`) FE 표본 30일을 백필한다(최근 48시간 5분 · 그 앞 1시간) —
  목 서버에서 상세 ② · 점검 어레이 측 항목이 채워진다(기동 뒤 첫 스토리지 수집까지 약 40초는 '시리얼 불일치' 로 보인다 — 데모 한정).
- Chromium(목 서버 · 1440/400 · 10:40~10:52 KST): 현황 · PowerMax 상세(② 패널 5지표 · 카드 2 · 선 차트 · 보고 대조) · Unity 상세(7일 · 포트 표 4행 · SAN 포트 대조) · 점검(알약 '어레이 측 값 6/30') ·
  기준 설정 모달(슬라이더 14개 — 슬라이더를 42 로 움직이면 숫자 칸이 42) 모두 가로 넘침 0 · pageerror 0 · console error 0 · 1440 표 잘림 0. 스크린샷은 스크래치패드(`sst-b2-*.png`).
- 정직: PR ⓑ 의 벤더 응답 필드는 문서 · 공개 예제에서 가져온 추정이다. 특히 PowerStore `cpu_utilization` · Unity `fibreChannel.target.*` 이력 수집 켜짐 여부는 장비에서 확인해야 한다
  (`probe.fields` · `probe.counterNote`). 시험 ⑦ 은 실제 라우트를 돌리지만 표본은 합성이다.

### 8.3 2차 — 알림 · 자기 기준선 · 월간 보고서 · 공개 API · 용량 × 성능(v2.953.0 — 2026-11-09 · 같은 요청의 2차 PR)
- (E) 알림 `sanswitch/storagePerfNotifyStore.js`(순수 — 설정 · 상태 · `diffCheck` · `alertsOf`) + `storagePerfNotify.js`(실행기 — `alerts.notify` · 적응 타이머 하한 5분 · 중앙만):
  현황 · 점검과 **같은 함수**(`buildListCore → runCheck`)로 판정해 어레이별 스냅샷을 두고 직전과 비교한다 — **상태가 바뀐 순간만**(파트 장애 규약) · 법인 단위 묶음(`san-storage:<dc>`) ·
  unknown · na 는 수준이 아니라 올리지도 내리지도 않는다 · `collect` 항목의 ok → unknown 은 '보고 끊김' 으로 올린다 · 첫 비교는 기준만(`action: 'baseline'`) · 엣지는 보내지 않는다.
  설정 `san-storage-notify.json` · 상태 `-state.json`(손상은 preserveCorrupt). 라우트 `GET /notify` · `PUT /notify-settings` · `POST /notify/run-now`.
- (F) 자기 기준선 `sanswitch/storageBaseline.js`(순수) — 창 시작 전 4주의 어레이 합 시계열을 요일 × 시간 칸으로 접고(`foldBaseline` · 포탈 하루 오프셋), 창의 각 칸을 같은 칸 평균과 비교해
  허용 폭(기준 설정 `baselineTolerancePct` · 기본 50 · null 이면 끔) 을 벗어나면 `off`. 표본 3개 미만 칸 · 차이 0.5 Gb/s 미만은 판정하지 않는다(`minSamples` · `minAbs`). `/array` 응답 `baseline`
  (`applicable · marks · summary · reason`). 화면: 선 차트의 고리 표시 + 범례 '평소와 다름 n/m칸' · 히트맵 칸 테두리(`foldHeatmap(..., marks)` 가 칸마다 `off` 수를 센다).
- (G) 월간 보고서 `sanswitch/storagePerfReport.js`(순수 — 설정 정규화 · `monthlySlot` · `planMonthlyTick`(none/send/missed/rebase · 유예 30분 · 몰아서 보내지 않음) · `buildReportModel` ·
  `renderReportHtml`(자급형 HTML · 스크립트 없음 · 인쇄 CSS · 절마다 가로 스크롤) · `reportMailParts`) + `storagePerfReportMail.js`(실행기 60초 틱 · 메일 종류 `san-storage-report`).
  **PDF 는 직접 만들지 않는다**(v2.953 당시 기록 — ⚠ v2.954 정정: '저장소에 PDF 생성기 · 한글 글꼴이 없다' 는 **틀렸다**. 웹에 jsPDF + Pretendard KS X 1001 서브셋(`reportExport.saveDocAsPdf` · SAN 월간 점검이 이미 씀)이 있었고 §8.4 에서 화면 PDF 를 붙였다. 서버 쪽 생성기가 없는 것만 맞다. 브라우저 인쇄 → PDF 로 안내). 라우트 `GET /report` ·
  `PUT /report-settings` · `GET /report/preview`(HTML · `?format=json`) · `POST /report/send-now`(SMTP 꺼짐 · 실패면 409 — 보냈다고 말하지 않는다).
- (J) 공개 API — 허용 목록 분류 `san` · `/san-storage/arrays` · `/san-storage/check`(`requiresFullScope` — 범위 지정 키는 게이트에서 403 `needs-full-scope`). 처음엔 핸들러를 404 catch-all
  **뒤에** 등록해 닿지 않았고(시험 ④ 가 잡았다), 범위 거절도 핸들러 안에 한 벌 더 두었다가 게이트 하나로 합쳤다(판정 코어 하나).
- (K) 용량 × 성능 교차 보기 — `growthLookup`(storage `dailySeries + growthMatrix` 30일 · 10분 기억 · DB 없으면 전부 null)을 현황 행 `growth` 에 붙이고 웹 `CrossView` 가 표시 규칙
  `QUADRANT_RULE`(용량 80% · 회선 20%)로 사분면 라벨을 적는다 — **판정이 아니라 표시**(각주). `daysToFull` 은 growth.js 의 `{days, basis}` 객체를 그대로 내보내 '—' 로만 보이던 것을
  일수(숫자)로 고쳤다(Chromium 에서 발견). 짝이 없으면 '—'.
- 시험 `test/sanStorage2953.test.js`(기준선 · 알림 저장소 · 보고서 순수 · 실제 라우트 — 알림 run-now baseline → quiet · 보고서 미리보기 HTML/JSON · 보내기 409 · 공개 API 키 3종) ·
  웹 `sanStorage2953.test.js`(히트맵 marks · 사분면 · 소스 규약 — 모달은 PUT/POST 반환값 확인 · 날 table 없음 · 훅은 조기 return 위).
- Chromium(목 서버 · 1440/400 · 11:25~11:34 KST): 현황 교차 보기(30대 · 사분면 알약 · 소진 예상 일수) · 상세(기준선 범례 '평소와 다름 0/97칸' — 데모는 벗어난 칸이 없어 고리 표시 자체는
  단위 시험으로만 확인) · 점검 '알림' · '월간 보고서' 모달 · 보고서 HTML 1440/400 — 가로 넘침 0 · pageerror 0 · 1440 표 잘림 0(보고서 HTML 직접 열기의 console 404 는 `/favicon.ico`).
  판독에서 고친 것: 보고서 '판정 기준' 표가 기본값을 전부 '비움' 으로 적던 결함(`settings.items` 에는 정의만 있고 값은 `settings.values`) · 보고서 400px 넘침 557px(절마다 `overflow-x:auto`) ·
  현황 상태 알약 400px 잘림(PR ⓐ 때부터 — 600px 이하 줄바꿈).
- 정직: 알림 · 보고서의 발송은 시험에서 SMTP 가 꺼져 있어 '보내지 않음(409 · skipped)' 경로만 실행했다 — 실제 메일 본문 · 첨부는 `reportMailParts` 단위 시험과 미리보기로 확인. 기준선은
  데모 데이터(수식)라 벗어난 칸이 생기지 않았다.

### 8.4 3차 — 남은 작업 일괄(v2.954.0 — 2026-11-09 16:13~ KST · 사용자 "권장 순서로 진행해줘" → "대기작업 모두 수행" · 검증 '표준')
- **점검 결과 이력** `sanswitch/storageCheckHistory.js` — SAN 점검 이력(healthHistory)과 같은 규약(`san-storage-check.db` · node:sqlite 없으면 available:false · 어레이당 48건 · `compareRuns` 재사용).
  '1회' 의 정의가 다르다: 스토리지 판정은 창(24시간 평균 · 최근 표본)을 보므로 '수집 1회 = 기록 1회' 가 없어 **판정이 바뀌었거나 마지막 기록에서 1시간**이 지났을 때만 적는다(`shouldRecord`).
  기록은 알림 틱(알림이 꺼져 있어도 · 중앙만)과 점검 탭 '지금 판정'. 1시간 반복 기록 때문에 '마지막 두 건' 비교가 변화를 놓치므로 `lastChangeOf` 가 최신부터 서명이 달라지는 첫 쌍을 찾는다.
  라우트 `GET /check/history`(key 없으면 어레이 목록 + 최근 7일 변화 · key 있으면 최근 N회 + 비교 + 마지막 변화) · 점검 탭 '이력' 모달.
- **운영 안내** `docs/OPS-SAN-STORAGE.md`(INDEX §1) — 준비 순서(시리얼 · REST · 표본 토글 · 캡처) · 화면 읽는 법 · 확인 불가의 뜻 · 알림 · 보고서 · 공개 API · 문제 해결 · 파일.
- **화면 4건** — ① CSV `nodeLoad` 칸을 REST 어레이(PowerMax/PowerStore/Unity)까지(`storage/csv.js exportedNodeLoad` — registry sampleCapable 과 같은 조건 · SSH 변형은 빈칸 유지) ② 상세 **임의 구간**(datetime-local 시작 · 끝 · 최대 366일 — 서버 `rangeParams` from/to 는 이미 받았다 · 구간 중엔 ◀ ▶ 잠금)
  ③ ⌘K 팔레트에 두 글자 이상이면 'SAN 스토리지 성능에서 ‘q’ 찾기' 행(검색어는 URL 이 아니라 **인계**(`useSearchHandoff('san-storage')` — v2.616 규약) · 상세 '호스트별 플로우 ↗' 는 어레이 포트 WWN(최대 8 · `portsDetail.wwn` 새 필드)을 `san-flow:targets` 로 인계해 Flow Vision 이 타깃을 미리 고른다(해시에 쿼리를 싣지 않는다 — 도구 라우터가 `?` 를 모른다)
  ④ 상세 머리 '스토리지 경로 ↗'(`storage-paths`).
- **PowerMax 포트 단위** `arrayPerf.js` — `performance/FEPort/keys → metrics`(문서 기준 · 실장비 미확인). 디렉터를 다 읽은 뒤 남는 자리에만 · 디렉터당 4포트 · 전체 24호출 상한 · 지표 이름이 디렉터와 다르다(IOs · MBs · ResponseTime — 디렉터 이름으로 와도 읽는다) · `probe.ports` 가 읽음 · 실패 · 호출 수 · 건너뜀을 말한다. 단위 이름 `FA-1D:4` → SAN 포트 `FA-1D 4` 와 `unitMatchKey` 로 짝.
- **데모 보정** — 어레이 측 호스트 처리량을 스위치 트래픽 자릿수로(전 어레이가 '보고 대조 주의 −45%' 로 보이던 것) · 해시로 고른 어레이 약 12% 에 **최근 24시간 KST 10~12시 ×2.4** 창(`sanswitch/demoPerfSynth.js demoAnomalyFactor` — 수식 데모에 Date.now() 가 들어가는 유일한 자리 · 기준선 '평소와 다름' 이 화면에 보이게).
  ⚠ 처음엔 `mock/demo/sanswitch.js sanDemoPortBps` 에 넣었다가 Chromium 에서 표시가 안 나와 확인하니 **데모 조회는 표본을 쌓지 않고 `demoPerfSynth` 가 수식으로 만든다**(v2.715) — 그쪽으로 옮기고 샘플러 쪽은 되돌렸다.
- **발송 경로 시험** — 가짜 SMTP(net 서버 · audit2742g 방식)로 월간 보고서 '지금 보내기' 와 알림 틱(상태 전이 → alerts.notify → 메일)을 실제로 보내 봤다(아래 시험 ⑤). **결함 발견**: v2.953 의 보고서 첨부가 `contentType: 'text/html; charset=utf-8'` 이라 `util/smtp.js` 화이트리스트(`^[a-z]+/[a-z0-9.+-]+$`)에 걸려 '지금 보내기' · 정기 발송이 **항상 실패**했다(알림 메일은 첨부가 없어 무관). `'text/html'` 로 고침 — v2.953 보고의 '보내지 않음 경로만 시험했다' 가 왜 부족했는지의 실례. `storagePerfReportStatus` 를 edgelog spec `service.sanStorageReport` 로 등재.
- **보고서 PDF(화면)** — `reportPdfDoc`(순수 · `sanStorageText.js`) → `reportExport.saveDocAsPdf`(jsPDF + Pretendard KSX 벡터 · 동적 import). 임베드 글꼴이 KS X 1001 서브셋이라 ✕(U+2715) 대신 ×. 파일명 ASCII(`san-storage-report_YYYY-MM.pdf`). 메일 첨부는 HTML 그대로(서버 생성기 없음).
  ⚠ **정정**: v2.953 보고의 'PDF 라이브러리 · 한글 글꼴 부재' 는 웹 쪽을 보지 않은 틀린 말이었다(SAN 월간 점검 PDF 가 이미 같은 인프라를 쓴다 — `docs/rules/sanswitch.md` v2.52x 항목).
- **v2.953 결함 2건 발견 · 고침**(Chromium · 가짜 SMTP 가 잡았다): ① 요일 × 시간 히트맵의 '평소와 다름' 테두리는 **한 번도 나올 수 없었다** — 7일 요청이 2시간 칸(85점)으로 내려와 서버가 기준선을 붙이지 않았다(reason 'bucket'). `/array` 에 `points` 를 더하고 화면이 `points: 168`(1시간 칸)로 요청한다. ② 월간 보고서 메일 첨부 형식(위).
- 시험 `test/sanStorage2954.test.js` · 웹 `sanStorage2954.test.js`. `storageNodeClients2936` ⑨ 의 'nodeLoad 칸은 아이실론만' 기대를 REST 어레이 포함으로 갱신.
- Chromium(목 서버 · 1440/400 · 16:43~17:03 KST): 이력 모달(어레이 3대 기록 · 비교 · 표) · 상세 임의 구간(시작 · 끝 → '임의 구간 · 11/9 04:55 ~ 07:55' · ◀ 비활성) · 기준선(PowerStore::PS667B96EC — 범례 '평소와 다름 8/97칸' ·
  차트 고리 8개 · 히트맵 테두리 2칸 + 각주) · 보고서 'PDF 로 저장'(실제 내려받기 `san-storage-report_2026-10.pdf` 43,994바이트 · `%PDF-`) · ⌘K 'SAN 스토리지 성능에서 ‘PMAX’ 찾기' 행(누르면 현황 검색 칸에 PMAX) ·
  '호스트별 플로우 ↗' → `#/tools/san-flow` — 가로 넘침 0 · pageerror 0 · console error 0 · 1440 표 잘림 0. 판독에서 고친 것: ① 상세가 통째로 깨짐(`const live = live && !custom` — 치환이 새 줄까지 바꿔 TDZ ·
  CLAUDE.md '치환 뒤 전수 확인' 교훈 재발) ② 히트맵 테두리 0칸 → 7일 요청이 2시간 칸이라 기준선이 안 붙던 v2.953 결함 → `points: 168` ③ 데모 이상치가 안 보임 → 수식 데모 경로(`demoPerfSynth`)로 옮김
  ④ 팔레트 행이 목록에만 들고 그려지지 않음 → 기능 목록(`toolRowsAll`)에 넣음. 스크린샷은 스크래치패드 `shots3/`.
- 남긴 것: 실장비 캡처 확인(PowerMax FEPort 포함) · 메일 첨부 PDF(서버 생성기 — 별도 결정).

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
8. **월간 성능 점검 PDF 자동 발송** — ⑥ 판정표 + 상위 어레이 추이(월간 점검 PDF 인프라 재사용). → v2.953 메일 첨부 HTML · v2.954 화면 'PDF 로 저장'(같은 벡터 PDF 인프라). 메일 첨부 PDF 는 서버 생성기가 없어 아직 아니다.
9. **ISL 사용량 연계** — 팹 비대칭의 원인 단서(헬스체크 ISL 항목 + 포트 사용량의 E-포트).
10. **어레이 측 경보 연동** — 스토리지 수집기가 이미 세는 알람 수를 상세 ② 머리에(링크 → 스토리지 현황).
11. **publicapi 노출** — `/api/public/san-storage/...`(외부 모니터링 연동 · 기존 publicapi 토큰 규약).
12. **용량 × 성능 교차 보기** — 스토리지 증가량(`growth.js`)과 디렉터 처리량 추세를 한 표에(증설 판단 — '찼는데 한가함' / '바쁜데 여유').
13. **Unity · PowerStore 포트 단위 어레이 측 지표**(`performance_metrics_by_fe_fc_port` · Unity fePort) — 1차는 노드/SP 단위까지.

### 12.3 문서
- 저장소: `docs/rules/sanswitch.md`(스토리지 성능 도구 · 디렉터 해석 · 매핑 · 점검 기본값 출처) · `docs/rules/storage.md`(디렉터 · 노드 · SP 수집 · 누적 카운터 델타) · `docs/API.md` 재생성(`scripts/api-doc.mjs`) · `docs/CONFIG-FILES.md` 재생성(`config-doc.mjs` — `san-storage-map.json` · `storage-perf-check.json`) · 운영 안내 `docs/OPS-SAN-STORAGE.md`(캡처 · 임계값 설정 · 판정표 읽는 법 · '확인 불가' 의 뜻) · 릴리스 노트에 '첫 반영에서 어레이 측 칸이 비어 있을 수 있는 이유'.
- 확보해야 할 외부 문서: Unisphere for PowerMax REST 문서(장비 로컬 `https://<unisphere>:8443/univmax/restapi/docs` — FEDirector 절) · PowerStore REST API Developers Guide(dell.com/powerstoredocs — `metrics/generate` 응답 스키마) · Unity Unisphere Management REST API Programmer's Guide + Performance Metrics 백서 H15161 · 운영 중인 FOS 버전의 MAPS User Guide(기본 임계값 표) · Broadcom SAN Design and Best Practices 53-1004781.
