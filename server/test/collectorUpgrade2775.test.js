/**
 * v2.775(사용자 보고 '수집서버 자동 업그레이드가 안되') — 업그레이드 실패 이유가 사라지지 않게.
 *  ① 성공한 pull 이 상태를 통째로 바꾸며 upgrade(push 결과)를 지우지 않는다(puller.withUpgradeKept — 두 호출 지점 모두).
 *  ② 번들을 다시 확인하지 못해 수집 서버 push 를 생략하면 그 사실·사유가 남는다(manager.lastCollectorSkip → lastResult.collectorPush.skipped).
 *  ③ 실제 라우트 GET /admin/collectors 가 마지막 자동 push 결과를 상태·요약(autoPush)으로 싣는다.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'colupg2775-'));
Object.assign(process.env, { CONFIG_DIR: CFG, DATA_SOURCE: 'mock' });
for (const k of ['UPGRADE_WATCH_DIR', 'UPGRADE_REMOTE_BASE', 'UPGRADE_INSTALL_DIR', 'EDGE_MODE', 'CENTRAL_URL']) delete process.env[k];
const closers = [];
after(async () => { for (const c of closers) { try { await c(); } catch { /* */ } } try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* */ } });

const state = await import('../src/collector/state.js');
const puller = await import('../src/collector/puller.js');
const { stripComments } = await import('./_stripComments.js');

test('① withUpgradeKept — 직전 상태의 upgrade 만 이어 붙인다 · 없으면 그대로', () => {
  state.setCollectorStatus('cA', { ok: false, version: '1.0.0', upgrade: { at: 123, ok: false, reason: 'HTTP 403' } });
  const next = puller.withUpgradeKept('cA', puller.statusFromPull({ hosts: 3, version: '1.0.1' }));
  assert.deepEqual(next.upgrade, { at: 123, ok: false, reason: 'HTTP 403' });
  assert.equal(next.version, '1.0.1', 'pull 결과가 나머지 필드를 정한다');
  assert.equal(next.ok, true);
  const none = puller.withUpgradeKept('nobody', { ok: true });
  assert.deepEqual(none, { ok: true });
});

test('① 소스 — 성공한 pull 의 두 호출 지점 모두 upgrade 를 보존한다(statusFromPull 을 그대로 넣는 줄이 없다)', () => {
  const src = stripComments(fs.readFileSync(new URL('../src/collector/puller.js', import.meta.url), 'utf8'));
  assert.equal((src.match(/setCollectorStatus\(c\.id, statusFromPull\(r\)\)/g) || []).length, 0);
  assert.equal((src.match(/setCollectorStatus\(c\.id, withUpgradeKept\(c\.id, statusFromPull\(r\)\)\)/g) || []).length, 2);
});

test('② 번들을 다시 확인하지 못하면 생략 사유가 남는다 · 다음 호출에서 이전 생략이 새지 않는다', async () => {
  fs.writeFileSync(path.join(CFG, 'collectors.json'), JSON.stringify({ collectors: [{ id: 'c1', name: 'c1', url: 'http://127.0.0.1:9', token: 'T', enabled: true }] }));
  const { UpgradeManager } = await import('../src/upgrade/manager.js');
  const m = new UpgradeManager();
  const warns = []; const realWarn = console.warn; console.warn = (...a) => { warns.push(a.join(' ')); };
  try {
    const r = await m.pushToCollectors(path.join(CFG, 'no-such-bundle.tar.gz'));
    assert.deepEqual(r, []);
    assert.match(String(m.lastCollectorSkip), /수집 서버에 보내지 않았습니다/);
    assert.ok(warns.some((w) => /푸시 생략/.test(w)));
    fs.rmSync(path.join(CFG, 'collectors.json'), { force: true });
    await m.pushToCollectors(path.join(CFG, 'no-such-bundle.tar.gz'));   // 수집 서버 없음 → 생략 아님
    assert.equal(m.lastCollectorSkip, null);
  } finally { console.warn = realWarn; fs.rmSync(path.join(CFG, 'collectors.json'), { force: true }); }
});

let base = '';
before(async () => {
  const express = (await import('express')).default;
  const { registerCollectorsDc } = await import('../src/routes/admin/collectorsDc.js');
  const app = express(); app.use(express.json());
  const admin = express.Router();
  app.use('/api/admin', (req, _res, next) => { req.user = { username: 'adm', role: 'admin' }; next(); }, admin);
  registerCollectorsDc(admin);
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  closers.push(() => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(() => ok()); }));
  base = `http://127.0.0.1:${srv.address().port}/api/admin`;
});

test('③ 라우트 — 마지막 자동 push(파일 결과)를 수집 서버별 upgrade 와 autoPush 요약으로 싣는다', async () => {
  const { upgradeManager } = await import('../src/upgrade/manager.js');
  const keep = upgradeManager.lastResult;
  const at = Date.now() - 60_000;
  upgradeManager.lastResult = { at, ok: true, version: '2.775.0', collectorPush: { total: 2, ok: 1, items: [
    { id: 'edge-a', name: 'A', ok: false, status: 403, version: '', reason: 'HTTP 403 — 토큰 불일치' },
    { id: 'edge-b', name: 'B', ok: true, status: 200, version: '2.775.0', reason: '' },
  ] } };
  try {
    const j = await (await fetch(`${base}/collectors`)).json();
    assert.deepEqual(j.autoPush, { at, version: '2.775.0', total: 2, ok: 1 });
    assert.equal(j.status['edge-a'].upgrade.ok, false);
    assert.equal(j.status['edge-a'].upgrade.status, 403);
    assert.equal(j.status['edge-a'].upgrade.auto, true);
    assert.match(j.status['edge-a'].upgrade.reason, /403/);
    assert.equal(j.status['edge-b'].upgrade.version, '2.775.0');
    // 생략 기록은 요약에 skipped 로
    upgradeManager.lastResult = { at, ok: true, version: '2.775.0', collectorPush: { total: 0, ok: 0, items: [], skipped: '번들을 다시 확인하지 못해 수집 서버에 보내지 않았습니다: 서명 없음' } };
    const j2 = await (await fetch(`${base}/collectors`)).json();
    assert.match(j2.autoPush.skipped, /보내지 않았습니다/);
    upgradeManager.lastResult = null;
    const j3 = await (await fetch(`${base}/collectors`)).json();
    assert.equal(j3.autoPush, null);
  } finally { upgradeManager.lastResult = keep; }
});
