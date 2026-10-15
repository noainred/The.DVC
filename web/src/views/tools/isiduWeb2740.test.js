/**
 * v2.740 감사 축 D — 아이실론 디렉터리 사용량 화면의 정직성 회귀(D-01 · D-02 · D-05 · D-09 · D-10 · D-11).
 *
 *  · D-01 키가 바뀐 뒤 새 요청이 실패하면 이전 대상의 보고서·추이·사용자 표가 새 대상 이름 아래 그대로 보였다(오류 표시 없음).
 *  · D-02 개요 요청이 한 번 실패하면 다시 묻지 않았고, 하위 화면이 실패를 '불러오는 중' · '결과 없음' · '관측 짧음' 으로 말했다.
 *  · D-05 목록 폴링이 403·404 에도 계속 다시 물었다(v2.621 '403 은 다시 물어도 같다').
 *  · D-09 스토리지 상세의 SSH 배지가 '시리얼/GUID 미제공' 이라 말했다 — v2.735.2 부터 노드 시리얼은 isi_hw_status 로 읽는다.
 *  · D-10 서브메뉴에서 CSV 버튼 title 이 '성공한 수집이 있어야' 라고 말했다 — 실제 원인은 '대상을 고르지 않았다' 였다.
 *  · D-11 일괄 변경의 접속 계정에 공백만 넣으면 username:'' 이 patch 에 실렸다.
 * 훅의 판정은 순수 함수로 뺐고, 훅이 그 함수를 쓰는지는 소스(주석 제거 뒤)로 본다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/_stripComments.js';
import {
  KEYED_EMPTY, keyedStart, keyedOk, keyedFail, keyedView, pollStopped, listPollDelay, listStaleText, csvButtonState, deltaView,
} from './isiduText.js';
import {
  ovStatus, OV_UNREAD, OV_RETRY_MS, ovRetryDelay, ovBanner, overviewIndex, crossTop, noResultCount, corpChoices, corpChipView, corpCards,
  summaryModel, summaryDelta7Sub, topEmptyText, cardOvText,
} from './isiduOverviewText.js';
import { blankBulk, bulkPatchFrom, patchSummary } from './isiduBulkText.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = (f) => stripComments(fs.readFileSync(path.join(here, f), 'utf8'));
/** 함수 하나의 본문(다음 최상위 function 앞까지). */
const fnBody = (text, name) => {
  const i = text.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`${name} 를 찾지 못했습니다`);
  const j = text.indexOf('\nfunction ', i + 1);
  const k = text.indexOf('\nexport ', i + 1);
  const ends = [j, k].filter((x) => x > 0);
  return text.slice(i, ends.length ? Math.min(...ends) : text.length);
};
const httpErr = (status, message = `x -> ${status}`) => Object.assign(new Error(message), { status });
const NOW = Date.UTC(2026, 9, 15, 3, 0, 0);
const HOUR = 3_600_000;
const TIB = 1024 ** 4;
const okT = (id, corp) => ({
  id, label: id, corp, enabled: true, intervalHours: 24, timeoutMin: 120,
  okScan: { id: 1, ts: NOW - HOUR, count: 120, total: { bytes: 5 * TIB }, sumBytes: 5 * TIB },
  lastTry: { id: 1, ts: NOW - HOUR, ok: true },
});

describe('D-01 키가 바뀐 뒤 실패하면 이전 키의 data 를 새 키 이름 아래 보이지 않는다', () => {
  it('A 성공 → B 로 바꿈(불러오는 중) → B 실패: data 는 null 이고 오류가 보인다', () => {
    let s = keyedOk(keyedStart(KEYED_EMPTY), 'A', { state: 'ok', label: 'A 보고서' });
    expect(keyedView(s, 'A')).toMatchObject({ key: 'A', data: { label: 'A 보고서' }, error: null, loading: false });
    s = keyedStart(s);
    expect(keyedView(s, 'B')).toMatchObject({ key: 'B', data: null, error: null, loading: true });
    const e = httpErr(404);
    s = keyedFail(s, 'B', e);
    const v = keyedView(s, 'B');
    expect(v.data).toBe(null);
    expect(v.error).toBe(e);
    expect(v.loading).toBe(false);
  });
  it('A → B 성공 → A 로 돌아와 실패: B 의 값을 A 이름 아래 보이지 않는다', () => {
    let s = keyedOk(KEYED_EMPTY, 'A', { label: 'A' });
    s = keyedOk(keyedStart(s), 'B', { label: 'B' });
    s = keyedFail(keyedStart(s), 'A', httpErr(500));
    expect(keyedView(s, 'A').data).toBe(null);
    expect(keyedView(s, 'A').error.status).toBe(500);
  });
  it('같은 키를 다시 읽다 실패하면 그 키가 받은 직전 값은 남는다', () => {
    let s = keyedOk(KEYED_EMPTY, 'A', { label: 'A' });
    s = keyedFail(keyedStart(s), 'A', httpErr(503));
    expect(keyedView(s, 'A')).toMatchObject({ data: { label: 'A' }, loading: false });
    expect(keyedView(s, 'A').error.status).toBe(503);
  });
  it('키가 없으면 빈 상태', () => {
    expect(keyedView(KEYED_EMPTY, null)).toMatchObject({ data: null, error: null });
  });
  it('훅(useKeyed)이 순수 함수를 쓴다', () => {
    const b = fnBody(code('IsilonDirUsageTool.jsx'), 'useKeyed');
    for (const f of ['keyedStart(', 'keyedOk(', 'keyedFail(', 'keyedView(']) expect(b.includes(f), f).toBe(true);
  });
});

