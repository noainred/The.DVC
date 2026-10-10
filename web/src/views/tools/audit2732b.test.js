/**
 * views/tools/audit2732b.test.js — 점검 2회차(v2.732) 그룹 b: CVP 소비전력·GBIC 광신호 화면이 '지금 값이 아닌 장비' 를 말한다.
 *  서버(/tools/cvp/power totals.stale·staleBy, /tools/cvp/optics counts.staleDevices·staleXcvr·staleBy, 행 stale·staleReason)를 화면이
 *  합계·KPI·행 판정에서 정상·0 으로 섞지 않는다. 사유 키는 서버 CVP_STALE_REASONS 와 1:1(서버 소스를 읽어 대조).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { powerKpis, powerEmptyNote, powerRowNote, staleByText, CVP_STALE_REASON_TEXT, POWER_NOTE } from './cvpPowerText.js';
import { opticsKpis, opticRowState, opticsEmptyNote, OPTICS_NOTE } from './cvpOpticsText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const serverCvp = fs.readFileSync(path.join(HERE, '../../../../server/src/routes/api/cvp.js'), 'utf8');

describe('B2-03 사유 키 — 서버와 1:1', () => {
  it('CVP_STALE_REASONS 와 화면 문구 표의 키가 같다', () => {
    const m = serverCvp.match(/CVP_STALE_REASONS\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/);
    expect(m).toBeTruthy();
    const keys = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    expect(Object.keys(CVP_STALE_REASON_TEXT).sort()).toEqual(keys);
  });
  it('staleByText — 0 은 빼고, 모르는 키는 원문, 없으면 빈 문자열', () => {
    expect(staleByText({ 'parts-stale': 2, stale: 0, never: 1 })).toBe('부품 목록 오래됨 2 · 수집 기록 없음 1');
    expect(staleByText({ odd: 3 })).toBe('odd 3');
    expect(staleByText(null)).toBe('');
  });
});

describe('B2-03 소비전력 — 오래된 값은 합계가 아니다', () => {
  const t = { devices: 3, read: 1, watts: 400, stale: 2, staleBy: { stale: 1, 'parts-stale': 1 }, unread: { partsNotRead: 0, noPsu: 0, noPowerField: 0 } };
  it('KPI 에 오래된 값 칸이 있고 합계 칸이 그 제외를 말한다', () => {
    const k = powerKpis(t);
    const st = k.find((x) => x.key === 'stale');
    expect(st).toBeTruthy();
    expect(st.value).toBe('2');
    expect(st.accent).toBe('var(--amber)');
    expect(st.meta).toContain('수집 오래됨 1');
    expect(k[0].meta).toContain('오래된 값 2대 제외');
    // 기존 칸 순서·의미는 그대로(앞 네 칸)
    expect(k.slice(0, 4).map((x) => x.key)).toEqual(['total', 'avg', 'read', 'unread']);
  });
  it('오래된 값 0 은 경고색이 아니고, 서버가 필드를 주지 않으면(구버전) — 로 말한다', () => {
    expect(powerKpis({ ...t, stale: 0, staleBy: {} }).find((x) => x.key === 'stale').accent).toBeUndefined();
    expect(powerKpis({ devices: 1, read: 1, watts: 10, unread: {} }).find((x) => x.key === 'stale').value).toBe('—');
  });
  it('전부 오래됐으면 빈 상태가 "아직 읽지 않았다" 가 아니라 오래됐다고 말한다', () => {
    const n = powerEmptyNote({ devices: 2, read: 0, stale: 2, staleBy: { stale: 2 }, unread: {} });
    expect(n).toContain('오래');
    expect(n).not.toContain('아직 PSU 를 읽은 장비가 없습니다');
  });
  it('행 표지 — 오래된 행만 직전 값과 사유를 말한다', () => {
    expect(powerRowNote({ stale: false, watts: 400 })).toBe('');
    const r = powerRowNote({ stale: true, staleReason: 'parts-stale', lastWatts: 300 });
    expect(r).toContain('부품 목록 오래됨'); expect(r).toContain('300 W');
    expect(powerRowNote({ stale: true, staleReason: 'stale', lastWatts: null })).toContain('수집 오래됨');
  });
  it('문구에 백틱이 없다', () => { expect(POWER_NOTE.includes('`')).toBe(false); expect(POWER_NOTE).toContain('오래된'); });
});

describe('B2-03 GBIC 광신호 — 오래된 판정은 지금 장애가 아니다', () => {
  it('행 판정 — 오래된 행은 직전 판정과 함께 "판정 제외" 로 보인다(장애 색 아님)', () => {
    const s = opticRowState({ stale: true, staleReason: 'stale', judged: false, rxState: null, lastRxState: 'fault', rx: -16 });
    expect(s.tone).toBe('muted');
    expect(s.label).toContain('판정 제외');
    expect(s.label).toContain('직전 약함');
    expect(opticRowState({ stale: false, judged: true, rxState: 'fault' }).tone).toBe('bad');
  });
  it('KPI 에 오래된 값 칸 — 트랜시버 수 + 장비 수·사유', () => {
    const k = opticsKpis({ fault: 1, warn: 0, ok: 0, judged: 1, staleDevices: 2, staleXcvr: 3, staleBy: { 'parts-stale': 2 } }, { warnDbm: -10, faultDbm: -14 });
    const st = k.find((x) => x.key === 'stale');
    expect(st.value).toBe('3'); expect(st.accent).toBe('var(--amber)');
    expect(st.meta).toContain('장비 2대'); expect(st.meta).toContain('부품 목록 오래됨 2');
    expect(k.slice(0, 5).map((x) => x.key)).toEqual(['fault', 'warn', 'ok', 'notLinked', 'noDom']);
  });
  it('전부 오래됐으면 빈 상태가 "수집된 트랜시버가 없다" 가 아니다', () => {
    const n = opticsEmptyNote({ withDom: 0, present: 0, devicesNoXcvrRead: 0, staleDevices: 2, staleXcvr: 2 });
    expect(n).toContain('오래'); expect(n).not.toBe('아직 수집된 트랜시버가 없습니다.');
  });
  it('문구에 백틱이 없다', () => { expect(OPTICS_NOTE.includes('`')).toBe(false); expect(OPTICS_NOTE).toContain('오래된'); });
});
