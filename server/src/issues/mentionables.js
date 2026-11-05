/**
 * issues/mentionables.js — 댓글 @멘션 자동완성 후보(v2.907 · 시안 docs/design/wiki-mention ① · 결정 3 'A3-02 그대로 + 문서 참여자').
 *
 * 서버가 거른다 — 화면에 전 계정 목록을 내려주지 않는다(감사 A3-02: 범위 계정 · 요청 권한 계정에게 전 계정 이름 목록을 주지 않는다).
 *  · 전체 범위 쓰기 계정(조회 ∧ 쓰기 무제한 · 운영자/관리자): 로컬 계정 전부(데모 제외) + 메일 주소 표 + 참여자 + 이슈에 나온 이름.
 *    관리 판단용으로 역할 · 범위 지정 여부 · 메일 주소 유무 · 그 법인을 볼 수 있는지를 함께 싣는다.
 *  · 그 밖(범위 계정 · 요청 권한 계정): 자기 자신 + 참여자(이 문서 · 이슈에 이미 나온 이름) + 볼 수 있는 이슈에 나온 이름 — 계정 · 이름만.
 *  · q: '@' 를 뗀 1~64자(대소문자 무시). 계정 접두 > 이름 접두 > 계정 포함 > 이름 포함 순 · 같은 순위는 계정 이름순. 최대 limit(8)명.
 * 순수에 가깝다 — 계정 목록 · 설정 · 보기 판정은 부르는 쪽이 넘긴다(테스트가 바꿔 끼운다).
 */
export const MENTION_LIMITS = Object.freeze({ q: 64, items: 8 });
const NAME_RE = /^[^\s@,()]{1,64}$/;

/**
 * @param {object} o
 * @param {string} o.q 검색어('@' 포함 가능)
 * @param {string} o.me 요청한 계정
 * @param {string} [o.meName] 요청한 계정의 표시 이름
 * @param {boolean} o.full 전체 범위 쓰기 계정인가(라우트가 판정)
 * @param {string[]} [o.participants] 이 문서 · 이슈의 참여자 이름
 * @param {string[]} [o.knownNames] 이 사용자가 볼 수 있는 이슈에 나온 이름(issues/store knownNames(access))
 * @param {{username:string,name?:string,role?:string,demo?:boolean,scope?:object}[]} [o.users] 로컬 계정(full 일 때만 쓴다)
 * @param {{username:string,email:string}[]} [o.people] 메일 주소 표(full 일 때만 쓴다)
 * @param {(name:string)=>boolean} [o.canSee] 그 사람이 이 법인을 볼 수 있는가(full 일 때만 싣는다)
 */
export function mentionCandidates({ q = '', me = '', meName = '', full = false, participants = [], knownNames = [], users = [], people = [], canSee = null, limit = MENTION_LIMITS.items } = {}) {
  const query = String(q || '').trim().replace(/^@/, '').slice(0, MENTION_LIMITS.q).toLowerCase();
  const byName = new Map();
  const add = (username, info = {}) => {
    const u = String(username || '').trim();
    if (!NAME_RE.test(u)) return;
    const cur = byName.get(u) || { username: u, name: '' };
    byName.set(u, { ...cur, ...Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined && v !== '')) });
  };
  const localByName = new Map((Array.isArray(users) ? users : []).filter((x) => x?.username).map((x) => [x.username, x]));
  if (me) add(me, { name: meName || localByName.get(me)?.name || '' });
  for (const n of participants) add(n, { name: localByName.get(n)?.name || '' });
  for (const n of knownNames) add(n, { name: localByName.get(n)?.name || '' });
  if (full) {
    for (const x of localByName.values()) if (!x.demo) add(x.username, { name: x.name || '' });
    for (const p of Array.isArray(people) ? people : []) if (p?.username) add(p.username);
  }
  const mails = full ? new Set((Array.isArray(people) ? people : []).filter((p) => p?.username && p.email).map((p) => p.username)) : null;
  const rank = (c) => {
    if (!query) return 4;
    const u = c.username.toLowerCase(); const n = String(c.name || '').toLowerCase();
    if (u.startsWith(query)) return 0;
    if (n && n.startsWith(query)) return 1;
    if (u.includes(query)) return 2;
    if (n && n.includes(query)) return 3;
    return -1;
  };
  const hits = [];
  for (const c of byName.values()) {
    const r = rank(c);
    if (r < 0) continue;
    hits.push({ r, c });
  }
  hits.sort((a, b) => a.r - b.r || a.c.username.localeCompare(b.c.username));
  const lim = Math.max(1, Math.min(MENTION_LIMITS.items, Math.trunc(Number(limit)) || MENTION_LIMITS.items));
  const items = hits.slice(0, lim).map(({ c }) => {
    const base = { username: c.username, name: c.name && c.name !== c.username ? c.name : '' };
    if (!full) return base;
    const lu = localByName.get(c.username);
    const sc = lu?.scope || {};
    return {
      ...base,
      role: lu ? String(lu.role || 'viewer') : 'ad', // 로컬 계정이 아니면 AD 로그인 이름으로 본다(visibility.js 와 같은 가정)
      scoped: !!lu && ((Array.isArray(sc.vcenters) && sc.vcenters.length > 0) || (Array.isArray(sc.regions) && sc.regions.length > 0)),
      email: mails.has(c.username),
      canSee: typeof canSee === 'function' ? !!canSee(c.username) : true,
    };
  });
  return { items, truncated: hits.length > items.length };
}

/** 표시용 '계정/이름' 글자 — 이름의 공백 · 멘션을 끊는 글자는 뺀다(파서 MENTION_RE · mentionsOf 와 같은 끝 판정). 이름이 없거나 계정과 같으면 계정만. */
export function mentionText(username, name = '') {
  const n = String(name || '').replace(/[\s@,()[\]*`~/]/g, '').slice(0, 30);
  return n && n !== username ? `@${username}/${n}` : `@${username}`;
}
