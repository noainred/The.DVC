// 검토 I-02(그룹 B) — 내부 GET /api/vms 의 5,000 상한 뒤를 페이지로 가져온다.
//   실제 api 라우터를 express 에 마운트해 HTTP 로 순회한다(소스 grep 아님).
//   ① 고정 스냅샷 6,001개 · 정렬 동률이 많은 열(CPU 사용률 7종 + 결측) · 동명 VM 수천 개 — 누락·중복 0
//   ② 파라미터를 안 주면 예전 응답 그대로(items 순서·limit) + 새 필드만
//   ③ 범위 계정은 어느 페이지에서도 범위 밖 VM 이 없다 · 남의 범위 커서는 409
//   ④ 페이지 사이에 스냅샷이 바뀌어도(값 변경·삭제·추가) 같은 VM 이 두 번 나오지 않고 남은 VM 은 빠짐없이 나온다
//   ⑤ 순서 기억이 사라지고 스냅샷도 바뀌면 409 cursor-stale · 스냅샷이 같으면 다시 만들어 이어 간다
//   ⑥ 커서 검증 — 형식·길이·정렬 불일치·조건 불일치·위치 위조·정렬 키 이름 → 400
//   ⑦ CSV(VM 내보내기)는 이 상한과 무관하게 전량을 싣는지 실제로 확인
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rvB-vmPaging-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';

// 기준 시각은 경계에서 떨어뜨려 고정(CLAUDE.md — Date.now() 금지)
const NOW = Date.UTC(2026, 9, 9, 3, 30, 0);

const { store } = await import('../src/store.js');
const express = (await import('express')).default;
const { api } = await import('../src/routes/api.js');
const { sortBy } = await import('../src/routes/api/shared.js');
const { VM_PINS, decodeVmCursor, encodeVmCursor, sortedRowKeys, rowKeysOf, createVmPinCache } = await import('../src/inventory/vmPaging.js');

const N = 6001;
const CPU = [5, 10, 10, 50, 90, null, 90];   // 동률이 많고 결측도 섞는다
function mkVms(n, { gen = 0, drop = new Set(), extra = 0 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const id = `vc${(i % 3) + 1}:vm-${i}`;
    if (drop.has(id)) continue;
    const vc = `vc${(i % 3) + 1}`;
    out.push({
      id, vcenterId: vc,
      // 동명 VM 이 수천 개(같은 이름 'app' — 이름 정렬의 동률)
      name: i % 4 === 0 ? 'app' : `vm-${String(i % 997).padStart(4, '0')}`,
      host: `esx-${i % 20}`,
      powerState: i % 5 === 0 ? 'POWERED_OFF' : 'POWERED_ON',
      cpuCount: (i % 8) + 1,
      // gen 이 바뀌면 사용률이 크게 바뀐다(정렬 키가 휘발성)
      cpuUsagePct: CPU[(i + gen * 3) % CPU.length],
      memUsagePct: (i * 7 + gen) % 100,
      memMB: 4096, storageGB: 20, uncommittedGB: 5, guestOS: 'Linux', ipAddress: `10.0.${i % 250}.${i % 200}`,
    });
  }
  for (let j = 0; j < extra; j++) {
    out.push({ id: `vc1:new-${j}`, vcenterId: 'vc1', name: `new-${j}`, host: 'esx-1', powerState: 'POWERED_ON', cpuCount: 2, cpuUsagePct: 99, memUsagePct: 1, memMB: 1024, storageGB: 1, uncommittedGB: 0, guestOS: 'Linux' });
  }
  return out;
}
function mkSnap(vms, at) {
  return {
    generatedAt: new Date(at).toISOString(),
    source: 'mock',
    vcenters: [
      { id: 'vc1', name: 'vc1', status: 'connected', location: { region: '아시아' } },
      { id: 'vc2', name: 'vc2', status: 'connected', location: { region: '유럽' } },
      { id: 'vc3', name: 'vc3', status: 'connected', location: { region: '북미' } },
    ],
    hosts: [], datastores: [], alarms: [], networks: [], vms, rollups: {},
  };
}

let SNAP = mkSnap(mkVms(N), NOW);
const ADMIN = { username: 'adm', role: 'admin', scope: null };
const SCOPED = { username: 'sc', role: 'admin', scope: { vcenters: ['vc1'] } };

