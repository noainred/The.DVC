// v2.602 감사 수정 — 그룹 c(RMA 결과 · SAN 포트 사용량 DB · 포트 처리량).
//   CEN2602-03·04·05 · DB2602-01·02 · COL-2602-02 · COL-2602-03(가능성)
//   전부 실제 함수를 호출해 동작으로 본다(기준 시각은 고정값 — Date.now() 를 기준으로 쓰지 않는다).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2602c-'));
process.env.CONFIG_DIR = CFG;
process.env.PRUNE_CHUNK_ROWS = '500';   // 청크가 여러 번 도는 것을 작은 표본으로 본다(하한 500)
after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* */ } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = 1_750_000_000_000;   // 고정 기준 시각

// ── CEN2602-03: RMA 결과는 아는 필드·모양으로만 보관 ──────────────────────────
test('CEN2602-03 — 객체 reason·exitCode 가 화면·영속 이력을 깨뜨리지 않는다', async () => {
  const jobs = await import('../src/rma/jobs.js');
  const { listHistoryRows } = await import('../src/rma/historyDb.js');
  jobs._resetRma();
  const { reqId } = jobs.enqueueJob('e2602c', { cmd: 'uptime', args: {} }, { user: 'admin', timeoutMs: 5000 });
  assert.equal(jobs.takeJobs('e2602c', 'a').length, 1);
  assert.equal(jobs.setJobResult(reqId, {
    ok: 'yes', reason: { $$typeof: 'x', a: 1 }, exitCode: { a: 1 }, durationMs: '12', stdout: { s: 1 }, stderr: 'err',
    argv: ['ls', { x: 1 }, 5, 'y'.repeat(2000)], cmd: { c: 1 }, instance: 'a', timedOut: 1, extra: { secret: 'z' },
  }), true);
  const r = jobs.getJob(reqId).result;
  assert.equal(typeof r.reason, 'undefined', '객체 reason 은 버린다(글자만)');
  assert.equal(r.exitCode, null, '객체 exitCode 는 null');
  assert.equal(r.durationMs, 12);
  assert.equal(r.ok, false, "'yes' 는 true 가 아니다");
  assert.equal(r.timedOut, false);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'err');
  assert.deepEqual(r.argv.map((x) => x.length), [2, 1, 1000]);
  assert.equal(r.cmd, undefined);
  assert.equal(r.extra, undefined, '모르는 필드는 담지 않는다');
  assert.deepEqual(r.invalidFields.sort(), ['exitCode', 'reason', 'stdout'].sort());
  const h = jobs.listHistory({ agent: 'e2602c' })[0];
  assert.equal(typeof h.reason, 'string');
  assert.equal(h.exitCode, null);
  // 영속 이력: 예전에는 객체 exitCode 가 바인드 오류로 INSERT 가 조용히 실패했다
  let rows = null;
  for (let i = 0; i < 40; i++) { rows = await listHistoryRows({ agent: 'e2602c' }); if (rows?.length) break; await sleep(25); }
  assert.ok(rows, 'node:sqlite 사용 가능');
  assert.equal(rows.length, 1, '영속 이력에 적재됐다');
  assert.equal(rows[0].reqId, reqId);
  // 결과가 객체가 아니면 빈 결과 안내
  assert.deepEqual(jobs.sanitizeRmaResult(['x']), { ok: false, reason: '에이전트가 빈 결과를 회신했습니다.' });
});

// ── CEN2602-04: 점검 결과 name 이 객체여도 정렬이 던지지 않는다 ─────────────────
test('CEN2602-04 — 엣지 r.name 이 객체여도 latestResults 가 계속 동작한다', async () => {
  const tr = await import('../src/rma/testResults.js');
  tr._resetTestResults();
  await tr.ingestResult('e1', { id: 't1', test: { x: 1 }, name: { n: 1 }, status: 'ok', reply: { r: 1 }, durationMs: { d: 1 }, at: T0 }, { now: T0, alert: false });
  await tr.ingestResult('e1', { id: 't2', test: 'ping', name: 'b'.repeat(300), status: 'bad', at: T0 }, { now: T0, alert: false });
  await tr.ingestResult('e0', { id: 't3', test: 'ping', status: 'ok', at: T0 }, { now: T0, alert: false });
  const rows = tr.latestResults();
  assert.equal(rows.length, 3);
  const t1 = rows.find((x) => x.testId === 't1');
  assert.equal(t1.name, ''); assert.equal(t1.test, ''); assert.equal(t1.reply, ''); assert.equal(t1.durationMs, null);
  assert.equal(rows.find((x) => x.testId === 't2').name.length, 80);
  // 다음 보고에서 prev.name 으로 대물림돼도 글자다
  await tr.ingestResult('e1', { id: 't1', status: 'ok', at: T0 + 1 }, { now: T0 + 1, alert: false });
  assert.doesNotThrow(() => tr.latestResults());
  tr._resetTestResults();
});

