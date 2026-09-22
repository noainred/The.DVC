/**
 * Deterministic-ish mock data generator that simulates a large, globally
 * distributed VMware estate. It produces the same normalized shape as the
 * live vCenter collector so the dashboard behaves identically with or
 * without real infrastructure.
 *
 * Values drift slightly on every poll to make the live dashboard feel real.
 */

/**
 * mock 데이터 식별(v2.443, 사용자 신고 '신규 배포 엣지가 live 인데 east us 목업이 올라옴').
 *
 * 중앙의 기존 차단은 push 본문의 `source === 'mock'` 플래그만 봤다. 그런데
 *   · `DATA_SOURCE=auto` 는 vCenter 접속 실패 시 **목 데이터로 폴백**하면서도 source 는 'auto' 라 통과하고
 *   · 구버전 엣지는 source 필드 자체를 안 보내 통과한다
 * 그래서 실제로는 가짜인 인벤토리가 중앙에 저장될 수 있었다. 아래 목록으로 **id+이름이 둘 다
 * 생성기 것과 같을 때만** 목업으로 판정한다(둘 다 우연히 일치할 일은 없어 오탐이 사실상 없다).
 * 값은 SITES 하나에서 파생하므로 사이트를 추가/변경해도 자동으로 따라간다.
 */
export function mockVcenterIdentities() {
  return [...SITES.map((s) => ({ id: s.id, name: s.name })), ...EXAMPLE_SITES];
}

/**
 * 번들 예제 템플릿(config/vcenters.example.json)의 항목(v2.444).
 *
 * 신규 엣지가 vCenter 미등록 상태에서 그 템플릿으로 폴백해 **실제로 수집을 시도**하고
 * (접속 실패 → 호스트 0·VM 0) 그 빈 슬라이스를 중앙에 push 했다 — 6개 사이트가 똑같이
 * 'vc-ap-northeast' 를 보내 중앙 목록이 오염됐다. v2.444 에서 폴백 자체를 껐지만, **이미
 * 배포돼 돌고 있는 구버전 엣지**가 계속 보내므로 중앙이 내용으로도 막아야 한다.
 * 값은 그 파일과 같아야 한다(테스트로 고정).
 */
const EXAMPLE_SITES = [
  { id: 'vc-us-east', name: 'vcenter-us-east.corp.local' },
  { id: 'vc-eu-central', name: 'vcenter-eu-central.corp.local' },
  { id: 'vc-ap-northeast', name: 'vcenter-ap-northeast.corp.local' },
];

/** 이 vCenter(또는 {id,name})가 목 데이터/예제 템플릿인가 — id·이름 동시 일치. */
export function isMockVcenter(vc) {
  const id = String(vc?.id || '').trim();
  const name = String(vc?.name || '').trim();
  if (!id) return false;
  return SITES.some((s) => s.id === id && s.name === name)
    || EXAMPLE_SITES.some((s) => s.id === id && s.name === name);
}

const BASE_SITES = [
  { id: 'vc-us-east', name: 'vcenter-us-east-01', city: 'Ashburn', country: 'USA', region: '북미', lat: 39.04, lon: -77.49, hosts: 24 },
  { id: 'vc-us-west', name: 'vcenter-us-west-01', city: 'San Jose', country: 'USA', region: '북미', lat: 37.33, lon: -121.89, hosts: 18 },
  { id: 'vc-br-sao', name: 'vcenter-br-sao-01', city: 'São Paulo', country: 'Brazil', region: '북미', lat: -23.55, lon: -46.63, hosts: 8 },
  { id: 'vc-eu-central', name: 'vcenter-eu-central-01', city: 'Frankfurt', country: 'Germany', region: '유럽', lat: 50.11, lon: 8.68, hosts: 30 },
  { id: 'vc-eu-west', name: 'vcenter-eu-west-01', city: 'Dublin', country: 'Ireland', region: '유럽', lat: 53.35, lon: -6.26, hosts: 16 },
  { id: 'vc-me-uae', name: 'vcenter-me-uae-01', city: 'Dubai', country: 'UAE', region: '유럽', lat: 25.20, lon: 55.27, hosts: 6 },
  { id: 'vc-ap-northeast', name: 'vcenter-ap-northeast-01', city: 'Seoul', country: 'South Korea', region: '아시아', lat: 37.57, lon: 126.98, hosts: 22 },
  { id: 'vc-ap-southeast', name: 'vcenter-ap-southeast-01', city: 'Singapore', country: 'Singapore', region: '아시아', lat: 1.35, lon: 103.82, hosts: 14 },
  { id: 'vc-ap-south', name: 'vcenter-ap-south-01', city: 'Mumbai', country: 'India', region: '아시아', lat: 19.08, lon: 72.88, hosts: 12 },
  { id: 'vc-cn-east', name: 'vcenter-cn-east-01', city: 'Shanghai', country: 'China', region: '중국', lat: 31.23, lon: 121.47, hosts: 20 },
  { id: 'vc-cn-north', name: 'vcenter-cn-north-01', city: 'Beijing', country: 'China', region: '중국', lat: 39.90, lon: 116.41, hosts: 16 },
];

