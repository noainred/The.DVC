import { describe, it, expect } from 'vitest';
import { serviceDownKind, diagnosticLines, diagnosticText, SERVICE_DOWN_TEXT } from './serviceDownText.js';

/**
 * v2.459 회귀 고정.
 * 이 판정이 **과하게 잡으면 진짜 오류가 '5분 후 재시도' 안내 뒤로 숨는다** — 오탐 방지가 핵심이라
 * '잡아야 하는 것' 보다 '잡으면 안 되는 것' 을 더 촘촘히 고정한다.
 */

describe('serviceDownKind — 일시적 미가용으로 판정해야 하는 것', () => {
  it('브라우저 네트워크 실패(Failed to fetch)', () => {
    expect(serviceDownKind('Failed to fetch')).toBe('network');
  });
  it('Safari/Firefox 표현도 같이 잡는다', () => {
    expect(serviceDownKind('TypeError: Load failed')).toBe('network');
    expect(serviceDownKind('NetworkError when attempting to fetch resource.')).toBe('network');
  });
  it('게이트웨이 오류는 상태코드로', () => {
    expect(serviceDownKind('아무 문구', { status: 502 })).toBe('gateway');
    expect(serviceDownKind('아무 문구', { status: 503 })).toBe('gateway');
    expect(serviceDownKind('아무 문구', { status: 504 })).toBe('gateway');
  });
  it('서버 내부 오류(500)는 internal', () => {
    expect(serviceDownKind('아무 문구', { status: 500 })).toBe('internal');
  });
  it('★ 서버가 사유를 준 500 — 메시지에 -> 500 이 없어도 상태코드로 잡는다', () => {
    // httpFail 이 `data.reason` 을 메시지로 쓰므로 문자열만으로는 영영 판정할 수 없는 경우.
    expect(serviceDownKind('메일 발송 설정을 읽지 못했습니다', { status: 500 })).toBe('internal');
  });
  it('사이드 채널이 만료된 뒤에도 메시지 원문으로 잡는다', () => {
    expect(serviceDownKind('/api/admin/mail -> 500')).toBe('internal');
    expect(serviceDownKind('/api/admin/mail -> 503')).toBe('gateway');
  });
  it('타임아웃', () => {
    expect(serviceDownKind('AbortError: signal is aborted')).toBe('timeout');
    expect(serviceDownKind('TimeoutError')).toBe('timeout');
  });
});

describe('serviceDownKind — 절대 잡으면 안 되는 것', () => {
  it('403(권한 거부)은 AccessDenied 가 처리해야 하므로 null', () => {
    expect(serviceDownKind('forbidden', { status: 403 })).toBeNull();
  });
  it('4xx 는 재시도해도 결과가 같다 — 전부 null', () => {
    for (const status of [400, 401, 404, 409, 422, 429]) {
      expect(serviceDownKind('무언가 실패', { status })).toBeNull();
    }
  });
  it('상태코드 없는 일반 실패 문구는 그대로 오류로 남긴다', () => {
    expect(serviceDownKind('저장에 실패했습니다')).toBeNull();
    expect(serviceDownKind('vCenter 설정을 찾을 수 없습니다')).toBeNull();
    expect(serviceDownKind('VM 을 찾을 수 없습니다')).toBeNull();
  });
  it('본문에 500 이 값으로 들어간 정상 오류를 오인하지 않는다', () => {
    // '-> 500' 형태만 상태코드로 본다. 숫자 500 이 들어간 문구는 오류 그대로.
    expect(serviceDownKind('디스크 500 GB 를 확보하지 못했습니다')).toBeNull();
    expect(serviceDownKind('타임아웃 500ms 초과')).toBeNull();
  });
  it('빈 값·비문자열은 안전하게 null', () => {
    expect(serviceDownKind('')).toBeNull();
    expect(serviceDownKind(null)).toBeNull();
    expect(serviceDownKind(undefined)).toBeNull();
  });
  it('4xx 상태코드가 있으면 메시지에 network 문구가 있어도 null(상태코드 우선)', () => {
    expect(serviceDownKind('Failed to fetch', { status: 404 })).toBeNull();
  });
});

describe('문구·진단 항목', () => {
  it('사용자 문구는 원인과 무관하게 하나 — 행동 지시를 담는다', () => {
    expect(SERVICE_DOWN_TEXT.act).toContain('5분 후');
    expect(SERVICE_DOWN_TEXT.esc).toContain('관리자');
    expect(SERVICE_DOWN_TEXT.sub).toContain('업그레이드');
  });
  it('상세 항목에 구분·상태·경로·시각·원문이 담긴다', () => {
    const at = new Date(2026, 8, 10, 15, 57, 34);
    const lines = diagnosticLines('internal', 'Failed to fetch', { status: 500, path: '/api/admin/mail' }, at);
    const keys = lines.map(([k]) => k);
    expect(keys).toEqual(['구분', 'HTTP 상태', '요청 경로', '발생 시각', '원문 메시지']);
    expect(diagnosticText(lines)).toContain('HTTP 상태: 500');
    expect(diagnosticText(lines)).toContain('요청 경로: /api/admin/mail');
  });
  it('HTTP 정보가 없으면 그 줄은 생략한다(빈 값을 보여주지 않는다)', () => {
    const keys = diagnosticLines('network', 'Failed to fetch', null).map(([k]) => k);
    expect(keys).toEqual(['구분', '발생 시각', '원문 메시지']);
  });
});
