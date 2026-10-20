// CLAUDE.md 크기 상한 — 2026-10-20 루트 CLAUDE.md 가 6,209줄·902KB(약 44만 토큰)까지 자라 매 턴·매 하위 에이전트에
// 실렸고 컨텍스트가 자주 찼다. 영역별 규칙은 docs/rules/ 와 디렉터리 CLAUDE.md 로 옮겼다. 이 테스트는 다시 자라는 것을 막는다.
// 상한을 넘으면 상한을 올리지 말고 항목을 영역 문서(docs/rules/<영역>.md)로 옮길 것.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const size = (p) => fs.statSync(path.join(ROOT, p)).size;

const LIMITS = {
  'CLAUDE.md': 40_000,
  'server/CLAUDE.md': 40_000,
  'pyportal/CLAUDE.md': 20_000,
  'horizon-uag-monitor/CLAUDE.md': 10_000,
};

test('CLAUDE.md 파일은 상한 안에 있다(넘으면 docs/rules/ 로 옮길 것)', () => {
  for (const [p, max] of Object.entries(LIMITS)) {
    assert.ok(size(p) <= max, `${p} ${size(p)}B > ${max}B — 영역 문서로 옮길 것`);
  }
});

test('디렉터리 CLAUDE.md 는 각각 작게 유지한다', () => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const rel = path.join(d, e.name);
      if (e.isDirectory()) walk(rel);
      else if (e.name === 'CLAUDE.md') out.push(rel);
    }
  };
  walk('server/src');
  walk('web/src');
  for (const p of out) assert.ok(size(p) <= 15_000, `${p} ${size(p)}B > 15000B`);
});

test('루트 CLAUDE.md 가 가리키는 규칙 문서가 실재하고, 색인이 docs/rules 전부를 싣는다', () => {
  const root = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  const named = [...root.matchAll(/docs\/rules\/([\w-]+\.md)/g)].map((m) => m[1]);
  assert.ok(named.length >= 10, '루트에 영역 문서 색인이 없다');
  for (const f of named) assert.ok(fs.existsSync(path.join(ROOT, 'docs/rules', f)), `없는 문서: docs/rules/${f}`);
  const readme = fs.readFileSync(path.join(ROOT, 'docs/rules/README.md'), 'utf8');
  for (const f of fs.readdirSync(path.join(ROOT, 'docs/rules'))) {
    if (f === 'README.md') continue;
    assert.ok(readme.includes(`(${f})`), `docs/rules/README.md 에 ${f} 가 없다`);
  }
  for (const d of ['relaytopo', 'agent', 'rma', 'security', 'sanswitch', 'hostaccess']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'server/src', d, 'CLAUDE.md')), `server/src/${d}/CLAUDE.md 가 없다`);
  }
});

test('루트 CLAUDE.md 는 사용자 선호 절을 유지한다', () => {
  const root = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  for (const s of ['## 사용자 선호 (반드시 준수)', '작업 현황', 'TZ=Asia/Seoul', 'versions.json', '존댓말']) {
    assert.ok(root.includes(s), `사용자 선호 절에서 빠졌다: ${s}`);
  }
});
