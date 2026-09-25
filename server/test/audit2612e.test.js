/**
 * v2.612 감사 그룹 E — 스캔·배포·ping·SFTP·파트 장애 키 이관.
 *   RECENT2612-03 임시 스캔은 인증 실패를 기록하지 않고, 옛 scan|adhoc|* 기록을 1회 지운다
 *   LEFT2612-02  스캔 대역 CSV 가져오기는 saveScanRanges 의 필드별 사유를 싣고 iLO 는 CSV 로 못 넣는다고 말한다
 *   RECENT2612-05 엣지 배포 GPU 게스트 PUT 도 droppedSecrets 를 돌려준다
 *   LEFT2612-05  ping meta 는 aggregate 하나씩(건수 null)
 *   DB2612-02    롤업 시드 중 rowid 재사용 행을 두 번 세지 않는다
 *   LEFT2612-07  sftpReadFile 크기 상한
 *   LEFT2612-04  장비 키만 바뀐 같은 장애는 이관(옛 행 key-migrated, 재알림 없음)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2612e-'));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const url = (p) => JSON.stringify(pathToFileURL(path.join(SRC, p)).href);

function child(code, env = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'c-'));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 180_000,
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', ...env },
  });
  assert.equal(r.status, 0, `자식 실패: ${(r.stderr || '').slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-800)} ${r.stderr.slice(-800)}`);
  return { out: JSON.parse(line.slice(2)), dir };
}

test('RECENT2612-03: 임시 스캔(record:false)은 기록하지 않고, 옛 scan|adhoc|* 기록은 1회 지운다(대역 기록은 남긴다)', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'sa-'));
  fs.writeFileSync(path.join(dir, 'idrac-scan-auth-stops.json'), JSON.stringify({
    'scan|adhoc|10.9.0.1': { credHash: 'x', since: 1, at: 1, attempts: 1, reason: 'r' },
    'scan|adhoc|10.9.0.2': { credHash: 'x', since: 1, at: 1, attempts: 1, reason: 'r' },
    'scan|r1|10.9.0.3': { credHash: 'x', since: 1, at: 1, attempts: 1, reason: 'r' },
  }));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const m = await import(${url('idrac/scanAuth.js')});
    const p = m.makeScanAuthPolicy({ rangeId: 'adhoc', username: 'root', password: 'pw', periodic: false, record: false });
    for (let i = 0; i < 20; i++) p.noteAuthFailed('10.8.0.' + i, '401');
    p.flush();
    const q = m.makeScanAuthPolicy({ rangeId: 'r2', username: 'root', password: 'pw', periodic: false });
    q.noteAuthFailed('10.7.0.1', '401'); q.flush();
    console.log('@@' + JSON.stringify(Object.keys(JSON.parse((await import('node:fs')).readFileSync(${JSON.stringify(path.join(dir, 'idrac-scan-auth-stops.json'))}, 'utf8'))).sort()));
  `], { encoding: 'utf8', env: { ...process.env, CONFIG_DIR: dir } });
  assert.equal(r.status, 0, r.stderr);
  const keys = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('@@')).slice(2));
  assert.deepEqual(keys, ['scan|r1|10.9.0.3', 'scan|r2|10.7.0.1'], '임시 스캔 기록 0 · 옛 adhoc 정리 · 대역 기록 유지');
  const route = fs.readFileSync(path.join(SRC, 'routes/admin/idracScan.js'), 'utf8');
  assert.match(route, /makeScanAuthPolicy\(\{ rangeId: 'adhoc'[^}]*record: false/, '라우트가 record:false 를 넘긴다');
});

const HARNESS = (body) => `
  const SRC = ${JSON.stringify(SRC + '/')};
  const express = (await import('express')).default;
  const { adminRouter } = await import(SRC + 'routes/admin.js');
  const app = express(); app.use(express.json({ limit: '5mb' }));
  app.use((req, _r, n) => { req.user = { username: 'full', role: 'admin', scope: null }; n(); });
  app.use('/api/admin', adminRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const call = async (method, p, b) => {
    const r = await fetch(base + '/api' + p, { method, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 300); }
    return { s: r.status, j };
  };
  const out = {};
  try { ${body} } catch (e) { out.err = String(e && e.stack || e); } finally { srv.close(); }
  console.log('@@' + JSON.stringify(out));
  process.exit(0);
`;

test('LEFT2612-02: CSV 가져오기의 비밀번호 폐기 사유는 필드별(iLO 만 폐기면 Dell 폐기·스캔 보류라 말하지 않는다) + CSV 로 iLO 를 못 넣는다', () => {
  const { out } = child(HARNESS(`
    const dc = await call('POST', '/admin/datacenters', { id: 'dc1', name: 'DC1' });
    const dcId = dc.j?.datacenter?.id || dc.j?.id || (dc.j?.datacenters || []).find((d) => d.name === 'DC1')?.id;
    out.dcS = dc.s; out.dcId = dcId;
    out.save = (await call('PUT', '/admin/idrac/scan-ranges', { datacenterId: dcId, service: 'svc', ranges: ['10.20.0.0/30'], username: 'root', password: 'dellpw', iloUsername: 'Administrator', iloPassword: 'ilopw' })).s;
    const csv = 'datacenter,service,ranges,username,agent,dispatch,enabled,mode,password\\nDC1,svc,10.20.1.0/30,root,,,true,,newdellpw\\n';
    const r = await call('POST', '/admin/idrac/scan-ranges/import', { csv, overwrite: true });
    out.imp = r.j;
  `));
  assert.equal(out.err, undefined, out.err);
  assert.equal(out.save, 200, JSON.stringify(out));
  const pd = out.imp?.passwordDropped || [];
  assert.equal(pd.length, 1, JSON.stringify(out.imp));
  assert.deepEqual(pd[0].fields, ['iloPassword']);
  assert.match(pd[0].reason, /iLO 비밀번호를 폐기/);
  assert.match(pd[0].reason, /CSV 로 넣을 수 없습니다/);
  assert.doesNotMatch(pd[0].reason, /그 전까지 스캔 보류/, '고정 문구(Dell 폐기·스캔 보류)를 쓰지 않는다');
});

test('RECENT2612-05: 엣지 배포 GPU 게스트 PUT — 계정명만 바꾸면 비밀번호를 승계하지 않고 droppedSecrets 로 밝힌다', () => {
  const { out } = child(HARNESS(`
    out.a = (await call('PUT', '/admin/gpu-guest/deploy/edge1', { vcenters: { vc1: { enabled: true, username: 'u1', password: 'p1' } } })).j;
    out.b = (await call('PUT', '/admin/gpu-guest/deploy/edge1', { vcenters: { vc1: { username: 'u2' } } })).j;
  `));
  assert.equal(out.err, undefined, out.err);
  assert.equal(out.a.droppedSecrets, undefined, '첫 저장은 폐기 없음');
  assert.ok(Array.isArray(out.b.droppedSecrets) && out.b.droppedSecrets.length > 0, JSON.stringify(out.b));
});

test('LEFT2612-05: ping meta 는 MIN·MAX 를 따로 묻고 건수는 null(첫/끝 시각은 그대로)', () => {
  const file = path.join(TMP, 'meta-ping.db');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { getPingDb } = await import(${url('ping/db.js')});
    const db = await getPingDb();
    db.insertMany([{ target: 't', ts: 1000, rtt: 1, ok: true }, { target: 't', ts: 5000, rtt: 2, ok: true }, { target: 'u', ts: 9000, rtt: 2, ok: true }]);
    console.log('@@' + JSON.stringify([db.meta('t'), db.meta('zz')]));
  `], { encoding: 'utf8', env: { ...process.env, PING_DB_PATH: file } });
  assert.equal(r.status, 0, r.stderr);
  const [m, none] = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('@@')).slice(2));
  assert.deepEqual(m, { firstTs: 1000, lastTs: 5000, count: null });
  assert.deepEqual(none, { firstTs: null, lastTs: null, count: null });
  const src = fs.readFileSync(path.join(SRC, 'ping/db.js'), 'utf8');
  assert.doesNotMatch(src, /SELECT MIN\(ts\) mn, MAX\(ts\) mx, COUNT\(\*\)/, '세 aggregate 를 한 문장에 두지 않는다');
});

test('DB2612-02: 시드 중 최상위 행이 지워진 뒤 적재된 행(rowid 재사용)을 시드가 다시 세지 않는다', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.join(TMP, 'seed-ping.db');
  const T0 = Date.UTC(2026, 0, 5, 10, 30);
  { const d = new DatabaseSync(file);
    d.exec('CREATE TABLE samples (target TEXT NOT NULL, ts INTEGER NOT NULL, rtt REAL, ok INTEGER NOT NULL)');
    d.exec('CREATE TABLE ping_meta (k TEXT PRIMARY KEY, v TEXT)');
    const ins = d.prepare('INSERT INTO samples (rowid, target, ts, rtt, ok) VALUES (?,?,?,?,?)');
    for (let j = 1; j <= 10; j++) ins.run(j, 'a', T0 + j * 1000, 5, 1);                // 첫 청크(0,50000]
    for (let j = 60001; j <= 60004; j++) ins.run(j, 'b', T0 + (j - 60000) * 1000, 5, 1); // 둘째 청크
    for (let j = 60005; j <= 60010; j++) ins.run(j, 'c', T0 + (j - 60000) * 1000, 5, 1); // 최상위 — 시드 중 지워진다
    d.close(); }
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { DatabaseSync } = await import('node:sqlite');
    const { getPingDb } = await import(${url('ping/db.js')});
    const db = await getPingDb();            // 첫 청크만 동기로 돌고 둘째 청크는 양보 뒤
    const other = new DatabaseSync(${JSON.stringify(file)});
    other.exec("DELETE FROM samples WHERE target='c'");   // 최상위 rowid 가 사라진다
    other.close();
    db.insertMany([{ target: 'b', ts: ${T0} + 20000, rtt: 9, ok: true }]);   // rowid 60005 재사용 — 시드 경계 안
    await db._rollupSeed();
    const raw = db.history('b', ${T0} - 3600000, 3600000, 100).reduce((s, x) => s + x.n, 0);
    const hr = db.historyHourly('b', ${T0} - 3600000, 3600000, 100).reduce((s, x) => s + x.n, 0);
    console.log('@@' + JSON.stringify({ raw, hr, ready: db.rollupState().ready }));
  `], { encoding: 'utf8', env: { ...process.env, PING_DB_PATH: file } });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('@@')).slice(2));
  assert.equal(o.ready, true);
  assert.equal(o.raw, 5);
  assert.equal(o.hr, 5, `롤업 ${o.hr} ≠ 원시 ${o.raw} — 재사용 rowid 가 두 번 세였다`);
});

function fakeConn({ size, content }) {
  const sftp = {
    stat: (_p, cb) => setImmediate(() => cb(null, { size })),
    createReadStream: (_p, { end } = {}) => {
      const rs = new EventEmitter();
      let destroyed = false; rs.destroy = () => { destroyed = true; rs.emit('close'); };
      setImmediate(() => {
        const limit = end == null ? content.length : Math.min(content.length, end + 1);
        for (let i = 0; i < limit && !destroyed; i += 1024) rs.emit('data', content.subarray(i, Math.min(limit, i + 1024)));
        if (!destroyed) { rs.emit('end'); rs.emit('close'); }
      });
      return rs;
    },
    readFile: () => { throw new Error('readFile 전량 읽기는 쓰지 않는다'); },
  };
  return { sftp: (cb) => cb(null, sftp) };
}

test('LEFT2612-07: sftpReadFile — stat 이 상한을 넘으면 읽지 않고, stat 이 작아도 실제로 자라면 상한에서 끊는다', async () => {
  const { _sftpReadFileForTest: read } = await import(pathToFileURL(path.join(SRC, 'proxy/sshExec.js')).href);
  assert.equal(await read(fakeConn({ size: 5, content: Buffer.from('hello') }), '/x', { maxBytes: 100 }), 'hello');
  await assert.rejects(read(fakeConn({ size: 5000, content: Buffer.alloc(5000, 65) }), '/x', { maxBytes: 100 }), /상한/);
  await assert.rejects(read(fakeConn({ size: 10, content: Buffer.alloc(5000, 65) }), '/x', { maxBytes: 100 }), /상한/);
});

test('LEFT2612-04: 장비 키만 바뀐 같은 부품 — 옛 키 행은 key-migrated 로 닫고 새 키는 처음 본 시각을 잇고 다시 알리지 않는다', async () => {
  const { transition } = await import(pathToFileURL(path.join(SRC, 'partfault/transition.js')).href);
  const { makePart } = await import(pathToFileURL(path.join(SRC, 'partfault/types.js')).href);
  const base = { scope: 'idrac', deviceId: '10.0.0.5', kind: 'psu', partId: 'PSU 2', keyKind: 'name' };
  const oldP = makePart({ ...base, deviceKey: 'SKU-P123', state: 'fault' });
  const open = [{ ...oldP, agent: '', firstSeenAt: 111, lastSeenAt: 222 }];
  const newP = makePart({ ...base, deviceKey: 'SN0001', state: 'fault' });
  const scan = { deviceOk: { '|10.0.0.5': true } };
  const tr = transition({ open, observed: [newP], scan, now: 1000 });
  assert.equal(tr.opened.length, 1);
  assert.equal(tr.opened[0].migratedFrom, oldP.partKey);
  assert.equal(tr.opened[0].firstSeenAt, 111, '처음 본 시각을 잇는다');
  assert.equal(tr.closed.length, 1);
  assert.equal(tr.closed[0].closeReason, 'key-migrated');
  assert.equal(tr.held.length, 0, '옛 키가 missing 으로 남지 않는다');
  assert.equal(tr.stats.keyMigrated, 1);

  // 알림: 같은 상태의 이관은 보내지 않는다(sendAlert 를 부르지 않으므로 total 0)
  const { notifyTransition } = await import(pathToFileURL(path.join(SRC, 'partfault/notify.js')).href);
  const n = await notifyTransition(tr);
  assert.equal(n.total, 0, '키 이관은 새 사건이 아니다');

  // 새 키가 ok 면 옛 장애는 복구(ok)로 닫힌다 — key-migrated 가 아니다
  const tr2 = transition({ open, observed: [makePart({ ...base, deviceKey: 'SN0001', state: 'ok' })], scan, now: 1000 });
  assert.equal(tr2.closed.length, 1);
  assert.equal(tr2.closed[0].closeReason, 'ok');
  assert.equal(tr2.opened.length, 0);

  // 옛 키도 이번에 관측되면 이관이 아니다(같은 장비 두 등록 — C1 경로 그대로)
  const tr3 = transition({ open, observed: [newP, oldP], scan, now: 1000 });
  assert.ok(!tr3.opened.some((p) => p.migratedFrom), '둘 다 관측되면 이관하지 않는다');
  // 장비 수집 실패 주기에는 이관하지 않는다(규칙 ①)
  const tr4 = transition({ open, observed: [newP], scan: { deviceOk: { '|10.0.0.5': false } }, now: 1000 });
  assert.ok(!tr4.opened.some((p) => p.migratedFrom));
  assert.ok(!tr4.closed.length);
});