async function withServer(fn) {
  const orig = store.get;
  store.get = () => SNAP;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = req.get('x-test-user') === 'scoped' ? SCOPED : ADMIN; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { store.get = orig; srv.close(); }
}
async function getJ(base, qs, user = 'admin') {
  const r = await fetch(`${base}/api/vms?${new URLSearchParams(qs)}`, { headers: { 'x-test-user': user } });
  return { status: r.status, body: await r.json() };
}
/** 끝까지 순회 — 페이지마다 응답을 모은다. 상한으로 무한 루프 방지. */
async function traverse(base, qs, user = 'admin', between = null) {
  const pages = [];
  let cursor = null;
  for (let k = 0; k < 50; k++) {
    const r = await getJ(base, cursor ? { ...qs, cursor } : { ...qs, paged: '1' }, user);
    assert.equal(r.status, 200, `페이지 ${k} 실패: ${JSON.stringify(r.body).slice(0, 200)}`);
    pages.push(r.body);
    if (!r.body.hasMore) break;
    assert.ok(r.body.nextCursor, 'hasMore 인데 nextCursor 가 없다');
    cursor = r.body.nextCursor;
    if (between) await between(k);
  }
  return pages;
}
const idsOf = (pages) => pages.flatMap((p) => p.items.map((v) => v.id));

test('① 6,001개 순회 — CPU 사용률 내림차순(동률·결측 다수): 누락·중복 0, 순서는 전순서', async () => {
  VM_PINS.clear();
  SNAP = mkSnap(mkVms(N), NOW);
  await withServer(async (base) => {
    for (const limit of ['1000', '5000', '777']) {
      const pages = await traverse(base, { sortBy: 'cpuUsagePct', order: 'desc', limit });
      const ids = idsOf(pages);
      assert.equal(ids.length, N, `limit ${limit}: 받은 수 ${ids.length}`);
      assert.equal(new Set(ids).size, N, `limit ${limit}: 중복 ${ids.length - new Set(ids).size}건`);
      for (const p of pages) {
        assert.equal(p.total, N, 'total 은 전체 일치 집합 기준');
        assert.equal(p.totals.count, N, 'totals 도 전체 기준');
        assert.equal(p.returned, p.items.length);
        assert.ok(p.items.length <= Number(limit));
        assert.equal(p.page.mode, 'paged');
      }
      // 순서: 숫자 내림차순 → 결측은 맨 뒤, 같은 값은 id 오름차순
      const all = pages.flatMap((p) => p.items);
      for (let i = 1; i < all.length; i++) {
        const a = all[i - 1], b = all[i];
        if (a.cpuUsagePct == null) { assert.equal(b.cpuUsagePct, null, '결측 뒤에 값이 오면 안 된다'); assert.ok(a.id < b.id); continue; }
        if (b.cpuUsagePct == null) continue;
        assert.ok(a.cpuUsagePct > b.cpuUsagePct || (a.cpuUsagePct === b.cpuUsagePct && a.id < b.id), `순서 위반 ${a.id}(${a.cpuUsagePct}) → ${b.id}(${b.cpuUsagePct})`);
      }
      assert.equal(pages.at(-1).hasMore, false);
      assert.equal(pages.at(-1).nextCursor, null);
    }
  });
});

test('①-b 동명 VM 수천 개 이름 순 · 정렬 없음(id 순) — 누락·중복 0', async () => {
  VM_PINS.clear();
  SNAP = mkSnap(mkVms(N), NOW);
  await withServer(async (base) => {
    for (const qs of [{ sortBy: 'name', order: 'asc', limit: '1000' }, { limit: '1500' }, { sortBy: 'cpuCount', order: 'asc', limit: '999' }]) {
      const ids = idsOf(await traverse(base, qs));
      assert.equal(ids.length, N, JSON.stringify(qs));
      assert.equal(new Set(ids).size, N, JSON.stringify(qs));
    }
    // 정렬 없음은 id 오름차순
    const p = await getJ(base, { paged: '1', limit: '5' });
    const sorted = SNAP.vms.map((v) => v.id).sort();
    assert.deepEqual(p.body.items.map((v) => v.id), sorted.slice(0, 5));
  });
});

