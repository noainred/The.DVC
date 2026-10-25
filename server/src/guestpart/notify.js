/**
 * guestpart/notify.js — 게스트 파티션 사용률 메일 발송·일정·기록(v2.749). 규칙은 아이실론 디렉터리 사용량과 같은 코어를 쓴다
 *   (isidu/digestRules.planDigestTick·digestRecipients · isidu/mailRules.mailRecipients·failAlertDue — 사본을 만들지 않는다).
 *
 * 메일 네 가지(공용 메일 종류 'guestpart' — 켜기/끄기·속도 제한·이력·감사·SMTP 인증 정지는 mail/service 가 판정한다):
 *  ① 전체 법인 통합 메일 — 정한 요일·시각. 받는 사람 = 통합 관리자(메일 설정의 기본 받는 사람, 고르면) ∪ 추가 주소.
 *  ② vCenter 별 담당자 메일 — '수집이 끝날 때마다'(그 vCenter 의 수집 커밋 직후) 또는 '정한 요일·시각'. 받는 사람 = 공통(빼지 않았으면) ∪ 담당자.
 *  ③ 95% 이상 즉시 알림(통합 메일 선택) — 수집 커밋 직후, 같은 파티션은 24시간에 한 번. 받는 사람은 ① 과 같다.
 *  ④ 수집 실패·지연 알림(vCenter 별 선택) — 직접 수집 실패(폴러 결과) 또는 값이 '신선 경계(주기×3)' 를 넘김. 같은 vCenter 6시간에 한 번.
 *
 * 지키는 것(아이실론 종합 메일과 같다):
 *  · **중앙만 보낸다**(엣지는 메일 주소를 받지 않고 틱도 돌지 않는다).
 *  · 회차는 한 번만 — 처리한 회차(lastSlot)를 **보내기 전에** 상태 파일에 남긴다. 놓친 회차는 몰아서 보내지 않고 기록만 한다.
 *  · 기록은 주소 없이 개수만 남긴다. 사람이 누른 '지금 보내기' 는 '새 수집 없으면 생략'·'새로 넘은 것 없으면 생략' 을 보지 않는다.
 *  · 데모(mock) 데이터는 자동 메일로 보내지 않는다(사람이 누른 발송은 데모 표지를 달고 보낸다).
 *  · 받는 사람이 비면 보내지 않는다 — 공용 서비스는 빈 목록을 '기본 받는 사람' 으로 바꾸므로 여기서 먼저 막는다(엉뚱한 사람에게 가지 않게).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { store } from '../store.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';
import { sendPortalMail } from '../mail/service.js';
import { load as loadMailCfg } from '../mail/settings.js';
import { planDigestTick, nextDigestSlots, digestRecipients, slotLabel } from '../isidu/digestRules.js';
import { mailRecipients, failAlertDue, normalizeMailList, isEmail } from '../isidu/mailRules.js';
import { onGuestDiskCommitted, latestHoldMs, coverageByVcenter, listPartLatest } from '../guestdisk/db.js';
import { onGuestDiskRunDone } from '../guestdisk/poller.js';
import { load as loadSettings, settingsLoadError, digestOf } from './settings.js';
import { overview, overCsv } from './report.js';
import { renderOverMail, renderFailMail } from './mailHtml.js';
import { CRIT_PCT } from './rules.js';
import { todayStamp } from '../util/dayKey.js';

export const MAIL_KIND = 'guestpart';
export const TICK_MS = 30_000;
export const HISTORY_MAX = 60;
export const KEYS_MAX = 20_000;
export const CRIT_REPEAT_MS = 24 * 3_600_000;
const BOOT_AT = Date.now();

registerStateFile('guestpart-mail-state.json');
const FILE = () => path.join(config.configDir, 'guestpart-mail-state.json');   // ⚠ 리터럴 형태 유지 — scripts/config-doc.mjs 가 이 모양으로 찾는다
const isEdge = () => !!(config.agent.centralUrl && config.agent.centralToken);
const isMock = () => store.get()?.source === 'mock';

let _state = null;
const emptyStream = () => ({ lastSlot: null, lastSentAt: null, lastDataTs: null, lastKeys: [], lastFailAlertAt: null });
function state() {
  if (_state) return _state;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('형식 오류');
    const stream = (x) => ({ ...emptyStream(), ...(x && typeof x === 'object' ? x : {}), lastKeys: Array.isArray(x?.lastKeys) ? x.lastKeys.filter((k) => typeof k === 'string').slice(0, KEYS_MAX) : [] });
    const vc = {};
    for (const [id, v] of Object.entries(raw.vc && typeof raw.vc === 'object' ? raw.vc : {})) vc[id] = stream(v);
    _state = { digest: stream(raw.digest), vc, crit: raw.crit && typeof raw.crit === 'object' && !Array.isArray(raw.crit) ? raw.crit : {},
      history: (Array.isArray(raw.history) ? raw.history : []).filter((h) => h && typeof h === 'object').slice(0, HISTORY_MAX) };
  } catch (e) {
    if (e?.code !== 'ENOENT') { preserveCorrupt(FILE(), e?.message); console.warn(`[guestpart] 메일 상태 파일을 읽지 못해 새로 시작합니다: ${safeLoadText(e) || '사유 미상'}`); }
    _state = { digest: emptyStream(), vc: {}, crit: {}, history: [] };
  }
  return _state;
}
function save() {
  try { atomicWriteFileSync(FILE(), JSON.stringify(state()), { mode: 0o600 }); }
  catch (e) { console.warn(`[guestpart] 메일 상태를 저장하지 못했습니다(메모리로 계속): ${e.message}`); }
}
const vcState = (id) => { const st = state(); if (!st.vc[id]) st.vc[id] = emptyStream(); return st.vc[id]; };

/** 기록 한 줄(주소 없이 개수만). 최신이 앞. */
function record(entry) {
  const st = state();
  const e = { at: Date.now(), ...entry };
  if (e.reason) e.reason = String(e.reason).slice(0, 300);
  st.history.unshift(e);
  st.history.length = Math.min(st.history.length, HISTORY_MAX);
  save();
  return e;
}

