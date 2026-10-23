/**
 * v2.766 점검 R1 — 수정 그룹 G1(Veeam) 회귀.
 *  A1-1 · 전용 수집기 seen 이 vCenter 단위라 userList 의 공용 계정(administrator) 이벤트만 읽혀도 okAt 이 섰다 → 이름 규칙('veeam')으로만 잡히는
 *         실제 Veeam 계정을 이 수집기가 안 읽는데 로그 폴러 13일 지연 vCenter 의 판정이 ok 로 뒤집혔다(scratchpad a1/repro_seen.mjs).
 *         ② seen 은 공용 계정이 아닌 계정 일치만 · ③ 요약이 Veeam 으로 본 계정이 userList 로 다 덮일 때만 결합.
 *  A5-1 · 계정 목록이 바뀌어도 커서가 안 되돌아가 새 계정의 지난 7일을 영영 안 읽는데 okAt 은 최신(a5/cursor.mjs) — ① 지문(fp:<vc>)이 바뀌면
 *         커서·okAt·seen 을 지우고 새 지문으로 끝까지 읽은 회차 뒤에만 okAt. userList 상한 50 을 넘겨 원문 계정이 빠지면 okAt 을 쓰지 않는다.
 *  A5-2 · 엣지 cleanAccountList 가 중앙 vcAccounts(최대 64)를 32 로 조용히 잘랐다(a5/acc.mjs) — 받은 목록 상한 MAX_PULLED + 버린 수 보고(실제 pull).
 *  A4-1 · /veeam/vm-detail 의 jobs[].running 이 실패·오래된 결과에서도 true(a4/repro1.mjs) — withoutStaleRunning 이 작업 '실행 중'·상태 문자열도 지운다.
 *  A4-2 · /veeam/badges 의 unmatched(서버 전체 기준)가 범위 계정에 다른 법인 항목 수를 흘렸다 — 관리자만 수.
 *  A4-3 · vm-detail lastTask.message 원문(주소 꼴)이 비관리자에게 — 주소 꼴이면 일반 문구.
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2766a-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'live';
delete process.env.DB_DIR;
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
const SRC = new URL('../src/', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, SRC), 'utf8');

const C = await import('../src/veeam/snapCollector.js');
const D = await import('../src/veeam/snapDb.js');
const S = await import('../src/veeam/snapEvents.js');
const B = await import('../src/veeam/backupCounts.js');
const { saveLogSettings } = await import('../src/logs/settings.js');

/** 가짜 vCenter — CreateCollectorForEvents 의 beginTime·userList 를 지킨다(veeam2764.test.js 와 같은 방식). */
function fakeVcenter() {
  const state = { events: [], view: [], served: 0, creates: [] };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const op = (/<(\w+) xmlns="urn:vim25"/.exec(b) || [])[1] || '?';
      const send = (x) => { res.setHeader('Content-Type', 'text/xml'); res.end(`<soapenv:Envelope><soapenv:Body>${x}</soapenv:Body></soapenv:Envelope>`); };
      if (op === 'RetrieveServiceContent') return send('<RetrieveServiceContentResponse><returnval><propertyCollector>pc</propertyCollector><rootFolder>rf</rootFolder><viewManager>vm</viewManager><sessionManager>sm</sessionManager><eventManager>em</eventManager><about><version>8.0</version></about></returnval></RetrieveServiceContentResponse>');
      if (op === 'Login') { res.setHeader('Set-Cookie', 'vmware_soap_session=x'); return send('<LoginResponse><returnval><key>s</key></returnval></LoginResponse>'); }
      if (op === 'CreateCollectorForEvents') {
        state.creates.push(b);
        const begin = Date.parse((/<beginTime>([^<]+)<\/beginTime>/.exec(b) || [])[1] || '') || 0;
        const users = [...b.matchAll(/<userList>([^<]*)<\/userList>/g)].map((m) => m[1]);
        state.view = state.events.filter((e) => e.ts >= begin && (!users.length || users.includes(e.user))).sort((x, y) => x.ts - y.ts);
        state.served = 0;
        return send('<CreateCollectorForEventsResponse><returnval type="EventHistoryCollector">col</returnval></CreateCollectorForEventsResponse>');
      }
      if (op === 'ReadNextEvents') {
        const n = Number((/<maxCount>(\d+)<\/maxCount>/.exec(b) || [])[1] || 0);
        const page = state.view.slice(state.served, state.served + n);
        state.served += page.length;
        return send(`<ReadNextEventsResponse>${page.map((e) => `<returnval xsi:type="TaskEvent"><key>${e.key}</key><createdTime>${new Date(e.ts).toISOString()}</createdTime><userName>${e.user}</userName><vm><name>${e.vm}</name></vm><fullFormattedMessage>${e.msg}</fullFormattedMessage></returnval>`).join('')}</ReadNextEventsResponse>`);
      }
      return send('<Response></Response>');
    });
  });
  return { srv, state };
}
const SNAP = 'Task: Create virtual machine snapshot';
const ev = (key, ts, user, vm, msg = SNAP) => ({ key: String(key), ts, user, vm, msg });
const quiet = () => [mock.method(console, 'warn', () => {}), mock.method(console, 'log', () => {})];
const unquiet = (ms) => { for (const m of ms) m.mock.restore(); };
const writeVc = (srv, list) => fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: list.map((v) => ({ host: `http://127.0.0.1:${srv.address().port}`, username: 'u', password: 'p', timeoutMs: 5000, ...v })) }));
async function withVc(fn) {
  const q = quiet();
  const { srv, state } = fakeVcenter();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { saveLogSettings({ enabled: true, maxPerPoll: 100, minSeverity: 'info', pollIntervalMin: 10 }); S._resetForTest(); C._resetForTest(); await fn(srv, state); }
  finally { unquiet(q); await new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); }); }
}

