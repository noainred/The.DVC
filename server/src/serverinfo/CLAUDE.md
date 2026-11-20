# 서버 정보(`server/src/serverinfo/`) · 서버 접속 코어 `sshaccess/readServer.js` 불변조건 — 되돌리지 말 것

설계 `docs/design/server-access/README.md` §4.5 · §8.3. 계정 · 비밀 판정은 `server/src/sshaccess/CLAUDE.md`(1단계) 그대로다.

## v3.25 서버 접속 2단계 — 코어 `readServer` · 기능 ‘서버 정보’(설계 §4.2 · §4.5 · D3 · D5)

회귀: `server/test/serverInfo325.test.js`(읽기 묶음 산수 · 해석 · 가짜 sshd 코어(k-i 겸용 서버 · 멈추는 명령) · 실제 라우터 · 보관 파일) · 웹 `serverInfoText.test.js`.

- **서버에 붙어 명령을 돌리는 새 기능은 `readServer` 하나를 부른다**(자격 해석 → 탐침 → 로그인 한 번 → 명령 하나 → 결과 기록). 기능은 **고정 명령 묶음**(OS 마다 하나)만 넘긴다 —
  주소 · 계정 · 명령 글자를 요청에서 받지 않는다. 엣지 서버 · 수집을 끈 서버는 붙지 않는다 · 자격이 없으면 붙지 않는다(빈 비밀번호 시도 금지) · 거부면 다시 시도하지 않는다.
- **비밀번호는 한 번만 보낸다**(`sshExec` `singlePasswordAttempt` — ssh2 기본 처리기는 password 거부 뒤 같은 비밀번호로 keyboard-interactive 를 또 보내 시도가 2회였다 · 반증 F1).
  계정 정지를 쓰는 경로(코어 · 한 대 확인 · 연결 시험 · 베어메탈 사용률 · 스토리지 수집)가 켠다 — 다른 장비 수집기는 예전 그대로(k-i 만 받는 장비 호환).
- 탐침: 공통 계정 비밀번호는 `accountGate` · **서버 단독 비밀번호는 일괄 문**(`makeCredGate` — 같은 계정명 · 비밀번호 해시로 일괄 안에서 탐침 하나 · F2). 일괄은 하나씩(진행 중 429 · F3) ·
  시작만 하고 202(진행은 화면 조회 · F4).
  v3.30: 일괄 틀(하나씩 · 202 · 일괄 문 · 등록부 id 만)은 **`sshaccess/batch.js` 하나**로 뽑았다 — 서버 정보 · 서버 명령 실행(`server/src/servercmd/CLAUDE.md`)이 같이 쓴다(새 기능도 이것을).
- 시한: **로그인 + 명령 < 장비 시한**(두 OS — 시험) · 바깥 프로그램은 전부 `timeout N`(시험이 맨몸 호출을 잡는다 · F5) · Windows 는 조회마다 `-OperationTimeoutSec`.
  명령 시한 · 출력 상한이면 던지지 않고 받은 만큼(`exec(..., { partial: true })` — `exec-timeout` · 탐침은 성공 · F6).
- 해석(`serverinfo/profiles.js`): 상수 · sudo 없음 · 표지는 순서대로만 · 못 읽은 칸은 null + 이유(0 이 아니다) · **빈 디스크 목록 · 머리줄 없는 df · 실패한 CIM 조회는 못 읽음**(‘0개 · 읽음’ 이 아니다 — F7) ·
  열거값은 Map(‘__proto__’ — F9) · 끝 표지가 없으면 잘림(온 칸만).
- 보관(`server-info.json`)은 해석한 칸만(원문 없음) · 실패해도 마지막 성공 값은 `lastOk`(화면은 ‘지난 값’ · 일부만 읽은 값은 ‘일부만’ 으로 밝힌다 — F10) ·
  읽기 단계를 가른다(손상 = 보존 후 빈 값 · 읽기 오류 = 원본 그대로 · 쓰지 않음 · 30초 뒤 다시 읽고 그동안의 결과를 얹는다 — F11).
- 허용 기능 id 는 `server-info`(KEY_FEATURES · FEATURE_CATALOG · FEATURE_LABEL 셋을 같이 — 시험이 대조). 기능 목록이 있는 키 · 계정은 이 기능을 켜야 쓴다.
- 라우트는 관리자 + 전체 범위(베어메탈 스토리지와 같은 등록부 — 데모 계정은 관리자 게이트에서 막힌다) · 감사에 비밀 · 출력 없음 · 한 번에 50대 · 동시 4대.

## 점검 1회차(2026-11-20) — 되돌리지 말 것(회귀 `serverInfo325.test.js` ⑧ · `serverAccessHunt1.test.js` · 웹 `serverInfoText.test.js`)
- 디스크: 같은 WWN(없으면 시리얼)은 한 디스크로 묶고 경로 수(`paths`)를 단다(멀티패스가 디스크 수를 부풀렸다) · zram · ram 은 디스크가 아니다 · 빈 WWN · 시리얼은 묶지 않는다.
- Windows JSON 의 `{ value:[…], Count:N }`(PS 5.1 확장 형식 배열)은 푼다(그 꼴 — 다른 칸이 없을 때만 · 실제 서버 미확인 방어).
- 코어: 계획의 `stderrMax`(기본 2,000) · 로그인 뒤 실패는 `loggedIn`(계정 탐침이 성공으로 본다) · 효력 계정 없음은 `not-configured`(credCode `no-account`) · WinRM 거부 안내는 권한 가능성을 밝힌다.
- `sshExec.exec` 는 흐름마다 StringDecoder(덩어리 경계의 한글이 깨졌다) · partial 상한에 걸린 마지막 덩어리도 상한까지 싣는다.
- 화면: 늦게 온 이전 응답 버림 · 한 번 본 뒤 실패는 화면을 지우지 않고 알림 · 진행 중 폴링은 실패 뒤에도 이어짐(서버 명령 실행 화면과 같은 틀).
