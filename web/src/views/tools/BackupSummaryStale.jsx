/**
 * Backup › Summary '백업 안 된 VM 찾기 — 전체 법인'(v2.836 — 사용자 요청 '지정한 시간만큼 백업되지 않은 VM 찾는 기능' + 시안 ① Summary).
 *   판정은 서버(GET /tools/backup-summary/stale — backupPolicy.staleOf · 법인마다 Detail 과 같은 VM 행)가 하고 화면은 그린다.
 *   무거운 집계라 폴링하지 않는다 — 구획을 처음 펼칠 때와 '찾기' 를 누를 때만 부른다 · 늦게 온 이전 응답은 버린다 · 조건은 이 브라우저에 기억(Detail 과 따로).
 *   한쪽(Veeam·Bareos)을 모르는 VM 은 '모름' 으로 따로 센다(미달로 단정하지 않는다). 행은 서버 상한까지만 오고 수는 전부 센다.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { fmtNum, staleReason, STALE_UNITS, loadStaleOpts, saveStaleOpts, lastOkText, agoText, folderTail, methodOf } from './backupViewText.js';
import { SUMMARY_STALE_KEY, staleQuery, staleQueryMatches } from './backupSummaryText.js';

const SRC = [['all', '실제 백업 전부(Veeam · Bareos)'], ['veeam', 'Veeam 만'], ['bareos', 'Bareos 만']];
const KIND = { never: { text: '한 번도 없음', color: '#fca5a5' }, old: { text: '기준 넘음', color: '#fdba74' }, unknown: { text: '모름', color: 'var(--text-dim)' } };
const OPEN_KEY = 'backup-summary.stale-open';
const loadOpen = () => { try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; } };

export default function BackupSummaryStale({ scope, onOpenDetail }) {
  const [o, setO] = useState(() => loadStaleOpts(undefined, SUMMARY_STALE_KEY));
  const [open, setOpen] = useState(loadOpen);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [all, setAll] = useState(false);   // 표 전부 보기(처음엔 50줄 — 정렬 뒤 자른다)
  const gen = useRef(0);
  useEffect(() => { saveStaleOpts(o, undefined, SUMMARY_STALE_KEY); }, [o]);
  useEffect(() => { try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* 저장 못 해도 동작 */ } }, [open]);
  const find = useCallback(() => {
    const params = staleQuery(o, scope);
    if (!params) return;
    const my = ++gen.current;
    setLoading(true); setError(null);
    fetchJson('/tools/backup-summary/stale', params)
      .then((r) => { if (my === gen.current) setData(r); })
      .catch((e) => { if (my === gen.current) setError(e); })
      .finally(() => { if (my === gen.current) setLoading(false); });
  }, [o, scope]);
  // 처음 펼칠 때 한 번 찾는다(조건은 기억한 값) · 범위 옵션(전원·제외)이 바뀌면 지난 결과는 버린다
  const scopeSig = `${scope?.power || ''}|${scope?.excl === false ? 0 : 1}`;
  const lastScope = useRef(scopeSig);
  useEffect(() => { if (lastScope.current !== scopeSig) { lastScope.current = scopeSig; gen.current++; setData(null); setLoading(false); } }, [scopeSig]);
  useEffect(() => { if (open && !data && !loading && !error) find(); }, [open, data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { gen.current++; }, []);

  const set = (patch) => setO((cur) => ({ ...cur, ...patch }));
  const unitText = (STALE_UNITS.find(([k]) => k === o.unit) || ['', '일'])[1];
  const bad = staleQuery(o, scope) == null;
  const fresh = data && staleQueryMatches(data, o);
  const at = data?.at || Date.now();
  const q = data?.q;
  const qUnit = q ? (STALE_UNITS.find(([k]) => k === q.unit) || ['', '일'])[1] : unitText;

  return (
    <section className="card" aria-label="백업 안 된 VM 찾기 — 전체 법인" data-backup-stale-all="" style={{ padding: 0, overflow: 'hidden', minWidth: 0, border: '1px solid rgba(239,68,68,.4)' }}>
      <div className="flex wrap" style={{ alignItems: 'center', gap: '6px 12px', padding: '10px 14px' }}>
        <b style={{ fontSize: 14 }}>백업 안 된 VM 찾기</b>
        <span className="muted" style={{ fontSize: 12 }}>전체 법인</span>
        <span style={{ fontSize: 12.5, minWidth: 0, overflowWrap: 'anywhere' }}>
          {loading ? <span className="muted">찾는 중…</span>
            : error ? <span style={{ color: '#fca5a5' }}>{error?.status === 403 ? '이 계정은 Detail 화면이 허용되지 않아 VM 목록을 볼 수 없습니다.' : `찾지 못했습니다 — ${String(error?.message || error).slice(0, 160)}`}</span>
              : data ? <>
                최근 <b>{q?.n}{qUnit}</b> 동안 성공한 백업이 없는 VM <b style={{ color: data.n ? '#fca5a5' : '#86efac' }}>{fmtNum(data.n)}대</b>
                <span className="muted"> — 한 번도 없음 {fmtNum(data.never)} · 기준 넘음 {fmtNum(data.old)} · 법인 {fmtNum(data.sites)}곳{data.unknown ? ` · 모름 ${fmtNum(data.unknown)}(따로 셉니다)` : ''}{q?.excludeNone ? ` · 백업 안함 정책 ${fmtNum(data.excluded?.none)}대 제외` : ''}{q?.onlyOn ? ` · 꺼진 VM ${fmtNum(data.excluded?.off)}대 제외` : ''}</span>
              </> : <span className="muted">펼치면 전 법인에서 찾습니다.</span>}
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
            <button type="button" className="tab active" disabled={bad || loading} onClick={find} style={{ marginLeft: 'auto', padding: '3px 14px', fontSize: 12 }}>{loading ? '찾는 중…' : '찾기'}</button>
          </div>
          {bad && <div className="muted" style={{ padding: '0 14px 10px', fontSize: 12.5 }}>기간을 1~999 로 적으세요.</div>}
          {data && !fresh && !loading && <div style={{ padding: '0 14px 10px', fontSize: 12.5, color: '#fcd34d' }}>조건이 바뀌었습니다 — 아래 목록은 지난 조건의 결과입니다. 찾기를 누르세요.</div>}
          {data && (data.rows?.length ? (
            <div style={{ overflowX: 'auto' }}>
              <STable minWidth={1040} limit={all ? 0 : 50}>
                <thead><tr><th>법인</th><th>VM</th><th>폴더</th><th>백업 정책</th><th>마지막 성공</th><th>경과</th><th>판정</th><th>이유</th></tr></thead>
                <tbody>
                  {data.rows.map((x) => {
                    const vm = x.vm || {}; const k = KIND[x.kind] || KIND.unknown; const pol = methodOf(vm.p);
                    return (
                      <tr key={`${x.vc}|${vm.id}`}>
                        <td data-sort={x.vcName} style={{ whiteSpace: 'nowrap' }}><button type="button" onClick={() => onOpenDetail?.(x.vc)} title={`${x.vcName} Detail 로 — 백업 정책 · 백업 등록`} style={{ background: 'none', border: 0, padding: 0, color: 'var(--text)', font: 'inherit', fontWeight: 700, cursor: 'pointer', textAlign: 'left' }}>{x.vcName} <span style={{ color: '#93c5fd' }}>›</span></button></td>
                        <td data-sort={vm.name} style={{ whiteSpace: 'nowrap' }}>
                          <b>{vm.name}</b>
                          {(vm.os === 'windows' || vm.os === 'linux') && <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 700, padding: '0 6px', borderRadius: 999, color: vm.os === 'windows' ? '#93c5fd' : '#5eead4', background: vm.os === 'windows' ? 'rgba(59,130,246,.18)' : 'rgba(20,184,166,.18)' }}>{vm.os === 'windows' ? 'Windows' : 'Linux'}</span>}
                        </td>
                        <td className="muted" style={{ fontSize: 12 }}>{folderTail(vm.folder)}</td>
                        <td data-sort={vm.p || ''}>{pol ? <span style={{ color: pol.color, fontWeight: 700, fontSize: 12 }}>{pol.text}</span> : <span className="muted">모름</span>}</td>
                        <td data-sort={x.last ?? ''} style={{ fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{lastOkText(vm)}</td>
                        <td data-sort={x.last == null ? '' : at - x.last} style={{ whiteSpace: 'nowrap', fontWeight: 700, color: k.color }}>{x.last == null ? '—' : agoText(at - x.last)}</td>
                        <td style={{ whiteSpace: 'nowrap', color: k.color, fontWeight: 700, fontSize: 12 }}>{k.text}</td>
                        <td style={{ fontSize: 12, minWidth: 200, overflowWrap: 'anywhere' }}>{staleReason(x, at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </STable>
            </div>
          ) : <div className="muted" style={{ padding: '4px 14px 14px', fontSize: 13 }}>조건에 맞는 VM 이 없습니다.</div>)}
          {data?.rows?.length > 50 && (
            <div className="flex" style={{ padding: '6px 14px', fontSize: 12, alignItems: 'center', gap: 8 }}>
              <span className="muted">{fmtNum(data.rows.length)}대 중 {fmtNum(all ? data.rows.length : 50)}대 · 제목을 누르면 정렬</span>
              <button type="button" className="tab" onClick={() => setAll((v) => !v)} style={{ marginLeft: 'auto', padding: '3px 12px', fontSize: 12 }}>{all ? '50대만 보기' : '전부 보기'}</button>
            </div>
          )}
          <div className="muted" style={{ padding: '8px 14px', fontSize: 11.5, borderTop: '1px solid var(--border-soft)', lineHeight: 1.6 }}>
            {data?.truncated ? `목록은 서버가 앞 ${fmtNum(data.rows.length)}대만 보냈습니다(전체 ${fmtNum(data.total)}대 — 수는 전부 셉니다) · ` : ''}
            마지막 성공 = Veeam 백업 완료 · Bareos 성공(T·W) 중 가장 늦은 것 — 지금 도는 실행은 성공으로 치지 않습니다 · 결과를 못 읽은 VM 은 ‘모름’ 으로 따로 세고 미달로 단정하지 않습니다 · SSH 정책 VM 은 포탈이 결과를 아직 읽지 못해 Veeam · Bareos 결과로만 봅니다 · 법인 이름을 누르면 그 법인의 Detail 로 갑니다(백업 정책 저장 · 백업 등록).
          </div>
        </div>
      )}
    </section>
  );
}
