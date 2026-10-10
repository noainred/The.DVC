/**
 * v2.733 점검 3회차 그룹 c — C1-03(웹 절반): 인벤토리를 아직(또는 지금) 못 읽은 vCenter 의 선택 호스트·VM 을 서버가 판정하지 않고
 * staleUnknown 으로 싣는다. 화면은 그 vCenter 에 '목록에 없음' 칩(✕ 로 지우라는 뜻) 대신 '수집 전이라 판정하지 않음' 을 말한다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../test/_stripComments.js';
import { STALE_UNKNOWN_REASON, pendingStaleUnknown, staleUnknownNote } from './staleSettingIds.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('C1-03 판정하지 않은 vCenter — 지금 선택 기준', () => {
  const SU = {
    'vc-b': { reason: 'unreachable', hosts: 1, vms: 2 },
    'vc-p': { reason: 'pending', hosts: 0, vms: 200 },
    'vc-x': { reason: 'disabled', hosts: 3, vms: 0 },
  };
  const TG = {
    'vc-b': { clusters: [], folders: [], hosts: ['vc-b:h1'], vms: ['vc-b:v1', 'vc-b:v2'] },
    'vc-p': { all: true },                                       // '전체' 로 바꿨다 → 판정할 id 가 없다
    // vc-x 는 대상에서 뺐다
  };
  it('대상에서 빼거나 전체로 바꾼 vCenter 는 사라지고, 개수는 지금 targets 로 다시 센다', () => {
    expect(pendingStaleUnknown(SU, TG)).toEqual([{ vcId: 'vc-b', reason: 'unreachable', hosts: 1, vms: 2 }]);
    const tg2 = { ...TG, 'vc-b': { ...TG['vc-b'], vms: ['vc-b:v1'] } };
    expect(pendingStaleUnknown(SU, tg2)[0].vms).toBe(1);
    expect(pendingStaleUnknown(undefined, TG)).toEqual([]);
    expect(pendingStaleUnknown(SU, null)).toEqual([]);
  });
  it('문구 — 개수·이름·사유를 말하고, 지우지 말라고 말한다(백틱 없음 · 강조 짝수)', () => {
    const t = staleUnknownNote([{ vcId: 'vc-b', reason: 'unreachable', hosts: 1, vms: 2 }, { vcId: 'vc-p', reason: 'pending', hosts: 0, vms: 200 }],
      (id) => ({ 'vc-b': '법인B' })[id]);
    expect(t).toContain('**2곳**');
    expect(t).toContain('**수집 전이라 판정하지 않았습니다**');
    expect(t).toContain('‘법인B’(연결 실패 · 이어 쓸 직전 수집 없음 · 호스트 1 · VM 2)');
    expect(t).toContain('‘vc-p’(첫 수집 중 · 호스트 0 · VM 200)');   // 이름을 모르면 id
    expect(t).toContain('지우지 마세요');
    expect(t).not.toContain('`');
    expect((t.match(/\*\*/g) || []).length % 2).toBe(0);
    expect(staleUnknownNote([])).toBe('');
    expect(staleUnknownNote(undefined)).toBe('');
  });
  it('모르는 사유 코드는 지어내지 않고 미상이라 말한다 · 10곳이 넘으면 개수로 접는다', () => {
    expect(staleUnknownNote([{ vcId: 'v', reason: 'weird', hosts: 1, vms: 0 }])).toContain('수집 상태 미상');
    const many = Array.from({ length: 13 }, (_, i) => ({ vcId: `v${i}`, reason: 'pending', hosts: 1, vms: 1 }));
    const t = staleUnknownNote(many);
    expect(t).toContain('**13곳**');
    expect(t).toContain('외 3곳');
    expect(t).not.toContain('‘v12’');
  });
});

describe('C1-03 서버 사유 코드와 1:1', () => {
  it('STALE_UNKNOWN_REASON 키 == 서버 INVENTORY_UNREAD_REASONS', () => {
    const srv = fs.readFileSync(path.join(here, '../../../server/src/routes/api/vmSeries.js'), 'utf8');
    const m = srv.match(/INVENTORY_UNREAD_REASONS\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/);
    expect(m, '서버 INVENTORY_UNREAD_REASONS 를 찾지 못했다').toBeTruthy();
    const codes = [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]).sort();
    expect(Object.keys(STALE_UNKNOWN_REASON).sort()).toEqual(codes);
  });
  it('화면이 서버 staleUnknown 을 그 판정으로 그린다(칩 목록과 별개)', () => {
    const src = stripComments(fs.readFileSync(path.join(here, 'VmSeriesSettings.jsx'), 'utf8'));
    expect(src).toMatch(/staleUnknownNote\(\s*pendingStaleUnknown\(\s*d\.staleUnknown\s*,\s*targets\s*\)/);
    expect(src).toMatch(/<BoldText text=\{unknownNote\}/);
  });
});
