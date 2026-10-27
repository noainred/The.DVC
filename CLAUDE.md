# CLAUDE.md

## 프로젝트

VMware Global Monitoring Portal — 전세계 분산 vCenter 인프라를 통합 모니터링하는 포탈.
백엔드(Node/Express 집계 API) + 프론트엔드(React/Vite 대시보드). 자세한 내용은 `README.md`.

- 개발 브랜치: `claude/vmware-global-monitoring-portal-nrnpnt`
- **개발 방법론은 `docs/DEV-METHOD.md`**(v2.677 — 작업 등급·8단계 파이프라인·모델/에포트·토큰 다이어트·반복 결함 자동 검사). 새 교훈은 이 파일 본문에 단락으로 쌓지 말고 테스트 → 디렉터리 CLAUDE.md → docs 순으로 남긴다.
- 빌드 검증: `npm run verify` (= `npm test` 단위테스트 + `npm run build` 웹빌드). 서버 실행은 `node server/src/index.js`
  - 단위 테스트는 `server/test/*.test.js`(node:test). 핵심 로직 변경 시 테스트를 추가/갱신하고 커밋 전 `npm test` 통과 확인.
- 오프라인 패키지: `packaging/offline/build-package.sh` (Rocky Linux 9)
- 의존성: CI(`ci.yml`)의 `npm audit` 는 **critical 만 차단**(v2.478)이고 **`--omit=dev` 기준**이다. 잔여 수용 항목 — 웹 high `d3-color`(3d-force-graph·react-simple-maps·recharts 경유. v2.500 에서 색 문자열이 **전부 프론트 상수**임을 재확인했다: `Topology3D` COLOR 맵·`WorldMap` 상수·`sInfo.color` 계열, 서버 응답에 color 필드 없음 → 외부 입력 도달 불가. override 강제는 지도·차트 회귀 위험이 실익보다 크다), 서버 moderate `exceljs→uuid`(exceljs 는 `uuid.v4` 만 사용 — CVE 는 v3/v5/v6 의 `buf` 인자 경계검사). 개발·빌드 전용 잔여는 v2.500 의 비파괴 `npm audit fix` 로 11→6 건이 됐고, 남은 critical 은 **dev 전용 `vitest`**(Vitest UI 서버가 열려 있을 때만 성립 — `@vitest/ui` 미설치·`--ui` 미사용. 수정본은 4.1.11+ 로 2.1.9 에서 두 메이저 점프라 미적용). 새 critical 이 뜨면 PR 이 막히니 `npm audit --omit=dev` 로 먼저 확인.
- 소스 NUL 바이트 탐지는 `tr -cd '\000' < 파일 | wc -c` 로(`grep -cP '\x00'` 은 0 을 돌려주는 오탐 — v2.478 문서 오판의 원인). `file` 이 JS 를 'data' 로 분류하면 의심할 것. 분석 에이전트는 `model` 을 지정하지 말고 기본 모델로, 결과를 scratchpad 파일에도 쓰게 하면 12분 안에 돌아온다(2026-09-11 2차 감사 실측).
- **이 파일은 짧게 유지한다**(2026-10-20 사용자 요청 — 이 파일이 6,209줄·902KB(약 44만 토큰)까지 자라 매 턴·매 하위 에이전트에
  실려 컨텍스트가 자주 찼다). 영역별 규칙·버전별 기록은 아래 **영역별 규칙 문서**(`docs/rules/`)와 디렉터리 CLAUDE.md 에 있다.
  새 교훈은 **테스트 → 디렉터리 CLAUDE.md → `docs/rules/<영역>.md`** 순으로 남기고, 이 파일에는 **버전별 단락을 쌓지 않는다**.
  크기 상한은 `server/test/claudeMdSize.test.js` 가 고정한다(넘으면 영역 문서로 옮길 것).

## 운영 환경 (성능 설계 시 반드시 고려)

- vCenter: **현재 28개 vCenter(~658 호스트·~5,850 VM), 향후 30+까지 확장 예정**. 글로벌 분산.
- 사용자(포탈)는 **한국**에 위치. 일부 vCenter(예: **폴란드, 미국 동부**)는 **RTT 800ms 초과**.
- 고지연·다수 vCenter 환경이므로:
  - **매 폴링 주기마다 이벤트 루프를 블로킹하는 동기 작업 금지**(예: 대량 SQLite write는 반드시 트랜잭션으로 묶기). 과거 IPAM 동기화가 무트랜잭션으로 6천 행 25초 블로킹 → 전체 UI 지연 발생, 트랜잭션으로 해결.
  - vCenter 수집은 **병렬 + per-vCenter 타임아웃**. 느린 1개가 전체 폴링을 막지 않게 한다.
  - 30개 vCenter·고RTT 확장을 가정해 수집/직렬화/DB write를 O(N)·논블로킹으로 유지.
