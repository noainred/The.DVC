/**
 * veeam/run/ops.js — 백업 실행·관리 작업 표(v2.819). 중앙 직접(dispatch.js)·엣지 대행(agent/veeamRunWorker.js)·엣지 큐(edgeOps.js)가 이 표 하나를 본다.
 * MUTATING = Veeam 의 상태를 바꾸는 작업 — 엣지 큐에서 먼저 가져가고, 시한이 지나 회신이 없으면 '확인 불가'(다시 보내지 않는다).
 */
import * as P from './parse.js';
import { opQuickBackup, opPortalJob, opSessions, opRepos, reasonOf } from './exec.js';
import { opVmPoints, opRestoreVm, opJobExclude, opDeleteBackup } from './manage.js';

export const OPS = Object.freeze({
  quickBackup: opQuickBackup, portalJob: opPortalJob, sessions: opSessions, repos: opRepos,
  vmPoints: opVmPoints, restoreVm: opRestoreVm, jobExclude: opJobExclude, deleteBackup: opDeleteBackup,
});
export const MUTATING = new Set(['quickBackup', 'portalJob', 'restoreVm', 'jobExclude', 'deleteBackup']);

/** 작업 실행(던지지 않는다). */
export async function runOp(server, kind, args = {}, { signal, fetchImpl } = {}) {
  const fn = OPS[kind];
  if (!fn) return { ok: false, reason: `알 수 없는 작업 '${String(kind).slice(0, 40)}'` };
  try { return await fn(server, { ...(args && typeof args === 'object' ? args : {}), signal, fetchImpl }); }
  catch (e) { return P.SANITIZERS[kind]({ ok: false, reason: reasonOf(e), ...(MUTATING.has(kind) ? { unknown: true } : {}) }); }
}
