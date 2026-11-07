/**
 * 리눅스 성능 8a단계 — 정비 창 · 용량 소진 예측 화면(문구 · 그리기) 회귀.
 * ⚠ 판정은 서버(bmusage/maint · capacity) — 여기서는 ① 웹 문구 표 = 서버 열거(1:1) ② 폼 본문이 서버 정규화를 그대로 통과(같은 계약)
 *   ③ 못 읽음 · 데이터 부족 · 불안정을 0 · ‘안전’ 으로 그리지 않는다 ④ 서버가 준 값만 그린다(SSR) ⑤ 웹이 시간대 · 일정 · 예측을 다시 계산하지 않고 폴링하지 않는다(소스 스윕).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as MT from './bmMaintText.js';
import * as CT from './bmCapacityText.js';
import { MaintForm } from './BmMaintPanel.jsx';
import { CapacityFleetView, CapacityChart } from './BmCapacityFleet.jsx';
import { maintRowText, maintLeakCell } from './bmCollectText.js';
import { SCOPES } from '../../../../server/src/bmusage/maint/judge.js';
import { normalizeWindow } from '../../../../server/src/bmusage/maint/store.js';
import { CAP_STATUS, CAP_REASONS, CAP_KINDS } from '../../../../server/src/bmusage/capacity.js';
import { RULE_IDS, RULE_CONDS } from '../../../../server/src/bmusage/perfRules.js';
import { RULE_TEXT, FOCUS_CODE_TEXT } from './bmPerfOpsText.js';
import { sloMaintText } from './bmRunbookText.js';
import { capacityKpi } from './bmCapacityText.js';

const h = React.createElement;
const HERE = path.dirname(new URL(import.meta.url).pathname);

describe('정비 창 문구 · 계약', () => {
  it('① 억제 범위 · 대상 · 상태 문구 = 서버 열거', () => {
    expect([...MT.SCOPE_ORDER].sort()).toEqual([...SCOPES].sort());
    for (const s of SCOPES) expect(MT.SCOPE_TEXT[s].label).toBeTruthy();
    for (const st of ['active', 'scheduled', 'ended', 'expired', 'deleted']) expect(MT.STATUS_TEXT[st]).toBeTruthy();
    expect(Object.keys(RULE_TEXT).sort()).toEqual([...RULE_IDS].sort());
    expect(Object.keys(RULE_TEXT.capacity.conds).sort()).toEqual([...RULE_CONDS.capacity].sort());
    expect(FOCUS_CODE_TEXT.maintenance.text).toMatch(/수동 집중/);
  });
  it('② 폼 → 본문이 서버 정규화를 그대로 통과한다(같은 계약) · 빈 폼 기본 억제 = ①②③⑤', () => {
    const f = { ...MT.emptyForm({ corp: 'vcA' }), name: '패치', reason: '월간', kind: 'corp', sched: 'monthly', nth: 2, weekday: 6, time: '02:00', durMin: 240 };
    expect(f.scopes).toEqual({ alerts: true, hold: true, focus: true, collect: false, exclude: true });
    const b = MT.formToBody(f);
    const w = normalizeWindow(b, { strict: true });
    expect(w.target).toEqual({ kind: 'corp' }); expect(w.vcenterId).toBe('vcA');
    expect(w.scopes).toEqual({ alerts: true, hold: true, focus: true, exclude: true });
    expect(w.schedule).toEqual({ kind: 'monthly', nth: 2, weekday: 6, time: '02:00', durMin: 240 });
    const fs1 = MT.formToBody({ ...f, kind: 'server', keys: 'ABC1, ABC2  ABC1', sched: 'weekly', days: [0, 6] });
    expect(fs1.target.keys).toEqual(['ABC1', 'ABC2', 'ABC1']);
    expect(normalizeWindow({ ...fs1, vcenterId: 'vcA' }, { strict: true }).target.keys).toEqual(['ABC1', 'ABC2']);
    // 고치기 왕복
    const back = MT.windowToForm({ ...w, scopes: Object.keys(w.scopes) });
    expect(back.scopes.collect).toBe(false); expect(back.nth).toBe(2);
    // 반증 F1 — 서버 창의 법인(고르면 그 법인 안에서 키를 찾는다 · 고르지 않으면 보내지 않는다 — 서버가 모호하면 400)
    expect(MT.formToBody({ ...f, kind: 'server', keys: 'K1' }).vcenterId).toBeUndefined();
    expect(MT.formToBody({ ...f, kind: 'server', keys: 'K1', serverCorp: 'vcB' }).vcenterId).toBe('vcB');
    expect(MT.windowToForm({ ...w, target: { kind: 'server', keys: ['K1'] }, vcenterId: 'vcB', scopes: [] }).serverCorp).toBe('vcB');
    expect(MT.emptyForm({ corp: 'vcA' }).serverCorp).toBe('', '새 서버 창은 법인 자동(첫 법인으로 굳히지 않는다)');
  });
  it('②-b 반증 문구 — 합 규칙 승인 안내 · 점검이 잡는 것과 못 잡는 것', () => {
    expect(MT.approvalNote({ ownerOverMin: 720 })).toMatch(/같은 서버를 덮는 창들.*합이 어느 24시간에서든 12시간을 넘으면/);
    expect(MT.leakText({ n: 0, last: 3 }).text).toMatch(/못 잡는 것: 판정 규칙 자체/);
    expect(MT.leakText({ n: 1 }).text).toMatch(/창 끝 · 길이 상한 · 지움 · 끝내기 · 재확인 만료 · 배포본 시한/);
    const html = renderToStaticMarkup(h(MaintForm, { form: MT.emptyForm({ corp: 'vcA' }), setForm: () => {}, vcenters: [{ id: 'vcA', name: 'KR-SEL' }, { id: 'vcB', name: 'US-B' }], limits: { ownerOverMin: 720 } }));
    expect(html).toContain('자동 — 키로 찾기'); expect(html).toContain('US-B');
  });
  it('③ 일정 · 상태 · 계수 · 점검 문구 — 값이 없으면 지어내지 않는다', () => {
    expect(MT.scheduleText({ schedule: { kind: 'once', start: '2026-11-07T22:00', end: '2026-11-08T00:00' } })).toBe('2026-11-07 22:00 ~ 2026-11-08 00:00 (일회)');
    expect(MT.scheduleText({ schedule: { kind: 'once', start: '2026-11-07T00:05', end: '2026-11-07T02:00' } })).toBe('2026-11-07 00:05 ~ 02:00 (일회)');
    expect(MT.scheduleText({ schedule: { kind: 'monthly', nth: 2, weekday: 6, time: '02:00', durMin: 240 } })).toBe('매월 둘째 토 02:00 · 4시간 (반복)');
    expect(MT.scheduleText({ schedule: { kind: 'weekly', days: [0, 6], time: '01:30', durMin: 90 } })).toBe('매주 일·토 01:30 · 1시간 30분 (반복)');
    expect(MT.statusLine({ status: 'active', remainingMs: 95 * 60_000 })).toBe('진행 중 · 남은 1:35');
    expect(MT.countsText(null)).toBe('');
    expect(MT.countsText({ alerts: 212, after: 3 })).toBe('억제 알림 212 · 창 뒤 발송 3');
    expect(MT.leakText(null).tone).toBe('idle');
    expect(MT.leakText({ n: 0, last: 4 }).tone).toBe('ok');
    expect(MT.leakText({ n: 2 }).tone).toBe('bad');
    expect(MT.limitsNote({})).toMatch(/—/);
    expect(MT.maintHonest({ deployTtlMs: 86_400_000 })).toMatch(/24시간/);
    expect(maintLeakCell(null).text).toBe('—');
    expect(maintLeakCell({ maint: { leak: 0, checked: 3 } }).tone).toBe('ok');
    expect(maintLeakCell({ maint: { judge: 'unavailable' } }).tone).toBe('warn');
    expect(maintRowText({ maintSkipped: 2, maintFail: 0 })).toBe('정비 중 건너뜀 2(성공률 분모 밖)');
    expect(maintRowText({ maintSkipped: null })).toBe('');
  });
  it('③-b 목표선 ‘정비 창’ 칸 · 보드 KPI — 서버 값 그대로(못 만들면 판정 불가 · 계산 전 ‘—’)', () => {
    expect(sloMaintText({ maintenance: { source: 'windows', excluded: 6 } }, { maintenanceSource: 'windows' })).toBe('제외 6');
    expect(sloMaintText({ maintenance: { source: 'none' } }, { maintenanceSource: 'windows' })).toBe('창 없음');
    expect(sloMaintText({}, { maintenanceSource: 'unavailable' })).toBe('판정 불가');
    expect(sloMaintText({ maintenance: { source: 'none' } }, {})).toBe('원천 없음');
    expect(capacityKpi({ ok: true, sources: [{ none: true }], summary: { month: 0 } }).value).toBe('—');
    expect(capacityKpi({ ok: true, sources: [{ day: '2026-11-06' }], summary: { month: 3, soon: 1 }, cfg: { alertDays: 7 } })).toEqual({ value: 3, meta: '7일 안 1 · 불안정 — · 부족 —', soon: 1 });
    expect(capacityKpi(null).value).toBe('—');
  });
  it('④ 음영 · 변경 이벤트 묶음(서버 merged 그대로)', () => {
    const resp = { ok: true, items: [{ id: 'mw-a', name: 'OS 업그레이드' }], merged: [{ from: 100, to: 200, ids: ['mw-a'] }, { from: 300, to: 300, ids: [] }] };
    const b = MT.maintBands(resp);
    expect(b).toEqual([{ from: 100, to: 200, title: '정비 창 — OS 업그레이드' }]);
    expect(MT.maintBands({ ok: false })).toEqual([]);
    const sp = MT.splitByMaint([{ ts: 50 }, { ts: 150 }, { ts: 200 }], b);
    expect(sp.inside.map((x) => x.ts)).toEqual([150]); expect(sp.outside.map((x) => x.ts)).toEqual([50, 200]);
  });
  it('⑤ 폼 SSR — 억제 5종 · 승인 안내(API 값) · 미리보기 DST 표지', () => {
    const html = renderToStaticMarkup(h(MaintForm, { form: MT.emptyForm({ corp: 'vcA' }), setForm: () => {}, vcenters: [{ id: 'vcA', name: 'KR-SEL' }], limits: { ownerOverMin: 720, onceMaxMin: 1440, recurMaxMin: 720, keysMax: 20, confirmDays: 92 },
      preview: { ok: true, tz: 'Europe/Warsaw', durationMin: 60, next: [{ start: 1, end: 2, startLocal: '2027-03-28 03:30', endLocal: '2027-03-28 04:30', dstShift: true }] } }));
    for (const s of SCOPES) expect(html).toContain(MT.SCOPE_TEXT[s].label);
    expect(html).toContain('12시간 넘는 창은 설정 소유자 등급');
    expect(html).toContain('서머타임으로 없는 시각');
    expect(html).not.toMatch(/`/);
  });
});

describe('용량 예측 문구 · 그리기', () => {
  it('① 상태 · 사유 · 종류 문구 = 서버 열거', () => {
    expect(Object.keys(CT.STATUS_TEXT).sort()).toEqual([...CAP_STATUS].sort());
    expect(Object.keys(CT.REASON_TEXT).sort()).toEqual([...CAP_REASONS].sort());
    expect(Object.keys(CT.KIND_TEXT).sort()).toEqual([...CAP_KINDS].sort());
  });
  it('② 못 읽음은 0 · 안전이 아니다 — 데이터 부족 · 불안정 · 증가 없음 · 상한 없음', () => {
    expect(CT.daysText({ status: 'insufficient', n: 4 })).toBe('데이터 부족');
    expect(CT.daysText({ status: 'unstable', r2: 0.31 })).toBe('불안정 · 예측 안 함');
    expect(CT.daysText({ status: 'no-growth' })).toBe('증가 없음');
    expect(CT.daysText({ status: 'no-limit' })).toBe('상한 없음');
    expect(CT.slopeText({ status: 'unstable', slope: 2 })).toBe('—');
    expect(CT.confText({ status: 'insufficient', n: 4 })).toBe('표본 4일');
    expect(CT.confText({ status: 'unstable', r2: 0.31 })).toBe('R² .31');
    expect(CT.daysText({ status: 'forecast', daysToTarget: 3, dateToTarget: '2026-11-09' })).toBe('3일 (11-09)');
    expect(CT.daysText({ status: 'reached', daysToTarget: 0 })).toBe('도달');
    expect(CT.daysText({ status: 'forecast', daysToTarget: null, beyondTarget: true })).toBe('1년 넘음');
    expect(CT.confText({ status: 'forecast', conf: 'high', r2: 0.94 })).toBe('높음 R² .94');
    expect(CT.pctText(null)).toBe('—');
    expect(CT.noteText({ kind: 'mem', grade: 'ref', reset: true, resetDay: '2026-10-28', excluded: 2 })).toMatch(/리셋형 — 10-28 뒤부터 창 · 정비 창 2일 제외 · 참고 등급/);
    expect(CT.sourceText({ via: 'edge', node: 'e1', old: true }, '2.950.0')).toMatch(/구버전.*v2\.950\.0/);
    expect(CT.sourceText({ via: 'edge', node: 'e1', none: true }, null, { recomputeAfterMin: 70 })).toMatch(/01:10 뒤/);
  });
  it('②-b 반증 F2 · F3 · F4 · F11 문구 — 도달(추세 불가) 기울기 없음 · 일상 몫 · 오래된 관측 · 상한 서버 수', () => {
    expect(CT.slopeText({ status: 'reached', slope: 0.3, conf: null })).toBe('—');
    expect(CT.slopeText({ status: 'reached', slope: 0.3, conf: 'high' })).toBe('+0.3%p');
    expect(CT.noteText({ kind: 'fs', dailyWin: 120 })).toMatch(/하루 약 120분.*그보다 더 덮인 날만 뺌/);
    expect(CT.currentText({ current: 85, stale: true, staleDays: 5 })).toBe('85% (5일 전)');
    expect(CT.currentText({ current: null, stale: true, staleDays: 5 })).toBe('—');
    expect(CT.sourceText({ via: 'local', day: '2026-11-08', truncated: true, cap: { skippedServers: 0, trimmedServers: 12, trimmedMounts: 40 } })).toMatch(/마운트 일부만 12대\(급한 마운트부터 · 40개 뺌\)/);
    expect(CT.sourceText({ via: 'local', day: '2026-11-08', truncated: true })).toMatch(/일부만\(상한\)/);
  });
  it('③ 함대 표 SSR — 서버 행 그대로 · 데이터 부족 행에 0일 없음 · 요약은 서버 수', () => {
    const resp = { ok: true, cfg: { targetPct: 90, alertDays: 7 }, summary: { servers: 3, soon: 1, month: 2, unstable: 1, insufficient: 1, soonByKind: { fs: 1, inode: 0, mem: 0 }, monthByKind: { fs: 2, inode: 0, mem: 0 } },
      sources: [{ node: 'c', via: 'local', day: '2026-11-06' }, { node: 'e1', via: 'edge', old: true }],
      rows: [{ key: 'K1', name: 'gp04', vcenterId: 'vcA', kind: 'fs', res: '/data1', status: 'forecast', current: 87.2, slope: 0.9, daysToTarget: 3, dateToTarget: '2026-11-09', daysTo100: 14, dateTo100: '2026-11-20', conf: 'high', r2: 0.94 },
        { key: 'K2', name: 'new03', vcenterId: 'vcA', kind: 'fs', res: '/', status: 'insufficient', current: 22, n: 4, reason: 'few-days' }] };
    const html = renderToStaticMarkup(h(CapacityFleetView, { resp }));
    expect(html).toContain('3일 (11-09)'); expect(html).toContain('높음 R² .94'); expect(html).toContain('데이터 부족');
    expect(html).not.toMatch(/>0일</);
    expect(html).toContain('1대'); expect(html).toContain('구버전');
  });
  it('④ 상세 그림 — 결측 · 정비 창 날은 선을 끊는다 · 맞춤선 연장', () => {
    const s = [{ day: '2026-11-01', v: 80 }, { day: '2026-11-02', v: null }, { day: '2026-11-03', v: 82, ex: true }, { day: '2026-11-04', v: 83 }];
    const c = CT.capChart(s, { slope: 1, intercept: 80 - 20393, fromDay: '2026-11-01' }, { today: '2026-11-04', targetPct: 90 });
    expect(c.line.split('M').length - 1).toBe(2, '두 토막(결측 · 제외에서 끊김)');
    expect(c.fit).toMatch(/^M/); expect(c.exX.length).toBe(1);
    expect(CT.capChart([], null).line).toBe('');
    expect(renderToStaticMarkup(h(CapacityChart, { series: [] }))).toMatch(/0 으로 그리지 않습니다/);
  });
});

describe('소스 스윕 — 판정 복제 · 폴링 없음', () => {
  it('웹은 시간대 · 일정 · 회귀를 계산하지 않고 폴링하지 않는다', () => {
    for (const f of ['bmMaintText.js', 'BmMaintPanel.jsx', 'bmCapacityText.js', 'BmCapacityFleet.jsx']) {
      const src = fs.readFileSync(path.join(HERE, f), 'utf8');
      expect(/timeZone\s*:/.test(src), `${f} 시간대 계산`).toBe(false);
      expect(/setInterval\(/.test(src), `${f} 폴링`).toBe(false);
      expect(/linFit|leastSquares|forecastSeries/.test(src), `${f} 회귀 복제`).toBe(false);
      expect(/text-transform\s*:\s*uppercase/i.test(src)).toBe(false);
    }
  });
});
