// v2.633 — 손상 보존본만 남은 중앙 설정 파일을 관리자가 **기본값으로 확정**하는 경로(자동 해제 없음).
//   ① 등록된 설정 모듈 13개 전부가 confirm 을 가진다(소스 스윕) ② 13개 파일 모두 실제로 확정되고 보존본은 남는다
//   ③ 라우트: admin + 전체 범위만 · 감사 로그 · 모르는 파일 404 · 이미 정상 409 ④ util 실패 코드 ⑤ 서비스 점검 행이 확정 가능 표시를 싣는다.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2633-'));
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true'; // 인증 꺼짐이면 requireRole 이 익명(admin)으로 통과시킨다 — 역할 게이트를 보려면 켠다(req.user 는 테스트가 넣는다)
delete process.env.PARTFAULT_ENABLED;
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// 13개 배포 설정 파일 — 원본 없이 손상 보존본만(재시작 뒤 상태). 보존본 내용은 테스트가 읽지 않는다.
const FILES = ['linkcheck-settings.json', 'rma-schedules.json', 'central-svcmon-assign.json', 'ipam-scan.json',
  'bmusage-settings.json', 'bmusage-distribute.json', 'vmseries.json', 'sanswitch-perf-settings.json', 'storage-intervals.json',
  'cvp-settings.json', 'partfault-settings.json', 'pdu-intervals.json', 'curuser-settings.json'];
const MODULES = ['linkcheck/settings.js', 'rma/schedules.js', 'central/svcmonAssign.js', 'ipam/scanStore.js', 'bmusage/settings.js',
  'vmseries/settings.js', 'sanswitch/perfSettings.js', 'storage/intervals.js', 'cvp/settings.js', 'partfault/settings.js',
  'pdu/intervals.js', 'curuser/settings.js'];
for (const f of FILES) fs.writeFileSync(path.join(CFG, `${f}.corrupt.2026-09-27T00-00-00`), 'x');

const express = (await import('express')).default;
const FULL = { username: 'root', role: 'admin', scope: {} };
const OPER = { username: 'op', role: 'operator', scope: {} };
async function call(router, user, method, url, body) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message || err) }));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, body: json };
  } finally { srv.close(); }
}

let util; let api; let SCOPED;
before(async () => {
  for (const m of MODULES) await import(`../src/${m}`);
  util = await import('../src/util/settingsLoadError.js');
  ({ api } = await import('../src/routes/api.js'));
  const { store } = await import('../src/store.js');
  await store.refresh().catch(() => {});
  const vc = store.get().vms[0]?.vcenterId || 'vc-x';
  SCOPED = { username: 'adm2', role: 'admin', scope: { vcenters: [vc] } };
});

test('① 설정 로드 오류를 만드는 모든 모듈이 label + confirm 을 준다(새 모듈이 빠지면 확정 버튼이 뜨지 않는다)', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
  const calls = [];
  for (const f of walk(SRC)) {
    if (f.endsWith(path.join('util', 'settingsLoadError.js'))) continue;
    const s = stripComments(fs.readFileSync(f, 'utf8'));
    for (const m of s.matchAll(/makeSettingsLoadError\(([^\n]*)/g)) calls.push({ f: path.relative(SRC, f), line: m[1] });
  }
  assert.equal(calls.length, 13, `등록 수가 바뀌었다 — 테스트의 FILES 목록도 갱신할 것: ${calls.map((c) => c.f).join(', ')}`);
  for (const c of calls) assert.ok(/label:\s*'[^']+'/.test(c.line) && /confirm:/.test(c.line), `${c.f}: label·confirm 이 없다 — ${c.line}`);
});

test('⑤ 서비스 점검 목록: 13개 전부 못 읽음 + 이름·확정 가능 표시(값은 싣지 않는다)', () => {
  const errs = util.listSettingsLoadErrors();
  const names = errs.map((e) => e.file).sort();
  assert.deepEqual(names, [...FILES].sort());
  for (const e of errs) { assert.ok(e.label, e.file); assert.equal(e.confirmable, true, e.file); assert.ok(/손상 보존본/.test(e.reason), e.reason); }
});

