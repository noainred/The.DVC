/**
 * test/bareosAutoSetup2841.test.js — v2.841 Bareos 자동 설정 개선(사용자 화면 2026-11-01: 2단계가 사람이 만든 console/admin.conf 에 막힘 ·
 * '카탈로그 일부를 읽지 못했습니다(schedules)' · '매핑 빈 칸 0개를 채웠습니다').
 *  ① 스케줄 목록 명령은 `.schedule`(Bareos ua_cmds.cc 명령 표 — 21.1·22.1·23.0·master) — catalogLists 가 `.schedules` 를 보내지 않는다 ·
 *     자동 설정 Profile Command ACL(서버·웹 같은 줄)에 `.schedule` · 데모 Director 도 `.schedule`
 *  ② 사전 점검 @@own: 2단계가 쓰는 종류의 파일 주인(M·F·X) — 아는 종류·이름·상태만 · 구역이 없거나 출력이 잘리면 null(겹침 모름) ·
 *     job 은 읽지 않는다(VM 잡 파일 수천 개) · 실제 bash 로 스크립트를 돌려 심링크·디렉터리·표지·종류당 상한을 본다
 *  ③ 2단계 겹침 안내: 콘솔이면 '만들 콘솔 이름' 을 포탈 전용 이름으로(비었는지 모르는 이름을 예로 들지 않는다) · 아무것도 쓰지 않음 · paths 그대로
 *  ④ 엣지 정제: setup.preflight confFiles 는 아는 것만 · 없으면 null(옛 엣지)
 *  ⑤ 매핑 제안: 목록을 못 읽은 것(null)과 빈 목록을 가른다(unread)
 *  ⑥ 웹 directorPlanFiles(겹침 판정에 쓰는 목록) = 서버 directorResources 의 종류·이름
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2841-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';

const A = await import('../src/bareos/autoSetup.js');
const S = await import('../src/bareos/settings.js');
const { catalogLists } = await import('../src/bareos/director.js');
const { VALUE } = await import('../src/bareos/edgeResult.js');
const { demoCall } = await import('../src/mock/demo/bareos.js');
const { fakeServer, fakeConsole } = await import('./_fakeBareosSsh.js');
const W = await import('../../web/src/views/tools/bareosText.js');

const DIR = S.addDirector({ name: '한국 본사', host: '10.20.30.40', port: 9101 }).director.id;
const SSH_PW = 'ssh-Secret-2841';
const DIR_BODY = { directorId: DIR, host: '10.20.30.40', username: 'root', password: SSH_PW, restoreClient: 'kr-fd', restoreStorage: 'File', restorePool: 'Full' };
const acl = (s) => /Command ACL = ([^'`\n]+)/.exec(s)?.[1].trim();

test('① 스케줄 목록은 .schedule — catalogLists 명령 · Profile ACL(서버 = 웹) · 데모 Director', async () => {
  const sent = [];
  const session = { call: async (cmd) => { sent.push(cmd); return cmd === '.schedule' ? { schedules: [{ name: 'WeeklyCycle', enabled: true }, { name: 'PortalVmwareNightly', enabled: true }] } : { x: [] }; } };
  const r = await catalogLists(session);
  assert.ok(sent.includes('.schedule'), '.schedule 을 보낸다');
  assert.ok(!sent.includes('.schedules'), 'Bareos 에 없는 .schedules 를 보내지 않는다');
  assert.deepEqual(r.schedules, ['PortalVmwareNightly', 'WeeklyCycle']);
  assert.equal(r.errors.schedules, undefined);

  const server = acl(A.directorResources({ defaults: {}, consoleName: 'portal', consolePassword: 'x', restoreClient: 'c', restoreStorage: 's', restorePool: 'p' }).find((x) => x.type === 'profile').text);
  const web = acl(W.directorPrepBlock({}));
  assert.equal(server, web, '서버 자동 설정과 웹 안내 블록이 같은 줄');
  const items = server.split(',').map((x) => x.trim());
  assert.ok(items.includes('.schedule'));
  assert.ok(!items.includes('.schedules'));
  // Bareos ACL 은 처음 맞는 항목을 따른다(ua_acl.cc FindInAclList) — 허용 항목은 맨 끝 !*all* 앞에 있어야 한다
  assert.ok(items.indexOf('.schedule') < items.indexOf('!*all*'));
  assert.equal(items.at(-1), '!*all*');

  assert.ok(Array.isArray(demoCall('.schedule', { sites: [] }).schedules), '데모 Director 도 .schedule 에 답한다');
});

/** 사전 점검 출력(최소 · @@own 포함). */
const PF = (own) => ['@@id', '0', '@@layout', 'D', 'C', '@@res', 'client bareos-fd', ...(own === undefined ? [] : ['@@own', ...own]), '@@end'].join('\n');

