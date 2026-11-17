/**
 * 전체 점검 121회차 — 118회차(vCenter 등록부 vcenters.json · 순서 파일) · 116회차 F1(NSX 등록부) · 메인 115 D1(런타임 설정) 수정의 적대적 재검토(반증).
 *
 *  R1(중간) config.js loadVcenterConfig — 후보 파일 유무를 fs.existsSync 로 갈랐다. existsSync 는 stat 이 어떤 이유로든 실패하면 false 라, 설정 폴더(상위)의
 *      탐색 권한을 잃거나(EACCES) 디스크 · NFS 오류면 **폴더 수준 읽기 오류가 '파일 없음'** 으로 읽혔다 — 마지막 원문을 버리고 readError 없는 빈 목록
 *      (118회차 F2 가 고친 증상 그대로: store 가 'vCenter 0개' 로 돌며 캐시 · 위임 인벤토리를 지운다) · 등록부 로더의 마지막 목록까지 사라졌다.
 *      → '없음' 은 ENOENT 뿐(공용 읽기 readJsonFile 과 같은 판정).
 *  R2(결정 → 권장안 구현) 같은 함수 — 주 후보를 **못 읽었고** 마지막 원문도 없으면 다음 후보(앱 폴더의 레거시 vcenters.json · 예제 템플릿)로 넘어가
 *      그 목록을 `file` 과 함께 돌려줬다 → store 의 '모름' 판정(readError && !file)을 지나 옛 목록(지운 vCenter · 옛 비밀번호)으로 수집. 이제 넘어가지 않는다.
 *  R3(중간) ping/monitor.js startPingMonitor · routes/ping.js — 기동 때 등록부를 못 읽으면 빈 목록으로 vCenter×포트 대상을 다시 만들어 전부 지웠다
 *      (사용자가 고친 기준값 · 켬/끔 포함 · 등록부가 다시 읽혀도 다음 재시작까지 돌아오지 않음). 동기화를 건너뛰고, 사람이 누른 동기화 · 포트 지정은 503.
 *  R4(낮음) nsx/registry.js — 마지막 목록(_lastGood)을 읽을 때만 맞췄다 → 저장 바로 뒤의 읽기 오류에 저장 **전** 목록(지운 매니저 · 옛 비밀번호).
 *  R5(낮음) web VCenterAdmin.jsx — 쓰기 거절 503(code 'registry-unreadable')을 화면 전체 ErrorBox 로 보내 '일시 미가용' 안내로 바뀌었다(삭제 · 점검중 전환).
 *  R6(낮음) store.js — 건너뛴 주기가 콘솔 한 줄뿐: storeStatus(중앙의 '빈 인벤토리' 진단)가 `registered:0 · lastError:null`('등록된 vCenter 가 없습니다').
 *
 * 기동 조건(마지막으로 읽은 목록이 없다)은 새 프로세스로 돌린다(118회차 테스트와 같은 방식 — 이 파일을 자식으로 다시 실행).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const WEB = path.join(HERE, '..', '..', 'web', 'src');
const quietly = async (fn) => {
  const w = console.warn; const e = console.error; const l = console.log;
  console.warn = () => {}; console.error = () => {}; console.log = () => {};
  try { return await fn(); } finally { console.warn = w; console.error = e; console.log = l; }
};

/* ── 자식 프로세스 ─────────────────────────────────────────────────────────────────────────── */
if (process.env.R121_CHILD) {
  const dir = process.env.CONFIG_DIR;
  const out = {};
  const express = createRequire(import.meta.url)('express');
  const CFG = await import('../src/config.js');
  await CFG.secretsReady;
  const PS = await import('../src/ping/store.js');
  const vcports = () => PS.listTargets().filter((t) => t.source === 'vcport').map((t) => `${t.id}|${t.baselineMs ?? '-'}|${t.enabled}`);

  if (process.env.R121_CHILD === 'ping-prepare') {
    const list = CFG.loadVcenterConfig().vcenters.map((v) => ({ id: v.id, name: v.name, host: v.host }));
    out.set = PS.setVcPorts([443, 902], list);
    const first = PS.listTargets().find((t) => t.source === 'vcport');
    out.edit = PS.updateTarget(first.id, { baselineMs: 250, enabled: false })?.ok;
    out.vcports = vcports();
  }

  if (process.env.R121_CHILD === 'boot-unreadable') {
    // R2: 못 읽은 주 후보 아래(예제 템플릿 — VCENTERS_EXAMPLE_FALLBACK=true)로 넘어가지 않는다
    const c = await quietly(() => CFG.loadVcenterConfig());
    out.cfg = { file: c.file, n: c.vcenters.length, readError: c.readError || null };
    // R6: 건너뛴 주기 — 사유가 storeStatus 에 남고 가드는 풀린다
    const { store, storeStatus } = await import('../src/store.js');
    await quietly(() => store.refresh({ scheduled: true }));
    const st = storeStatus();
    out.store = { refreshing: store._refreshing === true, statusRefreshing: st.refreshing, registered: st.registered, lastError: st.lastError };
    // R3: Ping 기동 동기화 + 사람이 누른 동기화 · 포트 지정
    out.before = vcports();
    const MON = await import('../src/ping/monitor.js');
    await quietly(() => MON.startPingMonitor());
    out.afterBoot = vcports();
    const { pingRouter } = await import('../src/routes/ping.js');
    const app = express(); app.use(express.json());
    app.use((req, _r, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
    app.use('/api/ping', pingRouter);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const call = async (method, p, body) => {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      let j = null; try { j = await r.json(); } catch { j = null; }
      return { status: r.status, code: j?.code ?? null, registryUnreadable: j?.registryUnreadable ?? null, reason: String(j?.reason || '') };
    };
    out.sync = await quietly(() => call('POST', '/api/ping/vcport/sync'));
    out.ports = await quietly(() => call('PUT', '/api/ping/vcport/ports', { ports: [443] }));
    out.afterRoutes = vcports();
    out.portsKept = PS.getVcPorts();
    srv.close();
    try { MON.stopPingMonitor(); } catch { /* */ }
  }

  if (process.env.R121_CHILD === 'ping-boot-ok') {
    const MON = await import('../src/ping/monitor.js');
    await quietly(() => MON.startPingMonitor());
    out.afterBoot = vcports();
    try { MON.stopPingMonitor(); } catch { /* */ }
  }

  if (process.env.R121_CHILD === 'dir-eacces') {
    // R1 실제 판(root 전용): 한 번 읽고(마지막 원문 확보) 권한을 내린다 — 설정 폴더(0700 root)를 탐색하지 못해 stat 이 EACCES(existsSync 는 false).
    const REG = await import('../src/vcenter/registry.js');
    const file = path.join(dir, 'vcenters.json');
    out.first = { n: CFG.loadVcenterConfig().vcenters.length, reg: REG.loadRegistry().length };
    let dropped = true;
    try { process.setgid(65534); process.setuid(65534); } catch { dropped = false; }   // uid 0 이어도 권한을 못 내리는 환경(사용자 네임스페이스 등)
    let code = null; try { fs.statSync(file); } catch (e) { code = e.code; }
    if (!dropped || code !== 'EACCES') out.skipped = `권한을 내려도 폴더 수준 오류가 나지 않는 환경(setuid ${dropped} · stat ${code})`;
    out.stat = { code, existsSync: fs.existsSync(file) };
    const c = await quietly(() => CFG.loadVcenterConfig());
    out.cfg = { file: c.file === file, n: c.vcenters.length, readError: c.readError || null };
    out.reg = (await quietly(() => REG.loadRegistry())).length;
    out.lastKept = CFG.lastVcenterConfigText(file) != null;
  }

  process.stdout.write(`\nR121=${JSON.stringify(out)}\n`);
  process.exit(0);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rebut121-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_DIR = TMP;
process.env.AUTH_ENABLED = 'false';
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
delete process.env.VCENTERS_EXAMPLE_FALLBACK;

const F = (n) => path.join(TMP, n);
const express = createRequire(import.meta.url)('express');

// 시계: 실제 시각에서 정시 경계로 떨어뜨려 고정(재읽기 간격 판정 — util/jsonFileRead.js nowMs).
const RD = await import('../src/util/jsonFileRead.js');
let NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
RD._setJsonFileLoadClockForTest(() => NOW);
const pass = (ms = RD.READ_RETRY_MS + 1_000) => { NOW += ms; };

const REG = await import('../src/vcenter/registry.js');
const NSX = await import('../src/nsx/registry.js');
const CFG = await import('../src/config.js');
const { store } = await import('../src/store.js');
await CFG.secretsReady;

const rmTmp = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } };
let srv = null;
after(() => { RD._setJsonFileLoadClockForTest(); srv?.close(); rmTmp(); process.once('exit', rmTmp); });

const vc = (id, extra = {}) => ({ id, name: `VC ${id}`, host: `https://${id}.corp.example`, username: 'svc', password: `pw-${id}`, location: { city: '', country: '', region: '아시아' }, enabled: false, ...extra });
const ids = (l) => l.map((v) => v.id);
const errOf = (code) => { const e = new Error(`${code}: injected`); e.code = code; return e; };

/**
 * 폴더 수준 읽기 오류를 흉내 낸다 — 실제 EACCES(상위 폴더 탐색 권한 없음)에서 Node 가 주는 그대로: existsSync 는 false · statSync · readFileSync 는 code 로 던진다.
 * (existsSync 까지 바꾸지 않으면 수정 전 판본이 '파일 있음 → 읽기 오류' 로 가서 결함을 못 가린다.)
 */
async function withDirError(name, code, fn) {
  const target = F(name);
  const o = { ex: fs.existsSync, st: fs.statSync, rd: fs.readFileSync };
  fs.existsSync = (p) => (String(p) === target ? false : o.ex.call(fs, p));
  fs.statSync = (p, ...a) => { if (String(p) === target) throw errOf(code); return o.st.call(fs, p, ...a); };
  fs.readFileSync = (p, ...a) => { if (String(p) === target) throw errOf(code); return o.rd.call(fs, p, ...a); };
  try { return await quietly(fn); } finally { fs.existsSync = o.ex; fs.statSync = o.st; fs.readFileSync = o.rd; }
}
async function withReadError(name, code, fn) {
  const target = F(name);
  const orig = fs.readFileSync;
  fs.readFileSync = (p, ...a) => { if (String(p) === target) throw errOf(code); return orig.call(fs, p, ...a); };
  try { return await quietly(fn); } finally { fs.readFileSync = orig; }
}
const child = (mode, dir, extraEnv = {}) => {
  const r = spawnSync(process.execPath, ['--experimental-sqlite', fileURLToPath(import.meta.url)], {
    env: { ...process.env, R121_CHILD: mode, CONFIG_DIR: dir, DATA_DIR: dir, DATA_SOURCE: 'live', AUTH_ENABLED: 'false', NODE_TEST_CONTEXT: '', ...extraEnv },
    encoding: 'utf8', timeout: 90_000,
  });
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('R121='));
  assert.ok(line, `자식(${mode}) 출력 없음: ${String(r.stderr || '').slice(-800)}`);
  return JSON.parse(line.slice('R121='.length));
};

