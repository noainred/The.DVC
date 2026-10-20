# 규칙 — 데모(mock) 모드·데모 계정

> 루트 `CLAUDE.md` 에서 옮긴 기록(2026-10-20, v2.746 시점). 문구는 원문 그대로이고 목록 들여쓰기만 한 단계 줄였다. "되돌리지 말 것" 규칙은 그대로 유효하다 — 이 영역 코드를 고치기 전에 이 파일을 읽을 것. 새 교훈은 테스트 → 이 파일 순으로 남기고 루트 CLAUDE.md 에는 쌓지 않는다.

**언제 읽나**: server/src/mock/ · auth/demoGuest.js

## 목차

- (원래 5533행) v2.715 — SAN 사용량: 목업 데모 장비는 수식 값 · 1분 넘는 조회는 조회 엔진만 재시작
- (원래 5541행) v2.716 — mock 모드 내장 데모 계정은 '설정 뺀 조회 전부 + 안전한 실행만'. 판정은 `server/src/auth/demoGuest.js` 하나
- (원래 5548행) v2.716 데모 데이터 보완 1회차
- (원래 5552행) v2.717 데모 데이터 보완 2회차
- (원래 5554행) v2.718 데모 데이터 보완 3회차
- (원래 5667행) v2.708 — 데모(mock) 모드는 '특수 기능 전체가 동작' 이 목표다 — 규칙은 `server/src/mock/demo/flags.js` 머리말

## 본문

- ⚠⚠ **v2.715 — SAN 사용량: 목업 데모 장비는 수식 값 · 1분 넘는 조회는 조회 엔진만 재시작**(`sanswitch/demoPerfSynth.js` + `perfDb.js heavyQuery` 감시 +
  웹 `SanSwitchV2Parts.jsx` 대기 안내, 사용자 지시 "mock 모드 SAN 모니터링이 멈춘다 · 랜덤 숫자로 채우기 · 1분 넘으면 재시작해 전체 서비스 복원". 회귀 `server/test/sanDemoPerf2715.test.js`·`stall2713.test.js` — 변이 검증):
  · 수식 경로는 **mock 모드 + 장비 전부 `mock-san-`** 일 때만이다(`isDemoPerfQuery`). 사람이 등록한 장비가 하나라도 섞이면 예전처럼 DB 를 읽는다. 응답 모양은 실제 집계와
    같아야 한다(화면·trafficTotal 이 그대로 쓴다) — 집계 응답에 필드를 더하면 합성 쪽도 더할 것. 데모 장비 표본은 적재하지 않는다(포트 정보만) — `latestSampleTs` 는 데모 장비에 '지금' 을 준다.
  · 감시(`SANSW_PERF_QUERY_MAX_MS`, 기본 60초·하한 10초): 넘긴 조회는 `query-restarted` 로 실패, 취소 세대를 올려 진행 중 집계가 다음 양보 지점에서 멈추고, 기억한 결과를 버리고,
    DB 핸들을 다시 연다. **포탈 프로세스를 재시작하지 않는다** — 집계가 양보하며 돌아 다른 화면은 살아 있고, 프로세스 재시작은 모든 세션·폴러를 끊는다. 감시는 양보 지점이 있어야
    동작한다(동기 SQL 한 문장 안에서는 끊지 못한다 — v2.693 조각화가 전제다). 상태는 `perfQueryStats().restarts`.
  · 화면은 이 조회만 90초·재시도 0(`usePolling` 넷째 인자 `{timeoutMs, retries}` — 기본은 예전 그대로) · 대기 안내는 빨간 깜빡임(`.san2-loading-alert`, 움직임 줄이기면 정지).
- ⚠⚠ **v2.716 — mock 모드 내장 데모 계정은 '설정 뺀 조회 전부 + 안전한 실행만'. 판정은 `server/src/auth/demoGuest.js` 하나**
  (사용자 요청 "guest/demo 계정은 설정 제외한 모든 기능 가능하게" · 선택 '조회 전부 + 안전한 실행만' · '내장 데모 계정만'. 회귀 `server/test/demoGuest2716.test.js`(실제 authMiddleware · mock/live) + 웹 `demoGuest2716.test.js`):
  · 대상은 저장 레코드에 `demo:true` 인 로컬 계정 + `DATA_SOURCE=mock` 일 때만이다. 요청 문맥 역할은 `admin` + `demoGuest:true`(superAdmin·설정 소유자 아님) — live 면 예전 viewer.
  · ⚠⚠ **거부는 라우트 게이트보다 먼저 `authMiddleware` 안에서** 한다: 조회는 `READ_DENY` 접두(설정·계정·감사·백업·비밀·호스트 접근·업그레이드·원격) 밖만, 쓰기는 읽기성 POST(`auditSkipped`)와
    `SAFE_ACTIONS`(데모 데이터만 다시 만드는 수집·점검)만. **실제 호스트·네트워크에 닿는 실행(연결 테스트·배포·스캔·업그레이드·종료·방화벽·원격 명령)을 SAFE_ACTIONS 에 넣지 말 것.**
    새 설정 화면의 API 접두를 만들면 `READ_DENY` 에도 넣을 것(안 넣으면 데모 계정이 그 설정을 읽는다). WS SSH/RDP 게이트웨이는 미들웨어를 타지 않아 따로 거부한다.
  · 화면: 업그레이드 탭 `noDemoGuest` · 설정 탭은 소유자 조건으로 이미 숨는다 · 역할 칸은 '데모 계정'(admin 으로 보이지 않게).
