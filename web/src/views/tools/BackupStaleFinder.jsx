/**
 * Backup › Detail '백업 안 된 VM 찾기'(v2.835 — 사용자 요청 '지정한 시간만큼 백업되지 않은 VM 찾는 기능' + 시안 ②).
 *   판정은 서버가 행에 실은 마지막 성공(lok)·정책(p)을 읽어 창(N 시간·일·주)과 비교만 한다(backupViewText.staleOf — 서버 backupPolicy.staleOf 와 한 쌍).
 *   한쪽(Veeam·Bareos)을 모르는 VM 은 미달로 단정하지 않고 '모름' 으로 따로 센다. 조건은 이 브라우저에 기억한다.
 *   찾은 VM 은 '결과 모두 선택' 으로 Detail 의 선택에 더한다 — 그다음 위 도구 줄(백업 정책 · 백업 등록)로 이어진다.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { fmtNum, findStale, staleReason, STALE_UNITS, loadStaleOpts, saveStaleOpts, lastOkText, agoText, folderTail, methodOf } from './backupViewText.js';

const SRC = [['all', '실제 백업 전부(Veeam · Bareos)'], ['veeam', 'Veeam 만'], ['bareos', 'Bareos 만']];
const KIND = { never: { text: '한 번도 없음', color: '#fca5a5' }, old: { text: '기준 넘음', color: '#fdba74' }, unknown: { text: '모름', color: 'var(--text-dim)' } };
const OPEN_KEY = 'backup-detail.stale-open';
const loadOpen = () => { try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; } };

export default function StaleFinder({ vms, now, checked, setChecked, writable, onOpen }) {
  const [o, setO] = useState(() => loadStaleOpts());
  const [open, setOpen] = useState(loadOpen);
  useEffect(() => { saveStaleOpts(o); }, [o]);
  useEffect(() => { try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* 저장 못 해도 동작 */ } }, [open]);
  const at = now || Date.now();
  const res = useMemo(() => findStale(vms, { ...o, now: at }), [vms, o, at]);
  const unitText = (STALE_UNITS.find(([k]) => k === o.unit) || ['', '일'])[1];
  const set = (patch) => setO((cur) => ({ ...cur, ...patch }));
  const pickable = res.rows.filter((x) => x.kind !== 'unknown').map((x) => x.vm.id);
  const allPicked = pickable.length > 0 && pickable.every((id) => checked.has(id));

  return (
    <section className="card" aria-label="백업 안 된 VM 찾기" data-backup-stale="" style={{ padding: 0, overflow: 'hidden', minWidth: 0, border: '1px solid rgba(239,68,68,.4)' }}>
      <div className="flex wrap" style={{ alignItems: 'center', gap: '6px 12px', padding: '10px 14px' }}>
        <b style={{ fontSize: 14 }}>백업 안 된 VM 찾기</b>
        <span style={{ fontSize: 12.5, minWidth: 0, overflowWrap: 'anywhere' }}>
          {res.windowMs == null ? <span className="muted">기간을 1~999 로 적으세요.</span> : <>
            최근 <b>{o.n}{unitText}</b> 동안 성공한 백업이 없는 VM <b style={{ color: res.n ? '#fca5a5' : '#86efac' }}>{fmtNum(res.n)}대</b>
            <span className="muted"> — 한 번도 없음 {fmtNum(res.never)} · 기준 넘음 {fmtNum(res.old)}{res.unknown ? ` · 모름 ${fmtNum(res.unknown)}(따로 셉니다)` : ''}{o.excludeNone ? ` · 백업 안함 정책 ${fmtNum(res.excluded.none)}대 제외` : ''}{o.onlyOn ? ` · 꺼진 VM ${fmtNum(res.excluded.off)}대 제외` : ''}</span>
          </>}
        </span>
        <button type="button" className="tab" aria-expanded={open} onClick={() => setOpen((v) => !v)} style={{ marginLeft: 'auto', padding: '3px 12px', fontSize: 12 }}>{open ? '접기' : '조건 · 목록'}</button>
      </div>
      {open && (
        <div style={{ borderTop: '1px solid var(--border-soft)' }}>
          <div className="flex wrap" style={{ alignItems: 'center', gap: '8px 10px', padding: '10px 14px', fontSize: 12.5 }}>
            <label className="flex" style={{ alignItems: 'center', gap: 6 }}>
              <span className="muted">최근</span>
              <input className="input" type="number" min="1" max="999" value={o.n} onChange={(e) => set({ n: e.target.value === '' ? '' : Number(e.target.value) })} aria-label="기간 수" style={{ width: 72, minWidth: 0 }} />
            </label>
            <Select className="input" sort={false} value={o.unit} onChange={(e) => set({ unit: e.target.value })} aria-label="기간 단위" style={{ minWidth: 0, width: 'auto' }}>
              {STALE_UNITS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
            </Select>
            <span className="muted">동안 성공한 백업 없음</span>
            <label className="flex" style={{ alignItems: 'center', gap: 6 }}>
              <span className="muted">기준</span>
              <Select className="input" sort={false} value={o.src} onChange={(e) => set({ src: e.target.value })} aria-label="찾기 기준" style={{ minWidth: 0, width: 'auto' }}>
                {SRC.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
              </Select>
            </label>
            <label className="flex" style={{ alignItems: 'center', gap: 5 }}><input type="checkbox" checked={o.excludeNone} onChange={(e) => set({ excludeNone: e.target.checked })} /> 백업 안함 정책 제외</label>
            <label className="flex" style={{ alignItems: 'center', gap: 5 }}><input type="checkbox" checked={o.onlyOn} onChange={(e) => set({ onlyOn: e.target.checked })} /> 켜진 VM 만</label>
            <label className="flex" style={{ alignItems: 'center', gap: 5 }}><input type="checkbox" checked={o.includeNever} onChange={(e) => set({ includeNever: e.target.checked })} /> 한 번도 없음 포함</label>
            {writable && (
              <button type="button" className="tab" disabled={!pickable.length} onClick={() => setChecked((cur) => { const s = new Set(cur); for (const id of pickable) { if (allPicked) s.delete(id); else s.add(id); } return s; })}
                title="찾은 VM(모름 제외)을 위 선택에 더합니다 — 그다음 도구 줄의 백업 정책·백업 등록으로" style={{ marginLeft: 'auto', padding: '3px 12px', fontSize: 12 }}>
                {allPicked ? '결과 선택 해제' : `결과 모두 선택(${fmtNum(pickable.length)})`}
              </button>
            )}
          </div>
          {res.rows.length === 0
            ? <div className="muted" style={{ padding: '4px 14px 14px', fontSize: 13 }}>{res.windowMs == null ? '' : '조건에 맞는 VM 이 없습니다.'}</div>
            : (
              <div style={{ overflowX: 'auto' }}>
                <STable minWidth={980} limit={300}>
                  <thead><tr>{writable && <th data-nosort style={{ width: 34 }} />}<th>VM</th><th>폴더</th><th>백업 정책</th><th>마지막 성공</th><th>경과</th><th>판정</th><th>이유</th></tr></thead>
                  <tbody>
                    {res.rows.map((x) => {
                      const vm = x.vm; const k = KIND[x.kind]; const pol = methodOf(vm.p);
                      return (
                        <tr key={vm.id}>
                          {writable && <td><input type="checkbox" aria-label={`${vm.name} 선택`} checked={checked.has(vm.id)} onChange={() => setChecked((cur) => { const s = new Set(cur); if (s.has(vm.id)) s.delete(vm.id); else s.add(vm.id); return s; })} /></td>}
                          <td data-sort={vm.name}><button type="button" onClick={() => onOpen?.(vm.id)} title="표에서 이 VM 의 상세 열기" style={{ background: 'none', border: 0, padding: 0, color: 'var(--text)', font: 'inherit', fontWeight: 700, cursor: 'pointer', textAlign: 'left' }}>{vm.name}</button></td>
                          <td className="muted" style={{ fontSize: 12 }}>{folderTail(vm.folder)}</td>
                          <td data-sort={vm.p || ''}>{pol ? <span style={{ color: pol.color, fontWeight: 700, fontSize: 12 }}>{pol.text}</span> : <span className="muted">모름</span>}</td>
                          <td data-sort={x.last ?? ''} style={{ fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{lastOkText(vm)}</td>
                          <td data-sort={x.last == null ? '' : at - x.last} style={{ whiteSpace: 'nowrap', fontWeight: 700, color: k.color }}>{x.last == null ? '—' : agoText(at - x.last)}</td>
                          <td style={{ whiteSpace: 'nowrap', color: k.color, fontWeight: 700, fontSize: 12 }}>{k.text}</td>
                          <td style={{ fontSize: 12, minWidth: 220, overflowWrap: 'anywhere' }}>{staleReason(x, at)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </STable>
              </div>
            )}
          <div className="muted" style={{ padding: '8px 14px', fontSize: 11.5, borderTop: '1px solid var(--border-soft)', lineHeight: 1.6 }}>
            마지막 성공 = Veeam 백업 완료 · Bareos 성공(T·W) 중 가장 늦은 것 — 지금 도는 실행은 성공으로 치지 않습니다 · 결과를 못 읽은 VM 은 ‘모름’ 으로 따로 세고 미달로 단정하지 않습니다 · SSH 정책 VM 은 포탈이 결과를 아직 읽지 못해 Veeam·Bareos 결과로만 봅니다 · 조건은 이 브라우저에 기억합니다.
          </div>
        </div>
      )}
    </section>
  );
}
