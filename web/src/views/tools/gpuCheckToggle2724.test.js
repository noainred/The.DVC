// v2.724 — GPU 인벤토리의 '게스트 GPU 값을 읽지 못한 호스트' 박스는 평소 숨기고 '수집 점검' 버튼으로 펼친다(사용자 요청).
// 소스 검사인 이유: 이 화면은 API·폴링·모달이 얽힌 큰 컴포넌트라 node 환경 렌더 대신 계약(기본값·게이트·버튼 동작)을 고정한다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/_stripComments.js';

const src = stripComments(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'GpuTool.jsx'), 'utf8'));

describe('수집 점검 접기/펼치기(v2.724)', () => {
  it('박스는 기본 숨김이고 whyShown 일 때만 그린다', () => {
    expect(src).toMatch(/const \[whyShown, setWhyShown\] = useState\(false\)/);
    const at = src.indexOf('게스트 GPU 값을 읽지 못한 호스트가 있습니다');
    expect(at).toBeGreaterThan(0);
    const before = src.slice(Math.max(0, at - 600), at);
    expect(before).toMatch(/\{whyShown && \(/);
    // 예전처럼 view === 'host' 조건만으로 자동으로 뜨지 않는다.
    expect(src).not.toMatch(/\{view === 'host' && whyBannerItems\(data\.guestWhy\)\.length > 0 && \(/);
  });
  it('수집 점검 버튼은 펼치기 토글이고, 법인별 창은 박스 안 버튼이 연다', () => {
    const btn = src.slice(src.indexOf('🩺 수집 점검') - 500, src.indexOf('🩺 수집 점검'));
    expect(btn).toMatch(/onClick=\{\(\) => setWhyShown\(\(v\) => !v\)\}/);
    expect(btn).toMatch(/aria-expanded=\{whyShown\}/);
    expect(src).toMatch(/onClick=\{\(\) => setCheckOpen\(true\)\}[^>]*>\{whyBannerItems\(data\.guestWhy\)\.length > 6/);
    expect(src).toMatch(/법인별 상태 보기/);
  });
});
