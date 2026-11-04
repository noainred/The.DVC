/**
 * macro.js — 위키 포탈 매크로 한 줄 해석(v2.887 · 시안 ⑨ '포탈 매크로 · 포함' · C-5). 순수.
 *
 * 줄 하나가 통째로 `{{이름 인자…}}` 일 때만 매크로다(문장 안의 `{{…}}` 는 글자 그대로). 아는 이름만(MACROS) — 모르는 이름은 글자로 남는다
 * (템플릿의 `{{issue}}` 자리표시가 채워지지 않고 남아도 매크로가 되지 않게).
 *   {{issues query="type = incident AND status != done" limit=10}}   이슈 검색식 결과 표(서버가 범위 → 검색식)
 *   {{include W12}}                                                  다른 문서 본문을 그 자리에(한 단계만 — 포함 안의 포함 · 매크로는 그리지 않는다)
 *   {{vcenters}}                                                     법인(vCenter) 상태 표(보는 사람의 범위)
 *   {{partfaults}}                                                   열린 파트 장애 요약(도구 권한 · 전체 범위 — 서버가 판정)
 * 값은 **열 때마다 API 로 읽는다**(저장된 글이 아니다). 인쇄 · PDF 에는 그 시각의 값이 들어간다.
 * 해석은 손으로 한 글자씩(정규식은 한 글자 판정만 — 역추적 없음) · 줄 500자 · 인자 10개 · 값 300자.
 */

export const MACROS = Object.freeze(['issues', 'include', 'vcenters', 'partfaults']);
export const MACRO_LIMITS = Object.freeze({ line: 500, args: 10, value: 300 });
const isSp = (c) => c === ' ' || c === '\t';
const isNameCh = (c) => (c >= 'a' && c <= 'z');

/** 줄 → { name, args:{ _: [위치 인자], 키: 값 } } · 매크로가 아니면 null. */
export function parseMacroLine(line) {
  const s0 = String(line ?? '');
  if (s0.length > MACRO_LIMITS.line) return null;
  let a = 0; let b = s0.length;
  let lead = 0;
  while (a < b && s0[a] === ' ' && lead < 4) { a += 1; lead += 1; }
  if (lead > 3) return null;
  while (b > a && isSp(s0[b - 1])) b -= 1;
  if (!(s0.startsWith('{{', a) && b - a >= 4 && s0[b - 1] === '}' && s0[b - 2] === '}')) return null;
  const s = s0.slice(a + 2, b - 2);
  let i = 0;
  let name = '';
  while (i < s.length && isNameCh(s[i]) && name.length <= 20) { name += s[i]; i += 1; }
  if (!MACROS.includes(name) || (i < s.length && !isSp(s[i]))) return null;
  const args = { _: [] };
  let n = 0;
  while (i < s.length) {
    while (i < s.length && isSp(s[i])) i += 1;
    if (i >= s.length) break;
    if (s[i] === '{' || s[i] === '}') return null;
    // 키 — 영숫자
    let key = ''; const k0 = i;
    while (i < s.length && /[A-Za-z0-9_]/.test(s[i]) && key.length <= 20) { key += s[i]; i += 1; }
    let val;
    if (key && s[i] === '=') {
      i += 1;
      if (s[i] === '"' || s[i] === "'") {
        const q = s[i]; i += 1; let v = '';
        while (i < s.length && s[i] !== q) { if (s[i] === '\\' && i + 1 < s.length) { v += s[i + 1]; i += 2; continue; } v += s[i]; i += 1; }
        if (i >= s.length) return null; // 따옴표가 닫히지 않았다
        i += 1; val = v;
      } else { let v = ''; while (i < s.length && !isSp(s[i])) { v += s[i]; i += 1; } val = v; }
      if (val.length > MACRO_LIMITS.value) return null;
      args[key.toLowerCase()] = val;
    } else {
      i = k0; let v = '';
      while (i < s.length && !isSp(s[i])) { v += s[i]; i += 1; }
      if (v.length > MACRO_LIMITS.value) return null;
      args._.push(v);
    }
    n += 1;
    if (n > MACRO_LIMITS.args) return null;
  }
  return { name, args };
}

/** {{issues}} 인자 — 검색식 · 줄 수(1~50, 기본 10). 검색식이 없으면 '열린 이슈 최근 갱신순'. */
export function issuesMacroArgs(args = {}) {
  const query = String(args.query ?? args.q ?? args._?.join(' ') ?? '').trim() || 'status != done ORDER BY updated DESC';
  const n = Number(args.limit);
  return { query, limit: Number.isInteger(n) && n >= 1 && n <= 50 ? n : 10 };
}
/** {{include W12}} 인자 — 문서 번호(W숫자)만. 아니면 null. */
export function includeTarget(args = {}) {
  const v = String(args._?.[0] ?? args.page ?? args.id ?? '').trim().toUpperCase();
  return /^W\d{1,9}$/.test(v) ? v : null;
}
