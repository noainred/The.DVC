/**
 * 외부 공개 API 의 허용 목록 카탈로그 (v2.562) — **순수 모듈**. 판정은 이 파일 하나가 소유한다.
 *
 * ⚠⚠ **거부 기본값이다.** 이 저장소의 `/api/*` 라우트는 686개(조회 204 · 상태변경 280)이고
 * 거기에는 RMA 원격 명령 실행 · VM 프로비저닝 · `shutdown` · 호스트 방화벽 변경 ·
 * 백업 다운로드(= `AUTH_SECRET`·TOTP 시크릿 사본)가 섞여 있다. "전부 노출" 은 외부 포탈의 키
 * 하나가 인프라 전체를 조작할 수 있다는 뜻이므로, **여기 적힌 것만** 나간다.
 *
 * ⚠⚠ **상태변경을 여기 넣지 말 것.** `ENDPOINTS` 의 모든 항목은 GET 이고
 * `test/publicApi2562.test.js` 가 소스에서 그것을 고정한다. 쓰기를 열어야 하면 별건으로
 * 다루고, 그때도 '관리자가 명시적으로 고른 경로만' 이라는 축을 유지할 것.
 *
 * ⚠⚠ **내부 경로를 그대로 노출하지 않는다.** 이 저장소의 응답은 자체 UI 전용으로 만들어져
 * 필드가 자유롭게 바뀐다 — 실제로 `zoning.zones` 가 숫자→배열로, `capacityNote`→
 * `capacityBasisNote` 로 바뀐 전례가 있다. 외부 소비자가 내부 형태에 붙으면 그 변경이
 * **남의 포탈을 깨뜨린다**. 그래서 `/api/v1/...` 은 **선언된 필드만** 투사(projection)하고,
 * 내부 필드가 사라지면 테스트가 먼저 깨진다(소비자가 아니라 우리가 먼저 안다).
 *
 * 분류(`groups`)는 키마다 켠다. 분류를 나눈 기준은 **노출되는 식별자의 민감도**다:
 *   · `inventory` — 개수·합계·상태. 이름·IP 를 주지 않는다(가장 짧은 범위).
 *   · `capacity`  — 용량·사용률 추이. **장비명·법인**이 들어가므로 vCenter scope 가 걸린다.
 *   · `faults`    — 알람·부품 장애. 장비·엔티티 이름이 들어간다.
 *
 * ⚠⚠ **'포탈 자신의 상태' 분류는 1차에서 만들지 않았다**(관리자가 고르지 않았다). 초판에
 * `/portal/status` 를 넣어 뒀는데, 그것이 **선언 필드와 핸들러가 어긋난 채로** 있었다 —
 * 선언은 `uptimeSec`·`source`·`generatedAt` 인데 핸들러는 `startedAt`·`dataSource` 를 만들어
 * `project()` 가 **3개를 영원히 null 로** 채웠고, 근거로 읽던 `config.startedAt`·
 * `collector.lastSeenAt` 은 **이 저장소에 존재하지 않는 필드**였다(grep 0건 — `edgesFresh` 가
 * 언제나 0 이 된다). 요청되지 않은 분류를 '있으니까' 로 함께 실으면 이렇게 검증이 얕아진다.
 * 다시 필요해지면 **근거 필드를 코드로 확인한 뒤** 별건으로 추가할 것.
 */

/** 분류 정의 — 라벨·설명은 화면이 그대로 쓴다(문구를 화면에 복제하지 말 것). */
export const GROUPS = Object.freeze([
  {
    key: 'inventory',
    label: '인벤토리 지표',
    desc: 'vCenter·호스트·VM·데이터스토어·알람의 개수와 합계, 수집 상태. 이름·IP 를 주지 않습니다.',
    sensitivity: 'low',
  },
  {
    key: 'capacity',
    label: '용량 · 사용량 추이',
    desc: '스토리지 용량과 증가량, 데이터스토어 사용률. 장비명·법인이 들어가므로 키의 vCenter 범위가 걸립니다.',
    sensitivity: 'medium',
  },
  {
    key: 'faults',
    label: '장애 · 알람 현황',
    desc: 'vCenter 알람과 물리 부품 장애. 장비·엔티티 이름이 들어갑니다.',
    sensitivity: 'medium',
  },
]);

