// v2.744(감사 VC-03) — 읽지 못한 vCenter 를 '0' 으로 섞지 않았다는 사실을 말하는 문구(코어 라이선스·비용 배분·이전 준비도 공용).
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

/** 배너 한 줄 — 이름은 5곳까지 적고 나머지는 개수로 밝힌다. 없으면 빈 문자열. */
export function notReadNote(list) {
  const all = listOf(list);
  if (!all.length) return '';
  const m = missing(all);
  const off = all.length - m.length;
  const names = all.slice(0, 5).map((x) => `‘${x.name || x.vcenterId}’(${whyLabel(x.why)})`).join(' · ');
  const more = all.length > 5 ? ` 외 ${all.length - 5}곳` : '';
  const head = m.length
    ? `읽지 못한 vCenter ${m.length}곳은 합계에서 뺐습니다 — 합계는 하한입니다(0 으로 더하지 않았습니다)`
    : '비활성 vCenter 만 합계에서 빠졌습니다';
  const tail = off && m.length ? ` 비활성 ${off}곳은 원래 수집하지 않습니다.` : '';
  return `${head}: ${names}${more}.${tail}`;
}

/** 표의 한 칸(읽지 못한 vCenter 행) — '—' 와 구분되는 짧은 글자 + 툴팁. */
export function notReadCell(why) {
  return { text: '미수집', title: `${whyLabel(why)} — 이 vCenter 의 호스트·VM 을 읽지 못해 산정하지 않았습니다(0 대가 아닙니다)` };
}
