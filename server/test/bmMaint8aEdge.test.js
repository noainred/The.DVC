/**
 * 리눅스 성능 8a단계 — 정비 창 **중앙 → 엣지 배포 성공 왕복**(실제 centralRouter `/api/central/bm-maint` + 실제 엣지 워커 `pullBmMaintNow` — 엣지는 자식 프로세스(자기 CONFIG_DIR)).
 *   ① 개별 토큰만 · 그 엣지 법인 창만(다른 법인 창 없음) · 태그 창은 중앙이 그 엣지 대상의 키로 펼친다 · 엣지가 같은 정규화로 다시 자른다 ·
 *      **엣지 판정 = 중앙 판정**(같은 판정 코어 · 같은 대상 — 중앙은 수동 태그 · 엣지는 펼친 keys) · 다음 인출에 적용 서명 → 중앙 배포 현황 ‘applied’
 *   ② 공유 토큰(?agent=)은 창을 받지 못한다(distribute:false — 엣지는 지난 배포본 그대로 · 24시간 시한)
 *   ③ 중앙 창 파일 손상 → 503(빈 목록을 보내지 않는다) · 엣지는 지난 배포본 유지
 *   ④ 엣지 봉투의 정비 창 상태 · 용량 행은 중앙 정제(아는 필드만 · 대상 밖 키 버림 · 시각 clamp)
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
const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm8aedge-c-'));
const EDIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm8aedge-e-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
const MIN = 60_000;
const T0 = Date.now();

let srv; let port; let tokA; let SHARED; let ST; let S; let DP;
const REGISTRY = [{ id: 'vcE', name: 'KR-EDGE', host: 'e.invalid', collectMode: 'site', remoteAgent: 'Edge-A' }, { id: 'vcC', name: 'KR-CENTRAL', host: 'c.invalid' }];
const loc = (ms) => S.fmtLocal('Asia/Seoul', ms).replace(' ', 'T');

before(async () => {
  SHARED = 'shared-central-token-1234567890abcdef';
  fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: REGISTRY }));
  fs.writeFileSync(path.join(DIR, 'portal.env'), `CENTRAL_TOKEN=${SHARED}\n`);
  process.env.CENTRAL_TOKEN = SHARED;
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const { store } = await import('../src/store.js');
  store.snapshot = { ...store.get(), vcenters: REGISTRY.map((v) => ({ id: v.id, name: v.name })) };
  const tokens = await import('../src/central/agentTokens.js');
  tokA = tokens.issueAgentToken('Edge-A').token;
  S = await import('../src/bmusage/maint/schedule.js');
  ST = await import('../src/bmusage/maint/store.js');
  DP = await import('../src/bmusage/maint/deploy.js');
  const app = express();
  app.use(express.json());
  app.use('/api/central', centralRouter);
  srv = http.createServer(app);
  port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
});
after(() => { try { srv?.close(); } catch { /* */ } fs.rmSync(DIR, { recursive: true, force: true }); fs.rmSync(EDIR, { recursive: true, force: true }); });

/** 엣지 자식 — 한 번 인출하고 결과 · 배포본 · 판정을 출력. */
function edgeOnce(token) {
  const code = `
    const W = await import(${JSON.stringify(path.join(HERE, '../src/agent/bmMaintPull.js'))});
    const r = await W.pullBmMaintNow();
    const ST = await import(${JSON.stringify(path.join(HERE, '../src/bmusage/maint/store.js'))});
    const R = await import(${JSON.stringify(path.join(HERE, '../src/bmusage/maint/runtime.js'))});
    const w = ST.windowsForJudge(Date.now());
    const J = await R.maintJudge({ now: ${T0} });
    const st = (k) => J.stateFor({ key: k, vcenterId: 'vcE' }, ${T0});
    console.log('@@' + JSON.stringify({ r, ids: w.windows.map((x) => x.id).sort(), origins: [...new Set(w.windows.map((x) => x.origin))], deployed: w.deployed,
      tagKeys: (w.windows.find((x) => x.target.kind === 'tag') || {}).target?.keys || null, E1: st('E1'), E2: st('E2'), E3: st('E3') }));
  `;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, CONFIG_DIR: EDIR, CENTRAL_URL: `http://127.0.0.1:${port}`, CENTRAL_TOKEN: token, AGENT_CENTRAL_TOKEN: token, AGENT_NAME: 'Edge-A', DATA_SOURCE: 'live' },
      encoding: 'utf8', timeout: 60_000,
    }, (err, stdout, stderr) => {
      const line = String(stdout).split('\n').find((l) => l.startsWith('@@'));
      if (!line) return reject(new Error(`엣지 자식 출력 없음: ${err?.message || ''}\n${stderr}\n${stdout}`.slice(0, 2000)));
      resolve(JSON.parse(line.slice(2)));
    });
  });
}

