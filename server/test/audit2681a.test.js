/**
 * v2.681 감사 B 축 — 회귀 고정.
 *  R2B-01: 로컬 계정과 같은 이름의 AD 세션을 만들지도(authenticate), 받지도(resolveTokenUser) 않는다.
 *          예전에는 AD 가 입력한 이름을 그대로 돌려줘, 이름으로 판정하는 소유자·자격증명 가드를 전부 '본인' 으로 통과했다.
 *  R2B-02: 센서 상세 목록·상세 응답의 collection.error(iDRAC 관리 IP 가 든 원문)는 비-admin 에게 주지 않는다.
 *  R2B-03: vmperf·vmseries _index.json 은 원자 쓰기 + 손상 보존(파일명이 비가역이라 재구축 불가).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2681a-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
process.env.VMPERF_DB_DIR = path.join(tmp, 'vmperf');
process.env.VMSERIES_DB_DIR = path.join(tmp, 'vmseries');

let A; let ldapSrv; let ldapHits = 0;
before(async () => {
  A = await import('../src/auth/auth.js');
  // AD 서버 흉내 — 연결 수만 센다(곧바로 끊어 AD 인증은 실패한다). 로컬 이름이면 연결 자체가 없어야 한다.
  ldapSrv = net.createServer((s) => { ldapHits++; s.destroy(); });
  await new Promise((r) => ldapSrv.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(tmp, 'auth.json'), JSON.stringify({ ad: { enabled: true, url: `ldap://127.0.0.1:${ldapSrv.address().port}`, domain: 'corp.local', defaultRole: 'admin', timeoutMs: 1000 } }));
});
after(() => { try { ldapSrv?.close(); } catch { /* ignore */ } });

test('R2B-01 ① 로컬 계정 이름의 AD 형 토큰(src 없음)은 무효다 — 대소문자만 달라도', () => {
  const r = A.createUser({ username: 'kim', password: 'Initial#Pass1', role: 'admin' }, { trusted: true });
  assert.ok(r.ok !== false, JSON.stringify(r));
  assert.equal(A.resolveTokenUser(A.signToken({ sub: 'kim', role: 'admin', name: 'kim (AD)' })), null);
  assert.equal(A.resolveTokenUser(A.signToken({ sub: 'KIM', role: 'admin', name: 'KIM (AD)' })), null);
  // 로컬 토큰은 그대로 동작한다.
  const u = A.getUser('kim');
  const lt = A.resolveTokenUser(A.signToken({ sub: 'kim', role: 'admin', name: 'kim', src: 'local', tv: u.tokenVersion || 0 }));
  assert.equal(lt?.username, 'kim'); assert.equal(lt?.authSrc, 'local');
});

test('R2B-01 ② 로컬 계정이 없는 이름의 AD 토큰은 예전 그대로 풀린다', () => {
  const ad = A.resolveTokenUser(A.signToken({ sub: 'ad.lee', role: 'admin', name: 'lee' }));
  assert.equal(ad?.username, 'ad.lee');
  assert.equal(ad?.role, 'admin');
  assert.equal(ad?.authSrc, undefined, 'AD 세션은 로컬 표지를 받지 않는다');
});

test('R2B-01 ③ authenticate — 로컬 이름이면 AD 에 연결조차 하지 않고 로컬로만 판정한다', async () => {
  ldapHits = 0;
  const ok = await A.authenticate('kim', 'Initial#Pass1');
  assert.equal(ok?.username, 'kim'); assert.equal(ok?.source, 'local');
  assert.equal(await A.authenticate('kim', 'WrongAdPass!1'), null);
  assert.equal(await A.authenticate('Kim', 'WrongAdPass!1'), null);
  assert.equal(ldapHits, 0, '로컬 이름(대소문자 무시)은 AD 를 시도하지 않는다');
  // 로컬 계정이 없는 이름은 AD 를 시도한다(이 가짜 서버는 끊으므로 실패 → 로컬도 없음 → null).
  assert.equal(await A.authenticate('nolocal.user', 'AdPass#1'), null);
  assert.ok(ldapHits >= 1, 'AD 로그인 경로는 로컬 계정이 없는 이름에서 그대로 동작한다');
});

