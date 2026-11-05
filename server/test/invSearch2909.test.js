/**
 * v2.909 헤더 ⌘K '통합 장비 검색'(docs/design/inventory-search) — 질의 해석 · 일치 등급 · 묶음 상한 · 종류별 접근(권한 · 도구 · 범위) ·
 * 주소 가림 · 라우트 응답(범위 밖 비노출 · 개수 · 잠금 · 오류 · 부품 개수)을 고정한다.
 *
 * 범위 · 권한 · 가림이 걸린 변경이라 변이 검증 대상이다(루트 CLAUDE.md '작업 규모 기본값').
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-search-'));
process.env.CONFIG_DIR = tmp;

let Q; let IDX; let ACC; let ROUTE; let WEBQ; let perms;
before(async () => {
  Q = await import('../src/search/inventoryQuery.js');
  IDX = await import('../src/search/inventoryIndex.js');
  ACC = await import('../src/search/inventoryAccess.js');
  ROUTE = await import('../src/routes/api/invSearch.js');
  WEBQ = await import('../../web/src/components/invSearchQuery.js');
  perms = await import('../src/auth/permissions.js');
});
after(() => { try { IDX._resetForTest(); ROUTE._setScopedIpForTest(null); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

// ── 질의 해석 ────────────────────────────────────────────────────────────────
test('parseQuery: 알려진 접두만 해석 · 최소 글자 · 상한 · 문자열 아닌 입력', () => {
  const a = Q.parseQuery('vm:web-01');
  assert.equal(a.kind, 'vm'); assert.equal(a.mode, 'all'); assert.equal(a.needle, 'web-01'); assert.equal(a.tooShort, false);
  const b = Q.parseQuery('ip:10.1');
  assert.equal(b.mode, 'ip'); assert.equal(b.kind, null); assert.equal(b.tooShort, false);
  assert.equal(Q.parseQuery('ip:10').tooShort, true, 'ip: 뒤는 3자부터');
  assert.equal(Q.parseQuery('sn:ab').tooShort, true, 'sn: 뒤는 3자부터');
  assert.equal(Q.parseQuery('w').tooShort, true, '장비는 2자부터(컨펌 ⑥)');
  assert.equal(Q.parseQuery('we').tooShort, false);
  const v6 = Q.parseQuery('fe80::1');
  assert.equal(v6.mode, 'all'); assert.equal(v6.kind, null); assert.equal(v6.needle, 'fe80::1', '숫자가 섞인 머리는 접두가 아니다(IPv6)');
  const unk = Q.parseQuery('zz:abc');
  assert.equal(unk.kind, null); assert.equal(unk.needle, 'zz:abc', '모르는 접두는 글자 그대로');
  const long = Q.parseQuery('a'.repeat(Q.QUERY_MAX + 1));
  assert.equal(long.tooLong, true); assert.equal(long.needle, '', '상한을 넘으면 아무것도 맞지 않는다(잘라서 넓게 맞추지 않는다)');
  assert.equal(Q.parseQuery(['vm:a']).needle, '', '배열 쿼리는 빈 입력');
  assert.equal(Q.parseQuery('  HOST:  Esx-01 ').needle, 'esx-01');
});

test('접두 표 · 종류 표는 웹(components/invSearchQuery.js)과 같다', () => {
  assert.deepEqual(WEBQ.KINDS.map((k) => [k.key, k.label, k.prefix]), Q.KINDS.map((k) => [k.key, k.label, k.prefix]));
  assert.deepEqual(WEBQ.PREFIXES, Q.PREFIXES);
  for (const s of ['vm:a', 'ip:10.1', 'sn:abc', 'xx:1', 'fe80::1', 'bm: r750', '']) {
    const w = WEBQ.splitPrefix(s); const p = Q.parseQuery(s);
    assert.equal(w.kind, p.kind, s); assert.equal(w.mode, p.mode, s);
  }
});

// ── 행 · 일치 등급 ─────────────────────────────────────────────────────────────
test('bareAddr: URL · 포트 · 경로를 떼고 IPv6 원문은 그대로', () => {
  assert.equal(IDX.bareAddr('https://10.0.0.5:443/redfish/v1'), '10.0.0.5');
  assert.equal(IDX.bareAddr('10.0.0.5:22'), '10.0.0.5');
  assert.equal(IDX.bareAddr('unity-kr.corp'), 'unity-kr.corp');
  assert.equal(IDX.bareAddr('[fe80::1]:443'), 'fe80::1');
  assert.equal(IDX.bareAddr('fe80::1'), 'fe80::1');
  assert.equal(IDX.bareAddr(null), '');
});

test('mkRow: 빈 · 의미 없는 시리얼은 버리고 검색 키를 한 번 만든다', () => {
  const r = IDX.mkRow('host', { id: 'vc1:h1', name: 'ESX-01', serials: ['N/A', '', '7HX-2K93', 'unknown'], ips: ['10.0.0.1', '10.0.0.1'] });
  assert.deepEqual(r.serials, ['7HX-2K93']);
  assert.deepEqual(r._sn, ['7hx2k93']);
  assert.deepEqual(r.ips, ['10.0.0.1']);
  assert.equal(r._n, 'esx-01');
});

const row = (kind, f) => IDX.mkRow(kind, f);

test('matchTier: 완전 일치 › 이름 앞글자 › 이름 포함 › 보조 이름 › IP › 시리얼 › 모델(v2.911 B1)', () => {
  const pq = Q.parseQuery('db0');
  assert.equal(Q.matchTier(row('vm', { name: 'db0' }), pq), 1, '이름 완전 일치');
  assert.equal(Q.matchTier(row('vm', { name: 'db01' }), pq), 2);
  assert.equal(Q.matchTier(row('vm', { name: 'srv-db01' }), pq), 3);
  assert.equal(Q.matchTier(row('ip', { name: '10.0.0.1', alt: 'db01' }), pq), 4);
  assert.equal(Q.matchTier(row('vm', { name: 'x', serials: ['DB0-99'] }), pq), 6);
  assert.equal(Q.matchTier(row('vm', { name: 'x', model: 'db0 model' }), pq), 7);
  assert.equal(Q.matchTier(row('vm', { name: 'x' }), pq), null);
  const ip = Q.parseQuery('10.20');
  assert.equal(Q.matchTier(row('vm', { name: 'x', ips: ['10.20.1.5'] }), ip), 5);
  assert.equal(Q.matchTier(row('vm', { name: 'x', ips: ['110.20.1.5'] }), ip), null, 'IP 는 앞자리 일치만');
  assert.equal(Q.matchTier(row('vm', { name: 'x', ips: ['10.1.0.1'] }), Q.parseQuery('10.1.0.1')), 1, 'IP 완전 일치');
  assert.equal(Q.matchTier(row('host', { name: 'x', serials: ['7HX-2K93'] }), Q.parseQuery('7hx2k93')), 1, '시리얼 완전 일치(구분자 무시)');
});

test('v2.911 B1: 완전 일치가 같은 종류 안에서 맨 앞 — IP 를 치면 그 IP 의 VM 이 10.1.0.1x 보다 먼저', () => {
  const rows = [
    row('vm', { id: 'a', name: 'aaa', ips: ['10.1.0.15'] }),
    row('vm', { id: 'b', name: 'bbb', ips: ['10.1.0.12'] }),
    row('vm', { id: 'z', name: 'zzz', ips: ['10.1.0.1'] }),
  ];
  const r = Q.searchRows(rows, Q.parseQuery('10.1.0.1'));
  assert.deepEqual(r.groups[0].rows.map((x) => x.id), ['z', 'a', 'b']);
});

test('v2.911 B2: 여러 낱말은 낱말마다 어느 칸에든 있으면(AND) — 통째 일치보다 뒤 · 가린 칸은 낱말에도 쓰지 않는다', () => {
  const rows = [
    row('vm', { id: 'v1', name: 'srv-db-01', sub: 'RHEL 8', corp: 'KR', host: 'esx-kr-07' }),
    row('vm', { id: 'v2', name: 'srv-web-01', sub: 'RHEL 8' }),
    row('vm', { id: 'v3', name: 'srv db phrase' }),
    row('host', { id: 'h1', name: 'esx-kr-07', model: 'Dell R760' }),
  ];
  const pq = Q.parseQuery('srv rhel');
  assert.deepEqual(pq.words.map((w) => w.w), ['srv', 'rhel']);
  assert.equal(Q.matchTier(rows[0], pq), 8);
  assert.equal(Q.matchTier(rows[3], pq), null, '한 낱말이라도 없으면 아니다');
  const r = Q.searchRows(rows, Q.parseQuery('srv db'));
  assert.deepEqual(r.groups[0].rows.map((x) => x.id), ['v3', 'v1'], '통째 일치(srv db phrase)가 먼저, 낱말 일치가 뒤');
  assert.equal(Q.parseQuery('a b c d e f g h').words.length, Q.WORDS_MAX);
  assert.equal(Q.parseQuery('ip:10.1 10.2').words, null, 'ip: · sn: 은 낱말로 나누지 않는다');
  const masked = row('sanswitch', { id: 's', name: '10.30.0.3 core', addr: '10.30.0.3' });
  assert.equal(Q.matchTier(masked, Q.parseQuery('10.30.0.3 core'), { addrSearchable: false }), null, '가린 이름 칸은 낱말로도 찾지 않는다');
});

test('matchTier: ip: 는 주소만 · sn: 은 시리얼만(구분자 무시) · 가린 주소로는 찾지 않는다', () => {
  const st = row('storage', { name: 'unity-a', addr: '10.9.8.7', serials: ['APM00-1234'] });
  assert.equal(Q.matchTier(st, Q.parseQuery('ip:10.9.8')), 2);
  assert.equal(Q.matchTier(st, Q.parseQuery('ip:10.9.8'), { addrSearchable: false }), null, '가림 대상이면 주소로 걸리지 않는다');
  assert.equal(Q.matchTier(st, Q.parseQuery('10.9.8'), { addrSearchable: false }), null);
  assert.equal(Q.matchTier(st, Q.parseQuery('sn:apm001234')), 1, '구분자 무시 완전 일치');
  assert.equal(Q.matchTier(st, Q.parseQuery('sn:unity')), null, 'sn: 은 이름을 보지 않는다');
  assert.equal(Q.matchTier(st, Q.parseQuery('ip:unity')), null, 'ip: 는 이름을 보지 않는다');
});

test('searchRows: 묶음당 5 · 전체 60 · 종류 하나면 30 · 칩 개수는 종류 필터와 무관 · 잘린 수', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(row('vm', { id: `v${i}`, name: `web-${String(i).padStart(2, '0')}` }));
  for (let i = 0; i < 40; i++) rows.push(row('ip', { id: `10.0.0.${i}`, name: `10.0.0.${i}`, alt: `web-${i}` }));
  const all = Q.searchRows(rows, Q.parseQuery('web'));
  assert.deepEqual(all.groups.map((g) => [g.kind, g.total, g.rows.length]), [['vm', 40, 5], ['ip', 40, 5]]);
  assert.equal(all.shown, 10); assert.equal(all.omitted, 70);
  assert.equal(all.groups[0].rows[0].name, 'web-00', '같은 등급은 이름순');
  const one = Q.searchRows(rows, Q.parseQuery('vm:web'));
  assert.deepEqual(one.groups.map((g) => [g.kind, g.rows.length]), [['vm', 30]]);
  assert.equal(one.counts.ip, 40, '다른 종류의 개수도 센다(칩에 보인다)');
  const many = [];
  for (const k of Q.KIND_KEYS) for (let i = 0; i < 10; i++) many.push(row(k, { id: `${k}${i}`, name: `zz-${k}-${i}` }));
  const capped = Q.searchRows(many, Q.parseQuery('zz-'), { perKind: 9 });
  assert.equal(capped.shown, Q.TOTAL_MAX, '전체 상한');
  assert.equal(capped.matched, 110);
  assert.equal(Q.searchRows(rows, Q.parseQuery('w')).groups.length, 0, '1자는 결과 없음');
});

// ── 접근 판정 ──────────────────────────────────────────────────────────────────
const SNAP = { vcenters: [{ id: 'vc1', name: 'KR' }, { id: 'vc2', name: 'PL' }] };
const ADMIN = { username: 'adm', role: 'admin' };
const OPER = { username: 'op1', role: 'operator' };
const RANGE = { username: 'op2', role: 'operator', scope: { vcenters: ['vc1'] } };
const DEMO = { username: 'demo', role: 'admin', demoGuest: true };

test('accessPlan: 관리자 전 종류 · 비관리자는 베어메탈 없음 · 범위 계정은 전체 범위 전용 종류 잠금', () => {
  const a = ACC.accessPlan(ADMIN, SNAP);
  assert.deepEqual(Object.keys(a.kinds).sort(), [...Q.KIND_KEYS].sort());
  assert.ok(Object.values(a.kinds).every((v) => v === 'ok'));
  const o = ACC.accessPlan(OPER, SNAP);
  assert.equal(o.kinds.server, undefined, '서버 분석은 관리자 전용 API — 비관리자에게 종류를 열지 않는다');
  assert.equal(o.kinds.gpu, undefined, '물리 GPU 서버(서버 분석 › GPU)도 관리자 전용');
  assert.equal(o.kinds.storage, 'ok');
  assert.equal(o.addrSearchable(row('storage', {})), false);
  assert.equal(o.addrSearchable(row('vm', {})), true);
  const d = ACC.accessPlan(DEMO, SNAP);
  assert.equal(d.kinds.server, undefined, '데모 계정은 관리자 판본이 아니다(isAdminDetailUser)');
  assert.equal(d.addrSearchable(row('pdu', {})), false);
  const r = ACC.accessPlan(RANGE, SNAP);
  for (const k of ['storage', 'sanswitch', 'netswitch', 'pdu']) assert.equal(r.kinds[k], 'locked', k);
  assert.equal(r.kinds.vm, 'ok');
});

test('accessPlan.visible: 범위 밖 · 귀속 없음 · 스캔 발견 IP · 잠긴 종류는 범위 계정에 보이지 않는다', () => {
  const r = ACC.accessPlan(RANGE, SNAP);
  assert.equal(r.visible(row('vm', { vcenterId: 'vc1' })), true);
  assert.equal(r.visible(row('vm', { vcenterId: 'vc2' })), false);
  assert.equal(r.visible(row('gpu', { vcenterId: '' })), false, '귀속 없는 GPU 서버');
  assert.equal(r.visible(row('ip', { vcenterId: 'vc1', ownerType: 'scanned' })), false, '스캔 발견은 귀속 판정 불가');
  assert.equal(r.visible(row('ip', { vcenterId: 'vc1', ownerType: 'manual' })), true);
  assert.equal(r.visible(row('storage', { vcenterId: 'vc1' })), false, '전체 범위 전용 종류는 귀속값이 있어도 막는다');
  const a = ACC.accessPlan(ADMIN, SNAP);
  assert.equal(a.visible(row('storage', {})), true);
  assert.equal(a.visible(row('ip', { ownerType: 'scanned' })), true);
});

test('accessPlan: 도구 접근을 거부한 종류는 칩도 행도 없다', () => {
  const name = 'op-deny';
  const r = perms.setUserTools(name, { mode: 'deny', tools: ['storage-mon', 'ipam'] });
  assert.equal(r.ok, true, r.reason);
  const p = ACC.accessPlan({ username: name, role: 'operator' }, SNAP);
  assert.equal(p.kinds.storage, undefined);
  assert.equal(p.kinds.ip, undefined);
  assert.equal(p.kinds.pdu, 'ok');
  assert.equal(p.visible(row('storage', {})), false);
  perms.setUserTools(name, { mode: 'off' });
});

test('publicRow: 비관리자는 관리 주소 · 주소가 든 이름 · id 를 비우고 검색 키를 싣지 않는다', () => {
  const st = row('pdu', { id: 'pdu-1', name: '10.9.8.7', addr: '10.9.8.7', serials: ['S1'] });
  const o = ACC.publicRow(st, ACC.accessPlan(OPER, SNAP));
  assert.equal(o.addr, ''); assert.deepEqual(o.ips, []); assert.equal(o.addrHidden, true);
  assert.equal(o.name, 'PDU (이름 가림)');
  assert.equal(o.id, 'pdu-1');
  assert.ok(!Object.keys(o).some((k) => k.startsWith('_')), '검색 키는 응답에 없다');
  const leak = ACC.publicRow(row('sanswitch', { id: 'sw-10.9.8.7', name: 'core', addr: '10.9.8.7' }), ACC.accessPlan(OPER, SNAP));
  assert.equal(leak.id, '', '주소가 든 id 도 비운다');
  const a = ACC.publicRow(st, ACC.accessPlan(ADMIN, SNAP));
  assert.equal(a.addr, '10.9.8.7'); assert.equal(a.name, '10.9.8.7');
});

// ── 라우트 ────────────────────────────────────────────────────────────────────
function handler() {
  const routes = {};
  ROUTE.registerInvSearch({ get: (p, ...h) => { routes[p] = h.at(-1); } });
  return routes['/search/inventory'];
}
async function call(user, query) {
  const h = handler();
  let status = 200; let body;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  await h({ user, query }, res);
  return { status, body };
}

async function seed() {
  const { store } = await import('../src/store.js');
  if (typeof store.set === 'function') store.set({ ...SNAP, vms: [], hosts: [] });
  IDX._setIndexForTest([
    row('vm', { id: 'vc1:a', name: 'srv-db-01', ips: ['10.20.1.11'], vcenterId: 'vc1', corp: 'KR' }),
    row('vm', { id: 'vc2:b', name: 'srv-db-pl', ips: ['10.44.1.11'], vcenterId: 'vc2', corp: 'PL' }),
    row('host', { id: 'vc2:h', name: 'esx-srv-db-pl', serials: ['7HX2K93'], vcenterId: 'vc2' }),
    row('storage', { id: 'st-1', name: 'unity-srv-db', addr: '10.20.8.10', serials: ['APM001'] }),
    row('ip', { id: '10.20.1.13', name: '10.20.1.13', ips: ['10.20.1.13'], alt: 'srv-db-old', vcenterId: '', ownerType: 'scanned' }),
    row('ip', { id: '10.20.1.11', name: '10.20.1.11', ips: ['10.20.1.11'], alt: 'srv-db-01', vcenterId: 'vc1', ownerType: 'vm' }),
  ], { storage: { rows: 1, error: 'registryUnreadable' }, vm: { rows: 2 } });
  // 범위 계정의 IP 행은 IP관리와 같은 범위 원장에서 온다(반증 L-2) — 여기서는 그 출처를 고정한다.
  ROUTE._setScopedIpForTest(async (_snap, allowed) => {
    scopedIpCalls.push([...allowed]);
    return [
      row('ip', { id: '10.20.1.11', name: '10.20.1.11', ips: ['10.20.1.11'], alt: 'srv-db-01', vcenterId: 'vc1', ownerType: 'vm' }),
      row('ip', { id: '10.50.0.7', name: '10.50.0.7', ips: ['10.50.0.7'], alt: 'kr-reserved-db', vcenterId: 'vc1', ownerType: 'manual' }),
      row('ip', { id: '10.99.0.1', name: '10.99.0.1', ips: ['10.99.0.1'], alt: 'srv-db-x', vcenterId: 'vc2', ownerType: 'manual' }),
    ];
  });
}
const scopedIpCalls = [];

test('라우트: 범위 계정 응답에는 범위 밖 이름 · 개수가 어디에도 없다', async () => {
  await seed();
  const { status, body } = await call(RANGE, { q: 'srv-db' });
  assert.equal(status, 200);
  const txt = JSON.stringify(body);
  for (const leak of ['srv-db-pl', 'esx-srv-db-pl', 'unity-srv-db', 'srv-db-old', '10.20.8.10']) assert.ok(!txt.includes(leak), `범위 밖 노출: ${leak}`);
  assert.equal(body.counts.vm, 1); assert.equal(body.counts.host, 0); assert.equal(body.counts.ip, 1);
  assert.equal(body.counts.storage, undefined, '잠긴 종류는 개수를 싣지 않는다');
  const st = body.kinds.find((k) => k.key === 'storage');
  assert.equal(st.locked, true); assert.ok(st.reason);
  assert.equal(body.errors.storage, undefined, '잠긴 종류의 출처 오류도 싣지 않는다');
  assert.equal(body.scoped, true);
  const empty = await call(RANGE, {});
  assert.equal(empty.body.counts.vm, 1, '빈 입력의 종류별 개수도 범위 안만');
  assert.ok(!JSON.stringify(empty.body).includes('"rows":'), '출처 전체 개수(sources.rows)는 싣지 않는다');
});

test('라우트(반증 L-2): 범위 계정의 IP 행은 범위 원장에서 — 자기 vCenter 로 예약한 수동 IP 가 보이고, 원장이 잘못 준 범위 밖 행은 다시 거른다', async () => {
  await seed();
  scopedIpCalls.length = 0;
  const r = await call(RANGE, { q: 'kr-reserved' });
  assert.deepEqual(scopedIpCalls, [['vc1']], '범위 원장은 그 계정의 허용 vCenter 로 만든다');
  assert.deepEqual(r.body.groups.map((g) => [g.kind, g.rows.map((x) => x.id)]), [['ip', ['10.50.0.7']]]);
  const leak = await call(RANGE, { q: 'srv-db-x' });
  assert.equal(leak.body.matched, 0, '원장 행도 visible() 로 한 번 더 거른다');
  scopedIpCalls.length = 0;
  await call(ADMIN, { q: 'srv' });
  assert.equal(scopedIpCalls.length, 0, '전체 범위 계정은 관리자 판본 색인 그대로');
});

test('반증 M-1: 비관리자는 이름 · 보조 이름 · 모델에 든 가린 주소로도 찾지 못하고, 같은 등급 순서도 주소 순이 아니다', async () => {
  const { store } = await import('../src/store.js');
  void store;
  IDX._setIndexForTest([
    row('sanswitch', { id: 'sw-1', name: '10.30.0.3', alt: '10.30.0.3', addr: '10.30.0.3', serials: ['S1'] }),
    row('sanswitch', { id: 'sw-2', name: '10.30.0.5', addr: '10.30.0.5', serials: ['S2'] }),
    row('sanswitch', { id: 'sw-3', name: 'core-a', alt: '172.16.5.9', addr: '172.16.5.9' }),
    row('pdu', { id: 'pdu-1', name: 'pdu-10.9.8.7', addr: '10.9.8.7', model: 'AP 10.9.8.7' }),
    row('sanswitch', { id: 'sw-4', name: 'edge-sw', addr: '10.30.0.9' }),
  ]);
  for (const q of ['10.30.0.', '10.30.0.3', '172.16.5.9', '10.9.8.7', 'pdu-10.9', 'ip:10.30']) {
    const r = await call(OPER, { q });
    assert.equal(r.body.matched, 0, `${q} 로 가린 주소의 장비가 찾아졌다`);
  }
  const ok = await call(OPER, { q: 'edge-sw' });
  assert.equal(ok.body.matched, 1, '주소가 없는 이름은 그대로 찾는다');
  const a = await call(ADMIN, { q: '10.30.0.' });
  assert.equal(a.body.matched, 3, '관리자는 주소로 찾는다');
  // 같은 등급 정렬: 가린 행은 원래 이름(=주소) 순이 아니라 색인 순 — 시리얼로 모두 걸리게 해 순서를 본다
  IDX._setIndexForTest([
    row('sanswitch', { id: 'b', name: '10.0.0.9', addr: '10.0.0.9', serials: ['ZZQ1'] }),
    row('sanswitch', { id: 'a', name: '10.0.0.1', addr: '10.0.0.1', serials: ['ZZQ2'] }),
  ]);
  const o = await call(OPER, { q: 'sn:zzq' });
  assert.deepEqual(o.body.groups[0].rows.map((x) => x.id), ['b', 'a'], '가린 행은 색인 순(주소 순 아님)');
  const ad = await call(ADMIN, { q: 'sn:zzq' });
  assert.deepEqual(ad.body.groups[0].rows.map((x) => x.id), ['a', 'b'], '관리자는 이름 순');
});

test('반증 M-2: 구분자로 채운 254자 검색어도 보통 검색어와 비슷한 시간(비율) — 시리얼 정규화는 요청당 한 번', () => {
  const rows = [];
  for (let i = 0; i < 20000; i++) rows.push(row('vm', { id: `v${i}`, name: `vm-${i}`, serials: [`SN${i}`], model: 'model x' }));
  const time = (q) => { const pq = Q.parseQuery(q); const t0 = process.hrtime.bigint(); for (let k = 0; k < 3; k++) Q.searchRows(rows, pq); return Number(process.hrtime.bigint() - t0) / 3e6; };
  time('warm');
  const normal = Math.max(1, time('zz-none-1'));
  const crafted = time('-.'.repeat(127));
  assert.ok(Q.parseQuery('-.'.repeat(127)).snNeedle === '', '구분자만이면 정규화 결과는 빈 값');
  assert.ok(crafted < normal * 8, `조작 검색어 ${crafted.toFixed(1)}ms ↔ 보통 ${normal.toFixed(1)}ms`);
  // v2.911 B2: 낱말 상한(6) — 공백으로 쪼갠 긴 검색어도 낱말 6개까지만 본다
  const words = time('- . '.repeat(63));
  assert.ok(words < normal * 12, `낱말 조작 ${words.toFixed(1)}ms ↔ 보통 ${normal.toFixed(1)}ms`);
});

test('반증 L-1 · L-3 · L-5: 서버 귀속은 서버 분석과 같은 함수 · 색인 생성은 시간 기준 양보 · 엣지 id 접두 한 번', () => {
  const src = fs.readFileSync(new URL('../src/search/inventoryIndex.js', import.meta.url), 'utf8');
  assert.match(src, /idracServerVcOf\(s, tagMap, index\)/);
  assert.match(src, /from '\.\.\/idrac\/corpAttribution\.js'/);
  assert.match(src, /createYielder\(15\)/);
  assert.match(src, /id: e\.serverId \|\|/);
  const core = fs.readFileSync(new URL('../src/routes/admin/idracCore.js', import.meta.url), 'utf8');
  assert.ok(!/export function idracServerVcOf/.test(core), '판정 본문은 corpAttribution 한 곳(idracCore 는 다시 내보내기만)');
});

test('라우트: 관리자는 전 종류 · 출처 오류 · ip: 로 스토리지 관리 주소', async () => {
  await seed();
  const { body } = await call(ADMIN, { q: 'srv-db' });
  assert.deepEqual(body.groups.map((g) => [g.kind, g.total]), [['vm', 2], ['host', 1], ['storage', 1], ['ip', 2]]);
  assert.equal(body.errors.storage, 'registryUnreadable');
  const ip = await call(ADMIN, { q: 'ip:10.20.8' });
  assert.deepEqual(ip.body.groups.map((g) => g.kind), ['storage']);
  assert.equal(ip.body.groups[0].rows[0].addr, '10.20.8.10');
});

test('라우트: 비관리자는 ip: 로 스토리지 주소가 걸리지 않고 행에도 주소가 없다', async () => {
  await seed();
  const ip = await call(OPER, { q: 'ip:10.20.8' });
  assert.equal(ip.body.matched, 0);
  const byName = await call(OPER, { q: 'unity' });
  const r = byName.body.groups.find((g) => g.kind === 'storage').rows[0];
  assert.equal(r.addr, ''); assert.equal(r.addrHidden, true);
  assert.equal(byName.body.addressHidden, true);
  assert.ok(!JSON.stringify(byName.body).includes('10.20.8.10'));
});

test('라우트: kinds 필터 · 상한 초과 검색어 · 1자', async () => {
  await seed();
  const k = await call(ADMIN, { q: 'srv-db', kinds: 'vm,bogus' });
  assert.deepEqual(k.body.groups.map((g) => g.kind), ['vm']);
  assert.equal(k.body.counts.ip, 2, '칩 개수는 필터와 무관');
  const long = await call(ADMIN, { q: 'x'.repeat(300) });
  assert.equal(long.body.tooLong, true); assert.equal(long.body.groups.length, 0);
  const one = await call(ADMIN, { q: 's' });
  assert.equal(one.body.tooShort, true); assert.equal(one.body.groups.length, 0);
});

test('라우트: sn: 부품 개수는 전체 범위 · 시리얼 조회 권한 계정에만', async () => {
  await seed();
  const a = await call(ADMIN, { q: 'sn:7hx2k' });
  assert.deepEqual(a.body.groups.map((g) => g.kind), ['host']);
  assert.equal(typeof a.body.partsMatched, 'number');
  const r = await call(RANGE, { q: 'sn:7hx2k' });
  assert.equal(r.body.partsMatched, undefined);
  assert.equal(r.body.matched, 0, '범위 밖 호스트의 시리얼로 찾아지지 않는다');
});

test('parseKinds: 아는 키만', () => {
  assert.deepEqual([...ROUTE.parseKinds('vm, host,zz')], ['vm', 'host']);
  assert.equal(ROUTE.parseKinds(''), null);
  assert.equal(ROUTE.parseKinds(['vm']), null);
});
