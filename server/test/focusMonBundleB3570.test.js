/**
 * focusMonBundleB3570.test.js — 서버 집중 모니터링 전체 점검 29 · 30회차가 남긴 것(사용자 "모두 넣어서 구현해줘" — 남은 일 ⑦ · 묶음 B · 릴리스 v3.57.0).
 *  E1 상태 사건(키 로그인 거부 · 호스트키)은 대상 · **종류마다** 10분 창에 6건까지 + '줄여 적음' 한 줄 · 다음 창 첫 사건에 줄인 수 — 다른 종류의 정당한 변화는 그대로
 *  Q  대기열을 자를 때 사건 수를 다시 센다 · 잘린 줄은 dropped(그 분의 새 값은 새 줄로) · 몇 줄 잘랐는지 센다 · 묶음 대기열도 같은 자르기
 *  O  등록부에 없는 대상이 수집 정의에 남은 것(29회차 전 삭제분)을 10분마다 뺀다 — 등록부를 읽었을 때만
 *  K  **기계가 바뀌면**(주소 또는 담당 노드) 기록은 잇고 경계(resetAt) 뒤 표본만 지금 값 · 알림 판정에 — 열린 분 · 이미 쓴 분을 잃지 않는다(반증 K1 · K2 · F1)
 *     엣지는 값마다 기계 열쇠(ep) — 예전 서버 값은 받지 않는다(F2) · 옛 엣지는 동기화 두 번 울타리 · 실패 발송 되돌리기가 지운 상태를 되살리지 않는다(F1 · F3)
 *  M  메모리에 없던 분으로 만든 묶음은 DB 의 있는 줄과 **합쳐** 쓴다(재시작 · 업그레이드마다 한 분이 깎이던 기존 결함)
 *  C  잘린 서비스 목록 때문의 보류 사건은 '목록 잘림' 을 말한다 · 엣지 정제가 'nonsvc' 를 뭉개지 않는다(반증 alerts F2)
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fmb3570-'));
  try {
    setup(d);
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, CONFIG_DIR: d, DATA_DIR: d, FOCUSMON_SSH_KEY: '', ...env }, encoding: 'utf8', timeout: 60_000 });
    const line = r.stdout.trim().split('\n').pop();
    try { return JSON.parse(line); } catch { throw new Error(`${r.stdout}\n${r.stderr}`); }
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
};

test('E1 — 상태 사건은 대상 · 종류마다 10분 창에 상한까지 + 줄임 안내 한 줄(번갈아 보내도 대기열이 차지 않는다) · 다른 대상은 따로 · 다음 창 첫 사건에 줄인 수', () => {
  const out = sub(`const store = await import(${J('focusmon/store.js')});
    const t0 = Date.now();
    store.setStatus('fm-aaaaaaaa01', { state: 'ok' }, t0);
    for (let i = 0; i < 200; i++) { store.setStatus('fm-aaaaaaaa01', { state: i % 2 ? 'ok' : 'auth' }, t0 + 1000 + i * 1000); }
    store.setStatus('fm-bbbbbbbb02', { state: 'ok' }, t0); store.setStatus('fm-bbbbbbbb02', { state: 'hostkey' }, t0 + 5000);
    const rows1 = store.drainWrites(10000).filter((r) => r.kind === 'e');
    store.setStatus('fm-aaaaaaaa01', { state: 'ok' }, t0 + store.STATUS_EVENT_WINDOW_MS + 300_000);
    store.setStatus('fm-aaaaaaaa01', { state: 'auth' }, t0 + store.STATUS_EVENT_WINDOW_MS + 301_000);
    const rows2 = store.drainWrites(10000).filter((r) => r.kind === 'e');
    const a = rows1.filter((r) => r.target === 'fm-aaaaaaaa01');
    console.log(JSON.stringify({ a1: a.length, notice: a.filter((r) => /줄여 적습니다/.test(r.text)).length, b1: rows1.filter((r) => r.target === 'fm-bbbbbbbb02').length, held: store.memStats().statusEventsHeld, a2: rows2.map((r) => r.text), burst: store.STATUS_EVENT_BURST }));`);
  assert.equal(out.a1, out.burst + 1, '200번 번갈아도 창 상한 + 안내 한 줄만(대기열을 채우지 않는다)'); assert.equal(out.notice, 1, '줄여 적는다는 한 줄');
  assert.equal(out.b1, 1, '다른 대상은 따로');
  assert.equal(out.held, 100 - out.burst, '넘은 것은 센다');
  assert.deepEqual(out.a2, [`키 로그인 거부 — 수집을 멈췄습니다(앞 10분 동안 ${100 - out.burst}번 더 — 줄여 적음)`], '창이 지나면 다시 적고 앞 창에서 줄인 수를 붙인다');
});

test('E1-3 — 호스트키가 상한까지 흔들린 뒤 바뀐 키 로그인 거부는 적는다(종류마다 센다 — 반증 E1 재현)', () => {
  const out = sub(`const store = await import(${J('focusmon/store.js')});
    const t0 = Date.now(); const id = 'fm-eeee00000003';
    store.setStatus(id, { state: 'ok' }, t0);
    for (let i = 0; i < 8; i++) { store.setStatus(id, { state: 'hostkey' }, t0 + i * 60_000 + 1000); store.setStatus(id, { state: 'unreachable' }, t0 + i * 60_000 + 2000); }
    store.setStatus(id, { state: 'auth' }, t0 + 9 * 60_000 + 54_000);
    const ev = store.drainWrites(1000).filter((r) => r.kind === 'e');
    console.log(JSON.stringify({ auth: ev.filter((r) => r.ekind === 'auth').map((r) => r.text), hk: ev.filter((r) => r.ekind === 'hostkey').length, state: store.statusOf(id).state }));`);
  assert.deepEqual(out.auth, ['키 로그인 거부 — 수집을 멈췄습니다'], '수정 전: 호스트키 6건 뒤 같은 창의 거부가 사건에 남지 않았다');
  assert.equal(out.hk, 7, '호스트키는 상한 6 + 안내 1'); assert.equal(out.state, 'auth');
});

test('Q — 대기열을 자를 때 사건 수를 다시 센다(사건 상한이 일찍 차지 않는다) · 잘린 줄 표시 · 센다', () => {
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

test('K — 기계가 바뀌면(주소) 기록은 잇고 경계 뒤 표본만 지금 값 · OS · 알림 판정에 · 계정만 바뀌면 경계 없음 · 사건 한 줄', () => {
  const out = sub(`const store = await import(${J('focusmon/store.js')});
    const svc = await import(${J('focusmon/service.js')});
    const alerts = await import(${J('focusmon/alerts.js')});
    const now = Date.now(); const id = 'fm-mmmmmmmm01';
    for (let i = 0; i < 90; i++) store.ingestSample(id, now - 120_000 + i * 1000, { cpu: { pct: 95 }, up: 100000 + i }, { hostname: 'old' }, now);
    alerts.saveState({ ['r1|' + id]: { state: 'firing', since: now - 60_000 }, ['r1|fm-other0001']: { state: 'firing', since: now } });
    const t = { id, name: 'm', host: '10.2.0.1', port: 22, username: 'dvcmon', agent: '' };
    svc.targetsEndpointChanged([[t, { ...t, username: 'mon2' }]], now);
    const blocks0 = store.memBlocks(id).length;
    const keep = { latest: !!store.latestOf(id), alert: !!alerts.loadState()['r1|' + id], reset: store.resetAtOf(id) };
    svc.targetsEndpointChanged([[t, { ...t, host: '10.2.0.99' }]], now + 1);
    const gone = { blocksKept: store.memBlocks(id).length === blocks0 && blocks0 > 0, latest: !!store.latestOf(id), hello: store.helloOf(id), alert: !!alerts.loadState()['r1|' + id], other: !!alerts.loadState()['r1|fm-other0001'], reset: store.resetAtOf(id) === now + 1 };
    store.ingestSample(id, now - 500, { cpu: { pct: 99 }, up: 5 }, { hostname: 'old-late' }, now + 2);   // 늦게 온 예전 서버 표본(경계 앞)
    const late = { latest: !!store.latestOf(id), hello: store.helloOf(id) };
    store.ingestSample(id, now + 5000, { cpu: { pct: 7 }, up: 300 }, { hostname: 'new' }, now + 5000);
    const rule = { id: 'r1', metric: 'cpu', threshold: 90, durMin: 1, op: 'ge' };
    const pts = alerts.pointsFor(store, rule, id, now + 5000);
    const ev = store.drainWrites(10000).filter((r) => r.kind === 'e').map((r) => r.ekind + ':' + r.text);
    svc.stopFocusMon?.();
    console.log(JSON.stringify({ keep, gone, late, now: { cpu: store.latestOf(id)?.sample?.cpu?.pct, hello: store.helloOf(id)?.hostname }, pts: pts.map((p) => p[1]), ev }));`);
  assert.deepEqual(out.keep, { latest: true, alert: true, reset: 0 }, '계정만 바뀌면 같은 기계 — 경계 없음 · 남긴다');
  assert.deepEqual(out.gone, { blocksKept: true, latest: false, hello: null, alert: false, other: true, reset: true }, '수정 전(처음 판): 메모리 묶음을 버렸다(열린 분 유실 · 늦은 표본이 쓴 분을 덮음)');
  assert.deepEqual(out.late, { latest: false, hello: null }, '경계 앞 늦은 표본은 기록에만 — 지금 값 · OS 가 되지 않는다');
  assert.deepEqual(out.now, { cpu: 7, hello: 'new' });
  assert.deepEqual(out.pts, [7], '알림 판정은 경계 뒤 표본만(예전 서버의 95% 가 새 서버의 발생 · 해제가 되지 않는다)');
  assert.deepEqual(out.ev, ['endpoint:접속 주소를 바꿈 — 이 앞의 값은 예전 서버의 것입니다'], '주소를 바꾼 사건 한 줄 · 재부팅 사건 없음 · 계정만 바꾼 것은 사건 없음');
});

test('K3 — 담당 노드만 바뀌어도 다른 기계(사설 주소는 법인마다 겹친다 — 반증 alerts F3) · 같은 노드 이름의 대소문자만 다르면 같은 기계', () => {
  const out = sub(`const store = await import(${J('focusmon/store.js')});
    const svc = await import(${J('focusmon/service.js')});
    const now = Date.now(); const id = 'fm-nnnnnnnn01';
    store.ingestSample(id, now - 1000, { cpu: { pct: 50 } }, null, now);
    const t = { id, name: 'n', host: '10.0.0.5', port: 22, username: 'dvcmon', agent: 'edge-a' };
    svc.targetsEndpointChanged([[t, { ...t, agent: 'EDGE-A' }]], now);
    const caseOnly = store.resetAtOf(id);
    svc.targetsEndpointChanged([[t, { ...t, agent: 'edge-b' }]], now + 1);
    const ev = store.drainWrites(1000).filter((r) => r.kind === 'e').map((r) => r.text);
    svc.stopFocusMon?.();
    console.log(JSON.stringify({ caseOnly, moved: store.resetAtOf(id) === now + 1, latest: !!store.latestOf(id), ev }));`);
  assert.equal(out.caseOnly, 0); assert.equal(out.moved, true, '수정 전: 노드를 옮겨도 예전 기계의 알림 상태 · 표본을 이어 썼다'); assert.equal(out.latest, false);
  assert.deepEqual(out.ev, ['담당 노드를 바꿈 — 이 앞의 값은 예전 서버의 것입니다']);
});

test('K4 — 기계가 바뀐 분의 기록: 열린 분 · 이미 쓴 분을 잃지 않는다(DB 표본 수 — 반증 K1 · K2 · F1 재현 형태)', () => {
  const out = sub(`const store = await import(${J('focusmon/store.js')});
    const svc = await import(${J('focusmon/service.js')});
    const db = await import(${J('focusmon/db.js')});
    const M0 = Math.floor(Date.now() / 60_000) * 60_000 - 10 * 60_000;
    const id = 'fm-kkkkkkkk01'; const t = { id, name: 'k', host: '10.3.0.1', port: 22, username: 'dvcmon', agent: '' };
    const put = (ts, now) => store.ingestSample(id, ts, { cpu: { pct: 50 } }, null, now);
    const write = async () => { const rows = store.drainWrites(100000); const w = await db.writeBlocks(rows); if (!w.ok) throw new Error(w.error); };
    const nOf = async (m) => (await db.readMetric(id, m, m))[0]?.n ?? 0;
    // ① 열린 분: M0 에 표본 6(0~50초) → 40초에 주소 수정 → 새 서버 표본 2(52 · 56초) → 분 닫기
    for (let i = 0; i < 6; i++) put(M0 + i * 10_000, M0 + i * 10_000);
    svc.targetsEndpointChanged([[t, { ...t, host: '10.3.0.2' }]], M0 + 51_000);
    put(M0 + 52_000, M0 + 52_000); put(M0 + 56_000, M0 + 56_000);
    store.closeMinutes(M0 + 60_000 + store.GRACE_MS + 1, new Set([id])); await write();
    const open = await nOf(M0 / 60_000);
    // ② 이미 쓴 분: 다음 분 M1 에 6표본 → 닫고 씀 → 주소 수정 → 늦게 온 예전 서버 표본 1(M1 의 59초 — 엣지 묶음)
    const M1 = M0 + 60_000; const t2 = { ...t, host: '10.3.0.2' };
    for (let i = 0; i < 6; i++) put(M1 + i * 10_000, M1 + i * 10_000);
    store.closeMinutes(M1 + 60_000 + store.GRACE_MS + 1, new Set([id])); await write();
    svc.targetsEndpointChanged([[t2, { ...t2, host: '10.3.0.3' }]], M1 + 80_000);
    put(M1 + 59_000, M1 + 81_000); store.flushReopened(id); await write();
    const late = await nOf(M1 / 60_000);
    svc.stopFocusMon?.();
    console.log(JSON.stringify({ open, late, latest: store.latestOf(id)?.ts ?? null }));`, { DATA_SOURCE: 'live' });
  assert.equal(out.open, 8, '수정 전(처음 판): 열린 분이 대기열에 들지 않고 사라졌다(DB 에 그 분 없음) — 바뀌기 전 6 + 뒤 2');
  assert.equal(out.late, 7, '수정 전(처음 판): 늦은 표본 1개짜리 새 묶음이 이미 쓴 6표본 분을 덮었다(n=1)');
  assert.equal(out.latest, null, '늦은 예전 서버 표본은 지금 값이 아니다');
});

test('M — 메모리에 없던 분으로 만든 묶음은 DB 의 있는 줄과 합쳐 쓴다(재시작 · 업그레이드 — 1분 요약 · 프로세스도)', () => {
  const out = sub(`const store = await import(${J('focusmon/store.js')});
    const db = await import(${J('focusmon/db.js')});
    const { decodeSum } = await import(${J('focusmon/summary.js')});
    const { decodeProcBlock } = await import(${J('focusmon/codec.js')});
    const M0 = Math.floor(Date.now() / 60_000) * 60_000 - 10 * 60_000; const m = M0 / 60_000;
    const id = 'fm-rrrrrrrr01';
    const write = async () => { const w = await db.writeBlocks(store.drainWrites(100000)); if (!w.ok) throw new Error(w.error); };
    // 재시작 전: 0~20초 10표본 + 프로세스 2 → 종료 때 쓴다(closeAll)
    for (let i = 0; i < 10; i++) store.ingestSample(id, M0 + i * 2000, { cpu: { pct: 10 } }, null, M0 + i * 2000);
    store.ingestProcs(id, M0 + 1000, { n: 5, top: [] }); store.ingestProcs(id, M0 + 11_000, { n: 6, top: [] });
    store.closeAll(); await write();
    const before = (await db.readMetric(id, m, m))[0].n;
    store._resetForTest();   // 재시작 — 메모리가 비었다
    // 재시작 뒤: 엣지가 밀린 같은 분의 30~58초 15표본 + 프로세스 1 을 보냈다
    for (let i = 0; i < 15; i++) store.ingestSample(id, M0 + 30_000 + i * 2000, { cpu: { pct: 90 } }, null, M0 + 70_000);
    store.ingestProcs(id, M0 + 41_000, { n: 7, top: [] });
    store.closeMinutes(M0 + 60_000 + store.GRACE_MS + 1, new Set([id])); await write();
    const after = (await db.readMetric(id, m, m))[0];
    const sum = decodeSum((await db.readSum1(id, m, m))[0].data);
    const procs = decodeProcBlock((await db.readProc(id, m, m))[0].data).map((s) => s.n);
    console.log(JSON.stringify({ before, after: after.n, sumN: sum ? sum.n[sum.keys.indexOf('c.pct')] : null, sumA: sum ? sum.a[sum.keys.indexOf('c.pct')] : null, procs }));`, { DATA_SOURCE: 'live' });
  assert.equal(out.before, 10);
  assert.equal(out.after, 25, '수정 전: 재시작 뒤 15표본짜리 묶음이 INSERT OR REPLACE 로 앞 10표본을 덮었다(n=15)');
  assert.equal(out.sumN, 25, '1분 요약도 합친 묶음에서'); assert.equal(out.sumA, 58, '평균 (10×10 + 15×90) / 25');
  assert.deepEqual(out.procs, [5, 6, 7], '프로세스 묶음도 합친다');
});

test('F — 실패한 발송의 되돌리기는 그 사이 지운 짝(주소를 고침)을 되살리지 않는다(반증 alerts F1 · service F3)', async () => {
  const out = sub(`const alerts = await import(${J('focusmon/alerts.js')});
    const now = Date.now(); const id = 'fm-ffffffff01';
    const rid = alerts.writeRule('create', { name: 'CPU 높음', metric: 'cpu', threshold: 90, durMin: 1, severity: 'crit', scope: { kind: 'record' } }, { by: 'a' }).rule.id;
    alerts.saveState({ [rid + '|' + id]: { state: 'firing', since: now - 300_000, firedAt: now - 300_000, value: 95, at: now - 60_000 } });
    const blocks = [{ minute: Math.floor(now / 60_000), ts: Float64Array.from([now - 90_000, now - 30_000, now - 1000]), cols: new Map([['c.pct', Float32Array.from([10, 10, 10])]]) }];
    const store = { memBlocks: () => blocks, memProcs: () => new Map(), resetAtOf: () => 0, queueEvent: () => 'x' };
    let release; const gate = new Promise((r) => { release = r; });
    const send = async () => { await gate; return 'failed'; };
    const p = alerts.alertCycle({ store, targets: [{ id, name: 'f' }], recordIds: new Set([id]), send, now });
    await new Promise((r) => setTimeout(r, 20));
    const forgot = alerts.forgetTargetAlerts(id);   // 보내는 동안 주소를 고쳤다
    release(); const res = await p;
    console.log(JSON.stringify({ forgot, failed: res.failed, state: alerts.loadState()[rid + '|' + id] ?? null }));`);
  assert.equal(out.forgot, true); assert.equal(out.failed, 1);
  assert.equal(out.state, null, "수정 전: 예전 서버의 'firing' 을 되살려 새 서버에 '[해제]' 가 나갔다");
});

test('E — 엣지 값마다 기계 열쇠(ep): 예전 서버 것은 받지 않는다 · 응답 대상에 열쇠 · 옛 엣지(표지 없음)는 바뀐 뒤 동기화 두 번 울타리 · 시험 결과는 접속처 표지(반증 service F2)', () => {
  const out = sub(`const registry = await import(${J('focusmon/registry.js')}); const store = await import(${J('focusmon/store.js')});
    const edge = await import(${J('central/focusMonEdge.js')}); const svc = await import(${J('focusmon/service.js')}); const { endpointKey } = await import(${J('focusmon/audit/service.js')});
    const t = registry.addTarget({ name: 'e-1', host: '10.7.0.1', port: 22, username: 'dvcmon', agent: 'edge-e' }, { agents: ['edge-e'] }).target; const id = t.id;
    store.startSession({ targets: [id], interval: 2, mode: 'watch', by: 't' });
    let now = Date.now();
    const s = (cpu, ep) => ({ id, t: now - 500, s: { cpu: { pct: cpu } }, ...(ep ? { ep } : {}) });
    const r0 = edge.handleEdgeSync('edge-e', { sentAt: now, samples: [s(95)] }, now);
    const ep0 = r0.targets[0].ep;
    const before = registry.getTarget(id); const moved = registry.updateTarget(id, { host: '10.7.0.2' }, { agents: ['edge-e'] });
    now += 1000; svc.targetsEndpointChanged([[before, moved.target]], now);
    // 새 판 엣지: 예전 열쇠가 붙은 깨우기 동기화 본문(밀린 예전 서버 표본 · 상태 · 부하 · 프로세스)
    now += 1000;
    const r1 = edge.handleEdgeSync('edge-e', { sentAt: now, samples: [s(96, ep0), s(97, ep0)], procs: [{ id, t: now - 400, p: { n: 9, top: [] }, ep: ep0 }],
      status: { [id]: { state: 'ok', interval: 2, hello: { hostname: 'old', os: 'RHEL 7.8' }, ep: ep0 } }, load: { [id]: { windowS: 30, cpuPct: 1, ep: ep0 } } }, now);
    const ep1 = r1.targets[0].ep;
    const afterOld = { latest: !!store.latestOf(id), hello: store.helloOf(id), st: store.statusOf(id), load: store.loadOf(id), procs: !!store.latestProcsOf(id), acc: r1.accepted };
    now += 1000;
    const r2 = edge.handleEdgeSync('edge-e', { sentAt: now, samples: [s(5, ep1)] }, now);
    const newer = { cpu: store.latestOf(id)?.sample?.cpu?.pct ?? null, acc: r2.accepted.samples };
    // 시험 결과 — 예전 접속처 표지는 버린다 · 지금 표지 · 표지 없음(옛 엣지)은 받는다
    const epT0 = endpointKey(before); const epT1 = endpointKey(moved.target);
    edge.handleEdgeSync('edge-e', { sentAt: now, tests: [{ id, ep: epT0, result: { ok: true, kind: 'ok' } }] }, now); const tOld = store.testOf(id)?.result?.ok ?? null;
    edge.handleEdgeSync('edge-e', { sentAt: now, tests: [{ id, ep: epT1, result: { ok: false, kind: 'auth' } }] }, now); const tNew = store.testOf(id)?.result?.kind ?? null;
    console.log(JSON.stringify({ ep0, ep1, same: ep0 === ep1, keyOk: ep1 === store.machineKeyOf(moved.target), afterOld, newer, tOld, tNew }));`, { DATA_SOURCE: 'live' });
  assert.match(out.ep0, /^[a-f0-9]{16}$/); assert.equal(out.same, false); assert.equal(out.keyOk, true);
  assert.deepEqual({ latest: out.afterOld.latest, hello: out.afterOld.hello, st: out.afterOld.st, load: out.afterOld.load, procs: out.afterOld.procs }, { latest: false, hello: null, st: null, load: null, procs: false },
    '수정 전: 깨우기 동기화의 예전 서버 표본이 지운 지금 값 · OS 를 다시 채웠다(cpu 95 · hello old)');
  assert.equal(out.afterOld.acc.oldEp, 5, '표본 2 · 프로세스 1 · 상태 1 · 부하 1'); assert.equal(out.afterOld.acc.samples, 0);
  assert.deepEqual(out.newer, { cpu: 5, acc: 1 });
  assert.equal(out.tOld, null, '예전 접속처의 시험 결과는 새 접속처의 것이 아니다'); assert.equal(out.tNew, 'auth');
});

test('E2 — 표지를 싣지 않는 옛 엣지: 기계가 바뀐 뒤 그 엣지의 동기화 두 번은 받지 않고 세 번째부터 받는다 · 바뀐 적 없으면 그대로', () => {
  const out = sub(`const registry = await import(${J('focusmon/registry.js')}); const store = await import(${J('focusmon/store.js')});
    const edge = await import(${J('central/focusMonEdge.js')}); const svc = await import(${J('focusmon/service.js')});
    const t = registry.addTarget({ name: 'e-2', host: '10.7.1.1', port: 22, username: 'dvcmon', agent: 'edge-o' }, { agents: ['edge-o'] }).target; const id = t.id;
    const u = registry.addTarget({ name: 'e-3', host: '10.7.1.9', port: 22, username: 'dvcmon', agent: 'edge-o' }, { agents: ['edge-o'] }).target;
    store.startSession({ targets: [id, u.id], interval: 2, mode: 'watch', by: 't' });
    let now = Date.now(); const got = [];
    const one = (cpu) => { now += 2000; const r = edge.handleEdgeSync('edge-o', { sentAt: now, samples: [{ id, t: now - 100, s: { cpu: { pct: cpu } } }, { id: u.id, t: now - 100, s: { cpu: { pct: cpu } } }] }, now); got.push(r.accepted.samples); };
    one(50);
    const moved = registry.updateTarget(id, { host: '10.7.1.2' }, { agents: ['edge-o'] });
    svc.targetsEndpointChanged([[t, moved.target]], now + 1);
    one(96); one(97); one(5);
    console.log(JSON.stringify({ got, cpu: store.latestOf(id)?.sample?.cpu?.pct ?? null }));`, { DATA_SOURCE: 'live' });
  assert.deepEqual(out.got, [2, 1, 1, 2], '바뀐 대상만 두 번 거른다(다른 대상은 그대로)'); assert.equal(out.cpu, 5);
});

test('E3 — 수집기 묶음 · 엣지 워커: 값마다 열쇠를 붙인다 · 같은 접속처에 열쇠만 바뀌면 다시 열지 않고 바꿔 붙인다', async () => {
  const out = sub(`const worker = await import(${J('agent/focusMonWorker.js')}); const mock = await import(${J('focusmon/mock.js')});
    const id = mock.DEMO_TARGETS[0].id; const A = 'a'.repeat(16); const B = 'b'.repeat(16);
    worker._runnerForTest.reconcile([{ id, host: '10.10.20.11', port: 22, username: 'dvcmon', interval: 1, procEvery: 1, demo: true, ep: A }]);
    await new Promise((r) => setTimeout(r, 1300));
    const b1 = worker._bufForTest();
    worker._runnerForTest.reconcile([{ id, host: '10.10.20.11', port: 22, username: 'dvcmon', interval: 1, procEvery: 1, demo: true, ep: B }]);
    const runningSame = worker._runnerForTest.running().length === 1;
    await new Promise((r) => setTimeout(r, 1300));
    const b2 = worker._bufForTest();
    worker.stopFocusMonWorker();
    const eps = (list) => [...new Set(list.map((x) => x.ep || '-'))];
    console.log(JSON.stringify({ s1: eps(b1.samples), p1: eps(b1.procs), st1: b1.statuses[id]?.ep || '-', s2: eps(b2.samples.slice(b1.samples.length)), st2: b2.statuses[id]?.ep || '-', runningSame }));
    process.exit(0);`, { DATA_SOURCE: 'mock' });
  assert.deepEqual(out.s1, ['a'.repeat(16)]); assert.deepEqual(out.p1, ['a'.repeat(16)]); assert.equal(out.st1, 'a'.repeat(16));
  assert.deepEqual(out.s2, ['b'.repeat(16)], '같은 수집기에 새 열쇠'); assert.equal(out.st2, 'b'.repeat(16)); assert.equal(out.runningSame, true);
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

test('C2 — 엣지 정제가 nonsvc 를 뭉개지 않는다: 엣지 서버의 죽은 .service 도 발생(반증 alerts F2 재현) · 거른 칸이 있으면 true', async () => {
  const E = await import('../src/central/focusMonEdge.js'); const A = await import('../src/focusmon/alerts.js');
  const all = { 'sshd.service': 1 }; for (let i = 0; i < 30; i++) all[`libpod-${String(i).padStart(12, '0')}.scope`] = 1;
  const p = E.cleanProcs({ n: 40, top: [], apps: { sv: [], cm: [], all, allCut: 'nonsvc' } });
  assert.equal(p.apps.allCut, 'nonsvc', '수정 전: true 로 바뀌어 없는 .service 가 보류(cut)가 됐다');
  const now = Date.now(); const store = { memProcs: () => new Map([[1, [now - 70_000, now - 40_000, now - 10_000].map((t) => ({ t, apps: p.apps }))]]), resetAtOf: () => 0 };
  const rule = { metric: 'app', app: 'crond.service', threshold: 1, durMin: 1, op: 'lt' };
  assert.equal(A.judge(A.pointsFor(store, rule, 'fm-x', now), rule, null, now).event, 'fire', '엣지로 받은 서버의 죽은 서비스도 알린다');
  const bad = E.cleanProcs({ n: 1, top: [], apps: { sv: [], cm: [], all: { 'a.service': 1, 'bad name!': 2 }, allCut: 'nonsvc' } });
  assert.equal(bad.apps.allCut, true, '여기서 거른 칸이 있으면 무엇이 빠졌는지 모른다 — true');
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
  { DATA_SOURCE: 'mock', AUTH_SECRET: 'fmb3570-secret-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }, (d) => fs.writeFileSync(path.join(d, 'focusmon-targets.json'), '{ broken'));
  assert.equal(out.status, 403); assert.match(out.reason, /데모 계정/);
});


/* ── 변이 검증이 찾은 빈틈(생존 6 — 1건은 동등 변이라 동작을 고쳤다) ── */
test('Q2 — 잘린 분의 새 값은 새 줄로 다시 넣는다(버린 줄을 고치지 않는다)', () => {
  const out = sub(`const store = await import(${J('focusmon/store.js')});
    const t0 = Math.floor(Date.now() / 60_000) * 60_000;
    store.setLoad('fm-keep00000001', { cpuPct: 1 }, t0);
    for (let i = 0; i < store.WRITEQ_MAX; i++) store.setLoad('fm-l' + String(i).padStart(9, '0'), { cpuPct: 1 }, t0 + 1);
    const before = store.drainWrites(100000).filter((r) => r.target === 'fm-keep00000001').length;
    store.setLoad('fm-keep00000001', { cpuPct: 2 }, t0 + 2);
    const after = store.drainWrites(100000).filter((r) => r.target === 'fm-keep00000001').map((r) => JSON.parse(r.data).cpuPct);
    console.log(JSON.stringify({ before, after }));`);
  assert.equal(out.before, 0, '상한에서 잘렸다'); assert.deepEqual(out.after, [2], '같은 분의 새 값이 새 줄로');
});

