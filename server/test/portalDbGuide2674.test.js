// v2.674 — 포탈 DB '자세히' 팝업 설명: 화면에 나오는 파일 전부에 설명이 있고, 화면을 깨는 표기가 없다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const { guideFor, guideFiles, GUIDE_FIELDS } = await import('../src/insights/dbGuide.js');

function expectedFiles() {
  const t = fs.readFileSync(path.join(SRC, 'insights/portalDb.js'), 'utf8');
  const p = t.slice(t.indexOf('const PURPOSES'), t.indexOf('\n};', t.indexOf('const PURPOSES')));
  const keys = [...p.matchAll(/^\s+'([^']+)':/gm)].map((m) => m[1]);
  const d = fs.readFileSync(path.join(SRC, 'insights/dbLocation.js'), 'utf8');
  const mig = [...d.matchAll(/file: '([^']+)'/g)].map((m) => m[1]);
  return [...new Set([...keys, ...mig])];
}

test('① 화면 목록(PURPOSES ∪ 이전 대상 DB)의 모든 파일에 설명이 있다', () => {
  const missing = expectedFiles().filter((f) => !guideFor(f));
  assert.deepEqual(missing, [], `설명 없음: ${missing.join(', ')}`);
});

test('② 설명마다 제목·요약·저장 내용·보관 기간·지우면 생기는 일이 있다', () => {
  const thin = [];
  for (const f of guideFiles()) {
    const g = guideFor(f);
    if (!g.title || !g.summary || !g.stores.length || !g.retention || !g.ifDeleted) thin.push(f);
  }
  assert.deepEqual(thin, [], `빈 필드: ${thin.join(', ')}`);
});

test('③ 화면에 글자로 새는 표기(백틱·별표 두 개·제목 #)가 없다', () => {
  const bad = [];
  for (const f of guideFiles()) {
    const g = guideFor(f);
    for (const k of GUIDE_FIELDS) {
      for (const v of [].concat(g[k])) if (/`|\*\*|^#/m.test(v)) bad.push(`${f}.${k}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('④ 이름 조회는 표에 있는 이름만 — 경로·프로토타입 이름은 null, 라우트는 관리자·전체 범위 + 형식 검사', () => {
  assert.equal(guideFor('../../etc/passwd'), null);
  assert.equal(guideFor('__proto__'), null);
  assert.equal(guideFor('toString'), null);
  assert.ok(guideFor('host-temp.db'));
  const s = fs.readFileSync(path.join(SRC, 'routes/admin/statusTools.js'), 'utf8');
  assert.match(s, /'\/portal-db\/guide', adminOnly, fleetOnly/);
  assert.match(s, /\[\\w\.-\]\{1,120\}/, '파일명 형식 검사');
});
