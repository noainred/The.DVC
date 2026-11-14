/**
 * 테스트 도우미 — 라우트 파일(주석 뗀 글)에서 `메서드 경로` → **펼친 미들웨어 이름 줄**을 만든다(sshAccess390 ⑪ · sshKeyLogin3100 ⑲ 가 같이 쓴다).
 *
 *  · `...ownerWrite` 같은 묶음은 그 파일의 `const 이름 = [ … ];` 로 펼친다.
 *  · `...write(fn)` 같은 **묶음 함수**는 `const 이름 = (fn) => [ … ];` 로 펼친다(안의 `pre(fn)` 은 'pre').
 *  · `pre((req) => …)` 처럼 인자가 있는 사전 검사는 이름만 남긴다('pre'). `approvePre(true)` · `jobPre('key-login')` 같은 짧은 것은 글자 그대로.
 * 승인 · 키 작업 라우트는 사전 검사를 OTP 앞에 끼우려고 묶음을 펼쳐 적으므로, 묶음 이름만 보는 스윕은 그것들을 조용히 건너뛴다(점검 A10).
 */
/** 괄호 밖의 쉼표로만 나눈다. */
export function splitTop(s) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of String(s)) {
    if ('([{'.includes(ch)) depth += 1;
    if (')]}'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const PRE_WITH_FN = /^pre\(/;
const norm = (x) => (PRE_WITH_FN.test(x) ? 'pre' : x);

export function routeChains(src) {
  const lists = new Map([...src.matchAll(/const (\w+) = \[([^\]]*)\];/g)].map((m) => [m[1], splitTop(m[2]).map(norm)]));
  const fns = new Map([...src.matchAll(/const (\w+) = \((\w+)\) => \[([^\]]*)\];/g)].map((m) => [m[1], splitTop(m[3]).map(norm)]));
  const out = new Map();
  for (const m of src.matchAll(/api\.(get|post|put|delete)\('([^']+)',\s*([^\n]*?),\s*(?:async\s*)?\(_?req, res\) =>/g)) {
    const chain = splitTop(m[3]).flatMap((x) => {
      if (!x.startsWith('...')) return [norm(x)];
      const name = x.slice(3);
      const call = /^(\w+)\(/.exec(name);
      if (call) return fns.get(call[1]) || [`?${x}`];
      return lists.get(name) || [`?${x}`];
    });
    out.set(`${m[1]} ${m[2]}`, chain);
  }
  return out;
}
