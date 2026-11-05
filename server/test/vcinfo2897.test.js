/**
 * v2.897 — vCenter 알람 · 최근 작업 · 권한 목록(vcinfo). 고정하는 것:
 *  ① 파서: AlarmState(타입 이름 · 속성 이름 둘 다) · TaskInfo(result · reason 안의 같은 이름 태그에 속지 않는다) · Permission · AuthorizationRole
 *  ② 수집: 읽기 전용 호출만 · 종류별 주기 · 실패하면 직전 값 유지 + 오류 · 권한 부족 vCenter 에 매 주기 묻지 않는다 · 작업 버퍼 24시간
 *  ③ 엣지 정제(sanitizeVcInfo) · 중앙 수신이 vcenter 객체에서 vcInfo 를 지우고 캐시에만 넣는다(/vcenters 로 권한 목록이 새지 않는다)
 *  ④ 라우트: 범위 밖 · 없는 vCenter 404 → 권한 목록은 관리자 판본만(403) → 작업 시작 사용자 · 알람 확인자는 관리자 판본만
 *  ⑤ 선형 시간(8배 크기 · 기준 24배 · 번갈아 5회 최솟값 — docs/rules/common.md)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vcinfo2897-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';

const P = await import('../src/vcinfo/parse.js');
const C = await import('../src/vcinfo/collect.js');
const closers = [];
after(async () => { for (const c of closers) await c(); fs.rmSync(DIR, { recursive: true, force: true }); });

const ALARM_XML = '<val xsi:type="ArrayOfAlarmState">'
  + '<AlarmState><key>alarm-7.host-12</key><entity type="HostSystem">host-12</entity><alarm type="Alarm">alarm-7</alarm><overallStatus>red</overallStatus><time>2026-11-05T00:00:00Z</time><acknowledged>false</acknowledged><eventKey>1</eventKey></AlarmState>'
  + '<AlarmState><key>alarm-9.vm-3</key><entity type="VirtualMachine">vm-3</entity><alarm type="Alarm">alarm-9</alarm><overallStatus>yellow</overallStatus><time>2026-11-04T00:00:00Z</time><acknowledged>true</acknowledged><acknowledgedByUser>VSPHERE.LOCAL\\ops</acknowledgedByUser><acknowledgedTime>2026-11-04T01:00:00Z</acknowledgedTime></AlarmState>'
  + '</val>';
const TASK_INFO = (key, extra = '') => `<key>${key}</key><task type="Task">${key}</task><description><key>x</key><message>m</message></description><name>PowerOnVM_Task</name>`
  + `<descriptionId>VirtualMachine.powerOn</descriptionId><entity type="VirtualMachine">vm-1</entity><entityName>web01</entityName><state>success</state><cancelled>false</cancelled>${extra}`
  + '<reason xsi:type="TaskReasonUser"><userName>CORP\\kim</userName></reason><queueTime>2026-11-05T01:00:00Z</queueTime><startTime>2026-11-05T01:00:01Z</startTime><completeTime>2026-11-05T01:00:09Z</completeTime>';
const PERM_XML = '<RetrieveAllPermissionsResponse><returnval><entity type="Folder">group-d1</entity><principal>VSPHERE.LOCAL\\Administrators</principal><group>true</group><roleId>-1</roleId><propagate>true</propagate></returnval>'
  + '<returnval><entity type="VirtualMachine">vm-1</entity><principal>CORP\\kim</principal><group>false</group><roleId>1001</roleId><propagate>false</propagate></returnval></RetrieveAllPermissionsResponse>';
const ROLE_XML = '<AuthorizationRole><roleId>-1</roleId><system>true</system><name>Admin</name><info><label>Administrator</label><summary>s</summary></info><privilege>A</privilege><privilege>B</privilege></AuthorizationRole>'
  + '<AuthorizationRole><roleId>1001</roleId><system>false</system><name>Portal</name><info><label>Portal Monitoring</label><summary>s</summary></info><privilege>System.Read</privilege></AuthorizationRole>';

test('① 알람 파서 — 타입 이름 · 속성 이름 원소 둘 다 · 상태 · 확인 · 못 읽은 값 null', () => {
  const a = P.parseTriggeredAlarms(ALARM_XML);
  assert.equal(a.items.length, 2);
  assert.deepEqual(a.items[0], { alarm: 'alarm-7', name: null, entityType: 'HostSystem', entity: 'host-12', entityName: null, status: 'red', time: Date.parse('2026-11-05T00:00:00Z'), ack: false, ackBy: null, ackTime: null });
  assert.equal(a.items[1].ackBy, 'VSPHERE.LOCAL\\ops');
  const prop = '<triggeredAlarmState><entity type="Datastore">datastore-1</entity><alarm type="Alarm">alarm-1</alarm><overallStatus>purple</overallStatus></triggeredAlarmState>';
  assert.deepEqual(P.parseTriggeredAlarms(prop).items.map((x) => [x.entity, x.status, x.time, x.ack]), [['datastore-1', null, null, null]]);
  assert.equal(P.parseTriggeredAlarms('<AlarmState><entity type="X">a b c</entity></AlarmState>').items.length, 0, 'moref 형식이 아니면 뺀다');
});

test('① 작업 파서 — result · reason 안의 entityName · error 에 속지 않는다 · 사용자 · 실패 메시지', () => {
  const t = P.parseTaskInfo(TASK_INFO('task-1', '<result xsi:type="ManagedObjectReference" type="VirtualMachine">vm-9</result>'));
  assert.deepEqual([t.key, t.op, t.entity, t.entityName, t.state, t.user, t.reason], ['task-1', 'VirtualMachine.powerOn', 'vm-1', 'web01', 'success', 'CORP\\kim', 'user']);
  assert.equal(t.completed - t.started, 8000);
  const alarmReason = '<key>task-2</key><descriptionId>Drm.ExecuteVMotionLRO</descriptionId><entity type="VirtualMachine">vm-2</entity><entityName>db01</entityName><state>error</state>'
    + '<error><fault xsi:type="InvalidArgument"></fault><localizedMessage>A specified parameter was not correct</localizedMessage></error>'
    + '<reason xsi:type="TaskReasonAlarm"><alarmName>a</alarmName><alarm type="Alarm">alarm-1</alarm><entityName>OTHER</entityName><entity type="HostSystem">host-1</entity></reason>';
  const t2 = P.parseTaskInfo(alarmReason);
  assert.deepEqual([t2.entityName, t2.entity, t2.user, t2.reason, t2.error], ['db01', 'vm-2', null, 'alarm', 'A specified parameter was not correct']);
  assert.equal(P.parseTaskInfo('<state>success</state>'), null, 'key 가 없으면 행이 아니다');
});

test('① 권한 · 역할 파서 — 권한 이름은 싣지 않고 개수만', () => {
  const p = P.parsePermissions(PERM_XML);
  assert.deepEqual(p.items.map((x) => [x.entity, x.principal, x.group, x.roleId, x.propagate]), [['group-d1', 'VSPHERE.LOCAL\\Administrators', true, -1, true], ['vm-1', 'CORP\\kim', false, 1001, false]]);
  const r = P.parseRoleList(ROLE_XML);
  assert.deepEqual(r, [{ id: -1, name: 'Admin', label: 'Administrator', system: true, privileges: 2 }, { id: 1001, name: 'Portal', label: 'Portal Monitoring', system: false, privileges: 1 }]);
});

test('① 작업 버퍼 — 같은 key 는 새 값 · 24시간 지난 완료 작업과 상한 밖은 버린다', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  const prev = [{ key: 'a', state: 'running', started: now - 60_000 }, { key: 'old', state: 'success', completed: now - 25 * 3_600_000 }];
  const m = P.mergeTasks(prev, [{ key: 'a', state: 'success', started: now - 60_000, completed: now - 1000 }, { key: 'b', queued: now }], { now });
  assert.deepEqual(m.map((x) => [x.key, x.state ?? null]), [['b', null], ['a', 'success']]);
  assert.equal(P.mergeTasks([], Array.from({ length: 500 }, (_, i) => ({ key: `k${i}`, queued: now - i })), { now }).length, P.VCINFO_LIMITS.tasks);
});

/** 가짜 SOAP 클라이언트 — 부른 호출을 기록한다(상태를 바꾸는 메서드가 없음을 확인). */
function fakeClient({ failPerms = null, failTasks = null } = {}) {
  const calls = [];
  return {
    calls,
    sc: { propertyCollector: 'propertyCollector', rootFolder: 'group-d1', taskManager: 'TaskManager', authorizationManager: 'AuthorizationManager' },
    async retrieveObjectProps(type, ref, paths) {
      calls.push(`get:${type}:${paths.join(',')}`);
      if (type === 'Folder') return [{ type, ref, props: { triggeredAlarmState: ALARM_XML } }];
      if (type === 'TaskManager') { if (failTasks) throw new Error(failTasks); return [{ type, ref, props: { recentTask: '<ManagedObjectReference type="Task">task-1</ManagedObjectReference>' } }]; }
      if (type === 'AuthorizationManager') return [{ type, ref, props: { roleList: ROLE_XML } }];
      return [];
    },
    async retrieveManyObjectProps(type, refs, paths) {
      calls.push(`many:${type}:${paths.join(',')}`);
      if (type === 'Alarm') return refs.map((r) => ({ type, ref: r, props: { 'info.name': `정의 ${r}` } }));
      if (type === 'Task') return refs.map((r) => ({ type, ref: r, props: { info: TASK_INFO(r) } }));
      return [];
    },
    async callRaw(body) {
      const m = /^<(\w+)/.exec(body)?.[1];
      calls.push(`raw:${m}`);
      if (m === 'RetrieveAllPermissions') { if (failPerms) throw new Error(failPerms); return PERM_XML; }
      if (m === 'RetrieveProperties') {
        const objs = [...body.matchAll(/<obj type="(\w+)">([^<]+)<\/obj>/g)].map(([, t, r]) => `<returnval><obj type="${t}">${r}</obj><propSet><name>name</name><val xsi:type="xsd:string">이름-${r}</val></propSet></returnval>`).join('');
        return `<RetrievePropertiesResponse>${objs}</RetrievePropertiesResponse>`;
      }
      throw new Error(`예상하지 않은 호출 ${m}`);
    },
  };
}

