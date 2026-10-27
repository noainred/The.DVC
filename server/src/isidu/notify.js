/**
 * isidu/notify.js — 아이실론 디렉터리 사용량 결과 메일(v2.738). 규칙은 `mailRules.js`(순수), 발송은 공용 `sendPortalMail({kind:'isidu'})`.
 *
 * ── 언제 보내는가 ───────────────────────────────────────────────────────────
 *  · **중앙만 보낸다.** 엣지가 조사한 결과는 중앙이 받아 적재한 순간(routes/central.js /isidu-data)에, 중앙이 직접 조사한 결과는
 *    적재한 순간(poller.js)에 `notifyScanStored` 를 부른다. 엣지는 메일 설정을 받지 않는다(settings.edgeTargetView 가 싣지 않는다 —
 *    주소 목록을 28곳에 퍼뜨리지 않는다).
 *  · 조사가 성공할 때마다 보낸다. 대상이 '변화 없으면 생략' 이면 **마지막으로 보낸 조사**(v2.769 R4-D4-03 — 예전엔 직전 성공 조사)와 비교해
 *    메일에 보이는 것(상위 N·전체 합계)이 du -h 해상도 안에서 같으면 보내지 않고 그 사실을 기록한다. 보낸 기록이 없으면 비교하지 않고 보낸다.
 *  · 실패 알림은 대상이 고른 경우에만, 대상별 6시간에 한 번까지.
 *  · 같은 결과를 두 번 보내지 않는다 — 대상별 마지막으로 다룬 조사(id·시각)를 상태 파일에 남긴다(엣지 재전송·중앙 재시작).
 *    이미 다룬 것보다 오래된 조사(엣지가 밀린 결과를 늦게 보냄)는 보내지 않는다.
 *  · 데모(mock-) 대상은 어떤 모드에서도 실제 메일을 보내지 않는다(v2.708 '데모 데이터로 실제 알림 채널에 보내지 않는다' ·
 *    v2.719 'live 에서는 데모 표지 항목을 실행하지 않는다').
 *  · 결과(보냄·생략·실패·사유)는 대상별로 남기고 화면이 말한다 — 조용히 빼지 않는다. 주소는 남기지 않는다(개수만).
 *  · 발송은 한 줄로 묶는다(동시에 여러 대상이 끝나도 릴레이에 한 번에 하나씩).
 *
 * ── v2.745 보내는 때 '정한 요일·시각'(대상 mail.when === 'schedule') ─────────────────────
 *  · 조사 성공이 적재되면 결과 메일을 **보내지 않는다** — 중복·오래된 결과 판정(lastScanId·lastScanTs)만 갱신하고 마지막 메일 기록(last)은
 *    덮지 않는다(화면의 '마지막 메일' 은 실제 발송 결과다). **실패 알림은 보내는 때와 무관하게 조사 직후 그대로 보낸다**(알림이라 미루지 않는다).
 *  · 정기 틱(`targetMailTick`, 30초 — 중앙만)이 대상마다 종합 메일과 **같은 판정**(`digestRules.planDigestTick`)으로 회차를 본다:
 *    send(정한 시각 뒤 30분 안) / missed(그보다 늦음·포탈이 꺼져 있던 회차 — 몰아서 보내지 않고 기록만) / rebase(시계가 뒤로 감) / none.
 *    처리한 회차(lastSlot)는 **보내기 전에** 상태 파일에 남긴다(보내는 중 재시작해도 같은 회차를 두 번 보내지 않는다 — 대신 그 회차는 못 보냈을 수 있다).
 *  · 보낼 때: 마지막 **성공** 조사 결과 · 받는 사람 규칙은 그대로 · 데모 대상은 기록만. '새 조사 없으면 생략'(skipIfNoNew, 기본 켬)은 마지막 정기 발송
 *    이후 새 성공 조사가 없으면 건너뛴다. '변화 없으면 생략' 은 **마지막으로 보낸 정기 발송 조사**와 비교한다(없으면 비교하지 않고 보낸다 — 아래 SCHED-01).
 *  · 받는 사람이 0명인 대상은 메일 기록(last)·경고를 남기지 않는다. 다만 그 동안 지나간 회차는 **처리 기록(lastSlot)만 조용히** 넘긴다(v2.745 검토
 *    SCHED-02 — 그러지 않으면 수신자를 넣은 직후 그 회차들이 '놓침(늦게 확인·포탈 꺼짐) N번' 으로 한꺼번에 기록됐다. 포탈은 켜져 있었고 놓친 것도 아니다).
 *    사람이 누른 '지금 보내기' 는 정기 발송 기록(lastSlot·schedSent*)을 건드리지 않는다.
 *  · '변화 없으면 생략' 의 기준은 **실제로 보낸 정기 발송 조사**뿐이다(SCHED-01). 정기 발송 이력이 없거나 그 조사가 DB 에 없으면 비교하지 않고
 *    보낸다 — 직전 조사와 비교하면 조사마다 du -h 해상도보다 조금씩 자라는 폴더가 이웃한 두 조사끼리 늘 '같다' 가 되어 영원히 보내지 않았다.
 *  · since 가 미래(저장 뒤 서버 시계가 뒤로 감)면 설정 파일은 고치지 않고 대상 기록에 sinceFrom·sinceCap 을 남겨 지금으로 잡는다(SCHED-03 —
 *    xferspeed rebaseClock 과 같은 규칙). 그 since 때문에 보낼 차례에 막힌 회차는 소급해 보내지 않고 'missed-clock' 으로 남긴다.
 *    화면 '다음 발송'(rows.js)도 같은 실효 since 로 계산한다(`targetMailNextSlots`).
 *  · 기록 code 는 `mailRules.TARGET_MAIL_CODES` 하나다(웹 문구 표와 1:1).
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
import { planDigestTick, nextDigestSlots, slotLabel, DIGEST_GRACE_MS } from './digestRules.js';
import { effectiveSince, CLOCK_TOL_MS } from '../xferspeed/schedule.js';
import { numOrNull } from '../util/numOrNull.js';
import { renderResultMail, renderFailureMail, bytesText, deltaText } from './mailHtml.js';
import { corpNameOf } from './corpName.js';

registerStateFile('isidu-mail-state.json');
const FILE = () => path.join(config.configDir, 'isidu-mail-state.json');   // ⚠ 리터럴 형태 유지 — scripts/config-doc.mjs 가 이 모양으로 찾는다
const STATE_MAX = 200;
export const MAIL_KIND = 'isidu';

const isEdge = () => !!(config.agent.centralUrl && config.agent.centralToken);
const BOOT_AT = Date.now();
/** v2.745 정기 발송 틱 간격(종합 메일과 같다). */
export const TARGET_MAIL_TICK_MS = 30_000;

