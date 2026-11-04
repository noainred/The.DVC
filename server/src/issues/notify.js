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
import { dayKey, portalParts } from '../util/dayKey.js';
import { capStr } from '../util/capStr.js';
import { onIssueEvent, listIssues, dueDays, queryContext, minutesText } from './store.js';
import { subscribedFilters } from './filters.js';
import { listUsers } from '../auth/auth.js';
import { scopedVcenterIds } from '../auth/scope.js';
import { store } from '../store.js';
import { loadIssueSettings, emailOf } from './settings.js';
import { issueViewers } from './visibility.js';
import { load as loadMailSettings } from '../mail/settings.js';

export const BATCH_MS = 60_000;
export const DUE_SCAN_MS = 30 * 60_000;
export const DUE_WINDOW_MS = 24 * 3600_000;
export const LINES_MAX = 30;
export const RECIP_MAX = 500;
const STATE_NAME = registerStateFile('issue-notify-state.json');
const STATE_KEEP_DAYS = 3;
const STARTUP_SCAN_MS = 90_000;

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
let flushing = null; // 진행 중인 flush(감사 A5-03 — 겹쳐 돌지 않게)
const droppedNow = new Set(); // 이번 묶음에서 사람 수 상한으로 뺀 사람(감사 A4-08 — '사람' 단위로 센다)
const pendingDue = new Map(); // 이슈 키 → 포탈 날짜 — 보낸 뒤에야 기록 파일에 쓴다(감사 A2-02·A5-04)
const mailSentAt = []; // 이슈 메일 발송 시각(최근 1시간 — 감사 A5-01 이슈 몫 예산)
const status = { lastFlushAt: null, mails: 0, mailFail: 0, mailSkip: 0, mailDeferred: 0, noEmail: 0, outOfScope: 0, chat: 0, chatFail: 0, dropped: 0, lastError: null, dueSent: 0, slaSent: 0, lastDueScanAt: null };

/**
 * 이슈 메일의 시간당 몫 — 메일 설정의 시간당 한도(공용 — 장애 알림과 같이 쓴다)의 절반. 0(제한 없음)이면 제한 없음.
 * 넘는 묶음은 버리지 않고 다음 묶음으로 미룬다(mailDeferred) — 이슈 알림 폭주가 장애 알림 메일의 몫을 다 쓰지 않게(감사 A5-01).
 */
export function issueMailBudget() {
  let per = 60;
  try { per = Number(loadMailSettings()?.rateLimitPerHour); } catch { per = 60; }
  if (!Number.isFinite(per) || per <= 0) return Infinity;
  return Math.max(1, Math.floor(per / 2));
}
function mailRoom(now = Date.now()) {
  while (mailSentAt.length && now - mailSentAt[0] > 3600_000) mailSentAt.shift();
  return issueMailBudget() - mailSentAt.length;
}

/**
 * 팀 채팅 문구 정리(감사 A3-03) — 이슈 제목·댓글은 사람이 쓴 값이다. Slack 의 제어 표기(<!channel>·<url|글자>)와 Teams 마크다운 링크([글자](url))가
 * 그대로 실리지 않게 꺾쇠·대괄호를 비슷한 모양의 다른 글자로 바꾼다(뜻은 남고 채널 전체 호출·위장 링크는 생기지 않는다).
 */
export function chatSafe(t) {
  return String(t ?? '').replace(/</g, '‹').replace(/>/g, '›').replace(/\[/g, '［').replace(/\]/g, '］');
}