test('② parsePreflight @@own — 아는 종류·이름·상태만 · 구역이 없거나 잘리면 null · 사람이 만든 콘솔 항목', () => {
  const r = A.parsePreflight(PF(['console admin F', 'console portal M', 'profile webui-admin F', 'pool Full X', 'job PortalVmwareRestore F', 'console bad;name F', 'console x Q', 'garbage']));
  assert.deepEqual(r.confFiles, [
    { type: 'console', name: 'admin', state: 'foreign' }, { type: 'console', name: 'portal', state: 'managed' },
    { type: 'profile', name: 'webui-admin', state: 'foreign' }, { type: 'pool', name: 'Full', state: 'notfile' },
  ], 'job·잘못된 이름·모르는 상태 글자·쓰레기 줄은 버린다');
  const con = r.items.find((x) => x.key === 'consoles');
  assert.equal(con.detail, 'admin');
  assert.match(con.hint, /덮지 않습니다/);
  assert.equal(A.parsePreflight(PF(undefined)).confFiles, null, '구역이 없으면(옛 판·엣지) 모름');
  assert.equal(A.parsePreflight(PF(['console admin F']).replace('@@end', '')).confFiles, null, '출력이 끝까지 오지 않으면 모름(없다고 단정하지 않는다)');
  assert.deepEqual(A.parsePreflight(PF([])).confFiles, [], '읽었고 비어 있음');
  assert.ok(!A.parsePreflight(PF([])).items.some((x) => x.key === 'consoles' && x.status !== 'ok'));
  const many = A.parsePreflight(PF(Array.from({ length: 500 }, (_, i) => `profile p${i} F`)));
  assert.ok(many.confFiles.length <= A.OWN_TYPES.length * 40, '상한');
  assert.ok(!A.OWN_TYPES.includes('job'), 'job 은 읽지 않는다(포탈이 등록한 VM 잡 파일이 잡마다 하나)');
});

