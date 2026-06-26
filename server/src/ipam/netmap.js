/**
 * 네트워크 맵 — 선택한 대역(/24)을 격자로 펼쳐, 각 IP를 'OS 종류'(색)로 칠하고
 * '시간대별 사용/미사용'(up/down 시계열)을 보여준다. 데이터 원천:
 *  - OS/소유자: buildIpamRows(snap) (vCenter guestOS · ESXi · 스캔 서비스)
 *  - 사용 시계열: scanStore history[ip].events[] (up/down 전이, 최대 200/IP·1년)
 * 새 수집 없이 O(254) 계산(논블로킹).
 */

import { buildIpamRows } from './ledger.js';
import { getIpHistory } from './scanStore.js';
import { rangesForVcenter } from './rangeStore.js';
import { expandRange } from './scan.js';

const DAY = 86_400_000;

// OS 카테고리 → 격자 색(범례). 추정(스캔 서비스 기반)은 점선 표시용으로 guessed 플래그.
export const OS_COLORS = {
  Windows: '#2563eb', Linux: '#16a34a', ESXi: '#7c3aed', Hypervisor: '#9333ea',
  'BMC/장비': '#0891b2', Network: '#0d9488', Other: '#d97706', Unknown: '#64748b',
};

/** OS 카테고리 판정. osName(있으면 우선) → 서비스/포트 추정. */
export function osCategory(osName, services = []) {
  const o = String(osName || '').toLowerCase();
  if (o) {
    if (/(windows|win\d|microsoft)/.test(o)) return { key: 'Windows', guessed: false };
    if (/(esxi|vmware esx)/.test(o)) return { key: 'ESXi', guessed: false };
    if (/(linux|centos|ubuntu|red\s?hat|rhel|debian|rocky|suse|oracle|alma|fedora|photon|coreos)/.test(o)) return { key: 'Linux', guessed: false };
    return { key: 'Other', guessed: false };
  }
  const svc = (services || []).map((s) => String(s).toLowerCase());
  if (svc.some((s) => ['rdp', 'smb', 'winrm', 'winrm-s'].includes(s))) return { key: 'Windows', guessed: true };
  if (svc.includes('ssh')) return { key: 'Linux', guessed: true };
  if (svc.some((s) => ['esxi', 'proxmox'].includes(s))) return { key: 'Hypervisor', guessed: true };
  if (svc.some((s) => ['ipmi/bmc', 'snmp'].includes(s))) return { key: 'BMC/장비', guessed: true };
  if (svc.length) return { key: 'Other', guessed: true };
  return { key: 'Unknown', guessed: false };
}

// 시각 t에서 IP의 상태: 1=사용(up), 0=미사용(down/유휴), -1=관측이력 없음(미발견)
function stateAt(hist, t) {
  if (!hist) return -1;
  const first = hist.firstSeen || 0;
  if (first && t < first) return -1;                 // 아직 처음 관측되기 전
  const evs = (hist.events || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
  if (evs.length) {
    let st = null;
    for (const e of evs) { if ((e.ts || 0) <= t) st = e.type; else break; }
    if (st == null) return first && t >= first ? 1 : -1; // 첫 이벤트 이전이지만 firstSeen 이후 = up
    return st === 'up' ? 1 : 0;
  }
  // 이벤트가 없으면 firstSeen..lastSeen 을 사용 구간으로 근사.
  if (first && t >= first) return (hist.lastSeen && t > hist.lastSeen + DAY) ? 0 : 1;
  return -1;
}

/** vCenter(또는 전체) 대역에서 사용할 수 있는 /24 base 목록. */
export function netmapBases(snap, vcenterId = '') {
  const bases = new Set();
  // 1) vCenter 등록 대역에서
  const specs = vcenterId ? rangesForVcenter(vcenterId) : [];
  for (const spec of specs) {
    for (const ip of expandRange(spec)) { const p = ip.split('.'); bases.add(`${p[0]}.${p[1]}.${p[2]}`); }
  }
  // 2) 대장 rows(해당 vCenter 스코프)에서도 보강
  const { rows } = buildIpamRows(snap, vcenterId || undefined);
  for (const r of rows) {
    if (r.ipNum == null) continue;
    const p = String(r.ip).split('.'); if (p.length === 4) bases.add(`${p[0]}.${p[1]}.${p[2]}`);
  }
  const num = (b) => { const p = b.split('.').map(Number); return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8); };
  return [...bases].sort((a, b) => num(a) - num(b));
}

