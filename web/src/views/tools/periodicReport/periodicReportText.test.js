// v3.32 정기 점검 보고 — 화면 순수 문구(periodicReportText.js). 서버 rules.js · catalog.js 와 같은 글자 · 같은 축인지 대조한다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import * as T from './periodicReportText.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const raw = (p) => fs.readFileSync(path.join(here, p), 'utf8');

describe('정기 점검 보고 문구', () => {
  it('판정 표기는 기호 + 글자 — 모르는 값은 확인 불가', () => {
    expect(T.statusText('ok')).toBe('✓ 정상');
    expect(T.statusText('crit')).toBe('× 이상');
    expect(T.statusText('unknown')).toBe('? 확인 불가');
    expect(T.statusText('bogus')).toBe('? 확인 불가');
  });
  it('못 읽은 값은 0 이 아니다', () => {
    expect(T.numText(null)).toBe('—');
    expect(T.numText('')).toBe('—');
    expect(T.numText(undefined)).toBe('—');
    expect(T.numText(0)).toBe('0');
    expect(T.numText(1234)).toBe('1,234');
    expect(T.kstText(null)).toBe('—');
    expect(T.kstText(0)).toBe('—');
  });
  it('일정 한 줄', () => {
    expect(T.scheduleLine('daily', { enabled: true, time: '08:00' })).toBe('매일 08:00');
    expect(T.scheduleLine('daily', { enabled: true, time: '08:00', skipWeekend: true })).toBe('매일(주말 제외) 08:00');
    expect(T.scheduleLine('weekly', { enabled: true, time: '08:30', weekday: 1 })).toBe('매주 월요일 08:30');
    expect(T.scheduleLine('monthly', { enabled: true, time: '09:00', monthDay: 31 })).toContain('말일');
    expect(T.scheduleLine('quarterly', { enabled: true, time: '09:30', monthDay: 1 })).toBe('1 · 4 · 7 · 10월 1일 09:30');
    expect(T.scheduleLine('daily', { enabled: false, time: '08:00' })).toBe('꺼짐');
  });
  it('축 묶음 — 나쁜 순 · 정보는 뒤 · 축 종합은 판정 항목만', () => {
    const items = [{ axis: 'infra', status: 'info', label: 'a' }, { axis: 'infra', status: 'ok', label: 'b' }, { axis: 'infra', status: 'crit', label: 'c' }, { axis: 'service', status: 'unknown', label: 'd' }];
    const by = T.itemsByAxis(items);
    expect(by.infra.map((x) => x.status)).toEqual(['crit', 'ok', 'info']);
    expect(T.axisWorst(by.infra)).toBe('crit');
    expect(T.axisWorst(by.service)).toBe('unknown');
    expect(T.axisWorst([{ status: 'info' }])).toBe(null);
  });
  it('서버와 같은 글자 — 판정 · 주기 · 축', () => {
    const rules = raw('../../../../../server/src/periodic/rules.js');
    for (const [k, v] of Object.entries(T.STATUS_LABEL)) expect(rules).toContain(`${k}: '${v}'`);
    for (const [k, v] of Object.entries(T.KIND_LABEL)) expect(rules).toContain(`${k}: '${v}'`);
    const cat = raw('../../../../../server/src/periodic/catalog.js');
    for (const [k, v] of Object.entries(T.AXIS_LABEL)) expect(cat).toContain(`key: '${k}', label: '${v}'`);
  });
  it('도구 · 메뉴 연결 — 목록 · 특수 기능 · 설정 · 카테고리 · 접근 매핑', () => {
    expect(raw('../../specialToolsList.js')).toMatch(/k: 'periodic-report'/);
    expect(raw('../../SpecialTools.jsx')).toMatch(/tool === 'periodic-report' && <PeriodicReport \/>/);
    expect(raw('../../Settings.jsx')).toMatch(/k: 'periodic-report'.*group: 'notify'/);
    expect(raw('../../../../../server/src/toolcats/catalog.js')).toMatch(/'periodic-report'/);
    expect(raw('../../../../../server/src/auth/toolAccess.js')).toMatch(/'periodic-report': 'periodic-report'/);
  });
  it('화면 문구에 백틱 · uppercase 없음', () => {
    for (const f of ['PeriodicReport.jsx', 'periodicReport/Archive.jsx', 'periodicReport/ReportView.jsx', 'periodicReport/CatalogTab.jsx', 'periodicReport/ScheduleTab.jsx'].map((x) => `../${x}`)) {
      const s = raw(f);
      const strs = s.match(/'[^'\n]*'/g) || [];
      expect(strs.some((x) => x.includes('`'))).toBe(false);
    }
    expect(raw('periodicReport.css')).not.toMatch(/text-transform\s*:\s*uppercase/);
  });
});
