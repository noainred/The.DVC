// 호스트 구성 갱신(v2.699) — 인벤토리 수집 한 주기 안에서 '오래된 호스트부터 상한만큼' 다시 읽는다.
// 시간 예산(기본 15초)을 넘기면 다음 호스트를 시작하지 않는다(시작해 놓고 잘리면 버려진다 — v2.528 판단). 시작한 호스트는 끝까지 읽는다(v2.720 R1-01).
// 실패는 격리한다 — 이 갱신이 실패해도 인벤토리 수집은 성공이고, 직전 캐시 값은 그대로(at 으로 낡음이 보인다).
import { config } from '../config.js';
import { poolSettled } from '../util/pool.js';
import { HOST_CFG_PATHS, HOST_LOCKDOWN_PATH, HOST_VSAN_PATHS, HOST_MP_PATH, HOST_NET_PATHS, ADV_OPTIONS, parseHostCfgProps, parseOptionValue, parseCertInfo, applyAdvanced } from './parse.js';
import { pickDue, put, prune, setStatus, statusOf, noteTransientFail, HOST_FAIL_MAX } from './cache.js';

export const HOST_CFG_BUDGET_MS = 15_000;
const OPTIONAL_GROUPS = [
  { flag: 'noLockdownPath', label: '잠금 모드', paths: [HOST_LOCKDOWN_PATH], chunk: 100 },
  { flag: 'noVsanPath', label: 'vSAN 런타임', paths: HOST_VSAN_PATHS, chunk: 100 },
  { flag: 'noMultipathPath', label: '멀티패스', paths: [HOST_MP_PATH], chunk: 10 },
  { flag: 'noNetPath', label: '가상 스위치·포트그룹', paths: HOST_NET_PATHS, chunk: 20 }, // v2.701(A10) — 포트그룹이 많으면 응답이 커서 20대씩
];
const CONCURRENCY = 4;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isPathErr = (m) => /InvalidProperty|InvalidArgument/i.test(m);
// v2.719(감사 S1-03): 수집 중단·요청 시한 실패 — '그 값이 없다' 가 아니라 '이번에 못 읽었다' 다(캐시에 '방금 읽음' 으로 넣지 않는다).
export function isTransientErr(err, signal = null) {
  if (signal?.aborted) return true;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return true;
  return /abort|timed? ?out|timeout|데드라인|시한|중단/i.test(String(err?.message || err || ''));
}
// v2.720(감사 R1-02): 일시 실패 중 '그 호스트 요청이 시한에 걸렸다' 만 고른다 — 이것만 호스트별로 쉬었다가 다시 시도한다.
//   수집 중단(abort)은 그 호스트 탓이 아니므로 세지 않는다. Node 의 AbortSignal.timeout 은 이름이 TimeoutError 이고
//   문구에 'aborted' 가 들어 있으므로 이름을 먼저 본다.
export function isTimeoutErr(err, signal = null) {
  if (signal?.aborted) return false;
  if (err?.name === 'TimeoutError') return true;
  if (err?.name === 'AbortError') return false;
  return /timed? ?out|timeout|데드라인|시한/i.test(String(err?.message || err || ''));
}

async function queryOption(c, optRef, name) {
  try {
    const xml = await c.callRaw(`<QueryOptions xmlns="urn:vim25"><_this type="OptionManager">${esc(optRef)}</_this><name>${esc(name)}</name></QueryOptions>`);
    return parseOptionValue(xml, name);
  } catch (err) {
    if (/InvalidName/i.test(String(err?.message || err))) return null; // 그 버전에 없는 설정 — 그 값만 모름
    throw err;
  }
}
async function queryAcceptance(c, imgRef) {
  const xml = await c.callRaw(`<QueryHostAcceptanceLevel xmlns="urn:vim25"><_this type="HostImageConfigManager">${esc(imgRef)}</_this></QueryHostAcceptanceLevel>`);
  const m = /<returnval[^>]*>([^<]*)<\/returnval>/.exec(xml || '');
  return m ? m[1].trim().slice(0, 32) || null : null;
}

/**
 * @param {{ retrieveManyObjectProps: Function, callRaw: Function }} c 로그인된 SOAP 클라이언트
 * @param {string} vcId
 * @param {string[]} hostRefs 이번에 읽을 수 있는 호스트(연결된 호스트) · opts.allRefs = 인벤토리의 호스트 전부(prune 기준)
 */
