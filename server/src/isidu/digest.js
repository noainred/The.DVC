/**
 * isidu/digest.js — 아이실론 디렉터리 사용량 **종합 메일** 발송·일정·기록(v2.742). 규칙은 `digestRules.js`(순수), 본문은 `mailHtml.js`.
 *
 * ── 지키는 것 ────────────────────────────────────────────────────────────────
 *  · **중앙만 보낸다**(엣지는 설정을 받지 않고 틱도 돌지 않는다 — 메일 주소를 28곳에 퍼뜨리지 않는다).
 *  · 장비에 접속하지 않는다 — 그때까지 모인 마지막 성공 조사(DB)로 만든다. 조사를 새로 돌리지 않는다.
 *  · 회차는 한 번만 — 처리한 회차(lastSlot)를 **보내기 전에** 상태 파일에 남긴다(보내는 중 재시작해도 두 번 보내지 않는다 —
 *    대신 그 회차는 보내지 못했을 수 있고, 그 사실은 기록이 '보내는 중' 에서 멈춘 것으로 남는다).
 *  · 놓친 회차는 몰아서 보내지 않는다(놓침으로 기록). 데모(mock-) 대상은 실제 메일에 넣지 않는다.
 *  · 기록(보냄·생략·실패·놓침)은 주소 없이 개수만 남긴다. 사람이 누른 '지금 보내기' 는 '새 조사 없으면 생략' 을 보지 않는다.
 *  · 메일 서버·'아이실론 디렉터리 사용량' 종류의 켜기/끄기·SMTP 인증 정지는 공용 메일 서비스가 판정한다(그 결과를 그대로 기록한다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';
import { sendPortalMail } from '../mail/service.js';
import { load as loadMailCfg } from '../mail/settings.js';
import { loadSettings, isiduSettingsLoadError } from './settings.js';
import { targetRows } from './rows.js';
import { buildOverview } from './report.js';
import { MAIL_KIND } from './notify.js';
import {
  digestOf, normalizeDigest, planDigestTick, nextDigestSlots, digestRecipients, buildDigestModel, scanMarkOf, slotLabel, DIGEST_HISTORY_MAX,
} from './digestRules.js';
import { renderDigestMail } from './mailHtml.js';

registerStateFile('isidu-digest-state.json');
const FILE = () => path.join(config.configDir, 'isidu-digest-state.json');   // ⚠ 리터럴 형태 유지 — scripts/config-doc.mjs 가 이 모양으로 찾는다
const BOOT_AT = Date.now();
export const DIGEST_TICK_MS = 30_000;

const isEdge = () => !!(config.agent.centralUrl && config.agent.centralToken);

const MISSED_TEXT = {
  down: '포탈이 꺼져 있던 동안의 회차라 보내지 않았습니다(몰아서 보내지 않습니다).',
  late: '정한 시각보다 30분 넘게 늦게 확인해 보내지 않았습니다(몰아서 보내지 않습니다).',
  clock: '서버 시계가 뒤로 가 처리 기록을 지금으로 다시 잡았습니다.',
};

let _state = null; // { lastSlot, lastSentAt, lastScanMark, history: [] }
function state() {
  if (_state) return _state;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('형식 오류');
    const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
    _state = {
      lastSlot: num(raw.lastSlot), lastSentAt: num(raw.lastSentAt), lastScanMark: num(raw.lastScanMark),
      history: (Array.isArray(raw.history) ? raw.history : []).filter((h) => h && typeof h === 'object').slice(0, DIGEST_HISTORY_MAX),
    };
  } catch (e) {
    if (e?.code !== 'ENOENT') { preserveCorrupt(FILE(), e?.message); console.warn(`[isidu-digest] 상태 파일을 읽지 못해 새로 시작합니다: ${e?.message}`); }
    _state = { lastSlot: null, lastSentAt: null, lastScanMark: null, history: [] };
  }
  return _state;
}
function save() {
  try { atomicWriteFileSync(FILE(), JSON.stringify(state()), { mode: 0o600 }); }
  catch (e) { console.warn(`[isidu-digest] 상태 파일을 저장하지 못했습니다(메모리로 계속 — 재시작하면 같은 회차를 한 번 더 볼 수 있습니다): ${e.message}`); }
}
/** 기록 한 줄(주소 없음 — 개수만). 최신이 앞이다. */
function record(entry) {
  const st = state();
  const e = { at: Date.now(), ...entry };
  if (e.reason) e.reason = String(e.reason).slice(0, 300);
  st.history.unshift(e);
  st.history.length = Math.min(st.history.length, DIGEST_HISTORY_MAX);
  save();
  return e;
}

