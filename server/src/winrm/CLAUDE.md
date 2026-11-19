# WinRM(`server/src/winrm/`) 불변조건 — 되돌리지 말 것

설계 `docs/design/server-access/README.md` §8.4. 계정 · 비밀 판정은 `server/src/sshaccess/CLAUDE.md`, 코어는 `server/src/serverinfo/CLAUDE.md`.

## v3.26 서버 접속 3단계 — WinRM HTTPS + NTLMv2(설계 §8.4)

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

