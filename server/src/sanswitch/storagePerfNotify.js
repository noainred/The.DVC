/**
 * sanswitch/storagePerfNotify.js — SAN 스토리지 성능 알림 **러너**(v2.950 · 설계 §12.2-6). 설정 · 상태 · 전이 판정은 storagePerfNotifyStore.js(순수 부분), 점검은 라우트 모듈의
 * `buildListCore · runCheck`(판정 코어 하나 — 화면 · 공개 API · 월간 보고서와 같은 함수).
 *
 * 규약(CLAUDE.md 폴러): 주기는 매 틱 조회(SAN 포트 사용량 수집 주기 · 하한 5분) · 재진입 가드 · 중앙만(엣지는 보내지 않는다 — 엣지 현장 알림은 설계 밖) · 0건이어도 상태를 올린다(lastTick).
 * 발송은 alerts.notify(채널 공용 — Slack · Teams · 웹훅 · 메일 kind 'alert' · 전역 억제 창) · 법인당 알림 1건 · 상태가 바뀐 순간만 · 첫 틱은 기준만 잡는다.
 */
import { config } from '../config.js';
import { notify as sendAlert } from '../alerts.js';
import { startAdaptiveTimer } from '../storage/intervals.js';
import { loadPerfSettings } from './perfSettings.js';
import { loadNotifySettings, notifyLoadError, loadNotifyState, saveNotifyState, recordNotify, snapshotOf, carryKnown, diffCheck, alertsOf } from './storagePerfNotifyStore.js';
import { CHECK_ITEMS } from './storagePerfCheck.js';
import { deviceContextOf, buildListCore, runCheck } from './storagePerfCore.js';   // 판정 코어(라우트가 아니다 — 방향 위반 · 순환 금지)

export const NOTIFY_MIN_MS = 5 * 60_000;
const isEdge = () => !!(config.agent.centralUrl && config.agent.centralToken);
const tickMs = () => Math.max(NOTIFY_MIN_MS, Number(loadPerfSettings()?.intervalMs) || NOTIFY_MIN_MS);
const LABELS = Object.fromEntries(CHECK_ITEMS.map((i) => [i.k, i.label]));
let _timer = null; let _busy = false; let _last = null;

/** 한 틱 — 판정 → 전이 → 법인별 알림. 던지지 않는다(결과 객체). 테스트 · '지금 판정해 보내기' 가 직접 부른다. */
export async function pollStoragePerfNotifyOnce({ now = Date.now(), send = sendAlert, force = false } = {}) {
  if (_busy) return { action: 'busy' };
  _busy = true;
  try {
    if (isEdge()) return { action: 'edge' };
    if (notifyLoadError()) { _last = { at: now, action: 'unreadable' }; return _last; }
    const cfg = loadNotifySettings();
    if (!cfg.enabled && !force) { _last = { at: now, action: 'disabled' }; return _last; }
    const ctx = await deviceContextOf({ admin: true });
    const b = await buildListCore(ctx, null);
    const r = await runCheck(b, { signal: null });
    const st = loadNotifyState();
    const cur = snapshotOf(r.results);
    const d = diffCheck(st.last, cur, { minLevel: cfg.minLevel, recoveries: cfg.recoveries, items: cfg.items });
    const alerts = d.first ? [] : alertsOf(d, { labels: LABELS });
    const sent = [];
    for (const a of alerts) {
      let res;
      try { res = await send({ key: a.key, severity: a.severity, title: a.title, detail: a.detail }); } catch (e) { res = [`err ${String(e?.message || e).slice(0, 120)}`]; }
      const line = Array.isArray(res) ? res.join(' · ') : String(res);
      sent.push({ dc: a.dc, title: a.title, severity: a.severity, counts: a.counts, result: line.slice(0, 200) });
    }
    const next = { ...st, last: carryKnown(st.last, cur), at: now,   // v2.954(점검 B-2): unknown 이 직전 수준을 지우지 않게 이월
      lastTick: { at: now, arrays: r.results.length, opened: d.opened.length, recovered: d.recovered.length, alerts: alerts.length, first: d.first } };
    if (sent.length) next.history = [...sent.map((s) => ({ at: now, ...s })), ...st.history].slice(0, 20);
    saveNotifyState(next);
    _last = { at: now, action: d.first ? 'baseline' : (alerts.length ? 'sent' : 'quiet'), arrays: r.results.length, opened: d.opened.length, recovered: d.recovered.length, alerts: alerts.length, sent };
    if (alerts.length) console.log(`[san-storage-notify] 알림 ${alerts.length}건(법인) — 열림 ${d.opened.length} · 회복 ${d.recovered.length}`);
    return _last;
  } catch (e) {
    _last = { at: now, action: 'error', error: String(e?.message || e).slice(0, 200) };
    console.warn(`[san-storage-notify] 틱 실패: ${_last.error}`);
    try { recordNotify({ kind: 'error', reason: _last.error }); } catch { /* */ }
    return _last;
  } finally { _busy = false; }
}

export function startStoragePerfNotify() {
  if (_timer || isEdge()) return;
  _timer = startAdaptiveTimer(tickMs, () => pollStoragePerfNotifyOnce(), { firstDelayMs: 150_000, name: 'SAN 스토리지 성능 알림' });
}
export function storagePerfNotifyStatus() {
  const st = loadNotifyState();
  return { ...(_last || {}), intervalMs: tickMs(), busy: _busy, edge: isEdge(), lastTick: st.lastTick, history: st.history, baselineAt: st.at, arraysTracked: Object.keys(st.last || {}).length };
}
export function _resetStoragePerfNotifyForTest() { _timer = null; _busy = false; _last = null; }
