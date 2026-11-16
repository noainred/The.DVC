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
import { programSha, wrapperSha, AUDIT_DEADLINE_MS, pathsFor, dirIssue, dirsToCheck, INSTALL_FAILS } from './bundle.js';
import { installDir } from './settings.js'; // v3.17.0 설치 디렉터리
import { installExec, NODE_INSTALL_CONCURRENCY, INSTALL_CODES, INSTALL_TIMEOUT_MS } from './install.js'; // v3.17.0 자동 설치
import { installCredFor, credView, CRED_STATES, PREP_FEATURE, INSTALL_FEATURE } from './installCred.js';
import { prepExec, PREP_CODES, PREP_FAILS, AUDIT_SKIPS, PREP_TIMEOUT_MS } from './prep.js'; // v3.18.0 접속 자동 준비
import { putTestResult } from '../store.js'; // v3.18.0 — 준비 뒤 연결 시험 결과를 '키 로그인' 칸에(엣지 시험 결과와 같은 정제)
import { cleanHello, LOGIN_KINDS } from '../hello.js';

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
const ACTIVE_MAX = 300;   // 51회차 #7: 엣지 대기열(runner QUEUE_MAX 200) + 보낼 결과(엣지 AUDIT_RESULTS_MAX 64) 보다 크게
/** 51회차 #1(재현): 엣지 한 곳에 동시에 맡기는 작업(대기 · 실행 · 결과 보내는 중) 상한 — 엣지 결과 대기열(64)보다 작게. 배압이 없으면
 *  접속 전에 끝나는 작업(key-stopped · version · queue-full)이 100건을 넘을 때 결과가 대기열을 넘쳐 'lost' 로 남았다(200건 중 64건). */
export const EDGE_INFLIGHT_MAX = 40;
export const REDELIVER_MS = 2 * 60_000;
export const MAX_DELIVER = 3;
export const MAX_JOBS = 500;
export const RESULTS_PER_SYNC = 8;   // 50회차 R1: 엣지 AUDIT_RESULTS_PER_SYNC 와 같게(일괄 설치 · 준비 결과를 몇 번의 동기화 안에 받는다 — 바이트 상한은 엣지가 지킨다)
/** 화면에 싣는 한도(박지 않는다 — 응답 limits). */
export const LIMITS = Object.freeze({ runGapMin: RUN_GAP_MS / 60_000, checkGapSec: CHECK_GAP_MS / 1000, nodeConcurrency: 1, deadlineMin: Math.round(AUDIT_DEADLINE_MS / 60_000), keepRuns: db.AUDIT_KEEP, keepDays: db.AUDIT_KEEP_DAYS,
  installConcurrency: NODE_INSTALL_CONCURRENCY, installTimeoutSec: INSTALL_TIMEOUT_MS / 1000, prepTimeoutSec: PREP_TIMEOUT_MS / 1000 });
/** 엣지가 알려 온 설치 계정 상태를 믿는 시간 — 지나면 '모름'(엣지가 옛 판이거나 끊김). 설치 작업도 이 안에 알려 온 엣지에만 내려보낸다(옛 판 엣지는 'install' 을 점검 실행으로 읽는다). */
export const EDGE_CRED_TTL_MS = 10 * 60_000;

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
function writeState() { try { atomicWriteFileSync(file(), JSON.stringify({ v: 1, ready: load().ready, jobs: load().jobs, lost: load().lost })); } catch (e) { console.warn('[focusmon-audit] 상태 파일을 쓰지 못했습니다:', String(e?.message || e).slice(0, 160)); } }
/*
 * 51회차 #2: 엣지 동기화 한 번(handleEdgeAudit)이 받은 설치 · 준비 · 확인 결과(최대 RESULTS_PER_SYNC 8건)를 ingestResult 마다 원자 쓰기(fsync 둘)해
 *   한 요청에 상태 파일을 9번 썼다(실측 — 대상 2,000 개 상태 파일 291KB 에서 28~42ms 동기 · 이 컨테이너). 묶음 안에서는 persist 가 '더러움' 만 적고
 *   묶음이 끝날 때 한 번 쓴다. 묶는 것은 **동기 구간뿐**이다 — 점검 결과(DB await 뒤)의 쓰기는 묶음이 끝난 뒤에 돌므로 예전처럼 곧바로 쓴다.
 *   단건 경로(중앙 실행기 onResult · 접수 · 정리)는 묶음 밖이라 그대로다. 메모리는 예전처럼 쓰기 전에 바뀌고, 쓰기 실패는 예전처럼 콘솔 경고뿐(응답은 같다).
 */