test('② 수집 — 읽기 전용 호출만 · 이름 채움 · 종류별 주기(다음 주기 전에는 다시 묻지 않는다)', async () => {
  C._resetVcInfo();
  const c = fakeClient();
  const now = Date.parse('2026-11-05T03:00:00Z');
  const r = await C.refreshVcInfo(c, { id: 'vc1' }, { now });
  assert.equal(r.alarms.items[0].name, '정의 alarm-7');
  assert.equal(r.alarms.items[0].entityName, '이름-host-12');
  assert.equal(r.tasks.items[0].entityName, 'web01');
  assert.equal(r.perms.items.find((p) => p.entity === 'vm-1').role, 'Portal Monitoring');
  assert.equal(r.perms.items[0].entityName, '이름-group-d1');
  // 상태를 바꾸는 vim25 메서드(Acknowledge · Set · Create · Remove · Cancel …)를 부르지 않는다
  assert.ok(c.calls.every((x) => /^(get|many):|^raw:(RetrieveAllPermissions|RetrieveProperties)$/.test(x)), c.calls.join(' | '));
  const n = c.calls.length;
  await C.refreshVcInfo(c, { id: 'vc1' }, { now: now + 60_000 });
  assert.equal(c.calls.length, n, '1분 뒤에는 아무것도 다시 묻지 않는다');
  await C.refreshVcInfo(c, { id: 'vc1' }, { now: now + C.VCINFO_REFRESH_MS.alarms });
  assert.ok(c.calls.slice(n).some((x) => x.startsWith('get:Folder')), '알람 주기가 지나면 알람만 다시');
  assert.ok(!c.calls.slice(n).some((x) => x === 'raw:RetrieveAllPermissions'), '권한은 6시간 주기');
  assert.ok(!c.calls.slice(n).some((x) => x.startsWith('many:Alarm')), '알람 정의 이름은 기억한다(6시간)');
});

