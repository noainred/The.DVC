/**
 * focusmon/audit/runner.js — 디스크 점검을 **한 노드(중앙 또는 엣지)** 에서 실행한다(v3.11.0). 중앙과 엣지가 같은 파일을 쓴다.
 *
 *  · 대기열 하나 · 노드당 동시 실행 `NODE_CONCURRENCY`(1) — 점검은 대상 서버의 로그를 전부 읽어 무겁다. 준비 확인(check)도 같은 줄에 선다.
 *  · 한 세션 안에서: ① 준비 확인(일반 계정 · 상수 `READY_COMMAND`) ② 준비됐을 때만 실행(`RUN_COMMAND` — sudo 인자 없이) — 판본 · 소유자 · sudo 판정은
 *    parse.js readyState 하나. 중앙은 엣지가 보낸 원문(준비 줄 · 실행 줄)을 다시 해석한다(엣지 해석값을 믿지 않는다).
 *  · 시한 `AUDIT_DEADLINE_MS` 이 지나면 세션을 실제로 끊는다(withSsh signal). 실행 파일 안의 timeout 이 대상 서버 쪽 프로세스도 끝낸다.
 *  · 인증 거부는 집중 모니터링 수집과 같은 정지 기록(focusAuthGuard)에 남기고 자동으로 다시 시도하지 않는다. 정지된 대상은 접속하지 않는다.
 *  · 출력 보관은 구획별 예산(`SECTION_BUDGET`) + 전체 줄 수(`OUT_LINES_MAX`) — 보고서가 커도 구획 머리 · 판정 · 디스크 목록이 남는다. 넘친 구획은 그 뒤를 받지 않고
 *    '…(이 구획 N줄 생략)' 한 줄. 예산 밖은 **그 실행의 표지 줄(난수 — 최대 8줄)과 첫 줄뿐**이다(반증 F1 — 표지 꼴 줄이 예산 밖이라 결과가 23.5MB 가 됐다).
 *    구획 머리도 예산(`HEAD_BUDGET`) 안에서만 머리로 받는다(로그에서 온 줄일 수 있다).
 *  · 데모(mock) 대상은 SSH 없이 mock.js 의 보고서를 같은 길로 낸다.
 */
import { withSsh, isSshAuthError, isSshHostKeyError } from '../../proxy/sshExec.js';
import { focusAuthGuard, authDevOf, READY_TIMEOUT_MS } from '../collector.js';
import { isUnreadStop } from '../../util/authGuard.js';
import { AUDIT_DEADLINE_MS, READY_EXEC_MS, programSha, wrapperSha, pathsFor, dirIssue, dirsToCheck, readyCommandFor, runCommandFor } from './bundle.js';
import { parseReady, readyState, sectionOf, firstLineOf, markOf, LINE_MAX } from './parse.js';
import { demoAuditOutput } from './mock.js';
import { isDemoTarget } from '../mock.js';
import { trackAuditRunner } from './inflight.js';   // 50회차 R3

export const NODE_CONCURRENCY = 1;
export const QUEUE_MAX = 200;
export const MAX_LINE_BYTES = 256 * 1024;
export const STDERR_MAX = 4096;
/** 구획별 보관 예산(바이트 · 합 약 4MB) — 받은 프로그램의 보고서 구획 이름 그대로. 그 밖(머리 · 디스크 목록)은 'other'. */
export const SECTION_BUDGET = Object.freeze({
  '로그 수집 범위': 256 * 1024, 'PERC/StorCLI 조회': 256 * 1024, 'OS/SMART 조회': 256 * 1024, 'RAID 경유 물리 SMART 조회': 256 * 1024,
  '현재 디스크 인벤토리': 256 * 1024, '판정': 1024 * 1024, '상세 근거': 1536 * 1024, '해석 범위': 64 * 1024, other: 256 * 1024, disks: 512 * 1024,
});
/** 구획 머리 줄 예산 — 넘으면 머리로 보지 않고 그 구획의 글자로 센다. */
export const HEAD_BUDGET = 32 * 1024;
/** 보관 줄 수 상한(중앙 정제 상한 `cleanEdgeResult` 80,000줄보다 작게 — 엣지가 보낸 결과의 끝 표지가 중앙에서 잘리지 않게). */
export const OUT_LINES_MAX = 70_000;
/** 그 실행의 표지 줄 상한(EXIT · DISKS · RAID · END — 되풀이는 버린다). */
const MARKS_MAX = 8;
export const OUTPUT_MAX_BYTES = Object.values(SECTION_BUDGET).reduce((a, b) => a + b, 0) + HEAD_BUDGET;

