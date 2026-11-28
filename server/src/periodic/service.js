/**
 * periodic/service.js — 정기 점검 보고의 설정 · 상태 · 틱 · 회차 생성 · 전달 · 재시도 · 미리보기(설계 docs/design/periodic-report §4.4 · §4.5).
 * 규칙은 rules.js(순수), 항목은 catalog.js, 조립은 assemble.js, 글은 render.js, 보관은 db.js, 원천 읽기는 readers/*.js.
 *
 *  · **중앙 전용** — 엣지는 만들지도 보내지도 않는다(IP 관리 정기 보고와 같은 판단 — 법인 엣지는 자기 결과를 중앙에 올리고, 보고는 중앙이 모아서 한다).
 *  · 설정을 못 읽으면 기본값으로 돌리지 않고 멈춘다(사용자가 꺼 둔 보고를 기본값으로 켜지 않게 — ipam/report.js 103회차 F11 과 같은 읽기 · 손상 구분).
 *  · 생성과 전달을 나눈다: 회차는 먼저 보관하고, 전달 실패는 그 경로만 15 → 30 → 60분 간격으로 다시 보낸다(최대 4회 · 일일 리포트 backoff).
 *  · 조립은 서버 전체에서 동시에 하나(_busy). 같은 기간의 예약 회차가 이미 있으면 다시 만들지 않는다(재시작 · 시계 되감김).
 *  · 메일은 공용 경로(sendPortalMail kind 'periodic-report' — SMTP · 속도 제한 · 이력 · 감사). 데모(목) 데이터뿐이면 보내지 않는다(만들고 보관은 한다).
 */
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';
import { corruptOnlyReason } from '../util/registryCore.js';
import { makeJsonFileReader } from '../util/jsonFileRead.js';
import { DAY_OFFSET_MIN, dayKey } from '../util/dayKey.js';
import { GRACE_MS } from '../xferspeed/schedule.js';
import { sendPortalMail } from '../mail/service.js';
import { load as loadMailCfg } from '../mail/settings.js';
import { store } from '../store.js';
import { isMockVcenter } from '../mock/generator.js';
import { listDatacenters, getDatacenterAssign } from '../datacenter/store.js';
import {
  KINDS, KIND_LABEL, settingsOf, normalizeSettings, planKindTick, nextSlots, periodOf, manualRunId, matrixOf, scopeCutDoc, actionsOf,
} from './rules.js';
import { ITEMS, ITEM_KEYS, itemsForKind, catalogView } from './catalog.js';
import { assembleRun } from './assemble.js';
import { renderMail, renderReportHtml, renderChat, renderNotice, attachmentName, corpNamer } from './render.js';
import * as db from './db.js';
import { READERS } from './readers/index.js';
import { CAPTURE_MS } from './backupLedger.js';
import { captureBackups, backupSectionFor, ledgerStatus } from './backupService.js';
import { publicBackup } from './backupLedger.js';
import { pruneBackup } from './backupStore.js';

export const MAIL_KIND = 'periodic-report';
export const TICK_MS = 60_000;
const HISTORY_MAX = 60;
const PREVIEW_TTL_MS = 10 * 60_000;
const PREVIEW_MAX = 8;
const RETRY_STEPS_MS = Object.freeze([15 * 60_000, 30 * 60_000, 60 * 60_000]);
const RETRY_MAX_ATTEMPTS = 4;
const ATTACH_SOFT_MAX = 4_500_000;   // 공용 첨부 상한(5MB)보다 조금 아래 — 넘으면 첨부 없이 링크만
const PRUNE_EVERY_TICKS = 60;        // 약 1시간마다(기동 첫 틱 제외 — perf-db)
const NOTICE_DAYS = 7;
const SETTINGS_FILE = () => path.join(config.configDir, 'periodic-report.json');
const STATE_FILE = () => path.join(config.configDir, 'periodic-report-state.json');
registerStateFile('periodic-report-state.json');
const BOOT_AT = Date.now();
const isEdge = () => !!(config.agent?.centralUrl && config.agent?.centralToken);
const portalName = () => 'VMware Portal';   // 일일 리포트(buildDailyReportText 기본값)와 같은 이름 — 새 환경변수를 만들지 않는다

let _settingsErr = null;
const _settingsReader = makeJsonFileReader(SETTINGS_FILE, { parse: (t) => t, preserve: false, tag: 'periodic-report' });
const _stateReader = makeJsonFileReader(STATE_FILE, { parse: (t) => t, preserve: false, tag: 'periodic-report' });
let _stateReadErr = false;

