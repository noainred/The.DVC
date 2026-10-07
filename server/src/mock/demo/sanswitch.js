/**
 * mock/demo/sanswitch.js — SAN 스위치 모니터링 데모(DATA_SOURCE=mock) 합성 데이터(v2.708).
 *
 * 무엇을 만드나
 *  · 법인(vCenter)마다 Brocade 스위치 6·8·10대(팹 A/B 쌍 — 팹마다 코어 1 + 엣지 N). 등록부는 **비어 있을 때만** 시드하고
 *    id 는 `mock-san-` 접두다(live 폴러는 그 접두를 건너뛴다).
 *  · 스위치 스냅샷은 **실제 FOS CLI 출력 모양의 텍스트**를 만들어 진짜 파서(`collectors/fosSsh.buildSnapshot`)에 넣는다 —
 *    스냅샷 모양을 손으로 지어내면 파서·판정이 바뀔 때 데모만 조용히 어긋난다. 그래서 포트·광량·에러 카운터·조닝(cfgshow·
 *    별칭·nsshow FC4 역할)·월간 점검 원천(sensorshow·errdump·bottleneckmon·fabricshow·islshow·trunkshow)이 전부 실제 경로로 읽힌다.
 *  · 조닝은 서버 HBA(메인 스냅샷의 ESXi 호스트 FC HBA — 형식이 맞지 않으면 합성) ↔ 스토리지 어레이 포트(합성 PowerMax·Unity·
 *    PowerStore)다. 어레이 WWN 의 OUI 접두는 실제 벤더 접두이고 나머지 바이트·시리얼은 **지어낸 값**이다(v2.513 픽스처 규약).
 *  · 포트 사용량(portperfshow 상당 — 바이트/초)은 결정적 함수(`sanDemoPortBps`)이고 시드 때 최근 7일을 perfDb 에 백필한다.
 *
 * 장비에 접속하지 않는다. 값은 이름 해시(demoHash)로 결정적이고 시간에 따라 조금 흔들린다.
 */
import { isMockMode, demoHash, demoRand, demoIp } from './flags.js';

export const SAN_DEMO_PREFIX = 'mock-san-';
export const isSanDemoId = (id) => String(id || '').startsWith(SAN_DEMO_PREFIX);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WWN_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){7}$/i;
/** 카운터 기준 시각(스위치 부팅 시각의 바탕) — 결정적이어야 재시작 뒤에도 카운터가 줄지 않는다. */
const EPOCH = Date.UTC(2026, 5, 1);

const hx = (n) => (n & 0xff).toString(16).padStart(2, '0');
const h3 = (seed) => { const h = demoHash(seed); return [hx(h >>> 16), hx(h >>> 8), hx(h)]; };
const wwnOf = (prefix5, seed) => [...prefix5, ...h3(seed)].join(':');
const shortOf = (vcId) => String(vcId || 'corp').replace(/^vc-/, '').replace(/[^A-Za-z0-9]+/g, '').toUpperCase().slice(0, 10) || 'CORP';
const pick = (arr, seed) => arr[demoHash(seed) % arr.length];

/* ───────────────────────── 계획(순수·결정적) ───────────────────────── */

const ARRAY_KINDS = ['powermax', 'unity', 'powerstore'];

