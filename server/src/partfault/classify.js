/**
 * partfault/classify.js — 장비가 보고한 **원문 상태 → 5상태** 판정(순수, v2.547).
 *
 * 장비군마다 어휘가 다르다. 그 어휘를 한 곳에서만 번역한다 — 수집기마다 흩어 놓으면
 * 같은 값이 화면마다 다르게 판정된다(이 저장소가 `console/`↔`version_3/` 중복으로 겪은 유형).
 *
 * ⚠⚠ **이 파일의 모든 판정에서 지켜야 하는 것 — 빈 값은 `ok` 가 아니다.**
 * `idrac/redfish.js:422` 는 지금 이렇게 되어 있다:
 *     inv.psus.some((p) => p.health && p.health !== 'OK') ? 'Warning' : 'OK'
 * 전 PSU 의 health 가 `''`(못 읽음)이어도 결과가 **`OK`** 다. CLAUDE.md
 * 'unknown 을 ok 로 세지 않는다' 위반이라 **그 롤업을 이 기능이 쓰면 안 된다** —
 * 그래서 파트 단위 원소 배열에서 직접 판정한다.
 *
 * ⚠ **정직 기록**: 이 저장소에는 Dell Redfish 가 실제로 보내는 값의 픽스처가 **0건**이다
 * (전수 조사 v2.547 확인). 그래서 아래 매핑은 **Redfish 스펙의 닫힌 열거형**을 근거로 한 것이고,
 * 인식하지 못한 값은 **`fault` 가 아니라 `unknown`** 으로 떨어뜨린다. 이유는 둘이다 —
 *  ① `Status.Health` 는 스펙상 `OK|Warning|Critical` 뿐이라, 그 밖의 값은 '장애' 가 아니라
 *     **우리가 잘못 읽었다**는 뜻일 가능성이 크다.
 *  ② 965대 × 부품 수에서 오탐 하나가 수백 건이 된다.
 * `unknown` 은 정상 집계에도 들어가지 않고 화면이 **개수를 따로 밝히므로** 숨겨지지 않는다.
 * 실장비 값을 확인하면 이 판정을 좁히고 이 고지를 지울 것.
 */

import { PART_STATE } from './types.js';
import { healthWord } from '../storage/healthWord.js';
import { unityHealthWord } from '../storage/collectors/unity.js';

const up = (v) => String(v ?? '').trim().toUpperCase();

/** Redfish `Status.State` 중 **빈 슬롯**을 뜻하는 값. 이것만 `absent` 다. */
const ABSENT_STATES = new Set(['ABSENT']);

/**
 * Redfish 부품 1개의 상태.
 *
 * 판정 순서가 계약이다:
 *  ① `State === 'Absent'` → **빈 슬롯**(Health 가 붙어 와도 무시한다 — 빈 자리에 장애는 없다)
 *  ② `Health` 를 본다(OK/Warning/Critical)
 *  ③ 그 밖은 전부 `unknown` + 원문 보존
 *
 * @param {{health?:string, state?:string, predictiveFailure?:boolean|null}} p
 * @returns {{state:string, raw:string}}
 */
export function redfishPartState({ health, state, predictiveFailure } = {}) {
  const h = up(health);
  const s = up(state);
  const raw = [String(health ?? '').trim(), String(state ?? '').trim()].filter(Boolean).join(' / ');

  if (ABSENT_STATES.has(s)) return { state: PART_STATE.absent, raw };

  let out;
  if (h === 'OK') out = PART_STATE.ok;
  else if (h === 'WARNING') out = PART_STATE.warn;
  else if (h === 'CRITICAL') out = PART_STATE.fault;
  else out = PART_STATE.unknown;   // '' 도 여기 — **ok 로 접지 않는다**

  /*
   * 예측 실패는 **상태를 악화시키기만** 한다(ok → warn). 이미 fault 면 그대로 두고,
   * ⚠ `unknown` 은 올리지 않는다 — 상태를 못 읽은 부품에 '주의' 를 붙이면
   *   '확인 불가' 가 화면에서 사라져 v2.526 의 교훈을 잃는다.
   * ⚠ `predictiveFailure` 가 `null`(미확인)이면 아무것도 하지 않는다.
   *   `idrac/redfish.js:458` 은 지금 `!!(drive.FailurePredicted)` 라 **필드 부재를 false 로 굳힌다** —
   *   그 경로는 별도로 고친다. 여기서는 null 을 null 로 다룬다.
   */
  if (predictiveFailure === true && out === PART_STATE.ok) out = PART_STATE.warn;

  return { state: out, raw: raw || '' };
}

/**
 * FRU 계열(Unity `svc_diag`·일부 스토리지) 원문 → 5상태.
 * `storage/collectors/svcDiag.js fruState` 와 **같은 어휘**를 쓴다(두 판정이 갈라지지 않게).
 * ⚠ 거기서 `empty` 라 부르는 것이 여기서는 `absent` 다 — 이름만 다르고 뜻은 같다.
 */
