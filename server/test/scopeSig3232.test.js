/**
 * v3.23.2 — 범위 서명 공용화(`util/scopeSig.js`). dbg3231 이 `shared.js scopeKey` · `vmtrack scopeKeyOf` 두 곳을 고친 뒤 남은 같은 꼴
 *   (`[...allowed].sort().join(',')` · 무제한 'all'/'*')의 캐시 열쇠를 전부 이 함수 하나로 바꿨다.
 *   원인: 등록부(vcenter/registry.js normalize)는 id 에 쉼표 · 'all' · '*' 를 허용한다 — ['KR,Seoul'] 과 ['KR','Seoul'],
 *   scope ['all'] · ['*'] 과 무제한이 같은 열쇠가 되어 범위 계정이 다른 범위(범위 밖 법인)의 캐시를 받았다.
 *  ① scopeSig 단사 · 순서 무관 · 무제한 표식
 *  ② 쓰기 범위 열쇠(memoJson ETag = 열쇠 해시) — 조회 범위가 같고 쓰기 범위만 다른 두 계정이 같은 칸을 쓰지 않는다
 *     bm-folders · svc-inventory · bareos-backup/live · bareos-backup · bm-usage/profiles(opsKey) · backup-summary(veeam) · bm-usage/idle(gateKey)
 *  ③ 조회 범위 자체 캐시(응답 내용) — /health · /tools/disk-bad · /idrac/parts-inventory · /idrac/trend/table · /tools/svc-inventory(inventoryFor)
 *  ④ IPAM 원장 서브넷 기억(listSubnets — _ipamKey 와 같은 범위 조각)
 *  ⑤ 고른 법인 열쇠(vcenterPickKey — %2C 로 고른 쉼표 id)
 *  ⑥ 소스 스윕 — 범위를 다루는 파일에서 글자 join 으로 열쇠를 만들지 않는다 · 's:' + JSON 사본을 두지 않는다
 *  실제 라우터 핸들러를 부르는 꼴은 hubMultiScope3200 · bmFolders2995 를 본떴다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scopeSig3232-'));
Object.assign(process.env, { CONFIG_DIR: DIR, DATA_DIR: DIR, DATA_SOURCE: 'live', AUTH_ENABLED: 'true' });
const IDS = ['KR,Seoul', 'KR', 'Seoul', 'all', '*', 'US1'];
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: IDS.map((id, i) => ({ id, name: id, host: `vc${i}.corp.local`, username: 'u', password: 'p' })) }));
const closers = [];
after(async () => {
  for (const c of closers.reverse()) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* */ }
  process.once('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* 종료 중 */ } });
});
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const { scopeSig, SCOPE_SIG_ALL } = await import('../src/util/scopeSig.js');
const S = await import('../src/routes/api/shared.js');
const { store } = await import('../src/store.js');
const registry = await import('../src/idrac/registry.js');

// 실제 라우터 등록 — 핸들러(마지막 인자)만 모은다(미들웨어 게이트는 각 시험 파일이 따로 본다)
const routes = new Map();
const reg = { get: (p, ...h) => routes.set(`GET ${p}`, h.at(-1)), post() {}, put() {}, patch() {}, delete() {}, use() {} };
for (const [fn, p] of [
  ['registerBmFolders', '../src/routes/api/bmFolders.js'], ['registerSvcInventory', '../src/routes/api/svcInventory.js'],
  ['registerBareosLive', '../src/routes/api/bareosLive.js'], ['registerBareosBackup', '../src/routes/api/bareosBackup.js'],
  ['registerBmUsage', '../src/routes/api/bmUsage.js'], ['registerBackupStatus', '../src/routes/api/veeam.js'], ['registerBmIdle', '../src/routes/api/bmIdle.js'],
  ['registerDiskBad', '../src/routes/api/diskBad.js'], ['registerOverviewNsx', '../src/routes/api/overviewNsx.js'],
  ['registerIdracTrend', '../src/routes/admin/idracTrend.js'], ['registerIdracCore', '../src/routes/admin/idracCore.js'],
]) (await import(p))[fn](reg);

