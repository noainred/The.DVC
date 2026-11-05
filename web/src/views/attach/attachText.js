/**
 * attachText.js — 첨부 화면 문구(v2.889 · 순수).
 */
/** 바이트 → '8 MB' · '512 KB' · '120 B'. 못 읽으면 '—'.
 * v2.902 점검 W-7: 아래 단위에서 반올림한 값이 1024 에 닿으면 위 단위로 올린다(1,048,575 B 가 '1024 KB' 로 나왔다). */
export function attachSizeText(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  const UNITS = ['B', 'KB', 'MB', 'GB'];
  let v = n; let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) { v /= 1024; u += 1; }
  const fmt = (x, unit) => (unit === 0 ? String(Math.round(x)) : unit === 1 ? String(Math.round(x)) : x.toFixed(x >= 10 ? 0 : 1));
  let t = fmt(v, u);
  if (u > 0 && u < UNITS.length - 1 && Number(t) >= 1024) { u += 1; v /= 1024; t = fmt(v, u); }
  return `${t} ${UNITS[u]}`;
}
/** 올리기 · 지우기 실패 → 사유(서버 code 우선). */
export function attachFailText(r, limits = {}) {
  if (!r) return '알 수 없는 실패';
  if (r.status === 413 || r.code === 'too-big') return `파일이 너무 큽니다(${attachSizeText(limits?.fileBytes ?? 8 * 1024 * 1024)}까지)`;
  if (r.code === 'bad-type') return '받는 파일 형식이 아닙니다(그림 · PDF · 문서 · 로그 · 압축 — svg · html · 실행 파일은 받지 않습니다)';
  if (r.code === 'too-many') return r.reason || '첨부 개수 상한';
  if (r.code === 'attach-full') return `포탈 첨부 전체 상한에 닿았습니다(${attachSizeText(r.used)} / ${attachSizeText(r.max)}) — 관리자에게 알려 주세요`;
  if (r.status === 403) return r.reason || '권한이 없습니다';
  return r.reason || `실패(${r.status || '?'})`;
}
/** 본문에 넣을 마크다운 — 그림은 ![이름](attach:id), 그 밖은 [이름](attach:id). 이름의 ] · [ 는 뺀다. */
export function attachMarkdown(x) {
  // v2.902 점검 W-8: '[' · ']' 에 더해 머리의 '^'(각주 참조 '[^낱말]' 로 읽혔다)는 빼고 '|' 는 '\|' 로(표 안에서 칸을 갈랐다)
  const name = (String(x?.name || '첨부').replace(/[[\]]/g, '').replace(/^\^+/, '').replace(/\|/g, '\\|')) || '첨부';
  return x?.image ? `![${name}](attach:${x.id})` : `[${name}](attach:${x.id})`;
}
