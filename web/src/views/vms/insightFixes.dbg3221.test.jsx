// dbg3221 — VM · 호스트 분석 화면 결함 회귀(1회차):
//   ① VM 수 추이 — 법인마다 첫 · 마지막 슬롯이 다르면 기준 합 · 증감을 만들지 않는다(서로 다른 시각의 점을 한 슬롯 이름으로 말하지 않는다)
//   ② 오래된 스냅샷 · 게스트 파티션 구간 이름 — 기준이 경계 이상이면 거꾸로 된 범위를 만들지 않는다
//   ③ 로그아웃 → 같은 창 재로그인 — 새 계정의 첫 구독이 계정 비우기에 잘리지 않는다
//   ④ 스냅샷 패널 행 보조 줄이 전역 사이드바 .sb 와 이름이 겹치지 않는다
//   ⑤ 게스트 파티션 값이 한 건도 없으면 ‘확인할 것’ 칸 · 패널 수가 0 이 아니라 ‘—’
//   ⑥ Hypervisor 분석 보기는 /hosts 전량을 폴링하지 않는다
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/_stripComments.js';

let pending = [];
vi.mock('../../api.js', async (orig) => {
  const real = await orig();
  return { ...real, fetchJson: () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }) };
});

const { trackView, gpBandLabels, guestPartView } = await import('./insight-tools/vmToolPanelsText.js');
const { snapBands } = await import('./vmInsightText.js');
const { buildToolChecks } = await import('./insight-tools/vmToolChecks.js');
const { _internals, _resetToolSummaryCells, _toolSummaryCellInfo } = await import('./insight-tools/useToolSummary.js');
const { noteAccount, _resetAccountForTest } = await import('../../accountReset.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../..');
const read = (rel) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));

beforeEach(() => { pending = []; _resetToolSummaryCells(); _resetAccountForTest(); });

describe('① VM 수 추이 — 기준 · 증감은 같은 슬롯끼리만', () => {
  const resp = {
    ok: true, days: 30, slots: ['2026-11-01T00', '2026-11-10T00', '2026-11-18T00'],
    rows: [
      { vcenterId: 'A', base: { slot: '2026-11-01T00', total: 100 }, current: { slot: '2026-11-18T00', total: 100 },
        points: [{ slot: '2026-11-01T00', total: 100 }, { slot: '2026-11-10T00', total: 100 }, { slot: '2026-11-18T00', total: 100 }] },
      { vcenterId: 'B', base: { slot: '2026-11-10T00', total: 50 }, current: { slot: '2026-11-18T00', total: 50 },
        points: [{ slot: '2026-11-10T00', total: 50 }, { slot: '2026-11-18T00', total: 50 }] },
    ],
  };
  it('창 중간에 수집을 시작한 법인이 있으면 기준 · 증감을 말하지 않는다(예전: 150 → 150 · +0 · 기준 11-01)', () => {
    const v = trackView(resp, []);
    expect(v.current).toBe(150);
    expect(v.base).toBeNull();
    expect(v.baseSlot).toBeNull();
    expect(v.diff).toBeNull();
    expect(v.slotsMixed).toBe(true);
    expect(v.points[0]).toMatchObject({ slot: '2026-11-01T00', total: 100, partial: true });
  });
  it('모든 법인의 첫 · 마지막 슬롯이 같으면 그 슬롯 이름으로 증감을 낸다', () => {
    const r = { ...resp, rows: [resp.rows[0], { ...resp.rows[1], base: { slot: '2026-11-01T00', total: 40 } }] };
    const v = trackView(r, []);
    expect(v).toMatchObject({ current: 150, base: 140, baseSlot: '2026-11-01T00', diff: 10, slotsMixed: false });
  });
  it('마지막 슬롯이 엇갈려도 증감을 말하지 않는다', () => {
    const r = { ...resp, rows: [resp.rows[0], { ...resp.rows[1], base: { slot: '2026-11-01T00', total: 40 }, current: { slot: '2026-11-10T00', total: 50 } }] };
    const v = trackView(r, []);
    expect(v.diff).toBeNull();
    expect(v.slotsMixed).toBe(true);
  });
  it('화면 문구 — 증감이 없을 때 엇갈림을 밝힌다', () => {
    const s = read('views/vms/insight-tools/VmToolPanels.jsx');
    expect(s).toMatch(/t\.slotsMixed \?/);
  });
});

