/**
 * audit2740c.test.js — v2.740 감사 그룹 c(파트 장애 장애별 · 전송 속도) 회귀.
 *
 *  B-01 키 이전(key-migrated)된 장애가 한 건으로 묶인다 — 손으로 만든 배열이 아니라 **applyTransition 이 쓴 실제 순서**로
 *  B-06 시작 조회로 찾은 열림이 기간 안이면 '기간 이전 시작(이월)' 이 아니다
 *  E-06 장애별 묶기·종류별 집계의 양보판은 동기판과 결과가 같고, 실제로 양보한다
 *  E-11 파트 장애 DB 상태는 COUNT·MIN·MAX 를 한 문장에 두지 않는다(행 수는 짧게 기억하고 적재 때 버린다)
 *  B-04 예약 처리 기록을 파일에 못 써도 같은 회차를 매 틱 다시 재지 않는다
 *  B-12 설정·예약 기록 파일을 '못 읽은 것'(일시 오류)을 손상으로 보고 원본을 치우지 않는다
 *  B-09 시계가 뒤로 가도(미래 시각 기록) 측정이 서고, 화면은 '정상' 이 아니라 '시계 어긋남' 이다
 *  B-13 최신 표는 원시 보존일이 아니라 일 요약 보존일로 정리한다
 *  D-04 범위 밖 숫자는 잘라 저장하지 않고 거절한다(서버·웹 RANGES 대조)
 *  E-01·E-02·E-04 조각 읽기는 한 문장 판과 결과가 같다 · CSV 동시 1건(409)·바이트 동일 · 메인·히트맵 기억 · 동시 요청 합류
 *  D-06 파트 장애 DB 불가 응답에도 kind 를 싣는다
 *
 * 기준 시각: 시계 판정이 없는 곳은 정시 −30분(CLAUDE.md v2.517). 미래·현재 시각 판정은 실제 시계를 쓴다(insertSamples 가 Date.now() 로 자른다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const WEB = path.resolve(HERE, '../../web/src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2740c-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'live';
process.env.PARTFAULT_DB_PATH = path.join(TMP, 'part-faults.db');
delete process.env.CENTRAL_URL;
delete process.env.XFER_SPEED_ENABLED;

const pfdb = await import('../src/partfault/db.js');
const inc = await import('../src/partfault/incidents.js');
const settings = await import('../src/xferspeed/settings.js');
const sched = await import('../src/xferspeed/schedule.js');
const xdb = await import('../src/xferspeed/db.js');
const an = await import('../src/xferspeed/analyze.js');
const poller = await import('../src/xferspeed/poller.js');

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MB = 1_048_576;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * MIN;

const SET_FILE = path.join(TMP, 'xfer-speed-settings.json');
const STATE_FILE = path.join(TMP, 'xfer-speed-schedule-state.json');

/** 콘솔 경고를 모은다(본문 경고 문구 단언용). */
async function captureWarn(fn) {
  const got = []; const orig = console.warn;
  console.warn = (...a) => got.push(a.join(' '));
  try { await fn(); } finally { console.warn = orig; }
  return got;
}
function writeSettings(obj) { fs.writeFileSync(SET_FILE, JSON.stringify(obj)); settings._resetXferSettingsForTest(); }
async function freshXferDb() {
  xdb._resetForTest();
  for (const f of [xdb.dbPath(), `${xdb.dbPath()}-wal`, `${xdb.dbPath()}-shm`]) fs.rmSync(f, { force: true });
}
function resetPoller() { poller._resetXferPollerForTest(); fs.rmSync(STATE_FILE, { force: true }); }
const kstHm = (ts) => { const d = new Date(ts + 540 * MIN); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const sample = (agent, dir, ts, o = {}) => ({ agent, dir, ts, ok: true, mbps: 50, bytes: MB, xferMs: 160, totalMs: 220, ttfbMs: 40, basis: 'receiver', trig: 'timer', ...o });

/* ─────────────────────────── 파트 장애 ─────────────────────────── */

const PF_BASE = { agent: '', scope: 'idrac', deviceId: '10.9.9.9', deviceName: 'hpe-1', kind: 'psu', partId: 'PSU.Slot.1', label: 'PSU 1', keyKind: 'slot' };
const OLD_KEY = 'idrac:SKU123:psu:PSU.Slot.1';
const NEW_KEY = 'idrac:SERIAL9:psu:PSU.Slot.1';

async function freshPf() {
  pfdb._resetForTest();
  for (const f of [process.env.PARTFAULT_DB_PATH, `${process.env.PARTFAULT_DB_PATH}-wal`, `${process.env.PARTFAULT_DB_PATH}-shm`]) fs.rmSync(f, { force: true });
}
/** transition.js 가 키 이전 때 내는 모양 그대로(감사 재현 b01) — 새 키 열림 + 옛 키 key-migrated 닫힘이 한 전이. */
async function migrateTx(at, firstSeenAt) {
  return pfdb.applyTransition({
    opened: [{ ...PF_BASE, partKey: NEW_KEY, state: 'fault', firstSeenAt, lastSeenAt: at, migratedFrom: OLD_KEY, prevState: 'fault' }],
    closed: [{ ...PF_BASE, partKey: OLD_KEY, state: 'fault', firstSeenAt, closedAt: at, closeReason: 'key-migrated', migratedTo: NEW_KEY }],
  }, { now: at });
}

test('B-01 키 이전 장애는 한 건 — applyTransition 의 실제 이벤트 순서(새 키 열림이 옛 키 닫힘보다 먼저)로', async () => {
  await freshPf();
  const T0 = NOW - 6 * HOUR; const T1 = NOW - 2 * HOUR;
  assert.equal((await pfdb.applyTransition({ opened: [{ ...PF_BASE, partKey: OLD_KEY, state: 'fault', firstSeenAt: T0, lastSeenAt: T0 }] }, { now: T0 })).saved, true);
  assert.equal((await migrateTx(T1, T0)).saved, true);
  const inp = await pfdb.incidentInputs({ sinceAbs: NOW - DAY });
  // 전제(감사 재현): DB 는 새 키 '열림' 을 옛 키 '닫힘' 보다 먼저(낮은 id) 쓴다 — 이 순서가 바뀌면 이 테스트의 의미가 바뀐다.
  const atT1 = inp.events.filter((e) => e.at === T1).map((e) => `${e.event}:${e.partKey === NEW_KEY ? 'new' : 'old'}`);
  assert.deepEqual(atT1, ['open:new', 'close:old'], '실제 기록 순서');
  const { incidents, stats } = inc.buildIncidents({ events: inp.events, openRows: inp.openRows, since: NOW - DAY, now: NOW, startLookup: inp.startLookup });
  assert.equal(incidents.length, 1, '같은 장애가 두 건으로 갈리지 않는다');
  assert.equal(stats.merged, 1);
  const i = incidents[0];
  assert.equal(i.partKey, NEW_KEY);
  assert.equal(i.migratedFrom, OLD_KEY);
  assert.equal(i.openedAt, T0, '시작은 옛 키의 열림');
  assert.equal(i.ongoing, true);
  const sum = inc.summarizeKinds(incidents, { since: NOW - DAY });
  assert.equal(sum.kinds.find((k) => k.kind === 'psu')?.incidents, 1, '종류별에서도 한 건');
});

test('B-01·B-06 기간 이전에 열린 장애의 키 이전 — 시작 조회는 옛 키로, 기간 이전이면 이월', async () => {
  await freshPf();
  const since = NOW - DAY;
  const Told = since - 3 * HOUR;   // 기간 이전 열림
  const T1 = NOW - 6 * HOUR; const T2 = NOW - 2 * HOUR;
  await pfdb.applyTransition({ opened: [{ ...PF_BASE, partKey: OLD_KEY, state: 'fault', firstSeenAt: Told, lastSeenAt: Told }] }, { now: Told });
  await migrateTx(T1, Told);
  await pfdb.applyTransition({ closed: [{ ...PF_BASE, partKey: NEW_KEY, state: 'fault', firstSeenAt: Told, closedAt: T2, closeReason: 'ok', prevState: 'fault' }] }, { now: T2 });
  const inp = await pfdb.incidentInputs({ sinceAbs: since });
  const { incidents } = inc.buildIncidents({ events: inp.events, openRows: inp.openRows, since, now: NOW, startLookup: inp.startLookup });
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].openedAt, Told, '새 키에는 그 이전 열림이 없다 — 옛 키로 찾는다');
  assert.equal(incidents[0].startUnknown, false);
  assert.equal(incidents[0].startedBefore, true, '기간 이전 시작');
  assert.equal(incidents[0].closedAt, T2);
});

