/**
 * partfault/types.js — 물리 파트 장애의 **공용 계약**(순수, v2.547).
 *
 * 사용자 요청(2026-09-17): "서버 스토리지 등의 모든 장비에 있는 물리 파트 장애가 발생하면
 * 노티를 발생하고 체계적으로 파트 장애를 기록하는 DB 와 화면을 만들고 싶어" +
 * "엣지에서 수집해서 로컬에서 처리하고 **장애만** 중앙으로 보내게 해줘".
 *
 * ── 왜 5상태인가 (4가 아니라) ──────────────────────────────────────────────────
 * 이 저장소는 같은 실수를 두 번 겪었다.
 *  · v2.526 Unity 실측: SPA 의 DIMM 24칸 중 `REMOVED` 12칸은 **빈 슬롯**이다. 이상으로 세면
 *    **정상 장비에 장애 12건**이 찍힌다. 상대 SP 의 `UNKNOWN` 은 '읽지 못한 것' 이다.
 *  · v2.519 SAN 월간 점검: 못 본 것을 정상으로 칠하는 것이 "이 기능이 만들 수 있는 가장
 *    위험한 거짓" 이라고 적어 두었다.
 * 그래서 `ok / warn / fault / unknown / absent` 다. `unknown` 과 `absent` 는 **어느 쪽으로도
 * 세지 않는다** — 정상 집계에도, 장애 집계에도 넣지 않고 **각각 따로 밝힌다**.
 *
 * `storage/collectors/svcDiag.js` 의 `FRU_STATE`(ok/empty/unknown/fault)가 이 모델의 원형이다.
 * 거기에 SAN 월간 점검(`sanswitch/healthCheck.js`)의 `warn` 을 더해 다섯으로 맞췄다 —
 * 두 체계를 하나로 합치기 위해서다(코어는 하나다).
 *
 * ── 파트 식별 키의 신뢰도를 반드시 함께 저장한다 ────────────────────────────────
 * 장비군마다 식별자의 질이 다르다. 조사(v2.547)에서 확인한 것:
 *  · **있다**: iDRAC DIMM `DeviceLocator`(물리 슬롯) · 디스크 `SerialNumber` · CPU `Socket`
 *  · **없다**: 스토리지 컨트롤러(시리얼·슬롯 없음 — 같은 모델 2장이면 구분 불가) · GPU ·
 *    SAN PSU/팬(개수만 센다)
 *  · **위험**: `nodes.list` 의 `id` 가 7개 수집기에서 **합성 순번 `i+1`** 이다
 *    (unity.js:43 · powerstore.js:92 · powerstoreSsh.js:94 · xtremio.js:63 · xtremioSsh.js:96 ·
 *     vplex.js:57 · vplexSsh.js:91). 장비가 순서를 바꾸면 **같은 파트가 다른 파트로 기록**돼
 *    없던 장애가 생기고 있던 장애가 닫힌다.
 * 그래서 `keyKind` 를 **레코드에 함께 실어** 화면이 그 신뢰도를 밝힌다. 지어내지 않는다.
 *
 * ── v2.548 재설계 (사용자 지시 "이게 가능한지 검토, 다시 설계해줘") ─────────────────────
 * 6축 조사 + 적대적 반증으로 v2.547 의 확정 결함 9건을 찾았다(전부 코드 실행으로 재현). 이 파일이
 * 바뀐 이유는 그중 **키 체계** 두 건이다:
 *  · **F2 — 파트 키에 법인(agent) 축이 없었다.** `idrac/registry.js:248·272` 는 서버 id 를 **IP
 *    문자열**로 발급하고 등록부에 agent 개념이 없다. 두 법인이 같은 사설 IP 를 쓰면 서로 다른 물리
 *    서버가 중앙 DB 에서 **같은 행**이 되고, 한쪽의 열린 장애가 다른 쪽 관측으로 **거짓 '복구'**
 *    처리된다 — 이 기능이 스스로 '최악의 거짓' 이라 적어 둔 바로 그 경로였다.
 *    → 장비 키를 **등급화**한다(`DEVICE_KEY_KIND`): iDRAC 은 `serviceTag`(redfish.js:304) →
 *      `uuid`(:307) → 로컬 id 순으로 고르고 어느 것을 썼는지 레코드에 남긴다. 이 판단은
 *      `collector/remoteInventory.js:56` 이 이미 내려 둔 것이라 새 발명이 아니다. 스토리지·SAN 은
 *      중앙이 발급한 전역 유일 id(`st-`/`sw-`)를 그대로 쓴다. 그리고 **DB 기본키는
 *      `(agent, part_key)`** 다(`db.js`) — 키가 약한 장비라도 법인이 다르면 행이 갈린다.
 *  · **F1 — 수집 실패가 '부품 0개 = 정상' 으로 읽혔다.** `redfish.js fetchInventory` 는 어떤 경우에도
 *    던지지 않고(모든 블록이 `catch {}`), 연결 거부에도 29ms 만에 **신선한 빈 인벤토리**를 돌려준다.
 *    → 인벤토리에 **컬렉션별 성공/실패 메타**(`inv.collections`·`inv.reachable`)를 싣고, 실패한
 *      컬렉션의 열린 장애는 `held('collection-failed')` 로 **닫지 않는다**(`HOLD_REASON`).
 *
 * 판정 지점은 **사용자 선택으로 전 장비군 엣지**다(조사는 스토리지·SAN 을 중앙 판정으로 권했지만 —
 * 엣지 스냅샷이 이미 중앙에 온전히 도착한다 — 사용자가 '전부 엣지' 를 골랐다). 그 결과 판정 규칙을
 * 고칠 때마다 **전 엣지 업그레이드**가 필요하고 구버전 엣지 법인은 화면이 빈다. 그 사실을 화면이
 * **버전 단위로** 밝힌다(구버전 N곳 / 미구성 N곳 / 오래됨 N곳). 전송은 '장애 + 판정한 전체 요약'
 * (`PUSH_PROTOCOL` 2)이다 — 실측 18.3KB/push 라 '장애만' 의 회선 근거가 없었고, 전량이면
 * v2.547 의 `unknownKeys`·`unknownOmitted`·`unknownTruncated` 3단 우회가 통째로 사라진다.
 */

