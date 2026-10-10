// v2.731 점검 1회차 G5b — SAN 스위치.
//   A6-05 목록(GET /tools/sanswitch, 화면 30·60초 폴링)이 스위치마다 조닝 전체(zones·aliases)·extra 상세(raslog·usedCmds·sensors…)·nsRoles 를
//         싣고 요청마다 다시 직렬화했다(데모 260대 11.4MB · 요청당 약 110ms). 목록에는 요약만, 상세는 장비 단위 라우트에 — 그리고
//         같은 내용이면 같은 응답(내용 지문 키 기억). 수집 직후 새 값이 바로 보여야 한다(낡은 기억 금지).
//   A6-07 데모 SAN 주기 수집이 장비 사이에 양보하지 않았다(86대 첫 주기 1.19초 한 덩어리) — 장비마다 매크로태스크 양보.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2731g5b-san-'));
process.env.CONFIG_DIR = DIR;
process.env.TEMP_DB_PATH = path.join(DIR, 'host-temp.db');
process.env.IDRAC_DB_PATH = path.join(DIR, 'idrac-power.db');
process.env.AUTH_ENABLED = 'false';
process.env.DATA_SOURCE = 'mock';

const express = (await import('express')).default;
const { store } = await import('../src/store.js');
const { api } = await import('../src/routes/api.js');
const sanStore = await import('../src/sanswitch/store.js');
const sanReg = await import('../src/sanswitch/registry.js');
const routeMod = await import('../src/routes/api/sanSwitch.js');

const mk = (user) => { const app = express(); app.use(express.json()); app.use((req, _r, next) => { req.user = user; next(); }); app.use('/api', api); return app; };
const start = async (app) => { const s = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); }); return { s, base: `http://127.0.0.1:${s.address().port}` }; };
const get = async (base, p, headers = {}) => { const r = await fetch(base + p, { headers }); const text = r.status === 304 ? '' : await r.text(); return { status: r.status, etag: r.headers.get('etag'), text, body: text ? JSON.parse(text) : null }; };

await store.refresh({ force: true });
const admin = await start(mk({ username: 'root', role: 'admin', scope: null }));
const oper = await start(mk({ username: 'op', role: 'operator', scope: null }));
test.after(() => { admin.s.close(); oper.s.close(); });

