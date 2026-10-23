/**
 * pdu/thresholds.js — PDU 임계치 판정 + 알림 연동(v2.425).
 *
 * 판정은 **순수 함수**(evaluateSnapshot)로 분리한다 — 알림 발송과 섞으면 테스트가 네트워크에
 * 의존하게 되고, '어떤 값에서 왜 울렸나'를 회귀로 고정할 수 없다.
 *
 * 규칙(정직 표기):
 *  - **값이 null 이면 판정하지 않는다.** 센서 미장착·첫 수집·카운터 리셋은 '정상'도 '위험'도
 *    아니다. null 을 0 으로 보고 '저온 정상'이라 판단하면 센서 고장을 놓친다.
 *  - **상태 전이에서만 알림**한다(정상→경고, 경고→위험 …). 매 수집마다 보내면 5분 주기에서
 *    하루 288통이 된다. 해소되면 '복구' 1통.
 *  - 재알림은 알림 설정의 cooldownMin 을 그대로 따른다(채널·억제창도 기존 엔진 재사용) —
 *    PDU 만 별도 쿨다운을 두면 운영자가 두 곳을 관리해야 한다.
 *
 * 임계치는 `CONFIG_DIR/pdu-thresholds.json`. 비밀이 없으므로 vault 대상은 아니지만,
 * 원자적 쓰기 + 손상본 보존은 다른 설정과 동일하게 지킨다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { makeSettingsLoadError } from '../util/settingsLoadError.js';
import { numOrNull } from '../util/numOrNull.js';

const FILE = path.join(config.configDir, 'pdu-thresholds.json');

/**
 * 기본 임계치 — 데이터센터 통념 기준(ASHRAE 권장 상한 27℃ 부근에서 경고).
 * 현장마다 다르므로 화면에서 조정한다. `null` 은 '그 항목 감시 안 함'.
 */
export const DEFAULTS = {
  enabled: true,
  tempWarnC: 27,      // 경고
  tempCritC: 32,      // 위험
  humLowPct: 20,      // 저습(정전기)
  humHighPct: 70,     // 고습(결로)
  powerWarnW: null,   // 장비별 정격이 달라 기본은 감시 안 함
  powerCritW: null,
  bankWarnA: 12,      // 16A 뱅크의 75%
  bankCritA: 14.4,    // 16A 뱅크의 90%
};

/** 항목 정의 — UI 가 이 표를 받아 폼을 그린다(서버가 단일 소스). */
export const THRESHOLD_SPEC = [
  { key: 'tempWarnC', label: '온도 경고(℃)', hint: 'ASHRAE 권장 상한 부근. 비우면 온도 경고를 하지 않습니다.' },
  { key: 'tempCritC', label: '온도 위험(℃)', hint: '장비 보호 한계에 근접한 값.' },
  { key: 'humLowPct', label: '습도 하한(%RH)', hint: '너무 건조하면 정전기 위험.' },
  { key: 'humHighPct', label: '습도 상한(%RH)', hint: '너무 습하면 결로 위험.' },
  { key: 'powerWarnW', label: '전력 경고(W)', hint: 'PDU 본체 1대 기준. 정격의 70~80%를 권장. 비우면 감시 안 함.' },
  { key: 'powerCritW', label: '전력 위험(W)', hint: 'PDU 본체 1대 기준. 정격의 90% 부근.' },
  { key: 'bankWarnA', label: '뱅크 전류 경고(A)', hint: '뱅크 차단기 정격의 75% 권장(16A 기준 12A).' },
  { key: 'bankCritA', label: '뱅크 전류 위험(A)', hint: '뱅크 차단기 정격의 90% 권장(16A 기준 14.4A).' },
];

