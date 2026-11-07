/**
 * wiki/store.js — 위키(컨플루언스 같은 문서 공간) 저장소(v2.881 · 시안 docs/design/wiki-issues ①~⑤ · ⑫).
 *
 * 사용자 요청(2026-11-04): "지라와 컴풀루언스 같은 기능 넣어줘" → 위키 기본 · 이슈 ↔ 문서 연결 · 템플릿 · 댓글/멘션 + "위키 대문 페이지도
 * 만들어줘 최근 수정된 문서, 전체 문서, 목차" + 시안 컨펌 "만들어줘!".
 *
 * 파일 하나 — `wiki.json` `{ v:1, nextNum, spaces:{…}, pages:[…] }`. 사람이 쓴 값이라 issues.json 과 같은 규칙:
 *  · 쓰기는 util/userDocWriter.js(디바운스 · 비동기 원자 쓰기 · 저장 확인 · 실패 재시도 · 종료 flush) · 손상은 보존하고 빈 위키로 시작.
 *  · 합계 상한 `WIKI_MAX_BYTES`(기본 8MB — 백업이 파일당 8MB 까지 담는다(backup/service.js FILE_SIZE_CAP). 그보다 크면 백업에서 빠지므로
 *    기본값을 그 아래로 둔다). 넘기게 되는 저장은 409 `wiki-full` — 조용히 자르지 않는다.
 *
 * 스페이스 = 공용('pub') + 법인(vCenter)마다 하나(id = vcenterId). 스페이스는 따로 만들지 않는다 — 등록된 vCenter 가 곧 스페이스다.
 *  · 범위(이슈와 같은 규칙): 범위 계정은 자기 조회 범위 법인 스페이스만 보고 공용은 보지 않는다 · 조회 밖 404 → 쓰기 밖 403(findFor 하나).
 *
 * 페이지: 트리(부모 · 순서 · 3단계까지) · 마크다운 본문(64KB) · 상태(초안/검토 중/검토 완료/보관) · 라벨 · 판(version).
 *  · 저장마다 판이 하나 늘고 메모 · 사람 · 시각이 남는다(200판 — 넘치면 오래된 판부터 지우고 그 수를 밝힌다). 본문은 최근 30판만 들고 있다
 *    (그보다 오래된 판은 메타만 — 비교 · 되돌리기는 본문이 있는 판끼리만. 화면이 그 사실을 말한다).
 *  · 충돌: 저장 요청은 편집을 시작한 판(baseVersion)을 싣는다. 그 사이 누가 저장했으면 409 `conflict`(지금 판 · 사람 · 시각) — 남의 저장을
 *    조용히 덮어쓰지 않는다.
 *  · 되돌리기는 새 판이다(메모 'vN 로 되돌림').
 *  · 본문 · 댓글의 이슈 키(ISS-12)는 저장 때 색인한다(issueKeys) — 이슈 상세가 '관련 문서' 로 거꾸로 찾는다(backrefs).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { capStr } from '../util/capStr.js';
import { numOrNull } from '../util/numOrNull.js';
import { createUserDocWriter } from '../util/userDocWriter.js';
import { mentionsOf } from '../issues/store.js';
import { lineDiff, hunks } from './diff.js';
import { dayKey } from '../util/dayKey.js';

export const PUB = 'pub';
export const STATUSES = Object.freeze(['draft', 'review', 'approved', 'archived']);
export const LIMITS = Object.freeze({
  pages: 2000, title: 200, body: 65_536, labels: 10, label: 30, depth: 3, versionsMeta: 200, versionsBody: 30,
  comments: 300, comment: 2000, note: 200, homeMd: 10_000, notice: 1000, quickLinks: 12, quickTitle: 40, quickHref: 300,
  watchers: 100, issueKeys: 200, search: 50, // v2.904 점검 S-8: 색인 50 → 200(넘친 수는 issueKeysDropped 로 밝힌다)
  // v2.889 C-5 — 대문 담당(10명) · 당번 표(30줄 · 메모 60자) · 인라인 댓글 인용(200자)
  owners: 10, oncall: 30, oncallNote: 60, quote: 200,
});
export const WIKI_MAX_BYTES_DEFAULT = 8 * 1024 * 1024;
export const PERSIST_WAIT_MS = 3000;
const VC_ID_RE = /^[^\s\u0000-\u001f\u007f]{1,128}$/; // eslint-disable-line no-control-regex
const ISSUE_KEY_RE = /\bISS-(\d{1,9})\b/g;
const DAY = 86_400_000;

export function wikiMaxBytes() {
  const n = numOrNull(process.env.WIKI_MAX_BYTES);
  if (n == null || n <= 0) return WIKI_MAX_BYTES_DEFAULT;
  return Math.max(65_536, Math.trunc(n));
}
export const wikiFile = () => path.join(config.configDir, 'wiki.json');

/* ───── 내장 템플릿(시안 ⑤) — 마크다운 그대로. {{issue}} 는 관련 이슈 키로 채운다. ───── */
export const TEMPLATES = Object.freeze([
  { id: 'blank', name: '빈 페이지', tag: '처음부터', body: '# 제목\n\n본문\n' },
  { id: 'postmortem', name: '장애 보고서(포스트모템)', tag: '장애', body: '# [장애 제목]\n\n- 영향: \n- 기간: \n- 법인: \n- 관련 이슈: {{issue}}\n\n## 타임라인\n\n| 시각 | 무슨 일 |\n|---|---|\n|  |  |\n\n## 원인\n\n## 조치\n\n## 재발 방지\n\n- [ ] \n' },
  { id: 'runbook', name: '런북', tag: '절차', body: '# [작업 이름]\n\n## 언제 쓰나\n\n## 사전 확인\n\n- [ ] \n\n## 절차\n\n```bash\n\n```\n\n## 되돌리기\n\n## 확인\n\n관련 이슈: {{issue}}\n' },
  { id: 'meeting', name: '회의록', tag: '회의', body: '# [YYYY-MM-DD] [회의 이름]\n\n- 참석: \n- 진행: \n\n## 안건\n\n1. \n\n## 결정\n\n## 할 일\n\n- [ ] (이슈로 옮기면 ISS-번호를 적으세요) {{issue}}\n' },
  { id: 'change', name: '변경 계획(CAB)', tag: '변경', body: '# [변경 제목]\n\n- 대상 법인: \n- 변경 창: \n- 관련 이슈: {{issue}}\n\n## 영향 · 위험\n\n## 절차\n\n## 되돌리기\n\n## 승인 · 결과\n' },
]);

/* ───── 캐시 · 쓰기 ───── */
let cache = null; // { spaces, pages, nextNum, sizes:Map, bytes }
const jsonBytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');
const writer = createUserDocWriter({
  tag: 'wiki', file: wikiFile,
  serialize: () => (cache ? JSON.stringify({ v: 1, nextNum: cache.nextNum, spaces: cache.spaces, pages: cache.pages, trash: cache.trash }) : null),
});

function load() {
  if (cache) return cache;
  const file = wikiFile();
  let spaces = {}; let pages = []; let nextNum = 1; let trash = [];
  try {
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!j || typeof j !== 'object' || !Array.isArray(j.pages)) throw new Error('pages 배열이 없습니다');
      pages = j.pages.filter((p) => p && typeof p === 'object' && typeof p.id === 'string' && typeof p.spaceId === 'string');
      // v2.907 휴지통 — 지운 문서는 TRASH_DAYS 동안 따로 둔다(판 · 댓글 · 첨부 그대로). 같은 id 가 살아 있는 문서와 겹치면 휴지통 쪽을 버린다.
      const live = new Set(pages.map((p) => p.id));
      trash = (Array.isArray(j.trash) ? j.trash : []).filter((p) => p && typeof p === 'object' && typeof p.id === 'string' && typeof p.spaceId === 'string' && !live.has(p.id));
      spaces = j.spaces && typeof j.spaces === 'object' && !Array.isArray(j.spaces) ? j.spaces : {};
      const n = numOrNull(j.nextNum);
      nextNum = Math.max(n != null && n >= 1 ? Math.trunc(n) : 1, [...pages, ...trash].reduce((m, p) => Math.max(m, Number(p.num) || 0), 0) + 1);
    }
  } catch (e) {
    preserveCorrupt(file, e.message);
    console.warn(`[wiki] wiki.json 을 읽지 못해 빈 위키로 시작합니다: ${safeLoadText(e) || '사유 미상'}`);
    spaces = {}; pages = []; nextNum = 1; trash = [];
  }
  const sizes = new Map([...pages, ...trash].map((p) => [p.id, jsonBytes(p)]));
  let bytes = jsonBytes(spaces); for (const b of sizes.values()) bytes += b;
  cache = { spaces, pages, nextNum, sizes, bytes, trash };
  return cache;
}
function commit({ changed = null, removedId = null, spacesChanged = false } = {}) {
  const c = load();
  if (removedId) { c.bytes -= c.sizes.get(removedId) || 0; c.sizes.delete(removedId); }
  if (changed) { const b = jsonBytes(changed); c.bytes += b - (c.sizes.get(changed.id) || 0); c.sizes.set(changed.id, b); }
  if (spacesChanged) c.bytes = [...c.sizes.values()].reduce((a, b) => a + b, 0) + jsonBytes(c.spaces);
  c.bytes = Math.max(0, c.bytes);
  writer.changed();
}
function assertRoom(c, next, prevId = null) {
  const max = wikiMaxBytes();
  const after = c.bytes - (prevId ? (c.sizes.get(prevId) || 0) : 0) + jsonBytes(next);
  if (after > max) throw limitError('wiki-full', { bytes: c.bytes, max });
}

