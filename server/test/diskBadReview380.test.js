// v3.8.0 디스크 배드 섹터 이력 — 반증 검토(1회) 확정분 18건 가운데 고친 것을 고정한다(번호는 검토 보고서의 번호).
//   설계 · 기록: docs/design/idrac-disk-badsector/README.md §20 · docs/rules/idrac-server.md 'v3.8.0 디스크 배드 섹터 이력'.
//   스윕은 test/_stripComments.js 로 주석을 먼저 지운다. 기준 시각은 실제 시각을 정시 경계로 떨어뜨려 고정한다(docs/rules/common.md).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'diskbadrv380-'));
process.env.CONFIG_DIR = TMP;
process.env.DISKBAD_DB_PATH = path.join(TMP, 'disk-bad.db');
process.env.AUTH_ENABLED = 'false';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = (p) => stripComments(fs.readFileSync(path.join(ROOT, 'src', p), 'utf8'));
const webCode = (p) => stripComments(fs.readFileSync(path.join(ROOT, '..', 'web', 'src', p), 'utf8'));
const HOUR = 3_600_000; const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

const V = await import('../src/diskbad/verdict.js');
const L = await import('../src/diskbad/lclog.js');
const I = await import('../src/diskbad/ingest.js');
const D = await import('../src/diskbad/db.js');
const J = await import('../src/diskbad/jobs.js');
const SC = await import('../src/diskbad/scan.js');
const CU = await import('../src/diskbad/cursors.js');
const AK = await import('../src/diskbad/agentKey.js');
const ED = await import('../src/diskbad/edge.js');
const ST = await import('../src/diskbad/settings.js');

after(() => { try { D._resetDiskBadDbForTest(); } catch { /* */ } fs.rmSync(TMP, { recursive: true, force: true }); });

const mgr = { Members: [{ '@odata.id': '/redfish/v1/Managers/iDRAC.Embedded.1' }] };
const lc = (id, created, msgId = 'IDRAC.2.9.LOG007', message = 'x') => ({ Id: String(id), Created: new Date(created).toISOString(), MessageId: msgId, Message: message });
const PDR = (id, created, code = 'PDR46') => lc(id, created, `IDRAC.2.9.${code}`, `media error on Disk 3 in Backplane 1 of Integrated RAID Controller 1 ${code}`);

// ── #1(높음) 커서는 저장됐다는 답을 받은 서버만 앞으로 ─────────────────────────────
test('#1 scanServers: 저장 실패(false · 던짐) 묶음의 커서는 그대로 · 다음 묶음은 계속 보내고 저장된 것만 커서를 적는다', async () => {
  const servers = Array.from({ length: SC.CHUNK_SERVERS + 3 }, (_, i) => ({ id: `10.9.0.${i + 1}`, name: `s${i}` }));
  CU._resetCursorsForTest();
  const calls = [];
  const stat = await SC.scanServers(servers, {
    deps: { mock: true, invOf: () => null, authStoppedByPoller: () => false },
    onChunk: async (batch, st) => {
      calls.push({ n: batch.length, final: st.final });
      if (calls.length === 1) throw new Error('중앙 503');   // 첫 묶음(25대)은 저장 실패
      return true;
    },
  });
  assert.equal(calls.length, 2, '첫 묶음이 실패해도 다음 묶음을 보낸다');
  assert.equal(stat.unsaved, SC.CHUNK_SERVERS);
  const firstBatch = new Set(servers.slice(0, SC.CHUNK_SERVERS).map((s) => s.id));
  // 동시 4대라 어느 서버가 첫 묶음인지 순서는 정해지지 않는다 — 커서가 있는 서버 수 = 저장된 서버 수.
  const withCursor = servers.filter((s) => CU.cursorOf(s.id)).length;
  assert.equal(withCursor, servers.length - SC.CHUNK_SERVERS);
  void firstBatch;
  // false 를 돌려줘도 같다(중앙이 stored:false).
  CU._resetCursorsForTest();
  fs.rmSync(path.join(TMP, CU.CURSOR_FILE), { force: true });
  CU._resetCursorsForTest();
  const st2 = await SC.scanServers(servers.slice(0, 3), { deps: { mock: true, invOf: () => null, authStoppedByPoller: () => false }, onChunk: async () => false });
  assert.equal(st2.unsaved, 3);
  assert.equal(servers.slice(0, 3).filter((s) => CU.cursorOf(s.id)).length, 0);
});

