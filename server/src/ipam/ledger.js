/**
 * IPAM ledger builder — turns a snapshot into a per-center IP record list.
 * Shared by the /tools/ipam API and the SQLite exporter so both stay in sync.
 */

import { getIgnoreMatcher, getClassifier } from './settings.js';
import { getAnnotations } from './annotations.js';
import { scanResultList, getIpHistoryMap } from './scanStore.js';

export function ipToNum(s) {
  const p = String(s || '').split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) : null;
}

/** "CentOS 7 (64-bit)" → { osName:'CentOS', osVersion:'7' } 식으로 분리. */
export function parseOs(guestOS) {
  const s = String(guestOS || '').replace(/\s*\(\d+-bit\)\s*$/i, '').trim();
  if (!s) return { osName: '', osVersion: '' };
  const m = s.match(/^(.*?)[\s-]*((?:\d+\.)+\d+|\d{4}|\d+(?:\s*R\d)?)\s*$/);
  if (m && m[2]) return { osName: (m[1] || '').trim() || s, osVersion: m[2].trim() };
  return { osName: s, osVersion: '' };
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

  const ignored = getIgnoreMatcher();
  const classify = getClassifier();
  const rows = [];
  const count = new Map();
  for (const vm of vms) {
    const ips = vm.ipAddresses?.length ? vm.ipAddresses : (vm.ipAddress ? [vm.ipAddress] : []);
    for (const ip of ips) {
      if (ignored(ip, vm.vcenterId)) continue;
      count.set(ip, (count.get(ip) || 0) + 1);
      rows.push({
        ip, ipNum: ipToNum(ip), vcenterId: vm.vcenterId, vcenterName: vcName[vm.vcenterId] || vm.vcenterId,
        ownerType: 'vm', serverType: 'VM', ownerName: vm.name, powerState: vm.powerState, guestOS: vm.guestOS,
        ...parseOs(vm.guestOS),
        hostName: vm.host || '', cluster: vm.cluster || '', multiHomed: ips.length > 1, scope: classify(ip), owner: vm,
      });
    }
  }
  for (const h of hosts) {
    if (ipToNum(h.name) == null) continue; // host registered by FQDN → no mgmt IP
    if (ignored(h.name, h.vcenterId)) continue;
    count.set(h.name, (count.get(h.name) || 0) + 1);
    rows.push({
      ip: h.name, ipNum: ipToNum(h.name), vcenterId: h.vcenterId, vcenterName: vcName[h.vcenterId] || h.vcenterId,
      ownerType: 'host', serverType: 'BareMetal', ownerName: h.name, powerState: h.powerState, guestOS: `ESXi ${h.version || ''}`.trim(),
      osName: 'ESXi', osVersion: h.version || '',
      hostName: h.name, cluster: h.cluster || '', multiHomed: false, scope: classify(h.name), owner: h,
    });
  }
  // 능동 스캔으로 발견된 IP(물리/기타 서버 등) 병합 — vCenter가 모르는 IP만 추가.
  // 스캔 결과는 특정 vCenter에 속하지 않으므로 vCenter 스코프와 무관하게 표시한다.
  const histMap = getIpHistoryMap();
  if (!vcenterId) {
    const known = new Set(rows.map((r) => r.ip));
    for (const sc of scanResultList()) {
      if (ignored(sc.ip, '') || known.has(sc.ip) || ipToNum(sc.ip) == null) continue;
      known.add(sc.ip);
      const hist = histMap[sc.ip];
      const released = hist?.status === 'down';
      count.set(sc.ip, (count.get(sc.ip) || 0) + 1);
      rows.push({
        ip: sc.ip, ipNum: ipToNum(sc.ip), vcenterId: '', vcenterName: '(네트워크 스캔)',
        ownerType: 'scanned', serverType: 'Scanned', ownerName: sc.hostname || sc.ip,
        powerState: released ? 'POWERED_OFF' : 'POWERED_ON', guestOS: '', osName: '', osVersion: '',
        hostName: sc.hostname || '', cluster: '', multiHomed: false, scope: classify(sc.ip),
        openPorts: sc.openPorts || [], services: sc.services || [], lastSeen: sc.lastSeen || null,
        firstSeen: hist?.firstSeen || null, usageStatus: hist?.status || null, released,
        source: 'scan', owner: null,
      });
    }
  }
  // VM/호스트 IP에도 스캔 이력이 있으면 사용 추이를 붙인다(있을 때만).
  for (const r of rows) {
    const h = histMap[r.ip];
    if (h && r.firstSeen == null) { r.firstSeen = h.firstSeen; r.lastSeen = r.lastSeen || h.lastSeen; r.usageStatus = h.status; }
  }
  for (const r of rows) r.duplicate = count.get(r.ip) > 1;
  rows.sort((a, b) => (a.ipNum ?? Infinity) - (b.ipNum ?? Infinity));

  const byVc = {};
  for (const r of rows) byVc[r.vcenterId] = (byVc[r.vcenterId] || 0) + 1;
  return {
    total: rows.length,
    multiHomed: rows.filter((r) => r.multiHomed).length,
    duplicateIps: [...count.values()].filter((c) => c > 1).length,
    publicIps: rows.filter((r) => r.scope === 'public').length,
    privateIps: rows.filter((r) => r.scope === 'private').length,
    byVcenter: Object.entries(byVc).map(([id, c]) => ({ vcenterId: id, vcenterName: vcName[id] || id, count: c })).sort((a, b) => b.count - a.count),
    rows,
  };
}