describe('② 구간 이름 — 기준이 경계 이상이면 거꾸로 된 범위를 만들지 않는다', () => {
  it('스냅샷 기준 45일 → 45–90일 · 90일 이상(예전: 45–30일 · 30–90일)', () => {
    const b = snapBands({ snapAge: { d7_30: 0, d30_90: 1, d90p: 1 } }, { snapAgeDays: 45, snapAgeEdgesDays: [30, 90] });
    expect(b.map((x) => [x.label, x.n])).toEqual([['45–90일', 1], ['90일 이상', 1]]);
  });
  it('스냅샷 기준 120일 → 120일 이상 하나', () => {
    const b = snapBands({ snapAge: { d7_30: 0, d30_90: 0, d90p: 5 } }, { snapAgeDays: 120, snapAgeEdgesDays: [30, 90] });
    expect(b.map((x) => [x.label, x.n])).toEqual([['120일 이상', 5]]);
  });
  it('스냅샷 기준 30일(경계와 같음) → 30–90일 · 90일 이상', () => {
    const b = snapBands({ snapAge: { d7_30: 0, d30_90: 2, d90p: 1 } }, { snapAgeDays: 30, snapAgeEdgesDays: [30, 90] });
    expect(b.map((x) => x.label)).toEqual(['30–90일', '90일 이상']);
  });
  it('파티션 기준 90 → 90–95% · 95% 이상 · 기준 97 → 97% 이상', () => {
    expect(gpBandLabels(90, [85, 90, 95])).toEqual([null, null, '90–95%', '95% 이상']);
    expect(gpBandLabels(97, [85, 90, 95])).toEqual([null, null, null, '97% 이상']);
    expect(gpBandLabels(87, [85, 90, 95])).toEqual([null, '87–90%', '90–95%', '95% 이상']);
  });
  it('guestPartView 는 이름이 없는 빈 칸을 그리지 않는다(색은 원래 칸 번호대로)', () => {
    const v = guestPartView({ thresholds: { thr: 90, overBinEdges: [85, 90, 95] }, rows: [{ vcenterId: 'a', reported: 3, overVms: 2, overBins: [0, 0, 2, 1] }] }, []);
    expect(v.bands.map((b) => [b.key, b.label, b.n])).toEqual([['b2', '90–95%', 2], ['b3', '95% 이상', 1]]);
    for (const b of v.bands) {
      const m = /^(\d+)–(\d+)%$/.exec(b.label);
      if (m) expect(Number(m[1]), b.label).toBeLessThan(Number(m[2]));
    }
  });
});

describe('③ 로그아웃 → 같은 창 재로그인 — 새 계정의 첫 구독이 비우기에 잘리지 않는다', () => {
  it('Login 이 setUser 전에 계정을 알리면 이어지는 [user] 효과는 비우지 않고 구독이 값을 받는다', async () => {
    noteAccount('alice');
    noteAccount(null);                                  // 로그아웃 — 여기서 비운다
    noteAccount('alice');                               // Login onSuccess(동기 · setUser 전)
    // 같은 커밋에서 마운트된 VmInsight 의 자식 효과 — 칸을 만들고 구독 · 요청
    const c = _internals.cellOf('/tools/waste', null, {});
    const seen = [];
    c.subs.add((st) => seen.push(st));
    const p = _internals.load(c);
    expect(noteAccount('alice')).toBe(false);           // App 의 [user] 효과 — 같은 열쇠라 비우지 않는다
    expect(_toolSummaryCellInfo('/tools/waste')).not.toBeNull();
    pending[0].resolve({ rows: [{ vcenterId: 'va' }] });
    await p;
    expect(seen.at(-1)?.data?.rows?.[0]?.vcenterId).toBe('va');
  });
  it('소스: Login onSuccess 가 setUser 전에 noteAccount 를 부른다', () => {
    const app = read('App.jsx');
    expect(app).toMatch(/<Login onSuccess=\{\(u\) => \{ noteAccount\(accountKeyOf\(u\)\);[^}]*setUser\(u\); \}\}/);
  });
});

