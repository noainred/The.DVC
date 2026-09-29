import React, { useEffect, useState } from 'react';
import BoldText from '../../components/boldText.jsx';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox, Kpi } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { agoText, countText } from './cvpText.js';
import { corpLabel } from './cvpOverviewText.js';
import { OPTICS_NOTE, dbmText, opticRowState, basisText, opticsKpis, opticsEmptyNote } from './cvpOpticsText.js';

/**
 * CVP › 광신호(v2.646 — 사용자 요청 '각 GBIC 의 광신호 세기를 확인 · 신호가 약하면 장애로 판정').
 * `/tools/cvp/optics` 1회(폴링 금지 — 마운트 + 새로고침). 판정은 서버(parse.judgeOptics)가 수집 시 끝낸다.
 */
const TONE = { ok: 'var(--green)', warn: 'var(--amber)', bad: 'var(--red)', muted: 'var(--text-dim)' };
const NOTE = { fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 };
const FILTERS = [['problem', '약함·낮음'], ['judged', '판정한 것'], ['all', '전체']];

export default function CvpOpticsView({ servers = [], onOpen }) {
  const [cvpId, setCvpId] = useState('');
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState('problem');
  useEffect(() => {
    let active = true;
    setErr(null);
    fetchJson('/tools/cvp/optics', cvpId ? { cvpId } : {})
      .then((x) => { if (active) setR(x); }).catch((e) => { if (active) { setErr(e); setR(null); } });
    return () => { active = false; };
  }, [cvpId, reload]);
  const all = r && Array.isArray(r.optics) ? r.optics.filter((o) => o && typeof o === 'object') : [];
  const shown = filter === 'problem' ? all.filter((o) => o.judged && (o.rxState === 'fault' || o.rxState === 'warn'))
    : filter === 'judged' ? all.filter((o) => o.judged) : all;
  const empty = r ? opticsEmptyNote(r.counts) : '';
  return (
    <div style={{ display: 'grid', gap: 14, minWidth: 0 }}>
      <div className="card" style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <b>GBIC 광신호(수신 광량)</b>
          {servers.length > 1 && (
            <select className="input" value={cvpId} onChange={(e) => setCvpId(e.target.value)} style={{ maxWidth: 220 }}>
              <option value="">모든 CVP</option>
              {servers.map((s) => <option key={s.id} value={String(s.id)}>{s.name || s.id}</option>)}
            </select>
          )}
          <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={() => setReload((x) => x + 1)}>새로고침</button>
        </div>
        <div style={{ ...NOTE, marginTop: 6 }}><BoldText text={OPTICS_NOTE} /></div>
      </div>
      {err && <ErrorBox error={err} />}
      {!r && !err && <Loading />}
      {r && (
        <>
          <div className="kpis">
            {opticsKpis(r.counts, r.thresholds).map((k) => <Kpi key={k.key} label={k.label} value={k.value} accent={k.accent} meta={k.meta} />)}
          </div>
          {empty && <div className="banner"><BoldText text={empty} /></div>}
          <div className="card" style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {FILTERS.map(([k, l]) => <button key={k} type="button" className={`tab${filter === k ? ' active' : ''}`} onClick={() => setFilter(k)}>{l}</button>)}
              <span style={{ ...NOTE, alignSelf: 'center' }}>{countText(shown.length)}개 · 수신 광량 낮은 순(판정한 것 먼저)</span>
            </div>
            {shown.length === 0 ? (
              <div style={{ ...NOTE, marginTop: 8 }}>{filter === 'problem' ? '광량이 약하거나 낮은 트랜시버가 없습니다(판정한 것 기준 — 판정 안 함·값 없음은 위 칸을 보세요).' : '해당하는 트랜시버가 없습니다.'}</div>
            ) : (
              <STable minWidth={1000} limit={1000} style={{ marginTop: 8 }}>
                <thead><tr><th>장비</th><th>포트</th><th>판정</th><th>수신(Rx)</th><th>송신(Tx)</th><th>온도</th><th>전압</th><th>바이어스</th><th>기준</th><th>법인</th><th>CVP</th><th>수집</th></tr></thead>
                <tbody>
                  {shown.map((o, i) => {
                    const st = opticRowState(o);
                    return (
                      <tr key={`${o.cvpId}|${o.key}|${o.part}|${i}`}>
                        <td><button type="button" onClick={() => onOpen?.({ cvpId: o.cvpId, key: o.key, hostname: o.hostname })}
                          style={{ background: 'none', border: 0, padding: 0, color: 'inherit', cursor: 'pointer', fontWeight: 600, textDecoration: 'underline dotted', textUnderlineOffset: 3 }}>{o.hostname || o.key}</button></td>
                        <td style={{ fontSize: 12 }}>{o.intf || o.part}</td>
                        <td><span style={{ color: TONE[st.tone], fontWeight: 600, whiteSpace: 'nowrap' }}>{st.label}</span></td>
                        <td className="right" data-sort={o.rx ?? ''}><b style={{ color: TONE[st.tone === 'muted' ? 'muted' : st.tone] }}>{dbmText(o.rx)}</b></td>
                        <td className="right" data-sort={o.tx ?? ''}>{dbmText(o.tx)}</td>
                        <td className="right" data-sort={o.temperature ?? ''}>{o.temperature == null ? '—' : `${Math.round(o.temperature * 10) / 10}℃`}</td>
                        <td className="right" data-sort={o.voltage ?? ''}>{o.voltage == null ? '—' : Math.round(o.voltage * 100) / 100}</td>
                        <td className="right" data-sort={o.txBias ?? ''}>{o.txBias == null ? '—' : Math.round(o.txBias * 100) / 100}</td>
                        <td style={{ fontSize: 12 }}>{basisText(o)}</td>
                        <td style={{ fontSize: 12 }}>{corpLabel(o)}</td>
                        <td style={{ fontSize: 12 }}>{o.cvpName}</td>
                        <td style={{ fontSize: 12 }} data-sort={o.partsAt || 0}>{agoText(o.partsAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </STable>
            )}
            {shown.length > 1000 && <div style={{ ...NOTE, marginTop: 6 }}>표는 정렬 기준 상위 1,000개만 그립니다({countText(shown.length - 1000)}개 생략).</div>}
            {r.omitted > 0 && <div style={{ ...NOTE, marginTop: 6 }}>응답 상한으로 {countText(r.omitted)}개를 빼고 받았습니다 — CVP 를 골라 좁혀 보세요.</div>}
          </div>
        </>
      )}
    </div>
  );
}
