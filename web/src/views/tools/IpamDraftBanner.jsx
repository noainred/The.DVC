// IpamDraftBanner.jsx — 편집 초안 안내 줄(v2.636). 문구는 ipamDraft.draftNote 하나가 만든다.
import React from 'react';
import { draftNote } from './ipamDraft.js';

export function DraftBanner({ d, revertLabel = '서버 값으로 되돌리기' }) {
  const note = draftNote(d);
  if (!note) return null;
  return (
    <div className="banner warn" role="status" style={{ margin: '8px 0', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
      <span style={{ color: 'var(--amber)', marginRight: 6 }}>●</span>{note}{' '}
      <button className="cell-link" onClick={d.revert}>{revertLabel}</button>
    </div>
  );
}
