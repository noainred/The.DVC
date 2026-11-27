// 전체 점검 123회차 — 112회차(설정 화면 스윕) 수정에 대한 적대적 재검토(반증). 순수 판정은 실제로 호출하고(node 환경 — DOM 없음), 화면 배선은 소스로 고정한다.
//  W1 안내 문구의 조사: 버튼 이름이 받침 없이 끝나면 ‘를’ — ‘저장 · 지금 정리’ 을(SAN 포트 사용량)
//  W2 사용량 메일: ‘지금 한 번 보내기’ 응답이 status 만 갈아 끼워 표지가 사라지고(잠금 해제) 폼은 못 읽은 기본값 그대로였다 — 그 저장이 받는 사람 · 요일을 덮는다
//  W3 디스크 점검: 주기 조회가 없는 화면인데 배너에 ‘다시 확인’ 이 없어 다시 읽힌 뒤에도 잠긴 채였다
//  W4 권한 매트릭스(분류표 'out' 대조): 못 읽은 동안의 최소 권한 행 위의 편집이, 다시 읽힌 뒤(재시작) ‘저장’ 으로 역할 행 · 도구 거부 목록을 덮었다 — 다시 읽기가 편집 칸을 지켰다(v2.743)
//  W5 업그레이드 설정(분류표 'out' 대조): 처음 받은 값(env 기본값)을 끝까지 폼에 들었다
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { unreadMarkOf, unreadKind, saveLockedByUnread, shouldReseed, settingsUnreadNote, objectParticle } from './settingsUnread.js';
import { SettingsUnreadBanner } from './SettingsUnreadBanner.jsx';
import { mergeReloadedPerms } from './userAdmin/permReload.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf8');
const READ = { readError: true, code: 'EISDIR', reason: '설정 파일을 읽지 못했습니다(EISDIR) — 읽기 오류이고 원본은 그대로 있습니다' };
const CORRUPT = { reason: '손상 보존본으로 옮겼습니다' };

