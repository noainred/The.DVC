# `server/src/focusmon/` — 집중 모니터링 불변조건

> v2.976 사용자 요청(2026-11-11) "특수기능에 ‘집중 모니터링’ … 최대 20대 · cpu/memory/network/disk 실시간 · 본딩/개별 인터페이스 · 디스크/파티션 read/write/latency/wait ·
> top 30 프로세스" + "리눅스만 · IP ssh key less · RHEL 7.8 기준" + "iostat 13열" + "1·5·10·30분 구간 띠" + "30일 · DB 에 저장(프로세스 목록도)".
> 설계 `docs/design/focus-mon/README.md`(시안 컨펌 뒤 구현). 회귀: `server/test/focusMon2976.test.js` · `focusMonApi2976.test.js` · `web/src/views/tools/focusMonText.test.js`.
> 변이 10/10(공유 토큰 허용 · 남의 대상 받기 · 인증 정지 무시 · 데이터 경로 범위 게이트 · IPv4 검증 · 수집당 20대 · cmdline 수집 · 엣지 시각 자르기 · 공개키 보기에 개인키 · 엣지 보류 시한) — 처음 돌린 판에서 6건이 살아남아 테스트를 보강했다.

- **원격 명령은 상수**(`script.js SCRIPTS` — 주기 1·2·5·10초별로 미리 만든 bash 루프 하나). 사용자 · 원격 출력 값을 명령에 넣지 않는다.
  프로세스는 **comm 만**(/proc/<pid>/stat) — cmdline · environ 을 읽지 않는다(인자에 비밀번호가 흔하다 · `docs/rules/security-api.md` 8b 와 같은 규칙).
  comm 은 awk 가 안전한 글자로 바꾼다 → 표지(`##XXX`) 위조는 없다. ⚠ v2.981 정정(반증 F2 · 재현): comm 의 줄바꿈은 stat 한 줄을 둘로 나눠 뒷줄이 다른 pid 행(`1234 (sshd)`)으로 읽혔다(v2.976 부터) —
  이제 `grep -H` 로 읽어 **pid 는 파일 경로에서** · 같은 파일의 줄은 이어 붙이고 첫 칸이 그 pid 일 때만 받는다. 파서(`parse.js`)는 표지 · 순서 · 줄 수 · 줄 길이 상한으로 자른다.
- **접속은 키만**(`util/sshKeyStore.js` 공장 · 파일 `focusmon_key` · env `FOCUSMON_SSH_KEY`). 개인키는 노드 밖으로 나가지 않는다 — 응답 · 엣지 push · 백업에 공개키 · 지문만.
  등록부(`focusmon-targets.json`)에 비밀 필드가 없다. 비밀번호 폴백 없음.
- **인증 거부는 자동 재시도 금지**(`collector.js focusAuthGuard` — `focusmon-auth-stops.json`). 사람이 ‘다시 연결’ 을 눌러야 한 번 시도한다(`RETRY_MIN_MS` 60초에 한 번).
  호스트키는 `withSsh` 의 장비 신뢰(peerTrust) 판정을 그대로 따른다 — 거부되면 자동 승인하지 않고 60초마다 다시 확인만 한다(화면 ‘호스트키 승인 필요’).
  리눅스가 아니면 수집하지 않는다(`unsupported-os`).
- **대상 주소는 엄격한 IPv4 + 정적 SSRF 가드**(`registry.js` — `strictIpv4Num` 은 number|false|null 이라 `typeof === 'number'` 로 판정). `agent` 는 아는 엣지 이름만.
- **장비당 세션 하나 · 긴 스트림**(`proxy/sshExec.js execStream`) — 노드 상한 `FOCUSMON_MAX_STREAMS`(기본 40) · 루프 수명 6시간 뒤 다시 연다 ·
  SSH 핸드셰이크 시한 `READY_TIMEOUT_MS` · 무출력 감시 `idleLimitMs`. 느린 서버 하나가 다른 서버를 막지 않는다(서버마다 독립 수집기).
- **한도는 `store.js` 상수 하나**(수집 3개 · 수집당 20대 · 동시 40대 · 계속 수집 20대 · 잠깐 보기 15분 · 연장 120분) — 화면은 응답 `limits` 를 읽는다(숫자를 박지 않는다).
  잠깐 보기는 보는 화면이 없으면(심박 60초 · 시작 90초 유예) 끝난다. 계속 수집은 보는 화면이 없으면 10초 주기로 낮춘다.
