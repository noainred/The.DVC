# Handoff: 특수 기능 › 서비스 맵 — VM + 베어메탈 통합 (시안 A · 2차)

대상 저장소: `noainred/The.DVC` · 기준 커밋 v2.863.0
대상 화면: 새 도구 `#/tools/service-map`(새 키 — 기존 키는 바꾸지 않는다) + 설정 › 서비스 맵(전체 범위 관리자)
부수 범위: `tag-policy.json` 에 `serviceCategory` 1필드 · `service-map.json` 저장소 · 카탈로그 PRESET 배치 · 엣지 fleet push 에 `service` 필드

> 상태: **시안(초안) 2차**. 2026-11-03 사용자 요청 "vCenter 로 관리되는 VM 과 관리 방법이 없는 베어메탈을 서비스 형태로 분리해 통합 관리" 의 1차 시안에,
> 같은 날 추가 요청 **① iDRAC 에서 식별된 서버를 선택해서 추가 ② 폴더 형태로 관리 ③ 법인별로 관리** 를 반영했다. 구현 전이고 코드는 바뀌지 않았다.
> 결정이 필요한 항목은 §결정 필요 에 모았다.

## Overview

VM(vCenter)·베어메탈(iDRAC/OS)·ESXi 호스트를 **법인 › 폴더 › 서비스 › 구성원** 트리로 묶어, 서비스별 구성원 수·전원·CPU/메모리 가중 사용률·열린 부품 장애·
백업 결과·IP 를 한 화면에서 본다. **새 수집기를 만들지 않는다.** 이미 있는 스냅샷·캐시를 읽기 시점에 조인하므로 vCenter·iDRAC 왕복이 0 이고,
고RTT 법인(폴란드·미국 동부)에 부담이 없다.

2차에서 더한 것:

