/**
 * isidu/notify.js — 아이실론 디렉터리 사용량 결과 메일(v2.738). 규칙은 `mailRules.js`(순수), 발송은 공용 `sendPortalMail({kind:'isidu'})`.
 *
 * ── 언제 보내는가 ───────────────────────────────────────────────────────────
 *  · **중앙만 보낸다.** 엣지가 조사한 결과는 중앙이 받아 적재한 순간(routes/central.js /isidu-data)에, 중앙이 직접 조사한 결과는
 *    적재한 순간(poller.js)에 `notifyScanStored` 를 부른다. 엣지는 메일 설정을 받지 않는다(settings.edgeTargetView 가 싣지 않는다 —
 *    주소 목록을 28곳에 퍼뜨리지 않는다).
 *  · 조사가 성공할 때마다 보낸다. 대상이 '변화 없으면 생략' 이면 직전 성공 조사와 비교해 메일에 보이는 것(상위 N·전체 합계)이
 *    du -h 해상도 안에서 같으면 보내지 않고 그 사실을 기록한다.
 *  · 실패 알림은 대상이 고른 경우에만, 대상별 6시간에 한 번까지.
 *  · 같은 결과를 두 번 보내지 않는다 — 대상별 마지막으로 다룬 조사(id·시각)를 상태 파일에 남긴다(엣지 재전송·중앙 재시작).
 *    이미 다룬 것보다 오래된 조사(엣지가 밀린 결과를 늦게 보냄)는 보내지 않는다.
 *  · 데모(mock-) 대상은 어떤 모드에서도 실제 메일을 보내지 않는다(v2.708 '데모 데이터로 실제 알림 채널에 보내지 않는다' ·
 *    v2.719 'live 에서는 데모 표지 항목을 실행하지 않는다').
 *  · 결과(보냄·생략·실패·사유)는 대상별로 남기고 화면이 말한다 — 조용히 빼지 않는다. 주소는 남기지 않는다(개수만).
 *  · 발송은 한 줄로 묶는다(동시에 여러 대상이 끝나도 릴레이에 한 번에 하나씩).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';
import { localStamp } from '../util/dayKey.js';
import { sendPortalMail } from '../mail/service.js';
import { load as loadMailCfg } from '../mail/settings.js';
import { resolveRecipients } from '../mail/kinds.js';
import { loadSettings } from './settings.js';
import { buildReport } from './report.js';
import * as db from './db.js';
import { HISTORY_AGENT } from './targets.js';
import { targetMailOf, mailRecipients, changeSummary, failAlertDue, FAIL_ALERT_MIN_MS } from './mailRules.js';

registerStateFile('isidu-mail-state.json');
const FILE = () => path.join(config.configDir, 'isidu-mail-state.json');   // ⚠ 리터럴 형태 유지 — scripts/config-doc.mjs 가 이 모양으로 찾는다
const STATE_MAX = 200;
export const MAIL_KIND = 'isidu';

const isEdge = () => !!(config.agent.centralUrl && config.agent.centralToken);

let _state = null; // { targets: { [id]: { lastScanId, lastScanTs, lastFailAlertAt, last } } }
function state() {
  if (_state) return _state;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    _state = { targets: raw && typeof raw.targets === 'object' && !Array.isArray(raw.targets) ? raw.targets : {} };
  } catch (e) {
    if (e?.code !== 'ENOENT') { preserveCorrupt(FILE(), e?.message); console.warn(`[isidu-mail] 상태 파일을 읽지 못해 새로 시작합니다(같은 결과를 한 번 더 보낼 수 있습니다): ${e?.message}`); }
    _state = { targets: {} };
  }
  return _state;
}
function save() {
  const st = state();
  const ids = Object.keys(st.targets);
  if (ids.length > STATE_MAX) for (const id of ids.slice(0, ids.length - STATE_MAX)) delete st.targets[id];
  try { atomicWriteFileSync(FILE(), JSON.stringify(st), { mode: 0o600 }); }
  catch (e) { console.warn(`[isidu-mail] 상태 파일을 저장하지 못했습니다(메모리로 계속): ${e.message}`); }
}
function rec(id) { const st = state(); if (!st.targets[id] || typeof st.targets[id] !== 'object') st.targets[id] = {}; return st.targets[id]; }
function note(id, last) {
  const st = state(); const r = rec(id);
  r.last = { at: Date.now(), ...last };
  delete st.targets[id]; st.targets[id] = r;   // 맨 뒤로 — 상한(STATE_MAX)은 오래 쓰지 않은 대상부터 지운다
  save(); return r.last;
}

/**
 * 지금 메일을 보낼 수 있는 상태인가(화면 안내용) — 전역 메일 켜짐·SMTP 서버·'아이실론 디렉터리 사용량' 종류 켜짐.
 * 판정은 공용 `resolveRecipients` 하나다(받는 사람은 이 기능이 정하므로 자리 표시 주소를 넘긴다 — 실제로 보내지 않는다).
 */
