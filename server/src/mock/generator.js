/**
 * Deterministic-ish mock data generator that simulates a large, globally
 * distributed VMware estate. It produces the same normalized shape as the
 * live vCenter collector so the dashboard behaves identically with or
 * without real infrastructure.
 *
 * Values drift slightly on every poll to make the live dashboard feel real.
 */

const SITES = [
  { id: 'vc-us-east', name: 'vcenter-us-east-01', city: 'Ashburn', country: 'USA', region: '미국', lat: 39.04, lon: -77.49, hosts: 24 },
  { id: 'vc-us-west', name: 'vcenter-us-west-01', city: 'San Jose', country: 'USA', region: '미국', lat: 37.33, lon: -121.89, hosts: 18 },
  { id: 'vc-br-sao', name: 'vcenter-br-sao-01', city: 'São Paulo', country: 'Brazil', region: '미국', lat: -23.55, lon: -46.63, hosts: 8 },
  { id: 'vc-eu-central', name: 'vcenter-eu-central-01', city: 'Frankfurt', country: 'Germany', region: '유럽', lat: 50.11, lon: 8.68, hosts: 30 },
  { id: 'vc-eu-west', name: 'vcenter-eu-west-01', city: 'Dublin', country: 'Ireland', region: '유럽', lat: 53.35, lon: -6.26, hosts: 16 },
  { id: 'vc-me-uae', name: 'vcenter-me-uae-01', city: 'Dubai', country: 'UAE', region: '유럽', lat: 25.20, lon: 55.27, hosts: 6 },
  { id: 'vc-ap-northeast', name: 'vcenter-ap-northeast-01', city: 'Seoul', country: 'South Korea', region: '아시아', lat: 37.57, lon: 126.98, hosts: 22 },
  { id: 'vc-ap-southeast', name: 'vcenter-ap-southeast-01', city: 'Singapore', country: 'Singapore', region: '아시아', lat: 1.35, lon: 103.82, hosts: 14 },
  { id: 'vc-ap-south', name: 'vcenter-ap-south-01', city: 'Mumbai', country: 'India', region: '아시아', lat: 19.08, lon: 72.88, hosts: 12 },
  { id: 'vc-cn-east', name: 'vcenter-cn-east-01', city: 'Shanghai', country: 'China', region: '중국', lat: 31.23, lon: 121.47, hosts: 20 },
  { id: 'vc-cn-north', name: 'vcenter-cn-north-01', city: 'Beijing', country: 'China', region: '중국', lat: 39.90, lon: 116.41, hosts: 16 },
];