// ── CEN2602-05: perf 메타 포트 범위·문자열 길이 ────────────────────────────────
test('CEN2602-05 — 범위 밖 포트는 버리고 개수를 밝히며, 메타 문자열은 128자로 자른다', async () => {
  const db = await import('../src/sanswitch/perfDb.js');
  const now = Date.now();   // 저장 ts 는 보존일 안이어야 한다(판정 기준 시각은 아니다)
  const r = await db.importSamples(
    [{ d: 'swM', ts: now, p: 5, b: 10 }, { d: 'swM', ts: now, p: 99999, b: 10 }, { d: 'swM', ts: now, p: -1, b: 1 }],
    [{ d: 'swM', p: 5, ts: now, name: 'n'.repeat(5000), wwn: { w: 1 }, speed: '16G', type: 'F' },
      { d: 'swM', p: 1e9, ts: now, name: 'x' }, { d: 'swM', p: 4096, ts: now, name: 'x' }],
    90,
  );
  assert.equal(r.inserted, 1);
  assert.equal(r.skipped, 2);
  assert.equal(r.metaRejected, 2);
  const s = await db.portSeries('swM', { hours: 1 });
  assert.equal(s.series.length, 1);
  assert.equal(s.series[0].name.length, 128);
  const meta = await db.metaFor(['swM']);
  assert.deepEqual(meta.map((m) => m.p), [5]);
  assert.equal(meta[0].wwn, '');
});

// ── DB2602-01 + DB2602-02: 청크 prune · 통계 캐시 ─────────────────────────────
test('DB2602-01 — pruneNow 는 청크로 지우며 청크 사이에 이벤트 루프를 양보하고, port_meta 도 정리한다', async () => {
  const db = await import('../src/sanswitch/perfDb.js');
  const { DatabaseSync } = await import('node:sqlite');
  const now = Date.now();
  // 오래된 표본 3,000행(청크 500 → 6청크 이상) + 최근 10행 + 오래된 메타 1행
  const old = now - 200 * 86400e3;
  const rows = [];
  for (let i = 0; i < 3000; i++) rows.push({ d: 'swP', ts: old + i, p: i % 64, b: 1 });
  for (let i = 0; i < 10; i++) rows.push({ d: 'swP', ts: now - i * 1000, p: i, b: 1 });
  await db.importSamples(rows, [{ d: 'swP', p: 1, ts: old, name: 'old' }, { d: 'swP', p: 2, ts: now, name: 'new' }], 90);
  let ticks = 0; let stop = false;
  const probe = () => { if (stop) return; ticks++; setImmediate(probe); };   // 양보 여부를 같은 큐로 센다(v2.581 BUG-E 규약)
  setImmediate(probe);
  const r = await db.pruneNow(90);
  stop = true;
  assert.ok(r.deleted >= 3000, `삭제 ${r.deleted}`);
  assert.equal(r.done, true);
  assert.ok(ticks >= 5, `청크 사이 양보 ${ticks}회`);
  assert.equal(r.metaDeleted >= 1, true, '보존일 동안 갱신 없는 메타는 지운다');
  const meta = await db.metaFor(['swP']);
  assert.deepEqual(meta.map((m) => m.p), [2]);
  const conn = new DatabaseSync(path.join(CFG, 'sanswitch-perf.db'));
  const left = conn.prepare("SELECT COUNT(*) n FROM port_perf WHERE device_id='swP'").get().n;
  conn.close();
  assert.equal(left, 10, '보존일 안의 표본은 남는다');
});

