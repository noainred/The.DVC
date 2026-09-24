/**
 * v2.601 감사 수정 그룹 e — 보안·타이머·DB·설정 회귀.
 *  LO2601-01  에이전트 배포 env 블록에 개행·NUL 이 있으면 설치 전에 거부(원격 portal.env 키 주입)
 *  LO2601-02  AD 타임아웃 빈 칸 = 이전 값/기본(예전: '' 저장 → 모든 AD 로그인 즉시 'connect timeout')
 *  LO2601-03  idrac-scan-ranges.json(lastRun)·remote-access.json(lastUsedAt) 실행 필드는 백업 지문에서 뺀다
 *  TIM2601-01 RMA text-log 가 디렉터리 경로에서 fd 를 새지 않는다
 *  TIM2601-02 adaptiveTimer 는 getMs() 가 던져도 멈추지 않는다
 *  TIM2601-03 설정 파일 내용이 JSON null 이어도 relaycheck·SAN perf 로더가 던지지 않는다
 *  DB2601-03  vCenter 로그 prune 은 청크 + 양보(첫 청크만 동기)
 *  DB2601-04  curUserDbStatus 행 수는 캐시하고 countsAt 으로 밝힌다
 *  SEC2601-01 zip 겹침 폭탄(같은 localOffset)·누적 상한
 *  SEC2601-03 로그 가림이 JSON 인용 키·카멜케이스 비밀 필드를 잡고, deviceKey·partKey 는 두지 않는다
 * 기준 시각은 Date.now() 가 아니라 고정값을 쓴다(CLAUDE.md v2.517).
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2601e-'));
process.env.CONFIG_DIR = TMP;
process.env.CURUSER_DB_PATH = path.join(TMP, 'curuser.db');
process.env.PRUNE_CHUNK_ROWS = '500';
process.env.AUTH_ENABLED = 'false';

const T0 = 1_700_000_000_000;   // 고정 기준 시각
const DAY = 86_400_000;

// ─────────────── LO2601-01
test('LO2601-01: agentName 에 개행이 있으면 설치 전에 거부한다(portal.env 키 주입)', async () => {
  const { deployAgent } = await import('../src/agent/deploy.js');
  const r = await deployAgent({ host: '192.0.2.1', username: 'root', agentName: 'edge1\nAUTH_ENABLED=false\nDEFAULT_ADMIN_PASSWORD=pwn', centralUrl: 'https://c' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /개행·NUL/);
  const r2 = await deployAgent({ host: '192.0.2.1', username: 'root', agentName: 'edge1', centralToken: 'tok\r\nX=1' });
  assert.match(r2.reason, /개행·NUL/);
  // 정상 입력은 이 검사에 걸리지 않는다(설치 패키지가 없어서 그 다음 단계에서 멈춘다)
  const r3 = await deployAgent({ host: '192.0.2.1', username: 'root', agentName: 'edge1', centralUrl: 'https://c' });
  assert.doesNotMatch(String(r3.reason), /개행·NUL/);
});

// ─────────────── LO2601-02
test('LO2601-02: AD 타임아웃 빈 칸은 이전 값을 유지하고, 저장된 빈 값도 기본값으로 복구한다', async () => {
  const ad = await import('../src/auth/ad.js');
  assert.equal(ad.saveAdConfig({ timeoutMs: 5000 }).timeoutMs, 5000);
  assert.equal(ad.saveAdConfig({ timeoutMs: '' }).timeoutMs, 5000, '빈 칸 = 이전 값');
  assert.equal(ad.saveAdConfig({ timeoutMs: '0' }).timeoutMs, 5000, '0 이하 = 미지정');
  assert.equal(ad.saveAdConfig({ timeoutMs: '12000' }).timeoutMs, 12000, '숫자 문자열은 숫자로');
  assert.equal(ad.saveAdConfig({ timeoutMs: 10 }).timeoutMs, 1000, '하한 1초');
  // 이미 '' 가 저장된 옛 파일
  fs.writeFileSync(path.join(TMP, 'auth.json'), JSON.stringify({ ad: { timeoutMs: '' } }));
  const cfg = ad.loadAdConfig();
  assert.equal(typeof cfg.timeoutMs, 'number');
  assert.ok(cfg.timeoutMs >= 1000, `저장된 '' 가 ${cfg.timeoutMs} 로 읽혔다`);
});

// ─────────────── LO2601-03
test('LO2601-03: lastRun·lastUsedAt 만 바뀐 파일은 백업 지문을 바꾸지 않는다', async () => {
  const { settingsFingerprint } = await import('../src/backup/service.js');
  const scan = (at) => JSON.stringify({ entries: { a: { ranges: ['10.0.0.0/24'], lastRun: { at, ok: true } } } });
  const ra = (at) => JSON.stringify({ mappings: [{ id: 'm1', host: 'h', lastUsedAt: at }] });
  const f1 = settingsFingerprint({ 'idrac-scan-ranges.json': scan(T0), 'remote-access.json': ra('2026-01-01T00:00:00Z') });
  const f2 = settingsFingerprint({ 'idrac-scan-ranges.json': scan(T0 + DAY), 'remote-access.json': ra('2026-01-02T00:00:00Z') });
  assert.equal(f1, f2, '실행·사용 기록만 바뀌었는데 지문이 달라졌다(매번 change 백업)');
  const f3 = settingsFingerprint({ 'idrac-scan-ranges.json': JSON.stringify({ entries: { a: { ranges: ['10.0.1.0/24'], lastRun: { at: T0 } } } }), 'remote-access.json': ra('2026-01-01T00:00:00Z') });
  assert.notEqual(f1, f3, '실제 설정 변경은 지문을 바꾼다');
});

// ─────────────── TIM2601-01
test('TIM2601-01: text-log 경로가 디렉터리여도 fd 가 새지 않는다', async () => {
  const { runTest } = await import('../src/rma/testRunner.js');
  const root = fs.mkdtempSync(path.join(TMP, 'rma-'));
  fs.mkdirSync(path.join(root, 'sub'));
  const fds = () => fs.readdirSync('/proc/self/fd').length;
  const spec = { test: 'text-log', args: { path: path.join(root, 'sub'), pattern: 'x', tailLines: 10, maxMatches: 0 } };
  await runTest(spec, { fileRoots: [root] });   // 워밍업(모듈 지연 로드 fd 제외)
  const before = fds();
  let r;
  for (let i = 0; i < 20; i++) r = await runTest(spec, { fileRoots: [root] });
  const after = fds();
  assert.equal(r.status, 'unknown');
  assert.ok(after - before < 5, `fd 가 ${before} → ${after} 로 늘었다`);
  // 정상 파일은 여전히 읽는다
  fs.writeFileSync(path.join(root, 'a.log'), 'ok\nERROR x\n');
  const ok = await runTest({ test: 'text-log', args: { path: path.join(root, 'a.log'), pattern: 'ERROR', tailLines: 10, maxMatches: 5 } }, { fileRoots: [root] });
  assert.equal(ok.status, 'ok');
});

// ─────────────── TIM2601-02
test('TIM2601-02: getMs() 가 던져도 타이머가 멈추지 않고 60초로 다시 무장한다', async () => {
  const { startAdaptiveTimer } = await import('../src/util/adaptiveTimer.js');
  const rejections = [];
  const onRej = (e) => rejections.push(e);
  process.on('unhandledRejection', onRej);
  const warn = mock.method(console, 'warn', () => {});
  mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  let runs = 0;
  const t = startAdaptiveTimer(() => { throw new Error('getMs boom'); }, () => { runs += 1; }, { firstDelayMs: 0, name: 't2601' });
  try {
    mock.timers.tick(1000); await flush();
    assert.equal(runs, 1);
    mock.timers.tick(60_000); await flush();
    mock.timers.tick(60_000); await flush();
    assert.equal(runs, 3, 'getMs 예외 뒤에도 계속 돌아야 한다');
    assert.equal(rejections.length, 0, 'unhandledRejection 이 남으면 안 된다');
  } finally {
    t.stop(); mock.timers.reset(); warn.mock.restore();
    await flush();
    process.off('unhandledRejection', onRej);
  }
});

// ─────────────── TIM2601-03
test('TIM2601-03: 설정 파일 내용이 null 이어도 relaycheck·SAN perf 로더가 던지지 않고 손상본을 보존한다', async () => {
  const err = mock.method(console, 'error', () => {});
  try {
    const rc = await import('../src/relaycheck/settings.js');
    fs.writeFileSync(path.join(TMP, 'relaycheck-settings.json'), 'null');
    rc._resetForTest();
    const s = rc.loadSettings();
    assert.ok(Array.isArray(s.profile) && s.profile.length > 0);
    assert.doesNotThrow(() => rc.normalizeSettings(null));

    const pf = await import('../src/sanswitch/perfSettings.js');
    fs.writeFileSync(path.join(TMP, 'sanswitch-perf-settings.json'), 'null');
    pf._resetForTest();
    const p = pf.loadPerfSettings();
    assert.equal(p.enabled, false);
    assert.doesNotThrow(() => pf.normalizePerfSettings(null));
    const kept = fs.readdirSync(TMP).filter((f) => /^(relaycheck-settings|sanswitch-perf-settings)\.json\.corrupt\./.test(f));
    assert.equal(kept.length, 2, `손상본 보존: ${kept.join(',')}`);
  } finally { err.mock.restore(); }
});

// ─────────────── DB2601-03
test('DB2601-03: 로그 prune 은 첫 청크만 동기로 지우고 나머지는 양보하며 이어서 지운다', async () => {
  const log = mock.method(console, 'log', () => {});
  try {
    const { getLogsDb } = await import('../src/logs/db.js');
    const db = await getLogsDb();
    if (db.kind !== 'sqlite') return; // node:sqlite 없는 환경
    const rows = [];
    for (let i = 0; i < 3000; i++) rows.push({ vcenterId: 'vc1', key: `k${i}`, ts: T0 - 10 * DAY + i, severity: 'info', type: 't', user: '', entity: '', message: 'm' });
    for (let i = 0; i < 10; i++) rows.push({ vcenterId: 'vc1', key: `new${i}`, ts: T0 + i, severity: 'info', type: 't', user: '', entity: '', message: 'm' });
    db.insertMany(rows);
    const first = db.prune(T0 - DAY);
    assert.ok(first <= 500, `동기로 ${first}행을 지웠다(청크 500 초과 — 한 방 DELETE)`);
    const bg = db.pruneInFlight?.();
    assert.ok(bg, '남은 행이 있으면 백그라운드 청크 정리를 건다');
    await bg;
    assert.equal(db.rowCount(), 10, '보관기간 초과분은 결국 전부 지워진다');
    assert.equal(db.pruneOldest(10_000) <= 500, true, 'pruneOldest 도 청크 크기로 묶는다');
  } finally { log.mock.restore(); }
});

// ─────────────── DB2601-04
test('DB2601-04: curUserDbStatus 는 행 수를 캐시하고 countsAt 으로 밝히며, 적재하면 다시 센다', async () => {
  const cu = await import('../src/curuser/db.js');
  const s1 = await cu.curUserDbStatus();
  if (!s1.available) return;
  assert.equal(typeof s1.countsAt, 'number', 'countsAt 이 없다(캐시 사실을 밝히지 않음)');
  const s2 = await cu.curUserDbStatus();
  assert.equal(s2.countsAt, s1.countsAt, '두 번째 호출은 캐시를 쓴다');
  const c = await cu.commitCurUser({ ts: T0, records: [], series: [{ vcenterId: 'vc1', users: 3, usersActive: 2, sessions: 3, sessionsActive: 2, sessionsDisc: 1, vmsOk: 1, vmsFailed: 0 }] });
  assert.equal(c.ok, true);
  const s3 = await cu.curUserDbStatus();
  assert.equal(s3.seriesRows, s1.seriesRows + 1, '적재 뒤에는 다시 센다');
});

// ─────────────── SEC2601-01
function buildZip(entries, cdPointers) {
  // entries: [{name, data}] — deflate 로 로컬 헤더를 만든다. cdPointers: 중앙 디렉터리 [{name, idx}] (idx = 가리킬 로컬 엔트리)
  const locals = []; const offsets = []; let off = 0;
  for (const e of entries) {
    const comp = zlib.deflateRawSync(e.data);
    const nm = Buffer.from(e.name);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(e.data.length, 22); h.writeUInt16LE(nm.length, 26);
    offsets.push({ off, comp: comp.length, raw: e.data.length }); locals.push(h, nm, comp); off += 30 + nm.length + comp.length;
  }
  const cds = []; let cdLen = 0;
  for (const c of cdPointers) {
    const nm = Buffer.from(c.name); const t = offsets[c.idx];
    const h = Buffer.alloc(46); h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(8, 10);
    h.writeUInt32LE(t.comp, 20); h.writeUInt32LE(t.raw, 24); h.writeUInt16LE(nm.length, 28); h.writeUInt32LE(t.off, 42);
    cds.push(h, nm); cdLen += 46 + nm.length;
  }
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(cdPointers.length, 8); eocd.writeUInt16LE(cdPointers.length, 10);
  eocd.writeUInt32LE(cdLen, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, ...cds, eocd]);
}
test('SEC2601-01: 같은 로컬 데이터를 가리키는 zip 엔트리(겹침 폭탄)는 풀기 전에 거부한다', async () => {
  const { parseZip } = await import('../src/upgrade/archive.js');
  const ok = parseZip(buildZip([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'b.txt', data: Buffer.from('world') }],
    [{ name: 'a.txt', idx: 0 }, { name: 'b.txt', idx: 1 }]));
  assert.deepEqual(ok.map((e) => `${e.name}:${e.data}`), ['a.txt:hello', 'b.txt:world']);
  const bomb = buildZip([{ name: 'x', data: Buffer.alloc(1024 * 1024) }], Array.from({ length: 8 }, (_, i) => ({ name: `x${i}`, idx: 0 })));
  assert.throws(() => parseZip(bomb), /겹쳐|너무 큽니다/);
});

// ─────────────── SEC2601-03
test('SEC2601-03: 로그 가림이 JSON 인용 키·카멜케이스 비밀 필드를 잡고 식별자 키는 두지 않는다', async () => {
  const { redactLogLine, MASK } = await import('../src/edgelog/redact.js');
  assert.equal(redactLogLine('{"password":"S3cr3t!"}'), `{"password":"${MASK}"}`);
  assert.equal(redactLogLine('vcenterPass=abc'), `vcenterPass=${MASK}`);
  assert.equal(redactLogLine('guestPass: xyz'), `guestPass: ${MASK}`);
  assert.equal(redactLogLine('privateKey=-----BEGIN'), `privateKey=${MASK}`);
  assert.equal(redactLogLine('{"centralToken":"t1","n":1}'), `{"centralToken":"${MASK}","n":1}`);
  // 비밀이 아닌 식별자는 그대로(v2.549 규약)
  const ids = '{"deviceKey":"SVC1","partKey":"p:1","tokenFp":"sha256:ab"} deviceKey=SVC1 bypass=true';
  assert.equal(redactLogLine(ids), ids);
  // 빈 값은 그대로 — 그 자체가 진단
  assert.equal(redactLogLine('{"password":""}'), '{"password":""}');
  // 긴 줄에서도 선형
  const t = process.hrtime.bigint();
  redactLogLine(`{"password":"${'a'.repeat(200_000)}`);
  redactLogLine('"x '.repeat(100_000) + 'password');
  assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 500);
});

// ─────────────── DB2601-03 (poller)
async function pollTimes(n) {
  const { pollLogsOnce } = await import('../src/logs/poller.js');
  for (let i = 0; i < n; i++) await pollLogsOnce({ manual: true });
}
function oldRows(prefix, count, msgLen = 10) {
  const out = [];
  for (let i = 0; i < count; i++) out.push({ vcenterId: 'vc2', key: `${prefix}${i}`, ts: T0 - 20 * DAY + i, severity: 'info', type: 't', user: '', entity: '', message: 'm'.repeat(msgLen) });
  return out;
}
test('DB2601-03(poller): 보관기간 정리는 청크로 끝까지 지우고 실제 전체 건수를 보고한다', async () => {
  const lines = [];
  const log = mock.method(console, 'log', (...a) => lines.push(a.join(' ')));
  const warn = mock.method(console, 'warn', () => {});
  try {
    const { saveLogSettings } = await import('../src/logs/settings.js');
    const { getLogsDb } = await import('../src/logs/db.js');
    saveLogSettings({ enabled: true, retentionDays: 1, maxSizeMB: 0 });
    const db = await getLogsDb();
    if (db.kind !== 'sqlite') return;
    await db.pruneInFlight?.();
    db.pruneOldest(1e9); while (db.rowCount() > 0) db.pruneOldest(1e9);
    db.insertMany(oldRows('p', 3000));
    await pollTimes(10);
    await db.pruneInFlight?.();
    assert.equal(db.rowCount(), 0);
    const hit = lines.find((l) => /보관기간\(1일\) 초과/.test(l));
    assert.match(String(hit), /3000건/, `보고 건수가 실제 전체가 아니다: ${hit}`);
  } finally { log.mock.restore(); warn.mock.restore(); }
});
test('DB2601-03(poller): 용량 제한 정리는 청크마다 이벤트 루프에 양보한다', async () => {
  const log = mock.method(console, 'log', () => {});
  const warn = mock.method(console, 'warn', () => {});
  try {
    const { saveLogSettings } = await import('../src/logs/settings.js');
    const { getLogsDb } = await import('../src/logs/db.js');
    saveLogSettings({ enabled: true, retentionDays: 0, maxSizeMB: 1 });
    const db = await getLogsDb();
    if (db.kind !== 'sqlite') return;
    db.insertMany(oldRows('c', 8000, 400));
    assert.ok(db.sizeBytes() > 1024 * 1024, `DB 가 1MB 를 넘어야 한다: ${db.sizeBytes()}`);
    const before = db.rowCount();
    let turns = 0; let live = true;
    const spin = () => { if (!live) return; turns += 1; setImmediate(spin); };
    await pollTimes(9);
    setImmediate(spin);
    const { pollLogsOnce } = await import('../src/logs/poller.js');
    const p = pollLogsOnce({ manual: true });
    const turnsAtStart = turns;
    await p; live = false;
    assert.ok(db.rowCount() < before, '용량 초과분을 지웠다');
    assert.ok(turns - turnsAtStart >= 3, `정리 중 이벤트 루프 양보가 ${turns - turnsAtStart}회뿐이다(한 방 동기 삭제)`);
  } finally { log.mock.restore(); warn.mock.restore(); saveLogSettings2(); }
});
async function saveLogSettings2() { const { saveLogSettings } = await import('../src/logs/settings.js'); saveLogSettings({ maxSizeMB: 1024, retentionDays: 365 }); }

// ─────────────── LO2601-01 (저장·행 검증)
test('LO2601-01(저장): saveTarget 은 개행이 든 값을 저장 전에 거부하고 기존 항목을 바꾸지 않는다', async () => {
  const reg = await import('../src/agent/deployRegistry.js');
  const ok = reg.saveTarget({ host: '192.0.2.10', username: 'root', agentName: 'edge-ok' });
  assert.equal(ok.ok, true);
  const bad = reg.saveTarget({ id: ok.target.id, host: '192.0.2.10', username: 'root', agentName: 'edge-ok\nAUTH_ENABLED=false' });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /개행·NUL/);
  assert.equal(reg.getTargetRaw(ok.target.id).agentName, 'edge-ok', '거부된 저장이 캐시 값을 바꾸면 안 된다');
});

// ─────────────── TIM2601-01 형제(secretScan)
test('TIM2601-01(secretScan): 로그 꼬리 읽기가 finally 로 fd 를 닫는다', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'security', 'secretScan.js'), 'utf8'));
  assert.match(src, /try\s*\{\s*fs\.readSync\(fd[^}]*\}\s*finally\s*\{\s*fs\.closeSync\(fd\)/);
});

test('LO2601-01(행 검증): 대량 배포 미리보기·실행은 개행이 든 행을 오류로 뺀다', async () => {
  const express = (await import('express')).default;
  const { registerDeployLlm } = await import('../src/routes/admin/deployLlm.js');
  const app = express(); app.use(express.json({ limit: '2mb' }));
  const r = express.Router(); registerDeployLlm(r); app.use('/api/admin', r);
  const srv = app.listen(0, '127.0.0.1'); await new Promise((x) => srv.once('listening', x));
  const base = `http://127.0.0.1:${srv.address().port}/api/admin`;
  const post = (p, b) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  try {
    const text = '10.20.0.1\tAZ\n';
    const j = await (await post('/agent-deploy/bulk/preview', { text, defaults: { username: 'root', password: 'pw', collectorDatacenter: 'DC1\rX=1' } })).json();
    assert.equal(j.ok, true);
    const row = j.report.find((x) => x.host === '10.20.0.1');
    assert.equal(row.action, 'error', JSON.stringify(row));
    assert.match(row.reason, /개행·NUL/);
    const run = await post('/agent-deploy/bulk/run', { text, defaults: { username: 'root', password: 'pw', collectorDatacenter: 'DC1\rX=1' }, saveTargets: false, registerCollector: false });
    assert.equal(run.status, 400, '배포 가능한 행이 없어야 한다');
  } finally { srv.close(); }
});
