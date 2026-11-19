/**
 * v3.24.1 — 손상 보존본 이름이 같은 밀리초에 겹쳐 앞 보존본을 덮어쓰던 결함(util/atomicWrite.js corruptBackupPath).
 *   예전 `${file}.corrupt.${Date.now()}` 는 같은 밀리초의 두 번째 보존이 renameSync 로 첫 보존본을 지웠다 —
 *   빠른 CI 러너에서 rebut105a A4('새 손상본도 옮긴다 1 !== 2')가 실패해 v3.23.2 첫 게시 실행이 멈췄다(3.23.2 는 게시되지 않았고 v3.24.0 이 범위 수정을 함께 실었다 — 이 수정은 v3.24.1).
 *  ① 같은 밀리초 두 번 → 보존본 2개(내용 둘 다 남는다) · 이름 형식은 숫자 그대로(.corrupt.<숫자>)
 *  ② preserveCorrupt 를 시계 고정으로 두 번 → 2개
 *  ③ 소스 — 보존본 이름을 Date.now() 로 직접 만드는 곳이 남지 않는다(사본 5곳도 이 함수)
 */
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'corruptBak3233-'));
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const { corruptBackupPath, preserveCorrupt } = await import('../src/util/atomicWrite.js');
const baks = (f) => fs.readdirSync(DIR).filter((n) => n.startsWith(`${path.basename(f)}.corrupt.`)).sort();

test('① 같은 밀리초에 두 번 보존해도 앞 보존본을 덮어쓰지 않는다 · 이름은 .corrupt.<숫자>', () => {
  const F = path.join(DIR, 'a.json');
  const T = 1_795_000_000_000;
  fs.writeFileSync(F, 'first');
  fs.renameSync(F, corruptBackupPath(F, T));
  fs.writeFileSync(F, 'second');
  fs.renameSync(F, corruptBackupPath(F, T));
  const list = baks(F);
  assert.equal(list.length, 2, JSON.stringify(list));
  for (const n of list) assert.match(n, /\.corrupt\.\d+$/);
  assert.deepEqual(list.map((n) => fs.readFileSync(path.join(DIR, n), 'utf8')).sort(), ['first', 'second']);
});

test('② preserveCorrupt — 시계가 같은 값을 돌려줘도 보존본 2개', () => {
  const F = path.join(DIR, 'b.json');
  const m = mock.method(Date, 'now', () => 1_795_000_000_123);
  const err = mock.method(console, 'error', () => {});
  try {
    fs.writeFileSync(F, '{ broken');
    assert.ok(preserveCorrupt(F, 'x'));
    fs.writeFileSync(F, '{ broken again');
    assert.ok(preserveCorrupt(F, 'x'));
  } finally { m.mock.restore(); err.mock.restore(); }
  assert.equal(baks(F).length, 2, JSON.stringify(baks(F)));
});

test('③ 소스 — 보존본 이름을 Date.now() 로 직접 만드는 곳이 없다', () => {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && /\.corrupt\.\$\{Date\.now\(\)\}/.test(stripComments(fs.readFileSync(p, 'utf8')))) hits.push(path.relative(SRC, p));
    }
  };
  walk(SRC);
  assert.deepEqual(hits, []);
});