test('B-06 상한으로 잘려 첫 이벤트가 변화여도, 찾은 열림이 기간 안이면 새로 시작한 장애다', () => {
  const since = NOW - 7 * DAY;
  const base = { agent: '', partKey: 'idrac:SVC:disk:D1', scope: 'idrac', deviceId: '10.0.0.5', kind: 'disk', label: 'Disk 1' };
  const { incidents } = inc.buildIncidents({
    since, now: NOW,
    events: [{ ...base, at: NOW - 3 * DAY, event: 'change', state: 'fault', prevState: 'warn' }, { ...base, at: NOW - 2 * DAY, event: 'close', prevState: 'fault', closeReason: 'ok' }],
    startLookup: () => ({ at: NOW - 5 * DAY, state: 'warn' }),
  });
  assert.equal(incidents[0].openedAt, NOW - 5 * DAY);
  assert.equal(incidents[0].startedBefore, false, '열림이 기간 안');
  const k = inc.summarizeKinds(incidents, { since }).kinds[0];
  assert.equal(k.started, 1);
  assert.equal(k.carried, 0);
});

/** 합성 이벤트 — 부품 n개, 열림·변화·닫힘, 일부는 키 이전(실제 기록 순서: 새 키 열림 → 옛 키 닫힘). 시간 오름차순. */
function synthEvents(n) {
  const out = []; let id = 0;
  const base0 = NOW - 20 * DAY;
  const kinds = ['disk', 'psu', 'fan', 'memory', 'nic'];
  for (let p = 0; p < n; p += 1) {
    const b = { agent: p % 3 ? '' : 'edge-a', scope: 'idrac', deviceId: `10.0.${p % 250}.${p % 7}`, deviceName: `srv-${p % 400}`, kind: kinds[p % 5], label: `Part ${p}`, keyKind: 'slot' };
    const key = `idrac:S${p}:${b.kind}:P${p}`;
    const t0 = base0 + (p % 4000) * 3 * MIN;
    out.push({ id: ++id, at: t0, event: 'open', partKey: key, ...b, state: 'warn' });
    if (p % 2) out.push({ id: ++id, at: t0 + 10 * MIN, event: 'change', partKey: key, ...b, state: 'fault', prevState: 'warn' });
    if (p % 5 === 0) {   // 키 이전
      const nk = `${key}:v2`;
      out.push({ id: ++id, at: t0 + 20 * MIN, event: 'open', partKey: nk, ...b, state: 'fault' });
      out.push({ id: ++id, at: t0 + 20 * MIN, event: 'close', partKey: key, ...b, prevState: 'fault', closeReason: 'key-migrated' });
      if (p % 10 === 0) out.push({ id: ++id, at: t0 + 40 * MIN, event: 'close', partKey: nk, ...b, prevState: 'fault', closeReason: 'ok' });
    } else if (p % 3 === 0) out.push({ id: ++id, at: t0 + 30 * MIN, event: 'close', partKey: key, ...b, prevState: 'fault', closeReason: 'ok' });
  }
  return out.sort((x, y) => x.at - y.at || x.id - y.id);
}

test('E-06 양보판 = 동기판(같은 생성기) · 실제로 양보한다 · 양보 사이 간격은 전체보다 훨씬 짧다', async () => {
  const events = synthEvents(30_000);
  const p = { events, openRows: [], since: NOW - 30 * DAY, now: NOW, startLookup: () => null };
  const t0 = performance.now();
  const sync = inc.buildIncidents(p);
  const syncSum = inc.summarizeKinds(sync.incidents, { since: p.since });
  const syncMs = performance.now() - t0;
  let calls = 0; let last = performance.now(); let maxGap = 0;
  const yielder = async () => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); calls += 1; await new Promise((r) => setImmediate(r)); last = performance.now(); };
  const asy = await inc.buildIncidentsAsync(p, { yielder });
  const asySum = await inc.summarizeKindsAsync(asy.incidents, { since: p.since }, { yielder });
  sameBig(asy.incidents, sync.incidents, '묶기 결과가 같다');
  assert.ok(isDeepStrictEqual(asy.stats, sync.stats), '묶기 통계가 같다');
  assert.ok(isDeepStrictEqual(asySum, syncSum), '종류별 집계가 같다');
  assert.ok(sync.stats.merged > 0, '합성 입력에 키 이전이 들어 있어야 한다');
  assert.ok(calls >= 10, `양보 횟수 ${calls}`);
  // 회귀(양보 없음)면 maxGap ≈ 전체 시간이다. 비율로 판정한다(절대 시간은 CPU 에 따라 흔들린다).
  assert.ok(maxGap * 3 < syncMs, `양보 사이 최장 ${maxGap.toFixed(1)}ms · 동기 전체 ${syncMs.toFixed(1)}ms`);
});

