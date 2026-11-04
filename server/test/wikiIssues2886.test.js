/**
 * wikiIssues2886.test.js — v2.886 C-4 · C-5: 첨부(위키 · 이슈) · 관리자 템플릿 · 대문 담당/당번 · 인라인 댓글.
 *
 * ① 순수 — 파일 이름 정리(경로 · 제어 문자 · 확장자 화이트리스트) · 그림 첫 바이트 판정 · tar 머리말 체크섬.
 * ② 실제 api 라우터(자식 프로세스): 첨부 — 범위(조회 밖 404 · 쓰기 밖 403) · 형식 · 크기 · 개수 · 전체 상한 · 내려받기 머리말(attachment · nosniff · sandbox)
 *    · 그림만 inline · 지우기는 올린 사람/전체 범위 관리자 · 주인을 지우면 첨부도 · 본체 없음 410 · 전체 내려받기(tar.gz) · 관리 화면 문지기.
 * ③ 관리자 템플릿 · 대문 담당/당번 · 인라인 댓글(인용 · 해결).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanName, imageMagicOk } from '../src/attach/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b10000000049454e44ae426082', 'hex');

test('① 파일 이름 · 그림 판정', () => {
  assert.deepEqual(cleanName('보고서.PDF'), { name: '보고서.PDF', ext: 'pdf' });
  assert.equal(cleanName('../../etc/passwd.txt').name, '.._.._etc_passwd.txt'.replace(/^\.+/, ''), '경로 구분자는 _ · 앞의 점은 뗀다');
  assert.equal(cleanName('a\u0000b\nc.log').name, 'abc.log');
  for (const bad of ['x.svg', 'x.html', 'x.js', 'noext', '.png', 'a.exe', '']) assert.throws(() => cleanName(bad), /받는 파일 형식/, bad);
  assert.equal(cleanName(`${'가'.repeat(300)}.png`).name.length, 120);
  assert.equal(imageMagicOk('png', PNG), true);
  assert.equal(imageMagicOk('png', Buffer.from('<svg onload=alert(1)>xxxxxxxx')), false);
  assert.equal(imageMagicOk('jpg', PNG), false, '확장자와 내용이 다르면 그림으로 그리지 않는다');
});

function run(body, { pre, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2886-'));
  if (pre) pre(dir);
  const script = `
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const st = await import(${JSON.stringify(path.join(SRC, 'issues/store.js'))});
    const wk = await import(${JSON.stringify(path.join(SRC, 'wiki/store.js'))});
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    let who = { username: 'adm', role: 'admin', scope: null };
    app.use((req, _res, next) => { req.user = who; next(); });
    app.use('/api', api);
    app.use((err, _req, res, _next) => { res.status(err.status || err.statusCode || 500).json({ ok: false, reason: String(err.message || err).slice(0, 200) }); });
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port + '/api';
    const as = (u) => { who = u; };
    const call = async (m, p, b) => {
      const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      let j = null; try { j = await r.json(); } catch {}
      return { s: r.status, j };
    };
    const up = async (p, name, buf) => {
      const r = await fetch(base + p + '?name=' + encodeURIComponent(name), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buf });
      let j = null; try { j = await r.json(); } catch {}
      return { s: r.status, j };
    };
    const raw = async (p) => { const r = await fetch(base + p); const b = Buffer.from(await r.arrayBuffer()); return { s: r.status, h: Object.fromEntries(r.headers), len: b.length, b64: b.length < 2_000_000 ? b.toString('base64') : '' }; };
    const ADM = { username: 'adm', role: 'admin', scope: null };
    const SA = { username: 'sa', role: 'operator', scope: { vcenters: ['vc-a'] } };
    const PNG = Buffer.from(${JSON.stringify(PNG.toString('hex'))}, 'hex');
    const out = {};
    ${body}
    st.flushIssuesNow(); wk.flushWikiNow();
    srv.close();
    console.log('@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true', ...env },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  return { out: JSON.parse(line.slice(2)), dir };
}

test('② 첨부 — 범위 · 형식 · 크기 · 개수 · 전체 상한 · 머리말 · 지우기 · 주인 삭제 · 본체 없음 · 전체 내려받기', () => {
  const { out, dir } = run(`
    const pa = (await call('POST', '/wiki/pages', { title: 'A 문서', spaceId: 'vc-a', body: 'a' })).j.page;
    const pb = (await call('POST', '/wiki/pages', { title: 'B 문서', spaceId: 'vc-b', body: 'b' })).j.page;
    const ia = (await call('POST', '/issues', { title: 'A 이슈', vcenterId: 'vc-a' })).j.issue;
    out.png = await up('/attach/wiki/' + pa.id, '화면.png', PNG);
    out.txt = await up('/attach/issue/' + ia.key, 'log.txt', Buffer.from('hello'));
    out.bFile = await up('/attach/wiki/' + pb.id, 'b-secret.txt', Buffer.from('b'));
    out.svg = await up('/attach/wiki/' + pa.id, 'x.svg', Buffer.from('<svg/>'));
    out.big = await up('/attach/wiki/' + pa.id, 'big.log', Buffer.alloc(8 * 1024 * 1024 + 10, 97));
    out.fakePng = await up('/attach/wiki/' + pa.id, 'fake.png', Buffer.from('<html><script>alert(1)</script></html>'));
    out.list = (await call('GET', '/attach/wiki/' + pa.id)).j;
    out.dlPng = await raw('/attach/file/' + out.png.j.item.id + '?inline=1');
    out.dlFake = await raw('/attach/file/' + out.fakePng.j.item.id + '?inline=1');
    out.dlTxt = await raw('/attach/file/' + out.txt.j.item.id);
    as(SA);
    out.saListB = await call('GET', '/attach/wiki/' + pb.id);
    out.saUpB = await up('/attach/wiki/' + pb.id, 'x.txt', Buffer.from('x'));
    as({ username: 'ro', role: 'operator', scope: { vcenters: ['vc-a'], writeVcenters: ['vc-z'] } });
    out.roList = await call('GET', '/attach/wiki/' + pa.id);
    out.roUp = await up('/attach/wiki/' + pa.id, 'x.txt', Buffer.from('x'));
    as(SA);
    out.saUpA = await up('/attach/wiki/' + pa.id, 'sa.txt', Buffer.from('sa'));
    out.saDelOther = await call('DELETE', '/attach/file/' + out.png.j.item.id);
    out.saDelOwn = await call('DELETE', '/attach/file/' + out.saUpA.j.item.id);
    out.saDlB = await raw('/attach/file/' + out.bFile.j.item.id);
    out.saDelB = await call('DELETE', '/attach/file/' + out.bFile.j.item.id);
    as({ username: 'vw', role: 'viewer', scope: null });
    out.viewerList = await call('GET', '/attach/wiki/' + pa.id);
    out.viewerUp = await up('/attach/wiki/' + pa.id, 'v.txt', Buffer.from('v'));
    out.viewerAdmin = await call('GET', '/attach/admin/usage');
    as(SA);
    out.saAdmin = await call('GET', '/attach/admin/usage');
    as(ADM);
    // 개수 상한 20
    let last = null;
    for (let i = 0; i < 20; i += 1) last = await up('/attach/issue/' + ia.key, 'n' + i + '.txt', Buffer.from('n'));
    out.count21 = last;
    // 전체 상한 1MB
    out.capSave = await call('PUT', '/attach/admin/settings', { maxTotalMB: 1 });
    out.capOver = await up('/attach/wiki/' + pb.id, 'm.log', Buffer.alloc(1024 * 1024, 98));
    out.capBad = await call('PUT', '/attach/admin/settings', { maxTotalMB: 0 });
    out.usage = (await call('GET', '/attach/admin/usage')).j;
    // 전체 내려받기
    out.archive = await raw('/attach/admin/archive');
    // 본체 없음 → 410 · 목록 missing
    const fsx = await import('node:fs');
    fsx.unlinkSync(process.env.CONFIG_DIR + '/attachments/' + out.txt.j.item.id);
    out.gone = await raw('/attach/file/' + out.txt.j.item.id);
    // 주인 삭제 → 첨부도
    out.delPage = await call('DELETE', '/wiki/pages/' + pa.id);
    out.afterDel = await raw('/attach/file/' + out.png.j.item.id);
    out.ids = { png: out.png.j?.item?.id };
  `);
  assert.equal(out.png.s, 200); assert.equal(out.png.j.item.image, true);
  assert.equal(out.txt.s, 200);
  assert.equal(out.svg.s, 400, 'svg 는 받지 않는다');
  assert.equal(out.big.s, 413, '8MB 넘으면 413');
  assert.equal(out.fakePng.s, 200); assert.equal(out.fakePng.j.item.image, false, '내용이 png 가 아니면 그림이 아니다');
  assert.equal(out.list.items.length, 2); assert.equal(out.list.canUpload, true);
  assert.equal(out.dlPng.s, 200); assert.equal(out.dlPng.h['content-type'], 'image/png'); assert.match(out.dlPng.h['content-disposition'], /^inline/);
  assert.match(out.dlFake.h['content-disposition'], /^attachment/, '가짜 그림은 inline 으로 주지 않는다');
  assert.equal(out.dlTxt.h['x-content-type-options'], 'nosniff'); assert.match(out.dlTxt.h['content-security-policy'], /sandbox/);
  assert.match(out.dlTxt.h['content-disposition'], /^attachment; filename="log.txt"; filename\*=UTF-8''log.txt/);
  assert.equal(Buffer.from(out.dlTxt.b64, 'base64').toString(), 'hello');
  assert.equal(out.saListB.s, 404, '조회 밖 문서의 첨부는 404');
  assert.equal(out.saUpB.s, 404, '조회 밖 문서에 올리기도 404');
  assert.equal(out.saDlB.s, 404, '범위 밖 첨부를 id 로 직접 받아도 404(존재 은닉)');
  assert.equal(out.saDelB.s, 404, '범위 밖 첨부 지우기도 404');
  assert.equal(out.roList.s, 200); assert.equal(out.roList.j.canUpload, false, '쓰기 범위 밖이면 올리기 단추를 잠근다');
  assert.equal(out.roUp.s, 403, '조회는 되지만 쓰기 밖이면 403');
  assert.equal(out.saUpA.s, 200);
  assert.equal(out.saDelOther.s, 403, '남이 올린 첨부는 지우지 못한다');
  assert.equal(out.saDelOwn.s, 200);
  assert.equal(out.viewerList.s, 200, 'viewer 는 볼 수 있다');
  assert.equal(out.viewerUp.s, 403, 'viewer 는 올리지 못한다');
  assert.equal(out.viewerAdmin.s, 403); assert.equal(out.saAdmin.s, 403, '관리 화면은 관리자 + 전체 범위');
  assert.equal(out.count21.s, 409, '이슈마다 20개'); assert.match(out.count21.j.reason, /20개/);
  assert.equal(out.capSave.s, 200); assert.equal(out.capOver.s, 409); assert.equal(out.capOver.j.code, 'attach-full');
  assert.equal(out.capBad.s, 400);
  assert.equal(out.usage.usage.maxTotalMB, 1);
  assert.equal(out.archive.s, 200); assert.match(out.archive.h['content-disposition'], /portal-attachments-.*\.tar\.gz/);
  const tar = zlib.gunzipSync(Buffer.from(out.archive.b64, 'base64'));
  assert.equal(tar.subarray(0, 10).toString(), 'index.json');
  assert.equal(tar.subarray(257, 262).toString(), 'ustar');
  const sumField = parseInt(tar.subarray(148, 154).toString(), 8);
  const h = Buffer.from(tar.subarray(0, 512)); h.fill(0x20, 148, 156);
  assert.equal(sumField, h.reduce((a, b) => a + b, 0), 'tar 머리말 체크섬');
  const idx = JSON.parse(tar.subarray(512, 512 + parseInt(tar.subarray(124, 135).toString(), 8)).toString());
  assert.ok(idx.items.some((x) => x.name === '화면.png'), '원래 이름은 목록에');
  assert.equal(out.gone.s, 410, '본체가 없으면 410(조용히 깨진 파일을 주지 않는다)');
  assert.equal(out.delPage.s, 200);
  assert.equal(out.afterDel.s, 404, '문서를 지우면 첨부도 지운다');
  assert.equal(fs.existsSync(path.join(dir, 'attachments', out.ids.png)), false, '본체 파일도 지운다');
});

test('③ 관리자 템플릿 · 대문 담당/당번 · 인라인 댓글', () => {
  const H = 3600_000;
  const today = new Date(Math.floor(Date.now() / H) * H + 9 * H).toISOString().slice(0, 10); // 포탈 날짜(KST 기본)
  const { out } = run(`
    out.tplNew = await call('POST', '/wiki/templates', { name: '점검 기록', tag: '점검', body: '# 점검\\n\\n- [ ] 항목' });
    out.tplBad = await call('POST', '/wiki/templates', { name: '', body: 'x' });
    out.meta = (await call('GET', '/wiki/meta')).j.templates;
    out.tplGet = await call('GET', '/wiki/templates/' + out.tplNew.j.template.id);
    as(SA);
    out.tplSa = await call('POST', '/wiki/templates', { name: 'x', body: 'y' });
    as(ADM);
    out.tplDel = await call('DELETE', '/wiki/templates/' + out.tplNew.j.template.id);
    out.space = await call('PUT', '/wiki/spaces/pub', { owners: ['kim', 'lee'], oncall: [{ who: 'kim', from: '${today}', to: '${today}', note: '야간' }, { who: 'lee', from: '2999-01-01', to: '2999-01-07' }] });
    out.spaceBad = await call('PUT', '/wiki/spaces/pub', { oncall: [{ who: 'kim', from: '2026-11-09', to: '2026-11-01' }] });
    out.home = (await call('GET', '/wiki/home?space=pub')).j;
    const p = (await call('POST', '/wiki/pages', { title: '문서', spaceId: 'pub', body: '첫 문단 내용입니다' })).j.page;
    out.c1 = await call('POST', '/wiki/pages/' + p.id + '/comments', { body: '여기 확인', quote: '첫 문단' });
    out.cLong = await call('POST', '/wiki/pages/' + p.id + '/comments', { body: 'x', quote: 'q'.repeat(201) });
    out.resolve = await call('POST', '/wiki/pages/' + p.id + '/comments/' + out.c1.j.comment.id + '/resolve', { on: true });
    as({ username: 'vw', role: 'viewer', scope: null });
    out.vwResolve = await call('POST', '/wiki/pages/' + p.id + '/comments/' + out.c1.j.comment.id + '/resolve', { on: false });
    as(ADM);
    out.page = (await call('GET', '/wiki/pages/' + p.id)).j.page;
  `);
  assert.equal(out.tplNew.s, 200); assert.match(out.tplNew.j.template.id, /^c[a-f0-9]{10}$/);
  assert.equal(out.tplBad.s, 400);
  assert.ok(out.meta.some((t) => t.name === '점검 기록' && t.custom), '새 문서 템플릿 목록에 붙는다');
  assert.equal(out.tplGet.j.template.body, '# 점검\n\n- [ ] 항목');
  assert.equal(out.tplSa.s, 403, '관리자 템플릿은 관리자 + 전체 범위');
  assert.equal(out.tplDel.s, 200);
  assert.equal(out.space.s, 200);
  assert.equal(out.spaceBad.s, 400, '끝이 시작보다 앞이면 400');
  assert.deepEqual(out.home.space.owners, ['kim', 'lee']);
  assert.deepEqual(out.home.oncallNow.map((o) => o.who), ['kim'], '오늘(포탈 날짜) 당번');
  assert.deepEqual(out.home.oncallNext.map((o) => o.who), ['lee']);
  assert.equal(out.c1.s, 200); assert.equal(out.c1.j.comment.quote, '첫 문단');
  assert.equal(out.cLong.s, 400);
  assert.equal(out.resolve.s, 200); assert.equal(out.resolve.j.comment.resolved, true);
  assert.equal(out.vwResolve.s, 403, '해결 표시는 쓴 사람 · 쓰기 역할');
  assert.equal(out.page.comments[0].resolvedBy, 'adm');
});
