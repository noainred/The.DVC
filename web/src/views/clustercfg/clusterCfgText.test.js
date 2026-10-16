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

// v2.742(감사 VC-05) — 같은 이름 클러스터 구분 표시 · 상세 빈 사유 · 호스트 칸.
import * as srvAn from '../../../../server/src/clustercfg/analyze.js';
describe('clusterCfgText v2.742 — 같은 이름 클러스터', () => {
  const cfgA = { name: 'Prod', ref: 'domain-c1', at: 1, ha: { enabled: true }, drs: { enabled: true }, evc: 'intel-x', rules: [], rulesTotal: 0 };
  const cfgB = { name: 'Prod', ref: 'domain-c2', at: 1, ha: { enabled: false }, drs: { enabled: true }, evc: 'intel-x', rules: [], rulesTotal: 0 };
  it('행 키·이름 — ref 로 나뉘고 같은 이름이면 데이터센터를 붙인다', () => {
    const hosts = [
      { id: 'h1', vcenterId: 'vc', cluster: 'Prod', clusterRef: 'domain-c1', vcDatacenter: 'DC-서울' },
      { id: 'h2', vcenterId: 'vc', cluster: 'Prod', clusterRef: 'domain-c2', vcDatacenter: 'DC-부산' },
    ];
    const r = srvAn.analyzeClusters([{ id: 'vc', name: 'VC', clusterCfg: [cfgA, cfgB] }], hosts);
    const keys = r.rows.map(web.clusterRowKey);
    expect(new Set(keys).size).toBe(2);
    expect(r.rows.map(web.clusterNameLabel).sort()).toEqual(['Prod · DC-부산', 'Prod · DC-서울']);
    expect(web.clusterNameLabel({ name: 'Solo', sameName: 1, vcDatacenter: 'DC' })).toBe('Solo');
    expect(web.clusterNameLabel({ name: 'Prod', sameName: 2, ref: 'domain-c9' })).toBe('Prod (domain-c9)');
  });
  it('상세 빈 사유 — 서버 clusterOf 의 reason 이 전부 문구를 가진다', () => {
    const vcs = [{ id: 'vc', clusterCfg: [cfgA, cfgB] }];
    const amb = srvAn.clusterOf(vcs, [], 'vc', 'Prod');
    expect(amb.reason).toBe('ambiguous');
    expect(web.clusterMissText(amb)).toContain('정하지 못했습니다');
    expect(web.clusterMissText(srvAn.clusterOf(vcs, [], 'vc', 'Other'))).toBe(web.CLUSTER_MISS_TEXT['not-collected']);
    expect(web.clusterMissText(srvAn.clusterOf(vcs, [], 'vc', 'standalone'))).toBe(web.CLUSTER_MISS_TEXT.standalone);
    expect(web.clusterMissText(srvAn.clusterOf(vcs, [], 'vc', 'Prod', null, { clusterRef: 'domain-c2' }))).toBeNull();
    for (const t of Object.values(web.CLUSTER_MISS_TEXT)) expect(t).not.toMatch(/[`*]/);
  });
  it('호스트 칸 — 모르면 0 이 아니라 —', () => {
    expect(web.clusterHostsText({ hosts: null, hostsAmbiguous: 3 })).toContain('3대');
    expect(web.clusterHostsText({ hosts: null })).toBe('—');
    expect(web.clusterHostsText({ hosts: 0 })).toBe('0');
  });
});
