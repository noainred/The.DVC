/**
 * storage/inspect/schedule.js — PowerScale 점검 **설정 · 주간 회차 · 보고서 메일**(v2.964 · 중앙만 — 엣지는 회차를 돌리지 않는다).
 *
 *  · 설정 `storage-inspect.json`(enabled · weekday · time · mailEnabled · mailDelayMin · to · corpTo · thresholds) — 원자적 쓰기 + 손상 보존 · 못 읽으면 저장 거절.
 *  · 상태 `storage-inspect-state.json`(lastRunSlot · lastMailSlot · history 20) — 상태 파일(백업 변경 감시 대상 아님).
 *  · 1분 틱: ① 점검 회차(매주 weekday HH:MM 포탈 시각) — 중앙 직접 장비는 여기서 돌리고 위임 장비는 요청 큐(requests.js)에 넣는다.
 *    ② 메일 회차(점검 회차 + mailDelayMin — 엣지 결과가 올라올 시간) — 전체판은 to(없으면 메일 설정의 기본 수신자), 법인판은 corpTo[법인] 에게 그 법인 장비만.
 *    회차는 실행 **전에** 기록한다(재시작해도 두 번 돌지 않는다) · 포탈이 꺼져 있던 회차는 기록만(몰아서 돌리지 않는다 — usageMail · SAN 보고서와 같은 규약).
 *  · 메일은 공용 경로 sendPortalMail({ kind: 'storage-inspect-report' }) — SMTP 설정 · 속도 제한 · 이력 · 감사(mail/kinds.js 등재).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../../util/atomicWrite.js';
import { registerStateFile } from '../../util/stateFiles.js';
import { numOrNull } from '../../util/numOrNull.js';
import { DAY_OFFSET_MIN } from '../../util/dayKey.js';
import { sendPortalMail } from '../../mail/service.js';
import { load as loadMailCfg } from '../../mail/settings.js';
import { THRESHOLD_DEFAULTS } from './catalog.js';
import { thresholdsOf } from './judge.js';
import { runInspectOnce, inspectTargets } from './runner.js';
import { requestInspect } from './requests.js';
import { buildInspectModel, buildTopNodes, inspectDevices } from './view.js';
import { REPORT_KIND, buildReportModel, renderReportHtml, reportMailParts } from './report.js';
import { isMockMode, ensureStorageDemo } from '../../mock/demo/storage.js';

export const SETTINGS_DEFAULTS = Object.freeze({ enabled: true, weekday: 1, time: '09:00', mailEnabled: false, mailDelayMin: 30, to: [], corpTo: {}, thresholds: { ...THRESHOLD_DEFAULTS } });
export const TICK_MS = 60_000;
export const LATE_MS = 30 * 60_000;
export const HISTORY_MAX = 20;
const FILE = () => path.join(config.configDir, 'storage-inspect.json');
const STATE_FILE = () => path.join(config.configDir, 'storage-inspect-state.json');
const BOOT_AT = Date.now();
const isEdge = () => !!(config.agent.centralUrl && config.agent.centralToken);
const strMax = (v, n) => String(v ?? '').slice(0, n);
const MAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

/* ── 설정(순수 정규화) ──────────────────────────────────────────────── */
function mails(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(/[,\s;]+/);
  const out = [...new Set(list.map((x) => String(x || '').trim()).filter(Boolean))];
  if (out.some((x) => !MAIL_RE.test(x))) return null;
  return out.slice(0, 20);
}
/** 설정 정규화 — { settings } | { issue }. 없는 키는 prev 를 유지한다. */
export function normalizeSettings(input, prev = SETTINGS_DEFAULTS) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = { ...SETTINGS_DEFAULTS, ...(prev || {}), thresholds: { ...THRESHOLD_DEFAULTS, ...(prev?.thresholds || {}) }, corpTo: { ...(prev?.corpTo || {}) } };
  const bool = (k) => { if (Object.hasOwn(src, k)) out[k] = src[k] === true || src[k] === 'true'; };
  bool('enabled'); bool('mailEnabled');
  if (Object.hasOwn(src, 'weekday')) { const d = numOrNull(src.weekday); if (d == null || !Number.isInteger(d) || d < 1 || d > 7) return { issue: 'weekday 는 1(월) ~ 7(일) 입니다' }; out.weekday = d; }
  if (Object.hasOwn(src, 'time')) { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(src.time || '').trim()); if (!m) return { issue: 'time 은 HH:MM 입니다' }; out.time = `${m[1]}:${m[2]}`; }
  if (Object.hasOwn(src, 'mailDelayMin')) { const n = numOrNull(src.mailDelayMin); if (n == null || n < 10 || n > 360) return { issue: 'mailDelayMin 은 10 ~ 360 분입니다' }; out.mailDelayMin = Math.floor(n); }
  if (Object.hasOwn(src, 'to')) { const m = mails(src.to); if (!m) return { issue: '받는 사람 이메일 형식이 틀렸습니다' }; out.to = m; }
  if (Object.hasOwn(src, 'corpTo')) {
    const c = src.corpTo && typeof src.corpTo === 'object' && !Array.isArray(src.corpTo) ? src.corpTo : null;
    if (!c) return { issue: 'corpTo 는 { 법인 id: [이메일] } 입니다' };
    const next = {};
    for (const [k, v] of Object.entries(c).slice(0, 100)) {
      const key = strMax(k, 64).trim(); if (!key) continue;
      const m = mails(v); if (!m) return { issue: `법인 ${key} 의 이메일 형식이 틀렸습니다` };
      if (m.length) next[key] = m;
    }
    out.corpTo = next;
  }
  if (Object.hasOwn(src, 'thresholds')) out.thresholds = thresholdsOf({ ...out.thresholds, ...(src.thresholds || {}) });
  return { settings: out };
}
/** now 이전(포함)의 마지막 주간 회차(포탈 시각) — weekday 1=월 … 7=일. */
export function weeklySlot({ weekday = 1, time = '09:00' } = {}, now = Date.now(), offsetMin = DAY_OFFSET_MIN) {
  const [hh, mm] = String(time).split(':').map(Number);
  const off = offsetMin * 60_000;
  const local = new Date(now + off);
  const dow = local.getUTCDay() || 7;
  const base = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - (dow - weekday), hh || 0, mm || 0) - off;
  return base > now ? base - 7 * 86_400_000 : base;
}
/** 틱 계획(순수): none · go(slot) · missed(slot, reason down|late) · rebase(시계 되돌림). */
export function planWeekly({ enabled, slot, last, now = Date.now(), bootAt = 0 }) {
  if (!enabled) return { action: 'none' };
  const l = numOrNull(last);
  // 반증 F13: 시계를 조금(8일 이내) 되돌린 것이면 기록을 그대로 둔다 — now 로 낮추면 시계가 다시 회차를 지날 때 이미 돈 회차가 또 돈다.
  //   크게 어긋난 미래 기록(시계가 한때 크게 앞섰던 것)만 지금으로 내린다(그 시각까지 영영 멈추지 않게).
  if (l != null && l > now + 60_000) return l - now <= 8 * 86_400_000 ? { action: 'none' } : { action: 'rebase', last: now };
  if (l != null && slot <= l) return { action: 'none' };
  if (slot > now) return { action: 'none' };
  if (l == null && slot < bootAt - 60_000) return { action: 'init', last: slot }; // 처음 기동(상태 없음) — 지난 회차를 '놓침' 으로 적지 않고 기준만 잡는다
  // 반증 F14: 재시작이 회차 시각에 걸쳐도(자동 업그레이드 등) 유예(LATE_MS) 안이면 돌린다 — 꺼져 있던 회차를 버리는 것은 유예를 넘었을 때만.
  if (now - slot > LATE_MS) return { action: 'missed', slot, reason: slot < bootAt - 60_000 ? 'down' : 'late' };
  return { action: 'go', slot };
}

