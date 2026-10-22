/**
 * v2.754 — vCenter 이벤트로 본 Veeam 백업(사용자 선택 ②: '지금 스냅샷이 없어도 최근 Veeam 백업을 본다').
 *  · 판정 코어: 스냅샷 '생성' 이벤트 · Veeam 계정(이름에 veeam · 사람이 적은 계정 · 자동 학습) · 동명 VM 은 고르지 않는다.
 *  · 계정 저장: 정리·상한·손상 보존 · 학습은 지금 임시 스냅샷이 있는 VM 의 생성 이벤트가 하나뿐일 때만.
 *  · 로컬 계산: 실제 로그 DB → 요약(학습 계정이 저장된다).
 *  · 조회 라우트: 범위 밖 404 · 직접 수집 vCenter 는 로컬 · site vCenter 는 엣지 요약(없으면 no-edge-data).
 *  · 엣지 진입: 실제 pushVeeamNow → 실제 centralRouter. 중앙은 그 엣지가 맡은 site vCenter 것만 받는다(direct·남의 것 거절) ·
 *    VM id 접두사 · 미래 시각은 수신 시각으로 · veeam-config pull 에 vcAccounts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'veeam2754-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.CENTRAL_TOKEN = 'ctok-2754';
delete process.env.CENTRAL_URL;
const VC = 'apac:vc01';      // 중앙 직접 수집
const SITE = 'eu:vc02';      // 엣지 위임
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: VC, name: 'vc01', host: 'vc01.corp.local', username: 'u', password: 'p' },
  { id: SITE, name: 'vc02', host: 'vc02.corp.local', username: 'u', password: 'p', collectMode: 'site', agent: 'edge-a' },
] }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const S = await import('../src/veeam/snapEvents.js');
const { config } = await import('../src/config.js');
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
const ev = (o) => ({ type: 'TaskEvent', severity: 'info', message: 'Task: Create virtual machine snapshot', ...o });

test('판정 코어 — 생성 이벤트만 · Veeam 계정(이름·표기 차이) · 동명 VM 은 고르지 않는다 · 기간 밖은 버린다', () => {
  assert.equal(S.isSnapshotCreateEvent(ev({})), true);
  assert.equal(S.isSnapshotCreateEvent({ type: 'VmSnapshotCreatedEvent', message: '' }), true);
  for (const m of ['Task: Remove snapshot', 'Task: Revert to current snapshot', 'Task: Consolidate virtual machine disk files', 'Task: Remove all snapshots', 'Cannot create virtual machine snapshot: failed']) {
    assert.equal(S.isSnapshotCreateEvent(ev({ message: m })), false, m);
  }
  assert.equal(S.isSnapshotCreateEvent({ type: 'AlarmStatusChangedEvent', severity: 'info', message: 'Task: Create virtual machine snapshot' }), false, '종류 한정(검토 #9)');
  assert.equal(S.isSnapshotCreateEvent(ev({ severity: 'error' })), false, '정보 심각도만');
  // 검토 #2: 도메인까지 적은 계정은 정확히 그 계정만 · 도메인 없이 적은 것만 어느 도메인이든
  const is = S.makeVeeamAccountMatcher(['svc-bk', 'administrator@vsphere.local']);
  assert.equal(is('CORP\\svc-veeam'), 'name');
  assert.equal(is('svc-bk@corp.local'), 'account', '도메인 없이 적은 계정 ↔ user@domain');
  assert.equal(is('corp\\SVC-BK'), 'account', '대소문자');
  assert.equal(is('VSPHERE.LOCAL\\Administrator'), null, '도메인 표기가 다르면 같은 계정으로 보지 않는다(정확히 적은 그대로만)');
  assert.equal(is('administrator@vsphere.local'), 'account');
  assert.equal(is('CORP\\Administrator'), null, '다른 도메인의 administrator 는 Veeam 이 아니다');
  assert.equal(is('CORP\\admin'), null);
  assert.equal(is(''), null);
  const vms = [{ id: `${VC}:vm-1`, name: 'web01' }, { id: `${VC}:vm-2`, name: 'dup' }, { id: `${VC}:vm-3`, name: 'DUP' }];
  const rows = [
    ev({ ts: NOW - 2 * HOUR, user: 'CORP\\svc-veeam', entity: 'web01' }),
    ev({ ts: NOW - 26 * HOUR, user: 'CORP\\svc-veeam', entity: 'web01' }),
    ev({ ts: NOW - HOUR, user: 'CORP\\admin', entity: 'web01' }),                                 // Veeam 아님
    ev({ ts: NOW - HOUR, user: 'CORP\\svc-veeam', entity: 'web01', message: 'Task: Remove snapshot' }), // 삭제
    ev({ ts: NOW - HOUR, user: 'CORP\\svc-veeam', entity: 'dup' }),                                  // 동명 둘
    ev({ ts: NOW - HOUR, user: 'CORP\\svc-veeam', entity: 'gone' }),                                 // 없는 VM
    ev({ ts: NOW - 9 * 24 * HOUR, user: 'CORP\\svc-veeam', entity: 'web01' }),                       // 기간 밖
  ];
  const r = S.summarizeVeeamSnapEvents(vms, rows, { since: NOW - 7 * 24 * HOUR });
  assert.deepEqual(r.byVm, { [`${VC}:vm-1`]: [NOW - 2 * HOUR, 2] });
  assert.equal(r.ambiguous, 1); assert.equal(r.unmatched, 1); assert.equal(r.events, 4);
});

test('자동 학습 후보 — 지금 임시 스냅샷이 있는 VM 의 그 시각 ±3분 생성 이벤트가 하나뿐일 때만 · 공용 계정 제외', () => {
  const vms = [
    { id: `${VC}:vm-1`, name: 'web01', veeamSnaps: 1, veeamSnapTs: NOW - 10 * 60_000 },
    { id: `${VC}:vm-2`, name: 'db01', veeamSnaps: 1, veeamSnapTs: NOW - 10 * 60_000 },
    { id: `${VC}:vm-3`, name: 'app01' }, // 임시 스냅샷 없음
    { id: `${VC}:vm-4`, name: 'web02', veeamSnaps: 1, veeamSnapTs: NOW - 10 * 60_000 },
    { id: `${VC}:vm-5`, name: 'web03', veeamSnaps: 1, veeamSnapTs: NOW - 10 * 60_000 },
  ];
  const rows = [
    ev({ ts: NOW - 11 * 60_000, user: 'CORP\\svc-bk', entity: 'web01' }),
    ev({ ts: NOW - 11 * 60_000, user: 'CORP\\svc-bk', entity: 'db01' }),
    ev({ ts: NOW - 12 * 60_000, user: 'CORP\\someone', entity: 'db01' }),       // 같은 창에 둘 — db01 은 배우지 않는다
    ev({ ts: NOW - 11 * 60_000, user: 'CORP\\admin', entity: 'app01' }),        // 임시 스냅샷 없는 VM
    ev({ ts: NOW - 3 * HOUR, user: 'CORP\\late', entity: 'web01' }),            // 창 밖
    ev({ ts: NOW - 6 * 60_000, user: 'CORP\\kim', entity: 'web02' }),          // 4분 차 — 창(3분) 밖(검토 #1)
    ev({ ts: NOW - 10 * 60_000, user: 'administrator@vsphere.local', entity: 'web03' }), // 공용 계정 — 배우지 않는다(검토 #2)
  ];
  assert.deepEqual(S.learnAccounts(vms, rows), [{ account: 'CORP\\svc-bk', vm: 'web01' }]);
});

test('계정 저장 — 정리·상한·제어문자 · 학습 기억 · 다시 읽기 · 엣지 pull 반영 · 손상 보존', () => {
  S._resetForTest();
  const r = S.saveManualAccounts('CORP\\svc-bk\ncorp\\SVC-BK\n\n bad\u0001x \n' + 'x'.repeat(200));
  assert.deepEqual(r.list, ['CORP\\svc-bk']); assert.equal(r.dropped, 2);
  assert.equal(S.rememberLearned([{ account: 'CORP\\learned', vm: 'a' }], NOW), 1);
  assert.equal(S.veeamAccounts(NOW).includes('CORP\\learned'), false, 'VM 1대로는 쓰지 않는다(검토 #1)');
  assert.equal(S.rememberLearned([{ account: 'CORP\\learned', vm: 'a' }], NOW + 60_000), 0, '같은 VM 을 1시간 안에 다시 쓰지 않는다');
  assert.equal(S.rememberLearned([{ account: 'CORP\\learned', vm: 'b' }], NOW + 60_000), 1, '새 VM 은 쓴다');
  assert.equal(S.rememberLearned([{ account: 'CORP\\wrong', vm: 'a' }, { account: 'CORP\\wrong', vm: 'b' }], NOW), 2);
  assert.equal(S.forgetLearned(['CORP\\wrong', 'nope']), 1, '잘못 배운 계정 지우기');
  assert.equal(S.applyPulledAccounts(['CORP\\from-central']), true);
  assert.equal(S.applyPulledAccounts(['CORP\\from-central']), false, '같으면 쓰지 않는다');
  S._resetForTest(); // 파일에서 다시 읽는다
  assert.deepEqual(S.veeamAccounts(NOW).sort(), ['CORP\\from-central', 'CORP\\learned', 'CORP\\svc-bk']);
  assert.equal(S.accountView(NOW).learned.find((x) => x.name === 'CORP\\learned').active, true);
  assert.deepEqual(S.veeamAccounts(NOW + 91 * 24 * HOUR).includes('CORP\\learned'), false, '90일 지난 학습 계정은 버린다');
  const file = path.join(DIR, 'veeam-vc-accounts.json');
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  fs.writeFileSync(file, '{broken');
  S._resetForTest();
  assert.deepEqual(S.veeamAccounts(NOW), []);
  assert.ok(S.accountView().loadError); assert.equal(S.accountsUnreadable(), true);
  assert.ok(fs.readdirSync(DIR).some((f) => f.startsWith('veeam-vc-accounts.json.corrupt.')), '손상본 보존');
  S._resetForTest();
  assert.equal(S.accountsUnreadable(), false, '재시작 뒤에는 파일 없음');
  assert.equal(S.accountView().corruptKept, true, '그래도 예전 손상본이 있다는 사실은 말한다');
  for (const f of fs.readdirSync(DIR)) if (f.startsWith('veeam-vc-accounts.json')) fs.rmSync(path.join(DIR, f), { force: true });
  S._resetForTest();
});

test('로컬 계산 — 실제 로그 DB · 학습한 계정으로 Veeam 이 아닌 이름의 이벤트도 잡는다', async () => {
  S._resetForTest();
  const { getLogsDb } = await import('../src/logs/db.js');
  const db = await getLogsDb();
  const rows = [
    { vcenterId: VC, key: 'a1', ts: NOW - 10 * 60_000, severity: 'info', type: 'TaskEvent', user: 'CORP\\svc-bk', entity: 'web01', message: 'Task: Create virtual machine snapshot' },
    { vcenterId: VC, key: 'a2', ts: NOW - 25 * HOUR, severity: 'info', type: 'TaskEvent', user: 'CORP\\svc-bk', entity: 'app01', message: 'Task: Create virtual machine snapshot' },
    { vcenterId: VC, key: 'a3', ts: NOW - 2 * HOUR, severity: 'info', type: 'TaskEvent', user: 'CORP\\admin', entity: 'app01', message: 'Task: Create virtual machine snapshot' },
    { vcenterId: SITE, key: 'b1', ts: NOW - HOUR, severity: 'info', type: 'TaskEvent', user: 'CORP\\svc-veeam', entity: 'web01', message: 'Task: Create virtual machine snapshot' },
  ];
  await db.insertManyAsync(rows);
  await db.insertManyAsync([{ vcenterId: VC, key: 'a4', ts: NOW - 10 * 60_000, severity: 'info', type: 'TaskEvent', user: 'CORP\\svc-bk', entity: 'db01', message: 'Task: Create virtual machine snapshot' }]);
  const vms = [{ id: `${VC}:vm-1`, name: 'web01', veeamSnaps: 1, veeamSnapTs: NOW - 9 * 60_000 }, { id: `${VC}:vm-2`, name: 'db01', veeamSnaps: 1, veeamSnapTs: NOW - 9 * 60_000 }, { id: `${VC}:vm-3`, name: 'app01' }];
  const r = await S.localSnapSummary(db, VC, vms, { now: NOW });
  assert.deepEqual(r.byVm, { [`${VC}:vm-1`]: [NOW - 10 * 60_000, 1], [`${VC}:vm-2`]: [NOW - 10 * 60_000, 1], [`${VC}:vm-3`]: [NOW - 25 * HOUR, 1] }, '다른 vCenter 이벤트·Veeam 아닌 계정은 빠진다');
  assert.ok(S.accountView(NOW).learned.some((x) => x.name === 'CORP\\svc-bk' && x.active), 'VM 2대에서 배운 계정이 저장·활성화됐다');
  assert.equal(r.accounts, 1);
});

test('엣지 요약 만들기 — 이 엣지가 직접 모으는 vCenter 만 · 수집 꺼짐은 상태로', async () => {
  const { getLogsDb } = await import('../src/logs/db.js');
  const db = await getLogsDb();
  const snap = { vcenters: [{ id: VC }, { id: SITE }], vms: [{ id: `${VC}:vm-1`, vcenterId: VC, name: 'web01' }] };
  const list = await S.edgeSnapPayload({ db, snap, notCollected: new Map([[SITE, 'site']]), logSettings: { enabled: true, minSeverity: 'info' }, now: NOW });
  assert.deepEqual(list.map((x) => x.vcenterId), [VC]);
  assert.ok(list[0].byVm[`${VC}:vm-1`]);
  const off = await S.edgeSnapPayload({ db, snap, notCollected: new Map(), logSettings: { enabled: false }, now: NOW });
  assert.deepEqual(off.map((x) => x.status), ['log-off', 'log-off']);
});

test('정제 — 맡은 vCenter 만 · VM id 접두사 · 수치 형식 · 미래 시각 자르기 · 상태 열거', () => {
  const owns = (id) => id === SITE;
  const r = S.sanitizeEdgeSnap([
    { vcenterId: SITE, at: NOW + 3_600_000, byVm: { [`${SITE}:vm-1`]: [NOW + 99 * HOUR, 3], [`${VC}:vm-9`]: [NOW, 1], [`${SITE}:vm-2`]: ['x', 1], [`${SITE}:vm-3`]: [NOW, 1.5] }, events: 5, junk: 'x' },
    { vcenterId: VC, byVm: {} },
    { vcenterId: SITE, status: 'evil', byVm: null },
    'nope',
  ], owns, NOW);
  assert.equal(r.items.length, 1);
  assert.deepEqual(r.items[0].byVm, { [`${SITE}:vm-1`]: [NOW, 3] });
  assert.equal(r.items[0].at, NOW, '미래 시각은 수신 시각으로'); assert.equal(r.items[0].edgeAt, NOW + 3_600_000);
  assert.equal('junk' in r.items[0], false);
  assert.deepEqual(r.dropped, { notOwned: 1, bad: 2 });
  const old = S.sanitizeEdgeSnap([{ vcenterId: SITE, byVm: { [`${SITE}:vm-1`]: [1, 1] } }], owns, NOW);
  assert.deepEqual(old.items[0].byVm, {}, '1970 같은 기간 밖 시각은 버린다(검토 #7)');
  const st = S.sanitizeEdgeSnap([{ vcenterId: SITE, status: 'log-off' }], owns, NOW);
  assert.equal(st.items[0].status, 'log-off'); assert.deepEqual(st.items[0].byVm, {});
});

/* ═══════════════ 실제 라우터 ═══════════════ */
let port = 0;
before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/central', centralRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  port = srv.address().port;
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
});

