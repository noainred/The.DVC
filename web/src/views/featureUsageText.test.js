// v2.913 기능 사용 현황 — 순수 판정 · 문구(키 이름 · 위치 · 묶음 · 결측 '—' · 단서 규칙).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  keyMeta, allUsageKeys, menuItemKeys, fmtDur, fmtInt, avgPerView, pctText, trendOf, bucketShares, perDay, usageHints, filterFeatures, filterUsers, BUCKETS, fmtWhen, fmtBytes,
} from './featureUsageText.js';
import { TOOL_SEGS as TRACKER_SEGS } from '../usageTracker.js';
import { TOOL_SEGS } from './featureUsageText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ctx = { settingsMeta: [{ k: 'audit', label: '감사 로그', groupLabel: '로그' }, { k: 'feature-usage', label: '기능 사용 현황', groupLabel: '사용자' }, { k: 'isilon-dirusage', label: '아이실론', groupLabel: '수집', superOnly: true }] };

describe('keyMeta', () => {
  it('탭 · 도구 · 설정 · 콘솔의 이름과 메뉴 위치', () => {
    expect(keyMeta('tab:vms', ctx)).toMatchObject({ label: '가상화 서버', where: '서버 › 가상화 서버', bucket: 'server', inMenu: true, kindLabel: '탭' });
    expect(keyMeta('tab:overview', ctx)).toMatchObject({ label: 'Overview', bucket: 'home' });
    expect(keyMeta('tool:storage-mon', ctx)).toMatchObject({ label: '스토리지 현황', where: '스토리지 › 스토리지 현황', bucket: 'storage', inMenu: true, adminOnly: true });
    expect(keyMeta('tool:vmfinder', ctx)).toMatchObject({ where: '서버 › 가상화 서버 화면 위 탭', bucket: 'server', cardOnly: false });
    expect(keyMeta('tool:serveranalysis/baremetal', ctx)).toMatchObject({ label: '물리 서버', where: '서버 › 물리 서버' });
    expect(keyMeta('tool:serveranalysis', ctx)).toMatchObject({ where: '자원관리 › 서버 분석' });
    const card = keyMeta('tool:login-fails', ctx);
    expect(card).toMatchObject({ where: '특수 기능 카드', bucket: 'tools', cardOnly: true, inMenu: false, auth: '관리자 전용' });
    expect(keyMeta('settings:audit', ctx)).toMatchObject({ label: '감사 로그', where: '설정 › 로그 › 감사 로그', kindLabel: '설정', auth: '설정 소유자' });
    expect(keyMeta('settings:isilon-dirusage', ctx).auth).toBe('슈퍼 관리자');
    expect(keyMeta('console:compute', ctx)).toMatchObject({ label: '관제 콘솔 › 컴퓨트', kindLabel: '콘솔' });
    expect(keyMeta('tool:diskadd', ctx).notReady).toBe(true);
  });
  it('추적 단위 전체에는 메뉴 · 도구 · 설정 · 콘솔이 다 들어 있다', () => {
    const all = allUsageKeys(ctx);
    for (const k of ['tab:vms', 'tab:tools', 'tab:settings', 'tool:vmfinder', 'tool:serveranalysis/baremetal', 'settings:audit', 'console:alarms']) expect(all).toContain(k);
    expect(new Set(all).size).toBe(all.length);
    expect(menuItemKeys(ctx)).toContain('settings:feature-usage');
    expect(menuItemKeys(ctx)).not.toContain('tool:login-fails');
  });
  it('추적기와 이름표의 TOOL_SEGS 가 같다', () => { expect(TOOL_SEGS).toEqual(TRACKER_SEGS); });
});

describe('수치 · 결측', () => {
  it('못 센 것은 0 이 아니다', () => {
    expect(fmtDur(null)).toBe('—');
    expect(fmtDur(12_000)).toBe('12초');
    expect(fmtDur(228_000)).toBe('3분 48초');
    expect(fmtDur(41 * 3_600_000 + 20 * 60_000)).toBe('41시간 20분');
    expect(fmtInt(null)).toBe('—');
    expect(avgPerView(1000, 0)).toBe('—');
    expect(pctText(1, 0)).toBe('—');
    expect(perDay(100, 0)).toBe(null);
    expect(perDay(100, 4)).toBe(25);
    expect(fmtWhen(null)).toBe('—');
    expect(fmtBytes(null)).toBe('크기 —');
    expect(fmtBytes(90_000)).toBe('88 KB');
    expect(fmtBytes(3 * 1048576)).toBe('3.0 MB');
  });
  it('지난 기간 대비 — 기록 없음은 —, 0 에서 늘면 새로', () => {
    expect(trendOf(10, null)).toEqual({ text: '—', dir: 'flat' });
    expect(trendOf(10, 0)).toEqual({ text: '새로', dir: 'up' });
    expect(trendOf(0, 0)).toEqual({ text: '—', dir: 'flat' });
    expect(trendOf(106, 100)).toEqual({ text: '+6%', dir: 'up' });
    expect(trendOf(98, 100)).toEqual({ text: '−2%', dir: 'flat' });
    expect(trendOf(50, 100).dir).toBe('dn');
    expect(trendOf(290, 300, 29, 30)).toEqual({ text: '0%', dir: 'flat' }, '이번 기간에 꺼진 날이 있으면 하루 평균끼리');
  });
});

