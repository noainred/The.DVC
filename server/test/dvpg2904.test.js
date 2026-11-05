/**
 * test/dvpg2904.test.js — v2.904 분산 포트그룹 팀 구성 · LACP · VLAN(vcinfo 종류 'dvpg' — 사용자 선택 'vDS 팀 구성 수집').
 *  ① 파서: VMwareDVSPortSetting 의 <inherited>/<value> 감싸기 · 업링크 순서 · rollingOrder → failback · VLAN ID · 트렁크 · PVLAN · 옛 lacpPolicy
 *  ② 포트그룹 행: 업링크 포트그룹(tag SYSTEM/DVS.UPLINKPG) · vDS moref · LAG(Enhanced LACP)가 활성 업링크에 있으면 LACP = 그 LAG
 *  ③ 엣지 정제: 아는 정책 · 업링크 이름 형식 · VLAN 범위 · 상한 · sanitizeVcInfo 가 dvpg 를 받는다(모르는 키는 버린다)
 *  ④ 수집: 받은 포트그룹 moref 만 · LAG 를 못 읽으면 이름만 다시 읽는다(lagError) · moref 를 받지 않으면 이 종류를 건드리지 않는다
 *  ⑤ 라우트 종류 · 권한(inv.hosts) · 상한 · 데모 · 선형(비율)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SETTING = (o = {}) => `<blocked><inherited>true</inherited><value>false</value></blocked>${o.vlan ?? '<vlan xsi:type="VmwareDistributedVirtualSwitchVlanIdSpec"><inherited>false</inherited><vlanId>120</vlanId></vlan>'}
<uplinkTeamingPolicy><inherited>false</inherited><policy><inherited>false</inherited><value>${o.policy ?? 'loadbalance_loadbased'}</value></policy>
<reversePolicy><inherited>true</inherited><value>true</value></reversePolicy><notifySwitches><inherited>true</inherited><value>true</value></notifySwitches>
<rollingOrder><inherited>true</inherited><value>${o.rolling ?? 'false'}</value></rollingOrder>
<failureCriteria><inherited>true</inherited><checkSpeed><inherited>true</inherited><value>minimum</value></checkSpeed></failureCriteria>
<uplinkPortOrder><inherited>false</inherited>${(o.active ?? ['Uplink 1', 'Uplink 2']).map((u) => `<activeUplinkPort>${u}</activeUplinkPort>`).join('')}${(o.standby ?? []).map((u) => `<standbyUplinkPort>${u}</standbyUplinkPort>`).join('')}</uplinkPortOrder></uplinkTeamingPolicy>
<securityPolicy><inherited>true</inherited><allowPromiscuous><inherited>true</inherited><value>false</value></allowPromiscuous></securityPolicy>
${o.lacp ?? '<lacpPolicy><inherited>true</inherited><enable><inherited>true</inherited><value>false</value></enable><mode><inherited>true</inherited><value>passive</value></mode></lacpPolicy>'}`;

test('① 파서 — 상속 감싸기 · 업링크 순서 · failback · VLAN · 트렁크 · PVLAN · 옛 LACP', async () => {
  const P = await import('../src/vcinfo/parse.js');
  const a = P.parseDvPortSetting(SETTING());
  assert.deepEqual(a.vlan, { id: 120, trunk: null, pvlan: null });
  assert.deepEqual(a.teaming, { policy: 'loadbalance_loadbased', active: ['Uplink 1', 'Uplink 2'], standby: [], failback: true });
  assert.deepEqual(a.lacpLegacy, { enabled: false, mode: 'passive' });
  const b = P.parseDvPortSetting(SETTING({ policy: 'failover_explicit', rolling: 'true', active: ['Uplink 1'], standby: ['Uplink 2'],
    vlan: '<vlan xsi:type="VmwareDistributedVirtualSwitchTrunkVlanSpec"><inherited>false</inherited><vlanId><start>100</start><end>199</end></vlanId><vlanId><start>300</start><end>300</end></vlanId></vlan>',
    lacp: '<lacpPolicy><inherited>false</inherited><enable><inherited>false</inherited><value>true</value></enable><mode><inherited>false</inherited><value>active</value></mode></lacpPolicy>' }));
  assert.deepEqual(b.vlan, { id: null, trunk: [[100, 199], [300, 300]], pvlan: null });
  assert.deepEqual([b.teaming.policy, b.teaming.standby, b.teaming.failback], ['failover_explicit', ['Uplink 2'], false], 'rollingOrder=true → 되돌리지 않음');
  assert.deepEqual(b.lacpLegacy, { enabled: true, mode: 'active' });
  const c = P.parseDvPortSetting(SETTING({ vlan: '<vlan xsi:type="VmwareDistributedVirtualSwitchPvlanSpec"><inherited>false</inherited><pvlanId>12</pvlanId></vlan>', policy: 'weird', lacp: '' }));
  assert.deepEqual(c.vlan, { id: null, trunk: null, pvlan: 12 });
  assert.equal(c.teaming.policy, null, '모르는 정책은 null(지어내지 않는다)');
  assert.equal(c.lacpLegacy, null, 'lacpPolicy 가 없으면 모름');
  assert.deepEqual(P.parseDvPortSetting(''), { vlan: null, teaming: null, lacpLegacy: null });
  assert.deepEqual(P.parseDvPortSetting(undefined), { vlan: null, teaming: null, lacpLegacy: null });
});

test('② 포트그룹 행 — 업링크 포트그룹 · vDS · LAG(Enhanced LACP)', async () => {
  const P = await import('../src/vcinfo/parse.js');
  const rows = P.parseDvPortgroups([
    { ref: 'dvportgroup-31', props: { name: 'PG-App', tag: '', 'config.distributedVirtualSwitch': 'dvs-21', 'config.defaultPortConfig': SETTING({ policy: 'loadbalance_ip', active: ['lag1'] }) } },
    { ref: 'dvportgroup-30', props: { name: 'DS-Prod-DVUplinks-20', tag: '<Tag><key>SYSTEM/DVS.UPLINKPG</key></Tag>', 'config.distributedVirtualSwitch': 'dvs-21', 'config.defaultPortConfig': SETTING() } },
    { ref: 'bad ref', props: { name: 'x' } },
  ]);
  assert.deepEqual(rows.map((r) => [r.name, r.uplinkPg, r.dvs]), [['DS-Prod-DVUplinks-20', true, 'dvs-21'], ['PG-App', false, 'dvs-21']]);
  const lags = P.parseLacpGroups('<VMwareDvsLacpGroupConfig><key>1</key><name>lag1</name><mode>active</mode><uplinkNum>2</uplinkNum></VMwareDvsLacpGroupConfig>');
  assert.deepEqual(lags, [{ name: 'lag1', mode: 'active' }]);
  const out = P.applyDvsInfo(rows, new Map([['dvs-21', 'DS-Prod']]), new Map([['dvs-21', lags]]));
  const app = out.find((r) => r.name === 'PG-App');
  assert.equal(app.dvsName, 'DS-Prod');
  assert.deepEqual(app.lacp, { enabled: true, mode: 'active', lag: 'lag1' }, '활성 업링크가 LAG 면 LACP = 그 LAG');
  // LAG 를 못 읽었으면(null) 포트그룹 자체 설정만
  const noLag = P.applyDvsInfo(rows, new Map(), new Map()).find((r) => r.name === 'PG-App');
  assert.deepEqual([noLag.dvsName, noLag.lacp], [null, { enabled: false, mode: 'passive', lag: null }]);
});

test('③ 엣지 정제 — 아는 정책 · 업링크 이름 형식 · VLAN 범위 · 상한 · 모르는 키', async () => {
  const P = await import('../src/vcinfo/parse.js');
  const v = P.sanitizeVcInfo({ dvpg: { at: 5, items: [
    { ref: 'dvportgroup-1', name: 'pg', dvs: 'dvs-1', dvsName: 'DS', uplinkPg: false, vlan: { id: 5000, trunk: [[1, 2], [9, 3], 'x'], pvlan: '7' },
      teaming: { policy: 'evil', active: ['Uplink 1', '<script>', 3], standby: 'x', failback: 'yes' }, lacp: { enabled: true, mode: 'aggressive', lag: 'lag 1' }, extra: { a: 1 } },
    { ref: 'not a ref' },
  ], lagError: 'x'.repeat(500) }, unknownKind: { a: 1 } });
  assert.equal(Object.hasOwn(v, 'unknownKind'), false);
  const it = v.dvpg.items;
  assert.equal(it.length, 1);
  assert.deepEqual(it[0], { ref: 'dvportgroup-1', name: 'pg', dvs: 'dvs-1', dvsName: 'DS', uplinkPg: false, vlan: { id: null, trunk: [[1, 2]], pvlan: null },
    teaming: { policy: null, active: ['Uplink 1'], standby: [], failback: null }, lacp: { enabled: true, mode: null, lag: 'lag 1' } });
  assert.equal(v.dvpg.lagError.length, 300);
  const many = P.sanitizeDvpg({ items: Array.from({ length: P.DVPG_MAX + 5 }, (_, i) => ({ ref: `dvportgroup-${i}` })) });
  assert.equal(many.items.length, P.DVPG_MAX);
});

test('④ 수집 — 받은 포트그룹 moref 만 · LAG 실패면 이름만 다시 · moref 를 받지 않으면 건드리지 않는다', async () => {
  const C = await import('../src/vcinfo/collect.js');
  C._resetVcInfo();
  const calls = [];
  const c = { sc: {}, retrieveObjectProps: async () => { throw new Error('skip'); }, callRaw: async () => { throw new Error('skip'); },
    retrieveManyObjectProps: async (type, refs, paths) => {
      calls.push([type, refs.join(','), paths.join(',')]);
      if (type === 'DistributedVirtualPortgroup') return refs.map((r) => ({ type, ref: r, props: { name: `PG-${r}`, tag: '', 'config.distributedVirtualSwitch': 'dvs-21', 'config.defaultPortConfig': SETTING() } }));
      if (paths.includes('config.lacpGroupConfig')) throw new Error('InvalidProperty');
      return refs.map((r) => ({ type, ref: r, props: { name: 'DS-Prod' } }));
    } };
  const r = await C.refreshVcInfo(c, { id: 'vd' }, { now: Date.parse('2026-11-05T03:00:00Z'), dvpgRefs: ['dvportgroup-31', 'dvportgroup-32'] });
  assert.deepEqual(calls.filter((x) => x[0] !== 'ResourcePool').map((x) => x.slice(0, 3)), [
    ['DistributedVirtualPortgroup', 'dvportgroup-31,dvportgroup-32', 'name,tag,config.distributedVirtualSwitch,config.defaultPortConfig'],
    ['VmwareDistributedVirtualSwitch', 'dvs-21', 'name,config.lacpGroupConfig'],
    ['VmwareDistributedVirtualSwitch', 'dvs-21', 'name'],
  ], '읽기 전용 RetrieveProperties 만 · vDS 는 한 번(실패하면 이름만 다시)');
  assert.equal(r.dvpg.items.length, 2);
  assert.equal(r.dvpg.items[0].dvsName, 'DS-Prod');
  assert.match(r.dvpg.lagError, /InvalidProperty/);
  const r2 = await C.refreshVcInfo(c, { id: 've' }, { now: Date.parse('2026-11-05T03:00:00Z') });
  assert.equal(Object.hasOwn(r2, 'dvpg'), false);
  // 수집 연결 — soapClient 가 인벤토리의 분산 포트그룹 moref 를 넘긴다(소스)
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/vcenter/soapClient.js', import.meta.url), 'utf8');
  assert.match(src, /dvpgRefs: objs\.filter\(\(x\) => x\.type === 'DistributedVirtualPortgroup'\)\.map\(\(x\) => x\.ref\)/);
});

test('⑤ 라우트 종류 · 권한 · 상한 · 데모 · 응답 사유 칸 · 선형(비율)', async () => {
  const { VCINFO_PERM, VCINFO_KINDS, vcInfoBody } = await import('../src/routes/api/vcInfo.js');
  const { VCINFO_REFRESH_MS } = await import('../src/vcinfo/collect.js');
  assert.ok(VCINFO_KINDS.includes('dvpg'));
  assert.equal(VCINFO_PERM.dvpg, 'inv.hosts');
  assert.equal(VCINFO_REFRESH_MS.dvpg, 6 * 3_600_000);
  const body = vcInfoBody('dvpg', 'vc-a', { at: 1, items: [{ ref: 'dvportgroup-1' }], lagError: 'x', error: null });
  assert.deepEqual([body.items.length, body.lagError, body.dvsError, body.limits.max], [1, 'x', null, (await import('../src/vcinfo/parse.js')).DVPG_MAX]);
  const { generateSnapshot } = await import('../src/mock/generator.js');
  const { mockVcInfo } = await import('../src/mock/vcinfo.js');
  const snap = await generateSnapshot();
  const vc = snap.vcenters[0].id;
  const m = mockVcInfo('dvpg', vc, snap, Date.now());
  const P = await import('../src/vcinfo/parse.js');
  assert.deepEqual(P.sanitizeDvpg(m).items.length, m.items.length, '데모 값은 정제를 그대로 지난다(무손실)');
  assert.ok(m.items.some((x) => x.uplinkPg), '업링크 포트그룹을 하나 싣는다(화면이 빼는지 보이게)');
  const dvsNames = new Set(snap.hosts.filter((h) => h.vcenterId === vc).flatMap((h) => h.hcfg?.net?.switches || []).filter((w) => w.kind === 'dvs').map((w) => w.name));
  assert.ok(m.items.every((x) => dvsNames.has(x.dvsName)), '데모 vDS 이름 = 데모 호스트의 분산 스위치 이름');
  // 선형 — 닫히지 않은 업링크 태그 반복(크기 4배 → 2차면 16배)
  const evil = (n) => `<uplinkTeamingPolicy><uplinkPortOrder>${'<activeUplinkPort>Uplink 1'.repeat(n)}</uplinkPortOrder></uplinkTeamingPolicy>`;
  const time = (s) => { const t0 = process.hrtime.bigint(); for (let i = 0; i < 3; i++) P.parseDvPortSetting(s); return Number(process.hrtime.bigint() - t0) / 1e6; };
  time(evil(500));
  const a = time(evil(1000)); const b = time(evil(4000));
  assert.ok(b < Math.max(a * 8, 30), `선형(${a.toFixed(1)}ms → ${b.toFixed(1)}ms)`);
});
