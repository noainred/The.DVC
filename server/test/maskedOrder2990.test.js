// v2.990 — 가린 판본(범위 계정 · 비관리자)의 목록 순서는 '보이는 이름 → 보이는 키'(v2.989 반증 B-6 · 사용자 선택 '가린 응답 전부 · 표준 검증').
//   고치기 전: 입력 수집 순서 = 함대 정렬(전력 내림차순 → **원문** 이름 — insights/fleetInventory.js)이 그대로 실려, 이름이 전부 'idrac-•••' 로 보이는
//   서버들이 원문 태그 순으로 나왔다(가린 서비스 태그의 상대 순서가 드러난다). 비관리자 판본의 가린 주소 이름도 같은 계열.
//   고친 곳: 물리서버 폴더 메인 servers · missing · mismatch · CSV · ghost.prune 미리보기 / 서비스 인벤토리 members · candidates · CSV ·
//           queues(묶음 표본 · 키 · 유령) · ghosts.prune 미리보기. 비교는 `svcInventory.js visibleOrder` 하나(찾기 `/search` 와 같은 것).
//   바뀌지 않는 것: 전체 범위 관리자 판본(수집 순서 그대로) · 판정(resolved · 집계 — 판본마다 달라지지 않는다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maskedorder90-'));
process.env.CONFIG_DIR = tmp;

const bs = await import('../src/bmfolders/store.js');
const sm = await import('../src/servicemap/store.js');
const registry = await import('../src/idrac/registry.js');
const cstate = await import('../src/collector/state.js');
const rinv = await import('../src/collector/remoteInventory.js');
const { store } = await import('../src/store.js');
const { registerBmFolders, membersOf } = await import('../src/routes/api/bmFolders.js');
const svcinv = await import('../src/routes/api/svcInventory.js');
const { buildInventory } = await import('../src/servicemap/build.js');
const { maskedIdToken } = await import('../src/auth/addressMask.js');
const { parseCsvRows } = await import('../src/util/csv.js');
const { _resetExportBusy } = await import('../src/util/exportBusy.js');

const routes = new Map();
const reg = { get: (p, ...h) => routes.set(`GET ${p}`, h.at(-1)), post: (p, ...h) => routes.set(`POST ${p}`, h.at(-1)) };
registerBmFolders(reg); svcinv.registerSvcInventory(reg);
const scopeOf = (vcenters = []) => ({ vcenters, regions: [], writeVcenters: [] });
const ADMIN = { username: 'admin', role: 'admin', scope: scopeOf() };                 // 전체 범위 관리자 — 가리는 것이 없다
const SCOPED = { username: 'op-a', role: 'operator', scope: scopeOf(['vc-a']) };      // 범위 계정 — 태그 · 주소 가림
const SCOPED_ADMIN = { username: 'adm-a', role: 'admin', scope: scopeOf(['vc-a']) };  // 범위 지정 관리자 — 태그 가림
const OPER = { username: 'op-all', role: 'operator', scope: scopeOf() };              // 비관리자 · 전체 범위 — 주소 가림
const MASKED = [SCOPED, SCOPED_ADMIN, OPER];
let gen = 0;
async function call(key, { user = ADMIN, query = {}, body = {} } = {}) {
  const res = { statusCode: 200, headers: {}, body: undefined, headersSent: false,
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; this.headersSent = true; return this; },
    setHeader(k, v) { this.headers[k] = v; }, set(k, v) { this.headers[k] = v; return this; }, end() { this.headersSent = true; return this; }, send(x) { this.body = x; this.headersSent = true; return this; } };
  await routes.get(key)({ user, query, body, ip: '127.0.0.1', headers: {}, originalUrl: `${key.replace(/^\w+ /, '/api')}?${new URLSearchParams(query)}&u=${user.username}&g=${gen}` }, res);
  _resetExportBusy();
  return res;
}
const snapOf = (vms = [], hosts = []) => ({ ...store.snapshot, initial: false, generatedAt: Date.now() + 1000 + (gen += 7),
  vcenters: [{ id: 'vc-a', name: 'vcenter-a', status: 'ok' }, { id: 'vc-b', name: 'vcenter-b', status: 'ok' }], hosts, vms });
