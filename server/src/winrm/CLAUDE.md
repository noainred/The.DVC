# WinRM(`server/src/winrm/`) 불변조건 — 되돌리지 말 것

설계 `docs/design/server-access/README.md` §8.4. 계정 · 비밀 판정은 `server/src/sshaccess/CLAUDE.md`, 코어는 `server/src/serverinfo/CLAUDE.md`.

## v3.25 서버 접속 3단계 — WinRM HTTPS + NTLMv2(설계 §8.4)

회귀: `server/test/winrm326.test.js`(MS-NLMP 벡터 · 서버 쪽 검증을 구현한 가짜 WinRM 서버 · 코어 연결).

- **WinRM 은 Windows 단계 지정에서만**(`assign.<법인>.windows.via = 'winrm'` · `port`) — 물려받은 서버만 · **비밀번호만**(키로 넘어가지 않는다 — `winrm-needs-password`) · 같은 탐침 · 결과 기록 · 계정 정지.
  먼저 확인(지정 · 승인 · 새 비밀번호 · 한 대로 다시 확인)도 그 서버가 쓰는 방식으로(`loginOnce` `via`).
- **인증서 판정 전에는 아무 바이트도 보내지 않는다**(`deviceTlsConnect` 하위 시스템 `winrm`) · TLS 세션을 이어 쓰지 않는다(`resume: false` — 채널 바인딩) · 인증서를 못 꺼내면 비밀번호를 보내기 전에 끊는다 ·
  연결 하나(undici Agent connections 1 — NTLM 은 연결 단위) · 시한이면 Agent 를 부숴 연결째 끊는다 · 거부(두 번째 401)면 다시 시도하지 않는다 · HTTP(5985) · 봉인 · Kerberos 없음.
- NTLM 은 NTLMv2 만(서버가 확장 세션 보안 · 대상 정보를 안 주면 거절) · LM 칸은 규격대로(Z(24) · LMv2) · MIC · 채널 바인딩 · 비밀번호는 NT 해시로만.
- **연결이 둘이 되면 그만둔다**(`connection-split` — 두 번째 연결은 바이트 0) · 401 이 ‘로그인 거부’ 인 것은 AUTHENTICATE 를 실은 요청뿐(그 뒤 401 은 `session-lost` — 계정을 멈추지 않는다 · 반증 F1).
- **채널 바인딩 해시는 인증서 서명 알고리즘을 DER 에서 읽어**(RFC 5929 4.1 — `certHashAlg`) · 모르는 알고리즘은 AUTHENTICATE 를 보내지 않는다(F2 — 틀린 바인딩은 맞는 비밀번호를 거부시켜 계정 정지가 된다).
- 비밀번호 고정은 WinRM 으로 붙는 호출에만(`resolveOsAuth({ winrm: true })` — SSH 기능은 키 우선 그대로 · F3) · 접속 방식은 계층 지정에서만(등록부 원본 칸을 믿지 않는다 · F9).
- 응답 하나 640KB · 시한 Fault 다시 받기 상한 · Done 이 없으면 실패(받은 만큼을 성공으로 돌려주지 않는다) · 접속처 글자 검사(F5 · F6 · F10).

## 점검 1회차(2026-11-20) — 되돌리지 말 것(회귀 `winrm326.test.js` · `serverAccessHunt1.test.js`)
- AUTHENTICATE 를 실은 요청이 401 이 아니면 로그인 성공 — 그 뒤 실패는 `afterLogin`(코어가 `loggedIn` 으로 계정 탐침에 넘긴다 · 예전에는 ‘모름’ 이라 같은 계정 서버를 하나씩 직렬로).
- **한계(추정 · 실제 Windows 미확인)**: 비밀번호가 맞고 WinRM 권한(Administrators · Remote Management Users · 원격 UAC)이 없어도 같은 401 이 올 수 있다 — 계정 잠금이 더 위험해 판정은 거부(정지) 그대로이고,
  안내 문구가 권한 가능성을 밝힌다(본문 Fault 사유가 있으면 `faultWhy` 로 덧붙임). 권한을 고친 뒤 ‘한 대로 다시 확인’ 으로 정지를 푼다.
- Stream 여는 태그 정규식은 공백 하나(`\s(…)`) — `\s+` 와 `[^>]{0,300}` 겹침이 640KB 응답에 416ms(비율 시험).
- 2회차: AUTHENTICATE 를 실은 요청이 401 이 아닌 4xx · 5xx 여도 로그인 성공(`afterLogin` — 원격 셸 꺼짐 Fault 등) · AUTHENTICATE 를 보낸 뒤 판정 전 실패는 `passwordSent` · stderr 상한은 호출부 값(`stderrMax`).
  남긴 것(낮음): 시한이면 원격 셸 · 프로세스가 남을 수 있다(Receive 시한 = 전체 시한 − 2초 → 두 번째 Receive 중 끊김 · Signal/Delete 0) · NTLM Workstation 칸 비움 · MsvAvTargetName 없음 · 3xx 응답.
- 3회차: 비401 4xx · 5xx 는 **WS-Man SOAP Fault 일 때만** 로그인 성공(앞단 장비의 맨 5xx 는 아님 — 빠른 길이 열렸다) · ShellId 를 받은 뒤에만 `loggedIn` · `connection-split`(0바이트)은 `passwordSent` 아님.
