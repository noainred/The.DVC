/**
 * agent/sanSwitchConfigPull.js — 중앙→엣지 SAN 스위치 배포 pull(v2.410, storageConfigPull 패턴).
 * 중앙이 이 엣지 앞으로 지정한 스위치 목록(자격증명 포함 — 엣지가 스위치에 로그인해야 한다)을
 * 아웃바운드 GET 으로 주기 수집해 로컬 레지스트리에 반영한다(폐쇄망/NAT 엣지 동작).
 */
import crypto from 'node:crypto';
import { config, clampIntervalMs } from '../config.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { classifyCentral404 } from './central404.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { applyPulledDevices } from '../sanswitch/registry.js';
import { dropSnapshot } from '../sanswitch/store.js';
import { collectDeviceNow, testDeviceConnection } from '../sanswitch/poller.js';
import { applyCentralPerfSettings } from '../sanswitch/perfSettings.js';
import { pushSanSwitchNow } from '../sanswitch/push.js';
import { pollPerfOnce } from '../sanswitch/perfPoller.js';
import { pushPerfNow } from '../sanswitch/perfPush.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
const _log404 = createChangeLogger({ windowMs: 10 * 60_000 }); // v2.600 EDGE2600-06

export const configPullMs = () => clampIntervalMs(Number(process.env.SANSW_CONFIG_PULL_MS) || 5 * 60_000, 5 * 60_000, 60_000); // v2.600 EDGE2600-05: 상태 보고 주기도 실제(상한 적용) 값

let _timer = null;
let _lastSig = '';
let _last = null;
let _perfCollectPush = null; // v2.603 EDGE2603-03: 포트 사용량 '지금 수집' 대행 뒤 push 의 결과
let _collectPush = null; // v2.601 EDGE2601-06: '지금 수집' 직후 push 의 결과(상태 화면·엣지 로그용)

/**
 * v2.601(감사 EDGE2601-06): '지금 수집' 직후 push. 주기 push 가 진행 중이면 `pushSanSwitchNow` 는 `{ok:false,
 * reason:'이전 push 진행 중'}` 을 **던지지 않고** 돌려주는데, 예전에는 `.catch(() => {})` 만 있어 그 거절이 어디에도 남지
 * 않았고 진행 중이던 push 는 재수집 **전** 스냅샷을 보냈다(새 결과는 다음 주기까지 중앙에 없다). 진행 중이면 끝날 때까지
 * 기다렸다가(백그라운드 — pull 을 막지 않는다) 한 번 더 보낸다. 결과는 `_collectPush` 와 콘솔에 남긴다.
 */
const BUSY_REASON = '이전 push 진행 중';
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
export async function pushAfterCollect({ waitMs = 2_000, maxTries = 90 } = {}) {
  let r;
  try { r = await pushSanSwitchNow(); } catch (e) { r = { ok: false, reason: e.message }; }
  if (r?.ok === false && r.reason === BUSY_REASON) {
    _collectPush = { at: Date.now(), ok: null, pending: true, reason: '주기 push 가 진행 중 — 끝난 뒤 다시 보냅니다' };
    const bg = (async () => {
      let tries = 0;
      while (tries++ < maxTries) {
        await sleep(waitMs);
        let x;
        try { x = await pushSanSwitchNow(); } catch (e) { x = { ok: false, reason: e.message }; }
        if (!(x?.ok === false && x.reason === BUSY_REASON)) { recordCollectPush(x, tries); return x; }
      }
      recordCollectPush({ ok: false, reason: `주기 push 가 ${Math.round((waitMs * maxTries) / 1000)}초 넘게 끝나지 않아 다시 보내지 못했습니다 — 다음 주기 push 에 실립니다` }, tries);
      return null;
    })();
    bg.catch(() => {}); // recordCollectPush 가 이미 상태·콘솔에 남긴다
    return { ok: null, pending: true, done: bg };
  }
  recordCollectPush(r, 0);
  return r;
}
function recordCollectPush(r, retries) {
  _collectPush = { at: Date.now(), ok: !!r?.ok, ...(r?.ok ? {} : { reason: r?.reason || '알 수 없음' }), ...(retries ? { retries } : {}) };
  if (!r?.ok) console.warn(`[sanswitch-config] 재수집 결과 push 실패: ${r?.reason || '알 수 없음'}`);
}
// v2.591(3차 감사 PR-7): 실패를 상태뿐 아니라 콘솔에도(같은 사유는 10분에 한 번) — 403·5xx 가 저널 어디에도 안 남았다.
const _logChange = createChangeLogger({ windowMs: 10 * 60_000 });
// 재진입 가드(single-flight) — 수동 실행 API 도 같은 함수를 부르므로 가드를 공유한다.
let running = false;

