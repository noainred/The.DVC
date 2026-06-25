import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, putJson, postJson, delJson } from '../api.js';
import { Loading, ErrorBox, VmLink } from '../components/ui.jsx';

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
    <div style={{ maxWidth: 1280 }}>
      <div className="section-title" style={{ marginTop: 0 }}>🎮 GPU 게스트 수집</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
패스쓰루(DirectPath I/O) GPU는 ESXi가 사용률을 보지 못하고, vGPU도 VM별 사용률은 게스트에서 읽는 게 정확합니다. 선택한 <b>법인의 VM</b>에
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
      <VmCredManager vcs={vcs} vcenters={form.vcenters} collectMethod={form.collectMethod} onSavedShared={load} />

      {/* 물리(베어메탈) 서버 GPU 수집 — 가상화 안 한 서버 SSH nvidia-smi */}
      <PhysicalGpuManager vcs={vcs} />

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

/** VM별 계정 관리 — 법인 선택 → 패스쓰루 GPU VM 조회 → 공용/별도 선택 + 로그인/읽기 테스트(개별·일괄). */
function VmCredManager({ vcs, vcenters, collectMethod, onSavedShared }) {
  const [selVc, setSelVc] = useState('');
  const [rows, setRows] = useState(null);   // null=미조회, []=없음
  const [osFilter, setOsFilter] = useState('all'); // all | linux | windows
  const [powerFilter, setPowerFilter] = useState('all'); // all | on | off
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [testProg, setTestProg] = useState(null); // { done, total } 테스트 진행률(부분 갱신)
  const [selected, setSelected] = useState(() => new Set()); // 선택 테스트 대상 VM id
  const [testMethod, setTestMethod] = useState(''); // '' = 저장된 설정 방식 | guestops | ssh | auto
  const [revealCreds, setRevealCreds] = useState(false); // 디버그: 실행 로그에 실제 id/pw 평문
  const [logLines, setLogLines] = useState([]);   // 실행 로그 콘솔(명령/단계별)
  const [showLog, setShowLog] = useState(true);
  const logRef = useRef(null);
  const appendLog = (lines) => setLogLines((prev) => {
    const next = [...prev, ...lines];
    return next.length > 4000 ? next.slice(-4000) : next; // 상한(메모리 보호)
  });
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [logLines]);

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
        pwless: v.ownPwless ? true : undefined,  // true/false=명시 · undefined=자동(별도+id만+비번빈칸+저장없음)
        test: null,                              // {login,read,error,sample} | {pending}
      })));
    } catch (e) { setMsg(`오류: ${e.message}`); setRows([]); }
    finally { setLoading(false); }
  };

  // passwordless = 비번 없는 계정(빈 비번 인증). 별도 + 계정명 입력 + 비번 빈칸일 때:
  //   명시 토글(pwless=true) 또는 저장된 비번이 없으면(신규) 자동 인식.
  const isPwless = (r) => {
    if (r.mode !== 'own' || !(r.username || '').trim() || r.password) return false;
    if (r.pwless === true) return true;
    if (r.pwless === false) return false;
    return !r.hadOwn; // 자동: 저장된 비번 없는 신규 별도 계정
  };

  const pickVc = (vcId) => { setSelVc(vcId); setRows(null); loadVms(vcId); };
  const setRow = (id, patch) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const runTest = async (subset) => {
    const targets = subset || rows;
    if (!targets || !targets.length) return;
    // 도달 불가/느린 VM이 전체를 막지 않도록 작은 청크로 나눠 순차 처리하고, 끝나는 대로 행을 즉시 갱신한다.
    // 청크당 1 요청이라 길이가 짧아 프록시 유휴 끊김도 방지되고, 진행률로 멈춘 듯 보이지 않게 한다.
    const CHUNK = 4; // 서버 동시성(기본 4)에 맞춤 — 청크당 대략 1 웨이브
    const nameOf = (id) => (rows.find((r) => r.id === id)?.name) || id;
    const fmtT = (t) => { const d = new Date(t); return d.toLocaleTimeString('ko-KR', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0'); };
    const ids = new Set(targets.map((t) => t.id));
    setRows((rs) => rs.map((r) => (ids.has(r.id) ? { ...r, test: { pending: true } } : r)));
    setLogLines([]); setShowLog(true);
    setTestProg({ done: 0, total: targets.length });
    const nChunks = Math.ceil(targets.length / CHUNK);
    let done = 0;
    for (let off = 0; off < targets.length; off += CHUNK) {
      const chunk = targets.slice(off, off + CHUNK);
      const ci = Math.floor(off / CHUNK) + 1;
      appendLog([{ t: Date.now(), line: `━━━ 묶음 ${ci}/${nChunks} 시작 — ${chunk.map((r) => r.name).join(', ')}` }]);
      const items = chunk.map((r) => ({ vmId: r.id, useShared: r.mode === 'shared', username: r.mode === 'own' ? r.username : '', password: r.mode === 'own' ? r.password : '', passwordless: isPwless(r) }));
      try {
        const res = await postJson('/admin/gpu-guest/test', { vcenterId: selVc, items, ...(testMethod ? { method: testMethod } : {}), revealCreds });
        const byId = new Map((res.results || []).map((x) => [x.vmId, x]));
        setRows((rs) => rs.map((r) => (byId.has(r.id) ? { ...r, test: byId.get(r.id), _mock: res.mock } : r)));
        // 단계별 trace를 실행 로그에 누적(명령·다운로드·결과 등).
        const newLines = [];
        for (const x of res.results || []) {
          const nm = nameOf(x.vmId);
          for (const e of x.trace || []) newLines.push({ t: e.t, line: `${fmtT(e.t)} [${nm}] ${e.msg}` });
          const verdict = x.login && x.read ? '✅ 수집 준비 완료' : x.login ? `⚠ 로그인 OK / 읽기 실패 — ${x.error || ''}` : `❌ ${x.error || '실패'}`;
          newLines.push({ t: x.trace?.[x.trace.length - 1]?.t || Date.now(), line: `${fmtT(Date.now())} [${nm}] = ${verdict}` });
        }
        appendLog(newLines);
      } catch (e) {
        const cids = new Set(chunk.map((r) => r.id));
        setRows((rs) => rs.map((r) => (cids.has(r.id) ? { ...r, test: { error: e.message } } : r)));
        appendLog([{ t: Date.now(), line: `${fmtT(Date.now())} ✗ 묶음 ${ci} 요청 실패: ${e.message}` }]);
      }
      done += chunk.length;
      setTestProg({ done, total: targets.length });
    }
    appendLog([{ t: Date.now(), line: `━━━ 전체 완료 (${targets.length}대)` }]);
    setTestProg(null);
  };

  const saveCreds = async () => {
    if (!rows) return;
    setBusy(true); setMsg(null);
    try {
      const vms = {};
      for (const r of rows) {
        if (r.mode === 'own') {
          if (r.username) {
            vms[r.id] = isPwless(r)
              ? { username: r.username, passwordless: true }   // 비번없음 계정으로 저장
              : { username: r.username, ...(r.password ? { password: r.password } : {}) };
          }
        } else if (r.hadOwn) {
          vms[r.id] = null; // 공용으로 전환 → override 제거
        }
      }
      // SSH/auto로 테스트해 성공했는데 실제 수집 방식이 'VMware Tools만(guestops)'이면, 폴러는
      // SSH를 절대 시도하지 않아 "테스트는 되는데 수집은 안 됨"이 된다. 이때 수집 방식을 'auto'로
      // 올려 SSH 폴백을 켠다(게스트작업이 잘 되는 VM은 그대로, 막힌 VM만 SSH). 'ssh'로 강제하면
      // 게스트작업으로 잘 수집되던 VM이 끊길 수 있어 안전한 'auto'를 쓴다.
      const bumpToAuto = (testMethod === 'ssh' || testMethod === 'auto') && collectMethod === 'guestops';
      await putJson('/admin/gpu-guest/settings', {
        vcenters: { [selVc]: { vms } },
        ...(bumpToAuto ? { collectMethod: 'auto' } : {}),
      });
      setMsg(bumpToAuto
        ? "VM별 계정 저장 완료 — 수집 방식이 'VMware Tools만'이라 SSH 수집이 안 되던 걸 'auto(자동 폴백)'로 바꿔 켰습니다. 다음 주기부터 SSH로 수집됩니다."
        : 'VM별 계정을 저장했습니다. (수집 방식이 SSH/auto인지 위 설정에서 확인하세요)');
      if (bumpToAuto) onSavedShared?.();
      await loadVms(selVc);
    } catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };

  const vcShared = vcenters[selVc] || {};
  const isWin = (r) => /windows/i.test(r.guestOS || '');
  const isOn = (r) => r.powerState === 'POWERED_ON';
  const shown = rows ? rows.filter((r) =>
    (osFilter === 'all' ? true : osFilter === 'windows' ? isWin(r) : !isWin(r))
    && (powerFilter === 'all' ? true : powerFilter === 'on' ? isOn(r) : !isOn(r)),
  ) : rows;
  const ownCount = shown ? shown.filter((r) => r.mode === 'own').length : 0;
  const onCount = rows ? rows.filter(isOn).length : 0;

  return (
    <div className="card" style={{ padding: 16, marginTop: 14 }}>
      <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 8, gap: 8 }}>
        <b>VM별 계정 (계정이 VM마다 다를 때)</b>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <select className="select" value={osFilter} onChange={(e) => setOsFilter(e.target.value)} style={{ minWidth: 110 }} title="OS별로 구분해 보기">
            <option value="all">전체 OS</option>
            <option value="linux">🐧 Linux</option>
            <option value="windows">🪟 Windows</option>
          </select>
          <select className="select" value={powerFilter} onChange={(e) => setPowerFilter(e.target.value)} style={{ minWidth: 120 }} title="전원 상태로 구분해 보기 — 꺼진 VM은 수집 대상이 아닙니다.">
            <option value="all">전체 전원</option>
            <option value="on">🟢 켜짐</option>
            <option value="off">⚫ 꺼짐</option>
          </select>
          <select className="select" value={selVc} onChange={(e) => pickVc(e.target.value)} style={{ minWidth: 200 }}>
            <option value="">법인(vCenter) 선택…</option>
            {vcs.map((vc) => <option key={vc.id} value={vc.id}>{vc.name || vc.id}</option>)}
          </select>
          <button className="logout-btn" style={{ padding: '7px 12px' }} disabled={!selVc || loading} onClick={() => loadVms(selVc)}>{loading ? '조회 중…' : '↻ VM 조회'}</button>
        </div>
      </div>

      {!selVc && <div className="muted" style={{ fontSize: 13 }}>법인을 선택하면 그 법인에서 <b>GPU(패스쓰루·vGPU)</b>를 쓰는 VM 목록을 불러옵니다.</div>}
      {selVc && rows && rows.length === 0 && !loading && <div className="muted" style={{ fontSize: 13 }}>이 법인에 GPU 할당 VM이 없습니다.</div>}

      {selVc && rows && rows.length > 0 && (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            공용 계정 — 🐧Linux <b>{vcShared.username || '(미설정)'}</b>{vcShared.hasPassword ? '·비번O' : ''} · 🪟Windows <b>{vcShared.winUsername || '(Linux로 폴백)'}</b>{vcShared.hasWinPassword ? '·비번O' : ''} · {(osFilter === 'all' && powerFilter === 'all') ? `VM ${rows.length}개` : `표시 ${shown.length}/${rows.length}개`} · 🟢켜짐 {onCount} · ⚫꺼짐 {rows.length - onCount} · 별도 계정 {ownCount}개
          </div>
          <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
            <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
              <thead><tr>
                <th style={{ textAlign: 'center', width: 28 }}>
                  <input type="checkbox" title="표시된 VM 전체 선택/해제"
                    checked={shown.length > 0 && shown.every((r) => selected.has(r.id))}
                    onChange={(e) => setSelected(() => (e.target.checked ? new Set(shown.map((r) => r.id)) : new Set()))} />
                </th>
                <th style={{ textAlign: 'left' }}>VM</th>
                <th style={{ textAlign: 'left' }}>호스트</th>
                <th style={{ textAlign: 'left' }}>상태</th>
                <th style={{ textAlign: 'left' }}>수집(읽기)</th>
                <th style={{ textAlign: 'left' }}>계정 방식</th>
                <th style={{ textAlign: 'left' }}>계정 / 비밀번호</th>
                <th style={{ textAlign: 'left' }}>테스트</th>
              </tr></thead>
              <tbody>
                {shown.length === 0 && <tr><td colSpan={8} className="muted" style={{ padding: 14, textAlign: 'center' }}>해당 OS({osFilter})의 VM이 없습니다.</td></tr>}
                {shown.map((r) => {
                  const ready = r.powerState === 'POWERED_ON' && r.toolsStatus === 'RUNNING';
                  return (
                    <tr key={r.id} style={selected.has(r.id) ? { background: 'rgba(34,211,238,.06)' } : undefined}>
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" checked={selected.has(r.id)}
                          onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })} />
                      </td>
                      <td><VmLink name={r.name} vcenterId={selVc} label={r.name} item={r} /><div className="muted" style={{ fontSize: 11 }}>{r.guestOS || ''}</div></td>
                      <td className="muted" style={{ fontSize: 12, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.host}>{r.host}</td>
                      <td style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                        <span className={`badge ${r.powerState === 'POWERED_ON' ? 'green' : 'gray'}`}>{r.powerState === 'POWERED_ON' ? 'On' : 'Off'}</span>{' '}
                        <span className={`badge ${r.toolsStatus === 'RUNNING' ? 'green' : 'amber'}`}>Tools {r.toolsStatus === 'RUNNING' ? 'OK' : (r.toolsStatus || '—')}</span>
                      </td>
                      <td style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                        {r.collected
                          ? <span className="badge green" title={`마지막 수집 ${fmtAgo(r.collected.at)}`}>● {r.collected.utilPct}% <span style={{ opacity: 0.7 }}>{fmtAgo(r.collected.at)}</span></span>
                          : <span className="badge gray" title="아직 게스트에서 사용률을 읽어오지 못함">미수집</span>}
                      </td>
                      <td>
                        <select className="select" value={r.mode} onChange={(e) => setRow(r.id, { mode: e.target.value })} style={{ width: 84 }}>
                          <option value="shared">공용</option>
                          <option value="own">별도</option>
                        </select>
                      </td>
                      <td>
                        {r.mode === 'own' ? (
                          <div className="flex gap" style={{ gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                            <input className="input" style={{ width: 104 }} placeholder="계정(root 등)" value={r.username} onChange={(e) => setRow(r.id, { username: e.target.value })} />
                            <input className="input" type="password" style={{ width: 120 }} disabled={isPwless(r)}
                              placeholder={isPwless(r) ? '비번없음' : (r.hadOwn ? '저장됨 · 변경시 입력' : '비밀번호 (비우면 비번없음)')}
                              title={r.hadOwn ? '저장된 비밀번호가 있습니다. 새 비밀번호로 테스트/저장하려면 여기에 입력하세요(비워두면 저장된 값 사용).' : '이 VM 계정의 비밀번호(비우면 passwordless로 인증)'}
                              value={isPwless(r) ? '' : r.password} onChange={(e) => setRow(r.id, { password: e.target.value })} />
                            <label className="flex gap" style={{ alignItems: 'center', fontSize: 11, whiteSpace: 'nowrap' }}
                              title="비번 없는 계정(빈 비밀번호로 인증). 저장된 비번으로 폴백하지 않습니다.">
                              <input type="checkbox" checked={isPwless(r)} onChange={(e) => setRow(r.id, { pwless: e.target.checked, ...(e.target.checked ? { password: '' } : {}) })} />
                              <span style={{ color: isPwless(r) ? 'var(--accent-2,#22d3ee)' : 'var(--muted,#8b9bb4)' }}>🔓 비번없음</span>
                            </label>
                          </div>
                        ) : <span className="muted" style={{ fontSize: 12 }}>공용 계정</span>}
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
            <button className="login-btn" style={{ flex: 'none', padding: '8px 14px' }} disabled={!!testProg || selected.size === 0}
              title={selected.size === 0 ? '체크박스로 VM을 선택하세요' : `선택한 ${selected.size}대만 테스트`}
              onClick={() => runTest(rows.filter((r) => selected.has(r.id)))}>✅ 선택 테스트 ({selected.size})</button>
            <button className="logout-btn" style={{ padding: '8px 14px' }} disabled={!!testProg} onClick={() => runTest(shown)}>⚡ {osFilter === 'all' ? '모두' : osFilter} 테스트</button>
            {selected.size > 0 && <button className="tab" style={{ padding: '6px 10px', fontSize: 12 }} onClick={() => setSelected(new Set())}>선택 해제</button>}
            <label className="flex gap" style={{ alignItems: 'center', fontSize: 12 }} title="테스트 수집 방식. SSH=게스트 IP로 직접 접속해 nvidia-smi(VMware Tools 게스트작업 인증이 막힐 때). auto=SSH 우선 실패 시 게스트작업.">
              <span className="muted">방식</span>
              <select className="select" style={{ width: 120 }} value={testMethod} onChange={(e) => setTestMethod(e.target.value)}>
                <option value="">설정값</option>
                <option value="auto">auto(자동 폴백)</option>
                <option value="guestops">VMware Tools</option>
                <option value="ssh">SSH 직접</option>
              </select>
            </label>
            <label className="flex gap" style={{ alignItems: 'center', fontSize: 12 }} title="실행 로그에 실제 전송되는 ID/비밀번호를 평문으로 표시(디버그). 이 응답에만 보이고 디스크/중앙에는 기록되지 않습니다.">
              <input type="checkbox" checked={revealCreds} onChange={(e) => setRevealCreds(e.target.checked)} /> 🔓 자격증명 평문(디버그)
            </label>
            <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy} onClick={saveCreds}>{busy ? '저장 중…' : 'VM별 계정 저장'}</button>
            {testProg && (
              <span className="badge teal" style={{ fontSize: 12 }}>
                테스트 중 {testProg.done}/{testProg.total} ({Math.round((testProg.done / testProg.total) * 100)}%) — 끝나는 대로 표시됩니다
              </span>
            )}
            {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            도달 불가/느린 VM은 한 대당 수십 초가 걸릴 수 있어, 작은 묶음으로 나눠 끝나는 대로 행을 갱신합니다(전체가 멈추지 않음). 한 대만 빠르게 보려면 행의 “테스트”를 누르세요.
          </div>

          {logLines.length > 0 && (
            <div className="card" style={{ marginTop: 12, padding: 0, overflow: 'hidden' }}>
              <div className="flex between" style={{ alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid rgba(36,48,73,.6)' }}>
                <b style={{ fontSize: 13 }}>🖥 실행 로그 <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>({logLines.length}줄 · 게스트 작업 명령/단계)</span></b>
                <div className="flex gap" style={{ alignItems: 'center' }}>
                  <button className="tab" style={{ padding: '4px 10px', fontSize: 12 }}
                    onClick={() => navigator.clipboard?.writeText(logLines.map((l) => l.line).join('\n')).catch(() => {})}>복사</button>
                  <button className="tab" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setLogLines([])}>지우기</button>
                  <button className="tab" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setShowLog((v) => !v)}>{showLog ? '접기' : '펼치기'}</button>
                </div>
              </div>
              {showLog && (
                <pre ref={logRef} style={{
                  margin: 0, padding: '10px 12px', maxHeight: 320, overflow: 'auto',
                  fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12, lineHeight: 1.55,
                  background: '#0a0f1a', color: '#cbd5e1', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                }}>
                  {logLines.map((l, i) => {
                    const ok = /✓|✅|성공|준비 완료/.test(l.line);
                    const bad = /✗|❌|실패|타임아웃|오류|건너뜀/.test(l.line);
                    const hdr = l.line.startsWith('━━━');
                    const color = hdr ? '#7dd3fc' : ok ? '#86efac' : bad ? '#fca5a5' : l.line.includes('명령:') ? '#fcd34d' : '#cbd5e1';
                    return <div key={i} style={{ color, fontWeight: hdr || l.line.includes('명령:') ? 600 : 400 }}>{l.line}</div>;
                  })}
                </pre>
              )}
            </div>
          )}
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
      {t.sample && <span className="muted">{t.sample.utilNA ? 'N/A(MIG)' : `${t.sample.utilPct}%`} · {t.sample.gpus}GPU</span>}
      {!t.read && t.error && <span className="muted" title={t.error}>({t.error})</span>}
    </span>
  );
}

const PEMPTY = { id: '', name: '', host: '', port: 22, username: 'root', password: '', os: 'linux', vcenterId: '', enabled: true };

/** 물리(베어메탈) 서버 GPU 수집 — 가상화 안 한 서버를 IP+계정으로 등록해 SSH nvidia-smi로 수집. */
function PhysicalGpuManager({ vcs }) {
  const [d, setD] = useState(null);
  const [form, setForm] = useState(null);   // 추가/수정 폼
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [testing, setTesting] = useState(null); // id 또는 'form'
  const [testRes, setTestRes] = useState(null);
  const [auto, setAuto] = useState({ host: '', username: 'root', password: '', port: 22, vcenterId: '' });
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoMsg, setAutoMsg] = useState(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkIps, setBulkIps] = useState('');
  const [bulkForce, setBulkForce] = useState(true);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkRes, setBulkRes] = useState(null);
  const setA = (k) => (e) => setAuto((a) => ({ ...a, [k]: e.target.value }));
  const autoRegister = async (force = false) => {
    if (!auto.host.trim() || !auto.username.trim()) { setAutoMsg({ ok: false, text: 'IP와 계정을 입력하세요.' }); return; }
    setAutoBusy(true); setAutoMsg(null);
    const r = await postJson('/admin/gpu-physical/auto-register', { ...auto, force }).catch((e) => ({ ok: false, reason: e.message }));
    setAutoBusy(false);
    if (r.ok) {
      const models = [...new Set(r.detected?.gpuModels || [])];
      setAutoMsg({ ok: true, text: r.noGpu
        ? `✅ ${r.updated ? '갱신' : '등록'}됨(드라이버 미설치) — ${r.detected?.hostname || auto.host}. 드라이버 설치 후 자동 수집됩니다.`
        : `✅ ${r.updated ? '갱신' : '등록'}됨 — ${r.detected?.hostname || auto.host} · GPU ${r.detected?.gpuModels?.length || 0}장 (${models.join(', ')}) · ${/win/i.test(r.detected?.os || '') ? 'Windows' : 'Linux'}` });
      setAuto((a) => ({ ...a, host: '', password: '' }));
      await load();
      return;
    }
    // 로그인은 됐는데 GPU/드라이버 미발견 → 그래도 등록할지 확인 후 force 재시도.
    if (r.noGpu) {
      if (window.confirm('로그인은 되었지만 드라이버가 설치되어 있지 않은 것 같습니다(nvidia-smi 미발견).\n수집 서버에 일단 등록하시겠습니까? (드라이버 설치 후 자동으로 수집됩니다)')) {
        await autoRegister(true);
      } else { setAutoMsg({ ok: false, text: '등록을 취소했습니다(드라이버 미발견).' }); }
      return;
    }
    setAutoMsg({ ok: false, text: r.reason || '자동 등록 실패' });
  };
  const bulkRegister = async () => {
    if (!bulkIps.trim() || !auto.username.trim()) { setBulkRes({ error: 'IP 목록과 계정(위 자동 등록의 계정 칸)을 입력하세요.' }); return; }
    setBulkBusy(true); setBulkRes(null);
    const r = await postJson('/admin/gpu-physical/bulk-auto-register', { ips: bulkIps, username: auto.username, password: auto.password, port: auto.port, vcenterId: auto.vcenterId, force: bulkForce }).catch((e) => ({ ok: false, reason: e.message }));
    setBulkBusy(false);
    setBulkRes(r.ok ? r : { error: r.reason || '일괄 등록 실패' });
    if (r.ok) await load();
  };
  const load = () => fetchJson('/admin/gpu-physical').then(setD).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, []);
  const results = new Map((d?.results || []).map((r) => [r.id, r]));
  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const openAdd = () => { setEditing(false); setForm({ ...PEMPTY }); setMsg(null); setTestRes(null); };
  const openEdit = (s) => { setEditing(true); setForm({ ...PEMPTY, ...s, password: '' }); setMsg(null); setTestRes(null); };
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = editing ? await putJson(`/admin/gpu-physical/${encodeURIComponent(form.id)}`, form) : await postJson('/admin/gpu-physical', form);
      if (r.ok) { setForm(null); await load(); } else setMsg(r.reason || '저장 실패');
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };
  const del = async (s) => { if (window.confirm(`'${s.name}' 삭제?`)) { await delJson(`/admin/gpu-physical/${encodeURIComponent(s.id)}`).catch(() => {}); await load(); } };
  const test = async (payload, who) => {
    setTesting(who); setTestRes(null);
    const r = await postJson('/admin/gpu-physical/test', payload).catch((e) => ({ ok: false, error: e.message }));
    setTesting(null); setTestRes({ who, ...r });
  };
  const pollNow = async () => { setBusy(true); await postJson('/admin/gpu-physical/poll', {}).catch(() => {}); await load(); setBusy(false); };

  return (
    <div className="card" style={{ padding: 16, marginTop: 14 }}>
      <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 8, gap: 8 }}>
        <b>🖥 물리 서버 GPU 수집 <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>(가상화 안 한 베어메탈 — SSH nvidia-smi)</span></b>
        <div className="flex gap">
          <button className="logout-btn" style={{ padding: '7px 12px' }} disabled={busy} onClick={pollNow}>↻ 지금 수집</button>
          <button className="login-btn" style={{ flex: 'none', padding: '7px 14px' }} onClick={openAdd}>+ 서버 추가</button>
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        ESXi/VM이 아닌 <b>물리 서버</b>에 직접 SSH로 접속해 <code>nvidia-smi</code>로 GPU 사용률을 수집합니다(주기는 위 '수집 주기' 공유). 서버 OS에 NVIDIA 드라이버 + SSH가 있어야 합니다.
      </div>

      {/* ⚡ 자동 등록 — IP+ID+PW+소속 vCenter만 넣으면 로그인해 GPU/OS/호스트명을 감지해 등록 */}
      <div className="card" style={{ padding: 12, marginBottom: 12, border: '1px solid var(--accent)' }}>
        <b style={{ fontSize: 13 }}>⚡ 자동 등록 <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>— IP·계정·소속만 넣으면 로그인해 GPU·OS·호스트명을 자동 감지해 등록</span></b>
        <div className="flex gap wrap" style={{ marginTop: 8, alignItems: 'flex-end' }}>
          <Field label="IP/호스트 *"><input className="input" style={{ width: 160 }} value={auto.host} onChange={setA('host')} placeholder="10.94.46.94" onKeyDown={(e) => e.key === 'Enter' && autoRegister()} /></Field>
          <Field label="계정 *"><input className="input" style={{ width: 120 }} value={auto.username} onChange={setA('username')} placeholder="root" /></Field>
          <Field label="비밀번호"><input className="input" type="password" style={{ width: 130 }} value={auto.password} onChange={setA('password')} onKeyDown={(e) => e.key === 'Enter' && autoRegister()} /></Field>
          <Field label="포트"><input className="input" type="number" style={{ width: 70 }} value={auto.port} onChange={setA('port')} /></Field>
          <Field label="소속 vCenter"><select className="select" value={auto.vcenterId} onChange={setA('vcenterId')} style={{ minWidth: 140 }}><option value="">(없음)</option>{vcs.map((v) => <option key={v.id} value={v.id}>{v.name || v.id}</option>)}</select></Field>
          <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={autoBusy} onClick={() => autoRegister()}>{autoBusy ? '로그인·감지 중…' : '🔍 로그인 후 자동 등록'}</button>
          <button className="logout-btn" style={{ flex: 'none', padding: '9px 14px' }} onClick={() => setBulkOpen((v) => !v)}>📋 여러 IP 일괄 등록</button>
        </div>
        {autoMsg && <div style={{ marginTop: 8, fontSize: 13, color: autoMsg.ok ? 'var(--green)' : 'var(--red)' }}>{autoMsg.text}</div>}

        {bulkOpen && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(148,163,184,.2)' }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              IP를 한 줄에 하나씩(또는 범위 <code>10.0.0.1-20</code> · CIDR <code>10.0.0.0/24</code>). <b>계정·비밀번호·포트·소속 vCenter는 위 칸 값을 공통 사용</b>합니다. 각 IP에 SSH 로그인해 GPU를 감지·등록합니다(최대 512개).
            </div>
            <textarea className="input" style={{ width: '100%', minHeight: 90, fontFamily: 'monospace', fontSize: 12 }} value={bulkIps} onChange={(e) => setBulkIps(e.target.value)} placeholder={'10.94.46.94\n10.94.46.95\n10.94.46.0/24'} />
            <div className="flex gap" style={{ alignItems: 'center', marginTop: 8 }}>
              <label className="flex gap muted" style={{ alignItems: 'center', fontSize: 12 }}><input type="checkbox" checked={bulkForce} onChange={(e) => setBulkForce(e.target.checked)} /> 드라이버 없어도 등록(로그인만 되면)</label>
              <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={bulkBusy} onClick={bulkRegister}>{bulkBusy ? '일괄 처리 중… (시간이 걸립니다)' : '일괄 등록 실행'}</button>
            </div>
            {bulkRes && (bulkRes.error ? <div style={{ marginTop: 8, fontSize: 13, color: 'var(--red)' }}>{bulkRes.error}</div> : (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 13, marginBottom: 6 }}>완료 — 대상 <b>{bulkRes.total}</b> · 등록/갱신 <b style={{ color: 'var(--green)' }}>{bulkRes.registered}</b> · 실패 {bulkRes.total - bulkRes.registered}{bulkRes.truncated ? ' · ⚠ 512개 초과분 생략' : ''}</div>
                <div style={{ maxHeight: 220, overflow: 'auto' }}>
                  <table className="data-table" style={{ width: '100%', fontSize: 12 }}>
                    <thead><tr><th style={{ textAlign: 'left' }}>IP</th><th style={{ textAlign: 'left' }}>결과</th></tr></thead>
                    <tbody>{(bulkRes.results || []).map((x) => (
                      <tr key={x.ip}><td className="tabular">{x.ip}</td>
                        <td>{x.ok ? <span style={{ color: 'var(--green)' }}>✅ {x.updated ? '갱신' : '등록'}{x.host ? ` · ${x.host}` : ''}{x.noGpu ? ' (드라이버 미설치)' : ` · GPU ${x.gpuCount}`}</span>
                          : x.noGpu ? <span className="muted">로그인 OK · GPU 없음(미등록)</span>
                            : <span style={{ color: 'var(--red)' }}>❌ {x.error || '접속 실패'}</span>}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
          <thead><tr><th style={{ textAlign: 'left' }}>이름</th><th style={{ textAlign: 'left' }}>IP/계정</th><th style={{ textAlign: 'left' }}>소속</th><th style={{ textAlign: 'left' }}>GPU/사용률</th><th style={{ textAlign: 'left' }}>상태</th><th style={{ textAlign: 'right' }}>작업</th></tr></thead>
          <tbody>
            {(d?.servers || []).length === 0 && <tr><td colSpan={6} className="center muted" style={{ padding: 18 }}>등록된 물리 GPU 서버가 없습니다.</td></tr>}
            {(d?.servers || []).map((s) => {
              const r = results.get(s.id);
              return (
                <tr key={s.id}>
                  <td><b>{s.name}</b></td>
                  <td className="muted">{s.host}:{s.port} · {s.username} · {s.os}</td>
                  <td className="muted">{s.vcenterId || '—'}</td>
                  <td className="tabular">{r && r.error ? <span className="badge red" title={r.error}>오류</span> : r && r.count != null ? <span>{r.utilNA ? 'N/A(MIG)' : `${r.utilPct}%`} · {r.count}GPU{r.memUsedPct != null ? ` · mem ${r.memUsedPct}%` : ''}</span> : <span className="muted">—</span>}</td>
                  <td>{s.enabled ? <span className="badge green">수집</span> : <span className="badge gray">중지</span>}</td>
                  <td className="right nowrap">
                    <button className="tab" disabled={testing === s.id} onClick={() => test({ id: s.id }, s.id)}>{testing === s.id ? '테스트…' : '테스트'}</button>
                    <button className="tab" onClick={() => openEdit(s)}>수정</button>
                    <button className="tab" style={{ color: 'var(--red)' }} onClick={() => del(s)}>삭제</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {testRes && testRes.who !== 'form' && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          {testRes.read ? `✅ ${testRes.host}: 수집 OK — ${testRes.sample?.gpus}GPU · ${testRes.sample?.utilNA ? 'N/A(MIG)' : testRes.sample?.utilPct + '%'}` : `❌ ${testRes.host}: ${testRes.error || (testRes.login ? '읽기 실패' : '로그인 실패')}`}
        </div>
      )}

      {form && (
        <div className="card" style={{ padding: 14, marginTop: 12, border: '1px solid var(--accent)' }}>
          <b style={{ fontSize: 14 }}>{editing ? `서버 수정 — ${form.id}` : '새 물리 GPU 서버'}</b>
          <div className="flex gap wrap" style={{ marginTop: 10 }}>
            <Field label="이름"><input className="input" style={{ width: 150 }} value={form.name} onChange={setF('name')} placeholder="GPU-NODE-01" /></Field>
            <Field label="IP/호스트 *"><input className="input" style={{ width: 170 }} value={form.host} onChange={setF('host')} placeholder="10.94.46.94" /></Field>
            <Field label="SSH 포트"><input className="input" type="number" style={{ width: 80 }} value={form.port} onChange={setF('port')} /></Field>
            <Field label="계정 *"><input className="input" style={{ width: 130 }} value={form.username} onChange={setF('username')} placeholder="root" /></Field>
            <Field label={`비밀번호${editing ? ' (비우면 유지)' : ''}`}><input className="input" type="password" style={{ width: 140 }} value={form.password} onChange={setF('password')} /></Field>
            <Field label="OS"><select className="select" value={form.os} onChange={setF('os')}><option value="linux">Linux</option><option value="windows">Windows</option></select></Field>
            <Field label="소속 vCenter(선택)"><select className="select" value={form.vcenterId} onChange={setF('vcenterId')} style={{ minWidth: 150 }}><option value="">(없음)</option>{vcs.map((v) => <option key={v.id} value={v.id}>{v.name || v.id}</option>)}</select></Field>
          </div>
          <div className="flex gap" style={{ marginTop: 12, alignItems: 'center' }}>
            <button className="logout-btn" style={{ padding: '8px 14px' }} disabled={testing === 'form' || !form.host || !form.username} onClick={() => test({ host: form.host, username: form.username, password: form.password, port: form.port }, 'form')}>{testing === 'form' ? '테스트 중…' : 'SSH 테스트'}</button>
            <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy} onClick={save}>{busy ? '저장 중…' : (editing ? '수정' : '추가')}</button>
            <button className="tab" style={{ padding: '8px 12px' }} onClick={() => setForm(null)}>취소</button>
            {testRes && testRes.who === 'form' && <span className="muted" style={{ fontSize: 12 }}>{testRes.read ? `✅ 수집 OK — ${testRes.sample?.gpus}GPU · ${testRes.sample?.utilNA ? 'N/A(MIG)' : testRes.sample?.utilPct + '%'}` : `❌ ${testRes.error || (testRes.login ? '읽기 실패' : '로그인 실패')}`}</span>}
            {msg && <span className="badge red" style={{ fontSize: 12 }}>{msg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return <div><label className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>{label}</label>{children}</div>;
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
