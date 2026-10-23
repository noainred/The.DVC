/**
 * v2.765 — Veeam 계정 이벤트 전용 경량 수집기(veeam/snapCollector.js). 실서버 OC2 는 일반 로그 수집이 13일 뒤처져 '백업 시도' 가
 *   10-10 에 멈춘 것처럼 보였다 — 이제 Veeam 계정의 이벤트만 EventFilterSpecByUsername 으로 따로 읽어 전용 DB(snapDb)에 넣고,
 *   화면의 collectedAt 은 '로그 폴러 ok 시각과 전용 수집기 ok 시각 중 늦은 것'(snapEventsOkAt 하나) 이다.
 *  ① 필터 XML 에 계정 목록(systemUser false + userList) · ② 스냅샷 행만 전용 DB · ③ 커서(cur:<vc>)가 나아간다 ·
 *  ④ 호출 상한에 걸리면 같은 주기 안에서 이어 읽고 끝까지 읽었으면 okAt = 수집 시작 시각 · ⑤ 계정 0개면 건너뜀(SOAP 0회) ·
 *  ⑥ okAt 결합(snapEventsOkAt) + 라우트·push 가 그것만 쓴다 · ⑦ 인증 정지 vCenter 는 건너뜀 · ⑧ 표·대응표·기동 등재.
 *  재검토 후속(v2.765 2차): ⑨ 4-a 계정 표기 불일치의 0건 완결은 okAt 을 세우지 않는다(seen 뒤에만 · 재시작 복원도 seen 조건) ·
 *  ⑩ 2-b 이어 읽기 since 는 커서 포함(같은 ms 경계 유실 없음) + 같은 ms 에 상한만큼 몰리면 stalled 로 멈춤 ·
 *  ⑪ 1-a ingestSnapRows 조각 트랜잭션 + 양보 · ⑫ 4-f rescheduleVeeamSnapCollector.
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'veeam2764-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'live';
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
const SRC = new URL('../src/', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, SRC), 'utf8');

const C = await import('../src/veeam/snapCollector.js');
const D = await import('../src/veeam/snapDb.js');
const S = await import('../src/veeam/snapEvents.js');
const P = await import('../src/logs/poller.js');
const { saveLogSettings } = await import('../src/logs/settings.js');

/** 가짜 vCenter — CreateCollectorForEvents 본문을 기록하고, beginTime·userList 필터를 지킨다. */
function fakeVcenter() {
  const state = { events: [], view: [], served: 0, creates: [], reads: 0 };
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
        state.reads++;
        const n = Number((/<maxCount>(\d+)<\/maxCount>/.exec(b) || [])[1] || 0);
        const page = state.view.slice(state.served, state.served + n);
        state.served += page.length;
        const xml = page.map((e) => `<returnval xsi:type="TaskEvent"><key>${e.key}</key><createdTime>${new Date(e.ts).toISOString()}</createdTime><userName>${e.user}</userName><vm><name>${e.vm}</name></vm><fullFormattedMessage>${e.msg}</fullFormattedMessage></returnval>`).join('');
        return send(`<ReadNextEventsResponse>${xml}</ReadNextEventsResponse>`);
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

test('① 필터 — 계정 목록이 EventFilterSpec userName 에 실린다(systemUser false · 원문 + 표기 변형) · ② 스냅샷 행만 전용 DB · ③ 커서가 나아간다 · ⑤ 계정 0개면 SOAP 0회', async () => {
  const q = quiet();
  const { srv, state } = fakeVcenter();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    writeVc(srv, [{ id: 'oc2', name: 'OC2' }]);
    saveLogSettings({ enabled: true, maxPerPoll: 100, minSeverity: 'info', pollIntervalMin: 10 });
    S._resetForTest(); C._resetForTest();
    // ⑤ 계정 0개 — 그 vCenter 는 no-account 로 건너뛴다(일반 폴러·학습이 채운다) · SOAP 호출 없음
    const r0 = await C.pollVeeamSnapOnce({ now: NOW });
    assert.equal(r0.noAccount, 1, JSON.stringify(r0));
    assert.equal(state.creates.length, 0, '계정이 없으면 vCenter 에 묻지 않는다');
    assert.equal(C.veeamSnapCollectorStatus().perVc.oc2.state, 'no-account');
    // 계정 등록(사람이 적은 것 — 이벤트 원문 꼴) + 이벤트: Veeam 계정 스냅샷 3건 · Veeam 계정의 다른 작업 1건 · 다른 계정 스냅샷 1건
    S.saveManualAccounts(['CORP\\svc-veeam']);
    const t0 = NOW - 3 * HOUR;
    state.events = [
      ev(1, t0, 'CORP\\svc-veeam', 'web01'), ev(2, t0 + 60_000, 'CORP\\svc-veeam', 'db01'), ev(3, t0 + 120_000, 'CORP\\svc-veeam', 'web01', 'Task: Remove snapshot'),
      ev(4, t0 + 180_000, 'CORP\\svc-veeam', 'web01', 'Task: Reconfigure virtual machine'), ev(5, t0 + 240_000, 'CORP\\ops1', 'app01'),
    ];
    const r1 = await C.pollVeeamSnapOnce({ now: NOW });
    assert.equal(r1.ok, 1, JSON.stringify(r1));
    assert.equal(state.creates.length, 1);
    const body = state.creates[0];
    assert.match(body, /<userName><systemUser>false<\/systemUser><userList>CORP\\svc-veeam<\/userList>/, '원문 그대로 첫 항목');
    assert.match(body, /<userList>svc-veeam@corp<\/userList>/, 'DOMAIN\\user 는 user@domain 변형도 함께');
    assert.ok(!/<eventTypeId>/.test(body), '종류는 좁히지 않는다(TaskEvent·VmSnapshot* 모두 받아 isSnapRow 로 거른다)');
    const db = await D.getSnapDb();
    const rows = db.rowsFor('oc2', 0, 100);
    assert.deepEqual(rows.map((r) => r.entity).sort(), ['db01', 'web01', 'web01'], '스냅샷 행(생성·제거)만 — 재구성 작업·다른 계정은 없다');
    assert.equal(db.snapCursor('oc2'), t0 + 180_000, '커서 = 마지막으로 읽은 이벤트 시각(저장 여부와 무관)');
    assert.equal(db.snapOkAt('oc2'), NOW, '끝까지 읽었으면 okAt = 수집 시작 시각(영속)');
    assert.equal(C.snapCollectorOkAt('oc2'), NOW);
    // ③ 다음 주기는 커서 그 시각(포함)부터 — v2.765(2-b): +1ms 는 같은 ms 의 나머지를 영영 건너뛰었다(중복은 해시로 한 번)
    state.events.push(ev(6, NOW - 10 * 60_000, 'CORP\\svc-veeam', 'db01'));
    await C.pollVeeamSnapOnce({ now: NOW + 60_000 });
    const begin2 = Date.parse(/<beginTime>([^<]+)<\/beginTime>/.exec(state.creates[1])[1]);
    assert.equal(begin2, t0 + 180_000, '커서 시각부터(포함) 읽는다');
    assert.equal(db.rowsFor('oc2', 0, 100).length, 4);
    assert.equal(db.snapCursor('oc2'), NOW - 10 * 60_000);
    // 상태에는 주소·오류 원문이 없다(요약만)
    const st = JSON.stringify(C.veeamSnapCollectorStatus());
    assert.ok(!st.includes('127.0.0.1'), st);
    assert.equal(C.veeamSnapCollectorStatus().perVc.oc2.state, 'ok');
    assert.equal(C.veeamSnapCollectorStatus().perVc.oc2.seen, true, '계정 필터로 이벤트를 읽었다');
    assert.equal(C.veeamSnapCollectorStatus().perVc.oc2.reason, null);
    assert.equal(db.snapSeenAt('oc2') > 0, true, 'seen 영속');
    assert.equal(C.veeamSnapCollectorStatus().intervalMs, 600_000, '주기 = 로그 설정 pollIntervalMin');
  } finally { unquiet(q); await new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); }); }
});

