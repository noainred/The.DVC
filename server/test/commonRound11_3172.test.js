/**
 * v3.17.2 — 2차 공통 기능 점검 1회차: 저장소 읽기의 '객체 JSON' 판정을 공용 `util/jsonObject.js` 하나로.
 *
 * 고정하는 것:
 *  ① parseJsonObject — 객체는 그대로 · null 은 {} · 배열 · 수 · 글자 · 참거짓은 SyntaxError(문구에 파일 내용 없음).
 *  ② 소스 스윕 — server/src 에 `JSON.parse(fs.readFileSync(...)) || {}` 가 되살아나지 않는다(자체 판정이 있는 두 곳만 예외).
 *  ③ 실제 저장소(IP 메모) — 파일이 `[]` 면 예전엔 정상으로 읽혀 메모를 '저장했다' 고 하고 배열 속성이라 직렬화되지 않아 사라졌다.
 *     이제 손상으로 보아 원본을 보존하고, 25회차 F-4 규약대로 확정 전 쓰기를 거절한다. config 싱글턴이라 자식 프로세스로 돌린다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseJsonObject } from '../src/util/jsonObject.js';
import { stripComments } from './_stripComments.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

test('① parseJsonObject — 객체 · null 만 통과, 나머지는 깨진 JSON 과 같이 던진다', () => {
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonObject('null'), {});
  for (const t of ['[]', '[1,2]', '5', '"live"', 'true', 'false', '0']) {
    assert.throws(() => parseJsonObject(t), (e) => e instanceof SyntaxError && /객체가 아닌 JSON/.test(e.message), t);
  }
  assert.throws(() => parseJsonObject('{"a":'), SyntaxError);
  // 문구에 파일 내용(따옴표 · 값)을 싣지 않는다.
  try { parseJsonObject('"SuperSecret"'); } catch (e) { assert.equal(e.message.includes('SuperSecret'), false); }
});

test('② 소스 스윕 — JSON.parse(fs.readFileSync(...)) || {} 가 되살아나지 않는다', () => {
  const ALLOW = new Set([
    'central/assignments.js', // 자체 판정(객체가 아니면 빈 결과) · 호출부가 따로 다룬다
    'gpu/settings.js',        // gpuGuestEnabledLight — 'enabled' 하나만 읽는 배지 경로(객체가 아니면 기본값)
  ]);
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        const rel = path.relative(SRC, p).split(path.sep).join('/');
        const src = stripComments(fs.readFileSync(p, 'utf8'));
        const n = (src.match(/JSON\.parse\(\s*fs\.readFileSync\([^;\n]*\)\)\s*\|\|\s*\{\}/g) || []).length;
        if (n && !(ALLOW.has(rel) && n === 1)) hits.push(`${rel} × ${n}`);
      }
    }
  };
  walk(SRC);
  assert.deepEqual(hits, [], `parseJsonObject(fs.readFileSync(...)) 를 쓸 것:\n${hits.join('\n')}`);
});

test('③ IP 메모 저장소 — 파일이 배열이면 손상으로 본다(원본 보존 · 쓰기 거절) — 예전엔 \'저장됐다\' 고 하고 사라졌다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jo3172-'));
  try {
    fs.writeFileSync(path.join(dir, 'ipam-annotations.json'), '[]');
    const mod = pathToFileURL(path.join(SRC, 'ipam/annotations.js')).href;
    const code = `const m = await import(${JSON.stringify(mod)}); const r = m.setAnnotation('10.0.0.5', { memo: 'm1', tags: ['t'] }, 'u'); console.log(JSON.stringify({ r, got: m.getAnnotation('10.0.0.5'), err: !!m.annotationsLoadError() }));`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const { r, err } = JSON.parse(out.trim().split('\n').pop());
    // 25회차 F-4(main): 못 읽은 메모 파일이면 쓰기를 거절한다 — 배열은 이제 '못 읽은 것' 이다.
    assert.equal(err, true, '배열 파일을 정상으로 읽었다');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'settings-unreadable');
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('ipam-annotations.json.corrupt.')).length, 1, '원본 보존');
    // '저장됐다' 고 답하고 배열 그대로 다시 쓰는 일(메모 유실)이 없다.
    assert.equal(fs.existsSync(path.join(dir, 'ipam-annotations.json')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