test('#1 작업: 닫힌 · 모르는 작업(중앙 재시작)의 보고는 stored:false + stop:true · 엣지 워커는 그때 멈추고 false 를 돌려준다', async () => {
  J._resetJobsForTest();
  const r = await J.acceptPush('edgez', I.cleanPush({ v: 1, jobId: 'gone', servers: [] }, { now: NOW }));
  assert.equal(r.stored, false); assert.equal(r.stop, true);
  const edge = code('diskbad/edge.js');
  assert.match(edge, /if \(ack\.stored === false\) \{[\s\S]*?stop = true;[\s\S]*?return false;/);
  assert.match(edge, /catch \(e\) \{ failures\.push\([^)]*\)[^}]*return false; \}/);
  // 중앙 직결도 저장 실패를 false 로(던지면 다음 묶음이 끊겼다).
  const jobs = code('diskbad/jobs.js');
  assert.match(jobs, /if \(!r\.ok\) \{ u\.error = [^}]*return false; \}/);
  assert.doesNotMatch(jobs, /throw new Error\(r\.reason \|\| 'DB 저장 실패'\)/);
});

test('#1 엣지 포탈에서는 점검 · 중단 · 다시 보내기 · 설정을 받지 않는다(커서 파일을 중앙 작업과 함께 쓴다)', () => {
  const r = code('routes/api/diskBad.js');
  for (const route of ['scan', 'jobs/:id/stop', 'jobs/:id/retry', 'settings']) {
    const i = r.indexOf(`'/tools/disk-bad/${route}'`);
    assert.ok(i > 0, route);
    assert.match(r.slice(i, i + 700), /if \(isEdge\(\)\) return res\.status\(409\)\.json\(EDGE_NODE\)/, route);
  }
});

