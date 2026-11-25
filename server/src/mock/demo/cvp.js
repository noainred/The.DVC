/**
 * mock/demo/cvp.js — Arista CloudVision(CVP) 화면 데모 데이터(v2.708, DATA_SOURCE=mock 전용).
 *
 * 하는 일(전부 mock 모드에서만):
 *  · CVP 등록부가 **비어 있을 때만** CVP 서버 2~3대를 `mock-cvp-` id 로 시드한다. 법인 = 그 CVP 서버의 DataCenter(`demoCorps`).
 *  · 폴러가 mock 이면 CVP 에 접속하지 않고 `demoCvpCollect()` 가 collectCvp 와 같은 모양의 결과(장비 목록·포트·BGP·부품·CPU/메모리·
 *    이벤트)를 만든다. 결과는 기존 흐름(db.saveDevices → 장애 전이 판정) 그대로 적재된다 — 화면 API 는 DB 를 그대로 읽는다.
 *    처리량은 카운터 델타가 아니라 합성 값을 바로 싣는다(`demo:true` — 폴러가 applyDeltas 를 건너뛴다).
 *  · 스위치 40~80대: 일부 장애(PSU·팬·포트 link down·BGP Idle·GBIC 약한 광량)·스트리밍 아님·EOS 버전 갈림을 일부러 넣는다.
 *  · 시드한 그 순간에만 과거를 백필한다 — 포트 처리량(최근 48시간 30분 · 7일 2시간)·CPU/메모리(7일 30분)·
 *    장애 전이 이력(3일 전·1일 전 상태를 적재하고 판정을 돌려 '열림 → 해소' 이력이 남게).
 *
 * 값은 (CVP id · 장비 순번 · 시각 10분 칸) 해시로 결정된다 — 같은 입력이면 같은 값.
 */
import { isMockMode, demoHash, demoRand, demoIp } from './flags.js';
import { demoCorps } from './pdu.js';

const HOUR = 3_600_000;
const r2 = (v) => Math.round(v * 100) / 100;
const pad = (n, w = 2) => String(n).padStart(w, '0');

export const isDemoId = (id) => String(id || '').startsWith('mock-');
/** 데모가 지금 쓰이는가 — mock 모드이고 등록부에 데모(mock-) CVP 가 있다(사용자가 직접 등록한 CVP 만 있으면 예전 동작 그대로). */
export const cvpDemoActive = (servers) => isMockMode() && (Array.isArray(servers) ? servers : []).some((x) => isDemoId(x?.id));

/** CVP 서버마다 다른 버전(서버 버전 칩이 갈리게). */
const CVP_VERSIONS = ['2024.3.1', '2024.3.1', '2023.3.4'];
/** 역할 → 모델·포트 구성. */
const ROLES = {
  spine: { model: 'DCS-7280SR3-48YC8', layout: 'leaf' },
  leaf: { model: 'DCS-7050SX3-48YC8', layout: 'leaf' },
  border: { model: 'DCS-7504N', layout: 'chassis' },
  core: { model: 'DCS-7060CX2-32S', layout: 'q32' },
  oob: { model: 'CCS-720XP-48ZC2', layout: 'oob' },
};
const EOS_MAIN = ['4.31.2F', '4.31.2F', '4.30.4M'];

/** 데모 CVP 서버 목록(등록부 모양). 법인 5곳마다 1대 · 2~6대(v3.26.0 — 시연 규모 30곳이면 6대. 예전 상한 3대). */
export function demoCvpServers(corps) {
  const list = (Array.isArray(corps) ? corps : []).filter(Boolean);
  if (!list.length) return [];
  const n = Math.min(6, Math.max(2, Math.min(list.length, Math.ceil(list.length / 5))));
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = list[(i * Math.max(1, Math.floor(list.length / n))) % list.length];
    const id = `mock-cvp-${i + 1}`;
    out.push({
      id, name: `CVP-${c.code}-${pad(i + 1)}`, host: demoIp(id, 10), authMode: 'token', token: 'mock-demo-token', username: '',
      agent: '', verifyTls: false, enabled: true, datacenterId: c.id, note: '데모(합성) CVP — 실제로 접속하지 않습니다',
    });
  }
  return out;
}

/** CVP 한 대의 스위치 명세(결정적). 14~25대. */
export function demoSwitchSpecs(srv) {
  const sid = String(srv?.id || '');
  const n = 14 + (demoHash(`cvp-n|${sid}`) % 12);
  const code = String(srv?.name || 'CVP').split('-')[1] || 'DC';
  const idx = Number(sid.replace(/\D+/g, '')) || 1;
  const mainEos = EOS_MAIN[(idx - 1) % EOS_MAIN.length];
  const out = [];
  for (let i = 1; i <= n; i++) {
    const role = i <= 2 ? 'spine' : i === 3 ? 'border' : i === 4 ? 'core' : i === n ? 'oob' : 'leaf';
    const h = demoHash(`sw|${sid}|${i}`);
    const serial = `JPE${String(h % 1e8).padStart(8, '0')}`;
    out.push({
      i, role, model: ROLES[role].model, layout: ROLES[role].layout, serial, key: serial, h,
      hostname: `${code.toLowerCase()}-${role}-${pad(i)}`,
      eosVersion: role === 'oob' ? '4.29.8M' : (h % 7 === 0 ? '4.32.1F' : mainEos),
      streaming: !(h % 17 === 5 || (role === 'oob' && idx === 2)),
      mgmtIp: demoIp(`mgmt|${sid}|${i}`, 10),
    });
  }
  return out;
}

