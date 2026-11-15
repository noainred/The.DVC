/**
 * focusmon/audit/service.js — 디스크 점검의 **중앙 쪽**(v3.11.0): 작업 접수 · 중앙 실행기 · 엣지 배달 · 결과 해석 · 준비 상태 · 최근 결과.
 *
 *  · 작업은 그 서버를 맡은 노드가 돈다 — 중앙 직접 수집 서버는 중앙 실행기(createAuditRunner · 동시 1), 엣지 몫은 동기화 응답 `audit.jobs` 로 배달하고
 *    엣지가 동기화 본문 `audit.results` 로 원문(준비 줄 · 실행 줄)을 올린다. 중앙이 **원문을 다시 해석**한다(parse.js — 엣지 해석값을 믿지 않는다).
 *  · 한도: 같은 서버 실행은 `RUN_GAP_MS`(10분)에 한 번(실제로 실행된 때 기준) · 준비 확인은 `CHECK_GAP_MS`(60초)에 한 번 · 한 서버에 작업 하나.
 *  · 시한: 엣지가 받아 가지 않은 작업 `DELIVER_TTL_MS`(30분) · 엣지가 진행 목록(active)에 `SEEN_TTL_MS`(10분) 넘게 싣지 않은 작업 · 실행 중으로 실행 시한 + 10분 ·
 *    요청부터 `JOB_MAX_MS`(12시간) → 'lost'(결과 없음 — 까닭을 단정하지 않는다). 엣지 줄에서 차례를 기다리는 작업은 엣지가 보고하는 동안 지우지 않는다(반증 F3).
 *    'lost' 로 지운 작업은 `LOST_KEEP_MS`(2시간) 기억해 그사이 온 결과를 반영한다(늦게 온 결과를 버리지 않는다 — 엣지 보관 시한 1시간보다 길게).
 *  · 접속처(주소 · 포트 · 계정 · 담당 노드)가 바뀌면 작업 · 준비 상태를 지운다(`forgetReadiness`) — 진행 중이던 결과는 반영하지 않고, DB 회차에는 접속처 지문(`ep`)을 남겨
 *    화면이 지금 접속처의 회차만 '최근 결과' 로 쓴다(예전 주소의 결과가 새 주소의 서버에 붙지 않게 · 반증 F7).
 *  · 상태 파일 `focusmon-audit.json`(준비 상태 · 진행 중 작업 — 비밀 없음 · 원자 쓰기 · 손상 보존). 결과는 DB `fm_audit`(최근 10회 · 90일 · 원문 gzip).
 *  · 숫자는 보고서의 **줄 수**다(장애 횟수 아님) · 끝까지 돌지 않은 실행(시한 · 중단 · 오류)은 숫자를 합계처럼 쓰지 않는다(outcome ≠ 'done').
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../../util/atomicWrite.js';
import { registerStateFile } from '../../util/stateFiles.js';
import * as db from '../db.js';
import { createAuditRunner } from './runner.js';
import { parseReady, readyState, splitRun, parseReport, parseDisks, summarize, evidenceKey, cleanLine } from './parse.js';
import { PROGRAM_PATH, WRAPPER_PATH, programSha, wrapperSha, AUDIT_DEADLINE_MS } from './bundle.js';

const gzipAsync = promisify(zlib.gzip);
export const RUN_GAP_MS = 10 * 60_000;
export const CHECK_GAP_MS = 60_000;
export const DELIVER_TTL_MS = 30 * 60_000;
export const LOST_AFTER_MS = AUDIT_DEADLINE_MS + 10 * 60_000;
export const SEEN_TTL_MS = 10 * 60_000;
export const JOB_MAX_MS = 12 * 3600_000;
export const LOST_KEEP_MS = 2 * 3600_000;
const LOST_MAX = 300;
/** 엣지 진행 목록 받기 상한 — 엣지 대기열(runner QUEUE_MAX 200) + 보낼 결과보다 크게. */
const ACTIVE_MAX = 250;
export const REDELIVER_MS = 2 * 60_000;
export const MAX_DELIVER = 3;
export const MAX_JOBS = 500;
export const RESULTS_PER_SYNC = 2;
/** 화면에 싣는 한도(박지 않는다 — 응답 limits). */
export const LIMITS = Object.freeze({ runGapMin: RUN_GAP_MS / 60_000, checkGapSec: CHECK_GAP_MS / 1000, nodeConcurrency: 1, deadlineMin: Math.round(AUDIT_DEADLINE_MS / 60_000), keepRuns: db.AUDIT_KEEP, keepDays: db.AUDIT_KEEP_DAYS });

