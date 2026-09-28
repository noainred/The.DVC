# IPMS(IP 관리) 아키텍처 리뷰 — 2026-09-28 (v2.639)

사용자 요청: "ipms 부분 아키텍처 리뷰해서 통합할 수 있는 부분 통합하고 개선할 수 있는 부분 개선해줘" · 선택 **전체 범위 + 전체 검증**.
방법: 조사 에이전트 2(서버·웹, 읽기 전용) → 리드가 재현·확정 → 파일 집합이 겹치지 않는 수정 그룹 3(A1 서버 판정 코어 · A2 서버 스토어 위생 ·
W 웹) 병렬 → 리드 통합·배선·전량 검증. 회귀: `server/test/ipms2639.test.js`(7) · `server/test/ipamStore2639.test.js`(10) ·
`web/src/views/tools/ipamRanges2639.test.js`(18). 변이 검증: A1 3/3 · A2 7/7.

## 1. 확정 결함(재현 근거)

| # | 위치 | 증상 | 근거 | 조치 |
|---|---|---|---|---|
| S-D1 | `ipam/scan.js rangeSize`·`expandRange`, `rangePolicies.specToRange`, `vcRangesCsv`, `scanRangesCsv` | 판정기 4벌 — CSV 가져오기 2종·`PUT /ipam/scan/settings` 가 PUT vc-ranges 가 거부하는 입력을 저장 | node 재현: `10.0.0.0/8/x` rangeSize 16777214 · `10.0.0.250-300` expandRange 10.0.0.250~10.0.1.44 · `/24.5` 180개 · `1-2-3` 2개 — `checkRangeSpec` 은 전부 오류 | 셋을 `checkRangeSpec` 어댑터로 · CSV 2종·설정 PUT 이 같은 판정 · GET vc-ranges 에 `invalid` |
| S-D2 | `ipam/rangeStore.js write()` | 디스크 쓰기 실패를 `{ok:true}` 로 보고(재시작하면 사라짐) | 코드 + 테스트에서 ENOSPC 주입 재현 | throw · 캐시는 성공 뒤에만 |
| S-D3 | `ipam/scanLog.js` 로드 | 손상 파일을 `[]` 로 넘겨 다음 기록이 원본을 덮음 | 코드 + 테스트 재현 | `preserveCorrupt` |
| S-D4 | `centralIpam.js resolveVc` vs `ipamExport.js vcResolver` | 이름 해석 규칙 2벌 — vc-ranges CSV 는 이름이 겹치면 첫 항목 | 코드 확인 | `ipam/vcResolve.js` 한 벌(모호하면 null) |
| W-D1 | `IpamNet.jsx rangeSpecSize` | `192.168.1.1-50` 크기 음수 → 정책 폼 저장 잠금 | node 재현 bn = -1062731470 | 사본 제거 → `ipmsRangeText.policySpecSize` |
| W-D2 | `IpScanSettings runNow` | 저장 400 을 무시하고 스캔 시작 + '입력한 대역 N개 스캔' | 코드(`putJson` 은 400 본문 반환) | `sv.ok===false` 면 미시작 + 줄 목록 |
| W-D3 | `ipamSubmenu2636.test.js:221` | v2.638 커밋에서 깨진 테스트(보고 누락) | vitest 실행 1 failed | 정규식 수정 |
| W-D4 | `IpamNet.IpamRanges` | 문법 검사·초안·서버 400 표시 없음(IPMS ② 에는 있음) | 코드 대조 | `VcScanRangeEditor` 한 벌 |
| W-D5 | `IpScanSettings` 대역 textarea | 검사 없음(서버도 없었다) | 코드 | `checkRangeList` + 잠금 |
| W-D6 | `ScanStatusModal` | 403 이면 ErrorBox + 끝나지 않는 Loading | 코드 · Chromium(viewer) 확인 | Loading 은 `!err` 일 때만 |
| W-D7 | `IpamNet.jsx:92` | 다운로드 실패 문구 불일치 | 코드 | `downloadFailText` |
| W-D8 | 웹 `checkRangeList` vs 서버 `[\n,]` | `a/24, b/24` 한 줄이 웹에서만 오류 | 코드 | `normalizeRangeText` |
| — | `IpamNet.IpamRanges` | 관리자 아닌 계정에 쓰기 버튼이 열려 눌러야 403 | Chromium(viewer) | `access==='no'` 잠금 + 사유 |

