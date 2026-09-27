// v2.629 감사 수정 그룹 b — 범위 관리자 차단(AUTHZ2629-02·04·05·06·07·08) · svcmon XLSX 압축 해제 상한(SEC2629-09).
// 실제 라우터를 express 에 띄워 상태코드로 본다(소스 grep 이 아니다).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2629b-'));
process.env.CONFIG_DIR = TMP;
process.env.AUTH_ENABLED = 'true';

const { dirPathIssue } = await import('../src/util/dirPathGuard.js');
const { zipDeclaredSize, assertXlsxSizeOk, XLSX_MAX_UNCOMPRESSED } = await import('../src/svcmon/formats.js');
const { scopeVcLogStatus } = await import('../src/routes/admin/backupNetSec.js');

const SCOPED_ADMIN = { username: 'scadmin', role: 'admin', scope: { vcenters: ['vc-us-east'] } };
const FULL_ADMIN = { username: 'fulladmin', role: 'admin' };

let server; let base; let who = null;
before(async () => {
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const { api } = await import('../src/routes/api.js');
  const { insightsRouter } = await import('../src/routes/insights.js');
  const { pingRouter } = await import('../src/routes/ping.js');
  const { svcmonRouter } = await import('../src/routes/svcmon.js');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use((req, _res, next) => { req.user = who; next(); });
  app.use('/api/admin', adminRouter);
  app.use('/api/insights', insightsRouter);
  app.use('/api/ping', pingRouter);
  app.use('/api/svcmon', svcmonRouter);
  app.use('/api', api);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => { try { server?.close(); } catch { /* */ } try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

async function call(method, p, body) {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* */ }
  return { status: r.status, body: j };
}

test('AUTHZ2629-02·04·06·07·08: 범위 관리자는 403(전체 범위 사유) — 전 법인 공용 변경·자기진단 조회', async () => {
  who = SCOPED_ADMIN;
  const cases = [
    ['PUT', '/svcmon/log', { keepFiles: 1 }], ['POST', '/svcmon/log/prune'], ['POST', '/svcmon/flush'],
    ['PUT', '/insights/finops/config', { tariffPerKwh: 0, pue: 5 }],
    ['GET', '/admin/codex-check'], ['GET', '/admin/codex-check/file'], ['GET', '/admin/portal-db'],
    ['GET', '/admin/portal-db/health'], ['GET', '/admin/portal-db/location'], ['GET', '/admin/security/self-check'],
    ['GET', '/tools/secret-scan'], ['POST', '/ping/edge/sync'], ['GET', '/admin/api-keys'],
  ];
  for (const [m, p, b] of cases) {
    const r = await call(m, p, b);
    assert.equal(r.status, 403, `${m} ${p} → ${r.status}`);
    assert.match(r.body?.reason || '', /전체 범위/, `${m} ${p}`);
  }
});

test('AUTHZ2629-02·04·06·07·08: 전체 범위 관리자는 그대로 쓴다', async () => {
  who = FULL_ADMIN;
  for (const [m, p, b] of [
    ['PUT', '/svcmon/log', { keepFiles: 30 }], ['POST', '/svcmon/log/prune'], ['POST', '/svcmon/flush'],
    ['PUT', '/insights/finops/config', { pue: 1.5 }], ['GET', '/admin/portal-db/location'],
    ['GET', '/admin/security/self-check'], ['POST', '/ping/edge/sync'], ['GET', '/admin/api-keys'],
  ]) {
    const r = await call(m, p, b);
    assert.equal(r.status, 200, `${m} ${p} → ${r.status} ${JSON.stringify(r.body)}`);
  }
  // FinOps 저장은 감사에 남는다
  const audit = fs.readFileSync(path.join(TMP, 'audit.ndjson'), 'utf8');
  assert.match(audit, /insights\.finops\.config/);
});

test('AUTHZ2629-02: svcmon 로그 경로는 시스템 디렉터리·상위 경로·상대 경로를 거부한다(전체 범위여도)', async () => {
  who = FULL_ADMIN;
  const existedBefore = fs.existsSync('/etc/svcmon');   // 환경에 이미 있으면(다른 실행의 잔재) 이 요청이 만든 것이 아니다
  for (const dp of ['/etc/svcmon', '/usr//lib/x', '/var/../etc/x', 'relative/dir', '/tmp/a\u0001b']) {
    const r = await call('PUT', '/svcmon/log', { dirPath: dp });
    assert.equal(r.status, 400, `${dp} → ${r.status}`);
    assert.match(r.body?.error || '', /로그 경로/);
  }
  if (!existedBefore) assert.ok(!fs.existsSync('/etc/svcmon'), '거부된 경로에 디렉터리를 만들었다');
  const ok = await call('PUT', '/svcmon/log', { dirPath: path.join(TMP, 'svclog') });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('AUTHZ2629-02: dirPathIssue — vclogs 와 같은 규칙(빈 값은 문제 아님)', () => {
  assert.equal(dirPathIssue(''), '');
  assert.equal(dirPathIssue(undefined), '');
  assert.equal(dirPathIssue('/data/logs'), '');
  assert.equal(dirPathIssue('/etc'), '시스템 디렉터리 불가');
  assert.equal(dirPathIssue('//proc/1'), '시스템 디렉터리 불가');
  assert.equal(dirPathIssue('/data/../etc'), '상위 경로(..) 불가');
  assert.equal(dirPathIssue('data'), '절대경로여야 합니다');
  assert.equal(dirPathIssue('/a\nb'), '제어문자');
});

test('AUTHZ2629-05: vclogs 상태 — 범위 계정은 범위 안 vCenter 만 · 합계 재계산 · 경로·타 법인 정지 목록 가림', async () => {
  const st = {
    settings: { enabled: true, storagePath: '/data/vclogs' },
    lastRun: { at: 1, collected: 999, authStopped: ['vc-us-east', 'vc-kr'] },
    store: { count: 30, firstTs: 5, lastTs: 90, vcenters: [
      { vcenterId: 'vc-us-east', count: 10, lastTs: 50 }, { vcenterId: 'vc-kr', count: 20, lastTs: 90 },
    ] },
    dbKind: 'sqlite', dbPath: '/data/vclogs/vcenter-logs.db', dbSizeBytes: 100,
  };
  const out = scopeVcLogStatus(st, new Set(['vc-us-east']));
  assert.deepEqual(out.store.vcenters.map((v) => v.vcenterId), ['vc-us-east']);
  assert.equal(out.store.count, 10);
  assert.equal(out.store.lastTs, 50);
  assert.equal(out.store.firstTs, null);
  assert.equal(out.store.omittedOutOfScope, 1);
  assert.deepEqual(out.lastRun.authStopped, ['vc-us-east']);
  assert.equal(out.lastRun.authStoppedOmitted, 1);
  assert.equal(out.lastRun.collected, null);
  assert.equal(out.dbPath, null);
  assert.equal(out.settings.storagePath, '');
  assert.equal(out.pathHidden, true);
  assert.ok(!JSON.stringify(out).includes('vc-kr'), '범위 밖 vCenter id 가 남으면 안 된다');
  assert.ok(!JSON.stringify(out).includes('/data/vclogs'), '경로가 남으면 안 된다');
  assert.strictEqual(scopeVcLogStatus(st, null), st, '전체 범위는 원본 그대로');
  // 라우트: 범위 계정 응답에 경로가 없다 · 전체 범위는 경로가 있다
  who = SCOPED_ADMIN;
  const r = await call('GET', '/admin/vclogs/status');
  assert.equal(r.status, 200);
  assert.equal(r.body.pathHidden, true);
  assert.equal(r.body.dbPath, null);
  who = FULL_ADMIN;
  const f = await call('GET', '/admin/vclogs/status');
  assert.equal(f.status, 200);
  assert.ok(!f.body.pathHidden);
});

/* ── SEC2629-09: 작은 합성 zip 헤더로 선언 크기를 본다(큰 파일로 시험하지 않는다) ── */
function crc32(b) { return zlib.crc32 ? zlib.crc32(b) : 0; }
function zipOf(entries) {
  // entries: [{ name, data?, declared? }] — declared 가 있으면 중앙 디렉터리의 uncompressedSize 를 그 값으로 쓴다
  const locals = []; const cds = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name); const data = e.data || Buffer.alloc(0);
    const comp = zlib.deflateRawSync(data);
    const usize = e.declared ?? data.length;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(data) >>> 0, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(usize >>> 0, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc32(data) >>> 0, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(usize >>> 0, 24); cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(off, 42);
    cds.push(cd, name);
    off += 30 + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(cds);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

test('SEC2629-09: zipDeclaredSize 는 중앙 디렉터리의 선언 크기 합을 읽는다', () => {
  const z = zipDeclaredSize(zipOf([{ name: 'a.xml', data: Buffer.from('hello') }, { name: 'b.xml', data: Buffer.alloc(1000) }]));
  assert.deepEqual(z, { ok: true, entries: 2, total: 1005 });
  assert.equal(zipDeclaredSize(Buffer.from('not a zip at all, definitely not')).reason, 'no-eocd');
  assert.equal(zipDeclaredSize(zipOf([{ name: 'x', declared: 0xffffffff }])).reason, 'zip64');
  assert.equal(zipDeclaredSize(zipOf([{ name: 'a' }, { name: 'b' }]), { maxEntries: 1 }).reason, 'too-many-entries');
});

test('SEC2629-09: 선언 압축 해제 크기가 상한을 넘으면 exceljs 로드 전에 거부한다', async () => {
  // 실제 데이터는 몇 바이트 — 선언만 크다(합성 헤더). 큰 버퍼를 만들지 않는다.
  const bomb = zipOf([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.from('x'), declared: XLSX_MAX_UNCOMPRESSED + 1 }]);
  assert.throws(() => assertXlsxSizeOk(bomb), /압축 해제 크기가 너무 큽니다/);
  assert.doesNotThrow(() => assertXlsxSizeOk(zipOf([{ name: 'a', data: Buffer.from('ok') }])));
  // 라우트 경로(hostmap/parse) — 400 + 사유
  who = FULL_ADMIN;
  const r = await call('POST', '/svcmon/targets/hostmap/parse', { format: 'xlsx', content: bomb.toString('base64') });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body?.error || '', /압축 해제 크기/);
});

test('SEC2629-09: 정상 xlsx(exceljs 가 쓴 파일)는 그대로 통과한다', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('s');
  ws.addRow(['name', 'ip']); ws.addRow(['host-a', '10.0.0.1']);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const z = assertXlsxSizeOk(buf);
  assert.ok(z.total > 0 && z.total < XLSX_MAX_UNCOMPRESSED);
  who = FULL_ADMIN;
  const r = await call('POST', '/svcmon/targets/hostmap/parse', { format: 'xlsx', content: buf.toString('base64') });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pairs.length, 1);
});
