/**
 * Veeam 백업 실행 대행 워커(v2.818) — CENTRAL_URL 이 설정된 엣지에서 동작한다.
 *  1) 중앙에서 자기 몫 작업을 인출(`GET /api/central/veeam-run-ops` — 개별 토큰 전용, 5초 폴)
 *  2) **이 엣지의 등록부 사본**(중앙이 배정한 pulled 서버, 담당 = 나)으로 현지 VBR 에 실행(veeam/run/exec.js — 중앙 직접 실행과 같은 코드)
 *  3) 결과를 회신(`POST /api/central/veeam-run-result`)
 *
 * 규약(되돌리지 말 것):
 *  · 작업에는 비밀번호가 없다(서버 id 만). 배정되지 않은 서버(pulled 아님·담당이 다른 엣지) id 면 실행하지 않는다(notSent).
 *  · 시한은 중앙이 준 **남은 시간(ttlMs)** 을 받은 시각에 더한다(엣지 시계와 무관) — 지나면 상태 변경 요청을 보내지 않는다(반증 검토 F3).
 *    상태 변경 작업을 묶음 맨 앞에서 실행한다(중앙도 그 순서로 준다 — 긴 세션 조회 뒤에 밀려 시한을 넘기지 않게).
 *  · 결과 회신 재시도(resilientFetch 2회)뿐 — 작업 자체는 다시 실행하지 않는다(백업 이중 시작 방지).
 *  · 자격 거부면 이 엣지의 인증 정지에 기록한다(모니터링 폴러와 같은 기록 — 같은 계정).
 *  · 무음 실패 금지: `_last` + 콘솔(같은 사유 10분에 1줄) + edgelog/spec.js 등재. 재진입 가드.
 */
import { config, clampIntervalMs } from '../config.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { readJsonCapped } from '../util/readCapped.js';
import { poolRun } from '../util/pool.js';
import { agentHeaders, withAgentQuery } from './agentNameCarry.js';
import { getServerWithSecret } from '../veeam/registry.js';
import { authGuard } from '../veeam/poller.js';
import { runOp, MUTATING } from '../veeam/run/exec.js';
import { SANITIZERS } from '../veeam/run/parse.js';

const POLL_MS = clampIntervalMs(Number(process.env.AGENT_VEEAM_RUN_POLL_MS) || 5_000, 5_000, 1_000);
const OP_CONCURRENCY = 2;
let timer = null;
let running = false;
let _last = null;
const _logChange = createChangeLogger({ windowMs: 10 * 60_000 });
const lc = (s) => String(s ?? '').trim().toLowerCase();

/** 마지막 실행 결과 — edgelog/spec.js 가 화면에 싣는다. 비밀은 담지 않는다. */
export function veeamRunWorkerStatus() { return { pollMs: POLL_MS, ..._last }; }

