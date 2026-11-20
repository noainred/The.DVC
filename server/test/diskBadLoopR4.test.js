/**
 * 디스크 배드 섹터 — 개선 · 버그 수정 반복 4회차(반증 1인 — F1 ~ F10 · I1 ~ I5 · 변이 M1 ~ M6).
 * 고정하는 것(동작으로 — 3회차 라우트 계약 시험은 글자만 봐 변이 6개가 통과했다):
 *  F4 정상 행이 이미 있어도 옛 노드 이력을 합침 · M1 · M2 옮기기 판정 · I1 중단한 조각은 다시 내주지 않음 · I5 저장 못 한 수는 서버 단위 ·
 *  I2 · M3 기록 줄이기는 분류마다(드문 분류가 밀리지 않음) · M4 월 끝은 포탈 시각 · M5 '점검 중' 판정 · M6 응답 다듬기 · F8 저장 보고 사유.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'diskbadloopr4-'));
process.env.CONFIG_DIR = TMP;
process.env.DISKBAD_DB_PATH = path.join(TMP, 'disk-bad.db');
process.env.AUTH_ENABLED = 'false';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

const D = await import('../src/diskbad/db.js');
const J = await import('../src/diskbad/jobs.js');
const S = await import('../src/diskbad/summary.js');
const SC = await import('../src/diskbad/scan.js');
const ST = await import('../src/diskbad/settings.js');
const R = await import('../src/routes/api/diskBad.js');
const { portalParts, portalMs } = await import('../src/util/dayKey.js');

after(() => { try { D._resetDiskBadDbForTest(); } catch { /* */ } try { J._resetJobsForTest(); } catch { /* */ } fs.rmSync(TMP, { recursive: true, force: true }); });

const MSG = 'A disk media error on Disk 2 in Backplane 1 of Integrated RAID Controller 1 was corrected during recovery.';
const srv = (id, records, invAt = NOW, serial = 'SN-2') => ({ id, name: id, serviceTag: 'ST-R4', ok: true, reason: '', records,
  log: { order: 'desc', total: 10, read: 10, undated: 0, newestId: '9', newestCreated: NOW - DAY, oldestRead: NOW - 60 * DAY, reachedEnd: true, foundCursor: false, cursorUsed: false, stopped: '' },
  drives: [{ id: 'Disk.Bay.2:Enclosure.Internal.0-1:RAID.Integrated.1-1', name: 'Physical Disk 0:1:2', serial, model: 'M' }], invAt });
const rec = (entryId, created) => ({ entryId, created, createdRaw: created, messageId: 'IDRAC.2.9.PDR54', severity: 'OK', message: MSG, code: 'PDR54' });

test('F4 — 이 노드에 이미 정상 행이 있어도, 옮길 수 있게 되면 옛 노드 이력을 합친다(옛 행은 지움)', async () => {
  // 중앙 직결로 오래 읽은 서버(기록 2 · 시리얼 1).
  await D.ingestServers('', [srv('10.7.7.7', [rec('1', NOW - 50 * DAY), rec('2', NOW - 45 * DAY)], NOW - 50 * DAY)], { now: NOW - 50 * DAY });
  // 엣지가 한 번 정상으로 읽음 — 이때는 중앙 등록부에 아직 있어 옮기지 않는다(엣지 행이 따로 생김 · 겹치는 기록 1 + 새 기록 1).
  await D.ingestServers('edge-r4', [srv('10.7.7.7', [rec('2', NOW - 45 * DAY), rec('3', NOW - 2 * DAY)], NOW - DAY)], { now: NOW - DAY, canMoveFrom: () => false });
  assert.equal((await D.loadServer('', '10.7.7.7')).records.length, 2);
  const before = await D.loadServer('edge-r4', '10.7.7.7');
  assert.ok(Number.isFinite(before.server.firstOkAt));
  // 중앙 등록부에서 지운 뒤 — 이제 옮길 수 있다. 예전에는 엣지 행이 정상이라 영영 옮기지 않았다.
  await D.ingestServers('edge-r4', [srv('10.7.7.7', [])], { now: NOW, canMoveFrom: (from) => from === '' });
  const e = await D.loadServer('edge-r4', '10.7.7.7');
  assert.deepEqual(e.records.map((r) => r.created).sort((a, b) => a - b), [NOW - 50 * DAY, NOW - 45 * DAY, NOW - 2 * DAY], '옛 기록이 합쳐지고 겹친 것은 하나');
  assert.equal(e.serials.length, 1);
  assert.equal(e.serials[0].firstSeen <= NOW - 50 * DAY, true, '시리얼 처음 본 때는 더 이른 쪽');
  assert.equal(e.server.firstOkAt <= NOW - 50 * DAY, true, '처음 본 때도 더 이른 쪽');
  const old = await D.loadServer('', '10.7.7.7');
  assert.equal(old.server, null, '옛 노드 행은 지운다');
  assert.equal(old.records.length, 0);
  // 다시 보고해도 오가지 않는다(옛 행이 없다).
  await D.ingestServers('edge-r4', [srv('10.7.7.7', [])], { now: NOW + HOUR, canMoveFrom: () => true });
  assert.equal((await D.loadServer('edge-r4', '10.7.7.7')).records.length, 3);
});

