import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fmtNum, pctOf, veeamStateOf, filterRows, needsAttention, attentionList, vmClass, vmMatches, filterCounts, folderParts, buildTree, flattenTree, initialOpen, veeamCell, snapCell, shortTs } from './backupViewText.js';

const H = 3_600_000;
const vm = (id, folder, o = {}) => ({ id, name: id, folder, ...o });
// 서버 vmBackupView 모양 — v 키 없음 = Veeam 모름, v: null = 없음 / s.ev 키 없음 = 스냅샷 모름
const VMS = [
  vm('dc01', 'DC1/vm/A.MGMT/AD', { v: { state: 'ok', lb: 1, jobs: ['01. AD'] }, s: { ev: { ts: 1, n: 3 }, now: null } }),
  vm('spf01', 'DC1/vm/A.MGMT/Spotfire', { v: { state: 'run', pg: 72, jobs: ['23. spotfire'] }, s: { ev: null, now: { n: 1, ts: Date.now() - H, stale: false } } }),
  vm('spf02', 'DC1/vm/A.MGMT/Spotfire', { v: { state: 'wait', jobs: ['23. spotfire'] }, s: { ev: null, now: null } }),
  vm('app01', 'DC1/vm/B.Service', { v: null, s: { ev: { ts: 1, n: 1 }, now: null } }),
  vm('old01', 'DC1/vm/B.Service', { v: null, s: { ev: null, now: { n: 1, ts: Date.now() - 30 * H, stale: true } } }),
  vm('x01', 'DC1/vm/C.Add-ons', { v: null, s: { ev: null, now: null } }),
  vm('unk01', 'DC1/vm/C.Add-ons', { s: { now: null } }),
];

