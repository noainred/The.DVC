/**
 * v2.732 점검 2회차 그룹 i2 — B5-02(웹 절반): 삭제된 vCenter·VM id 가 남은 설정 화면.
 *  · 현재 사용자 설정: 400 본문의 r.settings(undefined)로 상태를 덮어 창이 '불러오는 중…' 에서 멈췄다(재현)
 *  · VM 성능 트래킹: 400 본문을 '저장되었습니다.' 로 읽었다(재현) · '2개 선택' 인데 칩은 1개라 낡은 id 를 지울 수 없었다
 *  · VM 실시간 스파이크: 트리는 스냅샷 VM 만 그려 낡은 VM·호스트·vCenter 를 해제할 수 없었다
 * 서버는 이제 이미 저장돼 있던 낡은 id 를 통과·보존하고 staleIds(·staleTargets)로 밝힌다 — 화면은 그것을 '목록에 없음' 칩으로 그린다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../test/_stripComments.js';
import {
  staleIdsOf, withoutKey, pendingStaleTargets, staleTargetChips, staleTargetCount, staleChipLabel,
  removeStaleTarget, staleNote, staleKeptSuffix, settingsSaveOutcome,
} from './staleSettingIds.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => stripComments(fs.readFileSync(path.join(here, rel), 'utf8'));

describe('B5-02 저장 응답 판정 — 실패면 편집값을 그대로 둔다', () => {
  const cur = { enabled: true, vcenters: { 'vc-a': { enabled: true }, 'vc-gone': { enabled: true } } };
  it('400 본문 {ok:false,reason} — settings 를 undefined 로 덮지 않는다(예전 Loading 멈춤의 원인)', () => {
    const o = settingsSaveOutcome(cur, { ok: false, reason: '존재하지 않는 vCenter id: vc-typo' });
    expect(o.ok).toBe(false);
    expect(o.settings).toBe(cur);
    expect(o.msg).toBe('저장 실패: 존재하지 않는 vCenter id: vc-typo');
  });
  it('{error} 본문·사유 없는 ok:false 도 실패다', () => {
    expect(settingsSaveOutcome(cur, { error: 'forbidden', reason: '권한 없음' }).ok).toBe(false);
    expect(settingsSaveOutcome(cur, { ok: false }).settings).toBe(cur);
  });
  it('성공이면 서버 값으로 바꾸고, 보존한 낡은 id 개수를 말한다', () => {
    const next = { enabled: false, vcenters: {} };
    const o = settingsSaveOutcome(cur, { ok: true, settings: next, staleIds: ['vc-gone'] });
    expect(o.ok).toBe(true);
    expect(o.settings).toBe(next);
    expect(o.msg).toBe('저장했습니다. 목록에 없는 vCenter 1곳은 그대로 남겼습니다.');
    // settings 가 없는 성공 본문은 편집값 유지(undefined 금지)
    expect(settingsSaveOutcome(cur, { ok: true }).settings).toBe(cur);
    expect(settingsSaveOutcome(cur, null).settings).toBe(cur);
  });
  it('staleKeptSuffix — 조사·단위', () => {
    expect(staleKeptSuffix({ staleIds: [] })).toBe('');
    expect(staleKeptSuffix({})).toBe('');
    expect(staleKeptSuffix({ staleIds: ['a', 'b'] }, { unit: '대상', count: '개' })).toBe(' 목록에 없는 대상 2개는 그대로 남겼습니다.');
  });
});

describe('B5-02 목록에 없는 id 판정·해제', () => {
  it('staleIdsOf — 지금 선택 중 목록({id}·문자열)에 없는 것, 중복·빈 값 제외', () => {
    expect(staleIdsOf(['vc-a', 'vc-gone', 'vc-gone', ''], [{ id: 'vc-a' }, { id: 'vc-b' }])).toEqual(['vc-gone']);
    expect(staleIdsOf(['vc-a'], ['vc-a'])).toEqual([]);
    expect(staleIdsOf(undefined, [])).toEqual([]);
  });
  it('withoutKey — 원본을 바꾸지 않는다', () => {
    const m = { a: 1, b: 2 };
    expect(withoutKey(m, 'a')).toEqual({ b: 2 });
    expect(m).toEqual({ a: 1, b: 2 });
  });
  const ST = {
    'vc-a': { vcenter: false, hosts: ['vc-a:host-old'], vms: ['vc-a:vm-old'] },
    'vc-gone': { vcenter: true, hosts: [], vms: ['vc-gone:vm-1'] },
  };
  const TG = {
    'vc-a': { clusters: [], folders: [], hosts: ['vc-a:host-1', 'vc-a:host-old'], vms: ['vc-a:vm-1', 'vc-a:vm-old'] },
    'vc-gone': { clusters: [], folders: [], hosts: [], vms: ['vc-gone:vm-1'] },
  };
  it('pendingStaleTargets — 사람이 해제하면 그 칩이 바로 사라진다', () => {
    expect(staleTargetCount(pendingStaleTargets(ST, TG))).toBe(3);
    const t1 = removeStaleTarget(TG, 'vc-a', 'vms', 'vc-a:vm-old');
    expect(t1['vc-a'].vms).toEqual(['vc-a:vm-1']);
    expect(TG['vc-a'].vms).toEqual(['vc-a:vm-1', 'vc-a:vm-old']);   // 원본 불변
    expect(pendingStaleTargets(ST, t1)['vc-a']).toEqual({ vcenter: false, hosts: ['vc-a:host-old'], vms: [] });
    const t2 = removeStaleTarget(removeStaleTarget(t1, 'vc-a', 'hosts', 'vc-a:host-old'), 'vc-gone', 'vcenter', 'vc-gone');
    expect(t2['vc-gone']).toBeUndefined();
    expect(pendingStaleTargets(ST, t2)).toEqual({});
    expect(staleTargetChips(pendingStaleTargets(ST, t2))).toEqual([]);
  });
  it("'전체' 로 바꾼 vCenter 의 낡은 호스트·VM 은 더 남지 않는다(사라진 vCenter 표지는 남는다)", () => {
    const p = pendingStaleTargets(ST, { 'vc-a': { all: true }, 'vc-gone': { all: true } });
    expect(p['vc-a']).toBeUndefined();
    expect(p['vc-gone']).toEqual({ vcenter: true, hosts: [], vms: [] });
  });
  it('칩 — 사라진 vCenter 는 한 칩(그 아래 개수만), 살아 있는 vCenter 의 낡은 대상은 하나씩', () => {
    const chips = staleTargetChips(pendingStaleTargets(ST, TG));
    expect(chips.map((c) => `${c.kind}:${c.id}`)).toEqual(['hosts:vc-a:host-old', 'vms:vc-a:vm-old', 'vcenter:vc-gone']);
    expect(staleChipLabel(chips[2])).toBe('vCenter vc-gone (그 아래 대상 1개 포함)');
    expect(staleChipLabel(chips[0])).toBe('호스트 vc-a:host-old');
    expect(staleChipLabel(chips[1])).toBe('VM vc-a:vm-old');
  });
  it('removeStaleTarget — 모르는 종류·전체 모드·없는 키는 그대로', () => {
    expect(removeStaleTarget(TG, 'vc-x', 'vms', 'a')).toBe(TG);
    expect(removeStaleTarget({ a: { all: true } }, 'a', 'vms', 'x')).toEqual({ a: { all: true } });
    expect(removeStaleTarget(TG, 'vc-a', 'clusters', 'x')).toBe(TG);
  });
  it('안내 문구 — **강조** 만, 백틱 없음, 조사, 데이터 삭제 고지', () => {
    expect(staleNote(0)).toBe('');
    const n = staleNote(2);
    expect(n).toMatch(/\*\*2곳\*\*이 설정에/);
    expect(n).not.toMatch(/`/);
    expect(staleNote(3, { unit: '대상', count: '개' })).toMatch(/\*\*3개\*\*가 설정에/);
    expect(staleNote(1, { drop: true })).toMatch(/데이터 파일도 삭제/);
    expect(staleNote(1)).not.toMatch(/데이터 파일/);
  });
});

describe('B5-02 화면 배선', () => {
  it('현재 사용자 설정: 저장 판정은 settingsSaveOutcome — 400 본문의 r.settings 로 상태를 덮지 않는다 · 낡은 키를 행으로 그려 뺄 수 있다', () => {
    const s = src('tools/CurrentUsersSettings.jsx');
    expect(s).toMatch(/const o = settingsSaveOutcome\(s, r\);/);
    expect(s).not.toMatch(/setS\(r\.settings\)/);
    expect(s).toMatch(/staleIdsOf\(Object\.keys\(s\.vcenters \|\| \{\}\), vcenters\)/);
    expect(s).toMatch(/withoutKey\(s\.vcenters, id\)/);
  });
  it('VM 성능 트래킹: putJson 반환을 requireChanged 로 판정 · 낡은 id 칩(해제·되돌리기)', () => {
    const s = src('MetricsSettings.jsx');
    expect(s).toMatch(/requireChanged\(await putJson\('\/tools\/waste\/settings'/);
    expect(s).toMatch(/staleIdsOf\(d\.settings\?\.vcenterIds, d\.vcenters \|\| \[\]\)/);
    expect(s).toMatch(/loadedStale\.map\(/);
    expect(s).toMatch(/staleNote\(staleIds\.length, \{ drop: true \}\)/);
  });
  it('VM 실시간 스파이크: requireChanged · 서버 staleTargets 로 낡은 대상 칩', () => {
    const s = src('VmSeriesSettings.jsx');
    expect(s).toMatch(/requireChanged\(await putJson\('\/tools\/vmseries\/settings'/);
    expect(s).toMatch(/staleTargetChips\(pendingStaleTargets\(d\.staleTargets, targets\)\)/);
    expect(s).toMatch(/removeStaleTarget\(cur, c\.vcId, c\.kind, c\.id\)/);
  });
});
