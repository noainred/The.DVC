# 설계: 헤더 ⌘K 검색 — 등록된 모든 인벤토리의 장비 찾기(통합 장비 검색)

작성 2026-11-05 (v2.898.0 · main 2d39b16 기준) · 상태 **구현 완료(v2.909.0 · §7)** · 시안 캔버스: https://claude.ai/artifact/HCcyuoSPeN8mpW595MjNnJ
(아트보드 6장 — 이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스. 장비 이름 · 법인 · IP · 시리얼 · 사람은 전부 가상이고 색 · 글자는 `web/src/styles.css` `:root` 토큰 그대로.
개수 중 vCenter 28 · 호스트 658 · VM 5,850 은 루트 CLAUDE.md 의 운영 수치이고, 그 밖의 종류별 개수(스토리지 41 · SAN 36 · 네트워크 128 · PDU 22 · IP 대장 9,412 …)는 **그림용 가상값**이다.
계정의 ‘Design System’ 아티팩트는 앞 시안들(`docs/design/wiki-mention`)과 같이 내용이 비어 있어 쓰지 않았다.)

## 1. 요구(사용자 2026-11-05)

> "상단 위에 있는 검색창에 VM 베어메탈 스토리지 등등 등록된 모든 인벤토리에 있는 장비 검색할 수 있는 기능 추가해줘, 클로드 코드로 시안 만들어서 보여줘"

- 규칙: 설계는 Fable + Claude Design 시안 → 컨펌 뒤 Opus 구현(2026-11-03 ‘기억해’).

## 2. 지금 코드에서 확인한 것(설계의 근거)

| 사실 | 위치 |
|---|---|
| 헤더 검색창(⌘K)은 **기능(특수 기능 도구)과 탭만** 찾는다. 문구가 그것을 약속하고(‘기능 · 탭 찾기’), 주석이 ‘VM 이름 검색은 Platform 탭의 검색창이다 — 여기서 약속하지 않는다’ 고 적고 있다 | `views/headerText.js:21-23` · `components/Palette.jsx` · `palette.js` |
| 팔레트 매칭은 카드 그리드와 같은 모듈 — 라벨 앞글자 › 포함 › 키 › 별칭(aka) › 분류 › 설명. 묶음별 상한 6 + **잘라낸 개수를 화면에 밝힌다**(조용히 자르지 않는 규약) | `views/toolSearch.js matchScore` · `palette.js search` |
| 팔레트는 순수 모듈(`palette.js`, node 테스트) + 컴포넌트(입력 · 커서 · 키)로 나뉘어 있고, 숨김/잠금 판정은 `toolVisibility.js`(카드 그리드 · 내비 트리와 같은 함수) | `Palette.jsx` 머리말 · `docs/rules/web.md` |
| 검색 버튼은 420px(`.tb-cmdk`), 400px 미만은 아이콘만 · 팔레트 `max-width: 640px` · 상단 10vh | `styles.css:130-157` · `App.jsx:702` |
| **시리얼 통합 색인이 이미 있다** — 서버(iDRAC) 섀시 · 부품(PSU · 디스크 · DIMM · NIC · 팬) · OME · ESXi 서비스 태그 · 스토리지(어레이 · 어플라이언스) · SAN 스위치(섀시 · WWN · PSU · SFP) · 엣지 베어메탈. 30초 캐시 1개 · `normKey`(대소문자 · `:` `-` 공백 `.` 무시) · 완전 일치 우선 · **출처별 try**(한 출처가 죽어도 나머지는 산다 · `sources` 로 밝힘) · `?refresh` 는 10초 스로틀 | `insights/serialLookup.js` |
| 시리얼 조회 라우트는 **전체 범위 계정만**(`fullScopeOnly`) + `tools` 권한, 비관리자에겐 관리 주소 · 주소로 떨어진 이름을 가린다(`maskSerialRow`) | `routes/api/serialLookup.js` |
| 심층 검색은 검색어 소문자화를 **루프 밖 1회** · 상한 1024자(넘으면 아무것도 맞지 않음 — 잘라서 넓게 맞추지 않는다). 900KB 검색어 하나로 이벤트 루프 3초가 막혔던 감사 사례 | `search/deepSearch.js lowerTerm` |
| vCenter 스냅샷 `store.get()` = `vcenters · hosts · vms · datastores · networks · alarms`. VM 에 `name · guestOS · ipAddresses[] · host · cluster · powerState · template · vcenterId`, 호스트에 `name · serviceTag · model · vendor · cluster` | `store.js:708-744` · `serialLookup.js` 3) |
| 인벤토리 조회 권한 `inv.hosts · inv.vms · inv.datastores · inv.networks · inv.nsx · inv.alarms` 는 서버가 집행(v2.536) — 키는 `App.jsx` 탭 `perm` 과 글자 그대로 같다 | `routes/api/inventory.js` 머리말 · `auth/permissions.js:29-34` |
| **범위**: 조회 라우트는 예외 없이 `scopedVcenterIds` 교집합 · 단건은 범위 밖 **404**(존재 은닉) · **vCenter 귀속 없는 데이터(스캔 발견물 · 미귀속 override · 스토리지 · SAN …)는 범위 계정에 노출하지 않는다** · memo 캐시는 `scopeKey` 필수 | `server/CLAUDE.md` · `auth/scope.js` |
| 도구 접근은 `tools` 권한 + `toolAllowed(key)`(`auth/toolAccess.js` 집행 매핑). 카탈로그 `adminOnly` 는 표시 관례이지 접근제어가 아니다 | `docs/rules/web.md` · `toolVisibility.js lockReasonOf` |
| 비관리자(operator · 데모 계정)에게 스토리지 · SAN · PDU 의 관리 주소 · 계정명을 가린다 — 판정은 `isAdminDetailUser` 하나 | `auth/addressMask.js` · `auth/demoGuest.js:128` |
| 장비 등록부 — 스토리지 `{id,type,name,host,agent,datacenterId}` · SAN 스위치(같은 꼴) · CVP 서버 `{id,name,host,agent,datacenterId}`(스위치는 수집 스냅샷) · PDU · GPU 물리 서버 `{id,name,host,vcenterId}` · NSX 매니저 · iDRAC 등록부(+ 위임 법인 원격 인벤토리 병합 `analysisServersWithRemote` · 범위 판정 `analysisScope.serverInScope`) · OME `allOmeDevices` · 엣지 fleet `getEdgeFleetServers` | `storage/registry.js` · `sanswitch/registry.js` · `cvp/registry.js` · `pdu/registry.js` · `gpu/physicalRegistry.js` · `nsx/registry.js` · `insights/analysisServers.js` · `central/fleet.js` |
| IP 대장은 VM · 호스트 · 스캔 발견 · 수동 등록(`DEVICE_TYPES` 12종) · 오버라이드(예약 등)를 한 표로 만든다 — ‘IP → 무엇’ 의 단일 출처 | `ipam/ledger.js buildIpamRowsShared` · `ipam/overrides.js:32` |
| **이동 주소(딥링크) 현황**: 호스트 상세 `#/hosts/<id>` 는 있다(v2.805). VM 상세는 목록에서 여는 **모달**(`EntityDetail`)이라 해시가 없다. 스토리지 모니터링 · SAN · PDU · CVP · 서버 분석 · GPU 화면은 `?focus=` 류 파라미터를 **읽지 않는다**(`URLSearchParams` 를 읽는 화면: IpamNet · SanPortUsage · StoragePaths · 백업 몇 곳뿐) | `views/Hosts.jsx:19` · `views/Vms.jsx:201` · `grep URLSearchParams web/src` |
| 상단 탭 id: `overview · summary · vcenters(Platform) · svcmon · hosts · vms · datastores · networks · ipam · alarms · tools · board · issues · wiki · settings · upgrade` | `App.jsx:54-81` |
| 도구 키(`#/tools/<k>`)는 바꾸지 않는다 — 권한 파일 값이자 집행 매핑. 새 주소는 **쿼리만** 더한다 | 루트 CLAUDE.md ‘프론트엔드 회귀 방지’ |

