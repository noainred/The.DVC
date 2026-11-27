/**
 * 포탈 점검 › **법인별 실환경 확인**(v2.938 · 제안 8번 '법인별로 적용').
 * 판정은 서버(`server/src/fieldcheck/judge.js`), 문구는 `fieldCheckText.js`. 이 파일은 조립만 한다.
 * ⚠ 폴링하지 않는다 — 마운트 1회 + '다시 불러오기'(왕복 0 이지만 v2.508 규약) · 늦게 온 이전 응답은 버린다 · 표는 STable minWidth.
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox, Kpi } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { STATE_TEXT, CHECK_TEXT, stateOf, bannerText, kpiOf, checkSummary, rowRank } from './fieldCheckText.js';
import { agoText } from './relTime.js';

const TONE = Object.freeze({ green: 'var(--ok, #35c46a)', red: 'var(--bad, #ef5a5a)', amber: 'var(--warn, #e8b23a)', gray: 'var(--muted)' });

function Cell({ c }) {
  const s = stateOf(c);
  return (
    <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
      <span style={{ color: TONE[s.tone] || TONE.gray, fontWeight: 600, whiteSpace: 'nowrap' }}>{s.label}</span>
      {c?.detail && <span className="muted" style={{ fontSize: 11, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{c.detail}</span>}
      {c?.at ? <span className="muted" style={{ fontSize: 10.5 }}>{agoText(c.at)}</span> : null}
    </div>
  );
}

export function FieldCheckView() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const seq = useRef(0);
  const load = async () => {
    const my = ++seq.current;
    setBusy(true);
    try { const d = await fetchJson('/tools/portal-check/field'); if (my === seq.current) { setData(d); setError(null); } }
    catch (e) { if (my === seq.current) setError(e); }
    finally { if (my === seq.current) setBusy(false); }
  };
  useEffect(() => { load(); }, []);

  if (error && !data) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  const checks = Array.isArray(data.checks) ? data.checks : Object.keys(CHECK_TEXT);
  const kpi = kpiOf(data);
  const rows0 = Array.isArray(data.rows) ? data.rows : [];
  const rows = (onlyOpen ? rows0.filter((r) => checks.some((k) => ['failed', 'pending', 'unknown'].includes(r.cells?.[k]?.state))) : rows0)
    .slice().sort((a, b) => rowRank(a, checks) - rowRank(b, checks) || String(a.name).localeCompare(String(b.name)));

  return (
    <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0 }} data-field-check="">
      {error && <div className="banner">다시 불러오지 못했습니다 — 아래는 직전에 읽은 값입니다.</div>}
      <div className="card" style={{ borderLeft: `3px solid ${TONE.gray}` }}>
        <div style={{ fontSize: 12, lineHeight: 1.6, whiteSpace: 'normal' }}><BoldText text={bannerText(data)} /></div>
        {data.hiddenForDemo && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>데모 계정에는 목 vCenter 만 보입니다.</div>}
      </div>
      {/* 다섯 칸은 겹치지 않는다 — 합계 = 확인됨 + 실패 + 근거 없음 + 해당 없음 + 판정 불가 */}
      <div className="kpis">
        <Kpi label="판정 칸" value={kpi.total} />
        <Kpi label={STATE_TEXT.confirmed.label} value={kpi.confirmed} />
        <Kpi label={STATE_TEXT.failed.label} value={kpi.failed} />
        <Kpi label={STATE_TEXT.pending.label} value={kpi.pending} meta={kpi.pending ? '실패가 아니라 기록 없음' : undefined} />
        <Kpi label={STATE_TEXT.na.label} value={kpi.na} />
        <Kpi label={STATE_TEXT.unknown.label} value={kpi.unknown} meta={kpi.unknown ? '확인됨에 넣지 않음' : undefined} />
      </div>
      <div className="card" style={{ display: 'grid', gap: 6, fontSize: 12 }}>
        {checks.map((k) => (
          <div key={k} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline', minWidth: 0 }}>
            <b style={{ whiteSpace: 'nowrap' }}>{CHECK_TEXT[k]?.label || k}</b>
            <span style={{ whiteSpace: 'nowrap' }}>{checkSummary(data, k)}</span>
            <span className="muted" style={{ fontSize: 11, minWidth: 0, whiteSpace: 'normal' }}>{CHECK_TEXT[k]?.what || ''}</span>
          </div>
        ))}
      </div>
      <div className="card" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn" onClick={load} disabled={busy} data-field-reload="">{busy ? '불러오는 중…' : '다시 불러오기'}</button>
        <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> 확인 안 된 법인만
        </label>
        <span className="muted" style={{ fontSize: 11, minWidth: 0, whiteSpace: 'normal' }}>장비 · 엣지에 나가지 않습니다 — 중앙이 이미 받은 결과만 봅니다.</span>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden', minWidth: 0 }}>
        <STable minWidth={860} wrap>
          <thead><tr>
            <th>법인(vCenter)</th><th>수집 · 엣지</th>
            {checks.map((k) => <th key={k}>{CHECK_TEXT[k]?.label || k}</th>)}
          </tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={2 + checks.length} className="center muted" style={{ padding: 18 }}>{onlyOpen ? '확인 안 된 법인이 없습니다.' : '법인이 없습니다.'}</td></tr>}
            {rows.map((r) => (
              <tr key={r.id}>
                <td data-sort={r.name}><b>{r.name}</b><div className="muted" style={{ fontSize: 11 }}>{r.id}</div></td>
                <td data-sort={r.agent || ''}>{r.mode === 'site' ? <>위임{r.agent ? <div className="muted" style={{ fontSize: 11 }}>{r.agent}</div> : null}</> : '중앙 직접'}</td>
                {checks.map((k) => <td key={k} data-sort={String(rowRank({ cells: { [k]: r.cells?.[k] } }, [k]))}><Cell c={r.cells?.[k]} /></td>)}
              </tr>
            ))}
          </tbody>
        </STable>
      </div>
    </div>
  );
}

export default FieldCheckView;
