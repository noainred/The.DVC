/**
 * ipam/report.js — IP 관리 정기 보고(IPMS 알람) 설정 · 상태 · 틱 · 발송 · 미리 보기(v3.7.0 재설계 묶음 라 — 설계 docs/design/ipam-redesign ⑫ ⑬).
 * 규칙은 reportRules.js(순수), 내용 · 본문은 reportModel.js(순수). 메일은 공용 경로(sendPortalMail kind 'ipam-report' — SMTP · 속도 제한 · 이력 · 감사 공용).
 * 중앙 전용(엣지는 보내지 않는다). 데모(mock) 법인은 실제 메일에 넣지 않는다(미리 보기에는 넣고 밝힌다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';
import { sendPortalMail } from '../mail/service.js';
import { load as loadMailCfg } from '../mail/settings.js';
import { store } from '../store.js';
import { isMockVcenter } from '../mock/generator.js';
import { listDatacenters, getDatacenterAssign } from '../datacenter/store.js';
import { buildIpamRows, listSubnets } from './ledger.js';
import { listChanges } from './changeLog.js';
import { listScanAgents, loadScanSettings, getAgentReports, LOCAL } from './scanStore.js';
import { scanDatacenterOf } from './scanDatacenterSource.js';
import { reportOf, normalizeReport, planReportTick, nextReportSlots, corpOffsetMin, periodMsOf } from './reportRules.js';
import { buildReportModel, renderCorpMail, renderOverallMail } from './reportModel.js';
import { DAY_OFFSET_MIN } from '../util/dayKey.js';

export const MAIL_KIND = 'ipam-report';
export const REPORT_TICK_MS = 30_000;
const HISTORY_MAX = 40;
const SETTINGS_FILE = () => path.join(config.configDir, 'ipam-report.json');
const STATE_FILE = () => path.join(config.configDir, 'ipam-report-state.json');
registerStateFile('ipam-report-state.json');
const BOOT_AT = Date.now();
const isEdge = () => !!(config.agent.centralUrl && config.agent.centralToken);
const FREQ_LABEL = { weekly: '주간', daily: '일간' };
const MISSED_TEXT = { down: '포탈이 꺼져 있던 동안의 회차라 보내지 않았습니다(몰아서 보내지 않습니다).', late: '정한 시각보다 30분 넘게 늦게 확인해 보내지 않았습니다(몰아서 보내지 않습니다).' };

let _settingsErr = null;
/** 설정(못 읽었으면 null — 기본값으로 보내지 않는다). */
export function loadReportSettings() {
  try { _settingsErr = null; return reportOf(JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'))); }
  catch (e) {
    if (e?.code === 'ENOENT') return reportOf(null);
    if (!_settingsErr) { preserveCorrupt(SETTINGS_FILE(), e?.message); console.warn(`[ipam-report] 설정 파일을 읽지 못했습니다: ${safeLoadText(e) || '사유 미상'}`); }
    _settingsErr = { at: Date.now(), reason: safeLoadText(e) || '형식 오류' };
    return null;
  }
}
export function reportSettingsError() { loadReportSettings(); return _settingsErr; }
/** 저장 — 정규화 실패는 { error, field }. */
export function saveReportSettings(input, now = Date.now()) {
  const prev = loadReportSettings();
  if (prev == null) return { error: '설정 파일을 읽지 못해 저장하지 않았습니다(손상본은 옆에 보존했습니다).', field: 'report' };
  const r = normalizeReport(input, prev, now);
  if (r.error) return r;
  atomicWriteFileSync(SETTINGS_FILE(), JSON.stringify(r.report, null, 2), { mode: 0o600 });
  _settingsErr = null;
  return r;
}

let _state = null;
function state() {
  if (_state) return _state;
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('형식 오류');
    _state = { overall: raw.overall && typeof raw.overall === 'object' ? raw.overall : {}, corps: raw.corps && typeof raw.corps === 'object' ? raw.corps : {},
      prevOcc: raw.prevOcc && typeof raw.prevOcc === 'object' ? raw.prevOcc : {}, history: (Array.isArray(raw.history) ? raw.history : []).slice(0, HISTORY_MAX) };
  } catch (e) {
    if (e?.code !== 'ENOENT') { preserveCorrupt(STATE_FILE(), e?.message); console.warn(`[ipam-report] 상태 파일을 읽지 못해 새로 시작합니다: ${safeLoadText(e) || '사유 미상'}`); }
    _state = { overall: {}, corps: {}, prevOcc: {}, history: [] };
  }
  return _state;
}
function save() { try { atomicWriteFileSync(STATE_FILE(), JSON.stringify(state()), { mode: 0o600 }); } catch (e) { console.warn(`[ipam-report] 상태 저장 실패: ${e?.message || e}`); } }
function record(entry) {
  const st = state();
  const e = { at: Date.now(), ...entry };
  st.history.unshift(e); st.history.length = Math.min(st.history.length, HISTORY_MAX);
  save();
  return e;
}

/** 보고 입력을 모은다(장비 왕복 0 — 스냅샷 · 대장 · 기록만). */
export function gatherReportModel(r, now = Date.now()) {
  const snap = store.get();
  const vcName = {}; const mockVc = new Set();
  for (const v of snap.vcenters || []) { vcName[v.id] = v.name || v.id; if (isMockVcenter(v)) mockVc.add(String(v.id)); }
  const subMap = new Map(listSubnets(snap, '', null).map((s) => [s.base, { rsv: s.rsv || 0, dhcp: s.dhcp || 0 }]));
  const agents = listScanAgents();
  if (!agents.some((a) => a.name === LOCAL)) agents.unshift({ name: LOCAL, ...loadScanSettings(LOCAL) });
  let datacenters = []; let assign = {};
  try { datacenters = listDatacenters(); assign = getDatacenterAssign() || {}; } catch { /* 법인 표를 못 읽음 — 행은 '법인 미지정' 으로 */ }
  return buildReportModel({
    rows: buildIpamRows(snap, '', null).rows, assign, datacenters, vcName, changes: listChanges({ limit: 100_000 }).entries, agents, reports: getAgentReports() || {},
    agentDc: (a) => { try { return scanDatacenterOf(a, snap.vcenters)?.datacenterId || ''; } catch { return ''; } }, mockVc, prevOcc: state().prevOcc,
    policyOf: (b) => subMap.get(b), now, periodMs: periodMsOf(r), fullPct: r.fullPct,
  });
}
const adminTo = () => { try { return loadMailCfg().defaultTo || []; } catch { return []; } };
const overallTo = (r) => [...new Set([...(r.includeAdmin ? adminTo() : []), ...r.to].map((x) => String(x).trim()).filter(Boolean))];

let _chain = Promise.resolve();
const serial = (fn) => { const p = _chain.then(fn, fn); _chain = p.catch(() => {}); return p; };

/**
 * 한 회차 발송. target: 'overall' | 'corps'(메인 시각 — 받는 사람을 정한 법인 전부) | 법인 id.
 * @returns {Promise<Array<object>>} 기록 항목들
 */
export function sendReport({ slot, target = 'overall', manual = false, by = 'system', now = Date.now() } = {}) {
  return serial(async () => {
    const out = [];
    const kind = manual ? 'manual' : 'schedule';
    if (isEdge()) return [{ state: 'edge', reason: '엣지는 정기 보고를 보내지 않습니다(메인만 보냅니다).' }];
    const r = loadReportSettings();
    if (!r) return [record({ slot, kind, target, state: 'skipped', code: 'unreadable', reason: '설정 파일을 읽지 못해 보내지 않았습니다.' })];
    let model;
    try { model = gatherReportModel(r, now); } catch (e) { return [record({ slot, kind, target, state: 'failed', reason: `만들지 못했습니다: ${String(e?.message || e).slice(0, 200)}` })]; }
    const real = model.corps.filter((c) => !c.mock);
    const freqLabel = FREQ_LABEL[r.freq] || '정기';
    const send = async (tgt, mail, to) => {
      const res = await sendPortalMail({ kind: MAIL_KIND, subject: mail.subject, html: mail.html, text: mail.text, to, by: manual ? (by || 'admin') : 'system' });
      if (res.ok) return record({ slot, kind, target: tgt, state: 'sent', to: to.length });
      return record({ slot, kind, target: tgt, state: res.skipped ? 'skipped' : 'failed', code: res.skipped ? 'mail-off' : null, reason: res.reason || '보내지 못했습니다', to: to.length });
    };
    if (target === 'overall' || target === 'all') {
      const to = overallTo(r);
      if (!real.length) out.push(record({ slot, kind, target: 'overall', state: 'skipped', code: 'demo-only', reason: '실제 법인이 없어(데모 데이터뿐) 보내지 않았습니다.' }));
      else if (!to.length) out.push(record({ slot, kind, target: 'overall', state: 'skipped', code: 'no-recipients', reason: "전체 종합 받는 사람이 없습니다 — '통합 관리자'(메일 기본 받는 사람)를 고르거나 주소를 넣으세요." }));
      else out.push(await send('overall', renderOverallMail(model, { sections: r.sections, offsetMin: DAY_OFFSET_MIN, freqLabel, corps: real }), to));
    }
    const corpTargets = target === 'corps' || target === 'all' ? real.filter((c) => (r.corps[c.id]?.to || []).length) : target !== 'overall' ? real.filter((c) => c.id === target) : [];
    for (const c of corpTargets) {
      const to = r.corps[c.id]?.to || [];
      if (!to.length) { out.push(record({ slot, kind, target: c.id, state: 'skipped', code: 'no-recipients', reason: `${c.name} 받는 사람이 없어 전체 종합에만 실었습니다.` })); continue; }
      out.push(await send(c.id, renderCorpMail(c, { model, sections: r.sections, offsetMin: corpOffsetMin(r, c.id, now), freqLabel }), to));
    }
    if (!manual) { const st = state(); for (const c of real) st.prevOcc[c.id] = c.occMap; save(); }   // 다음 보고의 '지난 보고 대비'
    return out;
  });
}

let _busy = false; let _timer = null; let _lastTick = null; let _lastError = null;
/** 틱 — 보낼 회차가 있으면 보내고, 놓친 회차는 기록만 한다(던지지 않는다). */
export async function reportTick(now = Date.now()) {
  if (isEdge()) return { action: 'edge' };
  if (_busy) return { action: 'busy' };
  _busy = true;
  try {
    const r = loadReportSettings();
    if (!r || !r.enabled) return { action: 'none' };
    const st = state();
    let corpIds = [];
    try { corpIds = listDatacenters().map((d) => String(d.id)); } catch { corpIds = []; }
    const plan = planReportTick({ report: r, state: st, corpIds, now, bootAt: BOOT_AT });
    _lastTick = { at: now, overall: plan.overall.action };
    const results = [];
    const handle = async (p, keep, target) => {
      if (p.action === 'rebase') { keep.lastSlot = p.lastSlot; save(); return; }
      if (p.action === 'missed') { keep.lastSlot = p.slot; record({ slot: p.slot, kind: 'schedule', target, state: 'missed', code: p.reason, count: p.count, reason: MISSED_TEXT[p.reason] || '보내지 않았습니다.' }); return; }
      if (p.action === 'send') { keep.lastSlot = p.slot; save(); for (const x of await sendReport({ slot: p.slot, target, now })) results.push(x); }
    };
    st.overall = st.overall || {};
    await handle(plan.overall, st.overall, r.clock === 'corp' ? 'overall' : 'all');
    for (const [id, p] of Object.entries(plan.corps)) { st.corps[id] = st.corps[id] || {}; if ((r.corps[id]?.to || []).length) await handle(p, st.corps[id], id); else if (p.action === 'send' || p.action === 'missed') st.corps[id].lastSlot = p.slot; }
    return { ...plan, results };
  } catch (e) {
    _lastError = { at: Date.now(), message: String(e?.message || e).slice(0, 300) };
    console.warn(`[ipam-report] 틱 실패: ${e?.message || e}`);
    return { action: 'error', error: _lastError.message };
  } finally { _busy = false; }
}

/** 미리 보기 — 보내지 않는다. 저장하지 않은 화면 값(input)이 있으면 그 값으로. 데모 법인도 넣고 밝힌다. */
export function previewReport(input = null, now = Date.now()) {
  const base = loadReportSettings() || reportOf(null);
  let r = base;
  if (input && typeof input === 'object') { const n = normalizeReport(input, base, now); if (n.error) return { ok: false, error: n.error, field: n.field }; r = n.report; }
  const model = gatherReportModel(r, now);
  const freqLabel = FREQ_LABEL[r.freq] || '정기';
  const overall = renderOverallMail(model, { sections: r.sections, offsetMin: DAY_OFFSET_MIN, freqLabel, preview: true });
  const corps = model.corps.slice(0, 30).map((c) => ({ id: c.id, name: c.name, mock: c.mock, recipients: (r.corps[c.id]?.to || []).length, ...renderCorpMail(c, { model, sections: r.sections, offsetMin: corpOffsetMin(r, c.id, now), freqLabel, preview: true }) }));
  return { ok: true, overall: { ...overall, recipients: overallTo(r).length }, corps, demoCorps: model.corps.filter((c) => c.mock).length };
}

/** 화면용 상태(주소 없음). */
export function reportStatus(now = Date.now()) {
  const r = loadReportSettings();
  const st = state();
  const corpNext = {};
  if (r?.enabled && r.clock === 'corp') for (const [id, c] of Object.entries(r.corps)) if (c.tz) corpNext[id] = { tz: c.tz, offsetMin: corpOffsetMin(r, id, now) };
  return { enabled: !!r?.enabled, next: r ? nextReportSlots(r, now, 3) : [], corpNext, history: st.history.map((h) => ({ ...h })), busy: _busy, lastTick: _lastTick, lastError: _lastError,
    edge: isEdge(), settingsError: _settingsErr, overallRecipients: r ? overallTo(r).length : 0 };
}

export function startIpamReport() {
  if (_timer || isEdge()) return;
  _timer = setInterval(() => { reportTick().catch(() => {}); }, REPORT_TICK_MS);
  _timer.unref?.();
}
export function _resetIpamReportForTest() { _state = null; _chain = Promise.resolve(); _busy = false; _lastTick = null; _lastError = null; _settingsErr = null; if (_timer) { clearInterval(_timer); _timer = null; } }
