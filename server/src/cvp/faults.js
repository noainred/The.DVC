/**
 * cvp/faults.js — Arista CloudVision(CVP) 장비의 **장애 관측 → 열기/유지/닫기 전이** 판정(순수 — 부작용 0, DB import 금지. v2.640).
 *
 * 왜 '전이만' 기록하는가(partfault/transition.js 머리말과 같은 이유 — 코어 규칙은 하나다):
 *   CVP 한 대가 장비 수백~2,000대를 대신 답한다(parse.DEVICE_MAX). 장비마다 PSU·팬·온도·트랜시버·포트(최대 1,024)·BGP 피어(최대 512)
 *   를 매 주기(기본 5분 = 288회/일) 전량 적재하면 하루 수천만 행이다. 상태가 **바뀔 때만** 적재하면 장비당 연 수 건이다.
 *
 * ⚠⚠ 그래서 '닫는 판정' 이 이 파일에서 가장 위험하다 — partfault 의 6규칙을 **그대로** 옮겼다(루트 CLAUDE.md
 *   "물리 파트(부품) 장애 — v2.548 재설계" 절). 하나라도 빼면 진행 중인 장애가 이력에서 '복구' 로 남는다:
 *   ① 장비 수집이 실패했으면(deviceOk=false) 그 장비의 열린 장애는 **건드리지 않는다**(held: device-failed / device-stale / not-streaming).
 *      실패한 주기의 관측(있더라도 옛 값)으로 열지도 않는다.
 *   ② `unknown` 은 열지도 닫지도 않는다(열려 있던 것은 held 'unknown').
 *   ③ `absent`(빈 슬롯·뽑힌 부품)는 닫되 closeReason 'removed' — 'ok'(고쳐짐)와 구분한다.
 *      v2.656: 링크가 내려간 것을 확인한 트랜시버에 판정할 지표가 없으면 closeReason 'no-link'(판정 대상 아님).
 *   ④ 관측 목록에 없는 열린 장애는 닫지 않는다(held 'missing' — 사라진 것 ≠ 고쳐진 것).
 *   ⑤ 장비 단위로 판정한다(A 성공·B 실패면 A 만 닫는다).
 *   ⑥ 종류(kind) 단위로도 판정한다 — 부품 목록만 못 읽은 주기(partsList null)는 psu·fan·temp·xcvr 의 열린 장애만
 *      held 'collection-failed' 이고 포트·BGP 는 정상 판정한다.
 *   그리고 v2.548 리뷰 C1 — 같은 faultKey 가 한 주기에 두 번 관측되면 **가장 나쁜 상태 하나**만 쓴다.
 *
 * 판정 대상이 아닌 것(정상으로도 장애로도 세지 않는다 — 열지도 닫지도 않는다):
 *   · 포트: 관리상 내려간(admin down) 포트·미연결(nolink)·상태 미상 → 'unknown'. 장애는 **admin up 인데 oper down** 뿐이다
 *     (parse.portsSummary 와 같은 기준 — 쓰지 않는 포트를 장애로 세면 정상 장비가 수십 개의 장애를 가진다).
 *   · BGP: bgpStateWord 가 'unknown'(빈 값·모르는 단어·MIB 정수 0/7 이상)인 피어.
 *
 * 키: devId = `${agent}|${cvpId}|${deviceKey}` · faultKey = `${kind}:${이름}`(BGP 는 `bgp:${vrf||'default'}|${peer}`).
 *   법인 축은 agent(엣지 이름, '' = 중앙 직접)이고 DB 기본키 (agent, cvp_id, device_key, fault_key) 가 격리한다.
 */
import { numOrNull } from '../util/numOrNull.js';
import { capStr } from '../util/capStr.js';
import { bgpStateWord } from './parse.js';

