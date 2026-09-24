import { describe, it, expect } from 'vitest';
import { layoutDeviceFlow, W, EDGE_X, MAIN_X, CHIPS_MAX_X, MAIN_MIN_H } from './deviceFlowLayout.js';
import {
  worstTone, groupNote, countsText, channelText, headerNote, itemExtra, LEGEND,
  CHANNEL_LABEL, ITEM_STATE_LABEL, TONE_LABEL, DEV_KIND_LABEL,
} from './deviceFlowText.js';

const g = (kind, tone, total = 3, extra = {}) => ({ kind, tone, total, counts: { registered: total }, items: [], omitted: 0, ...extra });
const data = {
  main: { groups: [g('vcenter', 'ok', 2)] },
  edges: [
    { id: 'a', name: 'A', registered: true, line: 'fail', groups: [g('vcenter', 'ok'), g('idrac', 'neutral', 70)] },
    { id: 'b', name: 'B', registered: true, line: 'none', groups: [] },
  ],
};

describe('deviceFlowLayout', () => {
  it('맨 위는 메인 직접 줄, 그 아래 엣지마다 한 줄', () => {
    const l = layoutDeviceFlow(data);
    expect(l.rows.map((r) => r.key)).toEqual(['main', 'edge:a', 'edge:b']);
    expect(l.rows[0].outLine).toBe(null);
    expect(l.rows[0].inLine.d).toMatch(`L${MAIN_X} `);
    expect(l.width).toBe(W);
  });
  it('엣지 → 메인 선: 기록 없음은 점선, 장비 없는 엣지는 장비 선 없음', () => {
    const l = layoutDeviceFlow(data);
    expect(l.rows[1].outLine).toMatchObject({ state: 'fail', dashed: false });
    expect(l.rows[2].outLine).toMatchObject({ state: 'none', dashed: true });
    expect(l.rows[2].inLine).toBe(null);
    expect(l.rows[1].inLine.tone).toBe('ok');
  });
  it('칩은 엣지 칸 앞에서 끝나고 메인은 모든 줄을 덮는다', () => {
    const l = layoutDeviceFlow(data);
    expect(CHIPS_MAX_X).toBeLessThan(EDGE_X);
    for (const r of l.rows) for (const c of r.chips) expect(c.x + c.w).toBeLessThanOrEqual(CHIPS_MAX_X);
    const last = l.rows[l.rows.length - 1];
    expect(l.main.y + l.main.h).toBeGreaterThanOrEqual(last.y + last.h);
    expect(l.main.h).toBeGreaterThanOrEqual(MAIN_MIN_H);
  });
  it('선택한 줄 밖은 흐리게', () => {
    const l = layoutDeviceFlow(data, { type: 'group', where: 'edge', edgeId: 'a', kind: 'idrac' });
    expect(l.rows.map((r) => r.dim)).toEqual([true, false, true]);
    expect(layoutDeviceFlow(data, { type: 'group', where: 'unassigned', kind: 'idrac' }).rows.every((r) => !r.dim)).toBe(true);
  });
  it('빈 데이터에서도 죽지 않는다', () => {
    const l = layoutDeviceFlow({});
    expect(l.rows).toHaveLength(1); expect(l.height).toBeGreaterThan(0);
  });
});

describe('deviceFlowText', () => {
  it('가장 나쁜 색조 — neutral 은 ok 보다 약하다(초록으로 끌어올리지 않는다)', () => {
    expect(worstTone([g('a', 'neutral'), g('b', 'ok')])).toBe('ok');
    expect(worstTone([g('a', 'neutral'), g('b', 'warn')])).toBe('warn');
    expect(worstTone([g('a', 'neutral')])).toBe('neutral');
    expect(worstTone([])).toBe(null);
  });
  it('묶음 머리말 — 판정 안 함·생략·pull 기준을 말한다', () => {
    expect(groupNote(g('idrac', 'neutral'), 'edge')).toMatch('판정하지 않습니다');
    expect(groupNote(g('idrac', 'neutral', 90, { reportBasis: 'pull', reportAt: null }), 'edge')).toMatch('정상 pull 기록이 없습니다');
    expect(groupNote(g('storage', 'ok', 90, { omitted: 10, items: new Array(80) }), 'edge')).toMatch('10대는 생략');
    expect(groupNote(g('vcenter', 'ok'), 'main')).toMatch('직접');
  });
  it('채널 — 기록 없음은 정상이 아니다', () => {
    expect(channelText({ state: 'none' })).toMatch('정상이라는 뜻이 아닙니다');
    expect(channelText({ state: 'fail', routes: 2, failRoutes: 1, lastFailAt: Date.now() })).toMatch('실패 1');
  });
  it('상태 개수·부가 정보', () => {
    expect(countsText({ counts: { fail: 1, registered: 2, ok: 0 } })).toBe('수집 실패 1 · 등록됨(판정 안 함) 2');
    expect(itemExtra({ kind: 'idrac', serviceTag: 'ABC', hasInventory: false })).toBe('ABC · 인벤토리 미수신');
    expect(itemExtra({ kind: 'vcenter', hosts: 3, vms: null })).toBe('호스트 3');
    expect(headerNote({ totals: { unassignedDevices: 2 }, edges: [{ registered: false }] })).toMatch('2대');
  });
  it('문구에 백틱 없음', () => {
    const all = [...LEGEND, ...Object.values(CHANNEL_LABEL), ...Object.values(ITEM_STATE_LABEL), ...Object.values(TONE_LABEL), ...Object.values(DEV_KIND_LABEL)];
    for (const s of all) expect(s.includes('`')).toBe(false);
  });
});

describe('reasonText', () => {
  it('사유 코드를 문장으로(객체를 그대로 내보내지 않는다)', async () => {
    const { reasonText } = await import('./deviceFlowText.js');
    expect(reasonText('pull-fail')).toMatch('export');
    expect(reasonText('not-registered')).toMatch('등록부에 없는');
    expect(reasonText('zzz')).toBe('zzz');
    expect(typeof reasonText('mock')).toBe('string');
  });
});

describe('v2.600 WEB2600-04 — 3단 지도 머리말', () => {
  it('인증 실패 칸은 등록부 밖 엣지로 세지 않고 따로 밝힌다', () => {
    const now = Date.UTC(2026, 8, 24, 2, 30, 0);
    const t = headerNote({ edges: [{ registered: true }], totals: {}, unauth: { count: 3, routes: [{}] } }, now);
    expect(t).toContain('인증에 실패한 요청 3건');
    expect(t).not.toContain('등록부에 없는 이름');
  });
});
