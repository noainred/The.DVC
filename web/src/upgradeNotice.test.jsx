// v2.999 — 업그레이드 뒤 '새로고침 하세요' 안내(사용자 요청 2026-11-13 · 설계 docs/design/upgrade-reload · 컨펌 '추천대로 전부 진행').
//   판정 코어(upgradeNotice.js) · 바뀐 것 요약(3줄 + More) · 오류 경계 분기 · 상자 렌더 · App 알림/배지 소스 스윕.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { stripComments } from './test/_stripComments.js';
import {
  normVersion, cmpVersion, isStale, noteServerVersion, loadedVersion, serverVersion, staleNow, subscribeUpgrade, noticeShown, markNoticeShown,
  checkServerVersion, cleanSince, summarize, loadSince, SUMMARY_LINES, UPGRADE_TITLE, SINCE_PATH, BUILT_VERSION, _resetUpgradeForTest,
} from './upgradeNotice.js';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import UpgradeNotice, { UpgradeChanges } from './components/UpgradeNotice.jsx';

const read = (rel) => stripComments(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));

const SAMPLE = {
  current: '2.999.0', from: '2.997.0', truncated: 0,
  notes: [
    { version: '2.999.0', date: '2026-11-13', title: '새로고침 안내', notes: ['첫째 줄', '둘째 줄'] },
    { version: '2.998.0', date: '2026-11-13', title: '서버 메뉴 이름 변경', notes: ['셋째 줄', '넷째 줄', '다섯째 줄'] },
  ],
};

beforeEach(() => _resetUpgradeForTest({ loaded: null }));

describe('판 비교 — 못 읽은 값은 다르다고 하지 않는다', () => {
  it('normVersion · cmpVersion', () => {
    expect(normVersion(' 2.999.0 ')).toBe('2.999.0');
    for (const bad of ['', '2.999', '2.999.0.1', 'v2.999.0', '2.999.0-rc', null, undefined, 2999, '1'.repeat(40)]) expect(normVersion(bad)).toBe(null);
    expect(cmpVersion('2.999.0', '3.0.0')).toBeLessThan(0);
    expect(cmpVersion('2.1000.0', '2.999.0')).toBeGreaterThan(0);   // 숫자 비교(글자 비교면 거꾸로)
    expect(cmpVersion('2.999.0', '2.999.0')).toBe(0);
    expect(cmpVersion('2.999.0', 'x')).toBe(null);
  });
  it('isStale — 다르면 true(되돌림 포함) · 같거나 못 읽으면 false', () => {
    expect(isStale('2.998.0', '2.999.0')).toBe(true);
    expect(isStale('2.999.0', '2.998.0')).toBe(true);
    expect(isStale('2.999.0', '2.999.0')).toBe(false);
    expect(isStale(null, '2.999.0')).toBe(false);
    expect(isStale('2.999.0', '')).toBe(false);
  });
  it('빌드 값은 vite define(web/package.json) — 테스트에서도 같은 값', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(BUILT_VERSION).toBe(pkg.version);
  });
});

describe('서버 판 저장소', () => {
  it('빌드 값이 없으면 처음 본 판이 이 창의 판 · 다음에 다른 판이 오면 stale · 구독자 호출', () => {
    let calls = 0; const off = subscribeUpgrade(() => { calls += 1; });
    noteServerVersion('2.998.0');
    expect(loadedVersion()).toBe('2.998.0');
    expect(staleNow()).toBe(false);
    noteServerVersion('2.998.0');           // 같은 값 — 다시 부르지 않는다
    noteServerVersion('not-a-version');      // 형식이 아니면 무시
    noteServerVersion('2.999.0');
    expect(serverVersion()).toBe('2.999.0');
    expect(loadedVersion()).toBe('2.998.0');
    expect(staleNow()).toBe(true);
    expect(calls).toBe(2);
    off();
  });
  it('빌드 값이 있으면 그것이 이 창의 판', () => {
    _resetUpgradeForTest({ loaded: '2.999.0' });
    noteServerVersion('2.999.0');
    expect(staleNow()).toBe(false);
    noteServerVersion('3.0.0');
    expect(staleNow()).toBe(true);
  });
  it('안내 상자 표시 — 마운트마다 세고 해제는 한 번만 · 구독자 호출(알림을 숨기는 근거)', () => {
    let calls = 0; subscribeUpgrade(() => { calls += 1; });
    expect(noticeShown()).toBe(false);
    const a = markNoticeShown(); const b = markNoticeShown();
    expect(noticeShown()).toBe(true);
    a(); a();                  // 두 번 불러도 한 번만 뺀다
    expect(noticeShown()).toBe(true);
    b();
    expect(noticeShown()).toBe(false);
    expect(calls).toBe(4);
  });
  it('checkServerVersion — /health 를 짧은 시한 · 재시도 없이 · 실패해도 던지지 않는다', async () => {
    _resetUpgradeForTest({ loaded: '2.998.0' });
    const seen = [];
    expect(await checkServerVersion(async (p, q, s, o) => { seen.push([p, o]); return { version: '2.999.0' }; })).toBe(true);
    expect(seen).toEqual([['/health', { timeoutMs: 5000, retries: 0 }]]);
    _resetUpgradeForTest({ loaded: '2.998.0' });
    expect(await checkServerVersion(async () => { throw new Error('down'); })).toBe(false);
  });
});

