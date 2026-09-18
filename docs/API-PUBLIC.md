# 공개 조회 API (`/api/v1`) — 외부 포탈 연동 가이드

> 다른 포탈·대시보드가 **이 포탈의 조회 데이터를 읽어 가는** API 입니다.
> 전 엔드포인트(820개) 목록은 [API.md](API.md), 이 문서는 **외부에 공개된 8개**만 자세히 다룹니다.
> 도입 릴리스: **v2.562.0**

---

## 1. 무엇이고, 무엇이 아닌가

| | |
|---|---|
| **조회 전용** | 이 키로는 **어떤 값도 바꿀 수 없습니다.** `/api/v1` 에는 GET 만 있습니다. |
| **허용 목록(거부 기본값)** | 관리자가 키마다 켠 **분류만** 나갑니다. 앞으로 엔드포인트가 늘어도 분류를 켜지 않으면 **자동으로 차단**됩니다. |
| **전용 키** | `CENTRAL_TOKEN`·`COLLECTOR_TOKEN` 과 **다른 자격증명**입니다. 그 토큰들을 여기에 쓰지 마세요(아래 §3). |
| **버전 고정 경로** | `/api/v1` 입니다. 응답 모양을 바꿔야 하면 `/api/v2` 를 새로 냅니다 — v1 은 깨지지 않습니다. |

### 왜 '모든 기능'을 열지 않았나

이 포탈의 `/api/*` 라우트는 **820개**(조회 426 · 상태변경 394)이고, 거기에는 원격 명령 실행 ·
VM 프로비저닝 · 전원 제어 · 호스트 방화벽 변경 · **백업 다운로드(세션 서명키·TOTP 시크릿 사본)**
가 섞여 있습니다. 전부 노출하면 외부 키 하나가 인프라를 조작할 수 있습니다.
그래서 공개한 것은 **관리자가 고른 조회 분류 3종 / 엔드포인트 8개**뿐입니다.

---

## 2. 빠른 시작

### ① 키 발급 (포탈 관리자)

`설정 › Security › 연동 키(외부 포탈 조회 API)` 에서 발급합니다.
권한은 **admin + 설정 소유 계정**입니다.

발급 시 정하는 것:

| 항목 | 뜻 | 비우면 |
|---|---|---|
| 이름 | 어느 포탈이 쓰는 키인지(감사 기록의 식별자) | **필수** — 비우면 발급되지 않습니다 |
| 허용 분류 | `인벤토리 지표` / `용량·사용량 추이` / `장애·알람 현황` | **아무것도 조회 못 합니다**(거부 기본값) |
| vCenter 범위 | 이 키가 볼 수 있는 법인(vCenter) | **전체** — 분류와 방향이 반대이니 주의(§8) |
| 만료일 | 지나면 401 `expired` | **무기한**(화면이 경고합니다) |
| 분당 상한 | 넘기면 429 | 기본 **120회/분** |

> ⚠ **키 값은 발급 직후 한 번만 보입니다.** 서버는 SHA-256 **해시만** 보관하므로 잃으면
> 복구할 수 없고 **재발급**뿐입니다. 발급 화면이 그 사실을 먼저 말합니다.

### ② 첫 호출

```bash
curl -H "X-Api-Key: dvcapi_xxxxxxxx…" https://portal.example/api/v1/
```

`GET /api/v1/` 는 **이 키가 무엇을 쓸 수 있는지** 스스로 확인하는 경로입니다.
분류마다 `allowed: true|false` 가 붙어 나오므로, 연동 첫 단계에서 이것부터 호출하세요.

### ③ 규격 받기

```bash
curl -H "X-Api-Key: dvcapi_…" https://portal.example/api/v1/openapi.json
```

OpenAPI 3.1 문서입니다. **그 키가 쓸 수 있는 경로만** 담깁니다
(전량을 담으면 403 이 날 경로를 '있다' 고 말하게 되므로 그렇게 하지 않습니다).

---

## 3. 인증

```
X-Api-Key: dvcapi_<base64url 43자>
```