test('② 실패 — 직전 값 유지 + 오류 · 한 번도 못 읽은 권한 부족은 주기 뒤에만 다시(매 수집 주기 금지) · 시한 실패는 짧게', async () => {
  C._resetVcInfo();
  const now = Date.parse('2026-11-05T03:00:00Z');
  await C.refreshVcInfo(fakeClient(), { id: 'vc2' }, { now });
  const bad = fakeClient({ failPerms: 'NoPermission', failTasks: 'request timed out' });
  const r = await C.refreshVcInfo(bad, { id: 'vc2' }, { now: now + 7 * 3_600_000 });
  assert.equal(r.perms.error, 'NoPermission');
  assert.equal(r.perms.items.length, 2, '직전 값을 지우지 않는다');
  assert.equal(r.perms.at, now, 'at 은 마지막 성공 시각 그대로');
  assert.equal(r.tasks.error, 'request timed out');
  assert.equal(r.tasks.retryAt, now + 7 * 3_600_000 + C.VCINFO_RETRY_MS, '시한 실패는 짧은 재시도');
  // 처음부터 권한이 없는 vCenter
  C._resetVcInfo();
  const np = fakeClient({ failPerms: 'NoPermission' });
  await C.refreshVcInfo(np, { id: 'vc3' }, { now });
  const n = np.calls.filter((x) => x === 'raw:RetrieveAllPermissions').length;
  await C.refreshVcInfo(np, { id: 'vc3' }, { now: now + 10 * 60_000 });
  assert.equal(np.calls.filter((x) => x === 'raw:RetrieveAllPermissions').length, n, '10분 뒤 다시 묻지 않는다');
  assert.equal(C.getVcInfo('vc3').perms.at, null);
  assert.equal(C.vcInfoDue(C.getVcInfo('vc3').perms, 'perms', now + C.VCINFO_REFRESH_MS.perms), true);
});

