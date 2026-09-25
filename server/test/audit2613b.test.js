/**
 * audit2613b.test.js — v2.613 아키텍처 점검 수정 그룹 G2(웹 공용 모듈·화면 규약) 중 **서버 쪽 스윕** 2건(WEB2613-11 b·c).
 * 나머지 G2 항목(WEB2613-01/02/03/08/09/10/12 · DEPS2613-11)은 웹 vitest `web/src/views/audit2613b.test.js` 가 고정한다.
 *
 * 주석은 `_stripComments.js` 로 먼저 지운다 — 규칙을 설명하는 주석이 통과 근거가 되면 안 된다(v2.535 규약).
 * 허용 목록은 **파일 · 개수 · 사유**를 열거한다(`length >= N` 검사는 추가를 잊은 것을 못 잡는다 — v2.574 규약).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../../web/src');
const SRC = path.resolve(HERE, '../src');

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(js|jsx)$/.test(e.name) && !/\.test\.(js|jsx)$/.test(e.name)) acc.push(p);
  }
  return acc;
}
const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');

/* ── WEB2613-11(b): JSX 인라인 textTransform: 'uppercase' 스윕 ─────────────────────────────────
 * `audit2575.test.js` 는 CSS 선택자(styles.css·v4.css·console.css)만 본다 — JSX 인라인 스타일은 대상 밖이었다.
 * 제품명·단위의 대소문자는 정보다(v2.575 BUG-13 — vCenter→VCENTER · kWh→KWH). 허용은 **고정 장식 라벨**뿐이고
 * 값(`{children}`·`{label}`)이 들어가는 자리면 사유를 적어야 한다.
 */
const UPPER_ALLOW = new Map([
  ['views/About.jsx', { count: 3, why: '고정 한글 소제목(저작자·저작권·주요 기능) — 한글에 대문자화는 무연산' }],
  ['views/tools/StorageGrowthTool.jsx', { count: 1, why: "고정 영문 보고서 제목 'Storage Growth Report' — 값 아님" }],
  ['views/tools/serverTemp/ServerTempBoard.jsx', { count: 1, why: "시안 B 장식 라벨 'Sampling …'(고정 문구 + 시각·숫자) — 값 아님" }],
  ['views/tools/serverTemp/parts.jsx', { count: 1, why: 'MonoLabel(시안 B) — 호출 3곳 전부 고정 한글 문구(ServerTempBoard:289,316 · parts.jsx:95). ⚠ 장비·vCenter 이름을 넣지 말 것' }],
]);
test('WEB2613-11(b) JSX 인라인 textTransform: uppercase 는 허용 목록(고정 장식 라벨)에만 있다', () => {
  const seen = new Map();
  for (const f of walk(WEB)) {
    const body = stripComments(fs.readFileSync(f, 'utf8'));
    const n = (body.match(/textTransform:\s*['"]uppercase['"]/g) || []).length;
    if (n) seen.set(rel(WEB, f), n);
  }
  const bad = [];
  for (const [f, n] of seen) {
    const a = UPPER_ALLOW.get(f);
    if (!a) bad.push(`${f}: ${n}곳 — 허용 목록에 없다(제품명·단위가 대문자로 샌다. 장식 라벨이면 사유와 함께 목록에)`);
    else if (a.count !== n) bad.push(`${f}: ${n}곳(허용 ${a.count}) — 개수가 달라졌다`);
  }
  for (const f of UPPER_ALLOW.keys()) if (!seen.has(f)) bad.push(`${f}: 허용 목록에 있는데 사라졌다 — 목록에서 뺄 것`);
  assert.deepEqual(bad, []);
});

/* ── WEB2613-11(c): 서버가 만들어 웹 BoldText 로 그려지는 문구 모듈 — 백틱 0 ───────────────────────
 * 웹 `views/uiText.test.js` 는 `web/src` 만 훑는다. 서버 문구는 기능별 테스트 7벌이 파일 하나씩 검사해 **새 문구 모듈은
 * 자동으로 검사되지 않았다**. 여기서는 이름 규약(`*Text.js`·`*Advice.js`·`remedy.js`·`*Remedy.js`·`*Findings.js`)으로
 * 모듈을 **열거**해 한 번에 본다 — 새 문구 모듈이 이 이름 규약을 따르면 자동으로 검사된다.
 * 검출 규칙은 uiText.test.js 와 같다(템플릿 리터럴 안의 이스케이프된 백틱 = 출력에 백틱이 남는 형태) + 홑따옴표
 * 문자열이 백틱으로 시작하는 형태(`'\`cmd\` …'` — audit2590 규약). 넓은 정규식은 중첩 템플릿에서 오탐한다(v2.576).
 */
function escapedBackticks(body) {
  const hits = [];
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '`') continue;
    let b = 0; let j = i - 1;
    while (j >= 0 && body[j] === '\\') { b += 1; j -= 1; }
    if (b % 2 === 1) hits.push(body.slice(0, i).split('\n').length);
  }
  return hits;
}
const TEXT_MODULE_RE = /(Text|Advice|Remedy|Findings)\.js$|(^|\/)remedy\.js$/;
// 허용: BoldText 가 아니라 **<code>/<pre> 로 그려지는** 셸 명령 인용(백틱이 곧 표기다). 새 항목은 소비처가 <code> 임을 확인하고 사유를 적을 것.
const BACKTICK_ALLOW = new Map([
  ['relaycheck/remedy.js', 'steps[] 는 web RelayCheckTool.jsx:142 가 <code> 로 그린다(BoldText 아님) — 셸 명령 인용'],
]);
test('WEB2613-11(c) 서버 문구 모듈(*Text·*Advice·remedy·*Findings)에 화면으로 새는 백틱이 0건', () => {
  const files = walk(SRC).filter((f) => TEXT_MODULE_RE.test(rel(SRC, f)) && !BACKTICK_ALLOW.has(rel(SRC, f)));
  for (const f of BACKTICK_ALLOW.keys()) assert.ok(fs.existsSync(path.join(SRC, f)), `${f}: 허용 목록 항목이 사라졌다 — 목록에서 뺄 것`);
  assert.ok(files.length >= 6, `문구 모듈 열거 ${files.length}개 — 이름 규약이 바뀌었으면 정규식을 고칠 것: ${files.map((f) => rel(SRC, f)).join(', ')}`);
  const bad = [];
  for (const f of files) {
    const body = stripComments(fs.readFileSync(f, 'utf8'));
    for (const ln of escapedBackticks(body)) bad.push(`${rel(SRC, f)}:${ln} 템플릿 리터럴 안 백틱`);
    for (const m of body.matchAll(/'`[A-Za-z가-힣]/g)) bad.push(`${rel(SRC, f)}:${body.slice(0, m.index).split('\n').length} 홑따옴표 문자열 안 백틱`);
  }
  assert.deepEqual(bad, [], 'BoldText 는 **강조** 만 해석한다 — 백틱은 화면에 글자로 샌다. 값 인용은 홑화살괄호 ‘ ’ 로');
  // 스윕이 실제로 동작한다(변이 검증)
  assert.equal(escapedBackticks('const s = `원 명령 \\`a\\` 대신`;').length, 2);
  assert.equal(escapedBackticks('t.startsWith(`${sel}\\\\`)').length, 0);
});