test('④ 호출 상한에 걸리면 같은 주기 안에서 이어 읽는다(여러 CreateCollector) · 전부 읽었으면 okAt = 시작 시각 · 예산을 넘기면 마지막으로 읽은 시각', async () => {
  const q = quiet();
  const { srv, state } = fakeVcenter();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    writeVc(srv, [{ id: 'oc3', name: 'OC3' }]);
    saveLogSettings({ enabled: true, maxPerPoll: 100, minSeverity: 'info', pollIntervalMin: 10 });
    S._resetForTest(); C._resetForTest();
    S.saveManualAccounts(['svc-veeam@corp.local']);
    const t0 = NOW - 5 * HOUR;
    state.events = Array.from({ length: 25 }, (_, i) => ev(i + 1, t0 + i * 60_000, 'svc-veeam@corp.local', `vm${i % 7}`));
    const r = await C.pollVeeamSnapOnce({ now: NOW, perCallMax: 10 });
    assert.equal(r.ok, 1, JSON.stringify(r));
    assert.equal(state.creates.length, 3, '#1~10 · #10~19(커서 포함) · #19~25 → 세 번째 호출이 상한에 안 걸려 끝');
    const db = await D.getSnapDb();
    assert.equal(db.rowsFor('oc3', 0, 100).length, 25, '커서 시각 이벤트를 다시 읽어도 해시로 한 번');
    assert.equal(C.snapCollectorOkAt('oc3'), NOW, '끝까지 읽었다 — 시작 시각까지 온전');
    assert.equal(C.veeamSnapCollectorStatus().perVc.oc3.read, 27, '읽은 수는 커서 시각 재읽기 2건을 포함(2-b — 저장은 25)');
    // 예산 0 — 첫 호출(상한)만 하고 멈춘다 · okAt 은 마지막으로 읽은 시각(그 뒤는 아직 안 읽었다)
    state.events.push(...Array.from({ length: 12 }, (_, i) => ev(100 + i, NOW + i * 60_000, 'svc-veeam@corp.local', 'vmX')));
    const r2 = await C.pollVeeamSnapOnce({ now: NOW + 20 * 60_000, perCallMax: 10, budgetMs: 0 });
    assert.equal(r2.ok, 1);
    assert.equal(state.creates.length, 4);
    assert.equal(C.snapCollectorOkAt('oc3'), NOW + 8 * 60_000, '상한에 걸려 멈췄으면 마지막으로 읽은 이벤트 시각(시작 시각이 아니다 — 커서 #25 재읽기 1 + 새 9건)');
    assert.equal(C.veeamSnapCollectorStatus().perVc.oc3.capped, true);
    assert.equal(C.veeamSnapCollectorStatus().perVc.oc3.stalled, undefined, '진행이 있었으니 stalled 아님');
  } finally { unquiet(q); await new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); }); }
});

