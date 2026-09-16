/**
 * powermaxApiVer2532.test.js — Unisphere for PowerMax REST 버전 경로(v2.532).
 *
 * ── 사용자 신고와 실측 ─────────────────────────────────────────────────────────
 * "power max 스토리지 10.x 버전에서는 9.x 버전과 좀 달라진것 같네 / 확인하고 9 / 10 버전에서
 * 다른게 있으면 버전별로 만들어줘" — 화면 실측(HG-PMAX, Unisphere 10.2.0.9):
 *     config: 오류: HTTP 404 — RESTEASY003210: Could not find resource for full path:
 *             https://10.112.31.25:8443/univmax/restapi/system/symmetrix
 *     alerts: 오류: HTTP 404 — …/univmax/restapi/system/alert_summary
 * 같은 코드가 GM1(9.2.4.9)에서는 config/capacity/alerts 전부 OK 였다 → **버전차**다.
 * 10.x 가 **무버전 `/univmax/restapi/system/*` 별칭을 없앤 것**이고, 이미 `sloprovisioning`
 * 에만 있던 버전 프리픽스 폴백을 나머지 호출에 적용하지 않은 것이 결함이었다.
 *
 * ── 왜 버전 목록을 코드에 박지 않는가(핵심) ────────────────────────────────────
 * 무버전 `/univmax/restapi/version` 은 10.x 에서도 살아 있고 **자기가 무엇을 지원하는지 직접
 * 알려준다**. 사용자 curl 실측(10.2.0.9):
 *     {"version":"V10.2.0.9","api_version":"102","supported_api_versions":["102","101","100"]}
 * → **9x 세그먼트가 아예 없다.** 그러므로 추측하지 않고 이 배열을 그대로 쓴다.
 * 정적 목록은 그 응답을 못 읽었을 때의 마지막 수단일 뿐이다.
 *
 * ⚠ 아직 확인하지 못한 것: 10.x 응답의 **필드 이름**(`symmetrixId` 배열·`system_capacity`).
 *   경로가 맞아도 필드가 바뀌었으면 `system_capacity 필드 부재` 로 떨어진다 — 실장비 본문을
 *   받으면 그때 맞춘다. 이 파일은 **경로 선택**만 고정한다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { apiVersionsFrom, pathsFor } from '../src/storage/collectors/powermax.js';

/* ── 1. 장비가 준 목록이 언제나 우선 ─────────────────────────────── */

test('★ 10.2 실측 응답 — supported_api_versions 를 그대로 쓴다(앞자리가 102)', () => {
  const r = apiVersionsFrom({ version: 'V10.2.0.9', api_version: '102', supported_api_versions: ['102', '101', '100'] });
  assert.equal(r.source, 'supported');
  assert.deepEqual(r.vers.slice(0, 3), ['102', '101', '100'], '장비가 준 순서를 뒤집지 말 것');
});

test('supported 목록이 없으면 api_version 하나를 쓴다', () => {
  const r = apiVersionsFrom({ version: 'V10.1.0.0', api_version: '101' });
  assert.equal(r.source, 'api_version');
  assert.equal(r.vers[0], '101');
});

test('둘 다 없으면 버전 문자열에서 유도한다(V9.2.4.9 → 92 · V10.2.0.9 → 102)', () => {
  assert.equal(apiVersionsFrom({ version: 'V9.2.4.9' }).vers[0], '92');
  assert.equal(apiVersionsFrom({ version: 'V9.2.4.9' }).source, 'derived');
  assert.equal(apiVersionsFrom({ version: 'V10.2.0.9' }).vers[0], '102');
});

test('버전 응답 자체를 못 읽으면 정적 폴백 — 그래도 빈 배열은 주지 않는다', () => {
  const r = apiVersionsFrom(null);
  assert.equal(r.source, 'fallback');
  assert.ok(r.vers.length >= 4, '후보가 비면 어떤 경로도 시도하지 못한다');
});

test('쓰레기 값은 버린다(경로에 끼면 404 왕복만 늘어난다)', () => {
  const r = apiVersionsFrom({ supported_api_versions: ['abc', '', null, '102', '102', '9'] });
  assert.equal(r.vers[0], '102');
  assert.equal(r.vers.filter((v) => v === '102').length, 1, '중복은 한 번만');
  assert.ok(!r.vers.includes('9'), '한 자리는 버전 세그먼트가 아니다');
});

test('후보 수에 상한이 있다(실패 시 404 왕복이 무한히 늘지 않게)', () => {
  const many = Array.from({ length: 30 }, (_, i) => String(100 + i));
  assert.ok(apiVersionsFrom({ supported_api_versions: many }).vers.length <= 8);
});

/* ── 2. 경로 조립 ────────────────────────────────────────────────── */

test('★ 버전 경로가 앞, **무버전이 맨 뒤** — 9.x 에서 동작이 확인된 형태를 빼지 않는다', () => {
  const p = pathsFor(['102', '101'], '/system/symmetrix');
  assert.deepEqual(p, [
    '/univmax/restapi/102/system/symmetrix',
    '/univmax/restapi/101/system/symmetrix',
    '/univmax/restapi/system/symmetrix',
  ]);
});

test('앞의 슬래시가 있든 없든 같은 경로를 만든다', () => {
  assert.deepEqual(pathsFor(['102'], 'system/alert'), pathsFor(['102'], '/system/alert'));
});

test('10.2 에서 실패했던 그 경로가 **후보 안에** 있다(9.x 호환)', () => {
  const { vers } = apiVersionsFrom({ supported_api_versions: ['102', '101', '100'] });
  const p = pathsFor(vers, '/system/symmetrix');
  assert.ok(p.includes('/univmax/restapi/102/system/symmetrix'), '10.x 가 쓸 경로');
  assert.ok(p.includes('/univmax/restapi/system/symmetrix'), '9.x 가 쓰던 무버전 경로');
  assert.ok(p.indexOf('/univmax/restapi/102/system/symmetrix') < p.indexOf('/univmax/restapi/system/symmetrix'),
    '10.x 에서 404 가 나는 무버전 경로를 먼저 때리면 매 주기 헛왕복이다');
});

/* ── 3. 소스 계약 ────────────────────────────────────────────────── */

test('★ 무버전 경로를 하드코딩으로 되돌리지 않았는지 소스로 확인한다', async () => {
  const fs = await import('node:fs');
  const url = new URL('../src/storage/collectors/powermax.js', import.meta.url);
  // 주석은 걷어낸다 — 결함을 설명하는 주석에 그 경로가 적혀 있다(v2.531.1 에서 겪은 함정).
  const code = fs.readFileSync(url, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const bad of ["get('/univmax/restapi/system/symmetrix')", "'/univmax/restapi/system/alert'"]) {
    assert.ok(!code.includes(bad), `무버전 경로 직접 호출이 남아 있다: ${bad}`);
  }
  assert.ok(code.includes('pathsFor('), '경로는 pathsFor 하나가 만든다');
});