let _chain = Promise.resolve();
const serial = (fn) => { const p = _chain.then(fn, fn); _chain = p.catch(() => {}); return p; };

const keyOf = (r) => (r.path == null ? r.vmId : `${r.vmId}\u0000${r.path}`);

/*
 * v2.782(점검 K2 H-B2): '새로 넘은 것만'(통합 newOnly)·'새로 넘은 게스트가 없으면 보내지 않기'(vCenter onlyOnChange)로 **건너뛸 때도**
 *   회복된 키는 기억(lastKeys)에서 뺀다. 예전에는 발송 성공 때만 lastKeys 가 바뀌어 90% → 메일 → 50% 회복(건너뜀) → 92% 재초과가
 *   '새로 넘음' 이 아니어서 다시는 메일이 가지 않았다(다른 키가 새로 넘을 때까지 무기한).
 *   빼는 것은 **이번 수집에서 값을 읽었는데 지금 초과가 아닌** 키만이다 — 이번에 보고되지 않은 VM(Tools 중단·전원 꺼짐)이나
 *   여유를 보고하지 않은 파티션(값 모름)은 '회복' 이 아니므로 남긴다('못 읽은 값은 0 이 아니다'). 새 키는 넣지 않는다(보내지 않았으므로).
 *   파티션 키(vmId\0경로)는 그 파티션이, VM 키(판정 단위 'vm')는 그 VM 의 값 있는 파티션이 하나라도 이번 수집에 있으면 '값을 읽음' 이다.
 */
