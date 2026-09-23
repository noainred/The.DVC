/**
 * collectDropText.js — 위임 '지금 수집' 요청이 결과 없이 폐기됐을 때의 안내(v2.591, 순수).
 *
 * 서버 요청 큐(util/collectRequestQueue.js)는 엣지가 요청을 가져간 뒤 새 수집 결과가 시한 안에 오지 않으면
 * 한 번 더 요청하고, 그래도 없으면 폐기한다. v2.590 은 '폐기 사실을 밝힌다' 고 적었지만 화면 소비처가 0건이라
 * **배지만 조용히 꺼졌다**('처리됐다' 로 보인다). 목록 API 의 `collectDrops` 를 이 모듈이 문장으로 만든다 —
 * 스토리지·SAN 스위치·PDU 세 화면이 같은 모듈을 쓴다(문구를 복제하지 않는다).
 */

export const DROP_WINDOW_MS = 6 * 3600_000; // 이보다 오래된 폐기는 다시 말하지 않는다(재시작 전까지 링에 남는다)

const ago = (ms) => {
  if (!(ms >= 0)) return '';
  const m = Math.round(ms / 60_000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  return `${h}시간 ${m % 60}분 전`;
};

/**
 * @param drops  서버 collectDrops — [{ id, agent, at, tries, reason? }] (최신이 앞)
 * @param nameOf id → 표시 이름(없으면 id)
 * @param now    기준 시각(ms)
 * @returns BoldText 문장 또는 null(보일 것 없음)
 */
export function collectDropNote(drops, nameOf = (id) => id, now = Date.now()) {
  const recent = (Array.isArray(drops) ? drops : [])
    .filter((d) => d && d.id != null && Number.isFinite(Number(d.at)) && now - Number(d.at) <= DROP_WINDOW_MS);
  if (!recent.length) return null;
  const names = recent.slice(0, 5).map((d) => String(nameOf(d.id) || d.id));
  const more = recent.length > 5 ? ` 외 ${recent.length - 5}대` : '';
  const agents = [...new Set(recent.map((d) => d.agent).filter(Boolean))];
  // v2.593(감사 R2593-03): 사유가 셋이다 — 조치가 다르다. 'untaken'(엣지가 한 번도 가져가지 않았다 = 엣지가 꺼졌거나
  //   설정 pull 을 하지 않는다) / 'no-result'·'requeued-expired'(가져갔지만 결과가 오지 않았다 = 그 장비 수집 오류).
  //   사유가 없는 옛 서버 응답은 예전 문장(가져갔지만 결과 없음)으로 말한다.
  const untaken = recent.filter((d) => d.reason === 'untaken').length;
  const agentText = agents.length ? `(${agents.join(', ')})` : '';
  const head = `'지금 수집' 요청 **${recent.length}건**이 결과 없이 폐기됐습니다(마지막 ${ago(now - Number(recent[0].at))}) — `;
  const tail = `: ${names.join(', ')}${more}. 수집이 되었다는 뜻이 아닙니다`;
  if (untaken === recent.length) {
    return `${head}엣지${agentText}가 요청을 **가져가지 않은 채** 보관 시한이 지났습니다${tail} — 그 엣지가 켜져 있고 중앙 설정을 받아 가는지(설정 › 수집 서버) 확인하세요.`;
  }
  const mixed = untaken ? ` 그중 ${untaken}건은 엣지가 요청을 가져가지도 않았습니다(엣지가 꺼졌거나 설정을 받아 가지 않음).` : '';
  return `${head}엣지${agentText}가 요청을 가져갔지만 새 수집 결과가 오지 않아 한 번 더 요청한 뒤 버렸습니다${tail} — 특수기능 › 엣지 로그에서 그 장비의 수집 오류를 확인하세요.${mixed}`;
}
