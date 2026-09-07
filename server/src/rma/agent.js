#!/usr/bin/env node
/**
 * RMA — 엣지 원격 명령 에이전트(별도 프로세스, v2.416).
 *
 *   node server/src/rma/agent.js        (systemd: vmware-portal-rma.service, portal.env 공유)
 *
 * 포탈 본체(index.js)와 **다른 프로세스**로 돈다. 이유:
 *  1. 포탈이 죽거나 업그레이드 재시작 중에도 원격에서 '서비스 상태/로그/재시작' 명령을 받을 수 있다
 *     (HostMonitor RMA 가 감시 대상과 분리된 서비스로 상주하는 것과 같은 이유).
 *  2. 명령 실행(spawn·출력 버퍼링)이 포탈의 수집 이벤트 루프와 섞이지 않는다.
 *  3. 권한 분리 — sudo 규칙(install.sh sudoers)은 이 프로세스의 실행 계정에만 필요하다.
 *
 * 동작(passive 모드 — 엣지가 중앙으로 아웃바운드만):
 *   loop: POST {CENTRAL_URL}/api/central/rma-poll { agent, info, wait } (롱폴 최대 RMA_LONGPOLL_MS)
 *         → jobs[] 각각: 서명 검증(RMA_PASSWORD) → 카탈로그 재검증(buildCommand) → 실행 → POST rma-result
 * 환경변수(portal.env 와 공유):
 *   CENTRAL_URL, CENTRAL_TOKEN|EDGE_TOKEN(개별 토큰 권장), AGENT_NAME|COLLECTOR_DATACENTER(기본 hostname)
 *   RMA_INSTANCE        이 프로세스의 인스턴스 이름(기본 hostname) — 한 법인에 RMA 를 여러 개 둘 때 구별자
 *                       (systemd 템플릿 vmware-portal-rma@<이름> 은 %i 를 자동 주입)
 *   RMA_PRIORITY        Active-Backup 순위(낮을수록 주, 기본 100)
 *   RMA_PASSWORD        엣지 비밀번호 — 설정 시 이 값으로 서명된 잡만 실행(중앙 '원격 명령' 화면에서 같은 값 등록)
 *   RMA_ALLOW_CUSTOM    true 면 자유 명령(/bin/sh -c) 허용(기본 false — 프리셋만)
 *   RMA_LONGPOLL_MS     롱폴 대기(기본 20000, 5000~55000)
 *   RMA_MAX_OUTPUT      결과 출력 상한 바이트(기본 262144)
 *   WAN_TLS_INSECURE    자체서명 중앙 https 인 경우에만 true(resilientFetch 규약과 동일)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resilientFetch } from '../util/resilientFetch.js';
import { buildCommand } from './commands.js';
import { verifyJob } from './signing.js';
import { runCommand, DEFAULT_MAX_OUTPUT } from './exec.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTRAL_URL = (process.env.CENTRAL_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.CENTRAL_TOKEN || process.env.EDGE_TOKEN || '';
const AGENT = process.env.AGENT_NAME || process.env.COLLECTOR_DATACENTER || os.hostname();
const INSTANCE = (process.env.RMA_INSTANCE || os.hostname()).trim().slice(0, 64) || 'default';
const PRIORITY = Number.isFinite(Number(process.env.RMA_PRIORITY)) && process.env.RMA_PRIORITY !== '' ? Number(process.env.RMA_PRIORITY) : 100;
const PASSWORD = process.env.RMA_PASSWORD || '';
const ALLOW_CUSTOM = process.env.RMA_ALLOW_CUSTOM === 'true';
const LONGPOLL_MS = Math.min(55_000, Math.max(5_000, Number(process.env.RMA_LONGPOLL_MS) || 20_000));
const MAX_OUTPUT = DEFAULT_MAX_OUTPUT;

function readVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'package.json'), 'utf8')).version || ''; } catch { return ''; }
}
const VERSION = readVersion();
const STARTED = Date.now();
let busy = false;
let stopping = false;

const log = (...a) => console.log(`[rma ${new Date().toISOString()}]`, ...a);
const headers = () => ({ 'Content-Type': 'application/json', 'X-Agent-Name': AGENT, ...(TOKEN ? { 'X-Central-Token': TOKEN } : {}) });

function info() {
  return {
    hostname: os.hostname(), version: VERSION, os: `${os.type()} ${os.release()}`, pid: process.pid, priority: PRIORITY,
    uptimeSec: Math.round((Date.now() - STARTED) / 1000), allowCustom: ALLOW_CUSTOM, signed: !!PASSWORD, busy,
  };
}

async function postResult(reqId, result) {
  await resilientFetch(`${CENTRAL_URL}/api/central/rma-result`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ agent: AGENT, instance: INSTANCE, reqId, result }), timeoutMs: 20_000, retries: 3,
  }).catch((e) => log(`결과 회신 실패 reqId=${reqId}: ${e.message}`));
}

/** 잡 1건 처리 — 검증 실패도 결과로 회신한다(중앙 UI 가 즉시 사유를 본다). */
export async function handleJob(job, { password = PASSWORD, allowCustom = ALLOW_CUSTOM, exec = runCommand, now } = {}) {
  const v = verifyJob(password, { ...job, agent: AGENT }, now);
  if (!v.ok) return { ok: false, reason: v.reason, rejected: true };
  const b = buildCommand(job.cmd, job.args || {}, { allowCustom, timeoutMs: job.timeoutMs });
  if (!b.ok) return { ok: false, reason: b.issue, rejected: true };
  const r = await exec(b, { maxOutput: MAX_OUTPUT });
  return { ...r, cmd: b.preset, argv: b.argv || null, instance: INSTANCE };
}