describe('v2.779 백업 메뉴 — 순수 헬퍼', () => {
  it('못 읽은 값은 — · % 는 둘 다 알 때만', () => {
    expect(fmtNum(null)).toBe('—'); expect(fmtNum(5981)).toBe('5,981');
    expect(pctOf(51, 340)).toBe(15); expect(pctOf(null, 340)).toBe(null); expect(pctOf(3, 0)).toBe(null);
    expect(veeamStateOf('veeam-failed').text).toBe('읽기 실패'); expect(veeamStateOf('zzz').text).toBe('모름');
  });

  it('서머리 필터·주의 — 연동 없음은 주의가 아니라 정보 · 스냅샷 모름·잔존·Veeam 실패는 주의', () => {
    const rows = [
      { id: 'a', name: 'AZ', veeamState: 'veeam-failed', snap: 120, snapStale: 0 },
      { id: 'b', name: 'AZ-IRS', veeamState: 'ok', snap: 48, snapStale: 0 },
      { id: 'c', name: 'NA-IRS', veeamState: 'unlinked', snap: 19, snapStale: 0 },
      { id: 'd', name: 'ST', veeamState: 'ok', snap: 200, snapStale: 2 },
      { id: 'e', name: 'GM2', veeamState: 'ok', snap: null, snapStale: 0 },
    ];
    expect(filterRows(rows, 'irs').map((r) => r.name)).toEqual(['AZ-IRS', 'NA-IRS']);
    expect(filterRows(rows, 'davinci').map((r) => r.name)).toEqual(['AZ', 'ST', 'GM2']);
    expect(filterRows(rows, 'warn').map((r) => r.name)).toEqual(['AZ', 'ST', 'GM2']);
    expect(needsAttention(rows[2])).toBe(false);
    const att = attentionList(rows);
    expect(att.map((a) => a.title)).toEqual(['AZ — Veeam 읽기 실패', 'ST — 스냅샷 잔존 2대', 'Veeam 연동 없음 1곳']);
    expect(att[0].text).toMatch(/스냅샷 기준 120대/);
    expect(JSON.stringify(att)).not.toMatch(/`/);
  });

  it('VM 분류·필터 — 확인 안 됨은 두 쪽을 다 읽고 둘 다 없을 때만(모름은 넣지 않는다) · 잔존은 스냅샷으로 치지 않는다', () => {
    expect(vmClass(VMS[6])).toMatchObject({ vKnown: false, sKnown: false });
    expect(vmClass(VMS[4])).toMatchObject({ snap: false, stale: true });
    const c = filterCounts(VMS);
    expect(c).toEqual({ all: 7, veeam: 3, snaponly: 1, none: 2, run: 2, stale: 1 });
    expect(vmMatches(VMS[6], 'none')).toBe(false);
  });

  it('폴더 트리 — vm 마디는 빼고(VM 및 폴더 화면과 같은 규칙) · 집계는 필터와 무관한 전체 · 필터·검색에 든 VM 만', () => {
    expect(folderParts('DC1/vm/A.MGMT/AD')).toEqual(['DC1', 'A.MGMT', 'AD']);
    const t = buildTree(VMS);
    const dc = t.children[0];
    expect(dc.name).toBe('DC1'); expect(dc.agg).toEqual({ n: 7, veeam: 3, snap: 3, run: 2, none: 2 });
    expect(dc.children.map((c) => c.name)).toEqual(['A.MGMT', 'B.Service', 'C.Add-ons']);
    const runOnly = buildTree(VMS, { filter: 'run' });
    expect(runOnly.children[0].children.map((c) => c.name)).toEqual(['A.MGMT']);
    expect(runOnly.children[0].children[0].agg.n).toBe(3, '집계는 전체 기준');
    expect(buildTree(VMS, { q: 'service' }).children[0].children.map((c) => c.name)).toEqual(['B.Service']);
    // 펼침 — 처음은 둘째 단계까지, 검색·필터 중엔 모두
    const open = initialOpen(t);
    expect([...open]).toEqual(['DC1', 'DC1/A.MGMT', 'DC1/B.Service', 'DC1/C.Add-ons']);
    const rows = flattenTree(t, open);
    expect(rows.slice(0, 3).map((r) => [r.kind, r.key, r.depth])).toEqual([['folder', 'DC1', 0], ['folder', 'DC1/A.MGMT', 1], ['folder', 'DC1/A.MGMT/AD', 2]]);
    expect(flattenTree(t, new Set(), { forceOpen: true }).filter((r) => r.kind === 'vm')).toHaveLength(7);
  });

  it('칸 글자 — Veeam(모름/없음/진행률/대기/완료) · 스냅샷(잔존 > 지금 > N일 > 없음/모름)', () => {
    expect(veeamCell(VMS[6])).toEqual({ text: '모름', tone: 'unknown' });
    expect(veeamCell(VMS[3])).toEqual({ text: '—', tone: 'none' });
    expect(veeamCell(VMS[1])).toEqual({ text: '백업 중 72%', tone: 'run' });
    expect(veeamCell(VMS[2]).text).toBe('대기');
    expect(veeamCell({ v: { state: 'ok', lb: null } }).text).toBe('Veeam');
    expect(snapCell(VMS[4]).tone).toBe('stale'); expect(snapCell(VMS[4]).text).toMatch(/^잔존 \d+h$/);
    expect(snapCell(VMS[1]).text).toBe('지금 스냅샷');
    expect(snapCell(VMS[0])).toEqual({ text: '7일 3회', tone: 'ev' });
    expect(snapCell(VMS[5])).toEqual({ text: '—', tone: 'none' });
    expect(snapCell(VMS[6])).toEqual({ text: '모름', tone: 'unknown' });
    expect(shortTs(null)).toBe('—');
  });

  it('화면 — 폴링하지 않는다(마운트 1회 + 새로고침) · 훅은 조기 return 위 · 백틱 문구 없음', () => {
    for (const f of ['./BackupSummaryTool.jsx', './BackupDetailTool.jsx']) {
      const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src).not.toMatch(/usePolling|setInterval/);
      const firstReturn = src.indexOf('\n  if (');
      const lastHook = Math.max(...['useState(', 'useEffect(', 'useMemo(', 'useCallback(', 'useRef('].map((h) => src.lastIndexOf(h)));
      expect(lastHook, f).toBeLessThan(firstReturn);
    }
  });
});