function makeArray(vcId, i) {
  const seed = `${vcId}|array|${i}`;
  const kind = ARRAY_KINDS[(demoHash(vcId) + i) % ARRAY_KINDS.length];
  const h = demoHash(seed);
  if (kind === 'powermax') {
    const serial = `0001979${String(h % 100000).padStart(5, '0')}`;
    return { kind, serial, label: `PMAX_${serial.slice(-4)}`, ctl: ['1D', '2D'], symb: (c, p) => `SYMMETRIX::${serial}::FA-${c} ${p}::FC::5978_711`, prefix: ['50', '00', '09', '73', hx(h >>> 4)] };
  }
  if (kind === 'unity') {
    const serial = `APM00${String(h % 1e9).padStart(9, '0')}`;
    return { kind, serial, label: `UNITY_${serial.slice(-4)}`, ctl: ['SPA', 'SPB'], symb: (c, p) => `UNITY::${serial}::${c} FC${p}::FC::5.3.0`, prefix: ['50', '06', '01', '6' + (h % 8), hx(h >>> 4)] };
  }
  const serial = `PS${(h >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
  return { kind, serial, label: `PSTORE_${serial.slice(-4)}`, ctl: ['NodeA', 'NodeB'], symb: (c, p) => `PowerStore::${serial}::${c} FC${p}::FC::3.6.0`, prefix: ['58', 'cc', 'f0', '9' + (h % 8), hx(h >>> 4)] };
}

/** 호스트 HBA 두 개(팹 A/B). 메인 스냅샷의 FC HBA WWN 이 형식에 맞으면 그것을, 아니면 합성(Emulex OUI). */
function hostHbas(h, used) {
  const fc = (h.hbas || []).filter((x) => /fibre/i.test(String(x.type || '')));
  const out = [];
  for (let p = 0; p < 2; p++) {
    const real = fc[p];
    let wwn = real && WWN_RE.test(String(real.wwn || '')) ? String(real.wwn).toLowerCase() : '';
    if (!wwn || used.has(wwn)) wwn = wwnOf(['10', '00', '00', '10', '9b'], `${h.vcenterId}|${h.name}|${p}`);
    used.add(wwn);
    const sp = Number(real?.speedGbps);
    out.push({ wwn, hba: real?.name || `vmhba${p + 1}`, speed: sp >= 32 ? 32 : 16, model: String(real?.model || 'Emulex LPe32002').split(/\s+/).slice(0, 2).join(' ') });
  }
  return out;
}

/**
 * 메인 스냅샷 → 스위치 배치(순수). 같은 스냅샷이면 언제나 같은 결과다.
 * @returns {Array<object>} 스위치 layout 배열(장비 id 순)
 */
export function planSanDemo(snapshot = {}) {
  const vcs = (snapshot.vcenters || []).filter((v) => v && v.id);
  const hostsAll = snapshot.hosts || [];
  const layouts = [];
  for (const vc of vcs) {
    const vcId = String(vc.id);
    const short = shortOf(vcId);
    const n = [6, 8, 10][demoHash(`${vcId}|n`) % 3];
    const m = n / 2;                        // 팹당 스위치 수(코어 1 + 엣지 m-1)
    const arrays = Array.from({ length: 2 + (demoHash(`${vcId}|arrays`) % 2) }, (_, i) => makeArray(vcId, i));
    const used = new Set();
    const hosts = hostsAll.filter((h) => h && String(h.vcenterId) === vcId).sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map((h) => ({ name: String(h.name || 'host').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40), kind: 'host', hbas: hostHbas(h, used) }));
    for (const fab of ['A', 'B']) {
      const f = fab === 'A' ? 0 : 1;
      const sws = [];
      for (let k = 0; k < m; k++) {
        const id = `${SAN_DEMO_PREFIX}${vcId}-${fab}${k}`;
        const seed = id;
        const core = k === 0;
        const P = core ? (demoHash(`${seed}|P`) % 2 ? 128 : 96) : (demoHash(`${seed}|P`) % 2 ? 64 : 48);
        const pod = P >= 64 && demoHash(`${seed}|pod`) % 3 === 0 ? 16 : 0;
        sws.push({
          id, vcId, fabric: fab, k, core, seed, P, licensed: P - pod,
          name: `${short}-SAN-${fab}${String(k + 1).padStart(2, '0')}${core ? '-CORE' : ''}`,
          domain: k + 1,
          wwn: wwnOf(['10', '00', 'c4', 'f5', '7c'], `${seed}|sw`),
          model: P >= 96 ? 'G630' : 'G620', switchType: P >= 96 ? '173.0' : '162.0',
          fos: pick(['v9.1.1c', 'v9.2.0b', 'v9.1.1d'], `${vcId}|fos`),
          serial: `GEP${String(demoHash(`${seed}|serial`) % 1e7).padStart(7, '0')}`,
          host: demoIp(`${seed}|mgmt`, 10),
          bootAt: EPOCH + (demoHash(`${seed}|boot`) % (40 * 24)) * HOUR,
          psuFault: demoHash(`${seed}|psu`) % 23 === 0,
          ports: [],
        });
      }
      const coreSw = sws[0];
      const take = (sw) => { const i = sw._next ?? 0; sw._next = i + 1; return i; };
      // ① 어레이 포트(코어) — 어레이마다 컨트롤러 2 × 포트 2
      for (const a of arrays) {
        for (let c = 0; c < 2; c++) for (let p = 0; p < 2; p++) {
          const port = f * 2 + p;               // 팹 A = FC0/1, 팹 B = FC2/3
          coreSw.ports.push({ idx: take(coreSw), kind: 'array', speed: 32, role: 'target', array: a.label,
            wwn: wwnOf(a.prefix, `${a.serial}|${c}|${port}`), symb: a.symb(a.ctl[c], port), alias: `${a.label}_${a.ctl[c]}_FC${port}` });
        }
      }
      // ② ISL — 엣지마다 코어 쪽 2포트(트렁크)
      for (const e of sws.slice(1)) {
        for (let j = 0; j < 2; j++) {
          const ep = e.licensed - 1 - j;
          const cp = coreSw.licensed - 1 - ((e.k - 1) * 2 + j);
          const down = j === 1 && demoHash(`${e.seed}|trunkdown`) % 8 === 0;   // 트렁크 멤버 하나가 빠진 엣지(월간 점검 '주의')
          e.ports.push({ idx: ep, kind: down ? 'nolight' : 'isl', speed: 32, peer: { name: coreSw.name, domain: coreSw.domain, wwn: coreSw.wwn, port: cp }, islIdx: j });
          coreSw.ports.push({ idx: cp, kind: down ? 'nolight' : 'isl', speed: 32, peer: { name: e.name, domain: e.domain, wwn: e.wwn, port: ep }, islIdx: j });
        }
      }
      // ③ 서버 HBA — 호스트 i 는 스위치 i % m(같은 번호의 팹 A/B 스위치)에 붙는다
      const free = (sw) => sw.licensed - sw.ports.filter((p) => p.kind === 'isl' || p.kind === 'nolight').length - (sw._next ?? 0);
      const initiators = [];
      hosts.forEach((h, i) => {
        const sw = sws[i % m];
        if (free(sw) <= 4) return;
        const b = h.hbas[f];
        sw.ports.push({ idx: take(sw), kind: 'host', speed: b.speed, role: 'initiator', wwn: b.wwn,
          symb: `${h.name} ${b.hba} ${b.model}`, alias: `${h.name}_${b.hba}`.replace(/[^A-Za-z0-9_-]/g, '_'), hostName: h.name });
        initiators.push({ alias: `${h.name}_${b.hba}`.replace(/[^A-Za-z0-9_-]/g, '_'), wwn: b.wwn, hostName: h.name });
      });
      // ④ 베어메탈 서버(가상화 밖) — 스위치마다 사용률 40~65% 가 되게 채운다
      for (const sw of sws) {
        const target = Math.round(sw.licensed * (0.4 + 0.25 * demoRand(`${sw.seed}|fill`)));
        let j = 0;
        while (sw.ports.filter((p) => p.kind !== 'nolight').length < target && free(sw) > 4) {
          const nm = `bm-${short.toLowerCase()}-${sw.k + 1}${String(++j).padStart(2, '0')}`;
          const wwn = wwnOf(['21', '00', '00', '24', 'ff'], `${sw.seed}|bm|${j}|${f}`);
          const alias = `${nm}_hba${f}`;
          sw.ports.push({ idx: take(sw), kind: 'filler', speed: 16, role: 'initiator', wwn, symb: `${nm} QLE2692 FC${f}`, alias, hostName: nm });
          initiators.push({ alias, wwn, hostName: nm });
        }
      }
      // ⑤ 나머지 라이선스 포트 — 대부분 빈 포트(No_Light/No_Module), 일부 비활성·장애 / POD 미구매 포트
      for (const sw of sws) {
        const taken = new Set(sw.ports.map((p) => p.idx));
        const disabledAt = demoHash(`${sw.seed}|dis`) % 4 === 0;
        const faultyAt = demoHash(`${sw.seed}|flt`) % 9 === 0;
        let first = true;
        for (let i = 0; i < sw.P; i++) {
          if (taken.has(i)) continue;
          if (i >= sw.licensed) { sw.ports.push({ idx: i, kind: 'nolicense', speed: 32 }); continue; }
          let kind = demoHash(`${sw.seed}|empty|${i}`) % 3 === 0 ? 'nomodule' : 'nolight';
          if (first && faultyAt) kind = 'faulty';
          else if (first && disabledAt) kind = 'disabled';
          first = false;
          sw.ports.push({ idx: i, kind, speed: 32 });
        }
        sw.ports.sort((a, b) => a.idx - b.idx);
        // 문제 포트(결정적) — 광량 주의/이상·CRC 증가·병목
        const flist = sw.ports.filter((p) => p.kind === 'host' || p.kind === 'filler');
        const at = (tag) => (flist.length ? flist[demoHash(`${sw.seed}|${tag}`) % flist.length] : null);
        const r = demoHash(`${sw.seed}|prob`) % 100;
        if (r < 30) { const p = at('rxw'); if (p) p.rx = 'warn'; }
        if (r >= 30 && r < 42) { const p = at('rxb'); if (p) p.rx = 'bad'; }
        if (demoHash(`${sw.seed}|crc`) % 100 < 18) { const p = at('crc'); if (p) p.crc = true; }
        if (demoHash(`${sw.seed}|bn`) % 100 < 15) { const p = at('bn'); if (p) p.bottleneck = true; }
        for (const p of sw.ports) {
          const ps = `${sw.seed}|${p.idx}`;
          p.rxNormal = -(2 + 3 * demoRand(`${ps}|rx`));
          p.rxBase = p.rx === 'bad' ? -12.8 : p.rx === 'warn' ? -9.6 : p.rxNormal;
          // 광량 저하가 시작된 시각(결정적 — 점검 이력에서 '새로 생긴 문제' 로 보이게 최근 몇 주 안)
          p.rxSince = p.rx ? EPOCH + (95 + (demoHash(`${ps}|since`) % 30)) * DAY : 0;
          p.txBase = -(1.4 + 1.6 * demoRand(`${ps}|tx`));
          p.sfpTemp = 30 + Math.round(14 * demoRand(`${ps}|t`));
          p.avgBps = p.kind === 'array' ? 6e7 + 1.6e8 * demoRand(`${ps}|bw`)
            : p.kind === 'isl' ? 1.5e8 + 2.5e8 * demoRand(`${ps}|bw`)
              : p.kind === 'host' ? 4e6 + 5.6e7 * demoRand(`${ps}|bw`)
                : p.kind === 'filler' ? 2e6 + 2.8e7 * demoRand(`${ps}|bw`) : 0;
          p.addr = `${hx(sw.domain)}${hx(p.idx)}00`;
        }
      }
      // 조닝(패브릭 공통) — 단일 이니시에이터 zone: 서버 HBA ↔ 어레이 1~2대(컨트롤러별 1포트씩)
      const aliases = {};
      const arrPorts = new Map();   // label → [{alias,wwn}]
      for (const p of coreSw.ports.filter((x) => x.kind === 'array')) {
        aliases[p.alias] = [p.wwn];
        if (!arrPorts.has(p.array)) arrPorts.set(p.array, []);
        arrPorts.get(p.array).push(p);
      }
      const zones = [];
      for (const ini of initiators) {
        aliases[ini.alias] = [ini.wwn];
        const nArr = 1 + (demoHash(`${vcId}|${ini.hostName}|narr`) % 2);
        for (let a = 0; a < Math.min(nArr, arrays.length); a++) {
          const arr = arrays[(demoHash(`${vcId}|${ini.hostName}|arr`) + a) % arrays.length];
          const ps = arrPorts.get(arr.label) || [];
          const tgt = [ps[0], ps[2]].filter(Boolean);   // SPA·SPB(컨트롤러별) 1포트씩
          zones.push({ name: `z_${ini.alias}__${arr.label}`.slice(0, 64), members: [ini.alias, ...tgt.map((t) => t.alias)], wwns: [ini.wwn, ...tgt.map((t) => t.wwn)] });
        }
      }
      // 활성 설정에 없는 옛 zone 하나(조닝 그림의 '정의만 있는 zone' 진단용 — 일부 법인만)
      const stale = demoHash(`${vcId}|${fab}|stale`) % 2 === 0
        ? { name: `z_old_${short.toLowerCase()}_decom`, members: [wwnOf(['10', '00', '00', '10', '9b'], `${vcId}|decom|${fab}`), [...arrPorts.values()][0]?.[0]?.wwn].filter(Boolean) }
        : null;
      const cfgName = `cfg_${short.toLowerCase()}_fab${fab.toLowerCase()}`;
      const fabric = { vcId, fabric: fab, cfgName, zones, aliases, stale, switches: sws.map((s) => ({ name: s.name, domain: s.domain, wwn: s.wwn, host: s.host, core: s.core })) };
      for (const sw of sws) { delete sw._next; sw.fabricInfo = fabric; layouts.push(sw); }
    }
  }
  return layouts;
}

/** 배치 → 등록부 항목(비밀번호는 합성 — 접속하지 않는다). dcOf: vcenterId → 법인(DataCenter) id. */
export function sanDemoDevices(layouts = [], { dcOf = (id) => id, now = Date.now() } = {}) {
  return layouts.map((l) => ({
    id: l.id, type: 'brocade', name: l.name, host: l.host, username: 'admin', password: 'demo',
    agent: '', datacenterId: String(dcOf(l.vcId) || l.vcId), collectMethod: 'ssh', sshPort: 22, httpsPort: 443, vfId: null,
    enabled: true, note: '데모(mock) 합성 장비 — 실제 스위치가 아닙니다', createdAt: now, pulled: false,
  }));
}

/* ───────────────────────── CLI 출력 텍스트(실제 파서에 넣는다) ───────────────────────── */

const ONLINE = new Set(['array', 'host', 'filler', 'isl']);
const pad = (s, n) => String(s).padEnd(n);
const fmtDate = (ms) => {
  const d = new Date(ms + 9 * HOUR);   // 표기는 KST
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}-${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

/** 누적 프레임 카운터(단조 증가 — 도함수 fps×(1±0.5)). */
function frames(fps, sec, phase) {
  return Math.max(0, Math.floor(fps * sec + fps * 1800 * Math.sin(sec / 3600 + phase)));
}

function switchshowText(sw) {
  const fab = sw.fabricInfo;
  const lines = [
    `switchName:\t${sw.name}`, `switchType:\t${sw.switchType}`, 'switchState:\tOnline', 'switchMode:\tNative',
    `switchRole:\t${sw.core ? 'Principal' : 'Subordinate'}`, `switchDomain:\t${sw.domain}`, `switchId:\tfffc${hx(sw.domain)}`,
    `switchWwn:\t${sw.wwn}`, `zoning:\t\tON (${fab.cfgName})`, 'switchBeacon:\tOFF', 'FC Router:\tOFF', `Fabric Name:\tFAB_${fab.fabric}_${shortOf(sw.vcId)}`, '',
    'Index Port Address  Media Speed   State       Proto', '==================================================',
  ];
  for (const p of sw.ports) {
    const head = `${pad(String(p.idx).padStart(4), 5)}${pad(String(p.idx).padStart(4), 5)} ${p.addr}   `;
    if (ONLINE.has(p.kind)) {
      const tail = p.kind === 'isl' ? `E-Port  ${p.peer.wwn} "${p.peer.name}" (${sw.core ? 'downstream' : 'upstream'})(Trunk master)` : `F-Port  ${p.wwn}`;
      lines.push(`${head}id    N${p.speed}   Online      FC  ${tail}`);
    } else if (p.kind === 'nolight') lines.push(`${head}id    N32   No_Light    FC`);
    else if (p.kind === 'disabled') lines.push(`${head}id    N32   No_Light    FC  Disabled (Persistent)`);
    else if (p.kind === 'faulty') lines.push(`${head}id    N32   Laser_Flt   FC`);
    else if (p.kind === 'nomodule') lines.push(`${head}--    N32   No_Module   FC`);
    else lines.push(`${head}--    N32   No_License  FC`);
  }
  return lines.join('\n');
}

function porterrshowText(sw, t) {
  const sec = Math.max(1, (t - sw.bootAt) / 1000);
  const lines = [
    '          frames      enc    crc    crc    too    too    bad    enc   disc   link   loss   loss   frjt   fbsy',
    '       tx     rx      in    err    g_eof  shrt   long   eof     out   c3    fail    sync   sig',
    '     =================================================================================================',
  ];
  for (const p of sw.ports) {
    const on = ONLINE.has(p.kind);
    const fps = on ? p.avgBps / 1800 : 0;
    const ph = (demoHash(`${sw.seed}|${p.idx}|ph`) % 628) / 100;
    const tx = on ? frames(fps * 0.55, sec, ph) : 0;
    const rx = on ? frames(fps * 0.45, sec, ph + 1) : 0;
    // 누적 에러 잔재(링크 재협상·재부팅 흔적)는 일부 스위치에만 둔다 — 전 스위치에 두면 월간 점검이 전부 '주의' 가 된다.
    const dirty = demoHash(`${sw.seed}|dirty`) % 10 < 2;
    const h = dirty ? demoHash(`${sw.seed}|${p.idx}|err`) : 0;
    const crc = p.crc ? 12 + Math.floor((sec / 3600) * 0.7) : (dirty && on && h % 11 === 0 ? 1 : 0);
    const encIn = p.crc ? 30 + Math.floor((sec / 3600) * 1.4) : 0;
    const encOut = on ? h % 7 : (dirty && p.kind === 'nolight' ? 40 + (h % 200) : 0);
    const disc = p.bottleneck ? 200 + Math.floor((sec / 3600) * 9) : (on ? h % 3 : 0);
    const linkFail = on ? h % 2 : (p.kind === 'faulty' ? 6 : 0);
    const lossSync = dirty ? (on ? 1 + (h % 3) : (p.kind === 'nolight' ? 3 : 0)) : 0;
    const lossSig = dirty ? (on ? h % 2 : (p.kind === 'nolight' ? 2 : 0)) : 0;
    const vals = [tx, rx, encIn, crc, 0, 0, 0, 0, encOut, disc, linkFail, lossSync, lossSig, 0, 0];
    lines.push(`${String(p.idx).padStart(3)}: ${vals.map((v) => String(v).padStart(7)).join(' ')}`);
  }
  return lines.join('\n');
}

function sfpshowText(sw, t) {
  const out = [];
  const wob = Math.sin(t / 600_000) * 0.1;
  for (const p of sw.ports) {
    if (p.kind === 'nomodule' || p.kind === 'nolicense') continue;
    const lit = ONLINE.has(p.kind);
    const rx = lit ? Math.round(((t >= (p.rxSince || 0) ? p.rxBase : p.rxNormal) + wob) * 10) / 10 : null;
    const tx = p.kind === 'faulty' ? null : Math.round(p.txBase * 10) / 10;
    const uw = (dbm) => (dbm == null ? '0.0' : (1000 * 10 ** (dbm / 10)).toFixed(1));
    out.push(`Port ${String(p.idx).padStart(2)}:`, 'Identifier:  3    SFP', 'Connector:   7    LC', 'Transceiver: 5c00000000000000 8,16,32_Gbps M5,M5E,M6 sw Short_dist',
      'Vendor Name: BROCADE', 'Vendor PN:   57-1000485-01', `Serial No:   HAA${String(demoHash(`${sw.seed}|${p.idx}|sn`) % 1e8).padStart(8, '0')}`,
      'Wavelength:  850  (units nm)', `Temperature: ${p.sfpTemp} Centigrade`, 'Voltage:     3301.2 (mVolts)', 'Current:     7.234 (mAmps)',
      `TX Power:    ${tx == null ? '-inf dBm (0.0 uW)' : `${tx.toFixed(1)} dBm (${uw(tx)} uW)`}`,
      `RX Power:    ${rx == null ? '-inf dBm (0.0 uW)' : `${rx.toFixed(1)} dBm (${uw(rx)} uW)`}`, '');
  }
  return out.join('\n');
}

function nsshowText(sw) {
  const out = ['{', ' Type Pid    COS     PortName                NodeName                 TTL(sec)'];
  let n = 0;
  for (const p of sw.ports) {
    if (!(p.kind === 'array' || p.kind === 'host' || p.kind === 'filler')) continue;
    n++;
    const node = `20${p.wwn.slice(2)}`;
    out.push(` N    ${p.addr};      3;${p.wwn};${node}; na`, '    FC4s: FCP',
      `    PortSymb: [${p.symb.length}] "${p.symb}"`, `    Fabric Port Name: 20:${hx(p.idx)}:${sw.wwn.slice(6)}`, `    Permanent Port Name: ${p.wwn}`,
      `    Device type: ${p.role === 'target' ? 'Physical Target' : 'Physical Initiator'}`, `    Port Index: ${p.idx}`, '    Share Area: No', '    Redirect: No', '    Partial: No');
  }
  out.push(`The Local Name Server has ${n} entries }`);
  return out.join('\n');
}

function cfgshowText(fab) {
  const out = ['Defined configuration:'];
  const zl = fab.zones.map((z) => z.name);
  out.push(` cfg:\t${fab.cfgName}\t${zl.join('; ')}`);
  for (const z of fab.zones) out.push(` zone:\t${z.name}`, `\t\t${z.members.join('; ')}`);
  if (fab.stale) out.push(` zone:\t${fab.stale.name}`, `\t\t${fab.stale.members.join('; ')}`);
  for (const [a, w] of Object.entries(fab.aliases)) out.push(` alias:\t${a}`, `\t\t${w.join('; ')}`);
  out.push('', 'Effective configuration:', ` cfg:\t${fab.cfgName}`);
  for (const z of fab.zones) { out.push(` zone:\t${z.name}`); for (const w of z.wwns) out.push(`\t\t${w}`); }
  return out.join('\n');
}

function healthTexts(sw, t) {
  const faulty = sw.ports.some((p) => p.kind === 'faulty');
  const mon = (name, bad) => `${pad(`${name} monitor`, 32)}${bad ? 'MARGINAL' : 'HEALTHY'}`;
  const anyBad = faulty || sw.psuFault;
  const status = [
    `Switch Health Report                        Report time: ${fmtDate(t)}`, `Switch Name:\t${sw.name}`, `IP address:\t${sw.host}`,
    `SwitchState:\t${anyBad ? 'MARGINAL' : 'HEALTHY'}`, `Duration:\t${Math.floor((t - sw.bootAt) / HOUR)}:00`, '',
    mon('Power supplies', sw.psuFault), mon('Temperatures', false), mon('Fans', false), mon('WWN servers', false),
    mon('Flash', false), mon('Marginal ports', false), mon('Faulty ports', faulty), mon('Missing SFPs', false), mon('Error ports', false),
  ].join('\n');
  const fans = [1, 2, 3].map((i) => `Fan ${i} is Ok, speed is ${6800 + (demoHash(`${sw.seed}|fan${i}`) % 900)} RPM`).join('\n');
  const psus = [1, 2].map((i) => (sw.psuFault && i === 2 ? `Power Supply #${i} is faulty` : `Power Supply #${i} is OK V10, 4, 160`)).join('\n');
  const temps = [1, 2, 3].map((i) => 28 + (demoHash(`${sw.seed}|tmp${i}`) % 12) + Math.round(Math.sin(t / 3_600_000 + i)));
  const sensors = [
    ...temps.map((v, i) => `sensor  ${i + 1}: (Temperature) is Ok, value is ${v} C`),
    ...[1, 2, 3].map((i) => `sensor  ${i + 3}: (Fan        ) is Ok,speed is ${6800 + (demoHash(`${sw.seed}|fan${i}`) % 900)} RPM`),
    ...[1, 2].map((i) => `sensor  ${i + 6}: (Power Supply) is ${sw.psuFault && i === 2 ? 'Faulty' : 'Ok'}`),
  ].join('\n');
  const watt = 180 + (demoHash(`${sw.seed}|w`) % 160);
  const chassis = [
    `Chassis Family:\t${sw.model}`,
    ...[1, 2, 3].flatMap((i) => [`FAN  Unit: ${i}`, `Time Awake:\t${Math.floor((t - sw.bootAt) / DAY)} days`, '']),
    ...[1, 2].flatMap((i) => [`POWER SUPPLY  Unit: ${i}`, 'Power Source:\tAC', 'PS Voltage input:\t218.00 V',
      `Power Usage:\t${sw.psuFault && i === 2 ? '0' : `-${Math.round(watt / 2)}`}W`, 'Factory Part Num:\t23-0000154-01', `Factory Serial Num:\tPSU${String(demoHash(`${sw.seed}|ps${i}`) % 1e6).padStart(6, '0')}`, '']),
    'CHASSIS/WWN  Unit: 1', 'Factory Part Num:\t40-1000xxx-04', `Factory Serial Num:\t${sw.serial}`, `Serial Num:\tBRC${sw.serial}`,
    `ID:\tBRD0000C${hx(sw.domain).toUpperCase()}`, `Time Awake:\t${Math.floor((t - sw.bootAt) / DAY)} days`, `Time Alive:\t${Math.floor((t - sw.bootAt) / DAY) + 400} days`,
  ].join('\n');
  return { status, fans, psus, sensors, chassis };
}

