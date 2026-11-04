/**
 * attachText.js — 첨부 화면 문구(v2.886 · 순수).
 */
/** 바이트 → '8 MB' · '512 KB' · '120 B'. 못 읽으면 '—'. */
export function attachSizeText(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
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
  const name = String(x?.name || '첨부').replace(/[[\]]/g, '');
  return x?.image ? `![${name}](attach:${x.id})` : `[${name}](attach:${x.id})`;
}
