/**
 * 리눅스 성능 8a단계 반증 F1 회귀 — **같은 키 · 다른 법인**(IP 로 등록한 iDRAC — 키 = IP)에서 서버 창이 다른 법인 엣지로 가지 않고 그 법인 서버를 억제하지 않는다.
 *   실제 centralRouter `GET /api/central/bm-maint` + 실제 엣지 워커 `pullBmMaintNow`(자식 프로세스 · 엣지마다 자기 CONFIG_DIR) + 실제 판정기 + 실제 임계 알림(notify.runBmUsageAlerts).
 *   반증 r1: Edge-B 가 vcA 창을 받아(windows 1 · kept 1) 법인 B 서버의 알림 · 수집을 끊었다(held 1).
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = process.env.TMPDIR || os.tmpdir();
const DIR = fs.mkdtempSync(path.join(TMP, 'bm8afixedge-c-'));
const EDIR_A = fs.mkdtempSync(path.join(TMP, 'bm8afixedge-a-'));
const EDIR_B = fs.mkdtempSync(path.join(TMP, 'bm8afixedge-b-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
const MIN = 60_000;
const NOW = Date.now();
const SHARED = 'shared-central-token-1234567890abcdef';
const REG = [{ id: 'vcA', name: 'PL-A', host: 'a.invalid', collectMode: 'site', remoteAgent: 'Edge-A' }, { id: 'vcB', name: 'US-B', host: 'b.invalid', collectMode: 'site', remoteAgent: 'Edge-B' }];
let srv; let port; const tok = {};

before(async () => {
  fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: REG }));
  fs.writeFileSync(path.join(DIR, 'portal.env'), `CENTRAL_TOKEN=${SHARED}\n`);
  process.env.CENTRAL_TOKEN = SHARED;
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const { store } = await import('../src/store.js');
  store.snapshot = { ...store.get(), vcenters: REG.map((v) => ({ id: v.id, name: v.name })) };
  const tokens = await import('../src/central/agentTokens.js');
  tok.A = tokens.issueAgentToken('Edge-A').token; tok.B = tokens.issueAgentToken('Edge-B').token;
  const app = express(); app.use(express.json()); app.use('/api/central', centralRouter);
  srv = http.createServer(app);
  port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
});
after(() => { try { srv?.close(); } catch { /* */ } for (const d of [DIR, EDIR_A, EDIR_B]) fs.rmSync(d, { recursive: true, force: true }); });

function edge(name, token, dir, vc) {
  const code = `
    const W = await import(${JSON.stringify(path.join(HERE, '../src/agent/bmMaintPull.js'))});
    const r = await W.pullBmMaintNow();
    const R = await import(${JSON.stringify(path.join(HERE, '../src/bmusage/maint/runtime.js'))});
    const Jx = await R.maintJudge({ now: Date.now() });
    const st = Jx.stateFor({ key: '10.0.0.5', vcenterId: ${JSON.stringify(vc)} }, Date.now());
    const N = await import(${JSON.stringify(path.join(HERE, '../src/bmusage/notify.js'))});
    const rows = [{ key: '10.0.0.5', name: 'db', vcenterId: ${JSON.stringify(vc)}, cpu_pct: 99 }];
    const a = await N.runBmUsageAlerts(rows, { alertEnabled: true, alertPct: 90, alertSustainMin: 0, alertRepeatHours: 6, intervalMs: 300000, maintJudge: Jx, targetOf: () => ({ key: '10.0.0.5', vcenterId: ${JSON.stringify(vc)} }) });
    console.log('@@' + JSON.stringify({ r, scopes: st.scopes, held: a.maint?.held ?? null, fires: (a.fires || []).map((f) => f.kind) }));
  `;
  return new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, CONFIG_DIR: dir, CENTRAL_URL: `http://127.0.0.1:${port}`, CENTRAL_TOKEN: token, AGENT_CENTRAL_TOKEN: token, AGENT_NAME: name, DATA_SOURCE: 'live' }, encoding: 'utf8', timeout: 60_000,
  }, (err, so, se) => { const l = String(so).split('\n').find((x) => x.startsWith('@@')); if (!l) reject(new Error(`엣지 자식 출력 없음: ${err?.message || ''}\n${se}\n${so}`.slice(0, 2000))); else resolve(JSON.parse(l.slice(2))); }));
}

test('F1 — IP 키가 겹치는 두 법인 엣지: 법인 A 서버 창은 Edge-A 에만 가고 Edge-B 의 법인 B 서버는 억제하지 않는다(실제 central 라우트 + 실제 엣지 인출)', async () => {
  const E = await import('../src/central/bmUsageEdgePull.js');
  E.putEdgeBmUsage('Edge-A', { ok: true, snap: { targets: [{ key: '10.0.0.5', serviceTag: '', vcenterId: 'vcA' }], maintVer: 1 } });
  E.putEdgeBmUsage('Edge-B', { ok: true, snap: { targets: [{ key: '10.0.0.5', serviceTag: '', vcenterId: 'vcB' }], maintVer: 1 } });
  const S = await import('../src/bmusage/maint/schedule.js');
  const ST = await import('../src/bmusage/maint/store.js');
  const loc = (ms) => S.fmtLocal('Asia/Seoul', ms).replace(' ', 'T');
  await ST.addWindow({ name: 'A 서버 패치', reason: 'A 법인만', target: { kind: 'server', keys: ['10.0.0.5'] }, vcenterId: 'vcA', tz: 'Asia/Seoul',
    schedule: { kind: 'once', start: loc(NOW - 30 * MIN), end: loc(NOW + 90 * MIN) }, scopes: { alerts: true, collect: true } }, { by: 'opA', now: NOW });
  const b = await edge('Edge-B', tok.B, EDIR_B, 'vcB');
  assert.equal(b.r.ok, true); assert.equal(b.r.windows, 0, '반증 r1 — 예전 windows 1 · kept 1');
  assert.equal(b.scopes.alerts, false); assert.equal(b.scopes.collect, false);
  assert.equal(b.held, 0); assert.deepEqual(b.fires, ['over'], '법인 B 서버의 임계 초과는 나간다');
  const a = await edge('Edge-A', tok.A, EDIR_A, 'vcA');
  assert.equal(a.r.windows, 1); assert.equal(a.scopes.alerts, true); assert.equal(a.scopes.collect, true);
  assert.equal(a.held, 1); assert.deepEqual(a.fires, [], '법인 A 서버는 창 안 — 기록만');
});
