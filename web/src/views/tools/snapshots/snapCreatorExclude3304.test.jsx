/**
 * v3.30.4 ‘만든 계정에서 뺄 백업 계정’ — 화면 쪽.
 *   ① settingsPatch: 가린 판본(creatorExcludeText 없음)은 이 칸을 보내지 않는다 — 빈 목록이 저장값을 지우지 않게
 *   ② creatorExcludeNote: 서버가 준 수만 쓴다 · 목록이 비면 적는 곳을 알려 준다
 */
import { describe, it, expect } from 'vitest';
import { settingsPatch } from '../../vmcfg/vmHygieneText.js';
import { creatorExcludeNote } from './SnapshotTool.jsx';

describe('만든 계정에서 뺄 백업 계정', () => {
  it('① 가린 판본은 보내지 않고, 보이는 판본은 줄마다 보낸다', () => {
    expect(settingsPatch({ snapAgeDays: '7', exceptionsText: '' })).not.toHaveProperty('creatorExclude');
    expect(settingsPatch({ creatorExcludeText: ' VSPHERE.LOCAL\\bareos \n\nrubrik ' }).creatorExclude).toEqual(['VSPHERE.LOCAL\\bareos', 'rubrik']);
    expect(settingsPatch({ creatorExcludeText: '' }).creatorExclude).toEqual([]);
  });
  it('② 안내 줄', () => {
    expect(creatorExcludeNote({ ok: true })).toMatch(/‘만든 계정에서 뺄 백업 계정’ 에 적으면/);
    expect(creatorExcludeNote({ ok: true, excludeCount: 2, listed: 1234 })).toBe('Veeam 계정과 적어 둔 백업 계정 2개를 뺐습니다(이벤트 1,234건)');
    expect(creatorExcludeNote({ ok: true, excludeCount: 1 })).toMatch(/이벤트 0건/);
  });
});
