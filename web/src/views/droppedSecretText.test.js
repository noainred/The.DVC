import { describe, it, expect } from 'vitest';
import { droppedSecretKeys, droppedSecretNote, passwordDroppedLines, relaySecretsDroppedText } from './droppedSecretText.js';

describe('droppedSecretText (WEB2607-03 · LEFT2607-07)', () => {
  it('droppedSecrets 가 있으면 다시 입력하라고 말한다', () => {
    const r = { ok: true, vcenter: {}, hasPassword: false, droppedSecrets: ['password'] };
    expect(droppedSecretKeys(r)).toEqual(['password']);
    expect(droppedSecretNote(r)).toMatch(/비밀번호을\(를\) 폐기했습니다/);
    expect(droppedSecretNote(r)).toMatch(/다시 입력/);
  });
  it('없거나 비어 있으면 빈 문자열', () => {
    expect(droppedSecretNote({ ok: true })).toBe('');
    expect(droppedSecretNote({ ok: true, droppedSecrets: [] })).toBe('');
    expect(droppedSecretNote(null)).toBe('');
    expect(droppedSecretNote({ droppedSecrets: [null, 3] })).toBe('');
  });
  it('CSV passwordDropped 를 줄 단위로', () => {
    const lines = passwordDroppedLines({ passwordDropped: [{ line: 3, datacenter: 'DC1', reason: '폐기함' }] });
    expect(lines).toEqual(['줄 3 · DC1 — 폐기함']);
    expect(passwordDroppedLines({})).toEqual([]);
  });
  it('중계 토폴로지 secretsDropped', () => {
    expect(relaySecretsDroppedText({ secretsDropped: ['DC1 Edge', 'DC1 IRS'] })).toMatch(/2개: DC1 Edge, DC1 IRS/);
    expect(relaySecretsDroppedText({ secretsDropped: [] })).toBe('');
  });
  it('백틱·별표 없음', () => {
    const t = droppedSecretNote({ droppedSecrets: ['password', 'privateKey'] }) + relaySecretsDroppedText({ secretsDropped: ['x'] });
    expect(/[`*]/.test(t)).toBe(false);
  });
});
