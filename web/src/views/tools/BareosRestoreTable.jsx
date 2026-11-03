/**
 * Bareos 운영 › 복원 › 폴더 표(v2.866 — 시안 캔버스 ① 일반 복원). vCenter › 폴더 › VM 트리 표에서 복원할 VM 을 고른다.
 *   고르기 판정 · 다음 단계(복원 지점 → 위치 · 이름 · 네트워크 → 확인 · OTP)는 지금 복원 화면과 같다(BareosRestore 가 넘겨 준다).
 *   폴더 VM 수는 표를 열 때 한 번 읽는다(GET restore-folders — 폴링 없음 · 다시 읽기 단추). 못 읽어도 대상 행은 그린다('—').
 *   VM 마다 복원 지점은 이 표에서 읽지 않는다 — Director 를 VM 수만큼 부르지 않게, '다음' 에서 고른 VM 만 한 번에 읽는다.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Note } from './BareosBits.jsx';
import { snapshotChip, SNAPSHOT_TITLE, RESTORE_MAX } from './bareosRestoreText.js';
import { restoreFolderRows, targetsText, targetsPct, sizeText, powerText, lastRunText, lastOkText, restoreStateText, pickedSize } from './bareosRestoreTree.js';

const BASE = '/tools/bareos-backup';
const COLS = '40px minmax(240px,2.4fr) 64px 84px minmax(150px,1.2fr) 128px minmax(150px,1.2fr)';
const TONE = { ok: '#86efac', warn: '#fcd34d', bad: '#fca5a5', info: '#93c5fd', muted: 'var(--text-dim)', '': 'var(--text)' };
const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' };

export function FolderBox({ ids, picked, toggle, label }) {
  const ref = useRef(null);
  const on = ids.filter((id) => picked.includes(id)).length;
  const all = ids.length > 0 && on === ids.length;
  useEffect(() => { if (ref.current) ref.current.indeterminate = on > 0 && !all; }, [on, all]);
  // v2.872(점검 B5-08): 일부만 고른 상태(─)에서 누르면 뺀다 — '더하기' 였을 때 상한(50대)에 걸린 폴더는 아무것도 못 해 풀 수 없었다
  return <input ref={ref} type="checkbox" checked={all} disabled={!ids.length} onChange={() => toggle(ids, on === 0)} title={on > 0 && !all ? '일부만 골랐습니다 — 누르면 이 폴더의 VM 을 뺍니다' : undefined} aria-label={`${label} 안의 복원 가능한 VM 모두`} />;
}

export default function BareosRestoreTable({ jobs, directors = [], picked, toggle, lockedDir, onNext, onClear }) {
  const [q, setQ] = useState('');
  const [onlyTargets, setOnlyTargets] = useState(true);
  const [open, setOpen] = useState(null);   // null = 대상이 있는 행을 모두 펼친 처음 모습
  const [fd, setFd] = useState(null);
  const [fdErr, setFdErr] = useState(null);
  const gen = useRef(0);
  const loadFolders = () => {
    const g = ++gen.current;
    setFdErr(null);
    fetchJson(`${BASE}/restore-folders`).then((r) => { if (g === gen.current) setFd(r); }).catch((e) => { if (g === gen.current) setFdErr(e); });
  };
  useEffect(() => { loadFolders(); }, []);   // 표를 열 때 한 번(폴링 없음)

  const dirNames = useMemo(() => Object.fromEntries(directors.map((x) => [x.id, x.name || x.id])), [directors]);
  const rows = useMemo(() => restoreFolderRows(jobs, fd ? fd.folders : null, { q, open, onlyTargets, lockedDir, vcNames: fd?.vcNames || {}, dirNames }), [jobs, fd, q, open, onlyTargets, lockedDir, dirNames]);
  const openKeys = () => new Set(rows.filter((r) => r.isOpen).map((r) => r.key));
  const flip = (key) => setOpen(() => { const s = openKeys(); if (s.has(key)) s.delete(key); else s.add(key); return s; });
  const pickedJobs = picked.map((id) => jobs.find((j) => j.id === id)).filter(Boolean);

  return (
    <div data-bareos-restore-table="" style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div style={ROW}>
        <input className="input" style={{ flex: '1 1 220px', minWidth: 0, maxWidth: 340 }} placeholder="VM · 폴더 이름" value={q} onChange={(e) => setQ(e.target.value)} aria-label="VM · 폴더 이름 찾기" />
        <label className="muted" style={{ ...ROW, gap: 6, fontSize: 12 }}><input type="checkbox" checked={onlyTargets} onChange={(e) => setOnlyTargets(e.target.checked)} />백업 대상이 있는 폴더만</label>
        <span style={{ flex: '1 1 auto' }} />
        <button type="button" className="tab" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setOpen(new Set(rows.filter((r) => r.kind !== 'vm' && r.hasKids).map((r) => r.key)))}>모두 펼치기</button>
        <button type="button" className="tab" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setOpen(new Set())}>모두 접기</button>
        <button type="button" className="tab" style={{ padding: '4px 10px', fontSize: 12 }} onClick={loadFolders}>폴더 수 다시 읽기</button>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>한 번에 한 법인 · {RESTORE_MAX}대까지(지금 복원과 같은 규칙) · 폴더를 고르면 그 아래 <b style={{ color: '#86efac' }}>고를 수 있는 VM</b> 만 고릅니다 · VM 행은 Bareos 백업 대상만 보입니다.</div>
      {fdErr && <Note tone="warn">폴더별 VM 수를 읽지 못했습니다 — 대상 / 전체 칸의 전체를 ‘—’ 로 둡니다(고르기는 그대로 됩니다).</Note>}

      <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', minWidth: 0 }}>
        <div style={{ overflowX: 'auto', maxHeight: '62vh', overflowY: 'auto' }}>
          <div role="table" aria-label="복원할 VM — 폴더 표" style={{ minWidth: 1040 }}>
            <div role="row" style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', minHeight: 38, position: 'sticky', top: 0, zIndex: 1, background: 'var(--panel-deep)', borderBottom: '1px solid var(--border)', fontSize: 12, fontWeight: 700, color: 'var(--text-dim)' }}>
              <span role="columnheader" aria-label="선택" />
              <span role="columnheader" style={{ padding: '0 8px' }}>vCenter › 폴더 › VM</span>
              <span role="columnheader" style={{ padding: '0 8px' }}>전원</span>
              <span role="columnheader" style={{ padding: '0 8px', textAlign: 'right' }}>용량</span>
              <span role="columnheader" style={{ padding: '0 8px' }}>Bareos 백업</span>
              <span role="columnheader" style={{ padding: '0 8px' }}>마지막 성공</span>
              <span role="columnheader" style={{ padding: '0 8px' }}>복원 상태</span>
            </div>
            {!rows.length && <div className="muted" style={{ padding: 16, fontSize: 12.5 }}>{jobs.length ? '찾는 VM 이 없습니다.' : '백업 대상이 없습니다 — 백업 대상에서 먼저 등록하세요.'}</div>}
            {rows.map((r) => {
              const pad = 8 + r.depth * 18;
              if (r.kind === 'vm') {
                const j = r.job;
                const on = picked.includes(j.id);
                const lr = lastRunText(j);
                const lo = lastOkText(j);
                const rs = restoreStateText(j);
                const snap = snapshotChip(j.snapshotCount);
                const off = !!r.why && !on;
                return (
                  <div key={r.key} role="row" style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', minHeight: 40, borderBottom: '1px solid var(--border-soft)', background: on ? 'rgba(59,130,246,.08)' : undefined, opacity: off ? 0.55 : 1, fontSize: 12.5 }}>
                    <span role="cell" style={{ paddingLeft: Math.min(pad, 60) }}><input type="checkbox" checked={on} disabled={off || (!on && picked.length >= RESTORE_MAX)} onChange={(e) => toggle([j.id], e.target.checked)} aria-label={`${j.vmName} 고르기`} /></span>
                    <span role="cell" title={r.why || undefined} style={{ paddingLeft: pad, paddingRight: 8, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{j.vmName}</b>
                      {snap && <span className="badge amber" style={{ fontSize: 10.5 }} title={SNAPSHOT_TITLE}>{snap}</span>}
                      {r.why && <span className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{r.why}</span>}
                    </span>
                    <span role="cell" style={{ padding: '0 8px' }}>{powerText(j.powerState)}</span>
                    <span role="cell" style={{ padding: '0 8px', textAlign: 'right' }}>{sizeText(j.storageGB)}</span>
                    <span role="cell" style={{ padding: '0 8px', color: TONE[lr.tone] }}>{lr.text}</span>
                    <span role="cell" title={lo.title || undefined} style={{ padding: '0 8px', color: TONE[lo.tone] }}>{lo.text}</span>
                    <span role="cell" style={{ padding: '0 8px', color: TONE[rs.tone] }}>{rs.text}</span>
                  </div>
                );
              }
              const pct = targetsPct(r);
              return (
                <div key={r.key} role="row" style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', minHeight: r.kind === 'vc' ? 44 : 40, borderBottom: '1px solid var(--border-soft)', background: r.kind === 'vc' ? 'var(--panel-deep)' : 'rgba(255,255,255,.015)', fontSize: 12.5 }}>
                  <span role="cell" style={{ paddingLeft: Math.min(pad, 60) }}><FolderBox ids={r.ids} picked={picked} toggle={toggle} label={r.label} /></span>
                  <span role="cell" style={{ paddingLeft: pad, paddingRight: 8, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    {r.hasKids
                      ? <button type="button" onClick={() => flip(r.key)} aria-expanded={r.isOpen} aria-label={`${r.label} ${r.isOpen ? '접기' : '펼치기'}`} style={{ background: 'none', border: 0, color: 'var(--text)', cursor: 'pointer', padding: 0, width: 22, minHeight: 28, fontSize: 13, lineHeight: 1 }}>{r.isOpen ? '▼' : '▶'}</button>
                      : <span style={{ width: 18 }} />}
                    <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, fontSize: r.kind === 'vc' ? 13.5 : 12.5 }}>{r.label}</b>
                    {r.kind === 'vc' && <span className="muted" style={{ fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{[r.dc, r.director].filter(Boolean).join(' · ')}</span>}
                  </span>
                  <span role="cell" />
                  <span role="cell" style={{ padding: '0 8px', textAlign: 'right' }} title={r.sizeUnknown ? `용량을 모르는 대상 ${r.sizeUnknown}대는 합에 없습니다` : undefined}>{sizeText(r.sizeGB, r.sizeUnknown)}</span>
                  <span role="cell" style={{ padding: '0 8px', display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span style={{ whiteSpace: 'nowrap', color: r.targets ? '#86efac' : 'var(--text-dim)' }} title="Bareos 백업 대상 / 폴더 VM(인벤토리 · 템플릿 제외)">{targetsText(r)}</span>
                    {pct !== null && <span aria-hidden="true" style={{ flex: '1 1 auto', minWidth: 30, height: 6, borderRadius: 999, background: 'var(--border)', overflow: 'hidden' }}><span style={{ display: 'block', width: `${pct}%`, height: '100%', background: '#86efac' }} /></span>}
                    <span className="muted" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>고를 수 있음 {r.ids.length}</span>
                  </span>
                  <span role="cell" style={{ padding: '0 8px' }}>{r.lastOk ? lastOkText({ lastOk: { at: r.lastOk } }).text : '—'}</span>
                  <span role="cell" style={{ padding: '0 8px', color: r.openRestores ? '#93c5fd' : 'var(--text-dim)' }}>{r.openRestores ? `복원 진행 ${r.openRestores}` : ''}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* v2.867(Chromium 판독): 포탈 하단 상태바(fixed)에 '다음' 버튼이 가렸다 — 상태바 위에 붙인다(styles.css .pickbar-sticky) */}
      <div data-bareos-restore-pickbar="" className="pickbar-sticky" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', padding: '10px 14px', borderRadius: 12, border: '1px solid #3b82f6', background: 'var(--panel-deep)', boxShadow: '0 8px 24px rgba(0,0,0,.35)' }}>
        <b style={{ fontSize: 13.5 }}>선택 {picked.length}대</b>
        <span className="muted" style={{ fontSize: 12, minWidth: 0, overflowWrap: 'anywhere' }}>
          {picked.length ? `${dirNames[lockedDir] || lockedDir || '—'} · 용량 ${pickedSize(pickedJobs)} · 다음 단계에서 방식(새 VM · 덮어쓰기)과 위치를 고릅니다` : 'VM 이나 폴더를 고르세요'}
        </span>
        <span style={{ flex: '1 1 auto' }} />
        <button type="button" className="logout-btn" style={{ padding: '6px 12px' }} disabled={!picked.length} onClick={onClear}>모두 빼기</button>
        <button type="button" className="login-btn" style={{ flex: 'none', padding: '7px 16px' }} disabled={!picked.length} onClick={onNext}>다음: 복원 지점 읽기 →</button>
      </div>
    </div>
  );
}