- **계산 코어는 `rates.js` 하나**(iostat -x -m 13열 · 본딩 속도: 802.3ad/balance = 올라온 구성원 합 · active-backup = 쓰는 구성원).
  끝난 요청 0건이면 await 류는 null('—' — iostat 은 0.00 으로 찍는다) · 걸린 요청만 있고 %util ≥ 99.5 면 `stuck`(‘응답 없음’). 못 읽은 값은 0 이 아니다.
- **엣지 수신은 정제한다**(`central/focusMonEdge.js`) — 아는 상태 이름만(`STATES` · 웹 `STATE_TEXT` 와 1:1 테스트) · 객체만 · 상한 · 엣지 시각은 수신 시각으로 자른다 ·
  그 엣지가 맡은 대상만 받는다. 동기화는 **개별 토큰만**(공유 토큰 403). 응답 `validUntil`(30초) 안에 다시 못 받으면 엣지가 수집기를 닫는다(보류에 시한).
- **DB(`focusmon.db`)는 1분 묶음**(`codec.js` — 열 단위 varint + deflateRaw) · 쓰기는 기록기 대기열을 트랜잭션으로 · 정리는 `minute` 인덱스 rowid 조각(`PRUNE_CHUNK`) ·
  용량 상한 · 디스크 여유 부족이면 기록만 멈춘다(수집 · 화면은 계속). 종료 때 남은 묶음을 쓴다. 상태 파일 · 등록부는 원자 쓰기 + 손상 보존.
- **차트 칸은 표본 간격의 1.5배 이상**(`query.js bucketize`) — 칸 폭이 수집 주기 이하이면 표본이 경계를 비켜 갈 때마다 빈 칸이 생겨 선이 끊겼다(2026-11-11 화면 검증).
  간격은 60초 이하 간격의 **90번째 백분위**(v2.977 — 중앙값이면 계속 수집 10초 → 2초 전환 구간의 선이 점으로 끊겼다) · 60초 넘는 틈은 수집 공백이라 비운다.
  **여러 서버를 한 화면에 놓는 곳(지표 비교 · iostat 비교 고정 선)은 공통 칸 수**(`query.commonPoints` — 가장 성긴 서버 기준 · v2.979 사용자 질문 '같은 길이에 칸이 더 촘촘한 건 왜').
  서버마다 따로 정하면 2초 서버만 150칸 · 10초 서버는 40칸이라 서버 × 시간 칸이 맞지 않았고, 지표 비교 CSV 는 시각 열(150칸)과 값 배열이 어긋났다. 응답 `points` = 값 배열 길이.
