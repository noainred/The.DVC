import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  findStale, staleReason, staleWindowMs, agoText, rpoCell, mismatchCell, lastOkText, nextText, errText, policyGbTotals, folderRpoPct, buildTree,
  saveBareosGroupHandoff, takeBareosGroupHandoff, loadStaleOpts, saveStaleOpts, STALE_DEFAULT, filterCountText, CHIP_GROUPS, ALL_FILTERS, METHOD_KEYS_MAP, POLICIES,
} from './backupViewText.js';

// v2.835 백업 메뉴 개편 1차 — Detail 의 백업 정책 · 실제 백업 · 정책≠실제 · RPO · 백업 안 된 VM 찾기(판정은 서버 — 화면은 창 비교와 문구만)
const H = 3_600_000; const DAY = 24 * H;
const NOW = Math.floor(Date.now() / H) * H;
const lok = (o) => ({ at: null, never: null, v: null, b: null, vk: true, bk: true, ...o });
const VM = (id, o = {}) => ({ id, name: id, folder: 'DC/vm/A', power: 'POWERED_ON', p: 'veeam', a: { v: false, b: false }, mm: true, lok: lok({ never: true }), ...o });

describe('백업 안 된 VM 찾기', () => {
  it('기간 — 1~999 정수만 · 단위 시간·일·주', () => {
    expect([staleWindowMs(3, 'd'), staleWindowMs(12, 'h'), staleWindowMs(2, 'w')]).toEqual([3 * DAY, 12 * H, 14 * DAY]);
    expect([staleWindowMs(0, 'd'), staleWindowMs(1000, 'd'), staleWindowMs(1.5, 'd'), staleWindowMs('', 'd'), staleWindowMs(3, 'm')]).toEqual([null, null, null, null, null]);
  });
  it('요약 · 순서(한 번도 없음 → 오래된 순 → 모름) · 범위 제외 수 · 모름은 n 에 넣지 않는다', () => {
    const vms = [
      VM('ok', { lok: lok({ at: NOW - H, v: NOW - H }) }),
      VM('old5', { lok: lok({ at: NOW - 5 * DAY, v: NOW - 5 * DAY }) }),
      VM('old9', { lok: lok({ at: NOW - 9 * DAY, v: NOW - 9 * DAY }) }),
      VM('never'),
      VM('unk', { lok: lok({ vk: false }) }),
      VM('none', { p: 'none' }),
      VM('off', { power: 'POWERED_OFF' }),
    ];
    const r = findStale(vms, { ...STALE_DEFAULT, now: NOW });
    expect(r.rows.map((x) => x.vm.id)).toEqual(['never', 'old9', 'old5', 'unk']);
    expect([r.n, r.never, r.old, r.unknown, r.excluded.none, r.excluded.off]).toEqual([3, 1, 2, 1, 1, 1]);
    const all = findStale(vms, { ...STALE_DEFAULT, excludeNone: false, onlyOn: false, now: NOW });
    expect(all.rows.map((x) => x.vm.id).sort()).toEqual(['never', 'none', 'off', 'old5', 'old9', 'unk']);
    expect(findStale(vms, { ...STALE_DEFAULT, n: 0, now: NOW })).toMatchObject({ rows: [], n: 0, windowMs: null });
  });
  it('이유 — 정책 미정 · 정책≠실제 · SSH · 최근 실패 · 한 번도 없음 · 경과', () => {
    expect(staleReason({ kind: 'unknown', vm: VM('x', { a: { v: null, b: false } }) })).toMatch(/Veeam 결과를 읽지 못함/);
    expect(staleReason({ kind: 'never', vm: VM('x', { p: 'check', mm: false }) })).toMatch(/정하지 않음/);
    expect(staleReason({ kind: 'never', vm: VM('x') })).toMatch(/Veeam 백업 대상에 없음/);
    expect(staleReason({ kind: 'never', vm: VM('x', { p: 'bareos' }) })).toMatch(/Bareos 잡이 없음/);
    expect(staleReason({ kind: 'never', vm: VM('x', { p: 'ssh', mm: false }) })).toMatch(/SSH/);
    expect(staleReason({ kind: 'old', last: NOW - 2 * DAY, vm: VM('x', { mm: false, e: [{ s: 'veeam', r: 'fail', at: NOW }] }) })).toBe('최근 실패 — Veeam');
    expect(staleReason({ kind: 'old', last: NOW - 2 * DAY - 3 * H, vm: VM('x', { mm: false }) }, NOW)).toBe('마지막 성공이 2일 3시간 전');
    expect([agoText(40 * 60_000), agoText(5 * H), agoText(3 * DAY), agoText(null)]).toEqual(['40분', '5시간', '3일', '—']);
  });
  it('조건 기억 — 모르는 값은 기본 · 저장 실패해도 동작', () => {
    const mem = new Map(); const st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
    expect(loadStaleOpts(st)).toEqual({ ...STALE_DEFAULT });
    saveStaleOpts({ n: 12, unit: 'h', src: 'bareos', excludeNone: false, onlyOn: true, includeNever: false }, st);
    expect(loadStaleOpts(st)).toEqual({ n: 12, unit: 'h', src: 'bareos', excludeNone: false, onlyOn: true, includeNever: false });
    st.setItem('backup-detail.stale', JSON.stringify({ n: -1, unit: 'y', src: 'tape' }));
    expect(loadStaleOpts(st)).toMatchObject({ n: 3, unit: 'd', src: 'all' });
    expect(loadStaleOpts({ getItem: () => { throw new Error('blocked'); } })).toEqual({ ...STALE_DEFAULT });
  });
});

