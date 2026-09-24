# Arista CloudVision(CVP) 네트워크 스위치 수집 (v2.608)

사용자 요청: "arista CVP 에서 네트워크 스위치 정보 가져오는 기능 — iDRAC 정보를 edge 에 연결된 서버에서 원격으로 가져오는 것처럼,
CVP 도 Edge 에 연결되어 있다. 가져올 정보: 스위치 정보·장애 파트·포트 구성·포트 사용량·버전·라우팅. 데이터 용량이 많으니 별도 DB."
선택: 엣지 수집 → 엣지 DB → 변경분 gzip·청크 push → 중앙 DB · 중앙 직접 수집도 지원 · 인증 토큰 + ID/PW 둘 다.

## 1. 구성

| 위치 | 파일 | 역할 |
|---|---|---|
| 등록부 | `server/src/cvp/registry.js` → `cvp-servers.json` | CVP 서버(주소·인증 방식·토큰/비밀번호·담당 엣지). 비밀은 secretVault 봉인(`SECRET_FILES`) + `.gitignore` + 원자 쓰기 + 손상 보존. 접속 대상(host·계정·인증 방식)이 바뀌면 저장 비밀을 승계하지 않는다(`util/secretCarry`). |
| 설정 | `server/src/cvp/settings.js` → `cvp-settings.json` | 켜짐(기본 꺼짐)·주기(기본 5분, 하한 60초)·원시 보존(기본 **7일**)·일 롤업 보존(730일)·동시 CVP 수(2)·CVP 당 시한(120초). 빈 칸은 이전 값. 엣지는 중앙 값을 pull. |
| 수집 | `cvp/client.js`(로그인·조회·후보 체인) · `cvp/parse.js`(순수 파서) · `cvp/poller.js`(주기·인증 정지·델타) | |
| 상태 | `cvp/store.js`(인메모리 — CVP 별 마지막 수집 결과) | |
| DB | `cvp/db.js` → `cvp.db`(`config.dbDir`, 0600, `insights/dbLocation` MIGRATABLE) | 아래 3절 |
| 엣지 → 중앙 | `cvp/push.js` → `POST /api/central/cvp-data`(BIG_JSON) | |
| 중앙 → 엣지 | `agent/cvpConfigPull.js` ← `GET /api/central/cvp-config` | 목록(자격증명 포함)·설정·'지금 수집' 요청(claim→ack, `cvp/collectRequests.js`) |
| 중앙 수신 | `central/cvpEdge.js`(상태 보관 + 수신 정제) | |
| 화면 API | `server/src/routes/api/cvp.js` | 5절 |

엣지 로그 표(`edgelog/spec.js`): `push.cvp` · `pull.cvp` · `collect.cvp`. 도구 키 `cvp`(`auth/toolAccess.js` 매핑). 데이터 흐름 지도는 `san` 칸
('SAN·네트워크 스위치')에 `cvp-data`·`cvp-config` 를 넣었다(웹 CAT_COLOR 에 새 칸을 만들지 않으려고).

## 2. 인증

- **토큰**(권장 — CVP 서비스 계정 토큰): 모든 요청에 `Authorization: Bearer <token>`. 첫 조회(인벤토리)가 401/403 이면 자격증명 거부.
- **ID/PW**: `POST /cvpservice/login/authenticate.do` `{userId,password}` → `Set-Cookie: access_token=…`(없으면 본문 `sessionId`/`cookie`) →
  이후 `Cookie: access_token=…`. 끝나면 `POST /cvpservice/login/logout.do`(실패 무시).
- **자격증명 거부만 주기 수집을 멈춘다**(`cvp-auth-stops.json`, util/authGuard). 로그인의 401/403, 토큰 모드 첫 조회의 401/403 만이다.
  장비별 텔레메트리 경로의 403 은 **RBAC 거부일 수 있어** 사유(`missing[kind]='forbidden(403)'`)로만 남긴다(수집을 멈추지 않는다).
  수동 실행('지금 수집'·연결 테스트)은 막지 않고, 토큰/비밀번호가 바뀌면 자동 재개, 저장 비밀로 연결 테스트가 성공하면 정지를 푼다.
- TLS: `verifyTls:false`(기본 — 자체서명 CVP)면 **로컬** undici Agent 만 검증을 끈다(전역 디스패처 금지). 두 Agent 모두 `withSsrfLookup`.

## 3. 용량 계산과 결정 (행 수를 먼저 계산했다)

가정: 스위치당 포트 64개(리프 48 + 업링크 8 + 여유), 링크가 올라온 포트 60%, 주기 5분(288회/일). 행 크기는 열 11개 + UNIQUE 인덱스
(agent,cvp_id,device_key,port,ts) + ts 인덱스를 합쳐 **약 170바이트/행**으로 잡았다(SQLite 페이지 여유 포함 추정).

