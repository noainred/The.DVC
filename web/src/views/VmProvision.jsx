import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson, usePolling } from '../api.js';
import { Loading, ErrorBox, SearchBox } from '../components/ui.jsx';
import EscClose from '../components/EscClose.jsx';

const chipStyle = { cursor: 'pointer', padding: '5px 12px', fontSize: 12, userSelect: 'none' };
const chipActive = { border: '1px solid var(--accent,#6366f1)', color: '#c7d2fe', background: 'rgba(99,102,241,.15)' };

const JOB_BADGE = { running: 'amber', completed: 'green', completed_with_errors: 'amber', error: 'red' };
const JOB_LABEL = { running: '진행 중', completed: '완료', completed_with_errors: '일부 실패', error: '실패' };
const VM_BADGE = { queued: 'gray', running: 'amber', done: 'green', error: 'red' };
const VM_LABEL = { queued: '대기', running: '생성 중', done: '완료', error: '실패' };

const EMPTY = {
  vcenterId: '', sourceId: '',
  namePattern: 'vm-{n}', count: 3, startIndex: 1, pad: 2, powerOn: true,
  placement: { cluster: '', host: '', datastore: '', folder: '', resourcePool: '', storageProfile: '' },
  guest: { hostnamePattern: 'vm-{n}', ipMode: 'static', ipStart: '', ipAssign: 'sequential', ipList: '', subnetMask: '255.255.255.0', gateway: '', dnsServers: '', domain: '', extraNics: [] },
};

