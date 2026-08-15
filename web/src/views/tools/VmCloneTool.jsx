import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, postJson, delJson } from '../../api.js';
import { Loading, ErrorBox, SearchBox } from '../../components/ui.jsx';

/**
 * 특수기능 › VM 복제(백업)(v2.299, admin 전용) — 사용자 요구사항:
 *  - 각 vCenter 에서 VM 을 지정해 복제 잡 등록(트리에는 'Clone' 배지 표시 — VCenterDetail)
 *  - 스케줄(매일 HH:MM / N시간 간격)로 정기 복제 = 백업처럼 사용
 *  - 대상: 다른 데이터스토어(서버측 클론) / NFS(Edge 노드 마운트 — 설정 › NFS 마운트에서 관리)
 *  - 보존 개수(최근 N개 유지 — 오래된 것부터 자동 삭제, datastore 는 우리가 만든 클론 원장만)
 * 실행은 서버의 전역 직렬 큐(한 번에 1개) — 여기서는 등록/실행/현황만 본다.
 */
const MODE_LABEL = { manual: '수동만', daily: '매일', interval: '간격' };

export default function VmCloneTool() {
  const [d, setD] = useState(null);          // { jobs, status, mounts }
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(null);    // 잡 추가/수정 폼 | null

  const load = () => fetchJson('/tools/vm-clone').then((r) => { setD(r); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, []);

  if (err && !d) return <ErrorBox message={err} />;
  if (!d) return <Loading />;
  const running = d.status?.running;

  const runNow = async (id) => {
    setBusy(true); setMsg(null);
    try { const r = await postJson(`/tools/vm-clone/jobs/${encodeURIComponent(id)}/run`, {}); setMsg(r.ok ? '실행 큐에 넣었습니다(한 번에 1개씩 직렬 실행).' : `실행 불가: ${r.reason}`); await load(); }
    catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(false); }
  };
  const remove = async (j) => {
    if (!window.confirm(`'${j.vmName}' 복제 잡을 삭제할까요?\n(만들어 둔 클론/NFS 사본은 지우지 않습니다 — 잡 정의만 삭제)`)) return;
    setBusy(true); setMsg(null);
    try { await delJson(`/tools/vm-clone/jobs/${encodeURIComponent(j.id)}`); await load(); }
    catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 10 }}>
        <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={() => setForm({ vcenterId: '', vmId: '', vmName: '', dest: { type: 'datastore', datastoreName: '' }, schedule: { mode: 'daily', time: '02:00' }, keep: 3, quiesce: false, enabled: true })}>+ 복제 잡 추가</button>
        {running
          ? <span className="badge amber">실행 중 — {d.jobs.find((j) => j.id === running.jobId)?.vmName || running.jobId} · {running.phase}</span>
          : <span className="muted" style={{ fontSize: 12 }}>유휴 · 대기 {d.status?.queued?.length || 0}건</span>}
        {msg && <span className="muted" style={{ fontSize: 12.5 }}>{msg}</span>}
      </div>

      <div className="card" style={{ padding: '9px 13px', marginBottom: 12, fontSize: 12, lineHeight: 1.7 }} >
        <b>동작</b>: 스냅샷(선택 시 정지점) → <b>스냅샷 시점 복제</b>(켜진 VM 무중단) → 스냅샷 삭제 → 보존 N개 유지.
        데이터스토어 대상은 vCenter 가 서버측에서 복사하고(포탈 경유 없음), NFS 대상은 이 노드의 마운트 경로로 베이스 파일(vmx·vmdk)을 받습니다(스냅샷 델타·스왑 제외).
        사본은 <b>꺼진 상태로</b> 만들어집니다 — 같은 네트워크에서 켜면 원본과 IP/호스트명이 충돌하니 주의하세요.
      </div>

      {form && <JobForm d={d} form={form} setForm={setForm} onSaved={() => { setForm(null); load(); }} />}

      <div className="table-wrap" style={{ maxHeight: '46vh' }}>
        <table>
          <thead><tr><th>VM</th><th>vCenter</th><th>대상</th><th>스케줄</th><th style={{ textAlign: 'right' }}>보존</th><th>정지점</th><th>보유 사본</th><th>최근 실행</th><th className="right">작업</th></tr></thead>
          <tbody>
            {d.jobs.length === 0 && <tr><td colSpan={9} className="center muted" style={{ padding: 22 }}>복제 잡이 없습니다 — "+ 복제 잡 추가"로 vCenter별 VM 을 지정하세요.</td></tr>}
            {d.jobs.map((j) => (
              <tr key={j.id} style={{ opacity: j.enabled ? 1 : 0.55 }}>
                <td><b>{j.vmName}</b>{!j.enabled && <span className="badge gray" style={{ marginLeft: 6 }}>비활성</span>}</td>
                <td className="muted">{j.vcenterId}</td>
                <td>{j.dest.type === 'datastore' ? <span className="badge blue">DS · {j.dest.datastoreName}</span> : <span className="badge purple">NFS · {(d.mounts.find((m) => m.id === j.dest.mountId) || {}).server || j.dest.mountId}{j.dest.subdir ? `/${j.dest.subdir}` : ''}</span>}</td>
                <td className="muted" style={{ fontSize: 12 }}>{MODE_LABEL[j.schedule.mode]}{j.schedule.mode === 'daily' ? ` ${j.schedule.time}` : j.schedule.mode === 'interval' ? ` ${j.schedule.hours}h` : ''}</td>
                <td style={{ textAlign: 'right' }}>{j.keep}</td>
                <td>{j.quiesce ? <span className="badge green">앱 정합</span> : <span className="badge gray">크래시 정합</span>}</td>
                <td className="muted" style={{ fontSize: 11.5 }}>{j.dest.type === 'datastore' ? `${(j.clones || []).length}개${(j.clones || []).length ? ` · 최신 ${(j.clones[j.clones.length - 1] || {}).name || ''}` : ''}` : 'NFS 디렉터리 참조'}</td>
                <td style={{ fontSize: 11.5 }}>
                  {j.lastRun
                    ? <span style={{ color: j.lastRun.ok ? 'var(--green)' : 'var(--red)' }} title={j.lastRun.detail}>{j.lastRun.ok ? '✅' : '⛔'} {new Date(j.lastRun.at).toLocaleString('ko-KR')} · {Math.round((j.lastRun.ms || 0) / 1000)}s<div className="muted" style={{ fontSize: 10.5, maxWidth: 260, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.lastRun.detail}</div></span>
                    : <span className="muted">—</span>}
                </td>
                <td className="right" style={{ whiteSpace: 'nowrap' }}>
                  <button className="logout-btn" style={{ padding: '4px 9px', fontSize: 12 }} disabled={busy} onClick={() => runNow(j.id)}>지금 실행</button>
                  {' '}<button className="logout-btn" style={{ padding: '4px 9px', fontSize: 12 }} disabled={busy} onClick={() => setForm({ ...j })}>수정</button>
                  {' '}<button className="logout-btn" style={{ padding: '4px 9px', fontSize: 12, color: 'var(--red)' }} disabled={busy} onClick={() => remove(j)}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
        NFS 마운트 등록/해제·로그·트러블슈팅은 <b>설정 › NFS 마운트(백업 대상)</b>에서. 복제 대상 VM 은 Platform 트리에 <span className="badge blue" style={{ fontSize: 10 }}>Clone</span> 배지로 표시됩니다.
      </div>
    </div>
  );
}

/** 잡 추가/수정 폼 — vCenter 선택 → VM 검색 선택 → 대상/스케줄/보존. */
function JobForm({ d, form, setForm, onSaved }) {
  const [vcs, setVcs] = useState([]);
  const [vms, setVms] = useState([]);
  const [dss, setDss] = useState([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { fetchJson('/vcenters').then((r) => setVcs(r || [])).catch(() => {}); }, []);
  // vCenter 를 고르면 그 vCenter 의 VM(선택용)·데이터스토어(대상용) 로드.
  useEffect(() => {
    if (!form.vcenterId) { setVms([]); setDss([]); return; }
    fetchJson('/vms', { vcenterId: form.vcenterId, limit: 5000, sortBy: 'name', order: 'asc' }).then((r) => setVms(r.items || [])).catch(() => setVms([]));
    fetchJson('/datastores', { vcenterId: form.vcenterId }).then((r) => setDss(r.items || [])).catch(() => setDss([]));
  }, [form.vcenterId]);

  const ql = q.trim().toLowerCase();
  const filtered = useMemo(() => (ql ? vms.filter((v) => v.name.toLowerCase().includes(ql)) : vms).slice(0, 50), [vms, ql]);
  const sel = vms.find((v) => v.id === form.vmId);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await postJson('/tools/vm-clone/jobs', form);
      if (r.ok === false) setErr(r.reason); else onSaved();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ padding: 14, marginBottom: 12, background: 'rgba(96,165,250,.05)' }}>
      <div className="flex between" style={{ marginBottom: 10 }}>
        <b style={{ fontSize: 13 }}>{form.id ? `복제 잡 수정 — ${form.vmName}` : '복제 잡 추가'}</b>
        <button className="logout-btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setForm(null)}>닫기</button>
      </div>
      <div className="flex gap wrap" style={{ alignItems: 'flex-end' }}>
        <label style={{ fontSize: 12 }}>vCenter<br />
          <select className="select" value={form.vcenterId} disabled={!!form.id}
            onChange={(e) => setForm({ ...form, vcenterId: e.target.value, vmId: '', vmName: '', dest: { ...form.dest, datastoreName: '' } })}>
            <option value="">(선택)</option>
            {vcs.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.id})</option>)}
          </select>
        </label>
        {form.vcenterId && !form.id && (
          <label style={{ fontSize: 12, flex: '1 1 260px' }}>VM 검색·선택 ({vms.length}대 중)<br />
            <SearchBox value={q} onChange={setQ} placeholder="VM 이름 검색" style={{ width: '100%' }} />
            {ql && !sel && (
              <div className="card" style={{ maxHeight: 160, overflow: 'auto', marginTop: 4, padding: 6 }}>
                {filtered.map((v) => (
                  <div key={v.id} className="vcd-link" style={{ padding: '3px 6px', cursor: 'pointer', fontSize: 12.5 }}
                    onClick={() => { setForm({ ...form, vmId: v.id, vmName: v.name }); setQ(v.name); }}>
                    🧊 {v.name} <span className="muted">· {v.host || '—'} · {v.cpuCount}vCPU/{Math.round((v.memMB || 0) / 1024)}GB · 💾 {v.storageGB ?? '—'}GB</span>
                  </div>
                ))}
                {!filtered.length && <div className="muted" style={{ fontSize: 12, padding: 6 }}>일치 VM 없음</div>}
              </div>
            )}
          </label>
        )}
        {form.vmId && <span className="badge green" style={{ alignSelf: 'center' }}>선택: {form.vmName}</span>}
      </div>

      <div className="flex gap wrap" style={{ alignItems: 'flex-end', marginTop: 10 }}>
        <label style={{ fontSize: 12 }}>백업 대상<br />
          <select className="select" value={form.dest.type} onChange={(e) => setForm({ ...form, dest: { type: e.target.value, datastoreName: '', mountId: '', subdir: '' } })}>
            <option value="datastore">다른 데이터스토어(서버측 클론)</option>
            <option value="nfs">NFS(Edge 노드 마운트 — 파일 백업)</option>
          </select>
        </label>
        {form.dest.type === 'datastore' ? (
          <label style={{ fontSize: 12 }}>대상 데이터스토어<br />
            <select className="select" value={form.dest.datastoreName || ''} onChange={(e) => setForm({ ...form, dest: { ...form.dest, datastoreName: e.target.value } })}>
              <option value="">(선택)</option>
              {dss.map((ds) => <option key={ds.id} value={ds.name}>{ds.name} — 여유 {Math.round((ds.freeGB || 0) / 1024 * 10) / 10}TB ({ds.usagePct}%)</option>)}
            </select>
          </label>
        ) : (
          <>
            <label style={{ fontSize: 12 }}>NFS 마운트(설정 › NFS 마운트에서 등록)<br />
              <select className="select" value={form.dest.mountId || ''} onChange={(e) => setForm({ ...form, dest: { ...form.dest, mountId: e.target.value } })}>
                <option value="">(선택)</option>
                {(d.mounts || []).map((m) => <option key={m.id} value={m.id}>{m.server}:{m.exportPath} {m.mounted ? '· 마운트됨' : '· ⚠ 미마운트'}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 12 }}>하위 폴더(선택)<br />
              <input className="input" style={{ width: 140 }} placeholder="예: prod" value={form.dest.subdir || ''} onChange={(e) => setForm({ ...form, dest: { ...form.dest, subdir: e.target.value } })} />
            </label>
          </>
        )}
        <label style={{ fontSize: 12 }}>스케줄<br />
          <select className="select" value={form.schedule.mode} onChange={(e) => setForm({ ...form, schedule: { mode: e.target.value, ...(e.target.value === 'daily' ? { time: '02:00' } : e.target.value === 'interval' ? { hours: 24 } : {}) } })}>
            <option value="daily">매일 지정 시각</option>
            <option value="interval">N시간 간격</option>
            <option value="manual">수동만</option>
          </select>
        </label>
        {form.schedule.mode === 'daily' && <label style={{ fontSize: 12 }}>시각<br /><input className="input" type="time" value={form.schedule.time || '02:00'} onChange={(e) => setForm({ ...form, schedule: { ...form.schedule, time: e.target.value } })} /></label>}
        {form.schedule.mode === 'interval' && <label style={{ fontSize: 12 }}>간격(시간)<br /><input className="input" type="number" min={1} max={168} style={{ width: 80 }} value={form.schedule.hours || 24} onChange={(e) => setForm({ ...form, schedule: { ...form.schedule, hours: Number(e.target.value) || 24 } })} /></label>}
        <label style={{ fontSize: 12 }}>보존 개수<br /><input className="input" type="number" min={1} max={30} style={{ width: 70 }} value={form.keep} onChange={(e) => setForm({ ...form, keep: Number(e.target.value) || 3 })} /></label>
        <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12, padding: '6px 0' }} title="VMware Tools 정지점(VSS/freeze) 스냅샷 — DB 등 앱 정합 사본. Tools 필수, 실패 시 잡이 오류로 끝납니다.">
          <input type="checkbox" checked={!!form.quiesce} onChange={(e) => setForm({ ...form, quiesce: e.target.checked })} /> 정지점(앱 정합)
        </label>
        <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12, padding: '6px 0' }}>
          <input type="checkbox" checked={form.enabled !== false} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> 활성
        </label>
        <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy || !form.vmId} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
      </div>
      {err && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 8 }}>⚠ {err}</div>}
    </div>
  );
}
