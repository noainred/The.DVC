# Handoff: 특수 기능 › 서비스 맵 — VM + 베어메탈 통합 (시안 A)

대상 저장소: `noainred/The.DVC` · 기준 커밋 v2.863.0
대상 화면: 새 도구 `#/tools/service-map`(새 키 — 기존 키는 바꾸지 않는다) + 설정 › 서비스 맵(관리자)
부수 범위: `tag-policy.json` 에 `serviceCategory` 1필드 · `service-assign.json` 저장소 · 카탈로그 PRESET 배치

> 상태: **시안(초안)**. 2026-11-03 사용자 요청 "vCenter 로 관리되는 VM 과 관리 방법이 없는 베어메탈을 서비스 형태로 분리해 통합 관리" 에 대한
> 설계안이고, 구현 전이다. 코드는 한 줄도 바뀌지 않았다. 결정이 필요한 항목은 §결정 필요 에 모았다.

## Overview

VM(vCenter)·베어메탈(iDRAC/OS)·ESXi 호스트를 **서비스 → 구성원** 매핑 한 겹으로 묶어, 서비스별 구성원 수·전원·CPU/메모리 가중 사용률·열린 부품 장애·
백업 결과·IP 를 한 화면에서 본다. **새 수집기를 만들지 않는다.** 이미 있는 스냅샷·캐시를 읽기 시점에 조인하므로 vCenter·iDRAC 왕복이 0 이고,
고RTT 법인(폴란드·미국 동부)에 부담이 없다.

왜 이 방식인가(조사 근거, 2026-11-03):

- 물리 서버 통합 인벤토리는 이미 있다 — `server/src/insights/fleetInventory.js classifyFleet()` 가 iDRAC·OME·엣지·원격 서버와 ESXi 호스트를
  서비스태그로 합쳐 가상화 호스트/베어메탈로 분류하고, `fleet-tags.json`(수동 분류)·`fleet-assign.json`(법인 귀속)이 예외를 받는다.
- 베어메탈 수집 경로도 다섯 가지가 돈다 — 전력·부품·온도(`idrac/`), 사용률(`bmusage/` — iDRAC 텔레메트리 + OS SSH, Windows 는 `parse/winPerf.js`),
  로컬 디스크(`bmstor/`), 부품 장애(`partfault/`), IP(`ipam/ledger.js` serverType BareMetal).
- VM + 물리 혼합 합산의 선례가 있다 — `corpusage/build.js` 가 '사용률 × 용량' 으로 더한다. 서비스별 합산도 같은 규약을 쓴다.
- 없는 것은 **서비스 축**이다. 묶음 수단이 모듈마다 따로 있고 서로 연결되지 않는다:
  - vSphere 태그·사용자 지정 속성은 6시간마다 수집된다(`tags/collect.js`, 스냅샷 `vc.tagInv` 의 vmTags·hostTags·vmCustom). 정책 `tag-policy.json` 에는
    requiredCategories·corpCategory 만 있다.
  - iDRAC 스캔 엔트리에 `service` 라벨이 있다(`idrac/scanRanges.js` — "한 법인에 서비스가 여러 개, 서비스별 대역·계정·에이전트"). 그러나 등록된 서버
    항목(`idrac.json`)에는 복사되지 않고 스캔 로그에만 남는다(`registry.js`·`scan.js`·`localScan.js` grep 기준). 항목에는 `scanRangeId`(v2.742)가 붙으므로
    조회 시 엔트리와 조인하면 복원된다.
  - `bmstor` 서버 그룹(최대 3개, 스토리지 전용) · `svcmon` infra/service 폴더 트리(호스트 문자열 키라 VM id·fleetId 와 연결 없음) · VM folder·resourcePool.

## About the Design Files

- `service-map.dc.html` — **최종안(A)**. 브라우저로 열면 동작하는 HTML 프로토타입(외부 의존 없음, 결정적 목 데이터). 복사 대상이 아니라 재구현 레퍼런스다.
  하단 `<script>` 의 `agg()`(가중 합산)·`groupSvc()`·`applySort()`(STable 과 같은 asc→desc→해제, null 뒤로) 는 그대로 옮겨도 된다.