test('② 사전 점검 스크립트 @@own 을 실제 bash 로 — 표지 · 남의 파일 · 심링크 · 디렉터리 · 종류당 40개 · job 무시 · 내용은 싣지 않는다', async (t) => {
  if (!fs.existsSync('/bin/bash')) { t.skip('bash 없음'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2841-dir-'));
  for (const d of ['console', 'profile', 'pool', 'job']) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, 'console/admin.conf'), 'Console {\n  Name = admin\n  Password = "TopSecretAdminPw"\n}\n');
  fs.writeFileSync(path.join(root, 'console/portal.conf'), `${A.MARKER}\nConsole {}\n`);
  fs.writeFileSync(path.join(root, 'console/near.conf'), `${A.MARKER} x\nConsole {}\n`);   // 표지와 글자가 다르면 남의 파일
  fs.symlinkSync('/etc/hostname', path.join(root, 'profile/linked.conf'));
  fs.mkdirSync(path.join(root, 'pool/odd.conf'));
  for (let i = 0; i < 45; i += 1) fs.writeFileSync(path.join(root, `profile/p${String(i).padStart(2, '0')}.conf`), 'Profile {}\n');
  fs.writeFileSync(path.join(root, 'job/vm-1.conf'), 'Job {}\n');
  let script = '';
  A._setDepsForTest({ ssh: async (creds, fn) => fn({ exec: async (cmd) => { script = cmd; return { code: 0, stdout: execFileSync('/bin/bash', ['-c', cmd.split(A.DIR_CONF_ROOT).join(root)], { encoding: 'utf8' }), stderr: '' }; } }) });
  try {
    const r = await A.preflight({ host: '10.20.30.40', password: SSH_PW }, { dir: { id: DIR } });
    const by = (type, name) => r.confFiles.find((x) => x.type === type && x.name === name)?.state;
    assert.equal(by('console', 'admin'), 'foreign');
    assert.equal(by('console', 'portal'), 'managed');
    assert.equal(by('console', 'near'), 'foreign');
    assert.equal(by('profile', 'linked'), 'notfile', '심링크는 따라 읽지 않는다');
    assert.equal(by('pool', 'odd'), 'notfile');
    assert.equal(r.confFiles.filter((x) => x.type === 'profile').length, 40, '종류당 40개');
    assert.ok(!r.confFiles.some((x) => x.type === 'job'));
    assert.ok(!JSON.stringify(r).includes('TopSecretAdminPw'), '파일 내용은 결과에 없다');
    assert.ok(!r.items.some((x) => x.key === 'output'), '출력이 끝까지 왔다(@@end)');
    assert.ok(!script.includes(SSH_PW));
  } finally { A._setDepsForTest(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('③ 2단계가 사람이 만든 콘솔에 막히면: 아무것도 쓰지 않고 \'만들 콘솔 이름\' 을 포탈 전용 이름으로 바꾸라고 말한다', async () => {
  const srv = fakeServer({ files: { '/etc/bareos/bareos-dir.d/console/admin.conf': 'Console {\n  Name = "admin"\n}\n' } });
  A._setDepsForTest({ ssh: srv.ssh, openConsole: fakeConsole().open, sleep: async () => {} });
  try {
    await assert.rejects(A.setupDirector({ ...DIR_BODY, consoleName: 'admin' }), (e) => {
      assert.equal(e.code, 'conflict');
      assert.deepEqual(e.paths, ['/etc/bareos/bareos-dir.d/console/admin.conf']);
      assert.match(e.message, /콘솔 ‘admin’/);
      assert.match(e.message, /만들 콘솔 이름/);
      assert.match(e.message, /포탈 전용 이름으로 바꿔/);
      assert.ok(!/예: /.test(e.message), '비었는지 모르는 이름을 예로 들지 않는다(화면이 사전 점검으로 고른다)');
      assert.match(e.message, /아무것도 바꾸지 않았습니다/);
      assert.ok(!e.message.includes('`'));
      return true;
    });
    assert.equal(srv.st.writes.length, 0, '쓰기 없음');
    assert.equal(srv.st.reloads, 0);
  } finally { A._setDepsForTest(); }
  // 종류별 안내
  assert.match(A.conflictMessage([{ type: 'console', name: 'portal', path: '/x/console/portal.conf' }], 'portal'), /콘솔 ‘portal’ 은\(는\) 이미 있고/);
  assert.match(A.conflictMessage([{ type: 'profile', name: 'portal', path: '/x/profile/portal.conf' }], 'portal'), /Profile ‘portal’/);
  assert.match(A.conflictMessage([{ type: 'jobdefs', name: 'PortalVmwareDefaults', path: '/x' }], 'portal'), /설정 탭 기본값/);
  assert.match(A.conflictMessage([{ type: 'pool', name: 'PortalVmwareFull', path: '/x' }], 'portal'), /전용 Pool · Schedule 만들기를 끄고/);
});

test('④ 엣지 정제 — setup.preflight confFiles: 아는 종류·이름·상태만 · 없으면 null', () => {
  const v = VALUE['setup.preflight']({ items: [], resources: {}, confFiles: [
    { type: 'console', name: 'admin', state: 'foreign', extra: 'x' }, { type: 'job', name: 'a', state: 'foreign' }, { type: 'console', name: 'a b', state: 'foreign' },
    { type: 'pool', name: 'Full', state: 'weird' }, null, 'str', { type: 'constructor', name: 'x', state: 'managed' },
  ] });
  assert.deepEqual(v.confFiles, [{ type: 'console', name: 'admin', state: 'foreign' }]);
  assert.equal(VALUE['setup.preflight']({ items: [], resources: {} }).confFiles, null);
  assert.equal(VALUE['setup.preflight']({ confFiles: Array.from({ length: 1000 }, () => ({ type: 'console', name: 'a', state: 'managed' })) }).confFiles.length, A.OWN_TYPES.length * 40);
});

test('⑤ 매핑 제안 — 못 읽은 목록(null)은 unread · 빈 목록은 그대로 비어 있음', async () => {
  const { suggestMapping } = await import('../src/routes/api/bareosBackup.js');
  const [s] = suggestMapping({ director: { id: 'd' }, sites: [{ vcenterId: 'vc-a', directorId: 'd' }], catalog: { clients: ['bareos-fd'], storages: [], pools: ['Full'], schedules: null }, vcenters: [] });
  assert.equal(s.fields.schedule.value, '');
  assert.equal(s.fields.schedule.unread, true);
  assert.match(s.fields.schedule.why, /읽지 못함/);
  assert.equal(s.fields.storage.unread, undefined);
  assert.match(s.fields.storage.why, /비어 있음/);
  assert.equal(s.fields.client.value, 'bareos-fd');
});

test('⑥ 웹 directorPlanFiles = 서버 directorResources 의 종류·이름(겹침 판정이 같은 파일을 본다)', () => {
  const pick = (a) => a.map((x) => `${x.type}/${x.name}`);
  for (const o of [
    { defaults: {}, consoleName: 'portal', pools: null, schedule: null },
    { defaults: { fileSet: 'FsX', jobDefs: 'JdX', restoreJob: 'RjX' }, consoleName: 'pc2', pools: { fullDays: 9, incrDays: 3, maxVolumeGB: 5 }, schedule: { fullDay: 'sun', time: '02:00' } },
  ]) {
    const server = A.directorResources({ ...o, consolePassword: 'x', restoreClient: 'c', restoreStorage: 's', restorePool: 'p' });
    assert.deepEqual(pick(W.directorPlanFiles({ defaults: o.defaults, consoleName: o.consoleName, pools: !!o.pools, schedule: !!o.schedule })), pick(server));
  }
  assert.equal(W.DIR_CONF_ROOT, A.DIR_CONF_ROOT);
});