test('E-11 DB 상태 — MIN·MAX 단독 문장 · 행 수는 기억하되 적재하면 버린다', async () => {
  await freshPf();
  const T0 = NOW - 5 * HOUR;
  await pfdb.applyTransition({ opened: [{ ...PF_BASE, partKey: OLD_KEY, state: 'fault', firstSeenAt: T0, lastSeenAt: T0 }] }, { now: T0 });
  const raw = new DatabaseSync(process.env.PARTFAULT_DB_PATH);
  const direct = () => ({ n: raw.prepare('SELECT COUNT(*) n FROM part_event').get().n, mn: raw.prepare('SELECT MIN(at) v FROM part_event').get().v, mx: raw.prepare('SELECT MAX(at) v FROM part_event').get().v });
  let st = await pfdb.partFaultDbStatus();
  let d = direct();
  assert.equal(st.rows, d.n); assert.equal(st.mn, d.mn); assert.equal(st.mx, d.mx);
  assert.ok(Number.isFinite(st.rowsAt), '기억한 값임을 시각으로 밝힌다');
  await pfdb.applyTransition({ closed: [{ ...PF_BASE, partKey: OLD_KEY, state: 'fault', firstSeenAt: T0, closedAt: NOW - HOUR, closeReason: 'ok', prevState: 'fault' }] }, { now: NOW - HOUR });
  st = await pfdb.partFaultDbStatus();
  d = direct();
  assert.equal(st.rows, d.n, '적재 뒤에는 새로 센다(방금 넣은 행이 안 보이면 저장이 안 된 줄 안다)');
  assert.equal(st.mx, NOW - HOUR);
  raw.close();
  const src = fs.readFileSync(path.join(SRC, 'partfault/db.js'), 'utf8');
  for (const m of src.matchAll(/db\.prepare\((['"`])([\s\S]*?)\1\)/g)) {
    const sql = m[2].toUpperCase();
    const aggs = ['COUNT(', 'MIN(', 'MAX('].filter((a) => sql.includes(a)).length;
    if (/FROM PART_EVENT/.test(sql) && !/WHERE/.test(sql)) assert.ok(aggs <= 1, `전체 표 집계는 한 문장에 하나 — ${m[2].slice(0, 80)}`);
  }
});

/* ─────────────────────────── 전송 속도 — 예약 기록 ─────────────────────────── */

test('B-04 예약 처리 기록을 못 써도(디스크 가득) 같은 회차를 매 틱 다시 재지 않는다 · 쓰기가 되면 다시 쓴다', async () => {
  await freshXferDb(); resetPoller();
  const now0 = Date.now();
  writeSettings({ enabled: true, intervalOn: false, schedules: [{ id: 's-a1', kind: 'daily', time: kstHm(now0 - 5 * MIN), enabled: true, since: now0 - DAY }] });
  const realRename = fs.renameSync;
  fs.renameSync = (a, b) => { if (String(b).endsWith('xfer-speed-schedule-state.json')) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); return realRename(a, b); };
  let runs = 0; let warns = [];
  try {
    warns = await captureWarn(async () => {
      for (let i = 0; i < 6; i += 1) {
        const r = await poller.tickXferSchedule({ now: now0 + i * MIN });
        if (r.started) { runs += 1; await r.promise; }
      }
    });
  } finally { fs.renameSync = realRename; }
  assert.equal(runs, 1, `유예 30분 안의 6틱 동안 측정 주기 ${runs}회`);
  assert.ok(warns.some((w) => /예약 처리 기록을 파일에 쓰지 못했습니다/.test(w) && /메모리/.test(w)), '쓰기 실패를 콘솔에 남긴다');
  assert.equal(fs.existsSync(STATE_FILE), false, '쓰기 실패 중에는 파일이 없다(전제)');
  const r = await poller.tickXferSchedule({ now: now0 + 7 * MIN });
  assert.ok(!r.started, '쓰기가 돌아와도 다시 재지 않는다');
  assert.ok(fs.existsSync(STATE_FILE), '다음 틱에 기록을 다시 쓴다');
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).schedules['s-a1'];
  assert.equal(saved.result, 'ran');
});

test('B-12 예약 기록 파일을 못 읽은 것(EACCES)은 손상이 아니다 — 원본을 옮기지 않고, 기록 없이 예약을 판정하지 않는다', async () => {
  await freshXferDb(); resetPoller();
  const now0 = Date.now();
  writeSettings({ enabled: true, intervalOn: false, schedules: [{ id: 's-b1', kind: 'daily', time: kstHm(now0 - 5 * MIN), enabled: true, since: now0 - DAY }] });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ v: 1, schedules: {} }));
  const realRead = fs.readFileSync;
  fs.readFileSync = (p, ...a) => { if (String(p).endsWith('xfer-speed-schedule-state.json')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); return realRead(p, ...a); };
  let r; let warns;
  try { warns = await captureWarn(async () => { r = await poller.tickXferSchedule({ now: now0 }); }); } finally { fs.readFileSync = realRead; }
  assert.ok(!r.started, '기록을 못 읽었고 이 프로세스의 기록도 없으면 예약을 판정하지 않는다');
  assert.equal(fs.readdirSync(TMP).some((n) => n.startsWith('xfer-speed-schedule-state.json.corrupt.')), false, '원본을 손상으로 옮기지 않는다');
  assert.ok(fs.existsSync(STATE_FILE), '원본은 그대로');
  assert.ok(warns.some((w) => /손상이 아니라/.test(w)));
  const r2 = await poller.tickXferSchedule({ now: now0 + MIN });
  assert.ok(r2.started, '읽기가 돌아오면 예정대로 잰다');
  await r2.promise;
});