export const flushWikiNow = () => writer.flushNow();
export const wikiIdle = (o) => writer.idle(o);
export const wikiSeq = () => writer.seq();
export const waitWikiPersist = (seq, o) => writer.waitPersist(seq, o);
export function wikiPersist({ admin = false } = {}) { return writer.persist({ admin, extra: admin ? { bytes: cache?.bytes ?? null, maxBytes: wikiMaxBytes() } : {} }); }
export function _resetWikiCache() { writer.reset(); cache = null; }
export const _setWikiIoForTest = (over, retry) => writer.setIoForTest(over, retry);

/* ───── 이벤트(알림) ───── */
const listeners = new Set();
export function onWikiEvent(fn) { if (typeof fn === 'function') listeners.add(fn); return () => listeners.delete(fn); }
function emit(ev) { for (const fn of listeners) { try { fn(ev); } catch (e) { console.warn(`[wiki] 이벤트 처리 실패: ${String(e?.message || e).slice(0, 160)}`); } } }
const evPage = (p) => ({ id: p.id, title: p.title, spaceId: p.spaceId, vcenterId: p.spaceId === PUB ? '' : p.spaceId, watchers: [...(p.watchers || [])], createdBy: p.createdBy || '' });

/* ───── 오류 · 검증 ───── */
function fieldError(field, msg) { const e = new Error(`${field}: ${msg}`); e.status = 400; e.field = field; return e; }
function limitError(msg, extra) { const e = new Error(msg); e.status = 409; if (extra) e.extra = extra; return e; }
function notFound() { const e = new Error('없는 문서입니다'); e.status = 404; return e; }
function forbidden(msg) { const e = new Error(msg); e.status = 403; return e; }
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
function text(v, max, field, { required = false, multiline = false } = {}) {
  if (v == null) v = '';
  if (typeof v !== 'string') throw fieldError(field, '문자열이어야 합니다');
  let s = v.replace(CTRL, '');
  if (!multiline) s = s.replace(/[\r\n\t]+/g, ' ');
  s = multiline ? s.replace(/\r\n?/g, '\n') : s.trim();
  if (required && !s.trim()) throw fieldError(field, '비어 있습니다');
  if (s.length > max) throw fieldError(field, `${max.toLocaleString('en-US')}자를 넘습니다(${s.length.toLocaleString('en-US')}자)`);
  return capStr(s, max);
}
function labelsField(v) {
  if (v == null) return [];
  if (typeof v === 'string') v = v.split(',');
  if (!Array.isArray(v)) throw fieldError('labels', '배열이어야 합니다');
  const out = [];
  for (const x of v) { const s = text(x, LIMITS.label, 'labels').toLowerCase().replace(/\s+/g, '-'); if (s && !out.includes(s)) out.push(s); }
  if (out.length > LIMITS.labels) throw fieldError('labels', `라벨은 ${LIMITS.labels}개까지입니다`);
  return out;
}
const enumField = (v, list, field, def) => { if (v == null || v === '') return def; if (!list.includes(v)) throw fieldError(field, `${list.join('·')} 중 하나여야 합니다`); return v; };
/**
 * 본문 · 댓글의 이슈 키 — 색인 상한(LIMITS.issueKeys)까지와 넘친 수.
 * v2.904(점검 S-8 — 재현): 50개에서 조용히 잘려 51번째 키부터 '관련 문서' · issue= 찾기 · 검색식 doc 에서 빠졌다 — 상한을 200 으로 올리고 넘친 수를 싣는다.
 */
export function issueKeysScan(...texts) {
  const keys = []; const seen = new Set();
  for (const s of texts) for (const m of String(s || '').matchAll(ISSUE_KEY_RE)) { const k = `ISS-${m[1]}`; if (seen.has(k)) continue; seen.add(k); if (keys.length < LIMITS.issueKeys) keys.push(k); }
  return { keys, dropped: seen.size - keys.length };
}
export function issueKeysOf(...texts) { return issueKeysScan(...texts).keys; }
const keyFields = (...texts) => { const r = issueKeysScan(...texts); return { issueKeys: r.keys, issueKeysDropped: r.dropped }; };
/** 댓글이 색인에 싣는 글 — 본문 + 그 댓글에서 만든 이슈 키(v2.907 — '관련 이슈' 에 함께 보인다). */
const commentTexts = (comments) => (comments || []).flatMap((q) => [q.body, q.issueKey || '']);

/* ───── 범위 ───── */
export const FULL_ACCESS = Object.freeze({ read: null, write: null });
const canSeeSpace = (sid, a) => !a?.read || (sid !== PUB && a.read.has(sid));
const canEditSpace = (sid, a) => !a?.write || (sid !== PUB && a.write.has(sid));
function spaceField(v, access, known) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s === PUB) { if (access?.write) throw fieldError('spaceId', '범위가 지정된 계정은 법인 스페이스를 골라야 합니다'); return PUB; }
  if (!VC_ID_RE.test(s)) throw fieldError('spaceId', '스페이스 id 형식이 아닙니다');
  if (known && !known.has(s)) throw fieldError('spaceId', '등록되지 않은 법인(vCenter)입니다');
  if (access?.read && !access.read.has(s)) throw fieldError('spaceId', '등록되지 않은 법인(vCenter)입니다');
  if (access?.write && !access.write.has(s)) throw forbidden('그 법인 스페이스는 쓰기 범위 밖입니다 — 조회만 할 수 있습니다');
  return capStr(s, 128);
}
function findFor(id, access = FULL_ACCESS, { write = false } = {}) {
  const p = load().pages.find((x) => x.id === id);
  if (!p || !canSeeSpace(p.spaceId, access)) throw notFound();
  if (write && !canEditSpace(p.spaceId, access)) throw forbidden('이 문서의 스페이스는 쓰기 범위 밖입니다 — 조회만 할 수 있습니다');
  if (write && load().spaces[p.spaceId]?.readOnly) throw forbidden('이 스페이스는 읽기 전용입니다(스페이스 설정)');
  return p;
}
export const writableBy = (p, access = FULL_ACCESS) => canSeeSpace(p.spaceId, access) && canEditSpace(p.spaceId, access);
/**
 * v2.888 — 저장된 id 목록(즐겨찾기 · 최근 본) → 지금 볼 수 있는 문서의 메타(순서 유지). 지워졌거나 범위 밖이면 빠진다(저장된 id 를 믿지 않는다).
 * extra(id) 가 주는 값을 덧붙인다(최근 본 시각 등).
 */
export function metasFor(ids, access = FULL_ACCESS, extra = null) {
  const byId = new Map(load().pages.map((p) => [p.id, p]));
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const p = byId.get(id);
    if (!p || !canSeeSpace(p.spaceId, access)) continue;
    out.push({ ...metaOf(p), ...(extra ? extra(id) || {} : {}) });
  }
  return out;
}

/* ───── 트리 ───── */
const childrenOf = (pages, id) => pages.filter((p) => p.parentId === id);
function depthOf(pages, id) { let d = 0; let cur = pages.find((p) => p.id === id); while (cur && d < 10) { d += 1; cur = cur.parentId ? pages.find((p) => p.id === cur.parentId) : null; } return d; }
function subtreeHeight(pages, id) { const kids = childrenOf(pages, id); return kids.length ? 1 + Math.max(...kids.map((k) => subtreeHeight(pages, k.id))) : 1; }
function isDescendant(pages, id, maybeAncestor) { let cur = pages.find((p) => p.id === id); let n = 0; while (cur && n < 20) { if (cur.parentId === maybeAncestor) return true; cur = pages.find((p) => p.id === cur.parentId); n += 1; } return false; }

