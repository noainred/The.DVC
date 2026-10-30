/**
 * agent/bareosConfigPull.js — 중앙 → 엣지 Bareos 법인 Director 배정 pull(v2.824 엣지 대행 · 선례 agent/veeamConfigPull.js).
 *
 * 중앙이 이 엣지에 대행을 맡긴 Director(설정 agent = 이 엣지 — **콘솔 비밀번호 포함**: 엣지가 그 법인 Director 에 로그인해야 한다.
 * WAN TLS 검증 ON · 개별 토큰 바인딩은 중앙 미들웨어)를 아웃바운드 GET 으로 받아 엣지 사본(bareos/edgeStore.js —
 * bareos-edge-directors.json)에 반영한다(엣지 자신의 vault 정책으로 재봉인). 엣지 자기 화면의 Bareos 설정(bareos.json)은 건드리지 않는다.
 *  · 비-2xx(503 설정 손상 포함)는 사본을 지우지 않는다 — 중앙이 못 읽은 동안 엣지 대행이 멈추지 않게.
 *  · 바뀌었을 때만 적용(본문 해시 — 메모리에만, 상태·로그에 싣지 않는다). 빠진·접속처가 바뀐 Director 는 이 엣지의 인증 정지 기록을 지운다.
 *  · 무음 실패 금지: `_last` + 콘솔(같은 사유는 10분에 1줄). edgelog/spec.js 에 등재(pull.bareos).
 */
import crypto from 'node:crypto';
import { config, clampIntervalMs } from '../config.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { classifyCentral404 } from './central404.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { readJsonCapped, EDGE_RESPONSE_MAX_BYTES } from '../util/readCapped.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { pullRecoveryNote } from '../util/registryCore.js';
import { applyPulledDirectors, edgeStoreLoadError, loadEdgeDirectors } from '../bareos/edgeStore.js';
import { directorCred } from '../bareos/settings.js';
import { bareosAuthGuard } from '../bareos/service.js';
import { agentHeaders } from './agentNameCarry.js';

export const configPullMs = () => clampIntervalMs(Number(process.env.BAREOS_CONFIG_PULL_MS) || 300_000, 300_000, 60_000);
const _log = createChangeLogger({ windowMs: 10 * 60_000 });
let _timer = null; let _last = null; let _running = null; let _lastSig = '';
let _recovered = null;

/** 주기 pull(본문이 직전과 같으면 사본을 다시 쓰지 않는다). 진행 중인 pull 이 있으면 그 결과를 같이 기다린다. */
export async function pullBareosConfigNow() { return pullShared(false); }

/**
 * 강제 pull — 본문이 직전과 같아도 사본에 다시 적용한다. 대행 워커가 작업의 접속값 표지(connSig)와 사본이 다르거나 사본에 그 Director 가
 * 없을 때 부른다(v2.824 검토 I1·I8 — 엣지가 자동 설정 2단계로 사본을 먼저 바꿨는데 중앙 저장이 실패하면, 같은 본문이라 영영 다시 적용되지 않았다).
 * 진행 중인 pull 이 있으면 끝난 뒤 한 번 더(겹치지 않게).
 */
export function pullBareosConfigForce() { return pullShared(true); }

let _queuedForce = null;
/**
 * v2.825.1 버그 점검(G9 — 재현): 진행 중인 pull 을 기다린 강제 호출들은 **뒤따르는 강제 pull 하나**를 같이 쓴다(예전에는 각자 시작해 3중으로 나갔고,
 * 먼저 끝난 쪽이 `_running` 을 지워 뒤 호출이 공유하지 못했다). `_running` 은 자기 Promise 일 때만 비운다.
 */
function pullShared(force) {
  if (!_running) return startPull(force);
  if (!force) return _running.catch(() => ({ ok: false, reason: '이전 pull 실패' }));
  if (!_queuedForce) {
    const after = _running.catch(() => null);
    _queuedForce = after.then(() => { _queuedForce = null; return _running ? _running.catch(() => null).then(() => startPull(true)) : startPull(true); });
  }
  return _queuedForce;
}
function startPull(force) {
  const p = _pull({ force });
  _running = p;
  const clear = () => { if (_running === p) _running = null; };
  p.then(clear, clear);
  return p;
}

