import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, putJson, postJson } from '../api.js';
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
  const [osFilter, setOsFilter] = useState('all'); // all | linux | windows
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [testProg, setTestProg] = useState(null); // { done, total } 테스트 진행률(부분 갱신)
  const [selected, setSelected] = useState(() => new Set()); // 선택 테스트 대상 VM id
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
        const res = await postJson('/admin/gpu-guest/test', { vcenterId: selVc, items });
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
      await putJson('/admin/gpu-guest/settings', { vcenters: { [selVc]: { vms } } });
      setMsg('VM별 계정을 저장했습니다.');
      await loadVms(selVc);
    } catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };

  const vcShared = vcenters[selVc] || {};
  const isWin = (r) => /windows/i.test(r.guestOS || '');
  const shown = rows ? rows.filter((r) => (osFilter === 'all' ? true : osFilter === 'windows' ? isWin(r) : !isWin(r))) : rows;
  const ownCount = shown ? shown.filter((r) => r.mode === 'own').length : 0;

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
            공용 계정 — 🐧Linux <b>{vcShared.username || '(미설정)'}</b>{vcShared.hasPassword ? '·비번O' : ''} · 🪟Windows <b>{vcShared.winUsername || '(Linux로 폴백)'}</b>{vcShared.hasWinPassword ? '·비번O' : ''} · {osFilter === 'all' ? `VM ${rows.length}개` : `${osFilter} ${shown.length}/${rows.length}개`} · 별도 계정 {ownCount}개
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
  const mk = (s) => ({ enabled: !!s.enabled, username: s.username || '', hasPassword: !!s.hasPassword, password: '', winUsername: s.winUsername || '', hasWinPassword: !!s.hasWinPassword, winPassword: '' });
  for (const vc of vcs) vcenters[vc.id] = mk(settings.vcenters?.[vc.id] || {});
  for (const [id, s] of Object.entries(settings.vcenters || {})) { if (!vcenters[id]) vcenters[id] = mk(s); }
  return {
    enabled: !!settings.enabled, pollIntervalMs: settings.pollIntervalMs || 60000, concurrency: settings.concurrency || 4,
    timeoutMs: settings.timeoutMs || 20000, maxVmsPerVcenter: settings.maxVmsPerVcenter || 1000, vcenters,
  };
}
