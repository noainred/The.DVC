# SSH 공용 접속(`server/src/sshaccess/`, v3.9.0) 불변조건 — 되돌리지 말 것

설계 `docs/design/ssh-access/README.md`. 사용자 요청(2026-11-14): 법인 공통 / 서버 단독 SSH 키 로그인 · 다른 기능과 공용 · 키를 법인 › 공통/서버별 폴더로 · 키 보안 · 서버에서 키 이름 · 서버에 들어 있는 키 고르기.
회귀: `server/test/sshAccess390.test.js`(실제 라우터 · 키 저장소 암호화 · 가짜 sshd — ⑫~⑯ 은 5축 점검 확정 결함) · 웹 `web/src/views/sshAccessText.test.js`.

- **새 저장소가 아니다**: 키 · 법인 공통 계정 = 7b `bmusage/onboard/keyStore.js`(ssh-keys.json), 서버 = `bmstor/registry.js`(bm-storage.json). 이 폴더는 그 위의 폴더 · 고르기 · 점검 · 상태만 둔다.
  같은 판정을 두 벌 두지 말 것 — 키를 이 서버 · 이 기능에 써도 되는가는 `refs.keyPlacementIssue` 하나(정의는 순수 모듈 `bmusage/onboard/placement.js` — refs 가 다시 내보낸다 · 온보딩 분석 · bm-storage 저장 · 회전이 쓰기 때도 같은 함수 — 4회차 D1), 폴더를 바꾸면 쓰던 곳이 밖이 되는가는 `refs.placementConflicts` 하나(폴더 변경 · 키 회전).
- **접속 자격 해석 순서**(`refs.resolveOsAuth(server, { feature })`): 키 원문 → **법인 사용 중지**(서버 · 공통 계정 · 키 폴더 법인 + 중지 때 적은 서버 id · 접속처) → **폴더** → **허용 기능** → **첫 사용 원문 ↔ 지문 대조**.
  호출부는 기능 id 를 밝힌다(`bm-usage` · `bm-storage` · `disk-audit` — 빈 값은 목록이 있는 키를 못 쓴다). `conn-test` 만 기능과 무관(사용 중지 · 폴더는 넘지 못한다). 폴더 · 기능이 없는 예전 키는 그대로 쓰인다(키 점검이 경고).
  공통 계정의 기본 키는 서버별 폴더 키 · 다른 법인 폴더 키일 수 없다(`keyStore.saveAccount`).
- **법인 사용 중지는 그때의 서버 목록을 함께 적는다**(`service.stopCorp` — id · 접속처). 법인 칸만 보면 칸을 비우거나 바꿔 빠져나갔다(점검 A-4 · B-1). 라우트는 `ST.setCorpStop` 을 직접 부르지 않는다(소스 스윕).
  **접속처 대조는 법인이 없는 서버에만**(반증 D2 — 법인끼리 사설 IP 가 겹친다: 다른 법인의 같은 주소 서버를 막지 않는다). 상태 객체는 프로토타입 없는 객체 + `Object.hasOwn`(‘toString’ 법인 — 반증 D7).
  엣지가 수집하는 서버는 그 엣지의 키를 쓴다 — 중앙의 중지는 닿지 않는다(응답 `edgeServers` · 화면이 그렇게 말한다).
- **상태 파일(`ssh-access-state.json`)을 못 읽으면 모든 키 접속을 멈추고(fail-closed) 쓰기를 거절한다** — 모양이 틀린 JSON(배열 · 객체 아닌 stops 등)도 손상이다. 읽기 오류(EMFILE 등)는 원본을 옮기지 않고 30초 뒤 다시 읽는다.
  복구는 설정 소유자 + OTP ‘상태 파일 다시 읽기’. 백업 복원에서 뺀다(`backup/stagedRestore.js RESTORE_EXCLUDE`). 서버에서 읽은 키는 따로(`installed.js` — 손상돼도 접속을 멈추지 않는다).