// 보내기는 한 줄로 — 틱과 '지금 보내기' 가 겹쳐도 같은 메일을 동시에 두 번 만들지 않는다.
let _chain = Promise.resolve();
const serial = (fn) => { const p = _chain.then(fn, fn); _chain = p.catch(() => {}); return p; };
let _busy = false;
let _timer = null;
let _lastTick = null;
let _lastError = null;

/** 본문 모델을 만든다(장비 접속 없음). */
async function buildModel(digest, { excludeDemo, now }) {
  const t0 = Date.now();
  const rows = await targetRows();
  const ids = rows.filter((r) => !excludeDemo || !String(r.id).startsWith('mock-')).map((r) => r.id);
  const ov = await buildOverview(ids);
  const ovById = new Map((Array.isArray(ov) ? ov : []).filter((x) => x && x.id).map((x) => [x.id, x]));
  const model = buildDigestModel(rows, ovById, { now, topN: digest.topN, excludeDemo });
  return { model, buildMs: Date.now() - t0 };
}

const recipientsOf = (d) => {
  let admin = [];
  try { admin = loadMailCfg().defaultTo || []; } catch { admin = []; }
  return digestRecipients(d, admin);
};

/**
 * 종합 메일 한 통을 만들고 보낸다(던지지 않는다).
 * @param {{slot:number, manual?:boolean, by?:string, now?:number}} a
 */
export function sendDigest({ slot, manual = false, by = 'system', now = Date.now() } = {}) {
  return serial(async () => {
    const kind = manual ? 'manual' : 'schedule';
    try {
      if (isEdge()) return { ok: false, state: 'edge', reason: '엣지는 종합 메일을 보내지 않습니다(메인만 보냅니다).' };
      if (isiduSettingsLoadError()) return { ok: false, state: 'skipped', ...record({ slot, kind, state: 'skipped', code: 'unreadable', reason: '설정 파일을 읽지 못해 보내지 않았습니다.' }) };
      const d = digestOf(loadSettings().mail?.digest);
      const rcpt = recipientsOf(d);
      if (!rcpt.to.length) return { ok: false, state: 'skipped', ...record({ slot, kind, state: 'skipped', code: 'no-recipients', reason: "받는 사람이 없습니다 — '통합 관리자'(설정 › 메일 발송의 기본 받는 사람)를 고르거나 추가 주소를 넣으세요." }) };
      const { model, buildMs } = await buildModel(d, { excludeDemo: true, now });
      if (!model.totals.targets) {
        const demo = model.demoExcluded > 0;
        return { ok: false, state: 'skipped', ...record({ slot, kind, state: 'skipped', code: demo ? 'demo-only' : 'no-targets', reason: demo ? `데모 대상(${model.demoExcluded}개)만 있어 보내지 않았습니다 — 데모 데이터는 실제 메일에 넣지 않습니다.` : '수집 대상이 없어 보내지 않았습니다.' }) };
      }
      const mark = scanMarkOf(model);
      const st = state();
      if (!manual && d.skipIfNoNew && mark != null && st.lastScanMark != null && mark <= st.lastScanMark) {
        return { ok: false, state: 'skipped', ...record({ slot, kind, state: 'skipped', code: 'no-new', reason: '직전 발송 뒤 새로 끝난 성공 조사가 없어 보내지 않았습니다(새 조사 없으면 생략).' }) };
      }
      const mail = renderDigestMail(model, { digest: d, slot, manual, recipients: rcpt.to.length, generatedMs: buildMs, now, includeWatch: d.includeWatch, includeTargets: d.includeTargets });
      const r = await sendPortalMail({ kind: MAIL_KIND, subject: mail.subject, html: mail.html, text: mail.text, to: rcpt.to, by: manual ? (by || 'admin') : 'system' });
      if (r.ok) {
        st.lastSentAt = Date.now();
        if (mark != null) st.lastScanMark = mark;
        const acc = Array.isArray(r.accepted) ? r.accepted.length : rcpt.to.length;
        return { ok: true, state: 'sent', ...record({ slot, kind, state: 'sent', to: rcpt.to.length, accepted: acc, targets: model.totals.targets, corps: model.totals.corps, buildMs }) };
      }
      const code = r.skipped ? (r.authStopped ? 'auth-stopped' : 'mail-off') : null;
      return { ok: false, state: r.skipped ? 'skipped' : 'failed', ...record({ slot, kind, state: r.skipped ? 'skipped' : 'failed', code, reason: r.reason || '보내지 못했습니다', to: rcpt.to.length }) };
    } catch (e) {
      _lastError = { at: Date.now(), message: String(e?.message || e).slice(0, 300) };
      console.warn(`[isidu-digest] 종합 메일을 만들지 못했습니다: ${e?.message || e}`);
      return { ok: false, state: 'failed', ...record({ slot, kind, state: 'failed', reason: `만들지 못했습니다: ${String(e?.message || e).slice(0, 200)}` }) };
    }
  });
}