## 3. 화면(IA) — 아트보드 6장

```
① Main     헤더 검색창 포커스 → 팔레트(640→760px) · ‘srv-db’ → 종류 칩(개수) + 묶음(가상머신 · VM호스트 · 베어메탈 · 스토리지 · 네트워크 · IP 대장 · 기능·탭)
           행 = 종류 태그 · 이름(일치 강조) · 법인 · IP · 모델/OS · 상태 · 목적 화면 — 묶음별 5건 + ‘N개 더 보기’ · 푸터(키 · 표시/숨김 수 · 색인 시각 · 출처 n/n)
② Empty    빈 입력 — 찾는 범위(종류별 색인 개수 · 출처 상태 · 못 읽은 엣지) · 접두 안내(vm: host: ds: bm: st: san: net: pdu: ip: sn: vc:) · 최근 연 항목(브라우저)
③ Prefix   ip:10.20.1.  → IP 대장 + 그 주소를 가진 VM · 호스트 · 베어메탈(iDRAC) · 스토리지 관리 주소 / sn:7hx2k9 → 호스트 · 베어메탈 · 서버 부품 · SAN SFP(시리얼 색인 그대로)
④ Landing  Enter → 가상머신 탭 + 기존 EntityDetail 모달 · 주소 #/vms?focus=<id> · ‘검색에서 이동’ 토스트 · 목록 필터는 그대로
⑤ States   ⓐ 범위 계정(귀속 없는 종류 칩 잠금 · 범위 밖 개수도 비노출) ⓑ 비관리자(관리 주소 가림 → ip: 제외) ⓒ 출처 일부 실패 띠 ⓓ 결과 없음 + 다른 찾기로 넘김
           ⓔ 너무 많음(종류별 5 · 전체 60 · 잘린 수 표시) ⓕ 색인 못 읽음(503 — 기능·탭은 계속) ⓖ 1자 입력 ⓗ 데모 계정 ⓘ 키보드
⑥ Narrow   400px — 헤더는 아이콘만 · 팔레트 전폭 · 칩 가로 스크롤 · 행 2줄(이름 / 메타) · 터치 44px
```

## 4. 설계 결정(시안에 그대로 그린 것)

### 4.1 색인(서버) — 시리얼 색인과 같은 꼴, 한 벌 더
- `server/src/search/inventoryIndex.js`(새): 출처를 돌며 **행 하나 = 장비 하나** `{ kind, id, name, hostname, ips[], keys[](시리얼·태그·WWN 정규화), model, vendor, vcenterId, datacenterId, agent, status, sub(클러스터·OS·버전), to(이동 주소) }`.
  종류(kind) 11: `vm · host · datastore · network · vcenter · baremetal(iDRAC · OME · 엣지 fleet) · gpu-server · storage · sanswitch · netswitch(CVP) · pdu · ip(IP 대장)`.
  `sn:` 은 **기존 시리얼 색인의 장비 행**(`server · ome · esxi · storage · sanswitch · bm-edge`)을 그대로 쓴다 — 부품 · SFP(`server-part` · `sanswitch-part`)는 개수만 세어 ‘시리얼 조회에서 보기’ 로 넘긴다(결정 5).
