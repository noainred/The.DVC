/**
 * 한 대씩 고정(예외용, v2.885) — iDRAC 에서 식별된 서버(통합 서버 인벤토리 분류) 또는 VM 을 골라 서비스에 고정한다.
 * 묶음 연결(미지정 탭)이 먼저이고 이것은 묶을 출처가 없는 서버용이다. 자동 판정과 다르면 드리프트 큐에 오른다.
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../../api.js';
import { Modal } from '../../../components/Modal.jsx';
import { STable } from '../../../components/STable.jsx';
import Select from '../../../components/Select.jsx';
import { Loading, ErrorBox } from '../../../components/ui.jsx';
import { SRC_LABEL } from '../svcInventoryText.js';

const btn = { padding: '5px 10px', fontSize: 12, flex: 'none' };

export default function PinModal({ corp: corp0, corps, servicesOf, writableOf, defaultService = '', op, busy, onClose, corpName }) {
  const [kind, setKind] = useState('bm');
  const [corp, setCorp] = useState(corp0 || '');
  const [q, setQ] = useState('');
  const [onlyUn, setOnlyUn] = useState(true);
  const [items, setItems] = useState(null);
  const [err, setErr] = useState(null);
  const [checked, setChecked] = useState(() => new Set());
  const [target, setTarget] = useState(defaultService);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current; setErr(null); setItems(null);
    const h = setTimeout(() => {
      fetchJson('/tools/svc-inventory/candidates', { kind, corp, q, unassignedOnly: onlyUn ? '1' : '0' })
        .then((r) => { if (my === seq.current) setItems(r); }).catch((e) => { if (my === seq.current) setErr(e); });
    }, 250);
    return () => clearTimeout(h);
  }, [kind, corp, q, onlyUn]);
  useEffect(() => { setChecked(new Set()); }, [kind, corp]);
  const list = items?.items || [];
  const svcs = corp ? servicesOf(corp) : [];
  const toggle = (k, on) => setChecked((s) => { const n = new Set(s); if (on) n.add(k); else n.delete(k); return n; });
  const allOn = list.length > 0 && list.every((x) => checked.has(x.key));
  return (
    <Modal title="⊕ 한 대씩 고정 — iDRAC 식별 서버 · VM" onClose={onClose} width={1080}>
      <div className="flex wrap gap" style={{ alignItems: 'center', marginBottom: 10 }}>
        <div className="tabs" style={{ marginLeft: 0 }}>
          <button type="button" className={`tab${kind === 'bm' ? ' active' : ''}`} onClick={() => setKind('bm')}>iDRAC 식별 서버</button>
          <button type="button" className={`tab${kind === 'vm' ? ' active' : ''}`} onClick={() => setKind('vm')}>VM</button>
        </div>
        <Select className="select" value={corp} onChange={(e) => { setCorp(e.target.value); setTarget(''); }} style={{ maxWidth: 240 }} aria-label="법인">
          <option value="">법인 선택…</option>
          {corps.filter((c) => writableOf(c.vcenterId)).map((c) => <option key={c.vcenterId} value={c.vcenterId}>{c.name}</option>)}
        </Select>
        <label className="muted" style={{ fontSize: 12, display: 'inline-flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={onlyUn} onChange={(e) => setOnlyUn(e.target.checked)} /> 미소속만</label>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="이름·서비스태그·폴더·IP" style={{ maxWidth: 220 }} />
        <span className="muted" style={{ fontSize: 12 }}>{items ? `${list.length}대 후보${items.omitted ? ` (상한으로 ${items.omitted}대 생략)` : ''}` : ''}</span>
      </div>
      {!corp ? <div className="muted" style={{ padding: 12 }}>고정할 법인을 먼저 고르십시오(쓰기 범위가 있는 법인만 보입니다). 법인 귀속이 없는 서버는 통합 서버 인벤토리에서 법인을 먼저 정합니다.</div>
        : err ? <ErrorBox error={err} /> : !items ? <Loading /> : (
          <div style={{ maxHeight: '52vh', overflow: 'auto' }}>
            <STable className="table" minWidth={820} wrap={false}>
              <thead><tr>
                <th data-nosort><input type="checkbox" checked={allOn} onChange={(e) => setChecked(e.target.checked ? new Set(list.map((x) => x.key)) : new Set())} aria-label="현재 목록 전부 선택" /></th>
                <th>이름</th><th>키</th><th>출처</th><th>현재 소속</th>
              </tr></thead>
              <tbody>{!list.length ? <tr><td colSpan={5} className="muted" style={{ padding: 14 }}>조건에 맞는 후보가 없습니다{onlyUn ? ' — ‘미소속만’ 을 끄면 이미 소속된 서버도 보입니다' : ''}.</td></tr> : null}{list.map((x) => (
                <tr key={x.key}>
                  <td><input type="checkbox" checked={checked.has(x.key)} onChange={(e) => toggle(x.key, e.target.checked)} aria-label={`${x.name} 선택`} /></td>
                  <td><b>{x.name}</b></td>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{x.key}</td>
                  <td className="muted">{x.kind === 'vm' ? (x.folderPath == null ? '위치 모름' : x.folderPath) : (x.scanEntry ? '스캔 엔트리' : (x.source || '—'))}</td>
                  <td>{x.serviceId ? <span>{svcs.find((s) => s.id === x.serviceId)?.name || '?'} <span className="badge blue">{SRC_LABEL[x.src]}</span></span> : <span className="badge amber">(미지정)</span>}</td>
                </tr>
              ))}</tbody>
            </STable>
          </div>
        )}
      <div className="flex wrap gap" style={{ alignItems: 'center', marginTop: 10 }}>
        <span className="muted" style={{ fontSize: 12 }}>선택 <b>{checked.size}</b>대 → 대상 서비스</span>
        <Select className="select" value={target} onChange={(e) => setTarget(e.target.value)} style={{ maxWidth: 260 }} aria-label="대상 서비스">
          <option value="">서비스 선택…</option>
          {svcs.map((s) => <option key={s.id} value={s.id}>{s.path ? `${s.path}\\` : ''}{s.name}</option>)}
        </Select>
        <button type="button" className="login-btn" style={btn} disabled={busy || !checked.size || !target || !corp}
          onClick={async () => { const r = await op({ op: 'pins.set', corp, keys: [...checked], serviceId: target }, `${checked.size}대를 ‘${svcs.find((s) => s.id === target)?.name}’ 에 고정했습니다(${corpName(corp)}).`); if (r) onClose(); }}>고정</button>
        <span className="muted" style={{ fontSize: 12 }}>고정은 자동 규칙보다 우선하고, 자동 판정과 다르면 검토 탭의 드리프트로 오릅니다 · 감사 로그</span>
      </div>
    </Modal>
  );
}