function lineOf(ev, who) {
  const i = ev.issue || {};
  const head = `${i.key} ${capStr(i.title || '', 120)}`;
  switch (ev.type) {
    case 'created': return `${head} — 새 이슈가 할당됐습니다${ev.auto ? '(자동 할당)' : ''} · ${ev.actor}`;
    case 'assigned':
      if (who === ev.to) return `${head} — 담당자로 지정됐습니다 · ${ev.actor}`;
      return `${head} — 담당자가 ${ev.from || '미할당'} → ${ev.to || '미할당'} 로 바뀌었습니다 · ${ev.actor}`;
    case 'status': return `${head} — 상태 ${st(ev.from)} → ${st(ev.to)} · ${ev.actor}`;
    case 'progress': return `${head} — 진행 ${ev.to == null ? '보고 없음' : `${ev.to}%`}${ev.note ? ` · ${capStr(ev.note, 120)}` : ''} · ${ev.actor}`;
    case 'comment': return `${head} — ${ev.mentions?.includes(who) ? '댓글에서 언급했습니다' : '새 댓글'} · ${ev.actor}: ${capStr(ev.excerpt || '', 160)}`;
    // 날짜는 포탈 날짜(dayKey — 하루 한 번 판정과 같은 기준). UTC 로 자르면 KST 09:00 이전 기한이 하루 앞으로 적혔다(감사 A2-07·A4-06).
    case 'due': {
      const d = dueDays(i.dueAt);
      const what = d == null ? '기한 확인 필요' : d < 0 ? '기한이 지났습니다' : d === 0 ? '오늘이 기한입니다' : '내일이 기한입니다';
      return `${head} — ${what}(${dayKey(i.dueAt) || '날짜 모름'})`;
    }
    // v2.887 SLA 초과 — 단계 · 목표 · 흐른 시간(보류 시간 제외)
    case 'sla': return `${head} — SLA ${ev.kind === 'respond' ? '응답' : '해결'} 목표(${minutesText(ev.targetMin)})를 넘었습니다 · 흐른 시간 ${minutesText(ev.usedMin)}(보류 제외)`;
    default: return head;
  }
}

/** 이 이벤트 종류가 켜져 있는가(알림 전체 · 종류별). */
function eventOn(ev, settings) {
  const n = settings?.notify;
  if (!n?.enabled) return false;
  const kind = ev.type === 'created' ? 'assigned' : ev.type;
  return n.events?.[kind] !== false;
}

// 이름이 이어지는 글자: 영숫자·_·-·\ 또는 '.' 뒤에 영숫자('kim.lee'). 문장 끝 '.'·',' 와 조사('님')는 이름이 아니다.
const NAME_TAIL_RE = /^(?:[A-Za-z0-9_\\-]|\.[A-Za-z0-9])/;
/**
 * 댓글의 @멘션 토큰 → 실제 이름(감사 A2-06·A5-02). 토큰은 '@kim님'·'@park.' 처럼 조사·구두점이 붙어 온다 — 알려진 이름(로컬 계정 ·
 * 메일 주소 표 · 이 이슈의 담당자·보고자·관찰자) 중 **가장 긴 접두**로 맞춘다. 이름 뒤가 이름이 이어지는 글자(NAME_TAIL_RE — 영숫자·_·-·\, 또는 '.' 다음 영숫자)면 다른 이름이라
 * 맞지 않는다. 맞는 이름이 없는 토큰은 버린다(수신자 자리를 차지하지 않는다).
 */
export function resolveMentions(tokens, known) {
  const names = [...known].filter(Boolean).sort((a, b) => b.length - a.length);
  const out = [];
  for (const t of Array.isArray(tokens) ? tokens.slice(0, 10) : []) {
    const tok = String(t || '');
    const hit = names.find((n) => tok === n || (tok.startsWith(n) && !NAME_TAIL_RE.test(tok.slice(n.length))));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/**
 * 이 이벤트를 받을 사람(변경한 본인 제외). 설정에서 끈 종류면 [].
 * 감사 A3-01: **그 이슈의 법인을 볼 수 있는 사람만** — 판정은 issues/visibility.js(자동 할당과 같은 함수). 범위 밖이면 빼고 센다(outOfScope).
 */
export function recipientsOf(ev, settings = loadIssueSettings(), viewers = issueViewers()) {
  if (!eventOn(ev, settings)) return [];
  const i = ev.issue || {};
  const set = new Set();
  if (ev.type === 'created') { if (i.assignee) set.add(i.assignee); }
  else if (ev.type === 'assigned') { if (ev.to) set.add(ev.to); if (ev.from) set.add(ev.from); }
  else if (ev.type === 'status' || ev.type === 'progress') { for (const x of [i.assignee, i.reporter, ...(i.watchers || [])]) if (x) set.add(x); }
  else if (ev.type === 'comment') {
    const parts = [i.assignee, i.reporter, ...(i.watchers || [])].filter(Boolean);
    const known = new Set([...viewers.localNames, ...(settings.notify.people || []).map((p) => p.username), ...parts]);
    for (const x of [...parts, ...resolveMentions(ev.mentions, known)]) set.add(x);
  } else if (ev.type === 'due') { if (i.assignee) set.add(i.assignee); }
  else if (ev.type === 'sla') { for (const x of [i.assignee, i.reporter]) if (x) set.add(x); } // v2.887 담당자 · 보고자(+ 팀 채팅)
  set.delete(ev.actor);
  const out = [];
  for (const u of set) {
    if (viewers.canSee(u, i.vcenterId || '')) out.push(u);
    else status.outOfScope += 1;
  }
  return out;
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; flushIssueNotify().catch((e) => console.warn(`[issues] 알림 발송 실패: ${e?.message || e}`)); }, BATCH_MS);
  timer.unref?.();
}

