/**
 * v2.744 회귀 검토 GA-R3 — VM 수량 추이(VmTrackTool)는 조회 중·조회 실패에도 선택 도구(vCenter·기간·지금 스냅샷)를 그린다.
 *   WEB-01(이전 범위 값 비우기) 뒤에 `if (error && !data) return <ErrorBox/>` 가 선택 도구보다 먼저 반환해, vCenter·기간을 바꾼
 *   조회가 한 번 실패하면 도구 전체가 오류 화면에 갇혔다(이 화면은 폴링하지 않아 저절로 회복하지 않고, '다시 시도' 는 새로고침이라
 *   선택이 전체·30일로 돌아갔다). 365일·고RTT 조회 동안에도 선택 도구가 Loading 으로 사라져 다른 기간을 고를 수 없었다.
 *
 * 렌더(renderToStaticMarkup)로 본다 — 서버 렌더에서는 효과가 돌지 않으므로 첫 렌더가 곧 '조회 중(data 없음)' 상태다.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import VmTrackTool, { VmTrackLoadFailed } from './VmTrackTool.jsx';
import { stripComments } from '../../test/_stripComments.js';

const h = React.createElement;
const here = path.dirname(fileURLToPath(import.meta.url));

describe('GA-R3 VM 수량 추이 — data 가 비어도 선택 도구를 그린다', () => {
  it('조회 중(첫 렌더)에도 vCenter 선택·기간 버튼·지금 스냅샷이 Loading 과 함께 보인다', () => {
    const html = renderToStaticMarkup(h(VmTrackTool));
    expect(html).toContain('전체 vCenter(합계)');
    for (const d of [7, 30, 90, 365]) expect(html).toContain(`>${d}일<`);
    expect(html).toContain('지금 스냅샷');
    expect(html).toContain('VM 수량 추이');
  });

  it('조회 실패 자리는 오류 안내와 같은 조건 다시 조회 버튼을 함께 그린다(새로고침이 아니라 load 를 부른다)', () => {
    let called = 0;
    const html = renderToStaticMarkup(h(VmTrackLoadFailed, { error: 'boom-일시 오류', onRetry: () => { called += 1; } }));
    expect(html).toContain('boom-일시 오류');
    expect(html).toContain('이 조건으로 다시 조회');
    expect(html).not.toContain('undefined');
    expect(called).toBe(0);
  });

  it('data 가 빈 분기는 선택 도구(head)를 먼저 그리고 그 아래에 실패 자리·Loading 을 둔다 — ErrorBox·Loading 만 단독으로 돌려주지 않는다', () => {
    const code = stripComments(fs.readFileSync(path.join(here, 'VmTrackTool.jsx'), 'utf8'));
    expect(code).not.toMatch(/if \(error && !data\) return <ErrorBox/);
    expect(code).not.toMatch(/if \(!data\) return <Loading \/>/);
    expect(code).toMatch(/if \(!data\) \{\s*return \(\s*<div>\s*\{head\}\s*\{error \? <VmTrackLoadFailed error=\{error\} onRetry=\{retry\} busy=\{retrying\} failedRetries=\{retryFails\} \/> : <Loading \/>\}/);
    // 다시 조회는 같은 조건의 load() — 새로고침(location.reload)이 아니다. v2.744(RA-R2): 진행 중 잠금(retryGate)을 거친다.
    expect(code).toMatch(/const retry = \(\) => retryGate\.current\.start\(\(\) => load\(/);
    // vCenter 목록은 마지막 응답의 것을 따로 둔다(data 가 비어도 선택 상자가 빈 목록이 되지 않게).
    expect(code).toMatch(/setVcList\(d\.vcenterList\)/);
    expect(code).toMatch(/vcList\.map\(/);
  });
});
