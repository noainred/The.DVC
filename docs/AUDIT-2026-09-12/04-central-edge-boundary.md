# 감사 04 — 중앙 포탈 ↔ 엣지/수집기 신뢰 경계 및 업그레이드/공급망 경로

- 대상: `/home/claude/the.dvc/server/src` (읽기 전용)
- 범위: `routes/central.js` 및 등록 라우트, `routes/collector.js`+`collector/puller.js`, 업그레이드/공급망 경로, config push, 토큰 처리
- 방식: 코드 검증 + 격리 환경 PoC 1건 실행. `security_check_20260809.MD`(M-1/M-2/L-1), `docs/AUDIT-2026-08-17.md`, `server/CLAUDE.md` 대조.
- 결론: M-1/M-2/L-1 은 **회귀 없이 해소 유지** 확인. 신규 취약점 1건(HIGH) 코드+PoC로 확인. 나머지는 대체로 양호.

---

## 확정 취약점

### H-1 [HIGH · CWE-290/CWE-639] `/register-collector` — 개별 토큰 agent 바인딩 우회로 임의 수집기 항목 탈취 (신규, 확인됨)

- **위치:** `server/src/routes/central.js:136-139` (`requestedAgent`), `:198-248` (`/register-collector`), 저장은 `collector/registry.js:358-369` `upsertCollectorFromAgent`
- **근본 원인:** 바인딩 대상 이름을 고르는 `requestedAgent` 가 **OR 단락(||) 우선순위**로 되어 있다:

```js
const requestedAgent = (req) => String(
  req.query?.agent || req.get('X-Agent-Name') || req.body?.agent
  || (req.path === '/register-collector' ? req.body?.name : '') || '',
).trim();
```

  `/register-collector` 의 진짜 저장 키는 `body.name`(→ 수집기 id)인데, 요청에 `X-Agent-Name`(또는 `?agent=`, `body.agent`)이 하나라도 있으면 `||` 단락으로 **`body.name` 을 아예 보지 않는다.** 공격자는 자기 토큰의 agent 이름을 `X-Agent-Name` 에 넣어 미들웨어(`:147`)의 일치 검사를 통과시키고, `body.name` 에는 **남의 엣지 이름**을 넣는다. 라우트(`:202`)는 `body.name` 을 그대로 수집기 id 로 써 `upsertCollectorFromAgent` 로 **다른 엣지의 수집기 항목(URL·collectorToken)을 덮어쓴다.**
- **공격자 전제:** 유효한 개별 토큰을 가진 침해 엣지 1대(agent 모드). 대상은 `managed=false` 수집기(엣지 자기등록의 기본값).
- **CLAUDE.md 규약 위반:** `central.js:12-13` "저장 키는 `req.centralAuth.agent` 만… 이름 필드를 생략하면 검사가 아예 안 걸린다" — 정확히 이 클래스. `requestedAgent` 주석(`:134-135`)은 `body.name` 을 바인딩에 포함한다고 적었으나 `||` 우선순위가 그 의도를 무력화한다.
- **PoC (격리 환경에서 실제 실행, 재현 성공):**

```
# edgeA 개별 토큰 보유. 사전 상태: edgeB → url=http://10.9.9.9:4000, token=B-collector-token
POST /api/central/register-collector
X-Central-Token: <edgeA 개별토큰>
X-Agent-Name: edgeA
{ "name": "edgeB", "urlHint": "http://10.8.8.8:4000", "collectorToken": "ATTACKER" }

→ 200 OK. 결과: edgeB.url = http://10.8.8.8:4000, token = ATTACKER (덮어써짐)
# 대조군) X-Agent-Name 없이 name=edgeB → 403 "이 토큰은 'edgeA' 전용입니다" (바인딩이 정상 작동)
```

  즉 헤더 하나로 403 이 200 으로 바뀐다. `CENTRAL_VERIFY_SELF_REGISTER`(기본 on)의 ping 검증도 우회 불가하지 않다 — 공격자가 URL·토큰을 모두 지정하므로 자기 서버가 `/api/collector/ping` 에 `{agent:'edgeB'}` 로 응답하면 `identityIssue`(registry.js:247)를 통과한다.
- **영향(피벗까지):** 수집기 항목의 `url`/`token` 은 중앙이 **아웃바운드로 자격증명을 실어 호출**하는 대상이다:
  - `collector/puller.js:23` — 그 URL의 `/export` 를 폴링(전력·인벤토리·servers 데이터 오염, 실호스트 은폐).
  - `central/idracScanPush.js:48` — 관리자가 입력한 **iDRAC username/password 를 그 URL로 평문 전송**(`/api/collector/idrac-scan`).
  - `bmstor/poller.js:65` — 서버 **SSH username/password 를 그 URL로 전송**(`/api/collector/bmstor-collect`).
  - `routes/admin/collectorsDc.js:206` — `/api/collector/set-password` 로 계정 비번 전송.
  URL을 공격자 서버로 바꾸면 이후 중앙발 위임 스캔/수집이 관리자 입력 자격증명을 공격자에게 흘린다 → HIGH.