/*
 * v2.769(점검 R4-D4-02): 임계치를 **엣지에도 배포**한다. 위임 PDU 의 경보는 엣지 폴러가 현장에서 평가·발송한다(poller.js
 *   evaluateAndNotify 머리말 — 의도된 설계, 중앙은 엣지 스냅샷을 평가하지 않는다: 둘 다 평가하면 같은 경보가 두 번 나간다).
 *   그런데 엣지는 자기 CONFIG_DIR 의 pdu-thresholds.json 만 봐서, 중앙 화면에서 바꾼 임계치(예: powerWarnW)가 위임 PDU 에는
 *   먹지 않았고 중앙 목록 배지(중앙 임계)와 엣지 경보(엣지 로컬 임계)가 갈렸다. 이제 pdu-config 응답이 중앙 값을 싣고
 *   (`thresholdsForEdge` — 중앙 파일이 있을 때만) 엣지가 `applyCentralThresholds` 로 메모리에 얹는다(intervals 와 같은 모양).
 *   · 실효 임계치 = **중앙 지정값 > 엣지 파일 > 기본값**. 엣지 파일은 덮어쓰지 않는다(중앙 값은 메모리 — 재시작 직후 첫 pull 전까지는 엣지 파일).
 *   · 중앙이 값을 안 주면(옛 중앙·중앙 파일 없음·중앙 파일 손상 → thresholdsUnreadable) 엣지는 **직전 값을 유지**한다.
 *   · 엣지 `PDU_THRESHOLDS_LOCAL=1` 이면 중앙 값을 무시한다(현장 고정 탈출구 — PDU_INTERVALS_LOCAL 과 같은 뜻).
 *   ⚠ **알림 채널 설정(설정 › 알림 채널)은 배포하지 않는다** — 엣지는 자기 알림 설정으로 보낸다. 엣지에 채널이 없으면
 *     위임 PDU 경보는 여전히 아무 데도 가지 않는다(남은 일 — 채널 주소를 28곳에 퍼뜨릴지는 사람이 정할 문제).
 */
const _loadErr = makeSettingsLoadError(() => FILE, { label: 'PDU 임계치', confirm: () => saveThresholds({}) });
let _central = null;   // 엣지가 중앙에서 받은 임계치(메모리 · 알려진 키만)

/** 파일에 저장된 값(+ 기본값). 중앙 배포분은 섞지 않는다. */
function loadFileThresholds() {
  if (!fs.existsSync(FILE)) { _loadErr.missing(); return { ...DEFAULTS }; }
  try {
    const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('객체가 아닌 JSON 값');
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      if (!(k in p)) continue;
      if (k === 'enabled') { out.enabled = p.enabled !== false; continue; }
      // 빈 문자열/null = '감시 안 함'. 0 은 유효한 임계치일 수 있으므로 구분해 남긴다.
      out[k] = (p[k] === '' || p[k] == null) ? null : (Number.isFinite(Number(p[k])) ? Number(p[k]) : DEFAULTS[k]);
    }
    _loadErr.ok();
    return out;
  } catch (e) { _loadErr.corrupt(e); preserveCorrupt(FILE, e.message); return { ...DEFAULTS }; }
}

/** 실효 임계치 — 중앙 지정값(엣지 · 받았을 때만) > 파일 > 기본값. */
export function loadThresholds() {
  const file = loadFileThresholds();
  const central = process.env.PDU_THRESHOLDS_LOCAL === '1' ? null : _central;
  return central ? { ...file, ...central } : file;
}

/** 중앙 임계치 파일을 못 읽었으면 { at, reason }, 아니면 null(pdu-config 가 thresholds 대신 thresholdsUnreadable 을 싣는다). */
export function pduThresholdsLoadError() { loadFileThresholds(); return _loadErr.get(); }

/**
 * 중앙 → 엣지에 내려보낼 임계치. **중앙 파일이 있을 때만**(관리자가 화면에서 저장한 값) — 한 번도 저장하지 않은 중앙이
 * 기본값으로 각 법인이 맞춰 둔 엣지 파일을 덮지 않게 한다(intervalsForEdge '지정한 키만' 과 같은 취지). 없으면 null.
 */
export function thresholdsForEdge() {
  if (!fs.existsSync(FILE)) return null;
  const v = loadFileThresholds();
  return _loadErr.get() ? null : v;
}