test('R2B-02 센서 상세 — 비-admin 은 collection.error 원문(관리 IP)을 받지 않는다, admin 은 받는다', async () => {
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  try { await store.refresh(); } catch { /* mock */ }
  const R = await import('../src/idrac/registry.js');
  const vc = store.get().vcenters[0].id;
  const add = R.addServer({ id: '10.77.1.15', host: 'https://10.77.1.15', name: '10.77.1.15', username: 'root', password: 'calvin123', vcenterId: vc });
  const id = (add.server || R.loadRegistry()[0]).id;
  const C = await import('../src/idrac/sensorDetailCache.js');
  C.setSensorCollection(id, { ok: false, sensors: [], error: 'fetch failed: connect ECONNREFUSED 10.77.1.15:443' });
  const { api } = await import('../src/routes/api.js');
  const run = async (role) => {
    const app = express(); app.use(express.json());
    app.use((req, _r, n) => { req.user = { username: role, role, scope: null }; n(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const base = `http://127.0.0.1:${srv.address().port}`;
      const list = await (await fetch(`${base}/api/tools/esxi-temp/sensors`)).json();
      const row = (list.rows || []).find((x) => !String(x.id).startsWith('mock'));
      assert.ok(row, '등록 서버 행이 있어야 한다');
      const detail = await (await fetch(`${base}/api/tools/esxi-temp/sensors/${encodeURIComponent(row.id)}`)).json();
      return { list, row, detail };
    } finally { srv.close(); }
  };
  const op = await run('operator');
  assert.equal(op.list.addressHidden, true);
  assert.ok(!JSON.stringify(op.list).includes('10.77.1.15'), '목록에 관리 IP 가 없어야 한다');
  assert.ok(!JSON.stringify(op.detail).includes('10.77.1.15'), '상세에 관리 IP 가 없어야 한다');
  assert.equal(op.row.collection?.ok, false, '실패했다는 사실은 남긴다');
  assert.equal(op.detail.collection?.error, '(관리자만 확인)');
  assert.equal(op.row.collection?.error, '(관리자만 확인)');
  const ad = await run('admin');
  assert.match(ad.detail.collection?.error || '', /10\.77\.1\.15/, 'admin 은 원문을 본다');
});

test('R2B-03 _index.json — 손상본은 보존하고, 쓰기는 원자적이다', async () => {
  for (const [mod, dirEnv, getDb, usage] of [
    ['../src/metrics/vmperfDb.js', 'VMPERF_DB_DIR', 'getVmperfDb', 'vmperfDiskUsage'],
    ['../src/vmseries/db.js', 'VMSERIES_DB_DIR', 'getVmSeriesDb', 'vmSeriesDiskUsage'],
  ]) {
    const m = await import(mod);
    const dir = process.env[dirEnv];
    fs.mkdirSync(dir, { recursive: true });
    const idxFile = path.join(dir, '_index.json');
    fs.writeFileSync(idxFile, '{"a-1234": "vc-a"'); // 절단본
    m[usage]();
    const left = fs.readdirSync(dir);
    assert.ok(left.some((f) => f.startsWith('_index.json.corrupt.')), `${mod}: 손상본을 .corrupt 로 보존해야 한다 (${left.join(',')})`);
    assert.ok(!fs.existsSync(idxFile), '손상본은 원래 이름에서 치워진다');
    await m[getDb]('vc-index-test');
    const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
    assert.ok(Object.values(idx).includes('vc-index-test'), `${mod}: 새 인덱스가 저장된다`);
    const src = fs.readFileSync(new URL(mod, import.meta.url), 'utf8');
    assert.ok(!/fs\.writeFileSync\(INDEX_FILE/.test(src), `${mod}: 인덱스는 atomicWriteFileSync 로 쓴다`);
  }
});
