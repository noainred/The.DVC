import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpError, isPermissionError, notePermissionError, permissionInfoFor } from './api.js';

// 403 권한 정보 사이드 채널 — 공용 ErrorBox 가 `message`(문자열)만 받는 계약을 깨지 않고
// '접근 제어 안내'로 렌더할 수 있게 하는 통로다. 이게 죽으면 전 화면이 다시 "오류: forbidden"
// 으로 보여 사용자가 시스템 장애로 오해한다(이 기능의 존재 이유).

afterEach(() => { vi.useRealTimers(); });

describe('HttpError — 서버 403 메타데이터 보존', () => {
  it('세 가지 거부 형태를 각각 필드로 보존한다', () => {
    const owner = new HttpError('m', { status: 403, path: '/p', body: { requiredOwner: true, reason: 'r' } });
    expect(owner.requiredOwner).toBe(true);
    expect(owner.serverReason).toBe('r');

    const role = new HttpError('m', { status: 403, body: { requiredRole: ['admin'] } });
    expect(role.requiredRole).toEqual(['admin']);

    const perm = new HttpError('m', { status: 403, body: { requiredPerm: ['tools'] } });
    expect(perm.requiredPerm).toEqual(['tools']);
  });

  it('배열이 아닌 값은 받아들이지 않는다(렌더에서 .map 이 깨지지 않게)', () => {
    const e = new HttpError('m', { status: 403, body: { requiredRole: 'admin', requiredPerm: 7 } });
    expect(e.requiredRole).toBeNull();
    expect(e.requiredPerm).toBeNull();
  });

  it('Error 계약을 유지한다 — 기존 호출부는 전부 e.message 를 쓴다', () => {
    const e = new HttpError('사유 문장', { status: 403 });
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('사유 문장');
  });

  it('isPermissionError 는 403 만 참', () => {
    expect(isPermissionError(new HttpError('m', { status: 403 }))).toBe(true);
    expect(isPermissionError(new HttpError('m', { status: 404 }))).toBe(false);
    expect(isPermissionError(new Error('m'))).toBe(false);
    expect(isPermissionError(null)).toBe(false);
  });
});

describe('permMemo — 메시지로 권한 정보를 되찾는다', () => {
  it('등록한 메시지로 조회된다', () => {
    const info = new HttpError('설정 소유 계정만 변경할 수 있습니다.', { status: 403, body: { requiredOwner: true } });
    notePermissionError(info.message, info);
    expect(permissionInfoFor('설정 소유 계정만 변경할 수 있습니다.')).toBe(info);
  });

  it('등록하지 않은 메시지는 null — 일반 오류가 권한 안내로 오인되면 안 된다', () => {
    expect(permissionInfoFor('vCenter 연결 실패')).toBeNull();
    expect(permissionInfoFor(null)).toBeNull();
    expect(permissionInfoFor(undefined)).toBeNull();
  });

  it('TTL(5분)이 지나면 만료된다 — 오래된 항목이 무관한 오류에 붙지 않게', () => {
    vi.useFakeTimers();
    const info = new HttpError('만료 대상 사유', { status: 403, body: { requiredPerm: ['ipam'] } });
    notePermissionError(info.message, info);
    expect(permissionInfoFor('만료 대상 사유')).toBe(info);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(permissionInfoFor('만료 대상 사유')).toBeNull();
  });

  it('상한(50)을 넘으면 오래된 것부터 버려 무한 증식하지 않는다', () => {
    for (let i = 0; i < 120; i++) {
      notePermissionError(`memo-msg-${i}`, new HttpError(`memo-msg-${i}`, { status: 403, body: { requiredOwner: true } }));
    }
    // 최신 항목은 남아 있고, 아주 오래된 항목은 정리됐다.
    expect(permissionInfoFor('memo-msg-119')).not.toBeNull();
    expect(permissionInfoFor('memo-msg-0')).toBeNull();
  });

  it('빈 인자는 무시(방어)', () => {
    expect(() => notePermissionError('', null)).not.toThrow();
    expect(permissionInfoFor('')).toBeNull();
  });
});
