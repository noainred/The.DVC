/**
 * v2.719 감사 그룹 F — W1-01(vCenter 선택지가 고른 하나로 접힘) · W1-03(재부팅 패널이 옛 선택의 데이터를 새 선택처럼 그림).
 * 웹 테스트는 DOM 이 없는 node 환경이라 화면은 렌더하지 못한다 — 판정은 순수 헬퍼를 실제로 불러 고정하고,
 * 10개 화면이 그 헬퍼로 선택지를 그리는지는 소스로 확인한다(주석을 먼저 지운다).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeVcChoices, vcChoiceList, selectionKey, keyedResult } from './vcChoices.js';
import { stripComments } from '../../test/_stripComments.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const A = { vcenterId: 'vc-a', name: 'A', vms: 10 };
const B = { vcenterId: 'vc-b', name: 'B', vms: 20 };
const C = { vcenterId: 'vc-c', name: 'C', vms: 30 };

describe('W1-01 mergeVcChoices — 전체 응답의 목록을 기억한다', () => {
  it('전체 응답(vcenterId 없음)은 목록을 그대로 기준으로 삼는다(사라진 vCenter 도 빠진다)', () => {
    expect(mergeVcChoices([A, B, C], [A, B], '')).toEqual([A, B]);
    expect(mergeVcChoices([A], [A, B, C], undefined)).toEqual([A, B, C]);
  });
  it('vCenter 를 고른 응답이 목록을 하나로 좁혀도 다른 vCenter 를 지우지 않는다', () => {
    const out = mergeVcChoices([A, B, C], [{ ...A, vms: 11 }], 'vc-a');
    expect(out.map((v) => v.vcenterId)).toEqual(['vc-a', 'vc-b', 'vc-c']);
    expect(out[0].vms).toBe(11);   // 고른 항목은 새 값으로
  });
  it('직전 목록이 없으면(범위가 미리 골라진 채 처음 연 경우) 응답 목록을 쓴다', () => {
    expect(mergeVcChoices([], [A], 'vc-a')).toEqual([A]);
  });
  it('직전에 없던 항목은 뒤에 붙이고, 모양이 잘못된 원소는 버린다', () => {
    expect(mergeVcChoices([A], [B, null, 'x', { name: 'no-id' }], 'vc-b').map((v) => v.vcenterId)).toEqual(['vc-a', 'vc-b']);
    expect(vcChoiceList(null)).toEqual([]);
  });
});

describe('W1-01 10개 화면이 기억한 목록으로 선택지를 그린다', () => {
  const FILES = ['VmHygieneTool', 'HostHygieneTool', 'StoragePathsTool', 'ClusterCheckTool', 'VmChangesTool',
    'CoreLicenseTool', 'VmTagsTool', 'ContentionTool', 'VmLifecycleTool', 'VmAvailabilityTool'];
  for (const f of FILES) {
    it(f, () => {
      const src = stripComments(fs.readFileSync(path.join(here, `${f}.jsx`), 'utf8'));
      expect(src).toMatch(/mergeVcChoices\(prev,/);
      expect(src).toMatch(/\{vcOpts\.map\(\(v\) => <option key=\{v\.vcenterId\}/);
      // 응답 목록으로 선택지를 다시 그리던 형태가 남아 있지 않다.
      expect(src).not.toMatch(/\{(vcs|\(data\.vcenters \|\| \[\]\))\.map\(\(v\) => <option/);
    });
  }
});

describe('W1-03 keyedResult — 지금 선택의 결과만 그린다', () => {
  const k30 = selectionKey('vc-a', 30);
  const k90 = selectionKey('vc-a', 90);
  const held = { key: k30, r: { rows: [1] } };
  it('키가 같으면 데이터를 그린다', () => {
    expect(keyedResult(held, null, k30)).toEqual({ error: null, data: { rows: [1] } });
  });
  it('선택을 바꾼 뒤(응답 전)에는 옛 데이터를 그리지 않는다', () => {
    expect(keyedResult(held, null, k90)).toEqual({ error: null, data: null });
  });
  it('새 선택의 재조회가 실패하면 옛 데이터가 있어도 오류를 말한다', () => {
    const e = new Error('boom');
    expect(keyedResult(held, { key: k90, e }, k90)).toEqual({ error: e, data: null });
  });
  it('vCenter 없음과 빈 문자열은 같은 선택이다 · vCenter 가 다르면 다른 선택이다', () => {
    expect(selectionKey(null, 30)).toBe(selectionKey('', 30));
    expect(selectionKey('vc-a', 30)).not.toBe(selectionKey('vc-b', 30));
  });
  it('재부팅 패널이 이 판정을 쓴다', () => {
    const src = stripComments(fs.readFileSync(path.join(here, 'HostHygieneTool.jsx'), 'utf8'));
    expect(src).toMatch(/keyedResult\(rd, err, want\)/);
    expect(src).not.toMatch(/if \(err && !d\)/);
  });
});

describe('v2.719 CPU 경합 — 선택지는 수집 상태가 아니라 범위 안 vCenter 전부', () => {
  it('ContentionTool 은 vcenterChoices 를 먼저 쓴다 · 서버가 싣는다', () => {
    const src = stripComments(fs.readFileSync(path.join(here, 'ContentionTool.jsx'), 'utf8'));
    expect(src).toMatch(/d\?\.vcenterChoices \|\| d\?\.status/);
    const srv = fs.readFileSync(path.join(here, '../../../../server/src/routes/api/contention.js'), 'utf8');
    expect(srv).toMatch(/vcenterChoices: S\.vcenters\.map/);
  });
});
