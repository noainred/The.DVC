/**
 * views/tools/bmShare.js — 리눅스 성능 6단계 **공유 링크**(설계 PROFILES §16 B · 아트보드 Annot ‘공유’) — 화면 상태 ↔ URL 해시(순수 · vitest).
 *
 * 규약(hooks/hashTab.js — 첫 세그먼트가 상단 탭, 그 뒤는 각 뷰): 도구 키는 그대로 `#/tools/bm-usage` 이고 상태는 그 아래 `share?…` 질의로 싣는다
 *   (`#/tools/bm-usage/share?view=compare&keys=…` — SpecialTools 의 도구 판정은 두 번째 조각만 본다 · 위키 해시 질의와 같은 꼴).
 * ⚠ 링크는 권한을 주지 않는다 — 여는 사람의 권한으로 서버가 다시 판정한다(범위 밖 · 사라진 서버는 404 · 비교 열 ‘없음’). 이 모듈은 형식만 본다(화이트리스트 · 길이 · 수).
 * ⚠ 값은 화면 상태뿐(서버 키 · 기간 · 커서 · 구간 · 토글 · 보기) — 비밀 · 이름 · 주소를 싣지 않는다(키는 화면이 쓰는 값 그대로 — 비관리자는 가림 토큰).
 */
import { TREND_RANGES, DISK_MODES, NET_MODES, LAYOUTS, SHOW_MODES } from './bmTrendText.js';
import { DETAIL_TABS } from './bmPerfText.js';
import { COMPARE_VIEWS, COMPARE_GROUP_TEXT, COMPARE_VALUE_TEXT, COMPARE_RANGES } from './bmCompareText.js';

