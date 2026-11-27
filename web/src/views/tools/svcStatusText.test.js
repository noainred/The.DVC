/**
 * svcStatusText.test.js — '포탈 서비스 상태 모니터링' 화면의 판정 · 문구(순수 모듈) 회귀.
 *
 * ① 서버 판정 코어(server/src/svcstatus/judge.js)와 코드 목록 대조 — 상태 · 사유 · 띠 칸 값 · 심각도(웹 · 서버 두 벌이면 같은 입력으로 대조).
 * ② 못 읽은 값은 0 이 아니다 — null · '' · 문자는 '—'(단위 없이).
 * ③ 꺼짐 · 제외 · 설정 오류는 상태 넷 합계에 들지 않는다 · 격자 칸은 가장 나쁜 상태.
 * ④ 설정 폼 변환 경계(빈 칸 · 0 · 문자 · 소수 · 범위).
 */
import { describe, it, expect } from 'vitest';
import * as W from './svcStatusText.js';
import * as S from '../../../../server/src/svcstatus/judge.js';
import { FAIL_KINDS } from '../../../../server/src/linkcheck/phases.js';
import { KIND_LABEL } from '../../../../server/src/svcstatus/targets.js';

const HOUR = 3_600_000;
// 순수 함수에 now · offsetMin 을 주입하므로 고정 시각을 쓴다(실제 시각에 기대지 않는다).
const NOW = Date.UTC(2026, 10, 27, 3, 30, 0); // KST 12:30
const KST = 540;

describe('서버 judge.js 와 코드 대조', () => {
  it('상태 코드 집합 == 서버 STATE_CODES', () => {
    expect(Object.keys(W.STATES).sort()).toEqual([...S.STATE_CODES].sort());
  });
  it('합계에 드는 상태 넷 == 서버 MEASURED_STATES · 나머지가 따로 센다', () => {
    expect([...W.MEASURED].sort()).toEqual([...S.MEASURED_STATES].sort());
    expect([...W.MEASURED, ...W.SIDE].sort()).toEqual([...S.STATE_CODES].sort());
  });
  it('사유 코드 집합 == 서버 REASON_CODES (문구가 전부 있다)', () => {
    expect(Object.keys(W.REASON_TEXT).sort()).toEqual([...S.REASON_CODES].sort());
    for (const k of S.REASON_CODES) {
      expect(W.reasonShort(k).length).toBeGreaterThan(0);
      expect(W.reasonLong(k, { staleMs: 240_000, failThreshold: 3, minEdgeVersion: '3.54.0' }).length).toBeGreaterThan(0);
    }
  });
  it('심각도 == 서버 SEVERITY', () => {
    for (const k of S.STATE_CODES) expect(W.STATES[k].sev).toBe(S.SEVERITY[k]);
  });
  it('띠 칸 값 == 서버 SAMPLE(0 정상 · 1 지연 · 2 일시 실패 · 3 끊김)', () => {
    expect(Object.keys(W.STRIP).map(Number).sort()).toEqual(Object.values(S.SAMPLE).sort());
    expect(W.STRIP[S.SAMPLE.ok].label).toBe('정상');
    expect(W.STRIP[S.SAMPLE.slow].label).toBe('지연');
    expect(W.STRIP[S.SAMPLE.fail].label).toMatch(/^일시 실패/);
    expect(W.STRIP[S.SAMPLE.down].label).toBe('끊김');
  });
  it('종류 라벨 폴백 == 서버 targets.js KIND_LABEL', () => {
    expect(W.KIND_FALLBACK_LABEL).toEqual({ ...KIND_LABEL });
  });
  it('실패 종류 라벨 == 서버 linkcheck FAIL_KINDS 라벨(키가 서버 표에 있다)', () => {
    for (const [k, label] of Object.entries(W.FAIL_TEXT)) {
      expect(Object.hasOwn(FAIL_KINDS, k)).toBe(true);
      expect(label).toBe(FAIL_KINDS[k].label);
    }
  });
});

