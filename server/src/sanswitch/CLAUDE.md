# SAN 스위치 연결 테스트 대행(v2.421) 불변조건

> `server/CLAUDE.md` 에서 옮긴 절(2026-10-20). 이 폴더 파일을 읽을 때 자동으로 로드된다. 원문 그대로다.

- `sanswitch/testRuns.js` 의 run 객체에는 비밀번호(device.password)가 있지만 **`getTestRun()` 응답에는 device/비밀번호를
  절대 넣지 않는다**(sanitize). 엣지에 내려가는 `testNow` 만 비밀번호를 포함한다(엣지가 로그인해야 함) — 이것은
  `sanswitch-config` 와 같은 신뢰 경계(개별 토큰 바인딩 agent 대조 후 서빙).
- 결과 회신(`POST /api/central/sanswitch-test-result`)은 **그 요청의 대상 엣지와 같은 agent 만** 받는다
  (`completeTestRun` 대조). 회신 본문은 `sanitizeResult` 로 화면이 쓰는 필드만·크기 제한해 저장한다(임의 필드/대용량 차단).
- SSH 추적 로그(`proxy/sshExec.js trace/verbose`)에 비밀번호·개인키를 찍지 않는다. ssh2 debug 는 프로토콜 단계만 남긴다.
  구형 알고리즘 폴백은 협상 실패(`no matching …`)에만 1회이며 항상 추적 로그에 남긴다(조용한 하향 금지).

