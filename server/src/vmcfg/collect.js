// VM 구성 속성 갱신(B10, v2.697) — 인벤토리 수집 한 주기 안에서 '오래된 VM 부터 상한만큼' 다시 읽는다.
// 수집 데드라인(vcDeadlineMs, 최소 90초)을 먹지 않도록 **시간 예산**(기본 20초)을 넘기면 다음 조각을 시작하지 않는다
// (시작해 놓고 잘리면 그 결과는 버려지므로 — v2.528 세션 예산과 같은 판단). 실패는 격리한다 — 이 갱신이 실패해도
// 인벤토리 수집은 성공이고, 직전 캐시 값은 그대로 남는다(at 으로 낡음이 보인다).
import { config } from '../config.js';
import { VM_CFG_PATHS, VM_DEV_PATHS, parseVmCfgProps, parseVmDeviceHygiene } from './parse.js';
import { pickDue, put, prune, setStatus, statusOf, get as cacheGet } from './cache.js';
import { createRetryTracker, isRequestTimeout } from '../dscfg/collect.js'; // v2.721(감사 S1-03) — 대상별 재시도 백오프(한 벌)
import { GOS_SOAP_VERSION, detailedApiOk, gosPaths, parseVmGosProps } from '../inventory/guestDetail.js'; // v3.54(실제 OS 1단계)

const CHUNK = 250;
const DEV_CHUNK = 75;
export const VM_CFG_BUDGET_MS = 20_000;
// v2.721(감사 S1-03): 종류(cfg·dev)마다 요청 시한에 걸린 조각의 VM 을 쉬게 한다 — 예전에는 그 VM 들이 at=0 으로 남아
//   매 주기 맨 먼저 다시 골라져 매 주기 요청 시한(최대 30초)을 먹었다. 수집 중단(abort)은 세지 않고, 읽으면 지운다.
const _retry = { cfg: createRetryTracker(), dev: createRetryTracker(), os: createRetryTracker() };
export function vmCfgRetryOf(vcId, ref, kind = 'cfg') { return _retry[kind]?.get(vcId, ref) || null; }
export function vmCfgRetrySummary(vcId) { return { cfg: _retry.cfg.summary(vcId), dev: _retry.dev.summary(vcId), os: _retry.os.summary(vcId) }; }
/** vCenter 삭제·접속처 변경 때 함께 버린다(hostcfg/cache.js CACHE_DROPPERS 가 부른다 — v2.727 감사 F-04 에 연결, 그 전에는 호출부 0). */
export function dropVcRetry(vcId) { _retry.cfg.drop(vcId); _retry.dev.drop(vcId); _retry.os.drop(vcId); }
export function _resetVmCfgRetry() { _retry.cfg.reset(); _retry.dev.reset(); _retry.os.reset(); }

/**
 * 경로 오류(같은 요청을 다시 해도 결과가 같다 — 그 종류만 갱신 주기만큼 쉰다) 판정 — cfg · dev · os 가 한 벌을 쓴다(점검 1회차).
 * SOAP fault 상세 타입(soapClient #call 의 err.fault)을 먼저 보고, 없으면 메시지에서 타입 이름만 찾는다.
 * ⚠ v3.54 첫 판은 os 에만 'version' 단어를 더해 일시 장애 메시지까지 6시간 쉬게 했다(반증 재현) — 단어 하나로 넓히지 말 것.
 */
const PATH_FAULTS = new Set(['InvalidProperty', 'InvalidArgument', 'InvalidRequest']);
export function isPathFault(err) {
  if (PATH_FAULTS.has(err?.fault)) return true;
  return /Invalid(?:Property|Argument|Request)/.test(String(err?.message ?? err ?? '').slice(0, 300));
}

