/**
 * perf/stallWatch.js — 메인 이벤트 루프 '멈춤' 감시(워커 스레드, v2.617).
 *
 * 왜: 2026-09-26 운영 중앙(v2.616.0)이 기동 약 5분 뒤 응답을 멈췄다 — 서비스는 active, 로그 0줄, 한 코어 100%,
 *   RSS 가 몇 초 사이 5.1→5.3GB. 기존 `util/loopLag.js` 는 **메인 루프 안의 타이머**라 루프가 풀린 뒤에야 보고한다
 *   (풀리지 않으면 영원히 말하지 않는다). console 도 메인 경유라 멈춘 동안에는 한 줄도 나가지 않는다.
 *   그래서 원인을 찍을 수단이 '사람이 서버에 들어가 SIGUSR1 로 인스펙터를 여는 것' 뿐이었다.
 *
 * 방식:
 *  - 메인은 1초마다 공유 버퍼(Float64Array)에 박동 시각·힙 사용량·힙 한계를 쓴다.
 *  - 워커는 주기적으로 박동을 본다. `stallMs`(기본 10초) 넘게 멈추면 **`fs.writeSync(2, …)` 로 stderr 에 직접**
 *    쓴다(systemd 가 journal 로 받는다 — 메인이 막혀 있어도 남는다).
 *  - 그때 1회 `inspector.Session.connectToMainThread()` → `Debugger.pause` 로 **메인의 JS 호출 스택**을 채취해
 *    적고 즉시 resume 한다. 프로세스 내부 스레드 간 연결이라 **네트워크 포트를 열지 않는다**(SIGUSR1 방식과 다름).
 *    pause 가 제한 시간 안에 응답하지 않으면 '스택을 얻지 못했다 — JS 가 아니라 GC 중일 수 있다' 고 적는다
 *    (**단정하지 않는다** — 네이티브 동기 호출일 수도 있다).
 *  - 멈춤이 이어지면 60초마다 경과를 한 줄, 풀리면 총 지속 시간과 힙을 한 줄 적는다.
 *  - 힙 사용량이 한계의 85% 이상이면(루프는 돌고 있어도) 1분에 1줄 경고한다 — GC 헛돎의 전조다.
 *
 * `STALL_WATCH=0` 이면 끈다. 시작 실패는 조용히 no-op(서비스에 영향 없음 — loopLag 와 같은 원칙).
 */
import { Worker } from 'node:worker_threads';
import v8 from 'node:v8';
import { clampIntervalMs } from '../config.js';

const SLOT_BEAT = 0; const SLOT_HEAP = 1; const SLOT_LIMIT = 2;

let started = false;
let worker = null;
let beatTimer = null;
const _state = { enabled: false, stallMs: null, stalls: 0, last: null, heapWarns: 0, lastHeapWarnAt: null, error: null };

