/**
 * ScanRangeImportModal.jsx — 스캔 대역·설정(에이전트별)의 '/24 대역 가져오기' 확인 창(v2.691).
 *
 * v2.690 의 vCenter 별 확인 창(VcRangeImportModal)을 에이전트 기준으로 옮긴 것이다. 달라진 점:
 *  · iDRAC 은 **서비스별**로 보여 주고 하나를 골라 불러온다(사용자 요청 — 한 법인/DataCenter 에 서비스가 여럿이면 하나 선택).
 *    서비스마다 번호(1,2,3…)를 붙이고 이름이 없으면 '이름 없음' 으로 쓴다. 서비스의 원래 대역도 보여 준다.
 *  · VM 은 vCenter 를 고른다 — 이 에이전트가 수집하는 vCenter 가 앞에 온다.
 *  · 중복 판정의 '다른 쪽' 은 다른 에이전트의 스캔 대역(+ 아직 옮기지 못한 vCenter 별 대역)이다.
 * 판정 코어는 vcRangeImportText.classifySubnets 한 벌이다(사본 금지). '추가' 를 눌러야 텍스트 박스가 바뀌고 저장은 '저장' 이다.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Modal } from '../../components/Modal.jsx';
import { STable } from '../../components/STable.jsx';
import { errorBoxInput } from '../../components/accessDeniedText.js';
import { classifySubnets, countKinds, vmSummaryText } from './vcRangeImportText.js';
import { AGENT_KIND_LABEL, CLS_BADGE, CLS_FILTERS, CLS_LABEL, agentName, clsCounts, defaultChosen, defaultServiceNo, filterByCls, idracHeadText, ignoredText, partialIgnoreText, serviceMeta, serviceTitle, serviceUnnamed } from './scanRangeImportText.js';

const KIND_COLOR = { new: 'var(--green)', covered: 'var(--text-dim)', partial: 'var(--amber)', other: 'var(--amber)', invalid: 'var(--red)' };
/** 선택했지만 필터 때문에 안 보이는 행 수 — 숨긴 채 추가되는 줄이 있다는 사실을 말한다. */
function selRowsHidden(rows, shown, chosen) { if (!chosen) return 0; const vis = new Set(shown.map((r) => r.cidr)); return rows.filter((r) => chosen.has(r.cidr) && !vis.has(r.cidr)).length; }
const SVC_KEY = 'svc'; // classifySubnets 의 vc 자리 — saved 목록에 같은 키가 없으므로 아무것도 빼지 않는다

