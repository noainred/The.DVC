// v2.872 통합 에러 로그 — 로그 서랍 · 따로 보기 · 묶어 보기 · '이력 →' 넘기기(시안 docs/design/bareos-errlog · 사용자 컨펌 2026-11-04 '구현해')
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from './backupSummaryPlan.js';
import { saveRunFocus, saveTargetFocus, takeTargetFocus } from './bareosViewText.js';
import { LOGS_MAX } from '../../../../server/src/bareos/ops.js';
import { withShapeGroups } from '../../../../server/src/veeam/backupErrors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T = Date.UTC(2026, 10, 4, 2, 48);
const run = (k, at, o = {}) => ({ at, vc: 'oc2', vcName: 'OC2', src: 'bareos', kind: 'fail', job: `pv-54220daf-vm-${k}`, vm: `VM${k}`, vmId: `oc2:vm-${k}`, jobKey: `j${k}`, jobid: 20600 + k, msg: '치명 오류 · Full · 오류 1건', open: 'bareos', ...o });
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

describe('v2.872 열기 — 로그 서랍 · 이력 →', () => {
  it('Bareos 실행 행은 [로그] + [이력 →] · 권한 · 원장 잡이 없으면 없음', () => {
    const o = { canBareos: true };
    expect(P.errorOpen(run(1, T), o)).toEqual({ key: 'log', text: '로그' });
    expect(P.errorHistory(run(1, T), o)).toEqual({ key: 'history', text: '이력 →', hash: '#/tools/bareos-backup/runs' });
    expect(P.errorHistory(run(1, T), {})).toBe(null);
    expect(P.errorHistory({ ...run(1, T), jobKey: '' }, o)).toBe(null);
    expect(P.canOpenLog(run(1, T))).toBe(true);
    expect(P.canOpenLog({ ...run(1, T), jobid: null })).toBe(false);
    expect(P.canOpenLog({ src: 'veeam', open: 'em' })).toBe(false);
    expect(P.logJobOf(run(1, T))).toEqual({ id: 'j1', vmName: 'VM1', writable: false });
    expect(P.logDirOf({ relay: true })).toEqual({ agent: 'edge' });
    expect(P.logDirOf({})).toBe(null);
  });
  it('이력 → 넘기기 — VM · jobid · runs 표지(한 번 읽고 지움) · 옛 넘기기는 targets', () => {
    const s = mem();
    saveRunFocus('oc2', 'oc2:vm-16895', 20612, s);
    expect(takeTargetFocus(s)).toEqual({ vcenterId: 'oc2', vmId: 'oc2:vm-16895', tab: 'runs', jobid: 20612 });
    expect(takeTargetFocus(s)).toBe(null);
    saveTargetFocus('oc2', 'oc2:vm-1', s);
    expect(takeTargetFocus(s)).toEqual({ vcenterId: 'oc2', vmId: 'oc2:vm-1', tab: 'targets', jobid: null });
    saveRunFocus('oc2', 'oc2:vm-1', 'x', s);
    expect(takeTargetFocus(s).jobid).toBe(null);
  });
  it('진행 · 이력이 넘기기를 읽는다 — 그 VM 을 대상으로 · 그 jobid 의 로그를 요약으로', () => {
    const src = fs.readFileSync(path.join(HERE, 'BareosBackupTool.jsx'), 'utf8');
    expect(src).toMatch(/function HistoryTab\(\{ d, focus = null \}\)/);
    expect(src).toMatch(/f\.tab !== 'runs'/);
    expect(src).toMatch(/view: 'summary'/);
    expect(src).toMatch(/<RunsTab d=\{data\} boardHint=\{boardHint\} focus=\{focus\} \/>/);
    expect(src).toMatch(/if \(!f \|\| f\.tab === 'runs'\) return ''/);   // 백업 대상 패널은 runs 넘기기를 먹지 않는다
  });
});

