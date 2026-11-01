// v2.846 U-1(Bareos 버그 점검 — 재현): fetchJson(경로, 쿼리, signal, 옵션) 의 **옵션을 두 번째 자리(쿼리)** 에 넣으면
//   시한 · 재시도가 기본값(20초 · 2회)이 되고 옵션이 쿼리스트링으로 붙는다(`?retries=0&timeoutMs=…` — 서버의 `refresh === '1'` 판정까지 깨졌다).
//   v2.845 법인별 Bareos · 계정 통합 화면 5곳이 그랬다(Director 인증 실패면 한 번 누를 때 로그인 3번). 소스 스윕으로 막는다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') files(p, out); } else if (/\.(jsx?|mjs)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}
/** 호출 괄호 안의 두 번째 인자 글자(괄호 깊이 0 의 쉼표로 나눈다). */
function secondArg(s, i) {
  let d = 0; const args = []; let cur = '';
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if ('([{'.includes(c)) d += 1;
    if (')]}'.includes(c)) { if (d === 0) break; d -= 1; }
    if (c === ',' && d === 0) { args.push(cur); cur = ''; if (args.length === 2) break; continue; }
    cur += c;
  }
  if (args.length < 2) args.push(cur);
  return (args[1] || '').trim();
}
/** 옵션처럼 보이는 두 번째 인자 — retries/timeoutMs 키가 있는 객체 글자 · 옵션 상수 이름(GET · *_GET). */
export function misplacedOptions(src) {
  const hits = [];
  const re = /\bfetchJson\(/g;
  let m;
  while ((m = re.exec(src))) {
    const a2 = secondArg(src, m.index + m[0].length);
    if (/^\{[^}]*\b(retries|timeoutMs)\s*:/.test(a2) || /^[A-Z][A-Z_]*GET$/.test(a2) || a2 === 'GET') hits.push({ line: src.slice(0, m.index).split('\n').length, arg: a2.slice(0, 60) });
  }
  return hits;
}

describe('fetchJson 옵션은 네 번째 자리(v2.846 U-1)', () => {
  it('스윕이 실제로 잡는다(변이 검증)', () => {
    expect(misplacedOptions("fetchJson('/a', { retries: 0 })").length).toBe(1);
    expect(misplacedOptions('fetchJson(`/a${x}`, GET).then(f)').length).toBe(1);
    expect(misplacedOptions("fetchJson('/a', DIRECTOR_GET)").length).toBe(1);
    expect(misplacedOptions("fetchJson('/a', {}, undefined, { retries: 0 })").length).toBe(0);
    expect(misplacedOptions("fetchJson('/a', refresh ? { refresh: 1 } : {}, undefined, GET)").length).toBe(0);
    expect(misplacedOptions("fetchJson('/a', { vcenterId: id, limit: 5 })").length).toBe(0);
  });
  it('web/src 전체에 옵션을 쿼리 자리에 넣은 호출이 없다', () => {
    const bad = [];
    for (const f of files(SRC)) for (const h of misplacedOptions(fs.readFileSync(f, 'utf8'))) bad.push(`${path.relative(SRC, f)}:${h.line} ${h.arg}`);
    expect(bad, bad.join('\n')).toEqual([]);
  });
});