function errdumpText(sw, t) {
  const lines = [];
  const at = (h) => fmtDate(t - h * HOUR);
  for (let i = 0; i < 8; i++) lines.push(`${at(70 - i * 9)}, [SEC-1203], ${1000 + i}, FID 128, INFO, ${sw.name}, Login information: Login successful via TELNET/SSH/RSH.`);
  lines.push(`${at(50)}, [ZONE-1022], 1100, FID 128, INFO, ${sw.name}, The effective configuration has changed to ${sw.fabricInfo.cfgName}.`);
  for (const p of sw.ports) {
    if (p.crc) lines.push(`${at(6)}, [C3-1012], 1200, FID 128, WARNING, ${sw.name}, Port ${p.idx} CRC errors detected on frames received (${p.hostName || ''}).`);
    if (p.rx === 'bad') lines.push(`${at(12)}, [SFP-1001], 1210, FID 128, WARNING, ${sw.name}, Port ${p.idx} RX power below low warning threshold.`);
    if (p.kind === 'faulty') lines.push(`${at(20)}, [PORT-1003], 1220, FID 128, ERROR, ${sw.name}, Port ${p.idx} Faulted because of SFP laser fault.`);
    if (p.bottleneck) lines.push(`${at(3)}, [AN-1010], 1230, FID 128, WARNING, ${sw.name}, Severe latency bottleneck detected at slot 0 port ${p.idx}.`);
  }
  if (sw.psuFault) lines.push(`${at(30)}, [EM-1034], 1300, FID 128, ERROR, ${sw.name}, Power Supply 2 set to faulty, rc=20004.`);
  lines.push(`${at(1)}, [SNMP-1008], 1400, FID 128, INFO, ${sw.name}, The last device change happened at : ${at(1)}`);
  return lines.join('\n');
}