`Authorization: Bearer dvcapi_…` 도 됩니다. 단 **접두 `dvcapi_` 가 없으면 이 경로의 키로
보지 않습니다** — 세션 토큰을 실수로 보내도 그 값으로 인증이 시도되지 않게 하기 위함입니다.

| 성질 | 값 |
|---|---|
| 형식 | `dvcapi_` + 난수 32바이트 base64url = **총 50자** |
| 서버 보관 | **SHA-256 해시만**(평문 저장 안 함) · 파일 `api-keys.json`(0600 · 봉인 대상 · git 차단) |
| 검증 | `crypto.timingSafeEqual` 상수시간 비교 |
| 화면 표기 | `sha256:xxxxxxxx(len=50)` **8자 지문**만 — 전체 해시는 어떤 응답에도 나오지 않습니다 |

> ⚠ **`CENTRAL_TOKEN`·`COLLECTOR_TOKEN` 을 재사용하지 마세요.** 그 토큰들은 엣지 수집 데이터
> 열람과 **설정 배포** 권한을 주고, **범위를 좁힐 축이 없습니다.** 외부 포탈에 건네면 조회가
> 아니라 통제 권한을 건네는 것이 됩니다.

> ⚠ 키는 **URL 쿼리스트링에 넣지 마세요.** 프록시 액세스 로그·브라우저 히스토리에 남습니다.
> 이 API 는 쿼리스트링 인증을 받지 않습니다.

---

## 4. 응답 봉투 (고정 계약)

성공 응답은 **항상** 이 6개 키입니다. 바뀌지 않습니다.

```json
{
  "ok": true,
  "apiVersion": "v1",
  "endpoint": "/inventory/summary",
  "generatedAt": 1789727283887,
  "data": { "…": "엔드포인트마다 다름" },
  "meta": { "…": "범위·상한·잘린 개수·주의 문구" }
}
```

| 키 | 뜻 |
|---|---|
| `ok` | 성공이면 항상 `true`. 실패 응답은 `false` + `code`(§9) |
| `apiVersion` | `"v1"` |
| `endpoint` | 요청한 경로(에코) |
| `generatedAt` | **응답을 만든 시각**(epoch ms). 데이터 수집 시각이 아닙니다 — 그것은 `meta.collectedAt` |
| `data` | 객체 또는 배열. **선언된 필드만** 들어 있습니다(§5) |
| `meta` | 범위·상한·주의. 엔드포인트마다 다릅니다 |

### 시각은 전부 **epoch ms 숫자**입니다

`generatedAt`·`collectedAt`·`triggeredAt`·`openedAt`·`lastSeenAt` 모두 밀리초 정수입니다.
ISO 문자열이 섞여 나오지 않습니다.

---

## 5. ⚠ 반드시 알아야 하는 6가지

이 여섯 줄을 모르면 **숫자를 정반대로 읽게 됩니다.**

1. **읽지 못한 수치는 `0` 이 아니라 `null` 입니다.**
   `null` 을 0 으로 읽으면 '사용량 0'·'부하 없음' 같은 **거짓**이 됩니다. 이 포탈은 값을
   읽지 못했을 때 0 으로 채우지 않는 것을 전 기능의 규약으로 삼고 있습니다.
2. **목록은 상한이 있고, 잘리면 밝힙니다.** `meta.truncated: true` + `meta.omitted: <개수>`
   + `meta.limit`(현재 5,000). 조용히 자르지 않습니다.
3. **`meta.scopedToVcenters`** 가 숫자면 그 키의 vCenter 범위로 걸러진 결과이고,
   `null` 이면 범위 제한이 없는 키입니다.
4. **첫 수집이 끝나지 않았으면 빈 배열이 아니라 `503 not-collected`** 입니다.
   '데이터가 없다' 와 '아직 못 모았다' 는 조치가 다르므로 구분합니다.
5. **분당 상한을 넘기면 `429`** 이고 `Retry-After` 헤더(초)가 옵니다. 그 시간 뒤에 재시도하세요.
6. **응답은 `Cache-Control: no-store`** 입니다. 키마다 보이는 범위가 다르므로 중간 캐시가
   섞으면 **남의 법인 데이터가 갑니다.** 프록시를 두더라도 이 응답은 캐시하지 마세요.

