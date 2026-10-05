// VM 구성 속성(B10, v2.697) — 순수 파서·판정. 수집(vcenter/soapClient.js)·엣지 수신 정제(central)·화면 판정이
// 같은 모양을 쓰도록 이 모듈 하나가 소유한다.
//
// 모양(vm.cfg — 없으면 그 수집기가 이 값을 아직 읽지 않았다 = '미수집'):
//   { at, consolidationNeeded, cbt, cpuHotAdd, memHotAdd, cpuReservationMhz, cpuLimitMhz, memReservationMB, memLimitMB,
//     firmware, guestIdConfig, guestIdTools, guestNameTools, guestHostName, bootTime, managedBy:{extensionKey,type}|null,
//     question:{text}|null }
//   - 불리언·수치는 **못 읽으면 null**(false·0 이 아니다 — 0 은 '예약 없음' 이라는 값이다).
//   - limit 의 -1(무제한)은 null 이 아니라 'unlimited' 를 뜻하므로 그대로 -1 로 둔다(화면이 '무제한' 으로 말한다).
//   - managedBy·question·bootTime 은 **설정되지 않은 것이 정상**이라 응답에 없으면 null(=없음)이다.
// 모양(vm.dev — 장치 위생 요약, 장치 목록을 읽었을 때만):
//   { at, cdroms:[{label,connected,startConnected,iso,host,file}], floppies:[{label,connected}],
//     disks:[{label,mode,sharing,rdm,rdmMode,datastore,capacityGB}], usb, serial, parallel, omitted }
import { xmlUnescape } from '../vcenter/soapParse.js';

/** 이 모듈이 vCenter 에 요청하는 VM 속성 경로 — 전부 vSphere 5.0+ 에 있는 경로만(없는 경로는 요청 전체를 InvalidProperty 로 만든다). */
export const VM_CFG_PATHS = Object.freeze([
  'runtime.consolidationNeeded', 'config.changeTrackingEnabled', 'config.cpuHotAddEnabled', 'config.memoryHotAddEnabled',
  'config.cpuAllocation.reservation', 'config.cpuAllocation.limit', 'config.memoryAllocation.reservation', 'config.memoryAllocation.limit',
  'config.firmware', 'config.guestId', 'guest.guestId', 'guest.guestFullName', 'guest.hostName', 'runtime.bootTime',
  'config.managedBy', 'runtime.question',
]);
export const VM_DEV_PATHS = Object.freeze(['config.hardware.device']);

const TEXT_MAX = 256;
const cap = (s, n = TEXT_MAX) => {
  if (s == null) return null;
  const t = String(s).trim();
  return t ? (t.length > n ? t.slice(0, n) : t) : null;
};
function boolOf(v) {
  if (v === true || v === false) return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}
function intOf(v) {
  if (v == null || v === '' || typeof v === 'object') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  const s = String(v).trim();
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}
const tag = (xml, name) => {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml || '');
  return m ? xmlUnescape(m[1]) : null;
};

/**
 * RetrieveProperties 결과의 props 맵 → vm.cfg. `fetched` 는 '이 VM 의 cfg 경로를 요청했다' 이다 —
 * 요청했는데 응답에 없는 불리언은 못 읽은 것(null)이고, managedBy·question·bootTime 은 '없음'(null)이다.
 */
