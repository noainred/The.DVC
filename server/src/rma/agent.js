#!/usr/bin/env node
/**
 * RMA — 엣지 원격 명령·점검 에이전트(별도 프로세스, v2.416 / v2.418 확장).
 *
 *   node server/src/rma/agent.js        (systemd: vmware-portal-rma@<인스턴스>, portal.env 공유)
 *
 * 포탈 본체(index.js)와 **다른 프로세스**로 돈다. 이유:
 *  1. 포탈이 죽거나 업그레이드 재시작 중에도 원격에서 '서비스 상태/로그/재시작' 명령을 받을 수 있다
 *     (HostMonitor RMA 가 감시 대상과 분리된 서비스로 상주하는 것과 같은 이유).
 *  2. 명령 실행(spawn·출력 버퍼링)이 포탈의 수집 이벤트 루프와 섞이지 않는다.
 *  3. 권한 분리 — sudo 규칙(install.sh sudoers)은 이 프로세스의 실행 계정에만 필요하다.
 *
 * 동작(Active RMA 모델 — 엣지가 중앙으로 아웃바운드만):
 *   loop: POST {CENTRAL_URL}/api/central/rma-poll { agent, instance, info, wait, results, scheduleVersion }
 *         ← { jobs[], schedule?, config? }
 *         jobs[]: 서명 검증(RMA_PASSWORD) → 카탈로그+정책 재검증(buildCommand) → 실행 → POST rma-result
 *         schedule: 중앙 점검 스케줄(버전이 바뀔 때만 내려옴) → 파일 보관 → 주기 실행 → 결과는 다음 폴에 동봉
 *         (중앙 불통이면 outbox 파일에 보관했다가 재접속 시 전송 — Active RMA 의 '결과 보관·재전송')
 * 환경변수(portal.env 와 공유):
 *   CENTRAL_URL, CENTRAL_TOKEN|EDGE_TOKEN(개별 토큰 권장), AGENT_NAME|COLLECTOR_DATACENTER(기본 hostname)
 *   RMA_INSTANCE / RMA_PRIORITY / RMA_PASSWORD / RMA_ALLOW_CUSTOM / RMA_LONGPOLL_MS / RMA_MAX_OUTPUT  (v2.416 참조)
 *   RMA_COMMENT              화면에 표시할 설명(HostMonitor 'Comment')
 *   RMA_ENABLED_COMMANDS     허용 명령 id 목록(쉼표, 비우거나 * = 전부) / RMA_DISABLED_COMMANDS 차단 목록
 *   RMA_ENABLED_TESTS        허용 점검 id 목록 / RMA_DISABLED_TESTS
 *   RMA_SERVICE_UNITS        service-start/stop/restart 가 다룰 수 있는 유닛 목록(sudoers 도 같은 목록으로 생성)
 *   RMA_ALLOW_REBOOT         true 면 reboot 프리셋 허용(sudoers 도 함께)
 *   RMA_FILE_ROOTS           파일 점검 허용 루트(쉼표, 기본 /var/log)
 *   RMA_TEST_CONCURRENCY     동시 점검 수(기본 4)
 *   RMA_REMOTE_MANAGE        true 면 중앙이 내려주는 원격 설정(longpoll·동시성·점검 허용 축소)을 받아들인다(기본 false)
 *   RMA_AUDIT_LOG            성공 감사 로그 파일(jsonl) / RMA_FAILURE_LOG 거부·실패 로그 파일
 *   RMA_OFFLINE_MINUTES      중앙 무연결이 N분 이상이면 아래 명령 실행(HostMonitor 'Alerts' 대응)
 *   RMA_OFFLINE_PING_HOST    무연결 시 ping 할 호스트(선택) → 응답이면 RMA_OFFLINE_CMD_OK, 아니면 RMA_OFFLINE_CMD_FAIL
 *   RMA_OFFLINE_CMD_OK / RMA_OFFLINE_CMD_FAIL / RMA_RESTORE_CMD   현장 담당자가 portal.env 에 두는 셸 명령(중앙이 못 바꾼다)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resilientFetch } from '../util/resilientFetch.js';
import { buildCommand, parseList } from './commands.js';
import { verifyJob } from './signing.js';
import { runCommand, DEFAULT_MAX_OUTPUT } from './exec.js';
import { buildTest } from './tests.js';
import { runTest } from './testRunner.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const CENTRAL_URL = (env.CENTRAL_URL || '').replace(/\/+$/, '');
const TOKEN = env.CENTRAL_TOKEN || env.EDGE_TOKEN || '';
const AGENT = env.AGENT_NAME || env.COLLECTOR_DATACENTER || os.hostname();
const INSTANCE = (env.RMA_INSTANCE || os.hostname()).trim().slice(0, 64) || 'default';
const PRIORITY = Number.isFinite(Number(env.RMA_PRIORITY)) && env.RMA_PRIORITY !== '' ? Number(env.RMA_PRIORITY) : 100;
const PASSWORD = env.RMA_PASSWORD || '';
const ALLOW_CUSTOM = env.RMA_ALLOW_CUSTOM === 'true';
const REMOTE_MANAGE = env.RMA_REMOTE_MANAGE === 'true';
const COMMENT = String(env.RMA_COMMENT || '').slice(0, 200);
const CONFIG_DIR = env.CONFIG_DIR || path.resolve(HERE, '..', '..', 'config');
const MAX_OUTPUT = DEFAULT_MAX_OUTPUT;

/** 엣지 정책(현장 담당자의 portal.env 가 진실 — 중앙은 축소만 가능). */
export const POLICY = {
  enabled: parseList(env.RMA_ENABLED_COMMANDS), disabled: parseList(env.RMA_DISABLED_COMMANDS),
  enabledTests: parseList(env.RMA_ENABLED_TESTS), disabledTests: parseList(env.RMA_DISABLED_TESTS),
  serviceUnits: parseList(env.RMA_SERVICE_UNITS), allowReboot: env.RMA_ALLOW_REBOOT === 'true',
  fileRoots: (() => { const l = parseList(env.RMA_FILE_ROOTS).filter((p) => /^\/[A-Za-z0-9._/-]*$/.test(p)); return l.length ? l : ['/var/log']; })(),
};
/** 원격 관리로 바뀔 수 있는 값(RMA_REMOTE_MANAGE=true 일 때만 중앙 config 를 받아들인다). */
const runtime = {
  longpollMs: Math.min(55_000, Math.max(5_000, Number(env.RMA_LONGPOLL_MS) || 20_000)),
  testConcurrency: Math.max(1, Math.min(16, Number(env.RMA_TEST_CONCURRENCY) || 4)),
  remoteDisabledTests: [], // 중앙이 축소한 점검 목록(원격 관리 시)
};