// 대상 기록: { lastScanId, lastScanTs, lastFailAlertAt, last, lastSlot(처리한 정기 회차), schedSentScanId·schedSentScanTs·schedSentAt(마지막 정기 발송한 조사),
//             scanSentScanId·scanSentScanTs(v2.769 R4-D4-03 — 조사마다 모드에서 마지막으로 자동 발송한 조사),
//             sinceFrom·sinceCap(시계가 뒤로 가 미래가 된 since 를 지금으로 잡은 기록 — 그 since 값일 때만 쓴다) }
let _state = null; // { targets: { [id]: { … } } }
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

/** 결과 메일 본문(순수 — 테스트로 고정). v2.745: schedule({days, time}) 가 있으면 정기 발송 메일이다(본문 머리가 그 사실을 말한다). */
export function buildResultMail(t, report, { change = null, corp = '', recipients = null, schedule = null, manual = false, now = Date.now() } = {}) {
  const tm = targetMailOf(t);
  // manual(지금 보내기): 바닥글이 '조사가 끝날 때마다 보냅니다' 라고 말하지 않게 그 대상의 실제 보내는 때를 넘긴다(v2.745 리뷰 F3).
  return renderResultMail({ label: nameOf(t), corp, report, change, recipients, onlyOnChange: tm.onlyOnChange, schedule, manual, mode: { when: tm.when, days: tm.days, time: tm.time }, now });
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
  // v2.745: 정기 발송 대상의 성공 결과는 지금 보내지 않는다 — 정한 요일·시각에 틱이 보낸다(실패 알림은 아래 그대로 즉시).
  const scheduled = ok && tm.when === 'schedule';
  if (Number.isFinite(sid) && Number(r.lastScanId) === sid) return { state: 'duplicate' };
  if (Number.isFinite(sts) && Number.isFinite(Number(r.lastScanTs)) && sts < Number(r.lastScanTs)) {
    // 정기 발송 대상은 성공·실패 모두 마지막 메일 기록(실제 정기 발송 결과)을 덮지 않는다(v2.745 리뷰 SCHED-05·F4 — 늦게 온 옛 실패가 '건너뜀' 으로 덮었다).
    if (tm.when === 'schedule') return { state: 'older' };
    return { state: 'older', last: note(id, { kind: ok ? 'result' : 'failure', scanId: sid, scanTs: sts, state: 'skipped', reason: '이미 메일을 보낸 조사보다 오래된 결과라 보내지 않았습니다(엣지가 밀린 결과를 늦게 보냄)' }) };
  }
  r.lastScanId = Number.isFinite(sid) ? sid : r.lastScanId; r.lastScanTs = Number.isFinite(sts) ? sts : r.lastScanTs;
  if (scheduled) { save(); return { state: 'scheduled' }; }
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
  // v2.769(점검 R4-D4-03): '변화 없으면 생략' 의 기준은 **마지막으로 실제 보낸(조사마다 모드) 조사**다 — 정기 발송(v2.745 SCHED-01)과 같은 규칙.
  //   예전에는 직전 성공 조사와 비교해, 조사마다 du -h 한 칸씩 자라는 폴더(73G→74G→…)가 이웃한 두 조사끼리 늘 '같다' 가 되어 영원히 생략됐고
  //   (재현: 10번 조사 동안 +10G, 메일 1통), 직전 결과 메일이 SMTP 실패·생략이었어도 다음 같은 결과가 '변화 없음' 으로 빠졌다.
  //   보낸 기록이 없거나 그 조사가 DB 에 없으면 비교하지 않고 보낸다.
  const sentBase = tm.onlyOnChange ? await scanSentBase(id, r) : null;
  if (sentBase) {
    change = await changeVsScan(id, report, t.topN, sentBase);
    if (!change.changed) return { state: 'unchanged', last: note(id, { kind: 'result', scanId: sid, scanTs: sts, state: 'skipped', reason: '마지막으로 보낸 조사와 상위 폴더·전체 합계가 반올림 범위 안에서 같아 보내지 않았습니다(변화 없으면 생략)' }) };
  } else {
    // v2.742: 본문의 '직전 조사 대비' 알림용 — 판정에는 쓰지 않으므로 실패해도 메일은 보낸다.
    try { change = await changeVsPrevious(id, report, t.topN); } catch { change = null; }
  }
  const mail = buildResultMail(t, report, { change, corp: corpNameOf(t), recipients: rcpt });
  const out = await sendTo(t, rcpt.to, mail, 'system');
  if (out.state === 'sent') { r.scanSentScanId = report.scan.id; r.scanSentScanTs = report.scan.ts; }   // note() 가 저장한다
  return { state: out.state, last: note(id, { kind: 'result', scanId: sid, scanTs: sts, to: rcpt.to.length, ...out }) };
}

