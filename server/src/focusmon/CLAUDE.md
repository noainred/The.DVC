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
- **v2.976 반증 · v2.978 CSV · 일괄 시험 · 다시 연결** — 원문 `docs/rules/focusmon.md`. 요지: 늦은 표본은 분마다 한 번 · `safeKey` + 프로토타입 없는 객체 · 실패 횟수는 표본을 받았을 때만 되돌림 · 등록부 손상이면 동기화도 503 · **인증 정지를 지우지 않는다** · 엣지 시험 동시 8.
- **표의 값 단추 · 구간 평균(v2.979)** — 원문 `docs/rules/focusmon.md`. 요지: 세 단추는 상태 하나(`fm.srv.at`) · 평균은 **시간 가중**(`query.sampleWeights` — 표본 평균으로 되돌리지 말 것).
- **서버는 수집 하나에만(v2.979) · 등록 수정(v2.980) · 저장된 계속 수집의 겹침 정리(v2.980)** — 원문은 `docs/rules/focusmon.md`(v3.11.0 에 상한 때문에 옮김). 요지: 판정은 `store.planJoin` 하나 ·
  계속 수집이 잠깐 보기의 서버를 넘겨받는다 · 수정은 같은 id · `EDIT_FIELDS` 는 웹과 대조 · 접속처가 바뀌면 틱 **뒤에** 상태를 지우고 **인증 정지는 지우지 않는다** · `loadSessions` 가 겹친 서버를 먼저 시작한 수집에만.
- **프로세스 세부 정보(v2.981)** — 원문은 `docs/rules/focusmon.md`(v2.982 에 상한 때문에 옮김). 요지: PROC 줄 14칸(옛 6칸도 읽는다) · `##UNIT`(30초 · 경로의 **첫** .service/.scope) ·
  `##IO`(그 계정 · root 만 · 못 읽으면 null) · io · cgroup 읽기는 `timeout -s KILL` · pid 는 `grep -H` 파일 경로에서 · 부트 줄은 `grep -c nodelayacct` 개수만 ·
  `query.procDetail` 은 pid + 시작 tick · 상위 30 밖 · 못 읽음은 null(0 아님) · 서버 전체 네트워크는 참고 · 라우트 admin + 전체 범위 · 사용자 이름은 관리자 판본만.
- **서버 그룹(v2.982)** — 원문 `docs/rules/focusmon.md`. 요지: 서버마다 하나 · `GROUP_RE`(웹과 대조) · 대소문자 무시 · 상한 50 · 쓰기는 수집 시작 문 + 503 + 감사 · **CSV 그룹 열이 없으면 그대로**.
- **수집 부하(v2.983)** — 원문 `docs/rules/focusmon.md`. 요지: 원격은 상수 12개 `SCRIPT_TABLE` · 코어 `load.js` · 못 읽음 null · 엣지 `cleanLoad` · 보는 화면 심박은 잠깐 보기 서버만.
- **카드 아래 줄 고르기(v2.992)** — 원문은 `docs/rules/focusmon.md`. 요지: `rates.summaryOf` 의 **이미 저장된 열에서**(새 열 없음 · 못 읽음 null) · 웹 `CARD_LINE_ITEMS`(최대 4 · `fm.ov.line`) ·
  회귀 `focusMonCard2992` · web `focusMonCard`.
- **더할 지표(v3.12.0 ⑬)** — 원문은 `docs/rules/focusmon.md`(v3.13.0 에 상한 때문에 줄임). 요지: 원격은 상수 · 새 구획은 기본 묶음 · df 는 `-l` + `timeout -s KILL` · 카운터 감소 null ·
  파일시스템 · D 는 마지막 값을 표본마다(age) · 묶음 메타 fs 는 `codec.mergeMeta` · 엣지 `cleanSample` 화이트리스트 · 가득 찰 때까지는 계속 수집만(추정). 회귀 `focusMonMetrics3120`.
- **긴 구간 · 사건 · 가장 변했나(v3.13.0 ⑭ — 시안 History · '기본값대로 모두 구현해줘')** — 상세 `docs/rules/focusmon.md` · 회귀 `focusMonHistory3130` · web `focusMonHistory`.
  요약 코어는 `summary.js` 하나(못 읽음은 표본 수에 없음 · 코어별 제외) · `fm_sum1` 은 기록할 때 같은 대기열(늦게 다시 쓴 분도) · `fm_sum60` 은 **끝난 시간만**(markDirty → rollupTick) ·
  백필은 조각 + 쉼 · 못 읽은 묶음은 빈 요약(되풀이 없음) · 열린 분 제외 · 조회 `longq.js` 빈 칸 null · 60초 기억 · 프로세스 · iostat · 수집 부하는 원본 구간만 · 데모 요약은 본 한 번(칸마다 표본 금지 — 24시간 0.5초).
  사건 `fm_event`: 자동은 'connecting' 을 뺀 **안정 상태가 바뀐 순간**만 · 앞 상태를 모르면 적지 않는다 · 재부팅은 가동 시간이 **줄었을 때만**(공백 판정 금지 — 엣지 시각 당김) · 수집 시작 · 끝은 서버마다 · 데모 계정에 이름 · 직접 글 없음 · 지우기는 user 만 + 503 ·
  가장 변했나 `changes.js` 는 두 구간 **같은 출처**(단추로만) · 링크는 해시 끝 ‘@’ 칸(물음표 금지 — 앱이 첫 두 칸으로 도구를 고른다).
