/**
 * issues/notify.js — 이슈 알림(v2.871, 사용자 선택 '이슈 알림(메일·Slack)').
 *
 * 무엇을 누구에게:
 *   · 할당(assigned · 생성 때 담당자 포함) → 새 담당자 · 할당 해제·재할당이면 이전 담당자에게도 한 줄.
 *   · 상태 변경 → 담당자 · 보고자 · 관찰자. · 댓글 → 담당자 · 보고자 · 관찰자 · @멘션된 사람.
 *   · 기한 → 열린 이슈의 담당자에게, 기한이 24시간 안이거나 지났으면 포탈 날짜(dayKey)마다 이슈당 한 번.
 *   · **변경한 본인에게는 보내지 않는다.** 이벤트 종류마다 설정에서 끈다(notify.events).
 * 어떻게:
 *   · 사람별 메일 — 이슈 설정의 사람 → 주소 표(계정에는 메일 칸이 없다). 주소가 없는 사람은 메일을 받지 않고 그 수를 센다(`noEmail`).
 *     메일 종류는 'issues'(설정 › 메일 발송에서 끌 수 있다 · SMTP · 속도 제한 · 이력은 공용 경로).
 *   · 팀 채팅 — 설정 › 알림의 Slack·웹훅·Teams(`alerts.sendChatText`)로 한 번에 한 통 요약.
 *   · **묶음** — 이벤트를 받는 사람마다 쌓아 두고 BATCH_MS(1분)마다 한 통으로 보낸다(일괄 할당 50건이 메일 50통이 되지 않게).
 *     쌓인 줄은 사람당 상한(LINES_MAX)을 넘으면 오래된 것부터 버리고 '외 N건' 으로 밝힌다. 사람 수 상한(RECIP_MAX)을 넘는 새 사람은 그
 *     묶음에서 빠지고 센다(`dropped`) — 조용히 버리지 않는다.
 *   · 실패는 `issueNotifyStatus()`(화면) · 콘솔에 남는다. 다시 보내지 않는다(같은 변경을 두 번 보내는 쪽보다 한 번 놓치는 쪽을 택했다 —
 *     메일 서버 쪽 재시도·이력은 공용 경로가 갖는다).
 *   · 기한 알림 기록(`issue-notify-state.json`)은 상태 파일이다(백업 감시 제외 — registerStateFile).
 * 데모(mock) 모드에서도 같은 코드가 돈다 — 메일·채팅이 꺼져 있으면 아무것도 나가지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';
import { dayKey } from '../util/dayKey.js';
import { capStr } from '../util/capStr.js';
import { onIssueEvent, listIssues } from './store.js';
import { loadIssueSettings, emailOf } from './settings.js';

export const BATCH_MS = 60_000;
export const DUE_SCAN_MS = 30 * 60_000;
export const DUE_WINDOW_MS = 24 * 3600_000;
export const LINES_MAX = 30;
export const RECIP_MAX = 500;
const STATE_NAME = registerStateFile('issue-notify-state.json');
const STATE_KEEP_DAYS = 3;

const STATUS_TEXT = { backlog: '백로그', todo: '할 일', progress: '진행 중', review: '검토', done: '완료' };
const st = (s) => STATUS_TEXT[s] || s || '—';

/* ───── 발송 함수(테스트가 바꿔 끼운다) ───── */
async function realMail(opts) { const { sendPortalMail } = await import('../mail/service.js'); return sendPortalMail(opts); }
async function realChat(text, title) { const { sendChatText } = await import('../alerts.js'); return sendChatText(text, title); }
let senders = { mail: realMail, chat: realChat };
/** 테스트 전용 — 발송 함수를 바꾼다. 인자 없이 부르면 원래대로. */
export function _setIssueNotifySendersForTest(over = null) { senders = over ? { mail: realMail, chat: realChat, ...over } : { mail: realMail, chat: realChat }; }

/* ───── 묶음 ───── */
const pending = new Map(); // username → { lines: string[], extra: number }
let chatLines = [];
let chatExtra = 0;
let timer = null;
const status = { lastFlushAt: null, mails: 0, mailFail: 0, mailSkip: 0, noEmail: 0, chat: 0, chatFail: 0, dropped: 0, lastError: null, dueSent: 0, lastDueScanAt: null };

