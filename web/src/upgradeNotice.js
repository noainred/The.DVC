/**
 * upgradeNotice.js — 업그레이드 뒤 '새로고침 하세요' 안내의 판정 코어(v2.999 · 사용자 요청 2026-11-13 ·
 * 설계 docs/design/upgrade-reload · 컨펌 '추천대로 전부 진행').
 *
 * 왜: 업그레이드는 서버를 새 판으로 바꾸지만 이미 열려 있던 창은 옛 판 화면 코드를 그대로 돌린다. 그 창에서 화면 오류가 나면
 * 예전에는 빨간 '이 영역을 표시하는 중 오류가 발생했습니다' + 오류 원문이 떠 사용자가 결함으로 알았다. 이제는
 * **이 창이 받은 판 ≠ 서버의 판** 이면 '프로그램이 업그레이드되었으니 새로고침 하세요' + 이번 업그레이드에서 바뀐 것 + 새로고침을 보인다.
 *
 * 규칙(회귀 방지):
 *  · 이 창의 판 = 빌드에 새긴 버전(vite define `import.meta.env.VITE_APP_VERSION` ← web/package.json — release.sh 가 세 package.json 을 같이 올린다).
 *    빌드 값이 없으면(개발 서버 · 테스트) 처음 본 서버 버전을 이 창의 판으로 본다(v2.458 업그레이드 토스트의 옛 방식).
 *  · 서버의 판 = /api/health 의 version(전 사용자 응답에 있다). App 의 20초 폴링이 noteServerVersion 으로 넣고,
 *    오류 경계는 오류를 잡은 순간 한 번 더 읽는다(checkServerVersion — 폴링 사이에 업그레이드된 경우).
 *  · **판이 같으면 지금 오류 상자 그대로**(오류 원문 + 다시 시도) — 진짜 결함을 업그레이드 탓으로 가리지 않는다.
 *  · 버전을 못 읽으면(형식이 아니면) '다르다' 고 하지 않는다(null → false). 판정은 isStale 하나.
 *  · 이 모듈과 오류 상자(components/UpgradeNotice.jsx)는 **주 번들**에 있어야 한다 — 옛 판 창은 lazy 청크를 못 받을 수 있다.
 *    `/api/release-notes/since` 는 옛 판 창이 새 서버에 부르는 경로라 **이름 · 모양을 바꾸지 않는다**(테스트가 대조).
 */
import { fetchJson } from './api.js';

export const UPGRADE_TITLE = '프로그램이 업그레이드되었으니 새로고침 하세요.';
export const UPGRADE_SUB = '열어 둔 창은 업그레이드 전 판이라 화면이 맞지 않을 수 있습니다. 새로고침하면 새 판으로 열립니다.';
export const CHANGES_HEAD = '이번 업그레이드에서 바뀐 것';
/** 서버 경로(api 기준) — server/src/routes/api/searchNotes.js 와 같은 글자. 옛 판 창이 부르므로 바꾸지 않는다. */
export const SINCE_PATH = '/release-notes/since';
/** 접힌 상태에서 보이는 줄 수(사용자 요청 '3줄 요약 · 넘는 것은 More'). */
export const SUMMARY_LINES = 3;

const VER_RE = /^(\d{1,4})\.(\d{1,5})\.(\d{1,6})$/;

/** 'a.b.c' → 정규화한 문자열 · 아니면 null(앞뒤 공백만 허용 · 길이 상한). */
export function normVersion(v) {
  if (typeof v !== 'string' || v.length > 32) return null;
  const s = v.trim();
  return VER_RE.test(s) ? s : null;
}

