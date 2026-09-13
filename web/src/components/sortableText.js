/**
 * 표 자동 정렬의 순수 로직(v2.422, 사용자 요구 '모든 표에 제목 클릭 정렬'). DOM 없이 React 엘리먼트 트리만 다루므로
 * node 환경 테스트로 고정한다. STable.jsx 가 이 함수들로 헤더 클릭 → tbody 행 재정렬을 수행한다.
 *
 * 설계: 표마다 정렬 코드를 손으로 넣는 대신, 이미 그려진 셀의 **내용(텍스트)** 을 뽑아 비교한다. 숫자·단위(KB/MB/GB/TB,
 * bps, %, W)·천단위 콤마·한국식 날짜(toLocaleString 'ko')를 인식해 수치로 비교하고, 그 외는 localeCompare(숫자 인식).
 * 빈 값('', '—', '-') 은 방향과 무관하게 항상 뒤로 보낸다(CLAUDE.md 규칙).
 */
import React from 'react';

export const EMPTY_TOKENS = new Set(['', '—', '-', '–', 'n/a', 'N/A', '없음', '미상', '?']);

/** React 노드에서 정렬용 텍스트를 뽑는다. data-sort 가 있으면 그것을 최우선. */
export function textOf(node, depth = 0) {
  if (node == null || typeof node === 'boolean' || depth > 12) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((n) => textOf(n, depth + 1)).filter(Boolean).join(' ');
  if (React.isValidElement(node)) {
    const p = node.props || {};
    if (p['data-sort'] != null) return String(p['data-sort']);
    if (node.type === 'input') return p.checked != null ? (p.checked ? '1' : '0') : String(p.value ?? '');
    const inner = textOf(p.children, depth + 1);
    if (inner) return inner;
    // 컴포넌트(UsageCell pct, 배지 label 등) — 흔한 props 에서 값을 찾는다.
    for (const k of ['value', 'pct', 'label', 'text', 'name', 'title']) {
      if (p[k] != null && typeof p[k] !== 'object' && typeof p[k] !== 'function') return String(p[k]);
    }
    return '';
  }
  return '';
}

const UNIT_MUL = { '': 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12, p: 1e15 };
// 단위: 순수 단위(ms/초/분/…)를 먼저 보고, 그 다음 접두(K/M/G/T/P) + B/bps/W/Hz — 'ms' 의 m 이 메가로 오인되지 않게.
const NUM_RE = /^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?\s*(?:(ms|초|분|시간|일|%|대|개|명|행|건|장|포트|코어)|([kKmMgGtTpP])?(i?[bB](?:ps)?|[wW]|Hz))?\s*$/;
const KO_DATE_RE = /(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.(?:\s*(오전|오후)\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/;

/** 문자열 → 정렬 키 { kind:'empty'|'num'|'str', v }. */
export function sortKeyOf(raw) {
  const s = String(raw ?? '').trim();
  if (EMPTY_TOKENS.has(s)) return { kind: 'empty', v: null };
  const n = s.match(NUM_RE);
  if (n) {
    const base = Number(n[1].replace(/,/g, '') + (n[3] || ''));
    const mul = UNIT_MUL[(n[5] || '').toLowerCase()] ?? 1;
    // 시간 단위는 초로 통일(ms/초/분/시간/일)
    const unit = n[4] || '';
    const tmul = unit === 'ms' ? 0.001 : unit === '분' ? 60 : unit === '시간' ? 3600 : unit === '일' ? 86400 : 1;
    return { kind: 'num', v: base * mul * tmul };
  }
  const ko = s.match(KO_DATE_RE);
  if (ko) {
    let h = Number(ko[5] || 0); if (ko[4] === '오후' && h < 12) h += 12; if (ko[4] === '오전' && h === 12) h = 0;
    return { kind: 'num', v: new Date(Number(ko[1]), Number(ko[2]) - 1, Number(ko[3]), h, Number(ko[6] || 0), Number(ko[7] || 0)).getTime() };
  }
  const iso = s.match(ISO_DATE_RE);
  if (iso) return { kind: 'num', v: new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), Number(iso[4] || 0), Number(iso[5] || 0), Number(iso[6] || 0)).getTime() };
  // 앞에 숫자가 오는 문자열("12 · 이름", "3대 중 1")은 숫자 우선 후 문자열 — 순수 문자열끼리는 localeCompare
  return { kind: 'str', v: s };
}

/**
 * 문자열 비교기 — **한 번만 만들어 재사용한다**(v2.503 성능 수정).
 *
 * `String.prototype.localeCompare(x, undefined, {...})` 는 호출할 때마다 옵션으로 Collator 를
 * 새로 해석한다. 표 정렬은 비교 횟수가 O(N log N) 이라 이 비용이 그대로 곱해진다 —
 * 1,100행 정렬 실측 **52.6ms → 2.5ms(21배)**, 그중 키 추출은 3.3ms 뿐이고 나머지가 전부 비교 비용이었다.
 * 규칙(숫자 인식·대소문자/악센트 무시)은 그대로다. Intl 이 없는 환경을 위해 폴백을 둔다.
 */
const COLLATOR = (() => {
  try { return new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }); } catch { return null; }
})();
const cmpStr = COLLATOR
  ? (x, y) => COLLATOR.compare(x, y)
  : (x, y) => x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' });