export const GROUP_KEYS = Object.freeze(GROUPS.map((g) => g.key));
export const GROUP_BY_KEY = Object.freeze(Object.fromEntries(GROUPS.map((g) => [g.key, g])));

/**
 * 공개 엔드포인트 선언. `path` 는 `/api/v1` 아래의 경로다.
 *
 * `fields` 는 **계약**이다 — 여기 적힌 것만 응답에 나가고, 테스트가 실제 응답 키와 대조한다.
 * `scoped: true` 면 키의 vCenter 범위가 적용된다(빈 범위 = 전체).
 */
export const ENDPOINTS = Object.freeze([
  {
    path: '/inventory/summary', group: 'inventory', method: 'GET', scoped: true,
    summary: '전 vCenter 합계 — 개수와 자원 총량',
    fields: ['vcenters', 'hosts', 'vms', 'vmsPoweredOn', 'templates', 'datastores', 'networks', 'clusters',
      'cpuCores', 'cpuTotalMhz', 'cpuUsedMhz', 'memTotalMB', 'memUsedMB', 'storageCapacityGB', 'storageUsedGB',
      'vmVcpu', 'vmRamMB', 'vmProvisionedGB'],
  },
  {
    path: '/inventory/vcenters', group: 'inventory', method: 'GET', scoped: true,
    summary: 'vCenter 별 개수·상태 — 이름과 id 는 주고 자격증명·주소는 주지 않는다',
    fields: ['id', 'name', 'status', 'version', 'hosts', 'vms', 'datastores', 'alarms', 'collectedAt'],
  },
  {
    path: '/inventory/collection', group: 'inventory', method: 'GET', scoped: false,
    summary: '수집 상태 — 첫 수집 중(pending)과 접속 실패(unreachable)를 구분해 준다',
    /*
     * ⚠ 상태값은 스냅샷의 실제 값(`connected`·`pending`·`unreachable`·`maintenance`)을
     *   그대로 센다 — `/health`(`routes/api/overviewNsx.js:88`)와 **같은 기준**이다.
     *   추측 정규식으로 분류하면 두 화면이 다른 수를 말한다.
     */
    fields: ['registered', 'connected', 'pending', 'unreachable', 'maintenance', 'generatedAt', 'source', 'intervalMs'],
  },
  {
    path: '/capacity/datastores', group: 'capacity', method: 'GET', scoped: true,
    summary: '데이터스토어 용량·사용률',
    fields: ['id', 'vcenterId', 'name', 'type', 'capacityGB', 'usedGB', 'freeGB', 'usedPct'],
  },
  {
    path: '/capacity/storage', group: 'capacity', method: 'GET', scoped: false, requiresFullScope: true,
    summary: '스토리지 장비 용량 — 읽지 못한 값은 null 이고 0 으로 채우지 않는다',
    fields: ['deviceId', 'name', 'type', 'totalBytes', 'usedBytes', 'usedPct', 'collectedAt', 'usedUnknown'],
  },
  {
    path: '/capacity/storage-growth', group: 'capacity', method: 'GET', scoped: false, requiresFullScope: true,
    summary: '스토리지 증가량 — 기준선이 없으면 null(추정으로 메우지 않는다)',
    fields: ['deviceId', 'name', 'usedBytes', 'totalBytes', 'observedDays', 'growth', 'unknownUsed'],
  },
  {
    path: '/faults/alarms', group: 'faults', method: 'GET', scoped: true,
    summary: 'vCenter 알람 — 음소거된 것은 제외하지 않고 muted 로 밝힌다',
    fields: ['id', 'vcenterId', 'entity', 'entityType', 'name', 'severity', 'triggeredAt', 'muted'],
  },
  {
    path: '/faults/parts', group: 'faults', method: 'GET', scoped: false,
    summary: '물리 부품 장애 — 확인 불가(unknown)를 정상으로도 장애로도 세지 않는다',
    fields: ['partKey', 'agent', 'scope', 'deviceKey', 'kind', 'partId', 'state', 'openedAt', 'lastSeenAt', 'reason'],
  },
]);