export const OUTCOMES = Object.freeze(['done', 'timeout', 'program-timeout', 'program-error', 'incomplete', 'cut', 'report-shape', 'no-start', 'sudo-denied', 'sudo-tty', 'wrapper-nopython', 'wrapper-args', 'wrapper-busy', 'wrapper-tmp', 'wrapper-nonce', 'wrapper-other']);
export const KINDS = Object.freeze(['done', 'not-ready', 'no-key', 'auth', 'auth-stopped', 'hostkey', 'unreachable', 'timeout', 'bad-output', 'busy', 'queue-full', 'too-big']);
export const READY_STATES = Object.freeze(['ready', 'nopy', 'pyold', 'notinstalled', 'unreadable', 'version', 'owner', 'nosudo', 'bad-output']);

const FILE_NAME = registerStateFile('focusmon-audit.json');
const file = () => path.join(config.configDir, FILE_NAME);
let S = null; // { ready: {tid: rec}, jobs: [job], lost: {runId: job} }
let loadErr = '';
function load() {
  if (S) return S;
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    const ready = j && typeof j.ready === 'object' && !Array.isArray(j.ready) ? j.ready : {};
    S = { ready: Object.create(null), jobs: [], lost: Object.create(null) };
    for (const [k, v] of Object.entries(ready).slice(0, 2000)) if (/^fm-[a-z0-9-]{4,40}$/.test(k) && v && typeof v === 'object') S.ready[k] = v;
    S.jobs = (Array.isArray(j?.jobs) ? j.jobs : []).filter((x) => x && typeof x.runId === 'string' && typeof x.tid === 'string').slice(0, MAX_JOBS);
    const lost = j && typeof j.lost === 'object' && !Array.isArray(j.lost) ? j.lost : {};
    for (const [k, v] of Object.entries(lost).slice(0, LOST_MAX)) if (/^da-[0-9a-f]{12}$/.test(k) && v && typeof v.tid === 'string' && v.node) S.lost[k] = v;
    // 이 프로세스에서 처음 읽은 때 남아 있는 중앙 작업은 앞 프로세스의 것 — 끝을 알 수 없으므로 'lost' 로 남긴다(엣지 작업은 그대로 기다린다).
    //   startAuditService 에서 하면 기동 직후(폴러 순차 기동 최대 1분) 사용자가 건 작업까지 지웠다.
    const stale = S.jobs.filter((x) => !x.node);
    for (const x of stale) { const rec = S.ready[x.tid] || {}; rec.lastError = { at: Date.now(), kind: 'lost', error: '포탈이 다시 시작돼 진행 중이던 점검의 결과를 받지 못했습니다.' }; S.ready[x.tid] = rec; }
    if (stale.length) { S.jobs = S.jobs.filter((x) => x.node); persist(); }
  } catch (e) {
    if (e?.code !== 'ENOENT') { try { preserveCorrupt(file()); } catch { /* */ } loadErr = String(e?.message || e).slice(0, 160); }
    S = { ready: Object.create(null), jobs: [], lost: Object.create(null) };
  }
  return S;
}
function persist() { try { atomicWriteFileSync(file(), JSON.stringify({ v: 1, ready: load().ready, jobs: load().jobs, lost: load().lost })); } catch (e) { console.warn('[focusmon-audit] 상태 파일을 쓰지 못했습니다:', String(e?.message || e).slice(0, 160)); } }
export function auditStateError() { load(); return loadErr; }

