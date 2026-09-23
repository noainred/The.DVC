/**
 * VM·호스트 성능 차트 요약 수치(v2.598 VC2598-02). 서버는 vCenter 결측(-1)을 null 로 준다 — 예전 화면은
 * `a + p.v` 로 null 을 0 으로 더하고 분모는 전 점이라 평균이 **과소**했고, 최대·마지막도 결측에 끌렸다.
 * 값이 있는 점만 쓴다. 마지막은 '마지막으로 읽은 값' 이고(결측 뒤에 있으면 그 사실은 missing 이 말한다),
 * 읽은 점이 하나도 없으면 전부 null(화면 '—').
 */
export function metricStats(points) {
  const vals = [];
  let missing = 0;
  for (const p of points || []) {
    const v = p?.v;
    if (v == null || v === '' || !Number.isFinite(Number(v))) { missing += 1; continue; }
    vals.push(Number(v));
  }
  if (!vals.length) return { last: null, avg: null, peak: null, missing, measured: 0 };
  const sum = vals.reduce((a, x) => a + x, 0);
  return {
    last: vals[vals.length - 1],
    avg: Math.round((sum / vals.length) * 10) / 10,
    peak: Math.max(...vals),
    missing,
    measured: vals.length,
  };
}
