/**
 * test/bareosPolicyDeadline2899.test.js — v2.899(점검 B3): Bareos 정책 수집의 전체 시한.
 *   ① 시한은 Director 수에서 유도(동시 4개 × Director 시한 + 여유, 바닥 15분)
 *   ② 틱 성공은 **모든 대상이 끝났고** 각각 무엇이든 읽었을 때만 — 예전에는 끝난 것만 보고 성공이라 그날 재시도하지 않았다
 *   ③ 시한 뒤 늦게 끝난 Director 의 결과도 파일에 쓴다(예전에는 메모리에만) · 시한 뒤에는 새 Director 를 시작하지 않는다
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2899pol-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
const POL = await import('../src/bareos/policy.js');
const S = await import('../src/bareos/settings.js');
const svc = await import('../src/bareos/service.js');
after(() => { svc._setSessionFactoryForTest(null); fs.rmSync(DIR, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('B3 ① 전체 시한은 Director 수에서 유도한다(바닥 15분)', () => {
  assert.equal(POL.runDeadlineMs(0), POL.RUN_DEADLINE_MS);
  assert.equal(POL.runDeadlineMs(4), POL.RUN_DEADLINE_MS, 'Director 4개 = 한 바퀴 3분 + 여유 < 15분');
  const n = 28;
  assert.equal(POL.runDeadlineMs(n), Math.ceil(n / POL.POLICY_CONCURRENCY) * POL.DIRECTOR_DEADLINE_MS + 60_000);
  assert.ok(POL.runDeadlineMs(n) > Math.ceil(n / POL.POLICY_CONCURRENCY) * POL.DIRECTOR_DEADLINE_MS, '모든 Director 가 Director 시한까지 걸려도 전체 시한 안');
});

test('B3 ② 틱 성공 판정 — 끝나지 않은 대상이 있으면 성공이 아니다', () => {
  assert.equal(POL.runOk({ total: 2, done: [{ any: true }, { any: true }] }), true);
  assert.equal(POL.runOk({ total: 3, done: [{ any: true }, { any: true }] }), false, '시한으로 남은 Director');
  assert.equal(POL.runOk({ total: 2, done: [{ any: true }, { any: false }] }), false);
  assert.equal(POL.runOk({ total: 0, done: [] }), false);
  assert.equal(POL.runOk(null), false);
});

test('B3 ③ 시한 뒤 늦게 끝난 결과는 파일에 쓰고 · 시한 뒤에는 새 Director 를 시작하지 않는다', async () => {
  POL._resetPolicyForTest();
  // 동시 4개 — 앞 4개 중 하나는 느리고(시한 뒤 성공), 다섯째는 시한 뒤 차례라 시작하지 않아야 한다
  const ds = ['A', 'B', 'C', 'SLOW', 'LATE'].map((name, i) => S.addDirector({ name, host: `10.1.2.${i + 1}`, consoleName: 'portal', password: 'pw' }).director);
  const byId = new Map(ds.map((d) => [d.id, d.name]));
  const opened = [];
  const map = { 'status scheduler days=7': { schedules: [], preview: [] }, 'llist pools': { pools: [] }, 'list volumes': { volumes: [] }, 'show schedules': { schedules: [] }, 'show jobdefs': { jobdefs: [] }, 'show filesets': { filesets: [] }, 'llist clients': { clients: [] } };
  svc._setSessionFactoryForTest(async (id) => {
    const nm = byId.get(id); opened.push(nm);
    if (nm === 'SLOW') await sleep(250);
    else if (nm !== 'LATE') await sleep(120);   // 앞 4개가 모두 시한(80ms)을 넘긴다 — 빈 자리가 시한 전에 나지 않게
    return { sent: [], info: { banner: 'OK: bareos-dir Version: 25.1.2 (26 October 2026)' }, call: async (cmd) => { if (!(cmd in map)) throw Object.assign(new Error('invalid'), { code: 'jsonrpc' }); return JSON.parse(JSON.stringify(map[cmd])); } };
  });
  const r = await POL.collectPolicy({ trigger: 'manual', deadlineMs: 80 });
  assert.equal(r.total, 5);
  assert.equal(r.timedOut, true);
  assert.equal(POL.runOk(r), false, '시한으로 남은 Director 가 있으면 성공이 아니다');
  const slowId = ds.find((d) => d.name === 'SLOW').id;
  const onDisk = () => JSON.parse(fs.readFileSync(path.join(DIR, 'bareos-policy.json'), 'utf8')).directors;
  assert.equal(onDisk()[slowId], undefined, '시한 때 파일에는 아직 없다');
  await sleep(400);
  assert.ok(onDisk()[slowId]?.any, '늦게 끝난 Director 의 결과를 파일에 썼다');
  assert.ok(!opened.includes('LATE'), '시한 뒤에는 새 Director 를 시작하지 않는다(가드 밖 호출이 Director 시한보다 길게 남지 않게)');
  assert.equal(POL.policyBusy(), false);
});

test('B3 ② 틱이 runOk 로 판정한다(끝난 것만 보는 옛 판정으로 되돌리지 않게)', () => {
  const src = fs.readFileSync(new URL('../src/bareos/policy.js', import.meta.url), 'utf8');
  assert.match(src, /const ok = runOk\(r\);/);
  assert.doesNotMatch(src, /r\.done\.length > 0 && r\.done\.every\(\(x\) => x\.any\);/);
});