async function prunedKeys(prev, keysNow, vcenterIds) {
  if (!prev.length) return prev;
  const rows = await listPartLatest(vcenterIds);
  const knownPart = new Set(); const knownVm = new Set();
  for (const p of rows) { if (p.unknown) continue; knownPart.add(`${p.vmId}\u0000${p.path}`); knownVm.add(p.vmId); }
  return prev.filter((k) => keysNow.has(k) || !(k.includes('\u0000') ? knownPart.has(k) : knownVm.has(k)));
}
async function forgetRecovered(st, b, vcenterIds) {
  const next = await prunedKeys(st.lastKeys || [], new Set(b.keys), vcenterIds);
  if (next.length !== (st.lastKeys || []).length) { st.lastKeys = next; save(); }
}
const adminTo = () => { try { return loadMailCfg().defaultTo || []; } catch { return []; } };
export const digestRecipientsOf = (d) => digestRecipients({ includeAdmin: d.includeAdmin, to: d.to }, adminTo());
const vcRecipientsOf = (s, id) => mailRecipients(s.mail.commonTo, s.mail.vcenters[id] || null);
const fromOf = (s) => ({ fromAddr: s.mail.from || '', fromName: s.mail.fromName || null });
const dataTsOf = (r) => r.vcenters.reduce((a, v) => Math.max(a, v.lastTs || 0), 0) || null;

function staleNoteOf(r, now) {
  const ts = dataTsOf(r);
  if (!ts) return '아직 수집된 게스트 파티션 값이 없습니다.';
  return now - ts > 24 * 3_600_000 ? `마지막 수집이 ${slotLabel(ts)} 입니다 — 24시간보다 오래된 값입니다.` : '';
}

/**
 * 메일 한 통 만들기(보내지 않음) — 발송·미리보기가 같이 쓴다.
 * target: 'digest' | vCenter id.  d: 통합 메일 설정(미리보기는 저장 전 값).
 */
async function buildMail(target, { s, d = null, now = Date.now(), streamState = null, test = false }) {
  const isDigest = target === 'digest';
  const dg = d || s.mail.digest;
  const r = await overview({ allowed: isDigest ? null : new Set([target]), thr: isDigest ? dg.thr : null, all: true, now });
  const prevKeys = new Set(streamState?.lastKeys || []);
  const keys = r.rows.map(keyOf);
  const newKeys = new Set(keys.filter((k) => !prevKeys.has(k)));
  // vCenter 메일의 '새로 넘은 게스트가 없으면 보내지 않기'(onlyOnChange)는 보낼지 판단에만 쓴다 — 본문은 초과 전체(새로 넘은 것은 표지). 아이실론 대상 메일과 같은 뜻.
  const newOnly = isDigest ? dg.newOnly : false;
  const rows = newOnly ? r.rows.filter((x) => newKeys.has(keyOf(x))) : r.rows;
  const vc = isDigest ? null : r.vcenters.find((v) => v.id === target);
  const csvName = isDigest && dg.csv ? `guest-partition-over-${dg.thr ?? s.threshold}-${todayStamp().replace(/-/g, '')}.csv` : null;
  const mail = renderOverMail({
    kind: test ? 'test' : (isDigest ? 'digest' : 'vcenter'), scopeLabel: isDigest ? '전체 법인' : (vc?.name || target),
    thr: isDigest ? (dg.thr ?? s.threshold) : (s.vcThresholds[target] ?? s.threshold), mode: r.mode, collectedAt: dataTsOf(r),
    rows, total: rows.length, topN: isDigest ? dg.topN : 30, newKeys, newOnly,
    kpi: { overVms: r.kpi.overVms, crit: r.kpi.crit, notReported: r.kpi.notReported, newCount: newKeys.size },
    vcSummary: isDigest ? r.vcenters : null, staleNote: staleNoteOf(r, now), csvName, demo: isMock(),
  });
  const attachments = csvName && rows.length ? [{ filename: csvName, contentType: 'text/csv', content: overCsv({ ...r, rows }) }] : [];
  return { mail, attachments, keys, newKeys, rows, dataTs: dataTsOf(r), newOnly };
}