- **새 로그인 키는 암호화 정책에서만**(`keyStore.keyVaultIssue` — 평문 409 `keys-need-encryption`, 정책 잠금 503 `SECRETS_POLICY_UNAVAILABLE`). 키를 새로 받는 라우트(SSH 공용 접속 키 등록 · 받는 곳 승인 · 7b 키 등록)는
  이 검사를 **OTP 앞에** 둔다(평문 409 가 1회 비밀번호를 먼저 쓰지 않게 — 점검 B-5). 정책이 평문이어도 키만 따로 암호화하지 않는다(열쇠 파일을 새로 만들면 S-07 이 포탈 전체 비밀 저장을 잠근다).
- **서버의 키 바꾸기는 `bmstor/registry.setBmServerKeyRef`(같은 접속처 · 키 참조만) 하나 · 부르는 곳은 `service.js` 하나**(설정 소유자 등급 + OTP 라우트 뒤 — 소스 스윕). `bindApproved` 경로를 늘리지 않는다.
  화면이 본 접속처(`addr`)를 `expectAddr` 로 돌려받아 다르면 409 `moved`. 고른 키로 한 번 접속해 확인하고 실패하면 되돌린다(`restoreBmServerKeyRef` — **그 사이 접속처가 바뀌었으면 되돌리지 않는다**: 옛 키를 새 주소에 묶지 않게).
  못 되돌렸으면 ‘되돌렸다’ 고 말하지 않는다(`reverted:false` + `revertError`). 엣지 위임 서버는 중앙에서 고르지 않는다.
- **서버에 들어 있는 키 읽기**: 고정 명령(`authorizedKeys.READ_COMMAND`) · 저장 주소 · 한 번 · 공개키 지문만 저장(`installed.js`). 1회 비밀번호는 어디에도 저장하지 않는다. 폴더의 키를 차례로 대 보지 않는다(계정 잠금).
- **받는 곳(`ssh-keys-inbox/<법인>/common|servers/<서버>/`)**: 파일은 lstat 으로 일반 파일인지 먼저 보고 `O_NOFOLLOW | O_NONBLOCK` 으로 연다(FIFO 하나가 이벤트 루프를 멈췄다 — 반증 D1 · 회귀 ⑦ 자식 프로세스 시한) · 찾은 파일은 승인 전에는 쓰지 않는다 · 승인 · 지우기는 **화면에서 본 내용 해시(sha)와 같을 때만**(승인은 지문도) · 다른 계정이 읽을 수 있는 파일(0600 아님)은 승인하지 않는다 ·
  폴더는 파일이 놓인 자리에서 정하고 **폴더 이름이 겹치면(법인 둘 · 서버 둘) 모호로 거절** · 경로의 어느 디렉터리 조각이든 심링크면 거부 · 경로 글자를 다듬지 않는다(앞뒤 공백 거부) · `..` · 절대 경로 거부 · 응답에 파일 내용 없음.
- **키 바꿔치기 감시 두 겹**: ① 주기 점검(10분)이 디스크 파일을 **푼 값**으로 메모리와 대조(`keyStore.diskDrift` — 정책 전환 재봉인은 바뀐 것이 아니다), 다르면 그 키를 접속에 쓰지 않는다(`key-tampered`) · 밖에서 들어온 키는 사건 ·
  ② 첫 사용 때 원문 ↔ 지문 대조(`refs.integrityOk`). 대조는 공개키 · 이름 · 공통 계정(계정명 · 법인 · 기본 키 · 비밀번호)까지, 공개키 ↔ 지문은 재시작 뒤에도 본다(반증 D4 — 바뀐 계정은 `account-tampered`).
  **포탈 밖 변경이 남아 있으면 키 저장소를 쓰지 않는다**(`keyStore.commit` — 정상 쓰기가 흔적을 사건 없이 지우지 않게 · 반증 D8). 받아들이기는 설정 소유자 + OTP ‘키 저장소 다시 읽기’.
  한계: 포탈이 재시작하면 그때 디스크 내용이 새 기준이다(원문 · 지문 · 공개키를 함께 바꾼 경우 — 화면 · 문서가 밝힌다).
