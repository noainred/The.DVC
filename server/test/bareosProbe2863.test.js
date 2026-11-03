/**
 * test/bareosProbe2863.test.js — v2.863 bareos-probe 실환경 사전 점검(읽기 전용).
 *  ① 복원 명령 미리 보기: 포탈과 **같은 함수**로 만든다(restoreCommand = runRestore 가 보내는 글자) · 성공한 백업만 · 체인 · 이름 · 데이터스토어 값 검사
 *  ② FD 판 줄: 평문 · JSON 모드 · 없음
 *  ③ NIC 요약: 연결 칸을 못 읽으면 null(false 로 단정하지 않는다) · PCI 패스스루 수
 *  ④ 권한: HasPrivilegeOnEntities 요청에 현재 세션 키 · 권한 id · 대상이 들어가고, 응답의 못 읽은 칸은 null
 *  ⑤ 읽기 전용: probe 는 복원을 보내거나 VM 을 바꾸는 함수를 부르지 않는다 · 비밀번호는 환경변수로만
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { restorePreview, fdVersionLine } = await import('../src/bareos/probePlan.js');
const { restoreCommand, runRestore } = await import('../src/bareos/director.js');
const vs = await import('../src/vmclone/vsphere.js');

const BASE = { vcserver: 'vc.corp', configFile: '/etc/bareos/vmware/vc.ini', dc: 'DC-A', folder: '/web' };   // v2.872 B1-04 포탈이 싣는 기본 키
const R = (jobid, level, startedAt, o = {}) => ({ jobid, name: 'pv-web', type: 'B', level, state: 'ok', status: 'T', startedAt, client: 'fd-seoul', ...o });

test('① 복원 명령 미리 보기 — 포탈과 같은 글자 · 성공한 백업만 · 체인 · 값 검사', async () => {
  const runs = [R(30, 'I', 3000), R(20, 'I', 2000), R(10, 'F', 1000), R(25, 'I', 2500, { state: 'error', status: 'f' })];
  const pv = restorePreview({ row: R(30, 'I', 3000), runs, jobid: 30, restoreJob: 'PortalVmwareRestore', newName: 'web-01-test', datastore: 'DS-01', base: BASE });
  assert.equal(pv.ok, true, JSON.stringify(pv));
  assert.deepEqual(pv.chain, [10, 20, 30], '실패한 실행은 체인에 넣지 않는다');
  assert.match(pv.pluginOptions, /vmname=web-01-test/);
  assert.match(pv.pluginOptions, /restore_powerstate=off/);
  assert.match(pv.pluginOptions, /restore_datastore=DS-01/);
  assert.equal(pv.command, restoreCommand({ client: 'fd-seoul', jobids: [10, 20, 30], restoreJob: 'PortalVmwareRestore', pluginOptions: pv.pluginOptions }));
  assert.match(pv.command, /^restore client=fd-seoul restoreclient=fd-seoul jobid=10,20,30 restorejob=PortalVmwareRestore pluginoptions=".*" all done yes$/);
  assert.match(pv.pluginOptions, /^python3:vcserver=vc\.corp:dc=DC-A:folder=\/web:vmname=web-01-test:config_file=\/etc\/bareos\/vmware\/vc\.ini:restore_powerstate=off:restore_datastore=DS-01$/, 'v2.872 B1-04 포탈과 같은 기본 키');
  assert.match(restorePreview({ row: R(30, 'I', 3000), runs, jobid: 30, restoreJob: 'PortalVmwareRestore' }).issue, /기본 키/, '기본 키를 모르면 만들지 않는다');
  assert.match(restorePreview({ row: R(30, 'I', 3000), runs, jobid: 30, restoreJob: 'PortalVmwareRestore', base: { ...BASE, configFile: '' } }).issue, /INI/);
  assert.doesNotMatch(pv.command, /\bselect\b/, 'select 를 넣지 않는다(v2.827.1)');
  // runRestore 가 실제로 보내는 글자와 같다(미리 보기가 다른 명령을 보여 주지 않게)
  let sent = '';
  await runRestore({ call: async (cmd) => { sent = cmd; return { jobid: 99 }; } }, { client: 'fd-seoul', jobids: [10, 20, 30], restoreJob: 'PortalVmwareRestore', pluginOptions: pv.pluginOptions });
  assert.equal(sent, pv.command);
  // 이름을 안 주면 '<잡 이름>-probe'
  assert.match(restorePreview({ row: R(10, 'F', 1000), runs, jobid: 10, restoreJob: 'PortalVmwareRestore', base: BASE }).pluginOptions, /vmname=pv-web-probe/);
  // 거부
  assert.match(restorePreview({ row: null, runs: [], jobid: 1, restoreJob: 'x' }).issue, /찾지 못했습니다/);
  assert.match(restorePreview({ row: R(25, 'I', 2500, { state: 'error', status: 'f' }), runs, jobid: 25, restoreJob: 'x' }).issue, /성공한 백업이 아닙니다/);
  assert.match(restorePreview({ row: R(40, 'I', 4000), runs: [R(40, 'I', 4000)], jobid: 40, restoreJob: 'x' }).issue, /체인/);
  assert.match(restorePreview({ row: R(10, 'F', 1000), runs, jobid: 10, restoreJob: 'x', newName: 'a"b', base: BASE }).issue, /새 VM 이름/);
  assert.match(restorePreview({ row: R(10, 'F', 1000), runs, jobid: 10, restoreJob: 'x', datastore: 'ds;rm', base: BASE }).issue, /데이터스토어/);
  assert.match(restorePreview({ row: R(10, 'F', 1000), runs, jobid: 10, restoreJob: 'bad name', base: BASE }).issue, /복원 잡 이름/);
  assert.match(restorePreview({ row: R(10, 'F', 1000, { client: '-x' }), runs, jobid: 10, restoreJob: 'x', base: BASE }).issue, /FD 이름/);
});

test('② FD 판 줄 — 평문 · JSON 모드 · 없음', () => {
  assert.equal(fdVersionLine('fd-seoul Version: 23.0.3 (21 Oct 2024) Linux\nDaemon started ...'), 'fd-seoul Version: 23.0.3 (21 Oct 2024) Linux');
  assert.equal(fdVersionLine(JSON.stringify({ result: { status: ['x', 'bareos-fd Version: 24.0.1 (x)'] } })), 'bareos-fd Version: 24.0.1 (x)');
  assert.equal(fdVersionLine('no version here'), '');
  assert.equal(fdVersionLine(null), '');
});

const NIC = (type, conn, label) => `<VirtualDevice xsi:type="${type}"><key>4000</key><deviceInfo><label>${label}</label><summary>x</summary></deviceInfo>${conn}<controllerKey>100</controllerKey></VirtualDevice>`;
test('③ NIC 요약 — 못 읽은 연결 칸은 null · 패스스루 수', () => {
  const xml = NIC('VirtualVmxnet3', '<connectable><startConnected>true</startConnected><allowGuestControl>true</allowGuestControl><connected>true</connected></connectable>', 'Network adapter 1')
    + NIC('VirtualE1000e', '', 'Network adapter 2')
    + '<VirtualDevice xsi:type="VirtualPCIPassthrough"><key>13000</key></VirtualDevice>'
    + '<VirtualDevice xsi:type="VirtualDisk"><key>2000</key></VirtualDevice>';
  assert.deepEqual(vs.nicSummary(xml), [
    { type: 'VirtualVmxnet3', label: 'Network adapter 1', connected: true, startConnected: true, allowGuestControl: true },
    { type: 'VirtualE1000e', label: 'Network adapter 2', connected: null, startConnected: null, allowGuestControl: null },
  ]);
  assert.equal(vs.passthroughCount(xml), 1);
  assert.deepEqual(vs.nicSummary(''), []);
});

test('④ 권한 — 현재 세션 키 · 권한 id · 대상으로 묻고, 못 읽은 칸은 null', async () => {
  const bodies = [];
  const c = {
    sc: { propertyCollector: 'propertyCollector', sessionManager: 'SessionManager', authorizationManager: 'AuthorizationManager' },
    async callRaw(body) {
      bodies.push(body);
      if (body.includes('<RetrieveProperties')) return '<returnval><obj type="SessionManager">SessionManager</obj><propSet><name>currentSession</name><val xsi:type="UserSession"><key>52abc-def</key><userName>VSPHERE.LOCAL\\portal</userName></val></propSet></returnval>';
      return '<HasPrivilegeOnEntitiesResponse><returnval><entity type="VirtualMachine">vm-42</entity>'
        + '<privAvailability><privId>VirtualMachine.Config.EditDevice</privId><isGranted>true</isGranted></privAvailability>'
        + '<privAvailability><privId>VirtualMachine.Inventory.Delete</privId><isGranted>false</isGranted></privAvailability>'
        + '<privAvailability><privId>VirtualMachine.Interact.PowerOn</privId></privAvailability></returnval>'
        + '<returnval><entity type="Folder">group-v7</entity><privAvailability><privId>VirtualMachine.Inventory.Delete</privId><isGranted>true</isGranted></privAvailability></returnval></HasPrivilegeOnEntitiesResponse>';
    },
  };
  const out = await vs.sessionPrivileges(c, [{ type: 'VirtualMachine', ref: 'vm-42' }, { type: 'Folder', ref: 'group-v7' }]);
  const q = bodies[1];
  assert.match(q, /<_this type="AuthorizationManager">AuthorizationManager<\/_this><entity type="VirtualMachine">vm-42<\/entity><entity type="Folder">group-v7<\/entity><sessionId>52abc-def<\/sessionId>/, '순서: _this · entity · sessionId · privId');
  for (const id of vs.VERIFY_PRIV_IDS) assert.ok(q.includes(`<privId>${id}</privId>`), id);
  assert.deepEqual(out, [
    { entity: 'VirtualMachine:vm-42', privId: 'VirtualMachine.Config.EditDevice', granted: true },
    { entity: 'VirtualMachine:vm-42', privId: 'VirtualMachine.Inventory.Delete', granted: false },
    { entity: 'VirtualMachine:vm-42', privId: 'VirtualMachine.Interact.PowerOn', granted: null },
    { entity: 'Folder:group-v7', privId: 'VirtualMachine.Inventory.Delete', granted: true },
  ]);
  await assert.rejects(vs.sessionPrivileges({ sc: {}, callRaw: async () => '' }, []), /AuthorizationManager/);
  await assert.rejects(vs.sessionPrivileges({ ...c, callRaw: async () => '<returnval></returnval>' }, []), /세션 키/);
});

test('⑤ 읽기 전용 — 복원을 보내거나 VM 을 바꾸는 함수를 부르지 않는다 · 비밀번호는 환경변수로만', () => {
  const src = fs.readFileSync(new URL('../src/tools/bareos-probe.js', import.meta.url), 'utf8');
  for (const f of ['runRestore', 'reconfigVm', 'disconnectAllNics', 'powerOnVm', 'powerOffVm', 'destroyClone', 'createSnapshot', 'removeSnapshot', 'cloneFromSnapshot']) {
    assert.ok(!new RegExp(`\\b${f}\\b`).test(src), `${f} 를 쓰지 않는다`);
  }
  assert.doesNotMatch(src, /call\(\s*pv\.command/, '미리 보기 명령을 보내지 않는다');
  assert.doesNotMatch(src, /--vc-pass|--password/, '비밀번호를 인자로 받지 않는다');
  assert.match(src, /process\.env\.VCENTER_PASSWORD/);
  assert.match(src, /ssrfBlockReasonResolved\(host\)/, 'vCenter 주소도 SSRF 규칙을 지난다');
});
