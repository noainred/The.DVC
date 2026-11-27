/**
 * servercmd/service.js — 기능 ‘서버 명령 실행’(v3.30 · 설계 docs/design/server-cmd ① · ③ · D1 · D6 · D10 · D12).
 *
 * 하는 일: 등록된 서버(bm-storage 등록부 — 서버 정보 · 서버 접속과 같은 목록)에 **정해 둔 확인 명령(프리셋)** 을 사람이 누를 때만 돌리고 출력을 보여 준다.
 *  · 접속 · 계정 · 비밀 · 엣지 · 수집 끔 판정은 코어(`sshaccess/readServer.js`), 여러 대 · 동시성 · 진행은 일괄 틀(`sshaccess/batch.js`) — 이 모듈은 프리셋 → 계획 · 출력 보관만.
 *  · **출력은 메모리에만**(D6): 마지막 실행 한 건 · 끝나고 30분 뒤 지운다 · 재시작하면 사라진다 · 파일 · 백업 · 엣지 push · 감사에 싣지 않는다.
 *  · 출력 원문은 다듬어(`presets.cleanOutput`) 둔다 — 터미널 제어 순서 · 제어문자를 걷고 줄 수 상한. 출력 속 비밀을 가리지는 못한다(목록에서 그런 명령을 뺐다).
 *  · 엣지가 수집하는 서버는 중앙이 붙지 않는다(코어 `edge-delegated` — 그 엣지 포탈의 같은 화면 · D10).
 *  · 데모(mock) 서버(mock- id)는 합성 출력(데모 화면이 비지 않게) — 사람이 등록한 서버는 mock 모드에서도 실제로 붙는다(서버 정보와 같은 규칙).
 */
import { listBmServersRaw, registryLoadError } from '../bmstor/registry.js';
import { effectiveAccountOf } from '../bmusage/onboard/refs.js';
import { readServer, READ_DEADLINE_MS } from '../sshaccess/readServer.js';
import { createServerBatch } from '../sshaccess/batch.js';
import { isMockMode, isDemoId } from '../mock/demo/storage.js';
import * as P from './presets.js';

export const FEATURE = P.FEATURE;
export const RUN_BATCH_MAX = 50;
export const RUN_CONCURRENCY = 4;
/** 출력 보관 시간(끝난 뒤) — 지나면 지운다(D6). */
export const RESULT_TTL_MS = 30 * 60 * 1000;
/** 표의 ‘출력 첫 줄’ 글자 상한. */
const FIRST_LINE_MAX = 200;
const t = (v, n = 256) => String(v ?? '').trim().slice(0, n);

const BATCH = createServerBatch({ max: RUN_BATCH_MAX, concurrency: RUN_CONCURRENCY, text: {
  busy: '다른 실행이 진행 중입니다', tooMany: `한 번에 ${RUN_BATCH_MAX}대까지 실행합니다.`, registry: 'OS 계정 등록부(bm-storage.json)를 읽지 못해 실행하지 않았습니다.' } });

/** 마지막 실행(하나) — { seq, preset, label, params, by, startedAt, finishedAt, total, rows:Map(serverId → 행) } · 없으면 null. */
let last = null;
let seq = 0;
let ttlTimer = null;
function dropIfOld(now = Date.now()) {
  if (last?.finishedAt && now - last.finishedAt >= RESULT_TTL_MS) last = null;
}

/** 화면에 보이는 마지막 실행(출력 원문 없이 — 첫 줄 · 줄 수만). */
function lastView() {
  dropIfOld();
  if (!last) return null;
  const rows = [...last.rows.values()].map(({ out, err, ...r }) => r);
  return { runKey: last.key, preset: last.preset, label: last.label, params: { ...last.params }, by: last.by, startedAt: last.startedAt, finishedAt: last.finishedAt || null, total: last.total,
    expiresAt: last.finishedAt ? last.finishedAt + RESULT_TTL_MS : null, rows };
}