/** 워커 본문(문자열로 eval — 별도 파일을 두면 패키지·경로 문제가 하나 더 생긴다). 순수 Node 내장만 쓴다. */
const WORKER_SRC = String.raw`
// 부모가 ESM 입력 모드(--input-type=module)면 eval 워커도 ESM 으로 해석돼 require 가 없다(v2.617 자체 테스트가 잡았다) —
// process.getBuiltinModule(Node 22.3+)을 먼저 쓴다.
const req = (n) => (typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule(n) : require(n));
const { workerData, parentPort } = req('node:worker_threads');
const fs = req('node:fs');
const { sab, stallMs, checkMs, pauseWaitMs, heapWarnPct } = workerData;
const buf = new Float64Array(sab);
const w = (line) => { try { fs.writeSync(2, '[stallwatch] ' + line + '\n'); } catch {} };
const mb = (b) => Number.isFinite(b) && b > 0 ? Math.round(b / 1048576) + 'MB' : '?';
const heapText = () => { const u = buf[1], l = buf[2]; return 'heap ' + mb(u) + '/' + mb(l) + (u > 0 && l > 0 ? ' (' + Math.round(u / l * 100) + '%)' : ''); };
let stalledSince = 0, lastProgress = 0, lastHeapWarn = 0;

function captureStack(done) {
  let inspector;
  try { inspector = req('node:inspector'); } catch (e) { done(null, 'inspector 없음: ' + e.message); return; }
  let s;
  try { s = new inspector.Session(); s.connectToMainThread(); } catch (e) { done(null, '메인 연결 실패: ' + e.message); return; }
  const urls = new Map();
  let finished = false;
  const finish = (frames, err) => {
    if (finished) return; finished = true;
    try { s.post('Debugger.resume', () => { try { s.post('Debugger.disable', () => { try { s.disconnect(); } catch {} }); } catch {} }); } catch {}
    done(frames, err);
  };
  s.on('Debugger.scriptParsed', (m) => { try { urls.set(m.params.scriptId, m.params.url); } catch {} });
  s.on('Debugger.paused', (m) => {
    try {
      const frames = (m.params.callFrames || []).slice(0, 30).map((f) =>
        (f.functionName || '(익명)') + '  ' + String(f.url || urls.get(f.location.scriptId) || '?').replace(/^file:\/\//, '') + ':' + (f.location.lineNumber + 1));
      finish(frames, null);
    } catch (e) { finish(null, e.message); }
  });
  const timer = setTimeout(() => finish(null, 'pause 가 ' + Math.round(pauseWaitMs / 1000) + '초 안에 응답하지 않음 — JS 실행이 아니라 GC(가비지 수집) 또는 네이티브 동기 호출 중일 수 있습니다(단정 아님)'), pauseWaitMs);
  try {
    s.post('Debugger.enable', () => { s.post('Debugger.pause', () => {}); });
  } catch (e) { clearTimeout(timer); finish(null, e.message); return; }
  const origDone = done; done = (fr, er) => { clearTimeout(timer); origDone(fr, er); };
}

setInterval(() => {
  const now = Date.now();
  const beat = buf[0];
  const gap = beat > 0 ? now - beat : 0;
  if (gap > stallMs) {
    if (!stalledSince) {
      stalledSince = beat; lastProgress = now;
      w('메인 이벤트 루프가 ' + Math.round(gap / 1000) + '초째 응답하지 않습니다 — HTTP 요청·폴러가 모두 멈춘 상태입니다. ' + heapText());
      captureStack((frames, err) => {
        if (frames && frames.length) {
          w('멈춘 지점의 메인 JS 호출 스택(위가 가장 안쪽):');
          for (const f of frames) w('    ' + f);
        } else {
          w('호출 스택을 얻지 못했습니다: ' + err);
        }
        try { parentPort.postMessage({ type: 'stall', at: stalledSince, frames: frames || null, error: err || null, heapUsed: buf[1], heapLimit: buf[2] }); } catch {}
      });
    } else if (now - lastProgress >= 60000) {
      lastProgress = now;
      w('여전히 멈춤 — ' + Math.round((now - stalledSince) / 1000) + '초 경과. ' + heapText());
    }
  } else if (stalledSince) {
    const dur = beat - stalledSince;
    w('멈춤이 풀렸습니다 — 약 ' + Math.round(dur / 1000) + '초 동안 멈춰 있었습니다. ' + heapText());
    try { parentPort.postMessage({ type: 'resume', at: stalledSince, durMs: dur }); } catch {}
    stalledSince = 0;
  } else {
    const u = buf[1], l = buf[2];
    if (u > 0 && l > 0 && u / l * 100 >= heapWarnPct && now - lastHeapWarn >= 60000) {
      lastHeapWarn = now;
      w('힙 사용량이 한계에 가깝습니다 — ' + heapText() + '. 한계에 닿으면 GC 가 헛돌며 응답이 멈출 수 있습니다.');
      try { parentPort.postMessage({ type: 'heap', at: now, heapUsed: u, heapLimit: l }); } catch {}
    }
  }
}, checkMs);
`;

