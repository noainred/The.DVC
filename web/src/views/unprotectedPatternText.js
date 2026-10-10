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

const UNDETERMINED_REASON = {
  'log-collection-off': '이 포탈의 vCenter 로그 수집이 꺼져 있음',
  'severity-filter': '로그 최소 심각도가 info 보다 높아 스냅샷 이벤트를 저장하지 않음',
  'no-events': '조회 기간에 저장된 이벤트가 0건인 vCenter(엣지 위임·수집 실패)',
  'not-collected': '이 포탈이 지금 직접 수집하지 않는 vCenter(비활성·점검중·엣지 위임) — 남은 옛 이벤트로는 판정하지 않음',
};

/**
 * v2.622(감사 DATA-05): 이벤트를 수집하지 않아 판정하지 못한 가동 VM 안내. 서버가 이 VM 들을 미보호에서 빼고
 * `summary.undeterminedCount`·`undeterminedByReason`·`noEventVcenters` 로 밝힌다 — 화면이 말하지 않으면 '미보호가 줄었다'
 * 는 거짓 안도가 된다. 해당 없으면 ''.
 */
export function undeterminedNote(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const n = Number.isFinite(s.undeterminedCount) ? s.undeterminedCount : 0;
  if (n <= 0) return '';
  const by = s.undeterminedByReason && typeof s.undeterminedByReason === 'object' ? s.undeterminedByReason : {};
  const parts = Object.entries(by).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${UNDETERMINED_REASON[k] || k} ${v}대`);
  const vcs = Array.isArray(s.noEventVcenters) ? s.noEventVcenters.filter((x) => typeof x === 'string') : [];
  const vcTxt = vcs.length ? ` 해당 vCenter: ${vcs.slice(0, 8).join(', ')}${vcs.length > 8 ? ` 외 ${vcs.length - 8}곳` : ''}.` : '';
  return `가동 VM ${n}대는 백업 이벤트를 확인할 근거가 없어 판정하지 않았습니다(미보호로 세지 않음 — 보호됐다는 뜻도 아닙니다). 사유: ${parts.join(' · ') || '미상'}.${vcTxt}`;
}