describe('못 읽은 값은 0 이 아니다', () => {
  it('msText — null · 빈 글자 · 문자 · 음수는 단위 없는 —, 0 은 0 ms', () => {
    for (const v of [null, undefined, '', '  ', 'abc', [], {}, -1, NaN]) expect(W.msText(v)).toBe('—');
    expect(W.msText(0)).toBe('0 ms');
    expect(W.msText(1930)).toBe('1,930 ms');
    expect(W.msText(812.4)).toBe('812 ms');
    expect(W.msText('38')).toBe('38 ms');
  });
  it('pctText — null 은 —, 100 이 아닌 값은 내림(100.0 으로 둔갑하지 않는다)', () => {
    expect(W.pctText(null)).toBe('—');
    expect(W.pctText('')).toBe('—');
    expect(W.pctText(100)).toBe('100 %');
    expect(W.pctText(99.96)).toBe('99.9 %');
    expect(W.pctText(0)).toBe('0.0 %');
  });
  it('ratioText — 평소를 모르면 빈 글자(지어내지 않는다)', () => {
    expect(W.ratioText(1930, 820)).toBe('2.4배');
    expect(W.ratioText(1930, null)).toBe('');
    expect(W.ratioText(null, 820)).toBe('');
    expect(W.ratioText(1930, 0)).toBe('');
  });
  it('시각 — 0 · null 은 —(1970년이 아니다) · 오늘/어제/날짜', () => {
    expect(W.clockText(0, NOW, { offsetMin: KST })).toBe('—');
    expect(W.clockText(null, NOW, { offsetMin: KST })).toBe('—');
    expect(W.clockText(NOW - HOUR, NOW, { offsetMin: KST })).toBe('11:30');
    expect(W.clockText(NOW - HOUR, NOW, { offsetMin: KST, sec: true })).toBe('11:30:00');
    expect(W.clockText(NOW - 13 * HOUR, NOW, { offsetMin: KST })).toBe('어제 23:30');
    expect(W.clockText(NOW - 50 * HOUR, NOW, { offsetMin: KST })).toBe('11-25 10:30');
    expect(W.sinceText(null, NOW)).toBe('—');
    expect(W.sinceText(NOW - 35 * 60_000, NOW, { offsetMin: KST })).toBe('11:55 부터 35분째');
  });
  it('주기 · 시한 · 길이 문구', () => {
    expect(W.intervalText(60_000)).toBe('60초');
    expect(W.intervalText(30_000)).toBe('30초');
    expect(W.intervalText(300_000)).toBe('5분');
    expect(W.intervalText(null)).toBe('—');
    expect(W.secText(2500)).toBe('2.5초');
    expect(W.secText(15000)).toBe('15초');
    expect(W.spanText(30 * 60_000)).toBe('30분');
    expect(W.spanText(24 * HOUR)).toBe('24시간');
    expect(W.spanText(11 * 24 * HOUR)).toBe('11일');
    expect(W.stripHead(1_800_000, 48)).toBe('24시간(30분 칸)');
    expect(W.stripHead(null, 48)).toBe('상태 띠');
  });
});

