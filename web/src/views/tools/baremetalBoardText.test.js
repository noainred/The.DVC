// v2.917 서버 › 물리 서버 '상태 보드' — 서버 1대 상태 접기 · 집계 · 소속 규칙(서버 serverInScope 와 대조).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  boardState, buildBoard, matchBoardFilter, scopeMatchServer, effVcOf, dcOfServer, matchServerQuery,
  ageText, tileTitle, attentionDetail, nojudgeReasonText, nojudgeShortText, BOARD_STATES, BOARD_STATE_TEXT, BOARD_STATE_TONE,
  NOJUDGE_NO_PARTS, NOJUDGE_NO_SUMMARY,
} from './baremetalBoardText.js';
import { serverInScope } from '../../../../server/src/insights/analysisScope.js';
import { PARTS_REASON } from '../../../../server/src/idrac/serverParts.js';
import { stripComments } from '../../test/_stripComments.js';

const P = (o) => ({ judged: true, reason: null, ok: 0, warn: 0, fault: 0, unknown: 0, absent: 0, total: 0, failedKinds: [], collectedAt: 1, stale: false, ...o });

describe('boardState — 서버 1대 상태(못 읽은 것은 정상이 아니다)', () => {
  it('장애 > 경고 > 일부 확인 불가 > 정상', () => {
    expect(boardState(P({ fault: 1, warn: 2, ok: 9 })).state).toBe('fault');
    expect(boardState(P({ warn: 1, unknown: 3, ok: 9 })).state).toBe('warn');
    expect(boardState(P({ unknown: 1, ok: 9 })).state).toBe('partial');
    expect(boardState(P({ ok: 9, failedKinds: ['psu'] })).state).toBe('partial'); // 일부 종류 수집 실패도 정상 아님
    expect(boardState(P({ ok: 9 })).state).toBe('ok');
  });
  it('판정 못함 — 요약 없음 · 판정 불가 사유 · 부품 0개', () => {
    expect(boardState(null)).toMatchObject({ state: 'nojudge', reason: NOJUDGE_NO_SUMMARY });
    expect(boardState(undefined).state).toBe('nojudge');
    expect(boardState(P({ judged: false, reason: 'unreachable' }))).toMatchObject({ state: 'nojudge', reason: 'unreachable' });
    expect(boardState(P({ judged: false, reason: '' })).reason).toBe(NOJUDGE_NO_SUMMARY);
    expect(boardState(P({ ok: 0, total: 0 }))).toMatchObject({ state: 'nojudge', reason: NOJUDGE_NO_PARTS });
  });
  it('수치가 아닌 값은 0 개로 다루되 상태를 정상으로 만들지 않는다', () => {
    expect(boardState(P({ ok: null, fault: '2' })).state).toBe('nojudge'); // 문자열 '2' 는 수가 아니다 → 확인한 부품 0
  });
  it('오래됨은 상태와 직교(판정 유지)', () => {
    const b = boardState(P({ fault: 1, stale: true }));
    expect(b.state).toBe('fault');
    expect(b.stale).toBe(true);
    expect(boardState(P({ ok: 3, stale: 'yes' })).stale).toBe(false);
  });
  it('상태 5종 모두 문구·색이 있다(확인 불가·판정 못함은 회색)', () => {
    for (const s of BOARD_STATES) { expect(BOARD_STATE_TEXT[s]).toBeTruthy(); expect(BOARD_STATE_TONE[s]).toBeTruthy(); }
    expect(BOARD_STATE_TONE.partial).toBe('gray');
    expect(BOARD_STATE_TONE.nojudge).toBe('gray');
  });
  it('판정 못함 사유 — 서버 PARTS_REASON 전부에 문구·짧은 글자가 있다', () => {
    for (const k of Object.values(PARTS_REASON)) {
      expect(nojudgeReasonText(k)).not.toBe('판정하지 못했습니다');
      expect(nojudgeShortText(k)).not.toBe('기타');
    }
    expect(nojudgeShortText('zzz')).toBe('기타');
  });
});