let _cfg = null; let _loadErr = null;
export function loadSettings() {
  if (_cfg) return _cfg;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    const r = normalizeSettings(raw, SETTINGS_DEFAULTS);
    if (r.issue) throw new Error(r.issue);
    _cfg = { ...r.settings, updatedAt: numOrNull(raw.updatedAt), updatedBy: strMax(raw.updatedBy, 64) }; _loadErr = null;
  } catch (e) {
    if (e?.code !== 'ENOENT') { preserveCorrupt(FILE(), e?.message); _loadErr = { at: Date.now(), reason: safeLoadText(e) }; console.warn(`[storage-inspect] 설정 파일을 읽지 못했습니다(기본값으로 돌고 저장은 거절): ${_loadErr.reason}`); }
    _cfg = { ...SETTINGS_DEFAULTS, thresholds: { ...THRESHOLD_DEFAULTS }, updatedAt: null, updatedBy: '' };
  }
  return _cfg;
}
export const settingsLoadError = () => { loadSettings(); return _loadErr; };
export function saveSettings(input, { by = '' } = {}) {
  loadSettings();
  if (_loadErr) return { issue: '설정 파일을 읽지 못해 저장하지 않았습니다 — 손상본(storage-inspect.json.corrupt.*)을 확인하세요.' };
  const r = normalizeSettings(input, _cfg);
  if (r.issue) return r;
  const next = { ...r.settings, updatedAt: Date.now(), updatedBy: strMax(by, 64) };
  atomicWriteFileSync(FILE(), JSON.stringify(next, null, 2), { mode: 0o600 });
  _cfg = next;
  return { settings: next };
}

