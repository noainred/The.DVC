/**
 * cvp/linkq.js — ④ 불량 링크 순위 · ⑩ 링크 플랩 순위(순수, v3.38 — docs/design/cvp-network-features §3 '링크 품질').
 *
 * 판정(포트 하나에 하나 — 우선순위 순):
 *  · replace(교체 후보) — 기간 오류 > 0 + 수신 광량(Rx) ≤ 주의 임계(GBIC · 케이블 쪽 의심)
 *  · flap(플랩)        — 기간 '링크 내려감' ≥ flapMin
 *  · peer(상대 확인)   — 기간 오류 > 0 + Rx 정상 · 구리 · 광량 모름(상대 장비 · 케이블 반대쪽부터)
 *  · observe(관찰)     — 플랩 1 ~ flapMin-1
 * 오류는 일 롤업의 카운터 차이 합(리셋 구간은 portDelta 가 이미 버렸다). 기간 안에 오류 카운터를 한 번도 못 읽은 포트는 '판정 못 함'(noData)으로
 *   따로 센다 — 0 이 아니다. 오류 순위 대상은 **지금 링크가 올라온 포트**, 플랩은 지금 상태와 무관(내려간 채일 수 있다).
 * 플랩은 수집 주기마다 oper 가 up → down/nolink 로 바뀐 횟수라 주기보다 짧은 플랩은 놓친다(화면이 밝힌다).
 */
import { intfOfPartName } from './portmap.js';
import { rxLimitsOf } from './opticstrend.js';

export const VERDICTS = Object.freeze(['replace', 'flap', 'peer', 'observe']);
export const FLAP_MIN_DEFAULT = 3;
export const LINKQ_ROWS_MAX = 500;
const devKey = (a, c, k) => `${a}\u0000${c}\u0000${k}`;

/** 부품 목록 → Map(인터페이스 → { rx, linked }) · 트랜시버 목록을 못 읽었으면 null. */
export function opticMapOf(parts) {
  if (!Array.isArray(parts)) return null;
  const xs = parts.filter((p) => p && p.kind === 'xcvr');
  if (!xs.length) return null;
  const m = new Map();
  for (const p of xs) {
    const o = p.optic && typeof p.optic === 'object' ? p.optic : null;
    const intf = (o && typeof o.intf === 'string' && o.intf) || intfOfPartName(p.name);
    if (!intf || m.has(intf)) continue;
    const rx = o?.rx ?? p.dom?.rxPower ?? null;
    m.set(intf, { present: p.state !== 'absent', rx: rx == null || !Number.isFinite(Number(rx)) ? null : Number(rx), optic: o });
  }
  return m;
}
const opticOf = (om, port) => {
  if (!om) return undefined;
  if (om.has(port)) return om.get(port);
  const base = String(port).replace(/\/\d+$/, '');
  return om.get(base) || null;
};

/**
 * @param {{ ports:Array<{agent,cvpId,key,hostname,port,oper,admin,speedBps,desc}>, devices:Map<string,{parts:any[]|null}>,
 *   err:Map<string,{inErr,outErr,inDrop,outDrop,errDays,days}>, flap:Map<string,{downs:number,byDay:Array}>, warnDbm:number, flapMin?:number }} a
 * @returns {{ rows:object[], counts:object, omitted:number }}
 */
export function rankLinks({ ports = [], devices = new Map(), err = new Map(), flap = new Map(), warnDbm = -10, faultDbm = -14, flapMin = FLAP_MIN_DEFAULT } = {}) {
  const counts = { replace: 0, flap: 0, peer: 0, observe: 0, judged: 0, noData: 0, up: 0 };
  const rows = [];
  const omCache = new Map();
  for (const p of Array.isArray(ports) ? ports : []) {
    if (!p || /^management/i.test(String(p.port))) continue;
    const dk = devKey(p.agent, p.cvpId, p.key);
    const k = `${dk}\u0000${p.port}`;
    const e = err.get(k) || null;
    const f = flap.get(k) || null;
    const downs = f ? f.downs : 0;
    const up = p.oper === 'up';
    if (up) {
      counts.up++;
      if (!e || e.errDays === 0) counts.noData++; else counts.judged++;
    }
    const errs = e && (e.inErr != null || e.outErr != null) ? (e.inErr ?? 0) + (e.outErr ?? 0) : null;
    const hasErr = up && errs != null && errs > 0;
    if (!hasErr && downs === 0) continue;
    if (!omCache.has(dk)) omCache.set(dk, opticMapOf(devices.get(dk)?.parts));
    const om = omCache.get(dk);
    const o = opticOf(om, p.port);
    const rx = o && o.present ? o.rx : null;
    const copper = om != null && o === null;   // 트랜시버 목록을 읽었는데 그 포트가 없다 = 구리(또는 목록에 없는 포트)
    let verdict;
    // v3.47(D-7): 교체 판정의 Rx 기준은 그 광모듈의 장비 임계(LowWarn — 없으면 LowAlarm)가 먼저, 없으면 포탈 주의 임계(실시간 GBIC 판정과 같은 순서)
    const lim = o && o.present ? rxLimitsOf(o.optic, { warnDbm, faultDbm }) : null;
    const rxLow = lim ? (lim.warnDbm ?? lim.faultDbm) : null;
    if (hasErr && rx != null && rxLow != null && rx <= rxLow) verdict = 'replace';
    else if (downs >= flapMin) verdict = 'flap';
    else if (hasErr) verdict = 'peer';
    else verdict = 'observe';
    counts[verdict]++;
    rows.push({
      agent: p.agent, cvpId: p.cvpId, key: p.key, hostname: p.hostname || p.key, port: p.port, desc: p.desc ?? null, speedBps: p.speedBps ?? null,
      oper: p.oper || 'unknown', admin: p.admin || 'unknown', verdict,
      errs: up ? errs : null, inErr: e?.inErr ?? null, outErr: e?.outErr ?? null, drops: e && (e.inDrop != null || e.outDrop != null) ? (e.inDrop ?? 0) + (e.outDrop ?? 0) : null,
      errDays: e?.errDays ?? 0, days: e?.days ?? 0, downs, flapDays: f ? f.byDay : [],
      rx, rxRead: rx != null, copper, xcvrRead: om != null, ...(lim ? { rxBasis: lim.basis, rxLowDbm: rxLow } : {}),
    });
  }
  const pri = Object.fromEntries(VERDICTS.map((v, i) => [v, i]));
  rows.sort((a, b) => (pri[a.verdict] - pri[b.verdict]) || ((b.errs ?? -1) - (a.errs ?? -1)) || (b.downs - a.downs) || String(a.hostname).localeCompare(String(b.hostname)) || String(a.port).localeCompare(String(b.port)));
  const omitted = Math.max(0, rows.length - LINKQ_ROWS_MAX);
  return { rows: rows.slice(0, LINKQ_ROWS_MAX), counts, omitted };
}