- `CLAUDE_CODE_PROMPT.md` — 구현 단계에 붙여 넣을 프롬프트.
- Chromium 1440px·400px 로 확인했다(콘솔 오류 0 · 페이지 가로 넘침 0 · 행 클릭·정렬·뷰 전환 동작). 스크린샷 파일은 저장소에 두지 않는다(세션 보고에 첨부).

## Fidelity

**High-fidelity.** 색·간격은 `web/src/styles.css :root` 토큰 값 그대로(새 hex 없음). 숫자·법인명·서비스명은 **목업**이다 — 실제 값은 API.
프로토타입은 `<table>` 에 자체 정렬을 넣었지만 구현은 공용 `components/STable.jsx`(`minWidth`·`data-sort`) 를 쓴다.

## 데이터 모델

### 구성원 키 (새로 만들지 않는다)

| 종류 | 키 | 출처 |
|---|---|---|
| VM | `vm.id` = `vcenterId:moref` | 스냅샷 `vms[]` |
| 베어메탈 | `fleetId` = 서비스태그 소문자(없으면 serverId 소문자) | `classifyFleet().bareMetal[].fleetId` |
| ESXi 호스트 | `fleetId` = 서비스태그 소문자(없으면 호스트명 소문자) | `classifyFleet().virtualizationHosts[].fleetId` |

### 소속 판정 — 순수 함수 하나 `server/src/servicemap/resolve.js resolveService(member, ctx)`

우선순위(위가 이긴다). 결과는 `{ service, src, reason }` — `src ∈ tag | scan | manual | rule | none`.

1. **vSphere 태그** — `tag-policy.json` 의 새 필드 `serviceCategory`(카테고리 **이름**, 대소문자 무시 — corpCategory 와 같은 규약)가 가리키는 카테고리의
   태그 이름이 서비스명. VM 은 `tagInv.vmTags[ref]`, 호스트는 `tagInv.hostTags[ref]`. 카디널리티 MULTIPLE 로 태그가 둘이면 **첫 번째를 쓰고 `multi:true`** 로 밝힌다.
   ⚠ 태그를 못 읽은 vCenter(`tagInv.tags === null`·`tagsPartialOf()` — `tags/analyze.js`)의 구성원은 `src:'unchecked'` 로 **'확인 안 됨'** 이지 미지정이 아니다.
2. **iDRAC 스캔 엔트리 service** — `idrac.json` 항목 `scanRangeId` → `idrac-scan-ranges.json` 엔트리 `service`(비어 있으면 통과). **복사하지 않고 조인**한다
   (스키마 변경 없음). 엣지 보고 베어메탈(`source:'edge'`)은 중앙에 엔트리가 없으므로 이 규칙을 타지 못한다 → 엣지 push 에 `service` 를 **싣고 중앙 정제
   화이트리스트에 추가**(규칙: 새 엣지 export 필드는 중앙 정제에도). 구버전 엣지는 빈 값 = 통과.
3. **수동 지정** — `CONFIG_DIR/service-assign.json` `{ "<key>": "<service>" }`. 저장 규약은 `insights/fleetAssign.js` 그대로(원자적 쓰기 · `preserveCorrupt` ·
   mtime+size 무효화 · `bumpFleetRev`). 관리자 전용 · `logAudit`. 서비스명은 1~64자 · 제어 문자 거부 · 앞뒤 공백 제거.
4. **이름 규칙(선택)** — `service-assign.json` 의 `rules:[{ pattern, service }]`. 입력은 길이 128 로 자른 뒤 매칭, 패턴은 저장 시 `safe-regex` 류 검사 대신
   **길이 상한 + 중첩 수량자 금지** 정적 검사(저장소 ReDoS 규약). 기본 비활성.
5. **(미지정)** — 위 넷 다 아니면. `reason` 에 왜인지 적는다(`no-tag-category` · `scan-service-empty` · `no-corp` · `not-registered`).

