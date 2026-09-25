import { describe, it, expect } from 'vitest';
import { droppedSecretKeys, droppedSecretNote, passwordDroppedLines, relaySecretsDroppedText } from './droppedSecretText.js';

describe('droppedSecretText (WEB2607-03 · LEFT2607-07)', () => {
  it('droppedSecrets 가 있으면 다시 입력하라고 말한다', () => {
    const r = { ok: true, vcenter: {}, hasPassword: false, droppedSecrets: ['password'] };
    expect(droppedSecretKeys(r)).toEqual(['password']);
    expect(droppedSecretNote(r)).toMatch(/비밀번호을\(를\) 폐기했습니다/);
    expect(droppedSecretNote(r)).toMatch(/다시 입력/);
  });
  it('장비 객체 안(r.device.droppedSecrets — 스토리지·SAN)도 본다', () => {
    expect(droppedSecretKeys({ ok: true, device: { id: 'd1', droppedSecrets: ['password'] } })).toEqual(['password']);
    expect(droppedSecretNote({ ok: true, device: { id: 'd1' } })).toBe('');
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

describe('WEB2612-05 iLO 비밀번호 라벨 · 서버 사유 우선', () => {
  it('iloPassword 원문 키가 새지 않는다', () => {
    const t = droppedSecretNote({ droppedSecrets: ['password', 'iloPassword'] });
    expect(t).toMatch(/iLO 비밀번호/);
    expect(t).not.toMatch(/iloPassword/);
  });
  it('일반 문구는 주소·포트·계정 한쪽 조건으로 단정하지 않는다', () => {
    const t = droppedSecretNote({ droppedSecrets: ['password'] });
    expect(t).not.toMatch(/접속처\(주소·포트·계정\)가/);
    expect(t).toMatch(/대역·수행 엣지/);
  });
  it('서버 skipped[].reason 이 있으면 그 사유를 쓴다(폐기한 키에 해당하는 것만)', () => {
    const t = droppedSecretNote({
      droppedSecrets: ['iloPassword'],
      skipped: [{ field: 'iloPassword', reason: '스캔 대역·수행 엣지·iLO 계정이 바뀌어 저장된 iLO 비밀번호를 폐기했습니다.' }, { field: 'other', reason: '무관' }],
    });
    expect(t).toMatch(/iLO 계정이 바뀌어/);
    expect(t).not.toMatch(/무관/);
  });
});
