/**
 * todayBoundary.test.js — '오늘' 의 자정은 포탈 시각(기본 KST — util/dayKey.js)이다(2026-11-26 시험 위생 점검).
 *
 * Bareos 실시간 화면의 '오늘 합계'(routes/api/bareosLive.js startOfToday)가 프로세스 시간대(setHours)로 자정을 잘라, 서버 시간대가 UTC 인 설치본은
 * 한국 시각 09:00 에 다시 0 부터 셌다 — 다른 Bareos 화면 · 일일 집계는 dayKey 를 쓴다. 시험(bareosLive2833)도 같은 setHours 를 써서 둘이 같은 방식으로 틀려 드러나지 않았다.
 *
 * 고정하는 것: ① 프로세스 시간대와 무관하게 포탈 자정(UTC · 뉴욕 · 서울 프로세스 모두 같은 값) ② server/src 에서 setHours(0 …) 로 '오늘' 을 자르지 않는다(소스 스윕).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const PRELOAD = path.join(HERE, '_isolateConfig.js');

test('① Bareos 오늘 합계의 자정 = 포탈 자정 — 프로세스 시간대(UTC · 뉴욕 · 서울)와 무관', () => {
  // 2026-11-26 20:00Z = 11-27 05:00 KST → 오늘 0시는 11-26 15:00Z(KST 11-27 00:00). 예전 setHours 는 UTC 프로세스에서 11-26 00:00Z(KST 09:00)였다.
  const at = Date.UTC(2026, 10, 26, 20, 0);
  const want = Date.UTC(2026, 10, 26, 15, 0);
  for (const tz of ['UTC', 'America/New_York', 'Asia/Seoul']) {
    const env = { ...process.env, TZ: tz }; delete env.PORTAL_TZ_OFFSET_MIN; delete env.CONFIG_DIR; delete env.DVC_TEST_ISOLATED_CONFIG;
    const code = `const m = await import(${JSON.stringify(new URL('../src/routes/api/bareosLive.js', import.meta.url).href)});
console.log(JSON.stringify({ v: m._startOfTodayForTest(${at}) })); process.exit(0);`;
    const out = execFileSync(process.execPath, ['--experimental-sqlite', '--import', PRELOAD, '--input-type=module', '-e', code], { env, encoding: 'utf8', timeout: 60_000 });
    const v = JSON.parse(out.trim().split('\n').pop()).v;
    assert.equal(v, want, `TZ=${tz}: ${new Date(v).toISOString()}`);
  }
});

test('② server/src 에서 setHours(0 …) 로 자정을 자르지 않는다 — 포탈 시각은 util/dayKey.js 하나', () => {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && /setHours\(\s*0\s*[,)]/.test(stripComments(fs.readFileSync(p, 'utf8')))) hits.push(path.relative(SRC, p));
    }
  };
  walk(SRC);
  assert.deepEqual(hits, [], `프로세스 시간대 자정: ${hits.join(', ')}`);
});
