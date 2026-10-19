// v2.744(감사 VC-03) — 읽지 못한 vCenter 를 '0' 으로 섞지 않았다는 사실을 말하는 문구(코어 라이선스·비용 배분·이전 준비도 공용 ·
// 판정 목록 화면(호스트·VM 구성 점검)은 notReadJudgeNote — v2.744 회귀 검토 FX-R2).
// 판정은 서버 corelicense/analyze.js notReadVcentersOf(metrics/unreadVcenters.js unreadVcenterReasons + 첫 수집 중·비활성)이고
// 응답은 notReadVcenters: [{ vcenterId, name, why }] + partial(비활성만 빠졌으면 false). 여기서는 문장만 만든다.
// 문구에 백틱·별표 두 개 금지(BoldText 를 거치지 않는 자리에서도 쓴다).
export const NOT_READ_WHY_TEXT = Object.freeze({
  pending: '첫 수집 중',
  unreachable: '연결 실패',
  maintenance: '점검중',
  stale: '보고 낡음',
  disabled: '비활성',
});
const whyLabel = (w) => NOT_READ_WHY_TEXT[w] || '읽지 못함';
const listOf = (list) => (Array.isArray(list) ? list.filter((x) => x && typeof x === 'object') : []);
const missing = (list) => listOf(list).filter((x) => x.why !== 'disabled');

/** KPI 아래 한 줄 — 읽지 못한(비활성 제외) vCenter 가 있으면 '하한', 없으면 빈 문자열. */
export function notReadKpiSub(list) {
  const m = missing(list);
  return m.length ? `읽지 못한 vCenter ${m.length}곳 제외 — 하한` : '';
}

/** 이름 목록 — 5곳까지 적고 나머지는 개수로 밝힌다(두 배너 공용). */
const namesText = (arr) => `${arr.slice(0, 5).map((x) => `‘${x.name || x.vcenterId}’(${whyLabel(x.why)})`).join(' · ')}${arr.length > 5 ? ` 외 ${arr.length - 5}곳` : ''}`;

/** 배너 한 줄(합계 화면 — 코어 라이선스·비용 배분·이전 준비도) — 이름은 5곳까지 적고 나머지는 개수로 밝힌다. 없으면 빈 문자열. */
export function notReadNote(list) {
  const all = listOf(list);
  if (!all.length) return '';
  const m = missing(all);
  const off = all.length - m.length;
  const head = m.length
    ? `읽지 못한 vCenter ${m.length}곳은 합계에서 뺐습니다 — 합계는 하한입니다(0 으로 더하지 않았습니다)`
    : '비활성 vCenter 만 합계에서 빠졌습니다';
  const tail = off && m.length ? ` 비활성 ${off}곳은 원래 수집하지 않습니다.` : '';
  return `${head}: ${namesText(all)}.${tail}`;
}

/**
 * v2.744(회귀 검토 FX-R2): 판정 목록 화면(호스트·VM 구성 점검)의 배너 한 줄. 그 화면에는 '합계' 가 없다 — 실제로 일어난 일은
 *   '읽지 못한 vCenter 의 호스트·VM 이 판정 목록에 없다' 이므로 그렇게 말한다(문제가 없다는 뜻이 아니라고 함께 적는다).
 *   비활성만 있으면 빈 문자열이다 — coverage 줄(notReadKpiSub)과 같은 판정(관리자가 일부러 끈 vCenter 를 화면마다 경고하지 않는다).
 *   이름은 읽지 못한(비활성 아닌) 것만 적고 비활성은 개수로 덧붙인다. noun 은 '호스트'·'VM' 처럼 짧은 명사(조사를 붙이지 않는 자리에 넣는다).
 */
export function notReadJudgeNote(list, noun = '항목') {
  const all = listOf(list);
  const m = missing(all);
  if (!m.length) return '';
  const off = all.length - m.length;
  const what = String(noun || '항목');
  const tail = off ? ` 비활성 ${off}곳은 원래 수집하지 않습니다.` : '';
  return `읽지 못한 vCenter ${m.length}곳은 판정하지 않았습니다 — 그 vCenter 의 ${what} 판정 결과는 이 목록과 개수에 들어 있지 않습니다(문제가 없다는 뜻이 아닙니다): ${namesText(m)}.${tail}`;
}

/** 표의 한 칸(읽지 못한 vCenter 행) — '—' 와 구분되는 짧은 글자 + 툴팁. */
export function notReadCell(why) {
  return { text: '미수집', title: `${whyLabel(why)} — 이 vCenter 의 호스트·VM 을 읽지 못해 산정하지 않았습니다(0 대가 아닙니다)` };
}
