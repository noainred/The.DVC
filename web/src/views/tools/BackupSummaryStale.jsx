/**
 * Backup › Summary '백업 안 된 VM 찾기 — 전체 법인'(v2.836 — 사용자 요청 '지정한 시간만큼 백업되지 않은 VM 찾는 기능' + 시안 ①)
 *   → v2.837 시안에 맞춤: 법인 선택 · 기준 '정책에 맞는 백업만' · CSV · '실패만 반복' 수 · 체크박스(위 도구 줄로 — 한 법인 안에서만) ·
 *   실제 백업(마지막 결과) 열 · 조치 열.
 *   판정은 서버(GET /tools/backup-summary/stale — backupPolicy.staleOf · 법인마다 Detail 과 같은 VM 행)가 하고 화면은 그린다.
 *   무거운 집계라 폴링하지 않는다 — 구획을 처음 펼칠 때와 '찾기' 를 누를 때만 부른다 · 늦게 온 이전 응답은 버린다 · 조건은 이 브라우저에 기억(Detail 과 따로).
 *   한쪽(Veeam·Bareos)을 모르는 VM 은 '모름' 으로 따로 센다(미달로 단정하지 않는다). 행은 서버 상한까지만 오고 수는 전부 센다(CSV 는 전부).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, downloadFile, canCsv, toolAllowed } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { fmtNum, staleReason, STALE_UNITS, loadStaleOpts, saveStaleOpts, lastOkText, agoText, folderTail, methodOf, veeamCell, bareosCell } from './backupViewText.js';
import { SUMMARY_STALE_KEY, staleQuery, staleQueryMatches, staleAction } from './backupSummaryText.js';
import { saveHandoff } from './backupRunText.js';
import { saveBareosHandoff } from './bareosViewText.js';

const SRC = [['all', '실제 백업 전부(Veeam · Bareos)'], ['veeam', 'Veeam 만'], ['bareos', 'Bareos 만'], ['policy', '정책에 맞는 백업만']];
const KIND = { never: { text: '한 번도 없음', color: '#fca5a5' }, old: { text: '기준 넘음', color: '#fdba74' }, unknown: { text: '모름', color: 'var(--text-dim)' } };
const ACT = { ok: '#86efac', run: '#fbbf24', wait: '#fbbf24', bareos: '#fdba74', bareosWarn: '#fcd34d', bareosBad: '#fca5a5', bareosNone: 'var(--text-dim)', none: 'var(--text-dim)', unknown: 'var(--text-dim)' };
const OPEN_KEY = 'backup-summary.stale-open';
const loadOpen = () => { try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; } };
const PAD = { padding: '8px 8px' };   // 이 표만 좁은 여백(1440 카드 안쪽 폭 안 — Chromium 으로 확인)
const linkBtn = { background: 'none', border: 0, padding: 0, color: '#93c5fd', font: 'inherit', fontSize: 12, cursor: 'pointer', textAlign: 'left', textDecoration: 'underline', whiteSpace: 'nowrap' };

/** 실제 백업(마지막 결과) 칸 — Detail 과 같은 문구(veeamCell · bareosCell). */
function actualText(vm) {
  const out = [];
  if (vm?.a?.v === true) out.push(veeamCell(vm));
  if (vm?.b?.job === true || vm?.b?.job === false) out.push(bareosCell(vm));
  if (out.length) return out;
  if (vm?.a?.v === false && vm?.a?.b === false) return [{ text: '없음', tone: 'none' }];
  return [{ text: '모름', tone: 'unknown' }];
}