function fabricTexts(sw) {
  const fab = sw.fabricInfo;
  const fabricshow = ['Switch ID   Worldwide Name           Enet IP Addr    FC IP Addr      Name',
    '-------------------------------------------------------------------------',
    ...fab.switches.map((s) => `${s.core ? '>' : ' '}${String(s.domain).padStart(2)}: fffc${hx(s.domain)} ${s.wwn} ${pad(s.host, 15)} 0.0.0.0         "${s.name}"`),
    '', `The Fabric has ${fab.switches.length} switches`].join('\n');
  const isls = sw.ports.filter((p) => p.kind === 'isl');
  const islshow = isls.length
    ? isls.map((p, i) => `${String(i + 1).padStart(2)}: ${String(p.idx).padStart(3)}-> ${String(p.peer.port).padStart(3)} ${p.peer.wwn} ${String(p.peer.domain).padStart(3)} ${p.peer.name} sp: 32.000G bw: ${isls.length > 1 ? '64.000G TRUNK' : '32.000G'} QOS`).join('\n')
    : 'No ISL found';
  const byPeer = new Map();
  for (const p of sw.ports.filter((x) => x.peer)) {
    if (!byPeer.has(p.peer.name)) byPeer.set(p.peer.name, []);
    if (p.kind === 'isl') byPeer.get(p.peer.name).push(p);
  }
  const groups = [...byPeer.values()].filter((g) => g.length);
  const trunkshow = groups.length
    ? groups.map((g, gi) => g.map((p, j) => `${j === 0 ? `${String(gi + 1).padStart(2)}: ` : '    '}${String(p.idx).padStart(3)}-> ${String(p.peer.port).padStart(3)} ${p.peer.wwn} ${String(p.peer.domain).padStart(3)} deskew ${15 + j} ${j === 0 ? 'MASTER' : ''}`.trimEnd()).join('\n')).join('\n')
    : 'No trunking links';
  const bn = sw.ports.filter((p) => p.bottleneck);
  const bottleneckmon = ['Bottleneck detection - Enabled', '==============================', 'Mode:                  Congestion and Latency',
    ...(bn.length ? ['List of bottlenecked ports in most recent interval:', ...bn.map((p) => ` ${p.idx}   Latency    Slow-drain   0.83`)] : ['No bottleneck ports detected in the most recent interval.'])].join('\n');
  return { fabricshow, islshow, trunkshow, bottleneckmon, lsanshow: 'FC Router is not enabled on this switch.' };
}

