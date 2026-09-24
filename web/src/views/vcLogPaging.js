/**
 * vCenter 로그 조회 페이징 판정(v2.607 — 그룹 f 의 서버 변경 DB2607-02 와 짝).
 *
 * 서버 `/tools/vclogs` 는 검색어·심각도 필터가 있으면 total 을 **상한 COUNT**(1만)로 세고, 닿았으면
 * `totalCapped:true`(+`totalCap`)를 싣는다 — 그때 total 은 '적어도 이만큼' 이다. 그래서
 *  ① 건수는 'N건 이상' 으로 말한다(정확한 수인 척하지 않는다)
 *  ② '더 보기' 를 `rows.length < total` 로만 판정하면 1만 행에서 멈춘다 — 상한에 닿았으면 **마지막 응답이 limit 을
 *     꽉 채웠는지**로 판정한다(덜 채웠으면 끝이다).
 */
export function vcLogTotalText({ total, totalCapped, totalCap } = {}, fmt = (n) => String(n)) {
  const n = Number.isFinite(totalCap) ? totalCap : (Number.isFinite(total) ? total : 0);
  return totalCapped ? `${fmt(n)}건 이상` : `${fmt(Number.isFinite(total) ? total : 0)}건`;
}

export function vcLogCanLoadMore({ loaded, total, totalCapped, lastBatch, limit }) {
  const got = Number.isFinite(loaded) ? loaded : 0;
  if (totalCapped) return Number.isFinite(lastBatch) && Number.isFinite(limit) && limit > 0 && lastBatch >= limit;
  return Number.isFinite(total) && got < total;
}
