/**
 * central/partFaultEdge.js — 엣지가 올린 **파트 판정 보고**를 중앙이 보관한다(v2.548, 프로토콜 2).
 *
 * 엣지는 `partfault/push.js` 로 장비마다 `{ ok, reason, failedKinds, states{ok,unknown,absent: 키꼬리[]}, open[] }`
 * 를 보낸다. 이 모듈은 **에이전트별 최신 보고 1건**만 갖는다 — 이력은 `partfault/db.js` 가 소유한다.
 *
 * ── 인메모리다(v2.548 F-minor). 디스크에 쓰지 않는다 ────────────────────────────────
 * v2.547 은 push 마다 맵 전체를 다시 직렬화해 파일에 썼다 — 전량 요약이면 12.5MB·74ms/push 다
 * (svcmon 이 실측 근거로 거부한 방식). 진실의 원천은 `part-faults.db` 이고 이 보고는 **다음 전이
 * 판정의 입력**일 뿐이다. 재기동 직후 보고가 없으면 그 엣지 장비의 열린 장애는 전이가 `device-failed`
 * 로 **보류**한다(닫지 않는다) — 첫 push 가 오면 저절로 맞는다. 화면은 그 상태를 '재기동 후 첫 보고
 * 대기' 로 말한다.
 *
 * ── 소유권·법인 축(v2.548 F2·F5) ──────────────────────────────────────────────
 *  · 저장 키는 **인증된 agent** 다(라우트가 `req.centralAuth.agent` 로 강제 — 본문 값을 믿지 않는다).
 *  · 모든 장비·파트에 그 agent 를 **덮어쓴다**(엣지가 법인 귀속을 정하지 못하게).
 *  · 스토리지·SAN 은 중앙 등록부가 진실의 원천이므로 `devicesForAgent(agent)` 에 없는 장비는 **버리고
 *    개수를 밝힌다**(`rejected`). iDRAC 은 중앙 등록부에 없어 검사할 수 없다 — 대신 DB 기본키
 *    `(agent, part_key)` 가 다른 법인 행을 격리한다.
 *  · 프로토콜 1(v2.547 엣지)은 받되 **'닫지 않는 쪽'** 으로만 다룬다 — unknown 과 해소를 구분해 줄 수 없다.
 *
 * ⚠ **보고가 없는 엣지를 '장애 없음' 이라 말하지 말 것** — '모른다' 다. `at`(마지막 보고 시각)과
 *   `version`(엣지 포탈 버전)을 보관해 화면이 '구버전 / 무보고 / 오래됨' 을 **각각** 말하게 한다.
 */
import { makePart, partKeyFromTail, PUSH_PROTOCOL, COLLECTION_KINDS } from '../partfault/types.js';
import { devKeyOf } from '../partfault/scan.js';

const t = (v) => String(v ?? '').trim();
const s = (v, n) => t(v).slice(0, n);
const MAX_DEVICES = Math.max(100, Number(process.env.PARTFAULT_EDGE_MAX_DEVICES) || 5_000);
/**
 * 파트 배열 상한(v2.548 보안 리뷰 S2). 수신부가 장비 **수**만 제한하면 장비 1개에 키 꼬리 120만 개를 실은
 * 16MB 본문(BIG_JSON 한도 이내)이 파트 객체 120만 개로 펼쳐져 agent 당 ~450MB 가 상주한다(리뷰 실측 RSS 556MB).
 * 실제 규모는 iDRAC 37~66개/대 · SAN 디렉터 최대 ~800개/대(v2.547 기록)라 장비당 2,000 이면 넉넉하다.
 * ⚠ 넘친 파트는 **조용히 버리지 않는다** — 그 장비를 `ok:false`(reason `parts-capped`)로 바꿔 전이가
 *   아무것도 닫지 못하게 하고(거짓 복구 방지 — v2.547 `unknownTruncated` 와 같은 방향) 개수를 밝힌다.
 */
const DEVICE_PART_MAX = Math.max(100, Number(process.env.PARTFAULT_EDGE_DEVICE_PART_MAX) || 2_000);
const REPORT_PART_MAX = Math.max(1_000, Number(process.env.PARTFAULT_EDGE_REPORT_PART_MAX) || 50_000);
const SCANNED_MAX_BYTES = 32 * 1024;   // scanned 요약(실측 ~1KB)의 상한 — 임의 객체를 그대로 상주시키지 않는다
const LIST_MAX = 64;                   // failedKinds·notCollected 같은 소형 배열
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** `constructor`·`__proto__` 같은 프로토타입 키로 `owned[scope].has` 가 함수가 아닌 값을 만나지 않게(S1). */
const ownedSet = (owned, scope) => (Object.hasOwn(owned, scope) && owned[scope] instanceof Set ? owned[scope] : null);
let _map = new Map();   // agentLower -> report

