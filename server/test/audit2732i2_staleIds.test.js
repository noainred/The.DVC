/**
 * v2.732 점검 2회차 그룹 i2 — B5-02: 삭제된 vCenter·VM id 가 남은 설정이 **영영 저장되지 않던** 결함.
 *
 * 세 설정(현재 사용자 · VM 성능 트래킹 · VM 실시간 스파이크)의 PUT 이 본문의 id 전부를 지금 스냅샷과 대조해,
 * 그 시점엔 유효했던(=이미 저장돼 있던) id 까지 '존재하지 않는 id' 로 400 을 냈다. 화면은 그 id 를 칩으로 그리지 않아
 * 사용자가 지울 수도 없었다(vCenter 하나 삭제 · mock→live 전환 · VM 삭제만으로 저장 영구 불가).
 *
 * 규칙(리드 결정): **새로 들어온** 모르는 id 만 400. 이미 저장돼 있던 낡은 id 는 통과·보존하고 응답(GET·PUT)에
 * `staleIds` 로 밝힌다. 조용히 걸러 저장하지 않는다 — vmperf 는 대상에서 빠진 vCenter 의 DB 파일을 지우므로,
 * 스냅샷이 잠시 그 vCenter 를 갖지 않는 순간의 자동 제거는 이력 소실이다. 사용자가 **명시적으로 뺄 때만** 지운다.
 *
 * ⚠ 실제 `api` 라우터를 express 에 마운트하고 상태코드·응답·저장 파일로 본다(소스 grep 아님).
 *   CONFIG_DIR 은 config.js 가 import 시점에 굳히므로 파일 맨 위에서 고정하고 src 는 동적 import 한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'a2732i2-'));
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* 정리 실패는 결과와 무관 */ } });