/** 장비 하나의 CLI 출력 묶음 — `fosSsh.buildSnapshot(device, out, {}, usedCmds)` 에 그대로 넣는다. */
export function sanDemoOutputs(sw, t = Date.now()) {
  const h = healthTexts(sw, t);
  const f = fabricTexts(sw);
  const lic = demoHash(`${sw.seed}|lic`).toString(16).toUpperCase().padStart(8, '0');
  const out = {
    switchshow: switchshowText(sw),
    chassisshow: h.chassis,
    firmwareshow: `Appl     Primary/Secondary Versions\n------------------------------------------\nFOS      ${sw.fos}\n         ${sw.fos}`,
    licenseshow: [`${lic}SbRZZ:`, '    Fabric license', '    Enhanced Group Management license', '    Fabric Vision license',
      ...(sw.P - sw.licensed < sw.P / 4 && sw.P > 48 ? ['    Ports on Demand license - additional 16 port upgrade'] : [])].join('\n'),
    porterrshow: porterrshowText(sw, t),
    sfpshow: sfpshowText(sw, t),
    switchstatusshow: h.status,
    fanshow: h.fans,
    psshow: h.psus,
    nsshow: nsshowText(sw),
    cfgshow: sw.fabricInfo._cfgText || (sw.fabricInfo._cfgText = cfgshowText(sw.fabricInfo)),   // 패브릭 공통·불변 — 한 번만 만든다
    sensorshow: h.sensors,
    errdump: errdumpText(sw, t),
    bottleneckmon: f.bottleneckmon,
    fabricshow: f.fabricshow,
    islshow: f.islshow,
    trunkshow: f.trunkshow,
    lsanshow: f.lsanshow,
  };
  const usedCmds = {};
  const label = { sfpshow: 'sfpshow -all', bottleneckmon: 'bottleneckmon --show', lsanshow: 'lsan --show' };
  for (const k of Object.keys(out)) usedCmds[k] = { cmd: label[k] || k, alt: false, paged: false, truncated: false, pages: null };
  return { out, usedCmds };
}

