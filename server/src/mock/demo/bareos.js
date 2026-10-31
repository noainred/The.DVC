/**
 * mock/demo/bareos.js — 데모(DATA_SOURCE=mock) Bareos Director(v2.820).
 *
 * 규칙(mock/demo/flags.js 머리말과 같다)
 *  · mock 모드이고 **Director 설정이 비어 있을 때만** 쓴다(사람이 Director 를 등록하면 mock 모드에서도 실제 Director 에 붙는다).
 *  · 설정 파일은 바꾸지 않는다 — 데모 설정(demoSettings)은 메모리에서 스냅샷으로 만든다. 응답에 demo:true 를 싣는다.
 *  · 어디에도 접속하지 않는다. 명령 문자열을 실제 Director 와 같은 모양으로 받아 같은 모양(JSON-RPC result)으로 돌려준다 —
 *    라우트·폴러·화면이 실제 경로와 같은 코드를 탄다(console.js 만 건너뛴다).
 *  · 백업 대상 시드는 원장이 **비어 있을 때만** 1회(demo:true 표지 — live 폴러는 건너뛴다).
 */
import { isMockMode, demoHash } from './flags.js';
import { pushAll } from '../../util/pushAll.js';
import { DEFAULTS } from '../../bareos/settings.js';
import { BareosConsoleError } from '../../bareos/console.js';

const DAY = 86_400_000;
const slugOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'site';

/** 데모 법인 Director 수 상한 — 지역(region)마다 하나. */
const DEMO_MAX_DIRECTORS = 6;

/**
 * 데모 설정(메모리 · v2.823 법인별 Director) — 스냅샷 vCenter 의 지역(location.region)마다 데모 Director 하나, vCenter 마다 매핑 1개.
 * 데모 Director 들은 같은 메모리 Director 를 나눠 쓴다(잡 이름이 vCenter 마다 달라 섞이지 않는다 — 접속하지 않는 합성 응답).
 */
export function demoSettings(snapshot) {
  const directors = [];
  const byRegion = new Map();
  const sites = [];
  for (const vc of (snapshot?.vcenters || []).slice(0, 60)) {
    const region = String(vc.location?.region || vc.region || 'Global').slice(0, 40);
    let d = byRegion.get(region);
    if (!d) {
      if (directors.length >= DEMO_MAX_DIRECTORS) d = directors[directors.length - 1];
      else {
        const n = directors.length + 1;   // 지역 이름은 한글이라(util/regions.js) 순번으로 id·주소를 만든다
        d = { id: `dir_demo_${n}`, name: `${region} 법인(데모)`, host: `bareos-r${n}.demo`, port: 9101, consoleName: 'portal', timeoutMs: DEFAULTS.director.timeoutMs, tlsMax: 'TLSv1.3', password: '(demo)' };
        directors.push(d);
      }
      byRegion.set(region, d);
    }
    const slug = slugOf(vc.id);
    sites.push({
      vcenterId: vc.id, directorId: d.id,
      vcserver: `${slug}.vcenter.demo`,
      client: `${slug}-fd`, storage: `${slug}-sd`, pool: `VMware-${slug}`,
      schedule: demoHash(vc.id) % 4 === 0 ? 'VMwareWeekly' : 'VMwareNightly',
      configFile: `/etc/bareos/vmware/${slug}.ini`,
    });
  }
  return { version: 2, directors, defaults: { ...DEFAULTS.defaults }, sites };
}

// ── 데모 Director 상태(메모리 — 재시작하면 '실행 중' 은 사라지고 과거 이력은 결정적으로 다시 만든다) ──
// 새 실행 jobid 는 합성 이력(historyOf — 100000 + 최대 80000 + 13)보다 커야 한다: 실제 Director 의 jobid 는 단조 증가이고
//   포탈은 jobid 로 최신을 고른다(director.jobRuns·원장 lastRun). 9000 에서 시작하면 방금 실행이 이력 표 맨 뒤로 밀렸다(v2.822 화면 확인).
const FIRST_RUN_ID = 200_000;
const S = { jobs: new Map(), runs: new Map(), nextId: FIRST_RUN_ID, deleted: new Set() };   // deleted: v2.831 보관 개수 정리가 지운 jobid(카탈로그에서 사라진 것처럼)
export function _resetBareosDemoForTest() { S.jobs.clear(); S.runs.clear(); S.nextId = FIRST_RUN_ID; S.deleted.clear(); _seeded = false; _slots = null; _slotsKey = ''; }

