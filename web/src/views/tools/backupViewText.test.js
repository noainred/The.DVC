import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fmtNum, pctOf, veeamStateOf, filterRows, needsAttention, attentionList, vmClass, vmMatches, filterCounts, folderParts, buildTree, flattenTree, initialOpen, veeamCell, snapCell, shortTs, FILTERS, CRIT_FILTERS, METHOD_FILTERS, METHODS, backupCell, cloneCell, POWER, RPO_DAYS, loadOpts, saveOpts, scopeQuery, scopeNote } from './backupViewText.js';
import { vmViewMatches, VIEW_FILTERS, viewClass as serverViewClass, POWER_VALUES, RPO_DAYS as SERVER_RPO_DAYS } from '../../../../server/src/veeam/backupStatus.js';

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
    // v2.781(점검 G3 C-I2): 스냅샷 모름(GM2)도 주의 보기에 드는 행이라 목록에 나온다 · 심각한 것부터(bad → warn → info)
    expect(att.map((a) => a.title)).toEqual(['AZ — Veeam 읽기 실패', 'ST — 스냅샷 잔존 2대', 'GM2 — 스냅샷 기준 모름', 'Veeam 연동 없음 1곳']);
    expect(att[0].text).toMatch(/스냅샷 기준 120대/);
    expect(JSON.stringify(att)).not.toMatch(/`/);
  });

  it('VM 분류·필터 — 확인 안 됨은 두 쪽을 다 읽고 둘 다 없을 때만(모름은 넣지 않는다) · 잔존은 스냅샷으로 치지 않는다', () => {
    expect(vmClass(VMS[6])).toMatchObject({ vKnown: false, sKnown: false });
    expect(vmClass(VMS[4])).toMatchObject({ snap: false, stale: true });
    const c = filterCounts(VMS);
    expect(c).toEqual({ all: 7, veeam: 3, snaponly: 1, none: 2, run: 2, stale: 1, rpo: 1, fail: 0, need: 0, needgap: 0, 'crit-high': 0, 'crit-mid': 0, 'crit-low': 0,
      'method-veeam': 0, 'method-clone': 0, 'method-config': 0, 'method-none': 0, 'method-unset': 7 });   // v2.803 백업 방식(표시 없음 = 미지정)   // v2.784 표시 필터(표시 없음 = 0)   // v2.780 rpo: dc01 의 lb 1(아주 오래 전)
    expect(vmMatches(VMS[6], 'none')).toBe(false);
  });

  it('폴더 트리 — vm 마디는 빼고(VM 및 폴더 화면과 같은 규칙) · 집계는 필터와 무관한 전체 · 필터·검색에 든 VM 만', () => {
    expect(folderParts('DC1/vm/A.MGMT/AD')).toEqual(['DC1', 'A.MGMT', 'AD']);
    const t = buildTree(VMS);
    const dc = t.children[0];
    expect(dc.name).toBe('DC1'); expect(dc.agg).toEqual({ n: 7, veeam: 3, snap: 3, run: 2, none: 2, clone: 0 });
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

describe('v2.780 백업 옵션 — 전원·제외·오래된 백업·실패·경고', () => {
  const D = 86_400_000;
  const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const X = [
    ...VMS,
    vm('old', 'DC1/vm/D', { v: { state: 'ok', lb: NOW - 4 * D, lr: 'Success' }, s: { ev: null, now: null } }),
    vm('old8', 'DC1/vm/D', { v: { state: 'ok', lb: NOW - 8 * D, lastResult: 'Warning' }, s: { ev: null, now: null } }),
    vm('bad', 'DC1/vm/D', { v: { state: 'ok', lb: NOW - 3_600_000, lr: 'Failed', lastResult: 'Success' }, s: { ev: { ts: NOW, n: 1 }, now: null } }),
    vm('nolb', 'DC1/vm/D', { v: { state: 'ok', lb: null, lr: 'warning' }, s: { ev: null, now: null } }),
  ];

  it('오래된 백업은 고른 일수 · 실패·경고는 VM 결과(lr) 먼저, 없으면 작업 결과 · 시각 모름은 오래됨이 아니다', () => {
    const o = (d) => ({ rpoDays: d, now: NOW });
    expect(X.filter((v) => vmMatches(v, 'rpo', o(3))).map((v) => v.id)).toEqual(['dc01', 'old', 'old8']);   // dc01 은 lb: 1(아주 오래 전)
    expect(X.filter((v) => vmMatches(v, 'rpo', o(7))).map((v) => v.id)).toEqual(['dc01', 'old8']);
    expect(X.filter((v) => vmMatches(v, 'fail', o(1))).map((v) => v.id)).toEqual(['old8', 'bad', 'nolb']);
    expect(filterCounts(X, o(1))).toMatchObject({ all: 11, rpo: 3, fail: 3 });
    expect(buildTree(X, { filter: 'fail', rpoDays: 1, now: NOW }).children[0].hit).toBe(3);
  });

  it('웹 vmMatches = 서버 vmViewMatches(같은 입력 · CSV 가 화면과 같은 VM 을 낸다) · 값 목록도 같다', () => {
    expect([...FILTERS, ...CRIT_FILTERS, ...METHOD_FILTERS].map(([k]) => k)).toEqual([...VIEW_FILTERS]);   // v2.803 백업 방식 필터도 칩 줄 밖   // v2.784: 중요도 필터는 칩 줄 밖(상단 수)
    expect(POWER.map(([k]) => k)).toEqual([...POWER_VALUES]);
    expect(RPO_DAYS).toEqual([...SERVER_RPO_DAYS]);
    const edge = [{}, { v: undefined, s: {} }, { v: null, s: { ev: undefined } }, { v: { state: 'wait' }, s: { now: { stale: true, ts: NOW } } }, ...X];
    for (const d of [1, 3, 7, 99]) {
      for (const f of VIEW_FILTERS) for (const v of edge) expect(vmMatches(v, f, { rpoDays: d, now: NOW }), `${f}/${d}/${v.id}`).toBe(vmViewMatches(v, f, { rpoDays: d, now: NOW }));
    }
  });

  it('옵션 기억 — 저장소가 없거나 던지거나 깨진 값이어도 기본값 · 아는 값만 받는다', () => {
    const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
    const st = mem();
    saveOpts({ power: 'off', excl: false, rpoDays: 7 }, st);
    expect(loadOpts(st)).toEqual({ power: 'off', excl: false, rpoDays: 7 });
    const boom = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadOpts(boom)).toEqual({ power: 'all', excl: true, rpoDays: 1 });
    expect(() => saveOpts({ power: 'on' }, boom)).not.toThrow();
    expect(loadOpts(null)).toEqual({ power: 'all', excl: true, rpoDays: 1 });
    const bad = mem(); bad.setItem('backup-opts', '{"power":"sideways","rpoDays":30}');
    expect(loadOpts(bad)).toEqual({ power: 'all', excl: true, rpoDays: 1 });
    bad.setItem('backup-opts', 'not json');
    expect(loadOpts(bad).power).toBe('all');
    expect(scopeQuery({ power: 'on', excl: false })).toEqual({ power: 'on', excl: '0' });
  });

  it('범위 안내 — 0 인 조각은 빼고 · 전체 전원이면 전원 모름을 말하지 않는다 · 백틱 없음', () => {
    expect(scopeNote({ power: 'on', excl: true }, { excluded: 12, powerUnknown: 3 })).toBe('템플릿·vCLS 12대 제외 · 전원 모름 3대(켜짐·꺼짐 어디에도 넣지 않음)');
    expect(scopeNote({ power: 'all', excl: true }, { excluded: 0, powerUnknown: 3 })).toBe('');
    expect(scopeNote({ power: 'off', excl: false }, { excluded: 5, powerUnknown: 0 })).toBe('');
    expect(scopeNote(null, {})).toBe('');
  });

  it('화면 — 전원·제외가 바뀌면 그 조건으로 서버를 다시 읽는다 · CSV 는 권한 있을 때만 · 두 화면이 같은 옵션 컴포넌트', () => {
    for (const f of ['./BackupSummaryTool.jsx', './BackupDetailTool.jsx']) {
      const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src, f).toMatch(/scopeQuery\(opts\)/);
      expect(src, f).toMatch(/opts\.power, opts\.excl\]/);
      expect(src, f).toMatch(/\{canCsv\(\) && <button/);
      expect(src, f).toMatch(/<BackupOptions opts=\{opts\}/);
      expect(src, f).toMatch(/loadOpts\(\)/);
    }
  });

  it('v2.780.1 서머리 표는 1440px 카드 폭 안 — 열을 더하며 minWidth 를 올려 오른쪽 열이 스크롤 뒤로 숨던 회귀 · 선택 상자는 .input 최소 폭(220px)을 풀었다', () => {
    // v2.787: 법인별 표는 옆 패널 없이 본문 전폭(1440px 카드 안쪽 폭 안 — Chromium 으로 넘침 확인) · 우선순위 표는 옆 패널과 나란히(≤ 858)
    const src = fs.readFileSync(new URL('./BackupSummaryTool.jsx', import.meta.url), 'utf8');
    const mws = [...src.matchAll(/<STable minWidth=\{(\d+)\}/g)].map((m) => Number(m[1]));
    expect(mws.length).toBe(2);
    expect(mws[0]).toBeGreaterThan(0);
    expect(mws[0]).toBeLessThanOrEqual(1100);
    expect(mws[1]).toBeLessThanOrEqual(858);
    expect(src).not.toMatch(/minWidth: 1[34]0 \}/);
    const opt = fs.readFileSync(new URL('./BackupOptions.jsx', import.meta.url), 'utf8');
    expect(opt).toMatch(/minWidth: 0, width: 'auto'/);
  });
});

describe('v2.784 백업 표시 — 중요도·백업 필요·메모', async () => {
  const M = await import('./backupViewText.js');
  const S = await import('../../../../server/src/veeam/backupStatus.js');
  const BM = await import('../../../../server/src/veeam/backupMarks.js');
  const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const X = [
    { id: 'a', name: 'a', folder: 'D/vm/F', v: { state: 'ok', lb: NOW }, s: { ev: null, now: null }, m: { crit: 'high', need: true, memo: 'x' } },
    { id: 'b', name: 'b', folder: 'D/vm/F', v: null, s: { ev: null, now: null }, m: { crit: 'mid', need: true, memo: '' } },
    { id: 'c', name: 'c', folder: 'D/vm/G', s: { now: null }, m: { crit: 'low', need: true } },          // Veeam 모름 — 미백업에 넣지 않는다
    { id: 'd', name: 'd', folder: 'D/vm/G', v: null, s: { ev: null, now: null }, m: { crit: 'zzz', need: 'yes' } },   // 모르는 값은 표시 없음
    { id: 'e', name: 'e', folder: 'D/vm/G', v: null, s: { ev: null, now: null } },
  ];
  it('필터 — 백업 필요 · 미백업(Veeam 모름 제외) · 중요도 · 웹=서버(같은 입력)', () => {
    const ids = (f) => X.filter((v) => M.vmMatches(v, f, { now: NOW })).map((v) => v.id);
    expect(ids('need')).toEqual(['a', 'b', 'c']);
    expect(ids('needgap')).toEqual(['b']);
    expect([ids('crit-high'), ids('crit-mid'), ids('crit-low')]).toEqual([['a'], ['b'], ['c']]);
    for (const f of S.VIEW_FILTERS) for (const v of X) expect(M.vmMatches(v, f, { now: NOW }), `${f}/${v.id}`).toBe(S.vmViewMatches(v, f, { now: NOW }));
    expect(M.MEMO_MAX).toBe(BM.MEMO_MAX);
    expect(M.CRIT.map((c) => c.key)).toEqual([...BM.CRIT_VALUES]);
  });
  it('보이는 VM 전체 선택 — 접힌 폴더도 포함 · 트리와 같은 판정 · 모두 골라져 있으면 해제', () => {
    const vis = M.visibleVmIds(X, { filter: 'need', q: 'g', now: NOW });
    expect(vis).toEqual(['c']);   // 폴더 G 검색 + 백업 필요
    const tree = M.buildTree(X, { filter: 'need', q: 'g', now: NOW });
    expect(tree.children[0].hit).toBe(vis.length);
    let sel = M.toggleAllVisible(new Set(['a']), ['b', 'c']);
    expect([...sel].sort()).toEqual(['a', 'b', 'c']);
    sel = M.toggleAllVisible(sel, ['b', 'c']);
    expect([...sel]).toEqual(['a']);
  });
  it('상단 수·주의 목록 — 미백업을 모르면 null(0 이 아니다) · 미백업 요약은 정보 칸 한 줄', () => {
    expect(M.marksLine({ high: 1, mid: 0, low: 2, need: 3, needGap: null })).toEqual({ high: 1, mid: 0, low: 2, need: 3, needGap: null, method: null });
    expect(M.marksLine(null)).toBe(null);
    const att = M.attentionList([{ id: 'v1', name: 'VC1', veeamState: 'ok', snap: 1, snapStale: 0, marks: { need: 2, needGap: 2 } }, { id: 'v2', name: 'VC2', veeamState: 'ok', snap: 1, snapStale: 0, marks: { need: 1, needGap: null } }]);
    expect(att.map((a) => a.title)).toEqual(['백업 필요인데 Veeam 백업 없음 2대']);
    expect(att[0].tone).toBe('info');
    expect(JSON.stringify(att)).not.toMatch(/`/);
  });
  it('화면 — 편집 칸은 서버 writable 일 때만 · 저장 뒤 다시 읽어도 펼침·선택 유지 · 표 열을 늘리지 않음', () => {
    const det = fs.readFileSync(new URL('./BackupDetailTool.jsx', import.meta.url), 'utf8');
    expect(det).toMatch(/const writable = data\?\.writable === true && !data\?\.marksUnreadable/);
    expect(det).toMatch(/\{writable && <input type="checkbox"/);
    expect(det).toMatch(/load\(true\)/);
    expect(det).toMatch(/const r = await putJson\('\/tools\/backup-detail\/marks'[\s\S]{0,120}r\?\.ok === false\)[\s\S]{0,80}r\.reason/);   // 400 본문을 성공으로 삼키지 않는다
    expect(det).toMatch(/const GRID = 'minmax\(220px, 2fr\) 52px minmax\(150px, 1\.3fr\) minmax\(140px, 1\.1fr\) 64px 104px'/);   // v2.803 6열(백업 · Clone)
    const sum = fs.readFileSync(new URL('./BackupSummaryTool.jsx', import.meta.url), 'utf8');
    expect(sum).toMatch(/data-backup-marks/);
    expect(Number((/<STable minWidth=\{(\d+)\}/.exec(sum) || [])[1])).toBeLessThanOrEqual(1100);   // v2.787 전폭 표
  });
});

