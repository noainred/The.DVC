/**
 * bmusage/targets.js — '어느 서버를 수집하고, 무엇으로 닿을 수 있는가'(순수, v2.550).
 *
 * 대상은 **서버 분석 › 구분 › Baremetal(미가상화 물리)** 과 정확히 같은 집합이다
 * (`insights/fleetInventory.js classifyFleet().bareMetal`). 판정을 복제하지 않는다 —
 * 복제하면 화면이 '이 서버는 베어메탈' 이라 하고 수집은 빼먹는 일이 생긴다(CLAUDE.md '코어는 하나다').
 *
 * ── 닿을 수 있는 경로를 **판정해서 밝힌다**(v2.517 규약) ──────────────────────
 * 한 서버에 대해 우리가 가진 경로는 최대 둘이고, 둘 다 없는 경우가 실제로 많다:
 *   `idrac`  — 등록부에 iDRAC 주소·계정이 있다 → CPU·MEM·IO(집계) 를 텔레메트리로 읽는다.
 *   `os`     — 베어메탈 스토리지 등록부(`bmstor`)에 그 호스트의 OS 계정이 있다 →
 *              CPU·MEM·**디스크·네트워크·HBA** 전부를 읽는다.
 *   (없음)   — `reason` 으로 **왜 없는지** 말한다. '수집 안 됨' 으로 뭉개지 않는다.
 *
 * ⚠ **엣지 위임 서버는 중앙이 접속할 수 없다**(`remoteAgent`). 중앙은 자기 것만 수집하고
 *   위임분은 그 엣지가 수집해 push 한다(스토리지·SAN·파트장애와 같은 구조).
 *   이 경계를 지우면 같은 서버를 두 곳에서 찔러 iDRAC 세션이 두 배가 된다.
 *   v2.959: 원격 수집 서버(엣지)가 iDRAC 을 맡은 서버(원격 전력 출처 · collectorId — remoteAgent 없음)도 이 노드에 등록이 없으면 그 엣지 위임이다(아래 루프 주석).
 * ⚠ `serverId` 가 `host:<vcenterId>:<name>` 인 항목은 **수동 태그로 베어메탈이 된 ESXi 호스트**로
 *   (`fleetInventory.js:170`) iDRAC 등록이 없다 — 그것을 '주소 없음' 이라 말해야 한다.
 */
import { licenseFromInventory } from './license.js';
import { hbaBasisFor } from './hbaBasis.js'; // v2.744(감사 LEFT-08 ②)
import { addressMatcher, extendMatcher, maskIdentityFields, maskedIdToken, maskedAddressName } from '../auth/addressMask.js';
import { overlapIdOf, decidedKeyOf } from './keyDecisions.js'; // 다음 점검 ①(2차): 식별 키가 겹치는 서버 — 사용자 결정

const t = (v) => String(v ?? '').trim();
const norm = (v) => t(v).toLowerCase();
/**
 * 호스트 비교용 정규화. ⚠⚠ **iDRAC 등록부의 `host` 에는 스킴이 붙어 있다**(`https://10.0.0.1`) —
 *   `idrac/registry.js` 가 그렇게 저장하고 `redfish.js` 가 그대로 base 로 쓴다. OS 계정 등록부
 *   (`bmstor`)는 주소만(`10.0.0.1`) 저장하므로, 그대로 비교하면 **host 매칭이 영원히 실패**해
 *   OS 경로가 붙지 않는다(v2.550 실화면 검증에서 발견 — 목 데이터로 재현했다).
 *   스킴·끝 슬래시·포트·대괄호(IPv6)를 떼고 비교한다.
 */
export function hostKey(v) {
  let s = norm(v).replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/\/+$/, '');
  if (s.startsWith('[')) { const m = /^\[([^\]]+)\]/.exec(s); return m ? m[1] : s; }   // IPv6 리터럴
  s = s.split('/')[0];
  const colon = s.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(s.slice(colon + 1))) s = s.slice(0, colon);            // :443 같은 포트
  return s;
}

/** 경로 없음 사유 — 조치가 서로 다르므로 한 문구로 덮지 않는다. */
export const NO_PATH_REASON = Object.freeze({
  'corp-off': '이 법인은 수집을 켜지 않았습니다.',
  unassigned: '법인 귀속이 없습니다(어느 법인 부하인지 알 수 없어 기본 제외).',
  'edge-delegated': '엣지가 수집하는 서버입니다 — 중앙에서는 접속하지 않습니다.',
  'no-idrac': 'iDRAC 등록이 없습니다(수동 태그로 베어메탈이 된 ESXi 호스트일 수 있습니다).',
  'no-idrac-cred': 'iDRAC 등록에 계정·비밀번호가 없습니다.',
  'no-os-cred': 'OS 계정이 없습니다 — 설정 › 베어메탈 스토리지에 이 호스트를 등록하면 디스크·네트워크·HBA 까지 읽습니다.',
  'both-off': 'iDRAC 텔레메트리와 OS SSH 가 모두 꺼져 있습니다.',
  // 2차 재확인 G3 — OS 등록을 법인으로 가른다(pickOsEntry). 0 · 정상이 아니다 — 등록을 고치면 다음 주기부터 OS 경로가 생긴다.
  'os-ambiguous': 'OS 계정 등록을 하나로 정할 수 없습니다 — 같은 이름 · 주소의 등록이 여럿(주소가 다름)이거나, 법인을 지정하지 않은 등록입니다(‘수집에 추가’ 한 서버는 법인이 맞는 등록만 씁니다). 설정 › 베어메탈 스토리지에서 그 등록에 법인을 지정하세요.',
  'os-foreign': 'OS 계정 등록이 다른 법인으로 지정돼 있어 쓰지 않습니다(다른 법인 서버의 주소 · 계정으로 접속하지 않게). 설정 › 베어메탈 스토리지에서 법인을 확인하세요.',
  'key-conflict': '식별 키가 이 노드의 다른 서버와 겹칩니다 — 두 서버의 값이 한 행에 섞이지 않게 수집하지 않습니다(설정 › iDRAC 등록에서 서비스태그를 채우면 키가 갈려 다음 주기부터 수집합니다).',
  // v2.959: 원격 수집 서버(엣지)가 보낸 전력으로만 보이는데 이 노드에 iDRAC · OS 등록이 없고, 그 수집 서버의 이름을 등록부에서 확인하지 못했다.
  //   어느 엣지가 수집하는지 모르므로 ‘엣지 수집’ 으로도 ‘iDRAC 등록 없음’ 으로도 말하지 않는다(못 읽음 ≠ 없음). 갈래는 행의 collectorIssue(unread · not-found · no-name).
  'remote-collector-unknown': '원격 수집 서버(엣지)가 보낸 전력으로만 보이는 서버인데, 그 수집 서버의 이름을 등록부에서 확인하지 못했습니다(수집 서버 등록부를 읽지 못함 · 등록부에 없는 수집 서버(삭제됨) · 이름이 빈 등록 중 하나) — 어느 엣지가 수집하는지 몰라 중앙에서 접속하지 않습니다. 설정 › 엣지·원격 › 수집 서버(원격)를 확인하세요.',
});

