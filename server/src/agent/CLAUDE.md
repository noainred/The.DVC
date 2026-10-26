# 배포 대상 레지스트리(`agent/deployRegistry.js`) 불변조건

> `server/CLAUDE.md` 에서 옮긴 절(2026-10-20). 이 폴더 파일을 읽을 때 자동으로 로드된다. 원문 그대로다.

- **`SECRET_KEYS` 는 `password`·`privateKey`·`centralToken`·`collectorToken` 4종**(v2.435). 두 토큰이
  빠져 있던 v2.339~2.434 는 `GET /agent-deploy/targets` 응답과 저장 응답에 토큰을 평문으로 실었다.
  중앙 토큰 유출 = 엣지→중앙 API 임의 호출, 수집 토큰 유출 = 그 엣지 수집 데이터 열람이다.
  이 목록에서 값을 빼지 말 것 — `redact()`(응답 가림)과 `saveTarget()`('빈 값 = 기존 유지')이 같은
  배열을 쓰므로, 빼면 두 보호가 동시에 사라진다. 비밀 포함 CSV 내보내기는 `listTargetsRaw()` +
  `requireSettingsOwner` 경로만 유지.


# SSH 로 엣지 portal.env 를 바꾸는 경로(`deploy.js applyAgentCentralTokenOverExec`) — v2.777

- **쓰기 전에 접속한 장비가 그 엣지인지 확인한다**: 사용자 구성은 '메인 → 엣지1:포워딩 포트 → 엣지2' 이고 SSH 도 엣지1 의 포워딩으로 엣지2 에 닿는다.
  포워딩이 틀리면 엣지1 자신에 붙어 **엣지1 의 portal.env 에 엣지2 의 토큰을 쓰고 재시작**한다(엣지1 이 이름 불일치 403 으로 멈춘다).
  그래서 ① 대상 이름(agentName)이 없으면 멈추고 ② 접속한 장비의 이름(`effectiveAgentName` — config.js 순서·마지막 값)이 다르면 멈추고
  ③ 중앙이 pull 로 기록한 엣지 호스트 이름(`expectHostname`)이 있으면 `util/sameHostName.js` 로 hostname 과 대조해 다르면 멈춘다(모름=null 은 통과).
  이 확인을 cp·sed 뒤로 옮기거나 빼지 말 것 — 회귀 `test/edgeTokenApply2776.test.js` E-2 · 포워딩 종단 `test/edgeTokenTopo2777.test.js`.
