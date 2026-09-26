/**
 * In-memory ring buffer that captures server console output so the admin UI can
 * display live operational logs. Patches console.* on import (side effect) so it
 * captures as much as possible; keeps the last MAX entries.
 */

import { flatStr } from './util/capStr.js'; // v2.617: 줄 길이 상한 평탄화(import 0 개인 순수 모듈)

const MAX = 1000;
const MSG_MAX = 8192;
const buffer = [];
let seq = 0;
// v2.583: 로그 분석(loganalysis/live.js)이 줄마다 누적 집계를 하려고 붙는 탭. 링 버퍼(1,000줄)는
// 몇 분이면 밀려나므로 24시간·7일 분석의 원천이 될 수 없다 — 그래서 들어오는 순간 집계한다.
// 탭은 **절대 던지지 않고 console 을 부르지 않아야 한다**(재귀) — 여기서도 try 로 막는다.
const taps = new Set();
let inTap = false;
export function addLogTap(fn) { if (typeof fn === 'function') taps.add(fn); return () => taps.delete(fn); }

function safeStringify(o) {
  if (o instanceof Error) return o.stack || o.message;
  try { return JSON.stringify(o); } catch { return String(o); }
}

function record(level, args) {
  try {
    let msg = args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ');
    // v2.617: 링 버퍼 1,000줄은 줄 길이 상한이 없어 큰 객체를 찍는 줄이 쌓이면 수백 MB 를 붙잡을 수 있었다. 8KB 로 자르고
    //   평탄화한다(slice 만 하면 V8 SlicedString 이 원문을 붙잡는다 — util/capStr.js 머리말). stdout(journal)에는 원문 그대로.
    if (msg.length > MSG_MAX) msg = `${flatStr(msg.slice(0, MSG_MAX))}…(+${msg.length - MSG_MAX}자 생략)`;
    const entry = { id: ++seq, time: Date.now(), level, msg };
    buffer.push(entry);
    if (buffer.length > MAX) buffer.shift();
    if (taps.size && !inTap) {
      inTap = true;
      try { for (const fn of taps) { try { fn(entry); } catch { /* 탭 실패는 무시 */ } } } finally { inTap = false; }
    }
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