/**
 * v2.959 — 원격 수집 서버 id → 이름 색인(순수). `remoteCollectors` = `{ readable, names: Map<id, name> }`(insights/fleetInventory.js getFleetInventory 가
 *   유령 키 판정과 같은 한 번의 등록부 읽기로 만든다 — 대상 해석이 등록부를 다시 읽지 않는다). 이름은 **등록부의 name**(엣지 보관분 표 `/tools/bm-usage/edges` 의
 *   agent 와 같은 값)이고 엣지가 보낸 문자열이 아니다. 못 읽었거나(readable 거짓 · 색인 없음) 없는 id · 이름 없는 항목은 ''(추측하지 않는다).
 *   반증 의심 2: 등록부에 있는데 이름이 빈 항목은 'not-found'(삭제됨) 가 아니라 'no-name' 이다(사유를 사실대로).
 * @returns {{ name:string, id?:string, issue:''|'unread'|'not-found'|'no-name' }}
 */
export function remoteCollectorNameOf(remoteCollectors, collectorId) {
  const id = t(collectorId);
  if (!remoteCollectors || typeof remoteCollectors !== 'object' || remoteCollectors.readable !== true || !(remoteCollectors.names instanceof Map)) return { name: '', issue: 'unread' };
  if (!id) return { name: '', issue: 'not-found' };
  const m = remoteCollectors.names;
  const has = m.has(id) || m.has(id.toLowerCase());
  const name = t(m.has(id) ? m.get(id) : m.get(id.toLowerCase()));
  return name ? { name, id, issue: '' } : { name: '', issue: has ? 'no-name' : 'not-found' };   // id — 재확인 R1 이름 겹침 판정(agentNameClash 는 대소문자를 보지 않는다)
}

/**
 * 반증 F2 · 재확인 R1 — 위임 행의 엣지 이름을 **수집 서버 등록부의 name 하나로** 맞춘다(순수). fleet 보고 경로의 이름은 엣지 인증 agent(등록 id 가 원칙)이고
 *   원격 전력 경로는 등록부 name 이라, 그대로 두면 같은 엣지가 ‘엣지 수집 — 엣지별’ 칩 두 개로 갈라지고 한쪽은 엣지 표(/tools/bm-usage/edges — agent = name)에서 못 찾았다.
 *   찾는 순서: **전 항목에서 id 일치 먼저**(대소문자 · 앞뒤 공백 무시) → 없을 때만 name 일치(목록 앞 항목). R1: 예전에는 항목마다 id → name(목록 순서)이라 앞 항목의 name 이
 *   뒤 항목의 id(그 엣지의 인증 이름)와 같으면 다른 엣지로 묶었다. id 로 찾은 항목의 name 이 비었거나 · 등록부를 못 읽었거나 · 등록부에 없는 이름이면 받은 이름 그대로(지어내지 않는다).
 * @returns {{ name:string, id:string }}  id = 찾은 수집 서버 id('' = 못 찾음)
 */
export function canonicalAgentRef(remoteCollectors, agent) {
  const a = t(agent);
  const rc = remoteCollectors;
  if (!a || !rc || rc.readable !== true || !(rc.byId instanceof Map) || !(rc.byName instanceof Map)) return { name: a, id: '' };
  const k = a.toLowerCase();
  const hit = rc.byId.get(k) || rc.byName.get(k) || null;
  return hit && t(hit.name) ? { name: t(hit.name), id: t(hit.id) } : { name: a, id: '' };
}
/** 이름만(호환). */
export function canonicalAgentOf(remoteCollectors, agent) { return canonicalAgentRef(remoteCollectors, agent).name; }
/**
 * 재확인 R1 — 보이는 이름(name)으로 당기기 · 중앙에서 켜기 · 엣지 표 · 누락 점검의 봉투 찾기를 하면 **다른 수집 서버로 가는가**(순수).
 *   그 경로들은 이름을 collector/registry.js findCollectorByName(목록 앞 항목 · 항목마다 id 또는 name)으로 푼다 — 이 서버의 수집 서버(id)가 아닌 항목이 그 이름을 먼저 가지면 참.
 *   모르면(색인 없음 · id 없음) 거짓(판정할 근거가 없다 — 이름은 그대로 보인다).
 */
export function agentNameClash(remoteCollectors, name, id) {
  const rc = remoteCollectors;
  const n = t(name).toLowerCase(); const i = t(id);
  if (!n || !i || !rc || rc.readable !== true || !(rc.firstAlias instanceof Map)) return false;
  const owner = rc.firstAlias.get(n);
  return owner != null && t(owner).toLowerCase() !== i.toLowerCase();
}
/** 위임 행에 붙일 엣지 이름 필드(중앙 — 정규화 이름 + 겹침 표지). */
function delegatedAgentFields(remoteCollectors, agent) {
  const r = canonicalAgentRef(remoteCollectors, agent);
  return { agent: r.name, ...(agentNameClash(remoteCollectors, r.name, r.id) ? { agentClash: true } : {}) };
}

/**
 * OS 계정 색인 — `bmstor` 등록부를 host·name 으로 찾을 수 있게 만든다(순수).
 * ⚠ 같은 host 가 여러 번 등록될 수 있으므로 **처음 것을 쓰고** 나머지는 세어 밝힌다.
 */
export function indexOsHosts(bmServers = []) {
  const byHost = new Map();
  const byName = new Map();
  // 2차 재확인 G3: 같은 host · 이름의 등록 **전부**(등록 순) — pickOsEntry 가 법인으로 가른다(첫 등록만 보면 다른 법인 등록을 집는다).
  const allByHost = new Map();
  const allByName = new Map();
  const push = (m, k, s) => { const l = m.get(k); if (l) l.push(s); else m.set(k, [s]); };
  let dup = 0;
  for (const s of bmServers) {
    if (!s || typeof s !== 'object') continue;
    const h = hostKey(s.host);
    const n = norm(s.name);
    if (h) { if (byHost.has(h)) dup += 1; else byHost.set(h, s); push(allByHost, h, s); }
    if (n) { if (!byName.has(n)) byName.set(n, s); push(allByName, n, s); }
  }
  return { byHost, byName, allByHost, allByName, duplicates: dup };
}

/**
 * OS 등록 고르기(순수 · 2차 재확인 G3) — 예전에는 iDRAC 주소 → 이름 → 이름 = 주소 순으로 **첫 등록**을 집어 법인을 보지 않았다
 *   (같은 이름 ‘db01’ 이 두 법인에 등록돼 있으면 B 서버가 A 법인 등록의 주소 · 계정으로 SSH — 같은 B 키에 A 서버 값이 쌓였다).
 *   단계(① iDRAC 주소 = OS 주소 ② 이름 ③ 이름 = 주소)마다 그 단계의 등록을 법인으로 가른다:
 *   · 다른 법인으로 지정된 등록(vcenterId ≠ 이 서버 법인)은 **쓰지 않는다**(그 단계만 그러면 다음 단계로 · 끝까지 없으면 'os-foreign').
 *   · 이 법인 등록이 있으면 그것만 · 법인 미지정(7b 이전 등록)은 strict 가 아닐 때만 — strict(‘수집에 추가’ 한 별도 키 서버)는 법인이 맞는 등록만(미지정이면 'os-ambiguous').
 *   · 남은 등록의 주소가 하나면(같은 장비의 중복 등록 — 예전과 같은 첫 등록) 그것 · 주소가 여럿이면 'os-ambiguous'(어느 장비인지 모른다 — 0/정상 아님).
 *   ⚠ 예전 동작과 달라지는 것은 셋뿐(시험 bmKeyOverlap ⑧ A/B): 다른 법인 등록을 집던 것 · 같은 이름 다른 주소(법인 미지정)를 첫 등록으로 집던 것 ·
 *     법인 지정 등록과 미지정 등록이 섞이면 지정 등록을 먼저. 그 서버는 OS 경로 없이(iDRAC 만 · 둘 다 없으면 대상이 아닌 서버) 사유가 화면에 보인다.
 * @returns {{ entry: object|null, reason: ''|'os-ambiguous'|'os-foreign' }}
 */