/* ── R1 ─────────────────────────────────────────────────────────────────────────────────── */

test('R1 수집 로더: 폴더 수준 읽기 오류(stat 실패 — existsSync false)는 "파일 없음" 이 아니다 — 마지막 목록 + readError · 마지막 원문을 버리지 않는다', async () => {
  assert.equal(REG.addVcenter(vc('vc-a')).ok, true);
  assert.equal(REG.addVcenter(vc('vc-b')).ok, true);
  assert.deepEqual(ids(CFG.loadVcenterConfig().vcenters), ['vc-a', 'vc-b']);
  for (const code of ['EACCES', 'EIO', 'ESTALE']) {
    await withDirError('vcenters.json', code, () => {
      const c = CFG.loadVcenterConfig();
      assert.deepEqual(c.vcenters.map((v) => [v.id, v.password]), [['vc-a', 'pw-vc-a'], ['vc-b', 'pw-vc-b']], `${code}: 빈 목록(등록 0개)이 아니라 마지막으로 읽은 목록`);
      assert.equal(c.readError, code);
      assert.equal(c.file, F('vcenters.json'));
      assert.notEqual(CFG.lastVcenterConfigText(F('vcenters.json')), null, `${code}: 마지막 원문을 버렸다 — 등록부 로더의 마지막 목록도 사라진다`);
      assert.deepEqual(ids(REG.loadRegistry()), ['vc-a', 'vc-b'], `${code}: 두 로더가 같은 목록`);
    });
    pass();
    assert.equal(REG.registryLoadError(), null);
  }
});