/** 설정(못 읽었으면 null — 기본값으로 만들지도 보내지도 않는다). */
export function loadSettings() {
  const rr = _settingsReader.read();
  if (rr.kind === 'read-error') {
    const code = String(rr.error?.code || 'read-error').slice(0, 32);
    if (!_settingsErr?.readError) _settingsErr = { at: Date.now(), reason: `읽기 오류(${code}) — 원본은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(30초마다 다시 읽습니다)`, readError: true };
    return null;
  }
  if (rr.kind === 'missing') {
    const why = corruptOnlyReason(SETTINGS_FILE());
    _settingsErr = why ? { at: _settingsErr?.corruptKept ? _settingsErr.at : Date.now(), corruptKept: true, reason: '설정 파일이 없고 손상 보존본만 남아 있습니다 — 정기 점검 보고를 멈췄습니다. 보존본을 확인한 뒤 설정을 다시 저장하면 풀립니다' } : null;
    return why ? null : settingsOf(null);
  }
  try { const s = settingsOf(JSON.parse(rr.value)); _settingsErr = null; return s; }
  catch (e) {
    if (!_settingsErr) { preserveCorrupt(SETTINGS_FILE(), e?.message); console.warn(`[periodic-report] 설정 파일을 읽지 못했습니다: ${safeLoadText(e) || '사유 미상'}`); }
    _settingsErr = { at: Date.now(), reason: safeLoadText(e) || '형식 오류' };
    return null;
  }
}
export function settingsError() { loadSettings(); return _settingsErr; }

/** 저장 — 정규화 실패는 { error, field }(라우트 400) · 못 읽은 동안은 { error, code:'settings-unreadable' }(409). */
export function saveSettings(input, { by = null, now = Date.now() } = {}) {
  const prev = loadSettings();
  if (prev == null) return { error: '설정 파일을 읽지 못해 저장하지 않았습니다(원본 · 손상 보존본을 확인하세요).', field: 'settings', code: 'settings-unreadable' };
  let known = null;
  try { known = new Set((store.get()?.vcenters || []).map((v) => String(v.id))); } catch { known = null; }
  const r = normalizeSettings(input, prev, { now, by, knownItems: ITEM_KEYS, knownVcIds: known });
  if (r.error) return r;
  atomicWriteFileSync(SETTINGS_FILE(), JSON.stringify(r.settings, null, 2), { mode: 0o600 });
  _settingsReader.reset(); _settingsErr = null;
  return r;
}

/* ── 상태 파일(회차 기록 · 놓침 · 공지 id · 이슈 하루 상한) ── */
let _state = null;
const freshState = () => ({ lastSlot: {}, history: [], noticeId: null, issuesDay: { day: '', count: 0 } });
function state() {
  if (_state) return _state;
  const rr = _stateReader.read();
  if (rr.kind === 'read-error') { _stateReadErr = true; return freshState(); }
  _stateReadErr = false;
  try {
    if (rr.kind === 'missing') { _state = freshState(); return _state; }
    const raw = JSON.parse(rr.value);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('형식 오류');
    const st = freshState();
    for (const k of KINDS) { const n = Number(raw.lastSlot?.[k]); if (Number.isFinite(n) && n > 0) st.lastSlot[k] = n; }
    st.history = (Array.isArray(raw.history) ? raw.history : []).filter((h) => h && typeof h === 'object').slice(0, HISTORY_MAX);
    st.noticeId = typeof raw.noticeId === 'string' ? raw.noticeId.slice(0, 64) : null;
    if (raw.issuesDay && typeof raw.issuesDay === 'object') st.issuesDay = { day: String(raw.issuesDay.day || ''), count: Number(raw.issuesDay.count) || 0 };
    _state = st;
  } catch (e) {
    preserveCorrupt(STATE_FILE(), e?.message);
    console.warn(`[periodic-report] 상태 파일을 읽지 못해 새로 시작합니다: ${safeLoadText(e) || '사유 미상'}`);
    _state = freshState();
  }
  return _state;
}
function saveState() { const st = state(); if (_stateReadErr) return; try { atomicWriteFileSync(STATE_FILE(), JSON.stringify(st), { mode: 0o600 }); } catch (e) { console.warn(`[periodic-report] 상태 저장 실패: ${e?.message || e}`); } }
function record(entry) {
  const st = state();
  st.history.unshift({ at: Date.now(), ...entry });
  st.history.length = Math.min(st.history.length, HISTORY_MAX);
  saveState();
}