describe('v2.787 Summary — 바로가기 · 법인별 표 · 우선순위', async () => {
  const M = await import('./backupViewText.js');
  it('바로가기 점 색 — 읽기 실패 빨강 · 주의 주황 · 연동 없음 회색 · 정상 초록', () => {
    expect(M.quickTone({ veeamState: 'veeam-failed' })).toBe('bad');
    expect(M.quickTone({ veeamState: 'unlinked', snap: 1, snapStale: 0 })).toBe('muted');
    expect(M.quickTone(null)).toBe('muted');
    expect(Object.keys(M.QUICK_DOT).sort()).toEqual(['bad', 'muted', 'ok', 'warn']);
  });
  it('커버리지 — VM 수를 모르면 막대 없음(0% 가 아니다) · 정렬은 모르는 값을 뒤로', () => {
    expect(M.coverageOf({ vm: null, split: { both: 1, vOnly: 0, sOnly: 0, none: 0 } })).toBe(null);
    expect(M.coverageOf({ vm: 4, split: null })).toBe(null);
    expect(M.coverageOf({ vm: 4, split: { both: 1, vOnly: 1, sOnly: 1, none: 1 } })).toEqual({ both: 25, vOnly: 25, sOnly: 25, none: 25 });
    const rows = [{ name: 'b', vm: 10, veeam: null }, { name: 'a', vm: 10, veeam: 9 }, { name: 'c', vm: 10, veeam: 1 }];
    expect(M.sortRows(rows, 'cover').map((r) => r.name)).toEqual(['c', 'a', 'b']);
    expect(M.sortRows(rows, 'name').map((r) => r.name)).toEqual(['a', 'b', 'c']);
    expect(M.matchSite({ name: 'APAC-VC01' }, 'vc01')).toBe(true);
  });
  it('화면 — 바로가기 줄 · 행 앵커 · 우선순위 보류 안내 · 탭 머리', () => {
    const sum = fs.readFileSync(new URL('./BackupSummaryTool.jsx', import.meta.url), 'utf8');
    expect(sum).toMatch(/data-backup-quicknav/);
    expect(sum).toMatch(/data-vc-row=\{r\.id\}/);
    expect(sum).toMatch(/priority\?\.withheld === 'detail-tool'/);
    expect(sum).toMatch(/<VeeamHeader active="summary"/);
    const det = fs.readFileSync(new URL('./BackupDetailTool.jsx', import.meta.url), 'utf8');
    expect(det).toMatch(/<VeeamHeader active="detail"/);
    expect(sum + det).not.toMatch(/textTransform/);
  });
});

