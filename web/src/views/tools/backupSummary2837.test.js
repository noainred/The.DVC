/**
 * v2.837 Summary 를 시안 ① 에 맞추기(사용자 요청 '시안대로 다 맞춰줘').
 *   ① 숫자 6칸 · 조치 · 배지 · 7일 성공률 · 시각 글자(순수) ② 찾기 쿼리(법인 하나) ③ 화면 소스 — 순서 · 선택은 한 법인 안에서만 · 저장은 같은 PUT · 넘기기 3종 · CSV · 스냅샷 문구 없음
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { summaryPolicyKpis, staleAction, siteBadges, okPct, hhmm, rpoLabel, bytesText, staleQuery, staleQueryMatches } from './backupSummaryText.js';
import * as AG from '../../../../server/src/veeam/backupSummaryAgg.js';

const H = 3_600_000;
const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime();

describe('v2.837 숫자 6칸', () => {
  const pa = { ...AG.sumSiteAggs([]), n: 10, on: 9, pol: { veeam: 4, bareos: 2, ssh: 1, none: 2, check: 1 }, polUnk: 0, unprot: 3, unver: 2, run: 1, brun: 2, bwait: 1,
    r24: { ok: 5, warn: 1, fail: 2 }, win: { start: NOW - 10 * H, end: NOW - H }, vbytes: 2 * 1024 ** 4, vbytesN: 3, bbytes: 512 * 1024 ** 3, bbytesN: 2 };
  pa.rpo.d1 = { ok: 6, miss: 2, unk: 0 };
  const rows = [{ name: 'OC2', pa: { win: { start: NOW - 9 * H, end: NOW - H } } }, { name: 'KR', pa: { win: { start: NOW - 3 * H, end: NOW - 2 * H } } }];
  it('보호 안 됨 · 확인 안 됨 = (BackedUp 인데 결과 없음 + 확인 필요) · 결과 모름', () => {
    const k = summaryPolicyKpis({ vcenters: 2, pa }, { rpoDays: 1, rows });
    expect(k.unprot.value).toBe('4 · 2');
    expect(k.unprot.sub).toMatch(/BackedUp 7\(Veeam 4 · Bareos 2 · SSH 1\) · 백업 안함 2 · 확인 필요 1 — 합 10/);
    expect(k.prot.value).toBe('10');
    expect(k.rpo.value).toBe('75%');
    expect(k.rpo.sub).toMatch(/^6대 — 24시간 안에 성공한 백업 있음/);
  });
  it('지금 실행 중 — Veeam + Bareos · 멈춤 의심은 진행 현황 값이 있을 때만', () => {
    expect(summaryPolicyKpis({ vcenters: 2, pa, stuck: null }, {}).run.sub).not.toMatch(/멈춤/);
    const k = summaryPolicyKpis({ vcenters: 2, pa, stuck: 1 }, {});
    expect(k.run.value).toBe('3');
    expect(k.run.sub).toBe('Veeam 1 · Bareos 2 · 대기 1 · 멈춤 의심 1');
  });
  it('최근 24시간 — 성공 / 경고 / 실패 · 백업 기간 · 가장 오래 걸린 법인', () => {
    const k = summaryPolicyKpis({ vcenters: 2, pa }, { rows });
    expect(k.r24.value).toBe('5 / 1 / 2');
    expect(k.r24.sub).toBe(`백업 기간 ${hhmm(NOW - 10 * H)}~${hhmm(NOW - H)} · 가장 오래 걸림 OC2`);
  });
  it('백업된 용량 — Veeam 복원 지점 + Bareos 마지막 실행 · 읽은 VM 이 없으면 —', () => {
    const k = summaryPolicyKpis({ vcenters: 2, pa }, { em: { trend30: { pct: 4.8 } } });
    expect(k.bytes.value).toBe('2.5 TB');
    expect(k.bytes.sub).toBe('Veeam 2.0 TB · Bareos 512 GB · 저장소 30일 +4.8%');
    expect(summaryPolicyKpis({ vcenters: 2, pa: { ...pa, vbytesN: 0, bbytesN: 0 } }, {}).bytes.value).toBe('—');
  });
  it('작은 글자들', () => {
    expect([okPct({ ok: 9, bad: 1 }), okPct({ ok: 0, bad: 0 }), okPct(null)]).toEqual([90, null, null]);
    expect([rpoLabel(1), rpoLabel(3), rpoLabel(7)]).toEqual(['24시간', '3일', '7일']);
    expect([hhmm(null), bytesText(null), bytesText(-1)]).toEqual(['—', '—', '—']);
  });
});

describe('v2.837 조치 · 배지', () => {
  const row = (vm, kind = 'never') => ({ vc: 'vc1', kind, vm });
  it('조치 — 이유에 맞는 화면 · 권한이 없으면 Detail', () => {
    const o = { canRun: true, canBareos: true };
    expect(staleAction(row({ p: 'veeam', mm: true }), o).key).toBe('veeam-run');
    expect(staleAction(row({ p: 'veeam', mm: true }), { canRun: false }).key).toBe('detail');
    expect(staleAction(row({ p: 'bareos', mm: true }), o).key).toBe('bareos-target');
    expect(staleAction(row({ p: 'bareos', b: { job: true, run: 'running' } }), o).key).toBe('live');
    expect(staleAction(row({ p: 'check' }), o).key).toBe('policy');
    expect(staleAction(row({ p: 'veeam', mm: true }, 'unknown'), o).key).toBe('detail');
    expect(staleAction(row({ p: 'veeam', mm: false }), o).key).toBe('detail');
  });
  it('법인 줄 배지 — 모르면 넣지 않는다', () => {
    expect(siteBadges({ stuck: 2, bEdge: true, veeamAuth: 1, bMapped: false, veeamState: 'ok' }).map((x) => x.text)).toEqual(['멈춤 의심 2', 'Director 엣지 대행', 'Veeam 인증 실패 1', 'Veeam 만']);
    expect(siteBadges({ bMapped: true, veeamState: 'unlinked' }).map((x) => x.key)).toEqual(['bonly']);
    expect(siteBadges({ veeamState: 'ok' })).toEqual([]);   // 매핑을 모르면(키 없음) 'Veeam 만' 이라 단정하지 않는다
  });
  it('찾기 쿼리 — 법인 하나(vc) · 조건 비교에 법인도 든다', () => {
    const o = { n: 3, unit: 'd', src: 'policy', excludeNone: true, onlyOn: true, includeNever: true, vc: 'vc-a' };
    const q = staleQuery(o, { power: 'all', excl: true });
    expect(q.vc).toBe('vc-a');
    expect(q.src).toBe('policy');
    expect(AG.staleQueryOf(q).vc).toBe('vc-a');
    expect(staleQuery({ ...o, vc: '' }).vc).toBe(undefined);
    expect(staleQueryMatches({ q: { n: 3, unit: 'd', src: 'policy', excludeNone: true, onlyOn: true, includeNever: true, vc: 'vc-b' } }, o)).toBe(false);
  });
});

describe('v2.837 화면 소스', () => {
  const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const sum = read('./BackupSummaryTool.jsx'); const tree = read('./BackupSummaryTree.jsx'); const stale = read('./BackupSummaryStale.jsx'); const bar = read('./BackupSummaryBar.jsx');
  it('순서 — 숫자 6칸 → 두 카드 → 도구 줄 → 찾기 → 트리 → 값 출처', () => {
    const i = (s) => sum.indexOf(s);
    expect((sum.match(/<Kpi /g) || []).length).toBe(6);
    expect(i('data-backup-sol="veeam"')).toBeGreaterThan(i('data-backup-kpis'));
    expect(i('<BackupSummaryBar ')).toBeGreaterThan(i('data-backup-sol="bareos"'));
    expect(i('<BackupSummaryStale ')).toBeGreaterThan(i('<BackupSummaryBar '));
    expect(i('<BackupSummaryTree ')).toBeGreaterThan(i('<BackupSummaryStale '));
    expect(i('data-backup-source')).toBeGreaterThan(i('<BackupSummaryTree '));
  });
  it('선택은 한 법인 안에서만 — 다른 법인 칸은 막고 pick 도 무시', () => {
    expect(sum).toMatch(/if \(cur\.vc && cur\.vc !== vc && cur\.ids\.size\) return cur;/);
    expect(tree).toMatch(/const lockedFor = \(vc\) => !!\(sel\?\.vc && sel\.vc !== vc && selIds\.size\);/);
    expect(stale).toMatch(/const locked = !!\(sel\?\.vc && sel\.vc !== x\.vc && selIds\.size\);/);
  });
  it('도구 줄 — Detail 과 같은 PUT · 쓰기 가능은 서버 w · 넘기기 3종 · SSH 는 준비 중', () => {
    expect(bar).toMatch(/const writable = site\?\.w === true;/);
    expect(bar).toMatch(/putJson\('\/tools\/backup-detail\/marks', \{ vcenterId: sel\.vc, vmIds: ids, method \}\)/);
    expect(bar).toMatch(/saveHandoff, '#\/tools\/backup-run'/);
    expect(bar).toMatch(/saveBareosHandoff, '#\/tools\/bareos-backup\/targets'/);
    expect(bar).toMatch(/saveBareosGroupHandoff, '#\/tools\/bareos-backup\/groups'/);
    expect(bar).toMatch(/<button type="button" className="tab" disabled title="SSH 백업 기능은 아직 없습니다/);
  });
  it('찾기 — CSV 는 권한 있을 때만 · SSH 만은 고를 수 없음 · 정책에 맞는 백업만', () => {
    expect(stale).toMatch(/\{canCsv\(\) && <button type="button" className="tab" disabled=\{bad\} onClick=\{csv\}/);
    expect(stale).toMatch(/downloadFile\(`\/tools\/backup-summary\/stale\.csv\?\$\{new URLSearchParams\(params\)\}`\)/);
    expect(stale).toMatch(/<option value="ssh" disabled>/);
    expect(stale).toMatch(/\['policy', '정책에 맞는 백업만'\]/);
  });
  it('스냅샷 · Clone 문구와 기능이 없다(주석은 빼고 본다) · 폴링 없음', () => {
    for (const s of [sum, tree, stale, bar]) {
      expect(strip(s)).not.toMatch(/스냅샷|snapshot|Clone ·|cloneCell|snapCell|coverageOf|PRIO_TABS/i);
      expect(s).not.toMatch(/usePolling|setInterval/);
    }
  });
});
