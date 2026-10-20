# 배포 대상 레지스트리(`agent/deployRegistry.js`) 불변조건

> `server/CLAUDE.md` 에서 옮긴 절(2026-10-20). 이 폴더 파일을 읽을 때 자동으로 로드된다. 원문 그대로다.

- **`SECRET_KEYS` 는 `password`·`privateKey`·`centralToken`·`collectorToken` 4종**(v2.435). 두 토큰이
  빠져 있던 v2.339~2.434 는 `GET /agent-deploy/targets` 응답과 저장 응답에 토큰을 평문으로 실었다.
  중앙 토큰 유출 = 엣지→중앙 API 임의 호출, 수집 토큰 유출 = 그 엣지 수집 데이터 열람이다.
  이 목록에서 값을 빼지 말 것 — `redact()`(응답 가림)과 `saveTarget()`('빈 값 = 기존 유지')이 같은
  배열을 쓰므로, 빼면 두 보호가 동시에 사라진다. 비밀 포함 CSV 내보내기는 `listTargetsRaw()` +
  `requireSettingsOwner` 경로만 유지.