describe('v2.803 백업 방식 · 백업 칸 · Clone 칸', async () => {
  const S = await import('../../../../server/src/veeam/backupStatus.js');
  const T = 1_800_000_000_000;
  it('백업 방식 글자 = 서버 METHOD_TEXT · 필터는 웹·서버 한 쌍(방식별 · 미지정)', () => {
    expect(Object.fromEntries(METHODS.map((m) => [m.key, m.text]))).toEqual({ ...S.METHOD_TEXT });
    const vms = [{ id: 'a', m: { method: 'clone' } }, { id: 'b', m: { method: 'veeam' } }, { id: 'c', m: { crit: 'high' } }, { id: 'd' }, { id: 'e', m: { method: 'bogus' } }];
    for (const [f] of METHOD_FILTERS) for (const v of vms) expect(vmMatches(v, f), `${f}/${v.id}`).toBe(S.vmViewMatches(v, f));
    expect(vms.filter((v) => vmMatches(v, 'method-unset')).map((v) => v.id)).toEqual(['c', 'd', 'e'], '모르는 값은 미지정');
    // v2.806 needgap — 백업 안함·Clone 은 미백업 아님(웹·서버 한 쌍)
    const nv = ['veeam', 'clone', 'config', 'none', ''].map((method, i) => ({ id: `n${i}`, v: null, s: { ev: null }, m: { need: true, method } }));
    for (const v of nv) expect(vmMatches(v, 'needgap'), v.m.method).toBe(S.vmViewMatches(v, 'needgap'));
    expect(nv.filter((v) => vmMatches(v, 'needgap')).map((v) => v.m.method)).toEqual(['veeam', 'config', '']);
  });
  it('백업 칸 — Veeam 이 있으면 Veeam(스냅샷 숨김) · 없으면 스냅샷 · 둘 다 없으면 Veeam 표기 · 모름을 — 로 덮지 않는다', () => {
    expect(backupCell({ v: { lb: T }, s: { ev: { n: 2, ts: T } } })).toMatchObject({ tone: 'ok', src: 'veeam' });
    expect(backupCell({ v: null, s: { ev: { n: 2, ts: T } } })).toMatchObject({ tone: 'ev', text: '7일 2회', src: 'snap' });
    expect(backupCell({ v: null, s: { ev: null, now: { n: 1, ts: T, stale: true } } })).toMatchObject({ tone: 'stale', src: 'snap' });
    expect(backupCell({ v: null, s: { ev: null } })).toMatchObject({ text: '—', tone: 'none' });
    expect(backupCell({ s: { ev: null } })).toMatchObject({ text: '모름', tone: 'unknown' }, 'Veeam 모름');
    expect(backupCell({ v: null, s: {} })).toMatchObject({ text: '모름', tone: 'unknown' }, '스냅샷 모름');
  });
  it('Clone 칸 — 키 없으면 없음(null) · 잡 없음 · 모름 · 실행 안 함 · 성공/실패 · 잡 꺼짐 · 서버 cloneView·cloneResultText 와 같은 갈래', () => {
    expect(cloneCell({})).toBe(null);
    expect(cloneCell({ c: null }).text).toBe('Clone · 모름');
    const st = (lastRun, enabled = true) => S.cloneView({ job: { enabled }, lastRun });
    expect(cloneCell({ c: S.cloneView(undefined) }).text).toBe('Clone · 잡 없음');
    expect(cloneCell({ c: st(undefined) }).text).toBe('Clone · 모름');
    expect(cloneCell({ c: st(null) }).text).toBe('Clone · 아직 실행 안 함');
    expect(cloneCell({ c: st({ at: T, ok: true }) })).toMatchObject({ tone: 'clone' });
    expect(cloneCell({ c: st({ at: T, ok: false }) })).toMatchObject({ tone: 'cloneBad' });
    expect(cloneCell({ c: st({ at: T, ok: true }, false) }).text).toMatch(/잡 꺼짐$/);
    expect([undefined, null, S.cloneView(undefined), st(undefined), st(null), st({ at: T, ok: true }), st({ at: T, ok: false }), st({ at: T, ok: false, skipped: 'x' })].map(S.cloneResultText))
      .toEqual(['', '모름', '잡 없음', '모름', '아직 실행 안 함', '성공', '실패', '건너뜀·중단']);
  });
});

