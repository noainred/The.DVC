/**
 * 코어 라이선스 산정 — 특수 기능 `core-license`(v2.703 — A13). 호스트 소켓·코어로 Broadcom 코어 구독 필요 수량(소켓당 최소 16코어)과
 * vSAN 용량(TiB)을 법인(vCenter)별로 낸다. ⚠ 판정은 서버(`server/src/corelicense/analyze.js`) — 이 화면은 조립만.
 * ⚠ 폴링하지 않는다(마운트 1회 + 새로고침) · 늦게 온 이전 응답은 버린다 · 훅은 전부 조기 return 위.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, downloadFile, canCsv } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { VSAN_PLAN_LABEL, fmtInt, fmtTib, coverageNote, reportedText, RULE_NOTE } from '../corelicense/coreLicenseText.js';

function Kpi({ label, value, sub }) {
  return (
    <div className="card" style={{ padding: '10px 14px', minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700 }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 11, whiteSpace: 'normal' }}>{sub}</div>}
    </div>
  );
}

export default function CoreLicenseTool({ scope }) {
  const [vcId, setVcId] = useState(scope || '');
  const [plan, setPlan] = useState('none');
  const [view, setView] = useState('vc');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvErr, setCsvErr] = useState(null);
  const gen = useRef(0);
  useEffect(() => { setVcId(scope || ''); }, [scope]);

  const load = useCallback(async () => {
    const my = ++gen.current;
    setLoading(true);
    try {
      const params = { vsan: plan };
      if (vcId) params.vcenterId = vcId;
      const d = await fetchJson('/tools/core-license', params);
      if (my !== gen.current) return;
      setData(d); setError(null);
    } catch (e) { if (my === gen.current) setError(e); } finally { if (my === gen.current) setLoading(false); }
  }, [vcId, plan]);
  useEffect(() => { load(); }, [load]);

  const showCsv = canCsv();
  const csv = async () => {
    setCsvBusy(true); setCsvErr(null);
    try {
      const qs = new URLSearchParams({ vsan: plan });
      if (vcId) qs.set('vcenterId', vcId);
      await downloadFile(`/tools/core-license.csv?${qs}`);
    } catch (e) { setCsvErr(e); } finally { setCsvBusy(false); }
  };

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const t = data.totals || {};
  const vcs = Array.isArray(data.vcenters) ? data.vcenters : [];
  const hosts = Array.isArray(data.hosts) ? data.hosts : [];
  const cov = coverageNote(t);
  const rate = data.rule?.vsanTibPerCore || 0;
  const vcNameOf = new Map(vcs.map((v) => [v.vcenterId, v.vcenterName]));

  return (
    <div style={{ minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        ESXi 호스트의 소켓·코어 수로 코어 단위 구독(vSphere Foundation·VCF)에 필요한 코어 수와 vSAN 용량을 법인(vCenter)별로 봅니다. 수집된 인벤토리만 읽습니다(vCenter 왕복 없음).
      </div>
      {data.initial && <div className="banner" style={{ marginBottom: 8 }}>첫 수집 중입니다 — 호스트 목록이 아직 비어 있을 수 있습니다.</div>}
      {cov && <div className="banner" style={{ marginBottom: 8 }}>{cov}</div>}
      {error && <div className="banner" style={{ marginBottom: 8 }}>다시 불러오지 못했습니다 — 이전 결과를 보여 줍니다.</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: 8, marginBottom: 10 }}>
        <Kpi label="필요 코어(산정)" value={fmtInt(t.licensed)} sub={`호스트 ${fmtInt(t.counted)}대 · 소켓 ${fmtInt(t.sockets)}`} />
        <Kpi label="물리 코어" value={fmtInt(t.cores)} sub={t.padded ? `최소 16코어로 ${fmtInt(t.padded)}코어 더함(${fmtInt(t.paddedHosts)}대)` : '최소 16코어로 더한 코어 없음'} />
        <Kpi label="vSAN 용량" value={fmtTib(t.vsanTib)} sub={rate ? `포함 ${fmtTib(t.vsanIncludedTib)} · 추가 필요 ${fmtTib(t.vsanAddonTib)}` : 'vSAN 포함 용량은 가정을 고르면 계산합니다'} />
        <Kpi label="산정 못 한 호스트" value={fmtInt(t.unknown)} sub={`전체 ${fmtInt(t.hosts)}대 중`} />
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 12 }}>vCenter</span>
        <select className="input" style={{ minWidth: 0, maxWidth: 260 }} value={vcId} onChange={(e) => setVcId(e.target.value)}>
          <option value="">전체</option>
          {vcs.map((v) => <option key={v.vcenterId} value={v.vcenterId}>{v.vcenterName}</option>)}
        </select>
        <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>vSAN 포함 용량</span>
        <select className="input" style={{ minWidth: 0, maxWidth: 240 }} value={plan} onChange={(e) => setPlan(e.target.value)}>
          {Object.entries(VSAN_PLAN_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <button type="button" className={`tab${view === 'vc' ? ' active' : ''}`} onClick={() => setView('vc')}>법인별</button>
        <button type="button" className={`tab${view === 'host' ? ' active' : ''}`} onClick={() => setView('host')}>호스트별</button>
        <button type="button" className="btn" onClick={load} disabled={loading}>{loading ? '불러오는 중…' : '새로고침'}</button>
        {showCsv && <button type="button" className="btn" onClick={csv} disabled={csvBusy}>CSV</button>}
      </div>
      {csvErr && <ErrorBox error={csvErr} />}

      <div className="card" style={{ padding: 0, minWidth: 0 }}>
        {view === 'vc' ? (
          vcs.length === 0 ? <div className="muted" style={{ padding: 16, fontSize: 13 }}>표시할 vCenter 가 없습니다.</div> : (
            <STable minWidth={1000}>
              <thead><tr><th>vCenter</th><th>호스트</th><th>소켓</th><th>물리 코어</th><th>필요 코어</th><th>16코어 보정</th><th>vSAN</th>{rate ? <th>vSAN 추가</th> : null}<th>vCenter 보고(코어 라이선스)</th></tr></thead>
              <tbody>
                {vcs.map((r) => {
                  const rep = reportedText(r);
                  return (
                    <tr key={r.vcenterId}>
                      <td style={{ minWidth: 150 }}><b>{r.vcenterName}</b></td>
                      <td data-sort={r.hosts}>{r.counted}{r.unknown ? <span className="muted" style={{ fontSize: 11 }}> (+모름 {r.unknown})</span> : null}</td>
                      <td data-sort={r.sockets}>{fmtInt(r.sockets)}</td>
                      <td data-sort={r.cores}>{fmtInt(r.cores)}</td>
                      <td data-sort={r.licensed}><b>{fmtInt(r.licensed)}</b></td>
                      <td data-sort={r.padded}>{r.padded ? `+${fmtInt(r.padded)}` : '—'}</td>
                      <td data-sort={r.vsanDs ? r.vsanTib : ''}>{r.vsanDs ? fmtTib(r.vsanTib) : '—'}</td>
                      {rate ? <td data-sort={r.vsanAddonTib ?? ''}>{r.vsanDs ? fmtTib(r.vsanAddonTib) : '—'}</td> : null}
                      <td style={{ whiteSpace: 'normal', fontSize: 12 }} className={rep.tone === 'muted' ? 'muted' : ''}>
                        {rep.tone === 'warn' ? <span className="badge amber">{rep.text}</span> : rep.text}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </STable>
          )
        ) : (
          hosts.length === 0 ? <div className="muted" style={{ padding: 16, fontSize: 13 }}>표시할 호스트가 없습니다.</div> : (
            <STable minWidth={860} limit={1000}>
              <thead><tr><th>호스트</th><th>vCenter</th><th>클러스터</th><th>소켓</th><th>물리 코어</th><th>소켓당 코어</th><th>필요 코어</th><th>16코어 보정</th></tr></thead>
              <tbody>
                {hosts.map((h) => (
                  <tr key={`${h.vcenterId}|${h.name}`}>
                    <td style={{ minWidth: 140 }}>{h.name}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{vcNameOf.get(h.vcenterId) || h.vcenterId}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{h.cluster || '—'}</td>
                    <td data-sort={h.sockets ?? ''}>{fmtInt(h.sockets)}</td>
                    <td data-sort={h.cores ?? ''}>{fmtInt(h.cores)}</td>
                    <td data-sort={h.perSocket ?? ''}>{h.unknown ? '—' : h.perSocket}</td>
                    <td data-sort={h.licensed ?? ''}>{h.unknown ? <span className="muted">산정 안 함</span> : <b>{fmtInt(h.licensed)}</b>}</td>
                    <td data-sort={h.padded ?? ''}>{h.padded ? `+${h.padded}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          )
        )}
      </div>
      {view === 'host' && (hosts.length > 1000 || data.hostsOmitted > 0) && (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>16코어 보정이 큰 순 상위 1,000대만 표시했습니다{data.hostsOmitted ? `(서버 상한으로 ${data.hostsOmitted}대 더 생략)` : ''} — 전체는 CSV 로 받으세요.</div>
      )}
      <div className="muted" style={{ fontSize: 12, marginTop: 6, whiteSpace: 'normal' }}>{RULE_NOTE} vSAN 은 vSAN 데이터스토어의 용량 합이고, 포함 용량은 계약 전체에서 합쳐지므로 추가 필요량 합계는 법인별 값을 더한 것이 아니라 전체 기준입니다.</div>
    </div>
  );
}
