# 규칙 — IP 관리(IPMS·대역·스캔·원장·VM DNS)

> 루트 `CLAUDE.md` 에서 옮긴 기록(2026-10-20, v2.746 시점). 문구는 원문 그대로이고 목록 들여쓰기만 한 단계 줄였다. "되돌리지 말 것" 규칙은 그대로 유효하다 — 이 영역 코드를 고치기 전에 이 파일을 읽을 것. 새 교훈은 테스트 → 이 파일 순으로 남기고 루트 CLAUDE.md 에는 쌓지 않는다.

**언제 읽나**: server/src/{ipam,vmdns}/ · web/src/views/tools/Ipam*·Ipms*·IpScan*·VmDns*

## 목차

- (원래 4923행) v2.619 — IP 원장(ipam.db) 동기화는 '입력 지문' 이 같으면 재구성을 건너뛴다(PERF-1 — 사용자 결정 "PERF-1 진행해줘")
- (원래 5425행) IPMS 대역 문법은 `ipam/rangeSyntax.js` 하나다 — 저장도 적용도 같은 판정
- (원래 5435행) 스캔 IP 의 데이터센터 귀속은 '수동 지정 > 후보가 하나일 때만 자동' 이다 — 지어내지 않는다
- (원래 5452행) IPMS 아키텍처 정리(v2.639) — 대역 문법 판정은 서버 `ipam/rangeSyntax.js` 한 벌, vCenter 대역 편집기는 웹
- (원래 5486행) 대역·스캔의 '/24 가져오기'(v2.690) — 계산은 서버, 중복 판정은 웹(저장 안 한 입력 기준)
- (원래 5496행) v2.691 — '대역·스캔'(vCenter 별)과 'IP 스캔 설정'(에이전트별)은 하나다: 스캔 대역은 에이전트별(scanStore)만 편집한다
- (원래 5513행) v2.694 — ② 에이전트별 대역·보고 현황의 '대역 삭제'
- (원래 5517행) v2.695 — VM IP 에 DNS 서버 주소가 섞이던 결함. `guest.net` 의 `<ipAddress>` 는 세 곳에 나온다
- (원래 5524행) v2.696 — 특수 기능 'VM DNS 설정 확인'(`vm-dns`). 판정은 `server/src/vmdns/analyze.js` 하나
- (원래 5762행) v2.692 — 스캔 대역·설정 서브메뉴 2개 · /24 가져오기에 IPMS 설정 적용
- (원래 5768행) IP관리 서브메뉴(v2.636) — 설정은 대장 로딩과 무관한 페이지이고, 입력은 편집 초안에 남는다

## 본문

- ⚠⚠ **v2.619 — IP 원장(ipam.db) 동기화는 '입력 지문' 이 같으면 재구성을 건너뛴다(PERF-1 — 사용자 결정 "PERF-1 진행해줘")**
  (`store.js ledgerInputSignature`·`syncLedger` · 회귀 `server/test/perf2619.test.js` 6건 — 변이 4종 전부 검출):
  - ⚠ **감사가 제안한 '수집 시각·push 수신 시각' 토큰으로는 절감이 0 이다** — 직접 수집 vCenter 는 기본 주기(30초)마다
    전부 새로 수집되어 토큰이 매 틱 바뀐다. 그래서 **내용 기반 입력 지문**(원장이 읽는 필드만)을 쓴다. 실측(vCenter 33·
    VM 6,004·원장 8,047행): 재구성+서명 p50 48.2ms → 입력 지문 6.4ms.
  - ⚠⚠ **외부 ipam.db 리더의 신선도 계약은 바뀌지 않는다** — 원장 행 서명의 모든 열이 입력 지문의 순수 함수라, 내용이
    바뀌는 틱에는 예전처럼 곧바로 다시 쓴다(감사가 '신선도 계약에 닿는다' 고 판단을 남긴 것은 시각 토큰을 전제로 한 것이다).
  - ⚠⚠ **원장(`ipam/ledger.js buildIpamRows`)이 VM·호스트·vCenter 의 새 필드를 읽기 시작하면 `ledgerInputSignature` 에도
    더할 것** — 테스트 ② 가 스냅샷의 모든 필드를 하나씩 바꿔 '원장 서명이 바뀌면 입력 지문도 바뀐다' 를 고정하지만, 테스트
    픽스처에 없는 필드는 못 본다. 놓쳐도 `LEDGER_FULL_CHECK_MS`(기본 10분)마다 한 번은 전량 확인한다(안전망 — 지우지 말 것).
    관리 입력은 `ipamRevKey()` 리비전이 덮는다 — 새 관리 입력을 원장에 넣으면 리비전도 그 키에 더할 것.
  - 입력 지문은 **쓰기 성공 뒤에만** 기억한다(실패한 입력을 기억하면 다음 틱이 건너뛰어 재시도가 사라진다) · 늦게 끝난 옛
    쓰기는 새 기억을 덮지 않는다(`_ledgerSeq`) · 건너뛴 횟수는 `storeStatus().ledgerInputSkips`.
  - ⚠ 정직 기록: 목 데이터는 틱마다 값을 새로 만들어 목 모드에서는 생략이 일어나지 않는다 — 운영 현장의 실제 절감 비율은 재지 못했다.
