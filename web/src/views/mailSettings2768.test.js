/**
 * v2.768 점검 3회차 G2 — C2-1(웹 부분): 범위(vCenter 제한) 계정에는 서버가 메일 발송 이력·최근 오류를 싣지 않는다
 * (routes/admin/mail.js scopeMailStatus — omittedOutOfScope). 화면이 그 빈 목록을 '아직 발송 기록이 없습니다' 로 말하면 거짓이다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../test/_stripComments.js';
import { mailHistoryEmptyText } from './MailSettings.jsx';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('C2-1 메일 발송 이력 — 범위 계정의 빈 이력은 기록 없음이 아니다', () => {
  it('서버가 범위 계정이라 뺐으면 그 사실을, 아니면 기록 없음을 말한다', () => {
    expect(mailHistoryEmptyText({ history: [], scoped: true, omittedOutOfScope: { history: 3, lastError: true } })).toMatch(/범위\(vCenter 제한\) 계정에는 표시하지 않습니다/);
    expect(mailHistoryEmptyText({ history: [], scoped: true, omittedOutOfScope: { history: 0, lastError: false } })).toMatch(/표시하지 않습니다/);
    expect(mailHistoryEmptyText({ history: [] })).toBe('아직 발송 기록이 없습니다.');
    expect(mailHistoryEmptyText(null)).toBe('아직 발송 기록이 없습니다.');
  });
  it('빈 이력 문구는 이 판정을 거친다(고정 문구로 되돌리지 말 것)', () => {
    const src = stripComments(fs.readFileSync(path.join(HERE, 'MailSettings.jsx'), 'utf8'));
    expect(src).toContain('{mailHistoryEmptyText(st)}');
    expect(src.match(/아직 발송 기록이 없습니다/g) || []).toHaveLength(1);
  });
});
