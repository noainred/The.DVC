/**
 * idrac/hwSummary.js — iDRAC 인벤토리 → **하드웨어 요약 · 상세**(순수 · v3.3.0 — 물리서버 폴더 표 요약 열 · 옆 패널 상세 · 엣지 fleet push).
 *
 * 판정을 새로 만들지 않는다:
 *   · 코어 · 소켓 · 메모리 = `physicalCapacity.js capacityOfInventory` 하나(통합 서버 인벤토리 내보내기 · 법인 사용률과 같은 값)
 *   · NIC 포트 중복 = `nicPorts.js dedupNics` · 링크 = `nicLinkState`
 *   · 컬렉션을 읽었는가 = `readInvArr`(못 읽은 컬렉션은 0 이 아니라 null — insights/hwExport/catalog.js 도 이 함수를 쓴다)
 * FC HBA 판정(`isFcHba`)만 여기서 새로 정한다 — Ethernet NIC 와 FC 어댑터가 둘 다 NetworkAdapters 에 나오므로 NIC 에서 FC 를 빼야 포트 수가 맞는다.
 * SAS HBA(HBA330 · HBA355i 등 내장 디스크용)는 스토리지 컨트롤러다(여기서 HBA 로 세지 않는다 — 상세의 컨트롤러 목록에 나온다).
 *
 * 값이 없으면 null(0 이 아니다 — CLAUDE.md '못 읽은 값은 0 이 아니다'). 요약은 엣지가 그대로 중앙에 보내는 계약이라
 * `sanitizeHwSummary` 가 받는 쪽 정제를 맡는다(아는 키만 · 수는 수로 · 글자 상한).
 */
import { numOrNull } from '../util/numOrNull.js';
import { capacityOfInventory } from './physicalCapacity.js';
import { dedupNics, nicLinkState } from './nicPorts.js';

const s = (v) => (v == null ? '' : String(v).trim());
const pos = (v) => { const x = numOrNull(v); return x != null && x > 0 ? x : null; };
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) : []);

/**
 * 그 컬렉션을 읽었는가(못 읽은 값은 0 이 아니다): redfish.js 는 배열을 먼저 [] 로 만들고 실패하면 collections.<키>='failed' 만 남긴다
 * — 배열 길이 0 을 그대로 세면 '읽지 못함' 이 '0개' 로 나간다. 배열이 없거나 'failed' 면 null.
 * emptyUnknown: 표식이 없는 컬렉션(NIC)은 빈 배열도 못 읽음으로 본다(NIC 0개 서버는 없다 — 구분할 근거가 없으면 지어내지 않는다).
 */
export function readInvArr(inv, key, { emptyUnknown = false } = {}) {
  if (!inv || !Array.isArray(inv[key])) return null;
  if (inv.collections && typeof inv.collections === 'object' && inv.collections[key] === 'failed') return null;
  const a = arr(inv[key]);
  return emptyUnknown && !a.length ? null : a;
}

/** FC HBA 인가 — 모델 · 이름 글자로(Redfish 에 'FC' 표준 필드가 컬렉션마다 다르다). Ethernet CNA(QLogic 57xxx · Emulex OneConnect)는 아니다. */
// QLogic 은 QLE2xxx 만 FC 다(QLE3242 · QLE3442 는 10GbE NIC, QLE8262 는 CNA — 반증 F6)
const FC_RE = /fibre\s*channel|\bfc\s*(hba|adapter)\b|\b(8|16|32|64|128)\s*(gb|g|gfc)\s*fc\b|\bqle\s?2\d{3}|\blpe\s?\d{4,5}/i;
export function isFcHba(x) {
  const txt = `${s(x?.model)} ${s(x?.name)}`.slice(0, 300);
  return !!txt.trim() && FC_RE.test(txt);
}

const SYNTH_NIC = '(EthernetInterfaces)';   // redfish.js 가 어댑터 응답에 속도가 하나도 없을 때만 붙이는 포트 폴백(실물 어댑터가 아니다)
const ethNics = (inv) => dedupNics(arr(inv?.nics)).filter((n) => !isFcHba(n));
/*
 * NIC 포트(반증 F4): 합성 '(EthernetInterfaces)' 는 실어댑터 포트에 속도가 하나도 없을 때만 붙는 **속도 폴백**이다 — 포트 수는 실어댑터에서만 센다
 * (둘을 더하면 같은 포트를 두 번 센다). 속도는 실어댑터 포트에 있으면 그것, 없으면 합성 포트의 속도. 실어댑터가 없으면 합성 포트가 곧 포트다.
 * 상세(hwDetailOf)도 같은 규칙 — 실어댑터가 없을 때만 합성 항목을 한 줄로 보인다(요약과 상세가 서로 다른 말을 하지 않게).
 */
