/**
 * v2.841 Bareos 자동 설정 개선(웹 순수 판정) — 사용자 화면 2026-11-01:
 *  ① 4단계 '매핑 빈 칸 0개를 채웠습니다 — 확인하고 매핑 저장' → 채울 칸이 없을 때·Schedule 을 못 읽었을 때를 그대로 말한다
 *  ② 2단계 겹침: 사전 점검 confFiles(또는 409 paths)로 OTP 를 쓰기 전에 막고, 사람이 만든 콘솔 이름이면 포탈 전용 이름을 고른다
 *  ③ 카탈로그 일부 실패 문구(Schedule 은 .schedule ACL 안내)
 */
import { describe, it, expect } from 'vitest';
import {
  fillEmptyMapping, fillResultText, directorPlanFiles, directorConflicts, freeConsoleName, consoleTaken, conflictText, ownFromPaths, catalogErrorText, DIR_CONF_ROOT,
} from './bareosText.js';

const ROW = { vcenterId: 'vc-a', vcserver: '192.168.21.200', client: 'bareos-fd', storage: 'File', pool: 'Full', schedule: '', configFile: '/etc/bareos/vmware/OC2.ini' };

describe('v2.841 ① 빈 칸 채우기 결과 문구', () => {
  it('필수 칸이 다 차 있고 Schedule 목록을 못 읽었으면 — 0개 채움이 아니라 이유를 말한다(사용자 화면 그대로)', () => {
    const out = fillEmptyMapping([ROW], [{ vcenterId: 'vc-a', fields: { schedule: { value: '', unread: true, why: '읽지 못함' } } }], () => 'OC2');
    expect(out.filled).toBe(0);
    expect(out.left).toEqual([]);
    expect(out.scheduleBlank).toEqual(['OC2']);
    expect(out.scheduleUnread).toBe(true);
    const r = fillResultText(out, { unsaved: false });
    expect(r.text).toMatch(/^채울 빈 칸이 없습니다 — 필수 칸/);
    expect(r.text).toMatch(/5단계로 넘어가면 됩니다/);
    expect(r.text).toMatch(/Schedule 은 Director 의 스케줄 목록을 읽지 못해 비워 두었습니다\(OC2\)/);
    expect(r.text).not.toMatch(/0개/);
    expect(r.tone).toBe(true);
  });
  it('저장하지 않은 변경이 있으면 저장하라고 · 확인 필요', () => {
    const r = fillResultText({ filled: 0, left: [], scheduleBlank: [] }, { unsaved: true });
    expect(r.text).toMatch(/‘매핑 저장’ 을 누르세요/);
    expect(r.tone).toBe('warn');
  });
  it('채웠으면 개수와 저장 안내 · 진행(저장 남음)', () => {
    const out = fillEmptyMapping([{ ...ROW, storage: '' }], [{ vcenterId: 'vc-a', fields: { storage: { value: 'File' }, schedule: { value: 'PortalVmwareNightly' } } }], () => 'OC2');
    expect(out.filled).toBe(2);
    const r = fillResultText(out);
    expect(r.text).toMatch(/^빈 칸 2개를 채웠습니다/);
    expect(r.tone).toBe(null);
  });
  it('제안이 없는 필수 칸은 남은 칸으로 · 못 읽은 목록이면 그 사실을 붙인다 · Schedule 은 비워도 되는 칸(후보가 정해지지 않음)', () => {
    const out = fillEmptyMapping([{ ...ROW, pool: '' }], [{ vcenterId: 'vc-a', fields: { pool: { value: '', unread: true }, schedule: { value: '', why: '후보 2개' } } }], () => 'OC2');
    expect(out.left).toEqual(['OC2 · Pool(Director 목록을 읽지 못함)']);
    const r = fillResultText(out);
    expect(r.text).toMatch(/^채울 수 있는 빈 칸이 없습니다\. 제안이 없어 남은 칸: OC2 · Pool/);
    expect(r.text).toMatch(/고를 후보가 하나로 정해지지 않아/);
    expect(r.tone).toBe('warn');
  });
  it('문구에 백틱 없음(BoldText 규약)', () => {
    for (const o of [{ filled: 0, left: [], scheduleBlank: ['a'], scheduleUnread: true }, { filled: 3, left: ['x'], scheduleBlank: [] }]) expect(fillResultText(o).text).not.toMatch(/`/);
  });
});

describe('v2.841 ② 2단계 겹침 · 포탈 전용 콘솔 이름', () => {
  const own = [{ type: 'console', name: 'admin', state: 'foreign' }, { type: 'console', name: 'portal', state: 'managed' }, { type: 'profile', name: 'webui-admin', state: 'foreign' }];
  it('사람이 만든 콘솔과 같은 이름이면 겹침 · 포탈 파일은 겹침이 아니다 · 점검 전이면 null(모름)', () => {
    const plan = directorPlanFiles({ consoleName: 'admin' });
    expect(directorConflicts(plan, own)).toEqual([{ type: 'console', name: 'admin', state: 'foreign', path: `${DIR_CONF_ROOT}/console/admin.conf` }]);
    expect(directorConflicts(directorPlanFiles({ consoleName: 'portal' }), own)).toEqual([]);
    expect(directorConflicts(plan, null)).toBe(null);
    expect(directorConflicts(plan, undefined)).toBe(null);
  });
  it('Pool · Schedule 은 고를 때만 계획에 들어간다', () => {
    const o2 = [{ type: 'pool', name: 'PortalVmwareFull', state: 'foreign' }];
    expect(directorConflicts(directorPlanFiles({ pools: false }), o2)).toEqual([]);
    expect(directorConflicts(directorPlanFiles({ pools: true }), o2)).toHaveLength(1);
  });
  it('빈 이름: 사람이 만든 콘솔·지금 이름은 건너뛴다 · 포탈이 만든 콘솔은 다시 써도 된다', () => {
    expect(freeConsoleName(own, 'admin')).toBe('portal');
    expect(freeConsoleName([{ type: 'console', name: 'portal', state: 'foreign' }], 'admin')).toBe('portal-vmware');
    expect(freeConsoleName(null, 'portal')).toBe('portal-vmware');
    expect(freeConsoleName(null, 'admin')).toBe('portal');
    const all = ['portal', 'portal-vmware', 'portal2', 'portal3', 'portal4', 'portal5'].map((name) => ({ type: 'console', name, state: 'foreign' }));
    expect(freeConsoleName(all, '')).toBe('');
  });
  it('409 paths → 겹친 파일 · 콘솔 겹침 판정', () => {
    const paths = ['/etc/bareos/bareos-dir.d/console/admin.conf', '/etc/bareos/bareos-dir.d/pool/PortalVmwareFull.conf', '/etc/passwd', '/etc/bareos/bareos-dir.d/console/../x.conf'];
    expect(ownFromPaths(paths)).toEqual([{ type: 'console', name: 'admin', state: 'foreign' }, { type: 'pool', name: 'PortalVmwareFull', state: 'foreign' }]);
    expect(ownFromPaths(null)).toEqual([]);
    expect(consoleTaken(paths, 'admin')).toBe(true);
    expect(consoleTaken(paths, 'portal')).toBe(false);
    expect(consoleTaken(undefined, 'admin')).toBe(false);
  });
  it('안내 문구: 콘솔이면 이름을 바꾸라고 · 그 밖은 기본값·전용 Pool · 백틱 없음', () => {
    const t = conflictText([{ type: 'console', name: 'admin', state: 'foreign' }]);
    expect(t).toMatch(/console ‘admin’/);
    expect(t).toMatch(/서버에 접속하기 전에 막았습니다/);
    expect(t).toMatch(/만들 콘솔 이름/);
    expect(t).toMatch(/사전 점검을 다시 하세요/);
    expect(t).not.toMatch(/설정 탭 기본값/);
    expect(conflictText([{ type: 'pool', name: 'PortalVmwareFull', state: 'notfile' }])).toMatch(/일반 파일 아님.*전용 Pool/);
    expect(conflictText([])).toBe('');
    expect(t).not.toMatch(/`/);
  });
});

describe('v2.841 ③ 카탈로그 일부 실패 문구', () => {
  it('칸 이름으로 · Schedule 이면 .schedule ACL 안내', () => {
    expect(catalogErrorText({ schedules: 'schedules: is an invalid command.' })).toMatch(/^Director 목록 일부를 읽지 못했습니다\(Schedule\).*Command ACL 에 \.schedule/);
    expect(catalogErrorText({ pools: 'x' })).not.toMatch(/\.schedule/);
    expect(catalogErrorText({})).toBe('');
    expect(catalogErrorText(null)).toBe('');
    expect(catalogErrorText({ schedules: 'x', pools: 'y' })).not.toMatch(/`/);
  });
});