export const FAULT_KINDS = Object.freeze(['psu', 'fan', 'temp', 'xcvr', 'port', 'bgp']);
export const FAULT_STATES = Object.freeze(['ok', 'warn', 'fault', 'unknown', 'absent']);
/** 부품 종류(partsList 의 kind) — 이 넷은 partsList 하나로 온다(못 읽으면 넷 다 collection-failed). */
export const PART_KINDS = Object.freeze(['psu', 'fan', 'temp', 'xcvr']);
export const HOLD_REASON = Object.freeze({
  deviceFailed: 'device-failed',           // 그 장비의 이번 수집이 실패(telemetry failed/aborted/budget/pending) 또는 이번 판정에 장비가 없음
  deviceStale: 'device-stale',             // 마지막 수집이 주기×3 보다 오래됨(엣지 push 끊김·CVP 불통)
  collectionFailed: 'collection-failed',   // 그 장비의 **그 종류**만 못 읽음(부품 목록 null · 포트 미조회 · BGP null)
  unknown: 'unknown',                      // 이번에 상태를 읽지 못함(판정 보류)
  missing: 'missing',                      // 관측 목록에 없음(사라진 것 ≠ 고쳐진 것)
  notStreaming: 'not-streaming',           // CVP 에 스트리밍하지 않는 장비 — 텔레메트리가 없어 판정할 수 없다
});

/** v2.656: 닫는 사유 — 링크 없는 트랜시버(판정 대상 아님). 'ok'(고쳐짐)·'removed'(빈 슬롯)와 구분한다. */
export const NO_LINK = 'no-link';
/** 장애로 세는 상태. ⚠ unknown·absent 를 여기 넣지 말 것. */
export const isBad = (s) => s === 'fault' || s === 'warn';
/** C1 — 같은 키 중복 관측의 우선순위(큰 쪽이 이긴다). */
const RANK = Object.freeze({ fault: 4, warn: 3, unknown: 2, ok: 1, absent: 0 });
/** 수집이 '읽었다' 고 볼 telemetry 값 — 빈 값은 구버전 행(모름)이라 읽은 것으로 본다(없는 실패를 만들지 않는다). */
export const TELEMETRY_OK = new Set(['ok', 'budget-partial', '']);
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const STALE_FACTOR = 3;

const t = (v) => String(v ?? '').trim();
export const devIdOf = (x) => `${t(x?.agent)}|${t(x?.cvpId)}|${t(x?.deviceKey ?? x?.key)}`;

/** 장비 신선도 경계(ms) — 주기×3(적응 타이머는 실행이 끝난 뒤 재무장하므로 두 표본 간격은 주기 + 실행 시간이다). */
export function staleAfterMs(intervalMs) {
  const iv = numOrNull(intervalMs);
  return (iv != null && iv > 0 ? iv : DEFAULT_INTERVAL_MS) * STALE_FACTOR;
}

/** 부품 조회 기본 주기(poller.js CVP_PARTS_EVERY_MS 기본값과 같다). */
export const PARTS_EVERY_DEFAULT_MS = 30 * 60_000;
/** 실제로 쓰는 부품 조회 주기(env CVP_PARTS_EVERY_MS, 하한 5분 — 빈 값·0 은 기본값). poller 와 판정이 같은 값을 쓴다. */
export const PARTS_EVERY_MS = (() => {
  const v = numOrNull(process.env.CVP_PARTS_EVERY_MS);
  return v != null && v > 0 ? Math.min(2_147_483_647, Math.max(5 * 60_000, v)) : PARTS_EVERY_DEFAULT_MS;
})();
/**
 * v2.680(감사 B-02): 부품 목록의 신선도 경계 — 부품은 긴 주기로만 읽고, 조회가 실패한 주기에는 DB 가 직전 목록을 유지한다.
 * 그 목록을 '이번 주기 관측' 으로 쓰면 며칠 전 PSU 상태가 지금 상태로 기록된다(v2.548 C2/H3 거짓 신선). 주기×3 + 장비 경계.
 */
export function partsStaleAfterMs(intervalMs, partsEveryMs = PARTS_EVERY_MS) {
  const pe = numOrNull(partsEveryMs);
  return (pe != null && pe > 0 ? pe : PARTS_EVERY_MS) * 3 + staleAfterMs(intervalMs);
}
/**
 * 엣지 push 의 전량 갱신 주기(cvp/push.js 가 이 값을 쓴다 — 한 벌). 부품이 그대로면 엣지는 그동안 수집 시각만 보내고(touch)
 *   중앙 DB 의 parts_at 은 전량 갱신 때만 바뀐다.
 */
