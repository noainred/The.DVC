/**
 * issues/inbox.js — 포탈 안 알림함(v2.908 · 기능 추천 9 · 사용자 '모두 적용' — 기존 화면 틀대로). 파일 `issue-inbox.json`(상태 파일).
 *
 * 왜: 이슈 · 위키 알림은 메일(이슈 설정의 사람 → 주소 표)과 팀 채팅뿐이라 주소 표에 없는 사람은 언급 · 할당을 아무 데서도 받지 못했다.
 *   알림함은 **받을 사람 판정(notify.js recipientsOf · 위키 수신자)을 그대로** 쓰고 줄을 사람마다 쌓아 둔다 — 메일 · 채팅 스위치와 따로다
 *   (끄려면 이슈 설정 › 알림 › '포탈 알림함'). 밖으로 나가는 것이 없어서 기본은 켬이다.
 *
 *  · 사람마다 최근 PER_USER(100)줄 · KEEP_DAYS(30)일 — 넘으면 오래된 것부터 버리고 센다(dropped). 사람 수 상한 USERS_MAX(2,000).
 *    v2.927(점검 B1-04 — 재현): 예전에는 상한에 한 번 닿으면 사람 항목을 지우는 곳이 없어 **영구히** 새 사람이 알림함을 받지 못했다(임의 관찰자
 *    이름 50명짜리 이슈 41건으로 채울 수 있었다). 이제 새 사람 자리가 없으면 ① 줄이 비었거나 모두 기한이 지난 사람을 치우고(pruned)
 *    ② 그래도 없으면 **가장 오래 쉰 사람**(마지막 줄 시각 · 마지막으로 알림함을 연 시각 중 늦은 것이 가장 이른 사람) 하나를 내보낸다(evicted).
 *    받는 이름을 로컬 계정으로 좁히지 않는다 — 주소 표에 없는 AD 사용자에게 알림을 주는 것이 알림함의 존재 이유다.
 *  · 줄에는 법인(vcenterId)을 같이 적고 **읽을 때 지금 범위로 다시 거른다** — 범위가 줄어든 계정이 예전에 받은 범위 밖 줄을 보지 않게.
 *    법인이 없는 줄(공용 이슈 · 공용 위키)도 범위 계정에게는 보이지 않는다(v2.927 점검 B1-05 — 판정은 라우트가 넘기는 canSee).
 *  · 쓰기는 디바운스(WRITE_DELAY_MS) + 원자적 쓰기. 손상은 보존하고 빈 알림함으로 읽는다(상태라 잃어도 기능은 돈다).
 *  · 본문은 문구(lineOf)만 — 메일 주소 · 비밀은 싣지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';
import { capStr } from '../util/capStr.js';

export const INBOX_LIMITS = Object.freeze({ perUser: 100, users: 2000, keepDays: 30, text: 400 });
export const INBOX_WRITE_DELAY_MS = 500;
const NAME = registerStateFile('issue-inbox.json');
const fileOf = () => path.join(config.configDir, NAME);
const KINDS = Object.freeze(['assigned', 'status', 'progress', 'comment', 'mention', 'due', 'sla', 'stale', 'wiki', 'created']);
const KEY_RE = /^ISS-\d{1,9}$/;
const PAGE_RE = /^W\d{1,9}$/;

let cache = null; // { users: Map<username, item[]>, seen: Map<username, ms> }
let timer = null;
const counters = { dropped: 0, usersFull: 0, pruned: 0, evicted: 0, writeFail: 0, lastError: null };
const keepMs = () => INBOX_LIMITS.keepDays * 86_400_000;

function load() {
  if (cache) return cache;
  cache = { users: new Map(), seen: new Map() };
  const f = fileOf();
  try {
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const u = j && typeof j.users === 'object' && !Array.isArray(j.users) ? j.users : {};
      const cut = Date.now() - keepMs();
      for (const [name, list] of Object.entries(u).slice(0, INBOX_LIMITS.users)) {
        if (!Array.isArray(list)) continue;
        // v2.927(점검 B1-04): 기한이 지난 줄은 읽을 때 버리고, 남은 줄이 없는 사람은 자리를 차지하지 않는다
        const keep = list.filter((x) => x && typeof x.id === 'string' && typeof x.text === 'string' && Number.isFinite(x.at) && x.at >= cut).slice(-INBOX_LIMITS.perUser);
        if (keep.length) cache.users.set(name, keep);
      }
      const seen = j && typeof j.seen === 'object' && !Array.isArray(j.seen) ? j.seen : {};
      for (const [name, at] of Object.entries(seen)) if (cache.users.has(name) && Number.isFinite(at)) cache.seen.set(name, at);
    }
  } catch (e) { preserveCorrupt(f, e.message); cache = { users: new Map(), seen: new Map() }; }
  return cache;
}
/** 마지막 활동 — 마지막 줄 시각과 마지막으로 알림함을 연 시각 중 늦은 것. */
const lastActive = (c, name, list) => Math.max(list.length ? list[list.length - 1].at : 0, c.seen.get(name) || 0);
/**
 * v2.927(점검 B1-04): 새 사람 자리 만들기 — ① 비었거나 모든 줄이 기한(KEEP_DAYS)을 넘은 사람을 치운다 ② 그래도 상한이면 가장 오래 쉰 사람 하나를
 * 내보낸다. 사람 수(2,000)만큼 한 번 훑는다(줄은 시각 순으로 쌓이므로 마지막 줄만 본다).
 */
