/**
 * mock/demo/idrac.js — 데모(DATA_SOURCE=mock) iDRAC 센서·인벤토리·센서 상세·통합 추이(v2.708).
 *
 * 예전 mock 은 iDRAC 등록 서버에 **전력만** 적재했다(seed.js mockIdracPollTick). 그래서 법인 전산실 온도·서버 온도·
 * 센서 상세·통합 추이·서버 분석(파트·NIC·GPU·시리얼)·파트 장애 화면이 전부 '센서 0대'·'인벤토리 없음' 이었다.
 * 여기서 mock 폴 틱마다 등록 서버(`mock-` 접두만)의 합성 값을 **실제 폴러가 쓰는 같은 저장소**에 넣는다:
 *   sensorStore(1분 표본) · sensorDetailCache(Thermal 상세 + Sensors 컬렉션) · invCache(인벤토리, 30분 주기) ·
 *   metrics DB(통합 추이·법인 온도 계열 백필 — 기동 1회, 이미 있으면 건너뜀) · 전력 DB(14일 백필 — 1회).
 *
 * 규칙(flags.js 머리말): mock 모드에서만 · 실등록(`mock-` 아님)은 건드리지 않는다 · 장비 접속 0 ·
 * 값은 서버 id 에서 결정적으로(demoHash) 만들고 시간에 따라 조금 흔들린다 · 결측은 지어내지 않는다
 * (텔레메트리 라이선스가 없는 서버는 cpuUsagePct 가 null 이고 Sensors 컬렉션의 CPU Usage 센서로만 온다 —
 * 실장비 Enterprise 라이선스 서버와 같은 모양).
 */
import { isMockMode, demoHash, demoRand, demoIp } from './flags.js';
import { mockServiceTag } from '../seed.js';
import { parseThermalTemp, parseThermalFan, parseRedfishSensor } from '../../idrac/sensorDetail.js';
import { pushAll } from '../../util/pushAll.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const INVENTORY_MAX_AGE_MS = 30 * MIN;   // idrac/poller.js 와 같은 값(인벤토리·Sensors 컬렉션 주기)

const r1 = (v) => Math.round(v * 10) / 10;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// 서비스태그 규칙은 seed.js 하나(시드와 데모가 같은 규칙). seed.js 는 이 모듈을 import 하지 않는다(순환 금지).
export { mockServiceTag };

/* ───────────────────────── 서버 프로필(결정적) ───────────────────────── */


/**
 * 서버 한 대의 고정 특성. `host` 는 같은 이름의 ESXi 호스트(가상화 호스트를 받치는 iDRAC 이면), `spec` 은 베어메탈 시드 사양.
 * @returns {{id,kind,model,cpuModel,sockets,coresPerSocket,memGB,gpus:string[],license:'datacenter'|'enterprise',
 *   inletBase:number,loadBase:number,phase:number,hot:boolean}}
 */
export function demoServerProfile(server, { host = null, spec = null } = {}) {
  const id = String(server?.id || '');
  const h = demoHash(id);
  const kind = spec ? 'baremetal' : 'esxi';
  const model = spec?.model || host?.model || 'PowerEdge R750';
  const sockets = spec?.sockets || host?.cpuSockets || 2;
  const cores = spec?.cores || host?.cpuCores || 32;
  const gpus = spec ? (spec.gpus || []) : (Array.isArray(host?.gpus) ? host.gpus.map((g) => String(g?.model || 'NVIDIA GPU')) : []);
  // 법인(vCenter) 단위로 전산실 기준 온도가 다르다 — 한 곳은 일부러 따뜻하게(주의 구간 27~32℃).
  const vc = String(server?.vcenterId || server?.datacenterId || '');
  const vcH = demoHash(`room|${vc}`);
  const hot = vcH % 7 === 3;
  const inletBase = (hot ? 27.5 : 19 + (vcH % 50) / 10) + ((h % 30) - 15) / 10;
  return {
    id, kind, model,
    cpuModel: spec?.cpuModel || host?.cpuModel || 'Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz',
    sockets, coresPerSocket: Math.max(1, Math.round(cores / sockets)),
    memGB: spec?.memGB || (host?.memTotalMB ? Math.round(host.memTotalMB / 1024) : 512),
    gpus,
    license: h % 5 < 3 ? 'datacenter' : 'enterprise',
    inletBase: r1(inletBase),
    loadBase: spec?.loadBase ?? (15 + (h % 55)),
    phase: (h % 1000) / 1000,
    hot,
  };
}

/** 시각 t 의 CPU 부하(0~100) — 하루 주기 + 서버별 위상 + 15분 단위 작은 흔들림. */
export function demoLoadAt(p, t) {
  const day = Math.sin(2 * Math.PI * ((t % DAY) / DAY + p.phase));
  const noise = (demoRand(`${p.id}|${Math.floor(t / (15 * MIN))}`) - 0.5) * 10;
  return r1(clamp(p.loadBase + day * 14 + noise, 2, 98));
}

/**
 * 시각 t 의 센서 판독 — 실장비 Thermal 응답(Redfish Temperatures[]·Fans[]) 모양의 원소와,
 * 그것을 sensorStore 표본 모양으로 접은 값.
 * @returns {{ rawTemps:object[], rawFans:object[], temps:{name,celsius}[], fans:{name,rpm}[], cpuUsagePct:number|null, load:number }}
 */