const FULL = { username: 'full', role: 'admin', scope: null };
const SADM = { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-a'], regions: [], writeVcenters: [] } };

/** 지금 스냅샷 — vc-gone(삭제된 vCenter)·vc-a:vm-old(삭제된 VM)·vc-a:host-old(빠진 호스트)는 없다. */
const SNAP = {
  generatedAt: new Date().toISOString(), source: 'mock',
  vcenters: [{ id: 'vc-a', name: 'A' }, { id: 'vc-b', name: 'B' }],
  hosts: [{ id: 'vc-a:host-1', vcenterId: 'vc-a', name: 'esx-a1' }, { id: 'vc-b:host-1', vcenterId: 'vc-b', name: 'esx-b1' }],
  vms: [
    { id: 'vc-a:vm-1', vcenterId: 'vc-a', name: 'a-vm1', folder: 'F', guestOS: 'Microsoft Windows Server 2019', powerState: 'POWERED_ON' },
    { id: 'vc-b:vm-1', vcenterId: 'vc-b', name: 'b-vm1', folder: 'F', guestOS: 'Microsoft Windows Server 2019', powerState: 'POWERED_ON' },
  ],
  datastores: [], alarms: [], networks: [],
};

let _app = null;
async function app() {
  if (_app) return _app;
  const { store } = await import('../src/store.js');
  store.snapshot = SNAP;   // 수집하지 않는다 — 판정 기준(지금 목록)을 고정한다
  const { api } = await import('../src/routes/api.js');
  const a = express();
  a.use(express.json({ limit: '5mb' }));
  a.use((req, _r, n) => { req.user = req.headers['x-u'] === 'sadm' ? SADM : FULL; n(); });
  a.use('/api', api);
  _app = a;
  return a;
}

async function call(user, method, p, body) {
  const a = await app();
  const srv = await new Promise((r) => { const s = a.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api${p}`, {
      method, headers: { 'x-u': user, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 300); }
    return { s: res.status, j };
  } finally { srv.close(); }
}

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(CFG, f), 'utf8'));

/* ── 현재 사용자(curuser) ── */
test('B5-02 curuser: 이미 저장돼 있던 삭제 vCenter id 는 통과·보존하고 staleIds 로 밝힌다 · 새 유령 id 만 400', async () => {
  const { save } = await import('../src/curuser/settings.js');   // 모듈 캐시를 거쳐 심는다(파일 직접 쓰기는 캐시가 있으면 안 읽힌다)
  save({
    enabled: true,
    vcenters: {
      'vc-a': { enabled: true, folders: ['F'], includeSubfolders: true, excludeFolders: [] },
      'vc-gone': { enabled: true, folders: ['Old'], includeSubfolders: true, excludeFolders: [] },
    },
  });
  const g = await call('full', 'GET', '/tools/curuser/settings');
  assert.equal(g.s, 200);
  assert.deepEqual(g.j.staleIds, ['vc-gone'], 'GET 이 목록에 없는 저장 키를 밝힌다');
  assert.ok(g.j.settings.vcenters['vc-gone'], 'GET 은 낡은 키도 그대로 준다(화면이 지울 수 있게)');

  // ① GET 값을 그대로 PUT — 예전에는 400 '존재하지 않는 vCenter id: vc-gone'
  const p1 = await call('full', 'PUT', '/tools/curuser/settings', g.j.settings);
  assert.equal(p1.s, 200, `같은 값 저장이 거부됐다: ${JSON.stringify(p1.j)}`);
  assert.equal(p1.j.ok, true);
  assert.deepEqual(p1.j.staleIds, ['vc-gone']);
  assert.ok(readJson('curuser-settings.json').vcenters['vc-gone'], '낡은 id 는 조용히 버리지 않고 보존한다');

  // ② 새 유령 id 는 여전히 400
  const p2 = await call('full', 'PUT', '/tools/curuser/settings', { vcenters: { ...g.j.settings.vcenters, 'vc-typo': { enabled: true, folders: ['X'] } } });
  assert.equal(p2.s, 400);
  assert.match(String(p2.j.reason), /vc-typo/);
  assert.doesNotMatch(String(p2.j.reason), /vc-gone/, '거부 사유에 이미 저장돼 있던 id 를 섞지 않는다');
  assert.ok(!readJson('curuser-settings.json').vcenters['vc-typo']);

  // ③ 사람이 낡은 id 를 뺀 PUT → 파일에서 사라진다
  const { 'vc-gone': _drop, ...rest } = g.j.settings.vcenters;
  const p3 = await call('full', 'PUT', '/tools/curuser/settings', { vcenters: rest });
  assert.equal(p3.s, 200);
  assert.deepEqual(p3.j.staleIds, []);
  assert.equal(readJson('curuser-settings.json').vcenters['vc-gone'], undefined);
});

test('B5-02 curuser: 범위 계정은 범위 밖 낡은 id 를 staleIds 로 열거하지 않는다', async () => {
  // curuser 설정 모듈은 인메모리 캐시를 둔다(앞 테스트의 저장이 남아 있다) — 파일을 직접 쓰지 않고 모듈의 save 로 심는다.
  const { save } = await import('../src/curuser/settings.js');
  save({ vcenters: { 'vc-a': { enabled: true, folders: ['F'] }, 'vc-gone': { enabled: true, folders: ['Old'] } } });
  const g = await call('sadm', 'GET', '/tools/curuser/settings');
  assert.equal(g.s, 200);
  assert.deepEqual(g.j.staleIds, []);
  const p = await call('sadm', 'PUT', '/tools/curuser/settings', g.j.settings);
  assert.equal(p.s, 200);
  assert.deepEqual(p.j.staleIds, []);
  assert.ok(readJson('curuser-settings.json').vcenters['vc-gone'], '범위 밖 키는 직전 값 보존(v2.605)');
});

/* ── VM 성능 트래킹(vmperf) ── */
test('B5-02 vmperf: 같은 값 PUT 이 200 + staleIds, 낡은 vCenter 의 DB 파일은 지우지 않는다 · 사람이 뺄 때만 지운다', async () => {
  fs.writeFileSync(path.join(CFG, 'vmperf.json'), JSON.stringify({ enabled: true, retentionDays: 90, vcenterIds: ['vc-a', 'vc-gone'], trackTotal: true }));
  const { getVmperfDb, dbFileName } = await import('../src/metrics/vmperfDb.js');
  await getVmperfDb('vc-a'); await getVmperfDb('vc-gone');
  const goneFile = path.join(CFG, 'vmperf', `${dbFileName('vc-gone')}.db`);
  assert.ok(fs.existsSync(goneFile), '픽스처: 낡은 vCenter 의 DB 파일');

  const g = await call('full', 'GET', '/tools/waste/settings');
  assert.equal(g.s, 200);
  assert.deepEqual(g.j.staleIds, ['vc-gone']);

  // ① 화면이 '수집 사용' 만 바꿔 저장 — 예전에는 400 인데 화면은 '저장되었습니다' 였다
  const p1 = await call('full', 'PUT', '/tools/waste/settings', { ...g.j.settings, enabled: false });
  assert.equal(p1.s, 200, `같은 목록 저장이 거부됐다: ${JSON.stringify(p1.j)}`);
  assert.deepEqual(p1.j.staleIds, ['vc-gone']);
  assert.deepEqual(p1.j.dropped, [], '보존한 낡은 id 의 DB 를 지우지 않는다');
  assert.ok(fs.existsSync(goneFile), '④ 낡은 vCenter 의 이력 파일이 남아 있다');
  const saved = readJson('vmperf.json');
  assert.equal(saved.enabled, false, '다른 필드 변경은 실제로 저장됐다');
  assert.deepEqual(saved.vcenterIds, ['vc-a', 'vc-gone']);

  // ② 새 유령 id → 400, 파일·DB 무변경
  const p2 = await call('full', 'PUT', '/tools/waste/settings', { vcenterIds: ['vc-a', 'vc-gone', 'vc-typo'] });
  assert.equal(p2.s, 400);
  assert.match(String(p2.j.reason), /vc-typo/);
  assert.doesNotMatch(String(p2.j.reason), /vc-gone/);
  assert.deepEqual(readJson('vmperf.json').vcenterIds, ['vc-a', 'vc-gone']);

  // ③ 사람이 낡은 id 를 뺀다 → 저장에서 사라지고 그 DB 는 예전 의미대로 지운다
  const p3 = await call('full', 'PUT', '/tools/waste/settings', { vcenterIds: ['vc-a'] });
  assert.equal(p3.s, 200);
  assert.deepEqual(p3.j.staleIds, []);
  assert.ok(p3.j.dropped.includes('vc-gone'));
  assert.ok(!fs.existsSync(goneFile));
  assert.deepEqual(readJson('vmperf.json').vcenterIds, ['vc-a']);
});

/* ── VM 실시간 스파이크(vmseries) ── */
test('B5-02 vmseries: 삭제된 VM·호스트·vCenter 가 남은 targets 도 저장된다 · 새 유령만 400 · 구조로 밝힌다', async () => {
  fs.writeFileSync(path.join(CFG, 'vmseries.json'), JSON.stringify({
    enabled: false, scope: 'selected',
    targets: {
      'vc-a': { clusters: [], folders: [], hosts: ['vc-a:host-1', 'vc-a:host-old'], vms: ['vc-a:vm-1', 'vc-a:vm-old'] },
      'vc-gone': { all: true },
    },
  }));
  const g = await call('full', 'GET', '/tools/vmseries/settings');
  assert.equal(g.s, 200);
  assert.deepEqual([...g.j.staleIds].sort(), ['vc-a:host-old', 'vc-a:vm-old', 'vc-gone']);
  assert.deepEqual(g.j.staleTargets['vc-a'], { vcenter: false, hosts: ['vc-a:host-old'], vms: ['vc-a:vm-old'] });
  assert.equal(g.j.staleTargets['vc-gone'].vcenter, true);

  // ① GET 값 그대로 — 예전에는 400 '존재하지 않는 vCenter id: vc-gone' / '스냅샷에 없는 대상: vc-a:vm-old'
  const p1 = await call('full', 'PUT', '/tools/vmseries/settings', { targets: g.j.settings.targets, scope: 'selected' });
  assert.equal(p1.s, 200, `같은 값 저장이 거부됐다: ${JSON.stringify(p1.j)}`);
  assert.deepEqual([...p1.j.staleIds].sort(), ['vc-a:host-old', 'vc-a:vm-old', 'vc-gone']);
  const saved = readJson('vmseries.json').targets;
  assert.ok(saved['vc-gone'] && saved['vc-a'].vms.includes('vc-a:vm-old'), '낡은 대상은 보존');

  // ② 새 유령 VM·호스트 → 400 (이미 있던 낡은 id 는 사유에 섞지 않는다)
  const p2 = await call('full', 'PUT', '/tools/vmseries/settings', {
    targets: { ...g.j.settings.targets, 'vc-a': { ...g.j.settings.targets['vc-a'], vms: ['vc-a:vm-1', 'vc-a:vm-old', 'vc-a:vm-typo'] } },
  });
  assert.equal(p2.s, 400);
  assert.match(String(p2.j.reason), /vc-a:vm-typo/);
  assert.doesNotMatch(String(p2.j.reason), /vm-old/);
  // 낡은 id 는 '그 vCenter 아래에 있던 것' 만 통과 — 다른 vCenter 키로 옮기면 새 id 다
  const p2b = await call('full', 'PUT', '/tools/vmseries/settings', {
    targets: { 'vc-b': { clusters: [], folders: [], hosts: [], vms: ['vc-a:vm-old'] } },
  });
  assert.equal(p2b.s, 400);
  const p2c = await call('full', 'PUT', '/tools/vmseries/settings', { targets: { 'vc-typo': { all: true } } });
  assert.equal(p2c.s, 400);
  assert.match(String(p2c.j.reason), /vc-typo/);

  // ③ 사람이 뺀 낡은 대상은 저장에서 사라진다
  const p3 = await call('full', 'PUT', '/tools/vmseries/settings', {
    targets: { 'vc-a': { clusters: [], folders: [], hosts: ['vc-a:host-1'], vms: ['vc-a:vm-1'] } },
  });
  assert.equal(p3.s, 200);
  assert.deepEqual(p3.j.staleIds, []);
  assert.deepEqual(Object.keys(readJson('vmseries.json').targets), ['vc-a']);

  // 형식 오류(배열 아님)는 500 이 아니라 400 이거나 무시 — 예외로 매달리지 않는다
  const p4 = await call('full', 'PUT', '/tools/vmseries/settings', { targets: { 'vc-a': { hosts: 'vc-a:host-1' } } });
  assert.ok(p4.s === 200 || p4.s === 400, `형식이 틀린 hosts 가 ${p4.s}`);
});

test('B5-02 vmseries: 범위 계정은 범위 밖 낡은 대상을 staleIds·staleTargets 로 열거하지 않는다', async () => {
  fs.writeFileSync(path.join(CFG, 'vmseries.json'), JSON.stringify({
    enabled: false, scope: 'selected',
    targets: { 'vc-a': { clusters: [], folders: [], hosts: [], vms: ['vc-a:vm-old'] }, 'vc-gone': { all: true } },
  }));
  const g = await call('sadm', 'GET', '/tools/vmseries/settings');
  assert.equal(g.s, 200);
  assert.deepEqual(g.j.staleIds, ['vc-a:vm-old']);
  assert.equal(g.j.staleTargets['vc-gone'], undefined);
  const p = await call('sadm', 'PUT', '/tools/vmseries/settings', { targets: g.j.settings.targets });
  assert.equal(p.s, 200, JSON.stringify(p.j));
  assert.ok(readJson('vmseries.json').targets['vc-gone'], '범위 밖 낡은 키는 보존');
});