test('DB2602-02 — perfDbStats 는 행 수를 60초 캐시하고 countsAt 으로 밝히며, 적재·prune 이 캐시를 버린다', async () => {
  const db = await import('../src/sanswitch/perfDb.js');
  const now = Date.now();
  const a = await db.perfDbStats({ now: T0 });
  assert.equal(a.available, true);
  assert.equal(a.countsAt, T0);
  const before = a.rows;
  // 캐시 안(60초 이내)에서는 COUNT 를 다시 하지 않는다 — 외부에서 행을 넣어도 같은 값
  const { DatabaseSync } = await import('node:sqlite');
  const conn = new DatabaseSync(path.join(CFG, 'sanswitch-perf.db'));
  conn.prepare('INSERT INTO port_perf (device_id, ts, port, bps) VALUES (?,?,?,?)').run('swX', now, 1, 1);
  conn.close();
  const b = await db.perfDbStats({ now: T0 + 30_000 });
  assert.equal(b.rows, before, '캐시 값');
  assert.equal(b.countsAt, T0);
  assert.ok(b.newest >= now - 1, 'MIN/MAX 는 캐시하지 않는다(인덱스 양끝 조회)');
  const c = await db.perfDbStats({ now: T0 + 61_000 });
  assert.equal(c.rows, before + 1, 'TTL 이 지나면 다시 센다');
  // 적재가 캐시를 버린다
  await db.importSamples([{ d: 'swX', ts: now, p: 2, b: 1 }], [], 90);
  const d = await db.perfDbStats({ now: T0 + 62_000 });
  assert.equal(d.rows, before + 2);
  assert.equal(d.countsAt, T0 + 62_000);
});

test('DB2602-01/02 — 소스에 단일 대형 DELETE·다중 aggregate 풀스캔이 남지 않는다', async () => {
  const { stripComments } = await import('./_stripComments.js');   // 규칙을 설명하는 주석이 통과 근거가 되지 않게(v2.535)
  const src = stripComments(fs.readFileSync(path.join(import.meta.dirname, '../src/sanswitch/perfDb.js'), 'utf8'));
  assert.equal(/DELETE FROM port_perf WHERE ts\s*</.test(src), false, 'port_perf 는 rowid 청크 DELETE');
  assert.equal(/COUNT\(\*\)[^'`]*MIN\(ts\)/.test(src), false, 'COUNT+MIN+MAX 한 쿼리 금지(v2.550.3)');
});

// ── COL-2602-02: 처리량 분모는 카운터를 읽은 시각 ──────────────────────────────
test('COL-2602-02 — REST 처리량은 카운터를 받은 시각 차이로 나눈다(조립 시각이 아니라)', async () => {
  const { buildSnapshot } = await import('../src/sanswitch/collectors/fosRest.js');
  const parts = (inOct) => ({
    ports: { 'fibrechannel': [{ name: '0', 'default-index': 0, 'physical-state': 'online', speed: 16e9 }] },
    stats: { 'fibrechannel-statistics': [{ name: '0', 'in-frames': inOct / 1000, 'out-frames': 0, 'in-octets': inOct, 'out-octets': 0 }] },
  });
  const dev = { id: 'rest-2602c', host: '10.0.0.9' };
  buildSnapshot(dev, parts(0), { countersAt: T0 });
  // 카운터는 정확히 300초 간격에 읽혔고 1초당 1,000,000 옥텟 → 8,000,000 bps. 조립 시각은 전혀 다른 때여도 무관.
  const s = buildSnapshot(dev, parts(300 * 1_000_000), { countersAt: T0 + 300_000 });
  const p = s.ports.list?.[0] || s.ports?.ports?.[0];
  assert.ok(p, JSON.stringify(Object.keys(s.ports)));
  assert.equal(p.inBps, 8_000_000);
  assert.equal(s.extra.rateGapSec, 300);
  const src = fs.readFileSync(path.join(import.meta.dirname, '../src/sanswitch/collectors/fosRest.js'), 'utf8');
  assert.match(src, /buildSnapshot\(device, parts, \{ countersAt: doneAt\.stats/, 'collect 가 stats 수신 시각을 넘긴다');
  assert.match(src, /doneAt\[key\] = Date\.now\(\)/);
});

// ── COL-2602-03(가능성): 값 줄에 카운터가 아닌 토큰이 섞이면 저장하지 않는다 ─────
test('COL-2602-03 — slot 접두 값 줄을 두 칸 밀어 읽지 않는다(틀린 값 대신 unrecognized)', async () => {
  const { parsePortPerfShow } = await import('../src/sanswitch/collectors/fosParse.js');
  const r = parsePortPerfShow('     0      1      2      3\n=====\nslot  1:   100 200 300 400\nslot  2:   500 600 700 800');
  assert.deepEqual(r.ports, {});
  assert.equal(r.unrecognized, 1);
  // 일반 형식은 그대로(- 는 값 없음)
  const ok = parsePortPerfShow('     0      1      2      3  Total\n=====\n  100 2.5k -  400 3000');
  assert.deepEqual(ok.ports, { 0: 100, 1: 2500, 3: 400 });
  assert.equal(ok.total, 3000);
  assert.equal(ok.unrecognized, undefined);
});