/**
 * 엣지: 중앙에서 받은 임계치를 정제해 적용한다. 반환 = 실제로 바뀌었는가.
 * 정제(엣지가 받은 값도 그대로 믿지 않는다): 평범한 객체만 · 알려진 키만 · enabled 는 불리언만 ·
 * 수치는 유한수(문자열 수치는 수로)만, null·'' 는 '감시 안 함' · 범위 밖·형식 오류 키는 버린다(그 키는 엣지 파일 값).
 * 객체가 아니면 아무것도 바꾸지 않는다(직전 값 유지).
 */
const CENTRAL_ABS_MAX = 1e7;
export function applyCentralThresholds(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const next = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const v = obj[k];
    if (k === 'enabled') { if (typeof v === 'boolean') next.enabled = v; continue; }
    if (v === null || v === '') { next[k] = null; continue; }
    if (typeof v !== 'number' && typeof v !== 'string') continue;
    const n = numOrNull(typeof v === 'string' ? v.slice(0, 32) : v);
    if (n == null || Math.abs(n) > CENTRAL_ABS_MAX) continue;
    next[k] = n;
  }
  const changed = JSON.stringify(next) !== JSON.stringify(_central || {});
  _central = next;
  return changed;
}

/** 엣지가 지금 적용 중인 중앙 임계치(진단·상태용 — 없으면 null). */
export function centralThresholdsApplied() { return _central ? { ..._central } : null; }

export function saveThresholds(partial = {}) {
  // 저장은 파일 값 기준이다 — 엣지에서 저장해도 중앙 배포분을 파일로 굳히지 않는다.
  const cur = loadFileThresholds();
  const next = { ...cur };
  for (const k of Object.keys(DEFAULTS)) {
    if (!(k in partial)) continue;
    if (k === 'enabled') { next.enabled = partial.enabled !== false; continue; }
    const v = partial[k];
    next[k] = (v === '' || v == null) ? null : (Number.isFinite(Number(v)) ? Number(v) : cur[k]);
  }
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  _loadErr.ok();
  return next;
}

/**
 * 스냅샷 1건 → 위반 목록(**순수**). 값이 null 인 항목은 건너뛴다.
 * @returns {Array<{key,severity,title,detail,metric,value,limit}>}
 */
export function evaluateSnapshot(snap, th = loadThresholds()) {
  const out = [];
  if (!snap || th.enabled === false) return out;
  const who = snap.name || snap.host || snap.id;

  const check = (value, warn, crit, mk) => {
    if (value == null) return;                       // 미측정 — 판정하지 않는다
    if (crit != null && value >= crit) out.push(mk('critical', crit));
    else if (warn != null && value >= warn) out.push(mk('warning', warn));
  };

  for (const s of snap.sensors || []) {
    const at = `${who} 센서#${s.index}${s.name ? `(${s.name})` : ''}`;
    check(s.tempC, th.tempWarnC, th.tempCritC, (sev, lim) => ({
      key: `pdu.temp.${snap.id}.${s.index}`, severity: sev, metric: 'temp', value: s.tempC, limit: lim,
      title: `PDU 온도 ${sev === 'critical' ? '위험' : '경고'} — ${at}`,
      detail: `현재 ${s.tempC}℃ (임계 ${lim}℃)`,
    }));
    // 습도는 상·하한 양방향이라 check() 를 쓰지 않는다.
    if (s.humidityPct != null) {
      if (th.humHighPct != null && s.humidityPct >= th.humHighPct) {
        out.push({ key: `pdu.hum.high.${snap.id}.${s.index}`, severity: 'warning', metric: 'humidity', value: s.humidityPct, limit: th.humHighPct,
          title: `PDU 습도 상한 초과 — ${at}`, detail: `현재 ${s.humidityPct}%RH (상한 ${th.humHighPct}%RH) — 결로 위험` });
      } else if (th.humLowPct != null && s.humidityPct <= th.humLowPct) {
        out.push({ key: `pdu.hum.low.${snap.id}.${s.index}`, severity: 'warning', metric: 'humidity', value: s.humidityPct, limit: th.humLowPct,
          title: `PDU 습도 하한 미만 — ${at}`, detail: `현재 ${s.humidityPct}%RH (하한 ${th.humLowPct}%RH) — 정전기 위험` });
      }
    }
  }

  for (const u of snap.units || []) {
    check(u.powerW, th.powerWarnW, th.powerCritW, (sev, lim) => ({
      key: `pdu.power.${snap.id}.${u.index}`, severity: sev, metric: 'power', value: u.powerW, limit: lim,
      title: `PDU 전력 ${sev === 'critical' ? '위험' : '경고'} — ${who} 본체#${u.index}`,
      detail: `현재 ${(u.powerW / 1000).toFixed(2)} kW (임계 ${(lim / 1000).toFixed(2)} kW)`,
    }));
    for (const b of u.banks || []) {
      check(b.currentA, th.bankWarnA, th.bankCritA, (sev, lim) => ({
        key: `pdu.bank.${snap.id}.${u.index}.${b.index}`, severity: sev, metric: 'bank', value: b.currentA, limit: lim,
        title: `PDU 뱅크 전류 ${sev === 'critical' ? '위험' : '경고'} — ${who} 본체#${u.index} 뱅크${b.index}`,
        detail: `현재 ${b.currentA}A (임계 ${lim}A)`,
      }));
    }
  }
  return out;
}