let first;
test('A6-05 ① 목록은 요약만 — 조닝 배열·nsRoles·extra 상세를 싣지 않는다(상세 라우트에는 그대로)', async () => {
  first = await get(admin.base, '/api/tools/sanswitch');
  assert.equal(first.status, 200, first.text.slice(0, 300));
  const devs = first.body.devices || [];
  assert.ok(devs.length >= 20, `데모 장비가 시드됐다(${devs.length}대)`);
  // 공허하지 않은지 — 전체 스냅샷(저장소)에는 상세가 있다
  const full = sanStore.getSnapshot(devs[0].id);
  assert.ok(Array.isArray(full?.zoning?.zones) && full.zoning.zones.length > 0, '전체 스냅샷에는 zone 배열이 있다');
  assert.ok(full.extra?.usedCmds && typeof full.extra.usedCmds === 'object', '전체 스냅샷에는 usedCmds 가 있다');
  assert.ok(full.extra?.raslog != null, '전체 스냅샷에는 raslog 가 있다');
  for (const d of devs) {
    const s = d.snap; if (!s) continue;
    assert.equal('nsRoles' in s, false, `${d.id} nsRoles`);
    assert.equal(s.ports?.list, undefined, 'ports.list');
    if (s.zoning) {
      assert.equal('zones' in s.zoning, false, `${d.id} zoning.zones`);
      assert.equal('aliases' in s.zoning, false, `${d.id} zoning.aliases`);
    }
    for (const k of ['raslog', 'usedCmds', 'sensors', 'isl', 'trunk', 'lsan', 'bottleneck', 'fabricMembers']) {
      assert.equal(s.extra && k in s.extra, false, `${d.id} extra.${k}`);
    }
  }
  // 목록이 쓰는 값은 저장소와 같다
  const s0 = devs[0].snap;
  assert.equal(s0.zoning.effectiveConfig, full.zoning.effectiveConfig);
  assert.equal(s0.zoning.zoneCount, full.zoning.zoneCount);
  assert.equal(s0.zoning.aliasCount, Object.keys(full.zoning.aliases || {}).length);
  for (const k of ['name', 'model', 'fabricOs', 'domainId', 'ok', 'switchState', 'collectedAt']) assert.deepEqual(s0[k], full[k], k);
  assert.deepEqual(s0.sections, full.sections);
  assert.deepEqual(s0.health, full.health);
  for (const k of ['usedPct', 'licensed', 'online', 'free', 'faulty', 'disabled', 'total']) assert.equal(s0.ports[k], full.ports[k], `ports.${k}`);
  assert.equal(s0.ports.listCount, (full.ports.list || []).length);
  assert.equal(s0.extra.switchType, full.extra.switchType);
  assert.equal(s0.extra.collectMethod, full.extra.collectMethod);
  assert.ok(first.body.detailOmitted && Array.isArray(first.body.detailOmitted.fields), '뺀 상세를 밝힌다');
  // 크기 — 예전 장비당 약 44KB(조닝 77%). 요약은 그 10분의 1 아래.
  const perDev = first.text.length / devs.length;
  assert.ok(perDev < 4500, `장비당 ${Math.round(perDev)}바이트`);
  // 상세 창 원천(/ports)에는 그대로 있다
  const ports = await get(admin.base, `/api/tools/sanswitch/devices/${devs[0].id}/ports`);
  assert.equal(ports.status, 200);
  assert.ok(ports.body.zoning.zones.length > 0 && ports.body.extra.usedCmds, '상세 라우트는 조닝·extra 전체');
});

test('A6-05 ② 목록이 쓰는 객체 값(authStopped·credFp)은 남는다', async () => {
  const id = first.body.devices[1].id;
  const cur = sanStore.getSnapshot(id);
  const stopped = { since: 1, at: 2, attempts: 3, reason: '인증 실패(401)' };
  const fp = { user: 'adm', len: 8, hash: 'ab12', space: false, empty: false, userSpace: false };
  sanStore.putSnapshot({ ...cur, ok: false, error: 'SSH 인증 실패', collectedAt: Date.now(), extra: { ...cur.extra, authStopped: stopped, credFp: fp, credFpSource: 'central' } });
  const r = await get(admin.base, '/api/tools/sanswitch');
  const s = r.body.devices.find((d) => d.id === id).snap;
  assert.deepEqual(s.extra.authStopped, stopped);
  assert.deepEqual(s.extra.credFp, fp);
  assert.equal(s.extra.credFpSource, 'central');
  assert.equal(s.ok, false);
});

