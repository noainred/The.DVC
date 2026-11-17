/**
 * bmusage/notify.js — 임계 초과 알림 발송 + **상태 영속**(v2.551).
 *
 * ⚠⚠ **상태를 파일에 남긴다.** 인메모리면 재시작마다 전 서버가 '새 초과' 가 되어 알림이
 *   폭주한다(v2.548 `part_state` 를 인메모리로 바꾸지 말라는 규약과 **같은 이유**).
 * ⚠ 상한(`MAX_SEND`)을 두고 **잘린 개수를 밝힌다** — 조용히 줄이면 화면이 '전부 보냈다' 고 거짓말한다.
 * ⚠⚠ 점검 반복 5회차 D2 · D3(정정 — 예전 머리말 ‘순차 발송이다’): 발송을 주기 안에서 순차 await 해, 응답 없는 웹훅 하나(시한 15초 × 재시도 1)가
 *   수집 주기 재진입 가드를 붙잡았다(실측: 3건 → 주기 91.5초 · 그 사이 다음 틱 · ‘지금 수집’ 거절 — 상한 40건이면 약 20분, 산수). 이제 형제 성능 알림 규칙
 *   (perfAlerts — 반증 F6)과 **같은 대기열**(alerts.enqueueNotify — 채널별 레인 · 상한 · 동시에 수백 개 열지 않는 것도 그 레인이 지킨다)로 넣고 주기는 기다리지 않는다.
 *   결과는 끝난 뒤 **같은 판정**(alerts.deliveryOutcome)으로 가르고, 받은 채널 없이 실패(failed)면 **같은 재시도 규칙**(alerts.retryDelayMs — 5분 · 15분 두 번)으로
 *   그 상태의 notifiedAt 을 앞당겨 다음 주기 판정이 다시 보내게 한다(예전: 채널 실패도 ‘발송’ 으로 세고 재알림 간격(기본 6시간)까지 다시 보내지 않았다).
 *   상태 고치기(주기 판정 · 결과 반영)는 직렬 큐 하나(withState — 결과가 주기 판정 사이에 끼어 앞 쓰기를 덮지 않게). 발송 결과 수는 alertStateInfo().delivery(화면 · 전체 범위만).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { enqueueNotify, deliveryOutcome, retryDelayMs, loadAlertConfig } from '../alerts.js';
import { evaluateRows, alertOf } from './alertRules.js';
import { isMockMode } from '../mock/demo/flags.js';
import { numOrNull } from '../util/numOrNull.js';

const FILE = () => path.join(config.configDir, 'bmusage-alert-state.json');
export const MAX_SEND = Math.max(1, Number(process.env.BMUSAGE_ALERT_MAX) || 40);   // v2.929: 성능 알림 규칙(perfAlerts)도 주기당 이 상한을 쓴다(반증 F6)

let _state = null;
/** 상태 고치기 직렬 큐(5회차 D2 — 주기 판정과 발송 결과 반영이 서로 덮지 않게). */
let _chain = Promise.resolve();
function withState(fn) { const run = _chain.then(fn); _chain = run.catch(() => {}); return run; }
/** 대기열에 넣은 발송(결과 반영까지) — 시험 · 종료용. */
const _pendingSends = new Set();
/** 직전 주기 발송 결과 수(화면 — 보냄 · 실패 · 정책상 안 보냄 · 보내는 중 · 재시도 예약). */
let _delivery = null;
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
export function _resetAlertStateForTest() { _state = null; _delivery = null; _chain = Promise.resolve(); try { fs.unlinkSync(FILE()); } catch { /* */ } }
/** 시험 · 종료용 — 대기열에 넣은 발송의 결과 반영까지 기다린다. */
export async function _drainBmUsageAlertsForTest() { while (_pendingSends.size) await Promise.allSettled([..._pendingSends]); await _chain; }
/** 화면용 — 지금 추적 중인 초과 건수(비밀 없음). */
export function alertStateInfo() {
  const s = load();
  const tracked = Object.entries(s);
  return {
    tracked: tracked.length,
    notified: tracked.filter(([, v]) => v?.notifiedAt != null && !(Number(v?.retries) > 0)).length,   // 5회차 D3: 실패해 재시도를 기다리는 것은 ‘알린 것’ 이 아니다
    maxSend: MAX_SEND,
    // 5회차 D3: 직전 주기 발송 결과 — ‘발송’ 을 넣은 수가 아니라 받은 결과로(보냄 · 실패 · 안 보냄(정책) · 보내는 중 · 재시도 예약)
    delivery: _delivery ? { ..._delivery, pending: Math.max(0, _delivery.queued - _delivery.sent - _delivery.failed - _delivery.skipped) } : null,
  };
}
/**
 * 발송 결과 → 상태(순수에 가까운 고치기 — withState 안에서). 결과 판정은 alerts.deliveryOutcome · 재시도 간격은 alerts.retryDelayMs(성능 알림 규칙 · 알림 엔진과 같은 함수).
 *   ‘초과’ 발송이 받은 채널 없이 실패했고 그 상태가 아직 이 발송의 것이면(notifiedAt = 보낸 주기 시각) notifiedAt 을 (지금 + 재시도 간격 − 재알림 간격)으로 앞당긴다 —
 *   다음 판정이 재알림 간격이 지난 것으로 보고 다시 보낸다(알림 엔진 applyOutcome 과 같은 방식). 받았으면 재시도 수를 지운다. 해제 발송 실패는 상태가 없어 재시도하지 않는다.
 * @returns {boolean} 상태를 바꿨는가
 */