/** lib/scan.cc next_arg 와 같은 규칙의 인자 분해. */
function parseArgs(cmd) {
  const out = []; let p = 0; const s = String(cmd);
  while (p < s.length) {
    while (p < s.length && /\s/.test(s[p])) p++;
    if (p >= s.length) break;
    let a = ''; let q = false;
    while (p < s.length) {
      const c = s[p];
      if (c === '\\') { p++; if (p < s.length) a += s[p++]; continue; }
      if (c === '"') { p++; q = !q; continue; }
      if (!q && /\s/.test(c)) { p++; break; }
      a += c; p++;
    }
    out.push(a);
  }
  const kv = {}; const words = [];
  for (const a of out) { const i = a.indexOf('='); if (i > 0) kv[a.slice(0, i).toLowerCase()] = a.slice(i + 1); else words.push(a.toLowerCase()); }
  return { kv, words };
}

/**
 * 카탈로그 시각 문자열 — Bareos 는 Director 의 **현지 시각**을 시간대 없이 낸다('YYYY-MM-DD HH:MM:SS'). 포탈(director.js)은 이를
 * 서버 현지 시각으로 읽으므로 데모도 현지 시각으로 만든다(UTC 문자열이면 한국 시각 서버에서 9시간 어긋난다).
 */
function catTime(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 이름 → 이력 jobid 칸(0..3999). v2.825.1 버그 점검(B2-3 — 재현): 해시 칸만 쓰면 두 이름이 같은 칸에 들어가(예: vm-47·vm-250)
 * 먼저 등록된 이름의 행이 돌아와 복원·로그가 '이 대상의 실행이 아니다' 로 거부됐다. 이름을 **정렬한 순서**로 해시 칸부터 비어 있는
 * 다음 칸을 쓴다(등록 순서와 무관하게 결정적 · 겹치지 않으면 예전 칸 그대로 · 범위 100000~179999 그대로).
 */
let _slots = null; let _slotsKey = '';
function slotOf(name) {
  // 칸 표는 잡 목록이 바뀔 때만 다시 만든다(데모 잡은 지워지지 않고 늘기만 한다 — 크기가 열쇠)
  if (!_slots || _slotsKey !== String(S.jobs.size) || !_slots.has(name)) {
    const names = [...new Set([...S.jobs.keys(), name])].sort();
    const used = new Set(); _slots = new Map();
    for (const n of names) { let k = demoHash(n) % 4000; while (used.has(k)) k = (k + 1) % 4000; used.add(k); _slots.set(n, k); }
    _slotsKey = String(S.jobs.size);
  }
  return _slots.get(name);
}

/** 이름별 과거 이력(결정적): 최근 14일, 7일마다 Full · 나머지 Incremental · 일부 경고/실패. */
function historyOf(name, now = Date.now()) {
  const h = demoHash(name);
  const base = 100_000 + slotOf(name) * 20;
  const rows = [];
  const today = Math.floor(now / DAY) * DAY;
  for (let d = 13; d >= 1; d--) {
    const jobid = base + (13 - d);
    const full = d === 13 || d === 6;
    const startedAt = today - d * DAY + (17 * 3_600_000) + ((h >>> 4) % 50) * 60_000; // 02:00 KST 전후(UTC 17시)
    const fullBytes = (30 + (h % 90)) * 1024 ** 3;
    const bytes = full ? fullBytes : Math.round(fullBytes * (0.02 + ((h >>> (d % 8)) % 7) / 100));
    const fail = h % 5 === 0 && d === 1;
    const warn = !fail && h % 3 === 0 && d === 2;
    rows.push({
      jobid, job: `${name}.demo`, name, type: 'B', level: full ? 'F' : 'I', jobstatus: fail ? 'f' : warn ? 'W' : 'T',
      starttime: catTime(startedAt),
      endtime: catTime(startedAt + (full ? 48 : 12) * 60_000),
      jobbytes: fail ? 0 : bytes, jobfiles: fail ? 0 : 3, joberrors: fail ? 1 : 0, client: '',
    });
  }
  return rows.filter((r) => !S.deleted.has(r.jobid));
}

function liveRow(jobid, now = Date.now()) {
  const r = S.runs.get(jobid);
  if (!r || S.deleted.has(jobid)) return null;
  const el = now - r.startAt;
  const st = r.canceled ? 'A' : el < 4_000 ? 'C' : el < 30_000 ? 'R' : 'T';
  const done = st === 'T' || st === 'A';
  const bytes = st === 'C' ? 0 : Math.round(r.bytes * Math.min(1, el / 30_000));
  return {
    jobid, job: `${r.name}.demo`, name: r.name, type: r.type, level: r.level, jobstatus: st,
    starttime: catTime(r.startAt),
    endtime: done ? catTime(r.startAt + Math.min(el, 30_000)) : '',
    jobbytes: bytes, jobfiles: done ? 3 : 0, joberrors: 0, client: r.client || '',
  };
}

function rowById(jobid) {
  const live = liveRow(jobid);
  if (live) return live;
  for (const name of S.jobs.keys()) { const r = historyOf(name).find((x) => x.jobid === jobid); if (r) return r; }
  return null;
}

const levelChar = (l) => (/^f/i.test(l) ? 'F' : /^d/i.test(l) ? 'D' : 'I');

/**
 * v2.839 정책 수집 데모 — 실측 모양(2026-11-01 · Director 25.1.2)과 같은 JSON(status scheduler · show schedules/jobdefs/filesets · llist pools · list volumes).
 *   그 Director 에 묶인 법인(sites)의 풀·잡만(데모 Director 들은 메모리를 나눠 쓰므로 directorId 로 거른다). 값은 이름 해시로 결정적.
 */
const DEMO_RUNS = Object.freeze({
  VMwareNightly: ['Full Sun at 23:00', 'Incremental Mon-Sat at 23:00'],
  VMwareWeekly: ['Full Sat at 01:00', 'Incremental Sun-Fri at 01:00'],
  WeeklyCycle: ['Full 1st Sat at 21:00', 'Differential 2nd-5th Sat at 21:00', 'Incremental Mon-Fri at 21:00'],
  WeeklyCycleAfterBackup: ['Full Mon-Fri at 21:10'],
});
function demoLevelAt(sched, d) {   // d: Date(서버 현지) — 그날 그 스케줄이 도는 레벨과 시각(안 돌면 null)
  const wd = d.getDay();
  if (sched === 'VMwareNightly') return { h: 23, m: 0, level: wd === 0 ? 'Full' : 'Incremental' };
  if (sched === 'VMwareWeekly') return { h: 1, m: 0, level: wd === 6 ? 'Full' : 'Incremental' };
  if (sched === 'WeeklyCycle') return wd === 6 ? { h: 21, m: 0, level: d.getDate() <= 7 ? 'Full' : 'Differential' } : wd === 0 ? null : { h: 21, m: 0, level: 'Incremental' };
  if (sched === 'WeeklyCycleAfterBackup') return wd >= 1 && wd <= 5 ? { h: 21, m: 10, level: 'Full' } : null;
  return null;
}
function demoPolicy(head, words, settings, directorId, now = Date.now()) {
  const sites = (settings?.sites || []).filter((s) => !directorId || s.directorId === directorId);
  const clients = new Set(sites.map((s) => s.client));
  const first = !directorId || (settings?.directors || [])[0]?.id === directorId;   // Director 자체 잡(카탈로그 백업)은 첫 데모 Director 에만
  if (head === 'status' && words[1] === 'scheduler') {
    const jobsOf = (sched) => [...S.jobs].filter(([, j]) => (j.schedule || '') === sched && clients.has(j.client)).map(([name, j]) => ({ name, enabled: j.enabled !== false }));
    const schedules = [
      { name: 'VMwareNightly', enabled: true, jobs: jobsOf('VMwareNightly') },
      { name: 'VMwareWeekly', enabled: true, jobs: jobsOf('VMwareWeekly') },
      ...(first ? [{ name: 'WeeklyCycle', enabled: true, jobs: [{ name: 'backup-bareos-fd', enabled: true }] }, { name: 'WeeklyCycleAfterBackup', enabled: true, jobs: [{ name: 'BackupCatalog', enabled: true }] }] : []),
    ];
    const preview = [];
    const p2 = (x) => String(x).padStart(2, '0');
    const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    for (let i = 0; i < 8; i++) {
      const base = new Date(now + i * DAY);
      for (const s of schedules) {
        const r = demoLevelAt(s.name, base);
        if (!r) continue;
        const at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), r.h, r.m, 0, 0);
        if (at.getTime() <= now || at.getTime() > now + 7 * DAY) continue;
        preview.push({ datetime: `${WD[at.getDay()]} ${p2(at.getDate())}-${MO[at.getMonth()]}-${at.getFullYear()} ${p2(r.h)}:${p2(r.m)}`, runtime: Math.floor(at.getTime() / 1000), schedule: s.name, level: r.level });
      }
    }
    preview.sort((a, b) => a.runtime - b.runtime);
    return { schedules, preview };
  }
  if (head === 'show' && words[1] === 'schedules') {
    return { schedules: Object.fromEntries(Object.entries(DEMO_RUNS).filter(([k]) => first || k.startsWith('VMware')).map(([name, run]) => [name, { name, ...(name === 'WeeklyCycleAfterBackup' ? { description: 'This schedule does the catalog. It starts after the WeeklyCycle.' } : {}), run }])) };
  }
  if (head === 'show' && words[1] === 'jobdefs') {
    const jd = { [DEFAULTS.defaults.jobDefs]: { name: DEFAULTS.defaults.jobDefs, type: 'Backup', level: 'Incremental', messages: 'Standard', fileset: DEFAULTS.defaults.fileSet, writebootstrap: '/var/lib/bareos/%c.bsr' },
      DefaultJob: { name: 'DefaultJob', type: 'Backup', level: 'Incremental', messages: 'Standard', storage: ['File'], pool: 'Incremental', fullbackuppool: 'Full', incrementalbackuppool: 'Incremental', differentialbackuppool: 'Differential', client: 'bareos-fd', fileset: 'SelfTest', schedule: 'WeeklyCycle', writebootstrap: '/var/lib/bareos/%c.bsr' } };
    if (!first) jd.AIJob = { name: 'AIJob', type: 'Backup', level: 'Incremental', pool: 'AI-Incremental', fullbackuppool: 'AI-Consolidated', incrementalbackuppool: 'AI-Incremental', alwaysincremental: true, alwaysincrementaljobretention: '7 days', alwaysincrementalkeepnumber: 7, alwaysincrementalmaxfullage: '21 days', priority: 10, maximumconcurrentjobs: 8 };
    return { jobdefs: jd };
  }
  if (head === 'show' && words[1] === 'filesets') {
    return { filesets: {
      [DEFAULTS.defaults.fileSet]: { name: DEFAULTS.defaults.fileSet, include: [{ options: [{ signature: 'XXH128', compression: 'LZ4', hardlinks: false, aclsupport: true, xattrsupport: true }], plugin: ['python3:module_name=bareos-fd-vmware'] }] },
      SelfTest: { name: 'SelfTest', description: 'fileset just to backup some files for selftest', include: [{ options: [{ signature: 'XXH128' }], file: ['/usr/sbin'] }] },
      LinuxAll: { name: 'LinuxAll', description: 'Backup all regular filesystems, determined by filesystem type.', include: [{ options: [{ signature: 'XXH128', onefs: false, fstype: ['ext4', 'xfs'] }], file: ['/'] }], exclude: [{ file: ['/var/lib/bareos'] }] },
    } };
  }
  const poolsOf = () => {
    const names = [...new Set(sites.map((s) => s.pool).filter(Boolean))];
    const rows = [{ name: 'Scratch', pooltype: 'Scratch', maxvols: 0, numvols: 0, volretention: 31536000, maxvolbytes: 0 }];
    for (const n of names) {
      const h = demoHash(n);
      const maxvols = 50 + (h % 4) * 50;
      const numvols = h % 5 === 0 ? maxvols : Math.min(maxvols, 8 + (h % 37));   // 해시 다섯 중 하나는 '가득 참'(상한 = 개수)
      rows.push({ name: n, pooltype: 'Backup', maxvols, numvols, volretention: [2592000, 7776000, 31536000][h % 3], maxvolbytes: 53687091200 });
    }
    if (first) rows.push({ name: 'Full', pooltype: 'Backup', maxvols: 100, numvols: 12, volretention: 31536000, maxvolbytes: 0 }, { name: 'Incremental', pooltype: 'Backup', maxvols: 100, numvols: 3, volretention: 2592000, maxvolbytes: 1073741824 });
    return rows.map((r, i) => ({ poolid: String(i + 1), name: r.name, numvols: String(r.numvols), maxvols: String(r.maxvols), useonce: '0', usecatalog: '1', acceptanyvolume: '0', volretention: String(r.volretention),
      voluseduration: '0', maxvoljobs: '0', maxvolbytes: String(r.maxvolbytes), autoprune: '1', recycle: '1', pooltype: r.pooltype, labelformat: r.pooltype === 'Scratch' ? '*' : `${r.name}-`, enabled: '1',
      scratchpoolid: '0', recyclepoolid: '0', labeltype: '0', prunablevolumes: '0', prunablejobs: '0', prunablebytes: '0' }));
  };
  if ((head === 'llist' || head === 'list') && words[1] === 'pools') {
    const rows = poolsOf();
    return { pools: head === 'llist' ? rows : rows.map(({ poolid, name, numvols, maxvols, pooltype, labelformat }) => ({ poolid, name, numvols, maxvols, pooltype, labelformat })) };
  }
  if (head === 'list' && words[1] === 'volumes') {
    const volumes = {}; let id = 1;
    for (const p of poolsOf()) {
      const n = Math.min(60, Number(p.numvols));
      if (!n) continue;
      const h = demoHash(p.name);
      const full = Number(p.numvols) >= Number(p.maxvols) && Number(p.maxvols) > 0;
      const rows = [];
      for (let i = 0; i < n; i++) {
        const st = full ? (i % 7 === 0 ? 'Used' : 'Full') : i === n - 1 ? 'Append' : (h + i) % 23 === 0 ? 'Error' : (h + i) % 5 === 0 ? 'Purged' : 'Full';
        const bytes = Number(p.maxvolbytes) > 0 ? Math.round(Number(p.maxvolbytes) * (st === 'Append' ? 0.3 : st === 'Purged' ? 0 : 0.92)) : 3145942 + i * 1000;
        rows.push({ mediaid: String(id++), volumename: `${p.name}-${String(i + 1).padStart(4, '0')}`, volstatus: st, enabled: '1', volbytes: String(bytes), volfiles: '0', volretention: p.volretention,
          recycle: '1', slot: '0', inchanger: '0', mediatype: 'File', lastwritten: catTime(now - (n - i) * DAY / 2), storage: 'File', hasencryptionkey: '0' });
      }
      volumes[p.name.toLowerCase()] = rows;
    }
    return { volumes };
  }
  return undefined;
}

