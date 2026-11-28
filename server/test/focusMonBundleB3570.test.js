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
  // 반증 AE-5: 앞 창에서 줄인 수는 **그 창 끝 시각**의 한 줄(새 사건 글에 붙이지 않는다) · 그다음 새 창의 첫 사건
  assert.deepEqual(out.a2, [`키 로그인 거부 — 그 10분 동안 ${100 - out.burst}번 더 바뀜(줄여 적음)`, '키 로그인 거부 — 수집을 멈췄습니다'], '창이 지나면 줄인 수 한 줄 + 새 사건');
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
    store.ingestProcs(id, now - 2000, { n: 5, top: [] });
    alerts.saveState({ ['r1|' + id]: { state: 'firing', since: now - 60_000 }, ['r1|fm-other0001']: { state: 'firing', since: now } });
    const t = { id, name: 'm', host: '10.2.0.1', port: 22, username: 'dvcmon', agent: '' };
    svc.targetsEndpointChanged([[t, { ...t, username: 'mon2' }]], now);
    const blocks0 = store.memBlocks(id).length;
    const keep = { latest: !!store.latestOf(id), procs: !!store.latestProcsOf(id), alert: !!alerts.loadState()['r1|' + id], reset: store.resetAtOf(id) };
    svc.targetsEndpointChanged([[t, { ...t, host: '10.2.0.99' }]], now + 1);
    const gone = { blocksKept: store.memBlocks(id).length === blocks0 && blocks0 > 0, latest: !!store.latestOf(id), procs: !!store.latestProcsOf(id), hello: store.helloOf(id), alert: !!alerts.loadState()['r1|' + id], other: !!alerts.loadState()['r1|fm-other0001'], reset: store.resetAtOf(id) === now + 1 };
    // 늦게 온 예전 서버 표본(경계 앞) — 가동 시간이 큰 예전 서버 · 커널 메시지 · 프로세스
    store.ingestSample(id, now - 500, { cpu: { pct: 99 }, up: 100500, km: { f: true, rc: 0, boot: Math.round(now / 1000) - 100500, bid: '11111111-1111-1111-1111-111111111111', oom: [], en: 7, es: '50.000001' } }, { hostname: 'old-late' }, now + 2);
    store.ingestProcs(id, now - 400, { n: 9, top: [] });
    const late = { latest: !!store.latestOf(id), hello: store.helloOf(id), km: store.kmsgOf(id), procs: !!store.latestProcsOf(id) };
    store.ingestSample(id, now + 5000, { cpu: { pct: 7 }, up: 300 }, { hostname: 'new' }, now + 5000);
    const rule = { id: 'r1', metric: 'cpu', threshold: 90, durMin: 1, op: 'ge' };
    const pts = alerts.pointsFor(store, rule, id, now + 5000);
    const ev = store.drainWrites(10000).filter((r) => r.kind === 'e').map((r) => r.ekind + ':' + r.text);
    svc.stopFocusMon?.();
    console.log(JSON.stringify({ keep, gone, late, now: { cpu: store.latestOf(id)?.sample?.cpu?.pct, hello: store.helloOf(id)?.hostname }, pts: pts.map((p) => p[1]), ev }));`);
  assert.deepEqual(out.keep, { latest: true, procs: true, alert: true, reset: 0 }, '계정만 바뀌면 같은 기계 — 경계 없음 · 남긴다');
  assert.deepEqual(out.gone, { blocksKept: true, latest: false, procs: false, hello: null, alert: false, other: true, reset: true }, '수정 전(처음 판): 메모리 묶음을 버렸다(열린 분 유실 · 늦은 표본이 쓴 분을 덮음)');
  assert.deepEqual(out.late, { latest: false, hello: null, km: null, procs: false }, '경계 앞 늦은 표본은 기록에만 — 지금 값 · OS · 커널 메시지 기준 · 프로세스가 되지 않는다');
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

test('M2 — 다시 연 묶음: 메모리에 없던 분(재시작 뒤 더 앞선 분)도 합쳐 쓰고 · 합쳐 쓴 분을 다시 열어도 합친다(얼림 · 풀림이 표시를 잇는다)', () => {
  const out = sub(`const store = await import(${J('focusmon/store.js')});
    const db = await import(${J('focusmon/db.js')});
    const M0 = Math.floor(Date.now() / 60_000) * 60_000 - 10 * 60_000; const m0 = M0 / 60_000; const M1 = M0 + 60_000;
    const id = 'fm-rrrrrrrr02';
    const write = async () => { const w = await db.writeBlocks(store.drainWrites(100000)); if (!w.ok) throw new Error(w.error); };
    const nOf = async (m) => (await db.readMetric(id, m, m))[0]?.n ?? 0;
    for (let i = 0; i < 10; i++) store.ingestSample(id, M0 + i * 2000, { cpu: { pct: 10 } }, null, M0 + i * 2000);
    store.closeAll(); await write();
    store._resetForTest();
    // 재시작 뒤 엣지가 M1 을 먼저 보내고(메모리 첫 묶음) 이어 M0 의 늦은 표본 5 를 보냈다 — M0 은 메모리에 없는 분(다시 연 새 묶음)
    for (let i = 0; i < 5; i++) store.ingestSample(id, M1 + i * 2000, { cpu: { pct: 20 } }, null, M1 + 20_000);
    for (let i = 0; i < 5; i++) store.ingestSample(id, M0 + 30_000 + i * 2000, { cpu: { pct: 30 } }, null, M1 + 21_000);
    store.flushReopened(id); await write();
    const a = await nOf(m0);
    // 그 분(M0 — 메모리엔 늦은 5표본뿐)을 또 다시 연다 — 얼려 둔 묶음에도 합쳐 쓰기 표시가 남아야 한다
    store.ingestSample(id, M0 + 50_000, { cpu: { pct: 40 } }, null, M1 + 22_000);
    store.flushReopened(id); await write();
    const b = await nOf(m0);
    console.log(JSON.stringify({ a, b }));`, { DATA_SOURCE: 'live' });
  assert.equal(out.a, 15, '수정 전: 다시 연 새 묶음(5표본)이 앞 10표본을 덮었다');
  assert.equal(out.b, 16, '두 번째로 다시 열어도 합친다(얼림 · 풀림이 표시를 버리면 메모리의 6표본으로 덮는다)');
});

test('Q3 — 분 묶음이 대기열 상한을 넘겨도 같은 자르기(잘린 줄 표시 · 센다 · 그 분의 새 부하 값은 새 줄로)', () => {
  const out = sub(`const store = await import(${J('focusmon/store.js')});
    const t0 = Math.floor(Date.now() / 60_000) * 60_000;
    store.setLoad('fm-keep00000002', { cpuPct: 1 }, t0);
    for (let i = 0; i < store.WRITEQ_MAX - 1; i++) store.setLoad('fm-l' + String(i).padStart(9, '0'), { cpuPct: 1 }, t0 + 1);
    const id = 'fm-bbbbbbbb09';
    for (let i = 0; i < 3; i++) store.ingestSample(id, t0 - 60_000 + i * 1000, { cpu: { pct: 5 } }, null, t0);
    store.closeMinutes(t0 + store.GRACE_MS + 1, new Set([id]));   // m · s1 두 줄 → 상한을 넘는다
    const st = store.memStats();
    store.setLoad('fm-keep00000002', { cpuPct: 2 }, t0 + 2);
    const keep = store.drainWrites(100000).filter((r) => r.target === 'fm-keep00000002').map((r) => JSON.parse(r.data).cpuPct);
    console.log(JSON.stringify({ queue: st.queue, cut: st.queueCut, keep }));`);
  assert.equal(out.queue, 20_000); assert.equal(out.cut, 2, '분 묶음 · 1분 요약 두 줄만큼(수정 전: 묶음 쪽 자르기는 세지 않았다 — 0)');
  assert.deepEqual(out.keep, [2], '수정 전: 표시 없이 잘린 줄을 고쳐 그 분의 새 값이 사라졌다');
});

test('M3 — 프로세스 합치기는 시각 합집합 · 같은 시각은 뒤 것 · 분당 상한 · 앱 묶음은 마지막에만', async () => {
  const { mergeProcLists, PROC_PER_MIN } = await import('../src/focusmon/codec.js');
  const a = Array.from({ length: 50 }, (_, i) => ({ t: 1000 + i * 2, n: 1 }));
  const b = Array.from({ length: 50 }, (_, i) => ({ t: 1001 + i * 2, n: 2, apps: { sv: [], cm: [], all: { x: 1 } } }));
  b.push({ t: 1000, n: 3 });
  const m = mergeProcLists(a, b);
  assert.equal(m.length, PROC_PER_MIN, '상한');
  assert.deepEqual(m.map((x) => x.t), [...m.map((x) => x.t)].sort((x, y) => x - y));
  assert.equal(m[m.length - 1].t, 1099, '최근 것을 남긴다');
  assert.deepEqual(m[m.length - 1].apps, { sv: [], cm: [] }); assert.ok(m.slice(0, -1).every((x) => x.apps === undefined));
  assert.equal(mergeProcLists(a, b.slice(-1)).find((x) => x.t === 1000).n, 3, '같은 시각은 뒤(새) 것');
});

test('E4 — 엣지 워커: 받은 시험의 접속처 표지를 결과에 그대로 돌려준다', () => {
  const out = sub(`const http = await import('node:http');
    const worker = await import(${J('agent/focusMonWorker.js')}); const mock = await import(${J('focusmon/mock.js')}); const { config } = await import(${J('config.js')});
    const id = mock.DEMO_TARGETS[0].id; const EP = 'c'.repeat(12);
    const MK = 'e'.repeat(16);
    const zlib = await import('node:zlib'); const sent = []; const sentT = [];
    const srv = http.createServer((req, res) => { const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
      try { let b = Buffer.concat(cs); if (req.headers['content-encoding'] === 'gzip') b = zlib.gunzipSync(b); const j = JSON.parse(b.toString('utf8')); for (const x of j.samples || []) sent.push(x.ep || '-'); for (const x of j.tests || []) sentT.push(x); } catch { /* */ }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, now: Date.now(), validUntil: Date.now() + 30000, targets: [{ id, host: '10.10.20.11', port: 22, username: 'dvcmon', interval: 1, procEvery: 5, ep: MK }], tests: [{ id, host: '10.10.20.11', port: 22, username: 'dvcmon', ep: EP }] })); }); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    config.agent.centralUrl = 'http://127.0.0.1:' + srv.address().port; config.agent.centralToken = 'tok'; config.agent.name = 'edge-t';
    const r = await worker.syncOnce();
    await new Promise((x) => setTimeout(x, 1300));
    const tests = [...sentT, ...worker._bufForTest().tests]; const sEps = [...new Set([...sent, ...worker._bufForTest().samples.map((x) => x.ep || '-')])];
    worker.stopFocusMonWorker(); srv.close();
    console.log(JSON.stringify({ ok: r?.ok ?? null, tests: [...new Set(tests.map((x) => JSON.stringify({ id: x.id === id, ep: x.ep || null, ok: x.result?.ok ?? null })))].map((x) => JSON.parse(x)), sEps }));
    process.exit(0);`, { DATA_SOURCE: 'mock' });
  assert.equal(out.ok, true); assert.deepEqual(out.tests, [{ id: true, ep: 'c'.repeat(12), ok: true }]);
  assert.deepEqual(out.sEps, ['e'.repeat(16)], '응답 대상의 열쇠를 수집기에 넘겨 표본에 붙인다');
});

test('K5 — 기계를 바꾼 직후 판정 보류의 까닭은 \'새 서버 값이 아직 없음\'(수집 끊김으로 단정하지 않는다)', () => {
  const out = sub(`const alerts = await import(${J('focusmon/alerts.js')});
    const now = Date.now(); const id = 'fm-hhhhhhhh01';
    alerts.writeRule('create', { name: 'CPU 높음', metric: 'cpu', threshold: 90, durMin: 5, severity: 'crit', scope: { kind: 'record' } }, { by: 'a' });
    const texts = [];
    const mk = (reset) => ({ memBlocks: () => [], memProcs: () => new Map(), resetAtOf: () => reset, queueEvent: (_t, _k, text) => { texts.push(text); return 'x'; } });
    await alerts.alertCycle({ store: mk(now - 30_000), targets: [{ id, name: 'h' }], recordIds: new Set([id]), now });
    alerts.forgetTargetAlerts(id);
    await alerts.alertCycle({ store: mk(0), targets: [{ id, name: 'h' }], recordIds: new Set([id]), now: now + 1 });
    console.log(JSON.stringify(texts));`);
  assert.equal(out.length, 2);
  assert.match(out[0], /판정 보류 · 접속처를 바꾼 뒤 새 서버 값이 아직 없음$/);
  assert.match(out[1], /판정 보류 · 값을 못 읽음\(수집 끊김 · 엣지 응답 없음\)$/);
});

test('K6 — \'아직 없음\' 은 경계 뒤 판정 점이 하나도 없고 경계 뒤 지금 값도 없을 때만(변이 2회차 생존 AE1 두 건)', () => {
  const out = sub(`const alerts = await import(${J('focusmon/alerts.js')});
    const now = Date.now(); const texts = [];
    alerts.writeRule('create', { name: '앱', metric: 'app', app: 'nginx.service', threshold: 1, durMin: 5, severity: 'crit', scope: { kind: 'record' } }, { by: 'a' });
    const q = (_t, _k, text) => { texts.push(text); return 'x'; };
    // ① 경계 뒤 표본은 왔다(서비스 지도 없음 — 값은 모름) · 지금 값 기억은 없음 → 점이 있으니 '아직 없음' 이 아니다
    const id1 = 'fm-k6k6k6k601';
    await alerts.alertCycle({ store: { memBlocks: () => [], memProcs: () => new Map([[1, [{ t: now - 10_000, apps: {} }]]]), resetAtOf: () => now - 30_000, queueEvent: q }, targets: [{ id: id1, name: 'h1' }], recordIds: new Set([id1]), now });
    alerts.writeRule('create', { name: 'CPU', metric: 'cpu', threshold: 90, durMin: 5, severity: 'crit', scope: { kind: 'record' } }, { by: 'a' });
    // ② 판정 창 안의 점은 없지만 경계 뒤 지금 값이 있다(창보다 조금 앞에 왔다 끊김) → '아직 없음' 이 아니다
    const id2 = 'fm-k6k6k6k602'; const reset = now - 5 * 60_000 - 100_000;
    await alerts.alertCycle({ store: { memBlocks: () => [], memProcs: () => new Map(), resetAtOf: () => reset, latestOf: () => ({ ts: reset + 5_000, sample: {} }), latestProcsOf: () => ({ ts: reset + 5_000, list: [] }), queueEvent: q }, targets: [{ id: id2, name: 'h2' }], recordIds: new Set([id2]), now });
    console.log(JSON.stringify(texts.filter((x) => /판정 보류/.test(x))));`);
  assert.ok(out.length >= 2, JSON.stringify(out));
  for (const x of out) assert.match(x, /값을 못 읽음\(수집 끊김 · 엣지 응답 없음\)$/, x);
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
    const mk = { nodeDiff: store.machineKeyOf({ agent: 'a', host: 'h' }) !== store.machineKeyOf({ agent: 'b', host: 'h' }), caseSame: store.machineKeyOf({ agent: 'Edge', host: 'h' }) === store.machineKeyOf({ agent: 'edge', host: 'h' }), acct: store.machineKeyOf({ agent: 'a', host: 'h', username: 'x', port: 1 }) === store.machineKeyOf({ agent: 'a', host: 'h', username: 'y', port: 2 }) };
    console.log(JSON.stringify({ ep0, ep1, same: ep0 === ep1, keyOk: ep1 === store.machineKeyOf(moved.target), afterOld, newer, tOld, tNew, mk }));`, { DATA_SOURCE: 'live' });
  assert.match(out.ep0, /^[a-f0-9]{16}$/); assert.equal(out.same, false); assert.equal(out.keyOk, true);
  assert.deepEqual(out.mk, { nodeDiff: true, caseSame: true, acct: true }, '기계 열쇠 = 노드(대소문자 무시) + 주소 · 계정 · 포트는 넣지 않는다');
  assert.deepEqual({ latest: out.afterOld.latest, hello: out.afterOld.hello, st: out.afterOld.st, load: out.afterOld.load, procs: out.afterOld.procs }, { latest: false, hello: null, st: null, load: null, procs: false },
    '수정 전: 깨우기 동기화의 예전 서버 표본이 지운 지금 값 · OS 를 다시 채웠다(cpu 95 · hello old)');
  assert.equal(out.afterOld.acc.oldEp, 5, '표본 2 · 프로세스 1 · 상태 1 · 부하 1'); assert.equal(out.afterOld.acc.samples, 0);
  assert.deepEqual(out.newer, { cpu: 5, acc: 1 });
  assert.equal(out.tOld, null, '예전 접속처의 시험 결과는 새 접속처의 것이 아니다'); assert.equal(out.tNew, 'auth');
});