export const EDGE_FULL_REFRESH_MS = 60 * 60_000;
/**
 * 부품 목록이 지금 값으로 쓸 수 있는가 — partsAt 이 없으면(구버전 행) 판정하지 않는다(예전 동작).
 * v2.681(감사 R2A-01 — v2.680 이 만든 회귀): 엣지 위임 행(agent 가 비어 있지 않음)은 전량 갱신 주기만큼 경계를 넓힌다 —
 *   넓히지 않으면 수집 소요가 주기의 1.5배를 넘는 엣지에서 전량 갱신 직전마다 부품이 '낡음' 이 되어 열린 장애가 보류됐다.
 *   ⚠ 엣지의 CVP_PARTS_EVERY_MS 가 중앙보다 크면 그만큼 더 넓혀야 하는데 중앙은 그 값을 모른다(정직 기록).
 */
export function partsFresh(dev, { intervalMs, partsEveryMs, now = Date.now() } = {}) {
  const pa = numOrNull(dev?.partsAt);
  if (pa == null) return true;
  const edgeRow = typeof dev?.agent === 'string' && dev.agent !== '';
  return now - pa <= partsStaleAfterMs(intervalMs, partsEveryMs) + (edgeRow ? EDGE_FULL_REFRESH_MS + staleAfterMs(intervalMs) : 0);
}

function portObservation(p) {
  const name = capStr(p?.name, 64);
  if (!name) return null;
  const oper = t(p?.oper).toLowerCase();
  const admin = t(p?.admin).toLowerCase();
  let state = 'unknown';
  let detail = '';
  if (admin === 'up' && oper === 'down') { state = 'fault'; detail = 'link down (admin up)'; }
  else if (oper === 'up') { state = 'ok'; detail = 'link up'; }
  else detail = [oper && `oper ${oper}`, admin && `admin ${admin}`].filter(Boolean).join(' · ');
  const desc = capStr(p?.desc, 120);
  return { faultKey: `port:${name}`, kind: 'port', label: name, state, detail: desc ? `${detail}${detail ? ' · ' : ''}${desc}` : detail };
}

function bgpObservation(b) {
  const peer = capStr(b?.peer, 64);
  if (!peer) return null;
  const vrf = capStr(b?.vrf, 64);
  const word = bgpStateWord(b?.state);
  const state = word === 'down' ? 'fault' : word === 'established' ? 'ok' : 'unknown';
  const raw = capStr(b?.state, 32);
  const prefixes = numOrNull(b?.prefixes);
  const detail = [raw || word, b?.asn != null && capStr(b.asn, 16) ? `AS ${capStr(b.asn, 16)}` : '', prefixes != null ? `prefixes ${prefixes}` : ''].filter(Boolean).join(' · ');
  return { faultKey: `bgp:${vrf || 'default'}|${peer}`, kind: 'bgp', label: vrf ? `${peer} (${vrf})` : peer, state, detail };
}

function partObservation(p) {
  const kind = t(p?.kind);
  if (!PART_KINDS.includes(kind)) return null;
  const name = capStr(p?.name, 128);
  if (!name) return null;
  let st = FAULT_STATES.includes(p?.state) ? p.state : 'unknown';
  // v2.656: 링크가 내려간 것을 확인한 트랜시버에서 판정할 지표(온도·전압 임계)가 없으면 '판정 대상 아님' 이다 — 열린 장애는
  //   closeReason 'no-link' 로 닫는다(고쳐졌다는 'ok' 와 구분). 링크 상태를 모르면(portKnown false) 예전처럼 unknown 보류.
  const o = p?.optic && typeof p.optic === 'object' ? p.optic : null;
  let closeAs = null;
  if (kind === 'xcvr' && o && o.portKnown === true && o.linked === false && st === 'unknown') { st = 'ok'; closeAs = NO_LINK; }
  return { faultKey: `${kind}:${name}`, kind, label: name, state: st, detail: capStr(p?.detail, 200), ...(closeAs ? { closeAs } : {}) };
}