- 캐시 1개 · TTL 30초 · 강제 재생성 10초 스로틀(시리얼과 같은 상수 사용). **요청이 있을 때만** 만든다(폴링 없음). 출처별 try + `sources{kind:{rows,error}}` — 한 출처가 죽어도 나머지는 찾고 빠진 출처를 응답에 싣는다(⑤ⓒ).
- 크기(추정 — 구현 때 실측): VM 5,850 + 호스트 658 + DS · 네트워크 수백 + 장비 등록부 수백 + IP 대장 ~1만 → **2만 행 안팎**. 행당 소문자 키를 색인 때 1회 만들어 두고 요청은 `includes` 선형 스캔(정규식 없음 · 검색어 소문자화 1회 · 상한 256자 · 넘으면 아무것도 맞지 않음).
  만드는 시간이 수백 ms 를 넘으면 `createYielder` 로 조각낸다(요청 경로 양보 규약). 첫 요청은 만들어질 때까지 기다리되 화면은 ‘색인 만드는 중…’ 을 적고 기능 · 탭은 바로 보여 준다(⑤ⓕ 의 시간 초과 판본).

### 4.2 API 와 문지기 — 범위 · 권한 · 가림은 전부 서버
- `GET /api/search/inventory?q=&kinds=&limit=` → `{ groups:[{ kind, total, rows[] }], shown, omitted, sources, builtAt, locked:[kind…], note }`. 응답 캐시(memo)는 두지 않는다(검색어마다 다르다) — 색인 캐시만.
- 접두(`vm:` `ip:` `sn:` …)는 **서버가 해석**(`search/inventoryQuery.js` 순수 — 접두 표 · 정렬 · 상한). 화면은 칩 표시에 같은 표를 쓰므로 두 벌이 생긴다 → **같은 입력으로 대조하는 테스트**를 둔다(‘판정 코어는 하나’ 규약의 예외 처리 방식).
- 종류별 판정(한 함수 `kindAccess(user, kind)` — 칩 · 행 · 색인 모두 이것으로):
  - `vm · host · datastore · network · vcenter` → `inv.*` 권한 + `scopedVcenterIds` 교집합(범위 밖 행은 **개수도** 세지 않는다 — ⑤ⓐ 푸터).
  - vCenter 귀속이 있는 베어메탈(iDRAC `vcenterId`) · GPU 서버 → 그 vCenter 범위로(`analysisScope.serverInScope` 와 같은 판정).
  - **귀속 없는 종류**(스토리지 · SAN · 네트워크 스위치 · PDU · OME · 엣지 fleet · 미귀속 iDRAC · 미귀속 IP) → **전체 범위 계정만** + `tools` 권한 + 그 도구의 `toolAllowed`(storage-mon · san-switch · cvp · pdu · serveranalysis · ipam · gpu). 범위 계정에는 칩을 잠그고 사유만(존재 · 개수 비노출 — 불변조건).
  - 도구 접근이 거부된 종류는 칩 · 행 모두 내려보내지 않는다(‘메뉴는 보이는데 API 는 403’ 을 만들지 않는다).
- 비관리자(`isAdminDetailUser` 아님): 스토리지 · SAN · PDU · CVP 의 `host`/IP 를 응답에서 비우고(`addressMask` 와 같은 규칙), **`ip:` 검색의 후보에서도 뺀다**(가린 값으로 찾아지면 가림이 무의미). 행에는 ‘(주소 가림)’ 을 적는다(⑤ⓑ). 데모 계정도 같은 판본(⑤ⓗ).
- 색인은 **관리자 판본 1개**를 공유하고 범위 · 가림은 **응답 때** 건다(색인을 사용자마다 만들지 않는다 — 시리얼 색인 L-2 와 같은 이유). 조회라 감사 로그는 남기지 않는다.

### 4.3 화면 — 지금 팔레트를 넓힌다(새 셸 · 새 창 없음)
- `components/Palette.jsx` 확장: 장비 결과는 서버(150ms 디바운스 · 요청 순번으로 **늦게 온 이전 응답은 버림** · 2자부터 · `ip:`/`sn:` 뒤는 3자부터), 기능 · 탭은 **지금처럼 브라우저 안에서**(서버가 죽어도 팔레트는 산다 — ⑤ⓕ).
- 결과는 종류 묶음 · 묶음별 5건 · 묶음 머리의 ‘<화면>에서 N개 모두 보기’ 는 그 종류의 전용 화면으로 검색어를 넘긴다(§5.1 · 결정 3) · 전체 60건 상한 · **잘린 개수를 푸터와 칩에 밝힌다**(기존 규약 그대로). 정렬: 이름 앞글자 일치 › 이름 포함 › 호스트명 › IP › 시리얼 › 모델, 같은 등급은 이름순(`toolSearch.js` 와 같은 모양).
- 행의 상태(켜짐 · 연결됨 · 정상 · 경고)는 **색인 시점의 스냅샷 값**이다 — 푸터의 ‘색인 n초 전’ 이 그 뜻이고, 화면은 ‘실시간’ 이라 말하지 않는다. 값이 없으면 ‘—’(IP 없음 · Tools 없음).
- 종류 칩 = 접두와 같은 뜻(칩 토글 ↔ 입력의 `vm:` 접두 동기화 · × 로 지움). 키보드는 기존 ↑ ↓ Enter Esc 에 `Tab`(칩 이동) · `⌘⏎`(새 탭) · Esc 1회는 접두만 지움(⑤ⓘ). 전역 keydown 은 ⌘K 하나(기존).
- 최근 연 항목 10개는 브라우저 `localStorage`(try/catch · 지우기 버튼) — 서버에 두지 않는다(개인 편의).
- 팔레트 폭 640 → 760(메타가 한 줄에 들어가게) · 400px 은 전폭 · 행 2줄 · 칩 가로 스크롤 · 터치 44px(⑥). 문구: `SEARCH_PLACEHOLDER` ‘장비 · 기능 찾기’ · `SEARCH_TITLE` ‘장비 · 기능 찾기 (⌘K / Ctrl+K)’ — `headerText.js` 의 ‘VM 이름 검색은 여기서 약속하지 않는다’ 주석을 정정한다.