- **예약 복원은 적용 시점의 지금 파일과 다시 합친다**(`stagedRestore.reconcileForApply` → `keyBundle.mergeRedactedKeyStore` — 예약 뒤 좁힌 폴더 · 기능 · 퇴역과 새 키를 지킨다 · 반증 D5). keyBundle.js 는 무의존 leaf(기동 첫 import 규칙 — `audit2768a`).
- **집중 모니터링은 분마다 자격을 다시 해석한다**(`focus/run.js refreshOsHost0` — 세션 시작 때 푼 키를 60분 쓰지 않게 · 점검 B-2) · 인증 결과도 그 분의 자격으로 적는다(반증 D9). 자격 해석이 막은 수집의 사유는 `cred-config`(ssh-error 와 따로 — `missReason.osMissOf`)이고, 그런 키는 사용 기록에 쌓지 않는다(접속 0회 — 반증 D3).
- **라우트(`routes/api/sshAccess.js`)**: 조회 = admin + `requireSettingsOwner`(소유자 ∧ 전체 범위) · 쓰기 = 위 + `reauth`(OTP 마지막) · 지금 점검은 시작만 하고 202 · 감사에 비밀 없음 ·
  라우트는 자격 원본(`resolveOsAuth` · `keyMaterial` · `listKeysRaw` · 등록부 원본 · `KS.`)을 만지지 않는다(소스 스윕).
- **사용 기록(`ssh-key-usage.json`)은 화면용** — 메모리에 모으고 30초 뒤 한 번 쓴다(매 접속 동기 쓰기 금지 · 종료 때 `flushKeyUsage`) · 판정에 쓰지 않는다 · 90일 · 묶음 열쇠에 법인 포함 · 마지막 사용은 전체 묶음에서.
- **보안 사건**은 모아 한 번에 쓴다(`ST.addEvents` — 받는 곳 새 파일은 사건 하나) · 넘치면 덜 중요한 것부터 버린다(`CRITICAL_EVENTS` — 사용 중지 · 바꿔치기 · 다시 읽기는 남긴다).

## v3.24 서버 접속 1단계 — 계층 지정 · Windows 공통 계정 · 비밀번호 특별 관리(설계 `docs/design/server-access` §4.4 · §4.6)

회귀: `server/test/serverAccess324.test.js`(실제 등록부 · 상태 파일 · 가짜 sshd 비밀번호 시도 수 · 실제 라우터 · 변이 — 반증 수정분 ⑨~⑪ 포함) · 웹 `web/src/views/serverAccessText.test.js`.

- **효력 계정은 `refs.effectiveAccountOf` 하나**(resolveOsAuth · 화면 · 법인 사용 중지 · 승인 전 확인이 같은 함수): 서버 자기 자격(credRef · keyRef · 비밀번호 — `registry.hasOwnCred`)이 있으면 ‘따로 정함’ ·
  없으면 **승인된**(`registry.inheritActive`) 서버만 법인 › OS 종류 → 법인 순 가장 가까운 지정. OS 미지정 서버는 OS 단계를 건너뛴다 · **법인 단계 계정은 OS 계열이 같은 서버에만**(예전 계정 · 미지정 서버 = Linux).
- **승인(`inherit.key`)은 주소 · 포트 · OS · 법인(`registry.inheritKeyOf`)에 묶인다** — 어느 쓰기 경로로든 넷 중 하나가 바뀌면 효력을 잃는다(요청 본문은 승인 칸을 세울 수 없다 — applyServerInput 이 모르는 칸).
  법인을 빼면 OTP 없는 서버 저장으로 다른 법인 계정 비밀번호가 간다(반증 F1 — 재현). **자기 자격이 생기는 쓰기(서버 저장 · 키 고르기)는 승인을 지운다**(남기면 OTP 없는 ‘떼기’ 로 되산다 — F5).
  승인 쓰기는 화면이 본 `inheritKey` 를 돌려받아 대조한다(F8).
  세우는 곳은 `setBmServerInherit` 하나 · 부르는 곳은 `service.js` 하나(설정 소유자 등급 + OTP 라우트 뒤 — 소스 스윕). **엣지 위임 서버(agent)는 물려받지 않는다**(승인도 거절 · 판정에서도 제외 — 위임 잡에 해석된 비밀번호가 실리지 않게).
