import React, { useState, useEffect } from 'react';
import { fetchJson, postJson, can } from '../api.js';
import { Modal } from './Modal.jsx'; // v2.295: ui.jsx(셸) 역참조 순환 절단 — 구현 파일 직접 import
// 54회차 F4: 계획 · 확인 문구 · 못 읽은 현재 값 판정은 순수 모듈 하나(vitest 고정) — 못 읽은 vCPU · RAM · 디스크 용량은 '—' 로 보이고 잠근다.
import { cps0, cpuKnown, memKnown, diskCapKnown, ramGB0, curText, reconfigPlan, reconfigSummary, lockedItems } from './vmReconfigText.js';

/**
 * VM 사양 변경 버튼/모달 — vCPU·RAM 증설, 디스크 증설/추가, NIC 추가/삭제.
 * 접근 권한은 기능 권한 'vm.reconfig'로 통제(기본 admin 전용, 권한 매트릭스에서 부여 가능).
 * 안전: 증설만(감소·축소 차단은 서버에서도 강제), 변경 전 확인창, 감사로그.
 */
export function VmReconfigButton({ vm }) {
  const [open, setOpen] = useState(false);
  if (!can('vm.reconfig')) return null; // 서버 라우트도 requirePerm('vm.reconfig')로 강제
  return (
    <>
      <button className="logout-btn" onClick={() => setOpen(true)}>⚙ 사양 변경</button>
      {open && <VmReconfigModal vm={vm} onClose={() => setOpen(false)} />}
    </>
  );
}

// 용량 표기: 1000GB 이상은 TB로(소수 1자리, 정수면 소수 생략). 예: 11517GB→11.5TB, 1000GB→1TB.
const fmtCap = (gb) => {
  if (gb == null || !Number.isFinite(Number(gb))) return '?';
  const g = Number(gb);
  if (g >= 1000) { const t = g / 1000; return `${t % 1 === 0 ? t : t.toFixed(1)}TB`; }
  return `${Math.round(g)}GB`;
};

