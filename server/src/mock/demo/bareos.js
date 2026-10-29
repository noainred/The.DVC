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

/** 데모 설정(메모리) — 스냅샷의 vCenter 마다 사이트 매핑 1개. */
export function demoSettings(snapshot) {
  const sites = (snapshot?.vcenters || []).slice(0, 60).map((vc) => {
    const slug = slugOf(vc.id);
    return {
      vcenterId: vc.id,
      vcserver: `${slug}.vcenter.demo`,
      client: `${slug}-fd`, storage: `${slug}-sd`, pool: `VMware-${slug}`,
      schedule: demoHash(vc.id) % 4 === 0 ? 'VMwareWeekly' : 'VMwareNightly',
      configFile: `/etc/bareos/vmware/${slug}.ini`,
    };
  });
  return {
    version: 1,
    director: { host: 'bareos-dir.demo', port: 9101, consoleName: 'portal', timeoutMs: DEFAULTS.director.timeoutMs, tlsMax: 'TLSv1.3', password: '(demo)' },
    defaults: { ...DEFAULTS.defaults },
    sites,
  };
}

// ── 데모 Director 상태(메모리 — 재시작하면 '실행 중' 은 사라지고 과거 이력은 결정적으로 다시 만든다) ──
const S = { jobs: new Map(), runs: new Map(), nextId: 9000 };
export function _resetBareosDemoForTest() { S.jobs.clear(); S.runs.clear(); S.nextId = 9000; _seeded = false; }

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

/** 이름별 과거 이력(결정적): 최근 14일, 7일마다 Full · 나머지 Incremental · 일부 경고/실패. */
function historyOf(name, now = Date.now()) {
  const h = demoHash(name);
  const base = 100_000 + (h % 4000) * 20;
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
  return rows;
}

function liveRow(jobid, now = Date.now()) {
  const r = S.runs.get(jobid);
  if (!r) return null;
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

/** 명령 1개 처리 → JSON-RPC result(오류면 BareosConsoleError('jsonrpc')). */
export function demoCall(cmd, settings) {
  const fail = (m) => { throw new BareosConsoleError('jsonrpc', m); };
  const { kv, words } = parseArgs(cmd);
  const head = words[0] || '';
  const sites = settings?.sites || [];
  const uniq = (a) => [...new Set(a)].sort().map((name) => ({ name }));
  switch (head) {
    case '.clients': return { clients: uniq(sites.map((s) => s.client)) };
    case '.storages': return { storages: uniq(sites.map((s) => s.storage)) };
    case '.pools': return { pools: uniq([...sites.map((s) => s.pool), 'Scratch']) };
    case '.schedules': return { schedules: uniq(['VMwareNightly', 'VMwareWeekly']) };
    case '.jobdefs': return { jobdefs: uniq(['DefaultJob', DEFAULTS.defaults.jobDefs]) };
    case '.filesets': return { filesets: uniq(['Catalog', DEFAULTS.defaults.fileSet]) };
    case '.jobs': return { jobs: uniq([...S.jobs.keys(), 'BackupCatalog', 'RestoreFiles', DEFAULTS.defaults.restoreJob]) };
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
          ...(row.endtime ? [[row.endtime, `bareos-dir JobId ${id}: Termination: ${row.jobstatus === 'T' ? 'Backup OK' : row.jobstatus === 'W' ? 'Backup OK -- with warnings' : row.jobstatus === 'A' ? 'Backup Canceled' : 'Backup Error'}`]] : []),
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
      rows.sort((a, b) => b.jobid - a.jobid);
      return { jobs: rows.slice(0, lim) };
    }
    case 'cancel': { const r = S.runs.get(Number(kv.jobid)); if (!r) fail('No Jobs running.'); r.canceled = true; return { cancel: { jobid: Number(kv.jobid) } }; }
    case 'enable': case 'disable': { const j = S.jobs.get(kv.job); if (j) j.enabled = head === 'enable'; return { [head]: { job: kv.job } }; }
    default: fail(`demo: 지원하지 않는 명령입니다(${head}).`);
  }
  return null;
}

/** console.js 세션과 같은 모양(call·info·close). */
export function demoSession(settings) {
  return {
    demo: true,
    info: { tls: { protocol: 'TLSv1.3', cipher: 'TLS_AES_128_GCM_SHA256' }, banner: 'OK: bareos-dir Version: 25.0.4 (데모)', infoMessage: 'Bareos 데모 Director — 접속하지 않는 합성 응답입니다.' },
    call: async (cmd) => demoCall(cmd, settings),
    close() {},
  };
}

/** 원장에 이미 있는 데모 잡 이름을 데모 Director 에도 알린다(재시작 후 .jobs 대조가 '없음' 으로 보지 않게). */
export function registerDemoJobNames(names) { for (const n of names) if (n && !S.jobs.has(n)) S.jobs.set(n, { enabled: true }); }

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
