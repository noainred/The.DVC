import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import NodeGraphView, { ChordGraph, NodeCards } from './NodeGraphView.jsx';
import NodeClientsDrawer from './NodeClientsDrawer.jsx';
import { vizDataOf, chordLayout, cardsOf } from './nodeLoadViz.js';

const h = React.createElement;
const resp = {
  ok: true, deviceId: 'isi-1', range: '7d', mean: 1930, thresholds: { fixedShare: 0.9, skewFactor: 1.5 },
  nodes: [{ id: 1, total: 1220, ratio: 0.6, skew: false }, { id: 2, total: 5668, ratio: 2.9, skew: true }, { id: 3, total: 0, ratio: 0, skew: false }],
  clients: [
    { client: '172.63.212.44', name: 'demo-http-41', proto: 'http', total: 1431, nodes: { 2: 1431 }, share: { 2: 100 }, top: 2, topShare: 100, fixed: true },
    { client: '10.20.4.11', name: '', proto: 'nfs', total: 520, nodes: { 1: 520 }, share: { 1: 100 }, top: 1, topShare: 100, fixed: true },
    { client: '10.20.9.9', name: 'vm-two', proto: 'hdfs', total: 550, nodes: { 1: 300, 2: 250 }, share: { 1: 54.5, 2: 45.5 }, top: 1, topShare: 54.5, fixed: false },
  ],
};

describe('연결 그래프 렌더 스모크(SSR)', () => {
  it('현 그래프 — 노드 3 · 클라이언트 3 · 리본 4 · 쏠림 라벨 · 최근 작업 없음 · 툴팁 · 버튼 역할', () => {
    const html = renderToStaticMarkup(h(ChordGraph, { layout: chordLayout(vizDataOf(resp), { size: 760 }), emphasis: 'skew', onPick: () => {} }));
    expect(html).toContain('<svg');
    expect((html.match(/role="button"/g) || []).length).toBe(6);        // 노드 3 + 클라이언트 3
    expect((html.match(/<path d="M [\d.]+ [\d.]+ Q /g) || []).length).toBe(4);   // 리본 2 + 1 + 1
    expect(html).toContain('노드 2 · 쏠림 2.9×');
    expect(html).toContain('최근 작업 없음');
    expect(html).toContain('10.20.4.11');          // 이름 없는 클라이언트는 주소가 라벨
    expect(html).toContain('demo-http-41');
    expect(html).toContain('<title>');
    expect(html).toContain('6,888 ops/s');         // 클러스터 합 = 노드 합(1220 + 5668 + 0)
    expect(html).not.toContain('**');
  });
  it('압축 모드 — 클라이언트 글자 없음(툴팁만) · 노드는 이름만', () => {
    const html = renderToStaticMarkup(h(ChordGraph, { layout: chordLayout(vizDataOf(resp), { size: 380, compact: true }), emphasis: 'none', onPick: () => {} }));
    expect(html).not.toContain('>demo-http-41 <');
    expect(html).toContain('<title>demo-http-41 (172.63.212.44)');
    expect(html).not.toContain('>노드 2 · 쏠림');   // 글자에는 없고 툴팁(title)에만
    expect(html).toContain('노드 2');
  });
  it('노드 카드 — 쏠림 카드 · 빈 카드 문장 · 칩 버튼 · 2노드+ 꼬리표 · 외 n', () => {
    const html = renderToStaticMarkup(h(NodeCards, { cards: cardsOf(vizDataOf(resp)), onPick: () => {} }));
    expect(html).toContain('class="nl-card skew"');
    expect(html).toContain('class="nl-card idle"');
    expect(html).toContain('‘연결 없음’ 이 아니라 ‘최근 작업 없음’');
    expect((html.match(/class="nl-chip [lms]"/g) || []).length).toBe(4);   // 노드 1 칩 2 · 노드 2 칩 2
    expect((html.match(/2노드\+/g) || []).length).toBe(2);
    expect(html).toContain('쏠림 2.9×');
    expect(html).toContain('클라이언트 2 · 고정 1 · 두 노드 이상 1');
    const many = { ...resp, clients: Array.from({ length: 14 }, (_, i) => ({ client: `10.0.0.${i}`, name: '', proto: 'nfs', total: 100 - i, nodes: { 1: 100 - i }, share: { 1: 100 }, top: 1, topShare: 100, fixed: true })) };
    expect(renderToStaticMarkup(h(NodeCards, { cards: cardsOf(vizDataOf(many)), onPick: () => {} }))).toContain('외 2 — 드로어에서 전부');
  });
  it('보기 전체(응답 전) — 모양 · 창 · 프로토콜 세그먼트만 · 폴링 없음 · 백틱 없음', () => {
    const html = renderToStaticMarkup(h(NodeGraphView, { deviceId: 'isi-1', onPick: () => {} }));
    expect(html).toContain('aria-label="모양"');
    expect(html).toContain('현 그래프');
    expect(html).toContain('노드 카드');
    expect(html).toContain('aria-label="창"');
    expect(html).not.toContain('`');
    const src = fs.readFileSync(new URL('./NodeGraphView.jsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/setInterval|usePolling/);
    expect(src.match(/fetchJson\(/g).length).toBe(1);
  });
  it('드로어 — focus prop 을 받아도 응답 전에는 그대로 그린다(훅은 조기 return 위)', () => {
    const html = renderToStaticMarkup(h(NodeClientsDrawer, { deviceId: 'isi-1', node: 2, onClose: () => {}, focus: { client: '10.20.4.11', range: '7d', at: 1 } }));
    expect(html).toContain('노드 2 · 클라이언트와 프로토콜');
    const src = fs.readFileSync(new URL('./NodeClientsDrawer.jsx', import.meta.url), 'utf8');
    expect(src).toContain('data-client={c.client}');
    expect(src).toContain('nl-rowhit');
  });
});
