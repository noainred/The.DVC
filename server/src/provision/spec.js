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

  const count = Math.max(0, Math.min(500, Math.round(Number(spec.count) || 0)));
  const start = Math.round(Number(spec.startIndex) || 1);
  const pad = Math.max(0, Math.round(Number(spec.pad) || 0));
  if (!spec.namePattern) errors.push('이름 패턴이 필요합니다 (예: web-{n}).');
  if (count < 1) errors.push('생성 개수는 1 이상이어야 합니다.');
  if (count > 500) errors.push('한 번에 최대 500대까지 생성할 수 있습니다.');

  let ipBase = null;
  if (!dhcp && guest.ipStart) {
    ipBase = ipToNum(guest.ipStart);
    if (ipBase == null) errors.push(`잘못된 시작 IP: ${guest.ipStart}`);
  }

  const vms = [];
  for (let i = 0; i < count; i++) {
    const n = start + i;
    const name = applyPattern(spec.namePattern, n, pad);
    const hostname = guest.hostnamePattern ? applyPattern(guest.hostnamePattern, n, pad) : name;
    const ip = dhcp ? '' : (ipBase != null ? numToIp(ipBase + i) : '');
    vms.push({ name, hostname, ip });
  }
  const names = vms.map((v) => v.name);
  if (new Set(names).size !== names.length) errors.push('이름 패턴이 중복을 만듭니다. {n} 을(를) 포함했는지 확인하세요.');
  return { vms, errors };
}
