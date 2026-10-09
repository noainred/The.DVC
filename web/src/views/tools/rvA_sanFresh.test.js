/**
 * rvA_sanFresh.test.js — 검토 I-04: SAN 트래픽 카드가 첫 성공 뒤의 조회 실패(503·90초 시한)를 숨기던 결함.
 *
 * ① 순수 판정(sanFreshText) — 합격 기준의 시나리오를 렌더 순서대로 흘린다:
 *    성공→시한→성공 · 성공→503 · 최초 실패 · 304 · 선택(기간·법인) 변경 직후 한 렌더.
 * ② 실제 TrafficCard 렌더(react-dom/server) — usePolling 만 대체해 상태별로 화면에 무엇이 남는지 본다.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { trackFetch, echoMatches, freshState, freshNote, badgeFor, clockText, failReasonText } from './sanFreshText.js';

const D1 = { id: 'd1' }; const D2 = { id: 'd2' };
const KEY = '{"hours":24}';
/** 렌더 순서대로 관찰을 흘린다 — [data, error, t] 목록. 마지막 추적 상태를 돌려준다. */
const run = (steps, key = KEY, start = null) => steps.reduce((tr, [data, error, t]) => trackFetch(tr, { data, error, key }, t), start);

describe('I-04 신선도 판정(순수)', () => {
  it('성공 → 시한 초과 → 성공: 시한 동안 차트(직전 값)와 경고가 함께, 다음 성공에서 경고만 사라진다', () => {
    let tr = run([[null, null, 0], [D1, null, 1_000]]);
    expect(freshState(tr)).toMatchObject({ state: 'fresh', usable: true, okAt: 1_000 });
    tr = trackFetch(tr, { data: D1, error: 'signal timed out', key: KEY }, 91_000);
    const st = freshState(tr);
    expect(st).toMatchObject({ state: 'failed-with-data', usable: true, okAt: 1_000, failAt: 91_000 });
    const note = freshNote(st, { what: '트래픽 합계', pollMs: 60_000, timeoutMs: 90_000 });
    expect(note.title).toBe('트래픽 합계 갱신 실패 — 직전 조회 결과 표시 중');
    expect(note.text).toContain(`마지막 성공 ${clockText(1_000)}`);
    expect(note.text).toContain(`조회 실패 ${clockText(91_000)}부터`);
    expect(note.text).toContain('응답 시한(90초) 초과');
    expect(badgeFor(st, '● 5분마다 수집').live).toBe(false);
    // 같은 오류가 이어져도(다음 주기 실패) 실패 시작 시각은 그대로
    tr = trackFetch(tr, { data: D1, error: 'signal timed out', key: KEY }, 181_000);
    expect(freshState(tr).failAt).toBe(91_000);
    // 다음 성공
    tr = trackFetch(tr, { data: D2, error: null, key: KEY }, 200_000);
    const ok = freshState(tr);
    expect(ok).toMatchObject({ state: 'fresh', usable: true, okAt: 200_000, failAt: null });
    expect(freshNote(ok)).toBe(null);
    expect(badgeFor(ok, '5분마다 수집')).toEqual({ text: '5분마다 수집', live: true });
  });
  it('성공 → 503: 서버 사유를 그대로 말하고 직전 값을 남긴다', () => {
    const tr = run([[null, null, 0], [D1, null, 1_000], [D1, '조회 엔진을 재시작했습니다(60초 초과)', 70_000]]);
    const st = freshState(tr);
    expect(st.state).toBe('failed-with-data');
    expect(st.usable).toBe(true);
    expect(freshNote(st, { what: '트래픽 합계', pollMs: 60_000, timeoutMs: 90_000 }).text).toContain('조회 엔진을 재시작했습니다(60초 초과)');
  });
  it('최초 실패: 쓸 값이 없고 실패 시각과 사유를 말한다(차트 없음)', () => {
    const tr = run([[null, null, 0], [null, 'HTTP 503', 5_000]]);
    const st = freshState(tr);
    expect(st).toMatchObject({ state: 'first-fail', usable: false, failAt: 5_000 });
    const n = freshNote(st, { what: '트래픽 합계', pollMs: 60_000 });
    expect(n.title).toBe('트래픽 합계를 불러오지 못했습니다');
    expect(n.text).toContain(`실패 ${clockText(5_000)}`);
    expect(n.sub).toContain('약 1분 뒤 다시 조회합니다');
    expect(badgeFor(st, 'x')).toEqual({ text: '', live: false });
  });
  it('304(본문 없음)는 실패가 아니다 — 성공 뒤 304 는 그대로 fresh, 실패 뒤 304 는 복구(마지막 성공을 지금으로)', () => {
    // usePolling: 304 면 data 를 그대로 두고 error 를 null 로 — 같은 객체·null 오류로 관찰된다.
    let tr = run([[null, null, 0], [D1, null, 1_000], [D1, null, 61_000]]);
    expect(freshState(tr)).toMatchObject({ state: 'fresh', okAt: 1_000 });   // 304 연속은 다시 그려지지 않는다 — 과장하지 않는다
    tr = trackFetch(tr, { data: D1, error: 'HTTP 503', key: KEY }, 121_000);
    tr = trackFetch(tr, { data: D1, error: null, key: KEY }, 181_000);     // 304 로 복구
    expect(freshState(tr)).toMatchObject({ state: 'fresh', okAt: 181_000, failAt: null });
  });
  it('같은 입력을 두 번 넣어도 결과가 같다(StrictMode 이중 렌더)', () => {
    const a = run([[null, null, 0], [D1, null, 1_000], [D1, 'x', 2_000]]);
    const b = trackFetch(a, { data: D1, error: 'x', key: KEY }, 9_999);
    expect(freshState(b)).toEqual(freshState(a));
  });
  it('선택(기간·법인)을 바꾼 직후 한 렌더: 이전 조건의 data·오류는 쓰지 않는다(불러오는 중)', () => {
    const k1 = '{"hours":24}'; const k2 = '{"hours":1}';
    let tr = run([[null, null, 0], [D1, null, 1_000]], k1);
    tr = trackFetch(tr, { data: D1, error: null, key: k2 }, 2_000);    // usePolling 이 아직 비우지 않았다
    expect(freshState(tr)).toMatchObject({ state: 'loading', usable: false });
    tr = trackFetch(tr, { data: null, error: null, key: k2 }, 2_001);  // 효과가 비웠다
    expect(freshState(tr).state).toBe('loading');
    tr = trackFetch(tr, { data: D2, error: null, key: k2 }, 30_000);
    expect(freshState(tr)).toMatchObject({ state: 'fresh', okAt: 30_000 });
    // 이전 조건의 실패도 새 조건에 실리지 않는다
    let t2 = run([[null, null, 0], [D1, null, 1_000], [D1, 'timeout', 5_000]], k1);
    t2 = trackFetch(t2, { data: D1, error: 'timeout', key: k2 }, 6_000);
    expect(freshState(t2).state).toBe('loading');
    expect(freshNote(freshState(t2))).toBe(null);
  });
  it('응답이 되돌려 준 조건(hours·datacenterIds)이 다르면 쓰지 않는다 · 필드가 없으면 판정하지 않는다', () => {
    const data = { hours: 24, datacenterIds: ['dc-b', 'dc-a'] };
    expect(echoMatches(data, { hours: 24, datacenterIds: ['dc-a', 'dc-b'] })).toBe(true);
    expect(echoMatches(data, { hours: 1, datacenterIds: ['dc-a', 'dc-b'] })).toBe(false);
    expect(echoMatches(data, { hours: 24, datacenterIds: ['dc-a'] })).toBe(false);
    expect(echoMatches({ hours: 24, datacenterIds: [] }, { hours: 24, datacenterIds: [] })).toBe(true);
    expect(echoMatches({}, { hours: 24, datacenterIds: ['x'] })).toBe(true);
    expect(echoMatches(null, { hours: 24 })).toBe(false);
    const tr = run([[null, null, 0], [data, null, 1]]);
    expect(freshState(tr, { matches: false })).toMatchObject({ state: 'loading', usable: false });
  });
  it('권한 거부로 자동 조회가 멈췄으면 "다시 조회합니다" 라고 말하지 않는다', () => {
    const st = freshState(run([[null, null, 0], [D1, null, 1], [D1, 'forbidden', 2]]));
    const n = freshNote(st, { what: '스위치 목록', pollMs: 30_000, stopped: true });
    expect(n.sub).toContain('자동 조회를 멈췄습니다');
    expect(n.sub).not.toContain('다시 조회합니다.');
  });
  it('문구에 백틱·별표가 없다(평문 자리) · 사유 판정', () => {
    const st = freshState(run([[null, null, 0], [D1, null, 1], [D1, new Error('The operation was aborted due to timeout'), 2]]));
    const n = freshNote(st, { what: 'x', pollMs: 60_000 });
    for (const v of Object.values(n)) { expect(v).not.toMatch(/`/); expect(v).not.toMatch(/\*\*/); }
    expect(n.text).toContain('응답 시한 초과');
    expect(failReasonText({ serverReason: '사유' })).toBe('사유');
    expect(failReasonText('')).toBe('알 수 없는 오류');
    expect(clockText(null)).toBe('—');
  });
});

// ── ② 실제 TrafficCard 렌더 — usePolling 만 대체한다(나머지 api.js 는 그대로) ──────────────────
let polled = { data: null, error: null, errorInfo: null, loading: true };
vi.mock('../../api.js', async (orig) => ({ ...(await orig()), usePolling: () => polled }));
const { TrafficCard } = await import('./SanSwitchV2Parts.jsx');

const TRAFFIC = {
  ok: true, unit: 'bytesPerSec', hours: 24, datacenterIds: [], buckets: [1_000, 2_000, 3_000], total: [1e9, 1.2e9, 1.1e9],
  now: { ts: 3_000, bps: 1.1e9 }, avg: 1.1e9, peak: { ts: 2_000, bps: 1.2e9 }, byDatacenter: [{ datacenterId: 'dc-a', name: 'NJ', bps: 1.1e9 }],
  datacenters: 1, switches: 2, arrays: 1, intervalMs: 300_000, enabled: true, lastSampleAt: Date.now(),
};
const render = (p, props = {}) => { polled = { loading: false, errorInfo: null, ...p }; return renderToStaticMarkup(React.createElement(TrafficCard, props)); };

describe('I-04 TrafficCard 렌더', () => {
  it('정상: 실시간 배지(●)와 값, 경고 없음', () => {
    const html = render({ data: TRAFFIC, error: null });
    expect(html).toContain('san2-badge-live');
    expect(html).toContain('5분마다 수집');
    expect(html).not.toContain('갱신 실패');
    expect(html).toContain('지금');
  });
  it('직전 성공 + 지금 실패(시한): 값(직전 결과)과 경고가 함께 보이고 배지는 실시간이 아니다', () => {
    const html = render({ data: TRAFFIC, error: 'signal timed out' });
    expect(html).toContain('트래픽 합계 갱신 실패 — 직전 조회 결과 표시 중');
    expect(html).toContain('마지막 성공');
    expect(html).toContain('응답 시한(90초) 초과');
    expect(html).not.toContain('san2-badge-live');
    expect(html).toContain('갱신 실패 · 마지막 성공');
    expect(html).toContain('기간 평균');                       // 차트 범례(직전 결과)가 남아 있다
    expect(html).not.toContain('불러오는 중입니다');
  });
  it('최초 실패: 차트 없이 실패 안내', () => {
    const html = render({ data: null, error: '조회 엔진을 재시작했습니다' });
    expect(html).toContain('트래픽 합계를 불러오지 못했습니다');
    expect(html).toContain('조회 엔진을 재시작했습니다');
    expect(html).not.toContain('기간 평균');
    expect(html).not.toContain('san2-badge-live');
  });
  it('첫 조회 중: 불러오는 중 안내', () => {
    const html = render({ data: null, error: null });
    expect(html).toContain('불러오는 중입니다');
    expect(html).not.toContain('갱신 실패');
  });
  it('응답이 다른 조건(법인)의 것이면 차트를 그리지 않는다(불러오는 중)', () => {
    const html = render({ data: { ...TRAFFIC, datacenterIds: ['dc-other'] }, error: null }, { datacenterIds: ['dc-a'], selected: 1 });
    expect(html).toContain('불러오는 중입니다');
    expect(html).not.toContain('기간 평균');
    const same = render({ data: { ...TRAFFIC, datacenterIds: ['dc-a'] }, error: null }, { datacenterIds: ['dc-a'], selected: 1 });
    expect(same).toContain('기간 평균');
  });
});

// ── ③ 같은 패턴의 형제 화면 배선(보조 소스 확인 — 이 화면들은 effect 로 조회해 서버 렌더로는 상태를 만들 수 없다) ──
import fs from 'node:fs';
import path from 'node:path';
import { stripComments } from '../../test/_stripComments.js';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const src = (rel) => stripComments(fs.readFileSync(path.resolve(HERE, rel), 'utf8'));

describe('I-04 형제 화면 배선', () => {
  it('SAN 스위치 목록(30초 폴링): 첫 성공 뒤 실패를 머리 안내로 말하고 "N초마다 갱신" 을 실패 중에 쓰지 않는다', () => {
    const s = src('./SanSwitchTool.jsx');
    expect(s).toMatch(/listTr\.current = trackFetch\(listTr\.current, \{ data, error, key: 'list' \}/);
    expect(s).toMatch(/<FreshNote note=\{listNote\}/);
    expect(s).toMatch(/listFresh\.state === 'failed-with-data'/);
  });
  it('장비 포트 사용량·법인 스토리지 사용량: 응답·오류에 요청 키를 붙이고 지금 키와 같은 것만 그린다', () => {
    const s = src('./SanSwitchTool.jsx');
    expect(s).toMatch(/setData\(\{ \.\.\.d, view: v, reqKey: key \}\)/);
    expect(s).toMatch(/data\.reqKey === perfKey/);
    expect(s).toMatch(/error && error\.key === perfKey/);
    expect(s).toMatch(/const data = got && got\.key === sumKey \? got\.d : null;/);
    expect(s).toMatch(/const error = errGot && errGot\.key === sumKey \? errGot\.msg : null;/);
  });
  it('포트 사용량 수집 설정(20초 폴링): 첫 성공 뒤 실패를 말한다', () => {
    const s = src('../SanSwitchPerf.jsx');
    expect(s).toMatch(/trackFetch\(trRef\.current, \{ data, error, key: 'settings' \}/);
    expect(s).toMatch(/<FreshNote note=\{note\}/);
  });
});
