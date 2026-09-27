// v2.631 감사 그룹 d — 웹 화면 결함 회귀(WEB2631-02·03·04·05·06·07·08·09·10·11·12).
// 판정·문구는 순수 모듈을 실제로 호출하고, 화면에 붙였는지는 소스를 주석 제거 후 검사한다(node 환경 — DOM 없음).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../test/_stripComments.js';
import { recentAlarms, alarmPanelText } from './overviewAlarmsText.js';
import { corpSiteStatus, corpTotalLabel } from './corpSiteStatus.js';
import { serverCorpRows } from '../version_6/v6Data.js';
import { bmcPollSummary, BMC_TONE_COLOR } from './bmcPollText.js';
import { dsTrendMeta } from './dsTrendKpiText.js';
import { serverRatio, ratioLabel } from './virtRatioText.js';
import { sortKeyOf } from '../components/sortableText.js';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => stripComments(fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8'));

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'node_modules') walk(p, out); }
    else if (/\.(jsx?|tsx?)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

describe('WEB2631-02 — 개요 최근 알람: 최신순 · 못 읽음을 없음이라 말하지 않는다', () => {
  it('시각 내림차순(동률이면 critical 먼저), 시각 없는 것은 뒤', () => {
    const items = [
      { id: 'a', time: '2026-09-27T01:00:00Z', severity: 'warning' },
      { id: 'b', time: '2026-09-27T03:00:00Z', severity: 'warning' },
      { id: 'c', time: null, severity: 'critical' },
      { id: 'd', time: '2026-09-27T03:00:00Z', severity: 'critical' },
      { id: 'e', time: '2026-09-27T02:00:00Z', severity: 'info' },
    ];
    expect(recentAlarms(items, 8).map((x) => x.id)).toEqual(['d', 'b', 'e', 'a', 'c']);
    expect(recentAlarms(items, 2).map((x) => x.id)).toEqual(['d', 'b']);
    expect(items[0].id).toBe('a'); // 원본 불변
    expect(recentAlarms(null)).toEqual([]);
  });
  it('권한 없음·불러오는 중·실패·REST 폴백 섞임은 "활성 알람이 없습니다" 가 아니다', () => {
    const none = '활성 알람이 없습니다.';
    expect(alarmPanelText({ allowed: false, data: null }).empty).not.toBe(none);
    expect(alarmPanelText({ allowed: true, data: null, forbidden: true }).empty).toMatch(/권한/);
    expect(alarmPanelText({ allowed: true, data: null, error: 'x' }).empty).toMatch(/불러오지 못/);
    expect(alarmPanelText({ allowed: true, data: null }).empty).toMatch(/불러오는 중/);
    const rest = alarmPanelText({ allowed: true, data: { items: [] }, sites: [{ id: 'v1', status: 'connected', alarmsUnknown: true }] });
    expect(rest.empty).not.toBe(none);
    expect(rest.note).toMatch(/1곳/);
    expect(alarmPanelText({ allowed: true, data: { items: [] }, sites: [{ id: 'v1', status: 'connected' }] }).empty).toBe(none);
  });
  it('Overview 는 inv.alarms 권한일 때만 /alarms 를 부르고 slice 전에 정렬한다', () => {
    const s = src('views/Overview.jsx');
    expect(s).toMatch(/usePolling\(canAlarms \? '\/alarms' : null/);
    expect(s).not.toMatch(/alarmData\?\.items \|\| \[\]\)\.slice/);
    expect(s).toMatch(/recentAlarms\(/);
    expect(s).not.toMatch(/>활성 알람이 없습니다\.</);
  });
});

describe('WEB2631-03 — 법인별 서버 표: 첫 수집 중·연결 실패·비활성은 0 이 아니라 —', () => {
  it('상태별 판정', () => {
    expect(corpSiteStatus({ status: 'connected' }).countable).toBe(true);
    expect(corpSiteStatus({}).countable).toBe(true);
    expect(corpSiteStatus({ status: 'maintenance' })).toMatchObject({ countable: true, mark: '점검중' });
    expect(corpSiteStatus({ status: 'pending' })).toMatchObject({ countable: false, mark: '첫 수집 중' });
    expect(corpSiteStatus({ status: 'disabled' })).toMatchObject({ countable: false, mark: '비활성' });
    expect(corpSiteStatus({ status: 'unreachable' })).toMatchObject({ countable: false, mark: '연결 실패' });
    expect(corpSiteStatus({ status: 'unreachable', stale: true, metrics: { hosts: 3 } })).toMatchObject({ countable: true, mark: '낡은 값' });
  });
  it('V6 serverCorpRows: pending vCenter 의 호스트·VM·합계는 null, 합계 표지는 제외 개수를 밝힌다', () => {
    const ov = {
      sites: [
        { id: 'a', status: 'connected', metrics: { hosts: 4, vms: 20, vmsPoweredOn: 18 } },
        { id: 'b', status: 'pending', metrics: { hosts: 0, vms: 0 } },
      ],
      physicalByCorp: { byVcenterPhysicalOnly: { a: 1, b: 2 } },
    };
    const rows = serverCorpRows(ov);
    expect(rows[0]).toMatchObject({ hosts: 4, vms: 20, total: 5 });
    expect(rows[1]).toMatchObject({ hosts: null, vms: null, total: null, vmsOn: null, physOnly: 2, mark: '첫 수집 중' });
    expect(corpTotalLabel(rows)).toMatch(/1곳 제외/);
    expect(corpTotalLabel(rows.slice(0, 1))).toBe('합계');
  });
  it('V6 서버 메뉴 합계 행이 부분 합 표지를 쓰고 행에 상태 표지를 단다', () => {
    const s = src('version_6/pages/MenuPage.jsx');
    expect(s).toMatch(/\{corpTotalLabel\(rows\)\}/);
    expect(s).toMatch(/r\.mark &&/);
  });
  it('개발 포탈 개요도 같은 판정을 쓴다', () => {
    const s = src('views/Overview.jsx');
    expect(s).toMatch(/corpSiteStatus\(s\)/);
    expect(s).not.toMatch(/const hosts = m\.hosts \|\| 0;/);
  });
});

describe('WEB2631-04 — data-sort 에 -1 같은 표지값을 쓰지 않는다(값 없음은 방향과 무관하게 뒤)', () => {
  it('빈 data-sort 는 empty 로 읽힌다(-1 은 숫자라 오름차순 맨 앞)', () => {
    expect(sortKeyOf('').kind).toBe('empty');
    expect(sortKeyOf('-1').kind).toBe('num');
  });
  it('웹 소스 전체에 data-sort={… ?? -1} · ?? 999 가 0건', () => {
    const bad = [];
    for (const f of walk(SRC_ROOT)) {
      const s = fs.readFileSync(f, 'utf8');
      const re = /data-sort=\{[^}]*\?\?\s*(-1|999)\b/g;
      let m;
      while ((m = re.exec(s))) bad.push(`${path.relative(SRC_ROOT, f)}:${m[0]}`);
      if (/data-sort=\{st === 'unknown' \? -1/.test(s)) bad.push(path.relative(SRC_ROOT, f));
    }
    expect(bad).toEqual([]);
  });
});

describe('WEB2631-05 — Explore Top 목록은 값 없음을 null%·null GB 로 그리지 않는다', () => {
  it('라벨이 unitText 를 쓰고 tb 가 null 을 가드한다', () => {
    const s = src('views/Explore.jsx');
    expect(s).not.toMatch(/`\$\{v\.cpuUsagePct\}%`/);
    expect(s).not.toMatch(/`\$\{h\.memUsagePct\}%`/);
    expect(s).not.toMatch(/`\$\{d\.usagePct\}%/);
    expect(s).toMatch(/const tb = \(gb\) => \{ const n = numOrNull\(gb\)/);
  });
});

describe('WEB2631-06 — V4 전산 화면 물리 서버 KPI 는 ESXi 호스트 수로 대체하지 않는다', () => {
  it('Compute.jsx 가 physicalServersKpi 를 쓴다', () => {
    const s = src('version_4/pages/Compute.jsx');
    expect(s).toMatch(/physicalServersKpi\(/);
    expect(s).not.toMatch(/phys\?\.servers \? fmtInt\(phys\.servers\) : fmtInt\(g\?\.hosts\)/);
  });
});

describe('WEB2631-07 — 폴링하지 않은 주기의 BMC 응답은 초록 0% 가 아니다', () => {
  it('ok+failed=0 이면 pct null · 중립 · 사유', () => {
    const st = bmcPollSummary({ ok: 0, failed: 0, skipped: '긴급중단', results: [] });
    expect(st).toMatchObject({ attempted: 0, pct: null, tone: 'neutral' });
    expect(st.reason).toMatch(/긴급중단/);
    expect(bmcPollSummary({ ok: 0, failed: 0, results: [] }).reason).toMatch(/대상/);
    expect(BMC_TONE_COLOR.neutral).not.toBe(BMC_TONE_COLOR.ok);
    expect(bmcPollSummary({ ok: 9, failed: 1 })).toMatchObject({ attempted: 10, pct: 90, tone: 'warn' });
    expect(bmcPollSummary({ ok: 5, failed: 0 }).tone).toBe('ok');
    expect(bmcPollSummary(null).pct).toBe(null);
  });
  it('관제 콘솔 설비 KPI 가 판정을 쓴다', () => {
    const s = src('console/pages/ConsoleFacility.jsx');
    expect(s).toMatch(/bmcPollSummary\(lr\)/);
    expect(s).not.toMatch(/lr\.failed \? '#f59e0b' : '#22c55e'/);
  });
});

describe('WEB2631-08 — 스토리지 사용률 KPI 는 사용량 미상 DS 제외를 말한다', () => {
  it('V4 스토리지·관제 콘솔 스토리지', () => {
    for (const f of ['version_4/pages/Storage.jsx', 'console/pages/ConsoleStorage.jsx']) {
      expect(src(f)).toMatch(/storageUsageUnknownNote\(g\)/);
    }
  });
});

describe('WEB2631-09 — 스토리지 증가 추이 카드: null 사용률은 (0%) 가 아니다', () => {
  it('dsTrendMeta', () => {
    expect(dsTrendMeta({ dsCapGB: 0, dsUsedGB: 0, dsUsagePct: null, dsCount: 5, dsUsedUnknown: 5 })).toMatch(/사용량을 읽은 데이터스토어 없음/);
    expect(dsTrendMeta({ dsCapGB: 0, dsUsedGB: 0, dsUsagePct: null, dsCount: 5, dsUsedUnknown: 5 })).not.toMatch(/0%|0 TB/);
    expect(dsTrendMeta({ dsCapGB: 2048, dsUsedGB: 1024, dsUsagePct: null })).toMatch(/\(—\)/);
    expect(dsTrendMeta({ dsCapGB: 2048, dsUsedGB: 1024, dsUsagePct: 50 })).toBe('사용 1 / 2 TB (50%)');
    expect(dsTrendMeta(null)).toMatch(/관측 전/);
  });
  it('VCenters.jsx 가 dsUsagePct || 0 을 쓰지 않는다', () => {
    expect(src('views/VCenters.jsx')).not.toMatch(/dsUsagePct \|\| 0/);
  });
});

describe('WEB2631-10 — VM 탭은 서버가 CPU 순으로 고른 N 개를 받는다', () => {
  it('params 에 sortBy/order 가 있고 부분 정렬 사실을 말한다', () => {
    const s = src('views/Vms.jsx');
    expect(s).toMatch(/sortBy: 'cpuUsagePct', order: 'desc'/);
    expect(s).toMatch(/안에서만 정렬됩니다/);
  });
});

describe('WEB2631-11 — 호스트 탭 vCore:물리 는 물리 코어 0 이면 —', () => {
  it('serverRatio/ratioLabel', () => {
    expect(ratioLabel(serverRatio(0, 0))).toBe('—');
    expect(ratioLabel(serverRatio(2.5, 40))).toBe('2.5 : 1');
    expect(src('views/Hosts.jsx')).not.toMatch(/\{s\.vcorePerCore\} : 1/);
  });
});

describe('WEB2631-12 — vCenter 상세는 vm-clone 도구 권한이 있을 때만 배지를 조회한다', () => {
  it('toolAllowed 게이트', () => {
    expect(src('views/VCenterDetail.jsx')).toMatch(/usePolling\(toolAllowed\('vm-clone'\) \? '\/tools\/vm-clone\/badges' : null/);
  });
});

// v2.631 리드 통합: V4 설비의 BMC 응답 KPI 도 bmcPollSummary 를 쓴다(시도 0대를 초록 0% 로 보이지 않는다).
it('WEB2631-07 V4 Facility 가 bmcPollSummary 를 쓴다', () => {
  const src = stripComments(fs.readFileSync(fileURLToPath(new URL('../version_4/pages/Facility.jsx', import.meta.url)), 'utf8'));
  expect(src).toMatch(/bmcPollSummary\(lr\)/);
  expect(src).not.toMatch(/Math\.max\(1, \(lr\.ok/);
});
