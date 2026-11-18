// v3.18.14 — Monitoring 설정 연동 결함 3건(2026-11-18 검토 → '결함 수정해줘' · 검증 표준):
//  D1(재현) 엣지 포탈(수집 서버) HTTP 점검 경로 '/api/health' 는 `/api` 인증 라우터 아래라 인증 포탈에서 늘 401 → 200 고정 점검이 실패였다.
//     새 등록은 무인증 공개 경로 · 이미 등록된 대상은 '변경' 으로 올라 적용하면 점검 id 를 승계한 채 경로 · 표지 · 기대 코드만 고친다.
//  D2(재현) 자동 등록 직후 감지값이 등록 **전** 카탈로그라 개요 '감시 범위' 가 다음 감지까지 '감시 0 · 미등록 N' 이었다.
//  D3 '자동 등록 저장' 직후 감지가 돌지 않아 최대 감지 주기 동안 아무 일도 없었다 — 저장 직후 한 번 감지(실제 타이머 · 실제 카탈로그로 등록까지 확인).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'svcmonFix31814-'));
after(() => { const rm = () => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 늦은 flush 와의 경합 */ } }; rm(); process.once('exit', rm); });
process.env.CONFIG_DIR = TMP;
process.env.AUTH_ENABLED = 'true';
delete process.env.CENTRAL_URL;

const SYNC = await import('../src/svcmon/settingsSync.js');
const STORE = await import('../src/svcmon/store.js');
const KINDS = await import('../src/linkcheck/settingsKinds.js');
const SRC = (p) => fs.readFileSync(path.join(HERE, '..', 'src', p), 'utf8');

const cat = (kind, ref, o = {}) => ({
  id: `${kind}|${ref}`, kind, ref, label: KINDS.SETTING_KINDS[kind].label, group: KINDS.SETTING_KINDS[kind].group,
  depth: KINDS.SETTING_KINDS[kind].depth, settings: KINDS.SETTING_KINDS[kind].settings, name: o.name || ref,
  agent: '', vcenterId: '', enabled: true, address: o.host, host: o.host, port: o.port ?? 443, scheme: 'https', basePath: '', facts: {},
});

/* ── D1 ── */
test('D1 — 엣지 포탈 HTTP 점검은 무인증 공개 경로(인증을 켠 포탈에서 토큰 없이 200 · 표지 포함)', async () => {
  const http = SYNC.checksFor(cat('set:collector', 'e1', { host: 'e1.corp.example', port: 8443 })).find((c) => c.type === 'http');
  assert.equal(new URL(http.url).pathname, SYNC.COLLECTOR_PROBE_PATH);
  assert.equal(http.expectStatus, 200);
  assert.equal(http.keyword, SYNC.COLLECTOR_PROBE_KEYWORD);
  // 실제 라우터 — 인증 켬 · 토큰 없음(Monitoring 점검과 같은 조건)
  const express = (await import('express')).default;
  const { authRouter } = await import('../src/routes/auth.js');
  const { authMiddleware } = await import('../src/auth/auth.js');
  const app = express();
  app.use('/api/auth', authRouter);
  app.use('/api', authMiddleware, (_req, res) => res.json({ status: 'ok' }));   // index.js 와 같은 순서 — 인증 라우터 아래
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const ok = await fetch(`${base}${SYNC.COLLECTOR_PROBE_PATH}`);
    assert.equal(ok.status, 200, '새 경로는 토큰 없이 200');
    assert.ok((await ok.text()).includes(SYNC.COLLECTOR_PROBE_KEYWORD), '본문에 표지');
    assert.equal((await fetch(`${base}/api/health`)).status, 401, '옛 경로는 인증 포탈에서 401(재현)');
  } finally { server.close(); }
  // 운영 index.js 에서도 '/api/auth' 가 인증 라우터('/api', authMiddleware)보다 먼저 붙는다
  const idx = SRC('index.js');
  assert.ok(idx.indexOf("app.use('/api/auth', authRouter)") > 0 && idx.indexOf("app.use('/api/auth', authRouter)") < idx.indexOf("app.use('/api', authMiddleware"));
});

test('D1 — 이미 등록된 옛 정의 대상은 \'변경\' · 적용하면 경로 · 표지 · 기대 코드만 고치고 점검 id · 사용 여부 · 주기는 그대로', () => {
  const x = cat('set:collector', 'e2', { host: '10.30.1.5', port: 4000 });
  const spec = SYNC.checksFor(x);
  const legacyUrl = 'https://10.30.1.5:4000/api/health';
  const tests = spec.map((s) => (s.tplKey === 'http' ? { ...s, url: legacyUrl, keyword: 'status' } : s));
  const r0 = STORE.bulkAddTargets([{ kind: 'infra', path: '설정 연동\\중앙↔엣지\\전역', name: 'e2', host: '10.30.1.5', enabled: true, tests,
    origin: SYNC.originOf(x, { label: '전역' }) }], { dedup: false, trustedOrigin: true });
  assert.equal(r0.committed, true, JSON.stringify(r0.errors));
  const before = STORE.listTargets().find((t) => t.name === 'e2');
  const httpBefore = before.tests.find((t) => t.tplKey === 'http');
  STORE.updateTest(before.id, httpBefore.id, { intervalSec: 600 });   // 사람이 바꾼 주기 — 적용이 덮지 않아야 한다
  STORE.updateTest(before.id, before.tests.find((t) => t.tplKey === 'tcp').id, { enabled: false });
  const cls = SYNC.classifyCatalog({ targets: [x] }, STORE.listTargets(), {});
  const row = cls.rows.find((r) => r.key === x.id);
  assert.equal(row.state, 'changed');
  assert.equal(row.defChanged, true);
  assert.match(row.reason, /점검 정의가 바뀌었습니다/);
  const plan = SYNC.planApply(cls.rows, [x.id], { builtByKey: new Map([[x.id, x]]) });
  assert.equal(plan.change.length, 1);
  SYNC.executePlan(plan, { user: 'adm' });
  const after = STORE.getTarget(before.id);
  const h = after.tests.find((t) => t.tplKey === 'http');
  assert.equal(h.id, httpBefore.id, '점검 id 승계(연속 횟수 · 만기)');
  assert.equal(new URL(h.url).pathname, SYNC.COLLECTOR_PROBE_PATH);
  assert.equal(h.keyword, SYNC.COLLECTOR_PROBE_KEYWORD);
  assert.equal(h.expectStatus, 200);
  assert.equal(h.intervalSec, 600, '사람이 바꾼 주기는 그대로');
  assert.equal(after.tests.find((t) => t.tplKey === 'tcp').enabled, false, '사람이 끈 점검은 그대로');
  assert.equal(SYNC.classifyCatalog({ targets: [x] }, STORE.listTargets(), {}).rows.find((r) => r.key === x.id).state, 'linked', '고친 뒤 다시 분류하면 연동');
});

