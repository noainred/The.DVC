import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  modeFromHash, overviewMode, normDays, briefingStamp, gauges, chartGroup, regionCards,
  siteRowsExec, sortSiteRows, sparkPaths, deltaText, trendNote, attentionItems, inventoryCells, usageTone, gpuKpi,
} from './execOverviewText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const site = (id, extra = {}) => ({ id, name: id, status: 'connected', location: { city: id.toUpperCase(), country: 'Germany', region: '유럽' },
  metrics: { vms: 10, hosts: 2, cpuUsagePct: 50, memUsagePct: 60, storageUsagePct: 40 }, ...extra });

describe('보기 모드 — 해시(그 탭에만) → 저장값 → 역할 기본값', () => {
  it('#/overview/exec|eng 만 읽고 다른 탭의 둘째 세그먼트는 무시한다', () => {
    expect(modeFromHash('#/overview/eng')).toBe('eng');
    expect(modeFromHash('#/overview/exec')).toBe('exec');
    expect(modeFromHash('#/tools/exec')).toBeNull();
    expect(modeFromHash('#/overview')).toBeNull();
    expect(modeFromHash('#/overview/zzz')).toBeNull();
  });
  it('우선순위', () => {
    expect(overviewMode({ hash: '#/overview/eng', stored: 'exec', role: 'admin' })).toBe('eng');
    expect(overviewMode({ hash: '#/overview', stored: 'eng', role: 'admin' })).toBe('eng');
    expect(overviewMode({ hash: '', stored: null, role: 'admin' })).toBe('exec');
    expect(overviewMode({ hash: '', stored: null, role: 'operator' })).toBe('eng');
  });
  it('기간은 7/30/90 만 — 모르면 7', () => {
    expect(normDays('30')).toBe(30); expect(normDays(14)).toBe(7); expect(normDays(null)).toBe(7);
  });
});

describe('머리 시각', () => {
  it('KST 표기 · 모르면 빈 문자열', () => {
    expect(briefingStamp('2026-09-30T00:05:00Z')).toBe('2026.09.30 09:05 KST');
    expect(briefingStamp(null)).toBe('');
  });
});

describe('게이지 — 분모가 0 이면 —', () => {
  it('호스트 0 이면 CPU·메모리 null, 데이터스토어 0 이면 스토리지 null', () => {
    const [c, m, s] = gauges({ hosts: 0, cpuTotalGhz: 0, cpuUsagePct: 0, memTotalGB: 0, memUsagePct: 0, datastores: 0, storageTotalTB: 0, storageUsagePct: 0 });
    expect([c.pct, m.pct, s.pct]).toEqual([null, null, null]);
    const [c2, , s2] = gauges({ hosts: 3, cpuTotalGhz: 100, cpuUsagePct: 58, cpuCores: 1488, memTotalGB: 49766, memUsagePct: 71, datastores: 5, storageTotalTB: 3420, storageUsagePct: 67 });
    expect(c2.pct).toBe(58); expect(c2.basis).toBe('물리 1,488 코어 기준'); expect(s2.basis).toBe('데이터스토어 3.42 PB 기준');
  });
  it('색은 75/90', () => {
    expect(usageTone(74)).toBe('ok'); expect(usageTone(75)).toBe('warn'); expect(usageTone(90)).toBe('bad'); expect(usageTone(null)).toBe('none');
  });
});

describe('리전 묶음 — 유럽/북미/아시아(중국 포함)/대한민국', () => {
  it('대한민국은 나라 이름으로, 중국은 아시아로', () => {
    expect(chartGroup({ location: { country: 'South Korea', region: '아시아' } })).toBe('대한민국');
    expect(chartGroup({ location: { country: 'China', region: '중국' } })).toBe('아시아(중국 포함)');
    expect(chartGroup({ location: { region: '북미' } })).toBe('북미');
    expect(chartGroup({})).toBe('Unknown');
  });
  it('순서·비중·세지 못한 법인은 VM 에 더하지 않고 밝힌다', () => {
    const r = regionCards([
      site('kr', { location: { country: 'Korea', region: '아시아' }, metrics: { vms: 30, hosts: 3 } }),
      site('de'), site('us', { location: { region: '북미' }, metrics: { vms: 60, hosts: 6 } }),
      site('cn', { location: { country: 'China', region: '중국' }, status: 'pending', metrics: { vms: 0, hosts: 0 } }),
    ]);
    expect(r.map((x) => x.key)).toEqual(['유럽', '북미', '아시아(중국 포함)', '대한민국']);
    expect(r.find((x) => x.key === '북미').pct).toBe(60);
    const asia = r.find((x) => x.key === '아시아(중국 포함)');
    expect(asia.desc).toContain('중국 포함'); expect(asia.desc).toContain('미수집 1곳 제외'); expect(asia.pct).toBe(0);
  });
});

