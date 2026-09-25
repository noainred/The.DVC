// v2.614 — 특수 기능 카탈로그 내보내기(scripts/tools-catalog.mjs) + 서버 리더(portalcheck/toolCatalog.js).
//
// 고정하는 것:
//  ① 생성물 web/public/special-tools.json == 원천 web/src/views/specialToolsList.js 의 **ESM import**(정규식 금지 —
//     v2.563 규약) — 계약 여섯 필드(k·adminOnly·perm·external·topTab·comingSoon)와 순서·개수. 이 단언은 CI 의
//     `--check`(continue-on-error)와 달리 **실패**다 — 카탈로그를 고치고 스크립트를 안 돌리면 여기서 막힌다.
//  ② 스크립트 `--check` 는 최신이면 0, 낡으면 1(generatedAt 만 다른 것은 낡음이 아니다) · 내용이 같으면 파일을 다시 쓰지 않는다.
//  ③ 리더는 파일이 없거나(not-found) · 손상(parse) · 모양이 틀리거나(shape) · 너무 크면(too-large) `source:'missing'` +
//     사유이고 **던지지 않는다**; 임시 webDist 에 정상 파일이 있으면 `source:'dist'` 와 원천이 같은 도구 목록.
//  ④ 스크립트와 리더의 계약 필드 목록이 같다(두 벌이 갈라지지 않게).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SCRIPT = path.join(ROOT, 'scripts/tools-catalog.mjs');
const SOURCE = path.join(ROOT, 'web/src/views/specialToolsList.js');
const GENERATED = path.join(ROOT, 'web/public/special-tools.json');

const { TOOLS } = await import(pathToFileURL(SOURCE).href);
const gen = await import(pathToFileURL(SCRIPT).href);
const { readToolCatalog, validateCatalog, CATALOG_FIELDS, CATALOG_MAX_BYTES, CATALOG_FILE } = await import('../src/portalcheck/toolCatalog.js');

const strOrNull = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
/** 테스트가 독립적으로 원천을 투사한다 — 스크립트의 projectTool 을 재사용하면 같은 결함을 두 번 통과시킨다. */
const expectTool = (t) => ({
  k: t.k, adminOnly: t.adminOnly === true, perm: strOrNull(t.perm), external: strOrNull(t.external),
  topTab: t.topTab === true, comingSoon: t.comingSoon === true,
});

function runScript(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'toolcat2614-'));
}

test('① 생성물 == 원천 ESM import(계약 필드·순서·개수)', () => {
  assert.ok(Array.isArray(TOOLS) && TOOLS.length > 0, '원천 TOOLS 가 비어 있다');
  const cat = JSON.parse(fs.readFileSync(GENERATED, 'utf8'));
  assert.equal(cat.count, TOOLS.length, 'count 가 원천 개수와 다르다');
  assert.equal(cat.tools.length, TOOLS.length);
  assert.deepEqual(cat.tools, TOOLS.map(expectTool), 'web/public/special-tools.json 이 낡았다 — node scripts/tools-catalog.mjs');
  // 계약 밖 필드(label·desc·icon·aka)는 실리지 않는다.
  for (const t of cat.tools) assert.deepEqual(Object.keys(t).sort(), [...CATALOG_FIELDS].sort());
  assert.ok(typeof cat.generatedAt === 'string' && Number.isFinite(Date.parse(cat.generatedAt)), 'generatedAt 이 ISO 시각이 아니다');
  // 원천의 k 는 유일하다(카탈로그 키가 권한 키라 중복이면 두 화면이 한 키를 다툰다).
  assert.equal(new Set(TOOLS.map((t) => t.k)).size, TOOLS.length);
});

test('④ 스크립트·리더의 계약 필드 목록이 같다', () => {
  assert.deepEqual([...gen.CATALOG_FIELDS], [...CATALOG_FIELDS]);
  assert.deepEqual(gen.projectTool(TOOLS[0]), expectTool(TOOLS[0]));
});

test('② --check: 최신이면 0 · generatedAt 만 다르면 0 · 내용이 낡으면 1 · 원천 오류면 파일을 쓰지 않고 1', () => {
  const r0 = runScript(['--check']);
  assert.equal(r0.status, 0, `--check 가 실패했다: ${r0.stderr}`);
  const d = tmpDir();
  try {
    const out = path.join(d, 'special-tools.json');
    // 같은 내용, 다른 시각 → 낡음 아님. 그리고 다시 생성해도 파일을 쓰지 않는다(generatedAt 유지).
    const cur = JSON.parse(fs.readFileSync(GENERATED, 'utf8'));
    fs.writeFileSync(out, JSON.stringify({ ...cur, generatedAt: '2000-01-01T00:00:00.000Z' }));
    assert.equal(runScript(['--check'], { TOOLS_CATALOG_OUT: out }).status, 0);
    const r1 = runScript([], { TOOLS_CATALOG_OUT: out });
    assert.equal(r1.status, 0);
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).generatedAt, '2000-01-01T00:00:00.000Z', '내용이 같은데 파일을 다시 썼다');
    // 도구 하나가 빠진 사본 → 낡음(1). 생성하면 다시 맞춘다(0).
    fs.writeFileSync(out, JSON.stringify({ ...cur, count: cur.count - 1, tools: cur.tools.slice(1) }));
    const r2 = runScript(['--check'], { TOOLS_CATALOG_OUT: out });
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /최신이 아닙니다/);
    assert.equal(runScript([], { TOOLS_CATALOG_OUT: out }).status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')).tools, cur.tools);
    // 파일이 없으면 --check 는 1, 생성은 만든다.
    fs.rmSync(out);
    assert.equal(runScript(['--check'], { TOOLS_CATALOG_OUT: out }).status, 1);
    assert.equal(runScript([], { TOOLS_CATALOG_OUT: out }).status, 0);
    assert.ok(fs.existsSync(out));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
  // 원천 검증(순수): 빈 k·중복 k·배열 아님은 던진다 — main 이 종료코드 1 로 만들고 파일을 쓰지 않는다.
  assert.throws(() => gen.buildCatalog([{ k: '' }]), /k 가 비어/);
  assert.throws(() => gen.buildCatalog([{ k: 'a' }, { k: 'a' }]), /두 번/);
  assert.throws(() => gen.buildCatalog({}), /배열/);
  assert.throws(() => gen.buildCatalog([]), /비어/);
});

