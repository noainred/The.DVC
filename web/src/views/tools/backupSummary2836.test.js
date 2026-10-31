/**
 * v2.836 백업 메뉴 개편 1-b — Summary(사용자 요청 '서머리에는 veeam/bareos/ssh 3개를 합쳐 BackedUp · 백업 안함 · 확인 필요' ·
 *   '폴더를 클릭하면 VM list' · '지정한 시간만큼 백업되지 않은 VM 찾기' · 'Summary/Detail 에서 Clone/snapshot 제거' + 시안 ①).
 *   ① 세 묶음 · RPO · KPI · 정렬 · 찾기 조건(순수) ② 서버 법인 집계와 웹 폴더 집계가 같은 VM 행에 같은 수(대조)
 *   ③ 화면 소스 — 폴링 없음 · 판정 코어 하나(Detail 응답 + buildTree) · 스냅샷 · Clone 문구 없음
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { BACKED_UP_KEYS, BUNDLES, bundlesOf, siteRpo, summaryPolicyKpis, sortSites, siteNote, staleQuery, staleQueryMatches, SUMMARY_STALE_KEY } from './backupSummaryText.js';
import { buildTree, loadStaleOpts, saveStaleOpts, STALE_DEFAULT } from './backupViewText.js';
import * as AG from '../../../../server/src/veeam/backupSummaryAgg.js';

const H = 3_600_000; const DAY = 24 * H;
const NOW = 1_800_000_000_000;
const row = (o) => ({ id: o.id, name: o.id, folder: o.folder || 'DC/vm/A', power: 'POWERED_ON', gb: 10, p: o.p, a: o.a ?? { v: false, b: false },
  mm: 'mm' in o ? o.mm : false, lok: o.lok ?? { at: null, never: true, v: null, b: null, vk: true, bk: true }, ...(o.e ? { e: o.e } : {}) });
const ok = (t) => ({ at: t, never: false, v: t, b: null, vk: true, bk: true });
const VMS = [
  row({ id: 'v1', p: 'veeam', a: { v: true, b: false }, lok: ok(NOW - 2 * H) }),
  row({ id: 'v2', p: 'bareos', mm: true }),
  row({ id: 'v3', p: 'ssh', folder: 'DC/vm/B' }),
  row({ id: 'v4', p: 'none', folder: 'DC/vm/B' }),
  row({ id: 'v5', p: 'check', a: { v: true, b: false }, mm: true, lok: ok(NOW - 4 * DAY), folder: 'DC/vm/B/C', e: [{ s: 'veeam', r: 'fail', at: NOW - H }] }),
  row({ id: 'v6', p: 'veeam', a: { v: null, b: false }, mm: null, lok: { at: null, never: null, v: null, b: null, vk: false, bk: true } }),
];

describe('v2.836 Summary — 세 묶음 · RPO · KPI · 정렬', () => {
  it('BackedUp = Veeam + Bareos + SSH(서버와 같은 키) · 정책을 모르면 null', () => {
    expect([...BACKED_UP_KEYS]).toEqual([...AG.BACKED_UP_KEYS]);
    expect(BUNDLES.map((b) => b.text)).toEqual(['BackedUp', '백업 안함', '확인 필요']);
    expect(bundlesOf({ n: 10, pol: { veeam: 3, bareos: 2, ssh: 1, none: 2, check: 2 }, polUnk: 0 })).toEqual({ n: 10, backed: 6, none: 2, check: 2, unk: 0, parts: { veeam: 3, bareos: 2, ssh: 1 } });
    expect(bundlesOf({ n: 3, pol: null, polUnk: 3 })).toBe(null);
    expect(bundlesOf({ n: 2, pol: { veeam: 1, bareos: 0, ssh: 0, none: 0, check: 0, unk: 1 } }).unk).toBe(1);   // 웹 폴더 집계 모양(pol.unk)
  });
  it('RPO — 대상(충족+미달)이 없으면 비율 없음 · 모름은 따로', () => {
    const pa = { rpo: { d1: { ok: 3, miss: 1, unk: 2 }, d3: { ok: 0, miss: 0, unk: 4 }, d7: { ok: 4, miss: 0, unk: 0 } } };
    expect(siteRpo(pa, 1)).toEqual({ ok: 3, miss: 1, unk: 2, pct: 75 });
    expect(siteRpo(pa, 3).pct).toBe(null);
    expect(siteRpo(pa, 99).pct).toBe(75);   // 모르는 기준은 1일
    expect(siteRpo(null, 1)).toBe(null);
  });
  it('KPI — 합계가 없으면 —(0 이 아니다) · 정책을 못 읽은 법인이 있으면 부분 합 *', () => {
    expect(summaryPolicyKpis({}).backed.value).toBe('—');
    const t = { vcenters: 2, pa: { ...AG.sumSiteAggs([]), n: 5, on: 4, pol: { veeam: 2, bareos: 1, ssh: 0, none: 1, check: 1 }, polUnkSites: 1 } };
    const k = summaryPolicyKpis(t, { rpoDays: 1 });
    expect([k.backed.value, k.none.value, k.check.value]).toEqual(['3*', '1*', '1*']);
    expect(k.backed.sub).toMatch(/Veeam 2 · Bareos 1 · SSH 0 · 표시 파일을 못 읽은 법인 1곳 제외/);
    expect(k.vm.value).toBe('5');
    expect(k.rpo.value).toBe('—');   // 대상 없음
  });
  it('정렬 — 모르는 값은 방향과 무관하게 뒤 · 같은 값은 이름 순', () => {
    const rows = [
      { name: 'b', pa: { n: 10, pol: { veeam: 5, bareos: 0, ssh: 0, none: 0, check: 5 }, gb: 100, gbUnk: 0, lok: 5 } },
      { name: 'a', pa: { n: 10, pol: { veeam: 9, bareos: 0, ssh: 0, none: 0, check: 1 }, gb: 50, gbUnk: 0, lok: null } },
      { name: 'c', pa: { n: 0, pol: null, gb: 0, gbUnk: 0 } },
    ];
    expect(sortSites(rows, 'backed', 'desc').map((r) => r.name)).toEqual(['a', 'b', 'c']);
    expect(sortSites(rows, 'backed', 'asc').map((r) => r.name)).toEqual(['b', 'a', 'c']);
    expect(sortSites(rows, 'lok', 'asc').map((r) => r.name)).toEqual(['b', 'a', 'c']);
    expect(sortSites(rows, 'name', 'desc').map((r) => r.name)).toEqual(['c', 'b', 'a']);
    expect(sortSites(rows, 'gb', 'asc').map((r) => r.name)).toEqual(['a', 'b', 'c']);   // c 는 VM 0대 — 용량 모름
  });
  it('법인 이름 아래 — 못 읽은 쪽을 밝힌다', () => {
    expect(siteNote({ veeamState: 'unlinked', bareosUnknown: true })).toBe('Veeam 연동 없음 · Bareos 원장 못 읽음');
    expect(siteNote({ veeamState: 'ok', pa: { pol: null } })).toBe('정책 모름');
    expect(siteNote({ veeamState: 'ok', pa: { pol: {} } })).toBe('');
  });
});

describe('v2.836 전체 법인 찾기 — 조건', () => {
  it('쿼리 — 서버 staleQueryOf 가 같은 조건으로 읽는다 · 기간이 틀리면 부르지 않는다', () => {
    const o = { n: 12, unit: 'h', src: 'bareos', excludeNone: false, onlyOn: true, includeNever: false };
    const q = staleQuery(o, { power: 'on', excl: false });
    expect(q).toEqual({ n: '12', unit: 'h', src: 'bareos', excludeNone: '0', onlyOn: '1', includeNever: '0', power: 'on', excl: '0' });
    const s = AG.staleQueryOf(q);
    expect([s.n, s.unit, s.src, s.excludeNone, s.onlyOn, s.includeNever, s.windowMs]).toEqual([12, 'h', 'bareos', false, true, false, 12 * H]);
    expect(staleQuery({ ...o, n: 0 })).toBe(null);
    expect(staleQuery({ ...o, n: '' })).toBe(null);
    expect(staleQueryMatches({ q: { n: 12, unit: 'h', src: 'bareos', excludeNone: false, onlyOn: true, includeNever: false } }, o)).toBe(true);
    expect(staleQueryMatches({ q: { n: 3, unit: 'h', src: 'bareos', excludeNone: false, onlyOn: true, includeNever: false } }, o)).toBe(false);
    expect(staleQueryMatches(null, o)).toBe(false);
  });
  it('조건 기억 — Summary 와 Detail 은 따로(같은 저장소 · 다른 키)', () => {
    const mem = new Map();
    const st = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
    saveStaleOpts({ ...STALE_DEFAULT, n: 9, unit: 'w' }, st, SUMMARY_STALE_KEY);
    expect(loadStaleOpts(st, SUMMARY_STALE_KEY)).toMatchObject({ n: 9, unit: 'w' });
    expect(loadStaleOpts(st)).toEqual({ ...STALE_DEFAULT });
  });
});

describe('v2.836 서버 법인 집계 ↔ 웹 폴더 집계(같은 VM 행)', () => {
  it('BackedUp · 백업 안함 · 확인 필요 · 실제 · 불일치 · RPO · 실패 · 마지막 백업이 같다', () => {
    const pa = AG.newSiteAgg(); for (const v of VMS) AG.addSiteVm(pa, v, NOW);
    const f = AG.finishSiteAgg(pa);
    for (const d of [1, 3, 7]) {
      const tree = buildTree(VMS, { rpoDays: d, now: NOW });
      const a = tree.agg;
      const sb = bundlesOf(f); const wb = bundlesOf(a);
      expect(wb).toEqual(sb);
      expect({ v: a.act.v, b: a.act.b, none: a.act.none, unk: a.act.unk }).toEqual(f.act);
      expect(a.mm).toBe(f.mm);
      expect([a.rpoOk, a.rpoMiss]).toEqual([f.rpo[`d${d}`].ok, f.rpo[`d${d}`].miss]);
      expect(a.err).toBe(f.err.vms);
      expect(a.lok).toBe(f.lok);
      expect(a.n).toBe(f.n);
    }
  });
});

describe('v2.836 화면 소스', () => {
  const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const sum = read('./BackupSummaryTool.jsx'); const tree = read('./BackupSummaryTree.jsx'); const stale = read('./BackupSummaryStale.jsx');
  it('폴링하지 않는다 · 늦게 온 응답은 버린다', () => {
    for (const s of [sum, tree, stale]) expect(s).not.toMatch(/usePolling|setInterval/);
    expect(tree).toMatch(/if \(gens\.current\.get\(id\) === my\)/);
    expect(stale).toMatch(/if \(my === gen\.current\) setData\(r\)/);
  });
  it('폴더 · VM 은 그 법인의 Detail 응답을 buildTree 로(판정 코어 하나) · 찾기는 서버 API', () => {
    expect(tree).toMatch(/fetchJson\('\/tools\/backup-detail', \{ vcenterId: id, \.\.\.scopeQuery\(opts\) \}\)/);
    expect(tree).toMatch(/buildTree\(s\.data\.vms, \{ rpoDays: opts\.rpoDays, now: s\.data\.at \}\)/);
    expect(stale).toMatch(/fetchJson\('\/tools\/backup-summary\/stale', params\)/);
  });
  it('Summary 에는 스냅샷 · Clone 문구와 기능이 없다(사용자 요청 — 주석은 빼고 본다)', () => {
    for (const s of [sum, tree, stale]) expect(strip(s)).not.toMatch(/스냅샷|snapshot|Clone ·|cloneCell|snapCell|coverageOf|PRIO_TABS/i);
  });
  it('순서 — 숫자 줄 → 두 솔루션 → 찾기 → 트리 표', () => {
    const i = (s) => sum.indexOf(s);
    expect(i('data-backup-kpis')).toBeGreaterThan(0);
    expect(i('data-backup-sol="veeam"')).toBeGreaterThan(i('data-backup-kpis'));
    expect(i('<BackupSummaryStale ')).toBeGreaterThan(i('data-backup-sol="bareos"'));
    expect(i('<BackupSummaryTree ')).toBeGreaterThan(i('<BackupSummaryStale '));
  });
});