test('B-12 설정 파일을 못 읽은 것(EMFILE)은 손상이 아니다 — 직전 값으로 동작, 직전 값이 없으면 기본값 + 저장 거절', () => {
  writeSettings({ enabled: true, intervalOn: true, intervalMs: 2 * HOUR, sizeMB: 7, schedules: [] });
  assert.equal(settings.loadXferSpeedSettings().sizeMB, 7, '한 번 읽어 둔다');
  const realRead = fs.readFileSync;
  const fail = (p, ...a) => { if (String(p) === SET_FILE) throw Object.assign(new Error('too many open files'), { code: 'EMFILE' }); return realRead(p, ...a); };
  fs.readFileSync = fail;
  try {
    const s = settings.loadXferSpeedSettings();
    assert.equal(s.enabled, true, '꺼짐(기본값)으로 떨어지지 않는다');
    assert.equal(s.sizeMB, 7);
    assert.equal(fs.readdirSync(TMP).some((n) => n.startsWith('xfer-speed-settings.json.corrupt.')), false, '원본을 손상으로 옮기지 않는다');
    // 직전 값이 없는 프로세스(재시작 직후)
    settings._resetXferSettingsForTest();
    const d = settings.loadXferSpeedSettings();
    assert.equal(d.enabled, false, '직전 값이 없으면 기본값');
    assert.ok(settings.xferSettingsLoadError()?.transient, '못 읽었다는 사실을 말한다');
    assert.throws(() => settings.saveXferSpeedSettings({ sizeMB: 9 }), (e) => e.code === 'settings-unreadable', '기본값 위에 덮어써 원본을 지우지 않는다');
  } finally { fs.readFileSync = realRead; }
  assert.equal(JSON.parse(fs.readFileSync(SET_FILE, 'utf8')).sizeMB, 7, '원본 그대로');
  assert.equal(settings.loadXferSpeedSettings().sizeMB, 7, '읽기가 돌아오면 원본 값');
  // 진짜 손상은 예전처럼 보존한다.
  fs.writeFileSync(SET_FILE, '{not json');
  assert.equal(settings.loadXferSpeedSettings().enabled, false);
  assert.ok(fs.readdirSync(TMP).some((n) => n.startsWith('xfer-speed-settings.json.corrupt.')), '손상은 보존');
});

/* ─────────────────────────── 전송 속도 — 시계 되돌림 ─────────────────────────── */

test('B-09 마지막 측정이 미래(시계 되돌림) — 간격 실행이 그 미래 시각까지 막히지 않는다', async () => {
  await freshXferDb(); resetPoller();
  const T = Date.now();
  await xdb.insertSamples([sample('Edge-F', 'down', T + 6 * HOUR)]);
  writeSettings({ enabled: true, intervalOn: true, intervalMs: 30 * MIN, schedules: [] });
  const warns = await captureWarn(async () => {
    const r1 = await poller.tickXferSchedule({ now: T });
    assert.ok(!r1.started, '지금부터 다시 센다(곧바로 몰아 재지 않는다)');
  });
  assert.ok(warns.some((w) => /시계가 뒤로/.test(w)), '시계 되돌림을 콘솔에 남긴다');
  const nx = poller.xferSpeedStatus(T).next;
  assert.ok(nx && nx.at <= T + 31 * MIN, `다음 실행 +${((nx?.at - T) / HOUR).toFixed(2)}h (예전 +6.5h)`);
  const r2 = await poller.tickXferSchedule({ now: T + 31 * MIN });
  assert.ok(r2.started, '간격이 지나면 잰다');
  await r2.promise;
});

test('B-09 예약 처리 기록이 미래(시계 되돌림) — 지금으로 다시 잡고 다음 회차에 잰다', async () => {
  await freshXferDb(); resetPoller();
  const T = Date.now();
  writeSettings({ enabled: true, intervalOn: false, schedules: [{ id: 's-c1', kind: 'daily', time: kstHm(T + 10 * MIN), enabled: true, since: T - DAY }] });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ v: 1, schedules: { 's-c1': { lastAt: T + 5 * HOUR, result: 'ran', at: T + 5 * HOUR } } }));
  await captureWarn(async () => { const r = await poller.tickXferSchedule({ now: T }); assert.ok(!r.started); });
  const rec = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).schedules['s-c1'];
  assert.equal(rec.lastAt, T, '미래 기록을 지금으로');
  assert.equal(rec.reason, 'clock');
  assert.equal(rec.clockFrom, T + 5 * HOUR, '원래 값을 남긴다');
  const r2 = await poller.tickXferSchedule({ now: T + 11 * MIN });
  assert.ok(r2.started, '다음 회차가 예정대로 선다(예전엔 미래 기록 시각까지 막혔다)');
  await r2.promise;
  // 순수 — 일정의 since 가 미래였던 경우(설정 파일은 고치지 않는다)
  const s = { settings: { intervalOn: false, schedules: [{ id: 's-d1', kind: 'daily', time: kstHm(T + 10 * MIN), enabled: true, since: T + 5 * HOUR }] } };
  const rb = sched.rebaseClock({ ...s, state: {}, now: T });
  assert.equal(rb.rebased[0].field, 'since');
  assert.equal(sched.effectiveSince(s.settings.schedules[0], rb.state['s-d1']), T);
  const p = sched.planTick({ ...s, state: rb.state, now: T + 11 * MIN, enabled: true });
  assert.equal(p.fire.length, 1, 'since 보정 뒤 회차가 선다');
  assert.equal(sched.planTick({ ...s, state: {}, now: T + 11 * MIN, enabled: true }).fire.length, 0, '보정이 없으면 막힌다(전제)');
  assert.ok(sched.MISSED_REASONS.includes('clock'));
});

test('B-09 화면 — 미래 시각 최신값은 정상이 아니라 오래됨(시계 어긋남) · DB 최신 표는 새 측정이 바꾼다', async () => {
  const T = Date.now();
  const rows = an.edgeRows({
    collectors: [{ id: 'edge-pl', url: 'https://pl.example', enabled: true }],
    latest: ['down', 'up'].map((dir) => ({ agent: 'edge-pl', dir, ts: T + 6 * HOUR, ok: 1, mbps: 50 })), recent: [],
    settings: { intervalOn: true, intervalMs: 30 * MIN, slowPct: 70 }, now: T,
  });
  assert.equal(rows[0].state, 'stale');
  assert.equal(rows[0].reason, 'clock-skew');
  const ok = an.edgeRows({ collectors: [{ id: 'e', url: 'https://e', enabled: true }], latest: [{ agent: 'e', dir: 'down', ts: T - MIN, ok: 1, mbps: 5 }], settings: { intervalMs: 30 * MIN }, now: T });
  assert.equal(ok[0].state, 'ok', '정상 측정은 그대로');
  await freshXferDb();
  await xdb.insertSamples([sample('Edge-G', 'down', T + 6 * HOUR, { mbps: 1 })]);
  await xdb.insertSamples([sample('Edge-G', 'down', T, { mbps: 2 })]);
  const lat = (await xdb.latestAll()).find((r) => r.agent === 'Edge-G');
  assert.equal(lat.ts, T, '시계가 따라잡을 때까지 최신 표가 굳지 않는다');
  assert.equal(lat.mbps, 2);
  await xdb.insertSamples([sample('Edge-G', 'down', T - HOUR, { mbps: 3 })]);
  assert.equal((await xdb.latestAll()).find((r) => r.agent === 'Edge-G').ts, T, '정상 범위의 더 이른 측정은 여전히 바꾸지 않는다');
});

