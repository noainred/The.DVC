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

# users.json OTP 시드 봉인(`secretVault.js` 레코드 단위 봉인 — 보안 잔여 11-27 M3) — 되돌리지 말 것

- users.json = `SECRET_FILES` + 파일 한정 필드(`USER_SECRET_FIELDS`)지만 load/save 는 **일반 경로가 아니라** `openRecordFields`/`sealRecordFields`(auth.js) —
  일반 경로는 키 없음에서 로그인 · 비밀번호 변경 저장을 거절하고, 복호 실패를 '' 로 열어 암호문 소거 + OTP 전용 계정을 비밀번호로 내린다.
- 복호 실패 시드는 **암호문 그대로** 메모리에 둔다(소비처는 `isSealed` 가드 · TOTP 는 엄격 base32) · 시드를 안 바꾸는 저장은 잠금 · 키 없음에서도 디스크 원문 승계 ·
  새 시드만 사전 판정(`newSecretSealIssue`)으로 거절 · 평문 정책은 같은 배열(바이트 동일). 콘솔 도구는 `disallowKeyCreation`(키 생성 · 키 확인 값 쓰기 · 자동 봉인 없음)
  + 포탈이 남긴 `secrets-keycheck` 로 같은 키일 때만 새로 봉인. 회귀 `test/secResidual1127TotpSeal.test.js`.