// ── 상태 전이 추적 + 발송 ─────────────────────────────────────────────────────
// key → { severity, since, lastNotified }
const _state = new Map();

/**
 * 위반 목록을 이전 상태와 비교해 **보낼 것만** 골라낸다(순수 — 발송은 하지 않는다).
 * @returns {{ fire:Array, resolve:Array }}
 */
/**
 * 이번 주기에 **값을 실제로 읽은** 경보 키 집합(순수 — v2.590 F5). 장비 수집은 성공했는데 그 센서·뱅크 값만 못 읽은
 * 경우(프로브 분리·E102·명령 실패 → 값 null 이거나 목록에서 빠짐)는 여기에 들지 않는다 — `diffAlerts` 가 그 키를
 * 해소가 아니라 **보류**로 다룬다. 키 형식은 `evaluateSnapshot` 과 글자 그대로 같아야 한다.
 */
export function readAlertKeys(snap) {
  const out = new Set();
  if (!snap || snap.ok === false) return out;
  const nn = (v) => v != null && v !== '' && Number.isFinite(Number(v));
  for (const s of snap.sensors || []) {
    if (nn(s.tempC)) out.add(`pdu.temp.${snap.id}.${s.index}`);
    if (nn(s.humidityPct)) { out.add(`pdu.hum.high.${snap.id}.${s.index}`); out.add(`pdu.hum.low.${snap.id}.${s.index}`); }
  }
  for (const u of snap.units || []) {
    if (nn(u.powerW)) out.add(`pdu.power.${snap.id}.${u.index}`);
    for (const b of u.banks || []) if (nn(b.currentA)) out.add(`pdu.bank.${snap.id}.${u.index}.${b.index}`);
  }
  return out;
}

/** 값을 못 읽어 보류 중인 경보를 이 시간이 지나면 **해소 알림 없이** 끊는다(복구가 아니라 모르는 것 — bmusage 규약). */
export const HOLD_MAX_MS = 6 * 60 * 60_000;