test('⑦ 인증 실패로 멈춘 vCenter 는 건너뛴다(SOAP 0회) · 직접 수집 대상이 아닌 vCenter(site·disabled)도 · 로그 수집이 꺼져 있으면 돌지 않는다', async () => {
  const q = quiet();
  const { srv, state } = fakeVcenter();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { vcAuthGuard } = await import('../src/vcenter/restClient.js');
    const { loadVcenterConfig } = await import('../src/config.js');
    writeVc(srv, [{ id: 'oc4', name: 'OC4' }, { id: 'pl1', name: 'PL1', collectMode: 'site' }, { id: 'off1', name: 'OFF', enabled: false }]);
    saveLogSettings({ enabled: true, maxPerPoll: 100, minSeverity: 'info', pollIntervalMin: 10 });
    S._resetForTest(); C._resetForTest();
    S.saveManualAccounts(['CORP\\svc-veeam']);
    state.events = [ev(1, NOW - HOUR, 'CORP\\svc-veeam', 'web01')];
    const vc = loadVcenterConfig().vcenters.find((v) => v.id === 'oc4');
    vcAuthGuard.markAuthStopped('oc4', vc, '인증 실패(테스트)');
    try {
      const r = await C.pollVeeamSnapOnce({ now: NOW });
      assert.equal(state.creates.length, 0, '인증 정지 vCenter 에 로그인하지 않는다');
      assert.deepEqual(r.authStopped, ['oc4']);
      assert.equal(r.targets, 1, 'site·disabled 는 대상이 아니다');
      assert.equal(C.veeamSnapCollectorStatus().perVc.oc4.state, 'auth-stopped');
    } finally { vcAuthGuard.clearAuthStop('oc4'); }
    saveLogSettings({ enabled: false });
    const r2 = await C.pollVeeamSnapOnce({ now: NOW });
    assert.equal(r2.skipped, 'log-off');
    assert.equal(state.creates.length, 0);
    assert.equal(C.veeamSnapCollectorStatus().enabled, false);
    saveLogSettings({ enabled: true, minSeverity: 'warning' });
    assert.equal((await C.pollVeeamSnapOnce({ now: NOW })).skipped, 'severity-filter', '정보 이벤트를 저장하지 않는 설정이면 화면도 severity-filter 라 돌지 않는다');
    saveLogSettings({ enabled: true, minSeverity: 'info' });
  } finally { unquiet(q); await new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); }); }
});

