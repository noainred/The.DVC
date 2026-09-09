/**
 * hashTab — 하위 탭 URL 유지(v2.438) 회귀 고정.
 * 웹 테스트는 node 환경(DOM 없음)이라 훅 자체는 못 돌린다 — 판정을 순수 함수로 고정한다.
 */
import { describe, it, expect } from 'vitest';
import { hashSegments, isUnderBase, tabFromHash, buildHash } from './hashTab.js';

describe('hashSegments', () => {
  it('선행 #/ 와 빈 조각을 걷어낸다', () => {
    expect(hashSegments('#/settings/collectors')).toEqual(['settings', 'collectors']);
    expect(hashSegments('#/tools/gpu/cluster')).toEqual(['tools', 'gpu', 'cluster']);
    expect(hashSegments('#/settings/')).toEqual(['settings']);
    expect(hashSegments('')).toEqual([]);
    expect(hashSegments('#')).toEqual([]);
  });
});

describe('isUnderBase — 남의 화면 해시를 삼키지 않는다', () => {
  it('base 접두가 맞아야 참', () => {
    expect(isUnderBase('#/settings/collectors', ['settings'])).toBe(true);
    expect(isUnderBase('#/settings', ['settings'])).toBe(true);           // 하위키 없이 막 들어온 상태
    expect(isUnderBase('#/tools/gpu/cluster', ['tools', 'gpu'])).toBe(true);
    expect(isUnderBase('#/tools/pdu/list', ['tools', 'gpu'])).toBe(false); // 다른 도구
    expect(isUnderBase('#/networks/ping', ['settings'])).toBe(false);      // 다른 상단 탭
  });
});

describe('tabFromHash', () => {
  const V = ['list', 'check', 'vcport', 'ping'];
  it('base 아래의 하위키를 읽는다', () => {
    expect(tabFromHash('#/networks/ping', ['networks'], V)).toBe('ping');
    expect(tabFromHash('#/tools/gpu/cluster', ['tools', 'gpu'], ['host', 'cluster'])).toBe('cluster');
  });
  it('하위키가 없거나 모르는 값이면 null — 호출자가 fallback 을 정한다', () => {
    expect(tabFromHash('#/networks', ['networks'], V)).toBe(null);
    expect(tabFromHash('#/networks/nope', ['networks'], V)).toBe(null);   // 잘못된 딥링크로 빈 화면이 되면 안 된다
  });
  it('base 밖이면 null (다른 화면 해시를 자기 탭으로 오인하지 않는다)', () => {
    expect(tabFromHash('#/settings/collectors', ['networks'], V)).toBe(null);
    expect(tabFromHash('#/tools/pdu/list', ['tools', 'gpu'], ['list'])).toBe(null);
  });
});

describe('buildHash', () => {
  it('2단·3단 경로를 만든다', () => {
    expect(buildHash(['settings'], 'collectors')).toBe('#/settings/collectors');
    expect(buildHash(['settings', 'agent-deploy'], 'bulk')).toBe('#/settings/agent-deploy/bulk');
    expect(buildHash(['tools', 'gpu'], 'model')).toBe('#/tools/gpu/model');
  });
  it('왕복한다', () => {
    const h = buildHash(['tools', 'storage-mon'], 'trend');
    expect(tabFromHash(h, ['tools', 'storage-mon'], ['devices', 'trend'])).toBe('trend');
  });
});