판정 코어는 **서버 한 곳**이고, 웹은 `src` 코드를 문장으로 바꾸기만 한다(`web/src/views/tools/serviceMapText.js`).

### 집계 — `server/src/servicemap/build.js buildServiceMap(snap, ctx)` (순수)

- 묶음 단위는 **(법인, 서비스)**. 법인:vCenter:Bareos 가 1:1:1 이므로 서비스는 법인 아래 둔다. 전 법인 합계는 별도 `totals` 로만.
- CPU·메모리는 `corpusage/build.js` 규약 — 구성원마다 `사용률 × 용량` 을 더하고 `Σ사용 ÷ Σ용량`. 지표마다 따로 센다(CPU 만 읽은 서버는 메모리 분모에 없다).
  용량: VM = `cpuCount`·`memMB`, 베어메탈 = `bmusage` 표본의 코어·메모리(없으면 `noCap`), 호스트 = `cpuCores`·`memGB`.
- 사용률 출처: VM = 스냅샷 `cpuUsagePct`·`memUsagePct`(꺼진 VM 은 0 그대로, 구동 중 null 은 못 읽음) · 베어메탈 = `bmusage/db.js latestUsage()`(`srcOf` 로
  idrac/os 밝힘, `freshMs` 초과는 stale 로 빼고 센다) · 호스트 = `corpusage` 가 쓰는 같은 경로(iDRAC 받침 → vCenter 대체, 출처 표시).
- 부품 장애 = `partfault/db.js openFaults()` 를 `deviceKey`(서비스태그) 로 조인. 베어메탈·호스트만. 엣지 보고가 오래된 법인(`classifyEdges` stale)은 '—'.
- 백업 = 그 법인의 Bareos 최근 24h 잡 결과를 VM 이름으로 조인(`bareos/vmView.js` 가 이미 VM↔잡 대응을 가진다 — 구현 시 export 확인). Veeam 은 2단계.
- 못 읽음(`unread`)·오래됨(`stale`)·용량 없음(`noCap`)·확인 안 됨(`unchecked`)은 **합계에 넣지 않고 따로 센다**. 분모 0 이면 사용률은 null('—').

### 세 질문(DEV-METHOD ③)

- **이 값을 못 읽으면?** — 구성원은 남고 지표만 '—'. 서비스 행의 `unread` 에 센다. 태그를 못 읽은 vCenter 는 `unchecked`(미지정으로 세지 않는다).
  등록부(`idrac.json`·`service-assign.json`)를 못 읽으면 빈 목록을 내리지 않고 503(`registryUnreadable` 규약).
- **범위 계정이면?** — `scopedVcenterIds` 교집합을 **요청 필터보다 먼저**. VM·호스트는 vcenterId, 베어메탈은 귀속 법인(vcenterId). **법인 귀속이 없는 베어메탈은
  범위 계정에 보이지 않는다**(기존 불변조건 — 미귀속 데이터 미노출). 수동 지정 쓰기는 '조회 밖 404 → 쓰기 밖 403' 순서 한 함수. 설정(태그 카테고리·규칙)은 `fullScopeOnly`.
  `memoJson` + `extraKey: scopeKey(...)` 필수(캐시로 전 범위 결과가 새지 않게).
- **엣지 위임이면?** — 중앙은 엣지가 push 한 fleet(`central/fleet.js`)·bmusage(`bmusage/edgePull.js`)·part-fault 요약을 조인만 한다. 엣지 보고 TTL 을 넘긴
  법인은 베어메탈 지표·장애를 '—' 로 보이고 화면이 배너로 말한다(프로토타입 `noteUnread`). 엣지 push 에 `service`(스캔 엔트리 라벨)를 싣는 변경은 엣지 업그레이드가
  필요하므로, 구버전 엣지 법인은 규칙 ② 가 비어 **수동 지정으로만** 채워진다 — 그 사실을 소속 규칙 탭이 버전 단위로 밝힌다.

## API