test('A6-05 ③ 같은 내용이면 같은 ETag(304) · 수집되면 곧바로 새 값(낡은 기억 금지) · 역할마다 다른 판본', async () => {
  // 데모 시드의 포트 정보 적재(백필)가 끝나야 응답의 demo 상태가 멈춘다 — 그 전에는 내용이 실제로 바뀌는 중이다.
  await (await import('../src/mock/demo/sanswitch.js')).sanDemoBackfillDone();
  const a = await get(admin.base, '/api/tools/sanswitch');
  const b = await get(admin.base, '/api/tools/sanswitch');
  assert.equal(a.etag, b.etag, '내용이 같으면 같은 ETag');
  const nm = await get(admin.base, '/api/tools/sanswitch', { 'If-None-Match': a.etag });
  assert.equal(nm.status, 304, '변동 없으면 본문 없이 304');
  // 새 수집(새 스냅샷 객체) — 기억 시간 안이어도 곧바로 보여야 한다
  const id = a.body.devices[2].id;
  const cur = sanStore.getSnapshot(id);
  const t = Date.now() + 5;
  sanStore.putSnapshot({ ...cur, collectedAt: t, switchState: 'Marginal' });
  const c = await get(admin.base, '/api/tools/sanswitch');
  assert.notEqual(c.etag, a.etag, '내용이 바뀌면 ETag 도 바뀐다');
  const s = c.body.devices.find((d) => d.id === id).snap;
  assert.equal(s.collectedAt, t);
  assert.equal(s.switchState, 'Marginal');
  // 등록 정보가 바뀌어도(이름) 곧바로
  const dev = sanReg.listDevices().find((d) => d.id === id);
  sanReg.saveDevice({ ...dev, name: `${dev.name}-renamed`, password: '' });
  const d2 = await get(admin.base, '/api/tools/sanswitch');
  assert.equal(d2.body.devices.find((d) => d.id === id).name, `${dev.name}-renamed`);
  // 비-admin 은 가린 판본(관리자 판본을 기억에서 받지 않는다)
  const o = await get(oper.base, '/api/tools/sanswitch');
  assert.equal(o.status, 200);
  assert.equal(o.body.addressHidden, true);
  assert.ok(o.body.devices.every((d) => d.host === ''), '비-admin 은 관리 주소를 가린다');
  assert.ok(d2.body.devices.some((d) => d.host), '관리자는 주소를 받는다(시험이 공허하지 않다)');
  assert.notEqual(o.etag, d2.etag);
});

test('A6-05 ④ 기억 키 — 스냅샷 객체·엣지 push·등록부·역할이 바뀌면 바뀐다', () => {
  assert.equal(typeof routeMod.sanListKeyOf, 'function');
  const s1 = { deviceId: 'a', collectedAt: 1 };
  const base = { local: [s1], edge: [{ agent: 'e', deviceId: 'b', pushedAt: 10, collectedAt: 9 }], devices: [{ id: 'a' }], pending: [false], extras: [{ x: 1 }] };
  const k = routeMod.sanListKeyOf(base);
  assert.equal(routeMod.sanListKeyOf({ ...base }), k, '같은 입력이면 같은 키');
  assert.notEqual(routeMod.sanListKeyOf({ ...base, local: [{ ...s1 }] }), k, '스냅샷을 새 객체로 바꾸면(putSnapshot) 다른 키');
  assert.notEqual(routeMod.sanListKeyOf({ ...base, edge: [{ ...base.edge[0], pushedAt: 11 }] }), k, '엣지 push');
  assert.notEqual(routeMod.sanListKeyOf({ ...base, devices: [{ id: 'a', name: 'x' }] }), k, '등록부');
  assert.notEqual(routeMod.sanListKeyOf({ ...base, pending: [true] }), k, '재수집 대기');
  assert.notEqual(routeMod.sanListKeyOf({ ...base, extras: [{ x: 2 }] }), k, '폴러 상태 등');
  assert.notEqual(routeMod.sanListKeyOf({ ...base, admin: true }), k, '역할');
});

test('A6-07 데모 SAN 주기 수집은 장비마다 양보한다(setImmediate 프로브가 장비 수에 비례해 돈다)', async () => {
  const { pollSanSwitchOnce } = await import('../src/sanswitch/poller.js');
  let ticks = 0; let on = true;
  const probe = () => { ticks++; if (on) setImmediate(probe); };
  setImmediate(probe);
  const r = await pollSanSwitchOnce({ manual: true });
  on = false;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.total >= 20, `데모 장비 수집(${r.total}대)`);
  assert.equal(r.collected, r.total, '데모 장비는 전부 수집 성공');
  // 동시 4대 — 한 루프 차례에 최대 4대 조립. 양보가 없으면 프로브는 거의 돌지 않는다(예전 0~2회).
  assert.ok(ticks >= Math.floor(r.total / 4), `프로브 ${ticks}회 / 장비 ${r.total}대`);
});