/**
 * v2.769(점검 R4-D4-03): 조사마다 모드 '변화 없으면 생략' 의 기준 — 마지막으로 **자동 발송에 성공한** 조사(scanSentScanTs).
 * 이 필드가 없는 옛 상태 파일은 마지막 메일 기록(last)이 '조사마다 자동 결과 메일 · 보냄' 이면 그 조사를 쓴다(업그레이드 직후 한 통 더 가지 않게).
 * 사람이 누른 '지금 보내기'·정기 발송 기록은 기준으로 쓰지 않는다(그 경로의 기록과 섞지 않는다 — v2.745 '지금 보내기는 자동 기록을 건드리지 않는다').
 * 없거나 그 조사가 DB 에 없으면 null(비교하지 않고 보낸다).
 */
async function scanSentBase(id, r) {
  let sentTs = numOrNull(r.scanSentScanTs);
  if (sentTs == null) {
    const l = r.last;
    if (l && l.kind === 'result' && l.state === 'sent' && !l.manual && !l.schedule) {
      sentTs = numOrNull(l.scanTs);
      // v2.770(점검 R5-E1-5): 옛 상태 호환으로 찾은 기준을 scanSentScanTs/Id 로 **굳힌다**(저장은 호출부의 note() 가 한다). 예전에는 굳히지 않아
      //   업그레이드 뒤 첫 조사가 '변화 없음' 이면 note() 가 last 를 '건너뜀' 으로 덮어 다음 조사에서 기준이 사라졌고, 비교 없이 한 통 더 나갔다.
      if (sentTs != null) { r.scanSentScanTs = sentTs; const lid = numOrNull(l.scanId); if (lid != null) r.scanSentScanId = lid; }
    }
  }
  if (sentTs == null) return null;
  return (await db.okScanAtOrBefore(HISTORY_AGENT, id, sentTs)) || null;
}

