/**
 * v3.10.11 — 공통 기능 개선 9회차: runtime-settings(데이터 소스 저장소, 19곳이 쓴다)의 '객체가 아닌 JSON'.
 *
 * 예전: `JSON.parse(...) || {}` 가 `5`·`"live"`·`[]` 를 그대로 cache 로 썼다 —
 *   · 숫자 · 문자열 → setDataSource 의 속성 대입이 엄격 모드 TypeError(라우트 500)
 *   · 배열 → 속성이 직렬화되지 않아 '저장됐다' 고 답하고 재시작 뒤 사라짐
 * 지금: 객체가 아니면 손상과 같이 보존(`runtime.json.corrupt.*`)하고 빈 설정으로 시작 — 저장이 실제로 남는다.
 * config.js 가 싱글턴이라 경우마다 자식 프로세스로 돌린다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MOD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/runtime-settings.js');

function run(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt3111-'));
  try {
    if (body !== undefined) fs.writeFileSync(path.join(dir, 'runtime.json'), body);
    const code = `const m = await import(${JSON.stringify('file://' + MOD)});
      const r = m.setDataSource('live');
      console.log(JSON.stringify({ r, ds: m.getDataSource(), over: m.isDataSourceOverridden() }));`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const last = out.trim().split('\n').pop();
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
    const corrupt = fs.readdirSync(dir).filter((f) => f.startsWith('runtime.json.corrupt.'));
    return { res: JSON.parse(last), saved, corrupt };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

for (const [name, body] of [['숫자', '5'], ['문자열', '"live"'], ['배열', '[]'], ['true', 'true']]) {
  test(`객체가 아닌 JSON(${name}) — 던지지 않고, 저장이 실제로 남고, 원본은 보존된다`, () => {
    const { res, saved, corrupt } = run(body);
    assert.deepEqual(res.r, { ok: true, dataSource: 'live' });
    assert.equal(res.ds, 'live');
    assert.equal(res.over, true);
    assert.deepEqual(saved, { dataSource: 'live' }, '파일에 남은 값');
    assert.equal(corrupt.length, 1, '원본을 보존해야 한다');
  });
}

test('정상 객체 · 파일 없음 · 깨진 JSON — 기존 동작 그대로', () => {
  const a = run('{"dataSource":"auto","other":1}');
  assert.deepEqual(a.saved, { dataSource: 'live', other: 1 }, '다른 키를 지우지 않는다');
  assert.equal(a.corrupt.length, 0);
  const b = run(undefined);
  assert.deepEqual(b.saved, { dataSource: 'live' });
  assert.equal(b.corrupt.length, 0);
  const c = run('{"dataSource":');
  assert.deepEqual(c.saved, { dataSource: 'live' });
  assert.equal(c.corrupt.length, 1);
});
