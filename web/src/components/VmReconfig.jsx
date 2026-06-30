import React, { useState, useEffect } from 'react';
import { fetchJson, postJson } from '../api.js';
import { Modal } from './ui.jsx';

/**
 * VM 사양 변경 버튼/모달 — vCPU·RAM 증설, 디스크 증설/추가, NIC 추가/삭제(관리자 전용).
 * 안전: 증설만(감소·축소 차단은 서버에서도 강제), 변경 전 확인창, 감사로그.
 */
export function VmReconfigButton({ vm }) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => { fetchJson('/auth/me').then((r) => setIsAdmin(r.user?.role === 'admin')).catch(() => {}); }, []);
  if (!isAdmin) return null;
  return (
    <>
      <button className="logout-btn" onClick={() => setOpen(true)}>⚙ 사양 변경</button>
      {open && <VmReconfigModal vm={vm} onClose={() => setOpen(false)} />}
    </>
  );
}

const numOr = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

function VmReconfigModal({ vm, onClose }) {
  const [hw, setHw] = useState(null);
  const [networks, setNetworks] = useState([]);
  const [powerState, setPowerState] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  const [cpu, setCpu] = useState('');
  const [cps, setCps] = useState('');              // 코어/소켓
  const [ramGB, setRamGB] = useState('');
  const [grows, setGrows] = useState({});          // diskKey -> 목표 GB
  const [adds, setAdds] = useState([]);            // [{gb, ctrl}, ...]
  const [nicRemoves, setNicRemoves] = useState(() => new Set());
  const [nicAdds, setNicAdds] = useState([]);      // [networkId, ...]
  const [nicConn, setNicConn] = useState({});      // nicKey -> 원하는 연결상태(bool)

  const load = () => fetchJson(`/admin/vm/${encodeURIComponent(vm.id)}/hardware`).then((r) => {
    setHw(r.hw); setNetworks(r.networks || []); setPowerState(r.powerState || '');
    setCpu(r.hw.cpu); setCps(r.hw.coresPerSocket || 1); setRamGB(Math.round((r.hw.memMB || 0) / 1024)); setErr(null);
    setNicConn(Object.fromEntries((r.hw.nics || []).map((n) => [n.key, n.connected])));
  }).catch((e) => setErr(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const poweredOn = /on/i.test(powerState);
  const cpuBlocked = poweredOn && hw && !hw.cpuHotAdd;
  const memBlocked = poweredOn && hw && !hw.memHotAdd;

  const buildPlan = () => {
    const plan = {};
    if (hw && numOr(cpu, hw.cpu) !== hw.cpu) plan.numCPUs = numOr(cpu, hw.cpu);
    if (hw && numOr(cps, hw.coresPerSocket) !== (hw.coresPerSocket || 0) && numOr(cps, 0) >= 1) plan.coresPerSocket = numOr(cps, 0);
    if (hw && numOr(ramGB, 0) * 1024 !== hw.memMB) plan.memoryMB = numOr(ramGB, 0) * 1024;
    const diskGrows = Object.entries(grows)
      .map(([key, gb]) => ({ key: Number(key), newGB: numOr(gb, 0) }))
      .filter((g) => { const d = hw.disks.find((x) => x.key === g.key); return d && g.newGB > d.capacityGB; });
    if (diskGrows.length) plan.diskGrows = diskGrows;
    const diskAdds = adds.map((a) => ({ sizeGB: numOr(a.gb, 0), controllerKey: a.ctrl ? Number(a.ctrl) : undefined })).filter((a) => a.sizeGB > 0);
    if (diskAdds.length) plan.diskAdds = diskAdds;
    const nicAddList = nicAdds.map((id) => networks.find((n) => n.id === id)).filter(Boolean)
      .map((n) => (n.type === 'DISTRIBUTED_PORTGROUP' ? { type: n.type, networkMoref: n.moref } : { type: n.type, networkName: n.name }));
    if (nicAddList.length) plan.nicAdds = nicAddList;
    if (nicRemoves.size) plan.nicRemoves = [...nicRemoves];
    const nicConnects = (hw.nics || []).filter((n) => !nicRemoves.has(n.key) && nicConn[n.key] !== n.connected).map((n) => ({ key: n.key, connected: !!nicConn[n.key] }));
    if (nicConnects.length) plan.nicConnects = nicConnects;
    return plan;
  };

  const summary = () => {
    const s = [];
    if (hw && numOr(cpu, hw.cpu) !== hw.cpu) s.push(`vCPU ${hw.cpu}→${numOr(cpu, hw.cpu)}`);
    if (hw && numOr(cps, hw.coresPerSocket) !== (hw.coresPerSocket || 0) && numOr(cps, 0) >= 1) s.push(`코어/소켓 →${numOr(cps, 0)}`);
    if (hw && numOr(ramGB, 0) * 1024 !== hw.memMB) s.push(`RAM ${Math.round(hw.memMB / 1024)}→${numOr(ramGB, 0)}GB`);
    Object.entries(grows).forEach(([key, gb]) => { const d = hw?.disks.find((x) => x.key === Number(key)); if (d && numOr(gb, 0) > d.capacityGB) s.push(`${d.label} ${d.capacityGB}→${numOr(gb, 0)}GB`); });
    adds.forEach((a) => { if (numOr(a.gb, 0) > 0) s.push(`디스크 추가 +${numOr(a.gb, 0)}GB`); });
    nicAdds.forEach((id) => { const n = networks.find((x) => x.id === id); if (n) s.push(`NIC 추가(${n.name})`); });
    [...nicRemoves].forEach((k) => { const n = hw?.nics.find((x) => x.key === k); if (n) s.push(`NIC 삭제(${n.network || n.macAddress || k})`); });
    (hw?.nics || []).forEach((n) => { if (!nicRemoves.has(n.key) && nicConn[n.key] !== n.connected) s.push(`NIC ${nicConn[n.key] ? '연결' : '연결해제'}(${n.network || n.key})`); });
    return s;
  };

  const submit = async () => {
    const plan = buildPlan();
    const sum = summary();
    if (!sum.length) { setErr('변경 사항이 없습니다.'); return; }
    if (!window.confirm(`다음 변경을 적용합니다 — 운영 VM '${vm.name}':\n\n• ${sum.join('\n• ')}\n\n진행할까요?`)) return;
    setBusy(true); setErr(null); setDone(null);
    try {
      const r = await postJson(`/admin/vm/${encodeURIComponent(vm.id)}/reconfig`, plan);
      if (r.ok) { setDone(`완료 — ${(r.changes || sum).join(', ')}`); await load(); setAdds([]); setNicAdds([]); setNicRemoves(new Set()); setGrows({}); }
      else setErr(r.reason || '변경 실패');
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal title={`사양 변경 — ${vm.name}`} onClose={onClose} width={640}>
      {!hw && !err && <div className="muted">하드웨어 조회 중…</div>}
      {err && <div className="card" style={{ padding: '8px 12px', marginBottom: 10, borderLeft: '3px solid var(--red)', fontSize: 13 }}>⚠ {err}</div>}
      {done && <div className="card" style={{ padding: '8px 12px', marginBottom: 10, borderLeft: '3px solid var(--green)', fontSize: 13 }}>✓ {done}</div>}
      {hw && (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            전원 <b>{powerState || '?'}</b> · 증설만 가능합니다(감소·축소 차단). 디스크 증설/추가·NIC 추가/삭제는 온라인 가능.
            {(cpuBlocked || memBlocked) && <span style={{ color: 'var(--amber)' }}> · {cpuBlocked ? 'CPU' : ''}{cpuBlocked && memBlocked ? '/' : ''}{memBlocked ? '메모리' : ''} hot-add 꺼짐 → 전원 ON 상태에선 증설 불가(전원 OFF 후).</span>}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 24px' }}>
            <label className="flex between" style={{ padding: '6px 0', gap: 12 }}>
              <span className="muted">vCPU (현재 {hw.cpu})</span>
              <input className="input" type="number" min={hw.cpu} value={cpu} disabled={cpuBlocked} onChange={(e) => setCpu(e.target.value)} style={{ width: 100 }} />
            </label>
            <label className="flex between" style={{ padding: '6px 0', gap: 12 }}>
              <span className="muted">코어/소켓 (현재 {hw.coresPerSocket || 1})</span>
              <input className="input" type="number" min={1} value={cps} disabled={cpuBlocked} onChange={(e) => setCps(e.target.value)} style={{ width: 100 }} title="총 vCPU의 약수여야 합니다" />
            </label>
            <label className="flex between" style={{ padding: '6px 0', gap: 12 }}>
              <span className="muted">RAM GB (현재 {Math.round(hw.memMB / 1024)})</span>
              <input className="input" type="number" min={Math.round(hw.memMB / 1024)} value={ramGB} disabled={memBlocked} onChange={(e) => setRamGB(e.target.value)} style={{ width: 100 }} />
            </label>
          </div>

          <div className="muted" style={{ fontSize: 12, margin: '12px 0 4px' }}>디스크 (증설만)</div>
          {hw.disks.map((d) => (
            <div key={d.key} className="flex between" style={{ padding: '5px 0', gap: 12, alignItems: 'center' }}>
              <span style={{ fontSize: 13 }}>{d.label} <span className="muted">· 현재 {d.capacityGB}GB</span></span>
              <input className="input" type="number" min={d.capacityGB} placeholder={`${d.capacityGB}`} value={grows[d.key] ?? ''} onChange={(e) => setGrows((g) => ({ ...g, [d.key]: e.target.value }))} style={{ width: 110 }} />
            </div>
          ))}
          <div className="flex gap" style={{ marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {adds.map((a, i) => (
              <span key={i} className="flex" style={{ gap: 4, alignItems: 'center' }}>
                <input className="input" type="number" min={1} placeholder="GB" value={a.gb} onChange={(e) => setAdds((arr) => arr.map((x, j) => (j === i ? { ...x, gb: e.target.value } : x)))} style={{ width: 80 }} />
                {hw.scsi.length > 1 && (
                  <select className="select" value={a.ctrl} onChange={(e) => setAdds((arr) => arr.map((x, j) => (j === i ? { ...x, ctrl: e.target.value } : x)))} style={{ maxWidth: 150, fontSize: 12 }}>
                    {hw.scsi.map((s) => <option key={s.key} value={s.key}>{s.label || `SCSI ${s.busNumber}`}</option>)}
                  </select>
                )}
                <button className="logout-btn" style={{ padding: '2px 8px' }} onClick={() => setAdds((arr) => arr.filter((_, j) => j !== i))}>✕</button>
              </span>
            ))}
            <button className="logout-btn" style={{ padding: '5px 10px' }} onClick={() => setAdds((arr) => [...arr, { gb: '', ctrl: hw.scsi[0]?.key || '' }])}>+ 디스크 추가</button>
          </div>

          <div className="muted" style={{ fontSize: 12, margin: '14px 0 4px' }}>네트워크 어댑터(NIC)</div>
          {hw.nics.map((n) => (
            <div key={n.key} className="flex between" style={{ padding: '4px 0', gap: 12, alignItems: 'center' }}>
              <span style={{ fontSize: 13 }}>{n.label} <span className="muted">· {n.network || '—'} · {n.macAddress || ''}</span></span>
              <span className="flex" style={{ gap: 14, alignItems: 'center' }}>
                <label className="flex" style={{ gap: 4, alignItems: 'center' }}>
                  <input type="checkbox" checked={!!nicConn[n.key]} disabled={nicRemoves.has(n.key)} onChange={(e) => setNicConn((c) => ({ ...c, [n.key]: e.target.checked }))} /> 연결
                </label>
                <label className="flex" style={{ gap: 4, alignItems: 'center', color: 'var(--red)' }}>
                  <input type="checkbox" checked={nicRemoves.has(n.key)} onChange={(e) => setNicRemoves((s) => { const x = new Set(s); if (e.target.checked) x.add(n.key); else x.delete(n.key); return x; })} /> 삭제
                </label>
              </span>
            </div>
          ))}
          <div className="flex gap" style={{ marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {nicAdds.map((id, i) => (
              <span key={i} className="flex" style={{ gap: 4, alignItems: 'center' }}>
                <select className="select" value={id} onChange={(e) => setNicAdds((a) => a.map((x, j) => (j === i ? e.target.value : x)))} style={{ maxWidth: 220 }}>
                  <option value="">네트워크 선택…</option>
                  {networks.map((nw) => <option key={nw.id} value={nw.id}>{nw.name}{nw.type === 'DISTRIBUTED_PORTGROUP' ? ' (DVS)' : ''}</option>)}
                </select>
                <button className="logout-btn" style={{ padding: '2px 8px' }} onClick={() => setNicAdds((a) => a.filter((_, j) => j !== i))}>✕</button>
              </span>
            ))}
            <button className="logout-btn" style={{ padding: '5px 10px' }} onClick={() => setNicAdds((a) => [...a, ''])}>+ NIC 추가</button>
          </div>

          <div className="flex between" style={{ marginTop: 16, alignItems: 'center', gap: 12 }}>
            <span className="muted" style={{ fontSize: 12 }}>{summary().length ? `변경 ${summary().length}건: ${summary().join(', ')}` : '변경 사항 없음'}</span>
            <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={busy || !summary().length} onClick={submit}>{busy ? '적용 중…' : '적용'}</button>
          </div>
        </>
      )}
    </Modal>
  );
}