function makeRoom(c, now) {
  const cut = now - keepMs();
  for (const [name, list] of c.users) {
    if (!list.length || list[list.length - 1].at < cut) { c.users.delete(name); c.seen.delete(name); counters.pruned += 1; }
  }
  if (c.users.size < INBOX_LIMITS.users) return;
  let victim = null; let oldest = Infinity;
  for (const [name, list] of c.users) { const t = lastActive(c, name, list); if (t < oldest) { oldest = t; victim = name; } }
  if (victim != null) { c.users.delete(victim); c.seen.delete(victim); counters.evicted += 1; }
}
function scheduleWrite() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; flushInboxNow(); }, INBOX_WRITE_DELAY_MS);
  timer.unref?.();
}
/** 지금 쓴다(종료 · 테스트). 던지지 않는다. */
export function flushInboxNow() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!cache) return;
  try { atomicWriteFileSync(fileOf(), JSON.stringify({ v: 1, users: Object.fromEntries(cache.users), seen: Object.fromEntries(cache.seen) }), { mode: 0o600 }); }
  catch (e) { counters.writeFail += 1; counters.lastError = String(e?.code || e?.message || e).slice(0, 120); console.warn(`[issues] 알림함을 쓰지 못했습니다: ${counters.lastError}`); }
}

/**
 * 한 사람에게 한 줄. item = { kind, text, key?, pageId?, vcenterId?, actor? }. 쌓았으면 true.
 * 같은 사람 · 같은 대상 · 같은 문구가 1분 안에 또 오면 하나로 친다(같은 변경이 두 경로로 와도 두 줄이 되지 않게).
 */
export function addInbox(username, item, { now = Date.now() } = {}) {
  const u = String(username || '').trim();
  if (!u || u.length > 64 || !item || typeof item.text !== 'string' || !item.text.trim()) return false;
  const c = load();
  let list = c.users.get(u);
  if (!list) {
    if (c.users.size >= INBOX_LIMITS.users) makeRoom(c, now);
    if (c.users.size >= INBOX_LIMITS.users) { counters.usersFull += 1; return false; }
    list = []; c.users.set(u, list);
  }
  const x = {
    id: crypto.randomBytes(6).toString('hex'), at: now, kind: KINDS.includes(item.kind) ? item.kind : 'status',
    text: capStr(String(item.text).replace(/[\r\n]+/g, ' '), INBOX_LIMITS.text),
    key: KEY_RE.test(String(item.key || '')) ? item.key : '', pageId: PAGE_RE.test(String(item.pageId || '')) ? item.pageId : '',
    vcenterId: capStr(String(item.vcenterId || ''), 128), actor: capStr(String(item.actor || ''), 64), read: false,
  };
  const last = list[list.length - 1];
  if (last && !last.read && last.text === x.text && last.key === x.key && last.pageId === x.pageId && now - last.at < 60_000) return false;
  list.push(x);
  const cut = now - keepMs();
  let drop = 0;
  while (list.length && (list.length > INBOX_LIMITS.perUser || list[0].at < cut)) { list.shift(); drop += 1; }
  counters.dropped += drop;
  scheduleWrite();
  return true;
}

/**
 * 내 알림함 — canSee(vcenterId) 로 지금 범위에서 다시 거른다(법인 없는 줄 '' 도 canSee 가 판정한다 — 범위 계정은 공용 줄을 보지 않는다 ·
 * v2.927 점검 B1-05 에서 이 주석의 '공용은 누구나' 를 정정). 최신 먼저.
 * 연 시각을 메모리에 남긴다(가장 오래 쉰 사람 판정 — 파일에는 다음 쓰기 때 함께 실린다. 폴링마다 파일을 쓰지 않는다).
 * @returns {{ items: object[], unread: number, total: number }}
 */
export function listInbox(username, { canSee = () => true, limit = 50, unreadOnly = false, now = Date.now() } = {}) {
  const c = load();
  const name = String(username || '');
  if (c.users.has(name)) c.seen.set(name, now);
  const list = (c.users.get(name) || []).filter((x) => canSee(x.vcenterId || ''));
  const unread = list.filter((x) => !x.read).length;
  const view = (unreadOnly ? list.filter((x) => !x.read) : list).slice().reverse().slice(0, Math.max(1, Math.min(100, Math.trunc(Number(limit)) || 50)));
  return { items: view.map(({ vcenterId, ...x }) => ({ ...x, scoped: !!vcenterId })), unread, total: list.length };
}
/** 읽음 표시 — ids 가 없으면 전부. 바뀐 수. */
export function markInboxRead(username, ids = null, { now = Date.now() } = {}) {
  const c = load();
  const name = String(username || '');
  const list = c.users.get(name);
  if (!list) return 0;
  c.seen.set(name, now);
  const want = Array.isArray(ids) ? new Set(ids.filter((s) => typeof s === 'string').slice(0, 200)) : null;
  let n = 0;
  for (const x of list) if (!x.read && (!want || want.has(x.id))) { x.read = true; n += 1; }
  if (n) scheduleWrite();
  return n;
}
/** 화면 · 점검용(계정명 없음). */
export function inboxStatus() {
  const c = load();
  let items = 0; let unread = 0;
  for (const l of c.users.values()) { items += l.length; unread += l.filter((x) => !x.read).length; }
  return { users: c.users.size, items, unread, ...counters, limits: INBOX_LIMITS };
}
/** 테스트 전용. */
export function _resetInboxForTest() { if (timer) { clearTimeout(timer); timer = null; } cache = null; Object.assign(counters, { dropped: 0, usersFull: 0, writeFail: 0, lastError: null }); }