export function pickOsEntry(os, { regHost = '', name = '', vc = '', strict = false } = {}) {
  const v = t(vc);
  const stages = [os?.allByHost?.get(hostKey(regHost)), os?.allByName?.get(norm(name)), os?.allByHost?.get(hostKey(name))];
  let foreign = false; let unknownStrict = false;
  for (const list of stages) {
    if (!Array.isArray(list) || !list.length) continue;
    const own = v ? list.filter((s) => t(s.vcenterId) === v) : [];
    const unk = list.filter((s) => !t(s.vcenterId));
    // 3차 재확인 H2: 이 서버의 법인을 모르면(귀속 없음) 법인 지정 등록은 ‘다른 법인’ 이 아니라 ‘어느 것인지 모름’ 이다.
    if (list.some((s) => t(s.vcenterId) && t(s.vcenterId) !== v)) { if (v) foreign = true; else unknownStrict = true; }
    const use = own.length ? own : (strict ? [] : unk);
    if (!use.length) { if (strict && unk.length) unknownStrict = true; continue; }
    if (new Set(use.map((s) => hostKey(s.host))).size === 1) return { entry: use[0], reason: '' };
    return { entry: null, reason: 'os-ambiguous' };
  }
  return { entry: null, reason: unknownStrict ? 'os-ambiguous' : foreign ? 'os-foreign' : '' };
}

/**
 * 대상 해석.
 * @param {object} p
 * @param {Array}  p.bareMetal   `classifyFleet().bareMetal`
 * @param {Array}  p.registry    `idrac/registry.js loadRegistry()` — host·username·password·agent 보유
 * @param {Array}  p.bmServers   `bmstor/registry.js listBmServersRaw()` — OS 계정
 * @param {object} p.settings    `loadBmUsageSettings()`
 * @param {string} p.agentName   이 노드의 agent 이름(엣지면 자기 것만 가져간다)
 * @param {boolean} p.isEdge     이 노드가 엣지인가
 * @param {function} [p.inventoryOf] `(registryId) => inv` — **캐시된** iDRAC 인벤토리(장비 왕복 0).
 *   v2.554: 이것으로 라이선스 등급(Datacenter/Enterprise)을 판정해 화면이 '텔레메트리가 왜 비었나'
 *   를 추측이 아니라 **근거로** 말한다(`bmusage/license.js` 머리말).
 * @param {object|null} [p.remoteCollectors] v2.959 — `{ readable, names, byId, byName, firstAlias }`(insights/fleetInventory.js remoteCollectorIndex — remoteCollectorNameOf · canonicalAgentRef · agentNameClash). 없으면 '못 읽음'.
 * @param {object|null} [p.registryUnread] 반증 F1 — `{ idrac:boolean, os:boolean }` 이 노드의 iDRAC · OS 등록부를 **읽지 못했는가**(poller sourceErrors 와 같은 판정).
 *   못 읽은 동안은 '이 노드에 등록이 없다' 를 알 수 없으므로 원격 위임 갈래를 타지 않는다(예전 사유 그대로 — sourceErrors 경고가 설명한다).
 * @returns {{targets:Array, skipped:Array, counts:object}}
 */
