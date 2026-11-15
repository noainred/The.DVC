/**
 * v3.10.15 디스크 배드 섹터 — 개선 · 버그 수정 반복 1회차(반증 1인 — R1 ~ R15 · 개선 I1 ~ I3).
 * 고정하는 것: 위치 못 읽은 기록은 건수로만 · 판정 기준 시각은 배드 섹터 기록 · 앞에서부터 읽다 멈춘 점검은 구간을 주장하지 않음 ·
 * 시한으로 닫은 조각도 메일 · 마지막 묶음은 저장 실패여도 닫음 · 교체된 자리의 새 디스크 흔적 · 다시 꽂은 같은 시리얼 ·
 * 로그 못 읽은 서버의 이상 디스크 · DB 를 못 열면 자동 점검 안 함 · 다시 보내기가 작업 시각을 안 바꿈 · 엣지가 다시 오면 남은 조각을 닫음 · 응답 범위.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'diskbadloop31015-'));
process.env.CONFIG_DIR = TMP;
process.env.DISKBAD_DB_PATH = path.join(TMP, 'disk-bad.db');
process.env.AUTH_ENABLED = 'false';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = (p) => stripComments(fs.readFileSync(path.join(ROOT, 'src', p), 'utf8'));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

const VD = await import('../src/diskbad/verdict.js');
const S = await import('../src/diskbad/summary.js');
const D = await import('../src/diskbad/db.js');
const J = await import('../src/diskbad/jobs.js');

after(() => { try { D._resetDiskBadDbForTest(); } catch { /* */ } J._resetJobsForTest(); fs.rmSync(TMP, { recursive: true, force: true }); });

const ID0 = 'Disk.Bay.0:Enclosure.Internal.0-1:RAID.Integrated.1-1';
const drive0 = (serial) => ({ id: ID0, name: 'Physical Disk 0:1:0', model: 'M', serial, inVolume: true, health: 'OK', state: 'Enabled' });
const rec = (created, code, cls, slotKey = 'bp1:d0') => ({ created, code, cls, slotKey });

test('R1 — 위치를 못 읽은 기록은 건수로만(자리 단위 판단 불가에 섞지 않음) · 그 서버도 기록 있는 서버', () => {
  const recs = [0, 1, 2].map((i) => rec(NOW - (i + 1) * DAY, 'PDR54', 'corrected', ''));
  const j = VD.judgeServer({ records: recs, drives: [drive0('S0')], serialRows: [], coverage: { lastOkAt: NOW, continuousSince: NOW - 90 * DAY } });
  assert.equal(j.status, 'records');
  assert.equal(j.counts.records, 3);
  assert.equal(j.counts.unplaced, 3);
  assert.equal(j.counts.slots, 0);
  assert.equal(j.counts.unknown, 0, '판단 불가는 자리 단위만');
  const row = { agent: '', serverId: 's1', name: 's1', lastStatus: 'ok', lastOkAt: NOW, continuousSince: NOW - 90 * DAY, drives: [drive0('S0')] };
  const f = S.buildFleet({ servers: [{ agent: '', id: 's1', name: 's1', corp: null }], db: { servers: [row], records: recs.map((r, i) => ({ agent: '', serverId: 's1', entryKey: `k${i}`, created: r.created, code: 'PDR54', slotKey: '', message: 'x' })), serials: [] }, now: NOW });
  assert.equal(f.totals.serversWithRecords, 1);
  assert.equal(f.totals.records, 3);
  assert.equal(f.totals.unplaced, 3);
  assert.equal(f.totals.unknown, 0);
});

test('R2 — 교체 뒤 새 디스크의 고장 예측(PDR16)이 옛 디스크의 기록을 사용 중으로 뒤집지 않음', () => {
  const recs = [rec(NOW - 30 * DAY, 'PDR46', 'unrecoverable'), rec(NOW - 20 * DAY, 'PDR5', 'removed'), rec(NOW - 5 * DAY, 'PDR16', 'predictive')];
  const j = VD.judgeServer({ records: recs, drives: [drive0('NEW')], serialRows: [], coverage: { lastOkAt: NOW, continuousSince: NOW - 90 * DAY } });
  assert.equal(j.slots[0].verdict, VD.VERDICT.unknown, '배드 섹터 기록 뒤 빠짐이 있다 — 다시 꽂았는지 바꿨는지 모른다');
  // 고장 예측만 있는 자리는 그것으로 판정한다(예전과 같다).
  const p = VD.judgeServer({ records: [rec(NOW - 5 * DAY, 'PDR16', 'predictive')], drives: [drive0('S0')], serialRows: [], coverage: { lastOkAt: NOW, continuousSince: NOW - 90 * DAY } });
  assert.equal(p.slots[0].verdict, VD.VERDICT.inUse);
});

