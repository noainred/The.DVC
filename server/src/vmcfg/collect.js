// VM 구성 속성 갱신(B10, v2.697) — 인벤토리 수집 한 주기 안에서 '오래된 VM 부터 상한만큼' 다시 읽는다.
// 수집 데드라인(vcDeadlineMs, 최소 90초)을 먹지 않도록 **시간 예산**(기본 20초)을 넘기면 다음 조각을 시작하지 않는다
// (시작해 놓고 잘리면 그 결과는 버려지므로 — v2.528 세션 예산과 같은 판단). 실패는 격리한다 — 이 갱신이 실패해도
// 인벤토리 수집은 성공이고, 직전 캐시 값은 그대로 남는다(at 으로 낡음이 보인다).
import { config } from '../config.js';
import { VM_CFG_PATHS, VM_DEV_PATHS, parseVmCfgProps, parseVmDeviceHygiene } from './parse.js';
import { pickDue, put, prune, setStatus, statusOf } from './cache.js';

const CHUNK = 250;
const DEV_CHUNK = 75;
export const VM_CFG_BUDGET_MS = 20_000;

async function fetchKind(c, vcId, refs, { kind, paths, chunk, parse, now, budgetEnd }) {
  let fetched = 0;
  for (let i = 0; i < refs.length; i += chunk) {
    if (Date.now() >= budgetEnd) return { fetched, cut: refs.length - i };
    const slice = refs.slice(i, i + chunk);
    const objs = await c.retrieveManyObjectProps('VirtualMachine', slice, paths, chunk);
    const seen = new Set();
    for (const o of objs) {
      seen.add(o.ref);
      put(vcId, o.ref, kind, parse(o.props, now));
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
  prune(vcId, new Set(vmRefs));
  const budgetEnd = Date.now() + budgetMs;
  const st = statusOf(vcId) || {};
  const out = { cfg: null, dev: null };
  // 경로 오류(InvalidProperty 등)는 같은 요청을 반복해도 결과가 같다 — 그 종류만 갱신 주기만큼 쉰다.
  if (!(st.cfgBackoffUntil > now)) {
    const due = pickDue(vcId, vmRefs, 'cfg', { now, periodMs: settings.vmCfgRefreshMs, max: settings.vmCfgPerCycle });
    if (due.length) {
      try {
        const r = await fetchKind(c, vcId, due, { kind: 'cfg', paths: VM_CFG_PATHS, chunk: CHUNK, parse: parseVmCfgProps, now, budgetEnd });
        out.cfg = { due: due.length, ...r };
        setStatus(vcId, { cfgAt: now, cfgError: null, cfgFetched: r.fetched, cfgCut: r.cut });
      } catch (err) {
        const msg = String(err?.message || err).slice(0, 300);
        setStatus(vcId, { cfgError: msg, cfgErrorAt: now, cfgBackoffUntil: /InvalidProperty|InvalidArgument/i.test(msg) ? now + settings.vmCfgRefreshMs : 0 });
        console.warn(`[vmcfg] ${vcId} VM 구성 속성 갱신 실패: ${msg}`);
        out.cfg = { error: msg };
      }
    }
  }
  if (!(st.devBackoffUntil > now) && Date.now() < budgetEnd) {
    const due = pickDue(vcId, vmRefs, 'dev', { now, periodMs: settings.vmDevRefreshMs, max: settings.vmDevPerCycle });
    if (due.length) {
      try {
        const r = await fetchKind(c, vcId, due, {
          kind: 'dev', paths: VM_DEV_PATHS, chunk: DEV_CHUNK, now, budgetEnd,
          parse: (props, at) => parseVmDeviceHygiene(props['config.hardware.device'], at),
        });
        out.dev = { due: due.length, ...r };
        setStatus(vcId, { devAt: now, devError: null, devFetched: r.fetched, devCut: r.cut });
      } catch (err) {
        const msg = String(err?.message || err).slice(0, 300);
        setStatus(vcId, { devError: msg, devErrorAt: now, devBackoffUntil: /InvalidProperty|InvalidArgument/i.test(msg) ? now + settings.vmDevRefreshMs : 0 });
        console.warn(`[vmcfg] ${vcId} VM 장치 목록 갱신 실패: ${msg}`);
        out.dev = { error: msg };
      }
    }
  }
  return out;
}