/** 화면 한 번에 필요한 것(비밀 · 출력 원문 없음). */
export function buildView() {
  if (registryLoadError()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'OS 계정 등록부(bm-storage.json)를 읽지 못했습니다.' };
  const servers = listBmServersRaw().map((s) => {
    const ef = effectiveAccountOf(s);
    return {
      id: s.id, name: s.name || s.host, host: s.host, port: Number(s.port) || 22, corp: t(s.vcenterId, 128), os: s.os === 'windows' ? 'windows' : (s.os === 'linux' ? 'linux' : ''),
      agent: t(s.agent, 64), enabled: s.enabled !== false, demo: isDemoId(s.id), running: BATCH.has(s.id),
      account: { source: ef.source, pending: !!ef.pending, unreadable: !!ef.unreadable, ...(ef.via === 'winrm' ? { via: 'winrm' } : {}) },
    };
  });
  return { ok: true, servers, presets: P.catalog(), groups: P.GROUPS,
    limits: { batch: RUN_BATCH_MAX, concurrency: RUN_CONCURRENCY, ttlMin: Math.round(RESULT_TTL_MS / 60000), maxLines: P.MAX_LINES, maxBytes: P.MAX_BYTES,
      winrmS: Math.round((READ_DEADLINE_MS - 2000) / 1000) },   // WinRM 은 스크립트 안 시한이 없어 서버 한 대 시한(readServer runWinrm)까지 기다린다
    job: BATCH.view(), last: lastView() };
}

/**
 * 마지막 실행의 출력(한 대 또는 전부) — 화면 ‘펼치기’ · ‘전체 복사’.
 * runKey — 화면이 본 실행(반증 F2: 그 사이 다른 관리자가 새로 실행하면 지난 표 아래에 새 실행의 출력이 붙었다). 다르면 409 · 지워졌으면 404(빈 200 이 아니다).
 */
export function outputs(id = '', runKey = '') {
  dropIfOld();
  const want = t(id, 64); const rk = t(runKey, 64);
  if (!last) return (want || rk) ? { ok: false, code: 'gone', status: 404, reason: '그 실행의 출력은 지워졌습니다(끝나고 30분 · 재시작) — 다시 실행하세요.' } : { ok: true, rows: [] };
  if (rk && rk !== last.key) return { ok: false, code: 'run-changed', status: 409, reason: '그 사이 새 실행이 있어 그 출력은 지워졌습니다 — 화면을 다시 읽으세요.' };
  // 점검 1회차 W2: 실행하지 못한 서버(접속 실패 · 로그인 거부 · 정지)는 출력이 없다 — 전체 복사 · 모두 펼치기에 ‘(출력 없음)’ 으로 섞지 않는다.
  const rows = [...last.rows.values()].filter((r) => r.ran && (!want || r.id === want)).map((r) => ({ id: r.id, name: r.name, ran: true, code: r.code, exit: r.exit, out: r.out || '', err: r.err || '', cut: !!r.cut }));   // 2회차 L2: ran — 화면 ‘끝 코드 모름’ 판정이 쓴다
  if (want && !rows.length) return { ok: false, code: 'not-found', status: 404, reason: '그 서버의 출력이 없습니다(실행하지 않았거나 아직 끝나지 않음).' };
  return { ok: true, runKey: last.key, preset: last.preset, label: last.label, rows };
}
/** 첫 줄 — 빈 줄은 건너뛴다(PowerShell 표는 빈 줄로 시작한다 — 반증 F7). */
function firstLine(...texts) {
  for (const x of texts) for (const l of String(x || '').split('\n', 50)) if (l.trim()) return l.slice(0, FIRST_LINE_MAX);
  return '';
}

/**
 * 코어 결과 → 보관 행(비밀 없음 · 출력은 다듬어서).
 * Linux 끝 코드는 문장마다의 표지(presets.rcOf — 반증 F3)에서: 표지가 문장 수와 맞지 않으면 모름(null — 셸의 끝 코드는 표지를 쓴 printf 의 것이다) ·
 * 어느 문장이 timeout 에 끊겼으면(124) 받은 만큼(partial — ‘시한’). Windows 는 스크립트가 정한 끝 코드(presets.windowsScript).
 */
function rowOf(s, r, at, { stmts = 1, timeoutS = 0 } = {}) {
  const base = { id: s.id, name: s.name || s.host, at, os: r.os || '', via: r.via || '', auth: r.auth || null, ms: r.ms ?? null };
  if (!r.ok && !r.partial) return { ...base, ok: false, ran: false, code: r.code || 'error', credCode: r.credCode || '', reason: t(r.reason, 300), exit: null, first: '', lines: 0, out: '', err: '', cut: false };
  const o = P.cleanOutput(r.stdout);
  let exit = Number.isInteger(r.exit) ? r.exit : null;
  let errRaw = r.stderr;
  let partial = !!r.partial; let code = r.code || 'ok'; let reason = r.partial ? t(r.reason, 300) : '';
  if (r.os !== 'windows') {
    const rc = P.rcOf(r.stderr, stmts);
    errRaw = rc.stderr;
    exit = rc.known ? rc.exit : null;
    if (rc.timedOut && !partial) { partial = true; code = 'exec-timeout'; reason = `명령이 시한(${timeoutS}초)에 걸려 끊겼습니다 — 받은 만큼만 보입니다.`; }
  }
  const e = P.cleanOutput(errRaw, { maxLines: 40 });
  // 로그인하고 명령을 돌렸다(ran) — 끝 코드가 0 이 아니어도 실패로 치지 않는다(출력과 끝 코드를 그대로). 시한 · 상한이면 받은 만큼(partial).
  return { ...base, ok: !partial, ran: true, partial, code, reason, exit, first: firstLine(o.text, e.text), lines: o.lines, out: o.text, err: e.text, cut: o.cut || code === 'exec-truncated' };
}

