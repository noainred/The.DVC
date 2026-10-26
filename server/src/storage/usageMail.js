/**
 * storage/usageMail.js — 스토리지 사용량 **예약 메일** 설정·발송·일정·기록(v2.789). 규칙·본문은 `usageMailRules.js`(순수).
 *
 * 사용자 요청(2026-10-26): "사용자가 지정한 시간에 전체 사용량을 사용자에게 이메일로 발송하는 기능 추가".
 *
 * ── 지키는 것(아이실론 종합 메일 `isidu/digest.js` 와 같은 틀) ─────────────────────────────
 *  · **중앙만 보낸다** — 엣지는 틱을 돌지 않는다(메일 주소를 엣지에 퍼뜨리지 않는다). 장비에 접속하지 않고 일 롤업으로 만든다.
 *  · 회차는 한 번만 — 처리한 회차(lastSlot)를 **보내기 전에** 상태 파일에 남긴다(보내는 중 재시작해도 두 번 보내지 않는다 —
 *    대신 그 회차는 못 보냈을 수 있다. 정직 기록). 놓친 회차는 몰아서 보내지 않는다(놓침으로 기록).
 *  · 기록은 주소 없이 개수만 남긴다. 사람이 누른 '지금 보내기' 는 회차 기록을 건드리지 않고, 공용 메일 서비스가 수동 발송으로 다룬다
 *    (SMTP 인증 정지 중에도 시도 — 고쳤는지 확인하는 경로).
 *  · 설정 파일(`storage-usage-mail.json`)을 못 읽으면 저장을 거절하고(409) 정기 발송도 하지 않는다 — 손상본 위에 기본값을 덮어
 *    받는 사람 목록이 조용히 사라지지 않게(손상본은 `.corrupt.<시각>` 로 보존).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';
import { sendPortalMail } from '../mail/service.js';
import { load as loadMailCfg } from '../mail/settings.js';
import { planDigestTick, nextDigestSlots, digestRecipients, slotLabel } from '../isidu/digestRules.js';
import { loadUsageReport } from './usageData.js';
import { mailOf, normalizeMail, buildMailModel, renderUsageMail, MAIL_KIND, MAIL_HISTORY_MAX } from './usageMailRules.js';
import { renderUsageWorkbook, xlsxFileName, XLSX_MIME } from './usageXlsx.js';
import { ATTACH_MAX_BYTES } from '../util/smtp.js';
import { localStamp } from '../util/dayKey.js';

registerStateFile('storage-usage-mail-state.json');
const FILE = () => path.join(config.configDir, 'storage-usage-mail.json');                  // ⚠ 리터럴 형태 유지 — scripts/config-doc.mjs 가 이 모양으로 찾는다
const STATE_FILE = () => path.join(config.configDir, 'storage-usage-mail-state.json');       // ⚠ 리터럴 형태 유지
const BOOT_AT = Date.now();
export const USAGE_MAIL_TICK_MS = 30_000;

const isEdge = () => !!(config.agent.centralUrl && config.agent.centralToken);

const MISSED_TEXT = {
  down: '포탈이 꺼져 있던 동안의 회차라 보내지 않았습니다(몰아서 보내지 않습니다).',
  late: '정한 시각보다 30분 넘게 늦게 확인해 보내지 않았습니다(몰아서 보내지 않습니다).',
  clock: '서버 시계가 뒤로 가 처리 기록을 지금으로 다시 잡았습니다.',
};

/* ── 설정 ───────────────────────────────────────────────────────────── */
let _cfg = null;
let _loadErr = null;
export function loadUsageMailSettings() {
  if (_cfg) return _cfg;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('형식 오류');
    _cfg = mailOf(raw); _loadErr = null;
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      preserveCorrupt(FILE(), e?.message);
      _loadErr = { at: Date.now(), reason: safeLoadText(e) || '사유 미상' };
      console.warn(`[storage-usage-mail] 설정 파일을 읽지 못했습니다(손상본 보존 — 저장·정기 발송 중지): ${_loadErr.reason}`);
    }
    _cfg = mailOf(null);
  }
  return _cfg;
}
export const usageMailLoadError = () => { loadUsageMailSettings(); return _loadErr; };

