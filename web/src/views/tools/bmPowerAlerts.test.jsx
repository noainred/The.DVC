/**
 * 다음 점검 ②③ — 전력 알림 규칙 4종(문구 · 설정 칸) · 엣지 서버 PowerCap 표시(상태 이유 · ‘엣지 버전 낮음’ 은 old-version 일 때만).
 * ⚠ 판정은 서버(bmusage/powerAlerts.js · powerAgg.js) — 웹은 서버가 준 capState · capMinEdgeVersion 을 글로 바꾸기만.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as PT from './bmPowerText.js';
import { RULE_TEXT, RULES_HONEST, SENT_RESULT_TEXT } from './bmPerfOpsText.js';
import { PowerFleetView } from './BmPowerFleet.jsx';
import { NUM_SECTIONS, autoFocusOff } from './BmPerfRulesPanel.jsx';
import { POWER_RULE_IDS, RULE_CONDS, LIMITS, AUTOFOCUS_OFF } from '../../../../server/src/bmusage/perfRules.js';
import { CAP_STATES } from '../../../../server/src/bmusage/powerAgg.js';

const h = React.createElement;
const HERE = path.dirname(new URL(import.meta.url).pathname);

describe('전력 규칙 4종 — 문구 표 = 서버 열거 · 설정 칸', () => {
  it('규칙 · 조건 문구가 서버 목록과 1:1 · 백틱 없음', () => {
    for (const id of POWER_RULE_IDS) {
      expect(RULE_TEXT[id]?.label, id).toBeTruthy();
      expect(Object.keys(RULE_TEXT[id].conds).sort(), id).toEqual([...RULE_CONDS[id]].sort());
      for (const c of Object.values(RULE_TEXT[id].conds)) expect(c).not.toMatch(/`/);
    }
    expect(RULES_HONEST).toMatch(/전력 · 온도 규칙/); expect(RULES_HONEST).not.toMatch(/`|\*\*/);
    expect(RULES_HONEST).toMatch(/주기 자체가 오래 걸리는 것은 끊지 않습니다/); expect(RULES_HONEST).toMatch(/재발 억제는 그 기간 동안 남깁니다/);   // 반증 n2 2차 M1 · M2
  });
  it('전력 · 온도 절의 칸 = 서버 범위 키(피크 급증 기준 포함)', () => {
    const p = NUM_SECTIONS.find((x) => x.k === 'power');
    expect(p.fields.map(([k]) => k).sort()).toEqual(Object.keys(LIMITS.power).sort());
  });
  it('자동 집중 ‘해당 없음’ 은 서버 목록(응답 autoFocusOff) · 구버전 응답은 예전 두 개', () => {
    expect(autoFocusOff({ autoFocusOff: AUTOFOCUS_OFF })).toEqual(AUTOFOCUS_OFF);
    for (const id of POWER_RULE_IDS) expect(AUTOFOCUS_OFF).toContain(id);
    expect(autoFocusOff({})).toEqual(['focusEnd', 'collect']);
  });
});

