/**
 * audit2590.test.js — v2.590 2차 점검(6축 병렬 감사) 확정분 회귀 고정.
 *
 * 각 테스트는 **수정 전 코드로 되돌리면 실패하는지**(변이 검증)를 기준으로 썼다 — 소스 문자열만 보는 검사는
 * 형태(순서·범위)가 바뀌면 통과해 버리므로, 가능한 한 실제 함수·실제 라우터·실제 파일을 돌린다.
 * 소스 검사는 **주석을 먼저 제거**한다(`_stripComments.js` — 규칙을 설명하는 주석이 통과 근거가 되면 안 된다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const ROOT = path.resolve(HERE, '../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2590-'));
process.env.CONFIG_DIR = TMP;
process.env.GUESTDISK_DB_PATH = path.join(TMP, 'gd.db');
process.env.VMTRACK_DB_PATH = path.join(TMP, 'vt.db');
process.env.DB_HEALTH_QUICK_MAX_BYTES = '1';   // 어떤 DB 도 '상한 초과' 가 되게 — 생략 분기를 실제로 태운다

const src = (rel) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));

// ── D1: viewer + tools 로 상태 변경 금지 ────────────────────────────────────────
test('★ D1: viewer(+tools) 는 IPAM 쓰기 7곳과 VMware Tools 업그레이드가 403(requiredRole) 이다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2590-rbac-'));
  fs.writeFileSync(path.join(dir, 'permissions.json'), JSON.stringify({
    schemaVersion: 2,
    matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } },
  }));
  const script = `
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { username: 'v', role: 'viewer', scope: null }; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const calls = [
      ['PUT', '/api/tools/ipam/annotation'], ['PUT', '/api/tools/ipam/ip/10.0.0.1'], ['DELETE', '/api/tools/ipam/ip/10.0.0.1'],
      ['POST', '/api/tools/ipam/bulk'], ['POST', '/api/tools/ipam/policies'], ['PUT', '/api/tools/ipam/policies/p1'],
      ['DELETE', '/api/tools/ipam/policies/p1'], ['POST', '/api/vms/upgrade-tools'],
    ];
    const out = {};
    for (const [m, p] of calls) {
      const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: m === 'DELETE' ? undefined : '{}' });
      let b = null; try { b = await r.json(); } catch {}
      out[m + ' ' + p] = { status: r.status, role: b && b.requiredRole };
    }
    srv.close();
    console.log('@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true' },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-400)}`);
  const out = JSON.parse(line.slice(2));
  for (const [k, v] of Object.entries(out)) {
    assert.equal(v.status, 403, `${k} 가 viewer 에게 열려 있습니다(${v.status})`);
    assert.ok(v.role, `${k} 의 403 이 역할 게이트가 아닙니다(requiredRole 없음 — requirePerm 만으로는 viewer 를 못 막는다)`);
  }
});

// ── D4: CONFIG-FILES.md 의 전 파일이 .gitignore 로 막혀야 한다(공개 저장소) ─────────────────
test('★ D4: docs/CONFIG-FILES.md 에 나열된 설정·데이터 파일이 전부 git check-ignore 를 통과한다', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/CONFIG-FILES.md'), 'utf8');
  const names = [...doc.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);
  assert.ok(names.length > 100, `문서 파싱 실패(${names.length})`);
  const paths = names.map((n) => `server/config/${n}`);
  const r = spawnSync('git', ['check-ignore', '--no-index', '-n', '-v', '--stdin'], { cwd: ROOT, input: paths.join('\n'), encoding: 'utf8' });
  const notIgnored = r.stdout.split('\n').filter((l) => l.startsWith('::')).map((l) => l.split('\t')[1]);
  assert.deepEqual(notIgnored, [], `막히지 않은 파일: ${notIgnored.join(', ')}`);
  // 예시 파일은 추적 대상으로 남아야 한다(설치 안내가 그것을 복사한다).
  const ex = spawnSync('git', ['check-ignore', '--no-index', '-q', 'server/config/vcenters.example.json'], { cwd: ROOT });
  assert.equal(ex.status, 1, '*.example.json 까지 막혔습니다');
});

// ── P1/D5: 백업 ────────────────────────────────────────────────────────────
const backup = await import('../src/backup/service.js');

test('★ P1: 백업 변경 감시는 상태·캐시 파일을 설정으로 보지 않는다(설정 파일은 그대로 본다)', () => {
  for (const n of ['central-inventory.json', 'central-agent-config.json', 'storage-activity.json', 'sanswitch-latest.json',
    'horizon-auth-stops.json', 'ipam-scan-history.json', 'backup.json', 'agent-results.json']) {
    assert.equal(backup.isRuntimeStateFile(n), true, `${n} 은 상태 파일이다`);
  }
  for (const n of ['vcenters.json', 'vcenter-logs.json', 'dirusage.json', 'users.json', 'portal.env', 'svcmon.json', 'permissions.json']) {
    assert.equal(backup.isRuntimeStateFile(n), false, `${n} 은 설정 파일이다 — 감시·지문에서 빠지면 변경 백업이 안 생긴다`);
  }
  const a = backup.settingsFingerprint({ 'vcenters.json': 'A', 'central-inventory.json': '1' });
  const b = backup.settingsFingerprint({ 'vcenters.json': 'A', 'central-inventory.json': '2' });
  const c = backup.settingsFingerprint({ 'vcenters.json': 'B', 'central-inventory.json': '1' });
  assert.equal(a, b, '상태 파일만 바뀌면 지문이 같아야 한다');
  assert.notEqual(a, c, '설정이 바뀌면 지문이 달라야 한다');
});

test('★ P1: 같은 설정의 change 백업은 만들지 않고, 자동 사유는 보관 슬롯을 독점하지 못한다', () => {
  backup._resetBackupFingerprint();
  fs.writeFileSync(path.join(TMP, 'alerts.json'), '{"a":1}');
  const first = backup.createBackup('manual', { retention: 30 });
  assert.ok(first.name && /-manual\.json\.gz$/.test(first.name), `파일명에 사유가 없습니다: ${first.name}`);
  fs.writeFileSync(path.join(TMP, 'storage-activity.json'), '{"x":1}');   // 상태 파일만 변경
  const same = backup.createBackup('change', { retention: 30, skipIfUnchanged: true });
  assert.equal(same.skipped, true, '상태 파일만 바뀐 change 백업이 만들어졌다');
  // change 를 AUTO_REASON_KEEP 보다 많이 만들어도 manual 은 살아남아야 한다(v2.589 까지는 30분 만에 밀려났다).
  for (let i = 0; i < backup.AUTO_REASON_KEEP + 5; i += 1) {
    fs.writeFileSync(path.join(TMP, 'alerts.json'), `{"a":${i + 2}}`);
    backup.createBackup('change', { retention: 12, skipIfUnchanged: true });
  }
  const list = backup.listBackups();
  const reasons = list.map((b) => backup.reasonOfName(b.name));
  assert.ok(reasons.includes('manual'), 'change 백업이 manual 백업을 밀어냈다');
  assert.ok(reasons.filter((r) => r === 'change').length <= backup.AUTO_REASON_KEEP, '자동 사유가 상한을 넘었다');
  assert.equal(backup.reasonOfName('portal-backup-2026-01-01T00-00-00-000Z.json.gz'), null, '구 이름(사유 없음)은 자동으로 치지 않는다');
});

test('★ D5: 크기 상한을 넘는 설정 파일은 조용히 빠지지 않고 결과에 실린다', () => {
  const big = path.join(TMP, 'huge-config.json');
  const fd = fs.openSync(big, 'w'); fs.ftruncateSync(fd, 9 * 1024 * 1024); fs.closeSync(fd);
  try {
    const r = backup.createBackup('manual', { retention: 30 });
    assert.ok(Array.isArray(r.skipped) && r.skipped.some((s) => s.name === 'huge-config.json'), `뺀 파일이 결과에 없습니다: ${JSON.stringify(r.skipped)}`);
    assert.ok(r.sizeCapBytes > 0);
    const arc = backup.readBackup(r.name);
    assert.ok(arc.central.skipped?.some((s) => s.name === 'huge-config.json'), '번들 자체에도 뺀 사실이 남아야 한다');
    assert.equal(arc.central.files[backup.SKIPPED_META], undefined, '메타 키가 파일로 복원되면 안 된다');
  } finally { fs.unlinkSync(big); }
});

test('★ P2: 복원 전 자동 백업은 설정된 보관 개수를 따른다(하드코딩 30 금지)', () => {
  const s = src('routes/admin/backupNetSec.js');
  assert.match(s, /restoreCentral\([^;]*retention:\s*loadBackupSettings\(\)\.retention/, '복원 라우트가 보관 개수를 넘기지 않는다');
  const svc = src('backup/service.js');
  assert.match(svc, /export function restoreCentral\(archive,\s*\{\s*retention/, 'restoreCentral 이 보관 개수를 받지 않는다');
});

// ── P11 / 로그 조회 만료 ───────────────────────────────────────────────────────
test('★ P11: 아무도 인출하지 않는 ping 요청은 영원히 pending 이 아니라 expired 가 된다', async () => {
  const pj = await import('../src/central/pingJobs.js');
  pj.enqueuePing('vc-dead', ['10.9.9.9']);
  assert.equal(pj.getPingResults('vc-dead', ['10.9.9.9'])['10.9.9.9']?.state, 'pending');
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 10 * 60_000;
    pj.reapPingClaims(Date.now());
    const r = pj.getPingResults('vc-dead', ['10.9.9.9'])['10.9.9.9'];
    assert.equal(r?.state, 'expired', `10분 뒤에도 ${JSON.stringify(r)}`);
  } finally { Date.now = realNow; }
});

test('★ P11: 로그 연합 조회는 인출되지 않으면 not-taken 으로 만료된다(무한 대기 금지)', async () => {
  const lq = await import('../src/central/logQueries.js');
  const rid = lq.enqueueLogQuery('vc-x', { q: 'err' }, 'alice');
  assert.equal(lq.getLogQueryResult(rid).state, 'pending');
  const later = lq.getLogQueryResult(rid, Date.now() + lq.QUERY_EXPIRE_MS + 1000);
  assert.equal(later.state, 'expired');
  assert.equal(later.why, 'not-taken');
});

// ── D2: svcmon 청크 ──────────────────────────────────────────────────────────
test('★ D2: svcmon push 는 메타를 청크마다 나눠 싣는다(첫 청크 몰기 금지) · 0행이어도 봉투 1개', async () => {
  const { splitSvcmonChunks } = await import('../src/agent/svcmonPush.js');
  const meta = Array.from({ length: 5000 }, (_, i) => ({ id: `m${i}` }));
  const chunks = splitSvcmonChunks(Array.from({ length: 300 }, (_, i) => i), meta, 1000);
  assert.equal(chunks.length, 5, '메타가 행보다 많으면 메타 기준으로 나눠야 한다');
  assert.ok(chunks.every((c) => c.meta.length <= 1000), '한 청크의 메타가 청크 크기를 넘었다');
  assert.equal(chunks.reduce((a, c) => a + c.meta.length, 0), 5000, '메타가 빠졌다');
  assert.equal(chunks.reduce((a, c) => a + c.rows.length, 0), 300, '행이 빠졌다');
  assert.equal(splitSvcmonChunks([], null, 250).length, 1, '0행이어도 하트비트 봉투 1개');
  const s = src('agent/svcmonPush.js');
  assert.doesNotMatch(s, /rows\.slice\(0,\s*chunkRows\)/, '413 재시도가 뒷부분 행을 버리는 형태로 돌아왔다');
  assert.match(fs.readFileSync(path.join(SRC, 'index.js'), 'utf8'), /app\.use\('\/api\/central\/svcmon-report',\s*BIG_JSON\)/, 'svcmon-report 가 BIG_JSON 에 없다');
});

// ── D6: LLM URL SSRF ────────────────────────────────────────────────────────
test('★ D6: LLM URL 은 스킴·SSRF 차단 대역을 검사한다', async () => {
  const { llmUrlIssue } = await import('../src/llm/config.js');
  assert.ok(llmUrlIssue('ftp://10.0.0.5/'), 'http(s) 외 스킴 허용');
  assert.ok(llmUrlIssue('http://169.254.169.254/latest/meta-data'), '메타데이터 주소 허용');
  assert.ok(llmUrlIssue('not a url'), '형식 오류 허용');
  assert.equal(llmUrlIssue('http://10.20.30.40:11434'), null, '사내 RFC1918 LLM 서버를 막으면 안 된다');
});

// ── P12: 스토리지 용량 중복 적재 ─────────────────────────────────────────────
test('★ P12: 같은 수집 시각의 용량 표본을 두 번 넣으면 일 롤업을 두 번 세지 않는다', async () => {
  const db = await import('../src/storage/db.js');
  const snap = { id: 'u-dup', deviceId: 'u-dup', ok: true, collectedAt: Date.now() - 60_000, capacity: { totalBytes: 100e12, usedBytes: 40e12 } };
  const a = await db.saveCapacityPoint(snap);
  if (a.reason === 'db-unavailable') return; // node:sqlite 없는 런타임
  assert.equal(a.saved, true);
  const b = await db.saveCapacityPoint(snap);
  assert.equal(b.duplicate, true, `두 번째 적재가 중복으로 걸러지지 않았다: ${JSON.stringify(b)}`);
  const rows = await db.dailySeries('u-dup', db.dayIndex(snap.collectedAt));
  assert.equal(rows[0]?.samples, 1, `일 롤업 표본 수가 ${rows[0]?.samples}`);
});

// ── P3: 게스트 디스크 carry-in ───────────────────────────────────────────────
test('★ P3: 게스트 디스크 조회 기간 안에 변화가 없어도 파티션·추이가 비지 않는다(carry-in)', async () => {
  const gd = await import('../src/guestdisk/db.js');
  const svc = await import('../src/guestdisk/service.js');
  const DAY = 86400e3; const now = Date.now();
  const vm = { vmId: 'vm-cin', vmName: 'web01', allocGB: 100, usedGB: 40, partCount: 1, parts: [{ path: 'C:\\', capGB: 60, usedGB: 30 }] };
  const c = await gd.commitCollection('vc1', 'VC1', [vm], { ts: now - 40 * DAY });
  if (c?.ok === false && /sqlite/i.test(String(c.reason))) return;
  await gd.commitCollection('vc1', 'VC1', [vm], { ts: now - 1 * DAY });
  const det = await svc.vmDetail('vm-cin', { days: 30 });
  assert.deepEqual(det.partitions.map((p) => p.path), ['C:\\'], '30일 창에 변화가 없다는 이유로 파티션이 사라졌다');
  assert.ok(det.vmTrendSeries.length >= 1, '추이가 비었다');
});

// ── P4/P5: vmtrack ─────────────────────────────────────────────────────────
test('★ P4: 1GB 미만씩 꾸준히 늘어도 차트가 실제 사용량을 1GB 안쪽으로 따라간다', async () => {
  const svc = await import('../src/vmtrack/service.js');
  const db = await import('../src/vmtrack/db.js');
  await db.getDb();
  const base = Date.parse('2026-08-01T01:00:00Z');
  let last = 0;
  for (let i = 0; i < 20; i += 1) {
    last = 100 + 0.6 * i;
    const snap = { vcenters: [{ id: 'vc1', status: 'ok' }], vms: [{ id: 'vm1', vcenterId: 'vc1', powerState: 'poweredOn', name: 'a' }],
      datastores: [{ id: 'vc1:DRIFT', vcenterId: 'vc1', name: 'DRIFT', capacityGB: 1000, usedGB: last, freeGB: 1000 - last }] };
    const r = await svc.takeVmSnapshot(snap, { now: new Date(base + i * 12 * 3600e3) });
    if (!r.ok && /sqlite/i.test(String(r.reason))) return;
    assert.ok(r.ok, JSON.stringify(r));
  }
  const ser = await svc.vmtrackDsSeries({ dsId: 'vc1:DRIFT', days: 3650 });
  const tail = ser.points.at(-1)?.usedGB;
  assert.ok(Math.abs(tail - last) < 1.0001, `차트 끝값 ${tail} 이 실제 ${last} 에서 1GB 이상 벗어났다(기준 드리프트)`);
});

test('★ P5: 값이 보존기간보다 오래 안 변한 데이터스토어도 prune 뒤 마지막 행이 남는다', async () => {
  const s = src('vmtrack/db.js');
  assert.match(s, /MAX\(rowid\)/, 'pruneDsSeries 가 ds 별 마지막 행을 보존하지 않는다');
});

// ── P16: 위임 수집 요청 큐 claim→ack ──────────────────────────────────────────
test('★ P16: 엣지 위임 수집 요청은 인출 즉시 사라지지 않고 결과 도착(ack)까지 유지된다', async () => {
  const { createCollectRequestQueue } = await import('../src/util/collectRequestQueue.js');
  const q = createCollectRequestQueue({ ttlMs: 60_000, ackMs: 1000, maxTries: 2 });
  const t0 = 1_000_000;
  q.request('dev1', 'Edge-A', t0);
  assert.deepEqual(q.take('edge-a', t0 + 10), ['dev1']);
  assert.equal(q.has('dev1', t0 + 20), true, '인출과 동시에 요청 표시가 꺼졌다(one-shot 회귀)');
  assert.equal(q.ack('dev1', t0 - 10 * 60_000), false, '인출 전 수집분으로 완료 처리하면 안 된다');
  assert.equal(q.ack('dev1', t0 + 30), true);
  assert.equal(q.has('dev1', t0 + 40), false);
  // 결과가 안 오면 재인출 1회 → 그래도 없으면 폐기하고 그 사실을 남긴다(조용한 소실 금지)
  q.request('dev2', 'edge-a', t0);
  q.take('edge-a', t0 + 1);
  assert.deepEqual(q.take('edge-a', t0 + 2000), ['dev2'], 'ack 시한이 지나면 재인출돼야 한다');
  assert.equal(q.has('dev2', t0 + 4000), false);
  assert.equal(q.lastDropped()?.id, 'dev2', '폐기 사실이 남지 않았다');
  for (const f of ['central/storageEdge.js', 'central/sanSwitchEdge.js', 'central/pduEdge.js', 'central/sanSwitchPerfEdge.js']) {
    assert.match(src(f), /ack[A-Za-z]*Collect\(/, `${f} 가 수신 시 ack 하지 않는다 — 요청이 영원히 '진행 중' 으로 남는다`);
  }
});

// ── P7: DB 점검 생략 ─────────────────────────────────────────────────────────
test('★ P7: 큰 DB 의 정합성 점검은 이벤트 루프를 막지 않고 생략하며 그 사실을 밝힌다', async () => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { return; }
  const p = path.join(TMP, 'probe.db');
  const d = new DatabaseSync(p); d.exec('CREATE TABLE t (a INTEGER, ts INTEGER); INSERT INTO t VALUES (1, 5);'); d.close();
  const { inspectSqlite } = await import('../src/insights/dbHealth.js');
  const r = await inspectSqlite(p, { full: false });
  assert.equal(r.checks.integrity?.mode, 'skipped', `상한 초과인데 quick_check 를 돌렸다: ${JSON.stringify(r.checks.integrity)}`);
  assert.equal(r.checks.integrity?.ok, null, "생략을 '정상' 으로 칠하면 안 된다");
  assert.ok(r.skipped.some((x) => /정합성 점검 생략/.test(x)));
  assert.match(src('routes/admin/statusTools.js'), /_dbHealthBusy/, '동시 점검 가드가 없다');
});

// ── P14: 업그레이드 체크포인트 하위 디렉터리 ────────────────────────────────────
test('★ P14: 업그레이드 전 WAL 체크포인트가 vCenter 별 하위 디렉터리 DB 까지 본다', async () => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt2590-'));
  fs.mkdirSync(path.join(root, 'vmperf'));
  const p = path.join(root, 'vmperf', 'vc1.db');
  const d = new DatabaseSync(p); d.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(a); INSERT INTO t VALUES (1);');
  const { checkpointConfigDbs } = await import('../src/upgrade/dbCheckpoint.js');
  const r = await checkpointConfigDbs(root);
  d.close();
  assert.ok(r.checkpointed.includes(path.join('vmperf', 'vc1.db')), `하위 디렉터리 DB 를 건너뛰었다: ${JSON.stringify(r)}`);
});

// ── F3/F4: SAN 스위치 점검 ────────────────────────────────────────────────────
const HDR = `          frames      enc    crc    crc    too    too    bad    enc   disc   link   loss   loss   frjt   fbsy
       tx     rx      in    err    g_eof  shrt   long   eof     out   c3    fail    sync   sig
`;
const SW = 'switchName: S\nswitchState: Online\nIndex Port Address  Media Speed   State     Proto\n==================================================\n'
  + '  5   5   010500   id    N16     Online      FC  F-Port  10:00:00:00:c9:aa:bb:cc\n';

test("★ F3: porterrshow 의 k/m/g 축약 카운터로 '신규 에러 없음(정상)' 을 단정하지 않는다", async () => {
  const { buildSnapshot } = await import('../src/sanswitch/collectors/fosSsh.js');
  const { checkDevice, checkPorts } = await import('../src/sanswitch/healthCheck.js');
  const { baselineFromSnapshot } = await import('../src/sanswitch/errBaseline.js');
  const pe = HDR + '  5:    4.1g   3.9g   0      3.4k   0      0      0      0      1.2m   0      2      3      31     0      0\n';
  const s1 = buildSnapshot({ id: 'f3', name: 'S', host: 'h' }, { switchshow: SW, porterrshow: pe });
  const p5 = s1.ports.list.find((p) => p.index === 5);
  assert.deepEqual(p5.errApprox, ['errCrc', 'errEncOut'], '축약된 열이 표시되지 않았다');
  assert.equal(p5.framesApprox, true);
  const base = baselineFromSnapshot(s1);
  const s2 = buildSnapshot({ id: 'f3', name: 'S', host: 'h' }, { switchshow: SW, porterrshow: pe });
  const item = checkDevice(s2, { baseline: base }).items.find((x) => x.key === 'portErrors');
  assert.notEqual(item.status, 'ok', `축약 카운터인데 '${item.detail}'`);
  assert.match(item.detail, /축약/);
  const row = checkPorts(s2, { baseline: base }).rows?.find((r) => r.index === 5) || checkPorts(s2, { baseline: base }).find?.((r) => r.index === 5);
  if (row) assert.notEqual(row.errors, 'ok', '포트별 표도 축약 카운터를 정상으로 칠했다');
  // 처리량: 축약 프레임 카운터의 차이는 트래픽이 아니다
  const { applyRates, _resetForTest } = await import('../src/sanswitch/rates.js');
  _resetForTest();
  const a = [{ index: 5, inFrames: 4.1e9, outFrames: 3.9e9, framesApprox: true }];
  applyRates('f3r', a, 1_000_000);
  const b = [{ index: 5, inFrames: 4.1e9, outFrames: 3.9e9, framesApprox: true }];
  applyRates('f3r', b, 1_300_000);
  assert.equal(b[0].inFps, null, "축약 카운터 차이를 '0 f/s' 로 보고했다");
  assert.equal(b[0].fpsHeld, 'approx');
});

test("★ F4: REST 수집 SAN 스위치는 수집한 광량·에러를 판정하고, 없는 항목에 '명령·권한' 조치를 말하지 않는다", async () => {
  const { checkDevice, restHealthSections, REST_NOT_COLLECTED } = await import('../src/sanswitch/healthCheck.js');
  const snap = {
    ok: true, switchState: 'Online', collectedAt: Date.now(),
    sections: { ports: 'ok', switch: 'ok', stats: 'ok', media: 'ok', fan: 'ok', psu: 'ok', fabric: 'ok' },
    ports: { list: [{ index: 0, state: 'online', rxPowerDbm: -15.2, errCrc: 1234, errEncOut: 0, errLinkFail: 0, errLossSync: 0, errLossSig: 0, discC3: 0 }] },
    health: { status: 'Online', fans: { ok: 1, total: 1 }, psus: { ok: 1, total: 1 } },
    extra: { collectMethod: 'rest' },
  };
  const items = checkDevice(snap).items;
  assert.equal(items.find((x) => x.key === 'optical').status, 'bad', '장애 수준 광량(-15.2 dBm)을 못 봤다');
  assert.notEqual(items.find((x) => x.key === 'portErrors').status, 'unknown', '수집한 에러 카운터를 못 봤다');
  for (const it of items.filter((x) => x.status === 'unknown')) {
    assert.doesNotMatch(it.detail, /명령이 없거나 계정 권한/, `${it.key}: REST 스위치에 틀린 조치를 준다`);
  }
  assert.equal(restHealthSections({ fabric: 'ok' }).fabric, REST_NOT_COLLECTED, "REST fabric 키를 SSH fabricshow 성공으로 읽으면 '형식을 못 읽었다' 는 거짓이 된다");
});

test('★ 화면으로 가는 SAN 점검 문구에 백틱이 없다(BoldText 는 백틱을 글자로 보여준다)', () => {
  const s = fs.readFileSync(path.join(SRC, 'sanswitch/healthCheck.js'), 'utf8');
  const code = stripComments(s);
  assert.equal((code.match(/\\`/g) || []).length, 0, '템플릿 리터럴 안의 이스케이프된 백틱');
  // 홑따옴표 문자열이 백틱으로 시작하는 형태('`cmd` …')만 본다 — 넓은 정규식은 중첩 템플릿에서 오탐한다(CLAUDE.md v2.576).
  assert.doesNotMatch(code, /'`[A-Za-z]/, '홑따옴표 문자열 안의 백틱');
});

// ── F5: PDU ─────────────────────────────────────────────────────────────────
test("★ F5: PDU 센서·뱅크 값을 못 읽은 주기는 '정상으로 돌아왔습니다' 가 아니라 보류다", async () => {
  const { evaluateSnapshot, diffAlerts, readAlertKeys } = await import('../src/pdu/thresholds.js');
  const th = { enabled: true, tempWarnC: 32, tempCritC: 40, humHighPct: 80, humLowPct: 20, powerWarnW: null, powerCritW: null, bankWarnA: 12, bankCritA: 16 };
  const state = new Map();
  const A = { id: 'p1', ok: true, units: [{ index: 1, banks: [{ index: 1, currentA: 17 }] }], sensors: [{ index: 1, tempC: 45, humidityPct: 40 }] };
  const B = { id: 'p1', ok: true, units: [{ index: 1, banks: [{ index: 1, currentA: null }] }], sensors: [{ index: 1, tempC: null, humidityPct: 41 }] };
  const t = 1e12;
  assert.equal(diffAlerts(evaluateSnapshot(A, th), { now: t, state, readKeys: readAlertKeys(A) }).fire.length, 2);
  const r2 = diffAlerts(evaluateSnapshot(B, th), { now: t + 300_000, state, readKeys: readAlertKeys(B) });
  assert.deepEqual(r2.resolve, [], `못 읽은 값을 복구로 판정했다: ${r2.resolve.map((x) => x.key)}`);
  const r3 = diffAlerts(evaluateSnapshot(A, th), { now: t + 600_000, state, readKeys: readAlertKeys(A) });
  assert.deepEqual(r3.fire, [], '다시 읽혔을 때 쿨다운을 무시하고 재발송했다');
  // 오래 못 읽으면 해소 알림 없이 끊는다(복구가 아니라 모르는 것)
  const r4 = diffAlerts([], { now: t + 600_000 + 7 * 3600e3, state, readKeys: new Set() });
  diffAlerts([], { now: t + 600_000 + 14 * 3600e3, state, readKeys: new Set() });
  assert.deepEqual(r4.resolve, []);
  assert.equal(state.size, 0, '보류가 영원히 남았다');
  // 값이 실제로 정상으로 읽히면 그때는 복구다
  const st2 = new Map();
  diffAlerts(evaluateSnapshot(A, th), { now: t, state: st2, readKeys: readAlertKeys(A) });
  const C = { id: 'p1', ok: true, units: [{ index: 1, banks: [{ index: 1, currentA: 5 }] }], sensors: [{ index: 1, tempC: 25, humidityPct: 40 }] };
  assert.equal(diffAlerts(evaluateSnapshot(C, th), { now: t + 1, state: st2, readKeys: readAlertKeys(C) }).resolve.length, 2);
});

// ── F8: Horizon ─────────────────────────────────────────────────────────────
test('★ F8: 서버별 이름 목록이 잘렸으면 전체 사용자는 하한값이고 그 사실을 밝힌다', async () => {
  const { combineServers } = await import('../src/horizon/sessions.js');
  const names = Array.from({ length: 2000 }, (_, i) => ({ name: `u${i}`, sessions: 1, connected: 1 }));
  const agg = combineServers([{ ok: true, serverId: 's1', sessions: 2500, connected: 2500, disconnected: 0, pending: 0, users: 2500, usersConnected: 2500, usersOmitted: 500, names }]);
  assert.equal(agg.usersLowerBound, true);
  assert.equal(agg.users, 2500, '잘린 목록의 합집합(2000)을 전체로 냈다 — 서버 행(2500)보다 작은 모순');
  assert.equal(agg.usersOmitted, 500);
});

// ── F9/F11: 베어메탈 사용률 ─────────────────────────────────────────────────
test('★ F9: 전이중 회선 사용률은 방향별 최대이지 rx+tx 합이 아니다', async () => {
  const { maxStrict } = await import('../src/bmusage/rates.js');
  assert.equal(maxStrict([10, 30]), 30);
  assert.equal(maxStrict([null, 30]), null, '한 방향을 못 읽으면 단정하지 않는다');
  assert.match(src('bmusage/usage.js'), /linkPct\(maxStrict\(/, '사용률이 방향 최대를 쓰지 않는다');
});

test('★ F11: /proc/stat 의 guest 시간을 두 번 세지 않는다', async () => {
  const { parseProcStat } = await import('../src/bmusage/parse/linuxProc.js');
  // user 100(그중 guest 50) · idle 100 → busy 는 100/200 = 50% 여야 한다
  const r = parseProcStat(['cpu  100 0 0 100 0 0 0 0 50 0']);
  const total = r.total ?? r.cpu?.total;
  assert.equal(total, 200, `guest 를 합에 더했다(total=${total})`);
});

// ── F10: Isilon ─────────────────────────────────────────────────────────────
test("★ F10: Isilon 'Critical Events' 절이 없으면 경보 0 이 아니라 미수집이다", async () => {
  const { parseIsiStatus, normalizeIsiStatus } = await import('../src/storage/collectors/isilonSsh.js');
  const txt = 'Cluster Name: C1\nCluster Health: [ OK ]\nCluster Storage:  HDD                 SSD Storage\nSize:             100T (100T Raw)     0 (0 Raw)\n';
  const snap = normalizeIsiStatus({ id: 'i1', name: 'C1', host: 'h' }, parseIsiStatus(txt));
  assert.equal(snap.alerts.unresolved, null, "이벤트 절을 못 봤는데 '경보 0' 이라 했다");
  const many = Array.from({ length: 60 }, (_, i) => `09/01 10:0${i % 10} 1 Critical event ${i}`).join('\n');
  const p2 = parseIsiStatus(`${txt}Critical Events:\nTime LNN Event\n${many}\n`);
  if (p2.sawEvents) {
    const s2 = normalizeIsiStatus({ id: 'i1', name: 'C1', host: 'h' }, p2);
    if (p2.criticalEventCount > 50) assert.equal(s2.extra.criticalEventsOmitted, p2.criticalEventCount - 50, '상한으로 잘린 개수를 밝히지 않았다');
  }
});

// ── 나머지: 소스 불변조건 ───────────────────────────────────────────────────
test('★ P6·P13·P15·P17·D9: 소스 불변조건', () => {
  assert.match(src('tools/powerOffPoller.js'), /NOT_SERVING/, "전원꺼짐 판정이 '서비스 안 하는 vCenter' 를 보류하지 않는다(P6)");
  assert.match(src('security/credentialStore.js'), /registerExitFlush\(/, '볼트 사용 기록이 종료 시 flush 되지 않는다(P13)');
  assert.match(src('store.js'), /db\.prune\(\s*ts\s*-\s*raw\s*\*/, '원시 보존일과 롤업 보존일을 한 값으로 prune 한다(P15)');
  assert.match(src('rma/agent.js'), /new Set\(batch\)/, 'RMA outbox 가 보낸 것만 지우지 않는다(P17)');
  assert.doesNotMatch(src('proxy/deploy.js'), /toISOString\(\)\.replace\(/, 'HAProxy 백업 파일명이 표식 없는 UTC 다(D9)');
  assert.match(src('util/bigJsonGate.js'), /\/api\/admin\/log-analysis\//, '로그 분석 붙여넣기가 대용량 파서를 못 탄다');
});

test('★ P9: 스토리지 보존일 env 가 설정 파일이 없을 때 반영되고 출처를 밝힌다', async () => {
  process.env.STORAGE_HISTORY_KEEP_DAYS = '45';
  const gs = await import('../src/storage/growthSettings.js');
  gs._resetForTest();
  const s = gs.loadGrowthSettings();
  assert.equal(s.rawKeepDaysSource, 'env', `출처: ${JSON.stringify(s)}`);
  assert.equal(s.rawKeepDays, 45, `env 값이 무시됐다: ${JSON.stringify(s)}`);
  assert.equal(s.dailyKeepDaysSource, 'default');
  delete process.env.STORAGE_HISTORY_KEEP_DAYS;
});