test('② 파라미터를 안 주면 예전 응답 그대로 + 새 필드만(nextCursor 없음)', async () => {
  VM_PINS.clear();
  SNAP = mkSnap(mkVms(N), NOW);
  await withServer(async (base) => {
    const cases = [{}, { limit: '5000' }, { sortBy: 'cpuUsagePct', order: 'desc', limit: '1000' }, { sortBy: 'name', order: 'asc', limit: '5000' }, { q: 'app', limit: '20' }];
    for (const qs of cases) {
      const r = await getJ(base, qs);
      assert.equal(r.status, 200);
      // 예전 계산을 그대로 다시 한다(applyFilters 는 q 검색만 — 여기 조건은 그것뿐)
      let exp = SNAP.vms;
      if (qs.q) exp = exp.filter((v) => ['name', 'guestOS', 'ipAddress', 'host'].some((f) => String(v[f] ?? '').toLowerCase().includes(qs.q)));
      if (qs.sortBy) exp = sortBy(exp, qs.sortBy, qs.order);
      const lim = Math.max(1, Math.min(Number(qs.limit) || 500, 5000));
      assert.deepEqual(r.body.items.map((v) => v.id), exp.slice(0, lim).map((v) => v.id), `items 가 예전과 다르다 ${JSON.stringify(qs)}`);
      assert.equal(r.body.total, exp.length);
      assert.equal(r.body.returned, Math.min(lim, exp.length));
      assert.equal(r.body.hasMore, exp.length > lim);
      assert.equal(r.body.nextCursor, null, '예전 응답에는 커서가 없다');
      assert.equal(r.body.snapshotAt, SNAP.generatedAt);
      assert.equal(r.body.page, undefined);
    }
  });
});

test('③ 범위 계정은 어느 페이지에서도 범위 밖 VM 이 없다 · 남의 범위 커서는 409', async () => {
  VM_PINS.clear();
  SNAP = mkSnap(mkVms(N), NOW);
  await withServer(async (base) => {
    const pages = await traverse(base, { sortBy: 'cpuUsagePct', order: 'desc', limit: '500' }, 'scoped');
    const items = pages.flatMap((p) => p.items);
    const inScope = SNAP.vms.filter((v) => v.vcenterId === 'vc1').length;
    assert.ok(items.every((v) => v.vcenterId === 'vc1'), '범위 밖 VM 이 나왔다');
    assert.equal(items.length, inScope);
    assert.equal(new Set(items.map((v) => v.id)).size, inScope);
    assert.ok(pages.every((p) => p.total === inScope), 'total 도 범위 기준');
    // 범위 계정이 요청 필터로 범위 밖을 고르면 0개(applyFilters 가 먼저 강제)
    const r = await getJ(base, { paged: '1', vcenterId: 'vc2' }, 'scoped');
    assert.equal(r.body.total, 0);
    // 전체 범위 계정의 커서를 범위 계정이 쓰면 — 순서·대상이 다른 목록이라 409(처음부터)
    const adm = await getJ(base, { paged: '1', sortBy: 'cpuUsagePct', order: 'desc', limit: '100' });
    const stolen = await getJ(base, { sortBy: 'cpuUsagePct', order: 'desc', limit: '100', cursor: adm.body.nextCursor }, 'scoped');
    assert.equal(stolen.status, 409);
    assert.equal(stolen.body.reason, 'cursor-stale');
    // 같은 URL 이라도 범위가 다르면 캐시가 섞이지 않는다(memoJson extraKey = scopeKey)
    const a = await getJ(base, { paged: '1', limit: '10' });
    const s = await getJ(base, { paged: '1', limit: '10' }, 'scoped');
    assert.equal(a.body.total, N);
    assert.equal(s.body.total, inScope);
  });
});

