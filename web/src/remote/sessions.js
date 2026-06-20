import { useSyncExternalStore } from 'react';

/**
 * Global remote-console session store. One floating window hosts multiple
 * sessions as tabs (SSH/RDP). Opening another server adds a tab instead of a
 * new window; switching tabs keeps every session connected (bodies stay mounted).
 */

let state = {
  sessions: [],   // { id, kind:'ssh'|'rdp', mapping }
  activeId: null,
  win: { minimized: false, maximized: false, x: 140, y: 88, w: 860, h: 560 },
};
const listeners = new Set();
const emit = () => { state = { ...state }; listeners.forEach((l) => l()); };
const sub = (l) => { listeners.add(l); return () => listeners.delete(l); };

export const useRemoteWindow = () => useSyncExternalStore(sub, () => state);

let seq = 0;
export function openRemoteSession({ kind, mapping, force = false, initialCreds = null }) {
  if (!force) {
    const existing = state.sessions.find((s) => s.kind === kind && s.mapping.id === mapping.id);
    if (existing) {
      state.activeId = existing.id;
      state.win = { ...state.win, minimized: false };
      emit();
      return existing.id;
    }
  }
  const id = `rs${++seq}`;
  state.sessions = [...state.sessions, { id, kind, mapping, initialCreds }];
  state.activeId = id;
  state.win = { ...state.win, minimized: false };
  emit();
  return id;
}

/** New tab to the same target (fresh credentials). */
export function newSessionLike(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (s) openRemoteSession({ kind: s.kind, mapping: s.mapping, force: true });
}

/** Duplicate a tab — same target AND its entered credentials (auto-connects). */
export function duplicateSession(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (s) openRemoteSession({ kind: s.kind, mapping: s.mapping, force: true, initialCreds: s.creds || null });
}

/** Remember the credentials a session connected with (for Duplicate). No re-render. */
export function setSessionCreds(id, creds) {
  const s = state.sessions.find((x) => x.id === id);
  if (s) s.creds = creds;
}

export function closeRemoteSession(id) {
  const i = state.sessions.findIndex((s) => s.id === id);
  state.sessions = state.sessions.filter((s) => s.id !== id);
  if (state.activeId === id) {
    const next = state.sessions[i] || state.sessions[i - 1] || state.sessions[state.sessions.length - 1];
    state.activeId = next ? next.id : null;
  }
  emit();
}

export function activateSession(id) { state.activeId = id; state.win = { ...state.win, minimized: false }; emit(); }
export function setWin(patch) { state.win = { ...state.win, ...patch }; emit(); }
export function closeAllSessions() { state.sessions = []; state.activeId = null; emit(); }
