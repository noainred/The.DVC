// v3.8.2 디스크 배드 섹터 — 첫 실사용(2026-11-14)에서 드러난 것을 고정한다.
//   사용자 화면: 서버 한 대의 Lifecycle 로그가 3,853건인데 하루치뿐이었다(읽은 42대 모두 이번 달부터) → iDRAC 가 Redfish 로 주는 것은
//   활성 로그뿐이고(Dell 사용자 안내서 — 검색 요약), 로그인 기록이 그것을 채우면 과거 PDR 기록은 거기 없다.
//   이 판은 과거 기록을 읽지 못하는 것을 **고치지 않는다** — 무엇을 읽었는지 밝히고(읽기 진단 · 전 법인 경고), 다음 수정의 근거를
//   그 장비에서 받아 온다(장비 진단 probe.js). 같이 고친 읽기 결함(쪽 건수 ≠ 전체 건수 · 빈 쪽 조기 종료 · 빈 로그)은 여기서 고정한다.
//   스윕은 test/_stripComments.js 로 주석을 먼저 지운다. 기준 시각은 실제 시각을 정시 경계로 떨어뜨려 고정한다(docs/rules/common.md).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'diskbadfld382-'));
process.env.CONFIG_DIR = TMP;
process.env.DISKBAD_DB_PATH = path.join(TMP, 'disk-bad.db');
process.env.AUTH_ENABLED = 'false';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = (p) => stripComments(fs.readFileSync(path.join(ROOT, 'src', p), 'utf8'));
const HOUR = 3_600_000; const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

const L = await import('../src/diskbad/lclog.js');
const I = await import('../src/diskbad/ingest.js');
const D = await import('../src/diskbad/db.js');
const S = await import('../src/diskbad/summary.js');
const C = await import('../src/diskbad/classify.js');
const P = await import('../src/diskbad/probe.js');
const SC = await import('../src/diskbad/scan.js');
const CU = await import('../src/diskbad/cursors.js');

after(() => { try { D._resetDiskBadDbForTest(); } catch { /* */ } fs.rmSync(TMP, { recursive: true, force: true }); });

const MGR = '/redfish/v1/Managers/iDRAC.Embedded.1';
const BASE = `${MGR}/LogServices/Lclog/Entries`;
const mgrs = { Members: [{ '@odata.id': MGR }] };
const lc = (id, created, msgId = 'IDRAC.2.9.USR0030', message = 'Successfully logged in using root, from 10.0.0.9 and REDFISH.') => ({ Id: String(id), Created: new Date(created).toISOString(), MessageId: msgId, Message: message });
const PDR54 = (id, created) => lc(id, created, 'IDRAC.2.9.PDR54', 'A disk media error on Disk 3 in Backplane 1 of Integrated RAID Controller 1 was corrected during recovery.');
/** 최신 먼저 n건. `at` 번째(0 = 가장 새 것)에 PDR54 한 건. */
const logOf = (n, at) => Array.from({ length: n }, (_, i) => (i === at ? PDR54(n - i, NOW - i * HOUR) : lc(n - i, NOW - i * HOUR, i % 2 ? 'IDRAC.2.9.USR0032' : 'IDRAC.2.9.USR0030')));
const skipOf = (p) => { const m = /\$skip=(\d+)/.exec(p); return m ? Number(m[1]) : 0; };

// ── 읽기 결함 ────────────────────────────────────────────────────────────────────
test('쪽 건수 ≠ 전체 건수: 다음 쪽 링크가 있는데 건수가 첫 쪽 길이 이하이면 그 값을 끝으로 믿지 않고 빈 쪽까지 읽는다', async () => {
  const all = logOf(3000, 2900);
  let calls = 0;
  const getJson = async (_e, p) => {
    if (p === '/redfish/v1/Managers') return mgrs;
    calls += 1;
    const k = skipOf(p); const rows = all.slice(k, k + 50);
    return { Members: rows, 'Members@odata.count': rows.length, ...(k + 50 < all.length ? { 'Members@odata.nextLink': `${BASE}?$skip=${k + 50}` } : {}) };
  };
  const r = await L.readLclog({}, { getJson });
  assert.equal(r.read, 3000); assert.equal(r.reachedEnd, true); assert.equal(r.total, null, '쪽 건수는 전체 건수가 아니다');
  assert.equal(r.entries.length, 1); assert.equal(r.entries[0].code, 'PDR54');
  assert.equal(r.oldestRead, NOW - 2999 * HOUR);
  assert.ok(calls >= 60);
  // 건수가 첫 쪽보다 크면 전체 건수로 쓴다(실장비 — 3,853건).
  const honest = async (_e, p) => (p === '/redfish/v1/Managers' ? mgrs : { Members: all.slice(skipOf(p), skipOf(p) + 50), 'Members@odata.count': all.length, 'Members@odata.nextLink': 'x' });
  const h = await L.readLclog({}, { getJson: honest });
  assert.equal(h.total, 3000); assert.equal(h.read, 3000); assert.equal(h.reachedEnd, true);
});

test('건수를 아는데 그 전에 빈 쪽이 오면 끝이 아니다(short — 일부만 읽음) · 첫 쪽이 비면 끝까지 읽음이 아니다(empty)', async () => {
  const all = logOf(500, 400);
  const cut = async (_e, p) => (p === '/redfish/v1/Managers' ? mgrs : { Members: skipOf(p) >= 150 ? [] : all.slice(skipOf(p), skipOf(p) + 50), 'Members@odata.count': all.length });
  const r = await L.readLclog({}, { getJson: cut });
  assert.equal(r.stopped, 'short'); assert.equal(r.reachedEnd, false); assert.equal(r.read, 150); assert.equal(r.entries.length, 0);
  const empty = async (_e, p) => (p === '/redfish/v1/Managers' ? mgrs : { Members: [], 'Members@odata.count': 0 });
  const e = await L.readLclog({}, { getJson: empty });
  assert.equal(e.stopped, 'empty'); assert.equal(e.reachedEnd, false);
  // 모양이 다른 응답(Members 없음)도 '끝까지 읽음 · 기록 없음' 이 되지 않는다.
  const odd = await L.readLclog({}, { getJson: async (_e, p) => (p === '/redfish/v1/Managers' ? mgrs : { error: 'x' }) });
  assert.equal(odd.reachedEnd, false);
  for (const st of ['short', 'empty']) assert.equal(I.cleanServer({ id: 'q', ok: true, log: { stopped: st } }, NOW).log.stopped, st);
});