export function applyAlertOutcome(state, { id, mark, kind, outcome, repeatMs, suppressMs = 0, now = Date.now() } = {}) {
  const cur = kind === 'over' ? state?.[id] : null;
  if (!cur || cur.notifiedAt !== mark) return false;
  if (outcome === 'delivered') { if (cur.retries) { delete cur.retries; return true; } return false; }
  if (outcome !== 'failed') return false;
  const d = retryDelayMs(Number(cur.retries) || 0, repeatMs, suppressMs);
  if (d == null) return false;
  cur.notifiedAt = now + d - repeatMs;
  cur.retries = (Number(cur.retries) || 0) + 1;
  return true;
}

/**
 * 한 주기의 알림. 설정이 꺼져 있으면 **판정도 하지 않는다**(상태를 건드리지 않아, 다시 켤 때
 * 과거 초과가 한꺼번에 나가지 않는다).
 * @param {Array} rows  이번 주기에 적재한 행
 * @param {object} settings  `loadBmUsageSettings()`
 */
export async function runBmUsageAlerts(rows = [], settings = {}) {
  if (!settings.alertEnabled) return { ok: true, skipped: 'disabled' };
  // v2.708: 데모(mock) 값으로 실제 채널에 알리지 않는다.
  if (isMockMode()) return { ok: true, skipped: 'demo' };
  return withState(() => runCycle(rows, settings));
}
async function runCycle(rows, settings) {
  const cfg = {
    pct: settings.alertPct, sustainMin: settings.alertSustainMin,
    repeatHours: settings.alertRepeatHours, intervalMs: settings.intervalMs,
    // v2.599(RECENT2599-01): 관측 간격 = 주기 + 수집 시간 — 지속 판정의 연속 한도에 쓴다.
    runMs: settings.runMs,
  };
  const now = Date.now();
  const prev = load();
  const { next, fires: fires0, counts } = evaluateRows(rows, prev, cfg, now);
  /*
   * 8a단계 ① 정비 창(설계 §20 ⑲ — 판정 코어 maint/judge.js 하나): 창 안 발화는 보내지 않고 상태에 표지를 단다 → 창 뒤에도 초과면 그때 1회(‘창 안부터 초과’).
   *   판정기를 못 만들면(파일 손상 등) 억제하지 않는다(알림이 나가는 쪽). 규약 · 상태 모양은 maint/alertHold.js 머리말.
   */
  let fires = fires0; let maintOut = null; let countAfter = null;
  try {
    const R = await import('./maint/runtime.js');
    const J = settings.maintJudge || await R.maintJudge({ now });
    const byKey = new Map((rows || []).map((r) => [String(r.key || '').trim(), r]));
    const H = (await import('./maint/alertHold.js')).holdThresholdFires({ prev, next, fires: fires0, now,
      stateOf: (key) => { const r = byKey.get(key) || {}; return J.stateFor(settings.targetOf?.(key) || { key, vcenterId: r.vcenterId || '' }, now); } });
    fires = H.send;
    for (const a of H.applied) R.noteApplied('alerts', a.key, a.until, a.ids, now, { occ: a.occ || null });   // 창마다(3회차 D3)
    for (const ids of H.counted) R.countSuppression('alerts', ids, { now });
    // 83회차(82회차 '남긴 것' ② 반증 — 재현): '정비 창 뒤 첫 발화' 계수는 **실제로 보내는 것만** — 주기 상한(MAX_SEND)에 잘린 발화는 다음 주기에 다시 판정돼
    //   거기서 센다(예전에는 이번에도 세어 같은 발화가 두 번 셌다). 아래 take 를 정한 뒤 센다.
    countAfter = (f) => R.countSuppression('after', f.maintIds || [], { now });
    maintOut = { held: H.held, heldNew: H.heldNew, after: H.after };
  } catch (e) { maintOut = { error: String(e?.message || e).slice(0, 120) }; }
  // ⚠ 위험한 것(초과)을 먼저 — 상한에 걸려 잘릴 때 해제 알림이 초과를 밀어내면 안 된다.
  const ordered = [...fires].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'over' ? -1 : 1));
  const take = ordered.slice(0, MAX_SEND);
  if (countAfter) for (const f of take) if (f.afterMaint) { try { countAfter(f); } catch { /* 통계 — 발송을 막지 않는다 */ } }
  /*
   * 82회차 F1(재현): 상한을 넘겨 이번에 보내지 않은 발화는 **상태를 되돌려 다음 주기에 다시 판정**한다(형제 perfAlerts.dispatch 의 deferred 와 같은 규칙 —
   *   idrac-server.md 8b 반증 F6). 예전에는 evaluateRows 가 찍은 notifiedAt 을 그대로 저장해, 잘린 초과는 한 번도 보내지 않았는데 ‘알림’ 으로 기록돼
   *   재알림 간격(기본 6시간) 동안 억제됐고(잘린 수만 capped 로 밝혔다), 잘린 해제는 상태가 지워져 영영 보내지 않았다.
   *   초과: notifiedAt · retries 를 직전 상태 값으로(지속 구간 since · overMs 는 그대로 — 다음 주기 판정이 곧바로 다시 발화) · 해제: 직전 상태를 그대로 들고 간다.
   */
  for (const f of ordered.slice(MAX_SEND)) {
    const id = `${f.key}|${f.metric}`;
    const p = prev?.[id] || null;
    if (f.kind === 'over' && next[id]) {
      const { notifiedAt: _n, retries: _r, ...rest } = next[id];
      // 정비 창 뒤 첫 발화(afterMaint)가 잘렸으면 창 표지도 들고 간다 — 다음 주기 발화가 ‘(정비 창 안부터 초과)’ 로 나가게.
      next[id] = { ...rest, notifiedAt: numOrNull(p?.notifiedAt) ?? null, ...(numOrNull(p?.retries) > 0 ? { retries: numOrNull(p.retries) } : {}), ...(p?.maint ? { maint: p.maint } : {}) };
    } else if (f.kind === 'recovered' && p) next[id] = p;
  }
  save(next);
  if (!fires.length) { _delivery = { at: now, queued: 0, sent: 0, failed: 0, skipped: 0, retry: 0 }; return { ok: true, queued: 0, counts, ...(maintOut ? { maint: maintOut } : {}) }; }
  // 5회차 D2: 대기열로 넣고 기다리지 않는다 · D3: 결과는 끝난 뒤 같은 판정 · 같은 재시도 규칙으로 상태에 반영한다.
  let acfg = null; try { acfg = loadAlertConfig(); } catch { acfg = null; }
  const repeatMs = Math.max(0, numOrNull(settings.alertRepeatHours) ?? 6) * 3_600_000;   // stepAlert 와 같은 읽기(0 = 매 주기 — 재시도 없음)
  const suppressMs = Math.max(0, Number(acfg?.suppressWindowMin ?? 5)) * 60_000;
  const tally = { at: now, queued: take.length, sent: 0, failed: 0, skipped: 0, retry: 0 };
  _delivery = tally;
  for (const f of take) {
    const id = `${f.key}|${f.metric}`;
    const p = Promise.resolve().then(() => enqueueNotify(alertOf(f), acfg || undefined))
      .catch((e) => [`queue:err ${String(e?.message || e).slice(0, 120)}`])
      .then((res) => {
        const outcome = deliveryOutcome(res);
        if (outcome === 'delivered') tally.sent += 1; else if (outcome === 'failed') tally.failed += 1; else tally.skipped += 1;
        return withState(() => {
          const st = load();
          if (applyAlertOutcome(st, { id, mark: now, kind: f.kind, outcome, repeatMs, suppressMs, now: Date.now() })) {
            if (outcome === 'failed') tally.retry += 1;
            save(st);
          }
        });
      })
      .catch(() => {})
      .finally(() => _pendingSends.delete(p));
    _pendingSends.add(p);
  }
  return {
    ok: true, queued: take.length, counts, ...(maintOut ? { maint: maintOut } : {}),
    capped: Math.max(0, ordered.length - take.length),
    fires: take.map((f) => ({ kind: f.kind, key: f.key, metric: f.metric, value: f.value })),
  };
}