describe('소속·스코프 — 서버 serverInScope 와 같은 입력으로 대조(판정 두 벌 금지)', () => {
  const assign = { vc1: 'corpA', vc2: 'corpB' };
  const servers = [
    { id: 'a', vcenterId: 'vc1' }, { id: 'b', mappedVcenterId: 'vc2' }, { id: 'c', datacenterId: 'corpA' },
    { id: 'd' }, { id: 'e', datacenterId: 'corpB', mappedVcenterId: 'vc1' }, { id: 'f', vcenterId: 'vc9' },
  ];
  const scopes = [
    {}, { baremetal: true }, { datacenterId: 'corpA' }, { datacenterId: 'corpA', baremetal: true }, { datacenterId: '__unmapped__' },
    { datacenterId: '__unmapped__', baremetal: true }, { vcenterId: 'vc1' }, { vcenterId: '__unmapped__' }, { vcenterId: 'vc2', datacenterId: 'corpB' },
  ];
  it('모든 조합에서 결과가 같다', () => {
    for (const sc of scopes) for (const s of servers) {
      expect(scopeMatchServer(s, sc, assign), JSON.stringify({ sc, s })).toBe(serverInScope(s, sc, assign));
    }
  });
  it('effVc · 법인', () => {
    expect(effVcOf({ vcenterId: 'x', mappedVcenterId: 'y' })).toBe('x');
    expect(effVcOf({ mappedVcenterId: 'y' })).toBe('y');
    expect(effVcOf(null)).toBe('');
    expect(dcOfServer({ mappedVcenterId: 'vc2' }, assign)).toBe('corpB');
    expect(dcOfServer({ datacenterId: 'z', vcenterId: 'vc1' }, assign)).toBe('z');
    expect(dcOfServer({}, assign)).toBe('');
  });
  it('검색 — 이름·서비스태그·주소·모델, 대소문자 무시', () => {
    const s = { name: 'KR-BM-01', serviceTag: '7XK2P93', host: '10.1.2.3', model: 'PowerEdge R760' };
    expect(matchServerQuery(s, '')).toBe(true);
    expect(matchServerQuery(s, ' r760 ')).toBe(true);
    expect(matchServerQuery(s, '7xk2')).toBe(true);
    expect(matchServerQuery(s, '10.1.2')).toBe(true);
    expect(matchServerQuery(s, 'nope')).toBe(false);
  });
});

describe('buildBoard — 집계', () => {
  const dcName = new Map([['corpA', 'DaVinci KR'], ['corpB', 'IRS Poland']]);
  const servers = [
    { id: '1', name: 'a1', datacenterId: 'corpA', model: 'PowerEdge R760', parts: P({ ok: 10, collectedAt: 1000 }) },
    { id: '2', name: 'a2', datacenterId: 'corpA', model: 'PowerEdge R760', parts: P({ fault: 1, ok: 9, collectedAt: 2000, stale: true }) },
    { id: '3', name: 'b1', datacenterId: 'corpB', model: 'PowerEdge R650', parts: P({ warn: 2, ok: 9 }) },
    { id: '4', name: 'b2', datacenterId: 'corpB', model: '', parts: P({ judged: false, reason: 'unreachable', collectedAt: null }) },
    { id: '5', name: 'u1', model: 'PowerEdge R650', parts: P({ unknown: 1, ok: 3 }), authStopped: { at: 1 } },
    { id: '6', name: 'ome', type: 'ome' },
    { id: '7', name: 'n1', datacenterId: 'corpA', model: 'PowerEdge R760' }, // parts 없음
  ];
  const b = buildBoard(servers, { dcName });
  it('OME 는 세지 않고 수만 밝힌다', () => {
    expect(b.omeSkipped).toBe(1);
    expect(b.counts.all).toBe(6);
  });
  it('상태별 합 = 전체 · 오래됨은 따로', () => {
    expect(b.counts).toMatchObject({ fault: 1, warn: 1, partial: 1, ok: 1, nojudge: 2, stale: 1 });
    expect(b.counts.fault + b.counts.warn + b.counts.partial + b.counts.ok + b.counts.nojudge).toBe(b.counts.all);
  });
  it('판정 못한 사유 집계 · 인증 정지 수', () => {
    expect(b.reasons.map((r) => [r.key, r.n])).toEqual([[NOJUDGE_NO_SUMMARY, 1], ['unreachable', 1]]);
    expect(b.authStopped).toBe(1);
  });
  it('법인 묶음 — 장애 있는 법인 먼저 · 미지정은 맨 뒤 · 묶음 안 타일도 나쁜 것 먼저', () => {
    expect(b.groups.map((g) => g.name)).toEqual(['DaVinci KR', 'IRS Poland', '미지정(법인 없음)']);
    expect(b.groups[0].rows.map((r) => r.s.id)).toEqual(['2', '7', '1']);
    expect(b.groups[0].topModel).toEqual({ name: 'PowerEdge R760', n: 3 });
    expect(buildBoard(servers, { dcName, dcErr: true }).groups.at(-1).name).toBe('법인 정보를 읽지 못함');
  });
  it('모델 분포 — 빈 모델은 미상', () => {
    expect(b.models).toEqual([{ name: 'PowerEdge R760', n: 3 }, { name: 'PowerEdge R650', n: 2 }, { name: '미상', n: 1 }]);
  });
  it('주의 목록 = 장애·경고만, 장애 먼저', () => {
    expect(b.attention.map((r) => r.s.id)).toEqual(['2', '3']);
    expect(attentionDetail(b.attention[0])).toBe('장애 부품 1 · PowerEdge R760');
  });
  it('최신 수집 시각 = 판정에 쓴 인벤토리 중 가장 새것(없으면 null)', () => {
    expect(b.newestAt).toBe(2000);
    expect(buildBoard([{ id: 'x', parts: null }]).newestAt).toBe(null);
  });
  it('필터', () => {
    const rows = b.rows;
    expect(rows.filter((r) => matchBoardFilter(r, 'all')).length).toBe(6);
    expect(rows.filter((r) => matchBoardFilter(r, 'stale')).map((r) => r.s.id)).toEqual(['2']);
    expect(rows.filter((r) => matchBoardFilter(r, 'nojudge')).map((r) => r.s.id)).toEqual(['4', '7']);
  });
  it('입력이 배열이 아니어도 깨지지 않는다', () => {
    expect(buildBoard(null).counts.all).toBe(0);
    expect(buildBoard([null, 1, 'x']).counts.all).toBe(0);
  });
});

