/**
 * CPU 경합·디스크 지연 — 특수 기능 `contention`(v2.706 — C2·C3). 켜진 VM 의 CPU Ready·Co-stop·latency, 가상 디스크 지연,
 * 경합 VM 이 몰린 호스트와 같은 호스트의 사용량 상위 VM(이웃 후보), 데이터스토어 지연.
 * ⚠ 판정은 서버(`server/src/contention/analyze.js`) — 이 화면은 조립만. 문구는 `views/contention/contentionText.js`.
 * ⚠ 폴링하지 않는다(마운트 1회 + 새로고침) · 늦게 온 이전 응답은 버린다(세대 번호) · 훅은 전부 조기 return 위(React #310).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, downloadFile, canCsv } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { VmLink } from '../../components/EntityDetail.jsx';
import { CONTENTION_TEXT, SEV_LABEL, SEV_BADGE, pctText, msText, coverageNote, windowText, missingCounterNote } from '../contention/contentionText.js';
import Select from '../../components/Select.jsx';
import { mergeVcChoices } from './vcChoices.js';

function Chip({ active, onClick, children, title }) {
  return (
    <button type="button" className={`tab${active ? ' active' : ''}`} onClick={onClick} title={title}
      style={{ whiteSpace: 'normal', maxWidth: '100%', textAlign: 'left', padding: '4px 10px', fontSize: 12 }}>{children}</button>
  );
}
const SEV_SORT = { crit: 0, warn: 1, info: 2 };

export default function ContentionTool({ scope }) {
  const [tab, setTab] = useState('vms');
  const [vcId, setVcId] = useState(scope || '');
  const [sev, setSev] = useState('issue');
  const [q, setQ] = useState('');
  const [qApplied, setQApplied] = useState('');
  const [data, setData] = useState(null);
  // v2.719(감사 W1-01): vCenter 를 고른 응답은 목록을 그 하나로 거른다 — 선택지는 '전체' 응답에서 본 목록을 기억해 쓴다.
  const [vcOpts, setVcOpts] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvErr, setCsvErr] = useState(null);
  const gen = useRef(0);

  useEffect(() => { setVcId(scope || ''); }, [scope]);
  useEffect(() => { const t = setTimeout(() => setQApplied(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  const load = useCallback(async () => {
    const my = ++gen.current;
    setLoading(true);
    try {
      const params = {};
      if (vcId) params.vcenterId = vcId;
      if (sev) params.sev = sev;
      if (qApplied) params.q = qApplied;
      const d = await fetchJson('/tools/contention', params);
      if (my !== gen.current) return;
      setData(d); setError(null);
      setVcOpts((prev) => mergeVcChoices(prev, d?.vcenterChoices || d?.status, params.vcenterId));
    } catch (e) { if (my === gen.current) setError(e); } finally { if (my === gen.current) setLoading(false); }
  }, [vcId, sev, qApplied]);
  useEffect(() => { load(); }, [load]);

  const showCsv = canCsv();
  const csv = async () => {
    setCsvBusy(true); setCsvErr(null);
    try {
      const qs = new URLSearchParams();
      if (vcId) qs.set('vcenterId', vcId); if (sev) qs.set('sev', sev);
      await downloadFile(`/tools/contention.csv${qs.toString() ? `?${qs}` : ''}`);
    } catch (e) { setCsvErr(e); } finally { setCsvBusy(false); }
  };

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const k = data.kpi || {};
  const cov = data.coverage || {};
  const note = coverageNote(data);
  const miss = missingCounterNote(data.status);
  const vms = Array.isArray(data.vms) ? data.vms : [];
  const hosts = Array.isArray(data.hosts) ? data.hosts : [];
  const dss = Array.isArray(data.datastores) ? data.datastores : [];
  const win = windowText(data.scan);
  const T = data.thresholds || {};

  return (
    <div style={{ minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        켜진 VM 의 CPU 대기(Ready)·Co-stop·지연과 가상 디스크 지연을 봅니다. 값은 vCenter 실시간 통계의 {win} 평균(괄호는 그 창의 최대)이고, 수집 서버가 VM 마다 몇 분에 한 번 나눠 읽습니다 — 지난주 피크가 아닙니다.
      </div>
      {data.initial && <div className="banner" style={{ marginBottom: 8 }}>첫 수집 중입니다 — 목록이 아직 비어 있을 수 있습니다.</div>}
      {note && <div className="banner" style={{ marginBottom: 8 }}>{note}</div>}
      {miss && <div className="banner" style={{ marginBottom: 8 }}>{miss}</div>}
      {error && <div className="banner" style={{ marginBottom: 8 }}>다시 불러오지 못했습니다 — 이전 결과를 보여 줍니다.</div>}

      <div className="kpis" style={{ marginBottom: 10 }}>
        <div className="kpi"><div className="label">CPU 대기 위험</div><div className="value">{(k.readyCrit ?? 0).toLocaleString()}</div><div className="sub">Ready {T.readyCrit}% 이상 · 주의 {(k.readyWarn ?? 0).toLocaleString()}</div></div>
        <div className="kpi"><div className="label">Co-stop</div><div className="value">{(k.costop ?? 0).toLocaleString()}</div><div className="sub">{T.costopWarn}% 이상(vCPU 과다 후보)</div></div>
        <div className="kpi"><div className="label">디스크 지연 위험</div><div className="value">{(k.diskCrit ?? 0).toLocaleString()}</div><div className="sub">{T.diskCrit} ms 이상 · 주의 {(k.diskWarn ?? 0).toLocaleString()}</div></div>
        <div className="kpi"><div className="label">느린 데이터스토어</div><div className="value">{(k.dsSlow ?? 0).toLocaleString()}</div><div className="sub">호스트 보고 {T.diskWarn} ms 이상</div></div>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        측정한 켜진 VM {(cov.measured ?? 0).toLocaleString()} / {(cov.poweredOn ?? 0).toLocaleString()}대 · 측정한 호스트 {(cov.hostsMeasured ?? 0).toLocaleString()} / {(cov.hostsConnected ?? 0).toLocaleString()}대
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, alignItems: 'center' }}>
        <Chip active={tab === 'vms'} onClick={() => setTab('vms')}>VM <b>{(data.matched ?? 0).toLocaleString()}</b></Chip>
        <Chip active={tab === 'hosts'} onClick={() => setTab('hosts')}>경합 호스트 <b>{hosts.length.toLocaleString()}</b></Chip>
        <Chip active={tab === 'ds'} onClick={() => setTab('ds')}>데이터스토어 <b>{dss.length.toLocaleString()}</b></Chip>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10, alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 12 }}>vCenter</span>
        <Select className="input" style={{ minWidth: 0, maxWidth: 260 }} value={vcId} onChange={(e) => setVcId(e.target.value)}>
          <option value="">전체</option>
          {vcOpts.map((v) => <option key={v.vcenterId} value={v.vcenterId}>{v.name}</option>)}
        </Select>
        {tab === 'vms' && (
          <>
            <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>보기</span>
            <Chip active={sev === 'issue'} onClick={() => setSev('issue')}>문제 있는 VM</Chip>
            <Chip active={sev === 'cpu'} onClick={() => setSev('cpu')}>CPU</Chip>
            <Chip active={sev === 'disk'} onClick={() => setSev('disk')}>디스크</Chip>
            <Chip active={sev === ''} onClick={() => setSev('')}>측정한 전체</Chip>
          </>
        )}
        <input className="input" style={{ minWidth: 0, flex: '1 1 180px', maxWidth: 320 }} placeholder="VM·호스트·클러스터 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn" onClick={load} disabled={loading}>{loading ? '불러오는 중…' : '새로고침'}</button>
        {showCsv && <button type="button" className="btn" onClick={csv} disabled={csvBusy}>CSV</button>}
      </div>
      {csvErr && <ErrorBox error={csvErr} />}

      {tab === 'vms' && (
        <>
          <div className="card" style={{ padding: 0, minWidth: 0 }}>
            {vms.length === 0 ? (
              <div className="muted" style={{ padding: 16, fontSize: 13 }}>
                {(cov.measured ?? 0) === 0 ? '측정한 VM 이 아직 없습니다(위 안내를 보세요).' : sev ? '조건에 맞는 VM 이 없습니다 — 측정한 VM 에서 기준을 넘은 것이 없다는 뜻입니다.' : '조건에 맞는 VM 이 없습니다.'}
              </div>
            ) : (
              <div className="table-wrap" style={{ maxHeight: '70vh' }}><STable minWidth={1100} wrap={false}>
                <thead><tr><th>VM</th><th>호스트</th><th>vCPU</th><th>Ready %</th><th>Co-stop %</th><th>CPU 지연 %</th><th>디스크 읽기</th><th>디스크 쓰기</th><th>심각도</th><th>판정</th></tr></thead>
                <tbody>
                  {vms.map((r) => (
                    <tr key={r.id}>
                      <td style={{ minWidth: 140 }}><VmLink name={r.name} vcenterId={r.vcenterId} /><div className="muted" style={{ fontSize: 11 }}>{r.vcenterName}</div></td>
                      <td style={{ fontSize: 12 }}>{r.host || '—'}<div className="muted" style={{ fontSize: 11 }}>{r.cluster}</div></td>
                      <td data-sort={r.cpuCount ?? ''}>{r.cpuCount ?? '—'}</td>
                      <td data-sort={r.readyAvg ?? ''} title={r.readyMax != null ? `창 최대 ${r.readyMax}%` : ''}>{pctText(r.readyAvg)}</td>
                      <td data-sort={r.costopAvg ?? ''}>{pctText(r.costopAvg)}</td>
                      <td data-sort={r.latencyAvg ?? ''}>{pctText(r.latencyAvg)}</td>
                      <td data-sort={r.readAvg ?? ''}>{msText(r.readAvg)}</td>
                      <td data-sort={r.writeAvg ?? ''} title={r.disk ? `가장 느린 디스크 ${r.disk}` : ''}>{msText(r.writeAvg)}</td>
                      <td data-sort={r.sev ? SEV_SORT[r.sev] : ''}>{r.sev ? <span className={`badge ${SEV_BADGE[r.sev]}`}>{SEV_LABEL[r.sev]}</span> : <span className="muted">—</span>}</td>
                      <td style={{ whiteSpace: 'normal' }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {r.findings.map((f, i) => (
                            <span key={`${f.code}-${i}`} className={`badge ${SEV_BADGE[f.sev]}`} title={CONTENTION_TEXT[f.code]?.fix} style={{ whiteSpace: 'nowrap' }}>{CONTENTION_TEXT[f.code]?.title || f.code}</span>
                          ))}
                          {!r.findings.length && <span className="muted" style={{ fontSize: 12 }}>기준 미만</span>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </STable></div>
            )}
          </div>
          {data.omitted > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>심각도 순 상위 {vms.length.toLocaleString()}대만 표시했습니다 — {data.omitted.toLocaleString()}대는 검색으로 좁혀 보세요.</div>}
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            Ready·Co-stop 은 vCPU 1개당 %입니다(Ready {T.readyWarn}% 주의·{T.readyCrit}% 위험, Co-stop {T.costopWarn}% 주의 — 흔히 쓰는 관행 값). 디스크 지연은 그 VM 의 가상 디스크 중 가장 느린 것입니다. 배지에 마우스를 올리면 조치가 보입니다.
          </div>
        </>
      )}

      {tab === 'hosts' && (
        <>
          <div className="card" style={{ padding: 0, minWidth: 0 }}>
            {hosts.length === 0 ? (
              <div className="muted" style={{ padding: 16, fontSize: 13 }}>경합 VM 이 있거나 디스크 지연이 큰 호스트가 없습니다(측정한 호스트 기준).</div>
            ) : (
              <div className="table-wrap" style={{ maxHeight: '70vh' }}><STable minWidth={980} wrap={false}>
                <thead><tr><th>호스트</th><th>클러스터</th><th>CPU 사용률</th><th>경합 VM</th><th>가장 큰 Ready</th><th>최대 디스크 지연</th><th>같은 호스트의 사용량 상위 VM</th></tr></thead>
                <tbody>
                  {hosts.map((h) => (
                    <tr key={h.id}>
                      <td><b>{h.name}</b><div className="muted" style={{ fontSize: 11 }}>{h.vcenterName}</div></td>
                      <td className="muted" style={{ fontSize: 12 }}>{h.cluster}</td>
                      <td data-sort={h.cpuUsagePct ?? ''}>{pctText(h.cpuUsagePct)}</td>
                      <td data-sort={h.contended}>{h.contended} / {h.vmCount}</td>
                      <td data-sort={h.worstReady ?? ''}>{pctText(h.worstReady)}</td>
                      <td data-sort={h.diskMaxMs ?? ''}>{h.diskSev ? <span className={`badge ${SEV_BADGE[h.diskSev]}`}>{msText(h.diskMaxMs)}</span> : msText(h.diskMaxMs)}</td>
                      <td style={{ whiteSpace: 'normal', fontSize: 12 }}>
                        {h.neighbors.length ? h.neighbors.map((n) => `${n.name}(vCPU ${n.cpuCount} · ${n.cpuUsagePct}%)`).join(', ') : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </STable></div>
            )}
          </div>
          {data.hostsOmitted > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>호스트 {data.hostsOmitted.toLocaleString()}대는 표시하지 않았습니다(상한 300).</div>}
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            '같은 호스트의 사용량 상위 VM' 은 경합 VM 과 같은 호스트에서 CPU 를 많이 쓰는 VM 입니다(사용률 × vCPU 순) — 원인 후보일 뿐 원인으로 증명된 것은 아닙니다. 사용률은 인벤토리의 최근 값입니다.
          </div>
        </>
      )}

      {tab === 'ds' && (
        <>
          <div className="card" style={{ padding: 0, minWidth: 0 }}>
            {dss.length === 0 ? (
              <div className="muted" style={{ padding: 16, fontSize: 13 }}>데이터스토어 지연을 보고한 호스트가 아직 없습니다.</div>
            ) : (
              <div className="table-wrap" style={{ maxHeight: '70vh' }}><STable minWidth={760} wrap={false}>
                <thead><tr><th>데이터스토어</th><th>vCenter</th><th>종류</th><th>읽기 지연</th><th>쓰기 지연</th><th>가장 느린 호스트</th><th>보고 호스트</th></tr></thead>
                <tbody>
                  {dss.map((d) => (
                    <tr key={d.id}>
                      <td><b>{d.name}</b>{d.sev && <span className={`badge ${SEV_BADGE[d.sev]}`} style={{ marginLeft: 6 }}>{SEV_LABEL[d.sev]}</span>}</td>
                      <td className="muted" style={{ fontSize: 12 }}>{d.vcenterName}</td>
                      <td className="muted" style={{ fontSize: 12 }}>{d.type || '—'}</td>
                      <td data-sort={d.readAvg ?? ''}>{msText(d.readAvg)}</td>
                      <td data-sort={d.writeAvg ?? ''}>{msText(d.writeAvg)}</td>
                      <td style={{ fontSize: 12 }}>{d.worstHost || '—'}</td>
                      <td data-sort={d.hosts}>{d.hosts}</td>
                    </tr>
                  ))}
                </tbody>
              </STable></div>
            )}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            그 데이터스토어를 마운트한 호스트들이 보고한 값 중 가장 나쁜 값입니다(호스트마다 경로·큐가 달라 값이 다를 수 있습니다).
            {data.unmatchedDs > 0 ? ` 이름을 찾지 못한 데이터스토어 보고 ${data.unmatchedDs.toLocaleString()}건은 빠졌습니다.` : ''}
          </div>
        </>
      )}
    </div>
  );
}