function nicPortsOf(inv) {
  const all = ethNics(inv);
  const real = all.filter((n) => s(n.model) !== SYNTH_NIC);
  const synth = all.filter((n) => s(n.model) === SYNTH_NIC);
  const realPorts = real.flatMap((a) => arr(a.ports));
  const synthPorts = synth.flatMap((a) => arr(a.ports));
  if (!real.length) return { count: synthPorts, speed: synthPorts, adapters: synth };
  const realHasSpeed = realPorts.some((p) => pos(p.speedMbps) != null);
  return { count: realPorts, speed: realHasSpeed ? realPorts : synthPorts, adapters: real };
}
/** 빈 슬롯(Status.State 'Absent')은 부품이 아니다(반증 F5 — iLO 등이 빈 DIMM · CPU 슬롯을 컬렉션에 싣는다). */
const present = (list) => (list ? list.filter((x) => !/^absent$/i.test(s(x?.state))) : list);
/** 링크 속도(Mbps) → 표시 단위 Gbps(0.1 단위 반올림 — 100M/1G/10G/25G/100G). */
const gbpsOf = (mbps) => { const v = pos(mbps); return v == null ? null : Math.round(v / 100) / 10; };

/** 디스크 매체 — SSD · HDD(SMR 포함) · 모름. NVMe 는 인터페이스(protocol)로 따로 센다. */
function mediaOf(d) {
  const m = s(d?.media).toUpperCase();
  if (m === 'SSD') return 'ssd';
  if (m === 'HDD' || m === 'SMR') return 'hdd';
  return '';
}

/**
 * 요약(표 칸 · 엣지 push 계약). 인벤토리가 없으면 null.
 * @returns {null | { v:1, at:number|null,
 *   cpu:{sockets,cores,threads,model}|null, mem:{gib,dimms}|null, disk:{n,gb,ssd,hdd,nvme}|null,
 *   nic:{ports,up,maxGbps,speeds:[[gbps,n]]}|null, hba:{n,ports}|null, os:{name,ver}|null, host:string, fw:string }}
 */
export function hwSummaryOf(inv) {
  if (!inv || typeof inv !== 'object') return null;
  const cap = capacityOfInventory(inv);
  const cpuList = present(readInvArr(inv, 'cpus'));
  const cpuModel = s(inv.cpu?.model) || s(cpuList?.[0]?.model);
  const cpu = cap && (cap.sockets != null || cap.cores != null || cpuModel)
    ? { sockets: cap.sockets ?? null, cores: cap.cores ?? null, threads: cap.threads ?? null, model: cpuModel.slice(0, 128) }
    : null;
  const dimms = present(readInvArr(inv, 'memoryDimms'));
  const dimmGb = dimms && dimms.length ? dimms.reduce((a, m) => (a == null || pos(m.sizeGB) == null ? null : a + pos(m.sizeGB)), 0) : null;
  const gib = cap?.memGiB != null ? Math.round(cap.memGiB) : dimmGb;
  const mem = gib != null || dimms ? { gib: gib ?? null, dimms: dimms ? dimms.length : null } : null;
  const dl = present(readInvArr(inv, 'disks'));
  let disk = null;
  if (dl) {
    let gb = 0; let ssd = 0; let hdd = 0; let nvme = 0;
    for (const d of dl) {
      const c = pos(d.capacityGB);
      gb = gb == null || c == null ? null : gb + c;   // 하나라도 못 읽었으면 합은 null(부분 합을 전체처럼 보이지 않게)
      const md = mediaOf(d); if (md === 'ssd') ssd += 1; else if (md === 'hdd') hdd += 1;
      if (/nvme/i.test(s(d.protocol))) nvme += 1;
    }
    disk = { n: dl.length, gb: dl.length ? gb : 0, ssd, hdd, nvme };
  }
  const nicsRead = readInvArr(inv, 'nics', { emptyUnknown: true });
  let nic = null;
  if (nicsRead) {
    const np = nicPortsOf(inv);
    const bySpeed = new Map(); let maxMbps = null;
    for (const p of np.speed) {
      const g = gbpsOf(p.speedMbps);
      if (g != null) { bySpeed.set(g, (bySpeed.get(g) || 0) + 1); maxMbps = Math.max(maxMbps ?? 0, pos(p.speedMbps)); }
    }
    const up = np.count.filter((p) => nicLinkState(p.link) === 'up').length;
    nic = { ports: np.count.length, up, maxGbps: gbpsOf(maxMbps), speeds: [...bySpeed].sort((a, b) => b[0] - a[0]).slice(0, 3) };
  }
  const hba = hbaListOf(inv);
  const osName = s(inv.system?.osName); const osVer = s(inv.system?.osVersion);
  return {
    v: 1,
    at: pos(inv.collectedAt),
    cpu, mem, disk, nic,
    hba: hba ? { n: hba.length, ports: hba.reduce((a, h) => (a == null || h.ports == null ? null : a + h.ports), 0) } : null,
    os: osName || osVer ? { name: osName.slice(0, 128), ver: osVer.slice(0, 64) } : null,
    host: s(inv.system?.hostName).slice(0, 255),
    fw: s(inv.idrac?.firmwareVersion).slice(0, 64),
  };
}