describe('법인 행', () => {
  it('첫 수집 중은 수치 —, 점검 중은 파란 점, 정렬은 모르는 값을 뒤로', () => {
    const rows = siteRowsExec([site('a', { metrics: { vms: 5, cpuUsagePct: 95 } }), site('b', { status: 'pending' }), site('c', { status: 'maintenance', metrics: { vms: 50 } })]);
    const b = rows.find((r) => r.id === 'b');
    expect(b.vms).toBeNull(); expect(b.cpu).toBeNull(); expect(b.mark).toBe('첫 수집 중'); expect(b.dot).toBe('none');
    expect(rows.find((r) => r.id === 'c').dot).toBe('info');
    expect(rows.find((r) => r.id === 'a').dot).toBe('bad');
    expect(sortSiteRows(rows, 'vms').map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(sortSiteRows(rows, 'risk').map((r) => r.id)[0]).toBe('a');
  });
});

describe('스파크라인·증감', () => {
  it('null 은 선을 끊고, 한 점 조각은 점으로', () => {
    const s = sparkPaths([{ v: 1 }, { v: 2 }, { v: null }, { v: 3 }]);
    expect((s.line.match(/M/g) || []).length).toBe(1);
    expect(s.dots.length).toBe(1);
    expect(sparkPaths([{ v: null }]).line).toBe('');
  });
  it('증감 문구 — 비교한 두 점 사이 길이를 적는다', () => {
    const D = 86_400_000;
    expect(deltaText('virtual', { diff: 12, firstTs: 0, lastTs: 7 * D }, 7)).toBe('+12 · 7일');
    expect(deltaText('virtual', { diff: -3, firstTs: 0, lastTs: 2 * D }, 7)).toBe('−3 · 2일');
    expect(deltaText('power', { diff: 3200, firstTs: 0, lastTs: 30 * D }, 30)).toBe('+3.2 kW · 30일');
    expect(deltaText('storage', { diff: 4e11, firstTs: 0, lastTs: 7 * D }, 7)).toBe('+0.4 TB · 7일');
    expect(deltaText('power', { diff: -20, firstTs: 0, lastTs: 7 * D }, 7)).toBe('±0 kW · 7일');
    expect(deltaText('virtual', { diff: 0, firstTs: 0, lastTs: 7 * D }, 7)).toBe('±0 · 7일');
    expect(deltaText('virtual', null, 7)).toBeNull();
  });
  it('추이 설명 — 기록 없음·범위 계정·부분 구간', () => {
    expect(trendNote('physical', { reason: 'no-series' })).toContain('기록하지 않습니다');
    expect(trendNote('power', { reason: '전체 범위 계정만' })).toContain('전체 범위');
    expect(trendNote('power', { series: [{ v: 1 }], partial: 2 })).toContain('2칸');
    expect(trendNote('power', { series: [{ v: 1 }] })).toContain('iDRAC');
    expect(trendNote('storage', { series: [{ v: null }] })).toContain('없습니다');
  });
});

describe('주의 항목', () => {
  it('용량 → 장애 → 라이선스 → 점검, 권한 없는 원천은 밝힌다', () => {
    const r = attentionItems({
      sites: [site('fra', { metrics: { vms: 1, storageUsagePct: 88 } }), site('dxb', { status: 'maintenance' })],
      alarms: { items: [{ severity: 'critical', vcenterId: 'fra', entity: 'esx-1' }, { severity: 'warning', vcenterId: 'fra' }] },
      forecast: { items: [{ vcenterId: 'fra', daysToFull: 47 }, { vcenterId: 'fra', daysToFull: null }] },
      licenses: { items: [{ daysLeft: 28, family: 'vSphere', vcenterId: 'dxb' }, { daysLeft: 400 }] },
      can: { alarms: true, forecast: true, licenses: true },
    });
    expect(r.items.map((x) => x.tag)).toEqual(['용량', '장애', '라이선스', '점검']);
    expect(r.items[0].title).toBe('FRA 스토리지 사용률 88%'); expect(r.items[0].desc).toContain('약 47일');
    expect(r.items[1].title).toContain('Critical 알람 1건');
    expect(r.items[2].title).toBe('vSphere 라이선스 만료 D-28');
    expect(r.skipped).toEqual([]);
    expect(attentionItems({ sites: [], can: { alarms: true, forecast: true, licenses: true }, errors: { 라이선스: 'forbidden', 알람: 'timeout' } }).skipped).toEqual(['라이선스(권한 없음)', '알람(읽기 실패)']);
    const n = attentionItems({ sites: [], can: {} });
    expect(n.skipped.length).toBe(3);
  });
  it('상한과 생략 개수', () => {
    const sites = Array.from({ length: 8 }, (_, i) => site(`s${i}`, { metrics: { vms: 1, storageUsagePct: 80 + i } }));
    const r = attentionItems({ sites, can: { alarms: true, forecast: true, licenses: true } }, 5);
    expect(r.items.length).toBe(5); expect(r.omitted).toBe(3); expect(r.items[0].tone).toBe('amber');
  });
});

describe('인벤토리·소스 규약', () => {
  it('모르는 값은 —', () => {
    const c = inventoryCells({ farms: { count: null, reason: 'x' } }, { hosts: 5, alarms: 0 });
    expect(c.find((x) => x.key === 'farm').value).toBe('—');
    expect(c.find((x) => x.key === 'alarms').value).toBe('0');
  });
  it('무거운 도구 조회는 폴링하지 않고 도구 권한을 먼저 본다', () => {
    const src = fs.readFileSync(path.join(HERE, 'ExecOverview.jsx'), 'utf8');
    expect(src).not.toMatch(/usePolling\([^)]*capacity-forecast/);
    expect(src).toMatch(/toolAllowed\('forecast'\)/);
    expect(src).toMatch(/toolAllowed\('license-expiry'\)/);
  });
  it('.xov 스타일은 uppercase 를 쓰지 않는다', () => {
    const css = fs.readFileSync(path.join(HERE, '..', 'styles.css'), 'utf8');
    const block = css.slice(css.indexOf('.xov {'));
    expect(block).not.toMatch(/text-transform:\s*uppercase/);
  });
});

describe('v2.678 GPU 카드 KPI — iDRAC 인벤토리 기준', () => {
  it('전부 읽었으면 개수 그대로', () => {
    const k = gpuKpi({ gpus: { count: 12, inventoryRead: 70, servers: 70 } });
    expect(k.value).toBe(12); expect(k.partial).toBe(false);
    expect(k.sub).toBe('iDRAC 인벤토리 기준 · 수집 70/70대');
  });
  it('한 대도 못 읽었으면 0 이 아니라 모름(null)', () => {
    const k = gpuKpi({ gpus: { count: 0, inventoryRead: 0, servers: 70 } });
    expect(k.value).toBeNull(); expect(k.sub).toMatch(/아직 읽은 서버가 없습니다/);
    expect(inventoryCells({ gpus: { count: 0, inventoryRead: 0, servers: 70 } }, {}).find((c) => c.key === 'gpu').value).toBe('—');
  });
  it('일부만 읽었으면 최소값임을 밝힌다', () => {
    const k = gpuKpi({ gpus: { count: 5, inventoryRead: 40, servers: 70 } });
    expect(k.value).toBe(5); expect(k.partial).toBe(true); expect(k.sub).toMatch(/최소값/);
  });
  it('등록 서버 0대면 0장(모름이 아니다) · 카드 자료가 없으면 null', () => {
    expect(gpuKpi({ gpus: { count: 0, inventoryRead: 0, servers: 0 } }).value).toBe(0);
    expect(gpuKpi(null).value).toBeNull();
  });
  it('경영 보기 KPI 에 GPU 카드 칸이 있다', () => {
    const src = fs.readFileSync(path.join(HERE, 'ExecOverview.jsx'), 'utf8');
    expect(src).toMatch(/key: 'gpus', label: 'GPU 카드'/);
  });
});