/* ───── 보기 ───── */
export function metaOf(p) {
  return {
    id: p.id, num: p.num, spaceId: p.spaceId, parentId: p.parentId || '', order: p.order ?? 0, title: p.title, status: p.status, labels: p.labels || [],
    version: p.version, createdAt: p.createdAt, createdBy: p.createdBy, updatedAt: p.updatedAt, updatedBy: p.updatedBy,
    comments: (p.comments || []).length, issueKeys: p.issueKeys || [], issueKeysDropped: Number(p.issueKeysDropped) || 0, template: p.template || '',
  };
}
function viewPage(p, me = '', access = FULL_ACCESS) {
  return {
    ...metaOf(p), body: p.body || '', watchers: p.watchers || [], watching: !!me && (p.watchers || []).includes(me),
    versions: (p.versions || []).map((v) => ({ v: v.v, at: v.at, by: v.by, note: v.note || '', status: v.status || '', hasBody: typeof v.body === 'string', len: v.len ?? null })).reverse(),
    versionsDropped: p.versionsDropped || 0,
    comments: (p.comments || []).map((c) => ({ ...c })),
    writable: writableBy(p, access) && !load().spaces[p.spaceId]?.readOnly,
    commentable: writableBy(p, access), // 댓글은 읽기 전용 스페이스에서도 된다(쓰기 범위만 본다 — addComment 와 같은 판정)
    checkLog: (Array.isArray(p.checkLog) ? p.checkLog : []).slice(-10).reverse(), // v2.883 체크리스트 기록(최근 10)
    checkRev: Number(p.checkRev) || 0, // v2.904 점검 S-1 — 편집기가 baseCheckRev 로 되돌려 싣는다
  };
}

/* ───── 스페이스 ───── */
/** 보이는 스페이스 — 공용 + 이 사용자가 보는 법인. vcenters = [{id,name}](스냅샷). */
export function listSpaces({ access = FULL_ACCESS, vcenters = [] } = {}) {
  const c = load();
  const counts = new Map();
  for (const p of c.pages) counts.set(p.spaceId, (counts.get(p.spaceId) || 0) + 1);
  const out = [];
  if (canSeeSpace(PUB, access)) out.push({ id: PUB, name: '공용(전 법인)', pages: counts.get(PUB) || 0, writable: canEditSpace(PUB, access), readOnly: !!c.spaces[PUB]?.readOnly });
  const seen = new Set();
  for (const v of vcenters) {
    if (!v?.id || seen.has(v.id) || !canSeeSpace(v.id, access)) continue;
    seen.add(v.id);
    out.push({ id: v.id, name: v.name || v.id, pages: counts.get(v.id) || 0, writable: canEditSpace(v.id, access), readOnly: !!c.spaces[v.id]?.readOnly });
  }
  // 등록에서 빠진 vCenter 의 스페이스에 문서가 남아 있으면 그것도 보인다(문서를 숨기지 않는다)
  for (const sid of counts.keys()) if (sid !== PUB && !seen.has(sid) && canSeeSpace(sid, access)) { seen.add(sid); out.push({ id: sid, name: `${sid}(등록에서 빠짐)`, pages: counts.get(sid), writable: canEditSpace(sid, access), readOnly: !!c.spaces[sid]?.readOnly }); }
  return out;
}
const QUICK_HREF_RE = /^(#\/[^\s<>"']{0,280}|https?:\/\/[^\s<>"']{1,280})$/;
export function spaceView(spaceId, access = FULL_ACCESS) {
  if (!canSeeSpace(spaceId, access)) throw notFound();
  const s = load().spaces[spaceId] || {};
  return { id: spaceId, homeMd: s.homeMd || '', notice: s.notice || null, quickLinks: s.quickLinks || [], readOnly: !!s.readOnly, updatedAt: s.updatedAt || null, updatedBy: s.updatedBy || '',
    owners: Array.isArray(s.owners) ? s.owners : [], oncall: Array.isArray(s.oncall) ? s.oncall : [] };
}
/** 스페이스 설정(대문 글 · 공지 · 바로 가기 · 읽기 전용) — 라우트가 관리자로 막고, 여기서 그 스페이스의 쓰기 범위를 본다. */
export function updateSpace(spaceId, body, user, { access = FULL_ACCESS } = {}) {
  const c = load();
  if (!canSeeSpace(spaceId, access)) throw notFound();
  if (!canEditSpace(spaceId, access)) throw forbidden('이 스페이스는 쓰기 범위 밖입니다');
  const b = body || {};
  const cur = c.spaces[spaceId] || {};
  const next = { ...cur };
  if (Object.hasOwn(b, 'homeMd')) next.homeMd = text(b.homeMd, LIMITS.homeMd, 'homeMd', { multiline: true });
  if (Object.hasOwn(b, 'notice')) {
    if (!b.notice || !String(b.notice.md || '').trim()) next.notice = null;
    else {
      const until = b.notice.until == null || b.notice.until === '' ? null : Number(b.notice.until);
      if (until != null && (!Number.isFinite(until) || until <= 0)) throw fieldError('notice.until', '시각을 읽지 못했습니다');
      next.notice = { md: text(b.notice.md, LIMITS.notice, 'notice', { multiline: true }), until: until ? Math.trunc(until) : null, by: user, at: Date.now() };
    }
  }
  if (Object.hasOwn(b, 'quickLinks')) {
    if (!Array.isArray(b.quickLinks)) throw fieldError('quickLinks', '배열이어야 합니다');
    if (b.quickLinks.length > LIMITS.quickLinks) throw fieldError('quickLinks', `바로 가기는 ${LIMITS.quickLinks}개까지입니다`);
    next.quickLinks = b.quickLinks.map((q, i) => {
      const title = text(q?.title, LIMITS.quickTitle, `quickLinks.${i}.title`, { required: true });
      const href = text(q?.href, LIMITS.quickHref, `quickLinks.${i}.href`, { required: true });
      if (!QUICK_HREF_RE.test(href)) throw fieldError(`quickLinks.${i}.href`, '‘#/…’ 포탈 주소나 http(s) 주소여야 합니다');
      return { title, href, desc: text(q?.desc ?? '', 60, `quickLinks.${i}.desc`) };
    });
  }
  if (Object.hasOwn(b, 'readOnly')) next.readOnly = b.readOnly === true;
  // v2.889 C-5 대문 담당 · 당번 — 계정명(공백 없는 64자) · 당번은 포탈 날짜 YYYY-MM-DD 범위(끝 ≥ 시작)
  if (Object.hasOwn(b, 'owners')) {
    const list = Array.isArray(b.owners) ? b.owners : String(b.owners || '').split(',');
    const owners = [...new Set(list.map((n) => String(n ?? '').trim()).filter(Boolean))];
    if (owners.length > LIMITS.owners) throw fieldError('owners', `담당은 ${LIMITS.owners}명까지입니다`);
    // eslint-disable-next-line no-control-regex
    for (const n of owners) if (n.length > 64 || /[\s\u0000-\u001f\u007f]/.test(n)) throw fieldError('owners', `‘${capStr(n, 20)}’ — 공백 없는 64자 이하 계정명이어야 합니다`);
    next.owners = owners;
  }
  if (Object.hasOwn(b, 'oncall')) {
    if (!Array.isArray(b.oncall)) throw fieldError('oncall', '배열이어야 합니다');
    if (b.oncall.length > LIMITS.oncall) throw fieldError('oncall', `당번 표는 ${LIMITS.oncall}줄까지입니다`);
    const day = (v, f) => { const t = String(v ?? '').trim(); if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || new Date(`${t}T00:00:00Z`).toISOString().slice(0, 10) !== t) throw fieldError(f, '날짜(YYYY-MM-DD)를 읽지 못했습니다'); return t; };
    next.oncall = b.oncall.map((o, i) => {
      const who = String(o?.who ?? '').trim();
      // eslint-disable-next-line no-control-regex
      if (!who || who.length > 64 || /[\s\u0000-\u001f\u007f]/.test(who)) throw fieldError(`oncall.${i}.who`, '공백 없는 64자 이하 계정명이어야 합니다');
      const from = day(o?.from, `oncall.${i}.from`); const to = day(o?.to || o?.from, `oncall.${i}.to`);
      if (to < from) throw fieldError(`oncall.${i}.to`, '끝 날짜가 시작보다 앞입니다');
      return { who, from, to, note: text(o?.note ?? '', LIMITS.oncallNote, `oncall.${i}.note`) };
    }).sort((x, y) => x.from.localeCompare(y.from));
  }
  next.updatedAt = Date.now(); next.updatedBy = user;
  const spaces = { ...c.spaces, [spaceId]: next };
  const max = wikiMaxBytes();
  if (c.bytes - jsonBytes(c.spaces) + jsonBytes(spaces) > max) throw limitError('wiki-full', { bytes: c.bytes, max });
  c.spaces = spaces;
  commit({ spacesChanged: true });
  return spaceView(spaceId, access);
}

/* ───── 페이지 ───── */
export function tree(spaceId, { access = FULL_ACCESS, includeArchived = true } = {}) {
  if (!canSeeSpace(spaceId, access)) throw notFound();
  return load().pages.filter((p) => p.spaceId === spaceId && (includeArchived || p.status !== 'archived')).map(metaOf)
    .sort((a, b) => (a.order - b.order) || a.title.localeCompare(b.title));
}
export function getPage(id, me = '', access = FULL_ACCESS) { return viewPage(findFor(id, access), me, access); }