test('M1 · M2 — 옮기기 판정: 중앙 직결(\'\')에서만 · 중앙 등록부에 없을 때만 · 등록부를 못 읽으면 옮기지 않음', () => {
  const can = J.makeCanMoveFrom(new Set(['still-here']));
  assert.equal(can('', 'gone'), true);
  assert.equal(can('', 'still-here'), false, '중앙 등록부에 남아 있으면 옮기지 않는다(M2)');
  assert.equal(can('edge-b', 'gone'), false, '엣지끼리는 옮기지 않는다(M1)');
  assert.equal(J.makeCanMoveFrom(null)('', 'gone'), false, '등록부를 못 읽었으면 옮기지 않는다');
});

test('I1 — 보고가 없는 조각이라도 사용자가 중단했으면 다시 내주지 않고 중단됨으로 닫는다', () => {
  J._resetJobsForTest();
  const job = J.createJob({ scope: 'all', units: [{ agent: 'edge-s', kind: 'edge', serverIds: null }] });
  assert.equal(J.claimForAgent('edge-s')?.id, job.id);
  J.stopJob(job.id);
  assert.equal(J.getJob(job.id).units[0].stop, true);
  assert.equal(J.claimForAgent('edge-s'), null, '중단한 조각을 다시 내주지 않는다');
  assert.equal(J.getJob(job.id).units[0].state, 'stopped');
});

test('I5 — 저장 못 한 묶음 가운데 저장된 서버는 \'저장 못 함\' 으로 세지 않는다(scanServers)', async () => {
  const servers = ['a', 'b', 'c'].map((id) => ({ id, name: id, host: id, excluded: false }));
  const deps = { mock: true, invOf: () => null, authStoppedByPoller: () => false };   // 데모 읽기 — 장비에 닿지 않는다
  const stat = await SC.scanServers(servers, { mode: 'full', deps,
    onChunk: async (batch) => ({ stored: false, storedIds: batch.filter((x) => x.id === 'a').map((x) => x.id) }) });
  assert.equal(stat.done, 3);
  assert.equal(stat.unsaved, 2, '저장된 서버 하나는 빼고 센다');
  const stat2 = await SC.scanServers(servers, { mode: 'full', deps, onChunk: async () => false });
  assert.equal(stat2.unsaved, 3, 'false 면 묶음 전체');
  const stat3 = await SC.scanServers(servers, { mode: 'full', deps, onChunk: async () => true });
  assert.equal(stat3.unsaved, 0);
});

test('I2 · M3 — 기록 줄이기는 분류마다 가장 새 것: 흔한 분류가 많아도 고장 예측 · 빠짐 · 복구 불가는 남는다', () => {
  const recs = [];
  for (let i = 0; i < 3_000; i += 1) recs.push({ created: NOW - i * 60_000, cls: 'corrected', code: 'PDR54' });
  recs.push({ created: NOW - 400 * DAY, cls: 'predictive', code: 'PDR16' });
  recs.push({ created: NOW - 300 * DAY, cls: 'removed', code: 'PDR5' });
  recs.push({ created: NOW - 200 * DAY, cls: 'unrecoverable', code: 'PDR46' });
  for (let i = 0; i < 500; i += 1) recs.push({ created: NOW - i * 1_000, cls: 'other', code: 'PDR99' });
  const t = S.trimRecordsForView(recs);
  const by = (c) => t.records.filter((r) => r.cls === c).length;
  assert.equal(by('corrected'), S.CLASS_RECORDS_VIEW_MAX, '세는 분류도 상한이 있다');
  assert.equal(by('predictive'), 1);
  assert.equal(by('removed'), 1);
  assert.equal(by('unrecoverable'), 1);
  assert.equal(by('other'), S.OTHER_RECORDS_VIEW_MAX);
  assert.equal(t.total, recs.length);
  assert.equal(t.trimmed, recs.length - t.records.length);
  assert.equal(t.records.filter((r) => r.cls === 'corrected').every((r) => r.created > NOW - 3_000 * 60_000), true, '가장 새 것');
});

