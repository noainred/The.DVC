import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox, Kpi } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { stateLabel, shortDeviceName } from './sanSwitchPorts.js';
import { MAP_HOURS, LEVELS, GAP_BG, mapTiles, mapKpis, tileStyle, sparkPoints, rateText, pctText } from './sanPortUsageText.js';

/**
 * 🔲 포트 배치(v2.748 — 사용자 요구 '스위치 한 대의 전체 포트와 포트 사용량을 보여주는 화면').
 * 데이터는 기존 /perf(포트별 시계열 — 기억·합류·취소를 탄다) + 스냅샷 포트 목록이다. 새 서버 집계를 만들지 않는다.
 * 폴링하지 않는다(무거운 조회 — 탭을 열 때 1회 + 기간 바꿀 때).
 */
function Spark({ values }) {
  const segs = sparkPoints(values, 80, 18);
  if (!segs.length) return <span className="muted">—</span>;
  return (
    <svg width="80" height="18" viewBox="0 0 80 18" aria-hidden="true">
      {segs.map((s, i) => <polyline key={i} points={s.map((p) => p.join(',')).join(' ')} fill="none" stroke="#22d3ee" strokeWidth="1.2" />)}
    </svg>
  );
}

export default function SanPortMap({ deviceId, ports, onOpenUsage, focusPort }) {
  const [hours, setHours] = useState(24);
  const [metric, setMetric] = useState('peak');
  const [sel, setSel] = useState(focusPort ?? null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const reqKey = JSON.stringify([deviceId, hours]);
  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    const key = reqKey;
    fetchJson(`/tools/sanswitch/devices/${deviceId}/perf`, { hours: String(hours) }, ac.signal, { timeoutMs: 90_000, retries: 0 })
      .then((d) => { if (!ac.signal.aborted) setData({ ...d, reqKey: key }); })
      .catch((e) => { if (!ac.signal.aborted) setError({ key, msg: e.message }); });
    return () => ac.abort();
  }, [reqKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = data && data.reqKey === reqKey ? data : null;
  const errNow = error && error.key === reqKey ? error.msg : null;
  const tiles = useMemo(() => mapTiles(ports, shown, metric), [ports, shown, metric]);
  const k = mapKpis(tiles);
  const cur = tiles.find((x) => x.port === sel) || null;
  const label = metric === 'peak' ? '피크' : '평균';

  return (
    <div style={{ marginBottom: 10, minWidth: 0 }}>
      <div className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        {MAP_HOURS.map(([h, l]) => (
          <button key={h} className={hours === h ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 12px' }} onClick={() => setHours(h)}>{l}</button>
        ))}
        {[['peak', '피크'], ['avg', '평균']].map(([m, l]) => (
          <button key={m} className={metric === m ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 12px' }} onClick={() => setMetric(m)}>{l}</button>
        ))}
        <span className="muted" style={{ fontSize: 11.5 }}>타일 색 = 지난 {MAP_HOURS.find(([h]) => h === hours)?.[1]} {label} ÷ 협상 속도</span>
      </div>
      {errNow && <ErrorBox message={errNow} />}
      {!errNow && !shown && <Loading />}
      {shown && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginBottom: 8 }}>
            <Kpi label="사용 중" value={k.online} meta="상태가 온라인인 포트" />
            <Kpi label="80% 이상" value={k.hot} accent={k.hot ? '#ea580c' : undefined} meta={`${label} 기준`} />
            <Kpi label="유휴(1% 미만)" value={k.idle} meta="사용 중인데 거의 안 쓰임" />
            <Kpi label="값 없음" value={k.noData} meta="사용 중인데 이 기간 표본 없음" />
            <Kpi label="전체" value={k.total} meta="스냅샷 포트 수" />
          </div>
          <div className="card" style={{ padding: 8, marginBottom: 8 }}>
            <div className="flex gap" style={{ flexWrap: 'wrap', fontSize: 11, marginBottom: 6, alignItems: 'center' }}>
              {LEVELS.map((l) => <span key={l.min} className="flex gap" style={{ alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 10, background: l.color, display: 'inline-block', borderRadius: 2 }} />{l.label}</span>)}
              <span className="flex gap" style={{ alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 10, background: GAP_BG, display: 'inline-block' }} />값 없음</span>
              <span className="flex gap" style={{ alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 10, background: 'rgba(148,163,184,.2)', display: 'inline-block' }} />사용 중 아님</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(58px, 1fr))', gap: 4 }}>
              {tiles.map((t) => (
                <button key={t.port} onClick={() => setSel(t.port)}
                  title={`포트 ${t.slotPort} · ${stateLabel(t.state)}${t.name ? `\n${t.name}` : ''}\n${label} ${rateText(t.value)}${t.pct == null ? (t.value == null ? '' : ' · 속도를 몰라 포화도 없음') : ` · ${t.pct}%`}`}
                  style={{ ...tileStyle(t), border: sel === t.port ? '2px solid #f8fafc' : '1px solid rgba(148,163,184,.25)', borderRadius: 4, padding: '4px 2px', fontSize: 11, cursor: 'pointer', minWidth: 0, lineHeight: 1.25 }}>
                  <div style={{ fontWeight: 600 }}>{t.slotPort}</div>
                  <div style={{ fontSize: 10 }}>{t.state !== 'online' ? stateLabel(t.state) : t.value == null ? '—' : pctText(t.pct)}</div>
                </button>
              ))}
            </div>
          </div>
          {cur && (
            <div className="card" style={{ padding: 8, marginBottom: 8, fontSize: 12.5 }}>
              <div className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'baseline' }}>
                <b>포트 {cur.slotPort}</b>
                <span className="muted" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }} title={cur.name}>{cur.name ? shortDeviceName(cur.name, 50) : '연결 장비 없음'}</span>
                <span className="muted">· {stateLabel(cur.state)} · 속도 {cur.speed || '모름'}</span>
              </div>
              <div style={{ marginTop: 4 }}>평균 {rateText(cur.avg)} · 피크 {rateText(cur.peak)} · {label} 포화도 {pctText(cur.pct)}</div>
              {onOpenUsage && (
                <button className="tab" style={{ flex: 'none', padding: '4px 12px', marginTop: 6 }} onClick={() => onOpenUsage(cur.port)}>📊 이 포트의 사용량 기록 보기(1일·7일·1달)</button>
              )}
            </div>
          )}
          <STable minWidth={720} style={{ width: '100%' }}>
            <thead>
              <tr><th>포트</th><th>상태</th><th>연결 장비</th><th>속도</th><th>평균</th><th>피크</th><th>{label} 포화도</th><th data-nosort>추이</th></tr>
            </thead>
            <tbody>
              {tiles.map((t) => (
                <tr key={t.port} onClick={() => setSel(t.port)} style={{ cursor: 'pointer', background: sel === t.port ? 'rgba(34,211,238,.08)' : undefined }}>
                  <td data-sort={t.port}><b>{t.slotPort}</b></td>
                  <td>{stateLabel(t.state)}</td>
                  <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.name}>{shortDeviceName(t.name, 36) || '—'}</td>
                  <td>{t.speed || '—'}</td>
                  <td data-sort={t.avg ?? ''}>{rateText(t.avg)}</td>
                  <td data-sort={t.peak ?? ''}>{rateText(t.peak)}</td>
                  <td data-sort={t.pct ?? ''}>{pctText(t.pct)}</td>
                  <td><Spark values={t.spark} /></td>
                </tr>
              ))}
            </tbody>
          </STable>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
            <BoldText text={'피크는 **수집 시점들 중 최댓값**(기본 5분 주기)이고, 값은 송수신 합이라 회선 속도 대비 100% 를 넘을 수 있습니다. 포트 상태·연결 장비·속도는 마지막 스냅샷 기준입니다.'} />
          </div>
        </>
      )}
    </div>
  );
}