test('D1 — 옛 정의 판정은 좁게: 사람이 더한 점검 · 다른 종류 · 다른 경로는 \'변경\' 이 아니다', () => {
  const legacy = { tpl: SYNC.SYNC_TPL, tplKey: 'http', url: 'https://e:4000/api/health' };
  assert.equal(SYNC.isLegacyCheck('set:collector', legacy), true);
  assert.equal(SYNC.isLegacyCheck('set:collector', { ...legacy, tpl: undefined }), false, '사람이 만든 점검');
  assert.equal(SYNC.isLegacyCheck('set:nsx', legacy), false, '다른 종류');
  assert.equal(SYNC.isLegacyCheck('set:collector', { ...legacy, url: 'https://e:4000/api/auth/config' }), false);
  assert.equal(SYNC.isLegacyCheck('set:collector', { ...legacy, url: '::bad' }), false);
});

/* ── D2 · D3 ── */
const vcFile = path.join(TMP, 'vcenters.json');
before(() => {
  fs.writeFileSync(vcFile, JSON.stringify({ vcenters: [
    { id: 'vc-fx-1', name: 'vc-fx-1', host: '10.40.1.10', username: 'svc', password: 'x', enabled: true, collectMode: 'direct' },
    { id: 'vc-fx-2', name: 'vc-fx-2', host: '10.40.1.11', username: 'svc', password: 'x', enabled: true, collectMode: 'direct' },
  ] }));
});

test('D2(재현) — 자동 등록한 감지의 감지값은 등록 뒤 카탈로그(개요 감시 범위가 다음 감지까지 0 이 아니다)', async () => {
  const set = SYNC.setOptions({ autoKinds: ['set:vcenter'] });
  assert.equal(set.saved, true);
  const cat1 = await SYNC.detectOnce({ ctx: {}, candidates: new Map() });
  assert.ok(cat1, '감지가 돌았다');
  const mine = STORE.listTargets().filter((t) => String(t.origin?.key || '').startsWith('set:vcenter|vc-fx-'));
  assert.equal(mine.length, 2, '자동 등록 2건');
  assert.ok(mine.every((t) => t.enabled === false), '언제나 중지 상태');
  const last = SYNC.lastDetection();
  assert.ok(last.counts.linked >= 2, `감지값의 연동 수(${last.counts.linked}) — 예전에는 0`);
  const cov = SYNC.coverageSummary();
  assert.ok(cov.stopped >= 2, '감시 범위 카드: 등록됐지만 중지');
  SYNC.setOptions({ autoKinds: [] });
});

test('D3 — 자동 등록 저장 직후 감지가 한 번 돈다(실제 감지 타이머 · 실제 카탈로그로 등록까지) · 화면 안내 문구', async () => {
  // 새 vCenter 하나 — 아직 한 번도 연동된 적 없는 키
  const db = JSON.parse(fs.readFileSync(vcFile, 'utf8'));
  db.vcenters.push({ id: 'vc-fx-3', name: 'vc-fx-3', host: '10.40.1.12', username: 'svc', password: 'x', enabled: true, collectMode: 'direct' });
  fs.writeFileSync(vcFile, JSON.stringify(db));
  const express = (await import('express')).default;
  const { svcmonRouter } = await import('../src/routes/svcmon.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin' }; next(); });
  app.use('/api/svcmon', svcmonRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const put = async (kinds) => (await fetch(`http://127.0.0.1:${server.address().port}/api/svcmon/settings-sync/options`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autoKinds: kinds }) })).json();
  try {
    const off = await put(['set:vcenter']);
    assert.equal(off.detectQueued, false, '감지 타이머가 없는 노드(시험 · 엣지)는 거짓으로 \'곧 감지\' 라 하지 않는다');
    await put([]);
    SYNC.startSettingsSyncDetector();
    const on = await put(['set:vcenter']);
    assert.equal(on.ok, true);
    assert.equal(on.detectQueued, true, '새 종류를 켜면 곧바로 한 번 감지');
    const deadline = Date.now() + 15_000;
    let got = null;
    while (Date.now() < deadline) {
      got = STORE.listTargets().find((t) => t.origin?.key === 'set:vcenter|vc-fx-3');
      if (got) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(got, '감지 주기를 기다리지 않고 등록됐다');
    assert.equal(got.enabled, false);
    const again = await put(['set:vcenter']);
    assert.equal(again.detectQueued, false, '켠 종류가 늘지 않으면(그대로 저장) 다시 돌리지 않는다');
  } finally { server.close(); SYNC.setOptions({ autoKinds: [] }); }
});