### 4.4 선택 뒤 이동 — 기존 화면에 `?focus` 만 더한다(새 상세 화면 없음)

| 종류 | 이동 주소 | 지금 있나 | 구현 메모 |
|---|---|---|---|
| 가상머신 | `#/vms?focus=<vmId>` | 없음 | `Vms.jsx` 가 focus 를 읽어 목록에서 찾아 기존 `EntityDetail` 모달을 연다. 현재 페이지 · 필터 밖이면 단건 조회로 상세만(범위 밖 404 → `ErrorBox`). 필터는 건드리지 않는다(④) |
| VM호스트 | `#/hosts/<id>` | **있음**(v2.805) | 그대로 |
| 데이터스토어 · 네트워크 · vCenter | `#/datastores?focus=` · `#/networks?focus=` · `#/vcenters?focus=` | 없음 | 같은 훅 |
| 베어메탈(iDRAC · OME) | `#/tools/serveranalysis/info?focus=<deviceId>` | 없음 | 서버 분석 ‘정보’ 가 그 서버를 열고 부품이면 부품 탭 |
| 엣지 베어메탈(fleet) | `#/tools/serveranalysis/baremetal?focus=` | 없음(세그먼트 `baremetal` 은 있음) | |
| GPU 서버 | `#/tools/gpu?host=<id>` | 없음 | |
| 스토리지 | `#/tools/storage-mon?device=<id>` | 없음 | 장비 행 스크롤 + 하이라이트 + 상세 펼침 |
| SAN 스위치(· SFP) | `#/tools/san-switch?device=<id>(&port=3/14)` | 없음 | |
| 네트워크 스위치 | `#/tools/cvp?device=<id>` | 없음 | |
| PDU | `#/tools/pdu?device=<id>` | 없음 | |
| IP 대장 | `#/ipam?ip=<ip>` | 없음(`IpamNet` 이 쿼리를 읽는 선례는 있다) | 대역을 펴고 그 행으로 |
| 기능 · 탭 | `#/tools/<k>` · `#/<tab>` | 있음 | 지금과 같음. ‘‘q’ 로 심층 검색 열기’ 는 `#/tools/deepsearch?q=` 로 검색어를 넘긴다 |

- 공용 훅 `hooks/useFocusParam.js`: 마운트 때 **한 번** 읽고 → 찾으면 스크롤 · 하이라이트 · 상세 열기 → 못 찾으면 ‘이 화면에 없는 항목입니다(범위 밖 · 삭제됨 · 수집 전)’ 안내 → 해시의 파라미터는 지우지 않는다(주소를 복사해 공유하면 같은 상세 — ④ 주소 띠). 도구 키는 바꾸지 않고 **쿼리만** 더한다.
- 이 표의 ‘없음’ 12곳이 구현 비용의 가장 큰 덩어리다(§6).

### 4.5 성능 · 안전 요약(회귀 방지 규약과의 대조)
- 폴링 없음 · 색인은 요청 때만 · TTL 30초 · 선형 스캔 · 정규식 없음 · 검색어 상한 · 결과 상한 · 잘린 수 표시 · 늦은 응답 버림 · 범위는 요청 필터보다 먼저 · 귀속 없는 데이터 범위 계정 비노출 · 가림은 `isAdminDetailUser` 하나 · 못 읽은 출처는 빈 결과로 위장하지 않고 띠로 밝힘(`registryUnreadable` 503 과 같은 정신) · 화면에 주기 · 상한 숫자를 박지 않는다(API 값 `limit` · `builtAt`).

## 5. 결정(사용자 컨펌 2026-11-05)

| # | 항목 | 결정 | 시안 · 설계에 미친 것 |
|---|---|---|---|
| 1 | 종류 범위 | **11종 전부** | §4.4 이동 훅 12곳 모두 구현 범위 |
| 2 | 귀속 없는 종류 × 범위 계정 | **칩 잠금 + 사유** | ⑤ⓐ 그대로 — 존재 · 개수는 내려보내지 않는다 |
| 3 | ‘더 보기’ | **전용 화면으로 이동** | 묶음 머리의 링크가 ‘<화면>에서 N개 모두 보기’ 로 바뀐다(①③⑥ 수정). 팔레트 안 펼침은 없다. 목적 화면이 **검색어를 필터로 받아야** 한다 — §5.1 |
| 4 | 최근 연 항목 | **localStorage 10개** | ② 그대로(try/catch · 지우기) |
| 5 | `sn:` 범위 | **장비만** | 시리얼 색인의 `server-part` · `sanswitch-part` 행은 쓰지 않는다. 부품 시리얼이 걸리면 개수만 적고 ‘시리얼 조회에서 보기’ 로 넘긴다(③ 수정) |
| 6 | 장비 최소 글자 | **2자** | ⑤ⓖ 그대로(`ip:` · `sn:` 뒤는 3자) |

