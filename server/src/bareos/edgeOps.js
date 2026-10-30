/**
 * bareos/edgeOps.js — 법인 Director 작업의 **엣지 대행 큐**(중앙, 인메모리 — v2.824 · 선례 veeam/run/edgeOps.js).
 *
 * 담당 엣지가 있는 Director(settings agent)는 중앙이 직접 접속하지 않는다. 중앙이 작업을 두면 그 엣지의 agent/bareosOpWorker.js 가
 * 5초마다 `GET /api/central/bareos-ops` 로 인출해 자기 Director 에 실행하고 `POST /api/central/bareos-op-result` 로 회신한다.
 *
 * 규칙(되돌리지 말 것 — server/src/bareos/CLAUDE.md):
 *  · 작업에 **콘솔 비밀번호를 싣지 않는다** — Director id 만. 엣지는 중앙이 배정해 둔 자기 사본(bareos-edge-directors.json)으로 로그인한다.
 *  · 자동 설정 대행(사용자 결정 '입력한 SSH·vCenter 비밀번호를 그 작업에만 실어 엣지로 1회 전달')만 `secretArgs` 를 둔다:
 *    중앙 메모리에만 · **엣지가 인출하면 그 즉시 지운다** · 인출 전 시한(SECRET_TTL_MS) 이 지나면 작업째 닫는다 · 목록·상태·로그·감사에 싣지 않는다.
 *  · 인출은 자기 몫만, 회신은 그 작업의 대상 엣지만(라우트가 개별 토큰 agent 로 부른다).
 *  · 시한은 남은 시간(ttlMs)으로 보낸다 — 엣지는 받은 시각 + ttl 이 지나면 시작하지 않는다(notSent). 중앙은 그보다 MARGIN_MS 늦게 닫는다.
 *  · 상태를 바꾸는 작업(ops.js MUTATING · 자동 설정)을 가져간 뒤 회신이 없으면 '결과 모름'(unknown) — 다시 보내지 않는다.
 *  · 회신은 sanitizeEdgeResult 를 반드시 지난다.
 */
import crypto from 'node:crypto';
import { sanitizeEdgeResult, VALUE } from './edgeResult.js';
import { MUTATING } from './ops.js';
import { clampIntervalMs } from '../config.js';

export const PICKUP_MS = clampIntervalMs(Number(process.env.BAREOS_EDGE_PICKUP_MS) || 120_000, 120_000, 30_000);
/** 자동 설정 비밀이 중앙 메모리에 머무는 최대 시간(인출 전) — 계획서 2-3 '시한 2분'. */
export const SECRET_TTL_MS = 120_000;
export const MARGIN_MS = 30_000;
/**
 * 가져간 뒤 회신 시한(종류별). 엣지는 이보다 MARGIN_MS 일찍 손을 뗀다. 자동 설정은 SSH 세션 예산(autoSetup BUDGET.sessionMs 420초) + 여유 —
 * autoSetup 을 import 하지 않는다(service ↔ autoSetup 순환 — 모듈 평가 순서). 값의 관계는 테스트가 대조한다.
 */
export const RESULT_MS = Object.freeze({
  probe: 90_000, catalog: 120_000, addJobs: 300_000, disableJobs: 120_000, runJob: 90_000, setEnabled: 90_000, history: 120_000,
  cancel: 90_000, log: 120_000, restore: 180_000, poll: 150_000,
  'setup.preflight': 180_000, 'setup.director': 480_000, 'setup.fdPlugin': 480_000,
  'setup.fdIni': 240_000, 'setup.thumbprint': 120_000,
});
const SETUP = new Set(['setup.director', 'setup.fdPlugin', 'setup.fdIni']);
/** 상태를 바꾸는 작업(회신이 없으면 결과 모름). */
export const EDGE_MUTATING = new Set([...MUTATING, ...SETUP]);
const MAX_PER_AGENT = 50;
const TAKE_MAX = 5;
const _ops = new Map(); // id → op
const lc = (s) => String(s ?? '').trim().toLowerCase();

function finish(op, result) {
  if (op.done) return;
  op.done = true;
  clearTimeout(op.timer);
  op.secretArgs = null;
  _ops.delete(op.id);
  op.resolve(result);
}
function timeoutResult(op) {
  if (op.status === 'queued') {
    return { ok: false, code: 'not-sent', notSent: true, reason: `법인 엣지 '${op.agent}' 가 ${Math.round((op.secretArgs ? Math.min(PICKUP_MS, SECRET_TTL_MS) : PICKUP_MS) / 1000)}초 안에 요청을 가져가지 않았습니다 — 엣지가 꺼졌거나 Bareos 대행 워커가 돌지 않습니다(엣지 로그 확인). Director 에 보내지 않았습니다.` };
  }
  const sec = Math.round((RESULT_MS[op.kind] || 120_000) / 1000);
  return EDGE_MUTATING.has(op.kind)
    ? { ok: false, code: 'unknown', unknown: true, reason: `법인 엣지 '${op.agent}' 가 요청을 가져갔지만 ${sec}초 안에 결과를 회신하지 않았습니다 — 실행됐는지 알 수 없습니다. Director·서버에서 확인하세요(포탈은 다시 보내지 않습니다).` }
    : { ok: false, code: 'timeout', reason: `법인 엣지 '${op.agent}' 가 요청을 가져갔지만 ${sec}초 안에 결과를 회신하지 않았습니다.` };
}