- ⚠⚠ **IPMS 대역 문법은 `ipam/rangeSyntax.js` 하나다 — 저장도 적용도 같은 판정**(v2.637, 사용자 요청 "Ipms 부분 버그 잡고 ui 개선해줘".
  웹 사본 `web/src/views/tools/ipmsRangeText.js` — 번들 경계로 두 벌이고 `server/test/ipms2637.test.js` ③ 이 같은 입력으로 대조한다):
  - ⚠⚠ **빈 마스크 `10.0.0.0/` 가 /0 이었다(재현)** — 예전 `settings.js parseRange` 가 `Number('')===0` 으로 마스크 0 을 받아 무시 대역이면
    IPv4 전체가 대장에서 사라지고, 공인 대역이면 사설 주소까지 '공인' 이 됐다(`Number('')` 함정의 아홉 번째). 마스크는 1~2자리 숫자·/8~/32.
  - **저장 경로는 아무것도 검사하지 않았다** — 이제 `PUT /admin/ipam/settings`·`/ipam/vc-ranges` 가 400 + `invalid[{field,vcenterId,line,value,reason}]`
    (줄 번호는 빈 줄 포함 원래 줄). 범위 계정은 **적용되는 vCenter 목록만** 검사한다(전역 목록 변경은 어차피 `ignoredGlobal` — 검사하면 기존 계약이 깨진다).
  - 뒤바뀐 범위는 무시·분류 목록에서 **바꿔 읽고 경고**(옛 저장값이 조용히 빠지지 않게), 스캔 대역은 오류(`reversed:'error'` — `rangeSize` 가 거부한다).
  - GET 은 `invalidSaved`(검사 전 저장분)·`orphanVcenters`(삭제된 vCenter 에 남은 키 — 전체 범위만)를 싣는다. 화면 선택기가 그 키를 보여 줘야
    지울 수 있다. ⚠ JSDoc 안에 별표 두 개 + 슬래시(굵게 표기의 /0)를 쓰지 말 것 — 블록 주석이 거기서 끝난다(이번에도 밟았다).
  - 화면은 `r.reason` 을 읽는다(`putJson` 은 400 을 던지지 않고 본문을 돌려준다 — 예전 `r.error` 만 읽어 '저장 실패' 로 뭉개졌다).
- ⚠⚠ **스캔 IP 의 데이터센터 귀속은 '수동 지정 > 후보가 하나일 때만 자동' 이다 — 지어내지 않는다**(v2.638, 사용자 요청
  "scan 한 데이터를 할당 에이전트가 속한 데이터센터에 자동으로" + "agent 가 속한 idrac/vcenter 에서 사용중인 ip 대역을 /24 로 골라 추가" +
  "csv import/export". 선택: 수동 지정 + 자동 · 전체 검증. `server/src/ipam/scanDatacenter.js`(순수 판정·제안) · `scanDatacenterSource.js`
  (입력 10초 메모 — ledger 가 import) · `scanSuggestSource.js`(iDRAC 입력 — **라우트 전용**, ledger 가 iDRAC 등록부를 끌어오지 않게 나눴다) ·
  `GET /admin/ipam/scan/suggest` + 웹 `ipScanDcText.js`. 회귀 `server/test/ipScanDc2638.test.js`(변이: vCenter 조회 필터를 지우면 실패)):
  - '에이전트가 수집하는 vCenter' = 등록부 collectMode 'site' + remoteAgent(없으면 스냅샷 collectedBy), 이름은 대소문자 무시 + 수집 서버 id·name 별칭.
    이 포탈(`__local__`)은 site 가 아닌 vCenter. **비활성 vCenter 는 근거가 아니다.** 후보 = 그 vCenter 들의 DataCenter 할당 + 같은 이름 수집 서버의 datacenter(이름으로도 찾는다).
  - 후보 0·2개 이상·삭제된 수동 값(`manual-missing`)은 **귀속하지 않고** 사유·후보를 화면이 말한다. 자동으로 바꿔 채우지 말 것.
  - 대장 스캔 행에 `datacenterId`·`datacenterName`·`dcSource`·`scanAgent` + 요약 `scanByDatacenter`. **vcenterName('(네트워크 스캔)')과 ipam.db 열은 그대로**
    (외부 리더 계약 — v2.619 입력 지문도 무변경). vCenter 를 고른 조회는 **다른 데이터센터에 귀속된** 스캔 행만 뺀다(귀속 없음은 예전처럼 보인다).
    범위 계정에는 여전히 스캔 행을 주지 않는다 — 데이터센터 귀속은 vCenter 귀속이 아니다.
  - 캐시: ledger `_ipamKey` 와 `/tools/ipam` memo extraKey 에 귀속 지문(`|d…`)이 붙는다 — 빼면 저장 뒤 스냅샷 세대(30초)·TTL 동안 옛 귀속이 보인다.
    스캔 설정 저장은 `invalidateScanDatacenters()` 를 부르고 화면은 `onSaved` 로 대장을 다시 읽는다(Chromium 검증에서 **대장이 저장 전 값을 보이던 것**을 잡았다).
  - /24 제안은 스냅샷·등록부·엣지 export 마지막 사본만 읽는다(장비 왕복 0). 이름 등록 호스트·iDRAC 은 개수만(`skipped`), 상한 1,024 는 `omitted`.
    '이미 입력됨' 판정은 **저장하지 않은 입력** 기준이라 웹이 한다(대역 문법은 `ipmsRangeText.js` 하나).
  - ⚠ 정직 기록: 실제 엣지(에이전트 이름 ≠ 수집 서버 id 인 현장)로는 확인하지 못했다 — 목 스택에 등록부를 심어 확인했다.

