/**
 * copyText.test.js — 클립보드 복사의 폴백 판정(v3.10.1).
 *  ① 보안 문맥 + Clipboard API → API 로 복사하고 textarea 를 만들지 않는다.
 *  ② HTTP(isSecureContext false)이거나 API 가 없으면 textarea + execCommand('copy').
 *  ③ API 가 던지면 폴백한다. 둘 다 안 되면 false(조용히 true 를 돌려주지 않는다). 붙인 textarea 는 늘 뗀다.
 */
import { describe, it, expect } from 'vitest';
import { copyText } from './copyText.js';

function fakeDoc({ execResult = true, execThrows = false } = {}) {
  const body = { kids: [], appendChild(n) { this.kids.push(n); }, removeChild(n) { this.kids = this.kids.filter((k) => k !== n); } };
  const made = [];
  return {
    body, made, execCalls: 0,
    createElement(tag) { const el = { tag, value: '', style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, select() { this.selected = true; } }; made.push(el); return el; },
    execCommand(cmd) { this.execCalls += 1; if (execThrows) throw new Error('x'); return cmd === 'copy' ? execResult : false; },
  };
}

describe('copyText', () => {
  it('① 보안 문맥이면 Clipboard API', async () => {
    const got = [];
    const doc = fakeDoc();
    const ok = await copyText('server/src/util/x.js', { nav: { clipboard: { writeText: async (s) => { got.push(s); } } }, doc, win: { isSecureContext: true } });
    expect(ok).toBe(true);
    expect(got).toEqual(['server/src/util/x.js']);
    expect(doc.made.length).toBe(0);
  });

  it('② HTTP 에서는 textarea + execCommand 로', async () => {
    const doc = fakeDoc();
    const nav = { clipboard: { writeText: async () => { throw new Error('API 를 부르면 안 된다'); } } };
    expect(await copyText('a', { nav, doc, win: { isSecureContext: false } })).toBe(true);
    expect(doc.execCalls).toBe(1);
    expect(doc.made[0].value).toBe('a');
    expect(doc.made[0].selected).toBe(true);
    expect(doc.body.kids.length).toBe(0); // 붙인 것을 뗐다
    // API 자체가 없어도 같다.
    const doc2 = fakeDoc();
    expect(await copyText('b', { nav: {}, doc: doc2, win: {} })).toBe(true);
    expect(doc2.made[0].value).toBe('b');
  });

  it('③ API 가 던지면 폴백 · 둘 다 안 되면 false', async () => {
    const doc = fakeDoc();
    const nav = { clipboard: { writeText: async () => { throw new Error('denied'); } } };
    expect(await copyText('c', { nav, doc, win: { isSecureContext: true } })).toBe(true);
    expect(doc.execCalls).toBe(1);
    expect(await copyText('d', { nav: {}, doc: fakeDoc({ execResult: false }), win: {} })).toBe(false);
    const throwing = fakeDoc({ execThrows: true });
    expect(await copyText('e', { nav: {}, doc: throwing, win: {} })).toBe(false);
    expect(throwing.body.kids.length).toBe(0);
    expect(await copyText('f', { nav: {}, doc: {}, win: {} })).toBe(false); // document 가 없는 환경
    expect(await copyText(null, { nav: {}, doc: fakeDoc(), win: {} })).toBe(true);
  });
});