- **계층 지정은 상태 파일(`ssh-access-state.json` `assign`)** — 비밀 없이 계정 id 만 · 모양이 틀리면 손상 · 못 읽으면 물려받는 서버와 공통 계정 비밀번호 접속을 멈춘다(`account-state-unreadable`) · 복원 제외(OTP 없는 복원으로 지정을 되살리지 않는다).
  계정 삭제 · 종류 · OS · 법인 바꾸기는 지정과 어긋나면 거절(`refs.deleteAccountIfUnused` · `accountUseIssue` — 상태 파일을 못 읽으면 모름 = 거절).
- **공통 계정 비밀번호에도** 법인 사용 중지(`account-corp-stopped`) · 허용 기능(`account-feature` — null = 예전 계정 전부) · 서버 OS ↔ 계정 OS(`account-os` — 서버 OS 를 정한 경우만)를 건다.
- **계정 단위 정지**(`accountStops`): 로그인 거부를 본 곳은 `outcome.noteCredOutcome` 하나 — 거부 판정은 **호출부의 접속 단계 표지**(`rejected`)만(문구 판정 금지 — df 의 ‘Permission denied’ 가 계정을 멈췄다 · 반증 F3).
  연결 실패 · 인증 정지 중 결과로는 멈추지 않는다 · 자격 해석이 막은 결과는 기록하지도 않는다. 연결 시험 본체(`connTest.testSavedOs`) · 서버 키 읽기 · 집중 모니터링 결과 기록도 이 함수를 부른다(F7).
  **한 주기 안에서도 듣는다**: 공통 계정 비밀번호 접속은 `accountGate.gateAccountLogin` 을 지난다(같은 계정 · 판은 탐침 하나의 결과를 본 뒤 — 거부면 나머지를 보내지 않음 · 두 폴러 모두 · 대기는 장비 시한 밖 — 반증 F2 재현: 5대 → 5회).
  정지는 **그 비밀번호 판**(`keyStore.accountSecretVersion` = pwSetAt — 해시를 남기지 않는다)에만 걸린다: 비밀번호를 넣으면(같은 값이어도) 풀린다. 정지를 넘는 해석(`ignoreAccountStop`)은 ‘한 대로 다시 확인’ 하나(소스 스윕).
- **새 OS 공통 비밀번호는 암호화 정책에서만**(`saveAccount` — `passwords-need-encryption` 409 · 라우트는 OTP 앞에서 `pwVaultFirst`). iDRAC 공통 계정은 복사 방식이라 이 조건 밖.
- **한 대 먼저 확인**: 지정 저장 · 승인 · 새 비밀번호 저장은 그 계정을 지금 쓰게 되는 서버가 있으면 **그중 한 대로 한 번 로그인**한 뒤에만 쓴다(`loginOnce` — 저장 주소 · 자동 재시도 없음 · 실패면 쓰지 않음).
  승인은 **계정마다 한 대씩**(F6). 옛 7b 계정 화면은 계층 지정 계정의 새 비밀번호를 받지 않는다(`refs.legacyAccountWriteIssue` — F7). 판정 거절은 OTP 앞(`judgeFirst` = 서비스 dryRun — F9).
  확인 대상이 없으면 409 `need-verify` + candidates(화면이 대상을 지어내지 않는다). 확인 기록(`verifiedAt · verifiedOn`)은 그 비밀번호 판일 때만 남긴다.
- AD 로그인 이름은 `keyStore.loginNameOf` 하나(도메인에 점 → `user@domain` · 없으면 `DOMAIN\user`) · 도메인 · OS · 로그인 종류가 바뀌면 저장 비밀을 잇지 않는다 · 포탈 밖 도메인 변경도 `account-tampered`(diskDrift 서명).