test('E6 — 예전 접속처의 시험 결과를 버리면 지금 시험을 바로 다시 배달 · 옛 엣지(표지 없음)의 결과는 울타리 동안 받지 않는다(반증 EDGE-F2)', () => {
  const out = sub(`const registry = await import(${J('focusmon/registry.js')}); const store = await import(${J('focusmon/store.js')});
    const edge = await import(${J('central/focusMonEdge.js')}); const svc = await import(${J('focusmon/service.js')}); const { endpointKey } = await import(${J('focusmon/audit/service.js')});
    const t = registry.addTarget({ name: 'e-6', host: '10.7.2.1', port: 22, username: 'dvcmon', agent: 'edge-t' }, { agents: ['edge-t'] }).target; const id = t.id;
    let now = Date.now();
    store.requestEdgeTest(id, 'edge-t', now);
    const r0 = edge.handleEdgeSync('edge-t', { sentAt: now }, now); const ep0 = r0.tests[0]?.ep;
    const moved = registry.updateTarget(id, { host: '10.7.2.2' }, { agents: ['edge-t'] }).target;
    now += 1000; svc.targetsEndpointChanged([[t, moved]], now);
    store.requestEdgeTest(id, 'edge-t', now);
    const r1 = edge.handleEdgeSync('edge-t', { sentAt: now }, now); const d1 = r1.tests.map((x) => x.ep);   // 새 시험 배달(엣지는 예전 시험이 돌고 있어 건너뜀)
    now += 2000;
    const r2 = edge.handleEdgeSync('edge-t', { sentAt: now, tests: [{ id, ep: ep0, result: { ok: true, kind: 'ok' } }] }, now);   // 예전 접속처 결과 도착 → 버림
    const again = r2.tests.map((x) => x.ep);
    const res1 = store.testOf(id)?.result ?? null;
    // 옛 엣지(표지 없음): 같은 흐름 — 바꿀 때 돌던 시험의 결과는 울타리가 풀린 뒤에 와도 버리고, 그다음 결과(새 시험)는 받는다
    const u = registry.addTarget({ name: 'e-7', host: '10.7.3.1', port: 22, username: 'dvcmon', agent: 'edge-t' }, { agents: ['edge-t'] }).target;
    store.requestEdgeTest(u.id, 'edge-t', now); edge.handleEdgeSync('edge-t', { sentAt: now }, now);
    const um = registry.updateTarget(u.id, { host: '10.7.3.2' }, { agents: ['edge-t'] }).target;
    now += 1000; svc.targetsEndpointChanged([[u, um]], now); store.requestEdgeTest(u.id, 'edge-t', now);
    for (let i = 0; i < 4; i++) { now += 2000; edge.handleEdgeSync('edge-t', { sentAt: now }, now); }   // 울타리가 풀릴 만큼 동기화
    now += 2000; edge.handleEdgeSync('edge-t', { sentAt: now, tests: [{ id: u.id, result: { ok: true, kind: 'ok' } }] }, now);
    const oldRes = store.testOf(u.id)?.result ?? null;
    now += 2000; edge.handleEdgeSync('edge-t', { sentAt: now, tests: [{ id: u.id, result: { ok: false, kind: 'auth' } }] }, now);
    console.log(JSON.stringify({ ep0ok: ep0 === endpointKey(t), d1: d1.length === 1 && d1[0] === endpointKey(moved), again: again.length === 1 && again[0] === endpointKey(moved), oldEp: r2.accepted.oldEp, res1, oldRes, newRes: store.testOf(u.id)?.result?.kind ?? null }));`, { DATA_SOURCE: 'live' });
  assert.deepEqual(out, { ep0ok: true, d1: true, again: true, oldEp: 1, res1: null, oldRes: null, newRes: 'auth' }, '수정 전: 새 시험이 60초 뒤에야 다시 배달됐다 · 옛 엣지가 늦게 보낸 예전 접속처 결과가 새 주소의 결과로 남았다');
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

test('E7 — 옛 엣지 울타리: 표본의 호스트 이름으로 예전 서버를 가른다(응답이 닿지 않아 두 번이 모자란 경우 — 반증 EDGE-F1) · 같은 이름 복제는 상한 뒤 푼다', () => {
  const out = sub(`const registry = await import(${J('focusmon/registry.js')}); const store = await import(${J('focusmon/store.js')});
    const edge = await import(${J('central/focusMonEdge.js')}); const svc = await import(${J('focusmon/service.js')});
    const mk = (name, host) => registry.addTarget({ name, host, port: 22, username: 'dvcmon', agent: 'edge-h' }, { agents: ['edge-h'] }).target;
    const a = mk('h-a', '10.8.0.1'); const b = mk('h-b', '10.8.0.2');
    store.startSession({ targets: [a.id, b.id], interval: 2, mode: 'watch', by: 't' });
    let now = Date.now();
    const one = (id, host) => { now += 2000; return edge.handleEdgeSync('edge-h', { sentAt: now, samples: [{ id, t: now - 100, s: { cpu: { pct: 1 } }, hello: { hostname: host, isLinux: true } }] }, now).accepted.samples; };
    one(a.id, 'old-db'); one(b.id, 'clone');
    for (const [t, h] of [[a, '10.8.0.11'], [b, '10.8.0.12']]) { const m = registry.updateTarget(t.id, { host: h }, { agents: ['edge-h'] }).target; svc.targetsEndpointChanged([[t, m]], now); }
    const ga = []; for (let i = 0; i < 4; i++) ga.push(one(a.id, 'old-db'));   // 응답이 닿지 않아 엣지가 계속 예전 서버를 본다
    ga.push(one(a.id, 'new-db')); ga.push(one(a.id, 'old-db'));             // 새 서버가 오면 푼다(그 뒤는 막지 않는다 — 엣지가 새 접속처를 적용했다)
    const gb = []; for (let i = 0; i < 12; i++) gb.push(one(b.id, 'clone'));  // 같은 이름(복제) — 상한 뒤 푼다
    console.log(JSON.stringify({ ga, gb }));`, { DATA_SOURCE: 'live' });
  assert.deepEqual(out.ga, [0, 0, 0, 0, 1, 1], '수정 전: 동기화 두 번 뒤 예전 서버 표본을 받았다');
  // 울타리는 바뀐 뒤 그 엣지의 동기화 수로 센다 — 위 a 의 6번이 이미 지났으므로 b 는 상한(10) − 6 = 4번 뒤부터 받는다
  assert.equal(out.gb.indexOf(1), 4, `같은 이름(복제)은 바뀐 뒤 동기화 ${10}번이 지나면 받는다 — ${out.gb}`);
  assert.ok(out.gb.slice(4).every((x) => x === 1));
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

test('E5 — 실수집 수집기(가짜 SSH · 컨테이너 원문)도 표본 · 상태에 열쇠를 붙인다', () => {
  const out = sub(`const { createRunner } = await import(${J('focusmon/runner.js')}); const svc = await import(${J('focusmon/service.js')}); const fs = await import('node:fs');
    const lines = fs.readFileSync(${JSON.stringify(path.join(HERE, 'fixtures/focusmon/container-linux-6.18.txt'))}, 'utf8').split('\\n');
    const got = { s: [], st: [] };
    const connect = async (_c, fn) => fn({ execStream: async (_cmd, { onLine }) => { lines.forEach(onLine); await new Promise((r) => setTimeout(r, 300)); return { code: 0 }; } });
    svc.focusKeys.ensureKey();
    const r = createRunner({ keys: svc.focusKeys, connect, sink: { sample: (id, ts, s, h, ep) => got.s.push(ep || '-'), procs: () => {}, status: (id, st, ep) => got.st.push(ep || '-'), load: () => {} } });
    r.reconcile([{ id: 'fm-e5e5e5e501', host: '10.9.9.9', port: 22, username: 'u', interval: 2, procEvery: 5, ep: 'd'.repeat(16) }]);
    await new Promise((x) => setTimeout(x, 1500)); r.stopAll(); svc.stopFocusMon?.();
    console.log(JSON.stringify({ s: [...new Set(got.s)], n: got.s.length, st: [...new Set(got.st)] }));
    process.exit(0);`);
  assert.ok(out.n >= 1, '표본을 받았다'); assert.deepEqual(out.s, ['d'.repeat(16)]); assert.deepEqual(out.st, ['d'.repeat(16)]);
});

test('S2 — 기계를 바꾼 뒤 화면의 지금 값 · 표 · 프로세스는 새 서버 표본만(차트는 기록 그대로 — 반증 SD-2)', () => {
  const out = sub(`const store = await import(${J('focusmon/store.js')}); const Q = await import(${J('focusmon/query.js')}); const svc = await import(${J('focusmon/service.js')});
    const now = Date.now(); const id = 'fm-s2s2s2s2s2';
    for (let i = 0; i < 30; i++) store.ingestSample(id, now - 60_000 + i * 2000, { cpu: { pct: 95 }, mem: { pct: 80 } }, null, now);
    store.ingestProcs(id, now - 5000, { n: 7, top: [{ pid: 1, c: 'oldproc', cpu: 90 }] });
    const t = { id, name: 's', host: '10.6.0.1', port: 22, username: 'u', agent: '' };
    svc.targetsEndpointChanged([[t, { ...t, host: '10.6.0.2' }]], now);
    const w = Q.normWindow({ win: 5 }, now + 1000);
    const ov1 = (await Q.overview([id], w)).targets[0]; const sd1 = await Q.serverDetail(id, w); const pr1 = (await Q.procs([id], w)).per[0];
    store.ingestSample(id, now + 500, { cpu: { pct: 7 }, mem: { pct: 10 } }, null, now + 500);
    store.ingestProcs(id, now + 600, { n: 3, top: [{ pid: 9, c: 'newproc', cpu: 1 }] });
    const w2 = Q.normWindow({ win: 5 }, now + 2000);
    const ov2 = (await Q.overview([id], w2)).targets[0]; const sd2 = await Q.serverDetail(id, w2); const pr2 = (await Q.procs([id], w2)).per[0];
    svc.stopFocusMon?.();
    const cpuOf = (sum) => sum?.cpu ?? null;
    console.log(JSON.stringify({ ov1: { lastAt: ov1.lastAt, cpu: cpuOf(ov1.sum), n: ov1.n }, sd1: { table: sd1.table == null, lastAt: sd1.lastAt }, pr1: { top: pr1.top.length, total: pr1.total },
      ov2: { cpu: cpuOf(ov2.sum) }, sd2: { lastAt: sd2.lastAt === now + 500 }, pr2: pr2.top.map((x) => x.c), chartKept: ov1.series.cpu.some((v) => v != null) }));`);
  assert.deepEqual(out.ov1, { lastAt: null, cpu: null, n: out.ov1.n }, "수정 전: 예전 서버의 95% 가 '지금' 으로 보였다"); assert.ok(out.ov1.n >= 30, '구간 표본(차트)은 그대로');
  assert.deepEqual(out.sd1, { table: true, lastAt: null }); assert.deepEqual(out.pr1, { top: 0, total: null });
  assert.equal(out.chartKept, true, '차트는 같은 id 의 기록');
  assert.equal(out.ov2.cpu, 7); assert.equal(out.sd2.lastAt, true); assert.deepEqual(out.pr2, ['newproc']);
});

test('S3 — 가득 찰 때까지 추정은 기계 경계 뒤 점만(예전 · 새 서버를 한 직선으로 잇지 않는다 — 반증 SD-3)', () => {
  const out = sub(`const store = await import(${J('focusmon/store.js')}); const Q = await import(${J('focusmon/query.js')}); const db = await import(${J('focusmon/db.js')}); const svc = await import(${J('focusmon/service.js')});
    const now = Math.floor(Date.now() / 600_000) * 600_000; const id = 'fm-s3s3s3s3s3';
    const reg = await import(${J('focusmon/registry.js')});
    store.startSession({ targets: [id], interval: 2, mode: 'record', by: 't' });
    // 20시간 동안 10분마다 한 묶음 — 파일시스템 / 가 30% → 70%(예전 서버)
    const { newBlock, appendToBlock, encodeBlock } = await import(${J('focusmon/codec.js')});
    const rows = [];
    for (let h = 0; h < 120; h++) { const t = now - 20 * 3600_000 + h * 600_000; const b = newBlock(Math.floor(t / 60_000)); appendToBlock(b, t, [['f./.p', 30 + h / 3]], null); rows.push({ kind: 'm', target: id, minute: b.minute, n: 1, data: encodeBlock(b) }); }
    await db.writeBlocks(rows);
    const before = await Q.fillEstimate(id, { now });
    store.forgetTargetState(id, { machineChanged: true, now: now - 3600_000 });   // 한 시간 전에 기계를 바꿨다
    const after = await Q.fillEstimate(id, { now: now + 1 });
    svc.stopFocusMon?.();
    console.log(JSON.stringify({ before: before.state, beforeRow: !!before.rows['/'], after: after.state, afterSpan: after.spanH }));`, { DATA_SOURCE: 'live' });
  assert.equal(out.before, 'ok'); assert.equal(out.beforeRow, true);
  assert.equal(out.after, 'short', '수정 전: 경계 앞 19시간의 예전 서버 값으로 가득 참 날짜를 냈다'); assert.ok(out.afterSpan < 1.1);
});

test('S6 — 재시작해도 기계 경계는 DB 의 접속처 바뀜 사건으로 되살아난다(24시간 안) · 묶음 기억이 지워져도 남는다(반증 SD-3 재검증)', () => {
  const out = sub(`const store = await import(${J('focusmon/store.js')}); const db = await import(${J('focusmon/db.js')}); const svc = await import(${J('focusmon/service.js')});
    const now = Date.now(); const id = 'fm-s6s6s6s6s6';
    const t = { id, name: 's', host: '10.6.6.1', port: 22, username: 'u', agent: '' };
    svc.targetsEndpointChanged([[t, { ...t, host: '10.6.6.2' }]], now - 3600_000);
    const at = store.resetAtOf(id);
    await db.writeBlocks(store.drainWrites(1000));
    store.closeMinutes(now, new Set());   // 쉬는 대상의 묶음 기억을 지운다
    const afterIdle = store.resetAtOf(id);
    store._resetForTest();                 // 재시작
    const gone = store.resetAtOf(id);
    const n = await svc.restoreResets(now);
    store.noteResetAt('fm-old0000001', now - 25 * 3600_000, now);
    console.log(JSON.stringify({ at: at === now - 3600_000, afterIdle: afterIdle === at, gone, n, back: store.resetAtOf(id) === at, old: store.resetAtOf('fm-old0000001') }));
    svc.stopFocusMon?.();`, { DATA_SOURCE: 'live' });
  assert.deepEqual(out, { at: true, afterIdle: true, gone: 0, n: 1, back: true, old: 0 });
});

test('S7 — 겹치지 않는 묶음 합치기 빠른 길은 일반 길과 같은 결과(무작위 400쌍) · 큰 서버 20대 합쳐 쓰기의 한 번 멈춤 상한(반증 SD-1)', async () => {
  const C = await import('../src/focusmon/codec.js');
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const mk = (t0, n, keys, drop) => { const b = C.newBlock(100); for (let i = 0; i < n; i++) { const row = []; for (const k of keys) if (!(drop && (i + k.length) % 3 === 0)) row.push([k, Math.round(rnd() * 1000) / 10]); C.appendToBlock(b, t0 + i * 2000, row, { net: {}, dsk: {}, fs: { [`/${i % 2}`]: 1 } }); } return b; };
  let bad = 0;
  for (let r = 0; r < 200; r++) {
    const a = mk(6_000_000, 1 + (r % 15), ['c.pct', 'm.pct', `x${r % 5}`], r % 2); const b = mk(6_040_000, 1 + (r % 9), ['c.pct', 'n.eth0.rx', `y${r % 7}`], r % 3 === 0);
    for (const [p, q] of [[a, b], [b, a]]) {
      const f = C.decodeBlock(C.encodeBlock(C.mergeBlocks(p, q))); const g = C.decodeBlock(C.encodeBlock(C.mergeBlocksSlow(p, q)));
      if (JSON.stringify([f.ts, [...f.cols], f.meta]) !== JSON.stringify([g.ts, [...g.cols], g.meta])) bad += 1;
    }
  }
  assert.equal(bad, 0);
  // 한 번 멈춤: 열 4000개 서버 20대의 재시작 합쳐 쓰기 — 가장 긴 동기 구간(양보 사이)이 대상 하나 몫을 넘지 않는다(측정 — 이 개발 환경 기준 넉넉한 상한)
  const out = sub(`const store = await import(${J('focusmon/store.js')}); const db = await import(${J('focusmon/db.js')});
    const M0 = Math.floor(Date.now() / 60_000) * 60_000 - 5 * 60_000; const keys = Array.from({ length: 4000 }, (_, i) => 'd.sd' + i + '.wAwait');
    const sample = (v) => { const s = { cpu: { pct: v } }; return s; };
    const { newBlock, appendToBlock, encodeBlock } = await import(${J('focusmon/codec.js')});
    const big = (t0, n) => { const b = newBlock(M0 / 60_000); for (let i = 0; i < n; i++) appendToBlock(b, t0 + i * 2000, keys.map((k, j) => [k, (i + j) % 97]), null); return b; };
    const rows = []; for (let t = 0; t < 20; t++) { const b = big(M0, 15); rows.push({ kind: 'm', target: 'fm-big' + String(t).padStart(8, '0'), minute: b.minute, n: 15, data: encodeBlock(b) }); }
    await db.writeBlocks(rows);
    const mrows = []; for (let t = 0; t < 20; t++) { const b = big(M0 + 30_000, 15); mrows.push({ kind: 'm', target: 'fm-big' + String(t).padStart(8, '0'), minute: b.minute, n: 15, data: encodeBlock(b), merge: true }); }
    let maxGap = 0; let last = performance.now(); let stop = false;
    const tick = () => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; if (!stop) setImmediate(tick); };
    setImmediate(tick);
    const t0 = performance.now(); const w = await db.writeBlocks(mrows); const total = performance.now() - t0; stop = true;
    const nOf = (await db.readMetric('fm-big00000000', M0 / 60_000, M0 / 60_000))[0].n;
    console.log(JSON.stringify({ ok: w.ok, merged: w.merged.length, n: nOf, total: Math.round(total), maxGap: Math.round(maxGap) }));`, { DATA_SOURCE: 'live' });
  assert.equal(out.ok, true); assert.equal(out.merged, 20); assert.equal(out.n, 30);
  assert.ok(out.maxGap < out.total / 3 || out.total < 150, `양보 없이 한 번에 막지 않는다 — 가장 긴 멈춤 ${out.maxGap}ms / 전체 ${out.total}ms`);
});

test('A1~5 — 알림 관점 반증 반영: 보류 까닭(새 값 왔다 끊김) · 새 서버 첫 키 거부 사건 · OOM 표 경계 · 조절 상태 · 줄인 수는 창 끝 시각에', () => {
  const out = sub(`const store = await import(${J('focusmon/store.js')}); const svc = await import(${J('focusmon/service.js')}); const alerts = await import(${J('focusmon/alerts.js')}); const tune = await import(${J('focusmon/tune.js')});
    const now = Date.now(); const id = 'fm-a1a1a1a1a1';
    const t = { id, name: 'a', host: '10.5.0.1', port: 22, username: 'u', agent: '' };
    // AE-4: 조절 상태(주기)는 기계가 바뀌면 지운다
    tune.tuneTick({ targets: [t], loadOf: () => ({ serverPct: 50, groups: { proc: { pct: 40 } } }), settings: { autoTune: true, procEvery: 5, loadWarnPct: 1 }, now: now - 120_000 });
    const tuned = tune.tuneStateOf(id) != null;
    store.setStatus(id, { state: 'ok' }, now - 5000);
    svc.targetsEndpointChanged([[t, { ...t, host: '10.5.0.2' }]], now);
    const afterTune = tune.tuneStateOf(id);
    // AE-2: 새 서버의 첫 안정 상태가 키 거부면 앞 상태 없이도 적는다
    store.setStatus(id, { state: 'connecting' }, now + 1000); store.setStatus(id, { state: 'auth' }, now + 2000);
    const ev = store.drainWrites(1000).filter((r) => r.kind === 'e').map((r) => r.ekind);
    // AE-1: 경계 뒤 값이 왔다가 끊기면 '아직 없음' 이 아니다
    store.ingestSample(id, now + 3000, { cpu: { pct: 10 } }, null, now + 3000);
    alerts.writeRule('create', { name: 'CPU', metric: 'cpu', threshold: 90, durMin: 1, severity: 'crit', scope: { kind: 'record' } }, { by: 'a' });
    const texts = [];
    const fake = { ...store, queueEvent: (_t, _k, text) => { texts.push(text); return 'x'; } };
    await alerts.alertCycle({ store: fake, targets: [t], recordIds: new Set([id]), now: now + 200_000 });
    // AE-5: 끝난 창의 줄인 수는 1분 틱이 그 창 끝 시각에 적는다
    const id2 = 'fm-a5a5a5a5a5'; store.setStatus(id2, { state: 'ok' }, now);
    for (let i = 0; i < 20; i++) store.setStatus(id2, { state: i % 2 ? 'ok' : 'auth' }, now + 1000 + i * 1000);
    store.drainWrites(1000);
    const n0 = store.flushHeldStatusEvents(now + 60_000);
    const n1 = store.flushHeldStatusEvents(now + 1000 + store.STATUS_EVENT_WINDOW_MS + 1);
    const sum = store.drainWrites(1000).filter((r) => r.kind === 'e');
    const n2 = store.flushHeldStatusEvents(now + 2 * store.STATUS_EVENT_WINDOW_MS);
    svc.stopFocusMon?.();
    console.log(JSON.stringify({ tuned, afterTune, ev, hold: texts.find((x) => /판정 보류/.test(x)) || null, n0, n1, n2, sumAt: sum[0] ? sum[0].at - now : null, sumText: sum[0]?.text || null }));`);
  assert.equal(out.tuned, true); assert.equal(out.afterTune, null, '수정 전: 예전 서버의 조절 상태(주기 · 잠금)를 이었다');
  assert.ok(out.ev.includes('auth'), `수정 전: 새 서버의 키 거부가 사건에 없었다 — ${out.ev}`);
  assert.match(out.hold, /값을 못 읽음\(수집 끊김/, `수정 전: 새 값이 왔다 끊겨도 '아직 없음' 이라고 했다 — ${out.hold}`);
  assert.equal(out.n0, 0, '창이 끝나기 전에는 적지 않는다'); assert.equal(out.n1, 1); assert.equal(out.n2, 0, '한 번만');
  assert.equal(out.sumAt, 1000 + 10 * 60_000, '그 창 끝 시각'); assert.match(out.sumText, /그 10분 동안 \d+번 더 바뀜/);
});

test('A3 — 알림 탭 OOM · 커널 오류 표는 기계 경계 뒤 사건만 센다(예전 서버의 OOM 을 새 서버 줄에 넣지 않는다 — 반증 AE-3)', () => {
  const out = sub(`
    const express = (await import(${EXPRESS})).default;
    const { api } = await import(${J('routes/api.js')});
    const store = await import(${J('focusmon/store.js')}); const db = await import(${J('focusmon/db.js')}); const svc = await import(${J('focusmon/service.js')}); const registry = await import(${J('focusmon/registry.js')});
    const t = registry.addTarget({ name: 'oom-1', host: '10.5.5.1', port: 22, username: 'u', agent: '' }, { agents: [] }).target;
    const now = Date.now();
    store.queueEvent(t.id, 'oom', 'OOM — java 종료', now - 600_000); store.queueEvent(t.id, 'kerr', '커널 오류 5줄', now - 590_000);
    svc.targetsEndpointChanged([[t, { ...t, host: '10.5.5.2' }]], now - 300_000);
    store.queueEvent(t.id, 'oom', 'OOM — nginx 종료', now - 60_000);
    await db.writeBlocks(store.drainWrites(1000));
    const app = express(); app.use(express.json());
    app.use((req, _r, next) => { req.user = { username: 'a', role: 'admin', scope: null }; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const r = await fetch('http://127.0.0.1:' + srv.address().port + '/api/tools/focus-mon/alerts').then((x) => x.json());
    const row = (r.kmsg || []).find((x) => x.id === t.id);
    console.log(JSON.stringify({ oom: row?.oom ?? null, kerr: row?.kerr ?? null, last: row?.lastOom?.text ?? null })); svc.stopFocusMon(); srv.close(); process.exit(0);`,
  { DATA_SOURCE: 'live', AUTH_SECRET: 'fmb3570-secret-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' });
  assert.deepEqual(out, { oom: 1, kerr: 0, last: 'OOM — nginx 종료' }, '수정 전: 예전 서버의 java OOM · 커널 오류 5줄이 새 서버 줄에 들어갔다');
});

test('S4 — 합쳐 쓴 분은 메모리 묶음 · 조회 기억도 합친 값(반증 SD-4) · 합치기는 트랜잭션 밖에서(SD-1)', () => {
  const out = sub(`const store = await import(${J('focusmon/store.js')}); const db = await import(${J('focusmon/db.js')}); const rec = await import(${J('focusmon/recorder.js')}); const Q = await import(${J('focusmon/query.js')});
    rec._setFreeSpaceForTest(() => ({ free: 1e12, total: 2e12 }));   // 정정(변이 2회차): 이 줄 없이는 컨테이너 디스크 여유 5% 경계로 기록기가 멈춰 '기록기 틱도 맞춘다' 를 보지 못했다
    const M0 = Math.floor(Date.now() / 60_000) * 60_000 - 3 * 60_000; const id = 'fm-s4s4s4s4s4';
    for (let i = 0; i < 10; i++) store.ingestSample(id, M0 + i * 2000, { cpu: { pct: 10 } }, null, M0 + i * 2000);
    store.closeAll(); await db.writeBlocks(store.drainWrites(1000));
    store._resetForTest();
    for (let i = 0; i < 5; i++) store.ingestSample(id, M0 + 40_000 + i * 2000, { cpu: { pct: 30 } }, null, M0 + 70_000);
    store.closeMinutes(M0 + 60_000 + store.GRACE_MS + 1, new Set([id]));
    const rows = store.drainWrites(1000);
    const w = await db.writeBlocks(rows);
    const memBefore = store.memBlocks(id).find((b) => b.minute === M0 / 60_000).ts.length;
    for (const x of w.merged) { store.adoptMerged(x.target, x.minute, x.block); Q.forgetCached(x.target, x.minute); }
    const memAfter = store.memBlocks(id).find((b) => b.minute === M0 / 60_000).ts.length;
    // 기록기 틱이 같은 일을 한다
    for (let i = 0; i < 3; i++) store.ingestSample(id, M0 + 50_000 + i * 1000 + 500, { cpu: { pct: 40 } }, null, M0 + 80_000);
    store.flushReopened(id); await rec.recordTick(Date.now());
    const memTick = store.memBlocks(id).find((b) => b.minute === M0 / 60_000).ts.length;
    console.log(JSON.stringify({ merged: w.merged.length, pre: rows.filter((r) => r._data).length, memBefore, memAfter, memTick, writes: rec.recorderStatus().writes }));`, { DATA_SOURCE: 'live' });
  assert.equal(out.writes, 1, '기록기가 실제로 썼다');
  assert.equal(out.merged, 1); assert.ok(out.pre >= 2, '원본 · 요약을 트랜잭션 밖에서 미리 합쳤다');
  assert.equal(out.memBefore, 5); assert.equal(out.memAfter, 15, '수정 전: 메모리(최근 31분 화면)는 재시작 뒤 5표본뿐');
  assert.equal(out.memTick, 18, '기록기 틱도 맞춘다');
});

test('M5 — 기록기 틱(recordTick)이 합쳐 쓴 분을 메모리 묶음에 맞춘다(손으로 맞추지 않아도 — 변이 2회차 생존 SD4)', () => {
  const out = sub(`const store = await import(${J('focusmon/store.js')}); const db = await import(${J('focusmon/db.js')}); const rec = await import(${J('focusmon/recorder.js')});
    rec._setFreeSpaceForTest(() => ({ free: 1e12, total: 2e12 }));   // 실행 환경의 디스크 여유(5% 경계)에 흔들리지 않게 — 기록기가 '여유 부족' 으로 멈추면 맞춤을 보지 못한다
    const M0 = Math.floor(Date.now() / 60_000) * 60_000 - 3 * 60_000; const id = 'fm-m5m5m5m5m5';
    for (let i = 0; i < 10; i++) store.ingestSample(id, M0 + i * 2000, { cpu: { pct: 10 } }, null, M0 + i * 2000);
    store.closeAll(); await db.writeBlocks(store.drainWrites(1000));
    store._resetForTest();
    for (let i = 0; i < 5; i++) store.ingestSample(id, M0 + 40_000 + i * 2000, { cpu: { pct: 30 } }, null, M0 + 70_000);
    store.closeMinutes(M0 + 60_000 + store.GRACE_MS + 1, new Set([id]));
    const before = store.memBlocks(id).find((b) => b.minute === M0 / 60_000).ts.length;
    await rec.recordTick(Date.now());
    const after = store.memBlocks(id).find((b) => b.minute === M0 / 60_000).ts.length;
    console.log(JSON.stringify({ before, after, pending: store.pendingWrites(), writes: rec.recorderStatus().writes }));`, { DATA_SOURCE: 'live' });
  assert.equal(out.before, 5); assert.equal(out.pending, 0); assert.equal(out.writes, 1, '기록기가 실제로 썼다(멈춤이 아니다)');
  assert.equal(out.after, 15, '기록기가 합친 묶음을 메모리에 맞추지 않으면 최근 31분 화면이 재시작 뒤 받은 5표본뿐');
});

test('M4 — 합쳐 쓸 묶음이 많아도(재시작 뒤 대상 2000개) 미리 합치기가 이벤트 루프에 양보한다(반증 SD-1 · 변이 2회차 생존 — 양보 없음)', () => {
  const out = sub(`const store = await import(${J('focusmon/store.js')}); const db = await import(${J('focusmon/db.js')});
    const M0 = Math.floor(Date.now() / 60_000) * 60_000 - 5 * 60_000;
    const fill = (pct, off) => { for (let k = 0; k < 2000; k++) { const id = 'fm-m4m' + String(k).padStart(7, '0'); for (let i = 0; i < 6; i++) { const ts = M0 + off + i * 4000; store.ingestSample(id, ts, { cpu: { pct }, mem: { pct }, load: { l1: 1 } }, null, ts); } } store.closeAll(); };
    fill(10, 0); await db.writeBlocks(store.drainWrites(100000));
    store._resetForTest(); fill(30, 30_000);
    const rows = store.drainWrites(100000);
    let spins = 0, done = false; const spin = () => { spins += 1; if (!done) setImmediate(spin); }; setImmediate(spin);
    const w = await db.writeBlocks(rows); done = true;
    console.log(JSON.stringify({ merge: rows.filter((r) => r.merge).length, merged: w.merged?.length ?? null, spins }));`, { DATA_SOURCE: 'live' });
  assert.equal(out.merge, 4000); assert.equal(out.merged, 2000);
  assert.ok(out.spins >= 3, `합치기 동안 다른 일이 돌 틈이 없었다(spins=${out.spins}) — 대상 2000개 재시작이면 수백 ms 를 한 번에 막는다`);
});

test('S5 — 옛 엣지 울타리는 시간이 지나도 풀리지 않고 동기화 두 번에 풀린다(회선이 끊긴 사이 주소를 고친 경우 — 반증 SD-5)', () => {
  const out = sub(`const store = await import(${J('focusmon/store.js')});
    const t0 = Date.now(); const id = 'fm-s5s5s5s5s5';
    store.forgetTargetState(id, { machineChanged: true, now: t0 });
    const a = store.edgeFenced(id, t0 + 30 * 60_000);
    store.edgeFenceSynced([id]); const b = store.edgeFenced(id, t0 + 31 * 60_000);
    store.edgeFenceSynced([id]); const c = store.edgeFenced(id, t0 + 32 * 60_000);
    console.log(JSON.stringify({ a, b, c }));`);
  assert.deepEqual(out, { a: true, b: true, c: false }, '수정 전: 2분 뒤 저절로 풀려 다시 붙은 엣지의 밀린 예전 서버 표본을 받았다');
});

test('S8 — 기계 경계는 뒤로 가지 않고(늦게 읽은 옛 사건) · 기동(startFocusMon)이 DB 의 최근 사건으로 되살린다(변이 2회차 생존 SD3 두 건)', () => {
  const out = sub(`const store = await import(${J('focusmon/store.js')}); const db = await import(${J('focusmon/db.js')}); const svc = await import(${J('focusmon/service.js')});
    const now = Date.now(); const id = 'fm-s8s8s8s8s8';
    const a = store.noteResetAt(id, now - 60_000, now);
    const b = store.noteResetAt(id, now - 120_000, now);   // 더 옛 경계 — 되돌리지 않는다
    const keep = store.resetAtOf(id) === now - 60_000;
    const t = { id, name: 's', host: '10.8.8.1', port: 22, username: 'u', agent: '' };
    svc.targetsEndpointChanged([[t, { ...t, host: '10.8.8.2' }]], now - 1800_000);
    await db.writeBlocks(store.drainWrites(1000));
    store._resetForTest();
    const gone = store.resetAtOf(id);
    svc.startFocusMon();
    let back = 0; for (let i = 0; i < 100 && !back; i++) { await new Promise((r) => setTimeout(r, 30)); back = store.resetAtOf(id); }
    svc.stopFocusMon();
    console.log(JSON.stringify({ a, b, keep, gone, back: back === now - 1800_000 }));
    process.exit(0);`, { DATA_SOURCE: 'live' });
  assert.deepEqual(out, { a: true, b: false, keep: true, gone: 0, back: true }, '경계를 옛 값으로 되돌리면 예전 서버 표본이 다시 지금 값이 된다 · 기동이 되살리지 않으면 재시작 뒤 경계가 없다');
});

test('S9 — 1분 틱(minuteTick)이 끝난 창의 줄인 상태 사건 수를 적는다(다음 사건을 기다리지 않는다 — 변이 2회차 생존 AE5)', () => {
  const out = sub(`const store = await import(${J('focusmon/store.js')}); const svc = await import(${J('focusmon/service.js')});
    const now = Date.now(); const id = 'fm-s9s9s9s9s9';
    store.setStatus(id, { state: 'ok' }, now);
    for (let i = 0; i < 20; i++) store.setStatus(id, { state: i % 2 ? 'ok' : 'auth' }, now + 1000 + i * 1000);
    store.drainWrites(1000);
    const r = await svc.minuteTick(now + 1000 + store.STATUS_EVENT_WINDOW_MS + 1);
    const ev = store.drainWrites(1000).filter((x) => x.kind === 'e' && x.target === id).map((x) => x.text);
    svc.stopFocusMon?.();
    console.log(JSON.stringify({ skipped: r?.skipped ?? null, ev }));
    process.exit(0);`, { DATA_SOURCE: 'live', CENTRAL_URL: '' });
  assert.equal(out.skipped, null);
  assert.ok(out.ev.some((x) => /그 10분 동안 \d+번 더 바뀜/.test(x)), JSON.stringify(out.ev));
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
