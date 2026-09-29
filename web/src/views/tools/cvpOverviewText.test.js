import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  healthRing, healthNote, overviewKpis, corpCards, modelBars, versionRows, freshnessRows, trafficRows,
  facetRowsOf, corpNameFn, eventCorpChips, eventSevChips, deviceSummaryTiles, historyNotes, corpLabel, UNASSIGNED_LABEL, CORP_NOTE, TRAFFIC_NOTE,
} from './cvpOverviewText.js';

describe('cvpOverviewText (v2.645)', () => {
  it('healthRing — 분모는 확인 불가 포함 전체, 0대면 null', () => {
    const r = healthRing({ ok: 90, warn: 5, bad: 1, unknown: 4 });
    expect(r.total).toBe(100); expect(r.okPct).toBe(90); expect(r.segs.map((s) => s.key)).toEqual(['ok', 'warn', 'bad', 'unknown']);
    expect(healthRing({}).okPct).toBeNull();
    expect(healthRing({ ok: 0, unknown: 3 }).okPct).toBe(0);
  });
  it('healthNote — 확인 불가를 정상에 넣지 않았다고 사유와 함께 말한다', () => {
    const s = healthNote({ devices: 10, health: { ok: 7, warn: 1, bad: 0, unknown: 2 }, unknownBy: { stale: 1, 'not-streaming': 1, never: 0 } });
    expect(s).toContain('10대 중 8대');
    expect(s).toContain('오래된 수집 1'); expect(s).toContain('스트리밍 아님 1'); expect(s).not.toContain('받은 적 없음');
    expect(healthNote({ devices: 0 })).toContain('없습니다');
  });
  it('overviewKpis — 0 은 경고색이 아니고, 수명주기를 못 읽으면 지어내지 않는다', () => {
    const k = overviewKpis({ totals: { openFaults: 0, openFaultsFault: 0, openFaultsWarn: 0, portsDown: 0, lifecycleRead: 0, devices: 3, streaming: 3, notStreaming: 0 }, events: {} });
    expect(k.find((x) => x.key === 'faults').tone).toBeNull();
    expect(k.find((x) => x.key === 'ports').tone).toBeNull();
    const eol = k.find((x) => x.key === 'eol');
    expect(eol.value).toBe('—'); expect(eol.sub).toContain('지어내지');
    const k2 = overviewKpis({ totals: { openFaults: 2, openFaultsFault: 1, openFaultsWarn: 1, portsDown: 4 }, events: { error: 2, critical: 1, warning: 3 } });
    expect(k2.find((x) => x.key === 'faults').tone).toBe('bad');
    expect(k2.find((x) => x.key === 'events').value).toBe('3');
  });
  it('corpCards — 미지정 라벨 · 전부 확인 불가는 회색 · 모두 정상은 확인 불가 없을 때만', () => {
    const c = corpCards([
      { corpId: 'kr', corpName: 'Korea', devices: 2, health: { ok: 2 } },
      { corpId: 'pl', corpName: 'Poland', devices: 2, health: { ok: 1, unknown: 1 } },
      { corpId: '', corpName: '', devices: 1, health: { unknown: 1 } },
    ]);
    expect(c[0].note).toBe('모두 정상'); expect(c[0].tone).toBe('ok');
    expect(c[1].note).toBe('확인 불가 1'); expect(c[1].tone).toBe('ok');
    expect(c[2].name).toBe(UNASSIGNED_LABEL); expect(c[2].tone).toBe('unknown');
    expect(corpLabel({ corpId: 'x', corpName: 'x', missing: true })).toContain('삭제');
  });
  it('modelBars·versionRows — 가장 큰 모델이 100%, 갈린 버전이 먼저', () => {
    const models = [{ model: 'A', count: 10, versions: [{ version: '4.30', count: 8 }, { version: '4.28', count: 2 }] }, { model: '', count: 5, versions: [{ version: '4.30', count: 5 }] }];
    const b = modelBars(models);
    expect(b[0].pct).toBe('100%'); expect(b[1].pct).toBe('50%'); expect(b[1].name).toBe('(모델 미상)');
    const v = versionRows({ models, versions: [{ version: '4.30', count: 13, models: ['A', ''] }, { version: '4.28', count: 2, models: ['A'] }, { version: '4.31', count: 20, models: ['B'] }] });
    expect(v[0].split).toBe(true); expect(v.at(-1).version).toBe('4.31'); expect(v.at(-1).tag).toBe('1개 모델');
  });
  it('freshnessRows — 경계는 서버 값에서(숫자를 박지 않는다)', () => {
    const f = freshnessRows({ fresh: 8, late: 1, stale: 1, never: 0, freshMs: 600_000, staleMs: 1_800_000 });
    expect(f.rows[0].label).toBe('10분 이내'); expect(f.rows[1].label).toBe('10분 ~ 30분');
    expect(f.rows[2].count).toBe(1); expect(f.note).toContain('확인 불가');
  });
  it('trafficRows — 측정 포트 0 인 법인은 0 bps 가 아니라 —, 큰 순', () => {
    const r = trafficRows([
      { corpId: 'a', corpName: 'A', traffic: { inBps: 0, outBps: 0, portsMeasured: 0, portsUnmeasured: 3 } },
      { corpId: 'b', corpName: 'B', traffic: { inBps: 1e9, outBps: 1e9, portsMeasured: 4, portsUnmeasured: 1 } },
    ]);
    expect(r[0].corpId).toBe('b'); expect(r[0].sumText).toBe('2.0 Gbps'); expect(r[0].partial).toBe(true);
    expect(r[1].sum).toBeNull(); expect(r[1].sumText).toBe('—');
  });
  it('facetRowsOf·corpNameFn — 법인 칩 이름·모델 축', () => {
    const devs = [{ key: 'a', corpId: 'kr', corpName: 'Korea', model: 'M1' }, { key: 'b', corpId: '', model: '' }];
    const rows = facetRowsOf(devs);
    expect(rows[0].datacenterId).toBe('kr'); expect(rows[1].type).toBe('');
    const nm = corpNameFn(devs);
    expect(nm('kr')).toBe('Korea'); expect(nm('')).toBe(UNASSIGNED_LABEL);
  });
  it('eventCorpChips·eventSevChips — 두 축을 따로, 개수는 다른 축 선택 기준', () => {
    const cc = [{ corpId: '', total: 1, bySeverity: { warning: 1 } }, { corpId: 'kr', corpName: 'Korea', total: 3, bySeverity: { critical: 1, error: 1, info: 1 } }];
    const c = eventCorpChips(cc, 'errors');
    expect(c[0].corpId).toBe('kr'); expect(c[0].count).toBe(2); expect(c[1].count).toBe(0);
    expect(eventCorpChips(cc, 'warning')[1].count).toBe(1);
    expect(eventCorpChips(cc)[0].count).toBe(3);
    const s = eventSevChips({ critical: 1, error: 2, warning: 4 });
    expect(s.map((x) => x.label)).toEqual(['전체', '오류', '경고']);
    expect(s.find((x) => x.key === 'errors').count).toBe(3);
    expect(eventSevChips({}, 'info').map((x) => x.key)).toContain('info');
  });
  it('deviceSummaryTiles·historyNotes — 못 읽으면 —, 잘린 개수를 밝힌다', () => {
    const t = deviceSummaryTiles({ device: { corpId: 'kr', corpName: 'Korea', ports: { down: 2 } }, history: { openFaults: [{ state: 'fault' }], events: [{ severity: 'error' }], eventDays: 7 } });
    expect(t.map((x) => x.key)).toEqual(['faults', 'ports', 'events']);
    expect(t.find((x) => x.key === 'faults').tone).toBe('bad');
    expect(t.find((x) => x.key === 'ports').value).toBe('2');
    expect(deviceSummaryTiles({ device: {}, history: { unavailable: true } }).find((x) => x.key === 'faults').value).toBe('—');
    const n = historyNotes({ faultEventsOmitted: 5, eventsScanTruncated: true, eventDays: 7 });
    expect(n.join(' ')).toContain('5건 생략'); expect(n.join(' ')).toContain('2,000건');
  });
  it('문구에 백틱이 없다(BoldText 는 굵게만 해석)', () => {
    for (const t of [CORP_NOTE, TRAFFIC_NOTE]) expect(t.includes('`')).toBe(false);
    const src = fs.readFileSync(new URL('./CvpOverview.jsx', import.meta.url), 'utf8');
    expect(/uppercase/i.test(src)).toBe(false);
  });
});