- **앱 단위 묶음(v3.15.0 ⑮)** — 상세 `docs/rules/focusmon.md` · 회귀 `focusMonApps3140`. 원격 명령 추가 없음 · 코어 `rates.appGroups` · 열쇠 `appServiceKey`/`appNameOf` 하나(펼침도) ·
  서비스 지도가 없으면 서비스 기준 null · 지도 뒤 시작한 프로세스에 옛 서비스 금지 · 못 읽은 디스크 null · DB 는 분마다 마지막 표본만 · 엣지 `cleanApps` · 계정 이름은 관리자 판본만.
- **알림 · OOM · 자동 조절(v3.16.0 ⑯)** — 상세 `docs/rules/focusmon.md` · 회귀 `focusMonAlerts3160` · `…Fix3160`. 코어 `alerts.judge`(지속 내내 · 덮어야 · 못 읽으면 **보류** · 조용함은 보류 아님) ·
  중앙만 판정 · 계속 수집만 · 정비 창은 `maintMatch`(DataCenter → vCenter) · 목 모드 발송 금지 · 규칙 503 + 감사 · `dmesg -x` **원문 없이** · boot_id 열쇠 · 엣지 `cleanKm` 50초 · `tune.decide`(설정이 하한).
- **디스크 점검(v3.11.0 — 사용자 '배드섹터 점검 프로그램 추가' + 원문 · '법인별 · 모델별로' · '기본값대로 모두 구현')** — 이 폴더의 **유일한 sudo 예외**(사용자 승인: 고정 설치 + sudoers 한 줄).
  상세 `docs/rules/focusmon.md` · 설계 `docs/design/focus-mon/README.md` §20 · 회귀 `focusMonAudit3110` · web `focusMonAudit`. **되돌리면 안 되는 것**:
  ① 받은 프로그램 `audit/rhel_disk_audit.py` 는 **한 바이트도 고치지 않는다**(sha256 = 판본 · 고치면 전 서버 재설치) — 덧붙일 일은 감싸는 실행 파일 `WRAPPER_TEXT` 에(인자 거절 · 임시 폴더 · 시한 KILL · nice/ionice · 디스크 목록).
  ② 원격 명령은 상수 둘 — `READY_COMMAND`(일반 계정 · `sudo -n -l` 로 허용 여부만) · `RUN_COMMAND`(sudoers 와 같은 인자 없는 한 줄). 포탈은 root 로 돌 코드를 보내지 않는다(python3 · 셸을 sudo 로 열지 않는다).
  ③ 실행 전 판정은 `parse.readyState` 하나 — 두 파일 sha256 · root 소유 · 그룹/남 쓰기 금지 · setuid 금지 · 경로 폴더 · sudo 규칙. 아니면 실행하지 않는다. 엣지 작업은 중앙이 아는 판본(`expect`)으로 맞춘다.
  ④ 결과는 **원문**으로 받아 중앙이 다시 해석(`service.analyzeRun`) — 엣지 해석값을 믿지 않는다 · `cleanEdgeResult` 상한(줄 · 줄 길이 · 5MB) · 그 엣지가 맡은 대상의 그 엣지 작업만 반영 · 모르는 결과도 ack(무한 재전송 방지).
  ⑤ 인증 거부는 `focusAuthGuard` 에 정지 · 정지된 대상은 접속하지 않는다(자동 재시도 금지). ⑥ 숫자는 **줄 수**(장애 횟수 아님) · 끝까지 돌지 않은 회차(outcome ≠ 'done')는 합계에 넣지 않는다(null).
  ⑦ 한도 — 노드당 동시 1 · 같은 서버 실행 10분에 한 번(실행된 때 기준) · 준비 확인 60초 · 엣지 미수령 30분/결과 없음 시한 뒤 'lost' · 보관 10회 · 90일. 조회 admin + 전체 범위 · 실행 + 쓰기 전체 범위 · 데모 차단 · 감사.
  ⑧ 반증 1인 반영(9건 · 변이 37/37): **표지는 실행마다 난수**(`##DA BEGIN 2 <16자>` · 그 표지가 붙은 줄만 — 보고서에 대상 서버 로그가 들어가고 일반 계정도 줄바꿈 든 로그를 남긴다) ·
     **보고서 모양 검사**(구획 순서 · 완료 줄 · 근거 번호 · 판정 건수 합 — 어긋나면 'report-shape' 로 숫자를 쓰지 않는다) · 출력 보관은 표지 외 **모든 줄을 예산 · 줄 수 상한으로**(넘친 구획은 뒤를 버린다) ·
     엣지 결과는 직렬화 크기 상한 · 413 이면 원문을 버림 · 실패 뒤 한 번 결과 없이 · 보관 1시간(이 본문에 표본도 실린다 — 막히면 그 엣지 수집 전체가 멈춘다) ·
     엣지 작업은 진행 목록에 실리는 동안 지우지 않고(seenAt) 'lost' 는 2시간 기억해 늦은 결과를 반영 · 접속처가 바뀌면 작업 · 준비 상태를 지우고 회차는 접속처 지문(`ep`)으로 거른다 ·
     sudo 실패(표준 출력 빔)도 회차로 · 잠금(flock) · SIGPIPE trap · `-I -S` · 준비 확인과 실행 파일은 같은 PATH. **받은 프로그램이 줄바꿈을 지우지 않아 남는 한계**(판정 글자 위조 · comm 을 바꾼 프로세스의 로그)는 `docs/rules/focusmon.md`.