let persistBatch = null;
function persist() { if (persistBatch) { persistBatch.dirty = true; return; } writeState(); }
function inPersistBatch(fn) {
  if (persistBatch) return fn();
  persistBatch = { dirty: false };
  try { return fn(); } finally { const b = persistBatch; persistBatch = null; if (b.dirty) writeState(); }
}
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
  // v3.17.0: 준비 줄은 **그 작업이 정한 후보 디렉터리 가운데** 결과가 말한 곳으로 다시 해석한다(엣지가 다른 곳을 말하면 반영하지 않는다).
  //   옛 작업 · 옛 엣지(디렉터리 칸 없음)는 기본 경로.
  // v3.18.0: 접속 준비 + 디스크 점검 함께(job.audit)도 설치와 같이 그 디렉터리 하나 · 함께가 아니면 준비 줄을 받지 않는다(후보 없음)
  const instLike = job.mode === 'install' || (job.mode === 'prep' && job.audit === true && !!r.install);
  const cands = instLike ? [job.dir ?? ''] : job.mode === 'prep' ? [] : (Array.isArray(job.cands) ? job.cands : ['']);
  const rdir = r.dir === undefined || r.dir === null ? (cands.includes('') ? '' : null) : (typeof r.dir === 'string' && !dirIssue(r.dir) && cands.includes(r.dir) ? r.dir : null);
  let rsState = null;
  if (readyLines.length && rdir !== null) {
    const P = pathsFor(rdir);
    const rd = parseReady(readyLines);
    const rs = readyState(rd, { programPath: P.program, wrapperPath: P.wrapper, programSha: programSha(), wrapperSha: wrapperSha(rdir), dirs: dirsToCheck(P) });
    rsState = rs.state;
    Object.assign(rec, { at: now, state: rs.state, reason: rs.reason, dmi: rd.dmi, py: rd.pyVer ? rd.pyVer.join('.') : null, node, dir: rs.state === 'notinstalled' ? null : rdir });
  }
  if (job.mode === 'prep') {
    // v3.18.0 접속 자동 준비 — 노드가 정제해 올린 까닭 이름 · 단계만(원격 글 없음). 연결 시험 결과는 '키 로그인' 칸(store.putTestResult)으로.
    const p = r.prep && typeof r.prep === 'object' ? r.prep : {};
    const lg = r.login && typeof r.login === 'object' ? r.login : null;
    const code = PREP_CODES.includes(p.code) ? p.code : 'unreachable';
    rec.lastPrep = { at: now, by: job.by || '', ok: code === 'ok', code, fail: p.fail || null, step: Number.isInteger(p.step) ? p.step : 0, rc: Number.isInteger(p.rc) ? p.rc : null,
      acct: p.acct || '', key: p.key || '', src: p.src || null, cred: p.cred || null, priv: p.priv || null, created: !!p.created, exists: !!p.exists, added: !!p.added, have: !!p.have,
      differs: !!p.differs, partial: !!p.partial, warn: Array.isArray(p.warn) ? p.warn : [],
      from: p.from === true, fromAsked: !!job.from, age: job.age === 'default' ? 'default' : 'never', login: lg ? lg.kind : null, // 반증 D2 — from 은 실제로 넣었을 때만
      audit: !job.audit ? 'off' : r.install ? 'done' : (AUDIT_SKIPS.includes(r.auditSkip) ? r.auditSkip : 'skip') };
    if (lg) { try { putTestResult(tid, { ok: lg.ok === true, kind: LOGIN_KINDS.includes(lg.kind) ? lg.kind : 'unreachable', error: lg.error || '', hello: cleanHello(lg.hello), ms: Number.isFinite(lg.ms) ? lg.ms : null, via: node ? 'edge' : 'central' }, now); } catch { /* 시험 칸은 다음 시험이 채운다 */ } }
  }
  if (instLike) {
    const ins = r.install && typeof r.install === 'object' ? r.install : {};
    // v3.17.0 반증 D4: 노드가 말한 'ok' 를 믿지 않는다 — 중앙이 준비 줄을 다시 판정해 준비됨일 때만 'ok'.
    //   준비 줄이 없거나 후보 밖이면 '설치함 · 확인 못 함'(check), 판정이 준비됨이 아니면 '설치함 · 준비 안 됨'(not-ready — 까닭은 준비 상태 칸).
    let code = INSTALL_CODES.includes(ins.code) ? ins.code : 'unreachable';
    if (code === 'ok') code = rsState === null ? 'check' : rsState === 'ready' ? 'ok' : 'not-ready';
    rec.lastInstall = { at: now, by: job.by || '', ok: code === 'ok' || code === 'check', code, ready: code === 'not-ready' ? rsState : null, fail: ins.fail || null, step: Number.isInteger(ins.step) ? ins.step : 0,
      rc: Number.isInteger(ins.rc) ? ins.rc : null, acct: ins.acct || '', key: ins.key || '', src: ins.src || null, cred: ins.cred || null, dir: job.dir ?? '', nopy: !!ins.nopy, oldRm: ins.oldRm || 0, oldKeep: ins.oldKeep || 0, priv: ins.priv || null };
    if (rec.lastInstall.ok && (!readyLines.length || rdir === null)) rec.dir = job.dir ?? ''; // 설치는 됐는데 준비 줄이 없다(수집 계정 로그인 거부 등) — 설치한 곳은 안다
  }
  else if (job.mode !== 'prep') rec.lastError = r.ok && (r.kind === 'done' || r.kind === 'not-ready') ? null : { at: now, kind: KINDS.includes(r.kind) ? r.kind : 'unreachable', error: cleanLine(r.error || '', 240) };
  if (readyLines.length && rdir === null && !instLike && job.mode !== 'prep') rec.lastError = { at: now, kind: 'bad-output', error: '결과가 말한 설치 위치가 작업의 후보가 아닙니다 — 반영하지 않았습니다.' };
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
let localInstaller = null;
let localPrepper = null;
let keysRef = null;
/** 작업 종류 → 중앙 실행기(점검 · 확인 = 동시 1 · 설치 · 준비 = 동시 NODE_INSTALL_CONCURRENCY 따로). */
const runnerOf = (mode) => (mode === 'install' ? localInstaller : mode === 'prep' ? localPrepper : localRunner);
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
/** 중앙 설치기 — 점검 실행 줄(동시 1)과 따로(동시 NODE_INSTALL_CONCURRENCY · 서버당 시한). */
function localInstall() {
  if (!localInstaller) {
    localInstaller = createAuditRunner({
      keys: keysRef, concurrency: NODE_INSTALL_CONCURRENCY, exec: installExec(), kind: 'install',
      onPhase: (job, phase) => { const j = load().jobs.find((x) => x.runId === job.runId); if (j) { j.phase = phase; j.state = 'running'; j.startedAt = j.startedAt || job.startedAt || Date.now(); } },
      onResult: (job, result) => {
        const j = liveJob(job.runId);
        if (!j) return;
        ingestResult({ ...j, startedAt: j.startedAt || job.startedAt }, result, { node: '' }).catch((e) => console.warn('[focusmon-audit] 설치 결과 반영 실패:', String(e?.message || e).slice(0, 160)));
      },
    });
  }
  return localInstaller;
}
/** 중앙 접속 준비기(v3.18.0) — 설치기와 같은 모양 · 줄은 따로. */
function localPrep() {
  if (!localPrepper) {
    localPrepper = createAuditRunner({
      keys: keysRef, concurrency: NODE_INSTALL_CONCURRENCY, exec: prepExec(), kind: 'prep',
      onPhase: (job, phase) => { const j = load().jobs.find((x) => x.runId === job.runId); if (j) { j.phase = phase; j.state = 'running'; j.startedAt = j.startedAt || job.startedAt || Date.now(); } },
      onResult: (job, result) => {
        const j = liveJob(job.runId);
        if (!j) return;
        ingestResult({ ...j, startedAt: j.startedAt || job.startedAt }, result, { node: '' }).catch((e) => console.warn('[focusmon-audit] 접속 준비 결과 반영 실패:', String(e?.message || e).slice(0, 160)));
      },
    });
  }
  return localPrepper;
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
  const job = { runId: newRunId(), tid: t.id, mode: m, node: t.demo ? '' : String(t.agent || ''), by: String(by || '').slice(0, 64), requestedAt: now, state: 'queued', phase: null, deliveredAt: null, deliveries: 0, startedAt: null, seenAt: null, ep: endpointKey(t),
    cands: dirCandidates(rec) };
  st.jobs.push(job);
  persist();
  if (!job.node) {
    if (!keysRef) { st.jobs = st.jobs.filter((x) => x.runId !== job.runId); persist(); return { ok: false, code: 'not-started', reason: '디스크 점검 실행기가 아직 준비되지 않았습니다 — 잠시 뒤 다시 누르세요.' }; }
    const s = local().submit({ runId: job.runId, mode: m, target: { id: t.id, host: t.host, port: t.port, username: t.username, demo: !!t.demo }, expect: expectFor(job) });
    if (!s.ok) { st.jobs = st.jobs.filter((x) => x.runId !== job.runId); persist(); return { ok: false, code: s.code, reason: s.code === 'busy' ? '이 서버의 점검이 이미 실행기 줄에 있습니다.' : '실행기 줄이 가득 찼습니다.' }; }
  }
  return { ok: true, runId: job.runId, via: job.node ? 'edge' : 'central' };
}