test('오래된 것 먼저 + 건수 모름: 앞에서부터 끝까지 읽고 가장 새 항목은 시각이 가장 큰 것 · 지난번 자리로 멈추지 않는다', async () => {
  const asc = logOf(170, 160).reverse();
  const getJson = async (_e, p) => {
    if (p === '/redfish/v1/Managers') return mgrs;
    const k = skipOf(p); const rows = asc.slice(k, k + 50);
    return { Members: rows, 'Members@odata.count': rows.length, ...(k + 50 < asc.length ? { 'Members@odata.nextLink': 'n' } : {}) };
  };
  const r = await L.readLclog({}, { getJson, cursor: { entryId: '5', created: NOW - 165 * HOUR } });
  assert.equal(r.order, 'asc'); assert.equal(r.cursorUsed, false); assert.equal(r.read, 170); assert.equal(r.reachedEnd, true);
  assert.equal(r.newest.created, NOW); assert.equal(r.oldestRead, NOW - 169 * HOUR); assert.equal(r.entries.length, 1);
});

test('표준 경로가 404 이면 옛 경로(Logs/Lclog — 12G/13G)를 한 번 시도한다 · 다른 오류는 그대로 던진다', async () => {
  const all = logOf(40, 3);
  const getJson = async (_e, p) => {
    if (p === '/redfish/v1/Managers') return mgrs;
    if (p.startsWith(BASE)) throw Object.assign(new Error('nf'), { status: 404 });
    assert.ok(p.startsWith(`${MGR}/Logs/Lclog`));
    return { Members: all.slice(skipOf(p), skipOf(p) + 50), 'Members@odata.count': all.length };
  };
  const r = await L.readLclog({}, { getJson });
  assert.equal(r.path, 'legacy'); assert.equal(r.read, 40); assert.equal(r.entries.length, 1);
  await assert.rejects(L.readLclog({}, { getJson: async (_e, p) => { if (p === '/redfish/v1/Managers') return mgrs; throw Object.assign(new Error('x'), { status: 403 }); } }), (e) => e.status === 403);
});

// ── 읽기 진단 ────────────────────────────────────────────────────────────────────
test('읽기 진단: 쪽 수 · 기록 ID 구성(상위 8) · 첫 쪽 크기 · 다음 쪽 링크 — 판정에 쓰지 않는 사실', async () => {
  const all = logOf(230, 200);
  const getJson = async (_e, p) => (p === '/redfish/v1/Managers' ? mgrs : { Members: all.slice(skipOf(p), skipOf(p) + 50), 'Members@odata.count': all.length, ...(skipOf(p) + 50 < all.length ? { 'Members@odata.nextLink': 'n' } : {}) });
  const r = await L.readLclog({}, { getJson });
  assert.equal(r.pages, 5); assert.equal(r.firstLen, 50); assert.equal(r.hasNext, true); assert.equal(r.distinct, 3);
  assert.deepEqual(r.top.map((x) => x.code).sort(), ['PDR54', 'USR0030', 'USR0032']);
  assert.equal(r.top.reduce((a, x) => a + x.n, 0), 230);
  assert.ok(r.top.length <= L.TOP_CODES);
  // 정제: 아는 꼴만 · 상한 · 못 읽은 수는 null(0 이 아니다).
  const c = I.cleanServer({ id: 's', ok: true, log: { pages: '5', ms: 'x', distinct: 3, firstLen: 50, hasNext: true, path: '../etc', top: [...r.top, { code: 'x'.repeat(99), n: -1 }, 'bad', ...Array.from({ length: 20 }, (_, i) => ({ code: `C${i}`, n: 1 }))] } }, NOW).log;
  assert.equal(c.pages, 5); assert.equal(c.ms, null); assert.equal(c.path, '');
  assert.ok(c.top.length <= I.TOP_MAX && c.top.every((x) => x && x.code.length <= 16 && Number.isInteger(x.n) && x.n >= 0), '상한을 먼저 자르고 객체가 아닌 것은 버린다');
  assert.equal(I.cleanServer({ id: 's', ok: true, log: {} }, NOW).log.top, null, '옛 판 엣지는 진단이 없다');
});

test('로그인 계열 비율: 상위 목록에 든 것만 세는 하한 · 읽은 건수를 모르면 null', () => {
  assert.equal(C.loginShareOf({ read: 1000, top: [{ code: 'USR0030', n: 480 }, { code: 'USR0032', n: 470 }, { code: 'PDR54', n: 1 }] }), 0.95);
  assert.equal(C.loginShareOf({ read: null, top: [{ code: 'USR0030', n: 5 }] }), null);
  assert.equal(C.loginShareOf(null), null);
  assert.equal(C.loginShareOf({ read: 10, top: [{ code: 'SYS1003', n: 10 }] }), 0);
});

const result = (id, log, extra = {}) => ({
  id, name: id, host: '10.0.0.9', ok: true, reason: '', invAt: NOW - HOUR, drives: [], records: [],
  log: { order: 'desc', total: 3853, read: 3853, oldestRead: NOW - 20 * HOUR, newestCreated: NOW - HOUR, reachedEnd: true, foundCursor: false, cursorUsed: false,
    pages: 78, ms: 41_000, distinct: 9, firstLen: 50, hasNext: true, path: 'std', top: [{ code: 'USR0030', n: 1900 }, { code: 'USR0032', n: 1890 }, { code: 'LOG007', n: 40 }], ...log },
  ...extra,
});