describe('행 문구 — 서버 값 그대로', () => {
  it('측정하는 곳 — 엣지면 엣지 이름(청록), 중앙이면 중앙, 모르면 —', () => {
    expect(W.byText({ by: 'central', byEdge: false, state: 'ok' })).toEqual({ text: '중앙', edge: false, measured: true });
    expect(W.byText({ by: 'edge-us-east', byEdge: true, state: 'down' })).toEqual({ text: 'edge-us-east', edge: true, measured: true });
    expect(W.byText({ by: '', byEdge: false, state: 'unknown' })).toEqual({ text: '—', edge: false, measured: null });
  });
  it('꺼짐 · 제외 · 설정 오류 행은 측정 안 함(중앙 측정 · 엣지 측정이라고 쓰지 않는다) — 표 · 카드 · 상세 공통', () => {
    for (const state of ['off', 'excluded', 'problem']) {
      expect(W.byText({ by: 'central', state }).measured).toBe(false);
      expect(W.byLine({ by: 'edge-x', byEdge: true, state })).toBe('측정 안 함');
    }
    expect(W.byLine({ by: 'central', state: 'ok' })).toBe('중앙 측정');
    expect(W.byLine({ by: 'edge-x', byEdge: true, state: 'slow' })).toBe('edge-x 측정');
    expect(W.byLine({ by: '', state: 'unknown', reason: 'unassigned' })).toBe('측정하는 곳 —');
  });
  it('등록 출처 문구 — 스토리지 REST · SSH · 그 밖', () => {
    expect(W.portSourceText({ kind: 'storage', sub: 'api' })).toBe('포트는 기종별 포탈 설정값(등록부에 포트 칸 없음)');
    expect(W.portSourceText({ kind: 'storage', sub: 'ssh' })).toBe('등록부의 주소 · SSH 포트');
    expect(W.portSourceText({ kind: 'vcenter', sub: 'direct' })).toBe('등록부의 주소:포트(없으면 https 443 · http 80)');
    expect(W.portSourceText({ kind: 'collector', sub: '' })).toBe('등록부의 주소:포트(없으면 https 443 · http 80)');
  });
  it('접속처 — 가린 응답이면 —', () => {
    expect(W.addrText({ address: '198.51.100.24:20444' }, false)).toBe('198.51.100.24:20444');
    expect(W.addrText({ address: '198.51.100.24:20444' }, true)).toBe('—');
    expect(W.addrText({ address: '' }, false)).toBe('—');
  });
  it('사유 줄 — 사유 코드 문구 · 끊김의 연속 실패와 실패 종류 · 지연의 배수 · 보충', () => {
    expect(W.whyText({ state: 'unknown', reason: 'edge-old-version' })).toBe('엣지 버전 낮음');
    expect(W.whyText({ state: 'down', reason: null, failStreak: 35, failKind: 'timeout' })).toBe('연속 35회 실패 · 타임아웃');
    expect(W.whyText({ state: 'slow', ms: 1930, baseMs: 820 })).toBe('평소의 2.4배');
    expect(W.whyText({ state: 'ok', note: '엣지 포트 설정이 중앙과 다름' })).toBe('엣지 포트 설정이 중앙과 다름');
    expect(W.whyText({ state: 'unknown', reason: 'judging', failStreak: 2, failKind: 'refused' })).toBe('판정 중 · 실패 2회째 · 연결 거부');
    // 모르는 코드는 코드 그대로(지어내지 않는다)
    expect(W.whyText({ state: 'unknown', reason: 'brand-new' })).toBe('brand-new');
  });
  it('정상 · 지연인데 마지막 측정이 실패(연속 실패 < 기준) — 일시 실패 N회째 · 실패 종류(기준 숫자는 응답 값으로만)', () => {
    const r = { state: 'ok', ms: null, baseMs: 11, failStreak: 2, failKind: 'timeout' };
    expect(W.whyText(r, { failThreshold: 3 })).toBe('일시 실패 2회째(끊김 판정 전 — 연속 3회째에 끊김) · 타임아웃');
    expect(W.whyText(r)).toBe('일시 실패 2회째(끊김 판정 전) · 타임아웃');
    expect(W.whyText({ ...r, state: 'slow' }, { failThreshold: 5 })).toBe('일시 실패 2회째(끊김 판정 전 — 연속 5회째에 끊김) · 타임아웃');
    expect(W.whyText({ ...r, failStreak: 0 })).toBe('');               // 성공 표본이면 서버가 0 으로 되돌린다
    expect(W.whyText({ ...r, state: 'down', failStreak: 4 })).toBe('연속 4회 실패 · 타임아웃'); // 끊김은 기존 문구
    expect(W.nowSubText(r, { failThreshold: 3 })).toBe('일시 실패 2회째(끊김 판정 전 — 연속 3회째에 끊김) · 타임아웃 · 평소 11 ms');
    expect(W.nowSubText({ ...r, baseMs: null })).toBe('일시 실패 2회째(끊김 판정 전) · 타임아웃');
    expect(W.nowSubText({ state: 'down', failStreak: 3, failKind: 'refused' })).toBe('연속 3회 실패 · 연결 거부');
    expect(W.nowSubText({ state: 'unknown', reason: 'stale' })).toBe('측정이 멈춤');
    expect(W.nowSubText({ state: 'slow', ms: 1930, baseMs: 820 })).toBe('평소 820 ms 의 2.4배');
    expect(W.nowSubText({ state: 'ok', ms: 12, baseMs: null })).toBe('평소 —');
  });
  it('제외 표지 — 사유 · 시각 · 누가 · 꺼짐 · 설정 오류와 겹치면 두 사실을 함께', () => {
    const ex = { at: NOW - 3 * 24 * HOUR, by: 'admin', reason: '이전 작업 중' };
    expect(W.excludedText(ex, NOW, { offsetMin: KST })).toBe('제외 11-24 12:30 · admin · 사유: 이전 작업 중');
    expect(W.excludedText({ at: null, by: '', reason: '' }, NOW)).toBe('제외 —');
    expect(W.excludedText(null)).toBe('');
    expect(W.isExcludedRow({ state: 'ok', excluded: null })).toBe(false);
    expect(W.isExcludedRow({ state: 'off', excluded: ex })).toBe(true);
    expect(W.isExcludedRow({ state: 'excluded' })).toBe(true);
    expect(W.excludedNote({ state: 'excluded', excluded: ex }, NOW, { offsetMin: KST })).toBe('제외 11-24 12:30 · admin · 사유: 이전 작업 중');
    expect(W.excludedNote({ state: 'off', excluded: ex }, NOW, { offsetMin: KST })).toMatch(/^제외 11-24 12:30 · admin · 사유: 이전 작업 중 — 지금 ‘꺼짐’ 상태이기도 해 측정하지 않습니다/);
    expect(W.excludedNote({ state: 'excluded', excluded: null }, NOW)).toBe('측정에서 제외한 대상입니다');
    expect(W.excludedNote({ state: 'ok' }, NOW)).toBe('');
  });
  it('사유 설명의 숫자는 응답 값(없으면 숫자 없이)', () => {
    expect(W.reasonLong('judging', { failThreshold: 5 })).toMatch(/연속 5회째/);
    expect(W.reasonLong('judging', {})).not.toMatch(/\d/);
    expect(W.reasonLong('edge-old-version', { minEdgeVersion: '3.54.0' })).toMatch(/3\.54\.0 이상/);
    expect(W.reasonLong('stale', { staleMs: 240_000 })).toMatch(/4분 넘게/);
  });
  it('각주 — 사유마다 한 번', () => {
    const n = W.reasonNotes([{ reason: 'stale' }, { reason: 'stale' }, { reason: null }, { reason: 'no-data' }]);
    expect(n.map((x) => x.code)).toEqual(['stale', 'no-data']);
  });
  it('보조 줄 — 기종 · 수집 방식', () => {
    expect(W.subText({ kind: 'vcenter', sub: 'direct' })).toBe('직접 수집');
    expect(W.subText({ kind: 'vcenter', sub: 'site' })).toBe('엣지 수집');
    expect(W.subText({ kind: 'storage', sub: 'api', typeLabel: 'PowerMax' })).toBe('PowerMax · REST');
    expect(W.subText({ kind: 'cvp', sub: '' })).toBe('');
  });
});

const row = (id, kind, corp, state, extra = {}) => ({ id, kind, kindLabel: kind, name: id, corp: { key: corp, label: corp.toUpperCase() }, state, ...extra });

