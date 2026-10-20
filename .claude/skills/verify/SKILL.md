---
name: verify
description: 빌드·테스트 검증(npm run verify = 서버 node:test + 웹 eslint + vitest + vite build)을 올바르게 실행하고 결과를 요약한다. 샌드박스가 테스트의 127.0.0.1 바인딩을 막아 멈추는 문제를 인지해 처리. "verify", "테스트 돌려", "빌드 확인", "검증" 요청과, 화면이 바뀌는 변경을 Chromium 으로 확인할 때(목 서버 실행·Playwright 경로·1440/400 점검·A/B) 사용. 작업 시간 추정 기준값도 여기 있다.
---

# 빌드·테스트 검증

`npm run verify` 는 4단계 `&&` 체인이다: `server` 단위테스트(`node --test`) → 웹 `eslint` →
웹 `vitest run` → `vite build`. 전체 exit 0 이면 4단계 모두 통과다.

## 실행
```
npm run verify
```

## 샌드박스 주의 (중요 — 과거 실측 함정)
서버 테스트(`uagmon`·`svcmonRouteOrder` 등)가 **`127.0.0.1` 로 실제 포트를 연다**. 샌드박스가
네트워크 바인딩을 막으면:
- `listen EPERM: operation not permitted 127.0.0.1` 로 실패하고,
- 포트가 안 열려 **프로미스가 안 풀리며 수 분간 hang → 타임아웃** 된다(코드 버그 아님).

처리: `/sandbox` 로 `localhost`/`127.0.0.1` 을 허용하거나, **이 검증 명령에 한해 샌드박스를 해제**해
실행한다. 해제로 통과하면 실패는 환경 아티팩트이지 코드 결함이 아니다.

## 진단 요령
verify 가 오래 걸리면 단계를 분리해 어디서 멈추는지 본다(파일로 스트리밍 — `| tail` 은 버퍼링돼
타임아웃 시 아무것도 안 보인다):
```
npm --prefix server test  > out.log 2>&1   # 서버 테스트만
npm --prefix web run test  > out.log 2>&1   # vitest 만
npm --prefix web run build > out.log 2>&1   # 빌드만
```

## 보고
검증 대상 HEAD(`git rev-parse --short HEAD` + package.json version)와 각 단계 결과(테스트 통과 수,
vitest 파일/케이스 수, 빌드 성공)를 요약한다. exit 0 이 아니면 실패 단계와 원문 오류를 그대로 보고
(축소·미화 금지). 다중 창 동시작업 중이면 "검증 대상이 다른 창 커밋으로 바뀔 수 있음"을 명시.

## 시간이 어디서 나가는지 (추정 기준값)
- 실측(v2.513): `npm test` 전량 115초(당시 1,910건). 지금은 서버 테스트 파일 799개·웹 363개로 늘어 더 길다(미측정).
  CI 한 번(서버 테스트 + 웹 빌드)은 약 10.5분(2026-10-20 실측 3회).
- 개발 중에는 바꾼 모듈의 테스트만 돌린다(`node --test server/test/<파일>` ≈ 2초). 전량은 커밋 직전 1회이거나 CI 에 맡긴다 — 맡겼으면 보고에 적는다.
- `npm run build`(vite) 약 20초. Chromium 검증은 `web/dist` 를 서빙하므로 웹 코드를 고칠 때마다 다시 빌드해야 한다.
- Chromium 1라운드 1~2분. 라운드를 나누지 말고 한 번에 몰아서 본다. 변경 전 커밋으로 되돌린 A/B 재빌드는 약 2분(넘침·깨짐을 발견했을 때만).
- 시한(60초)을 기다려야 하는 실제 연결 확인은 진행 표시까지만 보고 끊는다.

## 화면 검증 (Chromium — 화면이 바뀌는 변경이면 필수)
단위 테스트는 문자열·판정만 본다. 줄바꿈·클리핑·카드 높이·그리드 정렬·`text-transform`·`**강조**` 가 별표로 새는 것은 브라우저만 잡는다
(실제 사고: v2.439/v2.440/v2.505 의 `**강조**` 노출, v2.202 React #310 크래시).
- 띄우는 기준: 새 화면·새 표/차트, 눈에 띄게 길이가 변하는 문구, 조건부 렌더·훅 추가, 권한/빈 상태 분기. 서버 로직·테스트·문서만 바뀌면 생략하고 **생략 사실을 보고에 적는다**.
- 실행(이 환경에서 그대로 동작):
  ```
  cd server && mkdir -p tmp && CONFIG_DIR=tmp DATA_SOURCE=mock AUTH_ENABLED=false PORT=<포트> \
    node src/index.js &          # 목 데이터 · 인증 없음. web/dist 를 서빙하므로 먼저 vite build
  until curl -sf http://127.0.0.1:<포트>/api/health >/dev/null; do sleep 2; done
  ```
  Playwright 는 전역 설치분을 `createRequire('/opt/node22/lib/node_modules/playwright/package.json')` 로 불러오고
  `chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] })`. `playwright install` 은 하지 말 것.
  스크린샷 경로는 절대 경로(스크래치패드)로 — 상대 경로면 저장소에 png 가 떨어진다.
- 볼 것: ① `pageerror`·console error 0 ② `scrollWidth - clientWidth` 가로 넘침 ③ 1440px·400px 두 폭 ④ 실제 클릭으로 화면이 열리는지
  ⑤ 스크린샷을 **직접 읽어** 확인(수치만 보면 잘린 텍스트를 놓친다).
- 내가 만든 결함인지는 A/B 로 확정한다(변경 전 코드로 되돌려 재빌드해 같은 수치가 나오는지). 확인 없이 내 탓·남의 탓으로 적는 것 둘 다 거짓 보고다.
- 끝나면 목 서버를 반드시 죽이고 `pgrep -af "node src/index.js"` 가 0 인지 확인해 보고한다(`server/tmp/` 는 .gitignore 대상).
  `pkill -f '<패턴>'` 은 그 패턴을 담은 자기 셸까지 죽인다 — PID 로 죽일 것.