test('DB: 읽기 진단은 처음부터 읽은 점검의 것만 남기고 이어 읽기에서는 유지 · 장비 진단은 온 것만 바꾼다 · 옛 DB 에 열만 더한다', async () => {
  const push = (x, at) => I.cleanPush({ v: 1, jobId: 'j', servers: [x] }, { now: at }).servers;
  await D.ingestServers('fld', push(result('f1', {}), NOW), { now: NOW });
  let d = await D.loadServer('fld', 'f1');
  assert.equal(d.server.readDiag.read, 3853); assert.equal(d.server.readDiag.pages, 78); assert.equal(d.server.readDiag.top[0].code, 'USR0030');
  assert.equal(d.server.probe, null);
  // 이어 읽기(새 항목 몇 건) — 진단을 덮지 않는다. 장비 진단이 실려 오면 저장한다.
  await D.ingestServers('fld', push(result('f1', { cursorUsed: true, foundCursor: true, reachedEnd: false, read: 12, pages: 1, top: [{ code: 'USR0030', n: 12 }] }, { probe: { v: 1, at: NOW, manager: { firmware: '7.00.00.00' } } }), NOW + HOUR), { now: NOW + HOUR });
  d = await D.loadServer('fld', 'f1');
  assert.equal(d.server.readDiag.read, 3853);
  assert.equal(d.server.probe.manager.firmware, '7.00.00.00'); assert.equal(d.server.probeAt, NOW + HOUR);
  // 다음 점검에 장비 진단이 없으면 지난 것을 유지한다.
  await D.ingestServers('fld', push(result('f1', {}), NOW + 2 * HOUR), { now: NOW + 2 * HOUR });
  d = await D.loadServer('fld', 'f1');
  assert.equal(d.server.probe.manager.firmware, '7.00.00.00');
  const v = S.serverView(d.server, d.records, d.serials);
  assert.ok(v.coverage.diag.loginShare > 0.9); assert.deepEqual(v.coverage.diag.loginCodes, C.LOGIN_CODES);
  assert.equal('probe' in v.coverage, false, '장비 진단은 serverView 에 싣지 않는다(라우트가 관리자 판본에만)');
  const db = code('diskbad/db.js');
  for (const col of ['read_diag', 'probe_json', 'probe_at']) assert.match(db, new RegExp(`if \\(!cols\\.has\\('${col}'\\)\\) db\\.exec\\('ALTER TABLE dbr_server ADD COLUMN ${col} `));
});

test('전 법인 합계: 로그가 30일 미만만 남은 서버 수 · 가운데값 · 로그인 기록이 절반을 넘는 서버 수 — 못 읽은 서버는 세지 않는다', async () => {
  const db = await D.loadAll();
  const servers = [{ agent: 'fld', id: 'f1', name: 'f1', corp: { id: 'vc1', name: 'NJ', country: 'China' } }, { agent: 'fld', id: 'never', name: 'n', corp: { id: 'vc1', name: 'NJ', country: 'China' } }];
  const f = S.buildFleet({ servers, db, now: NOW + 3 * HOUR });
  assert.equal(f.totals.read, 1); assert.equal(f.totals.unread, 1);
  assert.equal(f.totals.spanKnown, 1); assert.equal(f.totals.shortLog, 1); assert.equal(f.totals.shortLogDays, S.SHORT_LOG_DAYS);
  assert.equal(f.totals.loginHeavy, 1); assert.equal(f.totals.diagKnown, 1);
  assert.ok(f.totals.medianLogDays > 0 && f.totals.medianLogDays < 2);
  const row = f.servers.find((x) => x.serverId === 'f1');
  assert.equal(row.logTotal, 3853); assert.ok(row.loginShare > 0.9);
  // 로그가 오래 남은 서버는 경고에 들지 않는다.
  await D.ingestServers('fld', I.cleanPush({ v: 1, jobId: 'j', servers: [result('f2', { oldestRead: NOW - 400 * DAY, top: [{ code: 'SYS1003', n: 300 }] })] }, { now: NOW }).servers, { now: NOW });
  const g = S.buildFleet({ servers: [...servers, { agent: 'fld', id: 'f2', name: 'f2', corp: null }], db: await D.loadAll(), now: NOW + 3 * HOUR });
  assert.equal(g.totals.spanKnown, 2); assert.equal(g.totals.shortLog, 1); assert.equal(g.totals.loginHeavy, 1); assert.equal(g.totals.diagKnown, 2);
});

// ── 장비 진단 ────────────────────────────────────────────────────────────────────
function fakeIdrac({ filterWorks = true } = {}) {
  const all = logOf(120, 100);
  const calls = [];
  const getJson = async (_e, p) => {
    calls.push(p);
    if (p === '/redfish/v1/Managers') return mgrs;
    if (p === MGR) return { FirmwareVersion: '7.00.00.00', Model: '14G Monolithic', secret: 'no' };
    if (p.startsWith(`${BASE}?$filter=`)) {
      if (!filterWorks) return { Members: all.slice(0, 50), 'Members@odata.count': all.length };
      const m = /MessageId eq '([^']+)'/.exec(decodeURIComponent(p));
      const rows = m ? all.filter((x) => x.MessageId === m[1]) : [];
      return { Members: rows.slice(0, 50), 'Members@odata.count': rows.length };
    }
    if (p === BASE) return { Members: all.slice(0, 50), 'Members@odata.count': all.length, 'Members@odata.nextLink': `${BASE}?$skip=50` };
    if (p === `${MGR}/Oem/Dell/DellLCService`) return { Actions: { '#DellLCService.ExportLCLog': { target: 't', '@Redfish.ActionInfo': `${MGR}/Oem/Dell/DellLCService/ExportLCLogActionInfo` }, '#DellLCService.SystemErase': { target: 'x' } } };
    if (p.endsWith('/ExportLCLogActionInfo')) return { Parameters: [{ Name: 'ShareType', AllowableValues: ['Local', 'NFS', 'CIFS'] }, { Name: 'FileName' }] };
    if (p === `${MGR}/Oem/Dell/DellAttributes/iDRAC.Embedded.1`) return { Attributes: { 'Users.2.UserName': 'root', 'SNMP.1.AgentCommunity': 'public', 'Logging.1.LCLogAggregation': 'Disabled', 'Logging.1.LCLogAggregationTimeout': 60 } };
    if (p === '/redfish/v1/Systems') return { Members: [{ '@odata.id': '/redfish/v1/Systems/System.Embedded.1' }] };
    if (p === '/redfish/v1/Systems/System.Embedded.1/Storage') return { Members: [{ '@odata.id': '/redfish/v1/Systems/System.Embedded.1/Storage/RAID.Integrated.1-1' }] };
    if (p.endsWith('/Storage/RAID.Integrated.1-1')) return { Drives: [{ '@odata.id': '/redfish/v1/Systems/System.Embedded.1/Storage/RAID.Integrated.1-1/Drives/Disk.Bay.0' }] };
    if (p.endsWith('/Drives/Disk.Bay.0')) return { Id: 'Disk.Bay.0', MediaType: 'SSD', Protocol: 'SATA', SerialNumber: 'S123', FailurePredicted: false, PredictedMediaLifeLeftPercent: 97,
      Oem: { Dell: { DellPhysicalDisk: { PredictiveFailureState: 'SmartAlertAbsent', RaidStatus: 'Online' }, DellDriveSMARTAttributes: { '@odata.id': '/redfish/v1/Systems/System.Embedded.1/Storage/RAID.Integrated.1-1/Drives/Disk.Bay.0/Oem/Dell/DellDriveSMARTAttributes' } } } };
    if (p.endsWith('/DellDriveSMARTAttributes')) return { '@odata.id': p, ReallocatedBlockCount: 12, UncorrectableErrorCount: 0, Name: 'SMART' };
    throw Object.assign(new Error(`nf ${p}`), { status: 404 });
  };
  return { getJson, calls };
}

