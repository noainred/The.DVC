# Backup 현황 › 백업 실행·포탈 백업 관리(`server/src/veeam/run/`, v2.818~) 불변조건 — 되돌리지 말 것

운영 문서·정직 기록(확인/추정 구분)은 `docs/VEEAM-BACKUP-RUN.md`. 회귀 테스트 `server/test/veeamRun2818.test.js` · `veeamManage2819.test.js`.

- **모니터링 클라이언트(`veeam/client.js`)에 쓰기 요청을 넣지 않는다**(그 파일의 설계 규칙). 상태를 바꾸는 요청은 `run/client.js` 에만 둔다.
  서버 등록부·VM 대조(`parse.js matchToVcenter`)·인증 정지(`poller.js authGuard`)는 모니터링 것을 그대로 쓴다 — 다시 만들지 말 것.
- **실 VBR 확인은 일부뿐이다**(2026-10-29 현장 'OC2': 잡 생성 type Backup + VM flat · 잡 시작 본문 · 세션 읽기 확인 — `docs/VEEAM-BACKUP-RUN.md` 표). Quick Backup 경로·본문, taskSessions 는 여전히 미확인이라 후보 체인이다. 현장 확인된 후보를 **맨 앞**에 둔다. 다음 후보로 넘어가는 것은
  '모양을 모른다'(400·404·405·415·422) 일 때만이다. 401/403/409·429 는 실패(시작 안 됨), **전송 오류·시한·408·5xx 는 결과 모름(unknown)** —
  다음 후보로도 넘어가지 않고, 포탈이 다시 보내지 않는다(반증 F2 — 같은 백업이 두 번 돈다).
- 엣지 대행 작업에는 **비밀번호를 싣지 않는다**(서버 id + 남은 시간 ttlMs). 엣지는 중앙이 배정한 자기 등록부 사본(pulled · 담당 = 나)으로만 실행한다(반증 F1).
  시한은 절대 시각이 아니라 남은 시간이다(엣지 시계와 무관) — 지나면 상태 변경 요청을 보내지 않는다(notSent, 반증 F3).
- 포탈은 **표지(`PORTAL_MARKER`)가 있는 잡만** 고친다. 포탈 잡 이름은 vCenter id 해시를 붙인다(반증 F6) — **형식을 바꾸면 이미 만든 잡을 못 찾는다**.
- 결과는 항상 `run/parse.js` sanitize 를 지난다(중앙 직접·엣지 회신 둘 다). 새 필드는 sanitize 에도 넣는다.
- '확인 불가'(unknown)·'보내지 않음'(skipped)은 성공도 실패도 아니다. 보호 상태를 모르면 '미보호' 로 단정하지 않는다
  (`routes/api/veeam.js veeamMatchFor` — 그 vCenter 의 B&R 서버 결과가 **전부** 있을 때만 known).
- **재시작 복구는 실행 기록 파일을 처음 읽을 때만**(`runs.js load`) — 기동 뒤 타이머에서 복구하면 그 사이 이 프로세스가 시작한 살아 있는 실행을 닫아
  409 가드가 풀린다(2차 반증 N1). 진행 중 실행은 기록 상한(100)으로 잘라 내지 않는다. 추적이 막히면 '기록 닫기'(OTP·감사)로 포탈 기록만 닫는다(N3).
- **상태 변경 요청이 2xx 를 받았으면 그 뒤 예외는 실패가 아니다**(`run/client.js call` — 본문 끊김·비JSON 은 json null, N2). Quick Backup 후보 C 는 VM 마다 독립(N5).
- 백업 실행용 '보호 상태를 안다' 는 B&R 결과가 **전부 있고 신선할 때만**(`veeamMatchFor` — `resultMaxAgeMs`, N4). 인증 정지는 저장소 조회에도 적용한다.
- **복원은 새 VM 으로만**(사용자 결정 2026-10-29 — `manage.js RESTORE_TYPE='Customized'` 하나, 코드에 OriginalLocation 없음 — 테스트가 소스를 본다).
  새 이름이 인벤토리 VM 이름과 겹치면 409, 복원 지점이 그 VM 이름의 것이 아니면 보내지 않는다. 백업 삭제는 **포탈 잡(표지)의 그 VM 만** — 다른 VM 이 든 백업을
  통째로 지우는 후보를 넣지 말 것. 삭제 전에 잡에서 빼고, 빼기가 실패·모름·마지막 VM·확정 못 함이면 지우지 않는다. **VM 은 이름이 아니라 moref + vCenter 로 묶는다**
  (`manage.js objectBinding/pointBinding` — 확인 못 하면 이 vCenter 포탈 잡만, 반증 F1·F2). 빼기·삭제는 `runs.js claimServer` 로 서버 자리를 차지한다(F4). 작업 표는 `run/ops.js` 하나(새 작업은 OPS·MUTATING·SANITIZERS·RESULT_MS 넷 다).
