# 성능·보안 전수조사 (2026-09-13, v2.503.0)

사용자 요청: **"보안점검 취약점 점검 성능 튜닝 성능 개선 문서화 최적화 진행 전수조사 실행"**

7개 영역을 병렬로 감사했다 — 성능 5도메인(수집·폴러 / SQLite·DB / HTTP 응답 경로 / 중앙↔엣지 전송 /
프론트엔드) + 보안 2도메인(직전 감사 미완독 영역 / v2.500~2.502 신규 코드). 같은 날 앞선 보안 전수 감사
(`AUDIT-2026-09-13.md`, v2.500)와 **범위가 겹치지 않도록** 보안 쪽은 '그때 읽지 못한 영역' 과 '그때 새로
쓴 코드' 로 좁혔다.

## 이 문서의 정직성 규약

- **측정한 것과 추정한 것을 구분한다.** 표의 '근거' 열이 `실측` 이면 실제로 잰 값이고, `추정` 이면
  가정에서 계산한 값이며 그 가정을 함께 적었다.
- 측정은 **이 샌드박스 컨테이너**에서 했다(Node v22.22.2). 운영 서버가 아니므로 **절대값이 아니라
  배수·실행계획(EXPLAIN QUERY PLAN)** 을 근거로 읽어야 한다.
- 실제 vCenter 에 접속해 잰 값은 없다. 고RTT(800ms) 관련 수치는 전부 추정이다.
- **틀렸던 판단도 적었다**(아래 '측정이 직관을 뒤집은 사례').

---

## 1. 확정·조치한 항목

### 성능

