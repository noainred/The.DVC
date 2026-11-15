/**
 * focusMonFullAudit29.test.js — 전체 점검 29회차(서버 집중 모니터링) 확정분.
 *  F1 접속처가 바뀐 대상의 커널 메시지 기준 · hello 도 지운다 · F2 엣지 상태 시각도 '보낸 시각 − 표본 시각' 으로 옮긴다
 *  F3 CSV 갱신 · 노드 옮기기도 예전 접속처 상태를 지운다(엣지마다 깨우기 한 번) · F4 동시 상한 'limit' 을 sink 로 알린다
 *  F5 수집 중인 서버를 지우면 그 수집에서 뺀다 · F6 잘린 서비스 목록(allCut)의 없는 이름은 0 이 아니라 보류
 *  F7 등록부 손상이면 조회 · 시험 · 수집 시작도 503 · F8 내려받기 실패를 삼키지 않는다(웹 소스)
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
const WEB = path.join(HERE, '../../web/src');
const J = (p) => JSON.stringify(path.join(SRC, p));
const EXPRESS = JSON.stringify(path.join(HERE, '../node_modules/express/index.js'));

const sub = (setup, code, env = {}) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fmfa29-'));
  try {
    setup(d);
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, CONFIG_DIR: d, DATA_DIR: d, FOCUSMON_SSH_KEY: '', ...env }, encoding: 'utf8', timeout: 60_000 });
    const line = r.stdout.trim().split('\n').pop();
    try { return JSON.parse(line); } catch { throw new Error(`${r.stdout}\n${r.stderr}`); }
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
};
const none = () => {};
// 실제 라우트(api.js)를 띄우는 머리 — 관리자 · 전체 범위
const ROUTE_HEAD = `
  const express = (await import(${EXPRESS})).default;
  const { api } = await import(${J('routes/api.js')});
  const svc = await import(${J('focusmon/service.js')});
  const registry = await import(${J('focusmon/registry.js')});
  const store = await import(${J('focusmon/store.js')});
  const app = express(); app.use(express.json({ limit: '2mb' }));
  app.use((req, _r, next) => { req.user = { username: 'a', role: 'admin', scope: null }; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const done = (o) => { console.log(JSON.stringify(o)); svc.stopFocusMon(); srv.close(); process.exit(0); };`;
const ROUTE_ENV = { DATA_SOURCE: 'mock', CENTRAL_TOKEN: 'ctok-fmfa29', AUTH_SECRET: 'fmfa29-secret-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' };

test('F1 — 접속처가 바뀐 대상: 커널 메시지 기준 · 읽기 상태 · hello 도 지운다(새 서버 버퍼를 사건으로 적지 않게)', () => {
  const out = sub(none, `const store = await import(${J('focusmon/store.js')});
    const id = 'fm-aaaaaaaaaa'; const now = Date.now();
    store.ingestSample(id, now - 2000, { dt: 2, up: 1000, cpu: { pct: 1, cores: [] }, mem: { pct: 1 }, net: [], dsk: [] }, { release: 'RHEL 7.8', ncpu: 16, hostname: 'old-db01' }, now);
    store.ingestKmsg(id, { f: true, rc: 0, boot: Math.round(now / 1000) - 86400, bid: '11111111-1111-1111-1111-111111111111', oom: [], en: 5, es: '100.000001' }, now);
    store.drainWrites(1000);
    store.forgetTargetState(id);
    const hello = store.helloOf(id); const km = store.kmsgOf(id);
    store.ingestKmsg(id, { f: true, rc: 0, boot: Math.round(now / 1000) - 3600, bid: '22222222-2222-2222-2222-222222222222', oom: [], en: 1234, es: '3000.000001' }, now + 5000);
    const ev = store.drainWrites(1000).filter((r) => r.kind === 'e').map((r) => r.text);
    console.log(JSON.stringify({ hello, km, ev }));`);
  assert.equal(out.hello, null, "수정 전: 예전 서버의 'RHEL 7.8 · 16코어' 가 새 IP 옆에 남았다");
  assert.equal(out.km, null);
  assert.deepEqual(out.ev, [], "수정 전: '커널 오류 1234줄(재부팅 뒤 버퍼)' 사건");
});

test('F2 — 엣지 상태 시각(lastSampleAt)도 보낸 시각 기준으로 옮긴다(엣지 시계가 늦어도 거짓 지연 없음 · 앞서도 오래된 상태는 지연)', () => {
  const out = sub(none, `const registry = await import(${J('focusmon/registry.js')}); const store = await import(${J('focusmon/store.js')}); const edge = await import(${J('central/focusMonEdge.js')});
    const id = registry.addTarget({ name: 'pl-01', host: '10.9.0.11', port: 22, username: 'dvcmon', agent: 'edge-pl' }, { agents: ['edge-pl'] }).target.id;
    store.startSession({ targets: [id], interval: 2, mode: 'watch', by: 't' });
    const central = Date.now(); const r = {};
    let e = central - 20_000; edge.handleEdgeSync('edge-pl', { sentAt: e, status: { [id]: { state: 'ok', lastSampleAt: e - 1000, interval: 2 } } }, central); r.slow = central - store.statusOf(id).lastSampleAt;
    e = central + 3_600_000; edge.handleEdgeSync('edge-pl', { sentAt: e, status: { [id]: { state: 'ok', lastSampleAt: e - 600_000, interval: 2 } } }, central); r.fastOld = central - store.statusOf(id).lastSampleAt;
    edge.handleEdgeSync('edge-pl', { status: { [id]: { state: 'ok', lastSampleAt: central - 7000, interval: 2 } } }, central); r.noSent = central - store.statusOf(id).lastSampleAt;
    console.log(JSON.stringify(r));`);
  assert.equal(out.slow, 1000, '수정 전: 21000ms(시계가 20초 늦은 엣지의 모든 서버가 지연)');
  assert.equal(out.fastOld, 600_000, '수정 전: 0ms(시계가 앞선 엣지는 10분 전 상태도 지연이 아니었다)');
  assert.equal(out.noSent, 7000, '보낸 시각이 없으면(옛 엣지) 예전처럼 — 나이 0 을 지어내지 않는다');
});

test('F3 — CSV 갱신 · 노드 옮기기도 PUT 과 같이 예전 접속처의 상태 · 시험 결과 · 부하 창을 지운다', () => {
  const out = sub(none, `${ROUTE_HEAD}
    const { issueAgentToken } = await import(${J('central/agentTokens.js')}); issueAgentToken('edge-pl'); issueAgentToken('edge-us');
    const seed = (id) => { store.setStatus(id, { state: 'ok', lastSampleAt: Date.now(), osVerified: true }); store.putTestResult(id, { ok: true, kind: 'ok', via: 'edge' }); store.setLoad(id, { cpuPct: 0.5, windowS: 30 }); };
    const st = (id) => ({ status: store.statusOf(id)?.state ?? null, test: store.testOf(id)?.result?.kind ?? null, load: !!store.loadOf(id) });
    const ag = { agents: ['edge-pl', 'edge-us'] };
    const a = registry.addTarget({ name: 'csv-1', host: '10.9.1.1', port: 22, username: 'olduser', agent: 'edge-pl' }, ag).target;
    const b = registry.addTarget({ name: 'mv-1', host: '10.9.1.2', port: 22, username: 'dvcmon', agent: 'edge-pl' }, ag).target;
    seed(a.id); seed(b.id);
    const c = await call('POST', '/api/tools/focus-mon/targets/import', { text: '이름,IP,포트,계정,담당 노드\\ncsv-1,10.9.1.1,22,newuser,edge-pl\\n', mode: 'valid', update: true });
    const m = await call('POST', '/api/tools/focus-mon/targets/move', { from: 'edge-pl', to: 'edge-us', ids: [b.id] });
    done({ csv: c.status, csvMoved: c.body?.moved?.length, a: st(a.id), move: m.status, b: st(b.id) });`, ROUTE_ENV);
  assert.equal(out.csv, 200); assert.equal(out.csvMoved, 1);
  assert.deepEqual(out.a, { status: null, test: null, load: false }, '수정 전: CSV 뒤 status ok · test ok 가 남음');
  assert.equal(out.move, 200);
  assert.deepEqual(out.b, { status: null, test: null, load: false }, '수정 전: 옮기기 뒤 status ok · test ok 가 남음');
  const src = fs.readFileSync(path.join(SRC, 'routes/api/focusMon.js'), 'utf8');
  assert.equal((src.match(/targetsEndpointChanged\(\(r\.moved \|\| \[\]\)\.map\(\(id\) => \[before\.get\(id\) \|\| null, registry\.getTarget\(id\)\]\)\);/g) || []).length, 2, 'CSV · 옮기기가 같은 함수(엣지마다 깨우기 한 번)');
});

test('F4 — 노드 동시 상한을 넘은 대상의 limit 상태를 sink 로 한 번 알린다', () => {
  const out = sub(none, `const { createRunner } = await import(${J('focusmon/runner.js')});
    const got = []; const runner = createRunner({ keys: null, sink: { sample() {}, procs() {}, load() {}, status: (id, st) => { got.push(id + ':' + st.state); } } });
    const want = [{ id: 'fm-d0000000', host: '192.0.2.1', port: 22, username: 'x', interval: 2, demo: true }, { id: 'fm-d0000001', host: '192.0.2.2', port: 22, username: 'x', interval: 2, demo: true }];
    runner.reconcile(want); runner.reconcile(want);
    runner.stopAll();
    console.log(JSON.stringify({ limits: got.filter((x) => x.endsWith(':limit')) }));`, { FOCUSMON_MAX_STREAMS: '1' });
  assert.deepEqual(out.limits, ['fm-d0000001:limit'], '수정 전: 0건(화면 · 엣지 본문에 닿지 않음) · 틱마다 다시 쓰지 않는다');
});

test('F5 — 수집 중인 서버를 지우면 그 수집에서 빼 한도를 돌려준다', () => {
  const out = sub(none, `${ROUTE_HEAD}
    const ids = []; for (let i = 0; i < 20; i++) ids.push(registry.addTarget({ name: 'srv-' + i, host: '10.77.0.' + (i + 1), port: 22, username: 'dvcmon', agent: 'edge-x' }, { agents: ['edge-x'] }).target.id);
    const s1 = await call('POST', '/api/tools/focus-mon/sessions', { targets: ids.slice(0, 1), mode: 'record', interval: 2 });
    const s2 = await call('POST', '/api/tools/focus-mon/sessions', { targets: ids.slice(1, 20), mode: 'record', interval: 2 });
    const del = await call('DELETE', '/api/tools/focus-mon/targets/' + ids[0]);
    const inSess = store.sessionOfTarget(ids[0]);
    const nid = registry.addTarget({ name: 'new-1', host: '10.77.1.1', port: 22, username: 'dvcmon', agent: 'edge-x' }, { agents: ['edge-x'] }).target.id;
    const add = await call('POST', '/api/tools/focus-mon/sessions/' + s2.body.session.id + '/targets', { targets: [nid] });
    done({ s: [s1.status, s2.status], del: del.status, inSess, add: add.status, addCode: add.body?.code ?? null });`, ROUTE_ENV);
  assert.deepEqual(out.s, [200, 200]); assert.equal(out.del, 200);
  assert.equal(out.inSess, null, '수정 전: 지운 id 가 수집 정의에 남았다');
  assert.equal(out.add, 200, `수정 전: 409 too-many-record(실제 수집은 19대) — ${out.addCode}`);
});

test('F6 — 서비스 목록이 상한에서 잘린 표본(allCut)의 없는 이름은 0(죽음)이 아니라 보류', () => {
  const out = sub(none, `const { appGroups } = await import(${J('focusmon/rates.js')}); const AL = await import(${J('focusmon/alerts.js')}); const store = await import(${J('focusmon/store.js')}); const edge = await import(${J('central/focusMonEdge.js')});
    const cur = []; const units = new Map();
    for (let i = 0; i < 410; i++) { const pid = 1000 + i; cur.push({ pid, ppid: 1, comm: 'app' + i, thr: 1, rss: 100, start: 10 }); units.set(pid, 'docker-' + String(i).padStart(12, '0') + '.scope'); }
    cur.push({ pid: 9000, ppid: 1, comm: 'oracle', thr: 4, rss: 1000, start: 10 }); units.set(9000, 'oracle-db.service');
    const g = appGroups(cur, [], { tck: 100, dt: 5, units, withAll: true });
    const id = 'fm-cccccccccc'; const now = Date.now();
    for (let t = now - 90_000; t <= now; t += 15_000) store.ingestProcs(id, t, { n: cur.length, top: [], apps: g });
    const rule = { id: 'ar-000000000001', metric: 'app', app: 'oracle-db.service', threshold: 1, durMin: 1, op: 'lt' };
    const pts = AL.pointsFor(store, rule, id, now);
    const viaEdge = edge.cleanApps ? edge.cleanApps({ sv: [], cm: [], all: { 'a.service': 1, 'bad name!': 2 } }) : null;
    console.log(JSON.stringify({ cut: g.allCut ?? null, vals: pts.map((p) => p[1]), ev: AL.judge(pts, rule, null, now).event, edgeCut: viaEdge ? viaEdge.allCut === true : null }));`);
  // 30회차 E: .service 를 먼저 싣는다 — 살아 있는 oracle-db.service 는 목록에 들고(값 1), 잘린 것은 scope 뿐이라 'nonsvc'
  assert.equal(out.cut, 'nonsvc');
  assert.ok(out.vals.every((v) => v === 1), `수정 전: 0,0,…,0 → fire(살아 있는 서비스를 죽음으로) — ${out.vals}`);
  assert.notEqual(out.ev, 'fire');
  if (out.edgeCut !== null) assert.equal(out.edgeCut, true, '엣지 수신에서 거른 칸이 있어도 allCut');
});

test('F7 — 등록부 손상이면 조회 · 시험 · 수집 시작도 503(메인 GET 과 같은 문 — 없는 대상 404 가 아니다)', () => {
  const out = sub((d) => fs.writeFileSync(path.join(d, 'focusmon-targets.json'), '{"targets":[{"id":"fm-aaaaaaaaaa", BROKEN'), `${ROUTE_HEAD}
    const r = {};
    for (const [k, m, p, b] of [['main', 'GET', '/api/tools/focus-mon'], ['data', 'GET', '/api/tools/focus-mon/data?view=overview&targets=fm-aaaaaaaaaa'], ['sessions', 'POST', '/api/tools/focus-mon/sessions', { targets: ['fm-aaaaaaaaaa'], mode: 'watch' }], ['test', 'POST', '/api/tools/focus-mon/targets/fm-aaaaaaaaaa/test', {}], ['procs', 'GET', '/api/tools/focus-mon/procs?targets=fm-aaaaaaaaaa'], ['coverage', 'GET', '/api/tools/focus-mon/coverage?targets=fm-aaaaaaaaaa']]) { const x = await call(m, p, b); r[k] = x.status + ' ' + (x.body?.reason || ''); }
    done(r);`, { ...ROUTE_ENV, DATA_SOURCE: 'live' });
  for (const [k, v] of Object.entries(out)) assert.match(v, /^503 registryUnreadable/, `${k}: ${v}`);
  // 스윕: visibleById · visibleTargets · pickIds 를 쓰는 핸들러는 registryUnreadable 을 먼저 부른다
  const src = fs.readFileSync(path.join(SRC, 'routes/api/focusMon.js'), 'utf8');
  const blocks = src.split(/\n(?=api\.(?:get|post|put|delete)\()/).slice(1);
  let checked = 0;
  for (const b of blocks) {
    const head = b.split('\n')[0];
    if (!/visibleById|visibleTargets|pickIds/.test(b.split(/\n\}\);/)[0])) continue;
    assert.match(b, /registryUnreadable\(res\)|registry\.registryLoadError\(\)/, head); checked += 1;   // 30회차 B: 수집에서 빼기는 손상 중에도 연다(세션 소속으로 판단)
  }
  assert.ok(checked >= 15, `스윕한 핸들러 ${checked}`);   // 29회차 시점 19개
});

test('F8 — 집중 모니터링 화면의 내려받기 실패를 삼키지 않는다 · 보고서 원문은 data.csv 권한으로 잠근다', () => {
  for (const f of ['FocusMonTool.jsx', 'FocusMonAudit.jsx', 'FocusMonBulk.jsx']) {
    const s = fs.readFileSync(path.join(WEB, 'views/tools', f), 'utf8');
    assert.doesNotMatch(s, /downloadFile\([^)]*\)\.catch\(\(\) => \{\}\)/, f);
  }
  const audit = fs.readFileSync(path.join(WEB, 'views/tools/FocusMonAudit.jsx'), 'utf8');
  assert.match(audit, /\{canCsv\(\) \? <button type="button" className="fm-btn sm" onClick=\{\(\) => downloadFile\(`\/tools\/focus-mon\/audit\/run\//);
});

/* ── 30회차(28 · 29회차 수정 반증) ── */
test('30 B · C — 손상 중 서버별 수집 종료는 열려 있고 · 1분 알림 주기는 건너뛴다(발생 중 상태를 지우지 않게)', () => {
  const out = sub(none, `${ROUTE_HEAD}
    const { issueAgentToken } = await import(${J('central/agentTokens.js')}); issueAgentToken('edge-x');
    const ids = [0, 1].map((i) => registry.addTarget({ name: 'b-' + i, host: '10.66.0.' + (i + 1), port: 22, username: 'dvcmon', agent: 'edge-x' }, { agents: ['edge-x'] }).target.id);
    const s = await call('POST', '/api/tools/focus-mon/sessions', { targets: ids, mode: 'record', interval: 2 });
    const fs2 = await import('node:fs'); const p = await import('node:path');
    fs2.writeFileSync(p.join(process.env.CONFIG_DIR, 'focusmon-targets.json'), '{"targets":[{"id": BROKEN');
    registry._resetForTest();
    const stop = await call('DELETE', '/api/tools/focus-mon/sessions/' + s.body.session.id + '/targets/' + ids[0]);
    const tick = await svc.minuteTick(Date.now());
    done({ start: s.status, stop: stop.status, left: store.sessionOfTarget(ids[1])?.targets?.length ?? null, tick });`, ROUTE_ENV);
  assert.equal(out.start, 200);
  assert.equal(out.stop, 200, '수정 전(29회차 판): 503 — 수집 전체 종료는 200 인데 서버별만 막혔다');
  assert.equal(out.left, 1);
  assert.deepEqual(out.tick, { skipped: 'registry-unreadable' }, '수정 전: 빈 대상으로 알림 주기를 돌아 발생 중 상태를 지웠다');
});

