import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import Guacamole from 'guacamole-common-js';
import '@xterm/xterm/css/xterm.css';
import { fetchJson, postJson, putJson, delJson, getToken } from '../api.js';
import { Loading, ErrorBox, Modal } from '../components/ui.jsx';

const PROTOCOLS = [['ssh', 'SSH'], ['rdp', 'RDP']];
const STATUS_BADGE = { active: 'green', manual: 'amber', pending: 'gray', error: 'red' };

/** 특수기능 → 원격 접속: HAProxy(Data Plane) 매핑으로 SSH/RDP 브라우저 접속. */
export default function RemoteAccess() {
  const [data, setData] = useState(null);
  const [cfg, setCfg] = useState(null);   // admin only (null if not admin)
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [ssh, setSsh] = useState(null);   // mapping for SSH terminal modal
  const [rdp, setRdp] = useState(null);   // mapping for RDP web console modal
  const [form, setForm] = useState({ name: '', vcenterId: '', protocol: 'ssh', targetHost: '', targetPort: '', publicPort: '' });
  const [vmQuery, setVmQuery] = useState('');
  const [vmList, setVmList] = useState([]);
  const [vmSel, setVmSel] = useState(null); // selected VM (with its IPs)

  const load = async () => {
    try { setData(await fetchJson('/remote/mappings')); setError(null); }
    catch (e) { setError(e.message); }
    fetchJson('/remote/config').then((r) => setCfg(r.config)).catch(() => setCfg(null)); // 403 for non-admin
  };
  useEffect(() => { load(); }, []);

  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  const isAdmin = !!cfg;
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
  const saveCfg = async () => {
    const r = await putJson('/remote/config', cfg).catch((e) => ({ ok: false }));
    if (r.config) setCfg(r.config); flash(!!r.config, r.config ? '설정을 저장했습니다.' : '저장 실패');
    await load();
  };
  const testDp = async () => {
    const r = await postJson('/remote/test', { dataplane: cfg.dataplane }).catch((e) => ({ ok: false, reason: e.message }));
    flash(r.ok, r.ok ? `Data Plane 연결 성공 (${r.ms}ms)` : `실패: ${r.reason}`);
  };
  const testDeploy = async () => {
    const r = await postJson('/remote/deploy/test', { deploy: cfg.deploy }).catch((e) => ({ ok: false, reason: e.message }));
    flash(r.ok, r.ok ? `SSH 접속 성공 · ${r.haproxy || ''} · cfg ${r.configReadable ? '읽기OK' : '없음'}` : `실패: ${r.reason}`);
  };
  const deployNow = async () => {
    if (!window.confirm('현재 모든 매핑을 프록시 HAProxy 설정으로 배포하고 reload할까요?')) return;
    const r = await postJson('/remote/deploy', {}).catch((e) => ({ ok: false, reason: e.message }));
    await load(); flash(r.ok, r.ok ? `배포 완료 — ${r.deployed}개 적용, 백업 ${r.backup}` : `배포 실패: ${r.reason}`);
  };
  const searchVms = async () => {
    const r = await fetchJson(`/remote/targets${vmQuery ? `?q=${encodeURIComponent(vmQuery)}` : ''}`).catch(() => ({ targets: [] }));
    setVmList(r.targets); setVmSel(null);
  };
  const pickVm = (id) => {
    const vm = vmList.find((v) => v.id === id) || null;
    setVmSel(vm);
    // auto-fill: single IP → use it; also seed name/vcenter if empty
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
          <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
            <b style={{ fontSize: 14 }}>HAProxy Data Plane API</b>
            <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
              <input type="checkbox" checked={!!cfg.dataplane.enabled} onChange={(e) => setCfg({ ...cfg, dataplane: { ...cfg.dataplane, enabled: e.target.checked } })} /> 사용
            </label>
          </div>
          <div className="spec-grid">
            <label>Data Plane URL<input className="input" value={cfg.dataplane.url} onChange={(e) => setCfg({ ...cfg, dataplane: { ...cfg.dataplane, url: e.target.value } })} placeholder="http://proxy:5555" /></label>
            <label>basePath<input className="input" value={cfg.dataplane.basePath} onChange={(e) => setCfg({ ...cfg, dataplane: { ...cfg.dataplane, basePath: e.target.value } })} placeholder="/v3" /></label>
            <label>사용자<input className="input" value={cfg.dataplane.username} onChange={(e) => setCfg({ ...cfg, dataplane: { ...cfg.dataplane, username: e.target.value } })} /></label>
            <label>비밀번호<input className="input" type="password" value={cfg.dataplane.password} onChange={(e) => setCfg({ ...cfg, dataplane: { ...cfg.dataplane, password: e.target.value } })} placeholder="********" /></label>
            <label>프록시 공개 주소(사용자 접속/SSH 게이트웨이)<input className="input" value={cfg.proxyHost} onChange={(e) => setCfg({ ...cfg, proxyHost: e.target.value })} placeholder="proxy.corp.com" /></label>
            <label>공개 포트 시작<input className="input" type="number" value={cfg.publicPortBase} onChange={(e) => setCfg({ ...cfg, publicPortBase: Number(e.target.value) })} /></label>
            <label>guacd 호스트(RDP 웹콘솔, 선택)<input className="input" value={cfg.guacd.host} onChange={(e) => setCfg({ ...cfg, guacd: { ...cfg.guacd, host: e.target.value } })} placeholder="(없으면 .rdp 다운로드)" /></label>
            <label>guacd 포트<input className="input" type="number" value={cfg.guacd.port} onChange={(e) => setCfg({ ...cfg, guacd: { ...cfg.guacd, port: Number(e.target.value) } })} /></label>
          </div>
          <div className="flex gap" style={{ marginTop: 10 }}>
            <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={saveCfg}>저장</button>
            <button className="logout-btn" style={{ padding: '8px 14px' }} onClick={testDp}>연결 테스트</button>
          </div>
        </div>
      )}

      {isAdmin && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
            <b style={{ fontSize: 14 }}>SSH 자동배포 (Data Plane 미사용 환경)</b>
            <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
              <input type="checkbox" checked={!!cfg.deploy.enabled} onChange={(e) => setCfg({ ...cfg, deploy: { ...cfg.deploy, enabled: e.target.checked } })} /> 사용
            </label>
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>프록시 서버에 SSH로 접속해 haproxy.cfg의 관리 블록을 갱신하고 검증(haproxy -c) 후 reload합니다. 원본은 자동 백업됩니다.</div>
          <div className="spec-grid">
            <label>SSH 호스트<input className="input" value={cfg.deploy.host} onChange={(e) => setCfg({ ...cfg, deploy: { ...cfg.deploy, host: e.target.value } })} placeholder="proxy.corp.com" /></label>
            <label>포트<input className="input" type="number" value={cfg.deploy.port} onChange={(e) => setCfg({ ...cfg, deploy: { ...cfg.deploy, port: Number(e.target.value) } })} /></label>
            <label>사용자<input className="input" value={cfg.deploy.username} onChange={(e) => setCfg({ ...cfg, deploy: { ...cfg.deploy, username: e.target.value } })} placeholder="root" /></label>
            <label>비밀번호<input className="input" type="password" value={cfg.deploy.password} onChange={(e) => setCfg({ ...cfg, deploy: { ...cfg.deploy, password: e.target.value } })} placeholder="********" /></label>
            <label style={{ gridColumn: '1 / -1' }}>개인키(PEM, 선택 — 입력 시 비밀번호 대신 사용)<textarea className="input" rows={2} value={cfg.deploy.privateKey} onChange={(e) => setCfg({ ...cfg, deploy: { ...cfg.deploy, privateKey: e.target.value } })} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 11 }} /></label>
            <label>haproxy.cfg 경로<input className="input" value={cfg.deploy.haproxyConfigPath} onChange={(e) => setCfg({ ...cfg, deploy: { ...cfg.deploy, haproxyConfigPath: e.target.value } })} /></label>
            <label>reload 명령<input className="input" value={cfg.deploy.reloadCmd} onChange={(e) => setCfg({ ...cfg, deploy: { ...cfg.deploy, reloadCmd: e.target.value } })} /></label>
            <label style={{ gridColumn: '1 / -1' }}>검증 명령 ({'{file}'} = 임시 파일)<input className="input" value={cfg.deploy.validateCmd} onChange={(e) => setCfg({ ...cfg, deploy: { ...cfg.deploy, validateCmd: e.target.value } })} /></label>
          </div>
          <div className="flex gap" style={{ marginTop: 10 }}>
            <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={saveCfg}>저장</button>
            <button className="logout-btn" style={{ padding: '8px 14px' }} onClick={testDeploy}>SSH 테스트</button>
            <button className="logout-btn" style={{ padding: '8px 14px' }} onClick={deployNow}>지금 배포 + reload</button>
          </div>
        </div>
      )}

      {isAdmin && (
        <div className="card" style={{ marginBottom: 14 }}>
          <b style={{ fontSize: 14 }}>대상 추가 (SSH/RDP)</b>
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
            <label>법인(vCenter ID, 선택)<input className="input" value={form.vcenterId} onChange={(e) => setForm({ ...form, vcenterId: e.target.value })} placeholder="vc-ap-southeast" /></label>
            <label>공개 포트(비우면 자동)<input className="input" type="number" value={form.publicPort} onChange={(e) => setForm({ ...form, publicPort: e.target.value })} placeholder="자동" /></label>
          </div>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 16px', marginTop: 10 }} disabled={!form.targetHost} onClick={addMapping}>추가 + HAProxy 적용</button>
        </div>
      )}

      <div className="section-title" style={{ marginTop: 0 }}>접속 대상 {data.proxyHost && <span className="muted" style={{ fontSize: 12 }}>· 프록시 {data.proxyHost}</span>}</div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>이름</th><th>프로토콜</th><th>대상</th><th>공개 포트</th><th>상태</th><th style={{ textAlign: 'right' }}>접속</th></tr></thead>
          <tbody>
            {data.mappings.length === 0 && <tr><td colSpan={6} className="center muted" style={{ padding: 26 }}>등록된 대상이 없습니다.</td></tr>}
            {data.mappings.map((m) => (
              <tr key={m.id}>
                <td><b>{m.name}</b>{m.vcenterId && <span className="muted" style={{ fontSize: 11 }}> · {m.vcenterId}</span>}</td>
                <td><span className="badge blue">{m.protocol.toUpperCase()}</span></td>
                <td>{m.targetHost}:{m.targetPort}</td>
                <td>{data.proxyHost ? `${data.proxyHost}:${m.publicPort}` : m.publicPort}</td>
                <td><span className={`badge ${STATUS_BADGE[m.status] || 'gray'}`}>{m.status}</span></td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {m.protocol === 'ssh'
                    ? <button className="login-btn" style={{ flex: 'none', padding: '6px 12px' }} onClick={() => setSsh(m)}>SSH 터미널</button>
                    : (data.guacdConfigured
                        ? <><button className="login-btn" style={{ flex: 'none', padding: '6px 12px' }} onClick={() => setRdp(m)}>웹 RDP</button>{' '}<button className="logout-btn" style={{ padding: '6px 10px' }} onClick={() => downloadRdp(m)}>.rdp</button></>
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
        포탈이 글로벌 프록시(HAProxy)에 <b>공개 포트 → 대상:포트</b> TCP 매핑을 만들고, 사용자는 <b>프록시주소:공개포트</b>로 접속합니다.
        SSH는 브라우저 내장 터미널, RDP는 .rdp 파일(또는 guacd 구성 시 웹 콘솔)로 연결됩니다.
      </div>

      {ssh && <SshTerminal mapping={ssh} onClose={() => setSsh(null)} />}
      {rdp && <RdpConsole mapping={rdp} onClose={() => setRdp(null)} />}
    </>
  );
}

export function RdpConsole({ mapping, onClose }) {
  const elRef = useRef(null);
  const clientRef = useRef(null);
  const [creds, setCreds] = useState({ username: '', password: '', domain: '' });
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => () => { try { clientRef.current?.disconnect(); } catch { /* */ } }, []);

  const connect = () => {
    setConnected(true);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const tunnel = new Guacamole.WebSocketTunnel(`${proto}://${location.host}/api/remote/rdp`);
    const client = new Guacamole.Client(tunnel);
    clientRef.current = client;
    elRef.current.appendChild(client.getDisplay().getElement());
    client.onstatechange = (s) => setStatus(['초기화', '연결 중', '대기', '연결됨', '연결 종료', '오류'][s] || String(s));
    client.onerror = (e) => setStatus(`오류: ${e.message || e}`);

    const w = Math.max(800, elRef.current.clientWidth || 1024);
    const h = Math.max(600, elRef.current.clientHeight || 768);
    const q = new URLSearchParams({
      token: getToken() || '', mappingId: mapping.id,
      username: creds.username, password: creds.password, domain: creds.domain,
      width: String(w), height: String(h),
    }).toString();
    client.connect(q);

    const display = client.getDisplay().getElement();
    const mouse = new Guacamole.Mouse(display);
    mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (state) => client.sendMouseState(state);
    const kbd = new Guacamole.Keyboard(document);
    kbd.onkeydown = (k) => client.sendKeyEvent(1, k);
    kbd.onkeyup = (k) => client.sendKeyEvent(0, k);
  };

  return (
    <Modal title={`RDP — ${mapping.name} (${mapping.targetHost}:${mapping.targetPort})`} onClose={onClose} width={900}>
      {!connected ? (
        <div className="spec-grid">
          <label>사용자명<input className="input" autoFocus value={creds.username} onChange={(e) => setCreds({ ...creds, username: e.target.value })} placeholder="Administrator" /></label>
          <label>비밀번호<input className="input" type="password" value={creds.password} onChange={(e) => setCreds({ ...creds, password: e.target.value })} /></label>
          <label>도메인(선택)<input className="input" value={creds.domain} onChange={(e) => setCreds({ ...creds, domain: e.target.value })} /></label>
          <div style={{ gridColumn: '1 / -1' }}>
            <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} onClick={connect}>접속</button>
            <span className="muted" style={{ fontSize: 12, marginLeft: 10 }}>guacd 게이트웨이 경유로 RDP에 연결합니다. (guacd 구성 필요)</span>
          </div>
        </div>
      ) : (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>상태: {status}</div>
          <div ref={elRef} style={{ height: 540, background: '#000', borderRadius: 8, overflow: 'hidden' }} tabIndex={0} />
        </>
      )}
    </Modal>
  );
}

export function SshTerminal({ mapping, onClose }) {
  const elRef = useRef(null);
  const termRef = useRef(null);
  const wsRef = useRef(null);
  const [creds, setCreds] = useState({ username: '', password: '' });
  const [connected, setConnected] = useState(false);

  useEffect(() => () => { try { wsRef.current?.close(); } catch { /* */ } try { termRef.current?.dispose(); } catch { /* */ } }, []);

  const connect = () => {
    setConnected(true);
    const term = new Terminal({ fontSize: 13, cursorBlink: true, theme: { background: '#0b1020' } });
    const fit = new FitAddon(); term.loadAddon(fit);
    term.open(elRef.current); fit.fit(); term.focus(); termRef.current = term;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/remote/ssh?token=${encodeURIComponent(getToken() || '')}`);
    wsRef.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', mappingId: mapping.id, username: creds.username, password: creds.password, cols: term.cols, rows: term.rows }));
    ws.onmessage = (e) => {
      const s = typeof e.data === 'string' ? e.data : '';
      try { const j = JSON.parse(s); if (j && j.type === 'status') { term.write(`\r\n\x1b[33m${j.text}\x1b[0m\r\n`); return; } } catch { /* raw */ }
      term.write(s);
    };
    ws.onclose = () => term.write('\r\n\x1b[31m[연결 종료]\x1b[0m\r\n');
    term.onData((d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data: d })); });
    const onResize = () => { try { fit.fit(); if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch { /* */ } };
    window.addEventListener('resize', onResize);
  };

  return (
    <Modal title={`SSH — ${mapping.name} (${mapping.targetHost}:${mapping.targetPort})`} onClose={onClose} width={820}>
      {!connected ? (
        <div className="spec-grid">
          <label>사용자명<input className="input" autoFocus value={creds.username} onChange={(e) => setCreds({ ...creds, username: e.target.value })} placeholder="root" /></label>
          <label>비밀번호<input className="input" type="password" value={creds.password} onChange={(e) => setCreds({ ...creds, password: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && creds.username && connect()} /></label>
          <div style={{ gridColumn: '1 / -1' }}>
            <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={!creds.username} onClick={connect}>접속</button>
            <span className="muted" style={{ fontSize: 12, marginLeft: 10 }}>프록시 경유로 대상 SSH에 연결합니다.</span>
          </div>
        </div>
      ) : (
        <div ref={elRef} style={{ height: 420, background: '#0b1020', borderRadius: 8, padding: 6 }} />
      )}
    </Modal>
  );
}