const GUEST_OS = [
  'Red Hat Enterprise Linux 9', 'Ubuntu Server 22.04', 'Windows Server 2022',
  'Windows Server 2019', 'CentOS Stream 9', 'SUSE Linux Enterprise 15', 'Debian 12',
];
const APP_ROLES = ['web', 'app', 'db', 'cache', 'mq', 'lb', 'k8s-node', 'monitor', 'backup', 'dns'];
const ESXI_VERSIONS = ['8.0.3', '8.0.2', '8.0.1', '7.0.3', '7.0.2', '6.7.0'];
const HBA_FC = [
  { model: 'Emulex LPe35002 32Gb FC', speeds: [32, 16] },
  { model: 'QLogic QLE2772 32Gb FC', speeds: [32, 32] },
  { model: 'Emulex LPe31002 16Gb FC', speeds: [16, 16] },
  { model: 'QLogic QLE2692 16Gb FC', speeds: [16, 8] },
];
const HBA_ISCSI = { model: 'Broadcom 57414 25GbE iSCSI', speeds: [25, 25] };
function wwn(idx, p) { const h = (idx * 131 + p * 17).toString(16).padStart(2, '0'); return `20:00:00:24:ff:${h}:${(p).toString(16).padStart(2, '0')}:${(idx % 256).toString(16).padStart(2, '0')}`; }
function mkHbas(idx) {
  const fc = HBA_FC[idx % HBA_FC.length];
  const hbas = fc.speeds.map((sp, p) => ({
    name: `vmhba${p + 1}`, type: 'FibreChannel', model: fc.model,
    speedGbps: idx % 23 === 0 && p === 1 ? Math.max(8, sp / 2) : sp, // a few links degraded
    wwn: wwn(idx, p), status: 'online',
  }));
  if (idx % 4 === 0) hbas.push({ name: 'vmhba64', type: 'iSCSI', model: HBA_ISCSI.model, speedGbps: HBA_ISCSI.speeds[0], wwn: '', status: 'online' });
  return hbas;
}
const VC_VERSIONS = ['8.0.3', '8.0.2', '7.0.3'];
const TOOLS_VERSIONS = ['12352', '12325', '11365', '11296', '10346', '12389'];
const VM_TAGS = [
  ['Production', 'Tier-1'], ['Dev'], ['Backup:Daily'], [], ['Critical', 'PCI'],
  ['Test'], ['Owner:InfraTeam'], ['DR-Protected'],
];
// Installed VMware solutions (vCenter extensions) per site, with NSX highlighted.
const NSX_VERSIONS = ['4.1.2.3', '4.1.0.2', '3.2.3.1', '4.0.1.1'];
const GPU_MODELS = [
  { model: 'NVIDIA H100 80GB', memGB: 80, vendor: 'NVIDIA' },
  { model: 'NVIDIA A100 80GB', memGB: 80, vendor: 'NVIDIA' },
  { model: 'NVIDIA L40S', memGB: 48, vendor: 'NVIDIA' },
  { model: 'NVIDIA A40', memGB: 48, vendor: 'NVIDIA' },
  { model: 'NVIDIA T4', memGB: 16, vendor: 'NVIDIA' },
];
// ~1 in 4 hosts has GPUs (AI/VDI hosts). Returns [] otherwise.
function mkGpus(idx, site) {
  if (idx % 4 !== 0) return [];
  const g = GPU_MODELS[idx % GPU_MODELS.length];
  const count = [1, 2, 4, 8][idx % 4];
  return Array.from({ length: count }, (_, i) => ({
    model: g.model, vendor: g.vendor, memGB: g.memGB,
    vgpuMode: idx % 3 === 0,
    busId: `0000:${(0x3b + i).toString(16)}:00.0`,
  }));
}
function mkLicenses(site) {
  const n = site.hosts;
  return [
    { name: 'vSphere 8 Enterprise Plus', total: n + 8, used: n, key: 'XXXXX-…-AAAAA', edition: 'esxEnterprisePlus', product: 'VMware ESX Server', productVersion: '8.0', expires: '2026-12-31' },
    { name: 'vCenter Server 8 Standard', total: 1, used: 1, key: 'YYYYY-…-BBBBB', edition: 'vcExpress', product: 'VMware VirtualCenter Server', productVersion: '8.0', expires: '2026-12-31' },
    { name: 'NSX Data Center Advanced', total: n + 4, used: n, key: 'ZZZZZ-…-CCCCC', edition: 'nsx', product: 'NSX', productVersion: '4.1', expires: site.region === '중국' ? '2025-09-30' : '2027-06-30' },
    { name: 'vSAN Enterprise', total: n, used: Math.round(n * 0.6), key: 'WWWWW-…-DDDDD', edition: 'vsanEnterprise', product: 'vSAN', productVersion: '8.0', expires: '2026-12-31' },
  ];
}
function mkSolutions(site) {
  const n = site.id.length;
  const sols = [
    { key: 'com.vmware.nsx.management.nsxt', label: 'VMware NSX-T', company: 'VMware', version: NSX_VERSIONS[n % NSX_VERSIONS.length], category: 'NSX' },
    { key: 'com.vmware.vsan.health', label: 'vSAN', company: 'VMware', version: ['8.0u2', '8.0u1', '7.0u3'][n % 3], category: 'Storage' },
    { key: 'com.vmware.vcHms', label: 'Site Recovery Manager', company: 'VMware', version: ['8.7.0', '8.6.0'][n % 2], category: 'DR' },
    { key: 'com.vmware.vrops', label: 'Aria Operations', company: 'VMware', version: ['8.14.0', '8.12.1'][n % 2], category: 'Mgmt' },
    { key: 'com.vmware.vlcm', label: 'Lifecycle Manager', company: 'VMware', version: site.region === '미국' ? '8.0.3' : '8.0.2', category: 'Mgmt' },
  ];
  // some sites also have HCX / Avi
  if (n % 2 === 0) sols.push({ key: 'com.vmware.hcx', label: 'HCX', company: 'VMware', version: '4.8.0', category: 'Migration' });
  if (n % 3 === 0) sols.push({ key: 'com.vmware.avi.lb', label: 'NSX Advanced LB (Avi)', company: 'VMware', version: '22.1.3', category: 'NSX' });
  return sols;
}
// VM folder paths to mimic a vSphere "VMs and Templates" inventory.
const VM_FOLDERS = [
  'Production/Web', 'Production/DB', 'Production/App', 'Infrastructure/Network',
  'Infrastructure/Storage', 'Test/QA', 'Dev', 'DMZ', 'Discovered virtual machine',
];
const DS_TYPES = ['VMFS', 'NFS', 'vSAN'];
const NET_TYPES = ['STANDARD_PORTGROUP', 'DISTRIBUTED_PORTGROUP'];

