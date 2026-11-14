# SSH 공용 접속(`server/src/sshaccess/`, v3.9.0) 불변조건 — 되돌리지 말 것

설계 `docs/design/ssh-access/README.md`. 사용자 요청(2026-11-14): 법인 공통 / 서버 단독 SSH 키 로그인 · 다른 기능과 공용 · 키를 법인 › 공통/서버별 폴더로 · 키 보안 · 서버에서 키 이름 · 서버에 들어 있는 키 고르기.
회귀: `server/test/sshAccess390.test.js`(실제 라우터 · 키 저장소 암호화 · 가짜 sshd) · 웹 `web/src/views/sshAccessText.test.js`.

- **새 저장소가 아니다**: 키 · 법인 공통 계정 = 7b `bmusage/onboard/keyStore.js`(ssh-keys.json), 서버 = `bmstor/registry.js`(bm-storage.json). 이 폴더는 그 위의 폴더 · 고르기 · 점검 · 상태만 둔다.
  같은 판정을 두 벌 두지 말 것 — 키를 이 서버 · 이 기능에 써도 되는가는 `refs.keyPlacementIssue` 하나(폴러 · 연결 시험 · 키 고르기 후보 · 폴더 변경 충돌 검사).
- **접속 자격 해석 순서**(`refs.resolveOsAuth(server, { feature })`): 키 원문 → **법인 사용 중지**(서버 · 공통 계정 · 키 폴더 법인 중 하나라도) → **폴더**(폴더 키는 그 법인 서버만, 서버별 폴더는 그 서버만) → **허용 기능**.
  호출부는 기능 id 를 밝힌다(`bm-usage` · `bm-storage` · `disk-audit` — 빈 값은 목록이 있는 키를 못 쓴다). `conn-test` 만 기능과 무관(사람이 누르는 uname 한 줄 — 사용 중지 · 폴더는 넘지 못한다).
  폴더 · 기능이 없는 예전 키는 그대로 쓰인다(하위 호환 — 키 점검이 경고).
- **상태 파일(`ssh-access-state.json`)을 못 읽으면 모든 키 접속을 멈추고(fail-closed) 쓰기를 거절한다** — 손상 한 번으로 사용 중지가 풀리지 않게. 백업 복원에서 뺀다(`backup/stagedRestore.js RESTORE_EXCLUDE`).
- **새 로그인 키는 암호화 정책에서만**(`keyStore.keyVaultIssue` — 평문 409 `keys-need-encryption`, 정책 잠금 503 `SECRETS_POLICY_UNAVAILABLE`). 정책이 평문이어도 키만 따로 암호화하지 않는다 —
  열쇠 파일을 새로 만들면 정책 파일이 없는 설치에서 S-07 이 ‘암호화 흔적’ 으로 읽어 포탈 전체 비밀 저장을 잠근다.
- **서버의 키 바꾸기는 `bmstor/registry.setBmServerKeyRef`(같은 주소 · 키 참조만) 하나 · 부르는 곳은 `service.js` 하나**(설정 소유자 등급 + OTP 라우트 뒤 — 소스 스윕). `bindApproved` 경로를 늘리지 않는다.
  고른 키로 한 번 접속해 확인하고 실패하면 **이전 설정으로 되돌린다**(`restoreBmServerKeyRef`). 엣지 위임 서버는 중앙에서 고르지 않는다(키는 법인 밖으로 나가지 않는다).
- **서버에 들어 있는 키 읽기**: 고정 명령(`authorizedKeys.READ_COMMAND`) · 저장 주소 · 한 번 · 공개키 지문만 저장. 1회 비밀번호는 어디에도 저장하지 않는다. 폴더의 키를 차례로 대 보지 않는다(계정 잠금).
- **받는 곳(`ssh-keys-inbox/<법인>/common|servers/<서버>/`)**: 찾은 파일은 승인 전에는 쓰지 않는다 · 승인 = 다시 읽어 **사람이 본 지문과 같을 때만** 저장소에 넣고 평문 파일을 지운다 ·
  폴더는 파일이 놓인 자리에서 정한다(요청 본문이 아니다) · 심링크 · 일반 파일 아님 · 64KB 초과는 읽지 않는다 · 경로는 `..` · 절대 경로 · 받는 곳 밖을 거부 · 응답에 파일 내용 없음.
- **라우트(`routes/api/sshAccess.js`)**: 조회 = admin + `requireSettingsOwner`(소유자 ∧ 전체 범위) · 쓰기 = 위 + `reauth`(OTP 마지막 — 권한 없는 요청이 OTP 를 소모하지 않게) · 감사에 비밀 없음 ·
  라우트는 자격 원본(`resolveOsAuth` · `keyMaterial` · `listKeysRaw` · 등록부 원본)을 만지지 않는다(소스 스윕).
- **사용 기록(`ssh-key-usage.json`)은 화면용** — 메모리에 모으고 30초 뒤 한 번 쓴다(매 접속 동기 쓰기 금지) · 판정에 쓰지 않는다 · 90일.
- **키 바꿔치기 감시**: 주기 점검(10분)이 저장 원문을 다시 풀어 등록 지문과 대조, 다르면 `keyStore.markKeyIntegrity` 로 그 키를 접속에 쓰지 않는다(`key-tampered`). 키 사이마다 이벤트 루프에 양보한다.