/** 저장(관리자). @returns {{ok:true, mail:object}|{ok:false, status:number, error:string, field?:string}} */
export function saveUsageMailSettings(input, now = Date.now()) {
  loadUsageMailSettings();
  if (_loadErr) return { ok: false, status: 409, error: '설정 파일을 읽지 못해 저장하지 않았습니다 — 손상본(storage-usage-mail.json.corrupt.*)을 확인하세요.' };
  const r = normalizeMail(input, _cfg, now);
  if (r.error) return { ok: false, status: 400, error: r.error, field: r.field };
  atomicWriteFileSync(FILE(), JSON.stringify(r.mail, null, 2), { mode: 0o600 });
  _cfg = r.mail;
  return { ok: true, mail: r.mail };
}

/* ── 상태(회차·기록) ─────────────────────────────────────────────────── */
let _state = null;
function state() {
  if (_state) return _state;
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('형식 오류');
    const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
    _state = { lastSlot: num(raw.lastSlot), lastSentAt: num(raw.lastSentAt),
      history: (Array.isArray(raw.history) ? raw.history : []).filter((h) => h && typeof h === 'object').slice(0, MAIL_HISTORY_MAX) };
  } catch (e) {
    if (e?.code !== 'ENOENT') { preserveCorrupt(STATE_FILE(), e?.message); console.warn(`[storage-usage-mail] 상태 파일을 읽지 못해 새로 시작합니다: ${safeLoadText(e) || '사유 미상'}`); }
    _state = { lastSlot: null, lastSentAt: null, history: [] };
  }
  return _state;
}
function saveState() {
  try { atomicWriteFileSync(STATE_FILE(), JSON.stringify(state()), { mode: 0o600 }); }
  catch (e) { console.warn(`[storage-usage-mail] 상태 파일을 저장하지 못했습니다(메모리로 계속 — 재시작하면 같은 회차를 한 번 더 볼 수 있습니다): ${e.message}`); }
}
function record(entry) {
  const st = state();
  const e = { at: Date.now(), ...entry };
  if (e.reason) e.reason = String(e.reason).slice(0, 300);
  st.history.unshift(e);
  st.history.length = Math.min(st.history.length, MAIL_HISTORY_MAX);
  saveState();
  return e;
}

let _chain = Promise.resolve();
const serial = (fn) => { const p = _chain.then(fn, fn); _chain = p.catch(() => {}); return p; };
let _busy = false;
let _timer = null;
let _lastTick = null;
let _lastError = null;

const recipientsOf = (m) => {
  let admin = [];
  try { admin = loadMailCfg().defaultTo || []; } catch { admin = []; }
  return digestRecipients(m, admin);
};

/** 메일 첨부의 '데이터 (행 단위)' 시트를 줄일 때의 주 수 — 첨부 상한(공용 SMTP ATTACH_MAX_BYTES)을 넘을 때만. */
export const ATTACH_DATA_WEEKS = 52;

/**
 * 첨부 엑셀(v2.791) — 누적 전 주차. 상한을 넘으면 데이터 시트만 최근 ATTACH_DATA_WEEKS 주로 줄여 다시 만들고, 그래도 넘거나 실패하면
 * 첨부 없이 보낸다(본문이 사유를 밝힌다 — 조용히 빼지 않는다). 엑셀은 워커 스레드에서 만든다(usageXlsx.renderUsageWorkbook).
 * @returns {Promise<{state:'attached'|'trimmed'|'failed', filename:string, attachment?:object, reason?:string, bytes?:number}>}
 */
export async function buildAttachment(rep, m, { now = Date.now(), limit = ATTACH_MAX_BYTES } = {}) {
  const stamp = localStamp(now);
  try {
    let r = await renderUsageWorkbook(rep, { includeResources: m.includeResources, stamp });
    let state = 'attached';
    if (r.buffer.length > limit) {
      r = await renderUsageWorkbook(rep, { includeResources: m.includeResources, stamp, dataWeeks: ATTACH_DATA_WEEKS });
      state = 'trimmed';
    }
    const filename = r.meta?.filename || 'storage-usage-weekly.xlsx';
    if (r.buffer.length > limit) {
      return { state: 'failed', filename, bytes: r.buffer.length,
        reason: `엑셀이 첨부 상한(${Math.round(limit / 1048576)}MB)보다 큽니다(데이터 시트를 줄여도 ${(r.buffer.length / 1048576).toFixed(1)}MB)` };
    }
    return { state, filename, bytes: r.buffer.length, attachment: { filename, contentType: XLSX_MIME, content: r.buffer },
      ...(state === 'trimmed' ? { reason: r.meta?.trimmedNote || `첨부 크기 상한 때문에 데이터 시트는 최근 ${ATTACH_DATA_WEEKS}주만 담았습니다.` } : {}) };
  } catch (e) {
    console.warn(`[storage-usage-mail] 엑셀을 만들지 못했습니다: ${e?.message || e}`);
    return { state: 'failed', filename: '', reason: `엑셀을 만들지 못했습니다(${String(e?.message || e).slice(0, 160)})` };
  }
}