describe('바뀐 것 — 3줄 요약 + More', () => {
  it('cleanSince — 아는 필드만 · 판 형식이 아니면 버림 · 줄이 없으면 제목 한 줄', () => {
    const c = cleanSince({ notes: [{ version: '2.999.0', title: 'T', notes: [] }, { version: 'bad', notes: ['x'] }, null, { version: '2.998.0', title: '', notes: [' a ', '', 3] }], truncated: 2 });
    expect(c.notes).toEqual([{ version: '2.999.0', title: 'T', lines: ['T'] }, { version: '2.998.0', title: '', lines: ['a'] }]);
    expect(c.truncated).toBe(2);
    expect(cleanSince({})).toBe(null);
  });
  it('summarize — 새 판부터 앞 3줄 · 나머지 수', () => {
    const s = summarize(cleanSince(SAMPLE));
    expect(SUMMARY_LINES).toBe(3);
    expect(s.head.map((x) => x.text)).toEqual(['첫째 줄', '둘째 줄', '셋째 줄']);
    expect(s).toMatchObject({ total: 5, more: 2, versions: 2 });
    expect(summarize(null)).toMatchObject({ total: 0, more: 0 });
  });
  it('loadSince — 같은 (이 창 → 서버) 는 한 번만 · 실패는 다음에 다시 · 같은 판이면 부르지 않는다', async () => {
    let n = 0; const ok = async (p, q) => { n += 1; expect(p).toBe(SINCE_PATH); expect(q).toEqual({ from: '2.997.0' }); return SAMPLE; };
    const a = await loadSince('2.997.0', '2.999.0', ok);
    const b = await loadSince('2.997.0', '2.999.0', ok);
    expect(n).toBe(1); expect(a).toBe(b); expect(a.notes.length).toBe(2);
    let m = 0; const bad = async () => { m += 1; throw new Error('x'); };
    expect(await loadSince('2.990.0', '2.999.0', bad)).toBe(null);
    expect(await loadSince('2.990.0', '2.999.0', bad)).toBe(null);
    expect(m).toBe(2);
    expect(await loadSince('2.999.0', '2.999.0', ok)).toBe(null);
  });
  it('UpgradeChanges — 접힘 3줄 + More · 2줄 더 / 펼침 판별 전체 + 접기 / 3줄 이하면 More 없음 / 자료 없으면 그리지 않음', () => {
    const data = cleanSince(SAMPLE);
    const closed = renderToStaticMarkup(<UpgradeChanges data={data} open={false} onToggle={() => {}} />);
    expect((closed.match(/<li /g) || []).length).toBe(3);
    expect(closed).toContain('이번 업그레이드에서 바뀐 것');
    expect(closed).toContain('2개 판 · 5줄');
    expect(closed).toContain('More');
    expect(closed).toContain('· 2줄 더');
    expect(closed).not.toContain('다섯째 줄');
    const open = renderToStaticMarkup(<UpgradeChanges data={data} open onToggle={() => {}} />);
    expect((open.match(/<li>/g) || []).length).toBe(5);
    expect(open).toContain('v2.998.0');
    expect(open).toContain('서버 메뉴 이름 변경');
    expect(open).toContain('접기');
    const few = renderToStaticMarkup(<UpgradeChanges data={cleanSince({ notes: [SAMPLE.notes[0]] })} open={false} onToggle={() => {}} />);
    expect(few).not.toContain('More');
    expect(renderToStaticMarkup(<UpgradeChanges data={null} />)).toBe('');
  });
});

