/**
 * audit2732h.test.js — 점검 2회차(v2.732) 그룹 h: 권한·가림 잔여(B3-01 · B3-03 · B3-05 · B3-06 · B3-07).
 *
 * 전부 **실제 라우터**(api · adminRouter)를 express 에 띄우고 역할(admin · 범위 admin · operator · 범위 operator · 데모 계정)별
 * 상태코드·응답 필드로 본다(소스 grep 이 아니다). 데모 계정은 실제 authMiddleware 와 같은 `denyDemoGuest` 를 앞에 둔다.
 *
 *  ① B3-01 데모 계정의 라이선스 만료 조회(GET)가 사람이 등록한 Horizon 커넥션 서버에 실제로 로그인하지 않는다 — demoSkipped 로 밝힌다.
 *  ② B3-03 범위 관리자의 GET /admin/alerts 에 웹훅 URL(쓰기 자격증명) 원문이 없다 — hasUrl·urlHidden 만. 전체 범위 admin 은 원문.
 *  ③ B3-05 GPU 스냅샷 JSON 파일 내보내기(/tools/gpu.json)도 data.csv 게이트다(형제 gpu.csv·gpu/export.json 과 같다).
 *  ④ B3-06 범위 관리자는 게시판에서 관리자 권한이 없다(남의 글 수정·고정·삭제 403, 표시 플래그 false) — 자기 글은 그대로.
 *  ⑤ B3-07 범위 계정에는 비용 단가·태그 정책 설정의 updatedBy(계정명)가 null 이다 — 전체 범위 응답은 그대로(v2.721 vm-hygiene 규칙).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

// config.js 가 import 시점에 굳으므로 src 를 부르기 전에 고정한다.
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'a2732h-'));
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_SECRET = 'x'.repeat(40);
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 가짜 Horizon(127.0.0.1) — 데모 계정이 거기에 닿는지를 본다

const ADMIN = { username: 'adm', role: 'admin', name: 'adm', scope: null };
const SADMIN = { username: 'sadm', role: 'admin', name: 'sadm', scope: { vcenters: ['vc-a'] } };
const OPER = { username: 'op', role: 'operator', name: 'op', scope: null };
const SOPER = { username: 'sop', role: 'operator', name: 'sop', scope: { vcenters: ['vc-a'] } };
const DEMO = { username: 'thedvcdemp', role: 'admin', name: 'demo', scope: null, demoGuest: true };

const { denyDemoGuest } = await import('../src/auth/demoGuest.js');

/** 라우터를 마운트하고 req.user 를 주입한 앱으로 1회 요청. 데모 계정은 실제 미들웨어와 같은 판정을 먼저 받는다. */
async function call(mount, router, user, method, url, body) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { ...user }; if (denyDemoGuest(req, res)) return; next(); });
  app.use(mount, router);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}${mount}${url}`, {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 파일 응답 */ }
    return { status: res.status, text, body: json, headers: Object.fromEntries(res.headers) };
  } finally { srv.close(); }
}

/* ── ① B3-01 ─────────────────────────────────────────────────────────────── */
test('① B3-01 데모 계정의 GET /tools/license-expiry 는 사람이 등록한 Horizon 에 로그인하지 않는다(demoSkipped) · 일반 admin 은 그대로', async () => {
  const hits = [];
  const fake = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => { hits.push({ m: req.method, u: req.url, b: b.slice(0, 200) }); res.writeHead(401, { 'content-type': 'application/json' }); res.end('{}'); });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  try {
    const hz = await import('../src/horizon/horizon.js');
    const { api } = await import('../src/routes/api.js');
    const port = fake.address().port;
    assert.equal(hz.upsertHorizon({ id: 'hz-real', name: 'real-cs', host: `http://127.0.0.1:${port}`, username: 'svc-portal', password: 'S3cret!pw', domain: 'CORP' }).ok, true);
    assert.equal(hz.upsertHorizon({ id: 'mock-hz-demo', name: 'demo-cs', host: 'https://demo-cs.mock.invalid', username: 'demo', password: 'demo', domain: 'DEMO' }).ok, true);

    const d1 = await call('/api', api, DEMO, 'GET', '/tools/license-expiry');
    assert.equal(d1.status, 200, d1.text.slice(0, 300));
    assert.equal(hits.length, 0, `데모 계정 요청이 사람이 등록한 커넥션 서버에 닿았다: ${JSON.stringify(hits)}`);
    assert.equal(d1.body.demoSkipped, 1, '건너뛴 사람 등록 서버 수를 밝힌다(조용한 생략 금지)');
    assert.ok(d1.body.items.some((i) => i.source === 'Horizon'), '데모(mock-) 서버의 합성 라이선스는 그대로 보인다');
    assert.ok(!d1.body.items.some((i) => i.source === 'Horizon' && /real-cs/.test(i.where)), '사람 등록 서버의 행이 없다');
    assert.ok(d1.body.collectionErrors.some((e) => /데모 계정/.test(e) && /1대/.test(e)), `화면이 생략 사실을 말한다: ${JSON.stringify(d1.body.collectionErrors)}`);
    assert.ok(!/S3cret|svc-portal/.test(d1.text), '저장 자격증명 흔적 없음');

    // 일반 admin(mock 모드에서도 사람이 등록한 서버는 실제로 수집 — v2.708 설계)은 로그인을 시도한다.
    const a1 = await call('/api', api, ADMIN, 'GET', '/tools/license-expiry');
    assert.equal(a1.status, 200);
    assert.equal(hits.length, 1, '일반 admin 은 사람이 등록한 서버를 실제로 조회한다(설계 고정)');
    assert.equal(hits[0].u, '/rest/login');
    assert.equal(a1.body.demoSkipped, undefined, '데모 계정이 아니면 생략 필드가 없다');
    assert.ok(a1.body.collectionErrors.some((e) => /real-cs/.test(e)), 'admin 은 그 서버의 조회 실패를 본다');

    // 그 뒤 데모 계정이 다시 열어도 접속하지 않고, admin 이 받아 둔 그 서버의 결과(오류 원문 포함)를 싣지 않는다.
    const d2 = await call('/api', api, DEMO, 'GET', '/tools/license-expiry');
    assert.equal(d2.status, 200);
    assert.equal(hits.length, 1, '두 번째 데모 요청도 접속하지 않는다');
    assert.ok(!d2.body.collectionErrors.some((e) => /real-cs.*로그인 실패|HTTP 401/.test(e)), `사람 등록 서버의 오류 원문이 데모 계정에 실리지 않는다: ${JSON.stringify(d2.body.collectionErrors)}`);
    assert.equal(d2.body.demoSkipped, 1);
  } finally { fake.close(); }
});