- ⚠⚠ **IPMS 아키텍처 정리(v2.639) — 대역 문법 판정은 서버 `ipam/rangeSyntax.js` 한 벌, vCenter 대역 편집기는 웹
  `VcScanRangeEditor.jsx` 한 벌**(사용자 요청 "ipms 부분 아키텍처 리뷰해서 통합할 수 있는 부분 통합하고 개선" · 선택 전체 + 전체 검증.
  조사 에이전트 2 → 수정 3그룹 병렬. 회귀 `server/test/ipms2639.test.js`·`ipamStore2639.test.js` + 웹 `ipamRanges2639.test.js` — 변이 검증
  A1 3/3·A2 7/7. 상세 `docs/AUDIT-2026-09-28-ipms.md`):
  - ⚠⚠ **판정기가 네 벌이었다** — `rangeSyntax.checkRangeSpec`(v2.637 엄격) · `scan.js rangeSize`·`expandRange` · `rangePolicies.specToRange`.
    화면 PUT 만 엄격 판정을 쓰고 **CSV 가져오기 2종·`PUT /ipam/scan/settings`** 는 느슨한 `rangeSize` 라 `10.0.0.0/8/x`·`10.0.0.250-300`
    (실제로 10.0.1.x 를 스캔)·`/24.5`(180개) 를 저장했다(재현). v2.637 "저장도 적용도 같은 판정" 의 누락. 이제 셋은 `checkRangeSpec` 위의
    어댑터다 — **의미는 유지**(CIDR 네트워크·브로드캐스트 제외 `/24`=254, 정책 lo+1/hi−1, RANGE_CAP 루프 상한). ⚠ `checkRangeSpec.size` 는
    256 이라 두 크기가 다른 것은 의도다(테스트가 둘 다 고정). **새 대역 입력 경로는 `checkRangeList(…, {reversed:'error', scanCap:RANGE_CAP})`
    를 쓰고 `ipms2639.test.js` ① 의 여섯 경로 대조에 더할 것.** 옛 저장값 중 이제 무효인 줄은 `GET /tools/ipam/vc-ranges` 가 `invalid` 로 밝힌다.
  - **웹 사본 파서 `IpamNet.rangeSpecSize` 는 `>>> 0` 이 빠져 `192.168.1.1-50` 이 음수 → 정책 폼 저장 잠금**이었다(서버는 고쳐진 버그의
    화면 사본). `ipmsRangeText.policySpecSize`(specToRange 뜻) 하나로. **서버에서 고친 파서 버그는 웹 사본에도 있는지 grep 할 것.**
  - **편집기 두 곳**(`IpamNet.IpamRanges` 원시 textarea vs `IpmsSettings` ②)을 `VcScanRangeEditor` 로 — 초안 키는 페이지별
    (`ranges:vc:<id>` / `ipms:vcscan:<id>`, `ipamDraft.pageOfKey` 규칙) · `access==='no'` 면 쓰기 버튼 잠금 + 사유(모름은 잠그지 않는다 — 서버가
    집행) · 쉼표 입력은 `normalizeRangeText`(줄 앞 공백까지 제거 — 남기면 들여쓴 줄처럼 보인다, Chromium 판독) · 저장 중 vCenter 를 바꾸면 늦은
    응답이 새 vCenter 초안을 '저장됨' 으로 만들지 않는다. `vcRangesGate`·`RangeCheck`·`SCAN_CAP` 는 이 파일이 소유한다(IpmsSettings↔Editor 순환 회피).
  - **`IpScanSettings.runNow` 가 저장 400 을 무시하고 스캔을 시작하며 '입력한 대역 N개 스캔' 이라 말했다** — `putJson` 은 400 본문을 돌려준다
    (`api.js:299`). `sv.ok===false` 면 시작하지 않는다. 에이전트 대역 칸도 `checkRangeList` + 잠금.
  - **`IpamSettings.jsx`(853줄) → `IpamEditors`·`IpmsSettings`·`IpScanSettings`·`IpamScanStatus` 4파일 + 재수출 셸.** 소스를 grep 하는 테스트
    (`audit2605e`·`audit2621e`·`audit2622f`·`audit2613b`·`audit2631c`·`ipmsRangeText.test`·`ipamSubmenu2636`)는 새 경로로 옮겼다 —
    **화면 파일을 나누면 그 파일을 읽는 서버·웹 테스트 경로를 함께 grep 할 것**(`webSrc('views/tools/IpamSettings.jsx')` 가 서버 테스트에도 있었다).
  - 서버 위생: `rangeStore.write` 실패를 `{ok:true}` 로 보고하던 것 → throw(캐시는 성공 뒤에만) · `scanLog` 손상 보존(`arch2582` allowlist 에서
    뺌) · vCenter 이름 해석기 2벌(vc-ranges CSV 는 **이름 겹치면 첫 항목** — 다른 vCenter 대역을 덮었다) → `ipam/vcResolve.js makeVcResolver`
    (모호하면 null + candidates) · `settings.invalidEntries` 한 벌 · `_ipamKey` 가 `ipamRevKey()` 재사용(키 문자열 불변) · `scanStore` 설정 파일
    (mtime,size) 캐시(디바운스 저장소 밖이라 안전 — CFG 의 쓰기 경로는 `saveAll` 뿐) · `scanDatacenterSource` 는 입력 토큰(파일 stat + scanRev)이
    같으면 재판정 생략 — 실측 26만 결과에서 **167ms → 0.01ms**(병목은 정렬이 아니라 26만 개 전량 훑기였다 → `scanResultAgents()` 카운터).
  - **라우트 분리**: `centralIpam.js` 의 비-IPAM 10개(중앙 토큰 3·개별 토큰 3·인벤토리 2·수신 통계 2) → `routes/admin/centralTokens.js`(본문·
    게이트 불변). `collectorSetPasswordGuard`·`audit2599b` 가 그 파일을 마운트/grep 한다.
  - **의도적으로 합치지 않은 것**: 웹 `ipmsRangeText.js` ↔ 서버 `rangeSyntax.js`(번들 경계 — `ipms2637.test.js` 가 대조) · `rangeStore` ↔
    `scanStore` 데이터 모델(권한 축이 다르다 — vc 대역은 쓰기 범위·404, 에이전트 대역은 fleetOnly) · CSV 2종의 analyze(교체 단위·blocked 규칙이
    다르다) · `scanDatacenter.LOCAL_AGENT` ↔ `scanStore.LOCAL`(순수 모듈 경계 — 테스트가 동일성 고정).
  - ⚠ **정직 기록**: v2.638 보고의 '웹 2,480건 통과' 는 **틀렸다** — `ipamSubmenu2636.test.js:221` 이 그 커밋에서 깨져 있었다(`onSaved` prop 추가를
    테스트가 못 받음). 이번에 고쳤다. 전량 테스트 결과를 보고할 때 **실패 수를 파일에서 grep 해** 적을 것(이번엔 `# fail 0` 을 파일로 확인).
    `scanInfo.byAgent` 키 순서가 IP 순에서 적재 순으로 바뀌었다(화면은 entries 를 join — 표시 순서만). 실장비 엣지·범위 계정 화면은 목 스택으로만 봤다.
