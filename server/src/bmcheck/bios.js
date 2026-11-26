/**
 * bmcheck/bios.js — 물리서버 **BIOS 설정 편차**의 판정 코어(v3.45 · 설계 docs/design/bm-feature-proposals ③). 순수.
 *
 *  · 입력은 포탈이 이미 읽는 BIOS 설정(`inv.bios.attributes` — idrac/biosKeys.js BIOS_KEYS 목록만). 새 수집이 없다.
 *  · 비교 묶음 = **같은 법인 · 같은 폴더 · 같은 모델**(물리서버 폴더에 넣은 서버만 — 폴더가 '같은 일을 하는 서버' 의 단서다).
 *    미분류 서버는 판정하지 않는다(unplaced) — 같은 모델이라는 것만으로 같은 일을 한다고 볼 수 없다.
 *  · 설정마다 묶음의 다수 값(util/majority.js)과 견준다. 다수가 없으면(동률 · 아는 서버 1대) 어느 쪽이 옳다고 말하지 않는다(tie).
 *    **다수 값이 옳다는 뜻이 아니다** — 같은 일을 하는 서버끼리 다른 점만 보인다(문구는 웹 checkText.js).
 *  · 못 읽은 것은 같음에도 다름에도 넣지 않는다: unread(설정 없음) · unsent(엣지가 보내지 않음) · 행 state 'unread'(그 설정만 없음).
 */
import { BIOS_KEYS } from '../idrac/biosKeys.js';
import { majorityOf } from '../util/majority.js';

export const BIOS_VALUE_MAX = 64;
const lc = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const valOf = (v) => {
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return '';
  let out = ''; const s = String(v).slice(0, BIOS_VALUE_MAX * 2);
  for (let i = 0; i < s.length; i += 1) { const c = s.charCodeAt(i); out += c < 32 || c === 127 ? ' ' : s[i]; }
  return out.trim().slice(0, BIOS_VALUE_MAX);
};

/** 인벤토리의 BIOS 설정 → 아는 항목만 { 키: 값 }. 항목이 하나도 없으면 null(못 읽음). */
export function biosAttrsOf(attributes) {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return null;
  const out = {}; let n = 0;
  for (const k of BIOS_KEYS) { const v = valOf(attributes[k]); if (v) { out[k] = v; n += 1; } }
  return n ? out : null;
}
/** 엣지 push 에 싣는 꼴 — 아는 항목만. 없으면 undefined(키를 만들지 않는다). */
export function biosPushOf(inv) { return biosAttrsOf(inv?.bios?.attributes) || undefined; }
/** 엣지가 보낸 BIOS 설정 정제(중앙) — 아는 키만 · 글자(수 · 참거짓은 글자로) · 상한. 형식이 아니면 undefined. */
export function sanitizeBiosPush(raw) { return biosAttrsOf(raw) || undefined; }

/**
 * 함대 판정(순수).
 * @param {Array<{ id:string, corp:string, path:string, model:string, bios: object|null|undefined }>} servers
 *        path '' = 미분류 · bios: 객체 = 읽음 · null = 못 읽음 · undefined = 보내지 않음(엣지 구버전)
 * @returns {Map<string, { state:'ok'|'diff'|'none'|'unread'|'unsent'|'unplaced', rows:object[], diff:number, group:{ size:number, known:number } }>}
 *   group.size = 같은 묶음 서버 수(이 서버 포함) · known = 그중 BIOS 설정을 읽은 수
 */
export function judgeBios(servers) {
  const list = Array.isArray(servers) ? servers : [];
  const groupOf = (s) => (lc(s.corp) && lc(s.path) && lc(s.model) ? `${lc(s.corp)}\u0000${lc(s.path)}\u0000${lc(s.model)}` : '');
  const groups = new Map();   // g → { size, known, vals: Map<키, 값[]> }
  for (const s of list) {
    if (!s) continue;
    const g = groupOf(s);
    if (!g) continue;
    let x = groups.get(g);
    if (!x) { x = { size: 0, known: 0, vals: new Map() }; groups.set(g, x); }
    x.size += 1;
    if (!s.bios || typeof s.bios !== 'object') continue;
    x.known += 1;
    for (const k of BIOS_KEYS) { const v = s.bios[k]; if (typeof v === 'string' && v) { const a = x.vals.get(k); if (a) a.push(v); else x.vals.set(k, [v]); } }
  }
  const major = new Map();
  for (const [g, x] of groups) { const m = new Map(); for (const [k, vals] of x.vals) m.set(k, majorityOf(vals)); major.set(g, m); }
  const out = new Map();
  for (const s of list) {
    if (!s) continue;
    const g = groupOf(s);
    const x = g ? groups.get(g) : null;
    const group = { size: x?.size || 0, known: x?.known || 0 };
    const base = { rows: [], diff: 0, group };
    if (s.bios === undefined) { out.set(s.id, { state: 'unsent', ...base }); continue; }
    if (!s.bios || typeof s.bios !== 'object') { out.set(s.id, { state: 'unread', ...base }); continue; }
    if (!g) { out.set(s.id, { state: 'unplaced', ...base }); continue; }
    const mj = major.get(g);
    let diff = 0; let judged = 0;
    const rows = [];
    for (const k of BIOS_KEYS) {
      const m = mj.get(k);
      if (!m) continue;   // 묶음의 어느 서버도 이 설정을 주지 않았다
      const v = typeof s.bios[k] === 'string' ? s.bios[k] : '';
      let state;
      if (!v) state = 'unread';
      else if (!m.value) state = 'tie';
      else if (v === m.value) state = 'same';
      else state = 'diff';
      if (state === 'diff') diff += 1;
      if (state === 'same' || state === 'diff') judged += 1;
      rows.push({ k, v: v || null, major: m.value, majorN: m.count, known: m.known, state });
    }
    out.set(s.id, { state: !judged ? 'none' : diff ? 'diff' : 'ok', rows, diff, group });
  }
  return out;
}