export function parseVmCfgProps(props = {}, at = Date.now()) {
  const p = props || {};
  const managedRaw = typeof p['config.managedBy'] === 'string' ? p['config.managedBy'] : '';
  const qRaw = typeof p['runtime.question'] === 'string' ? p['runtime.question'] : '';
  const boot = p['runtime.bootTime'];
  const bootMs = typeof boot === 'string' && boot ? Date.parse(boot) : NaN;
  const fw = cap(p['config.firmware'], 16);
  return {
    at,
    consolidationNeeded: boolOf(p['runtime.consolidationNeeded']),
    cbt: boolOf(p['config.changeTrackingEnabled']),
    cpuHotAdd: boolOf(p['config.cpuHotAddEnabled']),
    memHotAdd: boolOf(p['config.memoryHotAddEnabled']),
    cpuReservationMhz: intOf(p['config.cpuAllocation.reservation']),
    cpuLimitMhz: intOf(p['config.cpuAllocation.limit']),
    memReservationMB: intOf(p['config.memoryAllocation.reservation']),
    memLimitMB: intOf(p['config.memoryAllocation.limit']),
    firmware: fw ? fw.toLowerCase() : null,
    guestIdConfig: cap(p['config.guestId'], 64),
    guestIdTools: cap(p['guest.guestId'], 64),
    guestNameTools: cap(p['guest.guestFullName'], 128),
    guestHostName: cap(p['guest.hostName'], 128),
    bootTime: Number.isFinite(bootMs) ? bootMs : null,
    managedBy: managedRaw ? { extensionKey: cap(tag(managedRaw, 'extensionKey'), 128), type: cap(tag(managedRaw, 'type'), 64) } : null,
    question: qRaw ? { text: cap(tag(qRaw, 'text'), 512) } : null,
  };
}

const DEV_LIST_MAX = 32;
/** 'config.hardware.device' XML → 장치 위생 요약(vm.dev). 목록은 종류마다 32개까지이고 넘친 개수는 omitted. */
export function parseVmDeviceHygiene(deviceXml, at = Date.now()) {
  const out = { at, cdroms: [], floppies: [], disks: [], usb: 0, serial: 0, parallel: 0, omitted: 0 };
  if (typeof deviceXml !== 'string' || !deviceXml) return out;
  const push = (arr, v) => { if (arr.length < DEV_LIST_MAX) arr.push(v); else out.omitted += 1; };
  for (const blk of deviceXml.split(/<VirtualDevice(?=[ >])/).slice(1)) {
    const xsiType = /^[^>]*xsi:type="([^"]+)"/.exec(blk)?.[1] || '';
    const label = cap(tag(blk, 'label'), 64) || '';
    const backingType = /<backing xsi:type="([^"]+)"/.exec(blk)?.[1] || '';
    const conn = /<connectable>([\s\S]*?)<\/connectable>/.exec(blk)?.[1] || '';
    const connected = conn ? /<connected>true<\/connected>/.test(conn) : null;
    const startConnected = conn ? /<startConnected>true<\/startConnected>/.test(conn) : null;
    if (xsiType === 'VirtualCdrom') {
      const iso = /IsoBackingInfo/.test(backingType);
      push(out.cdroms, {
        label, connected, startConnected, iso,
        host: /Atapi|Passthrough/.test(backingType) && !/Remote/.test(backingType),
        file: iso ? cap(tag(blk, 'fileName'), 256) : null,
      });
    } else if (xsiType === 'VirtualFloppy') {
      push(out.floppies, { label, connected });
    } else if (xsiType === 'VirtualDisk') {
      const fileName = tag(blk, 'fileName') || '';
      const capKB = intOf(tag(blk, 'capacityInKB'));
      push(out.disks, {
        label,
        mode: cap(tag(blk, 'diskMode'), 32),
        sharing: cap(tag(blk, 'sharing'), 32),
        rdm: /RawDiskMapping/i.test(backingType),
        rdmMode: /RawDiskMapping/i.test(backingType) ? cap(tag(blk, 'compatibilityMode'), 32) : null,
        datastore: /^\[([^\]]+)\]/.exec(fileName)?.[1] || null,
        capacityGB: capKB == null ? null : Math.round((capKB / 1048576) * 10) / 10,
      });
    } else if (/^VirtualUSB/.test(xsiType) && xsiType !== 'VirtualUSBController' && !/Controller$/.test(xsiType)) {
      out.usb += 1;
    } else if (xsiType === 'VirtualSerialPort') {
      out.serial += 1;
    } else if (xsiType === 'VirtualParallelPort') {
      out.parallel += 1;
    }
  }
  return out;
}