/** 명령 1개 처리 → JSON-RPC result(오류면 BareosConsoleError('jsonrpc')). */
export function demoCall(cmd, settings, directorId = '') {
  const fail = (m) => { throw new BareosConsoleError('jsonrpc', m); };
  const { kv, words } = parseArgs(cmd);
  const head = words[0] || '';
  const sites = settings?.sites || [];
  const uniq = (a) => [...new Set(a)].sort().map((name) => ({ name }));
  const pol = demoPolicy(head, words, settings, directorId);   // v2.839 정책 수집 명령
  if (pol !== undefined) return pol;
  switch (head) {
    case '.clients': return { clients: uniq(sites.map((s) => s.client)) };
    case '.storages': return { storages: uniq(sites.map((s) => s.storage)) };
    case '.pools': return { pools: uniq([...sites.map((s) => s.pool), 'Scratch']) };
    case '.schedules': return { schedules: uniq(['VMwareNightly', 'VMwareWeekly']) };
    case '.jobdefs': return { jobdefs: uniq(['DefaultJob', DEFAULTS.defaults.jobDefs]) };
    case '.filesets': return { filesets: uniq(['Catalog', DEFAULTS.defaults.fileSet]) };
    case '.jobs': {   // 실제처럼 {name, enabled}(ua_dotcmds.cc DotJobsCmd — enabled 는 Director 메모리 값)
      const all = new Map([['BackupCatalog', true], ['RestoreFiles', true], [DEFAULTS.defaults.restoreJob, true]]);
      for (const [name, j] of S.jobs) all.set(name, j.enabled !== false);
      return { jobs: [...all].sort((a, b) => a[0].localeCompare(b[0])).map(([name, enabled]) => ({ name, enabled })) };
    }
    case '.bvfs_get_jobids': {
      const id = Number(kv.jobid);
      const row = rowById(id);
      if (!row) fail(`JobId ${id} not found.`);
      const hist = historyOf(row.name).filter((r) => r.jobid <= id && r.jobstatus !== 'f');
      let start = hist.length - 1;
      while (start > 0 && hist[start].level !== 'F') start--;
      const ids = hist.slice(start).map((r) => r.jobid);
      if (!ids.includes(id)) ids.push(id);
      return { jobids: ids.map((x) => ({ id: x })) };
    }
    case 'configure': {
      if (words[1] !== 'add' || words[2] !== 'job') fail('demo: configure add job 만 지원합니다.');
      const name = kv.name;
      if (S.jobs.has(name)) fail(`Resource "Job" with name "${name}" already exists.`);
      S.jobs.set(name, { ...kv, enabled: true });
      return { add: { resource: 'Job', name, filename: `/etc/bareos/bareos-dir.d/job/${name}.conf` } };
    }
    case 'run': {
      const name = kv.job;
      if (!S.jobs.has(name)) fail(`Job "${name}" not found.`);
      const jobid = S.nextId++;
      const h = demoHash(name);
      S.runs.set(jobid, { name, type: 'B', level: levelChar(kv.level), startAt: Date.now(), bytes: (levelChar(kv.level) === 'F' ? 30 + (h % 90) : 1 + (h % 6)) * 1024 ** 3, client: S.jobs.get(name).client });
      return { run: { jobid } };
    }
    case 'restore': {
      const ids = String(kv.jobid || '').split(',').map(Number).filter(Boolean);
      if (!ids.length) fail('demo: jobid 가 없습니다.');
      const jobid = S.nextId++;
      S.runs.set(jobid, { name: kv.restorejob || DEFAULTS.defaults.restoreJob, type: 'R', level: ' ', startAt: Date.now(), bytes: 20 * 1024 ** 3, client: kv.client });
      return { run: { jobid } };
    }
    case 'llist':
    case 'list': {
      if (words[1] === 'joblog') {
        const id = Number(kv.jobid);
        const row = rowById(id);
        if (!row) return { joblog: [] };
        // 카탈로그 Log 행 모양 — 시각은 time 칸, logtext 는 'daemon JobId N: …'(시각을 logtext 에 겹쳐 넣지 않는다).
        const lines = [
          [row.starttime, `bareos-dir JobId ${id}: Start ${row.type === 'R' ? 'Restore' : 'Backup'} JobId ${id}, Job=${row.job}`],
          [row.starttime, `bareos-dir JobId ${id}: Using Device "FileStorage" to write.`],
          [row.starttime, `demo-fd JobId ${id}: python-fd: bareos-fd-vmware: (데모) 스냅샷 생성 · CBT 변경 블록 읽기`],
          ...(row.jobstatus === 'f' ? [[row.endtime, `demo-fd JobId ${id}: Fatal error: python-fd: Error creating snapshot (데모)`]] : []),
          ...(row.jobstatus === 'W' ? [[row.endtime, `demo-fd JobId ${id}: Warning: quiesce 실패 — 정지점 없이 진행(데모)`]] : []),
          ...(row.endtime ? [[row.endtime, demoReport(id, row)]] : []),
        ];
        return { joblog: lines.map(([time, logtext]) => ({ time, logtext: `${logtext}\n` })) };
      }
      if (kv.jobid) { const r = rowById(Number(kv.jobid)); return { jobs: r ? [r] : [] }; }
      const lim = Math.max(1, Math.min(2000, Number(kv.limit) || 2000));
      const names = kv.job ? [kv.job] : [...S.jobs.keys()];
      const days = Number(kv.days) || 0;
      const cutoff = days ? Date.now() - days * DAY : 0;
      let rows = [];
      for (const n of names) {
        pushAll(rows, historyOf(n));   // 펼침 push 금지(인벤토리 규모 배열 — audit2603a 스윕)
        for (const id of S.runs.keys()) { const r = liveRow(id); if (r && r.name === n) rows.push(r); }
      }
      if (cutoff) rows = rows.filter((r) => Date.parse(r.starttime.replace(' ', 'T')) >= cutoff);
      // 실제 Director 와 같은 순서 — 시작 시각 오름차순 + LIMIT(가장 오래된 N건, sql_list.cc). 포탈이 받아서 최신 순으로 정렬한다(v2.822 W1).
      rows.sort((a, b) => a.starttime.localeCompare(b.starttime) || a.jobid - b.jobid);
      return { jobs: rows.slice(0, lim) };
    }
    case 'delete': {   // v2.831 — delete jobid=a,b,c(카탈로그 행 지우기). 끝나지 않은 실행은 실제처럼 거부하지 않지만 포탈은 보내지 않는다
      if (!kv.jobid) fail('demo: delete jobid= 만 지원합니다.');
      const ids = String(kv.jobid).split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
      for (const id of ids) if (rowById(id)) S.deleted.add(id);
      return { deleted: { jobids: ids } };
    }
    case 'cancel': { const r = S.runs.get(Number(kv.jobid)); if (!r) fail('No Jobs running.'); r.canceled = true; return { cancel: { jobid: Number(kv.jobid) } }; }
    case 'enable': case 'disable': {   // 모르는 잡은 실제처럼 거부한다(ua_cmds.cc — 'Job "X" not found.')
      const j = S.jobs.get(kv.job);
      if (!j) fail(`Job "${kv.job}" not found.`);
      j.enabled = head === 'enable';
      return { [head]: { jobs: [kv.job] } };
    }
    default: fail(`demo: 지원하지 않는 명령입니다(${head}).`);
  }
  return null;
}

