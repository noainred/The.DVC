// 3단 지도(장비 → 엣지 → 메인, v2.588) — 조립 규칙 + 라우트 + 웹 키 대조.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDeviceFlow, groupOf, channelsOf, worstChannel, ITEM_MAX, DEV_KINDS, CHANNELS, ITEM_STATES, GROUP_TONES } from '../src/devflow/build.js';
import { buildCommMap } from '../src/commmap/build.js';

// 기준 시각은 경계에서 떨어뜨려 고정(CLAUDE.md v2.517 규약)
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

const flow = {
  routes: [
    { id: 'central:POST /inventory', kind: 'push', cat: 'inv' },
    { id: 'central:GET /storage-config', kind: 'pull', cat: 'storage' },
    { id: 'collector:GET /export', kind: 'cpull', cat: 'inv' },
    { id: 'collector:POST /upgrade', kind: 'cpush', cat: 'ops' },
  ],
  edges: [{ id: 'gm1', name: 'GM1', registered: true }, { id: '?ghost', name: 'ghost', registered: false, unverifiedOnly: true }],
  links: [
    { edge: 'gm1', route: 'central:POST /inventory', state: 'ok', okAt: NOW - 1000, count: 3, bytes: 100 },
    { edge: 'gm1', route: 'central:GET /storage-config', state: 'fail', okAt: NOW - 9000, failAt: NOW - 500, count: 2, failCount: 1 },
    { edge: 'gm1', route: 'collector:GET /export', state: 'stale', okAt: NOW - 99 * 60_000, count: 1 },
    { edge: '?ghost', route: 'central:POST /inventory', state: 'fail', failAt: NOW, unverified: true },
  ],
  since: NOW - HOUR,
};

test('① 등록만 알고 판정하지 않은 묶음은 초록이 아니다(neutral)', () => {
  const g = groupOf('storage', [{ id: 'a', name: 'A', state: 'registered' }, { id: 'b', name: 'B', state: 'disabled' }]);
  assert.equal(g.tone, 'neutral');
  assert.equal(groupOf('vcenter', [{ name: 'x', state: 'ok' }, { name: 'y', state: 'stale' }]).tone, 'warn');
  assert.equal(groupOf('vcenter', [{ name: 'x', state: 'ok' }, { name: 'y', state: 'fail' }]).tone, 'fail');
  assert.equal(groupOf('vcenter', [{ name: 'x', state: 'ok' }]).tone, 'ok');
});

test('⑥ 개수는 전량, 목록은 심각한 것부터 상한까지 + 뺀 개수', () => {
  const list = Array.from({ length: ITEM_MAX + 7 }, (_, i) => ({ id: String(i), name: `n${i}`, state: i === 50 ? 'fail' : 'registered' }));
  const g = groupOf('idrac', list);
  assert.equal(g.total, ITEM_MAX + 7); assert.equal(g.items.length, ITEM_MAX); assert.equal(g.omitted, 7);
  assert.equal(g.items[0].state, 'fail'); assert.equal(g.counts.fail, 1); assert.equal(g.counts.registered, ITEM_MAX + 6);
});

test('②③ 채널 — 기록 없음은 none, 실패 > 낡음 > 정상', () => {
  const ch = channelsOf('gm1', flow);
  assert.equal(ch.up.state, 'ok'); assert.equal(ch.down.state, 'fail'); assert.equal(ch.cpull.state, 'stale'); assert.equal(ch.cpush.state, 'none');
  assert.equal(ch.cpush.lastOkAt, null);
  assert.equal(worstChannel(ch), 'fail');
  assert.equal(worstChannel(channelsOf('nobody', flow)), 'none');
  assert.deepEqual(ch.down.cats, ['storage']);
});

test('조립 — 엣지 장비 묶음·메인 직접·iDRAC·미귀속·등록부 밖 엣지', () => {
  const comm = buildCommMap({
    now: NOW,
    collectors: [{ id: 'gm1', name: 'GM1', url: 'https://10.0.0.1:3000/p', enabled: true }],
    status: { gm1: { ok: true, at: NOW - 60_000 } },
    vcenters: [{ id: 'vc-a', name: 'VC-A', collectMode: 'site', remoteAgent: 'gm1' }, { id: 'vc-d', name: 'VC-D', collectMode: 'direct' }],
    snapVcenters: [{ id: 'vc-a', status: 'ok', collectSource: 'site', collectedBy: 'gm1', receivedAt: NOW - 30_000 }, { id: 'vc-d', status: 'ok' }],
    storage: [{ id: 's1', name: 'S1', agent: 'gm1' }, { id: 's2', name: 'S2' }, { id: 's3', name: 'S3', agent: 'nowhere' }],
    pdu: [{ id: 'p1', name: 'P1', agent: 'gm1' }],
    resMax: Infinity, directMax: Infinity,
  });
  const out = buildDeviceFlow({
    now: NOW, comm, flow,
    idracLocal: [{ id: 'i1', name: 'local-1', password: 'PW' }, { id: 'o1', name: 'ome', type: 'ome' }],
    idracRemote: [{ id: 'r1', name: 'edge-1', collectorId: 'gm1', inv: {} }, { id: 'r2', name: 'lost', collectorId: 'zz' }],
    central: { version: '9.9.9' },
  });
  const gm1 = out.edges.find((e) => e.id === 'gm1');
  const kinds = gm1.groups.map((g) => g.kind);
  assert.deepEqual(kinds, ['vcenter', 'idrac', 'storage', 'pdu']);
  assert.equal(gm1.groups.find((g) => g.kind === 'vcenter').reportAt, NOW - 30_000);
  assert.equal(gm1.groups.find((g) => g.kind === 'idrac').reportBasis, 'pull');
  assert.equal(gm1.deviceTotal, 4);
  assert.equal(gm1.line, 'fail');
  // 메인 직접: vCenter 1 · iDRAC 1(OME 제외) · 스토리지 1
  assert.deepEqual(out.main.groups.map((g) => [g.kind, g.total]), [['vcenter', 1], ['idrac', 1], ['storage', 1]]);
  // ⑤ 미귀속: 스토리지 1(agent nowhere) + iDRAC 1(collector zz)
  assert.deepEqual(out.unassigned.map((g) => [g.kind, g.total]), [['idrac', 1], ['storage', 1]]);
  assert.equal(out.totals.devices, 4 + 3 + 2);
  // ④ 등록부 밖 엣지 이름
  const ghost = out.edges.find((e) => e.id === '?ghost');
  assert.equal(ghost.registered, false); assert.equal(ghost.line, 'fail'); assert.equal(ghost.unverifiedOnly, true);
  // 비밀 필드를 옮기지 않는다
  assert.equal(JSON.stringify(out).includes('PW'), false);
  assert.equal(out.main.version, '9.9.9');
});