test('② 예산 0 — 건너뛴 종류는 retryAt 만 · 직전 값 그대로 · push 본문에 retryAt · tried 를 싣지 않는다', async () => {
  C._resetVcInfo();
  const now = Date.parse('2026-11-05T03:00:00Z');
  await C.refreshVcInfo(fakeClient(), { id: 'vc4' }, { now });
  const r = await C.refreshVcInfo(fakeClient(), { id: 'vc4' }, { now: now + 7 * 3_600_000, budgetMs: -1 });
  assert.equal(r.alarms.items.length, 2);
  assert.ok(r.alarms.retryAt > now);
  const push = C.vcInfoForPush('vc4');
  assert.equal(Object.hasOwn(push.alarms, 'retryAt'), false);
  assert.equal(Object.hasOwn(push.alarms, 'tried'), false);
});

test('③ 엣지 정제 — 아는 키만 · 형식 밖 null · 상한 · 객체가 아니면 null', () => {
  assert.equal(P.sanitizeVcInfo('x'), null);
  const v = P.sanitizeVcInfo({ alarms: { at: 1, items: [{ alarm: 'alarm-1', entity: 'vm 1', entityType: '<x>', status: 'evil', name: { a: 1 }, extra: 'drop' }], omitted: -3 }, tasks: { items: [{ op: 'x' }, { key: 'task-1', progress: 500, reason: 'hack' }] }, perms: { items: [{ principal: 'a', roleId: '1' }, { principal: 'b', roleId: 2 }], roles: [{ id: 'x' }] }, junk: 1 });
  assert.deepEqual(v.alarms.items[0], { alarm: 'alarm-1', name: null, entityType: null, entity: null, entityName: null, status: null, time: null, ack: null, ackBy: null, ackTime: null });
  assert.equal(v.alarms.omitted, 0);
  assert.deepEqual(v.tasks.items.map((t) => [t.key, t.progress, t.reason]), [['task-1', null, null]]);
  assert.deepEqual(v.perms.items.map((p) => p.principal), ['b']);
  assert.deepEqual(v.perms.roles, []);
  assert.equal(Object.hasOwn(v, 'junk'), false);
  assert.equal(P.sanitizeVcInfo({ alarms: { items: Array.from({ length: 2000 }, () => ({ alarm: 'alarm-1' })) } }).alarms.items.length, P.VCINFO_LIMITS.alarms);
});