describe('합계 · 타일 · 격자', () => {
  const rows = [
    row('a', 'vcenter', 'kr', 'ok'), row('b', 'vcenter', 'kr', 'down'), row('c', 'vcenter', 'us', 'slow'),
    row('d', 'storage', 'kr', 'unknown'), row('e', 'storage', 'kr', 'off'), row('f', 'storage', 'us', 'excluded'),
    row('g', 'cvp', '', 'problem'), row('h', 'cvp', 'kr', 'ok'),
  ];
  it('행으로 셀 때 꺼짐 · 제외 · 설정 오류는 total 에 들지 않는다', () => {
    const c = W.countsOf({ rows });
    expect(c.total).toBe(5);
    expect(c.off).toBe(1);
    expect(c.excluded).toBe(1);
    expect(c.problem).toBe(1);
    expect(W.sideText(c)).toBe('합계에 넣지 않은 대상 — 꺼짐 1 · 제외 1 · 설정 오류 1');
  });
  it('서버 counts 가 있으면 그대로(0 도 값이다)', () => {
    const c = W.countsOf({ rows, counts: { total: 15, ok: 11, slow: 1, down: 0, unknown: 3, off: 0, excluded: 0, problem: 0 } });
    expect(c.total).toBe(15);
    expect(c.down).toBe(0);
    expect(c.off).toBe(0);
  });
  it('타일 보조 문구의 숫자는 응답 규칙 값', () => {
    const t = W.tilesOf({ total: 5, ok: 2, slow: 1, down: 1, unknown: 1 }, { slowFactor: 2.5, failThreshold: 4 }, 4);
    expect(t.map((x) => x.key)).toEqual(['all', 'ok', 'slow', 'down', 'unknown']);
    expect(t[0].sub).toBe('등록부 4종에서 자동 등록');
    expect(t[2].sub).toBe('평소의 2.5배 초과');
    expect(t[3].sub).toBe('연속 4회 실패');
    const t2 = W.tilesOf({}, {}, null);
    expect(t2[2].sub).not.toMatch(/\d/);
    expect(t2[3].sub).not.toMatch(/\d/);
  });
  it('격자 칸 = 그 법인 그 종류의 가장 나쁜 상태 · 대상 없으면 빈 칸 · 법인 모름은 맨 뒤', () => {
    const m = W.matrixOf(rows, [{ key: 'collector', label: '엣지 포탈' }, { key: 'vcenter', label: 'vCenter' }, { key: 'cvp', label: 'CVP' }, { key: 'storage', label: '스토리지' }]);
    expect(m.corps.map((c) => c.key)).toEqual(['kr', 'us', '']);
    const line = (k) => m.lines.find((l) => l.kind === k);
    expect(line('collector').cells).toEqual([null, null, null]);
    expect(line('vcenter').cells[0].state).toBe('down');       // ok + down → down
    expect(line('vcenter').cells[0].n).toBe(2);
    expect(line('vcenter').cells[1].state).toBe('slow');
    expect(line('storage').cells[0].state).toBe('unknown');    // 못 잼 > 꺼짐
    expect(line('storage').cells[1].state).toBe('excluded');
    expect(line('cvp').cells[2].state).toBe('problem');
    expect(line('vcenter').cells[0].title).toMatch(/끊김 1 · 정상 1/);
  });
  it('격자 열 — 나쁜 상태가 있는 법인이 왼쪽(이름순보다 먼저) · 꺼짐 · 제외는 당기지 않는다', () => {
    const r = (id, corp, state) => ({ id, kind: 'vcenter', kindLabel: 'vCenter', state, corp: { key: corp, label: corp.toUpperCase() } });
    const m = W.matrixOf([r('1', 'aa', 'ok'), r('2', 'bb', 'excluded'), r('3', 'zz', 'down'), r('4', 'yy', 'slow'), r('5', 'xx', 'unknown')], [{ key: 'vcenter', label: 'vCenter' }]);
    expect(m.corps.map((c) => c.key)).toEqual(['zz', 'xx', 'yy', 'aa', 'bb']);
  });
  it('거르기 — 종류 · 상태 · 법인 · 찾기', () => {
    expect(W.filterRows(rows, { kind: 'vcenter' }).length).toBe(3);
    expect(W.filterRows(rows, { state: 'ok' }).map((r) => r.id)).toEqual(['a', 'h']);
    expect(W.filterRows(rows, { corp: 'us' }).map((r) => r.id)).toEqual(['c', 'f']);
    expect(W.filterRows(rows, { q: 'US' }).map((r) => r.id)).toEqual(['c', 'f']);
    expect(W.filterRows(rows, { kind: 'storage', q: 'kr' }).map((r) => r.id)).toEqual(['d', 'e']);
  });
  it('정렬값 — 오름차순이 나쁜 상태가 위', () => {
    const order = ['ok', 'down', 'excluded', 'unknown', 'slow', 'off', 'problem'].sort((a, b) => W.stateSort(a) - W.stateSort(b));
    expect(order).toEqual(['down', 'unknown', 'slow', 'ok', 'problem', 'off', 'excluded']);
  });
});