export function demoSensorReadingAt(p, t) {
  const load = demoLoadAt(p, t);
  const wob = (k) => (demoRand(`${p.id}|${k}|${Math.floor(t / (10 * MIN))}`) - 0.5);
  const inlet = r1(p.inletBase + Math.sin(2 * Math.PI * ((t % DAY) / DAY)) * 0.8 + wob('in') * 0.6);
  const exhaust = r1(inlet + 9 + load * 0.13 + wob('ex'));
  const rawTemps = [
    { MemberId: 'iDRAC.Embedded.1#SystemBoardInletTemp', Name: 'System Board Inlet Temp', ReadingCelsius: inlet, PhysicalContext: 'Intake',
      LowerThresholdCritical: -7, LowerThresholdNonCritical: 3, UpperThresholdNonCritical: 38, UpperThresholdCritical: 42, Status: { State: 'Enabled', Health: 'OK' } },
    { MemberId: 'iDRAC.Embedded.1#SystemBoardExhaustTemp', Name: 'System Board Exhaust Temp', ReadingCelsius: exhaust, PhysicalContext: 'Exhaust',
      LowerThresholdCritical: 3, LowerThresholdNonCritical: 8, UpperThresholdNonCritical: 70, UpperThresholdCritical: 75, Status: { State: 'Enabled', Health: 'OK' } },
  ];
  for (let i = 1; i <= p.sockets; i++) {
    rawTemps.push({ MemberId: `iDRAC.Embedded.1#CPU${i}Temp`, Name: `CPU${i} Temp`, ReadingCelsius: r1(36 + load * 0.38 + i + wob(`c${i}`) * 2), PhysicalContext: 'CPU',
      LowerThresholdCritical: 3, LowerThresholdNonCritical: 8, UpperThresholdNonCritical: 93, UpperThresholdCritical: 98, Status: { State: 'Enabled', Health: 'OK' } });
  }
  p.gpus.forEach((_, i) => {
    const gl = clamp(load + (demoRand(`${p.id}|g${i}`) - 0.3) * 40, 0, 100);
    rawTemps.push({ MemberId: `iDRAC.Embedded.1#GPU${i + 1}Temp`, Name: `GPU${i + 1} Temp`, ReadingCelsius: r1(33 + gl * 0.42 + wob(`g${i}`) * 2), PhysicalContext: 'GPU',
      UpperThresholdNonCritical: 87, UpperThresholdCritical: 92, Status: { State: 'Enabled', Health: 'OK' } });
  });
  const rawFans = [];
  for (let i = 1; i <= 6; i++) {
    rawFans.push({ MemberId: `0x17||Fan.Embedded.${i}A`, Name: `System Board Fan${i}A`, Reading: Math.round((4200 + load * 40 + wob(`f${i}`) * 300) / 10) * 10, ReadingUnits: 'RPM',
      LowerThresholdCritical: 600, LowerThresholdNonCritical: 840, Status: { State: 'Enabled', Health: 'OK' } });
  }
  return {
    rawTemps, rawFans, load,
    temps: rawTemps.map((x) => ({ name: x.Name, celsius: x.ReadingCelsius })),
    fans: rawFans.map((x) => ({ name: x.Name, rpm: x.Reading })),
    // Dell 텔레메트리 SystemUsage 는 Datacenter 라이선스 전용 — Enterprise 서버는 null(실장비와 같다).
    cpuUsagePct: p.license === 'datacenter' ? Math.round(load) : null,
  };
}

/** Thermal 상세(임계값·상태 포함) — idrac/redfish.js fetchSensors 의 thermalDetail 과 같은 파서를 쓴다. */
export function demoThermalDetail(reading) {
  const out = [];
  for (const t of reading.rawTemps) { const d = parseThermalTemp(t, { chassis: 'System.Embedded.1' }); if (d) out.push(d); }
  for (const f of reading.rawFans) { const d = parseThermalFan(f, { chassis: 'System.Embedded.1' }); if (d) out.push(d); }
  return out;
}

/** Sensors 컬렉션(전압·전류·전력·퍼센트) — fetchSensorCollection 결과 모양. */
export function demoSensorCollection(p, t, watts = null) {
  const reading = demoSensorReadingAt(p, t);
  const S = (Id, Name, ReadingType, ReadingUnits, Reading, PhysicalContext, Thresholds = {}) =>
    parseRedfishSensor({ Id, Name, ReadingType, ReadingUnits, Reading, PhysicalContext, Thresholds, Status: { State: 'Enabled', Health: 'OK' } }, { chassis: 'System.Embedded.1' });
  const w = watts ?? Math.round(300 + reading.load * 4);
  const sensors = [
    S('SystemBoardCPUUsage', 'CPU Usage', 'Percent', '%', Math.round(reading.load), 'CPU'),
    S('SystemBoardMEMUsage', 'MEM Usage', 'Percent', '%', Math.round(clamp(30 + reading.load * 0.5, 0, 100)), 'Memory'),
    S('SystemBoardIOUsage', 'IO Usage', 'Percent', '%', Math.round(clamp(reading.load * 0.4, 0, 100)), 'SystemBoard'),
    S('PS1Voltage1', 'PS1 Voltage 1', 'Voltage', 'V', 228 + Math.round(demoRand(`${p.id}|v1`) * 6), 'PowerSupply', { LowerCritical: { Reading: 180 }, UpperCritical: { Reading: 264 } }),
    S('PS2Voltage2', 'PS2 Voltage 2', 'Voltage', 'V', 229 + Math.round(demoRand(`${p.id}|v2`) * 6), 'PowerSupply', { LowerCritical: { Reading: 180 }, UpperCritical: { Reading: 264 } }),
    S('PS1Current1', 'PS1 Current 1', 'Current', 'A', r1(w / 2 / 230), 'PowerSupply'),
    S('PS2Current2', 'PS2 Current 2', 'Current', 'A', r1(w / 2 / 230), 'PowerSupply'),
    S('SystemBoardPwrConsumption', 'System Board Pwr Consumption', 'Power', 'W', w, 'SystemBoard', { UpperCaution: { Reading: 1210 }, UpperCritical: { Reading: 1330 } }),
    S('SystemBoardDIMMTemp', 'System Board DIMM Temp', 'Temperature', 'Cel', r1(26 + reading.load * 0.12), 'Memory', { UpperCaution: { Reading: 85 }, UpperCritical: { Reading: 90 } }),
  ].filter(Boolean);
  return { ok: true, sensors, chassis: 1, absent: 0, failed: 0, expanded: 1, notRead: 0 };
}