function pushVersion(p, { by, note = '', at }) {
  const versions = [...(p.versions || []), { v: p.version, at, by, note: capStr(note, LIMITS.note), status: p.status, body: p.body, len: (p.body || '').length }];
  // 본문은 최근 versionsBody 판만 — 그보다 오래된 판은 메타만 남긴다
  for (let i = 0; i < versions.length - LIMITS.versionsBody; i += 1) if (typeof versions[i].body === 'string') { const { body, ...rest } = versions[i]; void body; versions[i] = rest; }
  let dropped = p.versionsDropped || 0;
  while (versions.length > LIMITS.versionsMeta) { versions.shift(); dropped += 1; }
  return { versions, versionsDropped: dropped };
}
function parentField(pages, spaceId, parentId, selfId = null) {
  const pid = typeof parentId === 'string' ? parentId.trim() : '';
  if (!pid) return '';
  const parent = pages.find((p) => p.id === pid);
  if (!parent || parent.spaceId !== spaceId) throw fieldError('parentId', '같은 스페이스의 문서만 상위로 고를 수 있습니다');
  if (selfId && (pid === selfId || isDescendant(pages, pid, selfId))) throw fieldError('parentId', '자기 자신이나 하위 문서를 상위로 둘 수 없습니다');
  const height = selfId ? subtreeHeight(pages, selfId) : 1;
  if (depthOf(pages, pid) + height > LIMITS.depth) throw fieldError('parentId', `트리는 ${LIMITS.depth}단계까지입니다`);
  return pid;
}

export function createPage(body, user, { access = FULL_ACCESS, known = null } = {}) {
  const c = load();
  if (c.pages.length >= LIMITS.pages) throw limitError(`문서는 ${LIMITS.pages}개까지 보관합니다 — 관리자에게 정리를 요청하세요`);
  const b = body || {};
  const spaceId = spaceField(b.spaceId, access, known);
  if (c.spaces[spaceId]?.readOnly) throw forbidden('이 스페이스는 읽기 전용입니다(스페이스 설정)');
  const now = Date.now();
  const num = c.nextNum;
  const title = text(b.title, LIMITS.title, 'title', { required: true });
  const md = text(b.body, LIMITS.body, 'body', { multiline: true });
  const parentId = parentField(c.pages, spaceId, b.parentId);
  const siblings = childrenOf(c.pages.filter((p) => p.spaceId === spaceId), parentId);
  const p0 = {
    id: `W${num}`, num, spaceId, parentId, order: siblings.reduce((m, s) => Math.max(m, s.order ?? 0), 0) + 1,
    title, body: md, status: enumField(b.status, STATUSES, 'status', 'draft'), labels: labelsField(b.labels), template: capStr(String(b.template || ''), 30),
    version: 1, versions: [], versionsDropped: 0, createdAt: now, createdBy: user, updatedAt: now, updatedBy: user,
    watchers: [user], comments: [], ...keyFields(title, md),
  };
  const x = { ...p0, ...pushVersion(p0, { by: user, note: text(b.note ?? '처음 만듦', LIMITS.note, 'note'), at: now }) };
  assertRoom(c, x);
  c.pages = [...c.pages, x]; c.nextNum = num + 1;
  commit({ changed: x });
  emit({ type: 'created', actor: user, page: evPage(x), mentions: mentionsOf(md) });
  return viewPage(x, user, access);
}

/** 저장(새 판). baseVersion 이 지금 판과 다르면 409 conflict — 남의 저장을 덮지 않는다. 바뀐 것이 없으면 판을 만들지 않는다. */
export function updatePage(id, body, user, { access = FULL_ACCESS } = {}) {
  const c = load();
  const p = findFor(id, access, { write: true });
  const b = body || {};
  const base = numOrNull(b.baseVersion);
  const checkRev = Number(p.checkRev) || 0;
  if (base == null || Math.trunc(base) !== p.version) {
    throw limitError(`다른 사람이 먼저 저장했습니다(v${p.version} · ${p.updatedBy}) — 비교한 뒤 다시 저장하세요`, { code: 'conflict', current: { version: p.version, by: p.updatedBy, at: p.updatedAt, checkRev } });
  }
  // v2.904(점검 S-1 — 재현): 체크 토글은 판을 만들지 않아 판 번호로는 '편집을 시작한 뒤의 체크' 를 못 잡았다 — 옛 본문을 실은 저장이
  // 409 없이 체크를 되돌렸다. 편집기가 싣는 baseCheckRev(편집 시작 때의 체크 순번)로 한 번 더 본다. 싣지 않은 호출(API 스크립트)은 예전처럼 판만.
  if (Object.hasOwn(b, 'baseCheckRev')) {
    const cr = numOrNull(b.baseCheckRev);
    if (cr == null || Math.trunc(cr) !== checkRev) {
      const last = (Array.isArray(p.checkLog) ? p.checkLog : []).at(-1) || {};
      throw limitError(`편집을 시작한 뒤 체크리스트가 바뀌었습니다(${last.by || '다른 사람'}) — 다시 읽어 체크 상태를 확인한 뒤 저장하세요`,
        { code: 'conflict', kind: 'check', current: { version: p.version, by: last.by || p.updatedBy, at: last.at || p.updatedAt, checkRev } });
    }
  }
  const has = (k) => Object.hasOwn(b, k);
  const title = has('title') ? text(b.title, LIMITS.title, 'title', { required: true }) : p.title;
  const md = has('body') ? text(b.body, LIMITS.body, 'body', { multiline: true }) : p.body;
  const status = has('status') ? enumField(b.status, STATUSES, 'status', p.status) : p.status;
  const labels = has('labels') ? labelsField(b.labels) : p.labels;
  const parentId = has('parentId') ? parentField(c.pages, p.spaceId, b.parentId, p.id) : p.parentId;
  const same = title === p.title && md === p.body && status === p.status && JSON.stringify(labels) === JSON.stringify(p.labels) && parentId === (p.parentId || '');
  if (same) return viewPage(p, user, access);
  const now = Date.now();
  const nx = { ...p, title, body: md, status, labels, parentId, version: p.version + 1, updatedAt: Math.max(now, (p.updatedAt || 0) + 1), updatedBy: user, ...keyFields(title, md, ...commentTexts(p.comments)) };
  const x = { ...nx, ...pushVersion(nx, { by: user, note: has('note') ? text(b.note, LIMITS.note, 'note') : '', at: nx.updatedAt }) };
  assertRoom(c, x, p.id);
  const oldPages = c.pages;
  c.pages = c.pages.map((q) => (q.id === p.id ? x : q));
  commit({ changed: x });
  // v2.907 제목이 바뀌면 '[[옛 제목]]' 링크를 새 제목으로(기능 추천 3 — 제목으로 찾는 링크가 조용히 깨졌다)
  const linkFix = title !== p.title ? rewriteLinksAfterRename(c, oldPages, x, p.title, user, access) : null;
  const prevMentions = new Set(mentionsOf(p.body));
  emit({ type: 'saved', actor: user, page: evPage(x), version: x.version, note: has('note') ? capStr(String(b.note || ''), 120) : '', mentions: mentionsOf(md).filter((m) => !prevMentions.has(m)) });
  return { ...viewPage(x, user, access), ...(linkFix ? { linkFix } : {}) };
}

/** 되돌리기 — 그 판의 본문으로 새 판을 만든다(본문을 들고 있는 판만). */
export function revertPage(id, v, user, { access = FULL_ACCESS, note = '' } = {}) {
  const p = findFor(id, access, { write: true });
  const target = (p.versions || []).find((x) => x.v === Math.trunc(Number(v)));
  if (!target) throw notFound();
  if (typeof target.body !== 'string') throw fieldError('v', `v${target.v} 은 본문을 보관하지 않는 오래된 판입니다(최근 ${LIMITS.versionsBody}판만 본문을 둡니다)`);
  return updatePage(id, { baseVersion: p.version, body: target.body, note: text(note || `v${target.v} 로 되돌림`, LIMITS.note, 'note') }, user, { access });
}

/**
 * 체크리스트 줄의 '[ ]' 안 글자 위치 — 아니면 -1(웹 views/wiki/markdown.js taskMarkAt 과 같은 규칙 — test/wikiIssues2883 이 같은 입력으로 대조).
 * 정규식 대신 손으로(앞쪽 공백 · '>' 를 겹쳐 훑는 역추적이 생기지 않게 · 긴 줄은 거절).
 */
