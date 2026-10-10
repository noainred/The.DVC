// v2.732(점검 2회차 B6-04 — v2.731 이 남긴 후보): IP 원장(ipam.db) 워커 전송을 조각으로 나눴다.
// 예전 `postMessage({ id, records: rows.map(toRecord) })` 는 변환 + 구조화 복제가 한 동기 구간이라 5만 행 120.7ms · 20만 행 1,133ms 메인 정지였다.
// 고정하는 것:
//   ① 워커 프로토콜 — 조각은 메모리에만 모은다(트랜잭션을 열지 않는다 = 외부 리더 잠금 없음) · commit 에서만 한 트랜잭션 · 개수 불일치·abort 면
//      쓰지 않는다 · 옛 한 번 메시지(records·rows)도 그대로 받는다.
//   ② 결과 동일성 — 같은 행을 인라인(IPAM_WRITE_WORKER=0, 예전 경로)과 워커 조각 경로로 적재한 ip_records 가 행 수·내용·순서까지 같다.
//   ③ 메인 최장 정지 — 8만 행 동기화 중 이벤트 루프 최장 정지가 '예전 동기 구간(map + 구조화 복제)' 의 1/4 미만(비율).
//   ④ 겹친 동기화 — 큰 A 를 보내는 중 시작된 나중 B(인라인 크기·워커 크기 둘 다)가 끝나면 DB 에 B 가 남는다(v2.620 ABA 규칙).
//   ⑤ 직렬화의 대가 — 워커가 답하지 않아도 뒤 동기화가 영원히 멈추지 않는다(답 시한 → 워커 종료 → 인라인).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { COLUMNS, toRecord } from '../src/ipam/record.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

// 결정적 행 생성기 — 자식 프로세스에도 같은 코드를 넣는다(열 전부를 고르게 채운다 · Date 변환 열 포함).
const GEN = `function mkRows(n, tag) {
  tag = tag || '';
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = {
    ip: '10.' + ((i >> 16) & 255) + '.' + ((i >> 8) & 255) + '.' + (i & 255), ipNum: 167772160 + i,
    vcenterId: 'vc-' + (i % 7), vcenterName: 'VC ' + (i % 7) + tag, ownerType: i % 5 === 0 ? 'host' : 'vm',
    serverType: i % 11 === 0 ? 'Edge' : undefined, ownerName: 'node-' + i + tag, powerState: i % 3 ? 'POWERED_ON' : '',
    guestOS: i % 4 ? 'Linux' : '', osName: i % 6 ? 'Rocky' : '', osVersion: '9.' + (i % 5), hostName: 'esx-' + (i % 13),
    cluster: 'cl-' + (i % 3), scope: i % 2 ? 'private' : 'public', multiHomed: i % 9 === 0, duplicate: i % 17 === 0,
    discovery: i % 2 ? 'vcenter' : 'scan', reconcile: i % 10 === 0 ? 'mismatch' : '', mgmtStatus: i % 8 === 0 ? 'reserved' : '',
    owner_: i % 12 === 0 ? 'ops' : '', label: i % 14 === 0 ? 'lbl-' + i : '', deviceType: i % 15 === 0 ? 'printer' : '',
    firstSeen: i % 3 === 0 ? 1700000000000 + i * 1000 : null, lastSeen: i % 4 === 0 ? 1710000000000 + i : undefined,
    usageStatus: i % 2 ? 'used' : 'free', appliedBy: i % 19 === 0 ? 'policy' : '', rangePolicySpec: i % 23 === 0 ? '10.0.0.0/24' : '',
  };
  return out;
}`;
// eslint-disable-next-line no-new-func
const mkRows = new Function(`${GEN}; return mkRows;`)();

