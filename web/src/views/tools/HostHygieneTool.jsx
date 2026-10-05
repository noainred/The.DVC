/**
 * ESXi 호스트 구성 점검 — 특수 기능 `host-hygiene`(v2.699). A1 보안 하드닝 · A9 클러스터 드리프트 · A11 재부팅 필요·빌드 · A12 인증서 만료.
 * ⚠ 판정은 서버(`server/src/hostcfg/analyze.js`) — 이 화면은 조립만. 문구는 `views/hostcfg/hostCfgText.js`.
 * ⚠ 폴링하지 않는다(마운트 1회 + 새로고침) · 늦게 온 이전 응답은 버린다(세대 번호) · 훅은 전부 조기 return 위(React #310).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, downloadFile, canCsv } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { HOST_CFG_TEXT, DRIFT_LABEL, SEV_LABEL, SEV_BADGE, codeChips, findingDetail, coverageText, coverageNote } from '../hostcfg/hostCfgText.js';

function Chip({ active, onClick, children, title }) {
  return (
    <button type="button" className={`tab${active ? ' active' : ''}`} onClick={onClick} title={title}
      style={{ whiteSpace: 'normal', maxWidth: '100%', textAlign: 'left', padding: '4px 10px', fontSize: 12 }}>{children}</button>
  );
}

function DriftPanel({ clusters, omitted }) {
  if (!clusters?.length) return null;
  return (
    <div className="card" style={{ marginTop: 12, minWidth: 0 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>클러스터 구성 드리프트 — 같은 클러스터에서 값이 다른 항목</div>
      <STable minWidth={640}>
        <thead><tr><th>클러스터</th><th>호스트</th><th>항목</th><th>값 분포(호스트 수)</th></tr></thead>
        <tbody>
          {clusters.flatMap((c) => Object.entries(c.fields).map(([f, v]) => (
            <tr key={`${c.vcenterId}|${c.cluster}|${f}`}>
              <td>{c.cluster}</td>
              <td data-sort={c.hosts}>{c.hosts}</td>
              <td>{DRIFT_LABEL[f] || f}</td>
              <td style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                {v.values.map((x) => `${x.value} (${x.count})`).join(' · ')}{v.majority == null ? ' — 다수값 없음' : ''}
              </td>
            </tr>
          )))}
        </tbody>
      </STable>
      {omitted > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>클러스터 {omitted.toLocaleString()}개는 표시하지 않았습니다(상한 200).</div>}
    </div>
  );
}

export default function HostHygieneTool({ scope }) {
  const [vcId, setVcId] = useState(scope || '');
  const [code, setCode] = useState('');
  const [sev, setSev] = useState('');
  const [q, setQ] = useState('');
  const [qApplied, setQApplied] = useState('');
  const [data, setData] = useState(null);
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
      if (code) params.code = code;
      if (sev) params.sev = sev;
      if (qApplied) params.q = qApplied;
      const d = await fetchJson('/tools/host-hygiene', params);
      if (my !== gen.current) return;
      setData(d); setError(null);
    } catch (e) { if (my === gen.current) setError(e); } finally { if (my === gen.current) setLoading(false); }
  }, [vcId, code, sev, qApplied]);
  useEffect(() => { load(); }, [load]);

  const showCsv = canCsv();
  const csv = async () => {
    setCsvBusy(true); setCsvErr(null);
    try {
      const qs = new URLSearchParams();
      if (vcId) qs.set('vcenterId', vcId); if (code) qs.set('code', code); if (sev) qs.set('sev', sev); if (qApplied) qs.set('q', qApplied);
      await downloadFile(`/tools/host-hygiene.csv${qs.toString() ? `?${qs}` : ''}`);
    } catch (e) { setCsvErr(e); } finally { setCsvBusy(false); }
  };

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const cov = data.coverage;
  const chips = codeChips(data.byCode);
  const vcs = Array.isArray(data.vcenters) ? data.vcenters : [];
  const note = coverageNote(cov, data.scan);
  const rows = Array.isArray(data.rows) ? data.rows : [];

  return (
    <div style={{ minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        ESXi 호스트 보안·구성(인증서 만료·재부팅 필요·SSH/Shell·NTP·syslog·허용 수준·계정 잠금·MOB·잠금 모드)과 클러스터 안 구성 드리프트를 한 표로 봅니다. 수집 서버가 호스트마다 몇 시간에 한 번 나눠 읽은 값입니다.
      </div>
      {data.initial && <div className="banner" style={{ marginBottom: 8 }}>첫 수집 중입니다 — 호스트 목록이 아직 비어 있을 수 있습니다.</div>}
      <div style={{ fontSize: 13, marginBottom: 6 }}>{coverageText(cov)}</div>
      {note && <div className="banner" style={{ marginBottom: 8 }}>{note}</div>}
      {error && <div className="banner" style={{ marginBottom: 8 }}>다시 불러오지 못했습니다 — 이전 결과를 보여 줍니다.</div>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 12 }}>vCenter</span>
        <select className="input" style={{ minWidth: 0, maxWidth: 260 }} value={vcId} onChange={(e) => setVcId(e.target.value)}>
          <option value="">전체</option>
          {vcs.map((v) => <option key={v.vcenterId} value={v.vcenterId}>{v.name} ({v.withFindings}/{v.hosts})</option>)}
        </select>
        <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>심각도</span>
        {['', 'crit', 'warn', 'info'].map((s) => <Chip key={s || 'all'} active={sev === s} onClick={() => setSev(s)}>{s ? SEV_LABEL[s] : '전체'}</Chip>)}
        <input className="input" style={{ minWidth: 0, flex: '1 1 180px', maxWidth: 320 }} placeholder="호스트·클러스터 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn" onClick={load} disabled={loading}>{loading ? '불러오는 중…' : '새로고침'}</button>
        {showCsv && <button type="button" className="btn" onClick={csv} disabled={csvBusy}>CSV</button>}
      </div>
      {csvErr && <ErrorBox error={csvErr} />}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
        <Chip active={!code} onClick={() => setCode('')}>전체 판정</Chip>
        {chips.map((c) => (
          <Chip key={c.code} active={code === c.code} onClick={() => setCode(code === c.code ? '' : c.code)} title={HOST_CFG_TEXT[c.code]?.fix}>
            <span className={`badge ${SEV_BADGE[c.sev]}`} style={{ marginRight: 4 }}>{SEV_LABEL[c.sev]}</span>{c.title} <b>{c.hosts.toLocaleString()}</b>
          </Chip>
        ))}
      </div>

      <div className="card" style={{ padding: 0, minWidth: 0 }}>
        {rows.length === 0 ? (
          <div className="muted" style={{ padding: 16, fontSize: 13 }}>
            {cov?.cfg === 0 ? '판정할 호스트가 아직 없습니다.' : (code || sev || qApplied) ? '조건에 맞는 호스트가 없습니다.' : '읽은 값에서 확인할 항목이 없습니다.'}
          </div>
        ) : (
          <STable minWidth={860}>
            <thead><tr><th>호스트</th><th>vCenter</th><th>클러스터</th><th>빌드</th><th>심각도</th><th>판정</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ minWidth: 150 }}><b>{r.name}</b></td>
                  <td className="muted" style={{ fontSize: 12 }}>{r.vcenterName}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{r.cluster}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{r.version ? (r.build ? `${r.version} (${r.build})` : r.version) : (r.build || '—')}</td>
                  <td data-sort={{ crit: 0, warn: 1, info: 2 }[r.sev]}><span className={`badge ${SEV_BADGE[r.sev]}`}>{SEV_LABEL[r.sev]}</span></td>
                  <td style={{ whiteSpace: 'normal' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {r.findings.map((f, i) => (
                        <span key={`${f.code}-${i}`} className={`badge ${SEV_BADGE[f.sev]}`} title={[HOST_CFG_TEXT[f.code]?.fix, findingDetail(f)].filter(Boolean).join(' · ')} style={{ whiteSpace: 'nowrap' }}>
                          {f.code === 'drift' ? `드리프트: ${DRIFT_LABEL[f.facts.field] || f.facts.field}` : (HOST_CFG_TEXT[f.code]?.title || f.code)}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </STable>
        )}
      </div>
      {data.omitted > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>심각도 순 상위 {rows.length.toLocaleString()}대만 표시했습니다 — {data.omitted.toLocaleString()}대는 조건으로 좁혀 보세요.</div>}
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>배지에 마우스를 올리면 조치와 근거가 보입니다. 호스트 상세(VM호스트 탭 › 호스트 클릭)의 '구성·보안' 칸에서 값을 볼 수 있습니다. 드리프트는 같은 클러스터에서 값을 아는 호스트끼리만 비교합니다(다수값이 없으면 어느 쪽이 옳다고 말하지 않습니다).</div>
      <DriftPanel clusters={data.clusters} omitted={data.clustersOmitted} />
    </div>
  );
}