/**
 * 작업 등록 → 결과 Promise(정제된 봉투). director 는 설정 항목(id·agent 만 쓴다 — 비밀번호는 큐에 넣지 않는다).
 * @param {{ secretArgs?: object, signal?: AbortSignal }} [o] secretArgs 는 자동 설정 대행만(인출 때 한 번 넘기고 지운다).
 *   signal: 부르는 쪽이 기다림을 그만두면(폴러 시한) 아직 가져가지 않은 작업은 거둔다(notSent) — 가져간 작업은 회신을 기다리지 않고 버린다.
 */
export function enqueueEdgeOp(director, kind, args = {}, { secretArgs = null, signal = null } = {}) {
  if (!VALUE[kind]) return Promise.resolve({ ok: false, code: 'error', reason: `알 수 없는 작업 '${String(kind).slice(0, 40)}'` });
  const agent = String(director?.agent || '').trim();
  if (!agent || !director?.id) return Promise.resolve({ ok: false, code: 'not-sent', notSent: true, reason: '담당 엣지가 없는 Director 입니다.' });
  if (secretArgs && !SETUP.has(kind) && kind !== 'setup.preflight' && kind !== 'setup.thumbprint') return Promise.resolve({ ok: false, code: 'error', reason: '비밀 인자는 자동 설정 대행에만 싣습니다.' });
  const mine = [..._ops.values()].filter((o) => lc(o.agent) === lc(agent)).length;
  if (mine >= MAX_PER_AGENT) return Promise.resolve({ ok: false, code: 'not-sent', notSent: true, reason: `법인 엣지 '${agent}' 의 대기 작업이 ${MAX_PER_AGENT}개를 넘었습니다 — 엣지가 요청을 가져가지 않고 있습니다.` });
  return new Promise((resolve) => {
    const op = {
      id: crypto.randomBytes(9).toString('hex'), agent, directorId: String(director.id), kind, args: args && typeof args === 'object' ? args : {},
      secretArgs: secretArgs && typeof secretArgs === 'object' ? { ...secretArgs } : null, status: 'queued', at: Date.now(), resolve, done: false, timer: null,
    };
    _ops.set(op.id, op);
    op.timer = setTimeout(() => finish(op, timeoutResult(op)), op.secretArgs ? Math.min(PICKUP_MS, SECRET_TTL_MS) : PICKUP_MS);
    op.timer.unref?.();
    if (signal) {
      const onAbort = () => finish(op, op.status === 'queued'
        ? { ok: false, code: 'not-sent', notSent: true, reason: '기다리는 쪽이 시한으로 그만두었습니다 — 엣지에 보내지 않았습니다.' }
        : (EDGE_MUTATING.has(op.kind) ? { ok: false, code: 'unknown', unknown: true, reason: '기다리는 쪽이 시한으로 그만두었습니다 — 엣지가 실행 중일 수 있습니다.' } : { ok: false, code: 'timeout', reason: '기다리는 쪽이 시한으로 그만두었습니다.' }));
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** 이 엣지 몫 대기 작업을 꺼낸다(상태 변경 먼저). 콘솔 비밀번호는 없다 — Director id·남은 시간(ttlMs)·(자동 설정이면) 1회용 secretArgs. */
export function takeEdgeOps(agentName) {
  const me = lc(agentName);
  if (!me) return [];
  const mineQ = [..._ops.values()].filter((o) => o.status === 'queued' && lc(o.agent) === me)
    .sort((a, b) => (EDGE_MUTATING.has(b.kind) - EDGE_MUTATING.has(a.kind)) || (a.at - b.at)).slice(0, TAKE_MAX);
  return mineQ.map((op) => {
    op.status = 'dispatched';
    clearTimeout(op.timer);
    const resultMs = RESULT_MS[op.kind] || 120_000;
    op.timer = setTimeout(() => finish(op, timeoutResult(op)), resultMs);
    op.timer.unref?.();
    const secretArgs = op.secretArgs;
    op.secretArgs = null;   // 인출 응답 한 번에만 — 중앙 메모리에서 바로 지운다
    return { id: op.id, kind: op.kind, directorId: op.directorId, args: op.args, ttlMs: resultMs - MARGIN_MS, ...(secretArgs ? { secretArgs } : {}) };
  });
}

/** 엣지 회신 — agent 가 그 작업의 대상 엣지와 같아야 한다(남의 결과 위조 차단). */
export function completeEdgeOp(id, agentName, result) {
  const op = _ops.get(String(id ?? ''));
  if (!op) return { ok: true, stale: true };   // 이미 시한으로 끝났거나 모르는 id — 늦은 결과는 반영하지 않는다
  if (lc(op.agent) !== lc(agentName)) return { ok: false, status: 403, reason: '이 작업의 대상 엣지가 아닙니다.' };
  if (op.status !== 'dispatched') return { ok: false, status: 409, reason: '아직 인출되지 않은 작업입니다.' };
  finish(op, sanitizeEdgeResult(op.kind, result));
  return { ok: true };
}

/** 화면·진단용 — 인자·비밀 없이 엣지·Director·종류·상태·나이만. */
export function pendingView() {
  const now = Date.now();
  return [..._ops.values()].map((o) => ({ agent: o.agent, directorId: o.directorId, kind: o.kind, status: o.status, ageMs: now - o.at }));
}
/** 이 Director 에 아직 끝나지 않은 작업(종류)이 있는가 — 폴러가 엣지 Director 에 poll 을 겹쳐 넣지 않게. */
export function hasPending(directorId, kind) { return [..._ops.values()].some((o) => o.directorId === directorId && o.kind === kind); }

export function _resetForTest() { for (const o of _ops.values()) clearTimeout(o.timer); _ops.clear(); }
export function _peekForTest() { return [..._ops.values()].map((o) => ({ ...o, resolve: undefined, timer: undefined })); }
