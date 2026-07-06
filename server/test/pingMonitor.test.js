import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  listTargets, addTarget, updateTarget, removeTarget, getTarget, enabledTargets, resetTargets, seedVcenterTargets,
  seedEdgeTargets, getVcPorts, setVcPorts, syncVcPortTargets,
} from '../src/ping/store.js';
import { getPingDb } from '../src/ping/db.js';
import { statusAll, seriesOf } from '../src/ping/service.js';

beforeEach(() => resetTargets());

test('addTarget: 검증(host 필수, tcp는 port, 안전문자) + 기본값', () => {
  assert.equal(addTarget({ host: '' }).ok, false);                       // host 필수
  assert.equal(addTarget({ host: 'a b;rm' }).ok, false);                 // 안전문자 위반(인젝션 방지)
  const tcp = addTarget({ kind: 'tcp', host: '10.0.0.9' });             // tcp는 port 미지정 시 443 기본
  assert.equal(tcp.ok, true);
  assert.equal(tcp.target.port, 443);
  const r = addTarget({ host: '10.0.0.1' });
  assert.equal(r.ok, true);
  assert.equal(r.target.kind, 'icmp');      // 기본 icmp
  assert.equal(r.target.name, '10.0.0.1');  // name 없으면 host
  assert.equal(r.target.enabled, true);
  const r2 = addTarget({ id: r.target.id, host: '10.0.0.2' });
  assert.equal(r2.ok, false);               // id 중복 거부
});

test('updateTarget/removeTarget/enabledTargets', () => {
  const { target } = addTarget({ name: 'DB', host: 'db.local', kind: 'tcp', port: 5432 });
  assert.equal(updateTarget(target.id, { enabled: false, baselineMs: 25 }).ok, true);
  assert.equal(getTarget(target.id).enabled, false);
  assert.equal(getTarget(target.id).baselineMs, 25);
  assert.equal(enabledTargets().length, 0);        // 비활성은 폴러 대상에서 제외
  assert.equal(listTargets().length, 1);
  assert.equal(removeTarget(target.id).ok, true);
  assert.equal(listTargets().length, 0);
  assert.equal(updateTarget(target.id, { host: 'x' }).ok, false); // 없는 대상
});

test('statusAll: baseline 대비 분류(ok/warn/crit/down)', async () => {
  const db = await getPingDb();
  const mk = (rtt, ok) => ({ target: '', ts: Date.now(), rtt, ok });
  const cases = [
    { name: 'ok', rtt: 10, ok: true, expect: 'ok' },      // baseline=20 → 10 정상
    { name: 'warn', rtt: 25, ok: true, expect: 'warn' },  // ≥20×1.2=24
    { name: 'crit', rtt: 31, ok: true, expect: 'crit' },  // ≥20×1.5=30
    { name: 'down', rtt: null, ok: false, expect: 'down' },
  ];
  const ids = [];
  for (const c of cases) {
    const { target } = addTarget({ name: c.name, host: `10.9.9.${cases.indexOf(c) + 1}`, baselineMs: 20 });
    ids.push(target.id);
    db.dropTarget(target.id);
    db.insertMany([{ target: target.id, ts: Date.now(), rtt: c.rtt, ok: c.ok }]);
  }
  const s = await statusAll();
  for (let i = 0; i < cases.length; i++) {
    const row = s.targets.find((r) => r.id === ids[i]);
    assert.equal(row.status, cases[i].expect, `${cases[i].name} 상태`);
    assert.equal(row.baseline, 20);
    assert.equal(row.baselineAuto, false);
  }
  ids.forEach((id) => db.dropTarget(id));
});

