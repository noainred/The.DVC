/**
 * 공개 API 안내 페이지(`/api/docs`) 회귀 — v2.564.
 *
 * 사용자 요청: "로그인 없이 볼 수 있는 페이지를 하나 만들어서 API 를 찾아서 사용할 수 있는
 * 페이지 만들어줘, 사용 예시와 샘플을 같이 제공하는 기능".
 *
 * ⚠⚠ 이 테스트가 지키는 것은 **하나다 — 무인증으로 나가는 것이 문서뿐인가.**
 * 그래서 소스 grep 이 아니라 **실제 express 에 마운트해 상태코드·본문으로** 본다
 * (v2.506 이 grep 으로 만족했다가 미들웨어 순서 변경을 놓친 전례).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const REPO = path.join(HERE, '..', '..');

const { publicDocsRouter } = await import('../src/routes/publicDocs.js');
const { ENDPOINTS, GROUPS } = await import('../src/publicapi/allowlist.js');
const { SAMPLES, sampleFor } = await import('../src/publicapi/samples.js');
const { docsEnabled, _resetDocsSettingsCache } = await import('../src/publicapi/docsSettings.js');
const mockGen = await import('../src/mock/generator.js');

function appWith() {
  const app = express();
  app.use('/api/docs', publicDocsRouter);
  return app;
}

async function call(app, url = '/api/docs/', headers = {}) {
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { headers });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 본문이 JSON 이 아닐 수 있다 */ }
    return { status: res.status, headers: res.headers, text, json };
  } finally {
    srv.close();
  }
}

