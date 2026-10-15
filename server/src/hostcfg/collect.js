// 호스트 구성 갱신(v2.699) — 인벤토리 수집 한 주기 안에서 '오래된 호스트부터 상한만큼' 다시 읽는다.
// 시간 예산(기본 15초)을 넘기면 다음 호스트를 시작하지 않는다(시작해 놓고 잘리면 버려진다 — v2.528 판단). 시작한 호스트는 끝까지 읽는다(v2.720 R1-01) —
// 단 예산 끝 + 유예(HOST_OVERRUN_GRACE_MS)를 넘기면 멈추고 시한 실패로 센다(v2.721 R1-01).
// 실패는 격리한다 — 이 갱신이 실패해도 인벤토리 수집은 성공이고, 직전 캐시 값은 그대로(at 으로 낡음이 보인다).
import { config } from '../config.js';
import { poolSettled } from '../util/pool.js';
import { HOST_CFG_PATHS, HOST_LOCKDOWN_PATH, HOST_VSAN_PATHS, HOST_MP_PATH, HOST_NET_PATHS, ADV_OPTIONS, parseHostCfgProps, parseOptionValue, parseCertInfo, applyAdvanced } from './parse.js';
import { pickDue, put, prune, setStatus, statusOf, noteTransientFail, HOST_FAIL_MAX, get, failOf } from './cache.js';