/* ── 회차 생성 ── */
let _busy = null;       // { kind, id, startedAt, done, total }
let _lastError = null; let _lastTick = null; let _tickN = 0;
const _previews = new Map();

function dcHelpers() {
  let assign = {}; let names = new Map();
  try { assign = getDatacenterAssign() || {}; names = new Map(listDatacenters().map((d) => [String(d.id), String(d.name || d.id)])); } catch { /* 법인 표를 못 읽음 — vCenter 이름으로 */ }
  return { dcOfVc: (vc) => assign[vc] || '', dcName: (dc) => names.get(String(dc)) || '' };
}

/**
 * 회차 하나를 만든다(예약 · 수동 · 미리보기).
 * @param {{kind:string, slot?:number|null, manual?:boolean, preview?:boolean, by?:string, now?:number, deliver?:boolean}} o
 * @returns {Promise<{ok:boolean, id?:string, doc?:object, previewId?:string, reason?:string, code?:string}>}
 */
export async function generateRun({ kind, slot = null, manual = false, preview = false, by = 'schedule', now = Date.now(), deliver = true } = {}) {
  if (!KINDS.includes(kind)) return { ok: false, code: 'bad-kind', reason: '주기는 일일 · 주간 · 월간 · 분기 중 하나입니다.' };
  if (isEdge()) return { ok: false, code: 'edge', reason: '엣지는 정기 점검 보고를 만들지 않습니다(중앙만 만듭니다).' };
  if (_busy) return { ok: false, code: 'busy', reason: `다른 보고서를 만드는 중입니다(${KIND_LABEL[_busy.kind]} ${_busy.id || ''}) — 끝난 뒤 다시 하세요.` };
  const s = loadSettings();
  if (!s) return { ok: false, code: 'settings-unreadable', reason: '설정 파일을 읽지 못해 만들지 않았습니다.' };
  const period = periodOf(kind, slot ?? now);
  const id = manual || preview ? manualRunId(period.id, now) : period.id;
  if (!manual && !preview) {
    const exists = await db.hasRun(id);
    if (exists == null) return { ok: false, code: 'db-unavailable', reason: `보관 DB 를 열지 못했습니다: ${db.periodicDbError() || '사유 미상'}` };
    if (exists) return { ok: false, code: 'exists', reason: `이미 만든 회차입니다(${id}).` };
  }
  _busy = { kind, id, startedAt: Date.now(), done: 0, total: 0 };
  try {
    const items = itemsForKind(kind, s.items);
    _busy.total = items.length;
    const snap = store.get();
    const vcs = (snap?.vcenters || []).filter((v) => v && v.status !== 'disabled');
    const mock = vcs.length > 0 && vcs.every((v) => isMockVcenter(v));
    const prev = await db.previousRun(kind, period.from);
    const { dcOfVc, dcName } = dcHelpers();
    const withBackup = s.backup?.kinds?.includes(kind);
    const doc = await assembleRun({ kind, slot: slot ?? null, period, id, items, readers: READERS, snap, now, by: manual || preview ? (by || 'admin') : 'schedule', manual: manual || preview,
      prev, dcOfVc, dcName, mock, onProgress: (p) => { if (_busy) _busy.done = p.done; },
      ...(withBackup ? { backup: (ctx) => backupSectionFor({ from: period.from, to: period.to, now, settings: s, ctx }) } : {}) });
    if (preview) {
      for (const [k, v] of _previews) if (now - v.at > PREVIEW_TTL_MS) _previews.delete(k);
      while (_previews.size >= PREVIEW_MAX) _previews.delete(_previews.keys().next().value);
      const previewId = `p${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      _previews.set(previewId, { doc, at: now, by });
      return { ok: true, previewId, doc };
    }
    const put = await db.putRun(doc, matrixOf(doc));
    if (!put.ok) {
      record({ kind, id, state: 'failed', reason: `보관하지 못했습니다: ${put.reason}` });
      return { ok: false, code: 'db-write', reason: `보관하지 못했습니다: ${put.reason}` };
    }
    record({ kind, id, state: 'done', manual, by: doc.by, overall: doc.overall, ms: doc.durationMs });
    if (deliver) await deliverRun(doc, s, { manual });
    return { ok: true, id, doc };
  } catch (e) {
    _lastError = { at: Date.now(), message: String(e?.message || e).slice(0, 300) };
    record({ kind, id, state: 'failed', reason: `만들지 못했습니다: ${_lastError.message}` });
    return { ok: false, code: 'failed', reason: `만들지 못했습니다: ${_lastError.message}` };
  } finally { _busy = null; }
}

/** 미리보기를 그대로 보관하고 전달한다(수동 회차 — 만든 사람 기록). */
export async function keepPreview(previewId, { by = 'admin' } = {}) {
  const p = _previews.get(String(previewId));
  if (!p || Date.now() - p.at > PREVIEW_TTL_MS) return { ok: false, code: 'expired', reason: '미리보기가 없거나 10분이 지나 사라졌습니다 — 다시 만들어 주세요.' };
  const s = loadSettings();
  if (!s) return { ok: false, code: 'settings-unreadable', reason: '설정 파일을 읽지 못해 보내지 않았습니다.' };
  const doc = { ...p.doc, by };
  const put = await db.putRun(doc, matrixOf(doc));
  if (!put.ok) return { ok: false, code: 'db-write', reason: `보관하지 못했습니다: ${put.reason}` };
  _previews.delete(String(previewId));
  record({ kind: doc.kind, id: doc.id, state: 'done', manual: true, by, overall: doc.overall, ms: doc.durationMs });
  await deliverRun(doc, s, { manual: true });
  return { ok: true, id: doc.id };
}
export function previewDoc(previewId) { const p = _previews.get(String(previewId)); return p && Date.now() - p.at <= PREVIEW_TTL_MS ? p.doc : null; }

/* ── 전달 ── */
const adminTo = () => { try { return loadMailCfg().defaultTo || []; } catch { return []; } };
function overallRecipients(s) {
  const seen = new Set(); const out = [];
  for (const a of [...(s.mail.includeAdmin ? adminTo() : []), ...s.mail.to]) {
    const v = String(a || '').trim(); if (!v || seen.has(v.toLowerCase())) continue; seen.add(v.toLowerCase()); out.push(v);
  }
  return out;
}
const linkOf = (doc) => `#/tools/periodic-report/r/${encodeURIComponent(doc.id)}`;

/** 메일 한 통(전체판 target='overall' · 법인판 target=vcId). */
async function sendMailFor(doc, s, target) {
  const corp = target === 'overall' ? null : String(target);
  const cut = corp ? scopeCutDoc(doc, new Set([corp])) : doc;
  // v3.59 3절 — 메일 · 첨부는 실패 사유 공개 문구 판본(받는 사람이 포탈 관리자가 아닐 수 있다 — 화면의 비관리자 판본과 같다)
  const view = cut.backup && !cut.backup.off && !cut.backup.error ? { ...cut, backup: publicBackup(cut.backup) } : cut;
  const to = corp ? (s.mail.corpTo?.[corp] || []) : overallRecipients(s);
  if (!to.length) return { state: 'skipped', reason: corp ? '이 법인의 받는 사람이 없습니다.' : "받는 사람이 없습니다 — '통합 관리자'(메일 기본 받는 사람)를 고르거나 주소를 넣으세요.", recipients: 0 };
  const corpLabel = corp ? corpNamer(doc)(corp) : '';
  let attachments = [];
  let attached = false;
  if (s.mail.attach) {
    const html = renderReportHtml(view, { portal: portalName(), scopedNote: corp ? `${corpLabel} 법인판 — 이 법인 행만 담았습니다(법인 행이 없는 포탈 자체 항목은 빠졌습니다).` : '' });
    const buf = Buffer.from(html, 'utf8');
    if (buf.length <= ATTACH_SOFT_MAX) { attachments = [{ filename: attachmentName(doc, corp || ''), contentType: 'text/html', content: buf }]; attached = true; }
  }
  const m = renderMail(view, { portal: portalName(), corpLabel, attached, link: linkOf(doc) });
  const r = await sendPortalMail({ kind: MAIL_KIND, subject: m.subject, html: m.html, text: m.text, to, attachments, by: 'system' });
  if (r?.ok) return { state: 'sent', recipients: to.length };
  if (r?.skipped) return { state: 'skipped', reason: r.reason || '메일이 꺼져 있습니다', recipients: to.length };
  return { state: 'failed', reason: String(r?.reason || '보내지 못했습니다').slice(0, 300), recipients: to.length };
}

async function sendChatFor(doc) {
  const { sendChatText } = await import('../alerts.js');
  const res = await sendChatText(renderChat(doc, { portal: portalName() }), `${KIND_LABEL[doc.kind]} 점검 보고서 ${doc.periodLabel}`);
  if (!res.length) return { state: 'skipped', reason: '켜진 알림 채널(Slack · Teams · 웹훅)이 없습니다.' };
  const bad = res.filter((x) => /err|:[45]\d\d/.test(String(x)));
  return bad.length ? { state: 'failed', reason: bad.join(' · ').slice(0, 300), recipients: res.length } : { state: 'sent', recipients: res.length };
}

async function postNotice(doc) {
  const { createNotice, updateNotice } = await import('../bulletin/store.js');
  const n = renderNotice(doc);
  const body = { title: n.title, body: n.body, level: 'info', enabled: true, startAt: null, endAt: Date.now() + NOTICE_DAYS * 86_400_000 };
  const st = state();
  try {
    if (st.noticeId) {
      try { updateNotice(st.noticeId, body, 'periodic-report'); return { state: 'sent', reason: '공지 하나를 갱신했습니다' }; }
      catch (e) { if (e?.status !== 404 && e?.code !== 'not-found' && !/찾을 수 없|not.?found/i.test(String(e?.message))) throw e; }
    }
    const created = createNotice(body, 'periodic-report');
    st.noticeId = created?.id || null; saveState();
    return { state: 'sent', reason: '공지를 올렸습니다' };
  } catch (e) { return { state: 'failed', reason: String(e?.message || e).slice(0, 300) }; }
}

async function createIssues(doc, s, now = Date.now()) {
  const crit = actionsOf(doc, corpNamer(doc)).filter((x) => x.status === 'crit');
  if (!crit.length) return { state: 'skipped', reason: '이상 항목이 없습니다.' };
  const st = state();
  const today = dayKey(now);
  if (st.issuesDay.day !== today) st.issuesDay = { day: today, count: 0 };
  const { createIssue, findByOrigin } = await import('../issues/store.js');
  let made = 0; let dup = 0; let capped = 0;
  for (const a of crit) {
    if (st.issuesDay.count >= s.issues.dailyMax) { capped++; continue; }
    // 출처는 '다른 알람' 모양(issues/store.js originField 'alert') — 같은 항목 · 법인의 열린 이슈가 있으면 다시 만들지 않는다.
    const alertKey = `periodic:${a.item}:${a.vc || 'all'}`;
    try {
      if (findByOrigin((o) => o?.kind === 'alert' && o.alertKey === alertKey, { openOnly: true }).length) { dup++; continue; }
      createIssue({ title: `[정기 점검] ${a.corp} — ${a.label}`.slice(0, 200), body: `${KIND_LABEL[doc.kind]} 점검 보고서 ${doc.id}(${doc.periodLabel})에서 이상으로 판정했습니다.\n근거: ${a.basis}\n\n보고서: 특수 기능 › 정기 점검 보고(#/tools/periodic-report/r/${doc.id})\n이 이슈는 정기 점검 보고의 이슈 자동 등록이 만들었습니다 — 해소는 사람이 판단해 닫습니다.`, type: 'task', priority: 'p1', ...(a.vc ? { vcenterId: a.vc } : {}) },
        'periodic-report', { origin: { kind: 'alert', alertKey, alertKind: 'periodic', title: `${a.label}`.slice(0, 200), deviceName: a.corp } });
      st.issuesDay.count++; made++;
    } catch (e) { return { state: 'failed', reason: String(e?.message || e).slice(0, 300) }; }
  }
  saveState();
  return { state: made ? 'sent' : 'skipped', reason: `만듦 ${made}${dup ? ` · 이미 있음 ${dup}` : ''}${capped ? ` · 하루 상한으로 건너뜀 ${capped}` : ''}`, recipients: made };
}

/** 경로 하나를 보내고 결과를 기록(실패면 재시도 시각). */
async function attempt(doc, s, channel, target, prevRec = null) {
  let r;
  try {
    if (channel === 'mail') r = await sendMailFor(doc, s, target);
    else if (channel === 'chat') r = await sendChatFor(doc);
    else if (channel === 'notice') r = await postNotice(doc);
    else if (channel === 'issues') r = await createIssues(doc, s);
    else r = { state: 'skipped', reason: '모르는 경로' };
  } catch (e) { r = { state: 'failed', reason: String(e?.message || e).slice(0, 300) }; }
  const n = (prevRec?.attempt || 0) + 1;
  const retry = r.state === 'failed' && n < RETRY_MAX_ATTEMPTS && channel !== 'issues';
  const rec = { runId: doc.id, kind: doc.kind, channel, target, state: retry ? 'retry' : r.state, at: Date.now(), reason: r.reason || null, attempt: n,
    nextAt: retry ? Date.now() + RETRY_STEPS_MS[Math.min(RETRY_STEPS_MS.length - 1, n - 1)] : null, recipients: r.recipients ?? null };
  if (prevRec?.id) await db.updateDelivery(prevRec.id, rec); else await db.addDelivery(rec);
  return rec;
}

/** 회차 하나를 정한 경로로 보낸다(설정의 주기 · 켜기). 데모 데이터뿐이면 보내지 않고 그 사실을 기록한다. */
export async function deliverRun(doc, s, { manual = false } = {}) {
  const out = [];
  if (doc.mock) {
    await db.addDelivery({ runId: doc.id, kind: doc.kind, channel: 'all', target: null, state: 'skipped', reason: '데모(목) 데이터뿐이라 보내지 않았습니다', attempt: 1 });
    return out;
  }
  if (s.mail.enabled && s.mail.kinds.includes(doc.kind)) {
    out.push(await attempt(doc, s, 'mail', 'overall'));
    for (const vc of Object.keys(s.mail.corpTo || {})) if ((doc.corps || []).some((c) => c.vc === vc)) out.push(await attempt(doc, s, 'mail', vc));
  }
  if (s.chat.enabled && s.chat.kinds.includes(doc.kind)) out.push(await attempt(doc, s, 'chat', 'channels'));
  if (s.notice.enabled && s.notice.kinds.includes(doc.kind) && !manual) out.push(await attempt(doc, s, 'notice', 'notice'));
  if (s.issues.enabled && !manual) out.push(await attempt(doc, s, 'issues', 'issues'));
  return out;
}

/** 전달 다시 보내기(수동 — backoff 를 기다리지 않는다). channel 없으면 실패 · 재시도 대기 경로 전부. */
export async function redeliver(runId, { channel = '' } = {}) {
  const s = loadSettings();
  if (!s) return { ok: false, code: 'settings-unreadable', reason: '설정 파일을 읽지 못해 보내지 않았습니다.' };
  const got = await db.getRun(runId);
  if (got == null) return { ok: false, code: 'db-unavailable', reason: '보관 DB 를 열지 못했습니다.' };
  if (!got.run?.doc) return { ok: false, code: 'not-found', reason: '회차를 찾지 못했습니다.' };
  const doc = got.run.doc;
  const list = (await db.deliveriesOfRun(runId)) || [];
  const targets = list.filter((d) => (d.state === 'failed' || d.state === 'retry') && (!channel || d.channel === channel));
  if (!targets.length && channel) {
    const rec = await attempt(doc, s, channel, channel === 'mail' ? 'overall' : channel);
    return { ok: rec.state === 'sent', results: [rec] };
  }
  const results = [];
  for (const d of targets) results.push(await attempt(doc, s, d.channel, d.target, { id: d.id, attempt: 0 }));
  return { ok: results.every((r) => r.state === 'sent'), results };
}

async function retryDue(now = Date.now()) {
  const due = await db.dueDeliveries(now, 10);
  if (!due.length) return 0;
  const s = loadSettings();
  if (!s) return 0;
  let n = 0;
  for (const d of due) {
    const got = await db.getRun(d.runId);
    if (!got?.run?.doc) { await db.updateDelivery(d.id, { ...d, state: 'failed', reason: '회차가 지워져 다시 보내지 않습니다', nextAt: null }); continue; }
    await attempt(got.run.doc, s, d.channel, d.target, d);
    n++;
  }
  return n;
}

/* ── 틱 ── */
export async function tick(now = Date.now()) {
  if (isEdge()) return { action: 'edge' };
  _tickN++;
  _lastTick = { at: now };
  const s = loadSettings();
  if (!s) return { action: 'unreadable' };
  const st = state();
  const results = [];
  for (const kind of KINDS) {
    const def = s.kinds[kind];
    // 처음 도는 설치(기록 · since 없음 — 기본값 켜짐)는 기동 시각 - 유예를 바닥으로 — 설치 직후 지난 회차를 '놓침' 으로 줄줄이 적지 않는다(기동 직후 유예 안 회차는 만든다).
    const floorSlot = st.lastSlot[kind] ?? (def?.since ? null : BOOT_AT - GRACE_MS);
    const plan = planKindTick({ kind, def, state: { lastSlot: floorSlot }, now, bootAt: BOOT_AT, offsetMin: DAY_OFFSET_MIN });
    if (plan.action === 'rebase') { st.lastSlot[kind] = plan.lastSlot; saveState(); continue; }
    if (plan.action === 'missed') {
      st.lastSlot[kind] = plan.slot;
      record({ kind, id: periodOf(kind, plan.slot).id, state: 'missed', code: plan.reason, count: plan.count,
        reason: plan.reason === 'down' ? '포탈이 꺼져 있던 동안의 회차라 만들지 않았습니다(몰아서 만들지 않습니다).' : '정한 시각보다 30분 넘게 늦게 확인해 만들지 않았습니다(몰아서 만들지 않습니다).' });
      continue;
    }
    if (plan.action === 'run') {
      if (_busy) continue;   // 다른 회차 조립 중 — 30분 유예 안에서 다음 틱에 다시 본다
      st.lastSlot[kind] = plan.slot; saveState();
      const r = await generateRun({ kind, slot: plan.slot, now });
      results.push({ kind, ...r, doc: undefined });
    }
  }
  try { await retryDue(now); } catch (e) { _lastError = { at: Date.now(), message: `재시도 실패: ${String(e?.message || e).slice(0, 200)}` }; }
  // v3.59 백업 적재 — 관측 주기마다(첫 틱 포함 — 기동 직후에도 한 번 본다 · 관측 실패는 적재 상태에 남는다). 적재를 끈 설정이면 멈춘다.
  if (s.backup?.ledger !== false && (_tickN === 1 || _tickN % Math.max(1, Math.round(CAPTURE_MS / TICK_MS)) === 0)) {
    try { await captureBackups({ now }); } catch (e) { console.warn(`[periodic-report] 백업 적재 실패: ${e?.message || e}`); }
  }
  if (_tickN > 1 && _tickN % PRUNE_EVERY_TICKS === 0) {
    try { await db.prunePeriodic(s.retainDays, now); } catch (e) { console.warn(`[periodic-report] 정리 실패: ${e?.message || e}`); }
    try { await pruneBackup(s.backup?.keepDays, now); } catch (e) { console.warn(`[periodic-report] 백업 적재 정리 실패: ${e?.message || e}`); }
  }
  return { action: 'ok', results };
}

let _timer = null;
export function startPeriodicReport() {
  if (_timer || isEdge()) return;
  _timer = setInterval(() => { tick().catch((e) => { _lastError = { at: Date.now(), message: String(e?.message || e).slice(0, 300) }; }); }, TICK_MS);
  _timer.unref?.();
}

/** 화면 '지금 상태'(주소 없음 — 받는 사람은 수만). */
export async function status(now = Date.now()) {
  const s = loadSettings();
  const st = state();
  const kinds = {};
  for (const k of KINDS) {
    const def = s?.kinds?.[k];
    kinds[k] = { enabled: !!def?.enabled, def: def || null, next: def ? nextSlots(k, def, now, 2) : [], last: await db.lastRunOfKind(k), items: s ? itemsForKind(k, s.items).length : null };
  }
  return {
    edge: isEdge(), kinds, busy: _busy ? { ..._busy } : null, lastTick: _lastTick, lastError: _lastError, settingsError: _settingsErr,
    history: st.history.slice(0, 30), retry: await db.retryCount(), db: await db.periodicDbInfo(), backup: { ...(await ledgerStatus()), enabled: s?.backup?.ledger !== false },
    recipients: s ? { overall: overallRecipients(s).length, corps: Object.keys(s.mail.corpTo || {}).length } : null,
  };
}

export function catalog() { const s = loadSettings(); return { items: catalogView(s?.items || {}), total: ITEMS.length }; }

export function _resetPeriodicForTest() {
  _state = null; _stateReadErr = false; _settingsReader.reset(); _stateReader.reset(); _settingsErr = null;
  _busy = null; _lastError = null; _lastTick = null; _tickN = 0; _previews.clear();
  if (_timer) { clearInterval(_timer); _timer = null; }
}