describe('④ 전역 사이드바 클래스(.sb · sb-*)와 이름이 겹치지 않는다', () => {
  const dirs = ['views/insight', 'views/vms', 'views/hosts'];
  const files = dirs.flatMap((d) => fs.readdirSync(path.join(SRC, d)).filter((f) => /\.(jsx|css)$/.test(f) && !/\.test\./.test(f)).map((f) => `${d}/${f}`));
  it('className 토큰 · CSS 선택자에 sb · sb-* 가 없다', () => {
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const s = read(f);
      if (f.endsWith('.css')) { expect(s, f).not.toMatch(/\.sb(?![\w-])|\.sb-/); continue; }
      for (const m of s.matchAll(/className=\{?\s*["'`]([^"'`]*)["'`]/g)) {
        for (const tok of m[1].split(/\s+/).filter(Boolean)) expect(tok === 'sb' || tok.startsWith('sb-'), `${f}: ${tok}`).toBe(false);
      }
    }
  });
  it('스냅샷 행 보조 줄은 ins-sb', () => {
    expect(read('views/vms/VmInsight.jsx')).toMatch(/<span className="ins-sb">/);
    expect(read('views/insight/insight.css')).toMatch(/\.ins-pr \.ins-sb/);
  });
});

describe('⑤ 파티션 값이 한 건도 없으면 0 이 아니라 모름', () => {
  const cold = { thresholds: { thr: 80, overBinEdges: [85, 90, 95] }, collect: { empty: true },
    rows: [{ vcenterId: 'a', guests: 10, reported: 0, notReported: 10, overVms: 0, overParts: 0, crit: 0, soon: 0, overBins: [0, 0, 0, 0] }] };
  it('guestPartView — noValues · 수는 null', () => {
    const v = guestPartView(cold, []);
    expect(v).toMatchObject({ noValues: true, overVms: null, overParts: null, crit: null, soon: null, reported: 0 });
    expect(v.bands.every((b) => b.n === null)).toBe(true);
  });
  it('확인할 것 칸 — ‘—’ 와 안내 · 톤 없음(예전: 0 · 위험 0)', () => {
    const [c] = buildToolChecks({ vcIds: [], canTool: (k) => k === 'guest-partition', gp: { data: cold } });
    expect(c).toMatchObject({ key: 'disk-filling', value: '—', sub: '아직 수집된 파티션 값이 없습니다', tone: '' });
  });
  it('값을 받은 VM 이 있으면 0 은 정상 0', () => {
    const warm = { ...cold, collect: null, rows: [{ ...cold.rows[0], reported: 7 }] };
    const [c] = buildToolChecks({ vcIds: [], canTool: () => true, gp: { data: warm } });
    expect(c.value).toBe('0');
    expect(guestPartView(warm, []).noValues).toBe(false);
  });
});

describe('⑥ Hypervisor 분석 보기는 /hosts 전량을 폴링하지 않는다', () => {
  const s = read('views/Hosts.jsx');
  it('usePolling 경로는 분석 보기에서 null · 보기는 훅 위에서 정한다', () => {
    expect(s).toMatch(/usePolling\(view === 'insight' \? null : '\/hosts', filters, 15_000\)/);
    expect(s.indexOf('const view = hostViewOf(')).toBeLessThan(s.indexOf('usePolling('));
  });
  it('빠른 확인은 그 호스트 하나(/hosts/:id)만 받는다 — 목록 행에 기대지 않는다', () => {
    const q = s.slice(s.indexOf('const quickHost'), s.indexOf('const openCorp'));
    expect(q).not.toMatch(/rows\.find/);
    expect(q).toMatch(/openHostById\(id\)/);
    expect(s).toMatch(/fetchJson\(`\/hosts\/\$\{encodeURIComponent\(id\)\}`\)/);
  });
});