async function changeVsPrevious(id, report, topN) {
  return changeVsScan(id, report, topN, await db.okScanBefore(HISTORY_AGENT, id, report.scan.ts));
}
/** 고른 기준 조사(prev — 없으면 첫 결과)와 비교한 변화. 정기 발송은 마지막으로 보낸 조사를 기준으로 쓴다(v2.745). */
async function changeVsScan(id, report, topN, prev) {
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
    const out = await sendTo(t, rcpt.to, buildResultMail(t, report, { corp: corpNameOf(t), recipients: rcpt, manual: true }), by);
    const last = note(id, { kind: 'result', scanId: report.scan.id, scanTs: report.scan.ts, to: rcpt.to.length, manual: true, ...out });
    return { ok: out.state === 'sent', ...last };
  });
}

// ── v2.745 정기 발송(대상 mail.when === 'schedule') ─────────────────────────────
const MISSED_TEXT = {
  down: '포탈이 꺼져 있던 동안의 회차라 보내지 않았습니다(몰아서 보내지 않습니다).',
  late: `정한 시각보다 ${Math.round(DIGEST_GRACE_MS / 60_000)}분 넘게 늦게 확인해 보내지 않았습니다(몰아서 보내지 않습니다).`,
  clock: '서버 시계가 뒤로 가 보내는 때를 저장한 시각이 지금보다 뒤였습니다 — 그 시각을 지금으로 잡고 이 회차는 보내지 않았습니다(소급해 보내지 않습니다).',
};
let _tickBusy = false;
let _tickTimer = null;

/**
 * 정기 발송의 '변화 없으면 생략' 기준 — 마지막으로 **보낸** 정기 발송 조사. 이력이 없거나 그 조사가 DB 에 없으면 null(비교하지 않고 보낸다 — SCHED-01).
 * 직전 성공 조사를 기준으로 쓰지 않는다: 보낸 적 없는 조사와 '같다' 는 것은 '마지막으로 보낸 것과 같다' 가 아니다.
 */
async function sentBaseScan(id, r) {
  const sentTs = numOrNull(r.schedSentScanTs);
  if (sentTs == null) return null;
  return (await db.okScanAtOrBefore(HISTORY_AGENT, id, sentTs)) || null;
}

/**
 * 대상 정기 발송의 실효 since(순수) — 시계가 뒤로 가 미래가 된 since 를 지금으로 잡은 기록(sinceFrom·sinceCap)이 그 since 값이면 잡은 값.
 * 일정을 다시 정의하면 since 가 바뀌므로 옛 보정은 저절로 빠진다(xferspeed effectiveSince 그대로). 없으면 null.
 */
