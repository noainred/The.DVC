import { ipToNum, numToIp } from '../util/ipv4.js';
/**
 * VM provisioning spec — expand a "create many similar VMs" request into a
 * concrete per-VM list. Supports a naming pattern with {n} (zero-paddable),
 * a matching guest hostname pattern, and auto-incrementing static IPs.
 */

// v2.586 — IPv4 파싱은 util/ipv4.js 하나. 호출부(svcmon/genspec.js) 호환을 위해 재수출한다.
export { ipToNum, numToIp };

const applyPattern = (pat, n, pad) => {
  const num = pad > 0 ? String(n).padStart(pad, '0') : String(n);
  return String(pat || '').replace(/\{n\}/g, num);
};

/**
 * Expand a bulk spec. Returns { vms, errors }.
 * spec = {
 *   namePattern, count, startIndex, pad,
 *   guest: { hostnamePattern, ipMode:'static'|'dhcp', ipStart, subnetMask, gateway, dnsServers[], domain },
 *   perVm: optional [{ name, hostname, ip }] (overrides pattern expansion)
 * }
 */
/*
 * 74회차 F1: 펼치기 전 입력 상한 — 상한이 없어 작은 본문 하나가 서버를 멈추거나 죽였다(실측):
 *   pad 1,000,000 × 500대 = 이름 10억 글자 · 15.7초 블로킹 / 이름 패턴 900KB × 500대 = 힙 4GB 초과로 프로세스 종료 /
 *   추가 NIC 20,000개 × 500대 = 1.3초 + 미리보기 응답 수백 MB. `/api/provision/preview` 는 화면이 입력할 때마다 부른다
 *   (자릿수 칸에 큰 수를 치는 실수만으로 포탈 전체가 멈춘다). 넘으면 펼치지 않고 사유를 돌려준다(잘라서 통과시키지 않는다).
 *   VM 하나의 가상 NIC 는 vSphere 구성 최대치가 10개라 추가 NIC 는 9개까지다.
 */
export const PAD_MAX = 32;
export const PATTERN_MAX = 255;
export const EXTRA_NICS_MAX = 9;
const START_MAX = 1e9;

/** 펼치기 전 상한 검사 — 사유 목록(비면 통과). */
function inputLimitErrors(spec, guest) {
  const errs = [];
  const pad = Number(spec.pad);
  if (Number.isFinite(pad) && Math.round(pad) > PAD_MAX) errs.push(`자릿수(pad)는 ${PAD_MAX} 이하여야 합니다 (요청: ${Math.round(pad)}).`);
  for (const [label, v] of [['이름 패턴', spec.namePattern], ['Hostname 패턴', guest.hostnamePattern]]) {
    if (v != null && String(v).length > PATTERN_MAX) errs.push(`${label}은 ${PATTERN_MAX}자 이하여야 합니다 (요청: ${String(v).length}자).`);
  }
  if (Array.isArray(guest.extraNics) && guest.extraNics.length > EXTRA_NICS_MAX) {
    errs.push(`추가 NIC 는 ${EXTRA_NICS_MAX}개까지입니다(VM 하나의 가상 NIC 최대 10개 — 요청: ${guest.extraNics.length}개).`);
  } else if (Array.isArray(guest.extraNics)) {
    // 객체가 아닌 원소(null 등)는 e.ipMode 에서 TypeError → 미리보기 500 이었다 — 사유로 돌려준다.
    const bad = guest.extraNics.findIndex((e) => !e || typeof e !== 'object' || Array.isArray(e));
    if (bad >= 0) errs.push(`추가 NIC ${bad + 1}번째 항목이 올바르지 않습니다.`);
  }
  return errs;
}