test('⑥ okAt 결합 — snapEventsOkAt = max(로그 폴러, 전용 수집기) · 전용 기록이 없으면 로그 폴러 값 그대로 · dedicated:false 면 로그 폴러만', () => {
  C._resetForTest();
  assert.equal(C.snapEventsOkAt('none'), P.logCollectOkAt('none'), '둘 다 없으면 null');
  assert.equal(C.snapEventsOkAt('none'), null);
  C._setOkAtForTest('vcA', NOW - HOUR);
  assert.equal(C.snapEventsOkAt('vcA'), NOW - HOUR, '로그 폴러 기록이 없으면 전용 수집기 값');
  assert.equal(C.snapEventsOkAt('vcA', { dedicated: false }), null, '전용 DB 를 쓰지 않은 요약에는 전용 수집기 시각을 섞지 않는다');
  // 순수 결합식
  assert.equal(C.combineOkAt(NOW - 13 * 24 * HOUR, NOW - 5 * 60_000), NOW - 5 * 60_000, '로그 폴러가 13일 뒤처져도 전용 수집기가 최신이면 그 값');
  assert.equal(C.combineOkAt(NOW, NOW - HOUR), NOW);
  assert.equal(C.combineOkAt(NOW, null), NOW);
  assert.equal(C.combineOkAt(null, null), null);
});

