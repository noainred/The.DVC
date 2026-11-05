/**
 * views/wiki/wikiText.js — 위키 화면의 문구 · 판정 함수(순수, v2.881). 그리는 것은 Wiki.jsx · MdView.jsx.
 * 주소: #/wiki/<스페이스>[/<보기> | /<문서 id>[/edit|/history]] — 스페이스 id 는 vCenter id 라 콜론 등이 들어갈 수 있어 조각마다 인코딩한다.
 */
import { dateText, timeText, mbText } from '../issues/issueText.js';

export { dateText, timeText };
export const STATUS_ORDER = Object.freeze(['draft', 'review', 'approved', 'archived']);
export const STATUS_TEXT = Object.freeze({ draft: '초안', review: '검토 중', approved: '검토 완료', archived: '보관' });
export const statusText = (s) => STATUS_TEXT[s] || s || '—';
export const STALE_DAYS = 90;
export const MAX_DEPTH = 3;
const ID_RE = /^W\d{1,9}$/;
const VIEWS = Object.freeze(['home', 'search', 'new', 'settings', 'templates', 'tidy']); // v2.889 templates — 관리자 템플릿 · v2.906 tidy — 휴지통 · 깨진 링크

/* ───── 주소 ───── */
function dec(s) { try { return decodeURIComponent(s); } catch { return ''; } }
/** '#/wiki/…' → { space, view, id }. view: home · search · new · settings · page · edit · history. */
export function parseWikiHash(hash) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const qi = raw.indexOf('?');
  const segs = (qi >= 0 ? raw.slice(0, qi) : raw).split('/');
  const params = {};
  if (qi >= 0) {
    for (const part of raw.slice(qi + 1, qi + 1 + 600).split('&')) {
      const eq = part.indexOf('=');
      const k = dec(eq >= 0 ? part.slice(0, eq) : part);
      if (['q', 'parent', 'label', 'status', 'from', 'to'].includes(k)) params[k] = dec(eq >= 0 ? part.slice(eq + 1) : '').slice(0, 200);
    }
  }
  if (segs[0] !== 'wiki') return { space: '', view: 'home', id: '', params };
  const space = dec(segs[1] || '').slice(0, 128);
  const a = segs[2] || '';
  if (ID_RE.test(a)) {
    const b = segs[3] || '';
    return { space, view: b === 'edit' ? 'edit' : b === 'history' ? 'history' : 'page', id: a, params };
  }
  return { space, view: VIEWS.includes(a) ? a : 'home', id: '', params };
}
export function wikiHash({ space = '', view = 'home', id = '', params = null } = {}) {
  const sp = space ? `/${encodeURIComponent(space)}` : '';
  const qs = params ? Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
  const tail = qs ? `?${qs}` : '';
  if (id && ID_RE.test(id)) return `#/wiki${sp || '/pub'}/${id}${view === 'edit' ? '/edit' : view === 'history' ? '/history' : ''}${tail}`;
  if (view && view !== 'home' && VIEWS.includes(view)) return `#/wiki${sp || '/pub'}/${view}${tail}`;
  return `#/wiki${sp}${tail}`;
}