describe('24시간 띠', () => {
  it('칸 값 → 색 · 설명 · 측정 없음(null)은 따로', () => {
    expect(W.stripCell(0).cls).toBe('c0');
    expect(W.stripCell(2).cls).toBe('c2');
    expect(W.stripCell(null).cls).toBe('cn');
    expect(W.stripCell('').cls).toBe('cn');   // '' 를 0(정상)으로 읽지 않는다
    expect(W.stripCell(9).cls).toBe('cn');
    const c = W.stripCells([0, 1, null, 3], 1_800_000);
    expect(c[3].title).toBe('최근 30분 · 끊김');
    expect(c[2].title).toBe('30분~1시간 전 · 측정 없음');
  });
  it('1시간 칸으로 합치면 더 나쁜 값 · 둘 다 없으면 null', () => {
    expect(W.stripHourly([0, null, null, 1, 2, 0, 3])).toEqual([0, null, 2, 3]);   // 최근 쪽부터 두 칸씩 — 홀수면 가장 오래된 칸이 혼자
  });
  it('읽는 글', () => {
    expect(W.stripSummary([0, 0, 2, null], 'vc-1')).toBe('vc-1 상태 띠 4칸 — 정상 2칸 · 일시 실패(끊김 판정 전) 1칸 · 측정 없음 1칸');
  });
});

describe('상세', () => {
  it('상태 변화 — 등록 · 첫 판정 · 바뀜', () => {
    expect(W.eventView({ to: 'registered', address: '198.51.100.24:20444' }).text).toBe('등록부에서 자동 등록 · 198.51.100.24:20444');
    expect(W.eventView({ to: 'registered', address: '' }).text).toBe('등록부에서 자동 등록');
    const first = W.eventView({ from: null, to: 'ok', ms: 12, by: 'central' });
    expect(first.text).toBe('첫 판정 · 12 ms · 중앙 측정');
    const ch = W.eventView({ from: 'ok', to: 'down', ms: null, failKind: 'refused', by: 'edge-us', note: '' });
    expect(ch.from).toBe('ok');
    expect(ch.to).toBe('down');
    expect(ch.text).toBe('연결 거부 · edge-us 측정');
  });
  it('추이 합 — 카운터(0 이 값) · 칸 없으면 null', () => {
    expect(W.seriesTally([])).toBe(null);
    expect(W.seriesTally([{ n: 6, fail: 0 }, { n: 0, fail: 0 }, { n: 6, fail: 2 }])).toEqual({ n: 12, fail: 2 });
  });
  it('같은 주소 — 이 대상을 포트 순으로 끼운다', () => {
    const r = W.sameHostRows({ id: 'x', port: 20444 }, [{ id: 'y', port: 20445 }, { id: 'z', port: 20443 }, { id: 'x', port: 20444 }]);
    expect(r.map((v) => [v.id, v.self])).toEqual([['z', false], ['x', true], ['y', false]]);
  });
  it('추이 그림 — 측정 없는 칸에서 선을 끊는다(0 으로 내리지 않는다) · 외톨이 칸은 점', () => {
    const t0 = NOW - 6 * HOUR;
    const s = [
      { ts: t0, avg: 800, min: 790, max: 810, n: 6, fail: 0, worst: 0 },
      { ts: t0 + HOUR, avg: 820, min: 800, max: 830, n: 6, fail: 0, worst: 0 },
      { ts: t0 + 2 * HOUR, avg: null, min: null, max: null, n: 0, fail: 0, worst: null },
      { ts: t0 + 3 * HOUR, avg: 900, min: 900, max: 900, n: 1, fail: 5, worst: 3 },
      { ts: t0 + 4 * HOUR, avg: null, min: null, max: null, n: 0, fail: 0, worst: null },
    ];
    const m = W.chartModel(s, { start: t0, end: NOW, baseMs: 820, slowAtMs: 1640, offsetMin: KST, now: NOW });
    expect(m.line.length).toBe(1);
    expect(m.singles.length).toBe(1);
    expect(m.fails.length).toBe(1);
    expect(m.fails[0].down).toBe(true);
    expect(m.top).toBeGreaterThanOrEqual(1640);
    expect(m.baseY).not.toBe(null);
    expect(m.grid[0].label).toBe('0 ms');
    expect(W.chartModel([], {})).toBe(null);
    const h = W.hoverAt(m, m.points[2].x, NOW, { offsetMin: KST });
    expect(h.lines[0]).toBe('측정 없음');
  });
});

describe('실행 · 표본 문구', () => {
  it('지금 측정 응답 — 서버 note 우선 · measured · queued', () => {
    expect(W.runResultText({ ok: true, note: '중앙 대상 9개를 잽니다' })).toBe('중앙 대상 9개를 잽니다');
    expect(W.runResultText({ ok: true, measured: 1 })).toBe('1개를 쟀습니다 — 표는 곧 새 값으로 바뀝니다.');
    expect(W.runResultText({ ok: true, measured: 9, failed: 1, note: '' })).toBe('9개를 쟀습니다(그중 연결 실패 1개) — 표는 곧 새 값으로 바뀝니다.');
    expect(W.runResultText({ ok: true, measured: 9, failed: 0 })).toBe('9개를 쟀습니다 — 표는 곧 새 값으로 바뀝니다.');
    // 0개를 잰 경우에 '표가 곧 바뀐다' 고 말하지 않는다
    expect(W.runResultText({ ok: true, measured: 0, failed: 0, note: '' })).toBe('중앙이 이번에 잰 대상은 없습니다 — 엣지가 재는 대상은 다음 엣지 보고 때 반영됩니다.');
    expect(W.runResultText({ ok: true, measured: 0, failed: 0, skipped: 2 })).toBe('중앙이 이번에 잰 대상은 없습니다(측정하지 못한 대상 2개) — 엣지가 재는 대상은 다음 엣지 보고 때 반영됩니다.');
    expect(W.runResultText({ ok: true, measured: 5, failed: 1, skipped: 2 })).toBe('5개를 쟀습니다(그중 연결 실패 1개) · 측정하지 못한 대상 2개 — 표는 곧 새 값으로 바뀝니다.');
    expect(W.runResultText({ ok: true, queued: 9 })).toBe('9개 측정을 시작했습니다 — 결과는 곧 표에 보입니다.');
    expect(W.runResultText({ ok: true, queued: true })).toBe('측정을 시작했습니다 — 결과는 곧 표에 보입니다.');
    expect(W.runResultText({ ok: true })).toBe('측정을 요청했습니다.');
  });
  it('표본 합 문구', () => {
    expect(W.tallyText({ n: 1440, fail: 0 })).toBe('1,440회 중 실패 0회');
    expect(W.tallyText(null)).toBe('');
  });
});

