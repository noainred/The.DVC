# Handoff: 특수 기능 › 서비스 인벤토리 — VM + 베어메탈 통합 (시안 A · 3차)

대상 저장소: `noainred/The.DVC` · 기준 커밋 v2.863.0
대상 화면: 새 도구 `#/tools/svc-inventory`(새 키 — 기존 키는 바꾸지 않는다. 통합 서버 인벤토리 `fleet` 의 탭으로 넣는 대안은 §결정 필요) + 설정 › 서비스 인벤토리(전체 범위 관리자)
부수 범위: VM 수집 속성 `config.instanceUuid` 1개 추가 · `service-map.json` 저장소 · 엣지 fleet push 에 `service`(스캔 엔트리 라벨) · 카탈로그 PRESET 배치

> 상태: **시안(초안) 3차**. 2026-11-03 사용자 요청 "VM 과 베어메탈을 서비스 형태로 분리해 통합 관리" → 1차(서비스 축) → 2차(폴더 트리 · 법인별 관리 · iDRAC 식별 서버 추가)
> → "한번 더 생각해서 제안해줘" 의 재검토 7가지를 반영한 3차 → "3차 제안대로 시안 다시 그려줘". 구현 전이고 코드는 바뀌지 않았다.

## Overview

VM(vCenter)과 베어메탈(iDRAC/OS)을 **법인 › 폴더 › 서비스** 로 묶어, 서비스별 구성원·전원·CPU/메모리 가중 사용률·열린 부품 장애·백업 결과를 한 화면에서 본다.
**새 수집기를 만들지 않는다.** 이미 있는 스냅샷·캐시를 읽기 시점에 조인하므로 vCenter·iDRAC 왕복이 0 이고, 고RTT 법인에 부담이 없다.

3차의 핵심 판단(2차와 다른 점 — 근거는 §왜 이 방식인가):

1. **VM 자동 소속의 1순위는 vCenter 폴더 경로 규칙**(접두 → 서비스). 태그는 선택.
2. **서비스는 자동 생성하지 않는다.** '매핑 안 된 값' 패널에서 사람이 만들거나 기존 서비스에 연결한다.
3. **(미지정) 은 출처별 묶음**(vCenter 폴더 · 스캔 엔트리)으로 보여 한 번에 연결한다. 한 대씩 고르는 모달은 예외용.
4. **구성원 = VM + 베어메탈.** ESXi 호스트는 그 서비스 VM 이 올라간 집합으로 **파생**한다('영향 호스트', 거꾸로 '호스트 장애 → 영향 서비스').
5. **수동 지정 = 고정(pin)**. 자동 판정과 다르면 **드리프트 큐**에 올라 관리자가 고른다(조용히 이기는 쪽 없음).
6. **VM 키 = instanceUuid**(수집 속성 추가) · **유령 키** 미리보기 → 정리.
7. **서비스 속성 3개**(등급 1/2/3 · 담당자 · 메모)를 지금 넣는다.
8. 전 법인 뷰 **'서비스명으로 묶기'** 토글(읽기 전용 집계) · 이름은 '서비스 인벤토리'.

## 왜 이 방식인가 (조사 근거, 2026-11-03~04)

- 물리 서버 통합 인벤토리는 이미 있다 — `server/src/insights/fleetInventory.js classifyFleet()` 가 iDRAC·OME·엣지·원격 서버와 ESXi 호스트를 서비스태그로 합쳐 분류한다. 'iDRAC 에서 식별된 서버' 는 이 출력 그대로다.
  유령 키 정리(`fleetGhostReport` · `POST /insights/fleet/prune` 미리보기 → 삭제)도 이미 있다.
