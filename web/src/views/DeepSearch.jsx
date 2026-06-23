import React, { useState } from 'react';
import { postJson, usePolling } from '../api.js';
import { VmLink, Loading } from '../components/ui.jsx';

const GPU_MODE = [['', '전체'], ['any', 'GPU 있음'], ['passthrough', '패스쓰루'], ['vgpu', 'vGPU'], ['none', 'GPU 없음']];

export default function DeepSearch() {
  const { data: vcs } = usePolling('/vcenters', {}, 60_000);
  const [scope, setScope] = useState(new Set()); // 빈 set = 전체
  const [f, setF] = useState({ q: '', gateway: '', ip: '', subnet: '', guestOS: '', powerState: '', toolsStatus: '', gpuMode: '', cluster: '', host: '', vcpuMin: '', ramMinGB: '', diskMinGB: '', cpuUsageMin: '', hasSnapshot: false, notes: '' });
  const [items, setItems] = useState(null);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  // 게스트 탐침
  const [probeType, setProbeType] = useState('gpuDriver');
  const [pattern, setPattern] = useState('');
  const [guest, setGuest] = useState({ user: '', pass: '', maxVms: 100 });
  const [probe, setProbe] = useState(null);
  const [probeBusy, setProbeBusy] = useState(false);

  const toggleVc = (id) => setScope((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const body = () => ({ vcenterIds: [...scope], filters: Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v !== false)) });

  const search = async () => {
    setBusy(true); setProbe(null);
    try { const r = await postJson('/tools/deep-search', body()); setItems(r.items || []); setTotal(r.total || 0); } catch { setItems([]); } finally { setBusy(false); }
  };
  const runProbe = async () => {
    setProbeBusy(true); setProbe(null);
    try { const r = await postJson('/admin/deep-search/probe', { ...body(), probe: { type: probeType, pattern }, guestUser: guest.user, guestPass: guest.pass, maxVms: Number(guest.maxVms) || 100 }); setProbe(r); } catch (e) { setProbe({ error: e.message }); } finally { setProbeBusy(false); }
  };

  const Field = ({ k, ph, w = 130 }) => <input className="input" placeholder={ph} style={{ width: w }} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />;
  const rows = probe?.matched || items;
  const VmTable = ({ list, evidence }) => (
    <div className="table-wrap" style={{ maxHeight: '46vh' }}>
      <table><thead><tr><th>VM</th><th>vCenter</th><th>호스트</th><th>Guest OS</th><th>IP</th><th>게이트웨이</th><th>GPU</th><th>전원</th>{evidence && <th>증거</th>}</tr></thead>
        <tbody>{(list || []).map((v) => (
          <tr key={v.id}>
            <td><VmLink name={v.name} vcenterId={v.vcenterId} ip={v.ipAddress} /></td>
            <td className="muted" style={{ fontSize: 12 }}>{v.vcenterId}</td>
            <td className="muted" style={{ fontSize: 12 }}>{v.host}</td>
            <td className="muted" style={{ fontSize: 12 }}>{v.guestOS}</td>
            <td style={{ fontSize: 12 }}>{(v.ipAddresses || []).slice(0, 2).join(', ')}</td>
            <td style={{ fontSize: 12 }}>{(v.gateways || []).join(', ') || '—'}</td>
            <td>{v.gpu ? <span className="badge amber">{v.gpu.type}</span> : <span className="muted">—</span>}</td>
            <td>{v.powerState === 'POWERED_ON' ? <span className="badge green">On</span> : <span className="badge gray">Off</span>}</td>
            {evidence && <td style={{ fontSize: 11, maxWidth: 280 }}><span className="muted">{v.evidence}</span></td>}
          </tr>
        ))}</tbody></table>
    </div>
  );

  return (
    <div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>다조건으로 VM을 검색합니다. 범위는 전체/특정/복수 vCenter. 게이트웨이·서브넷·OS·전원·GPU 등은 즉시 검색, GPU 드라이버·프로세스는 게스트 탐침(관리자).</p>

      {/* 범위 */}
      <div className="card" style={{ padding: 12, marginBottom: 10 }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>범위 ({scope.size === 0 ? '전체 vCenter' : `${scope.size}개 선택`})</div>
        <div className="flex gap wrap">
          <button className={scope.size === 0 ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 12px' }} onClick={() => setScope(new Set())}>전체</button>
          {(vcs || []).map((v) => <button key={v.id} className={scope.has(v.id) ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 12px' }} onClick={() => toggleVc(v.id)}>{v.name}</button>)}
        </div>
      </div>

      {/* 조건 */}
      <div className="card" style={{ padding: 14, marginBottom: 10 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 10 }}>
          <Field k="q" ph="이름/IP/OS/호스트" w={170} />
          <Field k="gateway" ph="게이트웨이 (예 192.168.10.1)" w={190} />
          <Field k="ip" ph="IP 시작" w={120} />
          <Field k="subnet" ph="서브넷 CIDR (10.0.0.0/8)" w={170} />
          <Field k="guestOS" ph="Guest OS 포함" w={130} />
          <select className="select" value={f.powerState} onChange={(e) => setF({ ...f, powerState: e.target.value })}><option value="">전원 전체</option><option value="POWERED_ON">On</option><option value="POWERED_OFF">Off</option></select>
          <select className="select" value={f.toolsStatus} onChange={(e) => setF({ ...f, toolsStatus: e.target.value })}><option value="">Tools 전체</option><option value="RUNNING">가동</option><option value="NOT_RUNNING">미실행</option></select>
          <select className="select" value={f.gpuMode} onChange={(e) => setF({ ...f, gpuMode: e.target.value })}>{GPU_MODE.map(([v, l]) => <option key={v} value={v}>{`GPU: ${l}`}</option>)}</select>
        </div>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 10, marginTop: 10 }}>
          <Field k="cluster" ph="클러스터" w={120} />
          <Field k="host" ph="호스트" w={120} />
          <span className="muted">vCPU≥</span><Field k="vcpuMin" ph="" w={56} />
          <span className="muted">RAM≥GB</span><Field k="ramMinGB" ph="" w={56} />
          <span className="muted">디스크≥GB</span><Field k="diskMinGB" ph="" w={64} />
          <span className="muted">CPU사용%≥</span><Field k="cpuUsageMin" ph="" w={56} />
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13, cursor: 'pointer' }}><input type="checkbox" checked={f.hasSnapshot} onChange={(e) => setF({ ...f, hasSnapshot: e.target.checked })} /> 스냅샷 있음</label>
          <button className="login-btn" style={{ padding: '8px 18px' }} disabled={busy} onClick={search}>{busy ? '검색 중…' : '🔍 검색'}</button>
        </div>
      </div>

      {/* 게스트 탐침 */}
      <div className="card" style={{ padding: 14, marginBottom: 10 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 10 }}>
          <span className="muted"><b>게스트 탐침</b></span>
          <select className="select" value={probeType} onChange={(e) => setProbeType(e.target.value)}><option value="gpuDriver">GPU 드라이버 설치</option><option value="process">프로세스 실행</option></select>
          {probeType === 'process' && <input className="input" placeholder="프로세스명/패턴 (예 nginx)" style={{ width: 200 }} value={pattern} onChange={(e) => setPattern(e.target.value)} />}
          <input className="input" placeholder="게스트 계정(선택)" style={{ width: 130 }} value={guest.user} onChange={(e) => setGuest({ ...guest, user: e.target.value })} />
          <input className="input" type="password" placeholder="비번(선택)" style={{ width: 120 }} value={guest.pass} onChange={(e) => setGuest({ ...guest, pass: e.target.value })} />
          <span className="muted">최대</span><input className="input" type="number" style={{ width: 64 }} value={guest.maxVms} onChange={(e) => setGuest({ ...guest, maxVms: e.target.value })} /><span className="muted">대</span>
          <button className="logout-btn" style={{ padding: '8px 16px' }} disabled={probeBusy} onClick={runProbe}>{probeBusy ? '탐침 중…' : '게스트 탐침 실행'}</button>
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>※ 위 조건으로 1차 필터된 VM(가동+Tools) 중에서 게스트 OS에 명령을 실행해 확인합니다. 게스트 계정 비우면 GPU 게스트 설정의 계정 사용.</div>
      </div>

      {probe && (probe.error ? <div className="badge red">{probe.error}</div> : (
        <div className="card" style={{ padding: 14, marginBottom: 10 }}>
          <div className="section-title" style={{ marginTop: 0, fontSize: 15 }}>게스트 탐침 결과 — 일치 {probe.matched.length} / 검사 {probe.checked} (후보 {probe.candidates})</div>
          {probe.matched.length > 0 && <VmTable list={probe.matched} evidence />}
          {(probe.errors || []).length > 0 && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>오류 {probe.errors.length}건: {probe.errors.slice(0, 3).map((e) => e.error).join(' · ')}…</div>}
        </div>
      ))}

      {!probe && items != null && (
        <div className="card" style={{ padding: 14 }}>
          <div className="section-title" style={{ marginTop: 0, fontSize: 15 }}>검색 결과 — {total.toLocaleString()}대{total > 2000 ? ' (상위 2000 표시)' : ''}</div>
          {busy ? <Loading /> : items.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>조건에 맞는 VM이 없습니다.</div> : <VmTable list={items} />}
        </div>
      )}
    </div>
  );
}
