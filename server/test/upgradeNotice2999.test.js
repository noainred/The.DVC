/**
 * v2.999 — 업그레이드 뒤 '새로고침 하세요' 안내(사용자 요청 2026-11-13 · 설계 docs/design/upgrade-reload · 컨펌 '추천대로 전부 진행').
 *  ① notesSince — from < version ≤ to 만 · 최신 먼저 · 판 수 · 줄 수 · 줄 길이 상한 · 형식이 아닌 판은 건너뜀 · 넘친 판 수(truncated)
 *  ② 실제 라우트 /api/release-notes/since — 잘못된 from 은 400 · 응답 모양(옛 판 창이 부르는 계약)
 *  ③ 웹과 대조 — 경로 글자(upgradeNotice.SINCE_PATH) · 버전 판정(웹 normVersion ↔ 서버 parseSinceVersion 같은 입력 같은 답)
 *  ④ 오류 상자는 주 번들 — ErrorBoundary · UpgradeNotice · upgradeNotice.js 에 lazy/동적 import 없음 · App 은 ErrorBoundary 를 정적 import
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'upgnotice2999-'));
Object.assign(process.env, { CONFIG_DIR: DIR, DATA_SOURCE: 'live', AUTH_ENABLED: 'true' });
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const { notesSince, parseSinceVersion, SINCE_LIMITS, listNotes } = await import('../src/release-notes.js');
const { currentVersion } = await import('../src/config.js');
const express = (await import('express')).default;
const { registerSearchNotes } = await import('../src/routes/api/searchNotes.js');
const W = await import('../../web/src/upgradeNotice.js');
const { stripComments } = await import('./_stripComments.js');

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

const N = (version, notes = [], title = `t${version}`) => ({ version, date: '2026-11-13', title, notes });

test('① notesSince — 범위 · 순서 · 상한', () => {
  const list = [N('2.999.0', ['a', 'b']), N('2.998.0', ['c']), N('2.997.0', ['d']), N('2.996.0', ['e']), N('3.0.0', ['future'])];
  const r = notesSince(list, '2.996.0', '2.999.0');
  assert.deepEqual(r.notes.map((x) => x.version), ['2.999.0', '2.998.0', '2.997.0'], 'from 은 빼고 to 는 넣는다 · to 보다 새 판(3.0.0)은 뺀다 · 최신 먼저');
  assert.equal(r.truncated, 0);
  assert.deepEqual(r.notes[0].notes, ['a', 'b']);
  // 순서가 섞여 들어와도 최신 먼저 · 숫자 비교(2.1000.0 > 2.999.0)
  const r2 = notesSince([N('2.997.0'), N('2.1000.0'), N('2.999.0')], '2.990.0', '3.0.0');
  assert.deepEqual(r2.notes.map((x) => x.version), ['2.1000.0', '2.999.0', '2.997.0']);
  // 같은 판 · 못 읽은 from/to → 빈 목록
  assert.deepEqual(notesSince(list, '2.999.0', '2.999.0').notes, []);
  assert.deepEqual(notesSince(list, 'x', '2.999.0'), { notes: [], truncated: 0 });
  assert.deepEqual(notesSince(list, '2.990.0', ''), { notes: [], truncated: 0 });
  // 형식이 아닌 판(관리자 기록 '2.998.1-hotfix') · 객체가 아닌 항목은 건너뛴다
  const r3 = notesSince([N('2.998.1-hotfix', ['x']), null, 'str', N('2.998.0', ['ok'])], '2.997.0', '2.999.0');
  assert.deepEqual(r3.notes.map((x) => x.version), ['2.998.0']);
});

test('① notesSince — 판 수 · 줄 수 · 줄 길이 · 제목 상한과 truncated', () => {
  const many = Array.from({ length: SINCE_LIMITS.maxVersions + 5 }, (_, i) => N(`2.${900 + i}.0`, ['x']));
  const r = notesSince(many, '2.0.0', '3.0.0');
  assert.equal(r.notes.length, SINCE_LIMITS.maxVersions);
  assert.equal(r.truncated, 5, '넘친 판 수를 밝힌다(조용히 버리지 않는다)');
  assert.equal(r.notes[0].version, `2.${900 + SINCE_LIMITS.maxVersions + 4}.0`, '남기는 것은 최신 판');
  const long = 'ㄱ'.repeat(SINCE_LIMITS.maxLineLen + 50);
  const r2 = notesSince([N('2.999.0', [long, ...Array.from({ length: 40 }, (_, i) => `n${i}`), '', '  ', 7], 'T'.repeat(500))], '2.998.0', '2.999.0');
  const one = r2.notes[0];
  assert.equal(one.notes.length, SINCE_LIMITS.maxLinesPerVersion, '줄 수 상한 · 빈 줄 · 문자열 아닌 값은 버린다');
  assert.equal(one.notes[0].length, SINCE_LIMITS.maxLineLen);
  assert.ok(one.notes[0].endsWith('…'));
  assert.equal(one.title.length, SINCE_LIMITS.maxTitleLen);
});

test('② 라우트 /api/release-notes/since — 400 · 응답 모양 · 실제 노트와 같은 내용', async () => {
  const app = express();
  app.use((req, _res, next) => { req.user = { username: 'u', role: 'viewer' }; next(); });
  const api = express.Router(); registerSearchNotes(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const base = `http://127.0.0.1:${srv.address().port}/api/release-notes/since`;
    for (const bad of ['', '?from=', '?from=abc', '?from=1.2', '?from=1.2.3.4', `?from=${'9'.repeat(40)}`]) {
      const res = await fetch(`${base}${bad}`);
      assert.equal(res.status, 400, `잘못된 from 은 400: '${bad}'`);
    }
    const cur = currentVersion();
    const all = listNotes();
    const older = all.map((n) => n.version).filter((v) => parseSinceVersion(v) && v !== cur)[2];   // 지금 판보다 세 판쯤 앞
    const res = await fetch(`${base}?from=${older}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['current', 'from', 'notes', 'truncated'], '응답 모양(옛 판 창이 부르는 계약)');
    assert.equal(body.current, cur);
    assert.equal(body.from, older);
    assert.ok(body.notes.length >= 1);
    for (const n of body.notes) {
      assert.deepEqual(Object.keys(n).sort(), ['date', 'notes', 'title', 'version']);
      assert.ok(W.cmpVersion(n.version, older) > 0 && W.cmpVersion(n.version, cur) <= 0, `${n.version} 은 (from, current] 안`);
    }
    assert.deepEqual(body.notes, notesSince(all, older, cur).notes, '라우트 = notesSince(listNotes)');
  } finally { srv.close(); }
});

test('③ 웹과 대조 — 경로 글자 · 버전 판정이 같다', () => {
  const src = stripComments(read('../src/routes/api/searchNotes.js'));
  assert.ok(src.includes(`api.get('${W.SINCE_PATH}'`), `서버 라우트 = 웹 SINCE_PATH(${W.SINCE_PATH})`);
  for (const v of ['2.999.0', ' 2.999.0 ', '10.0.0', '1.2', 'a.b.c', '1.2.3-x', '', '9999.99999.999999', '99999.0.0', `${'1'.repeat(40)}`]) {
    assert.equal(W.normVersion(v), parseSinceVersion(v), `같은 입력 같은 판정: '${v}'`);
  }
});

test('④ 오류 상자는 주 번들 — lazy · 동적 import 없음 · App 은 ErrorBoundary 를 정적 import', () => {
  for (const rel of ['../../web/src/components/ErrorBoundary.jsx', '../../web/src/components/UpgradeNotice.jsx', '../../web/src/upgradeNotice.js']) {
    const s = stripComments(read(rel));
    assert.ok(!/\blazy\s*\(/.test(s) && !/\bimport\s*\(/.test(s), `${rel}: 옛 판 창은 lazy 청크를 못 받을 수 있다`);
  }
  const app = stripComments(read('../../web/src/App.jsx'));
  assert.match(app, /^import ErrorBoundary from '\.\/components\/ErrorBoundary\.jsx';$/m);
  assert.match(app, /import \{ noteServerVersion, UPGRADE_TITLE \} from '\.\/upgradeNotice\.js';/);
  // 빌드 값의 글자 — vite define 키와 upgradeNotice.js 가 읽는 글자가 같다(?. 을 넣으면 바뀌지 않는다)
  const vite = read('../../web/vite.config.js');
  assert.ok(vite.includes("'import.meta.env.VITE_APP_VERSION'"), 'vite define 키');
  assert.ok(stripComments(read('../../web/src/upgradeNotice.js')).includes('import.meta.env.VITE_APP_VERSION)'), 'upgradeNotice.js 가 같은 글자를 읽는다');
});
