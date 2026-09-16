/**
 * sanHealthText.test.js — 월간 점검 문구·PDF 문서 모델 회귀(v2.519).
 *
 * 고정하는 것: **'확인 불가' 를 '이상 없음' 에 섞지 않는다**. 이 보고서는 "이번 달 이상 없음"
 * 결재의 근거이므로, 못 본 항목이 있으면 문구가 반드시 그것을 말해야 한다.
 */
import { describe, it, expect } from 'vitest';
import {
  deviceVerdict, allSummaryText, sortResults, baselineNote, stamp, deviceReportDoc, allReportDoc, reportFileName, STATUS_LABEL, stageLabel, portVerdict, opticalText, errorText, portCheckSummary, portBaselineNote, problemPortText, sideText, portBlocks,
} from './sanHealthText.js';

const R = (over = {}) => ({
  deviceId: 'd1', name: 'SW-A', overall: 'ok', uncheckedCount: 0,
  counts: { ok: 11, warn: 0, bad: 0, unknown: 0 }, collectedAt: 1_700_000_000_000,
  items: [{ key: 'psu', label: '전원 공급 장치(PSU)', stage: 1, cmd: 'psshow', status: 'ok', detail: '2/2 정상' }],
  ...over,
});

describe("deviceVerdict — '확인 불가' 를 정상에 섞지 않는다", () => {
  it('전부 확인했고 정상이면 그대로 말한다', () => {
    expect(deviceVerdict(R()).text).toBe('11항목 모두 이상 없음');
  });
  it("확인 불가가 있으면 '모두 이상 없음' 이라 말하지 않는다", () => {
    const v = deviceVerdict(R({ counts: { ok: 6, warn: 0, bad: 0, unknown: 5 }, uncheckedCount: 5 }));
    expect(v.text).toMatch(/확인한 6항목은 이상 없음/);
    expect(v.text).toMatch(/확인 불가 5항목/);
    expect(v.text).not.toMatch(/모두 이상 없음/);
  });

  it('확인 불가가 있으면 **배지 자체**가 초록 정상이 아니다(Chromium 판독으로 발견한 결함)', () => {
    // 문구로만 밝히고 배지를 초록으로 두면, 판정 열만 훑는 사람이 색을 보고 '괜찮다' 고 읽는다.
    const v = deviceVerdict(R({ counts: { ok: 6, warn: 0, bad: 0, unknown: 5 }, uncheckedCount: 5 }));
    expect(v.label).toBe('정상(일부 미확인)');
    expect(v.color).toBe('amber');
    // 전부 확인했을 때만 초록 '정상'.
    const clean = deviceVerdict(R());
    expect(clean.label).toBe(STATUS_LABEL.ok);
    expect(clean.color).toBe('green');
  });
  it('판정 가능한 항목이 없으면 확인 불가로 말한다', () => {
    const v = deviceVerdict(R({ overall: 'unknown', counts: { ok: 0, warn: 0, bad: 0, unknown: 11 }, uncheckedCount: 11 }));
    expect(v.label).toBe(STATUS_LABEL.unknown);
    expect(v.text).toMatch(/판정 가능한 항목이 없습니다/);
  });
  it('수집 실패는 그 사실을 먼저 말한다', () => {
    const v = deviceVerdict(R({ overall: 'unknown', collectFailed: true, uncheckedCount: 11 }));
    expect(v.text).toMatch(/수집이 실패해 점검하지 못했습니다/);
  });
  it('이상·주의는 항목 수를 함께 말한다', () => {
    expect(deviceVerdict(R({ overall: 'bad', counts: { ok: 8, warn: 1, bad: 2, unknown: 0 } })).text).toMatch(/이상 2항목 · 주의 1항목/);
    expect(deviceVerdict(R({ overall: 'warn', counts: { ok: 10, warn: 1, bad: 0, unknown: 0 } })).text).toMatch(/주의 1항목/);
  });
  it('빈 입력에 문구를 지어내지 않는다', () => {
    expect(deviceVerdict(null).text).toMatch(/결과가 없습니다/);
  });
});

describe('allSummaryText — 점검하지 못한 것을 감추지 않는다', () => {
  it('스냅샷 없음·확인 불가 합계를 함께 적는다', () => {
    const t = allSummaryText({ devices: 26, byOverall: { ok: 20, warn: 4, bad: 2, unknown: 0 }, missing: 2, uncheckedItems: 40 });
    expect(t).toMatch(/점검 26대/);
    expect(t).toMatch(/스냅샷 없음 2대/);
    expect(t).toMatch(/확인 불가 항목 합계 40/);
  });
  it('없는 항목은 적지 않는다(0 을 늘어놓지 않는다)', () => {
    const t = allSummaryText({ devices: 3, byOverall: { ok: 3 }, missing: 0, uncheckedItems: 0 });
    expect(t).not.toMatch(/스냅샷 없음/);
    expect(t).not.toMatch(/확인 불가/);
  });
});

