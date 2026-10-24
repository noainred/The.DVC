/**
 * agent/centralTokenApply.js — 엣지 쪽: 중앙이 내려준 **개별 central 토큰**을 적용한다(v2.776 — 사용자 요청 "이걸 자동으로 수정하는 기능").
 *
 * 순서(반증 F2·F3 — 확인한 뒤에만 바꾼다):
 *  ① 형식 검사(중앙 agentTokens 가 만드는 base64url 43자 꼴 — 그 밖은 거부) · 중앙 주소(CENTRAL_URL)가 있어야 한다
 *  ② 새 토큰으로 중앙 GET /api/central/health-probe — tokenMode 'agent' 이고 yourAgent 가 이 엣지 이름이어야 확인(실패면 아무것도 안 바꾼다)
 *  ③ 확인된 뒤에만 portal.env 에 AGENT_CENTRAL_TOKEN 기록(엄격 — 읽지 못하면 쓰지 않는다) → 메모리(config.agent.centralToken) 반영
 * ⚠ CENTRAL_TOKEN 은 건드리지 않는다 — 그 키는 이 인스턴스의 /api/central 받는 문(config.central.token)도 정한다.
 *   보내는 토큰만 바꾸는 키가 AGENT_CENTRAL_TOKEN(config.js agent.centralToken 우선순위)이다.
 * ⚠ 토큰 값은 로그·응답·감사 어디에도 싣지 않는다 — 지문(tokenFingerprintParts.short)만.
 * 호출 경로: routes/collector.js POST /api/collector/central-token(수집 토큰 먼저 — tokenFirst).
 */
import { config, currentVersion } from '../config.js';
import { upsertEnvKeyStrict } from '../central/token.js';
import { dispatcherFor } from '../util/resilientFetch.js';
import { readJsonCapped } from '../util/readCapped.js';
import { agentNameHeader } from '../util/agentNameHeader.js';
import { tokenFingerprintParts } from '../util/tokenFingerprint.js';

/** 중앙 agentTokens.issueAgentToken 이 만드는 꼴(32바이트 base64url = 43자). 다른 꼴은 받지 않는다(임의 값 주입 방지). */
export const AGENT_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const ENV_KEY = 'AGENT_CENTRAL_TOKEN';
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_MAX_BYTES = 16 * 1024;

let _busy = false;

