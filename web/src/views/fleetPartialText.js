/**
 * 엣지 베어메탈 목록 부분 전송 안내(v2.607, 감사 LEFT2607-02). 서버 응답 `fleetPartials`
 * (central/fleet.js fleetPartialsSummary — `/insights/fleet`·`/tools/bm-usage`)를 문장으로 바꾼다.
 *  · partialEdges/partials — vCenter 를 못 읽어 귀속 없는 베어메탈을 빼고 보낸 엣지(뺀 대수 withheldItems, 모르면 withheldUnknown)
 *  · omitted — 중앙 상한으로 받지 않은 수 · vcenterBlanked — 소유하지 않은 vCenter 귀속을 비운 수
 * 해당 없으면 '' — 범위 계정은 서버가 null 을 준다(엣지는 나눌 축이 없다).
 */
export function fleetPartialsNote(fp) {
  if (!fp || typeof fp !== 'object') return '';
  const nz = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const parts = [];
  const pe = nz(fp.partialEdges);
  if (pe) {
    const names = (Array.isArray(fp.partials) ? fp.partials : []).map((x) => x && x.agent).filter((x) => typeof x === 'string' && x);
    const w = nz(fp.withheldItems); const wu = nz(fp.withheldUnknown);
    const withheld = w ? `뺀 대수 ${w}대${wu ? `, 그 밖에 ${wu}곳은 뺀 대수를 모름` : ''}` : (wu ? '뺀 대수를 모름' : '');
    parts.push(`엣지 ${pe}곳의 목록이 일부입니다(vCenter 를 못 읽어 귀속 없는 서버를 빼고 보냄${withheld ? ` · ${withheld}` : ''}${names.length ? ` · ${names.slice(0, 5).join(', ')}${names.length > 5 ? ` 외 ${names.length - 5}곳` : ''}` : ''})`);
  }
  if (nz(fp.omitted)) parts.push(`상한으로 받지 않은 서버 ${nz(fp.omitted)}대`);
  if (nz(fp.vcenterBlanked)) parts.push(`그 엣지가 담당하지 않는 vCenter 귀속을 비운 서버 ${nz(fp.vcenterBlanked)}대`);
  if (!parts.length) return '';
  return `엣지 베어메탈 목록이 전부가 아닙니다 — ${parts.join(' · ')}. 빠진 서버는 이 표에 나오지 않습니다.`;
}