// 물리 서버(iDRAC 등록부 — 법인 귀속 vcenterId): KR,Seoul 1 · KR 2 · Seoul 1 · all 3 · * 0 · US1 1 — 수가 달라 섞이면 드러난다
const SRV = (n, vc) => ({ id: `s${n}`, name: `srv-${n}`, host: `https://192.0.2.${10 + n}`, username: 'root', password: 'x', serviceTag: `TAG${n}`, vcenterId: vc });
const SERVERS = [SRV(1, 'KR,Seoul'), SRV(2, 'KR'), SRV(3, 'KR'), SRV(4, 'Seoul'), SRV(5, 'all'), SRV(6, 'all'), SRV(7, 'all'), SRV(8, 'US1')];
registry.importServers(SERVERS, 'replace');
const serversIn = (scope) => SERVERS.filter((s) => !scope || scope.includes(s.vcenterId)).map((s) => s.id).sort();
// 호스트: KR,Seoul 1 · KR 2 · Seoul 3 · all 1 · * 0 · US1 1
const HOSTN = { 'KR,Seoul': 1, KR: 2, Seoul: 3, all: 1, '*': 0, US1: 1 };
const host = (vc, n) => ({ id: `${vc}:h${n}`, vcenterId: vc, name: `h${n}`, connectionState: 'CONNECTED', powerState: 'POWERED_ON' });
// VM IP: 법인마다 다른 /24 — IPAM 서브넷이 어느 법인 것인지 드러난다
const NET = { 'KR,Seoul': '10.1.1', KR: '10.2.2', Seoul: '10.3.3', all: '10.4.4', '*': '10.5.5', US1: '10.6.6' };
const vm = (vc) => ({ id: `${vc}:vm1`, vcenterId: vc, name: `vm-${Object.keys(NET).indexOf(vc)}`, host: 'h1', powerState: 'POWERED_ON', ipAddresses: [`${NET[vc]}.10`], cpuCount: 2, memMB: 4096 });
let gen = 0;
const mkSnap = () => ({ ...store.snapshot, source: 'live', initial: false, generatedAt: new Date(Date.UTC(2026, 10, 19) + (gen += 1) * 1000).toISOString(),
  vcenters: IDS.map((id) => ({ id, name: id, status: 'connected' })),
  hosts: IDS.flatMap((vc) => Array.from({ length: HOSTN[vc] }, (_, i) => host(vc, i + 1))), vms: IDS.map(vm),
  datastores: [], alarms: [], networks: [], rollups: { global: {}, sites: [] } });
const prevSnap = store.snapshot;
store.snapshot = mkSnap();
closers.push(async () => { store.snapshot = prevSnap; });

async function call(key, user, { query = {}, url } = {}) {
  const res = { statusCode: 200, headers: {}, body: undefined, headersSent: false,
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; this.headersSent = true; return this; },
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    set(k, v) { if (k && typeof k === 'object') { for (const [a, b] of Object.entries(k)) this.headers[a.toLowerCase()] = b; } else this.headers[String(k).toLowerCase()] = v; return this; },
    end() { this.headersSent = true; return this; }, send(x) { this.body = x; this.headersSent = true; return this; }, type() { return this; } };
  const p = key.replace(/^\w+ /, '');
  // originalUrl 은 두 계정이 같다(같은 URL 을 받았을 때 서로의 캐시를 받는가를 본다 — 사용자 이름을 URL 에 섞지 않는다)
  await routes.get(key)({ user, query, params: {}, body: {}, ip: '127.0.0.1', headers: {}, get: () => undefined, path: p, originalUrl: url || `/api${p}` }, res);
  return res;
}
// 조회 범위 계정(관리자 역할 — adminOnly 라우트도 핸들러까지 닿게 · 게이트는 각 라우트 시험이 본다). vcs=null 이면 무제한.
const viewer = (vcs) => ({ username: 'v', role: 'admin', scope: { vcenters: vcs || [], regions: [], writeVcenters: [] } });
// 조회 무제한 + 쓰기 범위 계정(writeVcenters 빈 배열 = 쓰기 범위 = 조회 범위 = 무제한)
const writer = (w) => ({ username: 'w', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: w } });

test('① scopeSig — 쉼표 · \'all\' · \'*\' · \'s:\' 꼴 id 를 포함해 서로 다른 집합은 서로 다른 서명 · 순서 · 중복 무관 · 무제한 표식', () => {
  const sets = [null, [], ['KR,Seoul'], ['KR', 'Seoul'], ['all'], ['*'], ['s:'], ['s:[]'], ['"'], ['a","b'], ['a', 'b'], ['KR']];
  const sigs = sets.map(scopeSig);
  assert.equal(new Set(sigs).size, sigs.length, `충돌: ${JSON.stringify(sigs)}`);
  assert.equal(scopeSig(null), SCOPE_SIG_ALL);
  assert.equal(scopeSig(undefined), SCOPE_SIG_ALL);
  for (const s of sets.slice(1)) assert.notEqual(scopeSig(s), SCOPE_SIG_ALL, `${JSON.stringify(s)} 는 무제한이 아니다`);
  assert.equal(scopeSig(new Set(['US1', 'KR'])), scopeSig(['KR', 'US1', 'KR']), 'Set · 배열 · 순서 · 중복과 무관');
  // shared.js scopeKey · SCOPE_KEY_ALL 은 같은 함수의 얇은 포장(판정 코어 하나)
  assert.equal(S.SCOPE_KEY_ALL, SCOPE_SIG_ALL);
  assert.equal(S.scopeKey(viewer(['KR,Seoul']), store.get()), scopeSig(['KR,Seoul']));
});

