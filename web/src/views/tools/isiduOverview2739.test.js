/**
 * v2.739 아이실론 디렉터리 사용량 — 서브메뉴(서머리·법인 현황·수집 상태·전 법인 Top 10) 계산 + 일괄 변경 문구·변환.
 * 서버 계약(일괄 변경 키 · 사유 코드 · 시한 상한 · 정렬 규칙 · 주기 규칙)은 서버 소스를 읽어 대조한다 — 한쪽만 바뀌면 화면이 거짓을 말한다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SUBVIEW_KEYS, viewOfSegs, hashOfView, STATUS_GROUPS, statusCounts, progressOf, nextRunOf, overviewIndex, summaryModel, crossTop,
  corpChoices, corpCards, miniLine, aheadText, attemptText,
} from './isiduOverviewText.js';
import {
  BULK_FIELD_KEYS, NOT_APPLIED_TEXT, notAppliedText, blankBulk, bulkPatchFrom, patchSummary, bulkResultText, presetIds, seqProgressText,
  RUN_FOLLOW as BULK_RUN_FOLLOW, MAIL_MODES,
} from './isiduBulkText.js';
import { TIMEOUT_CHOICES, RUN_FOLLOW, blankTarget } from './isiduText.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, '../../../../server/src');
const src = (p) => fs.readFileSync(path.join(SERVER, p), 'utf8');
const arrOf = (text, name) => {
  const m = text.match(new RegExp(`const ${name} = Object\\.freeze\\(\\[([^\\]]*)\\]\\)`));
  if (!m) throw new Error(`${name} 를 서버 소스에서 찾지 못했습니다`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
};
const MIN = 60_000; const HOUR = 3_600_000; const DAY = 24 * HOUR; const GIB = 1024 ** 3;
const NOW = Date.UTC(2026, 9, 15, 3, 0, 0);

describe('서버 계약 대조', () => {
  const bulk = src('isidu/bulk.js');
  it('일괄 변경 항목 키 = 서버 BULK_KEYS(한쪽에만 생기면 고를 수 없거나 400)', () => {
    const server = [...arrOf(bulk, 'BOOL_KEYS'), ...arrOf(bulk, 'NUM_KEYS'), ...arrOf(bulk, 'STR_KEYS'), 'mailTo'];
    expect(bulk).toMatch(/BULK_KEYS = Object\.freeze\(\[\.\.\.BOOL_KEYS, \.\.\.NUM_KEYS, \.\.\.STR_KEYS, 'mailTo'\]\)/);
    expect([...BULK_FIELD_KEYS].sort()).toEqual([...server].sort());
  });
  it('대상에서 뺀 사유 문구 = 서버 NOT_APPLIED_CODES 와 1:1 · 실제로 쓰는 코드가 전부 목록에 있다', () => {
    const codes = arrOf(bulk, 'NOT_APPLIED_CODES');
    expect(Object.keys(NOT_APPLIED_TEXT).sort()).toEqual([...codes].sort());
    const used = [...bulk.matchAll(/skipKey\('[^']+', '([^']+)'\)/g)].map((x) => x[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const c of used) expect(codes).toContain(c);
    expect(notAppliedText('dc-from-registry')).toMatch(/등록부 장비/);
    expect(notAppliedText('모르는-코드')).toBe('모르는-코드');
  });
  it('메일 모드 = 서버 MAIL_TO_MODES · 장비 담당 따름 표지 = 서버 RUN_FOLLOW', () => {
    expect(MAIL_MODES.map(([k]) => k).filter(Boolean).sort()).toEqual(arrOf(bulk, 'MAIL_TO_MODES').sort());
    expect(bulk).toContain(`RUN_FOLLOW = '${BULK_RUN_FOLLOW}'`);
    expect(BULK_RUN_FOLLOW).toBe(RUN_FOLLOW);
  });
  it('시한 선택지: 최대 180분(3시간) = 서버 RANGES 상한 · 기본 120분(2시간)', () => {
    const s = src('isidu/settings.js');
    const m = s.match(/timeoutMin: \{ min: (\d+), max: (\d+), def: (\d+) \}/);
    expect(m).toBeTruthy();
    expect(Math.max(...TIMEOUT_CHOICES)).toBe(Number(m[2]));
    expect(Number(m[2])).toBe(180);
    expect(Number(m[3])).toBe(120);
    expect(TIMEOUT_CHOICES).toContain(120);
    expect(blankTarget().timeoutMin).toBe(120);
    for (const v of TIMEOUT_CHOICES) expect(v >= Number(m[1]) && v <= Number(m[2])).toBe(true);
  });
  it('다음 예정 계산은 서버 poller.isDue 와 같은 규칙(성공 = 주기 · 실패 = min(주기, 재시도))', () => {
    const p = src('isidu/poller.js');
    expect(p).toMatch(/const wait = last\.ok \? iv : Math\.min\(iv, FAIL_RETRY_MS\);/);
  });
  it('Top 10 순서 = 서버 parse.sortBySize(크기 내림차순 → 이름 순 — 인자 없는 Intl.Collator = 인자 없는 localeCompare 와 같은 순서)', () => {
    // v2.740 E-03: 서버가 성능 때문에 localeCompare 를 재사용 Collator 로 바꿨다(인자 없는 생성 — 같은 순서). 웹 crossTop 은 localeCompare 그대로다.
    const p = src('isidu/parse.js');
    expect(p).toMatch(/sort\(bySizeThenName\)/);
    expect(p).toMatch(/const NAME_COLLATOR = new Intl\.Collator\(\);/);
    expect(p).toMatch(/\(b\.bytes - a\.bytes\) \|\| NAME_COLLATOR\.compare\(String\(a\.name\), String\(b\.name\)\)/);
  });
});

describe('서브메뉴 주소', () => {
  // v2.740(사용자 요청): 서머리 탭을 없애고 법인 현황 → 전 법인 Top 10 → 수집 상태 순서. 첫 화면·모르는 조각·옛 서머리 주소는 법인 현황.
  it('세 페이지(법인 현황·Top 10·수집 상태 순서) + 대상 화면 · 모르는 조각과 옛 서머리 주소는 법인 현황', () => {
    expect(SUBVIEW_KEYS).toEqual(['corps', 'top10', 'status']);
    expect(viewOfSegs(['tools', 'isilon-dirusage'])).toEqual({ view: 'corps', targetId: '' });
    expect(viewOfSegs(['tools', 'isilon-dirusage', 'status'])).toEqual({ view: 'status', targetId: '' });
    expect(viewOfSegs(['tools', 'isilon-dirusage', 'nope'])).toEqual({ view: 'corps', targetId: '' });
    expect(viewOfSegs(['tools', 'isilon-dirusage', 'summary'])).toEqual({ view: 'corps', targetId: '' });
    expect(viewOfSegs(['tools', 'isilon-dirusage', 't', 'a%2Fb'])).toEqual({ view: 'target', targetId: 'a/b' });
    expect(viewOfSegs(['tools', 'other'])).toBe(null);
  });
  it('주소 왕복', () => {
    for (const k of SUBVIEW_KEYS) expect(viewOfSegs(hashOfView(k).slice(2).split('/'))).toEqual({ view: k, targetId: '' });
    expect(hashOfView('target', 'a/b')).toBe('#/tools/isilon-dirusage/t/a%2Fb');
    expect(hashOfView('target', '')).toBe('#/tools/isilon-dirusage/corps');
    expect(hashOfView('엉뚱')).toBe('#/tools/isilon-dirusage/corps');
    expect(hashOfView('summary')).toBe('#/tools/isilon-dirusage/corps');
  });
});

const okT = (id, corp, bytes, extra = {}) => ({
  id, corp, label: id.toUpperCase(), host: `${id}.isi`, deviceName: `isi-${id}`, path: `/ifs/${id}`, intervalHours: 24, timeoutMin: 120,
  okScan: { id: 1, ts: NOW - HOUR, total: { bytes, res: 1 }, sumBytes: bytes, count: 3, errLines: 0 },
  lastTry: { id: 1, ts: NOW - HOUR, ok: true }, ...extra,
});
const ovOk = (id, { delta = null, base = true, denom = null, top = [], points = [] } = {}) => ({
  id, state: 'ok', scan: { ts: NOW - HOUR, path: `/ifs/${id}`, denom, sizeMode: 'h' }, base7: base ? { ts: NOW - 7 * DAY } : null,
  totalDelta7: delta == null ? null : { bytes: delta, withinRes: false }, top, points,
});

describe('상태 묶음 · 진행 · 다음 예정', () => {
  it('묶음 합 = 대상 수(빈 원소는 세지 않는다)', () => {
    const c = statusCounts([okT('a', 'S', 10), { id: 'b', enabled: false }, null, { id: 'c', running: { since: NOW - MIN } }, { id: 'd', lastTry: { ts: NOW - HOUR, ok: false, kind: 'auth' }, intervalHours: 24 }], NOW);
    expect(c.total).toBe(4);
    expect(c.ok + c.warn + c.run + c.bad + c.muted).toBe(c.total);
    expect(c).toMatchObject({ ok: 1, run: 1, muted: 1 });
    expect(STATUS_GROUPS.map(([k]) => k)).toEqual(['ok', 'warn', 'run', 'bad', 'muted']);
  });
  it('진행 막대: 시작 시각을 모르면 null · 엣지가 가져간 요청은 takenAt 부터 · 시한 모르면 120분 · 넘기면 over', () => {
    expect(progressOf({ id: 'a' }, NOW)).toBe(null);
    const p = progressOf({ running: { since: NOW - 60 * MIN }, timeoutMin: 120 }, NOW);
    expect(p.pct).toBeCloseTo(0.5); expect(p.over).toBe(false);
    const q = progressOf({ request: { state: 'taken', takenAt: NOW - 200 * MIN } }, NOW);
    expect(q.limitMs).toBe(120 * MIN); expect(q.over).toBe(true); expect(q.pct).toBe(1);
    expect(progressOf({ request: { state: 'queued', takenAt: NOW - MIN } }, NOW)).toBe(null);
    const r = progressOf({ running: { since: NOW - 170 * MIN }, timeoutMin: 180 }, NOW);
    expect(r.over).toBe(false);
  });
  it('다음 예정: 성공 뒤 주기 · 실패 뒤 min(주기, 재시도) · 꺼짐·조사 중은 null · 기록 없음·지남은 곧', () => {
    expect(nextRunOf({ intervalHours: 24, lastTry: { ts: NOW - HOUR, ok: true } }, HOUR, NOW)).toBe(NOW + 23 * HOUR);
    expect(nextRunOf({ intervalHours: 24, lastTry: { ts: NOW - 10 * MIN, ok: false } }, HOUR, NOW)).toBe(NOW + 50 * MIN);
    expect(nextRunOf({ intervalHours: 24, lastTry: { ts: NOW - 2 * HOUR, ok: false } }, HOUR, NOW)).toBe('soon');
    expect(nextRunOf({ intervalHours: 24 }, HOUR, NOW)).toBe('soon');
    expect(nextRunOf({ enabled: false, lastTry: { ts: NOW, ok: true } }, HOUR, NOW)).toBe(null);
    expect(nextRunOf({ running: { since: NOW }, lastTry: { ts: NOW, ok: true } }, HOUR, NOW)).toBe(null);
    expect(nextRunOf({ deviceDisabled: true }, HOUR, NOW)).toBe(null);
  });
  it('미래 시각 문구 · 진행 칸 문구', () => {
    expect(aheadText(NOW + 30 * MIN, NOW)).toBe('약 30분 뒤');
    expect(aheadText(NOW + 3 * HOUR, NOW)).toBe('약 3시간 뒤');
    expect(aheadText(NOW - MIN, NOW)).toBe('');
    expect(aheadText(null, NOW)).toBe('');
    expect(attemptText({ running: { since: NOW - 75 * MIN }, timeoutMin: 180 }, NOW).text).toBe('1시간 15분째 · 시한 180분');
    expect(attemptText({}, NOW).text).toBe('시도 기록 없음');
    expect(attemptText({ lastTry: { ts: NOW - 2 * HOUR, ok: false } }, NOW).text).toMatch(/^실패 · /);
  });
});

describe('서머리', () => {
  it('7일 변화 합은 7일 전 수집이 있는 대상만 · 결과 없는 대상은 크기 합에서 빠진다', () => {
    const targets = [okT('a', 'Seoul', 100 * GIB), okT('b', 'Seoul', 50 * GIB), okT('c', 'Busan', 30 * GIB), { id: 'd', corp: 'Busan', intervalHours: 24 }];
    const ov = overviewIndex({ targets: [ovOk('a', { delta: 5 * GIB }), ovOk('b', { base: false }), ovOk('c', { delta: -2 * GIB }), { id: 'd', state: 'no-data' }, { id: 'zz', state: 'ok', totalDelta7: { bytes: 99 } }] });
    const m = summaryModel(targets, ov, NOW);
    expect(m.totals.bytes).toBe(180 * GIB);
    expect(m.totals.measured).toBe(3); expect(m.totals.unmeasured).toBe(1);
    expect(m.totals.delta7).toBe(3 * GIB);
    expect(m.totals.delta7Targets).toBe(2); // 목록에 없는 개요 행(zz)은 세지 않는다
    const seoul = m.corps.find((c) => c.corp === 'Seoul');
    expect(seoul.delta7).toBe(5 * GIB); expect(seoul.delta7Partial).toBe(true);
    const busan = m.corps.find((c) => c.corp === 'Busan');
    expect(busan.unread.map((x) => x.id)).toEqual(['d']);
    expect(m.corps.map((c) => c.corp)).toEqual(['Seoul', 'Busan']); // 크기 큰 순
    expect(m.watch.map((x) => x.t.id)).toEqual(['d']);
  });
  it('반올림 해상도 안의 차이(withinRes)는 합계에서 0 — 카드의 \'변화 없음\' 과 같은 판정', () => {
    const targets = [okT('a', 'Seoul', 10_000 * GIB), okT('b', 'Frankfurt', 4_000 * GIB), okT('c', 'Ashburn', 3_000 * GIB)];
    const within = (id, bytes) => ({ ...ovOk(id), totalDelta7: { bytes, withinRes: true, uncertainty: 102 * GIB } });
    const ov = overviewIndex({ targets: [within('a', -102 * GIB), within('b', 102 * GIB), ovOk('c', { delta: -7 * GIB })] });
    const m = summaryModel(targets, ov, NOW);
    const seoul = m.corps.find((c) => c.corp === 'Seoul');
    expect(seoul.delta7).toBe(0); expect(seoul.delta7Within).toBe(true);
    expect(m.corps.find((c) => c.corp === 'Ashburn').delta7Within).toBe(false);
    expect(m.totals.delta7).toBe(-7 * GIB);
    expect(m.totals.delta7Within).toBe(false);
    expect(m.totals.delta7WithinCount).toBe(2);
    const allIn = summaryModel(targets.slice(0, 2), ov, NOW);
    expect(allIn.totals.delta7).toBe(0); expect(allIn.totals.delta7Within).toBe(true);
  });
  it('개요를 못 받았으면 7일 변화는 null(0 아님)', () => {
    const m = summaryModel([okT('a', 'S', 10)], new Map(), NOW);
    expect(m.totals.delta7).toBe(null);
    expect(m.corps[0].delta7).toBe(null);
  });
});

describe('전 법인 Top 10', () => {
  const targets = [okT('a', 'Seoul', 1000), okT('b', 'Busan', 1000), okT('c', 'Busan', 1000), { id: 'd', corp: 'Daegu' }];
  const ov = overviewIndex({ targets: [
    ovOk('a', { denom: 1000, top: [{ name: 'kim', bytes: 500 }, { name: 'lee', bytes: 300 }] }),
    ovOk('b', { denom: 1000, top: [{ name: 'ahn', bytes: 500 }, { name: 'park', bytes: 100 }] }),
    ovOk('c', { denom: 800, top: [{ name: 'choi', bytes: 400 }] }),
    { id: 'd', state: 'failed-only' },
  ] });
  it('합집합에서 크기 내림차순 → 이름 순 · 순위는 1부터 · 결과 없는 대상은 빠지고 밝힌다', () => {
    const r = crossTop(targets, ov, { n: 3 });
    expect(r.top.map((u) => u.name)).toEqual(['ahn', 'kim', 'choi']);
    expect(r.top.map((u) => u.rank)).toEqual([1, 2, 3]);
    expect(r.sum).toBe(1400);
    expect(r.base).toBe(2800);
    expect(r.share).toBeCloseTo(0.5);
    expect(r.excluded.map((x) => x.id)).toEqual(['d']);
    expect(r.approx).toBe(true);
  });
  it('법인을 고르면 그 법인 대상만 · 고른 법인에 결과가 없으면 합·비중은 null', () => {
    const r = crossTop(targets, ov, { corps: new Set(['Busan']), n: 10 });
    expect(r.top.map((u) => u.targetId)).toEqual(['b', 'c', 'b']);
    expect(r.included).toEqual(['b', 'c']);
    const none = crossTop(targets, ov, { corps: new Set(['Daegu']) });
    expect(none.top).toEqual([]); expect(none.sum).toBe(null); expect(none.base).toBe(null); expect(none.share).toBe(null);
  });
  it('고를 수 있는 법인: 결과 없는 법인은 표시 · 법인 미지정은 맨 뒤', () => {
    const c = corpChoices([...targets, { id: 'e' }], ov);
    expect(c.map((x) => x.label)).toEqual(['Busan', 'Daegu', 'Seoul', '법인 미지정']);
    expect(c.find((x) => x.corp === 'Daegu').withData).toBe(0);
  });
});

describe('법인 현황 카드 · 미니 추이', () => {
  it('정렬: 크기 · 7일 증가 · 상태(문제 먼저) — 모르는 값은 뒤', () => {
    const targets = [okT('a', 'S', 10), okT('b', 'S', 30), { id: 'c', corp: 'S', lastTry: { ts: NOW - HOUR, ok: false, kind: 'auth' }, intervalHours: 24 }];
    const ov = overviewIndex({ targets: [ovOk('a', { delta: 9 }), ovOk('b', { delta: 1 })] });
    expect(corpCards(targets, ov, NOW, 'size').map((c) => c.t.id)).toEqual(['b', 'a', 'c']);
    expect(corpCards(targets, ov, NOW, 'd7').map((c) => c.t.id)).toEqual(['a', 'b', 'c']);
    expect(corpCards(targets, ov, NOW, 'status')[0].t.id).toBe('c');
    const c = corpCards(targets, ov, NOW).find((x) => x.t.id === 'c');
    expect(c.bytes).toBe(null); expect(c.d7).toBe(null); expect(c.hasBase).toBe(false);
  });
  it('미니 추이: 점 없음 · 1점은 점만 · 작은 변화는 축을 넓혀 급경사로 보이지 않는다', () => {
    expect(miniLine([])).toEqual({ d: '', dots: [], last: null });
    const one = miniLine([{ ts: NOW, bytes: 5 }]);
    expect(one.d).toBe(''); expect(one.dots.length).toBe(1);
    const g = miniLine([{ ts: NOW - DAY, bytes: 1000 * GIB }, { ts: NOW, bytes: 1001 * GIB }], 220, 44, 3);
    const ys = g.d.match(/,([\d.]+)/g).map((s) => Number(s.slice(1)));
    expect(Math.abs(ys[0] - ys[1])).toBeLessThan(5); // 0.1% 변화가 높이 전체를 쓰지 않는다
    const part = miniLine([{ ts: NOW - DAY, bytes: 1 }, { ts: NOW, bytes: 2, partial: true }]);
    expect(part.dots.length).toBe(1);
  });
});

describe('일괄 변경 — 화면 → 서버 patch', () => {
  it("빈 값은 '그대로'(싣지 않는다) — 숫자 칸 빈 값이 0 이 되지 않는다", () => {
    expect(bulkPatchFrom(blankBulk())).toEqual({ patch: {}, issues: [] });
    const r = bulkPatchFrom({ ...blankBulk(), topN: '', port: '   ' });
    expect(r.patch).toEqual({});
    expect(r.issues.map((x) => x.key)).toEqual(['port']);
  });
  it('켜기/끄기 · 숫자 · 문자열 · 범위 밖은 오류(조용히 자르지 않는다)', () => {
    const r = bulkPatchFrom({ ...blankBulk(), enabled: 'off', detach: 'on', timeoutMin: '180', intervalHours: '12', topN: '20', sizeMode: 'k', username: ' svc ' });
    expect(r.issues).toEqual([]);
    expect(r.patch).toEqual({ enabled: false, detach: true, timeoutMin: 180, intervalHours: 12, topN: 20, sizeMode: 'k', username: 'svc' });
    expect(bulkPatchFrom({ ...blankBulk(), topN: '51' }).issues[0].text).toMatch(/5~50/);
    expect(bulkPatchFrom({ ...blankBulk(), port: '2.5' }).issues[0].text).toMatch(/정수/);
  });
  it('받는 사람: 모두 지우기 · 형식 오류 · 빈 목록', () => {
    expect(bulkPatchFrom({ ...blankBulk(), mailMode: 'clear' }).patch.mailTo).toEqual({ mode: 'clear' });
    expect(bulkPatchFrom({ ...blankBulk(), mailMode: 'add', mailList: 'a@x.com, b@x.com' }).patch.mailTo).toEqual({ mode: 'add', list: ['a@x.com', 'b@x.com'] });
    expect(bulkPatchFrom({ ...blankBulk(), mailMode: 'add', mailList: 'nope' }).issues[0].key).toBe('mailTo');
    expect(bulkPatchFrom({ ...blankBulk(), mailMode: 'replace', mailList: '' }).issues[0].text).toMatch(/주소를 입력/);
  });
  it('확인 문구', () => {
    expect(patchSummary({ timeoutMin: 180, enabled: true, runNode: BULK_RUN_FOLLOW, mailTo: { mode: 'add', list: ['a@x.com'] } }))
      .toBe('주기 수집 켜기 · 시한 180분 · 실행 노드 장비 담당 노드 따름 · 받는 사람 1명 추가');
    expect(patchSummary({})).toBe('');
  });
});

describe('일괄 변경 — 결과 문구 · 선택', () => {
  const nameOf = (id) => `T-${id}`;
  it('미리보기: 바뀜·같음·바꾸지 못함 · 뺀 항목은 사유별로 묶는다', () => {
    const r = bulkResultText({ ok: true, dryRun: true, changed: [{ id: 'a', keys: ['timeoutMin', 'runVia', 'agent'] }], unchanged: ['b'], skipped: [{ id: 'c', reason: '등록부 계정 없음' }],
      notApplied: [{ id: 'a', key: 'datacenterId', reason: 'dc-from-registry' }, { id: 'd', key: 'datacenterId', reason: 'dc-from-registry' }] }, nameOf);
    expect(r.tone).toBe('warn');
    expect(r.head).toBe('바뀜 1개 · 이미 같음 1개 · 바꾸지 못함 1개');
    expect(r.lines[0]).toBe('T-a — 시한, 실행 노드'); // runVia·agent 는 한 항목
    expect(r.lines).toContain('바꾸지 않음: T-c — 등록부 계정 없음');
    expect(r.lines.find((l) => l.startsWith('일부 항목 제외(2개)'))).toMatch(/T-a, T-d/);
  });
  it('적용 뒤 · 바뀐 것 없음 · 실패 · 빼기', () => {
    expect(bulkResultText({ ok: true, saved: true, changed: [{ id: 'a', keys: ['enabled'] }], unchanged: [] }).head).toMatch(/^저장했습니다 — 바뀜 1개/);
    const none = bulkResultText({ ok: true, saved: false, changed: [], unchanged: ['a', 'b'] });
    expect(none.tone).toBe('muted'); expect(none.head).toMatch(/바뀌는 대상이 없습니다\(이미 같음 2개/);
    expect(bulkResultText({ ok: false, reason: '판이 바뀌었습니다' })).toEqual({ tone: 'bad', head: '판이 바뀌었습니다', lines: [] });
    expect(bulkResultText({ ok: true, mode: 'remove', dryRun: true, removed: ['a', 'b'] }).head).toBe('목록에서 뺄 대상 2개');
    expect(bulkResultText(null).head).toBe('');
  });
  it('선택 프리셋: 최근 실패 = 마지막 시도가 실패이고 그 뒤 성공이 없는 대상', () => {
    const rows = [
      { id: 'a', enabled: true }, { id: 'b', enabled: false },
      { id: 'c', lastTry: { ts: 10, ok: false }, okScan: { ts: 5 } }, { id: 'd', lastTry: { ts: 10, ok: false }, okScan: { ts: 20 } }, null,
    ];
    expect(presetIds(rows, 'all')).toEqual(['a', 'b', 'c', 'd']);
    expect(presetIds(rows, 'none')).toEqual([]);
    expect(presetIds(rows, 'on')).toEqual(['a', 'c', 'd']);
    expect(presetIds(rows, 'off')).toEqual(['b']);
    expect(presetIds(rows, 'fail')).toEqual(['c']);
  });
  it('차례로 실행 진행 문구', () => {
    expect(seqProgressText({ kind: 'test', running: true, total: 3, results: [{ ok: true }], stopping: true })).toBe('연결 시험 1/3 진행 중 — 지금 것까지만 하고 멈춥니다');
    expect(seqProgressText({ kind: 'mail', running: false, total: 3, results: [{ ok: true }, { ok: false }] })).toBe('결과 메일 끝 — 3개 중 성공 1 · 실패 1 · 멈춤으로 1개 안 함');
  });
});

describe('문구 위생', () => {
  it('화면 문구 모듈에 백틱이 글자로 들어가지 않는다', () => {
    for (const f of ['isiduOverviewText.js', 'isiduBulkText.js', 'IsiduViews.jsx', 'IsiduBulk.jsx']) {
      const text = fs.readFileSync(path.join(here, f), 'utf8');
      const strs = [...text.matchAll(/'([^'\n]*)'/g)].map((m) => m[1]);
      for (const s of strs) expect(s.includes('`'), `${f}: ${s}`).toBe(false);
    }
  });
});