### 5.1 ‘모두 보기’ 목적지(결정 3 — 검색어를 그 화면의 필터로)

| 종류 | 목적지 | 메모 |
|---|---|---|
| 가상머신 · VM호스트 · 데이터스토어 · 네트워크 · vCenter | `#/vms?q=` · `#/hosts?q=` · `#/datastores?q=` · `#/networks?q=` · `#/vcenters?q=` | 각 탭의 기존 검색 입력에 넣는다(새 필터를 만들지 않는다) |
| 베어메탈 | `#/tools/serveranalysis/info?q=` | |
| GPU 서버 | `#/tools/gpu?q=` | |
| 스토리지 · SAN · 네트워크 스위치 · PDU | `#/tools/storage-mon?q=` · `#/tools/san-switch?q=` · `#/tools/cvp?q=` · `#/tools/pdu?q=` | |
| IP 대장 | `#/ipam?q=`(`ip:` 접두면 대역을 펴서) | |
| 부품 시리얼(결정 5) | `#/tools/serial-lookup?q=` | 전체 범위 계정만 — 범위 계정에는 링크를 내지 않는다 |

- `?focus=`(행 하나)와 `?q=`(목록 필터)를 같은 훅(`hooks/useHashQuery.js` — §4.4 의 `useFocusParam` 을 넓힌 것)이 읽는다. 마운트 1회 · 그 화면의 기존 검색 상태에 넣고 끝(해시는 지우지 않는다).
- 목적 화면이 검색 입력을 갖고 있지 않으면 그 화면에 검색 입력을 새로 두지 않고 이동만 한다(‘모두 보기’ 링크를 그 종류에서 빼고 개수만 적는다) — 구현 때 화면별로 확인해 §7 에 적는다.

## 6. 구현 범위(추정 · 컨펌 뒤 Opus)

- 서버: `search/inventoryIndex.js`(출처 11종 · 캐시) · `search/inventoryQuery.js`(접두 · 정렬 · 상한, 순수) · `routes/api/invSearch.js`(게이트 · 범위 · 가림 · 503) · 테스트(범위 계정 비노출 · 도구 거부 · 비관리자 가림 · `ip:` 가림 제외 · 잘림 · 출처 실패 · 검색어 길이 비율 회귀) · **변이 검증**(범위 · 권한이므로 — 규약).
- 웹: `Palette.jsx` · `palette.js`(묶음 · 커서) · `components/invSearchQuery.js`(접두 표 — 서버와 대조 테스트) · `hooks/useHashQuery.js`(`?focus` · `?q`) · 목적 화면 12곳에 focus + q 연결(§4.4 · §5.1) · `styles.css`(폭 · 칩 · 400px) · `headerText.js` 문구 · vitest · Chromium 1440/400.
- 문서: `docs/rules/web.md`(팔레트 항목 갱신) · `docs/rules/security-api.md`(검색 라우트 게이트 1항목) · API 문서 재생성 · 이 README §7.
- 예상 3~4.5시간(결정 1 · 3 반영 — 11종 · 목적 화면 12곳에 focus + q) — 착수 전 검증 수준을 묻는다(30분 초과 규약).

## 7. 구현 기록(v2.909.0 · 2026-11-06)

### 7.1 만든 것
- 서버 `server/src/search/` — `inventoryIndex.js`(색인 · 11종 출처 · 출처별 try · 30초 캐시 · 진행 중 생성 공유 · 강제 재생성 10초 스로틀) ·
  `inventoryAccess.js`(`accessPlan` 종류별 권한 · 도구 · 범위 · `publicRow` 주소 가림) · `inventoryQuery.js`(접두 · 일치 등급 · 묶음 상한 — 순수).
  라우트 `GET /api/search/inventory`(`routes/api/invSearch.js`). 테스트 `server/test/invSearch2909.test.js` 17건 · 변이 15건 중 14 잡음(§7.3).
- 웹 — `components/Palette.jsx`(장비 묶음 · 종류 칩 · 띠 · 빈 입력의 찾는 범위 · 최근 10개 · 키보드) · `components/invSearchQuery.js`(접두 표 · 이동 계획 · 최근 항목 · 행 메타 — 순수) ·
  `hooks/useSearchHandoff.js`(받는 화면 훅) · 문구 `views/headerText.js`('장비 · 기능 찾기'). 테스트 `invSearchQuery.test.js` 13건.
- 받는 화면(검색어 인계) — App(가상머신 · VM호스트 · 스토리지 탭 상단 필터) · VCenters(빠른 찾기) · 서버 분석 › 정보 · 서버 분석 › GPU · 스토리지 모니터링 · SAN 스위치 · Arista CVP ·
  IP관리 · 시리얼 조회(둘은 v2.616 부터 받던 것 그대로).