export function ScanRangeImportModal({ kind, agent, text, saved, onClose, onConfirm }) {
  const [pickDc, setPickDc] = useState('');   // '' = 서버가 이 에이전트의 DataCenter 를 쓴다
  const [pickVc, setPickVc] = useState('');   // '' = 서버가 이 에이전트의 첫 vCenter 를 쓴다
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [svcNo, setSvcNo] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [cls, setCls] = useState(''); // v2.692: 공인/사설 필터(표시만 거른다 — 선택은 그대로)
  useEffect(() => {
    let alive = true;
    setData(null); setErr(null); setChosen(null);
    const q = { agent, kind, ...(kind === 'idrac' && pickDc ? { datacenterId: pickDc } : {}), ...(kind === 'vm' && pickVc ? { vcenterId: pickVc } : {}) };
    fetchJson('/admin/ipam/scan/import', q)
      .then((r) => { if (!alive) return; setData(r); if (kind === 'idrac') setSvcNo(defaultServiceNo(r.services)); })
      .catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, [agent, kind, pickDc, pickVc]);
  const services = data?.services || [];
  const svc = kind === 'idrac' ? services.find((s) => s.no === svcNo) || null : null;
  const subnets = kind === 'idrac' ? (svc?.subnets || []) : (data?.subnets || []);
  const rows = useMemo(() => classifySubnets(subnets, { text, saved, vc: SVC_KEY }), [subnets, text, saved]);
  useEffect(() => { setChosen(defaultChosen(rows)); }, [data, svcNo]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = filterByCls(rows, cls);
  const clsN = clsCounts(rows);
  const ignored = kind === 'idrac' ? svc?.ignored : data?.ignored;
  const ignoredLine = ignoredText(ignored, data?.ignoreSources);
  const n = countKinds(rows);
  const sel = chosen || new Set();
  const selRows = rows.filter((r) => sel.has(r.cidr));
  const selNew = selRows.filter((r) => r.kind === 'new').length;
  const toggle = (cidr) => setChosen((c) => { const x = new Set(c || []); if (x.has(cidr)) x.delete(cidr); else x.add(cidr); return x; });
  const setAll = (on) => setChosen((c) => { const x = new Set(c || []); for (const r of shown) { if (r.kind === 'invalid') continue; if (on) x.add(r.cidr); else x.delete(r.cidr); } return x; }); // 보이는(필터) 행만
  const hiddenSel = selRowsHidden(rows, shown, chosen);
  const who = agentName(agent);
  const title = kind === 'idrac' ? `iDRAC 대역 가져오기 — ${who}` : `VM 대역 가져오기 — ${who}`;
  const e = err ? errorBoxInput(err) : null;
  return (
    <Modal title={title} onClose={onClose} width={780}>
      <div style={{ fontSize: 12, lineHeight: 1.6 }}>
        {kind === 'idrac'
          ? <div className="muted">DataCenter 의 <b>iDRAC 스캔 대역</b> 중 <b>서비스 1개</b>를 골라 /24 로 나눠 이 에이전트의 스캔 대역에 추가합니다.</div>
          : <div className="muted">고른 vCenter 의 <b>VM 이 쓰는 IPv4 주소</b>를 /24 로 묶어 이 에이전트의 스캔 대역에 추가합니다.</div>}
        {data && kind === 'idrac' && (
          <div className="flex gap wrap" style={{ alignItems: 'center', margin: '8px 0' }}>
            <span>DataCenter</span>
            <select className="select" value={pickDc || data.datacenterId || ''} onChange={(ev) => setPickDc(ev.target.value)} style={{ maxWidth: '100%', minWidth: 0 }} aria-label="DataCenter 선택">
              <option value="">(선택)</option>
              {(data.datacenters || []).map((d) => <option key={d.id} value={d.id}>{d.name}{d.id === data.assignedDatacenterId ? ' (이 에이전트 소속)' : ''}</option>)}
            </select>
            {data.datacentersError && <span style={{ color: 'var(--amber)' }}>DataCenter 목록을 읽지 못했습니다({data.datacentersError})</span>}
          </div>
        )}
        {data && kind === 'vm' && (
          <div className="flex gap wrap" style={{ alignItems: 'center', margin: '8px 0' }}>
            <span>vCenter</span>
            <select className="select" value={pickVc || data.vcenterId || ''} onChange={(ev) => setPickVc(ev.target.value)} style={{ maxWidth: '100%', minWidth: 0 }} aria-label="vCenter 선택">
              {!data.vcenterId && <option value="">(선택)</option>}
              {(data.vcenters || []).map((v) => <option key={v.id} value={v.id}>{v.name}{v.mine ? ' (이 에이전트가 수집)' : ''}</option>)}
            </select>
            {data.vcenterId && !data.vcenterMine && <span style={{ color: 'var(--amber)' }}>이 에이전트가 수집하지 않는 vCenter 입니다 — 이 에이전트 사이트에서 닿는 대역인지 확인하세요.</span>}
          </div>
        )}
        {!data && !err && <div className="muted" style={{ margin: '10px 0' }}>계산하는 중…</div>}
        {e && <div className="banner warn" role="status" style={{ whiteSpace: 'normal', margin: '8px 0' }}>{e.text}</div>}
        {data && kind === 'idrac' && (
          <>
            <div style={{ margin: '6px 0' }}>{idracHeadText(data)}</div>
            {data.rangesError && <div style={{ color: 'var(--amber)' }}>iDRAC 스캔 대역 파일을 읽지 못했습니다({data.rangesError}) — 아래 목록은 비어 있을 수 있습니다.</div>}
            {services.length > 0 && (
              <div role="radiogroup" aria-label="iDRAC 스캔 대역 서비스" style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '8px 0' }}>
                {services.map((s) => {
                  const on = s.no === svcNo;
                  return (
                    <button key={s.id || s.no} type="button" role="radio" aria-checked={on} onClick={() => setSvcNo(s.no)}
                      style={{ display: 'flex', gap: 12, alignItems: 'center', width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 10, cursor: 'pointer', font: 'inherit', color: 'inherit', textAlign: 'left', minHeight: 56,
                        background: on ? 'rgba(59,130,246,.16)' : 'var(--panel)', border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}` }}>
                      <span style={{ flex: 'none', width: 28, height: 28, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, background: on ? 'var(--accent)' : 'var(--border)', color: '#fff' }}>{s.no}</span>
                      <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: '1 1 auto' }}>
                        <span className="flex gap wrap" style={{ alignItems: 'center' }}>
                          <b style={serviceUnnamed(s) ? { color: 'var(--text-dim)', fontStyle: 'italic' } : undefined}>{serviceTitle(s).replace(/^\d+\.\s*/, '')}</b>
                          <span className="muted" style={{ fontSize: 11 }}>{serviceMeta(s)}</span>
                        </span>
                        <span style={{ fontFamily: 'monospace', fontSize: 11.5, overflowWrap: 'anywhere' }}>{(s.ranges || []).join('   ') || '—'}</span>
                      </span>
                      <span aria-hidden="true" style={{ flex: 'none', width: 16, height: 16, borderRadius: 999, boxSizing: 'border-box', border: on ? '5px solid var(--accent)' : '2px solid var(--text-dim)' }} />
                    </button>
                  );
                })}
              </div>
            )}
            {svc && (svc.invalid || []).length > 0 && (
              <div style={{ color: 'var(--amber)' }}>{svc.invalid.slice(0, 5).map((x, i) => <div key={i}>△ ‘{x.value}’ — {x.reason}</div>)}</div>
            )}
          </>
        )}
        {data && kind === 'vm' && data.vcenterId && <div style={{ margin: '6px 0' }}>{vmSummaryText(data)}</div>}
        {data && kind === 'vm' && data.noVcenter && <div className="muted" style={{ margin: '6px 0' }}>vCenter 를 고르세요 — 이 에이전트가 수집하는 vCenter 를 찾지 못했습니다(임의로 고르지 않습니다).</div>}
        {data && ignoredLine && <div className="card" style={{ padding: '7px 10px', margin: '8px 0 4px', fontSize: 12, whiteSpace: 'normal' }}>{ignoredLine}</div>}
        {data && rows.length > 0 && (
          <>
            <div className="flex gap wrap" role="group" aria-label="공인/사설 분류 필터" style={{ alignItems: 'center', margin: '8px 0 2px' }}>
              <span className="muted">분류</span>
              {CLS_FILTERS.filter((f) => !f.key || clsN[f.key] > 0 || cls === f.key).map((f) => (
                <button key={f.key || 'all'} type="button" className={`tab${cls === f.key ? ' active' : ''}`} aria-pressed={cls === f.key} style={{ flex: 'none', padding: '3px 10px', fontSize: 11.5 }} onClick={() => setCls(f.key)}>{f.label} {clsN[f.key]}</button>
              ))}
              <span className="muted" style={{ fontSize: 11 }}>IPMS 설정 ③ 공인/사설 기준(명시 대역 우선 → 없으면 RFC1918). 공인 /24 는 기본으로 체크를 풀어 둡니다.</span>
            </div>
            <div className="flex gap wrap" style={{ alignItems: 'center', margin: '8px 0 4px' }}>
              {svc && <b>{serviceTitle(svc)} — /24 {rows.length}개</b>}
              <span className="muted">새 대역 {n.new} · 이미 입력됨 {n.covered} · 일부 겹침 {n.partial} · 다른 에이전트와 겹침 {n.other}</span>
              <button className="tab" style={{ flex: 'none', padding: '3px 8px', fontSize: 11 }} onClick={() => setAll(true)}>모두 선택</button>
              <button className="tab" style={{ flex: 'none', padding: '3px 8px', fontSize: 11 }} onClick={() => setAll(false)}>모두 해제</button>
            </div>
            <div style={{ maxHeight: 300, overflowY: 'auto' }}>
              <STable className="v3-table" minWidth={340}>
                <thead><tr><th data-nosort>추가</th><th>대역(/24)</th><th>분류</th><th>상태 · 근거</th></tr></thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.cidr}>
                      <td data-sort={sel.has(r.cidr) ? 1 : 0}><input type="checkbox" aria-label={`${r.cidr} 추가`} checked={sel.has(r.cidr)} disabled={r.kind === 'invalid'} onChange={() => toggle(r.cidr)} /></td>
                      <td style={{ fontFamily: 'monospace' }}>{r.cidr}</td>
                      <td data-sort={r.cls || ''}>{r.cls ? <span className={`badge ${CLS_BADGE[r.cls] || 'gray'}`}>{CLS_LABEL[r.cls] || r.cls}</span> : <span className="muted">—</span>}</td>
                      <td data-sort={r.kind} style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                        <div style={{ color: KIND_COLOR[r.kind] }}>{AGENT_KIND_LABEL[r.kind] || r.kind}{r.kind === 'other' && r.with?.length ? ` (${r.with.join(', ')})` : ''}</div>
                        {r.ignore === 'partial' && <div style={{ fontSize: 11, color: 'var(--amber)' }}>△ {partialIgnoreText(r, data?.ignoreSources)}</div>}
                        {kind === 'vm' && <div className="muted" style={{ fontSize: 11 }}>{`VM ${r.vms ?? 0}대 · 주소 ${r.ips ?? 0}개${r.sample?.length ? ` · ${r.sample.join(', ')}${(r.vms ?? 0) > r.sample.length ? ' …' : ''}` : ''}`}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </STable>
            </div>
          </>
        )}
        {data && (svc || kind === 'vm') && rows.length === 0 && <div className="muted" style={{ margin: '8px 0' }}>가져올 /24 대역이 없습니다{Number(ignored?.count) > 0 ? ' — 남은 후보가 전부 IPMS 무시 대역이었습니다' : ''}.</div>}
        {data && (
          <div style={{ marginTop: 10 }}>
            <b>추가할 대역 {selRows.length}개</b>{hiddenSel > 0 && <span className="muted"> (지금 필터로 가린 {hiddenSel}개 포함)</span>}
            <span className="muted"> — 새 대역 {selNew}개는 스캔 대역 칸에, 겹치는 {selRows.length - selNew}개는 그 아래 ‘중복 대역’ 칸에 들어갑니다. 저장은 화면의 ‘저장’ 을 눌러야 됩니다.</span>
          </div>
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