function readVersion() { try { return JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'package.json'), 'utf8')).version || ''; } catch { return ''; } }
const VERSION = readVersion();
const STARTED = Date.now();
let busy = false;
let stopping = false;
let restartAfterPost = false;
const stats = { active: 0, performed: 0, rejected: 0, testsRun: 0, testsFailed: 0 };

const log = (...a) => console.log(`[rma ${new Date().toISOString()}]`, ...a);
const headers = () => ({ 'Content-Type': 'application/json', 'X-Agent-Name': AGENT, ...(TOKEN ? { 'X-Central-Token': TOKEN } : {}) });

// ── 감사 로그(엣지, jsonl) — HostMonitor 'Successful/Failure audit log' 대응 ──
function audit(file, rec) {
  if (!file) return;
  try { fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), instance: INSTANCE, ...rec }) + '\n', { mode: 0o600 }); } catch { /* best effort */ }
}
const auditOk = (rec) => audit(env.RMA_AUDIT_LOG, rec);
const auditFail = (rec) => audit(env.RMA_FAILURE_LOG, rec);

function info() {
  return {
    hostname: os.hostname(), version: VERSION, os: `${os.type()} ${os.release()}`, pid: process.pid, priority: PRIORITY,
    uptimeSec: Math.round((Date.now() - STARTED) / 1000), allowCustom: ALLOW_CUSTOM, signed: !!PASSWORD, busy,
    comment: COMMENT, remoteManage: REMOTE_MANAGE, stats: { ...stats },
    policy: { enabled: POLICY.enabled, disabled: POLICY.disabled, enabledTests: POLICY.enabledTests, disabledTests: POLICY.disabledTests, serviceUnits: POLICY.serviceUnits, allowReboot: POLICY.allowReboot, fileRoots: POLICY.fileRoots },
    scheduleVersion: schedule.version, scheduledTests: schedule.tests.length, outbox: outbox.length,
    runtime: { longpollMs: runtime.longpollMs, testConcurrency: runtime.testConcurrency },
  };
}

