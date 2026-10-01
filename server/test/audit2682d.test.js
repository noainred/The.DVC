/**
 * v2.682 — 3회차 점검 그룹 D(보안·성능·수명주기) 고정.
 *  R3S-03 perf client-stall 의 view/path/userAgent 는 hang 링에 평탄화(capStr)해 둔다 — SlicedString 이 큰 본문을 붙잡지 않게.
 *  R3S-04 POST /admin/llm-test 는 형제 PUT /llm-config 와 같이 fleetOnly · Ollama 응답은 상한까지만 읽는다.
 *  R3S-06 CVP 장비 상세 포트 — 비-admin 은 포트 MAC 제거 · 설명 주소 가림.
 *  R3P-01 아키텍처 점검 import 그래프는 비동기(양보) + 동시 첫 호출 합류, stripComments 는 출력 동일.
 *  R3E-02 로그인 실패 분석이 DB 조회 실패를 '0건' 으로 삼키지 않는다 · 증분 기준을 전진하지 않는다.
 *  R3E-03 중앙의 엣지 배정 보류(held)에 시한.
 *  R3E-04 CVP 장애 판정 디바운스가 진행 중 판정과 겹치면 끝난 뒤 다시 예약한다.
 *  R3E-05 롤업 백필 시작 전 예외는 'error' + 사유.
 *  R3A-05 같은 이름 로컬 계정 때문에 막힌 AD 로그인은 구분되는 사유를 남긴다(응답은 그대로).
 *  R3A-08 X-Agent-Hostname 퍼센트 인코딩을 중앙이 푼다.
 *  R3A-09 통신 점검 보고 POST 는 재전송하지 않는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2682d-'));
process.env.CONFIG_DIR = TMP;
process.env.CVP_FAULT_SCAN_DEBOUNCE_MS = '1000';
const { stripComments } = await import('./_stripComments.js');
const SRC = new URL('../src/', import.meta.url);
const srcOf = (f) => stripComments(fs.readFileSync(new URL(f, SRC), 'utf8'));

test('R3S-03 — client-stall 기록은 큰 본문을 붙잡지 않는다(평탄화) · 길이 상한', async () => {
  const M = await import('../src/perf/monitor.js');
  const big = 'v'.repeat(900_000);
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 30; i++) {
    // 실제 라우트처럼 매번 새 큰 문자열 — 평탄화하지 않으면 120자가 원문 900KB 를 붙잡는다.
    const s = `${big}${i}`;
    M.recordClientStall({ user: 'u', ip: '1.1.1.1', view: s, path: s, userAgent: s, inflight: [{ path: s, ms: 1 }] });
  }
  global.gc?.();
  await new Promise((r) => setTimeout(r, 10));
  global.gc?.();
  const grew = process.memoryUsage().heapUsed - before;
  // 평탄화가 없으면 30 × 900KB × (view·path·ua·inflight) ≈ 27MB 이상이 남는다. gc 노출이 없어도 링이 붙잡는 양은 줄어야 한다.
  if (global.gc) assert.ok(grew < 8_000_000, `잔존 ${grew}`);
  const src = srcOf('perf/monitor.js');
  const fn = src.slice(src.indexOf('export function recordClientStall'), src.indexOf('/* ── 요청 ID'));
  assert.doesNotMatch(fn, /\.slice\(0, (60|120|160|200)\)/, '상주 칸은 slice 가 아니라 capStr');
  assert.match(fn, /view: capStr\(view, 120\)/);
  assert.match(fn, /userAgent: capStr\(userAgent, 160\)/);
  const r = srcOf('routes/api/perfClient.js');
  assert.match(r, /const normView = \(v\) => capStr\(/);
  assert.match(r, /userAgent: capStr\(req\.get\('user-agent'\)/);
});

test('R3S-04 — /admin/llm-test 는 fleetOnly · ollama 는 readJsonCapped', async () => {
  const src = srcOf('routes/admin/deployLlm.js');
  assert.match(src, /adminRouter\.post\('\/llm-test', adminOnly, fleetOnly,/);
  const o = srcOf('llm/ollama.js');
  assert.doesNotMatch(o, /res\.json\(\)/, 'Ollama 응답을 상한 없이 읽지 않는다');
  assert.equal((o.match(/readJsonCapped\(res,/g) || []).length, 2);
  // 실제 라우터 스택 — /llm-test 경로에 fullScope 게이트 표지(v2.614)가 있어야 한다(형제 PUT /llm-config 와 같은 종류).
  const { adminRouter } = await import('../src/routes/admin.js');
  const kinds = (p, m) => {
    const L = adminRouter.stack.find((l) => l.route?.path === p && l.route.methods[m]);
    assert.ok(L, `${m} ${p}`);
    return L.route.stack.map((x) => x.handle?.gate?.kind).filter(Boolean);
  };
  assert.ok(kinds('/llm-test', 'post').includes('fullScope'), 'POST /llm-test 는 fullScope 게이트');
  assert.ok(kinds('/llm-config', 'put').includes('fullScope'));
});

test('R3S-06 — 장비 상세 포트: 비-admin 은 mac 제거 · 설명 주소 가림 · null 유지', async () => {
  const { maskDevicePorts } = await import('../src/routes/api/cvp.js');
  const ports = [{ name: 'Et1', mac: 'aa:bb:cc:dd:ee:ff', desc: 'to core 10.1.2.3 (cvp.example)' }, { name: 'Et2', mac: null, desc: null }];
  const m = maskDevicePorts(ports, false, ['cvp.example']);
  assert.ok(!('mac' in m[0]) && !('mac' in m[1]));
  assert.doesNotMatch(m[0].desc, /10\.1\.2\.3/);
  assert.doesNotMatch(m[0].desc, /cvp\.example/);
  assert.equal(m[1].desc, null);
  assert.deepEqual(maskDevicePorts(ports, true, []), ports, 'admin 은 원문');
  assert.equal(maskDevicePorts(null, false, []), null, '못 읽은 포트(null)를 빈 배열로 바꾸지 않는다');
  assert.match(srcOf('routes/api/cvp.js'), /ports: maskDevicePorts\(det\.ports, admin, hosts\)/);
});

test('R3P-01 — import 그래프 비동기판: 결과 동일 · 동시 첫 호출 합류 · 최장 정지가 동기판보다 훨씬 짧다', async () => {
  const A = await import('../src/portalcheck/archScan.js');
  A._resetImportGraphMemo();
  const tS = performance.now(); const gSync = A.buildImportGraph(); const syncMs = performance.now() - tS;
  A._resetImportGraphMemo();
  let max = 0; let last = performance.now(); let stop = false;
  const tick = () => { const n = performance.now(); max = Math.max(max, n - last); last = n; if (!stop) setImmediate(tick); };
  setImmediate(tick);
  const [g1, g2] = await Promise.all([A.buildImportGraphAsync(), A.buildImportGraphAsync()]);
  stop = true;
  assert.equal(g1, g2, '동시 첫 호출은 같은 결과(진행 중 프라미스 공유)');
  assert.equal(A.buildImportGraph(), g1, '동기판도 같은 메모를 쓴다');
  assert.deepEqual([...g1.entries()].sort(), [...gSync.entries()].sort(), '동기판과 같은 그래프');
  assert.ok(max < Math.max(120, syncMs / 2), `최장 정지 ${max.toFixed(1)}ms (동기 ${syncMs.toFixed(1)}ms)`);
  assert.match(srcOf('portalcheck/archScan.js'), /await safeAsync\(errors, 'import-graph', \(\) => buildImportGraphAsync\(\)\)/);
  // stripComments 출력 동일(전 소스 + 경계 입력)
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } })(new URL('../src/', import.meta.url).pathname);
  for (const f of files) { const s = fs.readFileSync(f, 'utf8'); assert.equal(A.stripComments(s), stripComments(s), f); }
  for (const s of ['', '/', 'a\n/', '( /x', '/*', '//', "'", 'x = /re[/]/g; // c', ' /x/  /y/', '`a${b}`/c/']) assert.equal(A.stripComments(s), stripComments(s), JSON.stringify(s));
});

test('R3E-02 — 조각 읽기 실패는 incomplete · scan.error · 증분 기준 불변', async () => {
  const L = await import('../src/security/loginFails.js');
  L._resetLoginFailIncForTest();
  const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000;
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push({ vcenterId: 'vc', ts: NOW - 100 * 60_000 - (i + 1) * 60_000, type: 'BadUsernameSessionEvent', user: 'bob', message: 'Cannot login bob@10.0.0.9', ip: '' });
  let fail = false;
  const read = ({ since, until }) => { if (fail) throw new Error('database is locked'); return rows.filter((r) => r.ts >= since && (until == null || r.ts <= until)); };
  const db = { loginFailCandidates: read };
  const ok = await L.analyzeLoginFails({ days: 1 }, { db, now: NOW, incremental: true });
  assert.equal(ok.incomplete, false);
  assert.equal(ok.summary.vcenter, 6);
  fail = true;
  const bad = await L.analyzeLoginFails({ days: 1 }, { db, now: NOW + 600_000, incremental: true });
  assert.equal(bad.incomplete, true);
  assert.ok(bad.scan.failedChunks > 0);
  assert.match(bad.scan.error, /locked/);
  const bad2 = await L.analyzeLoginFails({ days: 1 }, { db, now: NOW + 3_600_000, incremental: true });   // 실패가 이어진 둘째 주기
  assert.equal(bad2.incomplete, true);
  // 증분 기준이 전진하지 않았다 — 실패가 두 주기 이어지면, 기준이 전진했을 때 복구 주기의 겹침(2시간)이 표본(100~106분 전)을
  // 지나쳐 영영 빠진다(6 → 0). 전진하지 않았으면 마지막 성공 기준에서 다시 훑는다.
  fail = false;
  const again = await L.analyzeLoginFails({ days: 1 }, { db, now: NOW + 4_200_000, incremental: true });
  assert.equal(again.incomplete, false);
  assert.equal(again.summary.vcenter, 6);
  const full = await (async () => { fail = true; try { return await L.analyzeLoginFails({ days: 1 }, { db, now: NOW }); } finally { fail = false; } })();
  assert.equal(full.incomplete, true, '전 범위 분석도 실패를 밝힌다');
  const mon = srcOf('security/loginMonitor.js');
  assert.match(mon, /if \(r\.incomplete\) \{/);
  assert.match(mon, /else \{ lastSummary = r\.summary; lastIncomplete = null; \}/);
});

test('R3E-03 — 배정 보류는 시한 뒤 해제(빈 배정 명시)', async () => {
  const C = await import('../src/routes/central.js');
  C._resetEdgeConfigHoldForTest();
  const T0 = 1_800_000_000_000;
  assert.equal(C.edgeConfigHoldExpired('curuser', 'edge-a', true, T0), false);
  assert.equal(C.edgeConfigHoldExpired('curuser', 'edge-a', true, T0 + C.EDGE_CONFIG_HOLD_MS - 1), false);
  assert.equal(C.edgeConfigHoldExpired('curuser', 'edge-a', true, T0 + C.EDGE_CONFIG_HOLD_MS), true, '시한을 넘기면 해제');
  assert.equal(C.edgeConfigHoldExpired('vmseries', 'edge-a', true, T0 + C.EDGE_CONFIG_HOLD_MS), false, '종류마다 따로 잰다');
  assert.equal(C.edgeConfigHoldExpired('curuser', 'edge-a', false, T0 + 1), false, '다시 vCenter 가 생기면 초기화');
  assert.equal(C.edgeConfigHoldExpired('curuser', 'edge-a', true, T0 + C.EDGE_CONFIG_HOLD_MS + 5), false, '새로 잰다');
  const src = srcOf('routes/central.js');
  assert.match(src, /const expired = edgeConfigHoldExpired\('curuser', agent, mine\.size === 0\);\s*const held = mine\.size === 0 && !expired;/);
  assert.match(src, /const expired = edgeConfigHoldExpired\('vmseries', agent, mine\.size === 0\);[^\n]*\n\s*const held = mine\.size === 0 && !expired;/);
});

test('R3A-08 — X-Agent-Hostname 퍼센트 인코딩을 푼다(실패하면 원문 · 상한)', async () => {
  const { agentHostnameOf } = await import('../src/routes/central.js');
  const req = (v) => ({ get: (h) => (h === 'X-Agent-Hostname' ? v : undefined) });
  assert.equal(agentHostnameOf(req(encodeURIComponent('한글호스트'))), '한글호스트');
  assert.equal(agentHostnameOf(req('edge-01.corp')), 'edge-01.corp');
  assert.equal(agentHostnameOf(req('%E0%A4%A')), '%E0%A4%A', '디코드 실패면 원문');
  assert.equal(agentHostnameOf(req(undefined)), '');
  assert.equal(agentHostnameOf(req('a'.repeat(5000))).length, 255);
  assert.doesNotMatch(srcOf('routes/central.js'), /req\.get\('X-Agent-Hostname'\) \|\| ''/);
});

test('R3E-04 — 디바운스가 진행 중 판정과 겹치면 끝난 뒤 다시 판정한다', async () => {
  const F = await import('../src/cvp/faultScan.js');
  F._resetForTest();
  let release;
  F._setRunningForTest(new Promise((r) => { release = r; }));
  F.scheduleCvpFaultScan('ingest');
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(F.cvpFaultScanStatus().pending, 1, '진행 중이면 적재분을 버리지 않는다');
  release();
  await new Promise((r) => setTimeout(r, 1500));
  const st = F.cvpFaultScanStatus();
  assert.equal(st.pending, 0, '진행 중 판정이 끝난 뒤 다시 판정했다');
  assert.ok(st.last && /^ingest:1$/.test(st.last.reason || ''), `판정 사유 ${st.last?.reason}`);
  F._resetForTest();
});

test('R3E-05 — 롤업 백필 시작 전 예외는 error + 사유', async () => {
  const B = await import('../src/metrics/rollupBackfill.js');
  B._resetRollupBackfillForTest();
  const warn = console.warn; console.warn = () => {};
  try {
    const st = await B.runRollupBackfill({ db: { kind: 'sqlite', rollupBackfillStep() {}, metaValue() { throw new Error('database is locked'); } } });
    assert.equal(st.state, 'error');
    assert.match(st.lastError, /locked/);
  } finally { console.warn = warn; B._resetRollupBackfillForTest(); }
});

test('R3A-09 — 통신 점검 보고 POST 는 retries 0', () => {
  const src = srcOf('agent/linkCheckWorker.js');
  assert.match(src, /api\/central\/link-check`, agent\), \{ method: 'POST', headers: hdrs, body: payload, timeoutMs: 30_000, retries: 0 \}/);
});

test('R3A-05 — 같은 이름 로컬 계정 때문에 막힌 AD 로그인은 사유를 남긴다(응답은 null 그대로)', async () => {
  const A = await import('../src/auth/auth.js');
  A.createUser({ username: 'kim', role: 'viewer', password: 'Correct-Horse-9!' }, { trusted: true });
  const warn = console.warn; const lines = []; console.warn = (m) => lines.push(String(m));
  try {
    fs.writeFileSync(path.join(TMP, 'auth.json'), JSON.stringify({ ad: { enabled: false } }));
    A._resetAdShadowForTest();
    assert.equal(await A.authenticate('Kim', 'x'), null);
    assert.equal(A.adShadowBlockOf('kim'), null, 'AD 가 꺼져 있으면 기록하지 않는다');
    fs.writeFileSync(path.join(TMP, 'auth.json'), JSON.stringify({ ad: { enabled: true, url: 'ldap://127.0.0.1:1' } }));
    assert.equal(await A.authenticate('Kim', 'x'), null, '응답은 그대로(일반 실패)');
    assert.equal(await A.authenticate('Kim', 'y'), null);
    const rec = A.adShadowBlockOf('KIM');
    assert.ok(rec && rec.count === 2 && /로컬 계정/.test(rec.reason));
    assert.equal(lines.filter((l) => l.includes('AD 로그인 차단')).length, 1, '콘솔은 이름당 1시간 1회');
    const okUser = await A.authenticate('kim', 'Correct-Horse-9!');
    assert.ok(okUser, '로컬 인증 성공은 그대로');
  } finally { console.warn = warn; }
});