/** 두 정렬 키 비교(오름차순). 빈 값은 방향과 무관하게 뒤로(호출자가 dir 반전 시에도 유지). */
export function compareKeys(a, b) {
  if (a.kind === 'empty' && b.kind === 'empty') return 0;
  if (a.kind === 'empty') return 1;
  if (b.kind === 'empty') return -1;
  if (a.kind === 'num' && b.kind === 'num') return a.v - b.v;
  if (a.kind === 'num') return -1;   // 숫자가 문자열보다 앞
  if (b.kind === 'num') return 1;
  return cmpStr(String(a.v), String(b.v));
}

const PIN_RE = /^(합계|총계|전체 합계|전체|계|합산|Total|TOTAL|Sum)$/;

/** tbody 자식(행) 중 정렬 단위 — Fragment(확장 행 쌍)는 첫 tr 기준으로 한 덩어리. */
function firstTr(node) {
  if (!React.isValidElement(node)) return null;
  if (node.type === 'tr') return node;
  const kids = React.Children.toArray(node.props?.children || []);
  for (const k of kids) { const t = firstTr(k); if (t) return t; }
  return null;
}

/** 행(tr)의 colIndex 번째 셀 텍스트. colSpan 셀이 있는 행(빈 안내 행 등)은 null → 정렬 대상 아님(뒤로). */
export function cellText(tr, colIndex) {
  const kids = React.Children.toArray(tr?.props?.children || []).filter((c) => React.isValidElement(c));
  // td/th 가 하나도 없으면 셀이 컴포넌트(<Cell col=… />)로 감싸인 표 — 엘리먼트 자식을 그대로 셀로 본다(v2.425, 리뷰 #6:
  // 스토리지 장비 표는 헤더를 눌러도 순서가 불변이었다). 컴포넌트 셀은 colSpan 1 로 간주하고 props 에서 값을 찾는다.
  const cells = kids.some((c) => c.type === 'td' || c.type === 'th') ? kids.filter((c) => c.type === 'td' || c.type === 'th') : kids;
  if (!cells.length) return null;
  let i = 0;
  for (const c of cells) {
    const span = Number(c.props?.colSpan) || 1;
    if (colIndex >= i && colIndex < i + span) return span > 1 ? null : textOf(c);
    i += span;
  }
  return null;
}

/**
 * tbody 자식 배열을 colIndex 열 기준으로 정렬한 새 배열. 원래 순서를 tiebreaker 로 써 안정 정렬. 키 없는 자식에는
 * 원래 인덱스 기반 키를 붙여 React 재조정이 내용을 섞지 않게 한다.
 */
export function sortChildren(children, colIndex, dir = 'asc') {
  // Children.toArray 는 키에 접두('.$')를 붙이므로 원본 배열을 직접 평탄화한다(키 보존).
  const arr = (Array.isArray(children) ? children.flat(3) : [children]).filter((c) => c != null && typeof c !== 'boolean');
  const items = arr.map((node, i) => {
    const tr = firstTr(node);
    const txt = tr ? cellText(tr, colIndex) : null;
    // 합계/총계 행(첫 셀이 '합계'·'총계'·'전체' 류)과 data-pin 행은 정렬에서 빼고 **항상 맨 아래**에 둔다 — 정렬에 섞이면
    // 합계가 데이터 사이로 들어가 표를 오독한다(Summary 화면 브라우저 실측).
    const first = tr ? cellText(tr, 0) : null;
    const pinned = !!(tr?.props?.['data-pin'] != null || (first != null && PIN_RE.test(String(first).trim())));
    return { node, i, pinned, key: txt == null ? { kind: 'empty', v: null } : sortKeyOf(txt) };
  });
  items.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? 1 : -1;
    if (a.pinned) return a.i - b.i;
    const c = compareKeys(a.key, b.key);
    if (a.key.kind === 'empty' || b.key.kind === 'empty') return c || a.i - b.i;  // 빈 값은 항상 뒤
    return (dir === 'asc' ? c : -c) || a.i - b.i;
  });
  return items.map((it) => (React.isValidElement(it.node) && it.node.key == null ? React.cloneElement(it.node, { key: `s${it.i}` }) : it.node));
}

/** 다음 정렬 상태: 같은 열이면 asc→desc→해제, 다른 열이면 asc. */
export function nextSortState(cur, col) {
  if (!cur || cur.col !== col) return { col, dir: 'asc' };
  if (cur.dir === 'asc') return { col, dir: 'desc' };
  return null;
}

/** 헤더 셀이 정렬 대상인지 — onClick 이 이미 있거나(자체 정렬), 입력/버튼을 품거나, colSpan>1, data-nosort 면 제외. */
export function headerSortable(th) {
  if (!React.isValidElement(th) || th.type !== 'th') return false;
  const p = th.props || {};
  if (p.onClick || p['data-nosort'] != null || (Number(p.colSpan) || 1) > 1) return false;
  const hasControl = (n) => {
    if (!React.isValidElement(n)) return Array.isArray(n) ? n.some(hasControl) : false;
    if (n.type === 'input' || n.type === 'button' || n.type === 'select') return true;
    return hasControl(React.Children.toArray(n.props?.children || []));
  };
  if (hasControl(p.children)) return false;
  return textOf(p.children).trim() !== '';
}