async function postResult(reqId, result) {
  await resilientFetch(`${CENTRAL_URL}/api/central/rma-result`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ agent: AGENT, instance: INSTANCE, reqId, result }), timeoutMs: 20_000, retries: 3,
  }).catch((e) => log(`결과 회신 실패 reqId=${reqId}: ${e.message}`));
}

/** 잡 1건 처리 — 검증 실패도 결과로 회신한다(중앙 UI 가 즉시 사유를 본다). */
export async function handleJob(job, { password = PASSWORD, allowCustom = ALLOW_CUSTOM, policy = POLICY, exec = runCommand, now } = {}) {
  const v = verifyJob(password, { ...job, agent: AGENT }, now);
  if (!v.ok) { stats.rejected++; auditFail({ kind: 'job', reqId: job.reqId, cmd: job.cmd, reason: v.reason }); return { ok: false, reason: v.reason, rejected: true }; }
  const b = buildCommand(job.cmd, job.args || {}, { allowCustom, timeoutMs: job.timeoutMs, policy });
  if (!b.ok) { stats.rejected++; auditFail({ kind: 'job', reqId: job.reqId, cmd: job.cmd, reason: b.issue }); return { ok: false, reason: b.issue, rejected: true }; }
  stats.active++;
  try {
    const r = await exec(b, { maxOutput: MAX_OUTPUT });
    stats.performed++;
    (r.ok ? auditOk : auditFail)({ kind: 'job', reqId: job.reqId, cmd: b.preset, args: b.args, ok: r.ok, exitCode: r.exitCode, durationMs: r.durationMs, reason: r.reason });
    if (r.restartSelf) restartAfterPost = true;
    return { ...r, cmd: b.preset, argv: b.argv || null, instance: INSTANCE };
  } finally { stats.active--; }
}

// ── 점검 스케줄(중앙 배포) + 실행 + outbox ──
const SCHEDULE_FILE = path.join(CONFIG_DIR, `rma-schedule-${INSTANCE}.json`);
const OUTBOX_FILE = path.join(CONFIG_DIR, `rma-outbox-${INSTANCE}.json`);
const OUTBOX_MAX = 5000;
let schedule = { version: 0, assignKey: '', tests: [] };
let outbox = [];
const nextRun = new Map();   // testId → 다음 실행 시각
const running = new Set();

function loadJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function saveJson(file, data) { try { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 }); fs.renameSync(tmp, file); } catch (e) { log(`파일 저장 실패 ${path.basename(file)}: ${e.message}`); } }

export function testAllowed(id, policy = POLICY) {
  if ((policy.disabledTests || []).includes(id) || runtime.remoteDisabledTests.includes(id)) return false;
  const en = policy.enabledTests || [];
  return !en.length || en.includes('*') || en.includes(id);
}

/** 중앙 스케줄 적용(버전이 다를 때만 호출됨). 지터: 첫 실행을 주기 안에 분산해 동시 폭주 방지. */
export function applySchedule(sch) {
  if (!sch || typeof sch !== 'object') return;
  const tests = (Array.isArray(sch.tests) ? sch.tests : []).filter((t) => t && t.id && t.test).slice(0, 500);
  schedule = { version: Number(sch.version) || 0, assignKey: String(sch.assignKey || ''), tests };
  const ids = new Set(tests.map((t) => t.id));
  for (const id of [...nextRun.keys()]) if (!ids.has(id)) nextRun.delete(id);
  for (const t of tests) if (!nextRun.has(t.id)) nextRun.set(t.id, Date.now() + Math.floor(Math.random() * Math.min(30_000, (Number(t.intervalSec) || 300) * 1000)));
  saveJson(SCHEDULE_FILE, schedule);
  log(`점검 스케줄 적용 v${schedule.version} — ${tests.length}개`);
}

function pushOutbox(r) {
  outbox.push(r);
  if (outbox.length > OUTBOX_MAX) outbox.splice(0, outbox.length - OUTBOX_MAX);
}

