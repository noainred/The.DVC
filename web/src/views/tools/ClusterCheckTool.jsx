/**
 * 클러스터 HA·DRS 점검 — 특수 기능 `cluster-check`(v2.701 — A6). HA·수용 제어·호스트 모니터링·DRS·유효 호스트·선호도 규칙·EVC.
 * ⚠ 판정은 서버(`server/src/clustercfg/analyze.js`) — 이 화면은 조립만. 문구는 `views/clustercfg/clusterCfgText.js`.
 * ⚠ 폴링하지 않는다(마운트 1회 + 새로고침) · 늦게 온 이전 응답은 버린다(세대 번호) · 훅은 전부 조기 return 위(React #310).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, downloadFile, canCsv } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import {
  CLUSTER_TEXT, SEV_LABEL, SEV_BADGE, RULE_TYPE_LABEL, codeChips, findingDetail, coverageText, coverageNote, haText, drsText, evcText,
} from '../clustercfg/clusterCfgText.js';
import Select from '../../components/Select.jsx';
import { mergeVcChoices } from './vcChoices.js';

function Chip({ active, onClick, children, title }) {
  return (
    <button type="button" className={`tab${active ? ' active' : ''}`} onClick={onClick} title={title}
      style={{ whiteSpace: 'normal', maxWidth: '100%', textAlign: 'left', padding: '4px 10px', fontSize: 12 }}>{children}</button>
  );
}

function RulesCell({ row }) {
  if (!row.collected) return <span className="muted">—</span>;
  if (!row.rules.length) return <span className="muted">{row.rulesTotal ? `${row.rulesTotal}개` : '없음'}</span>;
  const more = (row.rulesTotal ?? row.rules.length) - row.rules.length;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {row.rules.slice(0, 6).map((r, i) => {
        const bad = r.enabled === true && r.inCompliance === false;
        return (
          <span key={`${r.name}-${i}`} className={`badge ${bad ? 'amber' : r.enabled === false ? 'gray' : 'blue'}`} style={{ whiteSpace: 'nowrap' }}
            title={`${RULE_TYPE_LABEL[r.type] || r.type} · VM ${r.vmCount}대${r.mandatory ? ' · 필수' : ''}${r.enabled === false ? ' · 꺼짐' : bad ? ' · 지켜지지 않음' : ''}`}>
            {r.name}{bad ? ' ⚠' : r.enabled === false ? ' (꺼짐)' : ''}
          </span>
        );
      })}
      {row.rules.length > 6 && <span className="muted" style={{ fontSize: 12 }}>외 {row.rules.length - 6}개</span>}
      {more > 0 && <span className="muted" style={{ fontSize: 12 }} title="규칙 목록은 클러스터당 50개까지 싣습니다">· 목록 밖 {more}개</span>}
    </div>
  );
}

export default function ClusterCheckTool({ scope }) {
  const [vcId, setVcId] = useState(scope || '');
  const [code, setCode] = useState('');
  const [sev, setSev] = useState('');
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
      if (code) params.code = code;
      if (sev) params.sev = sev;
      if (qApplied) params.q = qApplied;
      const d = await fetchJson('/tools/cluster-check', params);
      if (my !== gen.current) return;
      setData(d); setError(null);
      setVcOpts((prev) => mergeVcChoices(prev, d?.vcenters, params.vcenterId));
    } catch (e) { if (my === gen.current) setError(e); } finally { if (my === gen.current) setLoading(false); }
  }, [vcId, code, sev, qApplied]);
  useEffect(() => { load(); }, [load]);

  const showCsv = canCsv();
  const csv = async () => {
    setCsvBusy(true); setCsvErr(null);
    try {
      const qs = new URLSearchParams();
      if (vcId) qs.set('vcenterId', vcId); if (code) qs.set('code', code); if (sev) qs.set('sev', sev); if (qApplied) qs.set('q', qApplied);
      await downloadFile(`/tools/cluster-check.csv${qs.toString() ? `?${qs}` : ''}`);
    } catch (e) { setCsvErr(e); } finally { setCsvBusy(false); }
  };

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const cov = data.coverage;
  const chips = codeChips(data.byCode);
  const note = coverageNote(cov, data.scan);
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const t = data.totals || {};

  return (
    <div style={{ minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        클러스터마다 vSphere HA(수용 제어·호스트 모니터링)·DRS·유효 호스트 수·선호도 규칙 준수·EVC 를 한 표로 봅니다. 수집 서버가 클러스터 구성을 주기적으로 나눠 읽은 값입니다(vCenter 왕복 없음).
      </div>
      {data.initial && <div className="banner" style={{ marginBottom: 8 }}>첫 수집 중입니다 — 클러스터 목록이 아직 비어 있을 수 있습니다.</div>}
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        {coverageText(cov)}
        {cov?.cfg > 0 && ` · HA 켜짐 ${t.haOn ?? 0} / 꺼짐 ${t.haOff ?? 0} · DRS 켜짐 ${t.drsOn ?? 0} / 꺼짐 ${t.drsOff ?? 0} · 규칙 ${t.rules ?? 0}개(위반 ${t.rulesViolated ?? 0})`}
      </div>
      {note && <div className="banner" style={{ marginBottom: 8 }}>{note}</div>}
      {error && <div className="banner" style={{ marginBottom: 8 }}>다시 불러오지 못했습니다 — 이전 결과를 보여 줍니다.</div>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 12 }}>vCenter</span>
        <Select className="input" style={{ minWidth: 0, maxWidth: 260 }} value={vcId} onChange={(e) => setVcId(e.target.value)}>
          <option value="">전체</option>
          {vcOpts.map((v) => <option key={v.vcenterId} value={v.vcenterId}>{v.name} ({v.withFindings}/{v.clusters})</option>)}
        </Select>
        <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>심각도</span>
        {['', 'warn', 'info'].map((s) => <Chip key={s || 'all'} active={sev === s} onClick={() => setSev(s)}>{s ? SEV_LABEL[s] : '전체'}</Chip>)}
        <input className="input" style={{ minWidth: 0, flex: '1 1 180px', maxWidth: 320 }} placeholder="클러스터·vCenter 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn" onClick={load} disabled={loading}>{loading ? '불러오는 중…' : '새로고침'}</button>
        {showCsv && <button type="button" className="btn" onClick={csv} disabled={csvBusy}>CSV</button>}
      </div>
      {csvErr && <ErrorBox error={csvErr} />}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
        <Chip active={!code} onClick={() => setCode('')}>전체 판정</Chip>
        {chips.map((c) => (
          <Chip key={c.code} active={code === c.code} onClick={() => setCode(code === c.code ? '' : c.code)} title={CLUSTER_TEXT[c.code]?.fix}>
            <span className={`badge ${SEV_BADGE[c.sev]}`} style={{ marginRight: 4 }}>{SEV_LABEL[c.sev]}</span>{c.title} <b>{c.clusters.toLocaleString()}</b>
          </Chip>
        ))}
      </div>

      <div className="card" style={{ padding: 0, minWidth: 0 }}>
        {rows.length === 0 ? (
          <div className="muted" style={{ padding: 16, fontSize: 13 }}>
            {cov?.clusters === 0 ? '클러스터가 없습니다.' : (code || sev || qApplied) ? '조건에 맞는 클러스터가 없습니다.' : '표시할 클러스터가 없습니다.'}
          </div>
        ) : (
          <STable minWidth={1100}>
            <thead><tr><th>클러스터</th><th>vCenter</th><th>호스트</th><th>vSphere HA</th><th>DRS</th><th>EVC</th><th>선호도 규칙</th><th>판정</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.vcenterId}|${r.name}`}>
                  <td style={{ minWidth: 140 }}><b>{r.name}</b></td>
                  <td className="muted" style={{ fontSize: 12 }}>{r.vcenterName}</td>
                  <td data-sort={r.hosts}>
                    {r.numHosts != null && r.numEffectiveHosts != null && r.numEffectiveHosts < r.numHosts ? `${r.numEffectiveHosts} / ${r.numHosts}` : r.hosts}
                    {r.hostsDisconnected > 0 && <span className="muted" style={{ fontSize: 11, display: 'block' }}>끊김 {r.hostsDisconnected}</span>}
                  </td>
                  <td style={{ whiteSpace: 'normal', fontSize: 12 }}>{r.collected ? haText(r.ha) : <span className="muted">아직 안 읽음</span>}</td>
                  <td style={{ whiteSpace: 'normal', fontSize: 12 }}>{r.collected ? drsText(r.drs) : '—'}</td>
                  <td style={{ fontSize: 12 }}>{r.collected ? evcText(r.evc) : '—'}</td>
                  <td style={{ whiteSpace: 'normal', minWidth: 180 }}><RulesCell row={r} /></td>
                  <td data-sort={r.sev ? { crit: 0, warn: 1, info: 2 }[r.sev] : 9} style={{ whiteSpace: 'normal' }}>
                    {r.findings.length === 0 ? <span className="muted" style={{ fontSize: 12 }}>{r.collected ? '확인할 항목 없음' : '판정 안 함'}</span> : (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {r.findings.map((f, i) => (
                          <span key={`${f.code}-${i}`} className={`badge ${SEV_BADGE[f.sev]}`} title={[CLUSTER_TEXT[f.code]?.fix, findingDetail(f)].filter(Boolean).join(' · ')} style={{ whiteSpace: 'nowrap' }}>
                            {CLUSTER_TEXT[f.code]?.title || f.code}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </STable>
        )}
      </div>
      {data.omitted > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>심각도 순 상위 {rows.length.toLocaleString()}개만 표시했습니다 — {data.omitted.toLocaleString()}개는 조건으로 좁혀 보세요.</div>}
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>배지에 마우스를 올리면 조치와 근거가 보입니다. VM·호스트 상세 창에도 그 VM·호스트가 속한 클러스터의 HA·DRS 상태와 VM 이 들어 있는 선호도 규칙이 보입니다. 호스트 네트워크(업링크 이중화·무차별 모드·포트그룹 드리프트)는 'ESXi 호스트 구성 점검' 에서 봅니다.</div>
    </div>
  );
}