test('R3 — 앞(오래된 쪽)에서부터 읽다 멈춘 첫 점검은 끊김 없이 본 구간 · 기준선을 주장하지 않음', async () => {
  const s = { id: 'fwd', name: 'fwd', ok: true, reason: '', records: [{ entryId: '1', created: NOW - 400 * DAY, createdRaw: NOW - 400 * DAY, messageId: 'IDRAC.2.9.PDR54', severity: 'OK', message: 'A disk media error on Disk 0 in Backplane 1 of Integrated RAID Controller 1 was corrected during recovery.', code: 'PDR54' }],
    log: { order: 'unknown', total: null, read: 50_000, undated: 0, newestId: '1', newestCreated: NOW - 300 * DAY, oldestRead: NOW - 400 * DAY, reachedEnd: false, foundCursor: false, cursorUsed: false, stopped: 'max' }, drives: null };
  await D.ingestServers('', [s], { now: NOW });
  const one = await D.loadServer('', 'fwd');
  assert.equal(one.server.continuousSince, null, '최신 쪽을 못 봤다 — 구간 모름');
  assert.equal(one.server.firstOkAt, null, '기준선은 다음 점검으로(원래 있던 기록이 새 기록 메일이 되지 않게)');
  assert.equal(one.server.newestCreated, null);
  assert.equal(one.server.complete, false);
  // 다음 점검(끝까지 읽음)이 기준선 — 새 기록을 내지 않는다.
  const r2 = await D.ingestServers('', [{ ...s, records: [...s.records, { entryId: '2', created: NOW - DAY, createdRaw: NOW - DAY, messageId: 'IDRAC.2.9.PDR46', severity: 'Warning', message: 'x', code: 'PDR46' }],
    log: { ...s.log, order: 'desc', reachedEnd: true, newestCreated: NOW - HOUR, stopped: '' } }], { now: NOW + HOUR });
  assert.equal(r2.newRecords.length, 0);
  assert.equal(r2.baselineServers, 1);
});

test('R4 · R5 · R12 · R14 — 소스 계약(시한으로 닫아도 메일 · 마지막 묶음은 저장 실패여도 닫음 · DB 를 못 열면 자동 점검 안 함 · 응답 범위)', () => {
  const jb = code('diskbad/jobs.js');
  const sweep = jb.slice(jb.indexOf('export function sweepJobs'), jb.indexOf('function busyAgents'));
  assert.equal((sweep.match(/finishUnit\(j, u\)/g) || []).length, 2, '시작 못 함 · 응답 없음 둘 다 finishUnit');
  const push = jb.slice(jb.indexOf('export async function acceptPush'), jb.indexOf('export function stopJob'));
  assert.ok(push.indexOf('if (push.final)') < push.indexOf("if (!r.ok) return { ok: false"), '마지막 묶음 닫기가 저장 실패 반환보다 먼저');
  assert.match(push, /u\.unsaved \+= push\.servers\.length/);
  const auto = jb.slice(jb.indexOf('export async function autoTick'), jb.indexOf('export function autoInfo'));
  assert.match(auto, /if \(!\(await diskBadDbStatus\(\)\)\.available\) return null;/);
  assert.match(auto, /if \(!\(await setDiskBadMeta\(AUTO_META_KEY, t\)\)\) return null;/);
  const rt = code('routes/api/diskBad.js');
  assert.match(rt, /res\.json\(\{ ok: true, job: r \? \(jobsFor\(req\)\.find\(\(x\) => x\.id === r\.id\) \|\| null\) : null \}\)/);
  assert.match(rt, /res\.json\(\{ ok: true, job: jobsFor\(req\)\.find\(\(x\) => x\.id === r\.id\) \|\| null \}\)/);
});

