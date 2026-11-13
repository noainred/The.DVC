/**
 * focusMonCard.test.js — v2.992 개요 카드 아래 줄 고르기(사용자 "빨간 부분을 선택해서 볼 수 있게 · Disk write/read · Network in/out · disk wait 등").
 *  · 목록 정리(아는 열쇠 · 겹침 없음 · 최대 4 · 비면 기본값) · 체크 토글(넷이면 잠김 · 마지막 하나는 못 끔)
 *  · 칸 글(값 없으면 '—' · 단위 없음) · 서버 요약 칸 이름과 대조 · 화면 소스(브라우저 기억 · 카드가 고른 칸을 그림)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { CARD_LINE_ITEMS, CARD_LINE_MAX, CARD_LINE_DEFAULT, normCardLine, toggleCardLine, cardLineCells, DASH } from './focusMonText.js';

const SUM = { netRx: 1.4e9, netTx: 2e8, rAwait: 1.234, wAwait: 0, rMB: 12.34, wMB: 4.567, rIo: 120.4, wIo: 45.6, qu: 0.123, iow: 3.21, stl: 0, load1: 1.234, cores: 16, swU: 2 ** 30, swT: 4 * 2 ** 30 };

describe('목록 정리 · 토글', () => {
  it('아는 열쇠만 · 겹침 없이 · 최대 넷 · 비면 기본값(예전 고정 줄)', () => {
    expect(CARD_LINE_MAX).toBe(4);
    expect(CARD_LINE_DEFAULT).toEqual(['net', 'wAwait']);
    expect(normCardLine(null)).toEqual(['net', 'wAwait']);
    expect(normCardLine([])).toEqual(['net', 'wAwait']);
    expect(normCardLine(['x', 'iops', 'iops', 'qu', 'iow', 'stl', 'swap'])).toEqual(['iops', 'qu', 'iow', 'stl']);
    expect(normCardLine('net')).toEqual(['net', 'wAwait']);
    expect(normCardLine(['__proto__', 'constructor'])).toEqual(['net', 'wAwait']);
  });
  it('토글 — 고른 순서대로 뒤에 · 넷이면 더 못 고름 · 마지막 하나는 못 끔 · 모르는 열쇠는 무시', () => {
    expect(toggleCardLine(['net', 'wAwait'], 'diskRw')).toEqual(['net', 'wAwait', 'diskRw']);
    expect(toggleCardLine(['net', 'wAwait'], 'net')).toEqual(['wAwait']);
    expect(toggleCardLine(['qu'], 'qu')).toEqual(['qu']);
    expect(toggleCardLine(['net', 'qu', 'iow', 'stl'], 'swap')).toEqual(['net', 'qu', 'iow', 'stl']);
    expect(toggleCardLine(['net'], 'nope')).toEqual(['net']);
  });
});

describe('칸 글', () => {
  const all = CARD_LINE_ITEMS.map((x) => x.key);
  const text = (keys) => cardLineCells(SUM, keys).map((c) => c.text);
  it('값', () => {
    expect(text(['net', 'diskRw'])).toEqual(['↓1.4 Gb/s ↑200 Mb/s', 'R 12.3 · W 4.57 MB/s']);
    expect(text(['iops', 'rAwait'])).toEqual(['IOPS 120 / 46', '읽기 지연 1.2 ms']);
    expect(text(['wAwait', 'qu'])).toEqual(['쓰기 지연 0.0 ms', '대기열 0.12']);
    expect(text(['iow', 'stl'])).toEqual(['I/O 대기 3.2%', 'steal 0.0%']);
    expect(text(['load', 'swap'])).toEqual(['부하 1.23 / 16코어', '스왑 1.0 GB']);
    expect(cardLineCells({ swU: 0, swT: 0 }, ['swap'])[0].text).toBe('스왑 없음');
  });
  it('못 읽은 값은 — · 단위를 붙이지 않는다(0 아님)', () => {
    for (const c of cardLineCells(null, all.slice(0, 4))) expect(c.text).toContain(DASH);
    expect(cardLineCells({}, ['diskRw'])[0].text).toBe(`R ${DASH} · W ${DASH}`);
    expect(cardLineCells({}, ['load'])[0].text).toBe(`부하 ${DASH}`);
    expect(cardLineCells({}, ['swap'])[0].text).toBe(`스왑 ${DASH}`);
    expect(cardLineCells({ rMB: 0, wMB: null }, ['diskRw'])[0].text).toBe(`R 0.00 · W ${DASH} MB/s`);
  });
  it('마우스를 올리면 무엇인지(제목) · 백틱 없음', () => {
    for (const c of cardLineCells(SUM, all)) { expect(c.title).toMatch(/ — /); expect(c.title).not.toMatch(/`/); }
  });
});

describe('서버 · 화면 소스', () => {
  it('칸이 쓰는 요약 이름은 서버 rates.summaryOf 가 낸다', () => {
    const rates = fs.readFileSync(new URL('../../../../server/src/focusmon/rates.js', import.meta.url), 'utf8');
    const body = rates.slice(rates.indexOf('export function summaryOf'), rates.indexOf('export function timeAverageIostat'));
    for (const k of ['netRx', 'netTx', 'rAwait', 'wAwait', 'rMB', 'wMB', 'rIo', 'wIo', 'qu', 'iow', 'stl', 'load1', 'cores', 'swU', 'swT']) expect(body).toMatch(new RegExp(`\\b${k}:`));
  });
  it('브라우저가 기억 · 카드는 고른 칸을 그린다 · 정렬 줄에 메뉴', () => {
    const src = fs.readFileSync(new URL('./FocusMonTool.jsx', import.meta.url), 'utf8');
    expect(src).toMatch(/lsGet\('fm\.ov\.line', null\)/);
    expect(src).toMatch(/lsSet\('fm\.ov\.line', x\)/);
    expect(src).toMatch(/cardLineCells\(x\.sum, line\)/);
    expect(src).toMatch(/<CardLinePicker value=\{line\} onChange=\{setLine\} \/>/);
    expect(src).not.toMatch(/쓰기 지연 \{msText\(x\.sum\?\.wAwait\)\}/);
  });
});