test('A1-1 ② — userList 의 공용 계정(administrator) 이벤트만 읽혔으면 seen·okAt 이 서지 않는다 → 로그 폴러 13일 지연 vCenter 판정은 stale-events 그대로', async () => {
  await withVc(async (srv, state) => {
    writeVc(srv, [{ id: 'oc2', name: 'OC2' }]);
    S.saveManualAccounts(['administrator@vsphere.local']);
    state.events = [
      ...Array.from({ length: 5 }, (_, i) => ev(`v${i}`, NOW - (i + 1) * HOUR, 'CORP\\svc-veeam', `vm${i}`)),
      ev('a1', NOW - 2 * HOUR, 'administrator@vsphere.local', 'ops01', 'Task: Reconfigure virtual machine'),
    ];
    assert.equal(S.makeVeeamAccountMatcher(S.veeamAccounts(NOW))('CORP\\svc-veeam'), 'name', '전제: 판정은 이름 규칙으로 svc-veeam 을 Veeam 으로 센다');
    const r = await C.pollVeeamSnapOnce({ now: NOW });
    assert.equal(r.ok, 1, JSON.stringify(r));
    assert.equal(r.read, 1, '공용 계정 이벤트 1건만 읽힌다(svc-veeam 은 userList 에 없다)');
    assert.equal(C.snapCollectorSeen('oc2'), false, '공용 계정만 맞은 것은 seen 이 아니다');
    assert.equal(C.snapCollectorOkAt('oc2'), null);
    const db = await D.getSnapDb();
    assert.equal(db.snapOkAt('oc2'), null, '영속도 하지 않는다');
    assert.equal(C.veeamSnapCollectorStatus().perVc.oc2.reason, 'unseen');
    const logOkAt = NOW - 13 * DAY;
    const combined = C.combineOkAt(logOkAt, C.snapCollectorOkAt('oc2'));
    assert.equal(combined, logOkAt, '결합은 로그 폴러 값으로 폴백');
    assert.deepEqual(B.snapVerdict({ status: 'ok', collectedAt: combined, staleMs: 6 * HOUR, accounts: 1, events: 3, unpaired: 0, byVm: { 'oc2:vm-1': [NOW - 14 * DAY, 1] }, at: NOW }, NOW), { ok: false, reason: 'stale-events' });
  });
});