test('M4 — 월 끝은 포탈 시각: 이번 달 1일 01:00(포탈 시각)부터 본 서버는 지난달을 본 것이 아니다', () => {
  const p = portalParts(NOW);
  const since = portalMs(p.y, p.mo, 1, 1);
  const rows = [{ agent: '', serverId: 'm4', name: 'm4', lastStatus: 'ok', lastOkAt: NOW, continuousSince: since, drives: [] }];
  const f = S.buildFleet({ servers: [{ agent: '', id: 'm4', name: 'm4', corp: null }], db: { servers: rows, records: [], serials: [] }, now: Math.max(NOW, since + HOUR) });
  const prev = f.months[f.months.length - 2];
  assert.equal(prev.coveragePct, 0, `지난달(${prev.month}) 말에는 보지 않았다`);
});

test('M5 — 점검 중 판정: 같은 노드 · 이 서버를 읽는 조각만 running, 노드의 진행 조각은 nodeBusy', () => {
  const s = { agent: 'e1', id: '10.0.0.1' };
  const st = (state, agent, serverIds) => ({ state, agent, serverIds });
  assert.deepEqual(R.serverRunState([st('running', 'e1', null)], s), { running: true, nodeBusy: true }, '그 노드 전체 조각');
  assert.deepEqual(R.serverRunState([st('running', 'e2', null)], s), { running: false, nodeBusy: false }, '다른 노드의 전체 조각');
  assert.deepEqual(R.serverRunState([st('queued', 'e1', ['10.0.0.9'])], s), { running: false, nodeBusy: true }, '같은 노드의 다른 서버 조각');
  assert.deepEqual(R.serverRunState([st('queued', 'e1', ['10.0.0.1'])], s), { running: true, nodeBusy: true }, '이 서버를 읽는 조각');
  assert.deepEqual(R.serverRunState([st('done', 'e1', null)], s), { running: false, nodeBusy: false }, '끝난 조각');
});

test('M6 — 서버 창 응답 다듬기: 기록을 줄이고 전체 수를 밝힘 · 디스크 값 이름은 관리자 판본에만', () => {
  const records = Array.from({ length: 800 }, (_, i) => ({ created: NOW - i * 1_000, cls: 'other', code: 'PDR99' }));
  const v = { records, coverage: { vals: { status: 'ok', seen: ['ReallocatedBlockCount'] } } };
  const u = R.shapeServerView(v, { admin: false });
  assert.equal(u.records.length, S.OTHER_RECORDS_VIEW_MAX);
  assert.equal(u.recordsTotal, 800);
  assert.equal(u.recordsTrimmed, 800 - S.OTHER_RECORDS_VIEW_MAX);
  assert.deepEqual(u.coverage.vals.seen, []);
  assert.deepEqual(v.coverage.vals.seen, ['ReallocatedBlockCount'], '원본을 바꾸지 않는다');
  assert.deepEqual(R.shapeServerView(v, { admin: true }).coverage.vals.seen, ['ReallocatedBlockCount']);
});