export function targetMailSinceOf(tm, rec) {
  const v = numOrNull(effectiveSince({ since: tm?.since }, rec));
  return v != null && v > 0 ? v : null;
}

/**
 * 화면 '다음 발송'(순수) — 틱과 같은 실효 since 로 계산한다. 허용 폭(CLOCK_TOL_MS) 안의 미래 since 는 그 뒤부터(틱이 since 이하 회차를 보내지 않는다),
 * 그보다 먼 미래는 틱이 지금으로 잡으므로 지금부터. 정기 발송이 아니면 [].
 * @param {object} tm targetMailOf 결과   @param {object|null} rec 대상 기록   @param {number} now   @param {number} n
 */
export function targetMailNextSlots(tm, rec, now = Date.now(), n = 3) {
  if (tm?.when !== 'schedule') return [];
  const since = targetMailSinceOf(tm, rec);
  const from = since != null && since > now && since <= now + CLOCK_TOL_MS ? since : now;
  return nextDigestSlots({ enabled: true, days: tm.days, time: tm.time, since: null }, from, n);
}

/** 화면용 — 대상 기록을 읽어 다음 회차(rows.js). */
export function targetMailNextOf(id, tm, now = Date.now(), n = 3) {
  return targetMailNextSlots(tm, state().targets[String(id || '')] || null, now, n);
}

/** 정기 회차 한 번 보내기(serial 줄 안에서 — 던지지 않는 쪽은 호출부가 잡는다). 설정은 지금 다시 읽는다(틱이 본 뒤 바뀌었을 수 있다). */
async function sendScheduled(id, slot, now) {
  const { s, t } = targetById(id);
  if (!t) return { state: 'gone' };
  const tm = targetMailOf(t);
  if (tm.when !== 'schedule') return { state: 'not-scheduled' };   // 그 사이 '조사가 끝날 때마다' 로 바뀌었다 — 기록하지 않는다
  const base = { kind: 'result', schedule: true, slot };
  const rcpt = mailRecipients(s.mail?.commonTo, tm);
  if (!rcpt.to.length) return { state: 'skipped', last: note(id, { ...base, state: 'skipped', code: 'no-recipients', reason: '보낼 때 받는 사람이 없어 보내지 않았습니다.' }) };
  if (String(id).startsWith('mock-')) return { state: 'demo', last: note(id, { ...base, state: 'skipped', code: 'demo', reason: '데모 대상은 실제 메일을 보내지 않습니다' }) };
  const r = rec(id);
  const report = await buildReport(id, { topN: t.topN });
  if (report.state !== 'ok') {
    const dbOff = report.state === 'db-unavailable';
    return { state: 'no-report', last: note(id, { ...base, state: dbOff ? 'failed' : 'skipped', code: 'no-report', reason: dbOff ? '결과 DB 를 열지 못해 보내지 않았습니다.' : '보낼 성공 조사 결과가 없어 보내지 않았습니다(아직 성공한 조사가 없습니다).' }) };
  }
  const scanInfo = { scanId: report.scan.id, scanTs: report.scan.ts };
  const sentId = numOrNull(r.schedSentScanId);
  if (tm.skipIfNoNew && sentId != null && report.scan.id === sentId) {
    return { state: 'no-new', last: note(id, { ...base, ...scanInfo, state: 'skipped', code: 'no-new', reason: '직전 정기 발송 뒤 새로 끝난 성공 조사가 없어 보내지 않았습니다(새 조사 없으면 생략).' }) };
  }
  let change = null;
  // SCHED-01: 판정 기준은 마지막으로 보낸 정기 발송 조사뿐이다 — 없으면(첫 정기 발송·그 조사가 지워짐) 비교하지 않고 보낸다.
  const sentBase = tm.onlyOnChange ? await sentBaseScan(id, r) : null;
  if (sentBase) {
    change = await changeVsScan(id, report, t.topN, sentBase);
    if (!change.changed) return { state: 'unchanged', last: note(id, { ...base, ...scanInfo, state: 'skipped', code: 'unchanged', reason: '마지막으로 보낸 조사와 상위 폴더·전체 합계가 반올림 범위 안에서 같아 보내지 않았습니다(변화 없으면 생략).' }) };
  } else {
    // 본문의 '직전 대비' 알림용(판정에는 쓰지 않는다 — 실패해도 보낸다). 기준은 마지막으로 보낸 조사, 없으면 직전 성공 조사.
    try { change = await changeVsScan(id, report, t.topN, (await sentBaseScan(id, r)) || (await db.okScanBefore(HISTORY_AGENT, id, report.scan.ts))); } catch { change = null; }
  }
  const mail = buildResultMail(t, report, { change, corp: corpNameOf(t), recipients: rcpt, schedule: { days: [...tm.days], time: tm.time }, now });
  const out = await sendTo(t, rcpt.to, mail, 'system');
  if (out.state === 'sent') { r.schedSentScanId = report.scan.id; r.schedSentScanTs = report.scan.ts; r.schedSentAt = Date.now(); }
  return { state: out.state, last: note(id, { ...base, ...scanInfo, to: rcpt.to.length, ...out }) };
}