- 적용된 성능 메커니즘(회귀 방지 — 요약. 근거·실측·예외는 `docs/rules/perf-db.md`):
  - 수집 동시성 제한(`store.collectPool`) · **폴러 재진입 가드**(수동 실행과 공유, 주기에 상한 — '끝나지 않는 주기' 가 가드를 영원히 붙잡지 않게).
  - 사용자가 정하는 주기는 `startAdaptiveTimer` + 변경 리스너(모듈 로드 시 env 로 굳히지 말 것) · setTimeout 24.8일 상한(`util/longTimer.js`).
  - **장비당 시한은 세션을 실제로 끊는다**(`withDeadline` + `signal`) · SSH 세션 예산 < 장비 시한(산수를 테스트가 고정).
  - prune 은 스로틀 `(++tick % N) === 0`(기동 첫 틱 금지) + `ts` 단독 인덱스 + 청크(`util/chunkedPrune.js`).
  - SQLite: 집계 함수 2개 이상 한 문장 금지(MIN·MAX 단독) · '키별 최신값' 을 `GROUP BY + MAX(ts)` 로 만들지 말 것(최신 전용 표·재귀 CTE) ·
    open 은 진행 중인 시도 공유(`util/sqliteOpen.js`) · 요청 경로의 큰 집계는 조각 + **시간 기준 양보**(`createYielder`) · 원본 폴백 금지(`historyRollup`).
  - 상시 폴링 라우트는 `memoJson` + `extraKey: scopeKey(...)`(+ 역할) · 캐시는 '세대가 바뀌면 무엇이 지워지는가' 를 먼저 답할 것.
  - 엣지 push 는 gzip + 청크 + 중앙 `BIG_JSON` 등록 + 413 로그 · 무거운 내보내기는 동시 1건(`util/exportBusy.js`).

## 반복된 교훈 (요약 — 같은 실수가 여러 번 재발한 것만)

- **'못 읽은 값' 은 0 이 아니다**: 판정은 `util/numOrNull.js`(웹 `web/src/numOrNull.js`). `Number('')===0`·`Number(null)===0` 함정이 열 번 넘게 재발했다.
  못 읽음·오래됨·부분 합은 정상에도 장애에도 넣지 않고 **따로 센다**. 부분 합은 추이에 적재하지 않는다. 값이 없으면 단위를 붙이지 않는다('—').
- **판정 코어는 하나**: 같은 판정을 복제하지 말 것(웹·서버 두 벌이면 테스트가 같은 입력으로 대조). 결측을 null 로 바꿨으면 **소비처를 전수로** 따라간다.
- **가림·범위는 그 값이 실리는 응답 경로 전부에**: 관리자 판본 판정은 `auth/demoGuest.js isAdminDetailUser` 하나(`role === 'admin'` 직접 비교 금지 — 소스 스윕).
  범위 계정 쓰기 판정은 '조회 밖 404 → 쓰기 밖 403' · 전 법인 설정·동작은 `fullScopeOnly`/`fleetOnly`. 새 라우터 파일은 '범위 참조 0건' 인지 먼저 본다.
- **엣지가 보낸 것은 정제한다**: 아는 필드만·객체만·상한·문자열 수치는 수로 · 이름은 인증된 agent · 엣지 시각은 수신 시각으로 자르고 원본은 따로.
  새 엣지 export 필드는 **중앙 정제 화이트리스트에도** 넣는다. 등록부·설정을 못 읽었으면 빈 목록을 내려보내지 않고 503(`registryUnreadable`·`settingsUnreadable`).
- **보류(withhold)에는 반드시 시한**, 받는 쪽 TTL 보다 짧게. 엣지 워커는 0건이어도 상태를 올린다(무음 실패 금지 — `_last` + 콘솔 + `edgelog/spec.js` 등재).
- **자격증명**: 접속처가 바뀌면 저장 비밀을 승계하지 않는다(`util/secretCarry.js`) · 인증 실패는 주기 수집을 멈춘다(`util/authGuard.js`) · 자동 재시도 금지(계정 잠금).
  로드 오류 원문(파일 조각)은 응답·콘솔에 싣지 않는다(`safeLoadText`). 세부는 `server/CLAUDE.md`.