test('장비 진단: 읽기 전용 조회만 · 단계마다 따로 답한다 · 걸러 받기는 답이 맞는지로 판단 · 속성 전체를 내보내지 않는다', async () => {
  const { getJson, calls } = fakeIdrac();
  const p = await P.probeIdrac({}, { getJson, now: () => NOW });
  assert.equal(p.v, P.PROBE_VERSION);
  assert.deepEqual(p.manager, { firmware: '7.00.00.00', model: '14G Monolithic' });
  assert.equal(p.lclog.pageLen, 50); assert.equal(p.lclog.count, 120); assert.equal(p.lclog.nextLink, true); assert.equal(p.lclog.order, 'desc');
  assert.equal(p.filterExact.allMatch, true); assert.equal(p.filterExact.narrowed, true);
  assert.equal(p.filterPrefixEq.allMatch, false, '이 가짜 장비는 머리말 일치를 받지 않는다 — 0건은 지원으로 치지 않는다');
  assert.equal(p.filterNone.n, 0, '음성 대조: 없는 ID 로 물으면 0건');
  assert.deepEqual(p.filterVerdict, { ignoresFilter: false, exact: true, prefixEq: false, startsWith: false });
  assert.deepEqual(p.filterPdr.pdr54, { n: 1, matched: 1, count: 1 });
  assert.deepEqual(p.lcService.exports, ['ExportLCLog']); assert.deepEqual(p.lcService.ExportLCLog.shareTypes, ['Local', 'NFS', 'CIFS']); assert.equal(p.lcService.ExportCompleteLCLog, '없음');
  assert.deepEqual(Object.keys(p.logAttributes.matched).sort(), ['Logging.1.LCLogAggregation', 'Logging.1.LCLogAggregationTimeout']);
  const text = JSON.stringify(p);
  assert.equal(text.includes('public'), false); assert.equal(text.includes('"root"'), false); assert.equal(text.includes('S123'), false, '시리얼 · 계정 · 커뮤니티는 싣지 않는다');
  assert.equal(p.drive.values.PredictedMediaLifeLeftPercent, 97); assert.equal(p.drive.smart.ReallocatedBlockCount, 12);
  assert.equal('Name' in p.drive.smart, false, 'SMART 값은 수 · 불리언만 싣는다');
  assert.ok(calls.length <= 20, `조회 ${calls.length}번`);
  const filtered = calls.filter((c) => c.includes('$filter='));
  assert.ok(filtered.length >= 3 && filtered.every((c) => !/[ ']/.test(c) && c.includes('%27')), '걸러 받기 주소는 보낼 꼴 그대로(공백 · 따옴표를 미리 인코딩 — Digest uri 와 어긋나지 않게)');
  // 걸러 받기를 무시하는 장비(전부 돌려준다) — 맞지 않는 답은 지원으로 치지 않는다.
  const q = await P.probeIdrac({}, { getJson: fakeIdrac({ filterWorks: false }).getJson, now: () => NOW });
  assert.equal(q.filterExact.allMatch, false);
  assert.equal(q.filterVerdict.ignoresFilter, true); assert.equal(q.filterVerdict.exact, false);
  assert.equal(q.filterPdr.pdr54.matched, 0, '무시하는 장비가 준 첫 쪽 50건을 PDR54 로 세지 않는다'); assert.equal(q.filterPdr.pdr54.n, 50);
  // 첫 쪽이 전부 같은 ID 인 장비(로그인 기록으로 찬 로그)에서도 무시를 지원으로 보지 않는다 — 음성 대조가 가른다(반증 3.8.2 #3).
  const flood = Array.from({ length: 120 }, (_, i) => lc(120 - i, NOW - i * HOUR, 'IDRAC.2.9.USR0030'));
  const f2 = await P.probeIdrac({}, { now: () => NOW, getJson: async (_e, path) => {
    if (path === '/redfish/v1/Managers') return mgrs;
    if (path.startsWith(BASE)) return { Members: flood.slice(0, 50), 'Members@odata.count': flood.length };
    throw Object.assign(new Error('nf'), { status: 404 });
  } });
  assert.equal(f2.filterExact.allMatch, true); assert.equal(f2.filterVerdict.exact, false);
  // 한 단계가 실패해도 나머지는 답한다 · 실패는 상태 코드만.
  const broken = async (e, path) => { if (path.includes('DellLCService')) throw Object.assign(new Error('secret body text'), { status: 500 }); return getJson(e, path); };
  const b = await P.probeIdrac({}, { getJson: broken, now: () => NOW });
  assert.deepEqual(b.lcService, { error: 'HTTP 500' }); assert.equal(b.lclog.pageLen, 50);
  // 상태 코드 없는 오류는 문구를 싣지 않는다(본문 조각 · 호스트가 실리지 않게).
  const noStatus = async (e, path) => { if (path.includes('DellAttributes')) throw new Error('Unexpected token < in JSON <html>secret-host.example'); return getJson(e, path); };
  assert.deepEqual((await P.probeIdrac({}, { getJson: noStatus, now: () => NOW })).logAttributes, { error: '요청 실패' });
  // 인증이 거부되면(401) 남은 단계를 묻지 않는다 — 단계마다 다시 로그인하지 않는다(반증 3.8.2 #5).
  let after401 = 0; let denied = false;
  const deny = async (e, path) => {
    if (denied) after401 += 1;
    if (path.includes('$filter=')) { denied = true; throw Object.assign(new Error('401'), { status: 401, authFailed: true }); }
    return getJson(e, path);
  };
  const a = await P.probeIdrac({}, { getJson: deny, now: () => NOW });
  assert.equal(a.authDenied, true); assert.equal(after401, 0, '401 뒤로는 요청이 없다');
  assert.deepEqual(a.lcService, { skipped: '인증 거부 뒤 건너뜀' }); assert.deepEqual(a.drive, { skipped: '인증 거부 뒤 건너뜀' });
  // 장비가 준 경로는 정해진 꼴만 따라간다(.. · 쿼리 · 다른 자원으로 새지 않는다 — 반증 3.8.2 #10).
  const seen = [];
  const hostile = async (e, path) => {
    seen.push(path);
    if (path === '/redfish/v1/Systems') return { Members: [{ '@odata.id': '/redfish/v1/Systems/System.Embedded.1' }] };
    if (path === '/redfish/v1/Systems/System.Embedded.1/Storage') return { Members: [{ '@odata.id': '/redfish/v1/Systems/System.Embedded.1/Storage/../../../sysmgmt/x' }, { '@odata.id': '/redfish/v1/AccountService/Accounts/2?smart' }, { '@odata.id': '/redfish/v1/Systems/System.Embedded.1/Storage/RAID.Integrated.1-1' }] };
    if (path.endsWith('/Drives/Disk.Bay.0')) return { Id: 'Disk.Bay.0', Oem: { Dell: { X: { '@odata.id': '/redfish/v1/AccountService/Accounts/2?smart' }, Y: { '@odata.id': '/redfish/v1/Managers/iDRAC.Embedded.1/smart' } } } };
    return getJson(e, path);
  };
  const h = await P.probeIdrac({}, { getJson: hostile, now: () => NOW });
  assert.ok(!seen.some((x) => x.includes('..') || x.includes('sysmgmt') || x.includes('AccountService') || x.endsWith('/smart')), `따라간 경로: ${seen.join(' ')}`);
  assert.equal('smart' in h.drive, false, '디스크 아래가 아닌 SMART 링크는 따라가지 않는다');
  // 소스: 장비 상태를 바꾸는 호출이 없다(GET 헬퍼 하나만 부른다 — 내보내기 동작은 이름만 본다).
  const src = code('diskbad/probe.js');
  assert.doesNotMatch(src, /method\s*:|POST|PATCH|DELETE|bmcFetch|\.target\b/);
  assert.match(src, /const G = \(p\) => getJson\(entry, p, \{ signal \}\)/);
});

test('장비 진단 정제: 글자 · 수 · 불리언만, 깊이 · 개수 · 크기 상한, 프로토타입 키는 버린다', () => {
  const deep = { a: { b: { c: { d: { e: 'too deep' } } } }, s: 'x'.repeat(999), arr: Array.from({ length: 200 }, (_, i) => i), n: Infinity, fn: () => 1 };
  Object.defineProperty(deep, '__proto__', { value: { polluted: true }, enumerable: true });
  const c = I.cleanProbe(deep);
  assert.equal(c.a.b.c.d, null); assert.equal(c.s.length, 200); assert.equal(c.arr.length, 60); assert.equal(c.n, null); assert.equal(c.fn, null);
  assert.equal(Object.hasOwn(c, '__proto__'), false); assert.equal({}.polluted, undefined);
  assert.equal(c.polluted, undefined, '결과 객체의 프로토타입도 바뀌지 않는다');
  assert.equal(I.cleanProbe('x'), null); assert.equal(I.cleanProbe(null), null);
  const big = I.cleanProbe({ v: 1, list: Array.from({ length: 60 }, () => ({ k: Array.from({ length: 60 }, () => 'y'.repeat(200)) })) });
  assert.ok(big.error && JSON.stringify(big).length < 200);
  assert.equal(I.cleanServer({ id: 's', ok: false, reason: 'error', probe: { v: 1, manager: { firmware: 'f' } } }, NOW).probe.manager.firmware, 'f', '로그 읽기가 실패한 점검에도 진단은 실린다');
});

test('장비 진단은 서버 한 대를 직접 점검할 때만(manual) · 화면에는 관리자 판본에만', async () => {
  CU._resetCursorsForTest();
  const deps = { mock: true, invOf: () => null, authStoppedByPoller: () => false };
  const got = [];
  await SC.scanServers([{ id: '10.8.0.1', name: 'a' }], { manual: true, deps, onChunk: async (b) => { got.push(...b); return true; } });
  await SC.scanServers([{ id: '10.8.0.2', name: 'b' }], { manual: false, deps, onChunk: async (b) => { got.push(...b); return true; } });
  assert.ok(got[0].probe && got[0].probe.synthesized === true); assert.equal('probe' in got[1], false);
  assert.ok(Array.isArray(got[1].log.top) && got[1].log.pages > 0, '데모 결과에도 읽기 진단이 있다');
  const scan = code('diskbad/scan.js');
  assert.match(scan, /const probe = async \(\) => \{\s*if \(!manual\) return undefined;/);
  assert.match(scan, /reason === REASON\.authFailed \|\| reason === REASON\.unreachable\) \? undefined : await probe\(\)/, '인증 · 연결 실패면 다시 묻지 않는다');
  const route = code('routes/api/diskBad.js');
  assert.match(route, /isAdminDetailUser\(req\.user\) && d\.server\?\.probe \? \{ probe: d\.server\.probe, probeAt: d\.server\.probeAt \} : \{\}/);
});

// ── 반증 검토(3.8.2 변경분 · 12건) 반영 ───────────────────────────────────────────
const pager = (all, { count = 'total', next = true, past = 'empty' } = {}) => async (_e, p) => {
  if (p === '/redfish/v1/Managers') return mgrs;
  const k = skipOf(p); const rows = all.slice(k, k + 50);
  if (k >= all.length && past === 400) throw Object.assign(new Error('out of range'), { status: 400 });
  return { Members: rows, ...(count === 'total' ? { 'Members@odata.count': all.length } : count === 'page' ? { 'Members@odata.count': rows.length } : count === 'none' ? {} : { 'Members@odata.count': count }),
    ...(next && k + 50 < all.length ? { 'Members@odata.nextLink': 'n' } : {}) };
};

test('#4 장비가 준 관리자 경로는 정해진 꼴만 쓴다 · 끝 슬래시는 정규식으로 떼지 않는다', () => {
  assert.equal(L.safeMgrPath('/redfish/v1/Managers/iDRAC.Embedded.1/'), '/redfish/v1/Managers/iDRAC.Embedded.1');
  for (const bad of ['.evil.example', ':8443/x', '//evil.example/x', '/redfish/v1/Managers/../x', `/redfish/v1/Managers/${'/'.repeat(200_000)}x`, null, 5, '/redfish/v1/Managers/a?b']) {
    assert.equal(L.safeMgrPath(bad), L.DEFAULT_MGR, String(bad).slice(0, 40));
  }
  assert.doesNotMatch(code('diskbad/lclog.js'), /replace\(\/\\\/\+\$\//, '끝 슬래시 정규식(O(n²))을 다시 넣지 말 것');
  assert.doesNotMatch(code('diskbad/probe.js'), /replace\(\/\\\/\+?\$\//);
});

test('#7 못 읽은 건수는 0 이 아니다 · 첫 쪽보다 작은 건수는 버린다 — 끝까지 읽는다', async () => {
  const all = logOf(170, 160);
  for (const count of [null, '', [], true, 10, 'none']) {
    for (const rows of [all, [...all].reverse()]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await L.readLclog({}, { getJson: pager(rows, { count, next: false }) });
      assert.equal(r.total, null, `count=${JSON.stringify(count)}`); assert.equal(r.read, 170); assert.equal(r.reachedEnd, true); assert.equal(r.entries.length, 1);
    }
  }
  const huge = await L.readLclog({}, { getJson: pager(all, { count: 1e300, next: false }) });
  assert.equal(huge.total, null);
});

test('#6 끝 다음 쪽이 오류(400)여도 읽은 것을 버리지 않는다 · 더 있다고 한 쪽의 오류는 일부만 읽음 · 인증 오류는 던진다', async () => {
  const all = logOf(170, 160);
  const r = await L.readLclog({}, { getJson: pager(all, { count: 'page', past: 400 }) });
  assert.equal(r.read, 170); assert.equal(r.reachedEnd, true); assert.equal(r.entries.length, 1);
  const mid = async (e, p) => { if (skipOf(p) === 100) throw Object.assign(new Error('x'), { status: 500 }); return pager(all, { count: 'page' })(e, p); };
  const m = await L.readLclog({}, { getJson: mid });
  assert.equal(m.stopped, 'short'); assert.equal(m.reachedEnd, false); assert.equal(m.read, 100);
  const auth = async (e, p) => { if (skipOf(p) === 50) throw Object.assign(new Error('x'), { status: 401, authFailed: true }); return pager(all)(e, p); };
  await assert.rejects(L.readLclog({}, { getJson: auth }), (e) => e.status === 401);
  // 건수를 모르는데 Members 없는 답 — 더 있다고 했으면 short.
  const junk = async (e, p) => (skipOf(p) === 50 ? { oops: true } : pager(all, { count: 'page' })(e, p));
  assert.equal((await L.readLclog({}, { getJson: junk })).stopped, 'short');
});

test('#8 읽는 동안 로그가 늘어도 끝의 항목을 놓치지 않고 끝을 쫓아 무한히 묻지 않는다 · $skip 무시는 맨 위가 바뀌어도 잡는다', async () => {
  const base = logOf(1000, 995);
  let extra = 0; let calls = 0;
  const growing = async (_e, p) => {
    if (p === '/redfish/v1/Managers') return mgrs;
    calls += 1;
    const top = Array.from({ length: extra }, (_, i) => lc(100000 + extra - i, NOW + (extra - i) * 1000));
    const all = [...top, ...base]; extra += 2;
    return { Members: all.slice(skipOf(p), skipOf(p) + 50), 'Members@odata.count': all.length, 'Members@odata.nextLink': 'n' };
  };
  const r = await L.readLclog({}, { getJson: growing });
  assert.equal(r.reachedEnd, true); assert.equal(r.entries.length, 1, '끝쪽(995번째)의 PDR 을 읽었다'); assert.ok(calls < 40, `요청 ${calls}번`);
  let n = 0;
  const ignoring = async (_e, p) => {
    if (p === '/redfish/v1/Managers') return mgrs;
    n += 2;
    const top = Array.from({ length: n }, (_, i) => lc(200000 + n - i, NOW + (n - i) * 1000));
    return { Members: [...top, ...base].slice(0, 50), 'Members@odata.count': 1000 + n, 'Members@odata.nextLink': 'n' };
  };
  const s = await L.readLclog({}, { getJson: ignoring });
  assert.equal(s.stopped, 'skip'); assert.equal(s.reachedEnd, false);
});

test('#9 방향은 이웃한 항목끼리 본다 — 시계가 뒤로 간 새 항목 몇 건 때문에 오래된 것 먼저로 오판하지 않는다', async () => {
  const old = Array.from({ length: 45 }, (_, i) => lc(300 - i, NOW - i * HOUR));
  const fresh = [lc(305, NOW - DAY - 1 * 60_000), PDR54(304, NOW - DAY - 2 * 60_000), lc(303, NOW - DAY - 3 * 60_000), lc(302, NOW - DAY - 4 * 60_000), lc(301, NOW - DAY - 5 * 60_000)];
  assert.equal(L.orderOf([...fresh, ...old].map(L.entryRow)), 'desc');
  assert.equal(L.orderOf([lc(1, NOW), lc(2, NOW - HOUR), lc(3, NOW), lc(4, NOW - HOUR), lc(5, NOW), lc(6, NOW - 2 * HOUR)].map(L.entryRow)), 'unknown');
  assert.equal(L.orderOf([lc(1, NOW), lc(2, NOW)].map(L.entryRow)), 'unknown');
  const all = [...fresh, ...old, ...Array.from({ length: 255 }, (_, i) => lc(255 - i, NOW - (45 + i) * HOUR))];
  const r = await L.readLclog({}, { getJson: pager(all), cursor: { entryId: '300', created: NOW } });
  assert.equal(r.foundCursor, true); assert.equal(r.entries.length, 1, '시계가 뒤로 간 뒤의 PDR54 를 읽었다'); assert.equal(r.read, 6);
});

test('#2 · #11 읽기 진단은 지난 자리를 못 찾고 끝까지 읽은 점검도 반영 · 답한 단계가 없는 장비 진단은 지난 것을 덮지 않는다', async () => {
  const push = (x, at) => I.cleanPush({ v: 1, jobId: 'j', servers: [x] }, { now: at }).servers;
  await D.ingestServers('rv', push(result('r1', {}), NOW), { now: NOW });
  await D.ingestServers('rv', push(result('r1', { cursorUsed: true, foundCursor: false, reachedEnd: true, read: 4100, pages: 82, oldestRead: NOW + 5 * HOUR, newestCreated: NOW + DAY }), NOW + DAY), { now: NOW + DAY });
  let d = await D.loadServer('rv', 'r1');
  assert.equal(d.server.readDiag.read, 4100); assert.equal(d.server.readDiag.at, NOW + DAY);
  await D.ingestServers('rv', push(result('r1', { cursorUsed: true, foundCursor: true, reachedEnd: false, read: 3 }, { probe: { v: 1, at: NOW, manager: { firmware: '7.10' } } }), NOW + 2 * DAY), { now: NOW + 2 * DAY });
  await D.ingestServers('rv', push(result('r1', { cursorUsed: true, foundCursor: true, reachedEnd: false, read: 3 }, { probe: { v: 1, at: NOW, manager: { error: 'HTTP 403' }, lclog: { skipped: 'x' } } }), NOW + 3 * DAY), { now: NOW + 3 * DAY });
  d = await D.loadServer('rv', 'r1');
  assert.equal(d.server.readDiag.read, 4100, '자리를 찾은 이어 읽기는 덮지 않는다');
  assert.equal(d.server.probe.manager.firmware, '7.10', '전부 실패한 진단이 지난 정상 진단을 덮지 않는다');
  assert.equal(D.probeAnswered({ v: 0, error: 'x' }), false); assert.equal(D.probeAnswered({ v: 1, manager: { firmware: 'f' } }), true);
  // 지난 진단이 없으면 실패한 진단이라도 남긴다(실패했다는 사실을 보이게).
  await D.ingestServers('rv', push(result('r2', {}, { probe: { v: 0, at: NOW, error: '시한 초과' } }), NOW), { now: NOW });
  assert.equal((await D.loadServer('rv', 'r2')).server.probe.error, '시한 초과');
});

test('#1 활성 로그가 담은 기간은 시간이 지나도 늘지 않는다 — 하루치 서버를 주마다 점검해도 경고가 꺼지지 않는다', async () => {
  const srv = [{ agent: 'fade', id: 'w1', name: 'w1', corp: { id: 'vc1', name: 'NJ', country: 'China' } }];
  for (let w = 0; w <= 5; w += 1) {
    const at = NOW + w * 7 * DAY;
    // 활성 로그는 늘 20시간치 — 지난 자리는 이미 밀려나 못 찾고 끝까지 읽는다.
    // eslint-disable-next-line no-await-in-loop
    await D.ingestServers('fade', I.cleanPush({ v: 1, jobId: 'j', servers: [result('w1', { cursorUsed: w > 0, foundCursor: false, reachedEnd: true, oldestRead: at - 20 * HOUR, newestCreated: at })] }, { now: at }).servers, { now: at });
  }
  const now = NOW + 36 * DAY;
  const d = await D.loadServer('fade', 'w1');
  assert.ok(now - d.server.coveredFrom > 35 * DAY, '지금까지 본 가장 오래된 시각은 36일 전이다');
  const sp = S.logSpanOf(d.server);
  assert.ok(sp.ms <= 20 * HOUR && sp.ms > 19 * HOUR, `활성 로그 길이 ${sp.ms / HOUR}시간`);
  const f = S.buildFleet({ servers: srv, db: await D.loadAll(), now });
  assert.equal(f.totals.shortLog, 1); assert.ok(f.totals.medianLogDays < 1);
  assert.ok(f.servers[0].logSpanMs <= 20 * HOUR);
  // 월별 '그 달 로그가 남은 서버 비율' 은 끊김 없이 본 구간으로 센다 — 못 본 틈이 있는 지난달을 봤다고 하지 않는다.
  const prevMonth = f.months[f.months.length - 2];
  assert.equal(prevMonth.coveragePct, d.server.continuousSince <= Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1) - 1 ? 100 : 0);
  // 3.8.2 이전 엣지(진단 없음)는 첫 정상 점검 때의 범위로 — 이것도 늘지 않는다.
  const old = { complete: true, firstOkAt: NOW, coveredFrom: NOW - 20 * HOUR, readDiag: null };
  assert.equal(S.logSpanOf(old).ms, 20 * HOUR);
  assert.equal(S.logSpanOf({ complete: false, firstOkAt: NOW, coveredFrom: NOW - HOUR, readDiag: null }), null, '일부만 읽은 첫 점검으로는 길이를 말하지 않는다');
});

test('#12 장비 진단 상한은 UTF-8 바이트 · 건수를 못 읽은 상위 항목은 0 으로 두지 않고 버린다', () => {
  const kor = I.cleanProbe({ v: 1, list: Array.from({ length: 60 }, () => '가'.repeat(200)) });   // 12,000자 = 36KB
  assert.ok(kor.error, '글자 수가 아니라 바이트로 잰다');
  const c = I.cleanServer({ id: 's', ok: true, log: { top: [{ code: 'USR0030', n: 'x' }, { code: 'PDR54', n: 3 }] } }, NOW).log;
  assert.deepEqual(c.top, [{ code: 'PDR54', n: 3 }]);
});

// ── iDRAC 가 지금 알리는 디스크 상태(사용자 'iDRAC 정보만 가지고 판단하는 로직에 집중') ─────────────
const V = await import('../src/diskbad/verdict.js');
const bay = (n, extra = {}) => ({ id: `Disk.Bay.${n}:Enclosure.Internal.0-1:RAID.Integrated.1-1`, name: `Disk ${n}`, model: 'MZ7KH480', serial: `S${n}`, media: 'SSD', health: 'OK', state: 'Enabled', predictive: false, inVolume: true, ...extra });

test('지금 상태: 판정은 파트 장애 코어 하나(주의 · 이상) · 못 읽은 값 · 빈 슬롯 · 모르는 값은 경고가 아니다', () => {
  assert.equal(V.driveAlert(bay(0)), null);
  assert.deepEqual(V.driveAlert(bay(1, { health: 'Warning' })), { level: 'warn', raw: 'Warning / Enabled', predictive: false });
  assert.equal(V.driveAlert(bay(2, { health: 'Critical', predictive: true })).level, 'fault');
  assert.deepEqual(V.driveAlert(bay(3, { predictive: true })), { level: 'warn', raw: 'OK / Enabled', predictive: true });
  for (const d of [bay(4, { health: '' }), bay(5, { health: 'OK', state: 'Absent' }), bay(6, { health: 'Weird' }), bay(7, { health: '', predictive: true }), null, 'x']) assert.equal(V.driveAlert(d), null);
  assert.deepEqual(V.ALERT_LABEL, { warn: '주의', fault: '이상' });
  assert.match(code('diskbad/verdict.js'), /redfishPartState\(\{ health: d\.health, state: d\.state, predictiveFailure:/, '판정을 복제하지 않고 파트 장애 코어를 부른다');
  // 엣지가 보낸 디스크의 state 는 정제를 지나 남는다 · 인벤토리에서 꺼낼 때도 싣는다.
  assert.equal(I.cleanServer({ id: 's', ok: true, log: {}, drives: [{ id: 'Disk.Bay.1', health: 'Warning', state: 'Enabled', evil: 1 }] }, NOW).drives[0].state, 'Enabled');
  assert.equal(SC.drivesOf({ disks: [{ id: 'd', health: 'OK', state: 'Enabled' }] })[0].state, 'Enabled');
});

test('지금 상태: 서버 판정과 전 법인 합계 — 배드 섹터 기록이 없어도 보이고, 디스크 목록을 못 읽은 서버는 0 이 아니라 따로 센다', async () => {
  const drives = [bay(0), bay(3, { health: 'Warning' }), bay(5, { health: 'Critical', predictive: true })];
  const rec = { created: NOW - DAY, code: 'PDR54', cls: 'corrected', slotKey: 'bp1:d3' };
  const j = V.judgeServer({ records: [rec], drives, serialRows: [], coverage: { continuousSince: NOW - 2 * DAY, lastOkAt: NOW, complete: true } });
  assert.equal(j.counts.alerting, 2);
  assert.deepEqual(j.alerting.map((a) => [a.label, a.level, a.hasRecords]), [['Disk 3 · Backplane 1', 'warn', true], ['Disk 5 · Backplane 1', 'fault', false]]);
  const none = V.judgeServer({ records: [], drives: null, serialRows: [], coverage: { lastOkAt: NOW } });
  assert.equal(none.alerting, null); assert.equal(none.counts.alerting, null);
  // 전 법인: 기록 0건인 서버의 경고 디스크도 목록에 오른다(활성 로그가 며칠치뿐이어도 보이는 근거).
  const push = (id, d) => I.cleanPush({ v: 1, jobId: 'j', servers: [{ ...result(id, {}), drives: d }] }, { now: NOW }).servers;
  await D.ingestServers('alr', push('a1', drives), { now: NOW });
  await D.ingestServers('alr', push('a2', [bay(0), bay(1)]), { now: NOW });
  await D.ingestServers('alr', I.cleanPush({ v: 1, jobId: 'j', servers: [{ ...result('a3', {}), drives: null }] }, { now: NOW }).servers, { now: NOW });
  const corp = { id: 'vc1', name: 'NJ', country: 'China' };
  const f = S.buildFleet({ servers: ['a1', 'a2', 'a3', 'a4'].map((id) => ({ agent: 'alr', id, name: id, corp })), db: await D.loadAll(), now: NOW + HOUR });
  assert.equal(f.totals.alertingDisks, 2); assert.equal(f.totals.alertingServers, 1); assert.equal(f.totals.drivesUnknownServers, 1);
  assert.equal(f.totals.recordSlots, 0, '배드 섹터 기록은 0 — 그래도 경고 디스크는 보인다');
  assert.deepEqual(f.alerting.map((a) => [a.serverId, a.level]), [['a1', 'fault'], ['a1', 'warn']], '이상이 먼저');
  assert.equal(f.servers.find((x) => x.serverId === 'a3').alerting, null); assert.equal(f.servers.find((x) => x.serverId === 'a2').alerting, 0);
});
