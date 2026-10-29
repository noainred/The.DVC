/**
 * veeam/run/dispatch.js — 백업 실행 작업을 **어디서** 실행할지 가르고 인증 정지를 적용한다(v2.818).
 *
 *  · 담당 엣지 없음(agent '') → 이 중앙 노드가 직접(ops.runOp, 종류별 시한).
 *  · 담당 엣지 있음 → edgeOps 큐(엣지가 자기 등록부 사본으로 실행 — 비밀번호를 보내지 않는다).
 *
 * 인증 정지 — 모니터링 폴러와 **같은 기록**(veeam/poller.js authGuard — 같은 계정이다):
 *  · 정지 중이면 백업 실행·세션 확인을 보내지 않는다(틀린 계정으로 반복하면 잠긴다). 엣지 담당 서버는 그 엣지가 올린 마지막 결과의 정지 표지로 본다.
 *  · 실행 중 자격 거부(authFailed)가 나면 정지로 기록한다 — 모니터링도 함께 멈춘다(같은 계정). 비밀번호를 바꾸면 자동으로 풀린다.
 *  · 정지를 푸는 것은 모니터링 쪽(연결 시험·성공한 수집)이다 — 여기서 풀지 않는다.
 */
import { authGuard } from '../poller.js';
import { getRecord } from '../store.js';
import { runOp } from './ops.js';
import { enqueueEdgeOp, RESULT_MS } from './edgeOps.js';
import { SANITIZERS } from './parse.js';

/** 지금 정지 상태인가 — { reason, since } 또는 null. 중앙 담당은 이 노드 기록(지우지 않는 조회), 엣지 담당은 그 엣지가 올린 결과. */
export function authStopOf(server) {
  if (!server) return null;
  if (server.agent) {
    const st = getRecord(server.id)?.result?.authStop;
    return st && typeof st === 'object' ? { reason: String(st.reason || '인증 실패').slice(0, 200), since: Number(st.since) || null } : null;
  }
  const st = authGuard.peekAuthStop(server);
  return st ? { reason: st.reason, since: st.since } : null;
}

/**
 * @param {object} server 등록 항목(중앙 직접이면 비밀 포함 원소 — veeam/registry.js getServerWithSecret)
 * @param {string} kind   ops.OPS 키
 */
export async function dispatchOp(server, kind, args = {}, { signal, fetchImpl } = {}) {
  const sanitize = SANITIZERS[kind] || ((x) => x);
  if (!server) return sanitize({ ok: false, notSent: true, reason: 'Veeam 서버 등록을 찾을 수 없습니다(삭제됨).' });
  if (server.enabled === false) return sanitize({ ok: false, notSent: true, reason: `Veeam 서버 '${server.name}' 은(는) 꺼져 있습니다(설정).` });
  // 저장소 조회(repos)도 같은 계정으로 로그인한다 — 정지 중 반복 클릭이 계정을 잠그지 않게 예외 없이(2차 반증 N8).
  const stop = authStopOf(server);
  if (stop) return { ...sanitize({ ok: false, notSent: true, reason: `Veeam 서버 '${server.name}' 은(는) 인증 실패로 정지 중입니다(${stop.reason}) — 계정을 고치면 풀립니다. 보내지 않았습니다.` }), authStopped: true };
  if (server.agent) return enqueueEdgeOp(server, kind, args);
  const deadline = AbortSignal.timeout(RESULT_MS[kind] || 120_000);
  const r = await runOp(server, kind, { ...args, deadlineAt: Date.now() + (RESULT_MS[kind] || 120_000) - 5_000 }, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline, fetchImpl });
  if (r.authFailed) { authGuard.markAuthStopped(server.id, server, r.reason); authGuard.flush?.(); }
  return r;
}
