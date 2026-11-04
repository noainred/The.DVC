/**
 * wiki/diff.js — 두 판의 줄 단위 비교(순수, v2.881). 버전 이력 화면의 '원문 비교' 가 쓴다.
 *
 * LCS(최장 공통 부분열)를 줄 해시로 구한다. 본문 상한(64KB)이라 줄 수가 많아야 수천 줄 — 그래도 O(n·m) 표를 무작정 만들지 않게
 * 앞뒤의 같은 줄을 먼저 떼고(대부분의 편집은 가운데 일부만 바꾼다) 남은 부분이 MAX_CELLS 를 넘으면 '너무 커서 줄 단위로만 앞뒤 비교'
 * 로 내려간다(truncated:true — 화면이 밝힌다). 이벤트 루프를 수백 ms 막지 않기 위한 상한이다.
 */
export const MAX_CELLS = 4_000_000;

/**
 * @returns {{ ops: Array<{ op:'same'|'add'|'del', a:number|null, b:number|null, text:string }>, added:number, removed:number, truncated:boolean }}
 *   a · b 는 1부터 시작하는 줄 번호(없는 쪽은 null).
 */
export function lineDiff(from, to) {
  const A = String(from ?? '').split('\n');
  const B = String(to ?? '').split('\n');
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre += 1;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf += 1;
  const a = A.slice(pre, A.length - suf);
  const b = B.slice(pre, B.length - suf);
  const ops = [];
  for (let i = 0; i < pre; i += 1) ops.push({ op: 'same', a: i + 1, b: i + 1, text: A[i] });
  let truncated = false;
  if (a.length * b.length > MAX_CELLS) {
    truncated = true;
    for (let i = 0; i < a.length; i += 1) ops.push({ op: 'del', a: pre + i + 1, b: null, text: a[i] });
    for (let j = 0; j < b.length; j += 1) ops.push({ op: 'add', a: null, b: pre + j + 1, text: b[j] });
  } else {
    // dp[i][j] = a[i..] 와 b[j..] 의 LCS 길이(1차원 배열 두 줄로 — 메모리 O(m) 가 아니라 경로 복원이 필요해 전체 표를 둔다, 상한 안)
    const n = a.length; const m = b.length;
    const dp = new Array(n + 1);
    for (let i = 0; i <= n; i += 1) dp[i] = new Uint32Array(m + 1);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
    let i = 0; let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push({ op: 'same', a: pre + i + 1, b: pre + j + 1, text: a[i] }); i += 1; j += 1; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ op: 'del', a: pre + i + 1, b: null, text: a[i] }); i += 1; }
      else { ops.push({ op: 'add', a: null, b: pre + j + 1, text: b[j] }); j += 1; }
    }
    for (; i < n; i += 1) ops.push({ op: 'del', a: pre + i + 1, b: null, text: a[i] });
    for (; j < m; j += 1) ops.push({ op: 'add', a: null, b: pre + j + 1, text: b[j] });
  }
  for (let k = 0; k < suf; k += 1) ops.push({ op: 'same', a: A.length - suf + k + 1, b: B.length - suf + k + 1, text: A[A.length - suf + k] });
  let added = 0; let removed = 0;
  for (const o of ops) { if (o.op === 'add') added += 1; else if (o.op === 'del') removed += 1; }
  return { ops, added, removed, truncated };
}

/** 바뀐 줄 근처만(앞뒤 context 줄) — 화면이 긴 문서 전체를 그리지 않게. 사이는 { op:'gap', skipped } 하나로. */
export function hunks(ops, context = 3) {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => { if (o.op !== 'same') for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k += 1) keep[k] = true; });
  const out = [];
  let skipped = 0;
  ops.forEach((o, i) => {
    if (keep[i]) { if (skipped) { out.push({ op: 'gap', skipped }); skipped = 0; } out.push(o); } else skipped += 1;
  });
  if (skipped) out.push({ op: 'gap', skipped });
  return out;
}