/** 준비 확인 후보 — 기억한 설치 위치 → 지금 설정 → 기본 경로(검사를 지난 것 · 겹침 없이). 설정을 못 읽으면 그 칸은 뺀다. */
export function dirCandidates(rec) {
  const out = [];
  const add = (d) => { if (typeof d === 'string' && !dirIssue(d) && !out.includes(d)) out.push(d); };
  if (rec && typeof rec.dir === 'string') add(rec.dir);
  const sd = installDir(); if (sd !== null) add(sd);
  add('');
  return out.slice(0, 3);
}
/** 작업에 실을 기대 판본 — 프로그램 · 후보 디렉터리별 실행 파일(중앙이 아는 값 — 엣지 판이 달라도 중앙 기준). */
export function expectFor(job) {
  const inst = job.mode === 'install' || (job.mode === 'prep' && job.audit === true);
  const dirs = inst ? [job.dir ?? ''] : (job.cands || ['']);
  const wrappers = {}; for (const d of dirs) { const w = wrapperSha(d); if (w) wrappers[d] = w; }
  return { program: programSha(), wrapper: wrapperSha(''), wrappers, cands: dirs,
    ...(inst ? { dir: job.dir ?? '', oldDirs: job.oldDirs || [] } : {}),
    ...(job.mode === 'install' || job.mode === 'prep' ? { pick: job.pick || null, corpVcs: job.corpVcs || [] } : {}),
    ...(job.mode === 'prep' ? { from: job.from === true, age: job.age === 'default' ? 'default' : 'never', audit: job.audit === true } : {}) };
}

