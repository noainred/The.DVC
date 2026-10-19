// v2.744 최종 검토 리드 — VM 수량 추이 조회가 403(권한·범위)이면 권한 안내를 그리고 '이 조건으로 다시 조회' 를 두지 않는다
//   (403 은 다시 물어도 같다). 예전에는 오류를 e.message 문자열로 바꿔 넘겨 ErrorBox 가 403 을 알 수 없었다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as VmTrack from './VmTrackTool.jsx';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const forbidden = Object.assign(new Error('forbidden'), { status: 403, requiredPerm: ['tools'], serverReason: '권한이 없습니다' });

describe('VmTrackLoadFailed — 403', () => {
  it('403 이면 다시 조회 버튼이 없다', () => {
    const html = renderToStaticMarkup(h(VmTrack.VmTrackLoadFailed, { error: forbidden, onRetry: () => {} }));
    expect(html).not.toMatch(/이 조건으로 다시 조회/);
  });
  it('500·문자열 오류는 예전처럼 다시 조회 버튼이 있다', () => {
    const e500 = Object.assign(new Error('internal'), { status: 500 });
    expect(renderToStaticMarkup(h(VmTrack.VmTrackLoadFailed, { error: e500, onRetry: () => {} }))).toMatch(/이 조건으로 다시 조회/);
    expect(renderToStaticMarkup(h(VmTrack.VmTrackLoadFailed, { error: 'boom', onRetry: () => {} }))).toMatch(/이 조건으로 다시 조회/);
  });
  it('조회 실패는 오류 객체를 그대로 상태에 담고, 글자로 그리는 곳은 errorBoxInput 을 거친다', () => {
    const src = fs.readFileSync(path.join(HERE, 'VmTrackTool.jsx'), 'utf8');
    expect(src).toMatch(/\(e\) => \{ setError\(e\); done\?\.\(false\); \}/);
    expect(src).not.toMatch(/일시 조회 오류: \{error\}/);
  });
});
