/**
 * agent/isiduConfigPull.js — 중앙 → 엣지 아이실론 디렉터리 사용량 대상 pull(v2.736, cvpConfigPull 패턴).
 *
 * 중앙이 이 엣지 앞으로 정한 대상(엣지가 속한 법인의 아이실론 · 경로 · 주기 — **비밀 없음**: 접속은 엣지 자신의 SSH 키 또는
 * 엣지 스토리지 등록부의 계정)과 '지금 수집' 요청을 아웃바운드 GET 으로 받는다(중앙은 엣지에 명령을 밀어넣을 수 없다).
 *  - 사본은 파일에도 남긴다(재시작 직후 중앙이 안 닿아도 이어서 돈다). 비-2xx(503 설정·등록부 손상 포함)는 사본을 지우지 않는다.
 *  - 대상이 생기면 이 엣지의 SSH 키를 만든다(없을 때만) — 공개키는 다음 push 로 중앙 화면에 나타난다(관리자가 아이실론에 등록).
 *  - '지금 수집' 은 기다리지 않는다(du 는 수십 분이 걸릴 수 있다). 결과 push 는 폴러 적재 뒤 자동이다.
 *  - 무음 실패 금지: `_last` + 콘솔(같은 사유는 10분에 1줄). edgelog/spec.js 에 등재(pull.isidu).
 */
import crypto from 'node:crypto';
import { config, clampIntervalMs } from '../config.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { classifyCentral404 } from './central404.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { readJsonCapped, EDGE_RESPONSE_MAX_BYTES } from '../util/readCapped.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { applyEdgeTargets } from '../isidu/settings.js';
import { ensureKey } from '../isidu/sshKey.js';
import { runNow } from '../isidu/poller.js';
import { agentHeaders } from './agentNameCarry.js';

export const configPullMs = () => clampIntervalMs(Number(process.env.ISIDU_CONFIG_PULL_MS) || 300000, 300000, 60_000);
const _log = createChangeLogger({ windowMs: 10 * 60_000 });
let _timer = null; let _last = null; let running = false; let _lastSig = '';

export async function pullIsiduConfigNow() {
  if (running) return { ok: false, busy: true, reason: '이전 pull 진행 중(겹침 방지)' };
  running = true;
  try { return await _pull(); } finally { running = false; }
}

async function _pull() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'pull 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  try {
    const url = `${config.agent.centralUrl}/api/central/isidu-config?agent=${encodeURIComponent(config.agent.name || '')}`;
    const res = await resilientFetch(url, { method: 'GET', headers: { 'X-Central-Token': config.agent.centralToken, ...agentHeaders(config.agent.name || '') }, timeoutMs: 20_000, retries: 2 });
    if (res.status === 404) {
      const c = await classifyCentral404(res);
      _last = { ...(_last || {}), at: Date.now(), ok: false, error: c.reason, kind: c.kind };
      if (_log(c.kind, c.reason)) console.warn(`[isidu-config] ${c.reason}`);
      return { ok: false, reason: c.reason, kind: c.kind };
    }
    if (!res.ok) {
      let b = null; try { b = await readJsonCapped(res, 64 * 1024, '중앙 오류 응답'); } catch { try { await res.body?.cancel?.(); } catch { /* */ } }
      throw new Error(`isidu-config <- ${res.status}${b?.reason ? ` ${String(b.reason).slice(0, 60)}` : ''} — 직전 대상 사본을 그대로 씁니다`);
    }
    const body = await readJsonCapped(res, EDGE_RESPONSE_MAX_BYTES, 'isidu-config 응답');
    const targets = Array.isArray(body?.targets) ? body.targets : [];
    const sig = crypto.createHash('sha1').update(JSON.stringify([targets, body?.retentionDays ?? null])).digest('hex');
    let applied = null;
    if (sig !== _lastSig) {
      applied = applyEdgeTargets(targets, body?.retentionDays);
      _lastSig = sig;
      if (applied.applied) console.log(`[isidu-config] 중앙 배정 아이실론 대상 적용: ${applied.count}개${applied.removed.length ? ` · 빠짐 ${applied.removed.length}` : ''}${applied.rejected ? ` · 형식 오류로 버림 ${applied.rejected}` : ''}`);
    }
    let keyCreated = false;
    if (targets.some((t) => t && t.auth !== 'device')) {
      try { keyCreated = !!ensureKey().created; } catch (e) { if (_log('key', e.message)) console.warn(`[isidu-config] SSH 키를 만들지 못했습니다: ${e.message}`); }
      // 새 키는 곧바로 중앙 화면에 보여야 관리자가 아이실론에 등록한다(다음 push 주기 10분을 기다리지 않는다).
      if (keyCreated) import('../isidu/push.js').then((m) => m.pushIsiduNow()).catch(() => {});
    }
    const wants = Array.isArray(body?.runNow) ? body.runNow.filter((x) => typeof x === 'string').slice(0, 5) : [];
    let started = null; let queued = null;
    if (wants.length) {
      // runNow 는 시작만 하고 기다리지 않는다(du 는 수십 분) — 시작한 id 만 받아 둔다(원격 실행 응답이 그것을 말한다).
      // v2.741 TIMING-02: 동시 실행 상한을 넘는 요청은 엣지 대기열(queued)에 들어가 앞 조사가 끝나면 차례로 시작한다.
      try {
        const r = await runNow(wants, { trigger: 'central' });
        started = r.started; queued = r.queued || [];
        if (r.notHere.length) console.warn(`[isidu-config] 중앙 요청 수집 중 이 엣지에 없는 대상 ${r.notHere.length}개 — 대상 사본이 아직 갱신되지 않았을 수 있습니다`);
      } catch (e) { console.warn(`[isidu-config] 중앙 요청 수집 실패: ${e.message}`); }
    }
    _last = { at: Date.now(), ok: true, count: targets.length, ...(applied ? { applied: applied.applied, rejected: applied.rejected, removed: applied.removed.length } : { unchanged: true }), ...(keyCreated ? { keyCreated: true } : {}), runRequested: wants.length, ...(queued?.length ? { runQueued: queued.length } : {}) };
    return { ok: true, count: targets.length, runRequested: wants.length, started: started || [], queued: queued || [] };
  } catch (e) {
    _last = { at: Date.now(), ok: false, error: e.message };
    if (_log('pull', e.message)) console.warn(`[isidu-config] 중앙 대상 pull 실패: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

export function startIsiduConfigPull() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  _timer = startAdaptiveTimer(configPullMs, () => pullIsiduConfigNow(), { firstDelayMs: 30_000, name: '아이실론 디렉터리 사용량 대상 pull' });
}
export function isiduConfigPullStatus() { return { ...(_last || {}), intervalMs: configPullMs() }; }
