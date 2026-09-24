/**
 * v2.603 감사 그룹 d — 수집기·파서 ReDoS 회귀(COL-2603-01·02·04·05·06·07, SEC2603-01~06).
 *
 * 정규식 교체는 두 가지를 함께 고정한다: ① 긴 입력(수만~수십만 자)에서 150ms 안 ② 정상 출력에서 **예전 정규식과
 * 결과가 같다**(픽스처 + 결정적 난수 입력으로 옛 구현과 대조 — 옛 구현은 이 파일에 사본으로 둔다).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizePowerstoreSsh, alertOutputUnread, ALERT_FALLBACK_CMD } from '../src/storage/collectors/powerstoreSsh.js';
import { normalizeIsilon } from '../src/storage/collectors/isilon.js';
import { normalizePowerstore } from '../src/storage/collectors/powerstore.js';
import { shortVersion } from '../src/storage/collectors/unityVersion.js';
import { firewallSummary } from '../src/nsx/client.js';
import { physicalOsOf } from '../src/gpu/sshCollect.js';
import { readGuestFileBody } from '../src/gpu/guestops.js';
import { parseSensorShow, sensorNameOf } from '../src/sanswitch/collectors/fosParse.js';
import { stripUemcliBanner, stripChoiceLines } from '../src/proxy/sshExec.js';
import { readBodyPrefix, KEYWORD_SCAN_BYTES } from '../src/svcmon/checker.js';
import { parseFcHosts } from '../src/bmusage/parse/linuxProc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, 'fixtures');
const LIMIT_MS = 150;

function timed(fn) {
  const t = performance.now();
  const r = fn();
  return { r, ms: performance.now() - t };
}

// 결정적 난수(LCG) — Date.now()·Math.random 을 쓰지 않는다.
function rng(seed) {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}
function randText(r, alphabet, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(r() * alphabet.length)];
  return s;
}

// ── COL-2603-01 PowerStore SSH 알람 ─────────────────────────────────────────
const DEV = { id: 'ps1', type: 'powerstore', name: 'PS' };
const CLUSTER = JSON.stringify([{ name: 'c1', state: 'Configured' }]);

test('COL-2603-01: 사람용 표 알람 출력(레코드 0건)은 미해결 0건이 아니라 미수집(null)', () => {
  const alert = ' #  |  id  | severity | state \n----+------+----------+-------\n 1 | a1 | Major | ACTIVE';
  const s = normalizePowerstoreSsh(DEV, { cluster: CLUSTER, alert }, { alertCmd: ALERT_FALLBACK_CMD });
  assert.equal(s.alerts.unresolved, null);
  assert.match(s.sections.alerts, /^미수집: 알람 출력 형식을 읽지 못했습니다/);
});

test('COL-2603-01: 정상 0건(빈 JSON·없음 문구·빈 출력·머리글만)은 그대로 0건 ok', () => {
  for (const alert of ['[]', '', 'No alerts found.', 'id,severity,state']) {
    const s = normalizePowerstoreSsh(DEV, { cluster: CLUSTER, alert }, {});
    assert.equal(s.alerts.unresolved, 0, JSON.stringify(alert));
    assert.equal(s.sections.alerts, 'ok');
  }
  const s = normalizePowerstoreSsh(DEV, { cluster: CLUSTER, alert: JSON.stringify([{ id: 'a', severity: 'Major', state: 'ACTIVE' }]) }, {});
  assert.equal(s.alerts.unresolved, 1);
  assert.equal(alertOutputUnread('[]'), false);
  assert.equal(alertOutputUnread('a | b\n1 | 2'), true);
});

// ── COL-2603-02 Isilon devid ↔ lnn ─────────────────────────────────────────
test('COL-2603-02: 노드 통계는 id(devid)로 조인한다 — lnn 과 달라도 제 노드의 값', () => {
  const stats = [];
  for (const [devid, total, used] of [[1, 100, 10], [2, 200, 190], [3, 300, 30]]) {
    stats.push({ devid, key: 'node.ifs.bytes.total', value: total }, { devid, key: 'node.ifs.bytes.used', value: used });
  }
  const s = normalizeIsilon({ id: 'i', type: 'isilon', name: 'I' }, {
    nodes: { nodes: [{ id: 3, lnn: 1, status: 'ok' }, { id: 1, lnn: 2, status: 'ok' }, { id: 2, lnn: 3, status: 'ok' }] },
    nodeStats: { stats },
  });
  const byLnn = Object.fromEntries(s.nodes.list.map((n) => [n.id, n.hdd]));
  assert.deepEqual([byLnn[1].totalBytes, byLnn[1].usedBytes], [300, 30]);
  assert.deepEqual([byLnn[2].totalBytes, byLnn[2].usedBytes], [100, 10]);
  assert.deepEqual([byLnn[3].totalBytes, byLnn[3].usedBytes], [200, 190]);
  // id 가 없는 응답은 예전처럼 lnn 으로 찾는다
  const s2 = normalizeIsilon({ id: 'i', type: 'isilon', name: 'I' }, {
    nodes: { nodes: [{ lnn: 2, status: 'ok' }] }, nodeStats: { stats },
  });
  assert.equal(s2.nodes.list[0].hdd.totalBytes, 200);
});

// ── COL-2603-04 NSX 규칙 조회 실패 ─────────────────────────────────────────
test('COL-2603-04: 규칙 조회 실패 + rule_count 없음 → rulesPartial · rulesFailed', () => {
  const r = firewallSummary({ pols: { results: [{ id: 'p1' }], result_count: 1 },
    dfw: [{ ruleCount: null, rules: [], rulesFailed: true, ruleCountKnown: false }], ruleSets: [null] });
  assert.equal(r.rulesPartial, true);
  assert.equal(r.rulesFailed, 1);
  // rule_count 가 있으면 수는 맞다(부분 아님) — 그래도 실패 사실은 밝힌다
  const r2 = firewallSummary({ pols: { results: [{ id: 'p1', rule_count: 4 }], result_count: 1 },
    dfw: [{ ruleCount: 4, rules: [], rulesFailed: true, ruleCountKnown: true }], ruleSets: [null] });
  assert.equal(r2.rules, 4);
  assert.equal(r2.rulesPartial, undefined);
  assert.equal(r2.rulesFailed, 1);
  // 성공한 정책은 예전 그대로
  const r3 = firewallSummary({ pols: { results: [{ id: 'p1' }], result_count: 1 }, dfw: [{ ruleCount: 2, rules: [{}, {}] }], ruleSets: [[{}, {}]] });
  assert.deepEqual(r3, { policies: 1, rules: 2 });
});

// ── COL-2603-05 NSX IDS·라이선스 실패 / 이벤트 상한 — collectFromNsx 소스 확인 ─────
test('COL-2603-05: IDS 프로파일·이벤트·라이선스 조회는 failedList 로 받고 listsFailed 에 싣는다', () => {
  const src = fs.readFileSync(path.join(here, '../src/nsx/client.js'), 'utf8');
  assert.doesNotMatch(src, /(idsProfiles|idsEvents|licenses)\(\)\.catch\(\(\) => \(\{ results: \[\] \}\)\)/);
  for (const k of ['idsProfiles', 'idsEvents', 'licenses']) {
    assert.match(src, new RegExp(`client\\.${k}\\(\\)\\.catch\\(failedList\\)`));
    assert.match(src, new RegExp(`\\['${k}', `));
  }
  assert.match(src, /idsEventsTruncated/);
});

// ── COL-2603-06 물리 GPU OS 보정 ────────────────────────────────────────────
test('COL-2603-06: uname·ver 둘 다 비었는데 nvidia-smi.exe 로 찾았으면 Windows', () => {
  assert.equal(physicalOsOf('"C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe" -q', ''), 'Windows');
  assert.equal(physicalOsOf('nvidia-smi', ''), '');
  assert.equal(physicalOsOf('nvidia-smi.exe', 'Linux\n'), 'Linux');
  assert.equal(physicalOsOf('nvidia-smi', '\r\nMicrosoft Windows [Version 10.0]\r\n'), 'Microsoft Windows [Version 10.0]');
});

// ── COL-2603-07 PowerStore 볼륨 size 결측 ─────────────────────────────────
test('COL-2603-07: 볼륨 size 결측은 0 으로 더하지 않는다 — 합계 null + sizeUnknown', () => {
  const s = normalizePowerstore(DEV, { volumes: [{ id: 'v1', size: 1000, state: 'Ready' }, { id: 'v2', state: 'Ready' }] });
  assert.equal(s.extra.inventory.volumes.provisionedBytes, null);
  assert.equal(s.extra.inventory.volumes.sizeUnknown, 1);
  const ok = normalizePowerstore(DEV, { volumes: [{ id: 'v1', size: 1000, state: 'Ready' }, { id: 'v2', size: 24, state: 'Ready' }] });
  assert.equal(ok.extra.inventory.volumes.provisionedBytes, 1024);
  assert.equal(ok.extra.inventory.volumes.sizeUnknown, undefined);
});

// ── SEC2603-01 sensorshow 이름 ─────────────────────────────────────────────
const oldSensorName = (rest) => rest.replace(/\s*[,;]?\s*\bis\b.*$/i, '').trim();

test('SEC2603-01: sensorshow — "비공백 + 긴 공백 + 비공백" 한 줄이 150ms 안', () => {
  for (const n of [3000, 30000]) {
    const { ms } = timed(() => parseSensorShow(`sensor 1: (Temperature) Temp${' '.repeat(n)}x`));
    assert.ok(ms < LIMIT_MS, `${n}자 ${ms.toFixed(1)}ms`);
  }
  const { ms } = timed(() => parseSensorShow(`sensor 1: (Temperature) ${'a '.repeat(100000)}`));
  assert.ok(ms < LIMIT_MS, `반복 ${ms.toFixed(1)}ms`);
});

test('SEC2603-01: 이름 추출 결과가 예전 정규식과 같다(정상 표본 + 결정적 난수)', () => {
  const samples = [
    'Temp 1 is Ok, value is 31 C', 'Fan 1 is Ok,speed is 7050 RPM', 'Power Supply 2 is Absent',
    'Temp is Ok', 'Name, is Ok', 'Name ; is Faulty', 'Thisis not is Ok', 'ISLAND IS Ok', 'NoStateHere',
    '  lead  is Ok', 'a,, is b', 'x;is', '', 'is', 'Temp 3\tis\tOk',
  ];
  for (const s of samples) assert.equal(sensorNameOf(s), oldSensorName(s), JSON.stringify(s));
  const r = rng(2603);
  for (let i = 0; i < 3000; i++) {
    const s = randText(r, ['i', 's', 'I', 'S', ' ', ',', ';', 'a', 'x', '\t', '_', '1'], 1 + Math.floor(r() * 24));
    assert.equal(sensorNameOf(s), oldSensorName(s), JSON.stringify(s));
  }
  const p = parseSensorShow('sensor  1: (Temperature) Temp 1 is Ok, value is 31 C\nsensor 2: (Fan) Fan 1 is Absent');
  assert.deepEqual(p.list.map((x) => [x.name, x.state, x.value]), [['Temp 1', 'Ok', 31], ['Fan 1', 'Absent', null]]);
});

// ── SEC2603-02 stripUemcliBanner ───────────────────────────────────────────
// 옛 구현(감사 기준 c766e01)의 마지막 규칙 사본 — stripUemcliBanner 의 앞 단계는 그대로이고 이 규칙만
// stripChoiceLines 로 바뀌었으므로 두 함수의 동치성을 본다.
const oldChoiceRule = (t) => t.replace(/^\s*\[[123]\][^\n]*\n?/gm, '');

test('SEC2603-02: 빈 줄 10만 개 + 공백 줄 입력이 150ms 안', () => {
  for (const s of ['1: ID = x\n' + '\n'.repeat(100000), '1: ID = x\n' + ' \n'.repeat(100000) + 'y', '\r\n'.repeat(100000) + '[4]']) {
    const { ms } = timed(() => stripUemcliBanner(s));
    assert.ok(ms < LIMIT_MS, `${ms.toFixed(1)}ms`);
  }
});

test('SEC2603-02: 선택지 줄 규칙이 예전과 같은 결과(픽스처 + 결정적 난수)', () => {
  for (const f of fs.readdirSync(FIX).filter((x) => /^uemcli-/.test(x))) {
    const t = fs.readFileSync(path.join(FIX, f), 'utf8');
    assert.equal(stripChoiceLines(t), oldChoiceRule(t), f);
    const withChoices = `Would you like to:\n\n  [1] Accept once\n\n[2] Accept and store\n [3] Reject\n${t}\n\n[3] tail`;
    assert.equal(stripChoiceLines(withChoices), oldChoiceRule(withChoices), `${f}+선택지`);
  }
  const r = rng(26032);
  for (let i = 0; i < 5000; i++) {
    const s = randText(r, ['\n', '\n', ' ', '\t', '\r', 'a', '[1]', '[2]', '[3]', '[4]', ' [1] x', 'B'], Math.floor(r() * 18));
    assert.equal(stripChoiceLines(s), oldChoiceRule(s), JSON.stringify(s));
  }
  const prompt = fs.readFileSync(path.join(FIX, 'uemcli-prompt-inline-2544.txt'), 'utf8');
  assert.match(stripUemcliBanner(prompt), /^1:\s+ID\s+= pool_2/m);
});

// ── SEC2603-03 svcmon 키워드 본문 상한 ─────────────────────────────────────
test('SEC2603-03: readBodyPrefix 는 앞 256KB 까지만 읽고 끊는다(스트림)', async () => {
  let sent = 0, closed = false;
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    const chunk = Buffer.alloc(1024 * 1024, 'a');
    const pump = () => {
      while (sent < 200 * 1024 * 1024) {
        sent += chunk.length;
        if (!res.write(chunk)) { res.once('drain', pump); return; }
      }
      res.end();
    };
    res.on('close', () => { closed = true; });
    pump();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/`);
    const { text, capped } = await readBodyPrefix(res, KEYWORD_SCAN_BYTES);
    assert.equal(Buffer.byteLength(text), KEYWORD_SCAN_BYTES);
    assert.equal(capped, true);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(sent < 64 * 1024 * 1024, `서버가 보낸 양 ${sent}B — 끝까지 읽지 않아야 한다`);
    assert.equal(closed, true);
  } finally { srv.close(); }
  // 상한보다 작은 본문은 그대로 · capped false
  const small = await readBodyPrefix(new Response('hello keyword'), KEYWORD_SCAN_BYTES);
  assert.deepEqual(small, { text: 'hello keyword', capped: false });
  const exact = await readBodyPrefix(new Response('abcd'), 4);
  assert.deepEqual(exact, { text: 'abcd', capped: false });
  const over = await readBodyPrefix(new Response('abcdef'), 4);
  assert.deepEqual(over, { text: 'abcd', capped: true });
});

test('SEC2603-03: 키워드 검사가 res.text() 전체 읽기를 쓰지 않는다', () => {
  const src = fs.readFileSync(path.join(here, '../src/svcmon/checker.js'), 'utf8');
  assert.doesNotMatch(src, /await res\.text\(\)\)\.slice\(0, 262144\)/);
  assert.match(src, /readBodyPrefix\(res, KEYWORD_SCAN_BYTES\)/);
});

// ── SEC2603-04 FC 속도 파서 ────────────────────────────────────────────────
const oldGbit = (s) => { const m = /([\d.]+)\s*gbit/i.exec(s); return m ? m[1] : null; };
const newGbit = (s) => { const r = parseFcHosts([`h|Online|${s}|0x1|0x2`]); return r ? r[0].bitsPerSec : null; };

test('SEC2603-04: "0." 2만 번이 150ms 안 + 결과가 예전과 같다', () => {
  const { ms } = timed(() => parseFcHosts([`h|Online|${'0.'.repeat(20000)}|0x1|0x2`]));
  assert.ok(ms < LIMIT_MS, `${ms.toFixed(1)}ms`);
  for (const s of ['16 Gbit', '8Gbit', '32 Gbit/s', 'unknown', 'not negotiated', '1.5 Gbit', 'x16 gbit', '4 Gbit, 8 Gbit']) {
    const o = oldGbit(s);
    assert.equal(newGbit(s), o == null ? null : Number(o) * 1e9, s);
  }
  const r = rng(26034);
  for (let i = 0; i < 3000; i++) {
    const s = randText(r, ['1', '6', '.', ' ', 'g', 'G', 'bit', 'Gbit', 'x', '/'], 1 + Math.floor(r() * 12));
    const o = oldGbit(s);
    const n = newGbit(s.trim() ? s : 'z');
    if (!s.trim()) continue;
    assert.equal(n, o == null ? null : Number(o) * 1e9, JSON.stringify(s));
  }
});

// ── SEC2603-05 Unity shortVersion ──────────────────────────────────────────
const oldShort = (raw) => { const s = String(raw ?? '').trim(); if (!s) return ''; const m = /\d+(?:\.\d+){2,}/.exec(s); return m ? m[0] : s; };

test('SEC2603-05: 숫자 4만 자가 150ms 안 + 결과가 예전과 같다', () => {
  for (const s of ['0'.repeat(40000) + 'x', '1.' + '1'.repeat(40000) + 'x', '1.1' + '.x'.repeat(20000)]) {
    const { ms } = timed(() => shortVersion(s));
    assert.ok(ms < LIMIT_MS, `${ms.toFixed(1)}ms`);
  }
  for (const s of ['c4dev_PIE_8775R-5.4.0.0.5.094-GNOSIS_RETAIL', '5.4.0', '8775R', '4.5.1.0.5.001', 'v12.34', '']) {
    assert.equal(shortVersion(s), oldShort(s), s);
  }
  const r = rng(26035);
  for (let i = 0; i < 3000; i++) {
    const s = randText(r, ['1', '2', '0', '.', '.', 'a', '-', '_'], 1 + Math.floor(r() * 16));
    assert.equal(shortVersion(s), oldShort(s), JSON.stringify(s));
  }
});

// ── SEC2603-06 게스트 결과 파일 상한 ───────────────────────────────────────
test('SEC2603-06: 게스트 결과 파일은 상한까지만 — 크기 힌트가 넘으면 받지 않는다', async () => {
  const hint = await readGuestFileBody(new Response('x'), 9 * 1048576, 8 * 1048576);
  assert.equal(hint.text, '');
  assert.match(hint.error, /상한/);
  const big = await readGuestFileBody(new Response('y'.repeat(70_000)), null, 65_536);
  assert.equal(big.text, '');
  assert.match(big.error, /상한/);
  const ok = await readGuestFileBody(new Response('GPU 0, 45 %'), '11', 65_536);
  assert.deepEqual(ok, { text: 'GPU 0, 45 %', error: null });
});

/* ════ 추가 수정(코디네이터 요청) — 배정 밖으로 보고했던 5건 ════════════════════════════════ */
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { parsePoolCell } from '../src/storage/collectors/isilonSsh.js';
import { fetchUrl, URL_BODY_MAX } from '../src/rma/testRunner.js';