describe('상세 기준 시각 · 꺼진 종류 문구', () => {
  it('상세 기준 시각은 응답 generatedAt — 칸 경계로 올린 end 를 쓰면 저녁 시각이 어제가 된다(30일 · KST 22:10)', () => {
    const gen = Date.UTC(2026, 10, 27, 13, 10, 0);          // KST 22:10
    const step = 6 * HOUR;                                   // 30일 보기의 칸
    const end = Math.ceil(gen / step) * step;                // KST 03:00 다음 날 — 칸 경계로 올림
    const d = { generatedAt: gen, end, start: end - 30 * 24 * HOUR, stepMs: step };
    const lastTs = gen - 40_000;                              // 오늘 22:09
    expect(W.clockText(lastTs, end, { offsetMin: KST })).toBe('어제 22:09');   // 예전 결함 재현(now = d.end)
    expect(W.detailNowOf(d, 0)).toBe(gen);
    expect(W.clockText(lastTs, W.detailNowOf(d), { offsetMin: KST, sec: true })).toBe('22:09:20');
    expect(W.detailNowOf({}, 123)).toBe(123);
    expect(W.detailNowOf({ generatedAt: '' }, 123)).toBe(123);
  });
  it('등록부 오류 배너 — 서버 label 우선 · 꺼진 종류 표지 · 영문 키를 그대로 보이지 않는다', () => {
    expect(W.sourceErrorText({ kind: 'storage', label: '스토리지', off: true, reason: '등록부 파일을 읽지 못했습니다' })).toBe('스토리지 등록부(측정 꺼짐) — 등록부 파일을 읽지 못했습니다');
    expect(W.sourceErrorText({ kind: 'storage', reason: 'x' }, [])).toBe('스토리지 등록부 — x');   // kinds 에 없어도(꺼진 종류) 라벨
    expect(W.sourceErrorText({ kind: 'cvp' }, [{ key: 'cvp', label: 'CVP' }])).toBe('CVP 등록부 — 읽지 못했습니다');
  });
  it('꺼진 종류 안내 · 빈 목록 문구(전부 껐으면 거짓 대상 없음이라 하지 않는다)', () => {
    expect(W.kindsOffText([], [])).toBe('');
    expect(W.kindsOffText(['storage', 'cvp'], [{ key: 'vcenter', label: 'vCenter' }])).toBe('측정이 꺼진 종류: 스토리지 · CVP — 자동 등록 · 설정에서 켜면 대상이 됩니다.');
    expect(W.emptyRowsText({ kinds: [], sourceErrors: [] })).toBe('측정할 종류가 모두 꺼져 있습니다 — 자동 등록 · 설정에서 켜세요.');
    expect(W.emptyRowsText({ kinds: [{ key: 'vcenter', label: 'vCenter' }], sourceErrors: [{ kind: 'vcenter' }] })).toMatch(/^등록부를 읽지 못한 종류가 있습니다/);
    expect(W.emptyRowsText({ kinds: [{ key: 'vcenter', label: 'vCenter' }, { key: 'cvp', label: 'CVP' }], sourceErrors: [] })).toBe('등록부에 대상이 없습니다 — vCenter · CVP에 장비를 등록하면 다음 측정 주기에 대상이 됩니다.');
  });
});

