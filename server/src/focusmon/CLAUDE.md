# `server/src/focusmon/` — 집중 모니터링 불변조건

> v2.976 사용자 요청(2026-11-11) "특수기능에 ‘집중 모니터링’ … 최대 20대 · cpu/memory/network/disk 실시간 · 본딩/개별 인터페이스 · 디스크/파티션 read/write/latency/wait ·
> top 30 프로세스" + "리눅스만 · IP ssh key less · RHEL 7.8 기준" + "iostat 13열" + "1·5·10·30분 구간 띠" + "30일 · DB 에 저장(프로세스 목록도)".
> 설계 `docs/design/focus-mon/README.md`(시안 컨펌 뒤 구현). 회귀: `server/test/focusMon2976.test.js` · `focusMonApi2976.test.js` · `web/src/views/tools/focusMonText.test.js`.
> 변이 10/10(공유 토큰 허용 · 남의 대상 받기 · 인증 정지 무시 · 데이터 경로 범위 게이트 · IPv4 검증 · 수집당 20대 · cmdline 수집 · 엣지 시각 자르기 · 공개키 보기에 개인키 · 엣지 보류 시한) — 처음 돌린 판에서 6건이 살아남아 테스트를 보강했다.

- **원격 명령은 상수**(`script.js SCRIPTS` — 주기 1·2·5·10초별로 미리 만든 bash 루프 하나). 사용자 · 원격 출력 값을 명령에 넣지 않는다.
  프로세스는 **comm 만**(/proc/<pid>/stat) — cmdline · environ 을 읽지 않는다(인자에 비밀번호가 흔하다 · `docs/rules/security-api.md` 8b 와 같은 규칙).
  comm 은 awk 가 안전한 글자로 바꾼다 → 표지(`##XXX`) 위조 · 줄 깨기가 구조적으로 없다. 파서(`parse.js`)는 표지 · 순서 · 줄 수 · 줄 길이 상한으로 자른다.
- **접속은 키만**(`util/sshKeyStore.js` 공장 · 파일 `focusmon_key` · env `FOCUSMON_SSH_KEY`). 개인키는 노드 밖으로 나가지 않는다 — 응답 · 엣지 push · 백업에 공개키 · 지문만.
  등록부(`focusmon-targets.json`)에 비밀 필드가 없다. 비밀번호 폴백 없음.
- **인증 거부는 자동 재시도 금지**(`collector.js focusAuthGuard` — `focusmon-auth-stops.json`). 사람이 ‘다시 연결’ 을 눌러야 한 번 시도한다(`RETRY_MIN_MS` 60초에 한 번).
  호스트키는 `withSsh` 의 장비 신뢰(peerTrust) 판정을 그대로 따른다 — 거부되면 자동 승인하지 않고 60초마다 다시 확인만 한다(화면 ‘호스트키 승인 필요’).
  리눅스가 아니면 수집하지 않는다(`unsupported-os`).
- **대상 주소는 엄격한 IPv4 + 정적 SSRF 가드**(`registry.js` — `strictIpv4Num` 은 number|false|null 이라 `typeof === 'number'` 로 판정). `agent` 는 아는 엣지 이름만.
- **장비당 세션 하나 · 긴 스트림**(`proxy/sshExec.js execStream`) — 노드 상한 `FOCUSMON_MAX_STREAMS`(기본 40) · 루프 수명 6시간 뒤 다시 연다 ·
  첫 표본 시한 `READY_TIMEOUT_MS`. 느린 서버 하나가 다른 서버를 막지 않는다(서버마다 독립 수집기).
- **한도는 `store.js` 상수 하나**(수집 3개 · 수집당 20대 · 동시 40대 · 계속 수집 20대 · 잠깐 보기 15분 · 연장 120분) — 화면은 응답 `limits` 를 읽는다(숫자를 박지 않는다).
  잠깐 보기는 보는 화면이 없으면(심박 60초 · 시작 90초 유예) 끝난다. 계속 수집은 보는 화면이 없으면 10초 주기로 낮춘다.
- **계산 코어는 `rates.js` 하나**(iostat -x -m 13열 · 본딩 속도: 802.3ad/balance = 올라온 구성원 합 · active-backup = 쓰는 구성원).
  끝난 요청 0건이면 await 류는 null('—' — iostat 은 0.00 으로 찍는다) · 걸린 요청만 있고 %util ≥ 99.5 면 `stuck`(‘응답 없음’). 못 읽은 값은 0 이 아니다.
- **엣지 수신은 정제한다**(`central/focusMonEdge.js`) — 아는 상태 이름만(`STATES` · 웹 `STATE_TEXT` 와 1:1 테스트) · 객체만 · 상한 · 엣지 시각은 수신 시각으로 자른다 ·
  그 엣지가 맡은 대상만 받는다. 동기화는 **개별 토큰만**(공유 토큰 403). 응답 `validUntil`(30초) 안에 다시 못 받으면 엣지가 수집기를 닫는다(보류에 시한).
- **DB(`focusmon.db`)는 1분 묶음**(`codec.js` — 열 단위 varint + deflateRaw) · 쓰기는 기록기 대기열을 트랜잭션으로 · 정리는 `minute` 인덱스 rowid 조각(`PRUNE_CHUNK`) ·
  용량 상한 · 디스크 여유 부족이면 기록만 멈춘다(수집 · 화면은 계속). 종료 때 남은 묶음을 쓴다. 상태 파일 · 등록부는 원자 쓰기 + 손상 보존.
- **차트 칸은 표본 간격의 1.5배 이상**(`query.js bucketize`) — 칸 폭이 수집 주기 이하이면 표본이 경계를 비켜 갈 때마다 빈 칸이 생겨 선이 끊겼다(2026-11-11 화면 검증).
- 조회는 **admin + 전체 범위**(전 법인 서버의 주소 · 프로세스) · 쓰기는 전체 쓰기 범위 · 프로세스 사용자 이름은 관리자 판본(`isAdminDetailUser`)만 원문.
- ⚠ 실제 RHEL 7.8 서버에서는 아직 수집해 보지 않았다(이 환경에 없음 — 컨테이너 리눅스 6.18 원문만 픽스처). 실서버 원문을 받으면 픽스처로 고정할 것.
