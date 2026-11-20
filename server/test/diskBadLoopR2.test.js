/**
 * 디스크 배드 섹터 — 개선 · 버그 수정 반복 2회차(반증 1인 — R2-1 ~ R2-7 · 개선 I-1 ~ I-6).
 * 고정하는 것: 데모 항목 시각 고정(점검마다 두 배가 되지 않음) · 메일 참조 · 노드가 바뀌어도 이력 유지 · 건수로 끝 판정 · 오류 멈춤은 'error' ·
 * 2000년 전 시각은 못 읽은 시각 · 503 재시도 · 가져오기 재시도 · 양보 · 고장 예측 문장 · 오래된 것 먼저 장비의 진단 · 413 분할.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'diskbadloopr2-'));
process.env.CONFIG_DIR = TMP;
process.env.DISKBAD_DB_PATH = path.join(TMP, 'disk-bad.db');
process.env.AUTH_ENABLED = 'false';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = (p) => stripComments(fs.readFileSync(path.join(ROOT, 'src', p), 'utf8'));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

const M = await import('../src/diskbad/mock.js');
const I = await import('../src/diskbad/ingest.js');
const D = await import('../src/diskbad/db.js');
const L = await import('../src/diskbad/lclog.js');
const SEL = await import('../src/diskbad/sel.js');
const E = await import('../src/diskbad/edge.js');

after(() => { try { D._resetDiskBadDbForTest(); } catch { /* */ } fs.rmSync(TMP, { recursive: true, force: true }); });

const MGR = '/redfish/v1/Managers/iDRAC.Embedded.1';
const mgrs = { Members: [{ '@odata.id': MGR }] };
const skipOf = (p) => { const m = /\$skip=(\d+)/.exec(p); return m ? Number(m[1]) : 0; };

test('R2-1 — 데모 점검을 다른 시각에 두 번 해도 기록 · SEL 항목이 두 배가 되지 않고 새 기록도 없다', async () => {
  const drives = [0, 1, 2, 3, 4, 5].map((i) => ({ id: `Disk.Bay.${i}:Enclosure.Internal.0-1:RAID.Integrated.1-1`, name: `Physical Disk 0:1:${i}`, model: 'M', serial: `SN${i}` }));
  const ids = Array.from({ length: 60 }, (_, i) => `demo-${i}`);
  const scan = (now) => ids.map((id) => M.mockScanServer({ id, name: id, host: id, drives, invAt: now, mode: 'full', cursor: null, now }));
  const ing = async (now) => D.ingestServers('', scan(now).map((x) => I.cleanServer(x, now)).filter(Boolean), { now });
  await ing(NOW);
  const a = await D.loadAll();
  const recs1 = a.records.length;
  const sel1 = a.servers.reduce((n, s) => n + (s.sel?.events?.length || 0), 0);
  assert.ok(recs1 > 0 && sel1 > 0, '데모가 기록 · SEL 을 만든다');
  const r2 = await ing(NOW + 5 * 60_000 + 7 * HOUR);
  const b = await D.loadAll();
  assert.equal(b.records.length, recs1, '같은 항목은 한 번');
  assert.equal(b.servers.reduce((n, s) => n + (s.sel?.events?.length || 0), 0), sel1);
  assert.equal(r2.newRecords.length, 0, '가짜 새 기록이 없다');
});

test('R2-3 — 그 서버를 맡은 노드가 바뀌어도(중앙 직결 → 엣지) 지난 기록 · 시리얼 이력이 따라온다', async () => {
  const srv = (id) => ({ id, name: id, serviceTag: 'ST-MOVE1', ok: true, reason: '',
    records: [{ entryId: '7', created: NOW - 40 * DAY, createdRaw: NOW - 40 * DAY, messageId: 'IDRAC.2.9.PDR54', severity: 'OK', message: 'A disk media error on Disk 2 in Backplane 1 of Integrated RAID Controller 1 was corrected during recovery.', code: 'PDR54' }],
    log: { order: 'desc', total: 10, read: 10, undated: 0, newestId: '9', newestCreated: NOW - DAY, oldestRead: NOW - 60 * DAY, reachedEnd: true, foundCursor: false, cursorUsed: false, stopped: '' },
    drives: [{ id: 'Disk.Bay.2:Enclosure.Internal.0-1:RAID.Integrated.1-1', name: 'Physical Disk 0:1:2', serial: 'SN-2', model: 'M' }], invAt: NOW - 40 * DAY });
  await D.ingestServers('', [srv('10.9.9.9')], { now: NOW - 40 * DAY });
  const moved = { ...srv('10.9.9.9'), records: [], log: { ...srv('10.9.9.9').log, oldestRead: NOW - 5 * DAY } };
  await D.ingestServers('edge-x', [moved], { now: NOW });
  const e = await D.loadServer('edge-x', '10.9.9.9');
  assert.equal(e.records.length, 1, '활성 로그에서 밀려난 기록도 남는다');
  assert.equal(e.serials.length, 1);
  assert.ok(Number.isFinite(e.server.firstOkAt) && e.server.firstOkAt <= NOW - 40 * DAY, '기준선을 다시 시작하지 않는다');
  assert.equal((await D.loadServer('', '10.9.9.9')).server, null, '옛 노드 행은 옮겨졌다');
  // 서비스 태그가 다르면(같은 IP 에 다른 서버) 옮기지 않는다.
  await D.ingestServers('edge-y', [{ ...moved, serviceTag: 'OTHER' }], { now: NOW });
  assert.equal((await D.loadServer('edge-y', '10.9.9.9')).records.length, 0);
});

