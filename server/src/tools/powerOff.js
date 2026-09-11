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
 *  3) 추적 로스터 first_seen: 추적을 시작했을 때부터 계속 꺼져 있었으면 first_seen 이후로 꺼짐(하한).
 * 이벤트와 추적이 둘 다 있으면: 추적 전환이 이벤트 직후 슬롯(≤13h) 이면 이벤트(정확)를 쓰고, 그보다 늦으면
 * 이벤트가 낡은 것(그 사이 켜졌다 꺼진 기록 누락)이므로 더 늦은 쪽을 '현재 꺼짐 구간의 시작' 으로 본다.
 */
import { getLogsDb } from '../logs/db.js';
import { loadPowerChanges, loadRosterFirstSeen } from '../vmtrack/db.js';

const DAY = 86_400_000;
const SLOT_TOL_MS = 13 * 3_600_000; // 12시간 슬롯 + 1시간 여유

/**
 * 순수 판정 — 출처별 후보에서 '현재 꺼짐 구간의 시작' 을 고른다.
 * @param {{event?:{offTs?:number,onTs?:number}|null, track?:{offTs?:number,onTs?:number}|null,
 *          roster?:{firstSeen?:number,powerState?:string}|null, now?:number}} p
 * @returns {{offSince:number, offDays:number, source:'event'|'track'|'first_seen', exact:boolean}|null}
 */
export function resolveOffSince({ event = null, track = null, roster = null, now = Date.now() } = {}) {
  const ev = event?.offTs > 0 && !(event.onTs > event.offTs) ? { since: event.offTs, source: 'event', exact: true } : null;
  const tr = track?.offTs > 0 && !(track.onTs > track.offTs) ? { since: track.offTs, source: 'track', exact: false } : null;
  let pick = null;
  if (ev && tr) pick = (tr.since >= ev.since && tr.since - ev.since <= SLOT_TOL_MS) ? ev : (tr.since > ev.since ? tr : ev);
  else pick = ev || tr;
  if (!pick && roster?.firstSeen > 0 && roster.powerState && roster.powerState !== 'POWERED_ON') {
    pick = { since: roster.firstSeen, source: 'first_seen', exact: false };
  }
  if (!pick) return null;
  const offDays = Math.max(0, Math.floor((now - pick.since) / DAY));
  return { offSince: pick.since, offDays, source: pick.source, exact: pick.exact };
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
  const rows = []; let eventsOk = false; let trackOk = false;
  for (const [vc, list] of byVc) {
    const [ev, tr, ro] = await Promise.all([lastPowerEventsMap(vc), loadPowerChanges(vc), loadRosterFirstSeen(vc)]);
    if (ev) eventsOk = true;
    if (tr && tr.size) trackOk = true;
    for (const v of list) {
      const r = resolveOffSince({ event: ev?.get(v.name) || null, track: tr?.get(v.id) || null, roster: ro?.get(v.id) || null, now });
      rows.push(r ? { id: v.id, ...r } : { id: v.id });
    }
  }
  return { rows, sources: { events: eventsOk, track: trackOk } };
}