async function buildMail(m, { slot, manual = false, preview = false, recipients = 0, now = Date.now() }) {
  // 메일은 관리자가 아닌 사람도 받을 수 있다 — 화면의 비관리자 판본과 같이 관리 주소를 가린다(admin:false).
  // v2.791: 본문·첨부는 항상 주간(ISO 주차) 전체 누적이다(예전 gran·count 설정은 읽지 않는다 — usageMailRules 머리말).
  const rep = await loadUsageReport({ gran: 'weekly', count: 'all', admin: false, now });
  if (!rep.ok) return { ok: false, code: 'unreadable', reason: '스토리지 등록부를 읽지 못해 보내지 않았습니다.' };
  if (!rep.db) return { ok: false, code: 'db-off', reason: '용량 이력 DB 를 쓸 수 없어 보내지 않았습니다.' };
  const model = buildMailModel(rep, { includeResources: m.includeResources });
  if (!model.devices) return { ok: false, code: 'no-devices', reason: '이력이 있는 스토리지 장비가 없어 보내지 않았습니다.' };
  let attach = { state: 'off' };
  if (m.attachExcel) attach = preview ? { state: 'preview', filename: xlsxFileName(model) } : await buildAttachment(rep, m, { now });
  return { ok: true, model, attach, mail: renderUsageMail(model, { mail: m, slot, manual, preview, recipients, attach }) };
}

/** 한 통을 만들고 보낸다(던지지 않는다). */
export function sendUsageMail({ slot, manual = false, by = 'system', now = Date.now() } = {}) {
  return serial(async () => {
    const kind = manual ? 'manual' : 'schedule';
    try {
      if (isEdge()) return { ok: false, state: 'edge', reason: '엣지는 이 메일을 보내지 않습니다(메인만 보냅니다).' };
      if (usageMailLoadError()) return { ok: false, state: 'skipped', ...record({ slot, kind, state: 'skipped', code: 'unreadable', reason: '메일 설정 파일을 읽지 못해 보내지 않았습니다.' }) };
      const m = loadUsageMailSettings();
      const rcpt = recipientsOf(m);
      if (!rcpt.to.length) return { ok: false, state: 'skipped', ...record({ slot, kind, state: 'skipped', code: 'no-recipients', reason: "받는 사람이 없습니다 — '통합 관리자'(설정 › 메일 발송의 기본 받는 사람)를 고르거나 추가 주소를 넣으세요." }) };
      const b = await buildMail(m, { slot, manual, recipients: rcpt.to.length, now });
      if (!b.ok) return { ok: false, state: 'skipped', ...record({ slot, kind, state: 'skipped', code: b.code, reason: b.reason }) };
      const attachments = b.attach?.attachment ? [b.attach.attachment] : [];
      const r = await sendPortalMail({ kind: MAIL_KIND, subject: b.mail.subject, html: b.mail.html, text: b.mail.text, to: rcpt.to, by: manual ? (by || 'admin') : 'system', attachments });
      if (r.ok) {
        state().lastSentAt = Date.now();
        const acc = Array.isArray(r.accepted) ? r.accepted.length : rcpt.to.length;
        return { ok: true, state: 'sent', ...record({ slot, kind, state: 'sent', to: rcpt.to.length, accepted: acc, devices: b.model.devices,
          attach: b.attach?.state || 'off', ...(b.attach?.bytes ? { attachBytes: b.attach.bytes } : {}),
          ...(b.attach?.state === 'failed' || b.attach?.state === 'trimmed' ? { reason: b.attach.reason } : {}) }) };
      }
      const code = r.skipped ? (r.authStopped ? 'auth-stopped' : 'mail-off') : null;
      return { ok: false, state: r.skipped ? 'skipped' : 'failed', ...record({ slot, kind, state: r.skipped ? 'skipped' : 'failed', code, reason: r.reason || '보내지 못했습니다', to: rcpt.to.length }) };
    } catch (e) {
      _lastError = { at: Date.now(), message: String(e?.message || e).slice(0, 300) };
      console.warn(`[storage-usage-mail] 메일을 만들지 못했습니다: ${e?.message || e}`);
      return { ok: false, state: 'failed', ...record({ slot, kind, state: 'failed', reason: `만들지 못했습니다: ${String(e?.message || e).slice(0, 200)}` }) };
    }
  });
}