/** ① 통합 메일 발송(던지지 않는다). */
export function sendDigest({ slot = null, manual = false, by = 'system', now = Date.now(), to = null } = {}) {
  return serial(async () => {
    const kind = manual ? 'manual' : 'schedule';
    const scope = '전체 법인';
    try {
      if (isEdge()) return { ok: false, state: 'edge' };
      if (settingsLoadError()) return { ok: false, ...record({ slot, kind, scope, state: 'skipped', code: 'unreadable', reason: '설정 파일을 읽지 못해 보내지 않았습니다.' }) };
      if (!manual && isMock()) return { ok: false, ...record({ slot, kind, scope, state: 'skipped', code: 'demo', reason: '데모(mock) 데이터라 자동 메일을 보내지 않았습니다.' }) };
      const s = loadSettings();
      const d = s.mail.digest;
      const rcpt = to ? { to } : digestRecipientsOf(d);
      if (!rcpt.to.length) return { ok: false, ...record({ slot, kind, scope, state: 'skipped', code: 'no-recipients', reason: "받는 사람이 없습니다 — '통합 관리자'(설정 › 메일 발송의 기본 받는 사람)를 고르거나 추가 주소를 넣으세요." }) };
      const st = state().digest;
      const b = await buildMail('digest', { s, now, streamState: st, test: !!to });
      if (!manual && d.skipIfNoNew && b.dataTs != null && st.lastDataTs != null && b.dataTs <= st.lastDataTs) {
        return { ok: false, ...record({ slot, kind, scope, state: 'skipped', code: 'no-new', reason: '직전 발송 뒤 새 수집이 없어 보내지 않았습니다(새 수집 없으면 생략).' }) };
      }
      if (!manual && b.newOnly && !b.newKeys.size) {
        await forgetRecovered(st, b, null);
        return { ok: false, ...record({ slot, kind, scope, state: 'skipped', code: 'unchanged', reason: '새로 임계를 넘은 게스트가 없어 보내지 않았습니다(새로 넘은 것만).' }) };
      }
      const r = await sendPortalMail({ kind: MAIL_KIND, subject: b.mail.subject, html: b.mail.html, text: b.mail.text, to: rcpt.to, attachments: b.attachments,
        ...fromOf(s), by: manual ? (by || 'admin') : 'system' });
      if (r.ok && !to) { st.lastSentAt = Date.now(); st.lastDataTs = b.dataTs; st.lastKeys = b.keys.slice(0, KEYS_MAX); }
      return { ok: !!r.ok, ...record({ slot, kind: to ? 'test' : kind, scope, state: r.ok ? 'sent' : (r.skipped ? 'skipped' : 'failed'), count: b.rows.length,
        recipients: Array.isArray(r.accepted) ? r.accepted.length : rcpt.to.length, reason: r.ok ? '' : (r.reason || '') }) };
    } catch (e) {
      return { ok: false, ...record({ slot, kind, scope, state: 'failed', reason: String(e?.message || e) }) };
    }
  });
}

/** ② vCenter 별 담당자 메일 발송(던지지 않는다). trigger: 'scan' | 'schedule' | 'manual'. */
export function sendVcenter(vcId, { slot = null, trigger = 'scan', by = 'system', now = Date.now() } = {}) {
  return serial(async () => {
    const manual = trigger === 'manual';
    const s = loadSettings();
    const scope = vcId;
    try {
      if (isEdge()) return { ok: false, state: 'edge' };
      if (settingsLoadError()) return { ok: false, ...record({ slot, kind: trigger, scope, state: 'skipped', code: 'unreadable', reason: '설정 파일을 읽지 못해 보내지 않았습니다.' }) };
      if (!manual && isMock()) return { ok: false, state: 'skipped', code: 'demo' };   // 데모 수집 커밋마다 기록을 남기면 기록이 데모로 덮인다 — 기록하지 않는다
      const vm = s.mail.vcenters[vcId];
      if (!vm && !manual) return { ok: false, state: 'none' };
      const rcpt = vcRecipientsOf(s, vcId);
      if (!rcpt.to.length) return { ok: false, ...record({ slot, kind: trigger, scope, state: 'skipped', code: 'no-recipients', reason: '받는 사람이 없습니다 — 담당자나 공통 받는 사람을 넣으세요.' }) };
      const st = vcState(vcId);
      const b = await buildMail(vcId, { s, now, streamState: st });
      if (trigger === 'schedule' && vm?.skipIfNoNew && b.dataTs != null && st.lastDataTs != null && b.dataTs <= st.lastDataTs) {
        return { ok: false, ...record({ slot, kind: trigger, scope, state: 'skipped', code: 'no-new', reason: '직전 발송 뒤 새 수집이 없어 보내지 않았습니다.' }) };
      }
      if (!manual && vm?.onlyOnChange && !b.newKeys.size) {
        await forgetRecovered(st, b, [vcId]);
        return { ok: false, ...record({ slot, kind: trigger, scope, state: 'skipped', code: 'unchanged', reason: '새로 임계를 넘은 게스트가 없어 보내지 않았습니다.' }) };
      }
      if (!manual && !b.rows.length) {
        st.lastDataTs = b.dataTs; st.lastKeys = []; save();
        return { ok: false, ...record({ slot, kind: trigger, scope, state: 'skipped', code: 'none-over', reason: '임계를 넘은 게스트가 없어 보내지 않았습니다.' }) };
      }
      const r = await sendPortalMail({ kind: MAIL_KIND, subject: b.mail.subject, html: b.mail.html, text: b.mail.text, to: rcpt.to, ...fromOf(s), by: manual ? (by || 'admin') : 'system' });
      if (r.ok) { st.lastSentAt = Date.now(); st.lastDataTs = b.dataTs; st.lastKeys = b.keys.slice(0, KEYS_MAX); }
      return { ok: !!r.ok, ...record({ slot, kind: trigger, scope, state: r.ok ? 'sent' : (r.skipped ? 'skipped' : 'failed'), count: b.rows.length,
        recipients: Array.isArray(r.accepted) ? r.accepted.length : rcpt.to.length, reason: r.ok ? '' : (r.reason || '') }) };
    } catch (e) {
      return { ok: false, ...record({ slot, kind: trigger, scope, state: 'failed', reason: String(e?.message || e) }) };
    }
  });
}

