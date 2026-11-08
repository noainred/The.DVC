/**
 * 다음 점검 ①(2026-11-08) — 화면: 서버 = (법인, 키) 쌍. 상세 · 탭 · 팝업 · 비교 · 공유 링크 · 함대 보기에서 서버를 열 때 법인(vcenterId)을 함께 싣는다.
 *   ① 경로 · 쌍 글자 — perfPath · refOf/parseRef(서버 targetIdOf · 비교 열 cid 와 같은 꼴) · 예전 판 목록(키만)
 *   ② 응답 읽기 — ambiguous-key(HttpError · 본문) → 후보 · 비교 응답 cid → 열 식별
 *   ③ 공유 링크 — 상세에 법인 · 형식 밖 법인은 버린다 · 법인 없는 예전 링크는 그대로
 *   ④ 보드 — 같은 키 · 다른 법인은 두 서버(예전에는 키만 봐 엣지 쪽이 빠졌다)
 *   ⑤ 상세 — 조회기가 법인을 넘긴다 · 모호하면 법인 고르기(후보 버튼 · 오류 문장 아님)
 *   ⑥ 소스 스윕 — 서버 하나 경로는 perfPath 하나로(새 탭이 키만으로 요청하지 못하게)
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as U from './bmPerfUrl.js';
import * as S from './bmShare.js';
import { boardItems } from './bmPerfText.js';
import { createDetailLoader, BmPerfDetailView } from './BmPerfDetail.jsx';
import { annotBody } from './bmAnnotText.js';
import { groupCompareKeys } from './BmOpsFleet.jsx';
import { targetIdOf } from '../../../../server/src/bmusage/maint/judge.js';
import { NO_PATH_REASON } from '../../../../server/src/bmusage/targets.js';
import { MISS_REASON_TEXT } from './bmOnboardText.js';
import { skippedNotes } from './bmUsageText.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);

describe('① 경로 · 쌍 글자', () => {
  it('perfPath — 법인이 있으면 질의에 · 없으면 예전처럼 키만 · 접미 · 기존 질의와 합친다', () => {
    expect(U.perfPath('a/b c')).toBe('/tools/bm-usage/perf/a%2Fb%20c');
    expect(U.perfPath('K1', 'vc-A:1', '/tuning')).toBe('/tools/bm-usage/perf/K1/tuning?vcenterId=vc-A%3A1');
    expect(U.perfPath('K1', '', '/top', 'ts=5')).toBe('/tools/bm-usage/perf/K1/top?ts=5');
    expect(U.perfPath('K1', 'vcB', '/logs', '?range=7d')).toBe('/tools/bm-usage/perf/K1/logs?range=7d&vcenterId=vcB');
    expect(U.withVc({ a: 1 }, 'vcB')).toEqual({ a: 1, vcenterId: 'vcB' });
    expect(U.withVc({ a: 1 }, '')).toEqual({ a: 1 });
  });
  it('refOf · parseRef — 서버 targetIdOf · 비교 열 cid 와 같은 꼴(‘법인|키’) · 예전 판 목록(키만)은 법인 모름', () => {
    expect(U.refOf('10.0.0.5', 'vcA')).toBe(targetIdOf({ vcenterId: 'vcA', key: '10.0.0.5' }));
    expect(U.refOf('K', '')).toBe(targetIdOf({ key: 'K' }));
    expect(U.parseRef('vcA|10.0.0.5')).toEqual({ vc: 'vcA', key: '10.0.0.5' });
    expect(U.parseRef('|K')).toEqual({ vc: '', key: 'K' });
    expect(U.parseRef('PLAINKEY')).toEqual({ vc: '', key: 'PLAINKEY' });
    expect(U.normRef('PLAINKEY')).toBe('|PLAINKEY');
    expect(U.normRef('vcA|K')).toBe('vcA|K');
    expect(U.normRef('')).toBe('');
    expect(U.parseRef(U.refOf('ome:e1:x|y', 'vcA'))).toEqual({ vc: 'vcA', key: 'ome:e1:x|y' }, '키 안의 ‘|’ 는 첫 ‘|’ 뒤라 보존된다');
  });
  it('용도 그룹 비교 — ref 면 ‘법인|키’(같은 키 두 법인이 한 칸이 되지 않는다) · 기본은 예전처럼 키', () => {
    const servers = [{ key: 'K', vcenterId: 'vcA', apps: ['gpdb'], status: 'bad' }, { key: 'K', vcenterId: 'vcB', apps: ['gpdb'], status: 'warn' }];
    expect(groupCompareKeys(servers, 'gpdb')).toEqual(['K', 'K']);
    expect(groupCompareKeys(servers, 'gpdb', { ref: true })).toEqual(['vcA|K', 'vcB|K']);
  });
  it('운영 주석 본문 — keys 와 같은 순서의 법인(비면 싣지 않는다 — 예전 모양 그대로)', () => {
    expect(annotBody({ keys: ['K'], vcenterIds: ['vcB'], at: 1, kind: 'memo', text: 'x' })).toEqual({ keys: ['K'], vcenterIds: ['vcB'], at: 1, kind: 'memo', text: 'x' });
    expect(annotBody({ keys: ['K'], vcenterIds: [''], at: 1, kind: 'memo', text: 'x' })).toEqual({ keys: ['K'], at: 1, kind: 'memo', text: 'x' });
  });
});

describe('② 응답 읽기', () => {
  const body = { ok: false, code: 'ambiguous-key', reason: '같은 키의 서버가 2개 법인에 있습니다', candidates: [{ vcenterId: 'vcA', vcName: 'A 법인' }, { vcenterId: 'vcB', vcName: null }, { vcenterId: '' }, null] };
  it('ambiguous — HttpError(.body) · 본문 둘 다 · 빈 후보는 버린다 · 다른 오류는 null', () => {
    expect(U.ambiguousOf({ status: 400, body })).toEqual([{ vcenterId: 'vcA', vcName: 'A 법인' }, { vcenterId: 'vcB', vcName: null }]);
    expect(U.ambiguousOf(body)).toHaveLength(2);
    expect(U.ambiguousOf({ status: 404, body: { ok: false, code: 'not-found' } })).toBe(null);
    expect(U.ambiguousOf(null)).toBe(null);
    expect(U.corpLabel({ vcenterId: 'vcA', vcName: 'A 법인' })).toBe('A 법인(vcA)');
    expect(U.corpLabel({ vcenterId: 'vcB', vcName: null })).toBe('vcB');
    expect(U.AMBIGUOUS_TEXT).not.toContain('`');
  });
  it('비교 응답 — 열 식별 = cid(요청한 ‘법인|키’) · 원래 키는 realKey(같은 키 두 열이 섞이지 않는다)', () => {
    const r = U.normCompareResp({ columns: [{ key: 'K', cid: 'vcA|K', vcenterId: 'vcA', state: 'ok' }, { key: 'K', cid: 'vcB|K', vcenterId: 'vcB', state: 'ok' }, { key: 'J', vcenterId: 'vcA', state: 'none' }] });
    expect(r.columns.map((c) => [c.key, c.realKey])).toEqual([['vcA|K', 'K'], ['vcB|K', 'K'], ['vcA|J', 'J']]);
    expect(U.normCompareResp(null)).toBe(null);
  });
});

describe('③ 공유 링크', () => {
  it('상세 — 법인을 싣고 되읽는다 · 형식 밖 법인은 버린다 · 법인 없는 예전 링크는 그대로(법인 필드 없음)', () => {
    const d = { view: 'detail', key: '10.0.0.5', vc: 'vc-B', tab: 'summary' };
    const h = S.shareHashOf(d);
    expect(h).toContain('vc=vc-B');
    expect(S.parseShareHash(h)).toMatchObject({ key: '10.0.0.5', vc: 'vc-B' });
    expect(S.shareHashOf({ ...d, vc: 'bad vc/x' })).not.toContain('vc=');
    expect(S.parseShareHash('#/tools/bm-usage/share?view=detail&key=K&vc=%3Cx%3E')).not.toHaveProperty('vc');
    expect(S.parseShareHash('#/tools/bm-usage/share?view=detail&key=K')).not.toHaveProperty('vc');
  });
  it('비교 — keys 는 ‘법인|키’ 쌍 그대로 왕복', () => {
    const c = { view: 'compare', keys: ['vcA|K', 'vcB|K'], cross: true, range: '24h', cv: 'side', group: 'util6', value: 'avgpeak', metric: 'cpu_pct' };
    expect(S.parseShareHash(S.shareHashOf(c))).toEqual(c);
  });
});

describe('④ 보드 — 같은 키 · 다른 법인은 두 서버', () => {
  it('이 노드 vcA 의 K 와 엣지 vcB 의 K 는 둘 다 · 같은 쌍은 한 번(이 노드 것)', () => {
    const data = { targets: [{ key: 'K', name: 'a', vcenterId: 'vcA' }], rows: [], perf: [] };
    const edges = { rows: [{ agent: 'E1', snapAt: 1, targets: [{ key: 'K', name: 'b', vcenterId: 'vcB' }, { key: 'K', name: 'dup', vcenterId: 'vcA' }], rows: [], perf: [] }] };
    const items = boardItems(data, edges);
    expect(items.map((x) => [x.vcenterId, x.key, x.name, x.agent])).toEqual([['vcA', 'K', 'a', ''], ['vcB', 'K', 'b', 'E1']]);
  });
});

describe('⑤ 상세 — 법인을 넘기고 · 모호하면 법인 고르기', () => {
  it('조회기는 법인을 fetcher 로 넘긴다(세대 규칙 그대로)', async () => {
    const calls = [];
    const L = createDetailLoader(async (k, vc) => { calls.push([k, vc]); return { ok: true, key: k }; });
    expect(await L.load('K', () => {}, 'vcB')).toBe('ok');
    expect(await L.load('K', () => {})).toBe('ok');
    expect(calls).toEqual([['K', 'vcB'], ['K', '']]);
  });
  it('기본 fetcher — perfPath 로 법인을 질의에(실제 경로)', async () => {
    vi.resetModules();
    const urls = [];
    vi.doMock('../../api.js', async (orig) => ({ ...(await orig()), fetchJson: (p) => { urls.push(p); return Promise.resolve({ ok: true }); } }));
    const M = await import('./BmPerfDetail.jsx');
    await M.createDetailLoader().load('10.0.0.5', () => {}, 'vcB');
    expect(urls).toEqual(['/tools/bm-usage/perf/10.0.0.5?vcenterId=vcB']);
    const T = await import('./bmTrendLoad.js');
    const calls = [];
    vi.doMock('../../api.js', async (orig) => ({ ...(await orig()), fetchJson: (p, q) => { calls.push([p, q]); return Promise.resolve({ ok: true }); } }));
    vi.resetModules();
    const T2 = await import('./bmTrendLoad.js');
    await T2.trendFetcher('K', 'vcB')({ kind: 'server', metric: 'cpu_pct' }, { from: 1, to: 2 });
    expect(calls[0]).toEqual(['/tools/bm-usage/perf/K/history', { kind: 'server', metric: 'cpu_pct', from: 1, to: 2, vcenterId: 'vcB' }]);
    expect(typeof T.trendFetcher).toBe('function');
    vi.doUnmock('../../api.js');
  });
  it('모호 응답 — 오류 문장 대신 법인 고르기(후보 버튼 · 범위 안만 — 서버가 거른 그대로)', () => {
    const err = Object.assign(new Error('같은 키의 서버가 2개 법인에 있습니다 — 법인을 고르세요.'), { status: 400, body: { ok: false, code: 'ambiguous-key', candidates: [{ vcenterId: 'vcA', vcName: 'A 법인' }, { vcenterId: 'vcB', vcName: 'B 법인' }] } });
    const html = renderToStaticMarkup(React.createElement(BmPerfDetailView, { itemKey: '10.0.0.5', err, onPickCorp: () => {}, now: 1 }));
    expect(html).toContain('법인 고르기');
    expect(html).toContain('A 법인(vcA)'); expect(html).toContain('B 법인(vcB)');
    expect(html).toContain('여러 법인');
    expect(html).not.toContain('법인을 고르세요.</p>');   // 서버 사유 문장을 오류 줄로 다시 그리지 않는다
    // 고르기 전에는 한 법인 서버의 머리(서비스 태그 · 법인 · 모델)를 답처럼 그리지 않는다(Chromium 판독에서 잡은 것 — 목록의 첫 항목 머리가 떴다)
    const withItem = renderToStaticMarkup(React.createElement(BmPerfDetailView, { itemKey: '10.0.0.5', item: { key: '10.0.0.5', target: { serviceTag: 'TAGX', vcenterId: 'vcA', model: 'R750' } }, err, onPickCorp: () => {}, now: 1 }));
    expect(withItem).not.toContain('서비스 태그'); expect(withItem).not.toContain('R750');
    const nf = renderToStaticMarkup(React.createElement(BmPerfDetailView, { itemKey: 'K', err: Object.assign(new Error('대상 서버를 찾지 못했습니다.'), { status: 404, body: { code: 'not-found' } }), now: 1 }));
    expect(nf).not.toContain('법인 고르기');
  });
});

describe('⑤-2 저장 단계 — key-conflict 사유를 화면이 이름으로 말한다(사유 코드가 그대로 새지 않게)', () => {
  it('서버 사유 표에 있고 · 대상 아닌 서버 각주 · 등록 누락 점검이 같은 사유를 글로', () => {
    expect(NO_PATH_REASON['key-conflict']).toMatch(/수집하지 않습니다/);
    expect(skippedNotes({ 'key-conflict': 2 }, NO_PATH_REASON)[0]).toMatch(/^\*\*키 충돌 2대\*\*/);
    expect(MISS_REASON_TEXT['key-conflict']).toMatch(/서비스태그/);
  });
});