/** 파트 상태 — 다섯. `unknown`·`absent` 를 `ok`/`fault` 로 접지 말 것. */
export const PART_STATE = Object.freeze({
  ok: 'ok',           // 확인했고 정상
  warn: 'warn',       // 확인했고 주의(예측 실패·성능 저하)
  fault: 'fault',     // 확인했고 이상
  unknown: 'unknown', // 읽지 못함 — 정상도 이상도 아니다
  absent: 'absent',   // 빈 슬롯·미장착 — 장애가 아니다
});

export const PART_STATE_LABEL = Object.freeze({
  ok: '정상', warn: '주의', fault: '이상', unknown: '확인 불가', absent: '빈 슬롯',
});

/** 화면 색(배지) — `unknown` 은 빨강이 아니라 회색이다(v2.526 healthBadge 규약과 같다). */
export const PART_STATE_TONE = Object.freeze({
  ok: 'green', warn: 'amber', fault: 'red', unknown: 'gray', absent: 'gray',
});

/** 장애로 세는 상태. ⚠ `unknown`·`absent` 는 여기 넣지 말 것. */
export const BAD_STATES = Object.freeze(['fault', 'warn']);
export const isBad = (s) => s === PART_STATE.fault || s === PART_STATE.warn;
/** '확인했고 정상' 만. `unknown` 은 여기도 아니다. */
export const isGood = (s) => s === PART_STATE.ok;
/** 세지 않는 것 — 화면이 개수를 **따로** 밝힌다. */
export const isUncounted = (s) => s === PART_STATE.unknown || s === PART_STATE.absent;

/**
 * 파트 식별 키의 신뢰도 등급. 높을수록 좋다.
 * ⚠ `index` 는 **순서가 바뀌면 다른 파트가 된다** — 화면이 반드시 경고해야 한다.
 */
