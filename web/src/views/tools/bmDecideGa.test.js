/**
 * 결정 반영(2026-11-19 ③ — 웹 쪽): 보존 칸 옆 표지(retentionOwnerNote)는 /auth/me settingsOwnerTier(서버 requireSettingsOwner 의 결과)만 읽는다 —
 *   줄이려 하는지 비교하지 않는다(판정은 서버 설정 PUT · settings.retentionShrink). 서버 쪽은 server/test/bmUsageDecideGa.test.js ③.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { retentionOwnerNote, RETENTION_OWNER_NOTE } from './bmWriteText.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);

describe('③ 보존 줄이기 표지', () => {
  it('소유자 등급이 아니고 전역 값을 저장할 수 있으면 말한다 · 소유자 · 인증 꺼짐 · 읽기 전용 카드는 빈 문자열', () => {
    expect(retentionOwnerNote({ settingsOwnerTier: false, isSettingsOwner: true }, true)).toBe(RETENTION_OWNER_NOTE);
    expect(retentionOwnerNote({}, true)).toBe(RETENTION_OWNER_NOTE);
    expect(retentionOwnerNote(null, true)).toBe(RETENTION_OWNER_NOTE);
    expect(retentionOwnerNote({ settingsOwnerTier: true }, true)).toBe('');
    expect(retentionOwnerNote({ name: 'Anonymous' }, true)).toBe('');
    expect(retentionOwnerNote({ settingsOwnerTier: false }, false)).toBe('');
    expect(RETENTION_OWNER_NOTE).not.toMatch(/`/);
  });
  it('화면은 표지를 보존 칸 카드에 그리고, 저장하지 못하면 칸을 저장된 값으로 되돌린다(입력값이 남아 저장된 것처럼 보이지 않게)', () => {
    const jsx = fs.readFileSync(path.join(HERE, 'BmUsage.jsx'), 'utf8');
    expect(jsx).toMatch(/retentionOwnerNote\(getCurrentUser\(\), canGlobal && !data\?\.central\?\.managed\)/);
    expect(jsx).toMatch(/else if \(!saved && input && input\.isConnected\) input\.value = String\(Math\.round\(\(Number\(form\?\.\[field\]\) \|\| 0\) \/ scale\)\);/);
  });
});
