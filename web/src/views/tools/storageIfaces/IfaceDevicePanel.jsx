import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend as RLegend, ReferenceLine } from 'recharts';
import { fetchJson } from '../../../api.js';
import { Loading, ErrorBox } from '../../../components/ui.jsx';
import { STable } from '../../../components/STable.jsx';
import { Seg, Strip, StateCell, SpeedCell, WhyDetail } from './ifaceParts.jsx';
import {
  RANGES, UNITS, levelColor, rateText, pctText, speedText, timeText, hourText, KIND_LABEL, portKindOf, PROBE_STATE, sortVal, bucketText,
} from './ifaceText.js';
import { numOrNull } from '../../../numOrNull.js';

/**
 * 인터페이스 › 장비 한 대(v3.35.0 — 시안 docs/design/unity-iface ②). 포트 배치(SP × 종류) · SP 균형 · 고른 포트의 읽기/쓰기 추이 ·
 * 이 장비의 포트 표 · 이더넷 포트에 올라간 인터페이스 · 변화 이력 · 수집 출처. GET /tools/storage/devices/:id/ifaces — 폴링하지 않는다.
 */
const linkMBs = (g) => { const n = numOrNull(g); return n != null && n > 0 ? (n * 1e9) / 8 / 1e6 : null; };

function Tile({ p, selected, onPick }) {
  const band = p.linkUp === false ? 'transparent' : (levelColor(p.peakPct) || 'transparent');
  const sub = p.linkUp === false ? (p.state === 'down' ? '다운' : p.sfp === 'absent' ? 'SFP 없음' : '미연결') : speedText(p.speedGbps);
  return (
    <button type="button" onClick={() => onPick(p.id)} aria-pressed={selected} title={`${p.id} · ${sub} · 피크 ${pctText(p.peakPct)}`}
      style={{ width: 78, height: 58, boxSizing: 'border-box', borderRadius: 8, border: `1px ${p.linkUp === false && p.state !== 'down' ? 'dashed' : 'solid'} ${p.state === 'down' ? 'var(--red)' : (p.flags || []).includes('slow') ? 'var(--amber)' : 'var(--border)'}`,
        background: 'var(--panel-deep, #0f1626)', padding: '6px 7px 0', display: 'flex', flexDirection: 'column', gap: 1, position: 'relative', overflow: 'hidden', color: 'var(--text)', textAlign: 'left', cursor: 'pointer',
        outline: selected ? '2px solid #f8fafc' : 'none', outlineOffset: 1 }}>
      <b style={{ fontSize: 12, fontFamily: 'var(--mono)' }}>{p.id.replace(/^sp[ab]_/, '')}</b>
      <small style={{ fontSize: 10.5, color: p.state === 'down' ? 'var(--red)' : (p.flags || []).includes('slow') ? 'var(--amber)' : 'var(--text-dim)' }}>{sub}</small>
      <i style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 8, background: band }} />
    </button>
  );
}

function SpBar({ sp, label }) {
  if (!sp) return <span className="muted" style={{ fontSize: 12 }}>{label}: 판정 못 함(한쪽 SP 에만 값이 있거나 처리량을 못 읽음)</span>;
  const entries = Object.entries(sp.shares);
  const colors = ['#3b82f6', '#a855f7'];
  return (
    <div className="flex gap" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
      <span style={{ fontSize: 12, fontWeight: 600, width: 130 }}>{label}</span>
      <div style={{ flex: '1 1 260px', display: 'flex', height: 14, borderRadius: 7, overflow: 'hidden', minWidth: 0 }} role="img" aria-label={entries.map(([k, v]) => `${k.toUpperCase()} ${v}%`).join(', ')}>
        {entries.map(([k, v], i) => <span key={k} style={{ width: `${v}%`, background: colors[i % 2] }} />)}
      </div>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{entries.map(([k, v]) => `${k.toUpperCase()} ${v}%`).join(' · ')}</span>
      {sp.skew && <span className="badge amber">한쪽으로 몰림</span>}
      {sp.partial > 0 && <span className="muted" style={{ fontSize: 11.5 }}>못 읽은 포트 {sp.partial}개 제외</span>}
    </div>
  );
}

