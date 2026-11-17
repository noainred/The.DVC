/**
 * contentApiAudit67.test.js — 전체 점검 67회차(외부 API · 사용자 콘텐츠 1차: 공개 API · LLM · 첨부 · 이슈 · 위키) 확정분 회귀.
 *
 * F1 위키 사용자 상태(즐겨찾기 · 최근 본 문서) 표가 `{}` 라 로컬 계정 ID 규칙이 받는 'constructor' · 'toString' · '__proto__' 계정의
 *    문서 열기 · 대문 · 즐겨찾기가 TypeError(500)였다.
 * F2 GET /issues/versions 의 버전 → 개수 표가 `{}` 라 VERSION_RE 가 받는 'constructor' · 'toString' 버전이 응답에서 빠지고
 *    전역 Object 함수 · Object.prototype.toString 에 total · open 칸이 붙었다.
 * F3 OpenAPI 가 `/san-storage/arrays` · `/san-storage/check` 의 data 를 객체 하나로 선언했다(실제 응답은 배열) — 목록 여부를 필드 이름으로 추측했다.
 * F4 Ollama 오프라인 설치가 검증은 zstd(.tar.zst)를 받고 압축 해제는 `tar -xzf`(gzip 강제)라 zstd 파일은 언제나 실패했다.
 * 개선 LLM 설정 저장의 형식 검사(enabled 는 불리언 · 모델 이름) · 받을 모델 이름 정리(앞 '-' 제거 · 받은 이름 = 저장 이름).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const deployMod = await import('../src/llm/ollamaDeploy.js');   // 순수 함수(ollamaExtractCmd)만 쓴다 — 파일을 쓰지 않는다

/** 라우트 묶음(api.js)을 띄우고 body 를 돌린다 — CONFIG_DIR 은 매번 새 임시 폴더(설정 · 위키 · 이슈 파일이 섞이지 않게). */
function run(body, { env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c67-'));
  const script = `
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const st = await import(${JSON.stringify(path.join(SRC, 'issues/store.js'))});
    const wk = await import(${JSON.stringify(path.join(SRC, 'wiki/store.js'))});
    const us = await import(${JSON.stringify(path.join(SRC, 'wiki/userState.js'))});
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
    const ADM = { username: 'adm', role: 'admin', scope: null };
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
  assert.ok(line, `결과 줄 없음: ${r.stdout.slice(-400)} ${r.stderr.slice(-400)}`);
  return JSON.parse(line.slice(2));
}

test('F1 — Object.prototype 이름의 계정도 위키 문서 열기 · 대문 · 즐겨찾기가 된다(500 아님) · 프로토타입 오염 없음 · 저장 왕복', () => {
  const out = run(`
    as(ADM);
    const pg = await call('POST', '/wiki/pages', { spaceId: 'pub', title: '공용 문서', body: '본문' });
    out.created = pg.s;
    for (const name of ['constructor', 'toString', '__proto__', 'valueOf']) {
      as({ username: name, role: 'operator', scope: null });
      const v = await call('GET', '/wiki/pages/' + pg.j.page.id);
      const f = await call('POST', '/wiki/pages/' + pg.j.page.id + '/fav', { on: true });
      const h = await call('GET', '/wiki/home');
      (out.users ||= []).push({ name, view: v.s, fav: f.s, home: h.s, favIds: (h.j?.mine?.fav || []).map((x) => x.id), recentIds: (h.j?.mine?.recent || []).map((x) => x.id) });
    }
    out.protoClean = ({}).recent === undefined && ({}).fav === undefined && ({}).today === undefined;
    // 저장 → 캐시 비움 → 다시 읽기(파일의 '__proto__' 키가 프로토타입을 바꾸지 않고 자기 칸으로 돌아오는가)
    await us.flushWikiUserNow();
    us._resetWikiUserCache();
    out.reload = { proto: us.userLists('__proto__'), ctor: us.userLists('constructor'), other: us.userLists('nobody') };
    out.protoClean2 = ({}).fav === undefined;
  `);
  assert.equal(out.created, 200);
  // 결과는 배열로 받는다 — 객체 칸 이름이 '__proto__' 면 시험 쪽 out 도 같은 함정에 빠진다
  assert.deepEqual(out.users.map((u) => u.name), ['constructor', 'toString', '__proto__', 'valueOf']);
  for (const u of out.users) {
    assert.deepEqual({ view: u.view, fav: u.fav, home: u.home }, { view: 200, fav: 200, home: 200 },
      `${u.name}: 수정 전 GET /wiki/pages · POST fav · GET /wiki/home 이 500(TypeError)`);
    assert.deepEqual(u.favIds, ['W1']);
    assert.deepEqual(u.recentIds, ['W1']);
  }
  assert.equal(out.protoClean, true);
  assert.deepEqual(out.reload.proto.fav, ['W1'], '파일에서 다시 읽어도 __proto__ 계정의 즐겨찾기가 남는다');
  assert.deepEqual(out.reload.ctor.fav, ['W1']);
  assert.deepEqual(out.reload.other, { fav: [], recent: [] }, '다른 계정이 __proto__ 칸을 물려받지 않는다');
  assert.equal(out.protoClean2, true);
});

test('F2 — /issues/versions 는 constructor · toString 버전도 세고 전역 Object 함수에 칸을 붙이지 않는다', () => {
  const out = run(`
    as(ADM);
    for (const v of ['constructor', 'toString', 'constructor', '2.900.0']) {
      const r = await call('POST', '/issues', { title: '버전 ' + v, type: 'task', fixVersion: v });
      if (r.s !== 200) out.createFail = r;
    }
    const r = await call('GET', '/issues/versions');
    out.s = r.s; out.fix = r.j?.fix;
    out.globalsClean = Object.total === undefined && Object.open === undefined && Object.prototype.toString.total === undefined;
  `);
  assert.equal(out.createFail, undefined, JSON.stringify(out.createFail));
  assert.equal(out.s, 200);
  assert.deepEqual(out.fix, {
    constructor: { total: 2, open: 2 }, toString: { total: 1, open: 1 }, '2.900.0': { total: 1, open: 1 },
  }, '수정 전: constructor · toString 이 응답에서 빠졌다');
  assert.equal(out.globalsClean, true, '수정 전: Object.total · Object.prototype.toString.total 이 NaN 으로 붙었다');
});

test('F3 — 공개 API 목록 여부(list)는 모든 경로에 명시돼 있고 OpenAPI 스키마 · 핸들러(project/projectAll)와 일치한다', async () => {
  const { ENDPOINTS, GROUP_KEYS } = await import('../src/publicapi/allowlist.js');
  const { buildOpenApi } = await import('../src/publicapi/openapi.js');
  const doc = buildOpenApi({ groups: [...GROUP_KEYS] });
  const src = stripComments(fs.readFileSync(path.join(SRC, 'routes/publicApi.js'), 'utf8'));
  for (const ep of ENDPOINTS) {
    assert.equal(typeof ep.list, 'boolean', `${ep.path}: list 선언 없음`);
    const schema = doc.paths[ep.path].get.responses[200].content['application/json'].schema.properties.data;
    assert.equal(schema.type, ep.list ? 'array' : 'object', `${ep.path}: OpenAPI data 형태`);
    const start = src.indexOf(`v1.get('${ep.path}'`);
    assert.ok(start >= 0, `${ep.path}: 핸들러 없음`);
    const next = src.indexOf('v1.get(', start + 10);
    const block = src.slice(start, next < 0 ? undefined : next);
    const usesAll = /projectAll\(/.test(block);
    const usesOne = /\bproject\(/.test(block);
    assert.equal(usesAll, ep.list, `${ep.path}: 핸들러가 ${usesAll ? 'projectAll' : 'project'} 인데 list=${ep.list}`);
    assert.equal(usesOne, !ep.list, `${ep.path}: 단건/목록 투사가 섞였다`);
  }
  for (const p of ['/san-storage/arrays', '/san-storage/check']) {
    assert.equal(doc.paths[p].get.responses[200].content['application/json'].schema.properties.data.type, 'array', `${p}: 수정 전 object`);
  }
});

test('F4 — Ollama 오프라인 압축 해제 명령은 gzip · zstd 둘 다 푼다(tar 자동 판별) · 경로 형식 밖은 던진다', (t) => {
  const { ollamaExtractCmd } = deployMod;
  const cmd = ollamaExtractCmd('/tmp/ollama-install.AbCdEf1234/ollama.tgz');
  assert.equal(cmd, 'tar -C /usr -xf /tmp/ollama-install.AbCdEf1234/ollama.tgz');
  assert.doesNotMatch(cmd, /-x?z/, 'gzip 을 강제하지 않는다(수정 전 -xzf)');
  assert.throws(() => ollamaExtractCmd('/tmp/x; rm -rf /'), /형식/);
  assert.throws(() => ollamaExtractCmd('relative.tgz'), /형식/);

  // 실제 tar 로 푼다 — 같은 내용을 gzip · zstd 로 싸서 '.tgz' 이름으로 둔다(원격 파일 이름이 늘 ollama.tgz 이다).
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'c67-tar-'));
  fs.mkdirSync(path.join(work, 'src/bin'), { recursive: true });
  fs.writeFileSync(path.join(work, 'src/bin/ollama'), 'hello');
  const mk = spawnSync('tar', ['-C', path.join(work, 'src'), '-cf', path.join(work, 'plain.tar'), 'bin']);
  assert.equal(mk.status, 0, String(mk.stderr));
  const plain = fs.readFileSync(path.join(work, 'plain.tar'));
  const cases = [['gz', zlib.gzipSync(plain)]];
  if (typeof zlib.zstdCompressSync === 'function') cases.push(['zst', zlib.zstdCompressSync(plain)]);
  else t.diagnostic('이 Node 에는 zlib zstd 가 없어 zstd 경우는 명령 형태만 확인했다');
  // tar 가 부르는 'zstd -d' 대역(이 컨테이너 · CI 에 zstd 실행 파일이 없을 수 있다) — 표준 입력을 풀어 표준 출력으로.
  const fakeBin = path.join(work, 'fakebin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'zstd'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e "const z=require('zlib');const c=[];process.stdin.on('data',d=>c.push(d)).on('end',()=>process.stdout.write(z.zstdDecompressSync(Buffer.concat(c))))"\n`, { mode: 0o755 });
  for (const [kind, buf] of cases) {
    const arc = path.join(work, `${kind}-ollama.tgz`);
    fs.writeFileSync(arc, buf);
    const dest = path.join(work, `out-${kind}`);
    fs.mkdirSync(dest);
    const r = spawnSync('/bin/sh', ['-c', ollamaExtractCmd(arc, dest)], { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` }, encoding: 'utf8' });
    assert.equal(r.status, 0, `${kind}: ${r.stderr}`);
    assert.equal(fs.readFileSync(path.join(dest, 'bin/ollama'), 'utf8'), 'hello', `${kind}: 풀린 내용`);
  }
});

test('개선 — LLM 설정 저장은 enabled 불리언 · 모델 이름 형식을 본다 · 받을 모델 이름 정리', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c67-llm-'));
  const script = `
    const m = await import(${JSON.stringify(path.join(SRC, 'llm/config.js'))});
    const d = await import(${JSON.stringify(path.join(SRC, 'llm/ollamaDeploy.js'))});
    const out = {};
    const tryS = (p) => { try { const c = m.saveLlmConfig(p); return { ok: true, enabled: c.enabled, model: c.model }; } catch (e) { return { ok: false, status: e.status }; } };
    out.strEnabled = tryS({ enabled: 'false' });
    out.numEnabled = tryS({ enabled: 1 });
    out.spaceModel = tryS({ model: 'llama 3' });
    out.emptyModel = tryS({ model: '' });
    out.objModel = tryS({ model: { a: 1 } });
    out.good = tryS({ enabled: true, model: ' llama3.1:8b ' });
    out.after = m.loadLlmConfig().enabled;
    out.names = [d.ollamaModelName('--insecure'), d.ollamaModelName('llama3.1:8b'), d.ollamaModelName({ x: 1 }), d.ollamaModelName('qwen2.5; rm -rf /')];
    console.log('@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, LLM_ENABLED: '' }, encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 60_000,
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('@@')).slice(2));
  assert.deepEqual(out.strEnabled, { ok: false, status: 400 }, '수정 전: 문자열 "false" 가 저장돼 자연어 검색은 켜짐 · 설정 현황은 꺼짐으로 갈렸다');
  assert.deepEqual(out.numEnabled, { ok: false, status: 400 });
  assert.deepEqual(out.spaceModel, { ok: false, status: 400 });
  assert.deepEqual(out.emptyModel, { ok: false, status: 400 });
  assert.deepEqual(out.objModel, { ok: false, status: 400 });
  assert.deepEqual(out.good, { ok: true, enabled: true, model: 'llama3.1:8b' });
  assert.equal(out.after, true);
  assert.deepEqual(out.names, ['insecure', 'llama3.1:8b', '', 'qwen2.5rm-rf/']);
});

test('개선 — 자연어 검색은 LLM 이 준 음수 limit 로 뒤에서 자르지 않는다(가짜 Ollama 왕복)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c67-nl-'));
  const script = `
    const http = await import('node:http');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const srv = http.createServer((req, res) => {
      let b = ''; req.on('data', (d) => { b += d; }).on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ response: JSON.stringify({ entity: 'vm', filters: [], match: 'all', limit: -2 }) }));
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    fs.writeFileSync(path.join(process.env.CONFIG_DIR, 'llm.json'), JSON.stringify({ enabled: true, url: 'http://127.0.0.1:' + srv.address().port, model: 'm', timeoutMs: 5000 }));
    const { store } = await import(${JSON.stringify(path.join(SRC, 'store.js'))});
    const nl = await import(${JSON.stringify(path.join(SRC, 'llm/nlSearch.js'))});
    const vms = [1, 2, 3, 4, 5].map((i) => ({ id: 'v' + i, name: 'vm-' + i, vcenterId: 'vc-a', powerState: 'POWERED_ON' }));
    store.get = () => ({ generatedAt: new Date(0).toISOString(), vcenters: [{ id: 'vc-a' }], hosts: [], vms, datastores: [], networks: [], alarms: [] });
    const r = await nl.nlSearch('vm 목록');
    srv.close();
    console.log('@@' + JSON.stringify({ source: r.source, llmError: r.llmError || null, total: r.total, shown: r.results.length, summary: r.summary, limits: [-5, 0, 'x', 7.9, 9999].map(nl.nlResultLimit) }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock' }, encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 60_000,
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('@@')).slice(2));
  assert.equal(out.source, 'llm', `LLM 경로를 타야 한다: ${out.llmError}`);
  assert.equal(out.total, 5);
  assert.equal(out.shown, 5, '수정 전: limit -2 → slice(0,-2) 로 3개만(뒤 2개를 뺐다)');
  assert.doesNotMatch(out.summary, /상위/);
  assert.deepEqual(out.limits, [100, 100, 100, 7, 500]);
});
