import React, { useEffect, useState } from 'react';
import { fetchJson, usePolling, getToken } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

const DOT = { ok: '#22c55e', warn: '#f59e0b', down: '#ef4444', off: '#64748b', slow: '#f97316' };
const LBL = { ok: '정상', warn: '주의', down: '실패', off: '비활성', slow: '느림' };
const fmtAgo = (ts) => { if (!ts) return ''; const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? `${s}초 전` : s < 3600 ? `${Math.round(s / 60)}분 전` : `${Math.round(s / 3600)}시간 전`; };
const Dot = ({ s }) => <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: DOT[s] || '#64748b', boxShadow: s === 'ok' ? `0 0 6px ${DOT.ok}` : 'none', marginRight: 8 }} />;
const fmtBytes = (n) => { if (!n) return '0 B'; const u = ['B', 'KB', 'MB', 'GB']; let i = 0, v = n; while (v >= 1024 && i < 3) { v /= 1024; i++; } return `${v.toFixed(i ? 1 : 0)} ${u[i]}`; };

/* ───────── 다빈치 서비스 점검 ───────── */
export function ServiceCheck() {
  const { data, error, loading } = usePolling('/tools/service-check', {}, 15_000);
  if (error) return <ErrorBox message={error} />;
  if (loading && !data) return <Loading />;
  const sm = data.summary || {};
  return (
    <div>
      <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 10 }}>
        <div className="muted" style={{ fontSize: 13 }}>포탈 내부 서비스/수집기 상태를 한눈에 점검합니다(15초 자동 새로고침).</div>
        <span className={`badge ${data.overall === 'ok' ? 'green' : data.overall === 'warn' ? 'amber' : 'red'}`} style={{ fontSize: 13, padding: '4px 12px' }}>
          종합: {LBL[data.overall]} · 정상 {sm.ok} / 주의 {sm.warn} / 실패 {sm.down} / 비활성 {sm.off}
        </span>
      </div>
      <div className="vc-grid">
        {(data.checks || []).map((c) => (
          <div key={c.key} className="card" style={{ padding: 14, borderLeft: `3px solid ${DOT[c.status] || '#64748b'}` }}>
            <div className="flex between" style={{ alignItems: 'center' }}>
              <b style={{ fontSize: 14 }}><Dot s={c.status} />{c.label}</b>
              <span className="badge" style={{ background: 'transparent', color: DOT[c.status], fontSize: 12 }}>{LBL[c.status]}</span>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{c.detail}</div>
            {c.at && <div className="muted" style={{ fontSize: 11, marginTop: 4, opacity: 0.7 }}>{fmtAgo(c.at)}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────── 글로벌 네트워크 점검 ───────── */
export function NetworkCheck() {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const load = () => { setLoading(true); fetchJson('/tools/network-check').then((r) => { setD(r); setError(null); }).catch((e) => setError(e.message)).finally(() => setLoading(false)); };
  useEffect(() => { load(); }, []);
  if (error) return <ErrorBox message={error} />;
  if (loading && !d) return <Loading />;
  const sm = d.summary || {};
  const grade = (g, ms) => <span style={{ color: DOT[g] || '#94a3b8', fontWeight: 600 }}>{ms != null ? `${ms} ms` : '—'}</span>;
  return (
    <div>
      <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 10 }}>
        <div className="muted" style={{ fontSize: 13 }}>전세계 제어플레인(vCenter·NSX)의 중앙에서의 도달성·지연(TCP 443 RTT)을 측정합니다. 고RTT 사이트는 지연이 큽니다.</div>
        <button className="logout-btn" style={{ padding: '6px 12px', flex: 'none' }} disabled={loading} onClick={load}>{loading ? '점검 중…' : '↻ 다시 점검'}</button>
      </div>
      <div className="flex gap wrap" style={{ marginBottom: 12 }}>
        {[['엔드포인트', sm.endpoints], ['도달', sm.reachable, '#22c55e'], ['에이전트 경유', sm.viaAgent, '#f59e0b'], ['도달 불가', sm.unreachable, sm.unreachable ? '#ef4444' : '#22c55e'], ['평균 RTT', sm.avgRttMs != null ? `${sm.avgRttMs} ms` : '—'], ['네트워크 객체', sm.networks], ['NSX 세그먼트', sm.nsxSegments]].map(([l, v, c]) => (
          <div key={l} className="card" style={{ padding: '10px 14px', minWidth: 120 }}><div className="muted" style={{ fontSize: 11 }}>{l}</div><div style={{ fontSize: 20, fontWeight: 700, color: c || 'inherit' }}>{v ?? 0}</div></div>
        ))}
      </div>
      <div className="card" style={{ padding: 14 }}>
        <div className="table-wrap" style={{ maxHeight: '52vh' }}>
          <table><thead><tr><th>유형</th><th>이름</th><th>호스트</th><th>리전</th><th>도달성</th><th style={{ textAlign: 'right' }}>RTT</th><th>수집</th></tr></thead>
            <tbody>
              {(d.endpoints || []).map((e) => (
                <tr key={`${e.kind}:${e.id}`}>
                  <td><span className={`badge ${e.kind === 'nsx' ? 'purple' : 'blue'}`}>{e.kind === 'nsx' ? 'NSX' : 'vCenter'}</span></td>
                  <td><b>{e.name}</b></td>
                  <td className="muted" style={{ fontSize: 12 }}>{e.host}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{e.region || '—'}</td>
                  <td>{e.reachable ? <span className="badge green">도달</span> : e.viaAgent ? <span className="badge amber">에이전트 경유</span> : <span className="badge red">불가</span>}</td>
                  <td style={{ textAlign: 'right' }}>{grade(e.grade, e.rttMs)}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{e.collected || '—'}</td>
                </tr>
              ))}
            </tbody></table>
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>※ ‘에이전트 경유’ = 중앙에서 직접 443 도달은 안 되지만 현장 에이전트가 수집 중(정상). 사설망 vCenter에서 흔합니다.</div>
      </div>
    </div>
  );
}

/* ───────── 사이트 VMware 솔루션 구성 백업 ───────── */
export function VmwareConfigBackup() {
  const { data: vcs } = usePolling('/vcenters', {}, 60_000);
  const [vc, setVc] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const loadPreview = () => { setBusy('view'); fetchJson(`/tools/vmware-config${vc ? `?vcenterId=${encodeURIComponent(vc)}` : ''}`).then(setPreview).catch((e) => setMsg(e.message)).finally(() => setBusy('')); };
  useEffect(() => { loadPreview(); /* eslint-disable-next-line */ }, [vc]);
  const download = async () => {
    setBusy('dl'); setMsg(null);
    try {
      const url = `/api/tools/vmware-config?download=1${vc ? `&vcenterId=${encodeURIComponent(vc)}` : ''}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = res.headers.get('Content-Disposition')?.match(/filename="(.+?)"/)?.[1] || 'vmware-config.json.gz';
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      setMsg('다운로드 완료');
    } catch (e) { setMsg(`다운로드 오류: ${e.message}`); } finally { setBusy(''); }
  };
  const sites = preview?.sites || [];
  const total = sites.reduce((a, s) => ({ hosts: a.hosts + s.counts.hosts, vms: a.vms + s.counts.vms, ds: a.ds + s.counts.datastores, net: a.net + s.counts.networks }), { hosts: 0, vms: 0, ds: 0, net: 0 });
  return (
    <div style={{ maxWidth: 920 }}>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        포탈이 수집한 사이트의 <b>VMware 구성</b>(vCenter·ESXi 호스트·VM·데이터스토어·네트워크·NSX·알람)을 구조화해 내려받습니다.
        vCenter 자체 백업을 대체하지 않는 <b>구성 스냅샷</b>(문서화·DR 참고·감사용)입니다.
      </p>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 12 }}>
        <select className="select" value={vc} onChange={(e) => setVc(e.target.value)}>
          <option value="">전체 사이트</option>
          {(vcs || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <button className="login-btn" style={{ padding: '8px 16px' }} disabled={busy === 'dl'} onClick={download}>{busy === 'dl' ? '내보내는 중…' : '⬇ 구성 백업 다운로드 (.json.gz)'}</button>
        {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
      </div>
      <div className="flex gap wrap" style={{ marginBottom: 12 }}>
        {[['사이트', sites.length], ['호스트', total.hosts], ['VM', total.vms], ['데이터스토어', total.ds], ['네트워크', total.net]].map(([l, v]) => (
          <div key={l} className="card" style={{ padding: '10px 14px', minWidth: 110 }}><div className="muted" style={{ fontSize: 11 }}>{l}</div><div style={{ fontSize: 20, fontWeight: 700 }}>{v}</div></div>
        ))}
      </div>
      {sites.length > 0 && (
        <div className="card" style={{ padding: 14 }}>
          <div className="table-wrap" style={{ maxHeight: '44vh' }}>
            <table><thead><tr><th>vCenter</th><th>리전</th><th>버전</th><th style={{ textAlign: 'right' }}>호스트</th><th style={{ textAlign: 'right' }}>VM</th><th style={{ textAlign: 'right' }}>DS</th><th style={{ textAlign: 'right' }}>네트워크</th></tr></thead>
              <tbody>
                {sites.map((s) => (
                  <tr key={s.vcenter.id}>
                    <td><b>{s.vcenter.name}</b></td>
                    <td className="muted">{s.vcenter.region || '—'}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{s.vcenter.version || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{s.counts.hosts}</td>
                    <td style={{ textAlign: 'right' }}>{s.counts.vms}</td>
                    <td style={{ textAlign: 'right' }}>{s.counts.datastores}</td>
                    <td style={{ textAlign: 'right' }}>{s.counts.networks}</td>
                  </tr>
                ))}
              </tbody></table>
          </div>
          {preview?.nsx?.managers?.length > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>NSX: 매니저 {preview.nsx.managers.length} · 세그먼트 {preview.nsx.segments.length} · 게이트웨이 {preview.nsx.gateways.length} 포함</div>}
        </div>
      )}
    </div>
  );
}
