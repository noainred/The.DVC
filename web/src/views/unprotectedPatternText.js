/**
 * 백업 없음 리포트 — 버린 패턴 안내(v2.607, 감사 WEB2607-07). 서버(reports/unprotected.js)는 상한(개수·길이)을 넘은
 * 패턴을 버리고 `config.patternsOmitted` 로 밝힌다. 전부 버려지면 **기본 패턴으로 판정**한다 — 입력칸에는 사용자
 * 문자열이 그대로 보이므로, 이 문장이 없으면 어떤 패턴으로 판정했는지 화면이 말하지 않는다.
 * 해당 없으면 ''.
 */
export function unprotectedPatternNote(config) {
  const c = config && typeof config === 'object' ? config : {};
  const n = Number.isFinite(c.patternsOmitted) ? c.patternsOmitted : 0;
  if (n <= 0) return '';
  const lim = [Number.isFinite(c.maxPatterns) ? `최대 ${c.maxPatterns}개` : '', Number.isFinite(c.maxPatternLen) ? `각 ${c.maxPatternLen}자` : ''].filter(Boolean).join('·');
  const used = Array.isArray(c.patterns) ? c.patterns.filter((x) => typeof x === 'string') : [];
  return `입력한 패턴 중 ${n}개는 상한${lim ? `(${lim})` : ''}을 넘어 쓰지 않았습니다. 실제 판정에 쓴 패턴 ${used.length}개: ${used.length ? used.join(', ') : '없음'}`;
}