test('F8 — 담당자 저장 보고는 빠진 이유를 나눠 센다(형식 · 중복 · 주소 상한 · 법인 상한) · 이름 키 합치기의 문자열 값', () => {
  const many = Array.from({ length: ST.CORP_TO_MAX + 2 }, (_, i) => `u${i}@x.com`);
  const sent = { 'vc-a': [...many, 'u0@x.com', 'not-an-email'], 'vc-b': ['bad'] };
  for (let i = 0; i < ST.CORP_MAX; i += 1) sent[`vc-z${i}`] = ['z@x.com'];
  const saved = ST.normalizeSettings({ corpTo: sent }).corpTo;
  const r = R.corpToReport(sent, saved, Object.keys(saved));
  assert.equal(r.droppedEmails, 2, '형식이 아닌 값만(bad · not-an-email)');
  assert.equal(r.dupEmails, 1);
  assert.equal(r.overEmails, 2);
  assert.deepEqual(r.droppedCorps, ['vc-b']);
  assert.equal(r.overCorpsTotal, 2, '법인 상한을 넘은 곳');
  assert.equal(r.toMax, ST.CORP_TO_MAX);
  assert.equal(r.corpMax, ST.CORP_MAX);
  assert.equal(Object.keys(saved).length, ST.CORP_MAX - 1, '정규화와 같은 자르기(vc-b 는 올바른 주소가 없어 빠짐)');
  // 이름 키 + id 키 합치기 — 문자열 값의 주소가 빠지지 않는다.
  const m = R.mapCorpKeys({ n1: 'a@x.com,b@x.com', 'vc-1': ['c@x.com'] }, [{ id: 'vc-1', name: 'n1' }]);
  assert.deepEqual(ST.normalizeSettings({ corpTo: m.corpTo }).corpTo['vc-1'], ['a@x.com', 'b@x.com', 'c@x.com']);
  assert.equal(Object.getPrototypeOf(R.mapCorpKeys({ ['__proto__']: ['a@x.com'] }, []).corpTo), Object.prototype, '키로 원형을 바꾸지 않는다');
});

// ── 5회차 반증이 찾은 이 회차(F4)의 결함 — 4회차를 내기 전에 고쳤다 ──────────────────────────────
const I = await import('../src/diskbad/ingest.js');
const VID = 'Disk.Bay.2:Enclosure.Internal.0-1:RAID.Integrated.1-1';
const vals = (realloc) => ({ status: 'ok', telemetry: 'ok', metrics: '', reportAt: null, seen: [], drives: [{ id: VID, realloc, pending: 0, uncorrectable: 0, powerOnHours: 100, src: 'telemetry' }] });
const selOf = (events) => ({ status: 'ok', read: events.length, total: events.length, pages: 1, stopped: '', oldest: null, newest: null, kinds: {}, events });
const ev = (created, kind) => ({ created, createdRaw: created, kind, disk: 2, bp: 1, slotKey: 'bp1:d2', messageId: '', message: `Drive 2 is ${kind} in disk drive bay 1.`, severity: 'OK', sensor: 'Drive Slot / Bay' });

test('R5-1 — 합칠 때 옛 행의 SEL 보관 항목과 디스크 값 이력(처음 본 때 · 늘어난 때 · 늘기 전 값)을 잃지 않는다', async () => {
  const id = '10.8.8.8';
  await D.ingestServers('', [{ ...srv(id, [], NOW - 30 * DAY), vals: vals(1), sel: selOf([ev(NOW - 40 * DAY, 'removed')]) }], { now: NOW - 30 * DAY });
  await D.ingestServers('', [{ ...srv(id, [], NOW - 25 * DAY), vals: vals(3), sel: selOf([]) }], { now: NOW - 25 * DAY });
  const near = (x) => ({ ...x, log: { ...x.log, oldestRead: NOW - 3 * DAY } });   // 엣지는 최근 3일만 읽었다(N5 — 본 가장 오래된 때를 당기는지)
  await D.ingestServers('edge-m', [near({ ...srv(id, [], NOW - DAY), vals: vals(3), sel: selOf([ev(NOW - 2 * DAY, 'installed')]) })], { now: NOW - DAY, canMoveFrom: () => false });
  const old = await D.loadServer('', id);
  assert.equal(old.server.vals.drives[0].changedAt, NOW - 25 * DAY, '전제: 옛 행이 늘어난 때를 봤다');
  await D.ingestServers('edge-m', [near(srv(id, []))], { now: NOW, canMoveFrom: (from) => from === '' });
  const e = await D.loadServer('edge-m', id);
  assert.equal(e.server.coveredFrom, NOW - 60 * DAY, '본 가장 오래된 때는 옛 행 쪽으로 당긴다(N5)');
  assert.equal((await D.loadServer('', id)).server, null, '옛 행은 지운다');
  assert.deepEqual(e.server.sel.events.map((x) => x.kind).sort(), ['installed', 'removed'], 'SEL 보관 항목은 합집합');
  const d = e.server.vals.drives[0];
  assert.equal(d.firstAt, NOW - 30 * DAY, '처음 읽은 때는 더 이른 쪽');
  assert.equal(d.changedAt, NOW - 25 * DAY, '이 노드가 못 본 늘어남은 옛 노드가 본 때로');
  assert.equal(d.before?.realloc, 1);
  // 시리얼이 다르면(그 자리에 다른 디스크) 잇지 않는다.
  const k = D.mergeKeptVals({ drives: [{ id: VID, serial: 'NEW', firstAt: NOW, changedAt: null }] }, { drives: [{ id: VID, serial: 'OLD', firstAt: NOW - 9 * DAY, changedAt: NOW - 8 * DAY, before: { realloc: 1 } }] });
  assert.deepEqual(k.drives[0], { id: VID, serial: 'NEW', firstAt: NOW, changedAt: null });
});