const newRunId = () => `da-${crypto.randomBytes(6).toString('hex')}`;
const hash12 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
/** 접속처 지문 — 담당 노드(소문자) · 주소 · 포트 · 계정. 같은 사설 IP 가 법인마다 다른 서버일 수 있어 노드를 넣는다. */
export function endpointKey(t) { return hash12(`${String(t?.agent || '').toLowerCase()}|${String(t?.host || '')}|${Number(t?.port) || 22}|${String(t?.username || '')}`); }
/** 작업이 아직 살아 있는가(진행 중 목록 또는 'lost' 기억) — 접속처가 바뀌어 지운 작업의 결과는 반영하지 않는다. */
const liveJob = (runId) => load().jobs.find((x) => x.runId === runId) || load().lost[runId] || null;

/* ── 결과 정리 · 해석 ───────────────────────────────────────────────────── */
/**
 * 실행 결과의 끝 상태(판정 코어 — 화면 문구 키). 'done' 만 숫자를 합계로 쓴다.
 * @param {ReturnType<typeof splitRun>} sp  @param {{kind:string, stderr?:string}} r  @param {{complete:boolean}} rep
 */
export function runOutcome(sp, r, rep) {
  if (r.kind === 'timeout') return 'timeout';
  // 실행 파일의 오류 표지는 BEGIN 보다 먼저(첫 줄) 나온다 — begun 보다 먼저 본다(반증 F6)
  if (sp.err) return OUTCOMES.includes(`wrapper-${sp.err}`) ? `wrapper-${sp.err}` : 'wrapper-other';
  if (!sp.begun) {
    const e = String(r.stderr || '');
    if (/password is required|not allowed to execute|may not run sudo/i.test(e)) return 'sudo-denied';
    if (/must have a tty/i.test(e)) return 'sudo-tty';
    return 'no-start';
  }
  if (sp.rc == null || !sp.ended) return 'cut';
  if (sp.rc === 137) return 'program-timeout';
  if (sp.rc !== 0) return 'program-error';
  if (!rep.complete) return 'incomplete';
  // 보고서 모양이 프로그램의 것이 아니다(로그에서 온 줄이 보고서 줄처럼 보인다) — 숫자를 합계로 쓰지 않는다
  if (rep.shape && rep.shape.length) return 'report-shape';
  return 'done';
}

/** 한 결과 해석(순수에 가깝다 — DB 이전 회차의 근거 열쇠를 받는다). */
export function analyzeRun(result, { prevKeys = null } = {}) {
  const sp = splitRun(result.out || []);
  const rep = parseReport(sp.report);
  const disks = parseDisks(sp.lsblk, sp.raid);
  const sum = summarize(rep, disks);
  const outcome = runOutcome(sp, result, rep);
  const ek = rep.evidence.map((e) => hash12(evidenceKey(e)));
  const newN = prevKeys ? ek.filter((k) => !prevKeys.has(k)).length : null;
  // 시작하지 못한 실행은 까닭을 표준 오류 첫 줄로 남긴다(sudo · 실행 파일 — 대상 서버의 글이라 정리 · 상한)
  const errLine = !sp.begun ? cleanLine(String(result.stderr || '').split('\n').find((x) => x.trim()) || '', 200) : '';
  return { outcome, rc: sp.rc, begun: sp.begun, summary: { ...sum, ek: ek.slice(0, 2000), newN, truncated: !!result.truncated, outBytes: result.outBytes || 0, osDisks: disks.filter((d) => d.src === 'os').length, ...(errLine ? { stderr: errLine } : {}) } };
}

/** DB 기록을 멈출 만큼 여유 공간이 없는가(기록기 recorder 의 판정 — 10초마다 갱신). 기록기를 읽지 못하면 false. */
let spaceLow = () => false;
export function setSpaceProbe(fn) { if (typeof fn === 'function') spaceLow = fn; }

