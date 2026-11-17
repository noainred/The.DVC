/**
 * decideRegistry3189.test.js — 결정(78 남긴 것) 권장안 회귀(사용자 '결정 필요한 것은 권장 사항으로 진행해줘').
 *  ① 공용 등록부(util/registryCore.js makeLoadError.read)의 **읽기 오류**(EIO · EISDIR)는 손상이 아니다 — 원본을 옮기지 않고 · 캐시하지 않고(30초마다 다시 읽음) ·
 *     쓰기를 거절한다(409). 손상(parse 실패)은 예전 그대로 보존본으로 옮기고 관리자 저장이 푼다(v2.612). PDU · 스토리지 · SAN · CVP · bmstor · Veeam · Veeam EM · 집중 모니터링.
 *  ③ CSV 빈 칸 계약 — PDU · 스토리지 · SAN 가져오기의 **수정 행** 빈 칸은 저장값 유지, 값을 지우려면 `-` 하나(새 장비는 예전 그대로 기본값).
 *  ④ 엣지 PDU 스냅샷의 모르는 최상위 키는 버리고 개수를 표지로 남긴다(아는 키 = 엣지 워커가 실제로 만드는 키).
 * 읽기 오류는 fs.readFileSync 를 그 파일에서만 EIO 로 던지게 바꿔 재현한다(테스트가 root 로 돌면 chmod 000 은 읽힌다 · EISDIR 은 쓰기도 실패해 '덮어쓰기' 를 보여 주지 못한다).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decide3189-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

const ADMIN = { username: 'full', role: 'admin', scope: null };
let srv; let base; let jl; let now;
// 기준 시각 — 실제 시각에서 정시 경계로 떨어뜨려 고정(docs/rules/common.md)
const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000;

/** 그 파일의 readFileSync 만 EIO 로 던진다(읽은 횟수를 센다). 돌려준 함수로 되돌린다. */
function failReads(file) {
  const orig = fs.readFileSync;
  const st = { n: 0 };
  fs.readFileSync = function patched(p, ...rest) {
    if (path.resolve(String(p)) === path.resolve(file)) { st.n += 1; const e = new Error(`EIO: i/o error, read '${file}'`); e.code = 'EIO'; throw e; }
    return orig.call(this, p, ...rest);
  };
  st.restore = () => { fs.readFileSync = orig; };
  return st;
}
const corruptCopies = (name) => fs.readdirSync(tmp).filter((n) => n.startsWith(`${name}.corrupt.`));
const advance = (ms) => { now += ms; };