test('통신 지도 기본 상한은 그대로(resMax 를 안 주면 40)', () => {
  const storage = Array.from({ length: 45 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, agent: 'gm1' }));
  const c = buildCommMap({ now: NOW, collectors: [{ id: 'gm1', name: 'GM1' }], storage });
  assert.equal(c.edges[0].resources.storage.items.length, 40);
  assert.equal(c.edges[0].resources.storage.omitted, 5);
  const all = buildCommMap({ now: NOW, collectors: [{ id: 'gm1', name: 'GM1' }], storage, resMax: Infinity });
  assert.equal(all.edges[0].resources.storage.items.length, 45);
});

test('라우트 — admin 200 · 범위 계정 403 · 토큰·비밀번호 없음', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv2588r-'));
  fs.writeFileSync(path.join(dir, 'collectors.json'), JSON.stringify({ collectors: [{ id: 'gm1', name: 'GM1', url: 'https://127.0.0.1:1/x?token=Q', token: 'SECRET-TOKEN-XYZ', enabled: true }] }));
  fs.writeFileSync(path.join(dir, 'idrac.json'), JSON.stringify({ servers: [{ id: 'i1', name: 'srv1', host: 'https://10.1.1.1', username: 'root', password: 'IDRAC-PW-XYZ' }] }));
  const script = `
    process.env.CONFIG_DIR = ${JSON.stringify(dir)}; process.env.DATA_SOURCE = 'mock'; process.env.AUTH_ENABLED = 'false'; process.env.COLLECTOR_PULL_INTERVAL_MS = '0';
    const express = (await import('express')).default;
    const { store } = await import('../src/store.js');
    try { await store.refresh(); } catch {}
    const { api } = await import('../src/routes/api.js');
    const app = express();
    app.use((req, _res, next) => { req.user = req.get('x-s') ? { username: 'sc', role: 'viewer', scope: { vcenters: ['x'] } } : { username: 'ad', role: 'admin', scope: null }; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const a = await fetch(base + '/api/tools/device-flow'); const at = await a.text();
    const s = await fetch(base + '/api/tools/device-flow', { headers: { 'x-s': '1' } });
    console.log(JSON.stringify({ a: a.status, s: s.status, leak: at.includes('SECRET-TOKEN') || at.includes('token=Q') || at.includes('IDRAC-PW'), body: JSON.parse(at) }));
    srv.close(); process.exit(0);
  `;
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 });
  const r = JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop());
  assert.equal(r.a, 200); assert.equal(r.s, 403); assert.equal(r.leak, false);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.edges[0].id, 'gm1');
  assert.ok(r.body.main.groups.some((g) => g.kind === 'vcenter' && g.total > 0), '목 vCenter 는 메인 직접');
  assert.ok(Array.isArray(r.body.cats) && r.body.cats.length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('웹 문구 키가 서버 코드와 1:1', () => {
  const web = fs.readFileSync(new URL('../../web/src/views/tools/deviceFlowText.js', import.meta.url), 'utf8');
  const block = (name) => web.slice(web.indexOf(`export const ${name}`), web.indexOf('});', web.indexOf(`export const ${name}`)));
  const keysOf = (name) => [...block(name).matchAll(/\b([a-z]+): '/g)].map((m) => m[1]);
  assert.deepEqual(keysOf('DEV_KIND_LABEL').sort(), [...DEV_KINDS].sort());
  assert.deepEqual(keysOf('CHANNEL_LABEL').sort(), [...CHANNELS].sort());
  assert.deepEqual(keysOf('ITEM_STATE_LABEL').sort(), [...ITEM_STATES].sort());
  assert.deepEqual(keysOf('TONE_LABEL').sort(), [...GROUP_TONES].sort());
});
