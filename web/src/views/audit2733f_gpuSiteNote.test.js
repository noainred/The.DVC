// audit2733f_gpuSiteNote.test.js — 점검 3회차(v2.733) 그룹 f · C4-01 화면 쪽.
// GPU 게스트 설정의 '이 포탈(로컬 수집)' 대상 목록에서 엣지 위임(site)·비활성·점검중 vCenter 는 이 노드가 직접 수집하지 않는다 —
// 예전에는 구분 없이 나열돼 켜면 중앙이 그 vCenter 에 직접 로그인했다. 판정 순서는 서버 collectTarget.js 와 같다.
import { describe, it, expect } from 'vitest';
import { gpuVcTargetNote, gpuSkippedNote } from './GpuGuestSettings.jsx';
import { boldParts } from '../components/boldText.jsx';

describe('C4-01 gpuVcTargetNote — 로컬 대상에서 직접 수집하지 않는 vCenter 를 말한다', () => {
  it('엣지 위임은 담당 엣지와 함께 "엣지가 수집 — 이 포탈 설정은 쓰이지 않음"', () => {
    const n = gpuVcTargetNote({ id: 'a', collectMode: 'site', remoteAgent: 'Edge-Seoul' }, '');
    expect(n.kind).toBe('site');
    expect(n.text).toMatch(/엣지가 수집/);
    expect(n.text).toMatch(/이 포탈 설정은 쓰이지 않습니다/);
    expect(n.text).toMatch(/Edge-Seoul/);
    const none = gpuVcTargetNote({ id: 'b', collectMode: 'site' }, '');
    expect(none.text).toMatch(/담당 엣지 미지정/);
  });
  it('판정 순서는 서버와 같다 — 비활성 → 점검중 → 엣지 위임', () => {
    expect(gpuVcTargetNote({ enabled: false, maintenance: true, collectMode: 'site' }, '').kind).toBe('disabled');
    expect(gpuVcTargetNote({ maintenance: true, collectMode: 'site' }, '').kind).toBe('maintenance');
    expect(gpuVcTargetNote({ collectMode: 'direct' }, '')).toBe(null);
    expect(gpuVcTargetNote({}, '')).toBe(null);
  });
  it('원격 엣지 배포 대상을 편집 중이면 말하지 않는다(그 엣지의 등록부가 판정한다)', () => {
    expect(gpuVcTargetNote({ collectMode: 'site', remoteAgent: 'E' }, 'E')).toBe(null);
  });
  it('문구는 **강조** 만 — 백틱 없음, 짝이 맞는다', () => {
    for (const vc of [{ collectMode: 'site', remoteAgent: 'E' }, { collectMode: 'site' }, { enabled: false }, { maintenance: true }]) {
      const t = gpuVcTargetNote(vc, '').text;
      expect(t).not.toMatch(/`/);
      expect(boldParts(t).some((p) => p.b)).toBe(true);
      expect(boldParts(t).map((p) => p.t).join('')).not.toMatch(/\*\*/);
    }
  });
});

describe('C4-01 gpuSkippedNote — 마지막 수집에서 로그인하지 않고 건너뛴 개수', () => {
  it('사유별 개수를 말하고, 없으면 null', () => {
    expect(gpuSkippedNote({ skippedCounts: { site: 2, maintenance: 1 } })).toBe('건너뜀(로그인하지 않음): 엣지 위임 **2**곳 · 점검중 **1**곳');
    expect(gpuSkippedNote({ skippedCounts: {} })).toBe(null);
    expect(gpuSkippedNote({})).toBe(null);
    expect(gpuSkippedNote(null)).toBe(null);
    expect(gpuSkippedNote({ skippedCounts: { site: 0, disabled: '' } })).toBe(null);
  });
});
