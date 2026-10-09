/**
 * I-01(2026-10-09 검토 보고서) — 공용 표 정렬이 음수 부호를 잃던 결함의 회귀.
 *
 * 원인: NUM_RE 의 `[-+]?` 가 캡처 그룹 밖이라 부호가 소비만 되고, sortKeyOf 는 숫자 캡처만 다시 조립했다.
 * 그래서 '-3' 이 +3 으로, '-2 GB' 가 +2e9 로 정렬됐다. STable 을 쓰는 모든 표(181개)에 걸린다.
 * 함께: 증가량 문구가 쓰는 유니코드 마이너스(U+2212 '−')와 '±0' 도 숫자로 읽는다.
 * 결측은 음수 sentinel 이 아니라 빈 값(kind 'empty')이어야 방향과 무관하게 맨 뒤로 간다.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { sortKeyOf, sortChildren } from './sortableText.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const h = React.createElement;
const row = (label, v) => h('tr', { key: label }, h('td', null, label), h('td', null, v));
const order = (rows) => rows.map((r) => r.props.children[0].props.children);

describe('I-01 부호 있는 숫자 정렬 키', () => {
  it('부호가 있는 정수·소수·콤마·단위·퍼센트', () => {
    expect(sortKeyOf('-3')).toEqual({ kind: 'num', v: -3 });
    expect(sortKeyOf('+3')).toEqual({ kind: 'num', v: 3 });
    expect(sortKeyOf('-1,234.5')).toEqual({ kind: 'num', v: -1234.5 });
    expect(sortKeyOf('-2 GB')).toEqual({ kind: 'num', v: -2e9 });
    expect(sortKeyOf('-0.5%')).toEqual({ kind: 'num', v: -0.5 });
    expect(sortKeyOf('-90 ms').v).toBeCloseTo(-0.09, 10);
    expect(sortKeyOf('-2분').v).toBe(-120);
    expect(sortKeyOf('—')).toEqual({ kind: 'empty', v: null });
  });
  it('유니코드 마이너스(−)와 ±0 — 증가량 화면의 표기', () => {
    expect(sortKeyOf('−27.6 TB')).toEqual({ kind: 'num', v: -27.6e12 });
    expect(sortKeyOf('−0.5%').v).toBe(-0.5);
    expect(sortKeyOf('±0').v).toBe(0);
    expect(sortKeyOf('-0').v === 0).toBe(true);
  });
  it('부호만 있거나 부호가 두 개면 숫자가 아니다', () => {
    expect(sortKeyOf('-').kind).toBe('empty');
    expect(sortKeyOf('+').kind).toBe('str');
    expect(sortKeyOf('--3').kind).toBe('str');
    expect(sortKeyOf('+-3').kind).toBe('str');
  });
  it('[-3, 0, 2, 빈값] — 오름차순은 그 순서, 내림차순에서도 빈 값은 마지막', () => {
    const rows = [row('b', '2'), row('e', '—'), row('a', '-3'), row('z', '0')];
    expect(order(sortChildren(rows, 1, 'asc'))).toEqual(['a', 'z', 'b', 'e']);
    expect(order(sortChildren(rows, 1, 'desc'))).toEqual(['b', 'z', 'a', 'e']);
  });
  it('단위가 섞인 음수 — 큰 음수가 작은 음수보다 앞(오름차순)', () => {
    const rows = [row('p', '-2 GB'), row('q', '-900 MB'), row('r', '1 GB'), row('s', '−1 TB')];
    expect(order(sortChildren(rows, 1, 'asc'))).toEqual(['s', 'p', 'q', 'r']);
  });
});

/* 보조 스윕 — 결측을 음수 sentinel 로 넘기는 data-sort 가 남아 있지 않은지(I-01 수정 뒤에는 -1·-9999 가
 * 진짜 음수로 읽혀 결측 행이 오름차순 맨 앞에 온다). 결측은 '' 로 넘긴다(빈 값 = 방향 무관 맨 뒤). */
describe('I-01 결측 sentinel 스윕', () => {
  it('web/src 의 jsx 에 data-sort={… ? -숫자 …} 형태가 없다', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const hits = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
        if (!p.endsWith('.jsx')) continue;
        const src = fs.readFileSync(p, 'utf8');
        const re = /data-sort=\{[^}]*?(?:\?|:|\?\?|\|\|)\s*-\s*\d/g;
        let m;
        while ((m = re.exec(src))) hits.push(`${path.relative(root, p)}:${src.slice(0, m.index).split('\n').length}`);
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