export const KEY_KIND = Object.freeze({
  slot: 'slot',       // 물리 위치(DIMM.Socket.A1 등) — 최선
  serial: 'serial',   // 부품 시리얼 — 교체를 추적할 수 있다
  name: 'name',       // 장비가 준 이름(Fan 1, PSU 2) — 대체로 안정
  index: 'index',     // ⚠ 배열 순번 — 순서가 바뀌면 오탐
  none: 'none',       // 식별 불가 — 파트 단위로 기록하지 않는다(장비 단위로만)
});

export const KEY_KIND_LABEL = Object.freeze({
  slot: '슬롯', serial: '시리얼', name: '이름', index: '순번', none: '식별 불가',
});

/** 그 키를 믿어도 되는지 화면이 말할 문구. 없는 키를 있는 척하지 않기 위해 있다. */
export const KEY_KIND_NOTE = Object.freeze({
  slot: '물리 슬롯으로 식별합니다 — 부품을 교체해도 같은 자리로 추적됩니다.',
  serial: '부품 시리얼로 식별합니다 — 교체하면 다른 파트로 기록됩니다(정상 동작).',
  name: '장비가 보고한 이름으로 식별합니다.',
  index: '⚠ 목록 **순번**으로 식별합니다 — 장비가 순서를 바꾸면 같은 부품이 다른 파트로 기록될 수 있습니다.',
  none: '이 장비군은 부품을 구분할 식별자를 주지 않습니다 — **그룹 단위**로만 기록합니다(예: SAN 스위치 팬 3/4 정상 — 어느 팬인지는 알 수 없습니다).',
});

/** 파트 종류 — `idrac/partsInventory.js PART_CATS` 와 어휘를 맞춘다(두 화면이 갈라지지 않게). */
export const PART_KIND_LABEL = Object.freeze({
  psu: 'PSU', disk: '디스크', dimm: '메모리(DIMM)', fan: '팬', cpu: 'CPU', gpu: 'GPU',
  controller: '스토리지 컨트롤러', nic: 'NIC', pcie: 'PCIe 카드', node: '노드/SP',
  sensor: '센서', sfp: 'SFP', port: '포트', battery: '배터리', enclosure: '인클로저',
  other: '기타',
});

/** 장비군 — 화면 필터 축. */
export const SCOPE_LABEL = Object.freeze({
  idrac: '물리 서버(iDRAC)', storage: '스토리지', sanswitch: 'SAN 스위치',
  esxi: 'ESXi 호스트', pdu: 'PDU', other: '기타',
});

/**
 * ⚠ PDU 는 **범위 밖**이다(v2.548 조사 F8): `pdu/` 스냅샷 계약에 부품 상태 필드가 하나도 없다
 * (전력·전류·온습도뿐). 라벨은 남겨 두지만 추출기를 만들지 않는다 — 없는 상태를 지어내지 않는다.
 */
export const SCOPES_OUT_OF_RANGE = Object.freeze({ pdu: '스냅샷에 부품 상태 필드가 없습니다(전력·온습도만).' });

/**
 * 장비 식별자의 등급(v2.548 F2). 파트 키의 장비 축이 **법인 간에 유일한가**를 화면이 말할 수 있게 한다.
 *  · serviceTag — iDRAC `inv.system.serviceTag`(redfish.js:304). 제조사 발급, 전역 유일. 최선.
 *  · uuid       — iDRAC `inv.system.uuid`(:307). 시스템 UUID. 차선.
 *  · centralId  — 스토리지·SAN 처럼 **중앙이 발급**한 id(`st-…`/`sw-…`, storage/registry.js:100). 전역 유일.
 *  · localId    — 노드가 만든 로컬 id(iDRAC 은 **IP 문자열**, registry.js:272). ⚠ 법인 간 충돌 가능 —
 *                 그래서 DB 기본키가 `(agent, part_key)` 다. 이 등급은 화면이 반드시 밝힌다.
 */