describe('칸 문구 · 폴더 집계', () => {
  it('RPO — 백업 안함은 대상 아님 · 충족 · 미달 · 한 번도 없음 · 모름', () => {
    const o = { rpoDays: 1, now: NOW };
    expect(rpoCell(VM('x', { p: 'none' }), o).text).toBe('대상 아님');
    expect(rpoCell(VM('x', { lok: lok({ at: NOW - H, v: NOW - H }) }), o)).toEqual({ text: '충족', tone: 'ok' });
    expect(rpoCell(VM('x', { lok: lok({ at: NOW - 2 * DAY, v: NOW - 2 * DAY }) }), o)).toEqual({ text: '미달 2일', tone: 'bad' });
    expect(rpoCell(VM('x'), o).text).toBe('한 번도 없음');
    expect(rpoCell(VM('x', { lok: lok({ bk: false }) }), o).text).toBe('모름');
    expect(rpoCell(VM('x', { power: 'POWERED_OFF', lok: lok({ at: NOW - 2 * DAY, v: NOW - 2 * DAY }) }), o).tone).toBe('bad', '꺼진 VM 도 RPO 는 본다');
    expect(rpoCell({ id: 'x' }, o).text).toBe('—', '정책을 모르면');
  });
  it('정책≠실제 — 일치 · 불일치(다음 할 일) · SSH 는 — · 모름', () => {
    expect(mismatchCell(VM('x', { mm: null })).text).toBe('모름');
    expect(mismatchCell(VM('x', { p: 'ssh', mm: false })).text).toBe('—');
    expect(mismatchCell(VM('x', { mm: false })).text).toBe('일치');
    expect(mismatchCell(VM('x')).why).toMatch(/Veeam 백업 실행/);
    expect(mismatchCell(VM('x', { p: 'bareos' })).why).toMatch(/Bareos 대상 등록/);
    expect(mismatchCell(VM('x', { p: 'check', a: { v: true, b: false } }))).toMatchObject({ why: '실제는 Veeam → 정책을 Veeam 로', short: '실제 Veeam' });
    expect(mismatchCell(VM('x', { p: 'none', a: { v: true, b: true } })).short).toBe('실제 Veeam·Bareos');
  });
  it('마지막 성공 · 다음 예정 · 24시간 실패 문구', () => {
    expect([lastOkText(VM('x')), lastOkText(VM('x', { lok: lok({ vk: false }) }))]).toEqual(['없음', '모름']);
    expect(lastOkText(VM('x', { lok: lok({ at: NOW }) }))).toMatch(/^\d\d-\d\d \d\d:\d\d$/);
    expect(nextText(VM('x'))).toBe('—');
    expect(nextText(VM('x', { nx: { at: NOW + H, g: 'nightly', lv: 'Incremental' } }))).toMatch(/ · nightly$/);
    expect(errText(VM('x', { e: [{ s: 'veeam', r: 'fail' }, { s: 'bareos', r: 'warn' }] }))).toBe('Veeam 실패 · Bareos 경고');
    expect(errText(VM('x'))).toBe('');
  });
  it('정책별 용량 · 폴더 집계(정책 5범주 · 실제 · 불일치 · RPO · 실패 · 마지막 성공 · 다음)', () => {
    const vms = [
      VM('a', { gb: 10, p: 'veeam', a: { v: true, b: false }, mm: false, lok: lok({ at: NOW - H, v: NOW - H }) }),
      VM('b', { gb: 20, p: 'bareos', a: { v: false, b: false }, mm: true, e: [{ s: 'bareos', r: 'fail' }], nx: { at: NOW + 2 * H } }),
      VM('c', { gb: null, p: 'none', a: { v: false, b: null }, mm: null, nx: { at: NOW + H } }),
    ];
    expect(policyGbTotals(vms)).toEqual({ all: 30, unknown: 1, veeam: 10, bareos: 20, ssh: 0, none: 0, check: 0 });
    expect(policyGbTotals(vms, { marksUnreadable: true })).toMatchObject({ all: 30, veeam: null, check: null });
    const a = buildTree(vms, { rpoDays: 1, now: NOW }).children[0].agg;
    expect(a.pol).toEqual({ veeam: 1, bareos: 1, ssh: 0, none: 1, check: 0, unk: 0 });
    expect(a.act).toEqual({ v: 1, b: 0, none: 1, unk: 1 });
    expect([a.mm, a.rpoOk, a.rpoMiss, a.err, a.lok, a.nx]).toEqual([1, 1, 1, 1, NOW - H, NOW + H]);
    expect([folderRpoPct(a), folderRpoPct({ rpoOk: 0, rpoMiss: 0 })]).toEqual([50, null]);
  });
  it('칩 수 — 표시·Bareos·Veeam 을 모르면 그 칩은 —', () => {
    const c = { mismatch: 3, 'policy-ssh': 2, 'act-bareos': 4, 'act-veeam': 5, 'act-none': 1, run: 7 };
    expect([filterCountText('mismatch', c, true), filterCountText('policy-ssh', c, true), filterCountText('run', c, true)]).toEqual(['—', '—', 7]);
    expect([filterCountText('act-bareos', c, false, true), filterCountText('act-none', c, false, true)]).toEqual(['—', '—']);
    expect([filterCountText('act-veeam', c, false, false, true), filterCountText('act-bareos', c, false, false, true)]).toEqual(['—', 4]);
    for (const [, keys] of CHIP_GROUPS) for (const k of keys) expect(ALL_FILTERS.some(([x]) => x === k), k).toBe(true);
    expect(Object.keys(METHOD_KEYS_MAP)).toEqual(['v', 'b', 's', 'n', 'k']);
    expect(POLICIES.map((m) => m.text)).toEqual(['Veeam', 'Bareos', 'SSH', '백업 안함', '확인 필요']);
  });
});