export default function IfaceDevicePanel({ deviceId, range, onRange, unit, onUnit, dcName, onBack }) {
  const [port, setPort] = useState(null);
  const [end, setEnd] = useState(null);
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);
  const topRef = useRef(null);
  // 긴 표 아래에서 장비를 눌렀어도 이 화면의 머리부터 보이게(열 때 한 번).
  const ready = !!d;
  useEffect(() => { if (ready) { try { topRef.current?.scrollIntoView({ block: 'start' }); } catch { /* 오래된 브라우저 */ } } }, [deviceId, ready]);
  const load = () => {
    const my = ++reqRef.current;
    const ac = new AbortController();
    setLoading(true);
    fetchJson(`/tools/storage/devices/${encodeURIComponent(deviceId)}/ifaces`, { range, port: port || undefined, end: end || undefined }, ac.signal)
      .then((r) => { if (my === reqRef.current) { setD(r); setErr(null); } })
      .catch((e) => { if (my === reqRef.current && e?.name !== 'AbortError') setErr(e); })
      .finally(() => { if (my === reqRef.current) setLoading(false); });
    return ac;
  };
  useEffect(() => { const ac = load(); return () => ac.abort(); }, [deviceId, range, port, end]); // eslint-disable-line react-hooks/exhaustive-deps

  const dev = d?.device; const v = dev?.view;
  const ifsByPort = useMemo(() => { const m = new Map(); for (const x of v?.interfaces || []) { if (!m.has(x.port)) m.set(x.port, []); m.get(x.port).push(x); } return m; }, [v]);
  const sel = (v?.ports || []).find((p) => p.id === d?.selected) || null;
  const chart = useMemo(() => {
    const s = d?.series;
    if (!s || !Array.isArray(s.cols)) return [];
    const useMax = s.kind !== 'raw' && Array.isArray(s.inMax);
    return s.cols.map((t, i) => {
      const inB = numOrNull(useMax ? s.inMax[i] : s.in[i]); const outB = numOrNull(useMax ? s.outMax[i] : s.out[i]);
      const fc = sel?.kind === 'fc';
      const mb = (b) => (b == null ? null : Math.round((b / 8 / 1e6) * 10) / 10);
      return { t, read: mb(fc ? outB : inB), write: mb(fc ? inB : outB) };
    });
  }, [d, sel]);
  const busyTime = useMemo(() => {
    const s = d?.series; const cap = linkMBs(sel?.speedGbps);
    if (!s || s.kind !== 'raw' || cap == null || !chart.length) return null;
    const th = cap * (numOrNull(d.busyPct) ?? 80) / 100;
    const n = chart.filter((x) => Math.max(x.read ?? 0, x.write ?? 0) >= th).length;
    const missing = chart.filter((x) => x.read == null && x.write == null).length;
    return { min: Math.round((n * (numOrNull(d.sampleMs) ?? 300_000)) / 60_000), missing, total: chart.length };
  }, [d, sel, chart]);

  if (err && !d) return <div><button type="button" className="tab" onClick={onBack}>← 전 장비</button><ErrorBox error={err.message || String(err)} /></div>;
  if (!d) return <Loading label="장비 인터페이스" />;
  if (!v) return <div><button type="button" className="tab" onClick={onBack}>← 전 장비</button><ErrorBox error="이 장비의 인터페이스 화면을 만들지 못했습니다." /></div>;

  const fcRows = v.ports.filter((p) => p.kind === 'fc' && p.linkUp === true);
  const ethRows = v.ports.filter((p) => p.kind === 'eth' && p.linkUp === true);
  const sum = (rows, k) => { const xs = rows.map((r) => numOrNull(r[k])); return xs.some((x) => x == null) || !xs.length ? null : xs.reduce((a, b) => a + b, 0); };
  const fcRead = sum(fcRows, 'readBps'); const fcWrite = sum(fcRows, 'writeBps');
  const ethIn = sum(ethRows, 'readBps'); const ethOut = sum(ethRows, 'writeBps');
  const top = [...v.ports].filter((p) => p.peakPct != null).sort((a, b) => b.peakPct - a.peakPct)[0] || null;
  const sps = [...new Set(v.ports.map((p) => p.sp || '?'))].sort();
  const cap = linkMBs(sel?.speedGbps);
  const s = d.series;
  const spanMs = s ? s.end - s.start : 0;
  const rangeLabel = RANGES.find(([x]) => x === range)?.[1] || range;
  return (
    <div ref={topRef} style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, scrollMarginTop: 110 }}>
      <div className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'center', gap: '8px 10px' }}>
        <button type="button" className="tab" style={{ flex: 'none', padding: '4px 12px' }} onClick={onBack}>← 전 장비</button>
        <b style={{ fontSize: 17 }}>{dev.name || dev.id}</b>
        <span className="badge gray">법인 {dcName(dev.datacenterId)}</span>
        <span className="badge gray">수집 {dev.collectMethod === 'ssh' ? 'SSH(uemcli)' : 'REST'}{dev.agent ? ` · 엣지 ${dev.agent}` : ''}</span>
        <span className="badge gray">마지막 수집 {timeText(dev.collectedAt)}</span>
        {!dev.snapOk && dev.collectedAt && <span className="badge red" title={dev.snapError}>마지막 수집 실패</span>}
        <span style={{ flexGrow: 1 }} />
        <Seg label="기간" items={RANGES} value={range} onPick={(k) => { setEnd(null); onRange(k); }} />
        <Seg label="단위" items={UNITS} value={unit} onPick={onUnit} />
        <button type="button" className="tab" style={{ flex: 'none', padding: '4px 12px' }} disabled={loading} onClick={() => load()}>{loading ? '읽는 중…' : '새로 고침'}</button>
      </div>
      {err && <ErrorBox error={`새로 고침 실패 — 아래는 직전 결과입니다: ${err.message || err}`} />}
      {v.throughputWhy && <div className="card" style={{ padding: '10px 14px', borderColor: 'rgba(245,158,11,.45)' }}><b style={{ fontSize: 13 }}>사용량을 못 읽는 이유</b><WhyDetail why={v.throughputWhy} detail={v.throughputDetail} /></div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
        <div className="card kpi"><div className="label">포트</div><div className="value">{v.ports.length}</div>
          <div className="muted" style={{ fontSize: 11.5 }}>링크 업 {v.ports.filter((p) => p.linkUp === true).length} · 다운 {v.ports.filter((p) => p.state === 'down').length} · 미연결 {v.ports.filter((p) => p.state === 'unused').length}</div></div>
        <div className="card kpi"><div className="label">FC 합계 · 최근 5분</div><div className="value" style={{ fontSize: 20 }}>{rateText(fcRead == null || fcWrite == null ? null : fcRead + fcWrite, unit)}</div>
          <div className="muted" style={{ fontSize: 11.5 }}>읽기 {rateText(fcRead, unit)} · 쓰기 {rateText(fcWrite, unit)}</div></div>
        <div className="card kpi"><div className="label">이더넷 합계 · 최근 5분</div><div className="value" style={{ fontSize: 20 }}>{rateText(ethIn == null || ethOut == null ? null : ethIn + ethOut, unit)}</div>
          <div className="muted" style={{ fontSize: 11.5 }}>받음 {rateText(ethIn, unit)} · 보냄 {rateText(ethOut, unit)}</div></div>
        <div className="card kpi"><div className="label">가장 높은 포트 · {rangeLabel}</div><div className="value" style={{ fontSize: 20, color: top && top.peakPct >= d.busyPct ? '#fdba74' : undefined }}>{pctText(top?.peakPct)}</div>
          <div className="muted" style={{ fontSize: 11.5, fontFamily: 'var(--mono)' }}>{top ? `${top.id} · ${hourText(top.peakAt)}` : '—'}</div></div>
      </div>
      <span className="muted" style={{ fontSize: 11.5, marginTop: -6 }}>합계는 링크 업 포트를 전부 읽었을 때만 냅니다(한 포트라도 못 읽으면 ‘—’ — 부분 합을 내지 않습니다).</span>

      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-soft, #1f2a40)', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <b>포트 배치</b><span className="muted" style={{ fontSize: 12 }}>칸 아래 띠 = {rangeLabel} 피크 사용률 · 칸을 누르면 아래 추이가 그 포트로 바뀝니다 · 점선 = 미연결</span>
        </div>
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {sps.map((sp) => (
            <div key={sp} className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'flex-end', gap: 18 }}>
              <b style={{ width: 44, alignSelf: 'center' }}>{sp.toUpperCase()}</b>
              {['fc', 'eth'].map((kd) => {
                const ps = v.ports.filter((p) => (p.sp || '?') === sp && p.kind === kd);
                if (!ps.length) return null;
                return (
                  <div key={kd} style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                    <span className="muted" style={{ fontSize: 11, fontWeight: 600 }}>{kd === 'fc' ? 'FC' : '이더넷'} · {ps.length}개</span>
                    <div className="flex gap" style={{ flexWrap: 'wrap', gap: 6 }}>{ps.map((p) => <Tile key={p.id} p={p} selected={p.id === d.selected} onPick={(id) => { setEnd(null); setPort(id); }} />)}</div>
                  </div>
                );
              })}
            </div>
          ))}
          <div style={{ borderTop: '1px solid var(--border-soft, #1f2a40)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <SpBar sp={v.sp?.fc} label="FC 처리량 SP 균형" />
            <SpBar sp={v.sp?.eth} label="이더넷 SP 균형" />
            <span className="muted" style={{ fontSize: 12 }}>기간 평균 처리량 기준입니다. LUN 소유 SP 와 호스트 경로 정책에 따라 정상일 수 있습니다 — 한쪽 포트만 포화에 가까운지와 함께 보세요.</span>
          </div>
        </div>
      </div>

      {sel && (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-soft, #1f2a40)', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <b style={{ fontFamily: 'var(--mono)', fontSize: 14 }}>{sel.id}</b>
            <span className={`badge ${sel.kind === 'fc' ? 'blue' : 'teal'}`}>{KIND_LABEL[portKindOf(sel, ifsByPort)]}</span>
            <StateCell r={sel} />
            <span className="muted" style={{ fontSize: 12 }}>연결 <SpeedCell r={sel} /> · 요청 {sel.requested === 'auto' ? '자동' : speedText(sel.requested)} · 최대 {speedText(sel.maxGbps)}{sel.mtu ? ` · MTU ${sel.mtu}` : ''}</span>
          </div>
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
              <div className="card kpi"><div className="label">{sel.kind === 'fc' ? '읽기' : '받음'} · 최근 5분</div><div className="value" style={{ fontSize: 18, color: '#67e8f9' }}>{rateText(sel.readBps, unit)}</div></div>
              <div className="card kpi"><div className="label">{sel.kind === 'fc' ? '쓰기' : '보냄'} · 최근 5분</div><div className="value" style={{ fontSize: 18, color: '#fcd34d' }}>{rateText(sel.writeBps, unit)}</div><div className="muted" style={{ fontSize: 11.5 }}>포트 사용률 {pctText(sel.nowPct)}</div></div>
              <div className="card kpi"><div className="label">기간 피크</div><div className="value" style={{ fontSize: 18, color: sel.peakPct != null && sel.peakPct >= d.busyPct ? '#fdba74' : undefined }}>{pctText(sel.peakPct)}</div><div className="muted" style={{ fontSize: 11.5 }}>{hourText(sel.peakAt) || '—'}</div></div>
              <div className="card kpi"><div className="label">기간 평균</div><div className="value" style={{ fontSize: 18 }}>{pctText(sel.avgPct)}</div></div>
              {busyTime && <div className="card kpi"><div className="label">{pctText(d.busyPct)} 이상이던 시간</div><div className="value" style={{ fontSize: 18 }}>{busyTime.min}분</div><div className="muted" style={{ fontSize: 11.5 }}>결측 {busyTime.missing} / {busyTime.total} 칸</div></div>}
            </div>
            {!s ? <div className="muted" style={{ fontSize: 12.5 }}>{'이 포트의 처리량 표본이 없습니다 — 이유는 위 ‘사용량을 못 읽는 이유’ 를 보세요.'}</div> : (
              <>
                <div style={{ width: '100%', height: 260, minWidth: 0 }}>
                  <ResponsiveContainer>
                    <ComposedChart data={chart} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke="rgba(148,163,184,.12)" vertical={false} />
                      <XAxis dataKey="t" type="number" domain={[s.start, s.end]} scale="time" tickFormatter={(t) => (spanMs > 2 * 86_400_000 ? hourText(t).slice(0, 5) : timeText(t).slice(6))} stroke="#8b9bb4" fontSize={11} />
                      <YAxis stroke="#8b9bb4" fontSize={11} unit=" MB/s" width={78} domain={[0, (max) => Math.max(max || 0, cap || 0)]} />
                      <Tooltip labelFormatter={(t) => timeText(t)} formatter={(val, name) => [val == null ? '—' : `${val} MB/s`, name]} contentStyle={{ background: '#141b2d', border: '1px solid #243049', fontSize: 12 }} />
                      <RLegend wrapperStyle={{ fontSize: 12 }} />
                      {cap && <ReferenceLine y={cap} stroke="#ea580c" strokeDasharray="5 4" label={{ value: `링크 ${speedText(sel.speedGbps)} (100%)`, fill: '#fdba74', fontSize: 10, position: 'insideTopRight' }} />}
                      {cap && <ReferenceLine y={cap * (numOrNull(d.busyPct) ?? 80) / 100} stroke="#f59e0b" strokeDasharray="2 4" label={{ value: `포화 근접 ${pctText(d.busyPct)}`, fill: '#fcd34d', fontSize: 10, position: 'insideTopLeft' }} />}
                      <Line type="monotone" dataKey="read" name={sel.kind === 'fc' ? '읽기' : '받음'} stroke="#22d3ee" dot={false} strokeWidth={1.5} connectNulls={false} isAnimationActive={false} />
                      <Line type="monotone" dataKey="write" name={sel.kind === 'fc' ? '쓰기' : '보냄'} stroke="#f59e0b" dot={false} strokeWidth={1.7} connectNulls={false} isAnimationActive={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                  <span className="muted" style={{ fontSize: 12 }}>{timeText(s.start)} ~ {timeText(s.end)} · {s.kind === 'raw' ? '5분 표본' : `${bucketText(s.bucketMs) || '하루'} 칸(칸 안 최댓값)`}{s.truncated ? ' · 행 상한으로 앞부분이 잘렸습니다' : ''}</span>
                  <span style={{ flexGrow: 1 }} />
                  <button type="button" className="tab" style={{ flex: 'none', padding: '4px 12px' }} onClick={() => setEnd(s.start)} disabled={!s.oldest?.sampleTs && !s.oldest?.day}>◀ 이전 {rangeLabel}</button>
                  <button type="button" className="tab" style={{ flex: 'none', padding: '4px 12px' }} disabled={!s.past} onClick={() => setEnd(s.end + spanMs)}>다음 ▶</button>
                  <button type="button" className="tab" style={{ flex: 'none', padding: '4px 12px' }} disabled={!s.past} onClick={() => setEnd(null)}>최신</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 520px), 1fr))', gap: 12 }}>
        <div className="card" style={{ padding: 0, overflow: 'hidden', minWidth: 0 }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-soft, #1f2a40)' }}><b>이 장비의 포트</b> <span className="muted" style={{ fontSize: 12 }}>{v.ports.length}개 · 행을 누르면 위 추이가 그 포트로</span></div>
          <STable minWidth={640}>
            <thead><tr><th>포트</th><th>종류</th><th>속도</th><th>상태</th><th style={{ textAlign: 'right' }}>읽기/받음</th><th style={{ textAlign: 'right' }}>쓰기/보냄</th><th style={{ textAlign: 'right' }}>피크</th><th data-nosort>{rangeLabel}</th></tr></thead>
            <tbody>
              {[...v.ports].sort((a, b) => (b.peakPct ?? -1) - (a.peakPct ?? -1)).map((p) => (
                <tr key={p.id} onClick={() => { setEnd(null); setPort(p.id); }} style={{ cursor: 'pointer', background: p.id === d.selected ? 'rgba(59,130,246,.10)' : undefined }}>
                  <td style={{ fontFamily: 'var(--mono)' }}>{p.id}</td>
                  <td>{KIND_LABEL[portKindOf(p, ifsByPort)]}</td>
                  <td data-sort={sortVal(p.speedGbps)}><SpeedCell r={p} /></td>
                  <td><StateCell r={p} /></td>
                  <td data-sort={sortVal(p.readBps)} style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{rateText(p.readBps, unit)}</td>
                  <td data-sort={sortVal(p.writeBps)} style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{rateText(p.writeBps, unit)}</td>
                  <td data-sort={sortVal(p.peakPct)} style={{ textAlign: 'right', fontFamily: 'var(--mono)', color: p.peakPct != null && p.peakPct >= d.busyPct ? '#fdba74' : undefined }}>{pctText(p.peakPct)}</td>
                  <td data-nosort><Strip cells={p.cells} label={`${p.id} 칸별 피크`} width={120} /></td>
                </tr>
              ))}
            </tbody>
          </STable>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-soft, #1f2a40)' }}><b>이더넷 포트에 올라간 인터페이스</b> <span className="muted" style={{ fontSize: 12 }}>사용량은 인터페이스가 아니라 그 포트의 값입니다</span></div>
            {(v.interfaces || []).length === 0 ? <div className="muted" style={{ padding: 14, fontSize: 12.5 }}>읽은 인터페이스가 없습니다(아래 수집 출처 확인).</div> : (
              <STable minWidth={520}>
                <thead><tr><th>포트</th><th>종류</th><th>이름 · NAS 서버</th><th>IP</th><th style={{ textAlign: 'right' }}>VLAN</th><th>역할</th></tr></thead>
                <tbody>
                  {v.interfaces.map((x) => (
                    <tr key={x.id}><td style={{ fontFamily: 'var(--mono)' }}>{x.port}</td><td><span className={`badge ${x.kind === 'iscsi' ? 'teal' : 'gray'}`}>{x.kind === 'iscsi' ? 'iSCSI' : x.kind === 'nas' ? 'NAS' : '기타'}</span></td>
                      <td>{x.nasServer || <span style={{ fontFamily: 'var(--mono)' }}>{x.id}</span>}</td><td style={{ fontFamily: 'var(--mono)' }}>{x.ip || '—'}</td>
                      <td data-sort={sortVal(x.vlan)} style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{x.vlan ?? '—'}</td><td>{x.role === 'production' ? '운영' : x.role === 'backup' ? '백업' : (x.role || '—')}</td></tr>
                  ))}
                </tbody>
              </STable>
            )}
          </div>
          <div className="card" style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5 }}>
            <b style={{ fontSize: 13 }}>이 장비의 속도 · 링크 변화 <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>최근 30일</span></b>
            {(d.changes || []).length === 0 ? <span className="muted">기록된 변화가 없습니다.</span> : d.changes.map((c, i) => (
              <span key={i} className="flex gap" style={{ gap: 10, flexWrap: 'wrap' }}><span className="muted" style={{ fontFamily: 'var(--mono)', width: 92 }}>{timeText(c.ts)}</span><span style={{ fontFamily: 'var(--mono)' }}>{c.port}</span>
                <span style={{ fontFamily: 'var(--mono)' }}>{c.before === 'down' ? '링크 다운' : c.before} → {c.after === 'down' ? '링크 다운' : c.after}</span></span>
            ))}
            <span className="muted" style={{ fontSize: 12 }}>시각은 변화를 처음 본 수집 시각입니다. 두 수집 사이에 내려갔다 올라온 변화는 남지 않습니다.</span>
          </div>
          <div className="card" style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
            <b style={{ fontSize: 13 }}>수집 출처 <span className="muted" style={{ fontWeight: 400 }}>구성 {timeText(v.at)} · {v.source || '—'}</span></b>
            {['fc', 'eth', 'ifs'].map((k) => {
              const pr = v.probe?.[k];
              if (!pr) return <span key={k} className="muted">{k === 'fc' ? 'FC 포트' : k === 'eth' ? '이더넷 포트' : '인터페이스'}: 기록 없음</span>;
              return (
                <span key={k} className="flex gap" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span className={`badge ${pr.state === 'ok' ? 'green' : pr.state === 'skipped' ? 'gray' : 'amber'}`}>{PROBE_STATE[pr.state] || pr.state}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, flex: '1 1 220px', minWidth: 0, overflowWrap: 'anywhere' }}>{pr.source}</span>
                  {pr.count != null && <span className="muted">{pr.count}건</span>}
                  {pr.detail && <span className="muted">{pr.detail}</span>}
                </span>
              );
            })}
            {(v.portsDropped > 0 || v.ifsDropped > 0) && <span className="muted">상한으로 뺀 항목 — 포트 {v.portsDropped} · 인터페이스 {v.ifsDropped}</span>}
            {d.addressHidden && <span className="muted">관리자가 아니어서 인터페이스 IP 는 가렸습니다.</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
