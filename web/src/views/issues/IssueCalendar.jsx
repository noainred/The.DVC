/**
 * IssueCalendar — 이슈 › 캘린더(v2.886 · 시안 ⑩ '주간 캘린더' · C-5). 기한이 있는 이슈를 달력 칸에 · 스프린트 시작 · 끝 표지.
 *  · 데이터는 보드 · 목록과 같은 목록(열린 이슈 + 최근 완료 — 화면 걸러보기 그대로). 기한 없는 이슈는 수만 밝힌다.
 *  · 쓰기 범위 안의 이슈는 다른 날로 끌어 기한을 바꾼다(PUT /issues/:key — 서버가 범위 · 권한을 다시 본다 · 이력에 남는다).
 *  · 날짜 기준은 기한 입력과 같다(브라우저 날짜 — toDateInput/fromDateInput).
 */
import React, { useMemo, useState } from 'react';
import { putJson } from '../../api.js';
import { TypeTag, PrioTag } from './issueParts.jsx';
import { monthGrid, issuesByDay, sprintMarks, shiftMonth, fromDateInput, toDateInput, saveFailText, STATUS_TEXT } from './issueText.js';

const DOW = ['월', '화', '수', '목', '금', '토', '일'];

export default function IssueCalendar({ rows, meta, onOpen, onWritten, canWrite }) {
  const today = toDateInput(Date.now());
  const [ym, setYm] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() + 1 }; });
  const [drag, setDrag] = useState('');
  const [over, setOver] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const grid = useMemo(() => monthGrid(ym.y, ym.m), [ym]);
  const { byDay, none } = useMemo(() => issuesByDay(rows), [rows]);
  const move = async (key, day) => {
    const r0 = rows.find((x) => x.key === key);
    if (!r0 || toDateInput(r0.dueAt) === day) return;
    setBusy(true); setMsg('');
    try {
      const r = await putJson(`/issues/${key}`, { dueAt: fromDateInput(day) });
      if (r?.ok === false) setMsg(`${key}: ${saveFailText(r)}`); else { setMsg(`${key} 기한을 ${day} 로 옮겼습니다.`); onWritten?.(r); }
    } catch (e) { setMsg(`${key}: ${saveFailText({ reason: e.message })}`); } finally { setBusy(false); }
  };
  return (
    <div className="iss-cal">
      <div className="iss-cal-head">
        <button type="button" className="btn" onClick={() => setYm((v) => shiftMonth(v, -1))} aria-label="이전 달">‹</button>
        <b className="iss-cal-title">{ym.y}년 {ym.m}월</b>
        <button type="button" className="btn" onClick={() => setYm((v) => shiftMonth(v, 1))} aria-label="다음 달">›</button>
        <button type="button" className="btn" onClick={() => { const d = new Date(); setYm({ y: d.getFullYear(), m: d.getMonth() + 1 }); }}>이번 달</button>
        <span className="muted iss-small">기한 없는 이슈 {none}건은 달력에 없습니다{canWrite ? ' · 이슈를 다른 날로 끌면 기한이 바뀝니다(쓰기 범위 안)' : ''}</span>
      </div>
      {msg && <div className="banner">{msg}</div>}
      <div className="muted iss-small iss-cal-narrow-note">좁은 화면에서는 이슈 · 스프린트가 있는 날만 보입니다.</div>
      <div className="iss-cal-grid" role="grid" aria-label={`${ym.y}년 ${ym.m}월 이슈 기한`}>
        {DOW.map((d) => <div key={d} className="iss-cal-dow" role="columnheader">{d}</div>)}
        {grid.flat().map((c, ci) => {
          const list = byDay.get(c.day) || [];
          const marks = sprintMarks(meta.sprintList, c.day);
          const empty = !list.length && !marks.length;
          return (
            <div key={c.day} role="gridcell" className={`iss-cal-cell${c.inMonth ? '' : ' out'}${c.day === today ? ' today' : ''}${over === c.day ? ' drop' : ''}${empty ? ' empty' : ''}`}
              onDragOver={canWrite && drag ? (e) => { e.preventDefault(); if (over !== c.day) setOver(c.day); } : undefined}
              onDragLeave={canWrite ? (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(''); } : undefined}
              onDrop={canWrite ? (e) => { e.preventDefault(); setOver(''); const k = e.dataTransfer.getData('text/plain') || drag; setDrag(''); if (k) move(k, c.day); } : undefined}>
              <div className="iss-cal-day">{Number(c.day.slice(8))}<span className="iss-cal-dow-inline"> ({DOW[ci % 7]})</span>{c.day === today && <span className="iss-cal-dow-inline muted"> 오늘</span>}{list.length > 0 && <span className="muted"> · {list.length}</span>}</div>
              {marks.map((m, i) => <div key={i} className={`iss-cal-sprint ${m.kind}`} title={`스프린트 ${m.name} ${m.kind === 'start' ? '시작' : '끝'}`}>{m.kind === 'start' ? '▶' : '■'} {m.name}</div>)}
              {list.slice(0, 4).map((r) => (
                <button key={r.key} type="button" className={`iss-cal-item${r.status === 'done' ? ' done' : ''}`} title={`${r.key} ${r.title} · ${STATUS_TEXT[r.status] || r.status}`}
                  draggable={canWrite && r.writable !== false && !busy} onDragStart={(e) => { e.dataTransfer.setData('text/plain', r.key); setDrag(r.key); }} onDragEnd={() => { setDrag(''); setOver(''); }}
                  onClick={() => onOpen(r.key)}>
                  <PrioTag p={r.priority} /><TypeTag t={r.type} /> <span className="iss-cal-t">{r.title}</span>
                </button>
              ))}
              {list.length > 4 && <div className="muted iss-small">외 {list.length - 4}건</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