function runChild(env, body, { timeoutMs = 240_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger2732d-'));
  const script = `
    const SRC = ${JSON.stringify(SRC + '/')};
    const path = await import('node:path'); const crypto = await import('node:crypto');
    const { DatabaseSync } = await import('node:sqlite');
    ${GEN}
    const db = await import(SRC + 'ipam/db.js');
    const rec = await import(SRC + 'ipam/record.js');
    const CFG = process.env.CONFIG_DIR;
    const readDb = () => {
      const c = new DatabaseSync(path.join(CFG, 'ipam.db'));
      const all = c.prepare('SELECT * FROM ip_records ORDER BY rowid').all();
      c.close();
      const at = new Set(all.map((r) => r.updated_at));
      const body = all.map((r) => { const o = { ...r }; delete o.updated_at; return o; });
      return { n: all.length, atDistinct: at.size, hash: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'),
        first: body[0] || null, last: body[body.length - 1] || null, owners: [...new Set(body.map((r) => String(r.owner_name).replace(/^node-\\d+/, '')))] };
    };
    const out = {};
    try { ${body} } catch (e) { out.err = String(e && e.stack || e); }
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  // ⚠ `node -e` 로 돌리지 말 것 — eval 모듈의 최상위 await 동안에는 setImmediate 탐침이 한 번도 돌지 않아(실측 0회) ③ 측정이 뜻을 잃는다.
  //   서버와 같은 '파일 모듈' 로 돌린다.
  const file = path.join(dir, 'child.mjs');
  fs.writeFileSync(file, script);
  const r = spawnSync(process.execPath, [file], {
    env: { ...process.env, CONFIG_DIR: dir, ...env }, encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${(r.stderr || '').slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-1000)} ${r.stderr.slice(-1000)}`);
  const o = JSON.parse(line.slice(2));
  assert.equal(o.err, undefined, o.err);
  return o;
}

// ── ① 워커 프로토콜 ─────────────────────────────────────────────────────────
function reply(worker, msg) {
  return new Promise((resolve, reject) => {
    const onMsg = (m) => { if (m.id === msg.id) { worker.off('message', onMsg); worker.off('error', reject); resolve(m); } };
    worker.on('message', onMsg); worker.once('error', reject);
    worker.postMessage(msg);
  });
}