export function resolveTargets({ bareMetal = [], virtHosts = [], vcenters = [], registry = [], bmServers = [], settings = {}, agentName = '', isEdge = false, inventoryOf = null, now = Date.now(), dupes = [], decisions = null, remoteCollectors = null, registryUnread = null } = {}) {
  // 반증 F1: 등록부를 못 읽은 것은 '등록 없음' 이 아니다 — 베어메탈은 iDRAC · OS 둘 다 · 가상화 호스트는 iDRAC 만(OS 경로가 없다) 본다.
  const idracUnread = !!(registryUnread && registryUnread.idrac);
  const bmRegUnread = idracUnread || !!(registryUnread && registryUnread.os);
  const regById = new Map(registry.map((r) => [t(r.id), r]));
  const regByTag = new Map(registry.filter((r) => t(r.serviceTag)).map((r) => [norm(r.serviceTag), r]));
  const os = indexOsHosts(bmServers);
  const corps = settings.corps || {};
  const me = norm(agentName);

  const targets = [];
  const skipped = [];
  /*
   * 다음 점검 ①(2차 · 사용자 결정): **식별 키가 겹치는 서버**를 조용히 버리지 않는다.
   *   dupes = 분류(classifyFleet)가 같은 dk 라 bareMetal 에 넣지 않은 서버(bareMetalDupes) · 아래 가상화 호스트 루프의 같은 키 건너뜀 —
   *   이 노드가 맡는(mine) · 켠 법인의 것만 keyOverlaps 로 올린다(법인 · 이름 · 주소 · 원문 서비스태그 · serverId · 출처 · 겹친 상대 · 결정).
   *   decisions(oid → 결정)가 ‘수집에 추가’ 면 그 서버를 **별도 키**(keyDecisions.decidedKeyOf — `<법인>:<serverId>`)로 대상에 넣는다.
   *   같은 결정은 그 서버가 더는 겹치지 않아도 키를 지킨다(키가 바뀌어 이력 · 주석 · 정비 창이 끊기지 않게).
   *   결정이 없거나 ‘제외 유지’ 면 예전처럼 수집하지 않는다(이미 수집 중인 상대 서버의 키 · 이력은 그대로).
   */
  const decOf = (role, x) => { const d = decisions && typeof decisions.get === 'function' ? decisions.get(overlapIdOf({ role, vcenterId: x.vcenterId, serverId: x.serverId, name: x.name })) : null; return d || null; };
  const isMine = (owner) => (isEdge ? (!owner || owner === me) : !owner);
  const corpOn = (vc) => (vc ? !!corps[vc] : !!settings.includeUnassigned);
  const keyOverlaps = [];
  const bmIn = [];
  for (const b of bareMetal) {
    if (!b || typeof b !== 'object') continue;
    const d = decOf('bm', { ...b, vcenterId: t(b.vcenterId) });
    bmIn.push(d?.decision === 'add' ? { ...b, keyOverride: d.key } : b);
  }
  for (const d0 of Array.isArray(dupes) ? dupes : []) {
    if (!d0 || typeof d0 !== 'object') continue;
    const vc = t(d0.vcenterId);
    if (!isMine(norm(d0.remoteAgent)) || !corpOn(vc)) continue;   // 엣지가 맡는 서버는 그 엣지가 · 꺼진 법인은 대상이 아니다(겹침과 무관)
    const dec = decOf('bm', { ...d0, vcenterId: vc });
    const reg = regById.get(t(d0.serverId)) || null;   // ⚠ 서비스태그로 찾지 않는다 — 공통 태그(‘To Be Filled By O.E.M.’)면 남의 등록을 집는다
    const osPick = pickOsEntry(os, { regHost: reg?.host, name: d0.name, vc, strict: true });   // G3: 겹침 행 · ‘추가’ 뒤 경로는 법인이 맞는 OS 등록만
    const osEntry = osPick.entry;
    const nat = idOf(d0);
    keyOverlaps.push({ oid: overlapIdOf({ role: 'bm', vcenterId: vc, serverId: d0.serverId, name: d0.name }), role: 'bm', stage: 'classify',
      serverId: t(d0.serverId), fleetId: t(d0.fleetId), name: t(d0.name), serviceTag: t(d0.serviceTag), key: nat.key, keyKind: nat.keyKind,
      vcenterId: vc, vcName: t(d0.vcenter), source: t(d0.source), model: t(d0.model), idracHost: t(reg?.host), osHost: t(osEntry?.host), osIssue: osPick.reason || '',
      dupOf: d0.dupOf && typeof d0.dupOf === 'object' ? { key: nat.key, name: t(d0.dupOf.name), vcenterId: t(d0.dupOf.vcenterId), source: t(d0.dupOf.source), edge: !!t(d0.dupOf.remoteAgent) } : null,
      decision: dec, decidedKey: dec?.key || decidedKeyOf({ role: 'bm', vcenterId: vc, serverId: d0.serverId, name: d0.name }) });
    if (dec?.decision === 'add') bmIn.push({ ...d0, keyOverride: dec.key, decided: true });
  }
  for (const b of bmIn) {
    const vc = t(b.vcenterId);
    const owner = norm(b.remoteAgent);
    // 이 노드가 담당하는 서버인가 — 엣지는 **자기 로컬 등록분**(remoteAgent 없음)과 자기 agent 것, 중앙은 agent 없는 것만.
    // ⚠ v2.626: 예전 조건 `owner && owner === me` 는 엣지의 로컬 등록 서버(remoteAgent 는 중앙이 엣지 보고를 합칠 때만
    //   붙는다 — 엣지 자신의 분류에는 없다)를 전부 '위임됨' 으로 빼서 **엣지가 물리 서버를 한 대도 수집하지 못했다**.
    //   엣지의 분류에는 남의 엣지 서버가 들어오지 않으므로(fleetInventory 는 중앙에서만 엣지 보고를 합친다) 넓혀도 안전하다.
    const mine = isEdge ? (!owner || owner === me) : !owner;
    // 반증 F2: 이름은 수집 서버 등록부 name 으로 맞춘다(중앙만 — 엣지 노드에는 남의 엣지 서버가 들어오지 않는다). 등록부에 없는 이름은 그대로.
    if (!mine) { skipped.push({ ...idOf(b), reason: 'edge-delegated', ...(isEdge ? { agent: b.remoteAgent || '' } : delegatedAgentFields(remoteCollectors, b.remoteAgent)) }); continue; }

    // 다음 점검 ①(2차): 별도 키로 수집하는 서버(keyOverride)는 서비스태그로 등록을 찾지 않는다 — 공통 태그면 다른 서버의 iDRAC 을 집는다.
    const reg = regById.get(t(b.serverId)) || (t(b.serviceTag) && !b.keyOverride ? regByTag.get(norm(b.serviceTag)) : null) || null;
    // 2차 재확인 G3: OS 등록은 법인으로 가른다(pickOsEntry) — 별도 키 서버(keyOverride)는 법인이 맞는 등록만(strict).
    const osPick = pickOsEntry(os, { regHost: reg?.host, name: b.name, vc, strict: !!b.keyOverride });
    /*
     * v2.959 — **원격 수집 서버(엣지)가 iDRAC 을 맡은 서버는 그 엣지가 수집한다**(사용자 보고: 엣지 iDRAC 스캔이 자동 등록한 서버가 중앙에서
     *   ‘iDRAC 등록 없음’ 1,157대로 보였다). 그 서버의 bareMetal 행은 원격 전력(collector/state.js — 수집 서버 pull) 출처라 `remoteAgent` 가 없고
     *   (엣지 이름은 fleet 보고에만 실리는데 같은 서버의 fleet 보고는 fleetInventory 가 겹침으로 버린다), 중앙은 자기 iDRAC 등록부에서 찾다가 없으니 no-idrac 이었다.
     *   계정은 그 엣지에만 있고 중앙은 그 사설망에 닿지 못한다(법인 로컬 원칙) — 계정을 가져오지 않고 ‘엣지 수집 — 그 엣지’ 로 말한다.
     *   조건(전부): 중앙(엣지 아님) · 출처 remote · collectorId 있음 · **이 노드에 이 서버의 등록이 하나도 없음**(iDRAC 등록 · OS 계정 · 법인이 맞지 않는 OS 등록까지 —
     *   등록이 있으면 이 노드 설정의 문제이므로 예전 사유 그대로). 그래서 예전에 이 노드가 수집하던 대상은 하나도 빠지지 않는다(대상에는 등록이 필요하다 —
     *   불변식 시험 bmRemoteDelegate2959). 사유 순서: 법인 꺼짐 · 귀속 없음보다 먼저 — 중앙 설정(법인 켜기 · 귀속 포함)을 바꿔도 중앙은 수집할 수 없고
     *   수집 여부는 그 엣지 설정이 정한다(엣지 보관분 표의 ‘엣지에서 꺼짐’ → ‘중앙에서 켜기’). 법인 축(vcenterId)은 싣는다 — 범위 계정은 범위 안 행만 본다.
     *   수집 서버를 등록부에서 못 찾거나 등록부를 못 읽으면 이름을 추측하지 않고 remote-collector-unknown(엣지 수집에도 no-idrac 에도 넣지 않는다).
     *   반증 F1: **이 노드의 iDRAC · OS 등록부를 못 읽은 동안은 이 갈래를 타지 않는다**(빈 목록은 '등록 없음' 이 아니라 '모름' — 중앙이 수집하던 서버를
     *   '엣지 수집' 으로 단정했다). 예전 사유(no-idrac · no-os-cred · 법인 꺼짐 …)로 두고 sourceErrors 경고가 그 이유를 말한다.
     */
    if (!isEdge && !bmRegUnread && t(b.source) === 'remote' && t(b.collectorId) && !reg && !osPick.entry && !osPick.reason) {
      const who = remoteCollectorNameOf(remoteCollectors, b.collectorId);
      if (who.name) skipped.push({ ...idOf(b), reason: 'edge-delegated', agent: who.name, ...(agentNameClash(remoteCollectors, who.name, who.id) ? { agentClash: true } : {}), vcenterId: vc, delegatedBy: 'collector', ...edgeKeyOf(b) });
      else skipped.push({ ...idOf(b), reason: 'remote-collector-unknown', vcenterId: vc, collectorIssue: who.issue });
      continue;
    }
    if (!vc) {
      if (!settings.includeUnassigned) { skipped.push({ ...idOf(b), reason: 'unassigned' }); continue; }
    } else if (!corps[vc]) {
      skipped.push({ ...idOf(b), reason: 'corp-off', vcenterId: vc }); continue;
    }
    const osEntry = osPick.entry;
    const osReason = osPick.reason || 'no-os-cred';

    const paths = [];
    let idracReason = '';
    if (settings.idracTelemetry) {
      if (!reg || !t(reg.host)) idracReason = 'no-idrac';
      else if (!t(reg.username) || !t(reg.password)) idracReason = 'no-idrac-cred';
      else paths.push('idrac');
    }
    if (settings.osSsh && osEntry) paths.push('os');

    if (!paths.length) {
      // 3차 재확인 H2: OS 등록이 있는데 법인이 맞지 않아 쓰지 않았으면(os-foreign · os-ambiguous) 그것이 사유다 — 예전에는 iDRAC 사유(no-idrac)만 보여
      //   기준판에서 OS 로 수집되던 서버가 왜 빠졌는지 화면이 말하지 못했다. iDRAC 쪽 사유는 idracIssue 로 함께 싣는다.
      const reason = (!settings.idracTelemetry && !settings.osSsh) ? 'both-off'
        : (settings.osSsh && osPick.reason) ? osPick.reason
          : (settings.osSsh && !osEntry && idracReason) ? idracReason
            : (idracReason || osReason);
      skipped.push({ ...idOf(b), reason, vcenterId: vc, osMissing: !osEntry, ...(osPick.reason ? { osIssue: osPick.reason } : {}), ...(idracReason && reason !== idracReason ? { idracIssue: idracReason } : {}) });
      continue;
    }
    /*
     * iDRAC 라이선스 등급(v2.554) — **캐시된 인벤토리만** 읽는다(장비 왕복 0).
     * ⚠ 인벤토리가 없으면 `unknown` 이고 '라이선스가 없다' 고 말하지 않는다.
     * ⚠ `entAllowed` 는 '설정이 허용하는가' 일 뿐이다 — **실제로 시도할지**는 텔레메트리 결과를
     *   본 뒤 `license.enterpriseEligible()` 이 정한다(정상인 Datacenter 장비에 부하를 더하지 않게).
     */
    const license = (paths.includes('idrac') && typeof inventoryOf === 'function')
      ? licenseFromInventory((() => { try { return inventoryOf(t(reg.id)); } catch { return null; } })(), { now })
      : { tier: 'unknown', label: '미상', names: [], count: 0, expired: 0, evaluation: false, matched: '', source: '', at: null };
    targets.push({
      ...idOf(b), vcenterId: vc, vcName: b.vcName || '', model: b.model || '',
      role: 'bm',
      paths,
      license,
      // v2.610: HPE iLO 로 등록된 서버에는 Dell 전용 대체 경로(iDRAC SSH racadm)를 걸지 않는다 — iLO 에 racadm 은 없고
      //   SSH 로그인만 시도해 실패가 쌓인다.
      entAllowed: !!(paths.includes('idrac') && settings.enterpriseEnabled && settings.enterpriseAck && String(reg?.vendor || '').toLowerCase() !== 'hpe'),
      // ⚠ 비밀은 여기 담기지만 **응답에는 절대 싣지 않는다**(라우트가 publicTarget 으로 뺀다).
      // `regId`(v2.590): 주 iDRAC 폴러의 인증 실패 정지 기록을 같은 id 로 조회하기 위한 것(poller.js).
      idrac: paths.includes('idrac') ? { regId: t(reg.id), host: t(reg.host), username: t(reg.username), password: reg.password } : null,
      osHost: paths.includes('os') ? osEntry : null,
      // OS 계정은 있는데 iDRAC 이 없거나 반대인 경우 — 그 사실을 화면이 말해야 한다.
      missing: [idracReason, (settings.osSsh && !osEntry) ? osReason : ''].filter(Boolean),
    });
  }

  /*
   * ── 가상화 호스트(ESXi) — v2.625 ────────────────────────────────────────────
   * 사용자 요청 "iDRAC 사용량을 ESXi 호스트까지 넓혀서". `settings.includeVirtualization` 이 켜진 경우만(기본 꺼짐).
   *  · 대상은 `classifyFleet().virtualizationHosts` 그대로다(판정 복제 금지 — 베어메탈과 같은 규칙).
   *  · 경로는 **iDRAC 하나**다 — ESXi 에 OS SSH(/proc)를 걸지 않는다.
   *  · 위임: 엣지가 push 한 vCenter(`collectSource:'site'`)의 호스트는 **그 엣지**가 수집한다. 중앙은 건드리지 않는다
   *    (같은 호스트에 iDRAC 세션이 두 배가 된다 — 베어메탈 `remoteAgent` 규칙과 같다).
   *  · 받치는 iDRAC 을 모르면(`idracServerId` 없음·서비스태그로도 못 찾음) `no-idrac` 로 밝힌다 — '법인별 서버 사용량' 화면은
   *    그 호스트를 vCenter 값으로 채운다(사용자 선택).
   *  · 켜지 않았으면 제외 목록에도 싣지 않는다 — 수백 대의 '꺼짐' 행이 베어메탈 화면의 사유 목록을 덮는다.
   */
  if (settings.includeVirtualization) {
    const siteAgent = siteAgentByVcenter(vcenters);
    const bmKeys = new Set(targets.map((x) => x.key));
    for (const h of virtHosts || []) {
      if (!h || typeof h !== 'object') continue;
      const vc = t(h.vcenterId);
      let idv = idOf({ serverId: h.idracServerId, fleetId: h.fleetId, name: h.name, serviceTag: h.serviceTag });
      if (!vc) continue;                                   // 가상화 호스트는 늘 vCenter 에 매인다 — 없으면 합성 행(판정 불가)
      const vdec = decOf('virt', { vcenterId: vc, serverId: h.idracServerId, name: h.name });
      if (vdec?.decision === 'add') idv = idOf({ serverId: h.idracServerId, fleetId: h.fleetId, name: h.name, serviceTag: h.serviceTag, keyOverride: vdec.key });
      if (bmKeys.has(idv.key)) {
        // 같은 키의 대상이 이미 있다(같은 물리 박스가 베어메탈로도 잡혔거나 · 이름 · 공통 태그가 겹친 다른 호스트) — 예전에는 사유 없이 건너뛰었다(반증 F1).
        //   이 노드가 맡는 · 켠 법인의 호스트면 ‘식별 키가 겹치는 서버’ 로 올린다(같은 iDRAC 을 받치는 호스트면 sameIdrac — 같은 박스일 가능성).
        const owner0 = norm(siteAgent.get(vc) || '');
        if ((owner0 ? (isEdge && owner0 === me) : true) && corps[vc]) {
          const peer = targets.find((x) => x.key === idv.key) || null;
          const reg0 = regById.get(t(h.idracServerId)) || null;
          keyOverlaps.push({ oid: overlapIdOf({ role: 'virt', vcenterId: vc, name: h.name }), role: 'virt', stage: 'virt',
            serverId: t(h.idracServerId), fleetId: t(h.fleetId), name: t(h.name), serviceTag: t(h.serviceTag), key: idv.key, keyKind: idv.keyKind,
            vcenterId: vc, vcName: t(h.vcenter), source: 'vcenter-host', model: t(h.model), idracHost: t(reg0?.host), osHost: '',
            dupOf: peer ? { key: peer.key, name: t(peer.name), vcenterId: t(peer.vcenterId), source: peer.role === 'virt' ? 'vcenter-host' : 'bm', edge: false, sameIdrac: !!(reg0 && peer.idrac?.regId && t(reg0.id) === t(peer.idrac.regId)) } : null,
            decision: vdec, decidedKey: vdec?.key || decidedKeyOf({ role: 'virt', vcenterId: vc, name: h.name }) });
        }
        continue;
      }
      const owner = norm(siteAgent.get(vc) || '');
      const mine = owner ? (isEdge && owner === me) : true;
      if (!mine) { skipped.push({ ...idv, role: 'virt', reason: 'edge-delegated', ...(isEdge ? { agent: siteAgent.get(vc) || '' } : delegatedAgentFields(remoteCollectors, siteAgent.get(vc))), vcenterId: vc }); continue; }
      const reg = regById.get(t(h.idracServerId)) || (t(h.serviceTag) ? regByTag.get(norm(h.serviceTag)) : null) || null;
      /*
       * 반증 F4(가상화 호스트 — 같은 결함): 중앙이 직접 수집하는 vCenter 의 ESXi 호스트인데 그 호스트를 받치는 iDRAC 이 **엣지 원격 전력뿐**이면
       *   (classifyFleet 이 받침 원격 항목의 수집 서버 id 를 idracCollectorId 로 싣는다) 중앙 iDRAC 등록부에서 찾다가 없으니 no-idrac 이었다.
       *   베어메탈과 같은 규칙: 중앙 · 받침 원격 수집 서버 있음 · 이 노드 iDRAC 등록 없음 · iDRAC 등록부를 읽을 수 있음 → 엣지 수집(등록부 이름) · 이름을 모르면 remote-collector-unknown.
       *   가상화 호스트의 경로는 iDRAC 하나라 OS 등록은 보지 않는다. 중앙 등록이 있으면 예전 판정 그대로(불변식 — 대상에는 등록이 필요하다).
       */
      if (!isEdge && !idracUnread && t(h.idracCollectorId) && !reg) {
        const who = remoteCollectorNameOf(remoteCollectors, h.idracCollectorId);
        if (who.name) skipped.push({ ...idv, role: 'virt', reason: 'edge-delegated', agent: who.name, ...(agentNameClash(remoteCollectors, who.name, who.id) ? { agentClash: true } : {}), vcenterId: vc, delegatedBy: 'collector', ...edgeKeyOf({ serviceTag: h.serviceTag, serverId: h.idracServerId, collectorId: h.idracCollectorId, keyOverride: vdec?.decision === 'add' ? vdec.key : '' }) });
        else skipped.push({ ...idv, role: 'virt', reason: 'remote-collector-unknown', vcenterId: vc, collectorIssue: who.issue });
        continue;
      }
      if (!corps[vc]) { skipped.push({ ...idv, role: 'virt', reason: 'corp-off', vcenterId: vc }); continue; }
      if (!settings.idracTelemetry) { skipped.push({ ...idv, role: 'virt', reason: 'both-off', vcenterId: vc }); continue; }
      let idracReason = '';
      if (!reg || !t(reg.host)) idracReason = 'no-idrac';
      else if (!t(reg.username) || !t(reg.password)) idracReason = 'no-idrac-cred';
      if (idracReason) { skipped.push({ ...idv, role: 'virt', reason: idracReason, vcenterId: vc }); continue; }
      const license = typeof inventoryOf === 'function'
        ? licenseFromInventory((() => { try { return inventoryOf(t(reg.id)); } catch { return null; } })(), { now })
        : { tier: 'unknown', label: '미상', names: [], count: 0, expired: 0, evaluation: false, matched: '', source: '', at: null };
      targets.push({
        ...idv, vcenterId: vc, vcName: h.vcenter || '', model: h.model || '',
        role: 'virt',
        paths: ['idrac'],
        license,
        entAllowed: !!(settings.enterpriseEnabled && settings.enterpriseAck && String(reg?.vendor || '').toLowerCase() !== 'hpe'),
        idrac: { regId: t(reg.id), host: t(reg.host), username: t(reg.username), password: reg.password },
        osHost: null,
        missing: [],
      });
      bmKeys.add(idv.key);
    }
  }

  /*
   * ⚠⚠ **키 충돌을 조용히 두지 않는다**(v2.550.3) — 그리고 **수집하지 않는다**(다음 점검 ① · 2026-11-08 — v2.550.3 의 ‘대상에서 빼지 않는다’ 를 뒤집었다).
   *   이 노드의 저장 표는 전부 `(agent, key, …)` 가 기본키다(db.js usage_history · usage_daily · usage_latest · usage_devices · change_latest · log_cursor ·
   *   log_pattern · log_hour · log_sec · monthStore.js usage_hourly · usage_mount_daily · usage_device_* · top_sample · top_proc · top_proc_hourly) — 같은 키 두 서버는
   *   ① 최신값 · 일 롤업 · 커서 · 변경 기준이 한 행에 덮어써지고 ② 이력 행이 번갈아 섞이며(추이가 두 서버를 오간다) ③ 폴러의 인메모리 맵(_prev 누적 카운터 ·
   *   _authStopped 인증 정지 · 상세 · 로그 커서)도 키 하나를 같이 쓴다 — 한 서버의 인증 실패가 다른 서버 수집을 멈추고 카운터 차이가 두 서버 값으로 계산된다.
   *   예전 판은 ‘어느 쪽을 버릴지 근거가 없어 빼지 않는다’ 였지만 그 결과는 오류 없이 **틀린 값**이었다 — 섞인 값보다 ‘수집 안 함 · 이유’ 가 낫다(못 읽음은 0 이 아니다).
   *   그래서 같은 키의 **모든** 대상을 수집에서 빼고(어느 하나도 고르지 않는다 — 분류 순서는 전력값으로 바뀌어 매 주기 다른 쪽이 이긴다) `key-conflict` 로 밝힌다.
   *   ⚠ 기존 행의 키는 바꾸지 않는다(마이그레이션 없음 — 이미 섞인 이력은 보존일이 지나며 사라진다) · 서비스태그를 채워 키가 갈리면 다음 주기부터 다시 수집한다.
   *   목록은 **서버마다 한 줄**(그 서버의 법인 · 이름만) — 예전에는 한 줄에 두 서버 이름을 담고 법인은 하나라 범위 계정이 다른 법인 서버 이름을 봤다.
   */
  const groups = new Map();
  for (const x of targets) { if (!groups.has(x.key)) groups.set(x.key, []); groups.get(x.key).push(x); }
  const keyConflicts = [];
  let conflictGroups = 0;
  for (const [k, list] of groups) {
    if (list.length < 2) continue;
    conflictGroups += 1;
    for (const x of list) {
      keyConflicts.push({ key: k, names: [x.name].filter(Boolean), keyKind: x.keyKind, vcenterId: x.vcenterId || '', role: x.role, peers: list.length });
      skipped.push({ serverId: x.serverId, fleetId: x.fleetId, name: x.name, serviceTag: x.serviceTag, key: x.key, keyKind: x.keyKind, role: x.role, reason: 'key-conflict', vcenterId: x.vcenterId || '' });
    }
  }
  if (conflictGroups) {
    const bad = new Set([...groups].filter(([, l]) => l.length > 1).map(([k]) => k));
    for (let i = targets.length - 1; i >= 0; i -= 1) if (bad.has(targets[i].key)) targets.splice(i, 1);
  }

  const counts = { targets: targets.length, skipped: skipped.length, idrac: 0, os: 0, both: 0 };
  counts.virt = targets.filter((x) => x.role === 'virt').length;
  for (const x of targets) {
    if (x.paths.includes('idrac')) counts.idrac += 1;
    if (x.paths.includes('os')) counts.os += 1;
    if (x.paths.length > 1) counts.both += 1;
  }
  /*
   * 라이선스 등급 분포 — 화면이 '이 법인은 Enterprise 가 N대' 라고 말할 수 있게.
   * ⚠ `unknown` 을 Enterprise 에 흡수하지 않는다(v2.548 규약: 확인 못 한 것을 한쪽으로 접지 않는다).
   */
  const byLicense = {};
  for (const x of targets) {
    const k = t(x.license?.tier) || 'unknown';
    byLicense[k] = (byLicense[k] || 0) + 1;
  }
  counts.byLicense = byLicense;
  const byReason = {};
  for (const s of skipped) byReason[s.reason] = (byReason[s.reason] || 0) + 1;
  counts.byReason = byReason;
  counts.osDuplicates = os.duplicates;
  counts.keyConflicts = conflictGroups;   // 겹친 키 수(서버 수는 keyConflicts.length)
  // 다음 점검 ①(2차): 겹침 목록에 ‘지금 그 별도 키로 수집 대상인가’ 를 붙인다(결정 ‘추가’ 뒤 대상이 됐는지 — 경로 없음이면 skipped 사유로 따로 보인다).
  const liveKeys = new Set(targets.map((x) => x.key));
  for (const o of keyOverlaps) o.collecting = !!(o.decision?.decision === 'add' && liveKeys.has(o.decision.key));
  counts.keyOverlaps = keyOverlaps.length;
  return { targets, skipped, counts, keyConflicts, keyOverlaps };
}