/* ───── 나무 ───── */
const byOrder = (a, b) => ((a.order ?? 0) - (b.order ?? 0)) || String(a.title).localeCompare(String(b.title));
/** 평평한 목록 → [{ page, children }] — 부모를 못 찾은 문서(범위 · 삭제)는 맨 위로 올린다(숨기지 않는다). */
export function buildTree(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const ids = new Set(list.map((p) => p.id));
  const kids = new Map();
  for (const p of list) {
    const parent = p.parentId && ids.has(p.parentId) && p.parentId !== p.id ? p.parentId : '';
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(p);
  }
  const seen = new Set();
  const build = (pid, depth) => (kids.get(pid) || []).sort(byOrder).filter((p) => !seen.has(p.id) && seen.add(p.id)).map((p) => ({ page: p, depth, children: depth < 10 ? build(p.id, depth + 1) : [] }));
  return build('', 1);
}
/** 나무 → 화면 줄 [{ page, depth, hasChildren }] — 접힌 것(collapsed Set)의 아래는 뺀다. */
export function flattenTree(roots, collapsed = new Set()) {
  const out = [];
  const walk = (nodes) => { for (const n of nodes) { out.push({ page: n.page, depth: n.depth, hasChildren: n.children.length > 0 }); if (!collapsed.has(n.page.id)) walk(n.children); } };
  walk(roots || []);
  return out;
}
/** 상위 문서 선택지 — 자기 자신 · 자기 아래는 빼고, 깊이 상한(3단계)을 넘지 않는 곳만. */
export function parentOptions(pages, selfId = '') {
  const list = Array.isArray(pages) ? pages : [];
  const byId = new Map(list.map((p) => [p.id, p]));
  const depthOf = (id) => { let d = 0; let cur = byId.get(id); while (cur && d < 12) { d += 1; cur = cur.parentId ? byId.get(cur.parentId) : null; } return d; };
  const heightOf = (id) => { const k = list.filter((p) => p.parentId === id); return k.length ? 1 + Math.max(...k.map((x) => heightOf(x.id))) : 1; };
  const under = (id, anc) => { let cur = byId.get(id); let n = 0; while (cur && n < 12) { if (cur.parentId === anc) return true; cur = byId.get(cur.parentId); n += 1; } return false; };
  const h = selfId ? heightOf(selfId) : 1;
  const opts = [{ value: '', label: '(맨 위)' }];
  for (const { page, depth } of flattenTree(buildTree(list))) {
    if (page.id === selfId || (selfId && under(page.id, selfId))) continue;
    if (depthOf(page.id) + h > MAX_DEPTH) continue;
    opts.push({ value: page.id, label: `${'  '.repeat(depth - 1)}${depth > 1 ? '└ ' : ''}${page.title}` });
  }
  return opts;
}
/** 빵 부스러기 — 맨 위부터 자기까지. */
export function breadcrumb(pages, id) {
  const byId = new Map((pages || []).map((p) => [p.id, p]));
  const out = [];
  let cur = byId.get(id);
  while (cur && out.length < 12) { out.unshift(cur); cur = cur.parentId ? byId.get(cur.parentId) : null; }
  return out;
}

/** [[참조]] → 문서 — W번호면 id, 아니면 제목(대소문자 무시 · 같은 스페이스 우선). */
export function resolvePageRef(ref, pages, spaceId = '') {
  const r = String(ref || '').trim();
  if (!r) return null;
  const list = Array.isArray(pages) ? pages : [];
  if (ID_RE.test(r)) return list.find((p) => p.id === r) || null;
  const low = r.toLowerCase();
  const hits = list.filter((p) => String(p.title).toLowerCase() === low);
  return hits.find((p) => p.spaceId === spaceId) || hits[0] || null;
}

/** 템플릿 본문의 {{issue}} 자리를 채운다(없으면 비운다). */
export function fillTemplate(body, issueKey = '') {
  const key = /^ISS-\d{1,9}$/.test(String(issueKey).trim()) ? String(issueKey).trim() : '';
  return String(body || '').split('{{issue}}').join(key);
}

/* ───── 저장 응답 ───── */
export function wikiSaveFailText(r) {
  if (r?.reason === 'wiki-full') return `저장하지 못했습니다 — 위키 저장 용량이 상한(${mbText(r.max)})에 닿았습니다(지금 약 ${mbText(r.bytes)}). 관리자에게 오래된 문서 정리를 요청하세요.`;
  if (r?.code === 'conflict') return conflictText(r);
  return r?.reason ? `저장하지 못했습니다 — ${r.reason}` : '저장하지 못했습니다.';
}
/** 충돌(409) — 편집을 시작한 판과 지금 판이 다르다. */
export function conflictText(r) {
  const c = r?.current || {};
  if (r?.kind === 'check') return `편집을 시작한 뒤 체크리스트가 바뀌었습니다(${c.by || '알 수 없음'} · ${timeText(c.at)}). 내 글은 그대로 두었습니다. 지금 판을 확인한 뒤 '확인하고 내 글로 저장' 을 누르세요.`; // v2.904 점검 S-1
  return `다른 사람이 먼저 저장했습니다 — 지금 판 v${c.version ?? '?'}(${c.by || '알 수 없음'} · ${timeText(c.at)}). 내 글은 그대로 두었습니다. 바뀐 내용을 비교한 뒤 '확인하고 내 글로 저장' 을 누르세요.`;
}
export const isConflict = (r) => r?.ok === false && r?.code === 'conflict';

