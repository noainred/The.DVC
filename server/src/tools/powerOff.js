/**
 * tools/powerOff.js — 전원 꺼진 VM 이 **언제부터** 꺼져 있는지(v2.483, 사용자 요청 "꺼진 지 몇 일 됐는지").
 *
 * vCenter 인벤토리에는 '꺼진 시각' 이 없다(runtime.bootTime 은 켜진 VM 에만 있다). 그래서 이미 갖고 있는
 * 세 출처를 합쳐 판정하고, 출처와 정확도를 화면에 그대로 표시한다(추정으로 채우지 않는다):
 *  1) 이벤트(logs DB, vCenter 로그 수집): VmPoweredOffEvent / VmPoweredOnEvent 의 최신 시각 — **정확**(초 단위).
 *     로그 수집이 켜져 있고 보관 기간(기본 365일) 안일 때만 있다. 엔티티 키는 VM **이름** 이라 동명 VM 은
 *     구분하지 못한다(같은 vCenter 안 동명은 드물지만 가능 — 표시 문구에 명시).
 *  2) VM 추적(vmtrack, 12시간 슬롯 diff): powered_off/powered_on 전환이 **관측된 슬롯 시각**. 실제로 꺼진 시각은
 *     그 슬롯과 직전 슬롯 사이이므로 '그 시각 이후로는 확실히 꺼짐' 인 **하한**.
 *  3) 전원 꺼짐 점검(v2.484, tools/powerOffPoller.js — 설정 주기, 기본 6시간): 현재 꺼짐 구간의 **관측 시작**.
 *     실제 꺼진 시각은 직전 점검과 그 점검 사이(정밀도 = 점검 주기) → 하한.
 *  4) 추적 로스터 first_seen: 추적을 시작했을 때부터 계속 꺼져 있었으면 first_seen 이후로 꺼짐(하한, 다른 하한이 없을 때만).
 * 하한 출처가 여럿이면 **정밀도(간격)가 가장 촘촘한 것** 을 쓴다(점검 주기 ≤ 12h 면 점검, 아니면 추적).
 * 이벤트(정확)와 하한이 둘 다 있으면: 하한이 이벤트 직후 한 간격 안이면 이벤트를 쓰고, 그보다 늦으면 이벤트가 낡은 것
 * (그 사이 켜졌다 꺼진 기록 누락)이므로 하한을 '현재 꺼짐 구간의 시작' 으로 본다.
 */
import { getLogsDb } from '../logs/db.js';
import { loadPowerChanges, loadRosterFirstSeen, loadOffSeen } from '../vmtrack/db.js';
import { loadPowerOffSettings } from './powerOffSettings.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const TRACK_GRAN_MS = 12 * HOUR;   // VM 추적 슬롯(00/12시)

/**
 * 순수 판정 — 출처별 후보에서 '현재 꺼짐 구간의 시작' 을 고른다.
 * @param {{event?:{offTs?:number,onTs?:number}|null, track?:{offTs?:number,onTs?:number}|null,
 *          observed?:{offSince?:number}|null, observedGranMs?:number,
 *          roster?:{firstSeen?:number,powerState?:string}|null, now?:number}} p
 * @returns {{offSince:number, offDays:number, source:'event'|'observed'|'track'|'first_seen', exact:boolean, granHours?:number}|null}
 */
