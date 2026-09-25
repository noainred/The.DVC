// v2.613 감사 그룹 F(G5 — 저장소·등록부·설정 규약) 회귀 고정.
//   PERSIST2613-01 CVP 상태 파일 2개가 백업 변경 감시에 설정으로 잡히던 것 · PERSIST2613-08 상태 파일을 만드는 헬퍼가 스스로 등록 ·
//   PERSIST2613-02 DB·상태 파일 용도 카탈로그 · PERSIST2613-03 SQLite open 코어 사본 3벌 · PERSIST2613-04/DEPS2613-04 등록부 코어 ·
//   PERSIST2613-06 파트 장애 보존일(설정 + env 0 = 전부 보관) · DEPS2613-12/RUNTIME2613-08 설정 모듈 clamp 사본 · TESTDOC2613-13 MIXED_STATE_FILES 스윕.
// 스윕은 test/_stripComments.js 로 주석을 먼저 지운다(주석이 통과 근거가 되지 않게 — v2.535 규약). 시각 경계에 Date.now() 를 쓰지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2613f-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
delete process.env.PARTFAULT_RETENTION_DAYS;
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const code = (p) => stripComments(read(p));
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'mock' && e.name !== 'intro') walk(p, out); } else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const rel = (f) => path.relative(SRC, f).split(path.sep).join('/');
const quiet = (fn) => { const w = console.warn; const e = console.error; console.warn = () => {}; console.error = () => {}; try { return fn(); } finally { console.warn = w; console.error = e; } };

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

/* ── PERSIST2613-01 ───────────────────────────────────────────────────────────── */
test('PERSIST2613-01 — CVP 상태 파일 2개(central-agent-cvp.json·cvp-push.json)는 백업·엣지 설정 push 감시에서 상태다', async () => {
  const backup = await import('../src/backup/service.js');
  const { configWatchRelevant } = await import('../src/agent/configPush.js');
  for (const n of ['central-agent-cvp.json', 'cvp-push.json']) {
    assert.equal(backup.RUNTIME_STATE_NAMES.has(n), true, `${n} 은 명시 목록에도 있어야 한다(헬퍼 모듈이 아직 로드되지 않은 시점의 판정까지 같게)`);
    assert.equal(backup.isRuntimeStateFile(n), true, `${n} 은 상태 파일이다`);
    assert.equal(configWatchRelevant(n), false, `${n} 쓰기는 엣지 설정 push 를 깨우지 않는다(v2.602 EDGE2602-01 의 CVP 재발)`);
  }
  // 형제(v2.590 에 등록된 것)와 같은 판정 — 커서만 바뀌면 지문이 같다
  const a = backup.settingsFingerprint({ 'cvp-servers.json': 'A', 'cvp-push.json': '{"lastRowid":1}', 'central-agent-cvp.json': '{"e":1}' });
  const b = backup.settingsFingerprint({ 'cvp-servers.json': 'A', 'cvp-push.json': '{"lastRowid":2}', 'central-agent-cvp.json': '{"e":2}' });
  const c = backup.settingsFingerprint({ 'cvp-servers.json': 'B', 'cvp-push.json': '{"lastRowid":1}', 'central-agent-cvp.json': '{"e":1}' });
  assert.equal(a, b, '상태 파일(push 커서·수신 캐시)만 바뀌면 지문이 같아야 한다');
  assert.notEqual(a, c, '등록부(설정)가 바뀌면 지문이 달라야 한다');
});