describe('오류 상자 · 오류 경계', () => {
  it('UpgradeNotice — 문구 · 이 창 → 지금 판 · 바뀐 것 · 새로고침', () => {
    const html = renderToStaticMarkup(<UpgradeNotice versions={{ loaded: '2.997.0', server: '2.999.0', stale: true }} notes={cleanSince(SAMPLE)} />);
    expect(html).toContain(UPGRADE_TITLE);
    expect(UPGRADE_TITLE).toBe('프로그램이 업그레이드되었으니 새로고침 하세요.');
    expect(html).toContain('v2.997.0');
    expect(html).toContain('v2.999.0');
    expect(html).toContain('첫째 줄');
    expect(html).toContain('새로고침');
    // 판을 모르면(화면 조각 오류 · 개발 서버) 판 줄과 바뀐 것은 그리지 않는다 — 지어내지 않는다
    const bare = renderToStaticMarkup(<UpgradeNotice versions={{ loaded: null, server: null, stale: false }} notes={null} />);
    expect(bare).toContain(UPGRADE_TITLE);
    expect(bare).not.toContain('이 창');
    expect(bare).not.toContain('이번 업그레이드에서 바뀐 것');
  });
  it('getDerivedStateFromError — 판이 같으면 예전 오류 상자 · 다르면 업그레이드 · 화면 조각 오류는 늘 업그레이드', () => {
    _resetUpgradeForTest({ loaded: '2.998.0' });
    noteServerVersion('2.998.0');
    expect(ErrorBoundary.getDerivedStateFromError(new Error('boom')).upgrade).toBe(false);
    expect(ErrorBoundary.getDerivedStateFromError(new Error('Failed to fetch dynamically imported module: /assets/x.js')).upgrade).toBe(true);
    noteServerVersion('2.999.0');
    expect(ErrorBoundary.getDerivedStateFromError(new Error('boom')).upgrade).toBe(true);
  });
  it('render — 업그레이드면 fallback 보다 먼저 안내 상자(감싸는 클래스) · 아니면 fallback / 오류 원문 + 다시 시도', () => {
    const fb = <div>FALLBACK</div>;
    const up = new ErrorBoundary({ fallback: fb, upgradeClassName: 'login-screen' });
    up.state = { error: new Error('boom'), upgrade: true };
    const h1 = renderToStaticMarkup(up.render());
    expect(h1).toContain(UPGRADE_TITLE);
    expect(h1).toContain('class="login-screen"');
    expect(h1).not.toContain('FALLBACK');
    const same = new ErrorBoundary({ fallback: fb });
    same.state = { error: new Error('boom'), upgrade: false };
    expect(renderToStaticMarkup(same.render())).toContain('FALLBACK');
    const plain = new ErrorBoundary({});
    plain.state = { error: new Error('boom'), upgrade: false };
    const h3 = renderToStaticMarkup(plain.render());
    expect(h3).toContain('이 영역을 표시하는 중 오류가 발생했습니다.');
    expect(h3).toContain('boom');
    expect(h3).toContain('다시 시도');
  });
});

describe('App — 알림은 닫을 때까지 · 배지 · 판정은 저장소 하나', () => {
  const app = read('./App.jsx');
  it('8초 자동 사라짐 · 옛 판정(lastVerRef) 없음 · 서버 판을 저장소로', () => {
    expect(app).not.toMatch(/setUpToast|lastVerRef/);
    expect(app).not.toMatch(/setTimeout\(\(\) => setUpToast/);
    expect(app).toMatch(/useEffect\(\(\) => \{ noteServerVersion\(health\?\.version\); \}, \[health\?\.version\]\);/);
    expect(app).toContain('{UPGRADE_TITLE}');
    expect(app).toMatch(/setUpDismissedFor\(upv\.server\)/);
    expect(app).toMatch(/const showUpToast = upv\.stale && !upv\.noticeOpen && upDismissedFor !== upv\.server;/);   // 상자가 떠 있으면 알림을 숨긴다(1440 겹침)
    expect(app).toMatch(/upv\.stale && \(\s*<button type="button" className="ver-badge brand-ver upg-need"/);
    expect(app).toContain('새로고침 필요');
  });
  it('포탈 전체 경계는 안내 상자를 가운데(login-screen)로', () => {
    expect(app).toMatch(/<ErrorBoundary upgradeClassName="login-screen" fallback=\{/);
  });
});
