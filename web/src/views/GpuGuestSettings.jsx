// GpuGuestSettings.jsx — GPU 게스트 수집 설정 셸(v2.295 대형 파일 분할 · 1차 감사 확정 #4·#8).
// 구 891줄 중 별개 도메인/최다 수정 지점을 gpu-guest/ 로 분리하고, 이 파일은 전역 설정 폼 +
// 배포 대상 선택 + 공용 계정 표 + 상태 카드 + QuickSshTest + toForm 만 남는다(경로·default
// export 불변 — Settings.jsx 소비자 무변경, IdracAdmin v2.292 와 같은 '원 경로=셸 유지' 규약).
//  · gpu-guest/PhysicalGpuManager.jsx : 물리 GPU 서버(베어메탈 — 별개 백엔드 도메인)
//  · gpu-guest/VmCredManager.jsx      : VM별 계정·테스트 러너(이 화면 기능 커밋 최다 지점)
//  · gpu-guest/shared.jsx             : Field·fmtAgo(셸·하위가 공용 — 복제 금지)
import React, { useEffect, useState } from 'react';
import { fetchJson, putJson, postJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import { Field, fmtAgo } from './gpu-guest/shared.jsx';
import { VmCredManager } from './gpu-guest/VmCredManager.jsx';
import { PhysicalGpuManager } from './gpu-guest/PhysicalGpuManager.jsx';

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
  // 설정 대상: '' = 이 포탈(로컬 수집), 그 외 = 원격 엣지(agent) 앞으로 배포(엣지가 pull해 적용).
  const [deployAgent, setDeployAgent] = useState('');
  const [agents, setAgents] = useState([]);

  const settingsUrl = (agent) => (agent ? `/admin/gpu-guest/deploy/${encodeURIComponent(agent)}` : '/admin/gpu-guest/settings');

  const load = async (agent = deployAgent, force = false) => {
    try {
      const [d, v] = await Promise.all([
        fetchJson(settingsUrl(agent)),
        fetchJson('/admin/vcenters').catch(() => ({ vcenters: [] })),
      ]);
      // 로컬: { settings, status } · 배포: { assigned, settings } (미지정이면 settings=null)
      const settings = agent ? (d.settings || { vcenters: {} }) : d.settings;
      setData(agent ? { settings, status: {}, deploy: true, assigned: !!d.assigned } : d);
      setVcs(v.vcenters || []);
      // 대상 전환(force) 시 폼을 새로 채움. 로컬 30초 폴링은 최초 1회만(미저장 입력 보존).
      setForm((cur) => (force || !cur ? toForm(settings || { vcenters: {} }, v.vcenters || []) : cur));
      setError(null);
    } catch (e) { setError(e.message); }
  };
  // 배포 대상 후보 목록(1회).
  useEffect(() => { fetchJson('/admin/gpu-guest/deploy/agents').then((r) => setAgents(r.agents || [])).catch(() => {}); }, []);
  // 대상 전환 시 폼 재로딩. 로컬일 때만 30초 자동 폴링(배포 편집 중 덮어쓰기 방지).
  useEffect(() => {
    load(deployAgent, true);
    if (deployAgent) return undefined;
    const t = setInterval(() => load('', false), 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line
  }, [deployAgent]);

  if (error && !data) return <ErrorBox message={error} />; // 데이터 보유 중 일시 폴링 오류로 화면 전체를 갈아치우지 않음(CLAUDE.md)
  if (!data || !form) return <Loading />;

  const setVc = (id, patch) => setForm((f) => ({ ...f, vcenters: { ...f.vcenters, [id]: { ...f.vcenters[id], ...patch } } }));

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await putJson(settingsUrl(deployAgent), form);
      const settings = deployAgent ? (r.settings || form) : r.settings;
      if (!deployAgent) setData(r);
      setForm(toForm(settings, vcs, form));
      setMsg(deployAgent
        ? `원격 엣지 [${deployAgent}]로 배포 저장됨 — 엣지가 다음 pull 주기(약 1분)에 가져가 적용합니다.`
        : '저장되었습니다. 새 설정이 다음 주기부터 적용됩니다.');
      if (deployAgent) fetchJson('/admin/gpu-guest/deploy/agents').then((rr) => setAgents(rr.agents || [])).catch(() => {});
    } catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };

  const status = data.status || {};
  const last = status.lastRun;
  const monitoredCount = Object.values(form.vcenters).filter((v) => v.enabled).length;

  return (
    <div style={{ maxWidth: 1280 }}>
      <div className="section-title" style={{ marginTop: 0 }}>🎮 GPU 게스트 수집</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
패스쓰루(DirectPath I/O) GPU는 ESXi가 사용률을 보지 못하고, vGPU도 VM별 사용률은 게스트에서 읽는 게 정확합니다. 선택한 <b>법인의 VM</b>에
        VMware Tools 게스트 작업으로 <code>nvidia-smi</code>를 실행해 사용률을 수집합니다.
        VM마다 계정이 다르면 <b>VM별 계정</b>을 등록하세요.
        <span className="badge amber" style={{ marginLeft: 6 }}>실환경 BETA</span>
      </p>

      {/* 설정 대상: 이 포탈(로컬) vs 원격 엣지 배포. 원격 엣지는 폐쇄망/NAT라 중앙이 직접 접속 못 하므로,
          여기서 지정한 설정을 엣지가 pull해 자기 로컬에 적용한다(실제 SSH/게스트작업은 엣지에서 수행). */}
      <div className="card" style={{ padding: '10px 16px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 13 }}>설정 대상</b>
        <select className="select" style={{ minWidth: 260 }} value={deployAgent} onChange={(e) => { setDeployAgent(e.target.value); setMsg(null); }}
          title="이 포탈(로컬)에서 직접 수집할지, 원격 엣지 앞으로 설정을 배포할지 선택. 원격 엣지 앞 설정은 엣지가 주기적으로 가져가 적용합니다.">
          <option value="">🖥️ 이 포탈(로컬 수집)</option>
          {agents.length > 0 && <optgroup label="원격 엣지에 배포(pull)">
            {agents.map((a) => <option key={a.agent} value={a.agent}>📡 {a.agent}{a.assigned ? ` · 배포됨(vC ${a.vcenters}·VM계정 ${a.vmCreds})` : ''}</option>)}
          </optgroup>}
        </select>
        {deployAgent && (
          <span className="muted" style={{ fontSize: 12, color: 'var(--amber,#f59e0b)' }}>
            ℹ 이 설정은 원격 엣지 <b>{deployAgent}</b>로 배포됩니다. 엣지가 다음 pull 주기(약 1분)에 가져가 로컬에 적용하고, <b>실제 SSH/게스트작업은 엣지에서</b> 수행합니다. (테스트 버튼은 중앙에서 원격 VM에 도달 못 하므로 비활성)
          </span>
        )}
      </div>

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
          <Field label="수집 방식"><select className="select" style={{ width: 210 }} value={form.collectMethod}
            title="auto(권장)=게스트작업 먼저→실패 시 SSH 자동 폴백(VM별 성공 방식 학습). VMware Tools=게스트작업만. SSH 직접=게스트 IP로 SSH해 nvidia-smi만."
            onChange={(e) => setForm((f) => ({ ...f, collectMethod: e.target.value }))}>
            <option value="auto">auto · 자동 폴백(권장)</option>
            <option value="guestops">VMware Tools만</option>
            <option value="ssh">SSH 직접만</option>
          </select></Field>
          {form.collectMethod !== 'guestops' && (
            <Field label="SSH 포트"><input className="input" type="number" min={1} max={65535} style={{ width: 80 }}
              value={form.sshPort} onChange={(e) => setForm((f) => ({ ...f, sshPort: Math.max(1, Number(e.target.value) || 22) }))} /></Field>
          )}
        </div>
        {form.collectMethod === 'ssh' && (
          <div className="muted" style={{ fontSize: 12, marginTop: 6, color: 'var(--amber,#f59e0b)' }}>
            ℹ Windows VM은 기본적으로 SSH 서버(sshd)가 없어 <b>SSH 직접</b> 방식으로는 수집되지 않습니다.
            Windows VM은 자동으로 <b>VMware Tools 게스트 작업</b>(nvidia-smi.exe)으로 수집합니다(리눅스는 SSH 그대로).
          </div>
        )}
        <div className="flex gap" style={{ alignItems: 'center', marginTop: 12 }}>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy} onClick={save}>{busy ? '저장 중…' : '설정 저장'}</button>
          <span className="muted" style={{ fontSize: 12 }}>수집 방식·주기·동시성 등 전역 설정을 저장합니다(아래 공용 계정도 함께).</span>
          {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
        </div>
      </div>

      <div className="card" style={{ padding: 16, marginTop: 14 }}>
        <div className="flex between" style={{ alignItems: 'center', marginBottom: 8 }}>
          <b>법인(vCenter)별 모니터링 + 공용 계정</b>
          <span className="muted" style={{ fontSize: 12 }}>선택됨 {monitoredCount} / {vcs.length}</span>
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          여기 계정은 그 법인 VM에 <b>공용(기본)</b>으로 쓰입니다. <b>Linux/Windows를 구분</b>해 입력하면 게스트 OS에 맞는 계정으로 수집합니다(Windows 칸 비우면 Linux 계정으로 폴백). VM마다 계정이 다르면 아래 <b>VM별 계정</b>에서 개별 지정하세요(개별이 공용보다 우선).
        </div>
        {vcs.length === 0 ? <span className="muted">등록된 vCenter가 없습니다. 먼저 vCenter를 등록하세요.</span> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ width: '100%' }}>
              <thead><tr>
                <th style={{ textAlign: 'left' }}>모니터링</th>
                <th style={{ textAlign: 'left' }}>법인 / vCenter</th>
                <th style={{ textAlign: 'left' }}>🐧 Linux 계정</th>
                <th style={{ textAlign: 'left' }}>Linux 비번</th>
                <th style={{ textAlign: 'left' }}>🪟 Windows 계정</th>
                <th style={{ textAlign: 'left' }}>Windows 비번</th>
              </tr></thead>
              <tbody>
                {vcs.map((vc) => {
                  const v = form.vcenters[vc.id] || { enabled: false, username: '', password: '', hasPassword: false, winUsername: '', winPassword: '', hasWinPassword: false };
                  return (
                    <tr key={vc.id}>
                      <td><input type="checkbox" checked={!!v.enabled} onChange={(e) => setVc(vc.id, { enabled: e.target.checked })} /></td>
                      <td><b>{vc.name || vc.id}</b><div className="muted" style={{ fontSize: 11 }}>{vc.location?.region || vc.location?.country || vc.id}</div></td>
                      <td><input className="input" style={{ width: 140 }} placeholder="root" value={v.username}
                        onChange={(e) => setVc(vc.id, { username: e.target.value })} /></td>
                      <td><input className="input" type="password" style={{ width: 140 }}
                        placeholder={v.hasPassword ? '●●●●● (변경시 입력)' : 'Linux 비번'} value={v.password || ''}
                        onChange={(e) => setVc(vc.id, { password: e.target.value })} /></td>
                      <td><input className="input" style={{ width: 140 }} placeholder="Administrator" value={v.winUsername || ''}
                        onChange={(e) => setVc(vc.id, { winUsername: e.target.value })} /></td>
                      <td><input className="input" type="password" style={{ width: 140 }}
                        placeholder={v.hasWinPassword ? '●●●●● (변경시 입력)' : 'Windows 비번'} value={v.winPassword || ''}
                        onChange={(e) => setVc(vc.id, { winPassword: e.target.value })} /></td>
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

      {/* VM 목록 조회 없이 IP+계정만으로 1대 즉시 테스트 */}
      <QuickSshTest />

      {/* VM별 계정 관리 + 테스트 */}
      <VmCredManager vcs={vcs} vcenters={form.vcenters} collectMethod={form.collectMethod} onSavedShared={() => load(deployAgent, false)} deployAgent={deployAgent} />

      {/* 물리(베어메탈) 서버 GPU 수집 — 가상화 안 한 서버 SSH nvidia-smi. 로컬 전용(엣지 배포 대상 아님). */}
      {!deployAgent && <PhysicalGpuManager vcs={vcs} />}

      {deployAgent ? (
        <div className="card" style={{ padding: 16, marginTop: 14 }}>
          <div className="muted" style={{ fontSize: 12 }}>
            원격 엣지 <b style={{ color: 'var(--text)' }}>{deployAgent}</b> 배포 모드 — 실제 수집 상태/진단은 이 엣지에서 수행되며, GPU 수집 진단 화면의 <b>Agent: {deployAgent}</b> 블록에서 확인하세요.
          </div>
        </div>
      ) : (
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
      )}
    </div>
  );
}

/** 빠른 단일 테스트 — VM 목록/ vCenter 조회 없이 IP+계정만으로 nvidia-smi 1대 즉시 SSH 테스트. */
function QuickSshTest() {
  const [ip, setIp] = useState('');
  const [username, setUsername] = useState('root');
  const [password, setPassword] = useState('');
  const [port, setPort] = useState(22);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const run = async () => {
    if (!ip.trim() || !username.trim()) return;
    setBusy(true); setRes(null);
    try { setRes(await postJson('/admin/gpu-guest/test-ssh', { ip: ip.trim(), username: username.trim(), password, port: Number(port) || 22, revealCreds: reveal })); }
    catch (e) { setRes({ error: e.message }); }
    setBusy(false);
  };
  const fmtT = (t) => { const d = new Date(t); return d.toLocaleTimeString('ko-KR', { hour12: false }); };
  return (
    <div className="card" style={{ padding: 16, marginTop: 14 }}>
      <div className="section-title" style={{ fontSize: 14, marginTop: 0 }}>⚡ 빠른 단일 테스트 (SSH)</div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>VM 목록 조회 없이 <b>IP + 계정</b>만으로 게스트에 직접 SSH해 nvidia-smi 1대를 즉시 테스트합니다(VMware Tools 게스트작업 인증이 막힐 때 확인용). 비번을 비우면 passwordless/키 인증.</div>
      <div className="flex gap wrap" style={{ alignItems: 'center' }}>
        <input className="input" style={{ width: 160 }} placeholder="게스트 IP (예: 10.0.0.5)" value={ip} onChange={(e) => setIp(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} />
        <input className="input" style={{ width: 120 }} placeholder="계정(root 등)" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input className="input" type="password" style={{ width: 130 }} placeholder="비밀번호(빈칸 가능)" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} />
        <input className="input" type="number" style={{ width: 80 }} min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} title="SSH 포트" />
        <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={busy || !ip.trim() || !username.trim()} onClick={run}>{busy ? '테스트 중…' : '테스트'}</button>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 12 }} title="실행 로그에 실제 id/pw 평문 표시(디버그)">
          <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} /> 🔓 평문
        </label>
      </div>
      {res && (
        <div style={{ marginTop: 12 }}>
          <div className="flex gap" style={{ alignItems: 'center', marginBottom: 6 }}>
            {res.error && !res.trace ? <span className="badge red">오류: {res.error}</span> : (
              <>
                <span className={`badge ${res.login ? 'green' : 'red'}`}>로그인 {res.login ? 'OK' : '실패'}</span>
                <span className={`badge ${res.read ? 'green' : 'gray'}`}>읽기 {res.read ? 'OK' : '실패'}</span>
                {res.sample && <span className="badge teal">GPU {res.sample.gpus} · 사용률 {res.sample.utilPct}% · mem {res.sample.memUsedPct ?? '-'}%</span>}
                {!res.read && res.error && <span className="muted" style={{ fontSize: 12 }}>{res.error}</span>}
              </>
            )}
          </div>
          {(res.trace || []).length > 0 && (
            <pre style={{ margin: 0, padding: '8px 10px', maxHeight: 200, overflow: 'auto', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12, background: '#0a0f1a', color: '#cbd5e1', whiteSpace: 'pre-wrap', wordBreak: 'break-all', borderRadius: 6 }}>
              {res.trace.map((l, i) => {
                const ok = /✓|성공|OK/.test(l.msg); const bad = /✗|실패|오류|타임아웃|거부/.test(l.msg);
                return <div key={i} style={{ color: ok ? '#86efac' : bad ? '#fca5a5' : (l.msg.includes('🔓') ? '#fcd34d' : '#cbd5e1') }}>{fmtT(l.t)} {l.msg}</div>;
              })}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function toForm(settings, vcs, prev) {
  const vcenters = {};
  const mk = (s) => ({ enabled: !!s.enabled, username: s.username || '', hasPassword: !!s.hasPassword, password: '', winUsername: s.winUsername || '', hasWinPassword: !!s.hasWinPassword, winPassword: '' });
  for (const vc of vcs) vcenters[vc.id] = mk(settings.vcenters?.[vc.id] || {});
  for (const [id, s] of Object.entries(settings.vcenters || {})) { if (!vcenters[id]) vcenters[id] = mk(s); }
  return {
    enabled: !!settings.enabled, pollIntervalMs: settings.pollIntervalMs || 60000, concurrency: settings.concurrency || 4,
    timeoutMs: settings.timeoutMs || 20000, maxVmsPerVcenter: settings.maxVmsPerVcenter || 1000,
    collectMethod: settings.collectMethod || 'auto', sshPort: settings.sshPort || 22, vcenters,
  };
}
