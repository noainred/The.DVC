/**
 * Bareos 법인 Director 대행 워커(v2.824) — CENTRAL_URL 이 설정된 엣지에서 동작한다(선례 agent/veeamRunWorker.js).
 *  1) 중앙에서 자기 몫 작업을 인출(`GET /api/central/bareos-ops` — 개별 토큰 전용, 5초 폴)
 *  2) **이 엣지의 Director 사본**(bareos/edgeStore.js — 중앙이 배정한 것, 담당 = 나)으로 자기 법인 Director 에 실행
 *     (작업 표 bareos/ops.js — 중앙 직접 실행과 같은 코드 · 자동 설정은 bareos/edgeSetup.js)
 *  3) 결과를 회신(`POST /api/central/bareos-op-result`)
 *
 * 규약(되돌리지 말 것 — server/src/bareos/CLAUDE.md):
 *  · 작업에는 콘솔 비밀번호가 없다(Director id 만). 사본에 없거나 담당이 다른 Director 면 실행하지 않는다(notSent).
 *  · 시한은 중앙이 준 **남은 시간(ttlMs)** 을 받은 시각에 더한다(엣지 시계와 무관) — 지나면 시작하지 않는다(notSent).
 *  · 자동 설정의 secretArgs(SSH·vCenter·새 콘솔 비밀번호)는 이 작업 실행에만 쓰고 저장·로그·상태에 남기지 않는다(회신 사유에서도 가린다).
 *  · 결과 회신만 재시도(resilientFetch 1회) — 작업 자체는 다시 실행하지 않는다(이중 실행 방지). 회신 예산(20초 × 2)은 중앙 여유(MARGIN_MS)보다 짧게.
 *  · 작업의 접속값 표지(connSig)가 사본과 다르면 배정을 **즉시 다시 받고**(pull force) 그래도 다르면 보내지 않는다(v2.824 검토 I1 —
 *    저장 직후 옛 사본으로 실패한 것을 중앙이 새 비밀번호의 인증 정지로 기록했다).
 *  · 빈 자리만큼만 인출한다(동시 OP_CONCURRENCY — 긴 작업 하나가 배치 전체를 붙잡아 다른 Director 작업이 인출 시한을 넘기지 않게, P2).
 *    자동 설정에도 엣지 시한 신호를 넘긴다(P3 — 시한이 지나면 SSH 를 끊고 되돌린다).
 *  · 무음 실패 금지: `_last` + 콘솔(같은 사유 10분에 1줄) + edgelog/spec.js 등재. 인출 재진입 가드.
 */
import { config, clampIntervalMs } from '../config.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { readJsonCapped } from '../util/readCapped.js';
import { agentHeaders, withAgentQuery } from './agentNameCarry.js';
import { edgeDirectorById } from '../bareos/edgeStore.js';
import { runLocalOp } from '../bareos/service.js';
import { OPS } from '../bareos/ops.js';
import { EDGE_MUTATING } from '../bareos/edgeOps.js';
import { runSetupOp, SETUP_KINDS } from '../bareos/edgeSetup.js';
import { isSshAuthError, isSshHostKeyError } from '../proxy/sshExec.js';
import { pullBareosConfigForce } from './bareosConfigPull.js';

const POLL_MS = clampIntervalMs(Number(process.env.AGENT_BAREOS_OP_POLL_MS) || 5_000, 5_000, 1_000);
export const OP_CONCURRENCY = 3;
const AUTH_CODES = new Set(['auth', 'pam', 'tls']);
let timer = null;
let fetching = false;
let inflight = 0;
let _last = null;
const _logChange = createChangeLogger({ windowMs: 10 * 60_000 });
const lc = (s) => String(s ?? '').trim().toLowerCase();

/** 마지막 실행 결과 — edgelog/spec.js 가 화면에 싣는다. 비밀은 담지 않는다. */
export function bareosOpWorkerStatus() { return { pollMs: POLL_MS, ..._last, inflight }; }

