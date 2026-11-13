// v2.915 디스크 배드 섹터 이력 — 분류 · 위치 · 로그 읽기 · 판정 · 정제 · DB 적재 · 작업 · 메일 · 집계 · 배선을 고정한다.
//   설계: docs/design/idrac-disk-badsector/README.md. 스윕은 test/_stripComments.js 로 주석을 먼저 지운다(주석이 통과 근거가 되지 않게).
//   기준 시각은 실제 시각을 정시 경계로 떨어뜨려 고정한다(docs/rules/common.md — Date.now() 직접 · 고정 epoch 금지).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'diskbad2915-'));
process.env.CONFIG_DIR = TMP;
process.env.DISKBAD_DB_PATH = path.join(TMP, 'disk-bad.db');
process.env.AUTH_ENABLED = 'false';
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const code = (p) => stripComments(fs.readFileSync(path.join(SRC, p), 'utf8'));
const HOUR = 3_600_000; const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

const C = await import('../src/diskbad/classify.js');
const V = await import('../src/diskbad/verdict.js');
const L = await import('../src/diskbad/lclog.js');
const I = await import('../src/diskbad/ingest.js');
const D = await import('../src/diskbad/db.js');
const J = await import('../src/diskbad/jobs.js');
const N = await import('../src/diskbad/notify.js');
const S = await import('../src/diskbad/summary.js');
const ST = await import('../src/diskbad/settings.js');

after(() => { try { D._resetDiskBadDbForTest(); } catch { /* */ } fs.rmSync(TMP, { recursive: true, force: true }); });

// ── 분류 ──────────────────────────────────────────────────────────────────────
test('codeOf: MessageId 끝 토큰 · 이상한 값은 빈 문자열', () => {
  assert.equal(C.codeOf('IDRAC.2.9.PDR46'), 'PDR46');
  assert.equal(C.codeOf('PDR54'), 'PDR54');
  assert.equal(C.codeOf('idrac.2.8.pdr16'), 'PDR16');
  assert.equal(C.codeOf(''), '');
  assert.equal(C.codeOf('IDRAC.2.9.'), '');
  assert.equal(C.codeOf('x'.repeat(10_000)), '');
});