test('⑥ 소스 — 라우트(snap-events)·push(edgeSnapPayload) 의 collectedAt 은 snapEventsOkAt 하나만 쓴다 · 엣지 push 필드는 그대로', () => {
  const route = read('routes/api/veeam.js');
  assert.match(route, /collectedAt: snapEventsOkAt\(vcenterId/);
  assert.ok(!/collectedAt: logCollectOkAt\(/.test(route), '라우트가 로그 폴러 값을 직접 쓰지 않는다');
  const push = read('veeam/push.js');
  assert.match(push, /collectedAtFor: \(vc\) => snapEventsOkAt\(vc/);
  assert.ok(!/collectedAtFor: logCollectOkAt/.test(push));
  // 엣지 계약: edgeSnapPayload 가 싣는 필드는 바뀌지 않았다(collectedAt 값만 결합 함수로)
  const se = read('veeam/snapEvents.js');
  assert.match(se, /collectedAt: Number\.isFinite\(ca\) \? ca : null, \.\.\.\(collectRan === true \? \{ collectRan: true \} : \{\}\)/);
});

test('⑧ 등재 — edgelog/spec.js collect.veeamSnap · health/services.js MODS · index.js 기동(Veeam 묶음) · 상태 함수가 주기·실행 여부를 밝힌다', async () => {
  const { STATUS_SPEC } = await import('../src/edgelog/spec.js');
  const sp = STATUS_SPEC.find((s) => s.key === 'collect.veeamSnap');
  assert.ok(sp, '표에 collect.veeamSnap');
  assert.deepEqual([sp.group, sp.mod, sp.fn], ['collect', '../veeam/snapCollector.js', 'veeamSnapCollectorStatus']);
  assert.match(read('health/services.js'), /'\.\.\/veeam\/snapCollector\.js': m_veeamSnapCollector/);
  const idx = read('index.js');
  assert.match(idx, /import \{ startVeeamSnapCollector \} from '\.\/veeam\/snapCollector\.js'/);
  assert.match(idx, /startVeeamSnapWarmup, startVeeamSnapCollector/);
  const st = C.veeamSnapCollectorStatus();
  assert.ok(Number.isFinite(st.intervalMs) && st.intervalMs >= 60_000);
  assert.equal(typeof st.running, 'boolean');
});

test('⑨ 4-a — 계정 표기가 vCenter 와 맞지 않아 0건으로 완결되면 okAt 을 세우지 않는다(seen 뒤에만) · 결합은 로그 폴러 값으로 폴백 → 판정 stale-events 그대로 · 재시작 복원도 seen 조건', async () => {
  const q = quiet();
  const { srv, state } = fakeVcenter();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const B = await import('../src/veeam/backupCounts.js');
    writeVc(srv, [{ id: 'oc5', name: 'OC5' }]);
    saveLogSettings({ enabled: true, maxPerPoll: 100, minSeverity: 'info', pollIntervalMin: 10 });
    S._resetForTest(); C._resetForTest();
    // R/veeam_mask.mjs 시나리오: 사람이 'svc-veeam'(도메인 없음 — 다른 계정이 없어 변형을 만들 수 없다)으로 적고 실제 userName 은 'CORP\\svc-veeam'
    S.saveManualAccounts(['svc-veeam']);
    state.events = Array.from({ length: 5 }, (_, i) => ev(i, NOW - (i + 1) * HOUR, 'CORP\\svc-veeam', `vm${i}`));
    const r = await C.pollVeeamSnapOnce({ now: NOW });
    assert.equal(r.ok, 1, JSON.stringify(r));
    assert.equal(r.read, 0, 'vCenter 의 userList 정확 일치 — 0건');
    const db = await D.getSnapDb();
    assert.equal(db.rowsFor('oc5', 0, 100).length, 0);
    assert.equal(C.snapCollectorOkAt('oc5'), null, '0건 완결은 모름 — okAt 을 세우지 않는다');
    assert.equal(db.snapOkAt('oc5'), null, '영속도 하지 않는다');
    assert.equal(db.snapSeenAt('oc5'), null);
    const per = C.veeamSnapCollectorStatus().perVc.oc5;
    assert.equal(per.state, 'ok');
    assert.equal(per.seen, false);
    assert.equal(per.reason, 'unseen', '계정 표기가 vCenter 와 다를 수 있음');
    assert.equal(per.okAt, null);
    // 로그 폴러가 13일 뒤처진 vCenter — 결합은 로그 폴러 값 그대로 → 화면 판정 stale-events(ok+accountUnseen 으로 뒤집히지 않는다)
    const logOkAt = NOW - 13 * 24 * HOUR;
    const combined = C.combineOkAt(logOkAt, C.snapCollectorOkAt('oc5'));
    assert.equal(combined, logOkAt);
    const evSum = { status: 'ok', collectedAt: combined, staleMs: 6 * HOUR, accounts: 1, events: 0, unpaired: 0, byVm: {}, at: NOW };
    assert.deepEqual(B.snapVerdict(evSum, NOW), { ok: false, reason: 'stale-events' });
    // 사람이 표기를 고치면(원문 꼴 추가) 읽히고 그때부터 okAt 이 선다
    S.saveManualAccounts(['svc-veeam', 'CORP\\svc-veeam']);
    const r2 = await C.pollVeeamSnapOnce({ now: NOW + 60_000 });
    assert.equal(r2.read, 5, JSON.stringify(r2));
    assert.equal(C.snapCollectorOkAt('oc5'), NOW + 60_000);
    assert.equal(db.snapOkAt('oc5'), NOW + 60_000);
    assert.ok(db.snapSeenAt('oc5') > 0);
    assert.equal(C.veeamSnapCollectorStatus().perVc.oc5.seen, true);
    assert.equal(C.veeamSnapCollectorStatus().perVc.oc5.reason, null);
    // 재시작(메모리 초기화) — seen 이 있으니 okAt 복원 · seen 없는 ok 는 믿지 않는다
    C._resetForTest();
    db.setSnapOkAt('ghost', NOW);   // seen 없는 ok(표기 불일치 시절의 값을 흉내)
    assert.equal(C.snapCollectorOkAt('oc5'), null, '초기화 직후');
    await C.pollVeeamSnapOnce({ now: NOW + 120_000 });
    assert.equal(C.snapCollectorOkAt('oc5'), NOW + 120_000, 'seen 인 vCenter 는 복원되고 이어서 갱신');
    assert.equal(C.snapCollectorOkAt('ghost'), null, 'seen 없는 ok 는 복원하지 않는다');
  } finally { unquiet(q); await new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); }); }
});