test('R8 · R9 — 교체된 자리의 새 디스크 흔적은 흔적으로 · 다시 꽂은 같은 시리얼이 사이 기록을 확정하지 않음', () => {
  // R8: 기록(옛 디스크 OLD) → 교체(NEW) — 새 디스크의 흔적은 '로그 기록 있음' 이 아니라 흔적.
  const serialRows = [{ slotKey: 'bp1:d0', serial: 'OLD', firstSeen: NOW - 60 * DAY, lastSeen: NOW - 20 * DAY }, { slotKey: 'bp1:d0', serial: 'NEW', firstSeen: NOW - 10 * DAY, lastSeen: NOW }];
  const vals = { status: 'ok', tryAt: NOW, drives: [{ id: ID0, serial: 'NEW', realloc: 12, pending: 3, uncorrectable: 0, readAt: NOW }] };
  const j = VD.judgeServer({ records: [rec(NOW - 30 * DAY, 'PDR46', 'unrecoverable')], drives: [drive0('NEW')], serialRows, coverage: { lastOkAt: NOW, continuousSince: NOW - 90 * DAY }, vals });
  assert.equal(j.slots[0].verdict, VD.VERDICT.replaced);
  assert.equal(j.diskVals[0].trace, VD.TRACE.trace);
  assert.equal(j.counts.traces, 1);
  // R9: 같은 시리얼 SA 를 뺐다가 다시 꽂음(SA 이력이 처음 ~ 지금으로 합쳐짐) · 그 사이 SB 가 있던 때의 기록 → SA 로 확정하지 않는다.
  const rows9 = [{ slotKey: 'bp1:d0', serial: 'SA', firstSeen: NOW - 90 * DAY, lastSeen: NOW }, { slotKey: 'bp1:d0', serial: 'SB', firstSeen: NOW - 50 * DAY, lastSeen: NOW - 30 * DAY }];
  const k = VD.judgeServer({ records: [rec(NOW - 40 * DAY, 'PDR46', 'unrecoverable')], drives: [drive0('SA')], serialRows: rows9, coverage: { lastOkAt: NOW, continuousSince: NOW - 90 * DAY } });
  assert.notEqual(k.slots[0].verdict === VD.VERDICT.inUse && k.slots[0].confidence === VD.CONFIDENCE.confirmed, true, '사용 중 · 확정이 아니다');
  assert.equal(k.slots[0].verdict, VD.VERDICT.replaced, '기록 당시의 시리얼(SB)은 지금 없다');
});

test('R10 · I3 — 로그를 못 읽은 서버의 이상 디스크도 전 법인에 · 마지막 점검 실패 서버 수', () => {
  const warn = { ...drive0('S0'), health: 'Warning', predictive: true };
  const unread = { agent: '', serverId: 'u1', name: 'u1', lastStatus: 'forbidden', lastOkAt: null, drives: [warn] };
  const stale = { agent: '', serverId: 's2', name: 's2', lastStatus: 'timeout', lastOkAt: NOW - DAY, continuousSince: NOW - 30 * DAY, drives: [drive0('S2')] };
  const f = S.buildFleet({ servers: [{ agent: '', id: 'u1', name: 'u1', corp: null }, { agent: '', id: 's2', name: 's2', corp: null }], db: { servers: [unread, stale], records: [], serials: [] }, now: NOW });
  assert.equal(f.totals.alertingDisks, 1);
  assert.equal(f.alerting[0].serverId, 'u1');
  assert.equal(f.totals.staleServers, 1);
});

test('R13 · I1 — 다시 보내기는 작업 시각을 바꾸지 않음 · 엣지가 다시 가지러 오면 남은 조각을 닫음', () => {
  J._resetJobsForTest();
  const job = J.createJob({ scope: 'all', units: [{ agent: 'edge-a', kind: 'edge', serverIds: null }, { agent: 'edge-b', kind: 'edge', serverIds: null }] });
  J.sweepJobs(job.at + J.CLAIM_TIMEOUT_MS + 60_000);
  let g = J.getJob(job.id);
  assert.deepEqual(g.units.map((u) => u.state), ['not-started', 'not-started']);
  const r = J.retryUnit(job.id, 'edge-a');
  assert.equal(r.at, job.at, '작업 시작 시각 그대로');
  J.sweepJobs(Date.now() + 60_000);
  g = J.getJob(job.id);
  assert.equal(g.units[0].state, 'queued', '다시 보낸 조각의 시한은 그때부터');
  // I1: 가져간 뒤(읽는 중) 끝을 알리지 않고 다시 가지러 오면 — 앞 조각을 닫고 기다리는 조각이 없으면 null.
  assert.ok(J.claimForAgent('edge-a'));
  assert.equal(J.getJob(job.id).units[0].state, 'running');
  assert.equal(J.claimForAgent('edge-a'), null);
  const u = J.getJob(job.id).units[0];
  assert.equal(u.state, 'failed');
  assert.match(u.error, /다음 작업을 가지러 왔습니다/);
  assert.equal(J.isAgentBusy('edge-a'), false, '그 법인 점검을 막지 않는다');
});