describe('⑥ 소스 스윕 — 서버 하나 경로는 perfPath 하나로', () => {
  const files = fs.readdirSync(HERE).filter((f) => /^(Bm|bm).*\.(jsx|js)$/.test(f) && !/\.test\./.test(f));
  const src = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(HERE, f), 'utf8')]));
  it('‘/tools/bm-usage/perf/${’ 템플릿은 bmPerfUrl.js 에만(새 탭이 법인 없이 키만으로 부르지 못하게)', () => {
    const bad = Object.entries(src).filter(([f, s]) => f !== 'bmPerfUrl.js' && s.includes('/tools/bm-usage/perf/${')).map(([f]) => f);
    expect(bad).toEqual([]);
  });
  it('서버 하나를 받는 다른 경로도 법인을 싣는다(용량 상세 · 정비 음영 · 사용률 추이 · 용도 태그 · 주석 · 비교)', () => {
    expect(src['BmCapacityFleet.jsx']).toMatch(/capacity\/\$\{encodeURIComponent\(k\)\}\$\{v \? `\?vcenterId=/);
    expect(src['BmTrendTab.jsx']).toMatch(/maintenance\/occurrences\?key=\$\{encodeURIComponent\(itemKey\)\}\$\{vcenterId \? `&vcenterId=/);
    expect(src['BmUsage.jsx']).toMatch(/vc \? \{ \.\.\.q0, vcenterId: vc \}/);
    expect(src['BmProfileTab.jsx']).toMatch(/vcenterId: vc/);
    expect(src['BmAnnotations.jsx']).toMatch(/vcenterIds: vcList\.join/);
    expect(src['BmCompareView.jsx']).toMatch(/vcenterIds: vcs\.join/);
    expect(src['BmCompareView.jsx']).toMatch(/vcenterIds: live\.map/);
  });
});