/** 데모 Director 상태(평문 · v2.833.1) — 실행 중 잡 표(dird ua_status.cc 모양 · 추정). 막 시작한 실행은 'is waiting execution'. */
export function demoDirStatus(now = Date.now()) {
  const lines = ['bareos-dir Version: 25.0.4 (데모)', 'Running Jobs:', ' JobId  Type Level     Files     Bytes  Name              Status', '======================================================================'];
  let any = false;
  for (const [jobid, r] of S.runs) {
    if (r.canceled || S.deleted.has(jobid)) continue;
    const el = now - r.startAt;
    if (el >= 30_000) continue;
    any = true;
    const st = el < 4_000 ? 'is waiting execution' : 'is running';
    lines.push(`${String(jobid).padStart(6)}  ${r.type === 'R' ? 'Rest' : 'Back'} ${r.level === 'F' ? 'Full' : 'Incr'}          0         0  ${r.name}.${catTime(r.startAt).replace(' ', '_').replace(/:/g, '.')}_01 ${st}`);
  }
  if (!any) lines.push('No Jobs running.');
  lines.push('====');
  return lines.join('\n');
}

/** 데모 FD 상태(평문) — 실행 중(R) 데모 실행만(4초 미만은 Director 의 대기). 숫자는 천 단위 쉼표(Bareos edit_uint64_with_commas 모양). */
export function demoFdStatus(client, now = Date.now()) {
  const comma = (n) => Math.round(n).toLocaleString('en-US');
  const lines = [`${client} Version: 25.0.4 (데모)`, 'Running Jobs:'];
  let any = false;
  for (const [jobid, r] of S.runs) {
    if (r.type !== 'B' || r.canceled || S.deleted.has(jobid)) continue;
    if (r.client && r.client !== client) continue;
    const el = now - r.startAt;
    if (el < 4_000 || el >= 30_000) continue;   // 막 보낸 실행은 Director 만 안다('is waiting execution' — demoDirStatus 와 맞춘다)
    any = true;
    const sec = Math.max(1, el / 1000);
    const bytes = r.bytes * Math.min(1, el / 30_000);
    const ave = bytes / sec;
    lines.push(`JobId ${jobid} Job ${r.name}.${catTime(r.startAt).replace(' ', '_').replace(/:/g, '.')}_01 is running.`);
    lines.push(`    ${r.level === 'F' ? 'Full' : r.level === 'D' ? 'Differential' : 'Incremental'} Backup Job started: ${catTime(r.startAt)}`);
    lines.push(`    Files=${comma(3)} Bytes=${comma(bytes)} AveBytes/sec=${comma(ave)} LastBytes/sec=${comma(ave * (0.9 + (jobid % 5) / 20))} Errors=0`);
  }
  if (!any) lines.push('No Jobs running.');
  lines.push('====', '', 'Terminated Jobs:', ' JobId  Level    Files      Bytes   Status   Finished        Name', '====');
  return lines.join('\n');
}

