/**
 * views/tools/cvpBugRound342.test.jsx — v3.42 CVP 버그 점검 1회차 웹 확정분 회귀(D1~D14 · A2-F5/F6/F9 · L1~L4).
 * 화면 함수는 실제로 부르고, 컴포넌트 안 배치(칸 배열 · 정렬값 · 상태 되돌림)는 주석을 뺀 소스로 본다(fetch 를 부르는 화면이라 렌더 대신).
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { cellText } from '../../components/sortableText.js';
import { devListText, downMembersText, horizonText, forecastText, opticTrendText, layoutNodes, bugText, BUG_DEFS, FORECAST_TONE } from './cvpNetText.js';
import { lastLinkText, verdictText, lldpText } from './cvpPortMapText.js';

const dir = path.dirname(new URL(import.meta.url).pathname);
const src = (f) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('v3.42 CVP 버그 점검 1회차 — 웹', () => {
  it('D1 전 스위치 여유 표 — 조건부 칸은 배열(Fragment 면 정렬이 칸을 세지 못한다)', () => {
    const s = src('CvpPortMap.jsx');
    expect(s).not.toMatch(/d\.counts \? \(<>/);
    expect(s).toMatch(/d\.counts \? \[/);
    // 배열 칸은 cellText 가 센다(대조: STable 이 쓰는 같은 함수)
    const row = React.createElement('tr', null, React.createElement('td', null, 'a'), [React.createElement('td', { key: 'x', 'data-sort': 7 }, '7')]);
    expect(cellText(row, 1)).not.toBe(null);
  });
  it('D4 장비 목록을 못 읽으면 "없음" 으로 단정하지 않는다', () => {
    expect(devListText('loading')).toBe(null);
    expect(devListText('error')).toContain('읽지 못했습니다');
    expect(devListText('unavailable')).toContain('읽지 못함');
    expect(devListText('ok')).toBe('수집된 CVP 장비가 없습니다.');
    expect(src('CvpTool.jsx')).toMatch(/listState=\{devListState\}/);
  });
  it('D2 · D13 전후 비교 — 후(b) 가 선택지에서 빠지면 지금으로 · 지금은 고정 · 새로 찍은 것을 전으로', () => {
    const s = src('CvpCompare.jsx');
    expect(s).toMatch(/const bGone = b !== 'now' && \(b === a \|\| !done\.some/);
    expect(s).toMatch(/<option value="now" data-pin>/);
    expect(s).toMatch(/b: bGone \? 'now' : b/);
    expect(s).toMatch(/setA\(String\(x\.id\)\)/);
  });
  it('D3 토폴로지 — 새 응답에 없는 법인은 기본값으로', () => {
    expect(src('CvpTopology.jsx')).toMatch(/corps\.some\(\(\[name\]\) => name === corp\)/);
  });
  it('D5 · D6 · D7 정렬값이 표시와 맞는다', () => {
    expect(src('CvpOpticsTrend.jsx')).toMatch(/data-sort=\{x\.state === 'alreadyFault' \? 0 : x\.state === 'already' \? 1/);
    expect(src('CvpRedundancy.jsx')).toMatch(/data-sort=\{x\.lagUnread \|\| !x\.portsRead \? '' : badCh\.length\}/);
    expect(src('CvpPortMap.jsx')).toMatch(/data-sort=\{p\.oper === 'up' \? \(utilOf\(p\) \?\? ''\) : ''\}/);
  });
  it('D8 · A2-F9 이중화 — 포트 목록 못 읽음은 채널 없음이 아니다 · 확인 불가는 문제 목록에 넣지 않는다', () => {
    const s = src('CvpRedundancy.jsx');
    expect(s).toMatch(/!x\.portsRead \? <span style=\{NOTE\}>포트 목록 못 읽음/);
    expect(s).toMatch(/const BAD_CH = new Set\(\['degraded', 'down'\]\)/);
    expect(s).toMatch(/const BAD_MLAG = new Set\(\['peerDown', 'notConnected', 'inactive'\]\)/);
  });
  it('D9 지도 — 한 줄 상자들이 겹치지 않는다', () => {
    const W = 1100; const BOX = 104; const per = Math.max(1, Math.floor(W / (BOX + 8)) - 1);
    const nodes = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, hostname: `leaf-${String(i).padStart(2, '0')}`, layer: 'leaf' }));
    const { pos } = layoutNodes(nodes, { width: W, perRow: per });
    const byRow = new Map();
    for (const n of nodes) { const p = pos.get(n.id); if (!byRow.has(p.y)) byRow.set(p.y, []); byRow.get(p.y).push(p.x); }
    for (const xs of byRow.values()) { xs.sort((a, b) => a - b); for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(BOX); }
    // 대조: 예전 기본(한 줄 10대)은 간격 100px < 상자 104px
    const old = layoutNodes(nodes, { width: W, perRow: 10 }).pos;
    expect(old.get('n1').x - old.get('n0').x).toBeLessThan(BOX);
    expect(src('CvpTopology.jsx')).toMatch(/perRow: PER_ROW/);
  });
  it('D10 문제 채널의 내려간 멤버를 글자로 · 지도 노드는 키보드로 고른다', () => {
    expect(downMembersText({ members: [{ port: 'Ethernet1', oper: 'up', admin: 'up' }, { port: 'Ethernet2', oper: 'down', admin: 'up' }, { port: 'Ethernet3', oper: 'down', admin: 'down' }] })).toBe('Et2 내려감 · Et3 꺼짐');
    expect(downMembersText({ members: Array.from({ length: 6 }, (_, i) => ({ port: `Ethernet${i}`, oper: 'down', admin: 'up' })) })).toMatch(/외 2$/);
    expect(downMembersText({ members: [] })).toBe('');
    const s = src('CvpTopology.jsx');
    expect(s).toMatch(/role="button" tabIndex=\{0\}/);
    expect(s).toMatch(/onKeyDown=/);
  });
  it('D11 · A2-F3 예측 지평선은 응답 값 · 오래된 기록은 끊김', () => {
    expect(horizonText(365)).toBe('1년'); expect(horizonText(180)).toBe('180일'); expect(horizonText(null)).toBe('예측 기간');
    expect(forecastText({ state: 'far' }, { horizonDays: 730 })).toBe('2년 넘게');
    expect(forecastText({ state: 'stale', lastAt: Date.UTC(2026, 8, 1, 3) })).toMatch(/^기록 끊김\(마지막 2026-09-0[12]\)$/);
    expect(opticTrendText({ state: 'far' }, { horizonDays: 365 })).toBe('1년 넘게');
    expect(FORECAST_TONE.stale).toBeTruthy();
    for (const f of ['CvpPortPlan.jsx', 'CvpOpticsTrend.jsx']) expect(src(f)).not.toMatch(/'1년/);
  });
  it('A2-F6 버그 기록 없음은 노출 없음(초록 · 0)이 아니다', () => {
    expect(bugText({ state: 'norecord', bugCount: null })).toBe('—');
    expect(BUG_DEFS.norecord[0]).toBe('기록 없음');
    expect(BUG_DEFS.norecord[1]).not.toBe(BUG_DEFS.none[1]);
  });
  it('A2-F5 · L4 포트 구성도 문구 — LLDP 이웃 없음의 이유 · 링크 기록 못 읽음을 단정하지 않는다', () => {
    expect(verdictText({ sub: 'use', ev: 'desc', lldpUnread: false })).not.toContain('보내지 않음)');
    expect(verdictText({ sub: 'use', ev: 'desc', lldpUnread: false })).toContain('이웃 기록이 없어');
    expect(lldpText({ oper: 'up', lldpUnread: false })).toBe('이웃 기록 없음');
    expect(lastLinkText({ oper: 'nolink', lastLinkAt: null }, Date.UTC(2026, 0, 1), Date.now(), true)).toBe('못 읽음');
    expect(lastLinkText({ oper: 'nolink', lastLinkAt: null }, null, Date.now(), false)).toBe('기록 없음');
  });
  it('D14 오류여도 새로고침 줄을 남긴다 · 추세 ↔ 재고는 다시 부르지 않는다', async () => {
    const { Pending } = await import('./CvpNetParts.jsx');
    const html = renderToStaticMarkup(React.createElement(Pending, { err: new Error('x'), onRetry: () => {} }));
    expect(html).toContain('새로고침');
    expect(src('CvpOptics.jsx')).not.toMatch(/<CvpOpticsTrendView key=/);
  });
});
