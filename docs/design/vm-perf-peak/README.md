# 설계: VM 성능 그래프 — 포탈 20초 Peak 겹쳐 보기

작성 2026-11-10 10:23~ (main v2.957.0 기준 · 브랜치 `claude/happy-keller-ghpe4z`) · 상태 **시안 · 컨펌 대기**.
시안 캔버스: https://claude.ai/artifact/PeR2Q9WR6a86zphTqegyMA (아트보드 1장 — ① 성능 화면 1440 · CPU · 24시간 30분 평균 위에 Peak 겹침 + 상태 6종 + 데이터 메모).
이 폴더의 `Main.dc.html` 이 같은 내용의 레퍼런스(HTML 프로토타입 — 복사 대상이 아님). **VM · vCenter 이름과 수치는 전부 가상**이다(첨부 캡처의 실명은 쓰지 않았다).
규칙(2026-11-03 ‘기억해’): 설계는 Fable + Claude Design 시안 → **컨펌 뒤** 구현. §2 는 이 세션(Fable)이 코드로 확인한 사실이다.

## 1. 요구(사용자 2026-11-10 10:22 KST)

> "VM 성능 차트 볼때 기존에 포탈에서 수집하는 peak 를 보여주는 기능 추가 — 시안 설계해서 보여줘"

첨부: VM 개체 보기 › 모니터 › 성능(LESAAHMPS01 · 24시간 · 30분 평균 · 48점 · CPU 17% · 최대 17.1%). 30분 평균이라 20초 단위 피크가 보이지 않는다.

## 2. 지금 코드에서 확인한 것(설계의 근거 — 10:23~10:29)

| 사실 | 위치 |
|---|---|
| 성능 화면(`VmPerfView`)은 vCenter 롤업만 그린다 — `GET /vms/:id/metrics?types=cpu,mem,disk,net&interval=…` · 4지표 1회 · 결측은 선 끊음 · 과부하 기준선 · 과거 창(◀ 슬라이더 · 날짜) · 구간 요약 표. 문구 "포탈은 시계열을 저장하지 않습니다" | `web/src/components/vmperf/VmPerfView.jsx` · `vmPerfText.js` |
| **포탈이 수집하는 Peak = 실시간 스파이크 수집(vmseries, v2.510)**: 50분마다(설정 · 20~60분) vCenter 실시간 20초 표본(최근 1시간 · 180개)을 읽어 **트리거(CPU 50% · 메모리 50% · Ready 5%/vCPU — 설정값) 이상인 순간만** 저장한다. 저장 단위는 ‘순간’ — 그 시각의 카운터 10개 전부(cpu% · MHz · ready · mem% · active · consumed · balloon · swapped · diskKBps · netKBps). 기본 **꺼짐(opt-in)** · 대상 all/selected · 보존 60일 · vCenter 마다 DB 파일 · 엣지 위임 vCenter 는 엣지가 수집해 중앙에 push | `server/src/vmseries/{counters,settings,poller,db,query}.js` · `docs/rules/vcenter.md` 항목 "실시간(20초) 스파이크 수집" |
| 이 값을 읽는 API: `GET /tools/vmseries/local?vmId=&days=7|30|90|180|365` → `moments[]`(3000점 넘으면 버킷 최대만 · `downsampled` · `momentCount`) · `peak.{cpuUsagePct,memUsagePct,cpuReadyPct,…}{v,t}` · `runs{count,maxSec,totalSec}` · `freq[]`(버킷별 최대 · measured) · `coverage{pct,hours[],unmeasuredHours}` · `thresholds` · `settings{enabled,intervalMin,retentionDays}` · `lastPollAt` · `synthesized`(목). DB 없으면 `available:false reason:'no-db'`, 표본 없으면 `empty:true reason:'no-samples'` | `server/src/routes/api/vmSeries.js:265` · `vmseries/query.js localReportFor` |
| 권한: `/tools/vmseries/*` 는 도구 키 **`waste`**(자원 축소 근거 리포트 묶음)로 집행된다(`toolAccess.js` `vmseries: 'waste'`) · 범위 밖 VM 404 | `server/src/auth/toolAccess.js:135` |
| 지금 이 값을 그리는 화면은 자원 축소 근거 리포트의 Local 섹션뿐 — 주황 작은 점(r 1.8 · 반투명) · 커버리지 띠(미측정 = 회색) · ‘스파이크 0 ≠ 미측정’ 문구 · 20초 최대 vs 롤업 최대 비교(peakNote) | `web/src/views/tools/RightsizeLocal.jsx` · `views/vmSeriesText.js` |

## 3. 정직하게 밝혀야 하는 것(시안 문구에 반영)

- 점이 없는 곳은 ‘피크 없음’ 이 아니다 — **임계(50%) 미만 피크는 저장하지 않았고**, 미측정 시간(수집 꺼짐 · 실패 · 시작 전)도 비어 있다. 타일 Peak ‘—(임계 미만)’ · 빗금 ‘미측정’ · 커버리지 띠 회색을 구분한다.
- 디스크 · 네트워크는 트리거가 아니다 — ‘Peak 순간의 값’(CPU · 메모리 · Ready 임계 순간에 함께 남은 값의 최대)으로만 말한다(†).
- 실시간 1시간 보기는 vCenter 가 이미 20초 값을 준다 — 겹치지 않는다(토글 비활성). 1년 보기는 보존(60일) 밖이라 겹치지 않는다.
- 숫자(임계 · 주기 · 보존 · 커버리지 · 마지막 수집)는 전부 응답값으로만 말한다 — 화면에 박지 않는다.
- Peak 는 표시 · 경보용이다 — 자원 축소 권고 산정에는 쓰지 않는다(리포트 규약 그대로).