### 응답 필드는 '선언된 것만' 나갑니다

`data` 의 키 집합은 서버의 선언(`publicapi/allowlist.js` 의 `fields`)과 **정확히 같습니다.**
내부 객체를 그대로 펼쳐 보내지 않습니다.

- 그래서 내부 구현이 바뀌어도 **이 계약은 그대로**입니다.
- 선언에 있는데 원본에 값이 없으면 키가 사라지는 대신 **`null` 로 채웁니다** — 소비자가
  '키 없음' 과 '값 없음' 을 구분하지 않아도 되게 하기 위함입니다.
- 회귀 테스트가 **응답 키 집합 == 선언 필드**를 대조하므로, 내부 필드가 사라지면
  소비자가 아니라 **포탈 쪽 CI 가 먼저** 깨집니다.

---

## 6. 허용 분류 3종

| 키 | 라벨 | 민감도 | 무엇이 들어가나 |
|---|---|---|---|
| `inventory` | 인벤토리 지표 | low | vCenter·호스트·VM·데이터스토어·알람의 **개수와 합계**, 수집 상태. 개별 VM 이름·IP 는 주지 않습니다 |
| `capacity` | 용량 · 사용량 추이 | medium | 데이터스토어 사용률, 스토리지 장비 용량·증가량. **장비명·법인**이 들어갑니다 |
| `faults` | 장애 · 알람 현황 | medium | vCenter 알람, 물리 부품 장애. **장비·엔티티 이름**이 들어갑니다 |

> 포탈 자신의 상태(엣지 주소·내부 IP·버전)는 **공개하지 않습니다.**

---

## 7. 엔드포인트 8개

아래 예시는 **목 데이터로 실제 호출해 받은 응답**입니다(형식은 실제와 같고 값은 데모입니다).

### 7-1. `GET /inventory/summary` — 전 vCenter 합계

분류 `inventory` · **vCenter 범위 적용** · 단건 객체

| 필드 | 뜻 |
|---|---|
| `vcenters` `hosts` `vms` `datastores` `networks` `clusters` | 개수 |
| `vmsPoweredOn` | 전원 켜진 VM 수 |
| `templates` | 템플릿 수(VM 수에 **포함**되어 있습니다) |
| `cpuCores` `cpuTotalMhz` `cpuUsedMhz` | 호스트 CPU 합계 |
| `memTotalMB` `memUsedMB` | 호스트 메모리 합계 |
| `storageCapacityGB` `storageUsedGB` | 데이터스토어 합계 |
| `vmVcpu` `vmRamMB` `vmProvisionedGB` | VM 에 **할당된** 양(실제 사용량이 아닙니다) |

```json
{
  "ok": true, "apiVersion": "v1", "endpoint": "/inventory/summary",
  "generatedAt": 1789727283887,
  "data": {
    "vcenters": 11, "hosts": 186, "vms": 2242, "vmsPoweredOn": 1918,
    "templates": 138, "datastores": 38, "networks": 33, "clusters": 25,
    "cpuCores": 6936, "cpuTotalMhz": 18288800, "cpuUsedMhz": 10231709,
    "memTotalMB": 112197632, "memUsedMB": 69231477,
    "storageCapacityGB": 1157120, "storageUsedGB": 800543,
    "vmVcpu": 11957, "vmRamMB": 44269568, "vmProvisionedGB": 736552
  },
  "meta": { "scopedToVcenters": null, "collectedAt": 1789727271549 }
}
```

> ⚠ **단위에 주의하세요** — CPU 는 **MHz**, 메모리는 **MB**, 스토리지는 **GB** 입니다.
> 포탈 화면은 GHz·GB·TB 로 보여주므로 같은 수를 다르게 표시합니다(값은 같습니다).
> ⚠ `meta.collectedAt` 은 **스냅샷을 만든 시각**입니다. 봉투의 `generatedAt`(응답 시각)과
> 다른 것이 정상이고, 둘의 차이가 곧 데이터의 나이입니다.

### 7-2. `GET /inventory/vcenters` — vCenter 별 개수·상태

분류 `inventory` · **vCenter 범위 적용** · 배열

