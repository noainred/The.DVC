/**
 * central/bmHwLogPull.js — 물리서버 ‘하드웨어 이벤트 로그’(v3.50)의 **엣지 대행**: 엣지 · 수집 서버가 맡은 서버 한 대의 SEL 을 그 엣지가 읽어 돌려준다
 *   (`GET /api/collector/bm-hwlog` — 중앙이 법인 iDRAC 에 WAN 으로 직접 붙지 않는다 · 루트 CLAUDE.md ‘작업 하나를 법인 쪽에’).
 *
 * 규약(bmPeerPull · bmComparePull 과 같다 — edge.md):
 *   · 같은 url · 같은 토큰(pullFromEdge — 수집 서버 등록부) — 새 포트 · 새 인증 없음 · 보관 없음(중앙은 받기만). 읽기 요청 · 재시도 0.
 *   · 엣지 응답은 정제한다(idrac/hwLog.js sanitizeHwLog — 아는 필드만 · 상한 · 글자 자르기 · 시각은 수신 시각으로).
 *   · 구버전 엣지(경로 없음 → 401/404)는 old-version — 최소 버전 문구는 릴리스 노트의 첫 게시 번호(featureMinEdgeVersion — 숫자를 박지 않는다).
 *   · 장비 시한(30초) + 쪽 예산(20초)보다 긴 당김 시한(40초) — 엣지가 시한으로 끊고 ‘시한 초과’ 를 답할 시간을 둔다.
 */
import { pullFromEdge } from './edgePull.js';
import { reqTimeoutMs } from '../agent/envTimeout.js';
import { hwlogMinEdgeVersion } from './featureMinEdgeVersion.js';
import { sanitizeHwLog } from '../idrac/hwLog.js';
import { capStr } from '../util/capStr.js';   // 상주 문자열 절단은 capStr 하나(TIM2607-01)

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const TIMEOUT_MS = reqTimeoutMs(process.env.BM_HWLOG_PULL_TIMEOUT_MS, 40_000, { min: 10_000 });
export const hwLogBodyOk = (b) => isObj(b) && b.ok === true && Array.isArray(b.rows);

/**
 * @param {string} agent  엣지 이름 · 수집 서버 등록 id
 * @param {{ id?:string, k?:string }} q  id = 그 엣지의 등록부 id(수집 서버 pull 출처) · k = 엣지가 push 에 실은 열쇠(엣지 출처)
 */
export async function pullEdgeHwLog(agent, { id = '', k = '' } = {}) {
  const qs = new URLSearchParams();
  if (id) qs.set('id', capStr(String(id), 128)); else if (k) qs.set('k', capStr(String(k), 128)); else return { ok: false, kind: 'bad-args', reason: '서버를 정하지 못했습니다.' };
  const r = await pullFromEdge(agent, `/api/collector/bm-hwlog?${qs}`, {
    retries: 0, timeoutMs: TIMEOUT_MS, minVersion: hwlogMinEdgeVersion(), what: '하드웨어 이벤트 로그를 읽을', label: '엣지 하드웨어 이벤트 로그 응답', bodyOk: hwLogBodyOk, missing401: true,
  });
  if (!r.ok) {
    // 엣지가 ‘이 엣지의 서버가 아님’ 이라 답했으면(404 + code) 구버전과 가른다
    if (r.kind !== 'old-version' && isObj(r.body) && r.body.code === 'not-found') return { ok: false, kind: 'not-found', reason: '그 엣지의 등록부에서 이 서버를 찾지 못했습니다.' };
    return { ok: false, kind: r.kind, reason: r.reason };
  }
  const body = sanitizeHwLog(r.body);
  return body ? { ok: true, body } : { ok: false, kind: 'bad-body', reason: '엣지 응답 형식이 다릅니다.' };
}