describe('D-02 개요를 읽지 못한 것을 수집 없음·관측 짧음·불러오는 중으로 말하지 않는다', () => {
  const targets = [okT('a', 'Seoul'), okT('b', 'Busan')];
  const unreadById = overviewIndex(null);
  it('개요 상태 넷 — 받음 · 직전 값(새로 못 읽음) · 받는 중 · 못 읽음', () => {
    expect(ovStatus({ data: { targets: [] }, error: null })).toBe('ok');
    expect(ovStatus({ data: { targets: [] }, error: httpErr(500) })).toBe('stale');
    expect(ovStatus({ data: null, error: null })).toBe('loading');
    expect(ovStatus({ data: null, error: httpErr(500) })).toBe('unread');
    expect(ovStatus(null)).toBe('loading');
  });
  it('실패하면 백오프로 다시 묻는다 · 403/404 는 다시 묻지 않는다', () => {
    const e = httpErr(500);
    expect(ovRetryDelay(e, 0)).toBe(OV_RETRY_MS[0]);
    expect(ovRetryDelay(e, 1)).toBe(OV_RETRY_MS[1]);
    expect(ovRetryDelay(e, 99)).toBe(OV_RETRY_MS[OV_RETRY_MS.length - 1]);
    expect(OV_RETRY_MS[0]).toBeLessThan(OV_RETRY_MS[OV_RETRY_MS.length - 1]);
    expect(ovRetryDelay(new Error('signal timed out'), 0)).toBe(OV_RETRY_MS[0]);
    expect(ovRetryDelay(httpErr(403), 0)).toBe(null);
    expect(ovRetryDelay(httpErr(404), 0)).toBe(null);
  });
  it('훅(useOverview)이 실패 뒤 다시 시도를 건다', () => {
    const b = fnBody(code('IsilonDirUsageTool.jsx'), 'useOverview');
    expect(b.includes('ovRetryDelay(')).toBe(true);
    expect(b.includes('setTimeout(')).toBe(true);
    expect(b.includes('clearTimeout(')).toBe(true);
  });
  it('배너: 못 읽음은 다시 시도한다고 말하고 · 403 은 다시 시도하지 않는다고 · 직전 값이면 그 사실을', () => {
    expect(ovBanner({ data: { targets: [] }, error: null })).toBe(null);
    expect(ovBanner({ data: null, error: null })).toBe(null);
    expect(ovBanner({ data: null, error: httpErr(500) }).text).toMatch(/다시 시도합니다/);
    expect(ovBanner({ data: null, error: httpErr(403) }).text).toMatch(/다시 시도하지 않습니다/);
    expect(ovBanner({ data: { targets: [] }, error: httpErr(500) }).text).toMatch(/직전에 받은 값/);
  });
  it('서머리 7일 변화 합 부제: 못 읽음은 영원히 \'불러오는 중\' 이 아니다', () => {
    const T = summaryModel(targets, unreadById, NOW).totals;
    expect(summaryDelta7Sub(T, 'unread')).toMatch(new RegExp(OV_UNREAD));
    expect(summaryDelta7Sub(T, 'unread')).not.toMatch(/불러오는 중/);
    expect(summaryDelta7Sub(T, 'loading')).toMatch(/불러오는 중/);
    expect(summaryDelta7Sub(T, 'ok')).toMatch(/7일 전 수집이 있는 대상이 없습니다/);
  });
  it('전 법인 Top: 제외 사유는 \'개요 못 읽음\' 이고 \'결과 없음\' 으로 세지 않는다 · 빈 표 문구도 그렇다', () => {
    const r = crossTop(targets, unreadById, { n: 5, unread: true });
    expect(r.top).toEqual([]);
    expect(r.excluded.map((x) => x.state)).toEqual(['overview-unread', 'overview-unread']);
    expect(noResultCount(r)).toBe(0);
    expect(topEmptyText('unread')).toMatch(new RegExp(OV_UNREAD));
    expect(topEmptyText('unread')).not.toMatch(/성공한 수집이 있는 대상이 없습니다/);
    expect(topEmptyText('loading')).toMatch(/불러오는 중/);
    expect(topEmptyText('ok')).toMatch(/성공한 수집이 있는 대상이 없습니다/);
    // 개요를 받았는데 그 대상이 실패만 있으면 그것은 '결과 없음' 이다.
    const ok = crossTop([okT('a', 'Seoul'), { id: 'd', corp: 'Daegu' }], overviewIndex({ targets: [{ id: 'a', state: 'ok', top: [], scan: { denom: 1 } }, { id: 'd', state: 'failed-only' }] }), { n: 5 });
    expect(noResultCount(ok)).toBe(1);
  });
  it('법인 칩: 개요를 못 읽으면 잠그지 않고 \'결과 없음\' 이라 말하지 않는다', () => {
    const cs = corpChoices(targets, unreadById, { unread: true });
    for (const c of cs) {
      const v = corpChipView(c);
      expect(v.disabled).toBe(false);
      expect(v.suffix).toBe('');
      expect(v.title).not.toMatch(/성공한 수집이 없습니다/);
      expect(v.title).toMatch(/개요를 읽지 못/);
    }
    // 개요를 받았는데 결과가 없는 법인은 예전처럼 잠근다.
    const got = corpChoices([{ id: 'd', corp: 'Daegu' }], overviewIndex({ targets: [{ id: 'd', state: 'failed-only' }] }));
    expect(corpChipView(got[0])).toMatchObject({ disabled: true, suffix: ' · 결과 없음' });
  });
  it('법인 현황 카드: 7일 변화는 \'관측 짧음\' 이 아니라 \'개요를 못 읽음\' · 상위 폴더·추이 칸도', () => {
    const cards = corpCards(targets, unreadById, NOW, 'size', { unread: true });
    for (const c of cards) {
      expect(c.ovUnread).toBe(true);
      const v = deltaView(c.d7, { hasBase: c.hasBase, unread: c.ovUnread });
      expect(v.text).toBe('—');
      expect(v.title).not.toMatch(/관측 기간이 짧습니다/);
      expect(v.title).toMatch(/개요를 읽지 못/);
    }
    expect(cardOvText('top3', 'unread')).toMatch(/읽지 못했습니다/);
    expect(cardOvText('top3', 'loading')).toMatch(/불러오는 중/);
    expect(cardOvText('top3', 'ok')).toBe('상위 폴더 없음');
    expect(cardOvText('trend', 'unread')).toMatch(/읽지 못했습니다/);
    expect(cardOvText('trend', 'ok')).toBe('30일 추이 없음');
    // 개요를 받은 카드는 예전 판정 그대로(관측 짧음).
    const okCards = corpCards(targets, overviewIndex({ targets: [{ id: 'a', state: 'ok', base7: null }, { id: 'b', state: 'ok', base7: null }] }), NOW);
    expect(okCards[0].ovUnread).toBe(false);
    expect(deltaView(okCards[0].d7, { hasBase: okCards[0].hasBase, unread: okCards[0].ovUnread }).title).toMatch(/관측 기간이 짧습니다/);
  });
  it('하위 화면이 판정 함수를 쓰고 예전 하드코딩 문구를 남기지 않는다', () => {
    const v = code('IsiduViews.jsx');
    for (const f of ['ovStatus(', 'ovBanner(', 'summaryDelta7Sub(', 'topEmptyText(', 'corpChipView(', 'cardOvText(', 'noResultCount(']) expect(v.includes(f), f).toBe(true);
    expect(v.includes("!ov.data ? '불러오는 중…'")).toBe(false);
    expect(v.includes('disabled={!c.withData}')).toBe(false);
    expect(v.includes("'상위 폴더 불러오는 중…'")).toBe(false);
    expect(v.includes("'30일 추이 없음'")).toBe(false);
    expect(v.includes('이 법인은 아직 성공한 수집이 없습니다')).toBe(false);
  });
});

