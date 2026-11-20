/**
 * 전체 점검 132회차(129회차 추정 E4) — 403 화면을 5분 넘게 열어 두면 ‘접근 제어 안내’ 가 빨간 ‘오류: …’ 로 바뀌었다.
 *
 * 원인: ErrorBox 는 렌더마다 api.js 의 사이드 채널 메모(문구 → HTTP 정보)를 다시 읽는데 메모는 5분 뒤(또는 50건 넘게 쌓이면) 지워진다.
 *   usePolling 은 403 에서 폴링을 멈추고 문구를 그대로 두므로 메모가 다시 채워지지 않는다.
 * 수정: 상자가 같은 문구로 한 번 찾은 정보는 문구가 바뀔 때까지 붙든다(accessDeniedText.js holdHttpInfo).
 * 컴포넌트를 두 번 그리는 테스트는 DOM 이 없어 못 한다 — 판정은 순수 함수로, 배선은 소스로 고정한다.
 * ⚠ 기준 시각: 실제 시각에서 정시 −30분으로 떨어뜨려 가짜 시계에 넣는다(경계에서 흔들리지 않게).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { noteHttpError, permissionInfoFor, httpInfoFor } from '../api.js';
import { holdHttpInfo, errorBoxInput } from './accessDeniedText.js';
import { stripComments } from '../test/_stripComments.js';

const HOUR = 3_600_000;
const T0 = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
const src = stripComments(fs.readFileSync(new URL('./primitives.jsx', import.meta.url), 'utf8'));

afterEach(() => { vi.useRealTimers(); });

/** ErrorBox 의 판정부와 같은 순서 — 렌더 한 번. */
function renderOnce(ref, message, info = null) {
  const norm = errorBoxInput(message);
  return holdHttpInfo(ref, norm.text, { perm: info || norm.perm || permissionInfoFor(norm.text), http: norm.http || httpInfoFor(norm.text) });
}

describe('E4 — 표시 중인 상자의 판정은 메모의 수명과 무관하다', () => {
  it('재현: 메모는 5분 뒤 지워진다(원인) — 붙들지 않으면 다음 렌더가 권한 정보를 잃는다', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const msg = '이 기능은 관리자 권한이 필요합니다(132-a)';
    noteHttpError(msg, { status: 403, path: '/admin/x', required: 'admin' });
    expect(permissionInfoFor(msg)?.status).toBe(403);
    vi.setSystemTime(T0 + 5 * 60_000 + 1000);
    expect(permissionInfoFor(msg)).toBeNull(); // 고치기 전 ErrorBox 는 이 값만 봤다 → 빨간 '오류: …'
  });

  it('403: 5분이 지나 메모가 지워져도 같은 문구의 상자는 접근 제어 안내를 유지한다', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const msg = '이 기능은 관리자 권한이 필요합니다(132-b)';
    noteHttpError(msg, { status: 403, path: '/admin/y', required: 'admin' });
    const ref = { current: null };
    expect(renderOnce(ref, msg).perm?.status).toBe(403);
    vi.setSystemTime(T0 + 6 * 60_000);
    expect(permissionInfoFor(msg)).toBeNull();
    const again = renderOnce(ref, msg);
    expect(again.perm?.status).toBe(403);
    expect(again.perm?.path).toBe('/admin/y');
    vi.setSystemTime(T0 + 3 * HOUR);
    expect(renderOnce(ref, msg).perm?.status).toBe(403);
  });

  it('5xx: 상태코드(일시적 미가용 안내의 근거)도 같이 붙든다', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const msg = '수집 서버가 응답하지 않습니다(132-c)';
    noteHttpError(msg, { status: 503, path: '/tools/z' });
    const ref = { current: null };
    const first = renderOnce(ref, msg);
    expect(first.perm).toBeNull();
    expect(first.http?.status).toBe(503);
    vi.setSystemTime(T0 + 10 * 60_000);
    expect(httpInfoFor(msg)).toBeNull();
    expect(renderOnce(ref, msg).http?.status).toBe(503);
    expect(renderOnce(ref, msg).perm).toBeNull(); // 5xx 를 403 으로 올리지 않는다
  });

  it('문구가 바뀌면 붙든 정보를 버린다 — 다른 오류에 옛 권한 정보를 붙이지 않는다', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const msg = '범위 밖입니다(132-d)';
    noteHttpError(msg, { status: 403, path: '/p' });
    const ref = { current: null };
    expect(renderOnce(ref, msg).perm?.status).toBe(403);
    const other = renderOnce(ref, 'Failed to fetch(132-d)');
    expect(other.perm).toBeNull();
    expect(other.http).toBeNull();
    // 원래 문구로 돌아와도(메모가 지워진 뒤라면) 되살리지 않는다 — 붙드는 것은 '지금 표시 중인 문구' 뿐이다
    vi.setSystemTime(T0 + 6 * 60_000);
    expect(renderOnce(ref, msg).perm).toBeNull();
  });

  it('새로 찾은 정보가 있으면 그것이 먼저다 · 상자마다 따로 붙든다 · ref 가 없어도 던지지 않는다', () => {
    const a = { current: null };
    const b = { current: null };
    expect(holdHttpInfo(a, 'm', { perm: { status: 403, path: '/1' }, http: null }).perm.path).toBe('/1');
    expect(holdHttpInfo(a, 'm', { perm: { status: 403, path: '/2' }, http: null }).perm.path).toBe('/2');
    expect(holdHttpInfo(b, 'm', { perm: null, http: null }).perm).toBeNull(); // 다른 상자는 영향 없음
    expect(holdHttpInfo(null, 'm', { perm: null, http: null })).toEqual({ text: 'm', perm: null, http: null });
    expect(holdHttpInfo(a, 'm', null).perm.path).toBe('/2');
  });
});

describe('E4 — 화면 배선(primitives.jsx ErrorBox · 주석 제거 후)', () => {
  const box = src.slice(src.indexOf('export function ErrorBox('), src.indexOf('오류: {norm.text}'));
  it('훅(useRef)은 조기 return 위에 있고, 권한 · 상태 정보 둘 다 붙든 값에서 읽는다', () => {
    const iRef = box.indexOf('const heldRef = useRef(null);');
    const iRet = box.indexOf('return <AccessDenied');
    expect(iRef).toBeGreaterThan(-1);
    expect(iRet).toBeGreaterThan(iRef);
    expect(box).toMatch(/const held = holdHttpInfo\(heldRef, norm\.text, \{ perm: info \|\| norm\.perm \|\| permissionInfoFor\(norm\.text\), http: norm\.http \|\| httpInfoFor\(norm\.text\) \}\);/);
    expect(box).toMatch(/const perm = held\.perm;/);
    expect(box).toMatch(/const http = held\.http;/);
    // 메모를 직접 읽는 판정이 남아 있지 않다
    expect((box.match(/permissionInfoFor\(/g) || []).length).toBe(1);
    expect((box.match(/httpInfoFor\(/g) || []).length).toBe(1);
  });
});