test('B-13 최신 표는 일 요약 보존일로 정리 — 원시 보존일 밖이어도 마지막 측정이 남는다', async () => {
  await freshXferDb();
  const now = Date.now();
  await xdb.insertSamples([sample('Edge-Old', 'down', now - 200 * DAY), sample('Edge-Ancient', 'down', now - 2000 * DAY)]);
  const r = await xdb.pruneXferSpeed({ sampleDays: 180, dailyDays: 1825, now });
  assert.equal(r.ok, true);
  const lat = await xdb.latestAll();
  assert.ok(lat.some((x) => x.agent === 'Edge-Old'), '원시 보존일(180일) 밖이어도 최신 표에 남는다 — "한 번도 재지 않았다" 가 되지 않게');
  assert.ok(!lat.some((x) => x.agent === 'Edge-Ancient'), '일 요약 보존일(5년) 밖은 지운다');
  assert.equal((await xdb.samplesSince(0, { agent: 'Edge-Old' })).rows.length, 0, '원시는 원시 보존일대로 지운다');
  const rows = an.edgeRows({ collectors: [{ id: 'Edge-Old', url: 'https://x', enabled: true }], latest: lat, settings: { intervalMs: 30 * MIN }, now });
  assert.equal(rows[0].reason, 'old', "'측정 없음 — 한 번도' 가 아니라 '오래됨'");
});

/* ─────────────────────────── 전송 속도 — 설정 범위 ─────────────────────────── */

test('D-04 범위 밖 숫자는 거절(400 용 code·field) · 웹 RANGES 사본과 같다', async () => {
  writeSettings({ enabled: false, sizeMB: 10 });
  assert.throws(() => settings.saveXferSpeedSettings({ sizeMB: 200 }), (e) => e.code === 'bad-range' && e.field === 'sizeMB' && /1MB~50MB/.test(e.message));
  assert.throws(() => settings.saveXferSpeedSettings({ concurrency: 10 }), (e) => e.code === 'bad-range' && e.field === 'concurrency');
  assert.throws(() => settings.saveXferSpeedSettings({ intervalMs: 5 * MIN }), (e) => e.field === 'intervalMs' && /10분/.test(e.message));
  assert.equal(settings.loadXferSpeedSettings().sizeMB, 10, '거절된 저장은 아무것도 바꾸지 않는다');
  assert.equal(settings.saveXferSpeedSettings({ sizeMB: 50 }).sizeMB, 50, '경계는 받는다');
  assert.equal(settings.saveXferSpeedSettings({ sizeMB: '' }).sizeMB, 50, '빈 칸은 그대로(미지정)');
  const w = await import(path.join(WEB, 'views/tools/xferSpeedText.js'));
  assert.deepEqual(JSON.parse(JSON.stringify(w.XFER_RANGES)), JSON.parse(JSON.stringify(settings.RANGES)), '서버 RANGES ↔ 웹 사본');
  assert.deepEqual(w.settingsIssues({ sizeMB: '200' }).map((x) => x.key), ['sizeMB'], '웹도 같은 범위로 막는다');
  assert.ok(w.MISSED_TEXT.clock, '놓침 사유 clock 문구');
});

/* ─────────────────────────── 전송 속도 — 조각 읽기(E-01·E-02·E-04) ─────────────────────────── */

/** 예전 한 문장 판(v2.735.3) — 결과 대조용 사본. */
function oldSamplesSince(raw, sinceTs, { agent = '', limit = 200_000, until = null } = {}) {
  const lim = Math.max(1, Math.min(500_000, Math.floor(limit)));
  const to = until;
  const rows = agent
    ? (to == null
      ? raw.prepare('SELECT agent, dir, ts, ok, mbps, ttfb_ms, xfer_ms, total_ms, bytes, basis, kind, err FROM xfer_sample WHERE agent = ? AND ts >= ? ORDER BY ts DESC LIMIT ?').all(agent, sinceTs, lim + 1)
      : raw.prepare('SELECT agent, dir, ts, ok, mbps, ttfb_ms, xfer_ms, total_ms, bytes, basis, kind, err FROM xfer_sample WHERE agent = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?').all(agent, sinceTs, to, lim + 1))
    : (to == null
      ? raw.prepare('SELECT agent, dir, ts, ok, mbps, ttfb_ms, xfer_ms, total_ms, basis FROM xfer_sample WHERE ts >= ? ORDER BY ts DESC LIMIT ?').all(sinceTs, lim + 1)
      : raw.prepare('SELECT agent, dir, ts, ok, mbps, ttfb_ms, xfer_ms, total_ms, basis FROM xfer_sample WHERE ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?').all(sinceTs, to, lim + 1));
  const truncated = rows.length > lim;
  const kept = truncated ? rows.slice(0, lim) : rows;
  kept.reverse();
  return { rows: kept, truncated, available: true };
}
function oldExportRows(raw, sinceTs, { agent = '', limit = 200_000, until = null } = {}) {
  const lim = Math.max(1, Math.min(500_000, Math.floor(limit)));
  const sql = `SELECT agent, dir, ts, ok, bytes, mbps, xfer_ms, total_ms, ttfb_ms, basis, kind, err, trig FROM xfer_sample WHERE ts >= ? ${until != null ? 'AND ts <= ?' : ''} ${agent ? 'AND agent = ?' : ''} ORDER BY ts DESC LIMIT ?`;
  const rows = raw.prepare(sql).all(sinceTs, ...(until != null ? [until] : []), ...(agent ? [agent] : []), lim + 1);
  return { rows: rows.slice(0, lim).reverse(), truncated: rows.length > lim };
}
const byTsDir = (a, b) => a.ts - b.ts || String(a.dir).localeCompare(String(b.dir));
/**
 * 큰 배열 대조 — 실패해도 보고기가 수천 행을 직렬화하지 않게(CLAUDE.md v2.731: assert.deepEqual 의 actual 로 큰 배열을 넘기면 실패 시
 * 프로세스가 메모리로 죽는다). 다르면 처음 어긋난 자리만 말한다.
 */