const SRC2 = path.join(here, '../src');
const J2 = (p) => JSON.stringify(path.join(SRC2, p));

function runLive(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2603d-'));
  const boot = `
    const express = (await import('express')).default;
    const { store } = await import(${J2('store.js')});
    const { api } = await import(${J2('routes/api.js')});
    const { nsxStore } = await import(${J2('nsx/store.js')});
    await store.refresh({ force: true });
    const snap = store.get();
    const mk = (user) => { const app = express(); app.use(express.json()); app.use((req, _r, next) => { req.user = user; next(); }); app.use('/api', api); return app; };
    const servers = [];
    const start = async (app) => { const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); }); servers.push(s); return 'http://127.0.0.1:' + s.address().port; };
    const req = async (base, p) => { const r = await fetch(base + p); const text = await r.text(); let b = null; try { b = JSON.parse(text); } catch {} return { status: r.status, body: b, text }; };
    const out = await (async () => { ${script} })();
    for (const s of servers) s.close();
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', boot], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' }, encoding: 'utf8', cwd: path.resolve(SRC2, '..'), timeout: 180_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr?.slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-1500)} ${r.stderr?.slice(-1500)}`);
  return JSON.parse(line.slice(2));
}

test('추가 ①② 실제 라우터 — threats 의 IDS 조회 실패는 null · license-expiry 가 NSX 라이선스 조회 실패를 밝힌다', () => {
  const r = runLive(`
    nsxStore.snapshot = { ...nsxStore.get(), managers: [
      { id: 'm-f', vcenterId: snap.vcenters[0].id, name: 'nsx-failed', idsEnabled: true, idsProfiles: null, idsEventCount: null,
        licenses: [], listsFailed: ['idsProfiles', 'idsEvents', 'licenses'], listFailReasons: { licenses: 'HTTP 503 from nsxsecret.invalid' } },
      { id: 'm-o', vcenterId: snap.vcenters[0].id, name: 'nsx-ok', idsEnabled: true, idsProfiles: 2, idsEventCount: 0, licenses: [{ key: 'K', description: 'NSX', quantity: 1 }] },
    ] };
    const admin = await start(mk({ username: 'root', role: 'admin', scope: null }));
    const oper = await start(mk({ username: 'op', role: 'operator', scope: null }));
    const t = await req(admin, '/api/tools/threats');
    const la = await req(admin, '/api/tools/license-expiry');
    const lo = await req(oper, '/api/tools/license-expiry');
    return { ids: t.body?.ids?.managers, la: la.body?.collectionErrors, lo: lo.body?.collectionErrors, loText: lo.text };
  `);
  const f = r.ids.find((m) => m.name === 'nsx-failed');
  const o = r.ids.find((m) => m.name === 'nsx-ok');
  assert.equal(f.profiles, null);
  assert.equal(f.events, null);
  assert.equal(o.profiles, 2);
  assert.equal(o.events, 0);
  const aErr = r.la.find((e) => e.startsWith('NSX nsx-failed'));
  assert.ok(aErr && /확인 불가/.test(aErr) && /HTTP 503/.test(aErr), JSON.stringify(r.la));
  assert.ok(!r.la.some((e) => e.startsWith('NSX nsx-ok')));
  const oErr = r.lo.find((e) => e.startsWith('NSX nsx-failed'));
  assert.ok(oErr && /확인 불가/.test(oErr));
  assert.ok(!r.loText.includes('nsxsecret'), '비-admin 에게 사유 원문(주소)을 싣지 않는다');
});