test('A1-1 ③ — 요약이 Veeam 으로 본 계정(이름 규칙 svc-veeam)을 전용 수집기가 덮지 않으면 snapEventsOkAt 에 그 시각을 섞지 않는다(실제 localSnapSummary 경로)', async () => {
  await withVc(async (srv, state) => {
    writeVc(srv, [{ id: 'oc9', name: 'OC9' }]);
    S.saveManualAccounts(['CORP\\svc-bk']);
    state.events = [ev('b1', NOW - HOUR, 'CORP\\svc-bk', 'web01'), ev('v1', NOW - 2 * HOUR, 'CORP\\svc-veeam', 'db01'), ev('v2', NOW - 3 * HOUR, 'CORP\\svc-veeam', 'db02')];
    const r = await C.pollVeeamSnapOnce({ now: NOW });
    assert.equal(r.read, 1, JSON.stringify(r));
    assert.equal(C.snapCollectorOkAt('oc9'), NOW, '전제: svc-bk(공용 아님)로 seen → 완결 okAt');
    const db = await D.getSnapDb();
    const vms = [{ id: 'oc9:vm-1', name: 'web01' }, { id: 'oc9:vm-2', name: 'db01' }, { id: 'oc9:vm-3', name: 'db02' }];
    db.setCoveredFrom('oc9', NOW - 9 * DAY, NOW);
    // 덮는 경우 — 전용 DB 의 행이 svc-bk 뿐: 요약 계정 ⊆ userList → 수집기 시각을 섞는다
    // v2.767(점검 R2-B1-1): 단 이것은 svc-veeam 을 **한 번도 본 적 없을 때** 뿐이다(알 수 없는 계정 — 남은 한계). 아래 s2 에서 본 뒤에는 같은 s1 도 섞지 않는다.
    const s1 = await S.localSnapSummary(null, 'oc9', vms, { now: NOW, snapDb: db });
    assert.deepEqual(s1.veeamUsers, ['svc-bk@corp']);
    assert.equal(C.snapEventsOkAt('oc9', { dedicated: true, summary: s1 }), NOW);
    // 로그 폴러가 svc-veeam 행(이름 규칙)을 넣었다 — 이 수집기는 그 계정을 읽지 않는다 → 섞지 않는다(로그 폴러 값 = 여기선 기록 없음 null)
    await D.ingestSnapRows([
      { vcenterId: 'oc9', ts: NOW - 2 * HOUR, severity: 'info', type: 'TaskEvent', user: 'CORP\\svc-veeam', entity: 'db01', message: SNAP },
      { vcenterId: 'oc9', ts: NOW - 3 * HOUR, severity: 'info', type: 'TaskEvent', user: 'CORP\\svc-veeam', entity: 'db02', message: SNAP },
    ]);
    db.setCoveredFrom('oc9', NOW - 9 * DAY, Date.now());
    const s2 = await S.localSnapSummary(null, 'oc9', vms, { now: NOW, snapDb: db });
    assert.deepEqual(s2.veeamUsers, ['svc-bk@corp', 'svc-veeam@corp']);
    assert.equal(C.snapEventsOkAt('oc9', { dedicated: true, summary: s2 }), null, '판정 계정 ⊄ 덮은 계정 → 수집기 시각을 섞지 않는다');
    // v2.767(점검 R2-B1-1): s1 단언 갱신 — 본 적 있는 svc-veeam 은 기억된다(snap_meta 'vu:<vc>'). 로그 폴러가 밀려 7일 창에 svc-bk 만 남은 요약(s1 모양)도 섞지 않는다.
    assert.equal(C.snapEventsOkAt('oc9', { dedicated: true, summary: s1 }), null, '1회차 판본은 여기서 NOW(섞음) — 2회차 B1-1');
    assert.equal(C.snapEventsOkAt('oc9', { dedicated: true, summary: { veeamUsers: [], veeamUsersOverflow: true } }), null, '다 세지 못한 요약은 모름');
    // 엣지 push 경로(edgeSnapPayload)도 요약을 넘긴다 — 필드는 그대로
    const out = await S.edgeSnapPayload({ db: null, snap: { vcenters: [{ id: 'oc9' }], vms: vms.map((v) => ({ ...v, vcenterId: 'oc9' })) }, notCollected: new Map(), logSettings: { enabled: true, minSeverity: 'info' }, now: NOW, snapDb: db,
      collectedAtFor: (vc, sum) => C.snapEventsOkAt(vc, { dedicated: true, summary: sum }) });
    assert.equal(out.length, 1);
    assert.equal(out[0].collectedAt, null);
    assert.ok(!('veeamUsers' in out[0]), 'push 에 계정 이름을 싣지 않는다(필드 그대로)');
    assert.match(read('routes/api/veeam.js'), /collectedAt: snapEventsOkAt\(vcenterId, \{ dedicated: viaSnapDb, summary: r \}\)/);
  });
});