### 7.2 시안과 달라진 것(근거)
| 시안 | 구현 | 근거 |
|---|---|---|
| ④ 이동 주소에 `?focus=` · `?q=`(공유 가능한 URL) | **이미 있는 상세 주소 + 메모리 인계** — VM `#/vcenters/<vc>/vm/<id>`(v2.895) · 호스트 `#/hosts/<id>`(v2.805) · vCenter `#/vcenters/<id>`, 그 밖은 그 화면 검색 칸에 장비 이름(베어메탈은 서비스 태그)을 넣는다 | `hooks/searchHandoff.js`(v2.616) 규약 — 검색어 · IP · 시리얼을 주소창 · 기록에 남기지 않는다. 또 지금 해시 라우터는 `#/vms?focus=` 의 `?` 뒤를 탭 이름에 붙여 읽는다(구현 중 확인) — 쿼리 방식은 탭 판정 36개 파일을 건드려야 했다 |
| ‘N개 모두 보기’ | ‘<화면>에서 모두 보기’(개수는 묶음 머리에만) | 목적 화면의 필터 규칙이 다르다 — 목 데이터 실측: 팔레트 41(템플릿 제외) ↔ 가상머신 탭 43. 링크에 개수를 쓰면 거짓 약속이 된다 |
| PDU ‘모두 보기’ | ‘PDU 정보 열기’(필터 없이 이동) | PDU 화면에 이름 검색 칸이 없다 — §5.1 규칙대로 새 입력을 만들지 않았다 |
| GPU 서버 종류 = `tools` + `gpu` 도구 | **관리자 판본만** · 목적지 서버 분석 › GPU | 물리 GPU 서버 등록부(`gpu/physicalRegistry.js`)가 보이는 화면은 서버 분석 › GPU(관리자 전용 API) 와 설정 › GPU 게스트 수집뿐이다 — `#/tools/gpu` 는 ESXi GPU 호스트 화면이라 그 행을 보여 주지 않는다 |
| §4.1 의 12종(포트그룹 포함) | 11종(포트그룹 제외) | ② 아트보드 · 컨펌 ① 의 11종 그대로. 포트그룹은 장비가 아니다 |
| 행 상태 · 메타 순서 | 상태를 법인 바로 뒤로 | 1440 실측에서 메타 끝의 ‘사용 62%’ 가 잘렸다 |
| 새 탭(⌘Enter) | 주소만 연다 | 메모리 인계는 다른 문서에 닿지 않는다 — 새 탭에서는 검색 칸이 비어 있다(VM · 호스트 · vCenter 는 주소만으로 열린다) |

### 7.3 검증
- 서버 `invSearch2909.test.js` 17/17 · 웹 `invSearchQuery.test.js` 13/13 · `headerText.test.js`(⑤ 문구 계약을 ‘장비 · 기능 찾기’ 로 갱신).
- 변이 15건(범위 교집합 · 잠금 · 스캔 IP · 도구 판정 · 관리자 판본 · 주소 가림 3종 · role 직접 비교 · 부품 개수 범위 · 잠긴 종류 오류 · 빈 입력 개수 · 검색어 상한 · ip 가림) — 14 잡음.
  살아남은 1건(`visible()` 의 `scope !== 'vc'` 줄 제거)은 앞 단계 `kinds[k] !== 'ok'` 가 같은 행을 이미 막는 **이중 방어 줄**이라 단독 제거로 결과가 바뀌지 않는다(동등 변이). 잠금 판정(M2)이 퇴행하면 이 줄이 행 노출을 막는다.
- Chromium(목 서버 · 1440/400): 빈 입력 · ‘ash’ 혼합 결과 · `ip:` · `sn:` · 1자 · 결과 없음 · VM 행 Enter → VM 개체 보기 · 스토리지 행 → 스토리지 모니터링 검색 칸 ‘PMAX-FRA-01’ ·
  CVP 행 → 장비 탭 검색 칸 · ‘모두 보기’ → 가상머신 탭 필터 · 최근 항목 · Tab/Esc — 콘솔 · 페이지 오류 0 · 가로 넘침 0 · 1440 이름 잘림 0.
- 목 서버 응답 시간(참고 · 이 컨테이너): 빈 입력 51ms(첫 색인 생성 포함) · 검색 4~8ms. 운영 규모(VM 5,850 · IP 1만)는 재지 않았다.

### 7.4 반증 검토 1인(커밋 5910cc4 대상) — 확정 5 · 추정 2, 모두 반영
| 건 | 내용 | 조치 · 회귀 |
|---|---|---|
| M-1 | 비관리자가 **이름 · 보조 이름에 든 가린 관리 주소**로 장비를 찾고(SAN 이름이 비면 스냅샷 이름이 관리 IP), 같은 등급 정렬이 숨긴 IP 순이라 id ↔ IP 대응을 복원 | 색인 때 `_nAddr · _aAddr · _mAddr`(그 칸에 행 주소가 있나) → 가림 판본은 그 칸으로 찾지 않음 · 가린 행의 동순위 키는 색인 순. 테스트 + 변이 R2~R5 |
| M-2 | 시리얼 정규화를 **행마다** 다시 해 구분자 254자 검색어가 14k 행 55~82ms · 5만 행 215ms | `parseQuery` 가 `snNeedle` 를 한 번 만든다. 비율 테스트(조작 < 보통 × 8) + 변이 R1 |
| L-1 | 범위 관리자의 베어메탈 귀속이 서버 분석보다 좁은 '줄인 사본'(v2.630 R2630-01 과 같은 계열 — 누락 방향) | `idTag · idracServerVcOf · idracCorpIndex` 를 `idrac/corpAttribution.js` 로 옮겨 두 곳이 같은 함수(idracCore 는 다시 내보냄 — 호출부 · audit2630b 무변경) |
| L-2 | 범위 계정: 범위 밖 VM · 스캔이 쓰는 IP 를 자기 vCenter 로 예약한 수동 행이 IP관리에는 있는데 ⌘K 에는 없음(약한 부재 오라클) | 범위 계정의 IP 행은 **IP관리와 같은 범위 원장**(`buildIpamRowsShared(snap,'',allowed)` · 세대 캐시 · WeakMap)에서. 원장 행도 `visible()` 로 다시 거름. 변이 R6 · R7 |
| L-3 | 색인 생성이 양보 없이 동기(목 14k 행 32~107ms) · 권한 0 계정도 `refresh=1` | 출처 함수 async + 행 128개마다 시간 기준 양보(`createYielder(15)`) · 강제 재생성은 볼 종류가 있는 계정만 |
| L-4(추정) | 최근 연 항목이 계정별이 아님 | 키 `ui.invSearch.recent:<계정>`(`recentKeyFor`) · 계정을 모르면 저장 안 함 · 인증을 끈 단일 사용자 모드는 'anonymous' |
| L-5(추정) | 엣지 베어메탈 id 이중 접두 · 출처 중간 실패 시 '0행 + 오류' | `serverId` 그대로 · 실패해도 그때까지 넣은 행 수를 적음 |
- 반영 뒤: 서버 테스트 21/21 · 새 변이 7/7 잡음 · 기존 변이 15 중 14(같은 동등 변이 1) · 웹 14/14 · Chromium 재확인(최근 항목 2건 · 오류 0).

