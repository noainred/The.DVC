import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 격리된 CONFIG_DIR — 레지스트리/전력 DB가 이 디렉터리를 쓴다.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostpower-tag-'));
process.env.CONFIG_DIR = tmp;

let service, registry, db;
before(async () => {
  registry = await import('../src/idrac/registry.js');
  service = await import('../src/idrac/service.js');
  db = await (await import('../src/idrac/db.js')).getDb();
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('hostPower: 호스트명이 iDRAC 등록명과 달라도 서비스태그로 매칭', async () => {
  // iDRAC를 '짧은 이름'으로 등록(vCenter의 FQDN 호스트명과 불일치) + Dell 서비스태그 지정.
  // 실제 사례: 요약의 'iDRAC 실측'은 서비스태그로 매칭돼 값이 뜨는데,
  // 하단 전력 패널(hostPower)은 name만 봐서 '매핑된 iDRAC 없음'이 되던 불일치.
  const r = registry.addServer({
    id: 'idr-tag-1', name: 'idrac-box-1', host: '10.0.0.5', username: 'root', password: 'x',
    serviceTag: 'SVCTAG1', hostNames: ['leshdvcps02'],
  });
  assert.ok(r.ok, r.reason);
  db.insert('idr-tag-1', 412, Date.now());

  // FQDN 호스트명으로 조회, serviceTag 미동반 → name 매칭 실패(기존 동작).
  const byNameOnly = await service.hostPower('leshdvcps02.dvc.lgensol.com', { hours: 24 });
  assert.equal(byNameOnly.matched, false, 'name만으로는 불일치해야 한다');

  // serviceTag 동반 조회 → 서비스태그 폴백으로 매칭.
  const byTag = await service.hostPower('leshdvcps02.dvc.lgensol.com', { hours: 24, serviceTag: 'svctag1' });
  assert.equal(byTag.matched, true, '서비스태그로 매칭돼야 한다');
  assert.equal(byTag.matchedBy, 'serviceTag');
  assert.equal(byTag.current.watts, 412);
  assert.ok(byTag.history.length >= 1, '이력이 있어야 한다');
});

test('hostPower: 이름·서비스태그 모두 불일치면 미매핑', async () => {
  const none = await service.hostPower('unknown-host.example.com', { hours: 24, serviceTag: 'NOSUCHTAG' });
  assert.equal(none.matched, false);
});