/**
 * FC HBA 목록 — PCIe 카드(카드 하나 = 한 줄)를 먼저, PCIe 를 못 읽었거나 FC 카드가 없으면 NetworkAdapters 의 FC 어댑터.
 * 포트 수는 NetworkAdapters 의 같은 모델 어댑터 포트(없으면 null). 두 컬렉션을 모두 못 읽었으면 null(모름 — 0 이 아니다).
 */
export function hbaListOf(inv) {
  const pcie = readInvArr(inv, 'pcie');
  const nics = readInvArr(inv, 'nics', { emptyUnknown: true });
  if (!pcie && !nics) return null;
  const fcNics = dedupNics(arr(inv?.nics)).filter(isFcHba);
  const portsOf = (model) => { const n = fcNics.find((x) => s(x.model) && s(x.model) === s(model)); return n ? arr(n.ports).length || null : null; };
  // PCIe 는 Name 이 설명형(‘Emulex LPe35002 32Gb 2-Port … Fibre Channel Adapter’)이고 Model 은 짧거나 비어 있다 — 이름을 먼저
  const fromPcie = (pcie || []).filter(isFcHba).map((d) => ({ model: (s(d.name) || s(d.model)).slice(0, 128), ports: portsOf(d.model) }));
  const fromNics = fcNics.map((n) => ({ model: (s(n.model) || s(n.name)).slice(0, 128), ports: arr(n.ports).length || null }));
  // 카드 하나 = PCIe 한 줄 = NetworkAdapter 하나 — 수집기가 PCIe 를 앞 16개만 읽으므로 더 많이 본 쪽을 쓴다(반증 F7 — 같으면 PCIe: 이름이 설명형)
  return (fromPcie.length >= fromNics.length ? fromPcie : fromNics).slice(0, 16);
}

/** 같은 라벨끼리 묶어 개수(상세 목록 — 순서는 처음 나온 순). */
function groupBy(list, keyOf, make, max = 32) {
  const m = new Map();
  for (const x of list) { const k = keyOf(x); const g = m.get(k); if (g) g.n += 1; else m.set(k, { ...make(x), n: 1 }); }
  return [...m.values()].slice(0, max);
}

/**
 * 옆 패널 상세(요청 1건 — 목록에는 싣지 않는다). 주소(iDRAC 관리 NIC IPv4)는 `admin` 판본만.
 * 각 목록은 못 읽었으면 null, 읽었고 없으면 [].
 */
export function hwDetailOf(inv, { admin = false } = {}) {
  if (!inv || typeof inv !== 'object') return null;
  const cpus = present(readInvArr(inv, 'cpus'));
  const dimms = present(readInvArr(inv, 'memoryDimms'));
  const disks = present(readInvArr(inv, 'disks'));
  const ctrls = readInvArr(inv, 'storageControllers');
  const nicsRead = readInvArr(inv, 'nics', { emptyUnknown: true });
  const net = arr(inv.network);
  return {
    summary: hwSummaryOf(inv),
    cpus: cpus ? groupBy(cpus, (c) => `${s(c.model)}|${pos(c.cores)}|${pos(c.threads)}`, (c) => ({ model: s(c.model).slice(0, 128), cores: pos(c.cores), threads: pos(c.threads), mhz: pos(c.maxSpeedMHz) })) : null,
    dimms: dimms ? groupBy(dimms, (d) => `${pos(d.sizeGB)}|${s(d.type)}|${pos(d.speedMHz)}|${s(d.manufacturer)}`, (d) => ({ gb: pos(d.sizeGB), type: s(d.type).slice(0, 32), mhz: pos(d.speedMHz), maker: s(d.manufacturer).slice(0, 64) })) : null,
    disks: disks ? groupBy(disks, (d) => `${s(d.model)}|${pos(d.capacityGB)}|${s(d.media)}|${s(d.protocol)}`, (d) => ({ model: s(d.model).slice(0, 128), gb: pos(d.capacityGB), media: s(d.media).slice(0, 16), proto: s(d.protocol).slice(0, 16) })) : null,
    ctrls: ctrls ? groupBy(ctrls, (c) => s(c.model) || s(c.name), (c) => ({ model: (s(c.model) || s(c.name)).slice(0, 128), fw: s(c.firmware).slice(0, 64) }), 8) : null,
    nics: nicsRead ? nicPortsOf(inv).adapters.map((n) => {
      const ports = arr(n.ports);
      const speeds = [...new Set(ports.map((p) => gbpsOf(p.speedMbps)).filter((g) => g != null))].sort((a, b) => b - a);
      return { model: (s(n.model) || s(n.name)).slice(0, 128), ports: ports.length, up: ports.filter((p) => nicLinkState(p.link) === 'up').length, speeds: speeds.slice(0, 3) };
    }).slice(0, 16) : null,
    hbas: hbaListOf(inv),
    os: { name: s(inv.system?.osName).slice(0, 128), ver: s(inv.system?.osVersion).slice(0, 64), host: s(inv.system?.hostName).slice(0, 255) },
    idrac: {
      fw: s(inv.idrac?.firmwareVersion).slice(0, 64), model: s(inv.idrac?.model).slice(0, 64),
      ...(admin ? { ipv4: s(net.find((e) => s(e.ipv4))?.ipv4).slice(0, 64) } : {}),
    },
    at: pos(inv.collectedAt),
  };
}

