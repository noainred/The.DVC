/**
 * apiDoc2563.test.js — **API 문서 생성기의 스캐너**를 고정한다(v2.563).
 *
 * ⚠⚠ **이 테스트가 보는 것은 '문서가 최신인가' 가 아니라 '스캐너가 이 형태들을 여전히
 * 잡는가' 다.** `docsGen2452.test.js` 머리말이 기록한 사고가 그 이유다 — 정규식이 못 잡는
 * 형태가 생기면 항목이 **조용히 사라지는데 생성은 성공**해 CI 의 `--check` 도 통과했다
 * (환경변수 28개·가장 큰 DB 2개가 그렇게 빠져 있었다).
 *
 * v2.563 초판을 만들며 스캐너가 실제로 틀렸던 것 셋 — 전부 아래에 고정한다:
 *   ① 가드 없이 바로 핸들러인 라우트(`api.get('/x', (req, res) => …)`)를 **35건 놓쳤다**.
 *      `(req, res)` 의 쉼표가 깊이 2 라 인자 경계로 잡히지 않아 핸들러 본문을 끝까지 읽다가
 *      상한에 걸렸다.
 *   ② `req.get('host')`(요청 헤더 읽기)를 **라우트로 34건 잘못 셌다**. 없는 엔드포인트를
 *      문서에 싣는 것은 누락만큼 나쁘다 — 읽는 사람이 있지도 않은 경로를 호출한다.
 *   ③ 라우트 인자 사이 **주석 한 줄이 게이트 이름으로** 표에 실렸다(v2.535 '주석을 먼저
 *      제거하고 검사할 것' 과 같은 규칙).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SRC = path.join(ROOT, 'server/src');
const DOCS = path.join(ROOT, 'docs');
const read = (p) => fs.readFileSync(p, 'utf8');

const API_MD = read(path.join(DOCS, 'API.md'));

/** 표의 데이터 행만 뽑는다: `| GET | \`/x\` | 게이트 | [file:line](..) |` */
function rows(md) {
  const out = [];
  for (const line of md.split('\n')) {
    const m = /^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]*)`\s*\|\s*(.*?)\s*\|\s*\[([^\]]+)\]/.exec(line);
    if (m) out.push({ method: m[1], sub: m[2], guard: m[3], src: m[4] });
  }
  return out;
}
const ROWS = rows(API_MD);

/* ── 문서가 최신인가(가장 기본) ─────────────────────────────────────────────── */

test('docs/API.md 가 최신이다 — 생성기 --check 통과', () => {
  const r = spawnSync(process.execPath, ['scripts/api-doc.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `문서가 낡았습니다. 'node scripts/api-doc.mjs' 를 실행하세요.\n${r.stderr}`);
});

/* ── ① 가드 없는 라우트를 놓치지 않는다 ─────────────────────────────────────── */

test('가드 없이 바로 핸들러인 라우트가 문서에 있다(초판이 35건 놓쳤던 형태)', () => {
  /*
   * 소스에서 `xxx.get('/path', (req, res)` 또는 `async (req, res)` 형태를 찾아
   * 그 경로가 문서에 실제로 실렸는지 본다. 이 형태가 이 저장소의 **다수**라,
   * 놓치면 문서가 통째로 못 만들어지거나 절반이 빈다.
   */
  const src = read(path.join(SRC, 'routes/api/inventory.js'));
  const m = /\bapi\.get\('([^']+)'\s*,\s*(async\s*)?\(/.exec(src);
  assert.ok(m, 'inventory.js 에서 가드 없는 라우트를 찾지 못했다 — 표본을 바꾸세요');
  assert.ok(ROWS.some((r) => r.sub === m[1]),
    `가드 없는 라우트 '${m[1]}' 가 문서에 없습니다 — 핸들러 조기 종료가 깨졌습니다`);

  // 그리고 그런 라우트가 '몇 개쯤' 있어야 한다(한두 개만 잡히면 그것도 결함이다).
  const noGuard = ROWS.filter((r) => r.guard === '—');
  assert.ok(noGuard.length >= 50, `가드 없는 라우트가 ${noGuard.length}건뿐입니다 — 스캐너가 삼키고 있습니다`);
});

/* ── ② 라우트가 아닌 것을 세지 않는다 ───────────────────────────────────────── */

test('문서의 모든 행이 실제 라우트 선언이다 — 비-라우트 0건', () => {
  /*
   * ⚠ **경로 문자열만 보고 판단하면 안 된다**: `/api/capacity/host` 는 **실재하는 라우트**이고
   *   `req.get('host')` 는 헤더 읽기다 — 문자열이 같다. 초판 테스트가 이것으로 오탐했다
   *   (그 오탐을 이 테스트가 스스로 잡았다). 그래서 **행이 가리키는 소스 줄을 실제로 열어**
   *   라우터 메서드 호출인지 확인한다.
   */
  const bad = [];
  for (const r of ROWS) {
    const i = r.src.lastIndexOf(':');
    const f = r.src.slice(0, i); const ln = Number(r.src.slice(i + 1));
    const text = (read(path.join(ROOT, f)).split('\n')[ln - 1]) || '';
    if (/\breq\.(get|post|put|patch|delete)\(/.test(text)) { bad.push(`${r.src} → 헤더 읽기: ${text.trim().slice(0, 70)}`); continue; }
    if (!/\.(get|post|put|patch|delete)\(\s*'/.test(text)) bad.push(`${r.src} → 라우트 선언이 아님: ${text.trim().slice(0, 70)}`);
  }
  assert.deepEqual(bad, [], `라우트가 아닌 행이 문서에 있습니다:\n  ${bad.join('\n  ')}`);

  // 소스에 `req.get(…)` 표본이 실제로 있어야 이 테스트가 뜻을 가진다.
  const all = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) walk(q);
      else if (e.name.endsWith('.js')) all.push(q);
    }
  };
  walk(path.join(SRC, 'routes'));
  const n = all.reduce((acc, f) => acc + [...read(f).matchAll(/\breq\.get\('/g)].length, 0);
  assert.ok(n >= 10, `req.get(…) 표본이 ${n}건뿐입니다 — 이 테스트가 무의미해졌는지 확인하세요`);

  for (const r of ROWS) {
    assert.ok(r.sub === '' || r.sub.startsWith('/'), `경로 형태가 아님: ${r.method} ${r.sub} (${r.src})`);
  }
});

test('엔드포인트 수가 독립 계수와 일치한다', () => {
  // 생성기와 **다른 방법**으로 센다 — 같은 정규식을 쓰면 대조의 뜻이 없다.
  const declared = /\| 엔드포인트 \| \*\*(\d+)개\*\* \|/.exec(API_MD);
  assert.ok(declared, '요약의 엔드포인트 수를 찾지 못했다');
  assert.equal(ROWS.length, Number(declared[1]),
    `요약(${declared[1]})과 표의 행 수(${ROWS.length})가 다릅니다`);
  const byMethod = {};
  for (const r of ROWS) byMethod[r.method] = (byMethod[r.method] || 0) + 1;
  for (const [mth, n] of Object.entries(byMethod)) {
    const d = new RegExp(`\\| ${mth} \\| (\\d+)개 \\|`).exec(API_MD);
    assert.ok(d, `${mth} 요약이 없습니다`);
    assert.equal(Number(d[1]), n, `${mth}: 요약 ${d[1]} vs 표 ${n}`);
  }
});

/* ── ③ 주석·전개 연산자가 게이트로 새지 않는다 ──────────────────────────────── */

test('게이트 열에 주석·전개 연산자가 새지 않는다', () => {
  for (const r of ROWS) {
    assert.ok(!r.guard.includes('//'), `주석이 게이트로 실렸습니다: ${r.src} → ${r.guard.slice(0, 60)}`);
    assert.ok(!r.guard.includes('/*'), `블록 주석이 게이트로 실렸습니다: ${r.src}`);
    assert.ok(!r.guard.includes('...'), `전개 연산자가 해석되지 않았습니다: ${r.src} → ${r.guard}`);
  }
});

/* ── 별칭 해석 — 같은 파일 · 다른 파일 ──────────────────────────────────────── */

test('같은 파일의 가드 별칭을 해석한다(adminOnly → 역할)', () => {
  // `const adminOnly = requireRole('admin')` 를 쓰는 라우트가 '역할 admin' 으로 나와야 한다.
  const adminRows = ROWS.filter((r) => /역할 `admin`/.test(r.guard));
  assert.ok(adminRows.length >= 100,
    `별칭 해석 결과가 ${adminRows.length}건뿐입니다 — adminOnly 해석이 깨졌습니다`);
  // 별칭 '이름 그대로' 가 남아 있으면 안 된다.
  assert.ok(!ROWS.some((r) => /`adminOnly`/.test(r.guard)), 'adminOnly 가 해석되지 않고 이름으로 남았습니다');
});

test('다른 파일의 export 별칭까지 해석한다(svcmon canEdit → admin/operator)', () => {
  const shared = read(path.join(SRC, 'routes/svcmon/shared.js'));
  assert.match(shared, /export const canEdit = requireRole\('admin', 'operator'\)/,
    'canEdit 정의가 바뀌었습니다 — 이 테스트를 갱신하세요');
  assert.ok(!ROWS.some((r) => /`canEdit`/.test(r.guard)),
    'canEdit 가 해석되지 않고 이름으로 남았습니다(import 추적이 깨졌습니다)');
  assert.ok(ROWS.some((r) => r.src.includes('svcmon/') && /역할 `admin\/operator`/.test(r.guard)),
    'svcmon 라우트의 역할이 표시되지 않습니다');
});

/* ── 선언 줄에 안 보이는 게이트(마운트·라우터 수준) ─────────────────────────── */

test('마운트 수준 게이트를 상속한다(/api/svcmon → requirePerm(svcmon))', () => {
  const idx = read(path.join(SRC, 'index.js'));
  assert.match(idx, /app\.use\('\/api\/svcmon',[^)]*requirePerm\('svcmon'\)/,
    '마운트가 바뀌었습니다 — 이 테스트를 갱신하세요');
  const sec = section(API_MD, '/api/svcmon');
  assert.match(sec, /\*\*공통 게이트\*\*.*requirePerm\('svcmon'\)/,
    '/api/svcmon 의 마운트 게이트가 문서에 없습니다 — "인증만 하면 된다" 는 거짓이 됩니다');
});

test('라우터 수준 use() 게이트를 상속한다(/api/capacity → admin)', () => {
  const cap = read(path.join(SRC, 'routes/capacity.js'));
  assert.match(cap, /capacityRouter\.use\(adminOnly\)/, 'capacity 라우터 가드가 바뀌었습니다');
  const sec = section(API_MD, '/api/capacity');
  assert.match(sec, /\*\*공통 게이트\*\*.*role:admin/,
    '/api/capacity 의 라우터 수준 adminOnly 가 문서에 없습니다');
});

function section(md, group) {
  const i = md.indexOf(`## \`${group}\``);
  assert.ok(i >= 0, `문서에 ${group} 구획이 없습니다`);
  const j = md.indexOf('\n## ', i + 1);
  return md.slice(i, j < 0 ? md.length : j);
}