/* ── ② B3-03 ─────────────────────────────────────────────────────────────── */
test('② B3-03 범위 관리자의 GET /admin/alerts 는 웹훅 URL 원문을 주지 않는다(hasUrl·urlHidden) · 전체 범위 admin 은 원문', async () => {
  const al = await import('../src/alerts.js');
  const { adminRouter } = await import('../src/routes/admin.js');
  al.saveAlertConfig({ channels: {
    slack: { enabled: true, url: 'https://hooks.slack.com/services/T000/B000/SECRETTOKENxyz' },
    webhook: { enabled: false, url: '' },
    teams: { enabled: true, url: 'https://example.webhook.office.com/IncomingWebhook/SECRET3/xyz' },
  } });
  const s = await call('/api/admin', adminRouter, SADMIN, 'GET', '/alerts');
  assert.equal(s.status, 200, s.text.slice(0, 300));
  assert.ok(!/SECRETTOKEN|SECRET3|hooks\.slack\.com|webhook\.office\.com/.test(s.text), '범위 관리자 응답에 웹훅 URL 이 없다');
  const ch = s.body.config.channels;
  assert.equal(ch.slack.url, ''); assert.equal(ch.slack.hasUrl, true); assert.equal(ch.slack.urlHidden, true);
  assert.equal(ch.teams.url, ''); assert.equal(ch.teams.hasUrl, true);
  assert.equal(ch.webhook.hasUrl, false, '설정 안 된 채널은 hasUrl:false');
  assert.equal(ch.slack.enabled, true, '켜짐 여부는 그대로');
  assert.equal(s.body.scoped, true);
  assert.equal(s.body.config.urlsHidden, true, '가렸다는 사실을 응답이 말한다');

  const a = await call('/api/admin', adminRouter, ADMIN, 'GET', '/alerts');
  assert.equal(a.status, 200);
  assert.equal(a.body.config.channels.slack.url, 'https://hooks.slack.com/services/T000/B000/SECRETTOKENxyz', '전체 범위 admin 은 편집 폼에 원문');
  assert.equal(a.body.config.urlsHidden, undefined);
  // 범위 관리자는 저장도 못 한다(v2.622) — 가린 값이 원본을 덮을 경로가 없다.
  const p = await call('/api/admin', adminRouter, SADMIN, 'PUT', '/alerts', { channels: { slack: { enabled: true, url: '' } } });
  assert.equal(p.status, 403);
  const o = await call('/api/admin', adminRouter, OPER, 'GET', '/alerts');
  assert.equal(o.status, 403);
  const d = await call('/api/admin', adminRouter, DEMO, 'GET', '/alerts');
  assert.equal(d.status, 403, '데모 계정은 READ_DENY');
});

