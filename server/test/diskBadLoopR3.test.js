/**
 * 디스크 배드 섹터 — 개선 · 버그 수정 반복 3회차(반증 1인 — D1 ~ D9 · 개선 I1 · I2).
 * D1(노드 이동 조건)은 diskBadLoopR2 R2-3 이 고정한다. 여기서는 D3 · D4 · D5 · D9 · I1 과 라우트 계약을 고정한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'diskbadloopr3-'));
process.env.CONFIG_DIR = TMP;
process.env.DISKBAD_DB_PATH = path.join(TMP, 'disk-bad.db');
process.env.AUTH_ENABLED = 'false';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = (p) => stripComments(fs.readFileSync(path.join(ROOT, 'src', p), 'utf8'));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

const S = await import('../src/diskbad/summary.js');
const VD = await import('../src/diskbad/verdict.js');
const R = await import('../src/routes/api/diskBad.js');
const { normalizeSettings } = await import('../src/diskbad/settings.js');
const { dayKey, portalParts, portalMs } = await import('../src/util/dayKey.js');

after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

const ID0 = 'Disk.Bay.0:Enclosure.Internal.0-1:RAID.Integrated.1-1';

test('D4 — 이상 디스크 상한은 정렬 뒤(이상 먼저) · 전체 수를 함께', () => {
  const rows = []; const servers = [];
  for (let i = 0; i < 400; i += 1) {
    const fault = i >= 390;
    rows.push({ agent: '', serverId: `s${i}`, name: `s${i}`, lastStatus: 'ok', lastOkAt: NOW, continuousSince: NOW - 30 * DAY, complete: true,
      drives: [{ id: ID0, name: 'Physical Disk 0:1:0', serial: `S${i}`, health: fault ? 'Critical' : 'Warning', state: 'Enabled', inVolume: true }] });
    servers.push({ agent: '', id: `s${i}`, name: `s${i}`, corp: null });
  }
  const f = S.buildFleet({ servers, db: { servers: rows, records: [], serials: [] }, now: NOW });
  assert.equal(f.alertingTotal, 400);
  assert.equal(f.alerting.length, 300);
  assert.equal(f.alerting.filter((a) => a.level === 'fault').length, 10, '이상 10개가 잘리지 않는다');
});

test('D5 — 근거 날짜와 월은 포탈 시각(기본 KST)', () => {
  const p = portalParts(NOW);
  const firstKst = portalMs(p.y, p.mo, 1, 3);   // 그달 1일 03:00 포탈 시각(KST 면 UTC 로는 전달 말일 — 오프셋을 박지 않는다 · 4회차 반증)
  const created = firstKst <= NOW ? firstKst : firstKst - 31 * DAY;
  const j = VD.judgeServer({ records: [{ created, code: 'PDR46', cls: 'unrecoverable', slotKey: 'bp1:d0' }], drives: [{ id: ID0, name: 'Physical Disk 0:1:0', serial: 'S0', inVolume: true }],
    serialRows: [], coverage: { lastOkAt: NOW, continuousSince: created - 30 * DAY } });
  assert.match(j.slots[0].evidence[0].text, new RegExp(dayKey(created)));
  const rows = [{ agent: '', serverId: 'm1', name: 'm1', lastStatus: 'ok', lastOkAt: NOW, continuousSince: created - DAY, drives: [] }];
  const f = S.buildFleet({ servers: [{ agent: '', id: 'm1', name: 'm1', corp: null }], db: { servers: rows, records: [{ agent: '', serverId: 'm1', entryKey: 'k', created, code: 'PDR46', slotKey: '', message: 'x' }], serials: [] }, now: NOW });
  const m = f.months.find((x) => x.month === dayKey(created).slice(0, 7));
  assert.ok(m && m.unrecoverable === 1, `KST 달(${dayKey(created).slice(0, 7)})에 들어간다`);
});

test('4회차 F3 — 월별 추이의 창도 포탈 시각의 달(1일 새벽에 이번 달 기록이 빠지지 않는다)', () => {
  const p = portalParts(NOW);
  const now = portalMs(p.y, p.mo, 1, 3);         // 이번 달 1일 03:00(포탈 시각)
  const created = now - 2 * HOUR;                // 같은 날 01:00
  const rows = [{ agent: '', serverId: 'm1', name: 'm1', lastStatus: 'ok', lastOkAt: now, continuousSince: created - DAY, drives: [] }];
  const f = S.buildFleet({ servers: [{ agent: '', id: 'm1', name: 'm1', corp: null }], db: { servers: rows, records: [{ agent: '', serverId: 'm1', entryKey: 'k', created, code: 'PDR46', slotKey: '', message: 'x' }], serials: [] }, now });
  const last = f.months[f.months.length - 1];
  assert.equal(last.month, dayKey(now).slice(0, 7), '마지막 달은 포탈 시각의 이번 달');
  assert.equal(last.unrecoverable, 1, '1일 새벽 기록이 이번 달 추이에 든다');
  assert.equal(last.partial, true);
});

test('D9 — 서버 창에 싣는 기록: 판정에 쓰는 분류는 전부 · 그 밖은 가장 새 N건 · 전체 수', () => {
  const recs = [];
  for (let i = 0; i < 5; i += 1) recs.push({ created: NOW - i * HOUR, cls: 'unrecoverable', code: 'PDR46' });
  for (let i = 0; i < 400; i += 1) recs.push({ created: NOW - i * 60_000, cls: 'other', code: 'PDR99' });
  const t = S.trimRecordsForView(recs);
  assert.equal(t.total, 405);
  assert.equal(t.records.length, 5 + S.OTHER_RECORDS_VIEW_MAX);
  assert.equal(t.trimmed, 100);
  assert.equal(t.records.filter((r) => r.cls === 'unrecoverable').length, 5);
});

test('D3 — 담당자 저장 보고: 버린 주소 · 통째로 뺀 법인 · 모르는 법인 키', () => {
  const sent = { 'vc-a': ['a@x.com', 'not-a-mail'], 'vc-b': ['홍길동'], 서울법인: ['c@x.com'] };
  const saved = normalizeSettings({ corpTo: sent }).corpTo;
  const rep = R.corpToReport(sent, saved, ['vc-a', 'vc-b']);
  assert.equal(rep.droppedEmails, 2);
  assert.deepEqual(rep.droppedCorps, ['vc-b']);
  assert.deepEqual(rep.unknownCorps, ['서울법인']);
});

test('3회차 화면 확인 — 법인 이름으로 적은 담당자 키는 그 법인 id 로(이름이 둘 이상과 맞으면 그대로)', () => {
  const corps = [{ id: 'vc-1', name: 'vcenter-ap-northeast-01' }, { id: 'vc-2', name: 'dup' }, { id: 'vc-3', name: 'dup' }];
  const m = R.mapCorpKeys({ 'vcenter-ap-northeast-01': ['a@x.com'], dup: ['b@x.com'], 'vc-2': ['c@x.com'] }, corps);
  assert.deepEqual(m.renamed, [{ from: 'vcenter-ap-northeast-01', to: 'vc-1' }]);
  assert.deepEqual(Object.keys(m.corpTo).sort(), ['dup', 'vc-1', 'vc-2']);
});

test('D9 · I1 — 라우트 계약(이 서버를 읽는 조각만 점검 중 · 노드 바쁨 따로 · 법인 쓰기 가능 · 설정 수정 가능 · 기록 줄이기)', () => {
  const rt = code('routes/api/diskBad.js');
  assert.match(rt, /const running = units\.some\(\(u\) => !Array\.isArray\(u\.serverIds\) \|\| u\.serverIds\.map\(String\)\.includes\(String\(s\.id\)\)\);/);
  assert.match(rt, /nodeBusy,/);
  assert.match(rt, /writable: !!c\.id && inUserWriteScope\(req\.user, store\.get\(\), c\.id\)/);
  assert.match(rt, /settingsEditable: isFullReadWriteScope\(req\.user, store\.get\(\)\)/);
  assert.match(rt, /const tr = trimRecordsForView\(v\.records\);/);
});