export function taskMarkAt(line) {
  const s = String(line ?? '');
  if (s.length > 4000) return -1;
  let i = 0;
  for (;;) {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
    if (s[i] === '>') { i += 1; continue; }
    break;
  }
  if (s[i] === '-' || s[i] === '*' || s[i] === '+') i += 1;
  else {
    const st = i;
    while (i < s.length && i - st < 9 && s[i] >= '0' && s[i] <= '9') i += 1;
    if (i === st || (s[i] !== '.' && s[i] !== ')')) return -1;
    i += 1;
  }
  if (s[i] !== ' ' && s[i] !== '\t') return -1;
  while (s[i] === ' ' || s[i] === '\t') i += 1;
  if (s[i] !== '[' || s[i + 2] !== ']' || !(s[i + 1] === ' ' || s[i + 1] === 'x' || s[i + 1] === 'X')) return -1;
  if (s[i + 3] !== ' ' && s[i + 3] !== '\t') return -1;
  return i + 1;
}
export const CHECK_LOG_MAX = 50;

/**
 * 체크리스트 한 칸(v2.883 · 시안 ⑨ '체크리스트(보기에서 체크)') — line(0부터)의 '[ ]' ↔ '[x]'. **판을 만들지 않는다** — 지금 판의 본문도 같이 고쳐
 * 판 본문과 문서 본문이 어긋나지 않게 하고, 기록(checkLog)에 한 줄 남긴다. 쓰기 범위 · 읽기 전용은 저장과 같은 판정(findFor write).
 * baseVersion 이 지금 판과 다르면 409(본문이 바뀌어 줄 번호가 달라졌을 수 있다). 그 줄이 체크리스트가 아니거나 상태가 이미 다르면 409.
 */
export function toggleTask(id, body, user, { access = FULL_ACCESS } = {}) {
  const c = load();
  const p = findFor(id, access, { write: true });
  const b = body || {};
  const base = numOrNull(b.baseVersion);
  if (base == null || Math.trunc(base) !== p.version) {
    throw limitError(`문서가 바뀌었습니다(지금 판 v${p.version}) — 다시 읽은 뒤 체크하세요`, { code: 'conflict', current: { version: p.version, by: p.updatedBy, at: p.updatedAt } });
  }
  if (typeof b.checked !== 'boolean') throw fieldError('checked', 'true 또는 false 여야 합니다');
  const lines = String(p.body || '').split(/\r\n?|\n/);
  const n = Number.isInteger(b.line) ? b.line : -1;
  if (n < 0 || n >= lines.length) throw fieldError('line', '줄 번호가 문서 범위 밖입니다');
  const pos = taskMarkAt(lines[n]);
  if (pos < 0) throw limitError('그 줄은 체크리스트 항목이 아닙니다 — 다시 읽은 뒤 체크하세요', { code: 'not-task' });
  const cur = lines[n][pos] !== ' ';
  if (cur === b.checked) return viewPage(p, user, access);
  lines[n] = `${lines[n].slice(0, pos)}${b.checked ? 'x' : ' '}${lines[n].slice(pos + 1)}`;
  const md = lines.join('\n');
  const now = Date.now();
  const versions = (p.versions || []).map((v, k, arr) => (k === arr.length - 1 && typeof v.body === 'string' ? { ...v, body: md, len: md.length } : v));
  const log = [...(Array.isArray(p.checkLog) ? p.checkLog : []), { at: now, by: user, line: n, checked: b.checked, text: capStr(lines[n].trim(), 80) }].slice(-CHECK_LOG_MAX);
  const x = { ...p, body: md, versions, checkLog: log, checkRev: (Number(p.checkRev) || 0) + 1 }; // v2.904 점검 S-1 — 저장 충돌 판정용 순번
  assertRoom(c, x, p.id);
  c.pages = c.pages.map((q) => (q.id === p.id ? x : q));
  commit({ changed: x });
  return viewPage(x, user, access);
}

/**
 * v2.908 자동화 규칙 '완료 → 위키 체크 항목 완료'(서버 내부). 이슈 키(ISS-n — 뒤에 숫자가 이어지지 않는 것)를 적은 **체크 안 된**
 * 체크리스트 항목을 체크한다. 보기에서 체크(toggleTask)와 같은 방식 — 판을 만들지 않고 지금 판 본문도 같이 고치고 checkLog · checkRev 를 남긴다.
 * 읽기 전용 스페이스 · 보관(archived) 문서는 건드리지 않는다. 문서 50개 · 문서당 50줄까지.
 * v2.927(사용자 선택 '같은 법인 + 공용만'): v2.908 은 모든 스페이스를 건드려 법인 A 이슈의 완료가 B 법인 스페이스 문서를 바꿀 수 있었다 —
 *   **이슈의 법인 스페이스 + 공용 스페이스만**(공용 이슈는 공용 스페이스만). 다른 법인 문서는 건너뛰고 센다(outOfScope).
 * @returns {{ pages: number, items: number, skipped: number, outOfScope: number }}
 */
export const AUTO_CHECK_LIMITS = Object.freeze({ pages: 50, lines: 50 });
export function checkIssueTasks(issueKey, user = 'automation', { now = Date.now(), vcenterId = '' } = {}) {
  const out = { pages: 0, items: 0, skipped: 0, outOfScope: 0 };
  const corp = String(vcenterId || '');
  const key = String(issueKey || '');
  if (!/^ISS-\d{1,9}$/.test(key)) return out;
  const re = new RegExp(`\\b${key}(?!\\d)`);
  const c = load();
  for (const p of c.pages) {
    if (out.pages >= AUTO_CHECK_LIMITS.pages) { out.skipped += 1; continue; }
    if (!(p.issueKeys || []).includes(key)) continue;
    if (p.spaceId !== PUB && p.spaceId !== corp) { out.outOfScope += 1; continue; } // v2.927 — 다른 법인 스페이스는 건드리지 않는다
    if (p.status === 'archived' || c.spaces[p.spaceId]?.readOnly) { out.skipped += 1; continue; }
    const lines = String(p.body || '').split(/\r\n?|\n/);
    const hit = [];
    for (let n = 0; n < lines.length && hit.length < AUTO_CHECK_LIMITS.lines; n += 1) {
      const pos = taskMarkAt(lines[n]);
      if (pos < 0 || lines[n][pos] !== ' ' || !re.test(lines[n])) continue;
      lines[n] = `${lines[n].slice(0, pos)}x${lines[n].slice(pos + 1)}`;
      hit.push(n);
    }
    if (!hit.length) continue;
    const md = lines.join('\n');
    const versions = (p.versions || []).map((v, k, arr) => (k === arr.length - 1 && typeof v.body === 'string' ? { ...v, body: md, len: md.length } : v));
    const log = [...(Array.isArray(p.checkLog) ? p.checkLog : []), ...hit.map((n) => ({ at: now, by: user, line: n, checked: true, text: capStr(`자동화: ${key} 완료 — ${lines[n].trim()}`, 80) }))].slice(-CHECK_LOG_MAX);
    const x = { ...p, body: md, versions, checkLog: log, checkRev: (Number(p.checkRev) || 0) + 1 };
    try { assertRoom(c, x, p.id); } catch { out.skipped += 1; continue; }
    c.pages = c.pages.map((q) => (q.id === p.id ? x : q));
    commit({ changed: x });
    out.pages += 1; out.items += hit.length;
  }
  return out;
}

export function versionBody(id, v, access = FULL_ACCESS) {
  const p = findFor(id, access);
  const target = (p.versions || []).find((x) => x.v === Math.trunc(Number(v)));
  if (!target) throw notFound();
  return { v: target.v, at: target.at, by: target.by, note: target.note || '', hasBody: typeof target.body === 'string', body: typeof target.body === 'string' ? target.body : null };
}
export function diffVersions(id, from, to, access = FULL_ACCESS) {
  const a = versionBody(id, from, access); const b = versionBody(id, to, access);
  if (!a.hasBody || !b.hasBody) throw fieldError('v', `본문을 보관하지 않는 오래된 판은 비교할 수 없습니다(최근 ${LIMITS.versionsBody}판만)`);
  const d = lineDiff(a.body, b.body);
  return { from: { v: a.v, at: a.at, by: a.by, note: a.note }, to: { v: b.v, at: b.at, by: b.by, note: b.note }, added: d.added, removed: d.removed, truncated: d.truncated, ops: hunks(d.ops, 3) };
}

