// 랙 실장도 3회차 점검(동시성 · 성능 축 2) + 2회차 반증(C3 나) — 등록 주소 치환(`replaceNeedles`)의 앞머리 색인 · 경계 규칙.
//   ① 느린 기준 구현(항목마다 모든 일치 자리 · 경계 규칙을 다른 방식으로 적음)과 무작위 대조 — 앞머리로 걸러도 결과가 같다(3자 미만 항목이 섞여도).
//   ② 길이 종류가 늘어도 일이 그만큼 늘지 않는다(비율 — 고치기 전에는 길이 종류 수에 비례했다: 96자 글 12,100개 4.9초 실측).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TM = await import('../src/rack/textMask.js');

const slow = (text, needles, repl) => {
  const low = text.toLowerCase();
  const hit = new Array(text.length).fill(false);
  const hostCh = (ch) => ch !== undefined && /[\p{L}\p{N}_-]/u.test(ch);
  for (const k of needles) {
    const free = k.length >= 6 && /[.:]/.test(k);
    for (let a = low.indexOf(k); a >= 0; a = low.indexOf(k, a + 1)) {
      if (!free && (hostCh(low[a - 1]) || hostCh(low[a + k.length]))) continue;
      for (let x = a; x < a + k.length; x += 1) hit[x] = true;
    }
  }
  let out = ''; let i = 0;
  while (i < text.length) {
    if (!hit[i]) { out += text[i]; i += 1; continue; }
    while (i < text.length && hit[i]) i += 1;
    out += repl;
  }
  return out;
};

test('앞머리 색인: 느린 기준 구현과 무작위 대조(짧은 항목 · 점 든 항목 · 겹침 · 맞닿음)', () => {
  let seed = 1126003;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const ALPHA = 'ab1.-:'; const GLUE = [' ', '-', '.', ':', '/', '(', ')', 'x', ''];
  const word = (n) => Array.from({ length: n }, () => ALPHA[rnd(ALPHA.length)]).join('');
  for (const min of [1, 3]) {
    for (let n = 0; n < 3000; n += 1) {
      const needles = [...new Set(Array.from({ length: 1 + rnd(5) }, () => word(min + rnd(8))))];
      let text = '';
      for (let w = 0; w < 1 + rnd(6); w += 1) text += (rnd(3) ? word(1 + rnd(7)) : needles[rnd(needles.length)].toUpperCase()) + GLUE[rnd(GLUE.length)];
      const idx = TM.needleIndexOf(needles, { min });
      const usable = needles.map((k) => k.trim().toLowerCase()).filter((k) => k.length >= min);
      assert.equal(TM.replaceNeedles(text, idx, '(X)'), slow(text, usable, '(X)'), `글 ${JSON.stringify(text)} · 항목 ${JSON.stringify(needles)} · min ${min}`);
    }
  }
});

test('앞머리 색인: 색인의 꼴 — 앞머리마다 그 묶음의 길이만(긴 것 먼저) · 3자 미만 항목이 있으면 앞머리도 짧아진다', () => {
  const a = TM.needleIndexOf(['idrac-a1.mgmt.example', 'idrac-b', '10.20.30.4', '10.20.30.41', 'kr1'], { min: 3 });
  assert.equal(a.headLen, 3);
  assert.deepEqual(a.heads.get('idr'), [21, 7]);
  assert.deepEqual(a.heads.get('10.'), [11, 10]);
  assert.deepEqual(a.heads.get('kr1'), [3]);
  assert.equal(a.heads.get('xyz'), undefined);
  const b = TM.needleIndexOf(['ab', 'abcdef.x'], { min: 1 });
  assert.equal(b.headLen, 2);
  assert.equal(TM.replaceNeedles('see abcdef.x and (ab)', b, '#'), 'see # and (#)');
  const e = TM.needleIndexOf([], { min: 3 });
  assert.equal(TM.replaceNeedles('anything', e, '#'), 'anything');
});

test('길이 종류가 60배 늘어도 치환 시간은 그만큼 늘지 않는다(비율)', () => {
  const texts = Array.from({ length: 1500 }, (_, i) => (`node-${i} rack kr-a${i % 90} spare server unit number ${i} `.repeat(4)).slice(0, 96));
  const few = TM.needleIndexOf(Array.from({ length: 2000 }, (_, i) => `zq${String(i).padStart(6, '0')}.mgmt`), { min: 3 });            // 길이 1종
  const many = TM.needleIndexOf(Array.from({ length: 2000 }, (_, i) => `zq${'y'.repeat(i % 60)}${String(i).padStart(6, '0')}.mgmt`), { min: 3 });   // 길이 60종
  assert.equal(few.lens.length, 1); assert.equal(many.lens.length, 60);
  const cost = (idx) => { let best = Infinity; for (let r = 0; r < 7; r += 1) { const t0 = process.hrtime.bigint(); for (const t of texts) TM.replaceNeedles(t, idx, '#'); best = Math.min(best, Number(process.hrtime.bigint() - t0)); } return best; };
  cost(few); cost(many);   // 예열
  const ratio = cost(many) / cost(few);
  assert.ok(ratio < 12, `길이 60종 / 1종 시간 비율 ${ratio.toFixed(1)} — 길이 종류에 비례하면 수십 배가 된다`);
});
