/**
 * bareos/logFirstError.js — v2.872 통합 에러 로그 '묶음 로그'(시안 docs/design/bareos-errlog · 사용자 컨펌 2026-11-04 '구현해').
 * 순수 함수 — 작업 로그(jobLog 의 'YYYY-MM-DD HH:MM:SS 본문' 줄)에서 **첫 오류 줄**을 고르고, 여러 실행의 첫 오류 줄을 대조한다.
 *
 *  · 첫 오류 줄 = 첫 'Fatal error:' · 없으면 첫 'Error:'(보고 블록 머리줄 'Error: Bareos bareos-dir 25.1.2 (…):' 와 보고 칸 'SD Errors: 0' 은 제외 —
 *    웹 bareosText.parseJobReport 와 같은 제외 규칙). 없으면 null(오류 줄이 없다 — 0 이 아니라 '없음').
 *  · 대조 서명 = 첫 오류 줄에서 시각 · 'bareos-fd JobId N:' 머리 · VM 이름 · 잡 이름 · 따옴표 안 · 숫자를 지우고 공백을 줄인 소문자(160자).
 *    원장만으로는 같은 원인인지 모른다 — 로그를 읽어 이 서명이 같을 때만 '같은 오류' 다(시안 ②의 정직한 한계).
 *  · 엣지가 이 모듈로 첫 오류 줄만 회신한다(원문은 낱건 '로그' 에서) — 회신은 중앙 edgeResult 가 다시 자른다.
 *  ⚠ 외부 입력(장비 출력) — 줄 길이를 먼저 자르고 앵커 있는 유한 반복만 쓴다(정규식 규칙 · ReDoS).
 */

const LINE_MAX = 600;
const OUT_MAX = 400;
const SCAN_MAX = 8000;
const TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\s{1,4}/;
const WHO_RE = /^\S{1,80}\s{1,4}JobId\s{1,4}\d{1,12}:\s{0,4}/;
const REPORT_HEAD_RE = /^(?:Error|Warning): Bareos \S{1,80} \d/;
const REPORT_KV_RE = /^\s{1,12}[A-Za-z][A-Za-z0-9 ()/.-]{0,39}:\s/;

/** 줄 하나에서 시각 · 데몬 머리를 뗀 본문(600자에서 자름). */
function bodyOf(raw) {
  const t = String(raw ?? '').slice(0, LINE_MAX);
  return t.replace(TS_RE, '').replace(WHO_RE, '');
}

/**
 * 첫 오류 줄 — 'Fatal error:' 가 먼저, 없으면 'Error:'. 없으면 null.
 * @param {string[]} lines
 * @returns {string|null}
 */
export function firstErrorLine(lines) {
  const list = Array.isArray(lines) ? lines.slice(0, SCAN_MAX) : [];
  let err = null;
  for (const raw of list) {
    if (REPORT_KV_RE.test(String(raw ?? '').slice(0, LINE_MAX).replace(TS_RE, ''))) continue;   // 보고 칸('  SD Errors: 0')은 오류가 아니다
    const b = bodyOf(raw).trim();
    const fi = b.indexOf('Fatal error:');
    if (fi >= 0) return b.slice(fi, fi + OUT_MAX);
    if (err === null) {
      const ei = b.search(/(?:^|\s)Error:/);
      if (ei >= 0 && !REPORT_HEAD_RE.test(b)) err = b.slice(ei).trim().slice(0, OUT_MAX);
    }
  }
  return err;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * 대조 서명 — VM · 잡 이름 · 따옴표 안 · 숫자를 지운 소문자. 비교 전용(화면에 그대로 내지 않는다).
 * @param {string|null} line @param {{ vmName?: string, jobName?: string }} o
 */
export function errorSig(line, { vmName = '', jobName = '' } = {}) {
  if (typeof line !== 'string' || !line) return '';
  let s = line.slice(0, OUT_MAX);
  for (const n of [vmName, jobName]) {
    const v = String(n || '').slice(0, 128);
    if (v.length >= 2) s = s.replace(new RegExp(escRe(v), 'g'), '<vm>');
  }
  return s.replace(/['‘’"“”][^'‘’"“”]{0,200}['‘’"“”]/g, '<q>').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 160);
}

/**
 * 묶음 대조 — 읽은 항목의 서명을 세어 가장 많은 것을 '같은 오류' 로, 나머지 읽은 것은 '다른 오류', 오류 줄이 없으면 '오류 줄 없음', 못 읽으면 '못 읽음'.
 *   가장 많은 서명이 1건뿐이고 읽은 것이 둘 이상이면(전부 제각각) 'same' 을 붙이지 않는다 — 같은 오류라고 말할 근거가 없다.
 * @param {{ ok:boolean, firstError?:string|null, vmName?:string, jobName?:string }[]} items
 * @returns {{ items: object[], summary: { total, same, other, none, unread, topLine: string|null } }}
 */
export function compareFirstErrors(items) {
  const list = Array.isArray(items) ? items : [];
  const sigs = list.map((x) => (x?.ok && typeof x.firstError === 'string' && x.firstError ? errorSig(x.firstError, x) : ''));
  const n = new Map();
  sigs.forEach((s, i) => { if (s) { const c = n.get(s); if (c) c.n += 1; else n.set(s, { n: 1, first: i }); } });
  let top = ''; let best = null;
  for (const [s, c] of n) if (!best || c.n > best.n || (c.n === best.n && c.first < best.first)) { top = s; best = c; }
  const readable = [...n.values()].reduce((a, c) => a + c.n, 0);
  const hasTop = !!best && (best.n > 1 || readable === 1);
  const summary = { total: list.length, same: 0, other: 0, none: 0, unread: 0, topLine: hasTop ? list[best.first].firstError : null };
  const out = list.map((x, i) => {
    const match = !x?.ok ? 'unread' : !sigs[i] ? 'none' : hasTop && sigs[i] === top ? 'same' : 'other';
    summary[match === 'unread' ? 'unread' : match] += 1;
    return { ...x, match };
  });
  return { items: out, summary };
}
