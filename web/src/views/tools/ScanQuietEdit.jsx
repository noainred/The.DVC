// ScanQuietEdit.jsx — 스캔 설정의 '스캔 속도' · '쉬는 시간' 칸(v3.7.0 재설계 묶음 라 — 시안 ⑭).
// 속도는 기존 동시 IP 수 · 응답 대기 값을 채우는 단추일 뿐이다(저장 값은 그 두 칸). 쉬는 시간은 그 에이전트 현지 시각 — 판정은 스캔하는 쪽(서버 scanQuiet.js).
import React from 'react';
import { DAY_LABELS, SPEED_PRESETS, quietRowIssue, speedOf } from './scanScheduleText.js';

export function ScanSpeed({ s, onChange }) {
  const cur = speedOf(s);
  return (
    <div className="flex gap wrap" style={{ alignItems: 'center' }} role="group" aria-label="스캔 속도">
      {SPEED_PRESETS.map((p) => (
        <button key={p.k} type="button" className={`tab${cur === p.k ? ' active' : ''}`} aria-pressed={cur === p.k} style={{ flex: 'none', padding: '4px 11px', fontSize: 12 }}
          title={`동시 ${p.concurrency}개 · 응답 대기 ${p.timeoutMs}ms — ${p.note}`} onClick={() => onChange({ concurrency: p.concurrency, timeoutMs: p.timeoutMs })}>{p.label}</button>
      ))}
      <span className="muted" style={{ fontSize: 12 }}>{cur === 'custom' ? '직접 넣은 값' : `동시 ${s.concurrency}개 · 응답 대기 ${s.timeoutMs}ms`} — 아래 칸에서 바꿀 수 있습니다.</span>
    </div>
  );
}

export function ScanQuietEdit({ quiet, onChange }) {
  const rows = Array.isArray(quiet) ? quiet : [];
  const set = (i, patch) => onChange(rows.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const toggleDay = (i, d) => {
    const cur = Array.isArray(rows[i].days) && rows[i].days.length ? rows[i].days : [0, 1, 2, 3, 4, 5, 6];
    const next = cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort();
    set(i, { days: next.length === 7 ? undefined : next });
  };
  return (
    <div className="card" style={{ padding: '10px 12px', minWidth: 0 }}>
      {rows.length === 0 && <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>쉬는 시간이 없습니다 — 주기마다 언제든 스캔합니다.</div>}
      {rows.map((q, i) => {
        const issue = quietRowIssue(q);
        const days = Array.isArray(q.days) && q.days.length ? q.days : [0, 1, 2, 3, 4, 5, 6];
        return (
          <div key={i} className="ipam-quiet-row">
            <input className="input" type="time" aria-label={`쉬는 시간 ${i + 1} 시작`} value={q.from || ''} onChange={(e) => set(i, { from: e.target.value })} style={{ width: 135 }} />
            <span className="muted">~</span>
            <input className="input" type="time" aria-label={`쉬는 시간 ${i + 1} 끝`} value={q.to || ''} onChange={(e) => set(i, { to: e.target.value })} style={{ width: 135 }} />
            <span className="flex" style={{ gap: 2, flexWrap: 'wrap' }}>
              {DAY_LABELS.map((l, d) => (
                <button key={d} type="button" className={`tab${days.includes(d) ? ' active' : ''}`} aria-pressed={days.includes(d)} style={{ flex: 'none', padding: '2px 7px', fontSize: 11.5 }} onClick={() => toggleDay(i, d)}>{l}</button>
              ))}
            </span>
            <button type="button" className="logout-btn" style={{ padding: '3px 9px', fontSize: 12 }} onClick={() => onChange(rows.filter((_, j) => j !== i))}>빼기</button>
            {issue && <span style={{ fontSize: 12, color: 'var(--amber)' }}>{issue}</span>}
          </div>
        );
      })}
      <div className="flex gap wrap" style={{ alignItems: 'center' }}>
        <button type="button" className="tab" style={{ flex: 'none', padding: '3px 10px', fontSize: 12 }} disabled={rows.length >= 8} onClick={() => onChange([...rows, { from: '01:00', to: '05:00' }])}>+ 쉬는 시간 추가</button>
        <span className="muted" style={{ fontSize: 11.5 }}>이 에이전트가 있는 곳의 현지 시각입니다. 자정을 넘길 수 있습니다(22:00~06:00). 쉬는 시간에 걸린 주기 회차는 건너뛰고, ‘지금 스캔’ 은 막지 않습니다.</span>
      </div>
    </div>
  );
}