/** 스토리지·SAN 소유권 확인용 — 테스트가 주입한다. 기본은 실제 등록부. */
let _ownedLookup = null;
async function ownedIdsFor(agent) {
  if (_ownedLookup) return _ownedLookup(agent);
  const [st, sw] = await Promise.all([import('../storage/registry.js'), import('../sanswitch/registry.js')]);
  const ids = { storage: new Set(), sanswitch: new Set() };
  try { for (const d of st.devicesForAgent(agent)) ids.storage.add(t(d.id)); } catch { /* 등록부 없음 */ }
  try { for (const d of sw.devicesForAgent(agent)) ids.sanswitch.add(t(d.id)); } catch { /* 등록부 없음 */ }
  return ids;
}

/**
 * 한 엣지의 보고를 저장한다.
 * @param {string} agent  **인증된** agent 이름(라우트가 정한다)
 * @param {object} body   프로토콜 2 본문(구버전 1 도 받는다)
 * @returns {{ok:boolean, protocol:number, devices:number, rejected:number, open:number, reason?:string}}
 */
export async function putEdgeReport(agent, body = {}) {
  const key = t(agent).toLowerCase();
  if (!key) return { ok: false, reason: 'agent 없음', protocol: 0, devices: 0, rejected: 0, open: 0 };
  const protocol = Number(body.v) === PUSH_PROTOCOL ? PUSH_PROTOCOL : 1;
  const owned = await ownedIdsFor(key);
  const devices = [];
  let rejected = 0;
  let openN = 0;
  let totalParts = 0;     // 보고 전체 파트 수(REPORT_PART_MAX)
  let partsOmitted = 0;   // 상한으로 버린 파트 수(화면이 밝힌다)

  if (protocol === PUSH_PROTOCOL) {
    for (const d of (Array.isArray(body.devices) ? body.devices : []).slice(0, MAX_DEVICES)) {
      if (!isObj(d)) continue;   // null·문자열 원소는 건너뛴다(S1 — 던지면 라우트가 응답 없이 매달린다)
      const scope = s(d.scope, 32) || 'other';
      const deviceId = s(d.deviceId, 200);
      if (!deviceId) continue;
      // 소유권 — 중앙 등록부가 있는 장비군만. iDRAC 은 검사 불가(주석 참조).
      const ownedIds = ownedSet(owned, scope);
      if (ownedIds && !ownedIds.has(deviceId)) { rejected += 1; continue; }
      const deviceKey = s(d.deviceKey, 200) || deviceId;
      const base = { scope, deviceId, deviceKey, deviceKeyKind: s(d.deviceKeyKind, 32) || 'localId', deviceName: s(d.deviceName, 200) || deviceId, agent: key };
      const parts = [];
      let omitted = 0;
      const room = () => parts.length < DEVICE_PART_MAX && totalParts + parts.length < REPORT_PART_MAX;
      for (const p of Array.isArray(d.open) ? d.open : []) {
        if (!isObj(p)) continue;
        if (!room()) { omitted += 1; continue; }
        const part = makePart({ ...base, kind: p.kind, partId: p.partId, keyKind: p.keyKind, state: p.state, rawState: s(p.rawState, 200), label: s(p.label, 200), detail: s(p.detail, 300) });
        if (!part.partId) continue;
        parts.push(part); openN += 1;
      }
      const states = isObj(d.states) ? d.states : {};
      for (const st of ['ok', 'unknown', 'absent']) {
        for (const tail of Array.isArray(states[st]) ? states[st] : []) {
          if (typeof tail !== 'string') continue;
          if (!room()) { omitted += 1; continue; }
          const [kind, ...rest] = tail.split(':');
          const partId = rest.join(':');
          if (!kind || !partId) continue;
          parts.push({ ...base, kind, partId, keyKind: 'name', state: st, rawState: '', label: partId, detail: '', partKey: partKeyFromTail({ scope, deviceKey, tail }) });
        }
      }
      totalParts += parts.length;
      partsOmitted += omitted;
      // 상한에 걸린 장비는 **닫지 않는 쪽** 으로 — 빠진 파트는 '사라짐' 이 아니라 '못 받음' 이다.
      devices.push({
        ...base, ok: d.ok === true && omitted === 0, reason: omitted ? 'parts-capped' : s(d.reason, 300),
        failedKinds: Array.isArray(d.failedKinds) ? d.failedKinds.slice(0, LIST_MAX).map((k) => s(k, 32)) : [],
        capped: !!d.capped || omitted > 0, partsOmitted: omitted,
        notCollected: Array.isArray(d.notCollected) ? d.notCollected.slice(0, LIST_MAX).map((k) => s(k, 64)) : [],
        parts,
      });
    }
  } else {
    // 프로토콜 1(v2.547): open[] + deviceOk{} 만 있다. 장비 단위 레코드로 접되 **ok 를 false 로** 둔다 —
    // 그 엣지는 unknown 과 해소를 구분해 줄 수 없으므로 전이가 아무것도 닫지 못하게 한다.
    for (const p of (Array.isArray(body.open) ? body.open : []).slice(0, REPORT_PART_MAX)) {
      if (!isObj(p)) continue;
      const part = makePart({ ...p, agent: key });
      if (!part.partId) continue;
      let dev = devices.find((x) => x.scope === part.scope && x.deviceId === part.deviceId);
      if (!dev) { dev = { scope: part.scope, deviceId: part.deviceId, deviceKey: part.deviceKey, deviceKeyKind: part.deviceKeyKind, deviceName: part.deviceName, agent: key, ok: false, reason: 'legacy-protocol', failedKinds: Object.values(COLLECTION_KINDS), parts: [] }; devices.push(dev); }
      dev.parts.push(part); openN += 1;
    }
  }

  // scanned 요약은 크기 상한 안에서만 보관한다(임의 객체를 그대로 상주시키지 않는다 — S2). 넘치면 버리고 밝힌다.
  let scanned = null;
  let scannedDropped = false;
  if (isObj(body.scanned)) {
    try { scanned = JSON.stringify(body.scanned).length <= SCANNED_MAX_BYTES ? body.scanned : null; } catch { scanned = null; }
    scannedDropped = scanned === null;
  }
  _map.set(key, {
    at: Date.now(), reportedAt: Number(body.at) || null,
    version: s(body.version, 32), protocol,
    devices, rejected, omitted: Number(body.omitted) || 0, partsOmitted, scannedDropped,
    scanned,
  });
  return { ok: true, protocol, devices: devices.length, rejected, open: openN, partsOmitted };
}

