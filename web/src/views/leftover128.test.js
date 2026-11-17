/**
 * 전체 점검 128회차 — 앞 회차들이 남긴 같은 꼴의 잔여(화면 쪽 순수 판정).
 *  B 등록부를 못 읽은 동안의 빈 목록을 ‘등록 없음 · 추가하세요’ 로 말하지 않는다(118회차 vCenter 관리 화면의 꼴 — SAN 스위치 · CVP · 베어메탈 스토리지 · NSX).
 *  B ‘손상본 보존’ 문구: 읽기 오류면 보존본이 없다 — 서버가 표지에 readError 를 싣는 화면은 조치를 가른다.
 *  C postJson 은 409 본문을 던지지 않고 돌려준다 — 그 본문을 성공으로 읽지 않는 판정(requireChanged)이 실제 서버 본문 모양에서 맞게 도는지.
 */
import { describe, it, expect } from 'vitest';
import { registryUnreadNote, registryEmptyText, unreadMarkOf, settingsUnreadNote } from './settingsUnread.js';
import { unreadFixText } from './loadErrorText.js';
import { requireChanged, changeFailText } from './changeResult.js';

const READ = { readError: true, code: 'EACCES', reason: '설정 파일을 읽지 못했습니다(EACCES) — 읽기 오류이고 원본은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(30초마다 다시 읽습니다)' };
const CORRUPT = { reason: '등록부 파일을 읽지 못했습니다(JSON 형식 오류(1행 3열)) — 손상본은 설정 폴더에 보존돼 있습니다' };

describe('128회차 B — 등록부를 못 읽은 동안의 목록 안내', () => {
  it('표지가 없으면 아무 문구도 없다(평소 문구를 쓴다)', () => {
    expect(registryUnreadNote(null, { what: 'SAN 스위치 등록부' })).toBe('');
    expect(registryUnreadNote(undefined)).toBe('');
    expect(registryEmptyText(null, 'SAN 스위치 등록부')).toBe('');
    expect(registryEmptyText(unreadMarkOf({ devices: [] }), 'SAN 스위치 등록부')).toBe('');
  });

  it('읽기 오류: 목록이 비어 보여도 등록이 없는 것이 아니다 · 새로 등록하지 말 것 · 잠근다고 말하지 않는다(버튼을 잠그지 않는 화면도 쓴다)', () => {
    const t = registryUnreadNote(READ, { what: 'SAN 스위치 등록부' });
    expect(t).toContain('SAN 스위치 등록부');
    expect(t).toContain('(EACCES)');
    expect(t).toContain('목록이 비어 보여도 등록이 없는 것이 아닙니다');
    expect(t).toContain('새로 등록하지 마세요');
    expect(t).toContain('저장되지 않습니다');
    expect(t).not.toContain('잠급니다');
    expect(t).not.toContain('보존본');   // 읽기 오류에는 보존본이 없다
    expect(t).not.toContain('`');
  });

  it('읽기 오류 + 마지막 값을 주는 등록부(NSX): 지금 목록이 마지막으로 읽은 목록임을 말한다', () => {
    const t = registryUnreadNote(READ, { what: 'NSX Manager 등록부', lastGood: true });
    expect(t).toContain('마지막으로 읽은 목록');
    expect(t).toContain('한 번도 읽지 못했으면 빈 목록');
    expect(t).not.toContain('새로 등록하지 마세요');
  });

  it('손상(보존본으로 옮김): 등록이 없었던 것이 아니다 · 보존본을 되돌리거나 새로 등록(새 등록부가 된다)', () => {
    const t = registryUnreadNote(CORRUPT, { what: 'CVP 서버 등록부' });
    expect(t).toContain('목록이 비어 보여도 등록이 없었던 것이 아닙니다');
    expect(t).toContain('보존본을 되돌리면');
    expect(t).toContain('새 등록부가 됩니다');
    expect(t).not.toContain('저장되지 않습니다');
  });

  it('빈 목록 자리의 한 줄: 조사(을 · 를)를 맞춘다', () => {
    expect(registryEmptyText(READ, 'SAN 스위치 등록부')).toBe('SAN 스위치 등록부를 읽지 못했습니다 — 목록이 비어 보여도 등록이 없는 것이 아닙니다.');
    expect(registryEmptyText(CORRUPT, '서버 목록')).toBe('서버 목록을 읽지 못했습니다 — 목록이 비어 보여도 등록이 없는 것이 아닙니다.');
  });

  it('설정 폼 문구(112회차)는 그대로다 — 등록부 문구와 섞이지 않는다', () => {
    expect(settingsUnreadNote(READ, { what: '서버 성능 측정 설정', save: '저장' })).toContain('‘저장’ 을 잠급니다');
  });
});