// ── #2 진행 보고 간격 < 무응답 판정 ──────────────────────────────────────────────
test('#2 엣지는 2분마다 진행 보고 · 무응답 판정(45분)은 그 간격의 여러 배 · 서버 0대 보고는 DB 를 건드리지 않고 updatedAt 만 올린다', async () => {
  assert.ok(ED.HEARTBEAT_MS * 5 <= J.STALL_TIMEOUT_MS, `${ED.HEARTBEAT_MS} × 5 ≤ ${J.STALL_TIMEOUT_MS}`);
  assert.ok(SC.SERVER_TIMEOUT_MS() < J.STALL_TIMEOUT_MS, '서버 한 대의 시한도 무응답 판정보다 짧다');
  const edge = code('diskbad/edge.js');
  assert.match(edge, /setInterval\(\(\) => \{\s*postChunk\(job, \[\]/);
  assert.match(edge, /finally \{ clearInterval\(hb\); \}/);
  J._resetJobsForTest();
  const job = J.createJob({ scope: 'corp', units: [{ agent: 'hb1', kind: 'edge', serverIds: ['a', 'b'] }] });
  J.claimForAgent('hb1');
  const gen = D.diskBadGeneration();
  const before = J.getJob(job.id).units[0].updatedAt;
  await new Promise((r) => { setTimeout(r, 5); });
  const ack = await J.acceptPush('hb1', I.cleanPush({ v: 1, jobId: job.id, final: false, done: 1, total: 2, servers: [] }, { now: NOW }));
  assert.equal(ack.stored, true);
  assert.equal(D.diskBadGeneration(), gen, '진행 보고는 화면 캐시를 버리지 않는다');
  const u = J.getJob(job.id).units[0];
  assert.ok(u.updatedAt > before); assert.equal(u.done, 1);
});

// ── #3 인증 이름 ↔ 등록부 id ────────────────────────────────────────────────────
test('#3 agentKeyOf: id 먼저 · 이름이 하나만 맞으면 그 id · 둘이면 풀지 않는다 · 중앙 수신 두 곳이 쓴다', () => {
  const list = [{ id: 'pl-warsaw', name: 'warsaw-edge' }, { id: 'us-east', name: 'dup' }, { id: 'us-east-2', name: 'DUP' }];
  assert.equal(AK.agentKeyOf('PL-Warsaw', list), 'pl-warsaw');
  assert.equal(AK.agentKeyOf('warsaw-edge', list), 'pl-warsaw');
  assert.equal(AK.agentKeyOf('dup', list), 'dup');
  assert.equal(AK.agentKeyOf('Other', list), 'other');
  assert.equal(AK.agentKeyOf('', list), '');
  const central = code('routes/central/storageRoutes.js');
  assert.match(central, /claimForAgent\(agentKeyOf\(agent\)\)/);
  assert.match(central, /acceptPush\(agentKeyOf\(agent\), p\)/);
  // 이름으로 가져가도 등록부 id 의 조각을 받는다.
  J._resetJobsForTest();
  J.createJob({ scope: 'corp', units: [{ agent: 'pl-warsaw', kind: 'edge', serverIds: ['x'] }] });
  assert.ok(J.claimForAgent(AK.agentKeyOf('warsaw-edge', list)));
});

// ── #4 조각 권한 = 조각이 맡은 서버 집합 ─────────────────────────────────────────
test('#4 unitAccess: 중앙 직결 조각 공유 · 서버 집합으로 판정 · 조회 밖 404 → 쓰기 밖 403 · 쓰기만 줄인 계정도 검사', async () => {
  const { unitAccess } = await import('../src/routes/api/diskBad.js');
  const snap = { vcenters: [{ id: 'vcX' }, { id: 'vcY' }] };
  const srv = (agent, id, vc) => ({ agent, id, vc });
  const all = [srv('', '10.0.0.1', 'vcX'), srv('', '10.0.0.2', 'vcY'), srv('edgey', '10.1.0.1', 'vcY')];
  const ctxOf = (visible, scoped) => ({ scoped, visible: new Map(visible.map((s) => [`${s.agent}|${s.id}`, s])), all, snap });
  // 범위 계정 U(법인 Y — 중앙 직결 10.0.0.2 와 엣지 edgey 를 가짐)
  const U = { user: { username: 'u', role: 'operator', scope: { vcenters: ['vcY'] } } };
  const ctxU = ctxOf(all.filter((s) => s.vc === 'vcY'), true);
  assert.equal(unitAccess(U, { agent: '', serverIds: ['10.0.0.1'] }, ctxU, { write: true }), 404, '다른 법인(X)의 중앙 직결 작업');
  assert.equal(unitAccess(U, { agent: '', serverIds: null }, ctxU), 404, "'전체' 작업의 중앙 직결 조각(전 법인)");
  assert.equal(unitAccess(U, { agent: '', serverIds: ['10.0.0.2'] }, ctxU, { write: true }), 200);
  assert.equal(unitAccess(U, { agent: 'edgey', serverIds: null }, ctxU, { write: true }), 200, '자기 엣지 전체');
  // 조회 무제한 · 쓰기만 vcY 로 줄인 계정 W
  const W = { user: { username: 'w', role: 'operator', scope: { writeVcenters: ['vcY'] } } };
  const ctxW = ctxOf(all, false);
  assert.equal(unitAccess(W, { agent: '', serverIds: ['10.0.0.1'] }, ctxW), 200, '보기는 된다');
  assert.equal(unitAccess(W, { agent: '', serverIds: ['10.0.0.1'] }, ctxW, { write: true }), 403, '쓰기 범위 밖 법인 조각은 조작 못 함');
  assert.equal(unitAccess(W, { agent: '', serverIds: null }, ctxW, { write: true }), 403);
  // 전체 범위
  assert.equal(unitAccess({ user: { username: 'a', role: 'admin' } }, { agent: '', serverIds: null }, ctxW, { write: true }), 200);
  const r = code('routes/api/diskBad.js');
  assert.doesNotMatch(r, /unitAllowed/);
  assert.match(r, /unitAccess\(req, u, unitCtx\(req\), \{ write: true \}\)/);
  assert.match(r, /by: \['auto', 'demo', me\]\.includes\(j\.by\) \? j\.by : ''/, '범위 계정에는 다른 사람의 계정명을 싣지 않는다');
});

// ── #5 설정은 조회 · 쓰기 모두 전체 범위 ─────────────────────────────────────────
test('#5 설정 저장은 fullReadWriteScopeOnlyWith(쓰기만 줄인 admin 이 전 법인 자동 점검을 켜지 못하게)', () => {
  const r = code('routes/api/diskBad.js');
  assert.match(r, /const fullScopeOnly = fullReadWriteScopeOnlyWith\(/);
  assert.doesNotMatch(r, /fullScopeOnlyWith\(/);
});

// ── #6 · #7 · #17 판정 ───────────────────────────────────────────────────────────
const T0 = NOW - 100 * DAY;
test('#6 새 디스크를 처음 보기 전(이전 디스크 마지막 관찰 뒤)에 난 기록은 교체됨 · 확정이 아니다', () => {
  const v = V.judgeSlot({ slotKey: 'bp1:d3', records: [{ created: T0 + 5 * HOUR, code: 'PDR64', cls: 'unrecoverable' }],
    drive: { serial: 'B' }, serials: [{ serial: 'A', firstSeen: T0 - 30 * DAY, lastSeen: T0 }, { serial: 'B', firstSeen: T0 + 6 * HOUR, lastSeen: T0 + 6 * HOUR }],
    continuousSince: T0 - 60 * DAY });
  assert.equal(v.verdict, 'unknown'); assert.equal(v.confidence, 'none');
  // 기록 시각에 A 를 실제로 보고 있었으면(처음 ~ 마지막 사이) 교체됨 · 확정.
  const w = V.judgeSlot({ slotKey: 'bp1:d3', records: [{ created: T0 - DAY, code: 'PDR64', cls: 'unrecoverable' }],
    drive: { serial: 'B' }, serials: [{ serial: 'A', firstSeen: T0 - 30 * DAY, lastSeen: T0 }, { serial: 'B', firstSeen: T0 + 6 * HOUR, lastSeen: T0 + DAY }],
    continuousSince: T0 - 60 * DAY });
  assert.equal(w.verdict, 'replaced'); assert.equal(w.confidence, 'confirmed');
  // 지금 시리얼을 못 읽으면 '바뀌었다' 고 말하지 않는다.
  const x = V.judgeSlot({ slotKey: 'bp1:d3', records: [{ created: T0 - DAY, code: 'PDR64', cls: 'unrecoverable' }],
    drive: { serial: '' }, serials: [{ serial: 'A', firstSeen: T0 - 30 * DAY, lastSeen: T0 }], continuousSince: null });
  assert.notEqual(x.verdict, 'replaced');
});

test('#7 기록 뒤에 이 자리에서 다른 시리얼을 본 적이 있으면 아직 사용 중 · 추정이 아니다(교체됨 · 추정)', () => {
  const v = V.judgeSlot({ slotKey: 'bp1:d3', records: [{ created: T0 - 10 * DAY, code: 'PDR46', cls: 'unrecoverable' }],
    drive: { serial: 'B' }, serials: [{ serial: 'A', firstSeen: T0, lastSeen: T0 + 5 * DAY }, { serial: 'B', firstSeen: T0 + 6 * DAY, lastSeen: T0 + 7 * DAY }],
    continuousSince: T0 - 90 * DAY });
  assert.equal(v.verdict, 'replaced'); assert.equal(v.confidence, 'estimated');
  assert.ok(v.evidence.some((e) => e.text.includes('A') && e.text.includes('B')));
});

test('#17 시리얼 확정은 마지막으로 본 때까지 — 그 뒤 빠짐 기록이 있으면 판단 불가 · 근거에 마지막 관찰 시각', () => {
  const v = V.judgeSlot({ slotKey: 'bp1:d3', records: [{ created: T0, code: 'PDR46', cls: 'unrecoverable' }, { created: T0 + 3 * DAY, code: 'PDR5', cls: 'removed' }],
    drive: { serial: 'A' }, serials: [{ serial: 'A', firstSeen: T0 - 30 * DAY, lastSeen: T0 + DAY }], continuousSince: T0 - 60 * DAY });
  assert.equal(v.verdict, 'unknown');
  const w = V.judgeSlot({ slotKey: 'bp1:d3', records: [{ created: T0, code: 'PDR46', cls: 'unrecoverable' }],
    drive: { serial: 'A' }, serials: [{ serial: 'A', firstSeen: T0 - 30 * DAY, lastSeen: T0 + DAY }], continuousSince: T0 - 60 * DAY });
  assert.equal(w.verdict, 'inUse'); assert.equal(w.confidence, 'confirmed');
  assert.ok(w.evidence[1].text.includes('마지막 점검') && !w.evidence[1].text.includes('지금까지'));
});

// ── #9 · #14 로그 읽기 ───────────────────────────────────────────────────────────
test('#9 $skip 을 무시하는 장비 — 최신 먼저 · 오래된 것 먼저 모두 일부만 읽음(skip)으로 멈춘다(거짓 끝까지 읽음 금지)', async () => {
  const base = NOW - 10 * DAY;
  const desc = Array.from({ length: 200 }, (_, i) => lc(1000 - i, base - i * HOUR));
  const asc = [...desc].reverse();
  const ignoring = (rows) => async (_e, p) => (p === '/redfish/v1/Managers' ? mgr : { Members: rows.slice(0, 50), 'Members@odata.count': rows.length });
  const a = await L.readLclog({}, { getJson: ignoring(desc) });
  assert.equal(a.stopped, 'skip'); assert.equal(a.reachedEnd, false);
  const b = await L.readLclog({}, { getJson: ignoring(asc) });
  assert.equal(b.stopped, 'skip'); assert.equal(b.reachedEnd, false);
  // 지원하는 장비는 그대로 끝까지.
  const honoring = (rows) => async (_e, p) => {
    if (p === '/redfish/v1/Managers') return mgr;
    const m = /\$skip=(\d+)/.exec(p); const k = m ? Number(m[1]) : 0;
    return { Members: rows.slice(k, k + 50), 'Members@odata.count': rows.length };
  };
  const c = await L.readLclog({}, { getJson: honoring(asc) });
  assert.equal(c.reachedEnd, true); assert.equal(c.read, 200); assert.equal(c.stopped, '');
  assert.equal(I.cleanServer({ id: 'q', ok: true, log: { stopped: 'skip' } }, NOW).log.stopped, 'skip');
});

test('#14 지난번 자리는 같은 항목일 때만 — 시계가 거꾸로 간 뒤의 새 항목(더 오래된 시각)을 건너뛰지 않는다', async () => {
  const curT = NOW - DAY;
  // 최신 먼저: 13(새) · 12(새 — 시계가 거꾸로 가 시각은 더 오래됨) · 11(지난번 자리) · 10. 예전 판정('시각이 더 오래되면 찾음')은 12 에서 멈췄다.
  const rows = [lc(13, curT + HOUR), PDR(12, curT - 30 * DAY), lc(11, curT), lc(10, curT - HOUR)];
  const getJson = async (_e, p) => (p === '/redfish/v1/Managers' ? mgr : { Members: rows, 'Members@odata.count': rows.length });
  const r = await L.readLclog({}, { getJson, cursor: { entryId: '11', created: curT } });
  assert.equal(r.foundCursor, true);
  assert.equal(r.entries.length, 1); assert.equal(r.entries[0].entryId, '12');
});

// ── #8 · #10 · #15 · #11 적재 ────────────────────────────────────────────────────
const result = (id, recs, log = {}) => ({
  id, name: id, host: '10.0.0.9', ok: true, reason: '', invAt: NOW - HOUR, drives: [],
  log: { order: 'desc', total: 100, read: 100, oldestRead: NOW - 900 * HOUR, reachedEnd: true, foundCursor: false, cursorUsed: false, ...log },
  records: recs,
});
const rec = (id, created, codeId = 'PDR46') => ({ entryId: String(id), created, messageId: `IDRAC.2.9.${codeId}`, severity: 'Warning', message: `media error on Disk 3 in Backplane 1 of RAID Controller 1 ${codeId}` });

test('#8 기록 상한으로 잘린 점검은 남긴 가장 오래된 기록부터만 본 것 · complete 아님 · 이유(capped)를 남긴다 · 엣지 커서도 끝까지 봄이 아니다', async () => {
  const recs = [rec(1, NOW - 5 * HOUR), rec(2, NOW - 3 * HOUR)];
  const r = await D.ingestServers('capa', [{ ...result('c1', recs), recordsCapped: true }], { now: NOW });
  assert.equal(r.ok, true);
  const d = await D.loadServer('capa', 'c1');
  assert.equal(d.server.continuousSince, NOW - 5 * HOUR);
  assert.equal(d.server.complete, false); assert.equal(d.server.readStop, 'capped');
  assert.equal(d.server.logOldest, null, '끝까지 읽음이 아니므로 로그의 가장 오래된 시각을 적지 않는다');
  const scan = code('diskbad/scan.js');
  assert.match(scan, /complete: !capped && \(r\.reachedEnd \|\| r\.foundCursor\)/);
  assert.match(scan, /sort\(\(a, b\) => \(b\.created \?\? -Infinity\) - \(a\.created \?\? -Infinity\)\)\.slice\(0, RECORDS_MAX\)/);
});

test('#10 시계가 빠른 iDRAC — 같은 항목을 다시 읽어도 한 행 · 새 기록 아님(키는 원래 시각)', async () => {
  const ahead = NOW + 9 * HOUR;   // 장비 시계가 9시간 빠름
  const push = (recvAt) => I.cleanPush({ v: 1, jobId: 'j', servers: [result('k1', [rec(777, ahead)], { newestCreated: ahead })] }, { now: recvAt });
  const p1 = push(NOW); const p2 = push(NOW + 6 * HOUR);
  assert.equal(p1.servers[0].records[0].clockAhead, true);
  assert.equal(p1.servers[0].records[0].createdRaw, ahead);
  await D.ingestServers('clk', p1.servers, { now: NOW });
  const r2 = await D.ingestServers('clk', p2.servers, { now: NOW + 6 * HOUR });
  assert.equal(r2.newRecords.length, 0);
  assert.equal((await D.loadServer('clk', 'k1')).records.length, 1);
});

test('#15 지난 점검에서 본 가장 새 항목보다 오래된 기록은 채워 넣기 — 저장은 하되 새 기록(메일)이 아니다', async () => {
  await D.ingestServers('bf', [result('b1', [rec(1, NOW - 50 * HOUR)], { newestCreated: NOW - 10 * HOUR, reachedEnd: false, stopped: 'budget' })], { now: NOW });   // 기준선(일부만)
  const r = await D.ingestServers('bf', [result('b1', [rec(2, NOW - 80 * HOUR), rec(3, NOW - 2 * HOUR, 'PDR54')], { newestCreated: NOW - HOUR })], { now: NOW + HOUR });
  assert.deepEqual(r.newRecords.map((x) => x.code), ['PDR54']);
  assert.equal((await D.loadServer('bf', 'b1')).records.length, 3);
});

test('#11 loadAll 은 세대가 같으면 다시 읽지 않는다 · 라우트는 캐시를 DB 읽기보다 먼저 본다 · 서버 단위 트랜잭션 + 양보 · 서버당 상한', async () => {
  const a = await D.loadAll(); const b = await D.loadAll();
  assert.equal(a, b);
  await D.ingestServers('gen', [result('g1', [])], { now: NOW });
  assert.notEqual(await D.loadAll(), a);
  const r = code('routes/api/diskBad.js');
  const h = r.slice(r.indexOf("api.get('/tools/disk-bad', toolsPerm"));
  assert.ok(h.indexOf('memoGet(key, gen)') > 0 && h.indexOf('memoGet(key, gen)') < h.indexOf('await loadAll()'));
  const db = code('diskbad/db.js');
  assert.match(db, /for \(const s of servers \|\| \[\]\) \{\s*await yielder\(\);[\s\S]*?h\.db\.exec\('BEGIN'\)/);
  assert.match(db, /pruneOf\.run\(a, s\.id, RECORDS_PER_SERVER_MAX\)/);
  assert.ok(D.RECORDS_PER_SERVER_MAX >= I.RECORDS_MAX * 2);
});

// ── #12 메일 법인 표는 한 번 ─────────────────────────────────────────────────────
test('#12 메일 한 번에 법인 표를 한 번 만든다(기록마다 물리 서버 판정을 다시 돌지 않는다)', () => {
  const jobs = code('diskbad/jobs.js');
  assert.match(jobs, /corpOf = _corpOfFactory\(\) \|\| corpOf/);
  const r = code('routes/api/diskBad.js');
  assert.match(r, /setCorpResolver\(\(\) => \{\s*const m = new Map\(\);/);
});

// ── #13 자동 점검 ────────────────────────────────────────────────────────────────
test('#13 자동 점검: 기동 뒤 5분은 판정하지 않는다 · 마지막 실행 시각은 DB 에 남아 재시작 뒤에도 주기를 지킨다', async () => {
  ST.saveDiskBadSettings({ autoEnabled: true, intervalHours: 6 });
  J._resetJobsForTest();
  J._setBootAtForTest(NOW);
  assert.equal(await J.autoTick(NOW + J.AUTO_BOOT_DELAY_MS - 1000), null, '기동 직후');
  await D.setDiskBadMeta('autoLastAt', NOW - HOUR);   // 재시작 전 1시간 전에 돌았다
  assert.equal(await J.autoTick(NOW + J.AUTO_BOOT_DELAY_MS + 1000), null, '6시간이 안 됐다');
  const job = await J.autoTick(NOW + 6 * HOUR);
  assert.ok(job && job.auto === true);
  assert.equal(Number(await D.getDiskBadMeta('autoLastAt')), NOW + 6 * HOUR);
  ST.saveDiskBadSettings({ autoEnabled: false });
});

// ── #16 서버는 (엣지, id)로 ──────────────────────────────────────────────────────
test('#16 서버 상세 · 서버 1대 점검은 (엣지, id)로 찾는다 · 화면이 agent 를 보낸다', () => {
  const r = code('routes/api/diskBad.js');
  assert.match(r, /findServer\(servers, req\.params\.id, typeof req\.query\.agent === 'string' \? req\.query\.agent : null\)/);
  assert.match(r, /findServer\(servers, target, typeof body\.agent === 'string' \? body\.agent : null\)/);
  assert.doesNotMatch(r, /servers\.find\(\(x\) => x\.id ===/);
  const panel = webCode('views/tools/DiskBadServerPanel.jsx');
  assert.match(panel, /\?agent=\$\{encodeURIComponent\(agent\)\}/);
  assert.match(panel, /scope: 'server', serverId, \.\.\.\(agent != null \? \{ agent \} : \{\}\)/);
  assert.match(webCode('views/idrac/IdracDetailModal.jsx'), /<DiskBadServerPanel serverId=\{server\.id\} agent=\{server\.remote \? String\(server\.collectorId \|\| ''\) : ''\} \/>/);
});

// ── 감사 로그 형식(전량 테스트 auditMiscall2569 가 잡은 것) ─────────────────────
test('감사 로그는 logAudit({ user, action, target, detail, ip }) 형식', () => {
  const r = code('routes/api/diskBad.js');
  assert.doesNotMatch(r, /logAudit\(req,/);
  assert.equal((r.match(/logAudit\(\{ user: /g) || []).length, 5);
});
