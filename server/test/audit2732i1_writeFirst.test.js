/**
 * v2.732 점검 2회차 그룹 i1 — 서버 형제(verify-B5 B5-03 절).
 *   ① sanswitch/perfSettings.js savePerfSettings — 디스크 쓰기가 실패하면 캐시(메모리 설정)를 바꾸지 않는다
 *   ② storage/intervals.js saveIntervalConfig — 같은 규칙
 *   ③ PUT /insights/fleet/assign-bulk — fleet-assign 쓰기 실패({ok:false})를 버리고 {ok:true, assigned} 를 주던 것 → 500 + 사유
 *   ④ PUT /insights/fleet/tag — 실패를 200 {ok:false} 로 주던 것 → 400(형제 /fleet/assign 과 같다)
 *
 * 쓰기 실패는 atomicWriteFileSync 의 마지막 단계(fs.renameSync)를 대상 파일에 한해 던지게 해 만든다 — atomicWrite.js 는
 * `import fs from 'node:fs'` 의 속성을 호출 시점에 읽으므로 같은 객체를 바꾸면 그대로 걸린다(root 라 권한으로는 실패를 만들 수 없다).
 * ⚠ config.js 는 import 시점에 CONFIG_DIR 을 굳힌다 — ①② 는 env 를 고정한 뒤 dynamic import, ③④ 는 자식 프로세스(실제 라우터).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2732i1-'));
process.env.DATA_SOURCE = 'mock';

/** 대상 파일 이름으로 끝나는 rename 만 실패시키고 원래 함수를 돌려준다. */
function failRenameFor(basename) {
  const real = fs.renameSync;
  fs.renameSync = (a, b) => {
    if (String(b).endsWith(basename)) { const e = new Error('EIO: 모의 디스크 쓰기 실패'); e.code = 'EIO'; throw e; }
    return real(a, b);
  };
  return () => { fs.renameSync = real; };
}

test('① SAN 포트 사용량 설정 — 쓰기 실패면 메모리 설정도 그대로(재시작 전후가 같다)', async () => {
  const ps = await import(path.join(SRC, 'sanswitch/perfSettings.js'));
  ps._resetForTest();
  ps.savePerfSettings({ enabled: false, intervalMs: 10 * 60_000, retentionDays: 30 });
  const before = ps.loadPerfSettings();
  assert.equal(before.enabled, false);
  const restore = failRenameFor('sanswitch-perf-settings.json');
  try {
    assert.throws(() => ps.savePerfSettings({ enabled: true, intervalMs: 60 * 60_000, retentionDays: 365 }), /모의 디스크 쓰기 실패/);
  } finally { restore(); }
  const after = ps.loadPerfSettings();
  assert.deepEqual(after, before, '쓰기 실패 뒤 메모리는 새 값으로 수집하면 안 된다(라우트는 400 을 줬다)');
  // 파일도 그대로 — 재시작 뒤와 지금이 같다
  ps._resetForTest();
  assert.deepEqual(ps.loadPerfSettings(), before);
  // 쓰기가 되면 바뀐다(정상 경로 회귀 없음)
  ps.savePerfSettings({ enabled: true });
  assert.equal(ps.loadPerfSettings().enabled, true);
});

test('② 스토리지 수집 주기 — 쓰기 실패면 배포·적용 값(메모리)도 그대로', async () => {
  const iv = await import(path.join(SRC, 'storage/intervals.js'));
  iv._resetForTest();
  iv.saveIntervalConfig({ global: { pollMs: 2 * 3600_000 }, agents: { 'edge-a': { pushMs: 10 * 60_000 } } });
  const before = iv.loadIntervalConfig();
  assert.equal(before.global.pollMs, 2 * 3600_000);
  const restore = failRenameFor('storage-intervals.json');
  let threw = false;
  try {
    try { iv.saveIntervalConfig({ global: { pollMs: 3 * 3600_000 }, agents: {} }); } catch (e) { threw = /모의 디스크 쓰기 실패/.test(e.message); }
  } finally { restore(); }
  assert.ok(threw, '쓰기 실패는 던져야 한다(라우트가 400 으로 말한다)');
  assert.deepEqual(iv.loadIntervalConfig(), before, '쓰기 실패 뒤 메모리 설정이 새 값이면 안 된다');
  assert.equal(iv.intervalsForAgent('edge-a').pushMs, 10 * 60_000, '엣지 배포 값도 옛 값 그대로');
  iv._resetForTest();
  assert.deepEqual(iv.loadIntervalConfig(), before, '파일도 그대로');
});

