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

/*
 * v2.744(감사 후속 FC — EDGE-01 이 만든 상태 필드의 화면 표시): 엣지가 iDRAC 등록부(idrac.json)를 읽지 못해 목록 대신 상태 전용
 *   보고를 보내면 중앙은 그 엣지의 직전 목록을 지우지 않고 유지한다(central/fleet.js holdEdgeFleet). 그 사실은
 *   `fleetPartials.registryUnreadable: [{ agent, reason, since, holdExpired }]` 로 오는데 화면이 말하지 않았다 — 표의 그 엣지 서버가
 *   '지금 목록' 처럼 보였다. 판정을 새로 하지 않고 서버가 준 값만 문장으로 바꾼다.
 *   ⚠ 위 fleetPartialsNote(일부 목록)와 섞지 않는다 — 일부 목록은 '빠진 서버가 있다', 이것은 '목록이 갱신되지 않는다' 로 조치가 다르다.
 *   문구에 백틱·별표 두 개 금지(BoldText 를 거치지 않는 자리에서 쓴다).
 */
const heldList = (fp) => (fp && typeof fp === 'object' && Array.isArray(fp.registryUnreadable)
  ? fp.registryUnreadable.filter((x) => x && typeof x === 'object' && typeof x.agent === 'string' && x.agent) : []);

/** 각주 한 줄 — 등록부를 읽지 못해 직전 목록을 유지 중인 엣지. 없으면 ''. 이름은 5곳까지, 사유는 첫 곳의 것을 적는다. */
export function fleetHeldNote(fp) {
  const list = heldList(fp);
  if (!list.length) return '';
  const names = list.slice(0, 5).map((x) => x.agent).join(', ') + (list.length > 5 ? ` 외 ${list.length - 5}곳` : '');
  const why = typeof list[0].reason === 'string' && list[0].reason ? ` · 사유: ${list[0].reason.slice(0, 120)}` : '';
  const expired = list.filter((x) => x.holdExpired).length;
  const tail = expired
    ? ` 그중 ${expired}곳은 보류 시한이 지나 만료 시간 뒤 이 표에서 빠집니다.`
    : '';
  return `엣지 ${list.length}곳(${names})은 iDRAC 등록부를 읽지 못해 베어메탈 목록을 새로 보내지 못하고 있습니다${why} — 이 표의 그 엣지 서버는 마지막으로 온전히 받은 직전 목록이고 갱신되지 않습니다. 그 엣지에서 손상 보존본(idrac.json.corrupt.*)을 되돌리거나 iDRAC 등록을 다시 저장하면 다음 주기에 다시 보냅니다.${tail}`;
}

/** 표 행의 짧은 표지(그 행의 remoteAgent 가 직전 목록 유지 중이면). 없으면 null. */
export function fleetHeldBadge(fp, agent) {
  if (!agent) return null;
  const hit = heldList(fp).find((x) => x.agent === agent);
  if (!hit) return null;
  return {
    text: hit.holdExpired ? '목록 만료 예정' : '직전 목록',
    title: `엣지 ${agent} 가 iDRAC 등록부를 읽지 못해 목록을 새로 보내지 못하고 있습니다 — 이 행은 마지막으로 받은 값입니다${hit.holdExpired ? '(보류 시한이 지나 곧 빠집니다)' : ''}.`,
  };
}
