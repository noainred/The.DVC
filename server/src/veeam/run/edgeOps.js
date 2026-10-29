/**
 * veeam/run/edgeOps.js — 백업 실행의 엣지 대행 큐(중앙, 인메모리 — v2.818).
 *
 * 담당 엣지가 있는 Veeam 서버(등록부 agent)는 중앙이 직접 호출하지 않는다. 중앙이 작업을 두면 그 엣지의 agent/veeamRunWorker.js 가
 * 5초마다 `GET /api/central/veeam-run-ops` 로 인출해 현지에서 실행하고 `POST /api/central/veeam-run-result` 로 회신한다.
 *
 * 보안·정합(반증 검토 F1·F3 — 되돌리지 말 것):
 *  · 작업에 **비밀번호를 싣지 않는다**. 서버 id 만 보내고, 엣지는 중앙이 이미 배정해 둔 자기 등록부 사본(veeam/registry.js pulled)으로 로그인한다.
 *    v2.747 초안은 등록 항목의 참조를 큐에 들고 있어, 대기 중에 담당 엣지·비밀번호를 바꾸면 **옛 엣지가 새 비밀번호를 받았다**(재현).
 *  · 인출·회신은 엣지별 개별 토큰 전용(라우트). 인출은 자기 몫만, 회신은 그 작업의 대상 엣지만.
 *  · 시한은 **남은 시간(ttlMs)** 으로 보낸다(엣지 시계와 무관) — 엣지는 받은 시각 + ttl 이 지나면 상태 변경 요청을 보내지 않는다(notSent).
 *    중앙은 그보다 여유(MARGIN_MS)만큼 늦게 '모름' 으로 닫는다 — 닫은 뒤 늦게 백업이 시작되는 일이 없게.
 *  · 상태를 바꾸는 작업을 가져간 뒤 회신이 없으면 '결과 모름'(unknown)이다 — 실패로 단정하지 않고 다시 보내지 않는다.
 *  · 회신 결과는 작업 종류의 sanitize 를 반드시 지난다. 가져가지 않은 작업은 '보내지 않음'(notSent).
 */
import crypto from 'node:crypto';
import { SANITIZERS } from './parse.js';
import { MUTATING } from './exec.js';
import { clampIntervalMs } from '../../config.js';

export const PICKUP_MS = clampIntervalMs(Number(process.env.VEEAM_RUN_PICKUP_MS) || 2 * 60_000, 2 * 60_000, 30_000);
/** 가져간 뒤 회신 시한(종류별). 엣지는 이보다 MARGIN_MS 일찍 손을 뗀다. */
export const RESULT_MS = Object.freeze({ quickBackup: 4 * 60_000, portalJob: 5 * 60_000, sessions: 3 * 60_000, repos: 2 * 60_000 });
export const MARGIN_MS = 30_000;
const MAX_PER_AGENT = 50;
const TAKE_MAX = 5;
const _ops = new Map(); // id → op
const lc = (s) => String(s ?? '').trim().toLowerCase();

function finish(op, result) {
  if (op.done) return;
  op.done = true;
  clearTimeout(op.timer);
  _ops.delete(op.id);
  op.resolve(result);
}
function timeoutResult(op) {
  const sanitize = SANITIZERS[op.kind];
  if (op.status === 'queued') {
    return sanitize({ ok: false, notSent: true, reason: `엣지 '${op.agent}' 가 ${Math.round(PICKUP_MS / 1000)}초 안에 요청을 가져가지 않았습니다 — 엣지가 꺼졌거나 백업 실행 워커가 돌지 않습니다(엣지 로그 확인). Veeam 에 보내지 않았습니다.` });
  }
  const sec = Math.round(RESULT_MS[op.kind] / 1000);
  return MUTATING.has(op.kind)
    ? sanitize({ ok: false, unknown: true, reason: `엣지 '${op.agent}' 가 요청을 가져갔지만 ${sec}초 안에 결과를 회신하지 않았습니다 — 백업이 시작됐는지 알 수 없습니다. Veeam 콘솔에서 확인하세요(포탈은 다시 보내지 않습니다).` })
    : sanitize({ ok: false, reason: `엣지 '${op.agent}' 가 요청을 가져갔지만 ${sec}초 안에 결과를 회신하지 않았습니다.` });
}