/* ───────────────────────── 인벤토리(결정적 + 일부 부품 장애) ───────────────────────── */

const FW_BY_MODEL = { R760: ['2.3.5', '7.10.30.00'], R750: ['1.13.2', '7.00.00.171'], R740: ['2.21.2', '6.10.80.00'], R650: ['1.12.1', '7.00.00.171'] };

/**
 * 장애 계획 — 대부분 정상, 일부 서버만 부품 이상(파트 장애 화면이 열린 장애·전이·이벤트를 갖게).
 * 하나는 **시간에 따라 열렸다 닫힌다**(6시간 창마다 바뀐다) — 전이(열림/해소) 이벤트가 쌓인다.
 */
export function demoFaultPlan(id, now = Date.now()) {
  const h = demoHash(`fault|${id}`);
  const plan = { disk: null, psu: null, dimm: null, fan: null };
  if (h % 13 === 0) plan.disk = 'predictive';             // 예측 실패(주의)
  if (h % 19 === 0) plan.psu = 'Critical';                 // PSU 이상
  if (h % 23 === 0) plan.dimm = 'Warning';                 // 정정 가능 오류 누적(주의)
  if (h % 11 === 0 && Math.floor(now / (6 * HOUR)) % 2 === 0) plan.fan = 'Critical'; // 오락가락 — 전이 이벤트
  return plan;
}

function macOf(seed) {
  const h = demoHash(`mac|${seed}`); const h2 = demoHash(`mac2|${seed}`);
  const b = [0xb0, 0x26, 0x28, (h >>> 16) & 255, (h >>> 8) & 255, h2 & 255];
  return b.map((x) => x.toString(16).padStart(2, '0')).join(':').toUpperCase();
}

/**
 * idrac/redfish.js fetchInventory 결과와 같은 모양의 인벤토리.
 * @param {object} server 등록부 항목
 * @param {object} p demoServerProfile
 * @param {number} now
 * @param {{watts?:number|null}} [o]
 */