## 2. 통합·구조

- 서버: 판정 코어 1벌(`rangeSyntax`) · `numToIp` 사본 제거(`util/ipv4`) · `settings.invalidEntries` 1벌 · `_ipamKey` → `ipamRevKey()` 재사용 ·
  `centralIpam.js` 의 비-IPAM 라우트 10개 → `centralTokens.js` · 죽은 export 18개 비공개화.
- 웹: `IpamSettings.jsx`(853줄) → `IpamEditors`·`IpmsSettings`·`IpScanSettings`·`IpamScanStatus` + 재수출 셸 · `VcScanRangeEditor` ·
  `ipamShared`(`LOCAL_AGENT`·`agentLabel`·`fmtDt`·`fmtDur`·`Frame`) · `VcenterChips` · `ScanRunsTable` · 죽은 export 정리 · `ipamPages.needsLedger` 실사용.
- 성능(실측, 합성 262,144 결과·vCenter 33·수집 서버 28): `currentScanDatacenters` TTL 재판정 **167ms → 0.01ms**(입력 토큰이 같으면 생략) ·
  입력 변경 시 재판정 167ms → 0.78ms(`scanResultAgents()` 카운터 — 병목은 정렬이 아니라 26만 개 전량 훑기였다) · `scanStore` 설정 mtime 캐시.

## 3. 의도적으로 합치지 않은 것

- 웹 `ipmsRangeText.js` ↔ 서버 `rangeSyntax.js`: 번들 경계 — `server/test/ipms2637.test.js` 가 같은 입력으로 대조한다.
- `rangeStore` ↔ `scanStore`: 권한 축이 다르다(vc 대역은 쓰기 범위·404 은닉, 에이전트 대역은 fleetOnly). 데이터 모델을 합치면 권한·netmap·배포 범위가 바뀐다.
- `vcRangesCsv.analyze` ↔ `scanRangesCsv.analyze`: 교체 단위(vCenter 1행 vs 대역 1행)·blocked 규칙이 다르다. 문법 검증만 공유.
- `scanDatacenter.LOCAL_AGENT` ↔ `scanStore.LOCAL`: 순수 모듈 경계. 테스트가 동일성 고정.

## 4. 검증

- 서버 `npm test` **4,418 pass / 0 fail**(226초) · 웹 vitest **192 files / 2,500 tests 통과** · eslint 0 errors · vite build OK.
- Chromium 1440/400 · admin + viewer(`AUTH_DISABLED_ROLE=viewer`) 목 스택 2대: 대역·스캔 편집기(오류 줄 → 저장 잠금·사유 · 쉼표 정규화 · 저장) ·
  IPMS ② · 정책 폼 `192.168.1.1-50` → 50개 · `10.0.0.0/8/x` → 무효 · 스캔 설정 `10.0.0.250-300` → 잠금 · 스캔 상태(viewer: ErrorBox 만) ·
  대역·스캔(viewer: 안내 + 버튼 잠금) · 목록·시트 — **pageerror 0 · 가로 넘침 0(7화면 × 2폭)**. 스크린샷 판독으로 잡은 것 2건(쉼표 뒤 공백이 줄 앞에
  남음 · 403 인데 '목록을 불러오는 중…')을 고쳐 재실행.
- 정직 기록: v2.638 보고의 '웹 2,480건 통과' 는 틀렸다(W-D3). 실장비 엣지·실제 범위 계정은 보지 못했다. `scanInfo.byAgent` 키 순서가 바뀌었다(표시 순서만).
