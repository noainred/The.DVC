import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  CPU_ATTENTION_PCT, cpuBucket, hostReasons, triageCounts, cpuDistribution, clusterTiles, clusterKey, filterHosts, focusLabel,
} from './hostTriage.js';

const H = (name, o = {}) => ({ name, vcenterId: 'OC2', cluster: 'HQ-GPDB', connectionState: 'CONNECTED', cpuUsagePct: 40, memUsagePct: 50, ...o });

describe('hostTriage — ESXi 호스트 시안 B 판정(v2.764)', () => {
  it('CPU 확인 기준은 서버 high-cpu 경보와 같은 > 90 이다', () => {
    expect(CPU_ATTENTION_PCT).toBe(90);
    const soap = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../server/src/vcenter/soapClient.js'), 'utf8');
    expect(soap).toMatch(/h\.cpuUsagePct > 90\) mkAlarm\(h\.name, 'host', 'warning'/);
    expect(hostReasons(H('a', { cpuUsagePct: 90 }))).toEqual([]);
    expect(hostReasons(H('a', { cpuUsagePct: 91 }))).toEqual([{ kind: 'cpu', label: 'CPU 91%' }]);
  });

  it('CPU 구간 경계 — 100 초과는 따로, 못 읽음은 미수집', () => {
    expect(cpuBucket(H('a', { cpuUsagePct: 49 }))).toBe('lt50');
    expect(cpuBucket(H('a', { cpuUsagePct: 50 }))).toBe('b50');
    expect(cpuBucket(H('a', { cpuUsagePct: 75 }))).toBe('b75');
    expect(cpuBucket(H('a', { cpuUsagePct: 90 }))).toBe('b75');
    expect(cpuBucket(H('a', { cpuUsagePct: 100 }))).toBe('b90');
    expect(cpuBucket(H('a', { cpuUsagePct: 120 }))).toBe('over');
    expect(cpuBucket(H('a', { cpuUsagePct: null }))).toBe('na');
    expect(cpuBucket(H('a', { cpuUsagePct: '' }))).toBe('na');
  });

  it("끊김·무응답 호스트의 0% 는 CPU 구간·평균에 들어가지 않는다('못 읽은 값은 0 이 아니다')", () => {
    const down = H('d', { connectionState: 'DISCONNECTED', cpuUsagePct: 0 });
    const nr = H('n', { connectionState: 'NOT_RESPONDING', cpuUsagePct: 0 });
    expect(cpuBucket(down)).toBe('na');
    expect(hostReasons(down)).toEqual([{ kind: 'down', label: '끊김' }]);
    expect(hostReasons(nr)).toEqual([{ kind: 'down', label: '무응답' }]);
    const [t] = clusterTiles([H('a', { cpuUsagePct: 80 }), down]);
    expect(t.avg).toBe(80);
    expect(t.max).toBe(80);
    expect(t.count).toBe(2);
    expect(clusterTiles([down])[0].avg).toBe(null);
  });

  it('카드 숫자와 표 필터는 같은 판정이다', () => {
    const hosts = [
      H('a', { cpuUsagePct: 120 }), H('b', { cpuUsagePct: 95 }), H('c', { cpuUsagePct: 30 }),
      H('m', { connectionState: 'MAINTENANCE', cpuUsagePct: 95 }), H('d', { connectionState: 'DISCONNECTED', cpuUsagePct: 0 }),
    ];
    const c = triageCounts(hosts);
    expect(c).toEqual({ maint: 1, down: 1, cpu: 3, attention: 4, total: 5 });
    expect(filterHosts(hosts, { tab: 'attention' }).map((h) => h.name)).toEqual(['a', 'b', 'm', 'd']);
    for (const kind of ['maint', 'down', 'cpu']) expect(filterHosts(hosts, { tab: 'attention', focus: { kind } }).length).toBe(c[kind]);
    expect(filterHosts(hosts, { tab: 'all' }).length).toBe(5);
    expect(filterHosts(hosts, { tab: 'all', focus: { kind: 'bucket', value: 'over' } }).map((h) => h.name)).toEqual(['a']);
  });

  it('분포 합계 = 전체 호스트 수, share 는 가장 큰 구간 기준', () => {
    const hosts = [H('a', { cpuUsagePct: 10 }), H('b', { cpuUsagePct: 20 }), H('c', { cpuUsagePct: 110 }), H('d', { connectionState: 'DISCONNECTED' })];
    const d = cpuDistribution(hosts);
    expect(d.reduce((a, b) => a + b.count, 0)).toBe(4);
    expect(d.find((b) => b.key === 'lt50')).toMatchObject({ count: 2, share: 1 });
    expect(d.find((b) => b.key === 'over')).toMatchObject({ count: 1, share: 0.5 });
    expect(d.find((b) => b.key === 'na').count).toBe(1);
    expect(cpuDistribution([]).every((b) => b.share === 0)).toBe(true);
  });

  it('클러스터는 vCenter 와 묶어 나누고(동명 클러스터 분리) 최대 CPU 내림차순, 못 읽은 클러스터는 뒤', () => {
    const tiles = clusterTiles([
      H('a', { vcenterId: 'WA', cluster: 'C1', cpuUsagePct: 60 }),
      H('b', { vcenterId: 'OC2', cluster: 'C1', cpuUsagePct: 99 }),
      H('c', { vcenterId: 'PL', cluster: 'C2', connectionState: 'DISCONNECTED' }),
      H('d', { vcenterId: 'US', cluster: '', cpuUsagePct: 70 }),
    ]);
    expect(tiles.map((t) => `${t.vcenterId}/${t.cluster}`)).toEqual(['OC2/C1', 'US/standalone', 'WA/C1', 'PL/C2']);
    expect(tiles[0].attention).toBe(1);
    expect(filterHosts([H('x', { vcenterId: 'WA', cluster: 'C1' }), H('y')], { focus: { kind: 'cluster', value: clusterKey(H('z', { vcenterId: 'WA', cluster: 'C1' })) } }).map((h) => h.name)).toEqual(['x']);
  });

  it('필터 칩 문구', () => {
    expect(focusLabel({ kind: 'cpu' })).toBe('CPU 90% 초과');
    expect(focusLabel({ kind: 'bucket', value: 'over' })).toBe('CPU 100% 초과');
    expect(focusLabel({ kind: 'cluster', value: 'OC2\tHQ-GPDB' })).toBe('클러스터 OC2 · HQ-GPDB');
    expect(focusLabel(null)).toBe('');
  });
});