export async function pullSanSwitchConfigNow(...args) {
  if (running) return { ok: false, reason: '이전 pull 진행 중(겹침 방지)' };
  running = true;
  try { return await _pull(...args); } finally { running = false; }
}

async function _pull() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'pull 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  try {
    const url = `${config.agent.centralUrl}/api/central/sanswitch-config?agent=${encodeURIComponent(config.agent.name || '')}`;
    const res = await resilientFetch(url, { method: 'GET', headers: { 'X-Central-Token': config.agent.centralToken }, timeoutMs: 20_000, retries: 2 });
    // v2.600 EDGE2600-06: 404 본문으로 '중앙이 central 을 끔' 과 '엔드포인트 없음' 을 가르고 상태·콘솔에 남긴다(예전엔 값만 돌려줬다).
    if (res.status === 404) {
      const c = await classifyCentral404(res);
      _last = { ...(_last || {}), at: Date.now(), ok: false, error: c.reason, kind: c.kind };
      if (_log404(c.kind, c.reason)) console.warn(`[sanswitch-config] ${c.reason}`);
      return { ok: false, reason: c.reason, kind: c.kind };
    }
    if (!res.ok) throw new Error(`sanswitch-config <- ${res.status}`);
    const body = await res.json();
    const devices = body?.devices || [];
    const sig = crypto.createHash('sha1').update(JSON.stringify(devices)).digest('hex');
    let applied = false;
    if (sig !== _lastSig) {
      // 중앙에서 빠진 장비의 로컬 스냅샷도 함께 제거(낡은 스냅샷이 매 주기 push 되어 orphan 으로 남는 것 방지).
      applyPulledDevices(devices, { onRemoved: (ids) => ids.forEach((id) => { try { dropSnapshot(id); } catch { /* */ } }) });
      _lastSig = sig;
      applied = true;
      console.log(`[sanswitch-config] 중앙 배포 스위치 적용: agent=${config.agent.name} ${devices.length}대`);
    }
    // 포트 사용량 수집 설정(v2.423): 중앙이 지정한 값을 적용(SANSW_PERF_LOCAL=1 이면 무시). 켜짐이 바뀌면 다음 틱부터 수집.
    let perfApplied = false;
    if (body?.perf) { try { perfApplied = applyCentralPerfSettings(body.perf); if (perfApplied) console.log(`[sanswitch-config] 중앙 포트 사용량 설정 적용: ${JSON.stringify(body.perf)}`); } catch (e) { console.warn(`[sanswitch-config] perf 설정 적용 실패: ${e.message}`); } }
    // '지금 수집' 요청 — 구성이 안 바뀌어도 **매 pull 마다** 처리한다(재수집은 흔한 요청).
    const wants = Array.isArray(body?.collectNow) ? body.collectNow.slice(0, 20) : [];
    let collected = 0;
    for (const id of wants) {
      try { if (await collectDeviceNow(id)) collected++; else console.log(`[sanswitch-config] ${id} 는 이미 수집 중 — 그 결과로 대신합니다`); } catch (e) { console.warn(`[sanswitch-config] 재수집 실패 ${id}: ${e.message}`); }
    }
    if (collected) await pushAfterCollect(); // 결과를 push 주기까지 기다리지 않게(v2.601 EDGE2601-06: 진행 중이면 끝난 뒤 다시)
    // 연결 테스트 대행(v2.421): 중앙 등록 화면의 테스트를 현지에서 실행하고 결과(추적 로그 포함)를 회신한다.
    // pull 자체를 막지 않도록 비동기로 돌린다(테스트는 최대 60초).
    const tests = Array.isArray(body?.testNow) ? body.testNow.slice(0, 5) : [];
    for (const t of tests) runDelegatedTest(t).catch((e) => console.warn(`[sanswitch-config] 테스트 대행 실패 ${t?.id}: ${e.message}`));
    /**
     * 포트 사용량 '지금 수집' 대행(v2.517). 중앙에서 버튼을 누르면 엣지 위임 장비는 이 플래그로만
     * 실행된다(중앙은 엣지에 명령을 밀어넣을 수 없다 — pull 구조).
     *
     * · `force: true` — 설정이 꺼져 있어도 관리자가 눌러 시험할 수 있게(중앙 라우트와 같은 의미론).
     * · **await 하지 않는다** — portperfshow 캡처는 표본 시간(기본 8초)×장비 수라 pull 응답을 붙잡으면
     *   설정 반영·연결 테스트 대행이 그만큼 밀린다. 재진입 가드가 중복 실행을 막는다.
     * · 수집 뒤 즉시 push — 표본이 0건이어도 상태 하트비트가 올라가 중앙이 사유를 본다.
     */
    let perfCollect = false;
    if (body?.perfCollectNow === true) {
      perfCollect = true;
      (async () => {
        const r = await pollPerfOnce({ force: true });
        console.log(`[sanswitch-config] 중앙 요청 포트 사용량 수집: ${r.ok ? `성공 ${r.collected}대 / 실패 ${r.failed}대` : `건너뜀(${r.reason})`}`);
        // v2.603(감사 EDGE2603-03): push 결과를 버리지 않는다 — 예전엔 반환값을 보지 않아 거절·실패가 무음이었다.
        //   pushPerfNow 는 이제 진행 중인 주기 push 가 끝난 뒤 한 번 더 보내고 그 결과를 돌려준다.
        let p;
        try { p = await pushPerfNow(); } catch (e) { p = { ok: false, reason: e.message }; }
        _perfCollectPush = { at: Date.now(), ok: !!p?.ok, ...(p?.ok ? { sent: p.sent ?? 0 } : { reason: p?.reason || '알 수 없음' }) };
        if (!p?.ok) console.warn(`[sanswitch-config] 포트 사용량 수집 결과 push 실패: ${p?.reason || '알 수 없음'}`);
      })().catch((e) => console.warn(`[sanswitch-config] 포트 사용량 수집 대행 실패: ${e.message}`));
    }
    _last = { at: Date.now(), applied, count: devices.length, collectRequested: wants.length, collected, testRequested: tests.length, perfApplied, perfCollect, ...(collected && _collectPush ? { collectPush: _collectPush } : {}) };
    return { ok: true, applied, unchanged: !applied, count: devices.length, collectRequested: wants.length, collected, testRequested: tests.length, perfApplied, perfCollect };
  } catch (e) {
    _last = { at: Date.now(), error: e.message };
    if (_logChange('pull', e.message)) console.warn(`[sanswitch-config] 중앙 설정 pull 실패: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

async function runDelegatedTest(t) {
  const device = t?.device && typeof t.device === 'object' ? t.device : null;
  if (!t?.id || !device) return;
  const result = await testDeviceConnection(device, { timeoutMs: Math.min(120_000, Number(t.timeoutMs) || 60_000), verbose: !!t.verbose, ranOn: config.agent.name || '엣지' });
  const res = await resilientFetch(`${config.agent.centralUrl}/api/central/sanswitch-test-result`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': config.agent.centralToken },
    body: JSON.stringify({ agent: config.agent.name || '', id: t.id, result }), timeoutMs: 20_000, retries: 2,
  });
  if (!res.ok) throw new Error(`sanswitch-test-result <- ${res.status}`);
}

export function startSanSwitchConfigPull() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  _timer = startAdaptiveTimer(configPullMs, () => pullSanSwitchConfigNow(), { firstDelayMs: 20_000, name: 'SAN 스위치 설정 pull' });
}
export function sanSwitchConfigPullStatus() { return { ..._last, ...(_collectPush ? { collectPush: _collectPush } : {}), ...(_perfCollectPush ? { perfCollectPush: _perfCollectPush } : {}), intervalMs: configPullMs() }; }