/* ── 상태 ─────────────────────────────────────────────────────────── */
let _state = null;
function state() {
  if (_state) return _state;
  registerStateFile(STATE_FILE());
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('형식 오류');
    _state = { lastRunSlot: numOrNull(raw.lastRunSlot), lastMailSlot: numOrNull(raw.lastMailSlot), history: (Array.isArray(raw.history) ? raw.history : []).slice(0, HISTORY_MAX) };
  } catch (e) {
    if (e?.code !== 'ENOENT') { preserveCorrupt(STATE_FILE(), e?.message); console.warn(`[storage-inspect] 상태 파일을 읽지 못해 새로 시작합니다: ${safeLoadText(e, 160)}`); }
    _state = { lastRunSlot: null, lastMailSlot: null, history: [] };
  }
  return _state;
}
function saveState() { try { atomicWriteFileSync(STATE_FILE(), JSON.stringify(state()), { mode: 0o600 }); } catch (e) { console.warn(`[storage-inspect] 상태 파일을 저장하지 못했습니다: ${strMax(e?.message, 160)}`); } }
function record(entry) { const st = state(); const e = { at: Date.now(), ...entry }; st.history = [e, ...st.history].slice(0, HISTORY_MAX); saveState(); return e; }

/* ── 점검 시작(회차 · 지금 점검 공용) ──────────────────────────────── */
/**
 * 점검 시작 — 이 노드 몫은 바로 돌리고(기다리지 않는다), 위임 장비는 요청 큐에. ids 를 주면 그 장비만.
 * @returns {{ local:number, queued:number, unknown:string[] }}
 */
export function startInspection({ ids = null, reason = 'manual' } = {}) {
  const want = ids ? new Set(ids.map(String)) : null;
  const all = inspectDevices().filter((d) => !want || want.has(String(d.id)));
  const localIds = new Set(inspectTargets().map((d) => String(d.id)));
  const local = []; let queued = 0;
  for (const d of all) {
    if (localIds.has(String(d.id))) local.push(String(d.id));
    else if (d.agent && !isEdge()) { requestInspect(d.id, d.agent); queued += 1; }
  }
  const unknown = want ? [...want].filter((id) => !all.some((d) => String(d.id) === id)) : [];
  if (local.length) runInspectOnce({ ids: local, reason }).catch((e) => console.warn(`[storage-inspect] 점검 실행 실패: ${strMax(e?.message, 160)}`));
  return { local: local.length, queued, unknown };
}