/** 부팅 시 1회. 재호출·비활성·오류에 안전(no-op). */
export function startStallWatch({ stallMs, checkMs, beatMs, pauseWaitMs = 10_000, heapWarnPct } = {}) {
  if (started) return false;
  if (process.env.STALL_WATCH === '0') return false;
  started = true;
  try {
    const stall = stallMs ?? clampIntervalMs(Number(process.env.STALL_WATCH_MS) || 10_000, 10_000, 2_000);
    const check = checkMs ?? Math.max(250, Math.min(2_000, Math.floor(stall / 4)));
    // 박동 간격은 경계보다 충분히 짧아야 한다 — 같거나 길면 멈추지 않았는데도 박동 사이 간격이 경계를 넘어 거짓 멈춤이 된다.
    const beatEvery = beatMs ?? Math.max(100, Math.min(1_000, Math.floor(stall / 4)));
    const warnPct = heapWarnPct ?? Math.min(99, Math.max(50, Number(process.env.STALL_WATCH_HEAP_WARN_PCT) || 85));
    const sab = new SharedArrayBuffer(8 * 3);
    const buf = new Float64Array(sab);
    const beat = () => {
      buf[SLOT_BEAT] = Date.now();
      try { const h = v8.getHeapStatistics(); buf[SLOT_HEAP] = h.used_heap_size; buf[SLOT_LIMIT] = h.heap_size_limit; } catch { /* */ }
    };
    beat();
    beatTimer = setInterval(beat, beatEvery);
    beatTimer.unref?.();
    worker = new Worker(WORKER_SRC, { eval: true, execArgv: [], workerData: { sab, stallMs: stall, checkMs: check, pauseWaitMs, heapWarnPct: warnPct } });
    worker.unref?.();
    worker.on('message', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'stall') {
        _state.stalls += 1;
        _state.last = { at: m.at, durMs: null, frames: Array.isArray(m.frames) ? m.frames.slice(0, 30) : null, error: m.error || null,
          heapUsed: m.heapUsed || null, heapLimit: m.heapLimit || null };
      } else if (m.type === 'resume' && _state.last && _state.last.at === m.at) {
        _state.last = { ..._state.last, durMs: m.durMs };
        // v2.617(ARCH-3): 워커의 stderr 줄은 journal 에만 간다 — 서비스 계정은 보통 journal 을 못 읽고, 링 버퍼·엣지 로그·
        //   로그 분석은 console 만 본다. 풀린 뒤(메인이 다시 돌 때) 요약 한 줄을 console 로도 남긴다.
        try {
          const top = Array.isArray(_state.last.frames) && _state.last.frames.length ? _state.last.frames[0] : null;
          console.warn(`[stallwatch] 메인 이벤트 루프가 약 ${Math.round((m.durMs || 0) / 1000)}초 동안 멈췄다가 풀렸습니다 — ${top ? `멈춘 지점 ${top}` : `스택 없음(${_state.last.error || 'GC·네이티브 호출 가능성'})`}. 전체 스택은 journal 의 [stallwatch] 줄에 있습니다.`);
        } catch { /* */ }
      } else if (m.type === 'heap') {
        _state.heapWarns += 1; _state.lastHeapWarnAt = m.at;
        try { console.warn(`[stallwatch] 힙 사용량이 한계에 가깝습니다 — ${Math.round((m.heapUsed || 0) / 1048576)}MB/${Math.round((m.heapLimit || 0) / 1048576)}MB. 한계에 닿으면 GC 가 헛돌며 응답이 멈출 수 있습니다.`); } catch { /* */ }
      }
    });
    worker.on('error', (e) => { _state.error = String(e?.message || e); _state.enabled = false; try { console.warn(`[stallwatch] 감시 워커 오류 — 감시 중단: ${_state.error}`); } catch { /* */ } });
    _state.enabled = true; _state.stallMs = stall;
    return true;
  } catch (e) {
    _state.error = String(e?.message || e);
    try { console.warn(`[stallwatch] 비활성(${_state.error})`); } catch { /* */ }
    return false;
  }
}

/** 서비스 점검 화면용 상태(스택은 코드 경로뿐 — 비밀 없음). 엣지 로그 표에는 넣지 않았다(edgeSweep EXCLUDED 사유) — 대신 풀린 뒤 console 한 줄이 링 버퍼·엣지 로그로 간다. */
export function stallWatchStatus() {
  return { ..._state, last: _state.last ? { ..._state.last } : null };
}

/** 테스트용 정지. */
export async function _stopStallWatch() {
  if (beatTimer) clearInterval(beatTimer);
  beatTimer = null;
  if (worker) { try { await worker.terminate(); } catch { /* */ } }
  worker = null; started = false;
}