| # | 파일 | 문제 | 근거 | 조치 |
|---|------|------|------|------|
| P-1 | `server/src/perf/stats.js:12` | 히스토그램 첫 경계가 50ms — 이 서버 API 는 거의 전부 50ms 미만이라 **전 표본이 0번 버킷**에 몰려 p50·p95·p99 가 모두 `maxMs` 로 붕괴 | 실측 | 1·2·5·10·25ms 경계 추가 |
| P-2 | `server/src/vmtrack/db.js` | `changes` 에 `vcenter_id` 인덱스 없음 → `SCAN changes` + temp b-tree, vCenter 28개 = 풀스캔 28회 | **실측 2,329ms → 114ms (20.4배)** | 커버링 인덱스 `idx_changes_vc_kind` |
| P-3 | `routes/api/toolsCapacity.js` `/tools/capacity-forecast` | DS 1대당 시계열 조회 2회를 **양보 없이** 동기 루프. memo 없음(형제 엔드포인트는 전부 memoJson) | **실측 요청당 1,563ms 하드블록**(1,100 DS × 120일 = 3.17M행) | memoJson(30초, scopeKey) + 100건마다 `setImmediate` 양보 |
| P-4 | `server/src/vcenter/soapClient.js` | `powerCounterId`/`gpuUtilCounterId` 가 v2.447 카탈로그 캐시를 **안 쓰고** 매번 카탈로그 전량 재다운로드 | 합성 실측 461KB/회 → 28 vCenter × 30초 ≈ 13MB/30초(추정) | `perfCounterMap()` 경유(각 2줄) |
| P-5 | `capacity/sampler.js` · `logs/poller.js` | `% N === 1` / `tick++ % N === 0` → **기동 후 첫 틱에 prune**. `metrics/sampler.js` 가 명시적으로 금지한 v2.453 패턴의 재발 | 코드 | `(++tick % N) === 0` |
| P-6 | `logs/poller.js` 용량 정리 루프 | 반복마다 `db.meta()`(풀스캔 2회) — 상한 50회 = 최악 100회 전체 스캔이 한 틱에 동기로 | EQP | 행 수를 루프 **밖에서 1회** + GROUP BY 없는 `rowCount()` 신설 |
| P-7 | `logs/db.js meta()` | 로그 화면이 페이지를 넘길 때마다 필터와 무관한 풀스캔 2회 | EQP | 30초 TTL memo(`LOGS_META_TTL_MS`), prune 시 무효화 |
| P-8 | `web/src/components/sortableText.js` | `compareKeys` 가 비교마다 옵션 붙은 `localeCompare` 호출 | **실측 50.1ms → 2.2ms (22배)**, 1,100행 정렬 | 공유 `Intl.Collator` |
| P-9 | `web/src/components/STable.jsx` | 정렬이 켜지면 **매 렌더** 전량 재정렬(15초 폴링마다) | 위와 동일 | `useMemo` — **조기 return 위**에 배치(React #310 규칙) |
| P-10 | `server/src/index.js` + `storage/push.js` · `pdu/push.js` | 중앙 push 가 gzip·청크 없이 **기본 1MB 한도**로 감. 스키마상 장비 35~50대면 413 이고 **413 은 재시도 대상이 아니라 그 법인 데이터가 조용히 전량 소실** | 스키마 역산(추정) | gzip 전송 + 두 엔드포인트를 `BIG_JSON` 으로 + 413 경고 로그 |
| P-11 | `server/src/util/snapCache.js` | `MAX_PER_NAME=12` < **운영 vCenter 28개** → 법인별 화면을 동시에 보면 LRU 스래싱(v2.447 이 고친 '히트율 0%' 재발) | 코드 | 기본값 32 |
| P-12 | `routes/api/reports.js` | `/tools/report/capacity`(DS N+1) · `/tools/report/unprotected`(2만 행 동기 조회)가 60초 폴링인데 memo 없음 | 코드 | memoJson(30초, scopeKey) |
| P-13 | `sanswitch/perfDb.js` | 트랜잭션 루프 안에서 포트마다 `prepare()` — 디렉터 1대가 512~768포트 | 코드 | init 에서 1회 준비 |

### 보안

| # | 심각도 | 파일 | 문제 | 조치 |
|---|--------|------|------|------|
| S-1 | **high** | `proxy/registry.js` + `proxy/dataplane.js` | `DP_ID_KEYS=['url']` 가 접속처를 다 덮지 못했다. 최종 URL 은 `url + basePath` **문자열 연결**이라 `basePath:'@attacker.example/v3'` 로 저장하면 `accessMoved` 가 거짓 → 저장 비밀번호 승계 + 호스트 치환(`new URL(...).host === 'attacker.example'` 실측). Basic 헤더로 Data Plane 비밀번호가 공격자에게 간다 | `DP_ID_KEYS=['url','basePath']` + `basePathIssue()` 형식 검증 |
| S-2 | **high(실질)** | `vcenter/registry.js` · `nsx/registry.js` · `idrac/registry.js` · `horizon/horizon.js` · `collector/registry.js` · `gpu/physicalRegistry.js` | v2.500 이 '추정' 으로 남긴 나머지 스토어 6종이 **접속처가 바뀌어도 저장 비밀을 승계**한다(코드로 확인). `{host:'https://vc.attacker.example', password:''}` 저장 1회로 다음 수집에서 운영 계정이 평문 전송 | 공용 `util/secretCarry.js` 적용 + `droppedSecrets` 반환 |
| S-3 | medium | `proxy/registry.js getConfigSafe()` | `{...c}` 스프레드가 **최상위만** 가려 `c.proxies[].dataplane.password`·`deploy.privateKey` 가 평문으로 응답에 실렸다(v2.500 D/M1 과 같은 원인) | `proxies.map(normalizeProxy).map(redactProxy)` |
| S-4 | medium | `security/loginRateLimit.js` + `routes/auth.js` | v2.500 이 추가한 계정 무관 `ip:` 카운터가 ① `req.socket.remoteAddress` 고정이라 **리버스 프록시 뒤에서 전 사용자가 한 키를 공유**하고 ② 잠기면 `checkLoginAllowed` 가 시도를 막아 "정상 로그인 1회가 리셋" 이 **발동할 수 없다**(자기지속) → 48회 실패로 15분 전체 로그인 마비 | 출발지를 `clientIp(req)`(trust proxy 규약)로, 이 레이어만 잠금 60초로 분리 |
| S-5 | low | `guestdisk/db.js` | DB 파일 `chmod 0600` 누락(v2.447 에서 12개 모듈에 일괄 적용됐는데 v2.459 신규 파일만 빠짐) | 1줄 추가 |

회귀 테스트: `server/test/audit2503.test.js`(16건) + `server/test/perfMonitor2498.test.js` 버킷 해상도 2건.

---

## 2. 측정이 직관을 뒤집은 사례 (기록해 둘 것)

- **`/tools/capacity-forecast` 의 N+1 을 '전 키 1쿼리 병합' 으로 고치면 더 느리다.**
  정적 분석 결과 두 건(P2·P3)이 모두 `metrics/db.js historyAll()` 형태로의 통합을 권했지만,
  실제로 만들어 재니 **1,563ms → 3,586ms 로 2.3배 악화**했다. `samples_hourly` PK 가 `(metric,k,h)` 라
  키별 조회는 인덱스 선탐색이 되지만 `WHERE metric=? AND h>=? GROUP BY k,b` 는 metric 파티션 전체를
  훑고 temp b-tree 로 정렬하기 때문이다. 그래서 memo + 양보를 택했다. 코드 주석에도 남겼다.
- **`/tools/ipam` 이 34ms 라 느려 보였지만 서버는 빠르다.** 인프로세스 측정에서 `buildIpamRows` 0.0ms,
  `rows.map` 0.2ms, `JSON.stringify` 5.1ms 였다. 34ms 는 1.5MB 응답의 **클라이언트 수신·파싱까지** 포함한
  값이었다. 처음에 "캐시가 없어서 느리다" 고 본 내 가설은 틀렸다.
- **정적 분석이 지목한 `idrac/poller.js` 의 O(N²)** 는 965대 실측 **0.24ms** 로 문제가 아니었다.

## 3. 확인했으나 조치하지 않은 것 (근거 있음)

- `ipam.db` 의 PRAGMA 예외(WAL 미적용)는 **의도된 규약**이다(외부 프로그램이 직접 읽는 공유 파일).
- 웹 번들 500KB 초과 청크 3개(3d-force-graph 1.29MB·한글 PDF 폰트 567KB·Settings 555KB)는 **전부 lazy** 라
  초기 로딩에 실리지 않는다. 초기 로드는 394KB raw / **121KB gzip**.
- `columns` 배열 미메모이제이션(54곳)은 1,100행에 0.34~1.03ms 로 실익이 없어 건드리지 않았다.
- SSH 호스트키 미검증·DNS 리바인딩 TOCTOU 5곳·`/llm-test` SSRF·조회 권한 서버 미집행·`toolsDenied`
  41개 미매핑·CSP 기본 비활성 등 **직전 감사의 미해결 8건은 여전히 유효**하다(아래 4절).

## 4. 남은 미해결 항목 (정직 기록)

> **2026-09-13 추가(v2.506)**: 아래 표 중 3건을 닫았다 — 조회 권한 서버 미집행(svcmon) ·
> DNS 리바인딩 TOCTOU · `toolsDenied` 미매핑. 해당 행에 ✅ 를 달고 조치 내용을 적었다.
> 조치 상세는 `server/CLAUDE.md` 의 'v2.506' 절, 회귀 테스트는 `server/test/audit2506.test.js`.
>
> 그 과정에서 이 문서의 서술 두 가지가 부정확했음을 확인했다(정정):
> · "DNS 리바인딩 TOCTOU **5곳**" → 실제 **7곳**이었다. `horizon.js` 의 폴러 경로
>   (`fetchHorizonLicenses`)는 실행 시점 가드가 **아예 없었고**, `relayProbe.js` 는 접속부가
>   4개(net/tls/https/http)로 단일 지점이 아니었다.
> · "`toolsDenied` **41개** 미매핑" → UI 키와 경로 키를 비교한 수치였다. 실제로는 다수가
>   `/api/tools/*` 를 쓰지 않아 그 게이트의 **구조적 범위 밖**이었고(각자 `requirePerm`/`adminOnly`
>   로 보호됨), 같은 경로를 공유해 분리 집행이 불가능한 것도 있었다. 지금은 집행 49 + 부분 1 +
>   사유 선언 29 = 79 로 **미지 0** 이다.


| 항목 | 위치 | 왜 남겼나 |
|------|------|-----------|
| SSH 호스트키 미검증 | `proxy/sshExec.js` | `hostVerifier` 도입은 전 엣지의 known_hosts 배포 설계가 선행돼야 한다 |
| ✅ **해결(v2.506)** DNS 리바인딩 TOCTOU | 위 4파일 + `util/resilientFetch.js` · `routes/admin/collectorsDc.js` | 연결 시점 `lookup` 훅(`util/ssrfLookup.js`)으로 7개 지점 일괄. 실제로는 5곳이 아니라 7곳이었다(본문 정정 참조) |
| `/llm-test`·`PUT /llm-config` URL 무검증 | `routes/admin/deployLlm.js` | adminOnly 이지만 SSRF 가드는 붙여야 한다 |
| ✅ **해결(v2.506)** 조회 권한 서버 미집행 | `index.js` · `auth/permissions.js` | `/api/svcmon` 에 `requirePerm('svcmon')` + 새 권한 키(operator 기본, viewer 제외) + 구버전 파일 가산 마이그레이션. `dashboard`·`inv.*` 자체의 전역 집행은 여전히 미해결 |
| ✅ **해결(v2.506)** `toolsDenied` 미매핑 | `auth/toolAccess.js` | 두 세그먼트 매칭 + 미스매핑 1건 수정 + 전용 매핑 3건 → 집행 37→49개. 못 막는 것은 사유 선언(미지 0, 테스트로 고정) |
| 상태변경 IPAM/`upgrade-tools`/`reconfig` 에 `requireRole` 없음 | `routes/api/ipamExport.js` 외 | `tools` 권한을 viewer 에 주면 쓰기가 열린다(권한 부여가 선행돼야 성립) |
| 중앙 push 수신부 동기 `atomicWriteFileSync` | `central/storageEdge.js` 외 | 비동기 write→rename(`central/inventory.js` 패턴) 이식 필요 |
| 잡 폴러 5종이 중앙↔엣지 요청의 88% | `pingWorker` 외 | RMA 롱폴 패턴으로 통합해야 하며 범위가 크다 |
| vCenter 수집 타임아웃이 세션을 안 끊음 | `store.js` + `vcenter/soapClient.js` | `VimSoapClient` 에 signal 인자가 없다 — v2.417 패턴 이식 필요 |

## 5. 재현용 스크립트

감사 중 만든 벤치·EQP 스크립트는 저장소에 커밋하지 않았다(일회성). 재현이 필요하면 이 문서의
'근거' 열에 적힌 조건(행 수·스키마)으로 다시 만들면 된다.