test('A5-1 ① — 계정 목록이 바뀌면 커서를 되돌려 새 계정의 지난 이벤트를 읽는다 · 바뀐 직후(수집 전)는 okAt 폴백 · 지문은 재시작에도 이어진다', async () => {
  await withVc(async (srv, state) => {
    writeVc(srv, [{ id: 'oc2b', name: 'OC2B' }]);
    S.saveManualAccounts(['CORP\\svc-veeam-a']);
    state.events = [
      ev('1', NOW - 1 * HOUR, 'CORP\\svc-veeam-a', 'web01'),
      ev('2', NOW - 72 * HOUR, 'CORP\\svc-bk2', 'db01'), ev('3', NOW - 48 * HOUR, 'CORP\\svc-bk2', 'db02'), ev('4', NOW - 24 * HOUR, 'CORP\\svc-bk2', 'db03'),
    ];
    await C.pollVeeamSnapOnce({ now: NOW });
    const db = await D.getSnapDb();
    assert.equal(C.snapCollectorOkAt('oc2b'), NOW);
    assert.equal(db.snapCursor('oc2b'), NOW - HOUR);
    const fp1 = db.snapFp('oc2b');
    assert.ok(fp1, '지문 영속');
    // 관리자가 계정 B 를 추가(또는 중앙 pull) — 수집기가 돌기 전에도 옛 okAt 을 쓰지 않는다
    S.saveManualAccounts(['CORP\\svc-veeam-a', 'CORP\\svc-bk2']);
    assert.equal(C.snapCollectorOkAt('oc2b'), null, '목록이 바뀌었는데 아직 다시 읽지 않았다 — 폴백');
    state.creates = [];
    await C.pollVeeamSnapOnce({ now: NOW + 10 * 60_000 });
    const begin = Date.parse(/<beginTime>([^<]+)<\/beginTime>/.exec(state.creates[0])[1]);
    assert.equal(begin, NOW + 10 * 60_000 - C.LOOKBACK_MS, '커서를 now − LOOKBACK 로 되돌렸다');
    assert.deepEqual(db.rowsFor('oc2b', 0, 100).map((r) => r.user).filter((u) => u === 'CORP\\svc-bk2').length, 3, '새 계정의 지난 3건을 읽었다');
    assert.equal(C.snapCollectorOkAt('oc2b'), NOW + 10 * 60_000, '새 지문으로 끝까지 읽은 뒤 okAt');
    assert.notEqual(db.snapFp('oc2b'), fp1);
    assert.equal(C.veeamSnapCollectorStatus().perVc.oc2b.listChanged, true);
    // 재시작(메모리 초기화) — 지문이 같으니 커서를 되돌리지 않고 이어 읽는다
    C._resetForTest();
    state.creates = [];
    await C.pollVeeamSnapOnce({ now: NOW + 20 * 60_000 });
    const begin2 = Date.parse(/<beginTime>([^<]+)<\/beginTime>/.exec(state.creates[0])[1]);
    assert.equal(begin2, NOW - HOUR, '커서(마지막 이벤트 시각)부터 이어 읽는다');
    assert.equal(C.snapCollectorOkAt('oc2b'), NOW + 20 * 60_000);
    assert.equal(C.veeamSnapCollectorStatus().perVc.oc2b.listChanged, false);
  });
});