describe('엣지 서버 PowerCap — 상태 이유', () => {
  it('상태 문구 = 서버 열거 · 값 없으면 — · ‘엣지 버전 낮음’ 은 old-version 일 때만', () => {
    expect(Object.keys(PT.CAP_STATE_TEXT).sort()).toEqual([...CAP_STATES].sort());
    expect(PT.capText({ capW: 500, capHit: true, capPct: 99 })).toBe('걸림(500 W · 99%)');
    expect(PT.capText({ capW: null, capState: 'old-version' }, {}, '2.950.0')).toBe('— 엣지 버전 낮음(v2.950.0 이상)');
    expect(PT.capText({ capW: null, capState: 'old-version' })).toBe('— 엣지 버전 낮음');
    for (const st of ['unread', 'stale', 'unset', null]) expect(PT.capText({ capW: null, capState: st }, {}, '2.950.0')).toBe('—');
    expect(PT.capTitle({ capW: null, capState: 'stale' })).toMatch(/2시간/);
    expect(PT.capTitle({ capW: 400, capState: 'set' })).toBeUndefined();
    expect(PT.POWER_HONEST.join(' ')).toMatch(/봉투에 싣는 서버별 상한/);
    expect(PT.POWER_HONEST.join(' ')).not.toMatch(/인벤토리 요약에 없어/);
  });
  it('그리기(SSR) — 구버전 엣지 안내 · 표 칸 · 다른 이유에는 버전을 붙이지 않는다', () => {
    const resp = { ok: true, fleet: { trend: [] }, corps: [], racks: [], bins: [], cfg: { inletWarnC: 27, capHitPct: 98 }, capOldEdge: 3, capMinEdgeVersion: '2.950.0',
      hot: [{ key: 'O1', name: 'bm-o1', vcenterId: 'vcO', inletC: 31, w: 300, capW: null, capState: 'old-version', fanRead: true },
        { key: 'S1', name: 'bm-s1', vcenterId: 'vcS', inletC: 30, w: 290, capW: null, capState: 'stale', fanRead: true },
        { key: 'E1', name: 'bm-e1', vcenterId: 'vcE', inletC: 29, w: 495, capW: 500, capHit: true, capPct: 99, capState: 'set', fanRead: true }] };
    const html = renderToStaticMarkup(h(PowerFleetView, { resp }));
    expect(html).toContain('엣지 위임 서버 3대의 PowerCap 은 확인할 수 없습니다'); expect(html).toContain('(엣지 v2.950.0 이상)');
    expect(html).toContain('— 엣지 버전 낮음(v2.950.0 이상)'); expect(html).toContain('걸림(500 W · 99%)');
    expect((html.match(/>— 엣지 버전 낮음/g) || []).length).toBe(1, 'old-version 행 하나만');
    expect(html).toMatch(/title="엣지가 읽은 지 2시간 넘음">—</);   // stale 행 — 칸은 ‘—’ · 이유는 마우스 설명(버전 이유 없음)
    expect(html).not.toMatch(/\*\*|`/);
    expect(renderToStaticMarkup(h(PowerFleetView, { resp: { ...resp, capOldEdge: undefined, capMinEdgeVersion: undefined, hot: [] } }))).not.toContain('확인할 수 없습니다');
  });
  it('웹은 걸림 · 낡음을 다시 판정하지 않는다(소스 스윕)', () => {
    const s = fs.readFileSync(path.join(HERE, 'bmPowerText.js'), 'utf8') + fs.readFileSync(path.join(HERE, 'BmPowerFleet.jsx'), 'utf8');
    expect(s).not.toMatch(/capHitPct\s*[<>*]|INV_FRESH|7_200_000|2 \* 3_600_000/);
  });
});

describe('반증 n2 — 시험 실행 · 지난 주기 상태 · 알림 판정 없음 · 목록 밖 배치 서버', () => {
  it('F3 시험 실행: 원천 실패 · 판정 보류를 ‘걸린 규칙 0건’ 과 가른다', async () => {
    const { DryRunResult, LastCycleLine } = await import('./BmPerfRulesPanel.jsx');
    const h1 = renderToStaticMarkup(h(DryRunResult, { resp: { servers: 0, fires: [], counts: { unknown: 0 }, powerError: 'idrac-power.db 열기 실패', note: 'n' } }));
    expect(h1).toContain('전력 · 온도 규칙을 대 보지 못했습니다'); expect(h1).toContain('idrac-power.db 열기 실패');
    const h2 = renderToStaticMarkup(h(DryRunResult, { resp: { servers: 2, powerItems: 3, fires: [], counts: { unknown: 5 }, note: 'n' } }));
    expect(h2).toContain('판정 보류 5건'); expect(h2).toContain('전력 판정 항목 3개');
    expect(renderToStaticMarkup(h(DryRunResult, { resp: { servers: 2, fires: [], counts: { unknown: 0 }, note: 'n' } }))).not.toMatch(/판정 보류|대 보지 못했습니다/);
    const l = renderToStaticMarkup(h(LastCycleLine, { last: { held: 4, powerError: '전력 원천 실패', powerItems: 7 } }));
    expect(l).toContain('지난 주기 전력 · 온도 규칙 입력 실패: 전력 원천 실패'); expect(l).toContain('지난 주기 판정 보류 4건'); expect(l).toContain('전력 판정 항목 7개');
    expect(renderToStaticMarkup(h(LastCycleLine, { last: { held: 0 } }))).toBe('');
    // 2차 M3 — 판정 노드 넘어감은 발송 기록이 아니라 지난 주기 상태(개수만) · 알림 이력 문구에서는 뺐다
    expect(renderToStaticMarkup(h(LastCycleLine, { last: { released: 240 } }))).toContain('지난 주기 판정 노드 넘어감 240건');
    expect(renderToStaticMarkup(h(LastCycleLine, { last: { released: 0 } }))).toBe('');
    expect(SENT_RESULT_TEXT['judge-moved']).toBeUndefined();
  });
  it('F4 알림 판정 없음 — 사유 문구 = 서버 열거 · 칸 아래 한 줄 · 요약', async () => {
    const { JUDGE_REASONS } = await import('../../../../server/src/bmusage/powerJudge.js');
    expect(Object.keys(PT.JUDGE_REASON_TEXT).sort()).toEqual([...JUDGE_REASONS].sort());
    expect(PT.judgeTitle({ judgeNode: null, judgeReason: 'source-central' })).toMatch(/엣지 대상이지만/);
    expect(PT.judgeTitle({ judgeNode: 'n', judgeReason: null })).toBeUndefined();
    expect(PT.noJudgeText({ servers: 2, racks: 1, byReason: { 'source-central': 1, 'source-edge': 1 } })).toMatch(/알림 판정 노드가 없는 서버 2대 · 상한 랙 1개\(원천 중앙 1 · 원천 엣지 사본 1\)/);
    expect(PT.noJudgeText({ servers: 0, racks: 0 })).toBe('');
    // 재확인 N4 · N5 — 모름은 없음 합계와 따로 · 구버전 엣지는 없음
    expect(PT.noJudgeText({ servers: 1, racks: 0, byReason: { 'edge-old': 1 }, unknown: 2, unknownRacks: 1 })).toMatch(/서버 1대 · 상한 랙 0개\(엣지 버전 낮음 1\).*판정 여부 모름 — 서버 2대 · 상한 랙 1개/);
    expect(PT.noJudgeText({ servers: 0, racks: 0, unknown: 1 })).toMatch(/^판정 여부 모름/);
    expect(PT.noJudgeLabel({ judgeReason: 'judge-unknown' })).toBe('알림 판정 모름'); expect(PT.noJudgeLabel({ judgeReason: 'edge-old' })).toBe('알림 판정 없음');
    const resp = { ok: true, fleet: { trend: [], noJudge: { servers: 1, racks: 1, byReason: { 'source-central': 1 } } }, corps: [], bins: [], cfg: {},
      racks: [{ vcenterId: 'vcX', rack: 'X-1', servers: 3, measured: 2, notTarget: 1, capKw: 5, marginPct: null, marginPartial: true, judgeNode: null, judgeReason: 'member-unknown' }],
      hot: [{ key: 'XT3', name: 'bm-x3', vcenterId: 'vcX', inletC: 30, w: 495, capW: 500, capHit: true, capPct: 99, capState: 'set', fanRead: true, judgeNode: null, judgeReason: 'source-central' }] };
    const html = renderToStaticMarkup(h(PowerFleetView, { resp }));
    expect(html).toContain('알림 판정 노드가 없는 서버 1대'); expect((html.match(/>알림 판정 없음</g) || []).length).toBe(2);
    expect(html).toContain('일부만 측정(2/3)');
  });
  it('F1 미측정 사유 — 대상 목록에 없음 · 판정 노드 아님(서버 열거와 1:1)', () => {
    expect(PT.UNMEASURED_TEXT['not-target']).toBe('대상 목록에 없음'); expect(PT.unmeasuredText({ 'not-target': 1 })).toBe('대상 목록에 없음 1');
  });
});
