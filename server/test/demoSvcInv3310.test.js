/**
 * v3.31.0 — 데모(mock) 보강(사용자 요청 2026-11-20 "IP 관리 충돌·중복 목업 데이터도 고쳐줘 · 서비스 인벤토리 목업 데이터 만들어줘, 중요한 기능이야").
 * 선택: 충돌·중복은 '시연용 몇 건만' · vCenter 없는 데이터센터 베어메탈은 '인근 vCenter 법인에 귀속' · 표준 검증.
 *
 * 고정하는 것
 *  ① 목 VM IP — 사이트 VM 이 253대를 넘어도 주 IP 가 겹치지 않고, 보조 IP(172.16~19 · 192.168)에 사이트 옥텟이 들어가 vCenter 끼리 겹치지 않는다.
 *     겹치는 주소는 일부러 만든 시연용 몇 건(다른 vCenter 와 겹침 · 같은 vCenter 안 겹침)뿐이다.
 *  ② 서비스 인벤토리 데모 — 빈 저장소에만 · mock 에서만 · 한 번. 전역 15 · 법인 20 · 태그 카테고리 · 고정.
 *  ③ 제품 판정 코어(resolve.js autoResolve)로 돌리면 베어메탈 548대(귀속 있는 전부)가 이름 규칙으로 정해지고 규칙 겹침(ruleOverlap)이 0,
 *     VM 은 'Discovered virtual machine' 폴더의 Owner-Team 태그 없는 것만 미지정으로 남는다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-svcinv-3310-'));
process.env.CONFIG_DIR = TMP;
process.env.DB_DIR = TMP;
process.env.DATA_SOURCE = 'mock';
delete process.env.MOCK_SCALE;

const gen = await import('../src/mock/generator.js');
const idracDemo = await import('../src/mock/demo/idrac.js');
const demo = await import('../src/mock/demo/svcinv.js');
const store = await import('../src/servicemap/store.js');
const { buildIndex, autoResolve } = await import('../src/servicemap/resolve.js');
const { vmKeyOf } = await import('../src/routes/api/svcInventory.js');
const { setDataSource } = await import('../src/runtime-settings.js');

const SNAP = gen.generateSnapshot();
const lc = (s) => String(s || '').toLowerCase();

test('① 목 IP — 겹치는 주소는 시연용 몇 건뿐(충돌 · 중복)', () => {
  const byIp = new Map();
  const add = (ip, vc, who) => { if (!ip) return; if (!byIp.has(ip)) byIp.set(ip, []); byIp.get(ip).push({ vc, who }); };
  for (const v of SNAP.vms) for (const ip of (v.ipAddresses?.length ? v.ipAddresses : (v.ipAddress ? [v.ipAddress] : []))) add(ip, v.vcenterId, v.name);
  for (const h of SNAP.hosts) for (const k of h.vmks || []) add(k.ip, h.vcenterId, `${h.name}/${k.dev}`);
  const dup = [...byIp].filter(([, l]) => l.length > 1);
  const conflict = dup.filter(([, l]) => new Set(l.map((x) => x.vc)).size > 1);
  const inVc = dup.filter(([, l]) => new Set(l.map((x) => x.vc)).size === 1);
  // 각 5건을 만들고, 대상 VM 이 꺼져 있으면 빠진다(전원 상태는 결정적) — 예전 규모에서는 충돌 2,720 · 중복 270(IP 관리 화면)
  assert.ok(conflict.length >= 2 && conflict.length <= 5, `다른 vCenter 와 겹침 ${conflict.length}`);
  assert.ok(inVc.length >= 2 && inVc.length <= 5, `같은 vCenter 안 겹침 ${inVc.length}`);
  assert.ok(byIp.size > 8_000, `주소 ${byIp.size}개`);
  // 일부러 만든 것 말고는 겹치지 않는다 — 겹친 주소에는 반드시 시연 VM(순번 42 · 77 → 이름 0043 · 0078)이 끼어 있다
  for (const [ip, l] of dup) assert.ok(l.some((x) => /-00(43|78)$/.test(x.who)), `의도하지 않은 겹침 ${ip}: ${l.map((x) => x.who).join(', ')}`);
});

test('② 서비스 인벤토리 데모 — live 면 하지 않고, mock + 빈 저장소에 한 번만 넣는다', () => {
  assert.equal(setDataSource('live').ok, true);
  try {
    demo._resetSvcInvDemoForTest();
    assert.equal(demo.ensureSvcInvDemo(SNAP, { vmKeyOf }), null);
    assert.equal(Object.keys(store.peekMap().corps).length, 0, 'live 에서는 넣지 않는다');
  } finally { setDataSource('mock'); }
  demo._resetSvcInvDemoForTest();
  assert.equal(demo.ensureSvcInvDemo(SNAP, {}), null, 'vmKeyOf 없이는 하지 않는다(키 규칙을 복제하지 않는다)');
  const r = demo.ensureSvcInvDemo(SNAP, { vmKeyOf });
  assert.equal(r.seeded, true);
  const map = store.peekMap();
  assert.equal(Object.keys(map.corps).length, 20);
  assert.equal(map.globals.length, 15);
  assert.equal(map.settings.tagCategory, demo.DEMO_TAG_CATEGORY);
  for (const [vc, c] of Object.entries(map.corps)) {
    assert.ok(c.services.every((s) => map.globals.some((g) => g.id === s.globalId)), `${vc} 서비스는 전역에 묶인다`);
    assert.ok(c.folderRules.length >= 8 && c.tagEnabled, `${vc} 폴더 규칙 · 태그`);
    assert.ok(c.nameRules.length >= 3, `${vc} 이름 규칙 ${c.nameRules.length}`);
  }
  const pins = store.peekPins();
  assert.equal(Object.keys(pins).length, r.pins);
  assert.ok(r.pins >= 12, `고정 ${r.pins}`);
  assert.ok(Object.entries(pins).every(([k, p]) => k.startsWith(`iu:${p.corp}:`)), '고정 키 = 라우트의 VM 키 규칙');
  assert.ok(Object.values(pins).some((p) => p.reviewed && p.reviewedAuto), "'고정 유지' 예");
  // 두 번째는 하지 않는다 · 사람이 만든 트리가 있으면 하지 않는다
  assert.equal(demo.ensureSvcInvDemo(SNAP, { vmKeyOf }).seeded, true, '같은 프로세스에서는 처음 결과');
  demo._resetSvcInvDemoForTest();
  assert.equal(demo.ensureSvcInvDemo(SNAP, { vmKeyOf }).skipped, 'not-empty');
});

test('③ 제품 판정 코어로 — 베어메탈은 전부 이름 규칙(겹침 0), VM 은 Discovered 의 태그 없는 것만 미지정', () => {
  const map = store.peekMap();
  const idx = buildIndex(map);
  const ctx = { tagCategory: map.settings.tagCategory };
  const specs = idracDemo.demoBareMetalSpecs(SNAP).filter((s) => s.vcenterId);
  assert.equal(specs.length, 548, '귀속 없는 앱 서버 2대를 뺀 전부(vCenter 없는 데이터센터 240대 포함 — 인근 vCenter)');
  const svcGlobal = new Map(Object.values(map.corps).flatMap((c) => c.services.map((s) => [s.id, s.globalId])));
  const bmMiss = []; const overlap = [];
  for (const s of specs) {
    const r = autoResolve({ key: `st:${lc(s.serviceTag)}`, kind: 'bm', corp: s.vcenterId, name: s.name }, idx, ctx);
    if (r.src !== 'rule' || !r.serviceId) bmMiss.push(s.name);
    if (r.ruleOverlap) overlap.push(s.name);
  }
  assert.deepEqual(bmMiss, [], '베어메탈 미지정 0');
  assert.deepEqual(overlap, [], '이름 규칙 겹침 0(겹치면 검토 큐가 쌓인다)');
  // 역할 → 서비스 대표 점검
  const one = (name) => svcGlobal.get(autoResolve({ key: 'x', kind: 'bm', corp: specs.find((s) => s.name === name).vcenterId, name }, idx, ctx).serviceId);
  assert.equal(one('bm-ulsan-mesdb01'), 'g_demo_mes');
  assert.equal(one('bm-daejeon-aigpu01'), 'g_demo_ai');
  assert.equal(one('bm-daejeon-login01'), 'g_demo_hpc');

  const tagInv = new Map(SNAP.vcenters.map((v) => [v.id, v.tagInv]));
  const teamTags = (vm) => {
    const inv = tagInv.get(vm.vcenterId);
    return (inv?.vmTags?.[vm.name] || []).map((i) => inv.tags[i]).filter((t) => inv.categories[t.cat]?.name === demo.DEMO_TAG_CATEGORY).map((t) => t.name);
  };
  let none = 0; let wrong = 0;
  for (const vm of SNAP.vms.filter((v) => !v.template)) {
    const r = autoResolve({ key: vmKeyOf(vm).key, kind: 'vm', corp: vm.vcenterId, name: vm.name, folderPath: vm.folderPath, tags: teamTags(vm) }, idx, ctx);
    if (!r.serviceId) { none += 1; if (vm.folderPath !== '/Discovered virtual machine' || teamTags(vm).length) wrong += 1; }
  }
  assert.equal(wrong, 0, '미지정은 Discovered 폴더의 태그 없는 VM 뿐');
  assert.ok(none > 20 && none < 200, `VM 미지정 ${none}(미지정 큐 시연)`);
});