/* ── PERSIST2613-08 ───────────────────────────────────────────────────────────── */
test('PERSIST2613-08 — 상태 파일을 만드는 헬퍼(createDebouncedWriter·createActivityLog·createAuthGuard·push 커서)가 스스로 등록하고 판정이 그것을 본다', async () => {
  const backup = await import('../src/backup/service.js');
  const { isRegisteredStateFile, registeredStateFiles } = await import('../src/util/stateFiles.js');
  // ① 합성 등록 — 이름 규약(-activity·-stops)·명시 목록에 걸리지 않는 이름으로 헬퍼를 만들면 그 순간 상태가 된다.
  const { createDebouncedWriter } = await import('../src/central/edgeRecord.js');
  const { createActivityLog } = await import('../src/util/activityLog.js');
  const { createAuthGuard } = await import('../src/util/authGuard.js');
  const probes = ['zz-probe-writer.json', 'zz-probe-alog.json', 'zz-probe-guard.json'];
  for (const n of probes) assert.equal(backup.isRuntimeStateFile(n), false, `${n} 은 등록 전에는 설정으로 보인다(이름 규약 밖)`);
  createDebouncedWriter(path.join(TMP, probes[0]), () => '{}', { name: 'probe' });
  createActivityLog({ fileName: probes[1] });
  createAuthGuard({ file: probes[2] });
  for (const n of probes) {
    assert.equal(isRegisteredStateFile(n), true, `${n} 등록`);
    assert.equal(backup.isRuntimeStateFile(n), true, `${n} — isRuntimeStateFile 이 등록부를 본다`);
  }
  // ② push 커서 — cvp/push.js 가 로드되면 등록돼 있다.
  await import('../src/cvp/push.js');
  assert.equal(isRegisteredStateFile('cvp-push.json'), true);
  assert.ok(registeredStateFiles().includes('cvp-push.json'));
  // ③ 열거 스윕 — 저장소의 헬퍼 호출부에서 파일명 리터럴을 뽑아 **전부** 상태로 판정되는지(목록·규약·등록부 어느 축이든).
  const names = new Map();
  for (const f of walk(SRC)) {
    const s = code(rel(f));
    if (rel(f) === 'util/stateFiles.js' || rel(f) === 'central/edgeRecord.js') continue; // 헬퍼 정의 자체(호출부가 아니다)
    for (const m of s.matchAll(/createAuthGuard\(\{\s*file:\s*'([^']+)'/g)) names.set(m[1], rel(f));
    for (const m of s.matchAll(/createActivityLog\(\{[\s\S]{0,120}?fileName:\s*'([^']+)'/g)) names.set(m[1], rel(f));
    if (/createDebouncedWriter\(/.test(s)) {
      const lit = [...s.matchAll(/configDir(?:\(\))?,\s*'([^']+\.json)'\)/g)].map((m) => m[1]);
      assert.ok(lit.length >= 1, `${rel(f)}: createDebouncedWriter 를 쓰는데 configDir 파일명 리터럴을 찾지 못했다 — 스윕이 못 보는 형태다`);
      for (const n of lit) names.set(n, rel(f));
    }
    for (const m of s.matchAll(/registerStateFile\('([^']+)'\)/g)) names.set(m[1], rel(f));
  }
  assert.ok(names.size >= 20, `헬퍼 호출부에서 뽑은 파일명이 너무 적다(${names.size}) — 스윕 정규식을 확인할 것`);
  const wrong = [...names].filter(([n]) => !backup.isRuntimeStateFile(n)).map(([n, f]) => `${n}(${f})`);
  assert.deepEqual(wrong, [], `헬퍼가 만드는 파일인데 설정으로 판정된다: ${wrong.join(', ')}`);
  assert.ok([...names.keys()].includes('central-agent-cvp.json') && [...names.keys()].includes('cvp-push.json'));
});

/* ── PERSIST2613-02 ───────────────────────────────────────────────────────────── */
test('PERSIST2613-02 — DB 위치 이전 대상·백업 상태 파일·신규 기능 설정 파일 전부에 용도(PURPOSES)가 있다', async () => {
  const { PURPOSES } = await import('../src/insights/portalDb.js');
  const { MIGRATABLE } = await import('../src/insights/dbLocation.js');
  const { RUNTIME_STATE_NAMES } = await import('../src/backup/service.js');
  const missingDb = MIGRATABLE.map((m) => m.file).filter((f) => !PURPOSES[f]);
  assert.deepEqual(missingDb, [], `MIGRATABLE 인데 용도 없음(포탈 DB 화면이 'SQLite 데이터베이스' 폴백으로 나열한다): ${missingDb.join(', ')}`);
  const missingState = [...RUNTIME_STATE_NAMES].filter((f) => !PURPOSES[f]);
  assert.deepEqual(missingState, [], `상태 파일인데 용도 없음: ${missingState.join(', ')}`);
  // 신규 기능(v2.520~v2.608)의 설정·등록부 JSON — 소스의 configDir 리터럴로 실재를 확인한 뒤 용도를 요구한다.
  const feature = ['partfault-settings.json', 'bmusage-settings.json', 'linkcheck-settings.json', 'cvp-settings.json', 'curuser-settings.json',
    'horizon-sessions.json', 'cvp-servers.json', 'storage-devices.json', 'sanswitch-devices.json', 'pdu-devices.json', 'bm-storage.json', 'storage-intervals.json'];
  const all = walk(SRC).map((f) => code(rel(f))).join('\n');
  for (const f of feature) {
    assert.ok(all.includes(`'${f}'`), `${f} — 소스에 그 파일명이 없다(이름이 바뀌었으면 목록을 고칠 것)`);
    assert.ok(PURPOSES[f], `${f} 용도 없음`);
  }
  for (const [k, v] of Object.entries(PURPOSES)) assert.ok(typeof v === 'string' && v.trim().length >= 4 && !/`/.test(v), `${k}: 설명이 비었거나 백틱`);
});

/* ── PERSIST2613-03 ───────────────────────────────────────────────────────────── */
test('PERSIST2613-03 — DatabaseSync 를 여는 모듈은 util/sqliteOpen.js 를 쓴다(원조 3벌의 손 사본 제거 · 일반 스윕)', async () => {
  // 예외(사유): ipam/writeWorker.js 는 워커 스레드에서 외부 공유 ipam.db(비-WAL)를 여는 쓰기 전용 경로 · upgrade/dbCheckpoint.js 는
  //   업그레이드 전 체크포인트 도구(폴링 경로가 아니다 — 잠금이면 그 회차만 실패하고 밝힌다).
  const EXCEPT = new Set(['ipam/writeWorker.js', 'upgrade/dbCheckpoint.js']);
  const bad = [];
  for (const f of walk(SRC)) {
    const r = rel(f); if (r === 'util/sqliteOpen.js' || EXCEPT.has(r)) continue;
    const s = code(r);
    if (/new DatabaseSync\(/.test(s) && !/openSqlite\(/.test(s)) bad.push(r);
  }
  assert.deepEqual(bad, [], `openSqlite 없이 DatabaseSync 를 연다(chmod→busy_timeout→WAL 순서·잠금 시 핸들 정리 규약 밖): ${bad.join(', ')}`);
  // 원조 3벌 — 잠금 재시도 시각·잠금 정규식·PRAGMA 손 실행이 남아 있지 않다.
  for (const f of ['storage/db.js', 'metrics/db.js', 'horizon/sessionDb.js']) {
    const s = code(f);
    assert.ok(!/retryAt\s*=\s*Date\.now\(\)|LOCK_RETRY_MS|const LOCK_RE|function isSqliteLockError|PRAGMA busy_timeout|PRAGMA journal_mode/.test(s), `${f}: open 코어 손 사본이 남아 있다`);
    assert.match(s, /openSqlite\(new DatabaseSync\(/, `${f}: openSqlite 로 연다`);
    assert.match(s, /createLockRetry\(|retryOnLock\(/, `${f}: 잠금 재시도는 공용 헬퍼`);
  }
  const st = await import('../src/storage/db.js');
  const so = await import('../src/util/sqliteOpen.js');
  assert.equal(st.isSqliteLockError, so.isSqliteLockError, 'storage/db.js 의 isSqliteLockError 는 util 의 재수출이다(판정은 하나)');
  // 실행 — 세 모듈이 실제로 열린다(리팩터가 open 을 깨지 않았다).
  const hz = await import('../src/horizon/sessionDb.js');
  assert.equal((await hz.hzSessionDbStatus()).available, true);
  assert.equal(await st.dbAvailable(), true);
  const m = await import('../src/metrics/db.js');
  const impl = await m.getMetricsDb();
  assert.ok(impl && typeof impl === 'object');
});

/* ── PERSIST2613-04 + DEPS2613-04 ─────────────────────────────────────────────── */
test('PERSIST2613-04/DEPS2613-04 — 등록부 5벌은 util/registryCore.js 를 쓰고, 원소 null 하나가 목록을 죽이거나 파일을 손상으로 비우지 않는다', async () => {
  // 소스: corruptOnlyReason 정의는 util/registryCore.js 하나, 5개 등록부가 import.
  const defs = walk(SRC).map(rel).filter((r) => /function corruptOnlyReason\(/.test(code(r)));
  assert.deepEqual(defs, ['util/registryCore.js']);
  for (const f of ['storage/registry.js', 'sanswitch/registry.js', 'pdu/registry.js', 'cvp/registry.js', 'bmstor/registry.js']) {
    const s = code(f);
    assert.match(s, /from '\.\.\/util\/registryCore\.js'/, `${f}: registryCore import`);
    assert.match(s, /filterObjectElements\(/, `${f}: 원소 필터`);
    assert.match(s, /preserveCorrupt\((?:FILE(?:\(\))?), e(?:\?\.| ?\.)message\)/, `${f}: preserveCorrupt 에 사유를 넘긴다`);
    assert.ok(!/let _loadError/.test(s), `${f}: 로드 오류 상태 사본`);
  }
  // 코어 판정 단위.
  const core = await import('../src/util/registryCore.js');
  assert.deepEqual(core.filterObjectElements([null, 'x', [1], { id: 'a' }, undefined, { id: 'b' }]), { list: [{ id: 'a' }, { id: 'b' }], dropped: 4 });
  assert.deepEqual(core.filterObjectElements('nope'), { list: [], dropped: 0 });
  const list = [{ id: 1, agent: 'Edge-A ' }, { id: 2, agent: '' }, { id: 3, agent: 'edge-a', enabled: false }, { id: 4 }];
  assert.deepEqual(core.devicesForThisNode(list, { agentName: 'edge-a', isEdge: true }).map((d) => d.id), [1]);
  assert.deepEqual(core.devicesForThisNode(list, { isEdge: false }).map((d) => d.id), [2, 4]);
  assert.deepEqual(core.devicesForThisNode(list, { agentName: '', isEdge: true }), [], '이름 빈 엣지는 아무것도 가져가지 않는다');
  assert.deepEqual(core.devicesForAgent(list, 'EDGE-A').map((d) => d.id), [1]);
  assert.deepEqual(core.devicesForAgent(list, ''), [], '빈 이름은 중앙 직접 장비(agent "")와 짝지어지지 않는다');
  // 실행 — 원소 null 이 든 등록부 파일(손편집·손상)에서 목록이 살아 있고 .corrupt 보존이 생기지 않는다.
  const write = (n, body) => fs.writeFileSync(path.join(TMP, n), JSON.stringify(body));
  write('storage-devices.json', { version: 1, devices: [null, { id: 'st1', name: 'A', type: 'unity480', host: '10.0.0.1', username: 'u', password: 'p', agent: '' }] });
  write('sanswitch-devices.json', { version: 1, devices: [null, 'junk', { id: 'sw1', name: 'S', host: '10.0.0.2', username: 'u', password: 'p', agent: '' }] });
  write('pdu-devices.json', { devices: [null, { id: 'pdu1', name: 'P', host: '10.0.0.3', agent: '' }] });
  write('cvp-servers.json', { version: 1, servers: [null, { id: 'cvp1', name: 'C', base: 'https://10.0.0.4', agent: '' }] });
  write('bm-storage.json', { servers: [null, { id: 'bm1', name: 'B', host: '10.0.0.5', username: 'u', password: 'p', group: 'g1', mounts: ['/data'] }], settings: {} });
  const st = await import('../src/storage/registry.js'); const sw = await import('../src/sanswitch/registry.js');
  const pd = await import('../src/pdu/registry.js'); const cv = await import('../src/cvp/registry.js'); const bm = await import('../src/bmstor/registry.js');
  st._resetForTest(); sw._resetForTest(); pd._resetForTest(); cv._resetForTest();
  assert.deepEqual(st.listDevices().map((d) => d.id), ['st1'], '예전: null 원소로 listDevices 가 매 호출 TypeError');
  assert.deepEqual(sw.listDevices().map((d) => d.id), ['sw1']);
  assert.deepEqual(pd.listDevices().map((d) => d.id), ['pdu1']);
  assert.deepEqual(cv.listServers().map((d) => d.id), ['cvp1']);
  assert.deepEqual(bm.listBmServers().map((d) => d.id), ['bm1'], '예전: groups 변형이 null 에서 던져 파일 전체를 손상으로 보존하고 목록을 비웠다');
  assert.deepEqual(fs.readdirSync(TMP).filter((n) => n.includes('.corrupt.')), [], '원소 하나 때문에 파일을 손상으로 보존하지 않는다');
  for (const r of [st, sw, pd, cv, bm]) assert.equal(r.registryLoadError(), null);
  // 손상 보존본만 남은 상태(원본 없음)는 5벌 모두 '못 읽음' 이다(v2.612 LEFT2612-01 판정을 bmstor 도 받는다).
  for (const n of ['storage-devices.json', 'sanswitch-devices.json', 'pdu-devices.json', 'cvp-servers.json', 'bm-storage.json']) {
    fs.renameSync(path.join(TMP, n), path.join(TMP, `${n}.corrupt.1700000000000`));
  }
  st._resetForTest(); sw._resetForTest(); pd._resetForTest(); cv._resetForTest();
  const bmReload = await import('../src/bmstor/registry.js?fresh=1').catch(() => null); // bmstor 는 reset 이 없다 — 별도 인스턴스로 확인
  for (const r of [st, sw, pd, cv]) assert.match(r.registryLoadError()?.reason || '', /손상 보존본/);
  if (bmReload) assert.match(bmReload.registryLoadError()?.reason || '', /손상 보존본/);
  for (const n of fs.readdirSync(TMP).filter((x) => x.includes('.corrupt.'))) fs.rmSync(path.join(TMP, n));
  st._resetForTest(); sw._resetForTest(); pd._resetForTest(); cv._resetForTest();
});

/* ── PERSIST2613-06 ───────────────────────────────────────────────────────────── */
test('PERSIST2613-06 — 파트 장애 보존일은 설정 파일(하한 30·기본 730)이고 env 는 0 = 전부 보관·빈 값·비숫자·음수 = 미지정이다', async () => {
  const s = await import('../src/partfault/settings.js');
  const db = await import('../src/partfault/db.js');
  s._resetForTest();
  assert.deepEqual(s.partFaultRetention(), { days: 730, source: 'default' });
  s.savePartFaultSettings({ retentionDays: 400 });
  assert.deepEqual(s.partFaultRetention(), { days: 400, source: 'settings' });
  s.savePartFaultSettings({ retentionDays: '' });
  assert.equal(s.partFaultRetention().days, 400, '빈 칸은 미지정(이전 값 유지 — 하한으로 승격하지 않는다)');
  s.savePartFaultSettings({ retentionDays: null });
  assert.equal(s.partFaultRetention().days, 400);
  s.savePartFaultSettings({ retentionDays: 5 });
  assert.equal(s.partFaultRetention().days, 30, '하한 30');
  s.savePartFaultSettings({ retentionDays: 99999 });
  assert.equal(s.partFaultRetention().days, 3650, '상한 10년');
  s.savePartFaultSettings({ enabled: true });
  assert.equal(s.loadPartFaultSettings().retentionDays, 3650, '다른 칸 저장이 보존일을 건드리지 않는다');
  // 파일 손편집 값도 범위 안으로
  s._resetForTest();
  fs.writeFileSync(path.join(TMP, 'partfault-settings.json'), JSON.stringify({ enabled: false, edges: {}, central: null, retentionDays: 'abc' }));
  assert.equal(s.partFaultRetention().days, 730);
  s.savePartFaultSettings({ retentionDays: 500 });
  // env 우선 — 0 은 전부 보관(예전: Math.max(30, Number(env) || 730) 이 0 을 조용히 730 으로)
  const cases = [['0', { days: 0, source: 'env' }], ['', { days: 500, source: 'settings' }], ['abc', { days: 500, source: 'settings' }],
    ['-5', { days: 500, source: 'settings' }], ['10', { days: 30, source: 'env' }], ['900', { days: 900, source: 'env' }], [' 45 ', { days: 45, source: 'env' }]];
  for (const [env, want] of cases) {
    process.env.PARTFAULT_RETENTION_DAYS = env;
    assert.deepEqual(s.partFaultRetention(), want, `env=${JSON.stringify(env)}`);
  }
  delete process.env.PARTFAULT_RETENTION_DAYS;
  // DB status 가 그 값을 싣고, prune 은 0 이면 생략한다(소스 고정 — 예전 상수 RETENTION_DAYS 가 없다).
  const stt = await db.partFaultDbStatus();
  assert.equal(stt.retentionDays, 500); assert.equal(stt.retentionSource, 'settings');
  const src = code('partfault/db.js');
  assert.ok(!/RETENTION_DAYS\b/.test(src.replace(/PARTFAULT_RETENTION_DAYS/g, '')), 'env 전용 상수가 남아 있다');
  assert.match(src, /const \{ days \} = retention\(\);\s*if \(days > 0\)/, 'prune 은 보존일 0(전부 보관)이면 생략');
  const route = code('routes/api/partFaults.js');
  assert.match(route, /savePartFaultSettings\(req\.body/, 'PUT /tools/part-faults/settings 가 같은 저장 함수를 쓴다(retentionDays 도 받는다)');
  s._resetForTest();
});

/* ── DEPS2613-12 + RUNTIME2613-08 ─────────────────────────────────────────────── */
test('DEPS2613-12/RUNTIME2613-08 — 신규 기능 설정 모듈 6벌은 로컬 clamp 를 정의하지 않고 util/clampSetting.js 를 쓴다(빈 칸 = 미지정)', async () => {
  const MODS = ['partfault/settings.js', 'bmusage/settings.js', 'linkcheck/settings.js', 'cvp/settings.js', 'curuser/settings.js', 'horizon/sessionSettings.js'];
  for (const f of MODS) {
    const s = code(f);
    const local = [...s.matchAll(/\b(?:const|let|var|function)\s+(clamp\w*)\b/g)].map((m) => m[1]);
    assert.deepEqual(local, [], `${f}: 로컬 clamp 정의 ${local.join(', ')}`);
    assert.match(s, /from '\.\.\/util\/clampSetting\.js'/, `${f}: clampSetting import`);
    assert.match(s, /clampSetting\(/, `${f}: 실제로 쓴다`);
  }
  // 동작 — 빈 값·null·비숫자는 기본값, 명시적 숫자만 값(예전 bmusage 사본은 Number(null)===0 을 하한으로 승격했다).
  const bm = await import('../src/bmusage/settings.js');
  const n1 = bm.normalizeSettings({ rawRetentionDays: null, dailyRetentionDays: '', alertPct: 'x', intervalMs: [5] });
  assert.equal(n1.rawRetentionDays, bm.DEFAULTS.rawRetentionDays); assert.equal(n1.dailyRetentionDays, bm.DEFAULTS.dailyRetentionDays);
  assert.equal(n1.alertPct, bm.DEFAULTS.alertPct); assert.equal(n1.intervalMs, bm.DEFAULTS.intervalMs);
  assert.equal(bm.normalizeSettings({ rawRetentionDays: '3' }).rawRetentionDays, 7, '숫자 문자열은 값(하한 7)');
  const lc = await import('../src/linkcheck/settings.js');
  assert.equal(lc.normalizeSettings({ concurrency: '' }).concurrency, lc.DEFAULTS.concurrency);
  assert.equal(lc.normalizeSettings({ concurrency: 64 }).concurrency, 32);
  const cv = await import('../src/cvp/settings.js');
  assert.equal(cv.normalizeSettings({ rawRetentionDays: null }).rawRetentionDays, cv.LIMITS.rawRetentionDays.def);
  assert.equal(cv.mergeSettings(cv.normalizeSettings({ rawRetentionDays: 20 }), { rawRetentionDays: '' }).rawRetentionDays, 20, '패치 빈 칸은 이전 값');
  assert.equal(cv.mergeSettings(cv.normalizeSettings({}), { rawRetentionDays: 500 }).rawRetentionDays, cv.LIMITS.rawRetentionDays.max);
  const cu = await import('../src/curuser/settings.js');
  assert.equal(cu.normalize({ retentionDays: '' }).retentionDays, cu.LIMITS.retentionDays.def);
  assert.equal(cu.normalize({ retentionDays: 99999 }).retentionDays, cu.LIMITS.retentionDays.max);
  const hz = await import('../src/horizon/sessionSettings.js');
  assert.equal(hz.normalize({ pageSize: 'abc' }).pageSize, hz.LIMITS.pageSize.def);
  assert.equal(hz.normalize({ pageSize: 7.6 }).pageSize, Math.max(hz.LIMITS.pageSize.min, 8));
});

/* ── TESTDOC2613-13 ───────────────────────────────────────────────────────────── */
test('TESTDOC2613-13 — MIXED_STATE_FILES 스윕: 항목마다 last*/useCount 를 쓰는 저장 모듈이 실재하고, 지문이 실행 필드만 뺀다', async () => {
  const backup = await import('../src/backup/service.js');
  const mods = walk(SRC).map(rel).map((r) => [r, code(r)]);
  const RUN_WRITE = /\.(?:last[A-Z]\w*|useCount)\s*=[^=]/;   // 저장 레코드의 실행 필드에 대한 **점 대입**(모듈 변수 lastRun = … 은 제외)
  // ① 항목마다 근거(파일명 리터럴 + 원자 쓰기 + 실행 필드 기록)가 있는 모듈이 있다 — 죽은 항목 0.
  for (const n of backup.MIXED_STATE_FILES) {
    const owners = mods.filter(([, s]) => s.includes(`'${n}'`) && /atomicWriteFileSync\(/.test(s) && /\b(?:last[A-Z]\w*|useCount)\b/.test(s)).map(([r]) => r);
    assert.ok(owners.length >= 1, `${n}: 실행 필드(last*/useCount)를 기록하는 저장 모듈이 없다 — 목록에서 뺄 것`);
    assert.equal(backup.isRuntimeStateFile(n), false, `${n}: 혼합 파일은 상태가 아니다(편집이 백업돼야 한다)`);
  }
  // ② 반대 방향 — 저장 레코드에 실행 필드를 점 대입으로 쓰는 모듈은 그 필드가 사는 configDir JSON 이 혼합 목록이거나 상태 파일이어야 한다.
  //   모듈이 파일을 여럿 쓰면(alerts.js: alerts.json + alerts-state.json) 어느 파일에 쓰는지는 소스로 가를 수 없으므로 '그중 하나라도'
  //   목록에 있으면 통과한다(정직 기록 — 파일 단위 판정은 실행 필드의 저장 위치를 코드가 선언해야 가능하다).
  const gaps = [];
  for (const [r, s] of mods) {
    if (!/atomicWriteFileSync\(/.test(s) || !RUN_WRITE.test(s)) continue;
    const lits = [...s.matchAll(/configDir(?:\(\))?,\s*'([^']+\.json)'\)/g)].map((m) => m[1]);
    if (!lits.length) continue; // 파일명을 변수로 조립하는 모듈은 이 스윕이 못 본다(정직 기록)
    if (!lits.some((n) => backup.MIXED_STATE_FILES.has(n) || backup.isRuntimeStateFile(n))) gaps.push(`${r}: ${lits.join('·')}`);
  }
  assert.deepEqual(gaps, [], `실행 필드를 쓰는데 혼합·상태 어느 목록에도 없다(폴러 실행마다 change 백업이 생긴다): ${gaps.join(', ')}`);
  // ③ 지문 — 혼합 파일의 last*/useCount 변화는 지문을 바꾸지 않고, 설정 변화는 바꾼다(중첩 포함).
  const fp = (v) => backup.settingsFingerprint({ 'os-scan.json': JSON.stringify(v), 'capture-monitors.json': JSON.stringify([{ id: 1, name: 'm', lastRun: 1, lastWorst: 'x' }]) });
  const base = fp({ enabled: true, intervalMin: 60, lastRun: 1, lastErr: '' });
  assert.equal(fp({ enabled: true, intervalMin: 60, lastRun: 2, lastErr: 'boom' }), base, 'last* 만 바뀌면 같다');
  assert.notEqual(fp({ enabled: true, intervalMin: 30, lastRun: 1, lastErr: '' }), base, '설정이 바뀌면 다르다');
  assert.equal(backup.settingsFingerprint({ 'capture-monitors.json': JSON.stringify([{ id: 1, name: 'm', lastRun: 9, lastWorst: 'y' }]), 'os-scan.json': JSON.stringify({ enabled: true, intervalMin: 60, lastRun: 1, lastErr: '' }) }), base, '배열 원소의 last* 도 뺀다');
  assert.notEqual(backup.settingsFingerprint({ 'api-keys.json': '{"k":1,"useCount":1}' }), backup.settingsFingerprint({ 'api-keys.json': '{"k":2,"useCount":1}' }));
  assert.equal(backup.settingsFingerprint({ 'api-keys.json': '{"k":1,"useCount":1}' }), backup.settingsFingerprint({ 'api-keys.json': '{"k":1,"useCount":2}' }));
});
