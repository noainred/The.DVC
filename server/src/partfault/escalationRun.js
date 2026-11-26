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
import { openFaultsOrNull, partFaultDbMissing, partFaultDbHasHistory } from './db.js';
import { alertOf } from './notify.js';
import { notify as sendAlert, deliveryOutcome } from '../alerts.js';
import { sendPortalMail } from '../mail/service.js';
import { escalationStore, loadEscalationState, saveEscalationState, escalationStateUnreadable, escalationPlan, recordSends, ESC_SENDS_PER_RUN, partKeyOf, partSigOf } from './escalation.js';

export const ESC_TICK_MS = 60_000;   // 회차 주기 — 화면은 API 값(tickMs)으로 쓴다(숫자를 화면에 박지 않는다 — 반증 B10)
const TICK_MS = ESC_TICK_MS;
let _timer = null; let _busy = false;
let _last = null;
let _heldKeys = new Set();   // 마지막 회차에서 정비 창 보류로 보내지 않은 장애 열쇠(행 표지용 — 화면 U7)
export const escalationRunMarks = () => (_last ? { why: _last.why || '', heldKeys: _heldKeys } : null);
/**
 * 행 표지용 — **지금** 보내지 않는 사유(진행 기록 못 읽음 · 부품 장애 점검 꺼짐 · 데모) + 마지막 회차의 정비 창 보류 열쇠.
 *   마지막 회차만 보면 재시작 뒤 첫 회차 전(1~2분)에 ‘보냅니다’ 로 보였다(디버깅 2회차 화면 D2). 단계 올리기 꺼짐은 행마다 말하지 않는다(대상 밖).
 */
export async function escalationMarksNow() {
  let why = '';
  if (escalationStateUnreadable()) why = 'state-unreadable';
  else if (escalationStore.loadError()) why = 'settings-unreadable';   // 설정을 못 읽으면 정책을 모른다 — 행이 ‘꺼짐 · 정책 밖’ 으로 보이지 않게(디버깅 8회차 판정 #2)
  else {
    let sw = { enabled: true, source: '' };
    try { sw = (await _deps.partFaultSwitch()) || sw; } catch { /* 모르면 막지 않는다 */ }
    why = !sw.enabled ? 'partfault-off' : sw.source === 'demo' ? 'demo' : '';
  }
  return { why, heldKeys: _heldKeys };
}   // { at, enabled, sent, delivered, failed, deferred, overCap, held, why?, errors:[], results:[] }

/** 단계 알림 한 건의 제목 · 본문(순수 — 시험이 고정). 채널 억제 열쇠에 수집 주체를 넣는다(두 엣지의 같은 파트 키가 서로를 억제하지 않게 — 반증 A17). */
export function escalationMessage(s, now = Date.now()) {
  const a = alertOf(s.part);
  const stepNo = s.step + 2;
  const mins = Math.max(0, Math.round((now - (Number(s.since) || now)) / 60_000));
  const title = `[${stepNo}단계 · 확인 없음] ${a.title}`;
  const oc = s.to.oncall;
  const lines = [a.detail, '',
    `아무도 확인하지 않아 ${stepNo}단계로 올렸습니다(정책: ${s.policy.name}${mins ? ` · ${mins}분째` : ''}). 부품 장애 화면에서 ‘확인’ 을 누르면 단계 올리기가 멈춥니다.`];
  // 건너뛴 단계 — 멈춘 동안(점검 꺼짐 · 데모 · 정비 창 · 회차 상한) 시각이 지나 보내지 않은 앞 단계를 밝힌다(화면 설명이 ‘결과에 밝힙니다’ 라고 약속한다 — 디버깅 8회차 화면 U2)
  const sk = (Array.isArray(s.skippedNote) ? s.skippedNote : Array.isArray(s.skipped) ? s.skipped : []).map((k) => k + 2);   // 다시 시도 회차도 밝힌다(9회차 화면 U3)
  if (sk.length) lines.push(`${sk.join(' · ')}단계는 시각이 지난 뒤 처음 본 회차라 보내지 않았습니다(건너뜀).`);
  // 받는 곳에 가지 않은 단계 — 건너뜀과 가른다(9회차 판정 #4) · 보내지 않은 경우(당직 없음)도 있어 ‘보냈으나’ 라 하지 않고 기록의 사유를 싣는다(10회차 화면 D2)
  const udIdx = Array.isArray(s.undeliveredNote) ? s.undeliveredNote : [];
  if (udIdx.length) lines.push(`${udIdx.map((k) => `${k + 2}단계${s.undeliveredWhy?.[k] ? `(${s.undeliveredWhy[k]})` : ''}`).join(' · ')}는 받는 곳에 가지 않았습니다.`);
  if (oc) lines.push(`오늘 당직: ${oc.name || oc.email}${oc.agent === '*' ? '' : ` (${oc.agent || '이 포탈'} 당직표)`}`);
  else if (s.to.oncallWanted) lines.push('당직표에 오늘 당직이 없어 당직에게는 보내지 못했습니다.');
  const ag = String(s.part.agent || '').trim().toLowerCase();
  // 열쇠 = 장애 · 정책 · 세대(since — 다시 켜면 바뀐다) · 단계 · 다시 시도 번호. 정책이 바뀌거나 다시 켠 뒤 옛 열쇠가 억제 창에 걸려 새 단계가 막히지 않게(디버깅 2회차 판정 #3) · 다시 시도마다 다른 열쇠(1회차 판정 #2)
  const gen = Number.isFinite(Number(s.since)) ? Number(s.since) : 0;
  return { key: `partfault-esc:${ag}|${s.part.partKey}:${String(s.policy?.id || '')}:${gen}:${s.step}:${Number.isInteger(s.attempt) ? s.attempt : 1}`, severity: a.severity, title, detail: lines.join('\n') };
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
  if (!out.length) out.push(s.to.oncall && !s.to.oncall.email ? `받는 곳 없음(오늘 당직 ${String(s.to.oncall.name || '').slice(0, 30)} 의 메일 주소가 당직표에 없음)` : '받는 곳 없음(당직표에 오늘 당직이 없음)');   // 원인을 가른다(판정 #10)
  return { text: out.join(' / '), delivered };
}

