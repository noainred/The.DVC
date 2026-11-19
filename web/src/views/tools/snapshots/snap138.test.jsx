// 138회차 — 지금 값을 못 읽은 vCenter 를 법인 카드 · 요약이 ‘0대 · 스냅샷 없음’ 으로 적지 않는다(못 읽은 값은 0 이 아니다).
// 입력은 서버 snaphist/view.js 가 만든 실제 응답 모양(corps[].vcenters[].unread — 판정은 서버 vcReadIssue 하나).
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { snapshotToolView } = await import('../../../../../server/src/snaphist/view.js');
vi.mock('../../../api.js', async (orig) => ({ ...(await orig()), fetchJson: () => new Promise(() => {}), canCsv: () => true, toolAllowed: () => true }));
const T = await import('./snapText.js');
const { default: SnapshotTool } = await import('./SnapshotTool.jsx');

const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const HY = { snapAgeDays: 7, snapCount: 3, snapSizeGB: 100, exceptions: [], notify: { enabled: false, hour: 9 } };
const vm = (vc, name, o = {}) => ({ id: `${vc}:${name}`, vcenterId: vc, name, powerState: 'POWERED_ON', cluster: 'C1', host: 'h1',
  snapshotCount: 1, snapshotSizeGB: 20, snapshotOldestTs: NOW - 20 * DAY, ...o });
const view = (vb, vbVms = []) => snapshotToolView({ vcenters: [{ id: 'va', name: 'VC-A', status: 'connected' }, vb], datastores: [], vms: [vm('va', 'a1'), ...vbVms] }, { hygiene: HY, now: NOW });

describe('138회차 — 못 읽은 vCenter 의 법인 카드', () => {
  it('보존 창이 지난 unreachable · 기동 직후 pending · REST 폴백 — ‘스냅샷 없음’ 이 아니라 ‘못 읽음’', () => {
    for (const vb of [{ id: 'vb', name: 'VC-B', status: 'unreachable' }, { id: 'vb', name: 'VC-B', status: 'pending' }, { id: 'vb', name: 'VC-B', status: 'connected', collectSource: 'rest' }]) {
      const d = view(vb);
      const b = T.corpCards(d.items, d.corps).find((c) => c.id === 'vc:vb');
      expect(b.unread).toBe(1);
      expect(b.blind).toBe(true);
      expect(T.corpFootText(b)).not.toMatch(/스냅샷 없음/);
      expect(T.corpFootText(b)).toMatch(/지금 값을 못 읽은 vCenter 1곳/);
      const a = T.corpCards(d.items, d.corps).find((c) => c.id === 'vc:va');
      expect(a.unread).toBe(0); expect(a.blind).toBe(false);
    }
  });
  it('읽었고 스냅샷이 없으면 그대로 ‘스냅샷 없음’ · 값이 낡은 것은 ‘값이 낡음’ 하나만(중복으로 못 읽음을 붙이지 않는다)', () => {
    const d0 = view({ id: 'vb', name: 'VC-B', status: 'connected' });
    const b0 = T.corpCards(d0.items, d0.corps).find((c) => c.id === 'vc:vb');
    expect(b0.unread).toBe(0); expect(b0.blind).toBe(false); expect(T.corpFootText(b0)).toBe('스냅샷 없음');
    const ds = view({ id: 'vb', name: 'VC-B', status: 'connected', collectSource: 'site', stale: true }, [vm('vb', 'b1')]);
    const bs = T.corpCards(ds.items, ds.corps).find((c) => c.id === 'vc:vb');
    expect(bs.unread).toBe(0); expect(T.corpFootText(bs)).toMatch(/값이 낡음/); expect(T.corpFootText(bs)).not.toMatch(/못 읽은/);
  });
  it('화면 — 못 읽은 법인 카드는 수 · 크기를 말하지 않고, 요약은 빠진 vCenter 를 밝힌다', () => {
    const d = view({ id: 'vb', name: 'VC-B', status: 'unreachable' });
    const html = renderToStaticMarkup(<SnapshotTool initial={d} initialHist={{ ok: true, status: { available: false } }} />);
    expect(html).toMatch(/지금 값을 못 읽은 vCenter 1곳은 빠졌습니다/);
    expect(html).toMatch(/못 읽음/);
    const card = html.slice(html.indexOf('VC-B'), html.indexOf('</button>', html.indexOf('VC-B')));
    expect(card).not.toMatch(/0대/);
    expect(card).not.toMatch(/스냅샷 없음/);
  });
});
