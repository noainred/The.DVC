/**
 * 베어메탈 사용률 점검 반복 2회차(기준판 68b220406) — 화면 · 보드 확정 8건 + 개선 3건을 재현한 입력으로 고정한다(웹 쪽).
 *   E1 수집 설정 카드 읽기 전용 · E2 쓰기 버튼(서버 표지 actions · 행/열 writable) · E3 PowerCap 꺼짐 = 해당 없음 · E4 사용률 색 = 설정값 ·
 *   E5 400 보기 탭 줄바꿈 · E6 범위 계정 비교 안내 · E7 저활용 편집 상태 = 행 식별 · E8 404 상세 머리 · I1 창 문구 날짜 · I2 피크 창 상한 · I3 예측 색.
 *   서버 쪽(표지 판정 = 실제 라우트 · PowerCap 판정 하나 · 캐시 열쇠)은 server/test/bmUsageLoop2.test.js.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WRITE_WHY_TEXT, gateOk, gateShown, gateWhy, gateTitle, settingsReadOnlyText } from './bmWriteText.js';
import { usageTone, bmUtilThresholds, corpSummary } from './bmUsageText.js';
import { columnStateView, focusBlockText, OTHER_CORP_SCOPED_NOTE } from './bmCompareText.js';
import { statusTone } from './bmCapacityText.js';
import { idleRowId } from './bmIdleText.js';
import * as P from './bmPerfText.js';
import { peakSrcText } from './bmTrendText.js';
import { windowRangeText } from '../../components/vmperf/vmPerfText.js';
import { IdleFleetView } from './BmIdleFleet.jsx';
import { CapacityFleetView } from './BmCapacityFleet.jsx';
import { BmPerfDetailView } from './BmPerfDetail.jsx';

const h = React.createElement;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const src = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');
const SERVER_GATE = fs.readFileSync(path.join(HERE, '../../../../server/src/routes/api/bmWriteGate.js'), 'utf8');

describe('E1 · E2 쓰기 표지 문구(서버 bmWriteGate 와 1:1)', () => {
  it('이유 code — 서버 WRITE_WHY 와 같은 집합 · 백틱 없음', () => {
    const m = /export const WRITE_WHY = Object\.freeze\(\[([^\]]+)\]\)/.exec(SERVER_GATE);
    const server = m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean).sort();
    expect(Object.keys(WRITE_WHY_TEXT).sort()).toEqual(server);
    for (const v of Object.values(WRITE_WHY_TEXT)) expect(v.includes('`')).toBe(false);
  });
  it('표지가 없으면 닫는다(조회 실패 상태로 열지 않는다) · 역할 이유면 그리지 않는다 · 범위 · 데모면 잠근 채 이유', () => {
    expect(gateOk(undefined)).toBe(false); expect(gateOk({ ok: true })).toBe(true);
    expect(gateShown(null)).toBe(false);
    expect(gateShown({ ok: false, why: 'role-operator' })).toBe(false);
    expect(gateShown({ ok: false, why: 'full-scope' })).toBe(true);
    expect(gateShown({ ok: false, why: 'demo' })).toBe(true);
    expect(gateWhy({ ok: false, why: 'full-scope' })).toMatch(/전체 범위/);
    expect(gateWhy({ ok: false, why: 'nope' })).toBe('');   // 모르는 이유는 지어내지 않는다
    expect(gateTitle({ ok: true }, 'x')).toBeUndefined();
    expect(gateTitle({ ok: false, why: 'demo' }, '지금 가져오기')).toMatch(/^지금 가져오기 — 데모 계정/);
  });
  it('E1 수집 설정 카드 — 관리자가 아니면 읽기 전용 한 줄(알림 규칙 패널과 같은 표현) · 데모는 데모 문구', () => {
    expect(settingsReadOnlyText({ ok: true })).toBe('');
    expect(settingsReadOnlyText({ ok: false, why: 'role-admin' })).toMatch(/^읽기 전용 — 저장은 관리자\(admin\)만/);
    expect(settingsReadOnlyText({ ok: false, why: 'demo' })).toMatch(/데모 계정/);
    expect(settingsReadOnlyText(undefined)).toMatch(/^읽기 전용/);
  });
  it('E1 화면 조립 — 입력 잠금(dl)에 저장 표지 · Enterprise 칸도 잠금 · 403 은 ErrorBox(원문 forbidden 아님)', () => {
    const s = src('BmUsage.jsx');
    expect(s).toMatch(/const dl = saving \|\| !!data\?\.central\?\.managed \|\| !canSet;/);
    expect(s).toMatch(/setGate = data\?\.actions\?\.settings/);
    expect(s).toMatch(/disabled=\{saving \|\| !canSet\} \/>\s*\{' '\}대체 수집 켜기/);
    expect(s).toMatch(/e\?\.status === 403 \? \{ tone: 'bad', err: e \}/);
    expect(s).toMatch(/msg\.err \? <ErrorBox error=\{msg\.err\} \/>/);
    // E2①: 지금 수집 · 엣지 지금 가져오기는 서버 표지로 잠근다
    expect(s).toMatch(/disabled=\{busy \|\| !data\?\.enabled \|\| !gateOk\(collectGate\)\}/);
    expect(s).toMatch(/!r\.hasUrl \|\| !gateOk\(pullGate\)\}/);
  });
});

describe('E2 저활용 · 용량 · 비교 · 주석 — 서버 표지대로 버튼', () => {
  const idleResp = (actions, rows) => ({ ok: true, rows, summary: {}, sources: [], cfg: { windowDays: 30 }, actions });
  const row = (o) => ({ key: 'K1', name: 'bm-1', vcenterId: 'vcA', node: 'central', status: 'candidate', score: 80, metrics: {}, ...o });
  it('④ 검토 상태 — 쓰기 범위 행만 버튼 · 조회 전용 법인 행은 표지 · 역할이 모자라면 아무것도 · ③ 다시 계산은 범위 계정에 잠금', () => {
    const rows = [row({ writable: true }), row({ key: 'K2', name: 'bm-2', vcenterId: 'vcB', writable: false })];
    const html = renderToStaticMarkup(h(IdleFleetView, { resp: idleResp({ review: { ok: true }, recompute: { ok: false, why: 'full-scope' } }, rows) }));
    expect(html.match(/검토 상태…/g)).toHaveLength(1);
    expect(html).toContain('조회 전용 법인');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="이 노드 다시 계산 — 전체 범위[^"]*"[^>]*>이 노드 다시 계산<\/button>/);
    const vw = renderToStaticMarkup(h(IdleFleetView, { resp: idleResp({ review: { ok: false, why: 'role-operator' }, recompute: { ok: false, why: 'role-operator' } }, rows) }));
    expect(vw).not.toContain('검토 상태…'); expect(vw).not.toContain('이 노드 다시 계산'); expect(vw).not.toContain('조회 전용 법인');
    // 귀속 없는 행(전체 범위 계정 — 검토 쓰기는 법인을 요구해 거절된다)은 ‘조회 전용’ 이 아니라 귀속 없음
    const nc = renderToStaticMarkup(h(IdleFleetView, { resp: idleResp({ review: { ok: true }, recompute: { ok: true } }, [row({ vcenterId: '', writable: false })]) }));
    expect(nc).toContain('귀속 없음 — 검토 불가'); expect(nc).not.toContain('조회 전용 법인');
    const demo = renderToStaticMarkup(h(IdleFleetView, { resp: idleResp({ review: { ok: false, why: 'demo' }, recompute: { ok: false, why: 'demo' } }, rows) }));
    expect(demo).not.toContain('검토 상태…'); expect(demo).toMatch(/검토 상태 바꾸기 — 데모 계정/);
    const none = renderToStaticMarkup(h(IdleFleetView, { resp: idleResp(undefined, rows) }));   // 표지 없음(옛 서버 · 실패) — 열지 않는다
    expect(none).not.toContain('검토 상태…');
  });
  it('E7 편집 상태 열쇠 = 행 식별(노드 · 법인 · 키) — 같은 키 · 다른 법인 두 행이 다른 값', () => {
    const a = row({}); const b = row({ vcenterId: 'vcB', node: 'edge-pl' });
    expect(idleRowId(a)).not.toBe(idleRowId(b));
    const s = src('BmIdleFleet.jsx');
    expect(s).toMatch(/editing === idleRowId\(r\)/); expect(s).toMatch(/setEditing\(idleRowId\(r\)\)/);
    expect(s).not.toMatch(/editing === r\.key|setEditing\(r\.key\)/);
  });
  it('② 용량 — 다시 계산은 표지 · I3 예측 색은 임박(≤ cfg.alertDays)만 주의 · 1년 넘음은 중립', () => {
    const resp = { ok: true, cfg: { targetPct: 90, alertDays: 7 }, summary: {}, sources: [], actions: { recompute: { ok: false, why: 'full-scope' } },
      rows: [{ key: 'K1', name: 'near', vcenterId: 'vcA', kind: 'fs', res: '/a', status: 'forecast', daysToTarget: 3 },
        { key: 'K2', name: 'far', vcenterId: 'vcA', kind: 'fs', res: '/b', status: 'forecast', daysToTarget: null, beyondTarget: true }] };
    const html = renderToStaticMarkup(h(CapacityFleetView, { resp }));
    expect(html).toMatch(/disabled=""[^>]*>이 노드 다시 계산/);
    expect(statusTone(resp.rows[0], resp.cfg)).toBe('warn');
    expect(statusTone(resp.rows[1], resp.cfg)).toBe('idle');
    expect(statusTone({ status: 'forecast', daysToTarget: 30 }, resp.cfg)).toBe('idle');
    expect(statusTone({ status: 'forecast', daysToTarget: 3 }, {})).toBe('idle');   // 기준을 모르면 단정하지 않는다
    expect(statusTone({ status: 'reached' }, resp.cfg)).toBe('bad');
    const ok = renderToStaticMarkup(h(CapacityFleetView, { resp: { ...resp, actions: { recompute: { ok: true } } } }));
    expect(ok).not.toMatch(/disabled=""[^>]*>이 노드 다시 계산/);
  });
  it('⑥ 비교 동시 집중 — 표지 · 열 writable 중 하나라도 조회 전용이면 막는 이유 한 줄 · E6 범위 계정 안내', () => {
    expect(focusBlockText({ ok: true }, [{ writable: true }])).toBe('');
    expect(focusBlockText({ ok: true }, [{ writable: true }, { writable: false }])).toMatch(/1대가 조회 전용 법인/);
    expect(focusBlockText({ ok: true }, [{}])).toMatch(/조회 전용/);   // 표지 없는 열은 열지 않는다
    expect(focusBlockText({ ok: false, why: 'demo' }, [{ writable: true }], gateWhy({ ok: false, why: 'demo' }))).toMatch(/데모 계정/);
    expect(columnStateView('other-corp', { crossAllowed: false }).note).toBe(OTHER_CORP_SCOPED_NOTE);
    expect(OTHER_CORP_SCOPED_NOTE).not.toMatch(/‘법인 간 허용’ 으로 바꾸면/);
    expect(columnStateView('other-corp', { crossAllowed: true }).note).toMatch(/‘법인 간 허용’ 으로 바꾸면/);
    const s = src('BmCompareView.jsx');
    expect(s).not.toMatch(/hasRole\(/);   // 역할만 보던 canWrite 를 서버 표지로 바꿨다
    expect(s).toMatch(/crossAllowed: resp\?\.crossAllowed/);
  });
  it('⑤ 주석 추가 — 서버 표지(actions.create)로만 · 같은 서버면 창이 바뀌어도 표지 유지 · 다른 서버로 바뀌면 비운다', () => {
    const s = src('BmAnnotations.jsx');
    expect(s).toMatch(/const canWrite = gateOk\(cg\);/);
    expect(s).not.toMatch(/hasRole\(/);
    expect(s).toMatch(/actions: p\.who === who \? p\.actions : null/);
    expect(src('BmTrendTab.jsx')).toMatch(/actions=\{ann\.actions\}/);
  });
});

describe('E3 · E4 · E5 · E8 · I1 · I2', () => {
  it('E3 PowerCap 꺼짐 — 하드웨어 표 ‘상한 꺼짐’ · 근거 ‘PowerCap 꺼짐’ · 각주 ‘해당 없음’(PSI 근거는 그대로)', () => {
    const rows = P.hwFactRows({ power: { watts: 415, capWatts: null, capPct: null, capState: 'unset' } }, { now: 1 });
    expect(rows[0].text).toBe('415W · 상한 꺼짐(PowerCap 0 · 빈 값)');
    expect(P.hwFactRows({ power: { watts: 415, capWatts: null, capPct: null } }, { now: 1 })[0].text).toBe('415W · cap 정보 없음');   // 모를 때는 예전 그대로
    expect(P.basisText({ key: 'power_cap_pct', label: '전력 cap 대비', value: null, code: 'none' })).toBe('전력 cap 대비 —(PowerCap 꺼짐 — 상한 0 · 빈 값)');
    expect(P.basisText({ key: 'power_cap_pct', label: '전력 cap 대비', value: null, code: 'missing' })).toBe('전력 cap 대비 —(못 읽음)');
    expect(P.basisText({ key: 'psi_cpu_some10', label: 'PSI cpu some', value: null, code: 'none' })).toBe('PSI cpu some —(그 커널에 없음)');
    expect(P.cellView('none').title).toBe('해당 없음');
    expect(P.CELL_FOOTNOTE.none).toMatch(/PowerCap/);
  });
  it('E4 사용률 색 — 응답 설정값(utilWarn · utilBad)으로 · 기본은 예전 75/90(CorpUsage 그대로) · 초과 대수도 같은 기준', () => {
    const th = bmUtilThresholds({ perfThresholds: { utilWarn: 80, utilBad: 90 } });
    expect(th).toEqual({ warn: 80, bad: 90 });
    expect(usageTone(77.4, th)).toBe('ok');      // 재현: USE 정상인데 사용률 표가 주의였다
    expect(usageTone(77.4)).toBe('warn');        // 기본(CorpUsage) 동작은 그대로
    expect(usageTone(85, { warn: 80, bad: 85 })).toBe('bad');
    expect(bmUtilThresholds({ perfThresholds: { utilWarn: '' }, perfDefaults: { utilWarn: 80, utilBad: 90 } })).toEqual({ warn: 80, bad: 90 });
    expect(bmUtilThresholds({})).toBeNull();
    const c = corpSummary([{ vcenterId: 'a', cpu_pct: 86 }, { vcenterId: 'a', cpu_pct: 91 }], { metric: 'cpu_pct', bad: 85 });
    expect(c[0].overBad).toBe(2);
    expect(src('BmUsage.jsx')).toMatch(/\{uth\?\.bad \?\? 90\}%↑/);
  });
  it('E5 400 — 보기 탭(10개)은 상세 탭과 같은 줄바꿈 규칙(한 줄 4개)', () => {
    const css = fs.readFileSync(path.join(HERE, '../../styles.css'), 'utf8');
    const i = css.indexOf('.bmp-seg.bmp-seg-top button { flex: 1 1 calc(25% - 1px);');
    expect(i).toBeGreaterThan(0);
    expect(css.slice(css.lastIndexOf('@media', i), i)).toMatch(/^@media \(max-width: 640px\) \{/);   // 좁은 폭에서만(1440 은 그대로)
  });
  it('E8 찾지 못한(404) 서버 — 법인을 단정하지 않는다(‘—’) · 비교에 추가 잠금 · 담겨 있으면 빼기는 열림', () => {
    const err = Object.assign(new Error('대상 서버를 찾지 못했습니다.'), { status: 404, body: { code: 'not-found' } });
    const html = renderToStaticMarkup(h(BmPerfDetailView, { itemKey: 'M169OMN', err, onCompareToggle: () => {}, now: 1 }));
    expect(html).not.toContain('귀속 없음');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>비교에 추가<\/button>/);
    const inCmp = renderToStaticMarkup(h(BmPerfDetailView, { itemKey: 'M169OMN', err, inCompare: true, onCompareToggle: () => {}, now: 1 }));
    expect(inCmp).toMatch(/<button[^>]*aria-pressed="true"[^>]*>비교에서 빼기<\/button>/);
    expect(inCmp).not.toMatch(/disabled=""[^>]*>비교에서 빼기/);
    // 아는 서버(목록 항목)의 귀속 없음은 그대로 말한다
    const known = renderToStaticMarkup(h(BmPerfDetailView, { itemKey: 'K', item: { key: 'K', target: { vcenterId: '' } }, onCompareToggle: () => {}, now: 1 }));
    expect(known).toContain('귀속 없음');
  });
  it('I1 창 문구 — 날짜를 붙인 공용 코어(24시간 창 시작 · 끝이 같은 시:분이어도 다른 글자)', () => {
    const to = Date.UTC(2026, 10, 15, 1, 24); const from = to - 86_400_000;
    const w = windowRangeText(from, to);
    const [a, b] = w.split(' ~ ');
    expect(a).not.toBe(b);
    expect(src('BmTrendTab.jsx')).toMatch(/\$\{windowRangeText\(win\.from, win\.to\)\} · 서버가 창/);
  });
  it('I2 피크 창 ‘줄었다’ — 응답 설정 상한과 견준다(기본값 10 하드코드 아님)', () => {
    expect(peakSrcText(['window10'], 5, 5)).not.toMatch(/줄/);
    expect(peakSrcText(['window10'], 12, 20)).toContain('설정 20초에서 줄어듦');
    expect(peakSrcText(['window10'], 5, null)).not.toMatch(/줄/);
    expect(src('bmTrendText.js')).not.toMatch(/w < 10/);
    expect(src('BmTrendTab.jsx')).toMatch(/devs\.data\?\.peakWindowCapS/);
  });
});