describe('v2.872 묶어 보기', () => {
  const rows = [];
  for (let k = 0; k < 17; k++) rows.push(run(k, T - k * 20_000));
  rows.push({ at: T - 30_000, vc: '', vcName: '', src: 'veeam', kind: 'fail', job: '11. H/W Monitoring', vm: 'HM', msg: 'EM 세션 결과 Failed · HM', open: 'em' });
  rows.push({ at: T - 40_000, vc: '', vcName: '', src: 'veeam', kind: 'fail', job: '11. H/W Monitoring', vm: 'HM', msg: 'EM 세션 결과 Failed · HM', open: 'em' });
  const shaped = withShapeGroups(rows).sort((a, b) => b.at - a.at);   // 서버 묶음 id 그대로(웹은 다시 판정하지 않는다)
  it('서버 묶음 id 로 모은다 · 대상 패턴 · VM 수 · 로그를 읽을 수 있는 실행 수 · 시각 칸', () => {
    const g = P.groupErrors(shaped);
    expect(g.length).toBe(2);
    const b = g.find((x) => x.head.src === 'bareos');
    expect([b.n, b.vms, b.runs, b.target]).toEqual([17, 17, 17, 'pv-54220daf-vm-*']);
    expect(P.groupTimeText(b)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2} ~ \d{2}:\d{2}$/);
    const v = g.find((x) => x.head.src === 'veeam');
    expect([v.n, v.runs, v.target]).toEqual([2, 0, '11. H/W Monitoring']);
    expect(P.groupErrors([{ ...run(1, T), group: undefined }, { ...run(2, T), group: undefined }]).length).toBe(2);   // 구버전 서버 — 저마다 한 묶음
  });
  it('묶음 정렬 — 묶음 단위 · 모르는 값은 뒤', () => {
    const g = P.groupErrors(shaped);
    expect(P.sortGroups(g, { key: 'n', dir: 'desc' })[0].n).toBe(17);
    expect(P.sortGroups(g, { key: 'n', dir: 'asc' })[0].n).toBe(2);
    expect(P.sortGroups(g, { key: 'corp', dir: 'asc' })[1].head.vcName).toBe('');   // 법인 없음(EM)은 뒤
    expect(P.GROUP_SORT_KEYS).toContain('time');
  });
  it('묶음 로그 요청 — 서버 상한과 같은 값 · 새것부터 · 나머지 수', () => {
    expect(P.BULK_LOG_MAX).toBe(LOGS_MAX);
    const b = P.groupErrors(shaped).find((x) => x.head.src === 'bareos');
    const q = P.bulkLogItems(b);
    expect(q.items.length).toBe(LOGS_MAX);
    expect(q.more).toBe(17 - LOGS_MAX);
    expect(q.items[0]).toEqual({ id: 'j0', jobid: 20600 });
  });
  it('대조 한 줄 — 0 인 칸은 빼고 · 근거가 없으면 그렇게', () => {
    expect(P.bulkSummaryText({ total: 15, same: 13, other: 1, none: 0, unread: 1 })).toBe('13건이 같은 오류 · 1건 다른 오류 · 1건 못 읽음');
    expect(P.bulkSummaryText({ total: 2, same: 0, other: 2, none: 0, unread: 0 })).toMatch(/^같은 오류로 묶이는 실행이 없습니다/);
    expect(P.bulkSummaryText(null)).toBe('');
    expect(Object.keys(P.MATCH_TEXT).sort()).toEqual(['none', 'other', 'same', 'unread']);
  });
  it('보기 기억 — 못 읽으면 따로 보기', () => {
    const s = mem();
    expect(P.loadErrorView(s)).toBe('rows');
    P.saveErrorView('groups', s);
    expect(P.loadErrorView(s)).toBe('groups');
    expect(P.loadErrorView({ getItem: () => { throw new Error('x'); } })).toBe('rows');
    expect(P.jobPattern(['ab', 'cd'])).toBe('여러 잡');
  });
  it('문구에 백틱이 없다(BoldText 규칙)', () => {
    const all = JSON.stringify([P.MATCH_TEXT, P.ERROR_VIEWS, P.bulkSummaryText({ total: 3, same: 0, other: 3, none: 0, unread: 0 })]);
    expect(all).not.toContain('`');
    const drawer = fs.readFileSync(path.join(HERE, 'BackupErrorDrawer.jsx'), 'utf8');
    expect(drawer).toMatch(/className="err-drawer"/);
    expect(fs.readFileSync(path.join(HERE, '..', '..', 'styles.css'), 'utf8')).toMatch(/\.err-drawer \{[^}]*bottom: var\(--statusbar-h, 34px\)/);
  });
});