필드: `id` `name` `status` `version` `hosts` `vms` `datastores` `alarms` `collectedAt`

```json
{
  "id": "vc-us-east", "name": "vcenter-us-east-01",
  "status": "connected", "version": "8.0.2",
  "hosts": 24, "vms": 240, "datastores": 5, "alarms": 7,
  "collectedAt": 1789727271549
}
```

`status` 값: `connected` / `pending`(첫 수집 전·중) / `unreachable`(접속 실패) / `maintenance`.

> ⚠ **접속처·자격증명은 주지 않습니다.** 이름과 id 까지입니다.

### 7-3. `GET /inventory/collection` — 수집 상태

분류 `inventory` · 범위 적용 안 함(포탈 전체 상태) · 단건 객체

```json
{
  "data": {
    "registered": 11, "connected": 11,
    "pending": 0, "unreachable": 0, "maintenance": 0,
    "generatedAt": 1789727271549, "source": "mock", "intervalMs": 30000
  },
  "meta": { "note": "pending 은 첫 수집이 끝나지 않은 것이고 unreachable 은 접속 실패입니다 — 조치가 다릅니다." }
}
```

> ⚠⚠ **`pending` 과 `unreachable` 을 합치지 마세요.** `pending` 은 기다리면 채워지고
> `unreachable` 은 **기다려도 안 됩니다.** 상대 포탈에서 "N곳 수집 실패" 로 뭉뚱그리면
> 운영자가 멀쩡한 첫 수집을 장애로 보고합니다.
> `source` 가 `mock` 이면 데모 데이터입니다 — **운영 값이 아닙니다.**

### 7-4. `GET /capacity/datastores` — 데이터스토어 용량

분류 `capacity` · **vCenter 범위 적용** · 배열

필드: `id` `vcenterId` `name` `type` `capacityGB` `usedGB` `freeGB` `usedPct`

```json
{
  "id": "vc-us-east:ashburn-ds-vsan-1", "vcenterId": "vc-us-east",
  "name": "ashburn-ds-vsan-1", "type": "vSAN",
  "capacityGB": 32768, "usedGB": 16920, "freeGB": 15848, "usedPct": 51.6
}
```

> ⚠ `capacityGB` 가 0 이거나 `usedGB` 를 읽지 못하면 **`usedPct` 는 `null`** 입니다
> (0 으로 나눈 값을 지어내지 않습니다). `freeGB` 도 같은 규칙입니다.

### 7-5. `GET /capacity/storage` — 스토리지 장비 용량

분류 `capacity` · **전체 범위 키만**(범위 지정 키는 403) · 배열

필드: `deviceId` `name` `type` `totalBytes` `usedBytes` `usedPct` `collectedAt` `usedUnknown`

```json
{
  "data": [],
  "meta": {
    "count": 0, "truncated": false, "omitted": 0, "limit": 5000,
    "usedUnknownCount": 0,
    "note": "사용량을 읽지 못한 장비는 usedBytes 가 null 로 나갑니다(0 으로 채우지 않습니다)."
  }
}
```

> ⚠⚠ **`usedUnknown: true` 인 장비를 '사용량 0' 으로 세지 마세요.** 그 장비는 값을 읽지
> 못한 것이지 비어 있는 것이 아닙니다. 합계를 낼 때 **분모에서 빼고 몇 대를 뺐는지
> 밝히는 것**이 이 포탈의 방식이고, `meta.usedUnknownCount` 가 그 개수입니다.
> ⚠ 범위 지정 키가 403 인 이유는 §8 에 있습니다.

### 7-6. `GET /capacity/storage-growth` — 스토리지 증가량

분류 `capacity` · **전체 범위 키만** · 배열

필드: `deviceId` `name` `usedBytes` `totalBytes` `observedDays` `growth` `unknownUsed`

`growth` 는 기간별 증가 **바이트**입니다: `{ "1d": 123456, "7d": null, "30d": null }`

```json
{
  "meta": {
    "count": 0, "limit": 5000,
    "periods": ["1d", "7d", "30d"], "periodsDropped": 0,
    "unknownUsedCount": 0,
    "note": "기준선이 없는 기간은 null 입니다 — 관측이 짧은 구간을 추정으로 메우지 않습니다."
  }
}
```

