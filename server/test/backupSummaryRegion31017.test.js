// v3.10.17 — Backup 현황 · Summary 의 리전 범위: 가상화 플랫폼 허브가 넘긴 ?region= 을 숫자 줄 · 트리 · CSV · 일정 · 에러 · 찾기가 같은 함수로 거른다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { regionOf, regionQuery, regionsOf, inRegion } from '../src/veeam/summaryRegion.js';
import { staleQueryOf } from '../src/veeam/backupSummaryAgg.js';

const vcs = [
  { id: 'a', location: { region: '유럽' } }, { id: 'b', location: { region: '북미' } }, { id: 'c', location: { region: '유럽' } },
  { id: 'd', location: {} }, { id: 'e' }, { id: 'f', location: { region: ' 아시아 ' } },
];

test('regionsOf — 빈 값 제외 · 중복 제거 · 한국어 정렬 · 공백 제거', () => {
  assert.deepEqual(regionsOf(vcs), ['북미', '아시아', '유럽']);
  assert.deepEqual(regionsOf(null), []); assert.deepEqual(regionsOf([]), []);
  assert.equal(regionOf({ location: { region: ' 유럽 ' } }), '유럽'); assert.equal(regionOf(null), '');
});

test('inRegion — 리전이 비면 전부 · 있으면 그 리전만 · 모르는 리전은 빈 목록(지어내지 않는다)', () => {
  assert.deepEqual(inRegion(vcs, '').map((v) => v.id), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(inRegion(vcs, '유럽').map((v) => v.id), ['a', 'c']);
  assert.deepEqual(inRegion(vcs, '아시아').map((v) => v.id), ['f']);
  assert.deepEqual(inRegion(vcs, '남극'), []);
  assert.deepEqual(inRegion(undefined, '유럽'), []);
});

test('regionQuery — 글자만 · 공백 제거 · 64자 상한(배열 · 숫자는 빈 값)', () => {
  assert.equal(regionQuery({ region: ' 유럽 ' }), '유럽');
  assert.equal(regionQuery({ region: ['유럽'] }), ''); assert.equal(regionQuery({ region: 3 }), ''); assert.equal(regionQuery({}), ''); assert.equal(regionQuery(null), '');
  assert.equal(regionQuery({ region: 'x'.repeat(100) }).length, 64);
});

test('staleQueryOf 가 region 을 같은 규칙으로 싣는다(찾기도 리전을 따른다)', () => {
  assert.equal(staleQueryOf({ n: '3', region: ' 유럽 ' }).region, '유럽');
  assert.equal(staleQueryOf({ n: '3' }).region, '');
  assert.equal(staleQueryOf({ n: '3', region: ['유럽'] }).region, '');
});

test('소스 계약 — 범위 교집합 뒤에 리전 · 다섯 집계가 inRegion · 네 라우트가 regionQuery(req.query) · 응답에 region · regions', () => {
  const s = fs.readFileSync(new URL('../src/routes/api/veeam.js', import.meta.url), 'utf8');
  assert.match(s, /async function summaryData\(req, snap, scope, region = ''\)/);
  assert.match(s, /const vcsAll = \(snap\?\.vcenters \|\| \[\]\)\.filter\(\(v\) => !allowed \|\| allowed\.has\(v\.id\)\);\n\s*const vcs = inRegion\(vcsAll, region\)/);
  assert.match(s, /async function scheduleData\(req, snap, scope, region = ''\)/);
  assert.match(s, /async function errorsData\(req, snap, scope, days, region = ''\)/);
  assert.equal((s.match(/inRegion\(/g) || []).length, 4, 'summary · schedule · errors · stale');
  assert.match(s, /\(!o\.vc \|\| v\.id === o\.vc\)\), o\.region\)/);
  assert.equal((s.match(/regionQuery\(req\.query\)/g) || []).length, 4, 'summary · summary.csv · schedule · errors');
  assert.match(s, /return \{ ok: true, at: Date\.now\(\), scope, region, regions: regionsOf\(vcsAll\), rows, totals,/);
});

test('v3.10.21 — 리전 보기: Director 정책 요약 · 오류 볼륨은 그 리전 법인만(regionSet) · EM 은 나눌 수 없어 응답이 emFleetWide · emSkippedForRegion 으로 밝힌다', () => {
  const s = fs.readFileSync(new URL('../src/routes/api/veeam.js', import.meta.url), 'utf8');
  assert.match(s, /const regionSet = region \? new Set\(vcs\.map\(\(v\) => v\.id\)\) : allowed;/);
  assert.match(s, /bareosPolicySummary\(bset, regionSet,/);
  assert.match(s, /emFleetWide: !!\(em && region\)/);
  assert.match(s, /const emSkippedForRegion = !allowed && !!region;/);
  assert.match(s, /if \(!allowed && !region\) \{/);
  assert.match(s, /bareosErrorVolumeItems\(bset, region \? new Set\(vcs\.map\(\(v\) => v\.id\)\) : allowed\)/);
  assert.match(s, /\.\.\.\(emSkippedForRegion \? \{ emSkippedForRegion: true \} : \{\}\)/);
});