/** 중앙 상태에 결과 하나 반영(로컬 · 엣지 공통). 작업이 지워졌으면(접속처 변경 · 대상 삭제) 반영하지 않는다. */
export async function ingestResult(job, r, { node = '', now = Date.now() } = {}) {
  const st = load();
  const tid = job.tid;
  if (!liveJob(job.runId)) return { wrote: null, dropped: true };
  const rec = { ...(st.ready[tid] || {}) };
  const readyLines = Array.isArray(r.ready) ? r.ready : [];
  if (readyLines.length) {
    const rd = parseReady(readyLines);
    const rs = readyState(rd, { programPath: PROGRAM_PATH, wrapperPath: WRAPPER_PATH, programSha: programSha(), wrapperSha: wrapperSha() });
    Object.assign(rec, { at: now, state: rs.state, reason: rs.reason, dmi: rd.dmi, py: rd.pyVer ? rd.pyVer.join('.') : null, node });
  }
  rec.lastError = r.ok && (r.kind === 'done' || r.kind === 'not-ready') ? null : { at: now, kind: KINDS.includes(r.kind) ? r.kind : 'unreachable', error: cleanLine(r.error || '', 240) };
  let wrote = null;
  // 실행을 시도했으면 출력이 비어도 회차를 남긴다(반증 F4 — sudo 자체가 실패하면 표준 출력이 빈다)
  if (job.mode === 'run' && (r.ran === true || (Array.isArray(r.out) && r.out.length))) {
    let prev = null; try { prev = await db.latestAudit(tid); } catch { prev = null; }
    if (prev && prev.id === job.runId) prev = null; // 같은 결과가 두 번 반영되는 경우(ack 를 잃음) — 자기 자신을 '지난 회차' 로 쓰지 않는다
    const prevKeys = prev && prev.outcome === 'done' && Array.isArray(prev.summary?.ek) ? new Set(prev.summary.ek) : null;
    const out = Array.isArray(r.out) ? r.out : [];
    const a = analyzeRun({ ...r, out }, { prevKeys });
    if (a.begun) rec.lastExecAt = job.startedAt || now; // root 프로그램이 실제로 돌았을 때만 실행 간격을 센다
    let report = null; if (out.length) { try { report = await gzipAsync(Buffer.from(out.join('\n'), 'utf8')); } catch { report = null; } }
    const row = { id: job.runId, target: tid, at: job.startedAt || job.requestedAt || now, ended: now, node, by: job.by || '', outcome: a.outcome, rc: a.rc, ver: programSha()?.slice(0, 12) || '', summary: { ...a.summary, prevId: prev?.id || null, ms: Number.isFinite(r.ms) ? r.ms : null, ep: job.ep || null }, ready: readyLines.slice(0, 200), report };
    if (spaceLow()) rec.lastError = { at: now, kind: 'db', error: 'DB 폴더 여유 공간이 부족해 결과를 기록하지 않았습니다.' };
    else {
      const ok = await db.writeAudit(row, now);
      if (ok) { latest.set(tid, { id: row.id, target: tid, at: row.at, ended: row.ended, node, by: row.by, outcome: row.outcome, rc: row.rc, ver: row.ver, summary: row.summary }); wrote = row.id; }
      else rec.lastError = { at: now, kind: 'db', error: '결과를 DB 에 쓰지 못했습니다(기록 없이 끝남).' };
    }
  }
  // 기다리는 동안 접속처가 바뀌었거나 대상이 지워졌으면 준비 상태를 되살리지 않는다(회차는 접속처 지문 ep 로 화면이 거른다)
  if (liveJob(job.runId)) st.ready[tid] = rec;
  st.jobs = st.jobs.filter((x) => x.runId !== job.runId);
  delete st.lost[job.runId];
  persist();
  return { wrote };
}

/* ── 접수 ───────────────────────────────────────────────────────────────── */
let localRunner = null;
let keysRef = null;
/** 중앙 실행기 — 처음 쓸 때 만든다(엣지 노드에는 만들지 않는다 · 키는 service.js 의 focusKeys). */
function local() {
  if (!localRunner) {
    localRunner = createAuditRunner({
      keys: keysRef,
      onPhase: (job, phase) => { const j = load().jobs.find((x) => x.runId === job.runId); if (j) { j.phase = phase; j.state = 'running'; j.startedAt = j.startedAt || job.startedAt || Date.now(); } },
      onResult: (job, result) => {
        const j = liveJob(job.runId);
        if (!j) return; // 지운 작업(접속처 변경 · 대상 삭제)의 결과 — 반영하지 않는다
        ingestResult({ ...j, startedAt: j.startedAt || job.startedAt }, result, { node: '' }).catch((e) => console.warn('[focusmon-audit] 결과 반영 실패:', String(e?.message || e).slice(0, 160)));
      },
    });
  }
  return localRunner;
}
/** 시작 — 키 저장소를 넘기고 상태 파일을 읽는다(앞 프로세스의 중앙 작업 정리는 load 가 처음 읽을 때 한다). */
export function startAuditService({ keys, spaceLow: probe } = {}) {
  keysRef = keys || keysRef;
  if (probe) setSpaceProbe(probe); // 기록기(recorder)의 여유 공간 판정을 같이 쓴다(반증 F9-b — 지표 기록이 멈출 때 점검 결과도 쓰지 않는다)
  load();
}