/**
 * 안정 키 — 서비스태그 우선(v2.548 `deviceKey` 와 같은 등급 판단). v2.625: 법인별 사용량 집계가 같은 키로 최신값을 찾도록 export.
 *   다음 점검 ①(2차): `keyOverride` 가 있으면(식별 키 겹침 — 사용자가 ‘수집에 추가’ 를 고른 서버) 그 별도 키 · keyKind 'decided'.
 */
export function idOf(b) {
  const tag = t(b.serviceTag).toUpperCase();
  const ov = t(b.keyOverride);
  return {
    serverId: t(b.serverId),
    fleetId: t(b.fleetId),
    name: t(b.name),
    serviceTag: tag,
    key: ov || tag || t(b.fleetId) || t(b.serverId),
    keyKind: ov ? 'decided' : (tag ? 'serviceTag' : (t(b.fleetId) ? 'fleetId' : 'serverId')),
  };
}

/**
 * 반증 의심 1(재현 — 고침): 원격 위임 행의 **엣지 쪽 키**(누락 점검이 그 엣지 봉투의 성능 항목을 찾는 열쇠). 원격 전력 항목의 serverId 는
 *   `remote:<collectorId>:<엣지 등록 id>`(엣지 collector/agent.js buildExport 가 엣지 iDRAC 등록 id 를 싣는다 — idrac/service.js localPowerByHostName)이고,
 *   엣지는 서비스태그가 없는 서버를 그 등록 id 의 소문자(fleetId — 위 idOf)로 키를 삼는다. 중앙 키는 `remote:<c>:<id>` 라 그대로 찾으면 늘 '기록 없음' 이었다.
 *   서비스태그가 있으면 두 노드 키가 같아 싣지 않는다 · 별도 키(keyOverride)는 싣지 않는다 · serverId 가 그 꼴이 아니면 싣지 않는다(잇는 근거가 없다 — 누락 점검은 '모름').
 *   ⚠ 값이 주소일 수 있다(IP 로 등록한 엣지 iDRAC) — BM_ID_FIELDS 에 넣어 비관리자 응답에서 가린다.
 */
