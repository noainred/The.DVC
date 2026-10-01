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
 *     ⑥ (v2.681 R2D-09) 직전 값 이후 한계 × (1 + SERIES_RETIRE_CARRIES) 를 넘게 값이 없는 시리즈는 **없어진 것**으로 본다
 *        (포트 재배선·어레이 퇴역·포트 메타 변경) — ⑤의 대칭이다. 예전엔 ④가 끝없이 이어져 포트 하나를 정리하면 그 뒤 합계가
 *        **전부** null('—')이 됐다. 그 사이(한계 ~ 한계 × 4)는 여전히 ④(모른다)이고, 없어진 시리즈 수는 retiredSeries 로 밝힌다.
 *     ⑦ (v2.682 R3A-03→R3A-02) ⑥은 **장비 자체가 보고를 멈춘 경우**에는 적용하지 않는다 — 엣지 perf push 가 끊긴 스위치(v2.566
 *        TDZ 사고와 같은 상황)·장비 장애를 40분 뒤 '없어진 것' 으로 빼면 남은 시리즈만의 값이 **온전한 버킷**처럼 나와 거짓 하락이
 *        된다. 시리즈의 장비 중 지금 등록·사용 중(`activeDeviceIds`)인 것이 있고 그 장비들의 마지막 표본(`deviceLastTs`)이 이 시리즈의
 *        마지막 값보다 한계 넘게 새롭지 않으면(= 장비가 다른 포트로도 보고하지 않는다) 그 시리즈는 **모른다(null)** 로 둔다
 *        (heldSeries 로 센다). 장비가 다른 포트로는 계속 보고하는데 이 시리즈만 없어졌으면(재배선·포트 정리) 예전처럼 ⑥.
 *        두 옵션을 주지 않으면 예전 동작이다.
 *   ⚠ 이월한 값은 표시만 하는 합계다 — 원 시계열에는 쓰지 않는다.
 */

/** v2.681(R2D-09): 한계를 넘긴 뒤 몇 한계 동안 더 '모른다(null)' 로 둘지 — 그 뒤는 없어진 시리즈. storage sumCapacityBuckets 와 같은 값. */
export const SERIES_RETIRE_CARRIES = 3;

/**
 * @param {{buckets:number[], bucketMs:number, series:Array<{key:string, group?:string|null, sum:(number|null)[], partial?:number[]}>}} agg
 * @param {{ isArray:(s:object)=>boolean, carryMs:number }} opts
 */
export function sumArrayTraffic(agg, { isArray, carryMs, activeDeviceIds = null, deviceLastTs = null } = {}) {
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
    return { s, first, last: null, retired: false, held: false, partial: new Set(Array.isArray(s.partial) ? s.partial : []) };
  });
  const retireAfter = lim > 0 ? lim * (1 + SERIES_RETIRE_CARRIES) : Infinity;
  // ⑦ 그 시리즈의 등록·사용 중 장비가 이 시리즈의 마지막 값 이후로 **어디로도** 보고하지 않았는가(= 장비가 멈췄다 — 퇴역 아님).
  const deviceSilent = (st) => {
    if (!(activeDeviceIds instanceof Set)) return false;
    const ids = (Array.isArray(st.s.deviceIds) ? st.s.deviceIds : []).map(String).filter((id) => activeDeviceIds.has(id));
    if (!ids.length) return false;
    const lastOf = (id) => { const v = deviceLastTs instanceof Map ? Number(deviceLastTs.get(id)) : NaN; return Number.isFinite(v) ? v : null; };
    return ids.every((id) => { const v = lastOf(id); return v == null || v <= st.last.ts + lim; });
  };
  for (let i = 0; i < n; i++) {
    let acc = 0; let any = false; let broken = false; let carried = 0;
    const byGroup = {};
    for (const st of state) {
      const v = st.s.sum[i];
      let use = null;
      // ⚠ break 하지 않는다 — 한 시리즈가 판정을 깨도 나머지 시리즈의 직전 값(last)은 이 버킷에서 갱신돼야 한다
      //   (중간에 멈추면 뒤 시리즈의 last 가 낡아 다음 버킷들이 줄줄이 '한계 초과' 로 비었다 — 목 데이터 검증에서 발견).
      if (v != null) { use = v; st.last = { v, ts: buckets[i] }; st.retired = false; st.held = false; }   // 다시 나오면 없어진 것이 아니다
      else if (st.partial.has(i)) broken = true;
      else if (st.last) {
        const gap = buckets[i] - st.last.ts;
        if (gap <= lim) { use = st.last.v; carried += 1; }
        else if (gap > retireAfter && deviceSilent(st)) { broken = true; st.held = true; st.retired = false; }   // ⑦ 장비가 멈췄다 — 모른다
        else if (gap > retireAfter) st.retired = true;   // ⑥ 없어진 시리즈 — 더하지도, 판정을 깨지도 않는다
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
    retiredSeries: state.filter((st) => st.retired).length,
    // v2.682(R3A-02): 등록·사용 중 장비가 보고를 멈춰 '없어진 것' 으로 빼지 않고 모른다(null)로 둔 시리즈 수.
    heldSeries: state.filter((st) => st.held).length,
  };
}