/**
 * 대상 하나의 이번 틱(회차 판정 → 기록 → 필요하면 보내기).
 * quiet(받는 사람 0명): 메일 기록(last)·경고 없이 처리한 회차(lastSlot)만 넘긴다 — SCHED-02. 보내지 않는다.
 */
async function tickTarget(t, tm, now, bootAt, { quiet = false } = {}) {
  const id = t.id;
  const cur = state().targets[id];
  const since = targetMailSinceOf(tm, cur);
  // SCHED-03: since 가 지금보다 한참 뒤 — 저장할 때 서버 시계가 앞서 있었다. 설정 파일은 고치지 않고 기록에 보정(sinceFrom·sinceCap)을 남긴다.
  if (since != null && since > now + CLOCK_TOL_MS) {
    const r = rec(id);
    r.sinceFrom = tm.since; r.sinceCap = now;
    // 그 since 때문에 막힌 '지금 보낼 차례' 회차 — 소급해 보내지 않고 시계 사유로 남긴다(그보다 오래된 회차는 since 이전이라 말하지 않는다).
    const p = planDigestTick({ digest: { enabled: true, days: tm.days, time: tm.time, since: null }, state: { lastSlot: cur?.lastSlot }, now, bootAt });
    const slot = p.action === 'send' ? p.slot : null;
    if (slot != null) r.lastSlot = slot;
    if (slot != null && !quiet) note(id, { kind: 'result', schedule: true, slot, state: 'skipped', code: 'missed-clock', reason: MISSED_TEXT.clock });
    else save();
    if (!quiet) console.warn(`[isidu-mail] ${id}: 서버 시계가 뒤로 가 결과 메일 보내는 때를 저장한 시각(${slotLabel(tm.since)})이 지금보다 뒤였습니다 — 지금으로 다시 잡았습니다${slot != null ? `(${slotLabel(slot)} 회차는 보내지 않음)` : ''}.`);
    return { id, action: 'rebase', field: 'since', sinceFrom: tm.since, sinceCap: now, ...(slot != null ? { slot } : {}) };
  }
  const plan = planDigestTick({ digest: { enabled: true, days: tm.days, time: tm.time, since }, state: { lastSlot: cur?.lastSlot }, now, bootAt });
  if (plan.action === 'none') return { id, action: 'none' };
  const r = rec(id);
  if (plan.action === 'rebase') {
    r.lastSlot = plan.lastSlot; save();
    if (!quiet) console.warn(`[isidu-mail] ${id}: 서버 시계가 뒤로 가 정기 발송 처리 기록을 지금으로 다시 잡았습니다.`);
    return { id, ...plan };
  }
  if (quiet) {
    // 받는 사람이 없던 회차 — 보낼 수 없었으니 놓친 것도 아니다. 처리 기록만 넘긴다(수신자를 넣은 뒤 거짓 '놓침 N번' 이 생기지 않게).
    if (plan.action === 'send' || plan.action === 'missed') { r.lastSlot = plan.slot; save(); }
    return { id, action: 'no-recipients', slot: plan.slot ?? null };
  }
  if (plan.action === 'missed') {
    const code = plan.reason === 'down' ? 'missed-down' : 'missed-late';
    r.lastSlot = plan.slot;
    note(id, { kind: 'result', schedule: true, slot: plan.slot, state: 'skipped', code, count: plan.count, reason: `${MISSED_TEXT[plan.reason === 'down' ? 'down' : 'late']}${plan.count > 1 ? ` (놓친 회차 ${plan.count}번 — 마지막 ${slotLabel(plan.slot)})` : ''}` });
    console.warn(`[isidu-mail] ${id}: 결과 메일 정기 회차를 놓쳤습니다(${slotLabel(plan.slot)} · ${plan.reason}${plan.count > 1 ? ` · ${plan.count}번` : ''}) — 몰아서 보내지 않습니다.`);
    return { id, ...plan };
  }
  if (plan.action !== 'send') return { id, action: plan.action };
  r.lastSlot = plan.slot; save();   // 보내기 전에 남긴다 — 보내는 중 재시작해도 같은 회차를 두 번 보내지 않는다
  const result = await serial(() => sendScheduled(id, plan.slot, now));
  if (result.state === 'failed') console.warn(`[isidu-mail] ${id}: 정기 결과 메일을 보내지 못했습니다(${slotLabel(plan.slot)}): ${result.last?.reason || ''}`);
  return { id, ...plan, result };
}