/**
 * 포트별 처리량(바이트/초 — portperfshow 원단위) at ts. 링크가 올라온 F-포트만(ISL·빈 포트는 싣지 않는다).
 * 낮(한국 시각 09~21시)에 오르고 밤에 내려가는 모양 + 5분 단위 흔들림.
 */
export function sanDemoPortBps(sw, ts = Date.now()) {
  const hourKst = (((ts / HOUR) + 9) % 24 + 24) % 24;
  const diurnal = 0.45 + 0.55 * Math.max(0, Math.sin(((hourKst - 6) / 24) * 2 * Math.PI)) + 0.12 * Math.sin((hourKst / 24) * 4 * Math.PI);
  const out = {};
  for (const p of sw.ports) {
    if (!(p.kind === 'array' || p.kind === 'host' || p.kind === 'filler')) continue;
    const noise = 0.8 + 0.4 * demoRand(`${sw.seed}|${p.idx}|${Math.floor(ts / 300_000)}`);
    out[p.idx] = Math.max(0, Math.round(p.avgBps * diurnal * noise));
  }
  return out;
}

/** 백필 시각(오름차순): 최근 24시간 10분 간격 + 2~3일 1시간 간격 + 4~7일 3시간 간격. 모든 장비가 같은 시각을 써 팹 A/B 합산 버킷이 어긋나지 않는다. */
export function sanDemoBackfillTimes(now = Date.now()) {
  const out = new Set();
  const step10 = 10 * 60_000;
  const end = Math.floor(now / step10) * step10;
  for (let t = end - DAY + step10; t <= end; t += step10) out.add(t);
  const hEnd = Math.floor((end - DAY) / HOUR) * HOUR;
  for (let t = hEnd - 2 * DAY + HOUR; t <= hEnd; t += HOUR) out.add(t);
  const h3End = Math.floor((hEnd - 2 * DAY) / (3 * HOUR)) * 3 * HOUR;
  for (let t = h3End - 4 * DAY + 3 * HOUR; t <= h3End; t += 3 * HOUR) out.add(t);
  return [...out].filter((t) => t < now).sort((a, b) => a - b);
}

