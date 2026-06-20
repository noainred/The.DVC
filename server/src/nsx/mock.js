/**
 * Mock NSX snapshot generator — lets the NSX dashboard run out of the box
 * (DATA_SOURCE=mock) without a real NSX Manager. Generates plausible inventory
 * per registered manager; if none are registered, a small demo set is used so
 * the screen is never empty in a demo.
 */

const DEMO = [
  { id: 'nsx-seoul', name: 'nsx-mgr-seoul', host: 'https://nsx-seoul.corp.local', location: { region: '아시아' }, vcenterId: 'vc-seoul' },
  { id: 'nsx-frankfurt', name: 'nsx-mgr-frankfurt', host: 'https://nsx-fra.corp.local', location: { region: '유럽' }, vcenterId: 'vc-frankfurt' },
  { id: 'nsx-ashburn', name: 'nsx-mgr-ashburn', host: 'https://nsx-iad.corp.local', location: { region: '북미' }, vcenterId: 'vc-ashburn' },
];

// Deterministic small PRNG so the demo numbers are stable across refreshes.
function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function generateNsxForManager(mgr) {
  const rnd = seeded(mgr.id);
  const n = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const degraded = rnd() < 0.12;
  const t0Count = n(1, 2), t1Count = n(3, 8), segCount = n(8, 24);
  const hostNodes = n(6, 24), edgeNodes = n(2, 4);

  const gateways = [];
  for (let i = 0; i < t0Count; i++) gateways.push({ id: `${mgr.id}:t0-${i}`, managerId: mgr.id, name: `T0-Gateway-${i + 1}`, tier: 'T0', haMode: 'ACTIVE_STANDBY', failoverMode: 'NON_PREEMPTIVE' });
  for (let i = 0; i < t1Count; i++) gateways.push({ id: `${mgr.id}:t1-${i}`, managerId: mgr.id, name: `T1-${['Web', 'App', 'DB', 'DMZ', 'Mgmt', 'Test', 'Prod', 'Bkp'][i % 8]}`, tier: 'T1', haMode: '', failoverMode: 'PREEMPTIVE' });

  const segments = [];
  for (let i = 0; i < segCount; i++) {
    const vlan = rnd() < 0.4;
    segments.push({
      id: `${mgr.id}:seg-${i}`, managerId: mgr.id, name: `seg-${['web', 'app', 'db', 'dmz', 'mgmt', 'svc'][i % 6]}-${i}`,
      connectivity: vlan ? '' : `T1-${['Web', 'App', 'DB'][i % 3]}`,
      vlanIds: vlan ? [String(100 + i)] : [],
      subnets: [`10.${n(10, 250)}.${i}.0/24`],
      type: vlan ? 'VLAN' : 'OVERLAY',
    });
  }
  const transportNodes = [];
  for (let i = 0; i < hostNodes; i++) transportNodes.push({ id: `${mgr.id}:tn-h-${i}`, managerId: mgr.id, name: `esxi-${mgr.id}-${i + 1}`, type: 'host' });
  for (let i = 0; i < edgeNodes; i++) transportNodes.push({ id: `${mgr.id}:tn-e-${i}`, managerId: mgr.id, name: `edge-${mgr.id}-${i + 1}`, type: 'edge' });

  const policies = n(4, 14);
  return {
    manager: {
      id: mgr.id, name: mgr.name, host: mgr.host, region: mgr.location?.region || '', vcenterId: mgr.vcenterId || '',
      status: degraded ? 'degraded' : 'connected', version: ['4.1.2.3', '4.1.1.0', '3.2.3.1'][n(0, 2)], nodeCount: 3,
    },
    gateways, segments, transportNodes,
    firewall: { policies, rules: policies * n(3, 9) },
    groups: n(8, 40),
  };
}

/** Build a full mock NSX snapshot from the given managers (or the demo set). */
export function generateNsxSnapshot(managers) {
  const src = managers && managers.length ? managers : DEMO;
  return src.map((m) => generateNsxForManager(m));
}