export function fruPartState(raw) {
  const s = up(raw);
  if (!s) return { state: PART_STATE.unknown, raw: '' };
  const r = String(raw).trim();
  if (s === 'OK' || s === 'PRESENT' || s === 'ENABLED' || s === 'NORMAL' || s === 'GOOD') {
    return { state: PART_STATE.ok, raw: r };
  }
  if (s === 'REMOVED' || s === 'EMPTY' || s === 'NOT PRESENT' || s === 'ABSENT') {
    return { state: PART_STATE.absent, raw: r };
  }
  if (s === 'UNKNOWN' || s === 'N/A' || s === '?') return { state: PART_STATE.unknown, raw: r };
  if (s === 'DEGRADED' || s === 'WARNING' || s === 'MINOR' || s === 'NON-CRITICAL') {
    return { state: PART_STATE.warn, raw: r };
  }
  // ⚠ FRU 어휘는 **닫힌 열거형이 아니다** — svcDiag 가 '넷 말고는 전부 fault' 로 보는 것과 같이
  //   여기서도 인식 못 한 값을 fault 로 본다. Redfish 와 다른 이유는, FRU 출력은 장애 시
  //   자유 문자열(예: 'FAULTED', 'REMOVED/FAULTED')이 오기 때문이다.
  return { state: PART_STATE.fault, raw: r };
}

/**
 * SAN 월간 점검(`sanswitch/healthCheck.js`)의 4상태 → 이 계약의 5상태.
 * 그쪽은 이미 `ok/warn/bad/unknown` 이라 **번역만** 한다(판정을 다시 하지 않는다 — v2.513 규약).
 */
export function sanPartState(v, raw = '') {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'ok') return { state: PART_STATE.ok, raw: String(raw || '') };
  if (s === 'warn') return { state: PART_STATE.warn, raw: String(raw || '') };
  if (s === 'bad') return { state: PART_STATE.fault, raw: String(raw || '') };
  return { state: PART_STATE.unknown, raw: String(raw || '') };
}

/**
 * 스토리지 노드/헬스 문자열 → 5상태.
 * 수집기들이 이미 쓰는 기준과 같다(`isilon.js:92`·`unity.js:42`:
 * `st !== 'unknown' && !/ok|healthy/`) — 다만 **거기서 빠진 `absent` 를 여기서 살린다**.
 */
/** 경고 등급 단어 — 문자열 **어디에** 있어도 본다('OK-degraded'·'Up (degraded)'). 'MINOR-FAILURE' 는 통째로 경고다. */
const WARN_WORDS = /\b(MINOR[-_ ]FAILURE|DEGRADED|WARNING|MINOR|ATTN\w*|NON[-_ ]?CRITICAL|PARTIAL)\b/;
const WARN_WORDS_ALL = new RegExp(WARN_WORDS.source, 'g');
/** 경고 단어와 함께 와도 fault 로 보는 **명백한** 이상어('FAILED (degraded)'). 숫자·부품명 같은 나머지는 경고를 유지한다. */
const HARD_BAD = /\b(FAIL\w*|ERROR\w*|FAULT\w*|CRITICAL|BROKEN|OFFLINE|DOWN|DISCONNECTED|UNHEALTHY|MAJOR|NON[ _]?RECOVERABLE|SMARTFAIL\w*|(NOT|NO|NON)[ _]*(OK|HEALTHY|NORMAL|ONLINE|UP|GOOD))\b/;

export function healthStringState(raw) {
  const s = up(raw);
  if (!s) return { state: PART_STATE.unknown, raw: '' };
  const r = String(raw).trim();
  // 구버전 Unity REST 수집기는 열거값을 'health:N' 으로 실었다 — 같은 번역표(unity.js)로 읽는다(v2.598 IDRAC-2598-05).
  const hm = /^HEALTH:(\d+)$/.exec(s);
  if (hm) {
    const w = unityHealthWord(Number(hm[1]));
    // 번역표에 없는 값은 원문 그대로 fault 다(예전과 같다 — 모르는 값을 정상이라 말하지 않는다).
    return /^health:/.test(w) ? { state: PART_STATE.fault, raw: r } : { ...healthStringState(w), raw: r };
  }
  // v2.598(감사 IDRAC-2598-06): 정상어 접두를 **먼저** 보면 'OK-degraded'·'Up (degraded)' 가 ok 가 됐다.
  //   순서: unknown → absent → 경고 단어(나머지에 명백한 이상어가 있으면 fault) → 공용 판정(storage/healthWord.js)
  //   의 ok/bad. 부정·이상어('not ok'·'UPGRADE_FAILED')는 공용 판정이 정상어보다 먼저 본다(v2.586).
  if (healthWord(r) === 'unknown') return { state: PART_STATE.unknown, raw: r };
  if (/^(REMOVED|EMPTY|ABSENT|NOT[_ ]?PRESENT|UNCONFIGURED)/.test(s)) return { state: PART_STATE.absent, raw: r };
  if (WARN_WORDS.test(s)) {
    const rest = s.replace(WARN_WORDS_ALL, ' ').replace(/[^A-Z0-9]+/g, ' ').trim();
    // 경고 단어를 뺀 나머지에 명백한 이상어가 남으면('FAILED (degraded)') fault, 아니면 경고다('OK-degraded'·'DEGRADED 3/4').
    return { state: HARD_BAD.test(rest) ? PART_STATE.fault : PART_STATE.warn, raw: r };
  }
  if (healthWord(r) === 'ok') return { state: PART_STATE.ok, raw: r };
  return { state: PART_STATE.fault, raw: r };
}