> ⚠⚠ **`growth[기간] === null` 은 '증가 0' 이 아닙니다 — '비교할 기준선이 없다' 입니다.**
> 관측이 10일뿐인 장비의 30일 증가량은 만들어 내지 않습니다. `observedDays` 로 그 장비의
> 관측 일수를 확인하세요.
> ⚠ 증가량이 **음수**로 나올 수 있습니다(실제로 줄어든 것). 0 으로 깎지 않습니다.

### 7-7. `GET /faults/alarms` — vCenter 알람

분류 `faults` · **vCenter 범위 적용** · 배열

필드: `id` `vcenterId` `entity` `entityType` `name` `severity` `triggeredAt` `muted`

```json
{
  "id": "vc-us-east:esxi-useast-17:4", "vcenterId": "vc-us-east",
  "entity": "esxi-useast-17", "entityType": "host",
  "name": null, "severity": "critical", "triggeredAt": null, "muted": false
}
```

> ⚠⚠ **음소거된 알람도 목록에 들어 있습니다**(`muted: true`). 빼지 않는 이유는, 빼면
> '알람 없음' 이라는 거짓이 되기 때문입니다. 상대 포탈에서 음소거를 숨기고 싶으면
> **받아서 직접 거르세요** — `meta.mutedCount` 가 그 개수입니다.
> ⚠ 위 예시에서 `name`·`triggeredAt` 이 `null` 인 것은 **데모 데이터에 그 필드가 없기
> 때문**입니다. 운영 vCenter 에서는 채워집니다(못 읽으면 그대로 `null`).

### 7-8. `GET /faults/parts` — 물리 부품 장애

분류 `faults` · 범위 적용 안 함 · 배열

필드: `partKey` `agent` `scope` `deviceKey` `kind` `partId` `state` `openedAt` `lastSeenAt` `reason`

| 필드 | 뜻 |
|---|---|
| `agent` | 어느 법인(엣지)이 보고했는가 |
| `scope` | 장비군(`idrac` / `storage` / `sanswitch`) |
| `deviceKey` | 장비 식별자(서비스태그 → UUID → 로컬 id 순으로 정해집니다) |
| `kind` `partId` | 부품 종류와 그 안의 식별자 |
| `state` | `fault` / `warn` / **`unknown`**(못 읽음) / **`absent`**(빈 슬롯) |
| `reason` | 열려 있는 사유(보류 사유 포함) |

> ⚠⚠ **`unknown`(확인 불가)과 `absent`(빈 슬롯)를 장애로 세지 마세요.** 실제로 겪은 사례가
> 있습니다 — 정상 장비의 빈 DIMM 슬롯 12칸을 고장으로 세면 **정상 장비에 장애 12건**이 찍힙니다.
> 정상으로도 세지 않습니다. `state` 를 그대로 보고 세 갈래로 나누세요.

---

## 8. 범위(scope)와 403

키에 vCenter 범위를 지정하면:

- **범위가 있는 자원**(인벤토리·데이터스토어·알람) → 그 vCenter 것만 나오고
  `meta.scopedToVcenters` 에 개수가 찍힙니다.
- **범위가 없는 자원**(`/capacity/storage`·`/capacity/storage-growth`) → **403 `needs-full-scope`**

```json
{
  "ok": false, "error": "needs-full-scope", "code": "needs-full-scope",
  "reason": "이 경로는 vCenter 범위로 나눌 수 없는 자원입니다 — 범위를 지정하지 않은(전체) 키만 조회할 수 있습니다.",
  "endpoint": "/capacity/storage"
}
```

**왜 빈 목록을 주지 않고 거절하나**: 스토리지 장비에는 vCenter 귀속이 없어 범위와 교집합할
수 없습니다. 빈 목록을 주면 **'장비 0대' 라는 거짓**이 되고, 전량을 주면 범위를 어깁니다.
그래서 "할 수 없다" 고 말합니다. 포탈 내부 화면도 같은 이유로 같은 정책입니다.

