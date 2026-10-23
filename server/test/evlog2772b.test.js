/**
 * v2.772 이벤트 수집 후속 점검(bughunt4) — 수정 그룹 G2(Veeam 전용 수집기 · Z3).
 *  Z3-1 · 목록의 원문 계정이 전부 공용 계정(administrator 등)이면 사유가 'unseen'(표기 불일치 의심)으로 틀리게 남았다 → 'shared-only'.
 *         seen·okAt·결합은 그대로(v2.766 R1-A1-1 ②) — 반증 시나리오(사람이 administrator 로 만든 스냅샷이 전용 DB 에 들어가 vu 가 공용 계정만 됨)에서도
 *         결합이 열리지 않는다. 로그 폴러가 이름 규칙 계정(svc-veeam) 행을 넣으면 사유는 'not-covered'.
 *  Z3-2 · 상태 setPer 가 병합이라 stalled·accountsMissing·이전 run 값(read·stored·cursor)이 남았다 → 교체 + 실패 갈래 null + stalled 늘 싣기.
 *  Z3 I1 · 전용 수집기가 그 vCenter 를 구제하지 못한 사유 코드(snapCollectorReason)를 snap-events·backup-counts(local)에 코드만 싣는다 ·
 *          상태 함수가 실패·unseen·shared-only 수와 warn 을 낸다.
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'evlog2772b-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'live';
delete process.env.DB_DIR;
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

const C = await import('../src/veeam/snapCollector.js');
const D = await import('../src/veeam/snapDb.js');
const S = await import('../src/veeam/snapEvents.js');
const P = await import('../src/logs/poller.js');
const { saveLogSettings } = await import('../src/logs/settings.js');

/** 가짜 vCenter — CreateCollectorForEvents 의 beginTime·userList 를 지킨다(audit2766a 와 같은 방식). */
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
const writeVc = (port, list) => fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: list.map((v) => ({ host: `http://127.0.0.1:${port}`, username: 'u', password: 'p', timeoutMs: 5000, ...v })) }));
async function withVc(fn) {
  const q = quiet();
  const { srv, state } = fakeVcenter();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { saveLogSettings({ enabled: true, maxPerPoll: 100, minSeverity: 'info', pollIntervalMin: 10 }); S._resetForTest(); C._resetForTest(); await fn(srv, state); }
  finally { unquiet(q); await new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); }); }
}
/** 로그 폴러가 9일 뒤처진 vCenter(실제 커서 파일 → loadCursorFile — Z3 재현과 같은 방식). */
function logLag9d(ids) {
  const vcenters = {};
  for (const id of ids) vcenters[id] = { readTs: NOW - 9 * DAY, okAt: NOW - 9 * DAY, capped: true, events: 936000, ended: 'budget', consecutiveCapped: 40 };
  fs.writeFileSync(path.join(TMP, 'vcenter-logs-cursor.json'), JSON.stringify({ savedAt: NOW, vcenters }));
  P.loadCursorFile({ force: true, now: NOW });
}
/** 닫힌 포트(연결 거부) — 실패 갈래. */
async function closedPort() {
  const s = http.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port; await new Promise((r) => s.close(r));
  return port;
}

