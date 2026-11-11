# `server/src/ping/` — Ping 모니터 불변조건

> v2.964 사용자 요청 "화면에서 주기 설정할 수 있게 · ping 은 중단없이 계속 ping"(선택: 1초 간격 연속 측정 + 주기 요약).
> 회귀: `server/test/pingContinuous2964.test.js`(변이 7/7) · `web/src/views/pingSettingsText.test.js`.

- **측정은 대상마다 독립 루프**(`monitor.js createPingEngine`) — '재기 → 측정 간격에서 걸린 시간을 뺀 만큼 쉼 → 다시'. 한 바퀴 `setInterval` +
  재진입 가드로 되돌리지 말 것: 한 바퀴가 주기보다 길면 다음 회차를 건너뛰어 기록이 비었고(예전), 느린 대상이 다른 대상을 막는다(테스트 ②).
- **저장은 요약 주기 시계 경계마다 대상당 한 줄**(n · fail · rn · rtt 평균 · mn · mx) — 1초 측정을 그대로 쓰지 말 것(대상 30개 × 1년이면 9억 행).
  예전 줄(측정 1회, 새 열 NULL)과 요약 줄은 `db.js` 의 **W_\* 식 하나**로 묶는다 — 평균은 rn 가중, 손실은 SUM(fail)/SUM(n). 새 집계를 만들면 같은 식을 쓴다
  (원시 버킷 · 시간 롤업 적재/시드/재구성 · NDJSON `weightOf`). `COUNT(*)` 를 측정 수로 쓰지 말 것.
- **설정은 `settings.js` 하나**(측정 간격 · 요약 주기 · 시한) — 기본은 env(`PING_MON_PROBE_MS` · `PING_MON_INTERVAL_MS` · `PING_MON_TIMEOUT_MS`), 화면 값이 이긴다.
  모듈 로드 때 굳히지 않는다 — 엔진이 매 측정마다 읽고, 변경 알림에 지금 창을 마감해 새 경계로 맞추며 쉬던 루프를 깨운다. 손상 파일은 보존 + 저장 거절(503).
  웹 범위(`web/src/views/pingSettingsText.js`)와 1:1(테스트 ⑩).
- **DNS 는 대상 호스트마다 캐시**(60초 · 실패 10초 · 조회 시한 3초 · 실패 시 예전 주소 유지) — 1초마다 `dns.lookup` 하면 libuv 스레드 풀(4)을 DNS 가 차지한다.
- **ICMP 는 프로세스 상한**(`config.ping.concurrency`) — 슬롯은 놓을 때 기다리는 쪽에 바로 넘긴다(넘치는 순간이 없다 · 테스트 ⑥). TCP 연결은 대상마다 1개.
- 종료(`index.js gracefulExit`)는 `stopPingMonitor()` 로 진행 중 창을 쓴다(DB 가 열려 있으면 동기 쓰기 — process.exit 전에 끝나게).
- 측정 설정 저장은 관리자 · 전체 범위(전 대상의 측정을 바꾼다). 조회는 인증만 · 부하 산수(전 대상 수)는 전체 범위만.
- ⚠ 측정 간격을 줄이면 대상 쪽 연결 · ping 횟수가 그만큼 는다(1초 = 대상당 하루 86,400회) — 화면이 저장 전 미리보기로 말한다. 데모(mock)는 실제로 재지 않는다.