export function edgeReports() { return [..._map.entries()].map(([agent, r]) => ({ agent, ...r })); }
export function edgeReport(agent) { return _map.get(t(agent).toLowerCase()) || null; }
export function _resetForTest(ownedLookup = null) { _map = new Map(); _ownedLookup = ownedLookup; }

/**
 * 모든 엣지 보고를 합쳐 전이 입력으로 만든다.
 * ⚠ **오래된 보고는 쓰지 않는다** — 엣지가 죽으면 그 엣지의 장애가 영원히 '지금 열려 있는 것' 으로
 *   남는다. `staleMs` 를 넘으면 그 엣지의 장비를 **전부 deviceOk=false** 로 바꿔(= '이번엔 못 봤다')
 *   전이가 닫지 않게 한다. 프로토콜 1 보고도 같다(장비 ok 가 이미 false 다).
 * `deviceReason` 은 deviceOk=false 인 장비의 **이유**(`edge-stale`·`edge-legacy`·엣지가 보낸 reason)다 — 전이가
 * 보류 사유를 '장비 실패' 로 뭉개지 않고 '엣지 보고 오래됨/구버전' 으로 나눠 적게 한다(v2.548 리뷰 H7).
 * @returns {{observed:Array, deviceOk:Object, kindFailed:Object, deviceReason:Object, agents:Array}}
 */
export function mergeEdgeReports({ staleMs = 3 * 3_600_000, now = Date.now() } = {}) {
  const observed = [];
  const deviceOk = {};
  const kindFailed = {};
  const deviceReason = {};
  const agents = [];
  for (const r of edgeReports()) {
    const age = now - (Number(r.at) || 0);
    const stale = age > staleMs;
    const legacy = r.protocol !== PUSH_PROTOCOL;
    let open = 0;
    for (const d of r.devices || []) {
      const k = devKeyOf(r.agent, d.deviceId);
      deviceOk[k] = !stale && !legacy && d.ok === true;
      if (stale) deviceReason[k] = 'edge-stale';
      else if (legacy) deviceReason[k] = 'edge-legacy';
      else if (d.ok !== true) deviceReason[k] = d.reason || 'device-failed';
      if (d.failedKinds?.length) kindFailed[k] = [...d.failedKinds];
      for (const p of d.parts || []) {
        if (p.state === 'fault' || p.state === 'warn') open += 1;
        /*
         * ⚠ 오래된 보고의 파트는 **관측 목록에 넣지 않는다**(v2.548 리뷰 C2). 넣으면 전이가 그 장애를
         *   '방금 봤다'(lastSeenAt 갱신 — 거짓 신선)로 적고, 그 보고의 ok 꼬리가 그동안 열린 장애를 **닫는다**.
         *   deviceOk=false 만 남기면 규칙 ①이 device-failed 로 보류한다. 구 프로토콜(장애만)은 신선하면 그대로.
         */
        if (stale) continue;
        observed.push(p);
      }
    }
    agents.push({
      agent: r.agent, at: r.at, reportedAt: r.reportedAt, ageMs: age, stale, legacy, version: r.version, protocol: r.protocol,
      devices: (r.devices || []).length, devicesFailed: (r.devices || []).filter((d) => !d.ok).length,
      open, rejected: r.rejected || 0, omitted: r.omitted || 0, partsOmitted: r.partsOmitted || 0, scannedDropped: !!r.scannedDropped, scanned: r.scanned,
    });
  }
  return { observed, deviceOk, kindFailed, deviceReason, agents };
}