function portNames(layout) {
  if (layout === 'chassis') return [3, 4].flatMap((s) => Array.from({ length: 24 }, (_, k) => ({ name: `Ethernet${s}/${k + 1}`, speedBps: 100e9 })));
  if (layout === 'q32') return Array.from({ length: 32 }, (_, k) => ({ name: `Ethernet${k + 1}/1`, speedBps: 100e9 }));
  if (layout === 'oob') return Array.from({ length: 48 }, (_, k) => ({ name: `Ethernet${k + 1}`, speedBps: 1e9 }));
  return [...Array.from({ length: 48 }, (_, k) => ({ name: `Ethernet${k + 1}`, speedBps: 25e9 })),
    ...Array.from({ length: 6 }, (_, k) => ({ name: `Ethernet${49 + k}/1`, speedBps: 100e9 }))];
}

/** 하루 주기(오후 최고) · 0.6~1.4. */
const diurnal = (ts) => 1 + 0.35 * Math.sin((((ts / HOUR) % 24) - 8) / 24 * 2 * Math.PI);

/**
 * 포트 하나의 합성 값. variant: 'now' | 'past1' | 'past3'(장애 이력용 — 과거에만 있던 link down).
 */
function portOf(sw, p, k, ts, variant) {
  const ph = demoHash(`p|${sw.key}|${p.name}`);
  const isUplink = /\/1$/.test(p.name) || sw.layout === 'chassis' || sw.layout === 'q32';
  const used = isUplink ? ph % 8 !== 0 : ph % 10 < 6;
  const slot = Math.floor(ts / 600_000);
  const base = {
    name: p.name, speedBps: p.speedBps, vlan: isUplink ? 'trunk' : String(100 + (ph % 40)), lag: isUplink && k % 2 === 0 ? `Port-Channel${1 + (k % 4)}` : '',
    duplex: 'duplexFull', fwdModel: isUplink ? 'routed' : 'bridged', mac: `00:1c:73:${pad(((ph >>> 16) % 256).toString(16))}:${pad(((ph >>> 8) % 256).toString(16))}:${pad((ph % 256).toString(16))}`,
    mtu: isUplink ? 9214 : 1500,
  };
  if (!used) return { ...base, desc: '', oper: 'nolink', admin: 'up', operRaw: 'linkDown', inBps: null, outBps: null, inUtil: null, outUtil: null, inErr: null, outErr: null, inDrop: null, outDrop: null };
  // 장애: 관리상 켜져 있는데 링크가 내려간 포트(정상 장비 대부분은 0개).
  const downNow = sw.streaming && sw.h % 8 === 1 && k === 7;
  const downPast = variant === 'past3' && sw.h % 7 === 2 && k === 9;   // 과거에만 있던 link down(이력에서 '해소' 로 닫힌다)
  const desc = isUplink ? `to ${sw.role === 'leaf' ? 'spine' : 'leaf'}-${pad(1 + (ph % 20))} ${p.name}` : `esx-${pad(1 + (ph % 90), 3)} vmnic${ph % 4}`;
  if (downNow || downPast) return { ...base, desc, oper: 'down', admin: 'up', operRaw: 'linkDown', inBps: null, outBps: null, inUtil: null, outUtil: null, inErr: null, outErr: null, inDrop: null, outDrop: null };
  const hot = ph % 37 === 3;
  const u0 = hot ? 60 + (ph % 10) : 2 + (ph % 34);
  const utilIn = Math.min(97, Math.max(0.2, u0 * diurnal(ts) * (1 + (demoRand(`${sw.key}|${p.name}|${slot}`) * 2 - 1) * 0.08)));
  const utilOut = Math.min(97, Math.max(0.1, utilIn * (0.55 + (ph % 40) / 100)));
  const inBps = Math.round(p.speedBps * utilIn / 100);
  const outBps = Math.round(p.speedBps * utilOut / 100);
  return { ...base, desc, oper: 'up', admin: 'up', operRaw: 'linkUp', inBps, outBps, inUtil: r2(utilIn), outUtil: r2(utilOut), inErr: ph % 23 === 0 ? 3 : 0, outErr: 0,
    // v2.923(B-①) 데모 드롭 — 붐비는 포트(hot)는 송신 쪽 드롭이 생긴다(큐 넘침 모양), 그 밖은 0.
    inDrop: ph % 29 === 0 ? 1 : 0, outDrop: hot ? 12 + (ph % 7) : 0 };
}

