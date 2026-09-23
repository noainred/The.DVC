/**
 * v2.596 — 7차 점검(7축 병렬 감사 + 축별 반증 검증) 확정분 회귀 고정.
 *
 * 각 테스트는 **수정을 되돌리면 실패하도록** 입력을 골랐다(변이 검증은 릴리스 노트에 기록).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const read = (p) => stripComments(fs.readFileSync(path.join(SRC, p), 'utf8'));

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'a2596-'));
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';

/* ── R2596-01 svcmon probe·assign 주소 ── */
test('R2596-01 — probe·assign 응답도 비-admin 에게 엣지 주소를 가린다', () => {
  const s = read('routes/svcmon/edge.js');
  assert.match(s, /cur\.sourceIp = fullAddr\(req\) \? e\.sourceIp : null;/);
  assert.match(s, /const out = fullAddr\(req\) \? r : \{ \.\.\.r, sourceIp:/);
  assert.ok(!/res\.status\(r\.ok \? 200 : 400\)\.json\(r\);/.test(s), '가리지 않은 probe 응답이 남았다');
});

/* ── R2596-02·03 백업 지문 ── */
test('R2596-02 — 암호화 모드에서도 last* 만 바뀐 설정은 지문이 같다(봉인을 열어 비교)', async () => {
  const vault = await import('../src/security/secretVault.js');
  const { settingsFingerprint } = await import('../src/backup/service.js');
  const base = { monitors: [{ id: 'm1', name: 'x', hostA: { host: '10.0.0.1', password: 'secret-pw' } }] };
  const seal = (o) => JSON.stringify(vault.sealSecretsDeep(o, { mode: 'encrypted' }));
  const a = { 'capture-monitors.json': seal({ ...base, monitors: [{ ...base.monitors[0], lastRun: 1 }] }) };
  const b = { 'capture-monitors.json': seal({ ...base, monitors: [{ ...base.monitors[0], lastRun: 2 }] }) };
  assert.notEqual(a['capture-monitors.json'], b['capture-monitors.json'], '봉인 결과는 매번 달라야 이 테스트가 의미 있다');
  assert.equal(settingsFingerprint(a), settingsFingerprint(b));
  const c = { 'capture-monitors.json': seal({ monitors: [{ ...base.monitors[0], hostA: { host: '10.0.0.1', password: 'other' }, lastRun: 2 }] }) };
  assert.notEqual(settingsFingerprint(a), settingsFingerprint(c), '비밀번호 변경은 설정 변경이다');
});
test('R2596-03 — 엣지 토큰 lastUsedAt · 연동 키 useCount · 일일 보고 lastRunTs 는 설정 변경이 아니다', async () => {
  const { settingsFingerprint } = await import('../src/backup/service.js');
  const f = (name, o) => ({ [name]: JSON.stringify(o) });
  assert.equal(settingsFingerprint(f('central-agent-tokens.json', { tokens: [{ agent: 'a', hash: 'h', lastUsedAt: 1 }] })),
    settingsFingerprint(f('central-agent-tokens.json', { tokens: [{ agent: 'a', hash: 'h', lastUsedAt: 2 }] })));
  assert.equal(settingsFingerprint(f('api-keys.json', { keys: [{ id: 'k', useCount: 1 }] })), settingsFingerprint(f('api-keys.json', { keys: [{ id: 'k', useCount: 9 }] })));
  assert.equal(settingsFingerprint(f('daily-report.json', { enabled: true, lastRunTs: 1 })), settingsFingerprint(f('daily-report.json', { enabled: true, lastRunTs: 2 })));
});

/* ── R2596-06·08 ── */
test('R2596-06 — 0B 는 0 · R2596-08 DS 사용량 결측은 null', async () => {
  const { toBytesOrNull } = await import('../src/storage/collectors/cliSsh.js');
  assert.equal(toBytesOrNull('0B'), 0);
  assert.equal(toBytesOrNull('0.0B'), 0);
  assert.ok(!/usedGB: r\.used_gb \|\| 0/.test(read('vmtrack/service.js')));
});

/* ── CLAMP2596-01~03·05 빈 칸 ── */
test('CLAMP2596-01 — 세션 총 상한 빈 칸은 이전 값 유지(무제한으로 풀리지 않는다) · 명시적 0 은 무제한', async () => {
  const ss = await import('../src/security/securitySettings.js');
  ss.saveSessionSecurity({ sessionMaxHours: 8 });
  ss.saveSessionSecurity({ sessionMaxHours: '' });
  assert.equal(ss.loadConfiguredSecurity().sessionMaxHours, 8, '예전: 0(무제한)');
  ss.saveSessionSecurity({ sessionMaxHours: 0 });
  assert.equal(ss.loadConfiguredSecurity().sessionMaxHours, 0);
});
test('CLAMP2596-02 — 스파이크 수집 임계·보존일 빈 칸은 이전 값 유지', async () => {
  const vs = await import('../src/vmseries/settings.js');
  const before = vs.saveVmSeriesSettings({ retentionDays: 60, thresholds: { cpuPct: 50, memPct: 50, readyPct: 5 } });
  const after = vs.saveVmSeriesSettings({ retentionDays: '', intervalMin: '', thresholds: { cpuPct: '', memPct: 70, readyPct: '' } });
  assert.equal(after.retentionDays, before.retentionDays, '예전: 0(무제한)');
  assert.equal(after.intervalMin, before.intervalMin);
  assert.equal(after.thresholds.cpuPct, 50, '예전: 0(트리거 꺼짐)');
  assert.equal(after.thresholds.memPct, 70, '값을 준 임계는 반영');
  assert.equal(after.thresholds.readyPct, 5);
});
test('CLAMP2596-03·05 — 게스트 디스크 주기 · VM 성능 보존일 빈 칸', async () => {
  const gd = await import('../src/guestdisk/settings.js');
  gd.save({ intervalHours: 12 });
  assert.equal(gd.save({ intervalHours: '' }).intervalHours, 12, '예전: 1(하한)');
  const vp = await import('../src/metrics/vmperfSettings.js');
  vp.saveVmperfSettings({ retentionDays: 90 });
  assert.equal(vp.saveVmperfSettings({ retentionDays: '' }).retentionDays, 90, '예전: 0(무제한)');
  assert.equal(vp.saveVmperfSettings({ retentionDays: 0 }).retentionDays, 0, '명시적 0 은 무제한');
});

/* ── SECWEB-03 svcmon CSV 가드 ── */
test('SECWEB-03 — svcmon 결과 CSV 는 공용 가드(탭·CR 포함)를 쓴다', () => {
  const s = read('svcmon/csvlog.js');
  assert.match(s, /let s = guardCell\(v\);/);
  assert.ok(!/\/\^\[=\+\\-@\]\//.test(s));
});

/* ── DB-3·DB-4 ── */
test('DB-3 — link_daily ms_n 을 새로 만든 경우에만 구 행의 합을 비운다 · DB-4 prune 은 t0 인덱스를 탄다', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.join(CFG, 'mig.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE spikes (t0 INTEGER, t1 INTEGER); CREATE INDEX idx_spikes_t0 ON spikes(t0);');
  const plan = db.prepare('EXPLAIN QUERY PLAN DELETE FROM spikes WHERE t0 < ? AND t1 < ?').all(1, 1).map((r) => r.detail).join(' ');
  assert.match(plan, /idx_spikes_t0/);
  db.close();
  assert.match(read('vmseries/db.js'), /DELETE FROM spikes WHERE t0 < \? AND t1 < \?/);
  const l = read('linkcheck/db.js');
  assert.match(l, /ADD COLUMN ms_n INTEGER NOT NULL DEFAULT 0'\);\s*try \{ conn\.exec\('UPDATE link_daily SET ms_sum = 0 WHERE ms_n = 0'\)/);
});

/* ── EF-2·EF-3 엣지 pull 정리 ── */
test('EF-3 — 스토리지 pull 은 이 엣지에서 빠진 장비 id 를 돌려주고 스냅샷을 지운다', async () => {
  process.env.AGENT_NAME = 'edge-x';
  const reg = await import('../src/storage/registry.js');
  const { config } = await import('../src/config.js');
  config.agent.name = 'edge-x';
  reg.applyPulledDevices([{ id: 'd1', agent: 'edge-x', type: 'unity480', host: '10.0.0.1' }, { id: 'd2', agent: 'edge-x', type: 'unity480', host: '10.0.0.2' }]);
  const r = reg.applyPulledDevices([{ id: 'd1', agent: 'edge-x', type: 'unity480', host: '10.0.0.1' }]);
  assert.deepEqual(r.removed, ['d2']);
  assert.match(read('agent/storageConfigPull.js'), /for \(const id of ap\?\.removed \|\| \[\]\) dropSnapshot\(id\);/);
});
test('EF-2 — 중앙이 svcmon 배정을 지우면 central: 배치를 지운다', () => {
  const s = read('agent/svcmonConfigPull.js');
  assert.match(s, /if \(!d\?\.assigned\) \{[\s\S]{0,400}deleteTargetsByBatch\(tag\)/);
});

/* ── PERFWEB-02 정적 자산 gzip ── */
test('PERFWEB-02 — 해시 자산은 gzip 으로 한 번 압축해 재사용하고, 경로 탈출·작은 파일은 손대지 않는다', async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'a2596-dist-'));
  fs.mkdirSync(path.join(dist, 'assets'));
  const body = 'console.log(1);'.repeat(500);
  fs.writeFileSync(path.join(dist, 'assets', 'app-abc.js'), body);
  fs.writeFileSync(path.join(dist, 'assets', 'tiny.js'), 'x');
  const { createStaticGzip } = await import('../src/util/staticGzip.js');
  const mw = createStaticGzip(dist);
  const srv = http.createServer((req, res) => { req.path = new URL(req.url, 'http://x').pathname; mw(req, res, () => { res.statusCode = 299; res.end('next'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const get = (p, enc = 'gzip') => new Promise((r) => http.get({ port, path: p, headers: { 'accept-encoding': enc } }, (res) => { const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => r({ res, buf: Buffer.concat(ch) })); }));
  try {
    const a = await get('/assets/app-abc.js');
    assert.equal(a.res.headers['content-encoding'], 'gzip');
    assert.equal(zlib.gunzipSync(a.buf).toString(), body);
    assert.ok(a.buf.length < body.length / 5);
    assert.equal((await get('/assets/app-abc.js', 'identity')).res.statusCode, 299, 'gzip 을 못 받으면 원본 경로');
    assert.equal((await get('/assets/tiny.js')).res.statusCode, 299, '작은 파일은 원본');
    assert.equal((await get('/assets/..%2F..%2Fetc%2Fpasswd.js')).res.statusCode, 299, '이름 밖 경로는 원본 경로로(정적 미들웨어가 거부)');
  } finally { srv.close(); }
  assert.match(read('index.js'), /app\.use\(createStaticGzip\(config\.webDist\)\);/);
  assert.match(fs.readFileSync(path.join(SRC, 'index.js'), 'utf8').split('\n')[0], /logbuffer/, 'logbuffer 가 첫 import 다');
});