- **수정안:** `/register-collector` 는 `body.name` 을 유일한 바인딩·저장 키로 강제한다. 최소 수정: 라우트 진입에서 `if (req.centralAuth.mode === 'agent' && norm(req.body?.name) !== norm(req.centralAuth.agent)) return 403;` 를 직접 검사(다른 3규약 라우트처럼). 근본 수정: `requestedAgent` 에서 `/register-collector` 는 `body.name` 을 **최우선**으로 보게 하거나, 이 경로만 `||` 체인 밖에서 별도 판정. `svcmon-report`(:283) 처럼 저장 키를 `req.centralAuth.agent` 로만 쓰는 것이 이상적이나, register 는 이름=수집기 id 라 최소한 body.name↔token 일치 강제가 필요.

---

## 이전 감사 항목 회귀 점검 (M-1/M-2/L-1) — 회귀 없음

- **M-1 (연합 로그 조회)** — 해소 유지. `/log-queries`(central.js:915-922)는 agent 모드에서 `vcs.filter(agentOwnsVcenter)`, `/log-query-result`(:924-939)는 body 값이 아닌 `vcenterOfReq(reqId)` 로 소유권 판정.
- **M-2 (IPAM 스캔 병합)** — 해소 유지. `/ip-scan-result`(:993-1015)는 agent 모드에서 배정 ranges 를 **필터 진입 전 1회 컴파일**(`specToRange`)해 범위 밖 IP 드롭. ranges 미설정=TOFU. 논블로킹 불변조건 준수.
- **L-1 (Ping)** — 해소 유지. `/ping-jobs`(:872-879)·`/ping-result`(:882-893) 모두 `agentOwnsVcenter` 소유권 모델.

---

## 확인된 양호한 방어

1. **개별 토큰 저장/비교** (`central/agentTokens.js`): 토큰 원문 미저장, SHA-256 해시만(0600, atomicWrite, preserveCorrupt). `resolveAgentByToken:102-117` 은 전 항목 순회+`crypto.timingSafeEqual`+조기 break 없음(타이밍 누설 차단). 발급 256bit(`:69`).
2. **공유 토큰 비교** (`util/secureCompare.js`): `tokenMatches`→`timingSafeEqualStr` HMAC 정규화 상수시간. 빈 expected 는 항상 false.
3. **RMA 개별 토큰 전용** (central.js): `/rma-poll`(:751)·`/rma-result`(:826)·`/rma-credential`(:804) 모두 `mode !== 'agent'` 면 403. rma-result 는 `rmaJobAgentOf(reqId)` 소유주 일치 검사. 브로커(:801-820)는 agent 모드 + `credentialStore.brokerFetch` 의 agents·hosts 범위 이중 검사 + 분당 상한 + `Cache-Control: no-store` + 감사(비밀 미기재). CLAUDE.md RMA 불변조건 준수.
4. **위임잡 reqId 소유권** (`reqAgentDenied` :180-184): idrac-scan-progress/result(:495,:507), capture-result(:953), bmstor-result(:972) 적용. bmstor 는 추가로 `ackd.serverIds` 로 결과 id 화이트리스트(:977-978).
5. **엣지 간 쓰기 격리(소유권 필터)**: gpu-guest-data 최장프리픽스 `ownsVc`+direct-mode 거부(:534-564), storage/pdu/sanswitch-data·sanswitch-perf 는 `devicesForAgent` 위임 목록으로 미위임 deviceId 드롭 + collectedAt 수신시각 clamp(:625-632,:668-674,:717-718,:848-854). inventory/guest-disk 는 TOFU 소유권(:392-397,:447-450) + mock 콘텐츠 차단.
6. **config-pull 자격증명 배포 스코핑**: storage-config(:596)·pdu-config(:644)·sanswitch-config(:687) 은 agent 모드에서 요청 agent≠토큰 agent 거부 후 `devicesForAgent(agent)` 로 **자기 위임분만** 반환. users-config/gpu-guest-config 는 `agent` 로 스코핑. 침해 엣지 토큰으로 남의 엣지 자격증명 열람 불가(agent 모드 한정).
7. **업그레이드 sha256 — 모든 수신 경로 검증(CLAUDE.md v2.480 규약 이행 확인)**:
   - 자체 remote 설치: `upgrade.js downloadArchive:382-393`, `fetchPackage.js:75-83`, `bundleSource.js verifyBundleSha:33-50` — sha 부재도 거부(`UPGRADE_ALLOW_UNVERIFIED`만 예외).
   - 엣지 수신 `/api/upgrade/bundle`: `routes/upgrade.js:194-195` `bundleShaIssue(X-Bundle-Sha256, body)` + adminOnly.
   - 수집기 수신 `/api/collector/upgrade`: `routes/collector.js:203-204` 동일, **인증을 256MB raw 버퍼링 앞**에서 수행(:195-199, DoS 증폭 차단).
   - push 측이 `X-Bundle-Sha256` 송신: `upgrade.js pushBundleToEdge:452`, `collector/upgradePush.js:38`.
   - `bundleShaIssue:429-438` 은 헤더 형식(`^[0-9a-f]{64}$`) 검증 + 상수 아닌 정확 대조.