test('seedVcenterTargets: vCenter 자동 등록(TCP 443) + 멱등 + 삭제 후 부활 방지', () => {
  const vcs = [
    { id: 'vc-eu', name: '유럽 vCenter', host: 'https://vcenter-eu.corp.local:443/sdk' },
    { id: 'vc-us', name: 'US', host: '10.0.0.5' },       // 스킴 없는 IP
    { id: 'bad', name: 'x', host: '' },                  // 호스트 없음 → 대상 미생성(시드만 기록)
  ];
  const r1 = seedVcenterTargets(vcs);
  assert.equal(r1.added, 2);
  const eu = getTarget('vc_vc-eu');
  assert.equal(eu.host, 'vcenter-eu.corp.local'); // URL에서 호스트만 추출(포트/경로 제거)
  assert.equal(eu.kind, 'tcp');
  assert.equal(eu.port, 443);
  assert.equal(getTarget('vc_vc-us').host, '10.0.0.5');
  // 멱등: 다시 시드해도 추가 없음.
  assert.equal(seedVcenterTargets(vcs).added, 0);
  // 사용자가 삭제하면 재시드해도 부활하지 않음(seededVc tombstone).
  assert.equal(removeTarget('vc_vc-eu').ok, true);
  assert.equal(seedVcenterTargets(vcs).added, 0);
  assert.equal(getTarget('vc_vc-eu'), null);
  // 새 vCenter는 재시드에서 추가됨.
  assert.equal(seedVcenterTargets([...vcs, { id: 'vc-kr', name: '서울', host: 'https://10.1.1.1' }]).added, 1);
  assert.equal(getTarget('vc_vc-kr').host, '10.1.1.1');
});

test('seedEdgeTargets: 엣지 노드를 TCP 대상으로 시드(DataCenter·포트 추출) + tombstone', () => {
  const cols = [
    { id: 'DMZ1', name: 'DMZ1', url: 'http://10.0.0.11:4000', datacenter: 'DMZ' },
    { id: 'OC2a', name: 'OC2a', url: 'https://10.1.2.3', datacenter: 'Korea' },
  ];
  const r = seedEdgeTargets(cols);
  assert.equal(r.added, 2);
  const dmz = getTarget('edge_dmz1');
  assert.equal(dmz.source, 'edge');
  assert.equal(dmz.kind, 'tcp');
  assert.equal(dmz.host, '10.0.0.11');
  assert.equal(dmz.port, 4000);              // URL에서 포트 추출
  assert.equal(dmz.datacenterId, 'dmz');     // DataCenter 그룹 키(정규화)
  assert.equal(getTarget('edge_oc2a').port, 443); // https 기본 443
  assert.equal(seedEdgeTargets(cols).added, 0);   // 멱등
  // edge 대상은 기존 Ping 모니터링 목록(manual/vcenter)에 섞이지 않음.
  assert.equal(listTargets('edge').length, 2);
  assert.equal(listTargets('manual').length, 0);
  // 삭제 후 재시드해도 부활 안 함.
  assert.equal(removeTarget('edge_dmz1').ok, true);
  assert.equal(seedEdgeTargets(cols).added, 0);
});

test('setVcPorts/syncVcPortTargets: vCenter×포트 대상 재구성', () => {
  const vcs = [
    { id: 'vc-a', name: 'A', host: 'https://vca.local' },
    { id: 'vc-b', name: 'B', host: '10.9.0.2' },
  ];
  const r = setVcPorts([443, 902, 443, 70000], vcs); // 중복/범위초과 제거
  assert.equal(r.ok, true);
  assert.deepEqual(getVcPorts(), [443, 902]);
  assert.equal(listTargets('vcport').length, 4);     // 2 vCenter × 2 포트
  const t = getTarget('vcport_vc-a_902');
  assert.equal(t.host, 'vca.local');
  assert.equal(t.port, 902);
  assert.equal(t.vcenterId, 'vc-a');
  // vCenter 1개 제거 반영.
  assert.equal(syncVcPortTargets([vcs[0]]).ok, true);
  assert.equal(listTargets('vcport').length, 2);     // vc-a만 남음
  // 포트 비우면 vcport 대상 전부 제거.
  setVcPorts([], vcs);
  assert.equal(listTargets('vcport').length, 0);
});

test('seriesOf: 자동 baseline(중앙값) + 다운샘플 버킷', async () => {
  const db = await getPingDb();
  const { target } = addTarget({ name: 'auto', host: '10.9.8.1' }); // baselineMs 없음 → 자동
  db.dropTarget(target.id);
  const now = Date.now();
  // 최근 OK 샘플 중앙값 = 10 (10,10,10,10,100) → 100은 crit(≥15)로 분류돼야
  const rtts = [10, 10, 10, 10, 100];
  db.insertMany(rtts.map((v, i) => ({ target: target.id, ts: now - (rtts.length - i) * 1000, rtt: v, ok: true })));
  const r = await seriesOf(target.id, { rangeMs: 60_000, points: 60 });
  assert.equal(r.ok, true);
  assert.equal(r.baselineAuto, true);
  assert.equal(r.baseline, 10);              // 중앙값
  assert.ok(r.series.length >= 1);
  db.dropTarget(target.id);
});
