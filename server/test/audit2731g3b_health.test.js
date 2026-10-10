/**
 * v2.731 점검 1회차 G3b — A2-02: iDRAC 인벤토리 하위 시스템 롤업(PSU·스토리지·GPU)이
 *   ① 상태를 못 읽은 부품을 'OK'(초록)로 ② Critical 을 'Warning'(호박색)으로 접던 결함.
 *   같은 탭의 부품 표(partState — partfault/classify.js redfishPartState)와 반대를 말했다.
 *
 * 실제 함수로 본다 — 가짜 Redfish 서버 + fetchInventory(수집 시점 롤업) / inventoryView(중앙 보기 — 30분 캐시·구버전 엣지 롤업도
 * 원소 판정으로 다시 만든다).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'g3b-health-'));
process.env.IDRAC_TIMEOUT_MS = '3000';

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createServer } = await import('node:http');
const { fetchInventory } = await import('../src/idrac/redfish.js');
const { inventoryView, statusFieldsMissing } = await import('../src/idrac/invView.js');

async function withRedfish(psus, drives, fn) {
  const CH = '/redfish/v1/Chassis/System.Embedded.1';
  const SYS = '/redfish/v1/Systems/System.Embedded.1';
  const ST = `${SYS}/Storage/RAID.1`;
  const routes = {
    '/redfish/v1/Chassis': { Members: [{ '@odata.id': CH }] },
    [`${CH}/Power`]: { PowerSupplies: psus },
    '/redfish/v1/Systems': { Members: [{ '@odata.id': SYS }] },
    [SYS]: { Id: 'System.Embedded.1', Status: { Health: 'OK' }, Storage: { '@odata.id': `${SYS}/Storage` } },
    [`${SYS}/Storage`]: { Members: [{ '@odata.id': ST }] },
    [ST]: { Id: 'RAID.1', Drives: drives.map((_, i) => ({ '@odata.id': `${ST}/Drives/D${i}` })) },
  };
  drives.forEach((d, i) => { routes[`${ST}/Drives/D${i}`] = d; });
  const srv = createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const r = routes[p];
    res.writeHead(r ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r || {}));
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    const inv = await fetchInventory({ id: 'x', host: `http://127.0.0.1:${srv.address().port}`, username: 'u', password: 'p' });
    return await fn(inv);
  } finally { await new Promise((ok) => srv.close(ok)); }
}

test('A2-02 ① 수집 시점: 상태를 못 읽은 PSU·디스크를 OK 로 접지 않는다', async () => {
  await withRedfish([{ Name: 'PS1' }, { Name: 'PS2' }], [{ Id: 'D0', Name: 'Disk0' }], (inv) => {
    assert.equal(inv.psus.length, 2);
    assert.notEqual(inv.health.psu, 'OK', '전부 못 읽은 PSU 롤업이 OK(초록)');
    assert.notEqual(inv.health.storage, 'OK', '못 읽은 디스크 롤업이 OK');
    assert.equal(inv.health.psu, '', '못 읽음은 글자를 만들지 않는다(화면은 healthParts 로 회색 확인 불가)');
    const v = inventoryView(inv);
    assert.equal(v.healthParts.psu.state, 'unknown');
    assert.deepEqual(v.healthParts.psu.counts, { ok: 0, warn: 0, fault: 0, unknown: 2, absent: 0 });
    assert.equal(v.healthParts.storage.state, 'unknown');
    // 부품 표와 같은 말을 한다
    assert.ok(v.psus.every((p) => p.partState === 'unknown'));
  });
});

test('A2-02 ② 수집 시점: Critical 이 있으면 롤업도 Critical(Warning 으로 한 단계 낮추지 않는다)', async () => {
  await withRedfish(
    [{ Name: 'PS1', Status: { Health: 'OK', State: 'Enabled' } }, { Name: 'PS2', Status: { Health: 'Critical', State: 'Enabled' } }],
    [{ Id: 'D0', Name: 'Disk0', Status: { Health: 'Critical', State: 'Enabled' }, FailurePredicted: false }],
    (inv) => {
      assert.equal(inv.health.psu, 'Critical');
      assert.equal(inv.health.storage, 'Critical');
      const v = inventoryView(inv);
      assert.equal(v.health.psu, 'Critical');
      assert.equal(v.healthParts.psu.state, 'fault');
      assert.equal(v.healthParts.psu.counts.fault, 1);
      assert.equal(v.healthParts.psu.counts.ok, 1);
    },
  );
});

test('A2-02 ③ 수집 시점: 전부 OK 면 OK · 예측 실패(OK+FailurePredicted)는 Warning', async () => {
  await withRedfish(
    [{ Name: 'PS1', Status: { Health: 'OK', State: 'Enabled' } }],
    [{ Id: 'D0', Status: { Health: 'OK', State: 'Enabled' }, FailurePredicted: true }, { Id: 'D1', Status: { Health: 'OK', State: 'Enabled' } }],
    (inv) => {
      assert.equal(inv.health.psu, 'OK');
      assert.equal(inv.health.storage, 'Warning');
    },
  );
});

test('A2-02 ④ 중앙 보기: 저장된 옛 롤업(30분 캐시·구버전 엣지)을 믿지 않고 원소 판정으로 다시 만든다', () => {
  const cached = {
    health: { overall: 'OK', processor: 'OK', memory: 'OK', storage: 'OK', psu: 'Warning', gpu: 'OK' },
    psus: [{ name: 'PS1', health: 'OK', state: 'Enabled' }, { name: 'PS2', health: 'Critical', state: 'Enabled' }],
    disks: [{ name: 'D0', health: '', state: '' }, { name: 'D1', health: 'OK', state: 'Enabled' }],
    gpus: [{ name: 'GPU0', health: '', state: '' }],
  };
  const v = inventoryView(cached);
  assert.equal(v.health.psu, 'Critical', '옛 Warning → Critical');
  assert.equal(v.health.storage, '', '못 읽은 디스크가 섞인 옛 OK → 글자 없음');
  assert.equal(v.healthParts.storage.state, 'unknown');
  assert.equal(v.health.gpu, '');
  assert.equal(v.health.overall, 'OK', '장비 원문 롤업(전체·CPU·메모리)은 그대로');
  // 원본 불변
  assert.equal(cached.health.psu, 'Warning');
  assert.equal(cached.health.storage, 'OK');
  assert.equal(cached.psus[0].partState, undefined);
});

test('A2-02 ⑤ 판정 순서 fault > warn > unknown > ok, 빈 슬롯만이면 표시하지 않는다', () => {
  const view = (psus) => inventoryView({ health: {}, psus }).healthParts.psu;
  assert.equal(view([{ health: 'Warning' }, { health: '' }]).state, 'warn', '확인한 주의는 못 읽은 것이 섞여도 말한다');
  assert.equal(view([{ health: 'Warning' }, { health: '' }]).counts.unknown, 1, '못 읽은 개수는 밝힌다');
  assert.equal(view([{ health: 'OK' }, { health: '' }]).state, 'unknown', 'OK 는 전부 읽었을 때만');
  assert.equal(view([{ health: 'OK' }, { state: 'Absent' }]).state, 'ok', '빈 슬롯은 판정에 넣지 않는다');
  assert.equal(view([{ state: 'Absent' }, { state: 'Absent' }]).state, '', '빈 슬롯뿐이면 배지 없음');
  assert.equal(view([]).state, '');
  assert.equal(view([{ health: 'Bogus' }]).state, 'unknown', '모르는 값은 unknown(classify.js 와 같다)');
  const v = inventoryView({ health: {}, psus: [{ state: 'Absent' }] });
  assert.equal(v.health.psu, '');
});

test('A2-02 ⑥ 구버전 엣지(상태 필드 없음): health 를 새로 만들지 않고 healthParts 로 확인 불가를 말한다', () => {
  const old = { psus: [{ name: 'PS1', model: 'X' }], disks: [{ name: 'D0' }] };
  assert.equal(statusFieldsMissing(old), true);
  const v = inventoryView(old);
  assert.equal(Object.hasOwn(v, 'health'), false, 'health 를 지어내지 않는다');
  assert.equal(v.healthParts.psu.state, 'unknown');
  assert.equal(statusFieldsMissing(old), true, '원본 판정 불변');
});