describe('128회차 B — ‘손상본 보존’ 문구는 사유별로', () => {
  it('읽기 오류면 보존본이 없다고 말하고, 손상이면 화면이 넘긴 조치를 그대로 쓴다', () => {
    expect(unreadFixText(null)).toBe('');
    const read = unreadFixText({ reason: 'x', readError: true }, { corrupt: '손상본은 .corrupt.<시각> 으로 보존했습니다. 저장하면 이 값으로 다시 시작합니다.' });
    expect(read).toContain('손상 보존본은 없습니다');
    expect(read).toContain('원본은 그대로');
    expect(read).not.toContain('저장하면 이 값으로');
    expect(unreadFixText({ reason: 'x' }, { corrupt: '손상 보존본을 되돌리세요.' })).toBe('손상 보존본을 되돌리세요.');
    expect(unreadFixText({ reason: 'x', readError: false })).toContain('서비스 점검에서 기본값으로 확정');
  });
});

describe('128회차 C — postJson 이 돌려준 409 본문을 성공으로 읽지 않는다', () => {
  it('등록부 읽기 오류 거절(SAN 스위치 · CVP 서버 등록 409) — 사유를 던진다', () => {
    const body = { ok: false, reason: 'SAN 스위치 등록부(sanswitch-devices.json)를 읽지 못한 상태라 저장하지 않았습니다 — 읽기 오류(EACCES)이고 원본은 그대로 있습니다.', code: 'registry-unreadable', readError: true };
    expect(() => requireChanged(body)).toThrow(/읽지 못한 상태라 저장하지 않았습니다/);
    try { requireChanged(body); } catch (e) { expect(e.body).toBe(body); expect(e.changeRejected).toBe(true); }
  });

  it('svcmon 의 409 본문은 { error } 모양이다 — 폴더 만들기 · 옮기기 · 점검 추가', () => {
    expect(() => requireChanged({ error: '서비스 모니터 저장소를 읽지 못한 상태라 저장하지 않았습니다' })).toThrow(/저장하지 않았습니다/);
    expect(requireChanged({ folder: { path: 'a' }, folders: [] })).toEqual({ folder: { path: 'a' }, folders: [] });
  });

  it('Bareos 취소 409(취소할 실행 없음 · 이미 보냄 · 돌고 있지 않음)는 ‘보냈습니다’ 가 아니다', () => {
    expect(() => requireChanged({ ok: false, reason: '취소할 실행이 없습니다.' })).toThrow('취소할 실행이 없습니다.');
    expect(() => requireChanged({ ok: false, code: 'sent', reason: '취소를 이미 보냈습니다.' })).toThrow('취소를 이미 보냈습니다.');
    expect(() => requireChanged({ ok: false, reason: '돌고 있는 회차가 없습니다', idle: true })).toThrow('돌고 있는 회차가 없습니다');
    expect(requireChanged({ ok: true, phase: 'cancelling', fire: 2 }).fire).toBe(2);
  });

  it('게스트 계정 추가: 성공 본문의 ok 는 **성공 대수(수)** 다 — 0 대여도 거절로 읽지 않고, 409 본문(ok:false)만 던진다', () => {
    expect(changeFailText({ ok: 3, fail: 0, results: [] })).toBeNull();
    expect(changeFailText({ ok: 0, fail: 2, results: [] })).toBeNull();
    expect(() => requireChanged({ ok: false, reason: '이 vCenter 는 인증 실패로 멈춰 있습니다', authStopped: true })).toThrow(/인증 실패로 멈춰/);
  });

  it('디스크 점검 작업 다시 보내기 409 본문에는 job 이 없다 — 던져서 목록을 건드리지 않게', () => {
    expect(() => requireChanged({ ok: false, reason: '이 법인에 진행 중인 다른 점검이 있습니다.' })).toThrow(/진행 중인 다른 점검/);
  });
});
