/**
 * sanswitch/storagePerfReportMail.js — 월간 SAN 스토리지 성능 점검 보고서 **발송 러너**(v2.950 · 설계 §12.2-8). 보고서 자체는 storagePerfReport.js(순수).
 *
 *  · 설정 `san-storage-report.json`(enabled · dayOfMonth · time · to · topN) · 상태 `san-storage-report-state.json`(lastSlot · history 20) — 원자적 쓰기 + 손상 보존.
 *  · 1분 틱 · 회차는 보내기 **전에** 기록(보내는 중 재시작해도 두 번 보내지 않는다) · 놓친 회차는 기록만(몰아서 보내지 않는다) · 중앙만(엣지는 보내지 않는다) · 재진입 가드.
 *  · 메일은 공용 경로 `sendPortalMail({ kind: 'san-storage-report' })`(SMTP 설정 · 수신자 · 속도 제한 · 이력 · 감사 — mail/kinds.js 등재) · 첨부 = 자급형 HTML(브라우저에서 PDF 저장).
 *  · 점검은 라우트 모듈의 buildListCore · runCheck(판정 코어 하나) — 알림 · 공개 API · 화면과 같은 값.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { numOrNull } from '../util/numOrNull.js';
import { sendPortalMail } from '../mail/service.js';
import { load as loadMailCfg } from '../mail/settings.js';
import { REPORT_DEFAULTS, REPORT_KIND, normalizeReportSettings, planMonthlyTick, monthLabelOf, monthlySlot, buildReportModel, renderReportHtml, reportMailParts } from './storagePerfReport.js';
import { deviceContextOf, buildListCore, runCheck } from './storagePerfCore.js';   // 판정 코어(라우트가 아니다 — 방향 위반 · 순환 금지)

const FILE = () => path.join(config.configDir, 'san-storage-report.json');
const STATE_FILE = () => path.join(config.configDir, 'san-storage-report-state.json');
export const REPORT_TICK_MS = 60_000;
export const REPORT_HISTORY_MAX = 20;
const BOOT_AT = Date.now();
const isEdge = () => !!(config.agent.centralUrl && config.agent.centralToken);
const strMax = (v, n) => String(v ?? '').slice(0, n);

/* ── 설정 ─────────────────────────────────────────────────────────────── */
let _cfg = null; let _loadErr = null;
export function loadReportSettings() {
  if (_cfg) return _cfg;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    const r = normalizeReportSettings(raw, REPORT_DEFAULTS);
    if (r.issue) throw new Error(r.issue);
    _cfg = { ...r.settings, updatedAt: numOrNull(raw.updatedAt), updatedBy: strMax(raw.updatedBy, 64) }; _loadErr = null;
  } catch (e) {
    if (e?.code !== 'ENOENT') { preserveCorrupt(FILE(), e?.message); _loadErr = { at: Date.now(), reason: strMax(e?.message, 200) }; console.warn(`[san-storage-report] 설정 파일을 읽지 못했습니다(손상본 보존 · 정기 발송 중지): ${_loadErr.reason}`); }
    _cfg = { ...REPORT_DEFAULTS, updatedAt: null, updatedBy: '' };
  }
  return _cfg;
}
export const reportLoadError = () => { loadReportSettings(); return _loadErr; };
export function saveReportSettings(input, { by = '' } = {}) {
  loadReportSettings();
  if (_loadErr) return { issue: '설정 파일을 읽지 못해 저장하지 않았습니다 — 손상본(san-storage-report.json.corrupt.*)을 확인하세요.' };
  const r = normalizeReportSettings(input, _cfg);
  if (r.issue) return r;
  const next = { ...r.settings, updatedAt: Date.now(), updatedBy: strMax(by, 64) };
  atomicWriteFileSync(FILE(), JSON.stringify(next, null, 2), { mode: 0o600 });
  _cfg = next;
  return { settings: next };
}

/* ── 상태 ─────────────────────────────────────────────────────────────── */
let _state = null;
function state() {
  if (_state) return _state;
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('형식 오류');
    _state = { lastSlot: numOrNull(raw.lastSlot), lastSentAt: numOrNull(raw.lastSentAt), history: (Array.isArray(raw.history) ? raw.history : []).slice(0, REPORT_HISTORY_MAX) };
  } catch (e) {
    if (e?.code !== 'ENOENT') { preserveCorrupt(STATE_FILE(), e?.message); console.warn(`[san-storage-report] 상태 파일을 읽지 못해 새로 시작합니다: ${safeLoadText(e, 160)}`); }
    _state = { lastSlot: null, lastSentAt: null, history: [] };
  }
  return _state;
}
function saveState() { try { atomicWriteFileSync(STATE_FILE(), JSON.stringify(state()), { mode: 0o600 }); } catch (e) { console.warn(`[san-storage-report] 상태 파일을 저장하지 못했습니다(메모리로 계속): ${e.message}`); } }
function record(entry) { const st = state(); const e = { at: Date.now(), ...entry }; st.history = [e, ...st.history].slice(0, REPORT_HISTORY_MAX); saveState(); return e; }

