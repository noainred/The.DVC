// views/vms/vmSeries.jsx — VM 24시간 추이(CPU·메모리) 1회 조회 훅 + 스파크라인(v2.909).
//   드로어(VmDrawer)와 개체 보기 요약 탭(vcd/VmObject)이 같이 쓴다(한 벌). /vms/:id/metrics interval=day — 폴링하지 않는다.
//   VM 이 바뀌면 이전 요청을 끊고(AbortController) 늦게 온 응답은 id 를 보고 버린다. 꺼진 VM 은 조회하지 않는다(enabled=false).
import React, { useEffect, useState } from 'react';
import { fetchJson } from '../../api.js';
import { sparkPath, peakOf, pctText } from './vmHubText.js';
import { numOrNull } from '../../numOrNull.js';

/** 24시간 추이(열 때 1회) — { cpu, mem } 각각 { points, error, loading }. vmId 가 바뀌면 이전 요청을 끊고 늦은 응답을 버린다. */
export function useDaySeries(vmId, enabled) {
  const [s, setS] = useState({ id: null, cpu: null, mem: null });
  useEffect(() => {
    if (!vmId || !enabled) { setS({ id: vmId, cpu: null, mem: null }); return undefined; }
    const ac = new AbortController();
    let alive = true;
    setS({ id: vmId, cpu: { loading: true }, mem: { loading: true } });
    // v2.911: 두 지표를 한 번에(types=cpu,mem — 서버 로그인 1회 · QueryPerf 1회). 예전에는 지표마다 호출해 로그인이 2회였다.
    const pick = (d, k) => { const s = d?.series?.[k]; return s?.error ? { error: s.error } : { points: Array.isArray(s?.points) ? s.points : [], mock: d?.mock === true }; };
    fetchJson(`/vms/${encodeURIComponent(vmId)}/metrics`, { types: 'cpu,mem', interval: 'day' }, ac.signal, { retries: 0, timeoutMs: 30_000 })
      .then((d) => { if (alive) setS((p) => (p.id === vmId ? { ...p, cpu: pick(d, 'cpu'), mem: pick(d, 'mem') } : p)); })
      .catch((e) => { if (alive && e?.name !== 'AbortError') { const err = { error: e?.message || String(e) }; setS((p) => (p.id === vmId ? { ...p, cpu: err, mem: err } : p)); } });
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

/**
 * v2.963 — /vms/lookup?id&signals=1 응답 → 드로어 신호 상태(순수 — vitest 고정).
 *   같은 VM 이고 signals 가 배열이면 { signals, days } · 응답에 그 VM 이 없으면(지워짐 · 범위 밖) { missing:true } — '신호 없음' 으로 말하지 않는다.
 */
export function signalsFromLookup(d, vmId) {
  const v = d && typeof d === 'object' ? d.vm : null;
  if (!v || v.id !== vmId || !Array.isArray(v.signals)) return { missing: true };
  return { signals: v.signals.filter((k) => typeof k === 'string'), days: numOrNull(d.snapAgeDays) };
}

/**
 * v2.963 — 목록 없이 연 드로어의 신호(열 때 1회 · 폴링 없음). enabled=false(이미 신호를 가진 항목)면 묻지 않는다.
 *   스냅샷만 읽는 조회라 vCenter 호출이 없다. VM 이 바뀌면 이전 요청을 끊고 늦게 온 응답은 id 로 버린다(useDaySeries 와 같은 규칙).
 *   effect 가 돌기 전(첫 렌더)에도 '확인 중' 으로 보이게 loading 을 기본으로 둔다 — 순간이라도 '신호를 받지 않았다' 고 말하지 않게.
 */
export function useVmSignals(vmId, enabled) {
  const [s, setS] = useState({ id: null });
  useEffect(() => {
    if (!vmId || !enabled) { setS({ id: vmId }); return undefined; }
    const ac = new AbortController();
    let alive = true;
    setS({ id: vmId, loading: true });
    fetchJson('/vms/lookup', { id: vmId, signals: '1' }, ac.signal, { retries: 0, timeoutMs: 20_000 })
      .then((d) => { if (alive) setS({ id: vmId, ...signalsFromLookup(d, vmId) }); })
      .catch((e) => { if (alive && e?.name !== 'AbortError') setS({ id: vmId, error: e?.message || String(e) }); });
    return () => { alive = false; ac.abort(); };
  }, [vmId, enabled]);
  return s.id === vmId ? s : { id: vmId, loading: !!(vmId && enabled) };
}