| 규모 | 포트 | 링크 올라온 포트 | 원시 행/일 | 원시 7일 | 원시 30일 |
|---|---:|---:|---:|---:|---:|
| 스위치 200대 | 12,800 | 7,680 | **221만** | 1,548만 행 · 약 2.6GB | 6,635만 행 · 약 11GB |
| 스위치 1,000대 | 64,000 | 38,400 | 1,106만 | 7,741만 행 · 약 13GB | 3.3억 행 · 약 56GB |

결정:
1. **원시는 '링크가 올라온 포트' 만**(`db.sampleWorthy`) — 내려간 포트는 처리량이 없고, 구성·상태는 `port_latest` 가 이미 갖는다. 전 포트를 넣으면 행이 1.7배다.
2. **원시 기본 7일**(계약 초안은 30일이었다 — 200대 기준 30일은 11GB 라 기본값으로 둘 수 없다). 하한 1일·상한 90일. 1,000대 규모 현장은
   원시 2~3일 또는 주기 15분을 권장한다(화면이 보존일을 바꿀 수 있다).
3. **일 롤업**(`port_daily`, 평균 = 합/표본수 · 최대, 기본 730일): 200대 7,680행/일 → 730일 약 560만 행(약 0.7GB). 1,000대면 약 2,800만 행.
   **null 은 평균의 분모에 넣지 않는다** · 하루 경계는 `util/dayKey`(포탈 오프셋, 기본 KST).
4. **최신값은 전용 표**(`device_latest` 장비당 1행 · `port_latest` 포트당 1행 — 200대 1.28만 행). '최신 1건씩' 을 `GROUP BY + MAX(ts)` 로 만들지
   않는다(v2.550.3 실측 702ms → 0.53ms).
5. **BGP 는 피어 요약만**(피어 상태·AS·받은 prefix 수, 장비당 상한 512). **전체 RIB 는 수집하지 않는다** — 리프 1대 수천~수만 경로 × 200대 × 5분이면
   원시 7일만으로 수십억 행이다. '라우팅 정보' 는 피어 건강과 prefix 수로 답한다(정직 기록 — 경로 단위 조회가 필요하면 별건).
6. 부품(전원·팬·온도·트랜시버)은 **30분마다**(`CVP_PARTS_EVERY_MS`) — 장비당 조회 4회를 매 주기 돌리지 않는다(아래 예산).

중앙 DB 는 모든 엣지의 합이다(엣지 이름이 `agent` 열).

## 4. 예산·전송량

- **왕복 예산**(v2.528 규약): 장비당 매 주기 3회(인터페이스·카운터·BGP) + 30분마다 부품 4회. 200대 × 3 = 600회, CVP 안 동시 6
  (`CVP_DEVICE_CONCURRENCY`), 엣지와 CVP 가 같은 사이트(RTT 수 ms)라 수 초~수십 초. 중앙 직접 수집(RTT 800ms)이면 약 80초라 **CVP 당 시한 120초 /
  세션 예산 110초** 안이다. 예산이 모자라면 남은 장비를 **시작하지 않고** `missing.budget`·`truncated.notTried` 로 밝힌다.
- **연속 실패 차단**: 한 종류가 처음 3대에서 모든 후보 경로가 실패하면 그 주기의 나머지 장비는 그 종류를 시도하지 않는다(경로가 없는 CVP 에서 장비 수 ×
  후보 수만큼 404 를 두드리지 않게).
- **전송량**(합성 200대 × 64포트로 실측): 장비 레코드 전량 JSON 3.56MB → gzip **318KB**, 원시 표본 1만 행 945KB → gzip **212KB**.
  레코드를 매번 보내면 5분마다 530KB(하루 약 150MB/엣지)라, **구성이 바뀐 장비만 레코드를 보내고** 나머지는 `touch`([cvpId, key, ts])로 수집 시각만
  올린다(처리량은 원시 표본이 싣고 중앙이 표본으로 `port_latest` 를 갱신). 정상 상태 약 **212KB/5분(하루 약 60MB/엣지)**. 한 시간에 한 번은 전량을 다시
  보낸다. 처리량 값이 null 로 바뀌면(리셋·링크 다운) 해시가 바뀌어 레코드가 다시 간다(중앙에 낡은 값이 남지 않게).
  ⚠ 무작위 값이라 실측 압축비는 보수적이다(실데이터는 더 잘 줄 수 있다 — 확인 못 함).

## 5. 화면 API (응답 모양은 `CVP2608.md` 계약)

