// components/ExportPreviewModal.jsx — 내보내기 미리보기 '크게 보기'(전체 화면 팝업, v2.801 — 승인 시안 ⑤ https://claude.ai/artifact/5PT9nUWUwMPTxwURq3xm1h).
// 사용자 요청(2026-10-27): "지금 미리보기 화면이 작은데, 미리보기를 전체화면으로 팝업해서 크게 볼 수 있게".
// VM 전체 정보 내보내기(views/tools/VmExport.jsx)와 VM 목록 내보내기 창(views/VmListExportDialog.jsx)이 같이 쓴다.
//  · 열 때 한 번 받는다(load — 서버가 같은 표 함수로 대상 첫 100대를 만든다). 15초 폴링 없음 · 닫으면 늦게 온 응답은 버린다.
//  · 묶음 띠 · 머리 · VM 이름 열 고정 · 칸 색은 엑셀과 같은 규칙(exportPreviewText.cellTone — 서버 vmXlsxStyle 과 대조 테스트).
//  · '폴더별로 나눠 보기'(폴더 이름 줄 + 그 폴더 VM) — 켜면 표 제목 정렬은 끈다(폴더 줄이 섞이지 않게 · 끄면 STable 정렬).
//  · Esc · 바깥 · 닫기로 닫는다(EscClose — 열린 창 위에 겹쳐도 맨 위만 닫힌다). body 로 portal(창 안에서 열려도 갇히지 않게).
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import EscClose from './EscClose.jsx';
import { STable } from './STable.jsx';
import { ErrorBox } from './primitives.jsx';
import { cellTone, cellText, folderGroups, matchRows, bandsOf, folderLine } from '../views/tools/exportPreviewText.js';

const TONE_STYLE = Object.freeze({
  missing: { color: '#5b6b85', fontStyle: 'italic' },
  on: { color: '#4ade80', fontWeight: 600 }, off: { color: 'var(--text-dim)' }, warn: { color: '#fbbf24', fontWeight: 600 },
  yes: { color: '#4ade80', fontWeight: 600 }, no: { color: '#fca5a5', fontWeight: 600 },
  hot: { color: '#fca5a5', fontWeight: 600, background: 'rgba(239,68,68,.18)' }, warm: { color: '#fcd34d', fontWeight: 600, background: 'rgba(245,158,11,.16)' },
  'v-veeam': { color: '#86efac', fontWeight: 600 }, 'v-snap': { color: '#7dd3fc', fontWeight: 600 }, 'v-none': { color: '#fcd34d', fontWeight: 600 }, 'v-unknown': { color: 'var(--text-dim)' },
  // v2.807 백업 방식 — Detail 배지(backupViewText METHODS)와 같은 색
  'm-veeam': { color: '#86efac', fontWeight: 600 }, 'm-clone': { color: '#67e8f9', fontWeight: 600 }, 'm-config': { color: '#a78bfa', fontWeight: 600 }, 'm-none': { color: '#94a3b8', fontWeight: 600 },
  name: { fontWeight: 700 },
});
const BAND = ['#1e3355', '#123047', '#2a2150', '#123826', '#3a2c10', '#3a1f10', '#23285a', '#3a1720', '#3a1530', '#183a2a'];
const BAND_FG = ['#bcd3f5', '#93d5f5', '#c4b5fd', '#86efac', '#fcd34d', '#fdba74', '#a5b4fc', '#fca5a5', '#f9a8d4', '#86efac'];

/**
 * @param {{ title:string, sub?:string, load:()=>Promise<{head:string[], cells:any[][], keys?:string[], cols?:Array<{key,group}>, folders?:string[], rows?:number}>,
 *           groupName?:(g:string)=>string, onDownload?:()=>void, downloadLabel?:string, downloadDisabled?:boolean, onClose:()=>void }} p
 */