/**
 * ⚠⚠ 운영 규모 부하 측정용 스케일 — `MOCK_SCALE`(기본 1, 상한 8).
 *
 * 왜 필요한가(v2.577): 이 저장소의 성능 규약은 전부 **"28개 vCenter(~658 호스트·~5,850 VM),
 * 향후 30+"** 를 전제로 쓰여 있는데(CLAUDE.md 운영 환경) 목 데이터는 **11 vCenter · 186 호스트 ·
 * 2,242 VM** 이라 그 규모를 재는 수단이 아예 없었다. v2.576 감사가 성능을 "확정 결함 0건" 으로
 * 보고하면서 *"측정은 목 데이터 기준이다"* 를 한계로 적어야 했던 것이 그 때문이다.
 * `MOCK_SCALE=3` 이면 33 vCenter · 558 호스트 · 약 6,700 VM 으로 **운영 규모를 넘어서** 측정된다.
 *
 * ⚠ 기본값은 **1** 이다 — 데모·CI 의 기존 수치(테스트가 고정하는 vCenter 11개)를 바꾸지 않는다.
 * ⚠ 사본 id·name 은 **접미사로만** 구분한다(`-c2`). `mockVcenterList()`·`isMockVcenter()` 가
 *   이 배열에서 파생하므로 사본도 자동으로 'mock' 으로 인식된다 — 그래야 엣지 push 차단
 *   (v2.257 direct-mode 봉인)과 '빈 인벤토리' 판정(v2.560)이 사본에서도 같게 동작한다.
 */
const MOCK_SCALE = Math.max(1, Math.min(8, Math.floor(Number(process.env.MOCK_SCALE) || 1)));
const SITES = MOCK_SCALE === 1 ? BASE_SITES : BASE_SITES.flatMap((s) => (
  Array.from({ length: MOCK_SCALE }, (_, k) => (k === 0 ? s : {
    ...s,
    id: `${s.id}-c${k + 1}`,
    name: s.name.replace(/-(\d+)$/, (_m, n) => `-${String(Number(n) + k).padStart(n.length, '0')}`),
    // 지도에서 겹치지 않게 살짝 흩는다(측정용이므로 정확한 좌표는 뜻이 없다).
    lat: s.lat + (k * 0.35), lon: s.lon + (k * 0.35),
  }))
));


const GUEST_OS = [
  'Red Hat Enterprise Linux 9', 'Ubuntu Server 22.04', 'Windows Server 2022',
  'Windows Server 2019', 'CentOS Stream 9', 'SUSE Linux Enterprise 15', 'Debian 12',
];
const APP_ROLES = ['web', 'app', 'db', 'cache', 'mq', 'lb', 'k8s-node', 'monitor', 'backup', 'dns'];
const ESXI_VERSIONS = ['8.0.3', '8.0.2', '8.0.1', '7.0.3', '7.0.2', '6.7.0'];
// Host hardware vendor/model mix.
const HW = [
  { vendor: 'Dell Inc.', model: 'PowerEdge R760' },
  { vendor: 'Dell Inc.', model: 'PowerEdge R750' },
  { vendor: 'Dell Inc.', model: 'PowerEdge R740' },
  { vendor: 'HPE', model: 'ProLiant DL380 Gen11' },
  { vendor: 'HPE', model: 'ProLiant DL360 Gen10' },
  { vendor: 'Lenovo', model: 'ThinkSystem SR650 V3' },
  { vendor: 'Cisco Systems Inc', model: 'UCSC-C240-M6' },
  { vendor: 'Supermicro', model: 'SYS-220U-TNR' },
];
/* v2.556: CPU 모델 믹스(데모) — 코어 수와 어울리는 실제 제품명을 쓴다. 이 값은 mock 이며
   실장비 값은 vCenter `summary.hardware.cpuModel` 에서 온다. */
