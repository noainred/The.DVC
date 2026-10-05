// v2.701(A6) — 클러스터 HA·DRS 문구. 판정 코드는 서버 clustercfg/parse.js 와 1:1(번들 경계라 두 벌).
import { describe, it, expect } from 'vitest';
import * as web from './clusterCfgText.js';
import * as srv from '../../../../server/src/clustercfg/parse.js';

describe('clusterCfgText', () => {
  it('코드 집합 — 서버 = 웹 = 문구 키(1:1)', () => {
    expect(web.CLUSTER_CFG_CODES).toEqual(srv.CLUSTER_CFG_CODES);
    expect(Object.keys(web.CLUSTER_TEXT).sort()).toEqual(Object.keys(srv.CLUSTER_CFG_CODES).sort());
  });
  it('문구에 백틱·별표 없음', () => {
    for (const t of Object.values(web.CLUSTER_TEXT)) expect(t.title + t.fix).not.toMatch(/[`*]/);
  });
  it('HA·DRS·EVC 문구 — 모르면 —, 꺼짐은 꺼짐', () => {
    expect(web.haText(null)).toBe('—');
    expect(web.haText({ enabled: null })).toBe('—');
    expect(web.haText({ enabled: false })).toBe('꺼짐');
    expect(web.haText({ enabled: true, admission: false, hostMon: 'disabled' })).toBe('켜짐 · 수용 제어 꺼짐 · 호스트 모니터링 꺼짐');
    expect(web.drsText({ enabled: true, behavior: 'manual' })).toBe('켜짐 · 수동');
    expect(web.evcText('')).toBe('꺼짐');
    expect(web.evcText(null)).toBe('—');
    expect(web.evcText('intel-skylake')).toBe('intel-skylake');
  });
  it('VM 규칙 문구 — null 은 판정 불가, 빈 배열은 없음', () => {
    expect(web.vmRulesText(null)).toBe(null);
    expect(web.vmRulesText([])).toMatch('없습니다');
    expect(web.vmRulesText([{ name: 'r1', type: 'anti-affinity', enabled: true, inCompliance: false }])).toBe('r1(반선호도 · 위반)');
  });
  it('coverageNote — 수집 꺼짐 / 전부 미수집 / 일부 미수집', () => {
    expect(web.coverageNote({ clusters: 3, cfg: 0, notCollected: 3 }, { enabled: false })).toMatch('꺼져');
    expect(web.coverageNote({ clusters: 3, cfg: 0, notCollected: 3 })).toMatch('아직');
    expect(web.coverageNote({ clusters: 3, cfg: 2, notCollected: 1 })).toMatch('1개');
    expect(web.coverageNote({ clusters: 3, cfg: 3, notCollected: 0 })).toBe(null);
  });
});
