/**
 * test/sanPerfPush2566.test.js — 엣지 → 중앙 포트 사용량 중계가 **실제로 동작하는지** 고정한다(v2.566).
 *
 * ── 왜 이 테스트가 필요했나 ───────────────────────────────────────────────────
 * v2.427(2026-09-08)이 커서 정합을 넣으며 `pushPerfNow()` 안에 이렇게 썼다:
 *
 *     import { samplesAfter, metaFor, maxRowid } from './perfDb.js';
 *     ...
 *     const max = await maxRowid();                                  // ← TDZ 로 던진다
 *     const { rows, maxRowid, unavailable } = await samplesAfter(…);  // ← 같은 블록 재선언
 *
 * `const maxRowid` 가 블록 전체를 TDZ 로 만들어 이 함수는 **매 호출 첫 줄에서**
 * `ReferenceError: Cannot access 'maxRowid' before initialization` 으로 죽었다.
 * 호출부가 전부 `pushPerfNow().catch(() => {})` 이고 내부 catch 는 `_last.error` 에만 적어
 * **콘솔에도 화면에도 남지 않았다** — 사용자가 "엣지 장비는 차트가 안 보인다" 고 신고할 때까지
 * **10일 동안** 엣지 사용량이 한 건도 중앙에 오지 않았다.
 *
 * 기존 `sanSwitchPerfRelay2423.test.js` 는 순수 헬퍼(`chunkRows`·`reconcileCursor`)와 DB 만
 * 봤고 **`pushPerfNow` 를 한 번도 호출하지 않았다** — 그래서 통과하면서 놓쳤다.
 * 여기서는 **실제 HTTP 로 목 중앙에 올려** 본문이 도착하는 것까지 확인한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sansw-push-'));
process.env.SANSW_PUSH_GZIP = 'true';   // 실제 운영 기본값 그대로 — gzip 경로까지 본다

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

/** 본문을 모으는 목 중앙. gzip 도 푼다(엣지가 기본으로 압축해 보낸다). */
function mockCentral() {
  const got = [];
  const srv = http.createServer((req, res) => {
    const bufs = [];
    req.on('data', (c) => bufs.push(c));
    req.on('end', () => {
      let raw = Buffer.concat(bufs);
      if (req.headers['content-encoding'] === 'gzip') { try { raw = zlib.gunzipSync(raw); } catch { /* 그대로 */ } }
      try { got.push({ url: req.url, body: JSON.parse(raw.toString('utf8')) }); } catch { got.push({ url: req.url, body: null }); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, inserted: 0, skipped: 0 }));
    });
  });
  return { srv, got };
}

async function listen(srv) {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return srv.address().port;
}

test('⚠ pushPerfNow 는 TDZ 로 던지지 않는다 — 표본이 실제로 중앙에 도착한다', async () => {
  const { savePerfSample, available, _resetForTest } = await import('../src/sanswitch/perfDb.js');
  if (!(await available())) return;   // 이 런타임이 node:sqlite 를 못 쓰면 건너뛴다
  _resetForTest();

  const now = Date.now();
  await savePerfSample('sw-edge', now - 60_000, { 0: 1000, 1: 2000 }, [{ port: 0, attachedName: 'ARR::1', speed: '16G' }], 3650);
  await savePerfSample('sw-edge', now, { 0: 1100, 1: 2100 }, [], 3650);

  const { srv, got } = mockCentral();
  const port = await listen(srv);
  try {
    const { config } = await import('../src/config.js');
    config.agent.centralUrl = `http://127.0.0.1:${port}`;
    config.agent.centralToken = 'tok';
    config.agent.name = 'agent-TEST';

    const { pushPerfNow } = await import('../src/sanswitch/perfPush.js');
    const r = await pushPerfNow();

    // ⚠ 이 단언이 v2.427~v2.565 에서 깨진다(reason: "Cannot access 'maxRowid' before initialization").
    assert.equal(r.ok, true, `push 가 실패했다: ${r.reason}`);
    assert.equal(r.sent, 4, '표본 4행(포트 2개 × 2주기)이 전송돼야 한다');

    const rowReqs = got.filter((g) => (g.body?.rows || []).length);
    assert.ok(rowReqs.length >= 1, '중앙이 표본 본문을 한 번도 받지 못했다');
    const allRows = rowReqs.flatMap((g) => g.body.rows);
    assert.equal(allRows.length, 4);
    assert.ok(allRows.every((row) => row[0] === 'sw-edge'), 'deviceId 가 실려야 한다');
    // 상태는 **청크 0 에만** 실린다(v2.517 규약).
    assert.equal(got.filter((g) => g.body?.status).length, 1, 'status 는 청크 0 에만 한 번');
    assert.equal(got[0].body.agent, 'agent-TEST');
  } finally { srv.close(); _resetForTest(); }
});