test('④ 페이지 사이에 스냅샷이 바뀌어도 같은 VM 이 두 번 나오지 않고, 남은 VM 은 빠짐없이 나온다', async () => {
  VM_PINS.clear();
  SNAP = mkSnap(mkVms(N), NOW);
  const orig = new Set(SNAP.vms.map((v) => v.id));
  await withServer(async (base) => {
    const qs = { sortBy: 'cpuUsagePct', order: 'desc', limit: '1000' };
    const first = await getJ(base, { ...qs, paged: '1' });
    const firstAt = first.body.snapshotAt;
    const seenFirst = first.body.items.map((v) => v.id);
    // 첫 페이지에 나온 것 중 일부와 아직 안 나온 것 중 일부를 지우고, 사용률을 전부 흔들고, 새 VM 을 더한다
    const drop = new Set([...seenFirst.slice(0, 30), ...[...orig].filter((id) => !seenFirst.includes(id)).slice(0, 40)]);
    let gen = 0;
    const pages = [first.body];
    let cursor = first.body.nextCursor;
    while (cursor) {
      gen += 1;
      SNAP = mkSnap(mkVms(N, { gen, drop, extra: 25 }), NOW + gen * 30_000);   // 스냅샷마다 바뀐다
      const r = await getJ(base, { ...qs, cursor });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      pages.push(r.body);
      assert.equal(r.body.page.orderAsOf, firstAt, '순서는 첫 페이지 시점 것');
      assert.equal(r.body.snapshotAt, SNAP.generatedAt, '값은 지금 스냅샷 것');
      cursor = r.body.nextCursor;
    }
    const ids = idsOf(pages);
    assert.equal(new Set(ids).size, ids.length, `중복 ${ids.length - new Set(ids).size}건`);
    // 첫 페이지 뒤 남아야 할 것 = 원래 집합 − 첫 페이지 − 지운 것
    const expectRest = [...orig].filter((id) => !seenFirst.includes(id) && !drop.has(id));
    const gotRest = new Set(ids.slice(seenFirst.length));
    assert.equal(gotRest.size, expectRest.length);
    for (const id of expectRest) assert.ok(gotRest.has(id), `누락 ${id}`);
    assert.ok(!ids.some((id) => id.startsWith('vc1:new-')), '순회 중 새로 생긴 VM 은 이 순회에 넣지 않는다');
    assert.equal(pages.slice(1).reduce((a, p) => a + p.page.vanished, 0), 40, '건너뛴(사라진) 개수를 밝힌다');
    assert.equal(pages.at(-1).page.added, 25, '새로 생긴 개수를 밝힌다');
    assert.equal(pages.at(-1).total, N - drop.size + 25, 'total 은 지금 스냅샷 기준');
  });
});

test('⑤ 순서 기억이 사라지면: 스냅샷이 바뀌었으면 409, 같으면 다시 만들어 같은 결과', async () => {
  VM_PINS.clear();
  SNAP = mkSnap(mkVms(N), NOW);
  await withServer(async (base) => {
    const qs = { sortBy: 'cpuUsagePct', order: 'desc', limit: '2000' };
    const p1 = await getJ(base, { ...qs, paged: '1' });
    const p2 = await getJ(base, { ...qs, cursor: p1.body.nextCursor });
    VM_PINS.clear();
    // 같은 스냅샷 — 결정적으로 다시 만든다(x=1: 같은 URL 의 응답 캐시를 피해 실제로 다시 계산하게 한다)
    const again = await getJ(base, { ...qs, cursor: p1.body.nextCursor, x: '1' });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.items.map((v) => v.id), p2.body.items.map((v) => v.id));
    VM_PINS.clear();
    SNAP = mkSnap(mkVms(N, { gen: 1 }), NOW + 30_000);
    const stale = await getJ(base, { ...qs, cursor: p2.body.nextCursor });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.reason, 'cursor-stale');
    assert.equal(stale.body.why, 'order-expired');
  });
});