- `GET /api/tools/cvp` — `{ enabled, settings, poller:{running,lastRun,intervalMs,…}, servers:[{…, status:{ok,collectedAt,deviceCount,error,authStopped,usedPaths,missing,truncated,…}, pendingRequest}], totals:{devices,streaming,partsFault,partsWarn,partsUnknown,partsUnread,bgpDown,portsDown}, edges:[{agent,lastPushAt,ok,error,servers}], collectDrops, orphanRows }`
- `GET /api/tools/cvp/devices?cvpId=&q=` · `GET /api/tools/cvp/device?cvpId=&key=` · `GET /api/tools/cvp/port-series?cvpId=&key=&port=&hours=`
- `POST /api/tools/cvp/collect`(admin/operator) — 중앙 직접은 즉시(백그라운드), 엣지 위임은 요청 등록 → `{direct, requested, busy?}`
- `GET/POST/PUT/DELETE /api/tools/cvp/servers[/:id]` · `POST /api/tools/cvp/servers/:id/test` · `GET/PUT /api/tools/cvp/settings`(adminOnly)
- 전부 **전체 범위 계정만**(CVP 는 vCenter 귀속이 없다). 비-admin 에는 CVP host·계정·장비 관리 IP 를 비우고 `addressHidden`.

판정 규칙:
- `ports.down` 은 **관리상 켜져 있는데 링크가 내려간 포트**만 센다(admin down·미연결 포트를 장애로 세지 않는다. admin 을 모르면 세지 않는다).
- 부품 상태 5종(ok/warn/fault/unknown/absent — partfault 와 같은 이름). 빈 슬롯은 absent, 상태 필드가 없으면 unknown(정상이라 말하지 않는다).
  부품을 한 종류도 못 읽으면 `parts:null`(빈 배열 = 읽었고 0개와 구분). 일부만 못 읽으면 `partsMissingKinds`.
- 처리량·사용률: 첫 표본·음수 델타(카운터 리셋)·간격 비정상(주기×3 초과) → null. 사용률은 **방향별**(in/out 속도 각각 — v2.590 F9), 속도를 모르면 null,
  100% 초과(카운터·속도 불일치)는 **null**(클램프하지 않는다 — v2.578).
- 스트리밍이 꺼진 장비(`streaming:false`)는 텔레메트리를 조회하지 않는다(`telemetry:'not-streaming'`) — 포트·부품·BGP 는 null.

## 6. ⚠ 정직 기록 — 실장비 CVP 로 확인하지 못한 것

이 환경에는 CVP 가 없다. 아래는 **전부 추정**이고, 그래서 후보 체인·`usedPaths`·`missing`·`seenFields` 를 화면에 싣는다. 첫 실수집에서 그 셋을 보고 좁힐 것.

| 항목 | 후보 경로(순서) | 확인 못 한 것 |
|---|---|---|
| 인벤토리 | `/api/resources/inventory/v1/Device/all` → `/cvpservice/inventory/devices` | Resource API 스트림 모양(NDJSON/배열/이어붙인 객체 — 셋 다 받는다) · 필드명(`softwareVersion`·`modelName`·`streamingStatus`·`key.deviceId`) · Resource API 에 관리 IP 가 없을 수 있다(옛 API 의 `ipAddress` 만 확인된 이름) |
| CVP 버전 | `/cvpservice/cvpInfo/getCvpInfo.do` | 응답의 `version` 필드 |
| 인터페이스 | `/api/v1/rest/{serial}/Sysdb/interface/status/eth/phy/slice/1/intfStatus/all` | Telemetry REST(`/api/v1/rest`)가 이 CVP 버전에서 열려 있는지 · 필드(`operStatus`·`linkStatus`·`adminEnabled`·`speed`·`description`) · VLAN·LAG 소속은 이 경로에 없을 가능성이 높다(없으면 빈 칸) |
| 카운터 | `/api/v1/rest/{serial}/Smash/counters/ethIntf/FastCounters/current` | 필드(`inOctets`·`outOctets`·`inErrors`) · 누적값인지 |
| BGP | `/api/v1/rest/{serial}/Sysdb/routing/bgp/export/vrfBgpPeerInfoStatusEntryTable` | 경로 존재 · 필드(`bgpPeerState`·`bgpPeerAs`·`bgpPeerPrefixesReceived`) |
| 부품 | `…/Sysdb/environment/{power,cooling,temperature}/status` · `…/Sysdb/hardware/archer/xcvr/status` | 경로·상태 필드명 전부(`state`·`status`·`alertRaised`) |
| 로그인 | `/cvpservice/login/authenticate.do`·`logout.do` | 쿠키 이름 `access_token` 과 본문 `sessionId` 중 무엇이 오는지(둘 다 받는다) |

- CVaaS(클라우드) 는 토큰 모드로만 가정했다 — 확인 못 함.
- 목 CVP(테스트 `server/test/cvp2608b.test.js`)의 응답 모양은 위 추정으로 **합성**했다. 파서는 인식 필드가 하나도 없는 본문(오류 JSON 등)을 포트·부품·피어로
  지어내지 않는다(null — 테스트 고정).