describe('D-05 목록 폴링은 403·404 에 멈춘다(수동 새로고침은 그대로)', () => {
  it('다음 폴링 간격: 정상 30초 · 조사 중 8초 · 일시 실패는 계속 · 403/404 는 멈춤', () => {
    expect(listPollDelay(null, false)).toBe(30_000);
    expect(listPollDelay(null, true)).toBe(8_000);
    expect(listPollDelay(httpErr(500), false)).toBe(30_000);
    expect(listPollDelay(new Error('Failed to fetch'), true)).toBe(8_000);
    expect(listPollDelay(httpErr(403), false)).toBe(null);
    expect(listPollDelay(httpErr(404), true)).toBe(null);
    expect(pollStopped(httpErr(403))).toBe(true);
    expect(pollStopped(httpErr(401))).toBe(false);
    expect(pollStopped(null)).toBe(false);
  });
  it('멈췄으면 배너가 그 사실을 말한다', () => {
    const t = listStaleText({ error: httpErr(403, 'forbidden'), failedAt: NOW - 60_000, stopped: true }, NOW);
    expect(t).toMatch(/자동 새로고침을 멈췄습니다/);
    const u = listStaleText({ error: httpErr(500, 'boom'), failedAt: NOW - 60_000, stopped: false }, NOW);
    expect(u).toMatch(/직전에 받은 값/);
    expect(u).not.toMatch(/멈췄습니다/);
  });
  it('훅(useMain)이 판정 함수로 재무장을 정한다', () => {
    const b = fnBody(code('IsilonDirUsageTool.jsx'), 'useMain');
    expect(b.includes('listPollDelay(')).toBe(true);
  });
});