/** ③ 95% 이상 즉시 알림 — 그 vCenter 의 수집 직후. 같은 파티션(키)은 24시간에 한 번. */
export function sendCritFor(vcId, now = Date.now()) {
  return serial(async () => {
    const s = loadSettings();
    const d = s.mail.digest;
    if (!d.critNow || isEdge() || isMock() || settingsLoadError()) return { ok: false, state: 'off' };
    const rcpt = digestRecipientsOf(d);
    if (!rcpt.to.length) return { ok: false, state: 'no-recipients' };
    // v2.782(점검 K2 H-I1): 즉시 알림은 **언제나 파티션 단위**다 — 설정의 판정 단위('vm')를 따르면 C: 99/100 + D: 100/400 이 VM 합계 39.9% 로
    //   빠졌다(본문·설정 문구는 '파티션'). 키도 vmId\0경로로 일관된다(예전 'vm' 키는 24시간 정리로 사라진다).
    const r = await overview({ allowed: new Set([vcId]), thr: CRIT_PCT, mode: 'part', all: true, now });
    const st = state();
    for (const [k, t] of Object.entries(st.crit)) if (!(now - Number(t) < CRIT_REPEAT_MS)) delete st.crit[k];
    const rows = r.rows.filter((x) => x.pct >= CRIT_PCT && !(now - Number(st.crit[keyOf(x)] || 0) < CRIT_REPEAT_MS));
    if (!rows.length) { save(); return { ok: false, state: 'none' }; }
    const vc = r.vcenters.find((v) => v.id === vcId);
    const mail = renderOverMail({ kind: 'crit', critPct: CRIT_PCT, scopeLabel: vc?.name || vcId, thr: CRIT_PCT, mode: r.mode, collectedAt: dataTsOf(r), rows, total: rows.length, topN: 50,
      newKeys: new Set(), newOnly: false, kpi: { overVms: new Set(rows.map((x) => x.vmId)).size, crit: rows.length, notReported: r.kpi.notReported, newCount: 0 } });
    const res = await sendPortalMail({ kind: MAIL_KIND, subject: mail.subject, html: mail.html, text: mail.text, to: rcpt.to, ...fromOf(s), by: 'system' });
    if (res.ok) for (const x of rows) st.crit[keyOf(x)] = now;
    return { ok: !!res.ok, ...record({ kind: 'crit', scope: vcId, state: res.ok ? 'sent' : (res.skipped ? 'skipped' : 'failed'), count: rows.length, recipients: rcpt.to.length, reason: res.ok ? '' : (res.reason || '') }) };
  });
}