test('R2-4 · R2-5 — 건수를 알면 건수로 끝을 판정 · 오류 멈춤은 error · 2000년 전 시각은 못 읽은 시각', async () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({ Id: String(1000 - i), Created: new Date(NOW - i * HOUR).toISOString(), MessageId: 'IDRAC.2.9.USR0030', Message: 'x' }));
  // 마지막 쪽에도 다음 쪽 링크를 달고 범위 밖은 400 으로 답하는 장비.
  const getJson = async (_e, p) => {
    if (p === '/redfish/v1/Managers') return mgrs;
    const s = skipOf(p);
    if (s >= rows.length) throw Object.assign(new Error('x'), { status: 400 });
    return { Members: rows.slice(s, s + 50), 'Members@odata.count': rows.length, 'Members@odata.nextLink': 'n' };
  };
  const r = await L.readLclog({}, { getJson });
  assert.equal(r.reachedEnd, true);
  assert.equal(r.stopped, '');
  // 1970 시각의 PDR 하나 — 구간을 지우지 않고 '시각 못 읽음' 으로 센다.
  const pre = [...rows.slice(0, 49), { Id: '1', Created: '1970-01-01T00:00:10Z', MessageId: 'IDRAC.2.9.PDR46', Message: 'Disk 2 in Backplane 1' }];
  const r2 = await L.readLclog({}, { getJson: async (_e, p) => (p === '/redfish/v1/Managers' ? mgrs : { Members: pre, 'Members@odata.count': pre.length }) });
  assert.equal(r2.undated, 1);
  assert.equal(r2.undatedStorage, 1);
  assert.ok(r2.oldestRead >= L.entryRow({ Created: new Date(NOW - 48 * HOUR).toISOString() }).created);
  assert.equal(L.entryRow({ Created: '1999-12-31T23:59:59Z' }).created, null);
  assert.equal(SEL.selDriveEvent({ Created: '1970-01-01T00:00:00Z', SensorType: 'Drive Slot / Bay', Message: 'Drive 2 is removed from disk drive bay 1.' }).created, null);
  const s = await SEL.readSel({}, { mgr: MGR, now: () => NOW, getJson: async () => ({ Members: [{ Id: '1', Created: '1970-01-01T00:00:00Z', Message: 'x' }, { Id: '2', Created: new Date(NOW - DAY).toISOString(), Message: 'y' }] }) });
  assert.equal(s.oldest, NOW - DAY, '1970 항목이 본 기간 시작을 지우지 않는다');
  // 정제 · 저장도 시각 못 읽은 저장 기록 수를 싣는다.
  const c = I.cleanServer({ id: 'u1', ok: true, log: { order: 'desc', undated: 4, undatedStorage: '2', top: [] }, records: [] }, NOW);
  assert.equal(c.log.undatedStorage, 2);
});

test('I-4 · I-6 — 고장 예측 문장 · 413 이면 반으로 나눠 다시 보냄(마지막 표시는 뒤쪽에만)', async () => {
  assert.equal(SEL.selDriveEvent({ Created: new Date(NOW).toISOString(), SensorType: 'Drive Slot / Bay', Message: 'Failure predicted on drive 2 in disk drive bay 1.' }).kind, 'predictive');
  const sent = [];
  const send = async (b, st) => {
    if (b.length > 2) throw Object.assign(new Error('413'), { status: 413 });
    sent.push({ n: b.length, final: !!st.final });
    return { stored: true, newRecords: b.length };
  };
  const ack = await E._postSplitWithForTest(send, [1, 2, 3, 4, 5, 6, 7], { final: true });
  assert.deepEqual(sent.map((x) => x.n), [2, 2, 2, 1]);
  assert.deepEqual(sent.map((x) => x.final), [false, false, false, true]);
  assert.equal(ack.stored, true);
  assert.equal(ack.newRecords, 7);
  await assert.rejects(E._postSplitWithForTest(async () => { throw Object.assign(new Error('413'), { status: 413 }); }, [1], { final: true }), (e) => e.status === 413);
});

test('R2-2 · R2-6 · R2-7 · I-3 · I-5 — 소스 계약(메일 참조 · 503 재시도 안 함 · 서버 id 로 세기 · 가져오기 재시도 안 함 · 보고 없는 조각 다시 내줌 · 양보 · 진단 방향)', () => {
  assert.match(code('diskbad/notify.js'), /cc: base\.ok && Array\.isArray\(base\.cc\) \? base\.cc : \[\]/);
  const edge = code('diskbad/edge.js');
  assert.match(edge, /retries: 2, noRetryStatus: \[503\]/);
  assert.match(edge, /disk-bad-job`, config\.agent\.name\), \{ headers: headers\(\), timeoutMs: 15_000, retries: 0 \}/);
  const jobs = code('diskbad/jobs.js');
  assert.match(jobs, /u\.unsaved = u\._unsavedIds\.size;/);
  assert.match(jobs, /if \(!u\.reported\) \{ u\.claimedAt = now\(\);/);
  assert.match(code('diskbad/db.js'), /if \(\(out\.length & 15\) === 0\) await yielder\(\);/);
  assert.match(code('diskbad/probe.js'), /if \(lclogOrder !== 'desc'\) return \{ n: f\.n, order: lclogOrder/);
});