describe('W1 안내 문구의 조사 — 버튼 이름의 마지막 글자 받침으로 고른다', () => {
  it('받침 있음 = 을 · 없음 = 를 · 한글이 아니면 을', () => {
    expect(objectParticle('저장')).toBe('을');
    expect(objectParticle('초안 저장 · 적용')).toBe('을');
    expect(objectParticle('정책 추가 · 변경')).toBe('을');
    expect(objectParticle('저장 · 지금 정리')).toBe('를');
    expect(objectParticle('다시 보내기')).toBe('를');
    expect(objectParticle('Save')).toBe('을');
    expect(objectParticle('')).toBe('을');
    expect(objectParticle(null)).toBe('을');
  });
  it('SAN 포트 사용량 배너(읽기 오류 · 손상 잠금)는 ‘… 지금 정리’ 를 이라고 쓴다 — 다른 화면의 ‘저장’ 을 은 그대로', () => {
    const san = { what: 'SAN 포트 사용량 수집 설정', save: '저장 · 지금 정리', corruptLocks: true };
    expect(settingsUnreadNote(READ, san)).toContain('‘저장 · 지금 정리’ 를 잠급니다');
    expect(settingsUnreadNote(CORRUPT, san)).toContain('‘저장 · 지금 정리’ 를 잠급니다');
    expect(settingsUnreadNote(READ, san)).not.toContain('’ 을 ');
    expect(settingsUnreadNote(READ, { what: 'x', save: '저장' })).toContain('‘저장’ 을 잠급니다');
    expect(settingsUnreadNote(CORRUPT, { what: 'x', save: '저장' })).toContain('‘저장’ 을 누르면');
    expect(settingsUnreadNote(READ, { what: 'x', save: '설정 저장', lastGood: true })).toContain('‘설정 저장’ 을 잠급니다');
    for (const le of [READ, CORRUPT]) expect(settingsUnreadNote(le, san)).not.toMatch(/`/);
  });
  it('화면에 넘기는 버튼 이름 전수 — 조사가 맞는다(받침 없는 이름: SAN ‘… 지금 정리’ · vCenter 등록 ‘… 삭제’)', () => {
    const names = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsx')) for (const m of fs.readFileSync(p, 'utf8').matchAll(/<SettingsUnreadBanner[^>]*\bsave="([^"]+)"/g)) names.push(m[1]); } };
    walk(HERE);
    expect(names.length).toBeGreaterThanOrEqual(15);
    const vowelEnd = [...new Set(names.filter((n) => objectParticle(n) === '를'))].sort();
    expect(vowelEnd).toContain('저장 · 지금 정리');
    for (const n of vowelEnd) expect(/[리제기]$/.test(n), n).toBe(true);   // 정리 · 삭제 · 보내기 — 새 이름이 걸리면 조사를 눈으로 확인하고 더한다
    for (const n of new Set(names)) {
      const t = settingsUnreadNote(READ, { what: 'x', save: n });
      expect(t).toContain(`‘${n}’ ${objectParticle(n)} 잠급니다`);
    }
  });
});

describe('W2 사용량 메일 — 지금 보내기 응답이 표지만 지우지 않는다', () => {
  it('설정 파일 상태가 바뀐 응답이면 설정을 통째로 다시 받는다(폼 다시 채움) · 같으면 status 만', () => {
    const s = src('tools/StorageUsageTool.jsx');
    expect(s).toMatch(/if \(r\?\.status\) \{ if \(unreadKind\(unreadMarkOf\(r\.status\)\) !== unreadKind\(unreadMarkOf\(data\.status\)\)\) await load\(\); else setData\(\(x\) => \(\{ \.\.\.x, status: r\.status \}\)\); \}/);
    expect(s).not.toMatch(/if \(r\?\.status\) setData\(\(x\) => \(\{ \.\.\.x, status: r\.status \}\)\);/);
    // load 는 폼을 늘 다시 채운다(이 판정이 기대는 전제)
    expect(s).toMatch(/setData\(r\); setForm\(\{ \.\.\.r\.mail \}\); setToText\(/);
  });
  it('판정: 읽기 오류 → 읽힘 은 상태가 바뀐 것 · 읽힘 → 읽힘 은 그대로(편집 중인 폼을 지우지 않는다)', () => {
    const kind = (st) => unreadKind(unreadMarkOf(st));
    expect(kind({ loadError: { at: 1, readError: true } })).toBe('read');
    expect(kind({ loadError: { at: 1, readError: false } })).toBe('corrupt');
    expect(kind({ loadError: null })).toBe('');
    expect(kind({ loadError: { at: 1, readError: true } }) !== kind({ loadError: null })).toBe(true);
    expect(kind({ loadError: null }) !== kind({ loadError: null })).toBe(false);
  });
});

describe('W3 디스크 점검 — 주기 조회가 없는 화면의 배너에는 다시 확인', () => {
  it('배너가 reload 를 받는다 · 다시 읽으면 key 가 바뀌어 설정 칸을 다시 만든다', () => {
    const s = src('tools/DiskBadTool.jsx');
    expect(s).toMatch(/<SettingsUnreadBanner le=\{unread\} what="디스크 배드 섹터 점검 설정" save="자동 점검 · 메일 · 담당자 저장" onRecheck=\{reload\}/);
    expect(s).toMatch(/<ScanPanel key=\{unreadKind\(unreadMarkOf\(data\)\) \|\| 'ok'\}/);
    const html = renderToString(createElement(SettingsUnreadBanner, { le: READ, what: '디스크 배드 섹터 점검 설정', save: '자동 점검 · 메일 · 담당자 저장', onRecheck: () => {} }));
    expect(html).toContain('다시 확인');
  });
});

describe('W4 권한 매트릭스 — 못 읽은 동안의 최소 권한 행으로 저장하지 않는다', () => {
  const LOCKED = { catalog: [], matrix: { operator: ['dashboard'], viewer: ['dashboard'], toolsDenied: { operator: [], viewer: [] }, users: {} }, loadError: { code: 'permissions-unreadable', reason: '권한 파일을 읽지 못하는 상태' } };
  const SAVED = { catalog: [], matrix: { operator: ['dashboard', 'tools', 'remote.access'], viewer: ['dashboard'], toolsDenied: { operator: ['rma', 'disk-bad'], viewer: [] }, users: {} } };
  it('서버 표지({ code, reason } — readError 없음)는 손상 쪽으로 읽히고 이 화면은 그것도 잠근다', () => {
    const le = unreadMarkOf(LOCKED);
    expect(unreadKind(le)).toBe('corrupt');
    expect(saveLockedByUnread(le, { corruptLocks: true })).toBe(true);
    expect(saveLockedByUnread(unreadMarkOf(SAVED), { corruptLocks: true })).toBe(false);
  });
  it('재현(수정 전 꼴): 편집 중이면 다시 읽기가 최소 권한 행을 지킨다 → 그 행의 저장이 저장된 권한을 덮는다', () => {
    const edited = { ...LOCKED, matrix: { ...LOCKED.matrix, operator: ['dashboard', 'vm.console'] } };
    const m = mergeReloadedPerms(edited, SAVED, true);   // 다시 읽힌 뒤의 조회 + 편집 중
    expect(m.perms.matrix.operator).toEqual(['dashboard', 'vm.console']);
    expect(m.perms.matrix.toolsDenied.operator).toEqual([]);   // 저장된 거부 목록(rma · disk-bad)이 빠진 채 저장 본문이 된다
    expect(m.perms.loadError).toBeUndefined();                  // 표지는 사라진다 — 잠금이 풀린다
  });
  it('수정: 못 읽은 값 위의 편집은 상태가 바뀐 조회에서 버린다(dirty 를 내리고 서버 값을 그대로)', () => {
    const edited = { ...LOCKED, matrix: { ...LOCKED.matrix, operator: ['dashboard', 'vm.console'] } };
    const reseed = shouldReseed(unreadKind(unreadMarkOf(edited)), unreadMarkOf(SAVED));
    expect(reseed).toBe(true);
    const m = mergeReloadedPerms(edited, SAVED, reseed ? false : true);
    expect(m.perms).toBe(SAVED);
    expect(m.dirty).toBe(false);
    // 읽은 값 위의 편집은 지킨다(v2.743 그대로) · 못 읽은 상태가 이어지면 편집을 지키되 잠금은 그대로
    expect(shouldReseed(unreadKind(unreadMarkOf(SAVED)), unreadMarkOf(SAVED))).toBe(false);
    expect(shouldReseed(unreadKind(unreadMarkOf(edited)), unreadMarkOf(LOCKED))).toBe(false);
    expect(shouldReseed(unreadKind(unreadMarkOf(SAVED)), unreadMarkOf(LOCKED))).toBe(false);
  });
  it('화면 배선: 저장 잠금 · 다시 읽기 전에 편집 버림 · 다시 확인 버튼 · 훅은 조기 return 위', () => {
    const s = src('UserAdmin.jsx');
    expect(s).toMatch(/const permLocked = saveLockedByUnread\(unreadMarkOf\(perms\), \{ corruptLocks: true \}\);/);
    expect(s).toMatch(/const savePerms = async \(\) => \{\s*if \(permLocked\) return;/);
    expect(s).toMatch(/disabled=\{!permDirty \|\| permLocked\} onClick=\{savePerms\}/);
    expect(s).toMatch(/if \(shouldReseed\(unreadKind\(unreadMarkOf\(permsRef\.current\)\), unreadMarkOf\(p\)\)\) setPermDirty\(false\);[^\n]*\n\s*setPerms\(\(cur\) => mergeReloadedPerms\(cur, p, permDirtyRef\.current\)\.perms\);/);
    expect(s).toMatch(/data-perm-unread=""[\s\S]{0,700}onClick=\{load\}>다시 확인<\/button>/);
    expect(s.indexOf('const permsRef = useRef(null);')).toBeGreaterThan(0);
    expect(s.indexOf('const permsRef = useRef(null);')).toBeLessThan(s.indexOf('if (!data) return <Loading />;'));
    const line = s.split('\n').find((l) => l.includes('data-perm-unread'));
    expect(line).not.toMatch(/`/);   // 화면 문구에 백틱 없음
  });
});