## 8. 개선(v2.911.0 · 2026-11-06 — 사용자 요청 '개선하면 좋은 점 제안' → '1차, 2차 모두 수행' · 검증 표준)

| # | 개선 | 어디 | 근거 · 확인 |
|---|---|---|---|
| B1 | **완전 일치가 맨 앞** — 이름 · IP · 관리 주소 · 시리얼(구분자 무시)이 검색어와 같으면 등급 1 | `server/src/search/inventoryQuery.js textTier` | 예전에는 IP 일치가 등급 하나뿐이라 `10.1.0.1` 의 VM 이 10.1.0.1x VM 사이에 이름순으로 섞였다. 행 메타도 완전 일치 IP 를 먼저 보인다(`shownIp` — Chromium 에서 멀티홈 VM 이 앞자리 IP 로 보이던 것 확인) |
| B2 | **여러 낱말 AND** — 통째로 맞지 않으면 낱말마다 어느 칸에든 있는 행(등급 8, 통째 일치보다 뒤) · 낱말 6개까지 · 가린 칸은 낱말에도 쓰지 않는다 | `parseQuery words` · `matchTier` | 낱말 · 낱말 정규화는 요청당 한 번(반증 M-2 규칙) · 비율 테스트(낱말 조작 < 보통 × 12) |
| A1 | **고른 장비를 그 화면에서 연다** — 스토리지 상세 모달 · SAN 포트 상세 · CVP 장비 상세 · 서버 분석 iDRAC 상세 · PDU 펼침 | 각 화면 `useFocusHandoff('<target>:focus', …)` | 이동 한 번에 검색어와 장비 id 를 함께 넘긴다 — `hooks/searchHandoff.js handoffMany`(target 별 칸 · 새로 남기면 이전 묶음은 버림 · 30초). 물리 GPU 서버는 그 화면에 상세 창이 없어 검색 칸만 |
| A2 | **데이터스토어 상세 자동 열기** | `views/Datastores.jsx` | App 이 같은 이동에서 상단 필터에 이름을 넣고(앞 칸), 화면이 상세를 연다(뒤 칸) |
| A3 | **PDU 화면 검색 칸**(이름 · 모델 · 시리얼 · 수집 주체 · 주소) — ‘모두 보기’ 가 PDU 에서도 걸러 보기 | `views/tools/PduTool.jsx` | 주소는 서버가 비관리자에게 비워 보내 걸리지 않는다 |
| A4 | **검색 결과로 돌아가기** — 결과를 골라 이동한 뒤 ⌘K 를 다시 열면 직전 검색어 · 칩이 그대로(글자 선택 상태 · 10분 · 모듈 메모리) | `components/Palette.jsx` | 저장소에 남기지 않는다(새로 고침하면 사라짐) |
| C1 | **단축키 표기를 OS 에 맞춤** — Mac `⌘K` · 그 밖 `Ctrl K`(팔레트 바닥의 새 탭 키도) | `views/headerText.js cmdkLabel · modKeyLabel` | 단축키는 예전처럼 둘 다 받는다 |

- 확인: 서버 `invSearch2909.test.js` 23건 · 웹 `invSearchQuery` 14 · `headerText` 10 · `searchHandoff` 7 · Chromium 1440(목 서버) — 스토리지 · SAN · CVP · 데이터스토어 · 서버 분석 상세 열림 ·
  PDU 필터 + 펼침 · 결과로 돌아가기 · `Ctrl K` 표기 · 콘솔 오류 0 · 400px PDU 가로 넘침 0.
- 구현 중 Chromium 에서 찾아 고친 것: ① PDU 가 첫 렌더의 빈 배열을 '받았는데 없음' 으로 읽어 인계를 버렸다 → `useFocusHandoff` 의 items 는 받기 전 undefined(훅 주석에 적음)
  ② 멀티홈 VM 의 메타가 완전 일치 IP 가 아닌 앞자리 일치 IP 를 보였다 → `shownIp` 완전 일치 먼저.
- 하지 않은 것: 행 강조(스크롤 + 색) — 검색 칸에 장비 이름이 들어가 목록이 그 장비로 좁혀지고 상세가 열리므로 따로 두지 않았다. 새 탭(⌘/Ctrl+Enter) 인계(B 제안 A5) · 태그 · 메모 색인(B3) · 최근 가산점(B4) · 접근성(C2) · 400px 메타 줄 넘김(C3) · 운영 실측(D1) · 비관리자 물리 서버(D2)는 이번 범위 밖. → D2 를 뺀 나머지는 §9(v2.928).