- **화면**: `BoldText` 는 `**강조**` 만 해석한다 — 문구에 **백틱 금지**(값 인용은 ‘ ’) · `text-transform: uppercase` 금지 · 표는 `STable`(+ `minWidth`·`limit` 은 정렬 뒤) ·
  그리드·플렉스 자식 `min-width:0` · 버튼 여러 개 행은 `flexWrap` · React 훅은 조기 return 위 · 403 은 `ErrorBox` 가 권한 안내로. 화면이 바뀌면 **Chromium 1440/400 으로 직접 본다**.
- **테스트**: 기준 시각은 실제 시각에서 정시 경계로 떨어뜨려 고정(`Date.now()` 직접·고정 epoch 둘 다 깨진다 — `docs/rules/common.md`) · 주석 제거는 `test/_stripComments.js` ·
  ReDoS 회귀는 비율로 · push/pull 진입 함수는 실제로 호출하는 테스트를 둔다 · 변이 검증의 '수정 전' 판본은 감사 기준 커밋으로.
- **정규식**: 외부 입력(장비 출력 포함)에 앵커 없는 무제한 반복·`/\s+$/`·`/\/+$/` 금지(O(n²)) — 길이를 먼저 자르고 선형으로.
- **문서의 '남아 있다'·'별건' 은 다음 점검의 첫 후보**이고, 고친 뒤에는 그 줄을 반드시 정정한다. 반증 기록에는 근거를 적는다.

## 영역별 규칙 문서 — 그 영역을 고치기 전에 해당 파일을 읽을 것

목록·목차는 `docs/rules/README.md`. 서버 모듈별 불변조건은 그 폴더의 CLAUDE.md 에도 있다(자동 로드):
`server/src/{relaytopo,agent,rma,security,sanswitch,hostaccess}/CLAUDE.md`.

| 파일 | 다루는 것 · 언제 읽나 |
|---|---|
| `docs/rules/perf-db.md` (24항목) | 성능·DB·폴러 규약 — 폴러·DB 모듈·캐시·대량 쓰기·응답 캐시를 새로 만들거나 고칠 때 |
| `docs/rules/common.md` (11항목) | 공통 코드·테스트·문서 규약(numOrNull·주석 제거·TDZ·생성기·의존 방향·릴리스 워크플로) — 테스트·스윕·문서 생성기·릴리스 워크플로를 만질 때 |
| `docs/rules/security-api.md` (16항목) | 보안·라우트·외부 API·감사 로그·라이선스 — server/src/routes/ · publicapi · auth · 압축 해제 · CSP |
| `docs/rules/web.md` (23항목) | 웹 화면·메뉴·표·문구 규약 — web/src/ 전반(메뉴·사이드바·표·문구·드롭다운·게시판) |
| `docs/rules/edge.md` (18항목) | 중앙↔엣지 통신·엣지 로그·통신 점검·토큰 점검·지도·전송 속도·스캔 재개·VM 백업 법인 위임 — server/src/{agent,central,collector,linkcheck,edgelog,portalcheck,commmap,dataflow,devflow,xferspeed,vmclone}/ |
| `docs/rules/storage.md` (34항목) | 스토리지 모니터링·증가량·Unity/PowerMax·전력·시리얼 — server/src/storage/ · web/src/views/tools/Storage* · bmstor |
| `docs/rules/sanswitch.md` (16항목) | SAN 스위치(수집·조닝·사용량·월간 점검) — server/src/sanswitch/ · web/src/views/tools/SanSwitch*·san* |
| `docs/rules/idrac-server.md` (24항목) | iDRAC·베어메탈 사용률·파트 장애·서버 온도·전력·Overview 서버 수량 — server/src/{idrac,bmusage,partfault,corpusage,power}/ · Overview |
| `docs/rules/vcenter.md` (24항목) | vCenter 점검 기능(VM 구성·호스트·DS·클러스터·라이선스·태그·이벤트·증분 수집·스파이크) — server/src/{vcenter,vmcfg,vmhygiene,hostcfg,dscfg,clustercfg,corelicense,tags,vmchanges,vmlife,contention,availability,cost,migration,vmseries,vmtrack}/ |
| `docs/rules/gpu.md` (6항목) | GPU 모니터링(할당·메모리·온도·수집 점검) — server/src/gpu/ · web/src/views/tools/Gpu* |
| `docs/rules/cvp.md` (11항목) | Arista CVP 수집·장애·GBIC·Overview — server/src/cvp/ · web/src/views/tools/Cvp*·cvp* |
| `docs/rules/isilon.md` (7항목) | 아이실론 디렉터리 사용량·메일 — server/src/isidu/ · web/src/views/tools/Isidu*·isidu* |
| `docs/rules/ipam.md` (11항목) | IP 관리(IPMS·대역·스캔·원장·VM DNS) — server/src/{ipam,vmdns}/ · web/src/views/tools/Ipam*·Ipms*·IpScan*·VmDns* |
| `docs/rules/horizon-curuser.md` (6항목) | Horizon 세션·앱 사용·현재 사용자(Windows) — server/src/{horizon,curuser}/ · web/src/views/tools/Horizon*·CurrentUsers* |
| `docs/rules/demo.md` (6항목) | 데모(mock) 모드·데모 계정 — server/src/mock/ · auth/demoGuest.js |
| `docs/rules/audits.md` (64항목) | 회차별 점검(감사) 기록 v2.583~v2.785 — 같은 영역을 다시 점검할 때 — 확정분·남긴 것·작업 방식 교훈 |
| `docs/rules/server-security-history.md` | 서버 보안 감사 조치 기록(2026-09-12 ~ 10-16 — SSRF lookup·큰 본문 게이트·비밀 가림·인증 정지·암호문 재사용·세션·장비 신뢰·관리자 판본) |