/** 지우기 — 하위 문서가 없을 때만. 만든 사람 또는 관리자(isMod — 라우트가 판정). 보관(archived)은 상태 바꾸기로. */
export function deletePage(id, user, { access = FULL_ACCESS, isMod = false } = {}) {
  const c = load();
  const p = findFor(id, access, { write: true });
  if (!isMod && p.createdBy !== user) throw forbidden('문서는 만든 사람이나 전체 범위 관리자만 지울 수 있습니다 — 보관(상태)으로 숨길 수 있습니다');
  if (childrenOf(c.pages, p.id).length) throw fieldError('id', '하위 문서가 있어 지울 수 없습니다 — 먼저 옮기거나 지우세요');
  // v2.907 휴지통(기능 추천 2): 바로 없애지 않고 TRASH_DAYS 동안 둔다 — 판 · 댓글 · 첨부를 그대로 되살릴 수 있다. 첨부 본체는 영구 삭제 때 지운다.
  const t = { ...p, deletedAt: Date.now(), deletedBy: user };
  c.pages = c.pages.filter((q) => q.id !== p.id);
  c.trash = [...(c.trash || []), t];
  commit({ changed: t });
  return { id: p.id, trashed: true, purgeAt: t.deletedAt + TRASH_DAYS * DAY_MS };
}

/* ───── v2.907 댓글 고치기(기능 추천 1) ─────
 * 쓴 사람만 · 댓글을 쓸 수 있는 범위(addComment 와 같은 판정). 옛 본문은 최근 5개까지 남기고(editedAt · edits) 판은 만들지 않는다.
 * 알림은 **새로 언급한 사람에게만**(같은 사람에게 두 번 가지 않게 — 오타 고치기로 메일이 다시 나가던 '지우고 다시 쓰기' 의 대안).
 */
export const COMMENT_EDIT_KEEP = 5;
export function editComment(id, commentId, body, user, { access = FULL_ACCESS } = {}) {
  const c = load();
  const p = findFor(id, access);
  if (!canEditSpace(p.spaceId, access)) throw forbidden('이 문서의 스페이스는 쓰기 범위 밖입니다 — 조회만 할 수 있습니다');
  const cm = (p.comments || []).find((x) => x.id === commentId);
  if (!cm) throw notFound();
  if (cm.author !== user) throw forbidden('댓글은 쓴 사람만 고칠 수 있습니다');
  const next = text(body?.body, LIMITS.comment, 'body', { required: true, multiline: true });
  if (next === cm.body) return cm;
  const now = Date.now();
  const edited = { ...cm, body: next, editedAt: now, edits: (Number(cm.edits) || 0) + 1, prev: [...(Array.isArray(cm.prev) ? cm.prev : []), { at: cm.editedAt || cm.at, body: cm.body }].slice(-COMMENT_EDIT_KEEP) };
  const comments = p.comments.map((x) => (x.id === commentId ? edited : x));
  const x = { ...p, comments, ...keyFields(p.title, p.body, ...commentTexts(comments)) };
  assertRoom(c, x, p.id);
  c.pages = c.pages.map((q) => (q.id === p.id ? x : q));
  commit({ changed: x });
  const before = new Set(mentionsOf(cm.body));
  const fresh = mentionsOf(next).filter((m) => !before.has(m));
  if (fresh.length) emit({ type: 'comment', edit: true, actor: user, page: evPage(x), excerpt: capStr(next, 200), mentions: fresh });
  return edited;
}

/* ───── v2.907 문서 링크 — 역링크 · 제목 바꿀 때 링크 갱신 · 깨진 링크(기능 추천 3) ─────
 * '[[제목]]' · '[[제목|글]]' · '[[W12]]' 를 화면 파서(web markdown.js)와 같은 규칙으로 읽는다: 대괄호 둘 안 200자 · '|' 앞이 가리키는 곳 · 'toc' 는 목차.
 * 가리키는 문서 찾기도 화면 resolvePageRef 와 같다 — W번호면 그 문서, 아니면 제목(대소문자 무시)이 같은 문서 중 같은 스페이스 우선.
 */
const PAGE_ID_RE = /^W\d{1,9}$/;
export function pageRefsOf(md) {
  const s = String(md || '');
  const out = [];
  let i = 0;
  while (i < s.length && out.length < 500) {
    const a = s.indexOf('[[', i);
    if (a < 0) break;
    const b = s.indexOf(']]', a + 2);
    if (b < 0) break;
    const raw = s.slice(a + 2, b);
    if (raw.length <= 200 && !raw.includes('\n') && !raw.includes('[')) {
      const bar = raw.indexOf('|');
      const ref = (bar >= 0 ? raw.slice(0, bar) : raw).trim();
      if (ref && ref.toLowerCase() !== 'toc') out.push({ ref, label: bar >= 0 ? raw.slice(bar + 1).trim() : '', start: a, end: b + 2 });
      i = b + 2;
    } else i = a + 2;
  }
  return out;
}
export function resolveRef(ref, pages, spaceId = '') {
  const r = String(ref || '').trim();
  if (!r) return null;
  if (PAGE_ID_RE.test(r)) return pages.find((p) => p.id === r) || null;
  const low = r.toLowerCase();
  const hits = pages.filter((p) => String(p.title).toLowerCase() === low);
  return hits.find((p) => p.spaceId === spaceId) || hits[0] || null;
}
/** 이 문서를 가리키는 문서(볼 수 있는 것만 · 보관 포함). */
export function backlinks(id, access = FULL_ACCESS) {
  const all = load().pages;
  const me = findFor(id, access);
  const out = [];
  for (const p of all) {
    if (p.id === me.id || !canSeeSpace(p.spaceId, access)) continue;
    if (pageRefsOf(p.body).some((r) => resolveRef(r.ref, all, p.spaceId)?.id === me.id)) out.push(metaOf(p));
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}
/** 가리키는 곳이 없는 링크(볼 수 있는 문서 · 스페이스 선택). */
export function brokenLinks({ access = FULL_ACCESS, spaceId = '', limit = 200 } = {}) {
  const all = load().pages;
  const out = [];
  for (const p of all) {
    if (!canSeeSpace(p.spaceId, access) || (spaceId && p.spaceId !== spaceId)) continue;
    for (const r of pageRefsOf(p.body)) if (!resolveRef(r.ref, all, p.spaceId)) out.push({ id: p.id, title: p.title, spaceId: p.spaceId, ref: capStr(r.ref, 120) });
  }
  return { total: out.length, rows: out.slice(0, Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 200))) };
}
/**
 * 제목이 바뀐 문서를 '[[옛 제목]]' 으로 가리키던 링크를 새 제목으로 고친다 — 옛 제목이 **이 문서로 풀리던** 링크만(같은 제목의 다른 문서를 빼앗지 않는다).
 * 고칠 수 있는 문서(쓰기 범위 · 읽기 전용 아님)만 새 판으로(메모 '링크 갱신') · 나머지는 센다. renamedPage 는 바뀐 뒤의 문서.
 */
function rewriteLinksAfterRename(c, oldPages, renamed, oldTitle, user, access) {
  let fixed = 0; let skipped = 0;
  const now = Date.now();
  for (const p of [...c.pages]) {
    if (p.id === renamed.id) continue;
    const refs = pageRefsOf(p.body).filter((r) => !PAGE_ID_RE.test(r.ref) && r.ref.toLowerCase() === oldTitle.toLowerCase() && resolveRef(r.ref, oldPages, p.spaceId)?.id === renamed.id);
    if (!refs.length) continue;
    if (!canSeeSpace(p.spaceId, access) || !canEditSpace(p.spaceId, access) || c.spaces[p.spaceId]?.readOnly) { skipped += 1; continue; }
    let md = p.body; // 뒤에서부터 바꿔 자리(start/end)가 흔들리지 않게
    for (const r of [...refs].sort((a, b) => b.start - a.start)) md = `${md.slice(0, r.start)}[[${renamed.title}${r.label ? `|${r.label}` : ''}]]${md.slice(r.end)}`;
    if (md.length > LIMITS.body) { skipped += 1; continue; }
    const nx = { ...p, body: md, version: p.version + 1, updatedAt: Math.max(now, (p.updatedAt || 0) + 1), updatedBy: user, ...keyFields(p.title, md, ...commentTexts(p.comments)) };
    const x = { ...nx, ...pushVersion(nx, { by: user, note: capStr(`링크 갱신: ‘${oldTitle}’ → ‘${renamed.title}’`, LIMITS.note), at: nx.updatedAt }) };
    try { assertRoom(c, x, p.id); } catch { skipped += 1; continue; }
    c.pages = c.pages.map((q) => (q.id === p.id ? x : q));
    commit({ changed: x });
    fixed += 1;
  }
  return { fixed, skipped };
}

/* ───── v2.907 다른 스페이스로 옮기기(기능 추천 4) ─────
 * 문서와 그 아래 문서 전부를 함께(계층 그대로 · 옮긴 맨 위 문서는 새 스페이스의 맨 위로). 두 스페이스 모두 쓰기 범위 · 읽기 전용 아님.
 * 문서 번호(W…)는 그대로라 첨부 · 즐겨찾기 · 이슈 '관련 문서' 가 따라간다(첨부는 문서의 스페이스로 보기 범위를 판정한다).
 */
