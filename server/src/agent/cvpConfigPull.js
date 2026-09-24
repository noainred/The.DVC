/**
 * agent/cvpConfigPull.js — 중앙 → 엣지 CloudVision(CVP) 배포 pull(v2.608, sanSwitchConfigPull 패턴).
 *
 * 중앙이 이 엣지 앞으로 지정한 CVP 목록(자격증명 포함 — 엣지가 CVP 에 로그인해야 한다)·수집 설정·'지금 수집' 요청을
 * 아웃바운드 GET 으로 받는다(폐쇄망/NAT 엣지 — 중앙은 엣지에 명령을 밀어넣을 수 없다).
 *  - 빠진 CVP 는 로컬 상태·DB 행을 지운다(안 지우면 낡은 장비가 매 주기 중앙으로 올라가 유령으로 남는다 — v2.416 #4).
 *  - 설정은 중앙 값(applyCentralSettings) — 엣지가 자기 복사본을 고집하면 중앙에서 바꾼 주기·켜짐이 영원히 안 먹는다.
 *  - '지금 수집' 은 **기다리지 않는다**(한 CVP 가 수 분 걸릴 수 있다 — pull 을 붙잡으면 설정 반영이 밀린다). 수집 뒤 push 는 폴러가 한다.
 *  - 무음 실패 금지: 실패는 `_last` + 콘솔(같은 사유는 10분에 1줄). edgelog/spec.js 에 등재(pull.cvp).
 */
import crypto from 'node:crypto';
import { config, clampIntervalMs } from '../config.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { classifyCentral404 } from './central404.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { readJsonCapped, EDGE_RESPONSE_MAX_BYTES } from '../util/readCapped.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { applyPulledServers, serversForThisNode } from '../cvp/registry.js';
import { applyCentralSettings } from '../cvp/settings.js';
import { dropStatus } from '../cvp/store.js';
import { pruneDevices, LOCAL_AGENT } from '../cvp/db.js';
import { pollCvpOnce } from '../cvp/poller.js';

export const configPullMs = () => clampIntervalMs(Number(process.env.CVP_CONFIG_PULL_MS) || 5 * 60_000, 5 * 60_000, 60_000);
const _log = createChangeLogger({ windowMs: 10 * 60_000 });
let _timer = null;
let _lastSig = '';
let _last = null;
let running = false;

export async function pullCvpConfigNow() {
  if (running) return { ok: false, reason: '이전 pull 진행 중(겹침 방지)' };
  running = true;
  try { return await _pull(); } finally { running = false; }
}

async function _pull() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'pull 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  try {
    const url = `${config.agent.centralUrl}/api/central/cvp-config?agent=${encodeURIComponent(config.agent.name || '')}`;
    const res = await resilientFetch(url, { method: 'GET', headers: { 'X-Central-Token': config.agent.centralToken, 'X-Agent-Name': config.agent.name || '' }, timeoutMs: 20_000, retries: 2 });
    if (res.status === 404) {
      const c = await classifyCentral404(res);
      _last = { ...(_last || {}), at: Date.now(), ok: false, error: c.reason, kind: c.kind };
      if (_log(c.kind, c.reason)) console.warn(`[cvp-config] ${c.reason}`);
      return { ok: false, reason: c.reason, kind: c.kind };
    }
    if (!res.ok) { try { await res.body?.cancel?.(); } catch { /* */ } throw new Error(`cvp-config <- ${res.status}`); }
    const body = await readJsonCapped(res, EDGE_RESPONSE_MAX_BYTES, 'cvp-config 응답');
    const servers = Array.isArray(body?.servers) ? body.servers : [];
    const sig = crypto.createHash('sha1').update(JSON.stringify(servers)).digest('hex');
    let applied = false; let removed = [];
    if (sig !== _lastSig) {
      const r = applyPulledServers(servers);
      removed = r.removed;
      for (const id of removed) dropStatus(id);
      if (removed.length) {
        try { await pruneDevices(LOCAL_AGENT, {}, { cvpIds: serversForThisNode().map((s) => s.id) }); }
        catch (e) { console.warn(`[cvp-config] 빠진 CVP 의 로컬 행 정리 실패: ${e.message}`); }
      }
      _lastSig = sig; applied = true;
      console.log(`[cvp-config] 중앙 배포 CVP 적용: agent=${config.agent.name} ${r.count}대${removed.length ? ` · 빠짐 ${removed.length}` : ''}`);
    }
    let settingsApplied = false;
    if (body?.settings) {
      try { settingsApplied = applyCentralSettings(body.settings); } catch (e) { console.warn(`[cvp-config] 설정 적용 실패: ${e.message}`); }
    }
    const wants = Array.isArray(body?.collectNow) ? body.collectNow.filter((x) => typeof x === 'string').slice(0, 10) : [];
    if (wants.length) {
      pollCvpOnce({ manual: true, only: wants, trigger: 'central-request' })
        .then((r) => { if (!r.ok) console.warn(`[cvp-config] 중앙 요청 수집을 지금 하지 못했습니다(${r.reason}) — 요청은 중앙에서 한 번 더 내려옵니다`); })
        .catch((e) => console.warn(`[cvp-config] 중앙 요청 수집 실패: ${e.message}`));
    }
    _last = { at: Date.now(), ok: true, applied, count: servers.length, removed: removed.length, settingsApplied, collectRequested: wants.length };
    return { ok: true, applied, unchanged: !applied, count: servers.length, removed: removed.length, settingsApplied, collectRequested: wants.length };
  } catch (e) {
    _last = { at: Date.now(), ok: false, error: e.message };
    if (_log('pull', e.message)) console.warn(`[cvp-config] 중앙 설정 pull 실패: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

export function startCvpConfigPull() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  _timer = startAdaptiveTimer(configPullMs, () => pullCvpConfigNow(), { firstDelayMs: 25_000, name: 'CVP 설정 pull' });
}
export function cvpConfigPullStatus() { return { ...(_last || {}), intervalMs: configPullMs() }; }