## 4. 화면(IA) — 아트보드 ①

1. **머리 줄**: 기존 pill(30분 평균 · 48점 · 읽은 시각) 옆에 주황 pill `포탈 20초 Peak · 임계 50% · 관측 22/24시간 · 50분마다 · 마지막 수집 10:05`.
2. **타일 4**: 값 아래 **Peak 줄**(주황) — CPU `20초 Peak 97.2% 02:05:40 · vCenter 최대 71%(30분 평균)` / 메모리 `— · 임계 50% 이상 순간 없음` / 디스크 · 네트워크 `Peak 순간의 값 …`. 스파크에 Peak 위치 삼각 표식.
3. **차트 카드**: 머리에 토글 `포탈 20초 Peak 겹치기 · 켜짐`(aria-pressed) · 범례 +3(주황 점 · 수집 임계 50% 점선 · 미측정 빗금) · 차트에 주황 점(r 1.8 · 반투명) · 최대 순간 삼각 + 라벨 `Peak 97.2% · 02:05:40` + 같은 30분 평균값 비교 · 미측정 구간 빗금 · 축 아래 **커버리지 띠**(시간 셀 24 — 관측 초록 · 미측정 회색 · 임계 이상 순간 수만큼 주황 채움). 점에 마우스 → 툴팁: 그 순간의 CPU · Ready · 메모리 · 디스크 · 네트워크 + 같은 30분 평균 + run 지속.
4. **구간 요약 표**: 열 +3(`20초 Peak` · `Peak 시각`(초까지) · `임계 이상 순간 · 지속`) — 주황 배경 묶음 · 각주 *(30분 평균 기준) †(트리거 아님).
5. **상태 6종**: ① 수집 대상 아님 · 꺼짐(no-db — 토글 ‘없음’ + 설정 링크는 관리자만) ② 창 안 표본 없음(no-samples — ‘스파이크 0 ≠ 미측정’) ③ 권한 없음(토글 · 열 · 띠 숨김 + 한 줄) ④ 실시간 1시간(토글 비활성) ⑤ 7일 · 30일 다운샘플(버킷 최대만 · 1년은 겹치지 않음) ⑥ 데모 · 엣지 위임(배지 · push 시각).
6. **400px**: 점 r 1.4 · 띠 유지 · 타일 Peak 줄 두 줄 · 툴팁 아래 고정(1차 400px 규칙 그대로).

## 5. 데이터 · 서버(새 수집 없음 — 있는 것을 겹칠 뿐)

- 추가 호출 1: `GET /tools/vmseries/local?vmId=…&start=…&end=…` — 지금은 `days` 만 받으므로 **start · end 를 더한다**(창과 같은 구간 · 서버 변경은 이 한 가지 · `days` 는 그대로 둔다). 토글을 켤 때 1회 · 창을 옮길 때마다 1회 · 15초 폴링 없음 · 늦게 온 응답은 버린다(요청 번호).
- 점의 x 는 vCenter 선과 같은 창(start~end)으로 계산 · 겹쳐 보기(CPU+메모리)는 지표별 색 점 · 디스크+네트워크는 † 로만.
- 판정 · 문구 한 벌: `views/vmSeriesText.js`(localPhase · coverageText · peakNote — 리포트와 같은 것) · `numOrNull` 결측 규약 · 임계 미만을 0 으로 말하지 않는다.
- 권한: 지금은 `waste` 도구 키 — 성능 화면에서 Peak 를 보는 사람이 자원 축소 도구 권한을 가져야 하는 셈(열린 질문 ②).

## 6. 컨펌 질문(기본값 — ‘기본값대로’ 면 이대로 구현)

1. **기본 켜짐**인가(기본값: 켜짐 — 수집이 있으면 바로 보인다 · 브라우저가 토글을 기억) vs 기본 꺼짐.
2. **권한**: 지금처럼 `waste` 도구 권한자만(기본값) vs 성능 화면 전용 완화(`inv.vms` 로 읽기 — 서버 라우트 하나 추가).
3. **Peak 를 알람 · 신호로도** 쓸지(예: ‘20초 Peak 90% 이상 N회’ 를 VM 신호에) — 이번 범위 밖(기본값: 표시만).
4. 겹쳐 보기(CPU+메모리)에서 두 지표의 점을 모두 그릴지(기본값: 그린다 — 색으로 구분) vs 고른 지표 점만.
5. 검증 수준(구현 때): ① 전체 ② 표준(관련 테스트 + Chromium 1회 — 기본값) ③ 빠르게.

## 7. 구현 메모(컨펌 뒤)

- 웹: `VmPerfView.jsx` 에 Peak 상태(토글 · 응답 · 로딩 · 오류) · 점 path(한 path 에 원 여러 개 — 수백 점에서 DOM 수를 늘리지 않는다) · 커버리지 띠 · 툴팁 분기 · 표 열 3 · 타일 줄 · 순수 보조는 `vmPerfText.js`(peakModel · peakText · coverageCells 재사용) — vitest.
- 서버: `routes/api/vmSeries.js` `/tools/vmseries/local` 에 `start` · `end`(ISO · 창 길이 상한 = 보존 기간) · `query.js localReportFor` 에 `{start,end}` 인자 — node:test(순수 + 실제 라우트 scope 404).
- 목(`vmseries/mock.js`): 창 안 순간을 만들어 데모에서도 점이 보이게(synthesized 배지).
- Chromium 1440/400: 성능 탭(토글 켜짐 · 꺼짐 · no-db · no-samples) — 오류 0 · 가로 넘침 0.