export function movePage(id, toSpace, user, { access = FULL_ACCESS, known = null } = {}) {
  const c = load();
  const p = findFor(id, access, { write: true });
  const to = String(toSpace || '').trim();
  if (!to || to === p.spaceId) throw fieldError('spaceId', '옮길 스페이스를 고르세요(지금 스페이스와 다른 곳)');
  if (to !== PUB && !VC_ID_RE.test(to)) throw fieldError('spaceId', '스페이스 형식이 아닙니다');
  if (to !== PUB && known && !known.has(to)) throw fieldError('spaceId', '등록되지 않은 법인(vCenter)입니다');
  if (!canSeeSpace(to, access)) throw fieldError('spaceId', '등록되지 않은 법인(vCenter)입니다'); // 조회 밖 — 존재를 흘리지 않는다
  if (!canEditSpace(to, access)) throw forbidden('옮길 스페이스는 쓰기 범위 밖입니다');
  if (c.spaces[to]?.readOnly) throw forbidden('옮길 스페이스는 읽기 전용입니다(스페이스 설정)');
  const ids = new Set([p.id]);
  for (let grew = true; grew;) { grew = false; for (const q of c.pages) if (!ids.has(q.id) && ids.has(q.parentId)) { ids.add(q.id); grew = true; } }
  const now = Date.now();
  const moved = [];
  c.pages = c.pages.map((q) => {
    if (!ids.has(q.id)) return q;
    const x = { ...q, spaceId: to, parentId: q.id === p.id ? '' : q.parentId, updatedAt: Math.max(now, (q.updatedAt || 0) + 1), updatedBy: user };
    moved.push(x);
    return x;
  });
  for (const x of moved) commit({ changed: x });
  return { id: p.id, spaceId: to, moved: moved.length, from: p.spaceId };
}

/* ───── v2.907 휴지통(기능 추천 2) ───── */
export const TRASH_DAYS = 30;
const DAY_MS = 86_400_000;
const trashView = (t) => ({ id: t.id, title: t.title, spaceId: t.spaceId, parentId: t.parentId || '', deletedAt: t.deletedAt, deletedBy: t.deletedBy || '', createdBy: t.createdBy || '', version: t.version, purgeAt: (t.deletedAt || 0) + TRASH_DAYS * DAY_MS });
/** 볼 수 있는 휴지통 항목(최근에 지운 것 먼저). */
export function listTrash({ access = FULL_ACCESS, spaceId = '' } = {}) {
  return (load().trash || []).filter((t) => canSeeSpace(t.spaceId, access) && (!spaceId || t.spaceId === spaceId)).sort((a, b) => b.deletedAt - a.deletedAt).map(trashView);
}
/** 기한(TRASH_DAYS)이 지난 휴지통 항목을 영구히 지운다 — 지운 id 목록(라우트가 첨부 · 즐겨찾기를 정리한다). */
export function purgeExpiredTrash(now = Date.now()) {
  const c = load();
  const keep = []; const gone = [];
  for (const t of c.trash || []) (now - (t.deletedAt || 0) > TRASH_DAYS * DAY_MS ? gone : keep).push(t);
  if (!gone.length) return [];
  c.trash = keep;
  for (const t of gone) commit({ removedId: t.id });
  return gone.map((t) => t.id);
}
/** 되살리기 — 원래 스페이스에(쓰기 범위 · 읽기 전용 아님). 상위 문서가 없어졌으면 맨 위로. */
export function restorePage(id, user, { access = FULL_ACCESS } = {}) {
  const c = load();
  const t = (c.trash || []).find((x) => x.id === id);
  if (!t || !canSeeSpace(t.spaceId, access)) throw notFound();
  if (!canEditSpace(t.spaceId, access)) throw forbidden('이 문서의 스페이스는 쓰기 범위 밖입니다 — 되살릴 수 없습니다');
  if (c.spaces[t.spaceId]?.readOnly) throw forbidden('이 스페이스는 읽기 전용입니다(스페이스 설정)');
  if (c.pages.some((q) => q.id === id)) throw limitError('같은 번호의 문서가 이미 있습니다');
  const { deletedAt, deletedBy, ...rest } = t; void deletedAt; void deletedBy;
  const parentOk = rest.parentId && c.pages.some((q) => q.id === rest.parentId && q.spaceId === rest.spaceId);
  const x = { ...rest, parentId: parentOk ? rest.parentId : '', updatedAt: Date.now(), updatedBy: user };
  c.trash = c.trash.filter((q) => q.id !== id);
  c.pages = [...c.pages, x];
  commit({ changed: x });
  return viewPage(x, user, access);
}
/** 영구 삭제 — 지운 사람 · 만든 사람 · 전체 범위 관리자(isMod). */
export function purgeTrashItem(id, user, { access = FULL_ACCESS, isMod = false } = {}) {
  const c = load();
  const t = (c.trash || []).find((x) => x.id === id);
  if (!t || !canSeeSpace(t.spaceId, access)) throw notFound();
  if (!canEditSpace(t.spaceId, access)) throw forbidden('이 문서의 스페이스는 쓰기 범위 밖입니다');
  if (!isMod && t.deletedBy !== user && t.createdBy !== user) throw forbidden('영구 삭제는 지운 사람 · 만든 사람이나 전체 범위 관리자만 합니다');
  c.trash = c.trash.filter((q) => q.id !== id);
  commit({ removedId: id });
  return { id };
}

export function addComment(id, body, user, { access = FULL_ACCESS } = {}) {
  const c = load();
  const p = findFor(id, access);
  if (!canEditSpace(p.spaceId, access)) throw forbidden('이 문서의 스페이스는 쓰기 범위 밖입니다 — 조회만 할 수 있습니다');
  const comments = p.comments || [];
  if (comments.length >= LIMITS.comments) throw limitError(`댓글은 문서마다 ${LIMITS.comments}개까지입니다`);
  const quote = text(body?.quote ?? '', LIMITS.quote, 'quote').replace(/\s+/g, ' ').trim(); // v2.889 인라인 댓글 — 선택한 글(본문에 있는지는 보지 않는다 — 판이 바뀌면 사라질 수 있다)
  const cm = { id: crypto.randomBytes(6).toString('hex'), author: user, body: text(body?.body, LIMITS.comment, 'body', { required: true, multiline: true }), at: Date.now(), v: p.version, ...(quote ? { quote } : {}) };
  const x = { ...p, comments: [...comments, cm], ...keyFields(p.title, p.body, ...commentTexts(comments), cm.body) };
  assertRoom(c, x, p.id);
  c.pages = c.pages.map((q) => (q.id === p.id ? x : q));
  commit({ changed: x });
  emit({ type: 'comment', actor: user, page: evPage(x), excerpt: capStr(cm.body, 200), mentions: mentionsOf(cm.body) });
  return cm;
}
/** v2.907 한 댓글(볼 수 있는 문서 · 없으면 404) — 댓글에서 이슈를 만들 때 라우트가 읽는다. */
export function getComment(id, commentId, access = FULL_ACCESS) {
  const p = findFor(id, access);
  const cm = (p.comments || []).find((x) => x.id === commentId);
  if (!cm) throw notFound();
  return { page: { id: p.id, title: p.title, spaceId: p.spaceId, createdBy: p.createdBy || '', watchers: [...(p.watchers || [])] }, comment: { ...cm } };
}
/** 이 문서의 참여자(만든 사람 · 고친 사람 · 지켜보는 사람 · 댓글 쓴 사람) — 멘션 후보(볼 수 있는 문서만). */
export function pageParticipants(id, access = FULL_ACCESS) {
  const p = findFor(id, access);
  const s = new Set([p.createdBy, p.updatedBy, ...(p.watchers || []), ...(p.comments || []).map((q) => q.author)].filter(Boolean));
  return { spaceId: p.spaceId, names: [...s] };
}
/**
 * v2.907 댓글에서 만든 이슈의 키를 그 댓글에 적는다(같은 댓글로 두 번 만들지 않게 · '관련 이슈' 색인). 판을 만들지 않는다.
 * 쓰기 범위는 보지 않는다 — 이슈를 만든 라우트가 이미 댓글 · 이슈 권한을 봤다(조회 범위만).
 */
export function setCommentIssue(id, commentId, key, { access = FULL_ACCESS } = {}) {
  const c = load();
  const p = findFor(id, access);
  if (!(p.comments || []).some((x) => x.id === commentId)) throw notFound();
  const comments = p.comments.map((x) => (x.id === commentId ? { ...x, issueKey: String(key || '').slice(0, 20) } : x));
  const x = { ...p, comments, ...keyFields(p.title, p.body, ...commentTexts(comments)) };
  assertRoom(c, x, p.id);
  c.pages = c.pages.map((q) => (q.id === p.id ? x : q));
  commit({ changed: x });
  return comments.find((q) => q.id === commentId);
}
export function deleteComment(id, commentId, user, { access = FULL_ACCESS, isMod = false } = {}) {
  const c = load();
  const p = findFor(id, access);
  const cm = (p.comments || []).find((x) => x.id === commentId);
  if (!cm) throw notFound();
  if (!isMod && cm.author !== user) throw forbidden('댓글은 쓴 사람이나 전체 범위 관리자만 지울 수 있습니다');
  const comments = p.comments.filter((x) => x.id !== commentId);
  const x = { ...p, comments, ...keyFields(p.title, p.body, ...commentTexts(comments)) };
  c.pages = c.pages.map((q) => (q.id === p.id ? x : q));
  commit({ changed: x });
  return { id: commentId };
}
/**
 * v2.889 인라인 댓글 해결 표시 — 쓴 사람 · 그 스페이스의 쓰기 역할(라우트가 canWrite 로 넘긴다) · 전체 범위 관리자. 판을 만들지 않는다.
 */