- **대역·스캔의 '/24 가져오기'(v2.690) — 계산은 서버, 중복 판정은 웹(저장 안 한 입력 기준)**(`server/src/ipam/vcRangeSuggest.js` +
  `GET /admin/ipam/vc-ranges/suggest?kind=idrac|vm` + 웹 `VcRangeImportModal.jsx`·`vcRangeImportText.js`, 사용자 요청 "선택한 DataCenter 의 iDRAC
  scan 대역과 vCenter VM 대역을 /24 로 · 버튼 2개 · 추가 전에 확인 창 · 중복은 작은 칸에서 고쳐서 반영". 회귀 `server/test/vcRangeImport2690.test.js` + 웹
  `vcRangeImportText.test.js` — 변이 3/3):
  · iDRAC 스캔 대역은 vCenter 가 아니라 **DataCenter 단위**다 — 기본은 그 vCenter 의 DataCenter(`datacenterOfVcenter`), 할당이 없으면 비워 두고 고르게 한다(임의로 고르지 않는다).
    꺼진 스캔 엔트리도 '입력한 대역' 이라 넣고 표시한다. 범위 계정은 iDRAC 쪽 403(전 법인 설정), VM 쪽은 범위 안 vCenter 만(밖은 404).
  · VM 주소는 IPv4 만, 루프백·169.254·0/8·멀티캐스트·예약은 빼고 **개수를 밝힌다**. 사설 대역(172.17 등)은 임의로 빼지 않는다 — 확인 창의 VM 수를 보고 사람이 해제한다.
  · 상태 넷: new / covered(이 칸에 이미) / partial(이 칸 다른 줄과 일부) / other(다른 vCenter 저장분과 겹침). new 만 텍스트 박스에, 나머지는 '중복 대역' 칸에 —
    '반영' 은 다시 판정해 겹치지 않는 줄만 옮긴다. 추가 직전에도 다시 판정한다(창을 연 뒤 텍스트를 고쳤을 수 있다). 문법·포함 판정은 `ipScanDcText.coverageOf` 한 벌.
  · ⚠ 확인 창 표에 '근거' 를 별도 열로 두지 말 것 — 400px 에서 그 열이 밀려 행 높이가 수백 px 가 됐다(Chromium 판독). 상태 칸 아래 작은 줄로 둔다.