function lineOf(ev, who) {
  const i = ev.issue || {};
  const head = `${i.key} ${capStr(i.title || '', 120)}`;
  switch (ev.type) {
    case 'created': return `${head} — 새 이슈가 할당됐습니다${ev.auto ? '(자동 할당)' : ''} · ${ev.actor}`;
    case 'assigned':
      if (who === ev.to) return `${head} — 담당자로 지정됐습니다 · ${ev.actor}`;
      return `${head} — 담당자가 ${ev.from || '미할당'} → ${ev.to || '미할당'} 로 바뀌었습니다 · ${ev.actor}`;
    case 'status': return `${head} — 상태 ${st(ev.from)} → ${st(ev.to)} · ${ev.actor}`;
    case 'comment': return `${head} — ${ev.mentions?.includes(who) ? '댓글에서 언급했습니다' : '새 댓글'} · ${ev.actor}: ${capStr(ev.excerpt || '', 160)}`;
    case 'due': return `${head} — ${ev.overdue ? '기한이 지났습니다' : '기한이 24시간 안입니다'}(${new Date(i.dueAt).toISOString().slice(0, 10)})`;
    default: return head;
  }
}

/** 이 이벤트를 받을 사람(변경한 본인 제외). 설정에서 끈 종류면 []. */
export function recipientsOf(ev, settings = loadIssueSettings()) {
  const n = settings?.notify;
  if (!n?.enabled) return [];
  const kind = ev.type === 'created' ? 'assigned' : ev.type;
  if (n.events?.[kind] === false) return [];
  const i = ev.issue || {};
  const set = new Set();
  if (ev.type === 'created') { if (i.assignee) set.add(i.assignee); }
  else if (ev.type === 'assigned') { if (ev.to) set.add(ev.to); if (ev.from) set.add(ev.from); }
  else if (ev.type === 'status') { for (const x of [i.assignee, i.reporter, ...(i.watchers || [])]) if (x) set.add(x); }
  else if (ev.type === 'comment') { for (const x of [i.assignee, i.reporter, ...(i.watchers || []), ...(ev.mentions || [])]) if (x) set.add(x); }
  else if (ev.type === 'due') { if (i.assignee) set.add(i.assignee); }
  set.delete(ev.actor);
  return [...set];
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; flushIssueNotify().catch((e) => console.warn(`[issues] 알림 발송 실패: ${e?.message || e}`)); }, BATCH_MS);
  timer.unref?.();
}

