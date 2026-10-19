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
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
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
import { renderResultMail, renderFailureMail, bytesText, deltaText } from './mailHtml.js';
import { corpNameOf } from './corpName.js';

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
    if (e?.code !== 'ENOENT') { preserveCorrupt(FILE(), e?.message); console.warn(`[isidu-mail] 상태 파일을 읽지 못해 새로 시작합니다(같은 결과를 한 번 더 보낼 수 있습니다): ${safeLoadText(e) || '사유 미상'}`); }
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
// v2.742: 본문은 `mailHtml.js`(시안 ③④ — 표 기반 · 인라인 스타일)가 그린다. 이 두 함수는 예전 이름·인자를 유지한다(테스트·호출부 호환).
export { bytesText, deltaText };

function nameOf(t) { return t.label || t.path || t.id; }

/** 결과 메일 본문(순수 — 테스트로 고정). */
export function buildResultMail(t, report, { change = null, corp = '', recipients = null, now = Date.now() } = {}) {
  return renderResultMail({ label: nameOf(t), corp, report, change, recipients, onlyOnChange: targetMailOf(t).onlyOnChange, now });
}

/** 실패 알림 본문(순수). lastOk 는 시각(옛 호출) 또는 { ts, bytes }. */
export function buildFailureMail(t, scan, { failStreak = 0, lastOk = null, firstFailTs = null, corp = '', authStopped = null, now = Date.now() } = {}) {
  const lo = lastOk == null ? null : (typeof lastOk === 'object' ? lastOk : { ts: lastOk, bytes: null });
  return renderFailureMail({ label: nameOf(t), corp, scan, target: t, failStreak, firstFailTs, lastOk: lo, authStopped, failAlertHours: Math.round(FAIL_ALERT_MIN_MS / 3_600_000), now });
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
    const ok = latest?.okScan || null;
    const firstFailTs = await firstFailureAfter(id, ok?.ts ?? null).catch(() => null);
    const mail = buildFailureMail(t, scan, { failStreak: latest?.failStreak || 0, lastOk: ok ? { ts: ok.ts, bytes: totalOf(ok)?.bytes ?? null } : null, firstFailTs, corp: corpNameOf(t) });
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
  } else {
    // v2.742: 본문의 '직전 조사 대비' 알림용 — 판정에는 쓰지 않으므로 실패해도 메일은 보낸다.
    try { change = await changeVsPrevious(id, report, t.topN); } catch { change = null; }
  }
  const mail = buildResultMail(t, report, { change, corp: corpNameOf(t), recipients: rcpt });
  const out = await sendTo(t, rcpt.to, mail, 'system');
  return { state: out.state, last: note(id, { kind: 'result', scanId: sid, scanTs: sts, to: rcpt.to.length, ...out }) };
}

async function changeVsPrevious(id, report, topN) {
  const prev = await db.okScanBefore(HISTORY_AGENT, id, report.scan.ts);
  if (!prev) return changeSummary(null, null, topN);
  // v2.740 E-03: 직전 스캔의 폴더 전체(최대 5만 행)를 읽지 않는다 — 비교에 필요한 것은 직전 상위 N 개와 지금 상위 폴더의 직전 크기뿐이다.
  // changeSummary 는 받은 맵에서 직전 상위 N 을 다시 고르는데, 진짜 상위 N 을 포함한 부분 집합이면 같은 N 개가 나온다(정렬 기준이 같다).
  const cur = { rows: (report.top || []).map((r) => ({ name: r.name, bytes: r.bytes, res: r.res })), total: totalOf(report.scan) };
  const n = Math.max(1, Math.round(Number(topN) || 10));
  const prevTop = (await db.topEntriesOf(prev.id, n)) || [];
  const entries = new Map(prevTop.map((r) => [r.name, { bytes: r.bytes, res: r.res }]));
  const curNames = cur.rows.slice(0, n).map((r) => r.name).filter((x) => !entries.has(x));
  for (const [k, v] of ((await db.entriesByNames(prev.id, curNames)) || new Map())) entries.set(k, v);
  return changeSummary(cur, { entries, total: totalOf(prev) }, topN);
}
/** 마지막 성공 뒤 처음 실패한 조사 시각(실패 알림 '처음 실패'). 성공이 없으면 최근 30일에서 찾는다. 못 찾으면 null. */
async function firstFailureAfter(id, okTs) {
  const since = okTs != null ? Number(okTs) + 1 : Date.now() - 30 * 86_400_000;
  const scans = (await db.scansIn(HISTORY_AGENT, id, since, 500)) || [];
  const f = scans.find((sc) => sc && sc.ok === false);
  return f ? f.ts : null;
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
    const out = await sendTo(t, rcpt.to, buildResultMail(t, report, { corp: corpNameOf(t), recipients: rcpt }), by);
    const last = note(id, { kind: 'result', scanId: report.scan.id, scanTs: report.scan.ts, to: rcpt.to.length, manual: true, ...out });
    return { ok: out.state === 'sent', ...last };
  });
}

export function _resetForTest() { _state = null; _chain = Promise.resolve(); }