/* ── 보고서 · 메일 ───────────────────────────────────────────────── */
/** 보고서(모델 + HTML) — 메일은 관리자가 아닌 사람도 받는다(주소 가림 판본). 장비 호출 0. */
/** 법인판 장비 거름(법인 키 = 등록부 datacenterId · 빈 값은 '법인 미지정' 판) — corp 가 없으면 받은 filter 그대로. */
export function corpFilterOf(corp, filter = null, devices = null) {
  if (corp == null) return filter;
  const mine = new Set((devices || inspectDevices()).filter((d) => String(d?.datacenterId || '') === String(corp)).map((d) => String(d.id)));
  return (id) => mine.has(String(id)) && (!filter || filter(id));
}
export async function buildReport({ now = Date.now(), corp = null, admin = false, filter = null } = {}) {
  const cfg = loadSettings();
  const model = await buildInspectModel({ now, admin, thresholds: cfg.thresholds, filter });
  // 반증 F5: 법인판의 Top 10 은 **그 법인 노드만으로** 다시 줄 세운다 — 전 법인 Top 10 을 거르면 상위가 몰린 다른 법인에 밀려 '표본이 없습니다' 가 나왔다.
  const top = await buildTopNodes({ range: '7d', metric: 'ops', limit: 10, admin, now, thresholds: cfg.thresholds, filter: corpFilterOf(corp, filter) });
  const rm = buildReportModel(model, top, { now, corp });
  return { model: rm, html: renderReportHtml(rm), parts: reportMailParts(rm) };
}
const recipientsOf = (cfg) => { if (cfg.to?.length) return cfg.to; try { return loadMailCfg().defaultTo || []; } catch { return []; } };
let _chain = Promise.resolve();
const serial = (fn) => { const p = _chain.then(fn, fn); _chain = p.catch(() => {}); return p; };
/** 보내기 — 전체판 + 법인판(corpTo). 결과 요약을 기록한다(무음 금지). */
export function sendReport({ slot = null, manual = false, by = 'system', now = Date.now() } = {}) {
  return serial(async () => {
    const kind = manual ? 'manual' : 'schedule';
    try {
      if (isEdge()) return { ok: false, state: 'edge', reason: '엣지는 이 메일을 보내지 않습니다(메인만 보냅니다).' };
      if (settingsLoadError()) return { ok: false, state: 'skipped', ...record({ type: 'mail', slot, kind, state: 'skipped', code: 'unreadable', reason: '설정 파일을 읽지 못해 보내지 않았습니다.' }) };
      const cfg = loadSettings();
      const jobs = [];
      const to = recipientsOf(cfg);
      if (to.length) jobs.push({ corp: null, to });
      for (const [corp, list] of Object.entries(cfg.corpTo || {})) if (list?.length) jobs.push({ corp, to: list });
      if (!jobs.length) return { ok: false, state: 'skipped', ...record({ type: 'mail', slot, kind, state: 'skipped', code: 'no-recipients', reason: "받는 사람이 없습니다 — 점검 설정의 '받는 사람' 또는 메일 설정의 기본 수신자를 넣으세요." }) };
      const results = [];
      for (const j of jobs) {
        const b = await buildReport({ now, corp: j.corp });
        if (!b.model.devices.length) { results.push({ corp: j.corp, state: 'skipped', reason: '그 법인 장비가 없습니다' }); continue; }
        const attachments = [{ filename: b.parts.filename, contentType: 'text/html', content: Buffer.from(b.html, 'utf8') }];
        const r = await sendPortalMail({ kind: REPORT_KIND, subject: b.parts.subject, html: b.parts.html, text: b.parts.text, to: j.to, by: manual ? (by || 'admin') : 'system', attachments });
        results.push({ corp: j.corp, state: r.ok ? 'sent' : r.skipped ? 'skipped' : 'failed', to: j.to.length, ...(r.ok ? {} : { reason: strMax(r.reason || '보내지 못했습니다', 160) }) });
      }
      const sent = results.filter((r) => r.state === 'sent').length;
      const st = sent === results.length ? 'sent' : sent ? 'partial' : results.every((r) => r.state === 'skipped') ? 'skipped' : 'failed';
      return { ok: sent > 0, state: st, ...record({ type: 'mail', slot, kind, state: st, sent, jobs: results.length, results: results.slice(0, 20) }) };
    } catch (e) {
      console.warn(`[storage-inspect] 보고서를 만들지 못했습니다: ${e?.message || e}`);
      return { ok: false, state: 'failed', ...record({ type: 'mail', slot, kind, state: 'failed', reason: `만들지 못했습니다: ${strMax(e?.message || e, 200)}` }) };
    }
  });
}
export function sendReportNow(by = 'admin', now = Date.now()) { return sendReport({ slot: null, manual: true, by, now }); }

