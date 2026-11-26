import React, { useEffect, useState } from 'react';
import BoldText from '../../components/boldText.jsx';
import { fetchJson } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { NOTE, MONO, ROW, GRID1, LINKBTN, Tiles, Spark, Pill, Pending } from './CvpNetParts.jsx';
import { opticTrendText, OPTIC_TREND_NOTE, FORECAST_TONE, perMonthText, dbmText, dateText, rowKey, numText, horizonText } from './cvpNetText.js';

/**
 * CVP › 광신호 › 추세 · 재고(v3.38 ⑮). `/tools/cvp/optics/trend` 마운트 1회 + 새로고침. 판정은 서버 cvp/opticstrend.js.
 */
export default function CvpOpticsTrendView({ part = 'trend', onOpen }) {
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  const [reload, setReload] = useState(0);
  const [onlyRisk, setOnlyRisk] = useState(true);
  useEffect(() => {
    let active = true;
    setErr(null); setR(null);
    fetchJson('/tools/cvp/optics/trend').then((x) => { if (active) setR(x); }).catch((e) => { if (active) setErr(e); });
    return () => { active = false; };
  }, [reload]);
  if (err || !r) return <Pending err={err} onRetry={() => setReload((x) => x + 1)} />;
  const t = r.trend || { rows: [], counts: {}, thresholds: {} };
  const th = t.thresholds || {};
  const risk = new Set(['alreadyFault', 'already', 'eta']);
  // v3.42(2회차 A1-F9): 기록이 끊긴 행도 마지막 값이 주의 임계 이하면 위험으로(장애 수준 Rx 로 링크가 끊긴 광모듈이 사라지지 않게)
  const isRisk = (x) => risk.has(x.state) || (x.state === 'stale' && x.lastRx != null && th.warnDbm != null && x.lastRx <= th.warnDbm);
  const rows = (t.rows || []).filter((x) => !onlyRisk || isRisk(x));
  const c = t.counts || {};
  const inv = r.inventory || { rows: [], totals: {} };
  if (part === 'stock') {
    const tt = inv.totals || {};
    return (
      <div style={GRID1}>
        <Tiles tiles={[
          ['링크 있음', tt.linked ?? 0, '꽂혀 있고 링크가 올라옴', '#4ade80'],
          ['예비 재고', tt.spare ?? 0, '꽂혀 있는데 링크 없음 — 다른 곳에 옮겨 쓸 수 있는 후보', '#93c5fd'],
          ['빈 케이지', tt.empty ?? 0, '', 'var(--text)'],
          ['링크 모름', tt.unknown ?? 0, '광 판정 값이 없는 트랜시버', 'var(--text-dim)'],
          ['목록 못 읽은 장비', tt.devicesUnread ?? 0, '0 이 아니라 모름', 'var(--amber)'],
        ]} />
        <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={ROW}><b>트랜시버 종류별</b><button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={() => setReload((x) => x + 1)}>새로고침</button></div>
          <STable className="v3-table" minWidth={620}>
            <thead><tr><th>종류</th><th>링크 있음</th><th>예비 재고</th><th>링크 모름</th><th>합</th></tr></thead>
            <tbody>
              {inv.rows.map((x) => (
                <tr key={x.type}>
                  <td style={MONO}>{x.type}</td>
                  <td style={{ ...MONO, textAlign: 'right' }}>{x.linked}</td>
                  <td style={{ ...MONO, textAlign: 'right', color: x.spare ? '#93c5fd' : undefined }}>{x.spare}</td>
                  <td style={{ ...MONO, textAlign: 'right' }}>{x.unknown}</td>
                  <td style={{ ...MONO, textAlign: 'right' }}>{x.linked + x.spare + x.unknown}</td>
                </tr>
              ))}
            </tbody>
          </STable>
          {!inv.rows.length && <div style={NOTE}>트랜시버 목록을 읽은 장비가 없습니다.</div>}
          <div style={NOTE}>부품 주기에 읽은 트랜시버 목록 기준입니다. 종류는 장비가 알려 준 매체(예: 25GBASE-SR) 그대로입니다.</div>
        </div>
      </div>
    );
  }
  return (
    <div style={GRID1}>
      <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={ROW}>
          <button type="button" className={`tab${onlyRisk ? ' active' : ''}`} aria-pressed={onlyRisk} onClick={() => setOnlyRisk((x) => !x)}>임계에 가까운 것만</button>
          <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={() => setReload((x) => x + 1)}>새로고침</button>
        </div>
        <div style={NOTE}><BoldText text={OPTIC_TREND_NOTE} /> 주의 {th.warnDbm} dBm · 장애 {th.faultDbm} dBm(CVP 설정) · 최근 {r.trendDays}일 · 기록 {r.minDays}일 미만은 기록 부족.</div>
      </div>
      <Tiles tiles={[
        ['장애 임계 이하', c.alreadyFault ?? 0, '', FORECAST_TONE.alreadyFault],
        ['주의 임계 이하', c.already ?? 0, '', FORECAST_TONE.already],
        [`${horizonText(r.horizonDays)} 안 주의 도달`, c.eta ?? 0, '하강 추세', FORECAST_TONE.eta],
        ['안정', (c.flat ?? 0) + (c.far ?? 0), `내려가지 않거나 ${horizonText(r.horizonDays)} 넘게`, 'var(--text)'],
        ['기록 부족 · 끊김', (c.short ?? 0) + (c.stale ?? 0), `기록 부족 ${c.short ?? 0} · 최근 기록 끊김 ${c.stale ?? 0}`, 'var(--text-dim)'],
      ]} />
      <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <STable className="v3-table" minWidth={1000}>
          <thead><tr><th>법인</th><th>스위치</th><th>인터페이스</th><th>지금(일 최저)</th><th data-nosort>최근 일 최저 Rx</th><th>변화</th><th>예상</th></tr></thead>
          <tbody>
            {rows.map((x) => (
              <tr key={rowKey(x)}>
                <td>{x.corpName || '법인 미지정'}</td>
                <td data-sort={x.hostname}><button type="button" style={LINKBTN} onClick={() => onOpen && onOpen(x)}>{x.hostname}</button></td>
                <td style={MONO}>{x.intf}</td>
                <td data-sort={x.current ?? x.lastRx ?? ''} style={MONO}>{x.current == null && x.lastRx != null ? <span title="기록이 끊겨 지금 값이 아닙니다">{`마지막 ${dbmText(x.lastRx)}`}</span> : dbmText(x.current)}</td>
                <td><Spark points={x.points} refLine={th.warnDbm} color={x.state === 'eta' || x.state.startsWith('already') ? '#fbbf24' : '#60a5fa'} title="일 최저 수신 광량" /></td>
                <td data-sort={x.perMonth ?? ''} style={MONO}>{perMonthText(x.perMonth, ' dB')}{x.resetAt ? <span style={{ ...NOTE, marginLeft: 6 }}>({dateText(x.resetAt)}부터 다시)</span> : null}</td>
                <td data-sort={x.state === 'alreadyFault' ? 0 : x.state === 'already' ? 1 : (x.warnEta ?? '')}><Pill color={FORECAST_TONE[x.state] || 'var(--text-dim)'}>{opticTrendText(x, { minDays: r.minDays, horizonDays: r.horizonDays })}</Pill></td>
              </tr>
            ))}
          </tbody>
        </STable>
        {!rows.length && <div style={NOTE}>{(t.rows || []).length ? '임계에 가까운 트랜시버가 없습니다.' : '아직 기록이 없습니다 — 부품 주기마다 링크가 올라온 트랜시버의 일 최저 광량을 쌓습니다.'}</div>}
        <div style={NOTE}>{numText(rows.length)}개 표시{t.omitted ? ` · ⚠ ${t.omitted}개 생략` : ''}</div>
      </div>
    </div>
  );
}
