# 통합 계정 관리(`security/credentialStore.js`, v2.419) 불변조건 — 되돌리지 말 것

> `server/CLAUDE.md` 에서 옮긴 절(2026-10-20). 이 폴더 파일을 읽을 때 자동으로 로드된다. 원문 그대로다.

- **비밀 값은 어떤 API 응답에도 싣지 않는다**(목록/단건/테스트 응답은 hasPassword/hasKey/지문만). '보기'·'내보내기'
  경로를 만들지 말 것. 백업 아카이브만 예외(기존 설정 소유자 전용 규약).
- **변경은 재인증**: 로컬 OTP 계정은 `verifyUserOtp`(1회용·잠금), OTP 없는 계정은 설정 소유자만. 등록/수정/삭제/
  연결 테스트/브로커 인출 전부 `logAudit`(비밀 미기재).
- **브로커(`/api/central/rma-credential`)는 개별 토큰 전용** + 계정의 `agents`·`hosts` 범위를 **둘 다** 검사 + 분당 상한 +
  `Cache-Control: no-store`. 잡/스케줄/outbox 에 비밀을 싣지 않는다 — 엣지는 실행 직전 브로커에서 받아 메모리에만
  (`RMA_CRED_CACHE_MS`) 두고 파일에 쓰지 않는다. 1회 입력 계정(`spec.secret`)은 `takeJobs` 인출 즉시 중앙에서 삭제.
- **엣지 opt-in**: `ssh-exec`/`ssh` 는 `RMA_ALLOW_SSH=true` + `RMA_SSH_TARGETS`(엣지 정책) 안에서만. 중앙 설정으로 켜지게
  만들지 말 것. `credentials.json` 은 SECRET_FILES 등록(password/privateKey/passphrase 봉인) + 0600 + atomicWrite +
  preserveCorrupt — 정직한 한계: 키 파일이 같은 호스트에 있어 at-rest 보호이며 호스트 완전 장악은 못 막는다.

