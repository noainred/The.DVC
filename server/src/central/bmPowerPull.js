/**
 * central/bmPowerPull.js — 물리서버 원격 전원 조작 · 위치 LED(v3.52 · ⑦ ⑥)의 **엣지 대행**: 엣지 · 수집 서버가 맡은 서버 한 대에 그 엣지가 보낸다
 *   (`POST /api/collector/bm-power` — 중앙이 법인 iDRAC 에 WAN 으로 직접 붙지 않는다 · 루트 CLAUDE.md ‘작업 하나를 법인 쪽에’).
 *
 * 규약(bmHwLogPull 과 같다 — edge.md):
 *   · 같은 url · 같은 토큰(pullFromEdge — 수집 서버 등록부). **상태를 바꾸는 요청이라 재시도 0** — 시한 · 끊김은 ‘장비가 받았는지 모름’ 으로 돌려준다.
 *   · 엣지 응답은 정제한다(idrac/power.js sanitizeDeviceAction — 아는 필드 · 아는 상태만).
 *   · 구버전 엣지(경로 없음 → 401/404)는 old-version — 최소 버전 문구는 릴리스 노트의 첫 게시 번호(featureMinEdgeVersion — 숫자를 박지 않는다).
 *   · 당김 시한(45초)은 장비 시한(30초)보다 길다 — 엣지가 시한으로 끊고 ‘시한 초과’ 를 답할 시간을 둔다.
 */
import { pullFromEdge } from './edgePull.js';
import { reqTimeoutMs } from '../agent/envTimeout.js';
import { remotePowerMinEdgeVersion } from './featureMinEdgeVersion.js';
import { sanitizeDeviceAction } from '../idrac/power.js';
import { capStr } from '../util/capStr.js';   // 상주 문자열 절단은 capStr 하나(TIM2607-01)

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const TIMEOUT_MS = reqTimeoutMs(process.env.BM_POWER_PULL_TIMEOUT_MS, 45_000, { min: 35_000 });
export const powerBodyOk = (b) => isObj(b) && typeof b.ok === 'boolean' && typeof b.status === 'string';

/**
 * @param {string} agent 엣지 이름 · 수집 서버 등록 id
 * @param {{ id?:string, k?:string, kind:'power'|'led', action:string, by?:string, reason?:string }} q
 */
export async function pullEdgePower(agent, { id = '', k = '', kind, action, by = '', reason = '' } = {}) {
  if (!id && !k) return { ok: false, kind: 'bad-args', reason: '서버를 정하지 못했습니다.' };
  const r = await pullFromEdge(agent, '/api/collector/bm-power', {
    method: 'POST', jsonBody: { ...(id ? { id: capStr(String(id), 128) } : { k: capStr(String(k), 128) }), kind, action, by: capStr(String(by), 80), reason: capStr(String(reason), 200) },
    retries: 0, timeoutMs: TIMEOUT_MS, minVersion: remotePowerMinEdgeVersion(), what: '원격 전원 · LED 요청을 보낼', label: '엣지 원격 전원 응답', bodyOk: powerBodyOk, missing401: true,
  });
  if (!r.ok) {
    if (r.kind !== 'old-version' && isObj(r.body) && r.body.code === 'not-found') return { ok: false, kind: 'not-found', reason: '그 엣지의 등록부에서 이 서버를 찾지 못했습니다.' };
    if (r.kind !== 'old-version' && isObj(r.body) && r.body.code === 'disabled') return { ok: false, kind: 'edge-disabled', reason: '그 엣지가 원격 전원 · LED 요청을 켜지 않았습니다(엣지 env BM_POWER_EDGE_ENABLE=true).' };
    if (r.kind !== 'old-version' && isObj(r.body) && r.body.code === 'force-off') return { ok: false, kind: 'edge-force-off', reason: '그 엣지가 강제 재시작 · 강제 끄기를 허용하지 않았습니다(엣지 env BM_POWER_EDGE_FORCE=true).' };
    if (r.kind !== 'old-version' && isObj(r.body) && r.body.code === 'rate') return { ok: false, kind: 'edge-rate', reason: '그 엣지의 10분 상한에 걸렸습니다 — 잠시 뒤 다시.' };
    return { ok: false, kind: r.kind, reason: r.reason };
  }
  const body = sanitizeDeviceAction(r.body);
  return body ? { ok: true, body } : { ok: false, kind: 'bad-body', reason: '엣지 응답 형식이 다릅니다.' };
}