function edgeKeyOf(b) {
  if (t(b.serviceTag) || t(b.keyOverride)) return {};
  const pre = `remote:${t(b.collectorId)}:`.toLowerCase();
  const sid = t(b.serverId);
  if (!sid.toLowerCase().startsWith(pre)) return {};
  const rest = sid.slice(pre.length).trim().toLowerCase();
  return rest ? { edgeKey: rest } : {};
}

/**
 * 사이트 위임 vCenter → 그 vCenter 를 수집하는 엣지 이름(원형 · 모르면 '')(순수).
 * v2.927: 가상화 호스트 위임 판정(위 resolveTargets)과 '중앙에서 켜기'의 엣지별 법인 매핑(edgeCorpIndex)이 **같은 규칙**을 쓴다
 *   — 두 벌로 두면 한쪽만 고쳐져 '그 엣지가 수집한다' 는 판정과 '그 엣지의 법인' 이 갈라진다(판정 복제 금지).
 */
export function siteAgentByVcenter(vcenters = []) {
  return new Map((vcenters || []).filter((v) => v && (v.collectSource === 'site' || v.collectMode === 'site'))
    .map((v) => [t(v.id), t(v.collectedBy || v.agent)]));
}

/**
 * v2.927 '중앙에서 켜기' — vCenter id → 담당 엣지 이름(원형 · 중앙 직접·모름이면 '')(순수).
 *   우선순위(반증 F2 — 순간 상태에 흔들리지 않게 · 선례 vmclone/dispatch.js execTargetOf · ipam/scanDatacenter.js):
 *   ① 등록부 `collectMode:'site'` 의 `remoteAgent`(관리자가 선언한 담당 엣지 — 디스크) → ② 위임 인벤토리 소유(`listInventory().agent` — 디스크)
 *   → ③ 스냅샷 관측(siteAgentByVcenter — collectedBy). 점검중·비활성·push 전·기동 직후 골격이면 ③ 이 비지만 ①·② 는 남는다.
 *   등록부에 `direct` 로 있는 vCenter 는 '' 다(등록부가 이긴다). 비활성 vCenter 도 담당 선언은 그대로 센다(엣지의 법인 축은 남아 있다).
 */