- 메뉴 이름은 v2.977 에 **‘서버 집중 모니터링’**(베어메탈 사용률 안의 ‘집중 모니터링’ 과 구분 — 도구 키 `focus-mon` 은 그대로 · aka 에 옛 이름). 차트 툴팁 좌표는 `focusMonChart.js` 순수 함수.
- 조회는 **admin + 전체 범위**(전 법인 서버의 주소 · 프로세스) · 쓰기는 전체 쓰기 범위 · 프로세스 사용자 이름은 관리자 판본(`isAdminDetailUser`)만 원문.
- ⚠ 실제 RHEL 7.8 서버에서는 아직 수집해 보지 않았다(이 환경에 없음 — 컨테이너 리눅스 6.18 원문만 픽스처). 실서버 원문을 받으면 픽스처로 고정할 것.
- **v2.976 반증 1회(11건) · v2.978 CSV 대량 등록 · 일괄 시험 · 노드 옮기기 · 다시 연결 · 반증 1회(7건)** — 원문은 `docs/rules/focusmon.md`(v2.980 에 이 파일 상한 15,000B 때문에 옮김 — 이 폴더를 고치기 전에 읽을 것). 요지: 늦은 표본은 분마다 한 번만 다시 쓴다 · 원격 이름은 `safeKey` + 프로토타입 없는 객체 · 실패 횟수는 표본을 받았을 때만 되돌린다 · 프레임 · 줄 상한 · 엣지 시험 60초에 한 번 배달 · 다시 연결은 60초 검사가 먼저 · 등록부 손상이면 동기화도 503 · CSV 적용은 본문을 다시 계획 · **인증 정지를 지우지 않는다** · 일괄 시험은 대상마다 시험 문턱 공유 · 엣지 시험 동시 상한 `EDGE_TEST_CONCURRENCY` 8 · 다시 연결 = 정지 풀기 + 한 번 시험(엣지는 `retryTargets`).
- **표의 값 단추 · 구간 평균은 시간 가중(v2.979)** — 원문은 `docs/rules/focusmon.md`(v2.981 에 상한 때문에 옮김). 요지: 세 단추는 상태 하나(`fm.srv.at`) · 평균은 **시간 가중**(`query.sampleWeights` · `rates.timeAverageIostat(rows, weights)` — 표본 평균으로 되돌리지 말 것) · 캡션은 응답 `lastAt` · `coverMs` 로 말한다.
- **서버는 수집 하나에만(v2.979 — 사용자 '중복 모니터링 방지' · '기존 모니터링 돌고 있는데 추가하면 잘 안 돼' · '모니터링 종료 버튼')** — 판정은 `store.planJoin` 하나(시작 · 더하기 공통):
  이미 수집 중인 서버는 빼고(skipped) 나머지만 · 모두 겹치면 409 `already` · **계속 수집으로 넣으면 잠깐 보기의 서버를 넘겨받는다**(moved — 잠깐 보기가 끝날 때 같이 멈추지 않게 ·
  비게 된 잠깐 보기는 why `moved` 로 끝) · 넘겨받아 비는 잠깐 보기는 동시 수집 상한에서 자리를 비운다. 더하기 `POST sessions/:id/targets` · 서버 하나 빼기 `DELETE sessions/:id/targets/:tid`
  (마지막 서버면 수집 끝 why `removed`) — 시작과 같은 문(admin · 조회 · 쓰기 전체 범위 · 데모 차단) · 감사 `focus-mon.add` · `focus-mon.remove-target`. 회귀 `focusMonSess2979` · 변이 6/6.
  화면: 진행 중인 수집마다 종료 · 연장 · 둘 이상이면 모두 종료 · 표의 '수집 중' · 서버별 수집 종료 · 시작 전 안내(`startNote` — 서버 규칙과 같은 판정).
  화면이 보는 서버의 기본값은 **진행 중인 모든 수집의 서버**(예전 '가장 최근 수집만' 은 새 수집을 시작하면 먼저 돌던 서버를 화면에서 지웠다) · 수집이 없으면 '수집 중' 이라 하지 않는다.
- **등록된 서버 수정(v2.980 — 사용자 '등록된 서버 수정하는 기능 추가')** — 회귀 `server/test/focusMonEdit2980.test.js` · `web/src/views/tools/focusMonEdit.test.js` · 변이 12/12:
  같은 id 를 고친다(기록은 id 로 이어진다 — 다른 서버면 새로 등록하라고 화면이 말한다) · 바뀐 칸은 `registry.targetChanges`(칸 목록 `EDIT_FIELDS` 는 웹과 테스트가 대조) · 바뀐 것이 없으면 쓰지 않고 감사도 없다.
  **접속처가 바뀌면**(`moved`) `service.targetEndpointChanged` — 바로 틱(수집 중이면 새 접속처로 다시 연다) → **틱 뒤에** `store.forgetTargetState`(상태 · 시험 결과 · 다시 연결 요청 — 남기면
  예전 주소의 '연결됨' · RHEL 이 새 주소의 결과처럼 보였다) → 예전 · 새 담당 엣지를 깨운다. **인증 정지는 지우지 않는다**(접속처 + 키 지문 해시 — 되돌리면 다시 멈춤 · v2.978 ④ 와 같은 규칙).
  화면은 그 줄 아래 colSpan 한 줄(Fragment 로 묶어 정렬해도 함께 · 표 칸 안에 입력을 넣으면 1440px 에서도 저장 단추가 표 밖으로 나갔다) · 포트는 글자 그대로 보낸다(서버가 검사).
- **저장된 계속 수집의 겹침 정리(v2.980 — 사용자 질문 '동시에 2번 수집하는 거야?')**: v2.979 전에 만든 계속 수집은 같은 서버가 두 수집에 있을 수 있고 업그레이드해도 남았다.
  수집기는 서버마다 하나(`desiredFor` 가 id 로 합친다 — 두 번 접속하지 않는다)지만 한 수집 · 서버별 '수집 종료' 가 그 서버를 멈추지 못했다. `loadSessions` 가 먼저 시작한 수집에만 남기고
  비게 된 수집은 뺀다(파일 다시 쓰기 · 콘솔 한 줄 · fm_run 은 `drainLoadFixes` 로 service 가 고쳐 쓴다 · '지난번 다시 고르기' 에 넣지 않는다). 회귀 `focusMonSessMerge2980` · 변이 7/7.