test('A5-1 ① — 바뀐 목록의 첫 회차가 예산·상한에 걸려 끝까지 못 읽었으면 okAt 을 세우지 않는다(다음 회차가 완결하면 그때)', async () => {
  await withVc(async (srv, state) => {
    writeVc(srv, [{ id: 'oc2c', name: 'OC2C' }]);
    S.saveManualAccounts(['CORP\\svc-veeam-a']);
    state.events = Array.from({ length: 25 }, (_, i) => ev(i, NOW - 100 * HOUR + i * HOUR, 'CORP\\svc-veeam-a', `vm${i % 5}`));
    const r = await C.pollVeeamSnapOnce({ now: NOW, perCallMax: 10, budgetMs: 0 });
    assert.equal(r.ok, 1, JSON.stringify(r));
    assert.equal(C.snapCollectorOkAt('oc2c'), null, '첫 완결 전');
    assert.equal(C.veeamSnapCollectorStatus().perVc.oc2c.reason, 'refilling');
    await C.pollVeeamSnapOnce({ now: NOW + 60_000, perCallMax: 100 });
    assert.equal(C.snapCollectorOkAt('oc2c'), NOW + 60_000, '이어 읽어 끝까지 — 그때 okAt');
    assert.equal((await D.getSnapDb()).rowsFor('oc2c', 0, 100).length, 25);
  });
});

test('A5-1 — 원문 계정이 userList 상한(50)을 넘어 빠지면 okAt 을 기록·사용하지 않는다(그 계정은 이 수집기가 읽지 않는다)', async () => {
  const many = Array.from({ length: 55 }, (_, i) => `CORP\\svc-${i}`);
  const cov = C.userListCoverage(many);
  assert.equal(cov.userNames.length, 50);
  assert.equal(cov.full, false);
  assert.equal(cov.missing, 5);
  const few = C.userListCoverage(['CORP\\svc-veeam', 'svc-x']);
  assert.equal(few.full, true);
  assert.equal(C.userListCoverage(['svc-x', 'CORP\\svc-veeam']).fp, few.fp, '순서만 다른 목록은 같은 지문');
  assert.notEqual(C.userListCoverage(['CORP\\svc-veeam']).fp, few.fp);
  await withVc(async (srv, state) => {
    writeVc(srv, [{ id: 'oc2d', name: 'OC2D' }]);
    S.saveManualAccounts(many.slice(0, 32));
    for (let k = 0; k < 25; k++) S.rememberLearned([{ account: `CORP\\learn${k}`, vm: 'a' }, { account: `CORP\\learn${k}`, vm: 'b' }], Date.now());
    assert.ok(S.veeamAccounts().length > 50, '전제: 원문 계정 57개');
    state.events = [ev(1, NOW - HOUR, 'CORP\\svc-0', 'web01')];
    const r = await C.pollVeeamSnapOnce({ now: NOW });
    assert.equal(r.read, 1, JSON.stringify(r));
    assert.equal(C.snapCollectorOkAt('oc2d'), null);
    assert.equal((await D.getSnapDb()).snapOkAt('oc2d'), null);
    const per = C.veeamSnapCollectorStatus().perVc.oc2d;
    assert.equal(per.reason, 'accounts-over-limit');
    assert.ok(per.accountsMissing > 0);
  });
});