- 베어메탈 수집 경로 다섯 가지가 돈다 — 전력·부품·온도(`idrac/`), 사용률(`bmusage/`), 로컬 디스크(`bmstor/`), 부품 장애(`partfault/`), IP(`ipam/`). 혼합 합산 규약은 `corpusage/build.js`(사용률 × 용량).
- **VM 폴더 경로는 매 수집(60초)마다 전 VM 에 이미 있다**(`soapClient.js` `folder: folderPath(p.parent)` · `vmPlacement.js`). 별도 권한·세션이 없다.
  반면 vSphere 태그는 별도 REST 세션(401 이면 vAPI 권한·SSO 문제 — `tags/collect.js` 머리말)·6시간 주기·시간 예산에 잘리면 부분 수집이고, 28개 vCenter 에 태그를 붙이는 새 운영 절차가 필요하다. 그래서 폴더가 1순위, 태그는 선택.
- iDRAC 스캔 엔트리에 `service` 라벨이 있고(`idrac/scanRanges.js` — "한 법인에 서비스가 여러 개, 서비스별 대역·계정·에이전트"), 등록 항목에는 `scanRangeId`(v2.742)가 붙는다. 이 현장은 스캔 엔트리가 이미 '서비스별 대역' 이므로 베어메탈의 대량 소속은 **엔트리 단위**가 자연스럽다.
- 스냅샷에 **VM 단위 instanceUuid 가 없다**(`soapClient.js` 131·254·2277 행은 vCenter 자신의 GUID). moref 는 같은 vCenter 안에서만 안정이라, 다른 vCenter 로 옮기거나 재등록하면 고정이 유령 키가 된다 → 수집 속성 1개 추가.
- 트리 저장의 선례 — `svcmon/store.js`(folders + path, `\` 경로, SAFE_PATH `^[^\\]{1,60}(\\[^\\]{1,60}){0,9}$`, 디바운스 배치 저장). 같은 규약을 쓰되 저장소는 분리한다.
- ESXi 호스트는 클러스터에서 여러 서비스의 VM 을 섞어 돌린다 — 호스트에 서비스를 붙이면 2차 목업처럼 '가상화 기반' 같은 인위적 서비스가 생겼다. 파생이 맞다.

## About the Design Files

- `service-map.dc.html` — **최종안(A · 3차)**. 브라우저로 열면 동작하는 HTML 프로토타입(외부 의존 없음, 결정적 목 데이터). 복사 대상이 아니라 재구현 레퍼런스다.
  뷰 5개(서비스별 · 미지정 · 매핑 안 된 값 · 검토 · 소속 규칙), 트리, 서비스 속성 저장, 미지정 묶음 연결(폴더 규칙·엔트리 라벨), 매핑 안 된 값 조치(서비스로 만들기·별칭), 드리프트 되돌리기/유지, 유령 키 정리, ＋폴더·＋서비스·이동·vCenter 폴더 가져오기, 한 대씩 고정 모달, 서비스명 묶기가 **메모리 안에서 실제로 동작**한다(저장 없음).
  하단 `<script>` 의 `autoResolve()`·`resolve()`(판정 코어 — 고정→폴더→스캔→태그→이름→없음, 드리프트), `agg()`(가중 합산 + 파생 호스트), `unmappedValues()`, `renderUn()` 의 묶음 키, `applySort()` 는 그대로 옮겨도 된다.
- `CLAUDE_CODE_PROMPT.md` — 구현 단계에 붙여 넣을 프롬프트.
- Chromium 1440px·400px 로 확인했다(콘솔 오류 0 · 페이지 가로 넘침 0 · 트리 → 표 · 속성 저장 · 미지정 폴더 묶음 연결로 14→5→3 · 매핑 안 된 값 2→0 · 드리프트 3→2 · 유령 키 2→0 · 규칙 25건 · 서비스명 묶기 13행). 스크린샷은 저장소에 두지 않는다(세션 보고에 첨부).

## Fidelity

**High-fidelity.** 색·간격은 `web/src/styles.css :root` 토큰 값 그대로(새 hex 없음). 숫자·법인명·서비스명·폴더명은 **목업**이다. 프로토타입은 **전체 범위 관리자 판본**이다(법인 미지정 서버가 보인다 — 범위 계정에는 보이지 않는다).
구현은 공용 `components/STable.jsx`(`minWidth`·`data-sort`)·`Card`·`Modal` 을 쓴다.

## 데이터 모델

### 구성원 키

| 종류 | 키 | 출처 |
|---|---|---|
| VM | `iu:<instanceUuid>` — 수집 속성 `config.instanceUuid` 추가. 없는 구버전 스냅샷은 `vm.id`(`vcenterId:moref`)로 폴백하고 키 등급을 밝힌다 | 스냅샷 `vms[]` |
| 베어메탈 | `st:<서비스태그 소문자>`(없으면 serverId 소문자) = `fleetId` | `classifyFleet().bareMetal[]` |
| ESXi 호스트 | 구성원이 아니다 — `vm.host` 로 파생. 부품 장애 조인 키는 호스트 `fleetId` | `classifyFleet().virtualizationHosts[]` |

### 저장소 — `CONFIG_DIR/service-map.json` (비밀 없음 · 원자적 쓰기 · `preserveCorrupt` · mtime+size 무효화 · `bumpFleetRev` · 디바운스 배치 200ms)

```json
{
  "rev": "a1b2c3",
  "corps": {
    "<vcenterId>": {
      "folders": ["업무시스템\\개발"],
      "services": [{ "id": "svc_01HX…", "name": "ERP", "path": "업무시스템", "tier": 1, "owner": "erp-ops@corp.local", "note": "" }],
      "folderRules": [{ "prefix": "vm\\ERP", "serviceId": "svc_01HX…" }],
      "aliases": [{ "kind": "scan", "value": "DB", "serviceId": "svc_01HY…" }, { "kind": "tag", "value": "Payroll", "serviceId": "svc_01HZ…" }],
      "tagCategory": "Service"
    }
  },
  "pins": { "iu:…": { "serviceId": "svc_01HX…", "by": "admin", "at": 1762128000000, "reviewed": false } },
  "nameRules": [{ "corp": "<vcenterId>|*", "pattern": "^erp-", "serviceId": "svc_01HX…" }]
}
```

- 서비스는 **법인 안에서 이름이 유일**(대소문자 무시). 같은 이름이 다른 법인에 있는 것은 정상(법인:vCenter:Bareos 1:1:1).
- 폴더는 `folders`(명시) ∪ 서비스 `path` 접두로 파생. 명시 폴더는 서비스가 없어도 남는다. 폴더 삭제는 아래 서비스가 0 일 때만. 'vCenter 폴더 가져오기' 는 VM 최상위 폴더 이름을 **한 번 복사**(동기화 아님).
- `folderRules` 는 접두 일치(가장 긴 접두가 이긴다). `aliases` 는 스캔 라벨·태그 값 → 서비스. **서비스를 자동으로 만드는 경로는 없다.**
- 서비스 삭제: 그 서비스를 가리키는 `folderRules`·`aliases`·`pins` 를 함께 지운다(구성원은 미지정으로 돌아간다). 삭제 전 영향 대수를 보여 주고 `?force=1`.
- `rev` 는 내용 해시 — 다른 관리자 변경을 조용히 덮지 않는다. 상한: 법인당 서비스 500 · 폴더 500 · 규칙 500 · pins 50,000. 넘치면 400.

### 판정 코어 — `server/src/servicemap/resolve.js resolveService(member, ctx)` (순수, 서버 한 곳)

`auto = autoResolve(member)` → `{ serviceId, src, via, reason, unmapped }`:

1. **vCenter 폴더 규칙**(VM) — `folder` 를 길이 256 으로 자른 뒤 그 법인 `folderRules` 와 접두 비교. 걸리면 `src:'folder'`.
2. **iDRAC 스캔 엔트리 라벨**(베어메탈) — `scanRangeId` → 엔트리 `service` 라벨. 라벨 = 서비스명 또는 별칭이면 `src:'scan'`. 라벨이 비어 있으면 `unmapped:{kind:'entry'}`(미지정 묶음), 라벨이 있는데 서비스가 없으면 `unmapped:{kind:'scan', value}`(매핑 안 된 값).
3. **vSphere 태그(선택)** — 그 법인에 `tagCategory` 가 있을 때만. 폴더 규칙에 안 걸린 VM 에 적용. 태그를 못 읽은 vCenter 는 `unchecked`(미지정 아님).
4. **이름 규칙(선택)** — 길이 128 로 자른 뒤 선형. 저장 시 중첩 수량자 금지.
5. **없음** — `reason` ∈ `no-folder-rule` · `scan-label-empty` · `scan-label-unmapped` · `tag-unmapped` · `host-no-tag` · `no-corp` · `not-registered`.

`resolve(member)`: `pins[key]` 가 있고 그 서비스가 살아 있으면 `src:'pin'`, `drift = auto.serviceId && auto.serviceId !== pin.serviceId`, `reviewed`. 없으면 `auto`.
가리키는 서비스가 지워진 pin 은 무시하고 유령 처리. 엣지 보고 베어메탈은 엣지 push 에 `service`(스캔 엔트리 라벨)를 실어 2번 규칙을 탄다(구버전 엣지는 빈 값 = 라벨 없음).

### 파생 — `build.js buildServiceInventory(snap, ctx)` (순수)

- 묶음 = (법인, 서비스). 폴더 노드 수치는 그 아래 서비스 구성원의 재합산(평균의 평균 금지). 전 법인 '서비스명으로 묶기' 는 같은 이름 구성원을 합쳐 다시 합산(읽기 전용).
- CPU·메모리는 `corpusage/build.js` 규약(사용률 × 용량 ÷ 용량, 지표마다 따로). VM = 스냅샷 quickStats, 베어메탈 = `bmusage latestUsage()`(`srcOf`, `freshMs` 초과는 stale).
- **영향 호스트** = 구성원 VM 의 `host` 집합. 호스트 행에 그 호스트의 사용률(iDRAC 받침 → vCenter 대체)·부품 장애·**함께 떠받치는 다른 서비스**(역조인). 부품 장애 열 = 베어메탈 + 영향 호스트의 열린 장애(`partfault/db.js openFaults()` 를 서비스태그로 조인).
- 백업 = 그 법인 Bareos 최근 24h 잡 결과를 VM 이름으로 조인(`bareos/vmView.js` export 확인). Veeam 은 후속.
- `unread`·`stale`·`noCap`·`unchecked` 는 합계에 넣지 않고 따로 센다. 분모 0 은 null('—').

### 운영 큐 세 가지 (이 도구의 핵심 가치 — 미지정을 빨리 0 으로)

| 큐 | 무엇 | 조치 |
|---|---|---|
| **(미지정) 출처별 묶음** | 규칙에 없는 vCenter 폴더(VM n 대) · 라벨 없는 스캔 엔트리(베어메탈 n 대) · 수동 등록 iDRAC · 법인 귀속 없음 | 폴더 → `folderRules` 추가 · 엔트리 → 엔트리 라벨 기록(`scanRanges` 저장 — 다음 스캔부터 자동) · 수동 등록 → 한 대씩 고정 · 법인 없음 → fleet 에서 귀속 먼저 |
| **매핑 안 된 값** | 규칙 값은 있는데 서비스가 없음: 스캔 라벨 'DB' · 태그 값 'Payroll' · (폴더는 미지정 묶음과 같은 항목) | '서비스로 만들기'(루트에 생성 + 규칙/별칭) · '기존 서비스에 연결'(별칭) |
| **검토** | 드리프트(고정 ≠ 자동) · 유령 키(고정이 가리키는 서버 없음) | 자동으로 되돌리기(pin 삭제) · 고정 유지(`reviewed`) · 유령 정리(미리보기 → 삭제) |

### 세 질문(DEV-METHOD ③)

- **이 값을 못 읽으면?** — 구성원은 남고 지표만 '—'. 태그를 못 읽은 vCenter 는 `unchecked`. 저장소·등록부를 못 읽으면 빈 트리를 내리지 않고 503(`registryUnreadable`). 스냅샷에 instanceUuid 가 없는 VM 은 moref 키 + 등급 표지.
- **범위 계정이면?** — 트리는 허용 법인 노드만(서버가 자른다). 수치·큐·구성원 전부 `scopedVcenterIds` 교집합 먼저. 쓰기(폴더·서비스·규칙·고정·속성)는 '조회 밖 404 → 쓰기 밖 403' 한 함수(`servicemap/access.js corpWriteAccess`). 법인 귀속 없는 서버·전 법인 설정은 범위 계정에 없다. `memoJson` + `extraKey: scopeKey(...)`.
- **엣지 위임이면?** — 중앙은 엣지가 push 한 fleet·bmusage·part-fault 요약을 조인만 한다. TTL 초과 법인은 지표·장애를 '—' 로 보이고 배너로 말한다. 엣지 push `service` 필드는 엣지 업그레이드가 필요하므로 구버전 엣지 법인은 스캔 규칙이 비어 미지정 묶음이 '엔트리 없음' 으로 보인다 — 소속 규칙 탭이 버전 단위로 밝힌다.

## 권한 (법인별 관리)

| 계정 | 트리·수치·큐 | 묶음 연결·고정·속성 | 폴더·서비스 만들기·이동·삭제 | 태그 카테고리·이름 규칙 |
|---|---|---|---|---|
| 전체 범위 admin | 전 법인 + 법인 미지정 | 전부 | 전부 | 가능(`fullScopeOnly`) |
| 법인 관리자(admin/operator · `writeVcenters ∋ corp`) | 허용 법인만 | 자기 법인만 · 법인 미지정 서버는 보이지 않음 | 자기 법인만 | 403 |
| 범위 조회 계정(쓰기 범위 없음) | 허용 법인만 | 403(버튼 잠금 · `ErrorBox`) | 403 | 403 |
| viewer | 허용 법인만(`requirePerm('insights')`) | 403 | 403 | 403 |

응답의 각 법인 노드에 `writable:true|false` 를 실어 화면이 버튼을 잠근다.

## API

| 메서드 · 경로 | 권한 | 응답(요지) |
|---|---|---|
| `GET /api/tools/svc-inventory` | `requirePerm('insights')` + scope | `{ corps:[{vcenterId,name,writable,folders,services:[{id,name,path,tier,owner,note}],rules:{folder:n,alias:n},unassigned:n}], services:[{corp,id,members:{vm,bm},hosts:n,on,total,cpu,mem,faults,backup,src:{pin,folder,scan,tag,rule},unread,stale,unchecked,drift}], queues:{unassigned:n,unmapped:n,drift:n,ghost:n}, totals, meta:{snapAt,snapPeriodMs,bmAt,bmPeriodMs,tagsAt,tagRefreshMs,faultsAt,edges:[{agent,state,version}]}, unreadable:[] }` |
| `GET …/members?corp=&service=&folder=&merge=name` | 같음 | `{ items:[{key,keyKind,name,kind,corp,serviceId,src,via,reason,drift,on,cpu,mem,msrc,faults,backup,host,ip}], hosts:[{name,fleetId,vmN,cpu,mem,faults,otherServices:[]}], omitted }` 상한 5,000 |
| `GET …/unassigned?corp=` | 같음 | `{ groups:[{kind:'folder'|'entry'|'manual'|'nocorp',corp,value,range,members:[key…],n}] }` |
| `GET …/unmapped?corp=` | 같음 | `{ items:[{kind:'scan'|'tag',corp,value,n}] }` |
| `GET …/review?corp=` | 같음 | `{ drift:[{key,name,pin:{serviceId,by,at},auto:{serviceId,src,via}}], ghosts:[{key,serviceId,by,at,reason}] }` |
| `GET …/candidates?kind=bm|vm&corp=&unassignedOnly=1&q=` | 같음 + 범위 | 한 대씩 고정용 후보(비관리자 판본은 주소·서비스태그 가림 — `maskIdentityFields`) |
| `GET /api/tools/svc-inventory.csv` | 같음 + `canCsv` | 구성원 표 · `exportBusy` 1건 |
| `PUT /api/admin/svc-inventory/folder-rules` · `…/aliases` · `…/pins` | admin/operator + `corpWriteAccess` | `{ corp, items:[…] }` ≤ 500 · rev 대조 · 감사. pins 는 법인 불일치 409, 법인 귀속 없는 서버는 fleet-assign 선행(실패 시 되돌림 + `partial`) |
| `POST/PATCH/DELETE …/services` · `…/folders` | 같음 | 이름 유일 · 이동은 같은 법인 · 삭제 전 영향 대수(`?force=1`) · 감사 |
| `PUT …/scan-entry-label` | 같음 | 라벨 없는 엔트리에 서비스명 기록(`idrac/scanRanges.js` 저장 — 엔트리는 그 법인 것만) |
| `POST …/review/{revert,keep}` · `POST …/ghosts/prune?dry=1` | 같음 | 드리프트 조치 · 유령 미리보기/삭제 · 감사 |
| `PUT …/settings` | admin · `fullScopeOnly` | `{ tagCategory(법인별), nameRules }` · rev 대조 |

캐시: `memoJson` 30초 + `scopeKey`. 세대 키 = `fleetRev` + 스냅샷 at + `service-map.json` mtime + `idrac-scan-ranges.json` mtime.

## Screens

1100px 이상은 좌 트리(240px) + 우 내용. 400px 은 세로로 쌓인다(트리 접힘 상태 유지, 표는 `STable minWidth` 래퍼, 페이지 가로 넘침 0 — 프로토타입 실측).

1. **안내 카드** — 파생 호스트 · 판정 순서 · 서비스는 사람이 만든다 · 출처별 묶음 · 드리프트 · 법인별 관리. `BoldText` 규약(백틱 금지).
2. **KPI 5장** — 서비스(등급1 n · 법인 n) · 구성원(VM/베어메탈/영향 호스트) · (미지정) · 매핑 안 된 값 · 검토 필요(드리프트·유령·부품 장애·엣지 오래됨). 클릭하면 그 뷰로.
3. **트리** — 전체 법인 › 법인 › 폴더(빈 폴더 표시) › 서비스(등급 배지 · 구성원 수) · 법인마다 ⚠(미지정) · 맨 아래 ❔ 법인 미지정(전체 범위만). 같은 노드 재클릭 = 접힘/펼침.
4. **내용 헤더** — 브레드크럼 + 뷰 세그먼트(**서비스별 · 미지정 n · 매핑 안 된 값 n · 검토 n · 소속 규칙**). 툴바: 검색 · ＋폴더 · ＋서비스(등급·담당자 포함) · vCenter 폴더 가져오기 · 이동 · ⊕ 한 대씩 추가 · CSV. 인라인 폼 4개. 완료 배너.
5. **서비스별** — (서비스 노드면) **속성 카드**(등급 · 담당자 · 메모 · 저장) → **서비스별 표**(`STable minWidth={1040}`: 서비스 · 등급 · 폴더 · 법인 · VM · 베어메탈 · 호스트(파생) · 켜짐 · CPU · 메모리 · 부품 장애 · 백업 24h · 못 읽음 · 소속 근거(고정n·폴더n·스캔n·태그n)).
   담당자는 서비스명 툴팁과 속성 카드에(열을 줄여 1440px 에서 14열이 다 보인다). 전 법인 뷰에 '서비스명으로 묶기' 체크(법인 열이 'n개 법인'). `(미지정)` 행은 amber, 항상 맨 아래. 행 클릭 → 아래 **구성원 표**(이름·키·vCenter 폴더 / 종류 / 소속 근거(드리프트 표지) / 전원 / CPU / 메모리 / 지표 출처 / 부품 장애 / 백업 / 호스트·IP) + **영향 호스트 표**(호스트 / 이 서비스 VM 수 / CPU / 메모리 / 부품 장애 → 영향 서비스 수 / 함께 떠받치는 서비스).
6. **미지정(출처별 묶음)** — 묶음마다 제목(vCenter 폴더 경로 · 스캔 엔트리 대역 · 수동 등록 · 법인 귀속 없음) + 법인 + 대수 + 조치(서비스 select → '이 폴더를 연결' / '이 엔트리를 연결' / '…서비스로 만들기' · 수동 등록은 '한 대씩 고정' · 법인 없음은 fleet 안내) + 구성원 이름 나열.
7. **매핑 안 된 값** — 출처(스캔 라벨 · 태그 값) · 값 · 법인 · 대수 · 어떻게 생겼나 · 조치('서비스로 만들기' · '기존 서비스에 연결…').
8. **검토** — 드리프트 표(구성원 · 고정된 서비스(누가·언제) · 자동 판정(근거 배지) · 근거 · 자동으로 되돌리기/고정 유지) + 유령 키 표(키 · 고정된 서비스 · 마지막 관측 · 왜 · 정리 버튼).
9. **소속 규칙** — 판정 순서 6단(규칙마다 그 규칙으로 소속된 대수) + 규칙 표(법인 · 폴더 접두/별칭 · → 서비스 · 걸린 VM · 종류).
10. **한 대씩 추가 모달** — 탭(iDRAC 식별 서버 · VM) · 법인 · 미소속만 · 검색 · 표(체크 · 이름 · 키 · 출처(폴더/스캔 엔트리 대역/수동/엣지) · 법인 · 현재 소속) · 대상 서비스 · '고정'. 결과 배너에 드리프트 대수.
11. **각주** — 갱신 시각·주기는 전부 `meta` 값(폴더 규칙은 스냅샷 주기로 반영된다는 문구).

## 파일 (구현 시)

- 서버: `src/servicemap/{store.js, tree.js, resolve.js, build.js, queues.js(unassigned·unmapped·review), candidates.js, access.js, settings.js}` · `src/routes/api/svcInventory.js` · `src/routes/admin/svcInventory.js` ·
  `src/vcenter/soapClient.js`(VM 속성 `config.instanceUuid` 1개 + 스냅샷 `vm.instanceUuid`) · `src/idrac/scanRanges.js`(라벨 쓰기 API 재사용) · `src/agent/fleetPush.js` + `src/central/fleet.js`(엣지 `service` 필드 + 정제 화이트리스트) · `src/toolcats/catalog.js` PRESET(서버·가상화·리포트).
- 웹: `views/tools/SvcInventory.jsx` + `views/tools/svcInventory/{Tree,Queues,AddOneModal,InlineForms,AttrCard}.jsx` · `svcInventoryText.js`(src/reason → 문장) · `views/specialToolsList.js`(키 `svc-inventory`, `aka:['서비스 인벤토리','서비스 맵','service inventory','서비스별 서버']`) · `views/admin/SvcInventorySettings.jsx` · `toolAccess.js`·`taskLabel.js`.
- 테스트: `server/test/svcInvResolve.test.js`(폴더 최장 접두 · 스캔 라벨/별칭 · 태그 선택·unchecked · 이름 규칙 · pin 우선 + drift · 지워진 서비스 pin 무시) · `svcInvBuild.test.js`(가중 합산 = corpusage 같은 입력 같은 출력 · 파생 호스트·역조인 · 폴더 합 = 서비스 합 · 분모 0 null) ·
  `svcInvQueues.test.js`(미지정 묶음 키 · 매핑 안 된 값 · 드리프트·유령) · `svcInvTree.test.js`(SAFE_PATH · 파생 폴더 · 빈 폴더 · 삭제 조건 · 이름 유일 · 상한) · `svcInvAccess.test.js`(404→403 · 409 · fleet-assign 선행/되돌림 · scopeKey · 손상 503 · 법인 미지정은 전체 범위만) ·
  `vmInstanceUuid.test.js`(속성 수집·폴백 등급) · 웹 `svcInventoryText.test.js` · `toolCategories` 프리셋 대조.

## 단계

1. **저장소 + 판정 + 큐 + 평면 서비스 목록**(Opus): store/tree/resolve/build/queues/access + 테스트 + API + instanceUuid 속성 + 엣지 `service`. 화면은 서비스별 표 + 미지정 묶음 + 매핑 안 된 값만(폴더 트리 없이 법인별 평면). 이것만으로 목표 대부분.
2. **트리 + 검토 + 영향 호스트 + 한 대씩 모달 + 속성 카드**(Opus 구현 · Sonnet Chromium).
3. **후속**: 담당자·등급 활용(서비스별 알림 라우팅 `alert-channels` · 일일 리포트 서비스 절) · svcmon 대상 자동 생성 · Veeam 조인 · 전력 열.

예상: 1단계 약 2.5시간 · 2단계 약 2시간 + 검증(verify 약 6분 · Chromium 2회 · CI/릴리스 대기). 30분을 넘기므로 착수 전에 방식(전체 검증/표준/빠르게)을 묻는다.

## 결정 필요 (사용자)

1. 도구 위치 — 독립 도구 `svc-inventory` vs 통합 서버 인벤토리(`fleet`) 안의 탭. 시안은 독립 도구.
2. 법인 관리자 권한 — 기존 `writeVcenters`(쓰기 범위)로 볼지, 별도 권한 키를 만들지. 시안은 전자.
3. iDRAC 스캔 엔트리 라벨을 현장에서 채워 쓰는지(비어 있으면 미지정 묶음에서 '이 엔트리를 연결' 로 채워 가면 된다).
4. 전력 열 포함 여부(`power/total.js buildPowerTotal` 조인) — 시안에는 없다.

## 정직 기록 — 확인하지 못한 것

- 실제 vCenter 의 VM 폴더 체계가 서비스 단위로 나뉘어 있는지(목 데이터로는 알 수 없다 — 아니라면 폴더 규칙 대신 이름 규칙·고정이 주 경로가 된다).
- `bareos/vmView.js` 가 '최근 24h 잡 결과' 를 VM 단위로 주는지는 머리말만 봤다.
- iDRAC 전원 제어(원격 리셋)는 소스에서 찾지 못했다 — '관리' 를 전원 제어까지로 본다면 별도 설계다.
- `classifyFleet()` 가 중앙 등록부에 없는 엣지 보고 서버의 iDRAC 주소를 싣는지 확인하지 않았다(없으면 모달 후보의 주소는 '—').
- `config.instanceUuid` 속성 추가가 수집 시간에 미치는 영향은 측정하지 않았다(속성 1개, VM 당 수십 바이트 — 추정).
- 프로토타입의 합산식·판정 코어는 각 모듈 머리말 규약을 옮긴 것이고 그 모듈 코드와 같은 입력으로 대조하지는 않았다 — 구현 테스트가 대조한다.

## 이력

- 1차(2026-11-03): 서비스 축 + 서비스별 표. 태그 1순위.
- 2차: 폴더 트리 · 법인별 관리 · iDRAC 식별 서버 추가 모달 · 호스트를 구성원에 포함 · 수동 1순위.
- 3차(2026-11-04): "한번 더 생각해서" — 폴더 규칙 1순위 · 자동 생성 금지 · 출처별 묶음 · 호스트 파생 · 고정 + 드리프트 · instanceUuid · 속성 3개 · 서비스명 묶기 · 이름 변경. 이 문서와 프로토타입은 3차 기준.