/* ── 자동 설치(v3.17.0) ─────────────────────────────────────────────────── */
const edgeCred = new Map(); // agent(소문자) → { at, rows: Map(tid → credView) }
const knownSentAt = new Map(); // agent(소문자) → 맡은 서버 목록을 마지막으로 실은 때
export const KNOWN_EVERY_MS = 60_000;
/**
 * 그 서버의 설치 계정 상태(화면 · 접수 공용 — 비밀 없음). 중앙 직접 서버는 이 노드에서 해석, 엣지 서버는 그 엣지가 알려 온 값(시한 안 · 없으면 'edge-unknown').
 * @param {object} t  대상  @param {{corpVcs?:string[], pick?:string|null, now?:number}} o
 */
export function credOfTarget(t, { corpVcs = [], pick = null, now = Date.now(), feature = INSTALL_FEATURE, snap = null } = {}) {
  if (t.demo) return demoCred(t, feature);
  if (!t.agent) return credView(installCredFor(t, { corpVcs, pick, feature, ...(snap || {}) }));   // 51회차 #4: 여러 대상이면 호출부가 사본(credSnapshot)을 한 번
  const e = edgeCred.get(String(t.agent).toLowerCase());
  if (!e || now - e.at > EDGE_CRED_TTL_MS) return { state: 'edge-unknown', src: null, acct: '', key: '' };
  // v3.18.0: 접속 준비 계정은 따로 알려 온다(credPrep) — 옛 엣지(3.17.x)는 보내지 않는다 → 'edge-unknown'
  const rows = feature === PREP_FEATURE ? e.prepRows : e.rows;
  return (rows && rows.get(t.id)) || { state: 'edge-unknown', src: null, acct: '', key: '' };
}
/** 데모 대상 — 장비에 닿지 않는 고정 값(일부는 '설치' 기능이 꺼진 모양). */
function demoCred(t, feature = INSTALL_FEATURE) {
  const n = Number(String(t.id).replace(/\D/g, '').slice(-2)) || 0;
  if (feature === PREP_FEATURE) return n % 7 === 4 ? { state: 'noentry', src: null, acct: '', key: '' } : { state: 'ok', src: n % 2 ? 'server' : 'corp', acct: 'dvcadmin', key: 'demo-common' };
  if (n % 5 === 3) return { state: 'feature', src: 'corp', acct: 'dvcadmin', key: 'demo-common' };
  return { state: 'ok', src: n % 2 ? 'server' : 'corp', acct: 'dvcadmin', key: 'demo-common' };
}
/**
 * 설치 요청(서버 하나). 한 서버에 작업 하나 · 설치 계정이 'ok' 인 서버만(고르면 되는 'ambig' 는 고른 계정이 후보일 때) · 설정을 못 읽으면 거절.
 * @returns {{ok:true, runId, via} | {ok:false, code, reason}}
 */
/** 같은 서버 주소인가(대소문자 무시 — 별칭 · IP 와 이름이 다른 등록은 알아보지 못한다: 문서의 남은 것). */
export const sameHost = (a, b) => String(a?.host || '').trim().toLowerCase() === String(b?.host || '').trim().toLowerCase() && String(a?.host || '').trim() !== '';
/**
 * @param {object} t  등록부 대상
 * @param {{peers?: object[]}} o  peers = 등록부의 다른 대상 전부(범위와 무관 — 같은 주소를 찾는다)
 *   v3.17.0 반증 S3: sudoers 파일은 서버마다 하나(계정 한 줄)라 같은 주소에 다른 수집 계정이 등록돼 있으면 설치가 서로의 sudo 규칙을 덮는다 —
 *   그런 서버는 자동 설치하지 않는다('host-shared'). 같은 주소의 설치가 진행 중이면 차례를 겹치지 않는다('host-busy').
 */