test('E1-2 — 접속처가 바뀌면 그 대상의 사건 창 기억도 지운다(새 기계의 첫 사건을 세지 않고 적는다)', () => {
  const out = sub(`const store = await import(${J('focusmon/store.js')});
    const t0 = Date.now(); const id = 'fm-eeee00000002';
    store.setStatus(id, { state: 'ok' }, t0);
    for (let i = 0; i < 40; i++) store.setStatus(id, { state: i % 2 ? 'ok' : 'auth' }, t0 + 1000 + i * 1000);
    store.drainWrites(100000);
    store.forgetTargetState(id, { machineChanged: true });
    store.setStatus(id, { state: 'ok' }, t0 + 60_000); store.setStatus(id, { state: 'auth' }, t0 + 61_000);
    console.log(JSON.stringify({ n: store.drainWrites(100000).filter((r) => r.kind === 'e').length }));`);
  assert.equal(out.n, 1);
});

test('O2 — 10분 간격(그 사이 새로 생긴 고아는 다음 차례에) · 1분 틱이 부른다', () => {
  const setup = (d) => {
    fs.writeFileSync(path.join(d, 'focusmon-targets.json'), JSON.stringify({ v: 1, targets: [
      { id: 'fm-aaaa000001', name: 'k1', host: '10.1.0.1', port: 22, username: 'dvcmon', agent: '', enabled: true },
      { id: 'fm-aaaa000002', name: 'k2', host: '10.1.0.2', port: 22, username: 'dvcmon', agent: '', enabled: true }] }));
    fs.writeFileSync(path.join(d, 'focusmon-sessions.json'), JSON.stringify({ v: 1, sessions: [{ id: 'fs-0123456789ab', mode: 'record', by: 'a', targets: ['fm-aaaa000001', 'fm-aaaa000002', 'fm-dead000099'], interval: 2, startedAt: Date.now() - 3600_000 }] }));
  };
  const out = sub(`const store = await import(${J('focusmon/store.js')});
    const svc = await import(${J('focusmon/service.js')});
    const registry = await import(${J('focusmon/registry.js')});
    const t0 = Date.now();
    const r1 = await svc.minuteTick(t0);                     // 1분 틱이 부른다
    const a1 = store.listSessions().map((s) => s.targets)[0];
    registry.removeTarget('fm-aaaa000002');                    // 지울 때 빼는 길을 거치지 않은 고아를 만든다
    const n2 = svc.pruneOrphans(t0 + 60_000);                  // 10분 안 — 하지 않는다
    const a2 = store.listSessions().map((s) => s.targets)[0];
    const n3 = svc.pruneOrphans(t0 + svc.ORPHAN_EVERY_MS + 1);
    const a3 = store.listSessions().map((s) => s.targets)[0];
    svc.stopFocusMon?.();
    console.log(JSON.stringify({ a1, n2, a2, n3, a3 }));`, { DATA_SOURCE: 'live' }, setup);
  assert.deepEqual(out.a1, ['fm-aaaa000001', 'fm-aaaa000002'], '틱이 고아를 뺐다');
  assert.equal(out.n2, 0); assert.deepEqual(out.a2, ['fm-aaaa000001', 'fm-aaaa000002'], '10분 안에는 다시 보지 않는다');
  assert.equal(out.n3, 1); assert.deepEqual(out.a3, ['fm-aaaa000001']);
});

test('K2 — 알림 상태 지우기는 그 대상 열쇠만(앞부분이 같은 다른 대상은 남긴다) · 파일에도 쓴다', () => {
  const out = sub(`const alerts = await import(${J('focusmon/alerts.js')});
    const id = 'fm-aaaa0000'; const longer = 'fm-aaaa00001111';
    alerts.saveState({ ['r1|' + id]: { state: 'firing' }, ['r1|' + longer]: { state: 'firing' }, ['r2|' + id]: { state: 'ok' } });
    alerts.forgetTargetAlerts(id);
    alerts._resetForTest();   // 메모리 캐시를 버리고 파일에서 다시 읽는다
    console.log(JSON.stringify(Object.keys(alerts.loadState()).sort()));`);
  assert.deepEqual(out, ['r1|fm-aaaa00001111']);
});