/** 부품 목록(장비 접속 없이 합성). judgeOptics·judgeSlotPower 는 호출자(demoCvpDevice)가 적용한다. */
function partsOf(sw, ports, ts, variant) {
  const parts = [];
  const psuFaultNow = sw.h % 17 === 4;
  const psuFaultPast = variant === 'past3' && sw.h % 13 === 2;
  for (const n of [1, 2]) {
    const bad = (psuFaultNow || psuFaultPast) && n === 2;
    const inW = bad ? null : Math.round((sw.layout === 'chassis' ? 1450 : sw.layout === 'oob' ? 95 : 210) * (0.92 + (demoHash(`psu|${sw.key}|${n}`) % 15) / 100));
    parts.push({
      kind: 'psu', name: `powerSupply › PowerSupply${n}`, state: bad ? 'fault' : 'ok',
      detail: bad ? 'status powerLoss · Input power lost' : 'status ok',
      ...(bad ? {} : { power: { inW, outW: Math.round(inW * 0.93), capW: sw.layout === 'chassis' ? 3000 : 1100 } }),
    });
  }
  const fanWarn = sw.h % 19 === 6 || (variant === 'past1' && sw.h % 9 === 3);
  for (let n = 1; n <= 4; n++) parts.push({ kind: 'fan', name: `cooling › FanTray${n}`, state: fanWarn && n === 3 ? 'warn' : 'ok', detail: fanWarn && n === 3 ? 'speed 92% · fan speed high' : `speed ${38 + (demoHash(`fan|${sw.key}|${n}`) % 20)}%` });
  const tempWarn = sw.h % 23 === 8;
  for (let n = 1; n <= 3; n++) {
    const t = 36 + (demoHash(`tmp|${sw.key}|${n}`) % 12) + (tempWarn && n === 1 ? 31 : 0);
    parts.push({ kind: 'temp', name: `temperature › TempSensor${n}`, state: tempWarn && n === 1 ? 'warn' : 'ok', detail: `${t}℃ · 경고 ${n === 1 ? 65 : 75}℃` });
  }
  // 트랜시버: 링크가 올라온 업링크·고속 포트 일부(장비당 최대 12개) + 빈 슬롯 1개.
  let n = 0; let weakDone = false;
  for (const p of ports) {
    if (n >= 12 || p.speedBps < 10e9 || p.oper === 'nolink') continue;
    const ph = demoHash(`x|${sw.key}|${p.name}`);
    const weak = sw.h % 7 === 2 && !weakDone && p.oper === 'up' ? (sw.h % 2 ? -12.4 : -15.6) : null;   // 약한 광량: 장비 7대 중 1대의 링크 올라온 첫 트랜시버
    if (weak != null) weakDone = true;
    const rx = weak ?? r2(-1.2 - (ph % 40) / 10 + (demoRand(`${sw.key}|${p.name}|${Math.floor(ts / 600_000)}`) - 0.5) * 0.2);
    parts.push({
      kind: 'xcvr', name: `xcvr › ${p.name}`, state: 'ok', detail: `Rx ${rx} · Tx ${r2(-1.5 - (ph % 10) / 10)}`,
      media: p.speedBps >= 100e9 ? '100GBASE-SR4' : '25GBASE-SR',
      dom: { rxPower: rx, txPower: r2(-1.5 - (ph % 10) / 10), temperature: 30 + (ph % 15), voltage: r2(3.28 + (ph % 5) / 100), txBias: r2(6.5 + (ph % 30) / 10) },
      domJudge: { otherState: null, envState: null, rxDevice: null, rxThresholds: null },
    });
    n++;
  }
  parts.push({ kind: 'xcvr', name: 'xcvr › Ethernet48', state: 'absent', detail: 'not present' });
  return parts;
}

function bgpOf(sw, ts, variant) {
  if (sw.role === 'oob') return [];
  const n = sw.role === 'spine' ? 8 : sw.role === 'border' ? 4 : 2;
  const out = [];
  for (let i = 1; i <= n; i++) {
    const ph = demoHash(`bgp|${sw.key}|${i}`);
    const downNow = sw.h % 12 === 5 && i === n;
    const downPast = variant === 'past3' && sw.h % 11 === 3 && i === 1;
    out.push({
      peer: `10.255.${(ph >>> 8) % 250}.${(ph % 250) + 1}`, asn: sw.role === 'border' && i > 2 ? String(64600 + (ph % 50)) : '65000',
      vrf: sw.role === 'border' && i > 2 ? 'INTERNET' : '',
      state: downNow ? 'Idle' : downPast ? 'Active' : 'Established',
      prefixes: downNow || downPast ? 0 : (sw.role === 'border' ? 850 + (ph % 300) : 40 + (ph % 60)),
    });
  }
  return out;
}

/** CPU·메모리 사용률(%) — 결정적. 이력 백필이 장비 레코드 전체를 만들지 않게 따로 둔다. */
export function sysOf(sw, ts) {
  const slot = Math.floor(ts / 600_000);
  const cpuHot = sw.h % 23 === 11;
  const cpu = cpuHot ? r2(86 + demoRand(`cpu|${sw.key}|${slot}`) * 6) : r2(6 + (sw.h % 30) * diurnal(ts) * 0.9 + demoRand(`cpu|${sw.key}|${slot}`) * 3);
  const mem = r2(32 + (sw.h % 30) + demoRand(`mem|${sw.key}|${slot}`) * 2);
  return { cpu: Math.min(100, cpu), mem: Math.min(100, mem) };
}

/**
 * 스위치 한 대의 장비 레코드(cvp/client.js collectCvp 의 devices[] 원소 + 폴러가 applySys 로 바꾸는 cpu/mem).
 * @param {object} sw demoSwitchSpecs 원소  @param {number} ts  @param {{variant?:string, optics?:object, P?:object}} o
 */
