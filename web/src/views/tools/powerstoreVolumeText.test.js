import { describe, it, expect } from 'vitest';
import { volumeProvisionText } from './powerstoreVolumeText.js';

const fmt = (b) => `${(b / 1e12).toFixed(2)} TB`;
describe('volumeProvisionText (v2.603 COL-2603-07)', () => {
  it('size 결측이 있으면 합계 대신 결측 개수를 말한다', () => {
    expect(volumeProvisionText({ provisionedBytes: null, sizeUnknown: 3 }, fmt)).toBe(' · 할당 합계 — (크기를 읽지 못한 볼륨 3개 — 0 으로 더하지 않았습니다)');
  });
  it('전부 읽었으면 예전처럼 합계', () => {
    expect(volumeProvisionText({ provisionedBytes: 2e12 }, fmt)).toBe(' · 할당 2.00 TB');
  });
  it('0·null·결측 표시 없음이면 빈 문자열', () => {
    expect(volumeProvisionText({ provisionedBytes: 0 }, fmt)).toBe('');
    expect(volumeProvisionText({ provisionedBytes: null }, fmt)).toBe('');
    expect(volumeProvisionText(null, fmt)).toBe('');
  });
});