export function siteOwnerByVcenter({ registry = [], inventory = [], vcenters = [] } = {}) {
  const observed = siteAgentByVcenter(vcenters);
  const invOwner = new Map();
  for (const e of inventory || []) if (e && typeof e === 'object' && e.vcenterId != null) invOwner.set(t(e.vcenterId), t(e.agent));
  const out = new Map();
  for (const r of registry || []) {
    if (!r || typeof r !== 'object') continue;
    const id = t(r.id);
    if (!id) continue;
    out.set(id, t(r.collectMode) === 'site' ? (t(r.remoteAgent) || invOwner.get(id) || observed.get(id) || '') : '');
  }
  for (const [id, a] of observed) if (id && !out.has(id)) out.set(id, a || invOwner.get(id) || '');
  return out;
}

/**
 * v2.927 '중앙에서 켜기' — 엣지 이름(소문자) → 그 엣지 법인(vCenter id) 집합(순수).
 *  ① 담당 엣지가 그 엣지인 사이트 vCenter(siteOwnerByVcenter — 법인 · vCenter · 엣지 1:1:1 의 기본 경우).
 *  ② 그 엣지가 보고한 베어메탈(`remoteAgent` = 그 엣지)의 vcenterId — vCenter 는 중앙이 직접 수집하고 iDRAC 만 엣지에 맡긴 법인.
 *     ⚠ 엣지가 보낸 값이다(엣지 정제 규약): **중앙이 아는 vCenter id 만** 쓰고, 다른 엣지가 담당하는 사이트 vCenter 는 넣지 않는다.
 *     ⚠ 정직 기록(반증 F3): fleet 수신은 **모르는 이름**의 공유 토큰 push 귀속만 비운다 — 아는 이름을 댄 공유 토큰 push 는 이 ② 를 바꿀 수 있다.
 *     그래서 이 결과는 **저장 때 한 번** 쓰고(확인 상자가 법인 이름을 보여 주고 관리자가 확인한 목록을 저장), 인출은 저장 목록을 그대로 보낸다.
 * @param {{registry?:Array, inventory?:Array, vcenters?:Array, bareMetal?:Array}} p  bareMetal 은 `{remoteAgent, vcenterId}` 행(엣지 보고 베어메탈)
 * @returns {Map<string, Set<string>>}
 */
