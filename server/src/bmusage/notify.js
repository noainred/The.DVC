/**
 * bmusage/notify.js — 임계 초과 알림 발송 + **상태 영속**(v2.551).
 *
 * ⚠⚠ **상태를 파일에 남긴다.** 인메모리면 재시작마다 전 서버가 '새 초과' 가 되어 알림이
 *   폭주한다(v2.548 `part_state` 를 인메모리로 바꾸지 말라는 규약과 **같은 이유**).
 * ⚠ **순차 발송이다** — `alerts.js` 의 POST 를 동시에 수백 개 열지 않는다(v2.548 규약).
 * ⚠ 상한(`MAX_SEND`)을 두고 **잘린 개수를 밝힌다** — 조용히 줄이면 화면이 '전부 보냈다' 고 거짓말한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { notify as sendAlert } from '../alerts.js';
import { evaluateRows, alertOf } from './alertRules.js';

const FILE = () => path.join(config.configDir, 'bmusage-alert-state.json');
const MAX_SEND = Math.max(1, Number(process.env.BMUSAGE_ALERT_MAX) || 40);

let _state = null;
function load() {
  if (_state) return _state;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    _state = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw.metrics || {}) : {};
  } catch {
    // 손상·부재는 빈 상태로 시작한다 — **재생성 가능한 캐시**다(자격증명 스토어와 다른 취급.
    // 여기서 원본을 보존해도 쓸모가 없고, 알림이 한 주기 늦게 나갈 뿐이다).
    _state = {};
  }
  return _state;
}
function save(next) {
  _state = next;
  try { atomicWriteFileSync(FILE(), `${JSON.stringify({ metrics: next, at: Date.now() }, null, 0)}\n`); } catch { /* best effort */ }
  try { fs.chmodSync(FILE(), 0o600); } catch { /* */ }
}
export function _resetAlertStateForTest() { _state = null; try { fs.unlinkSync(FILE()); } catch { /* */ } }
/** 화면용 — 지금 추적 중인 초과 건수(비밀 없음). */
export function alertStateInfo() {
  const s = load();
  const tracked = Object.entries(s);
  return {
    tracked: tracked.length,
    notified: tracked.filter(([, v]) => v?.notifiedAt != null).length,
    maxSend: MAX_SEND,
  };
}

/**
 * 한 주기의 알림. 설정이 꺼져 있으면 **판정도 하지 않는다**(상태를 건드리지 않아, 다시 켤 때
 * 과거 초과가 한꺼번에 나가지 않는다).
 * @param {Array} rows  이번 주기에 적재한 행
 * @param {object} settings  `loadBmUsageSettings()`
 */
export async function runBmUsageAlerts(rows = [], settings = {}) {
  if (!settings.alertEnabled) return { ok: true, skipped: 'disabled' };
  const cfg = {
    pct: settings.alertPct, sustainMin: settings.alertSustainMin,
    repeatHours: settings.alertRepeatHours, intervalMs: settings.intervalMs,
    // v2.599(RECENT2599-01): 관측 간격 = 주기 + 수집 시간 — 지속 판정의 연속 한도에 쓴다.
    runMs: settings.runMs,
  };
  const { next, fires, counts } = evaluateRows(rows, load(), cfg, Date.now());
  save(next);
  if (!fires.length) return { ok: true, sent: 0, counts };
  // ⚠ 위험한 것(초과)을 먼저 — 상한에 걸려 잘릴 때 해제 알림이 초과를 밀어내면 안 된다.
  const ordered = [...fires].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'over' ? -1 : 1));
  const take = ordered.slice(0, MAX_SEND);
  let sent = 0; let suppressed = 0; const errors = [];
  for (const f of take) {
    try {
      const r = await sendAlert(alertOf(f));           // 순차
      const line = Array.isArray(r) ? r.join(' · ') : String(r);
      if (/suppressed/.test(line)) suppressed += 1; else sent += 1;
    } catch (e) { errors.push(String(e?.message || e).slice(0, 120)); }
  }
  return {
    ok: true, sent, suppressed, counts,
    capped: Math.max(0, ordered.length - take.length),
    errors: errors.slice(0, 5),
    fires: take.map((f) => ({ kind: f.kind, key: f.key, metric: f.metric, value: f.value })),
  };
}