test('A5-2 — 중앙 vcAccounts(사람 30 + 학습 5)를 엣지가 32 로 자르지 않는다 · 실제 pull 이 받은 목록을 다 쓰고, 상한을 넘으면 버린 수를 상태에 밝힌다', async () => {
  S._resetForTest();
  fs.rmSync(path.join(TMP, 'veeam-vc-accounts.json'), { force: true }); S._resetForTest();
  S.saveManualAccounts(Array.from({ length: 30 }, (_, i) => `CORP\\svc-a${i}`));
  for (let k = 0; k < 5; k++) S.rememberLearned([{ account: `CORP\\learned${k}`, vm: 'vm1' }, { account: `CORP\\learned${k}`, vm: 'vm2' }], Date.now());
  const sent = S.veeamAccounts();
  assert.equal(sent.length, 35);
  const r = S.cleanAccountList(sent, S.MAX_PULLED);
  assert.equal(r.dropped, 0);
  assert.equal(S.cleanAccountList(sent).list.length, 32, '사람이 적는 목록의 상한은 그대로 32');
  // 엣지 쪽 — 실제 pullVeeamConfigNow 가 가짜 중앙에서 받는다
  fs.rmSync(path.join(TMP, 'veeam-vc-accounts.json'), { force: true }); S._resetForTest();
  const { config } = await import('../src/config.js');
  const keep = { ...config.agent };
  let body = { ok: true, servers: [], vcAccounts: sent };
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); req.resume(); req.on('end', () => res.end(JSON.stringify(body))); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const q = quiet();
  try {
    const pull = await import('../src/agent/veeamConfigPull.js');
    pull._resetForTest();
    config.agent.centralUrl = `http://127.0.0.1:${srv.address().port}`; config.agent.centralToken = 'tok-2766a'; config.agent.name = 'edge-2766a';
    const pr = await pull.pullVeeamConfigNow();
    assert.equal(pr.ok, true, pr.reason);
    assert.deepEqual(S.accountView().pulled, sent, '35개 전부(학습 계정 포함)');
    assert.equal(pull.veeamConfigPullStatus().accounts, 'changed');
    assert.equal(pull.veeamConfigPullStatus().accountsDropped, undefined);
    // 상한(MAX_PULLED)을 넘는 목록 — 조용히 자르지 않고 버린 수를 밝힌다
    body = { ok: true, servers: [], vcAccounts: Array.from({ length: S.MAX_PULLED + 4 }, (_, i) => `CORP\\x${i}`) };
    await pull.pullVeeamConfigNow();
    assert.equal(S.accountView().pulled.length, S.MAX_PULLED);
    assert.equal(pull.veeamConfigPullStatus().accountsDropped, 4);
    // 재시작(파일에서 다시 읽기)에도 잘리지 않는다
    S._resetForTest();
    assert.equal(S.accountView().pulled.length, S.MAX_PULLED);
  } finally {
    unquiet(q);
    Object.assign(config.agent, keep);
    await new Promise((ok) => { srv.closeAllConnections?.(); srv.close(() => ok()); });
    fs.rmSync(path.join(TMP, 'veeam-vc-accounts.json'), { force: true }); S._resetForTest();
  }
});