/* ───────────────────────── 배치 캐시(장비 id → layout) ───────────────────────── */

let _layouts = null;   // Map(id → layout)
let _planSig = '';

/** 메인 스냅샷에서 배치를 만들고 캐시한다(vCenter·호스트 수가 바뀌면 다시 만든다). */
export function sanDemoLayouts(snapshot) {
  const sig = `${(snapshot?.vcenters || []).map((v) => v?.id).join(',')}|${(snapshot?.hosts || []).length}`;
  if (_layouts && sig === _planSig) return _layouts;
  _layouts = new Map(planSanDemo(snapshot || {}).map((l) => [l.id, l]));
  _planSig = sig;
  return _layouts;
}

/**
 * 장비 하나의 배치. 스냅샷 배치에 없으면(스냅샷이 바뀌었거나 아직 없음) 그 장비 id 만으로 만든 최소 배치(호스트 없음)를 쓴다 —
 * 등록부에 남은 데모 장비가 '수집 실패' 로 보이지 않게.
 */
export function sanDemoLayoutFor(device, snapshot) {
  const hit = sanDemoLayouts(snapshot).get(device.id);
  if (hit) return hit;
  const m = String(device.id).match(/^mock-san-(.+)-([AB])(\d+)$/);
  const vcId = m ? m[1] : `demo-${demoHash(device.id) % 1000}`;
  const one = planSanDemo({ vcenters: [{ id: vcId }], hosts: [] });
  return one.find((l) => l.id === device.id) || one[0];
}

/** 데모 상태(테스트용 초기화). */
export function _resetSanDemoForTest() { _layouts = null; _planSig = ''; _primed.clear(); _seed = null; _seedDone = null; _backfill = null; }

/* ───────────────────────── 스냅샷 조립 ───────────────────────── */

const _primed = new Set();

/**
 * 데모 스냅샷 — 실제 파서(buildSnapshot)를 거친다. 처리량(f/s)은 두 수집의 차이라 첫 조립 전에 5분 전 카운터로 한 번
 * 조립해 둔다(그래야 첫 화면부터 처리량이 보인다 — 값은 결정적 카운터에서 나온 실제 차이다).
 * @param buildSnapshot fosSsh.buildSnapshot(주입 — 이 모듈이 수집기를 import 하지 않게)
 */
export function buildSanDemoSnapshot(device, layout, buildSnapshot, t = Date.now()) {
  if (!_primed.has(device.id)) {
    const prev = sanDemoOutputs(layout, t - 5 * 60_000);
    buildSnapshot(device, prev.out, {}, prev.usedCmds, { countersAt: t - 5 * 60_000 });
    _primed.add(device.id);
  }
  const { out, usedCmds } = sanDemoOutputs(layout, t);
  const snap = buildSnapshot(device, out, {}, usedCmds, { countersAt: t });
  snap.datacenterId = device.datacenterId || '';
  snap.host = device.host || '';
  snap.collectedAt = t;
  snap.durationMs = 900 + (demoHash(`${device.id}|${Math.floor(t / 300_000)}`) % 2400);
  snap.extra = { ...(snap.extra || {}), demo: true, mock: true };
  return snap;
}

/* ───────────────────────── 시드(비어 있을 때만) ───────────────────────── */

let _seed = null;       // 진행 중 프라미스
let _seedDone = null;   // 결과
let _backfill = null;   // 백필 프라미스(테스트·상태용)

/** 백필이 끝날 때까지 기다린다(없으면 즉시). */
export function sanDemoBackfillDone() { return _backfill || Promise.resolve(0); }
/** 시드가 끝났으면(또는 할 필요가 없다고 확정했으면) 그 결과, 아니면 null. */
export function sanDemoDone() { return _seedDone; }
/** 데모 시드 상태(응답에 싣는다). */
export function sanDemoStatus() { return isMockMode() ? { demo: true, ...(_seedDone || {}) } : null; }

