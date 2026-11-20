// 전체 점검 131회차 — 123회차 P1(권한 매트릭스 저장 잠금) 수정을 다시 깨뜨려 본 회귀. 순수 판정은 실제로 호출하고(node 환경 — DOM 없음), 화면 배선은 소스로 고정한다.
//  W1 손상(보존본) 상태의 ‘기본값’(초기화)은 서버가 받는 해제 길이다 — 성공하면 서버의 표지는 사라지는데 화면은 응답의 matrix 만 갈아 끼워 옛 표지(loadError)를 들고 있었다.
//     123회차가 넣은 저장 잠금(permLocked)이 그 옛 표지로 ‘다시 확인’ 을 누를 때까지 풀리지 않고 '권한 파일 못 읽음' 안내도 그대로였다(그 전에는 안내만 남고 저장은 됐다).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unreadMarkOf, unreadKind, saveLockedByUnread, shouldReseed } from './settingsUnread.js';
import { mergeReloadedPerms } from './userAdmin/permReload.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf8');

describe('W1 권한 매트릭스 — 초기화(손상 해제) 뒤 옛 표지로 저장이 잠긴 채 남지 않는다', () => {
  // 서버 GET /admin/permissions 의 표지는 { code, reason }(readError 없음 — 화면은 손상 쪽으로 읽고 잠근다 · 123회차 W4)
  const LOCKED = { catalog: [], matrix: { operator: ['dashboard'], viewer: ['dashboard'], toolsDenied: { operator: [], viewer: [] }, users: {} }, loadError: { code: 'permissions-unreadable', reason: '권한 파일이 손상돼 최소 권한으로 동작 중' } };
  const RESET = { ok: true, matrix: { operator: ['dashboard', 'tools', 'remote.access'], viewer: ['dashboard'], toolsDenied: { operator: [], viewer: [] }, users: {} } };   // POST /admin/permissions/reset 응답(표지 칸이 없다)

  it('재현(수정 전 꼴): 초기화 응답의 matrix 만 갈아 끼우면 옛 표지가 남아 저장이 잠긴 채다', () => {
    const stale = { ...LOCKED, matrix: RESET.matrix };
    expect(stale.matrix).toEqual(RESET.matrix);
    expect(saveLockedByUnread(unreadMarkOf(stale), { corruptLocks: true })).toBe(true);
  });

  it('수정: 초기화 뒤 다시 읽은 조회(표지 없음)가 화면 값이 되어 잠금이 풀린다 — 편집 표시는 내려가 있고 서버 값 그대로', () => {
    const stale = { ...LOCKED, matrix: RESET.matrix };
    const fetched = { catalog: [], matrix: RESET.matrix };   // 초기화가 서버의 표지를 지웠다(resetMatrix → persistMatrix)
    expect(shouldReseed(unreadKind(unreadMarkOf(stale)), unreadMarkOf(fetched))).toBe(true);
    const m = mergeReloadedPerms(stale, fetched, false);
    expect(m.perms).toBe(fetched);
    expect(saveLockedByUnread(unreadMarkOf(m.perms), { corruptLocks: true })).toBe(false);
  });

  it('화면 배선: resetPerms 의 성공 갈래가 편집 표시를 내린 뒤 load() 로 다시 읽는다 · 실패 갈래는 사유만', () => {
    const body = /const resetPerms = async \(\) => \{([\s\S]*?)\n {2}\};/.exec(src('UserAdmin.jsx'))?.[1] || '';
    expect(body).toMatch(/if \(r\.ok\) \{[^\n]*setPermDirty\(false\);[^\n]*await load\(\); \}\n\s*else flash\(false, r\.reason\);/);
    // ‘기본값’ 버튼은 잠그지 않는다(손상일 때 서버가 받는 해제 길 — 123회차 그대로)
    expect(src('UserAdmin.jsx')).toMatch(/<button className="logout-btn"[^>]*onClick=\{resetPerms\}>기본값<\/button>/);
  });
});