/** 지금 보내기(사람이 누름) — 회차 기록(lastSlot)은 건드리지 않는다. */
export function sendDigestNow(by = 'admin', now = Date.now()) {
  return sendDigest({ slot: now, manual: true, by, now });
}

/**
 * 틱 — 이번에 보낼 회차가 있으면 보내고, 놓친 회차는 기록만 한다(던지지 않는다).
 * @returns {Promise<object>} 계획(action)과 결과
 */
export async function digestTick(now = Date.now()) {
  if (isEdge()) return { action: 'edge' };
  if (_busy) return { action: 'busy' };
  _busy = true;
  try {
    const d = digestOf(loadSettings().mail?.digest);
    const st = state();
    const plan = planDigestTick({ digest: d, state: st, now, bootAt: BOOT_AT });
    _lastTick = { at: now, action: plan.action };
    if (plan.action === 'rebase') {
      st.lastSlot = plan.lastSlot; save();
      console.warn(`[isidu-digest] ${MISSED_TEXT.clock}`);
      return plan;
    }
    if (plan.action === 'missed') {
      st.lastSlot = plan.slot;
      record({ slot: plan.slot, kind: 'schedule', state: 'missed', code: plan.reason, count: plan.count, reason: `${MISSED_TEXT[plan.reason] || '보내지 않았습니다.'}${plan.count > 1 ? ` (놓친 회차 ${plan.count}번 — 마지막 ${slotLabel(plan.slot)})` : ''}` });
      console.warn(`[isidu-digest] 종합 메일 회차를 놓쳤습니다(${slotLabel(plan.slot)} · ${plan.reason}${plan.count > 1 ? ` · ${plan.count}번` : ''}) — 몰아서 보내지 않습니다.`);
      return plan;
    }
    if (plan.action === 'send') {
      st.lastSlot = plan.slot; save();   // 보내기 전에 남긴다 — 보내는 중 재시작해도 같은 회차를 두 번 보내지 않는다
      const result = await sendDigest({ slot: plan.slot, now });
      if (!result.ok && result.state === 'failed') console.warn(`[isidu-digest] 종합 메일을 보내지 못했습니다(${slotLabel(plan.slot)}): ${result.reason || ''}`);
      return { ...plan, result };
    }
    return plan;
  } catch (e) {
    _lastError = { at: Date.now(), message: String(e?.message || e).slice(0, 300) };
    console.warn(`[isidu-digest] 틱 실패: ${e?.message || e}`);
    return { action: 'error', error: _lastError.message };
  } finally { _busy = false; }
}

/**
 * 미리보기 — 보내지 않고 본문만 만든다. 입력(저장하지 않은 화면 값)이 있으면 그 값으로 만든다. 데모 대상도 넣고 그 사실을 밝힌다.
 * @returns {Promise<{ok:true, subject:string, html:string, text:string, recipients:number, targets:number, demoIncluded:number}|{ok:false, error:string, field?:string}>}
 */
export async function previewDigest(input = null, now = Date.now()) {
  const base = digestOf(loadSettings().mail?.digest);
  let d = base;
  if (input && typeof input === 'object') {
    const r = normalizeDigest(input, base, now);
    if (r.error) return { ok: false, error: r.error, field: r.field };
    d = r.digest;
  }
  const rcpt = recipientsOf(d);
  const { model, buildMs } = await buildModel(d, { excludeDemo: false, now });
  const mail = renderDigestMail(model, { digest: d, slot: now, preview: true, recipients: rcpt.to.length, generatedMs: buildMs, now, includeWatch: d.includeWatch, includeTargets: d.includeTargets });
  return { ok: true, ...mail, recipients: rcpt.to.length, targets: model.totals.targets, demoIncluded: model.demoIncluded };
}

/** 화면용 상태(주소 없음). */
export function isiduDigestStatus(now = Date.now()) {
  const d = digestOf(loadSettings().mail?.digest);
  const st = state();
  const rc = recipientsOf(d);
  return {
    enabled: d.enabled, next: nextDigestSlots(d, now, 3), lastSlot: st.lastSlot, lastSentAt: st.lastSentAt,
    history: st.history.map((h) => ({ ...h })), busy: _busy, lastTick: _lastTick, lastError: _lastError, edge: isEdge(),
    recipients: { total: rc.to.length, fromAdmin: rc.fromAdmin, fromExtra: rc.fromExtra, dupes: rc.dupes },
  };
}

export function startIsiduDigest() {
  if (_timer || isEdge()) return;
  _timer = setInterval(() => { digestTick().catch(() => {}); }, DIGEST_TICK_MS);
  _timer.unref?.();
}

export function _resetForTest() { _state = null; _chain = Promise.resolve(); _busy = false; _lastTick = null; _lastError = null; if (_timer) { clearInterval(_timer); _timer = null; } }
export const _bootAtForTest = () => BOOT_AT;