async function fetchKind(c, vcId, refs, { kind, paths, chunk, parse, now, budgetEnd, track = {}, retrieveOpts = undefined }) {
  let fetched = 0;
  for (let i = 0; i < refs.length; i += chunk) {
    if (Date.now() >= budgetEnd) return { fetched, cut: refs.length - i };
    const slice = refs.slice(i, i + chunk);
    track.slice = slice; // v2.721(S1-03): 실패하면 이 조각만 쉰다
    // v3.54: retrieveOpts(예: 이 요청만의 SOAP API 판) — 없으면 예전 호출 그대로(인자 4개).
    const objs = retrieveOpts ? await c.retrieveManyObjectProps('VirtualMachine', slice, paths, chunk, retrieveOpts) : await c.retrieveManyObjectProps('VirtualMachine', slice, paths, chunk);
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
  // 점검 1회차: VM_CFG_SCAN(구성 · 장치)과 VM_OS_SCAN(실제 OS)은 따로 끈다 — 예전에는 앞의 것이 꺼지면 os 도 조용히 꺼졌다.
  const cfgOn = !!settings.vmCfgScan;
  const osOn = !!settings.vmOsScan;
  if (!cfgOn && !osOn) return { skipped: 'off' };
  const live = new Set(vmRefs);
  prune(vcId, live);
  _retry.cfg.prune(vcId, live); _retry.dev.prune(vcId, live); _retry.os.prune(vcId, live);
  const budgetEnd = Date.now() + budgetMs;
  const st = statusOf(vcId) || {};
  const out = { cfg: null, dev: null, os: null };
  // 경로 오류(InvalidProperty 등)는 같은 요청을 반복해도 결과가 같다 — 그 종류만 갱신 주기만큼 쉰다.
  if (cfgOn && !(st.cfgBackoffUntil > now)) {
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
        setStatus(vcId, { cfgError: msg, cfgErrorAt: now, cfgBackoffUntil: isPathFault(err) ? now + settings.vmCfgRefreshMs : 0, cfgBackoffVms: _retry.cfg.summary(vcId).backoffTargets });
        console.warn(`[vmcfg] ${vcId} VM 구성 속성 갱신 실패: ${msg}`);
        out.cfg = { error: msg };
      }
    }
  }
  // v3.54(실제 OS 1단계): 실제 설치 OS(VMware Tools 보고 guestDetailedData) · 어플라이언스 제품 정보(vAppConfig.product).
  //   OS 는 거의 바뀌지 않아 갱신 주기가 길다(기본 6시간). cfg 다음 · dev 앞 — 장치 목록(VM 당 수 KB)이 예산을 먼저 먹지 않게.
  //   guestDetailedData 는 API 8.0.2.0 속성이라 **이 요청만** SOAPAction 을 그 판으로 보낸다(포탈 기본 8.0.0.1). 판이 8.0.2 미만이거나
  //   못 읽은 vCenter 에는 묻지 않는다(asked:false — 화면이 'Tools 가 보고하지 않음' 과 '묻지 않음' 을 가른다).
  //   settings.vmOsScan 이 없는 설정 객체(옛 호출·테스트)는 끈 것으로 본다 — 운영 설정(config.js)은 기본 켜짐.
  if (osOn && !(st.osBackoffUntil > now) && Date.now() >= budgetEnd) {
    // 점검 3회차: 앞 종류가 예산을 다 써 이번 주기를 건너뛰었다 — 사유를 남긴다(화면이 '수집 기록 없음 · 접속 실패 등' 으로 흐리지 않게).
    setStatus(vcId, { osSkippedAt: now, osSkipReason: 'budget' });
  } else if (osOn && !(st.osBackoffUntil > now)) {
    const asked = detailedApiOk(c?.sc?.apiVersion);
    const periodMs = settings.vmOsRefreshMs || 21_600_000;
    const max = settings.vmOsPerCycle || 1_000;
    // 점검 3회차: vCenter 판이 바뀌어 '묻는가(asked)' 가 달라진 VM 은 갱신 주기를 기다리지 않고 먼저 다시 읽는다 — 예전에는 8.0.2 로 올려도
    //   최대 6시간 동안 '판 미달 · 묻지 않음' 이 남았다. 판 · asked 는 대상이 0 이어도 상태에 바로 싣는다.
    const stale = [];
    const rest = [];
    for (const r of vmRefs) {
      if (_retry.os.resting(vcId, r, now)) continue;
      const e = cacheGet(vcId, r)?.os;
      (e && e.asked !== asked ? stale : rest).push(r);
    }
    const due = [...stale.slice(0, max), ...pickDue(vcId, rest, 'os', { now, periodMs, max: Math.max(0, max - stale.length) })];
    setStatus(vcId, { osAsked: asked, osApiVersion: typeof c?.sc?.apiVersion === 'string' ? c.sc.apiVersion.slice(0, 32) : null, osSkipReason: null });
    if (due.length) {
      const track = {};
      try {
        const r = await fetchKind(c, vcId, due, {
          kind: 'os', paths: gosPaths(asked), chunk: CHUNK, now, budgetEnd, track,
          retrieveOpts: asked ? { soapVersion: GOS_SOAP_VERSION } : undefined,
          parse: (props, at) => parseVmGosProps(props, at, { asked }),
        });
        out.os = { due: due.length, asked, ...r };
        setStatus(vcId, { osAt: now, osError: null, osFetched: r.fetched, osCut: r.cut, osAsked: asked, osApiVersion: typeof c?.sc?.apiVersion === 'string' ? c.sc.apiVersion.slice(0, 32) : null, osBackoffVms: _retry.os.summary(vcId).backoffTargets });
      } catch (err) {
        const msg = String(err?.message || err).slice(0, 300);
        if (isRequestTimeout(err, c?.signal) && track.slice) _retry.os.note(vcId, track.slice, { now, periodMs });
        setStatus(vcId, { osError: msg, osErrorAt: now, osAsked: asked, osBackoffUntil: isPathFault(err) ? now + periodMs : 0, osBackoffVms: _retry.os.summary(vcId).backoffTargets });
        console.warn(`[vmcfg] ${vcId} 실제 OS(Tools 보고) 갱신 실패: ${msg}`);
        out.os = { error: msg };
      }
    }
  }
  if (cfgOn && !(st.devBackoffUntil > now) && Date.now() < budgetEnd) {
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
        setStatus(vcId, { devError: msg, devErrorAt: now, devBackoffUntil: isPathFault(err) ? now + settings.vmDevRefreshMs : 0, devBackoffVms: _retry.dev.summary(vcId).backoffTargets });
        console.warn(`[vmcfg] ${vcId} VM 장치 목록 갱신 실패: ${msg}`);
        out.dev = { error: msg };
      }
    }
  }
  return out;
}