/** 두 버전 비교 — a<b 이면 음수 · 같으면 0 · a>b 이면 양수. 하나라도 형식이 아니면 null. */
export function cmpVersion(a, b) {
  const x = normVersion(a); const y = normVersion(b);
  if (!x || !y) return null;
  const pa = x.split('.').map(Number); const pb = y.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** 이 창의 판(loaded)과 서버의 판(server)이 다른가. 못 읽은 값이 있으면 false(단정하지 않는다). 되돌림(서버가 더 낮음)도 다르다. */
export function isStale(loaded, server) {
  const c = cmpVersion(loaded, server);
  return c != null && c !== 0;
}

/** 빌드에 새긴 이 창의 판(없으면 null). */
function builtVersion() {
  // ⚠ 'import.meta.env.VITE_APP_VERSION' 을 이 글자 그대로 쓴다 — vite define 이 글자를 바꿔 넣는다(?. 을 넣으면 바뀌지 않는다).
  try { return normVersion(import.meta.env.VITE_APP_VERSION); } catch { return null; }
}
export const BUILT_VERSION = builtVersion();

// ── 서버 판 저장소(모듈 하나 — App 폴링 · 오류 경계 · 토스트가 같은 값을 본다) ─────────────────────────────
let _loaded = BUILT_VERSION;
let _server = null;
const _subs = new Set();
const emit = () => { for (const fn of [..._subs]) { try { fn(); } catch { /* 구독자 오류가 다른 구독자를 막지 않는다 */ } } };

/** 이 창의 판 — 빌드 값, 없으면 처음 본 서버 판. */
export const loadedVersion = () => _loaded;
/** 마지막으로 읽은 서버 판(없으면 null). */
export const serverVersion = () => _server;
/** 지금 다른 판인가. */
export const staleNow = () => isStale(_loaded, _server);

// 안내 상자가 지금 화면에 있는가(개수) — 있으면 같은 말을 하는 알림을 숨긴다(Chromium 판독: 1440 에서 알림이 상자 모서리를 덮었다).
let _noticeShown = 0;
export const noticeShown = () => _noticeShown > 0;
/** UpgradeNotice 가 마운트될 때 부른다 — 돌려준 함수로 해제. */
export function markNoticeShown() {
  _noticeShown += 1; emit();
  let done = false;
  return () => { if (done) return; done = true; _noticeShown = Math.max(0, _noticeShown - 1); emit(); };
}

/** 서버 판을 넣는다(형식이 아니면 무시). 빌드 값이 없으면 처음 값을 이 창의 판으로 삼는다. 값이 바뀌면 구독자를 부른다. */
export function noteServerVersion(v) {
  const s = normVersion(v);
  if (!s) return;
  if (!_loaded) _loaded = s;
  if (s === _server) return;
  _server = s;
  emit();
}
export function subscribeUpgrade(fn) {
  if (typeof fn !== 'function') return () => {};
  _subs.add(fn);
  return () => { _subs.delete(fn); };
}

/** 오류를 잡은 순간 서버 판을 한 번 더 읽는다(짧은 시한 · 재시도 없음). 실패해도 던지지 않는다. */
export async function checkServerVersion(fetcher = fetchJson) {
  try {
    const d = await fetcher('/health', {}, undefined, { timeoutMs: 5000, retries: 0 });
    noteServerVersion(d?.version);
  } catch { /* 못 읽으면 판정하지 않는다 */ }
  return staleNow();
}

// ── 바뀐 것(릴리스 노트) ─────────────────────────────────────────────────────────────────────────────

/** 서버 응답의 notes[] 를 화면 모양으로 — 아는 필드만 · 문자열만. 판(version)이 형식이 아니면 버린다. */
export function cleanSince(data) {
  const list = Array.isArray(data?.notes) ? data.notes : null;
  if (!list) return null;
  const out = [];
  for (const n of list) {
    if (!n || typeof n !== 'object') continue;
    const version = normVersion(n.version);
    if (!version) continue;
    const title = typeof n.title === 'string' ? n.title.trim() : '';
    const notes = (Array.isArray(n.notes) ? n.notes : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
    out.push({ version, title, lines: notes.length ? notes : (title ? [title] : []) });
  }
  return { notes: out, truncated: Number.isInteger(data?.truncated) && data.truncated > 0 ? data.truncated : 0 };
}

/**
 * 접힘 요약 — 새 판부터 차례로 펼친 줄의 앞 n줄(줄마다 한 줄로 줄여 보이는 것은 CSS). 나머지 수는 more.
 * 반환 { head: [{ version, text }], total, more, versions }.
 */
export function summarize(clean, n = SUMMARY_LINES) {
  const groups = Array.isArray(clean?.notes) ? clean.notes : [];
  const flat = [];
  for (const g of groups) for (const t of g.lines) flat.push({ version: g.version, text: t });
  const k = Math.max(0, Math.min(n, flat.length));
  return { head: flat.slice(0, k), total: flat.length, more: flat.length - k, versions: groups.length };
}

/** 응답 캐시 — 같은 (이 창 판 → 서버 판) 은 한 번만 부른다(실패는 지워 다음에 다시). */
const _sinceCache = new Map();
export function loadSince(from, to, fetcher = fetchJson) {
  const f = normVersion(from); const t = normVersion(to);
  if (!f || !t || f === t) return Promise.resolve(null);
  const key = `${f}>${t}`;
  if (_sinceCache.has(key)) return _sinceCache.get(key);
  const p = fetcher(SINCE_PATH, { from: f }, undefined, { timeoutMs: 8000, retries: 1 })
    .then((d) => cleanSince(d))
    .catch(() => null)
    .then((v) => { if (!v) _sinceCache.delete(key); return v; });
  _sinceCache.set(key, p);
  return p;
}

/** 테스트 전용 — 저장소 초기화. */
export function _resetUpgradeForTest({ loaded = null } = {}) {
  _loaded = normVersion(loaded) || null; _server = null; _noticeShown = 0; _subs.clear(); _sinceCache.clear();
}