- ⚠⚠ **v2.691 — '대역·스캔'(vCenter 별)과 'IP 스캔 설정'(에이전트별)은 하나다: 스캔 대역은 에이전트별(scanStore)만 편집한다**
  (`server/src/ipam/vcRangeMigrate.js` + 라우트 `/admin/ipam/scan/{import,owners,migration[/move|/remove|/dismiss]}` + 웹
  `IpScanSettings.jsx`·`ScanRangeImportModal.jsx`·`ScanRangeMigration.jsx`·`scanRangeImportText.js`, 사용자 요청 "두 기능을 합치고 IP 스캔 화면으로 ·
  iDRAC 대역은 서비스별 1,2,3… 번호 · 이름 없으면 '이름 없음' · 서비스 하나를 골라 불러오기" + 선택 '수집하는 에이전트로 자동 이전'·'단계로 나눠 릴리스'(1차).
  회귀 `server/test/ipScanUnify2691.test.js` + 웹 `scanRangeImportText.test.js`):
  · 1회 이전(상태 파일 `ipam-vcrange-migration.json` · 원본 백업 `ipam-vcenter-ranges.json.pre-v2.691-<ts>.bak`): 중앙 직접 → `__local__`,
    엣지 위임 → remoteAgent 또는 스냅샷 collectedBy(기존 스캔 에이전트 이름의 대소문자로). **담당을 모르면 옮기지 않는다**(no-agent) ·
    삭제·비활성 vCenter·꺼진 대역(range-off — 켜면 동작이 바뀐다)도 남긴다. 남은 켜진 대역은 예전처럼 `enabledVcRanges()` 로 중앙이 계속 스캔한다
    (조용한 손실 없음) — 화면 안내에서 옮기거나 지운다. 옮긴 에이전트가 꺼져 있었으면 켠다(`enabledAgent` 기록). 스냅샷 첫 병합 전에는 기다린다(최대 15분).
  · ⚠ **동작 변화**: 엣지 법인 대역은 이제 그 엣지가 스캔한다(예전엔 중앙). 문법 오류 줄은 옮기지 않고 기록에 남긴다.
  · iDRAC 가져오기는 서비스(엔트리)마다 `idracSubnets({entries:[e]})` 를 따로 부른다 — 합쳐서 계산하지 말 것(서비스 하나를 고르는 요구).
    DataCenter 기본값은 `scanDatacenterOf(agent)` — 판정 불가(여러 DataCenter)면 비워 두고 고르게 한다(지어내지 않는다).
  · 중복 판정은 v2.690 `vcRangeImportText` 한 벌이고 '다른 쪽' 은 `/scan/owners`(다른 에이전트 + 남은 vCenter 대역, `ownersToSaved` 가 지금 에이전트를 뺀다).
  · ⚠ 옛 해시 `#/ipam/ranges` 는 `IPAM_PAGE_ALIASES` 로 옮기고 **옮기기 전 한 번의 렌더도 새 키로 그린다**(`view = ALIASES[hashView] || hashView`) —
    옛 키로 그리면 분기가 대장 목록으로 떨어져 `data.rows` 를 읽고 화면이 죽었다(Chromium 에서 실제로).
  · 남긴 것(2차 후보): `VcScanRangeEditor` 컴포넌트·`VcRangeImportModal` 은 더 그리지 않는다(RangeCheck 등 export 만 쓰인다) · vc-ranges API 는 호환으로 남김 ·
    netmap 은 `migratedRangesFor` 로 옮긴 대역을 그 vCenter 의 /24 목록에 계속 넣는다.