test('③ 중앙 수신 — vcenter 객체에서 vcInfo 를 지우고(정제 후) 캐시에만 넣는다 · 스냅샷 vCenter 객체에 권한 목록이 없다', async () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'routes', 'central.js'), 'utf8');
  assert.match(src, /vcInfoIn = sanitizeVcInfo\(vcenter\.vcInfo\)[\s\S]{0,200}delete vcenter\.vcInfo/);
  assert.match(src, /setInventory\(vcId, slice, agent[^\n]*\n\s*if \(vcInfoIn\) putVcInfoFromEdge\(vcId, vcInfoIn, agent\)/, '수신이 받아들여진 뒤(setInventory 다음)에만 넣는다');
  // 수집기는 vcenter 객체에 싣지 않는다(soapClient 반환 객체에 vcInfo · vcPerms 키가 없다)
  const soap = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'vcenter', 'soapClient.js'), 'utf8');
  const ret = soap.slice(soap.indexOf('solutions, licenses, clusterCfg, tagInv, invFetch'), soap.indexOf('hosts, vms, datastores, networks, alarms,'));
  assert.doesNotMatch(ret, /vcInfo|perms|vcAlarms|vcTasks/);
  C._resetVcInfo();
  C.putFromEdge('vcE', { alarms: { at: 1, items: [] } }, 'edge-a');
  C.putFromEdge('vcE', { perms: { at: 2, items: [], roles: [] } }, 'edge-a');
  assert.deepEqual([C.getVcInfo('vcE').alarms.at, C.getVcInfo('vcE').perms.at, C.getVcInfo('vcE').source], [1, 2, 'edge'], '받은 종류만 덮는다');
});

async function seedSnapshot(patch) {
  const { store } = await import('../src/store.js');
  store.snapshot = { ...(store.get() || {}), source: 'live', generatedAt: new Date().toISOString(), hosts: [], vms: [], datastores: [], alarms: [], ...patch };
}
async function serve(user) {
  const express = (await import('express')).default;
  const { registerVcInfo } = await import('../src/routes/api/vcInfo.js');
  const app = express();
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router();
  registerVcInfo(api);
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  return async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json().catch(() => null) }; };
}

