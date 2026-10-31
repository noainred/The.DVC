// v2.828 Bareos 조회 화면 · 백업 방식 Bareos — 웹 판정이 서버와 같은가 · 모름은 0 이 아닌가 · 넘기기 · 하위 탭 권한
import { describe, it, expect } from 'vitest';
import { bareosClass, detailFilterCounts, rowMatches, buildBareosTree, saveBareosHandoff, takeBareosHandoff, bareosSubTabs, resultBar, numText, BAREOS_HANDOFF_KEY } from './bareosViewText.js';
import { bareosCell, METHODS, NOT_VEEAM_GAP, METHOD_KEYS_MAP, vmMatches } from './backupViewText.js';
import { bareosClass as serverClass } from '../../../../server/src/bareos/vmView.js';
import { METHOD_TEXT, NOT_VEEAM_GAP as SERVER_GAP, vmViewMatches } from '../../../../server/src/veeam/backupStatus.js';

const NOW = Date.UTC(2026, 9, 30, 12);
const DAY = 86_400_000;
const B = [
  undefined, null, { job: false },
  { job: true, on: true, st: 'ok', ok: NOW - 2 * 3_600_000 },
  { job: true, on: true, st: 'ok', ok: NOW - 2 * DAY },
  { job: true, on: false, st: 'error', ok: NOW - 10 * DAY },
  { job: true, on: true, st: null, ok: null, run: 'running' },
  { job: true, on: true, st: 'warning', ok: NOW - DAY / 2, gone: true },
  { job: true, on: true, st: 'canceled', ok: null },
];

describe('v2.828 Bareos 판정 — 서버와 한 쌍', () => {
  it('bareosClass 는 서버 bareos/vmView.js 와 같은 입력에 같은 답', () => {
    for (const d of [1, 3, 7]) for (const b of B) expect(bareosClass(b, { rpoDays: d, now: NOW }), JSON.stringify(b)).toEqual(serverClass(b, { rpoDays: d, now: NOW }));
  });
  it('백업 방식 Bareos — 글자·순서·단축키 B · Veeam 미백업이 아닌 방식 목록이 서버와 같다', () => {
    expect(METHODS.map((m) => [m.key, m.text])).toEqual(Object.entries(METHOD_TEXT));
    expect(METHOD_KEYS_MAP.b).toBe('bareos');
    expect([...NOT_VEEAM_GAP]).toEqual([...SERVER_GAP]);
    const vms = [{ id: 'a', m: { method: 'bareos', need: true }, v: null, s: { ev: null } }, { id: 'b', b: { job: false } }, { id: 'c', b: null }, { id: 'd', b: { job: true, on: true, st: 'ok', ok: NOW } }];
    for (const f of ['needgap', 'bareos', 'bareos-missing']) for (const v of vms) expect(vmMatches(v, f, { now: NOW }), `${f}/${v.id}`).toBe(vmViewMatches(v, f, { now: NOW }));
  });
});

