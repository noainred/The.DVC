/**
 * mentionText.js — 댓글 @멘션 자동완성의 순수 판정(v2.905 · 시안 docs/design/wiki-mention ①②).
 *
 * 멘션 토큰의 끝 판정은 서버 `issues/store.js mentionsOf`(`(?:^|[\s(])@([^\s@,()]{1,64})`)와 같다 — 글에 넣는 '@계정/이름' 은
 * 서버가 가장 긴 접두로 계정만 풀어 알림을 보낸다(`issues/notify.js resolveMentions`). 이름에서는 공백 · 멘션을 끊는 글자를 뺀다(서버 `mentionText` 와 같은 규칙).
 */
export const MENTION_TOKEN_MAX = 64;
const TOKEN_CH = /[^\s@,()]/;

/** 커서 바로 앞이 '@검색어' 인가 — { start(＠ 위치), q } 또는 null. '@' 앞은 줄 머리 · 공백 · '(' 여야 한다(메일 주소 a@b 는 아니다). */
export function mentionQueryAt(text, caret) {
  const s = String(text ?? '');
  const end = Math.max(0, Math.min(Number.isInteger(caret) ? caret : s.length, s.length));
  let i = end;
  while (i > 0 && end - i <= MENTION_TOKEN_MAX && TOKEN_CH.test(s[i - 1])) i -= 1;
  if (i === 0 || s[i - 1] !== '@') return null;
  const at = i - 1;
  if (at > 0 && !/[\s(]/.test(s[at - 1])) return null;
  const q = s.slice(i, end);
  if (q.length > MENTION_TOKEN_MAX || q.includes('/')) return null; // 이미 '@계정/이름' 으로 넣은 토큰을 고치는 중이면 목록을 열지 않는다
  return { start: at, q };
}

/** 고른 사람을 '@계정/이름 ' 으로 넣는다. */
export function mentionText(username, name = '') {
  const n = String(name || '').replace(/[\s@,()[\]*`~/]/g, '').slice(0, 30);
  return n && n !== username ? `@${username}/${n}` : `@${username}`;
}
/** '@검색어' 자리를 고른 사람으로 바꾼다 — { text, caret }. 자리를 못 찾으면 null. */
export function applyMention(text, caret, cand) {
  const m = mentionQueryAt(text, caret);
  if (!m || !cand?.username) return null;
  const s = String(text ?? '');
  const ins = `${mentionText(cand.username, cand.name)} `;
  const next = s.slice(0, m.start) + ins + s.slice(caret).replace(/^[^\s@,()]*/, '').replace(/^ /, '');
  return { text: next, caret: m.start + ins.length };
}

/** 글 속 멘션(서버 mentionsOf 와 같은 정규식 · 10명) → [{ token, user, name }]. user 는 '/' 앞(계정), name 은 뒤. */
export function mentionsInText(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text ?? '').slice(0, 20_000).matchAll(/(?:^|[\s(])@([^\s@,()]{1,64})/g)) {
    const token = m[1];
    const slash = token.indexOf('/');
    const user = (slash > 0 ? token.slice(0, slash) : token).replace(/[.,]+$/, '');
    if (!user || seen.has(user)) continue;
    seen.add(user);
    out.push({ token, user, name: slash > 0 ? token.slice(slash + 1) : '' });
    if (out.length >= 10) break;
  }
  return out;
}
