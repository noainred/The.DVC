/**
 * issues/automation.js — 이슈 자동화 규칙(v2.908 · 기능 추천 6 · 시안 docs/design/wiki-issues ⑪ '자동화 규칙' — 고정 목록, 자유 스크립트 없음).
 *
 * 규칙(이슈 설정 › 자동화 — settings.js defaultAutomation, 기본 전부 꺼짐):
 *  · wikiCheck — 이슈가 완료되면 그 키를 적은 위키 체크리스트 항목을 체크(wiki/store.js checkIssueTasks) — v2.927 부터 이슈의 법인 스페이스 + 공용만.
 *  · childrenReview — 하위 작업이 모두 완료되면 상위를 '검토' 로(store.js parentReadyForReview → setStatus · 이력 메모 '자동화: …').
 *  · p0Chat — 유형 장애 · P0 이슈가 만들어지면 팀 채팅에 바로(묶음을 기다리지 않는다 — 설정 › 알림의 Slack · 웹훅 · Teams).
 *  · stale — 30분 검사(notify.js scanStale)와 목록 배지(store.js staleDaysOf)가 한다 — 여기서는 하지 않는다.
 *
 * 이벤트는 저장소가 **동기로** 내므로(store.js emit) 여기서는 setImmediate 로 미뤄 돈다 — 상위를 한꺼번에 완료하는 도중(closeChildren)에
 * 자식 완료 이벤트가 상위를 '검토' 로 되돌리지 않게(미룬 뒤에는 상위가 이미 완료라 건너뛴다). 던지지 않는다 — 실패는 status 에 센다.
 */
import { onIssueEvent, setStatus, parentReadyForReview } from './store.js';
import { loadIssueSettings } from './settings.js';
import { checkIssueTasks } from '../wiki/store.js';
import { lineOf, chatSafe } from './notify.js';
import { capStr } from '../util/capStr.js';

export const AUTOMATION_USER = 'automation';
const freshStatus = () => ({ wikiChecked: 0, wikiPages: 0, wikiOutOfScope: 0, reviewed: 0, p0Chat: 0, p0ChatFail: 0, errors: 0, error: null, ranAt: null });
const status = freshStatus();
export function automationStatus() { return { ...status }; }

async function realChat(text, title) { const { sendChatText } = await import('../alerts.js'); return sendChatText(text, title); }
let chat = realChat;
/** 테스트 전용 — 채팅 발송을 바꾼다. */
export function _setAutomationChatForTest(fn = null) { chat = fn || realChat; }

/** 이벤트 하나에 규칙을 돈다(테스트가 직접 부른다). */
export async function runAutomation(ev, settings = loadIssueSettings()) {
  const a = settings?.automation || {};
  const i = ev?.issue || {};
  if (!i.key) return;
  status.ranAt = Date.now();
  const fail = (what, e) => { status.errors += 1; status.error = `${what} ${i.key}: ${String(e?.message || e).slice(0, 160)}`; console.warn(`[issues] 자동화 규칙 실패(${status.error})`); };
  if (ev.type === 'status' && ev.to === 'done') {
    if (a.wikiCheck) {
      // v2.927(사용자 선택): 이슈의 법인 스페이스 + 공용 스페이스만 — 다른 법인 문서는 세기만 한다
      try { const r = checkIssueTasks(i.key, AUTOMATION_USER, { vcenterId: i.vcenterId || '' }); status.wikiChecked += r.items; status.wikiPages += r.pages; status.wikiOutOfScope += r.outOfScope; } catch (e) { fail('위키 체크', e); }
    }
    if (a.childrenReview) {
      try {
        const pk = parentReadyForReview(i.key);
        if (pk) { setStatus(pk, 'review', AUTOMATION_USER, { note: `자동화: 하위 작업이 모두 완료(마지막 ${i.key})` }); status.reviewed += 1; }
      } catch (e) { fail('상위 검토', e); }
    }
  }
  if (ev.type === 'created' && a.p0Chat && i.priority === 'p0' && i.type === 'incident') {
    try {
      const res = await chat(chatSafe(`P0 장애 등록 — ${capStr(lineOf({ ...ev, type: 'p0' }, ''), 300)}${i.vcenterId ? ` · 법인 ${i.vcenterId}` : ''}${i.assignee ? ` · 담당 ${i.assignee}` : ' · 미할당'} · ${ev.actor}`), '이슈 트래커 — P0 즉시');
      const lines = Array.isArray(res) ? res.map(String) : [];
      if (lines.some((l) => /^[a-z]+:2\d\d\b/i.test(l))) status.p0Chat += 1;
      else { status.p0ChatFail += 1; status.error = lines.length ? `P0 채팅: ${lines.join(' · ').slice(0, 160)}` : 'P0 채팅: 채팅 채널이 꺼져 있습니다(설정 › 알림)'; }
    } catch (e) { status.p0ChatFail += 1; fail('P0 채팅', e); }
  }
}

let started = false;
/** index.js 가 기동 때 한 번. */
export function startIssueAutomation() {
  if (started) return;
  started = true;
  onIssueEvent((ev) => {
    if (ev?.type !== 'status' && ev?.type !== 'created') return;
    setImmediate(() => { runAutomation(ev).catch((e) => { status.errors += 1; status.error = String(e?.message || e).slice(0, 160); }); });
  });
}
/** 테스트 전용. */
export function _resetAutomationForTest() { Object.assign(status, freshStatus()); chat = realChat; }