async function pollOnce() {
  const r = await resilientFetch(`${CENTRAL_URL}/api/central/rma-poll`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ agent: AGENT, instance: INSTANCE, info: info(), wait: LONGPOLL_MS }),
    timeoutMs: LONGPOLL_MS + 15_000, retries: 0,
  });
  if (r.status === 403 || r.status === 404) {
    let reason = ''; try { reason = (await r.json()).reason || ''; } catch { /* */ }
    throw new Error(`중앙 거부 HTTP ${r.status}${reason ? ` — ${reason}` : ''}`);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const { jobs } = await r.json();
  for (const job of jobs || []) {
    busy = true;
    const t0 = Date.now();
    log(`실행 reqId=${job.reqId} cmd=${job.cmd}`);
    let result;
    try { result = await handleJob(job); } catch (e) { result = { ok: false, reason: e.message }; }
    busy = false;
    log(`완료 reqId=${job.reqId} ok=${result.ok}${result.reason ? ` (${result.reason})` : ''} ${Date.now() - t0}ms`);
    await postResult(job.reqId, result);
  }
}

async function main() {
  if (!CENTRAL_URL) { console.error('[rma] CENTRAL_URL 이 비어 있습니다 — portal.env 에 중앙 주소를 설정하세요.'); process.exit(2); }
  if (!TOKEN) { console.error('[rma] CENTRAL_TOKEN/EDGE_TOKEN 이 비어 있습니다 — 이 엣지의 개별 토큰을 설정하세요.'); process.exit(2); }
  log(`시작 agent=${AGENT} instance=${INSTANCE} priority=${PRIORITY} central=${CENTRAL_URL} version=${VERSION} signed=${!!PASSWORD} custom=${ALLOW_CUSTOM} longpoll=${LONGPOLL_MS}ms`);
  if (!PASSWORD) log('⚠ RMA_PASSWORD 미설정 — 서명 없는 명령을 실행합니다. 중앙 토큰만이 방어선이므로 비밀번호 설정을 권장합니다.');
  let backoff = 2_000;
  while (!stopping) {
    try { await pollOnce(); backoff = 2_000; }
    catch (e) {
      log(`폴링 실패: ${e.message} — ${Math.round(backoff / 1000)}초 후 재시도`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(60_000, backoff * 2);
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.on('SIGTERM', () => { stopping = true; log('SIGTERM — 종료'); setTimeout(() => process.exit(0), 200).unref?.(); });
  process.on('SIGINT', () => { stopping = true; process.exit(0); });
  main().catch((e) => { console.error('[rma] 치명적 오류', e); process.exit(1); });
}