describe('묶음 · 단서 · 필터', () => {
  const rep = {
    range: { days: 14 }, totals: { recDays: 10, views: 100 },
    byKey: [
      { k: 'tab:vms', views: 50, users: 5 }, { k: 'tool:login-fails', views: 20, users: 3 }, { k: 'tool:serial-lookup', views: 9, users: 1 },
      { k: 'settings:audit', views: 15, users: 2 }, { k: 'tab:issues', views: 6, users: 2 },
    ],
    userKeys: [['a', 'settings:audit', 12], ['b', 'settings:audit', 3], ['a', 'tool:login-fails', 7]],
  };
  it('색은 묶음에 고정(순위로 칠하지 않는다) · 기타 내역', () => {
    const s = bucketShares(rep.byKey, ctx);
    expect(s.total).toBe(100);
    expect(s.rows.map((r) => r.id)).toEqual(BUCKETS.map((b) => b.id));
    expect(s.rows.find((r) => r.id === 'server').views).toBe(50);
    expect(s.rows.find((r) => r.id === 'tools').views).toBe(29);
    expect(s.rows.find((r) => r.id === 'collab').views).toBe(6);
    expect(s.etc[0]).toEqual(['설정', 15]);
  });
  it('승격 · 정리 · 깊이 규칙', () => {
    const h = usageHints(rep, ctx);
    expect(h.promote.map((x) => x.k)).toEqual(['tool:login-fails'], '카드 전용 · 2명 이상만(serial-lookup 은 1명)');
    expect(h.prune.total).toBeGreaterThan(0);
    expect(h.prune.items.every((x) => x.k !== 'tab:vms')).toBe(true);
    expect(h.depth.map((x) => x.k)).toEqual(['tool:login-fails', 'settings:audit'], '열람 많은 순');
    expect(h.depth[0].users).toBe(1, '주 3회 이상(14일에 6회 이상)인 사람만');
    expect(usageHints({ ...rep, totals: { recDays: 0 } }, ctx).prune.total).toBe(0, '기록한 날이 없으면 판단하지 않는다');
  });
  it('필터', () => {
    const rows = [{ k: 'tab:vms', views: 3, meta: keyMeta('tab:vms', ctx) }, { k: 'tool:diskadd', views: 0, meta: keyMeta('tool:diskadd', ctx) }, { k: 'tool:storage-mon', views: 0, meta: keyMeta('tool:storage-mon', ctx) }];
    expect(filterFeatures(rows, { status: 'unused' }).map((r) => r.k)).toEqual(['tool:storage-mon'], '준비 중은 안 씀에서 뺀다');
    expect(filterFeatures(rows, { status: 'notReady' }).map((r) => r.k)).toEqual(['tool:diskadd']);
    expect(filterFeatures(rows, { q: '스토리지' }).map((r) => r.k)).toEqual(['tool:storage-mon']);
    const users = [{ user: 'a', name: '가', role: 'admin', scoped: false, src: 'local' }, { user: 'b', role: 'viewer', scoped: true, src: 'ad' }];
    expect(filterUsers(users, { scope: 'scoped' }).map((u) => u.user)).toEqual(['b']);
    expect(filterUsers(users, { q: '가' }).map((u) => u.user)).toEqual(['a']);
  });
});

describe('화면 규약(소스)', () => {
  const src = fs.readFileSync(path.join(HERE, 'FeatureUsage.jsx'), 'utf8');
  const css = fs.readFileSync(path.join(HERE, 'featureUsage.css'), 'utf8');
  it('표는 STable · 폴링 없음 · uppercase 없음 · 문구에 백틱 없음', () => {
    expect(src).not.toMatch(/<table[\s>]/);
    expect(src).not.toMatch(/usePolling|setInterval/);
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/uppercase/);
    for (const m of src.matchAll(/<BoldText text=\{'([^']*)'\}/g)) expect(m[1]).not.toMatch(/`/);   // BoldText 문구에 백틱 금지
  });
  it('늦게 온 이전 응답은 버린다(reqId)', () => {
    expect(src).toMatch(/if \(id === reqId\.current\) setRep\(r\)/);
  });
});
