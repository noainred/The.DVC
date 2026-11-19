/**
 * v2.929(5단계 · 반증 V14) — 성능 기록 라우트(changes · baseline · compare · focus 목록 · 규칙 읽기)의 도구 권한: 역할에 ‘tools’ 권한이 없으면 403 ·
 *   도구 거부 목록(toolsDenied: bm-usage)이면 403(전역 toolGate). 라우트의 toolsPerm 을 빼면 무엇이 막는지 실제 라우터로 고정한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bm2929gt-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = '';
delete process.env.CENTRAL_URL;
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard'], toolsDenied: { operator: ['bm-usage'], viewer: [] } } }));
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test('V14 — tools 권한 없는 역할 · bm-usage 도구 거부 역할은 성능 기록 라우트 403', async (t) => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const USERS = { viewer: { username: 'v', role: 'viewer', scope: null }, op: { username: 'o', role: 'operator', scope: null } };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}/api/tools/bm-usage`;
  for (const p of ['/perf/K1/changes', '/perf/K1/baseline?metric=cpu_pct', '/perf/K1/compare?aFrom=1&aTo=2&bFrom=3&bTo=4', '/perf/K1/focus', '/focus', '/perf-rules']) {
    for (const u of ['viewer', 'op']) {
      const r = await fetch(`${base}${p}`, { headers: { 'x-u': u } });
      assert.equal(r.status, 403, `${u} ${p}`);
    }
  }
});