test('A4-1·A4-2·A4-3 — 범위 계정: vm-detail jobs[].running 은 실패·오래된 결과에서 false(상태 Running 도 비움) · badges.unmatched 는 null · lastTask 주소 원문 가림 / 관리자는 수·원문', async () => {
  const R = await import('../src/veeam/registry.js');
  const VS = await import('../src/veeam/store.js');
  const P = await import('../src/veeam/parse.js');
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerVeeamBadges } = await import('../src/routes/api/veeam.js');
  const VC1 = 'pl:vc01'; const VC2 = 'kr:vc02';
  fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: [VC1, VC2].map((id) => ({ id, name: id, host: `${id.split(':')[1]}.corp.local`, username: 'u', password: 'p' })) }));
  const now = Date.now();
  const a = R.saveServer({ name: 'VBR-SHARED', host: 'vbr.corp.local', username: 'svc', password: 'pw-1', vcenterIds: [VC1, VC2] });
  const msg = 'Error: Failed to connect to proxy 10.20.30.40:2500';
  const vms = [{ n: 'web-01', m: 'vm-1', h: 'vc01.corp.local', j: [0], rp: 3, lt: { r: 'Failed', m: msg, s: now - 3 * DAY - HOUR, e: now - 3 * DAY, j: 0 } }];
  for (let i = 0; i < 7; i++) vms.push({ n: `kr-phys-${i}`, m: '', h: '', j: [0], rp: 2, ag: 1 });
  VS.putResult(a.id, { ok: true, ts: now - 3 * DAY, jobs: [{ id: 'j1', name: 'Daily', status: 'Running', lastResult: 'Success', running: true, lastRun: now - 3 * DAY }], counts: {}, notes: [], vms });
  VS.putResult(a.id, { ok: false, ts: now, error: 'HTTP 401', kind: 'auth' });
  const keepSnap = store.snapshot;
  store.snapshot = { source: 'live', generatedAt: now, vcenters: [VC1, VC2].map((id) => ({ id, name: id })), vms: [{ id: `${VC1}:vm-1`, vcenterId: VC1, name: 'web-01' }, { id: `${VC2}:vm-9`, vcenterId: VC2, name: 'kr-x' }], hosts: [] };
  const app = express();
  let user = { username: 'pl-viewer', role: 'viewer', scope: { vcenters: [VC1] } };
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerVeeamBadges(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const get = async (p) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}/api${p}`); return { status: r.status, body: await r.json() }; };
  try {
    const b = await get(`/veeam/badges?vcenterId=${encodeURIComponent(VC1)}`);
    assert.equal(b.status, 200);
    assert.equal(b.body.unmatched, null, 'A4-2: 서버 전체 기준 수는 범위 계정에 싣지 않는다');
    assert.equal(b.body.otherVcenter, null);
    const d = await get(`/veeam/vm-detail?vcenterId=${encodeURIComponent(VC1)}&vmId=${encodeURIComponent(`${VC1}:vm-1`)}`);
    assert.equal(d.status, 200);
    assert.equal(d.body.detail.running, null);
    assert.deepEqual(d.body.detail.jobs.map((j) => [j.name, j.running, j.status]), [['Daily', false, '']], 'A4-1: 실패·오래된 결과의 작업 실행 중·Running 상태를 지운다');
    assert.ok(!JSON.stringify(d.body).includes('10.20.30.40'), 'A4-3: 주소 원문 없음');
    assert.match(d.body.detail.lastTask.message, /관리자 화면에서만/);
    user = { username: 'admin', role: 'admin' };
    const ba = await get(`/veeam/badges?vcenterId=${encodeURIComponent(VC1)}`);
    assert.equal(ba.body.unmatched, 7, '관리자는 수');
    const da = await get(`/veeam/vm-detail?vcenterId=${encodeURIComponent(VC1)}&vmId=${encodeURIComponent(`${VC1}:vm-1`)}`);
    assert.equal(da.body.detail.lastTask.message, msg, '관리자는 원문');
    assert.equal(da.body.detail.jobs[0].running, false, '관리자도 실패 결과의 실행 중은 사실이 아니다');
  } finally {
    srv.close();
    store.snapshot = keepSnap;
    R.deleteServer(a.id);
  }
  // 순수 — 신선한 결과는 그대로 · 오래된 결과는 작업 실행 중·상태를 지우고 다른 필드는 그대로
  const fresh = { ok: true, ts: now, jobs: [{ name: 'J', status: 'Working', running: true, lastResult: 'Success' }], vms: [] };
  assert.equal(P.withoutStaleRunning(fresh, { now, maxAgeMs: 60_000 }), fresh);
  const st = P.withoutStaleRunning(fresh, { failed: true, now });
  assert.deepEqual(st.jobs, [{ name: 'J', status: '', running: false, lastResult: 'Success' }]);
  assert.deepEqual(fresh.jobs[0].running, true, '원본은 바꾸지 않는다');
  const idle = P.withoutStaleRunning({ ok: true, ts: 1, jobs: [{ name: 'K', status: 'Stopped', running: false }], vms: [] }, { now });
  assert.deepEqual(idle.jobs, [{ name: 'K', status: 'Stopped', running: false }]);
});