export function isiduMailReady() {
  try {
    const r = resolveRecipients(loadMailCfg(), MAIL_KIND, ['probe@example.invalid']);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  } catch (e) { return { ok: false, reason: `메일 설정을 읽지 못했습니다(${e.message})` }; }
}

/** 대상별 마지막 메일 결과(화면용 — 주소 없음). */
export function isiduMailStateOf(id) {
  const r = state().targets[String(id || '')];
  return r?.last ? { ...r.last } : null;
}

// ── 본문 ──────────────────────────────────────────────────────────────────
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
export function bytesText(b) {
  if (b == null || !Number.isFinite(b)) return '—';
  let v = Math.abs(b); let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
  return `${b < 0 ? '−' : ''}${i === 0 ? v.toFixed(0) : v.toFixed(v >= 100 ? 0 : 1)} ${UNITS[i]}`;
}
export function deltaText(d) {
  if (!d) return '—';
  if (d.withinRes) return '변화 없음(반올림 범위)';
  return `${d.bytes > 0 ? '+' : ''}${bytesText(d.bytes)}`;
}
const pct = (x) => (x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(1)}%`);

function nameOf(t) { return t.label || t.path || t.id; }

/** 결과 메일 본문(순수 — 테스트로 고정). */
export function buildResultMail(t, report, { change = null } = {}) {
  const s = report.scan;
  const k = report.kpi || {};
  const when = localStamp(s.ts) || '—';
  const label = nameOf(t);
  const subject = `[아이실론 디렉터리 사용량] ${label} — ${when} · 폴더 ${(k.users ?? 0).toLocaleString()}개 · 상위 ${k.topN ?? 0}개 ${bytesText(k.topBytes)}`.slice(0, 200);
  const base7 = report.base7 ? `7일 변화 기준: ${localStamp(report.base7.ts) || '—'} 조사(${report.base7.spanDays}일 전)` : '7일 변화: 7일 이전 조사가 없어 비교하지 않았습니다';
  const notes = [];
  if (s.errLines) notes.push(`du 가 권한 오류 ${s.errLines}줄을 냈습니다 — 크기가 실제보다 작을 수 있습니다.`);
  if (s.truncated) notes.push('폴더가 많아 일부만 저장했습니다(상한).');
  if (s.sizeMode !== 'k') notes.push('크기는 du -h 반올림 값입니다 — 반올림 범위 안의 차이는 변화로 보지 않습니다.');
  if (change && !change.first && change.reasons?.length) notes.push(`직전 조사 대비: ${change.reasons.join(' · ')}`);
  const rows = (report.top || []).map((r) => ({ rank: r.rank, name: r.name, size: bytesText(r.bytes), share: pct(r.share), d7: r.new7 === true ? '신규' : deltaText(r.d7) }));
  const growth = (report.growth || []).slice(0, 5).map((r) => ({ name: r.name, d7: deltaText(r.d7), size: bytesText(r.bytes) }));
  const head = [
    ['경로', s.path], ['장비', s.host || '—'], ['조사 노드', s.node || '메인'], ['조사 시각', when], ['소요', `${Math.round((s.durationMs || 0) / 1000)}초`],
    ['전체 합계', `${bytesText(k.denomBytes)}${k.totalDelta7 ? ` (7일 ${deltaText(k.totalDelta7)})` : ''}`],
    ['폴더 수', `${(k.users ?? 0).toLocaleString()}개${k.new7 != null ? ` · 7일 신규 ${k.new7}개` : ''}${k.removed7 != null ? ` · 사라짐 ${k.removed7}개` : ''}`],
  ];
  const td = 'style="padding:4px 8px;border-bottom:1px solid #ddd"';
  const html = [
    `<div style="font-family:sans-serif;font-size:13px;color:#222">`,
    `<h3 style="margin:0 0 8px">${esc(label)} — 디렉터리 사용량 상위 ${esc(k.topN ?? 0)}개</h3>`,
    `<table style="border-collapse:collapse;margin-bottom:10px">${head.map(([a, b]) => `<tr><td ${td}><b>${esc(a)}</b></td><td ${td}>${esc(b)}</td></tr>`).join('')}</table>`,
    `<table style="border-collapse:collapse"><tr><th ${td}>순위</th><th ${td} align="left">폴더</th><th ${td} align="right">크기</th><th ${td} align="right">비중</th><th ${td} align="right">7일 변화</th></tr>`,
    rows.map((r) => `<tr><td ${td} align="right">${r.rank}</td><td ${td}>${esc(r.name)}</td><td ${td} align="right">${esc(r.size)}</td><td ${td} align="right">${esc(r.share)}</td><td ${td} align="right">${esc(r.d7)}</td></tr>`).join(''),
    `</table>`,
    growth.length ? `<p style="margin:10px 0 4px"><b>7일 증가 상위</b></p><ul style="margin:0">${growth.map((g) => `<li>${esc(g.name)} — ${esc(g.d7)} (지금 ${esc(g.size)})</li>`).join('')}</ul>` : '',
    `<p style="color:#666;margin-top:10px">${esc(base7)}</p>`,
    notes.length ? `<ul style="color:#666">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '',
    `<p style="color:#999">이 메일은 포탈의 특수 기능 › 아이실론 디렉터리 사용량에서 보냈습니다. 수신자는 수집 대상 설정의 '결과 메일' 에서 바꿉니다.</p>`,
    `</div>`,
  ].join('');
  const text = [
    `${label} — 디렉터리 사용량 상위 ${k.topN ?? 0}개`,
    ...head.map(([a, b]) => `${a}: ${b}`),
    '',
    ...rows.map((r) => `${String(r.rank).padStart(2)}. ${r.name} — ${r.size} (${r.share}, 7일 ${r.d7})`),
    ...(growth.length ? ['', '7일 증가 상위:', ...growth.map((g) => `- ${g.name} ${g.d7} (지금 ${g.size})`)] : []),
    '', base7, ...notes.map((n) => `* ${n}`),
  ].join('\n');
  return { subject, html, text };
}

