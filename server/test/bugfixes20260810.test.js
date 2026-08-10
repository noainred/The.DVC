/**
 * 2026-08-10 버그 수정(다중 에이전트 조사) 회귀 방지.
 *  - report/changes·unprotected: scope 를 SQL(vcenterIds)로 밀어넣고 post-filter 제거(truncated 정확)
 *  - /hosts vcoreAllocated: (vcenterId, host) 키잉(동명 호스트 사이트 간 합산 방지)
 *  - /vms·/top: 음수 limit 가드(Math.max(1,…))
 *  - soapParsePool: onDown 멱등 가드(워커 crash 시 error+exit 이중 호출 → 워커 누수 방지)
 *  - api.js: NUL 바이트 0(과거 grep 깨짐 방지 규칙)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('report/changes: scope 를 f.vcenterIds 로 밀어넣고 post-filter 를 제거(truncated 는 raw 기준)', () => {
  const src = read('../src/routes/api.js');
  const body = src.slice(src.indexOf("api.get('/tools/report/changes'"), src.indexOf("api.get('/tools/report/changes'") + 1700);
  assert.match(body, /f\.vcenterIds = vcParam \? \[vcParam\] : \[\.\.\.allowed\]/);
  assert.match(body, /const rows = db\.query\(f, SCAN_MAX, 0\)/); // let→const, 재할당 필터 없음
  assert.ok(!/rows = rows\.filter/.test(body), 'post-filter(rows 재할당)가 남아있으면 안 됨');
  assert.match(body, /truncated: rows\.length >= SCAN_MAX/);
});

test('report/unprotected: scope 를 로그 쿼리(lf.vcenterIds)로 밀어넣음', () => {
  const src = read('../src/routes/api.js');
  const body = src.slice(src.indexOf("api.get('/tools/report/unprotected'"), src.indexOf("api.get('/tools/report/unprotected'") + 1100);
  assert.match(body, /lf\.vcenterIds = vcParam \? \(allowed\.has\(vcParam\) \? \[vcParam\] : \[\]\) : \[\.\.\.allowed\]/);
  assert.ok(!/rows\.filter\(\(r\) => allowed\.has/.test(body), 'post-filter 가 남아있으면 안 됨');
});

test('/hosts vcoreAllocated: (vcenterId, host) 로 키잉(동명 호스트 사이트 간 합산 방지)', () => {
  const src = read('../src/routes/api.js');
  const body = src.slice(src.indexOf("api.get('/hosts'"), src.indexOf("api.get('/hosts'") + 900);
  assert.match(body, /hostKeys = new Set\(hosts\.map\(\(h\) => `\$\{h\.vcenterId\}\\t\$\{h\.name\}`\)\)/);
  assert.match(body, /hostKeys\.has\(`\$\{v\.vcenterId\}\\t\$\{v\.host\}`\)/);
  assert.ok(!/hostNames = new Set\(hosts\.map\(\(h\) => h\.name\)\)/.test(body), '이름만으로 키잉하던 코드가 남아있으면 안 됨');
});

test('/vms·/top: 음수 limit 가드(Math.max(1, Math.min(...)))', () => {
  const src = read('../src/routes/api.js');
  const guards = src.match(/const limit = Math\.max\(1, Math\.min\(Number/g) || [];
  assert.ok(guards.length >= 2, `Math.max(1,…) 가드가 2곳 이상이어야 함(실제 ${guards.length})`);
});

test('soapParsePool: onDown 멱등 가드(error+exit 이중 호출 → 워커 누수 방지)', () => {
  const src = read('../src/util/soapParsePool.js');
  const body = src.slice(src.indexOf('const onDown ='), src.indexOf('const onDown =') + 400);
  assert.match(body, /if \(slot\.down\) return;/);
  assert.match(body, /slot\.down = true;/);
});

test('api.js: NUL 바이트 0(grep 깨짐 방지 — 구분자로 NUL 금지)', () => {
  const src = read('../src/routes/api.js');
  assert.equal(src.split(String.fromCharCode(0)).length - 1, 0, 'api.js 에 NUL 이 있으면 안 됨');
});