/** console.js 세션과 같은 모양(call·info·close). */
export function demoSession(settings, directorId = '') {
  return {
    demo: true,
    info: { tls: { protocol: 'TLSv1.3', cipher: 'TLS_AES_128_GCM_SHA256' }, banner: 'OK: bareos-dir Version: 25.0.4 (데모)', infoMessage: 'Bareos 데모 Director — 접속하지 않는 합성 응답입니다.' },
    call: async (cmd) => demoCall(cmd, settings, directorId),
    // v2.833 진행 현황판: `status client=` 는 평문(FD 상태)을 돌려준다 — 실제와 같은 모양(filed/status.cc · 추정)으로 데모 실행 중 잡을 쓴다
    callRaw: async (cmd) => {
      if (String(cmd) === 'status director') return demoDirStatus();
      const m = /^status client=(\S+)$/.exec(String(cmd));
      if (!m) return JSON.stringify({ result: demoCall(cmd, settings) });
      return demoFdStatus(m[1]);
    },
    close() {},
  };
}

/** 원장에 이미 있는 데모 잡 이름을 데모 Director 에도 알린다(재시작 후 .jobs 대조가 '없음' 으로 보지 않게). */
export function registerDemoJobNames(names) {
  for (const x of names) {
    const n = typeof x === 'string' ? x : x?.name;
    if (!n) continue;
    const cur = S.jobs.get(n);
    // v2.839: 원장의 FD·스케줄도 알린다(정책 수집 데모의 status scheduler 가 재시작 뒤에도 잡을 스케줄에 넣게) — 이미 아는 값은 두고 빈 칸만
    const extra = typeof x === 'object' ? { ...(x.client ? { client: x.client } : {}), ...(x.schedule ? { schedule: x.schedule } : {}) } : {};
    if (!cur) S.jobs.set(n, { enabled: true, ...extra });
    else for (const [k, v] of Object.entries(extra)) if (!cur[k]) cur[k] = v;
  }
}

