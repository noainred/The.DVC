import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../api.js';
import { Loading, ErrorBox, Modal } from '../components/ui.jsx';

/** 설정 → 중계 서버(프록시): HAProxy Data Plane / SSH 자동배포 + vCenter별 프록시 할당. */
export default function ProxySettings() {
  const [cfg, setCfg] = useState(null);
  const [proxies, setProxies] = useState([]);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [editProxy, setEditProxy] = useState(null);
  const [health, setHealth] = useState({}); // { [proxyId]: { state, reason, ms, method } }

  const testOne = async (id) => {
    setHealth((h) => ({ ...h, [id]: { state: 'testing' } }));
    const r = await postJson(`/remote/proxies/${id}/health`, {}).catch((e) => ({ ok: false, reason: e.message, method: 'error' }));
    setHealth((h) => ({ ...h, [id]: { state: r.method === 'manual' ? 'manual' : (r.ok ? 'ok' : 'fail'), reason: r.reason, ms: r.ms, method: r.method } }));
  };
  const testAll = (list) => (list || proxies).forEach((p) => testOne(p.id));

  const load = async () => {
    try {
      const r = await fetchJson('/remote/config'); setCfg(r.config); setError(null);
      fetchJson('/remote/proxies/full').then((p) => { setProxies(p.proxies); testAll(p.proxies); }).catch(() => setProxies([]));
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  if (error) return <ErrorBox message={error} />;
  if (!cfg) return <Loading />;
  const flash = (ok, text) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 4500); };

  const saveCfg = async () => {
    const r = await putJson('/remote/config', cfg).catch(() => ({ ok: false }));
    if (r.config) setCfg(r.config);
    flash(!!r.config, r.config ? '설정을 저장했습니다.' : '저장 실패');
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
    flash(r.ok, r.ok ? '배포 완료(reload).' : `배포 실패: ${r.reason}`);
  };
  const saveProxyForm = async (p) => {
    const r = await postJson('/remote/proxies', p).catch((e) => ({ ok: false, reason: e.message }));
    if (r.ok) { setEditProxy(null); await load(); flash(true, '프록시를 저장했습니다.'); } else flash(false, r.reason);
  };
  const removeProxyForm = async (p) => {
    if (!window.confirm(`프록시 '${p.name}'을(를) 삭제할까요?`)) return;
    await delJson(`/remote/proxies/${p.id}`).catch(() => {}); await load();
  };

  return (
    <>
      <div className="section-title" style={{ margin: '6px 0 10px' }}>중계 서버(프록시) 설정 — HAProxy</div>
      {msg && <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13, background: msg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)', color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.text}</div>}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
          <b style={{ fontSize: 14 }}>기본 프록시 · HAProxy Data Plane API</b>
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

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
          <b style={{ fontSize: 14 }}>기본 프록시 · SSH 자동배포 (Data Plane 미사용 환경)</b>
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

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
          <b style={{ fontSize: 14 }}>vCenter별 프록시 할당</b>
          <div className="flex gap">
            <button className="logout-btn" style={{ padding: '7px 14px' }} onClick={() => testAll()}>전체 상태 테스트</button>
            <button className="login-btn" style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setEditProxy({ name: '', proxyHost: '', publicPortBase: 20000, vcenterIds: [], dataplane: { enabled: false, url: '', basePath: '/v3', username: '', password: '' }, deploy: { enabled: false, host: '', port: 22, username: '', password: '', haproxyConfigPath: '/etc/haproxy/haproxy.cfg', reloadCmd: 'systemctl reload haproxy', validateCmd: 'haproxy -c -f {file}' }, guacd: { host: '', port: 4822 } })}>+ 프록시 추가</button>
          </div>
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>법인(vCenter)별로 다른 프록시 서버를 지정합니다. VM 접속 시 해당 vCenter에 할당된 프록시를 자동 사용하며, 미할당 vCenter는 위 <b>기본 프록시</b>를 씁니다. <b>상태</b> 점등: 🟢 동작 · 🔴 실패 · ⚪ 수동/대기.</div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>상태</th><th>이름</th><th>프록시 주소</th><th>공개포트 시작</th><th>할당 vCenter</th><th>프로비저닝</th><th style={{ textAlign: 'right' }}>관리</th></tr></thead>
            <tbody>
              {proxies.length === 0 && <tr><td colSpan={7} className="center muted" style={{ padding: 20 }}>추가 프록시가 없습니다. (모두 기본 프록시 사용)</td></tr>}
              {proxies.map((p) => (
                <tr key={p.id}>
                  <td><HealthDot h={health[p.id]} /></td>
                  <td><b>{p.name}</b></td>
                  <td>{p.proxyHost || '—'}</td>
                  <td>{p.publicPortBase}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{(p.vcenterIds || []).join(', ') || '—'}</td>
                  <td>{p.dataplane?.enabled ? <span className="badge green">Data Plane</span> : p.deploy?.enabled ? <span className="badge green">SSH</span> : <span className="badge gray">수동</span>}{p.guacd?.host ? <span className="badge blue" style={{ marginLeft: 4 }}>guacd</span> : null}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="logout-btn" style={{ padding: '6px 10px' }} onClick={() => testOne(p.id)}>테스트</button>{' '}
                    <button className="logout-btn" style={{ padding: '6px 10px' }} onClick={() => setEditProxy(p)}>편집</button>{' '}
                    <button className="logout-btn" style={{ padding: '6px 10px' }} onClick={() => removeProxyForm(p)}>삭제</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="muted" style={{ fontSize: 12, lineHeight: 1.7 }}>
        접속 대상(매핑) 생성·SSH/RDP 접속은 특수기능 → <b>원격 접속</b>에서 합니다. 여기서는 중계 서버(HAProxy) 구성만 합니다.
      </div>

      {editProxy && <ProxyEditor initial={editProxy} onSave={saveProxyForm} onClose={() => setEditProxy(null)} />}
    </>
  );
}

/** Live proxy health indicator: 🟢 동작 · 🔴 실패 · 🟡 확인중 · ⚪ 수동/대기. */
export function HealthDot({ h }) {
  const map = {
    testing: ['#fbbf24', '확인중…'],
    ok: ['#22c55e', `동작 중${h?.ms ? ` · ${h.ms}ms` : ''}${h?.method ? ` (${h.method})` : ''}`],
    fail: ['#ef4444', `동작 안 함: ${h?.reason || '실패'}`],
    manual: ['#64748b', '수동 구성 (자동 프로비저닝 없음)'],
  };
  const [color, label] = map[h?.state] || ['#64748b', '대기 — 테스트를 눌러 확인'];
  return (
    <span title={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      <span style={{ width: 11, height: 11, borderRadius: '50%', background: color, boxShadow: `0 0 7px ${color}`, display: 'inline-block' }} />
      <span className="muted">{(h?.state === 'ok') ? '동작' : h?.state === 'fail' ? '실패' : h?.state === 'testing' ? '확인중' : h?.state === 'manual' ? '수동' : '대기'}</span>
    </span>
  );
}

export function ProxyEditor({ initial, onSave, onClose }) {
  const [p, setP] = useState({ ...initial, vcenterIdsText: (initial.vcenterIds || []).join(', ') });
  const set = (k) => (e) => setP((s) => ({ ...s, [k]: e.target.value }));
  const setSub = (grp, k) => (e) => setP((s) => ({ ...s, [grp]: { ...s[grp], [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value } }));
  const submit = () => onSave({ ...p, publicPortBase: Number(p.publicPortBase) || 20000, vcenterIds: p.vcenterIdsText.split(',').map((x) => x.trim()).filter(Boolean) });

  return (
    <Modal title={initial.id ? `프록시 편집 — ${initial.name}` : '프록시 추가'} onClose={onClose} width={620}>
      <div className="spec-grid">
        <label>이름<input className="input" value={p.name} onChange={set('name')} placeholder="OC2-Proxy" /></label>
        <label>프록시 공개주소<input className="input" value={p.proxyHost} onChange={set('proxyHost')} placeholder="proxy-oc2.dvc" /></label>
        <label>공개포트 시작<input className="input" type="number" value={p.publicPortBase} onChange={set('publicPortBase')} /></label>
        <label style={{ gridColumn: '1 / -1' }}>할당 vCenter ID (쉼표 구분)<input className="input" value={p.vcenterIdsText} onChange={set('vcenterIdsText')} placeholder="OC2, OC3" /></label>
      </div>
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,.08)' }}>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 13, marginBottom: 6 }}>
          <input type="checkbox" checked={!!p.dataplane?.enabled} onChange={setSub('dataplane', 'enabled')} /> <b>Data Plane API</b> 사용
        </label>
        <div className="spec-grid">
          <label>URL<input className="input" value={p.dataplane?.url || ''} onChange={setSub('dataplane', 'url')} placeholder="http://proxy-oc2:5555" /></label>
          <label>basePath<input className="input" value={p.dataplane?.basePath || '/v3'} onChange={setSub('dataplane', 'basePath')} /></label>
          <label>사용자<input className="input" value={p.dataplane?.username || ''} onChange={setSub('dataplane', 'username')} /></label>
          <label>비밀번호<input className="input" type="password" value={p.dataplane?.password || ''} onChange={setSub('dataplane', 'password')} placeholder="********" /></label>
        </div>
      </div>
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,.08)' }}>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 13, marginBottom: 6 }}>
          <input type="checkbox" checked={!!p.deploy?.enabled} onChange={setSub('deploy', 'enabled')} /> <b>SSH 자동배포</b> 사용
        </label>
        <div className="spec-grid">
          <label>SSH 호스트<input className="input" value={p.deploy?.host || ''} onChange={setSub('deploy', 'host')} /></label>
          <label>포트<input className="input" type="number" value={p.deploy?.port || 22} onChange={setSub('deploy', 'port')} /></label>
          <label>사용자<input className="input" value={p.deploy?.username || ''} onChange={setSub('deploy', 'username')} /></label>
          <label>비밀번호<input className="input" type="password" value={p.deploy?.password || ''} onChange={setSub('deploy', 'password')} placeholder="********" /></label>
          <label style={{ gridColumn: '1 / -1' }}>haproxy.cfg 경로<input className="input" value={p.deploy?.haproxyConfigPath || ''} onChange={setSub('deploy', 'haproxyConfigPath')} /></label>
        </div>
      </div>
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,.08)' }}>
        <b style={{ fontSize: 13 }}>guacd (RDP 웹콘솔, 선택)</b>
        <div className="spec-grid" style={{ marginTop: 6 }}>
          <label>guacd 호스트<input className="input" value={p.guacd?.host || ''} onChange={setSub('guacd', 'host')} /></label>
          <label>포트<input className="input" type="number" value={p.guacd?.port || 4822} onChange={setSub('guacd', 'port')} /></label>
        </div>
      </div>
      <div className="flex gap" style={{ marginTop: 14 }}>
        <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={!p.name} onClick={submit}>저장</button>
        <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={onClose}>취소</button>
      </div>
    </Modal>
  );
}