function runChild(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2732i1-r-'));
  const script = `
    const SRC = ${JSON.stringify(SRC + '/')};
    const fs = (await import('node:fs')).default; const path = await import('node:path');
    const express = (await import('express')).default;
    const { store } = await import(SRC + 'store.js');
    await store.refresh?.();
    const { insightsRouter } = await import(SRC + 'routes/insights.js');
    const app = express(); app.use(express.json({ limit: '5mb' }));
    app.use((req, _r, n) => { req.user = { username: 'full', role: 'admin', scope: null }; n(); });
    app.use('/api/insights', insightsRouter);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const call = async (method, p, b) => {
      const r = await fetch(base + '/api' + p, { method, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 300); }
      return { s: r.status, j };
    };
    const realRename = fs.renameSync;
    const failFor = (name) => { fs.renameSync = (a, b) => { if (String(b).endsWith(name)) { const e = new Error('EIO: 모의 디스크 쓰기 실패'); e.code = 'EIO'; throw e; } return realRename(a, b); }; };
    const unfail = () => { fs.renameSync = realRename; };
    const CFG = process.env.CONFIG_DIR;
    const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(CFG, f), 'utf8')); } catch { return null; } };
    const vcId = (store.get().vcenters || [])[0]?.id || '';
    const out = { vcId };
    try { ${body} } finally { unfail(); srv.close(); }
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 180_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${(r.stderr || '').slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-1000)} ${r.stderr.slice(-1000)}`);
  return JSON.parse(line.slice(2));
}

test('③④ 통합 서버 인벤토리 — 일괄 귀속·분류의 쓰기 실패는 실패 응답(실제 라우터)', () => {
  const o = runChild(`
    failFor('fleet-assign.json');
    out.bulkFail = await call('PUT', '/insights/fleet/assign-bulk', { items: [{ key: 'SVCTAG-I1A' }, { key: 'SVCTAG-I1B' }], vcenterId: vcId });
    unfail();
    out.fileAfterFail = readJson('fleet-assign.json');
    out.bulkOk = await call('PUT', '/insights/fleet/assign-bulk', { items: [{ key: 'SVCTAG-I1A' }], vcenterId: vcId });
    out.fileAfterOk = readJson('fleet-assign.json');
    failFor('fleet-tags.json');
    out.tagFail = await call('PUT', '/insights/fleet/tag', { key: 'SVCTAG-I1A', tag: 'exclude' });
    unfail();
    out.tagBad = await call('PUT', '/insights/fleet/tag', { key: 'SVCTAG-I1A', tag: 'nonsense' });
    out.tagOk = await call('PUT', '/insights/fleet/tag', { key: 'SVCTAG-I1A', tag: 'exclude' });
  `);
  assert.ok(o.vcId, '목 vCenter 가 있어야 한다');
  // ③ 수정 전: 200 {ok:true, assigned:2, total:2} 인데 파일에는 아무것도 없었다
  assert.equal(o.bulkFail.s, 500, `쓰기 실패는 실패 응답이어야 한다(받은 것: ${o.bulkFail.s} ${JSON.stringify(o.bulkFail.j)})`);
  assert.equal(o.bulkFail.j.ok, false);
  assert.match(o.bulkFail.j.reason, /소속 저장 실패/);
  assert.equal(o.bulkFail.j.notSaved, 2);
  assert.equal(o.fileAfterFail?.assign?.['svctag-i1a'], undefined);
  assert.equal(o.bulkOk.s, 200);
  assert.equal(o.bulkOk.j.ok, true);
  assert.equal(o.bulkOk.j.assigned, 1);
  assert.equal(o.fileAfterOk?.assign?.['svctag-i1a'], o.vcId);
  // ④ 수정 전: 200 {ok:false} — 화면은 다시 읽기만 했다
  assert.equal(o.tagFail.s, 400);
  assert.equal(o.tagFail.j.ok, false);
  assert.match(o.tagFail.j.reason, /저장 실패/);
  assert.equal(o.tagBad.s, 400);
  assert.equal(o.tagOk.s, 200);
  assert.equal(o.tagOk.j.ok, true);
});