/**
 * 장비 1대 → 이번 주기의 관측.
 * @param {object} dev  db.rowToDevice 모양({agent,cvpId,key,hostname,collectedAt,telemetry,streaming,partsList,bgpPeers,portsRead})
 *                      + `ports`: **배열**([{name,oper,admin,desc}]) 또는 null(못 읽음). ⚠ listDeviceRows 의 ports 는 요약 객체라
 *                      호출자(faultScan)가 portStateRows 로 배열을 붙여야 한다 — 객체가 오면 '못 읽음' 으로 본다.
 * @param {{intervalMs?:number, now?:number}} o
 * @returns {{deviceOk:boolean, deviceReason:string|null, kindsFailed:string[], observed:object[], duplicateObserved:number}}
 */
export function observeDevice(dev, { intervalMs, partsEveryMs, now = Date.now() } = {}) {
  const at = numOrNull(dev?.collectedAt);
  const telemetry = t(dev?.telemetry).toLowerCase();
  let deviceOk = true; let deviceReason = null;
  if (at == null || now - at > staleAfterMs(intervalMs)) { deviceOk = false; deviceReason = HOLD_REASON.deviceStale; }
  else if (telemetry === 'not-streaming') { deviceOk = false; deviceReason = HOLD_REASON.notStreaming; }
  else if (!TELEMETRY_OK.has(telemetry)) { deviceOk = false; deviceReason = HOLD_REASON.deviceFailed; }

  const kindsFailed = [];
  const partsList = Array.isArray(dev?.partsList) && partsFresh(dev, { intervalMs, partsEveryMs, now }) ? dev.partsList : null;
  if (!partsList) for (const k of PART_KINDS) kindsFailed.push(k);
  const ports = dev?.portsRead === true && Array.isArray(dev?.ports) ? dev.ports : null;
  if (!ports) kindsFailed.push('port');
  const peers = Array.isArray(dev?.bgpPeers) ? dev.bgpPeers : null;
  if (!peers) kindsFailed.push('bgp');

  // C1 — 같은 키가 두 번 관측되면 가장 나쁜 상태 하나(fault > warn > unknown > ok > absent).
  const byKey = new Map();
  let duplicateObserved = 0;
  const put = (o) => {
    if (!o) return;
    const prev = byKey.get(o.faultKey);
    if (!prev) { byKey.set(o.faultKey, o); return; }
    duplicateObserved += 1;
    if (RANK[o.state] > RANK[prev.state]) byKey.set(o.faultKey, o);
  };
  if (partsList) for (const p of partsList) put(partObservation(p));
  if (ports) for (const p of ports) put(portObservation(p));
  if (peers) for (const b of peers) put(bgpObservation(b));

  return { deviceOk, deviceReason, kindsFailed, observed: [...byKey.values()], duplicateObserved };
}

/**
 * 열린 장애(DB) + 장비별 관측 → 전이. 6규칙은 머리말.
 * @param {{open?:object[], observedByDevice?:Map<string, object>, now?:number}} p
 *   open 의 각 행: {agent,cvpId,deviceKey,faultKey,kind,state,label,detail,firstSeen,...} (db.listOpenFaults 모양)
 *   observedByDevice: devId → observeDevice 결과(+ 호출자가 붙인 agent·cvpId·deviceKey·deviceName)
 * @returns {{opened:object[], updated:object[], closed:object[], held:object[], stats:object}}
 */