const short = (e) => String(e?.message || e || '').replace(/\s+/g, ' ').slice(0, 240);

/**
 * 실행 출력 모으기(순수 — 테스트 고정). push(line) 을 차례로 부르고 done() 으로 줄 목록을 받는다.
 *  · 첫 줄(빈 줄 제외)은 늘 남긴다 — 실행 파일의 BEGIN(표지) 또는 ERR. 표지 판정은 parse.js firstLineOf · markOf 하나(해석과 같다).
 *  · 그 실행의 표지 줄만 예산 밖(최대 MARKS_MAX). END 뒤는 받지 않는다.
 *  · 구획이 예산을 넘으면 그 구획의 나머지를 받지 않는다(앞부분만 남는다 — 근거 번호가 중간에서 빠지지 않게). 넘친 구획에는 생략 줄을 하나 붙인다.
 */
export function createOutputKeeper({ budget = SECTION_BUDGET, linesMax = OUT_LINES_MAX, headBudget = HEAD_BUDGET } = {}) {
  const out = []; const used = {}; const cut = {}; const closed = new Set();
  let sec = 'other'; let part = ''; let bytes = 0; let phase = null; let nonce = null; let started = false; let ended = false; let heads = 0; let marks = 0;
  const flushCut = () => { if (cut[sec]) { out.push(`…(이 구획 ${cut[sec]}줄 생략)`); cut[sec] = 0; } };
  return {
    push(raw) {
      const s0 = String(raw ?? '');
      const line = s0.length > LINE_MAX ? `${s0.slice(0, LINE_MAX)}…(잘림)` : s0;
      const n = Buffer.byteLength(line) + 1;
      bytes += n;
      if (ended) return;
      if (!started) {
        if (!line) return;
        started = true;
        const f = firstLineOf(line);
        if (f?.nonce) nonce = f.nonce;
        out.push(line); return;
      }
      const mk = markOf(line, nonce);
      if (mk) {
        flushCut();
        if (mk === 'DISKS' || mk === 'RAID') { part = 'disks'; sec = 'disks'; phase = '디스크 목록'; }
        else { part = ''; sec = 'other'; if (mk === 'END') ended = true; }
        if (marks < MARKS_MAX) { marks += 1; out.push(line); }
        return;
      }
      const s = part === 'disks' ? null : sectionOf(line);
      if (s && heads + n <= headBudget && out.length < linesMax) { flushCut(); sec = s; phase = s; heads += n; out.push(line); return; }
      const key = part === 'disks' ? 'disks' : sec;
      const lim = budget[key] ?? budget.other;
      if (closed.has(key) || (used[key] || 0) + n > lim || out.length >= linesMax) { closed.add(key); cut[key] = (cut[key] || 0) + 1; return; }
      used[key] = (used[key] || 0) + n; out.push(line);
    },
    done() { flushCut(); return out; },
    phase: () => phase,
    bytes: () => bytes,
    truncated: () => closed.size > 0 || out.some((l) => l.startsWith('…(이 구획 ')),
  };
}

/** 준비 확인할 설치 위치 후보(검사를 지난 것만 · 겹침 없이 · 셋까지). 작업에 없으면(옛 중앙) 기본 경로 하나. */
export function candidateDirs(expect) {
  const raw = Array.isArray(expect?.cands) ? expect.cands : [''];
  const out = [];
  for (const d of raw.slice(0, 3)) { const x = d == null ? '' : d; if (typeof x === 'string' && !dirIssue(x) && !out.includes(x)) out.push(x); }
  return out.length ? out : [''];
}
/** 기대 판본 — 작업을 준 중앙이 아는 값(프로그램 · 디렉터리별 실행 파일) · 없으면 이 노드의 값. */
export function expectedShas(expect, dir) {
  const hex = (v) => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : null);
  const w = expect?.wrappers && typeof expect.wrappers === 'object' && !Array.isArray(expect.wrappers) && Object.hasOwn(expect.wrappers, dir) ? hex(expect.wrappers[dir]) : (dir === '' ? hex(expect?.wrapper) : null);
  return { programSha: hex(expect?.program) || programSha(), wrapperSha: w || wrapperSha(dir) };
}

/**
 * 한 대상 실행(대기열 밖에서 쓰는 순수 실행기 — 대기열은 createAuditRunner).
 * @param {{id:string, host:string, port:number, username:string, demo?:boolean}} t
 * @param {{mode:'check'|'run', keys:object, connect?:Function, onPhase?:Function, deadlineMs?:number}} o
 * @returns {Promise<object>} { mode, ok, kind, error, ready:string[], out:string[], outBytes, truncated, code, stderr, ms }
 */
