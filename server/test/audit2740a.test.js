/**
 * test/audit2740a.test.js — v2.740 점검 그룹 a(아이실론 du·스캔 기록) 회귀.
 *
 *  A-01 device 인증 대상의 접속 주소는 등록부 값으로 고정한다(엣지 /isidu-test 본문 host 로 저장 비밀번호가 나가지 않게).
 *  C-01 엣지 cleanEdgeTarget 도 메인과 같은 SSRF 판정을 한다.
 *  A-02 미래 시각(엣지 시계가 앞으로 튐) 결과가 '지금 수집' 기준선을 미래로 굳히지 않는다.
 *  A-03 du 작업 상태를 연속으로 못 읽으면 시한까지 매달리지 않고 끊는다.
 *  A-04 강제 적용 문구는 재개가 실제로 이어지는지 말한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import ssh2 from 'ssh2';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2740a-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.SSH_HOSTKEY_POLICY = 'observe';
process.env.ISIDU_SSH_KEY = '';
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

// 엣지 스토리지 등록부 — 실제 아이실론 주소는 127.0.0.2(아무도 듣지 않는다 → 곧바로 연결 거부).
fs.writeFileSync(path.join(DIR, 'storage-devices.json'), JSON.stringify({ version: 1, devices: [
  { id: 'isi-1', name: 'isi-1', type: 'isilon', host: '127.0.0.2', username: 'root', password: 'S3cret-Isilon-PW', agent: '', enabled: true },
] }));

test('A-01 credsFor(device) 는 본문 host 를 무시하고 등록부 주소로 접속한다', async () => {
  const { credsFor } = await import('../src/isidu/collect.js');
  const r = await credsFor({ id: 'p', auth: 'device', deviceId: 'isi-1', host: '10.66.66.66', port: 22, path: '/ifs/a' });
  assert.ok(r.creds, JSON.stringify(r));
  assert.equal(r.creds.host, '127.0.0.2');
  assert.equal(r.creds.password, 'S3cret-Isilon-PW');
});

test('A-01 엣지 /isidu-test: 본문 host 가 가짜 SSH 서버여도 저장 비밀번호가 그쪽으로 가지 않는다(실제 접속)', async () => {
  const got = [];
  const hostKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' });
  const srv = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') got.push(ctx.password);
      if (ctx.method === 'keyboard-interactive') { ctx.prompt([{ prompt: 'Password: ', echo: false }], (a) => { got.push(a); ctx.reject(); }); return; }
      ctx.reject(['password', 'keyboard-interactive']);
    });
    client.on('error', () => {});
  });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  try {
    const { edgeIsiduTest } = await import('../src/isidu/edgeOps.js');
    const r = await edgeIsiduTest({ target: { id: 'probe', host: '127.0.0.1', port, username: 'root', auth: 'device', deviceId: 'isi-1', path: '/ifs' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false); // 등록부 주소(127.0.0.2)는 듣는 곳이 없다
    assert.deepEqual(got, [], '가짜 서버가 자격증명을 받으면 안 된다');
  } finally { srv.close(); }
});

test('C-01 cleanEdgeTarget 은 링크로컬·메타데이터·우회 표기 주소를 받지 않는다(사내 주소·이름은 받는다)', async () => {
  const saved = process.env.SSRF_ALLOW_LOOPBACK;
  delete process.env.SSRF_ALLOW_LOOPBACK;
  try {
    const { cleanEdgeTarget } = await import('../src/isidu/settings.js');
    const ok = (h) => !!cleanEdgeTarget({ id: 'a', host: h, username: 'admin', path: '/ifs/a' });
    for (const h of ['169.254.169.254', '127.0.0.1', '0x7f000001', '2130706433']) assert.equal(ok(h), false, h);
    for (const h of ['10.1.2.3', '192.168.10.5', 'isilon01.corp']) assert.equal(ok(h), true, h);
  } finally { if (saved != null) process.env.SSRF_ALLOW_LOOPBACK = saved; }
});

test('A-02 미래 시각 결과 뒤에도 시계가 돌아온 정상 결과로 다음 "지금 수집" 이 완료된다(실제 centralRouter)', async () => {
  const src = fs.readFileSync(new URL('../src/routes/central.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf("centralRouter.post('/isidu-data'"), src.indexOf('// GET /api/central/users-config'));
  // 기준선·완료 판정은 잘라 둔 시각이다 — 원본 엣지 시각(edgeTs)을 넣으면 기준선이 미래에 굳는다.
  assert.match(block, /noteIsiduScanTs\(sc\.targetId, sc\.ts\)/);
  assert.match(block, /ackIsiduCollect\(sc\.targetId, sc\.ts\)/);
  assert.doesNotMatch(block, /sc\.edgeTs \?\? sc\.ts/);
  // 큐 동작: 미래값 대신 잘라 둔 값으로 적어 두면, 그 뒤 정상 시각 결과가 다음 요청을 완료한다.
  const Q = await import('../src/isidu/collectRequests.js');
  const E = await import('../src/central/isiduEdge.js');
  const now = Date.now();
  const { scans } = E.sanitizeIsiduScans({ scans: [{ targetId: 't1', ts: now + 3 * 3600_000, ok: true, entries: [] }] }, new Set(['t1']), now);
  assert.ok(scans[0].edgeTs > now && scans[0].ts === now, '미래 시각은 잘린다');
  E.noteIsiduScanTs('t1', scans[0].ts); Q.ackIsiduCollect('t1', scans[0].ts);
  Q.requestIsiduCollect('t1', 'edge-a');
  const taken = Q.takeIsiduRequests('edge-a');
  assert.ok(Array.isArray(taken) && taken.length === 1, JSON.stringify(taken));
  assert.equal(Q.ackIsiduCollect('t1', now + 60_000), true, '시계가 돌아온 뒤의 결과가 요청을 완료한다');
});

test('A-03 상태 출력을 연속으로 못 읽으면 시한 전에 끊고 장비 작업을 멈춘다', async () => {
  const D = await import('../src/isidu/detach.js');
  const cmds = [];
  let t = 0;
  const api = {
    async exec(cmd) {
      cmds.push(cmd);
      if (/DVC-STARTED|nohup/.test(cmd) && !/kill/.test(cmd) && cmds.length === 1) return { stdout: 'DVC-STARTED 1234\n', stderr: '', code: 0 };
      return { stdout: 'csh: syntax error\n', stderr: '', code: 1 };
    },
  };
  await assert.rejects(
    D.runDetached(api, { id: 'tg', path: '/ifs/a', sizeMode: 'h' }, { cmdMs: 3 * 3600_000, pollMinMs: 1, started: 0, now: () => (t += 40 * 60_000) }),
    (e) => /연속 읽지 못했습니다/.test(e.message) && /csh: syntax error/.test(e.message),
  );
  assert.ok(cmds.some((c) => /kill/.test(c)), '장비의 du 작업을 멈춘다');
  assert.ok(cmds.length <= 2 + D.UNKNOWN_MAX + 1, `상태 확인은 ${D.UNKNOWN_MAX}번에서 끝난다(실제 ${cmds.length})`);
});

test('A-04 강제 적용 문구 — 재개 꺼짐·재개 상한을 말한다', async () => {
  const J = await import('../src/util/scanJournal.js');
  assert.match(J.resumeOutlookText([{ resumes: 0 }]), /자동 재개가 잇습니다$/);
  assert.match(J.resumeOutlookText([{ resumes: J.RESUME_LIMIT }]), /재개 상한/);
  const saved = process.env.SCAN_RESUME;
  process.env.SCAN_RESUME = '0';
  try { assert.match(J.resumeOutlookText([{ resumes: 0 }]), /꺼져 있어/); } finally { if (saved == null) delete process.env.SCAN_RESUME; else process.env.SCAN_RESUME = saved; }
  const m = fs.readFileSync(new URL('../src/upgrade/manager.js', import.meta.url), 'utf8');
  assert.equal((m.match(/resumeOutlookText\(/g) || []).length, 2, '강제 적용 기록·콘솔 두 곳 다');
});

/* ═══════════════ 성능(E-03·E-05·E-07·E-08·E-09·E-10) — 결과는 예전과 같아야 한다 ═══════════════ */