/**
 * 점검 · 준비 확인 요청.
 * @param {{id:string, host:string, port:number, username:string, agent?:string, demo?:boolean}} t
 * @returns {{ok:true, runId:string, via:'central'|'edge'} | {ok:false, code:string, reason:string, waitSec?:number}}
 */
export function requestAudit(t, { mode = 'run', by = '', now = Date.now(), keys = null } = {}) {
  // 기동 직후(폴러 순차 기동 — 최대 1분)에는 startAuditService 가 아직 돌지 않았을 수 있다 — 라우트가 키 저장소를 함께 준다
  if (!keysRef && keys) keysRef = keys;
  const st = load();
  const m = mode === 'check' ? 'check' : 'run';
  sweep(now);
  if (st.jobs.some((x) => x.tid === t.id)) return { ok: false, code: 'busy', reason: '이 서버는 이미 점검 · 확인 작업이 진행 중이거나 차례를 기다리고 있습니다.' };
  if (st.jobs.length >= MAX_JOBS) return { ok: false, code: 'queue-full', reason: '대기 중인 작업이 너무 많습니다 — 잠시 뒤 다시 누르세요.' };
  const rec = st.ready[t.id] || {};
  if (m === 'run' && rec.lastExecAt && now - rec.lastExecAt < RUN_GAP_MS) {
    const waitSec = Math.ceil((RUN_GAP_MS - (now - rec.lastExecAt)) / 1000);
    return { ok: false, code: 'too-soon', waitSec, reason: `같은 서버는 ${RUN_GAP_MS / 60_000}분에 한 번만 점검합니다(${Math.ceil(waitSec / 60)}분 뒤).` };
  }
  if (m === 'check' && rec.at && now - rec.at < CHECK_GAP_MS) {
    const waitSec = Math.ceil((CHECK_GAP_MS - (now - rec.at)) / 1000);
    return { ok: false, code: 'too-soon', waitSec, reason: `준비 확인은 ${CHECK_GAP_MS / 1000}초에 한 번입니다(${waitSec}초 뒤).` };
  }
  const job = { runId: newRunId(), tid: t.id, mode: m, node: t.demo ? '' : String(t.agent || ''), by: String(by || '').slice(0, 64), requestedAt: now, state: 'queued', phase: null, deliveredAt: null, deliveries: 0, startedAt: null, seenAt: null, ep: endpointKey(t) };
  st.jobs.push(job);
  persist();
  if (!job.node) {
    if (!keysRef) { st.jobs = st.jobs.filter((x) => x.runId !== job.runId); persist(); return { ok: false, code: 'not-started', reason: '디스크 점검 실행기가 아직 준비되지 않았습니다 — 잠시 뒤 다시 누르세요.' }; }
    const s = local().submit({ runId: job.runId, mode: m, target: { id: t.id, host: t.host, port: t.port, username: t.username, demo: !!t.demo } });
    if (!s.ok) { st.jobs = st.jobs.filter((x) => x.runId !== job.runId); persist(); return { ok: false, code: s.code, reason: s.code === 'busy' ? '이 서버의 점검이 이미 실행기 줄에 있습니다.' : '실행기 줄이 가득 찼습니다.' }; }
  }
  return { ok: true, runId: job.runId, via: job.node ? 'edge' : 'central' };
}