export function resolveOffSince({ event = null, track = null, observed = null, observedGranMs = 6 * HOUR, roster = null, now = Date.now() } = {}) {
  const ev = event?.offTs > 0 && !(event.onTs > event.offTs) ? { since: event.offTs, source: 'event', exact: true } : null;
  // 하한 후보(정밀도 = 간격) — 가장 촘촘한 것을 택한다(동률이면 점검).
  const lbs = [];
  if (observed?.offSince > 0) lbs.push({ since: observed.offSince, source: 'observed', exact: false, gran: Math.max(HOUR, Number(observedGranMs) || 6 * HOUR) });
  if (track?.offTs > 0 && !(track.onTs > track.offTs)) lbs.push({ since: track.offTs, source: 'track', exact: false, gran: TRACK_GRAN_MS });
  lbs.sort((a, b) => a.gran - b.gran || (a.source === 'observed' ? -1 : 1));
  const lb = lbs[0] || null;
  let pick = null;
  if (ev && lb) pick = (lb.since > ev.since + lb.gran + HOUR) ? lb : ev;   // 하한이 이벤트보다 한 간격 넘게 늦으면 이벤트가 낡음
  else pick = ev || lb;
  if (!pick && roster?.firstSeen > 0 && roster.powerState && roster.powerState !== 'POWERED_ON') {
    pick = { since: roster.firstSeen, source: 'first_seen', exact: false };
  }
  if (!pick) return null;
  const offDays = Math.max(0, Math.floor((now - pick.since) / DAY));
  const out = { offSince: pick.since, offDays, source: pick.source, exact: pick.exact };
  if (pick.gran) out.granHours = Math.round(pick.gran / HOUR);
  return out;
}

// 이벤트 조회는 vCenter 당 1회면 되므로 짧게 캐시(같은 화면을 여러 사용자가 열어도 매번 GROUP BY 하지 않게).
const evCache = new Map(); // vcenterId -> { at, map }
const EV_TTL_MS = 5 * 60_000;
async function lastPowerEventsMap(vcenterId) {
  const hit = evCache.get(vcenterId);
  if (hit && Date.now() - hit.at < EV_TTL_MS) return hit.map;
  let map = null;
  try {
    const db = await getLogsDb();
    if (db && typeof db.lastPowerEvents === 'function') {
      map = new Map();
      for (const r of db.lastPowerEvents(vcenterId) || []) {
        const e = map.get(r.entity) || { offTs: 0, onTs: 0 };
        if (r.type === 'VmPoweredOffEvent') e.offTs = Math.max(e.offTs, Number(r.ts) || 0);
        else if (r.type === 'VmPoweredOnEvent') e.onTs = Math.max(e.onTs, Number(r.ts) || 0);
        map.set(r.entity, e);
      }
    }
  } catch { map = null; }
  evCache.set(vcenterId, { at: Date.now(), map });
  if (evCache.size > 200) for (const [k, v] of evCache) if (Date.now() - v.at > EV_TTL_MS) evCache.delete(k);
  return map;
}
export function _resetPowerOffCache() { evCache.clear(); }

/**
 * 꺼진 VM 목록 → 각 VM 의 꺼진 시각 판정. vms: [{id, name, vcenterId}] (id = vmtrack vm_id 와 동일한 전역 id).
 * @returns {{ rows: Array<{id,offSince,offDays,source,exact}|{id}>, sources: {events:boolean, track:boolean} }}
 */
export async function poweredOffSinceFor(vms, { now = Date.now() } = {}) {
  const byVc = new Map();
  for (const v of vms || []) { if (!byVc.has(v.vcenterId)) byVc.set(v.vcenterId, []); byVc.get(v.vcenterId).push(v); }
  const rows = []; let eventsOk = false; let trackOk = false; let observedOk = false;
  const ps = loadPowerOffSettings();
  const observedGranMs = (Number(ps.intervalHours) || 6) * HOUR;
  for (const [vc, list] of byVc) {
    const [ev, tr, ro, ob] = await Promise.all([lastPowerEventsMap(vc), loadPowerChanges(vc), loadRosterFirstSeen(vc), loadOffSeen(vc)]);
    if (ev) eventsOk = true;
    if (tr && tr.size) trackOk = true;
    if (ob && ob.size) observedOk = true;
    for (const v of list) {
      const r = resolveOffSince({ event: ev?.get(v.name) || null, track: tr?.get(v.id) || null, observed: ob?.get(v.id) || null, observedGranMs, roster: ro?.get(v.id) || null, now });
      rows.push(r ? { id: v.id, ...r } : { id: v.id });
    }
  }
  return { rows, sources: { events: eventsOk, track: trackOk, observed: observedOk, observedIntervalHours: ps.intervalHours, observedEnabled: ps.enabled } };
}