/** VM 이름과 게스트 hostname 비교용 짧은 이름 — 소문자 · 첫 '.' 앞. IP 처럼 보이면 비교하지 않는다(null). */
export function shortName(s) {
  if (s == null) return null;
  const t = String(s).trim().toLowerCase();
  if (!t || /^\d{1,3}(\.\d{1,3}){3}$/.test(t) || t.includes(':')) return null;
  return t.split('.')[0] || null;
}

/** guestId 정규화 — 'rhel8_64Guest' 와 'rhel8_64guest' 를 같게. 접미 'Guest' 를 뗀다. */
const normGuestId = (s) => (s ? String(s).toLowerCase().replace(/guest$/, '') : null);

/** 판정 코드 → 심각도. 화면 문구는 웹 vmCfgText.js 가 같은 키로 소유한다(1:1 테스트). */
export const VM_CFG_CODES = Object.freeze({
  question: 'crit',
  consolidation: 'warn',
  'disk-nonpersistent': 'warn',
  'cpu-limit': 'warn',
  'mem-limit': 'warn',
  'cdrom-connected': 'warn',
  'guestos-mismatch': 'warn',
  'disk-independent': 'info',
  'multi-writer': 'info',
  'rdm-physical': 'info',
  'cbt-off': 'info',
  floppy: 'info',
  reservation: 'info',
  'hostname-mismatch': 'info',
  managed: 'info',
});

/**
 * VM 하나의 판정 목록. vm.cfg/vm.dev 가 없으면 그 축은 **판정하지 않는다**(빈 결과가 '이상 없음' 이 아니라
 * '미수집' 이라는 사실은 호출부가 cfg/dev 존재로 말한다). 템플릿은 CD-ROM·질문 대기 판정을 하지 않는다.
 * @returns {{code:string, sev:string, facts:object}[]}
 */
export function vmCfgFindings(vm) {
  const out = [];
  const add = (code, facts = {}) => out.push({ code, sev: VM_CFG_CODES[code], facts });
  const c = vm?.cfg && typeof vm.cfg === 'object' ? vm.cfg : null;
  const d = vm?.dev && typeof vm.dev === 'object' ? vm.dev : null;
  const template = vm?.template === true;
  if (c) {
    if (c.question && !template) add('question', { text: c.question.text || null });
    if (c.consolidationNeeded === true) add('consolidation');
    if (c.cpuLimitMhz != null && c.cpuLimitMhz >= 0) add('cpu-limit', { mhz: c.cpuLimitMhz });
    if (c.memLimitMB != null && c.memLimitMB >= 0) add('mem-limit', { mb: c.memLimitMB });
    if ((c.cpuReservationMhz || 0) > 0 || (c.memReservationMB || 0) > 0) add('reservation', { cpuMhz: c.cpuReservationMhz, memMB: c.memReservationMB });
    if (c.cbt === false && !template) add('cbt-off');
    const gc = normGuestId(c.guestIdConfig); const gt = normGuestId(c.guestIdTools);
    if (gc && gt && gc !== gt) add('guestos-mismatch', { config: c.guestIdConfig, tools: c.guestIdTools });
    const hn = shortName(c.guestHostName); const vn = shortName(vm?.name);
    if (hn && vn && hn !== vn) add('hostname-mismatch', { hostName: c.guestHostName });
    if (c.managedBy && (c.managedBy.extensionKey || c.managedBy.type)) add('managed', { ...c.managedBy });
  }
  if (d) {
    const cds = (d.cdroms || []).filter((x) => x && x.connected === true);
    if (cds.length && !template) add('cdrom-connected', { count: cds.length, iso: cds.filter((x) => x.iso).length, file: cds.find((x) => x.file)?.file || null });
    if ((d.floppies || []).length) add('floppy', { count: d.floppies.length });
    const disks = Array.isArray(d.disks) ? d.disks : [];
    const nonp = disks.filter((x) => /nonpersistent/i.test(x?.mode || ''));
    if (nonp.length) add('disk-nonpersistent', { count: nonp.length });
    const indep = disks.filter((x) => /^independent_persistent$/i.test(x?.mode || ''));
    if (indep.length) add('disk-independent', { count: indep.length });
    const mw = disks.filter((x) => /multiwriter/i.test(x?.sharing || ''));
    if (mw.length) add('multi-writer', { count: mw.length });
    const rdmP = disks.filter((x) => x?.rdm && /physical/i.test(x?.rdmMode || ''));
    if (rdmP.length) add('rdm-physical', { count: rdmP.length });
  }
  const order = { crit: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.sev] - order[b.sev]);
}