describe('설정 폼 ↔ 본문', () => {
  const settings = {
    enabled: true, intervalMs: 60000, timeoutMs: 2500, concurrency: 16, failThreshold: 3, slowFactor: 2, slowMinDeltaMs: 30, retentionDays: 90,
    kinds: { collector: true, vcenter: true, cvp: true, storage: true },
    alerts: { down: true, slow: false, unknownMin: 30, to: ['ops@example.invalid'] },
  };
  const limits = {
    intervalMs: { min: 30000, max: 3600000 }, timeoutMs: { min: 500, max: 15000 }, concurrency: { min: 1, max: 64 },
    failThreshold: { min: 1, max: 20 }, slowFactor: { min: 1.2, max: 20 }, slowMinDeltaMs: { min: 0, max: 10000 },
    retentionDays: { min: 8, max: 730 }, unknownMin: { min: 0, max: 1440 },
  };
  it('초 단위 칸 → ms · 그대로면 바뀐 값 없음', () => {
    const f = W.formFromSettings(settings);
    expect(f.intervalMs).toBe('60');
    expect(f.timeoutMs).toBe('2.5');
    expect(f.unknownOn).toBe(true);
    expect(f.unknownMin).toBe('30');
    const { body, issues, kept } = W.bodyFromForm(f, settings, limits);
    expect(issues).toEqual([]);
    expect(kept).toEqual([]);
    expect(body.intervalMs).toBe(60000);
    expect(body.timeoutMs).toBe(2500);
    expect(W.changedLabels(body, settings)).toEqual([]);
  });
  it('빈 칸 · 0 이하는 보내지 않는다(현재 값 유지 — 칸 이름을 밝힌다)', () => {
    const f = { ...W.formFromSettings(settings), intervalMs: '', timeoutMs: '0', failThreshold: '-2' };
    const { body, issues, kept } = W.bodyFromForm(f, settings, limits);
    expect(issues).toEqual([]);
    expect(Object.hasOwn(body, 'intervalMs')).toBe(false);
    expect(Object.hasOwn(body, 'timeoutMs')).toBe(false);
    expect(Object.hasOwn(body, 'failThreshold')).toBe(false);
    expect(kept).toEqual(['측정 주기(초)', '연결 시한(초)', '끊김 판정 — 연속 실패(회)']);
  });
  it('0 이 뜻 있는 칸(최소 차이)은 0 을 보낸다', () => {
    const f = { ...W.formFromSettings(settings), slowMinDeltaMs: '0' };
    const { body } = W.bodyFromForm(f, settings, limits);
    expect(body.slowMinDeltaMs).toBe(0);
  });
  it('문자 · 정수 칸의 소수 · 범위 밖은 저장하지 않는다', () => {
    const f = { ...W.formFromSettings(settings), intervalMs: 'abc', failThreshold: '2.5', retentionDays: '1', slowFactor: '1.5' };
    const { body, issues } = W.bodyFromForm(f, settings, limits);
    expect(issues.map((i) => [i.key, i.reason])).toEqual([
      ['intervalMs', '숫자가 아닙니다'],
      ['failThreshold', '정수로 입력하세요'],
      ['retentionDays', '8~730일 사이로 입력하세요'],
    ]);
    expect(body.slowFactor).toBe(1.5);
    expect(W.rangeText(W.SETTING_FIELDS[0], limits)).toBe('30~3600초');
  });
  it('못 잼 알림 — 끄면 0, 켜고 빈 칸이면 현재 값, 0 · 문자는 오류', () => {
    const base = W.formFromSettings(settings);
    expect(W.bodyFromForm({ ...base, unknownOn: false }, settings, limits).body.alerts.unknownMin).toBe(0);
    expect(W.bodyFromForm({ ...base, unknownMin: '' }, settings, limits).body.alerts.unknownMin).toBe(30);
    expect(W.bodyFromForm({ ...base, unknownMin: '0' }, settings, limits).issues[0].key).toBe('unknownMin');
    expect(W.bodyFromForm({ ...base, unknownMin: 'x' }, settings, limits).issues[0].reason).toBe('숫자가 아닙니다');
    expect(W.bodyFromForm({ ...base, unknownOn: true, unknownMin: '' }, { ...settings, alerts: { ...settings.alerts, unknownMin: 0 } }, limits).issues[0].reason).toBe('분을 입력하세요');
  });
  it('받는 사람 상한 — 서버 limits.alertsTo.max 를 넘으면 저장 전에 막는다(숫자는 응답 값)', () => {
    const many = Array.from({ length: 4 }, (_, i) => `a${i}@x.io`).join(', ');
    const f = { ...W.formFromSettings(settings), to: many };
    const r = W.bodyFromForm(f, settings, { ...limits, alertsTo: { max: 3 } });
    expect(r.issues).toEqual([{ key: 'to', label: '받는 사람', reason: '3명까지 넣을 수 있습니다(지금 4명)' }]);
    expect(W.bodyFromForm(f, settings, { ...limits, alertsTo: { max: 4 } }).issues).toEqual([]);
    expect(W.bodyFromForm(f, settings, limits).issues).toEqual([]);   // 상한을 모르면 막지 않는다(서버가 판정)
  });
  it('받는 사람 — 나눔 · 형식 검사 · 바뀜 감지', () => {
    expect(W.parseRecipients('a@x.io, b@x.io;  a@x.io\nc@x.io')).toEqual(['a@x.io', 'b@x.io', 'c@x.io']);
    const f = { ...W.formFromSettings(settings), to: 'ops@example.invalid, nope' };
    expect(W.bodyFromForm(f, settings, limits).issues[0].key).toBe('to');
    const f2 = { ...W.formFromSettings(settings), to: 'ops@example.invalid, noc@example.invalid', alertSlow: true };
    expect(W.changedLabels(W.bodyFromForm(f2, settings, limits).body, settings)).toEqual(['알림', '받는 사람']);
  });
});

