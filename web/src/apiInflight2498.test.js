/**
 * v2.498 — fetchJson 의 '진행 중 요청' 등록·해제 시점 회귀 고정(node 환경).
 *
 * 왜 이 테스트가 필요한가: `try { return res.json() } finally { endReq() }` 는 **본문을 읽기 전에**
 * finally 를 실행한다(async 함수의 return 의미론). 그러면 응답 헤더가 도착한 순간 요청이 진행 중
 * 목록에서 사라지고, 호출자는 그 뒤로 본문 수신 + JSON.parse 를 기다린다 — 그 구간에 화면이
 * '대기 중인 요청이 없습니다 — 화면 상태 문제일 수 있습니다' 로 오진하고 새로고침을 권한다.
 * 이 기능이 잡으려던 상황(대량 응답·동기 dump 로 루프가 막힌 구간)을 정확히 '뷰 문제' 로
 * 오분류하므로, `return await` 여야 한다. 눈으로 지키기 어려운 한 글자라 테스트로 고정한다.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fetchJson } from './api.js';
import { inflightSnapshot, _resetPerfClient, _perfClientState } from './perfClient.js';

const origFetch = globalThis.fetch;

beforeEach(() => {
  _resetPerfClient();
  // api.js 의 authHeaders 가 토큰 저장소를 읽는다 — node 환경에는 없으므로 최소 스텁을 둔다.
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
});
afterEach(() => { globalThis.fetch = origFetch; });

/** 헤더는 즉시, 본문은 나중(타이머 뒤)에 오는 응답. */
function lateBodyResponse(body, delayMs = 40) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => new Promise((resolve) => { setTimeout(() => resolve(body), delayMs); }),
  };
}
const tick = (ms) => new Promise((r) => { setTimeout(r, ms); });

describe('fetchJson — 진행 중 요청은 본문 수신이 끝날 때까지 남아 있어야 한다', () => {
  it('본문이 흐르는 동안에도 진행 중 목록에 보인다', async () => {
    globalThis.fetch = async () => lateBodyResponse({ ok: 1 }, 60);
    const p = fetchJson('/overview');
    expect(inflightSnapshot(10).length).toBe(1);       // 요청 시작 직후
    // ⚠ 관측 지점: json() 이 **호출된 뒤** 별도 태스크에서 본다. json() 실행자 안에서 보면
    // `return res.json()`(버그) 과 `return await res.json()`(정상) 이 같은 값을 주므로 버그를
    // 잡지 못한다 — finally 는 res.json() 호출 **후**에 돌기 때문이다(실측으로 확인).
    await tick(20);
    const during = inflightSnapshot(10);
    const data = await p;
    expect(data).toEqual({ ok: 1 });
    expect(during.length).toBe(1);
    expect(during[0].path).toBe('/overview');
    expect(inflightSnapshot(10).length).toBe(0);       // 본문까지 끝난 뒤에는 해제
  });

  it('실패(throw)해도 해제된다 — 누수가 있으면 진행 중 목록이 영구 거짓이 된다', async () => {
    globalThis.fetch = async () => { throw new Error('Failed to fetch'); };
    await expect(fetchJson('/overview', {}, undefined, { retries: 0 })).rejects.toThrow();
    expect(inflightSnapshot(10).length).toBe(0);
    expect(_perfClientState().inflightN).toBe(0);
  });

  it('계측 자기 경로(/perf/*)는 진행 중 목록에 넣지 않는다(재귀·상시 대기 오표시 방지)', async () => {
    globalThis.fetch = async () => lateBodyResponse({ enabled: true, clientStuckMs: 60_000 });
    const p = fetchJson('/perf/client-config');
    expect(inflightSnapshot(10).length).toBe(0);
    await p;
  });
});
