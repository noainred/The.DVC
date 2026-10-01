/**
 * v2.679 — 특수 기능 메뉴 이름·설명·개발 단계(핸드오프 '특수 기능 화면 재구성' §1).
 *
 * 고정하는 것:
 *  ① 정규화 — 빈 문자열은 키를 지운다(비우면 원래 값) · 단계 id 형식 · 팔레트 밖 색 거부 · 단계 상한·중복.
 *  ② 업그레이드만으로 단계 축이 켜지지 않는다(기본 stages:null) — 옛 설정 파일을 읽어도 그대로.
 *  ③ 단계를 지우면 그 단계를 가리키던 기능의 stage 만 지워진다(이름·설명은 남는다). 단계 축을 끄면(null) 손대지 않는다.
 *  ④ 실제 admin 라우터: PUT 저장·GET 응답(limits·defaultStages) · 오류 400 · operator 403 · 범위 admin 403 · 카테고리 저장이 덮어쓰기를 지우지 않는다.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'toolnames2679-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

let C; let S; let srv; let base;
const USERS = {
  full: { username: 'full', role: 'admin', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-us-east'] } },
  op: { username: 'op', role: 'operator', scope: null },
};
before(async () => {
  C = await import('../src/toolcats/catalog.js');
  S = await import('../src/toolcats/settings.js');
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api/admin', adminRouter);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/admin`;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function call(u, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j };
}

test('① normOverride — 빈 값은 키를 지우고, 남는 것이 없으면 null', () => {
  assert.equal(C.normOverride({ label: '  ', desc: '', stage: '' }), null);
  assert.deepEqual(C.normOverride({ label: ' 새 이름 ', desc: 'd', stage: 'DEV' }), { label: '새 이름', desc: 'd', stage: 'dev' });
  assert.deepEqual(C.normOverride({ stage: 'bad id!' }), null);
  assert.equal(C.normOverride({ desc: 'x'.repeat(500) }).desc.length, C.MAX_DESC);
  // 키 형식이 틀린 항목은 버린다.
  assert.deepEqual(C.normOverrides({ 'Bad Key': { label: 'x' }, gpu: { label: 'G' } }), { gpu: { label: 'G' } });
});

test('① validate — 팔레트 밖 색·중복 id·상한은 오류, 없는 단계 참조는 경고만', () => {
  assert.match(C.validate({ stages: [{ id: 'a', label: 'A', color: 'red' }] })[0], /팔레트/);
  assert.match(C.validate({ stages: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }).join(), /중복/);
  const many = Array.from({ length: C.MAX_STAGES + 1 }, (_, i) => ({ id: `s${i}`, label: `S${i}`, color: C.STAGE_COLORS[0] }));
  assert.match(C.validate({ stages: many }).join(), /최대/);
  const v = C.validateStages({ stages: [{ id: 'prod', label: '운영', color: '#22c55e' }], overrides: { gpu: { stage: 'gone' } } });
  assert.deepEqual(v.errors, []);
  assert.equal(v.warnings.length, 1);
  assert.deepEqual(C.validate({ stageDisplay: 'weird' }).length, 1);
});

test('② 기본값은 단계 축 꺼짐 — 옛 설정 파일(stages 없음)을 읽어도 그대로', () => {
  fs.writeFileSync(S._FILE, JSON.stringify({ enabled: true, categories: [{ id: 'server', label: '서버', tools: ['gpu'] }] }));
  S.invalidate();
  const c = S.load();
  assert.equal(c.stages, null);
  assert.deepEqual(c.overrides, {});
  assert.equal(c.stageDisplay, 'badge');
  assert.equal(c.categories.length, 1);
});

test('③ 단계 삭제 → 그 단계를 가리키던 기능은 stage 만 지워진다 · 단계 축을 끄면 손대지 않는다', () => {
  S.invalidate();
  S.save({ stages: C.DEFAULT_STAGES, overrides: { gpu: { stage: 'dev', label: 'GPU X' }, hba: { stage: 'dev' } } });
  const info = {};
  const r = S.save({ stages: C.DEFAULT_STAGES.filter((s) => s.id !== 'dev') }, info);
  assert.equal(info.stageRefsCleared, 2);
  assert.deepEqual(r.overrides, { gpu: { label: 'GPU X' } });
  S.save({ overrides: { gpu: { stage: 'verify' } } });
  const off = S.save({ stages: null });
  assert.equal(off.stages, null);
  assert.deepEqual(off.overrides, { gpu: { stage: 'verify' } }, '단계 축을 꺼도 지정은 남는다(다시 켜면 돌아온다)');
});

test('④ 실제 라우터 — 저장·조회·오류·권한', async () => {
  S.invalidate();
  fs.rmSync(S._FILE, { force: true });
  const g0 = await call('full', 'GET', '/tool-categories');
  assert.equal(g0.s, 200);
  assert.deepEqual(g0.j.limits.stageColors, [...C.STAGE_COLORS]);
  assert.equal(g0.j.defaultStages.length, 4);
  assert.equal(g0.j.settings.stages, null);

  const ok = await call('full', 'PUT', '/tool-categories', { stages: g0.j.defaultStages, overrides: { gpu: { label: 'GPU 운영', stage: 'dev' } }, stageDisplay: 'suffix' });
  assert.equal(ok.s, 200);
  assert.equal(ok.j.settings.overrides.gpu.label, 'GPU 운영');
  assert.equal(ok.j.settings.stageDisplay, 'suffix');

  const bad = await call('full', 'PUT', '/tool-categories', { stages: [{ id: 'x', label: 'X', color: 'javascript:alert(1)' }] });
  assert.equal(bad.s, 400);

  assert.equal((await call('op', 'PUT', '/tool-categories', { overrides: {} })).s, 403);
  assert.equal((await call('sadm', 'PUT', '/tool-categories', { overrides: {} })).s, 403);

  // 카테고리 화면의 저장(overrides·stages 를 보내지 않음)이 덮어쓰기를 지우지 않는다.
  const cat = await call('full', 'PUT', '/tool-categories', { enabled: true, categories: [{ id: 'server', label: '서버', tools: ['gpu'] }] });
  assert.equal(cat.s, 200);
  assert.equal(cat.j.settings.overrides.gpu.label, 'GPU 운영');
  assert.equal(cat.j.settings.stages.length, 4);

  // 조회는 로그인 사용자 누구나(특수 기능 화면이 자기 배치를 그린다).
  const g1 = await call('op', 'GET', '/tool-categories');
  assert.equal(g1.s, 200);
  assert.equal(g1.j.settings.overrides.gpu.stage, 'dev');
});
