import React, { useEffect, useState } from 'react';
import { openRemoteSession } from '../remote/sessions.js';
import { fetchJson, postJson, delJson, getToken, usePolling } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

const PROTOCOLS = [['ssh', 'SSH'], ['rdp', 'RDP']];
const STATUS_BADGE = { active: 'green', manual: 'amber', pending: 'gray', error: 'red' };

/** 특수기능 → 원격 접속: 매핑 생성 + SSH/RDP 브라우저 접속. (중계서버 구성은 설정 → 중계 서버) */
export default function RemoteAccess() {
  const [data, setData] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [form, setForm] = useState({ name: '', vcenterId: '', protocol: 'ssh', targetHost: '', targetPort: '', publicPort: '' });
  const [vmQuery, setVmQuery] = useState('');
  const [vmList, setVmList] = useState([]);
  const [vmSel, setVmSel] = useState(null);
  const { data: vcList } = usePolling('/vcenters', {}, 60_000);

  const load = async () => {
    try { setData(await fetchJson('/remote/mappings')); setError(null); }
    catch (e) { setError(e.message); }
    fetchJson('/remote/config').then(() => setIsAdmin(true)).catch(() => setIsAdmin(false)); // 403 for non-admin
  };
  useEffect(() => { load(); }, []);

  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  const flash = (ok, text) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 4500); };

  const addMapping = async () => {
    const r = await postJson('/remote/mappings', form).catch((e) => ({ ok: false, reason: e.message }));
    if (r.ok) { setForm({ name: '', vcenterId: '', protocol: 'ssh', targetHost: '', targetPort: '', publicPort: '' }); await load(); flash(true, `매핑 생성 — 상태: ${r.mapping.status}`); }
    else flash(false, r.reason);
  };
  const remove = async (m) => {
    if (!window.confirm(`'${m.name}' 매핑을 삭제할까요? (HAProxy 설정에서도 제거)`)) return;
    await delJson(`/remote/mappings/${m.id}`).catch(() => {});
    await load();
  };
  const reapply = async (m) => {
    const r = await postJson(`/remote/mappings/${m.id}/apply`, {}).catch((e) => ({ ok: false, reason: e.message }));
    await load(); flash(r.ok, r.ok ? 'HAProxy에 적용했습니다.' : r.reason);
  };
  const searchVms = async () => {
    const r = await fetchJson(`/remote/targets${vmQuery ? `?q=${encodeURIComponent(vmQuery)}` : ''}`).catch(() => ({ targets: [] }));
    setVmList(r.targets); setVmSel(null);
  };
  const pickVm = (id) => {
    const vm = vmList.find((v) => v.id === id) || null;
    setVmSel(vm);
    setForm((f) => ({
      ...f,
      targetHost: vm && vm.ips.length === 1 ? vm.ips[0] : '',
      vcenterId: f.vcenterId || (vm ? vm.vcenterId : ''),
      name: f.name || (vm ? `${f.protocol.toUpperCase()} ${vm.name}` : ''),
    }));
  };
  const downloadRdp = async (m) => {
    const res = await fetch(`/api/remote/rdp/${m.id}`, { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} });
    const blob = await res.blob(); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${m.name}.rdp`; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <>
      {msg && (
        <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13,
          background: msg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)', color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.text}</div>
      )}

      {isAdmin && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="flex between wrap" style={{ alignItems: 'center' }}>
            <b style={{ fontSize: 14 }}>대상 추가 (SSH/RDP)</b>
            <span className="muted" style={{ fontSize: 12 }}>중계 서버(HAProxy) 구성은 설정 → 중계 서버</span>
          </div>
          <div className="card" style={{ margin: '8px 0', padding: '10px 12px', background: 'rgba(255,255,255,.02)' }}>
            <div className="flex gap wrap" style={{ alignItems: 'flex-end' }}>
              <label style={{ flex: 1, minWidth: 200 }}>vCenter VM에서 선택 (이름/IP 검색)
                <input className="input" value={vmQuery} onChange={(e) => setVmQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && searchVms()} placeholder="vm 이름 또는 IP" />
              </label>
              <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={searchVms}>검색</button>
            </div>
            {vmList.length > 0 && (
              <div className="flex gap wrap" style={{ marginTop: 8 }}>
                <label style={{ flex: 1, minWidth: 220 }}>VM ({vmList.length})
                  <select className="select" value={vmSel?.id || ''} onChange={(e) => pickVm(e.target.value)}>
                    <option value="">— VM 선택 —</option>
                    {vmList.map((v) => <option key={v.id} value={v.id}>{v.name} · {v.ips.length} IP · {v.powerState === 'POWERED_ON' ? 'On' : 'Off'}</option>)}
                  </select>
                </label>
                {vmSel && (
                  <label style={{ flex: 1, minWidth: 200 }}>IP 선택 ({vmSel.ips.length})
                    <select className="select" value={form.targetHost} onChange={(e) => setForm({ ...form, targetHost: e.target.value })}>
                      <option value="">— IP 선택 —</option>
                      {vmSel.ips.map((ip) => <option key={ip} value={ip}>{ip}</option>)}
                    </select>
                  </label>
                )}
              </div>
            )}
          </div>
          <div className="spec-grid" style={{ marginTop: 8 }}>
            <label>이름<input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="esxi-jump" /></label>
            <label>프로토콜
              <select className="select" value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value })}>
                {PROTOCOLS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label>대상 호스트(IP)<input className="input" value={form.targetHost} onChange={(e) => setForm({ ...form, targetHost: e.target.value })} placeholder="VM 선택 또는 직접 입력" /></label>
            <label>대상 포트(보안상 22/3389 아닐 수 있음)<input className="input" type="number" value={form.targetPort} onChange={(e) => setForm({ ...form, targetPort: e.target.value })} placeholder={form.protocol === 'rdp' ? '3389' : '22'} /></label>
            <label>법인(vCenter, 선택)
              <select className="select" value={form.vcenterId} onChange={(e) => setForm({ ...form, vcenterId: e.target.value })}>
                <option value="">— 선택 —</option>
                {(vcList || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </label>
            <label>공개 포트(비우면 자동)<input className="input" type="number" value={form.publicPort} onChange={(e) => setForm({ ...form, publicPort: e.target.value })} placeholder="자동" /></label>
          </div>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 16px', marginTop: 10 }} disabled={!form.targetHost} onClick={addMapping}>추가 + HAProxy 적용</button>
        </div>
      )}

      <div className="section-title" style={{ marginTop: 0 }}>접속 대상</div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>이름</th><th>프로토콜</th><th>대상</th><th>프록시</th><th>공개 포트</th><th>상태</th><th style={{ textAlign: 'right' }}>접속</th></tr></thead>
          <tbody>
            {data.mappings.length === 0 && <tr><td colSpan={7} className="center muted" style={{ padding: 26 }}>등록된 대상이 없습니다.</td></tr>}
            {data.mappings.map((m) => (
              <tr key={m.id}>
                <td><b>{m.name}</b>{m.vcenterId && <span className="muted" style={{ fontSize: 11 }}> · {m.vcenterId}</span>}</td>
                <td><span className="badge blue">{m.protocol.toUpperCase()}</span></td>
                <td>{m.targetHost}:{m.targetPort}</td>
                <td className="muted" style={{ fontSize: 12 }}>{m.proxyName || '기본'}</td>
                <td>{m.proxyHost ? `${m.proxyHost}:${m.publicPort}` : m.publicPort}</td>
                <td><span className={`badge ${STATUS_BADGE[m.status] || 'gray'}`}>{m.status}</span></td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {m.protocol === 'ssh'
                    ? <button className="login-btn" style={{ flex: 'none', padding: '6px 12px' }} onClick={() => openRemoteSession({ kind: 'ssh', mapping: m })}>SSH 터미널</button>
                    : (m.guacdConfigured
                        ? <><button className="login-btn" style={{ flex: 'none', padding: '6px 12px' }} onClick={() => openRemoteSession({ kind: 'rdp', mapping: m })}>웹 RDP</button>{' '}<button className="logout-btn" style={{ padding: '6px 10px' }} onClick={() => downloadRdp(m)}>.rdp</button></>
                        : <button className="login-btn" style={{ flex: 'none', padding: '6px 12px' }} onClick={() => downloadRdp(m)}>.rdp 다운로드</button>)}
                  {isAdmin && <> {' '}
                    {m.status === 'error' && <button className="logout-btn" style={{ padding: '6px 10px' }} onClick={() => reapply(m)}>재적용</button>}
                    {' '}<button className="logout-btn" style={{ padding: '6px 10px' }} onClick={() => remove(m)}>삭제</button>
                  </>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="muted" style={{ fontSize: 12, marginTop: 12, lineHeight: 1.7 }}>
        포탈이 프록시(HAProxy)에 <b>공개 포트 → 대상:포트</b> TCP 매핑을 만들고, 사용자는 <b>프록시주소:공개포트</b>로 접속합니다.
        SSH는 브라우저 내장 터미널, RDP는 .rdp 파일(또는 guacd 구성 시 웹 콘솔)로 연결됩니다.
      </div>
    </>
  );
}
