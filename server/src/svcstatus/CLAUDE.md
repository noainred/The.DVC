# 포탈 서비스 상태 모니터링(`svcstatus/`) 불변조건 (v3.54)

> 사용자 요청 2026-11-26 "포탈에 등록된 vcenter, edge … cvp, 스토리지 … 포탈에 등록된 ip/port 형식으로 모니터링"(일부 서비스는 포트 포워딩).
> 시안 `docs/design/portal-svc-status/README.md`(컨펌 2026-11-27 '좋아 기본값대로 구현해줘'). 회귀 `server/test/svcStatus354.test.js`.

- **대상은 손으로 등록하지 않는다** — 설정 카탈로그(`linkcheck/settingsLinks.js buildSettingsTargets` — 통신 점검 · Monitoring 설정 연동과 같은 열거기 하나)에서
  `set:collector` · `set:vcenter` · `set:cvp` · `set:storage-*` 만 골라 **매 주기 다시 계산**한다(`targets.js planTargets`). 새 종류를 보이려면 카탈로그에 더하고 `KIND_OF` 에 한 줄.
- **접속처 = 등록된 주소:포트 그대로**(카탈로그 판정 — URL 형은 포트, 없으면 https 443 · http 80). 스토리지는 SSH = 등록 sshPort, REST = **기종별 env 포트**
  (`storage/endpoint.js` 하나 — 수집기 6개 · 카탈로그 · 엣지가 같은 표를 쓴다. 사본을 만들지 말 것 — 시험 ②가 수집기 소스를 본다). '기본 포트 아님' 은
  계산된 포트 ≠ 그 방식의 기본(URL 은 :443 을 지운다 — `u.port` 유무로 보지 말 것).
- **측정하는 곳**: 엣지 포탈 = 중앙 · 직접 수집 vCenter = 중앙 · 현지 수집 vCenter = 담당 엣지(`bmusage/targets.js siteOwnerByVcenter` — 위임 인벤토리 소유 → 스냅샷 관측) ·
  CVP · 스토리지 = 등록부 agent(빈 값이면 중앙). 담당을 모르면 **중앙이 대신 재지 않는다**(`unassigned` — 중앙에서 안 닿는 주소를 '끊김' 으로 적는 거짓).
- **판정 코어는 `judge.js` 하나**(웹은 상태 · 사유 코드로 색 · 문구만 — 웹 시험이 코드 목록을 대조): 끊김 = 연속 `failThreshold` 회 · 그 전 실패는 직전 판정 유지 ·
  처음부터 실패 = 판정 중(pending — 사건 아님) · 지연 = 대상별 평소(최근 7일 성공 표본 중앙값 · 최소 30표본 · `refreshBaselines` 주기 틱이 저장 — **응답 경로에서 계산 금지**) ×
  `slowFactor` 초과 ∧ 차이 `slowMinDeltaMs` 이상 · 평소를 모르면 지연 판정 없음 · 못 잼 = 측정 없음 · 멈춤(`staleLimitMs`) · 엣지 사유(`view.js edgeReasonOf` — classifyCvpEdge 재사용).
  꺼짐 · 제외 · 설정 오류는 **합계(4상태) 밖**에서 따로 센다.
- **측정 단위 = (id, 주소, 포트)**(`sv_target.tid`) — 주소 · 포트가 바뀌면 새 단위(평소 · 이력이 섞이지 않게). 상세의 '등록부에서 자동 등록' 은 단위의 첫 시각.
- **저장(db.js)**: 원시 8일(24h 상세 + 7일 평소) · 30분 칸 · 최신 전용 표(`sv_latest` — GROUP BY+MAX 금지) · 사건은 판정이 바뀔 때만 · 적재는 트랜잭션 하나 ·
  INSERT OR IGNORE + changes 0 이면 칸 · 판정을 건드리지 않음(엣지 재전송) · 늦게 온 행은 최신값을 바꾸지 않음 · 실패 연결 시간은 NULL(평균 분모 ms_n) · prune 청크 + 양보.
  데모 백필 · 대량 적재는 **1,500행 묶음**(실측 약 11ms) — 하루치 2만 행을 한 트랜잭션에 넣지 말 것.
- **엣지 수신(`service.js putEdgeReport`)**: 개별 토큰만 · 인증된 agent 의 **자기 몫**(중앙 계획의 `plan==='edge' ∧ by===agent`) · id 와 **주소 · 포트가 중앙이 준 것과 같을 때만**(아니면 rejected) ·
  엣지 시각을 받지 않는다(행마다 나이 `a` → 수신 시각에서 뺀다 · 0~24h 밖은 수신 시각 + badTime) · 모르는 실패 종류는 unknown · 상한 `REPORT_MAX`(넘는 것은 omitted).
  설정 pull(`edgeConfigFor`)은 자기 몫만 · 토큰 없음 · 설정을 처음부터 못 읽었거나 등록부를 처음부터 못 읽은 종류가 있으면 503(빈 목록이 엣지 측정을 멈추게 하지 않는다).
- **엣지 워커(`agent/svcStatusWorker.js`)**: 0건 · 꺼짐이어도 보고 · `_last` + 콘솔 · 중앙 값(주기 · 동시성 · 시한)을 다시 자른다(상수 = `settings.js LIMITS` — 시험 대조) ·
  스토리지 REST 는 엣지 env 포트가 중앙이 준 포트와 다르면 `lp` 로 알린다(측정은 중앙이 준 포트로 — 화면 note).
- **설정(settings.js)**: 공용 로더 · 오류 중 저장 409 · **제외 목록 · 알림은 못 읽어도 풀지 않는다**(`_lastGood`) · 제외는 한 건씩(`setExcluded` — 동시 편집이 서로 덮지 않게) ·
  숫자 빈 칸은 현재 값 유지 · 처음부터 못 읽은 주기에는 보존 정리를 건너뛴다(기본 보존일로 지우지 않게).
- **메일(notify.js — 종류 `svc-status`)**: 1분 틱 · 측정 주기 밖 · 대상별 커서(`sv_latest.notified`) · 처음 본 상태는 기준점만 · 정책상 꺼짐이면 커서만 이동 · 실패 · 인증 정지 · 한도는 커서 유지 + 10분 뒤 ·
  법인별 한 통 · 5법인 넘으면 요약 · 사람이 끄거나 뺀 대상은 조용히 정상 · 데모는 보내지 않는다(커서는 이동).
- **게이트**: `/api/tools/svc-status*` 전부 관리자 ∧ 전체 범위(전 법인 주소:포트 · 담당 엣지) · 비관리자 판본은 주소 가림(`addressHidden`) ·
  데모 계정은 데모 항목만(가림은 memo **밖에서**) · 설정 API 는 `READ_DENY` · 지금 측정 · 제외는 데모 계정 403(실제 주소에 연결한다).
- **TCP 연결만 본다** — 로그인 · 서비스 응답 · 장비 건강은 보지 않는다(화면 첫 문단 · 메일 꼬리가 밝힌다). DNS 는 시한 있는 lookup + 차단 대역 거름 + 해석한 주소로 핀(`linkcheck/checks.js stepDns → stepTcp`).