/** 데모 서버 합성 출력(가상값 — 실제로 붙지 않는다). */
function demoRow(s, preset, at) {
  const text = `(데모 서버 — 실제로 실행하지 않았습니다)\n${preset.label}\n${s.name || s.host}: 그림용 가상 출력`;
  return { id: s.id, name: s.name || s.host, at, os: s.os === 'windows' ? 'windows' : 'linux', via: 'ssh', auth: null, ms: 0, ok: true, ran: true, partial: false, code: 'ok', reason: '', exit: 0,
    first: text.split('\n', 1)[0], lines: text.split('\n').length, out: text, err: '', cut: false, demo: true };
}

/**
 * 고른 서버에 프리셋 실행(사람이 누름) — **시작만 하고 돌려준다**(`done` 은 끝나는 Promise — 라우트는 기다리지 않는다 · 시험이 기다린다).
 * 값 검사가 먼저(틀리면 아무 서버에도 붙지 않는다) · 일괄은 하나씩(진행 중 429) · 새 실행이 시작되면 지난 출력은 지운다(마지막 한 건 — D6).
 * @returns {{ok:true, started:true, total:number, done:Promise<object>} | {ok:false, code, status, reason}}
 */
export function startRun({ preset, params, ids } = {}, { by = '' } = {}) {
  const c = P.checkRequest(preset, params);
  if (!c.ok) return { ...c, status: 400 };
  const p = c.preset;
  const plan = P.planOf(p, c.params);
  // 이번 실행의 보관 칸 — 일괄이 시작되면 last 로 건다(일꾼은 이 칸에만 쓴다: 더 새 실행이 시작되면 이 칸은 버려진다)
  const run = { seq: seq + 1, key: `${seq + 1}-${Date.now().toString(36)}`, preset: p.id, label: p.label, params: { ...c.params }, by: t(by, 64), startedAt: Date.now(), finishedAt: 0, total: 0, rows: new Map() };
  const r = BATCH.start(ids, async (s, { credGate }) => {
    const at = Date.now();
    const row = isMockMode() && isDemoId(s.id) ? demoRow(s, p, at)
      : rowOf(s, await readServer(s.id, { feature: FEATURE, plan, by, trigger: 'manual', credGate }), at, { stmts: p.linux ? P.linuxStatements(p, c.params) : 1, timeoutS: p.linux?.timeoutS || 0 });
    run.rows.set(s.id, row);
    return { ok: row.ok, code: row.code, reason: row.reason };
  }, { by, meta: { preset: p.id, label: p.label } });
  if (!r.ok) return r;
  seq = run.seq;
  run.total = r.total;
  if (ttlTimer) { clearTimeout(ttlTimer); ttlTimer = null; }
  last = run;
  const done = r.done.then((d) => {
    run.finishedAt = Date.now();
    if (last === run) {
      ttlTimer = setTimeout(() => { if (last === run) last = null; ttlTimer = null; }, RESULT_TTL_MS);
      ttlTimer.unref?.();
    }
    if (!d.ok) return d;
    const rows = [...run.rows.values()];
    // 합은 화면과 같은 나눔(실행됨 · 시한/잘림 · 실행 못 함 — 겹치지 않게 · 반증 F13)
    return { ok: true, results: d.results, ran: rows.filter((x) => x.ran && !x.partial).length, partial: rows.filter((x) => x.ran && x.partial).length,
      failed: rows.filter((x) => !x.ran).length, nonZero: rows.filter((x) => x.ran && x.exit != null && x.exit !== 0).length };
  });
  return { ok: true, started: true, total: r.total, preset: p.id, done };
}

/** 시험 · 내부용 — 끝날 때까지 기다린 결과. */
export async function runMany(req, o) {
  const r = startRun(req, o);
  return r.ok ? r.done : r;
}
/** 시험 전용 — 마지막 실행을 지운다 · 끝난 시각을 옮긴다(TTL 시험). */
export function _resetServerCmdForTest({ finishedAgoMs = null } = {}) {
  if (finishedAgoMs == null) { last = null; return; }
  if (last) last.finishedAt = Date.now() - finishedAgoMs;
}
