// 호스트 구성 갱신(v2.699) — 인벤토리 수집 한 주기 안에서 '오래된 호스트부터 상한만큼' 다시 읽는다.
// 시간 예산(기본 15초)을 넘기면 다음 호스트를 시작하지 않는다(시작해 놓고 잘리면 버려진다 — v2.528 판단).
// 실패는 격리한다 — 이 갱신이 실패해도 인벤토리 수집은 성공이고, 직전 캐시 값은 그대로(at 으로 낡음이 보인다).
import { config } from '../config.js';
import { poolSettled } from '../util/pool.js';
import { HOST_CFG_PATHS, HOST_LOCKDOWN_PATH, ADV_OPTIONS, parseHostCfgProps, parseOptionValue, parseCertInfo, applyAdvanced } from './parse.js';
import { pickDue, put, prune, setStatus, statusOf } from './cache.js';

export const HOST_CFG_BUDGET_MS = 15_000;
const CONCURRENCY = 4;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isPathErr = (m) => /InvalidProperty|InvalidArgument/i.test(m);

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
export async function refreshHostCfg(c, vcId, hostRefs, { now = Date.now(), budgetMs = HOST_CFG_BUDGET_MS, settings = config, allRefs = hostRefs } = {}) {
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
    // lockdownMode 는 6.0+ — 5.x vCenter 면 InvalidProperty 이고 그 값만 모른다(요청 전체를 실패로 만들지 않는다).
    if (!st.noLockdownPath) {
      try {
        for (const o of await c.retrieveManyObjectProps('HostSystem', due, [HOST_LOCKDOWN_PATH], 100)) {
          const p = props.get(o.ref); if (p) p[HOST_LOCKDOWN_PATH] = o.props[HOST_LOCKDOWN_PATH];
        }
      } catch (err) { if (isPathErr(String(err?.message || err))) setStatus(vcId, { noLockdownPath: true }); else throw err; }
    }
    const certRefs = [...props.values()].map((p) => p['configManager.certificateManager']).filter((x) => typeof x === 'string' && x);
    const certByRef = new Map();
    if (certRefs.length) {
      try {
        for (const o of await c.retrieveManyObjectProps('HostCertificateManager', certRefs, ['certificateInfo'], 100)) certByRef.set(o.ref, parseCertInfo(o.props.certificateInfo));
      } catch (err) { console.warn(`[hostcfg] ${vcId} 호스트 인증서 정보를 읽지 못했습니다: ${String(err?.message || err).slice(0, 200)}`); }
    }
    let fetched = 0; let cut = 0;
    await poolSettled(due, CONCURRENCY, async (ref) => {
      const p = props.get(ref);
      if (!p) return; // 그사이 사라진 호스트
      if (Date.now() >= budgetEnd) { cut += 1; return; }
      const h = parseHostCfgProps(p, now);
      const cert = certByRef.get(p['configManager.certificateManager']);
      if (cert) { h.certNotAfter = cert.notAfter; h.certSubject = cert.subject; }
      const optRef = p['configManager.advancedOption'];
      if (typeof optRef === 'string' && optRef) {
        for (const name of ADV_OPTIONS) {
          try { applyAdvanced(h, name, await queryOption(c, optRef, name)); } catch { /* 그 값만 모름(null 유지) */ }
        }
      }
      const img = p['configManager.imageConfigManager'];
      if (typeof img === 'string' && img) { try { h.acceptance = await queryAcceptance(c, img); } catch { /* 모름 */ } }
      put(vcId, ref, h);
      fetched += 1;
    });
    setStatus(vcId, { at: now, error: null, fetched, cut, due: due.length });
    return { due: due.length, fetched, cut };
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 300);
    setStatus(vcId, { error: msg, errorAt: now, backoffUntil: isPathErr(msg) ? now + settings.hostCfgRefreshMs : 0 });
    console.warn(`[hostcfg] ${vcId} 호스트 구성 갱신 실패: ${msg}`);
    return { error: msg };
  }
}