function VmReconfigModal({ vm, onClose }) {
  const [hw, setHw] = useState(null);
  const [networks, setNetworks] = useState([]);
  const [datastores, setDatastores] = useState([]);
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
    setHw(r.hw); setNetworks(r.networks || []); setDatastores(r.datastores || []); setPowerState(r.powerState || '');
    setCpu(cpuKnown(r.hw) ? r.hw.cpu : ''); setCps(r.hw.coresPerSocket || 1); setRamGB(ramGB0(r.hw) ?? ''); setErr(null);   // 54회차 F4: 못 읽은 값은 빈 칸(잠금)
    setNicConn(Object.fromEntries((r.hw.nics || []).map((n) => [n.key, n.connected])));
  }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const poweredOn = /on/i.test(powerState);
  const cpuBlocked = poweredOn && hw && !hw.cpuHotAdd;
  const memBlocked = poweredOn && hw && !hw.memHotAdd;

  const form = { cpu, cps, ramGB, grows, adds, nicAdds, nicRemoves, nicConn };
  const buildPlan = () => reconfigPlan(hw, form, networks);
  const summary = () => reconfigSummary(hw, form, networks);
  const cpuOk = cpuKnown(hw); const memOk = memKnown(hw);
  const locked = lockedItems(hw);

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
            {locked.length > 0 && <span style={{ color: 'var(--amber)' }}> · 현재 값을 읽지 못한 항목({locked.join(' · ')})은 증설 여부를 판정할 수 없어 잠갔습니다 — 창을 다시 열어 조회하세요.</span>}
          </div>

          {/* 2차 공통 기능 점검 8회차(Chromium 400px 판독): 두 열 고정이라 '코어/소켓' 라벨이 한 글자씩 세로로 쪼개지고 입력 칸이 잘렸다 — 좁으면 한 열. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '0 24px' }}>
            <label className="flex between" style={{ padding: '6px 0', gap: 12 }}>
              <span className="muted" style={{ minWidth: 0 }}>vCPU (현재 {curText(cpuOk ? hw.cpu : null)})</span>
              <input className="input" type="number" min={cpuOk ? hw.cpu : undefined} value={cpu} disabled={cpuBlocked || !cpuOk} title={cpuOk ? undefined : '현재 vCPU 수를 읽지 못해 변경을 잠갔습니다'} onChange={(e) => setCpu(e.target.value)} style={{ width: 100, flex: '0 0 100px' }} />
            </label>
            <label className="flex between" style={{ padding: '6px 0', gap: 12 }}>
              <span className="muted" style={{ minWidth: 0 }}>코어/소켓 (현재 {cps0(hw)})</span>
              <input className="input" type="number" min={1} value={cps} disabled={cpuBlocked || !cpuOk} onChange={(e) => setCps(e.target.value)} style={{ width: 100, flex: '0 0 100px' }} title={cpuOk ? '총 vCPU의 약수여야 합니다' : '현재 vCPU 수를 읽지 못해 변경을 잠갔습니다'} />
            </label>
            <label className="flex between" style={{ padding: '6px 0', gap: 12 }}>
              <span className="muted" style={{ minWidth: 0 }}>RAM GB (현재 {curText(ramGB0(hw))})</span>
              <input className="input" type="number" min={memOk ? ramGB0(hw) : undefined} value={ramGB} disabled={memBlocked || !memOk} title={memOk ? undefined : '현재 RAM 을 읽지 못해 변경을 잠갔습니다'} onChange={(e) => setRamGB(e.target.value)} style={{ width: 100, flex: '0 0 100px' }} />
            </label>
          </div>

          <div className="muted" style={{ fontSize: 12, margin: '12px 0 4px' }}>디스크 (증설만)</div>
          {hw.disks.map((d) => (
            <div key={d.key} className="flex between" style={{ padding: '5px 0', gap: 12, alignItems: 'center' }}>
              <span style={{ fontSize: 13 }}>{d.label} <span className="muted">· 현재 {curText(diskCapKnown(d) ? d.capacityGB : null, 'GB')}</span></span>
              <input className="input" type="number" min={diskCapKnown(d) ? d.capacityGB : undefined} placeholder={diskCapKnown(d) ? `${d.capacityGB}` : '—'} value={grows[d.key] ?? ''} disabled={!diskCapKnown(d)} title={diskCapKnown(d) ? undefined : '현재 용량을 읽지 못해 증설을 잠갔습니다'} onChange={(e) => setGrows((g) => ({ ...g, [d.key]: e.target.value }))} style={{ width: 110 }} />
            </div>
          ))}
          <div className="flex gap" style={{ marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {adds.map((a, i) => (
              <span key={i} className="flex" style={{ gap: 4, alignItems: 'center' }}>
                <input className="input" type="number" min={1} placeholder="GB" value={a.gb} onChange={(e) => setAdds((arr) => arr.map((x, j) => (j === i ? { ...x, gb: e.target.value } : x)))} style={{ width: 80 }} />
                {hw.scsi.length > 1 && (
                  <Select className="select" value={a.ctrl} onChange={(e) => setAdds((arr) => arr.map((x, j) => (j === i ? { ...x, ctrl: e.target.value } : x)))} style={{ maxWidth: 150, fontSize: 12 }}>
                    {hw.scsi.map((s) => <option key={s.key} value={s.key}>{s.label || `SCSI ${s.busNumber}`}</option>)}
                  </Select>
                )}
                {datastores.length > 0 && (
                  <Select className="select" value={a.ds} onChange={(e) => setAdds((arr) => arr.map((x, j) => (j === i ? { ...x, ds: e.target.value } : x)))} style={{ maxWidth: 200, fontSize: 12 }} title="디스크를 생성할 데이터스토어">
                    <option value="">기존 위치(자동)</option>
                    {datastores.map((d) => <option key={d.name} value={d.name}>{d.name} · 여유 {fmtCap(d.freeGB)} / 총 {fmtCap(d.capacityGB)}</option>)}
                  </Select>
                )}
                <button className="logout-btn" style={{ padding: '2px 8px' }} onClick={() => setAdds((arr) => arr.filter((_, j) => j !== i))}>✕</button>
              </span>
            ))}
            <button className="logout-btn" style={{ padding: '5px 10px' }} onClick={() => setAdds((arr) => [...arr, { gb: '', ctrl: hw.scsi[0]?.key || '', ds: '' }])}>+ 디스크 추가</button>
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
                <Select className="select" value={id} onChange={(e) => setNicAdds((a) => a.map((x, j) => (j === i ? e.target.value : x)))} style={{ maxWidth: 220 }}>
                  <option value="">네트워크 선택…</option>
                  {networks.map((nw) => <option key={nw.id} value={nw.id}>{nw.name}{nw.type === 'DISTRIBUTED_PORTGROUP' ? ' (DVS)' : ''}</option>)}
                </Select>
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

import Select from './Select.jsx';