export const ENDPOINT_BY_PATH = Object.freeze(Object.fromEntries(ENDPOINTS.map((e) => [e.path, e])));

/**
 * 이 키가 이 경로를 쓸 수 있는가 — **거부 기본값**.
 *
 * ⚠ 판정을 화면·라우트에서 다시 쓰지 말 것(v2.555 `effectiveToolAccess` 규약). 세 곳이
 *   각자 해석하면 "화면은 숨겼는데 API 는 열려 있는" 상태가 된다.
 *
 * @returns {{ok:boolean, reason?:string, code?:string, endpoint?:object}}
 */
export function endpointAllowed(key, apiPath) {
  const ep = ENDPOINT_BY_PATH[String(apiPath || '')];
  if (!ep) return { ok: false, code: 'unknown-endpoint', reason: '공개되지 않은 경로입니다.' };
  const groups = new Set(key?.groups || []);
  if (!groups.size) {
    return { ok: false, code: 'no-groups', endpoint: ep,
      reason: '이 키에 허용 분류가 하나도 없습니다 — 설정 › 연동 키에서 분류를 골라야 합니다.' };
  }
  if (!groups.has(ep.group)) {
    return { ok: false, code: 'group-denied', endpoint: ep,
      reason: `이 키에는 ‘${GROUP_BY_KEY[ep.group]?.label || ep.group}’ 분류가 없습니다.` };
  }
  /*
   * ⚠⚠ **법인 축이 없는 자원은 범위 키에 부분 데이터를 주지 않는다 — 거절한다**(v2.525 규약).
   *   스토리지 장비는 `datacenterId`(자유 라벨)만 있고 `vcenterId` 가 없어 vCenter 범위와
   *   교집합할 수 없다. 내부 라우트도 같은 이유로 `fullScopeOnly` 다
   *   (`routes/api/storageMon.js:46`). 빈 목록을 주면 '장비 0대' 라는 거짓이 되고,
   *   전량을 주면 범위를 어긴다 — 그래서 403 이다.
   */
  if (ep.requiresFullScope && (key?.vcenters || []).length) {
    return { ok: false, code: 'needs-full-scope', endpoint: ep,
      reason: '이 경로는 vCenter 범위로 나눌 수 없는 자원입니다 — 범위를 지정하지 않은(전체) 키만 조회할 수 있습니다.' };
  }
  return { ok: true, endpoint: ep };
}

/**
 * 선언된 필드만 남긴다 — **계약 집행부**.
 *
 * ⚠⚠ 내부 객체를 그대로 스프레드하지 말 것(v2.500 D/M1 relaycheck · v2.503 S-3 와 같은 사고).
 *   `{...row}` 뒤에 몇 개만 덮어쓰면 하위 객체의 내부 필드가 그대로 나간다.
 * ⚠ 선언에 있는데 원본에 없는 필드는 **`null` 로 채운다** — 소비자가 키 부재와 값 부재를
 *   구분하지 않아도 되게(계약이 안정적이어야 하는 이유다).
 */
export function project(row, fields) {
  const out = {};
  for (const f of fields) out[f] = row != null && Object.hasOwn(row, f) ? row[f] : null;
  return out;
}

/** 목록 투사. */
export function projectAll(rows, fields) {
  return (Array.isArray(rows) ? rows : []).map((r) => project(r, fields));
}