test('① 워커 조각 프로토콜 — 조각은 잠금 없이 모으고 commit 에서만 한 트랜잭션 · 불일치·abort 는 쓰지 않는다 · 옛 메시지 호환', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerw2732d-'));
  const dbPath = path.join(dir, 'ipam.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE ip_records (${COLUMNS.map((c) => `${c} TEXT`).join(', ')});`);
  const worker = new Worker(new URL('../src/ipam/writeWorker.js', import.meta.url), { workerData: { dbPath } });
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM ip_records').get().n;
  const owners = () => db.prepare('SELECT owner_name FROM ip_records ORDER BY rowid').all().map((r) => r.owner_name);
  try {
    const at = '2026-10-10T00:00:00.000Z';
    const base = mkRows(5, '-old').map((r) => toRecord(r, at));
    assert.equal((await reply(worker, { id: 1, records: base })).ok, true, '옛 한 번 메시지(records)');
    assert.equal(count(), 5);

    const recs = mkRows(4500).map((r) => toRecord(r, at));
    worker.postMessage({ id: 2, chunk: recs.slice(0, 2000) });
    worker.postMessage({ id: 2, chunk: recs.slice(2000, 4000) });
    await new Promise((r) => setTimeout(r, 150));
    // 조각만 받은 동안 워커는 트랜잭션을 열지 않는다 — 다른 연결(외부 리더 자리)이 곧바로 쓰기 잠금을 얻는다(busy_timeout 0).
    const probe = new DatabaseSync(dbPath);
    probe.exec('PRAGMA busy_timeout=0');
    assert.doesNotThrow(() => { probe.exec('BEGIN IMMEDIATE'); probe.exec('ROLLBACK'); }, '조각 수신 중에 잠금을 쥐고 있다');
    probe.close();
    assert.equal(count(), 5, '조각만으로는 원장이 바뀌지 않는다');
    worker.postMessage({ id: 2, chunk: recs.slice(4000) });
    const ok2 = await reply(worker, { id: 2, commit: true, total: recs.length });
    assert.equal(ok2.ok, true, ok2.error);
    assert.equal(ok2.count, 4500);
    assert.equal(count(), 4500);
    assert.deepEqual(owners().slice(0, 3), ['node-0', 'node-1', 'node-2'], '조각 순서 그대로');
    assert.equal(owners()[4499], 'node-4499');

    // 개수 불일치 → 쓰지 않는다(일부만 쓴 원장 금지).
    worker.postMessage({ id: 3, chunk: recs.slice(0, 10) });
    const bad = await reply(worker, { id: 3, commit: true, total: 11 });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /불일치/);
    assert.equal(count(), 4500, '불일치 commit 이 원장을 바꿨다');

    // abort 는 모으던 조각을 버린다 — 뒤이은 commit 은 0개를 받아 쓰지 않는다.
    worker.postMessage({ id: 4, chunk: recs.slice(0, 10) });
    worker.postMessage({ id: 4, abort: true });
    const afterAbort = await reply(worker, { id: 4, commit: true, total: 10 });
    assert.equal(afterAbort.ok, false);
    assert.equal(count(), 4500);

    // 옛 rows + updatedAt 메시지도 그대로.
    assert.equal((await reply(worker, { id: 5, rows: mkRows(3, '-rows'), updatedAt: at })).ok, true);
    assert.deepEqual(owners(), ['node-0-rows', 'node-1-rows', 'node-2-rows']);
  } finally {
    await worker.terminate();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── ② 결과 동일성 ──────────────────────────────────────────────────────────
test('② 같은 행 — 인라인(예전 경로)과 워커 조각 경로의 ip_records 가 행 수·내용·순서까지 같다', () => {
  const body = `
    out.ok1 = await db.syncLedger(mkRows(9001));
    out.r1 = readDb();
    out.ok2 = await db.syncLedger(mkRows(1500, '-b'));
    out.r2 = readDb();
  `;
  const inline = runChild({ IPAM_WRITE_WORKER: '0' }, body);
  const chunked = runChild({}, body);
  for (const o of [inline, chunked]) { assert.equal(o.ok1, true); assert.equal(o.ok2, true); }
  assert.equal(chunked.r1.n, 9001);
  assert.equal(chunked.r1.atDistinct, 1, '한 동기화의 updated_at 은 하나');
  assert.deepEqual(chunked.r1, inline.r1, '9,001행(조각 5개) 적재 결과가 인라인과 다르다');
  assert.equal(chunked.r2.n, 1500, '두 번째 동기화가 전체를 갈아엎어야 한다');
  assert.deepEqual(chunked.r2, inline.r2);
});

// ── ③ 메인 최장 정지 · ④ 겹친 동기화 ─────────────────────────────────────────
test('③ 8만 행 동기화 중 메인 최장 정지 < 예전 동기 구간의 1/4 · ④ 겹친 동기화는 나중 내용이 남는다', (t) => {
  const o = runChild({}, `
    const { performance } = await import('node:perf_hooks');
    await db.syncLedger(mkRows(600, '-warm'));            // 워커 생성·DB 초기화는 측정에서 뺀다
    const rows = mkRows(80000);
    const gaps = []; const ticks = []; const totals = [];
    for (let k = 0; k < 2; k++) {
      let last = performance.now(); let maxGap = 0; let on = true; let n = 0;
      const tick = () => { n++; const now = performance.now(); if (now - last > maxGap) maxGap = now - last; last = now; if (on) setImmediate(tick); };
      setImmediate(tick);
      const t1 = performance.now();
      const ok = await db.syncLedger(rows);
      on = false;
      if (!ok) throw new Error('8만 행 동기화 실패');
      gaps.push(maxGap); ticks.push(n); totals.push(performance.now() - t1);
    }
    out.gaps = gaps; out.ticks = ticks; out.totals = totals;
    out.big = readDb().n;
    // 예전 경로의 동기 구간 = 변환(map) + 구조화 복제(postMessage 가 메인에서 직렬화한다).
    const t0 = performance.now();
    const recs = rows.map((r) => rec.toRecord(r, new Date().toISOString()));
    structuredClone(recs);
    out.baseline = performance.now() - t0;

    // ④-a 큰 A(워커 조각) 진행 중 작은 B(인라인 크기 < 500)
    const pA = db.syncLedger(mkRows(30000, '-A'));
    await new Promise((r) => setImmediate(r));
    const pB = db.syncLedger(mkRows(10, '-B'));
    out.a1 = await Promise.all([pA, pB]);
    out.after1 = readDb();
    // ④-b 큰 A 진행 중 워커 크기 B(조각 3개)
    const pA2 = db.syncLedger(mkRows(30000, '-A2'));
    await new Promise((r) => setImmediate(r));
    const pB2 = db.syncLedger(mkRows(5000, '-B2'));
    out.a2 = await Promise.all([pA2, pB2]);
    out.after2 = readDb();
  `);
  assert.equal(o.big, 80000);
  const best = Math.min(...o.gaps);
  t.diagnostic(`메인 최장 정지 ${o.gaps.map((g) => g.toFixed(1)).join('·')}ms(탐침 ${o.ticks.join('·')}회 · 동기화 ${o.totals.map((x) => x.toFixed(0)).join('·')}ms) · 예전 동기 구간(map + 구조화 복제) ${o.baseline.toFixed(1)}ms`);
  assert.ok(o.ticks.every((x) => x > 10), '탐침이 돌지 않았다 — 측정이 뜻이 없다');
  assert.ok(o.baseline > 20, `예전 동기 구간 기준이 너무 작다(${o.baseline.toFixed(1)}ms) — 측정이 뜻이 없다`);
  assert.ok(best < o.baseline / 4, `메인 최장 정지 ${best.toFixed(1)}ms(두 번 ${o.gaps.map((g) => g.toFixed(1)).join('·')}) ≥ 예전 동기 구간 ${o.baseline.toFixed(1)}ms 의 1/4`);

  assert.deepEqual(o.a1, [true, true]);
  assert.equal(o.after1.n, 10, `나중 B(10행)가 남아야 한다 — 남은 행 ${o.after1.n}`);
  assert.deepEqual(o.after1.owners, ['-B']);
  assert.deepEqual(o.a2, [true, true]);
  assert.equal(o.after2.n, 5000, `나중 B2(5,000행)가 남아야 한다 — 남은 행 ${o.after2.n}`);
  assert.deepEqual(o.after2.owners, ['-B2']);
});

// ── ⑤ 답하지 않는 워커 ─────────────────────────────────────────────────────
test('⑤ 워커가 답하지 않으면 시한 뒤 인라인으로 적재하고, 줄 서 있던 뒤 동기화도 끝난다', () => {
  const o = runChild({}, `
    const fs = await import('node:fs'); const { pathToFileURL } = await import('node:url');
    const fake = path.join(CFG, 'silentWorker.mjs');
    fs.writeFileSync(fake, "import { parentPort } from 'node:worker_threads'; parentPort.on('message', () => {});");
    db._setWriteWorkerUrlForTest(pathToFileURL(fake));
    db._setWriteReplyDeadlineForTest(300);
    const t0 = Date.now();
    const pX = db.syncLedger(mkRows(3000, '-X'));
    const pY = db.syncLedger(mkRows(700, '-Y'));
    out.r = await Promise.all([pX, pY]);
    out.ms = Date.now() - t0;
    out.after = readDb();
  `, { timeoutMs: 30_000 });
  assert.deepEqual(o.r, [true, true], '시한 뒤 인라인 적재로 성공해야 한다');
  assert.ok(o.ms < 15_000, `시한(0.3초)이 걸렸어야 한다 — ${o.ms}ms`);
  assert.equal(o.after.n, 700);
  assert.deepEqual(o.after.owners, ['-Y'], '줄 서 있던 나중 동기화의 내용이 남는다');
});

// ── ⑥ 조각을 받다 죽는 워커 ─────────────────────────────────────────────────
test('⑥ 조각 전송 도중 워커가 죽으면 남은 조각을 보내지 않고 인라인으로 적재한다', () => {
  const o = runChild({}, `
    const fs = await import('node:fs'); const { pathToFileURL } = await import('node:url');
    const fake = path.join(CFG, 'dyingWorker.mjs');
    fs.writeFileSync(fake, "import { parentPort } from 'node:worker_threads'; parentPort.once('message', () => process.exit(3));");
    db._setWriteWorkerUrlForTest(pathToFileURL(fake));
    out.ok = await db.syncLedger(mkRows(9000, '-D'));
    out.after = readDb();
    out.ok2 = await db.syncLedger(mkRows(800, '-E'));   // 이후는 인라인(죽은 워커를 다시 띄우지 않는다)
    out.after2 = readDb();
  `, { timeoutMs: 60_000 });
  assert.equal(o.ok, true);
  assert.equal(o.after.n, 9000);
  assert.deepEqual(o.after.owners, ['-D']);
  assert.equal(o.ok2, true);
  assert.equal(o.after2.n, 800);
});
