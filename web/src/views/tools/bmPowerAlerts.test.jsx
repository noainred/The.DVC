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
import { RULE_TEXT, RULES_HONEST } from './bmPerfOpsText.js';
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