test('① 왕복 — 개별 토큰 · 자기 법인 창만 · 태그 펼침 · 엣지 판정 = 중앙 판정 · 적용 서명', async () => {
  const sched = { kind: 'once', start: loc(T0 - 30 * MIN), end: loc(T0 + 90 * MIN) };
  const corp = await ST.addWindow({ name: '법인 패치', reason: 'r', target: { kind: 'corp' }, vcenterId: 'vcE', tz: 'Asia/Seoul', schedule: sched, scopes: { alerts: true } }, { by: 'own', now: T0 });
  const tag = await ST.addWindow({ name: '웹 롤아웃', reason: 'r', target: { kind: 'tag', tag: 'role:web' }, vcenterId: 'vcE', tz: 'Asia/Seoul', schedule: sched, scopes: { focus: true } }, { by: 'own', now: T0 });
  const srvW = await ST.addWindow({ name: 'E1 교체', reason: 'r', target: { kind: 'server', keys: ['E1'] }, vcenterId: 'vcE', tz: 'Asia/Seoul', schedule: sched, scopes: { collect: true } }, { by: 'op', now: T0 });
  const other = await ST.addWindow({ name: '중앙 법인', reason: 'r', target: { kind: 'corp' }, vcenterId: 'vcC', tz: 'Asia/Seoul', schedule: sched, scopes: { alerts: true } }, { by: 'own', now: T0 });
  // 중앙이 아는 그 엣지 대상(봉투) · 수동 태그(E2 = web)
  const E = await import('../src/central/bmUsageEdgePull.js');
  E.putEdgeBmUsage('Edge-A', { ok: true, snap: { targets: [{ key: 'E1', serviceTag: 'E1', vcenterId: 'vcE' }, { key: 'E2', serviceTag: 'E2', vcenterId: 'vcE' }, { key: 'E3', serviceTag: 'E3', vcenterId: 'vcE' }], maintVer: 1 } });
  const FT = await import('../src/insights/fleetTags.js');
  assert.equal(FT.setFleetPurpose('e2', { role: 'web' }, { knownRoles: ['db', 'web', 'cache', 'file', 'general'] }).ok, true);
  const e1 = await edgeOnce(tokA);
  assert.equal(e1.r.ok, true, JSON.stringify(e1.r));
  assert.deepEqual(e1.ids, [corp.id, tag.id, srvW.id].sort(), '자기 법인 창만(다른 법인 창 없음)');
  assert.ok(!e1.ids.includes(other.id));
  assert.deepEqual(e1.origins, ['central']);
  assert.deepEqual(e1.tagKeys, ['E2'], '태그 창은 중앙이 그 엣지 대상의 키로 펼친다');
  // 엣지 판정 = 중앙 판정(같은 대상)
  const R = await import('../src/bmusage/maint/runtime.js');
  const C = await R.maintJudge({ now: T0 });
  for (const k of ['E1', 'E2', 'E3']) {
    const c = C.stateFor({ key: k, serviceTag: k, vcenterId: 'vcE' }, T0);
    assert.deepEqual(e1[k].scopes, c.scopes, `${k} 범위`); assert.deepEqual(e1[k].until, c.until, `${k} 시한`);
  }
  assert.equal(e1.E2.scopes.focus, true); assert.equal(e1.E3.scopes.focus, false); assert.equal(e1.E1.scopes.collect, true);
  // 다음 인출 — 적용 서명이 중앙 현황에 ‘applied’
  const e2 = await edgeOnce(tokA);
  assert.equal(e2.r.ok, true);
  const view = await DP.deployStatusView(E.listEdgeBmUsage(), Date.now());
  const row = view.edges.find((x) => x.agent.toLowerCase() === 'edge-a');
  assert.equal(row.status, 'applied', JSON.stringify(row));
});