export function expandSpec(spec = {}) {
  const errors = [];
  const guest = spec.guest || {};
  const dhcp = guest.ipMode === 'dhcp';
  {
    const lim = inputLimitErrors(spec, guest);
    if (lim.length) return { vms: [], errors: lim };
  }

  // Explicit per-VM list wins.
  if (Array.isArray(spec.perVm) && spec.perVm.length) {
    // v2.767(점검 R2-B3-11): perVm 경로에도 패턴 경로와 같은 500대 상한 — 상한이 없어 본문 한도(1MB)만큼 한 번에 만들 수 있었고
    //   중복 검사(indexOf)가 O(n²)이라 큰 본문 하나가 이벤트 루프를 수 초 막았다(/api/provision/preview 도 같은 함수).
    //   상한은 원본 길이로 먼저 보고(잘라서 통과시키지 않는다) 넘으면 펼치지 않는다. 객체가 아닌 원소(null 등)는 500 대신 400 사유로.
    if (spec.perVm.length > 500) return { vms: [], errors: [`한 번에 최대 500대까지 생성할 수 있습니다 (요청: ${spec.perVm.length}대).`] };
    const bad = spec.perVm.findIndex((v) => !v || typeof v !== 'object' || Array.isArray(v));
    if (bad >= 0) return { vms: [], errors: [`VM 목록 ${bad + 1}번째 항목이 올바르지 않습니다.`] };
    const vms = spec.perVm.map((v, i) => ({
      name: String(v.name || '').trim() || `vm-${i + 1}`,
      hostname: String(v.hostname || v.name || '').trim(),
      ip: dhcp ? '' : String(v.ip || '').trim(),
    }));
    // 74회차 F1: 항목 이름도 패턴과 같은 길이 상한(본문 한도만큼의 이름 하나가 작업 · 저장 파일 · 응답에 그대로 실린다).
    const long = vms.findIndex((v) => v.name.length > PATTERN_MAX || v.hostname.length > PATTERN_MAX);
    if (long >= 0) return { vms: [], errors: [`VM 목록 ${long + 1}번째 항목의 이름 · Hostname 은 ${PATTERN_MAX}자 이하여야 합니다.`] };
    if (!dhcp) for (const v of vms) if (v.ip && ipToNum(v.ip) == null) errors.push(`잘못된 IP: ${v.ip} (${v.name})`);
    const seen = new Set(); const dup = new Set();
    for (const v of vms) { if (seen.has(v.name)) dup.add(v.name); else seen.add(v.name); }
    if (dup.size) errors.push(`중복된 VM 이름: ${[...dup].join(', ')}`);
    return { vms, errors };
  }

  // Explicit IP list (one per VM) — for assigning non-contiguous / scattered IPs.
  // Accepts an array or a newline/space/comma separated string.
  const ipListRaw = Array.isArray(guest.ipList) ? guest.ipList : String(guest.ipList || '').split(/[\s,]+/);
  const ipList = ipListRaw.map((s) => String(s).trim()).filter(Boolean);
  const useList = !dhcp && ipList.length > 0;

  // When an explicit IP list is given and no count is set, default the count to
  // the number of IPs so users can just paste a column of addresses.
  // 상한 검사는 클램프 '이전' 원본 값으로 — 클램프를 먼저 하면 600대 요청이 오류 없이 500대만
  // 생성되고(IP 부족 검증도 잘린 수 기준으로 통과) 사용자가 누락을 인지하지 못한다.
  const rawCount = Math.round(Number(spec.count) || 0);
  if (rawCount > 500) errors.push(`한 번에 최대 500대까지 생성할 수 있습니다 (요청: ${rawCount}대).`);
  let count = Math.max(0, Math.min(500, rawCount));
  if (useList && count < 1) count = Math.min(500, ipList.length);
  // 74회차 F3: 시작 번호 0 을 1 로 바꾸지 않는다(예전 `Number(x) || 1` — 0 을 넣어도 1 부터 만들었다). 비었거나 숫자가 아니면 기본 1,
  //   음수 · 너무 큰 값은 사유를 돌려준다(음수는 'web-0-3' 같은 이름이 됐다).
  const startRaw = spec.startIndex == null || spec.startIndex === '' ? NaN : Number(spec.startIndex);
  const start = Number.isFinite(startRaw) ? Math.round(startRaw) : 1;
  if (start < 0 || start > START_MAX) errors.push(`시작 번호는 0 이상 ${START_MAX} 이하여야 합니다 (요청: ${start}).`);
  const pad = Math.max(0, Math.round(Number(spec.pad) || 0));
  if (!spec.namePattern) errors.push('이름 패턴이 필요합니다 (예: web-{n}).');
  if (count < 1) errors.push('생성 개수는 1 이상이어야 합니다.');

  if (useList) {
    for (const ip of ipList) if (ipToNum(ip) == null) errors.push(`잘못된 IP: ${ip}`);
    if (ipList.length < count) errors.push(`IP가 부족합니다 — VM ${count}대에 IP ${ipList.length}개. (한 줄에 하나씩 입력)`);
  }

  // 74회차 F2: 연속 IP 가 255.255.255.255 를 넘으면 0.0.0.0 으로 돌아갔다(numToIp 는 2^32 로 나머지) — 오류 없이 엉뚱한 IP 를 넣었다.
  const IP_LAST = 0xFFFFFFFF;
  const overflow = (base) => base != null && count > 0 && base + count - 1 > IP_LAST;
  let ipBase = null;
  if (!dhcp && !useList && guest.ipStart) {
    ipBase = ipToNum(guest.ipStart);
    if (ipBase == null) errors.push(`잘못된 시작 IP: ${guest.ipStart}`);
    else if (overflow(ipBase)) errors.push(`시작 IP ${guest.ipStart} 에서 ${count}대를 연속 배정하면 255.255.255.255 를 넘습니다.`);
  }

  // Additional NICs (NIC2, NIC3 …) applied IN ORDER (vSphere maps nicSettingMap
  // to the VM's virtual NICs positionally; optional MAC binds a specific NIC).
  const extraNics = (Array.isArray(guest.extraNics) ? guest.extraNics : []).map((e, idx) => {
    const edhcp = e.ipMode === 'dhcp';
    let base = null;
    if (!edhcp && e.ipStart) {
      base = ipToNum(e.ipStart);
      if (base == null) errors.push(`NIC${idx + 2} 잘못된 시작 IP: ${e.ipStart}`);
      else if (overflow(base)) errors.push(`NIC${idx + 2} 시작 IP ${e.ipStart} 에서 ${count}대를 연속 배정하면 255.255.255.255 를 넘습니다.`);
    }
    return { edhcp, base, subnetMask: e.subnetMask || '', gateway: e.gateway || '', mac: String(e.mac || '').trim() };
  });

  const vms = [];
  for (let i = 0; i < count; i++) {
    const n = start + i;
    const name = applyPattern(spec.namePattern, n, pad);
    const hostname = guest.hostnamePattern ? applyPattern(guest.hostnamePattern, n, pad) : name;
    const ip = dhcp ? '' : (useList ? (ipList[i] || '') : (ipBase != null ? numToIp(ipBase + i) : ''));
    const nics = [{ dhcp, ip, subnetMask: guest.subnetMask || '', gateway: guest.gateway || '', mac: '' }];
    for (const e of extraNics) {
      nics.push({
        dhcp: e.edhcp,
        ip: e.edhcp ? '' : (e.base != null ? numToIp(e.base + i) : ''),
        subnetMask: e.subnetMask, gateway: e.gateway, mac: e.mac,
      });
    }
    vms.push({ name, hostname, ip, nics });
  }
  const names = vms.map((v) => v.name);
  if (new Set(names).size !== names.length) errors.push('이름 패턴이 중복을 만듭니다. {n} 을(를) 포함했는지 확인하세요.');
  return { vms, errors };
}
