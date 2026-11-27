/**
 * focusMonBundleB3550.test.js — 서버 집중 모니터링 전체 점검 29 · 30회차가 남긴 것(사용자 "모두 넣어서 구현해줘" — 남은 일 ⑦ · 묶음 B).
 *  E1 상태 사건(키 로그인 거부 · 호스트키)은 대상마다 10분 창에 6건까지 — ok ↔ auth 를 번갈아 보내도 사건 대기열이 차지 않는다(정당한 연속 변화는 그대로)
 *  Q  대기열을 자를 때 사건 수를 다시 센다 · 잘린 줄은 쓴 것으로 표시 · 몇 줄 잘랐는지 센다
 *  O  등록부에 없는 대상이 수집 정의에 남은 것(29회차 전 삭제분)을 10분마다 뺀다 — 등록부를 읽었을 때만
 *  K  주소가 바뀌면 메모리 표본 · 지금 값 · 알림 상태를 버린다(계정 · 포트 · 노드만 바뀌면 남긴다)
 *  C  잘린 서비스 목록 때문의 보류 사건은 '목록 잘림' 을 말한다
 *  D  등록부 손상 중 데모 계정의 서버별 수집 종료는 demoBlockWrite 가 먼저 막는다(남긴 것 확인 — 해당 없음을 고정)
 * 각 시나리오는 저마다 임시 CONFIG_DIR 의 하위 프로세스에서 돈다(모듈 상태가 섞이지 않게).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(HERE, '../src');
const J = (p) => JSON.stringify(path.join(SRC, p));
const EXPRESS = JSON.stringify(path.join(HERE, '../node_modules/express/index.js'));
const sub = (code, env = {}, setup = () => {}) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fmb3550-'));
  try {
    setup(d);
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, CONFIG_DIR: d, DATA_DIR: d, FOCUSMON_SSH_KEY: '', ...env }, encoding: 'utf8', timeout: 60_000 });
    const line = r.stdout.trim().split('\n').pop();
    try { return JSON.parse(line); } catch { throw new Error(`${r.stdout}\n${r.stderr}`); }
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
};

test('E1 — 상태 사건은 대상마다 10분 창에 상한까지(번갈아 보내도 대기열이 차지 않는다) · 다른 대상은 따로 · 창이 지나면 다시', () => {
  const out = sub(`const store = await import(${J('focusmon/store.js')});
    const t0 = Date.now();
    store.setStatus('fm-aaaaaaaa01', { state: 'ok' }, t0);
    for (let i = 0; i < 200; i++) { store.setStatus('fm-aaaaaaaa01', { state: i % 2 ? 'ok' : 'auth' }, t0 + 1000 + i * 1000); }
    store.setStatus('fm-bbbbbbbb02', { state: 'ok' }, t0); store.setStatus('fm-bbbbbbbb02', { state: 'hostkey' }, t0 + 5000);
    const rows1 = store.drainWrites(10000).filter((r) => r.kind === 'e');
    store.setStatus('fm-aaaaaaaa01', { state: 'ok' }, t0 + store.STATUS_EVENT_WINDOW_MS + 300_000);
    store.setStatus('fm-aaaaaaaa01', { state: 'auth' }, t0 + store.STATUS_EVENT_WINDOW_MS + 301_000);
    const rows2 = store.drainWrites(10000).filter((r) => r.kind === 'e');
    console.log(JSON.stringify({ a1: rows1.filter((r) => r.target === 'fm-aaaaaaaa01').length, b1: rows1.filter((r) => r.target === 'fm-bbbbbbbb02').length, held: store.memStats().statusEventsHeld, a2: rows2.length, burst: store.STATUS_EVENT_BURST }));`);
  assert.equal(out.a1, out.burst, '200번 번갈아도 창 상한만큼만(대기열을 채우지 않는다)'); assert.equal(out.b1, 1, '다른 대상은 따로');
  assert.equal(out.held, 100 - out.burst, '넘은 것은 센다'); assert.equal(out.a2, 1, '창이 지나면 다시 적는다');
});

test('Q — 대기열을 자를 때 사건 수를 다시 센다(사건 상한이 일찍 차지 않는다) · 잘린 줄은 쓴 것 · 센다', () => {
  const out = sub(`const store = await import(${J('focusmon/store.js')});
    const t0 = Date.now();
    for (let i = 0; i < 30; i++) store.queueEvent('fm-cccccccc03', 'user', 'x' + i, t0);
    // 부하 창(분당 한 줄)을 다른 대상 · 다른 분으로 상한보다 많이 — 앞의 사건 줄이 잘려 나간다
    for (let i = 0; i < store.WRITEQ_MAX + 50; i++) store.setLoad('fm-l' + String(i).padStart(9, '0'), { cpuPct: 1 }, t0 + i);
    const st = store.memStats();
    console.log(JSON.stringify({ queue: st.queue, cut: st.queueCut, ev: st.queuedEvents }));`);
  assert.equal(out.queue, 20_000); assert.equal(out.cut, 80); assert.equal(out.ev, 0, '잘린 사건 30줄을 뺐다(예전엔 30 이 남았다)');
});

test('O — 등록부에 없는 대상이 수집 정의에 남은 것을 뺀다 · 등록부를 못 읽으면 건드리지 않는다 · 10분에 한 번', () => {
  const setup = (d) => {
    fs.writeFileSync(path.join(d, 'focusmon-targets.json'), JSON.stringify({ v: 1, targets: [{ id: 'fm-aaaa000001', name: 'k1', host: '10.1.0.1', port: 22, username: 'dvcmon', agent: '', enabled: true }] }));
    fs.writeFileSync(path.join(d, 'focusmon-sessions.json'), JSON.stringify({ v: 1, sessions: [{ id: 'fs-0123456789ab', mode: 'record', by: 'a', targets: ['fm-aaaa000001', 'fm-dead000099'], interval: 2, startedAt: Date.now() - 3600_000 }] }));
  };
  const out = sub(`const store = await import(${J('focusmon/store.js')});
    const svc = await import(${J('focusmon/service.js')});
    const before = store.listSessions().map((s) => s.targets);
    const n1 = svc.pruneOrphans(Date.now());
    const after = store.listSessions().map((s) => s.targets);
    const n2 = svc.pruneOrphans(Date.now() + 1000);
    console.log(JSON.stringify({ before, n1, after, n2 }));`, { DATA_SOURCE: 'live' }, setup);
  assert.deepEqual(out.before, [['fm-aaaa000001', 'fm-dead000099']]);
  assert.equal(out.n1, 1); assert.deepEqual(out.after, [['fm-aaaa000001']]); assert.equal(out.n2, 0, '10분에 한 번');
  // 등록부 손상 — 건드리지 않는다
  const bad = sub(`const store = await import(${J('focusmon/store.js')});
    const svc = await import(${J('focusmon/service.js')});
    const n = svc.pruneOrphans(Date.now());
    console.log(JSON.stringify({ n, after: store.listSessions().map((s) => s.targets) }));`, { DATA_SOURCE: 'live' }, (d) => { setup(d); fs.writeFileSync(path.join(d, 'focusmon-targets.json'), '{ broken'); });
  assert.equal(bad.n, 0); assert.deepEqual(bad.after, [['fm-aaaa000001', 'fm-dead000099']], '대상이 없다는 뜻이 아니다');
});

test('K — 주소가 바뀌면 메모리 표본 · 지금 값 · 알림 상태를 버린다 · 계정만 바뀌면 남긴다', () => {
  const out = sub(`const store = await import(${J('focusmon/store.js')});
    const svc = await import(${J('focusmon/service.js')});
    const alerts = await import(${J('focusmon/alerts.js')});
    const now = Date.now(); const id = 'fm-mmmmmmmm01';
    for (let i = 0; i < 90; i++) store.ingestSample(id, now - 120_000 + i * 1000, { t: now - 120_000 + i * 1000, cpu: { pct: 50 } }, null, now);
    alerts.saveState({ ['r1|' + id]: { state: 'firing', since: now - 60_000 }, ['r1|fm-other0001']: { state: 'firing', since: now } });
    const t = { id, name: 'm', host: '10.2.0.1', port: 22, username: 'dvcmon', agent: '' };
    svc.targetsEndpointChanged([[t, { ...t, username: 'mon2' }]]);
    const keep = { blocks: store.memBlocks(id).length, latest: !!store.latestOf(id), alert: !!alerts.loadState()['r1|' + id] };
    svc.targetsEndpointChanged([[t, { ...t, host: '10.2.0.99' }]]);
    const gone = { blocks: store.memBlocks(id).length, latest: !!store.latestOf(id), alert: !!alerts.loadState()['r1|' + id], other: !!alerts.loadState()['r1|fm-other0001'] };
    svc.stopFocusMon?.();
    console.log(JSON.stringify({ keep, gone }));`);
  assert.ok(out.keep.blocks > 0 && out.keep.latest && out.keep.alert, `계정만 바뀌면 같은 기계 — 남긴다 ${JSON.stringify(out.keep)}`);
  assert.deepEqual(out.gone, { blocks: 0, latest: false, alert: false, other: true });
});

test('C — 잘린 서비스 목록 때문의 보류는 세 번째 칸 cut · 판정은 그대로 보류 · 사건 문구가 목록 잘림을 말한다', async () => {
  const A = await import('../src/focusmon/alerts.js');
  const now = Date.now();
  const store = { memProcs: () => new Map([[1, [{ t: now - 30_000, apps: { all: { 'sshd.service': 1 }, allCut: true } }]]]) };
  const pts = A.pointsFor(store, { metric: 'app', app: 'nginx.service', durMin: 2 }, 'fm-x', now);
  assert.deepEqual(pts, [[now - 30_000, null, 'cut']]);
  const j = A.judge(pts, { op: 'lt', threshold: 1, durMin: 2 }, null, now);
  assert.equal(j.state, 'hold'); assert.equal(j.event, 'hold'); assert.equal(j.cut, true);
  assert.equal(A.judge([[now - 30_000, null]], { op: 'lt', threshold: 1, durMin: 2 }, null, now).cut, undefined, '그냥 못 읽음은 cut 아님');
  const src = fs.readFileSync(path.join(SRC, 'focusmon/alerts.js'), 'utf8');
  assert.match(src, /j\.cut \? ' · 서비스 목록이 상한에서 잘려 이 이름을 못 봄\(수집은 됨\)'/);
});

test('D — 등록부 손상 중 데모 계정의 서버별 수집 종료는 데모 차단이 먼저(30회차 남긴 것 — 해당 없음 고정)', () => {
  const out = sub(`
    const express = (await import(${EXPRESS})).default;
    const { api } = await import(${J('routes/api.js')});
    const svc = await import(${J('focusmon/service.js')});
    const app = express(); app.use(express.json());
    app.use((req, _r, next) => { req.user = { username: 'thedvcdemp', role: 'admin', scope: null, demoGuest: true }; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const r = await fetch('http://127.0.0.1:' + srv.address().port + '/api/tools/focus-mon/sessions/fs-0123456789ab/targets/fm-d0000001', { method: 'DELETE' });
    const body = await r.json().catch(() => null);
    console.log(JSON.stringify({ status: r.status, reason: body?.reason || '' })); svc.stopFocusMon(); srv.close(); process.exit(0);`,
  { DATA_SOURCE: 'mock', AUTH_SECRET: 'fmb3550-secret-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }, (d) => fs.writeFileSync(path.join(d, 'focusmon-targets.json'), '{ broken'));
  assert.equal(out.status, 403); assert.match(out.reason, /데모 계정/);
});