test('Z3-1 — 목록이 공용 계정뿐이면 사유 shared-only · seen·okAt·결합은 그대로(반증: 사람이 administrator 로 만든 스냅샷으로 vu 가 공용 계정만 되어도 결합이 열리지 않는다)', async () => {
  await withVc(async (srv, state) => {
    const id = 'oc2s';
    writeVc(srv.address().port, [{ id, name: 'OC2S' }]);
    logLag9d([id]);
    S.saveManualAccounts(['administrator@vsphere.local']);
    // 사람이 administrator 로 만든 스냅샷(생성만 — 지우지 않음) + 실제 Veeam 은 이름 규칙 계정(svc-veeam, userList 밖)
    state.events = [
      ev('h1', NOW - 3 * HOUR, 'administrator@vsphere.local', 'ops01'),
      ev('h2', NOW - 2 * HOUR, 'administrator@vsphere.local', 'ops02'),
      ...Array.from({ length: 4 }, (_, i) => ev(`v${i}`, NOW - (i + 1) * HOUR + 1000, 'CORP\\svc-veeam', `vm${i}`)),
    ];
    const r = await C.pollVeeamSnapOnce({ now: NOW });
    assert.equal(r.ok, 1, JSON.stringify(r));
    assert.equal(r.read, 2, '공용 계정 이벤트만 읽힌다(svc-veeam 은 userList 에 없다)');
    assert.equal(r.stored, 2, '스냅샷 행은 전용 DB 에 들어간다(반증의 전제)');
    const db = await D.getSnapDb();
    assert.ok((D.seenVeeamUsers(id) || []).includes('administrator@vsphere.local'), `전제: vu 가 공용 계정만 — ${JSON.stringify(D.seenVeeamUsers(id))}`);
    // ② 그대로 — seen·okAt 이 서지 않는다
    assert.equal(C.snapCollectorSeen(id), false);
    assert.equal(C.snapCollectorOkAt(id), null);
    assert.equal(db.snapOkAt(id), null);
    const per = C.veeamSnapCollectorStatus().perVc[id];
    assert.equal(per.reason, 'shared-only', '진단 사유 — 표기 불일치(unseen)가 아니다');
    assert.equal(per.seen, false);
    assert.equal(C.veeamSnapCollectorStatus().issues.sharedOnly, 1);
    assert.equal(C.veeamSnapCollectorStatus().warn, true, '공용 계정뿐이라 구제하지 못하는 vCenter 도 warn');
    // 결합: 로그 폴러 값(9일 전)으로 폴백 — 전용 수집기의 시각을 섞지 않는다
    db.setCoveredFrom(id, NOW - 31 * DAY, NOW);
    const vms = ['ops01', 'ops02', 'vm0', 'vm1', 'vm2', 'vm3'].map((n) => ({ id: `${id}:vm-${n}`, name: n, vcenterId: id }));
    const s1 = await S.localSnapSummary(null, id, vms, { now: NOW, snapDb: db });
    assert.equal(C.snapEventsOkAt(id, { dedicated: true, summary: s1 }), NOW - 9 * DAY, '공용 계정뿐인 vu 로 결합이 열리지 않는다');
    assert.equal(C.snapCollectorReason(id, { dedicated: true, summary: s1 }), 'shared-only');
    // 로그 폴러가 따라잡으며 svc-veeam(이름 규칙) 행을 넣었다 → vu 에 svc-veeam → 사유는 not-covered(덮음이 먼저), 결합은 여전히 닫힘
    const n = await D.ingestSnapRows(state.events.filter((e) => e.user === 'CORP\\svc-veeam').map((e) => ({ vcenterId: id, ts: e.ts, severity: 'info', type: 'TaskEvent', user: e.user, entity: e.vm, message: e.msg })));
    assert.equal(n, 4);
    const s2 = await S.localSnapSummary(null, id, vms, { now: NOW, snapDb: db });
    assert.equal(C.snapEventsOkAt(id, { dedicated: true, summary: s2 }), NOW - 9 * DAY);
    assert.equal(C.snapCollectorReason(id, { dedicated: true, summary: s2 }), 'not-covered');
    assert.equal(C.snapCollectorReason(id, { dedicated: false, summary: s2 }), null, '요약이 전용 DB 를 읽지 않았으면 사유를 싣지 않는다');
  });
});

test('Z3-1 — 공용 계정이 아닌 계정이 하나라도 있으면 사유는 예전대로 unseen(표기 불일치 의심)', async () => {
  await withVc(async (srv, state) => {
    const id = 'oc2m';
    writeVc(srv.address().port, [{ id, name: 'OC2M' }]);
    S.saveManualAccounts(['administrator@vsphere.local', 'svc-bk']);
    state.events = [ev('h1', NOW - 2 * HOUR, 'administrator@vsphere.local', 'ops01')];
    await C.pollVeeamSnapOnce({ now: NOW });
    assert.equal(C.snapCollectorSeen(id), false);
    assert.equal(C.veeamSnapCollectorStatus().perVc[id].reason, 'unseen');
    assert.equal(C.userListCoverage(['administrator@vsphere.local', 'svc-bk']).sharedOnly, false);
    assert.equal(C.userListCoverage(['administrator@vsphere.local', 'VSPHERE.LOCAL\\Administrator']).sharedOnly, true);
    assert.equal(C.userListCoverage([]).sharedOnly, false, '빈 목록은 shared-only 가 아니다(no-account)');
  });
});

