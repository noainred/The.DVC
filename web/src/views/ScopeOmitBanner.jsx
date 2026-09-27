import React from 'react';
import { scopeOmitNote } from './scopeOmitText.js';

/**
 * 범위 계정에서 뺀 항목 안내 한 줄(v2.630 UI2630-01). 판정·문구는 scopeOmitText.js 하나가 소유한다.
 * 뺀 것이 없으면 아무것도 그리지 않는다.
 */
export default function ScopeOmitBanner({ data, unit, counter, why, style }) {
  const note = scopeOmitNote(data, unit, counter, { why });
  if (!note) return null;
  return (
    <div className="card" data-scope-omit="1" style={{ padding: '8px 12px', marginBottom: 12, borderLeft: '3px solid var(--amber)', fontSize: 13, whiteSpace: 'normal', ...(style || {}) }}>
      🔒 {note}
    </div>
  );
}
