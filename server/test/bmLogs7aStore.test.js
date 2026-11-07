/**
 * 7a단계 로그 분석 — 보관(한 트랜잭션 · 읽기 위치 비교 후 쓰기 · 손상 보존 · 상한 · 청크 정리) · **실제 폴러 배선**(pollBmUsageOnce → beginLogCycle → finishLogCycle → 쓰기 →
 *   함대 요약 · 알림 규칙 입력 · pruneTick) · 알림 규칙 ‘logs’ 조건(못 읽음 = 보류).
 *   데모(mock) 대상으로 돈다 — 장비 접속 없이 합성 출력(같은 파서 · 분류 · 쓰기). 기준 시각: 정시 −30분.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmlog7s-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

const S = await import('../src/bmusage/logs/store.js');
const RUN = await import('../src/bmusage/logs/run.js');
const V = await import('../src/bmusage/logs/view.js');
const { config } = await import('../src/config.js');
const AG = config.agent?.name || '';
const out = (secLines, { cur = 'a' } = {}) => ['##JOURNAL', `J#cur=s=${cur.repeat(32)};i=1;b=${'b'.repeat(32)};m=1;t=1;x=1`, 'J#n=0', 'J#rc=0', '##DMESG', 'K#absent', '##SECURE',
  ...secLines.map((l) => `S|${l}`), 'S#ino=11', 'S#size=900', 'S#mode=inc', `S#n=${secLines.length}`, 'S#off=900', '##AUDIT', 'A#absent', '##APPLOG', 'G#absent', 'F#absent', '##END'].join('\n');
const syslog = (ts, msg) => { const d = new Date(ts); const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]; return `${M} ${String(d.getDate()).padStart(2, ' ')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')} h sshd[1]: ${msg}`; };

test('쓰기 — 한 트랜잭션 · 읽기 위치 비교 후 쓰기(늦게 끝난 옛 주기는 그 서버를 건너뜀 — 두 번 세지 않음) · 손상 상태 보존', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const b1 = await RUN.buildLogWrite({ key: 'K1', stdout: out([syslog(NOW - 60_000, 'Failed password for root from 203.0.113.45 port 1 ssh2')]), prev: null, now: NOW });
  const w1 = await S.logWriteBatch({ agent: AG, items: [b1.write] });
  assert.deepEqual([w1.ok, w1.written, w1.conflicts], [true, 1, 0]);
  const c1 = (await S.logCursorsAll({ agent: AG })).get('K1');
  assert.equal(c1.rev, 1); assert.equal(c1.state.pos.secure.off, '900'); assert.ok(c1.state.pos.journal.cursor);
  // 같은 rev 를 읽은 두 주기 — 먼저 끝난 쪽만 쓰인다
  const bA = await RUN.buildLogWrite({ key: 'K1', stdout: out([syslog(NOW - 50_000, 'Failed password for root from 203.0.113.45 port 2 ssh2')]), prev: c1, now: NOW });
  const bB = await RUN.buildLogWrite({ key: 'K1', stdout: out([syslog(NOW - 50_000, 'Failed password for root from 203.0.113.45 port 2 ssh2')]), prev: c1, now: NOW });
  assert.equal((await S.logWriteBatch({ agent: AG, items: [bA.write] })).written, 1);
  const wB = await S.logWriteBatch({ agent: AG, items: [bB.write] });
  assert.deepEqual([wB.written, wB.conflicts], [0, 1], '옛 rev 로 쓴 주기는 건너뛴다');
  const q = await S.logServerQuery({ agent: AG, key: 'K1', from: NOW - 2 * HOUR, to: NOW + HOUR });
  const fails = q.hourRows.filter((r) => r.cls === 'sec').reduce((a, r) => a + r.count, 0);
  assert.equal(fails, 2, '두 번 세지 않는다');
  // 손상 상태 — 처음 읽기로 돌아가되 손상본은 bad_json 에 보존
  const { mainDb } = await import('../src/bmusage/db.js');
  (await mainDb()).prepare("UPDATE log_cursor SET state_json='{not json' WHERE agent=? AND key='K1'").run(AG);
  const c2 = (await S.logCursorsAll({ agent: AG })).get('K1');
  assert.equal(c2.corrupt, true);
  assert.ok(!RUN.logExtraFor({ key: 'K1' }, { on: true, cfg: RUN.LOG_DEFAULTS, cursors: new Map([['K1', c2]]) }).cmd.includes('--after-cursor'), '손상이면 커서를 쓰지 않는다(처음 읽기)');
  const b3 = await RUN.buildLogWrite({ key: 'K1', stdout: out([]), prev: c2, now: NOW });
  assert.equal(b3.write.status.cursorReset, 'corrupt');
  assert.equal((await S.logWriteBatch({ agent: AG, items: [b3.write] })).written, 1);
  assert.equal((await mainDb()).prepare("SELECT bad_json FROM log_cursor WHERE agent=? AND key='K1'").get(AG).bad_json, '{not json');
  assert.equal((await S.logServerQuery({ agent: AG, key: 'K1', from: NOW - HOUR, to: NOW + HOUR })).cursor.corruptKept, true);
});

test('상한 — 서버당 서명 수(묶음 행) · 보안 항목(시간 · 종류마다 · ‘(기타)’) · 청크 정리 · 사라진 서버의 읽기 위치', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const pats = Array.from({ length: S.PATTERN_MAX + 5 }, (_, i) => ({ sig: i.toString(16).padStart(16, '0'), cls: 'issue', severity: 'medium', ruleId: 'ISS-UNIT-FAIL', src: 'journal', unit: 'u', tmpl: `t${i}`, count: 1, first: NOW, last: NOW, samples: [] }));
  const hours = pats.map((p) => ({ hour: Math.floor(NOW / HOUR) * HOUR, sig: p.sig, cls: 'issue', count: 1 }));
  const sec = Array.from({ length: 30 }, (_, i) => ({ hour: Math.floor(NOW / HOUR) * HOUR, kind: 'fail_ip', item: `203.0.113.${i}`, count: 1 }));
  const w = await S.logWriteBatch({ agent: AG, items: [{ key: 'K2', readRev: null, at: NOW, state: { pos: {} }, status: {}, patterns: pats, hours, sec }] });
  assert.equal(w.ok, true); assert.equal(w.overflow, 5);
  const { mainDb } = await import('../src/bmusage/db.js');
  const db = await mainDb();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM log_pattern WHERE agent=? AND key='K2'").get(AG).c, S.PATTERN_MAX + 1, '상한 + 묶음 행 하나');
  assert.equal(db.prepare("SELECT count FROM log_pattern WHERE agent=? AND key='K2' AND sig='#over:issue'").get(AG).count, 5);
  assert.equal(db.prepare("SELECT SUM(count) c FROM log_hour WHERE agent=? AND key='K2' AND sig='#over:issue'").get(AG).c, 5, '시간 집계도 묶음 행으로');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM log_sec WHERE agent=? AND key='K2' AND item <> '(기타)'").get(AG).c, 20);
  assert.equal(db.prepare("SELECT count FROM log_sec WHERE agent=? AND key='K2' AND item='(기타)'").get(AG).count, 10);
  // 청크 정리 — 기준 앞 시간 행 · 마지막이 오래된 패턴 · 대상 밖 서버의 읽기 위치
  const p = await S.logPrune({ before: NOW + 2 * HOUR, agent: AG, keys: ['K1'] });
  assert.ok(p.hours >= S.PATTERN_MAX && p.patterns >= S.PATTERN_MAX && p.cursors === 1, JSON.stringify(p));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM log_cursor WHERE agent=? AND key='K2'").get(AG).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM log_cursor WHERE agent=? AND key='K1'").get(AG).c, 1, '대상 안 서버는 남긴다');
});

test('알림 규칙 ‘logs’ — 못 읽음 = 보류(null) · 장애 · 보안 high · 조건 선택 · perfRules 정규화', async () => {
  const A = await import('../src/bmusage/perfAlerts.js');
  const R = await import('../src/bmusage/perfRules.js');
  assert.ok(R.RULE_IDS.includes('logs'));
  assert.equal(A.ruleCondition('logs', {}, { cond: 'fault-sec' }), null, '로그를 못 읽은 서버는 판정 보류');
  assert.equal(A.ruleCondition('logs', { logs: { read: false, faultLines: 3 } }, { cond: 'fault-sec' }), null);
  assert.equal(A.ruleCondition('logs', { logs: { read: true, faultLines: 0, secHigh: 0 } }, { cond: 'fault-sec' }), false);
  assert.equal(A.ruleCondition('logs', { logs: { read: true, faultLines: 1, secHigh: 0 } }, { cond: 'sec' }), false);
  assert.equal(A.ruleCondition('logs', { logs: { read: true, faultLines: 0, secHigh: 25 } }, { cond: 'sec' }), true);
  const al = A.perfAlertOf({ rule: 'logs', key: 'k', name: 'n', vcenterId: '', ctx: { logs: { read: true, faultLines: 0, secHigh: 25, bursts: 1 } } });
  assert.ok(!al.title.includes('**') && al.title.includes('SSH 실패 집중'));
  // 설정 — 기본 켬 · 범위 밖은 400(저장) · 기본값(읽기)
  const n = R.normalizeRules({ logs: { lineCap: 99999999 } }, { strict: false }).value.logs;
  assert.equal(n.lineCap, 5_000); assert.equal(n.on, true);
  assert.throws(() => R.normalizeRules({ logs: { lineCap: 50 } }, { strict: true }), /logs\.lineCap/);
  assert.equal(R.normalizeRules({ logs: { on: false } }, { strict: true }).value.logs.on, false);
  assert.equal(R.normalizeRules({ rules: { logs: { on: true, autoFocus: true } } }).value.rules.logs.autoFocus, true);
});

test('실제 폴러 배선 — 데모 대상 한 주기 → 로그 쓰기 · 함대 요약 · 알림 입력 · 둘째 주기는 증분(첫 읽기 아님) · 정리 틱 · 끄면 붙이지 않는다', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const SERVERS = [{ id: 'mock-bmsrv-lg-01', name: 'lg-01', tag: 'LGTAG01' }, { id: 'mock-bmsrv-lg-02', name: 'lg-02', tag: 'LGTAG02' }, { id: 'mock-bmsrv-lg-03', name: 'lg-03', tag: 'LGTAG03' }];
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: SERVERS.map((x) => ({ id: x.id, name: x.name, host: '10.9.9.9', username: 'root', password: 'p' })) }));
  const P = await import('../src/bmusage/poller.js');
  const R = await import('../src/bmusage/perfRules.js');
  P._setFleetForTest(async () => ({ bareMetal: SERVERS.map((x) => ({ serverId: x.id, name: x.name, serviceTag: x.tag })), virtualizationHosts: [] }));
  V._resetLogViewForTest();
  try {
    R.savePerfRules({ rules: { logs: { on: true } } }, { by: 'adm' });
    const r1 = await P.pollBmUsageOnce({ trigger: 'manual' });
    assert.equal(r1.ok, true, JSON.stringify(r1).slice(0, 300));
    const lg = P.bmUsageStatus().last.logs;
    assert.equal(lg.on, true); assert.equal(lg.written, 3, JSON.stringify(lg)); assert.equal(lg.error, undefined);
    const cur = await S.logCursorsAll({ agent: AG });
    assert.deepEqual([...cur.keys()].filter((k) => k.startsWith('LGTAG')).sort(), ['LGTAG01', 'LGTAG02', 'LGTAG03']);
    const sum = await V.logSummaryNow();
    assert.ok(sum.list.some((x) => x.key === 'LGTAG01' && x.read > 0), '함대 요약(메모리) 갱신');
    assert.equal(RUN.logAlertInputs().size, 3, '이번 주기에 읽은 서버만 알림 입력');
    assert.equal(P.bmUsageStatus().last.perfAlertsSkipped, 'demo', '켠 규칙이 있으면 알림 경로를 탄다(데모 값으로는 보내지 않는다)');
    const v1 = await V.logViewFor({ key: 'LGTAG01', range: '24h' });
    assert.equal(v1.ok, true); assert.equal(v1.read.sources.journal.first, true);
    // 둘째 주기 — 위치가 이어진다(첫 읽기가 아니다)
    await P.pollBmUsageOnce({ trigger: 'manual' });
    const c2 = (await S.logCursorsAll({ agent: AG })).get('LGTAG01');
    assert.equal(c2.rev, 2);
    assert.equal(c2.status.sources.journal.first, undefined);
    // 정리 틱 — 로그 정리도 같은 틱(사라진 서버가 없으면 위치는 남는다)
    const pr = await P.pruneTick({ every: 1 });
    assert.ok(pr.logsPruned && pr.logsPruned.cursors === 1, `앞 시험의 K1(대상 밖)만 지운다: ${JSON.stringify(pr.logsPruned)}`);
    assert.ok((await S.logCursorsAll({ agent: AG })).has('LGTAG01'), '대상 안 서버의 위치는 남는다');
    // 끄면 — 주기는 돌고 로그만 붙이지 않는다
    R.savePerfRules({ logs: { on: false } }, { by: 'adm' });
    await P.pollBmUsageOnce({ trigger: 'manual' });
    assert.equal(P.bmUsageStatus().last.logs.on, false);
    assert.equal(RUN.logExtraFor({ key: 'X', paths: ['os'] }, await RUN.beginLogCycle()), null);
  } finally { P._setFleetForTest(null); R._resetPerfRulesForTest(); }
});
