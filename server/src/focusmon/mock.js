/**
 * focusmon/mock.js — 데모(mock) 모드의 가짜 대상과 표본(v2.976). DATA_SOURCE=mock 일 때만 쓴다 — SSH 를 열지 않는다.
 *
 * 시안(docs/design/focus-mon)과 같은 결정적 난수라 화면 확인(Chromium)이 매번 같은 모양을 본다. 실제 수집과 **같은 표본 모양**
 * (rates.computeSample 의 결과)을 만든다 — 화면 · 묶음 · DB 경로가 실데이터와 같은 길을 탄다.
 * 데모 대상 id 는 `fm-d0…` 로 시작한다(등록부의 `fm-<16진>` 과 겹치지 않게 0 다음 글자를 d 로 고정 — 등록부 id 는 무작위 16진이라 우연히 겹칠 수 있어
 * isDemoTarget 은 목록 소속으로 판정한다).
 */
import { IOSTAT_COLS, aggregateIostat, TOP_N } from './rates.js';

const frac = (x) => x - Math.floor(x);
const hash = (a, b) => frac(Math.sin(a * 127.1 + b * 311.7) * 43758.5453);
const smooth = (a, t) => (hash(a, t) + hash(a, t - 1) + hash(a, t - 2)) / 3;
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const wave = (base, amp, seed, t) => clamp(base + amp * 0.8 * Math.sin((t + seed * 13) / 19) + amp * 0.35 * Math.sin((t + seed * 5) / 5) + amp * 2.2 * (smooth(seed, t) - 0.5));
const r2 = (v) => Math.round(v * 100) / 100;

// 이름, IP, 담당(표시), CPU 기준·폭, 메모리, 네트워크 기준·폭, 디스크 사용률 기준·폭, 쓰기 지연 평소(ms), 코어 수
const DEF = [
  ['kr-db-01', '10.10.20.11', '', 62, 14, 88, 34, 10, 48, 18, 9.5, 32],
  ['kr-db-02', '10.10.20.12', '', 18, 6, 61, 12, 5, 14, 8, 1.5, 32],
  ['kr-was-01', '10.10.21.21', '', 44, 16, 72, 22, 9, 6, 4, 0.5, 16],
  ['kr-was-02', '10.10.21.22', '', 47, 15, 74, 24, 9, 7, 4, 0.5, 16],
  ['kr-web-01', '10.10.22.31', '', 12, 6, 38, 41, 14, 3, 2, 0.4, 8],
  ['kr-bak-01', '10.10.30.5', '', 28, 10, 52, 76, 10, 84, 8, 28, 16],
  ['kr-nfs-01', '10.10.31.7', '', 16, 6, 46, 37, 12, 52, 16, 11, 16],
  ['kr-mon-01', '10.10.40.9', '', 21, 8, 57, 6, 3, 11, 6, 1.0, 8],
  ['pl-db-01', '10.48.20.11', 'PL-WRO', 92, 4, 84, 29, 8, 71, 14, 21, 32],
  ['pl-was-01', '10.48.21.21', 'PL-WRO', 55, 14, 69, 19, 7, 5, 3, 0.5, 16],
  ['pl-was-02', '10.48.21.22', 'PL-WRO', 52, 14, 83, 18, 7, 5, 3, 0.5, 16],
  ['pl-bak-01', '10.48.30.5', 'PL-WRO', 9, 4, 31, 4, 2, 6, 4, 0.6, 8],
  ['pl-file-01', '10.48.31.7', 'PL-WRO', 14, 6, 44, 26, 10, 33, 14, 4.5, 8],
  ['pl-mes-01', '10.48.50.15', 'PL-WRO', 36, 12, 63, 11, 5, 17, 8, 1.4, 8],
  ['us-db-01', '10.64.20.11', 'US-ATL', 58, 12, 79, 23, 8, 44, 14, 7.6, 32],
  ['us-was-01', '10.64.21.21', 'US-ATL', 41, 14, 66, 17, 7, 4, 3, 0.4, 16],
  ['us-was-02', '10.64.21.22', 'US-ATL', 39, 12, 64, 15, 6, 4, 3, 0.4, 16],
  ['us-bak-01', '10.64.30.5', 'US-ATL', 11, 5, 35, 5, 3, 8, 5, 0.7, 8],
  ['us-file-01', '10.64.31.7', 'US-ATL', 17, 7, 48, 31, 11, 27, 12, 3.4, 8],
  ['us-mes-01', '10.64.50.15', 'US-ATL', 33, 11, 59, 9, 4, 15, 8, 1.9, 8],
];