const GIB = 1024 ** 3;
async function seedTarget(targetId, ts, names) {
  const db = await import('../src/isidu/db.js');
  const entries = names.map(([name, bytes]) => ({ name, bytes, res: GIB }));
  const sum = entries.reduce((a, e) => a + e.bytes, 0);
  return db.insertScan({ agent: '', targetId, ts, ok: true, path: '/ifs/data', host: 'h', sizeMode: 'h', total: { bytes: sum, res: GIB }, sumBytes: sum, sumRes: 0, count: entries.length, entries });
}
// 옛 구현(localeCompare 정렬 · 매번 정렬) — 새 구현과 순서·내용이 같아야 한다.
const oldSort = (list) => [...list].sort((a, b) => (b.bytes - a.bytes) || String(a.name).localeCompare(String(b.name)));

test('E-03·E-09 보고서·사용자 표 — 재사용 Collator·정렬 기억 뒤에도 순서와 내용이 옛 계산과 같다', async () => {
  const R = await import('../src/isidu/report.js');
  R._resetForTest();
  const DAY = 86_400_000;
  const now = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000;
  // 같은 크기가 흔한 -h 표기 · 대소문자·한글·숫자 섞인 이름(동률 순서는 이름 비교가 정한다)
  const pool = ['alice', 'Bob', 'bob', 'carol9', 'carol10', '김철수', '이영희', 'Zed', 'zed', 'a.b', 'a-b', 'a_b', 'x1', 'X2', 'm'];
  const names = (seed) => pool.map((n, i) => [n, GIB * (1 + ((i * 7 + seed) % 5))]);
  await seedTarget('perf-1', now - 8 * DAY, names(1).slice(2));
  await seedTarget('perf-1', now, names(3));
  const all = await R.allRows('perf-1');
  assert.equal(all.state, 'ok');
  assert.deepEqual(all.rows.map((r) => r.name), oldSort(all.rows).map((r) => r.name), '보고서 순서 = 크기 → 이름(localeCompare)');
  for (const [sort, dir] of [['name', 'asc'], ['name', 'desc'], ['d7', 'desc'], ['d7', 'asc'], ['size', 'asc']]) {
    const a = await R.listUsers('perf-1', { sort, dir, spark: false, limit: 500 });
    const b = await R.listUsers('perf-1', { sort, dir, spark: false, limit: 500 }); // 두 번째는 기억한 정렬
    assert.deepEqual(a.rows.map((r) => r.name), b.rows.map((r) => r.name), `${sort}/${dir} 기억 전후 같음`);
    const val = (r) => (sort === 'name' ? r.name : sort === 'd7' ? r.d7?.bytes : r.bytes);
    const ref = [...all.rows].sort((x, y) => {
      const vx = val(x); const vy = val(y);
      if (vx == null && vy == null) return x.name.localeCompare(y.name);
      if (vx == null) return 1; if (vy == null) return -1;
      const d = sort === 'name' ? String(vx).localeCompare(String(vy)) : vx - vy;
      return (dir === 'asc' ? d : -d) || x.name.localeCompare(y.name);
    });
    assert.deepEqual(a.rows.map((r) => r.name), ref.map((r) => r.name), `${sort}/${dir} 옛 정렬과 같음`);
    // 검색어는 정렬 뒤에 걸러도 같은 결과(필터는 순서를 바꾸지 않는다)
    const q = await R.listUsers('perf-1', { sort, dir, spark: false, q: 'a', limit: 500 });
    assert.deepEqual(q.rows.map((r) => r.name), ref.filter((r) => r.name.toLowerCase().includes('a')).map((r) => r.name), `${sort}/${dir} 검색`);
  }
});

