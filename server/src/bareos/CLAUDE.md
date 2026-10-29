# Bareos VM 백업 연동(`server/src/bareos/`) 불변조건 (v2.820)

포탈이 Bareos Director 콘솔(9101 · TLS-PSK · CRAM-MD5 · `.api json`)로 VM 마다 잡을 만들고 실행·조회·복원한다.
백업 데이터는 사이트 FD → SD 안에서만 흐르고, 포탈은 제어 명령(수 KB)만 보낸다. 되돌리면 안 되는 규칙:

- **vCenter 비밀번호를 갖지 않는다**: 잡의 플러그인 옵션은 `config_file=<FD 의 INI>` 만 싣는다(vcuser·vcpass 금지 — `bareosRoutes ⑤` 가 명령 문자열로 고정).
  엣지 위임(`collectMode:'site'`) vCenter 는 중앙이 비밀번호를 모르므로 이 방식이 유일하게 맞다.
- **콘솔 명령에 넣는 값은 `names.js` 를 통과한 것만**: 리소스 이름 `[A-Za-z0-9._-]{1,64}` · 플러그인 값은 `" \ : ; @`·제어문자·앞뒤 공백·200자 초과 거부.
  `configure add` 는 FdPluginOptions 를 따옴표 없이 쓰므로 `consoleQuote(…, { literalQuotes: true })` 로 따옴표를 남긴다(빼면 `:` 뒤가 잘린다).
- **복원은 jobid 목록으로만**: 범용 FileSet 하나를 여러 VM 이 공유하므로 `restore … select current`(client+fileset 최신)는 다른 VM 을 섞는다 — 화면·API 에 그 경로를 두지 않는다.
  체인은 `.bvfs_get_jobids` → 안 되면 카탈로그 이력(`restore.js chainFromHistory`), 그 jobid 가 **이 대상의 성공한 백업(T·W, type B)** 인지 Director 에서 확인한다.
- **복원 라우트 순서**: OTP 등록 확인 → 진행 중 409 → jobid·`restorePlan` 판정 → **그다음에** `verifyUserOtp`(전제 실패가 1회용 OTP 를 태우지 않게) → Director 확인 → 실행 → 감사.
  덮어쓰기는 VM 이름 재입력 + 전원 꺼짐 + 스냅샷 0 — 못 읽은 전원·스냅샷 값은 **거부**(0 으로 보지 않는다). 새 VM 은 항상 꺼진 채(`restore_powerstate=off`)·동명 VM 거부.
- **데모 계정은 사람이 등록한 Director 에 닿지 않는다**: 조회 라우트는 `readDirector({ demoOnly: isDemoGuest(req.user) }, …)` 만 쓴다(`audit2719b` 스윕이 이 모양을 대조).
  설정·카탈로그는 `READ_DENY`, 실행·복원 POST 는 `SAFE_ACTIONS` 에 넣지 않는다. 목록의 Director 주소·콘솔 이름·접속 오류 원문은 범위 계정·데모 계정에 가린다.
- **연결 시험은 저장 비밀번호를 승계하면 저장 주소·포트·콘솔 이름으로 고정**(v2.480 규칙). 주소·포트·콘솔 이름이 바뀌면 저장 비밀번호를 폐기(`accessMoved`).
- **인증 실패는 주기 조회를 멈춘다**(`bareosAuthGuard` — auth·pam·tls 오류). 수동 조회는 계속, 성공하면 해제. 자동 재시도 없음.
- **폴러는 할 일이 없으면 접속하지 않는다**(pending 0 이고 대조 틱이 아니면). 재진입 가드 · `withDeadline` 예산 = max(30초, 시한×4).
- **VM 위치 필드는 `vcDcPath`·`folderPath`**(`vcenter/vmPlacement.js`) — 호스트의 `vcDatacenter`(데이터센터 이름)와 다른 값이다. 엣지 수집분은 중앙 정제 `INV_STR_ONLY_KEYS` 를 지난다.
- **원장 lastRun 은 같은 jobid 에서 null 로 덮지 않는다**(`list jobs days=` 행은 바이트가 비어 올 수 있다) · 음수 바이트·개수는 null(`director.js nonNeg`).
- **카탈로그 시각은 Director 현지 시각(시간대 없음)** 이다 — 포탈 서버 현지 시각으로 읽는다. 포탈과 Director 의 시간대가 다르면 어긋난다(같은 망·같은 시간대 전제 — 다르면 보정이 필요하다).
  데모 Director 도 현지 시각 문자열을 만든다(`catTime` — UTC 문자열이면 한국 시각 서버에서 9시간 어긋났다, `bareosDirector` 시험).
- 실환경 미확인(추정 — `tools/bareos-probe.js` 로 확인할 것): Node↔Director TLS-PSK 협상 · 잡 수준 FdPluginOptions 와 FileSet 플러그인 문자열 병합 ·
  `.bvfs_get_jobids` JSON 모양 · Profile ACL 지시어 이름 · `list jobs days=N`.