/* ── 틱 ──────────────────────────────────────────────────────────── */
let _timer = null; let _busy = false; let _lastTick = null; let _bootRun = null;
export async function inspectTick(now = Date.now()) {
  if (isEdge()) return { action: 'edge' };
  if (_busy) return { action: 'busy' };
  _busy = true;
  try {
    if (settingsLoadError()) return { action: 'unreadable' };
    const cfg = loadSettings();
    const st = state();
    const slot = weeklySlot(cfg, now);
    const run = planWeekly({ enabled: cfg.enabled, slot, last: st.lastRunSlot, now, bootAt: BOOT_AT });
    if (run.action === 'rebase' || run.action === 'init') { st.lastRunSlot = run.last; saveState(); }
    else if (run.action === 'missed') { st.lastRunSlot = run.slot; record({ type: 'run', slot: run.slot, kind: 'schedule', state: 'missed', code: run.reason, reason: run.reason === 'down' ? '포탈이 꺼져 있던 회차라 점검하지 않았습니다(몰아서 돌리지 않습니다).' : '회차 시각을 30분 넘게 지나 점검하지 않았습니다.' }); }
    else if (run.action === 'go') { st.lastRunSlot = run.slot; saveState(); const r = startInspection({ reason: 'schedule' }); record({ type: 'run', slot: run.slot, kind: 'schedule', state: 'started', local: r.local, queued: r.queued }); }
    const mslot = slot + (cfg.mailDelayMin || 30) * 60_000;
    const mail = planWeekly({ enabled: cfg.enabled && cfg.mailEnabled, slot: mslot <= now ? mslot : mslot - 7 * 86_400_000, last: st.lastMailSlot, now, bootAt: BOOT_AT });
    if (mail.action === 'rebase' || mail.action === 'init') { st.lastMailSlot = mail.last; saveState(); }
    else if (mail.action === 'missed') { st.lastMailSlot = mail.slot; record({ type: 'mail', slot: mail.slot, kind: 'schedule', state: 'missed', code: mail.reason, reason: mail.reason === 'down' ? '포탈이 꺼져 있던 회차라 보내지 않았습니다.' : '회차 시각을 30분 넘게 지나 보내지 않았습니다.' }); }
    else if (mail.action === 'go') { st.lastMailSlot = mail.slot; saveState(); await sendReport({ slot: mail.slot, now }); }
    _lastTick = { at: now, run: run.action, mail: mail.action };
    return _lastTick;
  } catch (e) { console.warn(`[storage-inspect] 틱 실패: ${e?.message || e}`); return { action: 'error', error: strMax(e?.message || e, 200) }; }
  finally { _busy = false; }
}
export function startInspectScheduler() {
  if (_timer || isEdge()) return;
  _timer = setInterval(() => { inspectTick().catch(() => {}); }, TICK_MS);
  _timer.unref?.();
  // 데모(mock) 는 기동 뒤 한 번 돌려 화면이 비지 않게(live 는 회차 · '지금 점검' 에서만 — 업그레이드 직후 전 법인 장비에 명령을 보내지 않는다).
  //   데모 장비 시드(ensureStorageDemo — 스토리지 폴러 첫 주기가 부른다)보다 먼저 돌면 0대로 끝난다 — 시드를 먼저 기다린다(멱등).
  if (isMockMode()) {
    _bootRun = setTimeout(() => {
      Promise.resolve().then(() => ensureStorageDemo()).catch(() => {})
        .then(() => runInspectOnce({ reason: 'demo-boot' })).catch(() => {});
    }, 20_000);
    _bootRun.unref?.();
  }
}
export function inspectScheduleStatus(now = Date.now()) {
  const cfg = loadSettings();
  const st = state();
  const next = cfg.enabled ? weeklySlot(cfg, now) + 7 * 86_400_000 : null;
  return { settings: cfg, loadError: _loadErr, lastRunSlot: st.lastRunSlot, lastMailSlot: st.lastMailSlot, history: st.history, lastTick: _lastTick, edge: isEdge(),
    nextRunAt: next, nextMailAt: cfg.enabled && cfg.mailEnabled && next ? next + (cfg.mailDelayMin || 30) * 60_000 : null };
}
export function _resetScheduleForTest() { _cfg = null; _loadErr = null; _state = null; if (_timer) clearInterval(_timer); _timer = null; _busy = false; _lastTick = null; _chain = Promise.resolve(); }