describe('sortResults — 조치가 필요한 것부터', () => {
  it('이상 → 주의 → 판정 불가 → 정상', () => {
    const order = sortResults([R({ deviceId: 'a', overall: 'ok' }), R({ deviceId: 'b', overall: 'bad' }),
      R({ deviceId: 'c', overall: 'unknown' }), R({ deviceId: 'd', overall: 'warn' })]).map((r) => r.deviceId);
    expect(order).toEqual(['b', 'd', 'c', 'a']);
  });
  it('같은 등급이면 확인 불가가 많은 것 먼저', () => {
    const order = sortResults([R({ deviceId: 'a', overall: 'ok', uncheckedCount: 0 }), R({ deviceId: 'b', overall: 'ok', uncheckedCount: 5 })]).map((r) => r.deviceId);
    expect(order).toEqual(['b', 'a']);
  });
});

describe('baselineNote — 기준선이 없으면 왜 필요한지 말한다', () => {
  it('없으면 당월 신규를 판정하지 않았다고 밝힌다', () => {
    const t = baselineNote(null);
    expect(t).toMatch(/기준선이 없어/);
    expect(t).toMatch(/부팅 이후 누적/);
  });
  it('있으면 시점과 포트 수를 적고, 불완전 기준선은 경고한다', () => {
    expect(baselineNote({ at: 1_700_000_000_000, portCount: 128, portsComplete: true })).toMatch(/포트 128개/);
    expect(baselineNote({ at: 1, portCount: 3, portsComplete: false })).toMatch(/일부 포트만 있을 때 저장돼/);
  });
});