/** VM 생성 — 비슷한 VM을 한 번에 대량 생성 + 게스트 OS hostname/IP 설정. (관리자) */
export default function VmProvision() {
  const { data: vcenters } = usePolling('/vcenters', {}, 60_000);
  const [form, setForm] = useState(structuredClone(EMPTY));
  const [sources, setSources] = useState([]);
  const [srcTotal, setSrcTotal] = useState(0);
  const [srcQuery, setSrcQuery] = useState('');
  const [srcLoading, setSrcLoading] = useState(false);
  const [placement, setPlacement] = useState(null);
  const [preview, setPreview] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState(null);

  // Placement options (cluster/host/datastore/folder/pool/profile) for the 법인.
  useEffect(() => {
    const q = form.vcenterId ? `?vcenterId=${encodeURIComponent(form.vcenterId)}` : '';
    fetchJson(`/provision/placement${q}`).then(setPlacement).catch(() => setPlacement(null));
  }, [form.vcenterId]);

  // Load clonable templates/VMs for the selected 법인(vCenter), prefix-filtered by
  // the name box (A → all starting with A). Debounced so typing stays smooth.
  useEffect(() => {
    let active = true; // 느린 이전 응답이 최신 검색 결과를 덮어쓰지 않게(고RTT + 빠른 타이핑).
    setSrcLoading(true);
    const params = new URLSearchParams();
    if (form.vcenterId) params.set('vcenterId', form.vcenterId);
    if (srcQuery.trim()) params.set('q', srcQuery.trim());
    const t = setTimeout(() => {
      fetchJson(`/provision/sources?${params.toString()}`)
        .then((r) => { if (active) { setSources(r.sources || []); setSrcTotal(r.total ?? (r.sources || []).length); } })
        .catch(() => { if (active) { setSources([]); setSrcTotal(0); } })
        .finally(() => { if (active) setSrcLoading(false); });
    }, 250);
    return () => { active = false; clearTimeout(t); };
  }, [form.vcenterId, srcQuery]);

  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setG = (k) => (e) => setForm((f) => ({ ...f, guest: { ...f.guest, [k]: e.target.value } }));
  const setP = (k) => (e) => setForm((f) => ({ ...f, placement: { ...f.placement, [k]: e.target.value } }));

  const specBody = useMemo(() => ({
    sourceId: form.sourceId,
    namePattern: form.namePattern, count: Number(form.count) || 0, startIndex: Number(form.startIndex) || 1, pad: Number(form.pad) || 0,
    powerOn: form.powerOn,
    placement: form.placement,
    guest: {
      ...form.guest,
      dnsServers: String(form.guest.dnsServers || '').split(/[\s,]+/).filter(Boolean),
      // 'list' mode → send the explicit IPs; otherwise let the server auto-increment.
      ipList: form.guest.ipAssign === 'list' ? String(form.guest.ipList || '').split(/[\s,\n]+/).filter(Boolean) : [],
      extraNics: (form.guest.extraNics || []).filter((e) => e.ipMode === 'dhcp' || e.ipStart),
    },
  }), [form]);

  // Additional NIC helpers.
  const addNic = () => setForm((f) => ({ ...f, guest: { ...f.guest, extraNics: [...(f.guest.extraNics || []), { ipMode: 'static', ipStart: '', subnetMask: '255.255.255.0', gateway: '', mac: '' }] } }));
  const setNic = (idx, k, v) => setForm((f) => ({ ...f, guest: { ...f.guest, extraNics: f.guest.extraNics.map((e, i) => (i === idx ? { ...e, [k]: v } : e)) } }));
  const delNic = (idx) => setForm((f) => ({ ...f, guest: { ...f.guest, extraNics: f.guest.extraNics.filter((_, i) => i !== idx) } }));
  const [ipGuide, setIpGuide] = useState(false);

  const previewGen = useRef(0); // 연타 입력 시 늦은 응답이 최신 미리보기(확인창 count 근거)를 덮지 않게
  const doPreview = async () => {
    const gen = ++previewGen.current;
    setMsg(null);
    try {
      const p = await postJson('/provision/preview', specBody);
      if (gen === previewGen.current) setPreview(p);
    } catch (e) { if (gen === previewGen.current) setMsg({ ok: false, text: e.message }); }
  };
  // Auto-refresh the preview as the user types the pattern/count/IP.
  useEffect(() => { const t = setTimeout(doPreview, 350); return () => clearTimeout(t); /* eslint-disable-next-line */ }, [form.namePattern, form.count, form.startIndex, form.pad, form.guest.ipMode, form.guest.ipStart, form.guest.ipAssign, form.guest.ipList, form.guest.hostnamePattern]);

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

  // Reload a saved job's spec back into the form for reuse.
  const loadSaved = (entry) => {
    const sp = entry.spec || {};
    const g = sp.guest || {};
    const ipList = Array.isArray(g.ipList) ? g.ipList : [];
    setForm({
      ...structuredClone(EMPTY),
      vcenterId: entry.vcenterId || '',
      sourceId: sp.sourceId || entry.sourceId || '',
      namePattern: sp.namePattern || 'vm-{n}',
      count: sp.count || 0,
      startIndex: sp.startIndex || 1,
      pad: sp.pad || 0,
      powerOn: sp.powerOn !== false,
      placement: { ...EMPTY.placement, ...(sp.placement || {}) },
      guest: {
        ...EMPTY.guest, ...g,
        ipAssign: ipList.length ? 'list' : 'sequential',
        ipList: ipList.join('\n'),
        dnsServers: Array.isArray(g.dnsServers) ? g.dnsServers.join(' ') : (g.dnsServers || ''),
      },
    });
    setMsg({ ok: true, text: `저장된 작업 '${entry.name}'을(를) 불러왔습니다. 원본/대상을 확인 후 생성하세요.` });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const sel = sources.find((s) => s.id === form.sourceId);

  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>🖥️ VM 생성 · 대량 생성</div>

      <div className="card" style={{ marginBottom: 14 }}>
        <b style={{ fontSize: 14 }}>1. 원본 선택 (클론) — 법인(vCenter)을 선택하고 이름으로 검색하세요</b>

        {/* 법인(vCenter) 칩 — 클릭 시 해당 법인의 템플릿/VM 목록 */}
        <div className="flex gap wrap" style={{ margin: '10px 0' }}>
          <span className="badge gray" style={{ ...chipStyle, ...(form.vcenterId === '' ? chipActive : {}) }}
            onClick={() => setForm((f) => ({ ...f, vcenterId: '', sourceId: '' }))}>전체</span>
          {(vcenters || []).map((v) => (
            <span key={v.id} className="badge gray" style={{ ...chipStyle, ...(form.vcenterId === v.id ? chipActive : {}) }}
              onClick={() => setForm((f) => ({ ...f, vcenterId: v.id, sourceId: '' }))}>{v.name}</span>
          ))}
        </div>

        {/* 이름 접두 검색: A 입력 → A로 시작하는 모든 VM/템플릿 */}
        <input className="input" value={srcQuery} onChange={(e) => setSrcQuery(e.target.value)}
          placeholder="이름으로 검색 (예: A → A로 시작하는 모든 VM/템플릿)" style={{ marginBottom: 8 }} />
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          {form.vcenterId ? `${vcenters?.find((v) => v.id === form.vcenterId)?.name || form.vcenterId} · ` : '전체 법인 · '}
          {srcLoading ? '검색 중…' : `${srcTotal.toLocaleString()}개 일치${srcTotal > sources.length ? ` (상위 ${sources.length}개 표시 — 이름을 더 입력해 좁히세요)` : ''}`}
        </div>

        <div className="table-wrap" style={{ maxHeight: '34vh' }}>
          <table>
            <thead><tr><th>유형</th><th>이름</th><th>Guest OS</th><th>전원/상태</th><th className="right">vCPU / RAM</th></tr></thead>
            <tbody>
              {sources.length === 0 && <tr><td colSpan={5} className="center muted" style={{ padding: 22 }}>{srcLoading ? '검색 중…' : '일치하는 템플릿/VM이 없습니다.'}</td></tr>}
              {sources.map((s) => (
                <tr key={s.id} style={{ cursor: 'pointer', background: form.sourceId === s.id ? 'rgba(99,102,241,.14)' : undefined }}
                  onClick={() => setForm((f) => ({ ...f, sourceId: s.id }))}>
                  <td>{s.template ? <span className="badge purple">📦 템플릿</span> : <span className="badge blue">VM</span>}</td>
                  <td><b>{s.name}</b>{form.sourceId === s.id && <span style={{ color: '#818cf8', marginLeft: 6 }}>✓</span>}</td>
                  <td className="muted">{s.guestOS || '—'}</td>
                  <td>{s.template ? <span className="muted">템플릿</span> : <span className="muted">{s.powerState === 'POWERED_ON' ? 'On' : 'Off'}</span>}</td>
                  <td className="right muted">{s.cpuCount ?? '—'} / {s.memMB ? `${Math.round(s.memMB / 1024)}GB` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {sel
          ? <div style={{ marginTop: 8, fontSize: 13 }}>선택된 원본: <b>{sel.name}</b> · 게스트 OS <b>{sel.guestOS || '알 수 없음'}</b>{/win/i.test(sel.guestOS) ? ' (Windows — Sysprep)' : ' (Linux — LinuxPrep)'} · vCPU {sel.cpuCount ?? '—'} · RAM {sel.memMB ? `${Math.round(sel.memMB / 1024)}GB` : '—'}</div>
          : <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>위 목록에서 복제할 템플릿/VM을 클릭하세요.</div>}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <b style={{ fontSize: 14 }}>2. 배치 (클러스터 · 호스트 · 스토리지 · 폴더 · 리소스풀 · 프로파일)</b>
        <div className="spec-grid" style={{ marginTop: 8 }}>
          <label>클러스터
            <select className="select" value={form.placement.cluster} onChange={(e) => setForm((f) => ({ ...f, placement: { ...f.placement, cluster: e.target.value, host: '' } }))}>
              <option value="">— 자동/원본과 동일 —</option>
              {(placement?.clusters || []).map((c) => <option key={c.name} value={c.name}>{c.name} (호스트 {c.hosts})</option>)}
            </select>
          </label>
          <label>호스트(ESXi)
            <select className="select" value={form.placement.host} onChange={setP('host')}>
              <option value="">— 자동(DRS) —</option>
              {(placement?.hosts || []).filter((h) => !form.placement.cluster || h.cluster === form.placement.cluster).map((h) => <option key={h.id} value={h.name}>{h.name}</option>)}
            </select>
          </label>
          <label>데이터스토어
            <select className="select" value={form.placement.datastore} onChange={setP('datastore')}>
              <option value="">— 자동/원본과 동일 —</option>
              {(placement?.datastores || []).map((d) => <option key={d.id} value={d.name}>{d.name}{d.freeGB != null ? ` · 여유 ${d.freeGB >= 1024 ? `${(d.freeGB / 1024).toFixed(1)}TB` : `${d.freeGB}GB`}` : ''}</option>)}
            </select>
          </label>
          <label>폴더(VM Folder)
            <input className="input" list="prov-folders" value={form.placement.folder} onChange={setP('folder')} placeholder="예: Production" />
            <datalist id="prov-folders">{(placement?.folders || []).map((x) => <option key={x} value={x} />)}</datalist>
          </label>
          <label>리소스 풀(Resource Pool)
            <input className="input" list="prov-pools" value={form.placement.resourcePool} onChange={setP('resourcePool')} placeholder="예: Prod" />
            <datalist id="prov-pools">{(placement?.resourcePools || []).map((x) => <option key={x} value={x} />)}</datalist>
          </label>
          <label>스토리지 프로파일(정책)
            <input className="input" list="prov-profiles" value={form.placement.storageProfile} onChange={setP('storageProfile')} placeholder="예: vSAN Default Storage Policy" />
            <datalist id="prov-profiles">{(placement?.profiles || []).map((x) => <option key={x} value={x} />)}</datalist>
          </label>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>비워두면 원본 VM과 동일한 위치(클러스터/호스트/데이터스토어)에 배치됩니다. 폴더·리소스풀·프로파일은 vCenter의 정확한 이름을 입력하세요(목록은 추천값).</div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <b style={{ fontSize: 14 }}>3. 이름 · 개수</b>
        <div className="spec-grid" style={{ marginTop: 8 }}>
          <label>이름 패턴 ({'{n}'}=번호)<input className="input" value={form.namePattern} onChange={setF('namePattern')} placeholder="web-{n}" /></label>
          <label>개수<input className="input" type="number" min="1" max="500" value={form.count} onChange={setF('count')} /></label>
          <label>시작 번호<input className="input" type="number" value={form.startIndex} onChange={setF('startIndex')} /></label>
          <label>자릿수(0=없음)<input className="input" type="number" min="0" value={form.pad} onChange={setF('pad')} placeholder="2 → 01,02" /></label>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={form.powerOn} onChange={(e) => setForm((f) => ({ ...f, powerOn: e.target.checked }))} /> 생성 후 전원 켜기
          </label>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="flex between wrap" style={{ alignItems: 'center' }}>
          <b style={{ fontSize: 14 }}>4. 게스트 OS 설정 (hostname · IP) — NIC1(기본)</b>
          <button className="logout-btn" style={{ padding: '6px 12px', fontSize: 12 }} onClick={() => setIpGuide(true)}>ⓘ IP 입력 가이드</button>
        </div>
        <div className="spec-grid" style={{ marginTop: 8 }}>
          <label>Hostname 패턴<input className="input" value={form.guest.hostnamePattern} onChange={setG('hostnamePattern')} placeholder="web-{n}" /></label>
          <label>IP 방식
            <select className="select" value={form.guest.ipMode} onChange={setG('ipMode')}>
              <option value="static">고정 IP</option>
              <option value="dhcp">DHCP</option>
            </select>
          </label>
          {form.guest.ipMode === 'static' && (
            <label>IP 할당
              <select className="select" value={form.guest.ipAssign} onChange={setG('ipAssign')}>
                <option value="sequential">순차 증가 (시작 IP +1)</option>
                <option value="list">직접 입력 (떨어진 IP)</option>
              </select>
            </label>
          )}
          {form.guest.ipMode === 'static' && form.guest.ipAssign === 'sequential' && (
            <label>시작 IP<input className="input" value={form.guest.ipStart} onChange={setG('ipStart')} placeholder="10.0.10.50" /></label>
          )}
          {form.guest.ipMode === 'static' && <>
            <label>서브넷 마스크<input className="input" value={form.guest.subnetMask} onChange={setG('subnetMask')} placeholder="255.255.255.0" /></label>
            <label>게이트웨이<input className="input" value={form.guest.gateway} onChange={setG('gateway')} placeholder="10.0.10.1" /></label>
          </>}
          <label>DNS 서버(공백/쉼표 구분)<input className="input" value={form.guest.dnsServers} onChange={setG('dnsServers')} placeholder="8.8.8.8 1.1.1.1" /></label>
          <label>도메인<input className="input" value={form.guest.domain} onChange={setG('domain')} placeholder="corp.local" /></label>
        </div>
        {form.guest.ipMode === 'static' && form.guest.ipAssign === 'list' && (
          <label style={{ display: 'block', marginTop: 10 }}>IP 목록 (한 줄에 하나 · VM 순서대로 매핑 — 떨어진/임의 IP 가능)
            <textarea className="input" rows={5} value={form.guest.ipList} onChange={setG('ipList')}
              placeholder={'10.0.10.50\n10.0.20.17\n10.0.99.200'} style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }} />
          </label>
        )}
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          {form.guest.ipMode === 'dhcp' ? 'DHCP로 자동 할당됩니다.'
            : form.guest.ipAssign === 'list' ? '입력한 IP가 VM 순서대로 1:1 매핑됩니다. (대수보다 IP가 많으면 IP 수만큼 생성)'
            : '시작 IP에서 1씩 증가합니다 (예: 10.0.10.50, .51, .52 …).'}
        </div>

        {/* 추가 NIC (NIC2+) — 순서 기준, 선택적 MAC */}
        <div style={{ borderTop: '1px solid rgba(255,255,255,.08)', marginTop: 12, paddingTop: 10 }}>
          <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 6 }}>
            <b style={{ fontSize: 13 }}>추가 NIC ({(form.guest.extraNics || []).length})</b>
            <button className="logout-btn" style={{ padding: '6px 12px', fontSize: 12 }} onClick={addNic}>+ NIC 추가</button>
          </div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
            NIC는 <b>가상 NIC 순서</b>대로 적용됩니다(NIC1=기본, 아래가 NIC2, NIC3 …). MAC을 입력하면 그 MAC의 NIC에 바인딩됩니다(보통 1대 생성 시에만 유효). 게스트 인터페이스 이름(ens192 등) 기준 지정은 vSphere가 지원하지 않습니다.
          </div>
          {(form.guest.extraNics || []).map((e, i) => (
            <div key={i} className="card" style={{ padding: '8px 10px', marginBottom: 6, background: 'rgba(255,255,255,.02)' }}>
              <div className="flex gap wrap" style={{ alignItems: 'flex-end' }}>
                <span className="badge blue" style={{ alignSelf: 'center' }}>NIC{i + 2}</span>
                <label style={{ fontSize: 12 }}>IP 방식
                  <select className="select" value={e.ipMode} onChange={(ev) => setNic(i, 'ipMode', ev.target.value)}>
                    <option value="static">고정 IP</option><option value="dhcp">DHCP</option>
                  </select>
                </label>
                {e.ipMode === 'static' && <>
                  <label style={{ fontSize: 12 }}>시작 IP<input className="input" value={e.ipStart} onChange={(ev) => setNic(i, 'ipStart', ev.target.value)} placeholder="10.20.0.50" /></label>
                  <label style={{ fontSize: 12 }}>서브넷<input className="input" value={e.subnetMask} onChange={(ev) => setNic(i, 'subnetMask', ev.target.value)} placeholder="255.255.255.0" /></label>
                  <label style={{ fontSize: 12 }}>게이트웨이<input className="input" value={e.gateway} onChange={(ev) => setNic(i, 'gateway', ev.target.value)} placeholder="(선택)" /></label>
                </>}
                <label style={{ fontSize: 12 }}>MAC(선택)<input className="input" value={e.mac} onChange={(ev) => setNic(i, 'mac', ev.target.value)} placeholder="00:50:56:.." /></label>
                <button className="tab" style={{ color: 'var(--red)', padding: '7px 10px' }} onClick={() => delNic(i)}>삭제</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {ipGuide && <IpGuideModal onClose={() => setIpGuide(false)} />}

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
      <SavedJobs onLoad={loadSaved} vcenters={vcenters} reloadKey={jobId} />
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
      {job.placement && (job.placement.cluster || job.placement.host || job.placement.datastore || job.placement.folder || job.placement.resourcePool || job.placement.storageProfile) && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>배치 — {[
          job.placement.cluster && `클러스터 ${job.placement.cluster}`, job.placement.host && `호스트 ${job.placement.host}`,
          job.placement.datastore && `DS ${job.placement.datastore}`, job.placement.folder && `폴더 ${job.placement.folder}`,
          job.placement.resourcePool && `풀 ${job.placement.resourcePool}`, job.placement.storageProfile && `프로파일 ${job.placement.storageProfile}`,
        ].filter(Boolean).join(' · ')}</div>
      )}
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

/** 저장된 작업: 모든 VM 생성 작업을 저장하고 vCenter별/전체·검색·10개+More·메모/TAG 편집·불러오기. */
function SavedJobs({ onLoad, vcenters, reloadKey }) {
  const [vc, setVc] = useState('');     // '' = 전체
  const [limit, setLimit] = useState(10);
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState(null); // { id, memo, tags }
  const load = () => fetchJson(`/provision/saved?limit=${limit}${vc ? `&vcenterId=${encodeURIComponent(vc)}` : ''}`).then(setData).catch(() => setData({ total: 0, items: [], vcenters: [] }));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [vc, limit, reloadKey]);
  if (!data) return null;

  const term = q.trim().toLowerCase();
  const items = (data.items || []).filter((e) => !term || `${e.name} ${e.sourceName} ${e.memo} ${(e.tags || []).join(' ')}`.toLowerCase().includes(term));
  const vcName = (id) => (vcenters || []).find((v) => v.id === id)?.name || id;

  const saveEdit = async () => {
    const r = await putJson(`/admin/provision/saved/${edit.id}`, { memo: edit.memo, tags: String(edit.tags).split(/[,\n]/).map((s) => s.trim()).filter(Boolean) }).catch(() => ({ ok: false }));
    if (r.ok) { setEdit(null); load(); }
  };
  const del = async (e) => { if (!window.confirm(`저장된 작업 '${e.name}'을 삭제할까요?`)) return; await delJson(`/admin/provision/saved/${e.id}`).catch(() => {}); load(); };

  return (
    <>
      <div className="section-title">저장된 작업 (재사용)</div>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
        <span className={vc === '' ? 'login-btn' : 'logout-btn'} style={{ cursor: 'pointer', padding: '5px 12px', fontSize: 12, borderRadius: 6 }} onClick={() => { setVc(''); setLimit(10); }}>전체 ({data.vcenters ? '' : ''}{vc === '' ? data.total : ''})</span>
        {(data.vcenters || []).map((id) => (
          <span key={id} className={vc === id ? 'login-btn' : 'logout-btn'} style={{ cursor: 'pointer', padding: '5px 12px', fontSize: 12, borderRadius: 6 }} onClick={() => { setVc(id); setLimit(10); }}>{vcName(id)}</span>
        ))}
        <SearchBox className="input" style={{ maxWidth: 240 }} placeholder="이름/원본/메모/태그 검색" value={q} onChange={setQ} />
        <span className="muted" style={{ fontSize: 12 }}>{vc ? `${vcName(vc)} · ` : '전체 · '}{data.total}건</span>
      </div>
      <div className="table-wrap" style={{ maxHeight: '44vh' }}>
        <table>
          <thead><tr><th>시작</th><th>이름 패턴</th><th>원본</th><th>vCenter</th><th>대수</th><th>메모 · 태그</th><th className="right">작업</th></tr></thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={7} className="center muted" style={{ padding: 20 }}>저장된 작업이 없습니다. VM을 생성하면 자동 저장됩니다.</td></tr>}
            {items.map((e) => (
              <tr key={e.id}>
                <td className="muted" style={{ fontSize: 12 }}>{new Date(e.createdAt).toLocaleString()}</td>
                <td><b>{e.name}</b></td>
                <td className="muted">{e.sourceName || '—'}</td>
                <td className="muted">{vcName(e.vcenterId)}</td>
                <td>{e.count || (e.spec?.guest?.ipList?.length) || '—'}</td>
                <td style={{ fontSize: 12 }}>
                  {e.memo && <div style={{ marginBottom: 3 }}>{e.memo}</div>}
                  {(e.tags || []).map((t) => <span key={t} className="badge blue" style={{ marginRight: 4, fontSize: 10 }}>{t}</span>)}
                  <button className="tab" style={{ padding: '2px 8px', fontSize: 11, marginLeft: (e.tags || []).length ? 4 : 0 }} onClick={() => setEdit({ id: e.id, memo: e.memo || '', tags: (e.tags || []).join(', ') })}>{e.memo || (e.tags || []).length ? '✎' : '+ 메모'}</button>
                </td>
                <td className="right nowrap">
                  <button className="login-btn" style={{ flex: 'none', padding: '5px 12px' }} onClick={() => onLoad(e)}>불러오기</button>{' '}
                  <button className="tab" style={{ color: 'var(--red)' }} onClick={() => del(e)}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!q && data.total > (data.items || []).length && (
        <div style={{ marginTop: 8, textAlign: 'center' }}>
          <button className="logout-btn" style={{ padding: '8px 18px' }} onClick={() => setLimit((l) => l + 20)}>More — 지난 작업 더 보기 ({(data.items || []).length}/{data.total})</button>
        </div>
      )}
      {edit && (
        <div className="modal-overlay" onClick={(ev) => { if (ev.target === ev.currentTarget) setEdit(null); }}>
          <EscClose onClose={() => setEdit(null)} />
          <div className="modal card" style={{ maxWidth: 460 }}>
            <div className="flex between" style={{ marginBottom: 12 }}><b>메모 · 태그</b><button className="logout-btn" onClick={() => setEdit(null)}>닫기</button></div>
            <label style={{ display: 'block', marginBottom: 10 }}>메모<textarea className="input" rows={3} value={edit.memo} onChange={(e) => setEdit({ ...edit, memo: e.target.value })} style={{ resize: 'vertical' }} /></label>
            <label style={{ display: 'block' }}>태그(쉼표 구분)<input className="input" value={edit.tags} onChange={(e) => setEdit({ ...edit, tags: e.target.value })} placeholder="예: 운영, 정기" /></label>
            <div className="flex gap" style={{ marginTop: 14 }}>
              <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} onClick={saveEdit}>저장</button>
              <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={() => setEdit(null)}>취소</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** IP 입력 상세 가이드 — 순차/직접입력/다중 NIC 규칙 + vSphere 한계 정직 안내. */
function IpGuideModal({ onClose }) {
  const H = ({ children }) => <div style={{ fontWeight: 800, fontSize: 13, margin: '12px 0 4px', color: '#c7d2fe' }}>{children}</div>;
  const code = { fontFamily: 'monospace', background: 'rgba(255,255,255,.06)', padding: '1px 5px', borderRadius: 4 };
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <EscClose onClose={onClose} />
      <div className="modal card" style={{ maxWidth: 640, maxHeight: '88vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="flex between" style={{ marginBottom: 8, flex: '0 0 auto' }}>
          <b style={{ fontSize: 15 }}>ⓘ IP 입력 가이드</b>
          <button className="logout-btn" onClick={onClose}>닫기</button>
        </div>
        <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', fontSize: 13, lineHeight: 1.7 }}>
          <H>1) 고정 IP — 순차 증가</H>
          <div className="muted">시작 IP에서 VM마다 +1씩 자동 증가합니다. 예) 시작 <span style={code}>10.0.10.50</span> · 3대 → <span style={code}>.50 / .51 / .52</span>. 서브넷 마스크·게이트웨이·DNS·도메인은 모든 VM 공통.</div>
          <H>2) 고정 IP — 직접 입력(떨어진 IP)</H>
          <div className="muted">연속되지 않은 IP가 필요할 때, <b>한 줄에 하나</b>씩 입력하면 VM 순서대로 1:1 매핑됩니다. 입력한 IP 개수만큼 생성됩니다(개수 자동).<br /><span style={code}>10.0.10.50</span> · <span style={code}>10.0.20.17</span> · <span style={code}>172.16.8.200</span></div>
          <H>3) DHCP</H>
          <div className="muted">IP를 비우고 DHCP를 선택하면 게스트가 부팅 후 DHCP로 주소를 받습니다. (마스크/게이트웨이 입력 불필요)</div>
          <H>4) 다중 NIC (NIC2, NIC3 …)</H>
          <div className="muted">‘추가 NIC’로 NIC를 더하면 각 NIC에 별도 IP 대역을 줄 수 있습니다. 적용 기준은 <b>가상 NIC의 순서</b>입니다 — 위에서부터 NIC1, NIC2 … 순으로 매핑됩니다. 각 NIC도 순차 증가 또는 DHCP를 선택할 수 있습니다.</div>
          <H>5) MAC 바인딩(선택) · 인터페이스 이름에 대한 사실</H>
          <div className="muted">MAC을 입력하면 그 MAC을 가진 NIC에 설정을 바인딩합니다. 다만 클론으로 <b>여러 대</b>를 만들면 각 VM의 MAC이 새로 생성되므로 MAC 바인딩은 보통 <b>1대 생성</b> 시에만 의미가 있습니다.<br />
            <b style={{ color: 'var(--amber)' }}>중요:</b> vSphere 게스트 커스터마이징은 <b>게스트 인터페이스 이름(ens192 / eth0 / Ethernet0)으로 IP를 지정하는 기능이 없습니다.</b> ‘순서(또는 MAC)’ 기준만 지원하며, 인터페이스 이름은 게스트 OS가 부팅하면서 정합니다.</div>
          <H>6) 적용 조건(실동작)</H>
          <div className="muted">고정 IP 적용에는 원본 템플릿에 <b>VMware Tools</b>와 게스트 커스터마이징 지원(Linux: perl/cloud-init, Windows: Sysprep)이 필요합니다. 누락 시 IP가 적용되지 않을 수 있습니다. 라이브 적용은 운영 vCenter에서 먼저 1대로 검증을 권장합니다.</div>
        </div>
      </div>
    </div>
  );
}
