// 특수 기능 카테고리 — 서버측 저장·검증·프리셋 회귀 고정 (v2.455).
//
// 화면 배치 계산(buildSections)은 **웹**(`web/src/views/toolSections.js`)이 소유한다 —
// 같은 로직을 양쪽에 두면 어긋나므로 서버에는 두지 않는다. 여기서는 저장 가능한 형태인지,
// 프리셋이 실제 도구 키를 가리키는지를 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESET, normCategory, categoryIssue, validate, MAX_CATEGORIES, TOOL_KEY_RE } from '../src/toolcats/catalog.js';
import { DEFAULTS } from '../src/toolcats/settings.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');

/** 웹의 단일 소스에서 실제 도구 키를 읽는다(서버로 복사하지 않는다). */
function webToolKeys() {
  const src = fs.readFileSync(path.join(WEB, 'views/specialToolsList.js'), 'utf8');
  return new Set([...src.matchAll(/\{\s*k:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]));
}

test('★ 프리셋의 도구 키가 전부 실제 존재한다(오타 = 그 카드가 영영 안 나옴)', () => {
  const keys = webToolKeys();
  assert.ok(keys.size > 50, `도구 목록을 못 읽었다(${keys.size}개)`);
  const bad = [];
  for (const c of PRESET) for (const t of c.tools) if (!keys.has(t)) bad.push(`${c.id}:${t}`);
  assert.deepEqual(bad, [], `프리셋이 없는 도구를 가리킨다 — ${bad.join(', ')}`);
});

test('★ 프리셋은 중복 소속을 실제로 쓴다(요구사항이 살아 있는지 고정)', () => {
  const count = new Map();
  for (const c of PRESET) for (const t of c.tools) count.set(t, (count.get(t) || 0) + 1);
  const dup = [...count].filter(([, n]) => n > 1);
  assert.ok(dup.length >= 5, `중복 소속 예시가 너무 적다(${dup.length}) — 한 도구를 여러 카테고리에 넣는 것이 이 기능의 요구사항이다`);
  // 대표 사례가 유지되는지 — 설명과 실제가 어긋나지 않게.
  assert.ok(count.get('esxitemp') >= 2, 'ESXi 온도는 서버이자 가상화여야 한다');
  assert.ok(count.get('gpu') >= 2, 'GPU 는 서버이자 가상화여야 한다');
});

test('프리셋 카테고리 자체가 검증을 통과한다', () => {
  assert.deepEqual(validate({ categories: PRESET }), []);
  assert.ok(PRESET.length <= MAX_CATEGORIES);
  for (const c of PRESET) assert.equal(categoryIssue(c), null, `${c.id} 검증 실패`);
});

test('정규화 — id 형식 보정 · 같은 카테고리 안 중복 제거 · 이름 보존', () => {
  const c = normCategory({ id: 'Net Work!', label: '  네트워크 · 회선  ', icon: '🌐', tools: ['nsx', 'nsx', 'BAD KEY', 'ipam'] }, 0);
  assert.equal(c.id, 'cat1', '형식에 안 맞는 id 는 안전한 값으로 대체');
  assert.equal(c.label, '네트워크 · 회선', '공백·가운뎃점은 이름에 정상적으로 쓰인다');
  assert.deepEqual(c.tools, ['nsx', 'ipam'], '같은 카테고리 안의 중복과 형식 오류만 제거');
  assert.equal(c.enabled, true);
});

test('검증 — id 중복·이름 없음·잘못된 도구 키를 잡는다', () => {
  assert.match(categoryIssue({ id: 'a', label: '' }), /이름/);
  assert.match(categoryIssue({ id: 'A B', label: 'x' }), /id/);
  assert.match(categoryIssue({ id: 'a', label: 'x', tools: ['ok', 'NOT OK'] }), /도구 키/);
  const errs = validate({ categories: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] });
  assert.ok(errs.some((e) => /중복/.test(e)));
});

test('도구 키 형식 — 실제 목록이 전부 통과한다(형식 규칙이 현실과 맞는지)', () => {
  for (const k of webToolKeys()) assert.ok(TOOL_KEY_RE.test(k), `실제 도구 키 '${k}' 가 형식 검사를 통과 못 한다`);
});

test('기본은 꺼짐 — 업그레이드만으로 특수 기능 화면 배치가 바뀌지 않는다', () => {
  assert.equal(DEFAULTS.enabled, false);
  assert.deepEqual(DEFAULTS.categories, []);
  assert.equal(DEFAULTS.showUncategorized, true, "분류 안 된 도구가 사라지면 안 된다");
});

test('화면 배치 로직은 서버에 없다(웹이 단일 소유 — 중복 구현 방지)', () => {
  const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/toolcats/catalog.js'), 'utf8');
  assert.ok(!/export function buildSections/.test(src),
    'buildSections 가 서버에 다시 생겼다 — web/src/views/toolSections.js 와 어긋나게 된다');
  assert.ok(fs.existsSync(path.join(WEB, 'views/toolSections.js')), '웹 구현이 있어야 한다');
});