test('④ 라우트 — 범위 밖 · 없는 vCenter 404 · 권한 목록 관리자만 · 사용자 이름은 관리자 판본만 · 아직 읽지 않음은 따로 말한다', async () => {
  await seedSnapshot({ vcenters: [{ id: 'vcA', name: 'A', status: 'connected' }, { id: 'vcB', name: 'B', status: 'connected' }] });
  C._resetVcInfo();
  await C.refreshVcInfo(fakeClient(), { id: 'vcA' }, { now: Date.now() });
  const admin = await serve({ username: 'adm', role: 'admin', scope: null });
  const viewer = await serve({ username: 'v', role: 'viewer', scope: null });
  const scoped = await serve({ username: 's', role: 'admin', scope: { vcenters: ['vcB'] } });
  const demo = await serve({ username: 'thedvcdemp', role: 'viewer', demo: true, scope: null });

  const a = await admin('/vcenter-info/perms?vcenterId=vcA');
  assert.equal(a.status, 200);
  assert.equal(a.body.items.length, 2);
  assert.equal(a.body.roles.length, 2);
  assert.equal((await viewer('/vcenter-info/perms?vcenterId=vcA')).status, 403);
  assert.equal((await demo('/vcenter-info/perms?vcenterId=vcA')).status, 403);
  // 범위 밖은 권한 목록이든 알람이든 404(403 이 아니다 — 존재를 흘리지 않는다)
  assert.equal((await scoped('/vcenter-info/perms?vcenterId=vcA')).status, 404);
  assert.equal((await scoped('/vcenter-info/alarms?vcenterId=vcA')).status, 404);
  assert.equal((await admin('/vcenter-info/alarms?vcenterId=nope')).status, 404);
  assert.equal((await admin('/vcenter-info/secrets?vcenterId=vcA')).status, 404);

  const t = await viewer('/vcenter-info/tasks?vcenterId=vcA');
  assert.equal(t.status, 200);
  assert.equal(t.body.items[0].user, null);
  assert.equal(t.body.userMasked, true);
  assert.equal((await admin('/vcenter-info/tasks?vcenterId=vcA')).body.items[0].user, 'CORP\\kim');
  const al = await viewer('/vcenter-info/alarms?vcenterId=vcA');
  assert.ok(al.body.items.every((x) => x.ackBy === null));
  assert.equal(al.body.refreshMs, C.VCINFO_REFRESH_MS.alarms);

  const notYet = await scoped('/vcenter-info/alarms?vcenterId=vcB');
  assert.equal(notYet.status, 200);
  assert.equal(notYet.body.at, null);
  assert.match(notYet.body.notCollected, /아직 읽지 않았습니다/);
});

test('④ /vcenters 응답(롤업 sites)에 vcinfo 값이 실리지 않는다 — 캐시는 스냅샷 밖', async () => {
  const { vcInfoBody } = await import('../src/routes/api/vcInfo.js');
  const { store } = await import('../src/store.js');
  const sites = store.get()?.rollups?.sites || store.get()?.vcenters || [];
  for (const s of sites) for (const k of ['vcInfo', 'perms', 'vcPerms']) assert.equal(Object.hasOwn(s, k), false);
  assert.equal(vcInfoBody('perms', 'x', null).notCollected.length > 0, true);
});

function pairMinTimes(fnSmall, fnBig, rounds = 5) {
  let a = Infinity; let b = Infinity;
  for (let i = 0; i < rounds; i++) {
    let t = process.hrtime.bigint(); fnSmall(); a = Math.min(a, Number(process.hrtime.bigint() - t) / 1e6);
    t = process.hrtime.bigint(); fnBig(); b = Math.min(b, Number(process.hrtime.bigint() - t) / 1e6);
  }
  return { a: Math.max(a, 0.05), b };
}
test('⑤ 선형 시간 — 닫히지 않은 원소 반복 · 긴 텍스트(8배 · 기준 24배)', () => {
  const mk = (n) => '<returnval '.repeat(n) + '<AlarmState '.repeat(n) + '<entity type="'.repeat(n) + '<key>' + 'k'.repeat(n * 10);
  const s = mk(5_000); const b = mk(40_000);
  for (const fn of [P.parsePermissions, (x) => P.parseTriggeredAlarms(x), P.parseRoleList]) {
    const { a, b: tb } = pairMinTimes(() => fn(s), () => fn(b));
    assert.ok(tb / a < 24, `비율 ${(tb / a).toFixed(1)} (작은 ${a.toFixed(2)}ms · 큰 ${tb.toFixed(2)}ms)`);
  }
  const t = (n) => '<key>t</key>' + '<error '.repeat(n) + '<reason '.repeat(n) + '<entity type="'.repeat(n);
  const { a, b: tb } = pairMinTimes(() => P.parseTaskInfo(t(2_000)), () => P.parseTaskInfo(t(16_000)));
  assert.ok(tb / a < 24, `작업 비율 ${(tb / a).toFixed(1)}`);
});