let _seeded = false;
/**
 * 원장이 비어 있으면 데모 대상 5개를 등록한다(mock 모드 · 1회). 실제 라우트와 같은 함수(createBackupTarget)를 부른다 —
 * 순환을 피하려고 호출부가 함수를 넘긴다.
 */
export async function ensureBareosDemo({ listJobs, createTarget, snapshot }) {
  if (_seeded || !isMockMode()) return { skipped: true };
  if (!snapshot?.vms?.length) return { skipped: 'no-snapshot' };
  _seeded = true;
  if (listJobs().length) return { skipped: 'not-empty' };
  const picks = []; const seenVc = new Set();
  for (const v of snapshot.vms) {
    if (picks.length >= 5) break;
    if (v.template || v.powerState !== 'POWERED_ON' || seenVc.has(v.vcenterId) || !v.vcDcPath || !v.folderPath) continue;
    if (!/^(db|app|web|mail|dc)-/.test(v.name || '')) continue;
    seenVc.add(v.vcenterId); picks.push(v);
  }
  let n = 0;
  for (const v of picks) {
    try { await createTarget({ vcenterId: v.vcenterId, vmId: v.id, level: 'Incremental', demo: true, by: 'demo' }); n++; } catch (e) { console.warn(`[mock] Bareos 데모 대상 등록 실패(${v.name}): ${e.message}`); }
  }
  if (n) console.log(`[mock] Bareos VM 백업 데모 대상 ${n}개 등록`);
  return { added: n };
}

