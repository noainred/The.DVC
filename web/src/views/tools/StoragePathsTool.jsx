/**
 * 데이터스토어·경로 점검 — 특수 기능 `storage-paths`(v2.700). A17 데이터스토어 운영 · A2 멀티패스 · A19 vSAN.
 * ⚠ 판정은 서버(`server/src/dscfg/analyze.js`) — 이 화면은 조립만. 문구는 `views/dscfg/dsCfgText.js`·`views/hostcfg/hostCfgText.js`.
 * ⚠ 폴링하지 않는다(마운트 1회 + 새로고침) · 늦게 온 이전 응답은 버린다 · 훅은 전부 조기 return 위.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, downloadFile, canCsv } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { DS_TEXT, SEV_LABEL, SEV_BADGE, findingDetail, dsCoverageText, pathCoverageText, gbText } from '../dscfg/dsCfgText.js';
import Select from '../../components/Select.jsx';

const TABS = [['ds', '데이터스토어'], ['paths', '스토리지 경로'], ['vsan', 'vSAN']];

function Chip({ active, onClick, children, title }) {
  return (
    <button type="button" className={`tab${active ? ' active' : ''}`} onClick={onClick} title={title}
      style={{ whiteSpace: 'normal', maxWidth: '100%', textAlign: 'left', padding: '4px 10px', fontSize: 12 }}>{children}</button>
  );
}
function Badges({ findings }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {findings.map((f, i) => (
        <span key={`${f.code}-${i}`} className={`badge ${SEV_BADGE[f.sev]}`} title={[DS_TEXT[f.code]?.fix, findingDetail(f)].filter(Boolean).join(' · ')} style={{ whiteSpace: 'nowrap' }}>
          {DS_TEXT[f.code]?.title || f.code}
        </span>
      ))}
    </div>
  );
}

export default function StoragePathsTool({ scope }) {
  const [tab, setTab] = useState('ds');
  const [vcId, setVcId] = useState(scope || '');
  const [code, setCode] = useState('');
  const [onlyIssues, setOnlyIssues] = useState(true);
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
      if (qApplied) params.q = qApplied;
      if (onlyIssues) params.onlyIssues = '1';
      const d = await fetchJson('/tools/storage-paths', params);
      if (my !== gen.current) return;
      setData(d); setError(null);
    } catch (e) { if (my === gen.current) setError(e); } finally { if (my === gen.current) setLoading(false); }
  }, [vcId, code, qApplied, onlyIssues]);
  useEffect(() => { load(); }, [load]);

  const showCsv = canCsv();
  const csv = async () => {
    setCsvBusy(true); setCsvErr(null);
    try {
      const qs = new URLSearchParams();
      if (vcId) qs.set('vcenterId', vcId); if (code) qs.set('code', code); if (qApplied) qs.set('q', qApplied);
      await downloadFile(`/tools/storage-paths.csv${qs.toString() ? `?${qs}` : ''}`);
    } catch (e) { setCsvErr(e); } finally { setCsvBusy(false); }
  };

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const ds = data.datastores; const pth = data.paths; const vs = data.vsan;
  const dsChips = Object.entries(ds.byCode || {}).filter(([, v]) => v.count > 0);
  const policies = Object.entries(pth.policies || {}).sort((a, b) => b[1] - a[1]);

  return (
    <div style={{ minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        데이터스토어 운영(마운트·유지보수·씬 오버할당·VMFS 버전·SIOC·VM 수), 호스트별 스토리지 경로(죽은 경로·단일 경로 공유 LUN·경로 정책), vSAN(분할·디스크 문제·사용률)을 봅니다. 수집 서버가 나눠 읽은 값이고 vCenter 에 따로 묻지 않습니다.
      </div>
      {data.initial && <div className="banner" style={{ marginBottom: 8 }}>첫 수집 중입니다 — 목록이 아직 비어 있을 수 있습니다.</div>}
      {error && <div className="banner" style={{ marginBottom: 8 }}>다시 불러오지 못했습니다 — 이전 결과를 보여 줍니다.</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, alignItems: 'center' }}>
        {TABS.map(([k, l]) => <Chip key={k} active={tab === k} onClick={() => setTab(k)}>{l}</Chip>)}
        <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>vCenter</span>
        <Select className="input" style={{ minWidth: 0, maxWidth: 260 }} value={vcId} onChange={(e) => setVcId(e.target.value)}>
          <option value="">전체</option>
          {(data.vcenters || []).map((v) => <option key={v.vcenterId} value={v.vcenterId}>{v.name}</option>)}
        </Select>
        <input className="input" style={{ minWidth: 0, flex: '1 1 160px', maxWidth: 300 }} placeholder="이름·클러스터 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn" onClick={load} disabled={loading}>{loading ? '불러오는 중…' : '새로고침'}</button>
        {showCsv && tab === 'ds' && <button type="button" className="btn" onClick={csv} disabled={csvBusy}>CSV</button>}
      </div>
      {csvErr && <ErrorBox error={csvErr} />}

      {tab === 'ds' && (
        <>
          <div style={{ fontSize: 13, marginBottom: 6 }}>{dsCoverageText(ds.coverage)}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            <Chip active={!code} onClick={() => setCode('')}>전체 판정</Chip>
            {dsChips.map(([c, v]) => (
              <Chip key={c} active={code === c} onClick={() => setCode(code === c ? '' : c)} title={DS_TEXT[c]?.fix}>
                <span className={`badge ${SEV_BADGE[v.sev]}`} style={{ marginRight: 4 }}>{SEV_LABEL[v.sev]}</span>{DS_TEXT[c]?.title || c} <b>{v.count.toLocaleString()}</b>
              </Chip>
            ))}
          </div>
          <div className="card" style={{ padding: 0, minWidth: 0 }}>
            {ds.rows.length === 0 ? <div className="muted" style={{ padding: 16, fontSize: 13 }}>{ds.coverage.cfg === 0 ? '운영 속성을 읽은 데이터스토어가 아직 없습니다.' : '읽은 값에서 확인할 항목이 없습니다.'}</div> : (
              <STable minWidth={880}>
                <thead><tr><th>데이터스토어</th><th>vCenter</th><th>유형</th><th>용량</th><th>사용</th><th>미할당 약정</th><th>VM</th><th>판정</th></tr></thead>
                <tbody>
                  {ds.rows.map((r) => (
                    <tr key={r.id}>
                      <td style={{ minWidth: 160 }}><b>{r.name}</b>{r.inSdrs ? <span className="badge gray" style={{ marginLeft: 6 }}>SDRS</span> : null}</td>
                      <td className="muted" style={{ fontSize: 12 }}>{r.vcenterName}</td>
                      <td className="muted" style={{ fontSize: 12 }}>{r.type}{r.vmfsMajor ? ` ${r.vmfsMajor}` : ''}</td>
                      <td data-sort={r.capacityGB ?? ''}>{gbText(r.capacityGB)}</td>
                      <td data-sort={r.usedGB ?? ''}>{gbText(r.usedGB)}</td>
                      <td data-sort={r.uncommittedGB ?? ''}>{gbText(r.uncommittedGB)}</td>
                      <td data-sort={r.vmCount ?? ''}>{r.vmCount ?? '—'}</td>
                      <td style={{ whiteSpace: 'normal' }}><Badges findings={r.findings} /></td>
                    </tr>
                  ))}
                </tbody>
              </STable>
            )}
          </div>
          {ds.omitted > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{ds.omitted.toLocaleString()}개는 표시하지 않았습니다 — 조건으로 좁혀 보세요.</div>}
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>오버할당 = (사용 + 미할당 약정) ÷ 용량 ≥ {data.limits?.overcommitPct}% · VM 많음 = {data.limits?.manyVms}대 초과 · SDRS 표시는 상위 폴더 이름 규칙(group-p)으로 추정한 것입니다.</div>
        </>
      )}

      {tab === 'paths' && (
        <>
          <div style={{ fontSize: 13, marginBottom: 6 }}>{pathCoverageText(pth.coverage)} · 죽은 경로 {pth.totals.dead.toLocaleString()}개(호스트 {pth.totals.hostsDead}) · 단일 경로 공유 LUN {pth.totals.singlePath.toLocaleString()}개(호스트 {pth.totals.hostsSingle})</div>
          {policies.length > 0 && <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>경로 정책 분포: {policies.map(([k, n]) => `${k} ${n.toLocaleString()}`).join(' · ')}</div>}
          <label style={{ fontSize: 12, display: 'inline-flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
            <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} /> 문제가 있는 호스트만
          </label>
          <div className="card" style={{ padding: 0, minWidth: 0 }}>
            {pth.rows.length === 0 ? <div className="muted" style={{ padding: 16, fontSize: 13 }}>{pth.coverage.read === 0 ? '경로 정보를 읽은 호스트가 아직 없습니다(호스트당 6시간 주기로 나눠 읽습니다).' : onlyIssues ? '죽은 경로·단일 경로 공유 LUN 이 있는 호스트가 없습니다.' : '조건에 맞는 호스트가 없습니다.'}</div> : (
              <STable minWidth={820}>
                <thead><tr><th>호스트</th><th>vCenter</th><th>클러스터</th><th>LUN(공유)</th><th>경로</th><th>죽은 경로</th><th>단일 경로 LUN</th><th>대상 LUN</th></tr></thead>
                <tbody>
                  {pth.rows.map((r) => (
                    <tr key={r.id}>
                      <td><b>{r.name}</b></td>
                      <td className="muted" style={{ fontSize: 12 }}>{r.vcenterName}</td>
                      <td className="muted" style={{ fontSize: 12 }}>{r.cluster}</td>
                      <td data-sort={r.shared}>{r.luns} ({r.shared})</td>
                      <td data-sort={r.paths}>{r.paths}</td>
                      <td data-sort={r.dead}>{r.dead > 0 ? <span className="badge amber">{r.dead}</span> : 0}</td>
                      <td data-sort={r.singlePath}>{r.singlePath > 0 ? <span className="badge amber">{r.singlePath}</span> : 0}</td>
                      <td className="muted" style={{ fontSize: 11, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{[...(r.deadLuns || []), ...(r.singleLuns || [])].join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </STable>
            )}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>공유 LUN = FC·iSCSI·FCoE 경로가 있는 LUN 입니다(로컬 디스크의 단일 경로는 정상이라 세지 않습니다). 대상 LUN 은 호스트당 앞 10개까지 보입니다. 같은 클러스터에서 공유 LUN 수가 다른 호스트는 'ESXi 호스트 구성 점검' 의 드리프트에 나옵니다.</div>
        </>
      )}

      {tab === 'vsan' && (
        <>
          {vs.clusters.length === 0 && vs.datastores.length === 0 ? (
            <div className="muted" style={{ fontSize: 13 }}>{vs.unknownHosts > 0 ? `vSAN 이 켜진 호스트가 아직 확인되지 않았습니다(vSAN 정보를 아직 읽지 않은 호스트 ${vs.unknownHosts}대).` : 'vSAN 을 쓰는 클러스터가 없습니다.'}</div>
          ) : (
            <>
              <div className="card" style={{ padding: 0, minWidth: 0, marginBottom: 12 }}>
                <STable minWidth={640}>
                  <thead><tr><th>클러스터</th><th>vCenter</th><th>vSAN 호스트</th><th>보고된 멤버</th><th>디스크 문제</th><th>판정</th></tr></thead>
                  <tbody>
                    {vs.clusters.map((c) => (
                      <tr key={`${c.vcenterId}|${c.cluster}`}>
                        <td><b>{c.cluster}</b></td>
                        <td className="muted" style={{ fontSize: 12 }}>{c.vcenterName}</td>
                        <td data-sort={c.hosts}>{c.hosts}</td>
                        <td data-sort={c.minMembers ?? ''}>{c.minMembers ?? '—'}</td>
                        <td data-sort={c.diskIssues}>{c.diskIssues}</td>
                        <td style={{ whiteSpace: 'normal' }}>{c.findings.length ? <Badges findings={c.findings} /> : <span className="muted" style={{ fontSize: 12 }}>확인할 항목 없음</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </STable>
              </div>
              <div className="card" style={{ padding: 0, minWidth: 0 }}>
                <STable minWidth={560}>
                  <thead><tr><th>vSAN 데이터스토어</th><th>vCenter</th><th>용량</th><th>사용</th><th>사용률</th><th>판정</th></tr></thead>
                  <tbody>
                    {vs.datastores.map((d) => (
                      <tr key={d.id}>
                        <td><b>{d.name}</b></td>
                        <td className="muted" style={{ fontSize: 12 }}>{d.vcenterName}</td>
                        <td data-sort={d.capacityGB ?? ''}>{gbText(d.capacityGB)}</td>
                        <td data-sort={d.usedGB ?? ''}>{gbText(d.usedGB)}</td>
                        <td data-sort={d.usagePct ?? ''}>{d.usagePct == null ? '—' : `${d.usagePct}%`}</td>
                        <td style={{ whiteSpace: 'normal' }}>{d.findings.length ? <Badges findings={d.findings} /> : <span className="muted" style={{ fontSize: 12 }}>—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </STable>
              </div>
            </>
          )}
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>vSAN 판정은 호스트가 보고한 멤버 수·디스크 문제와 데이터스토어 사용률뿐입니다. 리싱크 진행·객체 상태·헬스 점수(vSAN 헬스 서비스)는 이 화면이 읽지 않습니다 — vCenter 의 vSAN 상태 화면에서 확인하세요.</div>
        </>
      )}
    </div>
  );
}
