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
 * ⚠ `serverId` 가 `host:<vcenterId>:<name>` 인 항목은 **수동 태그로 베어메탈이 된 ESXi 호스트**로
 *   (`fleetInventory.js:170`) iDRAC 등록이 없다 — 그것을 '주소 없음' 이라 말해야 한다.
 */
import { licenseFromInventory } from './license.js';
import { addressMatcher, maskIdentityFields, maskedIdToken, maskedAddressName } from '../auth/addressMask.js';

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
});

/**
 * OS 계정 색인 — `bmstor` 등록부를 host·name 으로 찾을 수 있게 만든다(순수).
 * ⚠ 같은 host 가 여러 번 등록될 수 있으므로 **처음 것을 쓰고** 나머지는 세어 밝힌다.
 */
export function indexOsHosts(bmServers = []) {
  const byHost = new Map();
  const byName = new Map();
  let dup = 0;
  for (const s of bmServers) {
    const h = hostKey(s.host);
    const n = norm(s.name);
    if (h) { if (byHost.has(h)) dup += 1; else byHost.set(h, s); }
    if (n && !byName.has(n)) byName.set(n, s);
  }
  return { byHost, byName, duplicates: dup };
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
 * @returns {{targets:Array, skipped:Array, counts:object}}
 */
export function resolveTargets({ bareMetal = [], registry = [], bmServers = [], settings = {}, agentName = '', isEdge = false, inventoryOf = null, now = Date.now() } = {}) {
  const regById = new Map(registry.map((r) => [t(r.id), r]));
  const regByTag = new Map(registry.filter((r) => t(r.serviceTag)).map((r) => [norm(r.serviceTag), r]));
  const os = indexOsHosts(bmServers);
  const corps = settings.corps || {};
  const me = norm(agentName);

  const targets = [];
  const skipped = [];
  for (const b of bareMetal) {
    const vc = t(b.vcenterId);
    const owner = norm(b.remoteAgent);
    // 이 노드가 담당하는 서버인가 — 엣지는 자기 agent 것만, 중앙은 agent 없는 것만.
    const mine = isEdge ? (owner && owner === me) : !owner;
    if (!mine) { skipped.push({ ...idOf(b), reason: 'edge-delegated', agent: b.remoteAgent || '' }); continue; }
    if (!vc) {
      if (!settings.includeUnassigned) { skipped.push({ ...idOf(b), reason: 'unassigned' }); continue; }
    } else if (!corps[vc]) {
      skipped.push({ ...idOf(b), reason: 'corp-off', vcenterId: vc }); continue;
    }

    const reg = regById.get(t(b.serverId)) || (t(b.serviceTag) ? regByTag.get(norm(b.serviceTag)) : null) || null;
    const osEntry = os.byHost.get(hostKey(reg?.host)) || os.byName.get(norm(b.name)) || os.byHost.get(hostKey(b.name)) || null;

    const paths = [];
    let idracReason = '';
    if (settings.idracTelemetry) {
      if (!reg || !t(reg.host)) idracReason = 'no-idrac';
      else if (!t(reg.username) || !t(reg.password)) idracReason = 'no-idrac-cred';
      else paths.push('idrac');
    }
    if (settings.osSsh && osEntry) paths.push('os');

    if (!paths.length) {
      const reason = (!settings.idracTelemetry && !settings.osSsh) ? 'both-off'
        : (settings.osSsh && !osEntry && idracReason) ? idracReason
          : (idracReason || 'no-os-cred');
      skipped.push({ ...idOf(b), reason, vcenterId: vc, osMissing: !osEntry });
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
      paths,
      license,
      entAllowed: !!(paths.includes('idrac') && settings.enterpriseEnabled && settings.enterpriseAck),
      // ⚠ 비밀은 여기 담기지만 **응답에는 절대 싣지 않는다**(라우트가 publicTarget 으로 뺀다).
      // `regId`(v2.590): 주 iDRAC 폴러의 인증 실패 정지 기록을 같은 id 로 조회하기 위한 것(poller.js).
      idrac: paths.includes('idrac') ? { regId: t(reg.id), host: t(reg.host), username: t(reg.username), password: reg.password } : null,
      osHost: paths.includes('os') ? osEntry : null,
      // OS 계정은 있는데 iDRAC 이 없거나 반대인 경우 — 그 사실을 화면이 말해야 한다.
      missing: [idracReason, (settings.osSsh && !osEntry) ? 'no-os-cred' : ''].filter(Boolean),
    });
  }

  const counts = { targets: targets.length, skipped: skipped.length, idrac: 0, os: 0, both: 0 };
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
  /*
   * ⚠⚠ **키 충돌을 조용히 두지 않는다**(v2.550.3). DB 기본키가 `(agent, key, ts)` 라 두 서버가 같은
   *   `key` 를 쓰면 **한쪽이 다른쪽을 덮어쓴다** — 그 서버의 사용률이 다른 서버 값으로 보이고
   *   오류도 나지 않는다(v2.548 F2 가 겪은 것과 같은 유형: 서비스태그가 비어 fleetId·serverId 로
   *   떨어진 서버끼리, 또는 한쪽의 fleetId 가 다른쪽의 서비스태그와 같을 때 성립한다).
   *   여기서 **대상에서 빼지는 않는다** — 어느 쪽을 버릴지 판단할 근거가 없고, 빼면 멀쩡한 서버가
   *   조용히 사라진다. 개수와 목록을 올려 화면이 말하게 한다.
   */
  const seen = new Map();
  const keyConflicts = [];
  for (const x of targets) {
    const prev = seen.get(x.key) || null;
    if (prev) keyConflicts.push({ key: x.key, names: [prev.name, x.name].filter(Boolean), keyKind: x.keyKind, vcenterId: x.vcenterId || prev.vcenterId || '' });
    else seen.set(x.key, x);
  }
  counts.keyConflicts = keyConflicts.length;
  return { targets, skipped, counts, keyConflicts };
}