/**
 * 정기 발송 틱(v2.745) — 보내는 때가 '정한 요일·시각' 인 대상마다 회차를 판정한다(던지지 않는다). 중앙만 · 진행 중이면 건너뛴다.
 * @param {number} now
 * @param {{bootAt?:number}} opts 놓침 사유('포탈이 꺼져 있었음') 판정용 기동 시각
 * @returns {Promise<{action:'edge'|'busy'|'error'}|{action:'tick', at:number, results:object[]}>}
 */
export async function targetMailTick(now = Date.now(), { bootAt = BOOT_AT } = {}) {
  if (isEdge()) return { action: 'edge' };
  if (_tickBusy) return { action: 'busy' };
  _tickBusy = true;
  try {
    const s = loadSettings();
    const results = [];
    for (const t of s.targets) {
      const tm = targetMailOf(t);
      if (tm.when !== 'schedule') continue;
      // 받는 사람이 없으면 보내지도 기록(last)하지도 않는다 — 지나간 회차만 조용히 넘긴다(SCHED-02).
      const quiet = !mailRecipients(s.mail?.commonTo, tm).to.length;
      try { results.push(await tickTarget(t, tm, now, bootAt, { quiet })); }
      catch (e) { console.warn(`[isidu-mail] ${t.id}: 정기 발송 틱 실패: ${e?.message || e}`); results.push({ id: t.id, action: 'error', error: String(e?.message || e).slice(0, 300) }); }
    }
    return { action: 'tick', at: now, results };
  } catch (e) {
    console.warn(`[isidu-mail] 정기 발송 틱 실패: ${e?.message || e}`);
    return { action: 'error', error: String(e?.message || e).slice(0, 300) };
  } finally { _tickBusy = false; }
}

/** 정기 발송 틱 시작(중앙만 — 엣지는 메일을 보내지 않는다). */
export function startIsiduTargetMail() {
  if (_tickTimer || isEdge()) return;
  _tickTimer = setInterval(() => { targetMailTick().catch(() => {}); }, TARGET_MAIL_TICK_MS);
  _tickTimer.unref?.();
}

export function _resetForTest() { _state = null; _chain = Promise.resolve(); _tickBusy = false; if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; } }