## 보안 불변조건 (회귀 방지 — 유지할 것)

서버 보안 불변조건(전역 TLS·RBAC·토큰 검증·scope·OTP·WS 게이트웨이 등 전 항목)은
`server/CLAUDE.md` 로 이관했다 — server/ 아래 파일을 만질 때 자동 로드된다. 날짜별 감사 조치 기록은
`docs/rules/server-security-history.md`. 되돌리면 안 되는 규칙들이므로 삭제 금지. 새 보안 규칙도 그쪽에 추가할 것.

## 서비스 허브(`pyportal/`) 불변조건

pyportal 전용 불변조건(6차 감사 v2.214.0 ~ v2.216 추가분)은 `pyportal/CLAUDE.md` 로 이관했다 —
pyportal/ 아래 파일을 만질 때 자동 로드된다. 되돌리면 안 되는 규칙들이므로 삭제 금지.

## 프론트엔드 회귀 방지 (요약 — 상세는 `docs/rules/web.md`)

- **V4·V5·V6 셸은 v2.747 에 지웠다 — 되살리거나 고치지 않는다**(사용자 요청 · `server/test/v4Portal2508.test.js` 가 막는다). 새 셸·틀을 만들지 말 것 — 화면은 기본 셸 + 관제 콘솔 둘.
- **도구 키(`#/tools/<k>`)는 바꾸지 않는다**(권한 파일의 값이자 서버 집행 매핑). 옛 이름은 `specialToolsList.js` 의 `aka`.
  새 도구는 `toolcats/catalog.js` PRESET 에도 배치하고, 카탈로그 `adminOnly` 를 실제 API 게이트와 맞춘다
  (테스트가 대조). 상태를 바꾸는 도구는 '운영 작업' 소속.
- 위임(엣지) 수집 환경에서 중앙 화면이 비면 안 된다(`findRemoteServer`) · 값이 없는 이유를 단정하지 말 것 · 주기·상한 숫자를 화면에 박지 말 것(API 값).
- 긴 작업의 '진행 중' 잠금은 그 대상만 · 무거운 API 는 15초 폴링 금지(마운트 1회 + 버튼) · 늦게 온 이전 응답은 버린다 · 조회 실패 상태로 저장 버튼을 열지 않는다.

## 작업 규모 기본값 (2026-10-20 사용자 승인 — 시간·토큰 절감)

