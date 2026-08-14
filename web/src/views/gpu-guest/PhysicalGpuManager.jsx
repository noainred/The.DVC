// gpu-guest/PhysicalGpuManager.jsx — GpuGuestSettings.jsx(구 891줄)에서 분리(v2.295, 1차 감사
// 확정 #4). 본문은 원본 671~874행 그대로(PEMPTY·PGPU_ERR_COLOR 동봉 — 이 컴포넌트 전용 상수).
// 분리 이유: 물리 GPU 서버(베어메탈, /admin/gpu-physical)는 게스트 수집(/admin/gpu-guest)과
// 백엔드 API·데이터모델이 다른 별개 도메인인데 UI 만 동거 중이었다(git 이력도 별도 커밋 웨이브
// — 물리 v2.29~2.32 / 게스트 v2.166~2.170). 분리로 병렬 세션 간 같은 파일 충돌 표면 축소.
import React, { useEffect, useState } from 'react';
import { fetchJson, putJson, postJson, delJson } from '../../api.js';
import { Field } from './shared.jsx';

const PEMPTY = { id: '', name: '', host: '', port: 22, username: 'root', password: '', os: 'linux', vcenterId: '', enabled: true };
// 오류 분류별 배지 색: 로그인 안됨=red · 드라이버 없음=amber · 접속 불가=gray · 기타=red
const PGPU_ERR_COLOR = { login: 'red', nodriver: 'amber', unreachable: 'gray', error: 'red' };

/** 물리(베어메탈) 서버 GPU 수집 — 가상화 안 한 서버를 IP+계정으로 등록해 SSH nvidia-smi로 수집. */
export function PhysicalGpuManager({ vcs }) {
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

      {(d?.servers || []).length > 0 && (() => {
        const rs = d.servers.map((s) => results.get(s.id)).filter(Boolean);
        const c = { ok: rs.filter((r) => r.count != null).length, login: 0, nodriver: 0, unreachable: 0, error: 0 };
        for (const r of rs) if (r.error) c[r.errorCode || 'error'] = (c[r.errorCode || 'error'] || 0) + 1;
        return (
          <div className="flex gap wrap" style={{ fontSize: 12, marginBottom: 8 }}>
            <span className="badge green">수집 {c.ok}</span>
            {c.login > 0 && <span className="badge red">로그인 안됨 {c.login}</span>}
            {c.nodriver > 0 && <span className="badge amber">드라이버 없음 {c.nodriver}</span>}
            {c.unreachable > 0 && <span className="badge gray">접속 불가 {c.unreachable}</span>}
            {c.error > 0 && <span className="badge red">오류 {c.error}</span>}
          </div>
        );
      })()}

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
                  <td className="tabular">{r && r.count != null ? <span>{r.utilNA ? 'N/A(MIG)' : `${r.utilPct}%`} · {r.count}GPU{r.memUsedPct != null ? ` · mem ${r.memUsedPct}%` : ''}</span> : <span className="muted">—</span>}</td>
                  <td>{!s.enabled ? <span className="badge gray">중지</span>
                    : r && r.error ? <span className={`badge ${PGPU_ERR_COLOR[r.errorCode] || 'red'}`} title={r.error}>{r.errorLabel || '오류'}</span>
                      : r && r.count != null ? <span className="badge green">수집</span>
                        : <span className="badge gray">대기</span>}</td>
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
