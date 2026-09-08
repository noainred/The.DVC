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

export function loadThresholds() {
  if (!fs.existsSync(FILE)) return { ...DEFAULTS };
  try {
    const p = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      if (!(k in p)) continue;
      if (k === 'enabled') { out.enabled = p.enabled !== false; continue; }
      // 빈 문자열/null = '감시 안 함'. 0 은 유효한 임계치일 수 있으므로 구분해 남긴다.
      out[k] = (p[k] === '' || p[k] == null) ? null : (Number.isFinite(Number(p[k])) ? Number(p[k]) : DEFAULTS[k]);
    }
    return out;
  } catch (e) { preserveCorrupt(FILE, e.message); return { ...DEFAULTS }; }
}

export function saveThresholds(partial = {}) {
  const cur = loadThresholds();
  const next = { ...cur };
  for (const k of Object.keys(DEFAULTS)) {
    if (!(k in partial)) continue;
    if (k === 'enabled') { next.enabled = partial.enabled !== false; continue; }
    const v = partial[k];
    next[k] = (v === '' || v == null) ? null : (Number.isFinite(Number(v)) ? Number(v) : cur[k]);
  }
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
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
export function diffAlerts(violations, { now = Date.now(), cooldownMs = 60 * 60_000, state = _state } = {}) {
  const seen = new Set();
  const fire = [];
  for (const v of violations) {
    seen.add(v.key);
    const prev = state.get(v.key);
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
  for (const [key, st] of state) {
    if (seen.has(key)) continue;
    resolve.push({ key, severity: 'info', title: `PDU 임계치 복구 — ${key}`, detail: `${Math.round((now - st.since) / 60_000)}분 만에 정상으로 돌아왔습니다.` });
    state.delete(key);
  }
  return { fire, resolve };
}

/** 현재 활성 위반(화면 배지용). */
export function activeViolations() {
  return [...(_state.entries())].map(([key, st]) => ({ key, severity: st.severity, since: st.since }));
}

export function _resetForTest() { _state.clear(); }