export function demoInventory(server, p, now = Date.now(), { watts = null } = {}) {
  const id = String(server.id);
  const plan = demoFaultPlan(id, now);
  const fam = (/R7\d0|R6\d0/.exec(p.model) || ['R750'])[0];
  const [bios, idracFw] = FW_BY_MODEL[fam] || FW_BY_MODEL.R750;
  const tag = String(server.serviceTag || mockServiceTag(id));
  const hostName = (server.hostNames || [])[0] || server.name || '';
  const sysHealth = [plan.psu, plan.fan].includes('Critical') ? 'Critical' : (plan.disk || plan.dimm ? 'Warning' : 'OK');
  const w = watts ?? Math.round(320 + p.loadBase * 3);

  const inv = {
    collectedAt: now,
    reachable: true,
    collections: { system: 'ok', psus: 'ok', disks: 'ok', storageControllers: 'ok', memoryDimms: 'ok', cpus: 'ok', gpus: 'ok', pcie: 'ok', fans: 'ok' },
    system: {
      hostName, model: p.model, manufacturer: 'Dell Inc.', serviceTag: tag, serialNumber: `CN${String(demoHash(`sn|${id}`)).slice(0, 10)}`,
      sku: tag, hpe: false, assetTag: '', uuid: `4c4c4544-00${String(demoHash(`u|${id}`) % 100).padStart(2, '0')}-4d10-80${String(demoHash(`u2|${id}`) % 100).padStart(2, '0')}-${tag.toLowerCase().padEnd(12, '0').slice(0, 12)}`,
      biosVersion: bios, powerState: 'On', health: sysHealth, indicatorLED: 'Off',
    },
    idrac: { firmwareVersion: idracFw, model: '15G Monolithic', type: 'BMC', dateTime: new Date(now).toISOString(), ipmiVersion: '2.0' },
    cpu: { count: p.sockets, model: p.cpuModel, cores: p.sockets * p.coresPerSocket, threads: p.sockets * p.coresPerSocket * 2, health: 'OK' },
    memory: { totalGiB: p.memGB, health: plan.dimm ? 'Warning' : 'OK' },
    boot: { mode: 'UEFI', overrideTarget: 'None', overrideEnabled: 'Disabled', secureBoot: 'present', bootOrderCount: 4 },
    powerState: 'On',
    network: [{ name: 'NIC.1', mac: macOf(`${id}|bmc`), hostName: `idrac-${tag.toLowerCase()}`, fqdn: `idrac-${tag.toLowerCase()}.mgmt.local`, ipv4: String(server.host || '').replace(/^https?:\/\//, '') }],
    bios: { version: bios, attributes: { BootMode: 'Uefi', SysProfile: 'PerfOptimized', ProcVirtualization: 'Enabled', LogicalProc: 'Enabled', SriovGlobalEnable: p.kind === 'esxi' ? 'Enabled' : 'Disabled', MemOpMode: 'OptimizerMode', ProcTurboMode: 'Enabled', SecureBoot: 'Enabled' }, attributeCount: 412 },
  };
  inv.psus = [1, 2].map((i) => ({
    name: `PS${i} Status`, model: 'PWR SPLY,1400W,RDNT,LTON', manufacturer: 'DELL', serial: `CNLOD${String(demoHash(`ps${i}|${id}`)).slice(0, 9)}`, partNumber: '0RYMG6A02',
    capacityWatts: 1400, inputWatts: plan.psu && i === 2 ? null : Math.round(w / (plan.psu ? 1 : 2)), outputWatts: plan.psu && i === 2 ? null : Math.round(w / (plan.psu ? 1 : 2) * 0.94),
    lineInputVoltage: plan.psu && i === 2 ? 0 : 230, health: plan.psu && i === 2 ? plan.psu : 'OK', state: 'Enabled', firmware: '00.1D.7D',
  }));
  inv.powerCap = { limitWatts: null, allocatedWatts: 1400, metricWatts: w };
  const diskN = p.kind === 'baremetal' ? 6 : 2;
  inv.storageControllers = [
    { name: 'BOSS-S2', model: 'BOSS-S2', manufacturer: 'DELL', firmware: '2.5.13.4008', speedGbps: 6, protocols: 'SATA', health: 'OK' },
    ...(p.kind === 'baremetal' ? [{ name: 'PERC H755 Front', model: 'PERC H755 Front', manufacturer: 'DELL', firmware: '52.21.0-4606', speedGbps: 12, protocols: 'SAS/SATA', health: 'OK' }] : []),
  ];
  inv.disks = Array.from({ length: diskN }, (_, i) => {
    const boss = i < 2;
    const pf = plan.disk && i === diskN - 1;
    return {
      name: boss ? `SSD ${i} (BOSS)` : `Solid State Disk 0:1:${i}`,
      model: boss ? 'MTFDDAV480TDS' : 'KPM6XRUG3T84', serial: `S${String(demoHash(`d${i}|${id}`)).slice(0, 9)}`,
      capacityGB: boss ? 480 : 3840, media: 'SSD', protocol: boss ? 'SATA' : 'SAS',
      health: pf ? 'Warning' : 'OK', state: 'Enabled', predictiveFailure: !!pf, rpm: null,
    };
  });
  const dimmGB = 64;
  const dimmN = Math.max(4, Math.min(24, Math.round(p.memGB / dimmGB)));
  const slots = p.sockets * 16;
  inv.memoryDimms = Array.from({ length: Math.min(64, slots) }, (_, i) => {
    const sock = String.fromCharCode(65 + Math.floor(i / 16)); const slot = (i % 16) + 1;
    const present = i < dimmN;
    return present ? {
      locator: `DIMM.Socket.${sock}${slot}`, sizeGB: dimmGB, speedMHz: 3200, type: 'DDR4', manufacturer: 'Samsung', partNumber: 'M393A8G40AB2-CWE',
      serial: `${String(demoHash(`m${i}|${id}`)).slice(0, 8)}`, rank: 2, health: plan.dimm && i === 3 ? 'Warning' : 'OK', state: 'Enabled',
    } : { locator: `DIMM.Socket.${sock}${slot}`, sizeGB: null, speedMHz: null, type: '', manufacturer: '', partNumber: '', serial: '', rank: null, health: '', state: 'Absent' };
  // 빈 슬롯(State Absent)은 일부 서버에만 2칸 싣는다 — 실장비는 빈 슬롯을 전부 나열하기도 하지만, 데모에서 전부 실으면
  //   부품 인벤토리가 '미상' 수천 행으로 덮인다. 빈 슬롯이 '빈 슬롯'(장애 아님)으로 분류되는 것은 그 2칸이면 보인다.
  }).filter((d, i) => d.sizeGB != null || (demoHash(`absent|${id}`) % 3 === 0 && i < dimmN + 2));
  inv.cpus = Array.from({ length: p.sockets }, (_, i) => ({
    socket: `CPU.Socket.${i + 1}`, model: p.cpuModel, manufacturer: /amd/i.test(p.cpuModel) ? 'AMD' : 'Intel',
    cores: p.coresPerSocket, threads: p.coresPerSocket * 2, maxSpeedMHz: 4000, health: 'OK', state: 'Enabled',
  }));
  inv.gpus = p.gpus.map((m, i) => ({ name: `Video.Slot.${i + 2}-1`, model: m, manufacturer: 'NVIDIA Corporation', health: 'OK', state: 'Enabled' }));
  const fast = p.kind === 'baremetal' && demoHash(`nic|${id}`) % 3 === 0 ? 'Mellanox ConnectX-6 Dx Dual Port 100GbE QSFP56' : 'Broadcom Adv. Dual 25Gb Ethernet';
  const fastMb = /100GbE/.test(fast) ? 100000 : 25000;
  inv.nics = [
    { name: 'NIC.Embedded.1', model: 'Broadcom Gigabit Ethernet BCM5720', partNumber: '0JH3NF', serial: `CN${String(demoHash(`n1|${id}`)).slice(0, 8)}`, firmware: '22.31.6',
      ports: [1, 2].map((k) => ({ id: `NIC.Embedded.1-${k}-1`, link: k === 1 ? 'Up' : 'Down', speedMbps: 1000, mac: macOf(`${id}|e${k}`) })) },
    { name: 'NIC.Slot.1', model: fast, partNumber: '0F6FXM', serial: `CN${String(demoHash(`n2|${id}`)).slice(0, 8)}`, firmware: '22.31.6',
      ports: [1, 2].map((k) => ({ id: `NIC.Slot.1-${k}-1`, link: 'Up', speedMbps: fastMb, mac: macOf(`${id}|s${k}`) })) },
  ];
  inv.fans = Array.from({ length: 6 }, (_, i) => ({
    name: `System Board Fan${i + 1}A`, model: '', partNumber: '', manufacturer: '',
    health: plan.fan && i === 3 ? plan.fan : 'OK', redundant: true,
  }));
  inv.pcie = [
    { name: 'BOSS-S2 Adapter', model: 'BOSS-S2', manufacturer: 'DELL', deviceType: 'SingleFunction', firmware: '2.5.13.4008', health: 'OK' },
    { name: fast, model: fast, manufacturer: /Mellanox/.test(fast) ? 'Mellanox Technologies' : 'Broadcom Inc.', deviceType: 'MultiFunction', firmware: '22.31.6', health: 'OK' },
    ...(p.kind === 'esxi' ? [{ name: 'Emulex LPe35002 32Gb 2-Port PCIe Fibre Channel Adapter', model: 'LPe35002', manufacturer: 'Emulex Corporation', deviceType: 'MultiFunction', firmware: '12.8.351.40', health: 'OK' }] : []),
    ...p.gpus.map((m) => ({ name: m, model: m, manufacturer: 'NVIDIA Corporation', deviceType: 'SingleFunction', firmware: '94.00.5F.00.01', health: 'OK' })),
  ];
  inv.health = {
    overall: sysHealth, processor: 'OK', memory: inv.memory.health,
    storage: inv.disks.some((d) => d.health !== 'OK') ? 'Warning' : 'OK',
    psu: inv.psus.some((x) => x.health !== 'OK') ? 'Warning' : 'OK',
    fan: inv.fans.some((x) => x.health !== 'OK') ? 'Warning' : 'OK', battery: 'OK',
    ...(inv.gpus.length ? { gpu: 'OK' } : {}),
  };
  inv.events = [];
  if (plan.psu) inv.events.push({ severity: 'Critical', created: new Date(now - 3 * HOUR).toISOString(), message: 'The power input for power supply 2 is lost.' });
  if (plan.fan) inv.events.push({ severity: 'Critical', created: new Date(now - 40 * MIN).toISOString(), message: 'Fan 4A RPM is less than the lower critical threshold.' });
  if (plan.disk) inv.events.push({ severity: 'Warning', created: new Date(now - 26 * HOUR).toISOString(), message: `Predictive failure reported for Solid State Disk 0:1:${diskN - 1}.` });
  if (plan.dimm) inv.events.push({ severity: 'Warning', created: new Date(now - 9 * HOUR).toISOString(), message: 'Correctable memory error rate exceeded for DIMM A4.' });
  inv.licenses = [{ name: p.license === 'datacenter' ? 'iDRAC9 Datacenter License' : 'iDRAC9 Enterprise License', type: 'Production', entitlement: `ENT${String(demoHash(`lic|${id}`)).slice(0, 8)}`, expiry: '' }];
  inv.idracUsers = [{ id: '2', userName: 'root', role: 'Administrator', enabled: true }, { id: '3', userName: 'monitor', role: 'ReadOnly', enabled: true }];
  inv.firmware = [
    { name: 'BIOS', version: bios, updateable: true, type: 'BIOS' },
    { name: 'Integrated Dell Remote Access Controller', version: idracFw, updateable: true, type: 'iDRAC' },
    { name: 'Dell 64 Bit uEFI Diagnostics', version: '4301A73', updateable: true, type: 'Other' },
    { name: 'BOSS-S2', version: '2.5.13.4008', updateable: true, type: 'Storage' },
    { name: `Broadcom Gigabit Ethernet BCM5720 - ${macOf(`${id}|e1`)}`, version: '22.31.6', updateable: true, type: 'NIC' },
    { name: 'PS1 Power Supply', version: '00.1D.7D', updateable: true, type: 'PSU' },
  ];
  return inv;
}

/* ───────────────────────── 베어메탈 시드(ESXi 아님) · 서비스태그 보정 ───────────────────────── */

export const BM_PREFIX = 'mock-bmsrv-';

const ROLES = [
  { suffix: 'db', model: 'PowerEdge R750', cpuModel: 'Intel(R) Xeon(R) Gold 6342 CPU @ 2.80GHz', sockets: 2, cores: 48, memGB: 1024, gpus: [], loadBase: 45 },
  { suffix: 'app', model: 'PowerEdge R650', cpuModel: 'Intel(R) Xeon(R) Silver 4314 CPU @ 2.40GHz', sockets: 2, cores: 32, memGB: 256, gpus: [], loadBase: 25 },
  { suffix: 'gpu', model: 'PowerEdge R750xa', cpuModel: 'Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz', sockets: 2, cores: 64, memGB: 1024, gpus: null, loadBase: 60 },
];

/**
 * 스냅샷의 vCenter 들에서 베어메탈 사양을 결정적으로 만든다 — vCenter 마다 DB 서버 1대 · 앞 4곳은 GPU 서버 1대 ·
 * 앞 2곳은 법인 귀속 없는 앱 서버 1대(11 vCenter 기준 17대).
 * @returns {Array<{id,name,vcenterId,homeVc,host,serviceTag,model,cpuModel,sockets,cores,memGB,gpus:string[],loadBase}>}
 */
export function demoBareMetalSpecs(snapshot) {
  const vcs = (snapshot?.vcenters || []).map((v) => v.id).filter(Boolean).slice(0, 20);
  const out = [];
  vcs.forEach((vc, vi) => {
    const city = String(vc).replace(/^vc-/, '');
    ROLES.forEach((r, i) => {
      if (r.suffix === 'gpu' && vi >= 4) return;
      if (r.suffix === 'app' && vi >= 2) return;
      const id = `${BM_PREFIX}${vc}-${r.suffix}01`;
      const gpuModel = ['NVIDIA A100 80GB PCIe', 'NVIDIA L40S', 'NVIDIA H100 80GB'][demoHash(id) % 3];
      out.push({
        // app 서버는 법인(vCenter) 귀속 없이 둔다 — '법인 귀속 없음' 경로(사용률 수집의 귀속 없는 서버 포함·화면 사유)도 보이게.
        id, name: `bm-${city}-${r.suffix}01`, vcenterId: r.suffix === 'app' ? '' : vc, homeVc: vc,
        host: demoIp(`bm|${id}`, 10), serviceTag: mockServiceTag(id),
        model: r.model, cpuModel: r.cpuModel, sockets: r.sockets, cores: r.cores, memGB: r.memGB,
        gpus: r.gpus || Array.from({ length: 2 + (demoHash(id) % 3) }, () => gpuModel),
        loadBase: r.loadBase + (demoHash(`lb|${id}`) % 20) - 10 + i,
      });
    });
  });
  return out;
}

let _specCache = new Map();
/** 등록부 id → 베어메탈 사양(데모로 시드한 것만). */
export function bareMetalSpecOf(id) { return _specCache.get(String(id)) || null; }
/** 사양 캐시를 스냅샷에서 채운다(재시작 직후 첫 틱에도 베어메탈 프로필이 같게). 스냅샷이 비면 건드리지 않는다. */
export function primeBareMetalSpecs(snapshot) {
  const specs = demoBareMetalSpecs(snapshot);
  if (specs.length) _specCache = new Map(specs.map((s) => [s.id, s]));
  return specs.length;
}

let _seedDone = false;
/**
 * 베어메탈 시드 — mock 이고, 등록부가 mock 항목뿐이고, `mock-bmsrv-` 가 하나도 없을 때만 1회.
 * 사양 캐시는 매번 채운다(재시작 뒤에도 프로필이 같게).
 */
export async function ensureBareMetalSeed(snapshot) {
  if (!isMockMode()) return { skipped: 'not-mock' };
  const specs = demoBareMetalSpecs(snapshot);
  if (!specs.length) return { skipped: 'no-snapshot' };
  primeBareMetalSpecs(snapshot);
  if (_seedDone) return { skipped: 'done' };
  const { loadRegistry, addServer } = await import('../../idrac/registry.js');
  const reg = loadRegistry();
  _seedDone = true;
  if (reg.some((s) => !String(s.id).startsWith('mock-'))) return { skipped: 'real-entries' };
  if (reg.some((s) => String(s.id).startsWith(BM_PREFIX))) return { skipped: 'exists' };
  let n = 0;
  for (const s of specs) {
    const r = addServer({ id: s.id, name: s.name, host: s.host, username: 'root', password: 'mock', vcenterId: s.vcenterId, serviceTag: s.serviceTag, hostNames: [s.name] });
    if (r?.ok) n += 1;
  }
  // 전력 이력은 idrac.js backfillPower 가 서버마다(이력이 없는 서버만) 채운다.
  if (n) console.log(`[mock] 베어메탈 데모 시드: iDRAC 등록 ${n}대(ESXi 아님)`);
  return { added: n };
}

let _tagRepaired = false;
/**
 * seed.js 초판의 서비스태그 충돌 1회 보정 — `mock-` 항목 중 태그가 겹치는 것만 고유 태그로 바꾼다(실등록은 건드리지 않는다).
 * @returns {Promise<{fixed:number}|{skipped:string}>}
 */
export async function repairMockServiceTags() {
  if (!isMockMode()) return { skipped: 'not-mock' };
  if (_tagRepaired) return { skipped: 'done' };
  _tagRepaired = true;
  const { loadRegistry, updateServer } = await import('../../idrac/registry.js');
  const reg = loadRegistry().filter((s) => String(s.id).startsWith('mock-'));
  const count = new Map();
  for (const s of reg) { const t = String(s.serviceTag || '').toUpperCase(); if (t) count.set(t, (count.get(t) || 0) + 1); }
  let fixed = 0;
  for (const s of reg) {
    const t = String(s.serviceTag || '').toUpperCase();
    if (t && count.get(t) > 1) {
      const r = updateServer(s.id, { serviceTag: mockServiceTag(`${s.vcenterId}|${s.name}`) });
      if (r?.ok) fixed += 1;
    }
  }
  if (fixed) console.log(`[mock] iDRAC 데모 서비스태그 충돌 보정: ${fixed}대`);
  return { fixed };
}

/* ───────────────────────── 폴 틱 + 백필 ───────────────────────── */

let _sensorBackfilled = false;   // 인메모리 sensorStore — 재시작마다 24시간 다시 채운다(가볍다)
let _metricsBackfill = null;     // 진행 중 프라미스(기동 1회)
let _powerBackfill = null;
const _invVersion = new Map();   // id → 장애 계획 서명(바뀌면 인벤토리를 즉시 다시 만든다 — 전이 이벤트가 생기게)

/** 등록부의 mock 서버 + 프로필(ESXi 호스트·베어메탈 사양 결합). 실등록(`mock-` 아님)은 제외한다. */
export async function demoServers(snapshot) {
  const { loadRegistry } = await import('../../idrac/registry.js');
  primeBareMetalSpecs(snapshot);
  const hostsByKey = new Map((snapshot?.hosts || []).map((h) => [`${h.vcenterId}|${String(h.name).toLowerCase()}`, h]));
  const out = [];
  for (const s of loadRegistry()) {
    if (!s || s.type === 'ome' || !String(s.id).startsWith('mock-') || s.enabled === false) continue;
    const spec = bareMetalSpecOf(s.id);
    const host = spec ? null : hostsByKey.get(`${s.vcenterId}|${String((s.hostNames || [])[0] || s.name).toLowerCase()}`) || null;
    out.push({ server: s, profile: demoServerProfile(s, { host, spec }) });
  }
  return out;
}

/**
 * mock 폴 틱 — idrac/poller.js 의 mock 분기에서 mockIdracPollTick(전력) 뒤에 부른다.
 * @returns {Promise<null|{servers:number, inventoryRefreshed:number, demo:true}>}
 */
export async function mockIdracDemoTick(snapshot, { now = Date.now() } = {}) {
  if (!isMockMode()) return null;
  await repairMockServiceTags();
  await ensureBareMetalSeed(snapshot);
  const list = await demoServers(snapshot);
  if (!list.length) return { servers: 0, inventoryRefreshed: 0, demo: true };
  const [{ pushSensorSample, markSensorPollStart, setSensorPollCycle }, { setThermalDetail, setSensorCollection, sensorCollectionStale }, { setInventory, inventoryStale, getInventory }] = await Promise.all([
    import('../../idrac/sensorStore.js'), import('../../idrac/sensorDetailCache.js'), import('../../idrac/invCache.js'),
  ]);
  markSensorPollStart(now);
  if (!_sensorBackfilled) {
    _sensorBackfilled = true;
    // 24시간 · 5분 간격 — 서버 상세 센서 탭·스파크라인이 기동 직후부터 그려지게(실장비 폴러는 1분마다 쌓는다).
    for (let t = now - DAY; t < now - 4 * MIN; t += 5 * MIN) {
      for (const { server, profile } of list) {
        const r = demoSensorReadingAt(profile, t);
        pushSensorSample(server.id, { t, cpuUsagePct: r.cpuUsagePct, temps: r.temps, fans: r.fans });
      }
    }
  }
  let refreshed = 0;
  for (const { server, profile } of list) {
    const r = demoSensorReadingAt(profile, now);
    pushSensorSample(server.id, { t: now, cpuUsagePct: r.cpuUsagePct, temps: r.temps, fans: r.fans });
    setThermalDetail(server.id, demoThermalDetail(r), now);
    if (sensorCollectionStale(server.id, INVENTORY_MAX_AGE_MS)) setSensorCollection(server.id, demoSensorCollection(profile, now), now);
    const sig = JSON.stringify(demoFaultPlan(server.id, now));
    const old = getInventory(server.id);
    if (inventoryStale(server.id, INVENTORY_MAX_AGE_MS) || _invVersion.get(server.id) !== sig || old?.system?.serviceTag !== server.serviceTag) {
      setInventory(server.id, demoInventory(server, profile, now));
      _invVersion.set(server.id, sig);
      refreshed += 1;
    }
  }
  setSensorPollCycle({ durationMs: 1_000, intervalMs: 60_000, at: now });
  if (refreshed) { try { const { onSnapshotRefreshed } = await import('../../partfault/hooks.js'); onSnapshotRefreshed('idrac'); } catch { /* */ } }
  // 장기 이력 백필(기동 1회 · 이미 있으면 건너뜀). 기다리지 않는다 — 폴 틱을 붙잡지 않게.
  if (!_metricsBackfill) _metricsBackfill = backfillTrendMetrics(list, { now }).catch((e) => { console.warn(`[mock] iDRAC 추이 백필 실패: ${e?.message || e}`); });
  if (!_powerBackfill) _powerBackfill = backfillPower(list, { now }).catch((e) => { console.warn(`[mock] iDRAC 전력 백필 실패: ${e?.message || e}`); });
  return { servers: list.length, inventoryRefreshed: refreshed, demo: true };
}

const yieldNow = () => new Promise((r) => setImmediate(r));

/** 백필 시각 목록 — 최근 24시간은 5분, 그 앞 13일은 1시간(시간당 롤업이 채워지게). 오름차순. */
export function backfillTimes(now = Date.now(), { recentStepMs = 5 * MIN, days = 14 } = {}) {
  const out = [];
  const start = Math.floor((now - days * DAY) / HOUR) * HOUR + 30 * MIN;
  for (let t = start; t < now - DAY; t += HOUR) out.push(t);
  for (let t = Math.ceil((now - DAY) / recentStepMs) * recentStepMs; t < now - 5 * MIN; t += recentStepMs) out.push(t);
  return out;
}

/**
 * metrics DB 백필 — 통합 추이(idracusage_cpu*·idractemp_*·idractrend_*)·서버 온도(idractemp_max)·법인 전산실 온도(roomtemp_*).
 * 행 계산은 **실제 샘플러가 쓰는 순수 함수**(buildServerTempRows·buildServerTrendRows·roomTempReport)를 그대로 부른다 —
 * 과거 시각의 표본을 원격 서버 모양(`remote:true, sensors`)으로 넣으면 같은 판정을 탄다.
 */
export async function backfillTrendMetrics(list, { now = Date.now() } = {}) {
  if (!isMockMode() || !list.length) return { skipped: 'empty' };
  const { getMetricsDb } = await import('../../metrics/db.js');
  const db = await getMetricsDb();
  if (!db || typeof db.insertMany !== 'function') return { skipped: 'no-db' };
  const probe = list[0].server.id;
  try {
    const have = db.historyRollup ? db.historyRollup('idractemp_max', probe, now - 13 * DAY, HOUR, 5) : [];
    if (have && have.length >= 3) return { skipped: 'exists' };
  } catch { /* 확인 실패 — 백필 진행 */ }
  const [{ buildServerTempRows }, { buildServerTrendRows, CPU_FALLBACK_METRICS }, { roomTempReport }, { roomTempMetric }, { analysisServersWithRemote }] = await Promise.all([
    import('../../idrac/serverTempSeries.js'), import('../../idrac/serverTrendSeries.js'), import('../../idrac/roomTemp.js'),
    import('../../idrac/roomTempSeries.js'), import('../../insights/analysisServers.js'),
  ]);
  const prof = new Map(list.map((x) => [String(x.server.id), x.profile]));
  const base = analysisServersWithRemote().filter((s) => prof.has(String(s.id)));
  let steps = 0; let rowsN = 0;
  for (const t of backfillTimes(now)) {
    const fake = base.map((s) => {
      const r = demoSensorReadingAt(prof.get(String(s.id)), t);
      const temps = Object.fromEntries(r.temps.map((x) => [x.name, x.celsius]));
      return { ...s, remote: true, sensors: { t, cpu: r.cpuUsagePct, temps, fans: {} } };
    });
    const latestOf = (s) => s.sensors;
    const rows = buildServerTempRows(fake, { now: t, latestOf, localCycle: null }).rows;
    pushAll(rows, buildServerTrendRows(fake, { now: t, latestOf, localCycle: null, cpuIndex: null, detailOf: () => null }));
    // Enterprise 라이선스 서버는 텔레메트리가 없다 — 실장비에서는 Sensors 컬렉션의 CPU Usage 센서(idracusage_cpu_rs)로 온다.
    for (const s of fake) {
      const p = prof.get(String(s.id));
      if (p.license !== 'datacenter') rows.push({ metric: CPU_FALLBACK_METRICS.sensor, k: String(s.id), v: Math.round(demoLoadAt(p, t)) });
    }
    const rep = roomTempReport(fake, { now: t, localCycle: null });
    const push = (k, kind, agg) => {
      if (!agg || agg.avg == null) return;
      rows.push({ metric: roomTempMetric(kind, 'avg'), k, v: agg.avg });
      if (agg.max != null) rows.push({ metric: roomTempMetric(kind, 'max'), k, v: agg.max });
    };
    for (const g of rep.groups || []) { push(g.id, 'inlet', g.inlet); push(g.id, 'exhaust', g.exhaust); push(g.id, 'cpu', g.cpu); }
    push('', 'inlet', rep.totals?.inlet); push('', 'exhaust', rep.totals?.exhaust); push('', 'cpu', rep.totals?.cpu);
    if (rows.length) { db.insertMany(rows, t); rowsN += rows.length; }
    steps += 1;
    if (steps % 4 === 0) await yieldNow();
  }
  console.log(`[mock] iDRAC 추이 데모 백필: ${base.length}대 · ${steps}시점 · ${rowsN}행(14일)`);
  return { steps, rows: rowsN, servers: base.length };
}

/**
 * 전력 DB 백필 — 14일(최근 24시간 10분 · 그 앞 1시간). **서버마다** 이력이 없을 때만(나중에 시드된 베어메탈도 채우게). 1회.
 */
export async function backfillPower(list, { now = Date.now() } = {}) {
  if (!isMockMode() || !list.length) return { skipped: 'empty' };
  const { getDb } = await import('../../idrac/db.js');
  const db = await getDb();
  const need = list.filter(({ server }) => {
    try { const st = db.hourlyStats ? db.hourlyStats(server.id, now - 14 * DAY, now - 2 * DAY) : []; return !(st && st.length >= 3); } catch { return true; }
  });
  if (!need.length) return { skipped: 'exists' };
  const samples = [];
  for (const t of backfillTimes(now, { recentStepMs: 10 * MIN })) {
    for (const { server, profile } of need) samples.push({ serverId: server.id, watts: Math.round(demoWatts(profile, demoLoadAt(profile, t))), ts: t });
  }
  try { db.insertMany(samples); } catch (e) { return { error: String(e?.message || e) }; }
  console.log(`[mock] iDRAC 전력 데모 백필: ${need.length}대 · ${samples.length}표본(14일)`);
  return { samples: samples.length, servers: need.length };
}

/**
 * 지금 전력 — seed.js mockIdracPollTick 이 부른다(백필과 같은 곡선이라 '지금' 에서 값이 튀지 않게).
 * @returns {Promise<Map<string, number>>} 서버 id → W (mock 항목만)
 */
export async function demoPowerNow(snapshot, now = Date.now()) {
  const out = new Map();
  if (!isMockMode()) return out;
  for (const { server, profile } of await demoServers(snapshot)) {
    const w = demoWatts(profile, demoLoadAt(profile, now)) * (1 + (demoRand(`${server.id}|pw|${Math.floor(now / MIN)}`) - 0.5) * 0.04);
    out.set(String(server.id), Math.round(w));
  }
  return out;
}

/** 부하 → 소비 전력(W) — 모델·GPU 수 기준(seed.js baseWatts 와 같은 대역). */
export function demoWatts(p, load) {
  const base = /R760|R750xa/.test(p.model) ? 420 : /R750/.test(p.model) ? 360 : 300;
  return base + load * 2.6 + p.gpus.length * (60 + load * 1.8);
}

export function _resetBareMetalSeedForTest() { _specCache = new Map(); _seedDone = false; _tagRepaired = false; }
export function _resetIdracDemoForTest() { _sensorBackfilled = false; _metricsBackfill = null; _powerBackfill = null; _invVersion.clear(); }
