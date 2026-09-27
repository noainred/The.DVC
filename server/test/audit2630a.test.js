// v2.630 감사 수정 그룹 a — XLSX 실제 해제 상한(SEC2630-01) · 로그 연합 조회 입력 좁히기(SEC2630-02) ·
// IPAM 일괄 적용의 기존 claim 판정(AUTHZ2630-01) · 범위 관리자 vCenter 연결 테스트 접속처 고정(AUTHZ2630-02) ·
// Windows 드라이브 절대경로(R2630-04). 라우트는 실제 라우터를 express 에 띄워 상태코드로 본다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2630a-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

// 연결 테스트가 어디로 로그인하는지 보는 가짜 vCenter 두 개(저장값 = savedTrap, 요청 본문이 바꾸려는 곳 = otherTrap).
const hits = { saved: 0, other: 0 };
const mkTrap = (k) => http.createServer((_q, r) => { hits[k] += 1; r.statusCode = 401; r.end('no'); });
const savedTrap = mkTrap('saved');
const otherTrap = mkTrap('other');
await new Promise((r) => savedTrap.listen(0, '127.0.0.1', r));
await new Promise((r) => otherTrap.listen(0, '127.0.0.1', r));
fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: 'vc-a', name: 'A', host: `http://127.0.0.1:${savedTrap.address().port}`, username: 'u', password: 'p' },
  { id: 'vc-b', name: 'B', host: 'https://10.9.9.2', username: 'u', password: 'p' },
] }));

const { dirPathIssue } = await import('../src/util/dirPathGuard.js');
const { assertXlsxSizeOk, zipInflatedSize, serializeTargets, parseHostMapAny } = await import('../src/svcmon/formats.js');

const USERS = {
  full: { username: 'full', role: 'admin' },
  opA: { username: 'opA', role: 'operator', scope: { vcenters: ['vc-a'] } },
  op: { username: 'op', role: 'operator' },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-a'] } },
};
let server; let base;
before(async () => {
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const { api } = await import('../src/routes/api.js');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api/admin', adminRouter);
  app.use('/api', api);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => {
  for (const s of [server, savedTrap, otherTrap]) { try { s?.close(); } catch { /* */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});

async function call(u, method, p, body) {
  const r = await fetch(`${base}${p}`, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* */ }
  return { status: r.status, body: j };
}

/** 최소 zip 작성기 — lie 면 중앙 디렉터리·로컬 헤더의 해제 크기를 100 으로 거짓 선언한다. */
function zipOf(entries, { lie = false } = {}) {
  const locals = []; const cds = []; let off = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name); const comp = zlib.deflateRawSync(data, { level: 9 });
    const us = lie ? 100 : data.length;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(us, 22); lh.writeUInt16LE(n.length, 26);
    locals.push(lh, n, comp);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(us, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(off, 42);
    cds.push(cd, n); off += 30 + n.length + comp.length;
  }
  const cdb = Buffer.concat(cds); const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10);
  e.writeUInt32LE(cdb.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cdb, e]);
}

test('SEC2630-01: 선언 크기를 속인 zip 도 실제 해제 누적이 상한을 넘으면 거부한다(끝까지 풀지 않는다)', () => {
  const MB = 1024 * 1024;
  const bomb = zipOf([['[Content_Types].xml', Buffer.from('<Types/>')], ['xl/sharedStrings.xml', Buffer.alloc(3 * MB, 0x20)]], { lie: true });
  assert.ok(bomb.length < 64 * 1024, `폭탄은 작아야 한다(${bomb.length})`);
  const r = zipInflatedSize(bomb, 1 * MB);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too-large');
  assert.throws(() => assertXlsxSizeOk(bomb, 1 * MB), /실제 해제/);
  // 같은 폭탄도 상한 안이면 통과하고 실제 크기를 센다(선언 200 이 아니라 3MB + 8)
  const ok = zipInflatedSize(bomb, 4 * MB);
  assert.equal(ok.ok, true);
  assert.equal(ok.total, 3 * MB + 8);
  // 여러 항목의 누적도 센다(각각은 상한 안)
  const many = zipOf([['a.xml', Buffer.alloc(600 * 1024, 0x20)], ['b.xml', Buffer.alloc(600 * 1024, 0x20)]], { lie: true });
  assert.equal(zipInflatedSize(many, 1 * MB).reason, 'too-large');
  // 지원하지 않는 압축 방식·깨진 항목
  const broken = Buffer.from(bomb); broken.writeUInt32LE(0xdeadbeef, 0); // 첫 로컬 헤더 서명 파손
  assert.equal(zipInflatedSize(broken, 4 * MB).reason, 'bad-entry');
});

