# WinRM(`server/src/winrm/`) 불변조건 — 되돌리지 말 것

설계 `docs/design/server-access/README.md` §8.4. 계정 · 비밀 판정은 `server/src/sshaccess/CLAUDE.md`, 코어는 `server/src/serverinfo/CLAUDE.md`.

## v3.26 서버 접속 3단계 — WinRM HTTPS + NTLMv2(설계 §8.4)

회귀: `server/test/winrm326.test.js`(MS-NLMP 벡터 · 서버 쪽 검증을 구현한 가짜 WinRM 서버 · 코어 연결).

- **WinRM 은 Windows 단계 지정에서만**(`assign.<법인>.windows.via = 'winrm'` · `port`) — 물려받은 서버만 · **비밀번호만**(키로 넘어가지 않는다 — `winrm-needs-password`) · 같은 탐침 · 결과 기록 · 계정 정지.
  먼저 확인(지정 · 승인 · 새 비밀번호 · 한 대로 다시 확인)도 그 서버가 쓰는 방식으로(`loginOnce` `via`).
- **인증서 판정 전에는 아무 바이트도 보내지 않는다**(`deviceTlsConnect` 하위 시스템 `winrm`) · TLS 세션을 이어 쓰지 않는다(`resume: false` — 채널 바인딩) · 인증서를 못 꺼내면 비밀번호를 보내기 전에 끊는다 ·
  연결 하나(undici Agent connections 1 — NTLM 은 연결 단위) · 시한이면 Agent 를 부숴 연결째 끊는다 · 거부(두 번째 401)면 다시 시도하지 않는다 · HTTP(5985) · 봉인 · Kerberos 없음.
- NTLM 은 NTLMv2 만(서버가 확장 세션 보안 · 대상 정보를 안 주면 거절) · LM 응답 빈 값 · MIC · 채널 바인딩 · 비밀번호는 NT 해시로만.
