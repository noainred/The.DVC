/**
 * cvp/endpointNow.js — EndpointLocation '지금 조회'(v2.929 C-③) — 이 노드가 그 CVP 에 직접 묻고 로컬 DB 에 적는다.
 *   중앙 직접 수집 CVP(위임 없음)는 중앙 라우트가, 엣지 위임 CVP 는 엣지(cvp-config pull 의 epNow)가 부른다. 데모 CVP 는 합성 결과.
 *   세션 하나 · 시간 예산 · 끝나면 반드시 로그아웃(CVP 동시 세션을 붙잡지 않게).
 */
import { getServerWithSecret } from './registry.js';
import { openSession } from './client.js';
import { lookupEndpoints } from './endpoint.js';
import * as db from './db.js';
import { isMockMode } from '../mock/demo/flags.js';
import { isDemoId, demoEndpoints } from '../mock/demo/cvp.js';

export const EP_NOW_BUDGET_MS = 30_000;

/** @returns {Promise<{ ok:boolean, asked:number, ok?:number, none?:number, errors?:number, unsupported?:boolean, reason?:string }>} */
export async function lookupEndpointsNow(cvpId, macs = [], { budgetMs = EP_NOW_BUDGET_MS, signal = null } = {}) {
  const srv = getServerWithSecret(cvpId);
  if (!srv) return { ok: false, asked: 0, reason: '등록부에 없는 CVP 입니다' };
  const list = [...new Set((Array.isArray(macs) ? macs : []).filter((m) => /^[0-9a-f]{12}$/.test(m)))].slice(0, 64);
  if (!list.length) return { ok: true, asked: 0 };
  let r;
  if (isMockMode() && isDemoId(srv.id)) r = demoEndpoints(list, Date.now());
  else {
    let sess = null;
    try {
      sess = await openSession(srv, { signal, leftMs: () => budgetMs });
      r = await lookupEndpoints(sess, list, { budgetMs, signal });
    } catch (e) {
      return { ok: false, asked: list.length, reason: String(e?.message || e).slice(0, 200) };
    } finally { try { await sess?.logout(); } catch { /* */ } }
  }
  await db.saveEndpoints(db.LOCAL_AGENT, srv.id, r.results);
  const n = (s) => r.results.filter((x) => x.status === s).length;
  return { ok: true, asked: list.length, found: n('ok'), none: n('none'), errors: n('error'), unsupported: !!r.unsupported, cut: r.cut || 0 };
}