/**
 * mock 모드 1회 시드 — 등록부가 비어 있을 때만 장비를 넣고, 스냅샷을 즉시 만들고, 포트 사용량 7일을 백필한다.
 * live/auto 에서는 아무것도 하지 않는다(null). 메인 스냅샷에 vCenter 가 아직 없으면 다음 호출에서 다시 시도한다.
 * @param deps { snapshot, registry:{listDevices,seedDemoDevices}, putSnapshot, recordActivity, buildSnapshot, importSamples,
 *               recordRun, checkDevice, checkPorts(점검 이력 — 선택),
 *               dcOf, retentionDays, yieldFn, now }
 */
export function ensureSanDemo(deps = {}) {
  if (!isMockMode()) return null;
  if (_seedDone) return Promise.resolve(_seedDone);
  if (_seed) return _seed;
  _seed = (async () => {
    const { snapshot, registry, putSnapshot, recordActivity, buildSnapshot, importSamples, recordRun, checkDevice, checkPorts, dcOf = (id) => id,
      retentionDays = 90, yieldFn = () => new Promise((r) => setImmediate(r)), now = Date.now() } = deps;
    if (!(snapshot?.vcenters || []).length) return { waiting: true };
    if (registry.listDevices().length) { _seedDone = { seeded: 0, reason: 'registry-not-empty' }; return _seedDone; }
    const layouts = [...sanDemoLayouts(snapshot).values()];
    const devices = sanDemoDevices(layouts, { dcOf, now });
    const n = registry.seedDemoDevices(devices);
    if (!n) { _seedDone = { seeded: 0, reason: 'registry-not-empty' }; return _seedDone; }
    for (const d of devices) {
      const snap = buildSanDemoSnapshot(d, sanDemoLayouts(snapshot).get(d.id), buildSnapshot, now);
      putSnapshot(snap);
      try {
        const p = snap.ports || {};
        recordActivity({ deviceId: d.id, name: snap.name || d.name, host: d.host, source: 'central', ok: true,
          portsOnline: p.online ?? null, portsLicensed: p.licensed ?? null, portsFree: p.free ?? null, usedPct: p.usedPct ?? null,
          durationMs: snap.durationMs, error: null, at: now });
      } catch { /* 로그 기록 실패가 시드를 막지 않게 */ }
      await yieldFn();   // 장비 하나 조립 ≈ 20~40ms — 86대를 한 번에 돌면 이벤트 루프가 수 초 멈춘다
    }
    // 점검 이력(주 1회 · 최근 6주) — 같은 판정(checkDevice·checkPorts)을 과거 시각의 스냅샷에 돌려 기록한다.
    //   처리량 상태(rates)를 흐트러뜨리지 않게 별도 키로 조립하고 장비 id 를 되돌린다.
    if (recordRun && checkDevice) {
      for (const d of devices) {
        const lay = sanDemoLayouts(snapshot).get(d.id);
        for (let k = 6; k >= 1; k--) {
          const t = now - k * 7 * DAY;
          const { out, usedCmds } = sanDemoOutputs(lay, t);
          const snap = buildSnapshot({ ...d, id: `${d.id}~hist` }, out, {}, usedCmds, { countersAt: t });
          Object.assign(snap, { deviceId: d.id, collectedAt: t, datacenterId: d.datacenterId, host: d.host });
          try { await recordRun(checkDevice(snap, {}), { ports: checkPorts ? checkPorts(snap, {}) : null, at: t + 60_000 }); } catch { /* 이력 실패가 시드를 막지 않게 */ }
        }
        await yieldFn();
      }
    }
    // 포트 사용량 백필 — importSamples 로 2,000행씩 트랜잭션 · 사이마다 양보(이벤트 루프를 붙잡지 않게).
    //   기다리지 않는다 — 등록·스냅샷은 이미 끝났으니 화면이 바로 채워지고, 차트는 백필이 끝나는 대로 채워진다.
    const times = sanDemoBackfillTimes(now);
    _seedDone = { seeded: n, backfillPoints: times.length, backfill: importSamples ? 'running' : 'skipped', perfRows: 0 };
    if (importSamples) {
      _backfill = (async () => {
        let rows = 0;
        for (const d of devices) {
          const lay = sanDemoLayouts(snapshot).get(d.id);
          const last = times[times.length - 1];
          const meta = lay.ports.filter((p) => ONLINE.has(p.kind)).map((p) => ({ d: d.id, p: p.idx, ts: last, name: p.symb || '', wwn: p.wwn || p.peer?.wwn || '', speed: `${p.speed}G`, type: p.kind === 'isl' ? 'E-Port' : 'F-Port' }));
          // v2.715: 표본은 적재하지 않는다 — 조회가 포트 정보로 수식 값을 만든다(sanswitch/demoPerfSynth.js). 사양이 낮은 데모
          //   서버에서 86대 × 7일 표본(수십만 행)의 적재·집계가 화면을 1분 넘게 멈췄다. 포트 정보(연결 장비 이름)만 남긴다.
          const r = await importSamples([], meta, retentionDays);
          rows += Number(r?.inserted || 0);
          await yieldFn();
        }
        _seedDone.perfRows = rows; _seedDone.backfill = 'done';
        console.log(`[mock] SAN 스위치 데모 포트 정보 ${n}대 등록(포트 사용량은 조회 때 수식으로 만든다)`);
        return rows;
      })().catch((e) => { _seedDone.backfill = `failed: ${e.message}`; console.warn(`[mock] SAN 데모 백필 실패: ${e.message}`); return 0; });
    }
    console.log(`[mock] SAN 스위치 데모 시드: ${n}대(법인 ${new Set(devices.map((d) => d.datacenterId)).size}곳)`);
    return _seedDone;
  })().finally(() => { _seed = null; });
  return _seed;
}
