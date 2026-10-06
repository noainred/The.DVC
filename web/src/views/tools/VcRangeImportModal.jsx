/**
 * VcRangeImportModal.jsx — '/24 대역 가져오기' 확인 창(v2.690, 사용자 요청: 버튼을 누르면 **어떤 대역을 추가할지 물어보는 창**).
 *
 * 열면 서버(GET /admin/ipam/vc-ranges/suggest)에서 /24 목록을 받고, 저장하지 않은 입력·다른 vCenter 저장분과 비교해
 * 행마다 상태를 보인다(vcRangeImportText.classifySubnets). '추가' 를 눌러야 텍스트 박스가 바뀐다 — 저장은 여전히 '대역 저장'.
 *  · 새 대역은 기본 체크, 이미 입력된 것은 기본 해제. 다른 vCenter 와 겹치는 것·일부 겹침은 기본 체크이지만 텍스트 박스가 아니라
 *    아래 '중복 대역' 칸으로 간다(사용자 요청: 중복은 작은 칸에서 보여 주고 고칠 수 있게).
 *  · iDRAC 은 DataCenter 를 고를 수 있다 — 기본은 그 vCenter 가 속한 DataCenter, 할당이 없으면 비워 두고 고르게 한다.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Modal } from '../../components/Modal.jsx';
import { STable } from '../../components/STable.jsx';
import { errorBoxInput } from '../../components/accessDeniedText.js';
import { classifySubnets, countKinds, idracSummaryText, KIND_LABEL, vmSummaryText } from './vcRangeImportText.js';
import Select from '../../components/Select.jsx';

const KIND_COLOR = { new: 'var(--green)', covered: 'var(--text-dim)', partial: 'var(--amber)', other: 'var(--amber)', invalid: 'var(--red)' };

export function VcRangeImportModal({ kind, vc, vcName, text, saved, onClose, onConfirm }) {
  const [dcId, setDcId] = useState(''); // '' = 서버가 그 vCenter 의 DataCenter 를 쓴다
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [chosen, setChosen] = useState(null); // Set<cidr> — 응답이 오면 기본값으로 채운다
  useEffect(() => {
    let alive = true;
    setData(null); setErr(null); setChosen(null);
    fetchJson('/admin/ipam/vc-ranges/suggest', { vcenterId: vc, kind, ...(dcId ? { datacenterId: dcId } : {}) })
      .then((r) => { if (alive) setData(r); })
      .catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, [vc, kind, dcId]);
  const rows = useMemo(() => classifySubnets(data?.subnets || [], { text, saved, vc }), [data, text, saved, vc]);
  useEffect(() => {
    if (!data) return;
    setChosen(new Set(rows.filter((r) => r.kind !== 'covered' && r.kind !== 'invalid').map((r) => r.cidr)));
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = countKinds(rows);
  const sel = chosen || new Set();
  const selRows = rows.filter((r) => sel.has(r.cidr));
  const selNew = selRows.filter((r) => r.kind === 'new').length;
  const selDup = selRows.length - selNew;
  const toggle = (cidr) => setChosen((c) => { const x = new Set(c || []); if (x.has(cidr)) x.delete(cidr); else x.add(cidr); return x; });
  const setAll = (on) => setChosen(new Set(on ? rows.filter((r) => r.kind !== 'invalid').map((r) => r.cidr) : []));
  const title = kind === 'idrac' ? `iDRAC 대역 가져오기 — ${vcName || vc}` : `VM 대역 가져오기 — ${vcName || vc}`;
  const e = err ? errorBoxInput(err) : null;
  return (
    <Modal title={title} onClose={onClose} width={760}>
      <div style={{ fontSize: 12, lineHeight: 1.6 }}>
        {kind === 'idrac'
          ? <div className="muted">선택한 DataCenter 의 <b>iDRAC 스캔 대역</b>을 /24 로 나눠 이 vCenter 의 스캔 대역에 추가합니다.</div>
          : <div className="muted">이 vCenter 의 <b>VM 이 쓰는 IPv4 주소</b>를 /24 로 묶어 이 vCenter 의 스캔 대역에 추가합니다.</div>}
        {kind === 'idrac' && data && (
          <div className="flex gap wrap" style={{ alignItems: 'center', margin: '8px 0' }}>
            <span>DataCenter</span>
            <Select className="select" value={dcId || data.datacenterId || ''} onChange={(ev) => setDcId(ev.target.value)} style={{ maxWidth: '100%', minWidth: 0 }} aria-label="DataCenter 선택">
              <option value="">(선택)</option>
              {(data.datacenters || []).map((d) => <option key={d.id} value={d.id}>{d.name}{d.id === data.assignedDatacenterId ? ' (이 vCenter 소속)' : ''}</option>)}
            </Select>
            {data.datacentersError && <span style={{ color: 'var(--amber)' }}>DataCenter 목록을 읽지 못했습니다({data.datacentersError})</span>}
          </div>
        )}
        {!data && !err && <div className="muted" style={{ margin: '10px 0' }}>계산하는 중…</div>}
        {e && <div className="banner warn" role="status" style={{ whiteSpace: 'normal', margin: '8px 0' }}>{e.text}</div>}
        {data && (
          <>
            <div style={{ margin: '6px 0' }}>{kind === 'idrac' ? idracSummaryText(data) : vmSummaryText(data)}</div>
            {data.rangesError && <div style={{ color: 'var(--amber)' }}>iDRAC 스캔 대역 파일을 읽지 못했습니다({data.rangesError}) — 아래 목록은 비어 있을 수 있습니다.</div>}
            {kind === 'idrac' && (data.invalid || []).length > 0 && (
              <div style={{ color: 'var(--amber)' }}>{data.invalid.slice(0, 5).map((x, i) => <div key={i}>△ {x.service}: ‘{x.value}’ — {x.reason}</div>)}</div>
            )}
            {rows.length > 0 && (
              <>
                <div className="flex gap wrap" style={{ alignItems: 'center', margin: '8px 0 4px' }}>
                  <span className="muted">새 대역 {n.new} · 이미 입력됨 {n.covered} · 일부 겹침 {n.partial} · 다른 vCenter 와 겹침 {n.other}</span>
                  <button className="tab" style={{ flex: 'none', padding: '3px 8px', fontSize: 11 }} onClick={() => setAll(true)}>모두 선택</button>
                  <button className="tab" style={{ flex: 'none', padding: '3px 8px', fontSize: 11 }} onClick={() => setAll(false)}>모두 해제</button>
                </div>
                <div style={{ maxHeight: 340, overflowY: 'auto' }}>
                  <STable className="v3-table" minWidth={340}>
                    <thead><tr><th data-nosort>추가</th><th>대역(/24)</th><th>상태 · 근거</th></tr></thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.cidr}>
                          <td data-sort={sel.has(r.cidr) ? 1 : 0}><input type="checkbox" aria-label={`${r.cidr} 추가`} checked={sel.has(r.cidr)} disabled={r.kind === 'invalid'} onChange={() => toggle(r.cidr)} /></td>
                          <td style={{ fontFamily: 'monospace' }}>{r.cidr}</td>
                          <td data-sort={r.kind} style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                            <div style={{ color: KIND_COLOR[r.kind] }}>{KIND_LABEL[r.kind] || r.kind}{r.kind === 'other' && r.with?.length ? ` (${r.with.join(', ')})` : ''}</div>
                            <div className="muted" style={{ fontSize: 11 }}>
                              {kind === 'idrac'
                                ? `${(r.sources || []).join(', ')}${r.disabledOnly ? ' · 꺼진 스캔 대역' : ''}`
                                : `VM ${r.vms ?? 0}대 · 주소 ${r.ips ?? 0}개${r.sample?.length ? ` · ${r.sample.join(', ')}${(r.vms ?? 0) > r.sample.length ? ' …' : ''}` : ''}`}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </STable>
                </div>
              </>
            )}
            <div style={{ marginTop: 10 }}>
              <b>추가할 대역 {selRows.length}개</b>
              <span className="muted"> — 새 대역 {selNew}개는 스캔 대역 칸에, 겹치는 {selDup}개는 그 아래 ‘중복 대역’ 칸에 들어갑니다. 저장은 ‘대역 저장’ 을 눌러야 됩니다.</span>
            </div>
          </>
        )}
        <div className="flex gap" style={{ marginTop: 12, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button className="logout-btn" style={{ padding: '7px 14px' }} onClick={onClose}>취소</button>
          <button className="login-btn" style={{ flex: 'none', padding: '7px 14px' }} disabled={!data || selRows.length === 0}
            onClick={() => onConfirm(rows, sel)}>추가 ({selRows.length}개)</button>
        </div>
      </div>
    </Modal>
  );
}
