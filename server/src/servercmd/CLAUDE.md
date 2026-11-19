# 서버 명령 실행(`server/src/servercmd/`, v3.30) 불변조건 — 되돌리지 말 것

설계 `docs/design/server-cmd/README.md`(컨펌 2026-11-20 ‘기본값으로 수행’ — D1~D14 기본값). 접속 코어 · 계정 판정은 `server/src/serverinfo/CLAUDE.md` · `server/src/sshaccess/CLAUDE.md` 그대로다.
회귀: `server/test/serverCmd330.test.js`(목록 전체 쓸기 · 주입 시도 · 출력 다듬기 비율 · 직접 켠 계정 · 가짜 sshd · 실제 라우터) · 웹 `web/src/views/tools/serverCmdText.test.js`.

- **명령은 `presets.js` 에 고정**(D3) — API · 화면은 프리셋 id · 값 · 서버 id 만 보낸다(명령 글자 칸을 만들지 말 것 · 본문의 다른 칸은 명령에 닿지 않는다). 프리셋을 더하면 시험 ① 의 허용 프로그램 목록 · 금지 목록을 같이 본다.
- **값은 두 종류**(이름 · 경로 — D11): 길이 먼저 → 앵커 있는 유한 반복 정규식 → 경로의 `..` 조각 거절 → 그래도 작은따옴표(`q` · `psq` 는 따옴표가 있으면 던진다) + `--` 뒤. 모르는 값 이름 · 빠진 값은 400(접속 전).
- **읽기 전용 · sudo 없음**(D2): 상태를 바꾸는 명령 · 다른 주소로 가는 탐침(D4) · 값으로 받은 경로의 파일 내용 · 프로세스 인자 · 환경 변수(`ps aux` · `systemctl status`)를 넣지 않는다 —
  프로세스는 이름만(`comm` · `pgrep -l` · `systemctl show`). Linux 는 문장마다 `timeout N` · 파이프 뒤는 `sort` · `head` 만. 로그인 + 명령 < 서버 한 대 시한(시험이 산수를 고정).
- **실행은 코어 `readServer` 하나**(계정 해석 · 탐침 · 비밀번호 한 번 · 결과 기록 · 엣지 · 수집 끔 판정을 우회하지 않는다) · **일괄 틀은 `sshaccess/batch.js` 하나**(서버 정보와 같이 — 기능마다 일괄 하나 · 202 · 일괄 문).
- **직접 켠 키 · 계정만**(D8): 판정은 `placement.featureBlocked` 하나(키 · 공통 계정이 같은 함수 · `EXPLICIT_FEATURES`) — 기능 목록이 없는 예전 키 · 계정은 이 기능에 막힌다(다른 기능은 예전 그대로). 서버 단독 비밀번호는 목록이 없어 판정 밖.
- **출력은 메모리에만**(D6): 마지막 실행 한 건 · 끝나고 `RESULT_TTL_MS`(30분) 뒤 지운다 · 파일 · 백업 · 엣지 push · 감사에 싣지 않는다. 목록 응답(`GET /tools/server-cmd`)에는 첫 줄 · 줄 수만, 원문은 `GET /tools/server-cmd/output` 으로 따로.
  출력은 `cleanOutput`(선형 — 정규식 없이 ESC 순서 · 제어문자 · CR 을 걷고 줄 · 글자 상한)을 지난 것만 둔다. 출력 속 비밀은 가리지 못한다 — 그래서 그런 명령을 목록에서 뺐다.
- 라우트(`routes/api/serverCmd.js`)는 관리자 + 전체 범위(D7 — 실행마다 OTP 없음) · 감사: 누가 · 프리셋 · 값 · 대상 수 · 서버별 결과 코드(출력 · 비밀 없음).
- Windows 프리셋은 **실제 서버 출력으로 확인하지 못했다**(화면 ‘시험’ 표시 — D9). PowerShell `-EncodedCommand`(SSH · WinRM 같은 스크립트 · cmd 한도 8191 — 시험).