- **v2.694 — ② 에이전트별 대역·보고 현황의 '대역 삭제'**(`POST /admin/ipam/scan/agent/delete` + `scanStore.deleteScanAgent` + 웹 `IpScanSettings.jsx`·
  `scanRangeImportText.agentDeleteConfirmText`, 회귀 `server/test/ipScanAgentDelete2694.test.js` — 변이 3/3): mode `ranges`(대역만 — 포트·주기·켜짐 유지) /
  `agent`(설정 항목 + 마지막 보고 기록 — 대소문자 무시, 이 포탈은 400). 화면이 본 목록(`expect`)과 다르면 409 · **이미 보고된 스캔 결과는 지우지 않는다**
  (관리상태 붙은 IP 까지 지우지 않게 — 보존 기간·해제 판정이 정리, 응답 `resultsKept`) · 지운 에이전트의 편집 초안도 지운다 · 감사·스캔 로그.
- ⚠⚠ **v2.695 — VM IP 에 DNS 서버 주소가 섞이던 결함. `guest.net` 의 `<ipAddress>` 는 세 곳에 나온다**(`vcenter/soapClient.js extractIPv4s`·`vmDns`·
  `stripXmlBlocks` + 중앙 `central/vmDnsSanitize.js`, 사용자 신고 IP 대장 `8.8.8.8 충돌·중복·멀티홈` 7행. 회귀 `server/test/vmDns2695.test.js` — 변이 2/2):
  · GuestNicInfo 의 직계 `<ipAddress>`(NIC IP) · `<ipConfig><ipAddress><ipAddress>`(같은 IP + 접두) · **`<dnsConfig><ipAddress>`(그 VM 이 쓰는 DNS 서버)**.
    위치를 가리지 않는 정규식이 셋째까지 읽어 DNS 서버가 그 DNS 를 쓰는 VM 전부의 IP 가 됐다(IP 대장 거짓 충돌 · GPU 게스트 SSH 후보 IP 까지).
    이제 `dnsConfig` 블록을 먼저 지우고 읽는다(indexOf 선형 — 닫는 태그가 없으면 그 뒤를 IP 로 읽지 않는다).
  · DNS 는 같은 응답에서 `vm.dns = {servers, stack, nics}`(스택 먼저 합집합, 각 8개 상한)로 따로 싣는다 — **vCenter 왕복 0**. 보고 없음은 null(모름).
    엣지 수신은 `sanitizeVmDns`(아는 모양만). ⚠ 엣지 위임 vCenter 는 **엣지가 VM IP 를 읽어 보내므로** 엣지 2.695 이후에야 바로잡힌다.
- ⚠⚠ **v2.696 — 특수 기능 'VM DNS 설정 확인'(`vm-dns`). 판정은 `server/src/vmdns/analyze.js` 하나**(+ `policy.js`·`probe.js`·`db.js`·`poller.js` ·
  `routes/api/vmDns.js` · 웹 `views/tools/VmDnsTool.jsx`·`vmDnsText.js`. 사용자 승인 시안 https://claude.ai/artifact/Wu69JoFtDDVrUBJAZujwHi .
  회귀 `server/test/vmDns2696.test.js`(변이 10/10) + 웹 `vmDnsText.test.js`·`vmDnsRender.test.jsx`):
  · VM DNS 는 세 상태다 — reported / **unknown**(`dns:null`, Tools 미보고) / **notCollected**(`'dns' in vm === false` — 2.695 이전 엣지·REST 폴백). 뒤 둘을 정상·0 에 넣지 않는다.
  · 서버 주소 목록은 OS 스택 값이 먼저(없으면 NIC 합집합). 정책 판정 순서: 그 법인 목록에 맞으면 approved(명시 승인 우선) → `kind:'public'` 이고
    publicUnapproved 면 unapproved → 목록이 비면 none(판정 안 함). `vcenters[].unapprovedVms` 는 vCenter 필터 밖이면 **null**(0 아님).
  · 정책 항목은 정규형 IPv4·네트워크 경계 CIDR(/8~/32)만, 안쪽 빈 칸 거부 — 웹 `checkPolicyEntry` 와 같은 판정(테스트가 28개 입력으로 대조).
  · 도달성 점검은 버튼으로만, 대상은 스냅샷에서 계산한 주소(요청 본문의 주소를 받지 않는다) · 엣지 법인만 쓰는 주소는 `edge-only` · 목 vCenter 만 쓰는 주소는 `mock` 건너뜀.
  · 포탈 스냅샷 전원 표기는 `POWERED_ON`(밑줄)이다 — vSphere 원문 `poweredOn` 만 비교하면 전원 칸이 전부 '—' 가 된다(v2.696 Chromium 검증에서 잡았다).
