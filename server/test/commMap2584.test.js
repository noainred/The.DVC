/**
 * 통신 지도(v2.584) 회귀 — 이 화면이 만들 수 있는 **최악의 거짓**을 막는다:
 *   ① 기록 없는 엣지를 '정상' 으로 칠하기  ② 옛 거부가 방금 온 정상 수신을 덮기
 *   ③ 담당을 모르는 자원을 아무 엣지에나 붙이기  ④ 상한으로 자른 것을 조용히 숨기기
 *   ⑤ 서버 사유 코드와 웹 문구가 어긋나기  ⑥ 범위 계정에 전 법인 엣지 주소가 나가기
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const { buildCommMap, aliasMap, originOf, REASON_SEVERITY, RES_MAX_PER_KIND, DIRECT_MAX_PER_KIND, EDGE_STATES } = await import('../src/commmap/build.js');

const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000; // 정시 −30분(v2.517 규약 — 경계에서 떨어뜨린 고정 기준)
const cols = [
  { id: 'gm1', name: 'GM1', url: 'https://10.0.0.1:4000/api?x=1', enabled: true, datacenter: 'GM' },
  { id: 'hg', name: 'HG', url: 'https://10.0.0.2:4000', enabled: true },
  { id: 'off', name: 'OFF', url: 'https://10.0.0.3:4000', enabled: false },
];

test('① 기록이 둘 다 없으면 unknown — 정상이 아니다', () => {
  const r = buildCommMap({ now: NOW, collectors: cols });
  const gm1 = r.edges.find((e) => e.id === 'gm1');
  assert.equal(gm1.state, 'unknown');
  assert.deepEqual(gm1.reasons, ['pull-none', 'push-none']);
  assert.equal(r.edges.find((e) => e.id === 'off').state, 'disabled');
  assert.equal(r.counts.byState.unknown, 2);
  assert.equal(r.counts.byState.disabled, 1);
  assert.equal(r.counts.byState.ok, 0);
});

test('pull 정상 + push 신선이면 ok · push 가 관측 간격×3 을 넘기면 warn(push-stale)', () => {
  const status = { gm1: { at: NOW - 30_000, ok: true }, hg: { at: NOW - 30_000, ok: true } };
  const ingest = { rows: [
    { agent: 'GM1', pushes: 10, wireBytes: 5000, bytesPerSec: 1, intervalSec: 60, lastAt: NOW - 90_000, byEndpoint: [{ endpoint: '/inventory', count: 10, wireBytes: 5000, lastAt: NOW - 90_000 }] },
    { agent: 'hg', pushes: 3, wireBytes: 100, bytesPerSec: 1, intervalSec: 600, lastAt: NOW - 1_900_000, byEndpoint: [] },
  ] };
  const r = buildCommMap({ now: NOW, collectors: cols, status, ingest, siteStaleMs: 300_000 });
  const gm1 = r.edges.find((e) => e.id === 'gm1'); const hg = r.edges.find((e) => e.id === 'hg');
  assert.equal(gm1.state, 'ok'); assert.deepEqual(gm1.reasons, []);
  assert.equal(gm1.push.freshMs, 300_000);           // max(siteStale, 60s×3)
  assert.equal(hg.push.freshMs, 1_800_000);          // 600s × 3
  assert.equal(hg.push.state, 'stale'); assert.equal(hg.state, 'warn'); assert.deepEqual(hg.reasons, ['push-stale']);
  // 표시 이름(GM1)으로 기록된 통계가 id(gm1)로 접혔다
  assert.equal(gm1.push.pushes, 10);
});

test('② 거부는 마지막 정상 수신보다 뒤일 때만 push-rejected · 이름은 unverified', () => {
  const status = { gm1: { at: NOW - 10_000, ok: true } };
  const ingest = { rows: [{ agent: 'gm1', pushes: 5, wireBytes: 1, lastAt: NOW - 60_000, intervalSec: 60, byEndpoint: [] }] };
  const newer = buildCommMap({ now: NOW, collectors: cols, status, ingest, rejects: { rows: [{ agent: 'gm1', total: 2, lastAt: NOW - 30_000, lastKind: 'auth', lastReason: '토큰 불일치' }] } });
  const g1 = newer.edges.find((e) => e.id === 'gm1');
  assert.equal(g1.push.state, 'rejected'); assert.equal(g1.state, 'fail'); assert.ok(g1.reasons.includes('push-rejected'));
  assert.equal(g1.push.rejects.unverified, true);
  const older = buildCommMap({ now: NOW, collectors: cols, status, ingest, rejects: { rows: [{ agent: 'gm1', total: 2, lastAt: NOW - 120_000, lastKind: 'auth', lastReason: 'x' }] } });
  const g2 = older.edges.find((e) => e.id === 'gm1');
  assert.equal(g2.push.state, 'ok'); assert.equal(g2.state, 'ok');
  assert.ok(g2.push.rejects, '옛 거부도 기록은 남긴다(상태만 안 바꾼다)');
  assert.equal(newer.rejectsUnverified, true);
});

test('pull 실패·인증 실패·저하·정체 불일치 판정', () => {
  const status = {
    gm1: { at: NOW, ok: false, error: '수집 서버 토큰 불일치(인증 실패)', fails: 3 },
    hg: { at: NOW, ok: true, degraded: true, error: 'timeout', fails: 1, identity: { issue: { reason: '다른 엣지' } } },
  };
  const r = buildCommMap({ now: NOW, collectors: cols, status });
  const gm1 = r.edges.find((e) => e.id === 'gm1'); const hg = r.edges.find((e) => e.id === 'hg');
  assert.equal(gm1.state, 'fail'); assert.ok(gm1.reasons.includes('pull-auth')); assert.ok(!gm1.reasons.includes('pull-fail'));
  assert.equal(hg.state, 'warn'); assert.ok(hg.reasons.includes('pull-degraded')); assert.ok(hg.reasons.includes('pull-identity'));
  const plain = buildCommMap({ now: NOW, collectors: cols, status: { gm1: { at: NOW, ok: false, error: 'ECONNREFUSED', fails: 2 } } });
  assert.ok(plain.edges.find((e) => e.id === 'gm1').reasons.includes('pull-fail'));
  const off = buildCommMap({ now: NOW, collectors: cols, status, pullIntervalMs: 0 });
  assert.ok(off.edges.find((e) => e.id === 'hg').reasons.includes('puller-off'));
  assert.equal(off.hub.pullerEnabled, false);
});

test('③ 자원 배정 — 등록값 우선 · 관측 pusher 가 다르면 agentMismatch · 모르는 이름은 unassigned', () => {
  const vcenters = [
    { id: 'vc-a', name: 'A', collectMode: 'site', remoteAgent: 'GM1' },
    { id: 'vc-b', name: 'B', collectMode: 'site', remoteAgent: 'gm1' },
    { id: 'vc-c', name: 'C', collectMode: 'site', remoteAgent: 'ghost' },
    { id: 'vc-d', name: 'D', collectMode: 'site' },
    { id: 'vc-e', name: 'E', collectMode: 'direct' },
    { id: 'vc-f', name: 'F', collectMode: 'site' },
  ];
  const snapVcenters = [
    { id: 'vc-a', collectSource: 'site', collectedBy: 'hg', receivedAt: NOW - 1000 },     // 등록 GM1 vs 관측 hg
    { id: 'vc-b', collectSource: 'site', status: 'pending' },
    { id: 'vc-e', status: 'unreachable', stale: true, error: 'boom' },
    { id: 'vc-f', collectSource: 'site', collectedBy: 'HG', receivedAt: NOW - 1000 },     // 등록 비었고 관측만 있다 → 관측으로 배정
    { id: 'vc-mock', name: 'M', receivedAt: NOW },                                         // 등록부에 없다(목 폴백)
  ];
  const storage = [{ id: 's1', name: 'S1', type: 'unity480', agent: 'gm1' }, { id: 's2', name: 'S2', type: 'isilon', agent: '' }, { id: 's3', name: 'S3', type: 'vmax', agent: 'nobody' }];
  const counts = new Map([['vc-a', { hosts: 3, vms: 40 }]]);
  const r = buildCommMap({ now: NOW, collectors: cols, vcenters, snapVcenters, vcCounts: counts, storage, status: { gm1: { at: NOW, ok: true }, hg: { at: NOW, ok: true } } });
  const gm1 = r.edges.find((e) => e.id === 'gm1'); const hg = r.edges.find((e) => e.id === 'hg');
  const a = gm1.resources.vcenter.items.find((x) => x.id === 'vc-a');
  assert.ok(a, '등록값(GM1→gm1)이 이긴다'); assert.equal(a.agentMismatch, true); assert.equal(a.collectedBy, 'hg'); assert.equal(a.hosts, 3); assert.equal(a.state, 'ok');
  assert.equal(gm1.resources.vcenter.items.find((x) => x.id === 'vc-b').state, 'pending');
  assert.ok(hg.resources.vcenter.items.find((x) => x.id === 'vc-f'), '등록이 비면 관측 pusher 로');
  assert.equal(gm1.resources.storage.items.length, 1);
  assert.deepEqual(r.unassigned.map((u) => [u.id, u.reason]).sort(), [['s3', 'agent-unknown'], ['vc-c', 'agent-unknown'], ['vc-d', 'agent-empty']]);
  assert.equal(r.hub.direct.vcenter.items.find((x) => x.id === 'vc-e').state, 'fail');
  const m = r.hub.direct.vcenter.items.find((x) => x.id === 'vc-mock');
  assert.ok(m && m.registryMissing === true, '등록부에 없는 스냅샷 vCenter 는 밝힌다');
  assert.equal(r.hub.direct.storage.total, 1);
  assert.equal(r.counts.unassigned, 3);
  // 위임 자원이 있는데 push 기록이 없다 → warn(push-none-expected)
  assert.ok(gm1.reasons.includes('push-none-expected')); assert.equal(gm1.state, 'warn');
});

test('④ 상한 — 종류별로 자르고 omitted 로 밝힌다(직접 자원도)', () => {
  const storage = Array.from({ length: RES_MAX_PER_KIND + 7 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, agent: 'gm1' }));
  const pdu = Array.from({ length: DIRECT_MAX_PER_KIND + 2 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
  const r = buildCommMap({ now: NOW, collectors: cols, storage, pdu });
  const gm1 = r.edges.find((e) => e.id === 'gm1');
  assert.equal(gm1.resources.storage.items.length, RES_MAX_PER_KIND);
  assert.equal(gm1.resources.storage.omitted, 7);
  assert.equal(gm1.resources.storage.total, RES_MAX_PER_KIND + 7);
  assert.equal(gm1.resourceCounts.omitted, 7);
  assert.equal(r.hub.direct.pdu.omitted, 2);
  assert.equal(r.counts.resources, RES_MAX_PER_KIND + 7, '개수는 전체 기준');
});

test('통신 점검 최신값·엣지 보고 — 있으면 싣고 실패면 link-fail, 없으면 null(정상으로 칠하지 않는다)', () => {
  const latestLinks = [
    { link_id: 'central->edge|central|GM1', ts: NOW, ok: 0, phase: 'tcp', fail_kind: 'refused', streak: 4, since_ts: NOW - 1000, total_ms: 12 },
    { link_id: 'edge->central|GM1|central', ts: NOW, ok: 1, phase: '', fail_kind: '', streak: 1, since_ts: NOW, total_ms: 5 },
  ];
  const r = buildCommMap({ now: NOW, collectors: cols, status: { gm1: { at: NOW, ok: true } }, latestLinks, edgeReports: { GM1: { at: NOW - 5 * 3_600_000, stale: true } }, linkCheckEnabled: true });
  const gm1 = r.edges.find((e) => e.id === 'gm1');
  assert.equal(gm1.linkCheck['central->edge'].ok, false); assert.equal(gm1.linkCheck['central->edge'].failKind, 'refused');
  assert.equal(gm1.linkCheck['edge->central'].ok, true);
  assert.equal(gm1.linkCheck['edge->central-pull'], null);
  assert.ok(gm1.reasons.includes('link-fail')); assert.ok(gm1.reasons.includes('edge-report-stale'));
  assert.equal(gm1.state, 'fail');
  assert.equal(gm1.linkCheck.reportStale, true);
});

test('원산지만 싣는다(토큰이 실릴 수 있는 경로·쿼리 제거) · aliasMap 은 id/이름 모두 id 로', () => {
  assert.equal(originOf('https://10.0.0.1:4000/api/collector/export?token=abc'), 'https://10.0.0.1:4000');
  assert.equal(originOf(''), '');
  assert.equal(originOf('not a url?x=1'), 'not a url');
  const m = aliasMap(cols);
  assert.equal(m.get('gm1'), 'gm1'); assert.equal(m.get('hg'), 'hg');
  const r = buildCommMap({ now: NOW, collectors: cols });
  assert.equal(r.edges.find((e) => e.id === 'gm1').origin, 'https://10.0.0.1:4000');
  assert.ok(!JSON.stringify(r).includes('token'));
});

test('⑤ 사유 코드 ↔ 웹 문구 1:1 · 상태 집합 ↔ 웹 라벨 · 문구에 백틱·3단 대시 없음', () => {
  const web = fs.readFileSync(new URL('../../web/src/views/tools/commMapText.js', import.meta.url), 'utf8');
  const codes = [...web.matchAll(/^  '([a-z-]+)': \{ title:/gm)].map((m) => m[1]).sort();
  assert.deepEqual(codes, Object.keys(REASON_SEVERITY).sort());
  for (const st of EDGE_STATES) assert.ok(new RegExp(`\\b${st}: '`).test(web), `STATE_LABEL 에 ${st}`);
  const body = stripComments(web);   // v2.613 TESTDOC2613-08
  const strings = [...body.matchAll(/'([^'\n]*)'/g)].map((m) => m[1]);
  for (const s of strings) { assert.ok(!s.includes('`'), `백틱: ${s}`); assert.ok((s.match(/ — /g) || []).length <= 1, `3단 대시: ${s}`); }
});

test('⑥ 라우트 — admin 200 · 범위 계정 403 · 응답에 토큰 없음', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm2584-'));
  fs.writeFileSync(path.join(dir, 'collectors.json'), JSON.stringify({ collectors: [{ id: 'gm1', name: 'GM1', url: 'https://127.0.0.1:1', token: 'SECRET-TOKEN-XYZ', enabled: true }] }));
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
    const a = await fetch(base + '/api/tools/comm-map'); const at = await a.text();
    const s = await fetch(base + '/api/tools/comm-map', { headers: { 'x-s': '1' } });
    console.log(JSON.stringify({ a: a.status, s: s.status, hasToken: at.includes('SECRET-TOKEN'), body: JSON.parse(at) }));
    srv.close(); process.exit(0);
  `;
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 });
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  const r = JSON.parse(line);
  assert.equal(r.a, 200); assert.equal(r.s, 403); assert.equal(r.hasToken, false);
  assert.equal(r.body.ok, true); assert.equal(r.body.edges.length, 1); assert.equal(r.body.edges[0].origin, 'https://127.0.0.1:1');
  assert.equal(r.body.edges[0].state, 'unknown');
  assert.ok(r.body.edges[0].reasons.includes('puller-off'));
  assert.ok(Array.isArray(r.body.hub.direct.vcenter.items) && r.body.hub.direct.vcenter.items.length > 0, '목 폴백 vCenter 는 직접 자원(registryMissing)');
  assert.equal(r.body.hub.direct.vcenter.items[0].registryMissing, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