describe('v2.806 백업 방식 단축키 · 우선순위 VM', async () => {
  const B = await import('./backupViewText.js');
  const S = await import('../../../../server/src/veeam/backupStatus.js');
  const ev = (key, extra = {}) => ({ key, target: { tagName: 'DIV' }, ...extra });
  it('단축키 — V·C·G·N(대소문자 무관) · 조합키·IME·반복·입력 칸이면 무시', () => {
    expect(['v', 'C', 'g', 'N', 'x'].map((k) => B.methodKeyOf(ev(k)))).toEqual(['veeam', 'clone', 'config', 'none', null]);
    expect(B.methodKeyOf(ev('v', { ctrlKey: true }))).toBe(null);
    expect(B.methodKeyOf(ev('v', { metaKey: true }))).toBe(null);
    expect(B.methodKeyOf(ev('v', { altKey: true }))).toBe(null);
    expect(B.methodKeyOf(ev('v', { isComposing: true }))).toBe(null);
    expect(B.methodKeyOf(ev('v', { repeat: true }))).toBe(null);
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) expect(B.methodKeyOf(ev('v', { target: { tagName } })), tagName).toBe(null);
    expect(B.methodKeyOf(ev('v', { target: { tagName: 'DIV', isContentEditable: true } }))).toBe(null);
    expect(Object.values(B.METHOD_KEYS_MAP).sort()).toEqual([...B.METHODS.map((m) => m.key)].sort(), '네 방식 모두 키가 있다');
  });
  it('화면 — keydown 은 고른 VM·편집 가능일 때만 · 같은 값이면 저장하지 않는다 · 안내 한 줄', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('./BackupDetailTool.jsx', import.meta.url), 'utf8');
    expect(src).toMatch(/if \(!selVm \|\| !writable\) return undefined;/);
    expect(src).toMatch(/const method = methodKeyOf\(e\);/);
    expect(src).toMatch(/if \(\(selVm\.m\?\.method \|\| ''\) !== method\) saveMarks\(\[selVm\.id\], \{ method \}\);/);
    expect(src).toMatch(/단축키 V Veeam · C Clone · G Config 백업 · N 백업 안함/);
  });
  it('우선순위 VM — 백업 안함·Clone 은 Veeam 미백업이 아니다 · Clone 실패·잡 없음은 실패 탭 · Config 는 확인 불가 태그', () => {
    const NOW = 1_800_000_000_000;
    const vms = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, name: id }));
    const marks = { a: { need: true }, b: { need: true, method: 'none' }, c: { need: true, method: 'clone' }, d: { need: true, method: 'clone' }, e: { need: true, method: 'config' }, f: { method: 'clone' } };
    const clones = { c: { job: true, on: true, at: NOW - 1000, ok: true }, d: { job: false }, f: null };
    const items = S.priorityCandidates(vms, { byVm: {}, marks, veeamKnown: true, now: NOW, cloneOf: (id) => clones[id] });
    const by = Object.fromEntries(items.map((x) => [x.id, x]));
    expect(Object.keys(by).sort()).toEqual(['a', 'd', 'e'], 'b 백업 안함 · c Clone 성공 · f Clone 모름은 후보 아님');
    expect([by.a.gap, by.d.gap, by.d.cloneBad, by.e.gap, by.e.method]).toEqual([true, false, true, true, 'config']);
    const v = B.priorityView(items, { rpoDays: 1, now: NOW });
    const tags = Object.fromEntries(v.items.map((x) => [x.id, x.tags.map(([, t]) => t)]));
    expect(tags.a).toContain('Veeam 백업 없음');
    expect(tags.e).toContain('Config 백업 — 확인 불가');
    expect(tags.d).toContain('Clone 실패·잡 없음');
    expect([v.counts.gap, v.counts.fail]).toEqual([2, 1]);
    expect(v.items.filter((x) => B.prioMatches(x, 'fail')).map((x) => x.id)).toEqual(['d']);
    expect(S.cloneBadOf({ job: true, on: true, at: NOW, ok: false })).toBe(true);
    expect(S.cloneBadOf({ job: true, on: true, at: null, ok: null })).toBe(false, '아직 실행 안 함은 실패가 아니다');
    expect(S.cloneBadOf({ job: true, on: true, unknown: true })).toBe(false);
  });
});

