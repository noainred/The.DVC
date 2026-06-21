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
      transportZone: vlan ? 'TZ-VLAN' : 'TZ-Overlay',
      vmCount: n(0, 36),
      ports: Array.from({ length: Math.min(8, n(0, 8)) }, (_, k) => `vm-${['web', 'app', 'db'][k % 3]}-${mgr.id}-${i}-${k + 1}`),
    });
  }
  const transportNodes = [];
  for (let i = 0; i < hostNodes; i++) transportNodes.push({ id: `${mgr.id}:tn-h-${i}`, managerId: mgr.id, name: `esxi-${mgr.id}-${i + 1}`, type: 'host', status: rnd() < 0.95 ? 'UP' : 'DOWN' });
  for (let i = 0; i < edgeNodes; i++) transportNodes.push({ id: `${mgr.id}:tn-e-${i}`, managerId: mgr.id, name: `edge-${mgr.id}-${i + 1}`, type: 'edge', status: rnd() < 0.97 ? 'UP' : 'DOWN' });

  // Interfaces / NAT / LB on the gateways (for the detail view).
  for (const g of gateways) {
    g.interfaces = g.tier === 'T0' ? n(2, 6) : n(1, 4);
    g.nat = n(0, g.tier === 'T0' ? 24 : 12);
    g.lb = g.tier === 'T1' ? n(0, 4) : 0;
  }

  // Security groups with members (VM names + effective IPs) and a match criteria.
  const groupCount = n(8, 24);
  const groupNames = [];
  const securityGroups = [];
  for (let g = 0; g < groupCount; g++) {
    const gname = `sg-${['web', 'app', 'db', 'dmz', 'mgmt', 'svc', 'prod', 'dev'][g % 8]}-${g}`;
    groupNames.push(gname);
    const memberCount = n(1, 14);
    securityGroups.push({
      id: `${mgr.id}:grp-${g}`, managerId: mgr.id, name: gname,
      memberType: rnd() < 0.6 ? 'VM' : 'IP', memberCount,
      members: Array.from({ length: Math.min(memberCount, 40) }, (_, k) => `vm-${gname}-${k + 1}`),
      memberIps: Array.from({ length: Math.min(memberCount, 40) }, () => `10.${n(10, 250)}.${n(0, 255)}.${n(1, 254)}`),
      criteria: `Tag.scope = ${['env', 'app', 'tier'][g % 3]} AND Tag = ${['prod', 'web', 'db', 'dmz'][g % 4]}`,
    });
  }

  // Distributed firewall: policies, each with concrete rules referencing groups.
  const SERVICES = ['HTTPS', 'HTTP', 'SSH', 'MySQL', 'PostgreSQL', 'DNS', 'ICMP-ALL', 'Any'];
  const ACTIONS = ['ALLOW', 'DROP', 'REJECT'];
  const CATS = ['Emergency', 'Infrastructure', 'Environment', 'Application'];
  const policies = n(4, 14);
  const pickG = () => (groupNames.length ? groupNames[n(0, groupNames.length - 1)] : 'Any');
  const dfw = [];
  let ruleTotal = 0;
  for (let p = 0; p < policies; p++) {
    const cat = CATS[p % CATS.length];
    const ruleN = n(2, 8);
    const rules = [];
    for (let r = 0; r < ruleN; r++) {
      rules.push({
        id: `${mgr.id}:rule-${p}-${r}`, managerId: mgr.id, policy: `${cat}-Policy-${p}`,
        name: `${cat.slice(0, 3)}-rule-${p}-${r}`,
        sources: rnd() < 0.3 ? ['Any'] : [pickG()],
        destinations: rnd() < 0.3 ? ['Any'] : [pickG()],
        services: [SERVICES[n(0, SERVICES.length - 1)]],
        action: rnd() < 0.72 ? 'ALLOW' : ACTIONS[n(1, 2)],
        direction: 'IN_OUT', appliedTo: rnd() < 0.5 ? 'DFW' : pickG(),
        enabled: rnd() > 0.05,
        logged: rnd() < 0.5,
        ipProtocol: 'IPV4_IPV6', category: cat, sequence: (r + 1) * 10,
        notes: rnd() < 0.2 ? '운영팀 승인 규칙' : '',
      });
    }
    ruleTotal += ruleN;
    dfw.push({ id: `${mgr.id}:pol-${p}`, managerId: mgr.id, name: `${cat}-Policy-${p}`, category: cat, ruleCount: ruleN, rules });
  }

  return {
    manager: {
      id: mgr.id, name: mgr.name, host: mgr.host, region: mgr.location?.region || '', vcenterId: mgr.vcenterId || '',
      status: degraded ? 'degraded' : 'connected', version: ['4.1.2.3', '4.1.1.0', '3.2.3.1'][n(0, 2)], nodeCount: 3,
    },
    gateways, segments, transportNodes,
    firewall: { policies, rules: ruleTotal },
    groups: groupCount,
    dfw, securityGroups,
  };
}

/** Build a full mock NSX snapshot from the given managers (or the demo set). */
export function generateNsxSnapshot(managers) {
  const src = managers && managers.length ? managers : DEMO;
  return src.map((m) => generateNsxForManager(m));
}
