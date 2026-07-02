/**
 * VM provisioning spec — expand a "create many similar VMs" request into a
 * concrete per-VM list. Supports a naming pattern with {n} (zero-paddable),
 * a matching guest hostname pattern, and auto-incrementing static IPs.
 */

export function ipToNum(s) {
  const p = String(s || '').trim().split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) : null;
}
export function numToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

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
export function expandSpec(spec = {}) {
  const errors = [];
  const guest = spec.guest || {};
  const dhcp = guest.ipMode === 'dhcp';

  // Explicit per-VM list wins.
  if (Array.isArray(spec.perVm) && spec.perVm.length) {
    const vms = spec.perVm.map((v, i) => ({
      name: String(v.name || '').trim() || `vm-${i + 1}`,
      hostname: String(v.hostname || v.name || '').trim(),
      ip: dhcp ? '' : String(v.ip || '').trim(),
    }));
    if (!dhcp) for (const v of vms) if (v.ip && ipToNum(v.ip) == null) errors.push(`잘못된 IP: ${v.ip} (${v.name})`);
    const dup = vms.map((v) => v.name).filter((n, i, a) => a.indexOf(n) !== i);
    if (dup.length) errors.push(`중복된 VM 이름: ${[...new Set(dup)].join(', ')}`);
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
  const start = Math.round(Number(spec.startIndex) || 1);
  const pad = Math.max(0, Math.round(Number(spec.pad) || 0));
  if (!spec.namePattern) errors.push('이름 패턴이 필요합니다 (예: web-{n}).');
  if (count < 1) errors.push('생성 개수는 1 이상이어야 합니다.');

  if (useList) {
    for (const ip of ipList) if (ipToNum(ip) == null) errors.push(`잘못된 IP: ${ip}`);
    if (ipList.length < count) errors.push(`IP가 부족합니다 — VM ${count}대에 IP ${ipList.length}개. (한 줄에 하나씩 입력)`);
  }

  let ipBase = null;
  if (!dhcp && !useList && guest.ipStart) {
    ipBase = ipToNum(guest.ipStart);
    if (ipBase == null) errors.push(`잘못된 시작 IP: ${guest.ipStart}`);
  }

  // Additional NICs (NIC2, NIC3 …) applied IN ORDER (vSphere maps nicSettingMap
  // to the VM's virtual NICs positionally; optional MAC binds a specific NIC).
  const extraNics = (Array.isArray(guest.extraNics) ? guest.extraNics : []).map((e, idx) => {
    const edhcp = e.ipMode === 'dhcp';
    let base = null;
    if (!edhcp && e.ipStart) { base = ipToNum(e.ipStart); if (base == null) errors.push(`NIC${idx + 2} 잘못된 시작 IP: ${e.ipStart}`); }
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