function sameBig(a, b, msg) {
  if (isDeepStrictEqual(a, b)) return;
  const ra = a?.rows ?? a; const rb = b?.rows ?? b;
  let i = 0;
  if (Array.isArray(ra) && Array.isArray(rb)) while (i < Math.min(ra.length, rb.length) && isDeepStrictEqual(ra[i], rb[i])) i += 1;
  assert.fail(`${msg} — 다름(길이 ${ra?.length}/${rb?.length}, 첫 차이 ${i}: ${JSON.stringify(ra?.[i])?.slice(0, 200)} ≠ ${JSON.stringify(rb?.[i])?.slice(0, 200)}, truncated ${a?.truncated}/${b?.truncated})`);
}

/** 6엣지 × 2방향 — 같은 ts 를 엣지끼리 나눠 갖는다(전체 조각 경계에 같은 ts 가 걸리게). 한 엣지 안의 ↑ 는 ↓ +1ms. */
async function seedTies(base, n) {
  const agents = ['edge-a', 'edge-b', 'edge-c', 'edge-d', 'edge-e', 'edge-f'];
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const ts = base + i * 10 * MIN;
    for (const [j, a] of agents.entries()) {
      const fail = (i + j) % 17 === 0;
      rows.push(sample(a, 'down', ts, fail ? { ok: false, mbps: null, kind: 'timeout', error: 'x' } : { mbps: 20 + ((i * 7 + j) % 50) }));
      rows.push(sample(a, 'up', ts + 1, { mbps: 15 + ((i * 3 + j) % 40) }));
    }
  }
  for (let k = 0; k < rows.length; k += 5000) assert.equal((await xdb.insertSamples(rows.slice(k, k + 5000))).ok, true);
  return rows.length;
}

test('E-01·E-02·E-04 조각 읽기 = 한 문장 판(전체는 순서까지, 한 엣지는 같은 행) · 잘림·until · 양보판 판정 = 동기판', async () => {
  await freshXferDb();
  await xdb.insertSamples([sample('edge-z', 'down', NOW - 400 * DAY)]);   // 가장 낮은 rowid 의 오래된 행 — 정리가 MAX(rowid) 를 건드리지 않는 경우
  const base = NOW - 3 * DAY;
  const total = 1 + await seedTies(base, 400);   // 4,801행
  const raw = new DatabaseSync(xdb.dbPath());
  const since = base - HOUR;
  for (const chunk of [7, 13, 1000, 5000]) {
    for (const o of [{}, { limit: 50 }, { limit: 1234 }, { until: base + 100 * 10 * MIN }, { until: base + 100 * 10 * MIN, limit: 30 }]) {
      const a = await xdb.samplesSinceChunked(since, { ...o, chunk });
      const b = oldSamplesSince(raw, since, o);
      sameBig(a, b, `samplesSince 전체 chunk=${chunk} ${JSON.stringify(o)}`);
      const e1 = await xdb.exportRows(since, { ...o, chunk });
      const e2 = oldExportRows(raw, since, o);
      sameBig(e1, e2, `exportRows 전체 chunk=${chunk} ${JSON.stringify(o)}`);
      const oa = { ...o, agent: 'edge-c' };
      const s1 = await xdb.samplesSinceChunked(since, { ...oa, chunk });
      const s2 = oldSamplesSince(raw, since, oa);
      assert.equal(s1.truncated, s2.truncated);
      sameBig([...s1.rows].sort(byTsDir), [...s2.rows].sort(byTsDir), `samplesSince 엣지 chunk=${chunk} ${JSON.stringify(o)}`);
      const x1 = await xdb.exportRows(since, { ...oa, chunk });
      const x2 = oldExportRows(raw, since, oa);
      assert.equal(x1.truncated, x2.truncated);
      sameBig([...x1.rows].sort(byTsDir), [...x2.rows].sort(byTsDir), `exportRows 엣지 chunk=${chunk} ${JSON.stringify(o)}`);
    }
  }
  assert.equal((await xdb.exportRows(0)).rows.length, total, '전량');
  raw.close();
  // 양보판 판정 = 동기판
  const recent = await xdb.samplesSince(NOW - 7 * DAY);
  const p = { collectors: ['edge-a', 'edge-b', 'edge-x'].map((id) => ({ id, url: `https://${id}`, enabled: true })), latest: await xdb.latestAll(), recent: recent.rows, settings: { intervalMs: 10 * MIN, slowPct: 70 }, now: NOW };
  let yc = 0;
  const yielder = async () => { yc += 1; };
  sameBig(await an.edgeRowsAsync(p, { yielder }), an.edgeRows(p), 'edgeRows 양보판 = 동기판');
  sameBig(await an.heatOfAsync(recent.rows, {}, { yielder }), an.heatOf(recent.rows), 'heatOf 양보판 = 동기판');
  assert.ok(yc > 0, '양보 지점이 있다');
  // 기억 키 — 적재·정리 때 바뀐다
  const m1 = await xdb.dataMark();
  assert.equal(await xdb.dataMark(), m1, '바뀐 것이 없으면 같다');
  await xdb.insertSamples([sample('edge-a', 'down', NOW - MIN)]);
  const m2 = await xdb.dataMark();
  assert.notEqual(m2, m1, '적재하면 바뀐다');
  await xdb.insertSamples([sample('edge-a', 'down', NOW - MIN)]);
  assert.equal(await xdb.dataMark(), m2, '중복 재전송(INSERT OR IGNORE)은 바꾸지 않는다');
  const pr = await xdb.pruneXferSpeed({ sampleDays: 180, dailyDays: 1825, now: NOW });
  assert.equal(pr.sample, 1, '오래된 한 행만 지운다(전제 — MAX(rowid) 는 그대로)');
  assert.notEqual(await xdb.dataMark(), m2, '정리가 지우면 바뀐다(MAX(rowid) 가 같아도)');
});

/* ─────────────────────────── 실제 api 라우터(자식 프로세스) ─────────────────────────── */