test('③ 라우트 게이트: operator 403 · 범위 관리자 403 · 파일 없음 400 · 모르는 파일 404 · 경로 조작은 모르는 파일', async () => {
  const u = '/tools/service-check/settings-files/confirm';
  assert.equal((await call(api, OPER, 'POST', u, { file: 'cvp-settings.json' })).status, 403);
  const s = await call(api, SCOPED, 'POST', u, { file: 'cvp-settings.json' });
  assert.equal(s.status, 403, JSON.stringify(s.body));
  assert.ok(!fs.existsSync(path.join(CFG, 'cvp-settings.json')), '거절된 요청이 파일을 쓰면 안 된다');
  assert.equal((await call(api, FULL, 'POST', u, {})).status, 400);
  assert.equal((await call(api, FULL, 'POST', u, { file: 'users.json' })).status, 404);
  assert.equal((await call(api, FULL, 'POST', u, { file: '../cvp-settings.json' })).status, 404);
});

test('② 13개 전부 관리자 확정이 성공하고, 오류가 풀리며, 보존본은 남는다 · 두 번째는 409 · 감사 로그', async () => {
  const u = '/tools/service-check/settings-files/confirm';
  for (const f of FILES) {
    const r = await call(api, FULL, 'POST', u, { file: f });
    assert.equal(r.status, 200, `${f}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
    assert.ok(fs.existsSync(path.join(CFG, f)), `${f}: 기본값 파일이 써지지 않았다`);
    assert.ok(fs.existsSync(path.join(CFG, `${f}.corrupt.2026-09-27T00-00-00`)), `${f}: 보존본을 지우면 안 된다`);
  }
  assert.deepEqual(util.listSettingsLoadErrors(), [], '확정 뒤에는 목록이 비어야 한다');
  const again = await call(api, FULL, 'POST', u, { file: 'cvp-settings.json' });
  assert.equal(again.status, 409); assert.equal(again.body.code, 'not-in-error');
  const audit = fs.readFileSync(path.join(CFG, 'audit.ndjson'), 'utf8');
  assert.ok(/settings-file\.confirm-default/.test(audit) && /cvp-settings\.json/.test(audit), '감사 로그가 남아야 한다');
  const pf = await import('../src/partfault/settings.js');
  assert.equal(pf.partFaultSettingsLoadError(), null);
  assert.equal(pf.loadPartFaultSettings().enabled, false, '기본값(꺼짐)이 확정된다 — 켜진 값을 지어내지 않는다');
});

test('④ util 실패 코드: confirm 없음 → not-confirmable · 던짐 → confirm-failed · 저장했는데 여전히 오류 → still-error', () => {
  const mk = (name, opts) => { fs.writeFileSync(path.join(CFG, `${name}.corrupt.1`), 'x'); return util.makeSettingsLoadError(() => path.join(CFG, name), opts); };
  mk('t-none.json');
  assert.equal(util.confirmSettingsDefault('t-none.json').code, 'not-confirmable');
  mk('t-throw.json', { confirm: () => { throw new Error('디스크 가득'); } });
  const r = util.confirmSettingsDefault('t-throw.json');
  assert.equal(r.code, 'confirm-failed'); assert.ok(/디스크 가득/.test(r.detail));
  mk('t-noop.json', { confirm: () => {} });
  assert.equal(util.confirmSettingsDefault('t-noop.json').code, 'still-error', '파일을 쓰지 않은 confirm 을 성공이라 말하면 안 된다');
  let by = null;
  const le = mk('t-by.json', { confirm: (o) => { by = o.by; fs.writeFileSync(path.join(CFG, 't-by.json'), '{}'); le.ok(); } });
  assert.equal(util.confirmSettingsDefault('t-by.json', { by: 'root' }).ok, true);
  assert.equal(by, 'root');
  assert.equal(util.confirmSettingsDefault('').code, 'unknown-file');
});