describe('Bareos 그룹 등록 handoff · 화면 소스', () => {
  it('한 번 읽고 지운다 · 10분 · 200대 · 모양이 틀리면 null', () => {
    const mem = new Map(); const st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
    expect(saveBareosGroupHandoff('vc-a', Array.from({ length: 250 }, (_, i) => `vc-a:vm-${i}`), st)).toBe(true);
    const h = takeBareosGroupHandoff(st);
    expect([h.vcenterId, h.vmIds.length]).toEqual(['vc-a', 200]);
    expect(takeBareosGroupHandoff(st)).toBe(null, '한 번만');
    saveBareosGroupHandoff('vc-a', ['x'], st);
    expect(takeBareosGroupHandoff(st, Date.now() + 11 * 60_000)).toBe(null, '10분 지나면 버린다');
    st.setItem('bareos-backup.group-handoff', '{"vcenterId":1}');
    expect(takeBareosGroupHandoff(st)).toBe(null);
  });
  it('Detail — 도구 줄 순서(선택 → 정책 → 실제 거르기 → 백업 등록) · SSH 등록은 준비 중(누르지 못함) · 그룹 화면이 handoff 를 받는다', () => {
    const det = fs.readFileSync(new URL('./BackupDetailTool.jsx', import.meta.url), 'utf8');
    const i = (s) => det.indexOf(s);
    expect(i('data-backup-policy-bar')).toBeGreaterThan(0);
    expect(i('백업 방식(실제로 도는 백업) 거르기')).toBeGreaterThan(i('data-backup-policy-bar'));
    expect(i('data-backup-register')).toBeGreaterThan(i('백업 방식(실제로 도는 백업) 거르기'));
    expect(det).toMatch(/<button type="button" className="tab" disabled title="SSH 백업 기능은 아직 없습니다/);
    expect(det).toMatch(/saveBareosGroupHandoff\(vcId, \[\.\.\.checked\]\); window\.location\.hash = '#\/tools\/bareos-backup\/groups'/);
    const code = det.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   // 주석(변경 이력)은 빼고 본다
    expect(code).not.toMatch(/스냅샷|Clone ·|cloneCell|snapCell/, '스냅샷·Clone 문구와 기능은 Detail 에서 뺐다(사용자 요청)');
    const grp = fs.readFileSync(new URL('./BareosGroupsTab.jsx', import.meta.url), 'utf8');
    expect(grp).toMatch(/takeBareosGroupHandoff\(\)/);
    expect(grp).toMatch(/if \(tree\.vcenterId !== h\.vcenterId\) return;/);
    expect(grp).toMatch(/initialSel\.filter\(\(id\) => byId\?\.has\?\.\(id\) && pickable\(byId\.get\(id\), \{ editingId: '', groupName \}\)\.ok\)/);   // 이 법인 트리에 있고 고를 수 있는 VM 만
  });
});
