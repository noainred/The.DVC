/**
 * v2.618 — 전면 점검(버그·보안·메모리·튜닝·아키텍처·웹) 확정분 회귀. 상세는 docs/AUDIT-2026-09-26.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripComments } from './_stripComments.js';

const SRC = new URL('../src/', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, SRC), 'utf8');

test('BUG-1: 빈 env 값(KEY=)은 미지정 — pull·스캔이 꺼지거나 iDRAC 동시성이 1 이 되지 않는다', () => {
  const mod = new URL('config.js', SRC).href;
  const code = `import { config } from '${mod}'; process.stdout.write(JSON.stringify({ pull: config.collector.pullIntervalMs, conc: config.idrac?.pollConcurrency ?? null }));`;
  const run = (env) => JSON.parse(spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, ...env } }).stdout);
  const blank = run({ COLLECTOR_PULL_INTERVAL_MS: '', IDRAC_POLL_CONCURRENCY: '' });
  const unset = run({});
  assert.deepEqual(blank, unset);
  assert.ok(blank.pull > 0, '빈 값이 pull 을 끄면 안 된다');
  assert.equal(run({ COLLECTOR_PULL_INTERVAL_MS: '0' }).pull, 0, '명시적 0 은 여전히 끔');
});

test('BUG-2: 엣지가 등록부를 못 읽은 상태(registered:null)를 0(위임 0대 — 정상)으로 저장하지 않는다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2618-'));
  const code = `
    const st = await import('${new URL('central/storageEdge.js', SRC).href}');
    const sw = await import('${new URL('central/sanSwitchEdge.js', SRC).href}');
    const pd = await import('${new URL('central/pduEdge.js', SRC).href}');
    st.saveEdgeStorageStatus('e1', { reason: 'registry-unreadable', registered: null });
    sw.saveEdgeSanSwitchStatus('e1', { reason: 'x', registered: null });
    pd.saveEdgePduStatus('e1', { reason: 'x', registered: null });
    const pick = (m, fn) => { try { return fn(m); } catch (e) { return 'ERR ' + e.message; } };
    process.stdout.write(JSON.stringify({ ok: true }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, CONFIG_DIR: dir } });
  assert.equal(r.status, 0, r.stderr);
  const texts = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.doesNotMatch(texts, /"registered":\s*0/, '등록부를 못 읽은 것이 0 으로 저장됐다');
  for (const f of ['central/storageEdge.js', 'central/sanSwitchEdge.js', 'central/pduEdge.js']) {
    assert.match(stripComments(read(f)), /const registered = numOrNull\(src\.registered\)/, f);
  }
  assert.match(stripComments(read('storage/push.js')), /registered == null \? 'registry-unreadable' : 'no-snapshots'/);
});

test('WEB-2(서버): 빈 vCenter 순서는 명시적 초기화(clear:true)일 때만 저장한다', () => {
  const s = stripComments(read('routes/admin/vcenters.js'));
  assert.match(s, /if \(!ids\.length && body\.clear !== true\) return res\.status\(400\)/);
});

test('PERF-2: 지표 샘플러는 vCenter 사이에 양보한다(첫 DB open 84ms 연속 정지 방지)', () => {
  const s = stripComments(read('metrics/sampler.js'));
  assert.match(s, /await insertVmperf\(vcId, vcRows, ts\);[\s\S]{0,200}await new Promise\(\(r\) => setImmediate\(r\)\);/);
});

test('ARCH-1: 전역 롤업이 첫 수집 중·연결 실패를 따로 센다', () => {
  const s = stripComments(read('store.js'));
  assert.match(s, /vcentersPending: snap\.vcenters\.filter\(\(v\) => v\.status === 'pending'\)\.length/);
  assert.match(s, /vcentersUnreachable: snap\.vcenters\.filter\(\(v\) => v\.status === 'unreachable'\)\.length/);
});
