// dbg3221 8회차 — VM 분석 ‘VM 수 추이 · 생성/삭제’ 의 생성 · 삭제 요약(lifeView): 이벤트를 수집하지 않는 법인(notCollected)의 줄을 합에 넣던 결함.
//   서버 /tools/vm-lifecycle?summary=1 은 수집 밖 법인에도 줄을 싣는다(쌓인 이벤트가 없으면 0 줄 — vmLifecycle.js).
//   예전: 고른 법인이 모두 수집 밖이면 ‘+0 생성 · 0 삭제 · 순증 0’ + ‘이 기간에 기록된 생성 · 삭제가 없습니다.’ 로 단정했고,
//   일부만 수집 밖이면 그 법인의 쌓인 이벤트를 합에 넣은 채 ‘세지 않았습니다’ 라고 적었다(문구와 계산이 반대).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../../test/_stripComments.js';
import { lifeView } from './vmToolPanelsText.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const zeroRow = (id) => ({ vcenterId: id, total: 0, added: 0, removed: 0, net: 0, byKind: { create: 0, clone: 0, deploy: 0, register: 0, remove: 0 }, noDetail: 0, shortLivedCount: 0,
  series: Array.from({ length: 8 }, (_, i) => ({ day: 1000 + i, added: 0, removed: 0 })) });
const row = (id, added, removed) => ({ ...zeroRow(id), added, removed, net: added - removed, byKind: { create: added, remove: removed },
  series: [{ day: 1000, added, removed }] });

describe('dbg3221 8회차 — 수집 밖 법인은 생성 · 삭제 합에서 뺀다', () => {
  it('고른 법인이 모두 수집 밖이면 수는 null(‘—’) · allNotCollected · 날마다 칸 없음', () => {
    const resp = { summary: true, days: 7, rows: [zeroRow('vc-pl')], notCollected: [{ vcenterId: 'vc-pl', why: 'edge' }] };
    const v = lifeView(resp, ['vc-pl']);
    expect([v.added, v.removed, v.net]).toEqual([null, null, null]);
    expect(v.allNotCollected).toBe(true);
    expect(v.empty).toBe(false);
    expect(v.notCollected).toBe(1);
    expect(v.series).toEqual([]);
    expect(v.kinds.every((k) => k.n === 0)).toBe(true);
  });

  it('일부만 수집 밖이면 그 법인의 쌓인 이벤트를 합에 넣지 않는다(‘세지 않았습니다’ 와 같은 계산)', () => {
    const resp = { summary: true, days: 7, rows: [row('vc-a', 5, 1), row('vc-pl', 3, 2)], notCollected: [{ vcenterId: 'vc-pl', why: 'edge' }] };
    const v = lifeView(resp, ['vc-a', 'vc-pl']);
    expect([v.added, v.removed, v.net]).toEqual([5, 1, 4]);
    expect(v.kinds.find((k) => k.key === 'create').n).toBe(5);
    expect(v.series).toEqual([{ day: 1000, added: 5, removed: 1, partial: false }]);
    expect(v.allNotCollected).toBe(false);
    expect(v.notCollected).toBe(1);
  });

  it('수집 밖 법인을 고르지 않았으면 그 줄과 안내 모두 영향 없음 · 범위 전체(vcIds 빈 배열)면 뺀다', () => {
    const resp = { summary: true, days: 7, rows: [row('vc-a', 5, 1), row('vc-pl', 3, 2)], notCollected: [{ vcenterId: 'vc-pl', why: 'edge' }] };
    const a = lifeView(resp, ['vc-a']);
    expect([a.added, a.notCollected]).toEqual([5, 0]);
    const all = lifeView(resp, []);
    expect([all.added, all.notCollected, all.allNotCollected]).toEqual([5, 1, false]);
  });

  it('화면 계약 — 모두 수집 밖이면 ‘기록이 없다’ 단정 문구를 내지 않고 생성 수에 ‘+—’ 를 만들지 않는다', () => {
    const src = stripComments(fs.readFileSync(path.join(here, 'VmToolPanels.jsx'), 'utf8'));
    expect(src).toMatch(/!l\.allNotCollected && <div className="vit-note">\{l\.kinds/);
    expect(src).toMatch(/big: l\.added == null \? '—' : `\+\$\{fmtN\(l\.added\)\}`/);
    expect(src).toMatch(/l\?\.allNotCollected \? '이벤트를 수집하지 않는 법인이라 날마다 수가 없습니다\.'/);
  });
});
