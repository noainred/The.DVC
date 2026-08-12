import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 격리된 CONFIG_DIR — 레지스트리/전력 DB가 이 디렉터리를 쓴다.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostpower-tag-'));
process.env.CONFIG_DIR = tmp;

let service, registry, db, state;
before(async () => {
  registry = await import('../src/idrac/registry.js');
  service = await import('../src/idrac/service.js');
  db = await (await import('../src/idrac/db.js')).getDb();
  state = await import('../src/collector/state.js');
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

// v2.286 회귀 방지(확정 버그 #12): 원격(edge 수집) 서버를 서비스태그로 매칭할 때, 추이 그래프가
// 항상 비던 문제. 원격 전력은 DB에 'rmt:<host>' 키로 적재되는데 폴백 분기가 serverId
// ('remote:...')로 조회해 history 가 0행이었다(현재값만 인메모리 폴백으로 표시). rmt: 키로 고침.
test('hostPower: 원격 수집 서버도 서비스태그 매칭 시 추이(history)가 채워진다', async () => {
  const host = 'edge-esxi-77';
  // 원격 전력 상태 주입(collector 가 보고한 것과 동일 형태) — serviceTag 포함.
  state.setRemoteHost(host, { watts: 439, ts: Date.now(), collectorId: 'OC2', serverName: host, serviceTag: 'RMTTAG9' });
  // 시계열은 'rmt:<host>' 키로 적재된다(collector/puller.js 와 동일).
  const now = Date.now();
  db.insert(`rmt:${host}`, 430, now - 3600_000);
  db.insert(`rmt:${host}`, 439, now);

  const r = await service.hostPower('edge-esxi-77.dvc.example.com', { hours: 24, serviceTag: 'rmttag9' });
  assert.equal(r.matched, true, '서비스태그로 원격 서버가 매칭돼야 함');
  assert.equal(r.matchedBy, 'serviceTag');
  assert.equal(r.source, 'remote');
  assert.ok(r.current && r.current.watts === 439, '현재값이 떠야 함');
  assert.ok(Array.isArray(r.history) && r.history.length >= 2, '추이 그래프가 비어있지 않아야 함(rmt: 키 조회)');
});