export default function ExportPreviewModal({ title, sub = '', load, groupName, onDownload, downloadLabel = '⤓ 내려받기', downloadDisabled = false, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [byFolder, setByFolder] = useState(true);
  const [q, setQ] = useState('');
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(load)
      .then((r) => { if (!alive) return; if (r?.ok === false) setErr(new Error(r.reason || '미리보기를 받지 못했습니다.')); else setData(r); })
      .catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const keys = useMemo(() => (data?.keys || (data?.cols || []).map((c) => c.key) || []), [data]);
  const bands = useMemo(() => (data?.cols ? bandsOf(data.cols, groupName) : []), [data, groupName]);
  const nameIdx = keys.indexOf('name');
  const hits = useMemo(() => matchRows(data?.cells || [], q), [data, q]);
  const hasFolders = Array.isArray(data?.folders) && data.folders.length === (data?.cells || []).length;
  const groups = useMemo(() => {
    if (!data || !hasFolders || !byFolder) return null;
    const keep = new Set(hits);
    return folderGroups(data.folders, data.cells.length).map((g) => ({ ...g, rows: g.rows.filter((i) => keep.has(i)) })).filter((g) => g.rows.length);
  }, [data, hasFolders, byFolder, hits]);

  const head = data?.head || [];
  const cellTd = (row, ri) => row.map((v, ci) => (
    <td key={ci} data-sort={typeof v === 'number' ? v : undefined} title={cellText(v)}
      style={{ padding: '6px 10px', whiteSpace: 'nowrap', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', textAlign: typeof v === 'number' ? 'right' : 'left',
        fontVariantNumeric: typeof v === 'number' ? 'tabular-nums' : undefined, ...(TONE_STYLE[cellTone(v, keys[ci])] || {}),
        ...(ci === nameIdx ? { position: 'sticky', left: 0, zIndex: 1, background: ri % 2 ? '#111a2c' : 'var(--panel-deep)', borderRight: '1px solid var(--border)' } : {}) }}>
      {cellText(v)}
    </td>
  ));
  const rowTr = (i, z) => <tr key={i} style={{ background: z % 2 ? '#111a2c' : 'transparent', borderTop: '1px solid #1a2438' }}>{cellTd(data.cells[i], z)}</tr>;

  // body 로 옮겨 그린다 — VM 목록 내보내기 창(Modal) 안에서 열려도 그 창의 overflow·쌓임 순서에 갇히지 않게.
  return createPortal((
    <div className="modal-overlay" style={{ zIndex: 260, padding: 16, placeItems: 'stretch' }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} data-export-preview="">
      <EscClose onClose={onClose} />
      <div role="dialog" aria-modal="true" aria-label={title} className="card"
        style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, width: '100%', height: '100%', padding: 0, overflow: 'hidden', background: 'var(--panel-deep)' }}>
        {/* 머리 — 제목(+한 줄 설명, 넘치면 말줄임)·닫기 / 도구(폴더별 · 찾기 · 내려받기). 400px 에서 네 줄로 접혀 표가 11행만 보이던 것을 두 줄로(Chromium 점검 지적).
            남는 폭은 제목 쪽이 갖는다(grow 999) — 도구 쪽이 가지면 넓은 화면에서도 제목이 260px 에서 잘렸다(재점검 지적). */}
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: '8px 12px', padding: '10px 16px', borderBottom: '1px solid var(--border-soft)', background: 'var(--panel)' }}>
          <div style={{ flex: '999 1 300px', minWidth: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: '1 1 auto', minWidth: 0 }}>
              <b style={{ fontSize: 15, display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={title}>{title}</b>
              {sub && <div className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={sub}>{sub}</div>}
            </div>
            <button type="button" className="logout-btn" style={{ flex: 'none' }} onClick={onClose} title="Esc 또는 바깥을 눌러도 닫힙니다">닫기</button>
          </div>
          <div className="flex gap" style={{ flex: '1 1 auto', minWidth: 0, alignItems: 'center', gap: 10, justifyContent: 'flex-end' }}>
            {hasFolders && (
              <label className="flex gap" style={{ flex: 'none', alignItems: 'center', gap: 6, minHeight: 32, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                <input type="checkbox" checked={byFolder} onChange={() => setByFolder((x) => !x)} />폴더별
              </label>
            )}
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="찾기 — 이름 · IP" aria-label="미리보기에서 찾기" style={{ flex: '1 1 120px', width: 'auto', minWidth: 0, maxWidth: 240 }} />
            {onDownload && <button type="button" className="login-btn" style={{ flex: 'none', whiteSpace: 'nowrap' }} disabled={downloadDisabled} onClick={onDownload}>{downloadLabel}</button>}
          </div>
        </div>
        <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
          {err ? <div style={{ padding: 16 }}><ErrorBox error={err} /></div>
            : !data ? <div className="muted" style={{ padding: 16 }}>미리보기를 만드는 중…</div>
              : !data.cells?.length ? <div className="muted" style={{ padding: 16 }}>대상에 VM 이 없습니다.</div> : (
                <STable sortable={!groups} wrap={false} style={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: 12.5, minWidth: Math.max(600, head.length * 120), width: '100%' }}>
                  <thead>
                    {bands.length > 0 && (
                      <tr>{bands.map((b, i) => (
                        <th key={i} colSpan={b.span} data-nosort="" style={{ position: 'sticky', top: 0, zIndex: 3, padding: '5px 10px', textAlign: 'left', fontSize: 11.5, background: BAND[i % BAND.length], color: BAND_FG[i % BAND_FG.length], whiteSpace: 'nowrap' }}>{b.name}</th>
                      ))}</tr>
                    )}
                    <tr>{head.map((h, i) => (
                      <th key={i} style={{ position: 'sticky', top: bands.length ? 27 : 0, zIndex: i === nameIdx ? 4 : 2, ...(i === nameIdx ? { left: 0 } : {}), padding: '7px 10px', textAlign: 'left', whiteSpace: 'nowrap', background: '#1b2a45', borderBottom: '1px solid var(--border)' }}>{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {groups ? groups.flatMap((g) => [
                      // 폴더 이름은 칸 안에서 왼쪽에 붙여 둔다(sticky) — 열이 많아 가로로 밀면 이름이 화면 밖으로 나가 빈 띠만 남았다(Chromium 점검 지적).
                      <tr key={`f:${g.folder}`}><td colSpan={head.length} style={{ padding: '6px 0', background: '#16223a', color: '#c7d2e3', fontWeight: 600, borderTop: '1px solid var(--border)' }}>
                        <span style={{ position: 'sticky', left: 0, display: 'inline-block', padding: '0 10px', whiteSpace: 'nowrap' }}>▾ {folderLine(g.folder, g.rows.length)}</span>
                      </td></tr>,
                      ...g.rows.map((i, z) => rowTr(i, z)),
                    ]) : hits.map((i, z) => rowTr(i, z))}
                  </tbody>
                </STable>
              )}
        </div>
        <div className="muted" style={{ padding: '6px 16px', borderTop: '1px solid var(--border-soft)', background: 'var(--panel)', fontSize: 11.5, lineHeight: 1.5 }}>
          {data && <span>{q ? `찾은 행 ${hits.length.toLocaleString()} / ${data.cells.length.toLocaleString()}` : `${data.cells.length.toLocaleString()}행`}{typeof data.rows === 'number' && data.rows > data.cells.length ? ` · 대상 ${data.rows.toLocaleString()}대 중 앞부분(전체는 파일에)` : ''} · </span>}
          <span>{groups ? '폴더별을 끄면 제목으로 정렬' : '제목을 눌러 정렬'} · 칸 색은 엑셀과 같음 · Esc 로 닫기</span>
        </div>
      </div>
    </div>
  ), document.body);
}