describe('v2.828 Bareos 칸 · 필터 · 트리', () => {
  it('bareosCell — 모름 · 미등록 · 성공 · 경고 · 실패 · 진행 · 잡 꺼짐(키 없으면 null)', () => {
    expect(bareosCell({ id: 'x' })).toBe(null);
    expect(bareosCell({ b: null }).text).toBe('Bareos · 모름');
    expect(bareosCell({ b: { job: false } }).text).toBe('Bareos · 미등록');
    expect(bareosCell({ b: { job: true, on: true, st: null, run: 'running' } }).text).toBe('Bareos · 진행 중');
    expect(bareosCell({ b: { job: true, on: false, st: 'error', at: NOW } }).tone).toBe('bareosBad');
    expect(bareosCell({ b: { job: true, on: false, st: 'error', at: NOW } }).text).toMatch(/잡 꺼짐$/);
    expect(bareosCell({ b: { job: true, on: true, st: 'warning', at: NOW } }).tone).toBe('bareosWarn');
    expect(bareosCell({ b: { job: true, on: true, st: 'ok', at: NOW } }).tone).toBe('bareos');
  });
  it('결과를 모르는 법인은 결과 기준 필터 수가 null(—) · 방식 불일치는 인벤토리에 있는 VM 만', () => {
    const rows = [
      { method: 'bareos', b: { job: true, on: true, st: 'error', ok: NOW - 3 * DAY } },
      { method: 'veeam', b: { job: true, on: true, st: 'ok', ok: NOW } },
      { method: '', gone: true, b: { job: true, on: true, st: 'ok', ok: NOW, gone: true } },
      { method: 'bareos', b: { job: false } },
    ];
    const c = detailFilterCounts(rows, { now: NOW });
    expect([c.job, c.missing, c.bad, c.old, c.mismatch, c.gone]).toEqual([3, 1, 1, 1, 1, 1]);
    const u = detailFilterCounts(rows, { now: NOW, resultsKnown: false });
    expect([u.bad, u.old, u.run, u.never, u.job]).toEqual([null, null, null, null, 3]);
    expect(rowMatches(rows[0], 'bad', { now: NOW, resultsKnown: false })).toBe(false);
    expect(numText(null)).toBe('—'); expect(numText(0)).toBe('0');
    expect(resultBar({ jobs: 4, ok: null })).toBe(null);
    expect(resultBar({ jobs: 4, ok: 2, warn: 1, fail: 1, run: 0 })).toEqual({ ok: 50, warn: 25, fail: 25, run: 0 });
  });
  it('폴더 트리 — 집계는 보기와 무관한 전체 · 보기에 든 행만 담는다', () => {
    const rows = [
      { id: '1', name: 'a', folder: 'A/x', method: 'bareos', b: { job: true, on: true, st: 'ok', ok: NOW } },
      { id: '2', name: 'b', folder: 'A/x', method: 'bareos', b: { job: false } },
      { id: '3', name: 'c', folder: 'B', method: 'bareos', b: { job: true, on: true, st: 'error', ok: null } },
    ];
    const t = buildBareosTree(rows, { filter: 'missing', now: NOW });
    expect(t.children.map((x) => x.name)).toEqual(['A']);
    const a = t.children[0];
    expect(a.agg).toMatchObject({ n: 2, job: 1, ok: 1, missing: 1 });
    expect(a.children[0].rows.map((r) => r.id)).toEqual(['2']);
  });
});

describe('v2.828 넘기기 · 하위 탭', () => {
  it('Detail → Bareos 관리 화면 넘기기 — 한 번 읽고 지운다 · 200대 · 10분', () => {
    const m = new Map();
    const store = { setItem: (k, v) => m.set(k, v), getItem: (k) => m.get(k) ?? null, removeItem: (k) => m.delete(k) };
    expect(saveBareosHandoff('vc-a', Array.from({ length: 250 }, (_, i) => `vc-a:vm-${i}`), store)).toBe(true);
    const h = takeBareosHandoff(store);
    expect(h.vcenterId).toBe('vc-a'); expect(h.vmIds.length).toBe(200);
    expect(takeBareosHandoff(store)).toBe(null);
    m.set(BAREOS_HANDOFF_KEY, JSON.stringify({ vcenterId: 'vc-a', vmIds: ['x'], at: Date.now() - 11 * 60_000 }));
    expect(takeBareosHandoff(store)).toBe(null);
  });
  it('하위 탭 — 조회 전용 탭은 권한만 · 관리 탭은 admin + bareos-backup · 설정은 전체 범위', () => {
    // v2.839 '정책 · 일정'(policy) — 조회 전용 키(bareos-summary) 권한만으로 보인다
    expect(bareosSubTabs({ summaryOk: true, detailOk: true }).map((t) => t[0])).toEqual(['summary', 'detail', 'policy']);
    expect(bareosSubTabs({ summaryOk: true, detailOk: true, manageOk: true, admin: false }).map((t) => t[0])).toEqual(['summary', 'detail', 'policy']);
    expect(bareosSubTabs({ summaryOk: true, detailOk: true, manageOk: true, admin: true }).map((t) => t[0])).toEqual(['summary', 'detail', 'live', 'targets', 'groups', 'policy', 'history']);
    expect(bareosSubTabs({ summaryOk: true, detailOk: true, manageOk: true, admin: true, fullScope: true }).map((t) => t[0])).toEqual(['summary', 'detail', 'live', 'targets', 'groups', 'policy', 'history', 'settings']);
    expect(bareosSubTabs({ detailOk: true }).map((t) => t[0])).toEqual(['detail'], 'bareos-summary 권한이 없으면 정책 · 일정도 없다');
  });
});

describe('v2.828 레벨 글자', () => {
  it('카탈로그 한 글자도 낱말로 — 화면에 I·F 가 그대로 나가지 않는다(Chromium 판독)', async () => {
    const { lvText, runLine } = await import('./bareosViewText.js');
    expect([lvText('I'), lvText('F'), lvText('D'), lvText('Full'), lvText(''), lvText('X')]).toEqual(['Incremental', 'Full', 'Differential', 'Full', '—', 'X']);
    expect(runLine({ job: true, lv: 'I', by: 0 })).toBe('Incremental · 0 B');
  });
});