export function resolveComment(id, commentId, user, on, { access = FULL_ACCESS, canWrite = false, isMod = false } = {}) {
  const c = load();
  const p = findFor(id, access);
  const cm = (p.comments || []).find((x) => x.id === commentId);
  if (!cm) throw notFound();
  if (!isMod && cm.author !== user && !(canWrite && writableBy(p, access))) throw forbidden('해결 표시는 댓글을 쓴 사람이나 이 문서를 고칠 수 있는 사람이 합니다');
  if (typeof on !== 'boolean') throw fieldError('on', 'true 또는 false 여야 합니다');
  const next = { ...cm };
  if (on) Object.assign(next, { resolved: true, resolvedBy: user, resolvedAt: Date.now() }); else { delete next.resolved; delete next.resolvedBy; delete next.resolvedAt; }
  const x = { ...p, comments: p.comments.map((q) => (q.id === commentId ? next : q)) };
  c.pages = c.pages.map((q) => (q.id === p.id ? x : q));
  commit({ changed: x });
  return { ...next };
}
export function setWatch(id, user, on, { access = FULL_ACCESS } = {}) {
  const c = load();
  const p = findFor(id, access);
  const set = new Set(p.watchers || []);
  if (on) { if (set.size >= LIMITS.watchers && !set.has(user)) throw limitError(`지켜보는 사람은 ${LIMITS.watchers}명까지입니다`); set.add(user); } else set.delete(user);
  const x = { ...p, watchers: [...set] };
  c.pages = c.pages.map((q) => (q.id === p.id ? x : q));
  commit({ changed: x });
  return { watching: !!on, watchers: x.watchers.length };
}

/* ───── 찾기 · 역참조 · 대문 ───── */
function snippetOf(s, needle) {
  const src = String(s || '');
  const i = src.toLowerCase().indexOf(needle);
  if (i < 0) return '';
  const from = Math.max(0, i - 60);
  return `${from ? '…' : ''}${src.slice(from, i + needle.length + 80).replace(/\s+/g, ' ')}${i + needle.length + 80 < src.length ? '…' : ''}`;
}
export function searchPages({ q = '', spaceId = '', label = '', status = '', issueKey = '', includeArchived = false, limit = LIMITS.search, access = FULL_ACCESS } = {}) {
  const needle = String(q || '').trim().toLowerCase().slice(0, 100);
  const key = /^ISS-\d{1,9}$/.test(String(issueKey || '').trim()) ? issueKey.trim() : (/^ISS-\d{1,9}$/i.test(needle) ? needle.toUpperCase() : '');
  const hits = [];
  for (const p of load().pages) {
    if (!canSeeSpace(p.spaceId, access)) continue; // 범위가 필터보다 먼저
    if (spaceId && p.spaceId !== spaceId) continue;
    if (label && !(p.labels || []).includes(label)) continue;
    if (status ? p.status !== status : (!includeArchived && p.status === 'archived')) continue;
    if (key && !(p.issueKeys || []).includes(key)) continue;
    let where = ''; let snippet = '';
    if (needle && !key) {
      if (p.title.toLowerCase().includes(needle)) { where = 'title'; snippet = snippetOf(p.body, needle) || capStr(String(p.body || '').replace(/\s+/g, ' '), 160); }
      else if ((p.body || '').toLowerCase().includes(needle)) { where = 'body'; snippet = snippetOf(p.body, needle); }
      else { const cm = (p.comments || []).find((x) => x.body.toLowerCase().includes(needle)); if (!cm) continue; where = 'comment'; snippet = `${cm.author}: ${snippetOf(cm.body, needle)}`; }
    }
    hits.push({ ...metaOf(p), where, snippet: capStr(snippet, 300) });
  }
  const rank = { title: 0, body: 1, comment: 2, '': 0 };
  hits.sort((a, b) => (rank[a.where] - rank[b.where]) || (b.updatedAt - a.updatedAt));
  const lim = Math.max(1, Math.min(200, Math.trunc(Number(limit)) || LIMITS.search));
  return { total: hits.length, rows: hits.slice(0, lim), limit: lim };
}
/** 이 이슈 키를 적은 문서(보이는 것만) — 이슈 상세 '관련 문서'. */
export function backrefs(issueKey, access = FULL_ACCESS) {
  const key = String(issueKey || '').trim();
  if (!/^ISS-\d{1,9}$/.test(key)) return [];
  return load().pages.filter((p) => canSeeSpace(p.spaceId, access) && (p.issueKeys || []).includes(key)).map(metaOf).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
}

/** 이슈 키 → 그 키를 적은 문서 제목(보이는 스페이스만 · 키마다 20개) — 이슈 검색식 `doc` 필드(v2.882). */
export function issueDocIndex(access = FULL_ACCESS) {
  const m = new Map();
  for (const p of load().pages) {
    if (!canSeeSpace(p.spaceId, access)) continue;
    for (const k of p.issueKeys || []) { const a = m.get(k); if (!a) m.set(k, [p.title]); else if (a.length < 20) a.push(p.title); }
  }
  return m;
}

/** 대문(시안 ①) — 자동 영역은 손으로 적지 않고 여기서 모은다. */
export function homeOf(spaceId, { access = FULL_ACCESS, me = '', now = Date.now(), views = null } = {}) {
  if (!canSeeSpace(spaceId, access)) throw notFound();
  const c = load();
  const pages = c.pages.filter((p) => p.spaceId === spaceId);
  const live = pages.filter((p) => p.status !== 'archived');
  const labels = new Map();
  for (const p of live) for (const l of p.labels || []) labels.set(l, (labels.get(l) || 0) + 1);
  const space = spaceView(spaceId, access);
  const notice = space.notice && (!space.notice.until || space.notice.until > now) ? space.notice : null;
  const lastNote = (p) => { const v = (p.versions || [])[(p.versions || []).length - 1]; return v?.note || ''; };
  const today = dayKey(now);
  const oncall = space.oncall || [];
  return {
    space: { ...space, notice },
    // v2.889 당번 — 오늘(포탈 날짜)이 범위 안인 줄 · 다음 줄(오늘 뒤 시작 · 가장 이른 것 하나)
    oncallNow: oncall.filter((o) => o.from <= today && today <= o.to),
    oncallNext: oncall.filter((o) => o.from > today).slice(0, 1),
    counts: {
      pages: live.length, changed7d: live.filter((p) => now - p.updatedAt <= 7 * DAY).length, review: live.filter((p) => p.status === 'review').length,
      myDrafts: me ? live.filter((p) => p.status === 'draft' && p.createdBy === me).length : 0, watching: me ? live.filter((p) => (p.watchers || []).includes(me)).length : 0,
      stale90: live.filter((p) => now - p.updatedAt > 90 * DAY).length, archived: pages.length - live.length,
    },
    recent: [...live].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8).map((p) => ({ ...metaOf(p), note: lastNote(p) })),
    review: live.filter((p) => p.status === 'review').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8).map(metaOf),
    myDrafts: me ? live.filter((p) => p.status === 'draft' && p.createdBy === me).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8).map(metaOf) : [],
    faq: live.filter((p) => (p.labels || []).includes('faq')).sort((a, b) => a.title.localeCompare(b.title)).slice(0, 10).map(metaOf),
    stale: live.filter((p) => now - p.updatedAt > 90 * DAY).sort((a, b) => a.updatedAt - b.updatedAt).slice(0, 8).map(metaOf),
    // v2.888 많이 본 문서(최근 30일 · 사람/날/문서마다 1회) — views = Map(id → n)(wiki/userState.js). 이 스페이스의 보관 아닌 문서만.
    popular: views instanceof Map ? live.filter((p) => views.get(p.id) > 0).sort((a, b) => (views.get(b.id) - views.get(a.id)) || (b.updatedAt - a.updatedAt))
      .slice(0, 8).map((p) => ({ ...metaOf(p), views: views.get(p.id) })) : null,
    labels: [...labels.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 30).map(([name, n]) => ({ name, n })),
    tree: pages.map(metaOf).sort((a, b) => (a.order - b.order) || a.title.localeCompare(b.title)),
  };
}