test('⑥ 커서 검증 — 형식·길이·정렬·조건·위치 위조·정렬 키 이름', async () => {
  VM_PINS.clear();
  SNAP = mkSnap(mkVms(N), NOW);
  await withServer(async (base) => {
    const qs = { sortBy: 'cpuUsagePct', order: 'desc', limit: '1000' };
    const p1 = await getJ(base, { ...qs, paged: '1' });
    const good = p1.body.nextCursor;
    const bad = async (q, code, status = 400) => {
      const r = await getJ(base, q);
      assert.equal(r.status, status, `${JSON.stringify(q).slice(0, 120)} → ${r.status}`);
      assert.equal(r.body.reason, code);
    };
    await bad({ ...qs, cursor: '!!!' }, 'cursor-invalid');
    await bad({ ...qs, cursor: 'a'.repeat(600) }, 'cursor-invalid');
    await bad({ ...qs, cursor: Buffer.from('{"v":1}').toString('base64url') }, 'cursor-invalid');
    await bad({ ...qs, cursor: Buffer.from('not json').toString('base64url') }, 'cursor-invalid');
    await bad({ ...qs, cursor: Buffer.from('[1,2]').toString('base64url') }, 'cursor-invalid');
    const c = decodeVmCursor(good).cursor;
    await bad({ ...qs, cursor: encodeVmCursor({ ...c, p: N + 5 }) }, 'cursor-invalid');                // 위치 위조
    await bad({ ...qs, cursor: encodeVmCursor({ ...c, p: -1 }) }, 'cursor-invalid');
    await bad({ ...qs, cursor: Buffer.from(JSON.stringify({ ...c, v: 1, x: 1 })).toString('base64url') }, 'cursor-invalid'); // 모르는 키
    await bad({ sortBy: 'name', order: 'asc', limit: '1000', cursor: good }, 'cursor-sort-mismatch');
    await bad({ ...qs, order: 'asc', cursor: good }, 'cursor-sort-mismatch');
    await bad({ ...qs, powerState: 'POWERED_ON', cursor: good }, 'cursor-query-mismatch');
    await bad({ paged: '1', sortBy: '__proto__' }, 'bad-sort');
    await bad({ paged: '1', sortBy: 'a b' }, 'bad-sort');
    // limit 은 페이지 크기만 바꾼다 — 같은 커서로 다른 크기 OK
    const r = await getJ(base, { ...qs, limit: '10', cursor: good });
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 10);
    assert.equal(r.body.page.start, 1000);
  });
});

test('⑥-b 순수 — 같은 id 가 두 번 와도 한쪽이 사라지지 않는다 · 순서 기억 상한', () => {
  const vms = [{ id: 'x', name: 'b' }, { id: 'x', name: 'a' }, { id: 'y', name: 'a' }];
  const keys = rowKeysOf(vms);
  assert.equal(new Set(keys).size, 3);
  const order = sortedRowKeys(vms, keys, { by: 'name', order: 'asc' });
  assert.equal(order.length, 3);
  let t = 0;
  const pins = createVmPinCache({ maxPins: 2, maxKeys: 10, idleMs: 1000, now: () => t });
  pins.set('a', ['1', '2']); pins.set('b', ['3']); pins.set('c', ['4']);
  assert.equal(pins.has('a'), false, '개수 상한 — 가장 오래 안 쓴 것부터');
  assert.ok(pins.has('b') && pins.has('c'));
  pins.get('b'); pins.set('d', ['5']);
  assert.ok(pins.has('b'), '최근에 쓴 것은 남는다');
  assert.equal(pins.has('c'), false);
  pins.set('big', Array.from({ length: 9 }, (_, i) => String(i)));
  assert.ok(pins.stats().keys <= 10, '키 합계 상한');
  t = 5000;
  assert.equal(pins.get('big'), null, '유휴 만료');
});

test('⑦ CSV(VM 내보내기)는 이 상한과 무관하게 그 vCenter 의 VM 전량을 싣는다(확인)', async () => {
  // 한 vCenter 에 6,001대 — /tools/vm-export.csv 는 /vms 를 쓰지 않는다(buildVmExport 가 스냅샷을 직접 읽는다).
  const vms = mkVms(N).map((v) => ({ ...v, vcenterId: 'vc1', id: `vc1:${v.id.split(':')[1]}` }));
  SNAP = mkSnap(vms, NOW + 7 * 30_000);
  await withServer(async (base) => {
    const r = await fetch(`${base}/api/tools/vm-export.csv?vcenterId=vc1`);
    assert.equal(r.status, 200);
    const text = await r.text();
    const lines = text.replace(/^﻿/, '').split('\r\n').filter((l) => l !== '');
    assert.equal(lines.length, N + 1, `머리줄 + ${N}행이어야 한다(실제 ${lines.length - 1}행)`);
    const preview = await (await fetch(`${base}/api/tools/vm-export?vcenterId=vc1`)).json();
    assert.equal(preview.total, N, '미리보기는 100행이지만 total 은 전량');
  });
});
