# M3 핸드오프 — UAG 모니터 자격증명 유출 (uagmon/ 소유 세션 앞)

> 이 문서는 **다른 세션이 소유한 `uagmon/` 코드**의 보안 결함(M3)을 그 세션이 그대로 적용할 수 있게
> 정리한 핸드오프입니다. 교차 세션 위생상 **이 세션은 `uagmon/`을 수정하지 않았습니다** — 아래 수정은
> `uagmon/`를 소유한 세션이 적용해 주세요. 근거: `security_check_20260808.MD` M3.
> (라인 번호는 2026-08-08 조사 시점 기준. 적용 전 현재 코드로 재확인 요망.)

## 결함 요약 (확인 — 미수정 상태)

인증된 사용자가 **저장된 UAG 관리자 비밀번호를 임의 외부 서버로 유출**시킬 수 있다(체인 3조각):

1. **`uagmon/lib/store.js:23`** `normalizeTarget` — PUT 수정 시 password 가 비면 **기존 비번을 그대로 유지**.
   host 만 바꿔치기 가능(`const password = body.password ? ... : (existing.password || '')`).
2. **`uagmon/lib/uag.js:25-34`** `fetchUagStats` — `target.host` 로 `Authorization: Basic base64(user:pass)` 를
   **최초 GET 에 선제 전송**(401 챌린지를 안 기다림). host 는 여기서 재검증 안 됨(등록 시 1회만).
3. **`uagmon/lib/guard.js:47-55`** `ipv4Reason` — 우회표기/루프백/링크로컬은 차단하나 **공개 IP·공개 도메인은
   허용**(`evil.com`·`8.8.8.8` 등록 가능, 재확인됨).

→ 사용자가 기존 target 의 host 를 자신이 통제하는 공개 서버로 바꾸고 password 를 비워 저장한 뒤
`POST /api/targets/:id/test` 또는 `/api/poll-now` 를 부르면, UAG 관리자 자격증명이 공격자 서버의
Basic-Auth 헤더로 캡처된다. 서버 모드(단일 공유 비번·인증 필요·정상 기능 악용)라 **medium**. 데스크톱
(127.0.0.1) 모드는 단일 로컬 사용자라 해당 없음.

## ★ 모든 소비처 (형제 누락 방지 — 빠짐없이)

**자격증명이 네트워크로 나가는 지점 = `fetchUagStats` 호출부 2곳:**
- `uagmon/server.js:81`(`pollOnce` 내부) — ① setInterval 폴러 `:87` ② 기동 즉시 `:89` ③ `POST /api/poll-now` `:182` ④ `POST /api/targets` 직후 `:192` ⑤ `PUT /api/targets/:id` 직후 `:204`
- `uagmon/server.js:217` — `POST /api/targets/:id/test`

→ **권고 ②는 반드시 `fetchUagStats`(uag.js) 내부에** 넣어야 위 5+1 트리거가 한 번에 덮인다. 두 호출부에
개별 삽입하면 폴러 형제를 놓친다(M1 실수와 동형).

**normalizeTarget 소비처 3곳**: load `store.js:44`·addTarget `:60`·updateTarget `:69` — 권고 ①은
`normalizeTarget` 한 곳(:23) 수정으로 세 경로 모두 서버측 강제.

**hostBlockReason 소비처**: `server.js:232`(`validateTarget`) 1곳, add/update 공유(`:189`,`:200`).

## 최소 수정안 3가지

### ① host 변경 시 저장 password 무효화 — `store.js:23`
```js
const host = String(body.host ?? existing.host ?? '').trim();
// ...
const hostChanged = existing.host != null && host !== String(existing.host).trim();
const password = body.password
  ? String(body.password)
  : (hostChanged ? '' : (existing.password || ''));   // host 바뀌면 이월 금지
```
host 가 바뀌면 비번이 빈 채 저장돼 이후 요청이 빈 자격증명을 보내므로 **유출 차단**(재입력 UX 는 프론트 몫).

### ② 연결 직전 해석 IP SSRF 재검증 — `uag.js` `fetchUagStats` 내부
- `guard.js` 의 IP 판정을 export(예 `ipReason(addr)`)하고, `fetchUagStats` 에서 `dns.lookup(target.host)` 후
  **해석된 주소**를 검사한 뒤 그 IP 로 접속·`servername`/`Host` 는 원래 호스트로 핀(TOCTOU/DNS rebinding 차단).
  포탈 본체의 `collector/registry.js ssrfBlockReasonResolved` 와 동형.
- ⚠️ **유일한 구조 변경**: 현재 `new Promise((resolve)=>...)` executor 안에서는 await 불가(async executor
  안티패턴) → `fetchUagStats` 앞단을 async 화해 `await dns.lookup` 후 `https.request`. 호출부(`server.js:81`·`:217`)는
  이미 `await` 라 무수정.

### ③ 사내 화이트리스트(옵트인) — `guard.js:47-55` `ipv4Reason`
- 공개 IP 기본 차단, RFC1918 만 허용, `UAGMON_ALLOW_PUBLIC=true` 이스케이프.
- 호스트네임 분기(`guard.js:87`)는 `UAGMON_ALLOWED_DOMAINS` 접미사 매칭.
- (참고) IPv6 ULA(`fc00::/7`)는 현재 무조건 허용(`guard.js:79`) — 우선순위 낮음, 별도 처리 권장.

## 정직 고지
위 스니펫은 **정적 분석 제안**이며 실행·재현하지 않았습니다(수정 금지 범위). ②의 async 전환이 단순
라인 치환이 아닌 유일한 구조 변경입니다. 적용 세션이 현재 코드로 재확인 후 반영해 주세요.