test('Z3-2 — stalled 는 다음 정상 주기에 false 로 · 실패 주기는 이전 run 필드를 null 로 · full 이면 accountsMissing null', async () => {
  await withVc(async (srv, state) => {
    const id = 'oc6';
    writeVc(srv.address().port, [{ id, name: 'OC6' }]);
    S.saveManualAccounts(['CORP\\svc-veeam']);
    const T = NOW - HOUR;
    state.events = [ev(1, T, 'CORP\\svc-veeam', 'a'), ev(2, T, 'CORP\\svc-veeam', 'b'), ev(3, T, 'CORP\\svc-veeam', 'c')];
    await C.pollVeeamSnapOnce({ now: NOW, perCallMax: 2 });
    const s1 = C.veeamSnapCollectorStatus().perVc[id];
    assert.equal(s1.stalled, true, `전제: 같은 ms 에 상한만큼 몰려 정체 — ${JSON.stringify(s1)}`);
    state.events = [ev(4, NOW - 30 * 60_000, 'CORP\\svc-veeam', 'd')];
    await C.pollVeeamSnapOnce({ now: NOW + 600_000, perCallMax: 2 });
    const s2 = C.veeamSnapCollectorStatus().perVc[id];
    assert.equal(s2.state, 'ok');
    assert.equal(s2.ended, 'empty');
    assert.equal(s2.stalled, false, '정상 주기 뒤에는 stalled 가 남지 않는다');
    assert.equal(s2.accountsMissing, null);
    assert.ok(s2.read >= 1 && s2.cursor > 0, JSON.stringify(s2));
    const okBefore = C.snapCollectorOkAt(id);
    assert.ok(okBefore > 0);
    // 실패 주기(연결 거부) — 이번 회차 값이 없음을 null 로 밝힌다(직전 성공 값이 '이번 값' 처럼 보이지 않게)
    writeVc(await closedPort(), [{ id, name: 'OC6' }]);
    const r3 = await C.pollVeeamSnapOnce({ now: NOW + 1_200_000 });
    assert.equal(r3.fail, 1, JSON.stringify(r3));
    const s3 = C.veeamSnapCollectorStatus().perVc[id];
    assert.equal(s3.state, 'fail');
    for (const k of ['read', 'stored', 'cursor', 'calls', 'capped', 'ended', 'reason', 'stalled', 'listChanged', 'accountsMissing']) assert.equal(s3[k], null, `${k} 는 null — ${JSON.stringify(s3)}`);
    assert.equal(s3.okAt, okBefore, 'okAt·seen 은 판정 값이라 그대로 싣는다');
    assert.equal(s3.seen, true);
    // I1 — 사유 코드 failed · 상태 warn
    assert.equal(C.snapCollectorReason(id, {}), 'failed');
    const st = C.veeamSnapCollectorStatus();
    assert.equal(st.issues.failed, 1);
    assert.equal(st.warn, true);
    assert.match(st.warnText, /실패 1곳/);
  });
});

test('I1 — 상태 함수: unseen·shared-only 가 있으면 warn · 정상이면 warn 아님 · 계정 0 은 no-account(warn 아님)', async () => {
  await withVc(async (srv, state) => {
    writeVc(srv.address().port, [{ id: 'okvc', name: 'OK' }]);
    S.saveManualAccounts(['CORP\\svc-veeam']);
    state.events = [ev(1, NOW - HOUR, 'CORP\\svc-veeam', 'a')];
    await C.pollVeeamSnapOnce({ now: NOW });
    let st = C.veeamSnapCollectorStatus();
    assert.equal(st.warn, false, JSON.stringify(st.issues));
    assert.equal(C.snapCollectorReason('okvc', {}), null, '구제하고 있으면 사유 없음');
    // 같은 목록 · 이벤트 없는 vCenter → unseen
    writeVc(srv.address().port, [{ id: 'okvc', name: 'OK' }, { id: 'quiet', name: 'Q' }]);
    await C.pollVeeamSnapOnce({ now: NOW + 600_000 });
    st = C.veeamSnapCollectorStatus();
    assert.equal(st.issues.unseen, 1);
    assert.equal(st.warn, true);
    assert.equal(C.snapCollectorReason('quiet', {}), 'unseen');
    // 계정 0 → no-account(사이트에 Veeam 이 없을 수 있다 — warn 아님)
    S.saveManualAccounts([]);
    C._resetForTest();
    await C.pollVeeamSnapOnce({ now: NOW + 1_200_000 });
    st = C.veeamSnapCollectorStatus();
    assert.equal(st.issues.noAccount, 2);
    assert.equal(st.warn, false);
    assert.equal(C.snapCollectorReason('quiet', {}), 'no-account');
    // 상태에 계정 이름·주소가 없다
    assert.ok(!/svc-veeam|127\.0\.0\.1/.test(JSON.stringify(st)));
  });
});

