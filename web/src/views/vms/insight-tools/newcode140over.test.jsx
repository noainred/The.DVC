// 새 코드 점검 140회차 — VM 탭 ‘과할당’ 보기(VmOverView)의 S2 환산용 /hosts/corp 는 서버가 inv.hosts 로 막는다(routes/api/hostCorp.js).
//   inv.hosts 가 없는 역할에는 부르지 않는다(예전: 보기를 열 때마다 403 — 화면은 ‘받지 못해 호스트 대수로 바꾸지 않았습니다’ 로 같다).
//   이 저장소의 웹 시험은 node 환경(DOM 없음)이라 효과를 직접 돌린다 — 이 파일에서만 react 의 useEffect 를 ‘렌더 중 바로 실행’ 으로 바꾼다
//   (요약 훅 · useLatest 는 가짜라 렌더 중 상태를 바꾸지 않는다).
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('react', async (orig) => {
  const real = await orig();
  const useEffect = (fn) => { fn(); };
  return { ...real, useEffect, default: { ...real.default, useEffect } };
});
const perm = { hosts: true };
const fetched = [];
vi.mock('../../../api.js', async (orig) => {
  const real = await orig();
  return { ...real, fetchJson: (path) => { fetched.push(path); return new Promise(() => {}); }, toolAllowed: () => true, hasRole: () => true,
    can: (k) => (k === 'inv.hosts' ? perm.hosts : true) };
});
vi.mock('./useToolSummary.js', () => ({ useToolSummary: () => ({ data: null, error: null, loading: true, at: null, reload: () => {} }) }));
vi.mock('../../../hooks/useLatest.js', () => ({ useLatest: () => () => {} }));
const { default: VmOverView } = await import('./VmOverView.jsx');
const render = () => renderToStaticMarkup(React.createElement(VmOverView, { vcIds: [], rows: [], canTool: () => true }));

describe('140회차 — 과할당 보기의 /hosts/corp 는 inv.hosts 가 있을 때만', () => {
  it('inv.hosts 가 없으면 부르지 않는다', () => {
    perm.hosts = false; fetched.length = 0;
    render();
    expect(fetched).not.toContain('/hosts/corp');
  });
  it('inv.hosts 가 있으면 부른다(기존 동작 — 시험 장치가 효과를 실제로 돌리는지도 함께 확인)', () => {
    perm.hosts = true; fetched.length = 0;
    render();
    expect(fetched).toContain('/hosts/corp');
  });
});
