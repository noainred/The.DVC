/**
 * IPAM ledger builder — turns a snapshot into a per-center IP record list.
 * Shared by the /tools/ipam API and the SQLite exporter so both stay in sync.
 */

export function ipToNum(s) {
  const p = String(s || '').split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) : null;
}

/** Build IP rows + summary from a snapshot, optionally scoped to one vCenter. */
export function buildIpamRows(snap, vcenterId) {
  let vms = snap.vms || [];
  let hosts = snap.hosts || [];
  if (vcenterId) {
    vms = vms.filter((v) => v.vcenterId === vcenterId);
    hosts = hosts.filter((h) => h.vcenterId === vcenterId);
  }
  const vcName = {};
  for (const vc of snap.vcenters || []) vcName[vc.id] = vc.name;

  const rows = [];
  const count = new Map();
  for (const vm of vms) {
    const ips = vm.ipAddresses?.length ? vm.ipAddresses : (vm.ipAddress ? [vm.ipAddress] : []);
    for (const ip of ips) {
      count.set(ip, (count.get(ip) || 0) + 1);
      rows.push({
        ip, ipNum: ipToNum(ip), vcenterId: vm.vcenterId, vcenterName: vcName[vm.vcenterId] || vm.vcenterId,
        ownerType: 'vm', ownerName: vm.name, powerState: vm.powerState, guestOS: vm.guestOS,
        hostName: vm.host || '', cluster: vm.cluster || '', multiHomed: ips.length > 1, owner: vm,
      });
    }
  }
  for (const h of hosts) {
    if (ipToNum(h.name) == null) continue; // host registered by FQDN → no mgmt IP
    count.set(h.name, (count.get(h.name) || 0) + 1);
    rows.push({
      ip: h.name, ipNum: ipToNum(h.name), vcenterId: h.vcenterId, vcenterName: vcName[h.vcenterId] || h.vcenterId,
      ownerType: 'host', ownerName: h.name, powerState: h.powerState, guestOS: `ESXi ${h.version || ''}`.trim(),
      hostName: h.name, cluster: h.cluster || '', multiHomed: false, owner: h,
    });
  }
  for (const r of rows) r.duplicate = count.get(r.ip) > 1;
  rows.sort((a, b) => (a.ipNum ?? Infinity) - (b.ipNum ?? Infinity));

  const byVc = {};
  for (const r of rows) byVc[r.vcenterId] = (byVc[r.vcenterId] || 0) + 1;
  return {
    total: rows.length,
    multiHomed: rows.filter((r) => r.multiHomed).length,
    duplicateIps: [...count.values()].filter((c) => c > 1).length,
    byVcenter: Object.entries(byVc).map(([id, c]) => ({ vcenterId: id, vcenterName: vcName[id] || id, count: c })).sort((a, b) => b.count - a.count),
    rows,
  };
}