/* ── ③ B3-05 ─────────────────────────────────────────────────────────────── */
test('③ B3-05 /tools/gpu.json 은 data.csv 게이트 — operator 403 · admin 200(형제 gpu.csv 와 같다)', async () => {
  const { api } = await import('../src/routes/api.js');
  for (const u of [OPER, SOPER]) {
    const r = await call('/api', api, u, 'GET', '/tools/gpu.json');
    assert.equal(r.status, 403, `${u.username}: gpu.json`);
    assert.deepEqual(r.body.requiredPerm, ['data.csv']);
    const c = await call('/api', api, u, 'GET', '/tools/gpu.csv');
    assert.equal(c.status, 403, `${u.username}: gpu.csv(형제)`);
  }
  const a = await call('/api', api, ADMIN, 'GET', '/tools/gpu.json');
  assert.equal(a.status, 200);
  assert.match(a.headers['content-disposition'] || '', /attachment; filename="gpu-.*\.json"/);
  // 화면 조회(JSON 응답)는 data.csv 와 무관하다.
  const v = await call('/api', api, OPER, 'GET', '/tools/gpu');
  assert.equal(v.status, 200);
});

/* ── ④ B3-06 ─────────────────────────────────────────────────────────────── */
test('④ B3-06 범위 관리자는 게시판 관리 권한이 없다 — 남의 글 수정·고정·삭제 403 · 자기 글은 그대로 · 표시 플래그 false', async () => {
  const { api } = await import('../src/routes/api.js');
  const p1 = await call('/api', api, ADMIN, 'POST', '/board/posts', { title: '전체 관리자 글', body: '원문' });
  assert.equal(p1.status, 200, p1.text.slice(0, 300));
  const id1 = p1.body.post.id;
  const c1 = await call('/api', api, ADMIN, 'POST', `/board/posts/${id1}/comments`, { body: '관리자 댓글' });
  assert.equal(c1.status, 200);

  const e1 = await call('/api', api, SADMIN, 'PUT', `/board/posts/${id1}`, { body: '범위 관리자가 바꾼 본문' });
  assert.equal(e1.status, 403, '남의 글 본문 수정');
  assert.match(e1.body.reason, /범위 관리자/, '왜 막혔는지 말한다');
  const e2 = await call('/api', api, SADMIN, 'PUT', `/board/posts/${id1}`, { pinned: true });
  assert.equal(e2.status, 403, '상단 고정');
  const e3 = await call('/api', api, SADMIN, 'DELETE', `/board/posts/${id1}/comments/${c1.body.comment.id}`);
  assert.equal(e3.status, 403, '남의 댓글 삭제');
  const e4 = await call('/api', api, SADMIN, 'DELETE', `/board/posts/${id1}`);
  assert.equal(e4.status, 403, '남의 글 삭제');
  const g = await call('/api', api, ADMIN, 'GET', `/board/posts/${id1}`);
  assert.equal(g.body.post.body, '원문'); assert.equal(g.body.post.pinned, false);

  // 자기 글은 그대로 — 쓰기·수정·삭제. 고정 요청은 적용되지 않는다(관리자 아님).
  const own = await call('/api', api, SADMIN, 'POST', '/board/posts', { title: '범위 관리자 글', body: 'a', pinned: true });
  assert.equal(own.status, 200);
  assert.equal(own.body.post.pinned, false, '범위 관리자의 고정 요청은 무시');
  const ownEdit = await call('/api', api, SADMIN, 'PUT', `/board/posts/${own.body.post.id}`, { body: 'b' });
  assert.equal(ownEdit.status, 200);
  const ownDel = await call('/api', api, SADMIN, 'DELETE', `/board/posts/${own.body.post.id}`);
  assert.equal(ownDel.status, 200);

  // 표시 플래그 — 서버 판정과 같은 함수(누르면 403 이 되는 버튼을 보이지 않는다).
  const ls = await call('/api', api, SADMIN, 'GET', '/board/posts');
  assert.equal(ls.body.isAdmin, false); assert.equal(ls.body.canWrite, true);
  const la = await call('/api', api, ADMIN, 'GET', '/board/posts');
  assert.equal(la.body.isAdmin, true);
  const ns = await call('/api', api, SADMIN, 'GET', '/notices');
  assert.equal(ns.body.canEdit, false, '공지 편집은 전체 범위 관리자만(서버는 403)');
  const na = await call('/api', api, ADMIN, 'GET', '/notices');
  assert.equal(na.body.canEdit, true);

  // 전체 범위 관리자는 예전처럼 중재한다.
  const ok = await call('/api', api, ADMIN, 'PUT', `/board/posts/${id1}`, { pinned: true });
  assert.equal(ok.status, 200); assert.equal(ok.body.post.pinned, true);
});