test('R1 store: 폴더 수준 읽기 오류 주기에 수집 캐시 · 마지막 수집 시각 · 스냅샷의 vCenter 목록이 남는다', async () => {
  await quietly(() => store._refreshBody());   // 전부 비활성 — 망을 타지 않는다
  assert.deepEqual(ids(store.get().vcenters), ['vc-a', 'vc-b']);
  store.vcCache.set('vc-a', { ok: true, data: { marker: 1 }, at: 1 });
  store.vcLast.set('vc-a', 1);
  await withDirError('vcenters.json', 'EACCES', () => store._refreshBody());
  assert.deepEqual([...store.vcCache.keys()], ['vc-a'], '수집 캐시(lastGood)를 지웠다 — "vCenter 0개" 로 돈 것');
  assert.deepEqual([...store.vcLast.keys()], ['vc-a']);
  assert.deepEqual(ids(store.get().vcenters), ['vc-a', 'vc-b'], '스냅샷이 vCenter 0개로 바뀌었다');
  store.vcCache.clear(); store.vcLast.clear();
  pass();
});

test('R1 없음은 ENOENT 뿐: 지운 파일은 예전과 같이 빈 목록(표지 없음) · 그 뒤의 읽기 오류가 지운 목록을 되살리지 않는다 · stat 과 읽기 사이에 없어져도 없음', async () => {
  const good = fs.readFileSync(F('vcenters.json'), 'utf8');
  fs.rmSync(F('vcenters.json'));
  assert.deepEqual(CFG.loadVcenterConfig(), { file: null, vcenters: [] }, '반환 모양은 예전 그대로(readError 키 없음)');
  assert.equal(CFG.lastVcenterConfigText(F('vcenters.json')), null, '없어진 파일의 마지막 원문은 버린다');
  // 그 자리에 못 읽는 것이 생겨도(읽기 오류) 지운 목록이 돌아오지 않는다 — '모름'
  fs.mkdirSync(F('vcenters.json'));
  const c = await quietly(() => CFG.loadVcenterConfig());
  assert.deepEqual(c, { file: null, vcenters: [], readError: 'EISDIR' });
  fs.rmdirSync(F('vcenters.json'));
  // stat 은 됐는데 읽을 때 없어진 경합(ENOENT) — 읽기 오류가 아니라 없음
  fs.writeFileSync(F('vcenters.json'), good);
  assert.equal(CFG.loadVcenterConfig().vcenters.length, 2);
  await withReadError('vcenters.json', 'ENOENT', () => {
    assert.deepEqual(CFG.loadVcenterConfig(), { file: null, vcenters: [] }, '없어진 파일을 읽기 오류(마지막 목록)로 읽었다');
  });
  assert.deepEqual(ids(CFG.loadVcenterConfig().vcenters), ['vc-a', 'vc-b']);
  pass();
  assert.deepEqual(ids(REG.loadRegistry()), ['vc-a', 'vc-b']);
});