async function _pull({ force = false } = {}) {
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'pull 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  try {
    const url = `${config.agent.centralUrl}/api/central/bareos-config?agent=${encodeURIComponent(config.agent.name || '')}`;
    const res = await resilientFetch(url, { method: 'GET', headers: { 'X-Central-Token': config.agent.centralToken, ...agentHeaders(config.agent.name || '') }, timeoutMs: 20_000, retries: 2 });
    if (res.status === 404) {
      const c = await classifyCentral404(res);
      _last = { ...(_last || {}), at: Date.now(), ok: false, error: c.reason, kind: c.kind };
      if (_log(c.kind, c.reason)) console.warn(`[bareos-config] ${c.reason}`);
      return { ok: false, reason: c.reason, kind: c.kind };
    }
    if (!res.ok) {
      let b = null; try { b = await readJsonCapped(res, 64 * 1024, '중앙 오류 응답'); } catch { try { await res.body?.cancel?.(); } catch { /* */ } }
      throw new Error(`bareos-config <- ${res.status}${b?.reason ? ` ${String(b.reason).slice(0, b?.agentTokenRequired ? 240 : 60)}` : ''} — 직전 Director 사본을 그대로 씁니다`);
    }
    const body = await readJsonCapped(res, EDGE_RESPONSE_MAX_BYTES, 'bareos-config 응답');
    if (!Array.isArray(body?.directors)) throw new Error('bareos-config 응답에 directors 가 없습니다 — 직전 Director 사본을 그대로 씁니다');
    const sig = crypto.createHash('sha256').update(JSON.stringify(body.directors)).digest('hex');
    let applied = null;
    if (force || sig !== _lastSig) {
      const loadErr = edgeStoreLoadError();
      const before = new Map(loadEdgeDirectors().directors.map((d) => [d.id, d]));
      applied = applyPulledDirectors(body.directors, config.agent.name || '');
      if (loadErr) {
        _recovered = pullRecoveryNote(loadErr, { what: 'Bareos 대행 Director 사본(bareos-edge-directors.json)', restored: applied.count });
        console.warn(`[bareos-config] ${_recovered.note}`);
      }
      _lastSig = sig;
      // 빠진·접속처가 바뀐 Director 의 이 엣지 인증 정지 기록은 사실이 아니게 됐다(같은 cred id 로 새 접속처를 막지 않게)
      for (const id of [...applied.removed, ...applied.moved]) { const d = before.get(id); if (d) bareosAuthGuard.clearAuthStop(directorCred(d).id); }
      console.log(`[bareos-config] 중앙 배정 법인 Director 적용: ${applied.count}개${applied.removed.length ? ` · 빠짐 ${applied.removed.length}` : ''}${applied.moved.length ? ` · 접속처 변경 ${applied.moved.length}` : ''}${applied.rejected ? ` · 형식 오류로 버림 ${applied.rejected}` : ''}`);
    }
    _last = { at: Date.now(), ok: true, count: body.directors.length, ...(applied ? { applied: true, rejected: applied.rejected, removed: applied.removed.length, moved: applied.moved.length } : { unchanged: true }) };
    return { ok: true, count: body.directors.length };
  } catch (e) {
    _last = { at: Date.now(), ok: false, error: e.message };
    if (_log('pull', e.message)) console.warn(`[bareos-config] 중앙 Director 배정 pull 실패: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

export function startBareosConfigPull() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  _timer = startAdaptiveTimer(configPullMs, () => pullBareosConfigNow(), { firstDelayMs: 45_000, name: 'Bareos Director 배정 pull' });
}
export function bareosConfigPullStatus() { return { ...(_last || {}), ...(_recovered ? { registryRecovered: _recovered } : {}), intervalMs: configPullMs() }; }
export function _resetForTest() { _last = null; _lastSig = ''; _recovered = null; _running = null; _queuedForce = null; }
