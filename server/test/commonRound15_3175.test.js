/**
 * v3.17.6 — 2차 공통 기능 점검 5회차: 양수 환경변수는 공용 `util/envNumber.js envPositive` 하나로.
 *
 * 예전 `Number(process.env.X) || 기본값` 34곳은 음수 · Infinity 를 통과시켰다:
 *  · AUDIT_MAX=-5 → 감사 로그 정리가 빈 배열을 써 **감사 기록이 통째로 지워졌다**(③ — 실제 재현 · 수정 전 실패).
 *  · LOGIN_MAX_FAILS=Infinity → 로그인 실패 잠금이 꺼졌다 · 음수면 첫 실패에 잠겼다.
 * 고정: ① 판정 ② 소스 스윕(그 형태가 되살아나지 않는다) ③ 감사 로그 실제 정리.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { envPositive } from '../src/util/envNumber.js';
import { stripComments } from './_stripComments.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

test('① envPositive — 유한한 양수만 값 · 내림 · 그 밖은 기본값', () => {
  for (const v of [undefined, null, '', '  ', '0', 0, '-5', -5, 'abc', 'Infinity', Infinity, '-Infinity', [], [5], {}, true, '0.4']) {
    assert.equal(envPositive(v, 77), 77, JSON.stringify(v));
  }
  assert.equal(envPositive('300', 77), 300);
  assert.equal(envPositive('1.9', 77), 1);
  assert.equal(envPositive(' 20000 ', 77), 20000);
  assert.equal(envPositive('0.5', 1, { int: false }), 0.5);
  assert.equal(envPositive('-0.5', 1, { int: false }), 1);
});

test('② 소스 스윕 — const X = Number(process.env.Y) || N 가 되살아나지 않는다', () => {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        stripComments(fs.readFileSync(p, 'utf8')).split('\n').forEach((l, i) => {
          if (/^\s*(export\s+)?const\s+[A-Z0-9_]+\s*=\s*Number\(process\.env\.[A-Z0-9_]+\)\s*\|\|\s*[0-9_.]+\s*;/.test(l)) hits.push(`${path.relative(SRC, p)}:${i + 1}`);
        });
      }
    }
  };
  walk(SRC);
  assert.deepEqual(hits, [], `envPositive(process.env.X, 기본값) 를 쓸 것:\n${hits.join('\n')}`);
});

test('③ AUDIT_MAX=-5 여도 감사 로그 정리가 기록을 지우지 않는다(기본 상한으로)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit3175-'));
  try {
    const mod = pathToFileURL(path.join(SRC, 'audit.js')).href;
    // 첫 기록에서 정리가 한 번 돈다(appendsSinceTrim 499 시작). 10줄을 쓰고 남은 줄 수를 센다.
    const code = `const m = await import(${JSON.stringify(mod)}); for (let i = 0; i < 10; i++) m.logAudit({ user: 'u', action: 'a' + i }); console.log(m.listAudit({ limit: 100 }).total);`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUDIT_MAX: '-5' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(Number(out.trim().split('\n').pop()), 10, '감사 기록이 지워졌다');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