/**
 * 시한이 지난 작업 정리(받아 가지 않음 · 엣지가 더 보고하지 않음 · 결과 없음). 판정 코어 — 테스트가 시각을 넣어 고정한다.
 * 엣지 작업은 엣지가 진행 목록에 싣는 동안(seenAt) 지우지 않는다 — 노드 동시 1 이라 앞 작업만큼 기다린다.
 */
export function jobExpired(j, now) {
  if (j.state === 'ingesting') return false;
  if (now - j.requestedAt > JOB_MAX_MS) return true;
  if (!j.node) return now - j.requestedAt > LOST_AFTER_MS + 60 * 60_000; // 중앙 줄: 동시 1이라 앞 작업만큼 기다린다 — 넉넉히
  if (!j.deliveredAt) return now - j.requestedAt > DELIVER_TTL_MS;
  const seen = Math.max(j.deliveredAt || 0, j.seenAt || 0);
  if (now - seen > SEEN_TTL_MS) return true;
  if (j.state === 'running' && j.startedAt && now - j.startedAt > LOST_AFTER_MS) return true;
  return j.deliveries >= MAX_DELIVER && now - seen > REDELIVER_MS * 2;
}
export function sweep(now = Date.now()) {
  const st = load(); let changed = false;
  st.jobs = st.jobs.filter((j) => {
    if (!jobExpired(j, now)) return true;
    const rec = st.ready[j.tid] || {};
    rec.lastError = { at: now, kind: 'lost', error: j.node && !j.deliveredAt ? `엣지 ${j.node} 가 ${DELIVER_TTL_MS / 60_000}분 안에 작업을 받아 가지 않았습니다.` : '시한 안에 결과를 받지 못했습니다(늦게 오면 그때 반영합니다).' };
    st.ready[j.tid] = rec; changed = true;
    st.lost[j.runId] = { runId: j.runId, tid: j.tid, mode: j.mode, node: j.node || '-', by: j.by || '', requestedAt: j.requestedAt, startedAt: j.startedAt || null, ep: j.ep || null, lostAt: now };
    return false;
  });
  const lostIds = Object.keys(st.lost);
  for (const k of lostIds) if (now - (st.lost[k].lostAt || 0) > LOST_KEEP_MS) { delete st.lost[k]; changed = true; }
  const keep = Object.keys(st.lost);
  if (keep.length > LOST_MAX) { for (const k of keep.sort((a, b) => st.lost[a].lostAt - st.lost[b].lostAt).slice(0, keep.length - LOST_MAX)) delete st.lost[k]; changed = true; }
  if (changed) persist();
}

/* ── 엣지 ───────────────────────────────────────────────────────────────── */
const ACTIVE_STATES = new Set(['queued', 'running']);
/**
 * 엣지 동기화 한 번의 디스크 점검 부분 — 진행 상태 · 결과를 받고, 내려보낼 작업을 고른다.
 * @param {string} agent  인증된 엣지 이름(소문자 비교)
 * @param {Map<string, object>} mine  그 엣지가 맡은 대상(id → 대상)
 * @param {object} a  본문 audit(정제 전)
 * 동기 함수다(동기화 처리 handleEdgeSync 가 동기) — 결과 반영(DB 쓰기)은 뒤에서 이어 돈다(실패는 그 서버의 lastError 로 남긴다).
 * @returns {{jobs:object[], ack:string[]}}
 */