export function edgeCorpIndex({ registry = [], inventory = [], vcenters = [], bareMetal = [] } = {}) {
  const owners = siteOwnerByVcenter({ registry, inventory, vcenters });
  const known = new Set([...owners.keys(), ...(vcenters || []).map((v) => (v && typeof v === 'object' ? t(v.id) : '')).filter(Boolean)]);
  const idx = new Map();
  const add = (agent, id) => {
    const k = norm(agent);
    if (!k || !id) return;
    if (!idx.has(k)) idx.set(k, new Set());
    idx.get(k).add(id);
  };
  for (const [vc, a] of owners) add(a, vc);
  for (const b of bareMetal || []) {
    if (!b || typeof b !== 'object') continue;
    const a = typeof b.remoteAgent === 'string' ? norm(b.remoteAgent) : '';
    const vc = typeof b.vcenterId === 'string' ? t(b.vcenterId) : '';
    if (!a || !vc || !known.has(vc)) continue;
    const owner = norm(owners.get(vc) || '');
    if (owner && owner !== a) continue;
    add(a, vc);
  }
  return idx;
}

/** 한 엣지의 법인 id 목록(정렬 · 대소문자 무시). idx 를 주면 그것으로(한 요청 안에서 한 번만 만든다). */
export function edgeCorpIds(input = {}, idx = null) {
  const set = (idx || edgeCorpIndex(input)).get(norm(input?.agent));
  return set ? [...set].sort() : [];
}

/**
 * 비-admin 응답용 — 관리 주소를 가린다(v2.600 AUTHZ-2600-08). `publicTarget` 은 자격증명만 빼고
 * iDRAC 관리 주소(`idracHost`)와 OS SSH 주소(`osHostName` — adminOnly 인 베어메탈 스토리지 등록부의 값)를
 * 그대로 실어 `tools` 권한(operator 기본 보유)에 나갔다(v2.599 AUTHZ-2599-03 과 같은 계열).
 * ⚠ `null`(그 경로가 없다)과 `''`(있지만 가렸다)을 구분해 남긴다 — 화면이 경로 유무를 판정한다.
 * `publicTarget` 의 두 번째 인자로 두지 않은 이유: 호출부가 `.map(publicTarget)` 이라 인덱스가 들어온다.
 */
export function maskTargetAddress(pt, hosts = [], baseMatch = null) {
  if (!pt || typeof pt !== 'object') return pt;
  // v2.601 AUTHZ-2601-01: IP 로 등록한 iDRAC 은 serverId·fleetId·key·name 이 곧 그 IP 다 —
  //   host 칸만 비우면 식별자로 그대로 샜다. 자기 주소 + 등록부 주소 목록과 같거나 IP 인 값을 가린다.
  // v2.602 RECENT2602-01: 목록 공통 판정기(baseMatch)를 받으면 행마다 주소 목록을 다시 만들지 않는다.
  const own = [pt.idracHost, pt.osHostName].filter((h) => typeof h === 'string' && h);
  const match = extendMatcher(baseMatch || addressMatcher((hosts || []).filter((h) => typeof h === 'string' && h)), own);
  return {
    ...maskBmIdentity(pt, match),
    idracHost: pt.idracHost == null ? pt.idracHost : '',
    osHostName: pt.osHostName == null ? pt.osHostName : '',
  };
}

/** 베어메탈 행의 식별 필드(대상·제외·최신값·키 충돌·인증 정지·귀속 없음 표본 공용, v2.601). */
export const BM_ID_FIELDS = Object.freeze(['serverId', 'fleetId', 'key', 'tagKey', 'deviceId', 'edgeKey']);   // edgeKey — 반증 의심 1(원격 위임 행의 엣지 쪽 키)
/**
 * 식별자가 주소인 베어메탈 행을 가린다(원본 불변). 토큰은 같은 원문이면 같으므로 대상의 `key` 와
 * 최신값 행의 `key` 가 계속 짝을 이룬다(화면 `byKey` 매칭이 깨지지 않는다).
 * `names`(키 충돌 목록)와 `reason`·`error`(인증 정지 사유 — 원문 주소가 실린다)도 함께 본다.
 */
export function maskBmIdentity(x, match) {
  if (!x || typeof x !== 'object') return x;
  const out = maskIdentityFields(x, match, { idFields: BM_ID_FIELDS, nameFields: ['name'] });
  if (Array.isArray(out.names)) out.names = out.names.map((n) => (match(n) ? maskedAddressName(n) : n));
  for (const f of ['reason', 'error']) {
    if (typeof out[f] === 'string') out[f] = out[f].replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, (ip) => maskedIdToken(ip));
  }
  return out;
}

/** 응답용 — 자격증명을 뺀다. ⚠ 라우트는 반드시 이것만 내보낼 것. */
export function publicTarget(x = {}) {
  const { idrac, osHost, ...rest } = x;
  return {
    ...rest,
    idracHost: idrac ? idrac.host : null,
    osHostName: osHost ? (osHost.host || '') : null,
    osMounts: osHost ? (osHost.mounts || []).length : null,
    // v2.744(감사 LEFT-08 ②): HBA 사용률 분모 근거(포트 수만 — 주소·식별자 없음). 이 노드가 수집한 적이 없으면 null.
    hbaBasis: hbaBasisFor(rest.key),
  };
}