const VIEWS = Object.freeze(['detail', 'compare']);
// 허용 값은 화면이 쓰는 표에서(두 벌 두지 않는다 — 탭 · 기간 · 토글이 늘면 링크도 따라간다).
const TABS = Object.freeze(DETAIL_TABS.map((x) => x.id));
const RANGES = Object.freeze(TREND_RANGES.map((x) => x.k));
const CMP_RANGES = Object.freeze(COMPARE_RANGES.map((x) => x.k));
const SHOW = Object.freeze(SHOW_MODES.map((x) => x.k));
const CMP_VIEWS = COMPARE_VIEWS;
const GROUPS = Object.freeze(Object.keys(COMPARE_GROUP_TEXT));
const VALUES = Object.freeze(Object.keys(COMPARE_VALUE_TEXT));
const DISK = Object.freeze(DISK_MODES.map((x) => x.k));
const NET = Object.freeze(NET_MODES.map((x) => x.k));
const LAYOUT = Object.freeze(LAYOUTS.map((x) => x.k));
const KEY_RE = /^[^\s,&#?/\\]{1,256}$/;
// 다음 점검 ①: 서버 = (법인, 키) 쌍 — 상세 링크에 법인(vCenter id)을 싣는다(없으면 예전처럼 키만 — 같은 키가 여러 법인이면 화면이 법인 고르기를 보인다).
//   비교 링크의 keys 는 ‘법인|키’ 쌍 글자(bmPerfUrl.refOf — 법인 id 에는 ‘|’ 가 없다).
const VC_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
const METRIC_RE = /^[a-z0-9_]{1,40}$/;
const n = (v) => { if (typeof v !== 'string' || !/^\d{10,14}$/.test(v)) return null; const x = Number(v); return Number.isFinite(x) ? x : null; };
const pick = (v, list) => (list.includes(v) ? v : null);
const dec = (s) => { try { return decodeURIComponent(s); } catch { return ''; } };

/** 상태 → 해시(순수). 모르는 값 · 빈 값은 싣지 않는다. */
export function shareHashOf(st = {}) {
  const p = [];
  const put = (k, v) => { if (v != null && v !== '') p.push(`${k}=${encodeURIComponent(String(v))}`); };
  const view = pick(st.view, VIEWS);
  if (!view) return '#/tools/bm-usage';
  put('view', view);
  if (view === 'detail') {
    if (!KEY_RE.test(String(st.key || ''))) return '#/tools/bm-usage';
    put('key', st.key); put('vc', VC_RE.test(String(st.vc || '')) ? st.vc : null); put('tab', pick(st.tab, TABS)); put('range', pick(st.range, RANGES)); put('show', pick(st.show, SHOW));
    put('to', Number.isFinite(st.to) ? Math.round(st.to) : null); put('cur', Number.isFinite(st.cursor) ? Math.round(st.cursor) : null);
    if (st.sel && Number.isFinite(st.sel.from) && Number.isFinite(st.sel.to) && st.sel.to > st.sel.from) put('sel', `${Math.round(st.sel.from)}~${Math.round(st.sel.to)}`);
    put('disk', pick(st.disk, DISK)); put('net', pick(st.net, NET)); put('layout', pick(st.layout, LAYOUT));
  } else {
    const keys = (Array.isArray(st.keys) ? st.keys : []).filter((k) => KEY_RE.test(String(k))).slice(0, 8);
    if (!keys.length) return '#/tools/bm-usage';
    put('keys', keys.join(',')); put('cross', st.cross === true ? '1' : null); put('range', pick(st.range, CMP_RANGES));
    put('cv', pick(st.cv, CMP_VIEWS)); put('grp', pick(st.group, GROUPS)); put('val', pick(st.value, VALUES)); put('m', METRIC_RE.test(String(st.metric || '')) ? st.metric : null);
  }
  return `#/tools/bm-usage/share?${p.join('&')}`;
}

/** 해시 → 상태(순수). 이 형식이 아니면 null(잘못된 링크로 화면이 깨지지 않게 — 모르는 값은 버린다). */
export function parseShareHash(hash) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const qi = raw.indexOf('?');
  if (qi < 0 || raw.slice(0, qi) !== 'tools/bm-usage/share') return null;
  const q = {};
  for (const part of raw.slice(qi + 1, qi + 1 + 4_000).split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = dec(part.slice(0, eq)); const v = dec(part.slice(eq + 1));
    if (k && !Object.hasOwn(q, k) && v.length <= 2_100) q[k] = v;
  }
  const view = pick(q.view, VIEWS);
  if (!view) return null;
  if (view === 'detail') {
    if (!KEY_RE.test(q.key || '')) return null;
    const [a, b] = String(q.sel || '').split('~').map(n);
    return { view, key: q.key, ...(VC_RE.test(q.vc || '') ? { vc: q.vc } : {}), tab: pick(q.tab, TABS) || 'summary', range: pick(q.range, RANGES), show: pick(q.show, SHOW), to: n(q.to), cursor: n(q.cur),
      sel: a != null && b != null && b > a ? { from: a, to: b } : null, disk: pick(q.disk, DISK), net: pick(q.net, NET), layout: pick(q.layout, LAYOUT) };
  }
  const keys = String(q.keys || '').split(',').filter((k) => KEY_RE.test(k)).slice(0, 8);
  if (!keys.length) return null;
  return { view, keys, cross: q.cross === '1', range: pick(q.range, CMP_RANGES), cv: pick(q.cv, CMP_VIEWS), group: pick(q.grp, GROUPS), value: pick(q.val, VALUES), metric: METRIC_RE.test(q.m || '') ? q.m : null };
}
/** 지금 포탈 주소의 공유 링크(절대 주소). */
export function shareUrlOf(st, loc = (typeof window !== 'undefined' ? window.location : null)) {
  const h = shareHashOf(st);
  return loc ? `${loc.origin}${loc.pathname}${h}` : h;
}
export const SHARE_HONEST = '링크는 권한을 주지 않습니다 — 여는 사람의 권한으로 다시 판정합니다(범위 밖이면 보이지 않고, 사라진 서버는 ‘없음’). 링크에는 화면 상태(서버 키 · 기간 · 커서 · 구간 · 토글 · 보기)만 담깁니다.';
/** 공유 링크로 연 서버를 찾지 못했을 때(404 · 비교 열 none) — 사라졌거나 볼 수 없는 서버를 구분하지 않는다(존재 은닉). */
export const SHARE_MISSING_TEXT = '공유 링크의 서버를 찾지 못했습니다 — 등록부에서 빠졌거나 이 계정의 범위 밖입니다(둘을 구분하지 않습니다). 등록부에서 빠진 서버의 이력은 보존 기간 동안 저장소에 남지만 화면은 등록된 서버만 엽니다.';

/** 캡처 각주(맥락) — 서버 · 법인 · 기간 · 커서 · 출처 · 생성 시각 · 생성자. 값이 없으면 그 줄을 빼지 않고 ‘—’. */
export function captureFooter({ title = '', servers = [], corps = [], from = null, to = null, cursor = null, source = '', by = '', at = Date.now(), note = '' } = {}) {
  const ts = (ms) => (Number.isFinite(ms) ? new Date(ms).toLocaleString('ko-KR', { hour12: false }) : '—');
  return [
    title || '베어메탈 통합 성능',
    `서버 ${servers.length ? servers.slice(0, 5).join(' · ') : '—'} · 법인 ${corps.length ? [...new Set(corps)].join(' · ') : '—'}`,
    `기간 ${ts(from)} ~ ${ts(to)}${Number.isFinite(cursor) ? ` · 커서 ${ts(cursor)}` : ''}`,
    `출처 ${source || '—'} · 생성 ${ts(at)} · ${by || '—'}${note ? ` · ${note}` : ''}`,
  ];
}