/** 안정 키 — 서비스태그 우선(v2.548 `deviceKey` 와 같은 등급 판단). */
function idOf(b) {
  const tag = t(b.serviceTag).toUpperCase();
  return {
    serverId: t(b.serverId),
    fleetId: t(b.fleetId),
    name: t(b.name),
    serviceTag: tag,
    key: tag || t(b.fleetId) || t(b.serverId),
    keyKind: tag ? 'serviceTag' : (t(b.fleetId) ? 'fleetId' : 'serverId'),
  };
}

/**
 * 비-admin 응답용 — 관리 주소를 가린다(v2.600 AUTHZ-2600-08). `publicTarget` 은 자격증명만 빼고
 * iDRAC 관리 주소(`idracHost`)와 OS SSH 주소(`osHostName` — adminOnly 인 베어메탈 스토리지 등록부의 값)를
 * 그대로 실어 `tools` 권한(operator 기본 보유)에 나갔다(v2.599 AUTHZ-2599-03 과 같은 계열).
 * ⚠ `null`(그 경로가 없다)과 `''`(있지만 가렸다)을 구분해 남긴다 — 화면이 경로 유무를 판정한다.
 * `publicTarget` 의 두 번째 인자로 두지 않은 이유: 호출부가 `.map(publicTarget)` 이라 인덱스가 들어온다.
 */
export function maskTargetAddress(pt, hosts = []) {
  if (!pt || typeof pt !== 'object') return pt;
  // v2.601 AUTHZ-2601-01: IP 로 등록한 iDRAC 은 serverId·fleetId·key·name 이 곧 그 IP 다 —
  //   host 칸만 비우면 식별자로 그대로 샜다. 자기 주소 + 등록부 주소 목록과 같거나 IP 인 값을 가린다.
  const match = addressMatcher([pt.idracHost, pt.osHostName, ...(hosts || [])].filter((h) => typeof h === 'string' && h));
  return {
    ...maskBmIdentity(pt, match),
    idracHost: pt.idracHost == null ? pt.idracHost : '',
    osHostName: pt.osHostName == null ? pt.osHostName : '',
  };
}

/** 베어메탈 행의 식별 필드(대상·제외·최신값·키 충돌·인증 정지·귀속 없음 표본 공용, v2.601). */
export const BM_ID_FIELDS = Object.freeze(['serverId', 'fleetId', 'key', 'tagKey', 'deviceId']);
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
  };
}