/** ④ 수집 실패·지연 알림 — 같은 vCenter 6시간에 한 번(failAlertDue — 아이실론과 같은 간격). */
export function sendFailFor(vcId, { error = '', staleSince = null, now = Date.now() } = {}) {
  return serial(async () => {
    const s = loadSettings();
    const vm = s.mail.vcenters[vcId];
    if (!vm?.onFailure || isEdge() || isMock() || settingsLoadError()) return { ok: false, state: 'off' };
    const st = vcState(vcId);
    if (!failAlertDue(st.lastFailAlertAt, now)) return { ok: false, state: 'too-soon' };
    const rcpt = vcRecipientsOf(s, vcId);
    if (!rcpt.to.length) return { ok: false, state: 'no-recipients' };
    const name = (store.get()?.vcenters || []).find((v) => v.id === vcId)?.name || vcId;
    const mail = renderFailMail({ vcenterName: name, error, staleSince, now });
    st.lastFailAlertAt = now; save();   // 보내기 전에 남긴다(실패해도 6시간 안에 다시 두드리지 않는다 — 릴레이 보호)
    const r = await sendPortalMail({ kind: MAIL_KIND, subject: mail.subject, html: mail.html, text: mail.text, to: rcpt.to, ...fromOf(s), by: 'system' });
    return { ok: !!r.ok, ...record({ kind: error ? 'fail' : 'stale', scope: vcId, state: r.ok ? 'sent' : (r.skipped ? 'skipped' : 'failed'), recipients: rcpt.to.length, reason: r.ok ? '' : (r.reason || '') }) };
  });
}

/** 수집 커밋 직후(중앙 직접·엣지 수신 공통). */
export async function onCommitted({ vcenterId } = {}) {
  if (isEdge() || !vcenterId) return;
  const s = loadSettings();
  if (s.mail.vcenters[vcenterId]?.when === 'scan') await sendVcenter(vcenterId, { trigger: 'scan' });
  if (s.mail.digest.critNow) await sendCritFor(vcenterId);
}

/** 직접 수집 1회 끝 — 실패한 vCenter 에 실패 알림. */
export async function onRunDone(result) {
  if (isEdge()) return;
  for (const e of Array.isArray(result?.errors) ? result.errors : []) {
    if (e?.vcenterId) await sendFailFor(String(e.vcenterId), { error: String(e.error || '알 수 없음') });
  }
}

let _busy = false;
let _timer = null;
let _lastTick = null;
let _lastError = null;

/** 틱 — 통합 메일·vCenter 정기 메일의 회차, 값 지연 알림. 던지지 않는다. */
export async function tick(now = Date.now()) {
  if (isEdge()) return { action: 'edge' };
  if (_busy) return { action: 'busy' };
  _busy = true;
  const done = [];
  try {
    const s = loadSettings();
    const plans = [['digest', { enabled: s.mail.digest.enabled, days: s.mail.digest.days, time: s.mail.digest.time, since: s.mail.digest.since }, state().digest]];
    for (const [id, m] of Object.entries(s.mail.vcenters)) {
      if (m.when === 'schedule') plans.push([id, { enabled: true, days: m.days, time: m.time, since: m.since }, vcState(id)]);
    }
    for (const [target, sched, st] of plans) {
      const plan = planDigestTick({ digest: sched, state: st, now, bootAt: BOOT_AT });
      if (plan.action === 'rebase') { st.lastSlot = plan.lastSlot; save(); continue; }
      if (plan.action === 'missed') {
        st.lastSlot = plan.slot;
        record({ slot: plan.slot, kind: 'schedule', scope: target === 'digest' ? '전체 법인' : target, state: 'missed', code: plan.reason, count: plan.count,
          reason: plan.reason === 'down' ? '포탈이 꺼져 있던 동안의 회차라 보내지 않았습니다(몰아서 보내지 않습니다).' : '정한 시각보다 30분 넘게 늦게 확인해 보내지 않았습니다(몰아서 보내지 않습니다).' });
        continue;
      }
      if (plan.action === 'send') {
        st.lastSlot = plan.slot; save();   // 보내기 전에 남긴다 — 보내는 중 재시작해도 같은 회차를 두 번 보내지 않는다
        done.push(target);
        if (target === 'digest') await sendDigest({ slot: plan.slot, now }); else await sendVcenter(target, { slot: plan.slot, trigger: 'schedule', now });
      }
    }
    // 값 지연(엣지 위임 vCenter 도 덮는다) — 실패 알림을 켠 vCenter 만.
    const want = Object.entries(s.mail.vcenters).filter(([, m]) => m.onFailure).map(([id]) => id);
    if (want.length && !isMock()) {
      const cov = await coverageByVcenter(want);
      const hold = latestHoldMs();
      for (const id of want) {
        const c = cov.get(id);
        if (c?.lastTs && now - c.lastTs > hold) await sendFailFor(id, { staleSince: c.lastTs, now });
      }
    }
    _lastTick = { at: now, sent: done };
    return { action: 'ok', sent: done };
  } catch (e) {
    _lastError = { at: Date.now(), message: String(e?.message || e).slice(0, 300) };
    console.warn(`[guestpart] 메일 틱 실패: ${e?.message || e}`);
    return { action: 'error', error: _lastError.message };
  } finally { _busy = false; }
}