/* ── ⑤ B3-07 ─────────────────────────────────────────────────────────────── */
test('⑤ B3-07 범위 계정에는 비용 단가·태그 정책의 updatedBy 가 null — 전체 범위는 그대로', async () => {
  const { api } = await import('../src/routes/api.js');
  const s1 = await call('/api', api, ADMIN, 'PUT', '/tools/cost-showback/settings', { vcpu: 10 });
  assert.equal(s1.status, 200, s1.text.slice(0, 300));
  assert.equal(s1.body.settings.updatedBy, 'adm');
  const s2 = await call('/api', api, ADMIN, 'PUT', '/tools/vm-tags/policy', { requiredCategories: ['Owner'] });
  assert.equal(s2.status, 200, s2.text.slice(0, 300));
  assert.equal(s2.body.policy.updatedBy, 'adm');

  for (const u of [SADMIN, SOPER]) {
    const c = await call('/api', api, u, 'GET', '/tools/cost-showback/settings');
    assert.equal(c.status, 200);
    assert.equal(c.body.settings.updatedBy, null, `${u.username}: cost-showback`);
    assert.equal(c.body.settings.vcpu, 10, '단가 자체는 그대로(화면 계산에 쓴다)');
    assert.ok(!/"adm"/.test(c.text));
    const t = await call('/api', api, u, 'GET', '/tools/vm-tags/policy');
    assert.equal(t.status, 200);
    assert.equal(t.body.policy.updatedBy, null, `${u.username}: vm-tags`);
    assert.deepEqual(t.body.policy.requiredCategories, ['Owner']);
    const h = await call('/api', api, u, 'GET', '/tools/vm-hygiene/settings');
    assert.equal(h.body.settings.updatedBy, null, '형제 vm-hygiene 과 같은 규칙');
  }
  for (const u of [ADMIN, OPER]) {
    const c = await call('/api', api, u, 'GET', '/tools/cost-showback/settings');
    assert.equal(c.body.settings.updatedBy, 'adm', `${u.username}: 전체 범위는 그대로(v2.721 결정)`);
    const t = await call('/api', api, u, 'GET', '/tools/vm-tags/policy');
    assert.equal(t.body.policy.updatedBy, 'adm');
  }
});
