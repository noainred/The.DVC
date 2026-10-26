// v2.782(점검 K5 E-B2): 물리 GPU 서버 화면이 gpuErrors(일부 GPU 응답 없음)를 버려 '7GPU · 수집(초록)' 으로 보이던 결함 회귀.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/_stripComments.js';
import { physicalGpuErrView, physicalGpuErrServers, PGPU_GPU_ERR_TITLE } from './physicalGpuText.js';
import { gpuErrText } from '../tools/gpuUsageText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const code = (rel) => stripComments(fs.readFileSync(path.join(HERE, rel), 'utf8'));

describe('physicalGpuErrView — 일부 GPU 응답 없음 판정', () => {
  it('응답 없는 GPU 가 있으면 GPU 사용 화면과 같은 문구 + amber', () => {
    expect(physicalGpuErrView({ count: 7, gpuErrors: 1 })).toEqual({ text: gpuErrText(1), tone: 'amber' });
    expect(physicalGpuErrView({ count: 7, gpuErrors: 1 }).text).toBe('GPU 1장 응답 없음');
    expect(physicalGpuErrView({ count: 6, gpuErrors: 2 }).text).toBe('GPU 2장 응답 없음');
  });
  it('0 은 정상(green), null·undefined·빈 값·이상값(모름)은 표지를 지어내지 않는다', () => {
    for (const v of [0, null, undefined, '', 'x', -1]) expect(physicalGpuErrView({ count: 8, gpuErrors: v })).toEqual({ text: '', tone: 'green' });
    expect(physicalGpuErrView({ count: 8 })).toEqual({ text: '', tone: 'green' });
    expect(physicalGpuErrView(null)).toEqual({ text: '', tone: 'green' });
  });
  it('요약 줄 — 수집 성공 행 중 응답 없는 GPU 가 있는 서버만 센다(오류 행·미수집·모름 제외)', () => {
    const rows = [
      { count: 7, gpuErrors: 1 }, { count: 8, gpuErrors: 0 }, { count: 8 }, { count: 4, gpuErrors: null },
      { error: 'x', gpuErrors: 2 }, { count: null, gpuErrors: 1 }, null,
    ];
    expect(physicalGpuErrServers(rows)).toBe(1);
    expect(physicalGpuErrServers(null)).toBe(0);
  });
  it('툴팁 문구에 백틱이 없다', () => { expect(PGPU_GPU_ERR_TITLE).not.toContain('`'); });
});

describe('PhysicalGpuManager 가 판정 헬퍼를 쓴다(소스)', () => {
  const s = code('PhysicalGpuManager.jsx');
  it('physicalGpuText.js 를 import 하고 행·상태 배지에 쓴다', () => {
    expect(s).toMatch(/from '\.\/physicalGpuText\.js'/);
    expect(s).toMatch(/physicalGpuErrView\(r\)/);
    expect(s).toMatch(/physicalGpuErrServers\(/);
  });
  it('상태 배지를 green 으로 고정하지 않는다(gpuErrors 가 있으면 amber)', () => {
    expect(s).not.toMatch(/<span className="badge green">수집<\/span>/);
  });
  it('gpuErrors 판정을 인라인으로 복제하지 않는다(헬퍼 하나)', () => {
    expect(s).not.toMatch(/gpuErrors\s*>/);
  });
});
