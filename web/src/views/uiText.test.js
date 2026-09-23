/**
 * uiText.test.js — 화면 문구 계약 전수 스윕(v2.576).
 *
 * ⚠⚠ 왜 전수 스윕인가: `BoldText` 는 **`**강조**` 만** 해석한다. 문구에 백틱을 쓰면 그 문자가
 * 화면에 **그대로 보인다**. CLAUDE.md 는 이 사고를 v2.439·v2.440·v2.505·v2.545·v2.553 에 **다섯 번**
 * 기록했고, 그때마다 **그 파일 하나만** 고쳤다(v2.553 의 테스트는 `settingsCheckText` 만 검사한다).
 * v2.576 전수 조사에서 **여섯 번째**로 6곳이 남아 있는 것을 찾았다 —
 * `sanHealthText.cmdNote`(BoldText 렌더) · `bulkIoText.tokenHint`(plain) ·
 * `UnityCapacityPlanPanel` 의 `sub` prop(plain) · `CurrentUsersSettings`(BoldText) ·
 * `curUserText.agentGuide` 2줄(`<li>{g}</li>`). 목록을 늘리는 방식이면 또 빠지므로 스윕이다.
 *
 * 검출 규칙: **템플릿 리터럴 안의 이스케이프된 백틱** — 앞선 백슬래시 연속 개수가 **홀수**인
 * 백틱이다. 출력에 리터럴 백틱이 남는 형태이고, `` `${x}\\` ``(백슬래시 짝수 = 경로 문자열,
 * SvcMonitor 의 Windows 경로)는 대상이 아니다. 주석은 먼저 제거한다 — 규칙을 설명하는 주석이
 * 통과 근거가 되면 안 된다(v2.535 규약).
 *
 * ⚠ 정직 기록 — 이 스윕이 못 잡는 형태: `return '\u0060host=\u0060 값'` 처럼 **홑따옴표 문자열 안에
 * 그냥 넣은** 백틱. 그 형태까지 정규식으로 잡아 보았더니 중첩 템플릿 리터럴
 * (`` `평균 ${x == null ? '—' : `${x}%`}` ``)에서 **오탐 30여 건**이 나왔다 — 오탐이 있는 스윕은
 * 곧 무력화되므로 채택하지 않았다. 지금 이 저장소에는 그 형태가 0건이다(v2.576 확인).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VIEWS = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(VIEWS, '..');

/** 주석만 지우고 **개행은 보존**한다 — 지우면 줄 번호가 밀려 엉뚱한 줄을 지목한다(v2.574 규약). */
function stripComments(s) {
  let out = ''; let i = 0;
  const N = s.length;
  while (i < N) {
    const c = s[i]; const d = s[i + 1];
    if (c === '/' && d === '*') { const e = s.indexOf('*/', i + 2); const seg = s.slice(i, e < 0 ? N : e + 2); out += seg.replace(/[^\n]/g, ''); i = e < 0 ? N : e + 2; continue; }
    if (c === '/' && d === '/') { const e = s.indexOf('\n', i); const seg = s.slice(i, e < 0 ? N : e); out += seg.replace(/[^\n]/g, ''); i = e < 0 ? N : e; continue; }
    out += c; i += 1;
  }
  return out;
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(js|jsx)$/.test(e.name) && !/\.test\.(js|jsx)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

/** 이스케이프된 백틱(앞선 백슬래시 연속 개수가 홀수) 위치. */
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

const FILES = walk(SRC);

describe('화면 문구에 백틱 금지 (v2.576 — 여섯 번째 재발 차단)', () => {
  it('★ web/src 전체에서 UI 문자열 안 리터럴 백틱이 0건이다', () => {
    const bad = [];
    for (const f of FILES) {
      const body = stripComments(fs.readFileSync(f, 'utf8'));
      const rel = path.relative(SRC, f);
      for (const ln of escapedBackticks(body)) bad.push(`${rel}:${ln}`);
    }
    expect(bad, `BoldText 는 \`**강조**\` 만 해석한다 — 백틱은 화면에 글자로 샌다. 값 인용은 홑화살괄호 ‘ ’ 로.\n${bad.join('\n')}`).toEqual([]);
  });

  it('★ 스윕이 실제로 동작한다(변이 검증) — 백틱을 넣으면 잡힌다', () => {
    expect(escapedBackticks('const s = `원 명령 \\`a\\` 대신`;').length).toBe(2);
    // Windows 경로(백슬래시 짝수)는 대상이 아니다 — 오탐을 만들면 스윕이 곧 비활성화된다.
    expect(escapedBackticks('t.path.startsWith(`${sel}\\\\`)').length).toBe(0);
  });
});

/**
 * JSX **텍스트 노드**에 쓴 `**강조**`(v2.583 감사 #37). 텍스트 노드는 BoldText 를 거치지 않으므로 별표가 그대로
 * 보인다(v2.583 에 LinkCheck·RemoteCommand·CurrentUsersSettings·EmptyInvModal 4곳). 규칙: `>` 와 `<`/`{` 사이의
 * 텍스트에 `**X**` 가 있으면 결함이다. 문자열(따옴표·템플릿) 안의 `**` 는 대상이 아니다 — 그것은 BoldText 로
 * 렌더되는 문구 모듈의 정상 형태다(그쪽의 plain 렌더는 호출부를 봐야 해서 이 스윕으로 못 잡는다 — 정직 기록).
 */
function jsxTextBold(body) {
  const hits = [];
  const re = /[>}]([^<>{}`'"]*\*\*[^*<>{}`'"]+\*\*[^<>{}`'"]*)(?=[<{])/g;
  let m;
  while ((m = re.exec(body))) hits.push(body.slice(0, m.index).split('\n').length);
  return hits;
}

describe('JSX 텍스트 노드에 **강조** 금지 (v2.583 — BoldText 밖의 별표)', () => {
  it('★ .jsx 파일의 JSX 텍스트 노드에 **X** 가 0건이다', () => {
    const bad = [];
    for (const f of FILES.filter((x) => x.endsWith('.jsx'))) {
      const body = stripComments(fs.readFileSync(f, 'utf8'));
      for (const ln of jsxTextBold(body)) bad.push(`${path.relative(SRC, f)}:${ln}`);
    }
    expect(bad, `JSX 텍스트는 BoldText 를 거치지 않는다 — <b> 를 쓰거나 BoldText 로 감쌀 것.\n${bad.join('\n')}`).toEqual([]);
  });
  it('★ 스윕이 실제로 동작한다(변이 검증)', () => {
    expect(jsxTextBold('<div>저장 상한으로 **잘린** 기록입니다.</div>').length).toBe(1);
    expect(jsxTextBold('<div>{src.x} 추이가 **저장되지 않습니다**{e}</div>').length).toBe(1);
    expect(jsxTextBold("<BoldText text={'**굵게**'} />").length).toBe(0);
    expect(jsxTextBold('<b>굵게</b>').length).toBe(0);
  });
});
