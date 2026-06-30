import React, { useEffect, useState } from 'react';
import { fetchJson, putJson, postJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

const ROLES = ['viewer', 'operator', 'admin'];

/** 설정 → 인증(AD): Active Directory(LDAP) 로그인 연동 구성. */
export default function AdSettings() {
  const [cfg, setCfg] = useState(null);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sample, setSample] = useState({ username: '', password: '' });
  const [testRes, setTestRes] = useState(null);

  useEffect(() => {
    fetchJson('/auth/ad-config').then((d) => setCfg(d.ad)).catch((e) => setError(e.message));
  }, []);

  if (error) return <ErrorBox message={error} />;
  if (!cfg) return <Loading />;

  const set = (k) => (e) => setCfg((c) => ({ ...c, [k]: e.target.value }));
  const setBool = (k) => (e) => setCfg((c) => ({ ...c, [k]: e.target.checked }));

  const save = async () => {
    setBusy(true); setMsg(null);
    try { const r = await putJson('/auth/ad-config', cfg); setCfg(r.ad); setMsg({ ok: true, text: '저장되었습니다.' }); }
    catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };

  const test = async () => {
    setBusy(true); setTestRes(null);
    try {
      const r = await postJson('/auth/ad-test', { config: cfg, username: sample.username || undefined, password: sample.password || undefined });
      setTestRes(r);
    } catch (e) { setTestRes({ ok: false, reason: e.message }); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="flex between wrap" style={{ marginBottom: 12, alignItems: 'center' }}>
        <b style={{ fontSize: 15 }}>Active Directory (LDAP) 로그인 연동</b>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={!!cfg.enabled} onChange={setBool('enabled')} /> 사용
        </label>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="spec-grid">
          <label>AD 서버 URL *<input className="input" value={cfg.url} onChange={set('url')} placeholder="ldaps://dc.corp.local:636" /></label>
          <label>도메인 (UPN)<input className="input" value={cfg.domain} onChange={set('domain')} placeholder="corp.local" /></label>
          <label style={{ gridColumn: '1 / -1' }}>Base DN (그룹 조회용)<input className="input" value={cfg.baseDN} onChange={set('baseDN')} placeholder="DC=corp,DC=local" /></label>
          <label style={{ gridColumn: '1 / -1' }}>사용자 검색 필터<input className="input" value={cfg.userFilter} onChange={set('userFilter')} placeholder="(|(userPrincipalName={upn})(sAMAccountName={user}))" /></label>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={!!cfg.tlsRejectUnauthorized} onChange={setBool('tlsRejectUnauthorized')} /> TLS 인증서 검증(자체서명이면 끄기)</label>
          <label>타임아웃(ms)<input className="input" type="number" value={cfg.timeoutMs} onChange={set('timeoutMs')} /></label>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <b style={{ fontSize: 14 }}>그룹 → 역할 매핑</b>
        <div className="muted" style={{ fontSize: 12, margin: '6px 0 10px' }}>로그인 사용자의 memberOf 에 아래 그룹명(CN 일부 포함)이 있으면 해당 역할을 부여합니다.</div>
        <div className="spec-grid">
          <label>admin 그룹<input className="input" value={cfg.adminGroup} onChange={set('adminGroup')} placeholder="VMware-Portal-Admins" /></label>
          <label>operator 그룹<input className="input" value={cfg.operatorGroup} onChange={set('operatorGroup')} placeholder="(선택)" /></label>
          <label>viewer 그룹<input className="input" value={cfg.viewerGroup} onChange={set('viewerGroup')} placeholder="(선택)" /></label>
          <label>기본 역할(매칭 없을 때)
            <select className="select" value={cfg.defaultRole} onChange={set('defaultRole')}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
        </div>
      </div>

      <div className="flex gap" style={{ alignItems: 'center', marginBottom: 16 }}>
        <button className="login-btn" style={{ flex: 'none', padding: '10px 18px' }} disabled={busy} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
        {msg && <span style={{ fontSize: 13, color: msg.ok ? 'var(--green)' : 'var(--red)' }}>{msg.text}</span>}
      </div>

      <div className="card">
        <b style={{ fontSize: 14 }}>연결/로그인 테스트</b>
        <div className="muted" style={{ fontSize: 12, margin: '6px 0 10px' }}>사용자/비번을 비우면 연결만, 입력하면 실제 바인드+역할 매핑까지 검증합니다.</div>
        <div className="flex gap wrap" style={{ alignItems: 'flex-end' }}>
          <label style={{ fontSize: 12 }}>테스트 사용자<input className="input" value={sample.username} onChange={(e) => setSample((s) => ({ ...s, username: e.target.value }))} placeholder="user 또는 user@corp.local" /></label>
          <label style={{ fontSize: 12 }}>비밀번호<input className="input" type="password" value={sample.password} onChange={(e) => setSample((s) => ({ ...s, password: e.target.value }))} /></label>
          <button className="logout-btn" style={{ padding: '9px 14px' }} disabled={busy || !cfg.url} onClick={test}>테스트</button>
        </div>
        {testRes && (
          <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13,
            background: testRes.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)', color: testRes.ok ? '#4ade80' : '#f87171' }}>
            {testRes.ok
              ? `성공 (${testRes.ms}ms)${testRes.boundAs ? ` · 바인드 ${testRes.boundAs} · 역할 ${testRes.role}` : ` · ${testRes.note || ''}`}`
              : `실패: ${testRes.reason}`}
            {testRes.groups?.length > 0 && <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>그룹: {testRes.groups.join(', ')}</div>}
          </div>
        )}
      </div>

      <div className="muted" style={{ fontSize: 12, marginTop: 12, lineHeight: 1.7 }}>
        방식: 사용자 <b>UPN 직접 바인드</b>(user@도메인) → 성공 시 memberOf 조회로 역할 매핑.
        AD 인증 실패 시 <b>로컬 계정(users.json)</b>으로 폴백하므로 기본 admin 으로도 로그인됩니다.
        설정은 <code>$CONFIG_DIR/auth.json</code>(0600)에 저장됩니다. (AD_* 환경변수로도 설정 가능)
      </div>
    </>
  );
}