- **기계적 마무리 단계는 Sonnet 하위 에이전트로**(2026-10-25 사용자 지시): 문서 재생성 · `npm run verify` · Chromium 화면 검증 ·
  PR/CI/머지/릴리스 게시(`versions.json` 확인까지)는 `Agent`(`model: 'sonnet'`)에 맡긴다. 설계·구현·결함 판단은 메인이 하고,
  하위 에이전트가 결함을 찾으면 머지·게시 전에 멈추고 보고하게 한다. 작업 현황 표의 `실행` 열에 그 단계는 Sonnet 으로 적는다.
  하위 에이전트가 끝나면 메인이 **직접 재확인**한다 — PR 머지 상태·head CI·`versions.json` latest, 그리고 화면이 바뀐 작업은 스크린샷을 메인이 다시 본다
  (v2.780 실례: Sonnet 이 1440px 표 열 숨김을 '사소한 관찰' 로 분류 — 메인 재판독에서 결함으로 확정, v2.780.1 수정).

- **변이 검증·적대적 재검토(반증 에이전트)는 위험한 수정에만** 쓴다: 보안·권한·범위·자격증명·데이터 손실/삭제·엣지 수신 계약·
  동시성·업그레이드/설치 경로. 화면·문구·문서·단순 조회 수정은 **관련 테스트 + (화면이면) Chromium 1회**로 끝낸다.
- **다중 에이전트 점검은 사용자가 요청할 때만**. 규모를 지정하지 않으면 5축 × 반증 1인으로 시작하고, 그 이상은 먼저 묻는다.
  수정 그룹은 파일이 겹치지 않게 나누고 그룹 수는 꼭 필요한 만큼만.
- 전량 테스트는 커밋 직전 1회(또는 CI 에 맡기고 그 사실을 보고). 개발 중에는 바꾼 모듈의 테스트만.
- 사용자가 '전체 검증'·'자세하게' 를 고르면 그것이 우선이다.

## 사용자 선호 (반드시 준수)

- ★★ **정직 — 가장 중요한 덕목** (사실 기반·과장 금지, 엔지니어 간 대화): 질의응답·기술문의·
  디자인 등 **모든 대화**에서 근거 있는 사실만 말한다. **거짓말·상상해서 지어낸 내용·허황된 내용
  금지** — 사용자는 잠깐 기분이 좋아지는 거짓보다 확실하고 정직한 대화를 원한다. 부풀리기·수사적
  강조·기분을 맞추는 표현(칭찬·아부·불필요한 감탄)을 금지한다. 주장에는 기술적 근거(코드 위치·
  실측값·문서)를 붙이고, 검증하지 못한 내용은 반드시 추정임을 명시한다. 모르면 모른다고 말한다.
  실패·한계·리스크는 축소 없이 그대로 보고한다.
- **항상 한글로 응답**: 모든 답변/설명 메시지는 한국어로 작성한다.
- **존댓말로 응답**(2026-10-01 사용자 지시 "존대말로 해줄래? 기억해줘"): 모든 답변은 합니다체(존댓말)로 쓴다.
  반말·평서체('~다', '~했다')로 사용자에게 말하지 않는다. 코드 주석·문서·커밋 메시지는 기존 문체를 따른다.
- **새 작업 요청 시 작업 현황 표 표시**: 새로운 작업(명령) 요청을 받으면 응답 맨 앞에 "작업 현황" 표를 보여준다.
  열은 `난이도 | 적합 | 실행 | 작업 | 시간 | 토큰 | 상태 | 비고` 순서다(2026-09-15·10-01 사용자 지시).
  - `난이도`: 낮음/보통/높음(단순 편집·UI·엔드포인트=낮음/보통, 아키텍처·동시성·대규모 리팩터·미해결 버그=높음)
  - `적합`: 그 난이도에 적합한 모델(낮음/보통→Sonnet, 높음→Opus) · `실행`: 현재 실행 중인 모델(다르면 비고에 한 줄)
  - `시간`: 그 항목의 **시각과 소요 시간을 함께**(2026-09-17 지시 — 이 파일에 적지 않아 한 번 유실됐다. 지우지 말 것).
    완료 `19:46~20:08 (22분)` · 진행중 `20:09~ (9분째)` · 대기 `예상 8분`.
    ⚠⚠ **시각은 반드시 한국 시각(KST)** — 이 컨테이너의 `date` 는 UTC 다. `TZ=Asia/Seoul date '+%H:%M'` 으로 뽑을 것.
  - `토큰`: 그 항목의 토큰 사용량. 완료·진행중 `약 120k(추정)` · 대기 `예상 약 80k`. 정확한 계측값이 없으므로 **항상 추정임을 밝히고**
    근거(읽은/쓴 코드 분량·도구 호출 수·테스트·빌드·Chromium 회차)를 표 아래 한 줄로 적는다. 지어낸 정밀값 금지.
  - `상태`: `✅ 완료 / 🔄 진행중 / ⏳ 대기` · `비고`: 참고 사항(판단 근거·전제·주의점). **소요 시간은 적지 않는다.**
  현재 진행 중인 작업 + 추가로 해야 할 작업(미릴리스 포함)을 모두 한 표에 정리한다.
