/**
 * cvp/endpointNow.js — EndpointLocation '지금 조회'(v2.934 C-③) — 이 노드가 그 CVP 에 직접 묻고 로컬 DB 에 적는다.
 *   중앙 직접 수집 CVP(위임 없음)는 중앙 라우트가, 엣지 위임 CVP 는 엣지(cvp-config pull 의 epNow)가 부른다. 데모 CVP 는 합성 결과.
 *   세션 하나 · 시간 예산 · 끝나면 반드시 로그아웃(CVP 동시 세션을 붙잡지 않게).
 */
import { getServerWithSecret } from './registry.js';
import { openSession } from './client.js';
import { lookupEndpoints } from './endpoint.js';
import * as db from './db.js';
import { isMockMode } from '../mock/demo/flags.js';
import { isDemoId, demoEndpoints } from '../mock/demo/cvp.js';
import { cvpAuthGuard, credOf } from './poller.js';

export const EP_NOW_BUDGET_MS = 30_000;

/** @returns {Promise<{ ok:boolean, asked:number, ok?:number, none?:number, errors?:number, unsupported?:boolean, reason?:string }>} */
export async function lookupEndpointsNow(cvpId, macs = [], { budgetMs = EP_NOW_BUDGET_MS, signal = null } = {}) {
  const srv = getServerWithSecret(cvpId);
  if (!srv) return { ok: false, asked: 0, reason: '등록부에 없는 CVP 입니다' };
  const list = [...new Set((Array.isArray(macs) ? macs : []).filter((m) => /^[0-9a-f]{12}$/.test(m)))].slice(0, 64);
  if (!list.length) return { ok: true, asked: 0 };
  let r;
  const demo = isMockMode() && isDemoId(srv.id);
  // v2.934 반증 L-8: 주기 수집이 인증 실패로 멈춘 CVP 에는 버튼으로도 로그인하지 않는다(계정 잠금 위험) — 자격증명을 고치면 풀린다.
  const stop = demo ? null : cvpAuthGuard.authStopFor(credOf(srv));
  if (stop) return { ok: false, asked: list.length, authStopped: true, reason: `인증 실패로 멈춘 CVP 입니다 — 토큰 · 비밀번호를 고치면 다시 묻습니다(${String(stop.reason || '').slice(0, 120)})` };
  if (demo) r = demoEndpoints(list, Date.now());
  else {
    let sess = null;
    const end = Date.now() + budgetMs;   // v2.934 반증 L-6: 남은 시간(예전에는 요청마다 30초가 새로 시작했다)
    try {
      sess = await openSession(srv, { signal, leftMs: () => Math.max(1_000, end - Date.now()) });
      r = await lookupEndpoints(sess, list, { budgetMs, signal });
    } catch (e) {
      const reason = String(e?.message || e).slice(0, 200);
      if (e?.authFailed) cvpAuthGuard.markAuthStopped(srv.id, credOf(srv), reason);
      // v2.934 반증 L-8: 로그인 실패도 MAC 마다 '오류' 로 남긴다 — 엣지 대행이면 push 로 중앙에 닿는다(예전에는 저장 없이 끝나 화면이 영원히 '아직 안 물음').
      const at = Date.now();
      try { await db.saveEndpoints(db.LOCAL_AGENT, srv.id, list.map((mac) => ({ mac, at, status: 'error', reason: `CVP 로그인 실패: ${reason}`, locations: [] }))); } catch { /* DB 못 씀 — 아래 사유로 보고 */ }
      return { ok: false, asked: list.length, reason };
    } finally { try { await sess?.logout(); } catch { /* */ } }
  }
  await db.saveEndpoints(db.LOCAL_AGENT, srv.id, r.results);
  const n = (s) => r.results.filter((x) => x.status === s).length;
  return { ok: true, asked: list.length, found: n('ok'), none: n('none'), errors: n('error'), unsupported: !!r.unsupported, cut: r.cut || 0, ...(r.stopped ? { stopped: r.stopped } : {}) };
}