test('30 D · E · F — limit 해제는 stopped · .service 를 먼저 실어 필수 앱 죽음은 fire · 비정상 sentAt 은 나이를 믿지 않는다', () => {
  const out = sub(none, `const { createRunner } = await import(${J('focusmon/runner.js')});
    const got = []; const runner = createRunner({ keys: null, sink: { sample() {}, procs() {}, load() {}, status: (id, st) => { got.push(id + ':' + st.state); } } });
    const w = [{ id: 'fm-d0000000', host: '192.0.2.1', port: 22, username: 'x', interval: 2, demo: true }, { id: 'fm-d0000001', host: '192.0.2.2', port: 22, username: 'x', interval: 2, demo: true }];
    runner.reconcile(w); runner.reconcile([w[0]]); runner.stopAll();
    const { appGroups } = await import(${J('focusmon/rates.js')}); const AL = await import(${J('focusmon/alerts.js')}); const store = await import(${J('focusmon/store.js')});
    const cur = []; const units = new Map();
    for (let i = 0; i < 410; i++) { const pid = 1000 + i; cur.push({ pid, ppid: 1, comm: 'c' + i, thr: 1, rss: 100, start: 10 }); units.set(pid, 'cri-containerd-' + String(i).padStart(12, '0') + '.scope'); }
    const g = appGroups(cur, [], { tck: 100, dt: 5, units, withAll: true });   // oracle-db.service 는 죽었다(목록에 없음)
    const id = 'fm-cccccccccc'; const now = Date.now();
    for (let t = now - 90_000; t <= now; t += 15_000) store.ingestProcs(id, t, { n: cur.length, top: [], apps: g });
    const rule = { id: 'ar-000000000002', metric: 'app', app: 'oracle-db.service', threshold: 1, durMin: 1, op: 'lt' };
    const ev = AL.judge(AL.pointsFor(store, rule, id, now), rule, null, now).event;
    const registry = await import(${J('focusmon/registry.js')}); const edge = await import(${J('central/focusMonEdge.js')});
    const tid = registry.addTarget({ name: 'f-1', host: '10.9.0.21', port: 22, username: 'u', agent: 'edge-f' }, { agents: ['edge-f'] }).target.id;
    store.startSession({ targets: [tid], interval: 2, mode: 'watch', by: 't' });
    edge.handleEdgeSync('edge-f', { sentAt: 0, status: { [tid]: { state: 'ok', lastSampleAt: now - 3_600_000, interval: 2 } } }, now);
    console.log(JSON.stringify({ got, cut: g.allCut, ev, age: now - store.statusOf(tid).lastSampleAt }));`, { FOCUSMON_MAX_STREAMS: '1' });
  assert.ok(out.got.includes('fm-d0000001:stopped'), `수정 전: limit 이 남음 — ${out.got}`);
  assert.equal(out.cut, 'nonsvc', '.service 가 아닌 단위만 잘렸다');
  assert.equal(out.ev, 'fire', '수정 전(29회차 판): 영원히 hold — 필수 앱이 죽어도 알리지 않았다');
  assert.equal(out.age, 3_600_000, '수정 전: sentAt 0 이면 1시간 전 상태가 방금(나이 0)');
});

test('30 A · G — 파일을 못 읽음 503 은 서버 사유로 보인다(웹) · 느린 DNS 는 사유를 말한다(소스)', () => {
  const api = fs.readFileSync(path.join(WEB, 'api.js'), 'utf8');
  assert.match(api, /const msg = \(unreadable \? data\.detail : ''\) \|\| data\?\.reason/);
  const sd = fs.readFileSync(path.join(WEB, 'components/serviceDownText.js'), 'utf8');
  assert.match(sd, /if \(status === 503 && b && typeof b === 'object' && \[b\.reason, b\.code\]\.some/);
  const ck = fs.readFileSync(path.join(SRC, 'svcmon/checker.js'), 'utf8');
  assert.match(ck, /sock\.once\('timeout', \(\) => done\(resolved \? false : \{ why: '이름 해석 시간 초과' \}\)\);/);
});