test('③ 리더: 없음·손상·모양·크기 → missing + 사유(던지지 않음) / 정상 → dist', () => {
  const d = tmpDir();
  try {
    const file = path.join(d, CATALOG_FILE);
    // 없음
    let r = readToolCatalog({ dir: d });
    assert.equal(r.source, 'missing'); assert.equal(r.reason, 'not-found'); assert.deepEqual(r.tools, []); assert.equal(r.count, 0);
    assert.equal(r.generatedAt, null); assert.equal(r.path, file);
    // 디렉터리 자체가 없음
    r = readToolCatalog({ dir: path.join(d, 'nope') });
    assert.equal(r.source, 'missing'); assert.equal(r.reason, 'not-found');
    // 손상 JSON
    fs.writeFileSync(file, '{ "generatedAt": ');
    r = readToolCatalog({ dir: d });
    assert.equal(r.source, 'missing'); assert.equal(r.reason, 'parse'); assert.deepEqual(r.tools, []);
    // 모양 — tools 없음 / k 빈 원소 / 중복 k / count 불일치 / 배열 원소가 문자열
    for (const bad of [
      { generatedAt: 1, count: 0 },
      { tools: [{ k: '' }] },
      { tools: [{ k: 'a' }, { k: 'a' }] },
      { count: 5, tools: [{ k: 'a' }] },
      { tools: ['a'] },
      { tools: [] },
      [],
      null,
    ]) {
      fs.writeFileSync(file, JSON.stringify(bad));
      r = readToolCatalog({ dir: d });
      assert.equal(r.source, 'missing', JSON.stringify(bad)); assert.equal(r.reason, 'shape', JSON.stringify(bad));
    }
    // 너무 큼 — 상한 초과면 읽지도 않는다
    fs.writeFileSync(file, '{"tools":[' + '{"k":"x"},'.repeat(Math.ceil(CATALOG_MAX_BYTES / 9)) + '{"k":"y"}]}');
    assert.ok(fs.statSync(file).size > CATALOG_MAX_BYTES);
    r = readToolCatalog({ dir: d });
    assert.equal(r.source, 'missing'); assert.equal(r.reason, 'too-large');
    // 정상 — 생성물 사본. 계약 밖 필드는 새지 않고, 값 모양이 고정된다.
    const cur = JSON.parse(fs.readFileSync(GENERATED, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...cur, tools: cur.tools.map((t) => ({ ...t, desc: '화면 전용', secret: 'x' })) }));
    r = readToolCatalog({ dir: d });
    assert.equal(r.source, 'dist'); assert.equal(r.count, TOOLS.length); assert.equal(r.path, file);
    assert.deepEqual(r.tools, TOOLS.map(expectTool));
    assert.equal(r.generatedAt, Date.parse(cur.generatedAt));
    assert.ok(!('secret' in r.tools[0]) && !('desc' in r.tools[0]));
    // generatedAt: 숫자 문자열은 Date.parse 에 넘기지 않는다(연도 12345 함정) · 숫자는 epoch ms 그대로
    assert.equal(validateCatalog({ tools: [{ k: 'a' }], generatedAt: '12345' }).generatedAt, null);
    assert.equal(validateCatalog({ tools: [{ k: 'a' }], generatedAt: 1700000000000 }).generatedAt, 1700000000000);
    assert.equal(validateCatalog({ tools: [{ k: 'a' }] }).generatedAt, null);
    // perm/external 빈 문자열은 null, 공백은 다듬는다
    assert.deepEqual(validateCatalog({ tools: [{ k: ' a ', perm: '', external: ' x ', adminOnly: 'yes' }] }).tools[0],
      { k: 'a', adminOnly: false, perm: null, external: 'x', topTab: false, comingSoon: false });
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
  // dir 인자가 이상해도 던지지 않는다(기본 config.webDist 로 떨어진다).
  for (const dir of [null, 42, '', undefined]) {
    const r = readToolCatalog({ dir });
    assert.ok(r.source === 'dist' || r.source === 'missing');
    assert.ok(Array.isArray(r.tools));
  }
  assert.doesNotThrow(() => readToolCatalog());
  assert.doesNotThrow(() => readToolCatalog(null));
});
