/**
 * bmusage/alertRules.js — 임계 초과 **판정**(순수, v2.551).
 *
 * 사용자 요청(2026-09-18): 방금 만든 기능 개선 → 선택 ④「임계 초과 알림」.
 * 제가 질문에서 밝힌 대로 **폭주 위험이 실재한다** — 200대 × 5분이면 하루 5.76만 판정이고,
 * 한 번 튄 값으로 알리면 야간에 수백 통이 나간다. 그래서 규칙을 순수 함수로 분리해 테스트로 고정한다.
 *
 * ── 폭주를 막는 네 장치 ──────────────────────────────────────────────────────
 *  ① **지속 조건**(`sustainMin`) — 연속으로 임계를 넘긴 시간이 그만큼 돼야 알린다.
 *     한 주기 스파이크(백업·부팅)로 알리지 않는다.
 *  ② **재알림 억제**(`repeatHours`) — 같은 서버·같은 지표는 그 시간 안에 다시 보내지 않는다.
 *  ③ **해제 알림은 1회**(`recovered`) — 임계 아래로 내려오면 한 번만. 경계에서 떨리면
 *     `HYSTERESIS_PCT` 만큼 내려와야 해제로 본다(오르내림이 알림을 두 배로 만들지 않게).
 *  ④ **상태를 파일에 남긴다**(호출부) — 인메모리면 **재시작마다 전 서버가 새 초과**가 되어
 *     알림이 폭주한다(v2.548 `part_state` 규약과 같은 이유).
 *
 * ⚠⚠ **`null` 은 초과도 정상도 아니다.** 못 읽은 주기를 정상으로 세면 지속 카운터가 끊겨
 *   진짜 초과를 놓치고, 초과로 세면 없는 장애를 만든다 → **판정 보류**(상태를 그대로 유지)다.
 * ⚠ 값이 없는 동안 시간이 흐르는 것을 '지속' 으로 세지 않는다 — `since` 는 유지하되
 *   `lastOverAt`(마지막으로 실제 초과를 본 시각)이 오래되면 그 초과는 **끊어진 것**으로 본다.
 */
import { numOrNull } from '../util/numOrNull.js';
const n = numOrNull;   // v2.561: 공용 판정

/** 해제 판정 여유 — 임계 90 이면 87 아래로 내려와야 해제다. */
export const HYSTERESIS_PCT = 3;
/** 값이 이만큼 안 들어오면 진행 중이던 초과를 '끊어진 것' 으로 본다(주기 배수). */
export const STALE_FACTOR = 3;

/** 감시 지표 — 퍼센트 지표만. 처리량(B/s)은 장비마다 정상 범위가 달라 임계를 정하지 않는다. */
export const ALERT_METRICS = Object.freeze([
  { col: 'cpu_pct', label: 'CPU' },
  { col: 'mem_pct', label: '메모리' },
  { col: 'disk_busy_pct', label: '디스크 I/O' },
  { col: 'disk_used_pct', label: '디스크 공간' },
  { col: 'net_pct', label: '네트워크' },
  { col: 'hba_pct', label: 'HBA' },
]);

/**
 * 한 서버·한 지표의 상태 전이.
 *
 * @param {object|null} prev  `{ since, lastOverAt, notifiedAt, peak }` 또는 없음
 * @param {number|null} value 이번 주기 값(`null` = 못 읽음)
 * @param {object} cfg  `{ pct, sustainMin, repeatHours, intervalMs }`
 * @param {number} now
 * @returns {{state:object|null, fire:null|'over'|'recovered', reason:string, sustainedMin:number}}
 *   `state === null` = 그 지표를 더 추적하지 않는다(정상 복귀 완료).
 */
export function stepAlert(prev, value, cfg = {}, now = Date.now()) {
  const pct = n(cfg.pct);
  const v = n(value);
  const sustainMs = Math.max(0, n(cfg.sustainMin) ?? 15) * 60_000;
  const repeatMs = Math.max(0, n(cfg.repeatHours) ?? 6) * 3_600_000;
  const staleMs = Math.max(60_000, (n(cfg.intervalMs) || 300_000) * STALE_FACTOR);
  const p = prev || null;

  // 임계가 없으면 판정하지 않는다(설정이 비었을 때 0 으로 떨어지면 전 서버가 초과가 된다).
  if (pct == null || pct <= 0) return { state: p, fire: null, reason: 'no-threshold', sustainedMin: 0 };

  // ⚠ 못 읽은 주기는 **판정 보류** — 상태를 바꾸지 않는다.
  if (v == null) {
    if (p && n(p.lastOverAt) != null && now - p.lastOverAt > staleMs) {
      // 오래 값이 없으면 진행 중이던 초과를 끊는다(거짓 '지속' 을 만들지 않는다). 해제 알림은 없다 —
      // 복구된 것이 아니라 **모르는 것**이다.
      return { state: null, fire: null, reason: 'stale-drop', sustainedMin: 0 };
    }
    return { state: p, fire: null, reason: 'unknown', sustainedMin: 0 };
  }

  const over = v >= pct;
  if (over) {
    const since = p && n(p.since) != null ? p.since : now;
    const peak = Math.max(n(p?.peak) ?? 0, v);
    const sustained = now - since;
    const st = { since, lastOverAt: now, peak, notifiedAt: n(p?.notifiedAt) ?? null };
    if (sustained < sustainMs) return { state: st, fire: null, reason: 'sustaining', sustainedMin: Math.round(sustained / 60_000) };
    const last = n(st.notifiedAt);
    if (last != null && now - last < repeatMs) return { state: st, fire: null, reason: 'suppressed', sustainedMin: Math.round(sustained / 60_000) };
    return { state: { ...st, notifiedAt: now }, fire: 'over', reason: 'fire', sustainedMin: Math.round(sustained / 60_000) };
  }

  // 정상 범위 — 추적 중이던 것이 있으면 해제를 판단한다.
  if (!p) return { state: null, fire: null, reason: 'ok', sustainedMin: 0 };
  // ⚠ 경계에서 떨리는 것을 해제로 보지 않는다(오르내림이 알림을 두 배로 만든다).
  if (v > pct - HYSTERESIS_PCT) {
    return { state: p, fire: null, reason: 'hysteresis', sustainedMin: Math.round(((now - (n(p.since) ?? now))) / 60_000) };
  }
  // 알린 적이 있으면 해제도 알린다(알린 적이 없으면 조용히 잊는다 — 알리지 않은 것의 해제는 뜻이 없다).
  const fire = n(p.notifiedAt) != null ? 'recovered' : null;
  return { state: null, fire, reason: fire ? 'recover' : 'ok', sustainedMin: 0 };
}