export async function refreshHostCfg(c, vcId, hostRefs, { now = Date.now(), budgetMs = HOST_CFG_BUDGET_MS, settings = config, allRefs = hostRefs, signal = null } = {}) {
  if (!settings.hostCfgScan) return { skipped: 'off' };
  prune(vcId, new Set(allRefs)); // 인벤토리에서 사라진 호스트만 — 연결이 끊긴 호스트의 직전 값은 남긴다
  const st = statusOf(vcId) || {};
  if (st.backoffUntil > now) return { skipped: 'backoff' };
  const due = pickDue(vcId, hostRefs, { now, periodMs: settings.hostCfgRefreshMs, max: settings.hostCfgPerCycle });
  if (!due.length) return { due: 0 };
  const budgetEnd = Date.now() + budgetMs;
  try {
    const objs = await c.retrieveManyObjectProps('HostSystem', due, HOST_CFG_PATHS, 100);
    const props = new Map(objs.map((o) => [o.ref, o.props]));
    // 선택 경로 묶음 — 버전에 따라 없는 경로(InvalidProperty)는 그 묶음만 '모름' 이고 그 vCenter 는 다시 묻지 않는다.
    //   lockdownMode(6.0+) · vSAN(5.5+) · 멀티패스(응답이 커서 10대씩).
    for (const g of OPTIONAL_GROUPS) {
      if (st[g.flag] || Date.now() >= budgetEnd) continue;
      try {
        for (const o of await c.retrieveManyObjectProps('HostSystem', due, g.paths, g.chunk)) {
          const p = props.get(o.ref); if (p) for (const k of g.paths) p[k] = o.props[k];
        }
      } catch (err) {
        const m = String(err?.message || err);
        if (isPathErr(m)) setStatus(vcId, { [g.flag]: true });
        else console.warn(`[hostcfg] ${vcId} ${g.label} 읽기 실패: ${m.slice(0, 200)}`);
      }
    }
    const certRefs = [...props.values()].map((p) => p['configManager.certificateManager']).filter((x) => typeof x === 'string' && x);
    const certByRef = new Map();
    if (certRefs.length) {
      try {
        for (const o of await c.retrieveManyObjectProps('HostCertificateManager', certRefs, ['certificateInfo'], 100)) certByRef.set(o.ref, parseCertInfo(o.props.certificateInfo));
      } catch (err) { console.warn(`[hostcfg] ${vcId} 호스트 인증서 정보를 읽지 못했습니다: ${String(err?.message || err).slice(0, 200)}`); }
    }
    // v2.706(C4): 진단(코어 덤프) 파티션 — activePartition 이 없으면 false. 읽기 실패는 null(모름).
    const diagRefs = [...props.values()].map((p) => p['configManager.diagnosticSystem']).filter((x) => typeof x === 'string' && x);
    const diagByRef = new Map();
    if (diagRefs.length && Date.now() < budgetEnd) {
      try {
        for (const o of await c.retrieveManyObjectProps('HostDiagnosticSystem', diagRefs, ['activePartition'], 100)) {
          diagByRef.set(o.ref, typeof o.props.activePartition === 'string' && o.props.activePartition.includes('<id>'));
        }
        for (const r of diagRefs) if (!diagByRef.has(r)) diagByRef.set(r, false);
      } catch (err) { console.warn(`[hostcfg] ${vcId} 진단 파티션을 읽지 못했습니다: ${String(err?.message || err).slice(0, 200)}`); }
    }
    let fetched = 0; let cut = 0; let transient = 0; let backoff = 0; let gaveUp = 0; let started = 0;
    await poolSettled(due, CONCURRENCY, async (ref) => {
      const p = props.get(ref);
      if (!p) return; // 그사이 사라진 호스트
      // v2.720(감사 R1-01): 예산은 '다음 호스트를 시작할지' 만 정한다 — 시작한 호스트는 끝까지 읽는다(v2.719 이전 판단).
      //   v2.719 가 호스트 안에서도 예산을 보고 읽던 것을 버리자, 사전 조회가 예산 대부분을 먹는 고RTT vCenter(800ms)에서는
      //   모든 호스트가 중간에 잘려 캐시가 한 대도 안 차고 매 주기 같은 호스트를 다시 읽었다(진전 0).
      //   그리고 사전 조회만으로 예산을 다 쓴 주기라도 한 대는 시작한다 — 그래야 순서가 전진한다(수집 데드라인은 signal 이 지킨다).
      //   예산을 0 이하로 받았으면(호출자가 시간이 없다) 시작하지 않는다.
      if (signal?.aborted || (Date.now() >= budgetEnd && (started > 0 || budgetMs <= 0))) { cut += 1; return; }
      started += 1;
      const h = parseHostCfgProps(p, now);
      const cert = certByRef.get(p['configManager.certificateManager']);
      if (cert) { h.certNotAfter = cert.notAfter; h.certSubject = cert.subject; }
      const dg = diagByRef.get(p['configManager.diagnosticSystem']);
      if (typeof dg === 'boolean') h.diagPartition = dg;
      // v2.719(감사 S1-03): 중단·시한 실패면 이 호스트를 캐시에 넣지 않는다 — 넣으면 null 값이 '방금 읽음' 이
      //   되어 갱신 주기(기본 6시간) 동안 다시 고르지 않는다. 직전 캐시 값은 그대로 두고 다음에 다시 고른다.
      //   그 밖의 오류(권한 등)는 예전처럼 그 값만 null — 매 주기 같은 결과를 반복해 묻지 않게.
      let incomplete = false; let timedOut = false;
      const optRef = p['configManager.advancedOption'];
      if (typeof optRef === 'string' && optRef) {
        for (const name of ADV_OPTIONS) {
          if (signal?.aborted) { incomplete = true; break; }
          try { applyAdvanced(h, name, await queryOption(c, optRef, name)); } catch (err) { if (isTransientErr(err, signal)) { incomplete = true; timedOut = isTimeoutErr(err, signal); break; } /* 그 값만 모름(null 유지) */ }
        }
      }
      const img = p['configManager.imageConfigManager'];
      if (!incomplete && !signal?.aborted && typeof img === 'string' && img) {
        try { h.acceptance = await queryAcceptance(c, img); } catch (err) { if (isTransientErr(err, signal)) { incomplete = true; timedOut = isTimeoutErr(err, signal); } /* 그 밖은 모름 */ }
      }
      if (incomplete && !timedOut) { transient += 1; return; } // 수집 중단 — 이 호스트 탓이 아니다(실패로 세지 않고 다음 주기에 다시)
      if (incomplete) {
        // v2.720(감사 R1-02): 그 호스트의 요청이 시한에 걸렸다 — 쉬었다가 다시 시도하고, HOST_FAIL_MAX 회 연속이면
        //   예전처럼 읽은 만큼(못 읽은 값은 null)으로 캐시해 갱신 주기 동안 그 호스트를 다시 붙잡지 않는다.
        const f = noteTransientFail(vcId, ref, { now, periodMs: settings.hostCfgRefreshMs });
        if (f.count < HOST_FAIL_MAX) { transient += 1; backoff += 1; return; }
        gaveUp += 1;
      }
      put(vcId, ref, h);
      fetched += 1;
    });
    setStatus(vcId, { at: now, error: null, fetched, cut, transient, backoff, gaveUp, due: due.length });
    if (transient) console.warn(`[hostcfg] ${vcId} 호스트 ${transient}대는 중단·시한으로 다 읽지 못해 캐시하지 않았습니다(직전 값 유지 · 그중 요청 시한 ${backoff}대는 쉬었다가 다시 시도)`);
    if (gaveUp) console.warn(`[hostcfg] ${vcId} 호스트 ${gaveUp}대는 ${HOST_FAIL_MAX}회 연속 요청 시한이라 읽은 만큼(못 읽은 값은 비움)으로 기록했습니다`);
    return { due: due.length, fetched, cut, transient, backoff, gaveUp };
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 300);
    setStatus(vcId, { error: msg, errorAt: now, backoffUntil: isPathErr(msg) ? now + settings.hostCfgRefreshMs : 0 });
    console.warn(`[hostcfg] ${vcId} 호스트 구성 갱신 실패: ${msg}`);
    return { error: msg };
  }
}
