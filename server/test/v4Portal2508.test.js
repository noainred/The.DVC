/**
 * v2.508 — V4 신규 포탈 + 개편 전 선행 수정 3건 회귀.
 *
 * 여기서 고정하는 것은 '화면이 그려진다' 가 아니라 **되돌리면 다시 깨지는 경계**다.
 *   F0-1 사용빈도 API 상한   — 상한이 12 면 '클릭 많은 순' 정렬이 상위 12개에만 실효한다.
 *   F0-3 추천 분류 커버리지  — PRESET 에 없는 도구는 화면에서 '기타' 로 빠진다.
 *   V4  셸 계약             — svcmon 권한 게이트(v2.506)·해시 라우팅·도구 키 불변.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESET } from '../src/toolcats/catalog.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const readSrc = (p) => fs.readFileSync(path.join(ROOT, 'server/src', p), 'utf8');
const readWeb = (p) => fs.readFileSync(path.join(ROOT, 'web/src', p), 'utf8');

// --- F0-1: /tool-usage/top 상한 ---------------------------------------------
test('F0-1 사용빈도 API 상한이 웹 요청(n:200)을 담는다', () => {
  const src = readSrc('routes/api/inventory.js');
  const m = src.match(/tool-usage\/top'[\s\S]{0,400}?Math\.min\((\d+),/);
  assert.ok(m, '/tool-usage/top 의 Math.min 상한을 찾지 못했다');
  const cap = Number(m[1]);
  // 웹이 실제로 요청하는 n 보다 작으면 나머지 도구가 정렬에서 빠진다.
  const web = readWeb('views/SpecialTools.jsx');
  const req = web.match(/fetchJson\('\/tool-usage\/top',\s*\{\s*n:\s*(\d+)/);
  assert.ok(req, '웹의 /tool-usage/top 요청 n 을 찾지 못했다');
  assert.ok(cap >= Number(req[1]), `서버 상한 ${cap} < 웹 요청 ${req[1]} — 정렬이 상위 ${cap}개에만 실효한다`);
});

// --- F0-3: 추천 분류 프리셋이 도구 전체를 덮는다 ------------------------------
test('F0-3 PRESET 이 도구 전체를 덮고 유령 키가 없다', () => {
  const list = readWeb('views/specialToolsList.js');
  const keys = [...list.matchAll(/^\s*\{ k: '([^']+)'/gm)].map((m) => m[1]);
  assert.ok(keys.length >= 79, `도구 수가 줄었다(${keys.length}) — 목록 파싱이 깨졌는지 확인할 것`);
  const tools = new Set(keys);
  const preset = new Set(PRESET.flatMap((c) => c.tools));
  const missing = [...tools].filter((k) => !preset.has(k));
  const ghost = [...preset].filter((k) => !tools.has(k));
  assert.deepEqual(missing, [], `PRESET 에 없는 도구는 화면에서 '기타' 로 빠진다: ${missing.join(', ')}`);
  assert.deepEqual(ghost, [], `PRESET 에만 있는 유령 키: ${ghost.join(', ')}`);
});

// --- F0-2: 카드 JSX 단일화 ---------------------------------------------------
test('F0-2 카드 모양은 renderToolCard 하나만 소유한다', () => {
  const web = readWeb('views/SpecialTools.jsx');
  // 카드 본문의 특징 문자열이 두 번 이상 나오면 인라인 복제가 되살아난 것이다.
  const marks = web.match(/전체 사용자 누적 실행 횟수/g) || [];
  assert.equal(marks.length, 1, '카드 JSX 가 다시 복제됐다 — renderToolCard 로 단일화할 것');
  // 폭 측정은 단일/섹션 그리드 어느 쪽이 떠 있어도 동작해야 한다(ref 콜백).
  assert.ok(/ref=\{setGridEl\}/.test(web), '단일 그리드에 측정 ref 가 없다');
  assert.ok(/ref=\{secIdx === 0 \? setGridEl : undefined\}/.test(web), '섹션 그리드에 측정 ref 가 없다 — 카테고리 모드에서 favCount 가 갱신되지 않는다');
});

// --- V4 셸 계약 --------------------------------------------------------------
test('V4 셸도 svcmon 권한 게이트(v2.506)를 지킨다', () => {
  const src = readWeb('version_4/V4App.jsx');
  assert.ok(/const canSvcmon = can\('svcmon'\)/.test(src), 'can(\'svcmon\') 판정이 없다');
  assert.ok(/usePolling\(canSvcmon \? '\/svcmon\/state' : null/.test(src), '권한 없는 역할에 30초마다 403 을 만든다');
  assert.ok(/svcmon: canSvcmon/.test(src), '타일이 권한 없음을 거짓 원인(점검 상태 대기)으로 표시한다');
});

test('V4 는 구 딥링크 #/v3 를 버리지 않는다', () => {
  const app = readWeb('App.jsx');
  assert.ok(/isV4Hash/.test(app), 'App.jsx 에 V4 해시 판정이 없다');
  assert.ok(/isV3Hash/.test(app), '#/v3 리다이렉트 판정이 사라졌다 — 기존 북마크가 죽는다');
  assert.ok(/#\/v4/.test(app), '#/v3 → #/v4 리다이렉트 대상이 없다');
  // replaceState 가드에 V4 가 빠지면 진입 직후 해시가 덮여 즉시 튕긴다.
  assert.ok(/!tabFromHash\(\)[^\n]*!isV4Hash\(\)/.test(app), 'replaceState 가드에 isV4Hash 가 빠졌다');
});

test('V4 화면 중 무거운 API 는 15초 폴링을 걸지 않는다', () => {
  // /tools/capacity-forecast 는 실측 1.5초(CLAUDE.md v2.503), /tools/orphan-vmdk 는 실행마다
  // SOAP 왕복 2회(v2.505)다. 28 vCenter · 고RTT 환경에서 짧은 주기로 돌리면 안 된다.
  const dir = path.join(ROOT, 'web/src/version_4/pages');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.jsx'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/usePolling\([^;]*?'(\/tools\/capacity-forecast|\/tools\/waste|\/tools\/vm-track[^']*|\/compare\/matrix|\/insights\/[^']*)'[^;]*?,\s*([\d_]+)\)/g)) {
      const ms = Number(String(m[2]).replace(/_/g, ''));
      assert.ok(ms >= 60_000, `${f}: ${m[1]} 폴링 주기 ${ms}ms — 60초 이상이어야 한다`);
    }
    // 스캔 엔드포인트('/tools/orphan-vmdk')만 금지한다. 목록('/tools/orphan-vmdk/datastores')은
    // 스냅샷 memoJson 이라 값이 싸다(toolsCapacity.js:1298) — 둘을 구분하지 않으면 오탐이 난다.
    assert.ok(!/usePolling\([^;]*'\/tools\/orphan-vmdk'/.test(src),
      `${f}: 고아 VMDK **스캔**은 폴링하지 않는다 — 실행마다 vCenter SOAP 왕복이 발생한다(v2.505)`);
  }
});