/** 실패 알림 본문(순수). */
export function buildFailureMail(t, scan, { failStreak = 0, lastOk = null } = {}) {
  const label = nameOf(t);
  const when = localStamp(scan.ts) || '—';
  const subject = `[아이실론 디렉터리 사용량] 조사 실패 — ${label} (${when})`.slice(0, 200);
  const lines = [
    ['경로', scan.path || t.path || '—'], ['장비', scan.host || t.host || '—'], ['조사 노드', scan.node || '메인'], ['시각', when],
    ['종류', scan.kind || 'error'], ['사유', scan.error || '—'], ['연속 실패', `${failStreak || 1}회`],
    ['마지막 성공', lastOk ? (localStamp(lastOk) || '—') : '없음'],
  ];
  const td = 'style="padding:4px 8px;border-bottom:1px solid #ddd"';
  const tail = `다음 실패 알림은 ${Math.round(FAIL_ALERT_MIN_MS / 3_600_000)}시간 뒤에야 보냅니다(같은 대상).`;
  const html = `<div style="font-family:sans-serif;font-size:13px;color:#222"><h3 style="margin:0 0 8px">${esc(label)} — 디렉터리 사용량 조사 실패</h3>`
    + `<table style="border-collapse:collapse">${lines.map(([a, b]) => `<tr><td ${td}><b>${esc(a)}</b></td><td ${td}>${esc(b)}</td></tr>`).join('')}</table>`
    + `<p style="color:#666">${esc(tail)}</p></div>`;
  const text = [`${label} — 디렉터리 사용량 조사 실패`, ...lines.map(([a, b]) => `${a}: ${b}`), '', tail].join('\n');
  return { subject, html, text };
}