export function requestInstall(t, { by = '', pick = null, corpVcs = [], now = Date.now(), keys = null, peers = [] } = {}) {
  if (!keysRef && keys) keysRef = keys;
  const st = load();
  sweep(now);
  const dir = installDir();
  if (dir === null) return { ok: false, code: 'settings-unreadable', reason: '설치 디렉터리 설정을 읽지 못해 설치하지 않습니다 — 손상 보존본을 확인하세요.' };
  if (st.jobs.some((x) => x.tid === t.id)) return { ok: false, code: 'busy', reason: '이 서버는 이미 점검 · 확인 · 설치 작업이 진행 중이거나 차례를 기다리고 있습니다.' };
  const same = (Array.isArray(peers) ? peers : []).filter((p) => p && p.id !== t.id && sameHost(p, t));
  if (same.some((p) => String(p.username || '') !== String(t.username || ''))) return { ok: false, code: 'host-shared', reason: '같은 주소에 다른 수집 계정으로 등록된 항목이 있습니다 — sudoers 파일 하나에 계정 하나만 적으므로 자동 설치가 다른 계정의 sudo 규칙을 지웁니다. 손으로 설치하세요.' };
  const sameIds = new Set(same.map((p) => p.id));
  if (st.jobs.some((x) => (x.mode === 'install' || x.mode === 'prep') && sameIds.has(x.tid))) return { ok: false, code: 'host-busy', reason: '같은 주소의 다른 항목을 설치 · 준비하는 중입니다 — 그 작업이 끝난 뒤 다시 누르세요.' };
  if (st.jobs.length >= MAX_JOBS) return { ok: false, code: 'queue-full', reason: '대기 중인 작업이 너무 많습니다 — 잠시 뒤 다시 누르세요.' };
  const c = credOfTarget(t, { corpVcs, pick, now });
  const pickOk = c.state === 'ambig' && pick && Array.isArray(c.choices) && c.choices.some((x) => x.id === pick);
  if (c.state !== 'ok' && !pickOk) return { ok: false, code: `cred-${c.state}`, reason: '이 서버는 자동 설치에 쓸 계정이 정해지지 않았습니다.' };
  const rec = st.ready[t.id] || {};
  const oldDirs = typeof rec.dir === 'string' && rec.dir !== dir ? [rec.dir] : [];
  const job = { runId: newRunId(), tid: t.id, mode: 'install', node: t.demo ? '' : String(t.agent || ''), by: String(by || '').slice(0, 64), requestedAt: now, state: 'queued', phase: null, deliveredAt: null, deliveries: 0, startedAt: null, seenAt: null, ep: endpointKey(t),
    dir, oldDirs, pick: pickOk ? pick : null, corpVcs: t.agent ? [] : corpVcs.slice(0, 20) };
  st.jobs.push(job);
  persist();
  if (!job.node) {
    if (!keysRef) { st.jobs = st.jobs.filter((x) => x.runId !== job.runId); persist(); return { ok: false, code: 'not-started', reason: '설치기가 아직 준비되지 않았습니다 — 잠시 뒤 다시 누르세요.' }; }
    const s = localInstall().submit({ runId: job.runId, mode: 'install', target: { id: t.id, name: t.name, host: t.host, port: t.port, username: t.username, demo: !!t.demo }, expect: expectFor(job) });
    if (!s.ok) { st.jobs = st.jobs.filter((x) => x.runId !== job.runId); persist(); return { ok: false, code: s.code, reason: s.code === 'busy' ? '이 서버의 설치가 이미 줄에 있습니다.' : '설치 줄이 가득 찼습니다.' }; }
  }
  return { ok: true, runId: job.runId, via: job.node ? 'edge' : 'central' };
}

/**
 * v3.18.0 접속 자동 준비 요청(서버 하나) — 수집 계정 · 공개키(+ 고르면 디스크 점검 설치). 한 서버에 작업 하나 · 같은 주소의 설치 · 준비와 겹치지 않는다.
 * @param {object} t  등록부 대상
 * @param {{by?, pick?, corpVcs?, now?, keys?, peers?, withAudit?:boolean, from?:boolean, age?:'never'|'default'}} o
 *   withAudit — 디스크 점검 함께(설정을 못 읽거나 같은 주소에 다른 수집 계정이 있으면 그 서버는 준비만 — 까닭 auditWhy)
 * @returns {{ok:true, runId, via, audit:boolean, auditWhy:string|null} | {ok:false, code, reason}}
 */