/**
 * v2.822.3: 실제 Director 의 잡 끝 보고 블록 모양(dird backup.cc — 들여쓴 '키:  값' 줄)을 만든다. 화면의 '작업 결과' 요약(bareosText.parseJobReport)이
 * 데모에서도 실제와 같은 글을 읽게. 값은 이 행의 바이트·파일·시각에서만 만든다(지어낸 수치를 늘리지 않는다 — 압축률만 고정 표본).
 */
function demoReport(id, row) {
  const bytes = Number(row.jobbytes) || 0;
  const read = Math.round(bytes / 0.571);
  const fmt = (n) => n.toLocaleString('en-US');
  // Bareos edit_uint64_with_suffix 와 같은 괄호 값 — 쉼표 표기의 앞 두 덩어리를 '.' 로 잇고 5글자에서 자른다(190,492,305,747 → 190.4 GB).
  //   v2.828: 예전 toFixed(3)('10.230 GB')는 실제 Director 와 모양이 달라 화면 카드(괄호 값)와 계산 값('10.22 GB')이 어긋났다.
  const gb = (n) => {
    const parts = fmt(n).split(',');
    return parts.length < 2 ? `${parts[0]} B` : `${`${parts[0]}.${parts[1]}`.slice(0, 5)} ${'KMGTPE'[parts.length - 2]}B`;
  };
  const term = row.jobstatus === 'T' ? 'Backup OK' : row.jobstatus === 'W' ? 'Backup OK -- with warnings' : row.jobstatus === 'A' ? 'Backup Canceled' : 'Backup Error';
  const lvl = row.level === 'F' ? 'Full' : row.level === 'D' ? 'Differential' : 'Incremental';
  // 시각 두 개에서 소요·속도(실제 보고와 같은 표기) — 못 읽으면 줄을 비우지 않고 '0 secs'·'0.0 KB/s'(실제 Director 도 0 을 쓴다).
  const secs = Math.max(0, Math.round((Date.parse(String(row.endtime).replace(' ', 'T')) - Date.parse(String(row.starttime).replace(' ', 'T'))) / 1000)) || 0;
  const elapsed = secs >= 60 ? `${Math.floor(secs / 60)} mins ${secs % 60} secs` : `${secs} secs`;
  const rate = `${secs ? (bytes / 1000 / secs).toFixed(1) : '0.0'} KB/s`;
  if (row.type === 'R') {
    const ok = row.jobstatus === 'T' || row.jobstatus === 'W';
    return [
      `bareos-dir JobId ${id}: Bareos bareos-dir (demo):`,
      `  JobId:                  ${id}`,
      `  Job:                    ${row.job || row.name}`,
      '  Client:                 "demo-fd"',
      `  Start time:             ${row.starttime}`,
      `  End time:               ${row.endtime}`,
      `  Files Expected:         ${Number(row.jobfiles) || 0}`,
      `  Files Restored:         ${ok ? Number(row.jobfiles) || 0 : 0}`,
      `  Bytes Restored:         ${fmt(ok ? bytes : 0)} (${gb(ok ? bytes : 0)})`,
      '  FD Errors:              0',
      '  SD Errors:              0',
      `  FD termination status:  ${ok ? 'OK' : 'Error'}`,
      `  SD termination status:  ${ok ? 'OK' : 'Error'}`,
      `  Termination:            ${ok ? 'Restore OK' : row.jobstatus === 'A' ? 'Restore Canceled' : '*** Restore Error ***'}`,
    ].join('\n');
  }
  return [
    `bareos-dir JobId ${id}: Bareos bareos-dir (demo):`,
    `  JobId:                  ${id}`,
    `  Job:                    ${row.job || row.name}`,
    `  Backup Level:           ${lvl}`,
    '  Client:                 "demo-fd"',
    '  Pool:                   "Full" (From Job resource)',
    '  Storage:                "File" (From Job resource)',
    `  Start time:             ${row.starttime}`,
    `  End time:               ${row.endtime}`,
    `  FD Files Written:       ${Number(row.jobfiles) || 0}`,
    `  SD Files Written:       ${Number(row.jobfiles) || 0}`,
    `  FD Bytes Read:          ${fmt(read)} (${gb(read)})`,
    `  FD Bytes Written:       ${fmt(bytes)} (${gb(bytes)})`,
    `  SD Bytes Written:       ${fmt(bytes)} (${gb(bytes)})`,
    `  Elapsed time:           ${elapsed}`,
    `  Rate:                   ${rate}`,
    `  Software Compression:   ${bytes ? '42.9 % (lz4)' : 'None'}`,
    `  Volume name(s):         ${bytes ? 'Full-0009' : ''}`,
    `  Non-fatal FD errors:    ${Number(row.joberrors) || 0}`,
    `  SD Errors:              ${row.jobstatus === 'W' ? 1 : 0}`,
    `  FD termination status:  ${row.jobstatus === 'f' ? 'Fatal Error' : 'OK'}`,
    `  SD termination status:  ${row.jobstatus === 'f' ? 'Fatal Error' : 'OK'}`,
    '  Job triggered by:       User',
    `  Termination:            ${term}`,
  ].join('\n');
}
