/**
 * v2.620 감사 그룹 C — 회귀 테스트.
 *  - SRV2620-01: 폴더 사용량 리포트가 Top-N 끼리만 비교해 순위 밖 이탈을 '삭제', 순위 진입을 '신규' 로 말하던 결함.
 *  - EDGE2620-04: 엣지 설정 push 가 상태·캐시 파일까지 비압축으로 보내고, 413 이면 설정 사본 전체가 실패하던 결함.
 *  - PERF2620-01: 백업이 gzipSync 로 메인 루프를 멈추던 것 → 비동기 gzip + 백업 직렬화.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { stripComments } from './_stripComments.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2620c-'));
process.env.CONFIG_DIR = DIR;
process.env.DIRUSAGE_DB_PATH = path.join(DIR, 'dirusage.db');
process.env.SSRF_ALLOW_LOOPBACK = 'true';

const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');

// ── SRV2620-01 ──────────────────────────────────────────────────────────────
function mkRec(scan, sizes, ts, topN = 2) {
  const out = Object.entries(sizes).map(([n, b]) => `${b}\t/mnt/s/${n}`).join('\n')
    + `\n${Object.values(sizes).reduce((a, b) => a + b, 0)}\t/mnt/s`;
  return scan.buildScanRecord({ targetId: 't', root: '/mnt/s', agent: 'e', ts, parsed: scan.parseDuOutput(out, '/mnt/s'), topN });
}

test('SRV2620-01 — 순위 밖으로 밀린 폴더는 삭제가 아니고, 순위에 오른 기존 폴더는 신규가 아니다(재현 du.mjs)', async () => {
  const scan = await import('../src/dirusage/scan.js');
  const { renderReport } = await import('../src/dirusage/report.js');
  const prev = mkRec(scan, { a: 300, b: 200, c: 100 }, 1);
  const cur = mkRec(scan, { a: 300, b: 50, c: 250 }, 2);
  const c = scan.compareScans(cur, prev);
  assert.deepEqual(c.removed, [], 'b 는 50B 로 존재한다 — 삭제가 아니다');
  assert.deepEqual(c.rankedOut.map((r) => [r.name, r.confirmed]), [['b', true]]);
  assert.equal(c.delta.get('c').isNew, false, 'c 는 100→250 인 기존 폴더다 — 신규가 아니다');
  assert.equal(c.delta.get('c').entered, true);
  assert.equal(c.delta.get('c').existedBefore, true);
  const { text, html } = renderReport(cur, prev);
  assert.ok(!/사라진 폴더/.test(text), text);
  assert.match(text, /순위 밖으로 밀린 폴더 1개\(지금도 있음\): b/);
  assert.match(text, /순위 진입\s+c/);
  assert.ok(!/신규/.test(text), '기존 폴더를 신규로 적으면 안 된다');
  assert.match(html, /순위 밖으로 밀린 폴더/);
});

test('SRV2620-01 — 정말 지운 폴더는 삭제, 정말 새 폴더는 신규로 여전히 말한다', async () => {
  const scan = await import('../src/dirusage/scan.js');
  const prev = mkRec(scan, { a: 300, b: 200, c: 100 }, 1);
  const cur = mkRec(scan, { a: 300, d: 250, c: 10 }, 2);   // b 삭제 · d 신규
  const c = scan.compareScans(cur, prev);
  assert.deepEqual(c.removed.map((r) => r.name), ['b']);
  assert.equal(c.delta.get('d').isNew, true);
});

test('SRV2620-01 — 지문 집합이 없는 옛 기록은 단정하지 않는다(확인 불가로 따로 말한다)', async () => {
  const scan = await import('../src/dirusage/scan.js');
  const { renderReport } = await import('../src/dirusage/report.js');
  const prev = mkRec(scan, { a: 300, b: 200, c: 100 }, 1); delete prev.nameSet;   // v2.619 이전 행
  const cur = mkRec(scan, { a: 300, b: 50, c: 250 }, 2); delete cur.nameSet;
  const c = scan.compareScans(cur, prev);
  assert.deepEqual(c.removed, []);
  assert.deepEqual(c.rankedOut.map((r) => [r.name, r.confirmed]), [['b', false]]);
  assert.equal(c.delta.get('c').isNew, false);
  assert.equal(c.delta.get('c').existedBefore, null);
  assert.equal(c.enteredUnknown, 1);
  const { text } = renderReport(cur, prev);
  assert.match(text, /확인 불가/);
  assert.match(text, /새로 생긴 폴더인지 알 수 없습니다/);
  // DB 행 모양(snake_case)도 읽는다
  const row = { ...prev, others_count: prev.othersCount, name_set: mkRec(scan, { a: 300, b: 200, c: 100 }, 1).nameSet };
  delete row.othersCount;
  assert.equal(scan.compareScans(mkRec(scan, { a: 300, b: 50, c: 250 }, 2), row).delta.get('c').existedBefore, true);
});

test('SRV2620-01 — Top-N 이 전체 목록이면(그 외 0개) 지문 없이도 판정한다 · truncated 는 증거가 아니다', async () => {
  const scan = await import('../src/dirusage/scan.js');
  const prev = mkRec(scan, { a: 3, b: 2 }, 1, 5); delete prev.nameSet;
  const cur = mkRec(scan, { a: 3, z: 2 }, 2, 5); delete cur.nameSet;
  const c = scan.compareScans(cur, prev);
  assert.equal(c.delta.get('z').isNew, true);
  assert.deepEqual(c.removed.map((r) => r.name), ['b']);
  const curT = { ...mkRec(scan, { a: 300, c: 250 }, 2), truncated: true };
  const c2 = scan.compareScans(curT, mkRec(scan, { a: 300, b: 200, c: 100 }, 1));
  assert.deepEqual(c2.removed, [], 'truncated 기록에서 없는 것은 삭제의 증거가 아니다');
  assert.equal(c2.rankedOut[0].confirmed, false);
});

test('SRV2620-01 — DB 는 name_set 을 저장·로드하고(옛 DB 는 열을 추가), 목록 응답에는 싣지 않는다', async () => {
  // 옛 스키마 DB 를 먼저 만든다(name_set 열 없음)
  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(process.env.DIRUSAGE_DB_PATH);
  old.exec(`CREATE TABLE scans (id INTEGER PRIMARY KEY AUTOINCREMENT, target_id TEXT NOT NULL, agent TEXT NOT NULL DEFAULT '',
    root TEXT NOT NULL, ts INTEGER NOT NULL, total_bytes INTEGER, sum_bytes INTEGER NOT NULL DEFAULT 0, count INTEGER NOT NULL DEFAULT 0,
    others_bytes INTEGER NOT NULL DEFAULT 0, others_count INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
    truncated INTEGER NOT NULL DEFAULT 0, entries TEXT NOT NULL DEFAULT '[]', mailed INTEGER NOT NULL DEFAULT 0, mail_note TEXT)`);
  old.prepare("INSERT INTO scans (target_id, root, ts, entries) VALUES ('t', '/mnt/s', 1, '[]')").run();
  old.close();
  const scan = await import('../src/dirusage/scan.js');
  const { getDb } = await import('../src/dirusage/db.js');
  const db = await getDb();
  assert.ok(db, 'DB 가 열려야 한다');
  assert.equal(db.last('t').name_set, null, '옛 행은 NULL');
  const rec = mkRec(scan, { a: 300, b: 200, c: 100 }, 5);
  db.insertScan(rec);
  const last = db.last('t');
  assert.equal(last.name_set, rec.nameSet);
  assert.equal(scan.nameSetOf(last).size, 3);
  assert.ok(db.list('t', 10).every((r) => !('name_set' in r)), '목록 응답에 지문 집합을 싣지 않는다');
  assert.ok(db.latestAll().every((r) => !('name_set' in r)));
});

// ── EDGE2620-04 ─────────────────────────────────────────────────────────────
test('EDGE2620-04 — 상태·캐시 파일은 push 대상에서 빠지고(설정+실행필드 파일은 남는다) 개수를 돌려준다', async () => {
  const { splitStateFiles } = await import('../src/agent/configPush.js');
  const { registerStateFile } = await import('../src/util/stateFiles.js');
  registerStateFile('custom-cursor-2620.json');
  const { settings, stateNames } = splitStateFiles({
    'vcenters.json': '{}', 'os-scan.json': '{}', 'svcmon-log.json': '{}', 'portal.env': 'A=1',
    'idrac-inventory.json': '{}', 'storage-latest.json': '{}', 'cvp-push.json': '{}', 'storage-activity.json': '{}',
    'custom-cursor-2620.json': '{}',
  });
  assert.deepEqual(Object.keys(settings).sort(), ['os-scan.json', 'portal.env', 'svcmon-log.json', 'vcenters.json']);
  assert.deepEqual(stateNames, ['custom-cursor-2620.json', 'cvp-push.json', 'idrac-inventory.json', 'storage-activity.json', 'storage-latest.json']);
});

test('EDGE2620-04 — dropLargestFiles 는 큰 것부터 빼고 최소 1개는 남긴다', async () => {
  const { dropLargestFiles } = await import('../src/agent/configPush.js');
  const d = dropLargestFiles({ 'a.json': 'x'.repeat(10), 'b.json': 'x'.repeat(1000), 'c.json': 'x'.repeat(100) }, 2);
  assert.deepEqual(d.dropped.map((f) => f.name), ['b.json', 'c.json']);
  assert.deepEqual(Object.keys(d.files), ['a.json']);
  assert.deepEqual(Object.keys(dropLargestFiles({ 'only.json': '{}' }, 8).files), ['only.json']);
});

async function mockCentral(statuses) {
  const reqs = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let raw = Buffer.concat(chunks);
      const gz = /gzip/i.test(String(req.headers['content-encoding'] || ''));
      if (gz) raw = zlib.gunzipSync(raw);
      reqs.push({ url: req.url, gzip: gz, body: JSON.parse(raw.toString('utf8')) });
      const st = statuses.shift() ?? 200;
      res.statusCode = st;
      res.setHeader('Content-Type', 'application/json');
      res.end(st === 200 ? '{"ok":true}' : '{"ok":false}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, reqs, url: `http://127.0.0.1:${srv.address().port}` };
}

test('EDGE2620-04 — push 는 gzip 이고 상태 파일을 보내지 않으며, 413 이면 큰 파일을 빼고 한 번 다시 보낸다', async () => {
  fs.writeFileSync(path.join(DIR, 'alerts.json'), '{"a":1}');
  fs.writeFileSync(path.join(DIR, 'big-settings.json'), JSON.stringify({ blob: 'y'.repeat(200_000) }));
  fs.writeFileSync(path.join(DIR, 'idrac-inventory.json'), JSON.stringify({ inv: 'z'.repeat(50_000) }));
  const { config } = await import('../src/config.js');
  const m = await import('../src/agent/configPush.js');
  let c = await mockCentral([200]);
  config.agent = { ...(config.agent || {}), name: 'edge-2620c', centralUrl: c.url, centralToken: 'tok-2620' };
  try {
    m._resetConfigPush();
    assert.equal(await m.pushConfigNow(), true);
    const r0 = c.reqs.find((r) => r.url === '/api/central/agent-config');
    assert.ok(r0.gzip, '본문은 gzip 이어야 한다(중앙 express.json 이 자동 해제)');
    assert.ok(r0.body.files['alerts.json']);
    assert.equal(r0.body.files['idrac-inventory.json'], undefined, '상태·캐시 파일은 설정 push 대상이 아니다');
    const st = m.configPushStatus().last;
    assert.ok(st.stateExcluded >= 1 && st.stateExcludedNames.includes('idrac-inventory.json'), JSON.stringify(st));
    assert.ok(st.bytes < st.rawBytes, '압축 크기를 밝힌다');
  } finally { c.srv.close(); }

  c = await mockCentral([413, 200]);
  config.agent = { ...config.agent, centralUrl: c.url };
  try {
    m._resetConfigPush();
    assert.equal(await m.pushConfigNow(), true);
    const posts = c.reqs.filter((r) => r.url === '/api/central/agent-config');
    assert.equal(posts.length, 2, '413 이면 정확히 한 번 다시 보낸다');
    assert.ok(posts[0].body.files['big-settings.json']);
    assert.equal(posts[1].body.files['big-settings.json'], undefined, '가장 큰 파일부터 뺀다');
    const st = m.configPushStatus().last;
    assert.ok(st.retryDropped.some((f) => f.name === 'big-settings.json'), JSON.stringify(st));
  } finally { c.srv.close(); }
});

// ── PERF2620-01 ─────────────────────────────────────────────────────────────
test('PERF2620-01 — createBackup 은 비동기(gzipSync 를 쓰지 않는다) · restoreCentral 은 사전 백업을 기다린다', async () => {
  const svc = stripComments(fs.readFileSync(path.join(SRC, 'backup/service.js'), 'utf8'));
  assert.ok(!/gzipSync\s*\(/.test(svc), 'backup/service.js 에 gzipSync 가 남아 있다');
  assert.match(svc, /await\s+createBackup\('pre-restore'/);
  const bk = await import('../src/backup/service.js');
  bk._resetBackupFingerprint();
  fs.writeFileSync(path.join(DIR, 'ui.json'), '{"v":1}');
  const p = bk.createBackup('manual', { retention: 30 });
  assert.equal(typeof p.then, 'function', 'createBackup 은 Promise 를 돌려준다');
  const r = await p;
  assert.ok(r.name && fs.existsSync(path.join(DIR, 'backups', r.name)));
  assert.equal(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, 'backups', r.name)))).central.files['ui.json'], '{"v":1}');
});

test('PERF2620-01 — 겹친 백업은 한 줄로 선다(지문 생략이 앞 백업 완료를 본다 · v2.590 P1 유지)', async () => {
  const bk = await import('../src/backup/service.js');
  bk._resetBackupFingerprint();
  fs.writeFileSync(path.join(DIR, 'ui.json'), '{"v":2}');
  const [a, b] = await Promise.all([
    bk.createBackup('change', { retention: 30, skipIfUnchanged: true }),
    bk.createBackup('change', { retention: 30, skipIfUnchanged: true }),
  ]);
  assert.notEqual(a.skipped, true);
  assert.equal(b.skipped, true, '같은 내용의 두 번째 change 백업은 생략돼야 한다');
  assert.ok(Array.isArray(a.skipped), '성공 백업의 skipped 는 배열(v2.590 D5)');
});

test('PERF2620-01 — 복원 전 백업에는 덮어쓰기 **전** 설정이 들어간다', async () => {
  const bk = await import('../src/backup/service.js');
  fs.writeFileSync(path.join(DIR, 'ui.json'), '{"v":"before"}');
  const r = await bk.restoreCentral({ central: { files: { 'ui.json': '{"v":"restored"}' } } }, { retention: 30 });
  assert.equal(r.restored, 1);
  assert.equal(fs.readFileSync(path.join(DIR, 'ui.json'), 'utf8'), '{"v":"restored"}');
  const pre = bk.listBackups().find((b) => bk.reasonOfName(b.name) === 'pre-restore');
  assert.ok(pre, 'pre-restore 백업이 있어야 한다');
  assert.equal(bk.readBackup(pre.name).central.files['ui.json'], '{"v":"before"}');
});