/**
 * Build the per-/24-subnet ledger (Excel-style): each subnet is a sheet with all
 * .0–.255 rows; collected IPs are filled with Purpose(VM/호스트 · 법인 / 클러스터)
 * + Hostname + Notes + power + status. `onlyBase` returns a single subnet.
 */
export function buildSubnetSheets(snap, { vcenterId, onlyBase } = {}) {
  const { rows } = buildIpamRows(snap, vcenterId);
  const byIp = new Map();
  const bases = new Set();
  for (const r of rows) {
    if (r.ipNum == null) continue;
    const p = r.ip.split('.');
    const base = `${p[0]}.${p[1]}.${p[2]}`;
    bases.add(base);
    if (!byIp.has(r.ip)) byIp.set(r.ip, []);
    byIp.get(r.ip).push(r);
  }
  const baseNum = (b) => { const p = b.split('.').map(Number); return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8); };
  const sortedBases = [...bases].sort((a, b) => baseNum(a) - baseNum(b)).filter((b) => !onlyBase || b === onlyBase);

  const annotations = getAnnotations();
  const sheets = sortedBases.map((base) => {
    const sheetRows = [];
    let used = 0;
    for (let i = 0; i < 256; i++) {
      const ip = `${base}.${i}`;
      const recs = byIp.get(ip) || [];
      let status = 'empty', purpose = '', hostname = '', notes = '', power = '', scope = '', serverType = '', os = '';
      let firstSeen = null, lastSeen = null, usageStatus = null;
      if (i === 0) { status = 'network'; purpose = 'Network ID'; }
      else if (recs.length) {
        used++;
        const r = recs[0]; const o = r.owner || {};
        firstSeen = r.firstSeen || null; lastSeen = r.lastSeen || null; usageStatus = r.usageStatus || null;
        // vCenter가 모르고 능동 스캔으로만 확인된 IP는 'scanned'(스캔 확인)로 구분 표시.
        status = r.released ? 'released'
          : r.serverType === 'Scanned' ? 'scanned'
            : (recs.length > 1 ? 'duplicate' : (r.multiHomed ? 'multihomed' : 'used'));
        hostname = [...new Set(recs.map((x) => x.ownerName))].join(' / ');
        serverType = r.serverType === 'BareMetal' ? '베어메탈' : (r.serverType === 'Scanned' ? '스캔' : 'VM');
        os = r.serverType === 'Scanned' ? (r.services || []).join(', ') : [r.osName, r.osVersion].filter(Boolean).join(' ');
        purpose = r.serverType === 'Scanned'
          ? `네트워크 스캔 · 포트 ${(r.openPorts || []).join(',')}`
          : `${serverType} · ${r.vcenterName}${o.cluster ? ` / ${o.cluster}` : ''}`;
        notes = (o.notes || '').split(/\r?\n/)[0] || '';
        power = o.powerState === 'POWERED_ON' ? 'On' : (o.powerState ? 'Off' : '');
        scope = r.scope === 'public' ? '공인' : '사설';
      }
      const ann = annotations[ip];
      sheetRows.push({ ip, last: i, purpose, hostname, serverType, os, notes, power, status, scope, firstSeen, lastSeen, usageStatus, memo: ann?.memo || '', tags: ann?.tags || [] });
    }
    return { subnet: `${base}.0/24`, base, used, rows: sheetRows };
  });
  return sheets;
}

export function listSubnets(snap, vcenterId) {
  return buildSubnetSheets(snap, { vcenterId }).map((s) => ({ subnet: s.subnet, base: s.base, used: s.used }));
}