test('② 쓰기 범위 열쇠 — 조회 범위가 같고 쓰기 범위만 다른 두 계정은 같은 캐시 칸(ETag)을 쓰지 않는다 · 같은 집합은 같은 칸', async () => {
  const keys = ['GET /tools/bm-folders', 'GET /tools/svc-inventory', 'GET /tools/bareos-backup/live', 'GET /tools/bareos-backup',
    'GET /tools/bm-usage/profiles', 'GET /tools/backup-summary', 'GET /tools/bm-usage/idle'];
  store.snapshot = mkSnap();
  for (const k of keys) {
    const tag = async (w) => { const r = await call(k, writer(w)); assert.equal(r.statusCode, 200, `${k} ${JSON.stringify(r.body)?.slice(0, 200)}`); assert.ok(r.headers.etag, `${k}: memoJson 까지 닿아야 한다(ETag)`); return r.headers.etag; };
    assert.notEqual(await tag(['KR,Seoul']), await tag(['KR', 'Seoul']), `${k}: 쓰기 범위 ['KR,Seoul'] 과 ['KR','Seoul'] 이 같은 열쇠`);
    assert.notEqual(await tag(['all']), await tag([]), `${k}: 쓰기 범위 ['all'] 과 무제한이 같은 열쇠`);
    assert.equal(await tag(['Seoul', 'KR']), await tag(['KR', 'Seoul']), `${k}: 같은 집합은 순서와 무관하게 같은 열쇠`);
  }
});

// 조회 범위 쌍 — 앞 계정이 캐시를 채운 뒤 뒤 계정이 같은 URL 을 받는다. 뒤 계정은 제 범위 것만 받아야 한다.
const PAIRS = [[['KR,Seoul'], ['KR', 'Seoul']], [['KR', 'Seoul'], ['KR,Seoul']], [null, ['all']], [null, ['*']]];
const label = (s) => (s ? JSON.stringify(s) : '무제한');

test('③-a /health — 범위 계정의 헤더 수치(호스트 수)는 제 범위 것(healthScopedGlobal 기억)', async () => {
  for (const [a, b] of PAIRS) {
    store.snapshot = mkSnap();
    await call('GET /health', viewer(a));
    const r = await call('GET /health', viewer(b));
    const want = b.reduce((n, vc) => n + HOSTN[vc], 0);
    assert.equal(r.body.hosts, want, `${label(a)} 다음 ${label(b)}: 호스트 ${r.body.hosts} ≠ ${want}`);
  }
});

const idsOf = {
  // disk-bad 의 기억은 fleet(합계)이다 — corps 는 기억 밖에서 다시 만든다. 합계의 서버 수를 그 수만큼의 범위 서버 id 로 바꿔 같은 꼴로 비교한다.
  'GET /tools/disk-bad': (b, scope) => (Number.isFinite(b.fleet?.totals?.servers) ? serversIn(scope).slice(0, b.fleet.totals.servers).concat(Array(Math.max(0, b.fleet.totals.servers - serversIn(scope).length)).fill('(범위 밖)')) : ['(fleet 없음)']),
  'GET /idrac/parts-inventory': (b) => (b.missing || []).map((x) => x.id).sort(),
  'GET /idrac/trend/table': (b) => (b.rows || []).map((x) => x.id).sort(),
};
test('③-b 물리 서버 경로(disk-bad · parts-inventory · trend/table) — 뒤 계정은 앞 계정(다른 범위)의 캐시를 받지 않는다', async () => {
  let n = 0;
  for (const k of Object.keys(idsOf)) {
    for (const [a, b] of PAIRS) {
      store.snapshot = mkSnap();
      const url = `/api${k.replace(/^\w+ /, '')}?pair=${n += 1}`;   // 쌍마다 새 칸(parts-inventory 열쇠는 URL · 15초 — 앞 쌍의 칸을 물려받지 않게)
      const ra = await call(k, viewer(a), { url });
      assert.equal(ra.statusCode, 200, `${k} ${JSON.stringify(ra.body)?.slice(0, 200)}`);
      const rb = await call(k, viewer(b), { url });
      assert.equal(rb.statusCode, 200);
      assert.deepEqual(idsOf[k](rb.body, b), serversIn(b), `${k}: ${label(a)} 다음 ${label(b)} — 받은 서버가 제 범위와 다르다`);
    }
  }
});