export function demoCvpDevice(sw, ts, { variant = 'now', optics = {}, P = null } = {}) {
  const dev = {
    key: sw.key, hostname: sw.hostname, model: sw.model, serial: sw.serial, mgmtIp: sw.mgmtIp, eosVersion: sw.eosVersion,
    streaming: sw.streaming, ts,
    info: { fqdn: `${sw.hostname}.demo.local`, mac: `00:1c:73:${pad(((sw.h >>> 16) % 256).toString(16))}:${pad(((sw.h >>> 8) % 256).toString(16))}:${pad((sw.h % 256).toString(16))}`,
      bootAt: ts - (5 + (sw.h % 200)) * 86_400_000, status: 'Registered', container: `Tenant/${sw.role}`, internalVersion: `${sw.eosVersion}-${30000000 + (sw.h % 9000000)}`, ztpMode: false,
      ...demoComplianceInfo(sw, ts) },
  };
  if (!sw.streaming) {
    return { ...dev, telemetry: 'not-streaming', parts: undefined, partsAt: null, bgp: null, ports: null, countersAt: null, sysAt: null, cpu: null, mem: null };
  }
  const ports = portNames(sw.layout).map((p, k) => portOf(sw, p, k, ts, variant));
  let parts = partsOf(sw, ports, ts, variant);
  if (P) { parts = P.judgeOptics(parts, ports, optics); parts = P.judgeSlotPower(parts, {}); }
  const { cpu, mem } = sysOf(sw, ts);
  return {
    ...dev, telemetry: 'ok', ports, parts, partsAt: ts, partsAttempted: true, descsAt: ts, bgp: bgpOf(sw, ts, variant),
    countersAt: ts, sysAt: ts, cpu: { pct: cpu, counters: null }, mem: { pct: mem, total: 8_589_934_592 },
    // v3.41(⑧) 데모 — VLAN · 채널 소속을 읽은 시각 · MLAG 상태(leaf · spine 만 MLAG 사용). 여덟 번째마다 피어 링크 down · 열한 번째마다 협상 안 됨(가상).
    cfgReadAt: { vlan: ts, lag: ts },
    ...(sw.role === 'leaf' || sw.role === 'spine' ? { mlagStatus: { state: sw.h % 11 === 5 ? 'inactive' : 'active', negotiation: sw.h % 11 === 5 ? 'connecting' : 'connected',
      peerLinkState: sw.h % 8 === 3 ? 'down' : 'up', peerLink: 'Port-Channel1000', domain: `${sw.hostname.split('-')[0]}-${sw.role}`, localIntf: 'Vlan4094', at: ts } } : { mlagStatus: { state: 'disabled', at: ts } }),
  };
}

/**
 * v3.41(③ 버전 준수) 데모 — CVP 레거시 인벤토리 준수 코드 · 버그/CVE 노출 · 수명주기. 값은 전부 **가상**이다(실제 Arista 공지가 아니다).
 *   4.29.8M(oob) 은 지원 종료 지남 · 4.30.4M 은 180일 안 · 4.32.1F 는 CVE 높음 · 일곱 번째 장비마다 설정 불일치.
 */
function demoComplianceInfo(sw, ts) {
  const DAY = 86_400_000;
  const v = String(sw.eosVersion || '');
  const swEnd = v.startsWith('4.29') ? ts - 40 * DAY : v.startsWith('4.30') ? ts + 120 * DAY : ts + 700 * DAY;
  const bugs = v.startsWith('4.32') ? { bugCount: 7, cveCount: 2, highestBug: 'high', highestCve: 'high', acknowledged: false }
    : v.startsWith('4.29') ? { bugCount: 3, cveCount: 1, highestBug: 'low', highestCve: 'low', acknowledged: false } : null;
  return {
    complianceCode: sw.h % 7 === 3 ? '0001' : '0000', complianceIndication: sw.h % 7 === 3 ? 'WARNING' : 'NONE', mlag: sw.role === 'leaf' || sw.role === 'spine',
    readKinds: ['enrich', 'lifecycle', 'bugs'],
    lifecycle: { swEolVersion: v.replace(/[A-Z]$/, ''), swEndOfSupport: swEnd, hwEndOfLife: sw.role === 'oob' ? ts + 300 * DAY : null, hwEndOfSale: sw.role === 'oob' ? ts - 100 * DAY : null, hwEndOfTacSupport: null, hwEndOfRma: null },
    ...(bugs ? { bugs } : {}),
  };
}

/** CVP 이벤트(최근 7일 · 10~15건). */
export function demoCvpEvents(srv, specs, now = Date.now()) {
  const sid = String(srv?.id || '');
  const n = 10 + (demoHash(`ev-n|${sid}`) % 6);
  const SEV = ['info', 'warning', 'warning', 'error', 'critical', 'info'];
  const KINDS = [
    ['DEVICE_INTF_ERR_DISCARDS', '인터페이스 폐기 패킷 증가'], ['HIGH_CPU_UTILIZATION', 'CPU 사용률 높음'], ['BGP_SESSION_DOWN', 'BGP 세션 다운'],
    ['POWER_SUPPLY_FAILED', '전원 공급 장치 이상'], ['DEVICE_REBOOTED', '장비 재부팅'], ['CONFIG_DRIFT', '구성 불일치(Designed vs Running)'],
  ];
  const list = [];
  for (let i = 0; i < n; i++) {
    const h = demoHash(`ev|${sid}|${i}`);
    const sw = specs[h % specs.length];
    const [type, title] = KINDS[h % KINDS.length];
    const ts = now - Math.round((h % 1000) / 1000 * 7 * 86_400_000);
    list.push({ key: `mock-ev-${sid}-${i}`, ts, severity: SEV[(h >>> 3) % SEV.length], title: `${title} — ${sw.hostname}`, desc: `데모(합성) 이벤트 · ${sw.hostname}(${sw.serial})`, type, devices: [sw.serial], ack: h % 3 === 0, updatedAt: ts });
  }
  list.sort((a, b) => b.ts - a.ts);
  const bySeverity = {};
  for (const e of list) bySeverity[e.severity] = (bySeverity[e.severity] || 0) + 1;
  return { list, bySeverity, total: list.length, truncated: false, capped: 0, at: now };
}