export function requestPrep(t, { by = '', pick = null, corpVcs = [], now = Date.now(), keys = null, peers = [], withAudit = false, from = false, age = 'never' } = {}) {
  if (!keysRef && keys) keysRef = keys;
  const st = load();
  sweep(now);
  if (String(t.username || '') === 'root') return { ok: false, code: 'acct-root', reason: '수집 계정이 root 입니다 — 일반 계정으로 등록을 고치세요(root 에는 넣지 않습니다).' };
  if (st.jobs.some((x) => x.tid === t.id)) return { ok: false, code: 'busy', reason: '이 서버는 이미 점검 · 확인 · 설치 · 준비 작업이 진행 중이거나 차례를 기다리고 있습니다.' };
  const same = (Array.isArray(peers) ? peers : []).filter((p) => p && p.id !== t.id && sameHost(p, t));
  const sameIds = new Set(same.map((p) => p.id));
  if (st.jobs.some((x) => (x.mode === 'install' || x.mode === 'prep') && sameIds.has(x.tid))) return { ok: false, code: 'host-busy', reason: '같은 주소의 다른 항목을 설치 · 준비하는 중입니다 — 그 작업이 끝난 뒤 다시 누르세요.' };
  if (st.jobs.length >= MAX_JOBS) return { ok: false, code: 'queue-full', reason: '대기 중인 작업이 너무 많습니다 — 잠시 뒤 다시 누르세요.' };
  const c = credOfTarget(t, { corpVcs, pick, now, feature: PREP_FEATURE });
  const pickOk = c.state === 'ambig' && pick && Array.isArray(c.choices) && c.choices.some((x) => x.id === pick);
  if (c.state !== 'ok' && !pickOk) return { ok: false, code: `cred-${c.state}`, reason: '이 서버는 접속 준비에 쓸 계정이 정해지지 않았습니다.' };
  if (c.state === 'ok' && c.acct && c.acct === String(t.username || '')) return { ok: false, code: 'acct-prep', reason: '수집 계정이 준비에 쓸 계정(root · sudo) 자신입니다 — 집중 모니터링 키를 그 계정에 넣지 않습니다. 수집 계정을 일반 계정으로 등록하세요.' };
  // 디스크 점검 함께 — 서버마다 판단(준비는 그대로 한다)
  let audit = false; let auditWhy = null; let dir = null;
  if (withAudit) {
    dir = installDir();
    if (dir === null) auditWhy = 'settings-unreadable';
    else if (same.some((p) => String(p.username || '') !== String(t.username || ''))) auditWhy = 'host-shared';
    else audit = true;
  }
  const rec = st.ready[t.id] || {};
  const oldDirs = audit && typeof rec.dir === 'string' && rec.dir !== dir ? [rec.dir] : [];
  const job = { runId: newRunId(), tid: t.id, mode: 'prep', node: t.demo ? '' : String(t.agent || ''), by: String(by || '').slice(0, 64), requestedAt: now, state: 'queued', phase: null, deliveredAt: null, deliveries: 0, startedAt: null, seenAt: null, ep: endpointKey(t),
    pick: pickOk ? pick : null, corpVcs: t.agent ? [] : corpVcs.slice(0, 20), from: from === true, age: age === 'default' ? 'default' : 'never', audit, auditWhy, ...(audit ? { dir, oldDirs } : {}) };
  st.jobs.push(job);
  persist();
  if (!job.node) {
    if (!keysRef) { st.jobs = st.jobs.filter((x) => x.runId !== job.runId); persist(); return { ok: false, code: 'not-started', reason: '준비기가 아직 준비되지 않았습니다 — 잠시 뒤 다시 누르세요.' }; }
    const s2 = localPrep().submit({ runId: job.runId, mode: 'prep', target: { id: t.id, name: t.name, host: t.host, port: t.port, username: t.username, demo: !!t.demo }, expect: expectFor(job) });
    if (!s2.ok) { st.jobs = st.jobs.filter((x) => x.runId !== job.runId); persist(); return { ok: false, code: s2.code, reason: s2.code === 'busy' ? '이 서버의 준비가 이미 줄에 있습니다.' : '준비 줄이 가득 찼습니다.' }; }
  }
  return { ok: true, runId: job.runId, via: job.node ? 'edge' : 'central', audit, auditWhy };
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
    // v3.18.0 반증 D5: 늦게 온 결과를 그 작업이 정한 값으로 해석하게 — 설치 디렉터리 · 후보 · 준비 선택(예전에는 빠져 설치 결과 · 위치를 버리고 선택 값을 다르게 적었다 — v3.17.0 설치에도 있던 빈틈)
    st.lost[j.runId] = { runId: j.runId, tid: j.tid, mode: j.mode, node: j.node || '-', by: j.by || '', requestedAt: j.requestedAt, startedAt: j.startedAt || null, ep: j.ep || null, lostAt: now,
      ...(Array.isArray(j.cands) ? { cands: j.cands } : {}), ...(typeof j.dir === 'string' ? { dir: j.dir, oldDirs: j.oldDirs || [] } : {}),
      ...(j.mode === 'prep' ? { audit: j.audit === true, auditWhy: j.auditWhy || null, from: j.from === true, age: j.age === 'default' ? 'default' : 'never' } : {}) };
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
 * 51회차 #2: 이 한 번의 상태 파일 쓰기는 끝에 한 번(정리 · 결과 반영 · 배달 표시를 묶는다 — inPersistBatch).
 * @returns {{jobs:object[], ack:string[]}}
 */
export function handleEdgeAudit(agent, mine, a, now = Date.now()) {
  return inPersistBatch(() => handleEdgeAuditOnce(agent, mine, a, now));
}
function handleEdgeAuditOnce(agent, mine, a, now) {
  sweep(now); // 시한 정리(바뀐 때만 쓴다)
  const st = load();
  const key = String(agent || '').toLowerCase();
  const ack = []; const cancel = []; let changed = false;
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  const b = isObj(a) ? a : {};
  const active = new Set();
  const lostOf = (runId) => { const l = st.lost[runId]; return l && String(l.node).toLowerCase() === key ? l : null; };
  // v3.17.0: 엣지가 알려 온 설치 계정 상태(그 엣지가 맡은 대상만 · 아는 상태 · 이름은 정리 · 비밀 칸은 애초에 없다)
  if (isObj(b.cred)) {
    const rows = new Map();
    for (const [tid, v] of Object.entries(b.cred).slice(0, 500)) { if (mine.has(tid)) { const c = cleanEdgeCred(v); if (c) rows.set(tid, c); } }
    // v3.18.0: 접속 준비 계정(credPrep — 같은 정제). 옛 엣지는 보내지 않는다 → null(접수 'cred-edge-unknown' · 배달 안 함)
    let prepRows = null;
    if (isObj(b.credPrep)) { prepRows = new Map(); for (const [tid, v] of Object.entries(b.credPrep).slice(0, 500)) { if (mine.has(tid)) { const c = cleanEdgeCred(v); if (c) prepRows.set(tid, c); } } }
    edgeCred.set(key, { at: now, rows, prepRows });
    if (edgeCred.size > 200) edgeCred.delete(edgeCred.keys().next().value);
  }
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
  const credFresh = (() => { const e = edgeCred.get(key); return !!e && now - e.at <= EDGE_CRED_TTL_MS; })();
  const canInstall = Array.isArray(b.caps) && b.caps.slice(0, 10).includes('install'); // 반증 S1 — 이번 본문의 표시만 믿는다
  const canPrep = Array.isArray(b.caps) && b.caps.slice(0, 10).includes('prep'); // v3.18.0 — 3.17.x 엣지는 'prep' 을 모른다(점검 실행으로 읽는다)
  const prepFresh = (() => { const e = edgeCred.get(key); return !!e && !!e.prepRows && now - e.at <= EDGE_CRED_TTL_MS; })();
  const deliverMax = Math.min(20, Math.max(0, EDGE_INFLIGHT_MAX - (Array.isArray(b.active) ? Math.min(b.active.length, ACTIVE_MAX) : 0)));
  for (const j of deliverMax > 0 ? st.jobs : []) {
    if (String(j.node).toLowerCase() !== key || !mine.has(j.tid) || active.has(j.runId) || j.state === 'ingesting') continue;
    if (j.deliveredAt && (now - j.deliveredAt < REDELIVER_MS || j.deliveries >= MAX_DELIVER)) continue;
    // 설치 작업은 설치 계정 상태를 알려 오는 엣지(이 판 이상)에만 — 옛 엣지는 모르는 작업 종류를 점검 실행('run')으로 읽는다
    if (j.mode === 'install' && (!credFresh || !canInstall)) continue;
    if (j.mode === 'prep' && (!prepFresh || !canPrep || (j.audit && !canInstall))) continue;
    const t = mine.get(j.tid);
    j.deliveredAt = now; j.deliveries = (j.deliveries || 0) + 1; changed = true;
    jobs.push({ runId: j.runId, mode: j.mode, id: t.id, name: t.name, host: t.host, port: t.port, username: t.username, expect: expectFor(j) });
    if (jobs.length >= deliverMax) break;
  }
  // 상태가 실제로 바뀐 때만 쓴다(반증 F8 — 엣지는 작업이 있는 동안 2초마다 동기화한다 · 원자 쓰기는 fsync 둘)
  if (changed) persist();
  // v3.17.0: 그 엣지가 맡은 등록 서버 목록(설치 계정 상태를 알려 오게) — 60초에 한 번만 싣는다(비밀 없음 · 이름 · 주소 · 포트)
  let known;
  const kAt = knownSentAt.get(key) || 0;
  if (now - kAt >= KNOWN_EVERY_MS || now < kAt) {
    knownSentAt.set(key, now); if (knownSentAt.size > 200) knownSentAt.delete(knownSentAt.keys().next().value);
    known = [...mine.values()].slice(0, 500).map((t) => ({ id: t.id, name: t.name, host: t.host, port: t.port }));
  }
  return { jobs, ack, cancel, ...(known ? { known } : {}) };
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
  // v3.17.0: 설치 위치(검사를 지난 글자만 — 작업 후보인지는 ingestResult 가 본다) · 설치 결과(아는 까닭 · 정수 · 이름 정리)
  const dir = typeof x.dir === 'string' && !dirIssue(x.dir) ? x.dir : (x.dir === undefined ? undefined : null);
  const ii = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
  const nm = (v) => (typeof v === 'string' && /^[A-Za-z0-9가-힣_.@ -]{0,64}$/.test(v) ? v : '');
  const cleanInstall = (v) => ({
    code: INSTALL_CODES.includes(v.code) ? v.code : 'unreachable', fail: INSTALL_FAILS.includes(v.fail) ? v.fail : (v.fail == null ? null : 'other'),
    step: ii(v.step, 0, 7) ?? 0, rc: ii(v.rc, 0, 255), acct: nm(v.acct), key: nm(v.key), src: ['server', 'corp'].includes(v.src) ? v.src : null,
    cred: CRED_STATES.includes(v.cred) ? v.cred : null, nopy: v.nopy === true, oldRm: ii(v.oldRm, 0, 10) ?? 0, oldKeep: ii(v.oldKeep, 0, 10) ?? 0,
    priv: ['root', 'sudo', 'tty', 'no'].includes(v.priv) ? v.priv : null,
  });
  const install = x.mode === 'install' && x.install && typeof x.install === 'object' && !Array.isArray(x.install) ? cleanInstall(x.install) : null;
  // v3.18.0 접속 준비 결과(아는 까닭 · 정수 · 이름 · 참거짓만 — 원격 글 없음) · 연결 시험(엣지 시험 결과와 같은 정제) · 디스크 점검 건너뛴 까닭
  const isPrep = x.mode === 'prep';
  const pp = isPrep && x.prep && typeof x.prep === 'object' && !Array.isArray(x.prep) ? x.prep : null;
  const prep = pp ? {
    code: PREP_CODES.includes(pp.code) ? pp.code : 'unreachable', fail: PREP_FAILS.includes(pp.fail) ? pp.fail : (pp.fail == null ? null : 'other'),
    step: ii(pp.step, 0, 7) ?? 0, rc: ii(pp.rc, 0, 255), acct: nm(pp.acct), key: nm(pp.key), src: ['server', 'corp'].includes(pp.src) ? pp.src : null,
    cred: CRED_STATES.includes(pp.cred) ? pp.cred : null, priv: ['root', 'sudo', 'tty', 'no'].includes(pp.priv) ? pp.priv : null,
    created: pp.created === true, exists: pp.exists === true, added: pp.added === true, have: pp.have === true, differs: pp.differs === true, partial: pp.partial === true, from: pp.from === true,
    warn: Array.isArray(pp.warn) ? pp.warn.filter((w) => ['home-perm', 'passwd', 'chage'].includes(w)).slice(0, 3) : [],
  } : null;
  const lg = isPrep && x.login && typeof x.login === 'object' && !Array.isArray(x.login) ? x.login : null;
  const login = lg ? { ok: lg.ok === true, kind: LOGIN_KINDS.includes(lg.kind) ? lg.kind : 'unreachable', error: typeof lg.error === 'string' ? cleanLine(lg.error, 240) : '', hello: cleanHello(lg.hello), ms: Number.isFinite(lg.ms) && lg.ms >= 0 ? Math.min(lg.ms, 600_000) : null } : null;
  const auditSkip = isPrep && AUDIT_SKIPS.includes(x.auditSkip) ? x.auditSkip : null;
  const prepInstall = isPrep && x.install && typeof x.install === 'object' && !Array.isArray(x.install) ? cleanInstall(x.install) : null;
  return {
    mode: x.mode === 'check' ? 'check' : x.mode === 'install' ? 'install' : isPrep ? 'prep' : 'run', ok: x.ok === true, ran: x.ran === true, kind, error: typeof x.error === 'string' ? cleanLine(x.error, 240) : '',
    ...(dir !== undefined ? { dir } : {}), ...(install ? { install } : {}), ...(prepInstall ? { install: prepInstall } : {}),
    ...(prep ? { prep } : {}), ...(login ? { login } : {}), ...(isPrep ? { auditSkip } : {}),
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
  const lr = !j.node ? runnerOf(j.mode)?.state(j.runId) || null : null;
  return { runId: j.runId, mode: j.mode, node: j.node, state: lr?.state || j.state || 'queued', phase: lr?.phase || j.phase || null, position: lr?.position || null, requestedAt: j.requestedAt, startedAt: lr?.startedAt || j.startedAt || null, delivered: !!j.deliveredAt };
}
export function activeJobs() { return load().jobs.map((j) => jobOf(j.tid)).filter(Boolean); }
const dropJobsOf = (st, tid) => {
  const gone = st.jobs.filter((x) => x.tid === tid);
  for (const j of gone) if (!j.node) runnerOf(j.mode)?.cancel(j.runId);
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

/** 엣지 설치 계정 보고 한 줄 정제(비밀 칸 없음 · 아는 상태 · 이름 정리 · 고르기 후보 10개). */
export function cleanEdgeCred(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const nm = (x) => (typeof x === 'string' && /^[A-Za-z0-9가-힣_.@ -]{0,64}$/.test(x) ? x : '');
  const state = CRED_STATES.includes(v.state) ? v.state : 'error';
  const choices = state === 'ambig' && Array.isArray(v.choices) ? v.choices.slice(0, 10).filter((c) => c && typeof c === 'object' && typeof c.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(c.id)).map((c) => ({ id: c.id, name: nm(c.name), acct: nm(c.acct), key: nm(c.key) })) : null;
  return { state, src: ['server', 'corp'].includes(v.src) ? v.src : null, acct: nm(v.acct), key: nm(v.key), ...(choices ? { choices } : {}) };
}
export function _resetForTest() { S = null; loadErr = ''; persistBatch = null; latest.clear(); localRunner = null; localInstaller = null; localPrepper = null; keysRef = null; spaceLow = () => false; edgeCred.clear(); knownSentAt.clear(); }
