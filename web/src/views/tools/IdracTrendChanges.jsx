// IdracTrendChanges.jsx — iDRAC 통합 추이 › 서버 표에서 찾은 서버의 '언제 · 얼마나'(v2.687).
// 사용자 요청: "서버를 찾으면 어느 날 어느 시간에 얼마 만큼의 변화가 있었는지 리스트로 표시".
// 서버(`GET /admin/idrac/:id/trend/hourly`)는 표와 같은 창의 시간별 평균·최대·최소만 주고, 판정·묶기는
// idracTrendText.changeEpisodes(표의 조건 판정과 같은 규칙 — vitest)가 한다. 창을 열 때 1회만 부른다(폴링 없음).
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, canCsv } from '../../api.js';
import { Loading, ErrorBox } from '../../components/primitives.jsx';
import { Modal } from '../../components/Modal.jsx';
import { STable } from '../../components/STable.jsx';
import {
  TABLE_SERIES, activeConds, changeEpisodes, episodeRangeText, episodeDeltaText, condOneText, episodesCsv, valueText, hoursLabel, ymd, hm,
} from './idracTrendText.js';

export function IdracTrendChanges({ row, conds, hours, since, onClose, onOpen }) {
  const act = useMemo(() => activeConds(conds), [conds]);
  const keys = useMemo(() => [...new Set(act.map((c) => c.k))], [act]);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    setData(null); setErr(null);
    fetchJson(`/admin/idrac/${encodeURIComponent(row.id)}/trend/hourly`, { hours, since, keys: keys.join(',') })
      .then((d) => { if (alive) setData(d); }).catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, [row.id, hours, since, keys]);

  const res = useMemo(() => (data ? changeEpisodes(data.series, row, act) : null), [data, row, act]);
  const missing = data ? keys.filter((k) => !Array.isArray(data.series?.[k]) || !data.series[k].length) : [];
  const saveCsv = () => {
    const blob = new Blob([episodesCsv(row.name, res.episodes)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `idrac-changes_${hours}h.csv`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <Modal title={`언제 · 얼마나 — ${row.name}`} onClose={onClose} width={980} resizable>
      <div style={{ fontSize: 12, marginBottom: 8, lineHeight: 1.6 }}>
        <span className="muted">최근 {hoursLabel(hours)}(시작 {ymd(since)} {hm(since)}) 안에서 조건에 걸린 시간을 1시간 단위로 찾아 이어진 시간은 한 구간으로 묶었습니다.</span>
      </div>
      {!act.length && <div className="banner">조건이 없습니다 — 조건 칸에 값을 넣으면 그 조건에 걸린 시간을 보여 줍니다.</div>}
      {err && <ErrorBox error={err} />}
      {act.length > 0 && !data && !err && <Loading label="시간별 값" />}
      {res && (
        <>
          <div className="flex wrap" style={{ gap: 10, alignItems: 'center', marginBottom: 8, fontSize: 12 }}>
            <b>구간 {res.episodes.length + res.omitted}개 · 걸린 시간 {res.hitHours}시간</b>
            {res.omitted > 0 && <span style={{ color: 'var(--amber)' }}>최근 {res.episodes.length}개만 보입니다({res.omitted}개 생략 — CSV 도 같습니다).</span>}
            <span style={{ marginLeft: 'auto' }} className="flex" >
              <button type="button" className="tab" style={{ flex: 'none', padding: '3px 10px', marginTop: 0 }} onClick={() => onOpen(row)}>📈 추이 차트로</button>
              {canCsv() && <button type="button" className="logout-btn" style={{ flex: 'none', padding: '4px 12px', marginLeft: 6 }} disabled={!res.episodes.length} onClick={saveCsv}>⬇ CSV</button>}
            </span>
          </div>
          {missing.length > 0 && (
            <div className="banner" style={{ marginBottom: 8 }}>
              시간별 값이 없는 지표: {missing.map((k) => TABLE_SERIES.find((s) => s.k === k)?.label || k).join(', ')} — 그 지표의 조건은 판정하지 않았습니다(0 으로 보지 않습니다).
            </div>
          )}
          {Object.keys(data.errors || {}).length > 0 && <div className="banner" style={{ marginBottom: 8 }}>일부 지표를 읽지 못했습니다: {Object.keys(data.errors).join(', ')}</div>}
          <STable minWidth={860} limit={2000}>
            <thead>
              <tr><th>시간대</th><th>지속</th><th>지표</th><th>조건</th><th className="right">정점(시각 · 값)</th><th className="right">기간 평균</th><th className="right">평균 대비 변화</th></tr>
            </thead>
            <tbody>
              {res.episodes.map((e) => {
                const s = TABLE_SERIES.find((x) => x.k === e.k);
                return (
                  <tr key={e.id}>
                    <td data-sort={e.start} style={{ whiteSpace: 'nowrap' }}>{episodeRangeText(e)}</td>
                    <td data-sort={e.hours}>{e.hours}시간</td>
                    <td style={{ color: s?.color, fontWeight: 600 }}>{s?.label}</td>
                    <td className="muted">{condOneText(e.cond)}</td>
                    <td className="right" data-sort={e.peak} style={{ whiteSpace: 'nowrap' }}>
                      <span className="muted" style={{ fontSize: 11 }}>{hm(e.peakTs)}</span> {e.dir === 'up' ? '▲' : '▼'} <b>{valueText(e.peak, s?.unit || '')}</b>
                    </td>
                    <td className="right" data-sort={e.avg ?? ''}>{valueText(e.avg, s?.unit || '')}</td>
                    <td className="right" data-sort={e.delta == null ? '' : Math.abs(e.delta)} style={{ whiteSpace: 'nowrap', fontWeight: 700 }}>{episodeDeltaText(e)}</td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
          {!res.episodes.length && (
            <div className="muted" style={{ padding: 12 }}>
              시간별 값에서 조건에 걸린 시간을 찾지 못했습니다{missing.length ? ' — 위의 값이 없는 지표 때문일 수 있습니다' : ''}. 표를 연 뒤 시간이 지나 기간이 밀렸거나 값이 갱신됐을 수 있으니 표를 새로고침해 보세요.
            </div>
          )}
          <div className="muted" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
            시간대는 그 시간 칸의 시작~끝입니다(1시간 단위 — 시간당 집계라 분 단위 시각은 알 수 없습니다). 정점은 구간 안에서 기준에서 가장 크게 벗어난 시간과 그 시간의 최대(▲) 또는 최소(▼)입니다.
            평균 대비 변화는 정점 값 − 표의 기간 평균이고, 괄호는 평균에 대한 비율입니다(평균이 0 이하이면 비율은 내지 않습니다). 퍼센트 지표의 차이는 %p 입니다.
          </div>
        </>
      )}
    </Modal>
  );
}
