/**
 * ClientDistView — 클라이언트 분포 · 재배치 보드(v2.932 2차 ③ · 사용자 요청 "특정 노드에 치우치는 이슈가 있어서 노드에 연결된 서버를 확인해서 재배치").
 *  · `/client-dist` 하나(서버 DB 만 · 장비 호출 0 · 폴링 없음). 노드 막대(쏠림) · 재배치 후보(계산일 뿐 — 포탈은 바꾸지 않는다) · 클라이언트 × 노드 비중 표 · CSV.
 *  · 판정·문구는 nodeLoadText.js(순수 — vitest).
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../../api.js';
import { STable } from '../../../components/STable.jsx';
import { opsText, shareText, clientNameText, skewBarsOf, candidateText, distNotes, distCsv, sampleText, windowRangeText, HEAT_RAMP } from './nodeLoadText.js';

const RANGES = [{ key: '24h', label: '24시간' }, { key: '7d', label: '7일' }, { key: '30d', label: '30일' }];
function shareBin(p) { const n = Number(p); if (!Number.isFinite(n) || n <= 0) return null; return Math.min(HEAT_RAMP.length - 1, Math.floor((n / 100) * HEAT_RAMP.length)); }

export default function ClientDistView({ deviceId, end = null, offsetMin = 540, onPickNode }) {
  const [range, setRange] = useState('7d');
  const [proto, setProto] = useState('all');
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    setBusy(true); setErr(null);
    const q = `range=${encodeURIComponent(range)}&proto=${encodeURIComponent(proto)}${end != null ? `&end=${end}` : ''}`;
    fetchJson(`/tools/storage/devices/${encodeURIComponent(deviceId)}/client-dist?${q}`)
      .then((r) => { if (my === seq.current) { setD(r); setBusy(false); } })
      .catch((e) => { if (my === seq.current) { setErr(e); setBusy(false); } });
  }, [deviceId, range, proto, end]);
  const ready = d && d.ok !== false && d.deviceId === deviceId;
  const bars = ready ? skewBarsOf(d) : [];
  const nodes = ready ? d.nodes.map((n) => n.id) : [];
  const notes = ready ? distNotes(d) : [];
  const protos = ['all', ...(ready ? (d.protos || []) : [])];
  const download = () => {
    const blob = new Blob([distCsv(d)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `client-dist-${deviceId}-${d.range}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <div className="nl-dist">
      <div className="nl-controls">
        <div className="nl-segwrap"><span className="nl-seglabel">창</span>
          <div className="nl-seg" role="group" aria-label="분포 기간">{RANGES.map((r) => <button key={r.key} type="button" className={range === r.key ? 'on' : ''} aria-pressed={range === r.key} onClick={() => setRange(r.key)}>{r.label}</button>)}</div></div>
        <div className="nl-segwrap"><span className="nl-seglabel">프로토콜</span>
          <div className="nl-seg" role="group" aria-label="프로토콜">{protos.map((p) => <button key={p} type="button" className={proto === p ? 'on' : ''} aria-pressed={proto === p} onClick={() => setProto(p)}>{p === 'all' ? '전체' : p}</button>)}</div></div>
        {busy && <span className="nl-muted">불러오는 중…</span>}
        {ready && d.clients.length > 0 && <button type="button" className="nl-btn" onClick={download} title="클라이언트 × 노드 비중 표를 CSV 로">CSV 내려받기</button>}
      </div>
      {err && <div className="nl-banner amber">분포 조회 오류: {String(err?.message || err)}</div>}
      {ready && <div className="nl-note">{windowRangeText(d.end, d.days, offsetMin)} · 쏠림 기준 노드 평균 × {d.thresholds.skewFactor} · 고정 기준 {Math.round(d.thresholds.fixedShare * 100)}% · 표본 주기 {sampleText(d.sample?.sampleMs)}{d.proto !== 'all' ? ` · ${d.proto} 만` : ''}</div>}
      {notes.map((n) => <div key={n.text} className={`nl-banner ${n.tone}`}>{n.text}</div>)}
      {ready && bars.length > 0 && (
        <div className="nl-body">
          <div className="nl-side nl-skew">
            <div className="nl-sidehead">노드별 ops 합(창) · 노드 평균 {opsText(d.mean)}</div>
            {bars.map((b) => (
              <button type="button" key={b.id} className={`nl-rankrow nl-rowbtn${b.skew ? ' skew' : ''}`} onClick={() => onPickNode?.(b.id)}
                title={`노드 ${b.id} · ${opsText(b.total)} · 평균의 ${b.ratio ?? '—'}배${b.skew ? ' · 쏠림' : ''} — 눌러서 이 노드의 클라이언트`}>
                <span>노드 {b.id}{b.skew ? <span className="nl-badge amber">쏠림</span> : null}</span>
                <span className="nl-track"><i style={{ width: `${b.w}%` }} /></span>
                <span className="nl-num">{b.ratio != null ? `${b.ratio}×` : '—'}</span>
              </button>
            ))}
          </div>
          <div className="nl-main">
            <div className="nl-sidehead">재배치 후보 {d.candidates.length ? d.candidates.length : '— 없음'}</div>
            {d.candidates.length > 0 && <ol className="nl-cands">{d.candidates.map((c) => <li key={`${c.client}|${c.from}|${c.proto || ''}`}>{candidateText(c)}</li>)}</ol>}
            {d.candidates.length > 0 && <div className="nl-note">쏠린 노드의 ‘고정’ 클라이언트를 ops 큰 순으로 가장 한가한 노드에 배정한 계산입니다(탐욕 · 최대 10). 실제 이동은 운영자가 SmartConnect 풀·마운트 대상을 바꿔서 합니다.</div>}
          </div>
        </div>
      )}
      {ready && d.clients.length > 0 && (
        <div className="table-wrap nl-tablewrap">
          <STable minWidth={640 + nodes.length * 44}>
            <thead><tr>
              <th>클라이언트</th><th>이름</th><th>프로토콜</th>
              <th style={{ textAlign: 'right' }}>합계 ops</th><th>주 노드</th><th style={{ textAlign: 'right' }}>비중</th>
              {nodes.map((n) => <th key={n} style={{ textAlign: 'right' }}>노드 {n}</th>)}
            </tr></thead>
            <tbody>
              {d.clients.map((c) => {
                const nm = clientNameText(c);
                return (
                  <tr key={`${c.client}|${c.proto}`}>
                    <td className="nl-mono">{c.client}</td>
                    <td title={nm.hint}>{nm.text}{c.fixed ? <span className="nl-badge">고정</span> : null}</td>
                    <td>{c.proto || '—'}</td>
                    <td className="nl-num" data-sort={String(c.total ?? '')}>{opsText(c.total)}</td>
                    <td data-sort={String(c.top ?? '')}>{c.top != null ? `노드 ${c.top}` : '—'}</td>
                    <td className="nl-num" data-sort={String(c.topShare ?? '')}>{shareText(c.topShare)}</td>
                    {nodes.map((n) => { const v = c.share?.[n]; const b = shareBin(v); return <td key={n} className="nl-num nl-sharecell" data-sort={String(v ?? '')} style={b == null ? undefined : { background: `${HEAT_RAMP[b]}40` }}>{v != null && v > 0 ? shareText(v) : ''}</td>; })}
                  </tr>
                );
              })}
            </tbody>
          </STable>
        </div>
      )}
      {ready && <div className="nl-note">상위 {d.clients.length}{d.clientsTotal > d.clients.length ? ` / ${d.clientsTotal}` : ''} 클라이언트(창 ops 합 내림차순). 비중 = 그 클라이언트의 창 ops 중 그 노드 몫 · ‘고정’ = 한 노드 비중이 기준 이상. 통계에는 그 순간 요청을 보낸 클라이언트만 잡힙니다.</div>}
    </div>
  );
}