/** 기본 확인 — 새 토큰으로 중앙 health-probe. 던지지 않는다. */
export async function probeCentral(token, { centralUrl = config.agent.centralUrl, agent = config.agent.name, fetchImpl = fetch } = {}) {
  const base = String(centralUrl || '').replace(/\/+$/, '');
  const t0 = Date.now();
  try {
    const res = await fetchImpl(`${base}/api/central/health-probe`, {
      headers: { Accept: 'application/json', 'X-Central-Token': token, ...agentNameHeader(agent) },
      dispatcher: dispatcherFor(undefined, PROBE_TIMEOUT_MS),
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    let j = {};
    try { const b = await readJsonCapped(res, PROBE_MAX_BYTES, '중앙 health-probe 응답'); if (b && typeof b === 'object' && !Array.isArray(b)) j = b; } catch { j = {}; }
    const ms = Date.now() - t0;
    const yourAgent = typeof j.yourAgent === 'string' ? j.yourAgent.slice(0, 64) : '';
    const tokenMode = j.tokenMode === 'agent' ? 'agent' : (j.tokenMode === 'shared' ? 'shared' : '');
    if (!res.ok) return { ok: false, status: res.status, ms, reason: `중앙이 새 토큰을 거절했습니다(HTTP ${res.status})` };
    if (tokenMode !== 'agent') return { ok: false, status: res.status, ms, tokenMode, reason: '중앙이 새 토큰을 개별 토큰으로 보지 않습니다(공유 토큰 응답)' };
    if (String(yourAgent).toLowerCase() !== String(agent || '').toLowerCase()) {
      return { ok: false, status: res.status, ms, tokenMode, yourAgent, reason: `중앙은 이 토큰을 엣지 '${yourAgent || '—'}' 의 것으로 봅니다(이 엣지는 '${String(agent || '').slice(0, 64)}')` };
    }
    return { ok: true, status: res.status, ms, tokenMode, yourAgent };
  } catch (e) {
    return { ok: false, status: null, ms: Date.now() - t0, reason: `중앙에 닿지 못했습니다: ${String(e?.message || e).slice(0, 200)}` };
  }
}

/**
 * 적용. 던지지 않는다 — 단계 기록을 돌려준다.
 * v2.776(반증 F2·F3): 순서는 **형식 → 확인 → 기록 → 메모리**다. 확인 함수는 토큰을 인자로 받으므로 먼저 바꿀 필요가 없다 — 예전 판(작업 중)은
 *   확인 전에 파일·메모리를 바꿔, 수집 토큰 보유자가 임의 값을 보내는 동안 이 엣지의 모든 중앙 요청이 그 값으로 나갔고(일시 방해), 되돌리기가
 *   실패하면 확인되지 않은 값이 파일에 남았다. 이제 확인이 실패하면 아무것도 바뀌지 않는다(되돌릴 것이 없다).
 * 응답의 `applied` 가 **확정 답**이다 — true 면 파일·메모리 모두 새 토큰, false 면 둘 다 그대로(중앙은 이것으로 발급 취소를 정한다).
 * @param {{ token:string, probe?:Function, envFile?:string }} p  (probe·envFile 은 테스트 주입)
 * @returns {Promise<{ ok:boolean, applied:boolean, reason?:string, steps:Array<{key:string,ok:boolean,detail:string}>, fp?:string, version:string }>}
 */
export async function applyAgentCentralToken({ token, probe = probeCentral, envFile } = {}) {
  const steps = [];
  const step = (key, ok, detail) => { steps.push({ key, ok, detail: String(detail || '').slice(0, 300) }); };
  const out = (o) => ({ version: currentVersion(), steps, applied: false, ...o });
  const tk = typeof token === 'string' ? token : '';
  if (!AGENT_TOKEN_RE.test(tk)) { step('validate', false, '토큰 형식이 중앙 개별 토큰이 아닙니다'); return out({ ok: false, reason: 'bad-token' }); }
  if (!config.agent.centralUrl) { step('validate', false, '이 엣지에 중앙 주소(CENTRAL_URL)가 없습니다'); return out({ ok: false, reason: 'no-central-url' }); }
  if (_busy) { step('validate', false, '이미 다른 적용이 진행 중입니다'); return out({ ok: false, reason: 'busy' }); }
  _busy = true;
  const fp = tokenFingerprintParts(tk).short || '';
  try {
    step('validate', true, `형식 확인 · 지문 ${fp}`);
    const pr = await probe(tk);
    if (!pr || !pr.ok) {
      step('probe', false, `${(pr && pr.reason) || '중앙 확인 실패'} — 아무것도 바꾸지 않았습니다(이전 토큰으로 계속 동작)`);
      return out({ ok: false, reason: 'probe-failed', fp, probe: pr || null });
    }
    step('probe', true, `중앙 확인 성공 — 개별 토큰 · 이름 ${pr.yourAgent} · ${pr.ms}ms`);
    let saved;
    try {
      saved = envFile ? upsertEnvKeyStrict(ENV_KEY, tk, envFile) : upsertEnvKeyStrict(ENV_KEY, tk);
    } catch (e) {
      step('persist', false, `portal.env 에 쓰지 못했습니다(이전 토큰으로 계속 동작): ${String(e?.message || e).slice(0, 160)}`);
      return out({ ok: false, reason: 'persist-failed', fp, probe: pr });
    }
    process.env[ENV_KEY] = tk;
    config.agent.centralToken = tk;
    step('persist', true, `${saved.file} 에 ${ENV_KEY} 기록 · 메모리 반영(재시작 없음)`);
    return out({ ok: true, applied: true, fp, probe: pr });
  } finally {
    _busy = false;
  }
}

export function _resetForTest() { _busy = false; }