> ⚠⚠ **vCenter id 오타는 조용히 0건이 됩니다.** 범위에 없는 id 를 넣으면 거절이 아니라
> **빈 목록**이 나옵니다(그 키에 그 vCenter 가 없는 것과 구분할 수 없기 때문입니다).
> 연동 첫 호출에서 `GET /api/v1/inventory/vcenters` 로 **실제 id 를 확인**하고 범위를 정하세요.
> 실측 예: 범위를 `vc-kr-seoul` 로 준 키가 그 id 가 없는 환경에서 `datastores` 를 부르면
> `{"rows": 0, "meta": {"scopedToVcenters": 1}}` 입니다 — 200 이고 오류가 아닙니다.

---

## 9. 오류 코드

**사유마다 조치가 다르므로 한 문구로 덮지 않습니다.** `code` 로 분기하세요.

| HTTP | `code` | 뜻 | 조치 |
|---|---|---|---|
| 401 | `missing-key` | `X-Api-Key` 헤더가 없음 | 헤더를 넣으세요 |
| 401 | `unknown-key` | 서버가 모르는 값(오타·삭제된 키) | 값을 확인하거나 재발급 |
| 401 | `revoked` | 폐기된 키 | **같은 값은 다시 살아나지 않습니다** — 새로 발급 |
| 401 | `expired` | 만료 | 관리자가 만료일을 늘리거나 재발급 |
| 403 | `no-groups` | 키에 허용 분류가 **하나도 없음** | 관리자가 분류를 켜야 합니다 |
| 403 | `group-denied` | 그 경로의 분류가 이 키에 없음 | 관리자가 그 분류를 켜야 합니다 |
| 403 | `needs-full-scope` | 범위로 나눌 수 없는 자원(§8) | 범위 없는 키를 쓰거나 그 경로를 포기 |
| 404 | `unknown-endpoint` | 공개되지 않은 경로 | `GET /api/v1/` 로 목록 확인 |
| 429 | `rate-limited` | 분당 상한 초과 | `Retry-After` 초 뒤 재시도 |
| 503 | `not-collected` | 첫 수집 미완료 | **잠시 뒤 재시도**(장애가 아닙니다) |
| 503 | `unavailable` | 그 기능 모듈을 불러올 수 없음 | 포탈 관리자에게 문의 |

실패 응답 형태(실측):

```json
{ "ok": false, "error": "missing-key", "code": "missing-key",
  "reason": "X-Api-Key 헤더가 없습니다. 설정 › 연동 키에서 발급한 값을 넣으세요." }
```

> ⚠ **`no-groups` 는 401 이 아니라 403 입니다.** 키 자체는 유효하고 인가가 비어 있는
> 상태입니다 — 401 로 처리하면 멀쩡한 키를 재발급하게 됩니다.
> ⚠ **404 는 경로 목록을 알려주지 않습니다**(열거 단서가 되므로). 목록은 카탈로그(`GET /api/v1/`)
> 에서만 나오고, 거기서는 이미 키가 검증된 상태입니다.

---

## 10. 상한 · 응답 헤더

```
Cache-Control: no-store
X-RateLimit-Limit: 120
X-RateLimit-Remaining: 99
```

| 항목 | 값 |
|---|---|
| 분당 상한 | 키마다 설정(기본 **120**). 창은 60초이고 서버 재시작 시 초기화됩니다 |
| 목록 상한 | **5,000행**. 넘치면 `meta.truncated: true` · `meta.omitted` |
| 초과 시 | `429` + `Retry-After: <초>` |

> ⚠ 레이트리밋은 **인메모리**입니다. 남용 방지가 목적이고 과금 정산용이 아닙니다.

---

## 11. 운영 연동 절차 (권장)

1. 관리자가 키를 발급하고 **분류를 최소로** 켭니다(나중에 늘리는 편이 안전합니다).
2. 연동 담당자가 `GET /api/v1/` 로 **쓸 수 있는 것**을 확인합니다.
3. `GET /api/v1/openapi.json` 으로 클라이언트를 생성하거나 스키마를 고정합니다.
4. `GET /api/v1/inventory/vcenters` 로 **실제 vCenter id** 를 확인합니다(범위를 쓸 경우).
5. 폴링 주기는 포탈의 수집 주기(`/inventory/collection` 의 `intervalMs`)**보다 짧게 잡지
   마세요** — 같은 스냅샷을 반복해서 받게 됩니다.