function headers() {
  return { 'Content-Type': 'application/json', ...agentHeaders(config.agent.name), ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

/** 이 엣지가 실행해도 되는 서버인가 — 중앙이 배정한(pulled) 사본이고 담당이 나. 아니면 사유. */
export function localServerIssue(server, agentName = config.agent.name) {
  if (!server) return '이 엣지에 그 Veeam 서버 사본이 없습니다(아직 설정을 받지 못했거나 배정이 바뀜).';
  if (server.pulled !== true || lc(server.agent) !== lc(agentName)) return '이 엣지가 담당하는 Veeam 서버가 아닙니다(배정이 바뀜).';
  return null;
}

async function postResult(id, result) {
  let r;
  try { r = await resilientFetch(withAgentQuery(`${config.agent.centralUrl}/api/central/veeam-run-result`, config.agent.name), { method: 'POST', headers: headers(), body: JSON.stringify({ id, result }), timeoutMs: 30_000, retries: 2 }); }
  catch (e) { return `결과 회신 실패 — ${String(e?.message || e).slice(0, 200)}`; }
  if (r.ok) return null;
  let reason = '';
  try { const b = await r.json(); reason = String(b?.reason || '').slice(0, 200); } catch { /* 본문 없음 */ }
  return `결과 회신 HTTP ${r.status}${reason ? ` — ${reason}` : ''}`;
}

/** 작업 1건 실행(던지지 않는다). receivedAt + ttlMs 가 이 엣지 시계로 본 시한이다. */
export async function runEdgeOp(op, { receivedAt = Date.now(), fetchImpl, getServer = getServerWithSecret } = {}) {
  const sanitize = SANITIZERS[op?.kind];
  if (!sanitize) return { ok: false, notSent: true, reason: '알 수 없는 작업' };
  const server = getServer(String(op.serverId || ''));
  const issue = localServerIssue(server);
  if (issue) return sanitize({ ok: false, notSent: true, reason: issue });
  const ttl = Math.max(0, Number(op.ttlMs) || 0);
  const deadlineAt = receivedAt + ttl;
  if (!ttl || Date.now() >= deadlineAt) return sanitize({ ok: false, notSent: true, reason: '요청 시한이 지나 Veeam 에 보내지 않았습니다.' });
  if (MUTATING.has(op.kind) || op.kind === 'sessions') {
    const stop = authGuard.peekAuthStop(server);
    if (stop) return sanitize({ ok: false, notSent: true, reason: `이 엣지에서 Veeam 서버 '${server.name}' 이(가) 인증 실패로 정지 중입니다(${stop.reason}) — 보내지 않았습니다.` });
  }
  const res = await runOp(server, op.kind, { ...(op.args && typeof op.args === 'object' ? op.args : {}), deadlineAt }, { signal: AbortSignal.timeout(Math.max(1_000, deadlineAt - Date.now())), fetchImpl });
  if (res.authFailed) { authGuard.markAuthStopped(server.id, server, res.reason); authGuard.flush?.(); }
  return res;
}

export async function runVeeamRunWorkerOnce({ fetchImpl } = {}) {
  if (!config.agent.centralUrl) return null;
  if (running) return null;
  running = true;
  try {
    let r;
    try { r = await resilientFetch(withAgentQuery(`${config.agent.centralUrl}/api/central/veeam-run-ops`, config.agent.name), { headers: headers(), timeoutMs: 15_000, retries: 1 }); }
    catch (e) { const msg = `인출 실패 — ${String(e?.message || e).slice(0, 200)}`; _last = { at: Date.now(), ok: false, error: msg }; if (_logChange('인출', msg)) console.warn(`[veeam-run-agent] ${msg}`); return null; }
    const receivedAt = Date.now();
    if (!r.ok) {
      let reason = '';
      try { const b = await r.json(); reason = String(b?.reason || '').slice(0, 200); } catch { /* */ }
      const msg = `인출 HTTP ${r.status}${reason ? ` — ${reason}` : ''}`;
      _last = { at: Date.now(), ok: false, error: msg, status: r.status };
      if (_logChange('인출', msg)) console.warn(`[veeam-run-agent] ${msg}`);
      return null;
    }
    let body;
    try { body = await readJsonCapped(r, 1_048_576, '인출 응답'); } catch (e) { _last = { at: Date.now(), ok: false, error: `인출 응답 형식 오류 — ${String(e?.message || e).slice(0, 120)}` }; return null; }
    const ops = (Array.isArray(body?.ops) ? body.ops : []).filter((o) => o && typeof o.id === 'string' && typeof o.kind === 'string').slice(0, 10)
      .sort((a, b) => MUTATING.has(b.kind) - MUTATING.has(a.kind));
    if (!ops.length) { _last = { at: Date.now(), ok: true, ops: 0 }; return _last; }
    let postErr = null;
    await poolRun(ops, OP_CONCURRENCY, async (op) => {
      const res = await runEdgeOp(op, { receivedAt, fetchImpl });
      console.log(`[veeam-run-agent] ${op.kind} → ${op.serverId}: ${res.ok ? '성공' : `${res.unknown ? '결과 모름' : res.notSent ? '보내지 않음' : '실패'} — ${String(res.reason || '').slice(0, 160)}`}`);
      postErr = (await postResult(op.id, res)) || postErr;
    });
    _last = postErr ? { at: Date.now(), ok: false, ops: ops.length, error: postErr } : { at: Date.now(), ok: true, ops: ops.length };
    if (postErr && _logChange('회신', postErr)) console.warn(`[veeam-run-agent] ${postErr}`);
    return _last;
  } finally { running = false; }
}

export function startVeeamRunWorker() {
  if (!config.agent.centralUrl) return; // 중앙 미설정 → 에이전트 아님
  if (timer) return;
  timer = setInterval(() => runVeeamRunWorkerOnce().catch(() => {}), POLL_MS);
  timer.unref?.();
  console.log(`[veeam-run-agent] started (central=${config.agent.centralUrl}, poll=${POLL_MS}ms)`);
}