before(async () => {
  jl = await import('../src/util/jsonFileLoad.js');
  now = T0;
  jl._setJsonFileLoadClockForTest(() => now);
  const express = (await import('express')).default;
  const { registerPdu } = await import('../src/routes/api/pdu.js');
  const { registerStorageMon } = await import('../src/routes/api/storageMon.js');
  const { registerSanSwitch } = await import('../src/routes/api/sanSwitch.js');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = ADMIN; next(); });
  const router = express.Router();
  registerPdu(router); registerStorageMon(router); registerSanSwitch(router);
  app.use('/api', router);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
});
after(() => {
  try { jl?._setJsonFileLoadClockForTest(); } catch { /* */ }
  try { srv?.close(); } catch { /* */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

async function call(method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { s: r.status, j: await r.json().catch(() => null) };
}

/* ── ① 공용 판정 ───────────────────────────────────────────────────────────── */

test('① registryCore.read — 읽기 오류는 원본을 두고 readError 표지 · 30초 간격 · 쓰기 거절, 손상은 예전처럼 보존본으로', async () => {
  const core = await import('../src/util/registryCore.js');
  const f = path.join(tmp, 'core-probe.json');
  fs.writeFileSync(f, JSON.stringify({ devices: [{ id: 'a' }] }));
  const L = core.makeLoadError();
  const io = failReads(f);
  try {
    const r = L.read(f);
    assert.equal(r.kind, 'read-error');
    assert.equal(L.get()?.readError, true);
    assert.match(L.get().reason, /EIO/);
    assert.equal(L.readPending(), true);
    assert.equal(core.summarizeRegistryError(L.get())?.code, 'read-error');
    assert.equal(core.summarizeRegistryError(L.get())?.sysCode, 'EIO');
    const ref = L.writeRefusal('시험 등록부');
    assert.equal(ref?.status, 409); assert.equal(ref?.code, 'registry-unreadable'); assert.equal(ref?.readError, true);
    assert.throws(() => L.assertWritable('시험 등록부'), (e) => e.status === 409 && e.readError === true);
    const at = L.get().at;
    L.read(f);
    assert.equal(io.n, 1, '간격(30초) 안에는 디스크를 다시 보지 않는다');
    advance(31_000);
    L.read(f);
    assert.equal(io.n, 2);
    assert.equal(L.get().at, at, '이어지는 읽기 오류는 처음 시각을 유지한다');
  } finally { io.restore(); }
  assert.deepEqual(corruptCopies('core-probe.json'), [], '읽기 오류로 보존본을 만들지 않는다');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).devices[0].id, 'a', '원본은 그 자리에 그대로');
  advance(31_000);
  const ok = L.read(f);
  assert.equal(ok.kind, 'ok');
  assert.equal(L.get(), null, '읽히면 그 오류만 지운다(재시작 · 사람 조치 없이)');
  assert.equal(L.readPending(), false);
  assert.equal(L.writeRefusal('x'), null);
  // 손상은 예전과 같다 — 보존본으로 옮기고 오류(readError 아님) · 쓰기 거절 없음(v2.612 관리자 저장이 푼다)
  fs.writeFileSync(f, '{"devices": [');
  const c = L.read(f);
  assert.equal(c.kind, 'corrupt');
  assert.equal(corruptCopies('core-probe.json').length, 1);
  assert.ok(L.get() && !L.get().readError);
  assert.equal(L.writeRefusal('x'), null, '손상은 이 거절 대상이 아니다(관리자 저장이 새 등록부를 만든다)');
});

/**
 * 등록부마다: 원본(자격증명) 파일을 쓰고 → 읽기 오류 → 목록 빈 값 · 표지 · 보존본 없음 · 저장 · 삭제 · pull 거절(원본 그대로) → 풀리면 원래 목록.
 */
const REGS = [
  { name: 'pdu', mod: '../src/pdu/registry.js', file: 'pdu-devices.json', body: { devices: [{ id: 'p1', name: 'P1', host: '10.1.0.1', username: 'apc', password: 'pw-p1', sshPort: 22, agent: '' }] },
    list: (m) => m.listDevices(), err: (m) => m.registryLoadError(), reset: (m) => m._resetForTest(),
    save: (m) => m.saveDevice({ name: 'NEW', host: '10.1.0.9', username: 'apc', password: 'x' }), del: (m) => m.deleteDevice('p1'), pull: (m) => m.applyPulledDevices([]) },
  { name: 'storage', mod: '../src/storage/registry.js', file: 'storage-devices.json', body: { version: 1, devices: [{ id: 's1', type: 'unity480', name: 'S1', host: '10.2.0.1', username: 'u', password: 'pw-s1', agent: '' }] },
    list: (m) => m.listDevices(), err: (m) => m.registryLoadError(), reset: (m) => m._resetForTest(),
    save: (m) => m.saveDevice({ type: 'unity480', name: 'NEW', host: '10.2.0.9', username: 'u', password: 'x' }), del: (m) => m.deleteDevice('s1'), pull: (m) => m.applyPulledDevices([]) },
  { name: 'sanswitch', mod: '../src/sanswitch/registry.js', file: 'sanswitch-devices.json', body: { version: 1, devices: [{ id: 'w1', type: 'brocade', name: 'W1', host: '10.3.0.1', username: 'u', password: 'pw-w1', agent: '' }] },
    list: (m) => m.listDevices(), err: (m) => m.registryLoadError(), reset: (m) => m._resetForTest(),
    save: (m) => m.saveDevice({ type: 'brocade', name: 'NEW', host: '10.3.0.9', username: 'u', password: 'x' }), del: (m) => m.deleteDevice('w1'), pull: (m) => m.applyPulledDevices([]) },
  { name: 'cvp', mod: '../src/cvp/registry.js', file: 'cvp-servers.json', body: { version: 1, servers: [{ id: 'c1', name: 'C1', host: 'https://10.4.0.1', authMode: 'token', token: 'tk-c1', agent: '' }] },
    list: (m) => m.listServers(), err: (m) => m.registryLoadError(), reset: (m) => m._resetForTest(),
    save: (m) => m.saveServer({ name: 'NEW', host: 'https://10.4.0.9', authMode: 'token', token: 'x' }), del: (m) => m.deleteServer('c1'), pull: (m) => m.applyPulledServers([]) },
  { name: 'veeam', mod: '../src/veeam/registry.js', file: 'veeam-servers.json', body: { version: 1, servers: [{ id: 'v1', name: 'V1', host: '10.5.0.1', port: 9419, username: 'u', password: 'pw-v1', agent: '' }] },
    list: (m) => m.listServers(), err: (m) => m.registryLoadError(), reset: (m) => m._resetForTest(),
    save: (m) => m.saveServer({ name: 'NEW', host: '10.5.0.9', username: 'u', password: 'x' }), del: (m) => m.deleteServer('v1'), pull: (m) => m.applyPulledServers([]) },
  { name: 'veeam-em', mod: '../src/veeam/em/registry.js', file: 'veeam-em.json', body: { version: 1, ems: [{ id: 'e1', name: 'E1', host: '10.6.0.1', port: 9398, username: 'u', password: 'pw-e1' }] },
    list: (m) => m.listEms(), err: (m) => m.emRegistryLoadError(), reset: (m) => m._resetEmRegistryForTest(),
    save: (m) => m.saveEm({ name: 'NEW', host: '10.6.0.9', username: 'u', password: 'x' }), del: (m) => m.deleteEm('e1'), pull: null },
];

for (const R of REGS) {
  test(`① ${R.name} 등록부 — 읽기 오류(EIO)는 원본을 옮기지 않고 · 빈 목록을 캐시하지 않고 · 저장 · 삭제 · pull 을 거절한다(원본 그대로)`, async () => {
    const m = await import(R.mod);
    const file = path.join(tmp, R.file);
    fs.writeFileSync(file, JSON.stringify(R.body));
    R.reset(m);
    const before = fs.readFileSync(file, 'utf8');
    assert.equal(R.list(m).length, 1, '정상 읽기');
    R.reset(m);
    const io = failReads(file);
    try {
      assert.deepEqual(R.list(m), []);
      const e = R.err(m);
      assert.equal(e?.readError, true, JSON.stringify(e));
      assert.match(e.reason, /EIO/);
      const run = (fn) => { try { return { r: fn(m) }; } catch (x) { return { x }; } };
      for (const [what, fn] of [['저장', R.save], ['삭제', R.del], ...(R.pull ? [['pull', R.pull]] : [])]) {
        const o = run(fn);
        const refused = o.x ? (o.x.status === 409 && o.x.readError === true) : (o.r && o.r.ok === false && o.r.status === 409 && o.r.readError === true);
        assert.ok(refused, `${R.name} ${what}: 읽기 오류 중에는 거절(409) — ${o.x ? o.x.message : JSON.stringify(o.r)}`);
      }
    } finally { io.restore(); }
    assert.deepEqual(corruptCopies(R.file), [], `${R.name}: 읽기 오류로 원본을 .corrupt 로 옮기지 않는다`);
    assert.equal(fs.readFileSync(file, 'utf8'), before, `${R.name}: 원본(자격증명) 파일이 그대로다`);
    // 간격(30초)이 지나면 다시 읽어 저절로 풀린다(재시작 없이)
    advance(31_000);
    assert.equal(R.list(m).length, 1, `${R.name}: 읽히면 원래 목록`);
    assert.equal(R.err(m), null);
    R.reset(m);
  });
}

test('① bmstor · 집중 모니터링 등록부 — 읽기 오류는 원본을 두고 쓰기를 거절한다(손상 문구가 아니라 읽기 오류 문구)', async () => {
  const bm = await import('../src/bmstor/registry.js');
  const bmFile = path.join(tmp, 'bm-storage.json');
  fs.writeFileSync(bmFile, JSON.stringify({ servers: [{ id: 'b1', name: 'B1', host: '10.7.0.1', username: 'u', password: 'pw-b1', groups: ['g'], mounts: ['/d'] }], settings: { intervalMinutes: 15 } }));
  const fmMod = await import('../src/focusmon/registry.js');
  const fmFile = path.join(tmp, 'focusmon-targets.json');
  fs.writeFileSync(fmFile, JSON.stringify({ targets: [], settings: {}, groups: [] }));
  fmMod._resetForTest();
  advance(31_000);   // bmstor 는 테스트 리셋이 없다 — 이 테스트의 첫 읽기가 디스크를 보게
  const bmBefore = fs.readFileSync(bmFile, 'utf8');
  const io = failReads(bmFile);
  const io2 = failReads(fmFile);
  try {
    // bmstor 모듈은 다른 테스트에서 캐시를 들었을 수 있다 — 첫 import 이므로 비어 있다
    assert.deepEqual(bm.listBmServers(), []);
    assert.equal(bm.registryLoadError()?.readError, true);
    for (const r of [bm.saveBmServer({ name: 'N', host: '10.7.0.9', username: 'u', password: 'x' }), bm.removeBmServer('b1'), bm.saveBmSettings({ intervalMinutes: 30 })]) {
      assert.equal(r.ok, false); assert.equal(r.status, 409); assert.equal(r.readError, true);
    }
    assert.equal(bm.applyBmServerBatch([{ name: 'N', host: '10.7.0.8', username: 'u', password: 'x' }]).ok, false);
    assert.equal(fmMod.registryLoadError()?.readError, true);
    const w = fmMod.saveSettings ? fmMod.saveSettings({}) : null;
    if (w) { assert.equal(w.ok, false); assert.equal(w.code, 'registry-unreadable'); assert.equal(w.readError, true); assert.match(w.reason, /읽기 오류/); }
  } finally { io2.restore(); io.restore(); }   // 겹쳐 바꿨으니 거꾸로 되돌린다
  assert.deepEqual(corruptCopies('bm-storage.json'), []);
  assert.deepEqual(corruptCopies('focusmon-targets.json'), []);
  assert.equal(fs.readFileSync(bmFile, 'utf8'), bmBefore);
  advance(31_000);
  assert.equal(bm.listBmServers().length, 1, '읽히면 원래 목록(재시작 없이)');
  assert.equal(bm.registryLoadError(), null);
  assert.equal(fmMod.registryLoadError(), null);
});

test('① iDRAC 등록부 — 읽기 오류는 원본을 두고(보존본 없음) 추가 · 수정 · 삭제를 409 로 거절하고, 읽히면 저절로 풀린다', async () => {
  const id = await import('../src/idrac/registry.js');
  const file = path.join(tmp, 'idrac.json');
  fs.writeFileSync(file, JSON.stringify({ servers: [{ id: 'i1', name: 'I1', host: '10.10.0.1', username: 'root', password: 'pw-i1' }] }));
  const before = fs.readFileSync(file, 'utf8');
  const io = failReads(file);
  try {
    assert.deepEqual(id.loadRegistry(), []);
    assert.equal(id.registryLoadError()?.readError, true);
    for (const r of [id.addServer({ id: 'i2', name: 'I2', host: '10.10.0.2', username: 'root', password: 'x' }), id.updateServer('i1', { name: 'X' }), id.removeServer('i1')]) {
      assert.equal(r.ok, false); assert.equal(r.status, 409, JSON.stringify(r)); assert.equal(r.readError, true);
    }
  } finally { io.restore(); }
  assert.deepEqual(corruptCopies('idrac.json'), []);
  assert.equal(fs.readFileSync(file, 'utf8'), before, '원본(자격증명) 파일이 그대로다');
  advance(31_000);
  assert.equal(id.loadRegistry().length, 1, '읽히면 원래 목록(재시작 없이)');
  assert.equal(id.registryLoadError(), null);
});

test('① 손상(parse 실패)은 예전 그대로 — 보존본으로 옮기고 관리자 저장이 푼다(v2.612), 사유는 손상', async () => {
  const pd = await import('../src/pdu/registry.js');
  const file = path.join(tmp, 'pdu-devices.json');
  fs.writeFileSync(file, '{"devices": [ {"id": "p1", "password": "Sec');
  pd._resetForTest();
  assert.deepEqual(pd.listDevices(), []);
  const e = pd.registryLoadError();
  assert.ok(e && !e.readError);
  assert.equal(corruptCopies('pdu-devices.json').length >= 1, true, '손상은 보존본으로 옮긴다');
  const r = pd.saveDevice({ name: 'NEW', host: '10.1.0.50', username: 'apc', password: 'x' });
  assert.equal(r.ok, true, '손상은 관리자 저장을 막지 않는다(새 등록부)');
  assert.equal(pd.registryLoadError(), null);
  for (const n of corruptCopies('pdu-devices.json')) fs.rmSync(path.join(tmp, n));
  pd._resetForTest();
});

test('① 라우트 — PDU · 스토리지 · SAN 저장 · 삭제 · CSV 가져오기는 읽기 오류 중 409(사유: 읽기 오류 · 원본 그대로)', async () => {
  const files = [['pdu-devices.json', { devices: [{ id: 'p1', name: 'P1', host: '10.1.0.1', username: 'apc', password: 'pw' }] }],
    ['storage-devices.json', { version: 1, devices: [{ id: 's1', type: 'unity480', name: 'S1', host: '10.2.0.1', username: 'u', password: 'pw' }] }],
    ['sanswitch-devices.json', { version: 1, devices: [{ id: 'w1', type: 'brocade', name: 'W1', host: '10.3.0.1', username: 'u', password: 'pw' }] }]];
  for (const [n, b] of files) fs.writeFileSync(path.join(tmp, n), JSON.stringify(b));
  for (const m of ['../src/pdu/registry.js', '../src/storage/registry.js', '../src/sanswitch/registry.js']) (await import(m))._resetForTest();
  const ios = files.map(([n]) => failReads(path.join(tmp, n)));
  try {
    const cases = [
      ['POST', '/tools/pdu/devices', { name: 'N', host: '10.1.0.9', username: 'apc', password: 'x' }],
      ['DELETE', '/tools/pdu/devices/p1'],
      ['POST', '/tools/pdu/csv/import', { csv: 'name,host\nP1,10.1.0.1\n' }],
      ['POST', '/tools/storage/devices', { type: 'unity480', name: 'N', host: '10.2.0.9', username: 'u', password: 'x' }],
      ['DELETE', '/tools/storage/devices/s1'],
      ['POST', '/tools/storage/devices/import', { csv: 'type,name,host\nunity480,S1,10.2.0.1\n', dryRun: true }],
      ['POST', '/tools/sanswitch/devices', { type: 'brocade', name: 'N', host: '10.3.0.9', username: 'u', password: 'x' }],
      ['DELETE', '/tools/sanswitch/devices/w1'],
      ['POST', '/tools/sanswitch/devices/import', { csv: 'type,name,host\nbrocade,W1,10.3.0.1\n', dryRun: true }],
    ];
    for (const [method, p, body] of cases) {
      const r = await call(method, p, body);
      assert.equal(r.s, 409, `${method} ${p}: ${JSON.stringify(r.j)}`);
      assert.match(String(r.j?.reason || ''), /읽기 오류/, `${method} ${p}`);
    }
  } finally { for (const io of ios.reverse()) io.restore(); }   // 겹쳐 바꿨으니 거꾸로 되돌린다
  for (const [n] of files) assert.deepEqual(corruptCopies(n), [], n);
  advance(31_000);
});

/* ── ③ CSV 빈 칸 계약 ─────────────────────────────────────────────────────── */

test('③ PDU CSV — 수정 행의 빈 agent · enabled · note · 법인 · 이름은 저장값 유지, `-` 는 비움, 새 장비는 예전처럼 기본값', async () => {
  const reg = await import('../src/pdu/registry.js');
  for (const n of fs.readdirSync(tmp).filter((x) => x.startsWith('pdu-devices.json'))) fs.rmSync(path.join(tmp, n), { recursive: true, force: true });
  reg._resetForTest();
  const s0 = reg.saveDevice({ name: 'EDGE-PDU', host: '10.9.0.1', username: 'admin', password: 'pw-9', sshPort: 2222, agent: 'edge-a', enabled: false, note: '랙 9', datacenterId: 'dc-9' });
  assert.equal(s0.ok, true, s0.reason);
  const csv = await import('../src/pdu/csv.js');
  const parsed = csv.csvToDevices('name,host,username,sshPort,datacenter,agent,enabled,note,password\n,10.9.0.1,,,,,,,\n');
  assert.deepEqual(parsed.rows[0]._blank.slice().sort(), ['agent', 'datacenterId', 'enabled', 'name', 'note', 'sshPort', 'username'].sort());
  assert.equal(csv.csvToDevices('name,host,agent\nX,10.9.0.1,-\n').rows[0]._blank?.includes('agent'), false, '`-` 는 빈 칸이 아니다(명시적 비움)');
  // 빈 칸만 있는 수정 행 — 아무것도 바뀌지 않는다(예전: agent '' → 중앙 직접 · enabled 켬 · note · 법인 지움 · 계정 apc · 포트 22 → 비밀번호 폐기)
  const a = await call('POST', '/tools/pdu/csv/import', { csv: 'name,host,username,sshPort,datacenter,agent,enabled,note,password\n,10.9.0.1,,,,,,,\n' });
  assert.equal(a.s, 200, JSON.stringify(a.j));
  assert.equal(a.j.updated, 1, JSON.stringify(a.j));
  const d = reg.getDeviceWithSecret(s0.device.id);
  assert.equal(d.agent, 'edge-a', '빈 agent 가 위임 장비를 중앙 직접으로 바꾸지 않는다');
  assert.equal(d.enabled, false, '빈 enabled 가 꺼 둔 장비를 켜지 않는다');
  assert.equal(d.note, '랙 9'); assert.equal(d.datacenterId, 'dc-9'); assert.equal(d.name, 'EDGE-PDU');
  assert.equal(d.username, 'admin'); assert.equal(d.sshPort, 2222); assert.equal(d.password, 'pw-9');
  // `-` = 명시적 비움 — agent 를 지우면 중앙 직접, note 도 지운다
  const b = await call('POST', '/tools/pdu/csv/import', { csv: 'name,host,agent,note\nEDGE-PDU,10.9.0.1,-,-\n' });
  assert.equal(b.j.updated, 1, JSON.stringify(b.j));
  const d2 = reg.getDeviceWithSecret(s0.device.id);
  assert.equal(d2.agent, ''); assert.equal(d2.note, ''); assert.equal(d2.enabled, false, '이 파일에 없는 enabled 는 그대로');
  // 새 장비는 예전처럼 기본값(빈 칸 · `-` 모두)
  const c = await call('POST', '/tools/pdu/csv/import', { csv: 'name,host,username,agent,enabled,password\nN9,10.9.0.2,,-,,pw\n' });
  assert.equal(c.j.added, 1, JSON.stringify(c.j));
  const n = reg.listDevices().find((x) => x.host === '10.9.0.2');
  assert.equal(n.username, 'apc'); assert.equal(n.sshPort, 22); assert.equal(n.agent, ''); assert.equal(n.enabled, true);
});

test('③ 스토리지 · SAN 가져오기 — 수정 행의 빈 칸은 저장값 유지(드라이런 · 저장 같은 행), `-` 는 비움 · 자유텍스트도 같은 규칙', async () => {
  const st = await import('../src/storage/registry.js');
  const sw = await import('../src/sanswitch/registry.js');
  for (const n of fs.readdirSync(tmp).filter((x) => x.startsWith('storage-devices.json') || x.startsWith('sanswitch-devices.json'))) fs.rmSync(path.join(tmp, n), { recursive: true, force: true });
  st._resetForTest(); sw._resetForTest();
  const s0 = st.saveDevice({ type: 'unity480', name: 'U-EDGE', host: '10.8.0.1', username: 'svc', password: 'pw-u', collectMethod: 'ssh', sshPort: 2200, agent: 'edge-b', enabled: false, note: '메모', datacenterId: 'dc-8' });
  const w0 = sw.saveDevice({ type: 'brocade', name: 'SW-EDGE', host: '10.8.0.2', username: 'admin', password: 'pw-w', collectMethod: 'ssh', sshPort: 2201, vfId: 7, agent: 'edge-b', enabled: false, note: '팹', datacenterId: 'dc-8' });
  const sc = await import('../src/storage/csv.js');
  assert.deepEqual(sc.parseDevicesCsv('type,name,host,agent,note\nunity480,,10.8.0.1,,-\n').rows[0]._blank.slice().sort(),
    ['agent', 'collectMethod', 'datacenter', 'enabled', 'name', 'sshPort', 'username'].sort(), '열 없음 · 빈 칸은 _blank, `-`(note)는 아님');
  // 드라이런: 수정 행 · 오류 없음(빈 이름 · 계정이 '누락' 으로 떨어지지 않는다)
  const dry = await call('POST', '/tools/storage/devices/import', { csv: 'type,name,host,username,collectMethod,sshPort,datacenter,agent,enabled,note,password\nunity480,,10.8.0.1,,,,,,,,\n', dryRun: true });
  assert.equal(dry.s, 200, JSON.stringify(dry.j));
  assert.equal(dry.j.summary.update, 1, JSON.stringify(dry.j.report));
  assert.equal(dry.j.summary.error, 0, JSON.stringify(dry.j.report));
  const imp = await call('POST', '/tools/storage/devices/import', { csv: 'type,name,host,username,collectMethod,sshPort,datacenter,agent,enabled,note,password\nunity480,,10.8.0.1,,,,,,,,\n' });
  assert.equal(imp.j.updated, 1, JSON.stringify(imp.j));
  const sd = st.getDeviceWithSecret(s0.id);
  assert.equal(sd.agent, 'edge-b'); assert.equal(sd.enabled, false); assert.equal(sd.note, '메모'); assert.equal(sd.datacenterId, 'dc-8');
  assert.equal(sd.collectMethod, 'ssh'); assert.equal(sd.sshPort, 2200); assert.equal(sd.username, 'svc'); assert.equal(sd.password, 'pw-u', '계정 · 포트가 그대로라 비밀번호도 그대로');
  // 자유텍스트 키=값 — 적은 칸만 바뀐다 · `-` 는 비움
  const txt = await call('POST', '/tools/storage/devices/import', { format: 'text', text: 'type=unity480 host=10.8.0.1 note=새메모 agent=-\n' });
  assert.equal(txt.j.updated, 1, JSON.stringify(txt.j));
  const sd2 = st.getDeviceWithSecret(s0.id);
  assert.equal(sd2.note, '새메모'); assert.equal(sd2.agent, '', '`-` 로 중앙 직접'); assert.equal(sd2.enabled, false); assert.equal(sd2.name, 'U-EDGE');
  // SAN — 같은 계약
  const swImp = await call('POST', '/tools/sanswitch/devices/import', { csv: 'type,name,host,username,collectMethod,sshPort,httpsPort,vfId,datacenter,agent,enabled,note,password\nbrocade,,10.8.0.2,,,,,,,,,,\n' });
  assert.equal(swImp.s, 200, JSON.stringify(swImp.j));
  assert.equal(swImp.j.updated, 1, JSON.stringify(swImp.j));
  const wd = sw.getDeviceWithSecret(w0.id);
  assert.equal(wd.agent, 'edge-b'); assert.equal(wd.enabled, false); assert.equal(wd.note, '팹'); assert.equal(wd.vfId, 7); assert.equal(wd.sshPort, 2201);
  assert.equal(wd.username, 'admin'); assert.equal(wd.password, 'pw-w'); assert.equal(swImp.j.droppedSecrets, undefined);
  const swClear = await call('POST', '/tools/sanswitch/devices/import', { csv: 'type,name,host,vfId,agent\nbrocade,SW-EDGE,10.8.0.2,-,-\n' });
  assert.equal(swClear.j.updated, 1, JSON.stringify(swClear.j));
  const wd2 = sw.getDeviceWithSecret(w0.id);
  assert.equal(wd2.vfId, null); assert.equal(wd2.agent, ''); assert.equal(wd2.enabled, false);
});

test('③ 공용 fillBlankFromSaved — 새 행(저장 없음)과 _blank 없는 행은 그대로', async () => {
  const { fillBlankFromSaved } = await import('../src/util/bulkImport.js');
  const rows = [{ host: 'a', agent: '', _blank: ['agent'] }, { host: 'b', agent: '', _blank: ['agent'] }, { host: 'a', agent: 'x' }];
  const out = fillBlankFromSaved(rows, (r) => (r.host === 'a' ? { agent: 'edge-a' } : null), { agent: (d) => d.agent });
  assert.equal(out[0].agent, 'edge-a'); assert.deepEqual(out[0]._kept, ['agent']);
  assert.equal(out[1], rows[1], '저장 장비가 없는 행(신규)은 그대로');
  assert.equal(out[2], rows[2]);
  assert.equal(rows[0].agent, '', '입력을 바꾸지 않는다(사본)');
});

/* ── ④ 엣지 PDU 스냅샷 최상위 키 ─────────────────────────────────────────── */

test('④ 엣지 PDU 스냅샷 — 모르는 최상위 키는 버리고 개수를 표지로 · 아는 키 목록은 엣지 워커가 만드는 키를 모두 덮는다', async () => {
  const pe = await import('../src/central/pduEdge.js');
  const { emptySnapshot } = await import('../src/pdu/types.js');
  const { demoPduSnapshot } = await import('../src/mock/demo/pdu.js');
  const known = new Set(pe.PDU_SNAPSHOT_KEYS);
  for (const k of Object.keys(emptySnapshot({ id: 'x' }))) assert.ok(known.has(k), `emptySnapshot 키 ${k}`);
  for (const k of Object.keys(demoPduSnapshot({ id: 'mock-pdu-1', name: 'd' }, T0))) assert.ok(known.has(k), `데모 스냅샷 키 ${k}`);
  // 수집기 · 폴러 소스의 `snap.<키> =` 대입(주석 제거 뒤)도 전부 아는 키다
  const { stripComments } = await import('./_stripComments.js');
  for (const f of ['../src/pdu/collectors/apcSsh.js', '../src/pdu/poller.js']) {
    const src = stripComments(fs.readFileSync(new URL(f, import.meta.url), 'utf8'));
    for (const m of src.matchAll(/\bsnap\.([A-Za-z_]\w*)\s*=(?!=)/g)) assert.ok(known.has(m[1]), `${f}: snap.${m[1]}`);
  }
  for (const k of ['edgeCollectedAt', 'edgeClockAheadMs']) assert.ok(known.has(k), `중앙 수신 스탬프 ${k}`);
  // 모르는 키는 버리고 센다 · 아는 키는 남는다
  const { snap, unknownKeys } = pe.sanitizePduSnapshot({ id: 'p1', ok: true, units: [], sensors: [], name: 'P', junk: 'x'.repeat(1000), __proto_like: { a: 1 }, summary: { powerW: 1 }, demo: 'yes' });
  assert.equal(unknownKeys, 3);
  assert.equal(Object.hasOwn(snap, 'junk'), false); assert.equal(Object.hasOwn(snap, 'summary'), false);
  assert.equal(snap.name, 'P'); assert.equal(snap.demo, false, 'demo 는 불리언만');
  const r = pe.saveEdgePdu('edge-k', [{ id: 'k1', ok: true, collectedAt: T0, units: [], sensors: [], extra1: 1, extra2: 2 }]);
  assert.equal(r.ok, true);
  assert.equal(r.unknownKeys, 2);
  const s = pe.edgePduSnapshots().find((x) => x.id === 'k1');
  assert.equal(Object.hasOwn(s, 'extra1'), false);
  assert.equal(s.agent, 'edge-k');
  assert.equal(pe.edgePduStatus().find((x) => x.agent === 'edge-k')?.unknownKeys, 2, '엣지별 보고 상태에 표지');
});