describe('주소(해시)', () => {
  it('메인 · 상세 · 설정 · 잘못된 딥링크는 메인', () => {
    const id = 'set:vcenter|vc-use-01';
    expect(W.routeOf('#/tools/svc-status')).toEqual({ view: 'main', id: '' });
    expect(W.routeOf('#/tools/svc-status/settings')).toEqual({ view: 'settings', id: '' });
    expect(W.routeOf(W.hashOf('target', id))).toEqual({ view: 'target', id });
    expect(W.routeOf('#/tools/svc-status/target/%E0%A4%A')).toEqual({ view: 'main', id: '' });
    expect(W.routeOf('#/tools/other/target/x')).toEqual({ view: 'main', id: '' });
    expect(W.hashOf('main')).toBe('#/tools/svc-status');
  });
  it('403 · 404 는 폴링을 멈춘다', () => {
    expect(W.shouldStopPolling({ status: 403 })).toBe(true);
    expect(W.shouldStopPolling({ status: 404 })).toBe(true);
    expect(W.shouldStopPolling({ status: 500 })).toBe(false);
    expect(W.shouldStopPolling(null)).toBe(false);
  });
});

describe('문구 규칙', () => {
  it('모든 고정 문구에 백틱이 없다', () => {
    const all = [
      ...Object.values(W.REASON_TEXT).flatMap((r) => [r.short, r.long({ staleMs: 1, failThreshold: 1, minEdgeVersion: '1' })]),
      ...Object.values(W.FAIL_TEXT), ...Object.values(W.STATES).map((s) => s.label),
      ...W.legendOf({ slowFactor: 2, failThreshold: 3, baselineDays: 7, slowMinDeltaMs: 30 }).map((x) => x.text),
      W.measureText({ intervalMs: 60000, timeoutMs: 2500 }), W.NO_CHANGE_TEXT,
    ];
    for (const s of all) expect(s).not.toContain('`');
  });
  it('범례 · 측정 문구의 숫자는 응답 값', () => {
    const l = W.legendOf({ slowFactor: 3, failThreshold: 5, baselineDays: 14, slowMinDeltaMs: 50 });
    expect(l[1].text).toBe('지연 — 연결되지만 평소(최근 14일 중앙값)의 3배 초과(차이 50 ms 이상)');
    expect(l[2].text).toBe('끊김 — 연속 5회 연결 실패');
    expect(W.measureText({ intervalMs: 60000, timeoutMs: 2500 })).toBe('TCP 연결 · 60초마다 · 시한 2.5초(평소가 큰 대상은 자동으로 늘림)');
    expect(W.measureText({})).toBe('TCP 연결');
  });
  it('마지막 측정 줄', () => {
    expect(W.lastRunText(null, 60000, NOW).text).toBe('아직 측정 기록 없음 · 주기 60초');
    expect(W.lastRunText({ running: true }, 60000, NOW).text).toBe('측정 중… · 주기 60초');
    const r = W.lastRunText({ last: { at: NOW - 60_000, ms: 812, measured: 9, failed: 1, skipped: 0 } }, 60000, NOW, { offsetMin: KST });
    expect(r.text).toBe('마지막 측정 12:29:00 · 주기 60초');
    expect(r.title).toBe('마지막 측정 주기 — 측정 9 · 실패 1 · 건너뜀 0 · 걸린 시간 812 ms');
    expect(r.tone).toBe('');
  });
  it('마지막 측정 줄 — 주기 실패는 문구에 실패 + warn 톤, 꺼진 주기는 자동 측정 꺼짐(마지막 측정이라 하지 않는다)', () => {
    const f = W.lastRunText({ last: { at: NOW - 60_000, ms: 30, ok: false, error: 'DB 잠김' } }, 60000, NOW, { offsetMin: KST });
    expect(f.text).toBe('마지막 주기 실패 12:29:00 · 주기 60초');
    expect(f.tone).toBe('warn');
    expect(f.error).toBe('DB 잠김');
    expect(f.title).toBe('주기 실패 — DB 잠김 · 걸린 시간 30 ms');
    expect(W.lastRunText({ last: { at: NOW, error: 'x' } }, 60000, NOW).tone).toBe('warn');   // ok 없이 error 만 있어도 실패
    const off = W.lastRunText({ last: { at: NOW - 60_000, ms: 0, trigger: 'timer', disabled: true } }, 60000, NOW, { offsetMin: KST });
    expect(off.text).toBe('자동 측정 꺼짐');
    expect(off.text).not.toMatch(/마지막 측정|0 ms/);
    expect(off.title).toBe('마지막 확인 12:29:00');
    const man = W.lastRunText({ last: { at: NOW - 60_000, ms: 10, measured: 1, trigger: 'manual' } }, 60000, NOW, { offsetMin: KST });
    expect(man.title).toMatch(/^수동 측정 — /);
  });
});

describe('차트 축 눈금', () => {
  it('값이 없으면 0 만 · 작은 범위는 같은 글자가 겹치지 않는다', () => {
    const empty = W.chartModel([{ ts: 1_000, avg: null, n: 0 }], { start: 0, end: 10_000 });
    expect(empty.grid.map((g) => g.label)).toEqual(['0 ms', '', '', '', '']);
    const small = W.chartModel([{ ts: 1_000, avg: 1.5, max: 1.8, n: 1 }, { ts: 2_000, avg: 1.2, max: 1.4, n: 1 }], { start: 0, end: 10_000 });
    const labels = small.grid.slice(1).map((g) => g.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