test('분류표: 근거 문서가 있는 ID 만 — 항목마다 출처 URL · 확인 수준 · 미확인 ID(PDR56 · 삽입 ID)는 없다', () => {
  for (const [id, v] of Object.entries(C.ID_TABLE)) {
    assert.ok(Array.isArray(v.sources) && v.sources.length > 0, `${id} 출처 없음`);
    for (const s of v.sources) assert.match(s.url, /^https:\/\//, `${id} 출처 URL`);
    assert.ok(['dell', 'community'].includes(v.level), `${id} 확인 수준`);
  }
  assert.equal(C.ID_TABLE.PDR56, undefined);
  assert.equal(C.ID_TABLE.PDR8, undefined);
  // 사용자 결정: PDR54 · PDR59 · PDR57 을 센다 · 고장 예측(PDR16)과 빠짐(PDR5)은 세지 않는다.
  for (const id of ['PDR46', 'PDR47', 'PDR63', 'PDR64', 'PDR54', 'PDR59', 'PDR57']) assert.ok(C.COUNTED.has(C.classOf(id)), id);
  for (const id of ['PDR16', 'PDR5', 'VDR57']) assert.ok(!C.COUNTED.has(C.classOf(id)), id);
  assert.equal(C.classOf('PDR1016'), 'other');   // 표에 없는 PDR — 원문만 보관
  assert.equal(C.classOf('SYS1003'), null);      // 저장소 계열이 아님
  // 화면 표기: PDR54 · PDR59 · PDR57 은 ID 그대로(사용자 결정 2026-11-14)
  assert.equal(C.CLS_LABEL.corrected, 'PDR54'); assert.equal(C.CLS_LABEL.reassigned, 'PDR59'); assert.equal(C.CLS_LABEL.remapTable, 'PDR57');
});

test('slotOf: 백플레인 · 인클로저 · 연결자:인클로저:슬롯 · 못 읽으면 null(추측 금지)', () => {
  assert.deepEqual(C.slotOf('Patrol Read found an uncorrectable media error on Disk 5 in Backplane 1 of Integrated RAID Controller 1.'),
    { disk: 5, bp: 1, ctrl: 'Integrated RAID Controller 1' });
  assert.deepEqual(C.slotOf('Solid State Disk 2 in Enclosure 0 of RAID Controller in Slot 3 was corrected'), { disk: 2, bp: 0, ctrl: 'RAID Controller in Slot 3' });
  assert.deepEqual(C.slotOf('Predictive failure reported for Physical Disk 0:1:7 Controller 0'), { disk: 7, bp: 1, ctrl: '' });
  assert.equal(C.slotOf('The controller battery is degraded.'), null);
  assert.equal(C.slotKeyOf(C.slotOf('Disk 5 in Backplane 1 of X')), 'bp1:d5');
  assert.equal(C.labelOfKey('bp1:d5'), 'Disk 5 · Backplane 1');
});

test('slotOf: 긴 외부 입력에도 선형(ReDoS 회귀 — 비율로)', () => {
  const time = (s) => { const t0 = process.hrtime.bigint(); for (let i = 0; i < 200; i += 1) C.slotOf(s); return Number(process.hrtime.bigint() - t0); };
  const small = time('Disk '.repeat(80));
  const big = time('Disk '.repeat(80_000));
  assert.ok(big < small * 50 + 5e7, `긴 입력이 비선형(${big} vs ${small})`);
});

test('matchDrive: 디스크 번호 + 백플레인 · 후보가 둘이면 고르지 않는다', () => {
  const drives = [{ id: 'Disk.Bay.5:Enclosure.Internal.0-1:RAID.Integrated.1-1', serial: 'A' }, { name: 'Solid State Disk 0:2:5', serial: 'B' }];
  assert.equal(C.matchDrive('bp1:d5', drives).serial, 'A');
  assert.equal(C.matchDrive('bp2:d5', drives).serial, 'B');
  assert.equal(C.matchDrive('bp?:d5', drives), null);   // 둘 다 맞는다 — 추측하지 않는다
  assert.equal(C.matchDrive('bp1:d9', drives), null);
});

// ── 로그 읽기 ────────────────────────────────────────────────────────────────
function fakeLog(entries, { order = 'desc', pageSize = 3, total = true } = {}) {
  const sorted = [...entries].sort((a, b) => (order === 'desc' ? b.t - a.t : a.t - b.t));
  const calls = [];
  const getJson = async (_e, p) => {
    calls.push(p);
    if (p === '/redfish/v1/Managers') return { Members: [{ '@odata.id': '/redfish/v1/Managers/iDRAC.Embedded.1' }] };
    const skip = Number(/\$skip=(\d+)/.exec(p)?.[1] || 0);
    const page = sorted.slice(skip, skip + pageSize).map((e) => ({ Id: String(e.id), Created: new Date(e.t).toISOString(), MessageId: `IDRAC.2.9.${e.code}`, Severity: 'Warning', Message: e.msg || `Disk 3 in Backplane 1 of RAID Controller 1 ${e.code}` }));
    return { Members: page, ...(total ? { 'Members@odata.count': sorted.length } : {}) };
  };
  return { getJson, calls };
}
const E = (id, hoursAgo, code) => ({ id, t: NOW - hoursAgo * HOUR, code });

test('readLclog: 최신 먼저 — 처음은 전량 · PDR/VDR 만 남긴다', async () => {
  const f = fakeLog([E(1, 50, 'SYS1003'), E(2, 40, 'PDR46'), E(3, 30, 'USR0030'), E(4, 20, 'VDR57'), E(5, 10, 'PDR54'), E(6, 5, 'LOG007')]);
  const r = await L.readLclog({ host: 'h' }, { getJson: f.getJson, now: () => NOW });
  assert.equal(r.order, 'desc'); assert.equal(r.reachedEnd, true); assert.equal(r.read, 6);
  assert.deepEqual(r.entries.map((e) => e.code), ['PDR54', 'VDR57', 'PDR46']);
  assert.equal(r.newest.entryId, '6'); assert.equal(r.oldestRead, NOW - 50 * HOUR);
});

test('readLclog: 지난번 자리(cursor)에서 멈춘다 — 새 로그만', async () => {
  const f = fakeLog([E(1, 50, 'PDR46'), E(2, 40, 'PDR46'), E(3, 30, 'PDR54'), E(4, 20, 'PDR54'), E(5, 10, 'PDR46'), E(6, 5, 'PDR59')]);
  const r = await L.readLclog({ host: 'h' }, { cursor: { entryId: '4', created: NOW - 20 * HOUR }, getJson: f.getJson, now: () => NOW });
  assert.equal(r.foundCursor, true); assert.equal(r.cursorUsed, true);
  assert.deepEqual(r.entries.map((e) => e.entryId), ['6', '5']);
  assert.ok(!f.calls.some((p) => /\$skip=6/.test(p)), '자리를 찾은 뒤에도 더 읽었다');
});

test('readLclog: 오래된 것 먼저(건수 앎) — 끝쪽부터 거꾸로 · cursor 사용', async () => {
  const f = fakeLog([E(1, 50, 'PDR46'), E(2, 40, 'PDR46'), E(3, 30, 'PDR54'), E(4, 20, 'PDR54'), E(5, 10, 'PDR46')], { order: 'asc', pageSize: 2 });
  const r = await L.readLclog({ host: 'h' }, { cursor: { entryId: '3', created: NOW - 30 * HOUR }, getJson: f.getJson, now: () => NOW });
  assert.equal(r.order, 'asc'); assert.equal(r.foundCursor, true);
  assert.deepEqual(r.entries.map((e) => e.entryId), ['5', '4']);
});

test('readLclog: 방향을 모르면 cursor 를 쓰지 않는다(거짓 이어 읽기 금지)', async () => {
  const f = fakeLog([E(1, 50, 'PDR46'), E(2, 50, 'PDR54')], { order: 'asc', total: false });
  const r = await L.readLclog({ host: 'h' }, { cursor: { entryId: '9', created: NOW - 100 * HOUR }, getJson: f.getJson, now: () => NOW });
  assert.equal(r.order, 'unknown'); assert.equal(r.cursorUsed, false); assert.equal(r.foundCursor, false); assert.equal(r.reachedEnd, true);
});

test('readLclog: 예산을 넘으면 쪽 사이에서 멈추고 일부만 읽음으로 돌려준다', async () => {
  const f = fakeLog(Array.from({ length: 30 }, (_, i) => E(i + 1, 60 - i, 'PDR54')));
  let clock = NOW;
  const r = await L.readLclog({ host: 'h' }, { getJson: async (...a) => { clock += 10_000; return f.getJson(...a); }, budgetMs: 25_000, now: () => clock });
  assert.equal(r.reachedEnd, false); assert.equal(r.stopped, 'budget'); assert.ok(r.read > 0 && r.read < 30);
});

// ── 판정 ──────────────────────────────────────────────────────────────────────
const rec = (hoursAgo, code, slotKey = 'bp1:d3') => ({ created: NOW - hoursAgo * HOUR, code, cls: C.classOf(code), slotKey });
const drive3 = { id: 'Disk.Bay.3:Enclosure.Internal.0-1:RAID.Integrated.1-1', serial: 'S-NEW', model: 'M1' };

test('judgeSlot: 기록 시각에 같은 시리얼을 봤으면 아직 사용 중 · 확정', () => {
  const v = V.judgeSlot({ slotKey: 'bp1:d3', records: [rec(10, 'PDR46')], drive: drive3, serials: [{ serial: 'S-NEW', firstSeen: NOW - 100 * HOUR, lastSeen: NOW }], continuousSince: null });
  assert.equal(v.verdict, 'inUse'); assert.equal(v.confidence, 'confirmed'); assert.ok(v.evidence.length >= 2);
});

test('judgeSlot: 기록 당시 다른 시리얼 → 교체됨 · 확정', () => {
  const v = V.judgeSlot({ slotKey: 'bp1:d3', records: [rec(100, 'PDR46')], drive: drive3,
    serials: [{ serial: 'S-OLD', firstSeen: NOW - 200 * HOUR, lastSeen: NOW - 50 * HOUR }, { serial: 'S-NEW', firstSeen: NOW - 40 * HOUR, lastSeen: NOW }] });
  assert.equal(v.verdict, 'replaced'); assert.equal(v.confidence, 'confirmed');
});

test('judgeSlot: 시리얼 이력 없음 + 끊김 없이 봄 + 빠짐 없음 → 사용 중 · 추정 / 빠짐 있으면 판단 불가', () => {
  const a = V.judgeSlot({ slotKey: 'bp1:d3', records: [rec(10, 'PDR54')], drive: drive3, serials: [], continuousSince: NOW - 500 * HOUR });
  assert.equal(a.verdict, 'inUse'); assert.equal(a.confidence, 'estimated');
  const b = V.judgeSlot({ slotKey: 'bp1:d3', records: [rec(10, 'PDR54'), rec(5, 'PDR5')], drive: drive3, serials: [], continuousSince: NOW - 500 * HOUR });
  assert.equal(b.verdict, 'unknown'); assert.equal(b.confidence, 'none');
});

test('judgeSlot: 기록 뒤 구간을 끊김 없이 못 봤으면 판단 불가(사용 중으로 미루지 않는다)', () => {
  const v = V.judgeSlot({ slotKey: 'bp1:d3', records: [rec(1000, 'PDR46')], drive: drive3, serials: [], continuousSince: NOW - 100 * HOUR });
  assert.equal(v.verdict, 'unknown'); assert.equal(v.confidence, 'none');
});

test('judgeSlot: 디스크 목록을 못 읽었으면 판단하지 않는다', () => {
  const v = V.judgeSlot({ slotKey: 'bp1:d3', records: [rec(10, 'PDR46')], drive: null, driveKnown: false });
  assert.equal(v.verdict, 'unknown'); assert.equal(v.confidence, 'none');
});

test('judgeServer: 고장 예측만 있는 자리는 배드 섹터 수에 넣지 않는다 · 못 읽은 서버는 unread', () => {
  const j = V.judgeServer({ records: [rec(10, 'PDR16')], drives: [drive3], serialRows: [], coverage: { lastOkAt: NOW, continuousSince: NOW - 999 * HOUR, complete: true } });
  assert.equal(j.counts.slots, 0); assert.equal(j.counts.predictive, 1); assert.equal(j.status, 'clean');
  assert.equal(V.judgeServer({ records: [], drives: null, coverage: null }).status, 'unread');
  const hba = V.judgeServer({ records: [], drives: [{ ...drive3, inVolume: false }], coverage: { lastOkAt: NOW, complete: true } });
  assert.equal(hba.status, 'unwatched');   // RAID 로 묶이지 않은 디스크만 — '기록 없음' 이 아니다
});

// ── 끊김 없이 본 구간 ────────────────────────────────────────────────────────
test('nextContinuousSince: 자리를 찾으면 그대로 · 못 찾거나 도중에 멈추면 이번에 읽은 가장 오래된 시각', () => {
  assert.equal(D.nextContinuousSince(100, { cursorUsed: true, foundCursor: true, oldestRead: 500 }), 100);
  assert.equal(D.nextContinuousSince(null, { cursorUsed: true, foundCursor: true, oldestRead: 500 }), 500);
  assert.equal(D.nextContinuousSince(100, { cursorUsed: true, foundCursor: false, reachedEnd: true, oldestRead: 700 }), 700);
  assert.equal(D.nextContinuousSince(100, { cursorUsed: false, reachedEnd: false, oldestRead: 900 }), 900);
});

// ── 정제 ──────────────────────────────────────────────────────────────────────
test('cleanPush: 모르는 필드는 버리고 · 상한 · 미래 시각 자름 · 프로토콜 확인 · 자격증명 같은 필드는 남지 않는다', () => {
  assert.equal(I.cleanPush({ v: 99 }).ok, false);
  const p = I.cleanPush({
    v: 1, jobId: 'j', final: true, total: '3', password: 'x', servers: [
      { id: 's1', ok: true, username: 'root', password: 'calvin', evil: { a: 1 }, log: { order: 'desc', total: '120', oldestRead: NOW - DAY, newestCreated: NOW + 365 * DAY, reachedEnd: true },
        records: [{ entryId: '1', created: NOW - HOUR, messageId: 'IDRAC.2.9.PDR46', message: 'm'.repeat(5000), x: 1 }, { created: 'bad' }],
        drives: [{ id: 'Disk.Bay.1', serial: 'S', model: 'M', capacityGB: '480', secret: 'y' }] },
      { ok: true },
      'string',
    ],
  }, { now: NOW });
  assert.equal(p.ok, true); assert.equal(p.total, 3); assert.equal(p.servers.length, 1);
  const s = p.servers[0];
  assert.equal(JSON.stringify(s).includes('calvin'), false); assert.equal('username' in s, false); assert.equal('evil' in s, false);
  assert.equal(s.log.total, 120); assert.equal(s.log.newestCreated, NOW + 300_000);
  assert.equal(s.records.length, 1); assert.equal(s.records[0].message.length, 300);
  assert.equal(s.drives[0].capacityGB, 480); assert.equal('secret' in s.drives[0], false);
  assert.equal(I.cleanServer({ id: 'z', ok: false, reason: 'rm -rf' }, NOW).reason, 'error');   // 모르는 사유 코드는 일반 실패로
});

// ── DB 적재 ───────────────────────────────────────────────────────────────────
const serverResult = (id, recs, { drives = [drive3], log = {} } = {}) => ({
  id, name: id, host: '10.0.0.1', serviceTag: 'TAG', ok: true, reason: '', invAt: NOW - HOUR, drives,
  log: { order: 'desc', total: 100, read: 100, oldestRead: NOW - 900 * HOUR, reachedEnd: true, foundCursor: false, cursorUsed: false, ...log },
  records: recs.map((r, i) => ({ entryId: String(r.id ?? i), created: NOW - r.h * HOUR, messageId: `IDRAC.2.9.${r.code}`, severity: 'Warning', message: `media error on Disk 3 in Backplane 1 of RAID Controller 1 ${r.code}` })),
});

test('ingestServers: 첫 점검은 기준선(메일 대상 아님) · 다음 점검의 새 기록만 newRecords · 중복은 거른다', async () => {
  const r1 = await D.ingestServers('EdgeA', [serverResult('srv1', [{ id: 1, h: 100, code: 'PDR46' }])], { now: NOW });
  assert.equal(r1.ok, true); assert.equal(r1.baselineServers, 1); assert.equal(r1.newRecords.length, 0);
  const r2 = await D.ingestServers('edgea', [serverResult('srv1', [{ id: 1, h: 100, code: 'PDR46' }, { id: 2, h: 1, code: 'PDR54' }], { log: { cursorUsed: true, foundCursor: true, reachedEnd: false, oldestRead: NOW - 2 * HOUR } })], { now: NOW + HOUR });
  assert.equal(r2.newRecords.length, 1); assert.equal(r2.newRecords[0].code, 'PDR54'); assert.equal(r2.newRecords[0].slotKey, 'bp1:d3');
  const d = await D.loadServer('EDGEA', 'srv1');
  assert.equal(d.records.length, 2);
  assert.equal(d.server.continuousSince, NOW - 900 * HOUR);   // 자리를 찾은 이어 읽기 — 끊김 없이 본 구간 유지
  assert.equal(d.serials.length, 1); assert.equal(d.serials[0].serial, 'S-NEW');
  const v = S.serverView(d.server, d.records, d.serials);
  assert.equal(v.status, 'records'); assert.equal(v.slots[0].verdict, 'inUse');
});

test('ingestServers: 실패한 점검은 지난 디스크 목록 · 구간을 지우지 않는다', async () => {
  await D.ingestServers('edgea', [{ id: 'srv1', ok: false, reason: 'timeout', reasonText: 't', drives: null }], { now: NOW + 2 * HOUR });
  const d = await D.loadServer('edgea', 'srv1');
  assert.equal(d.server.lastStatus, 'timeout'); assert.ok(Array.isArray(d.server.drives)); assert.equal(d.server.continuousSince, NOW - 900 * HOUR);
});

// ── 작업 ──────────────────────────────────────────────────────────────────────
test('작업: 엣지 조각 claim → 그 엣지 보고만 저장 · 다른 엣지 보고는 거절 · 진행 중인 엣지는 busy', async () => {
  J._resetJobsForTest();
  const job = J.createJob({ scope: 'corp', target: 'vc1', mode: 'incremental', units: [{ agent: 'EdgeB', kind: 'edge', serverIds: ['x1'] }] });
  assert.equal(job.units[0].state, 'queued');
  const second = J.createJob({ scope: 'all', units: [{ agent: 'edgeb', kind: 'edge', serverIds: null }] });
  assert.equal(second.units[0].state, 'busy');
  assert.equal(J.claimForAgent('other'), null);
  const c = J.claimForAgent('edgeb');
  assert.equal(c.id, job.id);
  const push = I.cleanPush({ v: 1, jobId: job.id, final: true, total: 1, done: 1, servers: [serverResult('x1', [])] }, { now: NOW });
  const wrong = await J.acceptPush('edgec', push);
  assert.equal(wrong.stored, false);
  const ok = await J.acceptPush('EDGEB', push);
  assert.equal(ok.stored, true);
  assert.equal(J.getJob(job.id).units[0].state, 'done');
  assert.equal((await J.acceptPush('edgeb', push)).stored, false);   // 닫힌 작업의 보고는 받지 않는다
});

test('작업: 가져가지 않으면 15분 뒤 시작 못 함 · 진행 보고가 끊기면 45분 뒤 응답 없음', () => {
  J._resetJobsForTest();
  const a = J.createJob({ scope: 'corp', units: [{ agent: 'e1', kind: 'edge', serverIds: ['a'] }] });
  J.sweepJobs(Date.now() + J.CLAIM_TIMEOUT_MS + 1000);
  assert.equal(J.getJob(a.id).units[0].state, 'not-started');
  J._resetJobsForTest();
  J.createJob({ scope: 'corp', units: [{ agent: 'e2', kind: 'edge', serverIds: ['a'] }] });
  const c = J.claimForAgent('e2');
  J.sweepJobs(Date.now() + J.STALL_TIMEOUT_MS + 1000);
  assert.equal(J.getJob(c.id).units[0].state, 'no-response');
});

// ── 메일 ──────────────────────────────────────────────────────────────────────
test('메일: 법인별 한 통 · 세는 분류만 · HTML 이스케이프', () => {
  const recs = [
    { agent: 'a', serverId: 's1', serverName: '<b>x</b>', created: NOW, code: 'PDR54', slotKey: 'bp1:d3', message: '' },
    { agent: 'a', serverId: 's1', created: NOW, code: 'PDR16', slotKey: 'bp1:d3', message: '' },
    { agent: 'b', serverId: 's2', created: NOW, code: 'PDR46', slotKey: '', message: '' },
  ];
  const g = N.groupByCorp(recs, (agent) => ({ id: agent === 'a' ? 'vc1' : 'vc2', name: agent === 'a' ? 'KR' : 'PL' }));
  assert.equal(g.length, 2);
  assert.equal(g.find((x) => x.corp.id === 'vc1').records.length, 1);   // 고장 예측은 메일에 넣지 않는다
  const m = N.buildMail({ id: 'vc1', name: 'KR' }, g.find((x) => x.corp.id === 'vc1').records);
  assert.ok(!m.html.includes('<b>x</b>')); assert.ok(m.html.includes('&lt;b&gt;'));
  assert.match(m.subject, /새 기록 1건/);
});

// ── 집계 ──────────────────────────────────────────────────────────────────────
test('buildFleet: 못 읽은 서버의 디스크는 분모에서 뺀다 · HPE 는 제외 · 모델은 지금 꽂힌 디스크만', async () => {
  const db = await D.loadAll();
  const f = S.buildFleet({
    servers: [
      { agent: 'edgea', id: 'srv1', name: 'srv1', corp: { id: 'vc1', name: 'KR', country: '한국' } },
      { agent: 'edgea', id: 'never', name: 'never', corp: { id: 'vc1', name: 'KR', country: '한국' } },
      { agent: '', id: 'hpe1', name: 'hpe1', corp: { id: 'vc1', name: 'KR' }, excluded: true },
    ], db, now: NOW,
  });
  assert.equal(f.totals.servers, 2); assert.equal(f.totals.read, 1); assert.equal(f.totals.unread, 1); assert.equal(f.totals.excluded, 1);
  assert.equal(f.totals.disks, 1); assert.equal(f.totals.recordSlots, 1); assert.equal(f.totals.ratePer1000, 1000);
  assert.equal(f.byModel[0].model, 'M1'); assert.equal(f.byModel[0].recordDisks, 1);
  assert.equal(f.months.length, 18); assert.ok(f.months.every((m) => 'coveragePct' in m));
  assert.equal(f.inUse.length, 1);
});

test('설정: 기본은 자동 점검 꺼짐 · 6시간 · 메일 켬 · 잘못된 메일 주소는 버린다', () => {
  ST._resetDiskBadSettingsForTest();
  const s = ST.loadDiskBadSettings();
  assert.equal(s.autoEnabled, false); assert.equal(s.intervalHours, 6); assert.equal(s.mailEnabled, true);
  const n = ST.normalizeSettings({ intervalHours: 9999, corpTo: { vc1: 'a@b.com, bad, c@d.org', '': ['x@y.z'] } });
  assert.equal(n.intervalHours, 168); assert.deepEqual(n.corpTo, { vc1: ['a@b.com', 'c@d.org'] });
});

// ── 배선 · 규약 스윕 ──────────────────────────────────────────────────────────
test('배선: 중앙 수신 2개 · BIG_JSON · 엣지 상태 표 · DB 이전 목록 · 기동 · 메일 종류 · 라우트 등록', async () => {
  const central = code('routes/central.js');
  assert.match(central, /centralRouter\.get\('\/disk-bad-job', requireCentral\(\)/);
  assert.match(central, /centralRouter\.post\('\/disk-bad', requireCentral\(\)/);
  assert.match(code('index.js'), /app\.use\('\/api\/central\/disk-bad', BIG_JSON\)/);
  assert.match(code('index.js'), /startDiskBadJobs, startDiskBadEdge/);
  assert.match(code('edgelog/spec.js'), /diskBadEdgeStatus/);
  const { MIGRATABLE } = await import('../src/insights/dbLocation.js');
  assert.ok(MIGRATABLE.some((m) => m.file === 'disk-bad.db'));
  const { isKind } = await import('../src/mail/kinds.js');
  assert.equal(isKind('disk-bad'), true);
  assert.match(code('routes/api.js'), /registerDiskBad\(api\)/);
});

test('범위: 라우트는 관리자 판정 공용 함수 · 조회 범위 판정 한 벌(idracScopeOf) · 점검은 쓰기 범위 · 설정은 전체 범위', () => {
  const r = code('routes/api/diskBad.js');
  assert.doesNotMatch(r, /role\s*===\s*'admin'/);
  assert.match(r, /isAdminDetailUser\(req\.user\)/);
  assert.match(r, /idracScopeOf\(req\)/);
  assert.match(r, /inUserWriteScope\(req\.user, snap, target\)/);
  assert.match(r, /api\.put\('\/tools\/disk-bad\/settings', adminOnly, fullScopeOnly/);
  assert.match(r, /api\.post\('\/tools\/disk-bad\/scan', writeRole, toolsPerm/);
  // 서버 단건은 범위 밖 404(존재 은닉)
  assert.match(r, /if \(!s\) return res\.status\(404\)\.json\(NOT_FOUND\)/);
});

test('로그 읽기: $filter 를 쓰지 않는다(실장비 미확인 — 보수적) · 결과에 자격증명을 싣지 않는다', () => {
  assert.doesNotMatch(code('diskbad/lclog.js'), /\$filter/);
  const scan = code('diskbad/scan.js');
  assert.doesNotMatch(scan, /password:\s*s\.password|username:\s*s\.username/);
});