async function runOne(t) {
  if (running.has(t.id)) return;
  running.add(t.id);
  const t0 = Date.now();
  try {
    let r;
    if (!testAllowed(t.test)) r = { status: 'unknown', reply: `이 엣지에서 허용되지 않은 점검(${t.test}) — RMA_ENABLED_TESTS/RMA_DISABLED_TESTS`, durationMs: 0 };
    else {
      const b = buildTest(t.test, t.args || {});
      r = b.ok ? await runTest(b, { fileRoots: POLICY.fileRoots, allowCustom: ALLOW_CUSTOM }) : { status: 'unknown', reply: b.issue, durationMs: 0 };
    }
    stats.testsRun++; if (r.status === 'bad' || r.status === 'unknown') stats.testsFailed++;
    pushOutbox({ id: t.id, test: t.test, name: t.name || '', status: r.status, reply: r.reply, value: r.value ?? null, at: Date.now(), durationMs: r.durationMs, instance: INSTANCE });
  } catch (e) {
    pushOutbox({ id: t.id, test: t.test, name: t.name || '', status: 'unknown', reply: `실행 오류: ${e.message}`, value: null, at: Date.now(), durationMs: Date.now() - t0, instance: INSTANCE });
  } finally {
    running.delete(t.id);
    nextRun.set(t.id, Date.now() + Math.max(30, Number(t.intervalSec) || 300) * 1000);
  }
}

/** 기한이 된 점검을 동시성 상한 안에서 실행(HostMonitor 'Do not start more than N tests' 대응). */
export async function tickSchedule(now = Date.now()) {
  const due = schedule.tests.filter((t) => t.enabled !== false && (nextRun.get(t.id) || 0) <= now && !running.has(t.id));
  const slots = Math.max(0, runtime.testConcurrency - running.size);
  await Promise.all(due.slice(0, slots).map((t) => runOne(t)));
  return { due: due.length, started: Math.min(due.length, slots) };
}

// ── 무연결 알림 명령(HostMonitor 'Alerts' 대응 — 현장 셸 명령, portal.env 에서만 설정) ──
const OFFLINE_MIN = Math.max(0, Number(env.RMA_OFFLINE_MINUTES) || 0);
let lastContact = Date.now();
let offlineFired = false;
async function offlineCheck() {
  if (!OFFLINE_MIN) return;
  const mins = (Date.now() - lastContact) / 60_000;
  if (mins >= OFFLINE_MIN && !offlineFired) {
    offlineFired = true;
    let cmd = env.RMA_OFFLINE_CMD_FAIL || '';
    if (env.RMA_OFFLINE_PING_HOST) {
      const p = await runCommand({ argv: ['ping', '-n', '-c', '2', '-W', '2', env.RMA_OFFLINE_PING_HOST], timeoutMs: 15_000 });
      cmd = p.ok ? (env.RMA_OFFLINE_CMD_OK || '') : (env.RMA_OFFLINE_CMD_FAIL || '');
      log(`중앙 무연결 ${Math.round(mins)}분 — ping ${env.RMA_OFFLINE_PING_HOST}: ${p.ok ? '응답' : '무응답'}`);
    }
    if (cmd) { const r = await runCommand({ shell: cmd, timeoutMs: 60_000 }); log(`무연결 명령 실행: exit ${r.exitCode}`); auditFail({ kind: 'offline-alert', mins: Math.round(mins), exitCode: r.exitCode }); }
  }
}
async function onContact() {
  lastContact = Date.now();
  if (offlineFired) {
    offlineFired = false;
    if (env.RMA_RESTORE_CMD) { const r = await runCommand({ shell: env.RMA_RESTORE_CMD, timeoutMs: 60_000 }); log(`복구 명령 실행: exit ${r.exitCode}`); }
  }
}

function applyRemoteConfig(cfg) {
  if (!REMOTE_MANAGE || !cfg || typeof cfg !== 'object') return;
  if (cfg.longpollMs) runtime.longpollMs = Math.min(55_000, Math.max(5_000, Number(cfg.longpollMs) || runtime.longpollMs));
  if (cfg.testConcurrency) runtime.testConcurrency = Math.max(1, Math.min(16, Number(cfg.testConcurrency) || runtime.testConcurrency));
  if (Array.isArray(cfg.disabledTests)) runtime.remoteDisabledTests = cfg.disabledTests.map(String).slice(0, 200); // 축소만 — 허용 확대는 불가
}

