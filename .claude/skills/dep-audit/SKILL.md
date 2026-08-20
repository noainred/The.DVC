---
name: dep-audit
description: 의존성 CVE 전수검사 — server·web 의 npm audit 결과를 '운영 배포 영향도'로 판정한다(런타임 vs 빌드/개발 전용 vs 도달불가 transitive). "CVE 점검", "의존성 취약점", "npm audit", "패키지 보안" 요청이나 릴리스 전 점검에 사용. 읽기 전용.
---

# 의존성 CVE 감사

`npm audit` 원시 개수는 과장돼 보이므로, **실제 운영 배포물에 영향을 주는지**로 판정하는 것이 핵심이다.

## 절차
1. server·web 각각에서 감사 실행:
   ```
   (cd server && npm audit --json)
   (cd web && npm audit --json)
   ```
2. 각 취약점을 **의존 경로(`npm ls <pkg>`)로 분류**한다:
   - **런타임(운영 노출)**: 서버가 실제 실행 시 쓰는 것(예: `undici`·`express`·`ssh2`·`ws`). 최우선.
   - **빌드/개발 전용**: `vite`·`vitest`·`esbuild`·`postcss` 등 — 운영엔 정적 `web/dist` 만 배포되므로
     **운영 무영향**(개발자가 dev 서버/테스트를 신뢰 불가 네트워크에 노출할 때만 유효). `npm audit` 의
     critical/high 대부분이 여기라 개수에 겁먹지 말 것.
   - **도달불가 transitive**: 공격자 입력이 그 경로에 닿지 않는 DoS/경계검사(예: `exceljs→archiver`
     하위 트리). 실익 낮음.
3. 각 건에 대해: 패키지·설치버전·CVE 등급·**운영 영향 판정**·수정 버전(있으면)·근거를 표로.
4. **배포 런타임 Node 버전**도 언급(오프라인 패키지 `packaging/offline/build-package.sh` 의 `NODE_VERSION`) —
   Node 자체 CVE 는 npm audit 범위 밖이므로 최신 LTS 패치 유지 권고(구체 CVE 대조는 별도).

## 정직성
- `npm audit` 은 캐시된 어드바이저리 DB 기준일 수 있음 — 100% 최신 보장하려면 네트워크 열린 환경에서 재실행.
- "실패/에러" 단어가 로그에 있어도 실제 실패가 아닐 수 있음(테스트 제목·빌드 경고). 판정은 근거로.
- 코드 패턴 CVE(주입·SSRF·XSS·경로탈출)는 이 스킬 범위가 아니라 `security-auditor` 에이전트가 다룬다.
