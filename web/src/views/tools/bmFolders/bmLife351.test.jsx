// 물리서버 부품 수명 지표(v3.51 · 시안 ⑧) — 글자 모델 · 구역 렌더. 판정은 서버(idrac/partLife.js)가 한다.
//   반증 B(B7 · B8 · B11)와 웹 변이 생존(M02~M04 · M06~M09)을 막는다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { stripComments } from '../../../test/_stripComments.js';
import { lifeView, memCeView, LIFE_NOTE, MEMCE_NOTE } from './lifeText.js';

const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const read = (p) => stripComments(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));

describe('SSD 잔여 수명 — 글자', () => {
  it('이 노드 서버는 한 개씩 · 못 읽음은 — · 낮음은 빨강(같은 모델 대비 낮아도 — M02) · 혼자 빨리 닳음은 주황(서버 표지 그대로)', () => {
    const v = lifeView({ kind: 'bm', detail: { life: [{ name: 'Bay 0', model: 'M', gb: 960, life: 97, low: false, gap: null }, { name: 'Bay 2', model: 'M', gb: 960, life: 61, low: false, gap: 34.5 }, { name: 'Bay 5', model: 'O', gb: 480, life: 8, low: true, gap: 40 }, { name: 'Bay 3', model: 'M', gb: null, life: null, low: false, gap: null }] } });
    expect(v.kind).toBe('rows');
    expect(v.rows.map((x) => [x.lifeText, x.tone])).toEqual([['97%', 'green'], ['61%', 'amber'], ['8%', 'red'], ['—', 'gray']]);
    expect(v.rows[1].note).toBe('같은 모델 SSD 가운데값보다 34.5%p 낮습니다 — 혼자 빨리 닳고 있습니다');
    expect(v.rows[2].note).toBe('낮음 — 교체 계획 대상');
    expect(v.head).toBe('SSD 4개 · 가장 낮은 값 8% · 값 없음 1');
    expect(lifeView({ kind: 'bm', detail: { life: [{ name: 'a', life: 90 }, { name: 'b', life: 80 }] } }).head).toBe('SSD 2개 · 가장 낮은 값 80%', '다 읽었으면 값 없음 꼬리 없음(M03)');
    expect(lifeView({ kind: 'bm', detail: { life: [{ name: 'a', life: null }] } }).head).toBe('SSD 1개 · 값 없음');
    expect(lifeView({ kind: 'bm', detail: { life: null } }).kind).toBe('unread');
    expect(lifeView({ kind: 'esxi' })).toBe(null);
  });
  it('값 없음의 이유 — 장비가 주지 않음 / 읽기 전 판 인벤토리(B7)', () => {
    const v = lifeView({ kind: 'bm', detail: { life: [{ name: 'a', life: null }, { name: 'b', life: null, stale: true }] } });
    expect(v.rows[0].note).toBe('장비가 값을 주지 않았습니다');
    expect(v.rows[1].note).toContain('수명 값을 읽기 전 판의 인벤토리');
  });
  it('SSD 없음 — 매체를 모르는 디스크가 있으면 단정하지 않는다', () => {
    expect(lifeView({ kind: 'bm', detail: { life: [], disks: [{ media: 'HDD', proto: 'SAS', n: 4 }] } }).head).toBe('SSD 없음');
    const u = lifeView({ kind: 'bm', detail: { life: [], disks: [{ media: '', proto: 'SAS', n: 2 }, { media: 'HDD', proto: 'SAS', n: 4 }] } });
    expect([u.kind, u.head]).toEqual(['none', 'SSD 로 확인한 디스크 없음']); expect(u.why).toContain('2개');
    expect(lifeView({ kind: 'bm', summary: { disk: { n: 6, ssd: 0, nvme: 0, hdd: 4 } } }).head).toBe('SSD 로 확인한 디스크 없음');
    expect(lifeView({ kind: 'bm', summary: { disk: { n: 4, ssd: 0, nvme: 0, hdd: 4 } } }).head).toBe('SSD 없음');
  });
  it('엣지 · 요약만 받은 서버 — 요약 한 줄 · 디스크 목록 못 읽음(B11) · 요약 없음은 단정하지 않음', () => {
    expect(lifeView({ kind: 'bm', why: 'summary-only', summary: { disk: { ssd: 4, nvme: 0, life: { n: 4, read: 3, min: 41 } } } }).head).toBe('SSD 4개 중 3개 읽음 · 가장 낮은 값 41%');
    expect(lifeView({ kind: 'bm', summary: { disk: { ssd: 2, nvme: 0, life: { n: 2, read: 0, min: null } } } }).head).toBe('SSD 2개 · 값 없음');
    const old = lifeView({ kind: 'bm', summary: { disk: { ssd: 2, nvme: 0 } } }).why;
    expect(old).toContain('엣지가 이 판보다 낮거나'); expect(old).toContain('다시 읽지 않았을 수');
    expect(lifeView({ kind: 'bm', why: 'summary-only', summary: { disk: null } }).why).toBe('이 서버의 디스크 목록을 읽지 못해 수명 값을 볼 수 없습니다.');
  });
});

