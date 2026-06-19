/**
 * In-memory ring buffer that captures server console output so the admin UI can
 * display live operational logs. Patches console.* on import (side effect) so it
 * captures as much as possible; keeps the last MAX entries.
 */

const MAX = 1000;
const buffer = [];
let seq = 0;

function safeStringify(o) {
  if (o instanceof Error) return o.stack || o.message;
  try { return JSON.stringify(o); } catch { return String(o); }
}

function record(level, args) {
  try {
    const msg = args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ');
    buffer.push({ id: ++seq, time: Date.now(), level, msg });
    if (buffer.length > MAX) buffer.shift();
  } catch { /* never let logging break the app */ }
}

let installed = false;
export function initLogCapture() {
  if (installed) return;
  installed = true;
  for (const [method, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']]) {
    const orig = console[method].bind(console);
    console[method] = (...args) => { record(level, args); orig(...args); };
  }
}

/** Append a log entry directly (used for request logging). */
export function pushLog(level, msg) {
  record(level, [msg]);
}

/** Return entries with id > since, optionally filtered by level. */
export function getLogs({ since = 0, level } = {}) {
  let out = buffer.filter((e) => e.id > Number(since || 0));
  if (level && level !== 'all') out = out.filter((e) => e.level === level);
  return { lastId: seq, count: out.length, items: out };
}

// Capture as early as possible.
initLogCapture();