/**
 * 한 주기 전체 판정.
 * @param {Array} rows   이번 주기에 적재한 행
 * @param {object} state 이전 상태 `{ "<key>|<col>": {...} }`
 * @returns {{next:object, fires:Array, counts:object}}
 */
export function evaluateRows(rows = [], state = {}, cfg = {}, now = Date.now()) {
  const next = {};
  const fires = [];
  const counts = { over: 0, recovered: 0, sustaining: 0, suppressed: 0, unknown: 0, tracked: 0 };
  const seen = new Set();
  for (const r of rows || []) {
    const key = String(r.key || '').trim();
    if (!key) continue;
    for (const m of ALERT_METRICS) {
      const id = `${key}|${m.col}`;
      seen.add(id);
      const out = stepAlert(state[id] || null, r[m.col], cfg, now);
      if (out.state) { next[id] = out.state; counts.tracked += 1; }
      if (out.reason === 'sustaining') counts.sustaining += 1;
      if (out.reason === 'suppressed') counts.suppressed += 1;
      if (out.reason === 'unknown') counts.unknown += 1;
      if (out.fire === 'over') {
        counts.over += 1;
        fires.push({ kind: 'over', key, name: r.name || key, vcenterId: r.vcenterId || '', metric: m.col, label: m.label, value: n(r[m.col]), peak: out.state?.peak ?? null, sustainedMin: out.sustainedMin, pct: n(cfg.pct) });
      } else if (out.fire === 'recovered') {
        counts.recovered += 1;
        fires.push({ kind: 'recovered', key, name: r.name || key, vcenterId: r.vcenterId || '', metric: m.col, label: m.label, value: n(r[m.col]), pct: n(cfg.pct) });
      }
    }
  }
  /*
   * ⚠ **이번 주기에 없던 서버의 상태는 그대로 들고 간다** — 수집이 한 번 실패한 것으로 추적을
   *   버리면 다음 성공 주기가 '새 초과' 가 되어 알림이 다시 나간다. 단 `lastOverAt` 이 오래된 것은
   *   버린다(등록에서 사라진 서버가 영원히 남지 않게 — v2.550.3 인메모리 맵 규약).
   */
  const staleMs = Math.max(60_000, (n(cfg.intervalMs) || 300_000) * STALE_FACTOR * 4);
  for (const [id, st] of Object.entries(state || {})) {
    if (seen.has(id) || next[id]) continue;
    if (n(st?.lastOverAt) != null && now - st.lastOverAt < staleMs) next[id] = st;
  }
  return { next, fires, counts };
}

/** 알림 본문 — ⚠ `**` 를 쓰지 않는다(Slack·메일엔 BoldText 가 없다 — v2.548 규약). */
export function alertOf(f = {}) {
  if (f.kind === 'recovered') {
    return {
      key: `bmusage:${f.key}:${f.metric}`,
      severity: 'warning',
      title: `[해제] ${f.name} ${f.label} 사용률이 임계 아래로 내려왔습니다`,
      detail: `현재 ${f.value == null ? '—' : `${f.value}%`} (임계 ${f.pct}%)${f.vcenterId ? ` · 법인 ${f.vcenterId}` : ''}`,
    };
  }
  const sev = f.value != null && f.pct != null && f.value >= Math.min(99, f.pct + 5) ? 'critical' : 'warning';
  return {
    key: `bmusage:${f.key}:${f.metric}`,
    severity: sev,
    title: `${f.name} ${f.label} 사용률 ${f.value == null ? '' : `${f.value}%`} (임계 ${f.pct}%)`,
    detail: `${f.sustainedMin}분 이상 지속${f.peak != null ? ` · 최고 ${f.peak}%` : ''}${f.vcenterId ? ` · 법인 ${f.vcenterId}` : ''}`
      + ` · 베어메탈 사용률 화면에서 추이를 확인하세요.`,
  };
}