export function diffAlerts(violations, { now = Date.now(), cooldownMs = 60 * 60_000, state = _state, heldDeviceIds = [], readKeys = null, holdMaxMs = HOLD_MAX_MS } = {}) {
  // v2.583: 이번 주기에 **읽지 못한** 장비(스냅샷 ok:false)의 위반은 해소로 보지 않는다. 예전에는 수집 실패로
  // 스냅샷이 비면 위반이 사라진 것처럼 읽혀 '정상으로 돌아왔습니다' 가 나가고, 다음 정상 수집에서 같은 위반이
  // 새 알림으로 다시 나갔다('확인 불가 ≠ 정상' 규약 — v2.519·v2.548). 보류된 상태는 그대로 둔다.
  const held = new Set((heldDeviceIds || []).map(String));
  const isHeld = (key) => held.has(deviceOfAlertKey(key)); // v2.583: 부분 문자열이 아니라 장비 id 정확 매칭(id '1' 이 다른 장비의 뱅크 키에 걸리지 않게)
  const seen = new Set();
  const fire = [];
  for (const v of violations) {
    seen.add(v.key);
    const prev0 = state.get(v.key);
    if (prev0?.heldSince) { delete prev0.heldSince; }   // 다시 읽혔다 — 보류 해제(같은 위반이면 쿨다운을 그대로 따른다)
    const prev = prev0;
    if (!prev) { state.set(v.key, { severity: v.severity, since: now, lastNotified: now }); fire.push(v); continue; }
    if (prev.severity !== v.severity) {
      // 전이(경고↔위험)는 쿨다운과 무관하게 즉시 알린다 — 악화를 늦게 아는 것이 더 위험하다.
      state.set(v.key, { severity: v.severity, since: now, lastNotified: now });
      fire.push(v);
      continue;
    }
    if (now - (prev.lastNotified || 0) >= cooldownMs) {
      state.set(v.key, { ...prev, lastNotified: now });
      fire.push({ ...v, repeat: true });
    }
  }
  const resolve = [];
  const dropped = [];
  for (const [key, st] of state) {
    if (seen.has(key)) continue;
    if (held.size && isHeld(key)) continue;
    // v2.590 F5: 장비는 읽었지만 **이 값은 못 읽었다** — 해소가 아니라 보류다(센서가 분리되는 순간 '정상으로 돌아왔습니다'
    //   가 나가고 다시 읽히면 쿨다운 없이 재발송되던 결함). 오래 보류되면 알림 없이 끊는다.
    if (readKeys && !readKeys.has(key)) {
      if (!st.heldSince) st.heldSince = now;
      if (now - st.heldSince >= holdMaxMs) { state.delete(key); dropped.push(key); }
      continue;
    }
    resolve.push({ key, severity: 'info', title: `PDU 임계치 복구 — ${key}`, detail: `${Math.round((now - st.since) / 60_000)}분 만에 정상으로 돌아왔습니다.` });
    state.delete(key);
  }
  return { fire, resolve, dropped };
}

/**
 * 대상에서 빠진(삭제·재배정) 장비의 위반 상태를 **알림 없이** 지운다(v2.583). 없어진 장비의 경보를
 * '정상으로 돌아왔습니다' 라고 알리면 거짓이다 — 고쳐진 것이 아니라 더 이상 보지 않는 것이다.
 * @returns {number} 지운 키 수
 */
/**
 * 경보 키 → 장비 id(v2.583 — 검증 에이전트 권고). 키 형식: pdu.temp|power.<id>.<i> · pdu.hum.high|low.<id>.<i> ·
 * pdu.bank.<id>.<u>.<b>. `key.includes('.1.')` 같은 부분 문자열 비교는 숫자 id(사용자가 등록 시 지정 가능)가 다른 장비의
 * 뱅크 인덱스와 겹쳐 **엉뚱한 장비의 경보를 보류·삭제**한다. id 에 점이 있어도 되게 꼬리 인덱스만 떼어 낸다.
 */
export function deviceOfAlertKey(key) {
  const k = String(key || '');
  let m = /^pdu\.bank\.(.+)\.[^.]+\.[^.]+$/.exec(k); if (m) return m[1];
  m = /^pdu\.hum\.(?:high|low)\.(.+)\.[^.]+$/.exec(k); if (m) return m[1];
  m = /^pdu\.(?:temp|power)\.(.+)\.[^.]+$/.exec(k); if (m) return m[1];
  return '';
}

export function forgetDeviceAlerts(deviceIds = [], state = _state) {
  let n = 0;
  for (const id of deviceIds.map(String)) {
    for (const key of [...state.keys()]) if (deviceOfAlertKey(key) === String(id)) { state.delete(key); n += 1; }
  }
  return n;
}

/** 현재 활성 위반(화면 배지용). */
export function activeViolations() {
  return [...(_state.entries())].map(([key, st]) => ({ key, severity: st.severity, since: st.since }));
}

export function _resetForTest() { _state.clear(); _central = null; }