test('E-08 보고서·개요 기억은 시간이 지나면 버린다', async () => {
  const R = await import('../src/isidu/report.js');
  R._resetForTest();
  await R.allRows('perf-1');
  assert.equal(R._cacheSizes().report, 1);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + R.CACHE_TTL_MS + 60_000;
    await R.buildOverview(['perf-1']); // 아무 조회가 오래된 것을 쓸어 낸다
    await R.listUsers('none-target', { spark: false });
    assert.equal(R._cacheSizes().report, 0, '시간이 지난 보고서 기억은 남지 않는다');
  } finally { Date.now = realNow; }
});

test('E-07 최근 스캔·엣지 커서 조회는 임시 정렬 없이 인덱스·rowid 순서로 읽고 값은 같다', async () => {
  const db = await import('../src/isidu/db.js');
  const src = fs.readFileSync(new URL('../src/isidu/db.js', import.meta.url), 'utf8');
  assert.match(src, /WHERE \+agent=\? AND complete=1 ORDER BY ts DESC LIMIT \?/);
  assert.match(src, /WHERE \+agent='' AND complete=1 AND id>\? ORDER BY id LIMIT \?/);
  assert.match(src, /ORDER BY id DESC LIMIT 1/);
  assert.doesNotMatch(src, /SELECT MAX\(id\) AS m FROM isidu_scan WHERE/);
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path.join(DIR, 'isidu.db'), { readOnly: true });
  try {
    const plan = (sql, ...a) => raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...a).map((r) => r.detail).join(' | ');
    assert.doesNotMatch(plan('SELECT * FROM isidu_scan WHERE +agent=? AND complete=1 ORDER BY ts DESC LIMIT ?', '', 30), /TEMP B-TREE/);
    assert.doesNotMatch(plan("SELECT * FROM isidu_scan WHERE +agent='' AND complete=1 AND id>? ORDER BY id LIMIT ?", 0, 20), /TEMP B-TREE/);
    const max = raw.prepare("SELECT MAX(id) AS m FROM isidu_scan WHERE agent=''").get().m;
    assert.equal(await db.maxLocalScanId(), max);
    const recentOld = raw.prepare('SELECT id FROM isidu_scan WHERE agent=? AND complete=1 ORDER BY ts DESC LIMIT ?').all('', 30).map((r) => r.id);
    assert.deepEqual((await db.recentScans('', 30)).map((r) => r.id), recentOld);
  } finally { raw.close(); }
});

