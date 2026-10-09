// 검토 I-04: SAN 화면의 '갱신 실패 — 직전 조회 결과 표시 중' 안내(문구는 sanFreshText.freshNote 가 만든다 — 여기는 그리기만).
// 평문이다(BoldText 를 거치지 않는다) — 문구 모듈은 백틱·별표를 쓰지 않는다.
import React from 'react';

const TONE = { warn: 'var(--amber)', bad: 'var(--red)' };

export function FreshNote({ note, style }) {
  if (!note) return null;
  const c = TONE[note.tone] || 'var(--amber)';
  return (
    <div role="status" style={{ border: `1px solid ${c}`, borderRadius: 8, padding: '8px 12px', fontSize: 13, whiteSpace: 'normal', minWidth: 0, ...style }}>
      <div style={{ color: c, fontWeight: 700 }}>⚠ {note.title}</div>
      <div style={{ marginTop: 2 }}>{note.text}</div>
      {note.sub ? <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{note.sub}</div> : null}
    </div>
  );
}

export default FreshNote;
