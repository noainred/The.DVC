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
    // 2회차 A5-F4: 못 읽음(unknown) · 링크 없음(nolink) 을 '내려감' 으로 단정하지 않는다
    expect(downMembersText({ members: [{ port: 'Ethernet1', oper: 'unknown', admin: 'up' }, { port: 'Ethernet2', oper: 'nolink', admin: 'up' }] })).toBe('Et1 모름 · Et2 링크 없음');
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
  it('2회차 웹 — 끊긴 기록 · 확인 불가 · 버전별 · LAG 못 읽음 · Tab 순서 · 역방향 비교 · 늦은 목록', () => {
    expect(src('CvpPortPlan.jsx')).toMatch(/x\.used == null \? \(x\.total == null \? '—' : `— \/ \$\{x\.total\}`\)/);   // F1
    const rd = src('CvpRedundancy.jsx');
    expect(rd).toMatch(/const unk = \(x\) => x\.mlag\.state === 'unknown'/); expect(rd).toMatch(/확인 불가 <b/);   // F2
    expect(rd).toMatch(/포트 목록 \$\{rows\.filter\(\(x\) => !x\.portsRead\)\.length\}대/);   // F10
    expect(src('CvpCompliance.jsx')).toMatch(/v\.bugNoRecord/); expect(src('CvpCompliance.jsx')).toMatch(/v\.lifeUnread/);   // F5
    expect(src('CvpPortMap.jsx')).toMatch(/cfgReadAt\?\.lag && !data\.device\.info\.cfgReadAt\.lagPartial \? 'LAG 아님' : '소속 못 읽음'/);   // F7
    const tp = src('CvpTopology.jsx');
    expect(tp).toMatch(/drawOrder\.map\(\(n\) =>/); expect(tp).toMatch(/matches\(':focus-visible'\)/); expect(tp).toMatch(/onMouseDown=\{\(\) => setFocusId\(null\)\}/);   // F8 · 포커스
    expect(tp).toMatch(/마지막 읽기가 실패함/);   // F9
    const cp = src('CvpCompare.jsx');
    expect(cp).toMatch(/setA\(String\(x\.id\)\); setB\('now'\);/); expect(cp).toMatch(/if \(my !== listSeq\.current\) return;/);   // F11 · 늦은 목록
    const ot = src('CvpOpticsTrend.jsx');
    expect(ot).toMatch(/x\.state === 'stale' && x\.lastRx != null && rowLow\(x\) != null && x\.lastRx <= rowLow\(x\)/);   // A1-F9 → v3.47 D-7: 행마다 그 광모듈의 기준
    expect(src('CvpPortPlan.jsx')).toMatch(/sat\.seriesUnread/);   // A4-F6
  });
  it('2회차 반증 R7 · R12 · R13', async () => {
    const { rxStateLabel } = await import('./cvpOpticsText.js').then((m) => ({ rxStateLabel: Object.values(m).find((f) => typeof f === 'function' && /레인 일부만 링크/.test(String(f))) }));
    expect(typeof rxStateLabel).toBe('function');
    expect(rxStateLabel({ linked: false, lanesPartial: true }).label).toBe('판정 안 함(레인 일부만 링크)');   // R7
    expect(src('CvpPortPlan.jsx')).toMatch(/ex\.pointsRows && ex\.rows\.length > ex\.pointsRows/);   // R12
    expect(src('CvpRedundancy.jsx')).toMatch(/const unkOn = unkOnly && unkN > 0;/);   // R13
  });
  it('3회차 웹 — 버린 무거운 조회 취소 · 각주 · GBIC 타일 · 이중화 문구 · 비교 못 함 문구', async () => {
    // A5-F1: 무거운 조회 8곳은 fetchHeavy(재시도 없음 · 긴 시한) + effect 정리에서 취소
    for (const [f, n] of [['CvpLinkQuality.jsx', 1], ['CvpOpticsTrend.jsx', 1], ['CvpPortPlan.jsx', 2], ['CvpRedundancy.jsx', 1], ['CvpTopology.jsx', 1], ['CvpPortMap.jsx', 1]]) {
      const t = src(f);
      expect((t.match(/fetchHeavy\('\/tools\/cvp\//g) || []).length, f).toBe(n);
      expect((t.match(/active = false; ac\.abort\(\);/g) || []).length, f).toBe(n);
    }
    expect(src('CvpCompare.jsx')).toMatch(/cmpAc\.current\?\.abort\(\);/);
    const hv = src('cvpHeavy.js');
    expect(hv).toMatch(/retries: 0/); expect(hv).toMatch(/timeoutMs: HEAVY_TIMEOUT_MS/);
    // A5-F3: 예측 각주는 보고 있는 표의 것만
    expect(src('CvpPortPlan.jsx')).toMatch(/function forecastNotes\(part, ex, sat, r\)/);
    // A5-F4: 레인 일부만 링크인 칸을 '판정 안 함' 에 더한다
    const { opticsKpis } = await import('./cvpOpticsText.js');
    const k = opticsKpis({ notLinked: 3, lanesPartial: 2, present: 10, absent: 1 }, {}).find((x) => x.key === 'notLinked');
    expect(k.value).toBe('5'); expect(k.meta).toContain('레인 일부만 링크 2');
    expect(opticsKpis({ notLinked: 3 }, {}).find((x) => x.key === 'notLinked').value).toBe('3');
    // A5-F5: 못 읽은 장비가 있으면 '문제 없음' 으로 단정하지 않는다
    const { noProblemText, naText } = await import('./cvpNetText.js');
    expect(noProblemText(0, 0)).toBe('문제 있는 장비가 없습니다.');
    expect(noProblemText(0, 4)).toContain('4대는 MLAG'); expect(noProblemText(2, 0)).toContain('확인 불가');
    // A1-F3 · A5-F6: 비교 못 함 문구
    expect(naText(['portState'])).toContain('일부 포트의 링크 상태'); expect(naText(['broken'])).toContain('스냅샷 본문 손상');
  });
  it('4회차 웹 — 위치 찾기 상한 안내 · 포트 상태 모름의 측정 시각 · 지도 노드 키보드 초점', async () => {
    // A5-F1: 답 장비가 상한을 넘어 뺀 대수를 밝힌다(값은 응답에서 — 화면에 숫자를 박지 않는다)
    const lc = src('CvpLocate.jsx');
    expect(lc).toMatch(/r\.devicesTruncated && <div style=\{NOTE\}>/);
    expect(lc).toMatch(/\{r\.devicesMax \?\? '상한'\}/); expect(lc).toMatch(/\{r\.devicesOmitted \?\? '일부'\}/);
    // A5 관찰: 일부 목록에서 빠져 '모름' 이 된 포트의 rateTs 는 모름이 된 시각이다 — '측정 n분 전' 으로 보이지 않게
    const { default: HostNetCvp } = await import('../HostNetCvp.jsx');
    const up = (oper) => ({ cvpId: 'c', key: 'k', port: 'Ethernet1', hostname: 'sw1', oper, basis: 'lldp', rateTs: Date.now() - 120_000, ts: Date.now() - 600_000 });
    const html = (oper) => renderToStaticMarkup(React.createElement(HostNetCvp, { data: { uplinks: [up(oper)] }, nics: [] }));
    expect(html('unknown')).toContain('측정 없음(포트 상태 모름)');
    expect(html('up')).not.toContain('측정 없음'); expect(html('up')).toMatch(/측정 [^<]*전/);
    // 수정 검토: 장비가 원래 '모름' 으로 보고하지만 처리량 값은 있는 포트 — 값과 '측정 없음' 을 한 카드에 함께 내지 않는다
    const withRate = renderToStaticMarkup(React.createElement(HostNetCvp, { data: { uplinks: [{ ...up('unknown'), inBps: 1200, outBps: 800 }] }, nics: [] }));
    expect(withRate).not.toContain('측정 없음');
    // 수정 검토: 위치 찾기는 줄이 차서 온 429 를 자동으로 다시 보내지 않는다
    expect(lc).toMatch(/fetchJson\('\/tools\/cvp\/locate', \{ q: v \}, undefined, \{ retries: 0 \}\)/);
    // A5 관찰: 마우스로 누른 뒤 키보드로 고르면 초점 고리가 다시 보인다
    expect(src('CvpTopology.jsx')).toMatch(/onKeyDown=\{\(e\) => \{ setFocusId\(n\.id\);/);
  });
  it('v3.47 결정 · 5회차 웹 — 장애 임계 예측 문구 · 기준 안내 · 설명 링크 안내 · 회수 타일', async () => {
    const { opticTrendText, trendBasisText, descLinkNote, linkqBasis } = await import('./cvpNetText.js');
    const now = Date.UTC(2026, 10, 26, 3);
    expect(opticTrendText({ state: 'eta', target: 'fault', faultEta: now + 16 * 86_400_000 }, { now, horizonDays: 365 })).toMatch(/^장애 임계 /);
    expect(opticTrendText({ state: 'eta', warnEta: now + 10 * 86_400_000 }, { now, horizonDays: 365 })).not.toMatch(/장애/);
    expect(opticTrendText({ state: 'flat' }, { now })).toBe('내려가지 않음 — 예측 없음');
    expect(trendBasisText({ warnDbm: -10, faultDbm: -14 }, 3)).toContain('장비가 Rx 임계를 준 3개는 그 임계');
    expect(trendBasisText({}, 0)).not.toMatch(/— dBm/);
    expect(descLinkNote({ kind: 'desc', descPair: true })).toContain('양쪽 설명이 서로를 가리킴');
    expect(descLinkNote({ kind: 'desc' })).toContain('상대 포트 모름');
    expect(linkqBasis({ rx: -18, rxLowDbm: -20, rxBasis: 'device' }, -10)).not.toContain('≤');
    expect(linkqBasis({ rx: -21, rxLowDbm: -20, rxBasis: 'device' }, -10)).toContain('≤ 장비 임계 -20');
    expect(src('CvpPortPlan.jsx')).toMatch(/c\.young != null \? \[\['아직 판단 못 함', c\.young/);
    expect(src('CvpOpticsTrend.jsx')).toMatch(/refLine=\{rowLow\(x\)\}/);
  });
});
