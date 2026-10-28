// v2.810 — ESXi 호스트 '법인별' 보기 글자·색 판정(hostCorpText.js).
import { describe, it, expect } from 'vitest';
import { parseHostsView } from './hostChecksText.js';
import { stepTone, RATIO_STEPS, ratioText, pctText, gbText, fmtN, rttCell, corpMark, corpSortKey, chipList, corpView, clusterTags, bucketSegs, corpKpis, CORP_CHIPS } from './hostCorpText.js';

describe('hostCorpText', () => {
  it('보기 기억 — 모르는 값은 호스트별', () => {
    expect(['corp', 'host', '', null, 'x'].map(parseHostsView)).toEqual(['corp', 'host', 'host', 'host', 'host']);
  });

  it('과할당 3단계 — vCore 2.5·4 / RAM 100·150 · 못 읽음 none', () => {
    expect([2.5, 2.6, 4, 4.1, null].map((v) => stepTone(v, RATIO_STEPS.vcpu))).toEqual(['ok', 'warn', 'warn', 'crit', 'none']);
    expect([100, 101, 150, 151, ''].map((v) => stepTone(v, RATIO_STEPS.ram))).toEqual(['ok', 'warn', 'warn', 'crit', 'none']);
  });

  it("못 읽은 값은 '—' — 단위를 붙이지 않는다", () => {
    expect([ratioText(null), pctText(undefined), gbText(null), fmtN('')]).toEqual(['—', '—', '—', '—']);
    expect(ratioText(2.94)).toBe('2.9 : 1');
    expect(gbText(2048)).toBe('2 TB');
    expect(gbText(900)).toBe('900 GB');
    expect(fmtN(0)).toBe('0');
  });

  it('RTT — 없으면 —, 응답 없음은 0ms 가 아니다, 500ms 이상은 주의, 오래된 값은 stale', () => {
    expect(rttCell(null).text).toBe('—');
    expect(rttCell({ ok: false, rttMs: null, at: 1 }).text).toBe('응답 없음');
    expect(rttCell({ ok: true, rttMs: 842, at: 1, fresh: true })).toMatchObject({ text: '842 ms', tone: 'warn', stale: false });
    expect(rttCell({ ok: true, rttMs: 3, at: 1, fresh: false })).toMatchObject({ tone: 'ok', stale: true });
  });

  it('법인 표지는 corpSiteStatus 와 같은 말 — 첫 수집 중 · 연결 실패 · 낡은 값', () => {
    expect(corpMark({ status: 'pending', hosts: null }).mark).toBe('첫 수집 중');
    expect(corpMark({ status: 'unreachable', hosts: null }).mark).toBe('연결 실패');
    expect(corpMark({ status: 'connected', stale: true, hosts: 3, receivedAt: Date.now() - 7_200_000 })).toMatchObject({ mark: '낡은 값', stale: true });
    expect(corpMark({ status: 'connected', hosts: 3 }).mark).toBe(null);
  });

  it('법인 정렬 키 = 리전 › 이름(리전 없음은 맨 뒤)', () => {
    const list = [{ name: 'WA', region: '유럽' }, { name: 'X', region: null }, { name: 'OC2', region: '아시아' }, { name: 'AZ', region: '북미' }];
    expect(list.map(corpSortKey).sort()).toEqual(['0-oc2', '2-wa', '3-az', '4-x']);
  });

  it('칩 — 서버 byReason 개수 · 클러스터 칩은 권한이 있을 때만', () => {
    const t = { byReason: { hot: 9, n1: 3 } };
    expect(chipList(t, { cluster: true }).map((c) => [c.key, c.n])).toEqual(CORP_CHIPS.map((c) => [c.key, c.key === 'hot' ? 9 : c.key === 'n1' ? 3 : 0]));
    expect(chipList(t, { cluster: false }).some((c) => c.key === 'n1' || c.key === 'ha')).toBe(false);
  });

  it('칩은 숨기지 않고 흐리게 · 묶음(다빈치/IRS)은 거른다', () => {
    const corps = [{ id: 'a', group: 'davinci', reasons: ['hot'] }, { id: 'b', group: 'irs', reasons: [] }];
    expect(corpView(corps, { chip: 'hot' }).map((x) => [x.corp.id, x.dim])).toEqual([['a', false], ['b', true]]);
    expect(corpView(corps, { group: 'irs' }).map((x) => x.corp.id)).toEqual(['b']);
  });

  it('클러스터 표지 — N+1 · HA · 수용 제어 · DRS · EVC(꺼짐 = 빈 문자열) · 권한 없으면 호스트 상태만', () => {
    const c = { hot: 2, down: 0, maint: 1, n1Ok: false, cpuAfterFailPct: 112, cfgCollected: true, ha: true, admission: false, drs: 'manual', evc: '', findings: [{ code: 'evc-off-mixed' }] };
    const labels = clusterTags(c, true).map((t) => `${t.label}/${t.tone}`);
    expect(labels).toEqual(['CPU 90%↑ 2/red', '점검 1/amber', 'N+1 불가 · 1대 장애 시 CPU 112%/red', 'HA 켜짐/gray', '수용 제어 꺼짐/amber', 'DRS 수동/amber', 'EVC 꺼짐/amber']);
    expect(clusterTags({ ...c, n1Ok: false, cpuAfterFailPct: 999 }, true)[2].label).toBe('N+1 불가 · 1대 장애 시 CPU 수용 불가');
    expect(clusterTags(c, false).map((t) => t.label)).toEqual(['CPU 90%↑ 2', '점검 1']);
    expect(clusterTags({ ...c, cfgCollected: false }, true).map((t) => t.label)).toContain('구성 아직 안 읽음');
  });

  it('CPU 누적 막대 — 0 인 구간은 빼고 비율 합 100', () => {
    const segs = bucketSegs({ lt50: 3, b50: 0, b90: 1 }, ['lt50', 'b50', 'b75', 'b90', 'over', 'na']);
    expect(segs.map((s) => s.key)).toEqual(['lt50', 'b90']);
    expect(segs.reduce((a, s) => a + s.pct, 0)).toBeCloseTo(100);
    expect(bucketSegs({}, ['lt50'])).toEqual([]);
  });

  it('요약 — 호스트를 모르는 법인은 더하지 않고 밝힌다 · 용량을 못 읽은 법인은 비율에서 뺀다', () => {
    const data = {
      access: { cluster: true },
      totals: { corps: 3, corpsOk: 1, corpsStale: 0, corpsFail: 1, corpsUnknown: 1, clusters: 4, hosts: 10, hot: 2, hotCorps: 1, maint: 0, down: 1, n1Fail: 1, haOff: 0 },
      corps: [
        { hosts: 6, capUnknown: 0, cores: 100, vcpu: 300, powerKw: 2.5, vms: 40 },
        { hosts: 4, capUnknown: 1, cores: 50, vcpu: 999, powerKw: 1, vms: 10 },
        { hosts: null, powerKw: 0, vms: 0 },
      ],
    };
    const k = Object.fromEntries(corpKpis(data).map((x) => [x.key, x]));
    expect(k.ratio.value).toBe('3.0 : 1');
    expect(k.ratio.sub).toContain('용량 못 읽은 법인 제외');
    expect(k.hosts.sub).toContain('미수집 1곳 제외');
    expect(k.kw.value).toBe('3.5 kW');
    expect(k.hot.tone).toBe('crit');
  });
});
