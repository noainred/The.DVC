import React, { useEffect, useState } from 'react';
import { fetchJson, putJson, postJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

const fmtAgo = (ts) => {
  if (!ts) return '없음';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  return `${Math.round(s / 3600)}시간 전`;
};

/**
 * GPU 게스트 수집 설정 — 패스쓰루 GPU는 ESXi에서 사용률을 못 보므로, 선택한 법인의
 * VM에 VMware Tools 게스트 작업으로 nvidia-smi를 실행해 사용률을 가져온다.
 * 법인 공용 계정 + VM별 개별 계정(다른 비밀번호)을 모두 지원하며, 로그인/데이터 읽기
 * 테스트를 개별·일괄로 할 수 있다.
 */
export default function GpuGuestSettings() {
  const [data, setData] = useState(null);   // { settings, status }
  const [vcs, setVcs] = useState([]);       // [{id,name,...}]
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);   // local editable copy (전역 + 공용 계정)
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    try {
      const [d, v] = await Promise.all([
        fetchJson('/admin/gpu-guest/settings'),
        fetchJson('/admin/vcenters').catch(() => ({ vcenters: [] })),
      ]);
      setData(d); setVcs(v.vcenters || []);
      if (!form) setForm(toForm(d.settings, v.vcenters || []));
      setError(null);
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); /* eslint-disable-next-line */ }, []);

  if (error) return <ErrorBox message={error} />;
  if (!data || !form) return <Loading />;

  const setVc = (id, patch) => setForm((f) => ({ ...f, vcenters: { ...f.vcenters, [id]: { ...f.vcenters[id], ...patch } } }));

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await putJson('/admin/gpu-guest/settings', form);
      setData(r);
      setForm(toForm(r.settings, vcs, form));
      setMsg('저장되었습니다. 새 설정이 다음 주기부터 적용됩니다.');
    } catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };

  const status = data.status || {};
  const last = status.lastRun;
  const monitoredCount = Object.values(form.vcenters).filter((v) => v.enabled).length;

  return (
    <div style={{ maxWidth: 980 }}>
      <div className="section-title" style={{ marginTop: 0 }}>🎮 GPU 게스트 수집</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        패스쓰루(DirectPath I/O) GPU는 ESXi가 사용률을 보지 못합니다. 선택한 <b>법인의 VM</b>에
        VMware Tools 게스트 작업으로 <code>nvidia-smi</code>를 실행해 사용률을 수집합니다.
        VM마다 계정이 다르면 <b>VM별 계정</b>을 등록하세요.
        <span className="badge amber" style={{ marginLeft: 6 }}>실환경 BETA</span>
      </p>

      <div className="card" style={{ padding: 16 }}>
        <label className="flex gap" style={{ alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} />
          <b>게스트 GPU 수집 사용</b>
        </label>
        <div className="flex gap wrap" style={{ marginTop: 12 }}>
          <Field label="수집 주기(초)"><input className="input" type="number" min={10} style={{ width: 100 }}
            value={Math.round(form.pollIntervalMs / 1000)} onChange={(e) => setForm((f) => ({ ...f, pollIntervalMs: Math.max(10, Number(e.target.value) || 60) * 1000 }))} /></Field>
          <Field label="동시 실행 VM 수"><input className="input" type="number" min={1} max={32} style={{ width: 80 }}
            value={form.concurrency} onChange={(e) => setForm((f) => ({ ...f, concurrency: Number(e.target.value) || 4 }))} /></Field>
          <Field label="VM당 타임아웃(초)"><input className="input" type="number" min={3} max={120} style={{ width: 90 }}
            value={Math.round(form.timeoutMs / 1000)} onChange={(e) => setForm((f) => ({ ...f, timeoutMs: Math.max(3, Number(e.target.value) || 20) * 1000 }))} /></Field>
          <Field label="법인당 최대 VM"><input className="input" type="number" min={1} max={100000} style={{ width: 100 }}
            value={form.maxVmsPerVcenter} onChange={(e) => setForm((f) => ({ ...f, maxVmsPerVcenter: Math.max(1, Number(e.target.value) || 1000) }))} /></Field>
        </div>
      </div>

      <div className="card" style={{ padding: 16, marginTop: 14 }}>
        <div className="flex between" style={{ alignItems: 'center', marginBottom: 8 }}>
          <b>법인(vCenter)별 모니터링 + 공용 계정</b>
          <span className="muted" style={{ fontSize: 12 }}>선택됨 {monitoredCount} / {vcs.length}</span>
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          여기 계정은 그 법인 VM에 <b>공용(기본)</b>으로 쓰입니다. VM마다 계정이 다르면 아래 <b>VM별 계정</b>에서 개별 지정하세요(개별이 공용보다 우선).
        </div>
        {vcs.length === 0 ? <span className="muted">등록된 vCenter가 없습니다. 먼저 vCenter를 등록하세요.</span> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ width: '100%' }}>
              <thead><tr>
                <th style={{ textAlign: 'left' }}>모니터링</th>
                <th style={{ textAlign: 'left' }}>법인 / vCenter</th>
                <th style={{ textAlign: 'left' }}>공용 계정</th>
                <th style={{ textAlign: 'left' }}>비밀번호</th>
              </tr></thead>
              <tbody>
                {vcs.map((vc) => {
                  const v = form.vcenters[vc.id] || { enabled: false, username: '', password: '', hasPassword: false };
                  return (
                    <tr key={vc.id}>
                      <td><input type="checkbox" checked={!!v.enabled} onChange={(e) => setVc(vc.id, { enabled: e.target.checked })} /></td>
                      <td><b>{vc.name || vc.id}</b><div className="muted" style={{ fontSize: 11 }}>{vc.location?.region || vc.location?.country || vc.id}</div></td>
                      <td><input className="input" style={{ width: 160 }} placeholder="administrator / root" value={v.username}
                        onChange={(e) => setVc(vc.id, { username: e.target.value })} /></td>
                      <td><input className="input" type="password" style={{ width: 160 }}
                        placeholder={v.hasPassword ? '●●●●● (변경시 입력)' : '비밀번호'} value={v.password || ''}
                        onChange={(e) => setVc(vc.id, { password: e.target.value })} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex gap" style={{ alignItems: 'center', marginTop: 12 }}>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy} onClick={save}>{busy ? '저장 중…' : '전역·공용 설정 저장'}</button>
          {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
        </div>
      </div>

      {/* VM별 계정 관리 + 테스트 */}
      <VmCredManager vcs={vcs} vcenters={form.vcenters} onSavedShared={load} />

      <div className="card" style={{ padding: 16, marginTop: 14 }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>현재 상태</div>
        <div className="flex gap wrap" style={{ fontSize: 13 }}>
          <span className="muted">상태 <b style={{ color: status.enabled ? 'var(--green)' : 'var(--text-dim)' }}>{status.enabled ? '활성' : '비활성'}</b></span>
          <span className="muted">대상 법인 <b style={{ color: 'var(--text)' }}>{status.monitored ?? 0}</b></span>
          <span className="muted">마지막 수집 <b style={{ color: 'var(--text)' }}>{fmtAgo(last?.at)}</b></span>
          {last && (last.skipped
            ? <span className="muted">({last.skipped})</span>
            : <span className="muted">[{last.mode}] 호스트 <b style={{ color: 'var(--text)' }}>{last.hosts}</b> · VM <b style={{ color: 'var(--text)' }}>{last.vms}</b>{last.errors ? ` · 오류 ${last.errors}` : ''}</span>)}
        </div>
      </div>
    </div>
  );
}

/** VM별 계정 관리 — 법인 선택 → 패스쓰루 GPU VM 조회 → 공용/별도 선택 + 로그인/읽기 테스트(개별·일괄). */
function VmCredManager({ vcs, vcenters }) {
  const [selVc, setSelVc] = useState('');
  const [rows, setRows] = useState(null);   // null=미조회, []=없음
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const loadVms = async (vcId) => {
    if (!vcId) { setRows(null); return; }
    setLoading(true); setMsg(null);
    try {
      const r = await fetchJson(`/admin/gpu-guest/vms?vcenterId=${encodeURIComponent(vcId)}`);
      setRows((r.vms || []).map((v) => ({
        ...v,
        mode: v.hasOwnCred ? 'own' : 'shared',   // 'shared'=공용 | 'own'=별도
        username: v.ownUsername || '',
        password: '',
        hadOwn: !!v.hasOwnCred,
        test: null,                              // {login,read,error,sample} | {pending}
      })));
    } catch (e) { setMsg(`오류: ${e.message}`); setRows([]); }
    finally { setLoading(false); }
  };

  const pickVc = (vcId) => { setSelVc(vcId); setRows(null); loadVms(vcId); };
  const setRow = (id, patch) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const runTest = async (subset) => {
    const targets = subset || rows;
    if (!targets || !targets.length) return;
    setRows((rs) => rs.map((r) => (targets.find((t) => t.id === r.id) ? { ...r, test: { pending: true } } : r)));
    try {
      const items = targets.map((r) => ({ vmId: r.id, useShared: r.mode === 'shared', username: r.mode === 'own' ? r.username : '', password: r.mode === 'own' ? r.password : '' }));
      const res = await postJson('/admin/gpu-guest/test', { vcenterId: selVc, items });
      const byId = new Map((res.results || []).map((x) => [x.vmId, x]));
      setRows((rs) => rs.map((r) => (byId.has(r.id) ? { ...r, test: byId.get(r.id), _mock: res.mock } : r)));
    } catch (e) {
      setRows((rs) => rs.map((r) => (targets.find((t) => t.id === r.id) ? { ...r, test: { error: e.message } } : r)));
    }
  };

  const saveCreds = async () => {
    if (!rows) return;
    setBusy(true); setMsg(null);
    try {
      const vms = {};
      for (const r of rows) {
        if (r.mode === 'own') {
          if (r.username) vms[r.id] = { username: r.username, ...(r.password ? { password: r.password } : {}) };
        } else if (r.hadOwn) {
          vms[r.id] = null; // 공용으로 전환 → override 제거
        }
      }
      await putJson('/admin/gpu-guest/settings', { vcenters: { [selVc]: { vms } } });
      setMsg('VM별 계정을 저장했습니다.');
      await loadVms(selVc);
    } catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };

  const vcShared = vcenters[selVc] || {};
  const ownCount = rows ? rows.filter((r) => r.mode === 'own').length : 0;

  return (
    <div className="card" style={{ padding: 16, marginTop: 14 }}>
      <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 8, gap: 8 }}>
        <b>VM별 계정 (계정이 VM마다 다를 때)</b>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <select className="select" value={selVc} onChange={(e) => pickVc(e.target.value)} style={{ minWidth: 200 }}>
            <option value="">법인(vCenter) 선택…</option>
            {vcs.map((vc) => <option key={vc.id} value={vc.id}>{vc.name || vc.id}</option>)}
          </select>
          <button className="logout-btn" style={{ padding: '7px 12px' }} disabled={!selVc || loading} onClick={() => loadVms(selVc)}>{loading ? '조회 중…' : '↻ VM 조회'}</button>
        </div>
      </div>

      {!selVc && <div className="muted" style={{ fontSize: 13 }}>법인을 선택하면 그 법인에서 GPU를 <b>패스쓰루</b>로 쓰는 VM 목록을 불러옵니다.</div>}
      {selVc && rows && rows.length === 0 && !loading && <div className="muted" style={{ fontSize: 13 }}>이 법인에 패스쓰루 GPU VM이 없습니다.</div>}

      {selVc && rows && rows.length > 0 && (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            공용 계정: <b>{vcShared.username || '(미설정)'}</b>{vcShared.hasPassword ? ' · 비번 저장됨' : ''} · VM {rows.length}개 · 별도 계정 {ownCount}개
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
              <thead><tr>
                <th style={{ textAlign: 'left' }}>VM</th>
                <th style={{ textAlign: 'left' }}>호스트</th>
                <th style={{ textAlign: 'left' }}>상태</th>
                <th style={{ textAlign: 'left' }}>계정 방식</th>
                <th style={{ textAlign: 'left' }}>계정 / 비밀번호</th>
                <th style={{ textAlign: 'left' }}>테스트</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => {
                  const ready = r.powerState === 'POWERED_ON' && r.toolsStatus === 'RUNNING';
                  return (
                    <tr key={r.id}>
                      <td><b>{r.name}</b><div className="muted" style={{ fontSize: 11 }}>{r.guestOS || ''}</div></td>
                      <td className="muted" style={{ fontSize: 12 }}>{r.host}</td>
                      <td style={{ fontSize: 11 }}>
                        <span className={`badge ${r.powerState === 'POWERED_ON' ? 'green' : 'gray'}`}>{r.powerState === 'POWERED_ON' ? 'On' : 'Off'}</span>{' '}
                        <span className={`badge ${r.toolsStatus === 'RUNNING' ? 'green' : 'amber'}`}>Tools {r.toolsStatus === 'RUNNING' ? 'OK' : (r.toolsStatus || '—')}</span>
                      </td>
                      <td>
                        <select className="select" value={r.mode} onChange={(e) => setRow(r.id, { mode: e.target.value })} style={{ width: 96 }}>
                          <option value="shared">공용</option>
                          <option value="own">별도</option>
                        </select>
                      </td>
                      <td>
                        {r.mode === 'own' ? (
                          <div className="flex gap" style={{ gap: 4 }}>
                            <input className="input" style={{ width: 120 }} placeholder="계정(root 등)" value={r.username} onChange={(e) => setRow(r.id, { username: e.target.value })} />
                            <input className="input" type="password" style={{ width: 120 }} placeholder={r.hadOwn ? '●●●●● (변경시)' : '비밀번호'} value={r.password} onChange={(e) => setRow(r.id, { password: e.target.value })} />
                          </div>
                        ) : <span className="muted" style={{ fontSize: 12 }}>법인 공용 계정 사용</span>}
                      </td>
                      <td>
                        <div className="flex gap" style={{ alignItems: 'center', gap: 6 }}>
                          <button className="tab" style={{ padding: '4px 8px' }} disabled={!ready} title={ready ? '' : '전원 On + Tools RUNNING 필요'} onClick={() => runTest([r])}>테스트</button>
                          <TestResult t={r.test} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex gap wrap" style={{ alignItems: 'center', marginTop: 12 }}>
            <button className="logout-btn" style={{ padding: '8px 14px' }} onClick={() => runTest(null)}>⚡ 모두 테스트</button>
            <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy} onClick={saveCreds}>{busy ? '저장 중…' : 'VM별 계정 저장'}</button>
            {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            ※ <b>로그인</b>=게스트 계정 인증(명령 실행 안 함) · <b>읽기</b>=nvidia-smi로 GPU 사용률 실제 수집. 둘 다 ✅면 수집 준비 완료입니다.
            전원 Off/Tools 미동작 VM은 테스트 불가(수집 대상에서도 자동 제외).
          </div>
        </>
      )}
    </div>
  );
}

function TestResult({ t }) {
  if (!t) return <span className="muted" style={{ fontSize: 12 }}>—</span>;
  if (t.pending) return <span className="muted" style={{ fontSize: 12 }}>테스트 중…</span>;
  if (t.error && !t.login) return <span className="badge red" title={t.error} style={{ fontSize: 11 }}>실패: {t.error}</span>;
  return (
    <span className="flex gap" style={{ alignItems: 'center', gap: 4, fontSize: 11 }}>
      <span className={`badge ${t.login ? 'green' : 'red'}`}>로그인 {t.login ? '✓' : '✗'}</span>
      <span className={`badge ${t.read ? 'green' : (t.login ? 'amber' : 'gray')}`}>읽기 {t.read ? '✓' : '✗'}</span>
      {t.sample && <span className="muted">{t.sample.utilPct}% · {t.sample.gpus}GPU</span>}
      {!t.read && t.error && <span className="muted" title={t.error}>({t.error})</span>}
    </span>
  );
}

function Field({ label, children }) {
  return <div><label className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>{label}</label>{children}</div>;
}

function toForm(settings, vcs, prev) {
  const vcenters = {};
  for (const vc of vcs) {
    const s = settings.vcenters?.[vc.id] || {};
    vcenters[vc.id] = { enabled: !!s.enabled, username: s.username || '', hasPassword: !!s.hasPassword, password: '' };
  }
  for (const [id, s] of Object.entries(settings.vcenters || {})) {
    if (!vcenters[id]) vcenters[id] = { enabled: !!s.enabled, username: s.username || '', hasPassword: !!s.hasPassword, password: '' };
  }
  return {
    enabled: !!settings.enabled, pollIntervalMs: settings.pollIntervalMs || 60000, concurrency: settings.concurrency || 4,
    timeoutMs: settings.timeoutMs || 20000, maxVmsPerVcenter: settings.maxVmsPerVcenter || 1000, vcenters,
  };
}