/** 데모 대상(등록부 모양). agent 는 표시용 데모 엣지 이름 — 실제로는 이 노드가 만든다. */
/** 데모 그룹(v2.982) — 이름 가운데 칸으로(db · was · web · bak/nfs/file · mon · mes). */
const DEMO_GROUP = { db: 'DB', was: 'WAS', web: 'WEB', bak: '백업 파일', nfs: '백업 파일', file: '백업 파일', mon: '모니터링', mes: 'MES' };
export const DEMO_TARGETS = Object.freeze(DEF.map((d, i) => Object.freeze({
  id: `fm-d0${String(i).padStart(6, '0')}`, name: d[0], host: d[1], port: 22, username: 'dvcmon', agent: d[2], enabled: true, demo: true, createdAt: 0, createdBy: 'demo',
  group: DEMO_GROUP[String(d[0]).split('-')[1]] || '',
})));
const BY_ID = new Map(DEMO_TARGETS.map((t, i) => [t.id, i]));
export const isDemoTarget = (id) => BY_ID.has(String(id));

export function demoHello(id) {
  const i = BY_ID.get(String(id)) ?? 0;
  const d = DEF[i];
  return { kernel: 'Linux 3.10.0-1127.el7.x86_64 x86_64', isLinux: true, release: 'Red Hat Enterprise Linux Server release 7.8 (Maipo)', rhelMajor: '7.8',
    tck: 100, page: 4096, ncpu: d[11], hidepid: false, dacct: true, hostname: d[0] };
}

function diskRow(n, k, p, mp, sz, util, wAwait, rRatio, seed, t, extra = {}) {
  const busy = util / 100;
  const w = r2(busy * 4200 * (0.8 + 0.4 * hash(seed, t)));
  const r = r2(w * rRatio);
  const wMB = r2((w * (60 + 40 * hash(seed + 1, t))) / 1024);
  const rMB = r2((r * (32 + 20 * hash(seed + 2, t))) / 1024);
  const wa = w > 0 ? r2(wAwait * (0.75 + 0.5 * smooth(seed + 3, t))) : null;
  const ra = r > 0 ? r2((wAwait / 3) * (0.7 + 0.6 * hash(seed + 4, t))) : null;
  const ios = r + w;
  const v = new Array(IOSTAT_COLS.length).fill(null);
  v[0] = 0; v[1] = r2(w * 0.02); v[2] = r; v[3] = w; v[4] = rMB; v[5] = wMB;
  v[6] = ios > 0 ? r2(((rMB + wMB) * 2048) / ios) : null;
  v[7] = r2(((r * (ra || 0)) + (w * (wa || 0))) / 1000);
  v[8] = ios > 0 ? r2(((r * (ra || 0)) + (w * (wa || 0))) / ios) : null;
  v[9] = ra; v[10] = wa; v[11] = ios > 0 ? r2((util * 10) / ios) : null; v[12] = r2(util);
  return { n, dn: extra.dn || null, k, p, mp, sz, v, fl: Math.round(v[7]) };
}

/**
 * 데모 표본(서버 하나 · 시각 하나).
 * @param {string} id
 * @param {number} ts   ms
 * @param {number} interval 초
 */