test('E-03 결과 메일의 직전 비교 — 상위 N + 지금 상위 이름만 읽어도 판정이 전체를 읽은 것과 같다', async () => {
  const { changeSummary } = await import('../src/isidu/mailRules.js');
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let k = 0; k < 300; k++) {
    const n = 1 + Math.floor(rnd() * 12);
    const mk = () => Array.from({ length: 5 + Math.floor(rnd() * 40) }, (_, i) => [`u${Math.floor(rnd() * 60)}${i % 3 ? 'a' : 'B'}`, GIB * Math.floor(1 + rnd() * 6)]);
    const prevFull = new Map(mk().map(([name, bytes]) => [name, { bytes, res: GIB }]));
    const curRows = oldSort(mk().map(([name, bytes]) => ({ name, bytes, res: GIB })));
    const prevTop = oldSort([...prevFull].map(([name, v]) => ({ name, ...v }))).slice(0, n);
    const sub = new Map(prevTop.map((r) => [r.name, { bytes: r.bytes, res: r.res }]));
    for (const r of curRows.slice(0, n)) if (prevFull.has(r.name) && !sub.has(r.name)) sub.set(r.name, prevFull.get(r.name));
    const total = { bytes: 10 * GIB, res: GIB };
    assert.deepEqual(changeSummary({ rows: curRows, total }, { entries: sub, total }, n), changeSummary({ rows: curRows, total }, { entries: prevFull, total }, n));
  }
});

test('E-10 normPath — 옛 글자 단위 구현과 같은 결과', async () => {
  const { normPath } = await import('../src/isidu/parse.js');
  const old = (p) => { const s = String(p ?? ''); let out = ''; let prev = false; for (const c of s) { if (c === '/') { if (prev) continue; prev = true; } else prev = false; out += c; } while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1); return out; };
  const al = ['/', '/', 'a', '가', '.', ' ', 'b'];
  let seed = 3;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let k = 0; k < 5000; k++) { let s = ''; const n = Math.floor(rnd() * 12); for (let i = 0; i < n; i++) s += al[Math.floor(rnd() * al.length)]; assert.equal(normPath(s), old(s), JSON.stringify(s)); }
  for (const v of [null, undefined, '', '/', '//']) assert.equal(normPath(v), old(v));
});