| 메서드 · 경로 | 권한 | 응답(요지) |
|---|---|---|
| `GET /api/tools/service-map` | `requirePerm('insights')` + scope | `{ services:[{corp, service, members:{vm,bm,host}, on, total, cpu, mem, faults, backup:{ok,fail,none}, src:{tag,scan,manual,rule}, unread, stale, unchecked}], unassigned:n, totals, meta:{tagsAt, tagRefreshMs, bmAt, bmPeriodMs, snapAt, faultsAt, edges:[{agent, state}]}, unreadable:[] }` |
| `GET /api/tools/service-map/members?corp=&service=&kind=` | 같음 | `{ items:[{key, name, kind, corp, service, src, reason, on, cpu, mem, msrc, faults, backup, ip}], omitted }` — 상한 5,000 · 넘치면 `omitted` |
| `GET /api/tools/service-map.csv` | 같음 + `canCsv` | 구성원 표 그대로 · `exportBusy` 동시 1건 |
| `GET /api/admin/service-map/settings` | admin · `fullScopeOnly` | `{ serviceCategory, rules, assign:{count}, rev }` |
| `PUT /api/admin/service-map/settings` | admin · `fullScopeOnly` · OTP 불필요 | rev 대조(stale 거부) · 감사 |
| `PUT /api/admin/service-map/assign` | admin + 쓰기 범위 | `{ key, service|'' }` 1건 또는 `items[]` ≤ 500 · 조회 밖 404 · 쓰기 밖 403 · 감사 |

캐시: `memoJson` 30초 + `scopeKey`. 세대 키 = `fleetRev` + 스냅샷 at + `service-assign` mtime(무엇이 바뀌면 무엇이 지워지는가를 먼저 답한다).

## Screens

화면은 도구 하나. 위→아래 블록:

1. **안내 카드** — 소속 판정 순서와 '(미지정) 은 따로 센다' 를 한 문단으로. `BoldText` 규약(백틱 금지).
2. **KPI 5장**(`Card`) — 서비스 · 구성원(VM/베어메탈/호스트) · (미지정) · 열린 부품 장애 · 못 읽음(+엣지 오래됨). 클릭하면 뷰 전환.
3. **툴바** — 뷰 세그먼트(서비스별 · 구성원 전체 · 소속 규칙) · 법인 칩(전체 · 법인별 · 법인 미지정, 개수 표시) · 검색 · CSV. 범위 select 는 도구 패널 헤더가 이미 소유하므로 두 번 그리지 않는다(`SpecialTools.jsx`).
4. **서비스별 표**(`STable minWidth={1080}`) — 서비스 · 법인 · VM · 베어메탈 · 호스트 · 켜짐/전체 · CPU(가중, 막대) · 메모리(가중) · 부품 장애 · 백업 24h · 소속 근거(태그 n · 스캔 n · 수동 n) · 못 읽음.
   `(미지정)` 행은 amber 배경 + '규칙 없음' 배지로 **항상 맨 아래**(data-sort `￿`). 행 클릭 → 오른쪽 구성원 패널(1100px 미만은 아래로).
5. **구성원 표**(`STable minWidth={1180}`) — 이름(베어메탈은 서비스태그 소문자 보조행) · 종류 · 서비스 · 법인 · 소속 근거 · 전원 · CPU · 메모리 · 지표 출처(vCenter/iDRAC/OS(SSH)/못 읽음) · 부품 장애 · 백업 · IP. 종류 칩 필터.
6. **소속 규칙 탭** — 판정 순서 5단(규칙마다 그 규칙으로 소속된 대수) + (미지정) 표(왜 미지정인지 + 수동 지정 select). 설정 변경은 설정 메뉴에서.
7. **각주** — 갱신 시각·주기는 전부 `meta` 값. 숫자를 화면에 박지 않는다.

400px: KPI 2열 → 1열 자동(`auto-fit minmax(170px)`), 칩·세그먼트 `flexWrap`, 표는 `STable minWidth` 가 래퍼까지 만든다(페이지 가로 넘침 0). 프로토타입 실측 scrollWidth 400 = innerWidth 400.

## 파일 (구현 시)