/**
 * 한 /24 base의 격자 데이터를 만든다. days/buckets로 시간축 분해.
 * 반환: { base, cidr, days, bucketMs, buckets:[ts], cells:[{...,states:[...]}], osLegend, summary }
 */
export function buildNetmap(snap, { vcenterId = '', base = '', days = 30, buckets = 24 } = {}) {
  const now = snap?.generatedAt || Date.now();
  const bases = netmapBases(snap, vcenterId);
  const b = base && /^\d+\.\d+\.\d+$/.test(base) ? base : bases[0] || '';
  const D = Math.max(1, Math.min(365, Number(days) || 30));
  const N = Math.max(6, Math.min(96, Number(buckets) || 24));
  const span = D * DAY;
  const bucketMs = span / N;
  const start = now - span;
  const bucketTs = Array.from({ length: N }, (_, i) => Math.round(start + (i + 0.5) * bucketMs)); // 버킷 중앙시각

  if (!b) return { base: '', cidr: '', days: D, buckets: bucketTs, bucketMs, bases, cells: [], osLegend: [], summary: { total: 0 } };

  // OS/소유자 맵(대장) — 해당 vCenter 스코프 우선, 비면 전체.
  const ledger = buildIpamRows(snap, vcenterId || undefined).rows;
  const byIp = new Map();
  for (const r of ledger) if (!byIp.has(r.ip)) byIp.set(r.ip, r);

  const legendCount = {};
  const cells = [];
  let everUsed = 0, currentlyUp = 0, neverSeen = 0;
  for (let i = 1; i <= 254; i++) {
    const ip = `${b}.${i}`;
    const row = byIp.get(ip);
    const hist = getIpHistory(ip);
    const services = row?.services || hist?.events?.[hist.events.length - 1]?.ports?.map(String) || [];
    const osName = row ? [row.osName, row.osVersion].filter(Boolean).join(' ') : '';
    const cat = osCategory(osName, row?.services || []);
    const states = bucketTs.map((t) => stateAt(hist, t));
    const ever = (hist && hist.firstSeen) || row?.firstSeen ? true : states.some((s) => s >= 0);
    const up = hist ? hist.status === 'up' : (row?.powerState === 'POWERED_ON');
    if (hist || row) {
      if (ever) everUsed++;
      if (up) currentlyUp++;
      legendCount[cat.key] = (legendCount[cat.key] || 0) + 1;
    } else { neverSeen++; }
    cells.push({
      ip, host: row?.ownerName || hist?.events?.find((e) => e.hostname)?.hostname || '',
      os: osName || (services.length ? services.join(', ') : ''),
      osKey: cat.key, guessed: cat.guessed, color: OS_COLORS[cat.key] || OS_COLORS.Unknown,
      vcenterName: row?.vcenterName || '', services,
      firstSeen: hist?.firstSeen || row?.firstSeen || null,
      lastSeen: hist?.lastSeen || row?.lastSeen || null,
      status: hist?.status || (row ? (up ? 'up' : 'down') : null),
      present: !!(hist || row),
      states,
    });
  }
  const osLegend = Object.entries(legendCount).sort((a, b2) => b2[1] - a[1])
    .map(([key, count]) => ({ key, count, color: OS_COLORS[key] || OS_COLORS.Unknown }));
  const present = cells.filter((c) => c.present).length;
  return {
    base: b, cidr: `${b}.0/24`, vcenterId, days: D, buckets: bucketTs, bucketMs, bases,
    cells, osLegend,
    summary: { total: 254, present, everUsed, currentlyUp, neverSeen },
    generatedAt: now,
  };
}