function headers() {
  return { 'Content-Type': 'application/json', ...agentHeaders(config.agent.name), ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

/** 이 엣지가 실행해도 되는 Director 인가 — 사본에 있고 담당이 나. 아니면 사유. */
export function localDirectorIssue(dir, agentName = config.agent.name) {
  if (!dir) return '이 엣지에 그 Director 사본이 없습니다(아직 배정을 받지 못했거나 배정이 바뀜).';
  if (lc(dir.agent) !== lc(agentName)) return '이 엣지가 대행하는 Director 가 아닙니다(배정이 바뀜).';
  return null;
}

/** 회신 사유에서 이 작업의 비밀 값을 가린다(원격 출력에 같은 글자가 섞여도 중앙으로 보내지 않게). */
function maskWith(text, secretArgs) {
  let t = String(text ?? '');
  for (const v of Object.values(secretArgs || {})) if (typeof v === 'string' && v.length >= 4) t = t.split(v).join('****');
  return t;
}

/** 오류 → 회신 봉투(던지지 않는 쪽). */
function failOf(e, kind, secretArgs) {
  let code = typeof e?.code === 'string' ? e.code : 'error';
  if (isSshHostKeyError(e)) code = 'ssh-hostkey';
  else if (isSshAuthError(e)) code = 'ssh-auth';
  const reason = maskWith(String(e?.message || e), secretArgs).slice(0, 1800);
  return {
    ok: false, code, reason,
    // 콘솔 로그인 실패만 인증 정지 표지(작업 표 — 자동 설정의 SSH 인증 실패는 콘솔 정지가 아니다)
    ...(!SETUP_KINDS.has(kind) && AUTH_CODES.has(code) ? { authFailed: true } : {}),
    ...(Array.isArray(e?.paths) ? { paths: e.paths } : {}), ...(Array.isArray(e?.files) ? { files: e.files } : {}),
  };
}

async function postResult(id, result) {
  let r;
  try { r = await resilientFetch(withAgentQuery(`${config.agent.centralUrl}/api/central/bareos-op-result`, config.agent.name), { method: 'POST', headers: headers(), body: JSON.stringify({ id, result }), timeoutMs: 20_000, retries: 1 }); }
  catch (e) { return `결과 회신 실패 — ${String(e?.message || e).slice(0, 200)}`; }
  if (r.ok) return null;
  let reason = '';
  try { const b = await r.json(); reason = String(b?.reason || '').slice(0, 200); } catch { /* 본문 없음 */ }
  return `결과 회신 HTTP ${r.status}${reason ? ` — ${reason}` : ''}`;
}

/**
 * 작업 1건 실행(던지지 않는다). receivedAt + ttlMs 가 이 엣지 시계로 본 시한이다.
 * @param {{ receivedAt?, getDirector?, pullNow? }} o pullNow: 접속값 표지가 다를 때 배정을 즉시 다시 받는 함수(테스트 주입)
 */
export async function runBareosEdgeOp(op, { receivedAt = Date.now(), getDirector = edgeDirectorById, pullNow = pullBareosConfigForce } = {}) {
  const kind = String(op?.kind || '');
  if (!OPS[kind] && !SETUP_KINDS.has(kind)) return { ok: false, code: 'not-sent', notSent: true, reason: '알 수 없는 작업' };
  const id = String(op.directorId || '');
  let dir = getDirector(id);
  const want = typeof op.connSig === 'string' ? op.connSig : '';
  if (!dir || (want && dir.connSig !== want)) {
    // 중앙이 접속값을 바꿨거나 방금 배정했는데 이 엣지 사본이 아직 옛 값·없음이다(배정 인출 주기 전 — 검토 I1·I8) — 지금 다시 받아 맞춘다
    try { await pullNow(); } catch { /* 아래에서 다시 본다 */ }
    dir = getDirector(id);
    if (dir && want && dir.connSig !== want) return { ok: false, code: 'not-sent', notSent: true, reason: '이 엣지의 Director 사본이 중앙 접속값과 다릅니다(배정을 다시 받지 못함 — 엣지 로그 pull.bareos 확인). Director 에 보내지 않았습니다.' };
  }
  const issue = localDirectorIssue(dir);
  if (issue) return { ok: false, code: 'not-sent', notSent: true, reason: issue };
  const ttl = Math.max(0, Number(op.ttlMs) || 0);
  const deadlineAt = receivedAt + ttl;
  if (!ttl || Date.now() >= deadlineAt) return { ok: false, code: 'not-sent', notSent: true, reason: '요청 시한이 지나 Director 에 보내지 않았습니다.' };
  const signal = AbortSignal.timeout(Math.max(1_000, deadlineAt - Date.now()));
  const args = op.args && typeof op.args === 'object' ? op.args : {};
  const secretArgs = op.secretArgs && typeof op.secretArgs === 'object' ? op.secretArgs : null;
  try {
    const value = SETUP_KINDS.has(kind) ? await runSetupOp(kind, dir, args, secretArgs || {}, { signal }) : await runLocalOp(dir, kind, args, { signal });   // 둘 다 시한 신호를 받는다
    return { ok: true, value };
  } catch (e) { return failOf(e, kind, secretArgs); }
}

/**
 * 한 번 인출 → 실행 → 회신. 인출만 재진입 가드(fetching)이고 실행은 빈 자리(OP_CONCURRENCY − 실행 중)만큼 — 앞 작업이 끝나기를 기다리지 않고
 * 다음 틱이 남은 자리를 채운다(P2). 돌려주는 Promise 는 이번에 가져간 작업이 모두 회신된 뒤 끝난다(테스트가 기다린다).
 */
export async function runBareosOpWorkerOnce() {
  if (!config.agent.centralUrl) return null;
  if (fetching) return null;
  const free = OP_CONCURRENCY - inflight;
  if (free <= 0) { _last = { ...(_last || {}), at: Date.now(), ok: true, full: true }; return _last; }
  fetching = true;
  let ops; let receivedAt;
  try {
    let r;
    try { r = await resilientFetch(withAgentQuery(`${config.agent.centralUrl}/api/central/bareos-ops?max=${free}`, config.agent.name), { headers: headers(), timeoutMs: 15_000, retries: 1 }); }
    catch (e) { const msg = `인출 실패 — ${String(e?.message || e).slice(0, 200)}`; _last = { at: Date.now(), ok: false, error: msg }; if (_logChange('인출', msg)) console.warn(`[bareos-edge] ${msg}`); return null; }
    receivedAt = Date.now();
    if (!r.ok) {
      let reason = '';
      try { const b = await r.json(); reason = String(b?.reason || '').slice(0, 200); } catch { /* */ }
      const msg = `인출 HTTP ${r.status}${reason ? ` — ${reason}` : ''}`;
      _last = { at: Date.now(), ok: false, error: msg, status: r.status };
      if (_logChange('인출', msg)) console.warn(`[bareos-edge] ${msg}`);
      return null;
    }
    let body;
    try { body = await readJsonCapped(r, 1_048_576, '인출 응답'); } catch (e) { _last = { at: Date.now(), ok: false, error: `인출 응답 형식 오류 — ${String(e?.message || e).slice(0, 120)}` }; return null; }
    ops = (Array.isArray(body?.ops) ? body.ops : []).filter((o) => o && typeof o.id === 'string' && typeof o.kind === 'string').slice(0, free)
      .sort((a, b) => EDGE_MUTATING.has(b.kind) - EDGE_MUTATING.has(a.kind));
    inflight += ops.length;   // 인출 가드 안에서 자리를 잡는다(다음 틱이 같은 자리를 또 쓰지 않게)
  } finally { fetching = false; }
  if (!ops.length) { _last = { at: Date.now(), ok: true, ops: 0 }; return _last; }
  let postErr = null;
  await Promise.all(ops.map(async (op) => {
    try {
      const res = await runBareosEdgeOp(op, { receivedAt });
      op.secretArgs = null;
      console.log(`[bareos-edge] ${op.kind} → ${String(op.directorId).slice(0, 48)}: ${res.ok ? '성공' : `${res.notSent ? '보내지 않음' : '실패'}(${res.code}) — ${String(res.reason || '').slice(0, 160)}`}`);
      postErr = (await postResult(op.id, res)) || postErr;
    } finally { inflight -= 1; }
  }));
  _last = postErr ? { at: Date.now(), ok: false, ops: ops.length, error: postErr } : { at: Date.now(), ok: true, ops: ops.length };
  if (postErr && _logChange('회신', postErr)) console.warn(`[bareos-edge] ${postErr}`);
  return _last;
}

export function startBareosOpWorker() {
  if (!config.agent.centralUrl) return; // 중앙 미설정 → 에이전트 아님
  if (timer) return;
  timer = setInterval(() => runBareosOpWorkerOnce().catch(() => {}), POLL_MS);
  timer.unref?.();
  console.log(`[bareos-edge] 대행 워커 시작(central=${config.agent.centralUrl}, poll=${POLL_MS}ms)`);
}

export function _resetBareosOpWorkerForTest() { _last = null; fetching = false; inflight = 0; }