test('E-01·E-02·E-04·D-04·B-12·D-06 실제 api 라우터 — CSV 409·바이트 동일 · 메인/히트맵 기억 · 범위 400 · 못 읽음 503 · 파트 장애 DB 불가에도 kind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2740c-api-'));
  const pfDir = path.join(dir, 'pf-as-dir');
  fs.mkdirSync(pfDir);   // DB 경로가 디렉터리 — 파트 장애 DB 를 열 수 없다(initError)
  fs.writeFileSync(path.join(dir, 'collectors.json'), JSON.stringify({ collectors: [
    { id: 'edge-a', name: 'Edge A', url: 'https://10.20.0.6:4000', token: 'secret-tok-a', enabled: true },
    { id: 'edge-b', name: 'Edge B', url: 'https://10.20.0.7:4000', token: 'secret-tok-b', enabled: true },
  ] }));
  fs.writeFileSync(path.join(dir, 'xfer-speed-settings.json'), JSON.stringify({ enabled: false, sizeMB: 10 }));
  const script = `
    import fs from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
    const MIN = 60000, HOUR = 3600000, DAY = 24 * HOUR;
    const SET = ${JSON.stringify(path.join(dir, 'xfer-speed-settings.json'))};
    const db = await import(${JSON.stringify(path.join(SRC, 'xferspeed/db.js'))});
    const an = await import(${JSON.stringify(path.join(SRC, 'xferspeed/analyze.js'))});
    const { csvLine, CSV_BOM } = await import(${JSON.stringify(path.join(SRC, 'util/csv.js'))});
    const { localStamp } = await import(${JSON.stringify(path.join(SRC, 'util/dayKey.js'))});
    const { acquireExport } = await import(${JSON.stringify(path.join(SRC, 'util/exportBusy.js'))});
    const out = {};
    // B-12 — 설정 파일을 처음부터 못 읽는 프로세스: 저장은 503(기본값으로 덮지 않는다)
    const realRead = fs.readFileSync;
    fs.readFileSync = (p, ...a) => { if (String(p) === SET) throw Object.assign(new Error('too many open files'), { code: 'EMFILE' }); return realRead(p, ...a); };
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { username: 'a', role: 'admin', superAdmin: true, scope: null }; next(); });
    app.use('/api', api);
    const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    const B = 'http://127.0.0.1:' + srv.address().port + '/api/tools';
    const put = async (body) => { const x = await fetch(B + '/xfer-speed/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: x.status, body: await x.json() }; };
    out.unreadable = await put({ sizeMB: 20 });
    fs.readFileSync = realRead;
    out.fileAfter = JSON.parse(fs.readFileSync(SET, 'utf8'));
    out.badRange = await put({ sizeMB: 200 });
    out.okPut = await put({ sizeMB: 12 });
    // 데이터 — 2엣지 × 2방향 × 1,500회(같은 ts 를 엣지끼리 나눠 가짐)
    const now = Date.now();
    const base = now - 2 * DAY;
    const rows = [];
    for (let i = 0; i < 1500; i += 1) for (const a of ['edge-a', 'edge-b']) {
      const ts = base + i * MIN;
      rows.push({ agent: a, dir: 'down', ts, ok: i % 13 !== 0, mbps: i % 13 ? 10 + (i % 30) : null, bytes: 1048576, xferMs: 120, totalMs: 200, ttfbMs: 33, basis: 'receiver', kind: i % 13 ? null : 'timeout', error: i % 13 ? '' : 'err "q", x', trig: 'timer' });
      rows.push({ agent: a, dir: 'up', ts: ts + 1, ok: true, mbps: 8 + (i % 20), bytes: 1048576, xferMs: 140, totalMs: 260, ttfbMs: null, basis: i % 7 ? 'receiver' : 'sender-total', trig: 'schedule' });
    }
    for (let k = 0; k < rows.length; k += 3000) await db.insertSamples(rows.slice(k, k + 3000));
    // E-01 동시 1건
    const lock = acquireExport('xfer-speed-csv', { user: { username: 'other' } });
    const busy = await fetch(B + '/xfer-speed/export.csv?days=7');
    out.busy = { status: busy.status, body: await busy.json() };
    lock.release();
    // E-01 바이트 동일 — 예전 라우트 코드(한 문장 + join)로 만든 것과 비교
    const raw = new DatabaseSync(db.dbPath());
    const oldCsv = (sinceTs, agent) => {
      const sql = 'SELECT agent, dir, ts, ok, bytes, mbps, xfer_ms, total_ms, ttfb_ms, basis, kind, err, trig FROM xfer_sample WHERE ts >= ? ' + (agent ? 'AND agent = ? ' : '') + 'ORDER BY ts DESC LIMIT ?';
      const r = raw.prepare(sql).all(sinceTs, ...(agent ? [agent] : []), 200001);
      const kept = r.slice(0, 200000).reverse();
      const head = ['시각(포탈)', '엣지', '방향', '결과', '속도(Mbps)', '바이트', '전송(ms)', '전체(ms)', '지연(ms)', '계산 기준', '실패 종류', '사유', '실행'];
      const lines = [CSV_BOM + csvLine(head)];
      for (const x of kept) lines.push(csvLine([localStamp(x.ts), x.agent, x.dir === 'down' ? '엣지→메인' : '메인→엣지', Number(x.ok) === 1 ? '성공' : '실패', Number(x.ok) === 1 ? x.mbps : '', x.bytes ?? '', x.xfer_ms ?? '', x.total_ms ?? '', an.latencyMsOf(x) ?? '', x.basis || '', x.kind || '', x.err || '', x.trig || '']));
      return lines.join('\\r\\n');
    };
    const c1 = await fetch(B + '/xfer-speed/export.csv?days=7');
    const t1 = Buffer.from(await c1.arrayBuffer()).toString('utf8');
    const c2 = await fetch(B + '/xfer-speed/export.csv?days=7&agent=edge-b');
    const t2 = Buffer.from(await c2.arrayBuffer()).toString('utf8');
    // 예전 판의 since 는 요청 시각 기준 — 그 사이 경계에 걸린 행이 없도록 데이터는 2일 전부터다.
    out.csv = { status: c1.status, type: c1.headers.get('content-type'), disp: c1.headers.get('content-disposition'), same: t1 === oldCsv(now - 7 * DAY, ''), lines: t1.split('\\r\\n').length,
      sameAgent: t2 === oldCsv(now - 7 * DAY, 'edge-b'), bom: t1.charCodeAt(0) === 0xFEFF, trailing: t1.endsWith('\\r\\n') };
    // E-02 메인 기억
    const g = async (p) => (await fetch(B + p)).json();
    const m1 = await g('/xfer-speed');
    const m2 = await g('/xfer-speed');
    const direct = an.edgeRows({ collectors: JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, 'collectors.json'))}, 'utf8')).collectors, latest: await db.latestAll(), recent: (await db.samplesSince(m1.computedAt - 7 * DAY)).rows, settings: m1.settings, now: m1.computedAt });
    const proj = (rs) => rs.map((r) => [r.id, r.state, r.reason, r.vsPct, r.newestTs, r.down.week.n, r.up.week.n, r.down.baseline]);
    out.main = { same: m1.computedAt === m2.computedAt, nowMoves: m2.now >= m1.now, hasStatus: !!m2.status, projEq: JSON.stringify(proj(m1.rows)) === JSON.stringify(proj(direct)), kpis: m1.kpis, token: JSON.stringify(m1).includes('secret-tok') };
    await db.insertSamples([{ agent: 'edge-a', dir: 'down', ts: Date.now(), ok: true, mbps: 99, bytes: 1048576, xferMs: 10, totalMs: 20, ttfbMs: 5, basis: 'receiver', trig: 'manual' }]);
    const [a, b2, c] = await Promise.all([g('/xfer-speed'), g('/xfer-speed'), g('/xfer-speed')]);
    out.main.after = { changed: a.computedAt !== m1.computedAt, joined: a.computedAt === b2.computedAt && b2.computedAt === c.computedAt, latestMbps: a.rows.find((r) => r.id === 'edge-a').down.latest.mbps };
    // E-04 히트맵 기억 + 결과 동일
    const h1 = await g('/xfer-speed/heat?days=14');
    const h2 = await g('/xfer-speed/heat?days=14');
    const hDirect = an.heatOf((await db.samplesSince(h1.computedAt - 14 * DAY)).rows);
    out.heat = { same: h1.computedAt === h2.computedAt, eq: JSON.stringify(h1.rows) === JSON.stringify(hDirect), n: h1.rows.length };
    // E-02 기억 함수 — 계산 중인 같은 키는 합류한다(느린 계산으로 확인) · 키가 다르면 다시 계산 · 실패는 기억하지 않는다
    const xs = await import(${JSON.stringify(path.join(SRC, 'routes/api/xferSpeed.js'))});
    let calls = 0;
    const slow = () => new Promise((res) => setTimeout(() => res({ v: ++calls }), 80));
    const j = await Promise.all([xs._memoizedForTest('t', 'k1', slow), xs._memoizedForTest('t', 'k1', slow), xs._memoizedForTest('t', 'k1', slow)]);
    const again = await xs._memoizedForTest('t', 'k1', slow);
    const other = await xs._memoizedForTest('t', 'k2', slow);
    let threw = 0;
    try { await xs._memoizedForTest('f', 'k', async () => { throw new Error('boom'); }); } catch { threw += 1; }
    const afterFail = await xs._memoizedForTest('f', 'k', async () => ({ v: 'ok' }));
    const noKey = [await xs._memoizedForTest('n', null, async () => ({ v: ++calls })), await xs._memoizedForTest('n', null, async () => ({ v: ++calls }))];
    out.memo = { joined: j.map((x) => x.v), again: again.v, other: other.v, threw, afterFail: afterFail.v, noKey: noKey.map((x) => x.v) };
    // D-06 파트 장애 DB 불가 + 종류 필터
    out.pf = await g('/part-faults/incidents?days=7&kind=disk');
    srv.close();
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'live', AUTH_ENABLED: 'true', PARTFAULT_DB_PATH: pfDir },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 180_000,
  });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, r.stdout.slice(-800) + r.stderr.slice(-800));
  const o = JSON.parse(line.slice(2));
  assert.equal(o.unreadable.status, 503, 'B-12 못 읽은 설정 위에 저장하지 않는다');
  assert.equal(o.unreadable.body.settingsUnreadable, true);
  assert.equal(o.fileAfter.sizeMB, 10, '원본 그대로');
  assert.equal(o.badRange.status, 400, 'D-04');
  assert.equal(o.badRange.body.field, 'sizeMB');
  assert.deepEqual(o.badRange.body.range, { min: 1, max: 50 });
  assert.equal(o.okPut.status, 200);
  assert.equal(o.okPut.body.settings.sizeMB, 12);
  assert.equal(o.busy.status, 409, 'E-01 동시 1건');
  assert.equal(o.busy.body.error, 'export_busy');
  assert.equal(o.csv.status, 200);
  assert.match(o.csv.type, /text\/csv/);
  assert.match(o.csv.disp, /attachment; filename="xfer-speed-/);
  assert.equal(o.csv.same, true, 'CSV 바이트가 예전 판과 같다');
  assert.equal(o.csv.sameAgent, true, '한 엣지 CSV 도 같다');
  assert.equal(o.csv.lines, 1 + 6000, '머리 + 행');
  assert.equal(o.csv.bom, true);
  assert.equal(o.csv.trailing, false, '마지막 줄 뒤 개행 없음(예전 형식)');
  assert.equal(o.main.same, true, 'E-02 바뀐 것이 없으면 다시 계산하지 않는다');
  assert.equal(o.main.hasStatus, true, '진행 상황은 요청마다');
  assert.equal(o.main.projEq, true, '기억한 판정 = 그 시각의 직접 계산');
  assert.equal(o.main.token, false, '응답에 토큰 없음');
  assert.equal(o.main.after.changed, true, '새 측정이 들어오면 다시 계산');
  assert.equal(o.main.after.joined, true, '동시 요청은 같은 계산에 합류');
  assert.equal(o.main.after.latestMbps, 99);
  assert.deepEqual(o.memo.joined, [1, 1, 1], '계산 중인 같은 키는 한 번만 계산(동시 요청 합류)');
  assert.equal(o.memo.again, 1, 'TTL 안의 같은 키는 다시 계산하지 않는다');
  assert.equal(o.memo.other, 2, '키가 다르면 다시 계산');
  assert.equal(o.memo.threw, 1);
  assert.equal(o.memo.afterFail, 'ok', '실패는 기억하지 않는다');
  assert.deepEqual(o.memo.noKey, [3, 4], '키가 없으면(DB 불가) 기억하지 않는다');
  assert.equal(o.heat.same, true, 'E-04 히트맵 기억');
  assert.equal(o.heat.eq, true, '히트맵 = 한 문장 판 계산');
  assert.equal(o.heat.n, 4, '2엣지 × 2방향');
  assert.equal(o.pf.available, false, 'D-06 전제 — 파트 장애 DB 를 못 연다');
  assert.equal(o.pf.kind, 'disk', '종류를 싣는다(화면 대조가 영원히 불러오는 중이 되지 않게)');
  assert.equal(o.pf.days, 7);
});