export function demoSample(id, ts, interval = 2) {
  const i = BY_ID.get(String(id));
  if (i == null) return null;
  const d = DEF[i];
  const t = Math.floor(ts / 2000);
  const seed = i + 1;
  const cpu = wave(d[3], d[4], seed, t);
  const memPct = wave(d[5], 1.6, seed + 30, t);
  const netU = wave(d[6], d[7], seed + 60, t);
  const dskU = wave(d[8], d[9], seed + 90, t);
  const total = 256 * 2 ** 30 * (d[11] >= 32 ? 1 : 0.25);
  const used = (total * memPct) / 100;
  const ncores = d[11];
  const cores = [];
  for (let c = 0; c < ncores; c++) cores.push(r2(clamp(cpu + 18 * (hash(seed * 100 + c, t) - 0.5))));
  const bondSp = 20000;
  const rx = Math.round((netU / 100) * bondSp * 1e6);
  const tx = Math.round(rx * 0.62);
  const half = (x, f) => Math.round(x * f);
  const net = [
    { n: 'bond0', k: 'bond', sp: bondSp, st: 'up', m: null, md: '802.3ad', mem: ['eno1', 'eno2'], act: null, rx, tx, u: r2(netU), er: 0, dr: 0 },
    { n: 'eno1', k: 'phys', sp: 10000, st: 'up', m: 'bond0', md: null, mem: [], act: null, rx: half(rx, 0.52), tx: half(tx, 0.52), u: r2((half(Math.max(rx, tx), 0.52) / 1e10) * 100), er: 0, dr: 0 },
    { n: 'eno2', k: 'phys', sp: 10000, st: 'up', m: 'bond0', md: null, mem: [], act: null, rx: half(rx, 0.48), tx: half(tx, 0.48), u: r2((half(Math.max(rx, tx), 0.48) / 1e10) * 100), er: 0, dr: 0 },
    { n: 'bond1', k: 'bond', sp: 10000, st: 'up', m: null, md: 'active-backup', mem: ['ens2f0', 'ens2f1'], act: 'ens2f0', rx: half(rx, 0.05), tx: half(tx, 0.4), u: r2((half(tx, 0.4) / 1e10) * 100), er: 0, dr: 0 },
    { n: 'ens2f0', k: 'phys', sp: 10000, st: 'up', m: 'bond1', md: null, mem: [], act: null, rx: half(rx, 0.05), tx: half(tx, 0.4), u: r2((half(tx, 0.4) / 1e10) * 100), er: 0, dr: 0 },
    { n: 'ens2f1', k: 'phys', sp: 10000, st: 'up', m: 'bond1', md: null, mem: [], act: null, rx: 0, tx: 0, u: 0, er: 0, dr: 0 },
    { n: 'eno3', k: 'phys', sp: 1000, st: 'up', m: null, md: null, mem: [], act: null, rx: 1_200_000, tx: 2_100_000, u: 0.21, er: 0, dr: t % 97 === 0 ? 3 : 0 },
    { n: 'eno4', k: 'phys', sp: null, st: 'down', m: null, md: null, mem: [], act: null, rx: 0, tx: 0, u: null, er: 0, dr: 0 },
  ];
  const wa = d[10];
  const dsk = [];
  const sda = diskRow('sda', 'disk', null, '', 446 * 1e9, Math.min(5, dskU * 0.05), 1.4, 0.05, seed * 10 + 1, t);
  dsk.push(sda);
  dsk.push({ ...diskRow('sda1', 'part', 'sda', '/boot', 1e9, 0, 0, 0, seed * 10 + 2, t) });
  dsk.push({ ...sda, n: 'sda2', k: 'part', p: 'sda', mp: '' });
  dsk.push({ ...diskRow('dm-0', 'lvm', 'sda2', '/', 50e9, Math.min(3, dskU * 0.03), 1.2, 0.06, seed * 10 + 3, t), dn: 'rhel-root' });
  dsk.push({ ...diskRow('dm-2', 'lvm', 'sda2', '/var', 100e9, Math.min(3, dskU * 0.02), 1.5, 0.04, seed * 10 + 4, t), dn: 'rhel-var' });
  const sdb = diskRow('sdb', 'disk', null, '', 3.5e12, dskU, wa, 0.4, seed * 10 + 5, t);
  dsk.push(sdb);
  dsk.push({ ...sdb, n: 'sdb1', k: 'part', p: 'sdb', mp: '' });
  dsk.push({ ...sdb, n: 'dm-3', dn: 'oradata-data01', k: 'lvm', p: 'sdb1', mp: '/oradata' });
  const sdc = diskRow('sdc', 'disk', null, '', 1.7e12, dskU * 0.55, wa * 0.7, 0.01, seed * 10 + 6, t);
  dsk.push(sdc);
  dsk.push({ ...sdc, n: 'dm-4', dn: 'oraarch-arch01', k: 'lvm', p: 'sdc', mp: '/oraarch' });
  const sdd = diskRow('sdd', 'disk', null, '', 3.5e12, Math.min(12, dskU * 0.12), 3.0, 15, seed * 10 + 7, t);
  dsk.push(sdd);
  dsk.push({ ...sdd, n: 'sdd1', k: 'part', p: 'sdd', mp: '/backup' });
  // pl-db-01 의 sde 는 ‘응답 없음’(끝난 요청 0 · 걸린 요청 2 · 사용률 100%)을 가끔 보인다 — 화면 상태 확인용
  if (i === 8 && t % 60 < 8) {
    const v = new Array(IOSTAT_COLS.length).fill(null); v[0] = 0; v[1] = 0; v[2] = 0; v[3] = 0; v[4] = 0; v[5] = 0; v[7] = 2; v[12] = 100;
    dsk.push({ n: 'sde', dn: null, k: 'disk', p: null, mp: '', sz: 1.1e12, v, fl: 2, stuck: true });
  }
  const phys = dsk.filter((x) => x.k === 'disk');
  const dtot = aggregateIostat(phys);
  const usr = r2(cpu * 0.66); const sys = r2(cpu * 0.2); const iow = r2(Math.min(30, dskU * 0.15)); const stl = 0;
  return {
    dt: interval, cpu: { pct: r2(cpu), usr, sys, iow, stl, irq: r2(cpu * 0.02), cores },
    load: [r2((cpu / 100) * ncores * 1.1), r2((cpu / 100) * ncores), r2((cpu / 100) * ncores * 0.9)], run: Math.round((cpu / 100) * ncores), blk: Math.round(iow / 5), thr: 1200 + i * 10,
    mem: { pct: r2(memPct), total, used, avail: total - used, bc: total * 0.12, free: Math.max(0, total - used - total * 0.12), swT: 16 * 2 ** 30, swU: 0, dirty: 1.2 * 2 ** 30, slab: 6.4 * 2 ** 30, availSource: 'MemAvailable' },
    net, dsk, dtot, nPhys: phys.length,
  };
}

