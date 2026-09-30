/**
 * SAN 스토리지 트래픽 합계(v2.669 — 사용자 제공 시안 'SAN Switch v2' 의 트래픽 카드. 순수 모듈).
 *
 * 입력은 perfDb.storageSeriesMulti 의 결과(`{ buckets, bucketMs, series[] }`)이고, 어레이(endpointKind==='array')
 * 시리즈만 버킷별로 더해 **한 줄**을 만든다. 서버 HBA 는 같은 트래픽의 반대편이라 더하면 두 배가 된다.
 *
 * ⚠⚠ 시안 README 의 예시 코드처럼 '한 시리즈라도 그 버킷이 null 이면 합계 null' 로만 두면 안 된다:
 *   storageSeriesMulti 는 **자기 표본이 하나도 없는 버킷**을 빈 칸으로 두는데(v2.415 — 다른 장비 때문에 생긴 버킷을
 *   채우지 않는다), 팹 A/B·법인마다 캡처 시각이 수십 초씩 어긋나므로 짧은 버킷(1시간 조회 = 30초)에서는 거의 모든
 *   버킷에서 어느 어레이 하나가 비어 합계 선이 통째로 사라진다. 그래서 합계 단계에서 한 번 더 이월한다 —
 *   perfDb 의 포트 이월(v2.621 DATA-03)과 **같은 규칙·같은 한계**(carryMs, 수집 주기 × 2):
 *     ① 그 버킷에 값이 있으면 그 값
 *     ② 부분 합(series.partial)으로 비운 버킷이면 → 합계도 null(부분 합을 그리지 않는다)
 *     ③ 값이 없고 직전 값이 한계 안이면 이월(carried 로 센다)
 *     ④ 직전 값이 한계를 넘었으면 → 합계 null(본 적은 있는데 지금은 모른다)
 *     ⑤ 아직 한 번도 안 나온 시리즈: 첫 값이 한계 안에 곧 나오면 '아직 캡처 전' 이라 → 합계 null,
 *        한참 뒤에 나오면 그때는 없던 것이라 → 더하지 않는다(모르는 것을 0 으로 세지 않되, 없던 것을 모른다고 하지도 않는다)
 *   ⚠ 이월한 값은 표시만 하는 합계다 — 원 시계열에는 쓰지 않는다.
 */

/**
 * @param {{buckets:number[], bucketMs:number, series:Array<{key:string, group?:string|null, sum:(number|null)[], partial?:number[]}>}} agg
 * @param {{ isArray:(s:object)=>boolean, carryMs:number }} opts
 */
export function sumArrayTraffic(agg, { isArray, carryMs } = {}) {
  const buckets = Array.isArray(agg?.buckets) ? agg.buckets : [];
  const n = buckets.length;
  const lim = Number.isFinite(Number(carryMs)) && Number(carryMs) > 0 ? Number(carryMs) : 0;
  const arrays = (Array.isArray(agg?.series) ? agg.series : []).filter((s) => s && Array.isArray(s.sum) && (isArray ? isArray(s) : true));
  const total = new Array(n).fill(null);
  const nowByGroup = [];   // 버킷별 { group → 합 } — '지금' 법인 비중에 마지막 유효 버킷의 것을 쓴다
  let carriedCells = 0;
  const partialIdx = [];
  const state = arrays.map((s) => {
    const first = s.sum.findIndex((v) => v != null);
    return { s, first, last: null, partial: new Set(Array.isArray(s.partial) ? s.partial : []) };
  });
  for (let i = 0; i < n; i++) {
    let acc = 0; let any = false; let broken = false; let carried = 0;
    const byGroup = {};
    for (const st of state) {
      const v = st.s.sum[i];
      let use = null;
      // ⚠ break 하지 않는다 — 한 시리즈가 판정을 깨도 나머지 시리즈의 직전 값(last)은 이 버킷에서 갱신돼야 한다
      //   (중간에 멈추면 뒤 시리즈의 last 가 낡아 다음 버킷들이 줄줄이 '한계 초과' 로 비었다 — 목 데이터 검증에서 발견).
      if (v != null) { use = v; st.last = { v, ts: buckets[i] }; }
      else if (st.partial.has(i)) broken = true;
      else if (st.last) {
        if (buckets[i] - st.last.ts <= lim) { use = st.last.v; carried += 1; }
        else broken = true;
      } else if (st.first >= 0 && buckets[st.first] - buckets[i] <= lim) broken = true;
      if (use != null) {
        acc += use; any = true;
        const g = st.s.group ?? '';
        byGroup[g] = (byGroup[g] || 0) + use;
      }
    }
    if (broken || !any) { if (broken) partialIdx.push(i); nowByGroup.push(null); continue; }
    total[i] = acc; carriedCells += carried; nowByGroup.push(byGroup);
  }
  let lastIdx = -1;
  for (let i = n - 1; i >= 0; i--) if (total[i] != null) { lastIdx = i; break; }
  const valid = total.filter((v) => v != null);
  let peak = null;
  for (let i = 0; i < n; i++) if (total[i] != null && (!peak || total[i] > peak.bps)) peak = { bps: total[i], ts: buckets[i] };
  return {
    total,
    now: lastIdx >= 0 ? { ts: buckets[lastIdx], bps: total[lastIdx] } : null,
    avg: valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null,
    peak,
    byGroupNow: lastIdx >= 0 ? nowByGroup[lastIdx] : {},
    arrays: arrays.length,
    measuredBuckets: valid.length,
    partialBuckets: partialIdx.length,
    carriedCells,
  };
}