export function handleEdgeAudit(agent, mine, a, now = Date.now()) {
  sweep(now); // 시한 정리(바뀐 때만 쓴다)
  const st = load();
  const key = String(agent || '').toLowerCase();
  const ack = []; const cancel = []; let changed = false;
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  const b = isObj(a) ? a : {};
  const active = new Set();
  const lostOf = (runId) => { const l = st.lost[runId]; return l && String(l.node).toLowerCase() === key ? l : null; };
  for (const x of Array.isArray(b.active) ? b.active.slice(0, ACTIVE_MAX) : []) {
    if (!isObj(x) || typeof x.runId !== 'string' || x.runId.length > 40) continue;
    const j = st.jobs.find((y) => y.runId === x.runId && String(y.node).toLowerCase() === key);
    if (!j) { if (!lostOf(x.runId) && cancel.length < 50) cancel.push(x.runId); continue; } // 중앙이 모르는 작업(지움 · 접속처 변경) — 줄에서 빼라고 알린다
    active.add(j.runId);
    j.seenAt = now; // 엣지가 아직 들고 있다 — 시한은 마지막으로 본 때부터(상태 파일에는 바뀐 때만 쓴다)
    const st2 = ACTIVE_STATES.has(x.state) ? x.state : j.state;
    const ph = typeof x.phase === 'string' ? cleanLine(x.phase, 40) : j.phase;
    if (st2 !== j.state || ph !== j.phase) { j.state = st2; j.phase = ph; changed = true; }
    if (j.state === 'running' && !j.startedAt) { j.startedAt = now; changed = true; }
  }
  for (const x of Array.isArray(b.results) ? b.results.slice(0, RESULTS_PER_SYNC) : []) {
    if (!isObj(x) || typeof x.runId !== 'string' || x.runId.length > 40) continue;
    ack.push(x.runId); // 모르는 작업의 결과도 받았다고 알린다 — 엣지가 끝없이 다시 보내지 않게(반영은 하지 않는다)
    const j = st.jobs.find((y) => y.runId === x.runId && String(y.node).toLowerCase() === key) || lostOf(x.runId);
    if (!j || !mine.has(j.tid) || j.state === 'ingesting') continue; // 반영 중인 것을 다시 받지 않는다(ack 를 잃고 다시 온 같은 결과)
    const r = cleanEdgeResult(x.result);
    if (!r) continue;
    j.state = 'ingesting'; changed = true;
    ingestResult(j, r, { node: String(j.node), now }).catch((e) => {
      const rec = load().ready[j.tid] || {}; rec.lastError = { at: now, kind: 'db', error: `결과를 반영하지 못했습니다: ${String(e?.message || e).slice(0, 160)}` }; load().ready[j.tid] = rec;
      load().jobs = load().jobs.filter((y) => y.runId !== j.runId); delete load().lost[j.runId]; persist();
    });
  }
  // 내려보낼 작업: 아직 안 보낸 것 · 보냈는데 엣지 목록에 없고 결과도 없이 2분이 지난 것(엣지 재시작) — 최대 3번
  const jobs = [];
  for (const j of st.jobs) {
    if (String(j.node).toLowerCase() !== key || !mine.has(j.tid) || active.has(j.runId) || j.state === 'ingesting') continue;
    if (j.deliveredAt && (now - j.deliveredAt < REDELIVER_MS || j.deliveries >= MAX_DELIVER)) continue;
    const t = mine.get(j.tid);
    j.deliveredAt = now; j.deliveries = (j.deliveries || 0) + 1; changed = true;
    jobs.push({ runId: j.runId, mode: j.mode, id: t.id, host: t.host, port: t.port, username: t.username, expect: { program: programSha(), wrapper: wrapperSha() } });
    if (jobs.length >= 20) break;
  }
  // 상태가 실제로 바뀐 때만 쓴다(반증 F8 — 엣지는 작업이 있는 동안 2초마다 동기화한다 · 원자 쓰기는 fsync 둘)
  if (changed) persist();
  return { jobs, ack, cancel };
}

const LINE_CAP = 8200;
/** 엣지가 올린 결과 정제 — 아는 칸만 · 글자 배열 · 상한(줄 수 · 줄 길이 · 전체 바이트). 해석은 중앙이 원문으로 다시 한다. */
export function cleanEdgeResult(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const lines = (v, maxN, maxLen, maxBytes) => {
    if (!Array.isArray(v)) return [];
    const out = []; let bytes = 0;
    for (const l of v.slice(0, maxN)) { if (typeof l !== 'string') continue; const s = l.length > maxLen ? `${l.slice(0, maxLen)}…(잘림)` : l; bytes += Buffer.byteLength(s) + 1; if (bytes > maxBytes) break; out.push(s); }
    return out;
  };
  const kind = KINDS.includes(x.kind) ? x.kind : 'unreachable';
  const code = Number.isInteger(x.code) && x.code >= 0 && x.code < 512 ? x.code : null;
  return {
    mode: x.mode === 'check' ? 'check' : 'run', ok: x.ok === true, ran: x.ran === true, kind, error: typeof x.error === 'string' ? cleanLine(x.error, 240) : '',
    ready: lines(x.ready, 200, 400, 64 * 1024), out: lines(x.out, 80_000, LINE_CAP, 5 * 1024 * 1024),
    outBytes: Number.isFinite(x.outBytes) && x.outBytes >= 0 ? Math.min(x.outBytes, 1e10) : 0, truncated: x.truncated === true, code,
    stderr: typeof x.stderr === 'string' ? x.stderr.slice(0, 4096) : '', ms: Number.isFinite(x.ms) && x.ms >= 0 ? Math.min(x.ms, 4 * 3600_000) : 0,
  };
}