/** 이벤트 하나를 묶음에 넣는다(라우트·기한 검사가 부른다 — 저장소 훅이 연결한다). */
export function queueIssueEvent(ev) {
  const settings = loadIssueSettings();
  const who = recipientsOf(ev, settings);
  if (!who.length) return 0;
  for (const u of who) {
    let p = pending.get(u);
    if (!p) {
      if (pending.size >= RECIP_MAX) { status.dropped += 1; continue; }
      p = { lines: [], extra: 0 }; pending.set(u, p);
    }
    p.lines.push(lineOf(ev, u));
    if (p.lines.length > LINES_MAX) { p.extra += p.lines.length - LINES_MAX; p.lines = p.lines.slice(-LINES_MAX); }
  }
  if (settings.notify.chat) {
    chatLines.push(lineOf(ev, ''));
    if (chatLines.length > LINES_MAX) { chatExtra += chatLines.length - LINES_MAX; chatLines = chatLines.slice(-LINES_MAX); }
  }
  schedule();
  return who.length;
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function mailBody(username, lines, extra) {
  const text = `${username} 님, 이슈 변경 ${lines.length + extra}건\n\n${lines.map((l) => `· ${l}`).join('\n')}${extra ? `\n· 외 ${extra}건(앞의 것은 줄였습니다)` : ''}\n\n포탈 › 이슈에서 확인하세요.`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Malgun Gothic',sans-serif;max-width:680px;padding:16px;color:#101828;">
  <h2 style="margin:0 0 10px;font-size:16px;">이슈 변경 ${lines.length + extra}건</h2>
  <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.7;color:#344054;">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}${extra ? `<li>외 ${extra}건(앞의 것은 줄였습니다)</li>` : ''}</ul>
  <div style="color:#667085;font-size:11.5px;margin-top:16px;border-top:1px solid #eaecf0;padding-top:10px;">VMware Global Monitoring Portal — 이슈 › 설정에서 알림 종류와 받는 주소를 바꿀 수 있습니다.</div>
</div>`;
  return { text, html };
}

/** 쌓인 묶음을 지금 보낸다(타이머·시험). 던지지 않는다. */
export async function flushIssueNotify() {
  if (timer) { clearTimeout(timer); timer = null; }
  const settings = loadIssueSettings();
  const batch = [...pending.entries()];
  pending.clear();
  const chat = chatLines; const cExtra = chatExtra;
  chatLines = []; chatExtra = 0;
  status.lastFlushAt = Date.now();
  if (settings.notify?.mail !== false) {
    for (const [u, p] of batch) {
      const email = emailOf(settings, u);
      if (!email) { status.noEmail += 1; continue; }
      const { text, html } = mailBody(u, p.lines, p.extra);
      try {
        const r = await senders.mail({ kind: 'issues', to: [email], subject: `[이슈] ${p.lines.length + p.extra}건 — ${capStr(p.lines[p.lines.length - 1] || '', 80)}`, html, text });
        if (r?.ok) status.mails += 1;
        else if (r?.skipped) { status.mailSkip += 1; status.lastError = r.reason || '메일 발송을 건너뛰었습니다'; }
        else { status.mailFail += 1; status.lastError = r?.reason || '메일 발송 실패'; console.warn(`[issues] ${u} 에게 이슈 메일 실패: ${status.lastError}`); }
      } catch (e) { status.mailFail += 1; status.lastError = String(e?.message || e).slice(0, 200); console.warn(`[issues] ${u} 에게 이슈 메일 실패: ${status.lastError}`); }
    }
  }
  if (settings.notify?.chat && chat.length) {
    const text = `이슈 변경 ${chat.length + cExtra}건\n${chat.map((l) => `· ${l}`).join('\n')}${cExtra ? `\n· 외 ${cExtra}건` : ''}`;
    try {
      const res = await senders.chat(text, '이슈 트래커');
      const lines = Array.isArray(res) ? res.map(String) : [];
      if (lines.some((l) => /^[a-z]+:2\d\d\b/i.test(l))) status.chat += 1;
      else if (lines.length) { status.chatFail += 1; status.lastError = `채팅: ${lines.join(' · ').slice(0, 200)}`; console.warn(`[issues] 이슈 채팅 알림 실패: ${status.lastError}`); }
      else { status.lastError = '채팅 채널이 꺼져 있어 보내지 않았습니다(설정 › 알림)'; }
    } catch (e) { status.chatFail += 1; status.lastError = String(e?.message || e).slice(0, 200); }
  }
  return { recipients: batch.length, chat: chat.length };
}

/* ───── 기한 ───── */
const stateFile = () => path.join(config.configDir, STATE_NAME);
let dueState = null; // { [key]: dayKey }
function loadDueState() {
  if (dueState) return dueState;
  dueState = {};
  try {
    if (fs.existsSync(stateFile())) {
      const j = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
      if (j && typeof j.sent === 'object' && !Array.isArray(j.sent)) for (const [k, v] of Object.entries(j.sent)) if (typeof v === 'string') dueState[k] = v;
    }
  } catch (e) { preserveCorrupt(stateFile(), e.message); dueState = {}; }
  return dueState;
}

/** 기한 검사 — 열린 이슈 중 담당자가 있고 기한이 24시간 안이거나 지난 것을 그 날 한 번 알린다. @returns 보낸 이벤트 수 */
export function scanDue(now = Date.now()) {
  status.lastDueScanAt = now;
  const settings = loadIssueSettings();
  if (!settings.notify?.enabled || settings.notify.events?.due === false) return 0;
  const today = dayKey(now);
  const s = loadDueState();
  let n = 0; let changed = false;
  for (const r of listIssues({ done: 'open', limit: 100_000 }).rows) {
    if (!r.assignee || r.dueAt == null || r.dueAt > now + DUE_WINDOW_MS) continue;
    if (s[r.key] === today) continue;
    s[r.key] = today; changed = true;
    queueIssueEvent({ type: 'due', actor: '', overdue: r.dueAt < now, issue: { key: r.key, title: r.title, assignee: r.assignee, dueAt: r.dueAt } });
    n += 1;
  }
  // 오래된 기록 정리(며칠 지난 날짜) — 표가 끝없이 자라지 않게.
  const cut = dayKey(now - STATE_KEEP_DAYS * 86_400_000);
  for (const [k, v] of Object.entries(s)) if (v < cut) { delete s[k]; changed = true; }
  if (changed) { try { atomicWriteFileSync(stateFile(), JSON.stringify({ sent: s }), { mode: 0o600 }); } catch (e) { console.warn(`[issues] 기한 알림 기록을 쓰지 못했습니다: ${e?.code || e?.message}`); } }
  status.dueSent += n;
  return n;
}

/** 화면용 상태(계정명·주소 없음). */
export function issueNotifyStatus() {
  return { ...status, pendingRecipients: pending.size, pendingChat: chatLines.length, batchMs: BATCH_MS };
}

/* ───── 시작 ───── */
let started = false;
let dueTimer = null;
/** 저장소 이벤트를 구독하고 기한 검사를 돌린다(index.js 가 기동 때 한 번). */
export function startIssueNotify() {
  if (started) return;
  started = true;
  onIssueEvent((ev) => queueIssueEvent(ev));
  dueTimer = setInterval(() => { try { scanDue(); } catch (e) { console.warn(`[issues] 기한 알림 검사 실패: ${e?.message || e}`); } }, DUE_SCAN_MS);
  dueTimer.unref?.();
}
/** 테스트 전용. */
export function _resetIssueNotifyForTest() {
  pending.clear(); chatLines = []; chatExtra = 0; dueState = null;
  if (timer) { clearTimeout(timer); timer = null; }
  for (const k of Object.keys(status)) status[k] = typeof status[k] === 'number' ? 0 : null;
}