// ── 발송 ──────────────────────────────────────────────────────────────────
let _chain = Promise.resolve();
const serial = (fn) => { const p = _chain.then(fn, fn); _chain = p.catch(() => {}); return p; };

function targetById(id) {
  const s = loadSettings();
  return { s, t: s.targets.find((x) => x.id === id) || null };
}

async function sendTo(t, to, mail, by) {
  const r = await sendPortalMail({ kind: MAIL_KIND, subject: mail.subject, html: mail.html, text: mail.text, to, by });
  if (r.ok) return { state: 'sent', accepted: Array.isArray(r.accepted) ? r.accepted.length : to.length };
  return { state: r.skipped ? 'skipped' : 'failed', reason: String(r.reason || '보내지 못했습니다').slice(0, 300), ...(r.authStopped ? { authStopped: true } : {}) };
}

/**
 * 조사 결과가 적재됐다 — 메일을 보낼지 판정하고 보낸다(던지지 않는다).
 * @param {{targetId:string, scanId:number|null, ok:boolean, ts:number}} ev
 */
export function notifyScanStored(ev) {
  if (isEdge()) return Promise.resolve({ state: 'edge' });
  return serial(() => notifyInner(ev)).catch((e) => { console.warn(`[isidu-mail] ${ev?.targetId}: ${e.message}`); return { state: 'failed', reason: e.message }; });
}

async function notifyInner({ targetId, scanId, ok, ts }) {
  const id = String(targetId || '');
  const { s, t } = targetById(id);
  if (!t) return { state: 'gone' };
  const tm = targetMailOf(t);
  const rcpt = mailRecipients(s.mail?.commonTo, tm);
  if (!rcpt.to.length) return { state: 'no-recipients' };              // 메일을 고르지 않은 대상 — 기록하지 않는다
  const r = rec(id);
  const sid = Number(scanId);
  const sts = Number(ts);
  if (Number.isFinite(sid) && Number(r.lastScanId) === sid) return { state: 'duplicate' };
  if (Number.isFinite(sts) && Number.isFinite(Number(r.lastScanTs)) && sts < Number(r.lastScanTs)) {
    return { state: 'older', last: note(id, { kind: ok ? 'result' : 'failure', scanId: sid, scanTs: sts, state: 'skipped', reason: '이미 메일을 보낸 조사보다 오래된 결과라 보내지 않았습니다(엣지가 밀린 결과를 늦게 보냄)' }) };
  }
  r.lastScanId = Number.isFinite(sid) ? sid : r.lastScanId; r.lastScanTs = Number.isFinite(sts) ? sts : r.lastScanTs;
  if (String(id).startsWith('mock-')) return { state: 'demo', last: note(id, { kind: ok ? 'result' : 'failure', scanId: sid, scanTs: sts, state: 'skipped', reason: '데모 대상은 실제 메일을 보내지 않습니다' }) };

  if (!ok) {
    if (!tm.onFailure) { save(); return { state: 'no-failure-alert' }; }
    const now = Date.now();
    if (!failAlertDue(r.lastFailAlertAt, now)) {
      return { state: 'throttled', last: note(id, { kind: 'failure', scanId: sid, scanTs: sts, state: 'skipped', reason: `실패 알림은 ${Math.round(FAIL_ALERT_MIN_MS / 3_600_000)}시간에 한 번까지입니다(직전 ${localStamp(r.lastFailAlertAt) || '—'})` }) };
    }
    const latest = await db.latestOf(HISTORY_AGENT, id);
    const scan = latest?.lastTry && (latest.lastTry.id === sid || !Number.isFinite(sid)) ? latest.lastTry : { ts: sts, path: t.path, host: t.host, kind: 'error', error: '사유를 읽지 못했습니다' };
    const mail = buildFailureMail(t, scan, { failStreak: latest?.failStreak || 0, lastOk: latest?.okScan?.ts || null });
    const out = await sendTo(t, rcpt.to, mail, 'system');
    if (out.state === 'sent') r.lastFailAlertAt = now;
    return { state: out.state, last: note(id, { kind: 'failure', scanId: sid, scanTs: sts, to: rcpt.to.length, ...out }) };
  }

  const report = await buildReport(id, { topN: t.topN });
  if (report.state !== 'ok') return { state: 'no-report', last: note(id, { kind: 'result', scanId: sid, scanTs: sts, state: 'failed', reason: `결과를 읽지 못했습니다(${report.state})` }) };
  if (Number.isFinite(sid) && report.scan.id !== sid) {
    return { state: 'not-latest', last: note(id, { kind: 'result', scanId: sid, scanTs: sts, state: 'skipped', reason: '더 새 조사 결과가 있어 이 결과는 보내지 않았습니다' }) };
  }
  let change = null;
  if (tm.onlyOnChange) {
    change = await changeVsPrevious(id, report, t.topN);
    if (!change.changed) return { state: 'unchanged', last: note(id, { kind: 'result', scanId: sid, scanTs: sts, state: 'skipped', reason: '직전 조사와 상위 폴더·전체 합계가 반올림 범위 안에서 같아 보내지 않았습니다(변화 없으면 생략)' }) };
  }
  const mail = buildResultMail(t, report, { change });
  const out = await sendTo(t, rcpt.to, mail, 'system');
  return { state: out.state, last: note(id, { kind: 'result', scanId: sid, scanTs: sts, to: rcpt.to.length, ...out }) };
}