export default function BackupSummaryStale({ scope, rows, sel, onPick, onOpenDetail }) {
  const [o, setO] = useState(() => ({ vc: '', ...loadStaleOpts(undefined, SUMMARY_STALE_KEY) }));
  const [open, setOpen] = useState(loadOpen);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [all, setAll] = useState(false);   // 표 전부 보기(처음엔 50줄 — 정렬 뒤 자른다)
  const [csvErr, setCsvErr] = useState(null);
  const gen = useRef(0);
  useEffect(() => { const { vc: _vc, ...keep } = o; saveStaleOpts(keep, undefined, SUMMARY_STALE_KEY); }, [o]);   // 법인 선택은 기억하지 않는다(다음에 열면 전체)
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
  const csv = useCallback(async () => {
    const params = staleQuery(o, scope);
    if (!params) return;
    setCsvErr(null);
    try { await downloadFile(`/tools/backup-summary/stale.csv?${new URLSearchParams(params)}`); } catch (e) { setCsvErr(e); }
  }, [o, scope]);
  // 처음 펼칠 때 한 번 찾는다(조건은 기억한 값) · 범위 옵션(전원·제외)이 바뀌면 지난 결과는 버린다
  const scopeSig = `${scope?.power || ''}|${scope?.excl === false ? 0 : 1}`;
  const lastScope = useRef(scopeSig);
  useEffect(() => { if (lastScope.current !== scopeSig) { lastScope.current = scopeSig; gen.current++; setData(null); setLoading(false); } }, [scopeSig]);
  useEffect(() => { if (open && !data && !loading && !error) find(); }, [open, data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { gen.current++; }, []);

  const set = (patch) => setO((cur) => ({ ...cur, ...patch }));
  const bad = staleQuery(o, scope) == null;
  const fresh = data && staleQueryMatches(data, o);
  const at = data?.at || Date.now();
  const q = data?.q;
  const qUnit = (STALE_UNITS.find(([k]) => k === (q?.unit || o.unit)) || ['', '일'])[1];
  const sites = Array.isArray(rows) ? rows : [];
  const selIds = sel?.ids || new Set();
  const canRun = toolAllowed('backup-run'); const canBareos = toolAllowed('bareos-backup');
  const doAction = (x, a) => {
    if (a.key === 'veeam-run') { saveHandoff(x.vc, [x.vm.id]); window.location.hash = '#/tools/backup-run'; return; }
    if (a.key === 'bareos-target') { saveBareosHandoff(x.vc, [x.vm.id]); window.location.hash = '#/tools/bareos-backup/targets'; return; }
    if (a.key === 'live') { window.location.hash = '#/tools/bareos-backup/live'; return; }
    onOpenDetail?.(x.vc);
  };

  return (
    <section className="card" aria-label="백업 안 된 VM 찾기 — 전체 법인" data-backup-stale-all="" style={{ padding: 0, overflow: 'hidden', minWidth: 0, border: '1px solid rgba(239,68,68,.4)' }}>
      <div className="flex wrap" style={{ alignItems: 'center', gap: '6px 12px', padding: '10px 14px' }}>
        <b style={{ fontSize: 14 }}>백업 안 된 VM 찾기</b>
        <span className="muted" style={{ fontSize: 12, minWidth: 0, overflowWrap: 'anywhere' }}>지정한 시간 동안 성공한 백업(Veeam · Bareos)이 없는 VM — 실제 백업 결과 기준</span>
        <button type="button" className="tab" aria-expanded={open} onClick={() => setOpen((v) => !v)} style={{ marginLeft: 'auto', padding: '3px 12px', fontSize: 12 }}>{open ? '접기' : '조건 · 목록'}</button>
      </div>
      <div style={{ padding: '0 14px 10px', fontSize: 12.5, minWidth: 0, overflowWrap: 'anywhere' }}>
        {loading ? <span className="muted">찾는 중…</span>
          : error ? <span style={{ color: '#fca5a5' }}>{error?.status === 403 ? '이 계정은 Detail 화면이 허용되지 않아 VM 목록을 볼 수 없습니다.' : `찾지 못했습니다 — ${String(error?.message || error).slice(0, 160)}`}</span>
            : data ? <span data-stale-summary="">
              <b style={{ color: data.n ? '#fca5a5' : '#86efac' }}>{fmtNum(data.n)}대</b>가 최근 <b>{q?.n}{qUnit}</b> 동안 성공한 백업이 없습니다
              <span className="muted"> — 한 번도 없음 {fmtNum(data.never)} · 마지막 성공이 기준을 넘음 {fmtNum(data.old)} · 실패만 반복 {fmtNum(data.failing)} · 법인 {fmtNum(data.sites)}곳{q?.excludeNone ? ` (백업 안함 정책 ${fmtNum(data.excluded?.none)}대 제외` : ' ('}{q?.onlyOn ? ` · 꺼진 VM ${fmtNum(data.excluded?.off)}대 제외` : ''}{data.unknown ? ` · 결과를 못 읽은 ${fmtNum(data.unknown)}대는 ‘모름’ 으로 따로` : ''})</span>
            </span> : <span className="muted">펼치면 전 법인에서 찾습니다.</span>}
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
              <span className="muted">법인</span>
              <Select className="input" sort={false} value={o.vc || ''} onChange={(e) => set({ vc: e.target.value })} aria-label="법인" style={{ minWidth: 0, width: 'auto', maxWidth: 220 }}>
                <option value="">전체 {fmtNum(sites.length)}</option>
                {sites.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </Select>
            </label>
            <label className="flex" style={{ alignItems: 'center', gap: 6 }}>
              <span className="muted">기준</span>
              <Select className="input" sort={false} value={o.src} onChange={(e) => set({ src: e.target.value })} aria-label="찾기 기준" style={{ minWidth: 0, width: 'auto' }}>
                {SRC.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
                <option value="ssh" disabled>SSH 만(결과를 아직 읽지 못함)</option>
              </Select>
            </label>
            <label className="flex" style={{ alignItems: 'center', gap: 5 }}><input type="checkbox" checked={o.excludeNone} onChange={(e) => set({ excludeNone: e.target.checked })} /> 백업 안함 정책 제외</label>
            <label className="flex" style={{ alignItems: 'center', gap: 5 }}><input type="checkbox" checked={o.onlyOn} onChange={(e) => set({ onlyOn: e.target.checked })} /> 켜진 VM 만</label>
            <label className="flex" style={{ alignItems: 'center', gap: 5 }}><input type="checkbox" checked={o.includeNever} onChange={(e) => set({ includeNever: e.target.checked })} /> 한 번도 없음 포함</label>
            <span className="flex" style={{ marginLeft: 'auto', gap: 6 }}>
              <button type="button" className="tab active" disabled={bad || loading} onClick={find} style={{ padding: '3px 14px', fontSize: 12 }}>{loading ? '찾는 중…' : '찾기'}</button>
              {canCsv() && <button type="button" className="tab" disabled={bad} onClick={csv} title="지금 조건으로 찾은 VM 전부(서버 상한 없이) — CSV 권한이 있을 때만" style={{ padding: '3px 12px', fontSize: 12 }}>CSV</button>}
            </span>
          </div>
          {bad && <div className="muted" style={{ padding: '0 14px 10px', fontSize: 12.5 }}>기간을 1~999 로 적으세요.</div>}
          {csvErr && <div style={{ padding: '0 14px 10px', fontSize: 12.5, color: '#fca5a5' }}>CSV 를 받지 못했습니다 — {csvErr?.status === 403 ? 'CSV 권한이 없습니다.' : String(csvErr?.message || csvErr).slice(0, 160)}</div>}
          {data && !fresh && !loading && <div style={{ padding: '0 14px 10px', fontSize: 12.5, color: '#fcd34d' }}>조건이 바뀌었습니다 — 아래 목록은 지난 조건의 결과입니다. 찾기를 누르세요.</div>}
          {data && (data.rows?.length ? (
            <div style={{ overflowX: 'auto' }}>
              <STable minWidth={980} limit={all ? 0 : 50}>
                <thead><tr><th data-nosort style={{ ...PAD, width: 30 }}><span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>선택</span></th>{['법인', 'VM', '폴더', '백업 정책', '실제 백업(마지막 결과)', '마지막 성공', '경과', '이유'].map((h) => <th key={h} style={PAD}>{h}</th>)}<th data-nosort style={PAD}>조치</th></tr></thead>
                <tbody>
                  {data.rows.map((x) => {
                    const vm = x.vm || {}; const k = KIND[x.kind] || KIND.unknown; const pol = methodOf(vm.p);
                    const locked = !!(sel?.vc && sel.vc !== x.vc && selIds.size);
                    const picked = sel?.vc === x.vc && selIds.has(vm.id);
                    const act = staleAction(x, { canRun, canBareos });
                    return (
                      <tr key={`${x.vc}|${vm.id}`}>
                        <td style={PAD}><input type="checkbox" aria-label={`${vm.name} 선택`} checked={picked} disabled={locked} title={locked ? '다른 법인의 VM 이 골라져 있습니다 — 위 도구 줄에서 선택 해제 뒤 고르세요(선택은 한 법인 안에서만)' : undefined} onChange={() => onPick?.(x.vc, [vm.id], !picked)} /></td>
                        <td data-sort={x.vcName} style={PAD}><button type="button" onClick={() => onOpenDetail?.(x.vc)} title={`${x.vcName} Detail 로`} style={{ display: 'block', maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', background: 'none', border: 0, padding: 0, color: 'var(--text)', font: 'inherit', fontWeight: 700, cursor: 'pointer', textAlign: 'left' }}>{x.vcName}</button></td>
                        <td data-sort={vm.name} style={{ ...PAD, whiteSpace: 'nowrap', maxWidth: 230, overflow: 'hidden', textOverflow: 'ellipsis' }} title={vm.name}>
                          <b>{vm.name}</b>
                          {(vm.os === 'windows' || vm.os === 'linux') && <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 700, padding: '0 6px', borderRadius: 999, color: vm.os === 'windows' ? '#93c5fd' : '#5eead4', background: vm.os === 'windows' ? 'rgba(59,130,246,.18)' : 'rgba(20,184,166,.18)' }}>{vm.os === 'windows' ? 'Windows' : 'Linux'}</span>}
                        </td>
                        <td className="muted" style={{ ...PAD, fontSize: 12 }}><div style={{ minWidth: 90, maxWidth: 130, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{folderTail(vm.folder)}</div></td>
                        <td data-sort={vm.p || ''} style={PAD}>{pol ? <span style={{ color: pol.color, fontWeight: 700, fontSize: 12, padding: '0 7px', border: `1px solid ${pol.color}`, borderRadius: 999, whiteSpace: 'nowrap' }}>{pol.text}</span> : <span className="muted">모름</span>}</td>
                        <td style={{ ...PAD, fontSize: 12 }}><div style={{ width: 130, whiteSpace: 'normal' }}>{actualText(vm).map((c, i) => <div key={i} style={{ color: ACT[c.tone] || 'var(--text)', fontWeight: 600 }}>{c.text}</div>)}</div></td>
                        <td data-sort={x.last ?? ''} style={{ ...PAD, fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{lastOkText(vm)}</td>
                        <td data-sort={x.last == null ? '' : at - x.last} title={k.text} style={{ ...PAD, whiteSpace: 'nowrap', fontWeight: 700, color: k.color }}>{x.last == null ? k.text : agoText(at - x.last)}</td>
                        <td style={{ ...PAD, fontSize: 12 }}><div style={{ width: 160, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{staleReason(x, at)}</div></td>
                        <td style={PAD}><button type="button" onClick={() => doAction(x, act)} style={linkBtn}>{act.text}</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </STable>
            </div>
          ) : <div className="muted" style={{ padding: '4px 14px 14px', fontSize: 13 }}>조건에 맞는 VM 이 없습니다.</div>)}
          {data?.rows?.length > 50 && (
            <div className="flex" style={{ padding: '6px 14px', fontSize: 12, alignItems: 'center', gap: 8 }}>
              <span className="muted">{fmtNum(data.rows.length)}대 중 {fmtNum(all ? data.rows.length : 50)}대 · 열 제목으로 정렬 · 체크한 VM 은 위 도구 줄의 백업 정책 · 백업 등록으로 넘깁니다</span>
              <button type="button" className="tab" onClick={() => setAll((v) => !v)} style={{ marginLeft: 'auto', padding: '3px 12px', fontSize: 12 }}>{all ? '50대만 보기' : '전부 보기'}</button>
            </div>
          )}
          <div className="muted" style={{ padding: '8px 14px', fontSize: 11.5, borderTop: '1px solid var(--border-soft)', lineHeight: 1.6 }}>
            {data?.truncated ? `목록은 서버가 앞 ${fmtNum(data.rows.length)}대만 보냈습니다(전체 ${fmtNum(data.total)}대 — 수는 전부 셉니다 · CSV 는 전부) · ` : ''}
            ‘마지막 성공’ = Veeam 백업 완료 · Bareos 성공(T·W) 중 가장 늦은 것 — 지금 도는 실행은 성공으로 치지 않습니다 · 결과를 못 읽은 VM 은 ‘모름’ 으로 따로 세고 미달로 단정하지 않습니다 ·
            ‘정책에 맞는 백업만’ = 정책 Veeam 이면 Veeam 결과만, Bareos 면 Bareos 결과만 봅니다 · SSH 정책 VM 은 포탈이 결과를 아직 읽지 못해 Veeam · Bareos 결과로만 봅니다 · 조건은 이 브라우저에 기억합니다(법인 선택은 빼고).
          </div>
        </div>
      )}
    </section>
  );
}