/**
 * 작업 등록 → 결과 Promise. server 는 등록 항목(id·agent 만 쓴다 — 비밀번호는 큐에 넣지 않는다).
 * @returns {Promise<object>} 정제된 결과(시한이면 ok:false + notSent|unknown)
 */
export function enqueueEdgeOp(server, kind, args = {}) {
  const sanitize = SANITIZERS[kind];
  if (!sanitize) return Promise.resolve({ ok: false, reason: `알 수 없는 작업 '${String(kind).slice(0, 40)}'` });
  const agent = String(server?.agent || '').trim();
  if (!agent || !server?.id) return Promise.resolve(sanitize({ ok: false, notSent: true, reason: '담당 엣지가 없는 서버입니다.' }));
  const mine = [..._ops.values()].filter((o) => lc(o.agent) === lc(agent)).length;
  if (mine >= MAX_PER_AGENT) return Promise.resolve(sanitize({ ok: false, notSent: true, reason: `엣지 '${agent}' 의 대기 작업이 ${MAX_PER_AGENT}개를 넘었습니다 — 엣지가 요청을 가져가지 않고 있습니다.` }));
  return new Promise((resolve) => {
    const op = { id: crypto.randomBytes(9).toString('hex'), agent, serverId: String(server.id), kind, args: args && typeof args === 'object' ? args : {}, status: 'queued', at: Date.now(), resolve, done: false, timer: null };
    _ops.set(op.id, op);
    op.timer = setTimeout(() => finish(op, timeoutResult(op)), PICKUP_MS);
    op.timer.unref?.();
  });
}

/** 이 엣지 몫 대기 작업을 꺼낸다(상태 변경 작업 먼저). 비밀은 없다 — 서버 id 와 남은 시간(ttlMs)뿐. */
export function takeEdgeOps(agentName) {
  const me = lc(agentName);
  if (!me) return [];
  const mineQ = [..._ops.values()].filter((o) => o.status === 'queued' && lc(o.agent) === me)
    .sort((a, b) => (MUTATING.has(b.kind) - MUTATING.has(a.kind)) || (a.at - b.at)).slice(0, TAKE_MAX);
  return mineQ.map((op) => {
    op.status = 'dispatched';
    clearTimeout(op.timer);
    const resultMs = RESULT_MS[op.kind] || 2 * 60_000;
    op.timer = setTimeout(() => finish(op, timeoutResult(op)), resultMs);
    op.timer.unref?.();
    return { id: op.id, kind: op.kind, serverId: op.serverId, args: op.args, ttlMs: resultMs - MARGIN_MS };
  });
}

/** 엣지 회신 — agent 가 그 작업의 대상 엣지와 같아야 한다(남의 결과 위조 차단). */
export function completeEdgeOp(id, agentName, result) {
  const op = _ops.get(String(id ?? ''));
  if (!op) return { ok: true, stale: true };   // 이미 시한으로 끝났거나 모르는 id — 엣지는 지운다(늦은 결과는 반영하지 않는다)
  if (lc(op.agent) !== lc(agentName)) return { ok: false, status: 403, reason: '이 작업의 대상 엣지가 아닙니다.' };
  if (op.status !== 'dispatched') return { ok: false, status: 409, reason: '아직 인출되지 않은 작업입니다.' };
  finish(op, SANITIZERS[op.kind](result));
  return { ok: true };
}

/** 화면·진단용 — 인자·비밀 없이 엣지·종류·상태·나이만. */
export function pendingView() {
  const now = Date.now();
  return [..._ops.values()].map((o) => ({ agent: o.agent, kind: o.kind, status: o.status, ageMs: now - o.at }));
}

export function _resetForTest() { for (const o of _ops.values()) clearTimeout(o.timer); _ops.clear(); }
