# Handoff: 특수 기능 › 서비스 인벤토리 — VM + 베어메탈 통합 (시안 A · 3차)

대상 저장소: `noainred/The.DVC` · 기준 커밋 v2.863.0
대상 화면: 새 도구 `#/tools/svc-inventory`(새 키 — 기존 키는 바꾸지 않는다. 통합 서버 인벤토리 `fleet` 의 탭으로 넣는 대안은 §결정 필요) + 설정 › 서비스 인벤토리(전체 범위 관리자)
부수 범위: VM 수집 속성 `config.instanceUuid` 1개 추가 · `service-map.json` 저장소 · 엣지 fleet push 에 `service`(스캔 엔트리 라벨) · 카탈로그 PRESET 배치

> 상태: **시안(초안) 3차**. 2026-11-03 사용자 요청 "VM 과 베어메탈을 서비스 형태로 분리해 통합 관리" → 1차(서비스 축) → 2차(폴더 트리 · 법인별 관리 · iDRAC 식별 서버 추가)
> → "한번 더 생각해서 제안해줘" 의 재검토 7가지를 반영한 3차 → "3차 제안대로 시안 다시 그려줘".
> **구현됨(v2.887)** — 2026-11-04 사용자 결정 "시안 2 로 가자, 카탈로그 + 매트릭스로 구현 시작해줘"(검증 표준 · 1+2단계 전부 · 독립 도구). 시안과 달라진 점은 §구현(v2.887).

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
| VM | `iu:<vcenterId>:<instanceUuid>` — 수집 속성 `config.instanceUuid` 추가(vSphere API 정의상 **vCenter 안에서만 유일** — 반증 17 — 그래서 vcenterId 를 붙인다). 중앙 정제 `INV_STR_ONLY_KEYS` 에 등재. 없는 구버전 스냅샷은 `vm.id`(`vcenterId:moref`)로 폴백하고 키 등급을 밝힌다. Bareos 조인은 `vm.id` 로 하므로 스냅샷에 둘 다 둔다 | 스냅샷 `vms[]` |
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
      "folderRules": [{ "prefix": "/ERP", "serviceId": "svc_01HX…" }],
      "aliases": [{ "kind": "scan", "value": "DB", "serviceId": "svc_01HY…" }, { "kind": "tag", "value": "Payroll", "serviceId": "svc_01HZ…" }],
      "tagEnabled": true
    }
  },
  "globals": [{ "id": "g-db", "name": "DB", "tier": 1, "owner": "hq-dba@corp.local", "note": "" }],
  "pins": { "iu:<vcenterId>:…": { "serviceId": "svc_01HX…", "corp": "<vcenterId>", "by": "admin", "at": 1762128000000, "reviewed": false } },
  "nameRules": [{ "corp": "<vcenterId>|*", "match": "prefix|suffix|contains|glob", "value": "erp-", "serviceId": "svc_01HX…" }]
}
```

4차 반증으로 바뀐 것: ① `folderRules.prefix` 는 **`vmPlacement.folderPath` 모양**(`/ERP/prod` — 선행 슬래시 · `/` 구분. 화면용 `vm.folder` 는 'vm'·'Datacenters' 이름 폴더를 어느 깊이에서든 빼고 루트를 'vm' 으로 적어 규칙 키로 쓸 수 없다. vApp 안 VM 은 null → `placement-unknown`, 고정으로만) ② 태그 카테고리 이름은 전역 `tag-policy.json serviceCategory` 하나이고 법인별로는 켜고 끄기만(`tagEnabled`) ③ `pins` 에 **법인(`corp`)을 기록**한다 — 구성원 법인이 뒤에 바뀌면 그 고정은 무시하고 검토 큐 `pin-corp-mismatch`, 읽지 못한 법인(vCenter unreachable · 엣지 TTL 초과)의 고정은 유령 판정에서 **보류**(반증 5·16) ④ 이름 규칙은 정규식이 아니라 접두/접미/포함/글로브 4종(반증 14 — 중첩 수량자 금지로는 ReDoS 를 못 막는다) ⑤ `globals`(서비스별 축).
저장 모델은 **svcmon 식 하나**(메모리가 진실 · 디바운스 200ms flush · 단조 증가 `rev` · 쓰기 응답은 flush 결과 — 반증 12). mtime+size 재읽기(fleetAssign 식)와 섞지 않는다. pins 는 `service-map-pins.json` 으로 나눠 변경 감시 백업(`CHANGE_WATCH_EXCLUDE`)에서 빼되 복원에는 포함(반증 18 — 한 대씩 고정 20건이 아카이브 20개가 되지 않게).

- 서비스는 **법인 안에서 이름이 유일**(대소문자 무시). 같은 이름이 다른 법인에 있는 것은 정상(법인:vCenter:Bareos 1:1:1).
- 폴더는 `folders`(명시) ∪ 서비스 `path` 접두로 파생. 명시 폴더는 서비스가 없어도 남는다. 폴더 삭제는 아래 서비스가 0 일 때만. 'vCenter 폴더 가져오기' 는 VM 최상위 폴더 이름을 **한 번 복사**(동기화 아님).
- `folderRules` 는 접두 일치(가장 긴 접두가 이긴다). `aliases` 는 스캔 라벨·태그 값 → 서비스. **서비스를 자동으로 만드는 경로는 없다.**
- 서비스 삭제: 그 서비스를 가리키는 `folderRules`·`aliases`·`pins` 를 함께 지운다(구성원은 미지정으로 돌아간다). 삭제 전 영향 대수를 보여 주고 `?force=1`.
- `rev` 는 내용 해시 — 다른 관리자 변경을 조용히 덮지 않는다. 상한: 법인당 서비스 500 · 폴더 500 · 규칙 500 · pins 50,000. 넘치면 400.

### 판정 코어 — `server/src/servicemap/resolve.js resolveService(member, ctx)` (순수, 서버 한 곳)

`auto = autoResolve(member)` → `{ serviceId, src, via, reason, unmapped }`:

1. **vCenter 폴더 규칙**(VM) — `vmPlacement.folderPath`(null 이면 `placement-unknown`)를 길이 256 으로 자른 뒤 그 법인 `folderRules` 와 **`/` 경계** 접두 비교(가장 긴 접두). 걸리면 `src:'folder'`.
   구현 규칙(반증 9): 규칙은 법인별 `Map` 으로 미리 묶고 길이 내림차순 정렬 1회 · `resolve` 결과는 **요청(세대)당 `Map<key,result>` 로 한 번만** 계산해 트리·큐·표가 공유 · 트리 수는 서비스별 집계에서 폴더로 위로 합산. 테스트가 '판정 호출 수 = 구성원 수' 를 고정한다.
2. **iDRAC 스캔 엔트리 라벨**(베어메탈) — 구성원의 `serverId` 로 `loadRegistry()` 를 다시 찾아 `scanRangeId` → 엔트리 `service` 라벨(분류 출력에는 scanRangeId 가 없다 — 반증 3). 엔트리의 법인 축은 **DataCenter**(`datacenterId` — `datacenters.json assign: {vcenterId: datacenterId}`, vCenter id 가 아니다 — 반증 4) 이므로 `datacenterOfVcenter(구성원 법인) === entry.datacenterId` 로 조인하고, 그 DataCenter 에 vCenter 가 둘 이상이면 규칙을 적용하지 않고 `scan-label-ambiguous` 로 센다.
   라벨 = 서비스명 또는 별칭(대소문자 무시 — 반증 20)이면 `src:'scan'`. 라벨이 비어 있으면 `unmapped:{kind:'entry'}`(미지정 묶음), 라벨이 있는데 서비스가 없으면 `unmapped:{kind:'scan', value}`(매핑 안 된 값).
   ⚠ **구성원의 법인 자체**가 비어 있는 경우가 많다(반증 2): 스캔 등록 서버는 `registerScanned(…, vcenterId:'', datacenterId)` 라 `classifyFleet()` 출력의 `vcenterId` 가 빈 값이고, 이 현장 물리 전용 서버 약 500대가 그렇다(`idrac/corpAttribution.js` 머리말). 구성원 입력은 `corpUsage.js:106` 과 같이 **`attributeBareMetalFromSnap(fleet.bareMetal, snap)`** 을 거친 목록으로 한다(DataCenter 에 vCenter 가 하나면 그 법인으로, `vcSource:'corp-rule'`). 둘 이상이면 `no-corp` 사유를 'DataCenter 에 vCenter 가 n개' 로 밝힌다.
   엣지 보고 베어메탈: 엣지 등록부에는 `scanRangeId` 가 있고(`agent/idracScanWorker.js:212`) 라벨은 중앙에만 있다 → 엣지 push 에 **`scanRangeId` 와 iDRAC 주소 호스트 부분**을 더하고(6개 → 8개 필드 · 중앙 화이트리스트 동일) 라벨 조인은 중앙이 한다. pull(수집 서버) 경로는 `collector/remoteInventory.js SERVER_STR_KEYS` 에 `scanRangeId` 를 더하는 중앙 변경만으로 된다. 구버전 엣지는 두 필드가 없어 '엔트리 없음' 묶음.
3. **vSphere 태그(선택)** — 그 법인에 `tagCategory` 가 있을 때만. 폴더 규칙에 안 걸린 VM 에 적용. 태그를 못 읽은 vCenter 는 `unchecked`(미지정 아님).
4. **이름 규칙(선택)** — 길이 128 로 자른 뒤 선형. 저장 시 중첩 수량자 금지.
5. **없음** — `reason` ∈ `no-folder-rule` · `scan-label-empty` · `scan-label-unmapped` · `tag-unmapped` · `host-no-tag` · `no-corp` · `not-registered`.

`resolve(member)`: `pins[key]` 가 있고 그 서비스가 살아 있으면 `src:'pin'`, `drift = auto.serviceId && auto.serviceId !== pin.serviceId`, `reviewed`. 없으면 `auto`.
가리키는 서비스가 지워진 pin 은 무시하고 유령 처리. 엣지 보고 베어메탈은 엣지 push 에 `service`(스캔 엔트리 라벨)를 실어 2번 규칙을 탄다(구버전 엣지는 빈 값 = 라벨 없음).

### 파생 — `build.js buildServiceInventory(snap, ctx)` (순수)

- 묶음 = (법인, 서비스). 폴더 노드 수치는 그 아래 서비스 구성원의 재합산(평균의 평균 금지). 전 법인 '서비스명으로 묶기' 는 같은 이름 구성원을 합쳐 다시 합산(읽기 전용).
- CPU·메모리는 `corpusage/build.js` 규약(사용률 × 용량 ÷ 용량, 지표마다 따로). VM = 스냅샷 quickStats, 베어메탈 = `bmusage latestUsage()`(`srcOf`, `freshMs` 초과는 stale).
- **영향 호스트** = 구성원 VM 의 `host` 집합. 호스트 행에 그 호스트의 사용률(iDRAC 받침 → vCenter 대체)·부품 장애·**함께 떠받치는 다른 서비스**(역조인).
  부품 장애 열은 **구성원 장애와 영향 호스트 장애를 나눠** 보인다(호스트 장애는 서비스 여럿에 공유되어 열 합이 KPI 와 다르다 — 반증 19). `openFaults()` 는 DB 를 못 열면 `[]` 를 주므로 `partFaultDbStatus()` 로 가용 여부를 따로 보고 못 읽으면 null('—')·KPI '장애 모름 n법인'(반증 10). 엣지 보고분은 담당 agent 의 행만.
- 집계는 `corpusage/build.js` 의 `judgeServer`+`addAgg` 를 **그대로 호출**한다(복제 금지 — 반증 15. 프로토타입 `agg` 는 `noCap`·`stale` 을 세지 않는다). 태그는 `tags/analyze.js tagStateOf·tagsPartialOf` 로 `unchecked`/`partialUnchecked`.
- 백업 = 그 법인 Bareos 원장 `jobDigests()` 를 **`(vcenterId, vmId)`** 로 조인(이름이 아니다 — 같은 이름 VM 이 둘일 수 있다. 반증 11). 법인 `directorState().resultsKnown=false` 면 null('—'), 베어메탈은 해당 없음. Veeam 은 후속.
- 베어메탈 전원은 `getInventory(serverId)?.powerState`(없으면 null — 엣지 보고분은 중앙에 없다) 로 채우고 켜짐 분모에서 뺀다(반증 21).
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
| 범위 operator(`writeVcenters` 미설정 = **쓰기 범위 = 조회 범위**, `auth/scope.js:33-38` 기본값) | 허용 법인만 | 허용 법인 전부 · 법인 미지정 서버는 보이지 않음 | 허용 법인 전부 | 403 |
| 쓰기 범위를 좁힌 operator(`writeVcenters` 일부) | 조회 범위 | 쓰기 범위 법인만(조회만 되는 법인은 403 · 버튼 잠금 · `ErrorBox`) | 같음 | 403 |
| viewer | 허용 법인만(`requirePerm('insights')`) | 403 | 403 | 403 |

⚠ 4차 반증 6: 3차 표는 '쓰기 범위 없음 → 403' 이었는데 저장소 규약과 반대다(미설정 = 조회 범위에 쓰기 가능 — `server/CLAUDE.md` "이 기본값을 바꾸면 전 계정이 잠긴다").
'조회만' 계정은 viewer 역할 또는 `writeVcenters` 를 다른 vCenter 로 지정한 계정이다. `corpWriteAccess` 는 `inUserScope → 404`, `inUserWriteScope → 403` 두 함수만 쓴다.
응답의 각 법인 노드에 `writable:true|false` 를 실어 화면이 버튼을 잠근다. 비관리자 판본(`isAdminDetailUser` 아님)에는 스캔 엔트리 **대역(CIDR)·iDRAC 주소·서비스태그를 싣지 않는다**(묶음 제목은 '엔트리 #n' — 반증 13).

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
| `PUT …/scan-entry-label` | 같음 | `scanRanges.js` 에 **전용 `setScanRangeLabel(id, service, {datacenterId})`** 를 둔다(반증 7): 존재 확인(없으면 404 — `saveScanRanges` 는 모르는 id 에 새 엔트리를 만든다) · `entry.datacenterId === datacenterOfVcenter(corp)` · `service` 외 필드 불변(비밀번호·대역·agent 는 손대지 않으므로 `secretCarry` 가 비밀을 폐기하지 않는다) · 라벨 128자(`saveScanRanges` 와 같은 상한) · 이미 라벨이 있으면 덮지 않음 · 감사 action `svc-inventory.scan-label` |
| `POST …/review/{revert,keep}` · `POST …/ghosts/prune?dry=1` | 같음 | 드리프트 조치 · 유령 미리보기/삭제 · 감사 |
| `PUT …/settings` | admin · `fullScopeOnly` | `{ tagCategory(법인별), nameRules }` · rev 대조 |

캐시: `memoJson` 30초. `extraKey` = `scopeKey | w<writeKeyOf> | a/u(isAdminDetailUser) | f<fleetRev> | sm<serviceMapRev> | sr<scanRangesMtime> | b<bareosRegistryRev>` — 조회 범위만 키에 넣으면 같은 범위의 viewer 와 operator 가 서로의 `writable`·가림 해제 판본을 캐시로 받는다(반증 8). 큰 집계는 전체 범위 결과를 세대 키로 한 번 만들고 범위·역할별 절단만 따로 캐시한다.

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

## 4차 검토(2026-11-04) — 반증 에이전트 + 직접 대조 결과와 반영

"좀더 검토할 것이 있나 한번 더 검토 부탁해" 에 대한 답. 반증 에이전트(별도 세션, 제 결론을 모른 채 코드 대조 — 원문 22건 + 확인 못 함 6건)와 제가 직접 확인한 것을 합쳤다. **높음 5건은 설계를 바꿨고**, 나머지는 위 본문의 해당 자리에 '반증 n' 표지로 넣었다.

| # | 심각도 | 발견(근거) | 반영 |
|---|---|---|---|
| 1 | 높음 | VM `folder` 는 화면용(`/` 구분 · 'vm'·'Datacenters' 이름 폴더를 어느 깊이에서든 제거 · 루트 'vm') — `vm\ERP` 접두는 한 건도 안 걸린다(`soapClient.js:1891-1900`) | 규칙 입력을 `vmPlacement.folderPath`('/ERP/prod', null) 로. **프로토타입 수정**(루트·vApp 묶음 추가) |
| 2 | 높음 | 스캔 등록 베어메탈은 `classifyFleet()` 의 `vcenterId` 가 빈 값(`scanPoller.js:159` vcenterId '') — 현장 약 500대가 '법인 귀속 없음' 큐로 간다 | 구성원 입력을 `attributeBareMetalFromSnap`(DataCenter 에 vCenter 하나면 귀속) 을 거친 목록으로 |
| 3 | 높음 | 엣지 push 에 iDRAC 주소도 `scanRangeId` 도 없고 엣지는 라벨을 모른다(`fleetPush.js:227-230` 6필드 · `idracScanWorker.js:212` 는 scanRangeId 만 저장) | 엣지가 `service` 가 아니라 **`scanRangeId` + 주소**를 push, 라벨 조인은 중앙. pull 경로는 `SERVER_STR_KEYS` 에 키 추가 |
| 4 | 높음 | 스캔 엔트리의 법인 키는 DataCenter(`datacenterId`), vCenter id 가 아니다(`datacenters.json assign`) | `datacenterOfVcenter` 로 조인 · vCenter 둘 이상이면 `scan-label-ambiguous` |
| 5 | 높음 | 유령 키 판정에 '못 읽은 출처' 차단이 없다 — vCenter 7시간 불통이면 그 법인 고정 전부가 유령으로 보이고 '정리' 가 지운다(v2.783 P-B3 와 같은 사고 유형) | pins 에 `corp` 기록 · 읽지 못한 법인의 고정은 **판정 보류**(`fleetGhostReport` blocked 재사용). **프로토타입 수정**(보류 행·'고정한 사람·시각' 열) |
| 6 | 중간 | 권한 표 '쓰기 범위 없음 → 403' 은 `writeScopedVcenterIds` 기본값(미설정 = 조회 범위에 쓰기)과 반대 | 권한 표 수정 |
| 7 | 중간 | `saveScanRanges` 는 모르는 id 에 새 엔트리를 만들고 기존 게이트는 `adminOnly+fleetOnly` | 전용 `setScanRangeLabel` · 404 · DataCenter 검사 · 128자 · 덮어쓰기 금지 · 감사 action |
| 8 | 중간 | `memoJson` 키에 쓰기 범위·관리자 판본·Bareos 리비전이 없어 같은 범위의 다른 계정이 서로의 판본을 받는다 | 캐시 키 확장 |
| 9 | 중간 | 프로토타입을 그대로 옮기면 요청마다 구성원 × 규칙 × 노드 재판정(6,400 × 14,000 비교) | 법인별 규칙 Map · 세대당 판정 1회 · 폴더 합산 · '판정 호출 수 = 구성원 수' 테스트 |
| 10 | 중간 | `openFaults()` 는 DB 를 못 열면 `[]` — 장애 0 과 모름을 구분 못 함 | `partFaultDbStatus()` 로 null('—') · KPI '장애 모름' |
| 11 | 중간 | Bareos 조인은 이름이 아니라 `(vcenterId, vmId)` — 같은 이름 VM 둘이면 오판 · `resultsKnown` 규약 있음 | 조인 키 변경 · null 상태 · 베어메탈 해당 없음 |
| 12 | 중간 | mtime+size 재읽기와 디바운스 배치를 섞으면 쓰기 창에서 변경 유실 · 내용 해시 rev 는 두 요청이 같은 값 | svcmon 식 하나(메모리 진실 · 단조 rev · flush 결과 응답) |
| 13 | 중간 | 범위 계정(viewer 포함)에게 스캔 엔트리 대역(CIDR)이 묶음 제목으로 노출 — 기존엔 `adminOnly+fleetOnly` 에서만 | 비관리자 판본은 '엔트리 #n' · 주소·서비스태그 가림 |
| 14 | 중간 | '중첩 수량자 금지' 는 ReDoS 를 못 막는다(`(a|a)*b`) · 128자 상한도 지수 역추적을 못 막는다 | 이름 규칙을 접두/접미/포함/글로브 4종으로 |
| 15 | 중간 | 프로토타입 `agg` 는 `stale`·`noCap`·`unchecked` 를 세지 않는다(`corpusage addAgg` 와 다름) | 집계는 `judgeServer`+`addAgg` **같은 함수 호출** |
| 16 | 중간 | 고정 뒤 구성원 법인이 바뀌어도 판정이 그대로 따른다(A 서비스에 B 법인 서버) | pins `corp` 기록 · 불일치는 무시 + 검토 큐 `pin-corp-mismatch` |
| 17 | 낮음 | `instanceUuid` 는 vCenter 안에서만 유일(API 정의) · 중앙 정제 화이트리스트 미등재 | 키 `iu:<vcenterId>:<instanceUuid>` · `INV_STR_ONLY_KEYS` 등재 |
| 18 | 낮음 | `service-map.json` 은 CONFIG_DIR `*.json` 이라 백업·복원에 **자동 포함**(3차 README 의 '등록 필요' 는 제 오판) — 다만 pins 쓰기마다 변경 감시 백업이 돈다 | pins 파일 분리 + `CHANGE_WATCH_EXCLUDE` |
| 19 | 낮음 | 파생 호스트 장애가 서비스 행마다 더해져 열 합 > KPI | 구성원 장애 / 호스트 장애(공유) 분리. **프로토타입 수정** |
| 20 | 낮음 | 묶기·별칭·서비스명의 대소문자 규칙이 제각각 | 전부 소문자 비교 한 함수. **프로토타입 수정** |
| 21 | 낮음 | 베어메탈 '전원' 의 근거가 분류 출력에 없다(프로토타입 `on:true` 고정) | `invCache.powerState`, 없으면 null · 분모 제외. **프로토타입 수정**(엣지 보고분 '—') |
| 22 | 낮음 | 엣지 `service` 64자 vs 라벨 128자 불일치 | 3번으로 필드 자체가 사라짐 |
| 23 | 낮음(직접) | KPI '검토 필요' 숫자(드리프트+유령)와 부제(부품 장애 포함) 불일치 | **프로토타입 수정** |
| 24 | 낮음(직접) | 28개 법인을 트리에 전부 펼치면 길다 | 첫 법인만 펼친 채 시작 + 트리 검색. **프로토타입 수정** |
| 25 | 낮음(직접) | 고정 == 자동 판정인 '불필요한 고정' 이 쌓인다 | 검토 탭에 '불필요한 고정 n' 목록(되돌리기 일괄) — 구현 시 |
| 26 | 낮음(직접) | 태그 카테고리를 법인별 필드로 두면 전역 `tag-policy.json` 과 두 벌 | 이름은 전역 하나, 법인별은 `tagEnabled` 만 |

반증이 **확인하지 못한 것**(원문 그대로): vSphere 실환경에서 `config.instanceUuid` 의 vCenter 간 유일성·재등록 시 보존 여부 · `invCache.getInventory` 가 엣지 보고 서버에 주는 값 · `bmusage latestUsage()` 키가 서비스태그 없는 엣지 서버에서 중앙 키와 어긋나는 문제(집계를 같은 함수로 쓰면 자동으로 따라온다) · 태그 카테고리 cardinality MULTIPLE 처리(설계: 첫 태그 + `multi:true`) · 한 DataCenter 안 스캔 라벨 중복(코드가 막지 않음).

## 정직 기록 — 확인하지 못한 것

- 실제 vCenter 의 VM 폴더 체계가 서비스 단위로 나뉘어 있는지(목 데이터로는 알 수 없다 — 아니라면 폴더 규칙 대신 이름 규칙·고정이 주 경로가 된다).
- `bareos/vmView.js` 가 '최근 24h 잡 결과' 를 VM 단위로 주는지는 머리말만 봤다.
- iDRAC 전원 제어(원격 리셋)는 소스에서 찾지 못했다 — '관리' 를 전원 제어까지로 본다면 별도 설계다.
- `classifyFleet()` 가 중앙 등록부에 없는 엣지 보고 서버의 iDRAC 주소를 싣는지 확인하지 않았다(없으면 모달 후보의 주소는 '—').
- `config.instanceUuid` 속성 추가가 수집 시간에 미치는 영향은 측정하지 않았다(속성 1개, VM 당 수십 바이트 — 추정).
- 프로토타입의 합산식·판정 코어는 각 모듈 머리말 규약을 옮긴 것이고 그 모듈 코드와 같은 입력으로 대조하지는 않았다 — 구현 테스트가 대조한다.

## 서비스별(전 법인) 축 — 사용자 아이디어(2026-11-04) · 두 결정마다 시안 A/B

> "법인별로 DB 라는 서비스가 있고 그 서비스에 속한 인프라 자원들이 있는데, 전체 법인에서 특정 서비스에 대해서만 보는 화면 — 지금이 법인별 인프라 뷰라면,
> 전체 법인 뷰에서 서비스에 투입된 인프라 자원을 한눈에 보는 기능." 같은 저장소·판정 코어·집계 함수를 **서비스 → 법인 → 구성원**으로 돌려 보는 두 번째 축이다. 새 수집·새 저장 구조 없음.
> 프로토타입 상단의 축 전환 **[법인별 인프라] ↔ [서비스별(전 법인)]** 으로 들어가고, 안에서 두 결정의 A/B 를 토글로 비교한다. 3차의 '서비스명으로 묶기' 토글은 이 축으로 대체했다.

### 결정 1 — 서비스의 전역 정체성

| | A · 카탈로그 + globalId (권장) | B · 이름 일치 |
|---|---|---|
| 모양 | 전체 범위 관리자가 전역 서비스(`globals:[{id,name,tier,owner,note}]`)를 만들고, 법인 서비스에 `globalId` 를 붙인다. 이름이 같으면 자동 제안, 다르면 사람이 연결('DB-Oracle'·'Database' → 'DB'). 연결 없는 법인 서비스는 '그 법인에만 있는 서비스' 로 따로 | 법인 서비스 이름(대소문자 무시)이 같으면 같은 서비스 |
| 장점 | 본사가 표준 이름을 정하고 법인은 자기 이름을 쓴다 · 전역 담당자·등급을 둘 수 있다 · 이름이 달라도 한 서비스 | 설정 0 · 즉시 동작 |
| 단점 | 연결 작업 한 번(법인 28 × 서비스 수십 = 수백 건 — 자동 제안으로 대부분) | 'DB'·'DB-Oracle'·'Database' 가 세 조각(프로토타입 B 모드에서 실제로 그렇게 보인다) · 전역 속성 둘 곳 없음 |
| 범위 계정 | 자기 법인에 있는 전역 서비스만 보이고 자기 법인 열만 | 같음 |

### 결정 2 — 서비스별 축의 첫 화면

| | A · 커버리지 매트릭스 (권장) | B · 전역 서비스 목록 |
|---|---|---|
| 모양 | 행 = 전역 서비스, 열 = 법인(지역별 머리글), 칸 = 구성원 수(붉은 배지 = 열린 부품 장애, '?' = 엣지 보고 오래됨, '–' = 없음). 칸 클릭 → 그 서비스·그 법인의 구성원 | 서비스 · 등급 · 전역 담당자 · 법인 수 · VM · 베어메탈 · 호스트 · vCPU · 메모리 GB · 스토리지 GB · BM 코어 · 장애 · 백업 실패 · 못 읽음(`STable`) |
| 답하는 질문 | "DB 가 없는 법인은?", "ERP 가 가장 큰 법인은?", "장애가 어디에?" 를 한눈에 | "전사에서 가장 많이 투입된 서비스는?" 정렬로 |
| 폭 | 28개 법인이면 가로 스크롤 — 지역 머리글 클릭으로 접는다(구현) | 1440px 에 14열이 들어간다(프로토타입 실측) |

둘 다 '한눈에' 의 다른 면을 답하므로 **첫 화면은 A, B 는 같은 축의 토글**로 두는 것을 권한다(프로토타입이 그렇게 되어 있다).

### 공통 — 서비스 하나를 고르면

- KPI 7장: 법인 n · 구성원(VM/베어메탈/영향 호스트) · **vCPU 합 · 메모리 GB 합 · 스토리지 GB 합**(= '투입된 자원' — 할당 합계. VM `cpuCount`·`memMB`·`storageGB` + 베어메탈 코어·메모리) · 장애·백업 실패 · **제외**(못 읽음 n대 · 엣지 오래됨 n법인).
- **법인별 투입 자원 표**(`STable minWidth={1040}`): 법인(툴팁 지역) · 법인 서비스명(전역 이름과 다르면 '연결' 배지) · 담당자 · VM · 베어메탈 · 호스트 · vCPU · 메모리 GB · 스토리지 GB · CPU/메모리(가중) · 부품 장애 · 백업 24h · 못 읽음. 엣지 보고가 오래된 법인은 사용률·장애가 '—'. 행 클릭 → 그 법인의 구성원 표 + 영향 호스트 표(법인별 축과 같은 부품).
- 할당 합계에는 못 읽은 서버도 들어간다(할당은 스냅샷 값) — 사용률 합산에서만 빠진다. 이 차이를 각주가 말한다.

### 데이터 모델·API 추가

- `service-map.json` 에 `globals:[{id,name,tier,owner,note}]`, 법인 `services[].globalId`(선택). 전역 서비스 CRUD 는 `fullScopeOnly`. 전역 삭제 시 법인 서비스의 `globalId` 만 비운다(법인 서비스는 남는다).
- `GET /api/tools/svc-inventory/global?mode=catalog|name` → `{ services:[{key,name,tier,owner,corps:[...],members:{vm,bm},hosts,alloc:{vcpu,memGB,storageGB,bmCores},cpu,mem,faults,bkFail,unread,stale}], local:[{serviceId,corp,name}], matrix:{corps:[...],cells:{[key]:{[corp]:{n,faults,stale}}}} }` · `…/global/:key?corp=` → 법인별 표 + 구성원·호스트 · `…/global.csv`. 모두 `scopedVcenterIds` 교집합 먼저 + `memoJson`/`scopeKey`.
- `PUT /api/admin/svc-inventory/globals` · `PUT …/services/:id/global`(법인 관리자도 자기 법인 서비스의 연결은 바꿀 수 있다 — 전역 서비스 생성은 전체 범위만).
- 테스트: `svcInvGlobal.test.js`(이름 일치 vs globalId 묶음 · 할당 합계 = 구성원 합 · 매트릭스 셀 = 법인별 표 행 · 범위 계정 열 절단 · stale 법인 '?'/'—').

### 결정 필요(추가)

5. 전역 정체성 A(카탈로그) / B(이름 일치) — 시안은 둘 다, 권장 A.
6. 첫 화면 A(매트릭스) / B(목록) — 시안은 둘 다, 권장 A + B 토글.

## 구현(v2.887) — 시안과 달라진 점

결정: 전역 정체성 **A(카탈로그 globalId)** · 첫 화면 **A(커버리지 매트릭스) + 목록 토글** · 독립 도구 `svc-inventory` · 법인 관리자 = 기존 쓰기 범위(writeVcenters) · 전력 열 없음.

- **파일을 줄였다**: 서버는 `servicemap/{store,resolve,build,ops}.js` 네 개(tree·queues·candidates·access 는 build 와 라우트에 합침) + `routes/api/svcInventory.js` 하나. 별도 admin 라우터·설정 화면은 만들지 않았다.
  전역 서비스 추가·수정·삭제와 태그 카테고리는 도구 안(왼쪽 '전역 서비스' · 소속 규칙 탭)에서 **전체 범위 관리자에게만** 열린다. 쓰기는 `POST /tools/svc-inventory/op` 한 경로에 연산 이름(`service.add`·`pins.set`·`global.add` …)으로 보낸다.
- **API 를 합쳤다**: 전역 축 데이터(`global: {globals, cells, unlinked}`)와 법인별 큐 수(`queuesByCorp`)를 본 응답 `GET /tools/svc-inventory` 에 싣는다(별도 `/global` 없음). 구성원·큐·후보는 `…/members`·`…/queues`·`…/candidates`, CSV 는 `…/svc-inventory.csv` 하나.
- **태그 카테고리**는 별도 설정 파일이 아니라 `service-map.json` 의 `settings.tagCategory`. **이름 규칙은 법인별**(전역 아님).
- **법인 없는 구성원은 고정할 수 없다** — 법인 귀속은 통합 서버 인벤토리에서 먼저 정한다(범위 계정에 법인 미지정 구성원을 싣지 않는 규칙과 맞춘다).
- **엣지 fleet push 는 `scanRangeId` 만** 싣는다(라벨 원문 `service` 가 아니라 중앙 스캔 엔트리 id — 라벨은 중앙 등록부에서 읽는다). 중앙 정제 화이트리스트에도 넣었다.
- **이름 일치(B)는 만들지 않았다** — 대신 전역에 연결 안 된 법인 서비스 목록에서 이름이 같은 전역을 '제안' 으로 보여 주고 사람이 연결한다.
- **화면(1440px 실측으로 조정)**: 좌측 메뉴를 편 1440px 에서 표 열이 가로 스크롤 뒤로 숨지 않게 사용률을 CPU·MEM 한 칸, 구성원을 'VM n · BM n / 호스트 · 켜짐' 한 칸으로 합쳤다.
  매트릭스는 법인 수·합계 열을 등급 바로 뒤에 두고 서비스명 열을 붙잡는다(28법인이면 가로 스크롤). 법인을 고르면 탭 숫자도 그 법인 기준이다.
- 테스트: 시안의 여섯 파일 대신 `server/test/svcInventory2887.test.js` 18건 + 웹 `svcInventoryText.test.js` 5건.

## 이력

- 1차(2026-11-03): 서비스 축 + 서비스별 표. 태그 1순위.
- 2차: 폴더 트리 · 법인별 관리 · iDRAC 식별 서버 추가 모달 · 호스트를 구성원에 포함 · 수동 1순위.
- 구현(2026-11-04, v2.887): 시안 2(카탈로그 + 매트릭스) · 1+2단계 전부 — §구현(v2.887).
- 3차(2026-11-04): "한번 더 생각해서" — 폴더 규칙 1순위 · 자동 생성 금지 · 출처별 묶음 · 호스트 파생 · 고정 + 드리프트 · instanceUuid · 속성 3개 · 서비스명 묶기 · 이름 변경. 이 문서와 프로토타입은 3차 기준.
