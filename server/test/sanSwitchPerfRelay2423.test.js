/**
 * v2.423 — 엣지 위임 스위치 포트 사용량 시계열 중계: 커서 조회·중복 없는 적재·최신 시각, 청크, 중앙 설정 적용, 라우트 소유권.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sansw-relay-'));

test('perfDb: samplesAfter 커서 → importSamples 중복 건너뜀 → latestSampleTs', async () => {
  const { savePerfSample, samplesAfter, importSamples, latestSampleTs, metaFor, available, _resetForTest } = await import('../src/sanswitch/perfDb.js');
  if (!(await available())) return;
  _resetForTest();
  const now = Date.now();
  await savePerfSample('sw-e', now - 60_000, { 0: 100, 1: 200 }, [{ port: 0, attachedName: 'ARR::1', speed: '16G' }], 3650);
  await savePerfSample('sw-e', now, { 0: 110, 1: 210 }, [], 3650);
  const a = await samplesAfter(0, 3);
  assert.equal(a.rows.length, 3); assert.ok(a.maxRowid >= 3);
  const b = await samplesAfter(a.maxRowid, 100);
  assert.equal(b.rows.length, 1, '커서 뒤 나머지 1행');
  const meta = await metaFor(['sw-e']);
  assert.equal(meta.length, 1); assert.equal(meta[0].name, 'ARR::1');
  // 중앙 쪽 적재: 같은 (device,ts,port) 재전송은 건너뛴다
  const rows = [...a.rows, ...b.rows].map((r) => ({ d: 'sw-c', ts: r.ts, p: r.p, b: r.b }));
  const r1 = await importSamples(rows, [{ d: 'sw-c', p: 0, ts: now, name: 'ARR::1', speed: '16G' }]);
  assert.equal(r1.inserted, 4); assert.equal(r1.skipped, 0);
  const r2 = await importSamples(rows.slice(0, 2), []);
  assert.equal(r2.inserted, 0); assert.equal(r2.skipped, 2, '재전송 중복 없음');
  const r3 = await importSamples([{ d: '', ts: 1, p: 0, b: 1 }, { d: 'sw-c', ts: 'x', p: 0, b: 1 }], []);
  assert.equal(r3.inserted, 0); assert.equal(r3.skipped, 2, '잘못된 행은 버린다');
  const lt = await latestSampleTs(['sw-c', 'sw-none']);
  assert.equal(lt.get('sw-c'), now); assert.equal(lt.has('sw-none'), false);
  _resetForTest();
});

test('perfPush.chunkRows: 크기 기준 분할·순서 유지·한 행이 커도 단독 청크', async () => {
  const { chunkRows } = await import('../src/sanswitch/perfPush.js');
  const rows = Array.from({ length: 100 }, (_, i) => ({ rowid: i + 1, d: 'sw-1', ts: 1700000000000 + i, p: i, b: 12345 }));
  const chunks = chunkRows(rows, 400);
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flat().map((r) => r.rowid), rows.map((r) => r.rowid));
  for (const c of chunks) assert.ok(JSON.stringify(c.map((r) => [r.d, r.ts, r.p, r.b])).length <= 400 + 60);
  assert.equal(chunkRows([rows[0]], 10).length, 1);
});

test('perfSettings.applyCentralPerfSettings: 바뀐 값만 저장, 같으면 false, SANSW_PERF_LOCAL=1 이면 무시', async () => {
  const { loadPerfSettings, applyCentralPerfSettings, _resetForTest } = await import('../src/sanswitch/perfSettings.js');
  _resetForTest();
  assert.equal(loadPerfSettings().enabled, false, '기본 꺼짐');
  assert.equal(applyCentralPerfSettings({ enabled: true, intervalMs: 120_000 }), true);
  assert.equal(loadPerfSettings().enabled, true); assert.equal(loadPerfSettings().intervalMs, 120_000);
  assert.equal(applyCentralPerfSettings({ enabled: true, intervalMs: 120_000 }), false, '동일 값은 무변경');
  process.env.SANSW_PERF_LOCAL = '1';
  assert.equal(applyCentralPerfSettings({ enabled: false }), false);
  assert.equal(loadPerfSettings().enabled, true, '현장 고정');
  delete process.env.SANSW_PERF_LOCAL;
  assert.equal(applyCentralPerfSettings({ enabled: false }), true);
});

let server, base, tokens;
before(async () => {
  process.env.CENTRAL_TOKEN = '';
  tokens = await import('../src/central/agentTokens.js');
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json());
  app.use('/api/central', centralRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

test('중앙 /sanswitch-perf: 개별 토큰 엣지는 자기 위임 스위치 표본만 적재(미위임 드롭) + config 응답에 perf 설정', async () => {
  const { available, latestSampleTs, _resetForTest } = await import('../src/sanswitch/perfDb.js');
  if (!(await available())) return;
  const { saveDevice } = await import('../src/sanswitch/registry.js');
  const mine = saveDevice({ type: 'brocade', name: 'WA-1', host: '10.93.95.37', username: 'admin', password: 'x', agent: 'agent-WA', collectMethod: 'ssh' });
  const other = saveDevice({ type: 'brocade', name: 'OC2-1', host: '10.94.41.233', username: 'admin', password: 'x', agent: '', collectMethod: 'ssh' });
  const tok = tokens.issueAgentToken('agent-WA', { by: 'test' });
  const token = tok.token || tok;
  const now = Date.now();
  const res = await fetch(`${base}/api/central/sanswitch-perf`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': token },
    body: JSON.stringify({ agent: 'agent-WA', chunk: 0, chunks: 1,
      rows: [[mine.id, now - 1000, 0, 500], [mine.id, now + 3600_000, 1, 600], [other.id, now, 0, 999]],
      meta: [[mine.id, 0, now, 'ARR::9', '', '16G', 'F-Port'], [other.id, 0, now, 'X', '', '', '']] }),
  });
  const j = await res.json();
  assert.equal(res.status, 200, JSON.stringify(j));
  assert.equal(j.inserted, 2); assert.equal(j.dropped, 1, '미위임 스위치 표본은 드롭');
  const lt = await latestSampleTs([mine.id, other.id]);
  assert.ok(lt.get(String(mine.id)) <= Date.now(), '미래 ts 는 수신 시각으로 clamp');
  assert.equal(lt.has(String(other.id)), false);
  const cfg = await (await fetch(`${base}/api/central/sanswitch-config?agent=agent-WA`, { headers: { 'X-Central-Token': token } })).json();
  assert.ok(cfg.perf && typeof cfg.perf.enabled === 'boolean' && cfg.perf.intervalMs >= 60_000, 'perf 설정 동봉');
  _resetForTest();
});