/* ───────── 엣지 수신 정제(central/inventory) — 아는 필드만 · 수치는 수 · 글자는 상한 ───────── */
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const boolOrNull = (v) => (v === true || v === false ? v : null);
const numInt = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : intOf(v));
const tsOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** 엣지가 보낸 vm.cfg → 같은 모양으로 다시 좁힌다. 모양이 아니면 null(= 모름). */
export function sanitizeVmCfg(c) {
  if (!isObj(c)) return null;
  const mb = isObj(c.managedBy) ? { extensionKey: cap(c.managedBy.extensionKey, 128), type: cap(c.managedBy.type, 64) } : null;
  return {
    at: tsOrNull(c.at),
    consolidationNeeded: boolOrNull(c.consolidationNeeded),
    cbt: boolOrNull(c.cbt),
    cpuHotAdd: boolOrNull(c.cpuHotAdd),
    memHotAdd: boolOrNull(c.memHotAdd),
    cpuReservationMhz: numInt(c.cpuReservationMhz),
    cpuLimitMhz: numInt(c.cpuLimitMhz),
    memReservationMB: numInt(c.memReservationMB),
    memLimitMB: numInt(c.memLimitMB),
    firmware: typeof c.firmware === 'string' ? cap(c.firmware, 16) : null,
    guestIdConfig: typeof c.guestIdConfig === 'string' ? cap(c.guestIdConfig, 64) : null,
    guestIdTools: typeof c.guestIdTools === 'string' ? cap(c.guestIdTools, 64) : null,
    guestNameTools: typeof c.guestNameTools === 'string' ? cap(c.guestNameTools, 128) : null,
    guestHostName: typeof c.guestHostName === 'string' ? cap(c.guestHostName, 128) : null,
    bootTime: tsOrNull(c.bootTime),
    managedBy: mb && (mb.extensionKey || mb.type) ? mb : null,
    question: isObj(c.question) ? { text: typeof c.question.text === 'string' ? cap(c.question.text, 512) : null } : null,
  };
}

/** 엣지가 보낸 vm.dev → 같은 모양으로 다시 좁힌다. */
export function sanitizeVmDev(d) {
  if (!isObj(d)) return null;
  const arr = (v) => (Array.isArray(v) ? v.filter(isObj).slice(0, DEV_LIST_MAX) : []);
  const cnt = (v) => { const n = numInt(v); return n != null && n >= 0 ? n : 0; };
  const str = (v, n) => (typeof v === 'string' ? cap(v, n) : null);
  return {
    at: tsOrNull(d.at),
    cdroms: arr(d.cdroms).map((x) => ({ label: str(x.label, 64) || '', connected: boolOrNull(x.connected), startConnected: boolOrNull(x.startConnected), iso: x.iso === true, host: x.host === true, file: str(x.file, 256) })),
    floppies: arr(d.floppies).map((x) => ({ label: str(x.label, 64) || '', connected: boolOrNull(x.connected) })),
    disks: arr(d.disks).map((x) => ({ label: str(x.label, 64) || '', mode: str(x.mode, 32), sharing: str(x.sharing, 32), rdm: x.rdm === true, rdmMode: str(x.rdmMode, 32), datastore: str(x.datastore, 128), capacityGB: typeof x.capacityGB === 'number' && Number.isFinite(x.capacityGB) ? x.capacityGB : null })),
    usb: cnt(d.usb), serial: cnt(d.serial), parallel: cnt(d.parallel), omitted: cnt(d.omitted),
  };
}
