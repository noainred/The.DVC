---
name: verify
description: 빌드·테스트 검증(npm run verify = 서버 node:test + 웹 eslint + vitest + vite build)을 올바르게 실행하고 결과를 요약한다. 샌드박스가 테스트의 127.0.0.1 바인딩을 막아 멈추는 문제를 인지해 처리. "verify", "테스트 돌려", "빌드 확인", "검증" 요청에 사용.
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
