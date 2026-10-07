// VM 구성 속성 갱신(B10, v2.697) — 인벤토리 수집 한 주기 안에서 '오래된 VM 부터 상한만큼' 다시 읽는다.
// 수집 데드라인(vcDeadlineMs, 최소 90초)을 먹지 않도록 **시간 예산**(기본 20초)을 넘기면 다음 조각을 시작하지 않는다
// (시작해 놓고 잘리면 그 결과는 버려지므로 — v2.528 세션 예산과 같은 판단). 실패는 격리한다 — 이 갱신이 실패해도
// 인벤토리 수집은 성공이고, 직전 캐시 값은 그대로 남는다(at 으로 낡음이 보인다).
import { config } from '../config.js';
import { VM_CFG_PATHS, VM_DEV_PATHS, parseVmCfgProps, parseVmDeviceHygiene } from './parse.js';
import { pickDue, put, prune, setStatus, statusOf } from './cache.js';
import { createRetryTracker, isRequestTimeout } from '../dscfg/collect.js'; // v2.721(감사 S1-03) — 대상별 재시도 백오프(한 벌)

const CHUNK = 250;
const DEV_CHUNK = 75;
export const VM_CFG_BUDGET_MS = 20_000;
// v2.721(감사 S1-03): 종류(cfg·dev)마다 요청 시한에 걸린 조각의 VM 을 쉬게 한다 — 예전에는 그 VM 들이 at=0 으로 남아
//   매 주기 맨 먼저 다시 골라져 매 주기 요청 시한(최대 30초)을 먹었다. 수집 중단(abort)은 세지 않고, 읽으면 지운다.
const _retry = { cfg: createRetryTracker(), dev: createRetryTracker() };
export function vmCfgRetryOf(vcId, ref, kind = 'cfg') { return _retry[kind]?.get(vcId, ref) || null; }
export function vmCfgRetrySummary(vcId) { return { cfg: _retry.cfg.summary(vcId), dev: _retry.dev.summary(vcId) }; }
/** vCenter 삭제·접속처 변경 때 함께 버린다(hostcfg/cache.js syncVcConfigCaches 에 연결할 것). */
export function dropVcRetry(vcId) { _retry.cfg.drop(vcId); _retry.dev.drop(vcId); }
export function _resetVmCfgRetry() { _retry.cfg.reset(); _retry.dev.reset(); }

async function fetchKind(c, vcId, refs, { kind, paths, chunk, parse, now, budgetEnd, track = {} }) {
  let fetched = 0;
  for (let i = 0; i < refs.length; i += chunk) {
    if (Date.now() >= budgetEnd) return { fetched, cut: refs.length - i };
    const slice = refs.slice(i, i + chunk);
    track.slice = slice; // v2.721(S1-03): 실패하면 이 조각만 쉰다
    const objs = await c.retrieveManyObjectProps('VirtualMachine', slice, paths, chunk);
    const seen = new Set();
    for (const o of objs) {
      seen.add(o.ref);
      put(vcId, o.ref, kind, parse(o.props, now));
      _retry[kind]?.clear(vcId, o.ref);
      fetched += 1;
    }
    // 응답에 없는 ref(그사이 삭제된 VM)는 기록하지 않는다 — 다음 주기 prune 이 정리한다.
  }
  return { fetched, cut: 0 };
}

/**
 * @param {{ retrieveManyObjectProps: Function }} c 로그인된 SOAP 클라이언트
 * @param {string} vcId
 * @param {string[]} vmRefs 이번 인벤토리의 VM moref 전부
 */
export async function refreshVmCfg(c, vcId, vmRefs, { now = Date.now(), budgetMs = VM_CFG_BUDGET_MS, settings = config } = {}) {
  if (!settings.vmCfgScan) return { skipped: 'off' };
  const live = new Set(vmRefs);
  prune(vcId, live);
  _retry.cfg.prune(vcId, live); _retry.dev.prune(vcId, live);
  const budgetEnd = Date.now() + budgetMs;
  const st = statusOf(vcId) || {};
  const out = { cfg: null, dev: null };
  // 경로 오류(InvalidProperty 등)는 같은 요청을 반복해도 결과가 같다 — 그 종류만 갱신 주기만큼 쉰다.
  if (!(st.cfgBackoffUntil > now)) {
    const due = pickDue(vcId, vmRefs.filter((r) => !_retry.cfg.resting(vcId, r, now)), 'cfg', { now, periodMs: settings.vmCfgRefreshMs, max: settings.vmCfgPerCycle });
    if (due.length) {
      const track = {};
      try {
        const r = await fetchKind(c, vcId, due, { kind: 'cfg', paths: VM_CFG_PATHS, chunk: CHUNK, parse: parseVmCfgProps, now, budgetEnd, track });
        out.cfg = { due: due.length, ...r };
        setStatus(vcId, { cfgAt: now, cfgError: null, cfgFetched: r.fetched, cfgCut: r.cut, cfgBackoffVms: _retry.cfg.summary(vcId).backoffTargets });
      } catch (err) {
        const msg = String(err?.message || err).slice(0, 300);
        if (isRequestTimeout(err, c?.signal) && track.slice) _retry.cfg.note(vcId, track.slice, { now, periodMs: settings.vmCfgRefreshMs });
        setStatus(vcId, { cfgError: msg, cfgErrorAt: now, cfgBackoffUntil: /InvalidProperty|InvalidArgument/i.test(msg) ? now + settings.vmCfgRefreshMs : 0, cfgBackoffVms: _retry.cfg.summary(vcId).backoffTargets });
        console.warn(`[vmcfg] ${vcId} VM 구성 속성 갱신 실패: ${msg}`);
        out.cfg = { error: msg };
      }
    }
  }
  if (!(st.devBackoffUntil > now) && Date.now() < budgetEnd) {
    const due = pickDue(vcId, vmRefs.filter((r) => !_retry.dev.resting(vcId, r, now)), 'dev', { now, periodMs: settings.vmDevRefreshMs, max: settings.vmDevPerCycle });
    if (due.length) {
      const track = {};
      try {
        const r = await fetchKind(c, vcId, due, {
          kind: 'dev', paths: VM_DEV_PATHS, chunk: DEV_CHUNK, now, budgetEnd, track,
          parse: (props, at) => parseVmDeviceHygiene(props['config.hardware.device'], at),
        });
        out.dev = { due: due.length, ...r };
        setStatus(vcId, { devAt: now, devError: null, devFetched: r.fetched, devCut: r.cut, devBackoffVms: _retry.dev.summary(vcId).backoffTargets });
      } catch (err) {
        const msg = String(err?.message || err).slice(0, 300);
        if (isRequestTimeout(err, c?.signal) && track.slice) _retry.dev.note(vcId, track.slice, { now, periodMs: settings.vmDevRefreshMs });
        setStatus(vcId, { devError: msg, devErrorAt: now, devBackoffUntil: /InvalidProperty|InvalidArgument/i.test(msg) ? now + settings.vmDevRefreshMs : 0, devBackoffVms: _retry.dev.summary(vcId).backoffTargets });
        console.warn(`[vmcfg] ${vcId} VM 장치 목록 갱신 실패: ${msg}`);
        out.dev = { error: msg };
      }
    }
  }
  return out;
}