/**
 * 폴러가 mock 일 때 collectCvp 대신 부른다 — 같은 모양의 결과(`demo:true`).
 * @param {object} srv  @param {{now?:number, optics?:object}} o
 */
export async function demoCvpCollect(srv, { now = Date.now(), optics = {} } = {}) {
  const P = await import('../../cvp/parse.js');
  const specs = demoSwitchSpecs(srv);
  const devices = specs.map((sw) => demoCvpDevice(sw, now, { optics, P }));
  await demoL2(srv, devices, now);   // v2.924(SAN·CVP 설계 B-②) — LLDP 이웃 · MAC 테이블(데모 호스트 이름 · VM MAC)
  const idx = Number(String(srv?.id || '').replace(/\D+/g, '')) || 1;
  return {
    ok: true, error: null, demo: true, devices,
    usedPaths: { inventory: '(데모 합성 — 실제 CVP 에 접속하지 않았습니다)' }, missing: {}, seenFields: {}, truncated: null, samples: null,
    cvpVersion: CVP_VERSIONS[(idx - 1) % CVP_VERSIONS.length],
    events: demoCvpEvents(srv, specs, now), inventoryComplete: true,
  };
}

/**
 * v2.924(B-②) 데모 L2 — 이 CVP 법인(datacenterId)의 데모 vCenter 호스트를 leaf 스위치의 서버 쪽 포트에 둘씩 붙인다:
 *   LLDP 이웃(시스템 이름 = 호스트 이름 · 포트 ID = vmnic0/vmnic1) · MAC 테이블(vmnic0 포트에 그 호스트 VM 의 vNIC MAC 최대 16개 · VLAN 100).
 *   호스트 상세의 CVP 업링크 블록이 데모에서도 '확정(LLDP)' · '높음(VM MAC)' 근거를 보여 준다. 스냅샷·법인 지정이 아직 없으면 싣지 않는다(undefined — 저장소를 건드리지 않음).
 */