test('⑩ 2-b — 같은 ms 에 상한 경계가 걸려도 유실 없음(since = 커서 포함 · 해시로 중복 제거) · 같은 ms 에 상한만큼 몰리면 stalled 로 멈춤(무한 반복 없음)', async () => {
  const q = quiet();
  const { srv, state } = fakeVcenter();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    writeVc(srv, [{ id: 'oc6', name: 'OC6' }]);
    saveLogSettings({ enabled: true, maxPerPoll: 100, minSeverity: 'info', pollIntervalMin: 10 });
    S._resetForTest(); C._resetForTest();
    S.saveManualAccounts(['CORP\\svc-veeam']);
    // 14건 · #8~#11 이 같은 ms · 상한 10 → 첫 호출 #0~#9(커서 = ts#8=ts#9) · 둘째 since = 커서(포함) → #8~#13. 예전(+1)은 #10·#11 영구 유실(12건)
    const t0 = NOW - 2 * HOUR;
    const ts = (i) => (i >= 8 && i <= 11 ? t0 + 8 * 60_000 : t0 + i * 60_000);
    state.events = Array.from({ length: 14 }, (_, i) => ev(i, ts(i), 'CORP\\svc-veeam', `vm${i}`));
    const r = await C.pollVeeamSnapOnce({ now: NOW, perCallMax: 10 });
    assert.equal(r.ok, 1, JSON.stringify(r));
    const db = await D.getSnapDb();
    assert.equal(db.rowsFor('oc6', 0, 100).length, 14, '같은 ms 의 나머지(#10·#11)도 저장');
    assert.equal(state.creates.length, 2);
    const begin2 = Date.parse(/<beginTime>([^<]+)<\/beginTime>/.exec(state.creates[1])[1]);
    assert.equal(begin2, t0 + 8 * 60_000, '둘째 호출 since = 커서 시각(포함)');
    assert.equal(C.snapCollectorOkAt('oc6'), NOW, '끝까지 읽어 완결');
    assert.equal(C.veeamSnapCollectorStatus().perVc.oc6.stalled, undefined);
    // 같은 ms 에 상한(10)보다 많은 15건 — 둘째 호출이 같은 결과(maxRead == 커서) → stalled 로 멈춘다(호출 2회 · 저장 10)
    S._resetForTest(); C._resetForTest();
    S.saveManualAccounts(['CORP\\svc-veeam']);
    writeVc(srv, [{ id: 'oc7', name: 'OC7' }]);
    const t1 = NOW - HOUR;
    state.events = Array.from({ length: 15 }, (_, i) => ev(i, t1, 'CORP\\svc-veeam', `vm${i}`));
    state.creates = [];
    const r2 = await C.pollVeeamSnapOnce({ now: NOW, perCallMax: 10 });
    assert.equal(r2.ok, 1, JSON.stringify(r2));
    assert.equal(state.creates.length, 2, '같은 since 로 한 번 더 읽고 진행이 없어 멈춤 — 세 번째 호출 없음');
    const per = C.veeamSnapCollectorStatus().perVc.oc7;
    assert.equal(per.stalled, true);
    assert.equal(per.capped, true);
    assert.equal(per.read, 20);
    assert.equal(db.rowsFor('oc7', 0, 100).length, 10, '상한만큼만 — 나머지 5건은 이 수집기로는 못 읽는다(상태가 밝힌다)');
    assert.equal(C.snapCollectorOkAt('oc7'), t1, '완결이 아니다 — 마지막으로 읽은 시각');
  } finally { unquiet(q); await new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); }); }
});

