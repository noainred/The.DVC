import React, { useRef } from 'react';
import { useRemoteWindow, closeRemoteSession, activateSession, setWin, closeAllSessions } from './sessions.js';
import { SshConsole, RdpConsole } from './RemoteConsole.jsx';

/**
 * A single floating console window that hosts every open SSH/RDP session as a
 * tab. Opening another server adds a tab; bodies stay mounted across tab
 * switches so sessions keep running. Draggable, resizable, minimizable.
 */
export function RemoteConsoleWindow() {
  const { sessions, activeId, win } = useRemoteWindow();
  const dragRef = useRef(null);

  if (sessions.length === 0) return null;

  // Minimized → a dock chip at the bottom.
  if (win.minimized) {
    const active = sessions.find((s) => s.id === activeId) || sessions[0];
    return (
      <button onClick={() => setWin({ minimized: false })}
        style={{ position: 'fixed', left: 16, bottom: 16, zIndex: 300, padding: '10px 16px', borderRadius: 10,
          background: 'var(--accent, #2563eb)', color: '#fff', border: 'none', cursor: 'pointer', boxShadow: '0 6px 24px rgba(0,0,0,.4)', fontSize: 13 }}>
        🖥️ 원격 콘솔 {sessions.length}개 — {active.mapping.name} (열기)
      </button>
    );
  }

  const startDrag = (e) => {
    if (win.maximized || e.target.closest('button')) return;
    const d = { sx: e.clientX, sy: e.clientY, x: win.x, y: win.y };
    const move = (ev) => setWin({ x: Math.max(0, d.x + ev.clientX - d.sx), y: Math.max(0, d.y + ev.clientY - d.sy) });
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };
  const startResize = (e) => {
    e.stopPropagation();
    const d = { sx: e.clientX, sy: e.clientY, w: win.w, h: win.h };
    const move = (ev) => setWin({ w: Math.max(420, d.w + ev.clientX - d.sx), h: Math.max(260, d.h + ev.clientY - d.sy) });
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };

  const geo = win.maximized
    ? { left: 8, top: 8, width: 'calc(100vw - 16px)', height: 'calc(100vh - 16px)' }
    : { left: win.x, top: win.y, width: win.w, height: win.h };

  return (
    <div className="card" style={{ position: 'fixed', zIndex: 250, display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden', boxShadow: '0 10px 40px rgba(0,0,0,.5)', ...geo }} ref={dragRef}>
      {/* title bar (drag) */}
      <div onMouseDown={startDrag} onDoubleClick={() => setWin({ maximized: !win.maximized })}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: win.maximized ? 'default' : 'move', background: 'rgba(255,255,255,.04)', borderBottom: '1px solid rgba(255,255,255,.08)' }}>
        <b style={{ fontSize: 14 }}>🖥️ 원격 콘솔</b>
        <span className="muted" style={{ fontSize: 12 }}>{sessions.length} 세션</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button className="logout-btn" style={{ padding: '4px 10px' }} title="최소화" onClick={() => setWin({ minimized: true })}>—</button>
          <button className="logout-btn" style={{ padding: '4px 10px' }} title={win.maximized ? '창 모드' : '최대화'} onClick={() => setWin({ maximized: !win.maximized })}>{win.maximized ? '⤡' : '⤢'}</button>
          <button className="logout-btn" style={{ padding: '4px 10px' }} title="전체 닫기" onClick={closeAllSessions}>✕</button>
        </div>
      </div>

      {/* tab bar */}
      <div style={{ display: 'flex', gap: 2, padding: '6px 8px 0', overflowX: 'auto', background: 'rgba(255,255,255,.02)' }}>
        {sessions.map((s) => (
          <div key={s.id} onClick={() => activateSession(s.id)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: '8px 8px 0 0', cursor: 'pointer', whiteSpace: 'nowrap', fontSize: 12,
              background: s.id === activeId ? 'var(--card-bg, #0f172a)' : 'transparent',
              color: s.id === activeId ? 'var(--text)' : 'var(--text-faint, #94a3b8)',
              borderTop: s.id === activeId ? '2px solid var(--accent, #2563eb)' : '2px solid transparent' }}>
            <span className="badge blue" style={{ fontSize: 10, padding: '1px 5px' }}>{s.kind.toUpperCase()}</span>
            {s.mapping.name}
            <span onClick={(e) => { e.stopPropagation(); closeRemoteSession(s.id); }} title="탭 닫기" style={{ marginLeft: 4, opacity: 0.6 }}>✕</span>
          </div>
        ))}
      </div>

      {/* bodies (all mounted; only active is shown so sessions stay connected) */}
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {sessions.map((s) => (
          <div key={s.id} style={{ position: 'absolute', inset: 0, display: s.id === activeId ? 'block' : 'none' }}>
            {s.kind === 'ssh'
              ? <SshConsole mapping={s.mapping} active={s.id === activeId} />
              : <RdpConsole mapping={s.mapping} active={s.id === activeId} />}
          </div>
        ))}
      </div>

      {/* resize handle */}
      {!win.maximized && (
        <div onMouseDown={startResize} style={{ position: 'absolute', right: 0, bottom: 0, width: 16, height: 16, cursor: 'nwse-resize',
          background: 'linear-gradient(135deg, transparent 50%, rgba(255,255,255,.35) 50%)' }} />
      )}
    </div>
  );
}