const oldPool = (s) => {
  const t = String(s || '').trim();
  if (!t || /no storage/i.test(t)) return null;
  const l3 = /L3:\s*([\d.]+[kKMGTP]?)/.exec(t);
  if (l3) return { l3: l3[1] };
  const m = /([\d.]+[kKMGTP]?)\s*\/\s*([\d.]+[kKMGTP]?)\s*\(\s*([\d.]+)%\s*\)/.exec(t);
  return m ? [m[1], m[2], m[3]] : null;
};

test('추가 ③ Isilon parsePoolCell — 긴 셀이 150ms 안 + 결과가 예전과 같다', () => {
  for (const s of ['0.'.repeat(20000) + 'x', '1'.repeat(40000) + '/', '2.0T/ ' + '1'.repeat(40000) + '( x']) {
    const { ms } = timed(() => parsePoolCell(s));
    assert.ok(ms < LIMIT_MS, `${ms.toFixed(1)}ms`);
  }
  const fixedPairs = ['2.0T/ 107T( 2%)', '55.1T / 107T (51%)', '(No Storage HDDs)', 'L3: 373G', '1.5k/2.0M(75%)', '', 'x 1.2.3T/4G(5%)'];
  const r = rng(26036);
  const cells = [...fixedPairs];
  for (let i = 0; i < 3000; i++) cells.push(randText(r, ['1', '2', '.', 'T', 'G', 'k', '/', ' ', '(', ')', '%', '5'], 1 + Math.floor(r() * 18)));
  for (const c of cells) {
    const o = oldPool(c);
    const n = parsePoolCell(c);
    if (o == null) { assert.equal(n, null, JSON.stringify(c)); continue; }
    if (o.l3) { assert.ok(n && 'l3Bytes' in n, JSON.stringify(c)); continue; }
    // 옛 캡처로 같은 계산을 해 새 결과와 비교
    assert.equal(n?.pct, Number(o[2]), JSON.stringify(c));
    const ref = parsePoolCell(`${o[0]}/${o[1]}(${o[2]}%)`);
    assert.deepEqual(n, ref, JSON.stringify(c));
  }
});

test('추가 ④ RMA url 점검 — 본문은 앞 256KB 까지만 읽고 끊는다', async () => {
  let sent = 0, closed = false;
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    const chunk = Buffer.alloc(1024 * 1024, 'b');
    const pump = () => { while (sent < 200 * 1024 * 1024) { sent += chunk.length; if (!res.write(chunk)) { res.once('drain', pump); return; } } res.end(); };
    res.on('close', () => { closed = true; });
    pump();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const x = await fetchUrl(`http://127.0.0.1:${srv.address().port}/`, { timeoutMs: 10_000, insecure: false });
    assert.equal(x.status, 200);
    assert.equal(Buffer.byteLength(x.body), URL_BODY_MAX);
    assert.equal(x.capped, true);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(sent < 64 * 1024 * 1024, `서버 송신 ${sent}B`);
    assert.equal(closed, true);
  } finally { srv.close(); }
});
