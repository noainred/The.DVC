// v2.689 G3 — 감사 기록 정확성 회귀 고정.
//   B2: 로그인 감사·실패 기록의 `ip` 는 clientIp(실제 peer — TRUST_PROXY 일 때만 req.ip)이고, 위조 가능한 X-Forwarded-For 원문은
//       판정에 쓰지 않는 참고 필드 `xff`(64자 상한)로만 남는다. `ip` 칸도 64자 상한.
//   I3: `/api`·`/api/svcmon` 마운트에도 auditMiddleware — 2xx 변경만 기록, 읽기성 POST(AUDIT_SKIP)는 제외,
//       두 마운트를 지나는 요청은 한 줄만. 그동안 죽어 있던 describe() 규칙(`/tools/ipam/annotation`)이 살아난다.
//   B7: 게스트 계정 추가·심층 검색 게스트 탐침은 누가·어디에·무엇을 남긴다(비밀번호 제외).
// 실제 express 라우터를 띄워 감사 파일(audit.ndjson)을 읽는다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g3audit2689-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
delete process.env.TRUST_PROXY;
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const AUDIT = path.join(tmp, 'audit.ndjson');

let express, auditMod;
before(async () => {
  express = (await import('express')).default;
  auditMod = await import('../src/audit.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const lines = () => { try { return fs.readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const settle = () => new Promise((r) => setTimeout(r, 30)); // res 'finish' 이벤트 뒤 감사 줄이 써질 시간

test('B2: 위조 X-Forwarded-For 는 감사 ip 에 들어가지 않고 xff(64자 상한) 로만 남는다', async () => {
  const { authRouter } = await import('../src/routes/auth.js');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  const srv = await listen(app);
  try {
    const forged = '10.66.66.66';
    const before = lines().length;
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `${forged}, 1.2.3.4` },
      body: JSON.stringify({ username: 'nobody-g3', password: 'wrong' }),
    });
    assert.equal(r.status, 401);
    const got = lines().slice(before).filter((e) => e.user === 'nobody-g3');
    assert.ok(got.length >= 1, '로그인 실패 감사 줄');
    const e = got[got.length - 1];
    assert.notEqual(e.ip, forged, `감사 ip 가 위조 XFF 를 그대로 썼다: ${e.ip}`);
    assert.ok(!String(e.ip).includes('10.66.66.66'), e.ip);
    assert.match(e.ip, /127\.0\.0\.1/, '실제 peer 주소');
    assert.equal(e.xff, `${forged}, 1.2.3.4`, 'XFF 원문은 참고 필드로 남는다');

  } finally { srv.close(); }
});

test('B2: logAudit 의 ip 칸은 64자 상한 + 잘림 표지, xff 가 비면 키를 싣지 않는다', () => {
  auditMod.logAudit({ user: 'cap-g3', action: 't', ip: 'B'.repeat(500) });
  const e = lines().filter((x) => x.user === 'cap-g3').pop();
  assert.equal(e.ip, 'B'.repeat(auditMod.AUDIT_IP_MAX) + auditMod.AUDIT_TRUNC_MARK);
  assert.equal('xff' in e, false);
  auditMod.logAudit({ user: 'cap-g3x', action: 't', ip: '1.1.1.1', xff: 'C'.repeat(65) });
  const x = lines().filter((y) => y.user === 'cap-g3x').pop();
  assert.equal(x.xff, 'C'.repeat(auditMod.AUDIT_IP_MAX) + auditMod.AUDIT_TRUNC_MARK, 'xff 도 64자 + 잘림 표지');
  assert.equal(auditMod.listAudit({ user: 'cap-g3x' }).items[0].xff, x.xff, '읽기 소독이 xff 를 보존');
});

