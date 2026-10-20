# RMA(원격 명령 에이전트, `rma/`, v2.416) 불변조건 — 되돌리지 말 것

> `server/CLAUDE.md` 에서 옮긴 절(2026-10-20). 이 폴더 파일을 읽을 때 자동으로 로드된다. 원문 그대로다.

- **개별 토큰 전용**: `/api/central/rma-poll`·`rma-result` 는 `req.centralAuth.mode !== 'agent'` 면 403. 원격 명령은
  자격증명보다 큰 권한이라 공유 CENTRAL_TOKEN 예외(TOFU)를 두지 않는다. 결과 회신은 reqId 소유 agent 만.
- **프리셋 카탈로그 + argv 실행**(`rma/commands.js`): 중앙은 프리셋 id·파라미터만 보내고 **엣지가 다시 검증**해
  argv 배열로 spawn 한다(셸 없음). 파라미터는 화이트리스트 정규식(선행 `-` 차단). 자유 명령(`custom`)은
  **엣지 측 `RMA_ALLOW_CUSTOM=true`** 일 때만 — 중앙 설정으로 켜지게 만들지 말 것(현장 담당자의 opt-in 이 설계).
  파일 내용을 읽는 프리셋·재부팅/전원 프리셋을 추가하지 말 것(portal.env 유출·사고). sudo 프리셋을 늘리면
  `unitTemplate.js RMA_SUDOERS` 와 `install.sh` 의 규칙도 같은 줄로 늘려야 한다.
- **서명**(`rma/signing.js`): 법인 비밀번호(`rma-agents.json`, SECRET_FILES 봉인)가 있으면 잡에 HMAC 을 붙이고 엣지는
  `RMA_PASSWORD` 로 검증(±10분). 비밀번호는 선로에 싣지 않는다(서명만). 응답·감사로그에도 값 미기재.
- **비멱등 잡큐**(`rma/jobs.js`): `MAX_CLAIMS = 1` — 인출 후 미회신은 **재인출 없이** 오류 종결. 캡처 큐처럼 재시도로
  바꾸면 서비스 재시작/자유 명령이 두 번 실행된다. 배정 대상이 오프라인(하트비트 만료)일 때만 다른 인스턴스가 가져간다.
- **롱폴 대기 타이머는 unref 하지 않는다**(응답 대기 중인 HTTP 요청이 있다). 대기 상한 55초(프록시 유휴 타임아웃 아래).
- **패키지 유닛 동일성**: `packaging/offline/vmware-portal-rma@.service` 는 `rma/unitTemplate.js` 와 바이트 단위로 같아야
  한다(`test/rma.test.js` 고정) — 원격 배포와 오프라인 설치가 다른 유닛을 쓰면 안 된다.
- **배포 값은 화이트리스트 후에만 셸/env 에**(`rma/deploy.js`): 인스턴스 이름·경로·계정·env 값 정규식, 비밀번호는
  KEY=VALUE 안전 집합만. 설치 경로는 추측하지 않고 `systemctl show` 출력을 재검증해 쓴다.
- **점검·액션 확장(v2.418)의 경계**: 파일 계열 점검은 엣지 `RMA_FILE_ROOTS`(realpath 기준, `testRunner.pathAllowed`) 밖을
  읽지 않는다 — 접두 문자열 비교로 바꾸면 `/var/logs` 같은 우회가 생긴다. 서비스 제어 프리셋(`unitPolicy`)은 엣지
  `RMA_SERVICE_UNITS` 에 있는 유닛만, `reboot` 는 `RMA_ALLOW_REBOOT` 일 때만 — 이 두 목록은 sudoers(`RMA_SUDOERS`,
  install.sh) 와 항상 같은 원천에서 생성한다. 원격 관리(`config`)는 **축소만**(disabledTests·longpoll·동시성) —
  허용 확대·allowCustom·서명 해제를 중앙이 내려줄 수 있게 만들지 말 것. 폴에 동봉된 점검 결과는 그 법인 스케줄에
  있는 항목 id 만 반영한다(`known` 집합) — 남의 항목 id 로 상태 위조 차단. 점검 이력은 상태 변화 + 1시간 단위만
  저장(diff-저장) — 30초 점검 × 수백 항목 전량 적재 금지.