export function transition({ open = [], observedByDevice = new Map(), now = Date.now() } = {}) {
  const okey = (o) => `${devIdOf(o)}#${t(o.faultKey)}`;
  const openBy = new Map();
  for (const o of open) if (o && t(o.faultKey)) openBy.set(okey(o), o);

  const opened = []; const updated = []; const closed = []; const held = [];
  const seen = new Set();
  let observedTotal = 0; let duplicateObserved = 0; let devicesOk = 0; let devicesFailed = 0;

  for (const [devId, ob] of observedByDevice) {
    if (!ob) continue;
    duplicateObserved += Number(ob.duplicateObserved) || 0;
    const ident = { agent: t(ob.agent), cvpId: t(ob.cvpId), deviceKey: t(ob.deviceKey), deviceName: t(ob.deviceName) };
    const kindsFailed = new Set(Array.isArray(ob.kindsFailed) ? ob.kindsFailed : []);
    if (ob.deviceOk !== true) {
      // ① 실패한 장비 — 열린 장애를 건드리지 않는다(관측이 있어도 옛 값이다). 열지도 않는다.
      devicesFailed += 1;
      for (const [k, o] of openBy) {
        if (devIdOf(o) !== devId) continue;
        seen.add(k);
        held.push({ ...o, holdReason: ob.deviceReason || HOLD_REASON.deviceFailed, lastHeldAt: now });
      }
      continue;
    }
    devicesOk += 1;
    for (const p of Array.isArray(ob.observed) ? ob.observed : []) {
      observedTotal += 1;
      const rec = { ...ident, faultKey: p.faultKey, kind: p.kind, label: p.label, detail: p.detail, state: p.state };
      const k = `${devId}#${t(p.faultKey)}`;
      seen.add(k);
      const prev = openBy.get(k);
      if (isBad(p.state)) {
        if (!prev) opened.push({ ...rec, firstSeen: now, lastSeen: now });
        else if (prev.state !== p.state) updated.push({ ...rec, firstSeen: prev.firstSeen || now, lastSeen: now, prevState: prev.state, sameState: false });
        else updated.push({ ...rec, firstSeen: prev.firstSeen || now, lastSeen: now, prevState: prev.state, sameState: true });
        continue;
      }
      if (p.state === 'unknown') {
        // ② 열지도 닫지도 않는다.
        if (prev) held.push({ ...prev, holdReason: HOLD_REASON.unknown, lastHeldAt: now });
        continue;
      }
      // ok / absent — 열려 있던 것만 닫는다(③ 사유 구분).
      if (prev) closed.push({ ...prev, closedAt: now, closeReason: p.state === 'absent' ? 'removed' : (p.closeAs || 'ok'), closeDetail: p.detail });
    }
    // ④·⑥ 이 장비의 열린 장애 중 관측에 없던 것 — 그 종류를 못 읽었으면 collection-failed, 읽었는데 없으면 missing.
    for (const [k, o] of openBy) {
      if (seen.has(k) || devIdOf(o) !== devId) continue;
      seen.add(k);
      held.push({ ...o, holdReason: kindsFailed.has(t(o.kind)) ? HOLD_REASON.collectionFailed : HOLD_REASON.missing, lastHeldAt: now });
    }
  }
  // 이번 판정에 아예 없는 장비(등록 삭제·엣지 무보고·DB 행 없음)의 열린 장애 — 닫지 않는다(⑤·①).
  for (const [k, o] of openBy) {
    if (seen.has(k)) continue;
    held.push({ ...o, holdReason: HOLD_REASON.deviceFailed, lastHeldAt: now });
  }

  const count = (r) => held.filter((h) => h.holdReason === r).length;
  return {
    opened, updated, closed, held,
    stats: {
      devices: observedByDevice.size, devicesOk, devicesFailed,
      observed: observedTotal, duplicateObserved,
      opened: opened.length, closed: closed.length,
      changed: updated.filter((u) => !u.sameState).length,
      sustained: updated.filter((u) => u.sameState).length,
      held: held.length,
      heldUnknown: count(HOLD_REASON.unknown), heldMissing: count(HOLD_REASON.missing),
      heldDeviceFailed: count(HOLD_REASON.deviceFailed), heldDeviceStale: count(HOLD_REASON.deviceStale),
      heldCollectionFailed: count(HOLD_REASON.collectionFailed), heldNotStreaming: count(HOLD_REASON.notStreaming),
    },
  };
}