async function pollOnce() {
  const batch = outbox.slice(0, 500);
  const r = await resilientFetch(`${CENTRAL_URL}/api/central/rma-poll`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ agent: AGENT, instance: INSTANCE, info: info(), wait: runtime.longpollMs, results: batch, scheduleVersion: schedule.version, assignKey: schedule.assignKey }),
    timeoutMs: runtime.longpollMs + 15_000, retries: 0,
  });
  if (r.status === 403 || r.status === 404) {
    let reason = ''; try { reason = (await r.json()).reason || ''; } catch { /* */ }
    throw new Error(`중앙 거부 HTTP ${r.status}${reason ? ` — ${reason}` : ''}`);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const body = await r.json();
  await onContact();
  if (batch.length) { outbox = outbox.slice(batch.length); saveJson(OUTBOX_FILE, outbox); }
  if (body.schedule) applySchedule(body.schedule);
  if (body.config) applyRemoteConfig(body.config);
  for (const job of body.jobs || []) {
    busy = true;
    const t0 = Date.now();
    log(`실행 reqId=${job.reqId} cmd=${job.cmd}`);
    let result;
    try { result = await handleJob(job); } catch (e) { result = { ok: false, reason: e.message }; }
    busy = false;
    log(`완료 reqId=${job.reqId} ok=${result.ok}${result.reason ? ` (${result.reason})` : ''} ${Date.now() - t0}ms`);
    await postResult(job.reqId, result);
    if (restartAfterPost) { log('RMA 재시작 요청 — 3초 뒤 종료(systemd 재기동)'); setTimeout(() => process.exit(0), 3000); }
  }
}

async function main() {
  if (!CENTRAL_URL) { console.error('[rma] CENTRAL_URL 이 비어 있습니다 — portal.env 에 중앙 주소를 설정하세요.'); process.exit(2); }
  if (!TOKEN) { console.error('[rma] CENTRAL_TOKEN/EDGE_TOKEN 이 비어 있습니다 — 이 엣지의 개별 토큰을 설정하세요.'); process.exit(2); }
  log(`시작 agent=${AGENT} instance=${INSTANCE} priority=${PRIORITY} central=${CENTRAL_URL} version=${VERSION} signed=${!!PASSWORD} custom=${ALLOW_CUSTOM} remoteManage=${REMOTE_MANAGE} longpoll=${runtime.longpollMs}ms`);
  if (!PASSWORD) log('⚠ RMA_PASSWORD 미설정 — 서명 없는 명령을 실행합니다. 중앙 토큰만이 방어선이므로 비밀번호 설정을 권장합니다.');
  // 재시작 후에도 스케줄·미전송 결과를 이어간다(Active RMA 의 결과 보관).
  const savedSch = loadJson(SCHEDULE_FILE, null);
  if (savedSch?.tests) { applySchedule(savedSch); }
  outbox = (loadJson(OUTBOX_FILE, []) || []).slice(-OUTBOX_MAX);
  if (outbox.length) log(`미전송 점검 결과 ${outbox.length}건 복원`);
  // 점검 틱(5초) — 폴 루프와 독립(중앙 불통이어도 점검은 계속 돌고 결과는 outbox 에 쌓인다)
  const tick = setInterval(() => { tickSchedule().catch(() => {}); offlineCheck().catch(() => {}); if (outbox.length && outbox.length % 50 === 0) saveJson(OUTBOX_FILE, outbox); }, 5000);
  tick.unref?.();
  let backoff = 2_000;
  while (!stopping) {
    try { await pollOnce(); backoff = 2_000; }
    catch (e) {
      log(`폴링 실패: ${e.message} — ${Math.round(backoff / 1000)}초 후 재시도`);
      if (outbox.length) saveJson(OUTBOX_FILE, outbox);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(60_000, backoff * 2);
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const shutdown = () => { stopping = true; if (outbox.length) saveJson(OUTBOX_FILE, outbox); log('종료'); setTimeout(() => process.exit(0), 200).unref?.(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', () => { stopping = true; process.exit(0); });
  main().catch((e) => { console.error('[rma] 치명적 오류', e); process.exit(1); });
}