/* ── 용어집: 뜻 모르는 게이트를 숨기지 않는다 ───────────────────────────────── */

test('게이트 용어집에 뜻 모르는 이름이 없다(있으면 문서가 스스로 밝힌다)', () => {
  assert.match(API_MD, /## 게이트 헬퍼 용어집/, '용어집 구획이 사라졌습니다');
  /*
   * ⚠ 이 단언은 '경고 문구가 없어야 한다' 가 아니라 **'지금은 전부 설명돼 있다'** 를 고정한다.
   *   새 가드 헬퍼가 생기면 이 테스트가 깨지고, 그때 `GUARD_NOTE` 에 뜻을 적으면 된다.
   *   경고 문구 자체는 **남겨 두어야 한다** — 설명을 못 붙인 채로 문서가 나가는 것이
   *   조용히 '가드 없음' 으로 보이는 것보다 낫다.
   */
  assert.ok(!/뜻을 모르는 게이트 \*\*\d+개\*\*/.test(API_MD),
    '뜻을 모르는 게이트가 있습니다 — scripts/api-doc.mjs 의 GUARD_NOTE 에 설명을 추가하세요');
});

/* ── 공개 API 문서가 실제 허용 목록과 일치한다 ──────────────────────────────── */

test('API-PUBLIC.md 가 실제 공개 엔드포인트·분류와 일치한다', async () => {
  const { ENDPOINTS, GROUP_KEYS } = await import('../src/publicapi/allowlist.js');
  const pub = read(path.join(DOCS, 'API-PUBLIC.md'));
  for (const ep of ENDPOINTS) {
    assert.ok(pub.includes(ep.path), `API-PUBLIC.md 에 '${ep.path}' 설명이 없습니다`);
    // 선언 필드가 문서에 하나도 안 보이면 그 구획이 비어 있는 것이다.
    const hit = ep.fields.filter((f) => pub.includes(f)).length;
    assert.ok(hit >= Math.ceil(ep.fields.length / 2),
      `'${ep.path}' 의 필드가 문서에 ${hit}/${ep.fields.length} 개만 있습니다`);
  }
  for (const g of GROUP_KEYS) {
    assert.ok(pub.includes(`\`${g}\``), `분류 '${g}' 가 API-PUBLIC.md 에 없습니다`);
  }
  // 공개된 적 없는 경로를 안내하지 않는다(있지도 않은 것을 호출하게 만들지 않기 위해).
  for (const m of pub.matchAll(/`GET \/(inventory|capacity|faults|portal)\/([a-z-]+)`/g)) {
    const p = `/${m[1]}/${m[2]}`;
    assert.ok(ENDPOINTS.some((e) => e.path === p), `API-PUBLIC.md 가 없는 경로 '${p}' 를 안내합니다`);
  }
});

/* ── 문서 상호 링크 ────────────────────────────────────────────────────────── */

test('새 문서 3종이 INDEX 에 등재돼 있다', () => {
  const idx = read(path.join(DOCS, 'INDEX.md'));
  for (const f of ['API.md', 'API-PUBLIC.md', 'ARCHITECTURE.md']) {
    assert.ok(idx.includes(f), `docs/INDEX.md 에 ${f} 가 없습니다 — 아무도 찾지 못합니다`);
  }
});

test('생성 문서에 "직접 고치지 마세요" 경고가 있다', () => {
  assert.match(API_MD, /직접 고치지 마세요/, '생성 문서 경고가 사라졌습니다 — 손으로 고친 내용이 다음 생성에서 날아갑니다');
});