/** 사람 한 명의 묶음에 줄 하나(상한 · 사람 수 상한 — 이슈 · 위키 공용). */
function pushLine(u, line) {
  let p = pending.get(u);
  if (!p) {
    if (pending.size >= RECIP_MAX) { if (!droppedNow.has(u)) { droppedNow.add(u); status.dropped += 1; } return; }
    p = { lines: [], extra: 0 }; pending.set(u, p);
  }
  p.lines.push(line);
  if (p.lines.length > LINES_MAX) { p.extra += p.lines.length - LINES_MAX; p.lines = p.lines.slice(-LINES_MAX); }
}

/**
 * 위키 이벤트(v2.881 — 문서 저장 · 댓글 · @멘션) → 사람별 묶음. 받는 사람: 지켜보는 사람 + 새로 언급된 사람(+ 댓글이면 만든 사람) · 본인 제외 ·
 * **그 스페이스(법인)를 볼 수 있는 사람만**(이슈와 같은 판정 — visibility.js). 팀 채팅에는 싣지 않는다(문서 편집은 채널 소음이 크다).
 */
export function queueWikiEvent(ev, settings = loadIssueSettings(), viewers = issueViewers()) {
  const n = settings?.notify;
  if (!n?.enabled || n.events?.wiki === false) return 0;
  const pg = ev.page || {};
  const parts = [...(pg.watchers || []), ...(ev.type === 'comment' && pg.createdBy ? [pg.createdBy] : [])].filter(Boolean);
  const known = new Set([...viewers.localNames, ...(n.people || []).map((p) => p.username), ...parts]);
  const set = new Set(ev.type === 'created' ? [] : parts);
  const mentioned = new Set(resolveMentions(ev.mentions, known));
  for (const m of mentioned) set.add(m);
  set.delete(ev.actor);
  const head = `[위키] ${capStr(pg.title || '', 120)}`;
  let count = 0;
  for (const u of set) {
    if (!viewers.canSee(u, pg.vcenterId || '')) { status.outOfScope += 1; continue; }
    const tag = mentioned.has(u) ? '에서 언급했습니다' : '';
    const line = ev.type === 'comment' ? `${head} — 댓글${tag ? ` · ${tag}` : ''} · ${ev.actor}: ${capStr(ev.excerpt || '', 160)}`
      : ev.type === 'saved' ? `${head} — v${ev.version} 고침${tag ? ` · 본문${tag}` : ''} · ${ev.actor}${ev.note ? `: ${capStr(ev.note, 120)}` : ''}`
        : `${head} — 새 문서${tag ? ` · 본문${tag}` : ''} · ${ev.actor}`;
    pushLine(u, line); count += 1;
  }
  if (count) schedule();
  return count;
}