- ⚠ **v2.716 데모 데이터 보완 1회차**(`mock/demo/svcmon.js` + `svcmon/poller.js` · `mock/generator.js` · `mock/serviceTag.js`, 회귀 `server/test/demoData2716.test.js` — 변이 4/4):
  · Monitoring(svcmon) 데모 대상은 배치 태그 `mock-demo` 로 식별하고(대상 id 는 서버가 발급) **폴러가 runBatch 에 넘기지 않고 합성 결과**를 쓴다. 응답에 '(데모)' 를 붙인다. 사람이 등록한 대상은 mock 에서도 실제 점검.
  · 목업 ESXi 호스트 `serviceTag` = `mockServiceTag(vcenterId|name)` — iDRAC 데모 시드와 **같은 규칙**이어야 한다(다르면 v2.682 R3D-04 가 같은 장비를 '다른 장비' 로 본다). 규칙은 잎 모듈 `mock/serviceTag.js` 하나.
  · 목업 VM 의 판정용 분포를 다른 판정 집합과 겹치게 두지 말 것 — 'Tools 업그레이드 필요' 가 템플릿(idx%17)과 같은 VM 에 걸려 리포트에서 언제나 0이었다.
- **v2.717 데모 데이터 보완 2회차**: VM 복제 데모 잡(`mock/demo/vmclone.js` — 잡이 비어 있을 때만 · 스케줄러 틱이 부른다 · 시드 직후 `isDue` 거짓이어야 한다,
  마지막 실행 기록이 '지금' 이라 곧바로 실행되지 않는다) · 데모 엣지 베어메탈(`mock/demo/edgeSeed.js` 가 틱마다 `setEdgeFleet` — 실제 /fleet push 와 같은 모양, watts 없음).
- **v2.718 데모 데이터 보완 3회차**: vmperf(VM 할당·사용) 과거 90일 백필(`mock/demo/vmperf.js` — 샘플러가 적재 직후 부르고 기다리지 않는다 · 그 vCenter 첫 표본이 최근 2일 이내일 때만 ·
  240시간마다 양보). 3회차 점검 결과 400px 160화면·서브탭 75개 넘침·오류 0. 데모로 채우지 않은 것: 네트워크 모니터·게스트 조사(실제 접속) · svcmon 엣지 배정 · 설정 등록부(사람이 정함).