/** 미리보기(보내지 않음) — 통합 메일 또는 vCenter 메일. 주소는 싣지 않고 개수만. */
export async function previewMail(target = 'digest', now = Date.now()) {
  const s = loadSettings();
  const isDigest = target === 'digest';
  const st = isDigest ? state().digest : vcState(target);
  const b = await buildMail(target, { s, now, streamState: st });
  const rcpt = isDigest ? digestRecipientsOf(s.mail.digest) : vcRecipientsOf(s, target);
  return { ok: true, subject: b.mail.subject, html: b.mail.html, recipients: rcpt.to.length, rows: b.rows.length, newCount: b.newKeys.size, attachment: b.attachments[0]?.filename || null, demo: isMock() };
}

/** 테스트 발송 — 지정한 주소(최대 5명)로 통합 메일 내용을 '[테스트]' 로 보낸다. 상태(새로 넘음 기준)는 바꾸지 않는다. */
export function sendTest(toInput, by = 'admin') {
  const n = normalizeMailList(toInput);
  if (n.invalid.length || !n.list.length) return Promise.resolve({ ok: false, error: '받을 주소를 올바르게 넣으세요.' });
  if (n.list.length > 5) return Promise.resolve({ ok: false, error: '테스트 발송은 5명까지입니다.' });
  return sendDigest({ manual: true, by, to: n.list.filter(isEmail) });
}

/** 화면용 상태(주소 없음 — 개수만). */
export function mailStatus(now = Date.now()) {
  const s = loadSettings();
  const st = state();
  const d = digestOf(s.mail.digest);
  const rc = digestRecipientsOf(d);
  const vc = {};
  for (const [id, m] of Object.entries(s.mail.vcenters)) {
    const r = vcRecipientsOf(s, id);
    const x = st.vc[id] || emptyStream();
    vc[id] = { recipients: r.to.length, next: m.when === 'schedule' ? nextDigestSlots({ enabled: true, days: m.days, time: m.time, since: m.since }, now, 1)[0] ?? null : null, lastSentAt: x.lastSentAt };
  }
  return {
    edge: isEdge(), demo: isMock(), digest: { enabled: d.enabled, next: nextDigestSlots({ enabled: d.enabled, days: d.days, time: d.time, since: d.since }, now, 3), lastSentAt: st.digest.lastSentAt,
      recipients: { total: rc.to.length, fromAdmin: rc.fromAdmin, fromExtra: rc.fromExtra } },
    vcenters: vc, history: st.history.map((h) => ({ ...h })), lastTick: _lastTick, lastError: _lastError,
  };
}

/** 기동(중앙 전용) — 커밋·수집 완료를 듣고 30초 틱을 돈다. */
export function startGuestPartMail() {
  if (_timer || isEdge()) return;
  onGuestDiskCommitted((info) => onCommitted(info));
  onGuestDiskRunDone((res) => onRunDone(res));
  _timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  _timer.unref?.();
}

export function _resetForTest() { _state = null; _busy = false; }
