/**
 * v2.508 — 개편 전 선행 수정 3건 회귀 + (v2.747) V4·V5·V6 셸 삭제 고정.
 *
 * 여기서 고정하는 것은 '화면이 그려진다' 가 아니라 **되돌리면 다시 깨지는 경계**다.
 *   F0-1 사용빈도 API 상한   — 상한이 12 면 '클릭 많은 순' 정렬이 상위 12개에만 실효한다.
 *   F0-3 추천 분류 커버리지  — PRESET 에 없는 도구는 화면에서 '기타' 로 빠진다.
 *   셸 삭제                 — v2.508 에 만든 V4 셸(과 V5·V6)은 v2.747 에 사용자 요청으로 지웠다. 되살리지 않는다.
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
  // v2.679: 화면이 분류 탭·카드 격자로 바뀌었다 — 모든 격자가 renderToolCard 하나로 카드를 그린다.
  assert.ok(/function renderToolCard\(/.test(web), 'renderToolCard 가 없다');
  assert.equal((web.match(/className=\{`st-card\$\{/g) || []).length, 1, '카드 JSX 가 복제됐다');
});

// --- V4·V5·V6 셸 삭제(v2.747, 사용자 요청) --------------------------------------
// 셸은 지웠고 다시 만들거나 고치지 않는다 — 폴더가 되살아나거나 기본 화면이 다시 가져다 쓰면 여기서 막힌다.
test('V4·V5·V6 셸 폴더가 없고 기본 화면이 그 코드를 가져다 쓰지 않는다', () => {
  for (const d of ['version_4', 'version_5', 'version_6']) {
    assert.ok(!fs.existsSync(path.join(ROOT, 'web/src', d)), `web/src/${d} 가 되살아났다 — v2.747 에 지운 셸이다`);
  }
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'node_modules') walk(p, out); } else if (/\.(jsx?|css)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const bad = walk(path.join(ROOT, 'web/src'))
    .filter((f) => /(?:from\s+|import\()\s*['"][^'"]*version_[456]\//.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f));
  assert.deepEqual(bad, [], '지운 셸 경로를 import 한다');
});

test('옛 셸 주소(#/v3·#/v4·#/v5·#/v6·#/m)는 기본 화면으로 옮기고, 설정에 신규 포탈 보기가 없다', () => {
  const app = readWeb('App.jsx');
  assert.match(app, /legacyShellHash\(window\.location\.hash\) \|\| movedTabHash\(window\.location\.hash\)/,
    '옛 북마크(#/v4/…)가 빈 화면·엉뚱한 랜딩 탭으로 떨어진다');
  assert.match(app, /localStorage\.removeItem\(LEGACY_SHELL_KEY\)/, '지운 V5·V6 셸 플래그(ui.shell)를 정리하지 않는다');
  for (const name of ['V4App', 'V5Shell', 'V6Shell', 'v4On', 'v5On', 'v6On']) assert.ok(!app.includes(name), `App.jsx 에 ${name} 이 남았다`);
  const settings = readWeb('views/Settings.jsx');
  assert.ok(!settings.includes('신규 포탈 보기'), '설정에 신규 포탈 보기 메뉴가 남았다');
  assert.ok(!/v4-portal|V4Portal/.test(settings), '설정에 v4-portal 항목이 남았다');
  assert.ok(!fs.existsSync(path.join(ROOT, 'web/src/views/V4Portal.jsx')), 'V4Portal.jsx 가 되살아났다');
});
