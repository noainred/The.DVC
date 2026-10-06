// v2.706 — C2·C3 경합 문구·판정, C5 생성·삭제 종류, C4 재부팅 종류: 서버와 키·판정 1:1(번들 경계라 두 벌).
import { describe, it, expect } from 'vitest';
import * as web from './contention/contentionText.js';
import * as srv from '../../../server/src/contention/parse.js';
import { LIFE_KIND_LABEL, LIFE_KIND_TONE, ADD_KINDS, existsText, lifeSpanText, netText, sourceText } from './vmlife/vmLifeText.js';
import { LIFE_KIND } from '../../../server/src/vmchanges/eventDetail.js';
import { REBOOT_KIND } from './hostcfg/hostCfgText.js';
import { REBOOT_KINDS } from '../../../server/src/hostcfg/reboots.js';

const am = (avg, max = avg) => ({ avg, max });
const VMS = [
  { powerState: 'POWERED_ON', perfc: { readyPct: am(5), costopPct: am(2.9), latencyPct: am(12), readMs: am(19.9), writeMs: null } },
  { powerState: 'POWERED_ON', perfc: { readyPct: am(10), costopPct: am(10), latencyPct: am(30), readMs: am(50), writeMs: am(1) } },
  { powerState: 'POWERED_ON', perfc: { readyPct: null, costopPct: null, latencyPct: am(10), readMs: null, writeMs: am(20), disk: 'scsi0:1' } },
  { powerState: 'POWERED_OFF', perfc: { readyPct: am(50) } },
  { powerState: 'POWERED_ON' },
];

describe('contentionText', () => {
  it('코드·기준 — 서버 = 웹 = 문구 키', () => {
    expect(web.CONTENTION_CODES).toEqual(srv.CONTENTION_CODES);
    expect(web.THRESHOLDS).toEqual(srv.THRESHOLDS);
    expect(Object.keys(web.CONTENTION_TEXT).sort()).toEqual(Object.keys(srv.CONTENTION_CODES).sort());
  });
  it('판정 — 같은 입력에서 같은 결과', () => {
    for (const v of VMS) expect(web.vmContentionFindings(v)).toEqual(srv.vmContentionFindings(v));
  });
  it('문구에 백틱·별표 없음', () => {
    for (const t of Object.values(web.CONTENTION_TEXT)) expect(t.title + t.fix).not.toMatch(/[`*]/);
  });
  it('값 표시 — 없으면 —, 단위를 붙이지 않는다', () => {
    expect(web.avgMaxText(null, '%')).toBe('—');
    expect(web.avgMaxText({ avg: null }, '%')).toBe('—');
    expect(web.avgMaxText(am(3, 3), ' ms')).toBe('3 ms');
    expect(web.avgMaxText(am(3, 9), '%')).toBe('3% (최대 9%)');
    expect(web.pctText(null)).not.toMatch(/%/);
  });
  it('coverageNote — 꺼짐·전부 미측정·일부 미측정은 판정에서 빠졌다고 말한다', () => {
    expect(web.coverageNote({ scan: { enabled: false }, coverage: {} })).toMatch(/꺼져/);
    expect(web.coverageNote({ coverage: { poweredOn: 5, measured: 0, stale: 0 } })).toMatch(/아직 측정한 VM 이 없습니다/);
    expect(web.coverageNote({ coverage: { poweredOn: 5, measured: 3, notMeasured: 1, stale: 1 } })).toMatch(/경합이 없다는 뜻이 아닙니다/);
    expect(web.coverageNote({ coverage: { poweredOn: 5, measured: 5, notMeasured: 0, stale: 0 } })).toBeNull();
    expect(web.windowText({ windowSec: 300 })).toBe('최근 5분');
    expect(web.windowText({})).toBe('최근 창');
  });
});

describe('vmLifeText · 재부팅 종류', () => {
  it('생성·삭제 종류 키 = 서버 LIFE_KIND 값', () => {
    const kinds = [...new Set(Object.values(LIFE_KIND))].sort();
    expect(Object.keys(LIFE_KIND_LABEL).sort()).toEqual(kinds);
    expect(Object.keys(LIFE_KIND_TONE).sort()).toEqual(kinds);
    for (const k of ADD_KINDS) expect(kinds).toContain(k);
  });
  it('재부팅 종류 키 = 서버 REBOOT_KINDS', () => {
    expect(Object.keys(REBOOT_KIND).sort()).toEqual([...REBOOT_KINDS].sort());
  });
  it('문구 판정 — 모름·수명·순증·출처', () => {
    expect(existsText({ existsNow: null }).text).toBe('모름');
    expect(existsText({ kind: 'remove', existsNow: true }).tone).toBe('amber');
    expect(existsText({ kind: 'create', existsNow: true }).text).toBe('있음');
    expect(lifeSpanText(30 * 60_000)).toBe('30분');
    expect(lifeSpanText(5 * 3_600_000)).toBe('5시간');
    expect(lifeSpanText(-1)).toBe('—');
    expect(netText({ net: 3 })).toBe('+3');
    expect(netText({ net: -2 })).toBe('-2');
    expect(netText(null)).toBe('—');
    expect(sourceText({ kind: 'deploy', source: 'tpl' })).toBe('템플릿 tpl');
    expect(sourceText({ kind: 'rename', oldName: 'a', newName: 'b' })).toBe('a → b');
    expect(sourceText({ kind: 'create', hasDetail: false })).toMatch(/상세 없는/);
  });
});