describe('메모리 교정 오류 경고 — 글자', () => {
  it('슬롯별 · 덮었으면 기간 건수 · 덮지 못했으면 ‘읽은 기록 안’ 건수(B8) · 0 을 없음으로 쓰지 않음 · covered 가 없으면 덮지 못함(M04)', () => {
    const v = memCeView({ covered: true, days: 30, total: 3, slots: [['A1', 0], ['B3', 2]], unknownSlot: 1 });
    expect([v.head, v.slots, v.unknown, v.note]).toEqual(['지난 30일 경고 기록 3건', [{ slot: 'A1', n: 0 }, { slot: 'B3', n: 2 }], 1, '']);
    const p = memCeView({ covered: false, days: 30, total: 0, slots: [['A1', 0]], unknownSlot: 0 });
    expect(p.head).toBe('읽은 기록 안에는 경고 기록 없음'); expect(p.note).toContain('‘없음’ 이 아닙니다');
    expect(memCeView({ covered: false, days: 30, total: 3, slots: [] }).head).toBe('읽은 기록 안 경고 기록 3건(지난 30일을 다 읽지 못함)');
    expect(memCeView({ days: 30, total: 0, slots: [] }).covered).toBe(false);
    expect(memCeView({ covered: true, days: 30, total: 0, slots: [] }).head).toBe('지난 30일 경고 기록 없음');
    expect(memCeView(null)).toBe(null); expect(memCeView({ slots: 'x' })).toBe(null);
    expect(MEMCE_NOTE).toContain('오류 건수 자체가 아닙니다');
    expect(LIFE_NOTE).toContain('장비가 보고한');
  });
});

describe('구역 렌더', () => {
  it('부품 수명 지표 — 표 · 막대 · 같은 모델 대비 문구(M07) · 용량 없음은 단위 없이(M06) · 읽는 중 · ESXi 는 그리지 않음', async () => {
    const { LifeSection } = await import('./OpsSections.jsx');
    const r = { key: 'st:SYNTH01', kind: 'bm' };
    const html = renderToStaticMarkup(React.createElement(LifeSection, { r, hw: { d: { kind: 'bm', detail: { life: [{ name: 'Bay 2', model: 'M', gb: 960, life: 61, low: false, gap: 34.5 }, { name: 'Bay 7', model: 'M', gb: null, life: null }] } }, err: '' } }));
    const t = text(html);
    expect(t).toContain('부품 수명 지표'); expect(t).toContain('61%'); expect(html).toContain('class="bmd-life-bar"'); expect(html).toContain('width:61%');
    expect(t).toContain('34.5%p 낮습니다'); expect(t).toContain('960 GB');
    expect(t).not.toContain('null'); expect(t).not.toMatch(/—\s*GB|\bGB\s*$/);
    expect((html.match(/class="bmd-life-bar"/g) || []).length).toBe(1, '값 없음에는 막대 없음');
    expect(renderToStaticMarkup(React.createElement(LifeSection, { r, hw: { d: null, err: '' } }))).toBe('');
    expect(renderToStaticMarkup(React.createElement(LifeSection, { r: { ...r, kind: 'esxi' }, hw: { d: { kind: 'esxi' } } }))).toBe('');
  });
  it('이벤트 로그를 읽은 뒤 메모리 교정 오류 경고 칸 — 경고 슬롯 강조 · 슬롯 모름 건수(M09) · 덮지 못함 안내(M08)', async () => {
    const { HwLogSection } = await import('./OpsSections.jsx');
    const base = { ok: true, via: 'local', status: 'ok', read: 1, total: 1, gap: 0, stopped: '', counts: { critical: 0, warning: 1, ok: 0, other: 0 }, rows: [{ at: 1, sev: 'warning', code: 'MEM0701', sensor: 'Memory', msg: 'x' }] };
    const html = renderToStaticMarkup(React.createElement(HwLogSection, { r: { key: 'k', kind: 'bm' }, initial: { ...base, memCe: { covered: true, days: 30, total: 2, slots: [['A1', 0], ['B3', 1]], unknownSlot: 1 } } }));
    expect(text(html)).toContain('메모리 교정 오류 경고 — 지난 30일 경고 기록 2건'); expect(html).toContain('bmd-memce-c hot');
    expect(text(html)).toContain('슬롯을 알 수 없는 경고 기록 1건');
    const part = text(renderToStaticMarkup(React.createElement(HwLogSection, { r: { key: 'k', kind: 'bm' }, initial: { ...base, memCe: { covered: false, days: 30, total: 0, slots: [], unknownSlot: 0 } } })));
    expect(part).toContain('읽은 기록이 지난 30일을 다 덮지 못했습니다');
  });
  it('드로어에 붙는다(하드웨어 요약 뒤 · 같은 /hw 응답)', () => {
    expect(read('./BmDrawer.jsx')).toMatch(/<LifeSection r=\{r\} hw=\{hw\} \/>/);
  });
});