export const DEVICE_KEY_KIND = Object.freeze({
  serviceTag: 'serviceTag', uuid: 'uuid', centralId: 'centralId', localId: 'localId',
});
export const DEVICE_KEY_KIND_LABEL = Object.freeze({
  serviceTag: '서비스태그', uuid: 'UUID', centralId: '중앙 발급 id', localId: '로컬 id',
});
export const DEVICE_KEY_KIND_NOTE = Object.freeze({
  serviceTag: '', uuid: '', centralId: '',
  localId: '⚠ 이 장비는 서비스태그·UUID 를 읽지 못해 **로컬 id(IP)** 로 식별합니다 — 다른 법인의 같은 IP 장비와는 수집 주체(agent)로만 구분됩니다.',
});

/** 전이가 열린 장애를 **닫지 않고 보류**하는 사유. 화면 문구는 웹 `partFaultText.holdText` 가 소유한다. */
export const HOLD_REASON = Object.freeze({
  unknown: 'unknown',                       // 이번에 상태를 읽지 못함
  deviceFailed: 'device-failed',            // 그 장비의 이번 수집이 통째로 실패
  collectionFailed: 'collection-failed',    // 그 장비의 **그 부품 종류** 컬렉션만 실패(v2.548 F1)
  missing: 'missing',                       // 관측 목록에 없음(사라진 것 ≠ 고쳐진 것)
  unassigned: 'unassigned',                 // 그 agent 가 이번 주기에 보고했는데 **이 장비가 목록에 없음**(재배정·등록 삭제 — v2.548 리뷰 C5)
  noReport: 'no-report',                    // 그 agent 의 보고 자체가 없음(엣지 재기동·무보고 — '장비 실패' 와 다르다)
  edgeStale: 'edge-stale',                  // 그 엣지의 마지막 보고가 오래됨(기본 3시간) — 장비가 아니라 엣지 문제(v2.548 리뷰 H7)
  edgeLegacy: 'edge-legacy',                // 구 프로토콜 엣지(v2.547) — 해소를 판정할 수 없어 업그레이드 전까지 열려 있다
});

/**
 * 엣지→중앙 전송 프로토콜 버전. 1 = v2.547('장애만' + unknownKeys) · **2 = v2.548('장애 + 판정한
 * 전체 요약')**. 중앙은 1 을 받으면 **'닫지 않는 쪽'** 으로만 다룬다(구버전 엣지는 unknown 과 해소를
 * 구분해 줄 수 없다).
 */
export const PUSH_PROTOCOL = 2;

/**
 * Redfish 인벤토리 컬렉션 이름 → 이 계약의 파트 종류(v2.548 F1). `redfish.js fetchInventory` 가
 * `inv.collections[<컬렉션>] = 'ok'|'failed'` 를 싣고, `extract/idrac.js` 가 실패한 컬렉션의 종류를
 * `failedKinds` 로 올려 전이가 그 종류의 열린 장애를 보류한다. ⚠ `fans` 는 `fetchSensors`(Thermal)
 * 경로에서 오므로 `fetchInventory` 의 컬렉션이 아니다 — 폴러가 옮겨 넣을 때 'ok' 를 찍는다.
 */
export const COLLECTION_KINDS = Object.freeze({
  psus: 'psu', disks: 'disk', storageControllers: 'controller', memoryDimms: 'dimm',
  cpus: 'cpu', gpus: 'gpu', pcie: 'pcie', fans: 'fan',
});

const t = (v) => String(v ?? '').trim();

/**
 * 파트 레코드 1건을 정규화한다. **모르는 값을 지어내지 않는다** — 빈 값은 빈 문자열/`null` 로 둔다.
 *
 * @param {object} p
 * @param {string} p.scope      장비군(SCOPE_LABEL 키)
 * @param {string} p.deviceId   그 장비군 안에서의 장비 id
 * @param {string} p.deviceName 화면 표시용 장비 이름
 * @param {string} p.kind       파트 종류(PART_KIND_LABEL 키)
 * @param {string} p.partId     파트 식별자(슬롯·시리얼·이름·순번 중 실제로 쓴 값)
 * @param {string} p.keyKind    그 식별자의 등급(KEY_KIND)
 * @param {string} p.state      PART_STATE 중 하나
 * @param {string} [p.rawState] **장비가 보고한 원문**(판정 근거를 숨기지 않는다 — v2.523 규약)
 * @param {string} [p.label]    화면에 보일 파트 이름
 * @param {string} [p.detail]   모델·용량 등 부가 정보
 * @param {string} [p.agent]    수집 주체(빈 값 = 중앙 직접)
 * @param {string} [p.deviceKey]     파트 키의 장비 축(v2.548). 없으면 deviceId.
 * @param {string} [p.deviceKeyKind] 그 장비 키의 등급(DEVICE_KEY_KIND). 없으면 localId.
 */
