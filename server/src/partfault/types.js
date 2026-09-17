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
  none: '이 장비군은 부품을 구분할 식별자를 주지 않습니다 — 장비 단위로만 기록합니다.',
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
 */
export function makePart(p = {}) {
  const scope = t(p.scope) || 'other';
  const deviceId = t(p.deviceId);
  const kind = t(p.kind) || 'other';
  const keyKind = KEY_KIND[t(p.keyKind)] ? t(p.keyKind) : KEY_KIND.none;
  const partId = t(p.partId);
  const state = PART_STATE[t(p.state)] ? t(p.state) : PART_STATE.unknown;
  return {
    scope,
    deviceId,
    deviceName: t(p.deviceName) || deviceId,
    kind,
    partId,
    keyKind,
    // ⚠ 키는 **어떤 이름 변경에도 바뀌면 안 된다** — 바뀌면 열린 장애가 닫히고 새 장애가 열린다.
    partKey: partKeyOf({ scope, deviceId, kind, partId }),
    state,
    rawState: t(p.rawState),
    label: t(p.label) || partId || PART_KIND_LABEL[kind] || kind,
    detail: t(p.detail),
    agent: t(p.agent),
  };
}

/**
 * 파트 고유키. `scope:deviceId:kind:partId` — 넷을 모두 넣는 이유는 각각이 다른 축이기 때문이다
 * (같은 이름의 `Fan 1` 이 서버마다 있고, 같은 장비에 `PSU 1` 과 `Fan 1` 이 함께 있다).
 * ⚠ `partId` 가 비면 `none` 등급이므로 파트 단위로 기록하지 않는다 — 호출부가 걸러야 한다.
 */
export function partKeyOf({ scope, deviceId, kind, partId }) {
  return [t(scope), t(deviceId), t(kind), t(partId)].join(':');
}

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
