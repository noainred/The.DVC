// v2.698 — VM 구성 점검 문구. 서버 vmhygiene/analyze.js 코드 집합과 1:1, 설정 범위도 서버와 같아야 한다.
import { describe, it, expect } from 'vitest';
import * as web from './vmHygieneText.js';
import * as srv from '../../../../server/src/vmhygiene/analyze.js';
import { RANGES as SRV_RANGES } from '../../../../server/src/vmhygiene/settings.js';

describe('vmHygieneText', () => {
  it('코드 집합 — 서버 ALL_CODES = 웹 ALL_TEXT 키(1:1)', () => {
    expect(Object.keys(web.ALL_TEXT).sort()).toEqual(Object.keys(srv.ALL_CODES).sort());
  });
  it('설정 범위 — 서버와 같다', () => {
    expect(web.RANGES).toEqual(SRV_RANGES);
  });
  it('문구에 백틱·별표 없음', () => {
    for (const t of Object.values(web.ALL_TEXT)) expect(t.title + t.fix).not.toMatch(/[`*]/);
  });
  it('codeChips — 0건 코드는 빼지 않고 뒤로', () => {
    const c = web.codeChips({ 'uptime-long': { sev: 'info', vms: 0 }, 'snap-age': { sev: 'warn', vms: 2 }, question: { sev: 'crit', vms: 1 } });
    expect(c.map((x) => x.code)).toEqual(['question', 'snap-age', 'uptime-long']);
  });
  it('coverageNote — 전부 미수집 / 일부 미수집 / 전부 읽음', () => {
    expect(web.coverageNote({ vms: 3, notCollected: 3 })).toMatch(/읽은 VM 이 없습니다/);
    expect(web.coverageNote({ vms: 3, notCollected: 1 })).toMatch(/이상이 없다는 뜻이 아닙니다/);
    expect(web.coverageNote({ vms: 3, notCollected: 0 })).toBeNull();
  });
  it('settingsPatch — 빈 칸은 보내지 않는다(Number(\'\')===0 함정)', () => {
    const p = web.settingsPatch({ snapAgeDays: '', snapCount: ' ', snapSizeGB: '50', uptimeDays: null });
    expect(p).toEqual({ snapSizeGB: 50 });
  });
  it('notifyText — 꺼짐·채널 없음', () => {
    expect(web.notifyText({ enabled: false })).toMatch(/꺼짐/);
    expect(web.notifyText({ enabled: true, hour: 9, last: { reason: 'no-channel' } })).toMatch(/채널이 없어/);
  });
});