test('SEC2630-01: 정상 xlsx 는 그대로 통과한다(exceljs 산출물 왕복)', async () => {
  const buf = await serializeTargets([], 'xlsx');
  const z = assertXlsxSizeOk(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  assert.ok(z.inflated > 0 && z.inflated === z.total, `선언 ${z.total} · 실제 ${z.inflated}`);
  const r = await parseHostMapAny(Buffer.isBuffer(buf) ? buf : Buffer.from(buf), 'xlsx');
  assert.ok(Array.isArray(r.pairs));
});

test('SEC2630-02: 연합 조회는 이 포탈이 아는 vCenter 만 · 검색어 길이 상한', async () => {
  let r = await call('op', 'POST', '/tools/vclogs/federate', { vcenterId: 'nx-0', q: 'a' });
  assert.equal(r.status, 404, '등록부에 없는 id 는 큐에 올리지 않는다');
  r = await call('op', 'POST', '/tools/vclogs/federate', { vcenterId: 'vc-a', q: 'x'.repeat(501) });
  assert.equal(r.status, 400);
  r = await call('op', 'POST', '/tools/vclogs/federate', { vcenterId: 'vc-a', q: { toString: 1 } });
  assert.equal(r.status, 200, '문자열이 아닌 q 는 빈 검색어');
  r = await call('op', 'POST', '/tools/vclogs/federate', { vcenterId: 'vc-a', severity: 'y'.repeat(40) });
  assert.equal(r.status, 400);
  r = await call('op', 'POST', '/tools/vclogs/federate', { vcenterId: 'vc-a', q: 'error', since: 'abc', limit: -5 });
  assert.equal(r.status, 200);
  const lq = await import('../src/central/logQueries.js');
  const taken = lq.takeLogQueries(['vc-a']);
  const last = taken[taken.length - 1];
  assert.equal(last.filter.q, 'error');
  assert.equal(last.filter.since, 0);
  assert.equal(last.filter.limit, 200);
});

test('AUTHZ2630-01: 범위 계정의 IPAM 일괄 적용도 기존 claim 으로 먼저 판정한다(단건 PUT 과 같다)', async () => {
  const IP = '172.31.250.7';
  let r = await call('full', 'PUT', `/tools/ipam/ip/${IP}`, { status: 'reserved', owner: 'B-team', claimedVcenterId: 'vc-b' });
  assert.equal(r.status, 200);
  assert.equal((await call('opA', 'PUT', `/tools/ipam/ip/${IP}`, { owner: 'hijack', claimedVcenterId: 'vc-a' })).status, 404);
  r = await call('opA', 'POST', '/tools/ipam/bulk', { ips: [IP], owner: 'hijack', claimedVcenterId: 'vc-a' });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  // 문자열 ips 도 같은 판정을 거친다(적용 목록과 검사 목록이 같다)
  r = await call('opA', 'POST', '/tools/ipam/bulk', { ips: `${IP}, 172.31.250.8`, owner: 'hijack', claimedVcenterId: 'vc-a' });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  const after2 = await call('full', 'GET', `/tools/ipam/ip/${IP}`);
  assert.equal(after2.body.override.owner, 'B-team');
  assert.equal(after2.body.override.claimedVcenterId, 'vc-b');
  // 자기 범위의 새 예약은 여전히 된다
  r = await call('opA', 'POST', '/tools/ipam/bulk', { ips: ['172.31.250.9'], status: 'reserved', claimedVcenterId: 'vc-a' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.changed, 1);
});

test('AUTHZ2630-02: 범위 관리자의 연결 테스트는 저장된 접속처로만(body.host 무시)', async () => {
  hits.saved = 0; hits.other = 0;
  const otherHost = `http://127.0.0.1:${otherTrap.address().port}`;
  const r = await call('sadm', 'POST', '/admin/vcenters/test', { id: 'vc-a', host: otherHost, username: 'u', password: 'p' });
  assert.equal(r.status, 200);
  assert.equal(hits.other, 0, '본문 host 로 로그인하면 안 된다');
  assert.ok(hits.saved >= 1, '저장된 host 로 시험한다');
  assert.equal((await call('sadm', 'POST', '/admin/vcenters/test', { host: otherHost, username: 'u', password: 'p' })).status, 403);
  // 전체 범위 관리자는 새 접속처 시험 가능(기존 동작)
  hits.other = 0;
  await call('full', 'POST', '/admin/vcenters/test', { host: otherHost, username: 'u', password: 'p' });
  assert.ok(hits.other >= 1);
});

test('R2630-04: Windows 에서 드라이브 절대경로를 받고 시스템 디렉터리는 거부한다', () => {
  const W = { platform: 'win32' };
  assert.equal(dirPathIssue('D:\\svcmon-logs', W), '');
  assert.equal(dirPathIssue('D:/logs/svcmon', W), '');
  assert.equal(dirPathIssue('C:\\Windows\\Temp', W), '시스템 디렉터리 불가');
  assert.equal(dirPathIssue('c:/windows', W), '시스템 디렉터리 불가');
  assert.equal(dirPathIssue('C:\\Program Files\\x', W), '시스템 디렉터리 불가');
  assert.equal(dirPathIssue('C:\\Program Files (x86)', W), '시스템 디렉터리 불가');
  assert.equal(dirPathIssue('D:\\a\\..\\Windows', W), '상위 경로(..) 불가');
  assert.equal(dirPathIssue('\\\\srv\\share', W), '절대경로여야 합니다');
  assert.equal(dirPathIssue('D:', W), '절대경로여야 합니다');
  // 리눅스에서는 드라이브 표기가 상대경로다(예전 그대로 거부)
  assert.equal(dirPathIssue('D:\\logs', { platform: 'linux' }), '절대경로여야 합니다');
  assert.equal(dirPathIssue('/etc', { platform: 'linux' }), '시스템 디렉터리 불가');
  assert.equal(dirPathIssue('/data/logs', { platform: 'linux' }), '');
});