## 9. 남은 개선(v2.928.0 · 2026-11-07 — 사용자 요청 '프로그램 개선해줘' → 범위 '통합 장비 검색 남은 개선' · 검증 표준)

> 번호: v2.927.0 으로 준비했으나 머지 직전 main 이 2.927.0(VM 상세 · 성능 그래프 후속)을 먼저 써서 **v2.928.0** 으로 게시한다(코드 · 테스트 표지도 v2.928).

| # | 개선 | 어디 | 근거 · 확인 |
|---|---|---|---|
| A5 | **새 탭(⌘/Ctrl+Enter)에도 검색어 · 고른 장비를 넘긴다** — localStorage 일회용 칸(`ui.invSearch.newtab:<16진 16자>` · 60초) + 새 창 **이름**(window.name)에 번호만. 새 탭이 그리기 전에(main.jsx) 꺼내 지우고 메모리 인계로 옮긴다 | `hooks/searchHandoff.js stashForNewTab · consumeNewTabHandoff` · `main.jsx` · `App.jsx`(마운트 때 대기 칸 받기) | 검색어는 주소 · 기록에 남지 않는다(v2.616 규약 그대로). 새로 고침하면 다시 열리지 않는다(칸 · 창 이름 모두 지움). 낡은 칸은 다음에 남길 때 치운다 |
| B3 | **VM 태그 · 사용자 지정 속성 · 메모로 찾기** — 색인 VM 행에 `범주:태그` · `이름=값`(24개 · 각 120자) · 메모 앞 300자. 일치 등급은 이름 · IP · 시리얼 · 모델 뒤(태그 8 · 메모 9). 행에 ‘태그 · CostCenter=CC-1001’ · ‘메모 일치’ 표지 | `search/inventoryIndex.js vmTagStrings` · `inventoryQuery.js textTier` · `invSearch.js VIA` | **태그는 그 값이 보이는 화면(태그 · 속성 점검 `vm-tags` — tools)을 쓸 수 있는 계정만** 찾는다(`accessPlan.tagsSearchable`). 메모는 가상머신 목록의 '메모 포함' 검색과 같은 값이라 vm 종류를 볼 수 있으면 찾는다. 메모 본문은 응답에 싣지 않는다 |
| B4 | **최근 연 장비 가산점** — 팔레트가 최근 연 장비(계정별 localStorage)의 `종류\|id` 를 `recent=` 로 보내면, **이미 보이는 행 안에서만** 완전 일치 바로 뒤(등급 1.5)로 올리고 ‘최근’ 표지 | `invSearch.js parseRecent` · `searchRows({recent})` · `invSearchQuery.js recentIdsParam` | 아는 종류 · 10개 · 항목 300자까지. 이 값으로 행을 더하거나 범위를 바꾸지 않는다(범위 계정 테스트로 고정) |
| C2 | **스크린리더** — 입력칸 `role=combobox` + `aria-activedescendant`(포커스는 입력칸에 둔 채 커서 줄을 읽는다) · 목록 `listbox` · 종류 묶음 `group` · 줄 `option` · 결과 수 `role=status`(보이지 않는 줄) | `components/Palette.jsx` | Chromium: ↓↓ 뒤 activedescendant = 켜진 줄 id · 선택 줄 1개 |
| C3 | **400px 메타 2줄** — 한 줄 말줄임에서 2줄 말줄임(`line-clamp: 2`)으로. 줄은 ‘·’ 뒤에서 바뀐다(구분자 뒤 공백) · ‘외 n’ 은 붙여 둔다(nbsp) | `styles.css` | Chromium 400: 가로 넘침 0 · 메타 2줄 |
| D1 | **운영 규모 색인 시간** — 색인 생성 시간 · 양보 횟수 · 출처별 ms 를 관리자 판본 응답(`index`)에 싣고, 1.5초를 넘으면 10분에 한 번 콘솔 경고(출처 상위 4개) | `inventoryIndex.js noteSlowBuild` · `invSearch.js meta.index` | 전체 행 수는 범위와 무관한 값이라 범위 · 비관리자 응답에 싣지 않는다. 목 실측 5,518행 143ms(양보 2회) |

- 확인: 서버 `invSearch2909.test.js` 28건 · 웹 `invSearchQuery` 16 · `searchHandoff` 12 · Chromium 1440/400(목 서버) — 태그 · 메모 · 최근 표지, ARIA, 새 탭 스토리지(검색 칸 + 상세 모달 열림 · 창 이름 지움 · 칸 지움 · 새로 고침 뒤 모달 0) ·
  새 탭 IP(IP관리 검색 칸) · 400px 가로 넘침 0 · 콘솔 오류 0.
- 구현 중 Chromium 에서 찾아 고친 것: ① 1440 에서 태그 표지가 메타와 함께 줄어 ‘태그 · CostCente…’ 로 잘려 일치한 값이 안 보였다 → 표지는 줄지 않게(`flex: 0 0 auto` · 최대 260px), 메타가 대신 준다
  ② 400px 2줄에서 둘째 줄이 ‘·’ 로 시작했다 → 구분자 뒤 공백으로 줄바꿈 위치를 ‘·’ 뒤로 · ‘10.1.0.22 외 1’ 이 갈라지던 것은 nbsp.
- 하지 않은 것: 비관리자 물리 서버 검색(D2 — 목적 화면이 관리자 전용 API 라 정책 결정이 먼저다). 메모 본문 미리보기(가상머신 목록 '메모 포함' 과 같은 노출 수준이라 가능하지만 행이 길어져 표지만 둔다).