const SRV = (id, name, tag, vc) => ({ id, name, host: `https://192.0.2.${10 + Number(id.replace(/\D/g, '') || 0)}`, username: 'root', password: 'x', serviceTag: tag, ...(vc ? { vcenterId: vc } : {}) });
const VM = (id, name, vc = 'vc-a') => ({ id, name, vcenterId: vc, instanceUuid: `uuid-${id}`, powerState: 'POWERED_ON', host: '', cpuCount: 2, memMB: 4096 });
const S = (id, name) => ({ id, name, path: '', tier: 2, owner: '', note: '', globalId: '' });
const corpOf = (c = {}) => ({ folders: [], services: [], folderRules: [], aliases: [], nameRules: [], bmFolderRules: [], tagEnabled: false, ...c });
function reset({ servers = [], svc = { 'vc-a': corpOf({ services: [S('s1', 'ERP')] }) }, pins = {} } = {}) {
  bs._resetForTest(); sm._resetForTest();
  for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { recursive: true, force: true });
  fs.writeFileSync(path.join(tmp, 'service-map.json'), JSON.stringify({ rev: 0, globals: [], settings: { tagCategory: '' }, corps: svc }));
  fs.writeFileSync(path.join(tmp, 'service-map-pins.json'), JSON.stringify({ rev: 0, pins }));
  registry.importServers(servers, 'replace');
  cstate.clearCollectorHosts('c1'); rinv.clearCollectorServers('c1');
}
/** 수집 서버(pull) 경로 서버 한 대 — 전력이 있어 함대 정렬(전력 내림차순)의 **맨 앞**에 온다(이름 순이 아니다). */
function powered(name = 'pl-app-01', tag = 'RTAG01', watts = 300) {
  fs.writeFileSync(path.join(tmp, 'collectors.json'), JSON.stringify({ collectors: [{ id: 'c1', name: 'site-a', url: 'https://10.9.0.5:8443', enabled: true, vcenterId: 'vc-a' }] }));
  cstate.setCollectorStatus('c1', { ok: true, hosts: 1, at: Date.now() });
  rinv.setCollectorServers('c1', 'A', [{ id: 'r1', name, serviceTag: tag, host: '10.9.0.21' }]);
  cstate.clearCollectorHosts('c1');
  cstate.setRemoteHost('10.9.0.21', { watts, ts: Date.now(), collectorId: 'c1', serverName: name, serverId: 'r1', serviceTag: tag, vcenterId: 'vc-a', source: 'remote', dbKey: 'rmt:10.9.0.21' });
}
const withSnap = async (fn, vms = [], hosts = []) => { const prev = store.snapshot; try { store.snapshot = snapOf(vms, hosts); return await fn(); } finally { store.snapshot = prev; } };

