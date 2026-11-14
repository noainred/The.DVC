# 공통 기능 목록 (자동 생성)

솔루션 전체가 함께 쓰는 공용 모듈 **154개**를 코드에서 뽑은 목록이다. 새 헬퍼·컴포넌트를 만들기 전에 여기서 먼저 찾는다
(같은 판정을 복제하지 말 것 — 루트 `CLAUDE.md` '판정 코어는 하나').

- 생성: `node scripts/common-doc.mjs` · 최신 여부: `node scripts/common-doc.mjs --check`
- **이 파일을 직접 고치지 말 것** — 코드가 진실의 원천이며 다음 실행에서 덮어써진다. 설명을 고치려면 그 모듈의 **머리 주석 첫 단락**을 고친다.
- 훑은 소스 4093개 파일(`server/src` · `server/test` · `web/src` · `scripts`). `pyportal/`(Python)은 대상이 아니다.

## 읽는 법 · 한계

- **하는 일**: 그 파일 맨 앞 주석의 첫 단락(150자에서 자름). 머리 주석이 없는 모듈은 6개다.
- **사용처**: 그 모듈을 import 하는 파일 수(테스트 제외). **영역**: 사용처가 속한 폴더 수(서버 `server/src/<영역>` · 웹 `web/src/<영역>`, `views/tools` 는 따로).
- **테스트**: 그 모듈의 경로를 **import 하거나 문자열로 가리키는**(소스 스윕) 테스트 파일 수. 경로를 조각으로 조합하면(`path.join(SRC, 'util', 'x.js')`) 세지 못하므로 0 이 '검증 없음' 을 뜻하지는 않는다(0 인 모듈 20개).
- 사용처로 세는 것은 정적 import · 재수출 · 문자열 리터럴 동적 import 다. 경로를 런타임에 조합하는 동적 import 는 세지 못했다 — 8건 · 파일 8개(`server/src/edgelog/collect.js` · `server/src/linkcheck/settingsLinks.js` · `server/src/portalcheck/archScan.js` · `server/src/routes/api/bmFolders.js` · `server/src/routes/api/partFaults.js` · `server/src/routes/central/storageRoutes.js` · `server/src/routes/central.js` · `scripts/tools-catalog.mjs`).
- 사용처 수는 '얼마나 널리 쓰이는가' 이지 품질 지표가 아니다.

## 요약

| 구분 | 위치 | 모듈 | 사용처 0 | 테스트 0 |
|---|---|---|---|---|
| 서버 공용 유틸 | `server/src/util/` | 88 | 1 | 8 |
| 웹 공용 컴포넌트 | `web/src/components/` | 45 | 1 | 9 |
| 웹 공용 훅 | `web/src/hooks/` | 7 | 0 | 2 |
| 웹 공용 유틸 | `web/src/util/` | 2 | 0 | 0 |
| 웹 최상위 공용 모듈 | `web/src/` | 12 | 0 | 1 |
| **합계** | | **154** | **2** | **20** |

## 서버 공용 유틸 — `server/src/util/` (88)

사용처가 많은 순.