test('R1 실제 권한(root 로 돌 때만): 설정 폴더 탐색 권한을 잃은 서비스 계정 — 수집 로더가 마지막 목록을 준다', { skip: typeof process.getuid !== 'function' || process.getuid() !== 0 ? 'root 가 아니라 권한을 내릴 수 없다(주입 판이 같은 것을 고정한다)' : false }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebut121e-'));   // 0700 · root 소유 — 권한을 내린 프로세스는 들어오지 못한다
  try {
    fs.writeFileSync(path.join(dir, 'vcenters.json'), JSON.stringify({ vcenters: [vc('vc-1'), vc('vc-2')] }));
    const out = child('dir-eacces', dir);
    if (out.skipped) { t.skip(out.skipped); return; }
    assert.deepEqual(out.first, { n: 2, reg: 2 });
    assert.deepEqual(out.stat, { code: 'EACCES', existsSync: false }, '전제: 폴더 수준 오류에서 existsSync 는 false 다');
    assert.deepEqual(out.cfg, { file: true, n: 2, readError: 'EACCES' });
    assert.equal(out.reg, 2);
    assert.equal(out.lastKept, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ── R2 · R3 · R6 — 기동 때부터 못 읽음(새 프로세스) ─────────────────────────────────────────────────── */

test('R2 · R3 · R6 기동 때부터 못 읽음: 아래 후보(예제 템플릿)로 넘어가지 않는다 · Ping vCenter 포트 대상을 지우지 않는다(동기화 · 포트 지정 503) · 건너뛴 사유가 상태에 남는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebut121c-'));
  const file = path.join(dir, 'vcenters.json');
  const good = JSON.stringify({ vcenters: [vc('vc-1'), vc('vc-2')] });
  try {
    fs.writeFileSync(file, good);
    const prep = child('ping-prepare', dir);
    assert.equal(prep.set.ok, true);
    assert.deepEqual(prep.vcports, ['vcport_vc-1_443|250|false', 'vcport_vc-1_902|-|true', 'vcport_vc-2_443|-|true', 'vcport_vc-2_902|-|true']);

    fs.rmSync(file); fs.mkdirSync(file);   // 읽으면 EISDIR — 권한과 무관하게(root 로 도는 CI 에서도) 읽기 단계 실패
    const out = child('boot-unreadable', dir, { VCENTERS_EXAMPLE_FALLBACK: 'true' });
    // R2
    assert.deepEqual(out.cfg, { file: null, n: 0, readError: 'EISDIR' }, '못 읽은 주 후보 아래의 목록(예제 템플릿 · 레거시 파일)을 돌려줬다 — store 가 그 목록으로 수집한다');
    // R6
    assert.equal(out.store.refreshing, false, '건너뛴 주기가 재진입 가드를 붙잡았다');
    assert.equal(out.store.statusRefreshing, false);
    assert.equal(out.store.registered, 0);
    assert.match(String(out.store.lastError), /vCenter 등록부\(vcenters\.json\)를 읽지 못해\(읽기 오류 EISDIR\).*등록된 vCenter 가 없는 것이 아닙니다/, '건너뛴 사유가 상태(중앙의 빈 인벤토리 진단)에 없다');
    assert.equal(String(out.store.lastError).includes(dir), false, '상태에 설정 폴더 경로를 싣지 않는다');
    // R3
    assert.deepEqual(out.before, prep.vcports);
    assert.deepEqual(out.afterBoot, prep.vcports, '기동 동기화가 빈 목록으로 vCenter 포트 대상을 지웠다(기준값 · 켬/끔 포함)');
    for (const r of [out.sync, out.ports]) {
      assert.equal(r.status, 503);
      assert.equal(r.code, 'registry-unreadable');
      assert.equal(r.registryUnreadable, true);
      assert.match(r.reason, /vCenter 등록부\(vcenters\.json\)를 읽지 못해\(읽기 오류 EISDIR\)/);
      assert.equal(r.reason.includes(dir), false);
      assert.equal(r.reason.includes('`'), false, '화면 문구에 백틱 금지');
    }
    assert.deepEqual(out.afterRoutes, prep.vcports, '사람이 누른 동기화 · 포트 지정이 대상을 지웠다');
    assert.deepEqual(out.portsKept, [443, 902], '포트 지정도 저장하지 않는다');

    // 다시 읽히면 그대로 돈다(대상 · 사용자 편집값 유지)
    fs.rmdirSync(file); fs.writeFileSync(file, good);
    assert.deepEqual(child('ping-boot-ok', dir).afterBoot, prep.vcports);
    // 등록부에서 지운 vCenter 의 대상은 예전처럼 정리된다(정상 경로는 그대로)
    fs.writeFileSync(file, JSON.stringify({ vcenters: [vc('vc-1')] }));
    assert.deepEqual(child('ping-boot-ok', dir).afterBoot, ['vcport_vc-1_443|250|false', 'vcport_vc-1_902|-|true']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ── R4 NSX ─────────────────────────────────────────────────────────────────────────────── */

const nm = (id, extra = {}) => ({ id, name: `NSX ${id}`, host: `https://${id}.corp.example`, username: 'admin', password: `pw-${id}`, enabled: false, ...extra });

test('R4 NSX 등록부: 저장 직후의 읽기 오류는 저장 전 목록(지운 매니저 · 옛 비밀번호)을 되살리지 않는다', async () => {
  assert.equal(NSX.addManager(nm('n1')).ok, true);
  assert.equal(NSX.addManager(nm('n2')).ok, true);
  assert.deepEqual(ids(NSX.loadRegistry()), ['n1', 'n2']);
  // 삭제 → 곧바로 읽기 오류(저장 라우트가 바로 nsxStore.refresh 를 부르는 그 읽기)
  assert.deepEqual(NSX.removeManager('n2'), { ok: true });
  await withReadError('nsx.json', 'EMFILE', () => {
    assert.deepEqual(ids(NSX.loadRegistry()), ['n1'], '지운 매니저가 되살아났다 — 주기 수집이 저장 비밀번호로 로그인한다');
  });
  pass();
  // 비밀번호 변경 → 곧바로 읽기 오류
  assert.equal(NSX.updateManager('n1', { password: 'rotated!' }).ok, true);
  await withReadError('nsx.json', 'EIO', () => {
    const l = NSX.loadRegistry();
    assert.deepEqual(l.map((m) => [m.id, m.password]), [['n1', 'rotated!']], '옛 비밀번호로 돌아갔다');
    l[0].password = 'tampered';
    assert.equal(NSX.loadRegistry()[0].password, 'rotated!', '호출부가 고쳐도 마지막 목록은 그대로(사본)');
    assert.equal(NSX.addManager(nm('n9')).code, 'registry-unreadable');
  });
  pass();
  assert.equal(NSX.registryLoadError(), null);
  assert.equal(JSON.parse(fs.readFileSync(F('nsx.json'), 'utf8')).managers.length, 1);
});

test('NSX 라우트(116회차가 상태 코드를 그대로 둔 것 — 확인): 읽기 오류 중 등록 400 · 수정 400 · 삭제 404 에 사유 · 원본 그대로 · 화면은 세 경우 모두 사유를 보인다', async () => {
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express(); app.use(express.json());
  app.use((req, _r, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
  app.use('/api/admin', adminRouter);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { j = null; }
    return { status: r.status, body: j };
  };
  const before = fs.readFileSync(F('nsx.json'), 'utf8');
  await withReadError('nsx.json', 'EIO', async () => {
    const add = await call('POST', '/api/admin/nsx/managers', nm('n9'));
    const upd = await call('PUT', '/api/admin/nsx/managers/n1', { name: 'X' });
    const del = await call('DELETE', '/api/admin/nsx/managers/n1');
    assert.deepEqual([add.status, upd.status, del.status], [400, 400, 404]);
    for (const r of [add, upd, del]) {
      assert.equal(r.body.ok, false);
      assert.equal(r.body.code, 'registry-unreadable');
      assert.match(r.body.reason, /NSX 등록부\(nsx\.json\)를 읽지 못한 상태라 저장하지 않았습니다/);
    }
  });
  assert.equal(fs.readFileSync(F('nsx.json'), 'utf8'), before, '원본은 글자 그대로');
  pass();
  // 화면(NsxAdmin.jsx): POST 400 은 postJson 이 던지고(catch → 문구) · PUT 400 은 본문이 돌아와 r.ok 를 보고 · DELETE 404 는 던진다(catch → 배너)
  const ui = stripComments(fs.readFileSync(path.join(WEB, 'views', 'NsxAdmin.jsx'), 'utf8'));
  assert.match(ui, /else if \(r\.ok\) \{ await load\(\); close\(\); \} else setMsg\(\{ ok: false, text: r\.reason \}\)/, '수정 400 본문의 사유를 보인다(성공으로 읽지 않는다)');
  assert.match(ui, /catch \(e\) \{ setMsg\(\{ ok: false, text: e\.message \}\); \}/);
  assert.match(ui, /catch \(e\) \{ setActErr\(/, '삭제 실패는 배너로');
  const api = stripComments(fs.readFileSync(path.join(WEB, 'api.js'), 'utf8'));
  assert.match(api, /if \(!res\.ok && res\.status !== 409\) throw httpFail\(path, res, data\);/, 'postJson 은 400 을 던진다(전제)');
  assert.match(api, /if \(!res\.ok && res\.status !== 409 && res\.status !== 400\) throw httpFail\(path, res, data\);/, 'sendJson 은 404 를 던진다(전제)');
});

/* ── R5 화면 ────────────────────────────────────────────────────────────────────────────── */

test('R5 vCenter 관리 화면: 등록부 읽기 오류의 쓰기 거절(503)은 화면 전체 오류가 아니라 사유 배너 + 다시 조회', () => {
  const ui = stripComments(fs.readFileSync(path.join(WEB, 'views', 'VCenterAdmin.jsx'), 'utf8'));
  assert.match(ui, /const failAct = async \(e\) => \{\s*if \(e\?\.status === 503 && e\?\.body\?\.registryUnreadable === true\) \{ setActErr\(e\.message\); await load\(\); \} else setError\(e\.message\);/);
  const fnBody = (name) => { const at = ui.indexOf(`const ${name} = async`); assert.ok(at >= 0, name); return ui.slice(at, ui.indexOf('\n  };', at)); };
  for (const name of ['remove', 'toggleMaintenance']) {
    const b = fnBody(name);
    assert.match(b, /catch \(e\) \{ await failAct\(e\); \}/, `${name}: 503 을 ErrorBox(일시 미가용 안내)로 보내지 말 것`);
    assert.doesNotMatch(b, /catch \(e\) \{ setError\(e\.message\); \}/, name);
  }
  assert.match(ui, /\{actErr && <div className="banner warn" data-vc-act-err/);
  // 전제: 화면 공용 판정은 503 본문의 reason · code 가 'Unreadable' 로 끝날 때만 서버 사유를 그대로 보인다 — 118회차 본문(code 'registry-unreadable')은 걸리지 않는다
  const sd = stripComments(fs.readFileSync(path.join(WEB, 'components', 'serviceDownText.js'), 'utf8'));
  assert.match(sd, /\[b\.reason, b\.code, b\.error\]\.some\(\(v\) => typeof v === 'string' && \/Unreadable\$\/\.test\(v\)\)/);   // 132~135회차 묶음: error 칸 추가(판정식 · 접미 규칙은 그대로)
  assert.equal(/Unreadable$/.test('registry-unreadable'), false);
  const rt = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'admin', 'vcenters.js'), 'utf8'));
  assert.match(rt, /res\.status\(503\)\.json\(\{ ok: false, code: 'registry-unreadable', registryUnreadable: true, readError: true,/, '화면이 보는 표지(registryUnreadable)');
});

/* ── 스윕 ──────────────────────────────────────────────────────────────────────────────── */

test('스윕: 수집 로더는 existsSync 로 후보 유무를 가르지 않는다 · 못 읽은 후보 아래로 넘어가지 않는다 · NSX 는 저장 때 마지막 목록을 맞춘다', () => {
  const cfg = stripComments(fs.readFileSync(path.join(SRC, 'config.js'), 'utf8'));
  const at = cfg.indexOf('export function loadVcenterConfig()');
  const body = cfg.slice(at, cfg.indexOf('\nexport ', at + 10) > 0 ? cfg.indexOf('\nexport ', at + 10) : undefined);
  assert.doesNotMatch(body, /existsSync\(/, 'existsSync 는 stat 실패(EACCES · EIO)를 "없음" 으로 읽는다');
  assert.match(body, /if \(!vcFileMissing\(file\)\) \{/);
  assert.match(body, /if \(last == null\) break;/, '마지막 원문이 없는 읽기 오류에서 다음 후보로 넘어가지 말 것(continue 금지)');
  assert.match(body, /if \(readError\) break;/);
  // 134회차: 판정을 공용(util/fileMissing.js)으로 올렸다 — config.js 는 그것을 쓴다(판정 사본 금지). 판정 내용(ENOENT 만 없음)은 그대로다.
  assert.match(cfg, /const vcFileMissing = fileMissing;/);
  assert.match(stripComments(fs.readFileSync(path.join(SRC, 'util', 'fileMissing.js'), 'utf8')), /export function fileMissing\(file\) \{\s*try \{ fs\.statSync\(file\); return false; \} catch \(e\) \{ return e\?\.code === 'ENOENT'; \}/);
  const nsx = stripComments(fs.readFileSync(path.join(SRC, 'nsx', 'registry.js'), 'utf8'));
  const sv = nsx.slice(nsx.indexOf('function saveRegistry(list)'), nsx.indexOf('export function redact'));
  assert.ok(sv.indexOf('atomicWriteFileSync(') >= 0 && sv.indexOf('_lastGood = structuredClone(list)') > sv.indexOf('atomicWriteFileSync('), '쓰기 성공 뒤에 마지막 목록을 맞춘다');
  const mon = stripComments(fs.readFileSync(path.join(SRC, 'ping', 'monitor.js'), 'utf8'));
  assert.match(mon, /const vcUnknown = !!\(vcCfg\.readError && !vcCfg\.file\);/);
  assert.match(mon, /if \(!vcUnknown\) syncVcPortTargets\(/);
});