- ⚠⚠ **v2.708 — 데모(mock) 모드는 '특수 기능 전체가 동작' 이 목표다 — 규칙은 `server/src/mock/demo/flags.js` 머리말**(사용자 요청 "특수기능 포함 모든 메뉴의 데모모드 동작"):
  · 데모 모듈 `server/src/mock/demo/`{storage,sanswitch,pdu,cvp,users,idrac,baremetal,edge,edgeSeed}.js. mock 모드에서만 · 등록부가 비어 있을 때만 `mock-` 항목 시드 ·
    장비·엣지에 접속하지 않는다(SAN 은 FOS CLI 모양 텍스트를 진짜 파서에 넣는다) · 기본 꺼짐 기능은 `demoOn(saved)` 로 켜진 것처럼(**설정 파일은 바꾸지 않는다**) ·
    live 폴러는 `mock-` 항목을 건너뛴다. 합성 수집은 **mock 모드 + `mock-` id** 에만 — 사람이 등록한 장비는 mock 모드에서도 예전처럼 수집한다(DATA_SOURCE 기본값이 mock 이라 테스트가 깨졌다).
  · ⚠⚠ **데모 데이터로 실제 알림 채널에 보내지 않는다** — 파트 장애(source 'demo')·CVP 장애·베어메탈 임계·로그인 실패 브루트포스. 새 데모 경로가 알림을 낼 수 있으면 같은 가드를 둘 것.
  · ⚠ `flags.js` 는 `runtime-settings.js` 에서 직접 판정한다 — `mock/seed.js` 를 거치면 seed → 데모 → flags 순환이 생긴다(arch2579 SCC 상한).
  · 데모 이력은 처음 한 번 백필(스토리지 400일·SAN 7일·PDU 30일·CVP 7일·iDRAC 14일·bm-usage 45일 등)하고 다시 쌓지 않는다. sensorStore 는 인메모리라 재시작마다 24시간 백필.
  · 남은 것: 준비 중 3기능(디스크 추가·백업·대용량 배포)은 화면이 없다 · serveranalysis '미지원 서버'·Isilon 영역 상세·REST 수집 SAN 은 데모 없음 · 실장비 미확인(전부 합성).
  · 함께 고친 제품 판정: 실제 OS 확인이 Windows Server 연도와 커널 버전(10.0.x)을 비교해 **모든 Windows VM 을 불일치**로 냈다(`inventory/osStore.js computeMismatch`).
  · **v2.709 2차 점검**(107개 재조사): Isilon OneFS 영역은 `demoIsilonAreas` 가 실제 수집기와 같은 모양으로 만들어 **DB 에도 저장**한다(예전 요약 2줄만) ·
    미지원 서버는 `ensureUnsupportedDemo`(저장소가 비어 있고 **법인 할당이 끝난 뒤에만**) · 데모 vCenter 의 법인 할당은 `pdu.js assignDemoCorps`
    (**mock vCenter 이고 할당이 없을 때만** — 수집 엣지의 DataCenter 우선. ⚠ 데모 엣지 등록이 'Seoul' 같은 DataCenter 를 자동으로 만들므로 'DataCenter 목록이
    비어 있을 때만' 이라는 v2.708 조건은 한 번도 참이 아니었다) · 데모 엣지는 파트 장애 보고(장비 0대)를 틱마다 싣는다 · 화면이 저장 설정으로 '꺼짐' 을
    말하는 곳(bm-usage `emptyDiag`·corp-usage `collectOn`)은 데모를 먼저 본다. ⚠ 조사 스크립트는 **기동 직후 몇 분 동안 빈 화면이 정상**이다(첫 수집 전) — 원인을 단정하기 전에 API 로 다시 볼 것.
  · **v2.710 3차 점검**(상단 탭 11 · 설정 51 · 특수 기능 100 전수 — 오류·4xx·넘침 0): ⚠⚠ **제품 결함 하나를 찾았다** — `/tools/report/capacity` 가
    async `forecastCapacity` 를 `await` 없이 펼쳐 v2.537 부터 **모든 모드에서** 리포트가 비었다(`config`·`datastores` 없이 `{listLimit…}` 만).
    **async 로 바꾼 함수는 호출부 전수를 grep 할 것** — 일회성 스윕(`export async function` 이름 × `await` 없는 `= 이름(`)으로 저장소 전체에서 이 한 곳뿐이었다.
    데모 보강: 로그 폴러 첫 수집 91일(`MOCK_FIRST_DAYS` — 가용성 90일 보기) · iDRAC 스캔 로그(`seedIdracScanLogIfEmpty` — 과거 시각은 이 경로만, 비었을 때만) ·
    VM DNS 변경 이력(`mock/demo/vmdns.js` — 바뀐 뒤 = 지금 값, 첫 관측을 변경 이전으로 당긴다) · 태그 정책(파일 없음 + mock → `demo:true` 정책, 저장하면 그 값) ·
    용량 리포트 합성 추세(`withDemoForecast` — 실제 추세가 0개일 때만, R² null). ⚠ 합성 함수에서도 `Number(null) === 0` 을 밟았다(자체 테스트가 잡았다 — `numOrNull`).
  · **v2.711 4차 점검**(400px 162 화면 + 서브탭·IP관리 70 경로): ⚠ **rAF 로 그리는 캔버스는 '화면에서 떨어진 캔버스' 를 그리지 않는다** —
    React 효과 정리는 커밋 뒤에 돌아 그 사이 한 프레임이 폭 0 캔버스로 그려져 `createRadialGradient` 가 non-finite 로 던졌다(중계 토폴로지 graph → 다른 탭.
    `cv.isConnected` + 크기 > 0 + 노드 좌표 유한 검사, 웹 `relayTopoCanvas2711.test.js`). **새 캔버스 화면도 같은 가드.**
    데모 보강: 백업 스냅샷 이벤트(`mock/demo/backup.js` — 최근 8일·켜진 VM 약 60%, 미보호 리포트가 보호로 읽는다) · RMA 점검 상태(`edgeSeed.demoRmaTestResults` —
    빈 스케줄에만 4개 등록 · `ingestResult(…, {alert:false})`) · 목 생성기 사용률 프로필(`vm.idx % 37 === 5` 유휴 · `% 41 === 7` 과부하 — 라이트사이징 세 탭).