/**
 * 관리 주소(iDRAC) → 호스트만(스킴 · 경로를 뗀다 — ‘https://10.0.0.5:443/x’ → ‘10.0.0.5:443’). 정규식 반복 없이 길이를 먼저 자른다.
 * 호스트 글자(영숫자 · . - _ : [ ])가 아니면 ''(엣지가 보낸 값 · 등록부 값을 그대로 화면 링크에 쓰지 않는다).
 */
export function mgmtHostOf(v) {
  let x = typeof v === 'string' ? v.trim().slice(0, 300) : '';
  const i = x.indexOf('://'); if (i >= 0) x = x.slice(i + 3);
  const j = x.indexOf('/'); if (j >= 0) x = x.slice(0, j);
  x = x.slice(0, 255);
  if (!x) return '';
  // 반증 F9: 선행 '-'(ssh 인자로 읽힌다) · ':::' · ']]' 같은 글자를 막는다 — 세 꼴만 받는다
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}(:\d{1,5})?$/.test(x)) return x;   // 호스트 이름 · IPv4 (+ 포트)
  if (/^\[[0-9A-Fa-f:.]{2,45}\](:\d{1,5})?$/.test(x)) return x;         // [IPv6] (+ 포트)
  if (/^[0-9A-Fa-f:.]{2,45}$/.test(x) && x.split(':').length > 2 && /[0-9A-Fa-f]/.test(x)) return x;   // 맨 IPv6(숫자가 하나는 있어야)
  return '';
}

/* ───────── 받는 쪽 정제(엣지 → 중앙 fleet push · 아는 키만) ───────── */
const capS = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const capN = (v, max = 1e7) => { const x = typeof v === 'number' ? numOrNull(v) : null; return x != null && x >= 0 && x <= max ? x : null; };
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
/** 엣지가 보낸 요약 → 아는 필드만. 형식이 아니면 null(지어내지 않는다). 문자열 수치는 받지 않는다(엣지는 수로 보낸다). */
export function sanitizeHwSummary(x, { now = Date.now() } = {}) {
  const h = obj(x);
  if (!h || h.v !== 1) return null;
  const at = capN(h.at, 1e14);
  const cpu = obj(h.cpu); const mem = obj(h.mem); const disk = obj(h.disk); const nic = obj(h.nic); const hba = obj(h.hba); const os = obj(h.os);
  return {
    v: 1,
    at: at == null ? null : Math.min(at, now),   // 반증 F8: 엣지 시각은 수신 시각으로 자른다(미래 시각이면 '0초 전' 이 계속 나온다)
    cpu: cpu ? { sockets: capN(cpu.sockets, 64), cores: capN(cpu.cores, 4096), threads: capN(cpu.threads, 8192), model: capS(cpu.model, 128) } : null,
    mem: mem ? { gib: capN(mem.gib, 1e6), dimms: capN(mem.dimms, 256) } : null,
    disk: disk ? { n: capN(disk.n, 1024), gb: capN(disk.gb, 1e8), ssd: capN(disk.ssd, 1024), hdd: capN(disk.hdd, 1024), nvme: capN(disk.nvme, 1024) } : null,
    nic: nic ? {
      ports: capN(nic.ports, 1024), up: capN(nic.up, 1024), maxGbps: capN(nic.maxGbps, 1e4),
      speeds: Array.isArray(nic.speeds) ? nic.speeds.slice(0, 3).filter((p) => Array.isArray(p) && capN(p[0], 1e4) != null && capN(p[1], 1024) != null).map((p) => [p[0], p[1]]) : [],
    } : null,
    hba: hba ? { n: capN(hba.n, 64), ports: capN(hba.ports, 256) } : null,
    os: os ? { name: capS(os.name, 128), ver: capS(os.ver, 64) } : null,
    host: capS(h.host, 255),
    fw: capS(h.fw, 64),
  };
}
