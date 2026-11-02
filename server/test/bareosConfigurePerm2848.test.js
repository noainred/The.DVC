/**
 * test/bareosConfigurePerm2848.test.js — v2.848 잡 만들기 권한(configure) 판정(사용자 화면: 백업 대상 1대 등록 실패 'configure: is an invalid command.').
 *  ① configurePermission — 막힘('is an invalid command') false · 사용법 응답(jsonrpc) true · 성공 true · 그 밖 오류 null(모름 — 단정하지 않는다)
 *  ② 연결 진단에 '잡 만들기 권한' 단계 — 막혀도 연결 성공(ok)은 그대로 · 그 줄만 실패 · 조치 안내
 *  ③ 엣지 대행 연결 시험(probe) 회신 정제 — configure 칸(옛 엣지는 null)
 *  ④ 등록 실패 사유 — Director 원문 대신 원인 · 조치(원문은 끝에)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2848-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 가짜 Director 가 127.0.0.1 에 있다(bareosDiagnose2822 와 같은 방식)

const CP = await import('../src/bareos/configurePerm.js');
const { diagnoseConsole, DIAG_STAGES, BareosConsoleError } = await import('../src/bareos/console.js');
const { sanitizeEdgeResult } = await import('../src/bareos/edgeResult.js');
const { probe } = await import('../src/bareos/director.js');
const S = await import('../src/bareos/settings.js');
const REG = await import('../src/bareos/registry.js');
const svc = await import('../src/bareos/service.js');
const W = await import('../../web/src/views/tools/bareosText.js');
const { store } = await import('../src/store.js');
const { startFakeDirector } = await import('./_fakeBareosDirector.js');

const servers = [];
after(async () => { for (const s of servers) await s.close(); svc._setSessionFactoryForTest(null); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
const DENIED = 'configure: is an invalid command.';
const jsonrpcErr = (m) => new BareosConsoleError('jsonrpc', m);

test('① configurePermission — 막힘 · 허용(사용법 응답 · 성공) · 모름', async () => {
  const sess = (fn) => ({ call: async (cmd) => { assert.equal(cmd, 'configure', '인자 없는 configure 만 보낸다(아무것도 만들지 않는다)'); return fn(); } });
  assert.equal((await CP.configurePermission(sess(() => { throw jsonrpcErr(DENIED); }))).allowed, false);
  assert.equal((await CP.configurePermission(sess(() => { throw jsonrpcErr('usage: configure add <resourcetype> <key1>=<value1> ...'); }))).allowed, true);
  assert.equal((await CP.configurePermission(sess(() => ({})))).allowed, true);
  const t = await CP.configurePermission(sess(() => { throw new BareosConsoleError('timeout', '시한'); }));
  assert.equal(t.allowed, null, '그 밖 오류는 막힘으로 단정하지 않는다');
  assert.match(t.detail, /확인하지 못했습니다/);
  // 여러 오류 문구가 이어 붙어도 찾는다(jsonRpcErrorText 는 ' / ' 로 잇는다)
  assert.equal((await CP.configurePermission(sess(() => { throw jsonrpcErr(`경고 / ${DENIED}`); }))).allowed, false);
});

test('② 연결 진단 — 잡 만들기 권한 단계(막혀도 연결 성공 · 그 줄만 실패 · 조치 안내)', async () => {
  assert.deepEqual(DIAG_STAGES.at(-1), ['configure', '잡 만들기 권한(configure)']);
  const mk = async (cfg) => {
    const fd = await startFakeDirector({ name: 'portal', password: 'pw-1', handle: (cmd) => (cmd === '.clients' ? { clients: [{ name: 'kr-fd' }] } : cmd === 'configure' ? cfg : {}) });
    servers.push(fd);
    return diagnoseConsole({ host: '127.0.0.1', port: fd.port, name: 'portal', password: 'pw-1', timeoutMs: 4000 });
  };
  const denied = await mk({ error: DENIED });
  const row = denied.stages.find((x) => x.key === 'configure');
  assert.equal(denied.ok, true, '연결 · 인증은 맞다(연결 시험 성공 · 인증 정지 해제는 그대로)');
  assert.equal(row.ok, false); assert.equal(row.code, 'acl');
  assert.match(row.hint, /등록할 수 없습니다/); assert.match(row.hint, /자동 설정 2단계/);
  assert.deepEqual(denied.configure.allowed, false);
  assert.equal(W.diagView(row).mark, '✗ 실패');
  const allowed = await mk({ error: 'usage: configure add <resourcetype> ...' });
  assert.equal(allowed.stages.find((x) => x.key === 'configure').ok, true);
  assert.equal(allowed.configure.allowed, true);
  // 화면: 연결 시험 성공 문구에 붙는 한 줄
  assert.match(W.configurePermNote({ allowed: false }), /잡 만들기 권한\(configure\)이 없어/);
  assert.equal(W.configurePermNote({ allowed: true }), '');
  assert.match(W.configurePermNote({ allowed: null }), /확인하지 못했습니다/);
  assert.equal(W.configurePermNote(null), '', '옛 엣지 · 데모는 말하지 않는다');
  assert.equal(W.diagView({ key: 'configure', unknown: true }).mark, '? 모름');
});

test('③ 엣지 대행 연결 시험 — probe 가 권한도 보고 · 회신 정제가 칸을 지킨다(옛 엣지는 null)', async () => {
  const s = { info: { banner: 'OK: bareos-dir Version: 25.0.4 (01 Jan 2026)', tls: null }, call: async (cmd) => { if (cmd === '.clients') return { clients: [{ name: 'kr-fd' }] }; if (cmd === 'configure') throw jsonrpcErr(DENIED); return {}; } };
  const p = await probe(s);
  assert.equal(p.configure.allowed, false);
  const v = sanitizeEdgeResult('probe', { ok: true, value: p }).value;
  assert.deepEqual(v.configure, { allowed: false, detail: DENIED });
  assert.equal(sanitizeEdgeResult('probe', { ok: true, value: { director: 'd', version: '25' } }).value.configure, null);
  assert.deepEqual(sanitizeEdgeResult('probe', { ok: true, value: { configure: { allowed: 'yes', detail: 'x\ny', extra: 1 } } }).value.configure, { allowed: null, detail: 'x y' }, '아는 칸만 · 불리언만');
  const route = fs.readFileSync(new URL('../src/routes/api/bareosBackup.js', import.meta.url), 'utf8');
  assert.match(route, /clientsError: '', configure: d\.configure, stages: d\.stages/);
});

test('④ 등록 실패 사유 — configure 가 막혔으면 원인 · 조치(원문은 끝에) · 그 밖 원문 그대로', async () => {
  const t = CP.addJobFailText(DENIED);
  assert.match(t, /잡 만들기 명령\(configure\)/); assert.match(t, /Command ACL/); assert.match(t, /자동 설정 2단계/); assert.match(t, /Director 원문: configure: is an invalid command\./);
  assert.ok(!t.includes('`'), '화면 문구에 백틱 없음(BoldText)');
  assert.equal(CP.addJobFailText('client "x" not found'), 'client "x" not found');
  // 실제 일괄 등록 경로(중앙 직접 세션)
  const DIR = S.addDirector({ name: '기본', host: '10.20.30.40', port: 9101, consoleName: 'admin' }).director.id;
  S.saveSettings({ sites: [{ vcenterId: 'vc-a', directorId: DIR, vcserver: 'vc-a.corp', client: 'kr-fd', storage: 'File', pool: 'VMwareKR', configFile: '/etc/bareos/vmware/vc-a.ini' }] });
  const prev = store.snapshot;
  store.snapshot = { generatedAt: Date.now(), source: 'mock', vcenters: [{ id: 'vc-a', name: 'Seoul' }], hosts: [], datastores: [], alarms: [], networks: [],
    vms: [{ id: 'vc-a:vm-10', vcenterId: 'vc-a', name: 'LESTNTP01', powerState: 'POWERED_ON', vcDcPath: 'Datacenter', folderPath: '/A.MGMT/04.NTP' }] };
  svc._setSessionFactoryForTest(async () => ({
    info: { banner: 'OK: bareos-dir Version: 25.0.4 (01 Jan 2026)' }, close() {},
    call: async (cmd) => { if (cmd.startsWith('configure add job')) throw jsonrpcErr(DENIED); return {}; },
  }));
  try {
    const out = await svc.createBackupTargets({ vcenterId: 'vc-a', vmIds: ['vc-a:vm-10'], level: 'Incremental', schedule: '', by: 'adm' });
    assert.equal(out[0].ok, false);
    assert.match(out[0].reason, /Command ACL/, out[0].reason);
    assert.equal(REG.jobCount(), 0, '원장에 쓰지 않았다');
    await assert.rejects(svc.createBackupTarget({ vcenterId: 'vc-a', vmId: 'vc-a:vm-10', level: 'Incremental', schedule: '', by: 'adm' }), (e) => /Command ACL/.test(e.message));
  } finally { store.snapshot = prev; svc._setSessionFactoryForTest(null); }
  // 다시 등록 경로도 같은 판정을 쓴다
  const ms = fs.readFileSync(new URL('../src/bareos/manage/service.js', import.meta.url), 'utf8');
  assert.match(ms, /x\.o\.reason = addJobFailText\(r\.message\)/);
});