const CPU_MODELS = [
  'Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz',
  'Intel(R) Xeon(R) Gold 6348 CPU @ 2.60GHz',
  'Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz',
  'Intel(R) Xeon(R) Gold 5318Y CPU @ 2.10GHz',
  'AMD EPYC 7763 64-Core Processor',
  'AMD EPYC 9354 32-Core Processor',
  'Intel(R) Xeon(R) Gold 6248R CPU @ 3.00GHz',
];
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
  // 사용 방식: vGPU(공유 다이렉트) / 패스쓰루(DirectPath I/O) / vSGA(공유) 혼합.
  const mode = ['vgpu', 'passthrough', 'vsga'][idx % 3 === 0 ? 0 : idx % 5 === 0 ? 2 : 1];
  return Array.from({ length: count }, (_, i) => ({
    model: g.model, vendor: g.vendor, memGB: g.memGB,
    mode,                       // 'vgpu' | 'passthrough' | 'vsga'
    vgpuMode: mode === 'vgpu',  // 하위호환
    busId: `0000:${(0x3b + i).toString(16)}:00.0`,
  }));
}
// VM의 GPU 할당 정보(vGPU/패스쓰루). GPU 호스트 위 VM의 일부에만 부여.
function mkVmGpu(hostState, idx) {
  const hg = hostState?.gpus || [];
  if (!hg.length) return null;
  const mode = hg[0].mode; // 'vgpu' | 'passthrough' | 'vsga'
  if (mode === 'vsga') return null;            // vSGA는 할당형 GPU 아님
  if (idx % 3 !== 0) return null;              // GPU 호스트 VM의 ~1/3만 GPU 보유
  if (mode === 'vgpu') {
    const prof = hg[0].model.includes('A100') ? 'grid_a100-10c' : hg[0].model.includes('H100') ? 'grid_h100-20c' : 'grid_t4-4q';
    return { type: 'vgpu', count: 1, profile: prof, model: hg[0].model };
  }
  return { type: 'passthrough', count: idx % 6 === 0 ? 2 : 1, profile: '', model: hg[0].model };
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
    { key: 'com.vmware.vlcm', label: 'Lifecycle Manager', company: 'VMware', version: site.region === '북미' ? '8.0.3' : '8.0.2', category: 'Mgmt' },
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
const RES_POOLS = ['Resources', 'Prod', 'Dev', 'Batch', 'HighPriority'];
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
      // Map the datastore type to a backing-storage category. A VMFS volume can be
      // either an internal disk (로컬) or a shared block LUN (SAN); ~1 in 3 is local.
      let storageType, remoteHost = '';
      if (type === 'NFS') { storageType = 'nas'; remoteHost = `nas-${site.id.split('-').slice(1).join('')}.local`; }
      else if (type === 'vSAN') storageType = 'vsan';
      else storageType = (d % 3 === 0) ? 'local' : 'san';
      const label = storageType === 'local' ? 'local' : storageType === 'san' ? 'san' : type.toLowerCase();
      const capacityGB = storageType === 'local' ? pick([1024, 2048, 4096]) : pick([4096, 8192, 16384, 32768, 65536]);
      datastores.push({
        idx: d,
        name: `${site.city.replace(/\s+/g, '').toLowerCase()}-ds-${label}-${d + 1}`,
        type,
        storageType,
        remoteHost,
        ssd: storageType === 'vsan' || (storageType === 'local' && d % 2 === 0),
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
        cpuModel: CPU_MODELS[(h.idx * 3 + site.id.length) % CPU_MODELS.length],
        version: ESXI_VERSIONS[(h.idx + site.id.length) % ESXI_VERSIONS.length],
        vendor: HW[(h.idx + site.id.length) % HW.length].vendor,
        model: HW[(h.idx + site.id.length) % HW.length].model,
        hbas: mkHbas(h.idx),
        gpus: mkGpus(h.idx, site),
        // approximate host power draw (W): idle baseline + per-core + load-dependent
        powerWatts: disconnected ? 0 : Math.round(140 + h.cpuCores * 4.5 + cpuLoad * h.cpuCores * 5 + memLoad * 30),
        // 흡기 온도(섭씨): 부하/전원에 따라 22~38℃ 근방.
        tempC: disconnected ? null : Math.round((22 + cpuLoad * 12 + (h.idx % 5)) * 10) / 10,
        tempMaxC: disconnected ? null : Math.round((40 + cpuLoad * 25 + (h.idx % 7)) * 10) / 10,
        // ESXi가 보고하는 GPU 사용률은 vGPU/vSGA만. 순수 패스쓰루 호스트는 null
        // (게스트 OS 수집이 채움) — 실 환경 동작과 동일하게 시뮬레이션.
        gpuUtilPct: (() => {
          const gs = mkGpus(h.idx, site);
          if (!gs.length || gs.every((g) => g.mode === 'passthrough')) return null;
          return Math.round(cpuLoad * 80 + (h.idx % 17)) % 100;
        })(),
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
        template: vm.idx % 17 === 0, // ~6% are templates (always powered off)
        guestOS: vm.guestOS,
        cpuCount: vm.cpuCount,
        memMB: vm.memMB,
        storageGB: vm.storageGB,
        // ~60% thin: committed(사용) < provisioned, 나머지 thick.
        thin: vm.idx % 5 !== 0 && vm.idx % 3 !== 0,
        uncommittedGB: (vm.idx % 5 !== 0 && vm.idx % 3 !== 0) ? Math.round(vm.storageGB * (0.3 + (vm.idx % 4) * 0.15)) : 0,
        cpuUsagePct,
        memUsagePct,
        ipAddress: powered ? mkIp(site, vm.idx) : null,
        ipAddresses: powered ? mkIps(site, vm.idx) : [],
        folder: VM_FOLDERS[(vm.idx * 7 + site.id.length) % VM_FOLDERS.length],
        resourcePool: RES_POOLS[(vm.idx * 3) % RES_POOLS.length],
        toolsStatus: powered ? (vm.idx % 17 === 0 ? 'OUTDATED' : 'RUNNING') : 'NOT_RUNNING',
        toolsVersion: TOOLS_VERSIONS[vm.idx % TOOLS_VERSIONS.length],
        // 버전/패치 준수 리포트용 — 실환경 SOAP의 guest.toolsVersionStatus2와 동일한 값 집합.
        toolsVersionStatus: vm.idx % 17 === 0 ? 'guestToolsNeedUpgrade' : vm.idx % 11 === 0 ? 'guestToolsUnmanaged' : 'guestToolsCurrent',
        hwVersion: `vmx-${[19, 17, 15, 13, 10][vm.idx % 5]}`,
        // 좀비 리포트용 — 소수(약 2%)는 고아/접근불가 상태.
        connectionState: vm.idx % 53 === 0 ? 'orphaned' : vm.idx % 47 === 0 ? 'inaccessible' : 'connected',
        notes: vm.idx % 4 === 0 ? `${pick(['운영', '백업대상', '마이그레이션 예정', 'PoC', '담당: 인프라팀'])} · ${site.id}` : '',
        tags: VM_TAGS[vm.idx % VM_TAGS.length],
        snapshotCount: vm.idx % 6 === 0 ? intBetween(1, 4) : 0,
        snapshotSizeGB: vm.idx % 6 === 0 ? Math.round(vm.storageGB * (0.05 + (vm.idx % 5) * 0.06) * 10) / 10 : 0,
        // 스냅샷 나이 감시 데모용 — 1일~180일 분포의 생성일.
        snapshotOldestTs: vm.idx % 6 === 0 ? Date.now() - ((vm.idx % 180) + 1) * 86_400_000 : null,
        snapshotNewestTs: vm.idx % 6 === 0 ? Date.now() - ((vm.idx % 30) + 1) * 86_400_000 : null,
        snapshotNames: vm.idx % 6 === 0 ? ['pre-patch', 'before-upgrade'].slice(0, 1 + (vm.idx % 2)) : [],
        gpu: mkVmGpu(hostState, vm.idx),
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
        storageType: ds.storageType,
        remoteHost: ds.remoteHost,
        ssd: ds.ssd,
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
