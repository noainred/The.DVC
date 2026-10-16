// v2.698 — VM 구성 점검 문구. 서버 vmhygiene/analyze.js 코드 집합과 1:1, 설정 범위도 서버와 같아야 한다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
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
  it('notifyNowMsg — 데모·첫 수집·목업 제외 개수를 코드가 아니라 문장으로 말한다(v2.743)', () => {
    expect(web.notifyNowMsg({ sent: false, reason: 'demo', mockExcluded: 12 })).toMatch(/데모\(목업\) 데이터라/);
    expect(web.notifyNowMsg({ sent: false, reason: 'demo' })).not.toMatch(/\(demo\)/);
    expect(web.notifyNowMsg({ sent: false, reason: 'first-collect' })).toMatch(/첫 수집/);
    expect(web.notifyNowMsg({ sent: true, reason: 'sent', mockExcluded: 3 })).toBe('보냈습니다. 목업 vCenter 의 VM 3대는 뺐습니다.');
    expect(web.notifyNowMsg({ sent: false, reason: 'error', error: 'smtp down' })).toMatch(/smtp down/);
    expect(web.notifyNowMsg({ sent: false, reason: 'weird' })).toBe('보내지 않았습니다(weird).');
    // 서버가 '지금 보내기'(force) 경로로 낼 수 있는 사유는 전부 문장이 있다
    const src = fs.readFileSync(new URL('../../../../server/src/vmhygiene/notifier.js', import.meta.url), 'utf8');
    const reasons = new Set([...src.matchAll(/reason: '([a-z-]+)'/g)].map((m) => m[1]));
    for (const r of ['no-violation', 'no-channel', 'demo', 'first-collect', 'busy']) expect(reasons.has(r)).toBe(true);
    for (const r of reasons) if (!['off', 'edge', 'before-hour', 'already-sent', 'sent', 'error'].includes(r)) expect(web.NOTIFY_NOW_TEXT[r], r).toBeTruthy();
  });
});
