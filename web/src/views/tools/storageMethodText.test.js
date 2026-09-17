/**
 * storageMethodText.test.js — 수집 방식 표시 회귀(v2.542).
 *
 * 사용자 신고(2026-09-17, `OC2-unity-01`): API → SSH 로 고쳐 저장했는데 표가 계속 API 였고
 * 새로고침해도 바뀌지 않았다. 저장은 정상이었고(수정 폼이 SSH 로 열림) 표가
 * `snap.extra.collectMethod`(마지막 수집이 쓴 방식)를 등록값보다 우선한 것이 원인이다.
 *
 * ⚠ 이 테스트는 **양방향**을 고정한다 — ① 등록값이 즉시 보인다 ② 마지막 수집이 다른
 * 방식이었다는 사실이 사라지지 않는다. 한쪽만 고정하면 반대 방향의 거짓이 생긴다.
 */
import { describe, it, expect } from 'vitest';
import { collectMethodView, methodOf, METHOD_LABEL } from './storageMethodText.js';

describe('methodOf — 수집기의 실제 분기와 같은 기준', () => {
  it("'ssh' 만 ssh 이고 나머지는 api 다(unity.js:58 과 동일)", () => {
    expect(methodOf('ssh')).toBe('ssh');
    expect(methodOf('SSH')).toBe('ssh');
    expect(methodOf(' ssh ')).toBe('ssh');
    for (const v of ['api', 'API', '', null, undefined, 'rest', 'uemcli']) expect(methodOf(v)).toBe('api');
  });
});

describe('collectMethodView — 신고 재현(v2.542)', () => {
  const reported = { registered: 'ssh', lastUsed: 'api', hasSnap: true, agent: 'OC2' };

  it('등록값이 주 배지다 — 저장 직후 화면이 바로 SSH 를 보여준다', () => {
    expect(collectMethodView(reported).label).toBe('SSH');
  });

  it('마지막 수집이 API 였다는 사실을 숨기지 않는다', () => {
    const r = collectMethodView(reported);
    expect(r.pending).not.toBeNull();
    expect(r.pending.label).toBe('API 수집분');
    expect(r.pending.title).toMatch(/API 로 수집한 마지막 스냅샷/);
  });

  it('엣지 장비는 반영 경로를 엣지 이름으로 말한다', () => {
    expect(collectMethodView(reported).pending.title).toMatch(/엣지 'OC2' 가 중앙 설정을 받아/);
  });

  it('중앙 직접 장비는 엣지를 말하지 않는다', () => {
    const r = collectMethodView({ registered: 'api', lastUsed: 'ssh', hasSnap: true, agent: '' });
    expect(r.label).toBe('API');
    expect(r.pending.title).toMatch(/다음 수집 주기에 반영/);
    expect(r.pending.title).not.toMatch(/엣지/);
  });

  // 주기는 중앙 설정으로 바뀌므로 문구에 박으면 거짓이 된다(CLAUDE.md 규약).
  it('문구에 주기 숫자를 박지 않는다', () => {
    const r = collectMethodView(reported);
    for (const t of [r.title, r.pending.title]) expect(t).not.toMatch(/\d+\s*(분|시간|초)/);
  });
});

describe('collectMethodView — 대기가 아닌 경우를 대기라 하지 않는다', () => {
  it('등록값과 마지막 수집이 같으면 대기 배지가 없다', () => {
    const r = collectMethodView({ registered: 'ssh', lastUsed: 'ssh', hasSnap: true, agent: 'OC2' });
    expect(r.pending).toBeNull();
    expect(r.title).toMatch(/마지막 수집도 SSH/);
  });

  it('수집된 적이 없으면 대기가 아니라 "확인되지 않았다" 다', () => {
    const r = collectMethodView({ registered: 'ssh', hasSnap: false });
    expect(r.pending).toBeNull();
    expect(r.title).toMatch(/아직 수집된 스냅샷이 없어/);
    expect(r.title).not.toMatch(/대기/);
  });

  it('스냅샷이 없는데 lastUsed 가 들어와도 비교하지 않는다(hasSnap 이 기준)', () => {
    expect(collectMethodView({ registered: 'ssh', lastUsed: 'api', hasSnap: false }).pending).toBeNull();
  });
});

describe('collectMethodView — 등록값이 없는 옛 레코드', () => {
  it("기본값 API 로 동작한다고 밝힌다(지어낸 값이 아니라 수집기의 실제 동작)", () => {
    const r = collectMethodView({ registered: '', lastUsed: 'api', hasSnap: true });
    expect(r.label).toBe('API');
    expect(r.pending).toBeNull();
    expect(r.title).toMatch(/지정되지 않아 기본값 API/);
  });
  it('등록값이 없고 마지막 수집이 SSH 면 어긋남으로 밝힌다', () => {
    const r = collectMethodView({ registered: '', lastUsed: 'ssh', hasSnap: true });
    expect(r.label).toBe('API');
    expect(r.pending.label).toBe('SSH 수집분');
  });
});

describe('라벨 상수', () => {
  it('SSH/API 두 개뿐이다', () => {
    expect(METHOD_LABEL).toEqual({ ssh: 'SSH', api: 'API' });
  });
});