6. 만료일을 두고, 담당자 변경 시 **폐기 후 재발급**합니다(폐기는 즉시 401 이 됩니다).

### 최소 예제 (Node)

```js
const BASE = 'https://portal.example/api/v1';
const KEY = process.env.DVC_API_KEY;              // 소스에 박지 마세요

async function get(path) {
  const res = await fetch(BASE + path, { headers: { 'X-Api-Key': KEY } });
  const body = await res.json();
  if (!res.ok) {
    if (body.code === 'not-collected') return null;     // 장애가 아니라 '아직'
    if (res.status === 429) throw new Error(`상한 초과 — ${res.headers.get('Retry-After')}초 뒤`);
    throw new Error(`${res.status} ${body.code}: ${body.reason}`);
  }
  if (body.meta?.truncated) console.warn(`잘렸습니다: ${body.meta.omitted}건 누락`);
  return body;
}

const sum = await get('/inventory/summary');
// ⚠ null 을 0 으로 바꾸지 마세요 — '읽지 못함' 과 '0' 은 다릅니다.
const usedPct = sum.data.memTotalMB ? (sum.data.memUsedMB / sum.data.memTotalMB) * 100 : null;
```

---

## 12. 자주 하는 실수

| 실수 | 결과 | 바르게 |
|---|---|---|
| `null` 을 `0` 으로 치환 | '사용량 0'·'부하 없음' 이라는 **거짓 지표** | `null` 을 그대로 두고 '확인 불가' 로 표시 |
| `truncated` 무시 | 5,000행에서 잘린 것을 전체로 보고 | `meta.truncated`·`meta.omitted` 확인 |
| `503 not-collected` 를 장애로 알림 | 재시작 직후마다 오경보 | 재시도하고, 계속되면 그때 알림 |
| `pending` 을 `unreachable` 과 합산 | 멀쩡한 첫 수집을 장애로 보고 | 따로 세기 |
| `unknown`·`absent` 부품을 장애로 집계 | 정상 장비에 장애 수십 건 | `state` 세 갈래로 분리 |
| 응답을 CDN·프록시에 캐시 | **다른 키의 범위 데이터가 섞임** | `no-store` 존중 |
| 키를 쿼리스트링에 | 액세스 로그에 평문 잔존 | 헤더로만 |
| vCenter 범위에 오타 | 조용히 0건 | `/inventory/vcenters` 로 id 확인 |

---

## 13. 한계 · 확인하지 못한 것

정직하게 적습니다.

- **실제 외부 포탈이 이 API 를 소비하는 것은 아직 확인하지 못했습니다.** v2.562 시점까지
  확인한 것은 목 서버를 상대로 401·403·404·429·200 전 경로를 HTTP 로 돌린 것과,
  `/inventory/summary` 의 집계가 포탈 내부 `/summary` 와 **17항목 전부 일치**한다는 것입니다.
  첫 연동에서 `GET /api/v1/` 과 `openapi.json` 을 상대가 읽는지로 확인하십시오.
- **`/capacity/storage`·`/faults/parts` 의 실데이터 응답은 이 환경에 해당 장비가 없어
  빈 배열로만 확인했습니다.** 필드 계약은 테스트가 고정하지만, 실제 값이 들어찬 응답은
  운영 환경에서 처음 보게 됩니다.
- **레이트리밋은 프로세스 재시작으로 초기화**됩니다(인메모리).
- 이 API 는 **읽기 전용이고 앞으로도 그렇습니다.** 쓰기가 필요하면 별건으로 설계해야 하며,
  그때도 '관리자가 명시적으로 고른 경로만' 이라는 축은 유지됩니다.

---

## 관련 문서

- [API.md](API.md) — 전 엔드포인트(820개) 레퍼런스(자동 생성)
- [ARCHITECTURE.md](ARCHITECTURE.md) — 코드 지도와 데이터 흐름
- [SETTINGS.md](SETTINGS.md) — 설정 화면 42개 탭(연동 키는 §24)
