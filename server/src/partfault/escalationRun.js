/**
 * partfault/escalationRun.js — 부품 장애 알림 단계 올리기 **실행**(v3.51 · 판정은 escalation.js 의 순수 함수).
 *
 *  · 중앙만 돈다(엣지는 부품 장애를 판정하지 않는다 — 중앙이 받은 열린 장애를 본다). 60초마다 한 번 · 진행 중이면 건너뛴다(재진입 가드).
 *  · 보내지 않는 경우(기록은 정리한다): 꺼짐 · 부품 장애 점검 꺼짐 · **데모(mock)로만 켜진 점검**(합성 장애가 실제 채널로 나가지 않게 — poller.js v2.708 과 같은 규칙) ·
 *    진행 기록을 읽지 못함(보낸 단계를 모르는 채 보내지 않는다) · 정비 창 보류 장비.
 *  · 보내기는 **순차**(웹훅 · 메일 릴레이를 한꺼번에 때리지 않게). 보내기 직전에 그 장애가 그 사이 확인됐는지 다시 본다 · 회차 끝 저장은 그 사이 들어온 확인을 덮지 않는다(반증 A1).
 *  · 받는 곳 하나 이상에 ‘갔다’ 를 확인한 것만 ‘보냄’ — 메일 꺼짐 · 시간당 한도 · 채널 실패 · 당직 없음은 ‘안 감’ 으로 적고 다음 회차에 다시(ESC_RETRY_MAX 번까지 · 반증 A8 · B1).
 */
import { config } from '../config.js';
import { openFaults } from './db.js';
import { alertOf } from './notify.js';
import { notify as sendAlert, deliveryOutcome } from '../alerts.js';
import { sendPortalMail } from '../mail/service.js';
import { escalationStore, loadEscalationState, saveEscalationState, escalationStateUnreadable, escalationPlan, recordSends, ESC_SENDS_PER_RUN } from './escalation.js';

export const ESC_TICK_MS = 60_000;   // 회차 주기 — 화면은 API 값(tickMs)으로 쓴다(숫자를 화면에 박지 않는다 — 반증 B10)
const TICK_MS = ESC_TICK_MS;
let _timer = null; let _busy = false;
let _last = null;   // { at, enabled, sent, delivered, failed, deferred, overCap, held, why?, errors:[], results:[] }

/** 단계 알림 한 건의 제목 · 본문(순수 — 시험이 고정). 채널 억제 열쇠에 수집 주체를 넣는다(두 엣지의 같은 파트 키가 서로를 억제하지 않게 — 반증 A17). */
export function escalationMessage(s, now = Date.now()) {
  const a = alertOf(s.part);
  const stepNo = s.step + 2;
  const mins = Math.max(0, Math.round((now - (Number(s.since) || now)) / 60_000));
  const title = `[${stepNo}단계 · 확인 없음] ${a.title}`;
  const oc = s.to.oncall;
  const lines = [a.detail, '',
    `아무도 확인하지 않아 ${stepNo}단계로 올렸습니다(정책: ${s.policy.name}${mins ? ` · ${mins}분째` : ''}). 부품 장애 화면에서 ‘확인’ 을 누르면 단계 올리기가 멈춥니다.`];
  if (oc) lines.push(`오늘 당직: ${oc.name || oc.email}${oc.agent === '*' ? '' : ` (${oc.agent || '이 포탈'} 당직표)`}`);
  else if (s.to.oncallWanted) lines.push('당직표에 오늘 당직이 없어 당직에게는 보내지 못했습니다.');
  const ag = String(s.part.agent || '').trim().toLowerCase();
  return { key: `partfault-esc:${ag}|${s.part.partKey}:${s.step}`, severity: a.severity, title, detail: lines.join('\n') };
}

/** 한 건 보내기 — { text, delivered }. 던지지 않는다. */
async function sendOne(s, deps, now) {
  const msg = escalationMessage(s, now);
  const out = []; let delivered = false;
  const to = [...new Set([...(s.to.emails || []), ...(s.to.oncall?.email ? [s.to.oncall.email] : [])])];
  if (to.length) {
    try {
      const r = await deps.mail({ kind: 'alert', subject: msg.title, text: msg.detail, to });
      if (r?.ok) { delivered = true; out.push(`메일 ${to.length}명`); } else out.push(`메일 안 감(${String(r?.reason || '사유 모름').slice(0, 60)})`);
    } catch (e) { out.push(`메일 오류(${String(e?.message || e).slice(0, 60)})`); }
  }
  if (s.to.channels) {
    try {
      const r = await deps.channels(msg);
      const lines = Array.isArray(r) ? r.map(String) : [String(r)];
      const outcome = deliveryOutcome(lines);
      if (outcome === 'delivered') delivered = true;
      out.push(`채널 ${outcome === 'delivered' ? '감' : outcome === 'failed' ? '실패' : '안 감'}(${lines.join(' · ').slice(0, 50) || '켜진 채널 없음'})`);
    } catch (e) { out.push(`채널 오류(${String(e?.message || e).slice(0, 60)})`); }
  }
  if (!out.length) out.push('받는 곳 없음(당직표에 오늘 당직이 없음)');
  return { text: out.join(' / '), delivered };
}