export const HOST_CFG_BUDGET_MS = 15_000;
// v2.721(감사 R1-01): 시작한 호스트의 상한 — 예산 끝(그 호스트가 예산 뒤에 시작했으면 시작 시각) + 유예.
//   v2.720 은 시작한 호스트를 끝까지 읽게 했는데, 느린 vCenter(호출당 수 초)에서 한 호스트의 8회 조회가 예산과
//   수집 여유(soapClient AUX_RESERVE_MS 15초)를 넘기면 수집 데드라인이 vCenter 수집 전체를 끊었고, 그 abort 는
//   '시한' 으로 세지 않아 백오프 기록 없이 다음 주기에 같은 호스트가 다시 맨 먼저 골라졌다(매 주기 반복).
//   유예는 수집 여유보다 짧아야 한다(같거나 길면 데드라인이 먼저 끊는다). 예산 초과만으로 결과를 버리지는 않는다 —
//   유예 안에 다 읽으면 그대로 쓴다. 유예를 넘기거나 예산을 넘긴 채 abort 로 끊긴 호스트만 시한 실패로 센다.
export const HOST_OVERRUN_GRACE_MS = 10_000;
// field — 그 묶음이 채우는 hcfg 필드(parseHostCfgProps). v2.741(VC-04): 묶음을 못 읽은 주기에 직전 값을 이어 싣는 데 쓴다.
const OPTIONAL_GROUPS = [
  { flag: 'noLockdownPath', label: '잠금 모드', paths: [HOST_LOCKDOWN_PATH], chunk: 100, field: 'lockdown' },
  { flag: 'noVsanPath', label: 'vSAN 런타임', paths: HOST_VSAN_PATHS, chunk: 100, field: 'vsan' },
  { flag: 'noMultipathPath', label: '멀티패스', paths: [HOST_MP_PATH], chunk: 10, field: 'mp' },
  { flag: 'noNetPath', label: '가상 스위치·포트그룹', paths: HOST_NET_PATHS, chunk: 20, field: 'net' }, // v2.701(A10) — 포트그룹이 많으면 응답이 커서 20대씩
];
// v2.741(감사 VC-04 — 재현 r5_hostcfg.mjs: 첫 일괄 조회가 예산을 넘긴 주기에 선택 묶음 넷을 하나도 묻지 않고 그 호스트를
//   put(at=now) 해 직전 멀티패스·vSAN·잠금·네트워크 값이 전부 null 로 덮였고, 상태는 fetched:1('다 읽음'), 갱신 주기(6시간) 동안 다시
//   고르지 않았다). 선택 묶음을 **예산 초과·일시 실패**로 못 읽은 주기에는
//   ① 그 묶음의 필드를 직전 캐시 값으로 이어 싣고(덮어 지우지 않는다 — 못 읽은 것은 '없음' 이 아니다)
//   ② 그 호스트를 '묶음 재시도' 로 기록해 갱신 주기보다 일찍(10분 → 20분 → …, 갱신 주기 상한) 다시 고르며
//   ③ 상태에 groupsSkipped{묶음: 호스트 수}·carried 를 싣는다(조용히 '다 읽음' 이라 말하지 않는다).
//   경로 오류(InvalidProperty — 그 버전에 없는 경로)는 예전대로 그 묶음만 '모름'(null)이고 다시 묻지 않는다 — 결함이 아니라 사실이다.
//   ⚠ 이어 실은 값의 시각은 호스트 at(이번 주기)과 같아 보인다 — 직전 값이라는 표지는 hcfg 에 없다(엣지 정제·화면 모양을 바꾸지 않으려고).
//   그래서 ② 로 곧 다시 읽게 한다. 예산이 계속 모자라는 vCenter 에서는 그 묶음이 새로 채워지지 않을 수 있다 — 상태가 그 사실을 말한다.
const _groupGaps = new Map(); // vcId -> Map(ref -> { count, retryAt })
export const GROUP_RETRY_BASE_MS = 10 * 60_000;
function noteGroupGap(vcId, ref, { now, periodMs }) {
  let m = _groupGaps.get(vcId);
  if (!m) { m = new Map(); _groupGaps.set(vcId, m); }
  const count = (m.get(ref)?.count || 0) + 1;
  const wait = Math.min(Math.max(GROUP_RETRY_BASE_MS, Number(periodMs) || 0), GROUP_RETRY_BASE_MS * 2 ** (count - 1));
  m.set(ref, { count, retryAt: now + wait });
}
function clearGroupGap(vcId, ref) { _groupGaps.get(vcId)?.delete(ref); }
/** 묶음 재시도 시각이 된 호스트(이번에 읽을 수 있고 · 시한 실패로 쉬는 중이 아니고 · 이미 고른 것이 아닌 것). */
function dueGroupGaps(vcId, hostRefs, picked, { now, max }) {
  const m = _groupGaps.get(vcId);
  if (!m || !m.size || max <= 0) return [];
  const live = new Set(hostRefs);
  const have = new Set(picked);
  const out = [];
  for (const [ref, g] of [...m].sort((a, b) => a[1].retryAt - b[1].retryAt)) {
    if (out.length >= max) break;
    if (!live.has(ref) || have.has(ref) || g.retryAt > now) continue;
    if ((failOf(vcId, ref)?.retryAt || 0) > now) continue; // 요청 시한으로 쉬는 중(v2.720 R1-02)이면 그 규칙이 먼저다
    out.push(ref);
  }
  return out;
}
/** vCenter 삭제·접속처 변경 때 함께 버린다(hostcfg/cache.js syncVcConfigCaches 가 부를 수 있게 export). */
export function dropHostCfgGaps(vcId) { _groupGaps.delete(vcId); }
export function groupGapOf(vcId, ref) { return _groupGaps.get(vcId)?.get(ref) || null; }
export function _resetHostCfgGaps() { _groupGaps.clear(); }
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
export async function refreshHostCfg(c, vcId, hostRefs, { now = Date.now(), budgetMs = HOST_CFG_BUDGET_MS, settings = config, allRefs = hostRefs, signal = null, overrunGraceMs = HOST_OVERRUN_GRACE_MS } = {}) {
  if (!settings.hostCfgScan) return { skipped: 'off' };
  const allSet = new Set(allRefs);
  prune(vcId, allSet); // 인벤토리에서 사라진 호스트만 — 연결이 끊긴 호스트의 직전 값은 남긴다
  const gm = _groupGaps.get(vcId);
  if (gm) for (const ref of gm.keys()) if (!allSet.has(ref)) gm.delete(ref); // v2.741(VC-04): 사라진 호스트의 묶음 재시도 기록도
  const st = statusOf(vcId) || {};
  if (st.backoffUntil > now) return { skipped: 'backoff' };
  const due = pickDue(vcId, hostRefs, { now, periodMs: settings.hostCfgRefreshMs, max: settings.hostCfgPerCycle });
  // v2.741(VC-04): 직전 주기에 선택 묶음을 못 읽은 호스트를 남은 자리만큼 다시 고른다(갱신 주기를 기다리지 않는다).
  const gapRetry = dueGroupGaps(vcId, hostRefs, due, { now, max: Math.max(0, (Number(settings.hostCfgPerCycle) || 0) - due.length) });
  for (const ref of gapRetry) due.push(ref);
  if (!due.length) return { due: 0 };
  const budgetEnd = Date.now() + budgetMs;
  try {
    const objs = await c.retrieveManyObjectProps('HostSystem', due, HOST_CFG_PATHS, 100);
    const props = new Map(objs.map((o) => [o.ref, o.props]));
    // 선택 경로 묶음 — 버전에 따라 없는 경로(InvalidProperty)는 그 묶음만 '모름' 이고 그 vCenter 는 다시 묻지 않는다.
    //   lockdownMode(6.0+) · vSAN(5.5+) · 멀티패스(응답이 커서 10대씩).
    const gapGroups = []; // v2.741(VC-04): 이번 주기에 예산·일시 실패로 못 읽은 선택 묶음(경로 오류는 아니다)
    for (const g of OPTIONAL_GROUPS) {
      if (st[g.flag]) continue;
      if (Date.now() >= budgetEnd) { gapGroups.push(g); continue; }
      try {
        for (const o of await c.retrieveManyObjectProps('HostSystem', due, g.paths, g.chunk)) {
          const p = props.get(o.ref); if (p) for (const k of g.paths) p[k] = o.props[k];
        }
      } catch (err) {
        const m = String(err?.message || err);
        if (isPathErr(m)) setStatus(vcId, { [g.flag]: true });
        else { gapGroups.push(g); console.warn(`[hostcfg] ${vcId} ${g.label} 읽기 실패: ${m.slice(0, 200)}`); }
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
    let fetched = 0; let cut = 0; let transient = 0; let backoff = 0; let gaveUp = 0; let started = 0; let capped = 0;
    let carried = 0; const groupsSkipped = {}; // v2.741(VC-04)
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
      // v2.721(감사 R1-01): 이 호스트의 상한. overran() — 예산을 넘겨 끝내지 못했는가(abort 로 끊긴 경우 그 호스트 탓으로 센다).
      const hostCap = Math.max(budgetEnd, Date.now()) + overrunGraceMs;
      const overran = () => Date.now() >= budgetEnd;
      const pastCap = () => Date.now() >= hostCap;
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
          if (signal?.aborted) { incomplete = true; timedOut = overran(); break; }
          if (pastCap()) { incomplete = true; timedOut = true; capped += 1; break; }
          try { applyAdvanced(h, name, await queryOption(c, optRef, name)); } catch (err) { if (isTransientErr(err, signal)) { incomplete = true; timedOut = isTimeoutErr(err, signal) || (!!signal?.aborted && overran()); break; } /* 그 값만 모름(null 유지) */ }
        }
      }
      const img = p['configManager.imageConfigManager'];
      const hasImg = typeof img === 'string' && !!img;
      if (!incomplete && hasImg && signal?.aborted) { incomplete = true; timedOut = overran(); }
      if (!incomplete && hasImg && pastCap()) { incomplete = true; timedOut = true; capped += 1; }
      if (!incomplete && hasImg) {
        try { h.acceptance = await queryAcceptance(c, img); } catch (err) { if (isTransientErr(err, signal)) { incomplete = true; timedOut = isTimeoutErr(err, signal) || (!!signal?.aborted && overran()); } /* 그 밖은 모름 */ }
      }
      if (incomplete && !timedOut) { transient += 1; return; } // 수집 중단 — 이 호스트 탓이 아니다(실패로 세지 않고 다음 주기에 다시)
      if (incomplete) {
        // v2.720(감사 R1-02): 그 호스트의 요청이 시한에 걸렸다 — 쉬었다가 다시 시도하고, HOST_FAIL_MAX 회 연속이면
        //   예전처럼 읽은 만큼(못 읽은 값은 null)으로 캐시해 갱신 주기 동안 그 호스트를 다시 붙잡지 않는다.
        const f = noteTransientFail(vcId, ref, { now, periodMs: settings.hostCfgRefreshMs });
        if (f.count < HOST_FAIL_MAX) { transient += 1; backoff += 1; return; }
        gaveUp += 1;
      }
      // v2.741(VC-04): 못 읽은 선택 묶음은 직전 캐시 값으로 이어 싣고(null 로 덮지 않는다) 그 호스트를 일찍 다시 고른다.
      if (gapGroups.length) {
        const prev = get(vcId, ref);
        for (const g of gapGroups) {
          groupsSkipped[g.label] = (groupsSkipped[g.label] || 0) + 1;
          if (prev && prev[g.field] != null) { h[g.field] = prev[g.field]; carried += 1; }
        }
        noteGroupGap(vcId, ref, { now, periodMs: settings.hostCfgRefreshMs });
      } else clearGroupGap(vcId, ref);
      put(vcId, ref, h);
      fetched += 1;
    });
    const skippedAny = Object.keys(groupsSkipped).length > 0;
    setStatus(vcId, { at: now, error: null, fetched, cut, transient, backoff, gaveUp, capped, due: due.length,
      groupsSkipped: skippedAny ? groupsSkipped : null, carried, gapRetry: gapRetry.length });
    if (skippedAny) console.warn(`[hostcfg] ${vcId} 선택 묶음(${Object.keys(groupsSkipped).join('·')})을 이번 주기에 읽지 못해 직전 값을 이어 실었습니다(${carried}건 · 그 호스트는 갱신 주기보다 일찍 다시 읽습니다)`);
    if (transient) console.warn(`[hostcfg] ${vcId} 호스트 ${transient}대는 중단·시한으로 다 읽지 못해 캐시하지 않았습니다(직전 값 유지 · 그중 요청 시한 ${backoff}대는 쉬었다가 다시 시도)`);
    if (gaveUp) console.warn(`[hostcfg] ${vcId} 호스트 ${gaveUp}대는 ${HOST_FAIL_MAX}회 연속 요청 시한이라 읽은 만큼(못 읽은 값은 비움)으로 기록했습니다`);
    if (capped) console.warn(`[hostcfg] ${vcId} 호스트 ${capped}대는 예산 + 유예(${Math.round(overrunGraceMs / 1000)}초)를 넘겨 중간에 멈췄습니다(시한 실패로 기록 — 쉬었다가 다시 시도)`);
    return { due: due.length, fetched, cut, transient, backoff, gaveUp, capped, groupsSkipped: skippedAny ? groupsSkipped : null, carried, gapRetry: gapRetry.length };
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 300);
    // v2.721(감사 S1-03): 첫 일괄 조회(또는 그 뒤 조회)가 요청 시한에 걸렸으면 이번에 고른 호스트들을 쉬게 한다 —
    //   예전에는 backoffUntil 0 이라 같은 호스트들을 매 주기 맨 먼저 다시 골라 매 주기 요청 시한을 먹었다(수집 중단은 세지 않는다).
    let rested = 0;
    if (isTimeoutErr(err, signal || c?.signal)) for (const ref of due) { noteTransientFail(vcId, ref, { now, periodMs: settings.hostCfgRefreshMs }); rested += 1; }
    setStatus(vcId, { error: msg, errorAt: now, backoffUntil: isPathErr(msg) ? now + settings.hostCfgRefreshMs : 0, rested });
    console.warn(`[hostcfg] ${vcId} 호스트 구성 갱신 실패: ${msg}${rested ? `(호스트 ${rested}대는 쉬었다가 다시 시도)` : ''}`);
    return { error: msg, rested };
  }
}