test('I3: auditMiddleware — 읽기성 POST 는 건너뛰고, 2xx 변경은 기록하며, 두 마운트를 지나도 한 줄', async () => {
  const { auditMiddleware } = auditMod;
  const api = express.Router();
  api.put('/tools/ipam/annotation', (_req, res) => res.json({ ok: true }));
  api.post('/tool-usage', (_req, res) => res.json({ ok: true }));
  api.post('/vms/usage', (_req, res) => res.json({ ok: true }));
  api.post('/denied', (_req, res) => res.status(403).json({ ok: false }));
  const svc = express.Router();
  svc.post('/targets/hostmap/parse', (_req, res) => res.json({ ok: true }));
  svc.put('/reorder/targets', (_req, res) => res.json({ ok: true }));
  const adminR = express.Router(); // 아무 라우트도 없다 → next() 로 /api 로 넘어간다
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'aud-g3', role: 'admin' }; next(); });
  app.use('/api/admin', auditMiddleware, adminR);
  app.use('/api/svcmon', auditMiddleware, svc);
  app.use('/api', auditMiddleware, api);
  const srv = await listen(app);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = (m, p) => fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: '{}' });
  try {
    for (const [m, p] of [['PUT', '/api/tools/ipam/annotation'], ['POST', '/api/tool-usage'], ['POST', '/api/vms/usage'],
      ['POST', '/api/denied'], ['POST', '/api/svcmon/targets/hostmap/parse'], ['PUT', '/api/svcmon/reorder/targets']]) {
      await call(m, p);
    }
    await settle();
    const mine = lines().filter((e) => e.user === 'aud-g3');
    const targets = mine.map((e) => e.target);
    assert.ok(mine.some((e) => e.action === 'IP 메모/태그 저장'), `죽은 규칙이 살아나야 한다: ${JSON.stringify(mine)}`);
    assert.ok(targets.includes('/api/svcmon/reorder/targets'), 'svcmon 변경 기록');
    for (const skipped of ['/api/tool-usage', '/api/vms/usage', '/api/svcmon/targets/hostmap/parse', '/api/denied']) {
      assert.ok(!targets.includes(skipped), `${skipped} 는 기록하지 않는다`);
    }
    assert.equal(auditMod.auditSkipped('POST', '/api/tool-usage'), true);
    assert.equal(auditMod.auditSkipped('POST', '/api/tool-usage/x'), false, '접두 매칭 금지');
    assert.equal(auditMod.auditSkipped('PUT', '/api/tool-usage'), false, '메서드까지 맞아야 건너뛴다');
  } finally { srv.close(); }

  // 이중 장착 가드 — 같은 요청에 auditMiddleware 를 두 번 지나도 한 줄
  const app2 = express();
  app2.use((req, _res, next) => { req.user = { username: 'dup-g3', role: 'admin' }; next(); });
  const passR = express.Router();
  const okR = express.Router(); okR.put('/x', (_req, res) => res.json({ ok: true }));
  app2.use('/api', auditMiddleware, passR);
  app2.use('/api', auditMiddleware, okR);
  const srv2 = await listen(app2);
  try {
    await fetch(`http://127.0.0.1:${srv2.address().port}/api/x`, { method: 'PUT' });
    await settle();
    assert.equal(lines().filter((e) => e.user === 'dup-g3').length, 1, '두 마운트를 지나도 감사는 한 줄');
  } finally { srv2.close(); }
});

test('I3: index.js 의 /api·/api/svcmon 마운트가 auditMiddleware 를 단다', () => {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'index.js'), 'utf8'));
  assert.match(src, /app\.use\('\/api\/svcmon',[^\n]*auditMiddleware,\s*svcmonRouter\)/);
  assert.match(src, /app\.use\('\/api',\s*authMiddleware,\s*requireEnrolled,\s*auditMiddleware,\s*api\)/);
});

test('B7: 게스트 계정 추가·게스트 탐침은 누가·어디·무엇을 남기고 비밀번호는 남기지 않는다', async () => {
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'guest-g3', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: [] } }; next(); });
  app.use('/api/admin', adminRouter);
  const srv = await listen(app);
  const base = `http://127.0.0.1:${srv.address().port}/api/admin`;
  try {
    const r = await fetch(`${base}/guest/add-user`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vcenterId: 'vc-none-g3', vmIds: ['vm-1', 'vm-2'], username: 'svcbot', password: 'S3cret!pw', guestPass: 'R00tPw!', nopasswd: true }),
    });
    assert.equal(r.status, 400); // 등록되지 않은 vCenter — 실패도 기록한다
    const r2 = await fetch(`${base}/deep-search/probe`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ probe: { type: 'gpu', pattern: 'secret-pattern' }, guestPass: 'R00tPw!', maxVms: 7 }),
    });
    assert.ok(r2.status === 200 || r2.status === 500, String(r2.status));
    await settle();
    const mine = lines().filter((e) => e.user === 'guest-g3');
    const add = mine.find((e) => e.action === '게스트 계정 추가 실패');
    assert.ok(add, JSON.stringify(mine));
    assert.equal(add.target, 'vc-none-g3');
    assert.match(add.detail, /VM 2대 · 계정 svcbot · sudo=true · NOPASSWD/);
    const probe = mine.find((e) => e.action === '심층 검색 게스트 탐침');
    assert.ok(probe, JSON.stringify(mine));
    assert.match(probe.detail, /유형 gpu · 후보 \d+대 · 상한 7대/);
    const raw = JSON.stringify(mine);
    for (const secret of ['S3cret!pw', 'R00tPw!', 'secret-pattern']) assert.ok(!raw.includes(secret), `${secret} 가 감사에 남았다`);
  } finally { srv.close(); }
});