- **v2.692 — 스캔 대역·설정 서브메뉴 2개 · /24 가져오기에 IPMS 설정 적용**(`ipam/scanRangeRows.js`·`vcRangeSuggest.annotateSubnets`·`settings.ignoreRanges` +
  `GET /admin/ipam/scan/ranges`·`POST /admin/ipam/scan/ranges/line` + 웹 `ScanRangeList.jsx`·`scanRangeImportText.js`, 회귀 `server/test/ipScanRanges2692.test.js` + 웹 `scanRanges2692.test.js`, 변이 3/3):
  · ① 등록된 스캔 대역 = 대역 1줄 = 1행(사용자 선택). 수정·삭제·추가는 **그 한 줄만** 저장하고 `old` 가 지금 값과 다르면 409(다른 관리자가 바꿨다). 가져오기는 그 에이전트의 ② 편집기에서 연다(겹침 판정·중복 칸 사본 금지).
  · ② = 예전 '에이전트별 스캔 대역' + '에이전트별 보고 현황' 한 표 + 설정 편집기. 보고 상태는 정상·늦음(90분)·꺼짐·대기 — 꺼짐·대기를 늦음으로 세지 않는다. 주소 `#/ipam/scan/<ranges|agents>`.
  · 무시 대역 제외는 **호스트 주소(.1~.254)가 전부** 무시 대역에 들 때만이고(그 IP 는 대장에서 숨겨진다) 일부만 걸치면 남기고 표시한다. 출처: 전체 + VM 은 고른 vCenter, iDRAC 은 그 DataCenter 에 할당된 vCenter(iDRAC 대역에 vCenter 축이 없다).
  · 공인/사설은 대장과 같은 분류기(`getClassifier().num`) — /24 안에서 갈리면 'mixed'. 공인 /24 는 기본 체크 해제(빼지는 않는다). 분류 키는 웹 `CLS_LABEL` 과 1:1.