- **폴더 트리** — 법인마다 폴더(경로 `\` 구분, 최대 10단계 — `svcmon/store.js` 의 SAFE_PATH 와 같은 규약)를 만들고 서비스를 그 아래 둔다. 빈 폴더도 유지된다. 서비스 이동은 같은 법인 안에서만.
- **법인별 관리** — 트리 최상위가 법인이다. 범위 계정은 자기 법인 노드만 보고, **쓰기 범위**(`writeVcenters`)가 있는 법인 관리자가 자기 법인의 폴더·서비스·구성원을 바꾼다.
  태그 카테고리·이름 규칙은 전체 범위 관리자만(`fullScopeOnly`). 법인 귀속이 없는 서버는 범위 계정에 보이지 않는다(기존 불변조건).
- **iDRAC 에서 식별된 서버 추가** — '서버 추가' 모달이 `classifyFleet()` 의 베어메탈·가상화 호스트(서비스태그로 식별된 물리 서버) 후보를 보여 주고, 고른 서버를 서비스에
  **수동 지정**으로 넣는다(태그·스캔 라벨보다 우선, 감사 로그). VM 탭은 같은 모달의 보조 경로다(요청 밖이지만 VM 도 손으로 넣는 경우가 있어 둔다).

왜 이 방식인가(조사 근거, 2026-11-03):

- 물리 서버 통합 인벤토리는 이미 있다 — `server/src/insights/fleetInventory.js classifyFleet()` 가 iDRAC·OME·엣지·원격 서버와 ESXi 호스트를
  서비스태그로 합쳐 가상화 호스트/베어메탈로 분류하고, `fleet-tags.json`(수동 분류)·`fleet-assign.json`(법인 귀속)이 예외를 받는다. **'iDRAC 에서 식별된 서버' 목록은 이 함수의 출력 그대로다.**
- 베어메탈 수집 경로도 다섯 가지가 돈다 — 전력·부품·온도(`idrac/`), 사용률(`bmusage/` — iDRAC 텔레메트리 + OS SSH, Windows 는 `parse/winPerf.js`),
  로컬 디스크(`bmstor/`), 부품 장애(`partfault/`), IP(`ipam/ledger.js` serverType BareMetal).
- VM + 물리 혼합 합산의 선례가 있다 — `corpusage/build.js` 가 '사용률 × 용량' 으로 더한다. 서비스별 합산도 같은 규약을 쓴다.
- 트리 저장의 선례가 있다 — `svcmon/store.js`(folders + targets.path, `\` 경로, 디바운스 배치 저장, SAFE_PATH). 같은 규약을 쓰되 저장소는 분리한다(성능점검 대상과 서비스 구성원은 다른 것).
- 없는 것은 **서비스 축**이다. 묶음 수단이 모듈마다 따로 있고 서로 연결되지 않는다:
  - vSphere 태그·사용자 지정 속성은 6시간마다 수집된다(`tags/collect.js`, 스냅샷 `vc.tagInv` 의 vmTags·hostTags·vmCustom). 정책 `tag-policy.json` 에는 requiredCategories·corpCategory 만 있다.
  - iDRAC 스캔 엔트리에 `service` 라벨이 있다(`idrac/scanRanges.js`). 그러나 등록된 서버 항목(`idrac.json`)에는 복사되지 않고 스캔 로그에만 남는다(`registry.js`·`scan.js`·`localScan.js` grep 기준).
    항목에는 `scanRangeId`(v2.742)가 붙으므로 조회 시 엔트리와 조인하면 복원된다.
  - `bmstor` 서버 그룹(최대 3개, 스토리지 전용) · `svcmon` infra/service 폴더 트리(호스트 문자열 키라 VM id·fleetId 와 연결 없음) · VM folder·resourcePool.

## About the Design Files

- `service-map.dc.html` — **최종안(A · 2차)**. 브라우저로 열면 동작하는 HTML 프로토타입(외부 의존 없음, 결정적 목 데이터). 복사 대상이 아니라 재구현 레퍼런스다.
  트리 클릭(법인/폴더/서비스/미지정), 서버 추가 모달(후보 필터·체크·대상 서비스·추가), ＋폴더·＋서비스·이동 인라인 폼이 **메모리 안에서 실제로 동작**한다(저장 없음).
  하단 `<script>` 의 `agg()`(가중 합산)·`groupSvc()`·`buildTree()`(폴더 파생)·`mCandidates()`(후보 필터)·`applySort()`(STable 과 같은 asc→desc→해제, null 뒤로) 는 그대로 옮겨도 된다.
- `CLAUDE_CODE_PROMPT.md` — 구현 단계에 붙여 넣을 프롬프트.
- Chromium 1440px·400px 로 확인했다(콘솔 오류 0 · 페이지 가로 넘침 0 · 트리 → 표 필터 · 모달에서 2대 추가 → 구성원 8→10 · 폴더 3단 생성 · 서비스 생성 · 이동). 스크린샷 파일은 저장소에 두지 않는다(세션 보고에 첨부).

## Fidelity

**High-fidelity.** 색·간격은 `web/src/styles.css :root` 토큰 값 그대로(새 hex 없음). 숫자·법인명·서비스명·폴더명은 **목업**이다 — 실제 값은 API.
프로토타입은 `<table>` 에 자체 정렬을 넣었지만 구현은 공용 `components/STable.jsx`(`minWidth`·`data-sort`) 를 쓴다. 프로토타입은 **전체 범위 관리자 판본**이다(법인 미지정 서버가 후보에 보인다 — 범위 계정에는 보이지 않는다).

## 데이터 모델

### 구성원 키 (새로 만들지 않는다)

| 종류 | 키 | 출처 |
|---|---|---|
| VM | `vm.id` = `vcenterId:moref` | 스냅샷 `vms[]` |
| 베어메탈 | `fleetId` = 서비스태그 소문자(없으면 serverId 소문자) | `classifyFleet().bareMetal[].fleetId` |
| ESXi 호스트 | `fleetId` = 서비스태그 소문자(없으면 호스트명 소문자) | `classifyFleet().virtualizationHosts[].fleetId` |

### 저장소 — `CONFIG_DIR/service-map.json` (비밀 없음 · 원자적 쓰기 · `preserveCorrupt` · mtime+size 무효화 · `bumpFleetRev`)

```json
{
  "rev": "a1b2c3",
  "corps": {
    "<vcenterId>": {
      "folders": ["업무시스템\\개발"],
      "services": [{ "id": "svc_01HX…", "name": "ERP", "path": "업무시스템" }]
    }
  },
  "members": { "<key>": { "serviceId": "svc_01HX…", "by": "admin", "at": 1762128000000 } },
  "rules": [{ "corp": "<vcenterId>|*", "pattern": "^erp-", "service": "ERP" }]
}
```

- 서비스는 **법인 안에서 이름이 유일**(대소문자 무시). 같은 이름이 다른 법인에 있는 것은 정상이다(법인:vCenter:Bareos 1:1:1).
- 폴더는 `folders`(명시) ∪ 서비스 `path` 의 접두 전부로 **파생**한다(`svcmon` 과 같다). 명시 폴더는 서비스가 없어도 남는다. 폴더 삭제는 아래 서비스가 0 일 때만.
- 서비스 삭제: `members` 의 수동 지정은 지운다(구성원은 미지정으로). 태그로 들어온 구성원은 다음 판정에서 **같은 이름의 서비스를 루트에 다시 만들므로** 삭제 전에 경고한다(태그를 먼저 떼야 한다).
- `rev` 는 내용 해시 — 다른 관리자 변경을 조용히 덮지 않는다(`tags/policy.js` 와 같은 stale 거부).
- 상한: 법인당 서비스 500 · 폴더 500 · members 50,000 · rules 200. 넘치면 400(클램프 금지).

### 소속 판정 — 순수 함수 하나 `server/src/servicemap/resolve.js resolveService(member, ctx)`

우선순위(위가 이긴다). 결과는 `{ serviceId, src, reason }` — `src ∈ tag | scan | manual | rule | none | unchecked`.

1. **수동 지정**(`members`) — '서버 추가'·'(미지정) 표의 수동 지정'·CSV 로 들어온 값. ⚠ 1차 시안은 태그가 1순위였다. 2차에서 **수동을 1순위로 올렸다** — 관리자가 이 화면에서 넣은 서버가
   6시간 뒤 태그 갱신으로 다른 서비스로 튀면 '내가 넣었는데 사라졌다' 가 된다. 태그와 다르면 구성원 행에 `conflict:{tag:'…'}` 로 밝힌다(조용히 이기지 않는다).
2. **vSphere 태그** — `tag-policy.json` 의 `serviceCategory`(카테고리 **이름**, 대소문자 무시)가 가리키는 카테고리의 태그 이름 = 서비스명. VM 은 `tagInv.vmTags[ref]`, 호스트는 `tagInv.hostTags[ref]`.
   그 법인 트리에 같은 이름의 서비스가 없으면 **루트에 자동 생성**(폴더는 사람이 옮긴다 — 자동 생성은 `services[].auto:true` 로 표시). MULTIPLE 로 태그가 둘이면 첫 번째 + `multi:true`.
   태그를 못 읽은 vCenter(`tagInv.tags === null`·`tagsPartialOf()`)의 구성원은 `unchecked` 이지 미지정이 아니다.
3. **iDRAC 스캔 엔트리 service** — `idrac.json` 항목 `scanRangeId` → `idrac-scan-ranges.json` 엔트리 `service`(비어 있으면 통과). 복사하지 않고 조인한다. 엣지 보고 베어메탈은
   엣지 push 에 `service` 를 싣고 중앙 정제 화이트리스트에 넣는다(구버전 엣지는 빈 값 = 통과). 서비스가 트리에 없으면 루트에 자동 생성(②와 같다).
4. **이름 규칙(선택)** — `rules[]`. 입력은 길이 128 로 자른 뒤 매칭, 패턴은 저장 시 길이 상한 + 중첩 수량자 금지 정적 검사. 기본 비활성.
5. **(미지정)** — 위 넷 다 아니면. `reason` 에 왜인지(`no-tag-category` · `host-no-tag` · `scan-service-empty` · `no-corp` · `not-registered`).

판정 코어는 **서버 한 곳**이고, 웹은 `src`·`reason` 코드를 문장으로 바꾸기만 한다(`web/src/views/tools/serviceMapText.js`).

### '서버 추가' 후보 — `server/src/servicemap/candidates.js listCandidates({ kind, corp, unassignedOnly, q, user })` (순수 + 얇은 래퍼)

- `kind:'phys'` = `classifyFleet().bareMetal` ∪ `virtualizationHosts`(iDRAC 받침 여부와 무관하게 서비스태그가 있는 호스트 전부 — 'iDRAC 에서 식별' 의 뜻은 **서비스태그로 식별됐다**이다).
  `kind:'vm'` = 스냅샷 `vms`(템플릿 제외).
- 행: `key, name, kind(BM|HOST|VM), serviceTag, model, addr(iDRAC 주소), corp, found(등록 경로: scan-entry|manual|ome|edge|remote|vcenter), current:{serviceId, src}`.
  `addr`·`serviceTag` 는 **관리자 판본만**(`auth/demoGuest.js isAdminDetailUser`) — 그 외는 `auth/addressMask.js maskIdentityFields` 로 가린다(`bmusage/targets.js` 가 이미 같은 방식).
- 범위: `corp` 는 `scopedVcenterIds` 교집합 **먼저**. 법인 귀속이 없는 서버(`corp:''`)는 전체 범위 관리자에게만 후보다. 상한 5,000 + `omitted`.
- 추가 저장(`PUT /admin/service-map/members`): ① 대상 서비스의 법인 ≠ 서버 법인이면 거부(409 `corp-mismatch` — 법인을 넘는 이동은 fleet-assign 에서 귀속을 먼저 바꾼다)
  ② 법인 귀속이 없는 서버면 `fleet-assign` 에 그 법인을 **먼저** 쓰고 성공한 뒤 `members` 를 쓴다. 파일이 둘이라 원자성은 없다 — members 쓰기가 실패하면 fleet-assign 을 되돌리고 경고 로그, 응답에 `partial:true`.
  ③ 감사 로그 1건(키 목록·서비스·법인·요청자).

### 집계 — `server/src/servicemap/build.js buildServiceMap(snap, ctx)` (순수)

- 묶음 단위는 **(법인, 서비스)**. 폴더 노드의 수치는 그 아래 서비스의 합(같은 규약으로 다시 합산 — 평균의 평균 금지). 전 법인 합계는 별도 `totals`.
- CPU·메모리는 `corpusage/build.js` 규약 — 구성원마다 `사용률 × 용량` 을 더하고 `Σ사용 ÷ Σ용량`. 지표마다 따로 센다.
  용량: VM = `cpuCount`·`memMB`, 베어메탈 = `bmusage` 표본의 코어·메모리(없으면 `noCap`), 호스트 = `cpuCores`·`memGB`.
- 사용률 출처: VM = 스냅샷 `cpuUsagePct`·`memUsagePct` · 베어메탈 = `bmusage/db.js latestUsage()`(`srcOf` 로 idrac/os 밝힘, `freshMs` 초과는 stale) · 호스트 = `corpusage` 가 쓰는 같은 경로.
- 부품 장애 = `partfault/db.js openFaults()` 를 `deviceKey`(서비스태그) 로 조인. 엣지 보고가 오래된 법인(`classifyEdges` stale)은 '—'.
- 백업 = 그 법인의 Bareos 최근 24h 잡 결과를 VM 이름으로 조인(`bareos/vmView.js` — 구현 시 export 확인). Veeam 은 후속.
- `unread`·`stale`·`noCap`·`unchecked` 는 **합계에 넣지 않고 따로 센다**. 분모 0 이면 null('—').

### 세 질문(DEV-METHOD ③)

- **이 값을 못 읽으면?** — 구성원은 남고 지표만 '—'. 태그를 못 읽은 vCenter 는 `unchecked`. `service-map.json`·`idrac.json` 을 못 읽으면 빈 트리를 내리지 않고 503(`registryUnreadable`).
  트리 저장이 손상되면 `preserveCorrupt` 후 **빈 트리로 시작하지 않고 503** — 빈 트리를 보여 주면 관리자가 '다 지워졌다' 고 판단해 다시 만든다.
- **범위 계정이면?** — 트리는 허용 법인 노드만. 수치·후보·구성원 전부 `scopedVcenterIds` 교집합 먼저. 쓰기(폴더·서비스·구성원)는 '조회 밖 404 → 쓰기 밖 403' 한 함수(`servicemap/access.js corpWriteAccess`).
  법인 귀속 없는 서버·전 법인 설정은 범위 계정에 없다. `memoJson` + `extraKey: scopeKey(...)`.
- **엣지 위임이면?** — 중앙은 엣지가 push 한 fleet·bmusage·part-fault 요약을 조인만 한다. TTL 을 넘긴 법인은 지표·장애를 '—' 로 보이고 배너로 말한다. 엣지 push 의 `service` 필드는 엣지 업그레이드가 필요하므로
  구버전 엣지 법인은 규칙 ③ 이 비어 **수동 지정('서버 추가')으로만** 채워진다 — 소속 규칙 탭이 버전 단위로 밝힌다.

## 권한 (법인별 관리)

| 계정 | 트리·수치 | 서버 추가·수동 지정 | 폴더·서비스 만들기·이동·삭제 | 태그 카테고리·이름 규칙 |
|---|---|---|---|---|
| 전체 범위 admin | 전 법인 + 법인 미지정 | 전부 | 전부 | 가능(`fullScopeOnly`) |
| 법인 관리자(admin/operator · `writeVcenters ∋ corp`) | 허용 법인만 | 자기 법인 서비스로만 · 법인 미지정 서버는 후보에 없음 | 자기 법인만 | 403 |
| 범위 조회 계정(operator, 쓰기 범위 없음) | 허용 법인만 | 403(버튼 잠금 · `ErrorBox` 권한 안내) | 403 | 403 |
| viewer | 허용 법인만(`requirePerm('insights')`) | 403 | 403 | 403 |

`GET /tools/service-map` 응답의 각 법인 노드에 `writable:true|false` 를 실어 화면이 버튼을 잠근다(게스트 조사 작업 `guestScanAccess` 와 같은 모양).

## API

| 메서드 · 경로 | 권한 | 응답(요지) |
|---|---|---|
| `GET /api/tools/service-map` | `requirePerm('insights')` + scope | `{ corps:[{ vcenterId, name, writable, folders:[...], services:[{id,name,path,auto}], unassigned:n }], services:[{corp, id, path, name, members:{vm,bm,host}, on, total, cpu, mem, faults, backup, src:{manual,tag,scan,rule}, unread, stale, unchecked, conflicts}], totals, meta:{tagsAt, tagRefreshMs, bmAt, bmPeriodMs, snapAt, faultsAt, edges:[{agent,state,version}]}, unreadable:[] }` |
| `GET /api/tools/service-map/members?corp=&service=&folder=&kind=` | 같음 | `{ items:[{key, name, kind, corp, serviceId, src, reason, conflict, on, cpu, mem, msrc, faults, backup, ip}], omitted }` — 상한 5,000 |
| `GET /api/tools/service-map/candidates?kind=phys|vm&corp=&unassignedOnly=1&q=` | 같음 + 범위 | §후보 · 비관리자 판본은 주소·서비스태그 가림 |
| `GET /api/tools/service-map.csv` | 같음 + `canCsv` | 구성원 표 그대로 · `exportBusy` 동시 1건 |
| `PUT /api/admin/service-map/members` | admin/operator + `corpWriteAccess` | `{ items:[{key, serviceId|null}] }` ≤ 500 · 409 corp-mismatch · `partial` · 감사 |
| `POST /api/admin/service-map/folders` · `DELETE …/folders` | 같음 | `{ corp, path }` · 삭제는 빈 폴더만 · rev 대조 |
| `POST /api/admin/service-map/services` · `PATCH …/services/:id`(이름·path 이동) · `DELETE …/services/:id` | 같음 | 법인 안 이름 유일 · 이동은 같은 법인 · 삭제 전 태그 기반 구성원 수 경고(`?force=1`) · 감사 |
| `GET/PUT /api/admin/service-map/settings` | admin · `fullScopeOnly` | `{ serviceCategory, rules, rev }` · rev 대조 |

캐시: `memoJson` 30초 + `scopeKey`. 세대 키 = `fleetRev` + 스냅샷 at + `service-map.json` mtime. 트리 쓰기는 디바운스 배치(200ms, `svcmon` 과 같다 — 모달에서 500대를 한 번에 넣어도 fsync 1회).

## Screens

화면은 도구 하나. 1100px 이상은 **좌 트리(240px) + 우 내용**, 그 아래는 세로로 쌓인다.

1. **안내 카드** — 트리·판정 순서·'서버 추가' 가 수동 지정이라는 것·법인별 관리 범위를 한 문단으로. `BoldText` 규약(백틱 금지).
2. **KPI 5장**(`Card`) — 선택한 노드 기준. 서비스(폴더 수·법인 수) · 구성원(VM/베어메탈/호스트) · (미지정) · 열린 부품 장애 · 못 읽음(+엣지 오래됨). 클릭하면 뷰 전환.
3. **트리 카드** — 전체 법인 › 법인(🏢) › 폴더(📁, 빈 폴더 표시) › 서비스(🧩) · 법인마다 ⚠(미지정) · 맨 아래 ❔(법인 미지정, 전체 범위 관리자만). 노드마다 구성원 수. 같은 노드를 다시 누르면 접힘/펼침. '펼침' 버튼은 전부 펼치기/접기.
   범위 계정은 자기 법인 노드만 받는다(서버가 자른다 — 화면이 숨기는 것이 아니다).
4. **내용 헤더** — 브레드크럼(전체 법인 › 법인 › 폴더… › 서비스) + 뷰 세그먼트(서비스별 · 구성원 · 소속 규칙).
5. **툴바** — 검색 · ＋ 폴더 · ＋ 서비스 · 이동(서비스 노드일 때만) · ⊕ 서버 추가(iDRAC) · CSV. 쓰기 권한이 없으면 버튼을 잠그고 툴팁으로 이유. 인라인 폼 3개(폴더·서비스·이동)는 툴바 아래 한 줄.
   완료 메시지는 초록 배너(무엇을 어디에, 감사 로그 1건).
6. **서비스별 표**(`STable minWidth={1040}`) — 서비스 · 폴더 · 법인 · VM · 베어메탈 · 호스트 · 켜짐/전체 · CPU(가중) · 메모리(가중) · 부품 장애 · 백업 24h · 소속 근거(수동 n · 태그 n · 스캔 n) · 못 읽음.
   `(미지정)` 행은 amber + '규칙 없음' 배지로 항상 맨 아래(data-sort `￿`). 행 클릭 → 아래 구성원 패널.
7. **구성원 표**(`STable minWidth={1100}`) — 이름(물리는 서비스태그 보조행) · 종류 · 서비스 · 법인 · 소속 근거 · 전원 · CPU · 메모리 · 지표 출처 · 부품 장애 · 백업 · IP. 종류 칩 필터. 수동 지정과 태그가 다르면 `conflict` 배지.
8. **서버 추가 모달**(`Modal`, 최대 1120px) — 탭(iDRAC 서버 · VM) · 법인 select(노드가 법인 안이면 고정) · 구분 칩(전체·베어메탈·가상화 호스트) · '미소속만'(기본 켬) · 검색 · 후보 수.
   표: 체크 · 이름 · 서비스태그 · 모델 · iDRAC 주소 · 법인 · 구분 · 식별 경로 · 현재 소속. 푸터: 선택 n대 → 대상 서비스 select(그 법인 서비스만, 선택한 서비스가 기본) · 추가 · 저장 의미 한 줄.
   전부 선택은 **현재 필터의 후보만**. 추가 뒤 모달이 닫히고 배너 + 구성원 패널 갱신.
9. **소속 규칙 탭** — 판정 순서 5단(규칙마다 그 규칙으로 소속된 대수) + (미지정) 표(왜 미지정인지 + 수동 지정 select — 그 법인 서비스만).
10. **각주** — 갱신 시각·주기는 전부 `meta` 값.

400px: KPI 자동 1~2열, 트리가 내용 위에 쌓인다(접힘 상태 유지), 칩·툴바 `flexWrap`, 표는 `STable minWidth` 래퍼, 모달은 화면 폭(가로 스크롤은 표 안에서만). 프로토타입 실측 scrollWidth 400 = innerWidth 400.

## 파일 (구현 시)

- 서버: `src/servicemap/{store.js(service-map.json), resolve.js, build.js, tree.js(폴더 파생·경로 검증), candidates.js, access.js(corpWriteAccess), settings.js}` · `src/routes/api/serviceMap.js` · `src/routes/admin/serviceMap.js` ·
  `src/tags/policy.js`(serviceCategory) · `src/agent/fleetPush.js` + `src/central/fleet.js`(엣지 `service` 필드 + 정제 화이트리스트) · `src/toolcats/catalog.js` PRESET(서버·가상화·리포트) · `src/insights/dbLocation.js` 해당 없음(SQLite 없음).
- 웹: `views/tools/ServiceMap.jsx` + `views/tools/serviceMap/{Tree.jsx, AddServersModal.jsx, InlineForms.jsx}` · `views/tools/serviceMapText.js`(문구·src/reason 문장) · `views/specialToolsList.js`(키 `service-map`, `aka:['서비스 맵','service map','서비스별 서버','폴더']`) ·
  `views/admin/ServiceMapSettings.jsx` · `toolAccess.js`·`taskLabel.js` 등록.
- 테스트: `server/test/serviceMapResolve.test.js`(우선순위 5단 · 수동 > 태그 + conflict · unchecked ≠ none · MULTIPLE 첫 태그 · 자동 생성 루트) · `serviceMapBuild.test.js`(가중 합산 = corpusage 와 같은 입력 같은 출력 · 폴더 합 = 서비스 합 · 분모 0 null · stale 제외) ·
  `serviceMapTree.test.js`(경로 검증 · 파생 폴더 · 빈 폴더 유지 · 삭제 조건 · 이름 유일 · 상한) · `serviceMapCandidates.test.js`(classifyFleet 출력과 같은 집합 · 비관리자 가림 · 범위 교집합 · 법인 미지정은 전체 범위만) ·
  `serviceMapAccess.test.js`(404→403 순서 · corp-mismatch 409 · fleet-assign 선행·되돌림 · memoJson scopeKey · 손상 503) · 웹 `serviceMapText.test.js` · `toolCategories` 프리셋 대조.

## 단계

1. **저장소 + 판정 + 트리**(Opus): store/resolve/build/tree/access + 테스트 + 관리자 API. 화면 없음. 엣지 `service` 필드.
2. **화면**(Opus 구현 · Sonnet Chromium): 트리 + 서비스별/구성원/규칙 + 인라인 폼 + 서버 추가 모달 + 설정 탭 + 카탈로그 + CSV.
3. **후속**: 서비스별 알림 라우팅(담당자) · 일일 리포트 서비스 절 · svcmon 대상 자동 생성(서비스 원장 → 성능점검 트리) · Veeam 백업 조인 · 전력 열.

예상: 1단계 약 2시간 · 2단계 약 2시간 + 검증(verify 약 6분 · Chromium 2회 · CI/릴리스 대기). 30분을 넘기므로 착수 전에 방식(전체 검증/표준/빠르게)을 묻는다.

## 결정 필요 (사용자)

1. vSphere 에 서비스 용도 태그 카테고리가 이미 있는가 — 있으면 이름, 없으면 'Service' 로 만들어 운영팀이 붙이는 운영 절차가 필요하다(포탈이 vCenter 에 태그를 쓰지는 않는다).
2. iDRAC 스캔 엔트리 `service` 라벨을 현장에서 실제로 채워 쓰는가(비어 있으면 규칙 ③ 은 아무것도 못 한다 → '서버 추가' 가 주 경로가 된다).
3. 법인 관리자 권한을 기존 `writeVcenters`(쓰기 범위)로 볼지, 별도 권한 키(`service-map.manage`)를 만들지. 시안은 전자(권한 매트릭스 항목을 늘리지 않는다).
4. 수동 지정을 태그보다 위에 두는 2차 판단에 동의하는지(1차는 태그가 위였다). 반대면 수동은 태그가 없을 때만 쓰고 충돌은 배지로.
5. 첫 화면 열 우선순위(사용률 · 장애 · 백업 · 전력). 전력은 이 시안에 없다 — 넣으면 `power/total.js buildPowerTotal` 조인.

## 정직 기록 — 확인하지 못한 것

- 실제 vCenter 의 태그 운영 현황과 스캔 엔트리 라벨 기입 여부(목 데이터로는 알 수 없다).
- `bareos/vmView.js` 가 '최근 24h 잡 결과' 를 VM 단위로 바로 주는지는 머리말만 봤다 — 구현 시 export 를 확인하고 없으면 후속으로 미룬다.
- iDRAC 전원 제어(원격 리셋)는 소스에서 찾지 못했다 — '관리' 를 전원 제어까지로 본다면 별도 설계다(RMA 는 OS 명령, Redfish 전원 액션은 없음 — grep 기준).
- `classifyFleet()` 가 **중앙 등록부에 없는 엣지 보고 서버의 iDRAC 주소**를 싣는지는 확인하지 않았다(`central/fleet.js` 정제 화이트리스트에 따라 다르다). 없으면 후보 표의 'iDRAC 주소' 는 엣지 보고분에서 '—'.
- 프로토타입의 합산 수식·후보 필터는 각 모듈 머리말 규약을 옮긴 것이고 그 모듈 코드와 **같은 입력으로 대조하지는 않았다** — 구현 테스트가 대조한다.
- 1차 시안(수동 지정 3순위)과 2차(1순위)가 다르다 — §결정 필요 4 에 올렸고, 프로토타입은 2차 기준이다.