/** 이벤트 하나를 묶음에 넣는다(라우트·기한 검사가 부른다 — 저장소 훅이 연결한다). */
export function queueIssueEvent(ev) {
  const settings = loadIssueSettings();
  if (!eventOn(ev, settings)) return 0;
  const who = recipientsOf(ev, settings);
  for (const u of who) pushLine(u, lineOf(ev, u));
  // 팀 채팅은 개인 수신자와 따로다(감사 A2-03 — 받을 사람이 없는 이벤트(예: 담당자 없는 새 요청)도 팀 채널에는 간다). 문구는 chatSafe(A3-03).
  if (settings.notify.chat) {
    chatLines.push(chatSafe(lineOf(ev, '')));
    if (chatLines.length > LINES_MAX) { chatExtra += chatLines.length - LINES_MAX; chatLines = chatLines.slice(-LINES_MAX); }
  }
  if ((ev.type === 'due' || ev.type === 'sla') && ev.dueDay && ev.issue?.key) pendingDue.set(ev.markKey || ev.issue.key, ev.dueDay); // v2.887 SLA 는 'sla:<키>:<단계>'
  if (who.length || settings.notify.chat || pendingDue.size) schedule();
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

/** 쌓인 묶음을 지금 보낸다(타이머·시험). 던지지 않는다. 겹쳐 부르면 진행 중인 것을 기다린 뒤 한 번 더 돈다(감사 A5-03). */
export async function flushIssueNotify() {
  if (flushing) { await flushing.catch(() => {}); }
  flushing = flushOnce();
  try { return await flushing; } finally { flushing = null; }
}
async function flushOnce() {
  if (timer) { clearTimeout(timer); timer = null; }
  const settings = loadIssueSettings();
  const batch = [...pending.entries()];
  pending.clear(); droppedNow.clear();
  const chat = chatLines; const cExtra = chatExtra;
  chatLines = []; chatExtra = 0;
  const dueMarks = new Map(pendingDue); pendingDue.clear();
  status.lastFlushAt = Date.now();
  // 감사 A2-05: 쌓인 뒤 알림을 껐으면 보내지 않는다(버린다 — 끈 사람의 뜻이 우선).
  if (!settings.notify?.enabled) { if (dueMarks.size) writeDueMarks(dueMarks); return { recipients: 0, chat: 0, discarded: batch.length }; }
  let deferred = 0;
  if (settings.notify?.mail !== false) {
    for (const [u, p] of batch) {
      const email = emailOf(settings, u);
      if (!email) { status.noEmail += 1; continue; }
      if (mailRoom() <= 0) {
        // 이슈 몫을 다 썼다 — 버리지 않고 다음 묶음으로 미룬다(새로 쌓인 줄 앞에 붙인다).
        const q = pending.get(u) || { lines: [], extra: 0 };
        const lines = [...p.lines, ...q.lines];
        pending.set(u, { lines: lines.slice(-LINES_MAX), extra: p.extra + q.extra + Math.max(0, lines.length - LINES_MAX) });
        deferred += 1; continue;
      }
      const { text, html } = mailBody(u, p.lines, p.extra);
      try {
        mailSentAt.push(Date.now());
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
      const okN = lines.filter((l) => /^[a-z]+:2\d\d\b/i.test(l)).length;
      // 감사 A4-05: 채널마다 센다 — 하나라도 실패면 실패도 센다(부분 성공을 전체 성공으로 보이지 않게).
      if (okN) status.chat += 1;
      if (lines.length && okN < lines.length) { status.chatFail += 1; status.lastError = `채팅: ${lines.filter((l) => !/^[a-z]+:2\d\d\b/i.test(l)).join(' · ').slice(0, 200)}`; console.warn(`[issues] 이슈 채팅 알림 실패: ${status.lastError}`); }
      else if (!lines.length) { status.lastError = '채팅 채널이 꺼져 있어 보내지 않았습니다(설정 › 알림)'; }
    } catch (e) { status.chatFail += 1; status.lastError = String(e?.message || e).slice(0, 200); }
  }
  if (deferred) {
    status.mailDeferred += deferred;
    status.lastError = `이슈 메일 시간당 몫(${issueMailBudget()}통 — 메일 설정 한도의 절반)을 다 써서 ${deferred}명의 메일을 다음 묶음으로 미뤘습니다`;
    schedule();
  }
  // 기한 알림 기록은 보낸 뒤에 쓴다 — 보내기 전에 포탈이 멈추면 기록이 없어 다음 기동 검사가 다시 보낸다(감사 A2-02).
  if (dueMarks.size) writeDueMarks(dueMarks);
  return { recipients: batch.length, chat: chat.length, deferred };
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
    const d = dueDays(r.dueAt, now);
    // 기한이 오늘·내일(포탈 날짜)이거나 지났을 때 — 화면의 '오늘'·'내일'·'초과' 와 같은 기준(감사 A4-03).
    if (!r.assignee || d == null || d > 1) continue;
    if (s[r.key] === today || pendingDue.get(r.key) === today) continue;
    queueIssueEvent({ type: 'due', actor: '', overdue: d < 0, dueDay: today, issue: { key: r.key, title: r.title, assignee: r.assignee, dueAt: r.dueAt, vcenterId: r.vcenterId || '' } });
    n += 1;
  }
  // 오래된 기록 정리(며칠 지난 날짜) — 표가 끝없이 자라지 않게.
  const cut = dayKey(now - STATE_KEEP_DAYS * 86_400_000);
  for (const [k, v] of Object.entries(s)) if (!k.startsWith('sla:') && v < cut) { delete s[k]; changed = true; } // SLA 기록은 scanSla 가 정리한다
  if (changed) saveDueState(s);
  status.dueSent += n;
  return n;
}

/**
 * v2.887 SLA 초과 알림 — 열린 이슈의 응답 · 해결 단계가 목표를 넘으면 **단계마다 한 번** 담당자 · 보고자(+ 팀 채팅)에게.
 * 기록 'sla:<키>:<단계>' 는 보낸 뒤에 쓰고(기한 알림과 같은 규칙), 더는 넘은 상태가 아니면(완료 · 우선순위 변경 · 목표 변경) 지운다 —
 * 다시 열려 또 넘으면 다시 알린다. SLA · 알림 · 이 이벤트 중 하나라도 꺼져 있으면 보내지 않는다(기록도 그대로 둔다).
 */
export function scanSla(now = Date.now()) {
  const settings = loadIssueSettings();
  if (!settings.sla?.enabled || !settings.notify?.enabled || settings.notify.events?.sla === false) return 0;
  const today = dayKey(now);
  const s = loadDueState();
  const live = new Set();
  let n = 0;
  for (const r of listIssues({ done: 'open', limit: 100_000, now }).rows) {
    const sla = r.sla;
    if (!sla) continue;
    for (const kind of ['respond', 'resolve']) {
      const st0 = sla[kind];
      if (st0?.state !== 'breached') continue;
      const mk = `sla:${r.key}:${kind}`;
      live.add(mk);
      if (s[mk] || pendingDue.has(mk)) continue;
      queueIssueEvent({ type: 'sla', actor: '', kind, dueDay: today, markKey: mk, targetMin: st0.targetMin, usedMin: st0.usedMin,
        issue: { key: r.key, title: r.title, assignee: r.assignee, reporter: r.reporter, vcenterId: r.vcenterId || '' } });
      n += 1;
    }
  }
  let changed = false;
  for (const k of Object.keys(s)) if (k.startsWith('sla:') && !live.has(k)) { delete s[k]; changed = true; }
  if (changed) saveDueState(s);
  status.slaSent += n;
  return n;
}
function saveDueState(s) {
  try { atomicWriteFileSync(stateFile(), JSON.stringify({ sent: s }), { mode: 0o600 }); } catch (e) { console.warn(`[issues] 기한 알림 기록을 쓰지 못했습니다: ${e?.code || e?.message}`); }
}
function writeDueMarks(marks) {
  const s = loadDueState();
  for (const [k, v] of marks) s[k] = v;
  saveDueState(s);
}

/** 화면용 상태(계정명·주소 없음). */
export function issueNotifyStatus() {
  return { ...status, pendingRecipients: pending.size, pendingChat: chatLines.length, batchMs: BATCH_MS };
}

/* ───── 저장 필터 주간 메일(v2.883 · 시안 ⑧) ─────
 * 월요일 09:00(포탈 날짜) 뒤 첫 검사에서 구독자마다 한 통 — 결과는 **받는 사람의 조회 범위**로 다시 거른다(구독 · 공유가 범위를 넓히지 않는다).
 * 로컬 계정은 그 계정의 범위, 로컬이 아닌 이름(AD)은 범위 축이 없어 전체(visibility.js 와 같은 판단), 데모 계정은 보내지 않는다.
 * 알림이 꺼져 있거나 메일이 꺼져 있으면 보내지 않는다. 이슈 메일 몫(mailRoom)을 같이 쓰고, 몫이 없으면 다음 검사로 미룬다(기록을 쓰지 않는다).
 * 기록 `issue-filter-mail-state.json`(상태 파일) — '필터|사람' → 보낸 포탈 날짜. 보낸 뒤에만 쓴다.
 */
export const WEEKLY_ROWS = 50;
const WEEKLY_NAME = registerStateFile('issue-filter-mail-state.json');
const weeklyFile = () => path.join(config.configDir, WEEKLY_NAME);
let weeklyState = null;
function loadWeekly() {
  if (weeklyState) return weeklyState;
  weeklyState = {};
  try {
    if (fs.existsSync(weeklyFile())) {
      const j = JSON.parse(fs.readFileSync(weeklyFile(), 'utf8'));
      if (j && typeof j.sent === 'object' && !Array.isArray(j.sent)) for (const [k, v] of Object.entries(j.sent)) if (typeof v === 'string') weeklyState[k] = v;
    }
  } catch (e) { preserveCorrupt(weeklyFile(), e.message); weeklyState = {}; }
  return weeklyState;
}
function saveWeekly(s) {
  try { atomicWriteFileSync(weeklyFile(), JSON.stringify({ sent: s }), { mode: 0o600 }); } catch (e) { console.warn(`[issues] 필터 주간 메일 기록을 쓰지 못했습니다: ${e?.code || e?.message}`); }
}
const DUE_TXT = (ms) => (ms ? dayKey(ms) : '기한 없음');
function weeklyBody(username, f, list) {
  const rows = list.rows || [];
  const more = Math.max(0, (list.total || 0) - rows.length);
  const text = `${username} 님, 저장 필터 ‘${f.name}’ — ${list.total}건\n검색식: ${f.query}\n\n${rows.map((r) => `· ${r.key} [${st(r.status)}] ${r.title}${r.assignee ? ` — ${r.assignee}` : ''}`).join('\n')}${more ? `\n· 외 ${more}건` : ''}\n\n포탈 › 이슈 › 필터에서 확인하세요.`;
  const tr = rows.map((r) => `<tr><td style="padding:3px 8px;font-family:monospace;">${esc(r.key)}</td><td style="padding:3px 8px;">${esc(st(r.status))}</td><td style="padding:3px 8px;">${esc(r.title)}</td><td style="padding:3px 8px;">${esc(r.assignee || '미할당')}</td><td style="padding:3px 8px;">${esc(DUE_TXT(r.dueAt))}</td></tr>`).join('');
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Malgun Gothic',sans-serif;max-width:760px;padding:16px;color:#101828;">
  <h2 style="margin:0 0 6px;font-size:16px;">저장 필터 ‘${esc(f.name)}’ — ${list.total}건</h2>
  <div style="color:#667085;font-size:12px;margin-bottom:10px;font-family:monospace;">${esc(f.query)}</div>
  <table style="border-collapse:collapse;font-size:12.5px;color:#344054;"><tr style="background:#f2f4f7;"><th style="padding:3px 8px;text-align:left;">키</th><th style="padding:3px 8px;text-align:left;">상태</th><th style="padding:3px 8px;text-align:left;">제목</th><th style="padding:3px 8px;text-align:left;">담당자</th><th style="padding:3px 8px;text-align:left;">기한</th></tr>${tr}</table>
  ${more ? `<div style="font-size:12px;margin-top:6px;">외 ${more}건 — 포탈에서 확인하세요.</div>` : ''}
  <div style="color:#667085;font-size:11.5px;margin-top:16px;border-top:1px solid #eaecf0;padding-top:10px;">VMware Global Monitoring Portal — 이슈 › 필터에서 구독을 끌 수 있습니다. 결과는 받는 분이 볼 수 있는 법인의 이슈만입니다.</div>
</div>`;
  return { text, html };
}
/** 받는 사람의 조회 범위(로컬 계정) — AD 등 로컬이 아닌 이름은 null(전체), 데모 계정은 false(보내지 않음). */
function accessFor(name, byName, snap) {
  const u = byName.get(name);
  if (!u) return { read: null, write: null };
  if (u.demo) return false;
  return { read: scopedVcenterIds(u, snap), write: null };
}
/** @returns {Promise<{ sent: number, skipped: number, deferred: number }>} */
export async function scanWeeklyFilters(now = Date.now()) {
  const out = { sent: 0, skipped: 0, deferred: 0 };
  const parts = portalParts(now);
  if (parts.dow !== 1 || parts.h < 9) return out;
  const settings = loadIssueSettings();
  if (!settings.notify?.enabled || settings.notify?.mail === false) return out;
  const today = dayKey(now);
  const sent = loadWeekly();
  const snap = store.get();
  let users = [];
  try { users = listUsers(); } catch { users = []; }
  const byName = new Map(users.filter((u) => u?.username).map((u) => [u.username, u]));
  let changed = false;
  for (const f of subscribedFilters()) {
    for (const u of f.subscribers) {
      const mark = `${f.id}|${u}`;
      if (sent[mark] === today) continue;
      const email = emailOf(settings, u);
      const access = accessFor(u, byName, snap);
      if (!email || access === false) { out.skipped += 1; if (!email) status.noEmail += 1; continue; }
      if (mailRoom(now) <= 0) { out.deferred += 1; continue; }
      let list;
      try {
        const vcs = (snap?.vcenters || []).filter((v) => v?.id && (!access.read || access.read.has(v.id))).map((v) => ({ id: v.id, name: v.name || v.id }));
        list = listIssues({ query: f.query, access, me: u, limit: WEEKLY_ROWS, now, ctx: queryContext({ me: u, now, vcenters: vcs }) });
      } catch (e) { out.skipped += 1; status.lastError = `필터 ‘${capStr(f.name, 40)}’ 주간 메일: ${String(e?.message || e).slice(0, 160)}`; continue; }
      const { text, html } = weeklyBody(u, f, list);
      try {
        mailSentAt.push(Date.now());
        const r = await senders.mail({ kind: 'issues', to: [email], subject: `[이슈] 주간 필터 — ${capStr(f.name, 60)} ${list.total}건`, html, text });
        if (r?.ok) { status.mails += 1; out.sent += 1; sent[mark] = today; changed = true; }
        else if (r?.skipped) { status.mailSkip += 1; status.lastError = r.reason || '메일 발송을 건너뛰었습니다'; out.skipped += 1; }
        else { status.mailFail += 1; status.lastError = r?.reason || '메일 발송 실패'; out.skipped += 1; }
      } catch (e) { status.mailFail += 1; status.lastError = String(e?.message || e).slice(0, 200); out.skipped += 1; }
    }
  }
  // 오래된 기록 정리(3주 넘게 지난 것)
  const cut = dayKey(now - 21 * 86_400_000);
  for (const [k, v] of Object.entries(sent)) if (v < cut) { delete sent[k]; changed = true; }
  if (changed) saveWeekly(sent);
  status.weeklySent = (status.weeklySent || 0) + out.sent;
  if (out.deferred) status.mailDeferred += out.deferred;
  return out;
}

/* ───── 시작 ───── */
let started = false;
let dueTimer = null;
/** 저장소 이벤트를 구독하고 기한 검사를 돌린다(index.js 가 기동 때 한 번). */
export function startIssueNotify() {
  if (started) return;
  started = true;
  onIssueEvent((ev) => queueIssueEvent(ev));
  // v2.881 위키 문서 저장 · 댓글 알림 — 같은 묶음 · 같은 범위 판정
  import('../wiki/store.js').then(({ onWikiEvent }) => onWikiEvent((ev) => queueWikiEvent(ev))).catch((e) => console.warn(`[issues] 위키 알림 연결 실패: ${String(e?.message || e).slice(0, 160)}`));
  const scan = () => {
    try { scanDue(); } catch (e) { console.warn(`[issues] 기한 알림 검사 실패: ${e?.message || e}`); }
    try { scanSla(); } catch (e) { console.warn(`[issues] SLA 알림 검사 실패: ${String(e?.message || e).slice(0, 160)}`); } // v2.887
    scanWeeklyFilters().catch((e) => console.warn(`[issues] 필터 주간 메일 실패: ${String(e?.message || e).slice(0, 160)}`)); // v2.883
  };
  dueTimer = setInterval(scan, DUE_SCAN_MS);
  dueTimer.unref?.();
  // 기동 뒤 한 번(감사 A2-02·A5-04) — 30분을 기다리지 않는다. 재기동 직전 묶음에 있던 일반 이벤트(할당·상태·댓글)는 메모리에만 있어
  // 되살릴 수 없다(종료 때 비동기 발송을 기다릴 수 없다) — 기한 알림만 기록이 '보낸 뒤' 라 다시 보낸다.
  const first = setTimeout(scan, STARTUP_SCAN_MS);
  first.unref?.();
}
/** 테스트 전용. */
export function _resetIssueNotifyForTest() {
  pending.clear(); chatLines = []; chatExtra = 0; dueState = null; weeklyState = null; pendingDue.clear(); droppedNow.clear(); mailSentAt.length = 0;
  if (timer) { clearTimeout(timer); timer = null; }
  for (const k of Object.keys(status)) status[k] = typeof status[k] === 'number' ? 0 : null;
}