- **`.` 입력 시 작업 현황 표 응답**: 사용자가 `.` 하나만 입력하면 진행 중·대기 작업을 같은 형식의 표로 보여준다. 릴리스 폴링 등
  백그라운드 확인도 포함하고, 없으면 "모두 완료" 와 최근 완료 릴리스 버전을 알린다.
- **30분 이상 걸릴 것 같으면 착수 전에 방식을 물어볼 것**(2026-09-15 지시): 표의 `시간` 열에 예상 소요를 적고, 합이 30분을 넘길 것 같으면
  `AskUserQuestion` 으로 진행 방식을 먼저 묻는다. 선택지는 실제로 시간이 갈리는 축(① 전체 검증 ② 표준 ③ 빠르게)으로 주고,
  생략하면 무엇을 못 잡는지 한 줄로 밝힌다. 추정 기준값(테스트·빌드·CI·Chromium 소요)은 `.claude/skills/verify/SKILL.md`.
  ⚠ '검증을 줄여도 된다' 는 뜻이 아니다 — 어디에 시간을 쓸지 사용자가 정하게 하는 것이고, 생략한 검증은 반드시 보고에 적는다.
- **작업 완료 보고 시 토큰 사용량과 수행 시간 표시**(2026-09-15 지시): 토큰은 추정임과 근거를 함께. 수행 시간은 착수 시
  `date -u +%s` 를 스크래치패드(`scratchpad/task_start`)에 적어 두고 보고 직전에 차이를 낸다(요청을 받은 시점 기준). 벽시계라 테스트·빌드·
  Chromium·**CI·릴리스 대기**가 들어가므로 `총 42분(CI·릴리스 대기 18분 포함)` 처럼 큰 항목을 괄호로 나눈다. 측정값이 없으면 '미측정'.
  표의 `시간` 열(항목별)과 합이 맞지 않는 것은 정상이다.
- **모든 표는 제목(헤더) 클릭 정렬**(사용자 요구 '기억해줘'): 새 표는 `<table>` 대신 공용 `components/STable.jsx` 를 쓴다(규칙 상세는
  `docs/rules/web.md`·`components/sortableText.js` — `data-sort`·`data-nosort`·`data-pin`, null·'—' 는 항상 뒤로).
- **화면이 바뀌는 변경은 Chromium 으로 직접 보고 보고할 것**(v2.507 지시): 1440px·400px · 오류 0 · 가로 넘침 · 클릭 · **스크린샷 직접 판독** ·
  A/B 로 내 결함인지 확정 · 끝나면 목 서버 종료 확인. 실행 방법은 `.claude/skills/verify/SKILL.md` '화면 검증'. 생략했으면 생략 사실을 보고에 적는다.
- **PR 자동 진행**: 작업 완료 시 별도 요청 없이 PR 을 생성/갱신한다.
- **PR 완료 시 GitHub 다운로드 링크 자동 안내**: 브랜치 ZIP `https://github.com/noainred/The.DVC/archive/refs/heads/<branch>.zip`,
  머지됐으면 main ZIP `https://github.com/noainred/The.DVC/archive/refs/heads/main.zip`, 그리고 PR 링크.
- **작업 완료 시 자동 업그레이드가 되도록 반드시 릴리스를 게시**(★사용자 강조): 기능 작업은 버전업·커밋·PR 로 끝내지 말고
  GitHub 릴리스까지 게시하고 `versions.json` 의 `latest` 가 새 버전으로 바뀌었는지 확인해 보고한다
  (`https://github.com/noainred/The.DVC/releases/download/downloads/versions.json`). 게시 누락 = 자동 업그레이드 정지다.
  절차(버전 파일 3종·release-notes·pyportal ver.txt·태그/워크플로·자산 1000개 상한)는 `.claude/skills/release/SKILL.md`.
  포탈 동작이 바뀌지 않는 문서·개발 도구 변경은 새 버전을 내지 않고 다음 기능 릴리스에 싣는다(전 법인 포탈이 이유 없이 재시작하지 않게) — 그 사실을 보고한다.