/* ───── 초안 자동 저장(이 브라우저에만 — 서버에 가지 않는다) ───── */
export const draftKey = (space, id) => `wiki.draft.${encodeURIComponent(space || 'pub')}.${id || 'new'}`;
export function loadDraft(key, storage = (typeof window !== 'undefined' ? window.localStorage : null)) {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return d && typeof d === 'object' && typeof d.body === 'string' ? d : null;
  } catch { return null; }
}
export function saveDraft(key, draft, storage = (typeof window !== 'undefined' ? window.localStorage : null)) {
  try { storage?.setItem(key, JSON.stringify({ ...draft, savedAt: Date.now() })); return true; } catch { return false; }
}
export function clearDraft(key, storage = (typeof window !== 'undefined' ? window.localStorage : null)) {
  try { storage?.removeItem(key); } catch { /* 저장소를 못 쓰는 브라우저 — 무시 */ }
}

/* ───── 대문 ───── */
/** 숫자 타일 — 값이 없으면 '—'(0 으로 지어내지 않는다). */
export function countTiles(counts, { me = '' } = {}) {
  const c = counts || {};
  const v = (k) => (Number.isFinite(c[k]) ? c[k] : null);
  return [
    { k: 'pages', label: '문서', value: v('pages'), hint: '보관 제외' },
    { k: 'changed7d', label: '7일 안 변경', value: v('changed7d'), hint: '최근 7일 안에 고친 문서' },
    { k: 'review', label: '검토 중', value: v('review'), hint: '상태가 검토 중인 문서' },
    { k: 'myDrafts', label: '내 초안', value: me ? v('myDrafts') : null, hint: '내가 만든 초안' },
    { k: 'watching', label: '지켜보는 문서', value: me ? v('watching') : null, hint: '저장 · 댓글 알림을 받는 문서' },
    { k: 'stale90', label: `${STALE_DAYS}일 넘게 안 고침`, value: v('stale90'), hint: '정리 후보 — 보관(상태)으로 숨길 수 있습니다' },
  ];
}
export const numText = (n) => (Number.isFinite(n) ? String(n) : '—');
/** 공지 기한 문구. */
export function noticeUntilText(until) {
  if (!until) return '기한 없음';
  return `${timeText(until)} 까지`;
}
/** 바로 가기 주소 — 포탈 주소(#/…)는 같은 창, http(s) 는 새 창. 그 밖은 null(서버가 막지만 화면도 다시 본다). */
export function quickHref(href) {
  const s = String(href || '').trim();
  if (/^#\/[^\s<>"']{0,280}$/.test(s)) return { href: s, ext: false };
  if (/^https?:\/\/[^\s<>"']{1,280}$/i.test(s)) return { href: s, ext: true };
  return null;
}
/** 바로 가기 편집 글(한 줄에 '제목 | 주소 | 설명') ↔ 배열. */
export function quickLinksToText(list) {
  return (Array.isArray(list) ? list : []).map((q) => [q.title, q.href, q.desc].filter((x, i) => i < 2 || x).join(' | ')).join('\n');
}
export function textToQuickLinks(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [title = '', href = '', ...rest] = l.split('|').map((x) => x.trim());
    return { title, href, desc: rest.join(' | ') };
  });
}

/* ───── 이력 · 비교 ───── */
export function versionLine(v) {
  const parts = [`v${v.v}`, timeText(v.at), v.by || '—'];
  if (v.status) parts.push(statusText(v.status));
  return parts.join(' · ');
}
export function diffSummary(d) {
  if (!d) return '';
  const base = `v${d.from?.v} → v${d.to?.v}: ${d.added}줄 더함 · ${d.removed}줄 뺌`;
  return d.truncated ? `${base} — 문서가 커서 줄 단위로 맞춰 보지 못하고 바뀐 부분 전체를 뺌 · 더함으로 보여 줍니다` : base;
}
/** 비교 줄의 앞 기호. */
export const DIFF_MARK = Object.freeze({ same: ' ', add: '+', del: '−', gap: '⋯' });

/* ───── 찾기 ───── */
export const WHERE_TEXT = Object.freeze({ title: '제목', body: '본문', comment: '댓글', '': '' });
export function searchSummary(r, q) {
  if (!r) return '';
  const shown = (r.rows || []).length;
  const head = q ? `‘${q}’ — ` : '';
  return r.total > shown ? `${head}${r.total}건 중 ${shown}건을 보여 줍니다(최근 고친 순 상한 ${r.limit}건)` : `${head}${r.total}건`;
}

/** 스페이스 이름 — 메타의 목록에서 찾고, 없으면 id 그대로. */
export function spaceName(spaces, id) {
  const s = (spaces || []).find((x) => x.id === id);
  return s ? s.name : (id === 'pub' ? '공용(전 법인)' : id || '—');
}

/* ───── v2.888 C-2 슬래시 명령(편집기) ───── */
const CARET = '\u0001'; // 스니펫 안의 커서 자리(없으면 끝)
// 마크다운 코드 울타리(백틱 셋) — 화면 문구가 아니라 본문에 넣는 문법이다. 템플릿 안에 이스케이프 백틱을 쓰면 문구 스윕(uiText.test.js)에 걸린다.
const FENCE = '\u0060\u0060\u0060';
/** 명령 — keys 는 찾는 말(한글 · 영어). snip 은 '/명령' 자리를 바꾼다. today 는 그날 날짜(포탈이 아니라 브라우저 날짜 — 문서에 적는 글이다). */
export const SLASH_COMMANDS = Object.freeze([
  { k: 'h2', label: '제목(큰)', keys: ['제목', 'heading', 'h2'], snip: `## ${CARET}` },
  { k: 'h3', label: '제목(작은)', keys: ['소제목', 'heading', 'h3'], snip: `### ${CARET}` },
  { k: 'ul', label: '목록', keys: ['목록', 'list', 'ul', 'bullet'], snip: `- ${CARET}` },
  { k: 'ol', label: '번호 목록', keys: ['번호', 'number', 'ol'], snip: `1. ${CARET}` },
  { k: 'task', label: '체크리스트', keys: ['체크', '할일', 'todo', 'task', 'check'], snip: `- [ ] ${CARET}` },
  { k: 'table', label: '표', keys: ['표', 'table'], snip: `| 열 | 열 |\n|---|---|\n| ${CARET} |  |` },
  { k: 'code', label: '코드 블록', keys: ['코드', 'code'], snip: `${FENCE}bash\n${CARET}\n${FENCE}` },
  { k: 'quote', label: '인용', keys: ['인용', 'quote'], snip: `> ${CARET}` },
  { k: 'info', label: '콜아웃 — 정보', keys: ['콜아웃', '정보', 'info', 'callout'], snip: `:::info\n${CARET}\n:::` },
  { k: 'warn', label: '콜아웃 — 주의', keys: ['콜아웃', '주의', 'warn', 'warning'], snip: `:::warn\n${CARET}\n:::` },
  { k: 'danger', label: '콜아웃 — 위험', keys: ['콜아웃', '위험', 'danger'], snip: `:::danger\n${CARET}\n:::` },
  { k: 'tip', label: '콜아웃 — 팁', keys: ['콜아웃', '팁', 'tip'], snip: `:::tip\n${CARET}\n:::` },
  { k: 'fold', label: '접기', keys: ['접기', 'fold', 'details', 'toggle'], snip: `:::fold 더 보기\n${CARET}\n:::` },
  { k: 'toc', label: '목차', keys: ['목차', 'toc'], snip: `[[toc]]\n${CARET}` },
  { k: 'hr', label: '구분선', keys: ['구분선', 'hr', 'divider', 'line'], snip: `---\n${CARET}` },
  { k: 'page', label: '문서 링크', keys: ['문서', '링크', 'link', 'page'], snip: `[[${CARET}]]` },
  { k: 'issue', label: '이슈 키', keys: ['이슈', 'issue', 'iss'], snip: `ISS-${CARET}` },
  { k: 'fn', label: '각주', keys: ['각주', 'footnote', 'fn'], snip: `[^1]${CARET}\n\n[^1]: ` },
  { k: 'today', label: '오늘 날짜', keys: ['오늘', '날짜', 'today', 'date'], snip: '' },
]);
/**
 * 커서 앞이 '줄 머리(공백 허용) + /낱말' 이면 { start(‘/’ 위치), q } — 아니면 null. 주소(https://…) · 경로 중간의 '/' 는 명령이 아니다(줄 머리만).
 * 줄 머리에서 커서까지 40자를 넘게 보지 않는다(긴 줄에서 매 입력마다 줄 전체를 훑지 않게).
 */
export function slashQuery(text, caret) {
  const s = String(text ?? '');
  const c = Math.max(0, Math.min(Number.isInteger(caret) ? caret : s.length, s.length));
  const ls = s.lastIndexOf('\n', c - 1) + 1;
  if (c - ls > 40) return null;
  const head = s.slice(ls, c);
  const m = /^([ \t]*)\/([^\s/]{0,20})$/.exec(head);
  return m ? { start: ls + m[1].length, q: m[2] } : null;
}
/** 찾는 말로 거르기 — 빈 말이면 전부. 앞부분이 맞는 것 먼저. */
export function filterSlash(q, list = SLASH_COMMANDS) {
  const w = String(q || '').toLowerCase();
  if (!w) return [...list];
  const hit = (c) => [c.label, ...c.keys].map((x) => x.toLowerCase());
  const pre = list.filter((c) => hit(c).some((x) => x.startsWith(w)));
  const mid = list.filter((c) => !pre.includes(c) && hit(c).some((x) => x.includes(w)));
  return [...pre, ...mid];
}
const pad2 = (n) => String(n).padStart(2, '0');
/** 명령 적용 — '/낱말' 자리를 스니펫으로 바꾸고 새 본문 · 커서 위치를 돌려준다. */
export function applySlash(text, caret, cmd, now = new Date()) {
  const q = slashQuery(text, caret);
  if (!q || !cmd) return null;
  let snip = cmd.snip;
  if (cmd.k === 'today') snip = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}${CARET}`;
  const at = snip.indexOf(CARET);
  const clean = snip.replace(CARET, '');
  const body = text.slice(0, q.start) + clean + text.slice(caret);
  return { body, caret: q.start + (at < 0 ? clean.length : at) };
}

/* ───── v2.889 대문 담당 · 당번 ───── */
/** 당번 표 → 글('사람 | 시작 | 끝 | 메모' 한 줄씩). */
export function oncallToText(rows) {
  return (Array.isArray(rows) ? rows : []).map((o) => [o.who, o.from, o.to === o.from ? '' : o.to, o.note || ''].join(' | ').replace(/( \| )+$/, '')).join('\n');
}
/** 글 → 당번 표. 끝을 비우면 시작과 같은 날. 못 읽은 줄은 bad 로 따로(서버도 다시 검사한다). */
export function textToOncall(text) {
  const rows = []; const bad = [];
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  String(text ?? '').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    const [who = '', from = '', to = '', ...rest] = line.split('|').map((x) => x.trim());
    const t = to || from;
    if (!who || /\s/.test(who) || !DAY.test(from) || !DAY.test(t) || t < from) { bad.push(i + 1); return; }
    rows.push({ who, from, to: t, note: rest.join(' | ').slice(0, 60) });
  });
  return { rows, bad };
}
/** '11월 3일 ~ 11월 9일' — 같은 날이면 하루. */
export function oncallRange(o) {
  const f = (d) => { const [, m, dd] = String(d || '').split('-'); return m ? `${Number(m)}월 ${Number(dd)}일` : '—'; };
  return o.from === o.to ? f(o.from) : `${f(o.from)} ~ ${f(o.to)}`;
}