test('② 공유 토큰은 창을 받지 못한다 — 지난 배포본 그대로', async () => {
  const before0 = fs.readFileSync(path.join(EDIR, 'maintenance-windows-deployed.json'), 'utf8');
  const r = await edgeOnce(SHARED);
  assert.equal(r.r.distribute, false); assert.equal(r.r.reason, 'unverified');
  assert.equal(fs.readFileSync(path.join(EDIR, 'maintenance-windows-deployed.json'), 'utf8'), before0, '바꾸지 않는다');
  assert.equal(r.deployed.n, 3);
});

test('③ 중앙 창 파일 손상 → 503 · 엣지는 지난 배포본 유지', async () => {
  fs.writeFileSync(path.join(DIR, 'maintenance-windows.json'), '{broken');
  ST._resetMaintStoreForTest();
  const res = await fetch(`http://127.0.0.1:${port}/api/central/bm-maint?agent=Edge-A`, { headers: { 'X-Central-Token': tokA, 'X-Agent-Name': 'Edge-A' } });
  assert.equal(res.status, 503);
  const r = await edgeOnce(tokA);
  assert.equal(r.r.ok, false); assert.equal(r.deployed.n, 3, '지난 배포본 유지(24시간 시한)');
});

test('④-0 엣지 인출 본문 판정(순수) — 배포 판정 칸 · 서명 꼴 · 창 배열(봉투 모양 { ok, node } 가 아니다)', async () => {
  const { maintBodyOk } = await import('../src/agent/bmMaintPull.js');
  assert.equal(maintBodyOk({ ok: true, distribute: true, sig: 'a'.repeat(32), windows: [] }), true);
  assert.equal(maintBodyOk({ ok: true, distribute: false }), true);
  assert.equal(maintBodyOk({ ok: true, node: {} }), false);
  assert.equal(maintBodyOk({ ok: true, distribute: true, sig: 'zz', windows: [] }), false);
  assert.equal(maintBodyOk({ ok: true, distribute: true, sig: 'a'.repeat(32), windows: 'x' }), false);
  assert.equal(maintBodyOk({ ok: false, distribute: false }), false);
});

test('④ 봉투 정제 — 정비 창 상태 · 용량 행(대상 밖 키 · 모르는 열거 · 문자열 수치 · 시각)', async () => {
  const { sanitizeBmUsageSnap } = await import('../src/central/bmUsageEdgePull.js');
  const rcv = Date.now();
  const snap = sanitizeBmUsageSnap({
    node: { agent: 'Edge-A', role: 'edge' }, targets: [{ key: 'E1', vcenterId: 'vcE' }], rows: [], maintVer: 1, capacityVer: 1,
    maint: { deployed: { at: rcv + 9e9, sig: 'nothex', n: '3', stale: 'yes' }, local: 2, byWindow: { 'mw-abc1234': { alerts: '5', after: -1, evil: 9 }, 'bad id': { alerts: 1 } }, leak: { n: 0, last: 4, at: rcv } },
    capacity: { at: rcv, day: '2026-11-06', rows: [
      { key: 'E1', kind: 'fs', res: '/data1', status: 'forecast', current: '87.2', daysToTarget: 4, dateToTarget: '2026-11-10', conf: 'high', r2: 0.94, evil: '<script>' },
      { key: 'OTHER', kind: 'fs', res: '/', status: 'forecast' },
      { key: 'E1', kind: 'disk', res: '/', status: 'forecast' },
      { key: 'E1', kind: 'inode', res: '/', status: 'pwned' },
      { key: 'E1', kind: 'mem', res: 'mem', status: 'unstable', conf: 'super', dateToTarget: 'tomorrow' },
    ] },
  }, { receivedAt: rcv });
  assert.equal(snap.maintVer, 1); assert.equal(snap.capacityVer, 1);
  assert.ok(snap.maint.deployed.at <= rcv, '엣지 시각은 수신 시각으로'); assert.equal(snap.maint.deployed.sig, ''); assert.equal(snap.maint.deployed.n, 3); assert.equal(snap.maint.deployed.stale, false);
  assert.deepEqual(Object.keys(snap.maint.byWindow), ['mw-abc1234']); assert.deepEqual(snap.maint.byWindow['mw-abc1234'], { alerts: 5, after: 0, hold: 0, focus: 0, collect: 0, collectFail: 0 });
  assert.equal(snap.capacity.rows.length, 2); assert.equal(snap.capacity.dropped, 3);
  const fs1 = snap.capacity.rows[0];
  assert.equal(fs1.current, 87.2); assert.equal('evil' in fs1, false);
  assert.equal(snap.capacity.rows[1].conf, null); assert.equal(snap.capacity.rows[1].dateToTarget, null);
});
