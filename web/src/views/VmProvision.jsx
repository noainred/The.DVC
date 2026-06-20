import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, postJson, usePolling } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

const JOB_BADGE = { running: 'amber', completed: 'green', completed_with_errors: 'amber', error: 'red' };
const JOB_LABEL = { running: '진행 중', completed: '완료', completed_with_errors: '일부 실패', error: '실패' };
const VM_BADGE = { queued: 'gray', running: 'amber', done: 'green', error: 'red' };
const VM_LABEL = { queued: '대기', running: '생성 중', done: '완료', error: '실패' };

const EMPTY = {
  vcenterId: '', sourceId: '',
  namePattern: 'vm-{n}', count: 3, startIndex: 1, pad: 2, powerOn: true,
  guest: { hostnamePattern: 'vm-{n}', ipMode: 'static', ipStart: '', subnetMask: '255.255.255.0', gateway: '', dnsServers: '', domain: '' },
};

/** VM 생성 — 비슷한 VM을 한 번에 대량 생성 + 게스트 OS hostname/IP 설정. (관리자) */
export default function VmProvision() {
  const { data: vcenters } = usePolling('/vcenters', {}, 60_000);
  const [form, setForm] = useState(structuredClone(EMPTY));
  const [sources, setSources] = useState([]);
  const [preview, setPreview] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState(null);

  // Load clonable sources whenever the vCenter scope changes.
  useEffect(() => {
    const q = form.vcenterId ? `?vcenterId=${encodeURIComponent(form.vcenterId)}` : '';
    fetchJson(`/provision/sources${q}`).then((r) => setSources(r.sources || [])).catch(() => setSources([]));
  }, [form.vcenterId]);

  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setG = (k) => (e) => setForm((f) => ({ ...f, guest: { ...f.guest, [k]: e.target.value } }));

  const specBody = useMemo(() => ({
    sourceId: form.sourceId,
    namePattern: form.namePattern, count: Number(form.count) || 0, startIndex: Number(form.startIndex) || 1, pad: Number(form.pad) || 0,
    powerOn: form.powerOn,
    guest: { ...form.guest, dnsServers: String(form.guest.dnsServers || '').split(/[\s,]+/).filter(Boolean) },
  }), [form]);

  const doPreview = async () => {
    setMsg(null);
    try { setPreview(await postJson('/provision/preview', specBody)); }
    catch (e) { setMsg({ ok: false, text: e.message }); }
  };
  // Auto-refresh the preview as the user types the pattern/count/IP.
  useEffect(() => { const t = setTimeout(doPreview, 350); return () => clearTimeout(t); /* eslint-disable-next-line */ }, [form.namePattern, form.count, form.startIndex, form.pad, form.guest.ipMode, form.guest.ipStart, form.guest.hostnamePattern]);

  const submit = async () => {
    if (!form.sourceId) return setMsg({ ok: false, text: '원본 VM/템플릿을 선택하세요.' });
    if (!window.confirm(`${preview?.count ?? '?'}대의 VM을 생성할까요? (원본: ${sources.find((s) => s.id === form.sourceId)?.name || form.sourceId})`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/admin/provision/jobs', specBody);
      if (r.ok) { setJobId(r.job.id); setMsg({ ok: true, text: `작업 시작됨 — ${r.job.total}대 생성 중` }); }
      else setMsg({ ok: false, text: r.reason });
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };

  const sel = sources.find((s) => s.id === form.sourceId);

  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>🖥️ VM 생성 · 대량 생성</div>

      <div className="card" style={{ marginBottom: 14 }}>
        <b style={{ fontSize: 14 }}>1. 원본 선택 (클론)</b>
        <div className="spec-grid" style={{ marginTop: 8 }}>
          <label>vCenter
            <select className="select" value={form.vcenterId} onChange={(e) => setForm((f) => ({ ...f, vcenterId: e.target.value, sourceId: '' }))}>
              <option value="">— 전체 —</option>
              {(vcenters || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
          <label style={{ gridColumn: '1 / -1' }}>원본 VM / 템플릿 ({sources.length})
            <select className="select" value={form.sourceId} onChange={setF('sourceId')}>
              <option value="">— 선택 —</option>
              {sources.map((s) => <option key={s.id} value={s.id}>{s.template ? '📦 ' : ''}{s.name} · {s.guestOS || 'OS?'} · {s.template ? '템플릿' : (s.powerState === 'POWERED_ON' ? 'On' : 'Off')}</option>)}
            </select>
          </label>
        </div>
        {sel && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>게스트 OS: <b>{sel.guestOS || '알 수 없음'}</b>{/win/i.test(sel.guestOS) ? ' (Windows — Sysprep 사용자 지정)' : ' (Linux — LinuxPrep 사용자 지정)'} · vCPU {sel.cpuCount ?? '—'} · RAM {sel.memMB ? `${Math.round(sel.memMB / 1024)}GB` : '—'}</div>}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <b style={{ fontSize: 14 }}>2. 이름 · 개수</b>
        <div className="spec-grid" style={{ marginTop: 8 }}>
          <label>이름 패턴 (<code>{'{n}'}</code> = 일련번호)<input className="input" value={form.namePattern} onChange={setF('namePattern')} placeholder="web-{n}" /></label>
          <label>개수<input className="input" type="number" min="1" max="500" value={form.count} onChange={setF('count')} /></label>
          <label>시작 번호<input className="input" type="number" value={form.startIndex} onChange={setF('startIndex')} /></label>
          <label>자릿수 채움(0=없음)<input className="input" type="number" min="0" value={form.pad} onChange={setF('pad')} placeholder="2 → 01,02" /></label>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={form.powerOn} onChange={(e) => setForm((f) => ({ ...f, powerOn: e.target.checked }))} /> 생성 후 전원 켜기
          </label>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <b style={{ fontSize: 14 }}>3. 게스트 OS 설정 (hostname · IP)</b>
        <div className="spec-grid" style={{ marginTop: 8 }}>
          <label>Hostname 패턴<input className="input" value={form.guest.hostnamePattern} onChange={setG('hostnamePattern')} placeholder="web-{n}" /></label>
          <label>IP 방식
            <select className="select" value={form.guest.ipMode} onChange={setG('ipMode')}>
              <option value="static">고정 IP (자동 증가)</option>
              <option value="dhcp">DHCP</option>
            </select>
          </label>
          {form.guest.ipMode === 'static' && <>
            <label>시작 IP<input className="input" value={form.guest.ipStart} onChange={setG('ipStart')} placeholder="10.0.10.50" /></label>
            <label>서브넷 마스크<input className="input" value={form.guest.subnetMask} onChange={setG('subnetMask')} placeholder="255.255.255.0" /></label>
            <label>게이트웨이<input className="input" value={form.guest.gateway} onChange={setG('gateway')} placeholder="10.0.10.1" /></label>
          </>}
          <label>DNS 서버(공백/쉼표 구분)<input className="input" value={form.guest.dnsServers} onChange={setG('dnsServers')} placeholder="8.8.8.8 1.1.1.1" /></label>
          <label>도메인<input className="input" value={form.guest.domain} onChange={setG('domain')} placeholder="corp.local" /></label>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>고정 IP는 시작 IP에서 1씩 증가합니다 (예: 10.0.10.50, .51, .52 …).</div>
      </div>

      {msg && (
        <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13,
          background: msg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)', color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.text}</div>
      )}

      <div className="flex gap" style={{ marginBottom: 14, alignItems: 'center' }}>
        <button className="login-btn" style={{ flex: 'none', padding: '10px 20px' }} disabled={busy || !form.sourceId || !(preview?.count > 0)} onClick={submit}>
          {busy ? '시작 중…' : `생성 시작${preview?.count ? ` (${preview.count}대)` : ''}`}
        </button>
        <button className="logout-btn" style={{ padding: '10px 16px' }} onClick={doPreview}>미리보기 새로고침</button>
        {preview?.errors?.length > 0 && <span style={{ color: '#f87171', fontSize: 13 }}>{preview.errors.join(' / ')}</span>}
      </div>

      {preview?.vms?.length > 0 && (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>미리보기 — 생성될 VM {preview.count}대 {preview.count > preview.vms.length && `(처음 ${preview.vms.length}대 표시)`}</div>
          <div className="table-wrap" style={{ maxHeight: '34vh', marginBottom: 18 }}>
            <table>
              <thead><tr><th>#</th><th>VM 이름</th><th>Hostname</th><th>IP</th></tr></thead>
              <tbody>
                {preview.vms.map((v, i) => (
                  <tr key={v.name}><td className="muted">{i + 1}</td><td><b>{v.name}</b></td><td>{v.hostname}</td><td className="muted">{v.ip || (form.guest.ipMode === 'dhcp' ? 'DHCP' : '—')}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <JobProgress jobId={jobId} />
      <RecentJobs onOpen={setJobId} activeId={jobId} />
    </>
  );
}

function JobProgress({ jobId }) {
  const { data: job } = usePolling(jobId ? `/provision/jobs/${jobId}` : null, {}, 2000);
  if (!jobId || !job) return null;
  const pct = job.total ? Math.round(((job.done + job.failed) / job.total) * 100) : 0;
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="flex between" style={{ alignItems: 'center', marginBottom: 8 }}>
        <b style={{ fontSize: 14 }}>작업 진행 — {job.sourceName} 복제</b>
        <span className={`badge ${JOB_BADGE[job.status] || 'gray'}`}>{JOB_LABEL[job.status] || job.status}</span>
      </div>
      <div style={{ height: 8, borderRadius: 6, background: 'rgba(255,255,255,.08)', overflow: 'hidden', marginBottom: 8 }}>
        <div style={{ width: `${pct}%`, height: '100%', background: job.failed ? 'var(--amber)' : 'var(--green)', transition: 'width .3s' }} />
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>완료 {job.done} · 실패 {job.failed} · 전체 {job.total} {job.live ? '· LIVE (실제 vCenter)' : '· MOCK (데모)'}</div>
      <div className="table-wrap" style={{ maxHeight: '34vh' }}>
        <table>
          <thead><tr><th>VM</th><th>Hostname</th><th>IP</th><th>상태</th><th>비고</th></tr></thead>
          <tbody>
            {job.vms.map((v) => (
              <tr key={v.name}>
                <td><b>{v.name}</b></td><td>{v.hostname}</td><td className="muted">{v.ip || 'DHCP'}</td>
                <td><span className={`badge ${VM_BADGE[v.status] || 'gray'}`}>{VM_LABEL[v.status] || v.status}</span></td>
                <td className="muted" style={{ fontSize: 12 }}>{v.error || (v.task ? `task ${v.task}` : '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RecentJobs({ onOpen, activeId }) {
  const { data } = usePolling('/provision/jobs', {}, 5000);
  const jobs = (data?.jobs || []).filter((j) => j.id !== activeId);
  if (!jobs.length) return null;
  return (
    <>
      <div className="section-title">최근 작업</div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>시작</th><th>원본</th><th>대수</th><th>상태</th><th></th></tr></thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td className="muted">{new Date(j.createdAt).toLocaleString()}</td>
                <td>{j.sourceName}</td>
                <td>{j.done}/{j.total}{j.failed ? ` · 실패 ${j.failed}` : ''}</td>
                <td><span className={`badge ${JOB_BADGE[j.status] || 'gray'}`}>{JOB_LABEL[j.status] || j.status}</span></td>
                <td className="right"><button className="tab" onClick={() => onOpen(j.id)}>보기</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
