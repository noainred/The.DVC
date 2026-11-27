import React from 'react';
import { settingsUnreadNote, registryUnreadNote, unreadKind } from './settingsUnread.js';

/**
 * 112회차: 설정 파일을 못 읽은 동안의 조회 안내(문구 · 판정은 settingsUnread.js — 순수). 표지가 없으면 아무것도 그리지 않는다.
 *   onRecheck 가 있으면 ‘다시 확인’ 버튼을 둔다(주기 조회가 없는 화면 — 다시 읽혔는지 사용자가 확인한다).
 */
export function SettingsUnreadBanner({ le, what, save, corruptLocks = false, formHidden = false, lastGood = false, onRecheck = null, busy = false, style = null }) {
  const text = settingsUnreadNote(le, { what, save, corruptLocks, formHidden, lastGood });
  if (!text) return null;
  return (
    <div className="banner warn" data-settings-unread={unreadKind(le)} style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', marginBottom: 10, fontSize: 12.5, ...(style || {}) }}>
      {text}
      {onRecheck && <button type="button" className="tab" style={{ flex: 'none', padding: '2px 10px', marginLeft: 8 }} disabled={busy} onClick={onRecheck}>다시 확인</button>}
    </div>
  );
}

/**
 * 128회차: 장비 등록부를 못 읽은 동안의 목록 안내(문구는 settingsUnread.js registryUnreadNote — 순수). 표지가 없으면 아무것도 그리지 않는다.
 *   빈 목록을 ‘등록 없음’ 으로 읽지 않게 하는 것이 목적이다(운영자가 전부 새로 등록하지 않게).
 */
export function RegistryUnreadBanner({ le, what, lastGood = false, onRecheck = null, busy = false, style = null }) {
  const text = registryUnreadNote(le, { what, lastGood });
  if (!text) return null;
  return (
    <div className="banner warn" data-registry-unread={unreadKind(le)} style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', marginBottom: 10, fontSize: 12.5, ...(style || {}) }}>
      {text}
      {onRecheck && <button type="button" className="tab" style={{ flex: 'none', padding: '2px 10px', marginLeft: 8 }} disabled={busy} onClick={onRecheck}>다시 확인</button>}
    </div>
  );
}