const _demoEp = new Map();   // mac → { device, port, vlan, learnedAgoMs }
/** v2.935(C-③) 데모 EndpointLocation 결과 — demoL2 가 채운 표에서(없는 MAC 은 'none'). 수치 · 위치는 가상값이다. */
export function demoEndpoints(macs = [], now = Date.now()) {
  const results = (Array.isArray(macs) ? macs : []).map((mac) => {
    const e = _demoEp.get(mac);
    return e ? { mac, at: now, status: 'ok', locations: [{ device: e.device, port: e.port, vlan: e.vlan, learnedAt: new Date(now - (e.learnedAgoMs || 600_000)).toISOString(), macType: 'MAC_TYPE_LEARNED_DYNAMIC', likelihood: 'LIKELIHOOD_VERY_LIKELY' }] }
      : { mac, at: now, status: 'none', locations: [] };
  });
  return { results, unsupported: false, cut: 0 };
}
async function demoL2(srv, devices, now) {
  let hosts = []; let vms = [];
  try {
    const { store } = await import('../../store.js');
    const { datacenterOfVcenter } = await import('../../datacenter/store.js');
    const snap = store.get();
    const vcs = new Set((snap?.vcenters || []).filter((v) => String(datacenterOfVcenter(v.id) || '') === String(srv?.datacenterId || '')).map((v) => v.id));
    if (!vcs.size) return;
    hosts = (snap.hosts || []).filter((h) => vcs.has(h.vcenterId)).slice(0, 64);
    vms = snap.vms || [];
  } catch { return; }
  const leaves = devices.filter((d) => d.telemetry === 'ok' && /-leaf-/.test(String(d.hostname || '')));
  if (!leaves.length) return;
  for (const d of leaves) { d.lldp = []; d.fdb = []; d.fdbMeta = { truncated: 0, portsOverCap: [], total: 0 }; d.l2At = now; }
  demoFabricLinks(devices, leaves, now);   // v3.38 토폴로지 — leaf 업링크 ↔ spine(LLDP 양쪽)
  const slots = [];
  for (const d of leaves) for (const p of d.ports || []) if (p.oper === 'up' && !/\/1$/.test(p.name)) slots.push({ d, p });
  if (slots.length < 2) return;
  const devId = (d) => String(d.serial || d.key || '');
  hosts.forEach((h, i) => {
    const a = slots[(2 * i) % slots.length]; const b = slots[(2 * i + 1) % slots.length];
    // v2.935(C-③) 데모 EndpointLocation — 호스트 NIC MAC 은 LLDP 와 같은 포트 · VM MAC 은 vmnic0 포트(일곱 번째마다 다음 호스트 포트 = vMotion 직후 옛 위치처럼).
    const nics = Array.isArray(h.nics) ? h.nics : [];
    const other = slots[(2 * i + 2) % slots.length];
    // 아홉 번째 호스트마다 vmnic1 의 CVP 위치를 LLDP 와 다른 포트로 둔다 — 화면의 ‘LLDP 와 CVP 위치가 다릅니다’ 를 데모에서도 보이게(가상).
    nics.forEach((nic, k) => {
      const mac = String(nic?.mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
      if (mac.length !== 12) return;
      const slot = k === 1 && i % 9 === 4 ? other : k % 2 ? b : a;
      _demoEp.set(mac, { device: devId(slot.d), port: slot.p.name, vlan: null });
    });
    let vi = 0;
    for (const v of vms) {
      if (v.vcenterId !== h.vcenterId || v.host !== h.name) continue;
      for (const nic of v.dev?.nics || []) {
        const mac = String(nic?.mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
        if (mac.length !== 12) continue;
        const stale = (vi++ % 7) === 6;
        _demoEp.set(mac, { device: devId(stale ? other.d : a.d), port: (stale ? other.p : a.p).name, vlan: 100, learnedAgoMs: stale ? 3 * 3600_000 : 10 * 60_000 });
      }
    }
    a.d.lldp.push({ port: a.p.name, idx: '1', sysName: h.name, portId: 'vmnic0', portDesc: 'vmnic0', chassisId: '' });
    b.d.lldp.push({ port: b.p.name, idx: '1', sysName: h.name, portId: 'vmnic1', portDesc: 'vmnic1', chassisId: '' });
    // v3.37 포트 구성도 — 데모 포트 설명을 LLDP 이웃과 대개 맞춘다(그래야 '일치' 가 보인다). 여섯 번째마다 설명을 비우고(LLDP 만),
    //   그다음은 옛 설명을 남긴다(불일치 — 설명이 낡은 포트). 이름 · 수치는 가상값이다.
    if (i % 6 === 4) { a.p.desc = ''; b.p.desc = ''; } else if (i % 6 !== 5) { a.p.desc = `${h.name} vmnic0`; b.p.desc = `${h.name} vmnic1`; }
    let n = 0;
    for (const v of vms) {
      if (v.vcenterId !== h.vcenterId || v.host !== h.name) continue;
      for (const nic of v.dev?.nics || []) {
        const mac = String(nic?.mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
        if (mac.length === 12 && n < 16) { a.d.fdb.push({ mac, vlan: 100, port: a.p.name }); n++; }
      }
      if (n >= 16) break;
    }
  });
  for (const d of leaves) d.fdbMeta.total = d.fdb.length;
}

/**
 * v3.38(⑥ ⑦ 토폴로지 · 양끝 불일치) 데모 — leaf 의 링크 올라온 업링크(이름이 /1 로 끝나는 100G) 앞 둘을 spine 두 대의 슬롯 포트에 잇고,
 *   양쪽 LLDP 와 leaf 쪽 포트 설명(상대 이름 · 포트)을 맞춘다. 일곱 번째 leaf 는 설명이 다른 spine 을 가리키고(설명 불일치),
 *   아홉 번째 leaf 의 첫 업링크는 MTU 1500(MTU 불일치) — 화면의 '불일치' 를 데모에서도 보이게. 이름 · 포트 · 수치는 가상값이다.
 */
function demoFabricLinks(devices, leaves, now) {
  const spines = devices.filter((d) => d.telemetry === 'ok' && /-spine-/.test(String(d.hostname || '')));
  if (!spines.length) return;
  for (const sp of spines) { if (!Array.isArray(sp.lldp)) sp.lldp = []; sp.l2At = now; }
  leaves.forEach((lf, j) => {
    const ups = (lf.ports || []).filter((p) => p.oper === 'up' && /\/1$/.test(p.name)).slice(0, Math.min(2, spines.length));
    ups.forEach((p, u) => {
      const sp = spines[u % spines.length];
      // 데모 spine 은 leaf 와 같은 배치(Ethernet1~48 · 49/1~54/1)다 — leaf 순번으로 앞 48칸에 잇고, 상대 끝 값(속도 · MTU · 채널)을 leaf 업링크와 맞춘다.
      const spPort = `Ethernet${(j % 48) + 1}`;
      const sport = (sp.ports || []).find((x) => x.name === spPort);
      lf.lldp.push({ port: p.name, idx: '1', sysName: sp.hostname, portId: spPort, portDesc: '', chassisId: '' });
      if (sport) {
        sp.lldp.push({ port: spPort, idx: '1', sysName: lf.hostname, portId: p.name, portDesc: '', chassisId: '' });
        Object.assign(sport, { oper: 'up', admin: 'up', operRaw: 'linkUp', desc: `${lf.hostname} ${p.name}`, speedBps: p.speedBps, mtu: 9214, duplex: p.duplex, lag: p.lag ? 'Port-Channel1' : '' });
      }
      const wrong = j % 7 === 6 && spines.length > 1 ? spines[(u + 1) % spines.length] : sp;
      p.desc = `${wrong.hostname} ${spPort}`;
      p.mtu = j % 9 === 3 && u === 0 ? 1500 : 9214;
    });
  });
}

let _seeding = null;
let _seeded = false;

/**
 * CVP 등록부가 비어 있으면 데모 서버를 시드하고 과거를 백필한다(mock 전용 · 한 번만). 수집은 하지 않는다 —
 * 호출자(pollCvpOnce)가 이어서 수집한다.
 */
export function ensureCvpDemo() {
  if (!isMockMode()) return Promise.resolve({ seeded: false, reason: 'not-mock' });
  if (_seeded) return Promise.resolve({ seeded: false, reason: 'done' });
  if (_seeding) return _seeding;
  _seeding = seedInner().finally(() => { _seeding = null; });
  return _seeding;
}

async function seedInner() {
  const reg = await import('../../cvp/registry.js');
  if (reg.listServers().length) return topUpInner(reg);
  const { store } = await import('../../store.js');
  const snap = store.get();
  // 메인 mock 스냅샷이 생긴 뒤에만 시드한다(테스트처럼 스냅샷 없이 폴러만 부르는 경우에는 시드하지 않는다).
  if (!Array.isArray(snap?.vcenters) || !snap.vcenters.length) return { seeded: false, reason: 'snapshot-not-ready' };
  const corps = await demoCorps(snap);
  if (!corps.length) return { seeded: false, reason: 'snapshot-not-ready' };
  const servers = demoCvpServers(corps);
  const r = reg.seedDemoServers(servers);
  // ⚠ _seeded 는 백필이 끝난 뒤에 세운다 — 먼저 세우면 동시에 들어온 다른 수집(라우트 kick·타이머)이 '이미 시드됨' 으로 지나가
  //   현재 장비 행을 먼저 적재하고, 그 뒤의 과거 행은 ts 가드에 막혀 장애 이력이 만들어지지 않는다(실측으로 잡은 결함).
  //   동시 호출자는 진행 중 프라미스(_seeding)를 기다린다.
  if (!r.ok) { _seeded = true; return { seeded: false, reason: r.reason }; }
  const hist = await backfillCvp(servers).catch((e) => ({ error: e.message }));
  const nDev = servers.reduce((a, s) => a + demoSwitchSpecs(s).length, 0);
  console.log(`[mock] CVP 데모 시드: CVP ${servers.length}대 · 스위치 ${nDev}대 + 이력 ${JSON.stringify(hist)}`);
  _seeded = true;
  return { seeded: true, servers: servers.length, switches: nDev, history: hist };
}

/**
 * v3.26.0: 보충 — 등록부가 데모 CVP 뿐이고 지금 규모(법인 수 기준)보다 적으면(v2.914 이전 시드 — 3대) 없는 데모 CVP 만 덧붙이고 그것만 백필한다.
 */
async function topUpInner(reg) {
  const cur = reg.listServers();
  if (cur.some((x) => !isDemoId(x?.id))) { _seeded = true; return { seeded: false, reason: 'registry-not-empty' }; }
  const { store } = await import('../../store.js');
  const snap = store.get();
  if (!Array.isArray(snap?.vcenters) || !snap.vcenters.length) return { seeded: false, reason: 'snapshot-not-ready' };
  const corps = await demoCorps(snap);
  if (!corps.length) return { seeded: false, reason: 'snapshot-not-ready' };
  const want = demoCvpServers(corps);
  if (cur.length >= want.length) { _seeded = true; return { seeded: false, reason: 'registry-not-empty' }; }
  const r = reg.topUpDemoServers(want);
  if (!r.ok || !r.count) { _seeded = true; return { seeded: false, reason: r.reason || 'nothing-to-add' }; }
  const added = want.filter((x) => r.added.includes(String(x.id)));
  const hist = await backfillCvp(added).catch((e) => ({ error: e.message }));
  const nDev = added.reduce((a, x) => a + demoSwitchSpecs(x).length, 0);
  console.log(`[mock] CVP 데모 보충: CVP ${added.length}대 · 스위치 ${nDev}대 + 이력 ${JSON.stringify(hist)}`);
  _seeded = true;
  return { seeded: true, servers: added.length, switches: nDev, history: hist, topUp: true };
}

/** 포트 처리량 백필 시각(오래된 것부터): 7일 전 ~ 48시간 전 2시간, 최근 48시간 30분. */
export function cvpBackfillTimes(now = Date.now()) {
  const out = [];
  for (let t = now - 7 * 24 * HOUR; t < now - 48 * HOUR; t += 2 * HOUR) out.push(t);
  for (let t = now - 48 * HOUR; t < now - 20 * 60_000; t += 30 * 60_000) out.push(t);
  return out;
}

async function backfillCvp(servers, now = Date.now()) {
  const db = await import('../../cvp/db.js');
  const P = await import('../../cvp/parse.js');
  const { runCvpFaultScan } = await import('../../cvp/faultScan.js');
  const { loadSettings } = await import('../../cvp/settings.js');
  const st = loadSettings();
  const optics = { warnDbm: st.xcvrRxWarnDbm, faultDbm: st.xcvrRxFaultDbm };
  const times = cvpBackfillTimes(now);
  let samples = 0; let devSamples = 0;
  // ① 처리량·CPU/메모리 원시 표본(장비 행보다 먼저 — 최신 열을 과거 값으로 건드리지 않게). 장비당 업링크 + 앞쪽 접근 포트 8개만.
  for (const srv of servers) {
    const specs = demoSwitchSpecs(srv).filter((s) => s.streaming);
    const rows = []; const sysRows = [];
    for (const sw of specs) {
      await new Promise((r) => setImmediate(r));   // 장비마다 양보 — 백필 배열을 만드는 동안 이벤트 루프를 오래 잡지 않게
      const all = portNames(sw.layout).map((p, k) => ({ p, k }));
      const pick = [...all.filter((x) => x.p.speedBps >= 100e9).slice(0, 6), ...all.filter((x) => x.p.speedBps < 100e9).slice(0, 8)];
      for (const t of times) {
        for (const { p, k } of pick) {
          const v = portOf(sw, p, k, t, 'now');
          if (v.oper !== 'up') continue;
          rows.push([srv.id, sw.key, v.name, t, v.inBps, v.outBps, v.inUtil, v.outUtil, v.inErr, v.outErr, v.inDrop, v.outDrop]);
        }
      }
      for (let t = now - 7 * 24 * HOUR; t < now - 20 * 60_000; t += 30 * 60_000) {
        const y = sysOf(sw, t);
        sysRows.push([srv.id, sw.key, t, y.cpu, y.mem, 8_589_934_592]);
      }
    }
    samples += (await db.importSamples(db.LOCAL_AGENT, rows)).inserted || 0;
    devSamples += (await db.importDevSamples(db.LOCAL_AGENT, sysRows)).samples || 0;
  }
  // ② 장애 전이 이력 — 3일 전·1일 전 상태를 적재하고 그 시각으로 판정한다(과거에만 있던 장애는 다음 판정에서 '해소' 로 닫힌다).
  const scans = [];
  for (const [variant, t] of [['past3', now - 3 * 24 * HOUR], ['past1', now - 24 * HOUR]]) {
    for (const srv of servers) {
      const devices = demoSwitchSpecs(srv).map((sw) => {
        const d = demoCvpDevice(sw, t, { variant, optics, P });
        d.cpuPct = d.cpu ? d.cpu.pct : null; d.memPct = d.mem ? d.mem.pct : null; d.memTotal = d.mem ? d.mem.total : null;
        delete d.cpu; delete d.mem;
        return d;
      });
      await db.saveDevices({ agent: db.LOCAL_AGENT, cvpId: srv.id, devices, samples: false });
    }
    const r = await runCvpFaultScan({ now: t, reason: `demo-history:${variant}`, notify: false });
    scans.push({ variant, opened: r.opened ?? null, closed: r.closed ?? null });
  }
  // ③ v3.38 네트워크 기능 일 기록(포트 수 · GBIC 일 최저 · 플랩 · 마지막 링크 날 · 업링크 일 최대 사용률) — 추세 · 예측 화면이 데모에서 '기록 부족' 만 보이지 않게.
  const net = await demoNetHistory(servers, db, P, optics, now).catch((e) => ({ error: e.message }));
  return { samples, devSamples, scans, net };
}

/**
 * v3.38 데모 일 기록 — 날짜 · 값은 전부 가상이다. 장비 hash 로 갈래를 나눠 '곧 고갈' · '늘지 않음' · 'GBIC 하강' · '플랩' · '오래 안 쓴 포트' 가 다 보이게.
 */
async function demoNetHistory(servers, db, P, optics, now) {
  const DAY = 86_400_000;
  const today = Math.floor(now / DAY);
  const devPort = []; const xcvr = []; const flap = []; const lastLink = []; const firstDay = []; const util = [];
  for (const srv of servers) {
    for (const sw of demoSwitchSpecs(srv)) {
      await new Promise((r) => setImmediate(r));
      const d = demoCvpDevice(sw, now, { optics, P });
      const ports = d.ports || [];
      const total = ports.length;
      const usedNow = ports.filter((p) => p.oper === 'up').length;
      const kind = sw.h % 5;   // 0 = 빠르게 늘어남 · 1 = 천천히 · 그 밖 = 그대로
      const per = kind === 0 ? Math.max(0.02, (total - usedNow) / 150) : kind === 1 ? 0.04 : 0;
      if (total > 0) for (let i = 179; i >= 0; i--) devPort.push([srv.id, sw.key, today - i, total, Math.max(0, Math.round(usedNow - per * i))]);
      firstDay.push([srv.id, sw.key, today - 300]);
      ports.forEach((p, k) => {
        if (p.oper === 'up') { lastLink.push([srv.id, sw.key, p.name, today]); return; }
        const r = demoHash(`ll|${sw.key}|${p.name}`) % 4;
        if (r === 0) lastLink.push([srv.id, sw.key, p.name, today - 200 - (k % 60)]);
        else if (r === 1) lastLink.push([srv.id, sw.key, p.name, today - 40 - (k % 20)]);
        // r 2 · 3 = 기록 시작 뒤 한 번도 링크 없음
      });
      const xs = (d.parts || []).filter((x) => x.kind === 'xcvr' && x.state !== 'absent' && x.dom);
      xs.forEach((x, k) => {
        const intf = String(x.name).split(' › ')[1];
        const declining = sw.h % 6 === 1 && k === 0;
        const rxNow = Number(x.dom.rxPower);
        for (let i = 29; i >= 0; i--) xcvr.push([srv.id, sw.key, intf, today - i, declining ? Math.round((rxNow + 3.2 - i * 0.11) * 100) / 100 : Math.round((rxNow + (demoRand(`xd|${sw.key}|${intf}|${i}`) - 0.5) * 0.3) * 100) / 100, x.dom.txPower ?? null]);
      });
      if (sw.h % 4 === 1) {
        const up = ports.filter((p) => p.oper === 'up');
        const fp = up[(sw.h >>> 3) % Math.max(1, up.length)];
        if (fp) for (const [ago, n] of [[0, 2], [1, 3], [3, 1], [5, 2]]) flap.push([srv.id, sw.key, fp.name, today - ago, n]);
      }
      // 업링크 일 최대 사용률(8일 전 이전만 — 최근 7일은 표본 백필이 채운다). 셋째 장비마다 늘어나는 추세.
      if (sw.role === 'leaf' || sw.role === 'spine') {
        const ups = ports.filter((p) => p.oper === 'up' && /\/1$/.test(p.name)).slice(0, 2);
        for (const p of ups) {
          const base = Number(p.inUtil) || 20;
          const grow = sw.h % 3 === 0 ? 0.25 : 0.02;
          for (let i = 179; i >= 8; i--) util.push([srv.id, sw.key, p.name, today - i, Math.max(1, Math.round((base - grow * i + (demoRand(`ut|${sw.key}|${p.name}|${i}`) - 0.5) * 6) * 10) / 10)]);
        }
      }
    }
  }
  return db.importNetHistory(db.LOCAL_AGENT, { devPort, xcvr, flap, lastLink, firstDay, util });
}

export function _resetForTest() { _seeded = false; _seeding = null; }
export const _backfillForTest = (servers, now) => backfillCvp(servers, now);