let seed = 1337;
function rng() {
  // simple deterministic LCG so a baseline is stable, mutated per tick below
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const between = (min, max) => min + rng() * (max - min);
const intBetween = (min, max) => Math.floor(between(min, max + 1));

/** Build the stable baseline estate once. Metrics are added per-tick. */
function buildBaseline() {
  seed = 1337;
  const estate = [];
  for (const site of SITES) {
    const clusters = [];
    const nClusters = Math.max(1, Math.round(site.hosts / 8));
    for (let c = 0; c < nClusters; c++) clusters.push(`${site.city.replace(/\s+/g, '')}-CL${c + 1}`);

    const hosts = [];
    for (let h = 0; h < site.hosts; h++) {
      const cores = pick([16, 24, 32, 48, 64]);
      hosts.push({
        idx: h,
        name: `esxi-${site.id.split('-').slice(1).join('')}-${String(h + 1).padStart(2, '0')}`,
        cluster: clusters[h % clusters.length],
        cpuCores: cores,
        cpuMhzPerCore: pick([2200, 2400, 2600, 2900, 3200]),
        memTotalMB: pick([262144, 393216, 524288, 786432, 1048576]),
      });
    }

    const datastores = [];
    const nDs = Math.max(2, Math.round(site.hosts / 5));
    for (let d = 0; d < nDs; d++) {
      const type = pick(DS_TYPES);
      const capacityGB = pick([2048, 4096, 8192, 16384, 32768, 65536]);
      datastores.push({
        idx: d,
        name: `${site.city.replace(/\s+/g, '').toLowerCase()}-ds-${type.toLowerCase()}-${d + 1}`,
        type,
        capacityGB,
      });
    }

    const networks = [];
    const nNet = Math.max(2, Math.round(site.hosts / 6));
    for (let n = 0; n < nNet; n++) {
      networks.push({
        idx: n,
        name: `${site.city.replace(/\s+/g, '').toLowerCase()}-pg-${['mgmt', 'vmotion', 'prod', 'dmz', 'storage', 'backup'][n % 6]}`,
        type: pick(NET_TYPES),
        vlanId: 100 + n * 10 + (site.lat > 0 ? 0 : 1),
      });
    }

    const vms = [];
    const vmCount = site.hosts * intBetween(8, 16);
    for (let v = 0; v < vmCount; v++) {
      const host = hosts[v % hosts.length];
      vms.push({
        idx: v,
        host,
        name: `${pick(APP_ROLES)}-${site.id.split('-')[1]}-${String(v + 1).padStart(4, '0')}`,
        guestOS: pick(GUEST_OS),
        cpuCount: pick([1, 2, 2, 4, 4, 8, 16]),
        memMB: pick([2048, 4096, 8192, 8192, 16384, 32768, 65536]),
        storageGB: pick([40, 80, 100, 200, 500, 1024]),
        baseOn: rng() > 0.12, // ~12% powered off
      });
    }

    estate.push({ site, clusters, hosts, datastores, networks, vms });
  }
  return estate;
}

const baseline = buildBaseline();
let tick = 0;

/** Produce a fresh, slightly-drifting snapshot of the whole global estate. */
export function generateSnapshot() {
  tick++;
  const wave = Math.sin(tick / 5);
  const vcenters = [];
  const hosts = [];
  const vms = [];
  const datastores = [];
  const networks = [];
  const alarms = [];

  for (const env of baseline) {
    const { site } = env;
    // Occasionally a whole vCenter is unreachable.
    const vcReachable = !(site.id === 'vc-me-uae' && Math.floor(tick / 20) % 7 === 3);

    vcenters.push({
      id: site.id,
      name: site.name,
      location: { city: site.city, country: site.country, region: site.region, lat: site.lat, lon: site.lon },
      status: vcReachable ? 'connected' : 'unreachable',
      version: VC_VERSIONS[site.id.length % VC_VERSIONS.length],
      build: '22617221',
      solutions: mkSolutions(site),
      licenses: mkLicenses(site),
    });

    if (!vcReachable) {
      alarms.push({
        id: `${site.id}:vc-down`,
        vcenterId: site.id,
        entity: site.name,
        entityType: 'vcenter',
        severity: 'critical',
        message: 'vCenter Server is not responding (connection timeout)',
        time: new Date().toISOString(),
        acknowledged: false,
      });
      continue;
    }

    // Hosts
    const hostMetrics = new Map();
    for (const h of env.hosts) {
      const maint = (h.idx + Math.floor(tick / 3)) % 37 === 0;
      const disconnected = (h.idx * 7 + tick) % 113 === 0;
      const connectionState = disconnected ? 'DISCONNECTED' : maint ? 'MAINTENANCE' : 'CONNECTED';
      const powerState = 'POWERED_ON';
      const cpuTotalMhz = h.cpuCores * h.cpuMhzPerCore;
      // ~1 in 11 hosts runs hot, so a realistic share trips the CPU/mem thresholds.
      const hotCpu = h.idx % 11 === 3;
      const hotMem = h.idx % 13 === 5;
      const cpuLoad = clamp((hotCpu ? 0.88 : 0.25) + (hotCpu ? 0.1 : 0.4) * Math.abs(Math.sin((h.idx + tick) / 7)) + wave * 0.05, 0.03, 0.99);
      const memLoad = clamp((hotMem ? 0.9 : 0.4) + (hotMem ? 0.08 : 0.35) * Math.abs(Math.cos((h.idx + tick) / 9)), 0.1, 0.99);
      const cpuUsageMhz = Math.round(cpuTotalMhz * (disconnected ? 0 : cpuLoad));
      const memUsageMB = Math.round(h.memTotalMB * (disconnected ? 0 : memLoad));
      const vmsOnHost = env.vms.filter((vm) => vm.host === h);
      hostMetrics.set(h, { cpuLoad, memLoad });

      hosts.push({
        id: `${site.id}:${h.name}`,
        vcenterId: site.id,
        name: h.name,
        cluster: h.cluster,
        connectionState,
        powerState,
        cpuCores: h.cpuCores,
        cpuTotalMhz,
        cpuUsageMhz,
        cpuUsagePct: Math.round((cpuUsageMhz / cpuTotalMhz) * 100),
        memTotalMB: h.memTotalMB,
        memUsageMB,
        memUsagePct: Math.round((memUsageMB / h.memTotalMB) * 100),
        vmCount: vmsOnHost.length,
        cpuThreads: h.cpuCores * 2, // logical cores (hyper-threaded)
        version: ESXI_VERSIONS[(h.idx + site.id.length) % ESXI_VERSIONS.length],
        hbas: mkHbas(h.idx),
        gpus: mkGpus(h.idx, site),
        // approximate host power draw (W): idle baseline + per-core + load-dependent
        powerWatts: disconnected ? 0 : Math.round(140 + h.cpuCores * 4.5 + cpuLoad * h.cpuCores * 5 + memLoad * 30),
      });

      if (connectionState === 'DISCONNECTED') {
        alarms.push(mkAlarm(site.id, h.name, 'host', 'critical', 'Host disconnected from vCenter'));
      } else if (connectionState === 'MAINTENANCE') {
        alarms.push(mkAlarm(site.id, h.name, 'host', 'info', 'Host entered maintenance mode'));
      } else if (cpuUsageMhz / cpuTotalMhz > 0.9) {
        alarms.push(mkAlarm(site.id, h.name, 'host', 'warning', `High CPU usage (${Math.round((cpuUsageMhz / cpuTotalMhz) * 100)}%)`));
      } else if (memUsageMB / h.memTotalMB > 0.92) {
        alarms.push(mkAlarm(site.id, h.name, 'host', 'warning', `High memory usage (${Math.round((memUsageMB / h.memTotalMB) * 100)}%)`));
      }
    }

    // VMs
    for (const vm of env.vms) {
      const hostState = hosts.find((x) => x.name === vm.host.name && x.vcenterId === site.id);
      const hostDown = hostState?.connectionState === 'DISCONNECTED';
      const powered = vm.baseOn && !hostDown;
      const cpuUsagePct = powered ? Math.round(clamp(15 + 60 * Math.abs(Math.sin((vm.idx + tick) / 11)), 1, 100)) : 0;
      const memUsagePct = powered ? Math.round(clamp(25 + 55 * Math.abs(Math.cos((vm.idx + tick) / 13)), 1, 100)) : 0;
      vms.push({
        id: `${site.id}:${vm.name}`,
        vcenterId: site.id,
        host: vm.host.name,
        cluster: vm.host.cluster,
        name: vm.name,
        powerState: powered ? 'POWERED_ON' : 'POWERED_OFF',
        guestOS: vm.guestOS,
        cpuCount: vm.cpuCount,
        memMB: vm.memMB,
        storageGB: vm.storageGB,
        cpuUsagePct,
        memUsagePct,
        ipAddress: powered ? mkIp(site, vm.idx) : null,
        ipAddresses: powered ? mkIps(site, vm.idx) : [],
        folder: VM_FOLDERS[(vm.idx * 7 + site.id.length) % VM_FOLDERS.length],
        toolsStatus: powered ? (vm.idx % 17 === 0 ? 'OUTDATED' : 'RUNNING') : 'NOT_RUNNING',
        toolsVersion: TOOLS_VERSIONS[vm.idx % TOOLS_VERSIONS.length],
        notes: vm.idx % 4 === 0 ? `${pick(['운영', '백업대상', '마이그레이션 예정', 'PoC', '담당: 인프라팀'])} · ${site.id}` : '',
        tags: VM_TAGS[vm.idx % VM_TAGS.length],
        snapshotCount: vm.idx % 6 === 0 ? intBetween(1, 4) : 0,
        snapshotSizeGB: vm.idx % 6 === 0 ? Math.round(vm.storageGB * (0.05 + (vm.idx % 5) * 0.06) * 10) / 10 : 0,
      });
    }

    // Datastores
    for (const ds of env.datastores) {
      // ~1 in 7 datastores is near-full so capacity alarms appear.
      const hot = ds.idx % 7 === 2;
      const usedFrac = clamp((hot ? 0.9 : 0.45) + (hot ? 0.08 : 0.4) * Math.abs(Math.sin((ds.idx + tick) / 6)), 0.1, 0.99);
      const freeGB = Math.round(ds.capacityGB * (1 - usedFrac));
      datastores.push({
        id: `${site.id}:${ds.name}`,
        vcenterId: site.id,
        name: ds.name,
        type: ds.type,
        capacityGB: ds.capacityGB,
        freeGB,
        usedGB: ds.capacityGB - freeGB,
        usagePct: Math.round(usedFrac * 100),
        accessible: true,
      });
      if (usedFrac > 0.9) {
        alarms.push(mkAlarm(site.id, ds.name, 'datastore', usedFrac > 0.95 ? 'critical' : 'warning', `Datastore usage at ${Math.round(usedFrac * 100)}%`));
      }
    }

    // Networks
    for (const net of env.networks) {
      const vmCount = vms.filter((v) => v.vcenterId === site.id).length;
      networks.push({
        id: `${site.id}:${net.name}`,
        vcenterId: site.id,
        name: net.name,
        type: net.type,
        vlanId: net.vlanId,
        hostCount: env.hosts.length,
        vmCount: Math.round(vmCount / env.networks.length),
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    source: 'mock',
    vcenters,
    hosts,
    vms,
    datastores,
    networks,
    alarms: alarms.sort((a, b) => severityRank(b.severity) - severityRank(a.severity)),
  };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function mkIp(site, idx) {
  const oct = Math.abs(Math.round(site.lat)) % 250;
  return `10.${oct}.${Math.floor(idx / 254) % 254}.${(idx % 253) + 1}`;
}
// Some VMs are multi-homed (mgmt + service + storage NIC). Returns 1-3 IPv4s.
function mkIps(site, idx) {
  const ips = [mkIp(site, idx)];
  if (idx % 3 === 0) ips.push(`172.16.${idx % 254}.${(idx * 7 % 253) + 1}`);
  if (idx % 5 === 0) ips.push(`192.168.${idx % 254}.${(idx * 3 % 253) + 1}`);
  return ips;
}
function severityRank(s) {
  return { critical: 3, warning: 2, info: 1 }[s] || 0;
}
let alarmSeq = 0;
function mkAlarm(vcenterId, entity, entityType, severity, message) {
  return {
    id: `${vcenterId}:${entity}:${alarmSeq++}`,
    vcenterId,
    entity,
    entityType,
    severity,
    message,
    time: new Date().toISOString(),
    acknowledged: false,
  };
}
