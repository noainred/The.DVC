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
import { lookupEndpointsNow } from '../cvp/endpointNow.js';   // v2.934(C-③)
import { pushCvpNow } from '../cvp/push.js';
import crypto from 'node:crypto';
import { config, clampIntervalMs } from '../config.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { classifyCentral404 } from './central404.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { readJsonCapped, EDGE_RESPONSE_MAX_BYTES } from '../util/readCapped.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { applyPulledServers, serversForThisNode, registryLoadError } from '../cvp/registry.js';
import { pullRecoveryNote } from '../util/registryCore.js'; // v2.744(감사 EDGE-03)
import { applyCentralSettings } from '../cvp/settings.js';
import { dropStatus } from '../cvp/store.js';
import { pruneDevices, LOCAL_AGENT } from '../cvp/db.js';
import { pollCvpOnce } from '../cvp/poller.js';
import { agentHeaders, withAgentQuery } from './agentNameCarry.js'; // v2.629 A6-01: 원문 이름 헤더는 한글 이름에서 fetch 가 던진다

export const configPullMs = () => clampIntervalMs(Number(process.env.CVP_CONFIG_PULL_MS) || 5 * 60_000, 5 * 60_000, 60_000);
const _log = createChangeLogger({ windowMs: 10 * 60_000 });
let _timer = null;
let _lastSig = '';
let _last = null;
let _registryRecovered = null; // v2.744(감사 EDGE-03): 손상 등록부를 중앙 배포분으로 다시 쓴 마지막 기록
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
    const res = await resilientFetch(url, { method: 'GET', headers: { 'X-Central-Token': config.agent.centralToken, ...agentHeaders(config.agent.name || '') }, timeoutMs: 20_000, retries: 2 });
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
      // v2.744(감사 EDGE-03): 손상 등록부를 배포분으로 다시 쓰는 것은 막지 않고(복구) 그 사실을 남긴다 — pullRecoveryNote 머리말.
      const regErr = registryLoadError();
      const r = applyPulledServers(servers);
      if (regErr) {
        _registryRecovered = pullRecoveryNote(regErr, { what: 'CVP 등록부(cvp-servers.json)', restored: r.count });
        console.warn(`[cvp-config] ${_registryRecovered.note}`);
      }
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
    // v2.631(EDGE2631-01 후속): 중앙이 자기 CVP 설정 파일을 못 읽어 설정을 빼고 보냈다 — 현장 설정을 그대로 두고, 그 사실을 남긴다.
    const settingsUnreadable = !!body?.settingsUnreadable;
    if (settingsUnreadable && _log('settings-unreadable', '중앙 설정 손상')) console.warn('[cvp-config] 중앙이 CVP 설정 파일을 읽지 못해 설정을 내려보내지 않았습니다 — 이 엣지의 현장 설정을 그대로 씁니다');
    const wants = Array.isArray(body?.collectNow) ? body.collectNow.filter((x) => typeof x === 'string').slice(0, 10) : [];
    if (wants.length) {
      pollCvpOnce({ manual: true, only: wants, trigger: 'central-request' })
        .then((r) => { if (!r.ok) console.warn(`[cvp-config] 중앙 요청 수집을 지금 하지 못했습니다(${r.reason}) — 요청은 중앙에서 한 번 더 내려옵니다`); })
        .catch((e) => console.warn(`[cvp-config] 중앙 요청 수집 실패: ${e.message}`));
    }
    // v2.934(C-③): EndpointLocation '지금 조회' — 이 엣지 몫 CVP 만(등록부 대조) · MAC 12자만 · 64개 · 한 번에 하나씩(pull 을 기다리게 하지 않는다).
    const epReqs = Array.isArray(body?.epNow) ? body.epNow.filter((x) => x && typeof x.cvpId === 'string' && Array.isArray(x.macs)).slice(0, 10) : [];
    if (epReqs.length) runEndpointRequests(epReqs);
    _last = { at: Date.now(), ok: true, applied, count: servers.length, removed: removed.length, settingsApplied, ...(settingsUnreadable ? { settingsUnreadable: true } : {}), collectRequested: wants.length,
      ...(epReqs.length ? { epRequested: epReqs.length } : {}) };
    return { ok: true, applied, unchanged: !applied, count: servers.length, removed: removed.length, settingsApplied, collectRequested: wants.length };
  } catch (e) {
    _last = { at: Date.now(), ok: false, error: e.message };
    if (_log('pull', e.message)) console.warn(`[cvp-config] 중앙 설정 pull 실패: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

let _epRun = null;
const _epQueue = [];
/**
 * v2.934(C-③): 중앙이 내려보낸 EndpointLocation 요청을 차례로 처리하고 곧바로 push 한다(다음 push 주기를 기다리지 않게). 단일비행.
 *   v2.934 반증 L-4: 실행 중에 온 요청은 버리지 않고 대기열에 붙여 같은 실행이 이어서 처리한다(중앙은 내려보낼 때 큐에서 지운다 —
 *   버리면 로그 없이 사라졌다). 대기열은 CVP 마다 하나로 합친다(MAC 64개).
 */
export function runEndpointRequests(reqs) {
  for (const r of Array.isArray(reqs) ? reqs : []) {
    if (!r || typeof r.cvpId !== 'string' || !Array.isArray(r.macs)) continue;
    const cur = _epQueue.find((x) => x.cvpId === r.cvpId);
    if (cur) cur.macs = [...new Set([...cur.macs, ...r.macs])].slice(0, 64);
    else if (_epQueue.length < 64) _epQueue.push({ cvpId: r.cvpId, macs: r.macs.slice(0, 64) });
  }
  if (_epRun) return _epRun;
  _epRun = (async () => {
    let tried = 0; let done = 0;
    while (_epQueue.length) {
      const r = _epQueue.shift();
      const mine = new Set(serversForThisNode().map((s) => s.id));
      if (!mine.has(r.cvpId)) continue;   // 이 엣지 몫이 아닌 CVP — 등록부가 원천(중앙 요청을 그대로 믿지 않는다)
      const macs = r.macs.filter((m) => typeof m === 'string' && /^[0-9a-f]{12}$/.test(m)).slice(0, 64);
      tried += 1;
      try { const x = await lookupEndpointsNow(r.cvpId, macs); if (x.ok) done += 1; else console.warn(`[cvp-config] EndpointLocation 지금 조회 실패(${r.cvpId}): ${x.reason}`); }
      catch (e) { console.warn(`[cvp-config] EndpointLocation 지금 조회 실패(${r.cvpId}): ${e.message}`); }
    }
    // 실패도 MAC 마다 '오류' 로 저장된다(endpointNow) — 그 사실이 중앙에 닿도록 시도했으면 push 한다.
    if (tried) { try { await pushCvpNow(); } catch (e) { console.warn(`[cvp-config] EndpointLocation 결과 push 실패(다음 주기에 다시 갑니다): ${e.message}`); } }
    return done;
  })().finally(() => { _epRun = null; });
  return _epRun;
}
export function _epQueueForTest() { return _epQueue.map((x) => ({ ...x })); }

export function startCvpConfigPull() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  _timer = startAdaptiveTimer(configPullMs, () => pullCvpConfigNow(), { firstDelayMs: 25_000, name: 'CVP 설정 pull' });
}
export function cvpConfigPullStatus() { return { ...(_last || {}), ...(_registryRecovered ? { registryRecovered: _registryRecovered } : {}), intervalMs: configPullMs() }; }
