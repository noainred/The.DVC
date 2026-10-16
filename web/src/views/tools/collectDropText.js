import { elapsedText } from './relTime.js';
/**
 * collectDropText.js — 위임 '지금 수집' 요청이 결과 없이 폐기됐을 때의 안내(v2.591, 순수).
 *
 * 서버 요청 큐(util/collectRequestQueue.js)는 엣지가 요청을 가져간 뒤 새 수집 결과가 시한 안에 오지 않으면
 * 한 번 더 요청하고, 그래도 없으면 폐기한다. v2.590 은 '폐기 사실을 밝힌다' 고 적었지만 화면 소비처가 0건이라
 * **배지만 조용히 꺼졌다**('처리됐다' 로 보인다). 목록 API 의 `collectDrops` 를 이 모듈이 문장으로 만든다 —
 * 스토리지·SAN 스위치·PDU 세 화면이 같은 모듈을 쓴다(문구를 복제하지 않는다).
 */

export const DROP_WINDOW_MS = 6 * 3600_000; // 이보다 오래된 폐기는 다시 말하지 않는다(재시작 전까지 링에 남는다)

/**
 * v2.743(감사 LEFT-08): 엣지가 '받은 요청을 시작하지 않고 버렸다' 고 알려 온 폐기의 사유(지금은 아이실론 디렉터리 사용량만 알려 온다).
 * 서버 isidu/collectRequests.js EDGE_DROP_REASONS 와 1:1 이다(server/test/audit2743i 가 대조한다 — 한쪽만 늘면 실패).
 * 예전에는 중앙이 그 사실을 몰라 결과 시한(최대 약 10시간)이 지나서야 '결과가 오지 않았다' 로 버렸다 — 엉뚱한 조치(수집 오류 확인)를 안내했다.
 */
export const EDGE_DROP_TEXT = Object.freeze({
  'queue-hold': { label: '엣지의 동시 실행 대기 6시간 초과', fix: '앞 조사가 오래 걸려 차례가 오지 않았습니다. 앞 조사가 끝난 뒤 다시 누르세요.' },
  'target-gone': { label: '기다리는 동안 대상이 엣지 목록에서 빠짐', fix: '대상이 지워졌거나 실행 노드가 바뀌었는지 수집 대상 설정을 확인하세요.' },
  'not-here': { label: '엣지의 대상 사본에 그 대상이 없음', fix: '실행 노드·담당 엣지 설정과, 그 엣지가 중앙 설정을 받아 가는지(특수기능 › 엣지 로그) 확인하세요.' },
  'not-restored': { label: 'SCAN_RESUME=0 이라 엣지가 재시작 뒤 대기 요청을 다시 넣지 않음', fix: '다시 누르세요.' },
  'edge-other': { label: '엣지가 알려 온 다른 사유', fix: '특수기능 › 엣지 로그에서 그 엣지의 수집 기록을 확인하세요.' },
});
const isEdgeDrop = (d) => !!d && typeof d.reason === 'string' && Object.hasOwn(EDGE_DROP_TEXT, d.reason) && d.source === 'edge';

/** 엣지가 알려 온 폐기 사유를 '사유 N건 · …' 과 조치(겹치지 않게)로 묶는다. */
function edgeDropParts(list) {
  const counts = new Map();
  for (const d of list) counts.set(d.reason, (counts.get(d.reason) || 0) + 1);
  const reasons = [...counts].map(([r, n]) => `${EDGE_DROP_TEXT[r].label} ${n}건`).join(' · ');
  const fixes = [...new Set([...counts.keys()].map((r) => EDGE_DROP_TEXT[r].fix))].join(' ');
  return { reasons, fixes };
}

// v2.613 DEPS2613-11: 경과 시간 문구는 공용 코어 relTime.elapsedText 다(로컬 ago 사본 제거 — 결측·미래는 '' 로 비운다).
const ago = (ms) => elapsedText(ms, { dash: '', subMinute: '방금', future: '' });

/**
 * @param drops  서버 collectDrops — [{ id, agent, at, tries, reason?, source? }] (최신이 앞 · source 'edge' = 엣지가 버렸다고 알려 온 것)
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
  // v2.743(LEFT-08): 엣지가 시작하지 않고 버렸다고 알려 온 것(source 'edge')은 따로 말한다 — 조치가 다르다. 없으면 아래 문장은 예전 그대로다.
  const byEdge = recent.filter(isEdgeDrop);
  const rest = recent.filter((d) => !isEdgeDrop(d));
  const untaken = rest.filter((d) => d.reason === 'untaken').length;
  const agentText = agents.length ? `(${agents.join(', ')})` : '';
  const head = `'지금 수집' 요청 **${recent.length}건**이 결과 없이 폐기됐습니다(마지막 ${ago(now - Number(recent[0].at))}) — `;
  const tail = `: ${names.join(', ')}${more}. 수집이 되었다는 뜻이 아닙니다`;
  const ep = byEdge.length ? edgeDropParts(byEdge) : null;
  if (!rest.length) {
    return `${head}엣지${agentText}가 요청을 받았지만 시작하지 않고 버렸다고 알려 왔습니다(${ep.reasons})${tail} — ${ep.fixes}`;
  }
  const edgeNote = ep ? ` 그중 ${byEdge.length}건은 엣지가 요청을 받았지만 시작하지 않고 버렸다고 알려 왔습니다(${ep.reasons}) — ${ep.fixes}` : '';
  if (untaken === rest.length) {
    return `${head}엣지${agentText}가 요청을 **가져가지 않은 채** 보관 시한이 지났습니다${tail} — 그 엣지가 켜져 있고 중앙 설정을 받아 가는지(설정 › 수집 서버) 확인하세요.${edgeNote}`;
  }
  const mixed = untaken ? ` 그중 ${untaken}건은 엣지가 요청을 가져가지도 않았습니다(엣지가 꺼졌거나 설정을 받아 가지 않음).` : '';
  return `${head}엣지${agentText}가 요청을 가져갔지만 새 수집 결과가 오지 않아 한 번 더 요청한 뒤 버렸습니다${tail} — 특수기능 › 엣지 로그에서 그 장비의 수집 오류를 확인하세요.${mixed}${edgeNote}`;
}