// [이름, 사용자, CPU 기준, 스레드, 서비스(v2.981 — 데모 세부 정보), 디스크 대기 기준 %]
const PROC_NAMES = [
  ['java', 'wasadm', 380, 12, 'tomcat.service', 2], ['oracleORCL', 'oracle', 99, 1, 'dbora.service', 6], ['ora_p001_ORCL', 'oracle', 96, 1, 'dbora.service', 4], ['ora_p003_ORCL', 'oracle', 95, 1, 'dbora.service', 4], ['ora_dbw0_ORCL', 'oracle', 61, 1, 'dbora.service', 18],
  ['ora_lgwr_ORCL', 'oracle', 38, 1, 'dbora.service', 22], ['bareos-sd', 'bareos', 160, 37, 'bareos-sd.service', 9], ['python3', 'mes', 140, 24, 'mes-worker.service', 1], ['nfsd', 'root', 47, 1, null, 3], ['smbd', 'root', 33, 1, 'smb.service', 2],
  ['nginx', 'nginx', 31, 1, 'nginx.service', 0], ['kworker_3:1', 'root', 8, 1, null, 0], ['sshd', 'root', 2, 1, 'sshd.service', 0], ['systemd', 'root', 1, 1, 'init.scope', 0], ['rsyslogd', 'root', 1, 3, 'rsyslog.service', 0],
  ['rsync', 'dvcmon', 20, 1, 'session-12.scope', 12],
];

/** 데모 프로세스 상위 30. v2.981: 세부 정보 칸(사용자/커널 · 부모 · 서비스 · 디스크 대기 · 읽기/쓰기는 수집 계정 dvcmon 의 프로세스만). */
export function demoProcs(id, ts) {
  const i = BY_ID.get(String(id));
  if (i == null) return null;
  const d = DEF[i];
  const t = Math.floor(ts / 5000);
  const load = d[3] / 60;
  const rows = [];
  for (let k = 0; k < 40; k++) {
    const pn = PROC_NAMES[(k + i) % PROC_NAMES.length];
    const cpu = r2(Math.max(0, pn[2] * load * (0.6 + 0.8 * hash(i * 50 + k, t)) * (k < 6 ? 1 : 0.4)));
    const pid = 1000 + ((i * 977 + k * 131) % 60000);
    const rss = r2(200 + 1800 * hash(i, k));
    const io = r2(pn[5] * (0.5 + hash(i * 7 + k, t)));
    const own = pn[1] === 'dvcmon'; // 수집 계정 소유 — /proc/<pid>/io 를 읽을 수 있다
    rows.push({
      pid, c: pn[0], u: pn[1], cpu, sh: r2(cpu / d[11]), rss, th: pn[3], et: 3600 * (1 + ((i + k) % 200)),
      us: r2(cpu * 0.82), sy: r2(cpu * 0.18), pp: pn[0] === 'systemd' ? 0 : pn[0].startsWith('kworker') ? 2 : 1, pc: pn[0] === 'systemd' ? null : pn[0].startsWith('kworker') ? 'kthreadd' : 'systemd',
      sv: pn[4], ns: null, ni: 0, st: cpu > 50 ? 'R' : 'S', vsz: r2(rss * 3.2), mf: r2(hash(i + k, t) * 2), io,
      rb: own ? r2(40 + 30 * hash(i * 3 + k, t)) : null, wb: own ? r2(5 + 4 * hash(i * 5 + k, t)) : null, sk: 50_000 + pid,
    });
  }
  const same = new Map(); for (const r of rows) same.set(r.c, (same.get(r.c) || 0) + 1);
  for (const r of rows) r.ns = same.get(r.c) + (r.c.startsWith('ora_') ? 30 : 0); // 데모: 오라클 백그라운드 프로세스는 상위 밖에도 더 있다
  rows.sort((a, b) => b.cpu - a.cpu || a.pid - b.pid);
  return { n: 420 + i * 13, top: rows.slice(0, TOP_N), da: true };
}
