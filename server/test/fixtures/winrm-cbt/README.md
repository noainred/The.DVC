# winrm-cbt — WinRM 채널 바인딩(RFC 5929 tls-server-end-point) 해시 알고리즘 시험 전용 인증서

**시험 전용입니다. 어떤 운영 장비 · 서비스에도 쓰이지 않습니다.** 개인키는 커밋하지 않았습니다(인증서의 DER 만 해시한다 — TLS 서버를 띄우지 않는다).
`server/test/winrm326.test.js` 가 `winrm/ntlm.js certHashAlg` · `channelBindingHash` 를 RFC 5929 4.1 규칙과 대조하려고 2026-11-19 에 openssl 3.0.13 으로 만들었습니다.

| 파일 | 서명 알고리즘 | 채널 바인딩 해시 |
|---|---|---|
| `p384-sha384.crt` | ecdsa-with-SHA384(P-384) | SHA-384 |
| `rsa-sha512.crt` | sha512WithRSAEncryption | SHA-512 |
| `ed25519.crt` | Ed25519 | 규칙 밖 — 클라이언트는 AUTHENTICATE 를 보내지 않는다 |