export function makePart(p = {}) {
  const scope = t(p.scope) || 'other';
  const deviceId = t(p.deviceId);
  const deviceKey = t(p.deviceKey) || deviceId;
  const deviceKeyKind = DEVICE_KEY_KIND[t(p.deviceKeyKind)] ? t(p.deviceKeyKind) : DEVICE_KEY_KIND.localId;
  const kind = t(p.kind) || 'other';
  const keyKind = KEY_KIND[t(p.keyKind)] ? t(p.keyKind) : KEY_KIND.none;
  const partId = t(p.partId);
  const state = PART_STATE[t(p.state)] ? t(p.state) : PART_STATE.unknown;
  return {
    scope,
    deviceId,
    deviceKey,
    deviceKeyKind,
    deviceName: t(p.deviceName) || deviceId,
    kind,
    partId,
    keyKind,
    // ⚠ 키는 **어떤 이름 변경에도 바뀌면 안 된다** — 바뀌면 열린 장애가 닫히고 새 장애가 열린다.
    //   장비 축은 deviceId 가 아니라 **deviceKey**(서비스태그 우선)다(v2.548 F2).
    partKey: partKeyOf({ scope, deviceKey, kind, partId }),
    state,
    rawState: t(p.rawState),
    label: t(p.label) || partId || PART_KIND_LABEL[kind] || kind,
    detail: t(p.detail),
    agent: t(p.agent),
  };
}

/**
 * 파트 고유키. `scope:deviceKey:kind:partId` — 넷을 모두 넣는 이유는 각각이 다른 축이기 때문이다
 * (같은 이름의 `Fan 1` 이 서버마다 있고, 같은 장비에 `PSU 1` 과 `Fan 1` 이 함께 있다).
 * ⚠ 장비 축은 **deviceKey**(v2.548 — 서비스태그 우선)다. `deviceId` 만 주면 그것을 쓴다(하위 호환).
 * ⚠ 이 키에 agent 는 **넣지 않는다** — 법인 축은 DB 기본키 `(agent, part_key)` 가 담당한다.
 *   키에 넣으면 AGENT_NAME 기본값이 `os.hostname()` 이라(config.js:236) 호스트명 변경만으로
 *   전 장애가 닫혔다 다시 열린다.
 */
export function partKeyOf({ scope, deviceKey, deviceId, kind, partId }) {
  return [t(scope), t(deviceKey) || t(deviceId), t(kind), t(partId)].join(':');
}

/**
 * 파트 키의 꼬리 `kind:partId` — 엣지가 '판정한 전체 요약' 을 보낼 때 장비마다 이 꼬리만 실어
 * 바이트를 아낀다(중앙이 `scope:deviceKey:` 를 앞에 붙여 복원한다). 순수 문자열 규약이라 여기 둔다.
 */
export function partKeyTail({ kind, partId }) { return `${t(kind)}:${t(partId)}`; }
export function partKeyFromTail({ scope, deviceKey, tail }) { return `${t(scope)}:${t(deviceKey)}:${t(tail)}`; }

/**
 * 파트 목록 → 요약. **`unknown`·`absent` 를 정상에도 장애에도 넣지 않는다**(이 모듈의 존재 이유).
 * 화면은 이 네 수를 **각각** 보여준다.
 */
export function summarize(parts) {
  const out = { total: 0, ok: 0, warn: 0, fault: 0, unknown: 0, absent: 0 };
  for (const p of parts || []) {
    out.total += 1;
    if (out[p?.state] != null) out[p.state] += 1;
  }
  return out;
}