describe('v2.812 폴더 선택 — 폴더를 고르면 그 아래 VM 전부', () => {
  it('폴더 키 → 하위 폴더까지 포함한 VM id(접힘과 무관)', async () => {
    const { folderVmIdMap } = await import('./backupViewText.js');
    const m = folderVmIdMap(buildTree(VMS));
    expect(m.get('DC1').slice().sort()).toEqual(VMS.map((v) => v.id).sort());
    expect(m.get('DC1/A.MGMT').slice().sort()).toEqual(['dc01', 'spf01', 'spf02']);
    expect(m.get('DC1/A.MGMT/Spotfire').slice().sort()).toEqual(['spf01', 'spf02']);
    expect(m.get('DC1/B.Service').slice().sort()).toEqual(['app01', 'old01']);
  });
  it('보기 조건에 드는 VM 만 — 보이는 VM 전체 선택과 같은 집합', async () => {
    const { folderVmIdMap, visibleVmIds } = await import('./backupViewText.js');
    for (const filter of ['veeam', 'snaponly', 'none', 'run', 'stale']) {
      const m = folderVmIdMap(buildTree(VMS, { filter }));
      const all = [...m.entries()].filter(([k]) => !k.includes('/')).flatMap(([, ids]) => ids).sort();
      expect(all, filter).toEqual(visibleVmIds(VMS, { filter }).slice().sort());
    }
    const q = folderVmIdMap(buildTree(VMS, { q: 'spf' }));
    expect(q.get('DC1').slice().sort()).toEqual(['spf01', 'spf02']);
    expect(q.has('DC1/B.Service')).toBe(false);   // 해당 VM 이 없는 폴더는 트리에서 빠진다
  });
  it('체크 상태 all · some · none, 그리고 폴더 토글은 모두 고르기 ↔ 모두 풀기', async () => {
    const { folderCheckState, toggleAllVisible } = await import('./backupViewText.js');
    const ids = ['a', 'b'];
    expect(folderCheckState(new Set(), ids)).toBe('none');
    expect(folderCheckState(new Set(['a']), ids)).toBe('some');
    expect(folderCheckState(new Set(['a', 'b', 'z']), ids)).toBe('all');
    expect(folderCheckState(new Set(['a']), [])).toBe('none');   // VM 0대 폴더는 '모두 선택' 으로 보이지 않는다
    expect(folderCheckState(null, ids)).toBe('none');
    let sel = toggleAllVisible(new Set(['a', 'z']), ids);   // 일부 → 모두
    expect([...sel].sort()).toEqual(['a', 'b', 'z']);
    sel = toggleAllVisible(sel, ids);                        // 모두 → 그 폴더만 풀림(다른 선택 z 는 유지)
    expect([...sel]).toEqual(['z']);
  });
  it('화면 계약 — 편집 가능할 때만 · 일부 선택은 indeterminate · 트리 기준 맵', () => {
    const src = fs.readFileSync(new URL('./BackupDetailTool.jsx', import.meta.url), 'utf8');
    expect(src).toMatch(/const folderIds = useMemo\(\(\) => folderVmIdMap\(tree\), \[tree\]\);/);
    expect(src).toMatch(/\{writable && \(\(\) => \{\s*const ids = folderIds\.get\(row\.key\)/);
    expect(src).toMatch(/el\.indeterminate = st === 'some'/);
    expect(src).toMatch(/onChange=\{\(\) => setChecked\(\(cur\) => toggleAllVisible\(cur, ids\)\)\}/);
    const early = src.indexOf('if (vcs && !vcs.length) return');
    expect(src.indexOf('folderVmIdMap(tree)')).toBeLessThan(early);   // 훅은 조기 return 위
  });
});

describe('v2.812 선택 반전', () => {
  it('보이는 VM 만 뒤집고 보이지 않는 VM 의 선택은 그대로', async () => {
    const { invertVisible } = await import('./backupViewText.js');
    const sel = invertVisible(new Set(['a', 'hidden']), ['a', 'b', 'c']);
    expect([...sel].sort()).toEqual(['b', 'c', 'hidden']);
    expect([...invertVisible(sel, ['a', 'b', 'c'])].sort()).toEqual(['a', 'hidden']);   // 두 번 뒤집으면 제자리
    expect([...invertVisible(null, ['x'])]).toEqual(['x']);
    expect([...invertVisible(new Set(['k']), [])]).toEqual(['k']);
  });
  it('일괄 바에 선택 반전 버튼 — 보이는 VM 기준', () => {
    const src = fs.readFileSync(new URL('./BackupDetailTool.jsx', import.meta.url), 'utf8');
    expect(src).toMatch(/onClick=\{\(\) => setChecked\(\(cur\) => invertVisible\(cur, visibleIds\)\)\} disabled=\{!visibleIds\.length\}[^>]*>선택 반전<\/button>/);
  });
});