8. **업그레이드 아카이브 하드닝** (`upgrade/archive.js`, `upgrade.js`): `MAX_BUNDLE_BYTES=200MB`·`MAX_MEMBERS=20000`(archive.js:13-14), `acceptMember:69-76` 트래버설 가드(`..` 거부·pkgName 하위만), `collectMembers:84` 합계 크기·멤버 수 상한. `downloadArchive:373` 파일명 화이트리스트(`ARCHIVE_RE`)+크기캡, `fetchPackage.js:58-61` `basename`+확장자 화이트리스트로 versions.json 경유 경로이탈 차단.
9. **업그레이드 트리거 admin 전용**: `routes/upgrade.js` 전 제어 라우트 `adminOnly=requireRole('admin')`, `index.js:171` `/api/upgrade` 에 authMiddleware+requireEnrolled+auditMiddleware.
10. **엣지가 중앙에 임의 URL 다운로드 유발 불가**: remoteBase/edges URL 은 admin 이 `PUT /settings`(routes/upgrade.js:175, `validateUpgradeSettings`→`urlReason`→`ssrfBlockReason`)로만 설정. 엣지 인바운드가 원격 소스 URL 을 주입하는 경로 없음. installDir/watchDir 는 `pathReason` 로 허용 베이스 제한.
11. **collector puller 입력 정화** (`collector/puller.js:44-52`): watts 범위(0~1,000,000) 검증, 미래 ts(>5분 skew) 거부→수신시각, serverId 중복 제거. 토큰 비교 `tokenMatches`(collector.js:28) 상수시간. deny 로그에 토큰 값 미기재(지문만, :49).
12. **agent-config push** (central.js:897-912): 저장 키 `req.centralAuth.agent` 강제, 파일 200개·개당 8MB 상한, `require_basename` 로 경로 성분 제거. 저장소 null-proto(`central/agentConfig.js:14`)로 프로토타입 오염 차단. 백업 수집 `DENY_NAMES`+확장자 화이트리스트(backup/service.js:19-21).
13. **토큰 발급/회수 소유자 경계**: `routes/admin/centralIpam.js:70,76` `issueAgentToken`/`revokeAgentToken` 에 `adminOnly + requireSettingsOwner`(v2.480 S3), 평문 토큰은 발급 응답 1회만. `ingest-stats/reset`(:45)·`force-token`(collectorsDc.js:428) adminOnly.

---

## 추정 / 잔여 관찰 (수정 대상 아님 또는 미확정)

- **[추정, 설계상 수용] 공유 CENTRAL_TOKEN 전체신뢰**: 공유 토큰 모드는 모든 소유권/바인딩 검사를 생략(agent 모드 한정 방어). H-1 도 공유 토큰이면 애초에 임의 등록 가능(설계). 완전 봉인은 `CENTRAL_REQUIRE_AGENT_TOKEN=true`. 문서화된 수용 리스크와 일치 — 단, H-1 은 **개별 토큰 모드에서도** 우회되므로 별개의 실취약점.
- **[추정] `TOUCH_MS` 스로틀의 lastUsedAt** (agentTokens.js:89): 인증 결정과 무관, 저위험.
- **[관찰, 양호] set-password `trusted` 미전달** (collector.js:135-143): 원격에서 보호계정 비번 심기 차단 — 6차 재감사 지적 반영 확인.
- **[추정] `UPGRADE_ALLOW_UNVERIFIED`/`UPGRADE_TLS_INSECURE` blast radius**: 둘 다 **전역 env** 라, 사내 미러 하나 때문에 켜면 GitHub 공식 경로·엣지 push 수신 검증·TLS 검증이 **동시에** 꺼진다(코드 주석도 이를 인지, dlsource.js:40-42). 운영 리스크로 문서화 권장이나 코드 결함은 아님.

---

## 우선순위

1. **H-1 즉시 수정** — `requestedAgent` 의 `||` 우선순위로 `/register-collector` body.name 바인딩이 헤더 하나로 우회됨(PoC 확인). 개별 토큰 침해 엣지가 타 수집기 URL/토큰을 탈취 → 중앙발 자격증명 아웃바운드 리다이렉트.
2. 나머지 경로(M-1/M-2/L-1 및 업그레이드 sha256, 소유권 필터)는 회귀 없이 방어 유지.