test('I1 — 라우트: snap-events·backup-counts(local)가 사유 코드만 싣는다(계정 이름 없음) · 비관리자도 같은 코드', async () => {
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerVeeamBadges } = await import('../src/routes/api/veeam.js');
  const prev = store.snapshot;
  await withVc(async (srv, state) => {
    const id = 'oc2r';
    writeVc(srv.address().port, [{ id, name: 'OC2R' }]);
    logLag9d([id]);
    S.saveManualAccounts(['administrator@vsphere.local']);
    state.events = [ev('h1', NOW - 3 * HOUR, 'administrator@vsphere.local', 'ops01')];
    await C.pollVeeamSnapOnce({ now: NOW });
    (await D.getSnapDb()).setCoveredFrom(id, NOW - 31 * DAY, NOW);
    let role = 'admin';
    const app = express();
    app.use((req, _res, next) => { req.user = { username: role === 'admin' ? 'a' : 'v', role }; next(); });
    const api = express.Router(); registerVeeamBadges(api); app.use('/api', api);
    const http2 = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    closers.push(() => new Promise((r) => http2.close(() => r())));
    const base = `http://127.0.0.1:${http2.address().port}/api/veeam`;
    const get = async (p) => { const res = await fetch(`${base}${p}`); return { s: res.status, j: await res.json() }; };
    try {
      store.snapshot = { source: 'live', hosts: [], generatedAt: new Date(NOW).toISOString(), vcenters: [{ id, name: 'OC2R' }], vms: [{ id: `${id}:vm-1`, vcenterId: id, name: 'ops01' }, { id: `${id}:vm-2`, vcenterId: id, name: 'db01' }] };
      const se = await get(`/snap-events?vcenterId=${encodeURIComponent(id)}`);
      assert.equal(se.s, 200, JSON.stringify(se.j));
      assert.equal(se.j.source, 'local');
      assert.equal(se.j.verdict?.reason, 'stale-events', JSON.stringify(se.j));
      assert.equal(se.j.snapCollector, 'shared-only');
      const card = (await get('/backup-counts')).j.byVc[id];
      assert.equal(card.n, null);
      assert.equal(card.reason, 'stale-events');
      assert.equal(card.snapCollector, 'shared-only');
      role = 'viewer';
      store.snapshot = { ...store.snapshot, generatedAt: new Date(NOW + 1000).toISOString() };   // 응답 캐시 키만 바꾼다
      const card2 = (await get('/backup-counts')).j.byVc[id];
      assert.equal(card2.snapCollector, 'shared-only', '사유 코드는 계정 이름이 없어 비관리자에게도 같다');
      const body = JSON.stringify([se.j, card, card2]);
      assert.ok(!/administrator|vsphere\.local|svc-/i.test(body), `계정 이름을 싣지 않는다: ${body}`);
    } finally { store.snapshot = prev; }
  });
});

test('Z3 I1 후속 — 서비스 점검 행: 상태 함수가 warn + warnText 를 내면 시각이 신선해도 경고', async () => {
  const { pollerCheck } = await import('../src/health/services.js');
  const now = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const base = { enabled: true, at: now - 60_000, intervalMs: 600_000 };
  assert.equal(pollerCheck(base, { now }).status, 'ok');
  const w = pollerCheck({ ...base, warn: true, warnText: '1곳 구제 못 함' }, { now });
  assert.equal(w.status, 'warn');
  assert.match(w.detail, /1곳 구제 못 함/);
  assert.equal(pollerCheck({ ...base, warn: true }, { now }).status, 'ok', 'warnText 없는 warn 은 무시(다른 상태 객체의 우연한 필드)');
});