export async function auditOnce(t, { mode = 'run', keys, connect = withSsh, onPhase = () => {}, deadlineMs = AUDIT_DEADLINE_MS, expect = null } = {}) {
  const t0 = Date.now();
  const base = { mode, ok: false, kind: 'unreachable', error: '', ready: [], out: [], outBytes: 0, truncated: false, code: null, stderr: '', ms: 0 };
  if (t.demo || isDemoTarget(t.id)) {
    const dir = candidateDirs(expect)[0]; // 데모는 첫 후보(기억한 곳 · 지금 설정)에 설치돼 있는 것으로 그린다
    const d = demoAuditOutput(t.id, mode, dir);
    try { onPhase(mode === 'run' ? '판정' : '준비 확인'); } catch { /* */ }
    return { ...base, ok: true, kind: 'done', ...d, dir, ms: mode === 'run' ? 3000 : 400 };
  }
  const info = keys.keyInfo();
  const pem = keys.privateKeyForConnect();
  if (!pem) return { ...base, kind: 'no-key', error: info?.error || '이 노드에 SSH 키가 없습니다.' };
  const dev = authDevOf(t, info.fingerprint);
  const stopRec = focusAuthGuard.peekAuthStop(dev);
  // 127회차: 정지 기록 파일을 못 읽어 모르는 대상은 키 로그인이 거부된 것이 아니다(collector.js testTarget 과 같다 — 거부되면 아래에서 실제 정지로 기록)
  if (stopRec && !isUnreadStop(stopRec)) return { ...base, kind: 'auth-stopped', error: `키 로그인 거부로 멈춰 있습니다(${stopRec.reason}) — 공개키를 넣은 뒤 ‘다시 연결’ 을 누르세요.` };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deadlineMs); timer.unref?.();
  const keep = createOutputKeeper();
  let ready = []; let code = null; let stderr = ''; let ranRun = false; let state = null; let longCut = 0; let found = '';
  const cands = candidateDirs(expect);
  try {
    onPhase('준비 확인');
    await connect({ host: t.host, port: t.port, username: t.username, privateKey: pem, readyTimeout: READY_TIMEOUT_MS, signal: ctl.signal }, async (api) => {
      // v3.17.0: 설치 위치 후보(기억한 곳 → 지금 설정 → 기본 경로 — 중앙이 정해 보낸다)를 차례로 — 파일이 있는 첫 곳을 그 서버의 설치 위치로 본다
      let first = null;
      for (const dir of cands) {
        const P = pathsFor(dir);
        const r = await api.exec(readyCommandFor(P), READY_EXEC_MS);
        const lines = String(r.stdout || '').split('\n').slice(0, 200);
        // 판본은 작업을 준 중앙이 아는 값(엣지 · 중앙 판이 달라도 중앙이 내려준 설치 파일과 맞춘다) — 없으면 이 노드의 값
        const st = readyState(parseReady(lines), { programPath: P.program, wrapperPath: P.wrapper, dirs: dirsToCheck(P), ...expectedShas(expect, dir) });
        if (!first) first = { dir, lines, st };
        if (st.state !== 'notinstalled') { first = { dir, lines, st }; break; }
      }
      ({ dir: found, lines: ready, st: state } = first);
      if (mode !== 'run' || state.state !== 'ready') return {};
      ranRun = true;
      let last = '준비 확인';
      // 긴 한 줄은 끊지 않고 자른다(반증 F9-e — 일반 계정이 남긴 긴 로그 한 줄로 실행 전체를 'bad-output' 으로 만들 수 있었다)
      const s = await api.execStream(runCommandFor(pathsFor(found)), {
        maxLine: MAX_LINE_BYTES, cutLong: true, signal: ctl.signal,
        onLine: (l) => { keep.push(l); const p = keep.phase(); if (p && p !== last) { last = p; try { onPhase(p); } catch { /* */ } } },
      });
      code = s.code ?? null; stderr = String(s.stderr || '').slice(0, STDERR_MAX); longCut = s.cutLines || 0;
      if (s.aborted) throw new Error('aborted');
      return {};
    }, { signal: ctl.signal });
    focusAuthGuard.clearAuthStop(dev.id);
    const out = keep.done();
    if (!ranRun) return { ...base, ok: true, kind: mode === 'run' ? 'not-ready' : 'done', ready, dir: found, ms: Date.now() - t0 };
    // ran: 실행을 시도했다(출력이 비어도 — sudo 자체가 실패하면 표준 출력은 비고 표준 오류에만 남는다 · 반증 F4)
    return { ...base, ok: true, kind: 'done', ran: true, ready, dir: found, out, outBytes: keep.bytes(), truncated: keep.truncated() || longCut > 0, code, stderr, ms: Date.now() - t0 };
  } catch (e) {
    const out = keep.done();
    const partial = { ran: ranRun, ready, dir: found, out, outBytes: keep.bytes(), truncated: keep.truncated(), code, stderr, ms: Date.now() - t0 };
    if (isSshHostKeyError(e)) return { ...base, ...partial, kind: 'hostkey', error: short(e) };
    if (isSshAuthError(e)) { focusAuthGuard.markAuthStopped(dev.id, dev, '키 로그인 거부(디스크 점검)'); return { ...base, ...partial, kind: 'auth', error: '키 로그인이 거부됐습니다 — 공개키를 확인하세요.' }; }
    if (ctl.signal.aborted) return { ...base, ...partial, kind: 'timeout', error: `${Math.round(deadlineMs / 60_000)}분 안에 끝나지 않아 끊었습니다.` };
    if (/한 줄이 상한/.test(short(e))) return { ...base, ...partial, kind: 'bad-output', error: short(e) };
    return { ...base, ...partial, kind: 'unreachable', error: short(e) };
  } finally { clearTimeout(timer); }
}

