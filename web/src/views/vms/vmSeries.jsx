// views/vms/vmSeries.jsx — VM 24시간 추이(CPU·메모리) 1회 조회 훅 + 스파크라인(v2.909).
//   드로어(VmDrawer)와 개체 보기 요약 탭(vcd/VmObject)이 같이 쓴다(한 벌). /vms/:id/metrics interval=day — 폴링하지 않는다.
//   VM 이 바뀌면 이전 요청을 끊고(AbortController) 늦게 온 응답은 id 를 보고 버린다. 꺼진 VM 은 조회하지 않는다(enabled=false).
import React, { useEffect, useState } from 'react';
import { fetchJson } from '../../api.js';
import { sparkPath, peakOf, pctText } from './vmHubText.js';

/** 24시간 추이(열 때 1회) — { cpu, mem } 각각 { points, error, loading }. vmId 가 바뀌면 이전 요청을 끊고 늦은 응답을 버린다. */
export function useDaySeries(vmId, enabled) {
  const [s, setS] = useState({ id: null, cpu: null, mem: null });
  useEffect(() => {
    if (!vmId || !enabled) { setS({ id: vmId, cpu: null, mem: null }); return undefined; }
    const ac = new AbortController();
    let alive = true;
    setS({ id: vmId, cpu: { loading: true }, mem: { loading: true } });
    for (const type of ['cpu', 'mem']) {
      fetchJson(`/vms/${encodeURIComponent(vmId)}/metrics`, { type, interval: 'day' }, ac.signal, { retries: 0, timeoutMs: 30_000 })
        .then((d) => { if (alive) setS((p) => (p.id === vmId ? { ...p, [type]: { points: Array.isArray(d?.points) ? d.points : [], mock: d?.mock === true } } : p)); })
        .catch((e) => { if (alive && e?.name !== 'AbortError') setS((p) => (p.id === vmId ? { ...p, [type]: { error: e?.message || String(e) } } : p)); });
    }
    return () => { alive = false; ac.abort(); };
  }, [vmId, enabled]);
  return s.id === vmId ? s : { id: vmId, cpu: null, mem: null };
}

export function Spark({ series, color }) {
  if (!series || series.loading) return <span className="s">24시간 추이 조회 중…</span>;
  if (series.error) return <span className="s" title={series.error}>24시간 추이를 읽지 못했습니다</span>;
  const d = sparkPath(series.points, { w: 100, h: 26, max: 100 });
  if (!d) return <span className="s">24시간 추이 없음</span>;
  const peak = peakOf(series.points);
  return (
    <>
      <svg className="vmh-spark" viewBox="0 0 100 26" preserveAspectRatio="none" role="img" aria-label={`24시간 추이 · 최대 ${pctText(peak)}`}>
        <path d={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="s">24시간 최대 {pctText(peak)}</span>
    </>
  );
}