// ── 판정 도우미: '응답 순서는 응답에 실린 값만으로 다시 만들 수 있다' ──
const col = new Intl.Collator('ko');
const cmp = (a, b) => col.compare(a[0], b[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
const pairs = (rows) => rows.map((x) => [String(x.name ?? ''), String(x.key ?? '')]);
function assertVisibleOrder(rows, msg) {
  const got = pairs(rows);
  assert.deepEqual(got, [...got].sort(cmp), `${msg} — 보이는 이름 → 보이는 키 순이어야 한다`);
}
const tok = (tag) => maskedIdToken(`st:${String(tag).toLowerCase()}`);
/** 원문은 x < y 인 태그 쌍 — agree 면 토큰도 x < y, 아니면 토큰은 반대(토큰은 프로세스 HMAC 이라 실행마다 다르다 — 실행 중에 고른다). */
function pickPair(agree) {
  for (let i = 0; i < 2000; i += 1) {
    const x = `QA${String(i).padStart(4, '0')}`; const y = `QB${String(i).padStart(4, '0')}`;
    if ((tok(x) < tok(y)) === agree) return [x, y];
  }
  throw new Error('토큰 쌍을 고르지 못했다');
}
/** 태그 n개 — **토큰 내림차순**으로 돌려준다(원문 순서 · 저장 순서를 일부러 토큰 순의 반대로 만들 때 쓴다). */
function tagsByTokenDesc(prefix, n) {
  return Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`).sort((a, b) => (tok(a) < tok(b) ? 1 : -1));
}
const csvRows = (text) => parseCsvRows(String(text));
const colOf = (rows, title) => { const i = rows[0].findIndex((h) => h.replace(/^﻿/, '') === title); assert.ok(i >= 0, `CSV 열 ${title}`); return rows.slice(1).map((r) => r[i]); };

// ───────── 도우미(순수) ─────────
test('visibleOrder: 전체 범위 관리자는 받은 배열 그대로 · 가린 판본은 보이는 이름 → 키 · 원본을 고치지 않는다 · always', () => {
  const { visibleOrder, visibleKeyOrder, isMaskedView } = svcinv;
  assert.deepEqual([isMaskedView(true, false), isMaskedView(true, true), isMaskedView(false, false), isMaskedView(false, true)], [false, true, true, true]);
  const list = [{ key: 'vm:3', kind: 'vm', name: 'b' }, { key: 'vm:2', kind: 'vm', name: 'a' }, { key: 'vm:1', kind: 'vm', name: 'a' }];
  assert.equal(visibleOrder(list, true, false), list, '전체 범위 관리자 — 같은 배열(정렬하지 않는다)');
  const before = list.map((x) => x.key);
  assert.deepEqual(visibleOrder(list, false, false).map((x) => x.key), ['vm:1', 'vm:2', 'vm:3'], '이름이 같으면 키 순');
  assert.deepEqual(visibleOrder(list, true, true).map((x) => x.key), ['vm:1', 'vm:2', 'vm:3']);
  assert.deepEqual(visibleOrder(list, true, false, { always: true }).map((x) => x.key), ['vm:1', 'vm:2', 'vm:3'], '찾기는 모든 판본에서 정렬');
  assert.deepEqual(list.map((x) => x.key), before, '원본 배열은 그대로(입력 수집 결과는 여러 요청이 함께 쓴다)');
  // 범위 계정: 베어메탈은 가린 이름 · 토큰으로 견준다 — 원문 태그 순이 아니다
  const [x, y] = pickPair(false);   // 원문 x < y · 토큰은 y 가 먼저
  const bm = [{ key: `st:${x.toLowerCase()}`, kind: 'bm', name: `idrac-${x}`, serviceTag: x }, { key: `st:${y.toLowerCase()}`, kind: 'bm', name: `idrac-${y}`, serviceTag: y }];
  assert.deepEqual(visibleOrder(bm, false, true).map((m) => m.serviceTag), [y, x], '이름이 같게 보이면 토큰 순');
  assert.deepEqual(visibleOrder(bm, true, false).map((m) => m.serviceTag), [x, y], '전체 범위 관리자는 받은 순서');
  assert.deepEqual(visibleKeyOrder([`st:${x.toLowerCase()}`, `st:${y.toLowerCase()}`], false, true), [`st:${y.toLowerCase()}`, `st:${x.toLowerCase()}`]);
  assert.deepEqual(visibleKeyOrder(['st:b', 'st:a'], true, false), ['st:b', 'st:a']);
});

test('buildInventory queueMembers: 큐(묶음 표본 · 키 · 없는 서비스 고정)는 준 순서 · 판정(resolved) · 집계는 members 순서 그대로', () => {
  const B = (i) => ({ key: `st:t${i}`, keyKind: 'serviceTag', kind: 'bm', corp: 'A', name: `srv-${i}`, serviceTag: `t${i}`, usage: { state: 'unread' }, faults: null, powered: null, aliasKeys: [] });
  const members = Array.from({ length: 45 }, (_, i) => B(String(i).padStart(2, '0')));
  const rev = [...members].reverse();
  const map = { globals: [], settings: { tagCategory: '' }, corps: { A: corpOf({ services: [S('s1', 'ERP')] }) } };
  const pins = { 'st:t03': { serviceId: 'gone', corp: 'A' }, 'st:t40': { serviceId: 'gone', corp: 'A' } };
  const base = buildInventory({ members, map, pins });
  const inv = buildInventory({ members, queueMembers: rev, map, pins });
  assert.deepEqual([...inv.resolved.keys()], members.map((m) => m.key), '판정 순서는 members 그대로');
  assert.deepEqual([...inv.resolved.values()], [...base.resolved.values()], '판정 결과는 순서와 무관');
  assert.deepEqual([inv.corps, inv.services, inv.noCorp], [base.corps, base.services, base.noCorp], '집계도 그대로');
  const g = inv.queues.unassigned[0]; const g0 = base.queues.unassigned[0];
  assert.equal(g.n, 45); assert.equal(g.names.length, 40);
  assert.deepEqual(g.names.map((x) => x.key), rev.slice(0, 40).map((m) => m.key), '표본(앞 40건)도 준 순서로 고른다 — 자른 뒤 정렬이 아니다');
  assert.deepEqual(g.keys, rev.map((m) => m.key));
  assert.deepEqual(g0.names.map((x) => x.key), members.slice(0, 40).map((m) => m.key), 'queueMembers 가 없으면 members 순서(전체 범위 관리자)');
  assert.deepEqual(inv.queues.dangling.map((x) => x.key), ['st:t40', 'st:t03']);
  assert.deepEqual(base.queues.dangling.map((x) => x.key), ['st:t03', 'st:t40']);
});

// ───────── 완료 기준: 원문 이름이 가린 태그 안에서만 다른 두 서버 ─────────
test('두 서버의 원문 이름이 가린 태그 안에서만 다르면 — 태그 값이 어떻든 같은 규칙(토큰 순)으로 나온다 · 원문 태그 순이 아니다(5곳 전부)', async () => {
  for (const agree of [true, false]) {
    const [x, y] = pickPair(agree);   // 원문 순서는 늘 x < y
    reset({ servers: [SRV('s1', `idrac-${x}`, x, 'vc-a'), SRV('s2', `idrac-${y}`, y, 'vc-a')] });
    const want = [tok(x), tok(y)].sort();   // agree=false 면 [y 의 토큰, x 의 토큰] — 원문 순서의 반대
    await withSnap(async () => {
      // 전체 범위 관리자 — 수집 순서(원문 이름 순) 그대로
      const a = await call('GET /tools/bm-folders');
      assert.deepEqual(a.body.servers.map((s) => s.name), [`idrac-${x}`, `idrac-${y}`]);
      const am = await call('GET /tools/svc-inventory/members', { query: { corp: 'vc-a' } });
      assert.deepEqual(am.body.members.map((s) => s.name), [`idrac-${x}`, `idrac-${y}`]);
      for (const user of [SCOPED, SCOPED_ADMIN]) {
        const label = `${user.username} agree=${agree}`;
        const s = await call('GET /tools/bm-folders', { user });
        assert.deepEqual(s.body.servers.map((r) => r.name), ['idrac-•••', 'idrac-•••'], label);
        assert.deepEqual(s.body.servers.map((r) => r.key), want, `물리서버 폴더 servers ${label}`);
        const m = await call('GET /tools/svc-inventory/members', { user, query: { corp: 'vc-a' } });
        assert.deepEqual(m.body.members.map((r) => r.key), want, `서비스 인벤토리 members ${label}`);
        const c = await call('GET /tools/svc-inventory/candidates', { user, query: { kind: 'bm', corp: 'vc-a' } });
        assert.deepEqual(c.body.items.map((r) => r.key), want, `서비스 인벤토리 candidates ${label}`);
        const csv = csvRows((await call('GET /tools/svc-inventory.csv', { user })).body);
        assert.deepEqual(colOf(csv, '키'), want, `서비스 인벤토리 CSV ${label}`);
        const q = await call('GET /tools/svc-inventory/queues', { user, query: { corp: 'vc-a' } });
        assert.deepEqual(q.body.unassigned[0].keys, want, `서비스 인벤토리 queues 묶음 키 ${label}`);
        assert.deepEqual(q.body.unassigned[0].names.map((r) => r.key), want, `서비스 인벤토리 queues 묶음 표본 ${label}`);
        const f = await call('GET /tools/bm-folders/search', { user, query: { inc: 'idrac' } });
        assert.deepEqual(f.body.rows.map((r) => r.key), want, `물리서버 폴더 찾기(반증 6 — 공용 비교로 바꾼 뒤에도) ${label}`);
        assert.equal(/qa\d{4}|qb\d{4}/i.test(JSON.stringify([s.body, m.body, c.body, q.body, f.body]) + csv.join('\n')), false, '태그 원문은 여전히 실리지 않는다');
      }
    });
  }
});

test('가린 태그가 이름 앞에 있어 원문 순서가 태그로 갈리는 두 서버 — 태그를 서로 바꿔도 가린 판본의 순서는 같다(물리서버 폴더 CSV 포함)', async () => {
  const seen = [];
  for (const [tagWeb, tagDb] of [['AAAA1', 'ZZZZ1'], ['ZZZZ1', 'AAAA1']]) {
    reset({ servers: [SRV('s1', `${tagWeb}-web`, tagWeb, 'vc-a'), SRV('s2', `${tagDb}-db`, tagDb, 'vc-a')] });
    await withSnap(async () => {
      const a = await call('GET /tools/bm-folders');
      seen.push(a.body.servers.map((s) => s.name).join(','));   // 전체 범위 관리자: 원문 순서 — 태그에 따라 갈린다
      for (const user of [SCOPED, SCOPED_ADMIN]) {
        const s = await call('GET /tools/bm-folders', { user });
        assert.deepEqual(s.body.servers.map((r) => r.name), ['•••-db', '•••-web'], `servers ${user.username} ${tagWeb}`);
        const csv = csvRows((await call('GET /tools/bm-folders.csv', { user })).body);
        assert.deepEqual(colOf(csv, '이름'), ['•••-db', '•••-web'], `물리서버 폴더 CSV ${user.username} ${tagWeb}`);
        assert.equal(csv[0].includes('서비스 태그'), false);
        const m = await call('GET /tools/svc-inventory/members', { user, query: { corp: 'vc-a' } });
        assert.deepEqual(m.body.members.map((r) => r.name), ['•••-db', '•••-web']);
        const c = await call('GET /tools/svc-inventory/candidates', { user, query: { kind: 'bm' } });
        assert.deepEqual(c.body.items.map((r) => r.name), ['•••-db', '•••-web']);
        assert.deepEqual(colOf(csvRows((await call('GET /tools/svc-inventory.csv', { user })).body), '이름'), ['•••-db', '•••-web']);
      }
    });
  }
  assert.deepEqual(seen, ['AAAA1-web,ZZZZ1-db', 'AAAA1-db,ZZZZ1-web'], '전체 범위 관리자 출력은 바뀌지 않았다(원문 이름 순)');
});

// ───────── 섞인 목록: VM · 이름이 곧 태그 · 주소 이름 · 전력 있는 서버 ─────────
const MIX = [SRV('s1', 'idrac-ZZZT1', 'ZZZT1', 'vc-a'), SRV('s2', 'idrac-AAAT2', 'AAAT2', 'vc-a'), SRV('s3', 'idrac-MMMT3', 'MMMT3', 'vc-a'), SRV('s4', 'idrac-BBBT4', 'BBBT4', 'vc-a'),
  SRV('s5', 'kr-db-01', 'KRDBT5', 'vc-a'), SRV('s6', 'NAMETAG6', 'NAMETAG6', 'vc-a'), SRV('s7', '192.0.2.200', 'IPTAG07', 'vc-a'), SRV('s8', '192.0.2.99', 'IPTAG08', 'vc-a'),
  SRV('s9', 'idrac-OUTB9', 'OUTB9', 'vc-b')];
const MIX_VMS = [VM('vm-2', 'zzz-vm'), VM('vm-1', 'aaa-vm'), VM('vm-9', 'mmm-vm', 'vc-b')];   // 스냅샷 순서는 이름 순이 아니다

test('전체 범위 관리자 판본은 그대로 — 수집 순서(전력 내림차순 → 원문 이름 · VM 은 스냅샷 순서)와 같고 이름 순으로 다시 정렬하지 않는다', async () => {
  reset({ servers: MIX }); powered();
  await withSnap(async () => {
    const g = await svcinv.sharedGather(store.snapshot);
    const bm = membersOf(g).members;
    const a = await call('GET /tools/bm-folders');
    assert.deepEqual(a.body.servers.map((s) => s.key), bm.map((m) => m.key), '물리서버 폴더 servers = 수집 순서');
    assert.equal(a.body.servers[0].name, 'pl-app-01', '전력이 있는 서버가 맨 앞(함대 정렬) — 이름 순이 아니다');
    assert.notDeepEqual(pairs(a.body.servers), [...pairs(a.body.servers)].sort(cmp), '(이 자료에서 수집 순서는 이름 순과 다르다 — 정렬했다면 여기서 드러난다)');
    assert.deepEqual(colOf(csvRows((await call('GET /tools/bm-folders.csv')).body), '이름'), bm.map((m) => m.name));
    const inA = g.members.filter((m) => m.corp === 'vc-a');
    const m = await call('GET /tools/svc-inventory/members', { query: { corp: 'vc-a' } });
    assert.deepEqual(m.body.members.map((s) => s.key), inA.map((x) => x.key), '서비스 인벤토리 members = 수집 순서');
    assert.deepEqual(m.body.members.slice(0, 2).map((s) => s.name), ['zzz-vm', 'aaa-vm'], 'VM 은 스냅샷 순서');
    const c = await call('GET /tools/svc-inventory/candidates', { query: { kind: 'bm', corp: 'vc-a' } });
    assert.deepEqual(c.body.items.map((s) => s.key), inA.filter((x) => x.kind === 'bm').map((x) => x.key));
    assert.deepEqual(colOf(csvRows((await call('GET /tools/svc-inventory.csv')).body), '키'), g.members.map((x) => x.key));
    const q = await call('GET /tools/svc-inventory/queues', { query: { corp: 'vc-a' } });
    const want = new Map(inA.map((x, i) => [x.key, i]));
    for (const grp of q.body.unassigned) assert.deepEqual(grp.keys, [...grp.keys].sort((p, r) => want.get(p) - want.get(r)), '큐 묶음도 수집 순서');
  }, MIX_VMS);
  // 찾기는 전체 범위 관리자도 이름 → 키 순이다(v2.984 반증 6 부터 — 공용 비교로 바꾸며 달라지지 않았다): 이름이 같은 베어메탈 · ESXi 호스트
  reset({ servers: [SRV('s1', 'dup-srv', 'TAGB1', 'vc-a')] });
  await withSnap(async () => {
    const f = await call('GET /tools/bm-folders/search', { query: { inc: 'dup', kinds: 'bm,esxi' } });
    assert.deepEqual(f.body.rows.map((r) => [r.name, r.kind, r.key]), [['dup-srv', 'esxi', 'st:taga1'], ['dup-srv', 'bm', 'st:tagb1']], '수집 순서는 베어메탈 먼저 — 찾기는 키 순으로 가른다');
  }, [], [{ id: 'h1', name: 'dup-srv', vcenterId: 'vc-a', serviceTag: 'TAGA1' }]);
});

test('물리서버 폴더: 폴더에 넣은 ESXi 호스트도 화면에 보이는 이름(태그를 가린 이름)으로 견준다', async () => {
  const [x, y] = pickPair(false);   // 원문 x < y · 토큰은 y 가 먼저
  reset({ servers: [SRV('s1', 'kr-db-01', 'KRDBT5', 'vc-a')] });
  const hosts = [{ id: 'h1', name: `esx-${x}`, vcenterId: 'vc-a', serviceTag: x }, { id: 'h2', name: `esx-${y}`, vcenterId: 'vc-a', serviceTag: y }];
  await withSnap(async () => {
    const f = await call('GET /tools/bm-folders/search', { query: { inc: 'esx', kinds: 'esxi' } });
    assert.equal(f.body.rows.length, 2, JSON.stringify(f.body).slice(0, 300));
    assert.equal((await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'VIRT', keys: f.body.rows.map((r) => r.key) } })).body.result.added, 2);
  }, [], hosts);
  await withSnap(async () => {
    const a = await call('GET /tools/bm-folders');
    assert.deepEqual(a.body.servers.map((r) => r.name), ['kr-db-01', `esx-${x}`, `esx-${y}`], '전체 범위 관리자 — 베어메탈 뒤에 ESXi(수집 순서)');
    const s = await call('GET /tools/bm-folders', { user: SCOPED });
    assert.deepEqual(s.body.servers.map((r) => r.name), ['esx-•••', 'esx-•••', 'kr-db-01']);
    assert.deepEqual(s.body.servers.slice(0, 2).map((r) => r.key), [tok(y), tok(x)], '이름이 같게 보이는 ESXi 두 대는 토큰 순 — 원문 태그 순이 아니다');
    assertVisibleOrder(s.body.servers, 'ESXi 포함 servers');
    assert.deepEqual(colOf(csvRows((await call('GET /tools/bm-folders.csv', { user: SCOPED })).body), '이름'), ['esx-•••', 'esx-•••', 'kr-db-01']);
  }, [], hosts);
});

test('가린 판본(범위 계정 · 범위 지정 관리자 · 비관리자) — 모든 목록의 순서를 응답에 실린 이름 · 키만으로 다시 만들 수 있다 · 수집 순서가 아니다', async () => {
  reset({ servers: MIX }); powered();
  await withSnap(async () => {
    const g = await svcinv.sharedGather(store.snapshot);
    for (const user of MASKED) {
      const u = user.username; const scoped = user.scope.vcenters.length > 0; const admin = user.role === 'admin';
      // ── 물리서버 폴더 ──
      const s = await call('GET /tools/bm-folders', { user });
      assert.equal(s.statusCode, 200, u);
      assertVisibleOrder(s.body.servers, `물리서버 폴더 servers ${u}`);
      assert.equal(s.body.servers.length, scoped ? 9 : 10, u);
      assert.notEqual(s.body.servers[0].name, 'pl-app-01', `${u}: 전력 순(함대 정렬)이 아니다`);
      if (scoped) {
        assert.equal(s.body.servers.filter((r) => r.name === 'idrac-•••').length, 4, u);
        assert.equal(s.body.servers.some((r) => /^서버 [0-9a-f]{6}$/.test(r.name)), true, `${u}: 이름이 곧 태그인 서버는 토큰 이름`);
      }
      if (!admin) assert.equal(s.body.servers.filter((r) => r.name.endsWith('(이름 가림)')).length, 2, `${u}: 주소 이름 가림`);
      const csv = csvRows((await call('GET /tools/bm-folders.csv', { user })).body);
      assert.deepEqual(colOf(csv, '이름'), s.body.servers.map((r) => r.name), `물리서버 폴더 CSV 는 화면 목록과 같은 순서 ${u}`);
      // ── 서비스 인벤토리 ──
      const m = await call('GET /tools/svc-inventory/members', { user, query: { corp: 'vc-a' } });
      assertVisibleOrder(m.body.members, `서비스 인벤토리 members ${u}`);
      assert.equal(m.body.members.length, 11, u);
      const at = (name) => m.body.members.findIndex((r) => r.name === name);
      assert.ok(at('aaa-vm') >= 0 && at('aaa-vm') < at('kr-db-01') && at('kr-db-01') < at('zzz-vm'), `${u}: VM · 베어메탈을 함께 보이는 이름 순으로(수집 순서는 VM 먼저 · zzz-vm → aaa-vm)`);
      const c = await call('GET /tools/svc-inventory/candidates', { user, query: { kind: 'bm', corp: 'vc-a' } });
      assertVisibleOrder(c.body.items, `서비스 인벤토리 candidates ${u}`);
      assert.equal(c.body.items.length, 9, u);
      const sc = csvRows((await call('GET /tools/svc-inventory.csv', { user })).body);
      const names = colOf(sc, '이름'); const keys = colOf(sc, '키');
      assertVisibleOrder(names.map((name, i) => ({ name, key: keys[i] })), `서비스 인벤토리 CSV ${u}`);
      assert.equal(names.length, scoped ? 11 : g.members.length, u);
      const q = await call('GET /tools/svc-inventory/queues', { user, query: { corp: 'vc-a' } });
      assert.ok(q.body.unassigned.length >= 1, u);
      for (const grp of q.body.unassigned) {
        assertVisibleOrder(grp.names, `서비스 인벤토리 queues 묶음 표본 ${u} ${grp.key}`);
        assert.deepEqual(grp.keys.slice(0, grp.names.length), grp.names.map((x) => x.key), `묶음 키 · 표본은 같은 순서 ${u}`);
      }
      // 찾기(반증 6 — v2.984)도 같은 비교
      const f = await call('GET /tools/bm-folders/search', { user, query: { inc: 'idrac,kr,pl' } });
      assertVisibleOrder(f.body.rows, `물리서버 폴더 찾기 ${u}`);
      // 가림은 그대로다(순서를 바꾸며 원문이 새지 않았다)
      const all = JSON.stringify([s.body, m.body, c.body, q.body, f.body]) + sc.join('\n') + csv.join('\n');
      if (scoped) assert.equal(/ZZZT1|AAAT2|MMMT3|BBBT4|NAMETAG6|IPTAG0|RTAG01|OUTB9/i.test(all), false, `${u}: 태그 원문 없음`);
      if (!admin) assert.equal(/192\.0\.2\.(200|99)/.test(all), false, `${u}: 주소 이름 원문 없음`);
    }
  }, MIX_VMS);
});

test('판정은 판본마다 같다 — 가린 판본의 순서 바꾸기가 집계(법인 · 서비스 · 큐 개수)를 바꾸지 않는다', async () => {
  reset({ servers: MIX }); powered();
  await withSnap(async () => {
    const a = await call('GET /tools/svc-inventory');
    const o = await call('GET /tools/svc-inventory', { user: OPER });
    assert.deepEqual([o.body.queues, o.body.queuesByCorp, o.body.services.map((x) => x.stat.n)], [a.body.queues, a.body.queuesByCorp, a.body.services.map((x) => x.stat.n)]);
    const ab = await call('GET /tools/bm-folders'); const ob = await call('GET /tools/bm-folders', { user: OPER });
    const strip = (c) => ({ ...c, agents: undefined, writable: undefined });
    assert.deepEqual(ob.body.corps.map(strip), ab.body.corps.map(strip));
    assert.deepEqual(ob.body.prefixGroups, ab.body.prefixGroups);
  }, MIX_VMS);
});

// ───────── 자르기보다 먼저 ─────────
test('자르기(CAP)는 보이는 순서로 정렬한 뒤에 — 수집 순서의 끝에 있어도 보이는 순서로 앞이면 실린다(members 5000 · candidates 2000)', async () => {
  reset({ servers: [] });
  const vms = Array.from({ length: 5002 }, (_, i) => VM(`vm-${i}`, i >= 5000 ? `aaa-first-${i}` : `m-${String(i).padStart(5, '0')}`));
  await withSnap(async () => {
    const m = await call('GET /tools/svc-inventory/members', { user: SCOPED, query: { corp: 'vc-a' } });
    assert.equal(m.body.members.length, 5000); assert.equal(m.body.omitted, 2);
    assert.deepEqual(m.body.members.slice(0, 2).map((r) => r.name), ['aaa-first-5000', 'aaa-first-5001'], '수집 순서로 자르면 이 둘이 잘린다');
    const c = await call('GET /tools/svc-inventory/candidates', { user: SCOPED, query: { kind: 'vm', corp: 'vc-a' } });
    assert.equal(c.body.items.length, 2000); assert.equal(c.body.omitted, 3002);
    assert.deepEqual(c.body.items.slice(0, 2).map((r) => r.name), ['aaa-first-5000', 'aaa-first-5001']);
    const a = await call('GET /tools/svc-inventory/members', { query: { corp: 'vc-a' } });
    assert.deepEqual(a.body.members.slice(0, 2).map((r) => r.name), ['m-00000', 'm-00001'], '전체 범위 관리자는 예전처럼 수집 순서로 자른다');
  }, vms);
});

// ───────── 저장 순서(등록 · 고정)를 싣는 목록 ─────────
test('물리서버 폴더: 목록에 없는 등록 · 정리 미리보기 키 · 불일치도 가린 판본은 보이는 값 순 — 등록 저장 순서 · 수집 순서가 아니다', async () => {
  // 등록은 **토큰 내림차순**으로 저장한다 → 저장 순서로 실으면 내림차순, 고친 뒤에는 오름차순
  const tags = tagsByTokenDesc('GH', 5);
  reset({ servers: tags.map((tg, i) => SRV(`s${i + 1}`, `idrac-${tg}`, tg, 'vc-a')) });
  await withSnap(async () => {
    const r = await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'DB', keys: tags.map((tg) => `st:${tg.toLowerCase()}`) } });
    assert.equal(r.body.result.added, 5, JSON.stringify(r.body));
  });
  assert.deepEqual(Object.keys(bs.peekAssign()), tags.map((tg) => `st:${tg.toLowerCase()}`), '저장 순서 = 토큰 내림차순(전제)');
  registry.importServers([SRV('s9', 'kr-keep-01', 'KEEP9', 'vc-a')], 'replace');   // 등록한 서버들이 목록에서 사라진다
  const asc = tags.map(tok).sort();
  await withSnap(async () => {
    const a = await call('GET /tools/bm-folders');
    assert.deepEqual(a.body.missing.map((x) => x.key), tags.map((tg) => `st:${tg.toLowerCase()}`), '전체 범위 관리자는 저장 순서 그대로');
    for (const user of [SCOPED, SCOPED_ADMIN]) {
      const s = await call('GET /tools/bm-folders', { user });
      assert.deepEqual(s.body.missing.map((x) => x.name), Array(5).fill('idrac-•••'), user.username);
      assert.deepEqual(s.body.missing.map((x) => x.key), asc, `missing ${user.username}`);
      const dry = await call('POST /tools/bm-folders/op', { user, body: { op: 'ghost.prune', dry: true } });
      assert.equal(dry.statusCode, 200, JSON.stringify(dry.body));
      assert.deepEqual(dry.body.result.keys, s.body.missing.filter((x) => x.state === 'ghost').map((x) => x.key), `정리 미리보기 ${user.username}`);
      assert.deepEqual(dry.body.result.keys, [...dry.body.result.keys].sort(), user.username);
    }
    const o = await call('GET /tools/bm-folders', { user: OPER });
    assertVisibleOrder(o.body.missing, '비관리자 missing');
    const od = await call('POST /tools/bm-folders/op', { user: OPER, body: { op: 'ghost.prune', dry: true } });
    assert.deepEqual(od.body.result.keys, [...od.body.result.keys].sort());
    const ad = await call('POST /tools/bm-folders/op', { body: { op: 'ghost.prune', dry: true } });
    assert.deepEqual(ad.body.result.keys, a.body.missing.filter((x) => x.state === 'ghost').map((x) => x.key), '전체 범위 관리자 미리보기도 그대로');
  });
  // 불일치: 수집 순서(원문 이름 순)가 토큰 내림차순이 되게 이름을 붙인다 — 법인이 바뀐 서버의 예전 등록
  const mt = tagsByTokenDesc('MM', 4);
  reset({ servers: mt.map((tg, i) => SRV(`s${i + 1}`, `m${i}-srv`, tg, 'vc-a')) });
  await withSnap(async () => { assert.equal((await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'DB', keys: mt.map((tg) => `st:${tg.toLowerCase()}`) } })).body.result.added, 4); });
  registry.importServers(mt.map((tg, i) => SRV(`s${i + 1}`, `m${i}-srv`, tg, 'vc-b')), 'replace');
  await withSnap(async () => {
    const a = await call('GET /tools/bm-folders');
    assert.deepEqual(a.body.mismatch.map((x) => x.key), mt.map((tg) => `st:${tg.toLowerCase()}`), '전체 범위 관리자는 수집 순서');
    const s = await call('GET /tools/bm-folders', { user: SCOPED });
    assert.deepEqual(s.body.mismatch.map((x) => x.key), mt.map(tok).sort(), '범위 계정 불일치는 토큰 순(이름을 싣지 않는다)');
    assert.deepEqual(s.body.mismatch.map((x) => [x.corp, x.was]), Array(4).fill(['', 'vc-a']));
  });
});

test('서비스 인벤토리: 유령 고정 · 정리 미리보기 키도 가린 판본은 보이는 키 순 — 고정 저장 순서가 아니다', async () => {
  const tags = tagsByTokenDesc('PN', 6);
  const pins = Object.fromEntries(tags.map((tg, i) => [`st:${tg.toLowerCase()}`, { serviceId: 's1', corp: 'vc-a', by: 'admin', at: 1000 + i }]));
  reset({ servers: [SRV('s9', 'kr-keep-01', 'KEEP9', 'vc-a')], pins });
  const stored = tags.map((tg) => `st:${tg.toLowerCase()}`); const asc = tags.map(tok).sort();
  await withSnap(async () => {
    const a = await call('GET /tools/svc-inventory/queues', { query: { corp: 'vc-a' } });
    assert.deepEqual(a.body.ghosts.map((x) => x.key), stored, '전체 범위 관리자는 저장 순서 그대로');
    const ad = await call('POST /tools/svc-inventory/op', { body: { op: 'ghosts.prune', corp: 'vc-a', dry: true } });
    assert.deepEqual(ad.body.result.keys, stored);
    for (const user of [SCOPED, SCOPED_ADMIN]) {
      const q = await call('GET /tools/svc-inventory/queues', { user, query: { corp: 'vc-a' } });
      assert.deepEqual(q.body.ghosts.map((x) => x.key), asc, `유령 ${user.username}`);
      const dry = await call('POST /tools/svc-inventory/op', { user, body: { op: 'ghosts.prune', corp: 'vc-a', dry: true } });
      assert.equal(dry.statusCode, 200, JSON.stringify(dry.body));
      assert.deepEqual(dry.body.result.keys, asc, `정리 미리보기 ${user.username}`);
    }
    const o = await call('GET /tools/svc-inventory/queues', { user: OPER, query: { corp: 'vc-a' } });
    assert.deepEqual(o.body.ghosts.map((x) => x.key), [...stored].sort(), '비관리자(키는 원문으로 보인다)도 보이는 키 순');
    const od = await call('POST /tools/svc-inventory/op', { user: OPER, body: { op: 'ghosts.prune', corp: 'vc-a', dry: true } });
    assert.deepEqual(od.body.result.keys, [...stored].sort(), '비관리자 정리 미리보기도 같은 순서');
    // 미리보기 키로 정리하면 그 키들이 지워진다(순서를 바꿔도 토큰 → 키 되돌리기는 그대로)
    const dry = await call('POST /tools/svc-inventory/op', { user: SCOPED, body: { op: 'ghosts.prune', corp: 'vc-a', dry: true } });
    const del = await call('POST /tools/svc-inventory/op', { user: SCOPED, body: { op: 'ghosts.prune', corp: 'vc-a', keys: dry.body.result.keys } });
    assert.equal(del.body.result.removed, 6, JSON.stringify(del.body));
  });
  // 유령 행 상한(앞 500건)도 보이는 키 순으로 정렬한 **뒤에** 자른다 — 저장 순서로 자르면 '어느 것이 잘렸는가' 에 저장 순서가 남는다
  const many = tagsByTokenDesc('PM', 502);
  reset({ servers: [SRV('s9', 'kr-keep-01', 'KEEP9', 'vc-a')], pins: Object.fromEntries(many.map((tg, i) => [`st:${tg.toLowerCase()}`, { serviceId: 's1', corp: 'vc-a', by: 'admin', at: 1000 + i }])) });
  await withSnap(async () => {
    const q = await call('GET /tools/svc-inventory/queues', { user: SCOPED, query: { corp: 'vc-a' } });
    assert.equal(q.body.ghostsN, 502); assert.equal(q.body.ghosts.length, 500);
    assert.deepEqual(q.body.ghosts.map((x) => x.key), many.map(tok).sort().slice(0, 500), '토큰이 가장 큰 둘(저장 순서로는 맨 앞)이 잘린다');
    const a = await call('GET /tools/svc-inventory/queues', { query: { corp: 'vc-a' } });
    assert.deepEqual(a.body.ghosts.map((x) => x.key), many.slice(0, 500).map((tg) => `st:${tg.toLowerCase()}`), '전체 범위 관리자는 저장 순서 앞 500건 그대로');
  });
});
