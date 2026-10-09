# rvI-tls — S-02 TLS 상대 인증 테스트 전용 인증서(운영 무관)

**테스트 전용입니다. 어떤 운영 장비·서비스에도 쓰이지 않습니다.** 개인키는 이 저장소(공개)에 있으므로 누구나 갖고 있는 값입니다 —
이 인증서를 신뢰하도록 설정하면 안 됩니다. `server/test/rvI_tlsTrust.test.js` 가 가짜 HTTPS 서버에 쓰려고 2026-10-09 에 openssl 3.0 으로 만들었습니다
(테스트 실행 때 openssl 이 필요 없게 미리 만든 것).

| 파일 | 내용 |
|---|---|
| `ca.crt` | 테스트 사설 CA(`CN=DVC rvI TEST-ONLY Private CA`, 2126년 만료). CA 개인키는 커밋하지 않았습니다. |
| `server-ok.*` | 위 CA 가 서명, SAN `localhost`·`127.0.0.1`·`::1` (2126년 만료) |
| `server-wronghost.*` | 위 CA 가 서명, SAN `wrong-host.invalid` 뿐 — 호스트 이름 불일치 |
| `server-expired.*` | 위 CA 가 서명, SAN 은 맞지만 2020-01-01 ~ 2020-01-02 유효 — 만료 |
| `self-a.*`·`self-b.*` | 자체서명(SAN `localhost`·`127.0.0.1`·`::1`) — 서로 다른 키·지문(지문 승인·교체 시험) |

키는 EC P-256 입니다.