const DEFAULT_DEPS = {
  open: () => openFaults(), mail: (o) => sendPortalMail(o), channels: (a) => sendAlert(a), now: () => Date.now(),
  partFaultSwitch: async () => (await import('./settings.js')).partFaultEnabled(),
  hold: async (open, now) => {
    const M = await import('../bmusage/maint/partfaultHold.js');
    const r = await M.partfaultMaintHoldPeek(open.map((p) => ({ agent: p.agent, deviceId: p.deviceId, deviceKey: p.deviceKey, scope: p.scope })), { now });
    return { hold: r.hold, keyOf: M.maintHoldKeyOf };
  },
};
let _deps = DEFAULT_DEPS;
export function _setEscalationDepsForTest(d) { _deps = d ? { ...DEFAULT_DEPS, ...d } : DEFAULT_DEPS; }

/** 한 회차. @returns 마지막 결과(상태 화면이 쓴다) */
export async function runEscalationNow() {
  if (_busy) return { skipped: 'busy' };
  _busy = true;
  try {
    const deps = _deps;
    const now = deps.now();
    const settings = escalationStore.get();
    if (escalationStateUnreadable()) { _last = { at: now, enabled: settings.enabled, sent: 0, delivered: 0, failed: 0, deferred: 0, why: 'state-unreadable', errors: ['진행 기록을 읽지 못해 보내지 않았습니다(보낸 단계를 모르는 채 보내지 않는다).'] }; return _last; }
    const state = loadEscalationState();
    let open = [];
    try { open = await deps.open(); } catch (e) { _last = { at: now, enabled: settings.enabled, sent: 0, delivered: 0, failed: 0, deferred: 0, errors: [`열린 장애를 읽지 못했습니다(${String(e?.message || e).slice(0, 80)})`] }; return _last; }
    // 점검 스위치 — 꺼짐 · 데모로만 켜짐이면 보내지 않는다(기록 정리는 한다)
    let sw = { enabled: true, source: '' };
    try { sw = (await deps.partFaultSwitch()) || sw; } catch { /* 모르면 막지 않는다 */ }
    const why = !settings.enabled ? 'off' : !sw.enabled ? 'partfault-off' : sw.source === 'demo' ? 'demo' : '';
    let hold = null; let keyOf = null;
    if (!why) { try { const h = await deps.hold(open, now); hold = h?.hold || null; keyOf = h?.keyOf || null; } catch { hold = null; } }
    const plan = escalationPlan({ settings: why ? { ...settings, enabled: false } : settings, state, open, now, maxSends: ESC_SENDS_PER_RUN, hold, holdKeyOf: keyOf });
    const results = [];
    for (const s of plan.sends) {
      // 보내기 직전 — 그 사이 확인됐으면 보내지 않는다(확인 라우트가 메모리 기록을 바꾼다)
      if (loadEscalationState().items[s.key]?.ackedAt) { results.push({ notSent: true, text: '보내지 않음(그 사이 확인됨)' }); continue; }
      // eslint-disable-next-line no-await-in-loop
      results.push(await sendOne({ ...s, since: plan.items[s.key]?.since }, deps, now));
    }
    let items = recordSends(plan.items, plan.sends, results, now);
    // 회차 동안 들어온 확인을 덮지 않는다 — 최신 기록의 확인을 키별로 합친다(확인 쪽 우선 · 반증 A1)
    const latest = loadEscalationState().items;
    for (const [k, v] of Object.entries(latest)) {
      if (!v?.ackedAt) continue;
      if (Object.hasOwn(items, k)) { if (!items[k].ackedAt) items = { ...items, [k]: { ...items[k], ackedAt: v.ackedAt, ackBy: v.ackBy } }; }
      else if (open.some((p) => `${String(p.agent || '').trim().toLowerCase()}|${p.partKey}` === k)) items = { ...items, [k]: v };
    }
    const next = { v: 1, items, enabledAt: plan.enabledAt };
    const changed = JSON.stringify(next) !== JSON.stringify({ v: 1, items: latest, enabledAt: loadEscalationState().enabledAt ?? null });
    const saved = changed ? saveEscalationState(next) : true;
    const sentRes = results.filter((r) => !r.notSent);
    _last = { at: now, enabled: settings.enabled, ...(why ? { why } : {}), sent: sentRes.length, delivered: sentRes.filter((r) => r.delivered).length, failed: sentRes.filter((r) => !r.delivered).length,
      deferred: plan.deferred, overCap: plan.overCap, held: plan.held, errors: saved ? [] : ['진행 기록을 쓰지 못했습니다 — 다음 회차에 같은 단계를 다시 보낼 수 있습니다.'],
      results: plan.sends.map((s, i) => ({ part: `${s.part.deviceName || s.part.deviceId || ''} · ${s.part.label || ''}`.slice(0, 120), step: s.step + 2, result: results[i]?.text || '', delivered: !!results[i]?.delivered })).slice(0, 20) };
    return _last;
  } finally { _busy = false; }
}
export const escalationRunStatus = () => _last;

export function startEscalation() {
  if (_timer || config.agent.centralUrl) return;   // 중앙만
  _timer = setInterval(() => { runEscalationNow().catch(() => {}); }, TICK_MS);
  _timer.unref?.();
}
export const escalationRunning = () => !!_timer;
export function _stopEscalationForTest() { if (_timer) clearInterval(_timer); _timer = null; _last = null; }