/* ── 조회 ───────────────────────────────────────────────────────────────── */
const latest = new Map(); // tid → 최근 회차(원문 없이) — DB 를 처음 물을 때 채운다
/** 대상들의 최근 회차 — 캐시에 없으면 대상마다 한 번 DB(인덱스). DB 가 없으면 빈 지도. */
export async function latestFor(ids = []) {
  const out = new Map();
  let dbOk = null;
  for (const id of ids) {
    if (latest.has(id)) { out.set(id, latest.get(id)); continue; }
    if (dbOk == null) { try { dbOk = await db.available(); } catch { dbOk = false; } }
    if (!dbOk) { out.set(id, null); continue; } // DB 를 못 열었으면 캐시하지 않는다(반증 F9-a — 다음 요청에 열리면 그때 읽는다)
    let r = null; let ok = true; try { r = await db.latestAudit(id); } catch { r = null; ok = false; }
    if (ok) latest.set(id, r);
    out.set(id, r);
  }
  return out;
}
export function readinessOf(tid) { const r = load().ready[tid]; return r ? { ...r } : null; }
export function jobOf(tid) {
  const j = load().jobs.find((x) => x.tid === tid);
  if (!j) return null;
  const lr = !j.node && localRunner ? localRunner.state(j.runId) : null;
  return { runId: j.runId, mode: j.mode, node: j.node, state: lr?.state || j.state || 'queued', phase: lr?.phase || j.phase || null, position: lr?.position || null, requestedAt: j.requestedAt, startedAt: lr?.startedAt || j.startedAt || null, delivered: !!j.deliveredAt };
}
export function activeJobs() { return load().jobs.map((j) => jobOf(j.tid)).filter(Boolean); }
const dropJobsOf = (st, tid) => {
  const gone = st.jobs.filter((x) => x.tid === tid);
  for (const j of gone) if (!j.node && localRunner) localRunner.cancel(j.runId);
  st.jobs = st.jobs.filter((x) => x.tid !== tid);
  for (const [k, v] of Object.entries(st.lost)) if (v.tid === tid) delete st.lost[k];
  return gone.length;
};
/** 대상이 지워지면 준비 상태 · 작업 · 캐시를 지운다(결과 기록은 DB 의 보관 규칙대로 남는다). */
export function forgetTarget(tid) { const st = load(); delete st.ready[tid]; dropJobsOf(st, tid); latest.delete(tid); persist(); }
/**
 * 접속처(주소 · 포트 · 계정 · 담당 노드)가 바뀌면 준비 상태 · 진행 중 작업 · 'lost' 기억을 지운다(예전 주소의 것 — 반증 F7). 진행 중이던 결과는 반영하지 않는다.
 * 실행 간격(lastExecAt)은 남긴다(같은 서버를 곧바로 다시 돌리지 않게). 화면의 '최근 결과' 는 회차의 접속처 지문(ep)으로 거른다.
 */
export function forgetReadiness(tid) {
  const st = load(); const r = st.ready[tid];
  const n = dropJobsOf(st, tid);
  if (!r && !n) return;
  if (r) st.ready[tid] = { lastExecAt: r.lastExecAt || null };
  latest.delete(tid);
  persist();
}

export function _resetForTest() { S = null; loadErr = ''; latest.clear(); localRunner = null; keysRef = null; spaceLow = () => false; }