async function changeVsPrevious(id, report, topN) {
  const prev = await db.okScanBefore(HISTORY_AGENT, id, report.scan.ts);
  if (!prev) return changeSummary(null, null, topN);
  const entries = await db.entriesOf(prev.id);
  const cur = { rows: (report.top || []).map((r) => ({ name: r.name, bytes: r.bytes, res: r.res })), total: totalOf(report.scan) };
  return changeSummary(cur, { entries, total: totalOf(prev) }, topN);
}
function totalOf(scan) {
  if (scan?.total && Number.isFinite(scan.total.bytes)) return { bytes: scan.total.bytes, res: scan.total.res };
  if (Number.isFinite(scan?.sumBytes)) return { bytes: scan.sumBytes, res: scan.sumRes };
  return null;
}

/**
 * 지금 보내기(사람이 누름) — 마지막 성공 결과를 그 대상의 수신자에게. '변화 없으면 생략' 은 보지 않는다.
 * @returns {Promise<{ok:boolean, state:string, reason?:string, to?:number, accepted?:number}>}
 */
export function sendLatestNow(targetId, by = 'system') {
  return serial(async () => {
    const id = String(targetId || '');
    const { s, t } = targetById(id);
    if (!t) return { ok: false, state: 'gone', reason: '대상을 찾지 못했습니다.' };
    const rcpt = mailRecipients(s.mail?.commonTo, targetMailOf(t));
    if (!rcpt.to.length) return { ok: false, state: 'no-recipients', reason: '받는 사람이 없습니다 — 공통 수신자나 이 대상의 수신자를 넣고 저장하세요.' };
    if (String(id).startsWith('mock-')) return { ok: false, state: 'demo', reason: '데모 대상은 실제 메일을 보내지 않습니다.' };
    const report = await buildReport(id, { topN: t.topN });
    if (report.state !== 'ok') return { ok: false, state: 'no-report', reason: '보낼 성공 결과가 없습니다(먼저 조사를 한 번 실행하세요).' };
    const out = await sendTo(t, rcpt.to, buildResultMail(t, report), by);
    const last = note(id, { kind: 'result', scanId: report.scan.id, scanTs: report.scan.ts, to: rcpt.to.length, manual: true, ...out });
    return { ok: out.state === 'sent', ...last };
  });
}

export function _resetForTest() { _state = null; _chain = Promise.resolve(); }
