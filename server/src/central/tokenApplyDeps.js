/**
 * central/tokenApplyDeps.js — 개별 토큰 자동 적용 작업(central/tokenApplyJob.js)의 실제 의존성(v2.776).
 * 작업 본문은 순수하게 두고(테스트가 가짜를 주입) 여기서 실제 모듈을 잇는다.
 */
import { listAgentTokens, issueAgentToken, revokeAgentToken, agentTokensLoadError } from './agentTokens.js';
import { findCollectorByName } from '../collector/registry.js';
import { getCollectorStatus } from '../collector/state.js';
import { listTargetsRaw, saveTarget } from '../agent/deployRegistry.js';
import { forceAgentCentralToken } from '../agent/deploy.js';
import { dispatcherFor } from '../util/resilientFetch.js';
import { readJsonCapped } from '../util/readCapped.js';
import { recordOutbound } from '../util/outboundStats.js';
import { pullStats } from './pullStats.js';
import { capStr } from '../util/capStr.js';

const PUSH_TIMEOUT_MS = 45_000;   // 엣지는 기록 뒤 중앙 확인(최대 15초)까지 하고 답한다
const RESP_MAX = 64 * 1024;

/**
 * 중앙 → 엣지 POST /api/collector/central-token(수집 토큰). 던지지 않는다.
 * 응답 본문은 정제해서 돌려준다(엣지가 보낸 글자는 글자만 · 단계 20개 · 각 300자) — 작업 기록에 그대로 들어간다.
 * @returns {Promise<{ ok:boolean, status:number|null, body:object|null, error?:string }>}
 */
export async function pushTokenToEdge(c, token, { fetchImpl = fetch } = {}) {
  const url = `${String(c.url || '').replace(/\/+$/, '')}/api/collector/central-token`;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(c.token ? { 'X-Collector-Token': c.token } : {}) },
      body: JSON.stringify({ token }),
      dispatcher: dispatcherFor(undefined, PUSH_TIMEOUT_MS),
      redirect: 'manual',   // 토큰을 싣고 다른 주소로 따라가지 않는다(upgradePush 와 같다)
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    let raw = null;
    try { const j = await readJsonCapped(res, RESP_MAX, '엣지 토큰 적용 응답'); if (j && typeof j === 'object' && !Array.isArray(j)) raw = j; } catch { raw = null; }
    recordOutbound(url, { status: res.status, method: 'POST', tag: c.id || c.name || '' });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, body: sanitizeEdgeReply(raw) };
  } catch (e) {
    recordOutbound(url, { error: String(e?.message || e), method: 'POST', tag: c.id || c.name || '' });
    return { ok: false, status: null, body: null, error: capStr(e instanceof Error ? e.message : `${e}`, 200) };
  }
}

const s = (v, n) => (typeof v === 'string' ? capStr(v.replace(/[\r\n]+/g, ' '), n) : '');
/** 엣지 응답 정제(순수) — 아는 필드만. */
export function sanitizeEdgeReply(b) {
  if (!b || typeof b !== 'object') return null;
  const steps = Array.isArray(b.steps) ? b.steps.slice(0, 20).filter((x) => x && typeof x === 'object').map((x) => ({ key: s(x.key, 32), ok: x.ok === true, detail: s(x.detail, 300) })) : [];
  const pr = b.probe && typeof b.probe === 'object' ? { ok: b.probe.ok === true, reason: s(b.probe.reason, 200), yourAgent: s(b.probe.yourAgent, 64) } : null;
  // applied: 엣지의 확정 답(true = 파일·메모리 모두 새 토큰 · false = 바뀐 것 없음). 글자·숫자 등 다른 값은 '모름'(undefined).
  return { ok: b.ok === true, ...(typeof b.applied === 'boolean' ? { applied: b.applied } : {}), reason: s(b.reason, 64), version: s(b.version, 32), hostname: s(b.hostname, 128), steps, probe: pr };
}

/** @param {(o:{action:string,target:string,detail:string})=>void} [audit] 라우트가 실행자를 붙여 넘긴다 */
export function realTokenApplyDeps(audit) {
  return {
    issue: issueAgentToken, revoke: revokeAgentToken, listTokens: listAgentTokens, tokensLoadError: agentTokensLoadError,
    findCollector: findCollectorByName, statusOf: getCollectorStatus, deployTargets: listTargetsRaw, saveTarget,
    pushEdge: (c, token) => pushTokenToEdge(c, token),
    sshApply: forceAgentCentralToken,
    pullStats,   // 반증 F4: '받아들인 요청' 확인
    ...(audit ? { audit } : {}),
  };
}
