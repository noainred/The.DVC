/**
 * v2.901 — 버그 수정 · 개선 묶음(사용자 요청 '버그 수정이나 개선을 위한 작업 진행' · 범위: 버그 2건 · VMXNET3 권장 · 수집 확장 3종 · 전체 점검).
 *  ⓐ-1 연결된 vCenter: 범위 계정에는 조회 범위 안 등록 vCenter 와 짝지은 노드만 이름을 보인다(파트너 · 복제 이름도)
 *  ⓐ-2 데모: VM 스냅샷 개수 · 트리가 생성할 때마다 바뀌지 않는다
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('ⓐ-1 연결된 vCenter — 범위 계정은 짝지은 노드만 이름 · 전체 범위는 그대로', async () => {
  const { maskLinkedForScope } = await import('../src/routes/api/vcInfo.js');
  const body = {
    nodes: [
      { node: 'a.corp', type: 'VCSA_EMBEDDED', partners: ['b.corp', 'c.corp'], portal: { id: 'a' } },
      { node: 'b.corp', type: 'VCSA_EMBEDDED', partners: ['a.corp'], portal: null },
      { node: 'c.corp', type: 'VCSA_EMBEDDED', partners: [], portal: { id: 'c' } },
    ],
    replication: [{ node: 'a.corp', partner: 'b.corp', available: false, replicating: true, lag: 3 }],
  };
  const m = maskLinkedForScope(body, new Set(['a', 'c']));
  assert.deepEqual(m.nodes.map((n) => n.node), ['a.corp', null, 'c.corp']);
  assert.equal(m.nodes[1].masked, true);
  assert.deepEqual(m.nodes[0].partners, [null, 'c.corp'], '파트너 이름도 가린다');
  assert.deepEqual([m.replication[0].node, m.replication[0].partner, m.replication[0].available], ['a.corp', null, false], '복제 상태는 이름만 가리고 값은 남긴다');
  assert.equal(m.maskedNodes, 1);
  assert.equal(JSON.stringify(m).includes('b.corp'), false, '가린 이름이 응답 어디에도 남지 않는다');
  assert.equal(maskLinkedForScope(body, null), body, '전체 범위 계정은 그대로');
});

test('ⓐ-2 데모 — 같은 VM 의 스냅샷 개수 · 트리 노드 수가 생성마다 같다', async () => {
  const { generateSnapshot } = await import('../src/mock/generator.js');
  const a = generateSnapshot(0); const b = generateSnapshot(1);
  const byId = new Map(b.vms.map((v) => [v.id, v]));
  let n = 0;
  for (const v of a.vms) {
    const w = byId.get(v.id);
    if (!w) continue;
    assert.equal(v.snapshotCount, w.snapshotCount, v.id);
    assert.equal((v.snapshotTree || []).length, (w.snapshotTree || []).length, v.id);
    if (v.snapshotCount) { n += 1; assert.equal(v.snapshotTree.length, v.snapshotCount, '트리 노드 수 = 개수'); }
  }
  assert.ok(n > 0, '스냅샷이 있는 데모 VM 이 있다');
});

test('ⓓ-1 NIC 팀 구성 — 스위치 spec 의 중첩 policy 에 속지 않는다 · 포트그룹은 유효 정책 · 엣지 정제', async () => {
  const { parseNetwork, sanitizeHostCfg } = await import('../src/hostcfg/parse.js');
  const vs = '<HostVirtualSwitch><name>vSwitch0</name><pnic>key-vim.host.PhysicalNic-vmnic0</pnic><pnic>key-vim.host.PhysicalNic-vmnic1</pnic>'
    + '<spec><policy><security><allowPromiscuous>false</allowPromiscuous></security><nicTeaming><policy>failover_explicit</policy><rollingOrder>true</rollingOrder>'
    + '<nicOrder><activeNic>vmnic0</activeNic><standbyNic>vmnic1</standbyNic></nicOrder></nicTeaming></policy></spec></HostVirtualSwitch>';
  const pg = '<HostPortGroup><spec><name>VM Network</name><vlanId>10</vlanId><vswitchName>vSwitch0</vswitchName><policy></policy></spec>'
    + '<computedPolicy><nicTeaming><policy>loadbalance_ip</policy></nicTeaming></computedPolicy></HostPortGroup>';
  const n = parseNetwork(vs, pg, '<HostProxySwitch><dvsName>DS</dvsName><pnic>key-vim.host.PhysicalNic-vmnic2</pnic></HostProxySwitch>');
  assert.deepEqual(n.switches[0].teaming, { policy: 'failover_explicit', active: ['vmnic0'], standby: ['vmnic1'], failback: false });
  assert.equal(n.switches[1].teaming, null, '분산 스위치 팀 구성은 호스트 쪽에 없다(모름)');
  assert.equal(n.pgs[0].teaming, 'loadbalance_ip');
  assert.equal(parseNetwork('<HostVirtualSwitch><name>v</name><spec><policy><nicTeaming><policy>weird</policy></nicTeaming></policy></spec></HostVirtualSwitch>', '', '').switches[0].teaming.policy, null);
  const s = sanitizeHostCfg({ at: 1, net: { switches: [{ name: 'v', kind: 'vss', uplinks: [], teaming: { policy: '<x>', active: ['vmnic0', { a: 1 }, 'bad name!'], failback: 'yes' } }], pgs: [{ name: 'p', teaming: 'evil' }] } });
  assert.deepEqual(s.net.switches[0].teaming, { policy: null, active: ['vmnic0'], standby: [], failback: null });
  assert.equal(s.net.pgs[0].teaming, null);
});

test('ⓓ-2 호스트별 데이터스토어 마운트 — 앞 원소의 호스트 키를 줍지 않는다 · 상한 · 엣지 정제 · 판정 사실에 목록을 싣지 않는다', async () => {
  const { parseMounts, sanitizeDsCfg, DS_MOUNT_HOSTS_MAX, dsCfgFindings } = await import('../src/dscfg/parse.js');
  const one = (h, acc = 'true', mnt = 'true') => `<DatastoreHostMount><key type="HostSystem">${h}</key><mountInfo><mounted>${mnt}</mounted><accessible>${acc}</accessible></mountInfo></DatastoreHostMount>`;
  const noKey = '<DatastoreHostMount><mountInfo><mounted>true</mounted><accessible>true</accessible></mountInfo></DatastoreHostMount>';
  const m = parseMounts(one('host-1') + noKey + one('host-3', 'false'));
  assert.deepEqual([m.total, m.hosts, m.bad], [3, ['host-1', 'host-3'], [{ h: 'host-3', accessible: false, mounted: true }]], '키 없는 원소에 앞 호스트를 붙이지 않는다');
  const big = parseMounts(Array.from({ length: DS_MOUNT_HOSTS_MAX + 5 }, (_, i) => one(`host-${i}`)).join(''));
  assert.deepEqual([big.hosts.length, big.hostsOmitted], [DS_MOUNT_HOSTS_MAX, 5]);
  const s = sanitizeDsCfg({ mounts: { total: 2, hosts: ['host-1', 'bad id', 7], bad: [{ h: 'host-1', accessible: 'no' }, { h: '' }], hostsOmitted: -1 } });
  assert.deepEqual(s.mounts, { total: 2, notAccessible: 0, notMounted: 0, hosts: ['host-1'], bad: [{ h: 'host-1', accessible: null, mounted: null }], hostsOmitted: 0 });
  assert.equal(Object.hasOwn(sanitizeDsCfg({ mounts: { total: 1 } }).mounts, 'hosts'), false, '이전 판 엣지(목록 없음)는 키를 만들지 않는다 = 모름');
  if (typeof dsCfgFindings === 'function') {
    const f = dsCfgFindings({ type: 'VMFS', dcfg: { mounts: { total: 2, notAccessible: 1, notMounted: 0, hosts: ['host-1', 'host-2'], bad: [{ h: 'host-2' }] } } }).find((x) => x.code === 'ds-mount-partial');
    assert.deepEqual(Object.keys(f.facts).sort(), ['notAccessible', 'notMounted', 'total']);
  }
});

test('ⓓ-3 리소스 풀 — 중첩 shares · 무제한 -1 · 루트 판정 · 엣지 정제 · 수집은 받은 풀 moref 만 · 라우트 권한', async () => {
  const P = await import('../src/vcinfo/parse.js');
  const C = await import('../src/vcinfo/collect.js');
  assert.deepEqual(P.parseAllocation('<reservation>2000</reservation><expandableReservation>false</expandableReservation><limit>-1</limit><shares><shares>8000</shares><level>high</level></shares><overheadLimit>9</overheadLimit>'),
    { res: 2000, limit: -1, expandable: false, shares: 8000, level: 'high' });
  assert.equal(P.parseAllocation(''), null);
  const rows = P.parsePools([{ ref: 'resgroup-8', props: { name: 'Resources', parent: 'domain-c7', owner: 'domain-c7' } }, { ref: 'resgroup-9', props: { name: 'Prod', parent: 'resgroup-8', owner: 'domain-c7' } }, { ref: 'bad ref', props: {} }]);
  assert.deepEqual(rows.map((r) => [r.ref, r.root, r.owner]), [['resgroup-9', false, 'domain-c7'], ['resgroup-8', true, 'domain-c7']]);
  assert.deepEqual(P.sanitizeVcInfo({ pools: { items: [{ ref: 'resgroup-1', cpu: { res: '5', level: 'x', shares: -1 } }, { ref: 'x y' }] } }).pools.items,
    [{ ref: 'resgroup-1', name: null, owner: null, root: null, cpu: { res: null, limit: null, expandable: null, shares: null, level: null }, mem: null }]);
  C._resetVcInfo();
  const calls = [];
  const c = { sc: {}, retrieveObjectProps: async () => { throw new Error('skip'); }, callRaw: async () => { throw new Error('skip'); },
    retrieveManyObjectProps: async (type, refs, paths) => { calls.push([type, refs.length, paths.join(',')]); return refs.map((r) => ({ type, ref: r, props: { name: r, parent: 'resgroup-1' } })); } };
  const r = await C.refreshVcInfo(c, { id: 'vp' }, { now: Date.parse('2026-11-05T03:00:00Z'), poolRefs: ['resgroup-2', 'resgroup-3'] });
  assert.deepEqual(calls.filter((x) => x[0] === 'ResourcePool'), [['ResourcePool', 2, 'name,parent,owner,config.cpuAllocation,config.memoryAllocation']]);
  assert.equal(r.pools.items.length, 2);
  const r2 = await C.refreshVcInfo(c, { id: 'vq' }, { now: Date.parse('2026-11-05T03:00:00Z') });
  assert.equal(Object.hasOwn(r2, 'pools'), false, '풀 moref 를 받지 않으면 이 종류를 건드리지 않는다');
  const { VCINFO_PERM, VCINFO_KINDS } = await import('../src/routes/api/vcInfo.js');
  assert.ok(VCINFO_KINDS.includes('pools'));
  assert.equal(VCINFO_PERM.pools, 'inv.hosts');
});

// ════════════════════════════ 전체 점검 반영(내 코드의 결함 — 정정) ════════════════════════════
test('점검 E1 — recentTask · 알람 참조를 속성 순서와 무관하게 읽고, 못 읽으면 0건이 아니라 오류', async () => {
  const C = await import('../src/vcinfo/collect.js');
  const P = await import('../src/vcinfo/parse.js');
  const both = '<ManagedObjectReference type="Task" xsi:type="ManagedObjectReference">task-101</ManagedObjectReference>'
    + '<ManagedObjectReference xsi:type="ManagedObjectReference" type="Task">task-102</ManagedObjectReference>';
  assert.deepEqual([...C.taskRefsOf(both)], ['task-101', 'task-102']);
  assert.equal(C.taskRefsOf('<ManagedObjectReference').unreadable, 1, '원소가 있는데 하나도 못 읽음');
  assert.equal(C.taskRefsOf('').unreadable, 0, '빈 목록은 0건이다');
  const a = P.parseTriggeredAlarms('<AlarmState><entity type="HostSystem" xsi:type="ManagedObjectReference">host-1</entity><alarm xsi:type="ManagedObjectReference" type="Alarm">alarm-2</alarm></AlarmState><AlarmState><entity>x</entity></AlarmState>');
  assert.deepEqual([a.items.map((x) => [x.entityType, x.entity, x.alarm]), a.unreadable], [[['HostSystem', 'host-1', 'alarm-2']], 1]);
  // 수집: 못 읽은 recentTask 는 '0건 · 오류 없음' 이 아니라 오류(직전 값 유지)
  C._resetVcInfo();
  const c = { sc: { taskManager: 'TaskManager' },
    retrieveObjectProps: async (type) => (type === 'TaskManager' ? [{ props: { recentTask: '<ManagedObjectReference' } }] : (() => { throw new Error('skip'); })()),
    retrieveManyObjectProps: async () => [], callRaw: async () => { throw new Error('skip'); } };
  const r = await C.refreshVcInfo(c, { id: 'vt' }, { now: Date.parse('2026-11-05T03:00:00Z') });
  assert.match(r.tasks.error, /읽지 못했습니다/);
  assert.equal(r.tasks.at, null);
});

test('점검 E2 — 캐시에 남는 글자는 평탄화(응답 원문을 붙잡지 않는다)', async () => {
  const P = await import('../src/vcinfo/parse.js');
  const src = fs.readFileSync(new URL('../src/vcinfo/parse.js', import.meta.url), 'utf8');
  assert.match(src, /return t \? flatStr\(t\.slice\(0, n\)\) : null;/);
  assert.match(src, /\{ type: flatStr\(t\), ref: flatStr\(r\) \}/);
  const t = P.parseTaskInfo('<key>task-1</key><entityName>a-very-long-entity-name-01</entityName><state>success</state>');
  assert.equal(t.entityName, 'a-very-long-entity-name-01');
});

test('점검 E3 · E7 — 키가 없으면 직전 값을 지우지 않는다 · 엣지 시각은 받은 시각을 넘지 못한다 · 낡음 · 만료', async () => {
  const C = await import('../src/vcinfo/collect.js');
  const R = await import('../src/routes/api/vcInfo.js');
  const src = fs.readFileSync(new URL('../src/routes/central.js', import.meta.url), 'utf8');
  assert.match(src, /if \(vcInfoIn && !edgeVcWriteDenied\(vcId, \{ requireSite: true \}\)\) putVcInfoFromEdge/);
  C._resetVcInfo();
  const future = Date.now() + 3 * 86_400_000;
  C.putFromEdge('vE', { alarms: { at: future, items: [] } }, 'edge');
  const e = C.getVcInfo('vE');
  assert.ok(e.alarms.at <= Date.now(), '미래 시각을 받은 시각으로 자른다');
  assert.equal(e.alarms.atEdge, future, '원본은 따로');
  assert.ok(R.EDGE_STALE_MS < R.EDGE_EXPIRE_MS);
});

test('점검 B1 — 그룹 예약 기준 시계(사용자 결정: 두 시계를 보이고 고르게) · 옛 그룹은 현지 서버 · 포탈 시계는 프로세스 TZ 와 무관', async () => {
  const S = await import('../src/bareos/groupSchedule.js');
  assert.equal(S.normSchedule({ enabled: true, days: [1], time: '02:00' }).clock, 'server', 'clock 없는 옛 입력 = 현지 서버(실행 시각을 바꾸지 않는다)');
  assert.equal(S.normSchedule({ enabled: true, days: [1], time: '02:00', clock: 'evil' }).clock, 'server');
  const sched = S.normSchedule({ enabled: true, days: [0, 1, 2, 3, 4, 5, 6], time: '02:00', level: 'Incremental', fullDays: [5], clock: 'portal' });
  const now = Date.parse('2026-11-05T09:00:00Z');   // 포탈(KST, 오프셋 540) 18:00
  const n = S.nextSlot(sched, now);
  assert.equal(n.at, Date.parse('2026-11-05T17:00:00Z'), '포탈 02:00 = UTC 17:00(전날) — 프로세스 TZ 와 무관');
  assert.equal(n.key, '2026-11-06 02:00');
  assert.equal(n.level, 'Full', 'Full 요일도 포탈 시계의 요일(2026-11-06 금)');
  assert.equal(S.lastDueSlot(sched, now).key, '2026-11-05 02:00');
  assert.equal(S.clockStamp(n.at, 'portal'), '2026-11-06 02:00');
  // 프로세스 TZ 를 바꿔도(자식 프로세스) 포탈 시계의 회차 시각은 같다
  const { spawnSync } = await import('node:child_process');
  const code = `import(${JSON.stringify(new URL('../src/bareos/groupSchedule.js', import.meta.url).href)}).then((S) => { const s = S.normSchedule({ enabled: true, days: [0,1,2,3,4,5,6], time: '02:00', clock: 'portal' }); console.log(S.nextSlot(s, ${now}).at); })`;
  for (const tz of ['UTC', 'Asia/Seoul', 'America/New_York']) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, TZ: tz } });
    assert.equal(Number(r.stdout.trim()), n.at, `TZ=${tz}`);
  }
  assert.equal(S.scheduleText(sched), '매일 02:00 Incremental (Full: 금) · 중앙 포탈 시각');
});

test('점검 B1 — 기준 시계를 바꾸면 회차 열쇠를 비우고 anchorAt 으로만 막는다 · 화면용 두 시계 글자', async () => {
  const src = fs.readFileSync(new URL('../src/bareos/groups.js', import.meta.url), 'utf8');
  assert.match(src, /if \(\(v\.schedule\?\.clock \|\| 'server'\) !== \(g\.schedule\?\.clock \|\| 'server'\)\) g\.lastKey = '';/);
  const route = fs.readFileSync(new URL('../src/routes/api/bareosGroups.js', import.meta.url), 'utf8');
  assert.match(route, /server: clockStamp\(next\.at, 'server'\), portal: clockStamp\(next\.at, 'portal'\)/);
  assert.match(route, /clocks: clockInfo\(now\)/);
  const runner = fs.readFileSync(new URL('../src/bareos/groupRunner.js', import.meta.url), 'utf8');
  assert.match(runner, /const nowKey = slotKey\(now, g\.schedule\);/);
});

test('점검 E6 — VM PCI 패스스루 주소 파싱: 옛 정규식과 같은 결과 · 닫히지 않은 <backing 반복에도 선형(비율)', async () => {
  const { vmPassthroughPciIds, PCI_SEG_MAX } = await import('../src/vcenter/soapClient.js');
  const dev = (backing) => `<device xsi:type="VirtualPCIPassthrough"><key>13000</key>${backing}</device>`;
  const xml = [
    dev('<backing xsi:type="VirtualPCIPassthroughDeviceBackingInfo"><id>0000:3b:00.0</id><deviceId>1eb8</deviceId></backing>'),
    dev('<backing xsi:type="VirtualPCIPassthroughDynamicBackingInfo"><assignedId>0000:af:00.0</assignedId></backing>'),
    dev('<backing xsi:type="VirtualPCIPassthroughVmiopBackingInfo"><vgpu>grid_t4-4q</vgpu></backing>'),   // vGPU — 건너뛴다
    dev('<backingObjectId>x</backingObjectId><backing xsi:type="VirtualPCIPassthroughDeviceBackingInfo"><id>0000:5e:00.0</id></backing>'),   // \b
    dev('<backing xsi:type="VirtualPCIPassthroughDeviceBackingInfo"><id>not-a-pci</id></backing>'),
    dev('<backing xsi:type="x"><id>0000:3b:00.0</id></backing>'),   // 중복은 한 번
  ].join('');
  assert.deepEqual(vmPassthroughPciIds(xml), ['0000:3b:00.0', '0000:af:00.0', '0000:5e:00.0']);
  // 옛 정규식(35d4475)과 같은 결과 — 정상 출력에서 뜻이 바뀌지 않았다
  const old = (deviceXml) => {
    const ids = [];
    for (const seg of String(deviceXml || '').split(/xsi:type="VirtualPCIPassthrough"/).slice(1)) {
      const b = /<backing\b[^>]{0,200}>([\s\S]*?)<\/backing>/.exec(seg);
      if (!b || /VmiopBackingInfo/.test(b[0].slice(0, 200))) continue;
      const v = (/<assignedId>([^<]{1,64})<\/assignedId>/.exec(b[1])?.[1] || /<id>([^<]{1,64})<\/id>/.exec(b[1])?.[1] || '').trim();
      if (/^[0-9a-fA-F:.]{5,32}$/.test(v) && !ids.includes(v)) ids.push(v);
      if (ids.length >= 16) break;
    }
    return ids;
  };
  assert.deepEqual(vmPassthroughPciIds(xml), old(xml));
  const longHead = dev(`<backing ${'a'.repeat(250)}><id>0000:11:00.0</id></backing><backing x="1"><id>0000:12:00.0</id></backing>`);
  assert.deepEqual(vmPassthroughPciIds(longHead), old(longHead), '[^>]{0,200} 을 넘는 머리는 다음 <backing 으로');
  // 비율 — 닫히지 않은 <backing 반복(크기 4배 → 시간이 2차면 16배)
  const evil = (n) => `xsi:type="VirtualPCIPassthrough"${'<backing x>'.repeat(n)}`;
  const time = (s) => { const t0 = process.hrtime.bigint(); for (let i = 0; i < 3; i++) vmPassthroughPciIds(s); return Number(process.hrtime.bigint() - t0) / 1e6; };
  const small = evil(3000); const big = evil(12000);
  time(small);
  const a = time(small); const b = time(big);
  assert.ok(b < Math.max(a * 8, 30), `선형이어야 한다(${a.toFixed(1)}ms → ${b.toFixed(1)}ms)`);
  assert.ok(PCI_SEG_MAX >= 16_384 && PCI_SEG_MAX <= 262_144);
});

test('점검 E8 — 엣지가 보낸 instanceUuid 는 모양 · 길이를 본다(키가 되는 값 — 예전 주석의 문자열 상한은 없었다)', async () => {
  const { sanitizeInventoryList } = await import('../src/routes/central.js');
  const dropped = { notObject: 0, otherVcenter: 0, badId: 0, coerced: 0 };
  const out = sanitizeInventoryList([
    { id: 'vm-1', instanceUuid: '502e1f4b-8c3a-4d2b-9e1f-0a1b2c3d4e5f' },
    { id: 'vm-2', instanceUuid: 'x'.repeat(65) },
    { id: 'vm-3', instanceUuid: 'a b<script>' },
    { id: 'vm-4', instanceUuid: '' },
    { id: 'vm-5', instanceUuid: { $: 1 } },
    { id: 'vm-6' },
  ], 'vc-a', 100, dropped);
  assert.deepEqual(out.map((v) => v.instanceUuid), ['502e1f4b-8c3a-4d2b-9e1f-0a1b2c3d4e5f', null, null, '', null, undefined]);
  assert.equal(dropped.coerced, 3);
});
