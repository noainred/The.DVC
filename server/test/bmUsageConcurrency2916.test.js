/**
 * v2.916 — 베어메탈 사용률 폴러 동시성 기본값 32(사용자 결정 2026-11-06 "동시성을 32개로 늘려줘").
 * 1,000대 법인: 동시 4 · 서버당 ~5초 → 한 주기 약 21분(재진입 가드로 실제 주기 20분+) / 동시 32 → 약 2.6분.
 * 소스 상수를 고정한다(모듈을 import 하면 폴러·DB 부작용이 따라오므로 텍스트로 본다 — arch2579 와 같은 방식).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src', 'bmusage', 'poller.js'), 'utf8');

test('bmusage 폴러 동시성 기본값은 32 이고 env 로 바꿀 수 있다', () => {
  const m = /const CONCURRENCY = Math\.max\(1, Number\(process\.env\.BMUSAGE_CONCURRENCY\) \|\| (\d+)\);/.exec(src);
  assert.ok(m, 'CONCURRENCY 상수 정의를 찾지 못했다');
  assert.equal(Number(m[1]), 32);
});

test('1,000대 법인 산수 — 동시 32 면 한 주기(5분) 안에 끝난다', () => {
  const servers = 1000; const perServerSec = 5;
  const cycleSec = (c) => Math.ceil(servers / c) * perServerSec;
  assert.ok(cycleSec(4) > 300, '동시 4 는 5분을 넘긴다(그래서 올렸다)');
  assert.ok(cycleSec(32) < 300, '동시 32 는 5분 안');
});
