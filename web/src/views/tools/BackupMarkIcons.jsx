/**
 * 백업 표시 아이콘(v2.784 — 사용자 요청 '업무 중요도 아이콘 · 백업 필요 아이콘'). 백업 서머리·세부내용이 같이 쓴다.
 *  · 중요도 = 방패(상 빨강 · 중 주황 · 하 회색 — 색과 글자를 함께 써서 색만으로 구분하지 않게)
 *  · 백업 필요 = 내려받기 화살표가 든 원(파랑)
 */
import React from 'react';
import { critOf } from './backupViewText.js';

// plainText: 선택된(파란 바탕) 버튼 안에서는 글자를 바탕 글자색으로 — 빨강·주황 글자가 파란 바탕에서 읽히지 않는다(v2.784 Chromium 판독)
export function CritIcon({ crit, size = 15, withText = false, plainText = false }) {
  const c = critOf(crit);
  if (!c) return null;
  return (
    <span title={c.label} aria-label={c.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: plainText ? 'inherit' : c.color, flex: 'none' }}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill={c.color} fillOpacity="0.22" stroke={c.color} strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3 4 6v6c0 4.4 3.4 8.2 8 9 4.6-.8 8-4.6 8-9V6z" />
      </svg>
      {withText && <b style={{ fontSize: 11 }}>{c.text}</b>}
    </span>
  );
}

export const NEED_COLOR = '#60a5fa';
export function NeedIcon({ size = 15, title = '백업 필요' }) {
  return (
    <span title={title} aria-label={title} style={{ display: 'inline-flex', color: NEED_COLOR, flex: 'none' }}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={NEED_COLOR} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill={NEED_COLOR} fillOpacity="0.18" /><path d="M12 7v7m-3-3 3 3 3-3M8 17h8" />
      </svg>
    </span>
  );
}
