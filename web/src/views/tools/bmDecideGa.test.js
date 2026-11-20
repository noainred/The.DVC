/**
 * 결정 반영(2026-11-19 ③ — 웹 쪽): 보존 칸 옆 표지(retentionOwnerNote)는 /auth/me settingsOwnerTier(서버 requireSettingsOwner 의 결과)만 읽는다 —
 *   줄이려 하는지 비교하지 않는다(판정은 서버 설정 PUT · settings.retentionShrink). 서버 쪽은 server/test/bmUsageDecideGa.test.js ③.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { retentionOwnerNote, RETENTION_OWNER_NOTE } from './bmWriteText.js';
import { DIST_OWNER_NOTE, distCanEdit, edgeOnView } from './bmUsageDistText.js';

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

describe('재확인 N1 — 엣지 배포 칸은 서버 표지(distribution.canEdit)로만 연다', () => {
  it('canEdit false 면 닫고 · 표지가 없는 구버전 응답은 예전처럼 연다 · 배포 현황이 없으면 닫는다', () => {
    expect(distCanEdit({ canEdit: false })).toBe(false);
    expect(distCanEdit({ canEdit: true })).toBe(true);
    expect(distCanEdit({})).toBe(true);
    expect(distCanEdit(null)).toBe(false);
    expect(DIST_OWNER_NOTE).toMatch(/\*\*설정 소유 계정만\*\*/);
    expect(DIST_OWNER_NOTE).not.toMatch(/`/);
    // 엣지 표의 중앙 켜기 · 해제 버튼(edgeOnView actions)도 같은 표지로 — 비소유자에게는 버튼이 없다
    const row = { agent: 'e1', perEdge: true, mode: 'per-edge', state: 'applied' };
    expect(edgeOnView({ snapAt: 1 }, row, { canManage: distCanEdit({ canEdit: false }) }).actions).toEqual([]);
    expect(edgeOnView({ snapAt: 1 }, row, { canManage: distCanEdit({ canEdit: true }) }).actions).toEqual(['off']);
  });
  it('화면 — 배포 켜기 · 제외 · 다시 확인 · 해제 칸이 모두 같은 표지를 읽고 비소유자에게 이유 한 줄', () => {
    const src = fs.readFileSync(path.join(HERE, 'BmUsage.jsx'), 'utf8');
    expect(src.match(/!distCanEdit\(data\.distribution\)/g)?.length).toBeGreaterThanOrEqual(5);
    expect(src).toMatch(/canManage: distCanEdit\(data\?\.distribution\)/);
    expect(src).toMatch(/<BoldText text=\{DIST_OWNER_NOTE\} \/>/);
  });
});