| 모듈 | 하는 일 | 내보내는 이름 | 사용처 | 영역 | 테스트 |
|---|---|---|---|---|---|
| `numOrNull.js` | `numOrNull` — '읽지 못한 수치' 를 0 으로 둔갑시키지 않는 단일 판정 (v2.561). | `numOrNull` `default` | 284 | 60 | 7 |
| `atomicWrite.js` | 원자적 파일 쓰기 — 임시파일에 기록 후 rename으로 교체한다. writeFileSync는 기록 도중 크래시/정전 시 파일을 truncate/부분기록 상태로 남겨, 다음 로드에서 JSON 파싱 실패 → 빈 값 반환 → 다음 저장이 손상본을 덮어쓰며 데이터가 영구 유… | `atomicWriteFileSync` `classifyLoadReason` `loadReasonWhere` `summarizeLoadReason` `safeLoadText` `preserveCorrupt` 외 1 | 249 | 72 | 8 |
| `dayKey.js` | 날짜 경계 코어 — 하나다(v2.582 ARCH-2). | `resolveDayOffsetMin` `toMs` `dayKey` `todayStamp` `dayIndex` `dayStartMs` 외 9 | 134 | 34 | 32 |
| `capStr.js` | 외부 문자열을 **상주 구조**(Map 키·보관 레코드)에 넣을 때의 길이 상한(v2.606 감사 TIM2606-02). | `flatStr` `capStr` `capTrim` | 103 | 23 | 2 |
| `resilientFetch.js` | 크로스-WAN(중앙↔수집서버/에이전트) 호출용 견고한 fetch. | `loadWanCa` `wanTlsConnectOptions` `wanTlsStatus` `dispatcherFor` `abortableSleep` `headersWithoutSecrets` 외 9 | 77 | 24 | 14 |
| `csv.js` | RFC 4180 CSV 토크나이저 — 따옴표("...")로 감싼 필드 안의 쉼표·줄바꿈·이스케이프된 따옴표("")를 온전히 처리한다. 순진한 line.split(',')은 비밀번호에 쉼표(p@ss,w0rd)나 줄바꿈이 있으면 필드를 잘라 잘못된 자격증명을 저장했다(특수… | `parseCsvRows` `guardCell` `unguardCell` `delimiterHint` `csvCell` `csvLine` 외 1 | 65 | 21 | 22 |
| `pool.js` | 동시성 제한 실행 풀 — **단일 소스**(v2.575 IMP-08). | `poolSettled` `poolRun` `default` | 63 | 34 | 2 |
| `registryCore.js` | 장비 등록부(storage·sanswitch·pdu·cvp·bmstor)의 **공용 판정**(v2.613 PERSIST2613-04 · DEPS2613-04). | `corruptOnlyReason` `makeLoadError` `autoWriteRefusal` `manualRemoteWriteRefusal` `summarizeRegistryError` `pullRecoveryNote` 외 5 | 58 | 22 | 6 |
| `timeSlice.js` | 시간 기준 양보(v2.672). | `createYielder` | 52 | 26 | 3 |
| `logThrottle.js` | '같은 내용이면 가끔만' 찍는 로그 조절기(v2.583, 순수). | `createChangeLogger` | 51 | 14 | 1 |
| `stateFiles.js` | '이 파일은 설정이 아니라 **상태·캐시** 다' 를 파일이 스스로 선언하는 등록부(v2.613 PERSIST2613-01·08). | `registerStateFile` `isRegisteredStateFile` `registeredStateFiles` | 49 | 23 | 7 |
| `readCapped.js` | 응답 본문을 **상한까지만** 읽어 JSON 으로(v2.583 — 감사 확정). | `readJsonCapped` `readTextCapped` `EDGE_EXPORT_MAX_BYTES` `EDGE_RESPONSE_MAX_BYTES` | 40 | 17 | 1 |
| `sqliteOpen.js` | SQLite 첫 open 공용 규칙(v2.599 감사 DB2599-02 후속). | `isSqliteLockError` `applyStdPragmas` `createLockRetry` `chmodDbFiles` `openSqlite` `withOpenCleanup` 외 1 | 37 | 29 | 4 |
| `ipv4.js` | IPv4 점표기 ↔ uint32 의 **단일 소스**(v2.586). | `ipToNum` `numToIp` `strictIpv4Num` `cidrMatch` `canonIp` `isIpv4` | 34 | 13 | 6 |
| `authGuard.js` | 인증 실패(401/403) 대상의 **주기 수집 정지** 공용 코어(v2.535). | `isPeerRejectText` `isAuthFailureText` `credHashOf` `createAuthGuard` `createAuthBreaker` `runWithBreakerWarmup` 외 2 | 33 | 27 | 11 |
| `adaptiveTimer.js` | 주기를 스스로 다시 잡는 타이머(v2.409 에서 storage/intervals.js 로 도입, v2.410 에서 공용 유틸로 분리 — SAN 스위치 폴러도 같은 규칙을 쓴다). | `startAdaptiveTimer` | 32 | 17 | 7 |
| `chunkedPrune.js` | 대량 시계열 DELETE 를 청크로 끊어 이벤트 루프를 막지 않는다 (v2.453). | `shouldContinuePrune` `nextAdaptiveChunk` `chunkedDelete` `createPruneFlight` `PRUNE_CHUNK_ROWS` `PRUNE_MAX_ROWS` | 31 | 24 | 4 |
| `exitFlush.js` | 종료 시 flush 레지스트리(v2.582 ARCH-4) — 하나다. | `registerExitFlush` `runExitFlush` `exitFlushNames` `_resetExitFlushForTest` | 29 | 15 | 9 |
| `pushAll.js` | 큰 배열 붙이기(v2.603 감사 CEN2603-03 후속). | `pushAll` | 29 | 16 | 1 |
| `coercionTrap.js` | 요청 값을 글자·수로 바꿀 때 던지지 않게 하는 공용 규칙(v2.603 감사 CEN2603-05). | `stripCoercionTraps` `strOf` | 28 | 7 | 1 |
| `settingsLoadError.js` | **중앙 설정 파일**의 로드 오류 상태(v2.631 EDGE2631-01). | `makeSettingsLoadError` `listSettingsLoadErrors` `confirmSettingsDefault` | 26 | 16 | 6 |
| `secretCarry.js` | "접속 대상이 바뀌면 저장 비밀을 승계하지 않는다" — 공용 판정(v2.500). | `accessMoved` `dropCarriedSecrets` `secretProvided` | 24 | 19 | 2 |
| `ssrfLookup.js` | **DNS 리바인딩(TOCTOU) 차단용 공용 lookup 훅**(v2.506). | `filterAddresses` `addressBlockReason` `ssrfLookupError` `makeSsrfLookup` `pinnedLookup` `ssrfLookup` 외 1 | 24 | 17 | 2 |
| `agentNameHeader.js` | 엣지 → 중앙 push 에 `X-Agent-Name` 헤더를 싣는다(v2.620 RECENT2620-02). | `agentNameHeader` | 20 | 9 | 1 |
| `deadline.js` | 작업 시한 — **단일 관문**(v2.607 감사 TIM2607-02 · LEFT2607-08). | `deadlineMs` `withDeadline` `DEADLINE_MIN_MS` `DEADLINE_MAX_MS` `DEADLINE_LONG_MAX_MS` `DEADLINE_DEFAULT_MS` | 20 | 12 | 3 |
| `outboundStats.js` | 이 노드가 **다른 포탈로 나가는** 호출의 기록(v2.587, 데이터 흐름 지도). | `isTrackedPath` `withOutboundTag` `recordOutbound` `outboundStats` `resetOutboundStats` | 16 | 11 | 7 |
| `ssrfBlock.js` | SSRF 차단 판정 — IP 리터럴·URL·DNS 해석 결과의 차단 대역 검사(v2.579 에 `collector/registry.js` 에서 분리). | `ipBlockReason` `ssrfBlockReason` `ssrfBlockReasonResolved` | 16 | 10 | 2 |
| `cmpVersion.js` | semver 형태 버전 비교 — **단일 소스**(v2.575 IMP-04). | `cmpVersion` `default` | 15 | 7 | 2 |
| `exportBusy.js` | 무거운 내보내기의 **동시 실행 1건 가드** — 단일 소스(v2.575). | `acquireExport` `_resetExportBusy` `exportBusyOf` | 15 | 1 | 12 |
| `asyncRoute.js` | `asyncRoute` / `wrapAsyncRouter` — express 4 에서 **async 핸들러의 throw 를 전역 에러 핸들러로 보낸다**. (v2.574, 2026-09-21 감사 BUG-01·BUG-02·BUG-03) | `asyncRoute` `wrapAsyncRouter` | 14 | 1 | 5 |
| `errors.js` | Turn a thrown error (often a generic "fetch failed") into a human-readable reason plus a Korean hint about the likely cause, for vCenter connection di… | `describeError` | 14 | 9 | 4 |
| `pageArgs.js` | 페이징 인자 정규화(v2.594, 감사 SEC-2594-01~03). | `pageArgs` | 14 | 5 | 1 |
| `clampSetting.js` | 숫자 설정 정규화(v2.595, 감사 DEPS2595-01 — 재현). | `clampSetting` | 12 | 12 | 2 |
| `rateLimit.js` | 경량 인메모리 레이트 리밋 — 외부 의존성 없이 폭주/DoS·버그 클라이언트를 막는다. 키별(기본 클라이언트 IP) 고정 윈도우 카운터. 정상 폴링(사용자당 분당 수십 요청)은 넉넉히 통과하되, 한 IP가 비정상적으로 많은 요청을 보내면 429 + Retry-After… | `clientIp` `rateLimit` | 12 | 3 | 2 |
| `snapCache.js` | 스냅샷 리비전 키 기반 메모이저 — 무거운 폴링 엔드포인트(전력 대시보드·인사이트·전력분해 등)가 같은 스냅샷에 대해 매 요청 재계산하는 것을 막는다. 동일 key의 '동시' 요청은 하나의 계산에 합류(single-flight)시켜, N명이 동시에 같은 화면을 폴링해도… | `_snapCacheStats` `snapMemo` `snapCacheSweep` `snapCacheClear` `weakEtag` `sendCached` 외 2 | 12 | 3 | 6 |
| `clampEdgeTs.js` | 엣지가 보낸 시각을 **수신 시각으로 자른다**(루트 CLAUDE.md ‘엣지 시각은 수신 시각으로 자르고 원본은 따로’ · v2.682 R3S-01). 본체는 원래 `routes/api/corpUsage.js` 에 있었다 — v2.919 에 중앙 정제(central/… | `clampEdgeTs` | 11 | 2 | 0 |
| `noRedirect.js` | v2.620(SEC2620-01) — 자격증명을 싣는 장비 요청은 리다이렉트를 따라가지 않는다. 전역 fetch 의 기본값 redirect:'follow' 는 307/308 에 로그인 본문·커스텀 세션 헤더(vmware-api-session-id· EMC-CSRF-TO… | `refuseRedirect` `NO_REDIRECT` | 11 | 7 | 1 |
| `bulkImport.js` | 대량 가져오기 **드라이런 판정**의 공용 코어(순수, v2.513). | `analyzeBulkImport` `enrichAdvice` `selectRows` | 10 | 6 | 1 |
| `trimSlashes.js` | 끝 '/' 제거 — 선형(v2.611 LEFT2611-06 로 단일 소스화). | `trimTrailingSlashes` `COLLECTOR_URL_MAX` | 10 | 10 | 1 |
| `envTimeout.js` | 엣지 워커의 요청 시한 env 정규화(v2.600 감사 추가 배정 · v2.613 DEPS2613-01 에 agent/ → util/ 로 이동, 옛 경로는 재수출). | `reqTimeoutMs` | 9 | 7 | 1 |
| `agentKey.js` | 엣지(agent) 이름으로 저장된 맵을 조회할 때 쓰는 공용 규칙(v2.597, 감사 L2597-03 — 재현). | `agentKeyOf` `agentValueOf` `canonicalAgent` | 8 | 4 | 1 |
| `centralReply.js` | 엣지 push 가 중앙 응답의 '일부만 받음' 요약을 읽는 공용 헬퍼(v2.606 EDGE2606-03). | `readCentralReply` `dropSummaryOf` `dropText` `mergeDrop` `warnDrop` | 8 | 4 | 3 |
| `postNo503Retry.js` | 엣지가 중앙으로 **큰 본문**을 올릴 때 503 은 호출 안에서 다시 보내지 않는 전송 헬퍼. | `postNo503Retry` `fetchNo503Retry` | 8 | 7 | 3 |
| `tokenFingerprint.js` | 토큰 '지문'(v2.560, 순수 모듈). | `tokenFingerprint` `tokenFingerprintParts` `sameToken` `tokenGroupKey` | 8 | 6 | 4 |
| `xlsxWorkerRun.js` | 엑셀 조립·직렬화를 워커 스레드에서 돌리는 실행기(v2.799, 공용). | `runXlsxWorker` `serveXlsxWorker` | 8 | 3 | 0 |
| `httpsServer.js` | 포탈이 **직접 TLS 로** 받을 수 있게 하는 리스너(2026-10-09 검토 S-09, 그룹 J). | `tlsListenConfig` `loadTlsMaterial` `tlsListenerStatus` `advertisedListen` `listeningPortalPorts` `_resetHttpsServerState` 외 1 | 7 | 5 | 2 |
| `ping.js` | ICMP ping 유틸 — OS의 ping CLI를 호출해 도달성/RTT를 반환한다(raw 소켓 불필요). Linux/Windows 모두 지원. 모든 실패는 격리되어 { alive:false }로 떨어진다. | `pingProbeMode` `pingProbeStats` `parsePingOutput` `pingOne` `tcpConnect` `tcpProbeMany` 외 1 | 7 | 5 | 2 |
| `readPrefix.js` | 응답 본문을 **앞부분만** 읽는다(v2.603 감사 SEC2603-03). | `readBodyPrefix` | 7 | 7 | 0 |
| `scanJournal.js` | 실행 중 스캔 기록 + 재시작 뒤 자동 재개(v2.737). | `resumeDelayMs` `scanStarted` `scanProgress` `scanFinished` `scanQueued` `scanQueuedMany` 외 21 | 7 | 7 | 9 |
| `activityLog.js` | 수집 '작업 로그' 링버퍼 **공용 팩토리**(v2.516). | `createActivityLog` | 6 | 5 | 4 |
| `bulkText.js` | 대량 등록용 **자유텍스트** 파싱/직렬화(순수, v2.513). | `splitCells` `splitCellsRaw` `splitLine` `parseKeyed` `parseFreeRows` `rowsToFreeText` 외 3 | 6 | 6 | 3 |
| `central404.js` | 엣지 설정 pull 의 404 판정(v2.600 감사 EDGE2600-06 · v2.613 DEPS2613-01 에 agent/ → util/ 로 이동, 옛 경로는 재수출). | `classifyCentral404` `classifyCentral404Body` | 6 | 2 | 1 |
| `collectRequestQueue.js` | 엣지 위임 '지금 수집' 요청 큐의 공용 코어(v2.590 P16 · v2.591 재설계). | `createCollectRequestQueue` `SEEN_MAX` | 6 | 5 | 7 |
| `bulkRun.js` | 대량 가져오기의 **실제 연결 테스트** 실행/진행률 보관(v2.513). | `startBulkTest` `publicRun` `passedLines` `isBusy` `_resetForTest` | 5 | 1 | 5 |
| `hostPort.js` | 등록 주소(`https://host:port/…`)에서 접속용 host·port 를 뽑는 공용 파서(v2.603 LEFT2603-02). | `splitHostPort` `haproxyAddress` | 5 | 4 | 1 |
| `regions.js` | 지역(region) 목록 — **단일 소스**(v2.575 IMP-10). | `REGIONS` `default` | 5 | 4 | 1 |
| `smtp.js` | 의존성 없는 최소 SMTP 클라이언트 (v2.454). | `headerSafeText` `normalizeAddresses` `encodeHeaderWord` `formatDisplayName` `buildMime` `dotStuff` 외 8 | 5 | 4 | 6 |
| `waitDrain.js` | 쓰기 백프레셔 대기 공용(v2.783 점검 Q5 — O-B4 · 형제 스윕). | `waitDrain` | 5 | 2 | 1 |
| `credFingerprint.js` | 자격증명 '지문'(v2.528, 순수 모듈). | `credFingerprint` `credFingerprintParts` | 4 | 4 | 1 |
| `xlsxSheetPrOrder.js` | exceljs 가 쓰는 시트 속성(`<sheetPr>`)의 하위 요소 순서를 OOXML 스키마 순서로 바로잡는다(v2.799.1). | `ensureSheetPrOrder` `sheetPrOrderState` | 4 | 4 | 1 |
| `envRedact.js` | `.env` 텍스트에서 **키·토큰·비밀번호 값만** 가리는 순수 모듈(v2.538). | `redactEnvSecrets` `mergeRedactedEnv` `pinHostSecurityEnv` `REDACTED` `isSecretEnvKey` `HOST_PINNED_ENV` | 3 | 3 | 3 |
| `licenseExpiry.js` | 라이선스 만료일 확인 공용 헬퍼 — 특수기능 '라이선스 만료일 확인'(/tools/license-expiry). 제품군 분류와 만료 상태(만료/임박/정상/영구) 계산을 순수 함수로 분리(테스트 대상). | `licenseFamilyOf` `licenseExpiryStatus` | 3 | 2 | 1 |
| `linreg.js` | 최소제곱 기울기(순수). v2.672 에 routes/api/shared.js 에서 옮겼다 — 도메인 모듈(tools/dsGrowth.js)이 routes/ 를 import 하지 않게(의존 방향은 한쪽 — arch2579). shared.js 는 같은 이름으로 다시 내… | `linregSlope` | 3 | 3 | 0 |
| `readBytesCapped.js` | 응답 본문을 **바이트 상한까지만** Buffer 로 읽는다(v2.607 감사 SEC2607-06). | `readBytesCapped` | 3 | 1 | 1 |
| `ruleName.js` | 규칙(이름 · 자동 규칙)이 보는 베어메탈 이름 — **가린 뒤 이름**(판정 코어 하나). · 이름 속 서비스 태그(TAG_MASK_MIN 자 이상)는 NUL 로 걷어 낸다(규칙 값에는 제어 문자가 들어갈 수 없다 — 걷어 낸 자리를 건너 맞지 않는다) · 관리 주소… | `lowSameLen` `ruleNameOf` `TAG_MASK_MIN` | 3 | 3 | 1 |
| `runtimeCheck.js` | Node 런타임 계약과 기동 시 호환성 자가 점검(검토 I-06). | `enginesRange` `parseNodeVersion` `judgeVersion` `selfCheckFetchDispatcher` `overallState` `runtimeStatus` 외 7 | 3 | 3 | 1 |
| `sameHostName.js` | 두 호스트 이름이 같은 장비를 가리키는가(v2.777 — 사용자 요청 '엣지에서 보고하는 호스트네임을 기록해서 검증'). 대소문자 무시 · 끝 점 무시 · 한쪽만 FQDN 이면 첫 마디(짧은 이름)로 비교한다(os.hostname() 이 배포판마다 짧은 이름·FQDN… | `sameHostName` | 3 | 3 | 1 |
| `secureCompare.js` | 공유 토큰/시크릿 비교를 상수시간(timing-safe)으로 수행한다. 일반 `===`는 첫 불일치 바이트에서 조기 반환해 응답시간 차이로 토큰을 한 바이트씩 복구당할 수 있다. 길이를 먼저 HMAC으로 정규화해 길이 자체도 누설하지 않는다. | `timingSafeEqualStr` `tokenMatches` | 3 | 1 | 2 |
| `xlsxInternalLink.js` | 같은 파일 안 시트로 가는 링크(`#'시트'!A1`)를 OOXML 규격 모양으로 쓴다(v2.802 — 호스트·클러스터 엑셀). | `ensureInternalLinks` `internalLinkState` `sheetLink` | 3 | 3 | 2 |
| `zip.js` | 단일 파일 ZIP 생성기 — 의존성 없이(zlib만) 한 파일을 deflate 압축한 .zip 버퍼를 만든다. 대용량 내보내기를 zip으로 압축해 전송할 때 사용(에어갭 Rocky9에서 외부 패키지 불필요). | `zipSingle` `zipMany` `zipManyAsync` `sendMaybeZip` `ZIP_THRESHOLD` | 3 | 2 | 4 |
| `bigJsonGate.js` | 대용량 JSON 파서를 **인증된 요청에만** 태우는 게이트(v2.538). | `bigJsonStats` `sessionBigBodyAllowed` `bigJsonGate` | 2 | 2 | 8 |
| `bulkAdvice.js` | 대량 가져오기 실패를 **'텍스트의 어디를 어떻게 고쳐라'** 로 바꾼다(순수, v2.513). | `fieldOfIssue` `specialAdvice` `expectationFor` `tokenPos` `adviseRow` `preflightHints` | 2 | 2 | 4 |
| `bundleSha.js` | 업그레이드 번들 바이트의 sha256(같은 Buffer 는 한 번만 계산). v2.901(점검 P2): 엣지 자동 업그레이드 동기화가 돌 때마다 번들(수십 MB)을 동기로 읽고, 서명 판정과 push 헤더에서 sha256 을 **두 번** 계산했다(WeakMap 캐시가… | `bundleSha` | 2 | 2 | 1 |
| `denyAuditGate.js` | 무인증 거부의 감사 로그 요약(v2.583 — 감사 확정 · 검증 에이전트 권고). | `createDenyAuditGate` `foldedNote` | 2 | 2 | 1 |
| `dirPathGuard.js` | 관리자가 입력하는 '저장 디렉터리 절대경로' 검사(v2.629 AUTHZ2629-02). | `dirPathIssue` `SYSTEM_DIR_RE` `WIN_ABS_RE` `WIN_SYSTEM_NAMES` `WIN_SYSTEM_DIR_RE` | 2 | 1 | 3 |
| `exportPrefs.js` | 내보내기 화면의 '내 저장값'(계정별 기본값 + 1~5칸) 저장소 공장(v2.799). | `createExportPrefs` `SLOT_COUNT` `MAX_USERS` `NAME_MAX` | 2 | 2 | 0 |
| `fsType.js` | 게스트 파티션의 파일 시스템 종류 이름(v2.798 — VM 목록 내보내기 '파일 시스템 종류'). GuestDiskInfo.filesystemType(vSphere 7.0 이상이 준다고 추정 — 실물 미확인)·엣지가 보낸 값 모두 이 형식만 받는다: 영숫자·. _ -… | `fsTypeOf` | 2 | 2 | 0 |
| `longTimer.js` | 긴 간격 타이머(v2.591 L2). | `every` `MAX_TIMER_MS` | 2 | 2 | 1 |
| `sshKeyStore.js` | 노드(중앙 · 엣지)가 스스로 만든 SSH 키로 비밀번호 없이 접속하기 위한 **키 파일 공장**(v2.976 — 집중 모니터링). | `publicKeyViewOf` `createSshKeyStore` `sshKeyDir` | 2 | 2 | 0 |
| `userDocWriter.js` | 사용자 데이터 JSON 파일 하나의 '디바운스 · 비동기 원자 쓰기 · 저장 확인 · 실패 재시도'(v2.881). | `createUserDocWriter` `WRITE_ERROR_TEXT` `RETRY_DEFAULTS` | 2 | 1 | 0 |
| `compress.js` | 경량 gzip 응답 압축 + ETag/304 미들웨어 — 외부 의존성 없이 Node 내장 zlib/crypto만 사용 (에어갭 배포 호환). res.json()을 감싸 큰 JSON 응답만 비동기 gzip한다(동기 gzipSync로 이벤트 루프를 막지 않음). res.s… | `compression` | 1 | 1 | 2 |
| `loopLag.js` | 이벤트 루프 지연(lag) 모니터 — 대용량 동기 작업(수집 SOAP 파싱·집계·bulk write)이 메인 루프를 얼마나 오래 막는지 계측한다. docs/ARCH-HEAVY-JOB-ISOLATION.md §10-0 '계측 먼저'의 구현 — 실제 병목(수집 재구성 vs… | `startLoopLagMonitor` | 1 | 1 | 1 |
| `queryNormalize.js` | 쿼리스트링 정규화 — **`req.query` 의 모든 값은 문자열이다**(v2.575 BUG-22). | `normalizeQuery` `queryNormalizer` `default` | 1 | 1 | 5 |
| `releaseFile.js` | RedHat 계열의 /etc/redhat-release 처럼, CONFIG_DIR에 현재 포탈 버전을 한 줄로 명시하는 릴리스 파일(CONFIG_DIR/vmware-portal-release)을 기록한다. | `writeReleaseFile` `RELEASE_FILE` | 1 | 1 | 1 |
| `soapParsePool.js` | SOAP 파싱 워커 풀 — RetrieveProperties 응답의 CPU 바운드 정규식 파싱을 worker_threads로 오프로딩해 메인 이벤트 루프 블로킹을 없앤다(28+ vCenter·고RTT 환경에서 매 주기 파싱이 메인 스레드를 점유하면 HTTP 응답/다른… | `parseObjectContentAsync` `shutdownParsePool` `_poolInfo` | 1 | 1 | 2 |
| `staticGzip.js` | 빌드 자산(해시 이름·불변)의 gzip 전송(v2.596, 감사 PERFWEB-02 — 실측). | `acceptsGzip` `createStaticGzip` `STATIC_GZIP_MAX_BYTES` | 1 | 1 | 2 |
| `xlsxChart.js` | exceljs 가 만든 .xlsx 에 **꺾은선 차트**를 넣는다(v2.661 — iDRAC 통합 추이 엑셀 내보내기). | `colLetter` `chartXml` `addLineCharts` `sheetRef` `PRST_DASH` | 1 | 1 | 1 |
| `parseWorker.js` | worker_threads 워커 — RetrieveProperties 응답 XML의 정규식 파싱(CPU 바운드)을 메인 이벤트 루프 밖에서 수행한다. 28개 vCenter를 매 주기 수집할 때 수 MB XML을 메인 스레드에서 파싱하면 그동안 HTTP 응답/다른 vCe… | (없음) | 0 | 0 | 1 |

## 웹 공용 컴포넌트 — `web/src/components/` (45)

사용처가 많은 순.

| 모듈 | 하는 일 | 내보내는 이름 | 사용처 | 영역 | 테스트 |
|---|---|---|---|---|---|
| `STable.jsx` | STable — `<table>` 대체 컴포넌트(v2.422, 사용자 요구 '데이터 조회 화면의 모든 표는 제목 클릭 정렬, 기억해줘'). | `STable` `default` | 301 | 15 | 5 |
| `ui.jsx` | 공용 UI 재수출 셸(v2.295 대형 파일 분할 · 모듈화 감사 2차 확정 #2·#7). 구 633줄 구현은 3개 파일로 이동했고 이 파일은 **순수 재수출만** 한다 — views/ 의 86개 소비자 import 경로가 바뀌지 않도록(SpecialTools v2.2… | `GpuBadge` `usageColor` `Kpi` `UsageCell` `StateBadge` `SeverityBadge` 외 10 | 286 | 11 | 5 |
| `Select.jsx` | 공용 드롭다운(v2.708) — 날 `<select>` 대신 이것을 쓴다(테스트가 날 select 를 금지한다). 기본으로 선택지를 보이는 글자 순으로 정렬하고 '전체·선택…' 같은 고정 선택지는 맨 위에 둔다(selectSort.js). 기간·심각도·권장 먼저처럼 *… | `default` | 194 | 11 | 2 |
| `boldText.jsx` | 서버가 만든 안내 문구의 `**강조**` 를 안전하게 굵게 렌더한다(v2.440). | `boldParts` `default` | 116 | 5 | 5 |
| `EscClose.jsx` | (머리 주석 없음) | `default` | 30 | 9 | 0 |
| `primitives.jsx` | ui.jsx(구 633줄)에서 분리(v2.295 모듈화 감사 2차 확정 #2·#7). 본문은 원본 10~162·608~633행 그대로 이동(기능 변화 없음). | `GpuBadge` `usageColor` `Kpi` `UsageCell` `StateBadge` `SeverityBadge` 외 5 | 21 | 8 | 5 |
| `Modal.jsx` | ui.jsx(구 633줄)에서 분리(v2.295). 본문은 원본 164~190행 그대로. 단독 분리 이유: VmRemote/VmReconfig(EntityDetail 이 import)가 Modal 하나 때문에 ui.jsx 를 역참조하는 순환이 있었다(함수 선언 호이스팅… | `Modal` | 19 | 3 | 0 |
| `EntityDetail.jsx` | ui.jsx(구 633줄)에서 분리(v2.295). 본문은 원본 192~606행 그대로 이동. | `DRow` `VmIpPing` `HostVmsModal` `VmPartitionsSection` `VmCfgSection` `PerfcSection` 외 10 | 16 | 6 | 8 |
| `DataList.jsx` | 공용 자동완성 목록(v2.708) — 날 `<datalist>` 대신 이것을 쓴다. 제안 목록을 글자 순으로 정렬한다(selectSort.js 와 같은 규칙). | `default` | 12 | 4 | 1 |
| `vmperf/vmPerfText.js` | VM · ESXi 호스트 성능 화면(v2.911 · 시안 docs/design/vm-perf ②~④)의 **순수** 보조(vitest 고정). 기간 · 지표 상수 · 값 글자 · 구간 통계 · 과거 창 계산(◀ 이전 · 슬라이더 · 날짜로 이동) · 차트 좌표 · CS… | `chartKeys` `fmtRate` `fmtVal` `rollupLabel` `fmtClock` `fmtHm` 외 24 | 12 | 2 | 2 |
| `accessDeniedText.js` | 권한 거부(403) 안내 문구 생성 — 순수 함수만 둔다(AccessDenied.jsx 가 렌더). | `describePermission` `deniedRoleLabel` `deniedSubText` `buildRequestText` `errorBoxInput` `PERM_LABEL` 외 5 | 9 | 4 | 5 |
| `VmMetrics.jsx` | '📈 성능 그래프 보기' 단추(VM · ESXi 호스트). v2.911(시안 docs/design/vm-perf ② · 사용자 컨펌 '개선'): 예전에는 여기의 MetricModal(900px 모달 · recharts · 지표마다 vCenter 로그인)을 띄웠다. 이제… | `VmMetricButton` `HostMetricButton` | 5 | 4 | 1 |
| `VmRemote.jsx` | (머리 주석 없음) | `VmRemoteButton` | 5 | 4 | 2 |
| `IpmsMatches.jsx` | (머리 주석 없음) | `IPMS_DENIED_TEXT` `default` | 4 | 1 | 4 |
| `CsvBulkModals.jsx` | CSV 일괄 관리 공용 모달(v2.339) — 내보내기(비밀 포함 선택)·가져오기(검증 드라이런 → 덮어쓰기 확인 → 실행). 수집 서버 CSV(v2.338, Collectors.jsx)에서 자리잡은 UX 를 화면마다 복제하지 않게 엔드포인트/컬럼만 주입받는 형태로 일… | `CsvExportModal` `CsvImportModal` | 3 | 3 | 1 |
| `ErrorBoundary.jsx` | Catches render/runtime errors in its subtree so a single broken component never blanks the whole portal. Shows a small fallback (or a custom one). | `default` | 3 | 2 | 2 |
| `VmConsole.jsx` | VM remote-console launcher (원격 콘솔), mirroring the vSphere Client: - LAUNCH REMOTE CONSOLE → VMRC desktop app (vmrc:// URL) - LAUNCH WEB CONSOLE → HTML… | `VmConsoleButton` | 3 | 3 | 0 |
| `VmReconfig.jsx` | VM 사양 변경 버튼/모달 — vCPU·RAM 증설, 디스크 증설/추가, NIC 추가/삭제. 접근 권한은 기능 권한 'vm.reconfig'로 통제(기본 admin 전용, 권한 매트릭스에서 부여 가능). 안전: 증설만(감소·축소 차단은 서버에서도 강제), 변경 전 확인… | `VmReconfigButton` | 3 | 3 | 1 |
| `cpuModelText.js` | CPU 모델명 표시 문구(순수, v2.556). | `cpuModelText` `cpuModelCell` | 3 | 3 | 1 |
| `mentionText.js` | 댓글 @멘션 자동완성의 순수 판정(v2.907 · 시안 docs/design/wiki-mention ①②). | `mentionQueryAt` `mentionText` `applyMention` `mentionsInText` `MENTION_TOKEN_MAX` | 3 | 3 | 1 |
| `taskLabel.js` | 요청 경로 → **사람이 읽는 작업 이름**(v2.501) — 순수 함수. | `taskLabel` `secText` `taskRows` `visibleProgress` | 3 | 2 | 3 |
| `ExportPreviewModal.jsx` | 내보내기 미리보기 '크게 보기'(전체 화면 팝업, v2.801 — 승인 시안 ⑤ https://claude.ai/artifact/5PT9nUWUwMPTxwURq3xm1h). 사용자 요청(2026-10-27): "지금 미리보기 화면이 작은데, 미리보기를 전체화면으로 팝업… | `default` | 2 | 2 | 0 |
| `HostGpuPanel.jsx` | v2.650: 호스트 상세의 GPU 칸 — 사용률·온도·GPU 메모리 할당/사용·VM 별 동작(사용자 요청 "GPU 있는 서버는 GPU 사용율, GPU 온도, GPU 메모리 할당/사용율 붙여줘"). 서버 GET /tools/gpu/host(스냅샷·오버레이만 — 왕복 0… | `default` | 2 | 2 | 1 |
| `HostPowerPanel.jsx` | (머리 주석 없음) | `default` | 2 | 2 | 0 |
| `IdracTrendLinkButton.jsx` | 호스트 상세 '통합 성능 모니터링'(v2.676, 사용자 요청 "성능 그래프 보기 옆에 통합 성능 모니터링 메뉴 · hostname, TAG 넘버, IP 등으로 복합 조회해서 확실하게 연결"). 누르면 서버에 그 ESXi 호스트의 iDRAC 서버를 묻고 (`GET /a`… | `default` | 2 | 2 | 1 |
| `MentionBox.jsx` | MentionBox — '@' 자동완성이 붙은 글상자(v2.907 · 시안 docs/design/wiki-mention ①⑥⑦). 위키 댓글 · 이슈 댓글이 같이 쓴다. · 후보는 서버가 거른다(path 의 mentionables — 범위 · A3-02). 1자부터 ·… | `default` | 2 | 2 | 1 |
| `TaskWho.jsx` | (머리 주석 없음) | `default` | 2 | 1 | 0 |
| `UpgradeNotice.jsx` | '프로그램이 업그레이드되었으니 새로고침 하세요' 상자(v2.999 · 설계 docs/design/upgrade-reload ①③). 오류 경계(ErrorBoundary)가 '이 창의 판 ≠ 서버의 판' 이거나 화면 조각을 못 받은 오류일 때 그린다. ⚠ 주 번들에 둔다… | `useUpgradeVersions` `useSinceNotes` `UpgradeChanges` `RefreshIcon` `default` | 2 | 2 | 2 |
| `selectSort.js` | 드롭다운(&lt;select>) 선택지 정렬(순수, v2.708 — 사용자 요청 "모든 드롭박스 메뉴를 정렬해서 보이게, 앞으로 만드는 드롭박스도 정렬"). 화면은 `components/Select.jsx` 를 쓰고, 날 `<select>` 는 테스트가 금지한다. | `optionText` `isPinnedOption` `sortSelectChildren` | 2 | 1 | 1 |
| `serviceDownText.js` | '서비스 일시 미가용' 판정·문구(순수, v2.459). | `serviceDownKind` `headlineFor` `probeOutcome` `reconnectStep` `reconnectStatusText` `diagnosticLines` 외 4 | 2 | 1 | 2 |
| `useNarrowScreen.js` | 좁은 화면 여부 훅(v2.987 — VmDistPanels.jsx 에서 옮김 · 물리서버 폴더와 함께 쓴다). matchMedia 가 없거나 던지면 넓은 화면으로 본다(SSR · 구형 브라우저). | `useNarrowScreen` | 2 | 2 | 0 |
| `vmperf/VmPerfView.jsx` | VM · ESXi 호스트 **성능** 화면(v2.911 · 시안 docs/design/vm-perf ②③④ · 사용자 컨펌 '개선' = 기본값). 예전 성능 모달(VmMetrics.jsx MetricModal — 지표 4 + 기간 5 버튼 한 줄 · datetime-l… | `default` | 2 | 1 | 3 |
| `AccessDenied.jsx` | AccessDenied — 권한 부족(403) 안내 화면. | `default` | 1 | 1 | 2 |
| `GlobalProgress.jsx` | 전역 진행 표시(v2.501) — 사용자 요구: "대기가 3초 이상이면 구체적으로 어떤 작업을 하는지 진행상태를 보여줄 것." | `default` | 1 | 1 | 0 |
| `Palette.jsx` | 헤더 ⌘K 찾기(v2.508 기능 · 탭 → v2.909 장비 · 기능 · 탭). | `rememberLastSearch` `takeLast` `default` | 1 | 1 | 3 |
| `ServiceDown.jsx` | ServiceDown — 서비스 일시 미가용(업그레이드 중·5xx·연결 실패) 안내 화면(v2.459). | `default` | 1 | 1 | 1 |
| `SessionExpiryGuard.jsx` | 세션 만료 경고 + 연장(v2.428). | `tokenExpiresAt` `default` | 1 | 1 | 1 |
| `WorldMap.jsx` | (머리 주석 없음) | `default` | 1 | 1 | 0 |
| `invSearchQuery.js` | 헤더 ⌘K '통합 장비 검색' 의 화면 쪽 순수 모듈(v2.909). | `splitPrefix` `withKindPrefix` `focusPlan` `listPlan` `normPlan` `recentKeyFor` 외 26 | 1 | 1 | 4 |
| `loadState.js` | 화면이 '비어 있는 이유' 를 정직하게 말하게 하는 판정(v2.509, 순수 모듈). v2.747: V4 셸 삭제로 version_4/loadState.js 에서 옮겼다(관제 콘솔이 쓴다). | `isTimeoutError` `isNetworkError` `loadPhase` `collectProgress` `loadText` | 1 | 1 | 1 |
| `palette.js` | 헤더 ⌘K 기능 찾기의 후보 목록과 매칭(v2.508, 순수). | `catsOfFrom` `tabEntries` `search` `flatten` `TAB_GROUP` | 1 | 1 | 2 |
| `sortableText.js` | 표 자동 정렬의 순수 로직(v2.422, 사용자 요구 '모든 표에 제목 클릭 정렬'). DOM 없이 React 엘리먼트 트리만 다루므로 node 환경 테스트로 고정한다. STable.jsx 가 이 함수들로 헤더 클릭 → tbody 행 재정렬을 수행한다. | `textOf` `sortKeyOf` `compareKeys` `cellText` `sortChildren` `nextSortState` 외 2 | 1 | 1 | 7 |
| `vmMetricsText.js` | 성능 모달의 조회 실패 판정(순수 — vitest 고정, v2.591 감사 F6). | `metricErrorState` `metricSkipText` `metricAuthStopText` `edgePortalHref` `stopsAutoRefresh` | 1 | 1 | 3 |
| `vmRemoteProbeText.js` | VM 원격 접속 버튼의 사전 도달성 점검 문구(순수 — 판정과 문구를 한 곳에 둔다). | `probeFailState` `probeRow` `probeTip` `probeColor` `probeFooter` | 1 | 1 | 2 |
| `vmMetricStats.js` | VM·호스트 성능 차트 요약 수치(v2.598 VC2598-02). 서버는 vCenter 결측(-1)을 null 로 준다 — 예전 화면은 `a + p.v` 로 null 을 0 으로 더하고 분모는 전 점이라 평균이 **과소**했고, 최대·마지막도 결측에 끌렸다. 값이 있… | `metricStats` | 0 | 0 | 1 |

## 웹 공용 훅 — `web/src/hooks/` (7)

사용처가 많은 순.

| 모듈 | 하는 일 | 내보내는 이름 | 사용처 | 영역 | 테스트 |
|---|---|---|---|---|---|
| `useHashTab.js` | 하위 탭을 URL 해시에 실어 **새로고침·북마크·뒤로가기에서 유지**한다(v2.438). | `useHashTab` | 42 | 4 | 2 |
| `hashTab.js` | 해시 라우팅의 하위 탭 계산(순수, v2.438). | `hashSegments` `isUnderBase` `tabFromHash` `buildHash` `movedTabHash` `legacyShellHash` 외 3 | 14 | 6 | 3 |
| `useLatest.js` | 늦게 도착한 이전 응답이 최신 화면을 덮어쓰지 못하게 하는 세대 가드(v2.447, 감사 B16). | `useLatest` `default` | 11 | 1 | 0 |
| `searchHandoff.js` | 화면 사이의 검색어 인계(v2.616, V5 통합 검색). | `onSearchHandoff` `handoffSearch` `handoffMany` `takeSearch` `stashForNewTab` `consumeNewTabHandoff` 외 3 | 10 | 5 | 1 |
| `useSearchHandoff.js` | 검색어 인계(hooks/searchHandoff.js, v2.616)를 받는 화면용 훅(v2.909 통합 장비 검색). | `useFocusHandoff` `default` | 8 | 2 | 0 |
| `useStickyOffset.js` | 화면 안에서 sticky 로 붙이는 바의 top 을 '숫자를 박지 않고' 정하기 위한 높이 측정 훅(v2.810). | `useStickyHeadH` `useBoxHeight` `STICKY_HEADS` | 2 | 2 | 1 |
| `useTreeDnd.js` | 트리 드래그앤드롭 상태 기계(v2.319, 모듈화 감사 #10). | `dropZone` `useTreeDnd` | 1 | 1 | 1 |

## 웹 공용 유틸 — `web/src/util/` (2)

사용처가 많은 순.

| 모듈 | 하는 일 | 내보내는 이름 | 사용처 | 영역 | 테스트 |
|---|---|---|---|---|---|
| `fmt.js` | 공용 표시 포맷터(v2.319, 모듈화 감사 #9). | `fmtAgo` `num` `fmtDate` `fmtTime` `dec1` `fmtW` 외 3 | 20 | 4 | 2 |
| `csv.js` | 클라이언트 CSV 내보내기 공통 유틸 — **수식 인젝션 가드**를 한 곳에 모은다. 서버(server/src/util/csv.js guardCell)·pyportal(hub/csvio.py)과 동일 정책: Excel/Sheets 는 `= + - @` (및 앞선 탭/C… | `guardCell` `csvCell` `toCsv` | 18 | 2 | 3 |

## 웹 최상위 공용 모듈 — `web/src/` (12)

사용처가 많은 순.

| 모듈 | 하는 일 | 내보내는 이름 | 사용처 | 영역 | 테스트 |
|---|---|---|---|---|---|
| `api.js` | v2.498: 진행 중 요청 레지스트리 + 장기 로딩(hang) 보고. perfClient 는 api.js 를 import 하지 않으므로 순환이 없다(설정 조회는 fetchJson 을 인자로 받는다). | `noteHttpError` `permissionInfoFor` `httpInfoFor` `fetchJson` `postJson` `sendJson` 외 34 | 396 | 19 | 43 |
| `numOrNull.js` | `numOrNull`(웹) — '읽지 못한 수치' 를 0 으로 둔갑시키지 않는 단일 판정. | `numOrNull` `default` | 132 | 11 | 5 |
| `dayStamp.js` | 브라우저 쪽 날짜 표기(v2.582 BUG-3) — 내려받기 파일명·만료일은 **사용자의 로컬 날짜**다. `new Date().toISOString().slice(0, 10)` 은 UTC 날짜라 한국 시각 00:00~09:00 에는 **어제**가 된다 (보고서 파일명… | `dayStamp` | 24 | 5 | 1 |
| `regions.js` | 지역(region) 목록 — 웹 단일 소스(v2.575 IMP-10). ⚠ 값은 서버 `server/src/util/regions.js` 와 **글자 그대로 같아야 한다**(웹은 서버 소스를 import 할 수 없어 복사가 불가피하다). `web/src/regions.`… | `REGIONS` `default` | 5 | 2 | 1 |
| `perfClientLogic.js` | 브라우저 성능 보고의 **순수 로직**(v2.498): 경로 정규화·장기 로딩 문구· 쿨다운/상한 판정. 웹 테스트는 node 환경(DOM 없음)이라 판정·문구는 여기서 회귀로 고정한다. | `normPath` `loadingText` `allowReport` `stallPayload` `statusPollTargets` `requesterText` 외 3 | 4 | 2 | 3 |
| `perfClient.js` | 진행 중 요청 레지스트리 + 장기 로딩 보고(v2.498). | `startReq` `ridOf` `endReq` `inflightSnapshot` `oldestInflightMs` `subscribeInflight` 외 7 | 3 | 2 | 2 |
| `upgradeNotice.js` | 업그레이드 뒤 '새로고침 하세요' 안내의 판정 코어(v2.999 · 사용자 요청 2026-11-13 · 설계 docs/design/upgrade-reload · 컨펌 '추천대로 전부 진행'). | `normVersion` `cmpVersion` `isStale` `markNoticeShown` `noteServerVersion` `subscribeUpgrade` 외 15 | 3 | 2 | 2 |
| `chunkReload.js` | 업그레이드 뒤 옛 화면 조각(청크) 404 에서 빠져나오기(v2.977 전체 점검 · 화면 축 1번 — 재현). | `isChunkLoadError` `claimAutoReload` `reloadOnChunkError` `installChunkReload` `RELOAD_KEY` `RELOAD_GAP_MS` | 2 | 2 | 1 |
| `pwa.js` | PWA 부트스트랩 — 서비스워커 등록(설치 가능) + 위험 인시던트 브라우저 알림(폴링). 브라우저 푸시(VAPID) 없이도 세션이 떠 있는 동안 새 위험 경보를 데스크톱/모바일 알림으로 띄운다. 알림 권한은 사용자 제스처(인사이트 › 인시던트의 "알림 켜기")로 요청… | `registerPwa` `enableNotifications` `startAlertNotifications` | 2 | 2 | 0 |
| `cmpVersion.js` | semver 형태 버전 비교. 서버 `server/src/util/cmpVersion.js` 와 **같은 규칙**(v2.826 — 웹에도 하나만 둔다): - 선행 `v`/공백을 벗긴다 · 세그먼트가 전부 숫자가 아니면 null(모르는 것 — **낮은 버전으로 보지 않는… | `cmpVersion` `default` | 1 | 1 | 2 |
| `sessionActivity.js` | 서버측 세션 정리(2026-10-09 검토 S-05) — 로그아웃을 서버에 알리고, 서버측 유휴 만료의 기준인 '사용자 활동' 을 보낸다. | `createActivityPinger` `sendActivity` `serverLogout` `ACTIVITY_MIN_INTERVAL_MS` `ACTIVITY_EVENTS` | 1 | 1 | 1 |
| `usageTracker.js` | 기능 사용 추적(화면 쪽, v2.913 · 설계 docs/design/feature-usage §4.2·§4.6). | `usageKeyFromHash` `createUsageTracker` `sendUsage` `POLL_MS` `STABLE_MS` `BEAT_MS` 외 2 | 1 | 1 | 3 |

## 공용 위치 밖에서 널리 쓰이는 모듈 (77)

공용 위치(위 5곳) 밖에 있지만 사실상 공통 기능인 모듈이다. 새로 만들기 전에 함께 본다.

### 서버 (69)

**자기 영역 말고 5개 이상 영역**이 import 하는 모듈. 다른 영역 수가 많은 순.

| 모듈 | 하는 일 | 사용처 | 다른 영역 | 테스트 |
|---|---|---|---|---|
| `server/src/config.js` | (머리 주석 없음) | 507 | 86 | 174 |
| `server/src/store.js` | (머리 주석 없음) | 205 | 43 | 297 |
| `server/src/collector/registry.js` | Collector registry — the list of remote collector agents (one per datacenter) the central portal pulls power from. Stored in CONFIG_DIR/collectors.jso… | 82 | 31 | 48 |
| `server/src/security/secretVault.js` | 설정 파일 자격증명(비밀번호·SSH 키·토큰)의 저장 방식(평문/암호화) 중앙 모듈(v2.296). | 40 | 28 | 21 |
| `server/src/mock/demo/flags.js` | 데모(DATA_SOURCE=mock) 모드 공용 판정(v2.708). | 85 | 26 | 3 |
| `server/src/alerts.js` | Alerting — evaluates threshold/condition rules against the current snapshot on an interval and pushes notifications to Slack(incoming webhook) and/or… | 30 | 23 | 28 |
| `server/src/proxy/sshExec.js` | Small SSH helper built on ssh2: connect, run commands, and upload files via SFTP. Shared by the proxy auto-deploy and the agent auto-deploy features.… | 46 | 17 | 28 |
| `server/src/datacenter/store.js` | DataCenter(법인) 레지스트리 — vCenter의 '상위 개념'. | 44 | 15 | 11 |
| `server/src/vcenter/registry.js` | vCenter registry — read/write the managed list of vCenters in config/vcenters.json (the same file the live collector polls), with validation, password… | 31 | 15 | 6 |
| `server/src/vcenter/soapParse.js` | 순수(사이드이펙트 없음) SOAP 응답 파서 — worker_threads 워커에서도 재사용하기 위해 soapClient.js에서 분리했다. 여기에는 config/DB/네트워크 등 부수효과 있는 import를 절대 추가하지 말 것(워커가 로드할 때 부수효과가 워커 스레… | 25 | 15 | 16 |
| `server/src/mail/service.js` | 포탈 공용 메일 발송 진입점 (v2.454). | 18 | 14 | 17 |
| `server/src/agent/envTimeout.js` | 호환 재수출(v2.613 DEPS2613-01) — 본체는 `util/envTimeout.js` 로 옮겼다. config.js 가 agent/ 를 import 하는 방향(설정 leaf → 엣지 워커 디렉터리)이 잠재 순환의 씨앗이었고, agent/ 밖 18개 파일이 이… | 33 | 13 | 2 |
| `server/src/vcenter/restClient.js` | (머리 주석 없음) | 19 | 13 | 26 |
| `server/src/idrac/registry.js` | iDRAC registry — the managed list of Dell servers whose power draw we collect over Redfish. Stored in CONFIG_DIR/idrac.json (gitignored, 0600, holds c… | 34 | 12 | 52 |
| `server/src/mock/demo/edge.js` | 데모(DATA_SOURCE=mock) 엣지(수집 서버) 그룹(v2.708). | 23 | 12 | 2 |
| `server/src/mail/settings.js` | 포탈 공용 메일(SMTP) 설정 (`mail.json`, v2.454). | 21 | 12 | 21 |
| `server/src/audit.js` | Audit log — records security/operational actions (who did what, when) so the portal's write operations (VM 생성, 원격접속, 설정 변경 등)이 추적된다. Appended to CONFI… | 132 | 11 | 40 |
| `server/src/auth/auth.js` | (머리 주석 없음) | 143 | 10 | 54 |
| `server/src/runtime-settings.js` | Runtime-adjustable settings that can be changed from the portal UI (and persisted), overriding the env defaults. Currently: the data source (mock \| li… | 19 | 10 | 22 |
| `server/src/security/tlsTrust.js` | 장비 TLS 상대 인증(2026-10-09 검토 S-02) — 자격증명을 보내는 HTTPS 연결이 **정말 그 장비인지** 확인한다. | 14 | 10 | 4 |
| `server/src/storage/registry.js` | 스토리지 장비 등록부(v2.302). | 28 | 9 | 39 |
| `server/src/gpu/settings.js` | GPU 게스트 수집 설정 — 어떤 법인(vCenter)의 패스쓰루 GPU VM을 게스트 OS 계정으로 모니터링할지, 폴링 주기/동시성/타임아웃, 그리고 vCenter별 게스트 OS 자격증명을 보관한다. config/gpu-guest.json (gitignore, 060… | 13 | 9 | 9 |
| `server/src/perf/monitor.js` | 서버 성능 측정기(v2.498). 요청 지연·이벤트 루프 정체·진행 중 요청을 **상시 O(1)** 로 계측하고, 임계를 넘은 것만 남긴다. 설정 › 서버 성능 측정 화면(/api/admin/perf)이 이 값을 읽는다. | 13 | 9 | 4 |
| `server/src/idrac/invCache.js` | Cache of the latest hardware/firmware inventory collected per iDRAC server. Inventory is mostly static, so it is refreshed on a slow cadence and persi… | 25 | 8 | 7 |
| `server/src/vcenter/soapClient.js` | vim25 SOAP collector — gathers REAL host/VM/datastore metrics that the vSphere REST list endpoints do not expose (CPU/memory capacity & live usage, da… | 17 | 8 | 43 |
| `server/src/mock/generator.js` | Deterministic-ish mock data generator that simulates a large, globally distributed VMware estate. It produces the same normalized shape as the live vC… | 12 | 8 | 16 |
| `server/src/mock/demo/users.js` | 데모(DATA_SOURCE=mock) 합성 데이터: '사용자·게스트' 묶음(v2.708). | 11 | 8 | 1 |
| `server/src/auth/demoGuest.js` | 데모(mock) 모드의 내장 데모 계정 접근 규칙(v2.716). | 66 | 7 | 13 |
| `server/src/collector/state.js` | In-memory state for distributed collection on the CENTRAL portal: the merged host→power map pulled from remote collector agents, plus per-collector st… | 22 | 7 | 31 |
| `server/src/central/inventory.js` | 사이트 위임 수집 — 중앙(OC2) 측 인벤토리 캐시. | 20 | 7 | 20 |
| `server/src/insights/analysisServers.js` | 서버 분석 공용 — iDRAC 등록부(중앙) + 위임 법인의 원격 인벤토리 병합·법인 귀속·필터(v2.579 에 `routes/admin/shared.js` 에서 분리, ARCH-04). | 17 | 7 | 6 |
| `server/src/clustercfg/analyze.js` | 특수 기능 '클러스터 HA·DRS 점검'(도구 키 `cluster-check`, v2.701) 판정(순수). 입력은 스냅샷 vCenter 배열(vc.clusterCfg = clustercfg 캐시)과 호스트 배열. vCenter 왕복 0. | 12 | 7 | 7 |
| `server/src/idrac/poller.js` | Portal-embedded iDRAC power poller. On an interval it reads current power from every enabled registered Dell server (Redfish) and appends a sample to… | 12 | 7 | 11 |
| `server/src/vcenter/collectTarget.js` | '이 포탈이 직접 로그인해 수집하는 vCenter 인가' 판정(순수 · import 0) — v2.732(점검 2회차 B4-01). | 9 | 7 | 2 |
| `server/src/dscfg/collect.js` | 데이터스토어 운영 속성 갱신(v2.700 — A17). 인벤토리 수집 한 주기 안에서 오래된 DS 부터 상한만큼. 캐시는 vmcfg 처럼 인메모리이고 DS 전용이다(다른 캐시의 prune 이 지우지 않게). 실패는 격리한다. | 7 | 7 | 2 |
| `server/src/auth/scope.js` | 사용자 데이터 범위(scope) 해석 — "이 사용자가 볼 수 있는 vCenter"를 계산한다. scope = { vcenters:[id...], regions:[name...] }. 둘 다 비면 제한 없음(전체). 명시 vCenter + 지정 리전에 속한 모든 vCe… | 101 | 6 | 6 |
| `server/src/svcmon/store.js` | 성능점검 대상/폴더 저장소 — `CONFIG_DIR/svcmon.json` 전용 파일(포탈 코어와 분리). | 21 | 6 | 19 |
| `server/src/logs/db.js` | vCenter 이벤트 로그 장기 보관 DB. vCenter는 이벤트를 단기간만 보관하므로, 포탈이 주기적으로 수집해 여기 누적한다. Node 내장 SQLite(--experimental-sqlite) 우선, 없으면 NDJSON 폴백. 중복은 (vcenterId, key… | 17 | 6 | 43 |
| `server/src/partfault/types.js` | 물리 파트 장애의 **공용 계약**(순수, v2.547). | 16 | 6 | 9 |
| `server/src/sanswitch/registry.js` | SAN 스위치 등록부(v2.410). | 15 | 6 | 41 |
| `server/src/storage/store.js` | 이 노드가 수집한 최신 스냅샷 보관(v2.302). deviceId → NormalizedSnapshot. 재시작 후에도 마지막 뷰가 비지 않게 파일로 영속 (자격증명 없음 — 정규화 스냅샷만. 그래도 계정 목록이 있어 0600 + gitignore). 시계열(용량 추… | 15 | 6 | 15 |
| `server/src/upgrade/signature.js` | 업그레이드 번들 배포자 서명 검증의 **런타임 판정 하나**(검토 S-10, v2.730). | 13 | 6 | 9 |
| `server/src/metrics/unreadVcenters.js` | '지금 값' 으로 쓰지 않는 vCenter 와 그 사유(순수 leaf — import 0). | 10 | 6 | 4 |
| `server/src/security/emergencyStop.js` | 긴급중단(Emergency Stop) — 2인 승인(관리자 2명 OTP)으로만 켜고/끄는 전역 수집 정지 스위치. | 8 | 6 | 3 |
| `server/src/security/certMonitor.js` | TLS 인증서 만료 감시 — 등록된 vCenter·NSX Manager의 443 인증서를 주기적으로 프로브해 만료일(D-90 경고 / D-30 위험)을 추적한다. 28개 vCenter 규모에서 수동 추적이 불가능한 항목(커뮤니티 단골 장애: vCenter STS/머신… | 7 | 6 | 8 |
| `server/src/auth/addressMask.js` | 비-admin 응답에서 장비 관리 주소·계정명을 가린다(v2.599 AUTHZ-2599-03). | 44 | 5 | 15 |
| `server/src/bareos/settings.js` | Bareos 연동 설정(v2.820 · v2.823 법인별 Director). 파일: CONFIG_DIR/bareos.json (0600 · 원자적 쓰기 · 비밀 봉인). | 31 | 5 | 25 |
| `server/src/auth/permissions.js` | 기능별 권한(Permission) 프레임워크 — "모든 기능에 대해 역할별 권한을 켜고 끈다". | 17 | 5 | 14 |
| `server/src/isidu/settings.js` | 아이실론 디렉터리 사용량 수집 대상 설정(v2.736). | 17 | 5 | 17 |
| `server/src/collector/remoteInventory.js` | Remote (edge-collected) iDRAC server inventory, pulled from collector agents' /api/collector/export (the `servers` field). Keyed by collectorId so eac… | 15 | 5 | 23 |
| `server/src/vcenter/dsBrowse.js` | 데이터스토어 브라우즈 (v2.276) — 데이터스토어 상세에서 ① 어떤 VM 이 할당돼 있는지, ② 실제 어떤 파일들이 있는지 보여준다. | 15 | 5 | 4 |
| `server/src/ipam/ledger.js` | IPAM ledger builder — turns a snapshot into a per-center IP record list. Shared by the /tools/ipam API and the SQLite exporter so both stay in sync. | 14 | 5 | 23 |
| `server/src/metrics/db.js` | Generic metrics time-series store (host temperature, datastore usage, GPU utilization …). Mirrors the iDRAC power DB: Node built-in SQLite when the --… | 14 | 5 | 33 |
| `server/src/central/storageEdge.js` | 엣지들이 push 한 스토리지 스냅샷의 중앙 보관(v2.302). agent → { at, devices:[NormalizedSnapshot] }. 파일 영속: central-agent-storage.json (central-agent-* 는 .gitignore 와일드… | 12 | 5 | 17 |
| `server/src/idrac/db.js` | Time-series storage for iDRAC power samples. | 12 | 5 | 22 |
| `server/src/agent/deploy.js` | iDRAC-scan collector agent auto-deploy. The central portal pushes its offline install package to a fresh Rocky 9 host over SSH, runs install.sh, injec… | 11 | 5 | 8 |
| `server/src/sanswitch/store.js` | 이 노드가 수집한 최신 스냅샷 보관(v2.410, storage/store.js 와 동일 철학). deviceId → NormalizedSwitchSnapshot. 재시작 후에도 마지막 화면이 비지 않게 파일로 영속 (자격증명 없음 — 정규화 스냅샷만. 그래도 0600… | 11 | 5 | 19 |
| `server/src/vmchanges/eventDetail.js` | VM 이동 이력(A7)·구성 변경(A8) — 이벤트 본문에서 화면이 쓰는 몇 필드만 뽑는다(v2.702, 순수). vCenter 이벤트 수집(vcenter/soapClient.js parseEventsXml)이 이 함수를 불러 행에 `detail`(JSON) 을 싣는다… | 11 | 5 | 5 |
| `server/src/central/fleet.js` | 엣지 베어메탈 집계 — 중앙(OC2) 측 캐시. | 10 | 5 | 19 |
| `server/src/gpu/guestops.js` | VMware Tools 게스트 작업으로 게스트 OS 안에서 nvidia-smi를 실행해 GPU 사용률을 수집한다(패스쓰루 GPU는 ESXi에서 안 보이므로 게스트에서만 알 수 있음). | 10 | 5 | 14 |
| `server/src/idrac/service.js` | Glue between the iDRAC registry (which server maps to which ESXi host) and the power-sample DB. Provides host-name → power lookups for the API and the… | 10 | 5 | 8 |
| `server/src/nsx/store.js` | In-memory NSX aggregator + poller. Mirrors the vCenter store design: each NSX Manager is polled in parallel with a per-manager timeout so one slow/ hi… | 10 | 5 | 8 |
| `server/src/collector/puller.js` | Central-portal puller: periodically fetch each registered collector agent's /api/collector/export and merge its host→power into shared state. Per-host… | 9 | 5 | 23 |
| `server/src/upgrade/manager.js` | Orchestrates the auto-upgrade feature for the running portal: tracks the last check, runs the optional background watcher (local folder + remote sourc… | 8 | 5 | 16 |
| `server/src/edgelog/spec.js` | 엣지 포탈의 **진행상태**를 어디서 읽는지 적은 표(순수 데이터, v2.549). | 7 | 5 | 18 |
| `server/src/nsx/registry.js` | NSX Manager registry — read/write the managed list in CONFIG_DIR/nsx.json, with validation, password redaction, and a connectivity test. Edited throug… | 7 | 5 | 8 |
| `server/src/pdu/poller.js` | PDU 주기 수집. | 6 | 5 | 11 |
| `server/src/security/peerTrust.js` | 장비 상대 신뢰 저장소(2026-10-09 검토 S-01 SSH 호스트키 · S-02 TLS 인증서) — '이 주소의 장비가 정말 그 장비인가'. | 6 | 5 | 11 |
| `server/src/focusmon/service.js` | 이 노드의 집중 모니터링을 묶는다(v2.976): 키 · 중앙 직접 수집기 · 1초/10초 틱 · 수집 시작/끝 · 엣지 깨우기. | 5 | 5 | 8 |

### 웹 (8)

다른 영역 5개 이상 **또는 사용처 20개 파일 이상**인 모듈(도구 화면이 한 폴더 `views/tools` 에 모여 있어 영역 수만으로는 가를 수 없다). 사용처가 많은 순.

| 모듈 | 하는 일 | 사용처 | 다른 영역 | 테스트 |
|---|---|---|---|---|
| `web/src/views/unitText.js` | 값 + 단위 표기 — **값이 없으면 단위를 붙이지 않는다**(v2.575 BUG-20). | 53 | 7 | 4 |
| `web/src/views/tools/relTime.js` | 상대시각 문구 — **공용 코어** (v2.574 IMP-03). | 49 | 4 | 1 |
| `web/src/views/changeResult.js` | v2.731(점검 1회차 A5-01): 변경 요청 응답 판정 — 순수 모듈(화면·테스트가 같이 쓴다). | 40 | 4 | 4 |
| `web/src/views/tools/toneVar.js` | toneVar — 판정 톤(`ok`/`warn`/`bad`, 또는 진단 어휘 `green`/`amber`/`red`) → CSS 색 변수. **공용 코어** (v2.613 DEPS2613-11). 예전에는 `bmUsageText`·`edgeLogText`·`partFa`… | 29 | 1 | 1 |
| `web/src/views/blankOr.js` | 숫자 입력칸 → 요청 값(v2.596, 감사 CLAMP2596-02·05). 빈 칸은 **보내지 않는다**(undefined — JSON 에서 빠진다) — `Number('')` 는 0 이라 '임계 끔'·'보존 무제한' 으로 둔갑했다. 서버도 빈 값을 미지정으로 받지만… | 27 | 3 | 1 |
| `web/src/views/tools/shared.jsx` | SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동. | 26 | 1 | 3 |
| `web/src/views/droppedSecretText.js` | 저장 비밀 폐기 안내(v2.607, 감사 WEB2607-03 · LEFT2607-07). | 21 | 3 | 4 |
| `web/src/views/hostcfg/hostCfgText.js` | v2.699 — ESXi 호스트 구성·보안 문구·판정. 서버 hostcfg/parse.js 와 같은 입력으로 대조한다(번들 경계라 두 벌). 문구에 백틱·별표 금지(BoldText 는 **강조** 만 해석). | 7 | 5 | 5 |

## 살펴볼 것

판정이 아니라 **사실 목록**이다 — 지우거나 옮기기 전에 그 파일을 열어 확인한다.

### import 사용처가 없는 공용 모듈 (2)

죽은 코드라는 뜻이 아니다 — 경로를 조합하는 동적 import · 워커 진입점 · 테스트 전용일 수 있다.

- `server/src/util/parseWorker.js`(테스트 1)
- `web/src/components/vmMetricStats.js`(테스트 1)

### 서버와 웹에 같은 이름으로 두 벌 있는 모듈 (4)

런타임이 달라 두 벌일 수 있다. 같은 판정이면 테스트가 같은 입력으로 두 벌을 대조해야 한다(루트 `CLAUDE.md`).

| 이름 | 서버 | 웹 |
|---|---|---|
| `cmpVersion` | `server/src/util/cmpVersion.js` | `web/src/cmpVersion.js` |
| `csv` | `server/src/util/csv.js` | `web/src/util/csv.js` |
| `numOrNull` | `server/src/util/numOrNull.js` | `web/src/numOrNull.js` |
| `regions` | `server/src/util/regions.js` | `web/src/regions.js` |