- ⚠⚠ **IP관리 서브메뉴(v2.636) — 설정은 대장 로딩과 무관한 페이지이고, 입력은 편집 초안에 남는다**
  (`web/src/views/tools/`{ipamPages.js·ipamDraft.js·useIpamDraft.js·IpamDraftBanner.jsx·IpamCsv.jsx·IpamScanLog.jsx·ipamCsvChunk.js·
  ipamCsvText.js·ipamScanLogText.js} + 서버 `ipam/`{scanLog.js·manageCsv.js·scanRangesCsv.js}, 사용자 요청 "IP scan 을 위한 입력/수정이
  많고 복잡해서 별도의 화면 · KPI 아래에 sub menu · IPMS 설정·추천 30선·대용량 CSV·스캔 상태를 각각의 페이지로 · 편집하다가 없어지는 일이
  없도록" + "sub menu 에 scan 상태, 로그". 선택: 기존 보기 버튼까지 전부 · CSV 는 IP 관리상태 + 스캔 대역 · 스캔 실행 로그를 새로 기록.
  회귀 `server/test/ipamSubmenu2636.test.js`(변이 2종 검출) + 웹 `ipamSubmenu2636.test.js`):
  - ⚠⚠ **편집 유실의 원인(코드로 확인)**: IPMS 설정·IP 스캔·스캔 상태는 대장 화면 **안의 모달**이었고 대장 화면은 `if (loading) return
    <Loading />` 였다. `useTool` 은 파라미터(범위·재조회 카운터)가 바뀔 때마다 loading 을 true 로 돌리므로 범위 칩 클릭·관리상태 저장 뒤
    재조회가 모달을 **언마운트**했다. **대장 화면에 조기 return 을 되살리지 말 것** — 목록·대역 정책만 `ledgerWait` 로 기다리고, 재조회 중에는
    같은 범위의 직전 값을 보여 준다(다른 범위의 값은 섞지 않는다). 웹 테스트가 조기 return 0 을 고정한다.
  - **해시 키는 페이지 전부**(`IPAM_PAGE_KEYS`) — 예전 `valid:['list','sheet']` 라 '추천 기능 30선' 등을 누르면 해시가 바뀌는 순간
    hashchange 가 목록으로 되돌렸다(기존 결함). **새 페이지는 `ipamPages.js` 에 더할 것.** 관리자 페이지는 `/admin/ipam/settings` 가
    **403 일 때만** 숨긴다(네트워크 오류 = 'unknown' 이면 보여 주고 서버가 집행한다 — '모름' 을 '없음' 으로 읽지 않는다).
  - **편집 초안**(`ipamDraft.js`): 메모리 + sessionStorage(try/catch — 못 쓰면 메모리만, `volatile` 로 밝힌다 · 512KB 넘는 초안도 메모리만).
    초안에 **편집을 시작한 시점의 서버 값(base)** 을 둬서 돌아왔을 때 서버 값이 바뀌었으면 말한다(조용히 덮어쓰면 다른 관리자 변경을 지운다).
    값이 서버 값과 같아지면 초안을 지운다. 키 `<페이지>:<세부>` — 에이전트·vCenter 마다 따로(`scan:<agent>`·`ipms:vcscan:<vc>`)라 대상을
    바꿔도 다른 대상 값이 새 대상에 남지 않는다(v2.622 WEB-08 과 같은 판단). 탭을 닫을 때 `beforeunload` 경고.
    ⚠ 저장 성공 뒤에는 **`d.saved(서버가 돌려준 값)`** — 서버가 정리한 값(빈 줄 제거)과 폼 값이 달라 초안이 남는 것을 막는다.
    ⚠ 전역 `.input { min-width: 220px }` 이 페이지로 옮긴 2열 폼을 400px 에서 24px 밀어냈다 — `.ipam-page .input` 에서만 푼다.
  - **CSV 조각 분할은 서버 파서와 글자 그대로 같은 행 경계**(`ipamCsvChunk.splitCsvRecords` ↔ `server/src/util/csv.js parseCsvRows`) —
    서버가 조각마다 `_line = lineOffset + n + 2` 로 행 번호를 매기므로 어긋나면 결과표가 **엉뚱한 줄**을 지목한다. 웹 테스트가 서버 파서를
    import 해 칸·행 번호를 대조한다(인용 안 줄바꿈·CRLF·BOM·빈 행·탭 구분). 조각을 넘는 같은 IP 는 서버가 못 보므로 화면이 뒤 행을 오류로 바꾸고
    적용 때 그 행을 **주석 행**(ip 칸 `#`)으로 바꿔 보낸다 — 행을 빼면 뒤 행 번호가 밀린다.
  - **관리상태 CSV 판정 규칙**(`manageCsv.js`): 헤더에 있는 열만 바꾼다 · 빈 칸 = 지움 · 모르는 상태·디바이스·날짜·길이 초과는 **오류**
    (저장 함수 `overrides.clean` 은 모르는 상태를 빈 값으로 **조용히 지운다** — 그 경로를 타면 오타 하나가 기존 상태를 지운다) · 파일에 없는 IP 는
    건드리지 않는다 · 범위는 단건·일괄과 같은 `ipOverrideWriteVerdict` · 적용은 서버가 **다시 판정** · 쓰기는 `setOverridesMany`·
    `setAnnotationsMany` 로 파일 1회(행마다 원자 쓰기 금지 — 1만 행이면 1만 번 fsync).
  - **스캔 대역 CSV**: 교체는 파일에 나온 에이전트만 · 오류 줄이 하나라도 있는 에이전트는 통째로 막는다(교체에서 오류 줄만 빼면 그 대역이 조용히 지워진다).
  - **스캔 로그**(`ipam/scanLog.js`, `ipam-scan-log.json`, `IPAM_SCAN_LOG_MAX` 기본 1,000): 연속 같은 사유의 skip·reject 는 한 줄로 합친다
    (비이벤트가 상한을 소진하지 않게 — v2.517 규약). activityLog 와 같은 링버퍼라 손상이면 새로 시작한다(arch2582 allowlist 에 사유).
    못 읽은 수치는 null. 게이트는 형제 status 와 같은 adminOnly + fleetOnly. **새 스캔 경로(엣지 보고·수동 실행)를 만들면 여기에도 기록할 것.**
  - ⚠ 정직 기록: 실제 엣지 에이전트의 스캔 보고 로그는 테스트 라우터로만 확인했다 · 브라우저 검증은 목 데이터(관리자·AUTH_DISABLED_ROLE=viewer)로
    했다 — viewer 서버에서도 웹 `hasRole` 은 admin 으로 보여 'CSV 가져오기는 운영자·관리자만' 안내는 화면으로 보지 못했다(서버 403 은 테스트로 고정).