test('⑪ 1-a — ingestSnapRows 는 조각 트랜잭션 + 조각 사이 양보(setImmediate 가 끼어든다) · 결과(넣으려 한 수·저장 수)는 한 덩어리와 같다', async () => {
  const q = quiet();
  try {
    const db = await D.getSnapDb();
    const T0 = NOW - 20 * HOUR;
    const N = 12_000;
    const rows = Array.from({ length: N }, (_, i) => ({ vcenterId: 'ing1', ts: T0 + i * 1000, severity: 'info', type: 'TaskEvent', user: 'CORP\\svc-veeam', entity: `vm-${i % 300}`, message: `Task: Create virtual machine snapshot #${i}` }));
    rows.push({ vcenterId: 'ing1', ts: T0, severity: 'info', type: 'TaskEvent', user: 'u', entity: 'x', message: 'Task: Reconfigure virtual machine' });   // 스냅샷 아님 — 세지 않는다
    let ticks = 0; let done = false;
    const loop = () => { ticks++; if (!done) setImmediate(loop); };
    setImmediate(loop);
    const n = await D.ingestSnapRows(rows);
    done = true;
    assert.equal(n, N, '넣으려 한 스냅샷 행 수');
    assert.equal(db.rowsFor('ing1', 0, N + 10).length, N);
    assert.ok(ticks >= 3, `적재 중 이벤트 루프가 돌았다(setImmediate ${ticks}회) — 한 덩어리였으면 0`);
    // 조각 크기 지정 · 중복은 해시로 한 번
    const n2 = await db.ingestAsync(rows.slice(0, 2500), { chunkRows: 100 });
    assert.equal(n2, 2500);
    assert.equal(db.rowsFor('ing1', 0, N + 10).length, N, '다시 넣어도 한 번');
  } finally { unquiet(q); }
});

test('⑫ 4-f — rescheduleVeeamSnapCollector: 타이머가 무장돼 있으면 재무장 알림(구독자 1) · 없으면 0(설정 저장이 막히지 않는다)', async () => {
  const q = quiet();
  try {
    C._stopForTest();
    assert.equal(typeof C.rescheduleVeeamSnapCollector, 'function');
    assert.equal(C.rescheduleVeeamSnapCollector(), 0, '미기동이면 아무것도 하지 않는다');
    C.startVeeamSnapCollector();
    assert.equal(C.rescheduleVeeamSnapCollector(), 1, 'startAdaptiveTimer 구독자에게 알린다');
    C._stopForTest();
    assert.equal(C.rescheduleVeeamSnapCollector(), 0);
  } finally { unquiet(q); }
});