/**
 * 대기열 실행기 — 노드마다 하나. submit 은 같은 대상이 이미 줄에 있으면 거절한다(겹쳐 띄우지 않는다).
 * @param {{keys:object, connect?:Function, onResult:(job, result)=>void, onPhase?:(job, phase)=>void, concurrency?:number}} o
 */
export function createAuditRunner({ keys, connect, onResult, onPhase = () => {}, concurrency = NODE_CONCURRENCY, exec = auditOnce, kind = 'audit' } = {}) {
  const queue = []; const running = new Map(); // runId → job
  const pump = () => {
    while (running.size < concurrency && queue.length) {
      const job = queue.shift();
      running.set(job.runId, { ...job, startedAt: Date.now(), phase: '준비 확인' });
      exec(job.target, { mode: job.mode, keys, connect, expect: job.expect || null, onPhase: (p) => { const j = running.get(job.runId); if (j) j.phase = p; try { onPhase(job, p); } catch { /* */ } } })
        .catch((e) => ({ mode: job.mode, ok: false, kind: 'unreachable', error: short(e), ready: [], out: [], outBytes: 0, truncated: false, code: null, stderr: '', ms: 0 }))
        .then((result) => { const j = running.get(job.runId); running.delete(job.runId); try { onResult({ ...job, startedAt: j?.startedAt || Date.now() }, result); } catch { /* */ } pump(); });
    }
  };
  return trackAuditRunner({
    /** @returns {{ok:boolean, code?:string}} */
    submit(job) {
      const id = String(job?.target?.id || '');
      if (!id || !job.runId) return { ok: false, code: 'bad' };
      if (queue.some((x) => x.target.id === id) || [...running.values()].some((x) => x.target.id === id)) return { ok: false, code: 'busy' };
      if (queue.length >= QUEUE_MAX) return { ok: false, code: 'queue-full' };
      queue.push({ runId: String(job.runId), mode: job.mode === 'check' ? 'check' : 'run', target: { ...job.target }, expect: job.expect || null, queuedAt: Date.now() });
      pump();
      return { ok: true };
    },
    has: (runId) => running.has(String(runId)) || queue.some((x) => x.runId === String(runId)),
    /** 줄에서 기다리는 작업 지우기(도는 중인 것은 끝까지 — 결과는 받는 쪽이 버린다). @returns {boolean} */
    cancel(runId) { const i = queue.findIndex((x) => x.runId === String(runId)); if (i < 0) return false; queue.splice(i, 1); return true; },
    state(runId) { const r = running.get(String(runId)); if (r) return { state: 'running', phase: r.phase, startedAt: r.startedAt }; const q = queue.findIndex((x) => x.runId === String(runId)); return q >= 0 ? { state: 'queued', position: q + 1 } : null; },
    list: () => [...[...running.values()].map((j) => ({ runId: j.runId, id: j.target.id, mode: j.mode, kind, state: 'running', phase: j.phase, startedAt: j.startedAt })), ...queue.map((j, i) => ({ runId: j.runId, id: j.target.id, mode: j.mode, state: 'queued', position: i + 1 }))],
    size: () => queue.length + running.size,
  });
}