test('엣지 진입 — 실제 pushVeeamNow · 중앙은 그 엣지의 site vCenter 만 받는다 · pull 에 vcAccounts', async () => {
  S._resetForTest();
  S.saveManualAccounts(['CORP\\svc-bk']);
  const { issueAgentToken } = await import('../src/central/agentTokens.js');
  const tokA = issueAgentToken('edge-a').token;
  const tokB = issueAgentToken('edge-b').token;
  const post = async (tok, agent, body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/central/veeam-data?agent=${agent}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': tok, 'X-Agent-Name': agent }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const quiet = console.warn; console.warn = () => {};
  try {
    const { setInventory } = await import('../src/central/inventory.js');
    // 인벤토리 소유자가 없으면(TOFU 없음) 받지 않는다
    const pre = await post(tokA, 'edge-a', { results: [], snapEvents: [{ vcenterId: SITE, status: 'ok', byVm: { [`${SITE}:vm-1`]: [NOW - HOUR, 2] } }] });
    assert.equal(pre.body.snap.saved, 0); assert.equal(pre.body.snap.dropped.notOwned, 1);
    setInventory(SITE, { vcenter: { id: SITE, status: 'ok' }, hosts: [], vms: [] }, 'edge-a', NOW);
    // 공유 토큰은 여전히 403(v2.751 #5 — snapEvents 도 같은 문을 쓴다)
    assert.equal((await post('ctok-2754', 'edge-a', { snapEvents: [] })).status, 403);
    const body = { results: [], snapEvents: [
      { vcenterId: SITE, status: 'ok', at: Date.now(), byVm: { [`${SITE}:vm-1`]: [NOW - HOUR, 2] } }, // at 은 실제 시각 — 정시로 내린 NOW 면 30분 뒤 '오래됨' 판정에 걸린다
      { vcenterId: VC, status: 'ok', at: Date.now(), byVm: { [`${VC}:vm-1`]: [NOW - HOUR, 2] } }, // 중앙 직접 수집 — 거절
    ] };
    const a = await post(tokA, 'edge-a', body);
    assert.equal(a.status, 200); assert.equal(a.body.snap.saved, 1); assert.equal(a.body.snap.dropped.notOwned, 1);
    assert.deepEqual(S.edgeSnapFor(SITE).byVm, { [`${SITE}:vm-1`]: [NOW - HOUR, 2] });
    assert.equal(S.edgeSnapFor(VC), null);
    // pull — 사람이 적은 계정이 실린다
    const res = await fetch(`http://127.0.0.1:${port}/api/central/veeam-config?agent=edge-a`, { headers: { 'X-Central-Token': tokA, 'X-Agent-Name': 'edge-a' } });
    assert.deepEqual((await res.json()).vcAccounts, ['CORP\\svc-bk']);
    // 실제 push 진입 함수 — 이 프로세스의 store·로그 DB 로 요약을 만들어 보낸다(중앙 직접 vCenter 는 중앙이 거절)
    const keep = { ...config.agent };
    try {
      config.agent.centralUrl = `http://127.0.0.1:${port}`; config.agent.centralToken = tokB; config.agent.name = 'edge-b';
      const { store } = await import('../src/store.js');
      const prev = store.snapshot;
      store.snapshot = { source: 'live', vcenters: [{ id: VC, name: 'vc01' }, { id: SITE, name: 'vc02' }], vms: [{ id: `${VC}:vm-1`, vcenterId: VC, name: 'web01' }], hosts: [] };
      try {
        const push = await import('../src/veeam/push.js');
        const r = await push.pushVeeamNow();
        assert.equal(r.ok, true, r.reason);
        assert.equal(typeof r.snapVcenters, 'number');
        assert.deepEqual(S.edgeSnapFor(SITE).byVm, { [`${SITE}:vm-1`]: [NOW - HOUR, 2] }, 'edge-b 는 edge-a 의 site vCenter 를 덮어쓸 수 없다(이 프로세스에서 SITE 는 site 라 edge-b 요약에도 없다)');
        assert.equal(S.edgeSnapFor(VC), null, '중앙 직접 vCenter 는 엣지가 쓸 수 없다');
      } finally { store.snapshot = prev; }
    } finally { Object.assign(config.agent, keep); }
    // 남의 site vCenter 를 직접 보내도 거절(edge-b 는 SITE 의 위임 인벤토리 소유자가 아니다)
    const b = await post(tokB, 'edge-b', { results: [], snapEvents: [{ vcenterId: SITE, status: 'ok', byVm: { [`${SITE}:vm-1`]: [NOW, 99] } }] });
    assert.equal(b.body.snap.saved, 0); assert.equal(b.body.snap.dropped.notOwned, 1);
    assert.deepEqual(S.edgeSnapFor(SITE).byVm, { [`${SITE}:vm-1`]: [NOW - HOUR, 2] });
  } finally { console.warn = quiet; }
});

test('조회 라우트 — 범위 밖 404 · 직접 수집은 로컬 · site 는 엣지 요약 · 없으면 no-edge-data', async () => {
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerVeeamBadges } = await import('../src/routes/api/veeam.js');
  const prev = store.snapshot;
  store.snapshot = { source: 'live', generatedAt: NOW, vcenters: [{ id: VC, name: 'vc01' }, { id: SITE, name: 'vc02' }, { id: 'us:vc03', name: 'vc03' }],
    vms: [{ id: `${VC}:vm-1`, vcenterId: VC, name: 'web01' }, { id: `${SITE}:vm-1`, vcenterId: SITE, name: 'web01' }], hosts: [] };
  const app = express();
  app.use((req, _res, next) => { req.user = { username: 'v', role: 'viewer', scope: { vcenters: [VC, SITE] } }; next(); });
  const api = express.Router(); registerVeeamBadges(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const get = async (q) => { const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/veeam/snap-events?vcenterId=${encodeURIComponent(q)}`); return { status: res.status, body: await res.json() }; };
  try {
    assert.equal((await get('us:vc03')).status, 404, '범위 밖은 404');
    const local = await get(VC);
    assert.equal(local.body.status, 'ok'); assert.equal(local.body.source, 'local');
    assert.ok(local.body.byVm[`${VC}:vm-1`]);
    assert.equal(JSON.stringify(local.body).includes('svc-bk'), false, '계정 이름을 싣지 않는다');
    const site = await get(SITE);
    assert.equal(site.body.source, 'edge'); assert.deepEqual(site.body.byVm, { [`${SITE}:vm-1`]: [NOW - HOUR, 2] });
    // 오래된 엣지 요약은 '지금' 처럼 보이지 않는다(검토 #7) · 인벤토리에 없는 VM id 는 싣지 않는다(검토 #8)
    S.putEdgeSnap('edge-a', [{ vcenterId: SITE, status: 'ok', byVm: { [`${SITE}:vm-1`]: [NOW - HOUR, 1], [`${SITE}:vm-ghost`]: [NOW - HOUR, 1] }, at: Date.now() }]);
    store.snapshot = { ...store.snapshot, generatedAt: NOW + 1 };
    assert.deepEqual(Object.keys((await get(SITE)).body.byVm), [`${SITE}:vm-1`]);
    S.putEdgeSnap('edge-a', [{ vcenterId: SITE, status: 'ok', byVm: { [`${SITE}:vm-1`]: [NOW - HOUR, 1] }, at: Date.now() - 2 * HOUR }]);
    store.snapshot = { ...store.snapshot, generatedAt: NOW + 2 };
    assert.equal((await get(SITE)).body.status, 'stale-edge');
    S._resetForTest();
    store.snapshot = { ...store.snapshot, generatedAt: NOW + 3 }; // 캐시 키를 바꾼다
    const none = await get(SITE);
    assert.equal(none.body.status, 'no-edge-data');
  } finally { store.snapshot = prev; }
});