/* ── 만들기 · 보내기 ──────────────────────────────────────────────────── */
/** 보고서 모델 + HTML(미리보기 · 발송 공용). 장비 호출 0. */
export async function buildReport({ now = Date.now(), monthLabel = '', topN = null } = {}) {
  const cfg = loadReportSettings();
  const ctx = await deviceContextOf({ admin: false });   // 메일은 관리자가 아닌 사람도 받는다 — 주소 가림 판본
  const list = await buildListCore(ctx, null);
  const check = await runCheck(list, { signal: null });
  const model = buildReportModel(list, check, { now, monthLabel: monthLabel || monthLabelOf(now + 86_400_000), topN: topN ?? cfg.topN, portal: '' });
  return { model, html: renderReportHtml(model), parts: reportMailParts(model), arrays: list.rows.length };
}
const recipientsOf = (cfg) => { if (cfg.to?.length) return cfg.to; try { return loadMailCfg().defaultTo || []; } catch { return []; } };
let _chain = Promise.resolve();
const serial = (fn) => { const p = _chain.then(fn, fn); _chain = p.catch(() => {}); return p; };
export function sendReport({ slot = null, manual = false, by = 'system', now = Date.now() } = {}) {
  return serial(async () => {
    const kind = manual ? 'manual' : 'schedule';
    try {
      if (isEdge()) return { ok: false, state: 'edge', reason: '엣지는 이 메일을 보내지 않습니다(메인만 보냅니다).' };
      if (reportLoadError()) return { ok: false, state: 'skipped', ...record({ slot, kind, state: 'skipped', code: 'unreadable', reason: '설정 파일을 읽지 못해 보내지 않았습니다.' }) };
      const cfg = loadReportSettings();
      const to = recipientsOf(cfg);
      if (!to.length) return { ok: false, state: 'skipped', ...record({ slot, kind, state: 'skipped', code: 'no-recipients', reason: "받는 사람이 없습니다 — 보고서 설정의 '받는 사람' 또는 설정 › 알림·메일의 기본 수신자" }) };
      const b = await buildReport({ now, monthLabel: slot ? monthLabelOf(slot) : '' });
      if (!b.arrays) return { ok: false, state: 'skipped', ...record({ slot, kind, state: 'skipped', code: 'no-arrays', reason: '판정할 어레이가 없어 보내지 않았습니다.' }) };
      // ⚠ v2.955: contentType 은 매개변수 없이 'text/html' — util/smtp.js 가 text/* 에 charset 을 붙이고, '; charset=' 이 든 값은 화이트리스트에 걸려 **항상 실패**했다(v2.953 결함 · 가짜 SMTP 시험이 잡았다).
      const attachments = [{ filename: b.parts.filename, contentType: 'text/html', content: Buffer.from(b.html, 'utf8') }];
      const r = await sendPortalMail({ kind: REPORT_KIND, subject: b.parts.subject, html: b.parts.html, text: b.parts.text, to, by: manual ? (by || 'admin') : 'system', attachments });
      if (r.ok) { state().lastSentAt = Date.now(); return { ok: true, state: 'sent', ...record({ slot, kind, state: 'sent', to: to.length, arrays: b.arrays, month: b.model.monthLabel, bytes: attachments[0].content.length }) }; }
      const code = r.skipped ? (r.authStopped ? 'auth-stopped' : 'mail-off') : null;
      return { ok: false, state: r.skipped ? 'skipped' : 'failed', ...record({ slot, kind, state: r.skipped ? 'skipped' : 'failed', code, reason: r.reason || '보내지 못했습니다', to: to.length }) };
    } catch (e) {
      console.warn(`[san-storage-report] 보고서를 만들지 못했습니다: ${e?.message || e}`);
      return { ok: false, state: 'failed', ...record({ slot, kind, state: 'failed', reason: `만들지 못했습니다: ${strMax(e?.message || e, 200)}` }) };
    }
  });
}
export function sendReportNow(by = 'admin', now = Date.now()) { return sendReport({ slot: null, manual: true, by, now }); }

/* ── 틱 ───────────────────────────────────────────────────────────────── */
let _timer = null; let _busy = false; let _lastTick = null;
export async function reportTick(now = Date.now()) {
  if (isEdge()) return { action: 'edge' };
  if (_busy) return { action: 'busy' };
  _busy = true;
  try {
    if (reportLoadError()) return { action: 'unreadable' };
    const cfg = loadReportSettings();
    const st = state();
    const plan = planMonthlyTick({ cfg, state: st, now, bootAt: BOOT_AT });
    _lastTick = { at: now, action: plan.action };
    if (plan.action === 'rebase') { st.lastSlot = plan.lastSlot; saveState(); return plan; }
    if (plan.action === 'missed') { st.lastSlot = plan.slot; record({ slot: plan.slot, kind: 'schedule', state: 'missed', code: plan.reason, reason: plan.reason === 'down' ? '포탈이 꺼져 있던 회차라 보내지 않았습니다(몰아서 보내지 않습니다).' : '정한 시각보다 30분 넘게 늦게 확인해 보내지 않았습니다.' }); return plan; }
    if (plan.action === 'send') { st.lastSlot = plan.slot; saveState(); const result = await sendReport({ slot: plan.slot, now }); return { ...plan, result }; }
    return plan;
  } catch (e) { console.warn(`[san-storage-report] 틱 실패: ${e?.message || e}`); return { action: 'error', error: strMax(e?.message || e, 200) }; }
  finally { _busy = false; }
}
export function startStoragePerfReport() {
  if (_timer || isEdge()) return;
  _timer = setInterval(() => { reportTick().catch(() => {}); }, REPORT_TICK_MS);
  if (typeof _timer.unref === 'function') _timer.unref();
}
export function storagePerfReportStatus(now = Date.now()) {
  const cfg = loadReportSettings();
  const st = state();
  return { settings: cfg, loadError: _loadErr, lastSlot: st.lastSlot, lastSentAt: st.lastSentAt, history: st.history, lastTick: _lastTick, edge: isEdge(),
    nextSlot: cfg.enabled ? (() => { const prev = monthlySlot(cfg, now); const d = new Date(prev); const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes())); return n.getTime() > now ? n.getTime() : null; })() : null };
}
export function _resetReportForTest() { _cfg = null; _loadErr = null; _state = null; _timer = null; _busy = false; _lastTick = null; }