/** 지금 보내기(사람이 누름) — 회차 기록(lastSlot)은 건드리지 않는다. */
export function sendUsageMailNow(by = 'admin', now = Date.now()) {
  return sendUsageMail({ slot: now, manual: true, by, now });
}

/** 틱 — 보낼 회차가 있으면 보내고, 놓친 회차는 기록만 한다(던지지 않는다). */
export async function usageMailTick(now = Date.now()) {
  if (isEdge()) return { action: 'edge' };
  if (_busy) return { action: 'busy' };
  _busy = true;
  try {
    if (usageMailLoadError()) return { action: 'unreadable' };
    const m = loadUsageMailSettings();
    const st = state();
    const plan = planDigestTick({ digest: m, state: st, now, bootAt: BOOT_AT });
    _lastTick = { at: now, action: plan.action };
    if (plan.action === 'rebase') { st.lastSlot = plan.lastSlot; saveState(); console.warn(`[storage-usage-mail] ${MISSED_TEXT.clock}`); return plan; }
    if (plan.action === 'missed') {
      st.lastSlot = plan.slot;
      record({ slot: plan.slot, kind: 'schedule', state: 'missed', code: plan.reason, count: plan.count,
        reason: `${MISSED_TEXT[plan.reason] || '보내지 않았습니다.'}${plan.count > 1 ? ` (놓친 회차 ${plan.count}번 — 마지막 ${slotLabel(plan.slot)})` : ''}` });
      return plan;
    }
    if (plan.action === 'send') {
      st.lastSlot = plan.slot; saveState();   // 보내기 전에 남긴다 — 보내는 중 재시작해도 같은 회차를 두 번 보내지 않는다
      const result = await sendUsageMail({ slot: plan.slot, now });
      if (!result.ok && result.state === 'failed') console.warn(`[storage-usage-mail] 메일을 보내지 못했습니다(${slotLabel(plan.slot)}): ${result.reason || ''}`);
      return { ...plan, result };
    }
    return plan;
  } catch (e) {
    _lastError = { at: Date.now(), message: String(e?.message || e).slice(0, 300) };
    console.warn(`[storage-usage-mail] 틱 실패: ${e?.message || e}`);
    return { action: 'error', error: _lastError.message };
  } finally { _busy = false; }
}

/** 미리보기 — 보내지 않는다. 저장하지 않은 화면 값이 있으면 그 값으로 만든다. */
export async function previewUsageMail(input = null, now = Date.now()) {
  const base = loadUsageMailSettings();
  let m = base;
  if (input && typeof input === 'object') {
    const r = normalizeMail(input, base, now);
    if (r.error) return { ok: false, error: r.error, field: r.field };
    m = r.mail;
  }
  const rcpt = recipientsOf(m);
  const b = await buildMail(m, { slot: now, preview: true, recipients: rcpt.to.length, now });
  if (!b.ok) return { ok: false, error: b.reason, code: b.code };
  return { ok: true, ...b.mail, recipients: rcpt.to.length, devices: b.model.devices };
}

/** 화면용 상태(주소 없음 — 개수만). */
export function storageUsageMailStatus(now = Date.now()) {
  const m = loadUsageMailSettings();
  const st = state();
  const rc = recipientsOf(m);
  return {
    enabled: m.enabled, next: nextDigestSlots(m, now, 3), lastSlot: st.lastSlot, lastSentAt: st.lastSentAt,
    history: st.history.map((h) => ({ ...h })), busy: _busy, lastTick: _lastTick, lastError: _lastError, edge: isEdge(),
    loadError: _loadErr ? { at: _loadErr.at } : null,
    recipients: { total: rc.to.length, fromAdmin: rc.fromAdmin, fromExtra: rc.fromExtra, dupes: rc.dupes },
  };
}

export function startStorageUsageMail() {
  if (_timer || isEdge()) return;
  _timer = setInterval(() => { usageMailTick().catch(() => {}); }, USAGE_MAIL_TICK_MS);
  _timer.unref?.();
}

export function _resetForTest() { _cfg = null; _loadErr = null; _state = null; _chain = Promise.resolve(); _busy = false; _lastTick = null; _lastError = null; if (_timer) { clearInterval(_timer); _timer = null; } }
export const _bootAtForTest = () => BOOT_AT;
