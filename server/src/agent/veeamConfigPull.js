/**
 * agent/veeamConfigPull.js — 중앙 → 엣지 Veeam 서버 배정 pull(v2.751, storageConfigPull 과 같은 축).
 *
 * 중앙이 이 엣지 앞으로 정한 Veeam 서버 목록(**자격증명 포함** — 엣지가 그 법인의 Veeam 에 로그인해야 한다. WAN TLS 검증 ON ·
 * 개별 토큰 바인딩은 중앙 미들웨어)을 아웃바운드 GET 으로 받아 로컬 등록부에 반영한다(엣지 자신의 vault 정책으로 재봉인).
 *  · 비-2xx(503 등록부 손상 포함)는 로컬 사본을 지우지 않는다 — 중앙이 못 읽은 동안 엣지 수집이 멈추지 않게.
 *  · 배정이 바뀌면 곧바로 한 번 수집한다(사람이 등록하고 '언제 보이나' 를 10분 기다리지 않게).
 *  · 무음 실패 금지: `_last` + 콘솔(같은 사유는 10분에 1줄). edgelog/spec.js 에 등재(pull.veeam).
 */
import crypto from 'node:crypto';
import { config, clampIntervalMs } from '../config.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { classifyCentral404 } from './central404.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { readJsonCapped, EDGE_RESPONSE_MAX_BYTES } from '../util/readCapped.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { applyPulledServers } from '../veeam/registry.js';
import { dropResult } from '../veeam/store.js';
import { pollVeeamOnce } from '../veeam/poller.js';
import { agentHeaders } from './agentNameCarry.js';

export const configPullMs = () => clampIntervalMs(Number(process.env.VEEAM_CONFIG_PULL_MS) || 300_000, 300_000, 60_000);
const _log = createChangeLogger({ windowMs: 10 * 60_000 });
let _timer = null; let _last = null; let running = false; let _lastSig = '';

export async function pullVeeamConfigNow() {
  if (running) return { ok: false, busy: true, reason: '이전 pull 진행 중(겹침 방지)' };
  running = true;
  try { return await _pull(); } finally { running = false; }
}

async function _pull() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'pull 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  try {
    const url = `${config.agent.centralUrl}/api/central/veeam-config?agent=${encodeURIComponent(config.agent.name || '')}`;
    const res = await resilientFetch(url, { method: 'GET', headers: { 'X-Central-Token': config.agent.centralToken, ...agentHeaders(config.agent.name || '') }, timeoutMs: 20_000, retries: 2 });
    if (res.status === 404) {
      const c = await classifyCentral404(res);
      _last = { ...(_last || {}), at: Date.now(), ok: false, error: c.reason, kind: c.kind };
      if (_log(c.kind, c.reason)) console.warn(`[veeam-config] ${c.reason}`);
      return { ok: false, reason: c.reason, kind: c.kind };
    }
    if (!res.ok) {
      let b = null; try { b = await readJsonCapped(res, 64 * 1024, '중앙 오류 응답'); } catch { try { await res.body?.cancel?.(); } catch { /* */ } }
      throw new Error(`veeam-config <- ${res.status}${b?.reason ? ` ${String(b.reason).slice(0, 60)}` : ''} — 직전 서버 사본을 그대로 씁니다`);
    }
    const body = await readJsonCapped(res, EDGE_RESPONSE_MAX_BYTES, 'veeam-config 응답');
    const servers = Array.isArray(body?.servers) ? body.servers : [];
    // 서명(비밀번호 포함 본문의 해시)은 '바뀌었나' 판정용으로 메모리에만 둔다 — 상태·로그에 싣지 않는다.
    const sig = crypto.createHash('sha256').update(JSON.stringify(servers)).digest('hex');
    let applied = null;
    if (sig !== _lastSig) {
      applied = applyPulledServers(servers);
      _lastSig = sig;
      for (const id of applied.removed) dropResult(id);
      console.log(`[veeam-config] 중앙 배정 Veeam 서버 적용: ${applied.count}대${applied.removed.length ? ` · 빠짐 ${applied.removed.length}` : ''}${applied.rejected ? ` · 형식 오류로 버림 ${applied.rejected}` : ''}`);
      if (applied.count) pollVeeamOnce().catch(() => {});
    }
    _last = { at: Date.now(), ok: true, count: servers.length, ...(applied ? { applied: true, rejected: applied.rejected, removed: applied.removed.length } : { unchanged: true }) };
    return { ok: true, count: servers.length };
  } catch (e) {
    _last = { at: Date.now(), ok: false, error: e.message };
    if (_log('pull', e.message)) console.warn(`[veeam-config] 중앙 서버 배정 pull 실패: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

export function startVeeamConfigPull() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  _timer = startAdaptiveTimer(configPullMs, () => pullVeeamConfigNow(), { firstDelayMs: 40_000, name: 'Veeam 서버 배정 pull' });
}
export function veeamConfigPullStatus() { return { ...(_last || {}), intervalMs: configPullMs() }; }