describe('PDF 문서 모델', () => {
  it('장비 보고서 — 단계별 표 + 판정 기준 메모, `**` 는 새지 않는다', () => {
    const doc = deviceReportDoc(R({ items: [
      { key: 'psu', label: 'PSU', stage: 1, cmd: 'psshow', status: 'ok', detail: '2/2 정상' },
      { key: 'portErrors', label: '포트 에러', stage: 3, cmd: 'porterrshow', status: 'warn', detail: '**기준선이 없어** 판정 불가', evidence: ['포트 1: crc err 42'] },
    ] }), { baseline: null });
    expect(doc.title).toMatch(/SAN 스위치 점검 보고서 — SW-A/);
    const kinds = doc.blocks.map((b) => b.type);
    expect(kinds).toContain('kvrow');
    expect(kinds).toContain('table');
    expect(kinds).toContain('note');
    // `**강조**` 가 PDF 에서 별표로 새지 않게 미리 제거한다(v2.439/2.440/2.505 실제 사고와 같은 축).
    expect(JSON.stringify(doc)).not.toMatch(/\*\*/);
    // 주의 항목의 근거는 싣고, 정상 항목의 근거는 싣지 않는다.
    expect(JSON.stringify(doc)).toMatch(/포트 1: crc err 42/);
    // 판정 기준 메모에 '확인 불가' 의 뜻이 적혀 있다.
    expect(JSON.stringify(doc)).toMatch(/이상이 없다는 뜻이 아니라/);
  });

  it('전체 보고서 — 점검하지 못한 부분을 먼저 밝히고 상한을 밝힌다', () => {
    const results = Array.from({ length: 40 }, (_, i) => R({ deviceId: `d${i}`, name: `SW-${i}`, overall: 'warn', datacenterName: 'KR' }));
    const doc = allReportDoc({ summary: { devices: 40, registered: 42, byOverall: { warn: 40 }, missing: 2, uncheckedItems: 12 },
      results, missing: [{ deviceId: 'x', name: 'SW-X', agent: 'HG' }], baselines: [] }, { maxDetail: 30 });
    const txt = JSON.stringify(doc);
    expect(txt).toMatch(/점검하지 못한 부분/);
    expect(txt).toMatch(/스냅샷이 없어 점검 대상에서 빠진 스위치 2대/);
    expect(txt).toMatch(/전부 이상 없음' 이라고 결론 내릴 수 없습니다/);
    // 상세 상한으로 자른 개수를 밝힌다(조용한 상한 금지).
    expect(txt).toMatch(/상세는 30대까지만 실었습니다 — 10대는 생략/);
    expect(txt).toMatch(/점검 제외 — SW-X/);
  });

  it('정상만 있으면 경고 블록을 넣지 않는다', () => {
    const doc = allReportDoc({ summary: { devices: 2, registered: 2, byOverall: { ok: 2 }, missing: 0, uncheckedItems: 0 },
      results: [R(), R({ deviceId: 'd2' })], missing: [], baselines: [] });
    expect(JSON.stringify(doc)).not.toMatch(/점검하지 못한 부분/);
  });

  it('파일명은 ASCII 다 — 한글 파일명은 브라우저가 이름을 잃을 수 있다(A/B 실측)', () => {
    // 실측: 헤드리스 Chromium 에서 `<a download="한글.pdf">` 는 suggestedFilename 이 'download' 로
    // 떨어졌고 ASCII 는 그대로 왔다. 월간 보고서는 아카이브 파일이라 이름을 잃으면 쓸모가 없다.
    expect(reportFileName('SW/A:1', new Date(2026, 8, 15, 21, 40))).toBe('san-switch-health_SW-A-1_20260915-2140.pdf');
    expect(reportFileName('전체', new Date(2026, 8, 15, 21, 40))).toBe('san-switch-health_all_20260915-2140.pdf');
    expect(reportFileName('KR 법인', new Date(2026, 8, 15, 21, 40))).toBe('san-switch-health_KR_20260915-2140.pdf');
    expect(reportFileName('', new Date(2026, 8, 15, 21, 40))).toMatch(/^san-switch-health_all_/);
    // 전부 ASCII 인지 직접 확인.
    for (const s of ['전체', 'MOCK-한글-1', 'SW A']) expect(reportFileName(s)).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe('보조 포맷터', () => {
  it('stamp — 없는 시각은 —', () => {
    expect(stamp(null)).toBe('—');
    expect(stamp(0)).toBe('—');
    expect(typeof stamp(1_700_000_000_000)).toBe('string');
  });
  it('stageLabel — 4단계 + 기타', () => {
    expect(stageLabel(1)).toMatch(/1단계/);
    expect(stageLabel(4)).toMatch(/4단계/);
    expect(stageLabel(9)).toBe('기타');
  });
});

/* ══════════════ v2.521 — 전 포트 점검 · 불량 포트 세부정보 · 광량 오탐 ══════════════ */
describe('v2.521 전 포트 점검 문구', () => {
  it("링크 없는 포트의 광량을 '정상' 이 아니라 '판정 제외' 라고 말한다", () => {
    expect(opticalText({ optical: 'skipped', rxPowerDbm: -27 })).toContain('판정 제외');
    expect(opticalText({ optical: 'skipped', rxPowerDbm: -27 })).toContain('링크 없음');
    expect(opticalText({ optical: 'ok', rxPowerDbm: -3 })).toBe('-3 dBm');
    expect(opticalText({ optical: 'unknown', rxPowerDbm: null })).toBe('값 없음');
  });
  it('에러는 누적과 신규를 나눠서 말한다', () => {
    expect(errorText({ errors: 'ok', errNew: 0, errSum: 50 })).toBe('신규 0 (누적 50)');
    expect(errorText({ errors: 'warn', errNew: null, errSum: 50 })).toBe('누적 50 (기준선 없음)');
    expect(errorText({ errors: 'unknown' })).toBe('카운터 없음');
  });
  it('요약이 링크 없는 포트 수를 밝힌다(조용히 빼지 않는다)', () => {
    const t = portCheckSummary({ rows: [1], counts: { total: 64, bad: 1, warn: 2, ok: 53, unknown: 0, idle: 8 }, complete: true });
    expect(t).toContain('전 포트 64개');
    expect(t).toContain('링크 없음 8(광량 판정 제외)');
  });
  it('엣지가 일부만 올렸으면 전 포트를 본 것이 아니라고 말한다', () => {
    const t = portCheckSummary({ rows: [1], counts: { total: 3 }, complete: false, portsOmitted: 120 });
    expect(t).toContain('전 포트를 본 것이 아닙니다');
  });
  it('기준선 유무로 문구가 달라진다', () => {
    expect(portBaselineNote({ baselineAt: null })).toContain('누적값만');
    expect(portBaselineNote({ baselineAt: Date.now() })).toContain('신규분');
  });
  it('WWN 을 모르는 포트를 "조닝 안 됨" 이라 말하지 않는다', () => {
    const t = problemPortText({ index: 10, wwns: [], zones: [] });
    expect(t).toContain('WWN 을 알 수 없어');
    expect(t).not.toContain('조닝 안 됨');
  });
  it('역할은 확정과 추정을 구분한다(v2.511 규칙)', () => {
    expect(sideText({ side: 'target', confidence: 'confirmed' })).toBe('타깃(확정)');
    expect(sideText({ side: 'target', confidence: 'inferred' })).toBe('타깃(추정)');
    expect(sideText({ side: 'middle', confidence: 'none' })).toBe('겸용(추정)');
  });
  it('판정 라벨에 초록 정상과 붉은 이상이 있다', () => {
    expect(portVerdict('bad')).toEqual({ label: '이상', color: 'red' });
    expect(portVerdict('ok').color).toBe('green');
    expect(portVerdict('unknown').label).toBe('확인 불가');
  });
  it('PDF 블록은 상한으로 자른 개수를 밝힌다', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ index: i, verdict: 'ok', state: 'online', name: '', optical: 'ok', rxPowerDbm: -3, errors: 'ok', errSum: 0, errNew: 0 }));
    const b = portBlocks({ rows, counts: { total: 10, ok: 10 }, complete: true }, [], { maxRows: 4 });
    expect(JSON.stringify(b)).toContain('6포트는 생략');
  });
});
