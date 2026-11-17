// 전체 점검 106회차(105회차 수정 반증) — 화면 회귀: '설정 파일을 못 읽은 동안 받은 기본값' 으로 채운 폼이 다시 읽힌 뒤의 저장으로 저장된 설정을 덮지 않게.
//   서버 409(103 F18 · 105 A5)는 읽기 오류가 이어지는 동안만 막는다 — 다시 읽힌 뒤에는 그 폼이 어디서 왔는지 서버가 모른다.
// 판정 · 문구는 화면이 export 한 순수 함수를 실제로 호출한다(node 환경 — DOM 없음). 배선은 server/test/rebut106.test.js 가 소스로 고정한다.
import { describe, it, expect } from 'vitest';
import { adoptBackupSettings, backupSettingsUnreadText } from './PortalBackup.jsx';
import { linkSettingsUnreadNote, reseedAfterUnread } from './tools/LinkCheck.jsx';

describe('포탈 백업 정책 폼 — 못 읽은 값으로 채운 폼은 다음 조회 값으로 바꾼다', () => {
  const unread = { scheduleEnabled: false, every: 1, unit: 'day', autoOnChange: true, retention: 500, loadError: { readError: true, code: 'EACCES', since: 1 } };
  const real = { scheduleEnabled: true, every: 1, unit: 'day', autoOnChange: false, retention: 40 };
  it('처음에는 받은 값을 그대로 쓴다(못 읽은 값이어도 — 안내와 함께 보인다)', () => {
    expect(adoptBackupSettings(null, unread)).toBe(unread);
    expect(adoptBackupSettings(null, real)).toBe(real);
  });
  it('못 읽은 값으로 채운 폼(그 위의 편집 포함)은 다시 읽힌 값으로 바꾼다 — 예전에는 끝까지 들고 있어 저장이 정책을 기본값으로 덮었다', () => {
    const edited = { ...unread, retention: '60' };   // 사용자가 칸을 고쳐도 loadError 는 남는다(전개 복사)
    expect(adoptBackupSettings(unread, real)).toBe(real);
    expect(adoptBackupSettings(edited, real)).toBe(real);
    expect(adoptBackupSettings(unread, unread)).toBe(unread);   // 아직 못 읽음 — 그대로(저장은 잠겨 있다)
  });
  it('읽은 값으로 채운 폼은 편집 중이니 주기 조회가 덮지 않는다(예전 동작 그대로)', () => {
    const editing = { ...real, retention: '45' };
    expect(adoptBackupSettings(editing, real)).toBe(editing);
    expect(adoptBackupSettings(editing, unread)).toBe(editing);
  });
  it('안내 문구 — 읽기 오류일 때만 · 코드가 있으면 싣고 · 값을 인용하는 백틱은 쓰지 않는다', () => {
    expect(backupSettingsUnreadText(real)).toBe('');
    expect(backupSettingsUnreadText(null)).toBe('');
    const t = backupSettingsUnreadText(unread);
    expect(t).toMatch(/읽지 못했습니다\(EACCES\)/);
    expect(t).toMatch(/임시 기본값/);
    expect(t).toMatch(/정책 저장은 잠급니다/);
    expect(t).not.toMatch(/`/);
    expect(backupSettingsUnreadText({ loadError: { readError: true } })).toMatch(/읽지 못했습니다 — /);
  });
});

describe('통신 점검 설정 폼 — 못 읽은 조회의 안내 · 다시 채우기 판정', () => {
  it('표지가 없으면 안내도 없다', () => {
    expect(linkSettingsUnreadNote(null)).toBe('');
    expect(linkSettingsUnreadNote(undefined)).toBe('');
  });
  it('읽기 오류 — 기본값임을 말하고 저장을 잠근다고 말한다(손상 문구와 다르다)', () => {
    const t = linkSettingsUnreadNote({ reason: '설정 파일을 읽지 못했습니다(EISDIR) — 원본은 그대로 두었습니다.', readError: true });
    expect(t).toMatch(/EISDIR/);
    expect(t).toMatch(/저장된 값이 아니라 기본값/);
    expect(t).toMatch(/설정 저장은 잠급니다/);
    expect(t).not.toMatch(/`/);
  });
  it('손상(보존본으로 옮김) — 저장이 해제 길이라 잠근다고 말하지 않는다', () => {
    const t = linkSettingsUnreadNote({ reason: '설정 파일을 읽지 못했습니다(형식 오류) — 손상 보존본으로 옮겼습니다', readError: false });
    expect(t).toMatch(/기본값입니다/);
    expect(t).toMatch(/저장하면 이 화면의 값이 새 설정/);
    expect(t).not.toMatch(/잠급니다/);
    expect(linkSettingsUnreadNote({ readError: false })).toMatch(/통신 점검 설정 파일을 읽지 못했습니다/);
  });
  it('못 읽은 값으로 채운 폼은 다시 읽힌 조회에서만 다시 채운다', () => {
    expect(reseedAfterUnread(true, undefined)).toBe(true);                       // 다시 읽혔다
    expect(reseedAfterUnread(true, { readError: false, reason: 'x' })).toBe(true); // 손상으로 바뀜 — 읽기 오류 때의 폼은 버린다
    expect(reseedAfterUnread(true, { readError: true })).toBe(false);            // 아직 못 읽음
    expect(reseedAfterUnread(false, undefined)).toBe(false);                     // 읽은 값 위의 편집은 건드리지 않는다
    expect(reseedAfterUnread(false, { readError: true })).toBe(false);
  });
});
