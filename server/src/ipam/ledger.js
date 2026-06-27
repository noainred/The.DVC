/**
 * IPAM ledger builder — turns a snapshot into a per-center IP record list.
 * Shared by the /tools/ipam API and the SQLite exporter so both stay in sync.
 */

import { getIgnoreMatcher, getClassifier, settingsRev } from './settings.js';
import { getAnnotations, annotationsRev } from './annotations.js';
import { scanResultList, getIpHistoryMap, scanRev } from './scanStore.js';
import { getOverrides, overridesRev } from './overrides.js';

// buildIpamRows 결과 메모이즈 — 같은 스냅샷·스코프·설정/주석/스캔/override 리비전이면 재계산하지 않는다.
// (API·서브넷대장·xlsx·CSV·syncLedger가 같은 입력으로 여러 번 호출 → 중복 계산 제거)
const _ipamCache = new Map(); // key -> rows결과
const _ipamKey = (snap, vcenterId) => `${snap?.generatedAt || ''}|${vcenterId || ''}|s${settingsRev()}|a${annotationsRev()}|n${scanRev()}|o${overridesRev()}`;

// 자동 발견 출처(discovery)를 사용자 친화 reconcile 상태로 매핑.
// vcenter=vCenter만 인식 · scan=스캔만 발견(수동) · both=양쪽 · manual=운영자 등록(자동발견 없음)
const reconcileOf = (discovery) => (discovery === 'both' ? 'both' : discovery === 'scan' ? 'scan' : discovery === 'vcenter' ? 'vcenter' : 'manual');

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
  const _ck = _ipamKey(snap, vcenterId);
  const _hit = _ipamCache.get(_ck);
  if (_hit) return _hit;
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
  // 확인 출처(discovery): 'vcenter'(vCenter 인식) · 'scan'(Ping/TCP 스캔) · 'both'(둘 다).
  // vCenter가 아는 IP가 스캔에도 잡히면 'both'로 표시. (스캔 결과는 1회만 조회해 재사용)
  const scanList = scanResultList();
  const scanIpSet = new Set(scanList.map((s) => s.ip));
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
        discovery: scanIpSet.has(ip) ? 'both' : 'vcenter',
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
      discovery: scanIpSet.has(h.name) ? 'both' : 'vcenter',
    });
  }
  // 능동 스캔으로 발견된 IP(물리/기타 서버 등) 병합 — vCenter가 모르는 IP만 추가.
  // 스캔 결과는 특정 vCenter에 속하지 않으므로 vCenter 스코프와 무관하게 '항상' 표시한다.
  // '이미 vCenter가 아는 IP' 판정은 스코프된 rows가 아니라 '전체' vCenter IP 기준으로 한다
  // (스코프를 걸면 다른 vCenter의 IP가 known에서 빠져 스캔으로 오인되는 문제 방지).
  const histMap = getIpHistoryMap();
  {
    const known = new Set();
    for (const vm of (snap.vms || [])) {
      const ips = vm.ipAddresses?.length ? vm.ipAddresses : (vm.ipAddress ? [vm.ipAddress] : []);
      for (const ip of ips) known.add(ip);
    }
    for (const h of (snap.hosts || [])) if (ipToNum(h.name) != null) known.add(h.name);
    const seen = new Set(rows.map((r) => r.ip));
    for (const sc of scanList) {
      if (ignored(sc.ip, '') || known.has(sc.ip) || seen.has(sc.ip) || ipToNum(sc.ip) == null) continue;
      seen.add(sc.ip);
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
        source: 'scan', discovery: 'scan', owner: null,
      });
    }
  }
  // VM/호스트 IP에도 스캔 이력이 있으면 사용 추이를 붙인다(있을 때만).
  for (const r of rows) {
    const h = histMap[r.ip];
    if (h && r.firstSeen == null) { r.firstSeen = h.firstSeen; r.lastSeen = r.lastSeen || h.lastSeen; r.usageStatus = h.status; }
  }

  // ---- 수동 관리(override) 병합 ----------------------------------------------
  // 운영자가 IP 단위로 부여한 관리 상태(담당자/라벨/디바이스종류/예약 등)를 행에 입힌다.
  // override만 있고 vCenter/스캔 어디에도 없는 IP는 'manual' 행으로 추가해(예약/계획 IP) 함께 관리.
  const overrides = getOverrides();
  const seenAll = new Set(rows.map((r) => r.ip));
  for (const [ip, ov] of Object.entries(overrides)) {
    if (seenAll.has(ip) || ipToNum(ip) == null) continue;
    if (vcenterId && ov.claimedVcenterId && ov.claimedVcenterId !== vcenterId) continue; // 특정 vCenter에 귀속 예약이면 스코프 존중
    count.set(ip, (count.get(ip) || 0) + 1);
    rows.push({
      ip, ipNum: ipToNum(ip), vcenterId: ov.claimedVcenterId || '', vcenterName: vcName[ov.claimedVcenterId] || '(수동 등록)',
      ownerType: 'manual', serverType: 'Manual', ownerName: ov.label || ov.hostnameOverride || ip,
      powerState: '', guestOS: '', osName: '', osVersion: '',
      hostName: ov.hostnameOverride || '', cluster: '', multiHomed: false, scope: classify(ip),
      discovery: 'manual', owner: null,
    });
  }
  // 모든 행에 override 필드를 입히고 reconcile 상태를 계산. status:'ignored'면 숨김.
  const applied = [];
  for (const r of rows) {
    const ov = overrides[r.ip];
    if (ov) {
      if (ov.status === 'ignored') continue; // 운영자가 명시적으로 숨긴 IP
      r.mgmtStatus = ov.status || '';
      r.owner_ = ov.owner || '';
      r.label = ov.label || '';
      r.deviceType = ov.deviceType || '';
      r.note = ov.note || '';
      r.reservedUntil = ov.reservedUntil || null;
      r.managed = true;
      if (ov.hostnameOverride) r.hostName = ov.hostnameOverride;
      if (ov.label) r.displayName = ov.label;
    }
    if (!r.displayName) r.displayName = r.hostName || r.ownerName || r.ip;
    r.reconcile = reconcileOf(r.discovery);
    applied.push(r);
  }
  rows.length = 0;
  rows.push(...applied);

  for (const r of rows) r.duplicate = count.get(r.ip) > 1;
  rows.sort((a, b) => (a.ipNum ?? Infinity) - (b.ipNum ?? Infinity));

  const byVc = {};
  for (const r of rows) byVc[r.vcenterId] = (byVc[r.vcenterId] || 0) + 1;
  const out = {
    total: rows.length,
    multiHomed: rows.filter((r) => r.multiHomed).length,
    duplicateIps: [...count.values()].filter((c) => c > 1).length,
    publicIps: rows.filter((r) => r.scope === 'public').length,
    privateIps: rows.filter((r) => r.scope === 'private').length,
    byVcenter: Object.entries(byVc).map(([id, c]) => ({ vcenterId: id, vcenterName: vcName[id] || (id || '네트워크 스캔'), scanned: !id, count: c })).sort((a, b) => b.count - a.count),
    rows,
  };
  // 최근 키만 소량 보관(스냅샷이 바뀌면 키가 달라져 자연 만료). 메모리 상한.
  _ipamCache.set(_ck, out);
  if (_ipamCache.size > 8) _ipamCache.delete(_ipamCache.keys().next().value);
  return out;
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
      let owner = null, ownerType = '', vcenterId = '', discovery = ''; // 상세/원격접속/확인출처
      if (i === 0) { status = 'network'; purpose = 'Network ID'; }
      else if (recs.length) {
        used++;
        const r = recs[0]; const o = r.owner || {};
        owner = r.owner || null; ownerType = r.ownerType || ''; vcenterId = r.vcenterId || '';
        // 한 IP가 vCenter+스캔 양쪽 rec를 가지면 'both'
        discovery = recs.some((x) => x.discovery === 'both') ? 'both'
          : (recs.some((x) => x.discovery === 'vcenter') && recs.some((x) => x.discovery === 'scan')) ? 'both'
            : (r.discovery || '');
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
        // 전원: 행의 powerState 기준(스캔 IP는 owner가 없지만 ping/TCP 응답=살아있음=On).
        power = r.powerState === 'POWERED_ON' ? 'On' : (r.powerState ? 'Off' : '');
        scope = r.scope === 'public' ? '공인' : '사설';
      }
      const ann = annotations[ip];
      sheetRows.push({ ip, last: i, purpose, hostname, serverType, os, notes, power, status, scope, firstSeen, lastSeen, usageStatus, discovery, owner, ownerType, vcenterId, memo: ann?.memo || '', tags: ann?.tags || [] });
    }
    return { subnet: `${base}.0/24`, base, used, rows: sheetRows };
  });
  return sheets;
}

export function listSubnets(snap, vcenterId) {
  return buildSubnetSheets(snap, { vcenterId }).map((s) => ({ subnet: s.subnet, base: s.base, used: s.used }));
}