test('표본이 0건이어도 상태 하트비트는 올라간다 (v2.517 규약)', async () => {
  const { available, _resetForTest } = await import('../src/sanswitch/perfDb.js');
  if (!(await available())) return;
  const { srv, got } = mockCentral();
  const port = await listen(srv);
  try {
    const { config } = await import('../src/config.js');
    config.agent.centralUrl = `http://127.0.0.1:${port}`;
    config.agent.centralToken = 'tok';
    config.agent.name = 'agent-TEST';
    const { pushPerfNow } = await import('../src/sanswitch/perfPush.js');
    // 앞 테스트에서 커서가 끝까지 갔으므로 새 표본이 없다.
    const r = await pushPerfNow();
    assert.equal(r.ok, true);
    assert.equal(r.sent, 0, '보낼 표본은 없다');
    assert.equal(r.statusSent, true, '그래도 상태는 올라가야 한다 — 0건이 곧 신고된 증상이었다');
    assert.equal(got.length, 1);
    assert.ok(got[0].body.status, '하트비트 본문에 status 가 있어야 한다');
    assert.equal(got[0].body.rows.length, 0);
  } finally { srv.close(); _resetForTest(); }
});

test('⚠ push 실패를 조용히 삼키지 않는다 — 콘솔에 남긴다', async () => {
  const { available } = await import('../src/sanswitch/perfDb.js');
  if (!(await available())) return;
  const { config } = await import('../src/config.js');
  config.agent.centralUrl = 'http://127.0.0.1:1';   // 아무도 듣지 않는 포트
  config.agent.centralToken = 'tok';
  config.agent.name = 'agent-TEST';

  const { savePerfSample, _resetForTest } = await import('../src/sanswitch/perfDb.js');
  await savePerfSample('sw-edge', Date.now() + 1, { 0: 1 }, [], 3650);   // 보낼 것을 만든다

  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const { pushPerfNow } = await import('../src/sanswitch/perfPush.js');
    const r = await pushPerfNow();
    assert.equal(r.ok, false);
    assert.ok(warns.some((w) => /sanswitch-perf-push/.test(w)),
      '호출부가 전부 .catch(()=>{}) 이므로 이 catch 가 유일한 기록 지점이다 — 콘솔에 남아야 한다');
  } finally { console.warn = orig; _resetForTest(); }
});

test('⚠ import 된 이름을 같은 파일에서 const 구조분해로 재선언하지 않는다 (TDZ 전수 스윕)', () => {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
      else if (e.name.endsWith('.js')) files.push(p);
    }
  })(SRC);

  const hits = [];
  for (const f of files) {
    // 주석을 먼저 제거한다 — 규칙을 설명하는 주석이 오탐을 만들면 안 된다(v2.535 규약).
    const code = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const imported = new Set();
    for (const m of code.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
      for (const part of m[1].split(',')) {
        const n = part.trim().split(/\s+as\s+/).pop().trim();
        if (n) imported.add(n);
      }
    }
    if (!imported.size) continue;
    for (const m of code.matchAll(/\b(const|let)\s*\{([^}]+)\}\s*=/g)) {
      for (const part of m[2].split(',')) {
        const raw = part.trim();
        if (!raw) continue;
        const n = (raw.includes(':') ? raw.split(':')[1] : raw).split('=')[0].trim();
        if (imported.has(n)) hits.push(`${path.relative(SRC, f)}: '${n}'`);
      }
    }
  }
  assert.deepEqual(hits, [],
    `import 된 이름이 같은 파일의 const/let 구조분해로 가려진다 — 그 블록에서 원본을 부르면 TDZ 로 던진다:\n${hits.join('\n')}`);
  assert.ok(files.length > 500, `스윕이 파일을 못 찾았다(${files.length}개) — 경로가 바뀌었는지 확인할 것`);
});