describe('글자', () => {
  const now = 10 * 86_400_000;
  it('경과 — 값이 없으면 —(0분 전으로 지어내지 않는다)', () => {
    expect(ageText(null, now)).toBe('—');
    expect(ageText(undefined, now)).toBe('—');
    expect(ageText(now - 20_000, now)).toBe('방금 전');
    expect(ageText(now - 11 * 60_000, now)).toBe('11분 전');
    expect(ageText(now - 160 * 60_000, now)).toBe('2시간 40분 전');
    expect(ageText(now - 120 * 60_000, now)).toBe('2시간 전');
    expect(ageText(now - 3 * 86_400_000, now)).toBe('3일 전');
  });
  it('타일 툴팁 — 판정 못함은 사유, 오래됨은 경과', () => {
    const r1 = boardState(P({ judged: false, reason: 'edge-old' }));
    expect(tileTitle({ s: { name: 'x' }, model: 'M', ...r1 }, now)).toContain('엣지');
    const r2 = { s: { name: 'y' }, model: 'M', ...boardState(P({ warn: 1, ok: 2, stale: true })), collectedAt: now - 120 * 60_000 };
    expect(tileTitle(r2, now)).toBe('y · M · 경고 · 경고 1 · 오래됨(2시간 전 값)');
  });
});

describe('화면 규칙(소스)', () => {
  const read = (p) => stripComments(readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8'));
  const board = read('./BaremetalBoard.jsx');
  const hw = read('./HardwareTools.jsx');
  it('무거운 목록 API 를 폴링하지 않는다(마운트 1회 + 새로고침)', () => {
    expect(board).not.toMatch(/setInterval/);
    expect(board).toMatch(/fetchJson\('\/admin\/idrac\?parts=1'\)/);
  });
  it('늦게 온 이전 응답은 버린다', () => { expect(board).toMatch(/my !== seq\.current/); });
  it('표는 STable · 정렬 뒤 자르기(limit)', () => {
    expect(board).toMatch(/<STable[^>]*limit=/);
    expect(board).not.toMatch(/<table/);
  });
  it('백틱 문구·대문자 변환 없음', () => {
    expect(board).not.toMatch(/text-transform|textTransform/);
  });
  it('물리 서버 메뉴의 첫 탭은 상태 보드, 서버 분석(전체)은 기존대로', () => {
    expect(hw).toMatch(/valid: \['board', 'info'/);
    expect(hw).toMatch(/fallback: bm \? 'board' : 'info'/);
    expect(hw).toMatch(/sub === 'board' && <BaremetalBoard /);
  });
  it('서버 분석 목록도 같은 소속 판정 함수를 쓴다(복제 금지)', () => {
    expect(hw).toMatch(/scopeMatchServer\(s, vc, assign\)/);
    expect(hw).not.toMatch(/const effVc = \(s\) => s\.vcenterId/);
  });
});