- 서버: `src/servicemap/{resolve.js, build.js, assign.js, settings.js}` · `src/routes/api/serviceMap.js` · `src/routes/admin/serviceMap.js` · `src/tags/policy.js`(serviceCategory) ·
  `src/agent/fleetPush.js` + `src/central/fleet.js`(엣지 service 필드 + 정제 화이트리스트) · `src/toolcats/catalog.js` PRESET(서버·가상화·리포트 — 중복 소속이 정상) ·
  `src/insights/dbLocation.js` 해당 없음(SQLite 없음 — JSON 2개).
- 웹: `views/tools/ServiceMap.jsx`(+ `serviceMap/` 폴더로 200줄 초과 시 분리) · `views/tools/serviceMapText.js`(문구·src 문장) · `views/specialToolsList.js`(키 `service-map`, `aka:['서비스 맵','service map','서비스별 서버']`) ·
  `views/admin/ServiceMapSettings.jsx` · `toolAccess.js`·`taskLabel.js` 등록.
- 테스트: `server/test/serviceMapResolve.test.js`(우선순위 5단 · unchecked ≠ none · MULTIPLE 첫 태그) · `serviceMapBuild.test.js`(가중 합산 = corpusage 와 같은 입력 같은 출력 · 분모 0 null · stale 제외) ·
  `serviceMapScope.test.js`(범위 계정 미귀속 베어메탈 미노출 · 404→403 순서 · memoJson scopeKey) · `serviceMapAssign.test.js`(손상 보존 · 상한 · 감사) · 웹 `serviceMapText.test.js` · `toolCategories` 프리셋 대조.

## 단계

1. **원장 + 판정**(Opus): resolve/build/assign/settings + 테스트 + 관리자 API. 화면 없음. 엣지 service 필드.
2. **화면**(Opus 구현 · Sonnet Chromium): ServiceMap.jsx + 설정 탭 + 카탈로그 + CSV.
3. **후속**: 서비스별 알림 라우팅(담당자) · 일일 리포트 서비스 절 · svcmon 대상 자동 생성(서비스 원장 → 성능점검 트리) · Veeam 백업 조인.

예상: 1단계 약 1.5시간 · 2단계 약 1.5시간 + 검증(verify 약 6분 · Chromium 2회 · CI/릴리스 대기). 30분을 넘기므로 착수 전에 방식(전체 검증/표준/빠르게)을 묻는다.

## 결정 필요 (사용자)

1. vSphere 에 서비스 용도 태그 카테고리가 이미 있는가 — 있으면 이름, 없으면 'Service' 로 만들어 운영팀이 붙이는 운영 절차가 필요하다(포탈이 vCenter 에 태그를 쓰지는 않는다).
2. iDRAC 스캔 엔트리 `service` 라벨을 현장에서 실제로 채워 쓰는가(비어 있으면 규칙 ② 는 아무것도 못 한다 → 수동 지정이 주 경로가 된다).
3. 법인을 넘나드는 같은 서비스명을 전역 합계로 묶을지(기본: 법인별 행 + `totals` 만).
4. 첫 화면 열 우선순위(사용률 · 장애 · 백업 · 전력 중). 전력은 이 시안에 없다 — 넣으면 `power/total.js buildPowerTotal` 조인.

## 정직 기록 — 확인하지 못한 것

- 실제 vCenter 의 태그 운영 현황과 스캔 엔트리 라벨 기입 여부(목 데이터로는 알 수 없다).
- `bareos/vmView.js` 가 '최근 24h 잡 결과' 를 VM 단위로 바로 주는지는 머리말만 봤다 — 구현 시 export 를 확인하고 없으면 2단계로 미룬다.
- iDRAC 전원 제어(원격 리셋)는 소스에서 찾지 못했다 — '관리' 를 전원 제어까지로 본다면 별도 설계다(RMA 는 OS 명령, Redfish 전원 액션은 없음 — grep 기준).
- 프로토타입의 합산 수식은 `corpusage/build.js` 머리말 규약을 옮긴 것이고 그 모듈 코드와 **같은 입력으로 대조하지는 않았다** — 구현 테스트가 대조한다.
