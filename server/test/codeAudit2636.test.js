/**
 * v2.636 — 특수 기능 › 포탈 점검 › **코드 감사** 회귀.
 *
 * 고정하는 것:
 *  ① 카탈로그 `portalcheck/codeAudit.json` 이 모양 검사를 통과한다 — 분류 4 × 10건 · id 유일 · rank 1..10 · 문장 필드 백틱 0.
 *  ② **open 발견의 앵커가 지금 소스에 실재한다**(줄 무관 — 줄은 화면이 moved 로 말한다). 발견을 고치면 그 커밋에서
 *     status 를 fixed 로 바꿔야 한다 — 안 바꾸면 여기서 '앵커가 사라졌다' 로 잡힌다.
 *  ③ `checkAnchor` — present/moved/gone/missing-file/no-source/unchecked 를 임시 트리로 각각 재현.
 *  ④ 실제 `api` 라우터로 `GET /api/tools/portal-check/code-audit` — 전체 범위 admin 200 · 범위 admin 403 · operator 403 ·
 *     KPI 항등식 · 응답에 절대 경로 0.
 *  ⑤ `scripts/code-audit-doc.mjs --check` 통과 + CI 가 그것을 돌린다(문서 = JSON 의 투사).
 *
 * ⚠ CONFIG_DIR 은 import 전에 임시 디렉터리로 고정한다(config.js 싱글턴). 역할 게이트는 AUTH_ENABLED=true 여야 뜻이 있다(v2.633).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaudit2636-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let C; let express; let api; let srv; let base;
const USERS = {
  full: { username: 'full', role: 'admin', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-us-east'] } },
  op: { username: 'op', role: 'operator', scope: null },
};
before(async () => {
  C = await import('../src/portalcheck/codeAudit.js');
  express = (await import('express')).default;
  ({ api } = await import('../src/routes/api.js'));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
});
after(() => { srv?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const get = (p, u) => fetch(base + p, { headers: u ? { 'x-u': u } : {} });

test('① 카탈로그 모양 — 분류 4 × 10건 · id 유일 · rank · 백틱 0', () => {
  const r = C.loadCodeAudit();
  assert.deepEqual(r.errors, [], r.errors.join('\n'));
  assert.ok(r.ok);
  const k = C.kpiOf(r.data.findings);
  assert.equal(k.total, C.CATEGORIES.length * C.PER_CATEGORY);
  for (const c of C.CATEGORIES) assert.equal(k.byCategory[c], C.PER_CATEGORY, c);
  // 변이: 한 건을 빼면 개수 규칙이 잡는다 · 백틱을 넣으면 잡는다 · 절대 경로를 넣으면 잡는다
  const bad = structuredClone(r.data); bad.findings.pop();
  assert.ok(C.validateCodeAudit(bad).some((e) => /10건이어야/.test(e)));
  const bt = structuredClone(r.data); bt.findings[0].fix = 'x `y`';
  assert.ok(C.validateCodeAudit(bt).some((e) => /백틱/.test(e)));
  const abs = structuredClone(r.data); abs.findings[0].file = '/etc/passwd';
  assert.ok(C.validateCodeAudit(abs).some((e) => /상대 경로/.test(e)));
});

test('② open 발견의 앵커가 지금 소스에 실재한다(줄 무관) — 고쳤으면 status:fixed 로', () => {
  const { data } = C.loadCodeAudit();
  const missing = [];
  for (const f of data.findings) {
    if ((f.status || 'open') !== 'open') continue;
    const r = C.checkAnchor(f, { root: ROOT });
    if (!['present', 'moved'].includes(r.state)) missing.push(`${f.id} ${f.file}:${f.line} → ${r.state}`);
  }
  assert.deepEqual(missing, [], `앵커가 소스에 없다 — 고쳤으면 codeAudit.json 의 status 를 fixed 로:\n${missing.join('\n')}`);
});

test('③ checkAnchor — present/moved/gone/missing-file/no-source/unchecked', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaudit-root-'));
  fs.mkdirSync(path.join(root, 'server/src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server/src/a.js'), 'line1\nconst x = 1;\nfoo(bar);\n');
  const f = (over) => ({ id: 'X', file: 'server/src/a.js', line: 2, anchor: 'const x = 1;', status: 'open', ...over });
  assert.deepEqual(C.checkAnchor(f(), { root }), { state: 'present', lineNow: 2 });
  assert.deepEqual(C.checkAnchor(f({ line: 1 }), { root }), { state: 'moved', lineNow: 2 });
  assert.deepEqual(C.checkAnchor(f({ anchor: 'nope' }), { root }), { state: 'gone', lineNow: null });
  assert.deepEqual(C.checkAnchor(f({ file: 'server/src/b.js' }), { root }), { state: 'missing-file', lineNow: null });
  assert.deepEqual(C.checkAnchor(f({ file: 'web/src/b.js' }), { root }), { state: 'no-source', lineNow: null });
  assert.deepEqual(C.checkAnchor(f({ status: 'fixed' }), { root }), { state: 'unchecked', lineNow: null });
  assert.deepEqual(C.checkAnchor(f({ file: '../../etc/passwd' }), { root }), { state: 'unchecked', lineNow: null });
  assert.deepEqual(C.sourceInfo(root), { serverSrc: true, webSrc: false, docs: false, scripts: false });
  fs.rmSync(root, { recursive: true, force: true });
});

test('④ GET /api/tools/portal-check/code-audit — 전체 범위 admin 200 · 범위 admin 403 · operator 403 · 항등식 · 절대 경로 0', async () => {
  const r = await get('/tools/portal-check/code-audit', 'full');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.ok, JSON.stringify(j.errors));
  assert.equal(j.findings.length, j.kpi.total);
  assert.equal(Object.values(j.kpi.byCategory).reduce((a, b) => a + b, 0), j.kpi.total);
  assert.equal(Object.values(j.kpi.byAnchor).reduce((a, b) => a + b, 0), j.kpi.total);
  assert.ok(j.findings.every((f) => ['present', 'moved'].includes(f.check.state) || f.status === 'fixed'), '이 트리에서는 open 앵커가 전부 present/moved');
  assert.ok(j.serverVersion && j.date && j.base);
  const body = JSON.stringify(j);
  assert.ok(!body.includes(ROOT), '응답에 절대 경로가 실렸다');
  assert.ok(!/"file":"\//.test(body));
  assert.equal((await get('/tools/portal-check/code-audit', 'sadm')).status, 403);
  assert.equal((await get('/tools/portal-check/code-audit', 'op')).status, 403);
  assert.equal((await get('/tools/portal-check/code-audit')).status, 401);
});

test('⑤ docs/<doc> 는 JSON 의 투사 — 생성기 --check 통과 · CI 가 돌린다', () => {
  const r = spawnSync(process.execPath, ['scripts/code-audit-doc.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `문서가 낡았습니다. 'node scripts/code-audit-doc.mjs' 를 실행하세요.\n${r.stderr}`);
  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /node scripts\/code-audit-doc\.mjs --check/, 'CI 가 code-audit-doc --check 를 돌리지 않는다');
  const { data } = C.loadCodeAudit();
  assert.ok(fs.existsSync(path.join(ROOT, 'docs', data.doc)), `docs/${data.doc} 가 없다`);
});