test('R5-2 · N1 · N2 — acceptPush 의 옮기기: 중앙 등록부에 있으면 옮기지 않음 · 없으면 합침 · 등록부를 못 읽으면 옮기지 않음 · I-a 후보가 하나면', async () => {
  const REG = path.join(TMP, 'idrac.json');
  const reg = (ids) => fs.writeFileSync(REG, JSON.stringify({ servers: ids.map((x) => ({ id: x, host: x, name: x, username: 'root', password: 'x' })) }));
  const mk = (id, tag) => ({ id, name: id, serviceTag: tag, ok: true, reason: '', records: [], drives: [],
    log: { order: 'desc', total: 5, read: 5, undated: 0, newestId: '5', newestCreated: NOW - HOUR, oldestRead: NOW - 10 * DAY, reachedEnd: true, foundCursor: false, cursorUsed: false, stopped: '' } });
  const seed = async (id, tag, extra = []) => {
    await D.ingestServers('', [I.cleanServer(mk(id, tag), NOW - 20 * DAY)], { now: NOW - 20 * DAY });
    for (const ag of ['edge-q', ...extra]) await D.ingestServers(ag, [I.cleanServer(mk(id, tag), NOW - DAY)], { now: NOW - DAY });
  };
  const push = async (id, tag) => {
    J._resetJobsForTest();
    const job = J.createJob({ scope: 'all', units: [{ agent: 'edge-q', kind: 'edge', serverIds: null }] });
    assert.equal(J.claimForAgent('edge-q')?.id, job.id);
    const p = I.cleanPush({ v: 1, jobId: job.id, servers: [mk(id, tag)], final: true }, { now: NOW });
    assert.equal(p.ok, true);
    return J.acceptPush('edge-q', p);
  };
  await seed('10.5.5.1', 'T1'); await seed('10.5.5.2', 'T2'); await seed('10.5.5.3', 'T3'); await seed('10.5.5.4', 'T4', ['edge-other']);
  reg(['10.5.5.1', '10.5.5.3']);
  await push('10.5.5.1', 'T1');
  assert.ok((await D.loadServer('', '10.5.5.1')).server, '중앙 등록부에 있으면 옮기지 않는다(N1)');
  await push('10.5.5.2', 'T2');
  assert.equal((await D.loadServer('', '10.5.5.2')).server, null, '등록부에 없으면 합친다(N2)');
  assert.equal((await D.loadServer('edge-q', '10.5.5.2')).server.firstOkAt, NOW - 20 * DAY);
  await push('10.5.5.4', 'T4');
  assert.equal((await D.loadServer('', '10.5.5.4')).server, null, '다른 엣지 행이 함께 있어도 옮길 수 있는 후보가 하나면 합친다(I-a)');
  assert.ok((await D.loadServer('edge-other', '10.5.5.4')).server, '엣지끼리는 옮기지 않는다');
  fs.writeFileSync(REG, '{"servers": [ {"id": "10.5.5.3"');   // 손상 — loadRegistry 는 빈 목록을 준다
  await push('10.5.5.3', 'T3');
  assert.ok((await D.loadServer('', '10.5.5.3')).server, '등록부를 못 읽으면 옮기지 않는다(R5-2)');
});
