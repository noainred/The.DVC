/**
 * test/bareosPortalRes2849.test.js — v2.849 포탈 리소스 점검(사용자 화면: configure 를 허용한 뒤 등록이
 *   'configure error: Could not find config resource "PortalVmwareDefaults" referenced on line 3: JobDefs = "PortalVmwareDefaults"' 로 실패).
 *  ① 등록 실패 사유 — 없는 리소스가 포탈 리소스(JobDefs · FileSet)면 자동 설정 2단계 · 사전 준비 블록 안내, 매핑 값(Client · Storage · Pool · Schedule)이면 매핑 안내
 *  ② portalResources — 목록 명령(읽기)으로 있음 · 없음 · 모름(명령 실패)을 가른다
 *  ③ 연결 진단 '포탈 리소스' 단계 — 없으면 그 줄만 실패(연결 성공 · 첫 실패 기록에 넣지 않음) · 이름을 안 주면 시도 안 함
 *  ④ 엣지 대행 연결 시험 — probe 가 이름을 받아 점검 · 회신 정제(옛 엣지 null) · 라우트가 공통 기본값을 넘긴다
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.SSRF_ALLOW_LOOPBACK = 'true';
const CP = await import('../src/bareos/configurePerm.js');
const { diagnoseConsole, DIAG_STAGES, BareosConsoleError } = await import('../src/bareos/console.js');
const { probe } = await import('../src/bareos/director.js');
const { OPS } = await import('../src/bareos/ops.js');
const { sanitizeEdgeResult } = await import('../src/bareos/edgeResult.js');
const W = await import('../../web/src/views/tools/bareosText.js');
const { startFakeDirector } = await import('./_fakeBareosDirector.js');

const servers = [];
after(async () => { for (const s of servers) await s.close(); });
const USER_MSG = 'configure error: Could not find config resource "PortalVmwareDefaults" referenced on line 3: JobDefs = "PortalVmwareDefaults" / configure error: Parser Error occurred.';
const EXPECT = { jobDefs: 'PortalVmwareDefaults', fileSet: 'PortalVmwareGeneric', restoreJob: 'PortalVmwareRestore' };

test('① 등록 실패 사유 — 포탈 리소스가 없음 · 매핑 값이 없음 · 그 밖 원문', () => {
  const t = CP.addJobFailText(USER_MSG);
  assert.match(t, /포탈 리소스 JobDefs ‘PortalVmwareDefaults’ 가 없습니다/);
  assert.match(t, /자동 설정 2단계/); assert.match(t, /사전 준비 블록/); assert.match(t, /Director 원문: configure error: Could not find config resource/);
  assert.ok(!t.includes('`'));
  const fsT = CP.addJobFailText('configure error: Could not find config resource "MyFs" referenced on line 4: FileSet = "MyFs"');
  assert.match(fsT, /포탈 리소스 FileSet ‘MyFs’/);
  const cl = CP.addJobFailText('configure error: Could not find config resource "kr-fd" referenced on line 5: Client = "kr-fd"');
  assert.match(cl, /Client ‘kr-fd’ 가 없습니다 — 이 값은 설정 › 기본 설정의 vCenter 매핑/);
  assert.equal(CP.addJobFailText('Director 가 연결을 닫았습니다.'), 'Director 가 연결을 닫았습니다.');
  assert.match(CP.addJobFailText('configure: is an invalid command.'), /Command ACL/, 'v2.848 판정은 그대로');
  assert.equal(CP.missingResourceOf('x'.repeat(100_000)), null, '긴 입력도 선형(앞 2,000자만)');
});

test('② portalResources — 있음 · 없음 · 모름', async () => {
  const lists = { '.jobdefs': { jobdefs: [{ name: 'DefaultJob' }] }, '.filesets': { filesets: [{ name: 'PortalVmwareGeneric' }] }, '.jobs': { jobs: [{ name: 'RestoreFiles' }, { name: 'PortalVmwareRestore' }] } };
  const sess = (over = {}) => ({ call: async (cmd) => { if (over[cmd]) throw over[cmd]; if (!lists[cmd]) throw new Error(`쓰기 명령 금지: ${cmd}`); return lists[cmd]; } });
  const r = await CP.portalResources(sess(), EXPECT);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing.map((x) => x.name), ['PortalVmwareDefaults']);
  assert.match(r.detail, /없음: JobDefs ‘PortalVmwareDefaults’/);
  lists['.jobdefs'].jobdefs.push({ name: 'PortalVmwareDefaults' });
  assert.equal((await CP.portalResources(sess(), EXPECT)).ok, true);
  const u = await CP.portalResources(sess({ '.filesets': new BareosConsoleError('jsonrpc', '.filesets: is an invalid command.') }), EXPECT);
  assert.equal(u.ok, null, '목록을 못 읽으면 없다고 단정하지 않는다');
  assert.deepEqual(u.unknown.map((x) => x.key), ['fileSet']);
  assert.equal((await CP.portalResources(sess(), { jobDefs: 'bad name;x' })).ok, null, '이름 모양이 아니면 보지 않는다');
});

test('③ 연결 진단 — 포탈 리소스 단계(없으면 그 줄만 실패 · 연결 성공 · 첫 실패에 넣지 않음)', async () => {
  assert.deepEqual(DIAG_STAGES.at(-1), ['resources', '포탈 리소스(JobDefs · FileSet · 복원 잡)']);
  const fd = await startFakeDirector({ name: 'portal', password: 'pw-1', handle: (cmd) => (
    cmd === '.clients' ? { clients: [{ name: 'kr-fd' }] } : cmd === '.jobdefs' ? { jobdefs: [{ name: 'DefaultJob' }] } : cmd === '.filesets' ? { filesets: [{ name: 'PortalVmwareGeneric' }] }
      : cmd === '.jobs' ? { jobs: [{ name: 'PortalVmwareRestore' }] } : {}) });
  servers.push(fd);
  const conn = { host: '127.0.0.1', port: fd.port, name: 'portal', password: 'pw-1', timeoutMs: 4000 };
  const r = await diagnoseConsole(conn, { expect: EXPECT });
  const row = r.stages.find((x) => x.key === 'resources');
  assert.equal(r.ok, true); assert.equal(r.failed, null, '점검 단계는 첫 실패 기록에 넣지 않는다');
  assert.equal(row.ok, false); assert.equal(row.code, 'missing');
  assert.match(row.detail, /PortalVmwareDefaults/); assert.match(row.hint, /Could not find config resource/);
  assert.equal(r.resources.ok, false);
  const plain = await diagnoseConsole(conn);
  assert.equal(plain.stages.find((x) => x.key === 'resources').skipped, true, '이름을 안 주면 시도 안 함(CLI · 옛 호출)');
  // 화면 한 줄
  assert.match(W.resourcesNote(r.resources), /포탈 리소스가 Director 에 없습니다\(JobDefs ‘PortalVmwareDefaults’\)/);
  assert.equal(W.resourcesNote({ ok: true, missing: [], unknown: [] }), '');
  assert.equal(W.resourcesNote(null), '');
});

test('④ 엣지 대행 — probe 가 이름을 받아 점검 · 회신 정제 · 라우트가 공통 기본값을 넘긴다', async () => {
  const s = { info: { banner: 'OK: bareos-dir Version: 25.0.4 (01 Jan 2026)', tls: null }, call: async (cmd) => (cmd === '.jobdefs' ? { jobdefs: [] } : cmd === '.filesets' ? { filesets: [{ name: 'PortalVmwareGeneric' }] } : cmd === '.jobs' ? { jobs: [{ name: 'PortalVmwareRestore' }] } : {}) };
  const p = await OPS.probe(s, { expect: EXPECT });
  assert.equal(p.resources.ok, false);
  assert.equal((await probe(s)).resources, null, '이름을 안 주면(옛 중앙) 점검하지 않는다');
  const v = sanitizeEdgeResult('probe', { ok: true, value: p }).value;
  assert.deepEqual(v.resources.missing, [{ key: 'jobDefs', label: 'JobDefs', name: 'PortalVmwareDefaults' }]);
  assert.equal(sanitizeEdgeResult('probe', { ok: true, value: { director: 'd' } }).value.resources, null, '옛 엣지는 null');
  assert.deepEqual(sanitizeEdgeResult('probe', { ok: true, value: { resources: { ok: 'no', missing: [{ name: 'a;b' }, { name: 'ok-1', key: 'k', label: 'L' }] } } }).value.resources.missing, [{ key: 'k', label: 'L', name: 'ok-1' }]);
  const route = fs.readFileSync(new URL('../src/routes/api/bareosBackup.js', import.meta.url), 'utf8');
  assert.match(route, /relayToEdge\(saved, 'probe', \{ expect \}\)/);
  assert.match(route, /diagnoseConsole\(conn, \{ expect \}\)/);
  assert.match(route, /configure: d\.configure, resources: d\.resources, stages: d\.stages/);
});