const DEFAULT_DEPS = {
  // DB 를 못 열면 ‘열린 장애 0건’ 이 아니다 — 그 회차를 건너뛴다(빈 목록으로 계획하면 진행 · 확인 기록이 전부 지워지고 DB 가 돌아오면 확인한 장애에도 단계가 다시 갔다 — 디버깅 7회차 판정 #3)
  // DB 파일이 없는 노드(부품 장애 점검을 켠 적 없음)에는 파일을 만들지 않는다 — 열린 장애도 없다(만들면 ‘수집 안 함’ 이 ‘읽었고 0건’ 으로 바뀌었다 — 디버깅 8회차 판정 #3).
  //   ‘없음’ 은 ENOENT 만 — 권한 · 링크 고리 · 디스크 오류는 열기로 넘겨 회차를 건너뛴다(9회차 보안 #1)
  //   진행 기록이 있는데 DB 파일이 없으면 ‘0건’ 이 아니라 못 읽음이다(볼륨이 아직 안 붙음 · 경로가 바뀜 — 지우면 확인한 장애에도 단계가 다시 갔다 · 9회차 판정 #1)
  //   열었는데 0건이고 이 DB 에 기록이 한 번도 없으면(새로 만들어진 빈 DB) 진행 기록이 있는 동안은 닫힘이 아니다 — 못 읽음으로 건너뛴다(10회차 보안 #1).
  //   부품 장애 판정이 장애를 다시 잡으면 DB 에 기록이 생겨 보통 회차로 돌아간다(그때 빠진 장애는 진짜 닫힘 — 반증 A5)
  open: async () => {
    const hasItems = () => Object.keys(loadEscalationState().items || {}).length > 0;
    if (partFaultDbMissing()) { if (hasItems()) throw new Error('부품 장애 DB 파일이 없습니다(진행 기록은 있음 — 볼륨 · 경로 확인)'); return []; }
    const r = await openFaultsOrNull(); if (!r) throw new Error('부품 장애 DB 를 열지 못했습니다');
    if (!r.length && hasItems() && (await partFaultDbHasHistory()) === false) throw new Error('부품 장애 DB 가 비어 있습니다(새로 만들어짐 — 장애를 다시 잡을 때까지 진행 기록을 지우지 않습니다)');
    return r;
  }, mail: (o) => sendPortalMail(o), channels: (a) => sendAlert(a), now: () => Date.now(),
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
    // 단계 · 당직 설정을 못 읽은 회차는 계획 · 저장을 하지 않는다 — 빈 설정(꺼짐)으로 돌면 옛 기록의 그때 정책(lp)이 빈 목록으로 굳어 설정이 돌아온 뒤 같은 단계를 다시 보냈다(디버깅 7회차 판정 #1)
    if (escalationStore.loadError()) {
      // 계획 · lp 는 쓰지 않되 **닫힌 장애의 기록은 정리한다**(반증 A5 — 다시 열린 장애가 옛 확인 · 보낸 단계를 물려받지 않게). 키 이전 후보(같은 sig)는 남긴다(디버깅 8회차 판정 #1)
      if (!escalationStateUnreadable()) {
        let o = null; try { o = await deps.open(); } catch { o = null; }
        if (Array.isArray(o)) {
          const st = loadEscalationState(); const keys = new Set(o.map(partKeyOf)); const sigs = new Set(o.map(partSigOf));
          const kept = Object.fromEntries(Object.entries(st.items).filter(([k, v]) => keys.has(k) || (v?.sig && sigs.has(v.sig))));
          if (Object.keys(kept).length !== Object.keys(st.items).length) saveEscalationState({ ...st, items: kept });
        }
      }
      _heldKeys = new Set(); _last = { at: now, enabled: false, sent: 0, delivered: 0, failed: 0, deferred: 0, why: 'settings-unreadable', errors: ['단계 · 당직 설정을 읽지 못해 이번 회차를 건너뛰었습니다(빈 설정으로 진행 기록을 바꾸지 않습니다).'] }; return _last;
    }
    if (escalationStateUnreadable()) { _heldKeys = new Set(); _last = { at: now, enabled: settings.enabled, sent: 0, delivered: 0, failed: 0, deferred: 0, why: 'state-unreadable', errors: ['진행 기록을 읽지 못해 보내지 않았습니다(보낸 단계를 모르는 채 보내지 않는다).'] }; return _last; }
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
    _heldKeys = new Set(plan.heldKeys || []);
    const results = [];
    for (const s of plan.sends) {
      // 보내기 직전 — 그 사이 확인됐으면 보내지 않는다(확인 라우트가 메모리 기록을 바꾼다)
      if (loadEscalationState().items[s.key]?.ackedAt) { results.push({ notSent: true, text: '보내지 않음(그 사이 확인됨)' }); continue; }
      // eslint-disable-next-line no-await-in-loop
      results.push(await sendOne({ ...s, since: s.since ?? plan.items[s.key]?.since }, deps, now));   // 그 정책의 시작 시각(3회차 판정 #1)
    }
    let items = recordSends(plan.items, plan.sends, results, now);
    // 회차 동안 들어온 확인을 덮지 않는다 — 최신 기록의 확인을 키별로 합친다(확인 쪽 우선 · 반증 A1)
    const latest = loadEscalationState().items;
    // 열린 장애 열쇠는 한 번만 만들고 · 기록 사본도 한 번만 — 확인이 많을 때 매번 전부를 훑거나 복사하지 않게(v3.52 디버깅 1회차 성능 P3 — O(N²))
    let openKeys = null; let copied = false;
    const put = (k, v) => { if (!copied) { items = { ...items }; copied = true; } items[k] = v; };
    for (const [k, v] of Object.entries(latest)) {
      if (!v?.ackedAt) continue;
      if (Object.hasOwn(items, k)) { if (!items[k].ackedAt) put(k, { ...items[k], ackedAt: v.ackedAt, ackBy: v.ackBy }); }
      else {
        if (!openKeys) openKeys = new Set(open.map((p) => `${String(p.agent || '').trim().toLowerCase()}|${p.partKey}`));
        if (openKeys.has(k)) put(k, v);
      }
    }
    const next = { v: 1, items, enabledAt: plan.enabledAt };
    const changed = JSON.stringify(next) !== JSON.stringify({ v: 1, items: latest, enabledAt: loadEscalationState().enabledAt ?? null });
    const saved = changed ? saveEscalationState(next) : true;
    const sentRes = results.filter((r) => !r.notSent);
    _last = { at: now, enabled: settings.enabled, ...(why ? { why } : {}), sent: sentRes.length, delivered: sentRes.filter((r) => r.delivered).length, failed: sentRes.filter((r) => !r.delivered).length,
      deferred: plan.deferred, overCap: plan.overCap, held: plan.held, errors: saved ? [] : ['진행 기록을 쓰지 못했습니다 — 다음 회차에 같은 단계를 다시 보낼 수 있습니다.'],
      // 보내지 않은 줄(그 사이 확인)은 건너뜀 · 안 감을 말하지 않는다(그 회차는 skip 을 적지 않았다 — 11회차 판정 관찰)
      results: plan.sends.map((s, i) => ({ part: `${s.part.deviceName || s.part.deviceId || ''} · ${s.part.label || ''}`.slice(0, 120), step: s.step + 2, ...(!results[i]?.notSent && (s.skippedNote || s.skipped)?.length ? { skipped: (s.skippedNote || s.skipped).map((k) => k + 2) } : {}), ...(!results[i]?.notSent && s.undeliveredNote?.length ? { undelivered: s.undeliveredNote.map((k) => k + 2) } : {}), result: results[i]?.text || '', delivered: !!results[i]?.delivered, ...(results[i]?.notSent ? { notSent: true } : {}) })).slice(0, 20) };   // notSent — 회차 도중 확인돼 보내지 않음(안 감 아님 · 10회차 화면 D5)
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