describe('D-10 CSV 버튼은 대상 화면에서만 · 잠긴 이유를 나눠 말한다', () => {
  it('대상을 고르지 않았으면 버튼을 보이지 않는다', () => {
    expect(csvButtonState({ tid: '', rep: { data: null, error: null } }).show).toBe(false);
  });
  it('성공한 보고서면 내보낸다 · 불러오는 중·못 읽음·DB 불가·수집 없음은 각자 사유', () => {
    expect(csvButtonState({ tid: 'a', rep: { data: { state: 'ok' }, error: null } })).toMatchObject({ show: true, disabled: false });
    const loading = csvButtonState({ tid: 'a', rep: { data: null, error: null } });
    expect(loading.disabled).toBe(true); expect(loading.title).not.toMatch(/성공한 수집이 있어야/);
    const failed = csvButtonState({ tid: 'a', rep: { data: null, error: httpErr(500) } });
    expect(failed.disabled).toBe(true); expect(failed.title).toMatch(/읽지 못/);
    expect(csvButtonState({ tid: 'a', rep: { data: { state: 'db-unavailable' }, error: null } }).title).toMatch(/DB/);
    expect(csvButtonState({ tid: 'a', rep: { data: { state: 'no-data' }, error: null } }).title).toMatch(/성공한 수집이 있어야/);
  });
  it('머리의 CSV 버튼이 판정 함수를 쓴다', () => {
    const v = code('IsilonDirUsageTool.jsx');
    expect(v.includes('csvButtonState(')).toBe(true);
    expect(v.includes("title={!R || R.state !== 'ok' ? '성공한 수집이 있어야")).toBe(false);
  });
});

describe('D-11 일괄 변경: 공백만 넣은 계정은 \'그대로\' 다', () => {
  it('공백만 → patch 에 싣지 않는다 · 앞뒤 공백은 잘라 싣는다', () => {
    expect(bulkPatchFrom({ ...blankBulk(), username: '   ' })).toEqual({ patch: {}, issues: [] });
    expect(bulkPatchFrom({ ...blankBulk(), username: '\t ' }).patch).toEqual({});
    expect(bulkPatchFrom({ ...blankBulk(), username: ' svc ' }).patch).toEqual({ username: 'svc' });
    expect(String(patchSummary(bulkPatchFrom({ ...blankBulk(), username: '   ' }).patch))).not.toMatch(/‘’/);
    expect(String(patchSummary(bulkPatchFrom({ ...blankBulk(), username: ' svc ' }).patch))).toMatch(/계정 ‘svc’/);
  });
});

describe('D-09 SSH 수집 배지는 노드 시리얼을 읽는다는 사실과 맞다', () => {
  it("Isilon SSH 배지 title 이 '시리얼/GUID 미제공' 이라 말하지 않고 isi_hw_status 를 말한다", () => {
    const v = code('StorageMonTool.jsx');
    expect(v.includes('시리얼/GUID 미제공')).toBe(false);
    expect(v.includes('isi_hw_status')).toBe(true);
  });
});
