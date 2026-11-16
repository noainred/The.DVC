import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HostBasicRows } from './EntityDetail.jsx';

// 2차 공통 기능 점검 7회차: 호스트 상세가 못 읽은 메모리 · 코어 · VM 수 · HBA/GPU 를 '0 GB' · 'null코어' · '0개' 로 그렸다.
describe('HostBasicRows — 못 읽은 값은 0 이 아니라 —', () => {
  it('연결 끊긴 호스트(값 없음)', () => {
    const html = renderToStaticMarkup(<HostBasicRows item={{ name: 'esx-1', connectionState: 'DISCONNECTED', memTotalMB: null, cpuCores: null, vmCount: null }} onShowVms={() => {}} />);
    expect(html).not.toMatch(/0 GB/);
    expect(html).not.toMatch(/null|undefined/);
    expect(html).not.toMatch(/>코어/);
    expect(html).not.toMatch(/VM 0대/);   // 못 읽은 VM 수를 '0대' 로 말하지 않는다
    expect(html).toMatch(/VM 목록 보기/);
    expect(html).toMatch(/메모리[\s\S]{0,200}—/);
  });
  it('값이 있으면 그대로(0 은 값)', () => {
    const html = renderToStaticMarkup(<HostBasicRows item={{ name: 'esx-2', connectionState: 'CONNECTED', memTotalMB: 524288, cpuCores: 32, vmCount: 0, hbas: [], gpus: [{}] }} onShowVms={() => {}} />);
    expect(html).toMatch(/512 GB/);
    expect(html).toMatch(/32코어/);
    expect(html).toMatch(/0개 \/ 1개/);
  });
});