test('③-c /tools/svc-inventory — 범위 계정의 법인 줄 · 미분류 물리 서버 수는 제 범위 것(inventoryFor 기억)', async () => {
  for (const [a, b] of PAIRS) {
    store.snapshot = mkSnap();
    await call('GET /tools/svc-inventory', viewer(a));
    const r = await call('GET /tools/svc-inventory', viewer(b));
    assert.equal(r.statusCode, 200);
    const corps = (r.body.corps || []).map((c) => c.vcenterId).sort();
    assert.deepEqual(corps, [...b].sort(), `${label(a)} 다음 ${label(b)}: 법인 줄`);
    const bm = (r.body.corps || []).reduce((s, c) => s + (c.unassigned?.n?.bm || 0), 0);
    assert.equal(bm, serversIn(b).length, `${label(a)} 다음 ${label(b)}: 미분류 물리 서버 ${bm}`);
  }
});

test('④ IPAM 원장 서브넷 기억(listSubnets) — 쉼표 id · \'all\' · \'*\' 범위가 다른 범위의 기억을 받지 않는다', async () => {
  const led = await import('../src/ipam/ledger.js');
  for (const [a, b] of PAIRS) {
    const snap = mkSnap();
    led.listSubnets(snap, '', a ? new Set(a) : null);
    const got = led.listSubnets(snap, '', new Set(b)).map((s) => s.subnet).sort();
    const want = b.map((vc) => `${NET[vc]}.0/24`).sort();
    assert.deepEqual(got, want, `${label(a)} 다음 ${label(b)}`);
  }
});

test('⑤ 고른 법인 열쇠 vcenterPickKey — %2C 로 고른 쉼표 id 와 두 법인 목록은 다른 열쇠', () => {
  const snap = store.get();
  const one = S.vcenterPickKey({ vcenterIds: 'KR%2CSeoul' }, snap);
  const two = S.vcenterPickKey({ vcenterIds: 'KR,Seoul' }, snap);
  assert.deepEqual([...S.vcenterPickOf({ vcenterIds: 'KR%2CSeoul' }, snap)], ['KR,Seoul'], '전제: %2C 는 쉼표 id 하나로 풀린다');
  assert.notEqual(one, two);
  assert.notEqual(S.vcenterPickKey({ vcenterId: 'KR,Seoul' }, snap), two, '단일 vcenterId 쉼표 id 도 두 법인 목록과 다르다');
});

// 범위를 다루는 파일(scopedVcenterIds · writeScopedVcenterIds · scopeSig 를 부르는 파일)에서 `.sort().join(` 은 범위 서명이 아닌 것만 —
//   아래는 범위 집합이 아님을 확인한 예외(이유를 적는다). 새 줄이 걸리면 scopeSig 로 바꾸거나, 범위가 아니면 이유와 함께 여기 올린다.
const NOT_SCOPE = new Map([
  ['routes/api/bareosPolicy.js', ['[...collecting].sort().join(\',\')']],   // 지금 정책을 수집 중인 Director id(캐시 신선도 — 범위 조각은 같은 열쇠의 scopeKey)
  ['routes/insights.js', ['`${c.id}:${c.datacenterId || \'\'}:${c.datacenter || \'\'}`).sort().join(\',\')']],   // 수집 서버 → 데이터센터 할당 서명(설정 신선도 — 범위 집합 아님)
  ['routes/admin/users.js',['[...(loadMatrix().adminDenied || [])].sort().join(\',\')', 'ADMIN_TOGGLE_KEYS.includes(k)))].sort().join(\',\')']],   // 관리자 토글 키 목록 비교(캐시 열쇠 아님)
]);
test('⑥ 소스 스윕 — 범위를 다루는 파일의 캐시 열쇠에 글자 join 이 남지 않는다 · \'s:\' + JSON 사본은 util/scopeSig.js 하나', () => {
  const hits = []; const copies = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const rel = path.relative(SRC, p).split(path.sep).join('/');
      const s = stripComments(fs.readFileSync(p, 'utf8'));
      if (rel !== 'util/scopeSig.js' && /s:\$\{JSON\.stringify\(/.test(s)) copies.push(rel);
      if (!/\b(scopedVcenterIds|writeScopedVcenterIds|scopeSig|scopeKey)\b/.test(s)) continue;
      const ok = NOT_SCOPE.get(rel) || [];
      s.split('\n').forEach((line, i) => {
        if (!/\.sort\(\)\.join\(/.test(line)) return;
        if (ok.some((frag) => line.includes(frag))) return;
        hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
    }
  };
  walk(SRC);
  assert.deepEqual(hits, [], `범위 열쇠는 util/scopeSig.js scopeSig 로:\n${hits.join('\n')}`);
  assert.deepEqual(copies, [], '범위 서명 사본');
  // 예외 목록이 낡지 않게 — 적은 줄이 실제로 있어야 한다
  for (const [rel, frags] of NOT_SCOPE) {
    const s = fs.readFileSync(path.join(SRC, rel), 'utf8');
    for (const f of frags) assert.ok(s.includes(f), `${rel}: 예외 줄이 없어졌다 — 목록에서 지울 것(${f})`);
  }
});