- **프로세스 세부 정보(v2.981 — 사용자 '프로세스를 클릭하면 어떤 프로세스인지 · 네트워크 · 디스크 · CPU' · 시안 ⑩ `docs/design/focus-mon/README.md` §16 · 컨펌 '구현해줘' = 기본값)** —
  회귀 `server/test/focusMonProc2981.test.js`(실제 스크립트를 이 컨테이너에서 돌린 원문 `fixtures/focusmon/container-linux-6.18-proc2981.txt` 포함) · `web/src/views/tools/focusMonProc.test.js`:
  ① 원격 명령은 여전히 상수 · PROC 줄에 같은 stat 줄의 8칸(부모 · utime · stime · nice · vsize · majflt · 42번째 칸 디스크 대기 tick · 상태)을 더했다(파서는 **정확히 14칸**일 때만 새 줄 — 옛 6칸 줄도 읽는다).
  `##UNIT`(30초 · /proc/<pid>/cgroup 의 systemd 줄 → .service/.scope 마지막 칸 · 원격 awk 가 안전한 글자로) · `##IO`(프로세스 주기 · /proc/<pid>/io — **그 계정 · root 만 읽는다**, 못 읽으면 줄 없음 = null).
  구획 순서는 `parse.SECTIONS`(UNIT 은 PROC 앞 — 어기면 프레임을 버린다). HELLO `dacct`(sysctl task_delayacct · 없으면 `grep -c nodelayacct /proc/cmdline` — 커널 부트 줄에서 **개수만**. 옛 테스트의 cmdline 금지는 이 한 줄만 글자 그대로 예외).
  ② 못 읽은 값은 null: 읽기/쓰기(io 를 못 읽음) · 디스크 대기(지연 집계 꺼짐 · 모름) · 상위 30 밖 구간(차트가 끊긴다 — 0 아님). ③ 엣지 정제 `cleanProcs` 화이트리스트(음수 · 형식 · nice -20~19 · 서비스 이름 규칙 parse 와 같음).
  ④ `query.procDetail` — pid + 시작 tick(sk)으로 같은 프로세스(pid 재사용을 가른다) · 서버 전체 네트워크(s.rx · s.tx)는 **참고**(프로세스별 네트워크는 /proc 에 없다) · 라우트 `GET /tools/focus-mon/proc`
  (admin + 전체 범위 · 보이는 대상만 404 · pid 1~4194304 · 사용자 이름은 관리자 판본만). 화면은 줄 아래 colSpan 한 줄(Fragment) · 표에서 빠져도 펼친 패널은 유지 · 떨어진 칸은 점으로 그린다.
  ⚠ 실제 RHEL 7.8 에서 cgroup v1 systemd 줄 · delayacct 기본 켜짐은 확인하지 못했다(컨테이너는 systemd 가 없어 서비스 칸이 비고 task_delayacct=0).
  **반증 1인(v2.981 · 11건 중 10건 반영 · 변이 38/38)**: F1 io · cgroup 읽기를 `timeout -s KILL`(옛 커널 io 는 cred_guard_mutex 에서 기다린다 — root · 앱 계정 수집일 때) ·
  F3 상태 · 디스크 대기 tick 은 **주 스레드 하나의 값**(CPU · fault 는 합) — 스레드가 여럿이면 화면이 밝힌다 · F4 빈 comm '_' · 6/14칸만 · F5 서비스는 경로의 **첫** .service/.scope(사용자 유닛 위조) ·
  F6 사용자 · 서비스 맵은 읽은 uptime 뒤에 시작한 프로세스에 붙이지 않는다 · F7 404 뒤 멈춘 값을 밝힌다 · F8 평균 열쇠에 sk · F9 엣지 정수 · 범위 · F10 null 칸을 싣지 않는다(실측 1분 묶음 1.39배).
  남긴 것: 관리자 판본이 아니어도 `user@1000.service` 의 UID 가 보인다(라우트가 관리자 전용 · 데모 계정은 데모 서버만).