test('무인증으로 200 이고 카탈로그·샘플·예시가 실린다', async () => {
  const r = await call(appWith());
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.apiVersion, 'v1');
  assert.equal(r.json.endpoints.length, ENDPOINTS.length);
  assert.equal(r.json.groups.length, GROUPS.length);
  for (const e of r.json.endpoints) {
    assert.ok(e.sample, `${e.path} 샘플 없음`);
    assert.ok(e.examples.length >= 3, `${e.path} 예시 부족`);
  }
  // 키별 범위가 다른 데이터가 아니지만, 끄고 켜는 스위치가 있으므로 중간 캐시를 막는다.
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('공개하는 것은 조회 전용뿐 — method 가 전부 GET 이다', async () => {
  const r = await call(appWith());
  for (const e of r.json.endpoints) assert.equal(e.method, 'GET', `${e.path} 가 GET 이 아니다`);
});

test('⚠ 운영 데이터가 한 바이트도 실리지 않는다 — 소스가 스냅샷·DB·등록부를 import 하지 않는다', () => {
  const src = fs.readFileSync(path.join(SRC, 'routes', 'publicDocs.js'), 'utf8');
  // 주석을 먼저 제거한다 — 규칙을 설명하는 주석이 통과 근거가 되면 안 된다(v2.535 규약).
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  const ALLOWED = new Set([
    'express',
    '../publicapi/allowlist.js', '../publicapi/openapi.js',
    '../publicapi/samples.js', '../publicapi/keys.js', '../publicapi/docsSettings.js',
  ]);
  for (const i of imports) {
    assert.ok(ALLOWED.has(i), `publicDocs.js 가 예상 밖 모듈을 import 한다: ${i}`);
  }
  // 스냅샷 접근의 흔적도 없어야 한다.
  assert.ok(!/store\.get\(|listInventory|loadRegistry|openDb|getDb\(/.test(code),
    'publicDocs.js 에 스냅샷·DB 접근 흔적이 있다');
});

test('샘플의 필드 집합은 allowlist 의 선언과 정확히 같다 (투사 계약)', () => {
  for (const ep of ENDPOINTS) {
    const s = sampleFor(ep.path);
    assert.ok(s, `${ep.path} 샘플 없음`);
    const rows = Array.isArray(s.data) ? s.data : [s.data];
    for (const row of rows) {
      if (row == null || typeof row !== 'object') continue;
      const keys = Object.keys(row).sort();
      assert.deepEqual(keys, [...ep.fields].sort(),
        `${ep.path} 샘플 키가 선언 fields 와 다르다`);
    }
  }
});

test('샘플이 정직성 계약을 보여준다 — null 과 0 을 섞지 않는다', () => {
  // 이 API 의 계약은 "읽지 못한 값은 null" 이다. 샘플이 전부 값으로 차 있으면
  // 연동하는 쪽이 null 을 만날 준비를 하지 않는다 — 그래서 일부러 null 을 넣어 둔다.
  const json = JSON.stringify(SAMPLES);
  assert.ok(json.includes(':null'), '샘플 어디에도 null 이 없다 — null 계약을 보여주지 못한다');
});

test('샘플에 실제 운영/목 식별자를 넣지 않는다 (합성값)', async () => {
  const r = await call(appWith());
  const body = r.text;
  /*
   * ⚠ 이 검사의 기준은 두 가지다.
   * ① **목 생성기(`mock/generator.js`)가 만드는 id·이름이 하나도 없어야 한다** — 있으면
   *    이 라우트가 스냅샷을 읽고 있다는 뜻이다(문서만 나가야 한다).
   * ② **샘플의 식별자는 전부 `demo` 표식을 단다** — 그래야 연동 담당자가 화면의 값을
   *    '이 포탈의 실제 장비' 로 오해하지 않는다. 표식 없는 그럴듯한 이름을 넣지 말 것.
   */
  const { SITES, EXAMPLE_SITES } = mockGen;
  for (const s of [...(SITES || []), ...(EXAMPLE_SITES || [])]) {
    assert.ok(!body.includes(s.id), `무인증 응답에 목 vCenter id ${s.id} 가 있다`);
    assert.ok(!body.includes(s.name), `무인증 응답에 목 vCenter 이름 ${s.name} 이 있다`);
  }
  for (const ep of ENDPOINTS) {
    const rows = sampleFor(ep.path).data;
    for (const row of (Array.isArray(rows) ? rows : [rows])) {
      /*
       * ⚠ `name` 을 넣지 말 것 — `/faults/alarms` 의 name 은 **vSphere 알람 정의 이름**
       *   ('Host connection and power state')이라 이 현장의 식별자가 아니고, 실제 응답에서도
       *   그 문자열이 그대로 온다. 검사 대상은 **이 사이트의 대상을 가리키는 키**뿐이다.
       */
      for (const k of ['id', 'vcenterId', 'entity', 'device', 'deviceKey']) {
        const v = row?.[k];
        if (typeof v !== 'string' || v === '') continue;
        assert.match(v, /demo/i, `${ep.path} 샘플의 ${k}='${v}' 에 demo 표식이 없다`);
      }
    }
  }
  for (const vc of sampleFor('/inventory/vcenters').data) {
    assert.match(vc.name, /demo/i, `vCenter 샘플 이름 '${vc.name}' 에 demo 표식이 없다`);
  }
  assert.equal(r.json.disclosure.samplesAreSynthetic, true);
});

test('예시 코드에 실제 키를 넣지 않는다 — 자리표시자만', async () => {
  const r = await call(appWith());
  for (const e of r.json.endpoints) {
    for (const ex of e.examples) {
      assert.ok(ex.code.includes('<발급받은 키>') || ex.code.includes('DVC_API_KEY'),
        `${e.path}/${ex.lang} 예시에 키 자리표시자가 없다`);
      // 40자 이상 이어지는 base64url 조각 = 진짜 키처럼 보이는 값
      assert.ok(!/[A-Za-z0-9_-]{40,}/.test(ex.code), `${e.path}/${ex.lang} 예시에 키처럼 보이는 값이 있다`);
    }
  }
});

test('오류 코드표는 서버가 실제로 내는 코드와 1:1 이다', () => {
  const src = fs.readFileSync(path.join(SRC, 'routes', 'publicDocs.js'), 'utf8');
  const documented = new Set([...src.matchAll(/\{ status: \d+, code: '([a-z-]+)'/g)].map((m) => m[1]));
  const emitted = new Set();
  for (const f of ['publicapi/auth.js', 'publicapi/allowlist.js', 'routes/publicApi.js']) {
    const t = fs.readFileSync(path.join(SRC, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of t.matchAll(/code:\s*'([a-z-]+)'/g)) emitted.add(m[1]);
  }
  // 한쪽만 늘면 화면이 모르는 코드를 그대로 보여주거나, 없는 코드를 안내한다.
  assert.deepEqual([...emitted].sort(), [...documented].sort());
});

test('끄면 404 다 — 403 이 아니다(존재를 알려주지 않는다)', async () => {
  const prev = process.env.PUBLIC_API_DOCS;
  process.env.PUBLIC_API_DOCS = 'false';
  _resetDocsSettingsCache();
  try {
    assert.equal(docsEnabled(), false);
    const r = await call(appWith());
    assert.equal(r.status, 404);
    // 404 본문에도 카탈로그가 남으면 안 된다.
    assert.ok(!r.text.includes('/inventory/'), '404 본문에 경로 목록이 있다');
  } finally {
    if (prev === undefined) delete process.env.PUBLIC_API_DOCS; else process.env.PUBLIC_API_DOCS = prev;
    _resetDocsSettingsCache();
  }
});

test('env 는 끄는 쪽으로만 우선한다 — 켜는 쪽으로 되살리지 않는다', async () => {
  const src = fs.readFileSync(path.join(SRC, 'publicapi', 'docsSettings.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // 'true' 로 강제 켜는 분기가 있으면 관리자가 끈 결정이 조용히 뒤집힌다.
  assert.ok(!/===\s*'true'\s*\)\s*return true/.test(src), 'env 가 강제로 켜는 분기가 있다');
  assert.ok(/'false'\)\s*return false/.test(src.replace(/\s+/g, ' ').replace(/ \)/g, ')')),
    "env 'false' 강제 끄기 분기가 없다");
});

test('요청 Host 를 그대로 되비추지 않는다 (제어문자·주입 문자 제거)', async () => {
  const r = await call(appWith(), '/api/docs/', { Host: 'evil"><script>x</script>.example' });
  assert.ok(!r.text.includes('<script>'), 'Host 의 주입 문자가 응답에 그대로 있다');
  assert.ok(!r.text.includes('"><'), 'Host 의 따옴표가 그대로 있다');
});

test('상태 파일이 .gitignore 로 차단된다 (공개 저장소)', () => {
  const out = execFileSync('git', ['check-ignore', 'server/config/public-api-docs.json'],
    { cwd: REPO, encoding: 'utf8' }).trim();
  assert.ok(out.length > 0, 'public-api-docs.json 이 .gitignore 에 없다');
});