describe('W5 업그레이드 설정 — 못 읽은 값으로 채운 폼은 다시 채우고 그동안 저장을 잠근다', () => {
  it('화면 배선', () => {
    const s = src('Upgrade.jsx');
    expect(s).toMatch(/const seedKind = useRef\(null\);/);
    expect(s).toMatch(/if \(seedKind\.current === null \|\| shouldReseed\(seedKind\.current, le\)\) \{ seedKind\.current = unreadKind\(le\); setForm\(blankForm\(s\)\); setPollInit\(pollMinutesOf\(s\.pollIntervalMs\)\); \}/);
    expect(s).not.toMatch(/setForm\(\(f\) => f \|\| blankForm\(s\)\)/);
    expect(s).toMatch(/<SettingsUnreadBanner le=\{unread\} what="업그레이드 설정" save="설정 저장" lastGood onRecheck=\{load\}/);
    expect(s).toMatch(/disabled=\{busy \|\| saveLocked\} onClick=\{saveSettings\}/);
    expect(s.indexOf('const seedKind = useRef(null);')).toBeLessThan(s.indexOf('if (reload.full) return <ErrorBox'));   // 훅은 조기 return 위
  });
  it('판정: 읽은 값으로 채운 폼(seedKind 빈 글자)은 표지가 서도 다시 채우지 않는다 — 편집 중인 값을 지우지 않는다', () => {
    expect(shouldReseed('', READ)).toBe(false);
    expect(shouldReseed('', null)).toBe(false);
    expect(shouldReseed('read', READ)).toBe(false);
    expect(shouldReseed('read', null)).toBe(true);
    expect(settingsUnreadNote(READ, { what: '업그레이드 설정', save: '설정 저장', lastGood: true })).toContain('마지막으로 읽은 값');
  });
});
